// Discography-sync coverage report for @magistr/musicbrainz.
//
// Renders sync-artist-discographies' discographySyncState as an operator-
// facing coverage surface, bound to the EXECUTION that produced it: it only
// claims THIS run's numbers when the discography-sync-cursor handle is
// present in context.dataHandles — the report-layer equivalent of the
// music-wanted workflow's `tags.workflowRunId == run.id` scoping, and only
// sound because step 4F's method returns that handle rather than
// `[undefined]`. Never throws — a model-scope report runs after EVERY
// method on the instance, so a malformed/absent state must degrade, not
// crash the run.
//
// Five render cases, evaluated in a PINNED order because (a) and (d)
// overlap: (d) no stored state at all splits on the method (the "no
// resource found" shape for sync-artist-discographies itself, EMPTY
// markdown — no stray timestamp — for any other method on a fresh
// instance); (a) a method OTHER than sync-artist-discographies with stored
// state present renders one line naming that state's updatedAt and no
// coverage numbers; (b) this execution wrote the state — render its
// numbers, leading with a partial-pass banner when executionStatus is
// "failed"; (c) this execution wrote NO state — render the previous run's
// numbers under an explicit "does NOT describe this one" banner.
//
// The independent cross-check (case (b)/(c) always run it) rebuilds the set
// of cached `rg-by-artist-*` rows from stored data and verifies it agrees
// with the sync's own processed/skipped/uncovered accounting — in
// TypeScript, not CEL (see musicbrainz.ts's Gate-3-placement comment for
// why the workflow's own top-level version of this check cannot live
// inside a `.filter()` macro body).

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

interface ExecutionDataHandle {
  name: string;
  specName?: string;
}

interface ReportContext {
  modelType: string;
  modelId: string;
  methodName?: string;
  executionStatus?: "succeeded" | "failed";
  dataHandles?: ExecutionDataHandle[];
  dataRepository: DataRepo;
}

interface DiscographySyncStateContent {
  cursor: { offset: number };
  processed: string[];
  skipped: string[];
  updatedAt: string;
  requested?: number;
  requestedRaw?: number;
  listFingerprint?: string;
  startOffset?: number;
  covered?: number;
  remaining?: number;
  uncovered?: string[];
  uncoveredCount?: number;
}

const SYNC_METHOD_NAME = "sync-artist-discographies";
const DISCOGRAPHY_SYNC_CURSOR_INSTANCE = "discography-sync-cursor";

function decode(bytes: Uint8Array | null): unknown {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function isDiscographySyncState(
  v: unknown,
): v is DiscographySyncStateContent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.updatedAt === "string" &&
    Array.isArray(o.processed) &&
    Array.isArray(o.skipped) &&
    typeof o.cursor === "object" && o.cursor !== null;
}

/** Independent cross-check: rebuilds the set of cached `rg-by-artist-*`
 * rows from stored data (never from any counter the sync itself wrote) and
 * verifies it agrees with the sync's own processed/skipped/uncovered
 * accounting. Any disagreement is a real bug — the sync's self-report and
 * the actual cache have diverged. */
export interface CrossCheckResult {
  agrees: boolean;
  missingRows: string[];
  unexpectedRows: string[];
}

export async function buildCrossCheck(
  repo: DataRepo,
  modelType: string,
  modelId: string,
  state: DiscographySyncStateContent,
): Promise<CrossCheckResult> {
  const all = await repo.findAllForModel(modelType, modelId);
  const live = all.filter((h) => h.lifecycle !== "deleted");
  const rgNames = new Set(
    live
      .filter((h) =>
        h.tags?.specName === "browse" && h.name.startsWith("rg-by-artist-")
      )
      .map((h) => h.name),
  );
  const visited = [...(state.processed ?? []), ...(state.skipped ?? [])];
  const missingRows = visited.filter((mbid) =>
    !rgNames.has(`rg-by-artist-${mbid}`)
  );
  const unexpectedRows = (state.uncovered ?? []).filter((mbid) =>
    rgNames.has(`rg-by-artist-${mbid}`)
  );
  return {
    agrees: missingRows.length === 0 && unexpectedRows.length === 0,
    missingRows,
    unexpectedRows,
  };
}

export function renderCoverage(
  state: DiscographySyncStateContent,
  crossCheck: CrossCheckResult,
  opts: { leadBanner?: string; describesThisRun?: boolean } = {},
): string {
  // describesThisRun defaults to true because renderCoverage's ONLY other
  // caller (case (b)) always feeds it the execution's own just-written
  // state. Case (c) feeds it a PREVIOUS run's state and must pass false --
  // the coverage numbers are real, but nothing below may claim they
  // happened "this run" (that claim belongs to the previous run the
  // leadBanner already names).
  const { leadBanner, describesThisRun = true } = opts;
  const lines: string[] = [];
  lines.push("# Discography sync coverage");
  lines.push("");
  if (leadBanner) {
    lines.push(leadBanner);
    lines.push("");
  }

  const { requested, covered, remaining, startOffset, requestedRaw } = state;
  const processed = state.processed ?? [];
  const skipped = state.skipped ?? [];

  if (
    requested !== undefined && covered !== undefined &&
    remaining !== undefined
  ) {
    const resumeClause = startOffset !== undefined && startOffset > 0
      ? describesThisRun
        ? ` This run started at cursor offset ${startOffset}, so it never reached the start of the list. Re-run to cover the remainder.`
        : ` That run started at cursor offset ${startOffset}, so it never reached the start of the list.`
      : "";
    lines.push(
      `Discography sync: ${covered} of ${requested} requested artists covered — ` +
        `${processed.length} fetched, ${skipped.length} fresh-cache skipped, ${remaining} NOT ATTEMPTED.` +
        resumeClause,
    );
    if (remaining === 0) {
      lines.push(
        describesThisRun
          ? "Full coverage — every requested artist was visited this run."
          : "Full coverage — every requested artist was visited in that run.",
      );
    }
    if (requestedRaw !== undefined && requestedRaw !== requested) {
      lines.push(
        `${
          requestedRaw - requested
        } duplicate MBID(s) were deduped out of the raw input list (requestedRaw ${requestedRaw}, requested ${requested}).`,
      );
    }
  } else {
    lines.push(
      `Cursor at list position ${state.cursor.offset} (pre-this-change state — no coverage accounting recorded).`,
    );
  }

  lines.push("");
  lines.push(`Last updated: ${state.updatedAt}`);

  const uncoveredCount = state.uncoveredCount;
  if (uncoveredCount !== undefined) {
    if (uncoveredCount === 0) {
      lines.push(
        "Catalog complete: every requested artist has a cached discography.",
      );
    } else {
      lines.push("");
      lines.push(
        `## Catalog incomplete: ${uncoveredCount} artist(s) have no cached discography at all`,
      );
      for (const mbid of state.uncovered ?? []) {
        lines.push(`- ${mbid}`);
      }
    }
  }

  if (!crossCheck.agrees) {
    lines.push("");
    lines.push("## The sync's self-report disagrees with stored data");
    if (crossCheck.missingRows.length > 0) {
      lines.push(
        `- ${crossCheck.missingRows.length} MBID(s) reported processed/skipped have NO cached rg-by-artist row: ${
          crossCheck.missingRows.slice(0, 10).join(", ")
        }`,
      );
    }
    if (crossCheck.unexpectedRows.length > 0) {
      lines.push(
        `- ${crossCheck.unexpectedRows.length} MBID(s) reported uncovered DO have a cached row: ${
          crossCheck.unexpectedRows.slice(0, 10).join(", ")
        }`,
      );
    }
  }

  return lines.join("\n");
}

function toJson(
  state: DiscographySyncStateContent,
  crossCheck: CrossCheckResult,
): Record<string, unknown> {
  return {
    updatedAt: state.updatedAt,
    cursor: state.cursor,
    requested: state.requested,
    requestedRaw: state.requestedRaw,
    startOffset: state.startOffset,
    covered: state.covered,
    remaining: state.remaining,
    uncoveredCount: state.uncoveredCount,
    uncovered: state.uncovered,
    processedCount: (state.processed ?? []).length,
    skippedCount: (state.skipped ?? []).length,
    crossCheckAgrees: crossCheck.agrees,
    crossCheckMissingRows: crossCheck.missingRows,
    crossCheckUnexpectedRows: crossCheck.unexpectedRows,
  };
}

export const report = {
  name: "@magistr/musicbrainz-discography-sync",
  description:
    "Coverage surface over sync-artist-discographies' discographySyncState: this run's numbers when this execution wrote the state (with a loud partial-pass banner on a failed run), the previous run's numbers with an explicit 'does NOT describe this one' disclaimer when this execution wrote no state, one line naming just the timestamp for any other method, and nothing at all for a fresh instance's first non-sync method run. Independently cross-checks the sync's processed/skipped/uncovered accounting against the actual cached rg-by-artist-* rows and renders any disagreement loudly.",
  scope: "model" as const,
  labels: ["musicbrainz", "discography", "sync", "coverage"],

  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const { modelType, modelId, dataRepository: repo } = context;
    try {
      const all = await repo.findAllForModel(modelType, modelId);
      const live = all.filter((h) => h.lifecycle !== "deleted");
      const stateHandles = live.filter((h) =>
        h.tags?.specName === "discographySyncState"
      );

      // Newest persisted state, regardless of which run wrote it.
      let latest: DiscographySyncStateContent | null = null;
      let latestTs = -1;
      for (const h of stateHandles) {
        const c = decode(
          await repo.getContent(modelType, modelId, h.name, h.version),
        );
        if (!isDiscographySyncState(c)) continue;
        const ts = Date.parse(c.updatedAt) || 0;
        if (ts > latestTs) {
          latestTs = ts;
          latest = c;
        }
      }

      // (d) NO STORED STATE AT ALL — checked FIRST because it overlaps
      // with (a): splits on the method so a fresh instance's first
      // non-sync command (e.g. search-artist) never prints a stray
      // discography-coverage line naming a timestamp that doesn't exist.
      if (!latest) {
        if (context.methodName === SYNC_METHOD_NAME) {
          return {
            markdown:
              "# Discography sync coverage\n\nNo resource found — run the `sync-artist-discographies` method first.",
            json: { status: "no-data" },
          };
        }
        return { markdown: "", json: { status: "not-applicable" } };
      }

      // (a) a method OTHER than sync-artist-discographies, with stored
      // state present — one line naming that state's updatedAt, no
      // coverage numbers. A model-scoped report runs after EVERY method on
      // the instance, so without this an unrelated search-artist run would
      // print a discography-coverage block that has nothing to do with it.
      if (context.methodName !== SYNC_METHOD_NAME) {
        return {
          markdown:
            `Discography sync coverage last updated ${latest.updatedAt} — not touched by this run.`,
          json: { status: "not-this-method", updatedAt: latest.updatedAt },
        };
      }

      const crossCheck = await buildCrossCheck(
        repo,
        modelType,
        modelId,
        latest,
      );

      // Was THIS execution the one that wrote the state? — the handle for
      // discography-sync-cursor must be present in context.dataHandles,
      // exactly what the method's restructured `return` (finally-write,
      // return-out-of-try) produces on a successful sync.
      const thisRunHandle = (context.dataHandles ?? []).find((h) =>
        h.name === DISCOGRAPHY_SYNC_CURSOR_INSTANCE
      );

      if (!thisRunHandle) {
        // (c) this execution wrote NO state — e.g. the missing-artistMbids
        // throw, which fires before any sync is attempted.
        const failedPrefix = context.executionStatus === "failed"
          ? "This run FAILED. "
          : "";
        return {
          markdown: renderCoverage(latest, crossCheck, {
            leadBanner:
              `${failedPrefix}This run wrote no sync state. The coverage below is from the previous run at ${latest.updatedAt} and does NOT describe this one.`,
            describesThisRun: false,
          }),
          json: {
            status: "no-state-this-run",
            ...toJson(latest, crossCheck),
          },
        };
      }

      // (b) this execution DID write the state.
      const leadBanner = context.executionStatus === "failed"
        ? "This run FAILED part-way. The numbers below describe the partial pass it did complete, not a full sync."
        : undefined;
      return {
        markdown: renderCoverage(latest, crossCheck, { leadBanner }),
        json: { status: "ok", ...toJson(latest, crossCheck) },
      };
    } catch (e) {
      return {
        markdown: `# Discography sync coverage\n\nReport degraded: ${
          e instanceof Error ? e.message : String(e)
        }`,
        json: { status: "degraded", error: String(e) },
      };
    }
  },
};
