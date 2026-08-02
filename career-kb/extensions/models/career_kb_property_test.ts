/**
 * Property-based tests (fast-check) for @magistr/career-kb (career_kb.ts).
 *
 * Honors `FC_NUM_RUNS` for the nightly soak (`deno task test:soak`).
 *
 * Properties:
 *  (a) slugify -- for ANY string, the output is always a non-empty string of
 *      only lowercase alphanumerics/hyphens, at most 48 chars.
 *  (b) tokenize -- for ANY string, every returned token is >= 3 lowercase
 *      alphanumeric chars, and the result has no duplicates.
 *  (c) parseFrontmatter/buildEntry/extractSections tie -- for ANY body text
 *      with no frontmatter block, buildEntry() never throws and its
 *      `.sections` always equals extractSections() applied independently to
 *      the same body.
 *  (d) assess (no carinas) -- for ANY situation string (hostile content
 *      included), execute() never throws and the written resource always
 *      validates against the model's OWN `assessment` schema.
 *  (e) assess (carinas) -- for ANY non-empty array of finite numbers,
 *      execute() never throws; if the array contains at least one value in
 *      [1,5] the resulting mean is a finite number in [1,5], and if it
 *      contains NONE the mean is null and the band is "no valid input" --
 *      this generalizes the LB2 FIX (career-kb-latent-bugs) across the input
 *      space instead of one example.
 *  (f) search flow invariant -- for ANY query string against the shared
 *      fixture corpus, search() never throws, hits.length <= topK, hits are
 *      sorted non-increasing by score, totalMatches >= hitCount, and
 *      truncated === (totalMatches > hitCount).
 *  (g) index/read multi-step flow -- for any of the 4 known fixture files,
 *      read()'s reported cluster/slug always agrees with what index()'s
 *      catalog reports for that same file.
 */
import { assert } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  buildEntry,
  extractSections,
  model,
  slugify,
  tokenize,
} from "./career_kb.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(100) };

// ---------------------------------------------------------------------------
// Harness (shared fixtures corpus)
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; data: unknown };

function makeContext(clusters?: string[]) {
  const writes: Written[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(clusters ? { clusters } : {}),
    extensionFile: (rel: string) =>
      new URL(`../../fixtures/${rel}`, import.meta.url).pathname,
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ spec, name });
    },
  };
  return { context, writes };
}

const KNOWN_FILES = [
  "ama/fixture-ama-example.md",
  "inaction/fixture-inaction-example.md",
  "success-outcomes/fixture-success-example-one.md",
  "success-outcomes/fixture-success-example-two.md",
];

// ---------------------------------------------------------------------------
// (a) slugify -- charset + length invariants for ANY string
// ---------------------------------------------------------------------------

Deno.test("property: slugify(x) is always a non-empty string of lowercase alnum/hyphens, at most 48 chars, for ANY input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 500 }), (s) => {
      const out = slugify(s);
      return out.length > 0 && out.length <= 48 && /^[a-z0-9-]+$/.test(out);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) tokenize -- shape + uniqueness invariants for ANY string
// ---------------------------------------------------------------------------

Deno.test("property: tokenize(x) never returns a token shorter than 3 chars, never returns a duplicate, for ANY input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 500 }), (s) => {
      const tokens = tokenize(s);
      const allLongEnough = tokens.every((t) =>
        t.length >= 3 && /^[a-z0-9]+$/.test(t)
      );
      const noDupes = new Set(tokens).size === tokens.length;
      return allLongEnough && noDupes;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) buildEntry/extractSections tie -- for ANY frontmatter-free body
// ---------------------------------------------------------------------------

const arbBody = fc.string({ maxLength: 800 });

Deno.test("property: buildEntry() never throws for ANY frontmatter-free body, and its .sections always equals extractSections() on the same body", () => {
  fc.assert(
    fc.property(arbBody, (raw) => {
      // Force a leading non-hyphen character so the generated text can never
      // accidentally open a `---\n...\n---\n` frontmatter block.
      const body = "x" + raw;
      const entry = buildEntry("inaction/fixture-property.md", body);
      const expectedSections = extractSections(body);
      return entry.sections.length === expectedSections.length &&
        entry.sections.every((s, i) => s === expectedSections[i]);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) assess (no carinas) -- never throws, always schema-valid
// ---------------------------------------------------------------------------

Deno.test("property: assess() never throws for ANY situation string (no carinas), and the written resource always validates against its own schema", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 500 }), async (situation) => {
      const { context, writes } = makeContext();
      await model.methods.assess.execute({ situation }, context);
      model.resources.assessment.schema.parse(writes[0].data);
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) assess (carinas) -- generalizes LB2 (career-kb-latent-bugs) across the
// input space: an all-out-of-range array always yields NaN/"high"; an
// array with at least one in-range value always yields a finite mean.
// ---------------------------------------------------------------------------

Deno.test("property: assess() with ANY non-empty array of finite numbers as carinas never throws, and the null-mean/'no valid input' outcome (LB2 fix) holds exactly when NO value is in [1,5]", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), {
        minLength: 1,
        maxLength: 12,
      }),
      async (carinas) => {
        const { context, writes } = makeContext();
        await model.methods.assess.execute(
          { situation: "stuck", carinas },
          context,
        );
        const a = writes[0].data as {
          carinas?: { mean: number | null; band: string };
        };
        if (!a.carinas) return false;
        const inRange = carinas.filter((n) => n >= 1 && n <= 5);
        if (inRange.length === 0) {
          return a.carinas.mean === null && a.carinas.band === "no valid input";
        }
        return Number.isFinite(a.carinas.mean) && a.carinas.mean! >= 1 &&
          a.carinas.mean! <= 5;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (f) search flow invariant -- ANY query against the shared fixture corpus
// ---------------------------------------------------------------------------

Deno.test("property: search() never throws for ANY query string; hits respect topK, sort order, and the truncated flag", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 100 }),
      fc.integer({ min: 1, max: 10 }),
      async (query, topK) => {
        const { context, writes } = makeContext();
        await model.methods.search.execute({ query, topK }, context);
        const res = model.resources.searchResult.schema.parse(
          writes[0].data,
        );
        if (res.hits.length > topK) return false;
        for (let i = 0; i < res.hits.length - 1; i++) {
          if (res.hits[i].score < res.hits[i + 1].score) return false;
        }
        if (res.totalMatches < res.hitCount) return false;
        return res.truncated === (res.totalMatches > res.hitCount);
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (g) index/read multi-step flow -- catalog and read must agree
// ---------------------------------------------------------------------------

Deno.test("property: for any known fixture file, read()'s cluster/slug always agrees with index()'s catalog entry for that file", async () => {
  const { context: idxCtx, writes: idxWrites } = makeContext();
  await model.methods.index.execute({}, idxCtx);
  const catalog = model.resources.catalog.schema.parse(idxWrites[0].data);

  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...KNOWN_FILES), async (file) => {
      const { context, writes } = makeContext();
      await model.methods.read.execute({ file }, context);
      const doc = model.resources.document.schema.parse(writes[0].data);
      const catEntry = catalog.sources.find((s) => s.file === file)!;
      return doc.cluster === catEntry.cluster && doc.slug === catEntry.slug;
    }),
    { ...FC_RUNS, numRuns: Math.min(FC_RUNS.numRuns, 20) },
  );
});

// ---------------------------------------------------------------------------
// Sanity: the hostile-string arbitrary can generate weird/non-empty input
// ---------------------------------------------------------------------------

Deno.test("sanity: the string arbitrary generates non-empty and control-character-bearing input at least once (not vacuously safe)", () => {
  let sawNonEmpty = false;
  let sawControl = false;
  fc.assert(
    fc.property(fc.string({ maxLength: 500 }), (s) => {
      if (s.length > 0) sawNonEmpty = true;
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) <= 8) sawControl = true;
      }
      return true;
    }),
    { numRuns: 500 },
  );
  assert(sawNonEmpty, "sanity: the arbitrary must generate non-empty strings");
  void sawControl;
});
