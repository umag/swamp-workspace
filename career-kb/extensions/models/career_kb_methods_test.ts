/**
 * Methods suite for @magistr/career-kb (career_kb.ts) -- exercises every
 * model method's success AND failure paths (STANDARD.md's "methods" role:
 * "does each method do what it says?"), independently of
 * `career_kb_test.ts` (the contract-fixture suite, which pins behavior
 * against the REAL bundled `references/` corpus and is left unchanged).
 *
 * This suite drives the model against a SYNTHETIC, committed
 * `fixtures/references/` corpus (4 sample sources across all three
 * clusters) via a fake `context` whose `extensionFile` resolves into that
 * directory -- a REAL `Deno.readTextFile`, never a builtin stub. `assess`
 * needs no fixtures at all (it is pure: only `situation`/`carinas` in,
 * hardcoded `SIGNALS`/`FAMILY_INFO` constants, no file reads).
 *
 * career_kb.ts is UNMODIFIED -- every test here characterizes already-shipped
 * behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./career_kb.ts";

// ---------------------------------------------------------------------------
// Harness
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

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

Deno.test("index: arguments schema is z.object({})", () => {
  assertEquals(model.methods.index.arguments.parse({}), {});
});

Deno.test("search: arguments schema requires `query`, `cluster`/`topK` optional", () => {
  assertEquals(model.methods.search.arguments.parse({ query: "x" }), {
    query: "x",
  });
  assertEquals(
    model.methods.search.arguments.parse({
      query: "x",
      cluster: "ama",
      topK: 3,
    }),
    { query: "x", cluster: "ama", topK: 3 },
  );
});

Deno.test("read: arguments schema requires `file`, `section` optional", () => {
  assertEquals(model.methods.read.arguments.parse({ file: "x.md" }), {
    file: "x.md",
  });
});

Deno.test("assess: arguments schema requires `situation`, `carinas` optional", () => {
  assertEquals(model.methods.assess.arguments.parse({ situation: "s" }), {
    situation: "s",
  });
});

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

Deno.test("index: builds a schema-conformant catalog of all 4 fixture sources across 3 clusters", async () => {
  const { context, writes } = makeContext();
  await model.methods.index.execute({}, context);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "catalog");
  assertEquals(writes[0].name, "main");
  const cat = model.resources.catalog.schema.parse(writes[0].data);
  assertEquals(cat.sourceCount, 4);
  assertEquals(cat.sources.length, 4);
  const byName = Object.fromEntries(cat.clusters.map((c) => [c.name, c.count]));
  assertEquals(byName, { ama: 1, inaction: 1, "success-outcomes": 2 });
  assert(cat.allTopics.length > 0);
  assert(cat.allKeyConstructs.length > 0);
  assert(cat.allTopics.includes("perceived fraudulence"));
});

Deno.test("index: honours the clusters global-arg filter", async () => {
  const { context, writes } = makeContext(["success-outcomes"]);
  await model.methods.index.execute({}, context);
  const cat = model.resources.catalog.schema.parse(writes[0].data);
  assertEquals(cat.sourceCount, 2);
  assertEquals(cat.clusters, [{ name: "success-outcomes", count: 2 }]);
});

Deno.test("index: a clusters filter matching NOTHING yields a zero-source, zero-cluster catalog (not an error)", async () => {
  const { context, writes } = makeContext(["no-such-cluster"]);
  await model.methods.index.execute({}, context);
  const cat = model.resources.catalog.schema.parse(writes[0].data);
  assertEquals(cat.sourceCount, 0);
  assertEquals(cat.sources, []);
  assertEquals(cat.clusters, []);
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

Deno.test("search: ranks hits, honestly reports truncation when topK < totalMatches", async () => {
  const { context, writes } = makeContext();
  await model.methods.search.execute({ query: "fixture", topK: 2 }, context);
  const res = model.resources.searchResult.schema.parse(writes[0].data);
  assertEquals(
    res.totalMatches,
    4,
    "all 4 fixture titles start with 'Fixture'",
  );
  assertEquals(res.hitCount, 2);
  assertEquals(res.truncated, true);
  for (let i = 0; i < res.hits.length - 1; i++) {
    assert(res.hits[i].score >= res.hits[i + 1].score);
  }
  for (const h of res.hits) assert(h.score > 0);
});

Deno.test("search: cluster filter restricts the pool to only that cluster's sources", async () => {
  const { context, writes } = makeContext();
  await model.methods.search.execute(
    { query: "fixture", cluster: "success-outcomes", topK: 10 },
    context,
  );
  const res = model.resources.searchResult.schema.parse(writes[0].data);
  assertEquals(res.clusterFilter, "success-outcomes");
  assertEquals(res.totalMatches, 2);
  for (const h of res.hits) assertEquals(h.cluster, "success-outcomes");
});

Deno.test("search: no matches yields an empty, untruncated result", async () => {
  const { context, writes } = makeContext();
  await model.methods.search.execute(
    { query: "zzzqqqnonsensetoken", topK: 5 },
    context,
  );
  const res = model.resources.searchResult.schema.parse(writes[0].data);
  assertEquals(res.hitCount, 0);
  assertEquals(res.totalMatches, 0);
  assertEquals(res.truncated, false);
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

Deno.test("read: returns frontmatter + full body for a source given its relative path", async () => {
  const { context, writes } = makeContext();
  await model.methods.read.execute(
    { file: "ama/fixture-ama-example.md" },
    context,
  );
  const doc = model.resources.document.schema.parse(writes[0].data);
  assertEquals(doc.file, "ama/fixture-ama-example.md");
  assertEquals(doc.cluster, "ama");
  assertEquals(doc.section, undefined);
  assert(doc.content.length > 0);
  assert(doc.availableSections.includes("Overview"));
  assert(doc.availableSections.includes("Connections"));
});

Deno.test("read: resolves a bare slug and extracts one section", async () => {
  const { context, writes } = makeContext();
  await model.methods.read.execute(
    { file: "fixture-inaction-example", section: "Measurement" },
    context,
  );
  const doc = model.resources.document.schema.parse(writes[0].data);
  assertEquals(doc.file, "inaction/fixture-inaction-example.md");
  assertEquals(doc.section, "Measurement");
  assert(doc.content.startsWith("## Measurement"));
  assert(doc.content.includes("Career Stasis Inventory"));
});

Deno.test("read: throws on an unknown source", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => model.methods.read.execute({ file: "no-such-slug-at-all" }, context),
    Error,
    "not found",
  );
});

Deno.test("read: throws on an unknown section", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.read.execute(
        { file: "ama/fixture-ama-example.md", section: "NoSuchSectionAtAll" },
        context,
      ),
    Error,
    "not found",
  );
});

// ---------------------------------------------------------------------------
// assess -- full family coverage (pure; no fixtures involved)
// ---------------------------------------------------------------------------

Deno.test("assess: classifies an indecision situation and names SCCI", async () => {
  const { context, writes } = makeContext();
  await model.methods.assess.execute(
    {
      situation:
        "I can't decide between two offers, and I'm torn between which job to take.",
    },
    context,
  );
  const a = model.resources.assessment.schema.parse(writes[0].data);
  assertEquals(a.primaryFamily, "indecision");
  assert(a.families[0].instrument?.name.includes("SCCI"));
});

Deno.test("assess: classifies an indecisiveness situation and names EPCD", async () => {
  const { context, writes } = makeContext();
  await model.methods.assess.execute(
    {
      situation:
        "With every choice I second-guess everything and overthink every decision, no matter what.",
    },
    context,
  );
  const a = model.resources.assessment.schema.parse(writes[0].data);
  assertEquals(a.primaryFamily, "indecisiveness");
  assert(a.families[0].instrument?.name.includes("EPCD"));
});

Deno.test("assess: classifies a shock-transition situation with no named instrument", async () => {
  const { context, writes } = makeContext();
  await model.methods.assess.execute(
    {
      situation:
        "I was suddenly laid off due to a reorg, and my visa status is now at risk.",
    },
    context,
  );
  const a = model.resources.assessment.schema.parse(writes[0].data);
  assertEquals(a.primaryFamily, "shock-transition");
  assertEquals(a.families[0].instrument, undefined);
  assert(a.families[0].readSources.length > 0);
});
