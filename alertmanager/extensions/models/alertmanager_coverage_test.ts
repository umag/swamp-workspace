/**
 * Coverage suite for @magistr/alertmanager: one test per guard, so deleting
 * the guard turns a test red.
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  buildUrl,
  formatMatcher,
  model,
  normalizeSilence,
  parseMatchers,
  sameMatchers,
} from "./alertmanager.ts";
import {
  json,
  makeCtx,
  table,
  withFetch,
} from "./alertmanager_harness_test.ts";

Deno.test("buildUrl strips trailing slashes on the base", () => {
  assertEquals(
    buildUrl("http://h:9093///", "/api/v2/alerts"),
    "http://h:9093/api/v2/alerts",
  );
});

Deno.test("buildUrl keeps a path prefix (reverse-proxied AM)", () => {
  assertEquals(
    buildUrl("https://h/am/", "/api/v2/status"),
    "https://h/am/api/v2/status",
  );
});

Deno.test("parseMatchers accepts amtool-style braces", () => {
  assertEquals(parseMatchers('{alertname="A"}'), [
    { name: "alertname", value: "A", isRegex: false, isEqual: true },
  ]);
});

Deno.test("parseMatchers covers all four operators", () => {
  const ms = parseMatchers("a=1,b!=2,c=~3,d!~4");
  assertEquals(ms.map((m) => [m.isRegex, m.isEqual]), [
    [false, true],
    [false, false],
    [true, true],
    [true, false],
  ]);
});

Deno.test("parseMatchers rejects a part with no operator", () => {
  assertThrows(() => parseMatchers("alertname"), Error, "invalid matcher");
});

Deno.test("formatMatcher escapes backslashes", () => {
  assertEquals(
    formatMatcher({ name: "p", value: "a\\b", isRegex: false, isEqual: true }),
    'p="a\\\\b"',
  );
});

Deno.test("sameMatchers is false on different lengths", () => {
  const a = parseMatchers("a=1");
  assertEquals(sameMatchers(a, parseMatchers("a=1,b=2")), false);
});

Deno.test("sameMatchers distinguishes = from =~ with the same value", () => {
  assertEquals(
    sameMatchers(parseMatchers("a=1"), parseMatchers("a=~1")),
    false,
  );
});

Deno.test("normalizeSilence treats isEqual:false as negative", () => {
  const s = normalizeSilence({
    matchers: [{ name: "a", value: "b", isRegex: false, isEqual: false }],
  });
  assertEquals(s.matchers[0].isEqual, false);
});

Deno.test("globalArgs without url is rejected", async () => {
  const { ctx } = makeCtx({});
  await assertRejects(() => model.methods.alerts.execute({}, ctx));
});

Deno.test("silences: filter is sent as filter= params", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/silences": () => json([]) }),
    async (calls) => {
      await model.methods.silences.execute({ filter: "a=b" }, ctx);
      assertEquals(calls[0].url.searchParams.getAll("filter"), ['a="b"']);
    },
  );
});

Deno.test("silences: non-array body rejects", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/silences": () => json({}) }),
    () =>
      assertRejects(
        () => model.methods.silences.execute({}, ctx),
        Error,
        "not an array",
      ),
  );
});

Deno.test("groups: non-array body rejects", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts/groups": () => json(null) }),
    () =>
      assertRejects(
        () => model.methods.groups.execute({}, ctx),
        Error,
        "not an array",
      ),
  );
});

Deno.test("create-silence: different comment does not reuse a silence", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/silences": () =>
        json([{
          id: "aaaaaaaa-0000",
          status: { state: "active" },
          matchers: [{ name: "a", value: "b", isRegex: false, isEqual: true }],
          startsAt: "2020-01-01T00:00:00Z",
          endsAt: "2999-01-01T00:00:00Z",
          comment: "other",
        }]),
      "POST /api/v2/silences": () => json({ silenceID: "bbbbbbbb-0000" }),
    }),
    () =>
      model.methods["create-silence"].execute({
        matchers: "a=b",
        comment: "mine",
      }, ctx),
  );
  assertEquals(written[0].payload.action, "created");
});

Deno.test("create-silence: duration above one year is rejected", async () => {
  const { ctx } = makeCtx();
  await assertRejects(() =>
    model.methods["create-silence"].execute({
      matchers: "a=b",
      comment: "c",
      durationMinutes: 60 * 24 * 366,
    }, ctx)
  );
});

Deno.test("request times out after timeoutMs", async () => {
  const { ctx } = makeCtx({ url: "http://am.example:9093", timeoutMs: 20 });
  const original = globalThis.fetch;
  const stub: typeof globalThis.fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
      );
    });
  globalThis.fetch = stub;
  try {
    await assertRejects(
      () => model.methods.status.execute({}, ctx),
      Error,
      "timed out after 20ms",
    );
  } finally {
    globalThis.fetch = original;
  }
});
