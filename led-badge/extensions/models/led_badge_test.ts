/**
 * Contract/fixture tests for @magistr/led-badge: the model's public shape
 * (type, version, methods, resources, global-argument defaults) and the
 * argument schemas against representative fixtures.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parse as parseYaml } from "jsr:@std/yaml@1";
import { model } from "./led_badge.ts";

Deno.test("model type/version match the manifest", async () => {
  const manifest = parseYaml(
    await Deno.readTextFile(new URL("../../manifest.yaml", import.meta.url)),
  ) as { name: string; version: string };
  assertEquals(model.type, manifest.name);
  assertEquals(model.version, manifest.version);
});

Deno.test("exposes exactly detect, preview and send", () => {
  assertEquals(Object.keys(model.methods).sort(), [
    "detect",
    "preview",
    "send",
  ]);
  assertEquals(Object.keys(model.resources).sort(), [
    "device",
    "preview",
    "upload",
  ]);
});

Deno.test("global argument defaults target the USB badge", () => {
  const g = model.globalArguments.parse({});
  assertEquals(g.transport, "usb");
  assertEquals(g.vendorId, 0x0416);
  assertEquals(g.productId, 0x5020);
  assertEquals(g.bleName, "LSLED");
  assertEquals(g.bleScanSeconds, 20);
  assertEquals(g.blePin, undefined);
});

Deno.test("send/preview argument fixtures parse with defaults", () => {
  const a = model.methods.send.arguments.parse({
    messages: [
      { text: "Hello :heart:" },
      { art: ["#.#", ".#."], mode: "fixed", border: true },
      { frames: [["#"], [".#"]], speed: 8 },
    ],
  });
  assertEquals(a.brightness, 100);
  assertEquals(a.messages[0].mode, "left");
  assertEquals(a.messages[0].speed, 4);
  assertEquals(a.messages[1].border, true);
  assert(a.messages[2].frames);
  assertEquals(
    JSON.stringify(
      model.methods.preview.arguments.parse({ messages: [{ text: "x" }] }),
    ),
    JSON.stringify(
      model.methods.send.arguments.parse({ messages: [{ text: "x" }] }),
    ),
  );
});

Deno.test("each message needs exactly one content field", () => {
  const p = (m: Record<string, unknown>) =>
    model.methods.send.arguments.parse({ messages: [m] });
  assertThrows(() => p({}));
  assertThrows(() => p({ text: "a", art: ["#"] }));
  assertThrows(() => p({ text: "a", frames: [["#"]] }));
});

Deno.test("resource schemas accept the shapes the methods write", () => {
  model.resources.device.schema.parse({
    found: true,
    transport: "usb",
    vendorId: 1046,
    productId: 20512,
    devices: [{ product: "CH583" }],
    timestamp: new Date().toISOString(),
  });
  model.resources.upload.schema.parse({
    brightness: 50,
    messages: [],
    payloadBytes: 128,
    transport: "ble",
    reportsSent: 8,
    timestamp: new Date().toISOString(),
  });
});
