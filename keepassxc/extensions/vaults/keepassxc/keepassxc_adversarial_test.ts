/**
 * Adversarial suite: hostile server replies, hostile keys, cross-namespace
 * confusion, and secret leakage through errors.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { createKeePassXCProvider } from "./mod.ts";
import { fakeDeps, FakeKeePassXC } from "./fake_keepassxc_test_helper.ts";
import {
  encodeFrame,
  entryUrl,
  ErrorCode,
  FrameDecoder,
  KeePassXCError,
  MAX_FRAME_BYTES,
} from "./protocol.ts";

Deno.test("adversarial: replayed (non-incremented) handshake nonce is rejected", async () => {
  const server = new FakeKeePassXC({ badNonceOn: "change-public-keys" });
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await assertRejects(() => p.list(), KeePassXCError, "nonce");
});

Deno.test("adversarial: replayed nonce on an encrypted reply is rejected", async () => {
  const server = new FakeKeePassXC({ badNonceOn: "get-logins" });
  server.seed("swamp://ci/a", "a", "secret");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await assertRejects(() => p.get("a"), KeePassXCError, "nonce");
});

Deno.test("adversarial: tampered ciphertext fails the MAC check", async () => {
  const server = new FakeKeePassXC({ badMacOn: "get-logins" });
  server.seed("swamp://ci/a", "a", "secret");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  const err = await assertRejects(() => p.get("a"), KeePassXCError);
  assertEquals(err.code, ErrorCode.CANNOT_DECRYPT_MESSAGE);
});

Deno.test("adversarial: missing server public key aborts the handshake", async () => {
  const server = new FakeKeePassXC({ noPublicKey: true });
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  const err = await assertRejects(() => p.list(), KeePassXCError);
  assertEquals(err.code, ErrorCode.KEY_CHANGE_FAILED);
});

Deno.test("adversarial: control characters in keys are refused before any I/O", () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  for (const k of ["", "a\nb", "a\u0000", "tab\t", "x".repeat(513)]) {
    assertThrows(() => p.get(k));
    assertThrows(() => p.put(k, "v"));
  }
  assertEquals(server.transports.length, 0);
});

Deno.test("adversarial: URL metacharacters in keys cannot escape the namespace", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  const keys = ["../other", "@evil.com", "a?b#c", "x//y", "%2e%2e", "ünï code"];
  for (const k of keys) await p.put(k, `v:${k}`);
  for (const e of server.entries) {
    assert(e.url.startsWith("swamp://ci/"), e.url);
  }
  for (const k of keys) assertEquals(await p.get(k), `v:${k}`);
  assertEquals(await p.list(), [...keys].sort());
  assertEquals(entryUrl("ci", "@evil.com"), "swamp://ci/%40evil.com");
});

Deno.test("adversarial: a same-named login in another namespace is invisible", async () => {
  const server = new FakeKeePassXC();
  server.seed("swamp://prod/db", "db", "prod-secret");
  server.seed("https://ci/db", "db", "web-secret");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  await assertRejects(() => p.get("db"), Error, "not found");
  await p.put("db", "ci-secret");
  assertEquals(
    server.entries.find((e) => e.url === "swamp://prod/db")?.password,
    "prod-secret",
  );
  assertEquals(await p.get("db"), "ci-secret");
});

Deno.test("adversarial: prefix-sharing namespaces do not bleed (ci vs ci2)", async () => {
  const server = new FakeKeePassXC();
  server.seed("swamp://ci2/a", "a", "x");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  assertEquals(await p.list(), []);
});

Deno.test("adversarial: secret values never appear in error messages", async () => {
  const secret = "hunter2-SECRET-VALUE";
  const server = new FakeKeePassXC();
  server.seed("swamp://ci/a", "a", secret);
  server.seed("swamp://ci/a", "a", secret);
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  const e1 = await assertRejects(() => p.get("a"));
  const e2 = await assertRejects(() => p.put("a", secret));
  for (const e of [e1, e2]) {
    assert(!String((e as Error).message).includes(secret));
  }
});

Deno.test("adversarial: unsolicited notifications are skipped", async () => {
  const server = new FakeKeePassXC({ notifications: 2 });
  server.seed("swamp://ci/a", "a", "v");
  const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
  assertEquals(await p.get("a"), "v");
});

Deno.test("adversarial: oversized and non-JSON frames are refused", () => {
  const big = new Uint8Array(4);
  new DataView(big.buffer).setUint32(0, MAX_FRAME_BYTES + 1, true);
  assertThrows(() => new FrameDecoder().push(big), KeePassXCError, "too large");
  const junk = new TextEncoder().encode("nope");
  const frame = new Uint8Array(4 + junk.length);
  new DataView(frame.buffer).setUint32(0, junk.length, true);
  frame.set(junk, 4);
  assertThrows(
    () => new FrameDecoder().push(frame),
    KeePassXCError,
    "non-JSON",
  );
  assertThrows(
    () => new FrameDecoder().push(encodeFrame([1, 2])),
    KeePassXCError,
    "non-object",
  );
});

Deno.test("adversarial: server error text and code propagate verbatim", async () => {
  const server = new FakeKeePassXC();
  const p = createKeePassXCProvider(
    "ci",
    { unlockWaitSeconds: 0 },
    fakeDeps(server),
  );
  server.opts.lockedCalls = 1;
  const err = await assertRejects(() => p.list(), KeePassXCError);
  assertEquals(err.message, "Database not opened");
  assertEquals(err.code, 1);
});
