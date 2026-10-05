/**
 * `@magistr/led-badge` — drive a 44x11 LED name badge (USB 0416:5020, WCH
 * CH583 "LSLED" / Badge Magic family) from swamp.
 *
 * - `detect`  — find the badge's HID interface (no write).
 * - `preview` — render messages to ASCII frames without touching the device.
 * - `send`    — render and upload up to 8 messages (replaces what is stored).
 *
 * USB I/O goes through a small Rust hidapi helper (`bin/hid-send`), built
 * once with cargo and cached under ~/.cache/swamp-led-badge (macOS + Linux).
 * Protocol and font live in ./lib/protocol.ts.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  bitmapWidth,
  buildPayload,
  centre,
  framesToBitmap,
  HEIGHT,
  MAX_FRAMES,
  MAX_MESSAGES,
  type Message,
  MODES,
  parseArt,
  renderAscii,
  renderText,
  REPORT_SIZE,
  SYMBOL_NAMES,
  WIDTH,
} from "./lib/protocol.ts";

/** BLE GATT write size the badge accepts (exactly 16 bytes per write). */
const BLE_CHUNK = 16;

const GlobalArgsSchema = z.object({
  transport: z.enum(["usb", "ble"]).default("usb").describe(
    "usb (HID, cable) or ble (Bluetooth LE, badge advertises as LSLED)",
  ),
  bleName: z.string().default("LSLED").describe(
    "BLE advertised name; any device advertising service FEE0 also matches",
  ),
  bleScanSeconds: z.number().int().min(1).max(60).default(20).describe(
    "How long to scan for the badge over BLE",
  ),
  blePin: z.string().regex(/^\d{4}$/).optional().describe(
    "4-digit PIN shown by a badge in BT-PAIRING protection mode, if enabled",
  ),
  vendorId: z.number().int().default(0x0416).describe(
    "USB vendor id (default 0x0416 = 1046)",
  ),
  productId: z.number().int().default(0x5020).describe(
    "USB product id (default 0x5020 = 20512)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const MessageSchema = z.object({
  text: z.string().max(500).optional().describe(
    `Text in a 5x7 ASCII font. Symbols: ${
      SYMBOL_NAMES.map((s) => `:${s}:`).join(" ")
    }`,
  ),
  art: z.array(z.string()).max(HEIGHT).optional().describe(
    `Pixel art rows ('#' on, '.' off), up to ${HEIGHT} rows`,
  ),
  frames: z.array(z.array(z.string()).max(HEIGHT)).max(MAX_FRAMES).optional()
    .describe(
      "Animation frames, each pixel art up to 44 px wide. Implies " +
        "mode=animation; speed sets the frame rate",
    ),
  mode: z.enum(MODES).default("left").describe("Display mode"),
  speed: z.number().int().min(1).max(8).default(4).describe("Speed 1..8"),
  blink: z.boolean().default(false).describe("Blink the message"),
  border: z.boolean().default(false).describe("Marching-ants border"),
}).refine(
  (m) => [m.text, m.art, m.frames].filter((v) => v !== undefined).length === 1,
  { message: "each message needs exactly one of text, art or frames" },
);

const SendArgsSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES).describe(
    `1..${MAX_MESSAGES} messages; the badge cycles through them`,
  ),
  brightness: z.union([
    z.literal(25),
    z.literal(50),
    z.literal(75),
    z.literal(100),
  ]).default(100).describe("Brightness percent"),
});

type SendArgs = z.infer<typeof SendArgsSchema>;

interface ExecContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  extensionFile?: (path: string) => string;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

interface RenderedMessage {
  index: number;
  source: string;
  mode: string;
  speed: number;
  blink: boolean;
  border: boolean;
  widthPx: number;
  frame: string[];
}

function toMessages(args: SendArgs): {
  messages: Message[];
  rendered: RenderedMessage[];
} {
  const messages: Message[] = [];
  const rendered: RenderedMessage[] = [];
  args.messages.forEach((input, index) => {
    // Frames always play in animation mode.
    const m = input.frames ? { ...input, mode: "animation" as const } : input;
    let bitmap = m.text !== undefined
      ? renderText(m.text)
      : m.frames
      ? framesToBitmap(m.frames)
      : parseArt(m.art!);
    // Static modes look best centred on the 44-px window.
    if (m.mode === "fixed" || m.mode === "up" || m.mode === "down") {
      bitmap = centre(bitmap);
    }
    messages.push({
      bitmap,
      mode: m.mode,
      speed: m.speed,
      blink: m.blink,
      border: m.border,
    });
    rendered.push({
      index,
      source: m.text ??
        (m.frames ? `(animation, ${m.frames.length} frames)` : "(pixel art)"),
      mode: m.mode,
      speed: m.speed,
      blink: m.blink,
      border: m.border,
      widthPx: bitmapWidth(bitmap),
      frame: renderAscii(bitmap),
    });
  });
  return { messages, rendered };
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(d)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

const HELPER_FILES = [
  "bin/hid-send/Cargo.toml",
  "bin/hid-send/Cargo.lock",
  "bin/hid-send/src/main.rs",
];

/** Build (once, cached by source hash) and return the Rust helper path. */
async function helperPath(context: ExecContext): Promise<string> {
  // A prebuilt helper (packaging, tests) skips the cargo build entirely.
  const override = Deno.env.get("LED_BADGE_HELPER");
  if (override) return override;
  const resolve = (p: string) =>
    context.extensionFile
      ? context.extensionFile(p)
      : new URL(`../../${p}`, import.meta.url).pathname;
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is not set; cannot cache the HID helper");
  const sources = await Promise.all(
    HELPER_FILES.map((p) => Deno.readTextFile(resolve(p))),
  );
  const hash = (await sha256Hex(sources.join("\0"))).slice(0, 12);
  const dir = `${home}/.cache/swamp-led-badge`;
  const bin = `${dir}/hid-send-${hash}`;
  try {
    await Deno.stat(bin);
    return bin;
  } catch {
    // not built yet
  }
  await Deno.mkdir(dir, { recursive: true });
  const cargoHome = `${home}/.cargo/bin/cargo`;
  const cargo = await Deno.stat(cargoHome).then(() => cargoHome, () => "cargo");
  const out = await new Deno.Command(cargo, {
    args: [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      resolve("bin/hid-send/Cargo.toml"),
      "--target-dir",
      `${dir}/target`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `cargo build of the HID helper failed (needs a Rust toolchain): ${
        new TextDecoder().decode(out.stderr).slice(-2000)
      }`,
    );
  }
  await Deno.copyFile(`${dir}/target/release/hid-send`, bin);
  await Deno.chmod(bin, 0o755);
  return bin;
}

interface HelperResult {
  ok: boolean;
  error?: string;
  reportsSent?: number;
  chunksSent?: number;
  devices?: Record<string, unknown>[];
}

async function runHelper(
  context: ExecContext,
  extra: string[],
  stdin?: Uint8Array,
): Promise<HelperResult> {
  const bin = await helperPath(context);
  const g = GlobalArgsSchema.parse(context.globalArgs);
  const probe = extra.includes("probe");
  const args = g.transport === "ble"
    ? [
      "ble",
      g.bleName,
      String(g.bleScanSeconds),
      probe ? "probe" : "send",
      g.blePin ?? "",
    ]
    : ["usb", String(g.vendorId), String(g.productId), ...extra];
  const child = new Deno.Command(bin, {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  if (stdin) await writer.write(stdin);
  await writer.close();
  const out = await child.output();
  const text = new TextDecoder().decode(out.stdout).trim();
  try {
    return JSON.parse(text) as HelperResult;
  } catch {
    return {
      ok: false,
      error: `helper produced no JSON (exit ${out.code}): ${text} ${
        new TextDecoder().decode(out.stderr)
      }`.slice(0, 2000),
    };
  }
}

const RenderedSchema = z.object({
  index: z.number(),
  source: z.string(),
  mode: z.string(),
  speed: z.number(),
  blink: z.boolean(),
  border: z.boolean(),
  widthPx: z.number(),
  frame: z.array(z.string()),
});

/** The `@magistr/led-badge` model definition. */
export const model = {
  type: "@magistr/led-badge",
  version: "2026.10.05.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    device: {
      description: "Detected badge HID interface(s)",
      schema: z.object({
        found: z.boolean(),
        transport: z.string(),
        vendorId: z.number(),
        productId: z.number(),
        devices: z.array(z.record(z.string(), z.unknown())),
        error: z.string().optional(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    preview: {
      description: "Rendered frames of messages (not sent)",
      schema: z.object({
        displayWidth: z.number(),
        displayHeight: z.number(),
        brightness: z.number(),
        messages: z.array(RenderedSchema),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    upload: {
      description: "Messages uploaded to the badge",
      schema: z.object({
        brightness: z.number(),
        messages: z.array(RenderedSchema),
        payloadBytes: z.number(),
        transport: z.string(),
        reportsSent: z.number().describe("USB reports or BLE 16-byte writes"),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    detect: {
      description:
        "Find the badge's 64-byte HID output interface without writing to it.",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: ExecContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const r = await runHelper(context, ["probe"]);
        await context.writeResource("device", "device", {
          found: r.ok,
          transport: g.transport,
          vendorId: g.vendorId,
          productId: g.productId,
          devices: r.devices ?? [],
          ...(r.error ? { error: r.error } : {}),
          timestamp: new Date().toISOString(),
        });
        if (!r.ok) {
          throw new Error(
            r.error ?? g.transport === "ble"
              ? `no BLE badge ${g.bleName} found`
              : `no badge ${g.vendorId}:${g.productId} connected`,
          );
        }
        return {};
      },
    },
    preview: {
      description: `Render messages to ${WIDTH}x${HEIGHT} ASCII frames ` +
        "without touching the device.",
      arguments: SendArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = SendArgsSchema.parse(rawArgs);
        const { rendered } = toMessages(args);
        await context.writeResource("preview", "preview", {
          displayWidth: WIDTH,
          displayHeight: HEIGHT,
          brightness: args.brightness,
          messages: rendered,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
    send: {
      description: "Upload 1..8 messages to the badge over USB. Replaces " +
        "every message currently stored on the badge.",
      arguments: SendArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = SendArgsSchema.parse(rawArgs);
        const { messages, rendered } = toMessages(args);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const payload = buildPayload(
          messages,
          args.brightness,
          new Date(),
          g.transport === "ble" ? BLE_CHUNK : REPORT_SIZE,
        );
        const r = await runHelper(context, [], payload);
        if (!r.ok) throw new Error(r.error ?? "upload failed");
        await context.writeResource("upload", "upload", {
          brightness: args.brightness,
          messages: rendered,
          payloadBytes: payload.length,
          transport: g.transport,
          reportsSent: r.reportsSent ?? r.chunksSent ?? 0,
          timestamp: new Date().toISOString(),
        });
        context.logger?.info("uploaded {n} message(s) to badge", {
          n: messages.length,
        });
        return {};
      },
    },
  },
};
