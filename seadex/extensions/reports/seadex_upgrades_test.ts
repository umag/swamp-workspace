/**
 * Pins the `upgradeFilter` marker precedence in `seadex_upgrades.ts`: when a
 * durable `upgradeFilter` marker resource is present it is authoritative over
 * `methodArgs` (the marker persists the last-requested filter across report
 * runs regardless of which method triggered this report execution); when no
 * marker resource exists — e.g. an older seadex model that predates it — the
 * report falls back to `methodArgs`, preserving prior behaviour.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./seadex_upgrades.ts";

interface Handle {
  name: string;
  version: number;
  tags?: Record<string, string>;
  lifecycle?: string;
}

function entryContent(
  alID: number,
  title: string,
  userScore: number,
) {
  return {
    alID,
    title,
    found: true,
    notes: "",
    incomplete: false,
    bestReleases: [
      {
        releaseGroup: "GroupA",
        tracker: "Nyaa",
        url: `https://nyaa.example.test/${alID}`,
        infoHash: "a".repeat(40),
        isBest: true,
        dualAudio: false,
        tags: [],
        totalSizeBytes: 1_000_000,
        fileCount: 1,
        primaryFile: "file.mkv",
      },
    ],
    alternativeReleases: [],
    sourceUrl: `https://releases.moe/${alID}`,
    userScore,
  };
}

function buildRepo(
  entries: Array<{ alID: number; title: string; userScore: number }>,
  marker: { minScore: number } | null,
) {
  const handles: Handle[] = entries.map((e) => ({
    name: `al-${e.alID}`,
    version: 1,
    tags: { specName: "entry" },
  }));
  const contents = new Map<string, Uint8Array>();
  for (const e of entries) {
    contents.set(
      `al-${e.alID}`,
      new TextEncoder().encode(
        JSON.stringify(entryContent(e.alID, e.title, e.userScore)),
      ),
    );
  }
  if (marker) {
    handles.push({
      name: "render-upgrades",
      version: 1,
      tags: { specName: "upgradeFilter" },
    });
    contents.set(
      "render-upgrades",
      new TextEncoder().encode(
        JSON.stringify({
          year: null,
          status: null,
          minScore: marker.minScore,
          title: null,
          timestamp: "2026-08-02T00:00:00.000Z",
        }),
      ),
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

const ENTRIES = [
  { alID: 1, title: "High Score Anime", userScore: 80 },
  { alID: 2, title: "Low Score Anime", userScore: 50 },
];

Deno.test("seadex-upgrades report: marker present overrides methodArgs", async () => {
  // Marker says minScore=70 (only entry 1 qualifies); methodArgs disagrees
  // with minScore=10 (both entries would qualify) — the marker must win.
  const dataRepository = buildRepo(ENTRIES, { minScore: 70 });
  const result = await report.execute({
    modelType: "@magistr/seadex",
    modelId: "seadex-instance",
    methodArgs: { minScore: 10 },
    dataRepository,
  });
  assertEquals(result.json.totalUpgrades, 1);
  const upgrades = result.json.upgrades as Array<{ alID: number }>;
  assertEquals(upgrades.length, 1);
  assertEquals(upgrades[0].alID, 1);
});

Deno.test("seadex-upgrades report: no marker falls back to methodArgs", async () => {
  // No upgradeFilter resource exists at all — methodArgs (minScore=70) is the
  // only source of the filter and must be honoured.
  const dataRepository = buildRepo(ENTRIES, null);
  const result = await report.execute({
    modelType: "@magistr/seadex",
    modelId: "seadex-instance",
    methodArgs: { minScore: 70 },
    dataRepository,
  });
  assertEquals(result.json.totalUpgrades, 1);
  const upgrades = result.json.upgrades as Array<{ alID: number }>;
  assertEquals(upgrades.length, 1);
  assertEquals(upgrades[0].alID, 1);
});
