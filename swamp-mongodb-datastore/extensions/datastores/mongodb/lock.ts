import type { Collection, MongoServerError } from "npm:mongodb@6.17.0";
import type { ClientHandle } from "./client.ts";
import { lockCollectionName, type MongoDatastoreConfig } from "./config.ts";

export interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  nonce?: string;
}

export interface LockOptions {
  lockKey?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

export interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}

export class LockTimeoutError extends Error {
  constructor(
    public readonly lockKey: string,
    public readonly waitedMs: number,
    public readonly holder?: LockInfo,
  ) {
    super(
      holder
        ? `Lock "${lockKey}" held by ${holder.holder} (pid ${holder.pid}) — timed out after ${waitedMs}ms`
        : `Lock "${lockKey}" — timed out after ${waitedMs}ms`,
    );
    this.name = "LockTimeoutError";
  }
}

interface LockDoc {
  _id: string;
  holder: string;
  hostname: string;
  pid: number;
  acquiredAtMs: number;
  ttlMs: number;
  expiresAt: Date;
  nonce: string;
}

const GLOBAL_LOCK_KEY = "__global__";

function holderString(): string {
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "unknown";
  return `${user}@${Deno.hostname()}`;
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    (err as MongoServerError).code === 11000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toLockInfo(doc: LockDoc): LockInfo {
  return {
    holder: doc.holder,
    hostname: doc.hostname,
    pid: doc.pid,
    acquiredAt: new Date(doc.acquiredAtMs).toISOString(),
    ttlMs: doc.ttlMs,
    nonce: doc.nonce,
  };
}

export function createLock(
  cfg: MongoDatastoreConfig,
  getClient: (repoDir: string) => Promise<ClientHandle>,
  repoDir: string,
  options: LockOptions | undefined,
): DistributedLock {
  const lockKey = options?.lockKey ?? GLOBAL_LOCK_KEY;
  const ttlMs = options?.ttlMs ?? cfg.defaultLockTtlMs;
  const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;

  const collectionName = lockCollectionName(cfg);
  let myNonce: string | undefined;
  let heartbeatTimer: number | undefined;

  async function getCollection(): Promise<Collection<LockDoc>> {
    const { client } = await getClient(repoDir);
    return client.db(cfg.database).collection<LockDoc>(collectionName);
  }

  async function tryTakeOver(
    coll: Collection<LockDoc>,
    now: Date,
  ): Promise<string | null> {
    const nonce = crypto.randomUUID();
    try {
      const result = await coll.findOneAndUpdate(
        { _id: lockKey, expiresAt: { $lte: now } },
        {
          $set: {
            holder: holderString(),
            hostname: Deno.hostname(),
            pid: Deno.pid,
            acquiredAtMs: now.getTime(),
            ttlMs,
            expiresAt: new Date(now.getTime() + ttlMs),
            nonce,
          },
        },
        { returnDocument: "after" },
      );
      if (result && result.nonce === nonce) return nonce;
      return null;
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  }

  async function tryInsert(
    coll: Collection<LockDoc>,
    now: Date,
  ): Promise<string | null> {
    const nonce = crypto.randomUUID();
    try {
      await coll.insertOne({
        _id: lockKey,
        holder: holderString(),
        hostname: Deno.hostname(),
        pid: Deno.pid,
        acquiredAtMs: now.getTime(),
        ttlMs,
        expiresAt: new Date(now.getTime() + ttlMs),
        nonce,
      });
      return nonce;
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  }

  function startHeartbeat(coll: Collection<LockDoc>, nonce: string): void {
    const interval = Math.max(1_000, Math.floor(ttlMs / 3));
    heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          await coll.updateOne(
            { _id: lockKey, nonce },
            { $set: { expiresAt: new Date(Date.now() + ttlMs) } },
          );
        } catch {
          // Heartbeat failures are logged by the caller via other means;
          // swallow here so the interval keeps running.
        }
      })();
    }, interval);
  }

  return {
    async acquire(): Promise<void> {
      if (myNonce) return;
      const coll = await getCollection();
      const start = Date.now();

      while (true) {
        const now = new Date();
        const takeOver = await tryTakeOver(coll, now);
        if (takeOver) {
          myNonce = takeOver;
          startHeartbeat(coll, takeOver);
          return;
        }
        const inserted = await tryInsert(coll, now);
        if (inserted) {
          myNonce = inserted;
          startHeartbeat(coll, inserted);
          return;
        }

        const waited = Date.now() - start;
        if (waited >= maxWaitMs) {
          const existing = await coll.findOne({ _id: lockKey });
          throw new LockTimeoutError(
            lockKey,
            waited,
            existing ? toLockInfo(existing) : undefined,
          );
        }
        await sleep(retryIntervalMs);
      }
    },

    async release(): Promise<void> {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      const nonce = myNonce;
      myNonce = undefined;
      if (!nonce) return;
      const coll = await getCollection();
      await coll.deleteOne({ _id: lockKey, nonce });
    },

    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      await this.acquire();
      try {
        return await fn();
      } finally {
        await this.release();
      }
    },

    async inspect(): Promise<LockInfo | null> {
      const coll = await getCollection();
      const doc = await coll.findOne({ _id: lockKey });
      return doc ? toLockInfo(doc) : null;
    },

    async forceRelease(expectedNonce: string): Promise<boolean> {
      const coll = await getCollection();
      const result = await coll.deleteOne({
        _id: lockKey,
        nonce: expectedNonce,
      });
      return result.deletedCount === 1;
    },
  };
}
