/**
 * Methods suite: every provider method's success and failure paths against
 * the in-memory fake KeePassXC, plus the file association store.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  createKeePassXCProvider,
  FileAssociationStore,
  resolveAssociationFile,
  resolveNamespace,
  resolveProxyPath,
} from "./mod.ts";
import {
  fakeDeps,
  FakeKeePassXC,
  MemoryAssociationStore,
} from "./fake_keepassxc_test_helper.ts";
import { ErrorCode, KeePassXCError } from "./protocol.ts";

Deno.test("first call associates and persists the association", async () => {
  const server = new FakeKeePassXC({ associationName: "my-mac" });
  const deps = fakeDeps(server);
  const p = createKeePassXCProvider("ci", {}, deps);
  await p.list();
  assertEquals(deps.store.value?.id, "my-mac");
  assertEquals(deps.store.saves, 1);
  assert(server.actions.includes("associate"));
});

Deno.test("later calls reuse the stored association via test-associate", async () => {
  const server = new FakeKeePassXC();
  const deps = fakeDeps(server);
  const p = createKeePassXCProvider("ci", {}, deps);
  await p.list();
  server.actions.length = 0;
  await p.list();
  assertEquals(server.actions, [
    "change-public-keys",
    "test-associate",
    "get-logins",
  ]);
  assertEquals(deps.store.saves, 1);
});

Deno.test("rejected stored association names the file to delete", async () => {
  const server = new FakeKeePassXC();
  const store = new MemoryAssociationStore();
  store.value = { id: "stale", idKey: "AAAA" };
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server, store));
  const err = await assertRejects(() => p.list(), KeePassXCError);
  assertEquals(err.code, ErrorCode.ASSOCIATION_FAILED);
  assert(err.message.includes("memory://association"));
});

Deno.test("cancelled association dialog surfaces the error and saves nothing", async () => {
  const server = new FakeKeePassXC({ associationName: null });
  const deps = fakeDeps(server);
  const p = createKeePassXCProvider("ci", {}, deps);
  const err = await assertRejects(() => p.list(), KeePassXCError);
  assertEquals(err.code, ErrorCode.ACTION_CANCELLED_OR_DENIED);
  assertEquals(deps.store.value, null);
});

Deno.test("put creates the entry in the configured group", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider(
    "ci",
    { group: "Infra/swamp" },
    fakeDeps(server),
  );
  await p.put("token", "s3cret");
  assertEquals(server.entries.length, 1);
  const e = server.entries[0];
  assertEquals(e.url, "swamp://ci/token");
  assertEquals(e.login, "token");
  assertEquals(e.password, "s3cret");
  assertEquals(e.groupUuid, server.groups.get("Infra/swamp"));
});

Deno.test("put updates an existing entry in place", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await p.put("token", "a");
  const uuid = server.entries[0].uuid;
  await p.put("token", "b");
  assertEquals(server.entries.length, 1);
  assertEquals(server.entries[0].uuid, uuid);
  assertEquals(await p.get("token"), "b");
});

Deno.test("get returns the stored password, rejects a missing key", async () => {
  const server = new FakeKeePassXC();
  server.seed("swamp://ci/api", "api", "value");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  assertEquals(await p.get("api"), "value");
  await assertRejects(
    () => p.get("nope"),
    Error,
    "Secret 'nope' not found in vault 'ci'",
  );
});

Deno.test("get rejects when two entries share the key", async () => {
  const server = new FakeKeePassXC();
  server.seed("swamp://ci/api", "api", "1");
  server.seed("swamp://ci/api", "api", "2");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await assertRejects(() => p.get("api"), Error, "2 KeePassXC entries");
  await assertRejects(() => p.put("api", "3"), Error, "2 KeePassXC entries");
});

Deno.test("list returns sorted unique keys of the namespace only", async () => {
  const server = new FakeKeePassXC();
  server.seed("swamp://ci/b", "b", "1");
  server.seed("swamp://ci/a", "a", "1");
  server.seed("swamp://ci/a2", "a", "1");
  server.seed("swamp://other/c", "c", "1");
  server.seed("https://ci/d", "d", "1");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  assertEquals(await p.list(), ["a", "b"]);
});

Deno.test("locked database is retried until it unlocks", async () => {
  const server = new FakeKeePassXC({ lockedCalls: 3 });
  const deps = fakeDeps(server);
  const p = createKeePassXCProvider("ci", { unlockWaitSeconds: 10 }, deps);
  assertEquals(await p.list(), []);
  assertEquals(deps.clock.t, 3000);
  assert(server.transports.every((t) => t.closed));
});

Deno.test("locked database fails after unlockWaitSeconds", async () => {
  const server = new FakeKeePassXC({ lockedCalls: 1000 });
  const deps = fakeDeps(server);
  const p = createKeePassXCProvider("ci", { unlockWaitSeconds: 2 }, deps);
  const err = await assertRejects(() => p.list(), KeePassXCError);
  assertEquals(err.code, ErrorCode.DATABASE_NOT_OPENED);
});

Deno.test("unlockWaitSeconds 0 fails immediately", async () => {
  const server = new FakeKeePassXC({ lockedCalls: 1 });
  const deps = fakeDeps(server);
  const p = createKeePassXCProvider("ci", { unlockWaitSeconds: 0 }, deps);
  await assertRejects(() => p.list(), KeePassXCError);
  assertEquals(deps.clock.t, 0);
});

Deno.test("triggerUnlock false omits the flag", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider(
    "ci",
    { triggerUnlock: false },
    fakeDeps(server),
  );
  await p.list();
  assert(server.transports[0].sent.every((f) => !("triggerUnlock" in f)));
});

Deno.test("resolveNamespace: explicit, derived, and unusable", () => {
  const cfg = (o: Record<string, unknown>) => ({
    group: "swamp",
    timeoutSeconds: 1,
    triggerUnlock: true,
    unlockWaitSeconds: 0,
    ...o,
  });
  assertEquals(resolveNamespace("x", cfg({ namespace: "prod" })), "prod");
  assertEquals(resolveNamespace("My Vault_1", cfg({})), "my-vault-1");
  assertThrows(
    () => resolveNamespace("!!!", cfg({})),
    Error,
    "set 'namespace'",
  );
});

Deno.test("resolveProxyPath: config, macOS bundle, PATH fallback", () => {
  const base = {
    group: "swamp",
    timeoutSeconds: 1,
    triggerUnlock: true,
    unlockWaitSeconds: 0,
  };
  const env = () => "/Users/u";
  assertEquals(
    resolveProxyPath({ ...base, proxyPath: "/x" }, {
      env,
      exists: () => true,
      os: "darwin",
    }),
    "/x",
  );
  assertEquals(
    resolveProxyPath(base, { env, exists: () => true, os: "darwin" }),
    "/Applications/KeePassXC.app/Contents/MacOS/keepassxc-proxy",
  );
  assertEquals(
    resolveProxyPath(base, {
      env,
      exists: (p) => p.startsWith("/Users/u/"),
      os: "darwin",
    }),
    "/Users/u/Applications/KeePassXC.app/Contents/MacOS/keepassxc-proxy",
  );
  assertEquals(
    resolveProxyPath(base, { env, exists: () => true, os: "linux" }),
    "keepassxc-proxy",
  );
});

Deno.test("resolveAssociationFile: default under ~/.config, explicit wins", () => {
  const base = {
    group: "swamp",
    timeoutSeconds: 1,
    triggerUnlock: true,
    unlockWaitSeconds: 0,
  };
  assertEquals(
    resolveAssociationFile("prod/x", base, { env: () => "/h" }),
    "/h/.config/swamp/keepassxc/prod_x.json",
  );
  assertEquals(
    resolveAssociationFile("v", { ...base, associationFile: "/a.json" }, {
      env: () => undefined,
    }),
    "/a.json",
  );
  assertThrows(() =>
    resolveAssociationFile("v", base, { env: () => undefined })
  );
});

Deno.test("FileAssociationStore: missing -> null, save 0600, roundtrip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = new FileAssociationStore(`${dir}/nested/a.json`);
    assertEquals(await store.load(), null);
    await store.save({ id: "mac", idKey: "KEY" });
    assertEquals(await store.load(), { id: "mac", idKey: "KEY" });
    if (Deno.build.os !== "windows") {
      assertEquals(
        (await Deno.stat(`${dir}/nested/a.json`)).mode! & 0o777,
        0o600,
      );
      assertEquals((await Deno.stat(`${dir}/nested`)).mode! & 0o777, 0o700);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FileAssociationStore: malformed files are rejected", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/bad.json`, "{not json");
    await assertRejects(
      () => new FileAssociationStore(`${dir}/bad.json`).load(),
      Error,
      "not valid JSON",
    );
    await Deno.writeTextFile(`${dir}/partial.json`, '{"id":"x"}');
    await assertRejects(
      () => new FileAssociationStore(`${dir}/partial.json`).load(),
      Error,
      "missing",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
