import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  asArray,
  buildEntry,
  extractSections,
  getSection,
  model,
  parseFrontmatter,
  slugify,
  tokenize,
} from "./career_kb.ts";

// A minimal model execution context: globalArgs from the real schema,
// extensionFile resolved against the actual bundled `references/` tree (so the
// integration tests exercise the real corpus), and writeResource captured.
function makeContext(clusters?: string[]) {
  const writes: Array<{ spec: string; name: string; data: unknown }> = [];
  const context = {
    globalArgs: model.globalArguments.parse(clusters ? { clusters } : {}),
    extensionFile: (rel: string) =>
      new URL(`../../${rel}`, import.meta.url).pathname,
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ spec, name });
    },
  };
  return { context, writes };
}

// ---------- Pure helpers -----------------------------------------------------

Deno.test("slugify: lowercases, collapses punctuation to hyphens", () => {
  assertEquals(slugify("Hello, World!"), "hello-world");
  assertEquals(
    slugify("inaction/career-inaction.md"),
    "inaction-career-inaction-md",
  );
});

Deno.test("slugify: empty input falls back to 'main'", () => {
  assertEquals(slugify(""), "main");
  assertEquals(slugify("!!!"), "main");
});

Deno.test("slugify: caps length at 48 chars", () => {
  const out = slugify("a".repeat(120));
  assert(out.length <= 48, `expected <=48, got ${out.length}`);
});

Deno.test("parseFrontmatter: scalars, inline arrays, numbers, empty skipped", () => {
  const text = [
    "---",
    'title: "Career Inaction"',
    "cluster: inaction",
    'topics: [a, b, "c d"]',
    "year: 2025",
    "blank:",
    "---",
    "Body starts here.",
    "## Overview",
    "x",
  ].join("\n");
  const { fm, body } = parseFrontmatter(text);
  assertEquals(fm.title, "Career Inaction");
  assertEquals(fm.cluster, "inaction");
  assertEquals(fm.topics, ["a", "b", "c d"]);
  assertEquals(fm.year, 2025);
  assertEquals(fm.blank, undefined);
  assert(body.startsWith("Body starts here."));
});

Deno.test("parseFrontmatter: no frontmatter block returns empty fm + full body", () => {
  const { fm, body } = parseFrontmatter("just some text\n## A");
  assertEquals(Object.keys(fm).length, 0);
  assertEquals(body, "just some text\n## A");
});

Deno.test("extractSections: lists ## headings in order", () => {
  assertEquals(
    extractSections("## One\nx\n### Sub\n## Two\ny\n## Three"),
    ["One", "Two", "Three"],
  );
});

Deno.test("getSection: case-insensitive partial match, bounded by next heading", () => {
  const body = "## Overview\nintro\n## Measurement\nscale info\n## Next\nz";
  const sec = getSection(body, "measure");
  assert(sec !== undefined);
  assert(sec!.startsWith("## Measurement"));
  assert(sec!.includes("scale info"));
  assert(!sec!.includes("\nz"));
});

Deno.test("getSection: returns undefined when no heading matches", () => {
  assertEquals(getSection("## Overview\nx", "nonexistent"), undefined);
});

Deno.test("asArray: array passthrough, scalar singleton, empty -> []", () => {
  assertEquals(asArray(["a", "b"]), ["a", "b"]);
  assertEquals(asArray("x"), ["x"]);
  assertEquals(asArray(5), ["5"]);
  assertEquals(asArray(undefined), []);
  assertEquals(asArray(""), []);
});

Deno.test("tokenize: drops stopwords + short tokens, de-duplicates", () => {
  assertEquals(
    tokenize("The career IS about impostor impostor syndrome").sort(),
    ["impostor", "syndrome"],
  );
});

Deno.test("buildEntry: structures a source from path + markdown", () => {
  const text = [
    "---",
    "title: T",
    "cluster: inaction",
    "topics: [x]",
    "key_constructs: [k1, k2]",
    'summary: "s"',
    "---",
    "## A",
    "## B",
  ].join("\n");
  const e = buildEntry("inaction/foo.md", text);
  assertEquals(e.file, "inaction/foo.md");
  assertEquals(e.cluster, "inaction");
  assertEquals(e.slug, "foo");
  assertEquals(e.title, "T");
  assertEquals(e.topics, ["x"]);
  assertEquals(e.keyConstructs, ["k1", "k2"]);
  assertEquals(e.summary, "s");
  assertEquals(e.sections, ["A", "B"]);
});

// ---------- Schema / argument defaults --------------------------------------

Deno.test("globalArguments: defaults to all three clusters", () => {
  assertEquals(model.globalArguments.parse({}).clusters, [
    "ama",
    "inaction",
    "success-outcomes",
  ]);
});

// ---------- index (integration over the bundled corpus) ----------------------

Deno.test("index: builds a schema-conformant catalog of all 22 sources", async () => {
  const { context, writes } = makeContext();
  await model.methods.index.execute({}, context);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "catalog");
  assertEquals(writes[0].name, "main");
  const cat = model.resources.catalog.schema.parse(writes[0].data);
  assertEquals(cat.sourceCount, 22);
  assertEquals(cat.sources.length, 22);
  const clusterNames = cat.clusters.map((c) => c.name).sort();
  assertEquals(clusterNames, ["ama", "inaction", "success-outcomes"]);
  assert(cat.allTopics.length > 0);
  assert(cat.allKeyConstructs.length > 0);
});

Deno.test("index: honours the clusters global-arg filter", async () => {
  const { context, writes } = makeContext(["ama"]);
  await model.methods.index.execute({}, context);
  const cat = model.resources.catalog.schema.parse(writes[0].data);
  assertEquals(cat.sourceCount, 1);
  assertEquals(cat.clusters, [{ name: "ama", count: 1 }]);
});

// ---------- search -----------------------------------------------------------

Deno.test("search: ranks hits and reports truncation honestly", async () => {
  const { context, writes } = makeContext();
  await model.methods.search.execute(
    { query: "impostor syndrome", topK: 2 },
    context,
  );
  const res = model.resources.searchResult.schema.parse(writes[0].data);
  assertEquals(res.query, "impostor syndrome");
  assert(res.hits.length <= 2);
  assertEquals(res.hitCount, res.hits.length);
  assert(res.totalMatches >= res.hitCount);
  assertEquals(res.truncated, res.totalMatches > res.hitCount);
  // Sorted by descending score, every returned hit is a positive match.
  for (let i = 0; i < res.hits.length - 1; i++) {
    assert(res.hits[i].score >= res.hits[i + 1].score);
  }
  for (const h of res.hits) assert(h.score > 0);
});

Deno.test("search: cluster filter restricts the pool", async () => {
  const { context, writes } = makeContext();
  await model.methods.search.execute(
    { query: "indecision", cluster: "inaction", topK: 10 },
    context,
  );
  const res = model.resources.searchResult.schema.parse(writes[0].data);
  assertEquals(res.clusterFilter, "inaction");
  for (const h of res.hits) assertEquals(h.cluster, "inaction");
});

Deno.test("search: no matches yields an empty, untruncated result", async () => {
  const { context, writes } = makeContext();
  await model.methods.search.execute(
    { query: "zzzqqq nonsense token", topK: 5 },
    context,
  );
  const res = model.resources.searchResult.schema.parse(writes[0].data);
  assertEquals(res.hitCount, 0);
  assertEquals(res.totalMatches, 0);
  assertEquals(res.truncated, false);
});

// ---------- read -------------------------------------------------------------

Deno.test("read: returns frontmatter + full body for a source", async () => {
  const { context, writes } = makeContext();
  await model.methods.read.execute(
    { file: "inaction/career-inaction.md" },
    context,
  );
  const doc = model.resources.document.schema.parse(writes[0].data);
  assertEquals(doc.file, "inaction/career-inaction.md");
  assertEquals(doc.cluster, "inaction");
  assertEquals(doc.section, undefined);
  assert(doc.content.length > 0);
  assert(doc.availableSections.length > 0);
});

Deno.test("read: resolves a bare slug and extracts one section", async () => {
  const { context, writes } = makeContext();
  await model.methods.read.execute(
    { file: "career-inaction", section: "Overview" },
    context,
  );
  const doc = model.resources.document.schema.parse(writes[0].data);
  assertEquals(doc.file, "inaction/career-inaction.md");
  assertEquals(doc.section, "Overview");
  assert(doc.content.startsWith("## "));
});

Deno.test("read: throws on an unknown source", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => model.methods.read.execute({ file: "no-such-slug" }, context),
    Error,
    "not found",
  );
});

Deno.test("read: throws on an unknown section", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.read.execute(
        { file: "inaction/career-inaction.md", section: "NoSuchSection" },
        context,
      ),
    Error,
    "not found",
  );
});

// ---------- assess -----------------------------------------------------------

Deno.test("assess: classifies an inaction situation as primary", async () => {
  const { context, writes } = makeContext();
  await model.methods.assess.execute(
    { situation: "I want to leave but I feel stuck and keep putting it off" },
    context,
  );
  const a = model.resources.assessment.schema.parse(writes[0].data);
  assertEquals(a.primaryFamily, "inaction");
  assertEquals(a.families[0].family, "inaction");
  assert(a.families[0].instrument?.name.includes("CARINAS"));
  assert(a.copingGuidance.reduce.includes("escape"));
});

Deno.test("assess: a success-derailer family carries no instrument", async () => {
  const { context, writes } = makeContext();
  await model.methods.assess.execute(
    { situation: "I feel like an impostor and a fraud who doesn't deserve it" },
    context,
  );
  const a = model.resources.assessment.schema.parse(writes[0].data);
  assertEquals(a.primaryFamily, "success-derailer");
  assertEquals(a.families[0].instrument, undefined);
});

Deno.test("assess: scores CARINAS items into a band", async () => {
  const { context, writes } = makeContext();
  await model.methods.assess.execute(
    { situation: "stuck", carinas: [4, 5, 4, 5, 4, 3, 5, 4] },
    context,
  );
  const a = model.resources.assessment.schema.parse(writes[0].data);
  assertEquals(a.carinas?.mean, 4.25);
  assertEquals(a.carinas?.band, "high");
});

Deno.test("assess: out-of-range CARINAS values are ignored and reported", async () => {
  const { context, writes } = makeContext();
  await model.methods.assess.execute(
    { situation: "stuck", carinas: [4, 9, 0, 3] },
    context,
  );
  const a = model.resources.assessment.schema.parse(writes[0].data);
  assertEquals(a.carinas?.mean, 3.5);
  assert(a.carinas?.interpretation.includes("ignored"));
});

Deno.test("assess: an unmatched situation is 'unclear'", async () => {
  const { context, writes } = makeContext();
  await model.methods.assess.execute(
    { situation: "lorem ipsum dolor sit amet" },
    context,
  );
  const a = model.resources.assessment.schema.parse(writes[0].data);
  assertEquals(a.primaryFamily, "unclear");
  assertEquals(a.families.length, 0);
});
