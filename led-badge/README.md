# @magistr/led-badge

Drive a cheap **44x11 LED name badge** from swamp. These badges show up on USB
as `0416:5020` ("CH583", manufacturer `wch.cn`) and also speak Bluetooth LE as
`LSLED` (the FOSSASIA Badge Magic app). This extension speaks both.

## Methods

| Method    | Touches device | What it does                                     |
| --------- | -------------- | ------------------------------------------------ |
| `detect`  | read-only      | Finds the 64-byte vendor HID interface           |
| `preview` | no             | Renders messages to ASCII frames, stored as data |
| `send`    | **writes**     | Uploads 1..8 messages, replacing what is stored  |

Each message has exactly one of `text` (5x7 ASCII font, symbols `:heart:`
`:smile:` `:check:` `:cross:` `:arrow:`), `art` (up to 11 rows of `#`/`.`) or
`frames` (an animation: up to 32 pixel-art frames, each at most 44 px wide; the
badge plays them one after another in 48-px slots, `speed` sets the rate), plus
`mode` (`left right up down fixed animation snowflake picture laser`), `speed`
1..8, `blink`, `border`. `brightness` is 25/50/75/100.

## Usage

```bash
swamp model create @magistr/led-badge badge
swamp model method run badge send --input '{
  "messages": [
    {"text": "Hello from swamp :heart:", "mode": "left", "speed": 5},
    {"text": "OK", "mode": "fixed", "border": true}
  ],
  "brightness": 50
}'
```

Preview without the device:

```bash
swamp model method run badge preview --input '{"messages":[{"text":"Hi!"}]}'
swamp data query 'model("badge") && name == "preview"' --select content
```

## Limits

The badge accepts uploads up to about 2.3 KB in total (measured: 2176 bytes
plays, 4032 bytes is silently ignored and the old content stays). `send` refuses
anything bigger. One message of 32 animation frames fits.

## Bluetooth

Set `transport: ble` on the instance. The badge only advertises after you press
its button into Bluetooth / pairing mode, and it leaves that mode after every
upload, so press the button before each send. A badge in BT-PAIRING protection
mode shows a 4-digit PIN: put it in `blePin`.

```bash
swamp model create @magistr/led-badge badge-ble --global-arg transport=ble
swamp model method run badge-ble send --input "{\"messages\":[{\"text\":\"via BLE\"}]}"
```

## Protocol

A 64-byte header (`wang\0`, brightness, blink/border bitmasks, per-message
`(speed-1)<<4 | mode`, big-endian lengths in 8-px columns, timestamp) followed
by each bitmap as 11 bytes per 8-px column (MSB = leftmost pixel), padded to
64-byte HID output reports.

## Requirements

A Rust toolchain (`cargo`). The helper `bin/hid-send` (hidapi crate, IOKit on
macOS, hidraw on Linux) is built on first use with `cargo build --locked` and
cached in `~/.cache/swamp-led-badge/`, keyed by a hash of its sources. On Linux
you need a udev rule giving your user access to `0416:5020`.
