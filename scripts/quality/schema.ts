/**
 * Single source of truth for the shape of a per-extension quality.yaml (the
 * "Extension Compliance" bounded context's serialized aggregate). Every
 * other module in scripts/quality/ (scaffold, check_compliance,
 * check_allowlist, score_ratchet) imports REQUIRED_SUITES and
 * parseQualityFile from here rather than re-deriving the rule set —
 * STANDARD.md's suite list is asserted equal to REQUIRED_SUITES in
 * schema.test.ts, so the written standard and the enforced schema can never
 * silently drift apart.
 */
import { z } from "npm:zod@4";
import { WatchSourceSchema } from "../lib/watch_schema.ts";

export const SCHEMA_VERSION = 1;

/**
 * The five required test suites, named by ROLE — never by filename
 * convention. Real test file names are heterogeneous across this repo:
 * stripe-mpp uses `stripe_mpp_methods_test.ts`, swamp-go-brr uses co-located
 * `<model>.test.ts`, libvirt uses topical `_test.ts`, comfyui uses
 * `.test.ts`. A suite is "present" iff its quality.yaml entry declares
 * files[] that exist on disk (checked by check_compliance.ts) — never by
 * scanning for a name pattern.
 */
export const REQUIRED_SUITES = [
  "contract-fixture",
  "methods",
  "adversarial",
  "coverage",
  "property-invariant-flow",
] as const;

export type SuiteName = typeof REQUIRED_SUITES[number];

/** Backlog states must cite this Phase D tracking issue so the backfill work
 * is traceable from every quality.yaml that carries debt. */
export const BACKLOG_TRACKING_ISSUE = "ext-quality-test-backfill";

/** A `soak:` block's "backlog" state cites THIS tracking issue instead of
 * BACKLOG_TRACKING_ISSUE — the property-soak-permission-source-of-truth work
 * is Phase B (ext-quality-release-watch-soak), not Phase D's generic test
 * backfill, so debt in this specific block must be traceable to the phase
 * that actually owns it. */
export const SOAK_TRACKING_ISSUE = "ext-quality-release-watch-soak";

const MIN_JUSTIFICATION_LENGTH = 12;

/** `requiredIssue`, when given, is the exact tracking-issue string a
 * "backlog" justification must cite — generalised (rather than a hardcoded
 * boolean toggle for BACKLOG_TRACKING_ISSUE) so a NEW backlog-gated block
 * (e.g. `soak:`) can require its OWN tracking issue instead of blindly
 * reusing Phase D's. Omit for a justification with no required-issue check
 * at all (the "na" states). */
function justificationSchema(requiredIssue?: string) {
  return z.string().superRefine((val, ctx) => {
    const trimmed = val.trim();
    if (trimmed.length < MIN_JUSTIFICATION_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message:
          `justification must be at least ${MIN_JUSTIFICATION_LENGTH} trimmed characters (got ${trimmed.length})`,
      });
    }
    if (requiredIssue && !trimmed.includes(requiredIssue)) {
      ctx.addIssue({
        code: "custom",
        message:
          `backlog justification must cite the tracking issue "${requiredIssue}"`,
      });
    }
  });
}

/** present: backed by real declared files. na: permanently not applicable,
 * justified, no allowlist gating. backlog: temporary debt, justified, valid
 * ONLY while the extension is on quality-allowlist.txt (checked by
 * parseQualityFile via the isAllowlisted option, not by this schema alone —
 * a standalone quality.yaml file has no notion of "the allowlist"). */
const presentState = z.object({
  state: z.literal("present"),
  files: z.array(z.string().min(1)).min(1),
}).strict();

const naState = z.object({
  state: z.literal("na"),
  justification: justificationSchema(),
}).strict();

const backlogState = z.object({
  state: z.literal("backlog"),
  justification: justificationSchema(BACKLOG_TRACKING_ISSUE),
}).strict();

export const SuiteStateSchema = z.discriminatedUnion("state", [
  presentState,
  naState,
  backlogState,
]);

export type SuiteState = z.infer<typeof SuiteStateSchema>;

const suitesShape = Object.fromEntries(
  REQUIRED_SUITES.map((name) => [name, SuiteStateSchema]),
) as Record<SuiteName, typeof SuiteStateSchema>;

const TestsSchema = z.object(suitesShape).strict();

/**
 * watch: block — the `sources[]` union and the present-arm envelope
 * (issueLabel, optional justification) are Phase B's executable contract,
 * imported from scripts/lib/watch_schema.ts so the compliance gate applies
 * the same deep validation the release-watch resolver does. (This resolves
 * Phase A's original TODO: validate here once watch_schema.ts exists.)
 */
const watchPresent = z.object({
  state: z.literal("present"),
  sources: z.array(WatchSourceSchema).min(1),
  issueLabel: z.string().min(1),
  justification: z.string().optional(),
}).strict();

const WatchSchema = z.discriminatedUnion("state", [
  watchPresent,
  naState,
  backlogState,
]);

export type WatchBlock = z.infer<typeof WatchSchema>;

/**
 * canary: block — Phase C's richer live-verification shape. Fixture files
 * live under the `<ext>/fixtures/` convention (documented in STANDARD.md);
 * this schema validates shape only, never that the files exist on disk
 * (that is Phase C's checker to build).
 */
const canaryPresent = z.object({
  state: z.literal("present"),
  instance: z.string().min(1),
  method: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  assert: z.string().min(1).optional(),
  fixture: z.object({
    method: z.string().min(1).optional(),
    redact: z.array(z.string().min(1)),
  }).strict().optional(),
}).strict();

const CanarySchema = z.discriminatedUnion("state", [
  canaryPresent,
  naState,
  backlogState,
]);

export type CanaryBlock = z.infer<typeof CanarySchema>;

/**
 * docs: block — README, CHANGELOG, and bundled-skill score (tessl >= 90),
 * each with the same present/na/backlog envelope.
 */
const DocsItemSchema = z.discriminatedUnion("state", [
  presentState,
  naState,
  backlogState,
]);

const DocsSchema = z.object({
  readme: DocsItemSchema,
  changelog: DocsItemSchema,
  skill: DocsItemSchema,
}).strict();

/**
 * ratchet: block — this extension's recorded quality-score baseline. The
 * score is only comparable within the same rubricVersion (see
 * score_ratchet.ts); a rubric bump requires an explicit rebaseline, never a
 * silent repo-wide fail.
 */
const RatchetSchema = z.object({
  rubricVersion: z.number().int().positive(),
  baselinePercentage: z.number().min(0).max(100),
  label: z.string().min(1),
}).strict();

/**
 * `soak:` block — the property-soak-permission-source-of-truth PR's
 * addition (scripts/lib/soak_permissions.ts). OPTIONAL: every quality.yaml
 * authored before this PR has no `soak:` key at all and must keep
 * validating unchanged, so this is NOT added to QualityFileSchema as a
 * required field (SCHEMA_VERSION is not bumped either — an optional field
 * is a backward-compatible addition). Same present/na/backlog envelope as
 * `watch:`/`canary:`, and — like them — intentionally excluded from
 * `collectStates`/`hasAnyBacklog`: a "backlog" `soak:` block is exempt from
 * allowlist gating, same rationale as `watch:`/`canary:` (every extension's
 * soak override will legitimately be "backlog" until it's hand-authored).
 *
 * `present` carries a plain, non-empty `denoArgs` string array — the exact
 * deno permission flags scripts/run_soak.ts should run the property soak
 * with — rather than `files[]`; there is no file to check for existence
 * here, only an authority comparison against the extension's own `test`
 * task (scripts/lib/soak_permissions.ts's checkSoakAuthority, enforced by
 * scripts/quality/check_soak.ts, not by this schema).
 *
 * `runs` (optional, every state) — the fast-check iteration count
 * scripts/quality/generate_soak_task.ts bakes into the LOCAL `deno task
 * test:soak` entrypoint's `FC_NUM_RUNS=<runs>` prefix. Defaults to
 * DEFAULT_SOAK_RUNS (10000, generate_soak_task.ts's own constant) when
 * omitted. This is DECLARED config, not something the generator parses back
 * out of its own previous output (which would make a hand-tuned "this
 * extension's suite is slow, use a lower nightly-equivalent count" fact
 * unrecoverable the moment the generated string itself changed for any
 * other reason) — see STANDARD.md's `soak:` block section for why only four
 * extensions need it today (herdr/jabber at 2000, jscad-stl-slicer/
 * swamp-go-brr at 5000). Available on `present`, `na`, AND `backlog` alike
 * — unlike `denoArgs`, a custom run count is orthogonal to whether this
 * extension also needs a narrowed permission override: three of the four
 * extensions above (herdr, jabber, jscad-stl-slicer) have no broad test-task
 * grant at all, so their `soak:` block exists ONLY to declare `runs`, with
 * `state: na` (no permission narrowing needed) carrying it. This is why
 * `runs` is declared on soak-SPECIFIC `na`/`backlog` variants below rather
 * than reusing the generic, shared `naState`/`backlogState` — reusing those
 * would leak a soak-only concept onto every OTHER na/backlog block in this
 * file (tests.*, docs.*, watch, canary), none of which has any use for it.
 * Purely additive (like the rest of this `soak:` block — see its own
 * "OPTIONAL" note above): SCHEMA_VERSION is not bumped.
 */
const soakPresentState = z.object({
  state: z.literal("present"),
  denoArgs: z.array(z.string().min(1)).min(1),
  runs: z.number().int().positive().optional(),
}).strict();

const soakNaState = z.object({
  state: z.literal("na"),
  justification: justificationSchema(),
  runs: z.number().int().positive().optional(),
}).strict();

const soakBacklogState = z.object({
  state: z.literal("backlog"),
  justification: justificationSchema(SOAK_TRACKING_ISSUE),
  runs: z.number().int().positive().optional(),
}).strict();

const SoakSchema = z.discriminatedUnion("state", [
  soakPresentState,
  soakNaState,
  soakBacklogState,
]);

export type SoakBlock = z.infer<typeof SoakSchema>;

export const QualityFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  extension: z.string().min(1),
  tests: TestsSchema,
  watch: WatchSchema,
  canary: CanarySchema,
  docs: DocsSchema,
  ratchet: RatchetSchema,
  soak: SoakSchema.optional(),
}).strict();

export type QualityFile = z.infer<typeof QualityFileSchema>;

export interface ParseQualityOptions {
  /** The extension directory / manifest name this file is expected to
   * describe — checked against the `extension` field so a copy-pasted
   * quality.yaml can never silently apply to the wrong extension. */
  expectedExtension: string;
  /** Whether this extension currently appears on quality-allowlist.txt. Any
   * suite/docs-item/watch in "backlog" state is valid ONLY while its
   * extension is allowlisted — backlog eligibility == allowlist membership.
   * "na" states are NEVER gated by this (they are a permanent exemption). */
  isAllowlisted: boolean;
}

export type ParseQualityResult =
  | { ok: true; data: QualityFile }
  | { ok: false; errors: string[] };

/**
 * Every block whose "backlog" state is gated by allowlist membership: the
 * five required suites and the three `docs` items — the parts of the
 * standard THIS phase actually enforces. Exported so check_allowlist.ts's
 * cross-check inspects the EXACT same scope as this module's own
 * backlog-requires-allowlisted rule below — two independent re-derivations
 * of "does this extension carry backlog debt" would be the same
 * single-source-of-truth violation CLAUDE.md rule 4 warns against.
 *
 * `watch` and `canary` are intentionally excluded: Phase A only DECLARES
 * their shape (STANDARD.md is explicit that the workflows themselves are
 * Phase B's and Phase C's to build). Every extension's `watch`/`canary` will
 * legitimately be "backlog" until those phases ship — gating that on the
 * allowlist would force all 48 extensions onto it, including the one
 * (stripe-mpp) the standard is designed to prove can be fully compliant
 * without it.
 */
export function collectStates(
  data: QualityFile,
): Array<{ path: string; state: string }> {
  const out: Array<{ path: string; state: string }> = [];
  for (const suite of REQUIRED_SUITES) {
    out.push({ path: `tests.${suite}`, state: data.tests[suite].state });
  }
  out.push({ path: "docs.readme", state: data.docs.readme.state });
  out.push({ path: "docs.changelog", state: data.docs.changelog.state });
  out.push({ path: "docs.skill", state: data.docs.skill.state });
  return out;
}

/** True iff ANY allowlist-gated block (see `collectStates`) is in "backlog"
 * state — the single definition of "this extension carries backlog debt"
 * shared by `parseQualityFile`'s own gate and `check_allowlist.ts`'s
 * cross-check, so the two can never diverge on what counts as an offender. */
export function hasAnyBacklog(data: QualityFile): boolean {
  return collectStates(data).some(({ state }) => state === "backlog");
}

/**
 * Parse + validate a quality.yaml payload (already YAML-decoded to a plain
 * value). Combines the structural zod schema with the two cross-field
 * business rules that need external context: the extension-name/manifest
 * match, and the backlog-requires-allowlisted invariant.
 */
export function parseQualityFile(
  raw: unknown,
  options: ParseQualityOptions,
): ParseQualityResult {
  const result = QualityFileSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) =>
        `${issue.path.join(".") || "(root)"}: ${issue.message}`
      ),
    };
  }
  const data = result.data;
  const errors: string[] = [];
  if (data.extension !== options.expectedExtension) {
    errors.push(
      `extension: "${data.extension}" does not match expected "${options.expectedExtension}"`,
    );
  }
  if (!options.isAllowlisted) {
    for (const { path, state } of collectStates(data)) {
      if (state === "backlog") {
        errors.push(
          `${path}: state "backlog" is only valid while "${options.expectedExtension}" is on quality-allowlist.txt`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data };
}
