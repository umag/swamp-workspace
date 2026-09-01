import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  loadReference,
  model,
  normalizeScores,
  ReferenceSchema,
  resolveSkill,
  summarize,
} from "./vecs.ts";

// Resolve the bundled reference the way the manifest does at runtime.
const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const ctx = { extensionFile: (p: string) => `${REPO_ROOT}${p}` };

const DIMENSIONS = [
  {
    key: "vision",
    letter: "V",
    title: "Vision",
    href: "vision.html",
    intro: "",
    skillCount: 1,
    skillSlugs: ["visual-literacy"],
  },
  {
    key: "execution",
    letter: "E",
    title: "Execution",
    href: "execution.html",
    intro: "",
    skillCount: 2,
    skillSlugs: ["motion", "finishing"],
  },
];

const SKILLS = [
  {
    slug: "motion",
    title: "Motion",
    dimension: "execution",
    dimensionLetter: "E",
    position: 4,
    knowledge: ["ритм"],
    abilities: ["loop"],
  },
  {
    slug: "finishing",
    title: "Доведение",
    dimension: "execution",
    dimensionLetter: "E",
    position: 6,
    knowledge: ["чистота"],
    abilities: ["редактировать"],
  },
  {
    slug: "visual-literacy",
    title: "Визуальная грамотность",
    dimension: "vision",
    dimensionLetter: "V",
    position: 1,
    knowledge: ["композиция"],
    abilities: ["анализировать"],
  },
];

// ---------- bundled reference -------------------------------------------------

Deno.test("the bundled reference file loads and validates", async () => {
  const ref = await loadReference(ctx);
  assertEquals(ref.source.startsWith("https://"), true);
  assertEquals(ref.dimensions.length, 4);
  assertEquals(ref.skills.length, 19);
  assertEquals(ref.courses.length > 0, true);
});

Deno.test("the bundled reference covers all four dimensions in order", async () => {
  const ref = await loadReference(ctx);
  assertEquals(ref.dimensions.map((d) => d.key), [
    "vision",
    "execution",
    "communication",
    "strategy",
  ]);
  assertEquals(ref.dimensions.map((d) => d.letter), ["V", "E", "C", "S"]);
});

Deno.test("every bundled skill has knowledge, abilities and a unique slug", async () => {
  const ref = await loadReference(ctx);
  const slugs = new Set<string>();
  for (const s of ref.skills) {
    assertEquals(s.knowledge.length > 0, true, `${s.slug} has no knowledge`);
    assertEquals(s.abilities.length > 0, true, `${s.slug} has no abilities`);
    assertEquals(/^[a-z0-9-]+$/.test(s.slug), true, `${s.slug} is not ASCII`);
    assertEquals(slugs.has(s.slug), false, `${s.slug} is duplicated`);
    slugs.add(s.slug);
  }
});

Deno.test("each dimension's skillSlugs match the skills that reference it", async () => {
  const ref = await loadReference(ctx);
  for (const d of ref.dimensions) {
    const owned = ref.skills.filter((s) => s.dimension === d.key);
    assertEquals(d.skillSlugs, owned.map((s) => s.slug));
    assertEquals(d.skillCount, owned.length);
  }
});

Deno.test("loadReference fails loudly when the bundle is missing", async () => {
  await assertRejects(
    () => loadReference({ extensionFile: () => "/nonexistent/vecs.json" }),
    Error,
    "Cannot read the bundled framework",
  );
});

Deno.test("ReferenceSchema rejects a malformed bundle", () => {
  const bad = ReferenceSchema.safeParse({ source: "x", skills: [] });
  assertEquals(bad.success, false);
});

// ---------- scoring input -----------------------------------------------------

Deno.test("normalizeScores accepts an object", () => {
  assertEquals(normalizeScores({ motion: 3, finishing: 2 }), {
    motion: 3,
    finishing: 2,
  });
});

Deno.test("normalizeScores accepts the compact CLI string form", () => {
  assertEquals(normalizeScores("motion=3, finishing = 2\nvision:1"), {
    motion: 3,
    finishing: 2,
    vision: 1,
  });
});

Deno.test("normalizeScores accepts a JSON string", () => {
  assertEquals(normalizeScores('{"motion": 4}'), { motion: 4 });
});

Deno.test("normalizeScores returns empty for null/undefined", () => {
  assertEquals(normalizeScores(null), {});
  assertEquals(normalizeScores(undefined), {});
});

Deno.test("normalizeScores rejects unparseable input", () => {
  assertThrows(() => normalizeScores("motion"), Error, "cannot parse score");
  assertThrows(() => normalizeScores("{oops"), Error, "did not parse");
  assertThrows(
    () => normalizeScores({ motion: "high" }),
    Error,
    "not a number",
  );
  assertThrows(() => normalizeScores(42), Error, "must be an object");
});

// ---------- skill resolution --------------------------------------------------

Deno.test("resolveSkill matches slug, title and coordinate", () => {
  assertEquals(resolveSkill(SKILLS, "motion")?.slug, "motion");
  assertEquals(resolveSkill(SKILLS, "Доведение")?.slug, "finishing");
  assertEquals(resolveSkill(SKILLS, "execution:6")?.slug, "finishing");
  assertEquals(resolveSkill(SKILLS, "e:4")?.slug, "motion");
  assertEquals(resolveSkill(SKILLS, "vision:1")?.slug, "visual-literacy");
});

Deno.test("resolveSkill returns null when nothing or too much matches", () => {
  assertEquals(resolveSkill(SKILLS, "нет такого"), null);
  // "i" appears in more than one slug/title, so the partial match is ambiguous.
  assertEquals(resolveSkill(SKILLS, "i"), null);
});

Deno.test("every bundled skill resolves by each of its three forms", async () => {
  const ref = await loadReference(ctx);
  for (const s of ref.skills) {
    assertEquals(resolveSkill(ref.skills, s.slug)?.slug, s.slug);
    assertEquals(resolveSkill(ref.skills, s.title)?.slug, s.slug);
    assertEquals(
      resolveSkill(ref.skills, `${s.dimension}:${s.position}`)?.slug,
      s.slug,
    );
  }
});

// ---------- roll-up -----------------------------------------------------------

Deno.test("summarize clamps scores and rolls up per dimension", () => {
  const got = summarize(DIMENSIONS, SKILLS, { motion: 9, finishing: -3 });
  // 9 clamps down to the 5 ceiling, -3 clamps up to the 0 floor.
  assertEquals(got.scored.map((s) => s.score), [5, 0]);
  assertEquals(got.unscored, ["visual-literacy"]);
  assertEquals(got.overallMean, 2.5);

  const execution = got.dimensions.find((d) => d.key === "execution")!;
  assertEquals(execution.mean, 2.5);
  assertEquals(execution.scored, 2);
  assertEquals(execution.total, 2);

  const vision = got.dimensions.find((d) => d.key === "vision")!;
  assertEquals(vision.mean, 0);
  assertEquals(vision.scored, 0);
  assertEquals(vision.total, 1);
});

Deno.test("summarize attaches a scale band to each score", () => {
  const got = summarize(DIMENSIONS, SKILLS, { motion: 5 });
  assertEquals(got.scored[0].band.length > 0, true);
});

Deno.test("summarize handles an empty score set", () => {
  const got = summarize(DIMENSIONS, SKILLS, {});
  assertEquals(got.overallMean, 0);
  assertEquals(got.scored, []);
  assertEquals(got.unscored.length, 3);
});

Deno.test("summarize over the real bundle covers every skill", async () => {
  const ref = await loadReference(ctx);
  const all = Object.fromEntries(ref.skills.map((s) => [s.slug, 3]));
  const got = summarize(ref.dimensions, ref.skills, all);
  assertEquals(got.scored.length, 19);
  assertEquals(got.unscored, []);
  assertEquals(got.overallMean, 3);
  assertEquals(got.dimensions.map((d) => d.mean), [3, 3, 3, 3]);
});

// ---------- model shape -------------------------------------------------------

Deno.test("model exposes the documented type, version and methods", () => {
  assertEquals(model.type, "@magistr/vecs/school");
  assertEquals(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), true);
  assertEquals(Object.keys(model.methods).sort(), [
    "assess",
    "courses",
    "framework",
    "gaps",
    "skill",
  ]);
});

Deno.test("every method declares an arguments schema and a description", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    const m = method as { description?: string; arguments?: unknown };
    assertEquals(
      typeof m.description === "string" && m.description.length > 0,
      true,
      `${name} is missing a description`,
    );
    assertEquals(
      m.arguments !== undefined,
      true,
      `${name} is missing an arguments schema`,
    );
  }
});

Deno.test("every resource spec name is hyphen-free and has a schema", () => {
  for (const [name, spec] of Object.entries(model.resources)) {
    assertEquals(
      name.includes("-"),
      false,
      `${name} must not contain a hyphen`,
    );
    assertEquals(
      (spec as { schema?: unknown }).schema !== undefined,
      true,
      `${name} is missing a schema`,
    );
  }
});
