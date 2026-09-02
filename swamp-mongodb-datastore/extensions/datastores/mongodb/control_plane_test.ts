// RED tests for ./control_plane.ts — the ControlPlaneStore over the
// `_control` collection. Oracle: swamp core's fs_control_plane_store_test.ts,
// plus namespace scoping and regex-safe prefix listing.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import * as cpModule from "./control_plane.ts";
import { dec, enc, FakeCollection } from "./test_fakes.ts";

interface ControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

interface ControlPlaneModule {
  createControlPlaneStore(
    store: unknown,
    namespace?: string,
  ): ControlPlaneStore;
  controlKey(namespace: string | undefined, key: string): string;
}

function mod(): Promise<ControlPlaneModule> {
  return Promise.resolve(cpModule as unknown as ControlPlaneModule);
}

function setup(namespace?: string) {
  const coll = new FakeCollection("t_default_r_ns_control");
  return {
    coll,
    store: mod().then((m) => m.createControlPlaneStore(coll, namespace)),
  };
}

Deno.test("control plane: put and get round-trip", async () => {
  const { store } = setup();
  const s = await store;
  await s.put("heartbeats/i1", enc("alive"));
  assertEquals(dec((await s.get("heartbeats/i1"))!), "alive");
});

Deno.test("control plane: get returns null for a missing key", async () => {
  const s = await setup().store;
  assertEquals(await s.get("nope"), null);
});

Deno.test("control plane: put overwrites an existing key", async () => {
  const s = await setup().store;
  await s.put("k", enc("one"));
  await s.put("k", enc("two"));
  assertEquals(dec((await s.get("k"))!), "two");
});

Deno.test("control plane: delete removes the key and is idempotent", async () => {
  const s = await setup().store;
  await s.put("k", enc("v"));
  await s.delete("k");
  assertEquals(await s.get("k"), null);
  await s.delete("k");
  assertEquals(await s.get("k"), null);
});

Deno.test("control plane: list filters by prefix, returns relative keys sorted", async () => {
  const s = await setup().store;
  await s.put("heartbeats/b", enc("1"));
  await s.put("heartbeats/a", enc("1"));
  await s.put("pending-runs/x", enc("1"));
  assertEquals(await s.list("heartbeats/"), ["heartbeats/a", "heartbeats/b"]);
  assertEquals(await s.list("missing/"), []);
  assertEquals(await s.list(""), [
    "heartbeats/a",
    "heartbeats/b",
    "pending-runs/x",
  ]);
});

Deno.test("control plane: nested key paths and binary data round-trip", async () => {
  const s = await setup().store;
  const bytes = new Uint8Array([0, 255, 1, 254, 10, 13]);
  await s.put("active-runs/inst/run/1", bytes);
  assertEquals(await s.get("active-runs/inst/run/1"), bytes);
  assertEquals(await s.list("active-runs/inst/"), ["active-runs/inst/run/1"]);
});

Deno.test("control plane: delete then put the same key works", async () => {
  const s = await setup().store;
  await s.put("k", enc("a"));
  await s.delete("k");
  await s.put("k", enc("b"));
  assertEquals(dec((await s.get("k"))!), "b");
});

Deno.test("control plane: putIfAbsent returns true on a new key and false on an existing one, preserving data", async () => {
  const s = await setup().store;
  assertEquals(await s.putIfAbsent("fire/1", enc("first")), true);
  assertEquals(await s.putIfAbsent("fire/1", enc("second")), false);
  assertEquals(dec((await s.get("fire/1"))!), "first");
});

Deno.test("control plane: putIfAbsent after delete returns true", async () => {
  const s = await setup().store;
  await s.putIfAbsent("k", enc("a"));
  await s.delete("k");
  assertEquals(await s.putIfAbsent("k", enc("b")), true);
});

Deno.test("control plane: ten concurrent putIfAbsent calls — exactly one wins", async () => {
  const s = await setup().store;
  const results = await Promise.all(
    Array.from(
      { length: 10 },
      (_, i) => s.putIfAbsent("claims/x", enc(`w${i}`)),
    ),
  );
  assertEquals(results.filter((r) => r).length, 1);
});

Deno.test("control plane: rejects path traversal and absolute keys", async () => {
  const s = await setup().store;
  await assertRejects(() => s.put("../escape", enc("x")));
  await assertRejects(() => s.put("a/../b", enc("x")));
  await assertRejects(() => s.put("/abs", enc("x")));
  await assertRejects(() => s.get("../escape"));
});

Deno.test("control plane: list escapes regex metacharacters in the prefix", async () => {
  const s = await setup().store;
  await s.put("a.b/1", enc("x"));
  await s.put("aXb/1", enc("x"));
  assertEquals(await s.list("a.b/"), ["a.b/1"]);
});

Deno.test("control plane: keys are stored under <ns>/_control/ and namespaces do not see each other", async () => {
  const m = await mod();
  const coll = new FakeCollection("t_default_r_ns_control");
  const a = m.createControlPlaneStore(coll, "alpha");
  const b = m.createControlPlaneStore(coll, "beta");
  const solo = m.createControlPlaneStore(coll, undefined);
  await a.put("heartbeats/1", enc("a"));
  await b.put("heartbeats/1", enc("b"));
  await solo.put("heartbeats/1", enc("s"));
  assertEquals(dec((await a.get("heartbeats/1"))!), "a");
  assertEquals(dec((await b.get("heartbeats/1"))!), "b");
  assertEquals(dec((await solo.get("heartbeats/1"))!), "s");
  assertEquals(await a.list(""), ["heartbeats/1"]);
  const ids = coll.docs().map((d) => d._id).sort();
  assertEquals(ids, [
    "_control/heartbeats/1",
    "alpha/_control/heartbeats/1",
    "beta/_control/heartbeats/1",
  ]);
  assertEquals(m.controlKey("alpha", "x/y"), "alpha/_control/x/y");
  assertEquals(m.controlKey(undefined, "x/y"), "_control/x/y");
});

Deno.test("control plane: only duplicate-key errors turn into false; other errors propagate", async () => {
  const m = await mod();
  const coll = new FakeCollection("c");
  const boom = new Error("network down");
  coll.insertOne = () => Promise.reject(boom);
  const s = m.createControlPlaneStore(coll, undefined);
  await assertRejects(
    () => s.putIfAbsent("k", enc("v")),
    Error,
    "network down",
  );
  assert(coll.docs().length === 0);
});
