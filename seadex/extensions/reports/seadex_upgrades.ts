// SeaDex upgrade report — surfaces best releases for anime that have been
// looked up via @releasesmoe/seadex. Uses optional userScore/userStatus/
// userSeason/userYear metadata stored on each entry resource (passed in via
// lookup-many) to prioritise and group output.

interface ReleaseEntry {
  releaseGroup: string;
  tracker: string;
  url: string;
  infoHash: string;
  isBest: boolean;
  dualAudio: boolean;
  tags: string[];
  totalSizeBytes: number;
  fileCount: number;
  primaryFile: string | null;
}

interface SeadexResultContent {
  alID: number;
  title: string | null;
  found: boolean;
  notes: string;
  incomplete: boolean;
  bestReleases: ReleaseEntry[];
  alternativeReleases: ReleaseEntry[];
  sourceUrl: string;
  userScore?: number;
  userStatus?: string;
  userSeason?: string;
  userYear?: number;
  currentPath?: string;
  currentSizeBytes?: number;
  currentFileCount?: number;
}

const PREFERRED_TRACKER = "Nyaa";

function gb(n: number): string {
  return (n / 1e9).toFixed(1);
}

const SEASON_ORDER: Record<string, number> = {
  WINTER: 1,
  SPRING: 2,
  SUMMER: 3,
  FALL: 4,
};

/** SeaDex upgrade report: anime with available SeaDex best releases, scored and grouped by user metadata (userScore/userStatus/userSeason/userYear passed in via lookup-many). */
export const report = {
  name: "@magistr/seadex-upgrades",
  description:
    "List anime with available SeaDex best releases, scored and sorted by user metadata",
  scope: "model" as const,
  labels: ["seadex", "anime", "upgrades"],

  execute: async (context: {
    modelType: string;
    modelId: string;
    methodArgs?: Record<string, unknown>;
    methodName?: string;
    dataRepository: {
      findAllForModel: (
        type: string,
        modelId: string,
      ) => Promise<
        Array<{
          name: string;
          version: number;
          tags?: Record<string, string>;
          lifecycle?: string;
        }>
      >;
      getContent: (
        type: string,
        modelId: string,
        dataName: string,
        version?: number,
      ) => Promise<Uint8Array | null>;
    };
  }): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    // Load all data handles once, then resolve the active filter.
    const all = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );

    // Prefer the durable `upgradeFilter` marker resource (written by
    // render-upgrades) over ephemeral methodArgs: the marker persists the
    // last-requested filter across report runs regardless of which method
    // triggered this report. When present it is authoritative (a null field
    // means "no filter for that field"). When absent — e.g. an older seadex
    // model that predates the marker — fall back to methodArgs, preserving the
    // prior behaviour.
    const markerHandle = all
      .filter((d) =>
        d.tags?.specName === "upgradeFilter" && d.lifecycle !== "deleted"
      )
      .sort((a, b) => b.version - a.version)[0];
    let marker:
      | {
        year: number | null;
        status: string | null;
        minScore: number | null;
        title: string | null;
        timestamp: string;
      }
      | null = null;
    if (markerHandle) {
      const rawMarker = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        markerHandle.name,
      );
      if (rawMarker) {
        try {
          marker = JSON.parse(new TextDecoder().decode(rawMarker));
        } catch {
          // unparseable marker → treat as absent, fall back to methodArgs
        }
      }
    }

    const ma = context.methodArgs ?? {};
    const filterYear = marker
      ? (typeof marker.year === "number" ? marker.year : undefined)
      : (typeof ma.year === "number" ? ma.year : undefined);
    const filterStatus = marker
      ? (typeof marker.status === "string" ? marker.status : undefined)
      : (typeof ma.status === "string" ? ma.status : undefined);
    const filterMinScore = marker
      ? (typeof marker.minScore === "number" ? marker.minScore : undefined)
      : (typeof ma.minScore === "number" ? ma.minScore : undefined);
    const filterActive = filterYear !== undefined ||
      filterStatus !== undefined || filterMinScore !== undefined;

    const entryHandles = all.filter(
      (d) =>
        d.tags?.specName === "entry" &&
        d.lifecycle !== "deleted",
    );

    const entries: SeadexResultContent[] = [];
    for (const h of entryHandles) {
      const raw = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        h.name,
      );
      if (!raw) continue;
      try {
        entries.push(JSON.parse(new TextDecoder().decode(raw)));
      } catch {
        // skip unparseable
      }
    }

    const upgrades = entries.filter((e) => {
      if (!e.found || e.bestReleases.length === 0) return false;
      if (filterYear !== undefined && e.userYear !== filterYear) return false;
      if (filterStatus !== undefined && e.userStatus !== filterStatus) {
        return false;
      }
      if (filterMinScore !== undefined && (e.userScore ?? 0) < filterMinScore) {
        return false;
      }
      return true;
    });

    upgrades.sort((a, b) => {
      const sa = a.userScore ?? -1;
      const sb = b.userScore ?? -1;
      if (sb !== sa) return sb - sa;
      const ya = a.userYear ?? 0;
      const yb = b.userYear ?? 0;
      if (yb !== ya) return yb - ya;
      const seaA = SEASON_ORDER[a.userSeason ?? ""] ?? 9;
      const seaB = SEASON_ORDER[b.userSeason ?? ""] ?? 9;
      if (seaA !== seaB) return seaA - seaB;
      return (a.title ?? "").localeCompare(b.title ?? "");
    });

    const bands: Array<{ label: string; pred: (s: number) => boolean }> = [
      { label: "Loved (9-10/10)", pred: (s) => s >= 90 },
      { label: "Great (8/10)", pred: (s) => s >= 80 && s < 90 },
      { label: "Good (7/10)", pred: (s) => s >= 70 && s < 80 },
      { label: "Below 7", pred: (s) => s > 0 && s < 70 },
      { label: "Unrated", pred: (s) => s === 0 || s === undefined || s < 0 },
    ];

    const lines: string[] = [];
    lines.push(`# SeaDex Upgrade List`);
    lines.push("");
    if (filterActive) {
      const parts: string[] = [];
      if (filterYear !== undefined) parts.push(`year=${filterYear}`);
      if (filterStatus !== undefined) parts.push(`status=${filterStatus}`);
      if (filterMinScore !== undefined) {
        parts.push(`minScore=${filterMinScore}`);
      }
      lines.push(`**Filter:** ${parts.join(", ")}`);
      lines.push("");
    }
    lines.push(
      `**${upgrades.length}** anime with available best releases (of ${entries.length} entries scanned${
        filterActive ? ", after filter" : ""
      }).`,
    );
    lines.push("");

    function suitableNyaaOptions(u: SeadexResultContent): ReleaseEntry[] {
      const all = [...u.bestReleases, ...u.alternativeReleases];
      const nyaa = all.filter((r) => r.tracker === PREFERRED_TRACKER);
      // Sort within each isBest tier: sub-only first, then larger size (BD remux > encode)
      nyaa.sort((a, b) => {
        if (a.isBest !== b.isBest) return a.isBest ? -1 : 1;
        if (a.dualAudio !== b.dualAudio) return a.dualAudio ? 1 : -1;
        return b.totalSizeBytes - a.totalSizeBytes;
      });
      return nyaa;
    }

    function fmtRelease(r: ReleaseEntry, currentBytes?: number): string {
      const flags: string[] = [];
      if (r.isBest) flags.push("**BEST**");
      if (r.dualAudio) flags.push("dual");
      if (r.tags.length) flags.push(...r.tags);
      const delta = currentBytes
        ? ` (Δ ${r.totalSizeBytes >= currentBytes ? "+" : ""}${
          gb(r.totalSizeBytes - currentBytes)
        } GB)`
        : "";
      const flagStr = flags.length ? ` _${flags.join(" ")}_` : "";
      return `[${r.releaseGroup}](${r.url}) — ${
        gb(r.totalSizeBytes)
      } GB${delta}${flagStr}`;
    }

    for (const band of bands) {
      const inBand = upgrades.filter((u) => band.pred(u.userScore ?? 0));
      if (inBand.length === 0) continue;
      lines.push(`## ${band.label} — ${inBand.length}`);
      lines.push("");
      for (const u of inBand) {
        const score = (u.userScore ?? 0) > 0
          ? ((u.userScore ?? 0) / 10).toFixed(1)
          : "—";
        const season = u.userYear
          ? `${u.userYear} ${u.userSeason ?? "?"}`
          : "—";
        const incTag = u.incomplete ? " ⚠ INCOMPLETE" : "";
        const currentSize = u.currentSizeBytes
          ? ` — currently ${gb(u.currentSizeBytes)} GB`
          : "";
        const path = u.currentPath ? ` \`${u.currentPath}\`` : "";
        lines.push(
          `### ${score} — ${u.title} (${season})${incTag}`,
        );
        lines.push("");
        lines.push(
          `Library:${path}${currentSize} • [SeaDex #${u.alID}](${u.sourceUrl})`,
        );
        lines.push("");
        const opts = suitableNyaaOptions(u);
        if (opts.length === 0) {
          lines.push("_No Nyaa releases (only on AB or other trackers)._");
          lines.push("");
          continue;
        }
        const bestPicks = opts.filter((o) => o.isBest);
        const alts = opts.filter((o) => !o.isBest);
        if (bestPicks.length > 0) {
          lines.push("**SeaDex best (Nyaa) — BD-quality picks:**");
          for (const r of bestPicks) {
            lines.push(`- ${fmtRelease(r, u.currentSizeBytes)}`);
          }
        }
        if (alts.length > 0) {
          lines.push("");
          lines.push(
            `<details><summary>${alts.length} alternative${
              alts.length === 1 ? "" : "s"
            } (Nyaa)</summary>`,
          );
          lines.push("");
          for (const r of alts) {
            lines.push(`- ${fmtRelease(r, u.currentSizeBytes)}`);
          }
          lines.push("</details>");
        }
        if (u.notes) {
          lines.push("");
          lines.push(`> ${u.notes.replace(/\n/g, " ")}`);
        }
        lines.push("");
      }
    }

    return {
      markdown: lines.join("\n"),
      json: {
        totalEntriesScanned: entries.length,
        totalUpgrades: upgrades.length,
        bands: bands.map((b) => ({
          label: b.label,
          count: upgrades.filter((u) => b.pred(u.userScore ?? 0)).length,
        })),
        upgrades: upgrades.map((u) => ({
          alID: u.alID,
          title: u.title,
          userScore: u.userScore ?? null,
          userStatus: u.userStatus ?? null,
          userSeason: u.userSeason ?? null,
          userYear: u.userYear ?? null,
          currentPath: u.currentPath ?? null,
          currentSizeBytes: u.currentSizeBytes ?? null,
          sourceUrl: u.sourceUrl,
          notes: u.notes,
          incomplete: u.incomplete,
          nyaaOptions: suitableNyaaOptions(u).map((r) => ({
            releaseGroup: r.releaseGroup,
            url: r.url,
            isBest: r.isBest,
            dualAudio: r.dualAudio,
            tags: r.tags,
            totalSizeBytes: r.totalSizeBytes,
            deltaBytes: u.currentSizeBytes
              ? r.totalSizeBytes - u.currentSizeBytes
              : null,
          })),
        })),
      },
    };
  },
};
