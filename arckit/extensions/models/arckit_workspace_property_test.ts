/**
 * Property-based tests (fast-check) for @magistr/arckit/workspace
 * (arckit_workspace.ts, BYTE-FROZEN). Honors `FC_NUM_RUNS` for the nightly
 * soak (`deno task test:soak`). Every arbitrary is RESTRICTED to the region
 * where the invariant genuinely holds, per this backfill's property
 * discipline (two flaky property tests already cost master-CI reds):
 *
 *  (a) slugify — for ANY string: non-empty, only [a-z0-9-]+, and idempotent
 *      (slugify(slugify(x)) === slugify(x)).
 *  (b) parseArtifactFilename round-trip — restricted to (a real DOC_CODES
 *      key) x (3-digit id) x (optional 0-999 instance) x (simple dotted
 *      version) x (md|json|html format); empirically verified collision-free
 *      across ALL 62 real codes before writing this property (the
 *      longest-match-first scan never picks a WRONG code for a
 *      code-derived filename).
 *  (c) nextProjectDir monotonic + boundary-safe — ids restricted to <=998 so
 *      the 3-digit invariant holds; LB5 (arckit-latent-bugs) is the >999
 *      boundary and is EXCLUDED here (pinned separately in the adversarial
 *      and coverage suites).
 *  (d) evaluateGate monotonicity — adding MORE present commands never turns
 *      a satisfied gate unsatisfied, for any phase/profile.
 *  (e) computeGaps counting invariants — violationCount === violations.length,
 *      projectsWithViolations/totalViolations agree with a manual recount,
 *      restricted to the real MANDATORY_DEPS/CRITICAL_PATH vocabulary.
 *  (f) proposeClassification — second-pass idempotence holds for ANY text
 *      (the five mapped target strings are never themselves members of the
 *      source enum, so a second pass can never find a further match); a
 *      restricted arbitrary over the 5 recognized values also pins the
 *      exact CLASSIFICATION_MAPPING target for each.
 *  (g) phase-progression flow — for any of the 4 profiles, driving
 *      startProject + advance() exactly PHASES.length times (with every
 *      phase's gate artifact pre-seeded) reaches "complete"; small (4-value)
 *      domain, so numRuns is capped low regardless of FC_NUM_RUNS.
 *  (h) template-render determinism — template() called twice for the same
 *      command against the same synthetic bundle returns byte-identical
 *      content both times, for any of a curated set of commands.
 */
import { assert } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  COMMAND_TO_CODE,
  computeGaps,
  DOC_CODES,
  evaluateGate,
  gateFor,
  model,
  nextProjectDir,
  parseArtifactFilename,
  parseProjectDir,
  PHASES,
  PROFILES,
  proposeClassification,
  slugify,
} from "./arckit_workspace.ts";
import {
  makeCtx,
  run,
  withTempWorkspace,
  writeArtifact,
  writeTemplateFile,
} from "./fixtures/workspace.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// (a) slugify — charset, non-empty, idempotence, for ANY string
// ---------------------------------------------------------------------------

Deno.test("property: slugify(x) is always a non-empty [a-z0-9-]+ string, and is idempotent, for ANY input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (s) => {
      const once = slugify(s);
      const twice = slugify(once);
      return once.length > 0 && /^[a-z0-9-]+$/.test(once) && twice === once;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) parseArtifactFilename round-trip — restricted to the real DOC_CODES
// vocabulary, where longest-match-first is empirically collision-free.
// ---------------------------------------------------------------------------

const codeArb = fc.constantFrom(...Object.keys(DOC_CODES));
const idArb = fc.integer({ min: 0, max: 999 }).map((n) =>
  String(n).padStart(3, "0")
);
const versionArb = fc
  .array(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join("."));
const formatArb = fc.constantFrom("md", "json", "html");
const instanceArb = fc.option(fc.integer({ min: 0, max: 999 }), {
  nil: undefined,
});

Deno.test("property: parseArtifactFilename round-trips ARC-{id}-{code}[-{instance}]-v{version}.{format} for any real DOC_CODES key", () => {
  fc.assert(
    fc.property(
      idArb,
      codeArb,
      instanceArb,
      versionArb,
      formatArb,
      (id, code, instance, version, format) => {
        const middle = instance === undefined ? code : `${code}-${instance}`;
        const filename = `ARC-${id}-${middle}-v${version}.${format}`;
        const r = parseArtifactFilename(filename);
        if (!r) return false;
        if (r.projectId !== id) return false;
        if (r.docType !== code) return false;
        if (r.command !== DOC_CODES[code]) return false;
        if (r.version !== version) return false;
        if (r.format !== format) return false;
        return r.instance === instance;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) nextProjectDir — monotonic + boundary-safe for ids <= 998 (LB5's >999
// boundary is excluded here; see arckit-latent-bugs LB5, pinned separately)
// ---------------------------------------------------------------------------

const safeIdArb = fc.integer({ min: 0, max: 998 });

Deno.test("property: nextProjectDir(existing, slug) always allocates max(existing)+1, round-trippable by parseProjectDir, for any set of ids <= 998", () => {
  fc.assert(
    fc.property(
      fc.array(safeIdArb, { maxLength: 15 }),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
      (ids, slug) => {
        const existing = ids.map((n) => `${String(n).padStart(3, "0")}-x`);
        const max = ids.length ? Math.max(...ids) : 0;
        const dir = nextProjectDir(existing, slug);
        const parsed = parseProjectDir(dir);
        if (!parsed) return false;
        return Number(parsed.id) === max + 1 && parsed.name === slug;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) evaluateGate monotonicity — a superset of present commands never
// un-satisfies a group that was already satisfied, for any phase/profile.
// ---------------------------------------------------------------------------

const ALL_COMMANDS = Object.values(DOC_CODES);
const commandArb = fc.constantFrom(...ALL_COMMANDS);
const phaseArb = fc.constantFrom(...PHASES);
const profileArb = fc.constantFrom(...PROFILES);

Deno.test("property: evaluateGate is monotonic — adding more present commands never turns a satisfied group unsatisfied, for any phase/profile", () => {
  fc.assert(
    fc.property(
      phaseArb,
      profileArb,
      fc.array(commandArb, { maxLength: 6 }),
      fc.array(commandArb, { maxLength: 6 }),
      (phase, profile, base, extra) => {
        const before = evaluateGate(base, phase, profile);
        const after = evaluateGate([...base, ...extra], phase, profile);
        // every group satisfied in `before` must still be satisfied `after`
        for (let i = 0; i < before.groups.length; i++) {
          if (before.groups[i].satisfied && !after.groups[i].satisfied) {
            return false;
          }
        }
        if (before.satisfied && !after.satisfied) return false;
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) computeGaps counting invariants — restricted to the real command
// vocabulary (MANDATORY_DEPS keys/values), for any generated project set.
// ---------------------------------------------------------------------------

const projectArb = fc.record({
  dir: fc.stringMatching(/^[0-9]{3}-[a-z]{1,6}$/),
  isGlobal: fc.boolean(),
  commands: fc.array(commandArb, { maxLength: 5 }),
}).map((p) => ({
  dir: p.dir,
  id: p.dir.slice(0, 3),
  name: p.dir.slice(4),
  isGlobal: p.isGlobal,
  commands: p.commands,
}));

Deno.test("property: computeGaps' counters always agree with a manual recount, for any generated project/command set", () => {
  fc.assert(
    fc.property(
      fc.array(projectArb, { maxLength: 8 }),
      (projects) => {
        const gaps = computeGaps(projects);
        for (const p of gaps.projects) {
          if (p.violationCount !== p.violations.length) return false;
        }
        const withViolations =
          gaps.projects.filter((p) => p.violationCount > 0).length;
        if (gaps.summary.projectsWithViolations !== withViolations) {
          return false;
        }
        const total = gaps.projects.reduce((n, p) => n + p.violationCount, 0);
        if (gaps.summary.totalViolations !== total) return false;
        const nonGlobalCount = projects.filter((p) => !p.isGlobal).length;
        return gaps.summary.projectCount === nonGlobalCount;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (f) proposeClassification — universal second-pass idempotence, plus a
// restricted arbitrary pinning the exact mapping for each recognized value.
// ---------------------------------------------------------------------------

Deno.test("property: proposeClassification's SECOND application always yields zero further changes, for ANY text", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), (text) => {
      const first = proposeClassification(text);
      const second = proposeClassification(first.newText);
      return second.changes.length === 0 && second.newText === first.newText;
    }),
    FC_RUNS,
  );
});

const CLASSIFICATION_VALUES = [
  "PUBLIC",
  "OFFICIAL",
  "OFFICIAL-SENSITIVE",
  "SECRET",
  "TOP SECRET",
] as const;
const CLASSIFICATION_TARGETS: Record<string, string> = {
  "PUBLIC": "Open",
  "OFFICIAL": "Shared",
  "OFFICIAL-SENSITIVE": "Confidential",
  "SECRET": "Secret",
  "TOP SECRET": "Top Secret",
};

Deno.test("property: proposeClassification maps every recognized value to its documented UAE Smart Data target, for any surrounding table text", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...CLASSIFICATION_VALUES),
      fc.stringMatching(/^[a-zA-Z0-9 _-]{0,20}$/),
      (value, filler) => {
        const text = `${filler}\n| **Classification** | ${value} |\n${filler}`;
        const { changes, newText } = proposeClassification(text);
        if (changes.length !== 1) return false;
        if (changes[0].from !== value) return false;
        if (changes[0].to !== CLASSIFICATION_TARGETS[value]) return false;
        return newText.includes(
          `| **Classification** | ${CLASSIFICATION_TARGETS[value]} |`,
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (g) phase-progression flow — reaches "complete" in exactly PHASES.length
// advance() calls, for any profile. Small (4-value) domain: numRuns is
// capped independent of FC_NUM_RUNS to keep the soak run fast — the
// interesting variable here is WHICH profile, not how many samples.
// ---------------------------------------------------------------------------

Deno.test("property: advance() reaches complete in exactly PHASES.length calls, for any profile, once every phase's gate artifact is present", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await fc.assert(
      fc.asyncProperty(profileArb, async (profile) => {
        // One artifact per distinct command required by ANY phase's gate
        // under this profile (base + profile extras) — enough to satisfy
        // every phase's gate simultaneously, regardless of visit order.
        const needed = new Set<string>();
        for (const phase of PHASES) {
          for (const group of gateFor(phase, profile)) needed.add(group[0]);
        }
        for (const command of needed) {
          const docCode = COMMAND_TO_CODE[command];
          await writeArtifact(
            root,
            "001-flow",
            `ARC-001-${docCode}-v1.0.md`,
          );
        }

        // Fresh ctx => fresh in-memory state, independent of any other
        // iteration that reused the same physical `root`/artifacts.
        const { ctx, written } = makeCtx(root, templatesDir);
        await run(model, "startProject", {
          title: "flow",
          profile,
          dir: "001-flow",
        }, ctx);

        const seen: string[] = [];
        for (let i = 0; i < PHASES.length; i++) {
          await run(model, "advance", { project: "001-flow" }, ctx);
          seen.push(written[written.length - 1].payload.state as string);
        }
        if (seen[seen.length - 1] !== "complete") return false;
        return seen.slice(0, -1).every((s, i) => s === PHASES[i + 1]);
      }),
      { numRuns: Math.min(FC_RUNS.numRuns, 20) },
    );
  });
});

// ---------------------------------------------------------------------------
// (h) template-render determinism — calling template() twice for the same
// command against the same synthetic bundle is byte-identical both times.
// ---------------------------------------------------------------------------

const RENDER_COMMANDS = ["requirements", "risk", "adr"] as const;

Deno.test("property: template() renders byte-identical content across repeated calls, for any of a curated set of commands", async () => {
  await withTempWorkspace(async (_root, templatesDir) => {
    const contents: Record<string, string> = {
      requirements: "# Requirements Template\ncontent A\n",
      risk: "# Risk Register Template\ncontent B\n",
      adr: "# ADR Template\ncontent C\n",
    };
    await writeTemplateFile(
      templatesDir,
      "requirements-template.md",
      contents.requirements,
    );
    await writeTemplateFile(
      templatesDir,
      "risk-register-template.md",
      contents.risk,
    );
    await writeTemplateFile(templatesDir, "adr-template.md", contents.adr);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RENDER_COMMANDS),
        async (command) => {
          const { ctx: ctx1, written: w1 } = makeCtx("/unused", templatesDir);
          const { ctx: ctx2, written: w2 } = makeCtx("/unused", templatesDir);
          await run(model, "template", { command }, ctx1);
          await run(model, "template", { command }, ctx2);
          const c1 = w1[0].payload.content as string;
          const c2 = w2[0].payload.content as string;
          return c1 === c2 && c1 === contents[command];
        },
      ),
      FC_RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Sanity: the restricted arbitraries actually generate non-trivial input
// ---------------------------------------------------------------------------

Deno.test("sanity: codeArb/idArb/instanceArb can each produce more than one distinct value", () => {
  const codes = new Set<string>();
  const ids = new Set<string>();
  let sawInstance = false;
  let sawNoInstance = false;
  fc.assert(
    fc.property(idArb, codeArb, instanceArb, (id, code, instance) => {
      codes.add(code);
      ids.add(id);
      if (instance === undefined) sawNoInstance = true;
      else sawInstance = true;
      return true;
    }),
    { numRuns: 200 },
  );
  assert(codes.size > 1);
  assert(ids.size > 1);
  assert(sawInstance && sawNoInstance);
});
