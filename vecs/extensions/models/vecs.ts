/**
 * The V.E.C.S. competency framework as queryable swamp data, with 0–5
 * self-assessment and gap analysis on top.
 *
 * @module
 */
import { z } from "npm:zod@4";

// =============================================================================
// @magistr/vecs/school
//
// V.E.C.S. is the Method school's model (school.mishkatz.com) of what makes a
// creative specialist strong: four dimensions — Vision, Execution,
// Communication, Strategy — holding 19 skills, each published with explicit
// Знания (knowledge) and Умения (abilities) lists.
//
// The framework ships as a bundled reference file (`references/vecs.json`,
// declared in the manifest's additionalFiles and read via
// `context.extensionFile`), so this model needs no configuration, no
// credentials and no network access. Regenerate the bundle with
// `scripts/build_reference.ts` when the school changes its curriculum.
// =============================================================================

const REFERENCE_FILE = "references/vecs.json";

/** Meaning of each point on the 0–5 self-rating scale used by `assess`. */
const SCALE_BANDS: Record<number, string> = {
  0: "не касался — нет ни знаний, ни практики",
  1: "знаю, что это существует; терминология узнаётся",
  2: "делал под руководством / по туториалу, не самостоятельно",
  3: "делаю самостоятельно на рабочих задачах, с усилием",
  4: "делаю уверенно и предсказуемо, могу объяснить выбор",
  5: "могу учить других и развивать практику дальше",
};

// ---------- Global arguments -------------------------------------------------

// The framework is bundled, so there is nothing to configure.
const GlobalArgsSchema = z.object({});

// ---------- Reference-data schemas -------------------------------------------

const SkillSchema = z.object({
  slug: z.string(),
  title: z.string(),
  dimension: z.string(),
  dimensionLetter: z.string(),
  position: z.number(),
  knowledge: z.array(z.string()),
  abilities: z.array(z.string()),
  href: z.string().optional(),
});

const DimensionSchema = z.object({
  key: z.string(),
  letter: z.string(),
  title: z.string(),
  href: z.string(),
  intro: z.string(),
  skillCount: z.number(),
  skillSlugs: z.array(z.string()),
});

const CourseSchema = z.object({
  title: z.string(),
  href: z.string(),
  price: z.string().optional(),
  priceStruck: z.boolean(),
  summary: z.string().optional(),
});

/** Shape of the bundled `references/vecs.json` payload. */
export const ReferenceSchema = z.object({
  source: z.string(),
  capturedAt: z.string(),
  dimensions: z.array(DimensionSchema),
  skills: z.array(SkillSchema),
  courses: z.array(CourseSchema),
});

type Reference = z.infer<typeof ReferenceSchema>;
type Skill = z.infer<typeof SkillSchema>;

// ---------- Resource schemas -------------------------------------------------

const FrameworkSchema = z.object({
  source: z.string(),
  capturedAt: z.string(),
  dimensionFilter: z.string().optional(),
  dimensionCount: z.number(),
  skillCount: z.number(),
  dimensions: z.array(DimensionSchema),
  skills: z.array(SkillSchema),
  timestamp: z.string(),
});

const SkillDetailSchema = z.object({
  slug: z.string(),
  title: z.string(),
  dimension: z.string(),
  dimensionLetter: z.string(),
  position: z.number(),
  knowledge: z.array(z.string()),
  abilities: z.array(z.string()),
  href: z.string().optional(),
  sourceUrl: z.string(),
  timestamp: z.string(),
});

const CourseListSchema = z.object({
  source: z.string(),
  capturedAt: z.string(),
  courseCount: z.number(),
  courses: z.array(CourseSchema),
  timestamp: z.string(),
});

const SkillScoreSchema = z.object({
  slug: z.string(),
  title: z.string(),
  dimension: z.string(),
  score: z.number(),
  band: z.string(),
});

const DimensionScoreSchema = z.object({
  key: z.string(),
  letter: z.string(),
  title: z.string(),
  mean: z.number(),
  scored: z.number(),
  total: z.number(),
});

const AssessmentSchema = z.object({
  label: z.string(),
  note: z.string().optional(),
  scale: z.record(z.string(), z.string()),
  overallMean: z.number(),
  coverage: z.number(),
  scored: z.array(SkillScoreSchema),
  unscored: z.array(z.string()),
  unknownKeys: z.array(z.string()),
  dimensions: z.array(DimensionScoreSchema),
  weakestDimension: z.string(),
  strongestDimension: z.string(),
  timestamp: z.string(),
});

const StudyItemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  dimension: z.string(),
  score: z.number(),
  gapToTarget: z.number(),
  knowledge: z.array(z.string()),
  abilities: z.array(z.string()),
  href: z.string().optional(),
});

const GapPlanSchema = z.object({
  assessedAt: z.string(),
  assessmentLabel: z.string(),
  target: z.number(),
  overallMean: z.number(),
  weakestDimension: z.string(),
  dimensions: z.array(DimensionScoreSchema),
  focus: z.array(StudyItemSchema),
  unscored: z.array(z.string()),
  delta: z.object({
    comparedTo: z.string().optional(),
    overallMeanChange: z.number().optional(),
    improved: z.array(z.string()),
    regressed: z.array(z.string()),
  }),
  timestamp: z.string(),
});

// ---------- Reference loading ------------------------------------------------

/**
 * Read and validate the bundled framework. Resolved relative to the manifest
 * directory, so it works the same for a source-added and a pulled extension.
 */
export async function loadReference(
  context: { extensionFile: (path: string) => string },
): Promise<Reference> {
  const path = context.extensionFile(REFERENCE_FILE);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    throw new Error(
      `Cannot read the bundled framework at ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = ReferenceSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Bundled framework at ${path} is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// ---------- Assessment helpers ----------------------------------------------

/**
 * Accept scores either as an object (`{"motion": 3}`) or as the compact
 * `slug=score,slug=score` string form that survives `--input` on the CLI.
 */
export function normalizeScores(input: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (input === null || input === undefined) return out;

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) {
      try {
        return normalizeScores(JSON.parse(trimmed));
      } catch {
        throw new Error(
          `scores looked like JSON but did not parse: ${trimmed.slice(0, 80)}`,
        );
      }
    }
    for (const pair of trimmed.split(/[,\n]/)) {
      if (!pair.trim()) continue;
      const m = pair.match(/^\s*([^=:]+)\s*[=:]\s*(-?[\d.]+)\s*$/);
      if (!m) {
        throw new Error(
          `cannot parse score "${pair.trim()}" — expected "<skill>=<0-5>"`,
        );
      }
      out[m[1].trim()] = Number(m[2]);
    }
    return out;
  }

  if (typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const num = typeof v === "number" ? v : Number(v);
      if (Number.isNaN(num)) {
        throw new Error(`score for "${k}" is not a number: ${String(v)}`);
      }
      out[k] = num;
    }
    return out;
  }

  throw new Error(`scores must be an object or a "slug=score" string`);
}

/**
 * Resolve a user-supplied skill key against the framework. Accepts the ASCII
 * slug, the Russian title, or a `dimension:position` coordinate.
 */
export function resolveSkill(skills: Skill[], key: string): Skill | null {
  const needle = key.trim().toLowerCase();
  const bySlug = skills.find((s) => s.slug.toLowerCase() === needle);
  if (bySlug) return bySlug;
  const byTitle = skills.find((s) => s.title.toLowerCase() === needle);
  if (byTitle) return byTitle;
  const coord = needle.match(/^([a-z]+)\s*[:.\-]\s*(\d+)$/);
  if (coord) {
    const found = skills.find((s) =>
      (s.dimension === coord[1] ||
        s.dimensionLetter.toLowerCase() === coord[1]) &&
      s.position === Number(coord[2])
    );
    if (found) return found;
  }
  const partial = skills.filter((s) =>
    s.slug.includes(needle) || s.title.toLowerCase().includes(needle)
  );
  return partial.length === 1 ? partial[0] : null;
}

/** Round to two decimals without accumulating float noise. */
function round2(n: number): number {
  return Number(n.toFixed(2));
}

/** Build the per-dimension and overall roll-up for a set of skill scores. */
export function summarize(
  dimensions: Array<z.infer<typeof DimensionSchema>>,
  skills: Skill[],
  scores: Record<string, number>,
): {
  scored: Array<z.infer<typeof SkillScoreSchema>>;
  unscored: string[];
  dimensions: Array<z.infer<typeof DimensionScoreSchema>>;
  overallMean: number;
} {
  const scored: Array<z.infer<typeof SkillScoreSchema>> = [];
  const unscored: string[] = [];

  for (const skill of skills) {
    const raw = scores[skill.slug];
    if (raw === undefined) {
      unscored.push(skill.slug);
      continue;
    }
    const clamped = Math.min(5, Math.max(0, raw));
    scored.push({
      slug: skill.slug,
      title: skill.title,
      dimension: skill.dimension,
      score: clamped,
      band: SCALE_BANDS[Math.round(clamped)] ?? "",
    });
  }

  const rollup = dimensions.map((d) => {
    const all = skills.filter((s) => s.dimension === d.key);
    const hits = scored.filter((s) => s.dimension === d.key);
    const mean = hits.length
      ? hits.reduce((a, b) => a + b.score, 0) / hits.length
      : 0;
    return {
      key: d.key,
      letter: d.letter,
      title: d.title,
      mean: round2(mean),
      scored: hits.length,
      total: all.length,
    };
  }).filter((d) => d.total > 0);

  const overallMean = scored.length
    ? round2(scored.reduce((a, b) => a + b.score, 0) / scored.length)
    : 0;

  return { scored, unscored, dimensions: rollup, overallMean };
}

// ---------- Model ------------------------------------------------------------

type Assessment = z.infer<typeof AssessmentSchema>;

/** Model definition serving the V.E.C.S. framework and scoring against it. */
export const model = {
  type: "@magistr/vecs/school",
  version: "2026.07.28.1",
  description:
    "The V.E.C.S. competency framework (Vision / Execution / Communication / Strategy) as queryable data, with 0–5 self-assessment and gap analysis.",
  globalArguments: GlobalArgsSchema,
  resources: {
    framework: {
      description:
        "The V.E.C.S. dimensions and their skills, each with its knowledge and ability lists.",
      schema: FrameworkSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    skill: {
      description:
        "One skill's full knowledge and ability lists, with a link back to its page.",
      schema: SkillDetailSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    courses: {
      description: "The school's course list with prices and summaries.",
      schema: CourseListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    assessment: {
      description:
        "A self-assessment against the framework: per-skill scores, per-dimension means, and coverage.",
      schema: AssessmentSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    gapPlan: {
      description:
        "A study plan derived from the weakest scored skills, with their own knowledge and ability bullets as the syllabus.",
      schema: GapPlanSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    framework: {
      description:
        "Return the V.E.C.S. framework — the four dimensions and their skills with knowledge/ability lists. Optionally filtered to one dimension.",
      arguments: z.object({
        dimension: z.string().optional().describe(
          "Restrict to one dimension: vision | execution | communication | strategy (or V/E/C/S).",
        ),
      }),
      execute: async (
        args: { dimension?: string },
        context: {
          extensionFile: (path: string) => string;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const ref = await loadReference(context);
        const filter = args.dimension?.trim().toLowerCase();

        const dimensions = filter
          ? ref.dimensions.filter((d) =>
            d.key === filter || d.letter.toLowerCase() === filter
          )
          : ref.dimensions;

        if (filter && dimensions.length === 0) {
          throw new Error(
            `Unknown dimension "${args.dimension}" — expected one of: ` +
              ref.dimensions.map((d) => d.key).join(", "),
          );
        }

        const keys = new Set(dimensions.map((d) => d.key));
        const skills = ref.skills.filter((s) => keys.has(s.dimension));

        const handle = await context.writeResource(
          "framework",
          filter ? `framework-${dimensions[0].key}` : "framework",
          {
            source: ref.source,
            capturedAt: ref.capturedAt,
            dimensionFilter: filter ? dimensions[0].key : undefined,
            dimensionCount: dimensions.length,
            skillCount: skills.length,
            dimensions,
            skills,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    skill: {
      description:
        "Return one skill's full knowledge and ability lists. Accepts the ASCII slug, the Russian title, or a `dimension:position` coordinate such as `execution:4`.",
      arguments: z.object({
        skill: z.string().describe(
          "Skill identifier — slug (`motion`), title (`Доведение`), or coordinate (`vision:2`).",
        ),
      }),
      execute: async (
        args: { skill: string },
        context: {
          extensionFile: (path: string) => string;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const ref = await loadReference(context);
        const found = resolveSkill(ref.skills, args.skill);
        if (!found) {
          throw new Error(
            `No single skill matches "${args.skill}". Known slugs: ` +
              ref.skills.map((s) => s.slug).join(", "),
          );
        }

        const handle = await context.writeResource(
          "skill",
          `skill-${found.slug}`,
          {
            ...found,
            sourceUrl: `${ref.source}/${encodeURI(found.href ?? "")}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    courses: {
      description: "List the school's courses with their prices and summaries.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          extensionFile: (path: string) => string;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const ref = await loadReference(context);
        const handle = await context.writeResource("courses", "courses", {
          source: ref.source,
          capturedAt: ref.capturedAt,
          courseCount: ref.courses.length,
          courses: ref.courses,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    assess: {
      description:
        "Record a self-assessment against the framework. Scores are 0–5 per skill, given as an object or as a compact `slug=score,slug=score` string. Idempotent — an identical re-run is skipped unless `force` is set.",
      arguments: z.object({
        scores: z.union([
          z.record(z.string(), z.number()),
          z.string(),
        ]).describe(
          'Per-skill ratings 0–5, e.g. {"motion":3,"finishing":2} or "motion=3,finishing=2".',
        ),
        label: z.string().optional().describe(
          "Label for this assessment (default: today's date).",
        ),
        note: z.string().optional().describe(
          "Free-text context for this assessment.",
        ),
        force: z.boolean().optional().describe(
          "Write a new version even if the scores are unchanged.",
        ),
      }),
      execute: async (
        args: {
          scores: unknown;
          label?: string;
          note?: string;
          force?: boolean;
        },
        context: {
          extensionFile: (path: string) => string;
          readResource?: (
            name: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger?: { info: (msg: string, props?: unknown) => void };
        },
      ) => {
        const ref = await loadReference(context);
        const raw = normalizeScores(args.scores);

        // Resolve every supplied key against the framework before scoring, so a
        // typo surfaces as `unknownKeys` instead of silently vanishing.
        const resolved: Record<string, number> = {};
        const unknownKeys: string[] = [];
        for (const [key, value] of Object.entries(raw)) {
          const skill = resolveSkill(ref.skills, key);
          if (!skill) {
            unknownKeys.push(key);
            continue;
          }
          resolved[skill.slug] = value;
        }
        if (Object.keys(resolved).length === 0) {
          throw new Error(
            `None of the supplied keys matched a framework skill: ` +
              `${
                unknownKeys.join(", ")
              }. Run \`framework\` to list valid slugs.`,
          );
        }

        const { scored, unscored, dimensions, overallMean } = summarize(
          ref.dimensions,
          ref.skills,
          resolved,
        );
        const ranked = dimensions.filter((d) => d.scored > 0)
          .sort((a, b) => a.mean - b.mean);

        const assessment: Assessment = {
          label: args.label ?? new Date().toISOString().slice(0, 10),
          note: args.note,
          scale: Object.fromEntries(
            Object.entries(SCALE_BANDS).map(([k, v]) => [k, v]),
          ),
          overallMean,
          coverage: round2(scored.length / (ref.skills.length || 1)),
          scored,
          unscored,
          unknownKeys,
          dimensions,
          weakestDimension: ranked[0]?.key ?? "",
          strongestDimension: ranked[ranked.length - 1]?.key ?? "",
          timestamp: new Date().toISOString(),
        };

        // Idempotency: skip a write whose scores match the stored latest.
        const prior = await context.readResource?.("assessment-current") as
          | Assessment
          | null;
        if (!args.force && prior) {
          const priorScores = JSON.stringify(
            Object.fromEntries(prior.scored.map((s) => [s.slug, s.score])),
          );
          const nextScores = JSON.stringify(
            Object.fromEntries(scored.map((s) => [s.slug, s.score])),
          );
          if (priorScores === nextScores && prior.label === assessment.label) {
            context.logger?.info(
              "assessment unchanged — skipping write (pass force=true to override)",
            );
            return { dataHandles: [] };
          }
        }

        const handle = await context.writeResource(
          "assessment",
          "assessment-current",
          assessment as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    gaps: {
      description:
        "Turn the latest assessment into a study plan: per-dimension balance, the lowest-scoring skills with their own knowledge/ability bullets as the syllabus, and the delta against the previous assessment.",
      arguments: z.object({
        topN: z.number().int().positive().optional().describe(
          "How many weakest skills to expand into the plan (default 5).",
        ),
        target: z.number().optional().describe(
          "Target score to measure the gap against (default 4).",
        ),
      }),
      execute: async (
        args: { topN?: number; target?: number },
        context: {
          modelType: string;
          modelId: string;
          extensionFile: (path: string) => string;
          readResource?: (
            name: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          dataRepository?: {
            findByName: (
              type: string,
              modelId: string,
              name: string,
              version?: number,
            ) => Promise<{ version: number } | null>;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const ref = await loadReference(context);
        const latest = await context.readResource?.("assessment-current") as
          | Assessment
          | null;
        if (!latest) {
          throw new Error(
            "No assessment stored yet — run the `assess` method first.",
          );
        }

        const topN = args.topN ?? 5;
        const target = args.target ?? 4;

        const focus = [...latest.scored]
          .sort((a, b) => a.score - b.score || a.slug.localeCompare(b.slug))
          .slice(0, topN)
          .map((s) => {
            const skill = ref.skills.find((k) => k.slug === s.slug);
            return {
              slug: s.slug,
              title: s.title,
              dimension: s.dimension,
              score: s.score,
              gapToTarget: round2(Math.max(0, target - s.score)),
              knowledge: skill?.knowledge ?? [],
              abilities: skill?.abilities ?? [],
              href: skill?.href,
            };
          });

        // Compare against the previous stored version, when there is one.
        const delta: z.infer<typeof GapPlanSchema>["delta"] = {
          improved: [],
          regressed: [],
        };
        const current = await context.dataRepository?.findByName(
          context.modelType,
          context.modelId,
          "assessment-current",
        );
        if (current && current.version > 1) {
          const prev = await context.readResource?.(
            "assessment-current",
            current.version - 1,
          ) as Assessment | null;
          if (prev) {
            delta.comparedTo = prev.label;
            delta.overallMeanChange = round2(
              latest.overallMean - prev.overallMean,
            );
            const prevBySlug = new Map(
              prev.scored.map((s) => [s.slug, s.score]),
            );
            for (const s of latest.scored) {
              const before = prevBySlug.get(s.slug);
              if (before === undefined) continue;
              if (s.score > before) delta.improved.push(s.slug);
              else if (s.score < before) delta.regressed.push(s.slug);
            }
          }
        }

        const handle = await context.writeResource("gapPlan", "gap-plan", {
          assessedAt: latest.timestamp,
          assessmentLabel: latest.label,
          target,
          overallMean: latest.overallMean,
          weakestDimension: latest.weakestDimension,
          dimensions: latest.dimensions,
          focus,
          unscored: latest.unscored,
          delta,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
