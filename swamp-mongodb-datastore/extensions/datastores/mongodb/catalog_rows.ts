// Core's catalog export, stored as one document per catalog row in
// `t_<tenant>_r_<ns>_catalog` instead of one content-addressed blob per
// snapshot.
//
// Core rewrites `<ns>/.catalog-export.json` — the whole namespace catalog,
// 85–290 MB on real repos — after every push. Synced as an ordinary file, each
// rewrite hashed differently and orphaned the previous blob until a sweep ran
// (~140 GB in a month). Here the file never syncs (isExcludedPath); instead
// each push diffs its rows against what this host last published and writes
// only the rows that changed. A new data version is typically two row writes
// (the new row plus its predecessor losing is_latest), not a 290 MB upload.
//
// Merge semantics across peers: a host upserts rows whose content changed
// since ITS last publish and deletes only rows IT published earlier and no
// longer holds. A host that has not pulled a peer's newer data therefore never
// erases or reverts it — unlike the whole-file snapshot, where the last writer
// silently won.
//
// The collection is the backing store for pullForeignCatalogs (cross-namespace
// `swamp datastore catalog pull`).

import type { BaseStore } from "./stores.ts";

export const CATALOG_EXPORT_BASENAME = ".catalog-export.json";

// Host-local record of what this host last published: the export's stat stamp
// (mtimeMs, size) followed by one row hash per row, all float64. ~2 MB for a
// 290k-row catalog. Lives at the namespace root, which the push walk never
// enters (DATASTORE_SUBDIRS only).
const STATE_BASENAME = ".catalog-rows.state";

// Rows per bulkWrite / `$in` batch. A row is ~1 KB, so a batch stays far under
// the 48 MB wire message cap.
const CATALOG_BULK = 1000;

const READ_CHUNK = 1024 * 1024;

export interface CatalogRowDoc {
  _id: string;
  h: number;
  [field: string]: unknown;
}

export type CatalogRowsStore = BaseStore<CatalogRowDoc>;

type Row = Record<string, unknown>;

interface State {
  mtimeMs: number;
  size: number;
  hashes: Set<number>;
}

export interface ScannedRow {
  /** 53-bit hash of the row's raw bytes (cyrb53). */
  h: number;
  /** Decodes the row's JSON text — only called for rows that changed. */
  text(): string;
}

// Core's catalog primary key: (namespace, type_normalized, model_id,
// data_name, version). The namespace is implied by the collection.
export function catalogRowKey(row: Row): string {
  return JSON.stringify([
    row.type_normalized,
    row.model_id,
    row.data_name,
    row.version,
  ]);
}

const decoder = new TextDecoder();

function decodeParts(parts: Uint8Array[]): string {
  if (parts.length === 1) return decoder.decode(parts[0]);
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return decoder.decode(out);
}

/**
 * Streams the top-level objects of a JSON array file, one batch per read,
 * each with a hash of its raw bytes, scanning bytes rather than decoded text. String-aware, so braces,
 * commas and escaped quotes inside values (e.g. the `tags` JSON string) are
 * not mistaken for structure; every structural byte is ASCII, so UTF-8
 * multi-byte sequences can never be misread.
 *
 * Hashing is cyrb53 folded into the scan — change detection only; a collision
 * merely skips one row rewrite until its content changes again.
 */
export async function* scanExportRows(
  path: string,
  chunkBytes = READ_CHUNK,
): AsyncGenerator<ScannedRow[]> {
  const file = await Deno.open(path, { read: true });
  const st: ScanState = {
    depth: 0,
    inString: false,
    escaped: false,
    h1: 0,
    h2: 0,
    pieces: [],
  };
  try {
    while (true) {
      // Fresh buffer per read: a row's pieces are views into it.
      const buf = new Uint8Array(chunkBytes);
      const n = await file.read(buf);
      if (n === null) break;
      // One batch per read: a per-row async step costs more than the scan.
      const rows = scanChunk(buf, n, st);
      if (rows.length > 0) yield rows;
    }
  } finally {
    file.close();
  }
}

interface ScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
  h1: number;
  h2: number;
  pieces: Uint8Array[];
}

// The hot loop, kept out of the generator: V8 optimizes a plain function's
// locals far better than a generator frame (~5x on a 210 MB export).
function scanChunk(buf: Uint8Array, n: number, st: ScanState): ScannedRow[] {
  const rows: ScannedRow[] = [];
  let { depth, inString, escaped, h1, h2 } = st;
  let start = depth > 0 ? 0 : -1;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (depth === 0) {
      // Between rows: `[`, `,`, `]`, whitespace.
      if (c !== 0x7b) continue;
      depth = 1;
      start = i;
      h1 = Math.imul(0xdeadbeef ^ c, 2654435761);
      h2 = Math.imul(0x41c6ce57 ^ c, 1597334677);
      continue;
    }
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true; // backslash
      else if (c === 0x22) inString = false; // quote
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b) depth++;
    else if (c === 0x7d && --depth === 0) {
      st.pieces.push(buf.subarray(start, i + 1));
      const parts = st.pieces;
      let a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
        Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      const b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
        Math.imul(a ^ (a >>> 13), 3266489909);
      a = a >>> 0;
      rows.push({
        h: 4294967296 * (2097151 & b) + a,
        text: () => decodeParts(parts),
      });
      st.pieces = [];
      start = -1;
    }
  }
  if (depth > 0) st.pieces.push(buf.subarray(start, n));
  Object.assign(st, { depth, inString, escaped, h1, h2 });
  return rows;
}

/** Raw JSON text of each row — convenience over scanExportRows. */
export async function* iterateExportRows(
  path: string,
  chunkBytes = READ_CHUNK,
): AsyncGenerator<string> {
  for await (const rows of scanExportRows(path, chunkBytes)) {
    for (const r of rows) yield r.text();
  }
}

async function readState(path: string): Promise<State | null> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  // Corrupt or foreign-format state: treat as a first sync (never deletes).
  if (bytes.byteLength < 16 || bytes.byteLength % 8 !== 0) return null;
  const f = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.length / 8);
  const hashes = new Set<number>();
  for (let i = 2; i < f.length; i++) hashes.add(f[i]);
  return { mtimeMs: f[0], size: f[1], hashes };
}

async function writeState(path: string, state: State): Promise<void> {
  const f = new Float64Array(2 + state.hashes.size);
  f[0] = state.mtimeMs;
  f[1] = state.size;
  let i = 2;
  for (const h of state.hashes) f[i++] = h;
  const tmp = `${path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  await Deno.writeFile(tmp, new Uint8Array(f.buffer));
  await Deno.rename(tmp, path);
}

async function remoteHashes(store: CatalogRowsStore): Promise<Set<number>> {
  const out = new Set<number>();
  for await (const d of store.find({}, { projection: { h: 1 } })) {
    if (typeof d.h === "number") out.add(d.h);
  }
  return out;
}

/**
 * Publishes the rows of `<root>/.catalog-export.json` that changed since this
 * host last published, and retracts rows it published that are gone. Returns
 * the number of row documents written or deleted. State is saved only after
 * every write succeeded, so a failure is retried in full on the next push.
 *
 * An unchanged row — nearly all of them, on any push — costs one hash and one
 * set lookup; it is never decoded or parsed.
 */
export async function syncCatalogRows(
  store: CatalogRowsStore,
  root: string,
): Promise<number> {
  const exportPath = `${root}/${CATALOG_EXPORT_BASENAME}`;
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(exportPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return 0;
    throw err;
  }
  const mtimeMs = stat.mtime?.getTime() ?? 0;
  const statePath = `${root}/${STATE_BASENAME}`;
  let prev = await readState(statePath);
  // A remote emptied behind our back (dropped, restored) makes local state a
  // lie; fall back to a first sync so every row is republished.
  if (prev !== null && prev.hashes.size > 0) {
    if ((await store.countDocuments({}, { limit: 1 })) === 0) prev = null;
  }
  if (prev !== null && prev.mtimeMs === mtimeMs && prev.size === stat.size) {
    return 0;
  }

  // First sync from this host: learn the remote's hashes so identical rows
  // are not rewritten, but own nothing — deletions are only ever retractions
  // of this host's own earlier publishes.
  const known = prev?.hashes ?? await remoteHashes(store);
  const owned = prev?.hashes ?? new Set<number>();

  let changes = 0;
  let ops: Record<string, unknown>[] = [];
  const flush = async () => {
    if (ops.length === 0) return;
    await store.bulkWrite(ops, { ordered: false });
    changes += ops.length;
    ops = [];
  };

  const next = new Set<number>();
  const upserted = new Set<string>();
  for await (const rows of scanExportRows(exportPath)) {
    for (const r of rows) {
      next.add(r.h);
      if (known.has(r.h)) continue;
      const row = JSON.parse(r.text()) as Row;
      const key = catalogRowKey(row);
      upserted.add(key);
      ops.push({
        updateOne: {
          filter: { _id: key },
          update: { $set: { ...row, h: r.h } },
          upsert: true,
        },
      });
      if (ops.length >= CATALOG_BULK) await flush();
    }
  }
  await flush();

  // Rows this host published whose exact content is gone. A doc still
  // carrying such a hash was neither re-published above nor since replaced
  // by a peer (that would have changed its hash) — retract it.
  const vanished = [...owned].filter((h) => !next.has(h));
  for (let i = 0; i < vanished.length; i += CATALOG_BULK) {
    const batch = vanished.slice(i, i + CATALOG_BULK);
    for await (
      const d of store.find({ h: { $in: batch } }, { projection: { _id: 1 } })
    ) {
      if (upserted.has(d._id)) continue;
      ops.push({ deleteOne: { filter: { _id: d._id, h: { $in: batch } } } });
    }
    await flush();
  }

  await writeState(statePath, { mtimeMs, size: stat.size, hashes: next });
  return changes;
}

/** Every stored row of one namespace, in core's CatalogExportRow shape. */
export async function readForeignCatalog(
  store: CatalogRowsStore,
): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const d of store.find({})) {
    const { _id: _key, h: _hash, ...row } = d;
    rows.push(row);
  }
  return rows;
}
