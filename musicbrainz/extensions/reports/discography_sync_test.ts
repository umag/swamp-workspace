// Tests for the discography-sync coverage report.
// Run: deno test --allow-env=FC_NUM_RUNS --permit-no-files extensions/reports/discography_sync_test.ts
//
// Five render cases plus the independent cross-check, evaluated in the
// PINNED order (d) then (a) then (b) then (c) — see discography_sync.ts's
// header comment for why (a) and (d) overlap and must not be reordered.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildCrossCheck, renderCoverage, report } from "./discography_sync.ts";

interface Handle {
  name: string;
  version: number;
  tags?: Record<string, string>;
  lifecycle?: string;
}

function buildRepo(
  resources: Array<{ specName: string; name: string; content: unknown }>,
) {
  const handles: Handle[] = resources.map((r, i) => ({
    name: r.name,
    version: i + 1,
    tags: { specName: r.specName },
  }));
  const contents = new Map<string, Uint8Array>();
  for (const r of resources) {
    contents.set(
      r.name,
      new TextEncoder().encode(JSON.stringify(r.content)),
    );
  }
  return {
    findAllForModel: (_type: string, _modelId: string) =>
      Promise.resolve(handles),
    getContent: (
      _type: string,
      _modelId: string,
      dataName: string,
      _version?: number,
    ) => Promise.resolve(contents.get(dataName) ?? null),
  };
}

function throwingRepo() {
  return {
    findAllForModel: (_type: string, _modelId: string): Promise<Handle[]> => {
      throw new Error("backend unreachable");
    },
    getContent: (
      _type: string,
      _modelId: string,
      _dataName: string,
      _version?: number,
    ) => Promise.resolve(null),
  };
}

const BASE_CONTEXT = {
  modelType: "@magistr/musicbrainz",
  modelId: "musicbrainz-instance",
};

function syncState(
  over: Partial<{
    cursor: { offset: number };
    processed: string[];
    skipped: string[];
    updatedAt: string;
    requested: number;
    requestedRaw: number;
    listFingerprint: string;
    startOffset: number;
    covered: number;
    remaining: number;
    uncovered: string[];
    uncoveredCount: number;
  }>,
) {
  return {
    cursor: { offset: 775 },
    processed: ["aaaaaaaa-0000-4000-8000-000000000001"],
    skipped: ["aaaaaaaa-0000-4000-8000-000000000002"],
    updatedAt: "2026-08-04T22:17:14.000Z",
    requested: 775,
    requestedRaw: 775,
    listFingerprint: "deadbeef",
    startOffset: 1,
    covered: 774,
    remaining: 1,
    uncovered: [],
    uncoveredCount: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// (d) NO STORED STATE AT ALL — checked FIRST, split on the method.
// ---------------------------------------------------------------------------

Deno.test("report.execute (d)(1): no stored state, methodName IS sync-artist-discographies — renders the 'no resource found' shape, never throws", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "sync-artist-discographies",
    executionStatus: "succeeded",
    dataHandles: [],
    dataRepository: buildRepo([]),
  });
  assertEquals(result.json.status, "no-data");
  assert(
    result.markdown.includes("No resource found"),
    "must render the no-resource-found shape",
  );
});

Deno.test("report.execute (d)(2)/(e): no stored state, methodName is something ELSE — renders EMPTY markdown, no stray timestamp placeholder", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "search-artist",
    executionStatus: "succeeded",
    dataHandles: [],
    dataRepository: buildRepo([]),
  });
  assertEquals(result.markdown, "");
  assertEquals(result.json.status, "not-applicable");
});

// ---------------------------------------------------------------------------
// (a) a method OTHER than sync-artist-discographies, WITH stored state
// present — one line naming the updatedAt, no coverage numbers.
// ---------------------------------------------------------------------------

Deno.test("report.execute (a): a different method with stored state present renders ONE line naming updatedAt, no coverage numbers", async () => {
  const state = syncState({});
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "search-artist",
    executionStatus: "succeeded",
    dataHandles: [],
    dataRepository: buildRepo([{
      specName: "discographySyncState",
      name: "discography-sync-cursor",
      content: state,
    }]),
  });
  assert(
    result.markdown.includes(state.updatedAt),
    "must name the stored state's updatedAt",
  );
  assert(
    !result.markdown.includes("774"),
    "must not render this state's coverage numbers — the run that touched the instance was not the sync",
  );
  assertEquals(result.json.status, "not-this-method");
});

// ---------------------------------------------------------------------------
// (b) THIS execution wrote the state — the discography-sync-cursor handle
// is present in context.dataHandles.
// ---------------------------------------------------------------------------

Deno.test("report.execute (b): this execution wrote the state — renders THIS run's numbers", async () => {
  const state = syncState({});
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "sync-artist-discographies",
    executionStatus: "succeeded",
    dataHandles: [{
      name: "discography-sync-cursor",
      specName: "discographySyncState",
    }],
    dataRepository: buildRepo([{
      specName: "discographySyncState",
      name: "discography-sync-cursor",
      content: state,
    }]),
  });
  assert(
    result.markdown.includes("774 of 775"),
    "must render this run's covered/requested",
  );
  assert(
    result.markdown.includes("1 NOT ATTEMPTED"),
    "must render remaining as NOT ATTEMPTED",
  );
  assertEquals(result.json.status, "ok");
  assertEquals(result.json.covered, 774);
  assertEquals(result.json.remaining, 1);
});

Deno.test("report.execute (b): a FAILED execution that wrote partial state leads with the partial-pass banner", async () => {
  const state = syncState({ covered: 2, remaining: 3, requested: 5 });
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "sync-artist-discographies",
    executionStatus: "failed",
    dataHandles: [{
      name: "discography-sync-cursor",
      specName: "discographySyncState",
    }],
    dataRepository: buildRepo([{
      specName: "discographySyncState",
      name: "discography-sync-cursor",
      content: state,
    }]),
  });
  assert(
    result.markdown.includes("This run FAILED part-way"),
    "a failed run's own state must lead with the partial-pass banner",
  );
});

// ---------------------------------------------------------------------------
// (c) THIS execution wrote NO state — the handle is absent, e.g. the
// missing-artistMbids throw.
// ---------------------------------------------------------------------------

Deno.test("report.execute (c): this execution wrote NO state — renders the PREVIOUS run's numbers under an explicit disclaimer", async () => {
  const state = syncState({});
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "sync-artist-discographies",
    executionStatus: "failed",
    dataHandles: [],
    dataRepository: buildRepo([{
      specName: "discographySyncState",
      name: "discography-sync-cursor",
      content: state,
    }]),
  });
  assert(
    result.markdown.includes("This run wrote no sync state"),
    "must render the explicit no-state-this-run banner",
  );
  assert(
    result.markdown.includes("does NOT describe this one"),
    "must disclaim that the numbers are the previous run's",
  );
  assert(
    result.markdown.includes(state.updatedAt),
    "must name the previous run's updatedAt",
  );
  assertEquals(result.json.status, "no-state-this-run");
});

// ---------------------------------------------------------------------------
// The independent cross-check — computed from stored rg-by-artist-* rows,
// never from the sync's own counters.
// ---------------------------------------------------------------------------

Deno.test("buildCrossCheck: agrees when every processed/skipped MBID has a cached row and no uncovered MBID does", async () => {
  const state = syncState({
    processed: ["aaaaaaaa-0000-4000-8000-000000000001"],
    skipped: ["aaaaaaaa-0000-4000-8000-000000000002"],
    uncovered: ["aaaaaaaa-0000-4000-8000-000000000003"],
  });
  const repo = buildRepo([
    {
      specName: "browse",
      name: "rg-by-artist-aaaaaaaa-0000-4000-8000-000000000001",
      content: {},
    },
    {
      specName: "browse",
      name: "rg-by-artist-aaaaaaaa-0000-4000-8000-000000000002",
      content: {},
    },
  ]);
  const result = await buildCrossCheck(
    repo,
    BASE_CONTEXT.modelType,
    BASE_CONTEXT.modelId,
    state,
  );
  assertEquals(result.agrees, true);
  assertEquals(result.missingRows, []);
  assertEquals(result.unexpectedRows, []);
});

Deno.test("report.execute: a synthetic state whose processed contains an MBID with NO stored rg-by-artist row renders the loud self-report-disagrees block", async () => {
  const state = syncState({
    processed: ["aaaaaaaa-0000-4000-8000-000000000099"], // no cached row below
    skipped: [],
    uncovered: [],
    uncoveredCount: 0,
  });
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "sync-artist-discographies",
    executionStatus: "succeeded",
    dataHandles: [{
      name: "discography-sync-cursor",
      specName: "discographySyncState",
    }],
    dataRepository: buildRepo([{
      specName: "discographySyncState",
      name: "discography-sync-cursor",
      content: state,
    }]),
  });
  assert(
    result.markdown.includes("self-report disagrees with stored data"),
    "must render the loud disagreement block",
  );
  assertEquals(result.json.crossCheckAgrees, false);
});

// ---------------------------------------------------------------------------
// never-throws contract
// ---------------------------------------------------------------------------

Deno.test("report.execute: a repository failure degrades instead of throwing", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "sync-artist-discographies",
    executionStatus: "succeeded",
    dataHandles: [],
    dataRepository: throwingRepo(),
  });
  assertEquals(result.json.status, "degraded");
  assert(result.markdown.includes("Report degraded"));
});

Deno.test("report.execute: deleted state resources are ignored", async () => {
  const handles: Handle[] = [
    {
      name: "discography-sync-cursor",
      version: 1,
      tags: { specName: "discographySyncState" },
      lifecycle: "deleted",
    },
  ];
  const result = await report.execute({
    ...BASE_CONTEXT,
    methodName: "sync-artist-discographies",
    executionStatus: "succeeded",
    dataHandles: [],
    dataRepository: {
      findAllForModel: (_t: string, _m: string) => Promise.resolve(handles),
      getContent: (
        _t: string,
        _m: string,
        _n: string,
        _v?: number,
      ) =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(syncState({}))),
        ),
    },
  });
  assertEquals(result.json.status, "no-data");
});

// ---------------------------------------------------------------------------
// renderCoverage — pure function, direct unit coverage of the numeric shape
// ---------------------------------------------------------------------------

Deno.test("renderCoverage: the live shape (774 of 775, remaining 1) renders the BLUF line with the exact numbers", () => {
  const md = renderCoverage(
    syncState({}),
    { agrees: true, missingRows: [], unexpectedRows: [] },
  );
  assert(md.includes("Discography sync: 774 of 775 requested artists covered"));
  assert(md.includes("1 fetched"));
  assert(md.includes("1 fresh-cache skipped"));
  assert(md.includes("1 NOT ATTEMPTED"));
  assert(md.includes("started at cursor offset 1"));
});

Deno.test("renderCoverage: remaining 0 prints a quiet full-coverage confirmation", () => {
  const md = renderCoverage(
    syncState({ covered: 775, remaining: 0, startOffset: 0 }),
    { agrees: true, missingRows: [], unexpectedRows: [] },
  );
  assert(md.includes("Full coverage"));
});

Deno.test("renderCoverage: requestedRaw != requested names the duplicate count", () => {
  const md = renderCoverage(
    syncState({ requested: 767, requestedRaw: 775 }),
    { agrees: true, missingRows: [], unexpectedRows: [] },
  );
  assert(md.includes("duplicate MBID"));
  assert(md.includes("8"));
});

Deno.test("renderCoverage: uncoveredCount > 0 renders the catalog-incomplete section naming the missing MBIDs", () => {
  const md = renderCoverage(
    syncState({
      uncoveredCount: 1,
      uncovered: ["aaaaaaaa-0000-4000-8000-000000000501"],
    }),
    { agrees: true, missingRows: [], unexpectedRows: [] },
  );
  assert(md.includes("Catalog incomplete: 1 artist"));
  assert(md.includes("aaaaaaaa-0000-4000-8000-000000000501"));
});

Deno.test("report: metadata is well-formed", () => {
  assertEquals(report.name, "@magistr/musicbrainz-discography-sync");
  assertEquals(report.scope, "model");
  assert(report.description.length > 0);
  assert(Array.isArray(report.labels) && report.labels.length > 0);
});
