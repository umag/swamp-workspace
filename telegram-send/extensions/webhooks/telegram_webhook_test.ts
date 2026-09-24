/**
 * @magistr/telegram-webhook — unit tests.
 *
 * These pin the same cases `@swamp-club/swamp-testing`'s
 * `assertWebhookExportConformance` checks (valid token, wrong token, missing
 * header), plus the constant-time compare and header override, by driving the
 * exported handler directly. The published conformance helper does not yet
 * cover webhooks (jsr @0.3.0), so switch to it once released.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  bytesEqual,
  callbackView,
  digest,
  documentView,
  magnetView,
  senderLabel,
  TELEGRAM_SECRET_HEADER,
  tokenMatches,
  webhook,
} from "./telegram_webhook.ts";

Deno.test("export shape: type is the @collective/name scheme, handler wired", () => {
  assert(/^@[a-z0-9_-]+\/[a-z0-9_-]+$/.test(webhook.type));
  assertEquals(webhook.type, "@magistr/telegram-webhook");
  const h = webhook.createHandler({});
  assertEquals(typeof h.verify, "function");
  assertEquals(h.requiredHeaders, [TELEGRAM_SECRET_HEADER]);
});

Deno.test("verify accepts the exact token and rejects any mismatch", async () => {
  const h = webhook.createHandler({});
  assertEquals(h.signatureHeader, TELEGRAM_SECRET_HEADER);
  const ok = new Headers({ [TELEGRAM_SECRET_HEADER]: "abc" });
  assertEquals(await h.verify(new Uint8Array(), ok, "abc"), true);
  const bad = new Headers({ [TELEGRAM_SECRET_HEADER]: "abcd" });
  assertEquals(await h.verify(new Uint8Array(), bad, "abc"), false);
  assertEquals(await h.verify(new Uint8Array(), new Headers(), "abc"), false);
});

Deno.test("config can override the header name (lowercased)", () => {
  const h = webhook.createHandler({ header: "X-Custom-Token" });
  assertEquals(h.signatureHeader, "x-custom-token");
  assertEquals(h.requiredHeaders, ["x-custom-token"]);
});

Deno.test("tokenMatches is length-agnostic and exact", async () => {
  assert(await tokenMatches("same", "same"));
  assert(!(await tokenMatches("short", "longer-token")));
  assert(!(await tokenMatches("", "x")));
});

Deno.test("bytesEqual is constant-time-shaped and correct", async () => {
  assert(bytesEqual(await digest("a"), await digest("a")));
  assert(!bytesEqual(await digest("a"), await digest("b")));
});

Deno.test("callbackView splits data on the first colon and resolves the tapper", () => {
  const v = callbackView({
    callback_query: {
      id: "cbq1",
      data: "ia:incident-123",
      from: { username: "mag1", id: 42 },
    },
  });
  assertEquals(v.kind, "ia");
  assertEquals(v.arg, "incident-123");
  assertEquals(v.from, "@mag1");
  assertEquals(v.id, "cbq1");
});

Deno.test("callbackView keeps everything after the first colon in arg", () => {
  const v = callbackView({
    callback_query: { id: "x", data: "ir:a:b:c", from: { id: 7 } },
  });
  assertEquals(v.kind, "ir");
  assertEquals(v.arg, "a:b:c");
  assertEquals(v.from, "7"); // no username/first_name → numeric id
});

Deno.test("callbackView returns an empty view for a non-callback update", () => {
  const v = callbackView({ message: { text: "hi" } });
  assertEquals(v, { id: "", data: "", kind: "", arg: "", from: "" });
});

Deno.test("transform attaches the callback view to the raw update", async () => {
  const h = webhook.createHandler({});
  const out = await h.transform!(
    { update_id: 5, callback_query: { id: "c", data: "ack:dc-1", from: {} } },
    {},
  ) as Record<string, unknown>;
  assertEquals(out.update_id, 5); // raw update preserved
  assertEquals((out.callback as { kind: string }).kind, "ack");
  assertEquals((out.callback as { arg: string }).arg, "dc-1");
});

Deno.test("senderLabel prefers @username, then first name, then id, else empty", () => {
  assertEquals(senderLabel({ username: "u", first_name: "F", id: 1 }), "@u");
  assertEquals(senderLabel({ username: "", first_name: "F", id: 1 }), "F");
  assertEquals(senderLabel({ id: 42 }), "42");
  assertEquals(senderLabel(undefined), "");
  assertEquals(senderLabel("not-an-object"), "");
});

Deno.test("documentView lifts message.document with chat and sender", () => {
  assertEquals(
    documentView({
      message: {
        chat: { id: 154348275 },
        from: { first_name: "Mag" },
        document: {
          file_id: "BQAC",
          file_name: "ubuntu.iso.torrent",
          mime_type: "application/x-bittorrent",
        },
      },
    }),
    {
      fileId: "BQAC",
      fileName: "ubuntu.iso.torrent",
      mimeType: "application/x-bittorrent",
      chatId: "154348275",
      from: "Mag",
    },
  );
});

Deno.test("documentView returns an empty view when there is no document", () => {
  const empty = {
    fileId: "",
    fileName: "",
    mimeType: "",
    chatId: "",
    from: "",
  };
  assertEquals(documentView({ message: { text: "hi" } }), empty);
  assertEquals(documentView(null), empty);
});

Deno.test("magnetView surfaces only magnet: text, trimmed and case-insensitive", () => {
  assertEquals(
    magnetView({
      message: {
        text: "  MAGNET:?xt=urn:btih:abc ",
        chat: { id: 7 },
        from: { username: "me" },
      },
    }),
    { url: "MAGNET:?xt=urn:btih:abc", chatId: "7", from: "@me" },
  );
  assertEquals(magnetView({ message: { text: "https://x" } }), {
    url: "",
    chatId: "",
    from: "",
  });
});

Deno.test("transform attaches document and magnet views too", async () => {
  const h = webhook.createHandler({});
  const out = await h.transform!(
    { message: { text: "magnet:?xt=1", chat: { id: 1 } } },
    {},
  ) as Record<string, { url?: string; fileId?: string }>;
  assertEquals(out.magnet.url, "magnet:?xt=1");
  assertEquals(out.document.fileId, "");
});

Deno.test("property: views never throw and always return string fields on arbitrary JSON", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (body) => {
      for (
        const v of [callbackView(body), documentView(body), magnetView(body)]
      ) {
        if (!Object.values(v).every((x) => typeof x === "string")) return false;
      }
      return true;
    }),
  );
});

Deno.test("property: tokenMatches is true iff presented === secret", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string(),
      fc.string(),
      async (a, b) =>
        (await tokenMatches(a, b)) === (a === b) &&
        (await tokenMatches(a, a)),
    ),
  );
});
