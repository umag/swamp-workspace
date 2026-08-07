/**
 * Registry drift detector.
 *
 * Answers one question: for every extension in this repo, does the version
 * declared in `<ext>/manifest.yaml` actually exist on the swamp registry, on
 * the channel that extension publishes to?
 *
 * WHY THIS EXISTS. `extension-publish` fires only on the single commit whose
 * own diff carries the `+version:` line. If that one run does not complete —
 * cancelled, infrastructure failure, expired credentials — the publish is
 * dropped permanently: there is no retry, and no later run re-detects it. The
 * repo then claims a version the registry has never heard of, and nothing
 * says so. On 2026-08-07 a sweep found 18 packages in exactly that state,
 * some more than three weeks stale, after a concurrency-group cancellation
 * silently killed the publishing run.
 *
 * The failure is silent by construction, so it needs an explicit detector.
 *
 * Channel matters: a package carrying `<ext>/.release-channel` publishes to
 * beta or rc, and its version will NOT appear as the stable `latestVersion`.
 * Comparing against the wrong channel is how a beta package looks like it was
 * never published at all.
 *
 * @module
 */
import { join } from "jsr:@std/path@1";

/** A release channel an extension can publish to. */
export type Channel = "stable" | "beta" | "rc";

/** What one extension declares locally. */
export interface Declared {
  /** Directory name under the repo root, e.g. `musicbrainz`. */
  readonly dir: string;
  /** Full package name from the manifest, e.g. `@magistr/musicbrainz`. */
  readonly name: string;
  /** Version from the manifest, e.g. `2026.08.07.1`. */
  readonly version: string;
  /** Channel this extension publishes to. */
  readonly channel: Channel;
}

/** What the registry reports for a package, per channel. */
export interface RegistryVersions {
  readonly stable: string | null;
  readonly beta: string | null;
  readonly rc: string | null;
}

/** One extension's drift verdict. */
export interface DriftRow {
  readonly dir: string;
  readonly name: string;
  readonly channel: Channel;
  readonly declared: string;
  /** Registry's version on `channel`, or null when absent/unknown. */
  readonly published: string | null;
  readonly status: "in-sync" | "behind" | "absent";
}

const CHANNELS: readonly Channel[] = ["stable", "beta", "rc"];

/**
 * Reads `name:` and `version:` from a manifest. Deliberately a line scan
 * rather than a YAML parse: these two keys are always top-level scalars, and
 * this must not grow a YAML dependency for CI.
 *
 * Returns null when either key is missing — a manifest without both is not
 * publishable and is reported separately rather than silently skipped.
 */
export function parseManifest(
  text: string,
): { name: string; version: string } | null {
  let name: string | undefined;
  let version: string | undefined;
  for (const line of text.split("\n")) {
    if (name === undefined && line.startsWith("name:")) {
      name = unquote(line.slice("name:".length));
    } else if (version === undefined && line.startsWith("version:")) {
      version = unquote(line.slice("version:".length));
    }
  }
  if (!name || !version) return null;
  return { name, version };
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Resolves the channel from a `.release-channel` file's contents. Absent file
 * (`null`) means stable, matching `extension-publish`'s default.
 *
 * Throws on an unrecognised value rather than defaulting to stable: silently
 * treating a typo'd channel as stable would compare against the wrong channel
 * forever, which is the very confusion this detector exists to end.
 */
export function resolveChannel(fileContents: string | null): Channel {
  if (fileContents === null) return "stable";
  const value = fileContents.trim();
  if ((CHANNELS as readonly string[]).includes(value)) return value as Channel;
  throw new Error(
    `.release-channel must be one of ${CHANNELS.join(" | ")}, got "${value}"`,
  );
}

/** Picks the version the registry reports on `channel`. */
export function publishedOn(
  versions: RegistryVersions,
  channel: Channel,
): string | null {
  return versions[channel];
}

/**
 * Compares one declared extension against the registry.
 *
 * `registry === null` means the package is not on the registry at all;
 * a null version on the channel means the package exists but has nothing
 * published on that channel. Both are `absent` — actionable in the same way.
 */
export function classify(
  declared: Declared,
  registry: RegistryVersions | null,
): DriftRow {
  const published = registry === null
    ? null
    : publishedOn(registry, declared.channel);
  const status: DriftRow["status"] = published === null
    ? "absent"
    : published === declared.version
    ? "in-sync"
    : "behind";
  return {
    dir: declared.dir,
    name: declared.name,
    channel: declared.channel,
    declared: declared.version,
    published,
    status,
  };
}

/** Rows that mean CI should fail. */
export function drifted(rows: readonly DriftRow[]): DriftRow[] {
  return rows.filter((r) => r.status !== "in-sync");
}

/**
 * Renders the report. Drifted rows come first and carry the reason, because
 * the whole point is that a reader sees what to act on without scrolling
 * past 30 healthy packages.
 */
export function formatReport(rows: readonly DriftRow[]): string {
  const bad = drifted(rows);
  const lines: string[] = [];
  lines.push(
    `Checked ${rows.length} extension(s): ${
      rows.length - bad.length
    } in sync, ` +
      `${bad.length} drifted.`,
  );
  if (bad.length > 0) {
    lines.push("");
    lines.push(
      "Drifted — the repo declares a version the registry does not have:",
    );
    for (const r of bad) {
      const got = r.published === null
        ? `nothing published on '${r.channel}'`
        : `registry has ${r.published}`;
      lines.push(`  ${r.name}  declares ${r.declared} (${r.channel}) — ${got}`);
    }
  }
  return lines.join("\n");
}

/** Discovers every `<dir>/manifest.yaml` one level under `root`. */
export async function discover(root: string): Promise<Declared[]> {
  const out: Declared[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    const manifestPath = join(root, entry.name, "manifest.yaml");
    let text: string;
    try {
      text = await Deno.readTextFile(manifestPath);
    } catch {
      continue;
    }
    const parsed = parseManifest(text);
    if (parsed === null) {
      throw new Error(
        `${manifestPath}: missing a top-level name: or version: key`,
      );
    }
    let channelFile: string | null = null;
    try {
      channelFile = await Deno.readTextFile(
        join(root, entry.name, ".release-channel"),
      );
    } catch {
      channelFile = null;
    }
    out.push({
      dir: entry.name,
      name: parsed.name,
      version: parsed.version,
      channel: resolveChannel(channelFile),
    });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The `@ns` prefix of a package name, without the `@`. */
export function collectiveOf(packageName: string): string | null {
  const m = /^@([^/]+)\//.exec(packageName);
  return m ? m[1] : null;
}

/** The distinct collectives a set of declarations publishes to. */
export function collectives(declared: readonly Declared[]): string[] {
  const set = new Set<string>();
  for (const d of declared) {
    const c = collectiveOf(d.name);
    if (c !== null) set.add(c);
  }
  return [...set].sort();
}

/**
 * Maps one registry search/info payload onto per-channel versions.
 *
 * The three keys are read independently and a non-string becomes null, so a
 * package with nothing on a channel is indistinguishable from a package the
 * payload simply does not mention that channel for — both mean "not published
 * there", which is the only distinction `classify` needs.
 */
export function toVersions(entry: Record<string, unknown>): RegistryVersions {
  const pick = (k: string): string | null =>
    typeof entry[k] === "string" ? entry[k] as string : null;
  return {
    stable: pick("latestVersion"),
    beta: pick("latestBeta"),
    rc: pick("latestRc"),
  };
}

/** Extracts `name -> versions` from a `swamp extension search --json` payload. */
export function indexSearchPayload(
  raw: string,
): Map<string, RegistryVersions> {
  const out = new Map<string, RegistryVersions>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null) return out;
  const exts = (parsed as Record<string, unknown>).extensions;
  if (!Array.isArray(exts)) return out;
  for (const e of exts) {
    if (typeof e !== "object" || e === null) continue;
    const entry = e as Record<string, unknown>;
    if (typeof entry.name !== "string") continue;
    out.set(entry.name, toVersions(entry));
  }
  return out;
}

async function swampJson(args: string[]): Promise<string | null> {
  const { code, stdout } = await new Deno.Command("swamp", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) return null;
  return new TextDecoder().decode(stdout);
}

/**
 * Fetches every published version this repo could care about, in ONE call per
 * collective rather than one per package.
 *
 * Per-package `extension info` was the obvious implementation and is far too
 * slow to run in CI: the swamp binary costs roughly two seconds just to start,
 * so 51 extensions took over two minutes and timed out. Search returns the
 * same `latestVersion`/`latestBeta`/`latestRc` fields for a whole collective at
 * once.
 *
 * Only the DEFAULT (stable) sweep is trusted, and only for its `latestVersion`.
 * Two measured quirks force that, both filed upstream as swamp Lab #1555:
 *
 *  - `--channel` INTERSECTS rather than unions. `--channel stable --channel
 *    beta --channel rc` returned 1 result against this registry where the three
 *    separate sweeps returned 52, 1 and 0.
 *  - A channel-FILTERED search entry carries `latestVersion`, `latestBeta` and
 *    `latestRc` all null. The beta sweep finds @magistr/stripe-mpp but reports
 *    no version for it, while `extension info` on the same package reports
 *    `latestBeta: 2026.08.01.1`. Believing the search payload there would
 *    report a correctly-published beta package as never published — the exact
 *    false alarm this detector must not raise.
 *
 * So: one cheap sweep per collective covers every stable package, and anything
 * it cannot answer falls back to a direct `extension info`. In this repo that
 * is one extra call, not fifty. Once #1555 is fixed the fallback can go.
 */
export async function fetchAllRegistry(
  declared: readonly Declared[],
): Promise<Map<string, RegistryVersions>> {
  const index = new Map<string, RegistryVersions>();
  for (const collective of collectives(declared)) {
    const raw = await swampJson([
      "extension",
      "search",
      "--collective",
      collective,
      "--per-page",
      "100",
      "--json",
    ]);
    if (raw === null) continue;
    for (const [name, versions] of indexSearchPayload(raw)) {
      if (versions.stable === null) continue;
      index.set(name, versions);
    }
  }
  // Direct lookup for everything the stable sweep could not answer: packages on
  // a non-stable channel, and any package absent from search for any reason.
  for (const d of declared) {
    if (d.channel === "stable" && index.has(d.name)) continue;
    const raw = await swampJson(["extension", "info", d.name, "--json"]);
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.error === "string") continue;
      index.set(d.name, toVersions(parsed));
    } catch {
      continue;
    }
  }
  return index;
}

export function parseArgs(args: readonly string[]): { root: string } {
  let root = ".";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") root = args[++i];
  }
  return { root };
}

async function main(): Promise<void> {
  const { root } = parseArgs(Deno.args);
  const declared = await discover(root);
  const index = await fetchAllRegistry(declared);
  const rows: DriftRow[] = declared.map((d) =>
    classify(d, index.get(d.name) ?? null)
  );
  console.log(formatReport(rows));
  const bad = drifted(rows);
  if (bad.length > 0) {
    for (const r of bad) {
      const got = r.published === null
        ? `nothing on '${r.channel}'`
        : `registry has ${r.published}`;
      console.log(
        `::error file=${r.dir}/manifest.yaml::${r.name} declares ` +
          `${r.declared} but ${got}. The publish for this version never ` +
          `completed. Re-run that version's master CI run, or publish it with ` +
          `\`swamp extension push ${r.dir}/manifest.yaml --channel ${r.channel} ` +
          `--release-notes "$(scripts/changelog-section.sh ${r.dir}/CHANGELOG.md ` +
          `${r.declared})"\`.`,
      );
    }
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
