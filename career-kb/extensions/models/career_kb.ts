import { z } from "npm:zod@4";

// =============================================================================
// @magistr/career-kb
// A retrieval, routing, and triage layer over a career-research knowledge base
// (career-psychology extractions organized into the `ama`, `inaction`, and
// `success-outcomes` clusters) — this models the research, not any subject.
// The corpus ships as bundled reference files under `references/` (declared in
// the manifest's additionalFiles) and is read at runtime via
// `context.extensionFile()`, so the model needs no configuration.
// =============================================================================

const REF_DIR = "references";

const GlobalArgsSchema = z.object({
  clusters: z.array(z.string()).default(["ama", "inaction", "success-outcomes"])
    .describe(
      "Optional filter restricting index/search to these bundled clusters.",
    ),
});

// ---------- Resource schemas -------------------------------------------------

const SourceEntrySchema = z.object({
  file: z.string(),
  cluster: z.string(),
  slug: z.string(),
  title: z.string(),
  docType: z.string().optional(),
  authors: z.string().optional(),
  year: z.union([z.number(), z.string()]).optional(),
  topics: z.array(z.string()),
  keyConstructs: z.array(z.string()),
  summary: z.string().optional(),
  sections: z.array(z.string()),
});

const CatalogSchema = z.object({
  sourceCount: z.number(),
  clusters: z.array(z.object({ name: z.string(), count: z.number() })),
  allTopics: z.array(z.string()),
  allKeyConstructs: z.array(z.string()),
  sources: z.array(SourceEntrySchema),
  timestamp: z.string(),
});

const SearchHitSchema = z.object({
  file: z.string(),
  cluster: z.string(),
  slug: z.string(),
  title: z.string(),
  score: z.number(),
  matchedTerms: z.array(z.string()),
  why: z.string(),
  summary: z.string().optional(),
});

const SearchResultSchema = z.object({
  query: z.string(),
  clusterFilter: z.string().optional(),
  topK: z.number(),
  totalMatches: z.number(),
  hitCount: z.number(),
  truncated: z.boolean(),
  hits: z.array(SearchHitSchema),
  timestamp: z.string(),
});

const DocumentSchema = z.object({
  file: z.string(),
  cluster: z.string(),
  slug: z.string(),
  title: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  section: z.string().optional(),
  availableSections: z.array(z.string()),
  content: z.string(),
  timestamp: z.string(),
});

const FamilyAssessmentSchema = z.object({
  family: z.string(),
  confidence: z.number(),
  signals: z.array(z.string()),
  instrument: z.object({
    name: z.string(),
    items: z.string().optional(),
    scale: z.string(),
    dimensions: z.array(z.string()),
  }).optional(),
  readSources: z.array(z.string()),
  guidance: z.string(),
});

const AssessmentSchema = z.object({
  situation: z.string(),
  primaryFamily: z.string(),
  families: z.array(FamilyAssessmentSchema),
  carinas: z.object({
    mean: z.number(),
    band: z.string(),
    interpretation: z.string(),
  }).optional(),
  copingGuidance: z.object({
    increase: z.array(z.string()),
    reduce: z.array(z.string()),
    note: z.string(),
  }),
  caution: z.string(),
  timestamp: z.string(),
});

// ---------- Reference data (structural facts from the sources) ---------------

// SCCI (Lipshits-Braziler, Gati & Tatar, 2016) — 14 strategies / 3 clusters.
const SCCI = {
  productive: [
    "instrumental information-seeking",
    "emotional information-seeking",
    "problem-solving",
    "flexibility",
    "accommodation",
    "self-regulation",
  ],
  supportSeeking: [
    "instrumental help-seeking",
    "emotional help-seeking",
    "delegation",
  ],
  nonproductive: [
    "escape",
    "helplessness",
    "isolation",
    "submission",
    "opposition",
  ],
};

// EPCD (Gati et al., 2011) — 11 categories / 3 clusters.
const EPCD_CLUSTERS = [
  "Pessimistic Views (process / world of work / control)",
  "Anxiety (process / uncertainty / choosing / outcome)",
  "Self-concept & Identity (trait anxiety / self-esteem / uncrystallized identity / conflictual attachment & separation)",
];

// Which instrument + sources each problem family routes to.
const FAMILY_INFO = {
  inaction: {
    instrument: {
      name: "CARINAS — Career Inaction Scale (D'Huyvetter et al., 2025)",
      items: "8 items (unidimensional)",
      scale: "1–5 Likert (1 = completely disagree, 5 = completely agree)",
      dimensions: [
        "single factor: desire for change + insufficient action over time",
      ],
    },
    readSources: [
      "inaction/career-inaction.md",
      "inaction/career-inaction-scale.md",
      "inaction/career-inaction-psychodynamic.md",
    ],
    guidance:
      "Failing to act over time on a change you already want. Three inertia mechanisms keep you stuck: fear/anxiety about the change, near-term costs looming larger than long-term gains, and high cognitive load triggering avoidance. These are implicit — hard to self-justify, which feeds self-blame regret in the recall phase.",
  },
  indecision: {
    instrument: {
      name:
        "SCCI — Strategies for Coping with Career Indecision (Lipshits-Braziler et al., 2016)",
      items: "45 items, 14 strategies / 3 clusters",
      scale: "9-point (1 = does not describe me, 9 = describes me very well)",
      dimensions: [
        "Productive: " + SCCI.productive.join(", "),
        "Support-seeking: " + SCCI.supportSeeking.join(", "),
        "Nonproductive: " + SCCI.nonproductive.join(", "),
      ],
    },
    readSources: [
      "inaction/career-indecision-strategies.md",
      "inaction/career-indecision-decision-theories.md",
      "inaction/career-indecision-integrated.md",
      "inaction/career-indecision-anxiety.md",
    ],
    guidance:
      "Difficulty making a *specific* choice. Germeijs & De Boeck isolate three sources — lack of information, valuation problems, outcome uncertainty — and only valuation + outcome uncertainty actually predict indecision. Attack those two first.",
  },
  indecisiveness: {
    instrument: {
      name:
        "EPCD — Emotional & Personality Career Difficulties (Gati et al., 2011)",
      items: "25-item short form, 11 categories / 3 clusters",
      scale: "9-point (1 = does not describe me, 9 = describes me well)",
      dimensions: EPCD_CLUSTERS,
    },
    readSources: [
      "success-outcomes/career-difficulties.md",
      "inaction/chronic-career-indecision.md",
      "inaction/career-indecision-structure-measurement-xu-2019.md",
    ],
    guidance:
      "A chronic trait of struggling with *any* decision (vs. a one-off choice). Loads on neuroticism (r≈.60) and low career decision self-efficacy (r≈-.54). Self-efficacy and perceived autonomy are what distinguish chronic from developmental indecision (Guay et al.).",
  },
  "success-derailer": {
    instrument: undefined,
    readSources: [
      "success-outcomes/subjective-success.md",
      "success-outcomes/career-success.md",
      "success-outcomes/impostor-one.md",
      "success-outcomes/impostor-two.md",
      "success-outcomes/impostor-three.md",
    ],
    guidance:
      "You are moving, but the career doesn't *feel* successful or is being derailed. Unmet expectations is the single strongest negative correlate of subjective success (r≈-.77, Ng & Feldman). Impostor feelings serially route through avoidant coping into emotional exhaustion and suppressed career planning (Hutchins; Neureiter & Traut-Mattausch).",
  },
  "shock-transition": {
    instrument: undefined,
    readSources: [
      "success-outcomes/career-shocks.md",
      "success-outcomes/career-transition-theory.md",
      "success-outcomes/career-transition-outcomes.md",
      "success-outcomes/career-adaptability.md",
      "ama/ama-career-transitions.md",
    ],
    guidance:
      "An external, disruptive, often involuntary event (layoff, relocation, reorg, visa pressure) forces a career rethink. Career-shock theory deliberately rebalances away from pure individual agency; career adaptability (concern, control, curiosity, confidence) is the protective resource for working through it.",
  },
};

// Keyword signals for classifying a free-text situation into families.
const SIGNALS = {
  inaction: [
    "want to change",
    "want to leave",
    "stuck",
    "paralyz",
    "someday",
    "putting off",
    "procrastinat",
    "not acting",
    "never get around",
    "keep meaning to",
    "wantrepreneur",
    "too comfortable",
    "golden handcuff",
    "locked in",
    "inertia",
    "one day i",
    "haven't done anything",
  ],
  indecision: [
    "can't decide",
    "cannot decide",
    "don't know what i want",
    "which path",
    "choose between",
    "comparing options",
    "can't choose",
    "two offers",
    "torn between",
    "weighing",
    "should i take",
    "which job",
    "which role",
  ],
  indecisiveness: [
    "every decision",
    "with every choice",
    "i'm indecisive",
    "i am indecisive",
    "chronic",
    "second-guess everything",
    "overthink every",
    "perfectionis",
    "need certainty",
    "can't commit to anything",
    "always struggle to decide",
    "no matter what",
  ],
  "success-derailer": [
    "impostor",
    "imposter",
    "fraud",
    "don't deserve",
    "unmet expectation",
    "plateau",
    "passed over",
    "not progressing",
    "underpaid",
    "not recognized",
    "undervalued",
    "burnout",
    "dissatisf",
    "unfulfill",
  ],
  "shock-transition": [
    "laid off",
    "layoff",
    "fired",
    "relocat",
    "restructur",
    "reorg",
    "forced to",
    "redundan",
    "visa",
    "kennismigrant",
    "downsiz",
    "sudden",
    "unexpected",
    "shock",
    "my company is",
    "contracting",
  ],
};

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "are",
  "was",
  "but",
  "not",
  "you",
  "your",
  "what",
  "how",
  "why",
  "who",
  "when",
  "which",
  "from",
  "have",
  "has",
  "had",
  "does",
  "did",
  "can",
  "about",
  "into",
  "over",
  "than",
  "then",
  "they",
  "their",
  "them",
  "our",
  "out",
  "off",
  "all",
  "any",
  "more",
  "most",
  "some",
  "such",
  "only",
  "own",
  "same",
  "too",
  "very",
  "just",
  "should",
  "would",
  "could",
  "career",
  "careers",
]);

// ---------- Helpers ----------------------------------------------------------

/** Lowercase a string to a filesystem/instance-safe slug (≤48 chars); empty falls back to "main". */
export function slugify(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ).slice(0, 48);
  return out || "main";
}

/**
 * Parse a markdown file's YAML frontmatter into a record and return the body.
 * Handles quoted/unquoted scalars, inline `[a, b]` arrays, and numbers; a file
 * with no frontmatter block yields an empty record and the full text as body.
 */
export function parseFrontmatter(text) {
  const fm: Record<string, unknown> = {};
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { fm, body: text };
  const fmText = match[1];
  const body = match[2];
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (value === "") continue;
    let parsed: string | string[] | number = value;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      parsed = value.slice(1, -1);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      parsed = inner === ""
        ? []
        : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter((s) => s.length > 0);
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      parsed = Number(value);
    }
    fm[key] = parsed;
  }
  return { fm, body };
}

/** List the `## ` section headings in a markdown body, in document order. */
export function extractSections(body) {
  const sections: string[] = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) sections.push(m[1].trim());
  return sections;
}

/**
 * Extract one `## ` section (its heading plus content up to the next `## `) by
 * case-insensitive partial heading match; returns `undefined` if none matches.
 */
export function getSection(body, name) {
  const lines = body.split("\n");
  const target = name.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (h && h[1].trim().toLowerCase().includes(target)) {
      start = i;
      break;
    }
  }
  if (start === -1) return undefined;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/** Coerce a frontmatter value to a string array (array → strings, scalar → singleton, empty → []). */
export function asArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v === undefined || v === null || v === "") return [];
  return [String(v)];
}

/** Build one structured catalog entry from a source's relative path + raw markdown text. */
export function buildEntry(rel, text) {
  const cluster = rel.split("/")[0];
  const name = rel.split("/").pop();
  const { fm, body } = parseFrontmatter(text);
  return {
    file: rel,
    cluster: String(fm.cluster || cluster),
    slug: name.replace(/\.md$/, ""),
    title: String(fm.title || name.replace(/\.md$/, "")),
    docType: fm.doc_type ? String(fm.doc_type) : undefined,
    authors: fm.authors ? String(fm.authors) : undefined,
    year: fm.year,
    topics: asArray(fm.topics),
    keyConstructs: asArray(fm.key_constructs),
    summary: fm.summary ? String(fm.summary) : undefined,
    sections: extractSections(body),
  };
}

// Read a bundled reference file (resolved relative to the manifest directory).
async function readRef(context, rel) {
  return await Deno.readTextFile(context.extensionFile(`${REF_DIR}/${rel}`));
}

// The list of bundled source paths, optionally filtered to the clusters.
async function sourceList(context) {
  const index = JSON.parse(await readRef(context, "index.json"));
  const clusters = context.globalArgs.clusters;
  return clusters && clusters.length
    ? index.filter((rel) => clusters.includes(rel.split("/")[0]))
    : index;
}

// Resolve one source's raw markdown text from the bundled reference files.
function loadRaw(context, rel) {
  return readRef(context, rel);
}

// Load all sources as structured entries from the bundled reference files.
async function loadSources(context) {
  const list = await sourceList(context);
  const out: ReturnType<typeof buildEntry>[] = [];
  for (const rel of list) {
    out.push(buildEntry(rel, await readRef(context, rel)));
  }
  return out;
}

/** Split a query into de-duplicated lowercase terms ≥3 chars, dropping stopwords. */
export function tokenize(q) {
  return [
    ...new Set(
      String(q).toLowerCase().split(/[^a-z0-9]+/).filter(
        (t) => t.length >= 3 && !STOPWORDS.has(t),
      ),
    ),
  ];
}

// ---------- Model ------------------------------------------------------------

/**
 * `@magistr/career-kb` — a retrieval, routing, and triage model over a
 * career-research knowledge base. Scans the configured cluster folders into a
 * queryable catalog (`index`), routes a question to the most relevant sources
 * (`search`), returns a source or one section (`read`), and triages a described
 * situation into its problem family with the validated instrument and coping
 * guidance (`assess`). The corpus is bundled — no configuration required.
 */
export const model = {
  type: "@magistr/career-kb",
  version: "2026.07.16.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    catalog: {
      description:
        "Queryable catalog of every career-research source: cluster, title, topics, key constructs, summary, and section list, built from frontmatter.",
      schema: CatalogSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    searchResult: {
      description:
        "Ranked sources matching a question or keyword query, with matched terms and a why-string.",
      schema: SearchResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    document: {
      description:
        "A single source's frontmatter plus its full body or one requested section.",
      schema: DocumentSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    assessment: {
      description:
        "Triage of a described career situation: which problem family/families it fits, the validated instrument for each, sources to read, and coping guidance.",
      schema: AssessmentSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    index: {
      description:
        "Build the catalog of all bundled sources (idempotent — overwrites the latest catalog).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const sources = await loadSources(context);
        const clusterCounts = {};
        const topicSet = new Set();
        const constructSet = new Set();
        for (const s of sources) {
          clusterCounts[s.cluster] = (clusterCounts[s.cluster] || 0) + 1;
          s.topics.forEach((t) => topicSet.add(t));
          s.keyConstructs.forEach((c) => constructSet.add(c));
        }
        const handle = await context.writeResource("catalog", "main", {
          sourceCount: sources.length,
          clusters: Object.entries(clusterCounts).map(([name, count]) => ({
            name,
            count,
          })),
          allTopics: [...topicSet].sort(),
          allKeyConstructs: [...constructSet].sort(),
          sources,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    search: {
      description:
        "Route a question or keyword query to the most relevant sources, ranked. Optionally filter by cluster.",
      arguments: z.object({
        query: z.string().describe("A question or keywords to route"),
        cluster: z.string().optional().describe(
          "Restrict to one cluster: ama | inaction | success-outcomes",
        ),
        topK: z.number().optional().describe(
          "How many hits to return (default 6)",
        ),
      }),
      execute: async (args, context) => {
        const topK = args.topK ?? 6;
        const sources = await loadSources(context);
        const pool = args.cluster
          ? sources.filter((s) => s.cluster === args.cluster)
          : sources;
        const tokens = tokenize(args.query);
        const phrase = String(args.query).toLowerCase().trim();

        const hits = pool.map((s) => {
          const fields = {
            title: s.title.toLowerCase(),
            constructs: s.keyConstructs.join(" ").toLowerCase(),
            topics: s.topics.join(" ").toLowerCase(),
            summary: (s.summary || "").toLowerCase(),
            authors: (s.authors || "").toLowerCase(),
          };
          const weights = {
            title: 3,
            constructs: 3,
            topics: 2,
            summary: 1,
            authors: 1,
          };
          let score = 0;
          const matched = new Set();
          const whyFields = new Set();
          for (const t of tokens) {
            for (const [f, text] of Object.entries(fields)) {
              if (text.includes(t)) {
                score += weights[f];
                matched.add(t);
                whyFields.add(f);
              }
            }
          }
          // Whole-phrase bonus.
          if (
            phrase.length >= 5 &&
            (fields.title.includes(phrase) || fields.topics.includes(phrase) ||
              fields.summary.includes(phrase))
          ) {
            score += 5;
            whyFields.add("phrase");
          }
          return {
            file: s.file,
            cluster: s.cluster,
            slug: s.slug,
            title: s.title,
            score,
            matchedTerms: [...matched],
            why: whyFields.size
              ? `matched in ${[...whyFields].join(", ")}`
              : "no direct term match",
            summary: s.summary,
          };
        }).filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score);

        const ranked = hits.slice(0, topK);

        const handle = await context.writeResource(
          "searchResult",
          slugify(args.query),
          {
            query: args.query,
            clusterFilter: args.cluster,
            topK,
            totalMatches: hits.length,
            hitCount: ranked.length,
            truncated: hits.length > ranked.length,
            hits: ranked,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    read: {
      description:
        "Read one source: its frontmatter plus the full body, or just a named section (e.g. Measurement, Frameworks).",
      arguments: z.object({
        file: z.string().describe(
          "Relative path (inaction/career-inaction.md), filename, or slug",
        ),
        section: z.string().optional().describe(
          "Optional section name to extract (case-insensitive, partial match)",
        ),
      }),
      execute: async (args, context) => {
        let rel = args.file;
        if (!rel.includes("/")) {
          // Resolve a bare filename/slug against the bundled references.
          const want = rel.replace(/\.md$/, "");
          const found = (await loadSources(context)).find((s) =>
            s.slug === want
          );
          if (!found) {
            throw new Error(
              `Source not found: "${args.file}". Run search or index to see available slugs.`,
            );
          }
          rel = found.file;
        }
        const text = await loadRaw(context, rel);
        const { fm, body } = parseFrontmatter(text);
        const availableSections = extractSections(body);
        let content = body.trim();
        if (args.section) {
          const sec = getSection(body, args.section);
          if (!sec) {
            throw new Error(
              `Section "${args.section}" not found in ${rel}. Available: ${
                availableSections.join(", ")
              }`,
            );
          }
          content = sec;
        }
        const handle = await context.writeResource("document", slugify(rel), {
          file: rel,
          cluster: rel.split("/")[0],
          slug: rel.split("/").pop().replace(/\.md$/, ""),
          title: String(fm.title || rel),
          frontmatter: fm,
          section: args.section,
          availableSections,
          content,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    assess: {
      description:
        "Triage a described career situation: classify it across the KB's problem families (inaction / indecision / indecisiveness / success-derailer / shock-transition), name the validated instrument for each, point to sources, and give coping guidance. Optionally score self-rated CARINAS items.",
      arguments: z.object({
        situation: z.string().describe(
          "Free-text description of the career situation to triage",
        ),
        carinas: z.array(z.number()).optional().describe(
          "Optional self-ratings for the 8 CARINAS items, each 1–5 (see inaction/career-inaction-scale.md for the items)",
        ),
      }),
      execute: async (args, context) => {
        const text = String(args.situation).toLowerCase();

        // Classify into families by signal hits.
        const scored: Array<{ family: string; hits: string[] }> = [];
        for (const [family, sigs] of Object.entries(SIGNALS)) {
          const hits = sigs.filter((sig) => text.includes(sig));
          if (hits.length > 0) scored.push({ family, hits });
        }
        const totalHits = scored.reduce((n, s) => n + s.hits.length, 0) || 1;
        scored.sort((a, b) => b.hits.length - a.hits.length);

        const families = scored.map((s) => {
          const info = FAMILY_INFO[s.family];
          return {
            family: s.family,
            confidence: Number((s.hits.length / totalHits).toFixed(2)),
            signals: s.hits,
            instrument: info.instrument,
            readSources: info.readSources,
            guidance: info.guidance,
          };
        });

        const primaryFamily = families.length ? families[0].family : "unclear";

        // Optional CARINAS scoring against published benchmarks.
        let carinas;
        if (args.carinas && args.carinas.length > 0) {
          const vals = args.carinas.filter((n) => n >= 1 && n <= 5);
          const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
          let band;
          if (mean < 2.5) band = "low";
          else if (mean < 3.0) {
            band = "moderate (~general-population mean 2.74)";
          } else if (mean < 3.5) {
            band = "elevated (~counseling-client mean 3.21)";
          } else band = "high";
          carinas = {
            mean: Number(mean.toFixed(2)),
            band,
            interpretation:
              `Mean ${mean.toFixed(2)} on the 1–5 CARINAS (midpoint 3). ` +
              `Reference points: general-worker samples average ≈2.7–2.8, career-counseling clients ≈3.21. ` +
              `Higher = a stronger, self-aware desire for change paired with insufficient action.` +
              (vals.length !== args.carinas.length
                ? ` (${
                  args.carinas.length - vals.length
                } value(s) out of the 1–5 range were ignored.)`
                : ""),
          };
        }

        const handle = await context.writeResource(
          "assessment",
          slugify(args.situation),
          {
            situation: args.situation,
            primaryFamily,
            families,
            carinas,
            copingGuidance: {
              increase: SCCI.productive,
              reduce: SCCI.nonproductive,
              note:
                "Cutting nonproductive coping matters ~2× more than adding productive coping (d≈0.62 vs 0.25, Lipshits-Braziler et al.). Start by reducing escape / helplessness / isolation / submission / opposition. Support-seeking is mixed — instrumental help-seeking is productive, delegation is not.",
            },
            caution:
              "Keyword-based triage over the KB — not a clinical diagnosis or a scored psychometric. The CARINAS / SCCI / EPCD item wording lives in the cited source files; self-administer there before drawing conclusions. Verify any figure against the source PDF before citing.",
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
