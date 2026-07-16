import { z } from "npm:zod@4";
import * as cheerio from "npm:cheerio@1.0.0";
import type { AnyNode, Element, Text } from "npm:domhandler@5.0.3";

const GlobalArgsSchema = z.object({
  journalUrl: z
    .string()
    .describe("LiveJournal URL (e.g. https://username.livejournal.com/)"),
  vault: z.string().describe("Obsidian vault name"),
  folder: z.string().default("LiveJournal").describe(
    "Target folder in Obsidian vault",
  ),
  attachmentsFolder: z
    .string()
    .default("attachments")
    .describe("Attachments folder name inside the target folder"),
});

const ImportResultSchema = z.object({
  journal: z.string(),
  totalPosts: z.number(),
  notesCreated: z.number(),
  imagesCopied: z.number(),
  errors: z.array(z.string()),
  timestamp: z.iso.datetime(),
});

const PostSchema = z.object({
  id: z.number(),
  title: z.string(),
  date: z.string(),
  url: z.string(),
  text: z.string(),
  tags: z.array(z.string()),
  mood: z.string().optional(),
  nowPlaying: z.string().optional(),
  imageCount: z.number(),
  timestamp: z.iso.datetime(),
});

// Run obsidian CLI
async function runObsidian(
  command: string,
  params: Record<string, string | undefined>,
  vault: string,
  bareFlags: string[] | undefined = undefined,
) {
  const args = [command];
  args.push(`vault=${vault}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      args.push(`${key}=${value}`);
    }
  }
  if (bareFlags) {
    for (const flag of bareFlags) {
      args.push(flag);
    }
  }

  const proc = new Deno.Command("obsidian", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const output = await proc.output();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  const stdout = new TextDecoder().decode(output.stdout).trim();

  if (!output.success) {
    throw new Error(
      `obsidian ${command} failed (exit ${output.code}): ${stderr || stdout}`,
    );
  }
  return stdout;
}

// Get vault filesystem path
async function getVaultPath(vault: string): Promise<string> {
  const proc = new Deno.Command("obsidian", {
    args: ["vault", `vault=${vault}`, "info=path"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  if (!output.success || !stdout) {
    throw new Error(`Cannot resolve vault path for "${vault}"`);
  }
  return stdout;
}

// Fetch a URL with retries
async function fetchWithRetry(
  url: string,
  retries = 3,
): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      if (i === retries - 1) throw e;
      // Wait a bit between retries
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

// Convert LJ HTML content to markdown
function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);

  // Remove script/style
  $("script, style").remove();

  function walk(el: AnyNode): string {
    if (el.type === "text") {
      return (el as Text).data || "";
    }
    if (el.type !== "tag") return "";

    const tag = el as Element;
    const name = tag.tagName?.toLowerCase() || "";
    const children = (tag.children || []).map(walk).join("");

    switch (name) {
      case "br":
        return "\n";
      case "p":
        return `\n\n${children}\n\n`;
      case "div":
        return `\n${children}\n`;
      case "b":
      case "strong":
        return `**${children}**`;
      case "i":
      case "em":
        return `*${children}*`;
      case "a": {
        const href = $(tag).attr("href") || "";
        if (href && children.trim()) {
          // Skip LJ user links markup
          if (href.includes("livejournal.com/profile")) return children;
          return `[${children.trim()}](${href})`;
        }
        return children;
      }
      case "img": {
        // Return a placeholder - images handled separately
        return `{{IMG:${$(tag).attr("src") || ""}}}`;
      }
      case "blockquote":
        return children
          .split("\n")
          .map((l: string) => `> ${l}`)
          .join("\n");
      case "ul":
        return `\n${children}\n`;
      case "ol":
        return `\n${children}\n`;
      case "li":
        return `- ${children}\n`;
      case "h1":
      case "h2":
      case "h3":
        return `\n${"#".repeat(parseInt(name[1]))} ${children}\n`;
      case "code":
        return `\`${children}\``;
      case "pre":
        return `\n\`\`\`\n${children}\n\`\`\`\n`;
      case "iframe": {
        const src = $(tag).attr("src") || "";
        if (src) return `[Embedded: ${src}](${src})`;
        return "";
      }
      case "lj-embed":
      case "lj-poll":
        return `\n[LJ ${name}]\n`;
      default:
        return children;
    }
  }

  const body = $.root();
  const result = body.contents().toArray().map(walk).join("");

  // Clean up excessive whitespace
  return result
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// Collect all post URLs from index pages
async function collectPostUrls(
  baseUrl: string,
  logger: { info: (strings: TemplateStringsArray, ...args: unknown[]) => void },
): Promise<string[]> {
  const urls: string[] = [];
  const seen = new Set<string>();
  let skip = 0;

  // Normalize base URL
  const base = baseUrl.replace(/\/$/, "");

  while (true) {
    const pageUrl = skip === 0
      ? `${base}/?format=light`
      : `${base}/?format=light&skip=${skip}`;

    logger.info`Fetching index page: skip=${skip}`;
    const html = await fetchWithRetry(pageUrl);

    // Extract post URLs
    const pattern = new RegExp(
      `href="(${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d+)\\.html)"`,
      "g",
    );
    let match;
    let foundNew = false;
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1];
      const id = match[2];
      if (!seen.has(id)) {
        seen.add(id);
        urls.push(url);
        foundNew = true;
      }
    }

    if (!foundNew) break;

    // Check for next page
    const hasNext = html.includes(`skip=${skip + 10}`);
    if (!hasNext) break;
    skip += 10;
  }

  return urls;
}

// Parse a single post page
function parsePost(
  html: string,
  _url: string,
): {
  title: string;
  date: string;
  body: string;
  tags: string[];
  images: string[];
  mood: string;
  music: string;
  comments: { user: string; date: string; text: string; parent: number }[];
} {
  const $ = cheerio.load(html);

  // Title
  const titleEl = $(".aentry-post__title-text");
  let title = titleEl.text().trim() || "Untitled";
  // Clean up any leftover span tags
  title = title.replace(/<[^>]+>/g, "").trim();

  // Date
  const dateEl = $(".aentry-head__date time");
  let date = dateEl.text().trim();
  if (!date) {
    const dateContainer = $(".aentry-head__date");
    date = dateContainer.text().trim();
  }

  // Mood
  const moodEl = $(".aentry-head__mood .aentry-head__mood-text");
  const mood = moodEl.text().trim();

  // Music (now playing)
  const musicEl = $(".aentry-head__music .aentry-head__info-text");
  const music = musicEl.text().trim();

  // Tags
  const tagsEl = $(".aentry-tags a");
  const tags: string[] = [];
  tagsEl.each((_i: number, el: Element) => {
    const tag = $(el).text().trim();
    if (tag) tags.push(tag);
  });

  // Body content
  const bodyEl = $(".aentry-post__text");
  const bodyHtml = bodyEl.html() || "";

  // Extract image URLs from body
  const images: string[] = [];
  bodyEl.find("img").each((_i: number, el: Element) => {
    const src = $(el).attr("src") || "";
    if (
      src &&
      !src.includes("l-stat.livejournal.net") &&
      !src.includes("userpic") &&
      !src.includes("stat.livejournal") &&
      !src.includes("pixel") &&
      !src.includes("spacer")
    ) {
      images.push(src);
    }
  });

  // Also check for images wrapped in links (common LJ pattern)
  bodyEl.find("a img").each((_i: number, el: Element) => {
    const parentHref = $(el).parent("a").attr("href") || "";
    if (
      parentHref &&
      (parentHref.endsWith(".jpg") ||
        parentHref.endsWith(".jpeg") ||
        parentHref.endsWith(".png") ||
        parentHref.endsWith(".gif"))
    ) {
      if (!images.includes(parentHref)) {
        images.push(parentHref);
      }
    }
  });

  const body = htmlToMarkdown(bodyHtml);

  // Extract comments from Site.page JSON
  const comments: {
    user: string;
    date: string;
    text: string;
    parent: number;
  }[] = [];
  const pageMatch = html.match(/Site\.page\s*=\s*(\{.*?\});\s/s);
  if (pageMatch) {
    try {
      const pageData = JSON.parse(pageMatch[1]);
      const rawComments = pageData.comments || [];
      for (const c of rawComments) {
        const article = (c.article || "").replace(/<[^>]+>/g, "").trim();
        if (!article && !c.uname) continue; // skip empty/deleted
        comments.push({
          user: c.uname || c.dname || "anonymous",
          date: c.ctime || "",
          text: article,
          parent: c.parent || 0,
        });
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  return { title, date, body, tags, images, mood, music, comments };
}

// Parse LJ date to ISO
function parseLjDate(dateStr: string): string {
  // Format: "August 22 2010, 21:14" or "January 8 2013, 00:24"
  const months: Record<string, string> = {
    January: "01",
    February: "02",
    March: "03",
    April: "04",
    May: "05",
    June: "06",
    July: "07",
    August: "08",
    September: "09",
    October: "10",
    November: "11",
    December: "12",
  };

  const m = dateStr.match(
    /(\w+)\s+(\d+)\s+(\d{4}),?\s+(\d{2}):(\d{2})/,
  );
  if (m) {
    const month = months[m[1]] || "01";
    const day = m[2].padStart(2, "0");
    return `${m[3]}-${month}-${day}T${m[4]}:${m[5]}:00`;
  }
  return dateStr;
}

// Sanitize filename
function sanitize(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|.]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 100);
}

/** Swamp model that imports LiveJournal entries (images, tags, mood, now playing, comments) into an Obsidian vault. */
export const model = {
  type: "@magistr/livejournal/import",
  version: "2026.07.16.2",
  upgrades: [
    {
      fromVersion: "2026.03.28.1",
      toVersion: "2026.03.28.2",
      description: "Add mood and now_playing fields",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.03.28.2",
      toVersion: "2026.03.29.1",
      description: "Add comments extraction",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Import summary",
      schema: ImportResultSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    post: {
      description: "Individual imported post",
      schema: PostSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    import: {
      description:
        "Fetch all entries from LiveJournal and import them with images and tags into Obsidian",
      arguments: z.object({}),
      execute: async (_args: unknown, context: {
        globalArgs: {
          journalUrl: string;
          vault: string;
          folder: string;
          attachmentsFolder: string;
        };
        logger: {
          info: (strings: TemplateStringsArray, ...args: unknown[]) => void;
        };
        writeResource: (
          spec: string,
          instance: string,
          data: Record<string, unknown>,
        ) => Promise<unknown>;
      }) => {
        const { journalUrl, vault, folder, attachmentsFolder } =
          context.globalArgs;
        const logger = context.logger;

        // Resolve vault path for image storage
        const vaultPath = await getVaultPath(vault);
        const attachFolder = `${folder}/${attachmentsFolder}`;
        const attachDiskPath = `${vaultPath}/${attachFolder}`;
        await Deno.mkdir(attachDiskPath, { recursive: true });

        // Collect all post URLs
        logger.info`Collecting post URLs from ${journalUrl}`;
        const postUrls = await collectPostUrls(journalUrl, logger);
        logger.info`Found ${postUrls.length} posts`;

        const errors: string[] = [];
        let notesCreated = 0;
        let imagesCopied = 0;
        const dataHandles: unknown[] = [];

        for (let i = 0; i < postUrls.length; i++) {
          const postUrl = postUrls[i];
          const postId = postUrl.match(/\/(\d+)\.html/)?.[1] || `${i}`;

          logger.info`Processing post ${i + 1}/${postUrls.length}: ${postUrl}`;

          try {
            const html = await fetchWithRetry(`${postUrl}?format=light`);
            const post = parsePost(html, postUrl);
            const isoDate = parseLjDate(post.date);
            const datePrefix = isoDate.split("T")[0];
            const slug = `${datePrefix}-${sanitize(post.title || postId)}`;

            // Download images
            const imageNames: string[] = [];
            for (let j = 0; j < post.images.length; j++) {
              const imgUrl = post.images[j];
              const ext = imgUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] ||
                "jpg";
              const imgName = `lj-${postId}-${j + 1}.${ext}`;

              try {
                const resp = await fetch(imgUrl);
                if (resp.ok) {
                  const data = new Uint8Array(await resp.arrayBuffer());
                  await Deno.writeFile(`${attachDiskPath}/${imgName}`, data);
                  imageNames.push(imgName);
                  imagesCopied++;
                }
              } catch (e) {
                errors.push(
                  `Image download failed ${imgUrl}: ${(e as Error).message}`,
                );
              }
            }

            // Build frontmatter
            const fm = [
              "---",
              `title: "${post.title.replace(/"/g, '\\"')}"`,
              `date: ${isoDate}`,
              `source: livejournal`,
              `url: "${postUrl}"`,
              `lj_id: ${postId}`,
            ];
            if (post.mood) {
              fm.push(`mood: "${post.mood.replace(/"/g, '\\"')}"`);
            }
            if (post.music) {
              fm.push(`now_playing: "${post.music.replace(/"/g, '\\"')}"`);
            }
            if (post.tags.length > 0) {
              fm.push("tags:");
              fm.push("  - livejournal");
              for (const tag of post.tags) {
                fm.push(`  - "${tag}"`);
              }
            } else {
              fm.push("tags:", "  - livejournal");
            }
            fm.push("---", "");

            // Build body — replace image placeholders with obsidian embeds
            let body = post.body;
            let imgIdx = 0;
            body = body.replace(/\{\{IMG:[^}]*\}\}/g, () => {
              if (imgIdx < imageNames.length) {
                const name = imageNames[imgIdx];
                imgIdx++;
                return `![[${attachFolder}/${name}]]`;
              }
              return "";
            });

            // Append any remaining images not in body
            const remaining = imageNames.slice(imgIdx);
            if (remaining.length > 0) {
              body += "\n\n";
              for (const name of remaining) {
                body += `![[${attachFolder}/${name}]]\n`;
              }
            }

            // Append comments section
            if (post.comments.length > 0) {
              body += "\n\n---\n\n## Comments\n\n";
              // Build a map of talkid -> comment for threading
              for (const comment of post.comments) {
                const indent = comment.parent ? "> " : "";
                const header = `${indent}**${comment.user}**`;
                const dateStr = comment.date ? ` *(${comment.date})*` : "";
                const text = comment.text ? `\n${indent}${comment.text}` : "";
                body += `${header}${dateStr}${text}\n\n`;
              }
            }

            const noteContent = fm.join("\n") + body;
            const notePath = `${folder}/${slug}`;

            const noteKey = notePath.includes("/") ? "path" : "name";
            await runObsidian(
              "create",
              { [noteKey]: notePath, content: noteContent },
              vault,
              ["overwrite"],
            );
            notesCreated++;

            // Write post resource
            const postHandle = await context.writeResource("post", slug, {
              id: parseInt(postId),
              title: post.title,
              date: isoDate,
              url: postUrl,
              text: body.substring(0, 500),
              tags: post.tags,
              mood: post.mood || undefined,
              nowPlaying: post.music || undefined,
              imageCount: imageNames.length,
              timestamp: new Date().toISOString(),
            });
            dataHandles.push(postHandle);

            // Small delay between requests to be polite
            if (i < postUrls.length - 1) {
              await new Promise((r) => setTimeout(r, 300));
            }
          } catch (e) {
            errors.push(
              `Failed to process ${postUrl}: ${(e as Error).message}`,
            );
          }
        }

        // Extract journal name from URL
        const journalName = journalUrl.match(/:\/\/([^.]+)/)?.[1] ||
          "livejournal";

        // Write summary
        const summaryHandle = await context.writeResource("result", "main", {
          journal: journalName,
          totalPosts: postUrls.length,
          notesCreated,
          imagesCopied,
          errors,
          timestamp: new Date().toISOString(),
        });
        dataHandles.push(summaryHandle);

        logger
          .info`Import complete: ${notesCreated} notes, ${imagesCopied} images. Errors: ${errors.length}`;

        return { dataHandles };
      },
    },
  },
};
