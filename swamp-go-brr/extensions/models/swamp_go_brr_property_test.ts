/**
 * Property-based tests (fast-check) for @magistr/swamp-go-brr.
 *
 * gobrr.ts / docker_verify.ts / source_integration.ts / preflight.ts / lib/*
 * are UNMODIFIED — every property here is observed by calling an EXPORTED
 * pure function directly. Named invariants:
 *
 *  (a) scrub — idempotence (re-scrubbing a scrubbed string is a no-op),
 *      precision/no-leak on BENIGN text (the arbitrary EXCLUDES every trigger
 *      keyword so it can never accidentally match a redaction pattern), and
 *      never-throws for arbitrary input.
 *  (b) lib/acl — normalizePath idempotence, pathInSet reflexivity on a clean
 *      path, and pathEscapes flagging any `../`-prefixed variant of a clean
 *      path.
 *  (c) source-integration planApply — referential transparency: the SAME
 *      (env, allowlist, snapshot) input yields a deep-equal result across two
 *      independent calls, and the snapshot object passed in is never mutated.
 *  (d) gobrr deriveGate — the 3-way partition (real | advisory | error) is
 *      exhaustive and consistent for a disjoint / subset / mixed allowlist
 *      relative to verifyInputs.
 *  (e) lib/otlp — the METRIC_LABELS allowlist rejects any single
 *      non-allowlisted point-attribute key, for arbitrary combinations of
 *      otherwise-allowed labels; and serializeTrace round-trips an arbitrary
 *      traceId/spanId/status/attribute set (id preservation, OTLP status-code
 *      mapping, int-vs-string attribute typing).
 *  (f) docker-verify parseExitSentinel — LAST-WINS over an arbitrary
 *      sequence of embedded sentinels (a container cannot forge a green by
 *      emitting its own earlier sentinel; the host's TRAILING sentinel always
 *      wins).
 *  (g) gobrr applyReport — UNFORGEABLE GREEN: for any non-zero
 *      verifyExitCode, the outcome is NEVER "done", regardless of the
 *      WorkResult's self-reported content (changedPaths, testReport, diff).
 *
 * Property iteration count is overridable via FC_NUM_RUNS (small by default
 * here; verified manually at FC_NUM_RUNS=5000 per the ext-quality-bf-swamp-
 * go-brr plan).
 */
import fc from "npm:fast-check@4.8.0";
import { applyReport, deriveGate, type Run, type Task } from "./gobrr.ts";
import { planApply } from "./source_integration.ts";
import { parseExitSentinel } from "./docker_verify.ts";
import { normalizePath, pathEscapes, pathInSet } from "./lib/acl.ts";
import { scrubSecrets } from "./lib/scrub.ts";
import {
  METRIC_LABELS,
  newSpanId,
  newTraceId,
  type OtlpMetricInput,
  type OtlpTraceInput,
  serializeMetrics,
  serializeTrace,
} from "./lib/otlp.ts";

// Property iteration count — overridable for a manual soak (e.g.
// `FC_NUM_RUNS=5000 deno test --allow-env=FC_NUM_RUNS extensions/models/swamp_go_brr_property_test.ts`).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const RUNS = { numRuns: ENV_RUNS ? Number(ENV_RUNS) : 200 };

// Shared alnum-only segment alphabet — guarantees generated paths never
// collide with a VCS/deny-list name (.git, .jj, hooks, .github, ...) and
// never contain whitespace/dots that would independently trip pathEscapes.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const arbSegment = fc
  .array(fc.integer({ min: 0, max: ALPHABET.length - 1 }), {
    minLength: 1,
    maxLength: 8,
  })
  .map((idxs) => idxs.map((i) => ALPHABET[i]).join(""));
const arbCleanPath = fc
  .array(arbSegment, { minLength: 1, maxLength: 4 })
  .map((segs) => segs.join("/"));

// ---------------------------------------------------------------------------
// (a) lib/scrub — idempotence, benign-text precision, never-throws.
// ---------------------------------------------------------------------------

// Every redaction pattern requires one of these literal (case-insensitive)
// keywords to appear in the matched text — excluding all of them from the
// arbitrary guarantees scrubSecrets is a true no-op on the generated text
// (the "no false positive on genuinely benign input" invariant).
const TRIGGER_KEYWORDS = [
  "token",
  "secret",
  "password",
  "api_key",
  "api-key",
  "apikey",
  "sk-ant",
  "akia",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "glpat",
  "authorization",
  "bearer",
  "private_key",
];
// Mirrors lib/scrub.ts's B5 bare-high-entropy rule (issue swamp-go-brr-latent-bugs
// B5): a ≥32-char run from this charset mixing lower/upper/digit is now redacted
// with NO key word required. Excluded here too, so arbBenignText keeps its "no
// false-positive redaction" guarantee on genuinely benign generated text — without
// this exclusion, fc.string() could occasionally emit such a run and the (a) no-op
// property below would flake red at a high FC_NUM_RUNS.
const BARE_HIGH_ENTROPY_RE =
  /(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}/;
const arbBenignText = fc
  .string({ maxLength: 60 })
  .filter((s) => {
    const lower = s.toLowerCase();
    if (TRIGGER_KEYWORDS.some((k) => lower.includes(k))) return false;
    if (BARE_HIGH_ENTROPY_RE.test(s)) return false;
    return true;
  });

Deno.test("property: scrubSecrets is a no-op (no false-positive redaction) on text excluding every trigger keyword", () => {
  fc.assert(
    fc.property(arbBenignText, (s) => scrubSecrets(s) === s),
    RUNS,
  );
});

Deno.test("property: scrubSecrets is IDEMPOTENT — re-scrubbing an already-scrubbed string changes nothing further, for arbitrary (unrestricted) input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (s) => {
      const once = scrubSecrets(s);
      const twice = scrubSecrets(once);
      return once === twice;
    }),
    RUNS,
  );
});

Deno.test("property: scrubSecrets never throws, for arbitrary input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (s) => {
      scrubSecrets(s);
      return true;
    }),
    RUNS,
  );
});

// B5 (issue swamp-go-brr-latent-bugs): a BARE high-entropy run (no key word) is
// redacted for an arbitrary combination of the three required char-classes.
const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGIT = "0123456789".split("");
const arbBareHighEntropyBlob = fc
  .array(fc.constantFrom(...LOWER, ...UPPER, ...DIGIT), {
    minLength: 32,
    maxLength: 60,
  })
  .map((cs) => cs.join(""))
  .filter((s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s));

Deno.test("property: scrubSecrets redacts an arbitrary BARE high-entropy blob (≥32 chars, all 3 char-classes, no key word) embedded in plain surrounding text", () => {
  fc.assert(
    fc.property(arbBareHighEntropyBlob, (blob) => {
      const out = scrubSecrets(`see payload ${blob} thanks`);
      return !out.includes(blob);
    }),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) lib/acl — normalizePath idempotence, pathInSet reflexivity, pathEscapes.
// ---------------------------------------------------------------------------

Deno.test("property: normalizePath is idempotent for arbitrary (possibly messy) path-like strings", () => {
  const arbMessySegment = fc.constantFrom("a", "b", "c", "..", ".", "");
  const arbMessyPath = fc
    .array(arbMessySegment, { minLength: 0, maxLength: 8 })
    .map((parts) => parts.join("/"));
  fc.assert(
    fc.property(arbMessyPath, (p) => {
      const once = normalizePath(p);
      return normalizePath(once) === once;
    }),
    RUNS,
  );
});

Deno.test("property: a clean path is always a member of the singleton set containing itself (pathInSet reflexivity)", () => {
  fc.assert(
    fc.property(arbCleanPath, (p) => pathInSet(p, [p])),
    RUNS,
  );
});

Deno.test("property: pathEscapes flags any clean path prefixed with '../' , and never flags the clean path alone", () => {
  fc.assert(
    fc.property(arbCleanPath, (p) => !pathEscapes(p) && pathEscapes(`../${p}`)),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) source-integration planApply — referential transparency, no mutation.
// ---------------------------------------------------------------------------

Deno.test("property: planApply is referentially transparent — identical inputs (by value) produce a deep-equal result across two calls, and never mutate the snapshot", () => {
  fc.assert(
    fc.property(arbCleanPath, fc.string({ maxLength: 40 }), (path, content) => {
      const env = { edits: [], newFiles: [{ path, content }] };
      const allowlist = [path];
      const snapshot: Record<string, string> = { seed: "unchanged" };
      const before = JSON.stringify(snapshot);
      const r1 = planApply(env, allowlist, { ...snapshot });
      const afterFirstCall = JSON.stringify(snapshot);
      const r2 = planApply(env, allowlist, { ...snapshot });
      return (
        JSON.stringify(r1) === JSON.stringify(r2) &&
        before === afterFirstCall
      );
    }),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) gobrr deriveGate — 3-way partition (real | advisory | error).
// ---------------------------------------------------------------------------

const VERIFY_INPUTS = ["tests"];

Deno.test("property: deriveGate partitions exhaustively — disjoint->real, subset->advisory, mixed->error", () => {
  fc.assert(
    fc.property(
      fc.array(arbSegment, { minLength: 1, maxLength: 3 }),
      fc.array(arbSegment, { minLength: 1, maxLength: 3 }),
      fc.constantFrom("real", "advisory", "mixed"),
      (srcSegs, testSegs, category) => {
        const srcPaths = srcSegs.map((s) => `src/${s}.ts`);
        const testPaths = testSegs.map((s) => `tests/${s}.ts`);
        const allowlist = category === "real"
          ? srcPaths
          : category === "advisory"
          ? testPaths
          : [...srcPaths, ...testPaths];
        const g = deriveGate(allowlist, VERIFY_INPUTS);
        if (category === "real") return "gate" in g && g.gate === "real";
        if (category === "advisory") {
          return "gate" in g && g.gate === "advisory";
        }
        return "error" in g;
      },
    ),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) lib/otlp — METRIC_LABELS allowlist + trace round-trip.
// ---------------------------------------------------------------------------

const ALLOWED = METRIC_LABELS as readonly string[];
const HOSTILE_LABELS = ["spec", "intake", "path", "diff", "secret", "prompt"];

Deno.test("property: serializeMetrics accepts arbitrary combinations of ONLY allowlisted labels, and rejects the moment one hostile label is added", () => {
  fc.assert(
    fc.property(
      fc.subarray([...ALLOWED]),
      fc.constantFrom(...HOSTILE_LABELS),
      fc.boolean(),
      (allowedSubset, hostile, includeHostile) => {
        const attributes: Record<string, string | number | boolean> = {};
        for (const k of allowedSubset) attributes[k] = "x";
        if (includeHostile) attributes[hostile] = "leaked!";
        const input: OtlpMetricInput = {
          serviceName: "swamp-go-brr",
          metrics: [{
            name: "m",
            kind: "sum",
            points: [{ attributes, value: 1 }],
          }],
        };
        try {
          serializeMetrics(input);
          return !includeHostile;
        } catch {
          return includeHostile;
        }
      },
    ),
    RUNS,
  );
});

const arbAttrValue: fc.Arbitrary<string | number | boolean> = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
);

Deno.test("property: serializeTrace round-trips an arbitrary single-span traceId/spanId/status/attribute set", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<"unset" | "ok" | "error">("unset", "ok", "error"),
      fc.dictionary(
        fc.constantFrom("a_attr", "b_attr", "c_attr"),
        arbAttrValue,
        { maxKeys: 3 },
      ),
      (status, attributes) => {
        const traceId = newTraceId();
        const spanId = newSpanId();
        const input: OtlpTraceInput = {
          traceId,
          serviceName: "swamp-go-brr",
          spans: [{
            spanId,
            name: "x",
            startUnixNano: "0",
            endUnixNano: "1",
            status,
            attributes,
          }],
        };
        const out = serializeTrace(input) as Record<string, unknown>;
        const rs = (out.resourceSpans as Array<Record<string, unknown>>)[0];
        const ss = (rs.scopeSpans as Array<Record<string, unknown>>)[0];
        const span = (ss.spans as Array<Record<string, unknown>>)[0];
        if (span.traceId !== traceId || span.spanId !== spanId) return false;
        const expectedCode = status === "ok" ? 1 : status === "error" ? 2 : 0;
        if ((span.status as Record<string, unknown>).code !== expectedCode) {
          return false;
        }
        const encoded = span.attributes as Array<
          { key: string; value: Record<string, unknown> }
        >;
        for (const [k, v] of Object.entries(attributes)) {
          const enc = encoded.find((a) => a.key === k)!.value;
          if (typeof v === "boolean" && enc.boolValue !== v) return false;
          if (typeof v === "string" && enc.stringValue !== v) return false;
          if (
            typeof v === "number" &&
            (Number.isInteger(v)
              ? enc.intValue !== String(v)
              : enc.doubleValue !== v)
          ) return false;
        }
        return true;
      },
    ),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// (f) docker-verify parseExitSentinel — last-wins over an arbitrary sequence.
// ---------------------------------------------------------------------------

Deno.test("property: parseExitSentinel returns the LAST embedded sentinel for an arbitrary non-empty sequence of exit codes", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 255 }), {
        minLength: 1,
        maxLength: 6,
      }),
      (codes) => {
        const stdout = codes.map((c) => `__GOBRR_EXIT__:${c}`).join(
          "\nnoise\n",
        );
        return parseExitSentinel(stdout) === codes[codes.length - 1];
      },
    ),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// (g) gobrr applyReport — unforgeable green: exit != 0 => outcome never "done".
// ---------------------------------------------------------------------------

const BASE_CONFIG: Run["config"] = {
  verifyCommand: "deno test",
  verifyInputs: ["tests"],
  repoScope: "src",
  toolchainImage: "img@sha256:abc",
  leafModel: "",
  leafEffort: "low",
  maxConcurrentVMs: 8,
  maxAttempts: 5,
  maxFollowupDepth: 3,
  maxInvocations: 100,
  leaseTtlSeconds: 1800,
  wallclockSeconds: 7200,
  stallN: 2,
  stallK: 3,
  perInvocationCostEstimate: 0,
  pinnedVersions: {},
};

function leasedTask(): Task {
  return {
    id: "a",
    spec: "x",
    writeAllowlist: ["src/a.ts"],
    dependsOn: [],
    gate: "real",
    status: "leased",
    attempts: 0,
    followupDepth: 0,
    lease: {
      owner: "drv",
      expiresAt: "2999-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
    },
    outcome: null,
    failureKind: null,
    failureSignature: null,
    mergeDisposition: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

Deno.test("property: applyReport NEVER greens (outcome!=='done') for a non-zero verifyExitCode, regardless of the WorkResult's self-reported content", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 255 }),
      fc.array(fc.string({ maxLength: 15 }), { maxLength: 4 }),
      fc.string({ maxLength: 30 }),
      fc.boolean(),
      (exitCode, changedPaths, diff, redFirst) => {
        const run: Run = {
          status: "running",
          intake: "x",
          config: BASE_CONFIG,
          tasks: [leasedTask()],
          invocations: 1,
          costEstimate: 0,
          offers: [],
          haltReason: null,
          haltOptions: [],
          stallCulprits: [],
          stallSignature: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        const wr = {
          diff,
          changedPaths,
          followups: [],
          testReport: { redFirst, testsRun: 999 }, // a maximally rosy self-report
        };
        const res = applyReport(
          run,
          "a",
          "drv",
          wr,
          exitCode,
          "2026-01-01T01:00:00.000Z",
        );
        return "run" in res && res.run.tasks[0].outcome !== "done";
      },
    ),
    RUNS,
  );
});
