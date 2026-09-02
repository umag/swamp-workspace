// TEST DOUBLE — import only from *_test.ts files, never from production code.
//
// Test doubles for the MongoDB driver surface this extension uses.
//
// Not a test file (does not match *_test.ts) and never imported by
// production code. Implements just enough of `Collection`, `Db` and
// `MongoClient` — filters, cursors, bulkWrite, duplicate-key errors — for the
// sync service, control-plane store, journal and sweeps to run in-process
// against an in-memory store.

export const ERR_DUP_KEY = 11000;

// Global write sequence across every fake collection, so a test can prove
// that one collection was written before another (journal before mutation).
let writeSeq = 0;
export function nextWriteSeq(): number {
  return writeSeq++;
}

type Doc = Record<string, unknown> & { _id: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !(v instanceof Date) &&
    !(v instanceof RegExp) && !(v instanceof Uint8Array) &&
    !ArrayBuffer.isView(v) && !Array.isArray(v);
}

function toRegExp(v: unknown): RegExp {
  if (v instanceof RegExp) return new RegExp(v.source, v.flags);
  if (typeof v === "string") return new RegExp(v);
  throw new Error(`unsupported $regex operand: ${String(v)}`);
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  if (x === y) return 0;
  return (x as number) < (y as number) ? -1 : 1;
}

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (isPlainObject(cond) && Object.keys(cond).some((k) => k.startsWith("$"))) {
    for (const [op, operand] of Object.entries(cond)) {
      switch (op) {
        case "$gt":
          if (
            !(value !== undefined && value !== null && cmp(value, operand) > 0)
          ) return false;
          break;
        case "$gte":
          if (
            !(value !== undefined && value !== null && cmp(value, operand) >= 0)
          ) return false;
          break;
        case "$lt":
          if (
            !(value !== undefined && value !== null && cmp(value, operand) < 0)
          ) return false;
          break;
        case "$lte":
          if (
            !(value !== undefined && value !== null && cmp(value, operand) <= 0)
          ) return false;
          break;
        case "$in":
          if (!(operand as unknown[]).some((o) => o === value)) return false;
          break;
        case "$nin":
          if ((operand as unknown[]).some((o) => o === value)) return false;
          break;
        case "$ne":
          if (
            operand === null
              ? (value === null || value === undefined)
              : value === operand
          ) return false;
          break;
        case "$exists":
          if ((value !== undefined) !== Boolean(operand)) return false;
          break;
        case "$regex":
          if (typeof value !== "string" || !toRegExp(operand).test(value)) {
            return false;
          }
          break;
        case "$not":
          if (
            fieldMatches(
              value,
              operand instanceof RegExp ? { $regex: operand } : operand,
            )
          ) return false;
          break;
        default:
          throw new Error(`unsupported operator ${op}`);
      }
    }
    return true;
  }
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof RegExp) {
    return typeof value === "string" && cond.test(value);
  }
  return value === cond;
}

export function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(cond as Record<string, unknown>[]).some((f) => matches(doc, f))) {
        return false;
      }
      continue;
    }
    if (key === "$and") {
      if (!(cond as Record<string, unknown>[]).every((f) => matches(doc, f))) {
        return false;
      }
      continue;
    }
    if (!fieldMatches(doc[key], cond)) return false;
  }
  return true;
}

function project(doc: Doc, projection?: Record<string, number>): Doc {
  if (!projection) return { ...doc };
  const keys = Object.keys(projection).filter((k) => projection[k]);
  const out: Doc = { _id: doc._id };
  for (const k of keys) if (k in doc) out[k] = doc[k];
  return out;
}

class FakeCursor {
  #docs: Doc[];
  #projection?: Record<string, number>;
  constructor(docs: Doc[], projection?: Record<string, number>) {
    this.#docs = docs;
    this.#projection = projection;
  }
  sort(spec: Record<string, 1 | -1>): FakeCursor {
    const [[field, dir]] = Object.entries(spec);
    const sorted = [...this.#docs].sort((a, b) =>
      cmp(a[field], b[field]) * dir
    );
    return new FakeCursor(sorted, this.#projection);
  }
  limit(n: number): FakeCursor {
    return new FakeCursor(this.#docs.slice(0, n), this.#projection);
  }
  project(p: Record<string, number>): FakeCursor {
    return new FakeCursor(this.#docs, p);
  }
  toArray(): Promise<Doc[]> {
    return Promise.resolve(this.#docs.map((d) => project(d, this.#projection)));
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Doc> {
    for (const d of this.#docs) yield project(d, this.#projection);
  }
}

export interface BulkResult {
  insertedCount: number;
  upsertedCount: number;
  modifiedCount: number;
  matchedCount: number;
  deletedCount: number;
}

export class FakeCollection {
  readonly name: string;
  readonly store = new Map<string, Doc>();
  /** Every write call, in order — tests assert on this to prove what a phase touched. */
  readonly writes: Array<{ op: string; args: unknown; seq: number }> = [];
  /** Filters passed to find/findOne, for tests that assert on query shape. */
  readonly queries: Record<string, unknown>[] = [];
  /** When set, the next bulkWrite throws this error once. */
  failNextBulkWrite: Error | null = null;

  constructor(name: string) {
    this.name = name;
  }

  seed(docs: Doc[]): this {
    for (const d of docs) this.store.set(d._id, { ...d });
    return this;
  }

  docs(): Doc[] {
    return [...this.store.values()].map((d) => ({ ...d })).sort((a, b) =>
      cmp(a._id, b._id)
    );
  }

  createIndex(): Promise<string> {
    return Promise.resolve("ok");
  }

  find(
    filter: Record<string, unknown> = {},
    opts?: { projection?: Record<string, number> },
  ): FakeCursor {
    this.queries.push(filter);
    return new FakeCursor(
      this.docs().filter((d) => matches(d, filter)),
      opts?.projection,
    );
  }

  findOne(
    filter: Record<string, unknown> = {},
    opts?: { projection?: Record<string, number> },
  ): Promise<Doc | null> {
    this.queries.push(filter);
    const hit = this.docs().find((d) => matches(d, filter));
    return Promise.resolve(hit ? project(hit, opts?.projection) : null);
  }

  countDocuments(
    filter: Record<string, unknown> = {},
    opts?: { limit?: number },
  ): Promise<number> {
    const n = this.docs().filter((d) => matches(d, filter)).length;
    return Promise.resolve(
      opts?.limit !== undefined ? Math.min(n, opts.limit) : n,
    );
  }

  insertOne(doc: Doc): Promise<{ insertedId: string }> {
    this.writes.push({ seq: nextWriteSeq(), op: "insertOne", args: doc });
    if (this.store.has(doc._id)) {
      return Promise.reject(
        Object.assign(new Error(`E11000 duplicate key: ${doc._id}`), {
          code: ERR_DUP_KEY,
        }),
      );
    }
    this.store.set(doc._id, { ...doc });
    return Promise.resolve({ insertedId: doc._id });
  }

  updateOne(
    filter: Record<string, unknown>,
    update: {
      $set?: Record<string, unknown>;
      $setOnInsert?: Record<string, unknown>;
    },
    opts?: { upsert?: boolean },
  ): Promise<
    { matchedCount: number; modifiedCount: number; upsertedCount: number }
  > {
    this.writes.push({
      seq: nextWriteSeq(),
      op: "updateOne",
      args: { filter, update, opts },
    });
    const hit = this.docs().find((d) => matches(d, filter));
    if (hit) {
      this.store.set(hit._id, { ...hit, ...(update.$set ?? {}) });
      return Promise.resolve({
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
      });
    }
    if (opts?.upsert) {
      const id = filter._id as string;
      this.store.set(id, {
        _id: id,
        ...(update.$setOnInsert ?? {}),
        ...(update.$set ?? {}),
      });
      return Promise.resolve({
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 1,
      });
    }
    return Promise.resolve({
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
    });
  }

  replaceOne(
    filter: Record<string, unknown>,
    doc: Doc,
    opts?: { upsert?: boolean },
  ): Promise<{ matchedCount: number }> {
    this.writes.push({
      seq: nextWriteSeq(),
      op: "replaceOne",
      args: { filter, doc, opts },
    });
    const hit = this.docs().find((d) => matches(d, filter));
    if (hit) {
      this.store.set(hit._id, { ...doc, _id: hit._id });
      return Promise.resolve({ matchedCount: 1 });
    }
    if (opts?.upsert) this.store.set(doc._id, { ...doc });
    return Promise.resolve({ matchedCount: 0 });
  }

  deleteOne(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    this.writes.push({ seq: nextWriteSeq(), op: "deleteOne", args: filter });
    const hit = this.docs().find((d) => matches(d, filter));
    if (!hit) return Promise.resolve({ deletedCount: 0 });
    this.store.delete(hit._id);
    return Promise.resolve({ deletedCount: 1 });
  }

  deleteMany(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    this.writes.push({ seq: nextWriteSeq(), op: "deleteMany", args: filter });
    const doomed = this.docs().filter((d) => matches(d, filter));
    for (const d of doomed) this.store.delete(d._id);
    return Promise.resolve({ deletedCount: doomed.length });
  }

  async bulkWrite(
    ops: Record<string, unknown>[],
    _opts?: { ordered?: boolean },
  ): Promise<BulkResult> {
    this.writes.push({ seq: nextWriteSeq(), op: "bulkWrite", args: ops });
    if (this.failNextBulkWrite) {
      const err = this.failNextBulkWrite;
      this.failNextBulkWrite = null;
      throw err;
    }
    const res: BulkResult = {
      insertedCount: 0,
      upsertedCount: 0,
      modifiedCount: 0,
      matchedCount: 0,
      deletedCount: 0,
    };
    const writeErrors: Array<{ code: number; index: number }> = [];
    ops.forEach((op, index) => {
      if ("insertOne" in op) {
        const doc = (op.insertOne as { document: Doc }).document;
        if (this.store.has(doc._id)) {
          writeErrors.push({ code: ERR_DUP_KEY, index });
        } else {
          this.store.set(doc._id, { ...doc });
          res.insertedCount++;
        }
      } else if ("updateOne" in op) {
        const u = op.updateOne as {
          filter: Record<string, unknown>;
          update: { $set?: Record<string, unknown> };
          upsert?: boolean;
        };
        const hit = this.docs().find((d) => matches(d, u.filter));
        if (hit) {
          this.store.set(hit._id, { ...hit, ...(u.update.$set ?? {}) });
          res.matchedCount++;
          res.modifiedCount++;
        } else if (u.upsert) {
          const id = u.filter._id as string;
          this.store.set(id, { _id: id, ...(u.update.$set ?? {}) });
          res.upsertedCount++;
        }
      } else if ("deleteOne" in op) {
        const f = (op.deleteOne as { filter: Record<string, unknown> }).filter;
        const hit = this.docs().find((d) => matches(d, f));
        if (hit) {
          this.store.delete(hit._id);
          res.deletedCount++;
        }
      } else {
        throw new Error(`unsupported bulk op ${Object.keys(op)[0]}`);
      }
    });
    if (writeErrors.length > 0) {
      throw Object.assign(new Error("bulk write error"), {
        writeErrors,
        insertedCount: res.insertedCount,
      });
    }
    return await Promise.resolve(res);
  }
}

export class FakeDb {
  readonly collections = new Map<string, FakeCollection>();
  collection(name: string): FakeCollection {
    let c = this.collections.get(name);
    if (!c) {
      c = new FakeCollection(name);
      this.collections.set(name, c);
    }
    return c;
  }
  listCollections(
    _filter?: unknown,
    _opts?: unknown,
  ): { toArray(): Promise<Array<{ name: string }>> } {
    const names = [...this.collections.keys()].sort();
    return { toArray: () => Promise.resolve(names.map((name) => ({ name }))) };
  }
  command(_spec: unknown): Promise<Record<string, unknown>> {
    return Promise.resolve({ ok: 1 });
  }
}

export class FakeClient {
  readonly dbs = new Map<string, FakeDb>();
  db(name: string): FakeDb {
    let d = this.dbs.get(name);
    if (!d) {
      d = new FakeDb();
      this.dbs.set(name, d);
    }
    return d;
  }
  connect(): Promise<this> {
    return Promise.resolve(this);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A `getClient` factory the sync service and verifier accept. */
export function fakeClientFactory(client = new FakeClient()) {
  return {
    client,
    getClient: (repoDir: string) =>
      Promise.resolve({
        client: client as unknown as import("npm:mongodb@6.17.0").MongoClient,
        repoDir,
      }),
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
