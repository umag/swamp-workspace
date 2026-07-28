/**
 * Tests for the quality.yaml schema — the single source of truth for what
 * "compliant" means. Every invalid-mutation test below asserts a SPECIFIC
 * rejection reason, not just "parsing failed", so a future schema change
 * that silently loosens a rule shows up as a changed assertion, not a
 * vanished test.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import {
  BACKLOG_TRACKING_ISSUE,
  parseQualityFile,
  QualityFileSchema,
  REQUIRED_SUITES,
  SCHEMA_VERSION,
} from "./schema.ts";

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");

function validFixture(): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    extension: "widget",
    tests: {
      "contract-fixture": { state: "present", files: ["widget_test.ts"] },
      "methods": { state: "present", files: ["widget_methods_test.ts"] },
      "adversarial": {
        state: "backlog",
        justification:
          `seeded offender — backfill tracked in ${BACKLOG_TRACKING_ISSUE}`,
      },
      "coverage": {
        state: "backlog",
        justification:
          `seeded offender — backfill tracked in ${BACKLOG_TRACKING_ISSUE}`,
      },
      "property-invariant-flow": {
        state: "na",
        justification: "widget has no numeric invariants to fuzz at all",
      },
    },
    watch: {
      state: "backlog",
      justification:
        `no release-watch yet — backfill tracked in ${BACKLOG_TRACKING_ISSUE}`,
    },
    canary: {
      state: "na",
      justification: "no live instance exists for widget in this homelab",
    },
    docs: {
      readme: { state: "present", files: ["README.md"] },
      changelog: {
        state: "backlog",
        justification:
          `no CHANGELOG.md yet — tracked in ${BACKLOG_TRACKING_ISSUE}`,
      },
      skill: { state: "na", justification: "widget bundles no Claude skill" },
    },
    ratchet: { rubricVersion: 3, baselinePercentage: 100, label: "Grade A" },
  };
}

Deno.test("QualityFileSchema accepts a valid fixture", () => {
  const result = QualityFileSchema.safeParse(validFixture());
  assert(
    result.success,
    JSON.stringify(!result.success && result.error.issues),
  );
});

Deno.test("parseQualityFile accepts a valid fixture when allowlisted", () => {
  const result = parseQualityFile(validFixture(), {
    expectedExtension: "widget",
    isAllowlisted: true,
  });
  assert(result.ok, JSON.stringify(!result.ok && result.errors));
});

/** Test-only helper: `validFixture()` types `tests` loosely enough (a plain
 * object of suite-name -> entry) that mutation tests can replace one suite's
 * entry without an `any` cast — the entry itself is still a plain record, so
 * this stays honest about "we are constructing invalid input on purpose"
 * without disabling the type checker. */
function replaceSuite(
  fixture: Record<string, unknown>,
  suite: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const tests = {
    ...(fixture.tests as Record<string, unknown>),
    [suite]: entry,
  };
  return { ...fixture, tests };
}

Deno.test("rejects na state with a too-short justification", () => {
  const fixture = replaceSuite(validFixture(), "property-invariant-flow", {
    state: "na",
    justification: "too short",
  });
  const result = QualityFileSchema.safeParse(fixture);
  assert(!result.success);
  assertStringIncludes(
    result.error!.issues.map((issue) => issue.message).join("\n"),
    "12",
  );
});

Deno.test("rejects backlog state missing the Phase D tracking issue", () => {
  const fixture = replaceSuite(validFixture(), "adversarial", {
    state: "backlog",
    justification: "we just haven't gotten to this suite yet at all",
  });
  const result = QualityFileSchema.safeParse(fixture);
  assert(!result.success);
  assertStringIncludes(
    result.error!.issues.map((issue) => issue.message).join("\n"),
    BACKLOG_TRACKING_ISSUE,
  );
});

Deno.test("rejects present state with an empty files[] array", () => {
  const fixture = replaceSuite(validFixture(), "methods", {
    state: "present",
    files: [],
  });
  const result = QualityFileSchema.safeParse(fixture);
  assert(!result.success);
});

Deno.test("rejects unknown top-level keys (strict, no passthrough)", () => {
  const fixture = { ...validFixture(), extraField: "nope" };
  const result = QualityFileSchema.safeParse(fixture);
  assert(!result.success);
});

Deno.test("rejects unknown keys inside a suite entry", () => {
  const fixture = replaceSuite(validFixture(), "methods", {
    state: "present",
    files: ["x.ts"],
    extra: true,
  });
  const result = QualityFileSchema.safeParse(fixture);
  assert(!result.success);
});

Deno.test("parseQualityFile rejects extension name mismatch", () => {
  const result = parseQualityFile(validFixture(), {
    expectedExtension: "not-widget",
    isAllowlisted: true,
  });
  assert(!result.ok);
  assertStringIncludes(result.ok ? "" : result.errors.join("\n"), "not-widget");
});

Deno.test("parseQualityFile rejects a backlog suite when the extension is not allowlisted", () => {
  const result = parseQualityFile(validFixture(), {
    expectedExtension: "widget",
    isAllowlisted: false,
  });
  assert(!result.ok);
  assertStringIncludes(
    result.ok ? "" : result.errors.join("\n"),
    "allowlist",
  );
});

Deno.test("parseQualityFile does not flag na states when not allowlisted", () => {
  // A fixture whose non-present suites/watch/docs are ALL "na" (never
  // "backlog") must parse cleanly even when the extension is NOT on the
  // allowlist — na is a permanent exemption, not allowlist-gated debt.
  let fixture = validFixture();
  const tests = fixture.tests as Record<string, { state: string }>;
  for (const suite of REQUIRED_SUITES) {
    if (tests[suite].state === "backlog") {
      fixture = replaceSuite(fixture, suite, {
        state: "na",
        justification: "permanently not applicable to this extension",
      });
    }
  }
  fixture.watch = {
    state: "na",
    justification: "no external dependency to watch for this extension",
  };
  fixture.docs = {
    ...(fixture.docs as Record<string, unknown>),
    changelog: {
      state: "na",
      justification: "unreleased; no changelog needed yet at all",
    },
  };
  const result = parseQualityFile(fixture, {
    expectedExtension: "widget",
    isAllowlisted: false,
  });
  assert(result.ok, JSON.stringify(!result.ok && result.errors));
});

Deno.test("REQUIRED_SUITES has exactly five entries by role, not filename convention", () => {
  assertEquals(REQUIRED_SUITES.length, 5);
  assertEquals(
    [...REQUIRED_SUITES].sort(),
    [
      "adversarial",
      "methods",
      "contract-fixture",
      "coverage",
      "property-invariant-flow",
    ].sort(),
  );
});

Deno.test("STANDARD.md's declared suite list matches REQUIRED_SUITES exactly (single source of truth)", async () => {
  const standard = await Deno.readTextFile(join(REPO_ROOT, "STANDARD.md"));
  const start = standard.indexOf("<!-- REQUIRED_SUITES:START -->");
  const end = standard.indexOf("<!-- REQUIRED_SUITES:END -->");
  assert(
    start !== -1 && end !== -1 && end > start,
    "STANDARD.md must contain a REQUIRED_SUITES:START/END marker block",
  );
  const block = standard.slice(start, end);
  const listed = [...block.matchAll(/^- `([a-z-]+)`/gm)].map((m) => m[1]);
  assertEquals(listed.sort(), [...REQUIRED_SUITES].sort());
});

Deno.test("canary present state requires instance + method, args defaults to {}", () => {
  const fixture = validFixture();
  fixture.canary = {
    state: "present",
    instance: "my-widget-instance",
    method: "lookup",
  };
  const result = QualityFileSchema.safeParse(fixture);
  assert(
    result.success,
    JSON.stringify(!result.success && result.error.issues),
  );
  if (result.success) {
    assertEquals(result.data.canary, {
      state: "present",
      instance: "my-widget-instance",
      method: "lookup",
      args: {},
    });
  }
});

Deno.test("canary present state accepts an optional assert CEL and fixture redact list", () => {
  const fixture = validFixture();
  fixture.canary = {
    state: "present",
    instance: "my-widget-instance",
    method: "lookup",
    args: { id: "abc" },
    assert: "data.latest('widget', 'lookup').attributes.status == 'ok'",
    fixture: { method: "lookup", redact: ["$.secretKey", "$.token"] },
  };
  const result = QualityFileSchema.safeParse(fixture);
  assert(
    result.success,
    JSON.stringify(!result.success && result.error.issues),
  );
});

Deno.test("watch present state requires at least one source entry", () => {
  const fixture = validFixture();
  fixture.watch = { state: "present", sources: [] };
  const result = QualityFileSchema.safeParse(fixture);
  assert(!result.success);
});

Deno.test("watch present state accepts a valid Phase-B source (deep validation via watch_schema.ts)", () => {
  const fixture = validFixture();
  fixture.watch = {
    state: "present",
    issueLabel: "mppx-release-watch",
    sources: [{
      kind: "npm",
      package: "mppx",
      channel: "latest",
      pin: {
        from: "source",
        file: "extensions/models/stripe_mpp.ts",
        pattern: 'npm:mppx@([0-9][^/"]*)',
        required: true,
      },
    }],
  };
  const result = QualityFileSchema.safeParse(fixture);
  assert(
    result.success,
    JSON.stringify(!result.success && result.error.issues),
  );
});

Deno.test("watch present state REJECTS a malformed source (no more opaque passthrough)", () => {
  // The original Phase-A schema passed sources[] through unvalidated with a
  // TODO to wire scripts/lib/watch_schema.ts once it existed. It exists now
  // — a source that satisfies neither arm of the four-kind union (here: the
  // retired `distTag` field instead of `channel` + `pin`) must fail the
  // compliance gate, not slide through to a runtime resolver error.
  const fixture = validFixture();
  fixture.watch = {
    state: "present",
    issueLabel: "mppx-release-watch",
    sources: [{ kind: "npm", package: "mppx", distTag: "latest" }],
  };
  const result = QualityFileSchema.safeParse(fixture);
  assert(!result.success);
});
