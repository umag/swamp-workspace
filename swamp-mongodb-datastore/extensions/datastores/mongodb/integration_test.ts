// Integration tests against a real replica set. Skipped unless
// MONGO_TEST_URI is set (with credentials embedded, e.g.
// mongodb://user:pass@host:27017/?replicaSet=rs0&authSource=admin).
// Uses a throwaway tenant so it can never touch a real namespace, and drops
// its collections afterwards.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { MongoClient } from "npm:mongodb@6.17.0";
import { createControlPlaneStore } from "./control_plane.ts";
import { createJournal } from "../../models/journal.ts";
import { foldNamespacePrefix } from "../../models/sweeps.ts";
import { enc } from "./test_fakes.ts";

const uri = Deno.env.get("MONGO_TEST_URI");

interface ControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

Deno.test({
  name:
    "integration: control plane on a real replica set — putIfAbsent race, list, delete",
  ignore: !uri,
  async fn() {
    const client = new MongoClient(uri!, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const ns = `itest-${crypto.randomUUID().slice(0, 8)}`;
    const collName = `t_itest_r_${ns}_control`;
    const coll = client.db("swamp").collection(collName);
    try {
      const store = createControlPlaneStore(
        coll as never,
        ns,
      ) as ControlPlaneStore;
      const wins = await Promise.all(
        Array.from(
          { length: 10 },
          (_, i) => store.putIfAbsent("claims/x", enc(`w${i}`)),
        ),
      );
      assertEquals(wins.filter(Boolean).length, 1);
      await store.put("heartbeats/b", enc("1"));
      await store.put("heartbeats/a", enc("1"));
      assertEquals(await store.list("heartbeats/"), [
        "heartbeats/a",
        "heartbeats/b",
      ]);
      await store.delete("heartbeats/a");
      await store.delete("heartbeats/a");
      assertEquals(await store.list("heartbeats/"), ["heartbeats/b"]);
      assert((await store.get("claims/x")) !== null);
    } finally {
      await coll.drop().catch(() => undefined);
      await client.close();
    }
  },
});

Deno.test({
  name:
    "integration: fold then revert round-trips _paths byte-for-byte on a real replica set",
  ignore: !uri,
  async fn() {
    const client = new MongoClient(uri!, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const ns = `itest-${crypto.randomUUID().slice(0, 8)}`;
    const db = client.db("swamp");
    interface PathRow {
      _id: string;
      hash: string;
      size: number;
      updatedAt: Date;
      deletedAt: Date | null;
    }
    const paths = db.collection<PathRow>(`t_itest_r_${ns}_paths`);
    const runs = db.collection(`t_itest_r_${ns}_migrations`);
    const ops = db.collection(`t_itest_r_${ns}_migration_ops`);
    try {
      const old = new Date("2026-08-01T00:00:00Z");
      const newer = new Date("2026-08-10T00:00:00Z");
      await paths.insertMany([
        { _id: "data/a", hash: "h", size: 1, updatedAt: old, deletedAt: null },
        {
          _id: `${ns}/data/a`,
          hash: "h",
          size: 1,
          updatedAt: newer,
          deletedAt: null,
        },
        {
          _id: `${ns}/data/b`,
          hash: "p",
          size: 1,
          updatedAt: newer,
          deletedAt: null,
        },
      ]);
      const snapshot = await paths.find({}).sort({ _id: 1 }).toArray();
      const journal = createJournal({
        runs: runs as never,
        ops: ops as never,
        target: () => paths as never,
      });
      const r = await foldNamespacePrefix(paths as never, journal, {
        namespace: ns,
        dryRun: false,
        now: new Date("2026-09-02T12:00:00Z"),
      });
      assertEquals(r.refused, null);
      assertEquals(
        await paths.countDocuments({ _id: "data/b", deletedAt: null }),
        1,
      );
      const rv = await journal.revert(r.runId!, { dryRun: false });
      assertEquals(rv.refused, null);
      assertEquals(await paths.find({}).sort({ _id: 1 }).toArray(), snapshot);
    } finally {
      for (const c of [paths, runs, ops]) await c.drop().catch(() => undefined);
      await client.close();
    }
  },
});
