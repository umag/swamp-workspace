// Failing-first (TDD RED) tests for scripts/lib/soak_permissions.ts (does not
// exist yet) — the single source of truth for reasoning about deno CLI
// permission flags across the property-soak pipeline.
//
// The defect this module fixes: .github/workflows/property-soak.yml
// hardcodes `deno test --allow-env=FC_NUM_RUNS "<file>"` for EVERY soaked
// extension, ignoring each extension's own deno.json `test` task — which is
// what ci.yml actually runs and which carries the real permission set an
// extension needs. 24 of 51 extensions need strictly more (extra --allow-read/
// --allow-write scopes, extra --allow-env vars, --allow-net, --allow-all) and
// have therefore never been successfully soaked (NotCapable failures).
//
// This module owns FIVE things, each pinned in its own section below:
//   1. parsePermissionSet  — turn a raw `test` task string into a structured
//      PermissionSet, keeping only --allow*/--deny* tokens.
//   2. checkSoakAuthority  — the four narrowing rules that decide whether a
//      quality.yaml `soak:` override is a legitimate NARROWING of the test
//      task's authority, or an illegitimate widening/omission.
//   3. isBroadGrant        — the EXACT, narrow classifier for "this test
//      task's authority is broad enough that an unattended nightly soak
//      must not silently inherit it": --allow-all, OR unscoped --allow-run,
//      OR unscoped --allow-net. Nothing else. In particular, unscoped
//      --allow-write (14 extensions' ordinary temp-dir shape) and unscoped
//      --allow-read are NOT broad, nor is any SCOPED grant (including a
//      comma-scoped --allow-env). Getting this wrong — e.g. treating "needs
//      more than the trivial FC_NUM_RUNS baseline" as broad — would force
//      all 24 permission-needing extensions onto a hand-written quality.yaml
//      soak: override, a scope explosion that inverts PR B's whole premise:
//      the test task IS the source of truth; soak: is a RARE, human-reviewed
//      narrowing exception for the three extensions that are actually broad
//      (swamp-go-brr, stripe-mpp, jscad-cad) — not a per-extension
//      declaration triggered by needing any permission at all.
//   4. expandHomeTokens    — literal $HOME / ${HOME} expansion, engineered so
//      an unset/empty HOME can never silently turn a --deny-write=$HOME/.talos
//      guard into --deny-write=/.talos (voiding it).
//   5. validateTokenSafety / validatePropertyFilePath / validateSoakAdequacy
//      — validators that RETURN Violation[] and never throw, because a raw
//      throw in an unattended nightly soak is exactly the failure mode this
//      whole design avoids.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import {
  checkSoakAuthority,
  expandHomeTokens,
  isBroadGrant,
  type ParsedPermissionSet,
  parsePermissionSet,
  validateNoAllowAllWithOtherAllowFlags,
  validateNoDuplicateHardRejectFlags,
  validatePropertyFilePath,
  validateSoakAdequacy,
  validateTokenSafety,
  type Violation,
} from "./soak_permissions.ts";

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");

/** Reads `<ext>/deno.json`'s `tasks.test` string straight off disk — the
 * exact string ci.yml's deno-check matrix runs — so every parser fixture
 * below is pinned against the REAL, currently-live shape rather than a
 * hand-copied string that can silently drift out of sync with the repo. */
async function readTestTask(ext: string): Promise<string> {
  const raw = await Deno.readTextFile(join(REPO_ROOT, ext, "deno.json"));
  const json = JSON.parse(raw) as { tasks?: { test?: string } };
  const task = json.tasks?.test;
  if (!task) {
    throw new Error(`${ext}/deno.json has no tasks.test`);
  }
  return task;
}

function empty(): ParsedPermissionSet {
  return { allowAll: false, allow: new Map(), deny: new Map() };
}

// ============================================================================
// parsePermissionSet — keeps only --allow*/--deny* tokens
// ============================================================================

Deno.test("parsePermissionSet: keeps only --allow*/--deny* tokens; drops 'deno test', --permit-no-files, --ignore=..., and positional paths", () => {
  const parsed = parsePermissionSet(
    "deno test --ignore=a/b.ts,c/d.ts --allow-read=x,y --permit-no-files " +
      "some/positional/dir/ --deny-net=evil.example.com another/positional",
  );
  assertEquals(parsed.allowAll, false);
  assertEquals(parsed.allow.size, 1, JSON.stringify([...parsed.allow]));
  assertEquals(parsed.allow.get("read"), ["x", "y"]);
  assertEquals(parsed.deny.size, 1, JSON.stringify([...parsed.deny]));
  assertEquals(parsed.deny.get("net"), ["evil.example.com"]);
});

Deno.test("parsePermissionSet: recognizes bare --allow-all as allowAll=true, not a scoped 'all' flag", () => {
  const parsed = parsePermissionSet(
    "deno test --permit-no-files --allow-all extensions/models/",
  );
  assertEquals(parsed.allowAll, true);
  assertEquals(parsed.allow.size, 0);
});

Deno.test("parsePermissionSet: anilist-chart's real test task — --ignore= with embedded commas is dropped whole, not parsed as scopes", async () => {
  const parsed = parsePermissionSet(await readTestTask("anilist-chart"));
  assertEquals(parsed.allowAll, false);
  assertEquals(parsed.allow.get("read"), null);
  assertEquals(parsed.allow.get("write"), null);
  assertEquals(parsed.allow.get("env"), ["FC_NUM_RUNS"]);
  assertEquals(parsed.allow.size, 3, JSON.stringify([...parsed.allow]));
  assertEquals(parsed.deny.size, 0);
});

Deno.test("parsePermissionSet: music-library's real test task — multiple positional dirs at the end are dropped", async () => {
  const parsed = parsePermissionSet(await readTestTask("music-library"));
  assertEquals(parsed.allow.get("env"), ["FC_NUM_RUNS"]);
  assertEquals(parsed.allow.get("read"), ["extensions/workflows"]);
  assertEquals(parsed.allow.size, 2, JSON.stringify([...parsed.allow]));
});

Deno.test("parsePermissionSet: musicbrainz's real test task — positional dirs BEFORE --permit-no-files (order variance) are still dropped", async () => {
  const parsed = parsePermissionSet(await readTestTask("musicbrainz"));
  assertEquals(parsed.allow.get("env"), ["FC_NUM_RUNS"]);
  assertEquals(parsed.allow.size, 1, JSON.stringify([...parsed.allow]));
  assertEquals(parsed.allowAll, false);
});

Deno.test("parsePermissionSet: pihole's real test task — comma-scoped --allow-env AND --allow-read", async () => {
  const parsed = parsePermissionSet(await readTestTask("pihole"));
  assertEquals(parsed.allow.get("env"), ["FC_NUM_RUNS", "LIVE_PIHOLE"]);
  assertEquals(parsed.allow.get("read"), ["extensions", "fixtures"]);
});

Deno.test("parsePermissionSet: fidonet-msgbase's real test task — comma-scoped --allow-env, bare --allow-read/--allow-write", async () => {
  const parsed = parsePermissionSet(await readTestTask("fidonet-msgbase"));
  assertEquals(parsed.allow.get("env"), [
    "FC_NUM_RUNS",
    "FIDONET_MSGBASE_MAX_BYTES",
  ]);
  assertEquals(parsed.allow.get("read"), null);
  assertEquals(parsed.allow.get("write"), null);
});

Deno.test("parsePermissionSet: lastfm's real test task — bare (unscoped) --allow-env", async () => {
  const parsed = parsePermissionSet(await readTestTask("lastfm"));
  assertEquals(parsed.allow.get("env"), null);
  assertEquals(parsed.allow.get("read"), ["extensions/models", "fixtures"]);
});

Deno.test("parsePermissionSet: obsidian-vault's real test task — bare --allow-env, flags AFTER the positional path (order independence)", async () => {
  const parsed = parsePermissionSet(await readTestTask("obsidian-vault"));
  assertEquals(parsed.allow.get("env"), null);
  assertEquals(parsed.allow.get("read"), null);
  assertEquals(parsed.allow.get("write"), null);
  assertEquals(parsed.allow.size, 3, JSON.stringify([...parsed.allow]));
});

Deno.test("parsePermissionSet: cadvisor's real test task — scoped --allow-read", async () => {
  const parsed = parsePermissionSet(await readTestTask("cadvisor"));
  assertEquals(parsed.allow.get("env"), ["FC_NUM_RUNS"]);
  assertEquals(parsed.allow.get("read"), ["extensions", "fixtures"]);
});

Deno.test("parsePermissionSet: talm-cluster's real test task — --deny-write=$HOME/.talos,$HOME/.config/swamp kept RAW (unexpanded)", async () => {
  const parsed = parsePermissionSet(await readTestTask("talm-cluster"));
  assertEquals(parsed.allow.get("read"), null);
  assertEquals(parsed.allow.get("write"), null);
  assertEquals(parsed.allow.get("env"), ["FC_NUM_RUNS"]);
  assertEquals(parsed.deny.get("write"), [
    "$HOME/.talos",
    "$HOME/.config/swamp",
  ]);
});

// ============================================================================
// parsePermissionSet — REPEATED same-kind flags UNION (never last-wins),
// matching deno's REAL CLI semantics. Empirically verified against the
// installed deno 2.7.13 binary (same major/minor family as the 2.8.3 pinned
// in these workflows) — see each test's comment for the exact command run.
// This is the CRITICAL gate-bypass fix: parsePermissionSet used to store
// each --allow-X/--deny-X occurrence in a Map keyed by kind, so a SECOND
// occurrence silently overwrote the first ("last wins"), while deno itself
// unions them — a soak.denoArgs override with two --allow-read entries (a
// wide one, then a narrow one) was judged by check_soak.ts as granting only
// the narrow scope, while deno actually granted the union of both.
// ============================================================================

Deno.test("parsePermissionSet: two --allow-read entries with DISJOINT scopes UNION (never last-wins) — the CRITICAL gate-bypass fixture", () => {
  // Verified live: `deno run --allow-read=/tmp --allow-read=/var probe.ts`
  // grants BOTH /tmp and /var.
  const parsed = parsePermissionSet(
    "--allow-read=/etc,/root,/home/runner --allow-read=./fixtures",
  );
  assertEquals(
    parsed.allow.get("read"),
    ["/etc", "/root", "/home/runner", "./fixtures"],
  );
});

Deno.test("parsePermissionSet: --allow-write repeats union too (parity with --allow-read)", () => {
  const parsed = parsePermissionSet("--allow-write=/tmp --allow-write=/var");
  assertEquals(parsed.allow.get("write"), ["/tmp", "/var"]);
});

Deno.test("parsePermissionSet: duplicate --deny-write entries union the same way as --allow-*", () => {
  const parsed = parsePermissionSet(
    "--deny-write=$HOME/.talos --deny-write=$HOME/.config/swamp",
  );
  assertEquals(parsed.deny.get("write"), [
    "$HOME/.talos",
    "$HOME/.config/swamp",
  ]);
});

Deno.test("parsePermissionSet: Deno's REAL union semantics documented — a BARE occurrence does NOT subsume a scoped one, in EITHER order", () => {
  // Empirically verified live against deno 2.7.13 (this is the
  // counterintuitive half of the union rule, recorded here so the
  // assumption doesn't silently drift):
  //   deno run --allow-read --allow-read=/tmp probe.ts  -> ONLY /tmp granted
  //   deno run --allow-read=/tmp --allow-read probe.ts  -> ONLY /tmp granted
  // This is the OPPOSITE of the naive assumption that "an unscoped
  // occurrence subsumes any scoped one" — deno's clap-based parser
  // accumulates scope VALUES across every occurrence of the flag into one
  // list; a bare occurrence (no `=value`) contributes ZERO values. The flag
  // only means "grant everything" when that accumulated list ends up empty
  // — i.e. when EVERY occurrence was bare (see the next test). A bare
  // occurrence mixed with any scoped occurrence, in either order, narrows
  // to exactly the scoped values given — it never "wins" and grants all.
  const bareFirst = parsePermissionSet("--allow-read --allow-read=/tmp");
  assertEquals(bareFirst.allow.get("read"), ["/tmp"]);

  const scopedFirst = parsePermissionSet("--allow-read=/tmp --allow-read");
  assertEquals(scopedFirst.allow.get("read"), ["/tmp"]);
});

Deno.test("parsePermissionSet: only ALL-bare occurrences of the same flag stay unscoped (grant everything)", () => {
  // Verified live: `deno run --allow-read --allow-read probe.ts` still
  // grants everything — two bare occurrences both contribute zero scope
  // values, so the accumulated list stays empty.
  const parsed = parsePermissionSet("--allow-read --allow-read");
  assertEquals(parsed.allow.get("read"), null);
});

Deno.test("parsePermissionSet: three occurrences (scoped, bare, scoped) union to just the two scoped values", () => {
  // Verified live: `deno run --allow-read=/tmp --allow-read --allow-read=/var
  // probe.ts` grants exactly /tmp and /var, nothing else.
  const parsed = parsePermissionSet(
    "--allow-read=/tmp --allow-read --allow-read=/var",
  );
  assertEquals(parsed.allow.get("read"), ["/tmp", "/var"]);
});

Deno.test("parsePermissionSet: recognizes -A as deno's shorthand alias for --allow-all", () => {
  // Verified live: `deno run -A probe.ts` grants everything, identically to
  // `deno run --allow-all probe.ts`.
  const parsed = parsePermissionSet("deno test -A extensions/models/");
  assertEquals(parsed.allowAll, true);
  assertEquals(parsed.allow.size, 0);
});

// ============================================================================
// checkSoakAuthority — the four narrowing rules
// ============================================================================

// --- Rule (a): --allow-all in soak requires --allow-all in test ------------

Deno.test("checkSoakAuthority rule (a) VIOLATION: soak claims --allow-all but test does not grant it", () => {
  const test = { ...empty(), allow: new Map([["env", ["FC_NUM_RUNS"]]]) };
  const soak = { ...empty(), allowAll: true };
  const violations = checkSoakAuthority(test, soak);
  assert(Array.isArray(violations));
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("checkSoakAuthority rule (a) COMPLIANT: soak --allow-all is fine when test also grants --allow-all", () => {
  const test = { ...empty(), allowAll: true };
  const soak = { ...empty(), allowAll: true };
  assertEquals(checkSoakAuthority(test, soak), []);
});

// --- Rule (b): per --allow-X, test must grant it; scoped test -> scoped
// soak subset; unscoped test covers any soak scope -------------------------

Deno.test("checkSoakAuthority rule (b) COMPLIANT: soak's scoped grant is a SUBSET of test's scoped grant", () => {
  const test = { ...empty(), allow: new Map([["read", ["a", "b"]]]) };
  const soak = { ...empty(), allow: new Map([["read", ["a"]]]) };
  assertEquals(checkSoakAuthority(test, soak), []);
});

Deno.test("checkSoakAuthority rule (b) COMPLIANT: test's UNSCOPED grant covers any soak scope", () => {
  const test = { ...empty(), allow: new Map([["read", null]]) };
  const soak = { ...empty(), allow: new Map([["read", ["a"]]]) };
  assertEquals(checkSoakAuthority(test, soak), []);
});

Deno.test("checkSoakAuthority rule (b) VIOLATION: soak's scope is NOT a subset of test's scoped grant", () => {
  const test = { ...empty(), allow: new Map([["read", ["a", "b"]]]) };
  const soak = { ...empty(), allow: new Map([["read", ["a", "c"]]]) };
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("checkSoakAuthority rule (b) VIOLATION: soak widens test's scoped grant to unscoped", () => {
  const test = { ...empty(), allow: new Map([["read", ["a", "b"]]]) };
  const soak = { ...empty(), allow: new Map([["read", null]]) };
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("checkSoakAuthority rule (b) VIOLATION: soak grants a flag test lacks entirely", () => {
  const test = { ...empty(), allow: new Map([["env", ["FC_NUM_RUNS"]]]) };
  const soak = {
    ...empty(),
    allow: new Map([["env", ["FC_NUM_RUNS"]], ["net", null]]),
  };
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
});

// --- Rule (c): soak may omit a flag entirely (narrowing is the point) -----

Deno.test("checkSoakAuthority rule (c) COMPLIANT: soak omits a flag test grants — that is the whole point of narrowing", () => {
  const test = {
    ...empty(),
    allow: new Map([["net", null], ["env", ["FC_NUM_RUNS"]]]),
  };
  const soak = { ...empty(), allow: new Map([["env", ["FC_NUM_RUNS"]]]) };
  assertEquals(checkSoakAuthority(test, soak), []);
});

Deno.test("checkSoakAuthority rule (c) COMPLIANT: soak omits EVERY allow flag test grants except one — extreme narrowing is still legal", () => {
  const test = {
    ...empty(),
    allow: new Map([
      ["read", null],
      ["write", null],
      ["run", null],
      ["net", null],
      ["env", ["FC_NUM_RUNS"]],
    ]),
  };
  const soak = { ...empty(), allow: new Map([["env", ["FC_NUM_RUNS"]]]) };
  assertEquals(checkSoakAuthority(test, soak), []);
});

// --- Rule (d): every --deny-X in test must appear in soak with >= scope;
// denies may be ADDED, never removed or narrowed ----------------------------

Deno.test("checkSoakAuthority rule (d) COMPLIANT: soak preserves test's deny EXACTLY", () => {
  const test = {
    ...empty(),
    deny: new Map([["write", ["$HOME/.talos", "$HOME/.config/swamp"]]]),
  };
  const soak = {
    ...empty(),
    deny: new Map([["write", ["$HOME/.talos", "$HOME/.config/swamp"]]]),
  };
  assertEquals(checkSoakAuthority(test, soak), []);
});

Deno.test("checkSoakAuthority rule (d) COMPLIANT: soak ADDS a deny beyond what test declares", () => {
  const test = { ...empty(), deny: new Map([["write", ["$HOME/.talos"]]]) };
  const soak = {
    ...empty(),
    deny: new Map([["write", ["$HOME/.talos", "/etc"]]]),
  };
  assertEquals(checkSoakAuthority(test, soak), []);
});

Deno.test("checkSoakAuthority rule (d) VIOLATION: soak DROPS a deny test declares entirely", () => {
  const test = {
    ...empty(),
    deny: new Map([["write", ["$HOME/.talos", "$HOME/.config/swamp"]]]),
  };
  const soak = empty();
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
  assert(
    violations.some((v: Violation) => v.what.toLowerCase().includes("deny")),
    JSON.stringify(violations),
  );
});

Deno.test("checkSoakAuthority rule (d) VIOLATION: soak NARROWS test's deny scope (drops one denied path)", () => {
  const test = {
    ...empty(),
    deny: new Map([["write", ["$HOME/.talos", "$HOME/.config/swamp"]]]),
  };
  const soak = { ...empty(), deny: new Map([["write", ["$HOME/.talos"]]]) };
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
});

// --- Return type discipline: never throws -----------------------------------

Deno.test("checkSoakAuthority: returns Violation[] (array), never throws, even for a maximally-violating pair", () => {
  const test = empty();
  const soak = { ...empty(), allowAll: true };
  const violations = checkSoakAuthority(test, soak);
  assert(Array.isArray(violations));
});

// ============================================================================
// checkSoakAuthority — REAL fixtures: the three accepted overrides
// ============================================================================

Deno.test("checkSoakAuthority ACCEPTS swamp-go-brr's real override: test --allow-all, soak --allow-env=FC_NUM_RUNS", async () => {
  const test = parsePermissionSet(await readTestTask("swamp-go-brr"));
  assertEquals(test.allowAll, true, JSON.stringify(test));
  const soak = parsePermissionSet("--allow-env=FC_NUM_RUNS");
  assertEquals(checkSoakAuthority(test, soak), []);
});

Deno.test("checkSoakAuthority ACCEPTS stripe-mpp's real override: test --allow-net --allow-env, soak --allow-env", async () => {
  const test = parsePermissionSet(await readTestTask("stripe-mpp"));
  assertEquals(test.allow.get("net"), null, JSON.stringify(test));
  assertEquals(test.allow.get("env"), null, JSON.stringify(test));
  const soak = parsePermissionSet("--allow-env");
  assertEquals(checkSoakAuthority(test, soak), []);
});

Deno.test("checkSoakAuthority ACCEPTS jscad-cad's real override: test all-unscoped read/write/run/env/net, soak narrowed to read/write/env=FC_NUM_RUNS", async () => {
  const test = parsePermissionSet(await readTestTask("jscad-cad"));
  assertEquals(test.allow.size, 5, JSON.stringify(test));
  const soak = parsePermissionSet(
    "--allow-read --allow-write --allow-env=FC_NUM_RUNS",
  );
  assertEquals(checkSoakAuthority(test, soak), []);
});

// ============================================================================
// checkSoakAuthority — REAL fixtures: named rejections
// ============================================================================

Deno.test("checkSoakAuthority REJECTS dropping talm-cluster's real --deny-write=$HOME/.talos,$HOME/.config/swamp guard", async () => {
  const test = parsePermissionSet(await readTestTask("talm-cluster"));
  // Mirrors test's allow-* grants exactly but omits --deny-write entirely —
  // the regression this rule exists to catch.
  const soak = parsePermissionSet(
    "--allow-read --allow-write --allow-env=FC_NUM_RUNS",
  );
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
  assert(
    violations.some((v: Violation) => v.what.toLowerCase().includes("deny")),
  );
});

Deno.test("checkSoakAuthority REJECTS widening cadvisor's real scoped --allow-read to an unscoped grant", async () => {
  const test = parsePermissionSet(await readTestTask("cadvisor"));
  assertEquals(test.allow.get("read"), ["extensions", "fixtures"]);
  const soak = parsePermissionSet("--allow-env=FC_NUM_RUNS --allow-read");
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("checkSoakAuthority REJECTS granting --allow-net when musicbrainz's real test task never grants network access at all", async () => {
  const test = parsePermissionSet(await readTestTask("musicbrainz"));
  assertEquals(test.allow.has("net"), false, JSON.stringify(test));
  const soak = parsePermissionSet("--allow-env=FC_NUM_RUNS --allow-net");
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("checkSoakAuthority REJECTS the CRITICAL exploit fixture: a wide-then-narrow two-entry --allow-read override now unions to exceed test's authority", () => {
  // The exact scenario from the security review: test only grants read
  // scoped to ./fixtures; a two-entry override tries to smuggle in
  // /etc,/root,/home/runner as a SEPARATE occurrence, hoping a last-wins
  // parser only ever sees the second (narrow) one and lets it through. With
  // real union semantics the merged soak scope is
  // {"/etc","/root","/home/runner","./fixtures"} — NOT a subset of test's
  // {"./fixtures"} — so this MUST be rejected (before the fix, the Map-based
  // parser saw only the last occurrence, "./fixtures", and this passed
  // clean while the real nightly soak ran with read access to /etc, /root,
  // and /home/runner).
  const test = { ...empty(), allow: new Map([["read", ["./fixtures"]]]) };
  const soak = parsePermissionSet(
    "--allow-read=/etc,/root,/home/runner --allow-read=./fixtures",
  );
  const violations = checkSoakAuthority(test, soak);
  assert(violations.length > 0, JSON.stringify(violations));
  assert(
    violations.some((v: Violation) => v.rule === "soak-scope-not-subset"),
    JSON.stringify(violations),
  );
});

// ============================================================================
// isBroadGrant — the EXACT, narrow classifier: --allow-all, OR unscoped
// --allow-run/--allow-net/--allow-ffi/--allow-sys. NOTHING else. Fixtured on
// both sides with REAL extensions so the boundary is pinned permanently: the
// three broad-grant extensions in the whole repo (swamp-go-brr, stripe-mpp,
// jscad-cad — the same three with an accepted override above) must read
// TRUE; every other real fixture used elsewhere in this suite (which need
// MORE than the trivial FC_NUM_RUNS baseline but are not broad) must read
// FALSE. --allow-ffi/--allow-sys are synthetic fixtures (not fixtured
// against a real extension) — no extension in the repo uses either today.
// ============================================================================

Deno.test("isBroadGrant: TRUE for --allow-all (swamp-go-brr's real test task)", async () => {
  const permissions = parsePermissionSet(await readTestTask("swamp-go-brr"));
  assertEquals(permissions.allowAll, true, JSON.stringify(permissions));
  assertEquals(isBroadGrant(permissions), true);
});

Deno.test("isBroadGrant: TRUE for UNSCOPED --allow-run (jscad-cad's real test task)", async () => {
  const permissions = parsePermissionSet(await readTestTask("jscad-cad"));
  assertEquals(
    permissions.allow.get("run"),
    null,
    "expected jscad-cad's real test task to grant bare --allow-run",
  );
  assertEquals(isBroadGrant(permissions), true);
});

Deno.test("isBroadGrant: TRUE for UNSCOPED --allow-net (stripe-mpp's real test task)", async () => {
  const permissions = parsePermissionSet(await readTestTask("stripe-mpp"));
  assertEquals(
    permissions.allow.get("net"),
    null,
    "expected stripe-mpp's real test task to grant bare --allow-net",
  );
  assertEquals(isBroadGrant(permissions), true);
});

Deno.test("isBroadGrant: FALSE for unscoped --allow-write with no run/net/all (obsidian-vault's real test task — the ordinary temp-dir shape shared by 14 extensions)", async () => {
  const permissions = parsePermissionSet(await readTestTask("obsidian-vault"));
  assertEquals(
    permissions.allow.get("write"),
    null,
    "expected obsidian-vault's real test task to grant bare --allow-write",
  );
  assertEquals(permissions.allowAll, false);
  assertEquals(permissions.allow.has("run"), false);
  assertEquals(permissions.allow.has("net"), false);
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: FALSE for unscoped --allow-read alone", () => {
  const permissions = { ...empty(), allow: new Map([["read", null]]) };
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: FALSE for a SCOPED --allow-read (cadvisor's real test task)", async () => {
  const permissions = parsePermissionSet(await readTestTask("cadvisor"));
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: FALSE for comma-scoped --allow-env, even with two scopes (pihole's real test task)", async () => {
  const permissions = parsePermissionSet(await readTestTask("pihole"));
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: FALSE for flipper-zero's real test task — comma-scoped --allow-env plus a scoped --allow-read is NOT broad, despite needing more than the trivial baseline", async () => {
  const permissions = parsePermissionSet(await readTestTask("flipper-zero"));
  assertEquals(permissions.allowAll, false);
  assertEquals(permissions.allow.has("run"), false);
  assertEquals(permissions.allow.has("net"), false);
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: FALSE for a SCOPED --allow-net — scoping narrows net out of 'broad' too", () => {
  const permissions = {
    ...empty(),
    allow: new Map([["net", ["example.com"]]]),
  };
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: FALSE for a SCOPED --allow-run — scoping narrows run out of 'broad' too", () => {
  const permissions = { ...empty(), allow: new Map([["run", ["deno"]]]) };
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: TRUE for UNSCOPED --allow-ffi (not used by any real extension today — latent)", () => {
  const permissions = { ...empty(), allow: new Map([["ffi", null]]) };
  assertEquals(isBroadGrant(permissions), true);
});

Deno.test("isBroadGrant: TRUE for UNSCOPED --allow-sys (not used by any real extension today — latent)", () => {
  const permissions = { ...empty(), allow: new Map([["sys", null]]) };
  assertEquals(isBroadGrant(permissions), true);
});

Deno.test("isBroadGrant: FALSE for a SCOPED --allow-ffi — scoping narrows ffi out of 'broad' too", () => {
  const permissions = {
    ...empty(),
    allow: new Map([["ffi", ["libfoo.so"]]]),
  };
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: FALSE for a SCOPED --allow-sys — scoping narrows sys out of 'broad' too", () => {
  const permissions = { ...empty(), allow: new Map([["sys", ["hostname"]]]) };
  assertEquals(isBroadGrant(permissions), false);
});

Deno.test("isBroadGrant: never throws — returns a plain boolean for an empty permission set", () => {
  const result = isBroadGrant(empty());
  assertEquals(typeof result, "boolean");
  assertEquals(result, false);
});

// ============================================================================
// expandHomeTokens — ${HOME}/$HOME expansion
// ============================================================================

Deno.test("expandHomeTokens: expands a literal $HOME token", () => {
  const result = expandHomeTokens(["$HOME/.talos"], "/Users/mag1");
  assertEquals(result.violations, []);
  assertEquals(result.expanded, ["/Users/mag1/.talos"]);
});

Deno.test("expandHomeTokens: expands a literal ${HOME} token", () => {
  const result = expandHomeTokens(["${HOME}/.config/swamp"], "/Users/mag1");
  assertEquals(result.violations, []);
  assertEquals(result.expanded, ["/Users/mag1/.config/swamp"]);
});

Deno.test("expandHomeTokens: unset HOME is a VIOLATION, never a silent empty-string substitution", () => {
  const result = expandHomeTokens(["$HOME/.talos"], undefined);
  assert(Array.isArray(result.violations));
  assert(result.violations.length > 0, JSON.stringify(result));
  // The exact regression this guards: $HOME/.talos must NEVER silently become
  // /.talos (which would void the --deny-write guard it came from).
  assert(
    !result.expanded.includes("/.talos"),
    `expandHomeTokens silently substituted "" for HOME: ${
      JSON.stringify(result)
    }`,
  );
});

Deno.test("expandHomeTokens: EMPTY-STRING HOME is also a violation, not just unset", () => {
  const result = expandHomeTokens(["$HOME/.talos"], "");
  assert(result.violations.length > 0, JSON.stringify(result));
  assert(!result.expanded.includes("/.talos"));
});

Deno.test("expandHomeTokens: any OTHER unresolved $-token is a violation", () => {
  const result = expandHomeTokens(["$UNRELATED_VAR/bar"], "/Users/mag1");
  assert(result.violations.length > 0, JSON.stringify(result));
});

Deno.test("expandHomeTokens: a token with no $ at all passes through unchanged, no violation", () => {
  const result = expandHomeTokens(
    ["extensions/models/talm_cluster_property_test.ts"],
    "/Users/mag1",
  );
  assertEquals(result.violations, []);
  assertEquals(result.expanded, [
    "extensions/models/talm_cluster_property_test.ts",
  ]);
});

Deno.test("expandHomeTokens: round-trips talm-cluster's REAL deny scopes end to end", async () => {
  const test = parsePermissionSet(await readTestTask("talm-cluster"));
  const rawDenyScopes = test.deny.get("write");
  assert(rawDenyScopes, "expected talm-cluster's test task to deny-write");
  const result = expandHomeTokens(rawDenyScopes!, "/Users/mag1");
  assertEquals(result.violations, []);
  assertEquals(result.expanded, [
    "/Users/mag1/.talos",
    "/Users/mag1/.config/swamp",
  ]);
});

// ============================================================================
// validateTokenSafety — shell metacharacters in a permission token
// ============================================================================

Deno.test("validateTokenSafety: flags a semicolon shell-injection attempt", () => {
  const violations = validateTokenSafety(["--allow-read=x; rm -rf /"]);
  assert(Array.isArray(violations));
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateTokenSafety: flags a command-substitution $() form", () => {
  const violations = validateTokenSafety(["--allow-env=$(whoami)"]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateTokenSafety: flags a backtick command-substitution form", () => {
  const violations = validateTokenSafety(["--allow-env=`whoami`"]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateTokenSafety: flags a pipe form", () => {
  const violations = validateTokenSafety([
    "--allow-read=x|cat /etc/passwd",
  ]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateTokenSafety: clean, real permission tokens produce zero violations", () => {
  const violations = validateTokenSafety([
    "--allow-env=FC_NUM_RUNS",
    "--allow-read=extensions/models,fixtures",
    "--deny-write=$HOME/.talos,$HOME/.config/swamp",
  ]);
  assertEquals(violations, []);
});

// ============================================================================
// validateNoDuplicateHardRejectFlags — deno hard-rejects a repeated
// --allow-net/--allow-env/--allow-run/--allow-sys (and their --deny-*
// counterparts) outright ("cannot be used multiple times"); a soak.denoArgs
// override repeating one would parse "fine" through parsePermissionSet's
// merge logic but crash `deno test` at soak time. Empirically verified live
// against the installed deno 2.7.13 for all eight (allow/deny x
// net/env/run/sys) — AND that --allow-read/--allow-write/--allow-ffi (and
// their --deny-* counterparts) do NOT hard-reject a repeated occurrence
// (deno UNIONS these instead — see mergeScope), so the hard-reject set is
// {net, env, run, sys} exactly, not a superset.
// ============================================================================

Deno.test("validateNoDuplicateHardRejectFlags: flags a repeated --allow-net", () => {
  const violations = validateNoDuplicateHardRejectFlags([
    "--allow-net=a.com",
    "--allow-net=b.com",
  ]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateNoDuplicateHardRejectFlags: flags a repeated --allow-env", () => {
  const violations = validateNoDuplicateHardRejectFlags([
    "--allow-env=A",
    "--allow-env=B",
  ]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateNoDuplicateHardRejectFlags: flags a repeated --allow-run", () => {
  const violations = validateNoDuplicateHardRejectFlags([
    "--allow-run=a",
    "--allow-run=b",
  ]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateNoDuplicateHardRejectFlags: flags a repeated --allow-sys (verified live against deno 2.7.13 — the fresh finding this pins)", () => {
  const violations = validateNoDuplicateHardRejectFlags([
    "--allow-sys=hostname",
    "--allow-sys=uid",
  ]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateNoDuplicateHardRejectFlags: flags repeated --deny-net/--deny-env/--deny-run/--deny-sys too", () => {
  assert(
    validateNoDuplicateHardRejectFlags(["--deny-net=a.com", "--deny-net=b.com"])
      .length > 0,
  );
  assert(
    validateNoDuplicateHardRejectFlags(["--deny-env=A", "--deny-env=B"])
      .length > 0,
  );
  assert(
    validateNoDuplicateHardRejectFlags(["--deny-run=a", "--deny-run=b"])
      .length > 0,
  );
  assert(
    validateNoDuplicateHardRejectFlags([
      "--deny-sys=hostname",
      "--deny-sys=uid",
    ]).length > 0,
  );
});

Deno.test("validateNoDuplicateHardRejectFlags: does NOT flag repeated --allow-read/--allow-write/--allow-ffi (deno unions these, not a hard-reject)", () => {
  assertEquals(
    validateNoDuplicateHardRejectFlags([
      "--allow-read=/tmp",
      "--allow-read=/var",
      "--allow-write=/tmp",
      "--allow-write=/var",
      "--allow-ffi=/tmp",
      "--allow-ffi=/var",
    ]),
    [],
  );
});

Deno.test("validateNoDuplicateHardRejectFlags: does NOT flag one --allow-net + one --deny-net (different flag types, not a repeat)", () => {
  assertEquals(
    validateNoDuplicateHardRejectFlags([
      "--allow-net",
      "--deny-net=evil.example.com",
    ]),
    [],
  );
});

Deno.test("validateNoDuplicateHardRejectFlags: one violation per offending kind, not per extra occurrence", () => {
  const violations = validateNoDuplicateHardRejectFlags([
    "--allow-net=a",
    "--allow-net=b",
    "--allow-net=c",
  ]);
  assertEquals(violations.length, 1, JSON.stringify(violations));
});

// ============================================================================
// validateNoAllowAllWithOtherAllowFlags — deno hard-rejects --allow-all
// (or -A) combined with ANY other --allow-X flag outright ("cannot be used
// with"), a SEPARATE hard-reject class from validateNoDuplicateHardRejectFlags
// above (that one is about a REPEATED same-kind flag; this one fires on a
// single co-occurrence of a DIFFERENT kind). Empirically verified live
// against deno 2.7.13, end-to-end against the real exported functions:
// swamp-go-brr's real test task is bare --allow-all with no quality.yaml
// override today, so this is latent, not live — but a future human-authored
// override combining --allow-all with e.g. --allow-env would previously
// pass checkSoakAuthority + validateSoakAdequacy +
// validateNoDuplicateHardRejectFlags + validateTokenSafety clean (all four
// verified to approve it) and then hard-crash deno test's invocation before
// a single test runs.
// ============================================================================

Deno.test("validateNoAllowAllWithOtherAllowFlags: flags --allow-all combined with another --allow-X flag (verified live: deno hard-rejects this outright)", () => {
  const violations = validateNoAllowAllWithOtherAllowFlags([
    "--allow-all",
    "--allow-env=FC_NUM_RUNS",
  ]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateNoAllowAllWithOtherAllowFlags: flags -A (deno's shorthand) combined with another --allow-X flag, same as --allow-all", () => {
  const violations = validateNoAllowAllWithOtherAllowFlags([
    "-A",
    "--allow-read=/tmp",
  ]);
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateNoAllowAllWithOtherAllowFlags: does NOT flag --allow-all alone", () => {
  assertEquals(validateNoAllowAllWithOtherAllowFlags(["--allow-all"]), []);
});

Deno.test("validateNoAllowAllWithOtherAllowFlags: does NOT flag --allow-all combined with a --deny-X flag (a legitimate 'grant everything except ...' pattern deno permits — verified live)", () => {
  assertEquals(
    validateNoAllowAllWithOtherAllowFlags([
      "--allow-all",
      "--deny-read=/etc",
    ]),
    [],
  );
});

Deno.test("validateNoAllowAllWithOtherAllowFlags: does NOT flag --allow-all repeated with itself or with -A (verified live: deno permits this)", () => {
  assertEquals(
    validateNoAllowAllWithOtherAllowFlags(["--allow-all", "-A"]),
    [],
  );
});

Deno.test("validateNoAllowAllWithOtherAllowFlags: does NOT flag an ordinary permission set with no --allow-all at all", () => {
  assertEquals(
    validateNoAllowAllWithOtherAllowFlags([
      "--allow-read=/tmp",
      "--allow-env=FC_NUM_RUNS",
    ]),
    [],
  );
});

Deno.test("validateNoAllowAllWithOtherAllowFlags: reproduces the swamp-go-brr exploit fixture end-to-end (--allow-all + --allow-env=FC_NUM_RUNS, the exact combination a future human-authored override could introduce)", () => {
  const violations = validateNoAllowAllWithOtherAllowFlags([
    "--allow-all",
    "--allow-env=FC_NUM_RUNS",
  ]);
  assert(
    violations.some((v) => v.rule === "allow-all-with-other-allow-flag"),
    JSON.stringify(violations),
  );
});

// ============================================================================
// validatePropertyFilePath — safe charset for a discovered property file path
// ============================================================================

Deno.test("validatePropertyFilePath: accepts jscad-cad's real nested path", () => {
  const violations = validatePropertyFilePath(
    "extensions/models/jscad/jscad_cad_property_test.ts",
  );
  assertEquals(violations, []);
});

Deno.test("validatePropertyFilePath: flags a path containing a space", () => {
  const violations = validatePropertyFilePath(
    "extensions/models/evil file_property_test.ts",
  );
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validatePropertyFilePath: flags a path containing a semicolon", () => {
  const violations = validatePropertyFilePath(
    "extensions/models/evil;rm_property_test.ts",
  );
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validatePropertyFilePath: flags a path containing a shell-substitution token", () => {
  const violations = validatePropertyFilePath(
    "extensions/models/$(whoami)_property_test.ts",
  );
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validatePropertyFilePath: flags a path with non-ASCII characters outside the safe charset", () => {
  const violations = validatePropertyFilePath(
    "extensions/models/héllo_property_test.ts",
  );
  assert(violations.length > 0, JSON.stringify(violations));
});

// ============================================================================
// validateSoakAdequacy — no --allow-env*/--allow-all is a violation; a
// SCOPED --allow-env omitting FC_NUM_RUNS is a violation
// ============================================================================

Deno.test("validateSoakAdequacy: VIOLATION — no --allow-env at all and no --allow-all", () => {
  const violations = validateSoakAdequacy(empty());
  assert(violations.length > 0, JSON.stringify(violations));
});

Deno.test("validateSoakAdequacy: VIOLATION — scoped --allow-env omits FC_NUM_RUNS", () => {
  const soak = { ...empty(), allow: new Map([["env", ["OTHER_VAR"]]]) };
  const violations = validateSoakAdequacy(soak);
  assert(violations.length > 0, JSON.stringify(violations));
  assert(
    violations.some((v: Violation) => v.what.includes("FC_NUM_RUNS")),
    JSON.stringify(violations),
  );
});

Deno.test("validateSoakAdequacy: OK — scoped --allow-env includes FC_NUM_RUNS", () => {
  const soak = {
    ...empty(),
    allow: new Map([["env", ["FC_NUM_RUNS", "OTHER_VAR"]]]),
  };
  assertEquals(validateSoakAdequacy(soak), []);
});

Deno.test("validateSoakAdequacy: OK — bare (unscoped) --allow-env trivially covers FC_NUM_RUNS", () => {
  const soak = { ...empty(), allow: new Map([["env", null]]) };
  assertEquals(validateSoakAdequacy(soak), []);
});

Deno.test("validateSoakAdequacy: OK — --allow-all trivially covers env access", () => {
  const soak = { ...empty(), allowAll: true };
  assertEquals(validateSoakAdequacy(soak), []);
});

// ============================================================================
// Return-type discipline: every validator RETURNS Violation[], never throws
// ============================================================================

Deno.test("every validator returns an array (never throws) across a battery of malformed/failing inputs", () => {
  const results: unknown[] = [
    validateTokenSafety(["--allow-read=x; rm -rf /"]),
    validatePropertyFilePath("bad path; rm -rf /_property_test.ts"),
    validateSoakAdequacy(empty()),
    checkSoakAuthority(empty(), { ...empty(), allowAll: true }),
    expandHomeTokens(["$UNRESOLVED/x"], undefined).violations,
    validateNoDuplicateHardRejectFlags(["--allow-net=a", "--allow-net=b"]),
    validateNoAllowAllWithOtherAllowFlags(["--allow-all", "--allow-env=X"]),
  ];
  for (const result of results) {
    assert(
      Array.isArray(result),
      `expected an array, got ${JSON.stringify(result)}`,
    );
    for (const v of result as Violation[]) {
      assert(typeof v.rule === "string" && v.rule.length > 0);
      assert(typeof v.what === "string" && v.what.length > 0);
      assert(typeof v.why === "string" && v.why.length > 0);
      assert(typeof v.fix === "string" && v.fix.length > 0);
    }
  }
});
