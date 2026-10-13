/**
 * Contract suite: pins the wire format to frames captured from a live
 * KeePassXC 2.7.11 (fixtures/frames-2.7.11.json) and the swamp VaultProvider
 * contract (roundtrip, missing rejects, overwrite, list, getName).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import frames from "../../../fixtures/frames-2.7.11.json" with {
  type: "json",
};
import { ConfigSchema, createKeePassXCProvider, vault } from "./mod.ts";
import { fakeDeps, FakeKeePassXC } from "./fake_keepassxc_test_helper.ts";
import { encodeFrame, FrameDecoder } from "./protocol.ts";

function keysOf(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort();
}

Deno.test("contract: handshake request carries exactly the captured fields", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await p.list();
  const t = server.transports[0];
  assertEquals(keysOf(t.sent[0]), keysOf(frames.changePublicKeysRequest));
});

Deno.test("contract: encrypted request carries exactly the captured fields", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await p.list();
  const t = server.transports[0];
  const getLogins = t.sent.find((f) => f.action === "get-logins")!;
  assertEquals(keysOf(getLogins), keysOf(frames.encryptedRequest));
});

Deno.test("contract: captured error reply (no success field) maps to empty list", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  assertEquals(await p.list(), []);
  assertEquals(frames.errorReply.errorCode, "15");
  assert(!("success" in frames.errorReply));
});

Deno.test("contract: captured frames survive native-messaging framing", () => {
  const d = new FrameDecoder();
  const all = [
    frames.changePublicKeysReply,
    frames.encryptedReply,
    frames.errorReply,
  ];
  const bytes = all.map(encodeFrame);
  const out = bytes.flatMap((b) => d.push(b));
  assertEquals(out, all);
});

Deno.test("contract: vault export metadata", () => {
  assertEquals(vault.type, "@magistr/keepassxc");
  assert(vault.name.length > 0);
  assert(vault.description.length > 0);
  assertEquals(typeof vault.createProvider, "function");
  const p = vault.createProvider("my-vault", {});
  for (const m of ["get", "put", "list", "getName"] as const) {
    assertEquals(typeof p[m], "function");
  }
  assertEquals(p.getName(), "my-vault");
});

Deno.test("contract: configSchema accepts valid and rejects invalid configs", () => {
  for (
    const ok of [
      {},
      { namespace: "prod", group: "Infra/swamp" },
      { timeoutSeconds: 5, unlockWaitSeconds: 0, triggerUnlock: false },
      { proxyPath: "/usr/bin/keepassxc-proxy", associationFile: "/tmp/a.json" },
    ]
  ) assert(ConfigSchema.safeParse(ok).success, JSON.stringify(ok));
  for (
    const bad of [
      { namespace: "Has Space" },
      { namespace: "-lead" },
      { group: "" },
      { timeoutSeconds: 0 },
      { unlockWaitSeconds: -1 },
      { proxyPath: "" },
    ]
  ) assert(!ConfigSchema.safeParse(bad).success, JSON.stringify(bad));
});

Deno.test("contract: VaultProvider behaviour", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  const k = "swamp-conformance-test-key";
  await p.put(k, "one");
  assertEquals(await p.get(k), "one");
  await p.put(k, "two");
  assertEquals(await p.get(k), "two");
  assert((await p.list()).includes(k));
  await assertRejects(
    () => p.get("swamp-conformance-test-missing"),
    Error,
    "not found",
  );
  assertEquals(p.getName(), "ci");
});
