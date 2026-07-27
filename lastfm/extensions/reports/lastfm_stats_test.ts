/**
 * Tests for the @magistr/lastfm-stats model-scope report.
 *
 * The two findings that drove this suite (plan v3, round-2 review):
 *  - dataRepository.findAllForModel returns one handle per DATA VERSION, so
 *    folding every handle would multiply each statistic by the retained
 *    version count. Only max(version) per name may be decoded.
 *  - findAllForModel also returns handles whose lifecycle is "deleted"; those
 *    must be dropped before decoding.
 *
 * Plus: the report is scoped to sync-history, reconciles its bucket totals,
 * honours the timezone argument, and degrades on empty/absent history.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildStats,
  type Handle,
  latestPerName,
  report,
} from "./lastfm_stats.ts";

// ---------------------------------------------------------------------------
// latestPerName — the version/lifecycle guard
// ---------------------------------------------------------------------------

const h = (name: string, version: number, lifecycle = "active"): Handle => ({
  name,
  version,
  lifecycle,
  tags: { specName: "scrobbles" },
});

Deno.test("latestPerName: collapses multiple versions of one chunk to the newest", () => {
  const out = latestPerName([
    h("scrobbles.2007", 1),
    h("scrobbles.2007", 3),
    h("scrobbles.2007", 2),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].version, 3);
});

Deno.test("latestPerName: keeps one entry per distinct name", () => {
  const out = latestPerName([
    h("scrobbles.2007", 2),
    h("scrobbles.2008", 1),
    h("scrobbles.2007", 1),
  ]);
  assertEquals(out.length, 2);
  assertEquals(out.map((x) => x.name).sort(), [
    "scrobbles.2007",
    "scrobbles.2008",
  ]);
  assertEquals(out.find((x) => x.name === "scrobbles.2007")?.version, 2);
});

Deno.test("latestPerName: drops deleted handles entirely", () => {
  const out = latestPerName([
    h("scrobbles.2007", 1),
    h("scrobbles.2008", 5, "deleted"),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].name, "scrobbles.2007");
});

Deno.test("latestPerName: a name whose ONLY versions are deleted disappears", () => {
  const out = latestPerName([
    h("scrobbles.2009", 1, "deleted"),
    h("scrobbles.2009", 2, "deleted"),
  ]);
  assertEquals(out.length, 0);
});

Deno.test("latestPerName: failure path — empty input yields empty output", () => {
  assertEquals(latestPerName([]), []);
});

// ---------------------------------------------------------------------------
// buildStats — bucket reconciliation
// ---------------------------------------------------------------------------

const scrobble = (iso: string, artist: string, track: string) => ({
  uts: Math.floor(Date.parse(iso) / 1000),
  artist,
  track,
  album: `${artist} album`,
});

Deno.test("buildStats: every distribution reconciles to the total count", () => {
  const rows = [
    scrobble("2007-03-05T10:00:00Z", "A", "t1"),
    scrobble("2007-06-05T22:00:00Z", "B", "t2"),
    scrobble("2008-01-02T03:00:00Z", "A", "t3"),
  ];
  const stats = buildStats(rows, "UTC");
  assertEquals(stats.total, 3);

  for (const key of ["byYear", "byMonth", "byWeekday", "byHour"]) {
    const bucket = stats[key] as Record<string, number>;
    const sum = Object.values(bucket).reduce((a, b) => a + b, 0);
    assertEquals(sum, 3, `${key} must sum to the total`);
  }
});

Deno.test("buildStats: unique counts are distinct-value counts, not row counts", () => {
  const stats = buildStats([
    scrobble("2007-03-05T10:00:00Z", "A", "t1"),
    scrobble("2007-03-05T11:00:00Z", "A", "t1"),
    scrobble("2007-03-05T12:00:00Z", "B", "t2"),
  ], "UTC");
  assertEquals(stats.total, 3);
  assertEquals(stats.uniqueArtists, 2);
  assertEquals(stats.uniqueTracks, 2);
});

Deno.test("buildStats: the timezone argument shifts the hour buckets", () => {
  const row = [scrobble("2007-03-05T23:30:00Z", "A", "t1")];
  const utc = buildStats(row, "UTC").byHour as Record<string, number>;
  const tokyo = buildStats(row, "Asia/Tokyo").byHour as Record<string, number>;
  assertEquals(utc["23"], 1);
  assertEquals(tokyo["8"], 1, "23:30Z is 08:30 next day in Tokyo");
});

Deno.test("buildStats: the timezone argument can shift the weekday too", () => {
  // 2007-03-05T23:30Z is a Monday in UTC, Tuesday in Tokyo.
  const row = [scrobble("2007-03-05T23:30:00Z", "A", "t1")];
  const utc = buildStats(row, "UTC").byWeekday as Record<string, number>;
  const tokyo = buildStats(row, "Asia/Tokyo").byWeekday as Record<
    string,
    number
  >;
  assert(JSON.stringify(utc) !== JSON.stringify(tokyo));
});

Deno.test("buildStats: top lists rank by playcount, descending", () => {
  const stats = buildStats([
    scrobble("2007-03-05T10:00:00Z", "A", "t1"),
    scrobble("2007-03-05T11:00:00Z", "A", "t2"),
    scrobble("2007-03-05T12:00:00Z", "B", "t3"),
  ], "UTC");
  const top = stats.topArtists as Array<{ name: string; playcount: number }>;
  assertEquals(top[0].name, "A");
  assertEquals(top[0].playcount, 2);
});

Deno.test("buildStats: failure path — an empty history yields a valid zeroed report", () => {
  const stats = buildStats([], "UTC");
  assertEquals(stats.total, 0);
  assertEquals(stats.uniqueArtists, 0);
  assertEquals(Object.keys(stats.byYear as object).length, 0);
});

Deno.test("buildStats: failure path — an invalid timezone falls back to UTC rather than throwing", () => {
  const row = [scrobble("2007-03-05T23:30:00Z", "A", "t1")];
  const stats = buildStats(row, "Not/AZone");
  assertEquals((stats.byHour as Record<string, number>)["23"], 1);
});

// ---------------------------------------------------------------------------
// report.execute — scoping and degradation
// ---------------------------------------------------------------------------

function makeReportCtx(opts: {
  methodName?: string;
  handles?: Handle[];
  contents?: Record<string, unknown>;
}) {
  const handles = opts.handles ?? [];
  const contents = opts.contents ?? {};
  return {
    scope: "model" as const,
    modelType: "@magistr/lastfm",
    modelId: "model-uuid",
    methodName: opts.methodName ?? "sync-history",
    executionStatus: "succeeded" as const,
    logger: { info: () => {}, warning: () => {}, error: () => {} },
    dataRepository: {
      findAllForModel: () => Promise.resolve(handles),
      getContent: (_t: string, _m: string, name: string) =>
        Promise.resolve(
          contents[name]
            ? new TextEncoder().encode(JSON.stringify(contents[name]))
            : null,
        ),
      findByName: () => Promise.resolve(null),
    },
  };
}

Deno.test("report: short-circuits when the triggering method is not sync-history", async () => {
  const out = await report.execute(
    makeReportCtx({ methodName: "top-artists" }),
  );
  assertEquals((out.json as { status?: string }).status, "skipped");
});

Deno.test("report: reports no-data when no scrobbles resource exists", async () => {
  const out = await report.execute(makeReportCtx({ handles: [] }));
  assertEquals((out.json as { status?: string }).status, "no-data");
  assert(out.markdown.length > 0, "a markdown body is always produced");
});

Deno.test("report: counts each year chunk exactly once despite retained versions", async () => {
  const rows2007 = {
    scrobbles: [
      {
        uts: Math.floor(Date.UTC(2007, 2, 5) / 1000),
        artist: "A",
        track: "t1",
      },
    ],
  };
  const out = await report.execute(makeReportCtx({
    handles: [h("scrobbles.2007", 1), h("scrobbles.2007", 2)],
    contents: { "scrobbles.2007": rows2007 },
  }));
  assertEquals((out.json as { total?: number }).total, 1);
});

Deno.test("report: excludes deleted chunks from the totals", async () => {
  const mk = (year: number) => ({
    scrobbles: [
      { uts: Math.floor(Date.UTC(year, 2, 5) / 1000), artist: "A", track: "t" },
    ],
  });
  const out = await report.execute(makeReportCtx({
    handles: [h("scrobbles.2007", 1), h("scrobbles.2008", 1, "deleted")],
    contents: { "scrobbles.2007": mk(2007), "scrobbles.2008": mk(2008) },
  }));
  assertEquals((out.json as { total?: number }).total, 1);
});

Deno.test("report: failure path — an unreadable chunk degrades with a diagnostic", async () => {
  const out = await report.execute(makeReportCtx({
    handles: [h("scrobbles.2007", 1)],
    contents: {}, // getContent returns null
  }));
  const json = out.json as { total?: number; unreadable?: string[] };
  assertEquals(json.total, 0);
  assert(
    (json.unreadable ?? []).includes("scrobbles.2007"),
    "the unreadable chunk must be named in the output",
  );
});
