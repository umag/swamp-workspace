/**
 * Unit tests for the pure Flipper CLI protocol helpers. No hardware required.
 *
 * @module
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  candidatePorts,
  cleanResponse,
  cleanSequenceOutput,
  findScreenFrame,
  framebufferBase64,
  hasPrompt,
  installedAppsFromTree,
  looksLikeUnknownCommand,
  parseAppList,
  parseDeviceInfo,
  parseFileSize,
  parseListenEvents,
  parseLoaderInfo,
  parseStorageList,
  parseStorageTree,
  renderAscii,
  renderBraille,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  selectPort,
  stripAnsi,
} from "./lib/protocol.ts";

const ESC = "\x1b";

Deno.test("stripAnsi removes colour codes and control bytes", () => {
  const colored = `${ESC}[32mhello${ESC}[0m\x07 world`;
  assertEquals(stripAnsi(colored), "hello world");
});

Deno.test("stripAnsi keeps tabs and newlines", () => {
  assertEquals(stripAnsi("a\tb\nc"), "a\tb\nc");
});

Deno.test("hasPrompt detects the idle prompt", () => {
  assertEquals(hasPrompt("output\r\n>: "), true);
  assertEquals(hasPrompt("output\r\n>:"), true);
  assertEquals(hasPrompt(`${ESC}[0m>: `), true);
});

Deno.test("hasPrompt is false mid-stream", () => {
  assertEquals(hasPrompt("partial output without prompt"), false);
  assertEquals(hasPrompt("a line ending in >: text\r\nmore"), false);
});

Deno.test("cleanResponse strips echo and trailing prompt", () => {
  const raw = "info device\r\nhardware_model: F7\r\nfirmware: 1.0\r\n>: ";
  assertEquals(
    cleanResponse(raw, "info device"),
    "hardware_model: F7\nfirmware: 1.0",
  );
});

Deno.test("cleanResponse handles a leading sync-prompt fragment", () => {
  const raw = ">: help\r\ncommand list\r\n>: ";
  assertEquals(cleanResponse(raw, "help"), "command list");
});

Deno.test("cleanResponse strips a connect banner before the echoed command", () => {
  const raw =
    "Welcome to Flipper Zero!\r\n>: info device\r\nhardware_model: F7\r\n>: ";
  assertEquals(cleanResponse(raw, "info device"), "hardware_model: F7");
});

Deno.test("cleanResponse without device echo keeps all output", () => {
  const raw = "line one\r\nline two\r\n>: ";
  assertEquals(cleanResponse(raw, "info device"), "line one\nline two");
});

Deno.test("selectPort honours an explicit override", () => {
  assertEquals(selectPort([], "/dev/ttyUSB0"), "/dev/ttyUSB0");
  assertEquals(
    selectPort(["cu.usbmodemflip_X1"], "  /dev/custom  "),
    "/dev/custom",
  );
});

Deno.test("selectPort prefers a flipper node on macOS", () => {
  const names = ["cu.Bluetooth-Incoming-Port", "cu.usbmodemflip_Zilxi1"];
  assertEquals(selectPort(names), "/dev/cu.usbmodemflip_Zilxi1");
});

Deno.test("selectPort falls back to ttyACM then generic usbmodem", () => {
  assertEquals(selectPort(["ttyACM0", "ttyS0"]), "/dev/ttyACM0");
  assertEquals(selectPort(["cu.usbmodem1101"]), "/dev/cu.usbmodem1101");
});

Deno.test("selectPort throws when nothing matches", () => {
  assertThrows(
    () => selectPort(["cu.Bluetooth-Incoming-Port"]),
    Error,
    "No Flipper",
  );
});

Deno.test("candidatePorts filters and sorts serial nodes", () => {
  const names = ["cu.usbmodem1101", "ttyACM0", "cu.BLTH", "cu.usbmodemflip_A1"];
  assertEquals(candidatePorts(names), [
    "/dev/cu.usbmodem1101",
    "/dev/cu.usbmodemflip_A1",
    "/dev/ttyACM0",
  ]);
});

Deno.test("parseDeviceInfo parses key/value lines", () => {
  const text = [
    "hardware_model    : F7",
    "hardware_name     : Zilxi",
    "firmware_version  : 1.3.4",
    "not a kv line",
  ].join("\n");
  assertEquals(parseDeviceInfo(text), {
    hardware_model: "F7",
    hardware_name: "Zilxi",
    firmware_version: "1.3.4",
  });
});

Deno.test("parseStorageList parses dirs and files with sizes", () => {
  const text = [
    "Storage, /ext:",
    "\t[D] subghz",
    "\t[F] Manifest 85176b", // modern firmware: trailing 'b'
    "\t[F] legacy.dat 64", // older firmware: no suffix
    "\t[F] empty",
  ].join("\n");
  assertEquals(parseStorageList(text), [
    { type: "dir", name: "subghz", size: null },
    { type: "file", name: "Manifest", size: 85176 },
    { type: "file", name: "legacy.dat", size: 64 },
    { type: "file", name: "empty", size: null },
  ]);
});

Deno.test("parseFileSize extracts the Size header", () => {
  assertEquals(parseFileSize("Size: 42\nhello"), 42);
  assertEquals(parseFileSize("no header here"), null);
});

Deno.test("parseAppList drops headers and blanks", () => {
  const text = "Applications:\n\nSnake\nClock\n";
  assertEquals(parseAppList(text), ["Snake", "Clock"]);
});

Deno.test("looksLikeUnknownCommand detects CLI errors", () => {
  assertEquals(looksLikeUnknownCommand("`foo` command not found"), true);
  assertEquals(looksLikeUnknownCommand("all good"), false);
});

Deno.test("parseStorageTree parses full paths and sizes", () => {
  const text = [
    "\t[D] /ext/apps/Games",
    "\t[F] /ext/apps/Games/snake_game.fap 5840b",
    "\t[D] /ext/apps/Scripts",
    "\t[F] /ext/apps/Scripts/console.js 121b",
  ].join("\n");
  assertEquals(parseStorageTree(text), [
    { type: "dir", path: "/ext/apps/Games", size: null },
    { type: "file", path: "/ext/apps/Games/snake_game.fap", size: 5840 },
    { type: "dir", path: "/ext/apps/Scripts", size: null },
    { type: "file", path: "/ext/apps/Scripts/console.js", size: 121 },
  ]);
});

Deno.test("installedAppsFromTree groups apps by category and kind", () => {
  const entries = parseStorageTree([
    "\t[D] /ext/apps/Games",
    "\t[F] /ext/apps/Games/snake_game.fap 5840b",
    "\t[D] /ext/apps/Scripts",
    "\t[F] /ext/apps/Scripts/console.js 121b",
    "\t[F] /ext/apps/Scripts/notes.txt 10b",
  ].join("\n"));
  assertEquals(installedAppsFromTree(entries, "/ext/apps"), [
    {
      name: "snake_game.fap",
      id: "snake_game",
      category: "Games",
      kind: "fap",
      path: "/ext/apps/Games/snake_game.fap",
      size: 5840,
    },
    {
      name: "console.js",
      id: "console",
      category: "Scripts",
      kind: "js",
      path: "/ext/apps/Scripts/console.js",
      size: 121,
    },
    {
      name: "notes.txt",
      id: "notes",
      category: "Scripts",
      kind: "other",
      path: "/ext/apps/Scripts/notes.txt",
      size: 10,
    },
  ]);
});

Deno.test("parseLoaderInfo detects the running app", () => {
  assertEquals(parseLoaderInfo('Application "Snake Game" is running'), {
    running: true,
    app: "Snake Game",
  });
  assertEquals(parseLoaderInfo("No application is running"), {
    running: false,
    app: null,
  });
});

Deno.test("cleanSequenceOutput strips prompts, echoes and NFC splash art", () => {
  // Shape taken from a real capture: banner, main prompt, sub-shell prompt,
  // the '0'-character dolphin, then the payload.
  const raw = [
    "Welcome to Flipper Zero Command Line Interface!",
    ">: nfc",
    "   0000      0000   ",
    "        0005        ",
    "Welcome to NFC Command Line Interface!",
    "[nfc]>: scanner",
    "Found card: 04A2B3C4",
    "[nfc]>: exit",
    ">: ",
  ].join("\r\n");
  assertEquals(
    cleanSequenceOutput(raw, ["nfc", "scanner", "", "exit"]),
    [
      "Welcome to NFC Command Line Interface!",
      "Found card: 04A2B3C4",
    ].join("\n"),
  );
});

Deno.test("cleanSequenceOutput handles a sub-shell prompt with no output", () => {
  const raw = ">: nfc\r\n[nfc]>: scanner\r\n[nfc]>: exit\r\n>: ";
  assertEquals(cleanSequenceOutput(raw, ["nfc", "scanner", "exit"]), "");
});

Deno.test("parseListenEvents drops the sub-GHz startup banner", () => {
  // Exactly what the device emits when nothing is in the air.
  const quiet = [
    "Load_keystore keeloq_mfcodes OK",
    "Load_keystore keeloq_mfcodes_user Absent",
    "Listening at frequency: 433919830 device: 0. Press CTRL+C to stop",
  ].join("\n");
  assertEquals(parseListenEvents(quiet), []);
});

Deno.test("parseListenEvents drops the infrared banner", () => {
  // Exactly what `ir rx` emits with no remote pressed.
  const quiet = "Receiving  INFRARED...\nPress Ctrl+C to abort";
  assertEquals(parseListenEvents(quiet), []);
});

Deno.test("parseListenEvents drops the NFC sub-shell banner", () => {
  // Exactly what a real `nfc` -> `scanner` -> `exit` run emits with no card.
  const quiet = [
    "Welcome to NFC Command Line Interface!",
    "Run `help` or `?` to list available commands",
    "Press Ctrl+C to abort",
  ].join("\n");
  assertEquals(parseListenEvents(quiet), []);
});

Deno.test("parseListenEvents reports a card over the NFC banner", () => {
  const withCard = [
    "Welcome to NFC Command Line Interface!",
    "Run `help` or `?` to list available commands",
    "Press Ctrl+C to abort",
    "ISO14443-4A, UID: 04 A2 B3 C4 D5 E6 F7",
  ].join("\n");
  const events = parseListenEvents(withCard);
  assertEquals(events.length, 1);
  assertEquals(events[0].summary, "ISO14443-4A, UID: 04 A2 B3 C4 D5 E6 F7");
});

Deno.test("parseListenEvents strips banner lines mixed into a block", () => {
  // Noise is dropped per line, so a banner glued to real data still parses.
  const mixed = "Receiving  INFRARED...\nNEC, A:0x04, C:0x08";
  const events = parseListenEvents(mixed);
  assertEquals(events.length, 1);
  assertEquals(events[0].summary, "NEC, A:0x04, C:0x08");
});

Deno.test("parseListenEvents captures a decoded reception", () => {
  const captured = [
    "Load_keystore keeloq_mfcodes OK",
    "Listening at frequency: 433919830 device: 0. Press CTRL+C to stop",
    "",
    "Princeton 24bit",
    "Key:0x00ABCDEF",
    "Te:350us",
  ].join("\n");
  const events = parseListenEvents(captured);
  assertEquals(events.length, 1);
  assertEquals(events[0].summary, "Princeton 24bit");
  assertEquals(events[0].lines.length, 3);
});

Deno.test("findScreenFrame extracts the 1024-byte framebuffer", () => {
  const fb = new Uint8Array(1024);
  fb[0] = 0xab;
  fb[1023] = 0xcd;
  // Prefix junk, then the ScreenFrame.data header 0x0A 0x80 0x08.
  const stream = new Uint8Array([0x99, 0x0a, 0x80, 0x08, ...fb]);
  const found = findScreenFrame(stream);
  assertEquals(found?.length, 1024);
  assertEquals(found?.[0], 0xab);
  assertEquals(found?.[1023], 0xcd);
});

Deno.test("findScreenFrame returns null without a frame", () => {
  assertEquals(findScreenFrame(new Uint8Array([1, 2, 3, 4, 5])), null);
});

Deno.test("renderAscii renders a blank screen as spaces", () => {
  const fb = new Uint8Array(1024);
  const ascii = renderAscii(fb);
  const lines = ascii.split("\n");
  assertEquals(lines.length, SCREEN_HEIGHT / 2);
  assertEquals(lines[0], " ".repeat(SCREEN_WIDTH / 2));
});

Deno.test("renderAscii marks a lit top-left pixel", () => {
  const fb = new Uint8Array(1024);
  fb[0] = 0x01; // pixel (0,0) on -> one of the 4 subpixels in the first cell
  const firstChar = renderAscii(fb)[0];
  assertEquals(firstChar, "."); // ramp[1]
});

Deno.test("renderBraille produces a 64x16 grid", () => {
  const fb = new Uint8Array(1024);
  const lines = renderBraille(fb).split("\n");
  assertEquals(lines.length, SCREEN_HEIGHT / 4);
  assertEquals([...lines[0]].length, SCREEN_WIDTH / 2);
  assertEquals(lines[0][0], "⠀"); // blank braille cell
});

Deno.test("framebufferBase64 round-trips", () => {
  const fb = new Uint8Array(1024);
  fb[5] = 0x42;
  const b64 = framebufferBase64(fb);
  const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  assertEquals(back.length, 1024);
  assertEquals(back[5], 0x42);
});
