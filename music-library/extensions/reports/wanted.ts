// Wanted-gap report for @magistr/music-library.
//
// Renders the latest `wanted` resource (and, where useful, the latest
// `artistMap` resource) into an actionable gap report — it never touches
// MusicBrainz or the library scan itself (rule 3: use the data model). The
// grouping/worklist logic lives in this file as pure functions so it is
// unit-testable without a DataRepo; `execute` only wires resource lookup
// around it.
//
// Sections:
//   - headline totals (missing vs upgrade, or "library is caught up")
//   - missing releases grouped by artist, biggest gaps first
//   - upgrade candidates grouped by current quality bucket, worst first —
//     "200 albums at lossy-mid" and "3 at lossy-low" are different
//     decisions, so they are never flattened into one list
//   - artists parked ambiguous/unresolved by resolve-artists. This is the
//     one and only place that parked work becomes visible, so it is
//     rendered as a worklist (artist name, and for ambiguous entries the
//     competing MusicBrainz candidates), not folded into an error state.
//
// Never-throws contract (mirrors verify_triage.ts): a missing wanted
// resource, an empty want-set, an all-unresolved artistMap, and malformed
// fields on either resource must all render something sane rather than
// throwing — a report that throws breaks the method run that triggered it.

import { QUALITY_RANK } from "../lib/wanted.ts";
import type { QualityBucket, WantEntry, WantKind } from "../lib/wanted.ts";

interface Handle {
  name: string;
  version: number;
  tags?: Record<string, string>;
  lifecycle?: string;
}

interface DataRepo {
  findAllForModel(type: string, modelId: string): Promise<Handle[]>;
  getContent(
    type: string,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

interface ReportContext {
  modelType: string;
  modelId: string;
  methodArgs?: Record<string, unknown>;
  dataRepository: DataRepo;
}

interface WantedContent {
  kind: string;
  generatedAt: string;
  total: number;
  missing: number;
  upgrade: number;
  wants: unknown[];
}

/** artistMap entry shape (mirrors the model's ArtistMapEntrySchema). */
export interface ArtistMapEntry {
  artistKey: string;
  artistName: string;
  mbid: string | null;
  status: "resolved" | "ambiguous" | "unresolved";
  source: "seed" | "search" | null;
  candidates: Array<{ id: string; name: string }>;
  checkedAt?: string;
}

interface ArtistMapContent {
  kind: string;
  scannedAt: string;
  resolved: number;
  ambiguous: number;
  unresolved: number;
  entries: unknown[];
  pendingSearch?: number;
  truncated?: boolean;
  stopReason?: string | null;
}

const MISSING_ARTISTS_MAX = 30;
const MISSING_TITLES_SHOWN = 5;
const UPGRADE_SAMPLE_MAX = 5;
const REVIEW_ROWS_MAX = 50;

function decode(bytes: Uint8Array | null): unknown {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function isWantKind(v: unknown): v is WantKind {
  return v === "missing" || v === "upgrade";
}

function isQualityBucket(v: unknown): v is QualityBucket {
  return typeof v === "string" &&
    (QUALITY_RANK as readonly string[]).includes(v);
}

function isReviewStatus(
  v: unknown,
): v is "resolved" | "ambiguous" | "unresolved" {
  return v === "resolved" || v === "ambiguous" || v === "unresolved";
}

/**
 * Narrow one raw `wants` array element to a WantEntry, or null if it is
 * missing a field the report actually depends on (artist identity, title,
 * kind). Optional/derived fields fall back to safe defaults rather than
 * disqualifying the whole entry — see the never-throws contract above.
 */
function asWantEntry(raw: unknown): WantEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.artist !== "string") return null;
  if (typeof r.artistName !== "string") return null;
  if (typeof r.title !== "string") return null;
  if (!isWantKind(r.kind)) return null;
  return {
    artist: r.artist,
    artistName: r.artistName,
    releaseGroupId: typeof r.releaseGroupId === "string"
      ? r.releaseGroupId
      : "",
    title: r.title,
    kind: r.kind,
    quality: isQualityBucket(r.quality) ? r.quality : null,
    targetQuality: isQualityBucket(r.targetQuality)
      ? r.targetQuality
      : "lossless",
    primaryType: typeof r.primaryType === "string" ? r.primaryType : null,
    secondaryTypes: Array.isArray(r.secondaryTypes)
      ? r.secondaryTypes.filter((t): t is string => typeof t === "string")
      : [],
    firstReleaseDate: typeof r.firstReleaseDate === "string"
      ? r.firstReleaseDate
      : null,
  };
}

/** Narrow one raw `entries` array element to an ArtistMapEntry, or null. */
function asArtistMapEntry(raw: unknown): ArtistMapEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.artistName !== "string") return null;
  if (!isReviewStatus(r.status)) return null;
  const rawCandidates = Array.isArray(r.candidates) ? r.candidates : [];
  const candidates = rawCandidates
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      id: typeof c.id === "string" ? c.id : "",
      name: typeof c.name === "string" ? c.name : "",
    }))
    .filter((c) => c.name !== "");
  return {
    artistKey: typeof r.artistKey === "string" ? r.artistKey : "",
    artistName: r.artistName,
    mbid: typeof r.mbid === "string" ? r.mbid : null,
    status: r.status,
    source: r.source === "seed" || r.source === "search" ? r.source : null,
    candidates,
  };
}

export interface MissingArtistGroup {
  artistName: string;
  count: number;
  titles: string[];
}

export interface UpgradeQualityGroup {
  quality: QualityBucket;
  count: number;
  sample: Array<{ artistName: string; title: string }>;
}

export interface WantedGap {
  total: number;
  missingCount: number;
  upgradeCount: number;
  missingByArtist: MissingArtistGroup[];
  upgradeByQuality: UpgradeQualityGroup[];
}

/**
 * Build the gap groupings from an already-decoded want-set (pure —
 * unit-testable). An empty `wants` array is a valid, fully-caught-up
 * library, not an error: it simply yields all-zero counts and empty
 * groupings.
 */
export function buildWantedGap(wants: WantEntry[]): WantedGap {
  const missing = wants.filter((w) => w.kind === "missing");
  const upgrade = wants.filter((w) => w.kind === "upgrade");

  const byArtist = new Map<string, WantEntry[]>();
  for (const w of missing) {
    if (!byArtist.has(w.artistName)) byArtist.set(w.artistName, []);
    byArtist.get(w.artistName)!.push(w);
  }
  const missingByArtist = [...byArtist.entries()]
    .map(([artistName, ws]) => ({
      artistName,
      count: ws.length,
      titles: ws.map((w) => w.title).sort(),
    }))
    .sort((a, b) =>
      b.count - a.count || a.artistName.localeCompare(b.artistName)
    );

  const byQuality = new Map<QualityBucket, WantEntry[]>();
  for (const w of upgrade) {
    const q = w.quality ?? "unknown";
    if (!byQuality.has(q)) byQuality.set(q, []);
    byQuality.get(q)!.push(w);
  }
  const upgradeByQuality = QUALITY_RANK
    .filter((q) => byQuality.has(q))
    .map((quality) => {
      const ws = byQuality.get(quality)!;
      return {
        quality,
        count: ws.length,
        sample: ws.slice(0, UPGRADE_SAMPLE_MAX).map((w) => ({
          artistName: w.artistName,
          title: w.title,
        })),
      };
    });

  return {
    total: wants.length,
    missingCount: missing.length,
    upgradeCount: upgrade.length,
    missingByArtist,
    upgradeByQuality,
  };
}

export interface ReviewEntry {
  artistName: string;
  status: "ambiguous" | "unresolved";
  candidates: string[];
}

/**
 * Build the human-review worklist from artistMap entries (pure —
 * unit-testable): ambiguous and unresolved artists only, ambiguous first
 * (it is actionable — pick a candidate — vs. unresolved which needs a
 * fresh search), each artist alphabetical within its status.
 */
export function buildReviewWorklist(
  entries: ArtistMapEntry[],
): ReviewEntry[] {
  return entries
    .filter((e) => e.status === "ambiguous" || e.status === "unresolved")
    .map((e) => ({
      artistName: e.artistName,
      status: e.status as "ambiguous" | "unresolved",
      candidates: e.status === "ambiguous"
        ? e.candidates.map((c) => c.name)
        : [],
    }))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "ambiguous" ? -1 : 1;
      return a.artistName.localeCompare(b.artistName);
    });
}

function renderMissingSection(gap: WantedGap): string[] {
  if (gap.missingByArtist.length === 0) return [];
  const lines: string[] = [];
  lines.push("");
  lines.push(`## Missing by artist (${gap.missingByArtist.length})`);
  lines.push("");
  lines.push("| Artist | Missing | Releases |");
  lines.push("| --- | --- | --- |");
  const shown = gap.missingByArtist.slice(0, MISSING_ARTISTS_MAX);
  for (const g of shown) {
    const shownTitles = g.titles.slice(0, MISSING_TITLES_SHOWN);
    const more = g.titles.length - shownTitles.length;
    const titles = shownTitles.join(", ") + (more > 0 ? `, +${more} more` : "");
    lines.push(`| ${g.artistName} | ${g.count} | ${titles} |`);
  }
  const omitted = gap.missingByArtist.length - shown.length;
  if (omitted > 0) {
    lines.push("");
    lines.push(`_${omitted} more artists omitted._`);
  }
  return lines;
}

function renderUpgradeSection(gap: WantedGap): string[] {
  if (gap.upgradeByQuality.length === 0) return [];
  const lines: string[] = [];
  lines.push("");
  lines.push(`## Upgrade candidates (${gap.upgradeCount})`);
  lines.push("");
  lines.push("| Current quality | Count | Sample |");
  lines.push("| --- | --- | --- |");
  for (const b of gap.upgradeByQuality) {
    const sample = b.sample
      .map((s) => `${s.artistName} — ${s.title}`)
      .join("; ");
    lines.push(`| ${b.quality} | ${b.count} | ${sample} |`);
  }
  return lines;
}

function renderReviewSection(
  review: ReviewEntry[],
  hadArtistMap: boolean,
): string[] {
  const lines: string[] = [];
  lines.push("");
  if (review.length === 0) {
    lines.push("## Needs human review");
    lines.push("");
    lines.push(
      hadArtistMap
        ? "None — every library artist resolved cleanly."
        : "No artistMap resource found — run `resolve-artists` first to " +
          "see parked ambiguous/unresolved artists here.",
    );
    return lines;
  }

  const ambiguous = review.filter((r) => r.status === "ambiguous");
  const unresolved = review.filter((r) => r.status === "unresolved");
  lines.push(
    `## Needs human review (${review.length}: ${ambiguous.length} ` +
      `ambiguous, ${unresolved.length} unresolved)`,
  );

  if (ambiguous.length > 0) {
    lines.push("");
    lines.push(`### Ambiguous (${ambiguous.length}) — pick a candidate`);
    lines.push("");
    lines.push("| Artist | Competing candidates |");
    lines.push("| --- | --- |");
    for (const r of ambiguous.slice(0, REVIEW_ROWS_MAX)) {
      const candidates = r.candidates.length > 0
        ? r.candidates.join(", ")
        : "(candidates not recorded)";
      lines.push(`| ${r.artistName} | ${candidates} |`);
    }
  }

  if (unresolved.length > 0) {
    lines.push("");
    lines.push(
      `### Unresolved (${unresolved.length}) — no MusicBrainz match found`,
    );
    lines.push("");
    lines.push("| Artist |");
    lines.push("| --- |");
    for (const r of unresolved.slice(0, REVIEW_ROWS_MAX)) {
      lines.push(`| ${r.artistName} |`);
    }
  }

  return lines;
}

function renderMarkdown(
  gap: WantedGap,
  review: ReviewEntry[],
  generatedAt: string | null,
  hadArtistMap: boolean,
): string {
  const lines: string[] = [];
  lines.push("# Music library gap");
  lines.push("");
  if (generatedAt) {
    lines.push(`Latest want-set generated ${generatedAt}.`);
  }

  if (gap.total === 0) {
    lines.push("");
    lines.push(
      "**No wants.** The library is caught up against every resolved " +
        "artist's MusicBrainz discography at the target quality — nothing " +
        "missing, nothing to upgrade.",
    );
  } else {
    lines.push("");
    lines.push(
      `**${gap.total} wants** — ${gap.missingCount} missing, ` +
        `${gap.upgradeCount} upgrade.`,
    );
  }

  lines.push(...renderMissingSection(gap));
  lines.push(...renderUpgradeSection(gap));
  lines.push(...renderReviewSection(review, hadArtistMap));

  return lines.join("\n");
}

export const report = {
  name: "@magistr/music-wanted",
  description:
    "Gap report from the latest want-set: missing releases grouped by " +
    "artist (biggest gaps first), upgrade candidates grouped by current " +
    "quality bucket (worst first), and the artists resolve-artists parked " +
    "as ambiguous or unresolved — the human-review worklist, with " +
    "competing MusicBrainz candidates for ambiguous entries.",
  scope: "model" as const,
  labels: ["music", "wanted", "gap", "musicbrainz", "quality"],

  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const { modelType, modelId, dataRepository: repo } = context;
    const empty = {
      markdown: "# Music library gap\n\nNo wanted resource found — run " +
        "the `wanted` method first.",
      json: { status: "no-data" },
    };
    try {
      const all = await repo.findAllForModel(modelType, modelId);
      const live = all.filter((h) => h.lifecycle !== "deleted");

      let bestWanted: WantedContent | null = null;
      let bestWantedTs = -1;
      for (const h of live.filter((x) => x.tags?.specName === "wanted")) {
        const c = decode(
          await repo.getContent(modelType, modelId, h.name, h.version),
        ) as WantedContent | null;
        if (!c || c.kind !== "wanted" || !Array.isArray(c.wants)) continue;
        const ts = Date.parse(c.generatedAt) || 0;
        if (ts > bestWantedTs) {
          bestWantedTs = ts;
          bestWanted = c;
        }
      }
      if (!bestWanted) return empty;

      const wants = bestWanted.wants
        .map(asWantEntry)
        .filter((w): w is WantEntry => w !== null);
      const gap = buildWantedGap(wants);

      let bestArtistMap: ArtistMapContent | null = null;
      let bestArtistMapTs = -1;
      for (const h of live.filter((x) => x.tags?.specName === "artistMap")) {
        const c = decode(
          await repo.getContent(modelType, modelId, h.name, h.version),
        ) as ArtistMapContent | null;
        if (!c || c.kind !== "artistMap" || !Array.isArray(c.entries)) {
          continue;
        }
        const ts = Date.parse(c.scannedAt) || 0;
        if (ts > bestArtistMapTs) {
          bestArtistMapTs = ts;
          bestArtistMap = c;
        }
      }

      const artistMapEntries = bestArtistMap
        ? bestArtistMap.entries
          .map(asArtistMapEntry)
          .filter((e): e is ArtistMapEntry => e !== null)
        : [];
      const review = buildReviewWorklist(artistMapEntries);

      return {
        markdown: renderMarkdown(
          gap,
          review,
          bestWanted.generatedAt,
          bestArtistMap !== null,
        ),
        json: {
          status: "ok",
          generatedAt: bestWanted.generatedAt,
          total: gap.total,
          missing: gap.missingCount,
          upgrade: gap.upgradeCount,
          missingByArtist: gap.missingByArtist,
          upgradeByQuality: gap.upgradeByQuality,
          review,
        },
      };
    } catch (e) {
      return {
        markdown: `# Music library gap\n\nReport degraded: ${
          e instanceof Error ? e.message : String(e)
        }`,
        json: { status: "degraded", error: String(e) },
      };
    }
  },
};
