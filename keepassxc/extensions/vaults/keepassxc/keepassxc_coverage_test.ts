/**
 * Coverage suite: one test per guard, so deleting the guard turns a test red.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createKeePassXCProvider } from "./mod.ts";
import { fakeDeps, FakeKeePassXC } from "./fake_keepassxc_test_helper.ts";
import { BrowserSession } from "./client.ts";
import { ErrorCode, KeePassXCError } from "./protocol.ts";

Deno.test("coverage: putting an unchanged value sends no set-login", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await p.put("k", "v");
  server.actions.length = 0;
  await p.put("k", "v");
  assert(!server.actions.includes("set-login"), server.actions.join());
});

Deno.test("coverage: update refuses an entry without uuid", async () => {
  const server = new FakeKeePassXC({ omitUuid: true });
  server.seed("swamp://ci/k", "k", "old");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await assertRejects(() => p.put("k", "new"), Error, "no uuid");
  assertEquals(server.entries[0].password, "old");
});

Deno.test("coverage: create-new-group without uuid aborts the write", async () => {
  const server = new FakeKeePassXC({ groupWithoutUuid: true });
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  const err = await assertRejects(() => p.put("k", "v"), KeePassXCError);
  assertEquals(err.code, ErrorCode.CANNOT_CREATE_NEW_GROUP);
  assertEquals(server.entries.length, 0);
});

Deno.test("coverage: transport is closed after success and after failure", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await p.list();
  await assertRejects(() => p.get("missing"));
  assertEquals(server.transports.length, 2);
  assert(server.transports.every((t) => t.closed));
});

Deno.test("coverage: call() before handshake() is refused", async () => {
  const server = new FakeKeePassXC();
  const s = new BrowserSession(server.connect(), {
    timeoutMs: 10,
    triggerUnlock: false,
  });
  await assertRejects(() => s.call("get-logins"), KeePassXCError, "handshake");
});

Deno.test("coverage: empty logins are dropped and duplicates collapsed in list", async () => {
  const server = new FakeKeePassXC();
  server.seed("swamp://ci/", "", "x");
  server.seed("swamp://ci/a", "a", "1");
  server.seed("swamp://ci/a", "a", "2");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  assertEquals(await p.list(), ["a"]);
});

Deno.test("coverage: non-locked errors are not retried", async () => {
  const server = new FakeKeePassXC({ associationName: null });
  const deps = fakeDeps(server);
  const p = createKeePassXCProvider("ci", { unlockWaitSeconds: 60 }, deps);
  await assertRejects(() => p.list());
  assertEquals(server.transports.length, 1);
  assertEquals(deps.clock.t, 0);
});

Deno.test("coverage: non-string secret values are refused", () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  let threw = false;
  try {
    p.put("k", 42 as unknown as string);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("coverage: explicit namespace overrides the vault name", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider(
    "My Vault",
    { namespace: "prod" },
    fakeDeps(server),
  );
  await p.put("k", "v");
  assertEquals(server.entries[0].url, "swamp://prod/k");
});
