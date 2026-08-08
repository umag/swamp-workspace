/**
 * Single source of truth for reasoning about deno CLI permission flags
 * across the property-soak pipeline. scripts/soak_schedule.ts (emission),
 * scripts/run_soak.ts (execution), and scripts/quality/check_soak.ts
 * (PR-time enforcement) all import this module so the three can never
 * disagree about what a "legitimate narrowing" of a test task's authority
 * looks like.
 *
 * The defect this module fixes: .github/workflows/property-soak.yml used to
 * hardcode `deno test --allow-env=FC_NUM_RUNS "<file>"` for EVERY soaked
 * extension, ignoring each extension's own deno.json `test` task — the
 * permission set ci.yml's deno-check job actually runs under. 24 of 51
 * extensions need strictly more (extra --allow-read/--allow-write scopes,
 * extra --allow-env vars, --allow-net, --allow-all) and were therefore
 * NotCapable-failing every time the rotation reached them.
 *
 * The fix's premise: the extension's own `test` task IS the source of
 * authority. A `quality.yaml` `soak:` override is a RARE, human-reviewed
 * NARROWING of that authority — never a way to grant more. Every validator
 * below RETURNS Violation[] and never throws: a raw throw in an unattended
 * nightly soak is exactly the failure mode this whole design exists to
 * avoid (see run_soak.ts, the one deliberate exception, for the
 * last-moment backstop).
 *
 * A same-kind --allow-X/--deny-X flag repeated across multiple tokens is
 * UNIONED (mergeScope), matching deno's real CLI semantics — never
 * last-occurrence-wins (see mergeScope's docblock for the exact, empirically
 * verified merge rule, including the counterintuitive bare-vs-scoped case).
 * `-A` is recognized as deno's shorthand for `--allow-all`. isBroadGrant
 * additionally treats unscoped --allow-ffi/--allow-sys as broad, alongside
 * --allow-run/--allow-net. validateNoDuplicateHardRejectFlags's hard-reject
 * kind set is net/env/run/sys (read/write/ffi union instead — see that
 * validator's docblock); validateNoAllowAllWithOtherAllowFlags catches the
 * separate --allow-all-plus-any-other-allow-X hard-reject class.
 *
 * A SEPARATE, second defect this module fixes: parsePermissionSet only ever
 * keeps --allow-X/--deny-X tokens — every other "--"-prefixed token used to
 * be dropped by construction, including RUNTIME flags like
 * --v8-flags=--expose-gc that a `test` task needs for correctness (seanime's
 * and seadex's heap-pin regression tests silently skipped every nightly soak
 * run as a result). deriveSoakArgsFromTestTask carries recognized runtime
 * flags (--v8-flags/--unstable-*) through ahead of the permission flags, and
 * validateNoUnknownFlags makes the underlying "unrecognized token silently
 * vanishes" failure mode impossible to repeat: any "--"-prefixed token that
 * is neither a permission flag, a recognized runtime flag, nor on the
 * explicitly-reviewed DELIBERATELY_DROPPED_FLAG_KINDS list is a VIOLATION,
 * never a silent drop. See the RuntimeFlagSet section below.
 */

export interface ParsedPermissionSet {
  readonly allowAll: boolean;
  readonly allow: Map<string, string[] | null>;
  readonly deny: Map<string, string[] | null>;
}

export interface Violation {
  readonly rule: string;
  readonly what: string;
  readonly why: string;
  readonly fix: string;
}

// ============================================================================
// parsePermissionSet
// ============================================================================

const ALLOW_FLAG = /^--allow-([a-z]+)(?:=(.*))?$/;
const DENY_FLAG = /^--deny-([a-z]+)(?:=(.*))?$/;

function parseScope(scopeStr: string | undefined): string[] | null {
  if (scopeStr === undefined) return null;
  return scopeStr.split(",").filter((s) => s.length > 0);
}

/**
 * Merges one more occurrence's scope into a same-kind flag's accumulated
 * scope, matching deno's REAL CLI behavior for a repeated --allow-X/--deny-X
 * flag — empirically verified against deno 2.7.13 (the same major/minor
 * family as the 2.8.3 pinned in these workflows):
 *
 *   deno run --allow-read=/tmp --allow-read=/var f.ts   -> BOTH granted
 *     (disjoint scopes union: {"/tmp","/var"})
 *   deno run --allow-read --allow-read=/tmp f.ts        -> ONLY /tmp granted
 *   deno run --allow-read=/tmp --allow-read f.ts         -> ONLY /tmp granted
 *
 * The second and third lines are the counterintuitive part: a BARE
 * (unscoped) occurrence does NOT subsume a scoped one, in EITHER order —
 * deno's clap-based parser accumulates scope VALUES across every occurrence
 * into a single list (a bare occurrence contributes zero values); only when
 * that accumulated list is empty (i.e. every occurrence was bare) does the
 * flag mean "grant everything". So `null` (bare) is the merge identity, not
 * an absorbing "wins over everything" element — the opposite of what it
 * would be if unscoped really did subsume scoped. See
 * soak_permissions.test.ts's "Deno union semantics" tests for the fixtures
 * this was verified against (including deny-write, which follows the same
 * rule).
 */
function mergeScope(
  existing: string[] | null | undefined,
  incoming: string[] | null,
): string[] | null {
  if (existing === undefined) return incoming;
  if (existing === null && incoming === null) return null;
  const merged = [...(existing ?? [])];
  for (const s of incoming ?? []) {
    if (!merged.includes(s)) merged.push(s);
  }
  return merged;
}

/**
 * Parse a raw `test` task string (or any space-separated sequence of deno
 * CLI tokens) into a structured PermissionSet, keeping ONLY --allow-x and
 * --deny-x tokens. Everything else — "deno", "test", --permit-no-files,
 * --ignore=... (even with embedded commas), and positional paths (in any
 * position, before or after the flags) — is dropped by construction: it
 * simply never matches the --allow-x / --deny-x shape.
 *
 * A same-kind flag repeated across multiple tokens is UNIONED via
 * mergeScope (see its docblock), matching deno's real CLI semantics —
 * NEVER last-occurrence-wins. `-A` is recognized as deno's shorthand alias
 * for `--allow-all` (verified: `deno run -A` grants everything, identically
 * to `--allow-all`).
 */
export function parsePermissionSet(task: string): ParsedPermissionSet {
  const allow = new Map<string, string[] | null>();
  const deny = new Map<string, string[] | null>();
  let allowAll = false;

  const tokens = task.split(/\s+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    if (token === "--allow-all" || token === "-A") {
      allowAll = true;
      continue;
    }
    const allowMatch = token.match(ALLOW_FLAG);
    if (allowMatch) {
      const kind = allowMatch[1];
      allow.set(kind, mergeScope(allow.get(kind), parseScope(allowMatch[2])));
      continue;
    }
    const denyMatch = token.match(DENY_FLAG);
    if (denyMatch) {
      const kind = denyMatch[1];
      deny.set(kind, mergeScope(deny.get(kind), parseScope(denyMatch[2])));
      continue;
    }
    // "deno", "test", --permit-no-files, --ignore=..., positional paths —
    // none of these carry permission authority, so they are simply dropped.
  }

  return { allowAll, allow, deny };
}

/** The inverse of parsePermissionSet: serialize a PermissionSet back into an
 * argv-shaped array of flag tokens, in insertion order. Used by
 * soak_schedule.ts to derive a bucket entry's denoArgsJson directly from an
 * extension's own test task when no narrowed quality.yaml soak: override
 * exists — the default, common-case path that closes 24/51 extensions'
 * permission gap with zero per-extension hand-authoring. */
export function permissionSetToArgs(
  permissions: ParsedPermissionSet,
): string[] {
  const args: string[] = [];
  if (permissions.allowAll) {
    args.push("--allow-all");
  } else {
    for (const [kind, scope] of permissions.allow) {
      args.push(
        scope === null
          ? `--allow-${kind}`
          : `--allow-${kind}=${scope.join(",")}`,
      );
    }
  }
  for (const [kind, scope] of permissions.deny) {
    args.push(
      scope === null ? `--deny-${kind}` : `--deny-${kind}=${scope.join(",")}`,
    );
  }
  return args;
}

// ============================================================================
// RuntimeFlagSet — --v8-flags/--unstable-* are RUNTIME flags, deliberately
// kept OUT of the PermissionSet vocabulary above (they configure the deno/V8
// runtime itself, they grant/deny no authority at all) but must still reach
// the soaked child process.
//
// The defect this fixes: `deno run --allow-read --allow-env
// scripts/soak_schedule.ts --all` used to emit no "v8-flags" anywhere in its
// output, even though seanime/deno.json and seadex/deno.json both declare
// `--v8-flags=--expose-gc` on their `test` task. Root cause:
// parsePermissionSet/permissionSetToArgs above only ever round-trip
// --allow-*/--deny-* tokens by design (see parsePermissionSet's own
// docblock: "Everything else ... is dropped by construction"), so
// soak_schedule.ts's resolveDenoArgs fallback silently dropped --v8-flags on
// the floor for every extension that isn't hand-overridden via
// quality.yaml. seanime_property_test.ts's heap-pin regression tests (the
// guard for the req.clone() leak PR #182 fixed) declare `ignore:
// heapPinSkipReason !== undefined`, where the skip reason is set when
// `gc()` is not exposed to the running process — so those tests were
// SILENTLY SKIPPED in every nightly soak run, never actually exercising the
// leak they exist to catch. Same for seadex.
// ============================================================================

const V8_FLAGS = /^--v8-flags(?:=.*)?$/;
const UNSTABLE_FLAG = /^--unstable(?:-[a-zA-Z0-9-]+)?(?:=.*)?$/;

/** TRUE iff `token` is a recognized RUNTIME flag — carried through the
 * derivation verbatim, never treated as a PermissionSet member. */
export function isRuntimeFlag(token: string): boolean {
  return V8_FLAGS.test(token) || UNSTABLE_FLAG.test(token);
}

/** Extract every recognized runtime flag token from a raw `test` task
 * string, verbatim and in encounter order. Unlike mergeScope's union
 * semantics for permission scopes, duplicates (if a test task ever repeated
 * one) are preserved as-is — deno's own runtime-flag handling, not this
 * derivation's, owns what a repeated occurrence means. */
export function parseRuntimeFlags(task: string): string[] {
  return task.split(/\s+/).filter((t) => t.length > 0 && isRuntimeFlag(t));
}

/** Derive the full soak argv from a raw `test` task string: recognized
 * runtime flags FIRST, verbatim, in encounter order, THEN the permission
 * flags parsePermissionSet/permissionSetToArgs derive. Runtime flags are
 * ordered before permission flags because they configure how the deno
 * process itself starts up (V8 flags, unstable API surface) rather than
 * what it's authorized to touch — the natural "how to run" -> "what it may
 * do" reading order. This is what soak_schedule.ts's resolveDenoArgs calls
 * for the common (no quality.yaml `soak:` override) derivation path — see
 * that module for the rare, human-reviewed narrowing exception. */
export function deriveSoakArgsFromTestTask(task: string): string[] {
  return [
    ...parseRuntimeFlags(task),
    ...permissionSetToArgs(parsePermissionSet(task)),
  ];
}

// Flags this module KNOWS about and deliberately drops from the derived
// soak argv — matched by KIND (the token up to its first "="), never by
// full token, since some of these carry an extension-specific value. Each
// entry documents WHY it's safe to drop, not merely THAT it is, so a future
// reader can tell a deliberate omission from an oversight:
//
//   --permit-no-files  a `deno test` reporter/discovery flag ("don't fail
//     when the glob matches zero files"). The soak always targets exactly
//     ONE specific file (run_soak.ts's --file positional), so "zero files
//     matched" can never happen at soak time — the flag has nothing to do.
//   --ignore            `deno test`'s test-discovery exclude-glob
//     (anilist-chart's real test task uses it to skip two non-property
//     test files during the extension's OWN full-suite `deno task test`
//     run). Irrelevant once run_soak.ts has already narrowed the
//     invocation to one explicit file — there is nothing left to exclude.
//
// This is the SAME list validateNoUnknownFlags below checks a task's
// "--"-prefixed tokens against — see that validator's docblock for the
// defect this pair of lists (recognize-and-carry vs. recognize-and-drop)
// exists to make impossible to repeat.
const DELIBERATELY_DROPPED_FLAG_KINDS = new Set([
  "--permit-no-files",
  "--ignore",
]);

function flagKind(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/** TRUE iff `token` (a "--"-prefixed CLI token from a `test` task) is
 * recognized as EITHER a permission flag (--allow-X/--deny-X/--allow-all)
 * OR a carried runtime flag (--v8-flags/--unstable-*). */
function isRecognizedFlag(token: string): boolean {
  return token === "--allow-all" || ALLOW_FLAG.test(token) ||
    DENY_FLAG.test(token) || isRuntimeFlag(token);
}

/**
 * PR-time guard for the root cause of the --v8-flags-dropping defect: the
 * derivation used to silently DISCARD any "--"-prefixed token it didn't
 * recognize (see parsePermissionSet's docblock — "Everything else ... is
 * dropped by construction"). That silence is exactly how
 * --v8-flags=--expose-gc vanished from seanime's and seadex's derived soak
 * argv for as long as it did: nothing ever complained, so nobody noticed
 * until the heap-pin regression tests it gates turned out to have been
 * skipping silently in every nightly run.
 *
 * This validator makes the CLASS of defect impossible to repeat, not just
 * the one instance: any "--"-prefixed token in `task` that is
 *   (i)   not a recognized permission flag (parsePermissionSet's own
 *         ALLOW_FLAG/DENY_FLAG shape, or bare --allow-all),
 *   (ii)  not a recognized carried runtime flag (isRuntimeFlag), and
 *   (iii) not on the explicitly-reviewed DELIBERATELY_DROPPED_FLAG_KINDS
 *         list above (with a documented reason for each entry)
 * is reported as a VIOLATION rather than silently dropped. Never throws.
 * Checked once per unique flag KIND (not once per occurrence), matching
 * validateNoDuplicateHardRejectFlags's own dedup discipline above — a
 * flag repeated three times in one task is one finding, not three.
 */
export function validateNoUnknownFlags(task: string): Violation[] {
  const violations: Violation[] = [];
  const reported = new Set<string>();
  const tokens = task.split(/\s+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    if (!token.startsWith("--")) continue;
    if (isRecognizedFlag(token)) continue;
    const kind = flagKind(token);
    if (DELIBERATELY_DROPPED_FLAG_KINDS.has(kind)) continue;
    if (reported.has(kind)) continue;
    reported.add(kind);
    violations.push({
      rule: "soak-unrecognized-flag-silently-dropped",
      what: `test task contains "${token}", which is neither a recognized ` +
        "permission flag, a recognized runtime flag (--v8-flags/" +
        "--unstable-*), nor an explicitly-listed deliberately-dropped flag",
      why: "the derivation used to silently discard any --prefixed token " +
        "it didn't recognize by construction — the exact mechanism that " +
        "dropped --v8-flags=--expose-gc from seanime's and seadex's " +
        "derived soak argv and silently skipped their heap-pin regression " +
        "tests in every nightly soak run until someone happened to notice",
      fix: `either extend scripts/lib/soak_permissions.ts to carry ${kind} ` +
        "through the derivation (if the soak legitimately needs it, the " +
        "way --v8-flags/--unstable-* are carried), or add it to " +
        "DELIBERATELY_DROPPED_FLAG_KINDS there with a documented reason " +
        "why it's safe to drop",
    });
  }
  return violations;
}

// ============================================================================
// isBroadGrant — the EXACT, narrow classifier
// ============================================================================

/**
 * TRUE iff this permission set's authority is broad enough that an
 * unattended nightly soak must not silently inherit it: --allow-all, OR
 * UNSCOPED --allow-run, --allow-net, --allow-ffi, or --allow-sys. Nothing
 * else — in particular, unscoped --allow-write/--allow-read (14 extensions'
 * ordinary temp-dir shape) and any SCOPED grant (including a comma-scoped
 * --allow-env) are NOT broad. Getting this wrong in the "wider" direction
 * would force every permission-needing extension onto a hand-written
 * quality.yaml soak: override — a scope explosion that inverts this
 * design's whole premise (see the module docblock).
 *
 * --allow-ffi/--allow-sys are unscoped-only as broad as --allow-run/
 * --allow-net (arbitrary native-library loading / full system-info+process
 * introspection) but are not used by any of the 51 real test tasks today —
 * latent, not live.
 */
const UNSCOPED_BROAD_KINDS = ["run", "net", "ffi", "sys"] as const;

export function isBroadGrant(permissions: ParsedPermissionSet): boolean {
  if (permissions.allowAll) return true;
  for (const kind of UNSCOPED_BROAD_KINDS) {
    if (permissions.allow.get(kind) === null && permissions.allow.has(kind)) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// checkSoakAuthority — the four narrowing rules
// ============================================================================

/**
 * Compare `test` (the extension's own deno.json `test` task — the source of
 * authority) against `soak` (a proposed narrowed override), returning every
 * violation of the four rules:
 *   (a) --allow-all in soak requires --allow-all in test.
 *   (b) per --allow-X in soak: test must grant --allow-X at all; if test's
 *       grant is SCOPED, soak's must be scoped to a SUBSET of test's scopes
 *       (test unscoped covers any soak scope, scoped or unscoped).
 *   (c) soak may omit a flag test grants entirely — narrowing is the point.
 *   (d) every --deny-X in test must appear in soak with at least the same
 *       denied scope — denies may be ADDED, never removed or narrowed.
 * Never throws; always returns an array (possibly empty).
 */
export function checkSoakAuthority(
  test: ParsedPermissionSet,
  soak: ParsedPermissionSet,
): Violation[] {
  const violations: Violation[] = [];

  // Rule (a)
  if (soak.allowAll && !test.allowAll) {
    violations.push({
      rule: "soak-allow-all-not-in-test",
      what:
        "soak grants --allow-all but the test task does not grant --allow-all",
      why:
        "an unattended nightly soak must never claim MORE authority than the " +
        "test task ci.yml already runs under — --allow-all is the maximum " +
        "possible grant",
      fix: "remove --allow-all from the soak override, or narrow it to the " +
        "specific flags actually needed",
    });
  }

  // Rule (b) + (c) — (c) is implicit: we only ever iterate soak's own keys,
  // so a flag test grants but soak omits never produces a violation.
  for (const [kind, soakScope] of soak.allow) {
    if (test.allowAll) continue; // test's blanket grant covers any soak flag
    if (!test.allow.has(kind)) {
      violations.push({
        rule: "soak-grants-flag-test-lacks",
        what:
          `soak grants --allow-${kind} but the test task does not grant it at all`,
        why: "the test task (ci.yml's own permission set) is the source of " +
          "authority — soak may only narrow it, never add a flag the test " +
          "task lacks",
        fix:
          `remove --allow-${kind} from the soak override, or add it to the ` +
          "extension's own deno.json test task first",
      });
      continue;
    }
    const testScope = test.allow.get(kind)!;
    if (testScope === null) continue; // unscoped test grant covers any soak scope
    if (soakScope === null) {
      violations.push({
        rule: "soak-widens-scoped-grant",
        what:
          `soak's --allow-${kind} is unscoped but the test task's --allow-${kind} ` +
          `is scoped to ${JSON.stringify(testScope)}`,
        why: "soak may only narrow the test task's authority, never widen a " +
          "scoped grant to an unscoped one",
        fix: `scope soak's --allow-${kind} to a subset of ${
          JSON.stringify(testScope)
        }`,
      });
      continue;
    }
    // KNOWN LIMITATION: this subset check is EXACT-STRING, not
    // path/host-prefix aware — e.g. soak scope "/tmp/sub" is NOT recognized
    // as a subset of test scope "/tmp" even though deno's own permission
    // model would treat /tmp/sub as already covered by a /tmp grant. This
    // fails SAFE (it blocks a legitimate narrowing rather than ever
    // approving a widening), so it is deliberately left as-is rather than
    // "fixed" — a false-positive violation is a human-visible annoyance; a
    // false-negative here would be the security bug.
    const extra = soakScope.filter((s) => !testScope.includes(s));
    if (extra.length > 0) {
      violations.push({
        rule: "soak-scope-not-subset",
        what:
          `soak's --allow-${kind} scope ${
            JSON.stringify(soakScope)
          } is not a ` +
          `subset of the test task's scope ${JSON.stringify(testScope)} ` +
          `(extra: ${JSON.stringify(extra)})`,
        why: "soak may only narrow the test task's scoped grant, never add a " +
          "scope entry the test task doesn't already grant",
        fix: `remove ${
          JSON.stringify(extra)
        } from soak's --allow-${kind} scope`,
      });
    }
  }

  // Rule (d)
  for (const [kind, testDenyScope] of test.deny) {
    const soakDenyScope = soak.deny.get(kind);
    if (soakDenyScope === undefined) {
      violations.push({
        rule: "soak-drops-deny",
        what:
          `test task denies --deny-${kind}=${
            JSON.stringify(testDenyScope)
          } but ` +
          `soak declares no --deny-${kind} at all`,
        why:
          "a --deny-X guard in the test task must never silently disappear " +
          "from the nightly soak — denies may be added, never removed",
        fix: `add --deny-${kind}=${
          (testDenyScope ?? []).join(",")
        } to the soak override`,
      });
      continue;
    }
    if (testDenyScope === null) {
      if (soakDenyScope !== null) {
        violations.push({
          rule: "soak-narrows-deny",
          what:
            `test task's --deny-${kind} is unscoped (denies everything) but ` +
            `soak's --deny-${kind} is scoped to ${
              JSON.stringify(soakDenyScope)
            }`,
          why: "soak's deny coverage must be at least as broad as the test " +
            "task's — narrowing an unscoped deny would re-open access the " +
            "test task explicitly denies",
          fix: `make soak's --deny-${kind} unscoped as well`,
        });
      }
      continue;
    }
    if (soakDenyScope === null) continue; // soak's unscoped deny is a superset of any scoped test deny
    const missing = testDenyScope.filter((s) => !soakDenyScope.includes(s));
    if (missing.length > 0) {
      violations.push({
        rule: "soak-narrows-deny",
        what:
          `soak's --deny-${kind} scope ${
            JSON.stringify(soakDenyScope)
          } drops ` +
          `${
            JSON.stringify(missing)
          } from the test task's --deny-${kind} scope ` +
          `${JSON.stringify(testDenyScope)}`,
        why:
          "a --deny-X guard in the test task must never be narrowed in the " +
          "nightly soak — denies may be added, never removed or narrowed",
        fix: `add ${
          JSON.stringify(missing)
        } back to soak's --deny-${kind} scope`,
      });
    }
  }

  return violations;
}

// ============================================================================
// expandHomeTokens — literal $HOME / ${HOME} expansion
// ============================================================================

const HOME_BRACED = /\$\{HOME\}/g;
const HOME_BARE = /\$HOME\b/g;
const HAS_HOME_REF = /\$\{HOME\}|\$HOME\b/;

export interface ExpandHomeResult {
  readonly expanded: string[];
  readonly violations: Violation[];
}

/**
 * Expand literal `$HOME`/`${HOME}` tokens against `home`. An unset or
 * empty `home` is itself a VIOLATION for any token that references it —
 * NEVER a silent "" substitution, which would turn e.g.
 * `--deny-write=$HOME/.talos` into `--deny-write=/.talos`, voiding the
 * guard it came from (the exact regression this function exists to
 * prevent). Any OTHER unresolved `$`-token (after HOME expansion) is also a
 * violation.
 */
export function expandHomeTokens(
  tokens: readonly string[],
  home: string | undefined,
): ExpandHomeResult {
  const violations: Violation[] = [];
  const expanded: string[] = [];

  for (const token of tokens) {
    if (HAS_HOME_REF.test(token) && (home === undefined || home === "")) {
      violations.push({
        rule: "unresolved-home-token",
        what: `token "${token}" references $HOME/\${HOME} but HOME is ` +
          `${home === undefined ? "unset" : "empty"}`,
        why: "silently substituting an empty string for HOME would turn e.g. " +
          "--deny-write=$HOME/.talos into --deny-write=/.talos, voiding the " +
          "guard the token came from",
        fix:
          "ensure HOME is set to a real path before this permission set is " +
          "resolved",
      });
      expanded.push(token); // never silently substitute "" — leave raw
      continue;
    }

    let result = token;
    if (home) {
      result = result.replace(HOME_BRACED, home).replace(HOME_BARE, home);
    }
    if (result.includes("$")) {
      violations.push({
        rule: "unresolved-token",
        what:
          `token "${token}" contains an unresolved $-reference after HOME ` +
          `expansion: "${result}"`,
        why: "an unexpanded shell-style variable reference in a permission " +
          "scope would silently pass through to deno test as a literal, " +
          "meaningless path/host component",
        fix: "remove the unresolved variable reference, or expand it to a " +
          "literal value before this permission set is used",
      });
      expanded.push(token); // don't emit the partially-substituted value as final
      continue;
    }
    expanded.push(result);
  }

  return { expanded, violations };
}

// ============================================================================
// validateTokenSafety / validatePropertyFilePath / validateSoakAdequacy
// ============================================================================

// Safe charset for a permission token (a full "--allow-x=scope1,scope2"
// flag): letters, digits, and the punctuation real permission flags/scopes
// actually use (-, _, ., /, =, ,, $, {, }, :, @ — the last three cover
// ${HOME} expansion tokens and host:port scopes). Anything outside this —
// shell metacharacters (;, |, (, ), `, &, <, >), quotes, whitespace — is
// refused outright.
const SAFE_TOKEN_CHARS = /^[A-Za-z0-9_\-./=,${}:@]*$/;

/** Every permission token must match a safe charset; anything with a shell
 * metacharacter is a violation. Never throws; aggregates every offending
 * token before returning. */
export function validateTokenSafety(tokens: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const token of tokens) {
    if (!SAFE_TOKEN_CHARS.test(token)) {
      violations.push({
        rule: "unsafe-permission-token",
        what:
          `permission token "${token}" contains a character outside the safe charset`,
        why:
          "a soak permission token that reaches deno test's argv must never " +
          "carry a shell metacharacter (;, |, $(...), `...`, whitespace, " +
          "etc.) — even though argv never passes through a shell here, an " +
          "unsafe token is a sign the source (quality.yaml or a test task) " +
          "was tampered with or malformed",
        fix: `remove the unsafe character(s) from "${token}", or express the ` +
          "intended value without shell syntax",
      });
    }
  }
  return violations;
}

// Deno's CLI hard-rejects a SECOND occurrence of these flag kinds outright
// (clap: "the argument '--allow-net[=...]' cannot be used multiple times") —
// empirically re-verified against the installed deno 2.7.13 (2026-08-07,
// repeated-flag probes run for every kind referenced anywhere in this
// module, not just appended-to-taste): a repeated --allow-net / --allow-env
// / --allow-run / --allow-sys (AND their --deny-* counterparts) all
// hard-reject outright with "cannot be used multiple times"; a repeated
// --allow-read / --allow-write / --allow-ffi (AND their --deny-*
// counterparts) all UNION across occurrences instead (see mergeScope above)
// — confirmed live, not assumed. A quality.yaml soak.denoArgs override that
// repeats one of the hard-reject kinds parses "fine" through
// parsePermissionSet (which happily merges the token-level scopes) but
// would hard-fail run_soak.ts's `deno test` invocation at 3am, long after
// check_soak.ts's PR-time gate already passed it. This validator catches
// that mismatch at PR time instead.
const HARD_REJECT_DUPLICATE_KINDS = new Set(["net", "env", "run", "sys"]);

/** Flags a --allow-X/--deny-X kind in HARD_REJECT_DUPLICATE_KINDS that
 * appears more than once in `tokens` — regardless of what parsePermissionSet
 * would merge it into. Never throws; one violation per offending kind
 * (allow and deny tracked independently — --allow-net once + --deny-net once
 * is fine, only a REPEATED occurrence of the same flag is the problem). */
export function validateNoDuplicateHardRejectFlags(
  tokens: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  for (
    const [flagPrefix, pattern] of [
      ["--allow-", ALLOW_FLAG],
      ["--deny-", DENY_FLAG],
    ] as const
  ) {
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const token of tokens) {
      const match = token.match(pattern);
      if (!match) continue;
      const kind = match[1];
      if (!HARD_REJECT_DUPLICATE_KINDS.has(kind)) continue;
      if (seen.has(kind) && !reported.has(kind)) {
        violations.push({
          rule: "duplicate-hard-reject-flag",
          what:
            `${flagPrefix}${kind} appears more than once in the same denoArgs list`,
          why: "deno's CLI hard-rejects a repeated occurrence of this flag " +
            `outright ("the argument '${flagPrefix}${kind}[=...]' cannot ` +
            'be used multiple times") — unlike --allow-read/--allow-write ' +
            "(which deno unions across occurrences), this would parse " +
            "successfully through this module's own merge logic but crash " +
            "deno test at soak time, long after this PR-time gate passed it",
          fix:
            `merge the repeated ${flagPrefix}${kind} entries into a single ` +
            `occurrence (e.g. ${flagPrefix}${kind}=a,b instead of two ` +
            `separate ${flagPrefix}${kind}=a / ${flagPrefix}${kind}=b entries)`,
        });
        reported.add(kind);
      }
      seen.add(kind);
    }
  }
  return violations;
}

// Deno's CLI also hard-rejects --allow-all (or its -A shorthand) combined
// with ANY other --allow-X flag in the same argv outright ("the argument
// '--allow-all...' cannot be used with '--allow-X[=...]'") — empirically
// verified live against deno 2.7.13 for --allow-read, --allow-env, and
// --allow-net, and for -A equally. This is a DIFFERENT hard-reject class
// than HARD_REJECT_DUPLICATE_KINDS above (which is about a REPEATED
// same-kind flag): here the conflict is --allow-all against any other kind,
// even just once. Also verified live: --allow-all combined with a --deny-X
// flag is FINE (a legitimate "grant everything except ..." pattern deno
// permits), and --allow-all repeated with itself or with -A is also FINE —
// only a co-occurring OTHER --allow-X hard-crashes deno test before a
// single test runs.
const ALLOW_ALL_TOKENS = new Set(["--allow-all", "-A"]);

/** Flags a denoArgs list that combines --allow-all/-A with any OTHER
 * --allow-X flag. Never throws; returns at most one violation, listing every
 * offending flag found. */
export function validateNoAllowAllWithOtherAllowFlags(
  tokens: readonly string[],
): Violation[] {
  if (!tokens.some((t) => ALLOW_ALL_TOKENS.has(t))) return [];
  const others = tokens.filter((t) => {
    if (ALLOW_ALL_TOKENS.has(t)) return false;
    const match = t.match(ALLOW_FLAG);
    return match !== null && match[1] !== "all";
  });
  if (others.length === 0) return [];
  return [{
    rule: "allow-all-with-other-allow-flag",
    what: `denoArgs combines --allow-all (or -A) with other --allow-X ` +
      `flag(s): ${others.join(", ")}`,
    why: "deno's CLI hard-rejects --allow-all used alongside any other " +
      "--allow-X flag outright (\"the argument '--allow-all...' cannot be " +
      "used with '--allow-X[=...]'\") — this parses fine through every " +
      "other validator in this pipeline but crashes deno test's " +
      "invocation before a single test runs",
    fix: "remove --allow-all (it already grants everything the other " +
      `flag(s) would add) or remove the other --allow-X flag(s): ${
        others.join(", ")
      }`,
  }];
}

// Safe charset for a discovered property-file PATH: strictly narrower than
// a permission token's — no $, {, }, :, @, or , are ever legitimate in a
// real repo-relative file path.
const SAFE_PATH_CHARS = /^[A-Za-z0-9_\-./]+$/;

/** Same charset discipline as validateTokenSafety, applied to a discovered
 * property-file path (travels through soak_schedule.ts's GITHUB_OUTPUT and
 * run_soak.ts's argv). */
export function validatePropertyFilePath(path: string): Violation[] {
  if (SAFE_PATH_CHARS.test(path)) return [];
  return [{
    rule: "unsafe-property-file-path",
    what:
      `discovered property file path "${path}" contains a character outside the safe charset`,
    why: "a discovered file path travels through soak_schedule.ts's " +
      "GITHUB_OUTPUT and run_soak.ts's argv — a space, shell metacharacter, " +
      "or non-ASCII character here is a sign of a malicious or malformed " +
      "repo path, not a real extension file",
    fix: "rename the file to use only letters, digits, '_', '-', '.', and '/'",
  }];
}

/** A soak permission set with no --allow-env* and no --allow-all is a
 * violation (the property test harness reads FC_NUM_RUNS via
 * Deno.env.get); a SCOPED --allow-env that omits FC_NUM_RUNS is a
 * violation too. An unscoped --allow-env, or --allow-all, trivially
 * covers env access. */
export function validateSoakAdequacy(soak: ParsedPermissionSet): Violation[] {
  if (soak.allowAll) return [];
  if (!soak.allow.has("env")) {
    return [{
      rule: "soak-missing-env-grant",
      what: "soak permission set has no --allow-env (or --allow-all) at all",
      why: "the property test harness reads its iteration count via " +
        'Deno.env.get("FC_NUM_RUNS") — without at least a scoped ' +
        "--allow-env=FC_NUM_RUNS grant, the soak silently runs at its small " +
        "fallback iteration count instead of the intended high nightly count",
      fix:
        "add --allow-env=FC_NUM_RUNS (or a wider --allow-env grant) to the " +
        "soak permission set",
    }];
  }
  const scope = soak.allow.get("env") ?? null;
  if (scope === null) return []; // unscoped --allow-env trivially covers FC_NUM_RUNS
  if (!scope.includes("FC_NUM_RUNS")) {
    return [{
      rule: "soak-env-missing-fc-num-runs",
      what: `soak's --allow-env is scoped to ${
        JSON.stringify(scope)
      }, which omits FC_NUM_RUNS`,
      why: "the property test harness reads its iteration count via " +
        'Deno.env.get("FC_NUM_RUNS") — a scoped --allow-env that omits it ' +
        "makes the soak run at its small fallback count, defeating the " +
        "nightly high-iteration soak entirely",
      fix: `add FC_NUM_RUNS to the scoped --allow-env grant: --allow-env=` +
        `${[...scope, "FC_NUM_RUNS"].join(",")}`,
    }];
  }
  return [];
}
