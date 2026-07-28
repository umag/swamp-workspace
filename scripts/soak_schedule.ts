/**
 * Rotating nightly property-soak scheduler.
 *
 * Discovery is anchored one level under each extension directory, to
 * `extensions/models/<name>_property_test.ts` (i.e. `<extension>/extensions/
 * models/<name>_property_test.ts`) so only genuine extension property-test
 * suites are picked up — never a scripts/ test or a file at the wrong depth.
 *
 * The discovered set is partitioned into 7 nightly buckets, sized so every
 * bucket holds at most `ceil(N/7)` files and the total across all 7 buckets
 * is exactly N (a strict partition: every file in exactly one bucket per
 * cycle). The partition is recomputed FRESH on every run from whatever file
 * set is live today — there is no persisted cursor. That means if the
 * discovered set changes mid-cycle (a new property file lands on a
 * Wednesday), one file's night this week may shift or double up; the very
 * next full 7-night cycle over the new, now-stable set is exact again. This
 * is an accepted, documented trade-off (see review history) over the
 * complexity of a persisted rotation cursor.
 *
 * Empty nights (fewer than 7 discovered files) are a NORMAL, expected
 * outcome — the consuming workflow (.github/workflows/property-soak.yml)
 * gates its soak matrix job on `files != '[]'`, mirroring the same
 * empty-matrix guard already used by ci.yml's skill-review job.
 *
 * @module
 */
import { join, relative } from "jsr:@std/path@1";

export interface DiscoveredFile {
  readonly extension: string;
  readonly file: string; // relative to the extension directory
}

/** `ceil(N/7)` — the maximum size any single night's bucket can reach. */
export function windowSize(n: number): number {
  return Math.ceil(n / 7);
}

/**
 * Deterministic 7-night partition of `files` for `dayIndex` (0..6). Sorts
 * internally so the result depends only on the file SET, not input order.
 * Distributes the remainder across the first `N % 7` days so every bucket's
 * size is either `floor(N/7)` or `floor(N/7)+1` — guaranteeing every one of
 * the 7 buckets is non-empty whenever `N >= 7`.
 */
export function computeBucket(
  files: readonly string[],
  dayIndex: number,
): string[] {
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
    throw new RangeError(`dayIndex must be an integer 0..6, got ${dayIndex}`);
  }
  const sorted = [...files].sort();
  const n = sorted.length;
  const base = Math.floor(n / 7);
  const remainder = n % 7;
  const sizes = Array.from(
    { length: 7 },
    (_, d) => base + (d < remainder ? 1 : 0),
  );
  let offset = 0;
  for (let d = 0; d < dayIndex; d++) offset += sizes[d];
  return sorted.slice(offset, offset + sizes[dayIndex]);
}

/** UTC day-of-week, 0=Sunday..6=Saturday — the natural 7-night rotation key
 * for a daily cron. Injectable `date` for deterministic tests/dispatch. */
export function dayIndexFor(date: Date): number {
  return date.getUTCDay();
}

/**
 * Anchored discovery: only `<extension>/extensions/models/<name>_property_test.ts`
 * one level deep under `root`. Uses plain `Deno.readDir`/`Deno.stat` — no
 * shell globbing — so behavior is identical across CI runners.
 */
export async function discoverPropertyTestFiles(
  root: string,
): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  for await (const extEntry of Deno.readDir(root)) {
    if (!extEntry.isDirectory) continue;
    const modelsDir = join(root, extEntry.name, "extensions", "models");
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(modelsDir)) entries.push(e);
    } catch {
      continue; // no extensions/models/ in this dir — not an extension we soak
    }
    for (const e of entries) {
      if (e.isFile && e.name.endsWith("_property_test.ts")) {
        found.push({
          extension: extEntry.name,
          file: relative(join(root, extEntry.name), join(modelsDir, e.name)),
        });
      }
    }
  }
  return found.sort((a, b) =>
    a.extension === b.extension
      ? a.file.localeCompare(b.file)
      : a.extension.localeCompare(b.extension)
  );
}

export interface BuildBucketOpts {
  /** Return every discovered file, ignoring rotation (manual "run everything now"). */
  readonly all?: boolean;
  /** Restrict to one extension's files, ignoring rotation. */
  readonly target?: string;
  /** Clock used to derive tonight's rotation day when neither `all` nor `target` is set. */
  readonly now?: Date;
}

/** CLI-facing orchestration: discovery + rotation selection. */
export async function buildTonightsBucket(
  root: string,
  opts: BuildBucketOpts = {},
): Promise<DiscoveredFile[]> {
  const discovered = await discoverPropertyTestFiles(root);
  if (opts.all) return discovered;
  if (opts.target) return discovered.filter((f) => f.extension === opts.target);

  const byKey = new Map<string, DiscoveredFile>(
    discovered.map((f) => [`${f.extension}/${f.file}`, f]),
  );
  const dayIndex = dayIndexFor(opts.now ?? new Date());
  const bucketKeys = computeBucket([...byKey.keys()], dayIndex);
  return bucketKeys.map((k) => byKey.get(k)!);
}

// ============================================================================
// CLI entrypoint
// ============================================================================

function parseArgs(
  args: string[],
): { root: string; out?: string; all: boolean; target?: string } {
  let root = ".";
  let out: string | undefined;
  let all = false;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") root = args[++i];
    else if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--all") all = true;
    else if (args[i] === "--target") target = args[++i];
  }
  return { root, out, all, target };
}

/** Serializes the bucket for the `--out` file, WITH a trailing newline: the
 * workflow appends this file's content directly into a `$GITHUB_OUTPUT`
 * heredoc (`files<<EOF` ... `EOF`) — without a trailing newline here, the
 * closing "EOF" delimiter would be glued onto the end of the JSON line and
 * GitHub Actions would fail to parse the multiline output correctly. */
export function serializeBucketForOutputFile(bucket: DiscoveredFile[]): string {
  return JSON.stringify(bucket) + "\n";
}

async function main(): Promise<void> {
  const { root, out, all, target } = parseArgs(Deno.args);
  const bucket = await buildTonightsBucket(root, {
    all,
    target,
    now: new Date(),
  });
  const json = JSON.stringify(bucket);
  if (out) {
    await Deno.writeTextFile(out, serializeBucketForOutputFile(bucket));
  } else {
    console.log(json);
  }
  const listed = bucket.map((b) => `${b.extension}/${b.file}`).join(", ") ||
    "(none)";
  console.log(
    `soak-schedule: ${bucket.length} file(s) selected for tonight — ${listed}`,
  );
}

if (import.meta.main) {
  await main();
}
