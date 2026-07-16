// Playback-verification triage report for @magistr/music-library.
//
// Renders the latest `verify` resource into an actionable worklist — it
// never touches the filesystem or ffmpeg itself (rule 3: use the data
// model). Buckets:
//   - unreadable files (with junk/non-audio suspicion for plugin/skin paths)
//   - truncated files, split into known-incomplete sources (youtube rips,
//     `incomplete/` dirs), suspicious big gaps (VBR duration estimates), and
//     real losses
//   - systematically damaged directories (many bad files → re-source the
//     whole album) vs isolated single-glitch files
//   - lossless (flac/ape/wv/wav) corruption — the bit-rot indicator
//
// When a `dupes` resource exists, damaged dirs that belong to a duplicate
// cluster get a "healthy copy may exist" hint with the alternative path.

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

interface VerifyProblem {
  path: string;
  status: string;
  rc: number;
  expectedSec: number | null;
  decodedSec: number | null;
  errors: string[];
}

interface VerifyContent {
  kind: string;
  mode: string;
  startedAt: string;
  elapsedSec: number;
  params: { path: string; pathPrefix: string };
  checked: number;
  ok: number;
  failed: number;
  errors: number;
  truncated: number;
  problems: VerifyProblem[];
}

interface DupesContent {
  kind: string;
  albumClusters: Array<{
    artist: string;
    title: string;
    keep: string;
    albums: Array<{ dir: string }>;
  }>;
}

const LOSSLESS_EXT_RE = /\.(flac|ape|wv|wav|aiff|alac)$/i;
const JUNK_PATH_RE = /\/(plugins?|skins?|avs|visualizations?)\//i;
const KNOWN_INCOMPLETE_RE = /^youtube\/|\/incomplete\//i;
// full-mode gaps beyond this are as likely bad VBR header estimates as real
// truncation — surfaced separately for a listen-first check
const BIG_GAP_SEC = 300;
const SYSTEMATIC_MIN_FILES = 8;

function decode(bytes: Uint8Array | null): unknown {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
}

function pct(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "n/a";
}

function fmtGap(p: VerifyProblem): number {
  if (p.expectedSec === null) return 0;
  return Math.max(0, Math.round(p.expectedSec - (p.decodedSec ?? 0)));
}

/** Build the triage buckets from a verify resource (pure — unit-testable). */
export function triageVerify(
  verify: VerifyContent,
  dupes: DupesContent | null,
) {
  // dir → other dirs of the same duplicate cluster
  const dupeAlternatives = new Map<string, string[]>();
  for (const cluster of dupes?.albumClusters ?? []) {
    const dirs = cluster.albums.map((a) => a.dir);
    for (const d of dirs) {
      dupeAlternatives.set(d, dirs.filter((o) => o !== d));
    }
  }
  const altsFor = (dir: string): string[] =>
    dupeAlternatives.get(dir) ?? dupeAlternatives.get(dirOf(dir)) ?? [];

  const unreadable = verify.problems
    .filter((p) => p.status === "failed")
    .map((p) => ({
      path: p.path,
      suspectedJunk: JUNK_PATH_RE.test("/" + p.path),
      errors: p.errors.slice(0, 2),
    }));

  const truncatedAll = verify.problems
    .filter((p) => p.status === "truncated")
    .map((p) => ({ path: p.path, missingSec: fmtGap(p) }))
    .sort((a, b) => b.missingSec - a.missingSec);
  const truncated = {
    knownIncomplete: truncatedAll.filter((t) =>
      KNOWN_INCOMPLETE_RE.test(t.path)
    ),
    bigGapSuspect: truncatedAll.filter((t) =>
      !KNOWN_INCOMPLETE_RE.test(t.path) && t.missingSec > BIG_GAP_SEC
    ),
    realLoss: truncatedAll.filter((t) =>
      !KNOWN_INCOMPLETE_RE.test(t.path) && t.missingSec <= BIG_GAP_SEC
    ),
  };

  const errorProblems = verify.problems.filter((p) => p.status === "errors");
  const byDir = new Map<string, VerifyProblem[]>();
  for (const p of errorProblems) {
    const d = dirOf(p.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(p);
  }
  const systematicDirs = [...byDir.entries()]
    .filter(([, ps]) => ps.length >= SYSTEMATIC_MIN_FILES)
    .map(([dir, ps]) => ({
      dir,
      badFiles: ps.length,
      duplicateDirs: altsFor(dir),
    }))
    .sort((a, b) => b.badFiles - a.badFiles);
  const systematicDirSet = new Set(systematicDirs.map((s) => s.dir));
  const isolated = errorProblems.filter((p) =>
    !systematicDirSet.has(dirOf(p.path))
  );

  const losslessCorrupt = errorProblems
    .filter((p) => LOSSLESS_EXT_RE.test(p.path))
    .map((p) => ({
      path: p.path,
      errors: p.errors.slice(0, 2),
      duplicateDirs: altsFor(dirOf(p.path)),
    }));

  return {
    unreadable,
    truncated,
    systematicDirs,
    isolatedGlitchCount: isolated.length,
    losslessCorrupt,
  };
}

function renderMarkdown(
  verify: VerifyContent,
  triage: ReturnType<typeof triageVerify>,
  hadDupes: boolean,
): string {
  const scope = verify.params.path || verify.params.pathPrefix ||
    "whole library";
  const lines: string[] = [];
  lines.push(`# Playback triage — ${scope}`);
  lines.push("");
  lines.push(
    `Mode **${verify.mode}**, started ${verify.startedAt}, ` +
      `${verify.elapsedSec}s. **${verify.ok}/${verify.checked} ok** ` +
      `(${pct(verify.ok, verify.checked)}) · ${verify.failed} unreadable · ` +
      `${verify.truncated} truncated · ${verify.errors} with decode errors.`,
  );

  if (triage.unreadable.length > 0) {
    lines.push("");
    lines.push(`## 🔴 Unreadable (${triage.unreadable.length})`);
    lines.push("");
    lines.push("| File | Note |");
    lines.push("| --- | --- |");
    for (const u of triage.unreadable) {
      const note = u.suspectedJunk
        ? "suspected non-audio junk (plugin/skin path)"
        : (u.errors[0] ?? "");
      lines.push(`| ${u.path} | ${note} |`);
    }
  }

  const t = triage.truncated;
  if (t.realLoss.length + t.bigGapSuspect.length + t.knownIncomplete.length) {
    lines.push("");
    lines.push("## 🟠 Truncated");
    if (t.realLoss.length > 0) {
      lines.push("");
      lines.push(`### Real losses (${t.realLoss.length}) — re-source these`);
      lines.push("");
      lines.push("| File | Missing |");
      lines.push("| --- | --- |");
      for (const x of t.realLoss) {
        lines.push(`| ${x.path} | ${x.missingSec}s |`);
      }
    }
    if (t.bigGapSuspect.length > 0) {
      lines.push("");
      lines.push(
        `### Big gaps (${t.bigGapSuspect.length}) — listen first, ` +
          `VBR duration estimates can exaggerate`,
      );
      lines.push("");
      lines.push("| File | Missing |");
      lines.push("| --- | --- |");
      for (const x of t.bigGapSuspect) {
        lines.push(`| ${x.path} | ${x.missingSec}s |`);
      }
    }
    if (t.knownIncomplete.length > 0) {
      lines.push("");
      lines.push(
        `### Known-incomplete sources (${t.knownIncomplete.length}) — ` +
          `youtube rips / \`incomplete/\` dirs, re-download or accept`,
      );
    }
  }

  if (triage.systematicDirs.length > 0) {
    lines.push("");
    lines.push(
      `## 🟡 Systematically damaged albums (${triage.systematicDirs.length} dirs, ≥${SYSTEMATIC_MIN_FILES} bad files) — bad source rips, re-source whole album`,
    );
    lines.push("");
    lines.push("| Directory | Bad files | Duplicate copy |");
    lines.push("| --- | --- | --- |");
    for (const s of triage.systematicDirs) {
      const dupe = s.duplicateDirs.length > 0
        ? `maybe: ${s.duplicateDirs[0]}`
        : (hadDupes ? "none known" : "—");
      lines.push(`| ${s.dir} | ${s.badFiles} | ${dupe} |`);
    }
  }

  if (triage.losslessCorrupt.length > 0) {
    lines.push("");
    lines.push(
      `## 🟡 Lossless corruption (${triage.losslessCorrupt.length}) — bit-level damage in flac/ape/wv`,
    );
    lines.push("");
    lines.push("| File | Error | Duplicate copy |");
    lines.push("| --- | --- | --- |");
    for (const l of triage.losslessCorrupt) {
      const dupe = l.duplicateDirs.length > 0
        ? `maybe: ${l.duplicateDirs[0]}`
        : (hadDupes ? "none known" : "—");
      lines.push(`| ${l.path} | ${l.errors[0] ?? ""} | ${dupe} |`);
    }
  }

  lines.push("");
  lines.push(
    `## ⚪ Isolated glitches: ${triage.isolatedGlitchCount} files ` +
      `(one-off decode errors outside the systematic dirs — usually a ` +
      `single click; keep unless audible)`,
  );
  return lines.join("\n");
}

export const report = {
  name: "@magistr/music-verify-triage",
  description:
    "Triage of the latest playback-verification run: unreadable files, truncation split by cause, systematically damaged albums (with healthy-duplicate hints from the dupes resource), lossless corruption, and isolated glitches.",
  scope: "model" as const,
  labels: ["music", "verify", "integrity", "triage"],

  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const { modelType, modelId, dataRepository: repo } = context;
    const empty = {
      markdown: "# Playback triage\n\nNo verify resource found — run the " +
        "`verify` method first.",
      json: { status: "no-data" },
    };
    try {
      const all = await repo.findAllForModel(modelType, modelId);
      const live = all.filter((h) => h.lifecycle !== "deleted");

      // newest verify artifact; when this run IS a verify, prefer the
      // artifact whose params match the triggering arguments
      const wantPath = typeof context.methodArgs?.path === "string"
        ? context.methodArgs.path
        : null;
      const wantPrefix = typeof context.methodArgs?.pathPrefix === "string"
        ? context.methodArgs.pathPrefix
        : null;
      let best: VerifyContent | null = null;
      let bestScore = -1;
      for (const h of live.filter((x) => x.tags?.specName === "verify")) {
        const c = decode(
          await repo.getContent(modelType, modelId, h.name, h.version),
        ) as VerifyContent | null;
        if (!c || c.kind !== "verify" || !Array.isArray(c.problems)) continue;
        const ts = Date.parse(c.startedAt) || 0;
        const matchesRun = wantPath !== null && wantPrefix !== null &&
          c.params.path === wantPath && c.params.pathPrefix === wantPrefix;
        // params match outranks recency
        const score = (matchesRun ? 1e15 : 0) + ts;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) return empty;

      let dupes: DupesContent | null = null;
      for (const h of live.filter((x) => x.tags?.specName === "dupes")) {
        const c = decode(
          await repo.getContent(modelType, modelId, h.name, h.version),
        ) as DupesContent | null;
        if (c && Array.isArray(c.albumClusters)) dupes = c;
      }

      const triage = triageVerify(best, dupes);
      return {
        markdown: renderMarkdown(best, triage, dupes !== null),
        json: {
          status: "ok",
          scope: best.params.path || best.params.pathPrefix ||
            "whole-library",
          mode: best.mode,
          startedAt: best.startedAt,
          totals: {
            checked: best.checked,
            ok: best.ok,
            failed: best.failed,
            errors: best.errors,
            truncated: best.truncated,
          },
          ...triage,
        },
      };
    } catch (e) {
      return {
        markdown: `# Playback triage\n\nReport degraded: ${
          e instanceof Error ? e.message : String(e)
        }`,
        json: { status: "degraded", error: String(e) },
      };
    }
  },
};
