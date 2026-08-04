// Tests for the music-wanted gap report.
// Run: deno test --allow-env=FC_NUM_RUNS --permit-no-files extensions/reports/wanted_test.ts
//
// Two layers, mirroring verify_triage_test.ts's pure-function tests plus the
// never-throws contract this report must additionally hold (see wanted.ts's
// header comment): grouping/worklist logic is tested directly as pure
// functions, and the never-throws contract (absent resource, empty wants,
// every-artist-unresolved, malformed fields) is tested through
// `report.execute` against a mocked DataRepo, since that is where resource
// absence and malformed persisted content actually surface.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildReviewWorklist, buildWantedGap, report } from "./wanted.ts";
import type { ArtistMapEntry } from "./wanted.ts";
import type { WantEntry } from "../lib/wanted.ts";

// --- fixtures -----------------------------------------------------------

function want(over: Partial<WantEntry>): WantEntry {
  return {
    artist: "artist-key",
    artistName: "Artist Name",
    releaseGroupId: "rg-1",
    title: "Some Album",
    kind: "missing",
    quality: null,
    targetQuality: "lossless",
    primaryType: "Album",
    secondaryTypes: [],
    firstReleaseDate: null,
    ...over,
  };
}

function wantedContent(wants: unknown[]) {
  return {
    kind: "wanted",
    generatedAt: "2026-08-03T12:00:00.000Z",
    params: {
      artistMapName: "artist-map",
      musicbrainzInstance: "musicbrainz",
      targetQuality: "lossless",
      uncertainMatchPresent: true,
    },
    total: wants.length,
    // deno-lint-ignore no-explicit-any
    missing: (wants as any[]).filter((w) => w?.kind === "missing").length,
    // deno-lint-ignore no-explicit-any
    upgrade: (wants as any[]).filter((w) => w?.kind === "upgrade").length,
    // deno-lint-ignore no-explicit-any
    wants: wants as any,
  };
}

function artistMapEntry(over: Partial<ArtistMapEntry>): ArtistMapEntry {
  return {
    artistKey: "artist-key",
    artistName: "Artist Name",
    mbid: null,
    status: "unresolved",
    source: null,
    candidates: [],
    ...over,
  };
}

function artistMapContent(entries: unknown[]) {
  const list = entries as Array<{ status?: string }>;
  return {
    kind: "artistMap",
    scannedAt: "2026-08-03T11:00:00.000Z",
    params: { headphonesInstance: "headphones", musicbrainzInstance: "mb" },
    resolved: list.filter((e) => e?.status === "resolved").length,
    ambiguous: list.filter((e) => e?.status === "ambiguous").length,
    unresolved: list.filter((e) => e?.status === "unresolved").length,
    // deno-lint-ignore no-explicit-any
    entries: entries as any,
  };
}

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
    findAllForModel: (_type: string, _modelId: string) => {
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
  modelType: "@magistr/music-library",
  modelId: "music-instance",
};

// --- pure function tests -------------------------------------------------

Deno.test("buildWantedGap: missing wants group by artist, most-missing first", () => {
  const gap = buildWantedGap([
    want({ artistName: "Sparse Band", title: "Only Album" }),
    want({ artistName: "Prolific Band", title: "Album A" }),
    want({ artistName: "Prolific Band", title: "Album B" }),
    want({ artistName: "Prolific Band", title: "Album C" }),
  ]);
  assertEquals(gap.missingCount, 4);
  assertEquals(gap.missingByArtist.length, 2);
  assertEquals(gap.missingByArtist[0].artistName, "Prolific Band");
  assertEquals(gap.missingByArtist[0].count, 3);
  assertEquals(gap.missingByArtist[1].artistName, "Sparse Band");
  assertEquals(gap.missingByArtist[1].count, 1);
});

Deno.test("buildWantedGap: upgrade wants group by current quality bucket", () => {
  const gap = buildWantedGap([
    want({ kind: "upgrade", quality: "lossy-mid", title: "A" }),
    want({ kind: "upgrade", quality: "lossy-mid", title: "B" }),
    want({ kind: "upgrade", quality: "lossy-low", title: "C" }),
  ]);
  assertEquals(gap.upgradeCount, 3);
  assertEquals(gap.upgradeByQuality.length, 2);
  // worst bucket (lossy-low) surfaces before lossy-mid — the more urgent
  // gap belongs at the top of the section.
  assertEquals(gap.upgradeByQuality[0].quality, "lossy-low");
  assertEquals(gap.upgradeByQuality[0].count, 1);
  assertEquals(gap.upgradeByQuality[1].quality, "lossy-mid");
  assertEquals(gap.upgradeByQuality[1].count, 2);
});

Deno.test("buildWantedGap: an upgrade want with null quality buckets as unknown", () => {
  const gap = buildWantedGap([
    want({ kind: "upgrade", quality: null, title: "Mystery" }),
  ]);
  assertEquals(gap.upgradeByQuality.length, 1);
  assertEquals(gap.upgradeByQuality[0].quality, "unknown");
});

Deno.test("buildWantedGap: no wants at all is a valid, empty gap", () => {
  const gap = buildWantedGap([]);
  assertEquals(gap.total, 0);
  assertEquals(gap.missingCount, 0);
  assertEquals(gap.upgradeCount, 0);
  assertEquals(gap.missingByArtist.length, 0);
  assertEquals(gap.upgradeByQuality.length, 0);
});

Deno.test("buildReviewWorklist: ambiguous entries carry competing candidates", () => {
  const review = buildReviewWorklist([
    artistMapEntry({
      artistName: "Two Worlds",
      status: "ambiguous",
      candidates: [
        { id: "mbid-1", name: "Two Worlds" },
        { id: "mbid-2", name: "2 Worlds" },
      ],
    }),
  ]);
  assertEquals(review.length, 1);
  assertEquals(review[0].status, "ambiguous");
  assertEquals(review[0].candidates, ["Two Worlds", "2 Worlds"]);
});

Deno.test("buildReviewWorklist: unresolved entries carry no candidates", () => {
  const review = buildReviewWorklist([
    artistMapEntry({ artistName: "Nobody Knows", status: "unresolved" }),
  ]);
  assertEquals(review.length, 1);
  assertEquals(review[0].status, "unresolved");
  assertEquals(review[0].candidates, []);
});

Deno.test("buildReviewWorklist: resolved entries are excluded — not a review target", () => {
  const review = buildReviewWorklist([
    artistMapEntry({
      artistName: "Known Band",
      status: "resolved",
      mbid: "mbid-1",
      source: "seed",
    }),
  ]);
  assertEquals(review.length, 0);
});

Deno.test("buildReviewWorklist: ambiguous entries sort before unresolved", () => {
  const review = buildReviewWorklist([
    artistMapEntry({ artistName: "Zzz Unresolved", status: "unresolved" }),
    artistMapEntry({ artistName: "Aaa Ambiguous", status: "ambiguous" }),
  ]);
  assertEquals(review[0].status, "ambiguous");
  assertEquals(review[1].status, "unresolved");
});

// --- never-throws contract: report.execute against a mocked DataRepo -----

Deno.test("report.execute: no wanted resource at all does not throw", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([]),
  });
  assert(result.markdown.length > 0);
  assert(!result.markdown.includes("undefined"));
  assertEquals(result.json.status, "no-data");
});

Deno.test("report.execute: wanted resource with an empty want-set reads as a complete library", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([
      { specName: "wanted", name: "wanted", content: wantedContent([]) },
    ]),
  });
  assertEquals(result.json.status, "ok");
  assertEquals(result.json.total, 0);
  // a genuinely complete library is a valid, positive state — the
  // markdown should say so plainly, not render an empty table.
  assert(
    /no wants|caught up|complete/i.test(result.markdown),
    `expected a plain "complete" message, got:\n${result.markdown}`,
  );
  assert(!result.markdown.includes("| --- |"));
});

Deno.test("report.execute: every artist unresolved surfaces the full worklist", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([
      { specName: "wanted", name: "wanted", content: wantedContent([]) },
      {
        specName: "artistMap",
        name: "artist-map",
        content: artistMapContent([
          artistMapEntry({ artistName: "First Unknowns" }),
          artistMapEntry({ artistName: "Second Unknowns" }),
        ]),
      },
    ]),
  });
  assertEquals(result.json.status, "ok");
  const review = result.json.review as Array<{ artistName: string }>;
  assertEquals(review.length, 2);
  assert(result.markdown.includes("First Unknowns"));
  assert(result.markdown.includes("Second Unknowns"));
  assert(/review/i.test(result.markdown));
});

Deno.test("report.execute: ambiguous artists show their competing candidates in markdown", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([
      { specName: "wanted", name: "wanted", content: wantedContent([]) },
      {
        specName: "artistMap",
        name: "artist-map",
        content: artistMapContent([
          artistMapEntry({
            artistName: "Split Decision",
            status: "ambiguous",
            candidates: [
              { id: "mbid-a", name: "Split Decision" },
              { id: "mbid-b", name: "The Split Decision" },
            ],
          }),
        ]),
      },
    ]),
  });
  assert(result.markdown.includes("Split Decision"));
  assert(result.markdown.includes("The Split Decision"));
});

Deno.test("report.execute: missing artistMap resource does not throw and says so", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([
      { specName: "wanted", name: "wanted", content: wantedContent([]) },
    ]),
  });
  assertEquals(result.json.status, "ok");
  assert(result.markdown.length > 0);
});

Deno.test("report.execute: malformed want entries are dropped, not thrown on", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([
      {
        specName: "wanted",
        name: "wanted",
        content: wantedContent([
          want({ artistName: "Good Band", title: "Good Album" }),
          { garbage: true },
          null,
          "not an object",
          { artist: "half", kind: "not-a-real-kind" },
          { ...want({}), kind: undefined },
        ]),
      },
    ]),
  });
  assertEquals(result.json.status, "ok");
  assertEquals(result.json.total, 1);
  assert(result.markdown.includes("Good Band"));
});

Deno.test("report.execute: malformed artistMap entries are dropped, not thrown on", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([
      { specName: "wanted", name: "wanted", content: wantedContent([]) },
      {
        specName: "artistMap",
        name: "artist-map",
        content: artistMapContent([
          artistMapEntry({ artistName: "Valid Unresolved" }),
          { status: "unresolved" }, // missing artistName
          { artistName: "No Status" }, // missing status
          42,
          null,
        ]),
      },
    ]),
  });
  assertEquals(result.json.status, "ok");
  const review = result.json.review as Array<{ artistName: string }>;
  assertEquals(review.length, 1);
  assertEquals(review[0].artistName, "Valid Unresolved");
});

Deno.test("report.execute: completely malformed wanted resource degrades to no-data, never throws", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([
      { specName: "wanted", name: "wanted", content: { kind: "wanted" } },
    ]),
  });
  assert(result.markdown.length > 0);
  assert(!result.markdown.includes("undefined"));
});

Deno.test("report.execute: a repository failure degrades instead of throwing", async () => {
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: throwingRepo(),
  });
  assertEquals(result.json.status, "degraded");
  assert(result.markdown.length > 0);
});

Deno.test("report.execute: newest wanted resource by generatedAt wins", async () => {
  const older = wantedContent([want({ artistName: "Old Pick" })]);
  older.generatedAt = "2026-01-01T00:00:00.000Z";
  const newer = wantedContent([want({ artistName: "New Pick" })]);
  newer.generatedAt = "2026-08-01T00:00:00.000Z";
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: buildRepo([
      { specName: "wanted", name: "wanted-old", content: older },
      { specName: "wanted", name: "wanted-new", content: newer },
    ]),
  });
  assert(result.markdown.includes("New Pick"));
  assert(!result.markdown.includes("Old Pick"));
});

Deno.test("report.execute: deleted resources are ignored", async () => {
  const handles: Handle[] = [
    {
      name: "wanted",
      version: 1,
      tags: { specName: "wanted" },
      lifecycle: "deleted",
    },
  ];
  const contents = new Map<string, Uint8Array>();
  contents.set(
    "wanted",
    new TextEncoder().encode(
      JSON.stringify(wantedContent([want({ artistName: "Ghost" })])),
    ),
  );
  const result = await report.execute({
    ...BASE_CONTEXT,
    dataRepository: {
      findAllForModel: (_t: string, _m: string) => Promise.resolve(handles),
      getContent: (
        _t: string,
        _m: string,
        dataName: string,
        _v?: number,
      ) => Promise.resolve(contents.get(dataName) ?? null),
    },
  });
  assertEquals(result.json.status, "no-data");
});

Deno.test("report.execute: report metadata is well-formed", () => {
  assertEquals(report.name, "@magistr/music-wanted");
  assertEquals(report.scope, "model");
  assert(report.description.length > 0);
});
