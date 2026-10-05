//! hid-send — upload a badge payload over USB HID or Bluetooth LE.
//!
//! Usage:
//!   hid-send usb <vid> <pid> [probe]   payload on stdin, 64-byte HID reports
//!   hid-send ble <name> <scan-secs> [probe] [pin]
//!                                      payload on stdin, 16-byte GATT writes
//!                                      to FEE1 (service FEE0), with response
//! One JSON line with the result is printed to stdout.

use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use hidapi::HidApi;
use serde_json::{json, Value};
use std::io::Read;
use std::process::exit;
use std::time::{Duration, Instant};

const USB_REPORT: usize = 64;
const BLE_CHUNK: usize = 16;

fn out(v: Value, code: i32) -> ! {
    println!("{v}");
    exit(code)
}

fn fail(msg: String) -> ! {
    out(json!({"ok": false, "error": msg}), 1)
}

fn read_payload(multiple: usize) -> Vec<u8> {
    let mut payload = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut payload) {
        out(json!({"ok": false, "error": format!("stdin: {e}")}), 2);
    }
    if payload.is_empty() || payload.len() % multiple != 0 {
        out(json!({"ok": false, "error": format!("payload must be a non-empty multiple of {multiple} bytes, got {}", payload.len())}), 2);
    }
    payload
}

fn usb(args: &[String]) -> ! {
    let (vid, pid) = match (
        args.first().and_then(|s| s.parse::<u16>().ok()),
        args.get(1).and_then(|s| s.parse::<u16>().ok()),
    ) {
        (Some(v), Some(p)) => (v, p),
        _ => out(json!({"ok": false, "error": "usage: hid-send usb <vid> <pid> [probe]"}), 2),
    };
    let probe = args.get(2).map(|s| s == "probe").unwrap_or(false);
    let api = HidApi::new().unwrap_or_else(|e| fail(format!("hidapi init: {e}")));
    let matches: Vec<_> = api
        .device_list()
        .filter(|d| d.vendor_id() == vid && d.product_id() == pid)
        .collect();
    let devices: Vec<Value> = matches
        .iter()
        .map(|d| {
            json!({
                "transport": "usb",
                "product": d.product_string().unwrap_or(""),
                "manufacturer": d.manufacturer_string().unwrap_or(""),
                "usagePage": d.usage_page(),
                "usage": d.usage(),
                "interface": d.interface_number(),
                "path": d.path().to_string_lossy(),
            })
        })
        .collect();
    // The badge has one vendor-defined interface (usage page 0xFF00).
    let target = matches
        .iter()
        .find(|d| d.usage_page() == 0xFF00)
        .or(matches.first());
    if probe {
        let found = target.is_some();
        out(json!({"ok": found, "devices": devices}), if found { 0 } else { 1 });
    }
    let Some(info) = target else {
        out(json!({"ok": false, "error": format!("no HID device {vid}:{pid}"), "devices": devices}), 1)
    };
    let payload = read_payload(USB_REPORT);
    let dev = info
        .open_device(&api)
        .unwrap_or_else(|e| fail(format!("open: {e}")));
    let mut sent = 0;
    for chunk in payload.chunks(USB_REPORT) {
        // Report id 0 (the device uses unnumbered reports) + 64 data bytes.
        let mut buf = [0u8; USB_REPORT + 1];
        buf[1..].copy_from_slice(chunk);
        if let Err(e) = dev.write(&buf) {
            out(json!({"ok": false, "error": format!("write report {sent}: {e}"), "reportsSent": sent}), 1);
        }
        sent += 1;
        std::thread::sleep(Duration::from_millis(2));
    }
    out(json!({"ok": true, "transport": "usb", "reportsSent": sent, "bytes": payload.len()}), 0)
}

async fn find_ble(name: &str, scan: Duration) -> (Option<Peripheral>, Vec<Value>) {
    let manager = Manager::new()
        .await
        .unwrap_or_else(|e| fail(format!("bluetooth manager: {e}")));
    let central = manager
        .adapters()
        .await
        .unwrap_or_else(|e| fail(format!("bluetooth adapters: {e}")))
        .into_iter()
        .next()
        .unwrap_or_else(|| fail("no bluetooth adapter".into()));
    let service = uuid_from_u16(0xFEE0);
    central
        .start_scan(ScanFilter::default())
        .await
        .unwrap_or_else(|e| fail(format!("bluetooth scan: {e} (is Bluetooth on and allowed for this terminal?)")));
    let deadline = Instant::now() + scan;
    let mut seen: Vec<Value> = Vec::new();
    let mut found = None;
    while Instant::now() < deadline && found.is_none() {
        tokio::time::sleep(Duration::from_millis(500)).await;
        seen.clear();
        for p in central.peripherals().await.unwrap_or_default() {
            let Ok(Some(props)) = p.properties().await else { continue };
            let local = props.local_name.clone().unwrap_or_default();
            let has_service = props.services.contains(&service);
            if local.is_empty() && !has_service {
                continue;
            }
            seen.push(json!({"transport": "ble", "name": local, "id": p.id().to_string(), "rssi": props.rssi, "fee0": has_service}));
            if found.is_none() && (local == name || has_service) {
                found = Some(p);
            }
        }
    }
    let _ = central.stop_scan().await;
    (found, seen)
}

async fn ble(args: &[String]) -> ! {
    let name = args.first().cloned().unwrap_or_else(|| "LSLED".into());
    let secs = args.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(10);
    let probe = args.get(2).map(|s| s == "probe").unwrap_or(false);
    let pin = args.get(3).filter(|s| !s.is_empty()).cloned();
    let (found, seen) = find_ble(&name, Duration::from_secs(secs)).await;
    if probe {
        let ok = found.is_some();
        out(json!({"ok": ok, "devices": seen}), if ok { 0 } else { 1 });
    }
    let Some(p) = found else {
        out(json!({"ok": false, "error": format!("no BLE badge named {name} (or advertising FEE0) within {secs}s; switch the badge to Bluetooth mode"), "devices": seen}), 1)
    };
    let payload = read_payload(BLE_CHUNK);
    p.connect().await.unwrap_or_else(|e| fail(format!("ble connect: {e}")));
    p.discover_services()
        .await
        .unwrap_or_else(|e| fail(format!("ble discover: {e}")));
    let target = uuid_from_u16(0xFEE1);
    let Some(ch) = p.characteristics().into_iter().find(|c| c.uuid == target) else {
        let _ = p.disconnect().await;
        fail("badge has no FEE1 characteristic".into())
    };
    if let Some(pin) = pin {
        // PIN-protected badges want the 4 ASCII digits, zero-padded to 16 bytes,
        // in the same session as the data.
        let mut buf = [0u8; BLE_CHUNK];
        buf[..pin.len().min(BLE_CHUNK)].copy_from_slice(&pin.as_bytes()[..pin.len().min(BLE_CHUNK)]);
        p.write(&ch, &buf, WriteType::WithResponse)
            .await
            .unwrap_or_else(|e| fail(format!("ble pin write: {e}")));
    }
    let mut sent = 0;
    for chunk in payload.chunks(BLE_CHUNK) {
        if let Err(e) = p.write(&ch, chunk, WriteType::WithResponse).await {
            let _ = p.disconnect().await;
            out(json!({"ok": false, "error": format!("ble write chunk {sent}: {e}"), "chunksSent": sent}), 1);
        }
        sent += 1;
    }
    // The badge reboots into the new content and drops the link itself.
    let _ = p.disconnect().await;
    out(json!({"ok": true, "transport": "ble", "chunksSent": sent, "bytes": payload.len()}), 0)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("usb") => usb(&args[1..]),
        Some("ble") => ble(&args[1..]).await,
        _ => out(json!({"ok": false, "error": "usage: hid-send usb <vid> <pid> [probe] | hid-send ble <name> <scan-secs> [probe] [pin]"}), 2),
    }
}
