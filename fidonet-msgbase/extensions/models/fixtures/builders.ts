/**
 * Byte-accurate synthetic fixture Factory for @magistr/fidonet-msgbase's
 * three on-disk formats — JAM (`.jhr`/`.jdt`), Squish (`.sqd`), and FTS-0001
 * (`.msg`). This is the INVERSE of the production parsers in
 * `fidonet_msgbase.ts` (`parseJamFixedHeader`/`parseJamMessages`,
 * `parseSquishMessages`, `parseFtsMsg`) — every helper here writes exactly
 * the bytes the shipped parser reads, at the same offsets, so a passing test
 * proves the parser's byte-level contract instead of hand-waving over it.
 *
 * fidonet_msgbase.ts is BYTE-FROZEN; nothing here imports from it (it exports
 * only `model`, no parser internals) — every suite drives the parsers
 * indirectly via `model.methods.<m>.execute()` against files this module
 * writes to a per-test temp directory.
 *
 * All content produced by this module is 100% SYNTHETIC — see
 * ./PROVENANCE.md. No real FidoNet message-base bytes, sysop names, or
 * addresses appear anywhere in this file or its test-side callers.
 */

// ---------------------------------------------------------------------------
// Low-level byte helpers
// ---------------------------------------------------------------------------

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function asciiBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Zero-pad or truncate `v` into exactly `len` bytes (NUL-padded, like the
 * fixed-width string fields in Squish's XMSG and FTS-0001's `.msg` header). */
function packFixedField(
  v: string | Uint8Array | undefined,
  len: number,
): Uint8Array {
  const out = new Uint8Array(len); // zero-initialized
  if (v === undefined) return out;
  const bytes = v instanceof Uint8Array ? v : asciiBytes(v);
  out.set(bytes.subarray(0, Math.min(bytes.length, len)), 0);
  return out;
}

// ---------------------------------------------------------------------------
// CP866 — the exact inverse of fidonet_msgbase.ts's decodeCP866 tables
// ---------------------------------------------------------------------------

// Mirrors decodeCP866's cp866Upper (0x80-0xAF) / cp866Lower (0xE0-0xEF) /
// cp866Extra tables verbatim so encodeCp866(decodeCp866Text(bytes)) round
// -trips for every byte those tables cover.
const CP866_UPPER = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп"; // 0x80-0xAF (48)
const CP866_LOWER = "рстуфхцчшщъыьэюя"; // 0xE0-0xEF (16)
const CP866_EXTRA: Record<string, number> = {
  "░": 0xb0,
  "▒": 0xb1,
  "▓": 0xb2,
  "Ё": 0xf0,
  "ё": 0xf1,
  "Є": 0xf2,
  "є": 0xf3,
  "Ї": 0xf4,
  "ї": 0xf5,
  "Ў": 0xf6,
  "ў": 0xf7,
  "°": 0xf8,
  "№": 0xfc,
};

/** Encode text to CP866 bytes using the same table the production
 * `decodeCP866` decodes with. Throws on any character outside those tables —
 * fixtures needing unmapped high bytes should build the Uint8Array by hand
 * to exercise that (pinned-bug) path explicitly. */
export function encodeCp866(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const idxUpper = CP866_UPPER.indexOf(ch);
    if (idxUpper >= 0) {
      bytes.push(0x80 + idxUpper);
      continue;
    }
    const idxLower = CP866_LOWER.indexOf(ch);
    if (idxLower >= 0) {
      bytes.push(0xe0 + idxLower);
      continue;
    }
    if (CP866_EXTRA[ch] !== undefined) {
      bytes.push(CP866_EXTRA[ch]);
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    throw new Error(`encodeCp866: unmappable character ${JSON.stringify(ch)}`);
  }
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// JAM — fixed 1024-byte area header + message headers (76B + subfields) @1024
// ---------------------------------------------------------------------------

/** loID values `parseJamMessages` understands (JAM subfield IDs). */
export const JAM_LOID = {
  OADDRESS: 0,
  SENDERNAME: 2,
  RECEIVERNAME: 3,
  SUBJECT: 6,
} as const;

export interface JamSubfields {
  address?: string | Uint8Array; // loID 0
  from?: string | Uint8Array; // loID 2
  to?: string | Uint8Array; // loID 3
  subject?: string | Uint8Array; // loID 6
  /** Extra raw subfields (loID, bytes) appended after the four above — for
   * adversarial tests exercising unknown loIDs or malformed subfield chains. */
  extra?: Array<{ loID: number; data: Uint8Array }>;
}

function encodeSubfieldValue(v: string | Uint8Array | undefined): Uint8Array {
  if (v === undefined) return new Uint8Array(0);
  return v instanceof Uint8Array ? v : asciiBytes(v);
}

/** Builds the raw subfield block (JAM: [loID u16][hiID u16][datLen u32][data])
 * repeated per field, exactly matching `parseJamMessages`'s subfield loop. */
export function buildJamSubfields(fields: JamSubfields): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (loID: number, val: string | Uint8Array | undefined) => {
    if (val === undefined) return;
    const data = encodeSubfieldValue(val);
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint16(0, loID, true);
    view.setUint16(2, 0, true); // hiID — read as padding, never inspected
    view.setUint32(4, data.length, true);
    parts.push(header, data);
  };
  push(JAM_LOID.OADDRESS, fields.address);
  push(JAM_LOID.SENDERNAME, fields.from);
  push(JAM_LOID.RECEIVERNAME, fields.to);
  push(JAM_LOID.SUBJECT, fields.subject);
  for (const e of fields.extra ?? []) {
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint16(0, e.loID, true);
    view.setUint32(4, e.data.length, true);
    parts.push(header, e.data);
  }
  return concatBytes(parts);
}

export interface JamMessageSpec {
  msgNum: number;
  dateWritten: number; // unix seconds
  deleted?: boolean; // sets attr's 0x80000000 bit
  attrOverride?: number; // raw attr override (adversarial use)
  subfields: JamSubfields;
  txtOffset?: number;
  txtLen?: number;
  /** Override the encoded subfieldLen field independent of the actual
   * subfield bytes written — for adversarial oversized/undersized-length
   * cases (OOB subfield reads). */
  subfieldLenOverride?: number;
  /** Corrupt the 3-byte "JAM" per-message signature — for adversarial bad-
   * signature (mid-stream truncation) cases. */
  badSignature?: boolean;
}

/** Builds one JAM message header block: 76-byte fixed part + subfields.
 * Mirrors the exact offsets `parseJamMessages` reads: sig@0, subfieldLen@8,
 * dateWritten@36, msgNum@48, attr@52, txtOffset@60, txtLen@64, subfields@76. */
export function buildJamMessageHeader(spec: JamMessageSpec): Uint8Array {
  const subfieldBytes = buildJamSubfields(spec.subfields);
  const header = new Uint8Array(76);
  if (spec.badSignature) {
    header.set(asciiBytes("BAD"), 0);
  } else {
    header.set(asciiBytes("JAM"), 0);
  }
  const view = new DataView(header.buffer);
  view.setUint32(
    8,
    spec.subfieldLenOverride ?? subfieldBytes.length,
    true,
  );
  view.setUint32(36, spec.dateWritten >>> 0, true);
  view.setUint32(48, spec.msgNum >>> 0, true);
  const attr = spec.attrOverride !== undefined
    ? spec.attrOverride
    : (spec.deleted ? 0x80000000 : 0);
  view.setUint32(52, attr >>> 0, true);
  view.setUint32(60, (spec.txtOffset ?? 0) >>> 0, true);
  view.setUint32(64, (spec.txtLen ?? 0) >>> 0, true);
  return concatBytes([header, subfieldBytes]);
}

/** Builds the fixed 1024-byte JAM area header: sig@0 "JAM", activeMsgs@12,
 * baseMsgNum@20 — matches `parseJamFixedHeader` exactly. */
export function buildJamFixedHeader(
  opts: { activeMsgs: number; baseMsgNum?: number; badSignature?: boolean },
): Uint8Array {
  const header = new Uint8Array(1024);
  if (!opts.badSignature) header.set(asciiBytes("JAM"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(12, opts.activeMsgs >>> 0, true);
  view.setUint32(20, (opts.baseMsgNum ?? 1) >>> 0, true);
  return header;
}

/** Low-level: fixed header + already-built message header blocks. Use this
 * when a test needs to control subfieldLen/txtOffset/txtLen precisely
 * (adversarial OOB cases). For the common case, use `buildJamAreaFiles`. */
export function buildJamArea(
  opts: {
    activeMsgs?: number;
    baseMsgNum?: number;
    badSignature?: boolean;
    messages: JamMessageSpec[];
  },
): Uint8Array {
  const header = buildJamFixedHeader({
    activeMsgs: opts.activeMsgs ??
      opts.messages.filter((m) => !m.deleted).length,
    baseMsgNum: opts.baseMsgNum,
    badSignature: opts.badSignature,
  });
  return concatBytes([header, ...opts.messages.map(buildJamMessageHeader)]);
}

export interface JamMessageInput {
  msgNum: number;
  dateWritten: number;
  deleted?: boolean;
  address?: string | Uint8Array;
  from?: string | Uint8Array;
  to?: string | Uint8Array;
  subject?: string | Uint8Array;
  /** Body text appended to the returned `.jdt` buffer; txtOffset/txtLen are
   * computed automatically. Omit to leave the message bodiless (txtLen 0). */
  body?: string | Uint8Array;
}

/** High-level JAM area+text builder: lays out message bodies sequentially
 * into a `.jdt` buffer and wires each message's txtOffset/txtLen to match,
 * exactly like a real JAM area/text pair on disk. */
export function buildJamAreaFiles(
  opts: {
    activeMsgs?: number;
    baseMsgNum?: number;
    messages: JamMessageInput[];
  },
): { jhr: Uint8Array; jdt: Uint8Array } {
  const jdtParts: Uint8Array[] = [];
  let jdtOffset = 0;
  const specs: JamMessageSpec[] = [];
  for (const m of opts.messages) {
    let txtOffset = 0;
    let txtLen = 0;
    if (m.body !== undefined) {
      const bodyBytes = m.body instanceof Uint8Array
        ? m.body
        : asciiBytes(m.body);
      txtOffset = jdtOffset;
      txtLen = bodyBytes.length;
      jdtParts.push(bodyBytes);
      jdtOffset += bodyBytes.length;
    }
    specs.push({
      msgNum: m.msgNum,
      dateWritten: m.dateWritten,
      deleted: m.deleted,
      subfields: {
        address: m.address,
        from: m.from,
        to: m.to,
        subject: m.subject,
      },
      txtOffset,
      txtLen,
    });
  }
  const jhr = buildJamArea({
    activeMsgs: opts.activeMsgs,
    baseMsgNum: opts.baseMsgNum,
    messages: specs,
  });
  return { jhr, jdt: concatBytes(jdtParts) };
}

// ---------------------------------------------------------------------------
// Squish — 256-byte(+) area header (numMsg@4, beginFrame@104) + SQHDR frames
// ---------------------------------------------------------------------------

export const SQUISH_FRAME_ID = 0xafae4453;

export interface SquishMessageInput {
  attr?: number;
  from?: string | Uint8Array; // 36 bytes
  to?: string | Uint8Array; // 36 bytes
  subject?: string | Uint8Array; // 72 bytes
  zone?: number;
  net?: number;
  node?: number;
  point?: number;
  /** Preferred: a calendar date/time, packed via `packScombo` (the exact
   * inverse of `parseScombo`). */
  dateWritten?: {
    year: number;
    month: number; // 1-12
    day: number;
    hour: number;
    min: number;
    sec: number; // even seconds only (DOS time halves seconds)
  };
  /** Raw combo override — for adversarial malformed-date cases. */
  scomboRaw?: number;
  /** Bytes between the fixed XMSG (238B) and the body — real Squish control
   * info (kludges); the parser never inspects these, only counts them via
   * `clen`. */
  controlInfo?: Uint8Array;
  body?: string | Uint8Array;
  frameType?: number; // default 0 (normal message frame)
  /** Override the encoded msgLength independent of actual bytes written —
   * for adversarial truncated-frame / OOB-body cases. */
  msgLengthOverride?: number;
}

/** The exact inverse of `parseScombo`: packs a calendar date/time into the
 * DOS-style combo u32 (low 16 bits = date, high 16 bits = time). */
export function packScombo(
  d: {
    year: number;
    month: number;
    day: number;
    hour: number;
    min: number;
    sec: number;
  },
): number {
  const date16 = (d.day & 0x1f) | ((d.month & 0x0f) << 5) |
    (((d.year - 1980) & 0x7f) << 9);
  const time16 = (Math.floor(d.sec / 2) & 0x1f) | ((d.min & 0x3f) << 5) |
    ((d.hour & 0x1f) << 11);
  return (date16 | (time16 << 16)) >>> 0;
}

interface BuiltFrame {
  body: Uint8Array; // XMSG(238) + controlInfo + bodyBytes
  msgLength: number;
  clen: number;
  frameType: number;
}

function buildFrameBody(m: SquishMessageInput): BuiltFrame {
  const xmsg = new Uint8Array(238);
  const view = new DataView(xmsg.buffer);
  view.setUint32(0, (m.attr ?? 0) >>> 0, true);
  xmsg.set(packFixedField(m.from, 36), 4);
  xmsg.set(packFixedField(m.to, 36), 40);
  xmsg.set(packFixedField(m.subject, 72), 76);
  view.setUint16(148, (m.zone ?? 2) & 0xffff, true);
  view.setUint16(150, (m.net ?? 5020) & 0xffff, true);
  view.setUint16(152, (m.node ?? 1) & 0xffff, true);
  view.setUint16(154, (m.point ?? 0) & 0xffff, true);
  const combo = m.scomboRaw ?? (m.dateWritten ? packScombo(m.dateWritten) : 0);
  view.setUint32(164, combo >>> 0, true);
  const control = m.controlInfo ?? new Uint8Array(0);
  const bodyBytes = m.body === undefined
    ? new Uint8Array(0)
    : (m.body instanceof Uint8Array ? m.body : asciiBytes(m.body));
  const frameType = m.frameType ?? 0;
  const msgLength = m.msgLengthOverride ??
    (238 + control.length + bodyBytes.length);
  return {
    body: concatBytes([xmsg, control, bodyBytes]),
    msgLength,
    clen: control.length,
    frameType,
  };
}

/** Builds a full `.sqd` buffer: area header (numMsg@4, beginFrame@104) plus
 * a chain of SQHDR(28B)+XMSG(238B)+control+body frames, each frame's
 * nextFrame pointing at the next frame's offset (0 terminates the chain —
 * matches `parseSquishMessages`'s `frameOfs > 0` loop guard). */
export function buildSquishArea(
  opts: {
    numMsg?: number;
    headerSize?: number; // default 256
    messages: SquishMessageInput[];
    /** Override the LAST frame's nextFrame pointer instead of 0 — for
     * structurally characterizing (never executing) a frame-chain cycle. */
    lastNextFrameOverride?: number;
  },
): Uint8Array {
  const headerSize = opts.headerSize ?? 256;
  const built = opts.messages.map(buildFrameBody);
  const offsets: number[] = [];
  let cursor = opts.messages.length > 0 ? headerSize : 0;
  for (const f of built) {
    offsets.push(cursor);
    cursor += 28 + f.body.length;
  }
  const totalSize = Math.max(cursor, headerSize);
  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  view.setUint32(4, (opts.numMsg ?? opts.messages.length) >>> 0, true);
  view.setUint32(
    104,
    (opts.messages.length > 0 ? headerSize : 0) >>> 0,
    true,
  );
  for (let i = 0; i < built.length; i++) {
    const f = built[i];
    const off = offsets[i];
    view.setUint32(off + 0, SQUISH_FRAME_ID, true);
    const isLast = i === built.length - 1;
    const next = isLast ? (opts.lastNextFrameOverride ?? 0) : offsets[i + 1];
    view.setUint32(off + 4, next >>> 0, true);
    view.setUint32(off + 16, f.msgLength >>> 0, true);
    view.setUint32(off + 20, f.clen >>> 0, true);
    view.setUint16(off + 24, f.frameType & 0xffff, true);
    buf.set(f.body, off + 28);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// FTS-0001 — 190-byte fixed header + null-terminated body (kludges + text)
// ---------------------------------------------------------------------------

export interface FtsKludge {
  key: string;
  value: string;
}

export interface FtsMsgInput {
  from?: string | Uint8Array; // 36
  to?: string | Uint8Array; // 36
  subject?: string | Uint8Array; // 72
  dateStr?: string; // 20, e.g. "28 Aug 05  00:07:48"
  destNode?: number;
  origNode?: number;
  origNet?: number;
  destNet?: number;
  attr?: number;
  /** `\x01KEY value` kludge lines, written before the body lines. */
  kludges?: FtsKludge[];
  bodyLines?: string[];
  /** Omit the NUL body terminator entirely (exercises the `bodyEnd === -1`
   * -> `data.length` branch). */
  noTerminator?: boolean;
}

/** Builds one FTS-0001 `.msg` buffer: fixed 190-byte header (from@0, to@36,
 * subject@72, date@144, dest/orig node+net@166-175, attr@188) followed by a
 * `\r`-joined, NUL-terminated body of kludge lines then message lines —
 * matches `parseFtsMsg` exactly. */
export function buildFtsMsg(input: FtsMsgInput): Uint8Array {
  const kludgeLines = (input.kludges ?? []).map((k) =>
    `\x01${k.key} ${k.value}`
  );
  const bodyLines = input.bodyLines ?? [];
  const allLines = [...kludgeLines, ...bodyLines];
  const bodyRaw = allLines.length > 0 ? allLines.join("\r") : "";
  const bodyBytes = asciiBytes(bodyRaw);
  const headerLen = 190;
  const totalLen = headerLen + bodyBytes.length + (input.noTerminator ? 0 : 1);
  const buf = new Uint8Array(totalLen); // zero-initialized => NUL terminator free
  const view = new DataView(buf.buffer);
  buf.set(packFixedField(input.from, 36), 0);
  buf.set(packFixedField(input.to, 36), 36);
  buf.set(packFixedField(input.subject, 72), 72);
  buf.set(packFixedField(input.dateStr, 20), 144);
  view.setUint16(166, (input.destNode ?? 0) & 0xffff, true);
  view.setUint16(168, (input.origNode ?? 0) & 0xffff, true);
  view.setUint16(172, (input.origNet ?? 0) & 0xffff, true);
  view.setUint16(174, (input.destNet ?? 0) & 0xffff, true);
  view.setUint16(188, (input.attr ?? 0) & 0xffff, true);
  buf.set(bodyBytes, 190);
  return buf;
}

// ---------------------------------------------------------------------------
// Timezone-safe date helper
// ---------------------------------------------------------------------------

/**
 * Both `parseScombo` and `parseFtsDate` build the decoded timestamp via
 * `new Date(year, month-1, day, hour, min, sec).getTime()` — i.e. the
 * CALENDAR fields are interpreted in the process's LOCAL timezone, not UTC.
 * Tests must never hardcode an absolute ISO-string expectation (it would
 * only match on a machine sharing the author's TZ offset). Instead, derive
 * the expected epoch/ISO with this exact same construction, so the
 * expectation and the fixture agree under ANY host timezone, CI included.
 */
export function localEpochSeconds(
  d: {
    year: number;
    month: number; // 1-12
    day: number;
    hour: number;
    min: number;
    sec: number;
  },
): number {
  return Math.floor(
    new Date(d.year, d.month - 1, d.day, d.hour, d.min, d.sec).getTime() /
      1000,
  );
}

/** Formats a calendar tuple as an FTS-0001 date string, e.g.
 * "28 Aug 05  00:07:48" (two spaces before the time, matching common FTS
 * netmail packet output that `parseFtsDate`'s regex tolerates via `\s+`). */
export function formatFtsDateStr(
  d: {
    year: number;
    month: number;
    day: number;
    hour: number;
    min: number;
    sec: number;
  },
): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const yy = pad2(d.year % 100);
  return `${pad2(d.day)} ${months[d.month - 1]} ${yy}  ${pad2(d.hour)}:${
    pad2(d.min)
  }:${pad2(d.sec)}`;
}

// ---------------------------------------------------------------------------
// Fixture-tree writer — assembles a synthetic msgbase under a temp basePath
// ---------------------------------------------------------------------------

export type AreaFixture =
  | { kind: "jam"; jhr: Uint8Array; jdt?: Uint8Array }
  | { kind: "squish"; sqd: Uint8Array }
  | { kind: "raw"; files: Record<string, Uint8Array> };

export interface FixtureTree {
  /** Area name (without extension) -> its on-disk representation. */
  areas?: Record<string, AreaFixture>;
  /** netmail/<filename>.msg -> bytes. */
  netmail?: Record<string, Uint8Array>;
  /** Arbitrary extra files written directly under basePath (e.g. a
   * traversal-escape target that must stay INSIDE the temp tree). */
  extraFiles?: Record<string, Uint8Array>;
}

/** Materializes a `FixtureTree` under `basePath` (expected to be a
 * `Deno.makeTempDir()` result) using real `Deno.writeFile`/`Deno.mkdir` — no
 * FS stubbing anywhere in this suite. */
export async function writeFixtureTree(
  basePath: string,
  tree: FixtureTree,
): Promise<void> {
  for (const [name, area] of Object.entries(tree.areas ?? {})) {
    if (area.kind === "jam") {
      await Deno.writeFile(`${basePath}/${name}.jhr`, area.jhr);
      if (area.jdt) await Deno.writeFile(`${basePath}/${name}.jdt`, area.jdt);
    } else if (area.kind === "squish") {
      await Deno.writeFile(`${basePath}/${name}.sqd`, area.sqd);
    } else {
      for (const [fname, bytes] of Object.entries(area.files)) {
        await Deno.writeFile(`${basePath}/${fname}`, bytes);
      }
    }
  }
  if (tree.netmail) {
    await Deno.mkdir(`${basePath}/netmail`, { recursive: true });
    for (const [fname, bytes] of Object.entries(tree.netmail)) {
      await Deno.writeFile(`${basePath}/netmail/${fname}`, bytes);
    }
  }
  for (const [fname, bytes] of Object.entries(tree.extraFiles ?? {})) {
    await Deno.writeFile(`${basePath}/${fname}`, bytes);
  }
}

/** Test helper: makes a temp dir, runs `fn(basePath)`, always removes the
 * dir afterward (recursive) — matches the `makeTempDir` + `finally` cleanup
 * pattern used by the comfyui/bandcamp backfills. Returns whatever `fn`
 * returns (e.g. a boolean for a fast-check property predicate). */
export async function withTempMsgbase<T = void>(
  tree: FixtureTree,
  fn: (basePath: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "fidonet-msgbase-test-" });
  try {
    await writeFixtureTree(dir, tree);
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
