/**
 * Contract-fixture suite for @magistr/alertmanager: pins the v2 API wire
 * format — request paths/query params and the mapping of doc-derived
 * response fixtures (see fixtures/PROVENANCE.md) into stored resources.
 * If a test here breaks, the contract with Alertmanager changed.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./alertmanager.ts";
import {
  json,
  makeCtx,
  table,
  withFetch,
} from "./alertmanager_harness_test.ts";
import alertsFixture from "../../fixtures/alerts.json" with { type: "json" };
import groupsFixture from "../../fixtures/groups.json" with { type: "json" };
import silencesFixture from "../../fixtures/silences.json" with {
  type: "json",
};
import statusFixture from "../../fixtures/status.json" with { type: "json" };

Deno.test("alerts: GET /api/v2/alerts with default state flags", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts": () => json(alertsFixture) }),
    async (calls) => {
      await model.methods.alerts.execute({}, ctx);
      assertEquals(calls.length, 1);
      const p = calls[0].url.searchParams;
      assertEquals(p.get("active"), "true");
      assertEquals(p.get("silenced"), "false");
      assertEquals(p.get("inhibited"), "false");
      assertEquals(p.get("unprocessed"), "false");
      assertEquals(p.getAll("filter"), []);
    },
  );
});

Deno.test("alerts: fixture maps to the stored alert shape", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts": () => json(alertsFixture) }),
    () => model.methods.alerts.execute({}, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "alerts");
  assertEquals(written[0].name, "alerts");
  const alerts = written[0].payload.alerts as Record<string, unknown>[];
  // Sorted by alertname.
  assertEquals(alerts.map((a) => a.alertname), [
    "DiskSpaceWarning",
    "ExporterDown",
  ]);
  assertEquals(alerts[0], {
    alertname: "DiskSpaceWarning",
    severity: "warning",
    state: "active",
    labels: {
      alertname: "DiskSpaceWarning",
      severity: "warning",
      instance: "host-a:9100",
      mountpoint: "/data",
    },
    annotations: {
      summary: "Disk /data above 90%",
      description: "Usage is 93%",
    },
    startsAt: "2026-01-01T10:00:00.000Z",
    endsAt: "2026-01-01T10:05:00.000Z",
    updatedAt: "2026-01-01T10:01:00.000Z",
    fingerprint: "a1b2c3d4e5f60718",
    generatorURL:
      "http://vmalert.example:8880/vmalert/alert?group_id=1&alert_id=2",
    receivers: ["default"],
    silencedBy: [],
    inhibitedBy: [],
  });
  assertEquals(alerts[1].silencedBy, [
    "7c0f2a4e-1111-4222-8333-944455556666",
  ]);
  assertEquals(written[0].payload.counts, {
    total: 2,
    byState: { active: 1, suppressed: 1 },
    bySeverity: { warning: 1, critical: 1 },
    byAlertname: { DiskSpaceWarning: 1, ExporterDown: 1 },
  });
});

Deno.test("groups: GET /api/v2/alerts/groups maps receiver + alerts", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/alerts/groups": () => json(groupsFixture) }),
    () => model.methods.groups.execute({}, ctx),
  );
  const groups = written[0].payload.groups as Record<string, unknown>[];
  assertEquals(groups.length, 1);
  assertEquals(groups[0].receiver, "default");
  assertEquals(groups[0].labels, { alertname: "DiskSpaceWarning" });
  assertEquals(written[0].payload.totalAlerts, 1);
});

Deno.test("silences: fixture maps, isEqual defaults to true", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/silences": () => json(silencesFixture) }),
    () => model.methods.silences.execute({ state: "all" }, ctx),
  );
  const s = written[0].payload.silences as Record<string, unknown>[];
  assertEquals(s.length, 2);
  const old = s.find((x) => x.state === "expired")!;
  assertEquals(old.matchers, [
    { name: "alertname", value: "Old", isRegex: false, isEqual: true },
  ]);
});

Deno.test("status: config text is never stored, only its SHA-256", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /api/v2/status": () => json(statusFixture) }),
    () => model.methods.status.execute({}, ctx),
  );
  const p = written[0].payload;
  assertEquals(p.version, "0.28.1");
  assertEquals(p.clusterStatus, "ready");
  assertEquals(p.peers, [{ name: "01ABCDEF", address: "10.0.0.5:9094" }]);
  assert(/^[0-9a-f]{64}$/.test(String(p.configSha256)));
  assert(!JSON.stringify(p).includes("SECRET-TOKEN-DO-NOT-STORE"));
});

Deno.test("create-silence: POST body is a v2 postableSilence", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({
      "GET /api/v2/silences": () => json([]),
      "POST /api/v2/silences": () => json({ silenceID: "abcdef12-0000" }),
    }),
    async (calls) => {
      await model.methods["create-silence"].execute({
        matchers: 'alertname="X",job=~"n.*"',
        comment: "test",
      }, ctx);
      const post = calls.find((c) => c.method === "POST")!;
      const body = post.body as Record<string, unknown>;
      assertEquals(body.matchers, [
        { name: "alertname", value: "X", isRegex: false, isEqual: true },
        { name: "job", value: "n.*", isRegex: true, isEqual: true },
      ]);
      assertEquals(body.createdBy, "swamp");
      assertEquals(body.comment, "test");
      assert(!("id" in body));
    },
  );
});

Deno.test("expire-silence: GET then DELETE /api/v2/silence/{id}", async () => {
  const { ctx } = makeCtx();
  const id = "7c0f2a4e-1111-4222-8333-944455556666";
  await withFetch(
    table({
      [`GET /api/v2/silence/${id}`]: () => json(silencesFixture[0]),
      [`DELETE /api/v2/silence/${id}`]: () => new Response(null),
    }),
    async (calls) => {
      await model.methods["expire-silence"].execute({ id }, ctx);
      assertEquals(calls.map((c) => c.method), ["GET", "DELETE"]);
    },
  );
});
