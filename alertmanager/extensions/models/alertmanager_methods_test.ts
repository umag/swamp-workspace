/**
 * Method suite for @magistr/alertmanager: every method's success and failure
 * paths against a stubbed fetch, including the idempotency branches of
 * create-silence (created / extended / unchanged) and expire-silence
 * (expired / unchanged).
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./alertmanager.ts";
import {
  json,
  makeCtx,
  table,
  text,
  withFetch,
} from "./alertmanager_harness_test.ts";
import alertsFixture from "../../fixtures/alerts.json" with { type: "json" };
import silencesFixture from "../../fixtures/silences.json" with {
  type: "json",
};
import statusFixture from "../../fixtures/status.json" with { type: "json" };

const NOW = Date.parse("2026-01-01T10:00:00.000Z");

Deno.test("alerts: summary lists alertnames and passes filters", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts": () => json(alertsFixture) }),
    async (calls) => {
      const r = await model.methods.alerts.execute({
        silenced: true,
        filter: "severity=critical",
        receiver: "tele.*",
      }, ctx);
      assertEquals(r.summary, "2 alert(s): DiskSpaceWarning, ExporterDown");
      const p = calls[0].url.searchParams;
      assertEquals(p.get("silenced"), "true");
      assertEquals(p.getAll("filter"), ['severity="critical"']);
      assertEquals(p.get("receiver"), "tele.*");
    },
  );
});

Deno.test("alerts: empty list", async () => {
  const { ctx, written } = makeCtx();
  const r = await withFetch(
    table({ "GET /api/v2/alerts": () => json([]) }),
    () => model.methods.alerts.execute({}, ctx),
  );
  assertEquals(r.summary, "0 alert(s)");
  assertEquals((written[0].payload.counts as { total: number }).total, 0);
});

Deno.test("alerts: HTTP error is surfaced", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts": () => text("boom", 500) }),
    () =>
      assertRejects(
        () => model.methods.alerts.execute({}, ctx),
        Error,
        "HTTP 500: boom",
      ),
  );
  assertEquals(written.length, 0);
});

Deno.test("groups: HTTP error is surfaced", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts/groups": () => text("nope", 503) }),
    () =>
      assertRejects(
        () => model.methods.groups.execute({}, ctx),
        Error,
        "HTTP 503",
      ),
  );
});

Deno.test("silences: default keeps only active", async () => {
  const { ctx, written } = makeCtx();
  const r = await withFetch(
    table({ "GET /api/v2/silences": () => json(silencesFixture) }),
    () => model.methods.silences.execute({}, ctx),
  );
  assertEquals(r.summary, "1 active silence(s)");
  const s = written[0].payload.silences as { state: string }[];
  assertEquals(s.map((x) => x.state), ["active"]);
});

Deno.test("silences: HTTP error is surfaced", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({}),
    () =>
      assertRejects(
        () => model.methods.silences.execute({}, ctx),
        Error,
        "HTTP 404",
      ),
  );
});

Deno.test("status: summary", async () => {
  const { ctx } = makeCtx();
  const r = await withFetch(
    table({ "GET /api/v2/status": () => json(statusFixture) }),
    () => model.methods.status.execute({}, ctx),
  );
  assertEquals(r.summary, "Alertmanager 0.28.1, cluster ready, 1 peer(s)");
});

Deno.test("status: non-object body rejects", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/status": () => json([]) }),
    () =>
      assertRejects(
        () => model.methods.status.execute({}, ctx),
        Error,
        "not an object",
      ),
  );
});

Deno.test("create-silence: creates when none matches", async () => {
  using _t = new FakeTime(NOW);
  const { ctx, written } = makeCtx();
  const r = await withFetch(
    table({
      "GET /api/v2/silences": () => json(silencesFixture),
      "POST /api/v2/silences": () => json({ silenceID: "11111111-aaaa" }),
    }),
    (calls) =>
      model.methods["create-silence"].execute({
        matchers: "alertname=Fresh",
        comment: "c",
        durationMinutes: 30,
      }, ctx).then((res) => {
        const body = calls[1].body as Record<string, string>;
        assertEquals(body.startsAt, "2026-01-01T10:00:00.000Z");
        assertEquals(body.endsAt, "2026-01-01T10:30:00.000Z");
        return res;
      }),
  );
  assertEquals(
    r.summary,
    "Silence 11111111-aaaa created, ends 2026-01-01T10:30:00.000Z",
  );
  assertEquals(written[0].name, "silence-11111111-aaaa");
  assertEquals(written[0].payload.action, "created");
});

Deno.test("create-silence: unchanged when existing covers the window", async () => {
  using _t = new FakeTime(NOW);
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/silences": () => json(silencesFixture) }),
    async (calls) => {
      // Existing silence ends 12:00; asking for 60 min (11:00) is covered.
      await model.methods["create-silence"].execute({
        matchers: 'job=~"node.*",alertname="ExporterDown"',
        comment: "maintenance",
      }, ctx);
      assertEquals(calls.map((c) => c.method), ["GET"]);
    },
  );
  assertEquals(written[0].payload.action, "unchanged");
  assertEquals(written[0].payload.id, "7c0f2a4e-1111-4222-8333-944455556666");
  assertEquals(written[0].payload.endsAt, "2026-01-01T12:00:00.000Z");
  assertEquals(written[0].payload.createdBy, "ops");
});

Deno.test("create-silence: extends an existing silence that ends too soon", async () => {
  using _t = new FakeTime(NOW);
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/silences": () => json(silencesFixture),
      "POST /api/v2/silences": () =>
        json({ silenceID: "7c0f2a4e-1111-4222-8333-944455556666" }),
    }),
    async (calls) => {
      await model.methods["create-silence"].execute({
        matchers: 'alertname="ExporterDown",job=~"node.*"',
        comment: "maintenance",
        durationMinutes: 240,
      }, ctx);
      const body = calls[1].body as Record<string, string>;
      assertEquals(body.id, "7c0f2a4e-1111-4222-8333-944455556666");
      assertEquals(body.startsAt, "2026-01-01T09:30:00.000Z");
      assertEquals(body.endsAt, "2026-01-01T14:00:00.000Z");
    },
  );
  assertEquals(written[0].payload.action, "extended");
});

Deno.test("create-silence: missing silenceID rejects", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/silences": () => json([]),
      "POST /api/v2/silences": () => json({}),
    }),
    () =>
      assertRejects(
        () =>
          model.methods["create-silence"].execute({
            matchers: "a=b",
            comment: "c",
          }, ctx),
        Error,
        "silenceID",
      ),
  );
});

Deno.test("create-silence: POST error (e.g. 400 bad matchers) is surfaced", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/silences": () => json([]),
      "POST /api/v2/silences": () => text("silence invalid", 400),
    }),
    () =>
      assertRejects(
        () =>
          model.methods["create-silence"].execute({
            matchers: "a=b",
            comment: "c",
          }, ctx),
        Error,
        "HTTP 400: silence invalid",
      ),
  );
  assertEquals(written.length, 0);
});

Deno.test("expire-silence: already expired is a no-op", async () => {
  const { ctx, written } = makeCtx();
  const expired = silencesFixture[1];
  await withFetch(
    table({ [`GET /api/v2/silence/${expired.id}`]: () => json(expired) }),
    async (calls) => {
      const r = await model.methods["expire-silence"].execute(
        { id: expired.id },
        ctx,
      );
      assertEquals(r.summary, `Silence ${expired.id} unchanged`);
      assertEquals(calls.map((c) => c.method), ["GET"]);
    },
  );
  assertEquals(written[0].payload.action, "unchanged");
});

Deno.test("expire-silence: unknown id rejects with 404", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({}),
    () =>
      assertRejects(
        () =>
          model.methods["expire-silence"].execute(
            { id: "deadbeef-0000-0000-0000-000000000000" },
            ctx,
          ),
        Error,
        "HTTP 404",
      ),
  );
});
