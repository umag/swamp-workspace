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
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { deriveSoakArgsFromTestTask } from "./lib/soak_permissions.ts";

export interface DiscoveredFile {
  readonly extension: string;
  readonly file: string; // relative to the extension directory
}

/** A DiscoveredFile enriched with the exact deno permission argv (as a
 * JSON-encoded STRING — see serializeBucketForOutputFile/main below for
 * why never a bare array) its property soak should run with, resolved from
 * either a narrowed quality.yaml `soak:` override or, in the common case,
 * derived directly from the extension's own deno.json `test` task. */
export interface ScheduledFile extends DiscoveredFile {
  readonly denoArgsJson: string;
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

/** Recursively walks `dir`, pushing every `*_property_test.ts` file found
 * (at any depth) as a path relative to `base` into `out`. Missing/unreadable
 * `dir` is silently skipped (not every extension directory has an
 * extensions/models/ subtree). */
async function walkForPropertyTests(
  dir: string,
  base: string,
  out: string[],
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory) {
      await walkForPropertyTests(full, base, out);
    } else if (e.isFile && e.name.endsWith("_property_test.ts")) {
      out.push(relative(base, full));
    }
  }
}

/**
 * Anchored discovery: every `*_property_test.ts` file RECURSIVELY under
 * `<extension>/extensions/models/` — not just its direct entries.
 * jscad-cad's real property suite lives one level deeper, at
 * `jscad-cad/extensions/models/jscad/jscad_cad_property_test.ts`; a
 * one-level-deep scan never found it, so it was never actually soaked. Uses
 * plain `Deno.readDir`/`Deno.stat` — no shell globbing — so behavior is
 * identical across CI runners.
 */
export async function discoverPropertyTestFiles(
  root: string,
): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  for await (const extEntry of Deno.readDir(root)) {
    if (!extEntry.isDirectory) continue;
    const extDir = join(root, extEntry.name);
    const modelsDir = join(extDir, "extensions", "models");
    const rels: string[] = [];
    await walkForPropertyTests(modelsDir, extDir, rels);
    for (const rel of rels) {
      found.push({ extension: extEntry.name, file: rel });
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

/** Best-effort read of `<root>/<extension>/deno.json`'s `tasks.test` string.
 * Never throws: a missing/unreadable/malformed deno.json (or one with no
 * `test` task) resolves to "" — parsePermissionSet("") is the empty
 * permission set, and downstream check_soak.ts (not this scheduler) is the
 * gate that reports the resulting adequacy violation. */
async function readTestTaskLenient(
  root: string,
  extension: string,
): Promise<string> {
  try {
    const raw = await Deno.readTextFile(join(root, extension, "deno.json"));
    const json = JSON.parse(raw) as { tasks?: { test?: string } };
    return json.tasks?.test ?? "";
  } catch {
    return "";
  }
}

/** Resolve the deno permission argv for `extension`'s property soak: prefer
 * a narrowed `quality.yaml` `soak: { state: present, denoArgs: [...] } }`
 * override when one exists (scripts/quality/check_soak.ts is the gate that
 * verifies it's a legitimate narrowing, not this scheduler); otherwise fall
 * back to deriving argv directly from the extension's own `test` task — the
 * common-case path that closes the permission gap for every extension that
 * doesn't need a hand-authored override at all. Never throws. */
async function resolveDenoArgs(
  root: string,
  extension: string,
  testTask: string,
): Promise<string[]> {
  try {
    const raw = parseYaml(
      await Deno.readTextFile(join(root, extension, "quality.yaml")),
    );
    if (raw && typeof raw === "object") {
      const soak = (raw as Record<string, unknown>).soak;
      if (soak && typeof soak === "object") {
        const soakObj = soak as Record<string, unknown>;
        if (soakObj.state === "present" && Array.isArray(soakObj.denoArgs)) {
          const denoArgs = soakObj.denoArgs;
          if (
            denoArgs.length > 0 &&
            denoArgs.every((a) => typeof a === "string")
          ) {
            return denoArgs as string[];
          }
        }
      }
    }
  } catch {
    // no quality.yaml, or unreadable/malformed — fall back to the test task
  }
  // deriveSoakArgsFromTestTask carries runtime flags (--v8-flags=...,
  // --unstable-*) through ahead of the permission flags — see its docblock
  // for the seanime/seadex --v8-flags=--expose-gc coverage hole this fixes
  // (the heap-pin regression tests those extensions gate behind an exposed
  // gc() were silently skipped in every nightly soak run until this).
  return deriveSoakArgsFromTestTask(testTask);
}

async function enrichWithDenoArgs(
  root: string,
  files: readonly DiscoveredFile[],
): Promise<ScheduledFile[]> {
  const out: ScheduledFile[] = [];
  for (const f of files) {
    const testTask = await readTestTaskLenient(root, f.extension);
    const denoArgs = await resolveDenoArgs(root, f.extension, testTask);
    out.push({ ...f, denoArgsJson: JSON.stringify(denoArgs) });
  }
  return out;
}

/** CLI-facing orchestration: discovery + rotation selection + per-entry
 * denoArgsJson resolution. */
export async function buildTonightsBucket(
  root: string,
  opts: BuildBucketOpts = {},
): Promise<ScheduledFile[]> {
  const discovered = await discoverPropertyTestFiles(root);
  let selected: DiscoveredFile[];
  if (opts.all) {
    selected = discovered;
  } else if (opts.target) {
    selected = discovered.filter((f) => f.extension === opts.target);
  } else {
    const byKey = new Map<string, DiscoveredFile>(
      discovered.map((f) => [`${f.extension}/${f.file}`, f]),
    );
    const dayIndex = dayIndexFor(opts.now ?? new Date());
    const bucketKeys = computeBucket([...byKey.keys()], dayIndex);
    selected = bucketKeys.map((k) => byKey.get(k)!);
  }
  return enrichWithDenoArgs(root, selected);
}

// ============================================================================
// CLI entrypoint
// ============================================================================

function parseArgs(
  args: string[],
): {
  root: string;
  out?: string;
  all: boolean;
  target?: string;
  verbose: boolean;
} {
  let root = ".";
  let out: string | undefined;
  let all = false;
  let target: string | undefined;
  let verbose = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") root = args[++i];
    else if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--all") all = true;
    else if (args[i] === "--target") target = args[++i];
    else if (args[i] === "--verbose") verbose = true;
  }
  return { root, out, all, target, verbose };
}

/** Serializes the bucket for the `--out` file, WITH a trailing newline: the
 * workflow appends this file's content directly into a `$GITHUB_OUTPUT`
 * heredoc (`files<<EOF` ... `EOF`) — without a trailing newline here, the
 * closing "EOF" delimiter would be glued onto the end of the JSON line and
 * GitHub Actions would fail to parse the multiline output correctly.
 *
 * INVARIANT the workflow's literal `EOF` heredoc delimiter (property-soak.yml,
 * `discover` job) relies on: JSON.stringify(bucket) never contains an
 * embedded raw newline (soak_schedule_test.ts's "no emitted field ...
 * contains a raw newline" test pins this for every field, including
 * denoArgsJson), so the ENTIRE payload is always exactly one line. A
 * multi-line payload could in principle contain a line that is literally the
 * string "EOF" and prematurely terminate GitHub's heredoc parse — a real
 * risk this module avoids by construction (single-line JSON), not by
 * escaping/quoting the delimiter itself. If this function (or
 * buildTonightsBucket) is ever changed to allow embedded newlines, the
 * workflow's `files<<EOF`/`EOF` pair must be replaced with a randomized
 * delimiter first. */
export function serializeBucketForOutputFile(bucket: DiscoveredFile[]): string {
  return JSON.stringify(bucket) + "\n";
}

/** One human-readable summary line per bucket entry. Default: extension/file
 * plus the resolved permission FLAG COUNT (e.g. "(3 flags)") — cheap enough
 * to always include, and enough for an operator skimming the log to notice
 * "0 flags" or a suspiciously small count without opening the JSON blob.
 * `verbose`: the full resolved argv instead, e.g. "[--allow-read
 * --allow-env=FC_NUM_RUNS]" — for when the count alone isn't enough context
 * to debug a soak failure. */
function summarizeEntry(entry: ScheduledFile, verbose: boolean): string {
  const label = `${entry.extension}/${entry.file}`;
  const args = JSON.parse(entry.denoArgsJson) as string[];
  if (verbose) {
    return `${label} [${args.join(" ")}]`;
  }
  return `${label} (${args.length} flag${args.length === 1 ? "" : "s"})`;
}

async function main(): Promise<void> {
  const { root, out, all, target, verbose } = parseArgs(Deno.args);
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
  const listed = bucket.map((b) => summarizeEntry(b, verbose)).join(", ") ||
    "(none)";
  console.log(
    `soak-schedule: ${bucket.length} file(s) selected for tonight — ${listed}`,
  );
}

if (import.meta.main) {
  await main();
}
