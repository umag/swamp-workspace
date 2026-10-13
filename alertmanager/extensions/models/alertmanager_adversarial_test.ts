/**
 * Adversarial suite for @magistr/alertmanager: hostile input (matcher and
 * silence-id injection), hostile responses (wrong shapes, non-JSON, huge
 * error bodies, odd alerts), and secret handling.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { model, normalizeAlert, parseMatchers } from "./alertmanager.ts";
import {
  json,
  makeCtx,
  table,
  text,
  withFetch,
} from "./alertmanager_harness_test.ts";

Deno.test("silence id with path traversal is rejected before any request", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({}),
    async (calls) => {
      for (const id of ["../status", "abc/../../x", "a?b=c", "%2e%2e"]) {
        await assertRejects(() =>
          model.methods["expire-silence"].execute({ id }, ctx)
        );
      }
      assertEquals(calls.length, 0);
    },
  );
});

Deno.test("matcher with a hostile label name is rejected", () => {
  for (const bad of ['a b="x"', '1abc="x"', 'na-me="x"', '="x"']) {
    assertThrows(() => parseMatchers(bad));
  }
});

Deno.test("matcher with an invalid regex is rejected", () => {
  assertThrows(() => parseMatchers('job=~"("'), Error, "invalid regex");
});

Deno.test("unterminated quote is rejected", () => {
  assertThrows(() => parseMatchers('a="x,b=y'), Error, "unterminated");
});

Deno.test("filter values with quotes, commas and & stay one query param each", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts": () => json([]) }),
    async (calls) => {
      await model.methods.alerts.execute({
        filter: 'msg="a,b&active=false",x="q\\"t"',
      }, ctx);
      const p = calls[0].url.searchParams;
      assertEquals(p.getAll("active"), ["true"]);
      assertEquals(p.getAll("filter"), [
        'msg="a,b&active=false"',
        'x="q\\"t"',
      ]);
    },
  );
});

Deno.test("alerts response that is an object, not an array, rejects", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts": () => json({ data: [] }) }),
    () =>
      assertRejects(
        () => model.methods.alerts.execute({}, ctx),
        Error,
        "not an array",
      ),
  );
  assertEquals(written.length, 0);
});

Deno.test("non-JSON 200 body rejects with a bounded message", async () => {
  const { ctx } = makeCtx();
  const html = "<html>" + "x".repeat(10_000) + "</html>";
  await withFetch(
    table({ "GET /api/v2/alerts": () => text(html) }),
    async () => {
      const err = await assertRejects(
        () => model.methods.alerts.execute({}, ctx),
        Error,
        "non-JSON",
      );
      assert(err.message.length < 500);
    },
  );
});

Deno.test("huge error body is truncated to 300 chars", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/silences": () => text("e".repeat(50_000), 500) }),
    async () => {
      const err = await assertRejects(() =>
        model.methods.silences.execute({}, ctx)
      );
      assert((err as Error).message.length < 400);
    },
  );
});

Deno.test("odd alerts degrade field-by-field instead of hiding the rest", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/alerts": () =>
        json([
          null,
          42,
          { labels: "nope", status: [], receivers: "x" },
          { labels: { alertname: "Real", n: 5 }, status: { state: "active" } },
        ]),
    }),
    () => model.methods.alerts.execute({}, ctx),
  );
  const alerts = written[0].payload.alerts as { alertname: string }[];
  assertEquals(alerts.length, 4);
  assert(alerts.some((a) => a.alertname === "Real"));
});

Deno.test("label values are stringified", () => {
  const a = normalizeAlert({ labels: { alertname: "A", code: 503 } });
  assertEquals(a.labels.code, "503");
  assertEquals(a.state, "unknown");
  assertEquals(a.severity, null);
});

Deno.test("status with a secret in nested config never stores it", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/status": () =>
        json({
          config: { original: "password: hunter2-SECRET" },
          versionInfo: { version: "0.28.1" },
          cluster: { status: "disabled" },
          uptime: "2026-01-01T00:00:00Z",
        }),
    }),
    () => model.methods.status.execute({}, ctx),
  );
  assert(!JSON.stringify(written).includes("hunter2"));
});

Deno.test("create-silence rejects an empty matcher list before any request", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({}),
    async (calls) => {
      await assertRejects(() =>
        model.methods["create-silence"].execute({
          matchers: " , ",
          comment: "x",
        }, ctx)
      );
      assertEquals(calls.length, 0);
    },
  );
});

Deno.test("create-silence ignores a matching silence that is expired", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/silences": () =>
        json([{
          id: "aaaaaaaa-0000",
          status: { state: "expired" },
          matchers: [{ name: "a", value: "b", isRegex: false, isEqual: true }],
          startsAt: "2020-01-01T00:00:00Z",
          endsAt: "2999-01-01T00:00:00Z",
          comment: "c",
        }]),
      "POST /api/v2/silences": () => json({ silenceID: "bbbbbbbb-0000" }),
    }),
    () =>
      model.methods["create-silence"].execute({
        matchers: "a=b",
        comment: "c",
      }, ctx),
  );
  assertEquals(written[0].payload.action, "created");
});

Deno.test("silenceID with path characters from the server is refused", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/silences": () => json([]),
      "POST /api/v2/silences": () => json({ silenceID: "../../etc" }),
    }),
    () =>
      assertRejects(
        () =>
          model.methods["create-silence"].execute({
            matchers: "a=b",
            comment: "c",
          }, ctx),
        Error,
        "invalid silence id",
      ),
  );
});
