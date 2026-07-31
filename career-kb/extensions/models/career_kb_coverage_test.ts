/**
 * Coverage suite for @magistr/career-kb (career_kb.ts) -- sweeps guards and
 * branches the contract-fixture/methods/adversarial suites don't already
 * exercise on BOTH sides (STANDARD.md's coverage role: "if someone deletes
 * this guard, does a test go red?"). career_kb.ts is UNMODIFIED; every test
 * here PINS existing behavior.
 *
 * Most of these drive the exported PURE helpers (`buildEntry`,
 * `parseFrontmatter`, `extractSections`, `getSection`, `asArray`, `tokenize`)
 * directly -- no fixtures needed. Two tests (the multi-cluster filter and the
 * phrase-bonus scoring boundary) need the model's `search`/`index` methods
 * against the shared, committed `fixtures/references/` corpus.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  asArray,
  buildEntry,
  extractSections,
  getSection,
  model,
  parseFrontmatter,
  tokenize,
} from "./career_kb.ts";

// ---------------------------------------------------------------------------
// Harness (shared fixtures corpus only)
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

// ===========================================================================
// parseFrontmatter -- guards not already pinned by career_kb_test.ts
// ===========================================================================

Deno.test("parseFrontmatter: a line inside the frontmatter block that doesn't match `key: value` is silently skipped, not thrown", () => {
  const text = [
    "---",
    "title: T",
    "this line has no colon at all and is not a key",
    "cluster: inaction",
    "---",
    "body",
  ].join("\n");
  const { fm, body } = parseFrontmatter(text);
  assertEquals(fm.title, "T");
  assertEquals(fm.cluster, "inaction");
  assertEquals(Object.keys(fm).length, 2);
  assertEquals(body, "body");
});

Deno.test("parseFrontmatter: an UNTERMINATED frontmatter block (opening `---` with no closing `---`) yields empty fm and the FULL original text as body", () => {
  const text = ["---", "title: Never Closed", "still going"].join("\n");
  const { fm, body } = parseFrontmatter(text);
  assertEquals(Object.keys(fm).length, 0);
  assertEquals(body, text);
});

// ===========================================================================
// buildEntry -- cluster/title fallback branches, year type preservation
// ===========================================================================

Deno.test("buildEntry: cluster falls back to the path segment when frontmatter has no `cluster:` key", () => {
  const text = ["---", "title: T", "---", "body"].join("\n");
  const e = buildEntry("success-outcomes/fixture-x.md", text);
  assertEquals(e.cluster, "success-outcomes");
});

Deno.test("buildEntry: an explicit frontmatter `cluster:` OVERRIDES the path-derived cluster", () => {
  const text = ["---", "title: T", "cluster: other-cluster", "---", "body"]
    .join("\n");
  const e = buildEntry("success-outcomes/fixture-x.md", text);
  assertEquals(e.cluster, "other-cluster");
});

Deno.test("buildEntry: title falls back to the filename (sans .md) when frontmatter has no `title:` key", () => {
  const text = ["---", "cluster: ama", "---", "body"].join("\n");
  const e = buildEntry("ama/fixture-notitle.md", text);
  assertEquals(e.title, "fixture-notitle");
});

Deno.test("buildEntry: a non-numeric `year` string is preserved untouched, not coerced or rejected", () => {
  const text = ["---", "title: T", "year: circa 2020", "---", "body"].join(
    "\n",
  );
  const e = buildEntry("ama/fixture-y.md", text);
  assertEquals(e.year, "circa 2020");
});

// ===========================================================================
// extractSections / getSection -- boundary branches
// ===========================================================================

Deno.test("extractSections: a body with no `## ` headings returns an empty array", () => {
  assertEquals(extractSections("just prose, no headings anywhere"), []);
});

Deno.test("getSection: when the search target partially matches MULTIPLE headings, only the FIRST (document order) is returned -- the rest are silently ignored", () => {
  const body = "## Overview\nintro\n## Leftover Notes\nmore text";
  const sec = getSection(body, "over");
  assert(sec !== undefined);
  assert(sec!.startsWith("## Overview"));
  assert(!sec!.includes("Leftover Notes"));
});

Deno.test("getSection: a match on the LAST heading extends to the end of the body (no next `## ` to bound it)", () => {
  const body = "## First\nx\n## Last\ntail line one\ntail line two";
  const sec = getSection(body, "last");
  assert(sec !== undefined);
  assert(sec!.includes("tail line one"));
  assert(sec!.includes("tail line two"));
});

// ===========================================================================
// asArray -- the falsy-but-defined boundary
// ===========================================================================

Deno.test("asArray: a defined-but-falsy scalar (0) is NOT swallowed by the undefined/null/'' guard", () => {
  assertEquals(asArray(0), ["0"]);
});

// ===========================================================================
// tokenize -- length boundary, stopword additions
// ===========================================================================

Deno.test("tokenize: a 3-char token is kept, a 2-char token is dropped (the >= 3 length boundary)", () => {
  assertEquals(tokenize("abc de").sort(), ["abc"]);
});

Deno.test("tokenize: the domain-specific 'career'/'careers' stopword additions are dropped even though they look domain-relevant", () => {
  assertEquals(tokenize("career careers change"), ["change"]);
});

// ===========================================================================
// index -- multi-cluster filter (shared fixtures corpus)
// ===========================================================================

Deno.test("index: a clusters filter naming TWO of the three clusters includes both and excludes the third", async () => {
  const { context, writes } = makeContext(["inaction", "success-outcomes"]);
  await model.methods.index.execute({}, context);
  const cat = model.resources.catalog.schema.parse(writes[0].data);
  assertEquals(cat.sourceCount, 3);
  const names = cat.clusters.map((c) => c.name).sort();
  assertEquals(names, ["inaction", "success-outcomes"]);
});

Deno.test("index: allTopics and allKeyConstructs are returned alphabetically sorted", async () => {
  const { context, writes } = makeContext();
  await model.methods.index.execute({}, context);
  const cat = model.resources.catalog.schema.parse(writes[0].data);
  assertEquals(cat.allTopics, [...cat.allTopics].sort());
  assertEquals(cat.allKeyConstructs, [...cat.allKeyConstructs].sort());
});

// ===========================================================================
// search -- the whole-phrase bonus's length>=5 boundary
// ===========================================================================

Deno.test("search: the whole-phrase bonus (+5, only for a phrase of >= 5 chars) is what separates a 5-char query from its 3-char substring on the SAME source", async () => {
  const { context: longCtx, writes: longWrites } = makeContext([
    "success-outcomes",
  ]);
  await model.methods.search.execute({ query: "doubt", topK: 10 }, longCtx);
  const longRes = model.resources.searchResult.schema.parse(
    longWrites[0].data,
  );
  const longHit = longRes.hits.find((h) =>
    h.file === "success-outcomes/fixture-success-example-one.md"
  )!;
  assert(longHit.why.includes("phrase"), "5-char phrase gets the bonus");

  const { context: shortCtx, writes: shortWrites } = makeContext([
    "success-outcomes",
  ]);
  await model.methods.search.execute({ query: "dou", topK: 10 }, shortCtx);
  const shortRes = model.resources.searchResult.schema.parse(
    shortWrites[0].data,
  );
  const shortHit = shortRes.hits.find((h) =>
    h.file === "success-outcomes/fixture-success-example-one.md"
  )!;
  assert(
    !shortHit.why.includes("phrase"),
    "a 3-char phrase never qualifies for the >= 5-char phrase bonus",
  );
  assert(
    longHit.score > shortHit.score,
    "the phrase bonus must make the longer query score strictly higher on the same source",
  );
});

// ===========================================================================
// read -- bare filename WITH a .md suffix but no cluster prefix
// ===========================================================================

Deno.test("read: a bare filename carrying '.md' but no cluster prefix still resolves via the slug match (the `.replace(/\\.md$/, \"\")` normalization)", async () => {
  const { context, writes } = makeContext();
  await model.methods.read.execute(
    { file: "fixture-ama-example.md" },
    context,
  );
  const doc = model.resources.document.schema.parse(writes[0].data);
  assertEquals(doc.file, "ama/fixture-ama-example.md");
});
