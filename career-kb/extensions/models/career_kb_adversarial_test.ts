/**
 * Adversarial suite for @magistr/career-kb (career_kb.ts) -- hostile/boundary
 * inputs plus a mechanical fixtures-secret-scan over `fixtures/**`.
 *
 * LB1 (path traversal via `read`'s `file` argument, HIGH) was FIXED earlier:
 * `readRef()` calls the exported `assertWithinRefs()` guard before building
 * the on-disk path, so a `file` argument that escapes `references/` is
 * REJECTED (no read, no resource written) instead of succeeding.
 *
 * This change real-fixes the remaining 6 latent bugs tracked in the LOCAL
 * `career-kb-latent-bugs` issue-lifecycle model (NEVER filed to the
 * swamp.club Lab -- see CLAUDE.md's anti-bypass rule), version
 * 2026.08.01.1 -> 2026.08.02.1:
 *   LB2 all out-of-range CARINAS values now yield a distinct `mean: null`,
 *   `band: "no valid input"` state instead of a NaN mean mislabeled "high"
 *   (MEDIUM), LB3 `resourceName()` (slugify + FNV-1a hash suffix) now gives
 *   distinct `assess`/`search`/`read` inputs distinct resource names (MEDIUM),
 *   LB4 `loadSources` now skips+warns on one bad/missing source instead of
 *   aborting the whole catalog build (MEDIUM), LB5 an empty `clusters: []`
 *   global arg now matches zero sources instead of disabling filtering
 *   entirely (LOW), LB6 a new defaulted `maxFileBytes` global arg now caps
 *   `read`/`index` file size (LOW), LB7 `content` is now explicitly
 *   documented as untrusted-must-sanitize (verbatim storage stays
 *   BY DESIGN -- this model returns markdown to an agent/LLM consumer, not a
 *   trusted-HTML renderer) (LOW/info). Every pin below that flipped is
 *   renamed with `-- FIXED` (or `-- BY DESIGN` for LB7); all others are
 *   unchanged.
 *
 * LB1 uses the COMMITTED `fixtures/outside/` sibling (never a real file) --
 * an unreachable synthetic attack target, kept committed to prove the guard
 * actually rejects a real escape rather than merely rejecting a nonexistent
 * path. LB4/LB6/LB7 need bespoke corpora (a broken index entry, a huge file,
 * an injection payload) that must NOT pollute the shared
 * `fixtures/references/` corpus the methods/coverage/property suites depend
 * on -- each builds its own disposable `Deno.makeTempDir()` corpus, cleaned
 * up in a `finally`.
 *
 * It also pins two REFUTED risk classes as covered-negatives: credential
 * leak (globalArguments carries no secret-shaped field -- now `clusters` AND
 * `maxFileBytes`, neither credential-shaped) and subprocess/network egress
 * (career_kb.ts calls neither `Deno.Command` nor `fetch` anywhere --
 * confirmed by reading its own source text).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./career_kb.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; data: unknown };

function makeContext(
  clusters: string[] | undefined,
  baseDir: string,
  overrides?: Record<string, unknown>,
) {
  const writes: Written[] = [];
  const context = {
    globalArgs: model.globalArguments.parse({
      ...(clusters ? { clusters } : {}),
      ...overrides,
    }),
    extensionFile: (rel: string) => `${baseDir}/${rel}`,
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ spec, name });
    },
  };
  return { context, writes };
}

const FIXTURES_DIR = new URL("../../fixtures", import.meta.url).pathname;

function fixtureContext(clusters?: string[]) {
  return makeContext(clusters, FIXTURES_DIR);
}

/** A minimal, valid fixture source: frontmatter + one Overview section. */
function validMd(title: string, cluster: string, extraBody = ""): string {
  return `---
title: "${title}"
cluster: ${cluster}
topics: [fixture-topic]
key_constructs: [fixture-construct]
---

## Overview

${extraBody || "Fixture body text."}
`;
}

/**
 * Builds a disposable `references/` corpus under a fresh temp dir (optionally
 * with a caller-supplied `index.json` that can name entries NOT present on
 * disk, for LB4), runs `fn(baseDir)` against it, and always removes the temp
 * dir afterward.
 */
async function withTempCorpus(
  sources: Record<string, string>,
  indexOverride: string[] | undefined,
  fn: (baseDir: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "career-kb-adversarial-" });
  try {
    for (const [rel, content] of Object.entries(sources)) {
      const path = `${root}/references/${rel}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(path, content);
    }
    const index = indexOverride ?? Object.keys(sources);
    await Deno.mkdir(`${root}/references`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/references/index.json`,
      JSON.stringify(index),
    );
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// ===========================================================================
// LB1 path traversal via `read`'s `file` argument -- HIGH -- FIXED
// ===========================================================================

Deno.test("pin (career-kb-latent-bugs LB1, HIGH -- FIXED): a `file` argument containing `..` segments is REJECTED before any read is attempted -- assertWithinRefs confines readRef() to references/", async () => {
  const { context, writes } = fixtureContext();
  await assertRejects(
    () =>
      model.methods.read.execute(
        { file: "../outside/fixture-escape-target.md" },
        context,
      ),
    Error,
    "Invalid reference path",
  );
  assertEquals(
    writes.length,
    0,
    "the traversal attempt must be rejected before any resource is written -- the fixture-escape-target content must never surface",
  );
});

// Each of these is genuinely RED against the unmodified source (verified):
// pre-fix, "/etc/passwd" and "a/../../b" 404 as unrelated Deno.errors.NotFound
// (the naive `${REF_DIR}/${rel}` template-literal join never reaches real
// filesystem paths outside the fixtures tree in this test harness), "../.."
// throws Deno.errors.IsADirectory (it walks up to the fixtures parent, a real
// directory), and "./x" resolves harmlessly inside references/ and 404s on a
// nonexistent file -- NONE of those messages contain "Invalid reference
// path", so asserting that specific substring genuinely fails before
// assertWithinRefs is wired into readRef() and genuinely passes after,
// proving the guard -- not an incidental filesystem error -- is what rejects
// every shape.
Deno.test("pin (career-kb-latent-bugs LB1, HIGH -- FIXED): additional synthetic traversal shapes (absolute, nested ../.., mixed a/../../b, ./x) are all REJECTED by assertWithinRefs specifically, no resource written", async () => {
  const traversalAttempts = [
    "/etc/passwd",
    "../..",
    "a/../../b",
    "./x",
  ];
  for (const file of traversalAttempts) {
    const { context, writes } = fixtureContext();
    await assertRejects(
      () => model.methods.read.execute({ file }, context),
      Error,
      "Invalid reference path",
      `expected "${file}" to be rejected by assertWithinRefs specifically`,
    );
    assertEquals(
      writes.length,
      0,
      `no resource written for rejected traversal-shaped input "${file}"`,
    );
  }
});

// ===========================================================================
// LB2 all-out-of-range CARINAS -> distinct "no valid input" state -- MEDIUM -- FIXED
// ===========================================================================

Deno.test("pin (career-kb-latent-bugs LB2, MEDIUM -- FIXED): every CARINAS value out of [1,5] yields a distinct 'no valid input' state, never a fabricated 'high' band", async () => {
  const { context, writes } = fixtureContext();
  await model.methods.assess.execute(
    { situation: "stuck", carinas: [0, 9, -3, 6, 100] },
    context,
  );
  assertEquals(writes.length, 1);
  const a = writes[0].data as {
    carinas?: { mean: number | null; band: string; interpretation: string };
  };
  assert(a.carinas !== undefined);
  assertEquals(
    a.carinas!.mean,
    null,
    "vals is empty after filtering -- mean must be null, never NaN",
  );
  assertEquals(
    a.carinas!.band,
    "no valid input",
    "an all-out-of-range input must never be mislabeled with the STRONGEST band ('high')",
  );
  assert(
    /no mean/i.test(a.carinas!.interpretation),
    `expected the interpretation to explain no mean could be computed, got: ${
      a.carinas!.interpretation
    }`,
  );
});

// ===========================================================================
// LB3 resource-name slug collision -- MEDIUM -- FIXED
// ===========================================================================

Deno.test("pin (career-kb-latent-bugs LB3, MEDIUM -- FIXED): two DIFFERENT situations that differ only in punctuation now map to DISTINCT resource names", async () => {
  const { context, writes } = fixtureContext();
  await model.methods.assess.execute(
    { situation: "Fixture Career Situation, One!" },
    context,
  );
  await model.methods.assess.execute(
    { situation: "Fixture Career Situation: One?" },
    context,
  );
  assertEquals(writes.length, 2);
  assert(
    writes[0].name !== writes[1].name,
    "distinct situations now get distinct resource names -- resourceName()'s hash suffix prevents the second write from clobbering the first",
  );
  const first = writes[0].data as { situation: string };
  const second = writes[1].data as { situation: string };
  assert(
    first.situation !== second.situation,
    "sanity: these are two genuinely distinct inputs, not an accidental dedup no-op",
  );
});

// ===========================================================================
// LB4 one bad/missing source aborts the whole catalog build -- MEDIUM -- FIXED
// ===========================================================================

Deno.test("pin (career-kb-latent-bugs LB4, MEDIUM -- FIXED): one missing source listed in index.json is skipped; the catalog still covers every source that loaded", async () => {
  await withTempCorpus(
    {
      "inaction/fixture-good-one.md": validMd("Fixture Good One", "inaction"),
      "inaction/fixture-good-two.md": validMd("Fixture Good Two", "inaction"),
    },
    [
      "inaction/fixture-good-one.md",
      "inaction/fixture-missing.md",
      "inaction/fixture-good-two.md",
    ],
    async (baseDir) => {
      const { context, writes } = makeContext(undefined, baseDir);
      await model.methods.index.execute({}, context);
      assertEquals(
        writes.length,
        1,
        "index() must resolve and write exactly one catalog, not abort",
      );
      const cat = model.resources.catalog.schema.parse(writes[0].data);
      assertEquals(
        cat.sourceCount,
        2,
        "the missing source is skipped -- only the 2 good sources are counted",
      );
      const files = cat.sources.map((s) => s.file).sort();
      assertEquals(files, [
        "inaction/fixture-good-one.md",
        "inaction/fixture-good-two.md",
      ]);
    },
  );
});

Deno.test("pin (career-kb-latent-bugs LB4, MEDIUM -- FIXED): search() over the same one-bad-two-good corpus still returns hits drawn only from the good sources", async () => {
  await withTempCorpus(
    {
      "inaction/fixture-good-one.md": validMd("Fixture Good One", "inaction"),
      "inaction/fixture-good-two.md": validMd("Fixture Good Two", "inaction"),
    },
    [
      "inaction/fixture-good-one.md",
      "inaction/fixture-missing.md",
      "inaction/fixture-good-two.md",
    ],
    async (baseDir) => {
      const { context, writes } = makeContext(undefined, baseDir);
      await model.methods.search.execute({ query: "good" }, context);
      const res = model.resources.searchResult.schema.parse(writes[0].data);
      const files = res.hits.map((h) => h.file).sort();
      assertEquals(files, [
        "inaction/fixture-good-one.md",
        "inaction/fixture-good-two.md",
      ]);
    },
  );
});

// ===========================================================================
// LB5 empty `clusters: []` matches zero sources -- LOW -- FIXED
// ===========================================================================

Deno.test("pin (career-kb-latent-bugs LB5, LOW -- FIXED): an explicit `clusters: []` global arg matches zero sources, as its shape implies", async () => {
  const empty = fixtureContext([]);
  await model.methods.index.execute({}, empty.context);
  const catEmpty = empty.writes[0].data as { sourceCount: number };
  assertEquals(
    catEmpty.sourceCount,
    0,
    "an explicit empty clusters array must filter down to zero sources, not fall back to the full unfiltered index",
  );

  const one = fixtureContext(["ama"]);
  await model.methods.index.execute({}, one.context);
  const catOne = one.writes[0].data as { sourceCount: number };
  assertEquals(
    catOne.sourceCount,
    1,
    "sanity: a genuinely non-empty single-cluster filter behaves as documented",
  );
});

// ===========================================================================
// LB6 size cap on read()/index() via maxFileBytes -- LOW -- FIXED
// ===========================================================================

const LARGE_BODY_CHARS = 500_000;
const TINY_CAP_BYTES = 1024;

Deno.test("pin (career-kb-latent-bugs LB6, LOW -- FIXED): a source exceeding maxFileBytes is rejected", async () => {
  const largeBody = "fixture-filler-text ".repeat(
    Math.ceil(LARGE_BODY_CHARS / 20),
  );
  await withTempCorpus(
    {
      "success-outcomes/fixture-large.md": validMd(
        "Fixture Large",
        "success-outcomes",
        largeBody,
      ),
    },
    undefined,
    async (baseDir) => {
      const { context, writes } = makeContext(undefined, baseDir, {
        maxFileBytes: TINY_CAP_BYTES,
      });
      await assertRejects(
        () =>
          model.methods.read.execute(
            { file: "success-outcomes/fixture-large.md" },
            context,
          ),
        Error,
        "exceeding",
      );
      assertEquals(
        writes.length,
        0,
        "no resource is written when the size cap rejects the read",
      );
    },
  );
});

Deno.test("pin (career-kb-latent-bugs LB6, LOW -- FIXED): a small file UNDER a tiny cap still reads successfully", async () => {
  await withTempCorpus(
    {
      "success-outcomes/fixture-small.md": validMd(
        "Fixture Small",
        "success-outcomes",
      ),
    },
    undefined,
    async (baseDir) => {
      const { context, writes } = makeContext(undefined, baseDir, {
        maxFileBytes: TINY_CAP_BYTES,
      });
      await model.methods.read.execute(
        { file: "success-outcomes/fixture-small.md" },
        context,
      );
      assertEquals(writes.length, 1);
      const doc = writes[0].data as { content: string };
      assert(
        doc.content.includes("Fixture body text."),
        "a file safely under the cap must still read in full",
      );
    },
  );
});

Deno.test("pin (career-kb-latent-bugs LB6+LB4, LOW -- FIXED): index() over a corpus with one oversized entry + one small entry writes a catalog of just the small one", async () => {
  const largeBody = "fixture-filler-text ".repeat(
    Math.ceil(LARGE_BODY_CHARS / 20),
  );
  await withTempCorpus(
    {
      "success-outcomes/fixture-oversized.md": validMd(
        "Fixture Oversized",
        "success-outcomes",
        largeBody,
      ),
      "success-outcomes/fixture-normal.md": validMd(
        "Fixture Normal",
        "success-outcomes",
      ),
    },
    undefined,
    async (baseDir) => {
      const { context, writes } = makeContext(undefined, baseDir, {
        maxFileBytes: TINY_CAP_BYTES,
      });
      await model.methods.index.execute({}, context);
      assertEquals(writes.length, 1);
      const cat = model.resources.catalog.schema.parse(writes[0].data);
      assertEquals(
        cat.sourceCount,
        1,
        "the oversized entry's readRef() throws, loadSources() skips it (LB4), leaving only the small source",
      );
      assertEquals(cat.sources[0].file, "success-outcomes/fixture-normal.md");
    },
  );
});

// ===========================================================================
// LB7 verbatim unsanitized content storage -- LOW/info -- BY DESIGN
// ===========================================================================

Deno.test("pin (career-kb-latent-bugs LB7, LOW/info -- BY DESIGN): read()'s `content` field returns markdown VERBATIM by design AND documents content as untrusted-must-sanitize", async () => {
  const payload = "<script>alert('fixture-injection-marker')</script>";
  await withTempCorpus(
    {
      "success-outcomes/fixture-unsanitized.md": validMd(
        "Fixture Unsanitized",
        "success-outcomes",
        payload,
      ),
    },
    undefined,
    async (baseDir) => {
      const { context, writes } = makeContext(undefined, baseDir);
      await model.methods.read.execute(
        { file: "success-outcomes/fixture-unsanitized.md" },
        context,
      );
      const doc = writes[0].data as { content: string };
      assert(
        doc.content.includes(payload),
        "the raw, unescaped <script> tag survives byte-for-byte into the returned content -- lossless by design, this model returns source markdown to an agent/LLM consumer, not a trusted-HTML renderer",
      );
    },
  );

  const desc = model.resources.document.schema.shape.content.description ??
    "";
  assert(
    /untrusted|sanitiz/i.test(desc),
    `expected DocumentSchema.content to document the untrusted-must-sanitize contract, got: "${desc}"`,
  );

  const readDesc = model.methods.read.description;
  assert(
    /untrusted|sanitiz/i.test(readDesc),
    `expected read()'s method description to carry the same untrusted-content caveat, got: "${readDesc}"`,
  );
});

// ===========================================================================
// Covered-negatives: credential leak / subprocess+network egress -- REFUTED
// ===========================================================================

Deno.test("refuted: globalArguments carries no secret-shaped field -- `clusters`/`maxFileBytes` are the only keys, and neither is credential-shaped", () => {
  const keys = Object.keys(model.globalArguments.shape);
  assertEquals(keys, ["clusters", "maxFileBytes"]);
  for (const k of keys) {
    assert(
      !/token|secret|key|password|credential/i.test(k),
      `globalArgs key "${k}" looks credential-shaped`,
    );
  }
});

Deno.test("refuted: career_kb.ts invokes neither Deno.Command nor fetch anywhere -- there is no subprocess or network egress surface to attack", async () => {
  const source = await Deno.readTextFile(
    new URL("./career_kb.ts", import.meta.url),
  );
  assert(!source.includes("Deno.Command"), "no subprocess seam exists");
  assert(!/\bfetch\(/.test(source), "no network fetch seam exists");
});

// ===========================================================================
// Fixtures-secret-scan -- mechanical backstop over the committed corpus
// ===========================================================================

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "SECRET-shaped identifier", re: /\b[A-Z_]*SECRET[A-Z_]*\b/ },
  {
    name: "high-entropy token-shaped value",
    re: /^[A-Za-z0-9+/_=-]{32,}$/,
  },
  { name: "bearer-token shaped value", re: /^Bearer\s+[A-Za-z0-9._-]{20,}$/ },
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      out.push(...(await walk(path)));
    } else if (entry.isFile) {
      out.push(path);
    }
  }
  return out;
}

Deno.test("fixtures-secret-scan: no committed source file under fixtures/references or fixtures/outside contains a secret-shaped token", async () => {
  // Scoped to the two DATA corpus directories, not fixtures/PROVENANCE.md --
  // that file is prose documentation whose markdown table-separator rules
  // (long runs of `-`) are themselves high-entropy-shaped by this scanner's
  // own pattern, which would be a scanner false positive, not a real risk.
  const files = [
    ...(await walk(`${FIXTURES_DIR}/references`)),
    ...(await walk(`${FIXTURES_DIR}/outside`)),
  ];
  assert(files.length > 0, "sanity: the walk must find at least one file");
  const violations: string[] = [];
  for (const file of files) {
    const raw = await Deno.readTextFile(file);
    for (const { name, re } of SECRET_PATTERNS) {
      for (const token of raw.split(/\s+/)) {
        if (re.test(token)) {
          violations.push(`${file}: token "${token}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity -- the scanner actually detects an injected secret shape", () => {
  const poisoned = "a".repeat(40);
  const violations: string[] = [];
  for (const { re } of SECRET_PATTERNS) {
    if (re.test(poisoned)) violations.push(poisoned);
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real high-entropy shape",
  );
});
