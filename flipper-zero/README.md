# @magistr/flipper-zero

Control a [Flipper Zero](https://flipperzero.one/) over its USB serial CLI from
swamp. The Flipper exposes a virtual serial port; this model drives its text CLI
(the `>:` prompt), parses the replies, and stores structured results as swamp
data you can reference with CEL.

## Model: `@magistr/flipper-zero`

One instance = one Flipper, identified by its serial port (or auto-detected).

### Global arguments

| Field       | Default  | Description                                                        |
| ----------- | -------- | ------------------------------------------------------------------ |
| `port`      | _(auto)_ | Serial path, e.g. `/dev/cu.usbmodemflip_Zilxi1` or `/dev/ttyACM0`. |
| `baud`      | `230400` | stty baud (cosmetic for USB-CDC, but must be a valid speed).       |
| `timeoutMs` | `8000`   | Per-command read timeout in milliseconds.                          |

When `port` is omitted the model looks for `/dev/cu.usbmodemflip*` (macOS), then
`/dev/ttyACM*` (Linux), then any `/dev/cu.usbmodem*`.

### Methods

| Method           | CLI / RPC                | Result resource   |
| ---------------- | ------------------------ | ----------------- |
| `detect`         | _(none)_                 | `device-port`     |
| `info`           | `info device`            | `device-info`     |
| `exec`           | _your command_           | `command-output`  |
| `storage-list`   | `storage list <path>`    | `storage-listing` |
| `storage-read`   | `storage read <path>`    | `file-content`    |
| `apps`           | `loader list` (built-in) | `app-list`        |
| `installed-apps` | `storage tree /ext/apps` | `installed-apps`  |
| `launch`         | `loader open <app>`      | `launch-result`   |
| `close`          | `loader close` → Back    | `close-result`    |
| `running`        | `loader info`            | `loader-info`     |
| `screenshot`     | RPC screen stream        | `screenshot`      |
| `show-image`     | RPC virtual display      | `image-shown`     |
| `play-snake`     | RPC stream + input       | `snake-game`      |
| `reboot`         | `power reboot`           | `reboot-result`   |

## Quick start

```bash
swamp model add my-flipper @magistr/flipper-zero

# 1) Find the port (no device chatter)
swamp model @magistr/flipper-zero method run detect my-flipper

# 2) Read device / firmware / power info
swamp model @magistr/flipper-zero method run info my-flipper
swamp data get my-flipper device-info --json

# 3) Run any CLI command
swamp model @magistr/flipper-zero method run exec my-flipper \
  --input '{"command":"storage info /ext"}'

# 4) Browse the SD card
swamp model @magistr/flipper-zero method run storage-list my-flipper \
  --input '{"path":"/ext"}'

# 5) List installed apps/scripts, launch one, then close it
swamp model @magistr/flipper-zero method run installed-apps my-flipper
swamp model @magistr/flipper-zero method run launch my-flipper \
  --input '{"app":"/ext/apps/Games/snake_game.fap"}'
swamp model @magistr/flipper-zero method run close my-flipper

# 6) Capture the screen (ASCII + braille + raw framebuffer)
swamp model @magistr/flipper-zero method run screenshot my-flipper
swamp data get my-flipper screenshot --json
```

Reference results downstream via CEL, e.g.
`data.latest("my-flipper", "device-info").attributes.hardware_name`.

## Working with installed apps

`installed-apps` walks `/ext/apps` with a single `storage tree` and returns
every `.fap` app and `.js` script grouped by category, each with a launchable
`path`, plus a `byKind` summary. Feed a `path` to `launch`. `launch` reads
loader state first and refuses to open over a running app unless `force:true`
(which closes the current one first). `close` tries a soft `loader close` and,
because games ignore it, escalates to a simulated long Back press — reporting
how it closed via `via` (`already-idle` / `loader-close` / `back-button` /
`failed`).

## Capturing the screen

`screenshot` speaks the Flipper RPC protocol (`start_rpc_session` →
`Gui.StartScreenStream`), grabs one 128×64 `ScreenFrame`, and renders it as
`ascii` (2×2 px/char) and `braille` (2×4 px/char), plus the raw framebuffer as
`framebufferBase64`. Any other RPC client (qFlipper) must be disconnected.

## Drawing on the screen

`show-image` takes over the display with an RPC **virtual display**. Give it
ASCII art — any character other than ``, `.`, `·`, `_` or `0` lights a pixel,
and the art is scaled up and centred to fit 128×64 — or a raw 1024-byte
framebuffer as base64 (for example one captured by `screenshot`, letting you
round-trip a screen back onto the device).

```bash
swamp model @magistr/flipper-zero method run show-image my-flipper --input '{
  "ascii": "..####..\n.#....#.\n#.#..#.#\n#......#\n#.#..#.#\n#..##..#\n.#....#.\n..####..",
  "seconds": 6
}'
```

The image lives only as long as the RPC session, so it shows for `seconds` and
then the Flipper returns to its own UI.

## Playing Snake

`play-snake` plays the bundled Snake game autonomously. Each tick it streams the
screen, parses the 31×15 board, BFS-plans a path to the food, and takes it only
if the snake can **still reach its own tail** afterwards — otherwise it chases
its tail instead. That invariant is what avoids wall, loop and self-trap deaths.

```bash
swamp model @magistr/flipper-zero method run play-snake my-flipper \
  --input '{"seconds":60}'
swamp data query 'name == "snake-game"' --select 'content.maxLength' --json
```

The bot needs a long-lived, full-permission serial session (a ~166ms game tick
versus ~1.7s of swamp CLI startup rules out per-move method calls), so the
method runs `bots/snake_bot.ts` as a `deno --allow-all` child process and
captures its log.

## Notes & limitations

- **One writer at a time.** Close qFlipper (or any serial terminal) first — it
  can hold the port open and block the model.
- **Single-line commands only.** `exec` rejects embedded newlines so a command
  can't inject extra CLI input. Filenames with spaces aren't supported by the
  Flipper CLI itself.
- **Text output.** `storage-read` returns text as the CLI prints it; binary
  files are not chunk-decoded (use the Flipper's `storage read_chunks` via
  `exec` if you need raw blocks). Captured output is capped at 1 MiB.
- **`reboot` drops the port** — the model sends the command and does not wait
  for a prompt.

## Platform

macOS and Linux. Requires the `stty` binary and read/write access to the serial
device node.

## License

MIT — see [LICENSE.md](LICENSE.md).
