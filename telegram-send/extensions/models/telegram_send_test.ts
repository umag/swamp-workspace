// Unit tests for the pure helpers in telegram_send.ts.
// Run: deno test extensions/models/telegram_send_test.ts
//
// The send* methods themselves hit the live Bot API (covered by the getMe
// smoke test against a real token), so the unit-testable surface is the two
// pure helpers that decide routing: isLocalPath (JSON vs multipart upload)
// and resolveChatId (arg vs defaultChatId fallback).

import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isLocalPath, resolveChatId } from "./telegram_send.ts";

Deno.test("isLocalPath: https/http URLs are NOT local paths", () => {
  assertEquals(isLocalPath("https://example.com/cat.png"), false);
  assertEquals(isLocalPath("http://example.com/cat.png"), false);
  assertEquals(isLocalPath("HTTPS://EXAMPLE.COM/x.png"), false);
});

Deno.test("isLocalPath: a path with a slash is a local path", () => {
  assert(isLocalPath("/tmp/cat.png"));
  assert(isLocalPath("./relative/cat.png"));
  assert(isLocalPath("subdir/cat.png"));
});

Deno.test("isLocalPath: a bare file_id (no slash, no scheme) is NOT a local path", () => {
  // Telegram file_ids contain no slash → sent via JSON, not multipart.
  assertEquals(isLocalPath("AgACAgIAAxkBAAEBcat"), false);
  assertEquals(isLocalPath("upload.bin"), false);
});

Deno.test("resolveChatId: method chatId arg wins over defaultChatId", () => {
  assertEquals(
    resolveChatId({ chatId: "111" }, { globalArgs: { defaultChatId: "999" } }),
    "111",
  );
});

Deno.test("resolveChatId: falls back to defaultChatId when arg omitted", () => {
  assertEquals(
    resolveChatId({}, { globalArgs: { defaultChatId: "999" } }),
    "999",
  );
});

Deno.test("resolveChatId: throws when neither chatId nor defaultChatId is set", () => {
  assertThrows(
    () => resolveChatId({}, { globalArgs: {} }),
    Error,
    "chatId not provided",
  );
});
