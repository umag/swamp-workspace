// ControlPlaneStore over the `_control` collection.
//
// Mirrors swamp core's `ControlPlaneStore` contract (domain/datastore/
// control_plane_store.ts): small coordination records — instance heartbeats,
// active runs, pending runs, cron fire records, reconcile claims, token
// secrets — that bypass the sync pipeline entirely. Keys map to document ids
// `<namespace>/_control/<key>` (or `_control/<key>` in solo mode), the same
// layout the S3 reference uses for its objects.
//
// `putIfAbsent` is `insertOne` catching the duplicate-key error and nothing
// else; that single primitive is what gives serve HA its cron de-dup and
// reconcile claims.

import { Binary } from "npm:mongodb@6.17.0";
import type { ControlDoc, ControlStore } from "./stores.ts";

const ERR_DUP_KEY = 11000;

export interface ControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Document id a key maps to — used by migrations to journal raw ids. */
  rawKey(key: string): string;
}

export function controlKey(namespace: string | undefined, key: string): string {
  return namespace ? `${namespace}/_control/${key}` : `_control/${key}`;
}

export function controlPrefix(namespace: string | undefined): string {
  return namespace ? `${namespace}/_control/` : `_control/`;
}

function assertSafeKey(key: string): void {
  if (key.length === 0) throw new Error("control-plane key must not be empty");
  if (key.startsWith("/")) {
    throw new Error(`control-plane key must be relative: ${key}`);
  }
  if (key.includes("\\") || key.includes("\0")) {
    throw new Error(`control-plane key contains an illegal character: ${key}`);
  }
  for (const seg of key.split("/")) {
    if (seg === "..") {
      throw new Error(`control-plane key must not traverse: ${key}`);
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toBytes(data: Binary | Uint8Array): Uint8Array {
  // Copy out of the driver's Buffer so callers get a plain Uint8Array.
  return data instanceof Binary
    ? new Uint8Array(data.buffer)
    : new Uint8Array(data);
}

/**
 * Builds a ControlPlaneStore. `store` may be the collection itself or a
 * thunk resolving to it, because the sync service hands out the store
 * synchronously while the client connects lazily.
 */
export function createControlPlaneStore(
  store: ControlStore | (() => Promise<ControlStore>),
  namespace?: string,
): ControlPlaneStore {
  const coll = (): Promise<ControlStore> =>
    typeof store === "function" ? store() : Promise.resolve(store);
  const rawKey = (key: string): string => {
    assertSafeKey(key);
    return controlKey(namespace, key);
  };

  return {
    rawKey,

    async put(key, data) {
      const id = rawKey(key);
      const c = await coll();
      await c.updateOne(
        { _id: id },
        { $set: { data: new Binary(data), updatedAt: new Date() } },
        { upsert: true },
      );
    },

    async putIfAbsent(key, data) {
      const id = rawKey(key);
      const c = await coll();
      try {
        await c.insertOne({
          _id: id,
          data: new Binary(data),
          updatedAt: new Date(),
        });
        return true;
      } catch (err) {
        if ((err as { code?: number }).code === ERR_DUP_KEY) return false;
        throw err;
      }
    },

    async get(key) {
      const id = rawKey(key);
      const c = await coll();
      const doc = await c.findOne({ _id: id });
      if (doc === null) return null;
      return toBytes((doc as ControlDoc).data);
    },

    async delete(key) {
      const id = rawKey(key);
      const c = await coll();
      await c.deleteOne({ _id: id });
    },

    async list(prefix) {
      if (prefix.length > 0) assertSafeKey(prefix);
      const cp = controlPrefix(namespace);
      const c = await coll();
      const out: string[] = [];
      for await (
        const doc of c.find(
          { _id: { $regex: `^${escapeRegex(cp + prefix)}` } },
          { projection: { _id: 1 } },
        )
      ) {
        out.push(doc._id.slice(cp.length));
      }
      return out.sort();
    },
  };
}
