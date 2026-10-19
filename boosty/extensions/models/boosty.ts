import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// @magistr/boosty
//
// Archive a Boosty blog (boosty.to/<blog>) to a directory of Markdown notes
// with images downloaded next to them — shaped for an Obsidian vault.
//
// Boosty's web UI is hydrated from a JSON API:
//   - GET https://api.boosty.to/v1/blog/<blog>/post/?limit=<n>&offset=<cursor>
//       -> { data: Post[], extra: { isLast, offset } }
// A post's body is `data[]`, a flat list of blocks:
//   - { type: "text", content: '["text","<style>",[ranges]]', modificator }
//     where modificator "BLOCK_END" closes the current paragraph
//   - { type: "link", url, content: '["text",...]' }
//   - { type: "image", id, url, width, height }
//   - { type: "ok_video" | "video", ... }, { type: "audio_file" | "file", ... }
// Paid posts return `hasAccess: false` and an empty `data[]` (only `teaser[]`)
// unless the request carries the subscriber's access token.
//
// `archive` is a fan-out method: one run pages the whole blog, writes every
// note and image, and records one `archive` summary resource.
// ---------------------------------------------------------------------------

const DEFAULT_API = "https://api.boosty.to";
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30000;
const PAGE_LIMIT = 20;
const MAX_PAGES = 1000;

const GlobalArgsSchema = z.object({
  accessToken: z
    .string()
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Boosty access token (the `accessToken` field of the `auth` cookie on " +
        "boosty.to). Optional — without it paid posts are archived as " +
        "teaser-only. Reference it from a vault.",
    ),
  userAgent: z.string().optional().describe("Override the HTTP User-Agent."),
  timeoutMs: z
    .number()
    .optional()
    .describe("Per-request timeout in milliseconds (default 30000)."),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- input validation / SSRF guard ------------------------------------------

/** Validate a Boosty blog slug: letters, digits, underscore, hyphen, dot. */
export function sanitizeBlog(blog: string): string {
  const trimmed = (blog ?? "").trim().replace(/^https?:\/\/boosty\.to\//, "")
    .replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(
      `Invalid Boosty blog "${blog}" — expected a slug like 'rottenkepken'.`,
    );
  }
  return trimmed;
}

/** True for boosty.to and *.boosty.to over https. */
export function hostAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" &&
      (h === "boosty.to" || h.endsWith(".boosty.to"));
  } catch {
    return false;
  }
}

// --- HTTP -------------------------------------------------------------------

function headers(g: GlobalArgs): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": g.userAgent || DEFAULT_UA,
    "Accept": "application/json",
  };
  const token = normalizeToken(g.accessToken);
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

/**
 * Accept the bare access token, the raw `auth` cookie value (JSON, possibly
 * URL-encoded), or a "Bearer ..." string, and return the bare token.
 */
export function normalizeToken(raw: string | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep as-is
    }
  }
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s);
      if (typeof obj?.accessToken === "string") s = obj.accessToken;
    } catch {
      // keep as-is
    }
  }
  return s.replace(/^Bearer\s+/i, "").trim();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  g: GlobalArgs,
): Promise<Response> {
  if (!hostAllowed(url)) {
    throw new Error(`Refusing to fetch non-boosty host: ${url}`);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), g.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      last = await fetch(url, { ...init, signal: ctrl.signal });
      if (last.status !== 429 && last.status < 500) return last;
      await last.body?.cancel();
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    return last!;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url: string, g: GlobalArgs): Promise<unknown> {
  const res = await fetchWithTimeout(url, { headers: headers(g) }, g);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// --- block rendering ----------------------------------------------------------

/** One Boosty content block, as served by the post API. */
export interface Block {
  type: string;
  content?: string;
  modificator?: string;
  url?: string;
  id?: string;
  title?: string;
  preview?: string;
  previewId?: string;
  explicit?: boolean;
}

/** Parse a text/link block's `content` ('["text","style",[ranges]]'). */
export function parseContent(
  content: string | undefined,
): { text: string; style: string } {
  if (!content) return { text: "", style: "unstyled" };
  try {
    const arr = JSON.parse(content);
    if (Array.isArray(arr)) {
      return {
        text: String(arr[0] ?? ""),
        style: String(arr[1] ?? "unstyled"),
      };
    }
  } catch {
    // fall through — treat raw content as plain text
  }
  return { text: content, style: "unstyled" };
}

function prefixFor(style: string): string {
  switch (style) {
    case "header-one":
      return "# ";
    case "header-two":
      return "## ";
    case "header-three":
      return "### ";
    case "blockquote":
      return "> ";
    case "unordered-list-item":
      return "- ";
    case "ordered-list-item":
      return "1. ";
    default:
      return "";
  }
}

/** A resolver mapping an image block to the Markdown link target to embed. */
export type ImageResolver = (block: Block, index: number) => string | null;

/**
 * Render a post's blocks to Markdown. Consecutive text/link fragments join into
 * one paragraph until a BLOCK_END marker; media blocks stand alone.
 */
export function renderBlocks(
  blocks: Block[],
  resolveImage: ImageResolver,
  postUrl: string,
): string {
  const out: string[] = [];
  let para = "";
  let style = "unstyled";
  let imageIndex = 0;
  const flush = () => {
    if (para.trim()) out.push(prefixFor(style) + para.trim());
    para = "";
    style = "unstyled";
  };
  for (const b of blocks) {
    switch (b.type) {
      case "text": {
        const c = parseContent(b.content);
        if (c.text) {
          if (!para) style = c.style;
          para += c.text;
        }
        if (b.modificator === "BLOCK_END") flush();
        break;
      }
      case "link": {
        const c = parseContent(b.content);
        const label = c.text || b.url || "";
        para += b.url ? `[${label}](${b.url})` : label;
        break;
      }
      case "image": {
        flush();
        const target = resolveImage(b, imageIndex++);
        if (target) out.push(`![](${target})`);
        break;
      }
      case "ok_video":
      case "video": {
        flush();
        const label = b.title ? `Видео: ${b.title}` : "Видео";
        const href = b.url && /^https?:/.test(b.url) ? b.url : postUrl;
        out.push(`> [!video] [${label}](${href})`);
        break;
      }
      case "audio_file":
      case "file": {
        flush();
        out.push(`> [!file] [${b.title || b.type}](${b.url || postUrl})`);
        break;
      }
      default:
        if (b.url) {
          flush();
          out.push(`[${b.type}](${b.url})`);
        }
    }
  }
  flush();
  return out.join("\n\n");
}

/** Filesystem-safe note title (keeps Cyrillic; strips path/Obsidian chars). */
export function safeName(title: string): string {
  const s = (title || "untitled")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, "");
  return s || "untitled";
}

function yamlStr(s: string): string {
  return JSON.stringify(s);
}

function extFromType(ct: string | null): string {
  const t = (ct || "").split(";")[0].trim().toLowerCase();
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
  } as Record<string, string>)[t] || "jpg";
}

// --- post shape -------------------------------------------------------------

interface Post {
  id: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  hasAccess?: boolean;
  data?: Block[];
  teaser?: Block[];
  tags?: { title: string }[];
  price?: number;
}

async function* iteratePosts(
  blog: string,
  g: GlobalArgs,
): AsyncGenerator<Post> {
  let offset: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${DEFAULT_API}/v1/blog/${encodeURIComponent(blog)}/post/` +
      `?limit=${PAGE_LIMIT}${
        offset ? `&offset=${encodeURIComponent(offset)}` : ""
      }`;
    // deno-lint-ignore no-explicit-any
    const payload = await fetchJson(url, g) as any;
    const posts: Post[] = Array.isArray(payload?.data) ? payload.data : [];
    for (const p of posts) yield p;
    if (payload?.extra?.isLast) return;
    const next = payload?.extra?.offset;
    if (!next || next === offset) return;
    offset = String(next);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findExisting(
  dir: string,
  prefix: string,
): Promise<string | null> {
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.startsWith(prefix)) return e.name;
    }
  } catch {
    // dir missing
  }
  return null;
}

const PostSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  file: z.string(),
  hasAccess: z.boolean(),
  images: z.number(),
  imagesFailed: z.number(),
});

const ArchiveSchema = z.object({
  blog: z.string(),
  outputDir: z.string(),
  total: z.number(),
  withAccess: z.number(),
  locked: z.number(),
  notesWritten: z.number(),
  notesUnchanged: z.number(),
  imagesDownloaded: z.number(),
  imagesSkipped: z.number(),
  imagesFailed: z.number(),
  posts: z.array(PostSummarySchema),
  timestamp: z.string(),
});

// deno-lint-ignore no-explicit-any
type Ctx = any;

/** Boosty blog archiver model — pages a blog and writes Markdown + images. */
export const model = {
  type: "@magistr/boosty",
  version: "2026.10.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    whoami: {
      description: "Result of an accessToken check",
      schema: z.object({}).passthrough(),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    archive: {
      description: "Summary of one blog archive run (per post: file, access)",
      schema: ArchiveSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    whoami: {
      description:
        "Check the configured accessToken: report the HTTP status of the " +
        "current-user endpoint, the account name, and whether a sample post " +
        "of `blog` is readable. Writes nothing to disk.",
      arguments: z.object({
        blog: z.string().describe("Blog slug to probe access on."),
      }),
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const args = z.object({ blog: z.string() }).parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs ?? {});
        const blog = sanitizeBlog(args.blog);
        const token = normalizeToken(g.accessToken);
        const res = await fetchWithTimeout(
          `${DEFAULT_API}/v1/user/current`,
          { headers: headers(g) },
          g,
        );
        const text = await res.text();
        // deno-lint-ignore no-explicit-any
        let user: any = null;
        try {
          user = JSON.parse(text);
        } catch {
          // non-JSON
        }
        const page = await fetchJson(
          `${DEFAULT_API}/v1/blog/${blog}/post/?limit=5`,
          g,
        ) as { data?: Post[] };
        const sample = (page?.data ?? []).map((p: Post) => ({
          title: p.title ?? "",
          hasAccess: p.hasAccess === true,
        }));
        const result = {
          tokenPresent: token.length > 0,
          tokenLength: token.length,
          rawLooksLikeCookie: (g.accessToken ?? "").trim() !== token,
          userStatus: res.status,
          userName: String(user?.name ?? ""),
          userId: String(user?.id ?? ""),
          userError: res.ok ? "" : text.slice(0, 200),
          sample,
        };
        context.logger?.info?.(JSON.stringify(result));
        const handle = await context.writeResource("whoami", blog, result);
        return { dataHandles: [handle] };
      },
    },
    archive: {
      description:
        "Archive every post of a Boosty blog to `outputDir` as one Markdown " +
        "note per post (YAML frontmatter: title, date, url, tags, access) " +
        "with images downloaded to `outputDir/attachments/`. Idempotent: " +
        "existing images are not re-downloaded and unchanged notes are not " +
        "rewritten. Paid posts without an accessToken get teaser-only notes.",
      arguments: z.object({
        blog: z.string().describe("Blog slug or URL, e.g. 'rottenkepken'."),
        outputDir: z
          .string()
          .describe("Absolute directory to write notes into."),
        downloadImages: z
          .boolean()
          .default(true)
          .describe("Download images locally (default true)."),
      }),
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const args = z.object({
          blog: z.string(),
          outputDir: z.string(),
          downloadImages: z.boolean().default(true),
        }).parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs ?? {});
        const blog = sanitizeBlog(args.blog);
        if (!args.outputDir.startsWith("/")) {
          throw new Error(`outputDir must be absolute: ${args.outputDir}`);
        }
        const outDir = args.outputDir.replace(/\/+$/, "");
        const attDir = `${outDir}/attachments`;
        await Deno.mkdir(attDir, { recursive: true });

        const summary = {
          total: 0,
          withAccess: 0,
          locked: 0,
          notesWritten: 0,
          notesUnchanged: 0,
          imagesDownloaded: 0,
          imagesSkipped: 0,
          imagesFailed: 0,
        };
        const posts: z.infer<typeof PostSummarySchema>[] = [];
        const usedNames = new Set<string>();

        for await (const p of iteratePosts(blog, g)) {
          summary.total++;
          const id = String(p.id);
          const shortId = id.slice(0, 8);
          const created = new Date((p.createdAt ?? 0) * 1000);
          const date = created.toISOString().slice(0, 10);
          const title = (p.title || "").trim() || "Без названия";
          const postUrl = `https://boosty.to/${blog}/posts/${id}`;
          const hasAccess = p.hasAccess === true && (p.data?.length ?? 0) > 0;
          if (hasAccess) summary.withAccess++;
          else summary.locked++;
          const blocks = hasAccess ? p.data! : (p.teaser ?? []);

          // Download images first so the renderer can embed local paths.
          const imageTargets = new Map<number, string>();
          let imgIdx = 0;
          let postImages = 0;
          let postFailed = 0;
          for (const b of blocks) {
            if (b.type !== "image") continue;
            const i = imgIdx++;
            if (!b.url || !hostAllowed(b.url)) continue;
            if (!args.downloadImages) {
              imageTargets.set(i, b.url);
              continue;
            }
            const imgKey = /^[A-Za-z0-9-]+$/.test(b.id ?? "")
              ? b.id!.slice(0, 13)
              : String(i + 1).padStart(2, "0");
            const stem = `${blog}-${shortId}-${imgKey}`;
            const have = await findExisting(attDir, `${stem}.`);
            if (have) {
              imageTargets.set(i, `attachments/${have}`);
              summary.imagesSkipped++;
              postImages++;
              continue;
            }
            try {
              const res = await fetchWithTimeout(b.url, {
                headers: { "User-Agent": g.userAgent || DEFAULT_UA },
              }, g);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const bytes = new Uint8Array(await res.arrayBuffer());
              const file = `${stem}.${
                extFromType(res.headers.get("content-type"))
              }`;
              await Deno.writeFile(`${attDir}/${file}`, bytes);
              imageTargets.set(i, `attachments/${file}`);
              summary.imagesDownloaded++;
              postImages++;
            } catch (e) {
              context.logger?.warn?.(`image failed ${b.url}: ${e}`);
              imageTargets.set(i, b.url);
              summary.imagesFailed++;
              postFailed++;
            }
          }

          const body = renderBlocks(
            blocks,
            (_b, i) => imageTargets.get(i) ?? null,
            postUrl,
          );
          const tags = (p.tags ?? []).map((t) => t.title).filter(Boolean);
          const fm = [
            "---",
            `title: ${yamlStr(title)}`,
            `date: ${created.toISOString()}`,
            `source: ${yamlStr(postUrl)}`,
            `author: ${yamlStr(blog)}`,
            `boosty_id: ${yamlStr(id)}`,
            `access: ${hasAccess ? "full" : "locked"}`,
            "tags:",
            "  - boosty",
            ...tags.map((t) => `  - ${yamlStr(t.replace(/\s+/g, "-"))}`),
            "---",
            "",
            `# ${title}`,
            "",
            hasAccess
              ? ""
              : `> [!warning] Платный пост — сохранён только тизер. [Открыть на Boosty](${postUrl})\n`,
            body,
            "",
          ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");

          let name = `${date} ${safeName(title)}`;
          if (usedNames.has(name)) name = `${name} ${shortId}`;
          usedNames.add(name);
          const path = `${outDir}/${name}.md`;
          let old: string | null = null;
          if (await exists(path)) old = await Deno.readTextFile(path);
          if (old === fm) summary.notesUnchanged++;
          else {
            await Deno.writeTextFile(path, fm);
            summary.notesWritten++;
          }
          posts.push({
            id,
            title,
            date,
            file: `${name}.md`,
            hasAccess,
            images: postImages,
            imagesFailed: postFailed,
          });
        }

        context.logger?.info?.(
          `boosty ${blog}: ${summary.total} posts (${summary.withAccess} full, ` +
            `${summary.locked} locked), ${summary.imagesDownloaded} images new`,
        );
        const handle = await context.writeResource("archive", blog, {
          blog,
          outputDir: outDir,
          ...summary,
          posts,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
