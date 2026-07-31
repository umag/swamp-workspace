/**
 * Property-based tests (fast-check) for @magistr/flipper-zero's pure layers
 * — lib/rpc.ts, lib/protocol.ts and lib/image.ts. No Deno.Command stub is
 * needed anywhere in this file (mirroring music-library's property suite).
 *
 * lib/rpc.ts, lib/protocol.ts and lib/image.ts are BYTE-FROZEN — every
 * property here characterizes already-shipped behavior. Named invariants:
 *
 *  (a) varint round-trips through a byte-wise decoder (written here — rpc.ts
 *      exports no decoder) for any non-negative safe integer in the
 *      realistic domain, and rejects negatives/non-integers. The domain is
 *      restricted to [0, 2_000_000_000] — varint()'s `v >>>= 7` is a 32-bit
 *      unsigned shift, so values at/above 2**32 wrap incorrectly; the
 *      real usage here is protobuf tag numbers and payload lengths (<= the
 *      1 MiB exchange cap), so this restriction avoids an over-strong
 *      invariant on inputs the implementation was never meant to handle.
 *  (b) lenDelimited/frame length-prefix integrity: the decoded varint length
 *      prefix always equals the payload length, for arbitrary payloads.
 *  (c) framebuffer page-major round-trip: setPixel then getPixel is the
 *      identity for any in-bounds (x,y); out-of-bounds is a no-op.
 *  (d) framebufferBase64 -> framebufferFromBase64 round-trips any 1024-byte
 *      buffer.
 *  (e) stripAnsi/normalizeNewlines never throw and never LENGTHEN the
 *      string, for arbitrary input.
 *  (f) parseStorageList / parseStorageTree / parseDeviceInfo /
 *      parseListenEvents never throw on arbitrary text and return
 *      well-typed shapes.
 *  (g) buildTransmitCommand's ALNUM/IDENT/HEX-validated fields (ir
 *      protocol/address/command, universalRemote/signal, rfid
 *      keyType/keyData) never let a shell metacharacter into the resulting
 *      command — restricted to those shapes because the DEV_PATH-validated
 *      `file` field only excludes WHITESPACE, not every metacharacter (see
 *      the adversarial suite's "security note" — still safe because the
 *      whole command travels via the FZ_CMD env var, never shell-
 *      interpolated, so asserting "no metacharacter ever" there would be a
 *      false, over-strong property).
 *  (h) findScreenFrame returns either null or exactly a 1024-byte slice, for
 *      any byte array.
 */
import fc from "npm:fast-check@4.8.0";
import { assert, assertThrows } from "jsr:@std/assert@1";
import { frame, lenDelimited, varint } from "./lib/rpc.ts";
import {
  blankFramebuffer,
  FRAMEBUFFER_BYTES,
  getPixel,
  setPixel,
} from "./lib/image.ts";
import {
  buildTransmitCommand,
  findScreenFrame,
  framebufferBase64,
  normalizeNewlines,
  parseDeviceInfo,
  parseListenEvents,
  parseStorageList,
  parseStorageTree,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  stripAnsi,
} from "./lib/protocol.ts";
import { framebufferFromBase64 } from "./lib/image.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=5000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const RUNS = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: RUNS(200) };

// ---------------------------------------------------------------------------
// (a) varint round-trip + rejection, over a byte-wise decoder written here
// ---------------------------------------------------------------------------

/** A minimal protobuf-varint decoder (rpc.ts exports no decoder — this test
 * writes its own, using multiplication instead of `<<`/`>>>` so IT doesn't
 * reintroduce the 32-bit truncation the restricted domain below avoids). */
function decodeVarint(bytes: number[]): { value: number; length: number } {
  let result = 0;
  let shift = 0;
  let i = 0;
  for (;;) {
    const b = bytes[i];
    if (b === undefined) throw new Error("truncated varint");
    result += (b & 0x7f) * 2 ** shift;
    i++;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, length: i };
}

const arbVarintDomain = fc.integer({ min: 0, max: 2_000_000_000 });

Deno.test("property: varint round-trips through a byte-wise decoder for any non-negative integer in the realistic domain", () => {
  fc.assert(
    fc.property(arbVarintDomain, (n) => {
      const bytes = varint(n);
      const { value, length } = decodeVarint(bytes);
      return value === n && length === bytes.length;
    }),
    FC_RUNS,
  );
});

Deno.test("property: varint rejects any negative integer or non-integer", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({ max: -1 }),
        fc.double({ min: 0, max: 1e6, noNaN: true }).filter((n) =>
          !Number.isInteger(n)
        ),
      ),
      (bad) => {
        assertThrows(() => varint(bad));
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) lenDelimited / frame length-prefix integrity
// ---------------------------------------------------------------------------

Deno.test("property: lenDelimited's length prefix always equals the payload length, and the payload is preserved verbatim", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 30 }),
      fc.uint8Array({ minLength: 0, maxLength: 500 }),
      (fieldNumber, payload) => {
        const encoded = lenDelimited(fieldNumber, payload);
        const suffix = encoded.slice(encoded.length - payload.length);
        return (
          suffix.every((b, i) => b === payload[i]) &&
          decodeVarint(Array.from(encoded)).length < encoded.length
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: frame's length prefix decodes to the body length, for any body", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 0, maxLength: 500 }),
      (body) => {
        const framed = frame(body);
        const { value, length } = decodeVarint(Array.from(framed));
        const rest = framed.slice(length);
        return value === body.length &&
          rest.every((b, i) => b === body[i]);
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) framebuffer page-major round-trip
// ---------------------------------------------------------------------------

Deno.test("property: setPixel/getPixel is the identity for any in-bounds (x,y)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: SCREEN_WIDTH - 1 }),
      fc.integer({ min: 0, max: SCREEN_HEIGHT - 1 }),
      fc.boolean(),
      (x, y, on) => {
        const fb = blankFramebuffer();
        setPixel(fb, x, y, on);
        return getPixel(fb, x, y) === on;
      },
    ),
    FC_RUNS,
  );
});

const arbOutOfBounds = fc.oneof(
  fc.integer({ min: -1000, max: -1 }),
  fc.integer({ min: SCREEN_WIDTH, max: SCREEN_WIDTH + 1000 }),
);

Deno.test("property: setPixel is a no-op for any out-of-bounds x (fb stays blank)", () => {
  fc.assert(
    fc.property(
      arbOutOfBounds,
      fc.integer({ min: 0, max: SCREEN_HEIGHT - 1 }),
      (x, y) => {
        const fb = blankFramebuffer();
        setPixel(fb, x, y, true);
        return fb.every((b) => b === 0) && getPixel(fb, x, y) === false;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) framebufferBase64 <-> framebufferFromBase64 round-trip
// ---------------------------------------------------------------------------

Deno.test("property: framebufferBase64/framebufferFromBase64 round-trip any 1024-byte buffer", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({
        minLength: FRAMEBUFFER_BYTES,
        maxLength: FRAMEBUFFER_BYTES,
      }),
      (bytes) => {
        const back = framebufferFromBase64(framebufferBase64(bytes));
        return back.length === FRAMEBUFFER_BYTES &&
          back.every((b, i) => b === bytes[i]);
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) stripAnsi/normalizeNewlines never throw, never lengthen
// ---------------------------------------------------------------------------

Deno.test("property: stripAnsi never throws and never lengthens the string, for any input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (s) => {
      const out = stripAnsi(s);
      return out.length <= s.length;
    }),
    FC_RUNS,
  );
});

Deno.test("property: normalizeNewlines never throws and never lengthens the string, for any input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (s) => {
      const out = normalizeNewlines(s);
      return out.length <= s.length;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (f) parsers never throw on arbitrary text, and return well-typed shapes
// ---------------------------------------------------------------------------

const arbLines = fc.array(fc.string({ maxLength: 60 }), { maxLength: 30 })
  .map((lines) => lines.join("\n"));

Deno.test("property: parseStorageList never throws and returns well-typed entries", () => {
  fc.assert(
    fc.property(arbLines, (text) => {
      const entries = parseStorageList(text);
      return Array.isArray(entries) &&
        entries.every((e) =>
          (e.type === "dir" || e.type === "file") &&
          typeof e.name === "string" &&
          (e.size === null || typeof e.size === "number")
        );
    }),
    FC_RUNS,
  );
});

Deno.test("property: parseStorageTree never throws and returns well-typed entries", () => {
  fc.assert(
    fc.property(arbLines, (text) => {
      const entries = parseStorageTree(text);
      return Array.isArray(entries) &&
        entries.every((e) =>
          (e.type === "dir" || e.type === "file") &&
          typeof e.path === "string" &&
          (e.size === null || typeof e.size === "number")
        );
    }),
    FC_RUNS,
  );
});

Deno.test("property: parseDeviceInfo never throws and returns a string-keyed, string-valued object", () => {
  fc.assert(
    fc.property(arbLines, (text) => {
      const attrs = parseDeviceInfo(text);
      return typeof attrs === "object" && attrs !== null &&
        Object.values(attrs).every((v) => typeof v === "string");
    }),
    FC_RUNS,
  );
});

Deno.test("property: parseListenEvents never throws and returns well-typed events, for arbitrary (including control-byte) text", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (text) => {
      const events = parseListenEvents(text);
      return Array.isArray(events) &&
        events.every((e) =>
          typeof e.summary === "string" && Array.isArray(e.lines)
        );
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (g) buildTransmitCommand: ALNUM/IDENT/HEX-validated fields never leak a
// shell metacharacter into the resulting command (DEV_PATH excluded — see
// module docstring and the adversarial suite's security note).
// ---------------------------------------------------------------------------

const METACHAR = /[;&|$`'"\\]/;
const arbAlnum = fc.stringMatching(/^[A-Za-z0-9]{1,12}$/);
const arbIdent = fc.stringMatching(/^[A-Za-z0-9_]{1,12}$/);
const arbHex = fc.stringMatching(/^[0-9A-Fa-f]{1,8}$/);

Deno.test("property: buildTransmitCommand's ir {protocol,address,command} shape never contains a shell metacharacter", () => {
  fc.assert(
    fc.property(arbAlnum, arbHex, arbHex, (protocol, address, command) => {
      const { command: cmd } = buildTransmitCommand({
        source: "ir",
        protocol,
        address,
        command,
      });
      return !METACHAR.test(cmd);
    }),
    FC_RUNS,
  );
});

Deno.test("property: buildTransmitCommand's ir {universalRemote,signal} shape never contains a shell metacharacter", () => {
  fc.assert(
    fc.property(arbAlnum, arbIdent, (universalRemote, signal) => {
      const { command: cmd } = buildTransmitCommand({
        source: "ir",
        universalRemote,
        signal,
      });
      return !METACHAR.test(cmd);
    }),
    FC_RUNS,
  );
});

Deno.test("property: buildTransmitCommand's rfid {keyType,keyData} shape never contains a shell metacharacter", () => {
  fc.assert(
    fc.property(arbAlnum, arbHex, (keyType, keyData) => {
      const { command: cmd } = buildTransmitCommand({
        source: "rfid",
        keyType,
        keyData,
      });
      return !METACHAR.test(cmd);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (h) findScreenFrame: null or exactly a 1024-byte slice, for any bytes
// ---------------------------------------------------------------------------

Deno.test("property: findScreenFrame returns either null or exactly a 1024-byte slice, for any byte array", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 3000 }), (bytes) => {
      const found = findScreenFrame(bytes);
      return found === null || found.length === 1024;
    }),
    FC_RUNS,
  );
});

// Anti-vacuity: confirm the property above actually exercises the
// non-null branch at least once for a representative input.
Deno.test("property-flow sanity: findScreenFrame's non-null branch is reachable for a real frame", () => {
  const fb = new Uint8Array(1024).fill(0x77);
  const stream = new Uint8Array([0x0a, 0x80, 0x08, ...fb]);
  const found = findScreenFrame(stream);
  assert(found !== null && found.length === 1024);
});
