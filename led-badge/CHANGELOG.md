# Changelog

## 2026.10.05.1

Initial release.

- `detect`, `preview` and `send` for the 44x11 LED name badge (USB `0416:5020`,
  WCH CH583, BLE `LSLED`).
- Text (5x7 font plus `:heart:` `:smile:` `:check:` `:cross:` `:arrow:`
  symbols), pixel art, and animations (`frames`, up to 32 frames).
- Two transports through a Rust helper (`bin/hid-send`, hidapi + btleplug): USB
  HID (64-byte reports) and Bluetooth LE (16-byte writes to FEE1, optional
  4-digit PIN). Built once with `cargo build --locked` and cached;
  `LED_BADGE_HELPER` points at a prebuilt binary instead.
- Uploads above ~2.3 KB are refused: the stock firmware silently ignores them
  (measured: 2176 bytes plays, 4032 bytes is dropped).
- BLE payloads are padded to 16 bytes, not 64: the badge restarts once it has
  the announced bytes, so a padding-only trailing write hits a closed link.
