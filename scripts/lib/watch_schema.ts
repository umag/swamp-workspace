/**
 * The single executable contract for the `watch:` block that lives inside
 * each extension's `<ext>/quality.yaml`.
 *
 * APPROVED AMENDMENT (decision 1, ext-quality-release-watch-soak): there is
 * NO standalone `watch.yaml`. Declarations live under each extension's
 * `quality.yaml` `watch:` block:
 *
 *   watch:
 *     state: present | na | backlog
 *     sources: [<WatchSource>, ...]   # required when state=present
 *     issueLabel: string              # required when state=present
 *     justification: string           # required when state=na or backlog
 *
 * `backlog` means "not triaged yet — nothing to watch": scripts/quality/
 * scaffold.ts seeds every newly-scaffolded extension's `watch:` block at
 * `backlog` (it cannot know whether an extension has anything watchable),
 * and 51 of the 52 extensions in this repo are still there. release_watch.ts
 * treats `backlog` exactly like `na` — skipped, not a load error — so the
 * common "not triaged yet" state never breaks the weekly run. It differs
 * from `na` only in connotation (temporary/undecided vs. permanent/decided);
 * both carry a `justification` and neither carries `sources`.
 *
 * Phase A (ext-quality-standard-ci-gate) owns the REST of quality.yaml
 * (schemaVersion, extension name, other CI-gate keys) and treats
 * `watch.sources[]` as an opaque passthrough — THIS module owns the deep
 * validation of the `watch:` block. `loadQualityWatch` therefore parses the
 * whole YAML document loosely and validates only the `watch` key strictly.
 *
 * Four source kinds (WatchSource discriminated union):
 *   - npm             — compare a pin parsed from model source against an
 *                        npm dist-tag (with an optional fallback channel).
 *   - github-release  — compare a recorded baseline tag against the latest
 *                        published (or highest-semver) GitHub release.
 *   - http-fingerprint— compare a baseline sha256 against a normalized,
 *                        selector-scoped hash of a scraped page.
 *   - openapi-hash    — schema-validated here, but the RESOLVER is DEFERRED
 *                        to Phase C (live-canary): Shoko's OpenAPI spec is
 *                        only reachable from the private homelab, not from
 *                        GitHub Actions. See DEFERRED_RESOLVER_KINDS.
 *
 * Every network-reachable URL (http-fingerprint.url, openapi-hash.specUrl) is
 * https-only and SSRF-guarded (assertPublicHttpsUrl): no plain http, no
 * loopback/link-local/private/cloud-metadata hosts, no numeric-IP-obfuscation
 * tricks. This is defense-in-depth over committer-trusted YAML, NOT a hard
 * security boundary — it does not (and cannot, via the built-in `fetch` API)
 * pin DNS resolution against rebinding to an internal address after this
 * check runs. Documented as an accepted residual risk.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { parse as parseYaml } from "jsr:@std/yaml@1";

export class WatchSchemaError extends Error {
  override readonly name = "WatchSchemaError";
}

// ============================================================================
// SSRF guard
// ============================================================================

/** Hostname patterns refused even over https: loopback, link-local (incl. the
 * 169.254.169.254 cloud-metadata endpoint shared by AWS/GCP/Azure/DO), the
 * three RFC 1918 private ranges, IPv6 loopback/link-local/unique-local, and
 * common "internal" naming conventions (metadata.google.internal, *.internal). */
const BLOCKED_HOSTNAME_PATTERNS: RegExp[] = [
  /^localhost$/,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^169\.254\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fe80:/,
  /^fc00:/,
  /^fd00:/,
  /(^|\.)internal$/,
  /^metadata(\.google)?\.internal$/,
];

/** Numeric-IP obfuscation tricks (decimal / hex encodings of an IPv4
 * address) that a naive dotted-quad-only blocklist would miss — reject
 * outright rather than trying to decode and re-check them. */
const SUSPICIOUS_NUMERIC_HOST = /^(0x[0-9a-f]+|\d+)$/;

/**
 * Parse `raw` as a URL and enforce https + the SSRF guard above. Throws
 * {@link WatchSchemaError} (never a raw TypeError/ZodError) so callers get a
 * consistent, descriptive error type.
 */
export function assertPublicHttpsUrl(raw: string, ctx: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WatchSchemaError(
      `${ctx}: not a valid URL: ${JSON.stringify(raw)}`,
    );
  }
  if (url.protocol !== "https:") {
    throw new WatchSchemaError(
      `${ctx}: must be https:, got ${url.protocol} (${raw})`,
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (SUSPICIOUS_NUMERIC_HOST.test(hostname)) {
    throw new WatchSchemaError(
      `${ctx}: numeric-IP-obfuscated hostname refused (SSRF guard): ${hostname}`,
    );
  }
  if (BLOCKED_HOSTNAME_PATTERNS.some((re) => re.test(hostname))) {
    throw new WatchSchemaError(
      `${ctx}: hostname is loopback/link-local/private/metadata — refused (SSRF guard): ${hostname}`,
    );
  }
  return url;
}

function isPublicHttpsUrl(raw: string): boolean {
  try {
    assertPublicHttpsUrl(raw, "url");
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// pin.pattern — must compile AND carry exactly one usable capture group
// ============================================================================

/**
 * True if `pattern` has at least one capturing group (ignoring non-capturing
 * `(?:...)`, lookaheads/lookbehinds `(?=...)`/`(?!...)`/`(?<=...)`/`(?<!...)`,
 * and escaped literal parens `\(`). A resolver needs `match[1]` to exist, so a
 * pattern with none is rejected at schema-parse time rather than failing
 * later inside the resolver.
 */
export function hasCaptureGroup(pattern: string): boolean {
  // A non-capturing group / lookaround starts "(?:" "(?=" "(?!" "(?<=" "(?<!".
  // Anything else starting with "(" — including a named group "(?<name>" — is
  // a real capturing group (named groups are still reachable positionally via
  // match[1], match[2], ... in addition to match.groups.name).
  const NON_CAPTURING = /^\(\?(?::|=|!|<=|<!)/;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 2; // skip the escaped char entirely (e.g. a literal "\(")
      continue;
    }
    if (ch === "(" && !NON_CAPTURING.test(pattern.slice(i))) {
      return true;
    }
    i++;
  }
  return false;
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const PinSourceSchema = z.object({
  from: z.literal("source").describe(
    "The only supported pin strategy in Phase B: parse the pin from a model source file.",
  ),
  file: z.string().min(1).describe(
    "Path to the source file, relative to the extension directory.",
  ),
  pattern: z.string().min(1)
    .refine(isValidRegex, {
      message: "pattern must be a valid regular expression",
    })
    .refine(hasCaptureGroup, {
      message:
        "pattern must contain at least one capture group (the pin value)",
    }),
  required: z.boolean().default(true),
});

// ============================================================================
// WatchSource — four-kind discriminated union
// ============================================================================

const NpmWatchSourceSchema = z.object({
  kind: z.literal("npm"),
  package: z.string().min(1),
  channel: z.string().min(1).default("latest"),
  channelFallback: z.string().min(1).optional(),
  pin: PinSourceSchema,
});

const GithubReleaseWatchSourceSchema = z.object({
  kind: z.literal("github-release"),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be an owner/repo slug"),
  baseline: z.string().min(1),
  match: z.enum(["latest-published", "highest-semver"]).default(
    "latest-published",
  ),
  includePrerelease: z.boolean().default(false),
});

const HttpFingerprintWatchSourceSchema = z.object({
  kind: z.literal("http-fingerprint"),
  url: z.string().url().refine(isPublicHttpsUrl, {
    message: "url must be https and not loopback/link-local/private/metadata",
  }),
  selector: z.string().min(1).optional(),
  baselineSha256: z.string().regex(
    /^[0-9a-f]{64}$/i,
    "must be a sha256 hex digest",
  ),
});

const OpenapiHashWatchSourceSchema = z.object({
  kind: z.literal("openapi-hash"),
  specUrl: z.string().url().refine(isPublicHttpsUrl, {
    message:
      "specUrl must be https and not loopback/link-local/private/metadata",
  }),
  baselineSha256: z.string().regex(
    /^[0-9a-f]{64}$/i,
    "must be a sha256 hex digest",
  ),
});

export const WatchSourceSchema = z.discriminatedUnion("kind", [
  NpmWatchSourceSchema,
  GithubReleaseWatchSourceSchema,
  HttpFingerprintWatchSourceSchema,
  OpenapiHashWatchSourceSchema,
]);

export type NpmWatchSource = z.infer<typeof NpmWatchSourceSchema>;
export type GithubReleaseWatchSource = z.infer<
  typeof GithubReleaseWatchSourceSchema
>;
export type HttpFingerprintWatchSource = z.infer<
  typeof HttpFingerprintWatchSourceSchema
>;
export type OpenapiHashWatchSource = z.infer<
  typeof OpenapiHashWatchSourceSchema
>;
export type WatchSource = z.infer<typeof WatchSourceSchema>;
export type WatchSourceKind = WatchSource["kind"];

/** Kinds whose resolver is validated here but implemented in a later phase.
 * openapi-hash: Shoko's OpenAPI spec is only reachable from the private
 * homelab, not from a GitHub Actions runner — see Phase C (live-canary). */
export const DEFERRED_RESOLVER_KINDS: ReadonlySet<WatchSourceKind> = new Set([
  "openapi-hash",
]);

export function isResolverDeferred(kind: WatchSourceKind): boolean {
  return DEFERRED_RESOLVER_KINDS.has(kind);
}

// ============================================================================
// WatchDeclaration — the `watch:` block itself
// ============================================================================

export const WatchDeclarationSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("na"),
    justification: z.string().min(1),
  }),
  z.object({
    state: z.literal("backlog"),
    justification: z.string().min(1),
  }),
  z.object({
    state: z.literal("present"),
    sources: z.array(WatchSourceSchema).min(1),
    issueLabel: z.string().min(1),
    justification: z.string().optional(),
  }),
]);

export type WatchDeclaration = z.infer<typeof WatchDeclarationSchema>;

/** Parse a raw (already YAML-decoded) `watch:` value. Throws
 * {@link WatchSchemaError} — never a raw ZodError — with the zod issues
 * flattened into the message for a readable CI failure. */
export function parseWatchDeclaration(raw: unknown): WatchDeclaration {
  const result = WatchDeclarationSchema.safeParse(raw);
  if (!result.success) {
    throw new WatchSchemaError(
      `invalid watch: block — ${
        result.error.issues.map((i) =>
          `${i.path.join(".") || "(root)"}: ${i.message}`
        ).join("; ")
      }`,
    );
  }
  return result.data;
}

/**
 * Read `<ext>/quality.yaml` at `path`, extract the `watch:` key, and validate
 * it. The rest of the document (schemaVersion, extension name, other Phase-A
 * CI-gate keys) is intentionally NOT validated here — Phase A owns that
 * shape; this module only owns `watch:`.
 */
export async function loadQualityWatch(
  path: string,
  readFile: (p: string) => Promise<string> = Deno.readTextFile,
): Promise<WatchDeclaration> {
  const raw = await readFile(path);
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (e) {
    throw new WatchSchemaError(
      `${path}: not valid YAML — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (doc === null || typeof doc !== "object" || !("watch" in doc)) {
    throw new WatchSchemaError(
      `${path}: missing required top-level "watch:" key`,
    );
  }
  const watch = (doc as Record<string, unknown>).watch;
  try {
    return parseWatchDeclaration(watch);
  } catch (e) {
    if (e instanceof WatchSchemaError) {
      throw new WatchSchemaError(`${path}: ${e.message}`);
    }
    throw e;
  }
}
