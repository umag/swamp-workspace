/**
 * Development-time generator for the bundled V.E.C.S. reference data.
 *
 * The school publishes its curriculum as static HTML. This script fetches it
 * once and writes `references/vecs.json`, which the model then ships and reads
 * offline — the model itself never touches the network.
 *
 * Regenerate when the school changes its curriculum:
 *
 *     deno run --allow-net --allow-write scripts/build_reference.ts
 *
 * This file is NOT part of the published extension; it lives outside
 * `extensions/models/` and is excluded from the manifest on purpose.
 *
 * @module
 */

/** Root of the site the reference data is generated from. */
export const DEFAULT_BASE_URL = "https://school.mishkatz.com";

/** The four V.E.C.S. dimensions, in canonical order, keyed by page slug. */
export const DIMENSIONS = [
  { key: "vision", letter: "V", page: "vision.html", title: "Vision" },
  { key: "execution", letter: "E", page: "execution.html", title: "Execution" },
  {
    key: "communication",
    letter: "C",
    page: "communication.html",
    title: "Communication",
  },
  { key: "strategy", letter: "S", page: "strategy.html", title: "Strategy" },
];

/**
 * Canonical ASCII slugs for the published skills, keyed by their Russian title.
 * Keeps `assess` input typeable even though the source titles are Cyrillic.
 * Titles not listed here fall back to transliteration.
 */
export const SKILL_SLUGS: Record<string, string> = {
  "Визуальная грамотность": "visual-literacy",
  "Концептуальное мышление": "conceptual-thinking",
  "Авторское видение": "authorial-vision",
  "Формообразование": "form-making",
  "3D и procedural workflow": "procedural-workflow",
  "Свет, материалы, рендер": "light-materials-render",
  "Motion": "motion",
  "Генератив, код, AI": "generative-code-ai",
  "Доведение": "finishing",
  "Вербализация идеи": "idea-verbalization",
  "Презентация и упаковка": "presentation-packaging",
  "Публичность и контент": "publicity-content",
  "Критика и обратная связь": "critique-feedback",
  "Командное взаимодействие": "team-collaboration",
  "Проектное мышление": "project-thinking",
  "Развитие практики": "practice-development",
  "Навигация в профессии": "profession-navigation",
  "Работа с вниманием и ресурсом": "attention-resource",
  "Стратегия видимости": "visibility-strategy",
};

const CYRILLIC_TRANSLIT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&laquo;": "«",
  "&raquo;": "»",
};

/** A single scoreable skill parsed out of a dimension page. */
export interface Skill {
  slug: string;
  title: string;
  dimension: string;
  dimensionLetter: string;
  position: number;
  knowledge: string[];
  abilities: string[];
  href: string;
}

/** A course offered by the school, as listed on the index page. */
export interface Course {
  title: string;
  href: string;
  price?: string;
  priceStruck: boolean;
  summary?: string;
}

/** Decode the HTML entities the site emits, plus numeric escapes. */
export function decodeEntities(input: string): string {
  return input
    .replace(
      /&#x([0-9a-fA-F]+);/g,
      (_m, hex) => String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|laquo|raquo);/g,
      (m) => ENTITIES[m] ?? m,
    );
}

/** Strip tags from an HTML fragment and decode entities, preserving newlines. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

/** Transliterate a Cyrillic title into an ASCII slug. */
export function transliterate(input: string): string {
  let out = "";
  for (const ch of input.toLowerCase()) {
    out += CYRILLIC_TRANSLIT[ch] ?? ch;
  }
  return out;
}

/** Canonical, URL-safe slug for a title — mapped where known, translit else. */
export function slugify(title: string): string {
  const trimmed = title.trim();
  const mapped = SKILL_SLUGS[trimmed];
  if (mapped) return mapped;
  const slug = transliterate(trimmed)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/**
 * Rejoin the hard line wraps the site applies inside `<pre>` blocks so a bullet
 * wrapped over three display lines comes back as one logical bullet.
 */
export function unwrapBullets(text: string): string[] {
  const bullets: string[] = [];
  let current: string | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const started = line.match(/^\s*[-•]\s+(.*)$/);
    if (started) {
      if (current !== null) bullets.push(current.trim());
      current = started[1];
    } else if (current !== null && /^\s{2,}\S/.test(line)) {
      current += " " + line.trim();
    } else {
      if (current !== null) bullets.push(current.trim());
      current = null;
    }
  }
  if (current !== null) bullets.push(current.trim());
  return bullets.filter((b) => b.length > 0);
}

/** Bullets that follow a `<Heading>:` label, up to the next label. */
export function bulletsUnderHeading(
  section: string,
  heading: string,
): string[] {
  const re = new RegExp(`^${heading}:\\s*$`, "m");
  const match = section.match(re);
  if (!match || match.index === undefined) return [];
  const after = section.slice(match.index + match[0].length);
  const nextLabel = after.search(/^[^\n-]{2,40}:\s*$/m);
  const scope = nextLabel >= 0 ? after.slice(0, nextLabel) : after;
  return unwrapBullets(scope);
}

/** Title from a `╔══╗ ║ Title ║ ╚══╝` ASCII box, if the page has one. */
export function boxedTitle(text: string): string | null {
  const match = text.match(/^║\s*(.+?)\s*║\s*$/m);
  return match ? match[1].trim() : null;
}

/** The readable body of a page, whichever of the two shapes it uses. */
export function pageBody(html: string): string {
  const prose = html.match(/<div class="prose">([\s\S]*?)<\/div>/);
  if (prose) return stripTags(prose[1]).trim();
  const pre = html.match(/<pre>([\s\S]*?)<\/pre>/);
  if (!pre) return "";
  return stripTags(pre[1])
    .split("\n")
    .filter((l) => !/^[╔╗╚╝║═]/.test(l.trim()) && l.trim() !== "")
    .join("\n")
    .trim();
}

/**
 * Parse a dimension page into its intro prose and its numbered skills, each
 * with Знания / Умения bullet lists.
 *
 * The dimension pages are the parse target rather than the per-skill pages:
 * they carry the canonical numbered order and their bullets are not
 * hard-wrapped.
 */
export function parseDimensionPage(
  html: string,
  dimension: { key: string; letter: string; title: string },
): { intro: string; skills: Skill[] } {
  const prose = html.match(/<div class="prose">([\s\S]*?)<\/div>/);
  if (!prose) return { intro: "", skills: [] };
  const text = stripTags(prose[1]);

  const entryIdx = text.search(/^Что сюда входит:\s*$/m);
  const intro = (entryIdx >= 0 ? text.slice(0, entryIdx) : text).trim();
  const body = entryIdx >= 0 ? text.slice(entryIdx) : "";

  const headings = [...body.matchAll(/^(\d+)\.\s+(.+?)\s*$/gm)];
  const skills: Skill[] = [];

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const start = heading.index! + heading[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index! : body.length;
    const section = body.slice(start, end);
    const title = heading[2].trim();

    skills.push({
      slug: slugify(title),
      title,
      dimension: dimension.key,
      dimensionLetter: dimension.letter,
      position: Number(heading[1]),
      knowledge: bulletsUnderHeading(section, "Знания"),
      abilities: bulletsUnderHeading(section, "Умения"),
      href: `${title}.html`,
    });
  }

  return { intro, skills };
}

/** Parse the course list (title, href, price) out of the index page. */
export function parseCourses(html: string): Course[] {
  const courses: Course[] = [];
  const anchors = [
    ...html.matchAll(/<a\s+href="([^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g),
  ];
  for (const a of anchors) {
    const inner = a[2];
    const priceMatch = inner.match(/(<s>)?\s*(\$[\d.,]+)\s*(<\/s>)?/);
    if (!priceMatch) continue;
    courses.push({
      title: stripTags(inner).replace(/\s*\(\s*\$[\d.,]+\s*\)\s*$/, "").trim(),
      href: a[1],
      price: priceMatch[2],
      priceStruck: Boolean(priceMatch[1]),
    });
  }
  return courses;
}

async function get(base: string, href: string): Promise<string> {
  const url = `${base.replace(/\/+$/, "")}/${encodeURI(href)}`;
  const res = await fetch(url, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return await res.text();
}

/** Fetch the live site and assemble the reference payload. */
export async function build(base = DEFAULT_BASE_URL): Promise<
  Record<string, unknown>
> {
  const index = await get(base, "");
  const courses = parseCourses(index);

  const dimensions: Array<{
    key: string;
    letter: string;
    title: string;
    href: string;
    intro: string;
    skillCount: number;
    skillSlugs: string[];
  }> = [];
  const skills: Skill[] = [];
  for (const d of DIMENSIONS) {
    const { intro, skills: parsed } = parseDimensionPage(
      await get(base, d.page),
      d,
    );
    if (parsed.length === 0) {
      throw new Error(`Parsed 0 skills from ${d.page} — the markup changed.`);
    }
    skills.push(...parsed);
    dimensions.push({
      key: d.key,
      letter: d.letter,
      title: d.title,
      href: d.page,
      intro,
      skillCount: parsed.length,
      skillSlugs: parsed.map((s) => s.slug),
    });
  }

  // Each course page carries a short summary of its own.
  for (const course of courses) {
    course.summary = pageBody(await get(base, course.href)) || undefined;
  }

  const slugs = new Set(skills.map((s) => s.slug));
  if (slugs.size !== skills.length) {
    throw new Error("Duplicate skill slugs — the SKILL_SLUGS map needs a fix.");
  }

  return {
    source: base,
    capturedAt: new Date().toISOString(),
    dimensions,
    skills,
    courses,
  };
}

if (import.meta.main) {
  const out = new URL("../references/vecs.json", import.meta.url).pathname;
  const data = await build();
  await Deno.mkdir(new URL("../references/", import.meta.url).pathname, {
    recursive: true,
  });
  await Deno.writeTextFile(out, JSON.stringify(data, null, 2) + "\n");
  const skills = data.skills as Skill[];
  console.log(
    `wrote ${out}\n  ${(data.dimensions as unknown[]).length} dimensions, ` +
      `${skills.length} skills, ${(data.courses as unknown[]).length} courses`,
  );
}
