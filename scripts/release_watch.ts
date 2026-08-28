/**
 * Generic weekly release-watch resolver.
 *
 * Reads every top-level extension directory's `quality.yaml` `watch:` block
 * (see scripts/lib/watch_schema.ts — the executable contract) and compares
 * each declared source's pinned/baseline reference against the live
 * upstream. Every upstream HTTP response is treated as UNTRUSTED input:
 * fetched with a bounded `AbortSignal.timeout`, `safeParse`d, and any
 * 5xx / network failure / malformed shape resolves to `"unreachable"` — a
 * transient outage must NEVER be reported as drift.
 *
 * Kinds implemented here (Actions-reachable): npm, github-release,
 * http-fingerprint. `openapi-hash` is schema-validated (see watch_schema.ts)
 * but its resolver is DEFERRED to Phase C (live-canary) — Shoko's spec is
 * only reachable from the private homelab — so it always resolves to
 * `"deferred"` without ever fetching.
 *
 * Pin extraction reads model source with `Deno.readTextFile` — NEVER shells
 * out to `grep` — because a plain (non `-a`) `grep` silently treats a source
 * file containing a stray control byte + multibyte UTF-8 as binary and
 * returns zero matches (the 2026-07-13 incident; regression-fixtured in
 * release_watch_test.ts).
 *
 * Security note for the consuming workflow (.github/workflows/release-watch.yml):
 * every upstream-derived string (release tag/name, scraped page content,
 * package metadata) must reach GitHub Actions steps ONLY via this script's
 * JSON report file — never via `${{ }}` interpolation into a `run:` shell
 * script or a hand-built shell/JS string. See that workflow for the
 * `actions/github-script` step that reads the report from disk.
 *
 * @module
 */
import { join } from "jsr:@std/path@1";
import type {
  GithubReleaseWatchSource,
  HttpFingerprintWatchSource,
  NpmWatchSource,
  OpenapiHashWatchSource,
  WatchDeclaration,
  WatchSource,
} from "./lib/watch_schema.ts";
import { assertPublicHttpsUrl, loadQualityWatch } from "./lib/watch_schema.ts";

export type SourceStatus =
  | "ok"
  | "drift"
  | "unreachable"
  | "deferred"
  | "skipped";

export interface SourceResult {
  readonly source: WatchSource;
  readonly status: SourceStatus;
  readonly detail: string;
}

export interface ExtensionDriftReport {
  readonly extension: string;
  readonly issueLabel: string;
  readonly issueTitle: string;
  readonly hasDrift: boolean;
  readonly results: SourceResult[];
  readonly justification?: string;
  /** Set when this extension's quality.yaml could not be loaded/validated at
   * all (malformed YAML, invalid watch: block, an unexpectedly-thrown source
   * error). buildDriftReports ISOLATES this per extension — one broken
   * quality.yaml must never abort the run for the other 47+ extensions. Never
   * raises a GitHub issue on its own (that's Phase A/ci.yml's job at PR time);
   * main() surfaces it as a warning and a non-zero exit so it stays visible. */
  readonly loadError?: string;
}

export interface ResolveOpts {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Optional GitHub token to raise the unauthenticated 60/hour rate limit
   * to 5000/hour for github-release sources. Not needed for npm/http-fingerprint. */
  readonly githubToken?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** The single source of truth for the stable per-extension issue title —
 * shared by the JSON report so the workflow's github-script step never needs
 * to reimplement this naming convention. */
export function issueTitleFor(extension: string): string {
  return `${extension}: upstream release drift`;
}

// ============================================================================
// Pin extraction — Deno.readTextFile ONLY, never shell grep (see @module doc)
// ============================================================================

/**
 * Read `file` and extract `pattern`'s first capture group.
 * - `required=true` + no match  → throws (this is OUR bug: a stale pattern or
 *   moved import, not an upstream signal — fail the run loud, matching the
 *   old bash workflow's `::error::… pin not found`).
 * - `required=false` + no match → returns `undefined` (an optional pin, e.g.
 *   the link-cli global default, that simply isn't present yet).
 */
export async function parsePinFromSource(
  file: string,
  pattern: string,
  required: boolean,
  readFile: (p: string) => Promise<string> = Deno.readTextFile,
): Promise<string | undefined> {
  const text = await readFile(file);
  const match = new RegExp(pattern).exec(text);
  const pin = match?.[1];
  if (pin === undefined && required) {
    throw new Error(
      `${file}: pattern ${
        JSON.stringify(pattern)
      } did not match (required pin)`,
    );
  }
  return pin;
}

// ============================================================================
// sha256 helper (WebCrypto — available in Deno without extra permissions)
// ============================================================================

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================================
// npm
// ============================================================================

interface DistTagsShape {
  "dist-tags": Record<string, string>;
}
/** Untrusted-input guard for the npm registry response — no zod schema
 * needed for a single well-known shape, but still fully validated before use. */
function parseDistTags(v: unknown): DistTagsShape | undefined {
  if (
    v && typeof v === "object" && "dist-tags" in v &&
    typeof (v as Record<string, unknown>)["dist-tags"] === "object" &&
    (v as Record<string, unknown>)["dist-tags"] !== null
  ) {
    const tags = (v as Record<string, unknown>)["dist-tags"] as Record<
      string,
      unknown
    >;
    const allStrings = Object.values(tags).every((x) => typeof x === "string");
    if (allStrings) return v as DistTagsShape;
  }
  return undefined;
}

export async function resolveNpmSource(
  source: NpmWatchSource,
  opts: ResolveOpts = {},
): Promise<SourceResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const pin = await parsePinFromSource(
    source.pin.file,
    source.pin.pattern,
    source.pin.required,
  );
  if (pin === undefined) {
    return {
      source,
      status: "skipped",
      detail:
        `optional pin not present in ${source.pin.file} — nothing to compare`,
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(source.package)}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (e) {
    return {
      source,
      status: "unreachable",
      detail: `npm registry fetch failed for ${source.package}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  if (!res.ok) {
    return {
      source,
      status: "unreachable",
      detail: `npm registry returned HTTP ${res.status} for ${source.package}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      source,
      status: "unreachable",
      detail: `npm registry returned malformed JSON for ${source.package}`,
    };
  }
  const parsed = parseDistTags(body);
  if (!parsed) {
    return {
      source,
      status: "unreachable",
      detail:
        `npm registry response for ${source.package} did not match the expected dist-tags shape`,
    };
  }

  const tags = parsed["dist-tags"];
  const target = tags[source.channel] ??
    (source.channelFallback ? tags[source.channelFallback] : undefined);
  if (target === undefined) {
    const triedChannels = source.channelFallback
      ? `${source.channel} or ${source.channelFallback}`
      : source.channel;
    return {
      source,
      status: "unreachable",
      detail:
        `npm registry for ${source.package} has no "${triedChannels}" dist-tag`,
    };
  }

  if (pin !== target) {
    return {
      source,
      status: "drift",
      detail: `${source.package}: pinned ${pin}, upstream ${target}`,
    };
  }
  return {
    source,
    status: "ok",
    detail: `${source.package}: pinned ${pin} matches upstream`,
  };
}

// ============================================================================
// github-release
// ============================================================================

interface GithubReleaseShape {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  created_at: string;
}

function isGithubReleaseShape(item: unknown): item is GithubReleaseShape {
  return !!item && typeof item === "object" &&
    typeof (item as Record<string, unknown>).tag_name === "string" &&
    typeof (item as Record<string, unknown>).prerelease === "boolean" &&
    typeof (item as Record<string, unknown>).draft === "boolean" &&
    typeof (item as Record<string, unknown>).created_at === "string";
}

function safeParseGithubRelease(v: unknown): GithubReleaseShape | undefined {
  return isGithubReleaseShape(v) ? v : undefined;
}

function safeParseGithubReleases(v: unknown): GithubReleaseShape[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: GithubReleaseShape[] = [];
  for (const item of v) {
    if (isGithubReleaseShape(item)) {
      out.push(item);
    } else {
      return undefined; // one malformed entry taints the whole untrusted response
    }
  }
  return out;
}

/** Parse a `vMAJOR.MINOR.PATCH`-ish tag into a comparable numeric tuple.
 * Non-numeric trailing segments (e.g. "-rc1") are ignored for comparison
 * purposes — this is a pragmatic ordering, not a full semver implementation. */
function semverTuple(tag: string): number[] {
  const cleaned = tag.replace(/^v/i, "");
  return cleaned.split(".").map((seg) => {
    const n = parseInt(seg, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

function compareSemver(a: string, b: string): number {
  const ta = semverTuple(a);
  const tb = semverTuple(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const diff = (ta[i] ?? 0) - (tb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** GitHub's unauthenticated rate limit is 60 req/hour/IP; pass `githubToken`
 * (e.g. the workflow's `GITHUB_TOKEN`) to raise that to 5000/hour. */
function githubHeaders(opts: ResolveOpts): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (opts.githubToken) headers.Authorization = `Bearer ${opts.githubToken}`;
  return headers;
}

type GithubFetchResult =
  | { ok: true; releases: GithubReleaseShape[] }
  | { ok: false; result: SourceResult };

/** The common case: `match=latest-published` + `includePrerelease=false`.
 * Uses GET /repos/{repo}/releases/latest, which by API contract already
 * excludes prereleases/drafts and returns a SINGLE object — no pagination
 * concern at all. A 404 means the repo has no stable release yet (e.g. it
 * only ever publishes prereleases) — that's `"unreachable"`, not drift. */
async function fetchLatestRelease(
  source: GithubReleaseWatchSource,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  opts: ResolveOpts,
): Promise<GithubFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(
      `https://api.github.com/repos/${source.repo}/releases/latest`,
      { signal: AbortSignal.timeout(timeoutMs), headers: githubHeaders(opts) },
    );
  } catch (e) {
    return {
      ok: false,
      result: {
        source,
        status: "unreachable",
        detail: `GitHub releases/latest fetch failed for ${source.repo}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      result: {
        source,
        status: "unreachable",
        detail:
          `${source.repo} has no stable (non-prerelease/non-draft) release published yet`,
      },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      result: {
        source,
        status: "unreachable",
        detail:
          `GitHub API returned HTTP ${res.status} for ${source.repo}/releases/latest`,
      },
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      result: {
        source,
        status: "unreachable",
        detail:
          `GitHub API returned malformed JSON for ${source.repo}/releases/latest`,
      },
    };
  }
  const release = safeParseGithubRelease(body);
  if (!release) {
    return {
      ok: false,
      result: {
        source,
        status: "unreachable",
        detail:
          `GitHub API response for ${source.repo}/releases/latest did not match the expected release shape`,
      },
    };
  }
  return { ok: true, releases: [release] };
}

const GITHUB_LIST_PAGE_SIZE = 100;
/** Bounded pagination cap: `includePrerelease=true` or `match=highest-semver`
 * need to enumerate multiple releases. 3 pages (300 releases) is a pragmatic
 * bound, not a completeness guarantee — a repo with >300 consecutive
 * eligible releases before the one being compared is a residual, documented
 * gap (see scripts/README.md). */
const GITHUB_LIST_MAX_PAGES = 3;

async function fetchReleaseList(
  source: GithubReleaseWatchSource,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  opts: ResolveOpts,
): Promise<GithubFetchResult> {
  const collected: GithubReleaseShape[] = [];
  for (let page = 1; page <= GITHUB_LIST_MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchImpl(
        `https://api.github.com/repos/${source.repo}/releases?per_page=${GITHUB_LIST_PAGE_SIZE}&page=${page}`,
        {
          signal: AbortSignal.timeout(timeoutMs),
          headers: githubHeaders(opts),
        },
      );
    } catch (e) {
      if (page === 1) {
        return {
          ok: false,
          result: {
            source,
            status: "unreachable",
            detail: `GitHub releases fetch failed for ${source.repo}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          },
        };
      }
      break; // a later page failing transiently doesn't discard what we have
    }
    if (!res.ok) {
      if (page === 1) {
        return {
          ok: false,
          result: {
            source,
            status: "unreachable",
            detail: `GitHub API returned HTTP ${res.status} for ${source.repo}`,
          },
        };
      }
      break;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (page === 1) {
        return {
          ok: false,
          result: {
            source,
            status: "unreachable",
            detail: `GitHub API returned malformed JSON for ${source.repo}`,
          },
        };
      }
      break;
    }
    const releases = safeParseGithubReleases(body);
    if (releases === undefined) {
      if (page === 1) {
        return {
          ok: false,
          result: {
            source,
            status: "unreachable",
            detail:
              `GitHub API response for ${source.repo} did not match the expected releases shape`,
          },
        };
      }
      break;
    }
    collected.push(...releases);
    if (releases.length < GITHUB_LIST_PAGE_SIZE) break; // short page — done
  }
  return { ok: true, releases: collected };
}

export async function resolveGithubReleaseSource(
  source: GithubReleaseWatchSource,
  opts: ResolveOpts = {},
): Promise<SourceResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const useLatestEndpoint = source.match === "latest-published" &&
    !source.includePrerelease;
  const fetched = useLatestEndpoint
    ? await fetchLatestRelease(source, fetchImpl, timeoutMs, opts)
    : await fetchReleaseList(source, fetchImpl, timeoutMs, opts);
  if (!fetched.ok) return fetched.result;

  const eligible = useLatestEndpoint
    ? fetched.releases // /releases/latest already excludes prerelease/draft
    : fetched.releases.filter((r) =>
      !r.draft && (source.includePrerelease || !r.prerelease)
    );
  if (eligible.length === 0) {
    return {
      source,
      status: "unreachable",
      detail: `${source.repo} has no eligible (non-draft) releases`,
    };
  }

  const latest = source.match === "highest-semver"
    ? eligible.reduce((
      a,
      b,
    ) => (compareSemver(b.tag_name, a.tag_name) > 0 ? b : a))
    : [...eligible].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  if (latest.tag_name !== source.baseline) {
    return {
      source,
      status: "drift",
      detail:
        `${source.repo}: baseline ${source.baseline}, latest ${latest.tag_name}`,
    };
  }
  return {
    source,
    status: "ok",
    detail: `${source.repo}: baseline ${source.baseline} matches latest`,
  };
}

// ============================================================================
// http-fingerprint
// ============================================================================

/** Best-effort, dependency-free normalization: strip tags, collapse
 * whitespace. When `selector` is an `#id` or `.class` and it does NOT appear
 * in the page, resolution is `"unreachable"` (the page structure changed
 * under us) rather than silently hashing the whole page and risking a false
 * "drift" from unrelated content (ads, counters) elsewhere on the page. */
export function extractFingerprintText(
  html: string,
  selector?: string,
): string | undefined {
  if (!selector) {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  const isId = selector.startsWith("#");
  const isClass = selector.startsWith(".");
  if (!isId && !isClass) {
    // Unsupported selector syntax — treated the same as "not found" so the
    // caller reports unreachable rather than guessing.
    return undefined;
  }
  const name = selector.slice(1);
  const attrPattern = isId
    ? new RegExp(`<([a-zA-Z0-9]+)[^>]*\\bid=["']${name}["'][^>]*>`)
    : new RegExp(
      `<([a-zA-Z0-9]+)[^>]*\\bclass=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>`,
    );
  const openMatch = attrPattern.exec(html);
  if (!openMatch) return undefined;
  const tag = openMatch[1];
  const startIdx = openMatch.index + openMatch[0].length;
  const closeTag = `</${tag}>`;
  const endIdx = html.indexOf(closeTag, startIdx);
  const inner = endIdx === -1
    ? html.slice(startIdx)
    : html.slice(startIdx, endIdx);
  return inner.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export async function resolveHttpFingerprintSource(
  source: HttpFingerprintWatchSource,
  opts: ResolveOpts = {},
): Promise<SourceResult> {
  // Defense in depth: the SSRF guard already ran once at quality.yaml
  // schema-parse time (watch_schema.ts), but this resolver is also directly
  // callable (unit tests do exactly that). Re-enforcing it here means a
  // caller that ever constructs a WatchSource without going through the
  // schema — a bug elsewhere in the pipeline — still can't reach an
  // internal/metadata host. Throws (rather than "unreachable") because this
  // signals OUR OWN code is broken, not a transient upstream condition.
  assertPublicHttpsUrl(source.url, "http-fingerprint.url");

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetchImpl(source.url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return {
      source,
      status: "unreachable",
      detail: `fetch failed for ${source.url}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  if (!res.ok) {
    return {
      source,
      status: "unreachable",
      detail: `HTTP ${res.status} fetching ${source.url}`,
    };
  }

  const html = await res.text();
  const scoped = extractFingerprintText(html, source.selector);
  if (scoped === undefined) {
    return {
      source,
      status: "unreachable",
      detail:
        `selector ${source.selector} no longer matches ${source.url} — page structure changed`,
    };
  }

  const hash = await sha256Hex(scoped);
  if (hash !== source.baselineSha256.toLowerCase()) {
    return {
      source,
      status: "drift",
      detail:
        `${source.url}: fingerprint changed (baseline ${source.baselineSha256})`,
    };
  }
  return {
    source,
    status: "ok",
    detail: `${source.url}: fingerprint matches baseline`,
  };
}

// ============================================================================
// openapi-hash — schema-validated, resolver DEFERRED to Phase C
// ============================================================================

// deno-lint-ignore require-await
export async function resolveOpenapiHashSource(
  source: OpenapiHashWatchSource,
  _opts: ResolveOpts = {},
): Promise<SourceResult> {
  // Defense in depth (see resolveHttpFingerprintSource) — never fetches in
  // Phase B, but still re-validates the SSRF guard so a directly-constructed
  // WatchSource can't smuggle a disallowed host through unnoticed ahead of
  // the Phase C resolver being implemented against this same source shape.
  assertPublicHttpsUrl(source.specUrl, "openapi-hash.specUrl");
  return {
    source,
    status: "deferred",
    detail:
      `openapi-hash resolver deferred to Phase C (live-canary) — ${source.specUrl} is only reachable from the private homelab`,
  };
}

// ============================================================================
// Per-extension aggregation
// ============================================================================

/** Resolve every source in `declaration` for `extension`. `opts.extensionDir`,
 * when given, is joined onto each npm source's `pin.file` (quality.yaml
 * paths are relative to the extension's own directory); omit it when `file`
 * is already absolute (as the unit tests above do). */
export async function resolveExtensionWatch(
  extension: string,
  declaration: WatchDeclaration,
  opts: ResolveOpts & { extensionDir?: string } = {},
): Promise<ExtensionDriftReport> {
  const issueTitle = issueTitleFor(extension);
  // "backlog" (not triaged yet — nothing to watch) is treated exactly like
  // "na" (permanently not applicable): skipped, no sources to resolve, never
  // a load error. See watch_schema.ts's WatchDeclarationSchema doc for why
  // the two states exist separately despite behaving identically here.
  if (declaration.state === "na" || declaration.state === "backlog") {
    return {
      extension,
      issueLabel: "",
      issueTitle,
      hasDrift: false,
      results: [],
      justification: declaration.justification,
    };
  }

  const results: SourceResult[] = [];
  for (const source of declaration.sources) {
    if (source.kind === "npm") {
      const resolvedFile = opts.extensionDir
        ? join(opts.extensionDir, source.pin.file)
        : source.pin.file;
      const withResolvedFile: NpmWatchSource = {
        ...source,
        pin: { ...source.pin, file: resolvedFile },
      };
      results.push(await resolveNpmSource(withResolvedFile, opts));
    } else if (source.kind === "github-release") {
      results.push(await resolveGithubReleaseSource(source, opts));
    } else if (source.kind === "http-fingerprint") {
      results.push(await resolveHttpFingerprintSource(source, opts));
    } else {
      results.push(await resolveOpenapiHashSource(source, opts));
    }
  }

  return {
    extension,
    issueLabel: declaration.issueLabel,
    issueTitle,
    hasDrift: results.some((r) => r.status === "drift"),
    results,
  };
}

// ============================================================================
// Discovery + top-level orchestration
// ============================================================================

/** Every top-level directory under `root` that has its own `quality.yaml`.
 * Extensions that haven't migrated onto the Phase A schema yet are simply
 * absent from the result — forward-compatible as Phase A backfills them. */
export async function discoverExtensionsWithQuality(
  root: string,
): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    try {
      const stat = await Deno.stat(join(root, entry.name, "quality.yaml"));
      if (stat.isFile) found.push(entry.name);
    } catch {
      // no quality.yaml in this extension yet — skip
    }
  }
  return found.sort();
}

export async function buildDriftReports(
  root: string,
  opts: ResolveOpts = {},
): Promise<ExtensionDriftReport[]> {
  const extensions = await discoverExtensionsWithQuality(root);
  const reports: ExtensionDriftReport[] = [];
  for (const extension of extensions) {
    const extensionDir = join(root, extension);
    // Per-extension error isolation: a malformed quality.yaml (or any other
    // unexpected failure) for ONE extension must not abort release-watch for
    // the other 47+. Catch here — not deeper in the pipeline — so genuine
    // upstream-resolution failures (which already return "unreachable"
    // results, never throw) are unaffected by this boundary.
    try {
      const declaration = await loadQualityWatch(
        join(extensionDir, "quality.yaml"),
      );
      reports.push(
        await resolveExtensionWatch(extension, declaration, {
          ...opts,
          extensionDir,
        }),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`release-watch: skipping ${extension} — ${message}`);
      reports.push({
        extension,
        issueLabel: "",
        issueTitle: issueTitleFor(extension),
        hasDrift: false,
        results: [],
        loadError: message,
      });
    }
  }
  return reports;
}

// ============================================================================
// CLI entrypoint
// ============================================================================

function parseArgs(args: string[]): { root: string; out?: string } {
  let root = ".";
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") root = args[++i];
    else if (args[i] === "--out") out = args[++i];
  }
  return { root, out };
}

/**
 * The whole run, minus argv/env parsing: resolve every extension's watch
 * declaration, write (or print) the JSON report, and log a summary. Kept
 * separate from `main()` so tests can drive it directly with a fake `fetch`
 * — a `deno run` subprocess can't inject one — and assert on the returned
 * report set rather than on process exit code + stdout scraping.
 *
 * Never calls `Deno.exit` itself: a per-extension `loadError` (malformed
 * quality.yaml) is isolated by `buildDriftReports` and must NOT fail the
 * run — see the comment at the `main()` call site below for why. A genuine
 * crash (unreadable `root`, a rethrown non-isolated error) propagates as a
 * normal rejection, which is exactly what should abort the process.
 */
export async function runReleaseWatch(
  root: string,
  out: string | undefined,
  opts: ResolveOpts = {},
): Promise<ExtensionDriftReport[]> {
  const reports = await buildDriftReports(root, opts);
  const json = JSON.stringify(
    { generatedAt: new Date().toISOString(), extensions: reports },
    null,
    2,
  );
  if (out) {
    await Deno.writeTextFile(out, json + "\n");
  } else {
    console.log(json);
  }
  const drifted = reports.filter((r) => r.hasDrift);
  const unreachable = reports.flatMap((r) =>
    r.results.filter((s) => s.status === "unreachable")
  );
  const loadErrors = reports.filter((r) => r.loadError !== undefined);
  console.log(
    `release-watch: ${reports.length} extension(s) checked, ${drifted.length} drifted, ${unreachable.length} source(s) unreachable, ${loadErrors.length} quality.yaml load error(s)`,
  );
  for (const u of unreachable) {
    console.warn(`  warning: ${u.detail}`);
  }
  for (const r of loadErrors) {
    console.error(`  error: ${r.extension}: ${r.loadError}`);
  }
  return reports;
}

async function main(): Promise<void> {
  const { root, out } = parseArgs(Deno.args);
  const githubToken = Deno.env.get("GITHUB_TOKEN");
  await runReleaseWatch(root, out, { githubToken });
  // Every extension with a broken quality.yaml is isolated by
  // buildDriftReports and surfaced above as a `loadError` — printed as an
  // error and present in the report JSON's `loadError` field, but NOT fatal.
  // A malformed quality.yaml is Phase A/ci.yml's concern at PR time (that CI
  // gate already blocks the PR that introduced it); by the time
  // release-watch runs against `main`, failing the whole job here would
  // stop it from reaching the "Raise or update per-extension drift issues"
  // step in release-watch.yml (a GitHub Actions step with no `if:` guard is
  // skipped when the previous step fails) — silently discarding every OTHER
  // extension's real, detected drift along with it. Detection already
  // isolates the failure; exiting non-zero here would only block reporting
  // it. A genuine crash (unreadable `root`, bad CLI args, or any error NOT
  // isolated per-extension) still propagates out of runReleaseWatch as an
  // uncaught rejection, which Deno reports and exits non-zero for on its
  // own — no explicit Deno.exit needed for that case either.
}

if (import.meta.main) {
  await main();
}
