import { z } from "npm:zod@4";

// Juick.com API model
// Public JSON API at https://api.juick.com/
// No auth required for read operations

const GlobalArgsSchema = z.object({
  apiUrl: z.string().url().default("https://api.juick.com").describe(
    "Juick API base URL",
  ),
  allowedHosts: z.array(z.string()).default(["api.juick.com"]).describe(
    "Default-deny hostname allowlist applied to the Juick API request and to " +
      "every redirect it follows (LB1 SSRF fix). A custom apiUrl's host must " +
      "be added here too, or the request is rejected.",
  ),
  timeout: z.number().default(30000).describe(
    "Per-request timeout (ms) applied to every Juick API fetch via " +
      "AbortController (LB7 fix). Backward-compatible default -- existing " +
      "instances behave exactly as before unless this is set explicitly.",
  ),
  maxPages: z.number().default(1000).describe(
    "Maximum number of pages getUserPosts will paginate through before " +
      "stopping (LB3 fix -- safety cap against unbounded/stuck pagination). " +
      "Backward-compatible default well above any real feed's page count.",
  ),
});

// --- Schemas ---

const UserSchema = z.object({
  uid: z.number(),
  uname: z.string(),
  fullname: z.string().optional(),
  avatar: z.string().optional(),
}).passthrough();

const ReplySchema = z.object({
  mid: z.number(),
  rid: z.number().optional(),
  body: z.string().optional(),
  user: UserSchema,
  timestamp: z.string().optional(),
  replyQuote: z.string().optional(),
}).passthrough();

const MessageSchema = z.object({
  mid: z.number(),
  body: z.string().optional(),
  timestamp: z.string().optional(),
  updated: z.string().optional(),
  user: UserSchema,
  tags: z.array(z.string()).optional(),
  likes: z.number().optional(),
  replies: z.number().optional(),
  attach: z.string().optional(),
  photo: z.object({
    medium: z.string().optional(),
    small: z.string().optional(),
    thumbnail: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const UserPostsSchema = z.object({
  userSlug: z.string(),
  posts: z.array(
    z.object({
      mid: z.number(),
      body: z.string().optional(),
      timestamp: z.string().optional(),
      tags: z.array(z.string()).optional(),
      likes: z.number().optional(),
      replyCount: z.number().optional(),
      imageUrl: z.string().optional(),
      comments: z.array(ReplySchema).optional(),
      obsidianPath: z.string().optional(),
      obsidianContent: z.string().optional(),
    }).passthrough(),
  ),
  count: z.number(),
});

// --- SSRF guards (LB1) ---

// True if `hostname` (already lowercased; brackets stripped for IPv6) is a
// loopback, link-local, or RFC1918-style private-range IP literal. Checked
// UNCONDITIONALLY before the allowedHosts allowlist below -- even an
// allowedHosts entry naming one of these ranges outright cannot resurrect
// access to it. Only literal IP shapes are recognized (no DNS resolution),
// matching the sibling SSRF fixes elsewhere in this workspace (bandcamp's
// assertAllowedHost, livejournal-import's isAllowedImageHost).
function isPrivateOrLoopbackIp(hostname: string): boolean {
  const h = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (h.includes(":")) {
    // IPv6
    if (h === "::1" || h === "::") return true;
    if (
      h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") ||
      h.startsWith("feb")
    ) {
      return true; // fe80::/10 link-local
    }
    const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateOrLoopbackIp(mapped[1]);
    return false;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 0 && b === 0 && c === 0 && d === 0) return true; // 0.0.0.0
  return false;
}

/**
 * SSRF guard (LB1): default-deny -- only http(s) URLs whose host appears in
 * `allowedHosts` may ever be fetched, and a loopback/link-local/private-range
 * IP literal is rejected UNCONDITIONALLY first, even if it happens to also be
 * listed in allowedHosts. Applied at the top of juickApi AND re-applied to
 * every redirect Location (mirrors musicbrainz's assertBandcampUrl /
 * bandcamp's assertAllowedHost -- same shape, allowlist source differs).
 */
function assertPublicHttpUrl(rawUrl: string, allowedHosts: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Refusing to fetch: invalid URL "${rawUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing to fetch ${rawUrl}: unsupported protocol "${parsed.protocol}"`,
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackIp(hostname)) {
    throw new Error(
      `Refusing to fetch ${rawUrl}: host "${hostname}" is a loopback/link-local/private-range IP literal`,
    );
  }
  if (!allowedHosts.some((host) => host.toLowerCase() === hostname)) {
    throw new Error(
      `Refusing to fetch ${rawUrl}: host "${hostname}" is not in allowedHosts (${
        allowedHosts.join(", ")
      })`,
    );
  }
  return parsed;
}

// --- YAML scalar escaping (LB2) ---

/**
 * Escape a string for use inside a YAML double-quoted scalar: backslash and
 * double-quote are backslash-escaped, and every C0 control character
 * (including CR/LF) is replaced with its escape sequence. Used for `uname`
 * in the `source:`/`author:` frontmatter lines so a hostile uname containing
 * a quote or a newline cannot inject a new YAML key (only `title` was
 * escaped before this fix).
 */
export function yamlDq(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(
      // deno-lint-ignore no-control-regex
      /[\x00-\x1f]/g,
      (c) => {
        switch (c) {
          case "\n":
            return "\\n";
          case "\r":
            return "\\r";
          case "\t":
            return "\\t";
          default:
            return "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
        }
      },
    );
}

// --- HTTP helper ---

const MAX_JUICK_REDIRECT_HOPS = 5;

async function juickApi(
  apiUrl: string,
  path: string,
  allowedHosts: string[],
  timeoutMs: number,
) {
  // LB1: the host guard runs FIRST, before any timer is allocated -- a
  // rejected URL never touches fetch and never starts a clock.
  let current = assertPublicHttpUrl(
    `${apiUrl.replace(/\/$/, "")}${path}`,
    allowedHosts,
  );

  // LB7: one AbortController + timer for the WHOLE call, spanning every
  // redirect hop below -- a slow chain of redirects is bounded by the same
  // overall timeout as a single request, and clearTimeout always runs in
  // `finally` regardless of which hop throws or succeeds.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_JUICK_REDIRECT_HOPS; hop++) {
      const res = await fetch(current.toString(), {
        redirect: "manual",
        signal: ac.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) {
          throw new Error(
            `GET ${path} failed: ${res.status} redirect with no Location header`,
          );
        }
        if (hop === MAX_JUICK_REDIRECT_HOPS) {
          throw new Error(`GET ${path} failed: too many redirects`);
        }
        // LB1: re-validate the redirect target on EVERY hop -- a bounce to
        // an internal/private host must be rejected exactly like a direct
        // request to it.
        current = assertPublicHttpUrl(
          new URL(location, current).toString(),
          allowedHosts,
        );
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        // LB7: surface Retry-After (429/503 only) in the thrown error --
        // still no auto-retry/sleep, just visibility.
        let retrySuffix = "";
        if (res.status === 429 || res.status === 503) {
          const retryAfter = res.headers.get("retry-after");
          if (retryAfter) retrySuffix = ` (Retry-After: ${retryAfter})`;
        }
        throw new Error(
          `GET ${path} failed: ${res.status} ${
            text.slice(0, 500)
          }${retrySuffix}`,
        );
      }

      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        // LB4: map an unparsable 200 body to a domain error instead of
        // letting a bare SyntaxError escape.
        throw new Error(
          `Juick ${path}: invalid JSON response (status ${res.status})`,
        );
      }
    }
    throw new Error(`GET ${path} failed: too many redirects`);
  } finally {
    clearTimeout(timer);
  }
}

// --- Model ---

/** Juick.com microblogging model: fetch feed messages, threads, user profiles, and import a user's full post history (with comments) as Obsidian-ready markdown. */
export const model = {
  type: "@magistr/juick",
  version: "2026.08.19.1",
  upgrades: [
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.08.02.1",
      description:
        "SSRF host-allowlist + private-IP/scheme backstop + redirect re-validation, fetch AbortController timeout + Retry-After surfacing, bounded pagination -- adds allowedHosts/timeout/maxPages global args (all defaulted, no resource schema change)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.19.1",
      description: "Version bump and smoke test",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,

  resources: {
    messages: {
      description: "Messages from Juick feed",
      schema: z.object({
        query: z.string(),
        messages: z.array(MessageSchema),
        count: z.number(),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    thread: {
      description: "Full thread with comments",
      schema: z.object({
        mid: z.number(),
        post: MessageSchema,
        comments: z.array(ReplySchema),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
    userProfile: {
      description: "User profile",
      schema: UserSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    userPosts: {
      description: "All posts by a user with comments",
      schema: UserPostsSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },

  methods: {
    getMessages: {
      description: "Get messages from feed, optionally filtered by user or tag",
      arguments: z.object({
        uname: z.string().optional().describe("Filter by username"),
        tag: z.string().optional().describe("Filter by tag"),
        search: z.string().optional().describe("Full-text search"),
        popular: z.boolean().optional().describe("Show popular messages"),
      }),
      execute: async (args, context) => {
        const {
          apiUrl,
          // Backward-compatible JS-level defaults (LB1/LB7): GlobalArgsSchema
          // already applies `.default(...)` when swamp parses a real model
          // instance's global arguments, but these defaults are ALSO applied
          // here so an existing instance upgraded in place (or a caller that
          // hands this method raw globalArgs without going through the
          // schema, e.g. a test harness) behaves identically to before this
          // change unless allowedHosts/timeout are set explicitly.
          allowedHosts = ["api.juick.com"],
          timeout = 30000,
        } = context.globalArgs;

        const params = new URLSearchParams();
        if (args.uname) params.set("uname", args.uname);
        if (args.tag) params.set("tag", args.tag);
        if (args.search) params.set("search", args.search);
        if (args.popular) params.set("popular", "1");

        const qs = params.toString();
        const data = await juickApi(
          apiUrl,
          `/messages${qs ? "?" + qs : ""}`,
          allowedHosts,
          timeout,
        );
        // LB5: a non-array truthy response no longer sails through --
        // coerce to [] exactly like the falsy case already did.
        const messages = Array.isArray(data) ? data : [];
        // LB8: when BOTH uname and tag are given, fold both into the
        // resource name -- previously tag was silently dropped from the
        // name (though not from the query), so two different tag-scoped
        // feeds for the same uname clobbered each other's persisted
        // resource.
        const name = args.uname && args.tag
          ? `feed_${args.uname}_tag_${args.tag}`
          : `feed_${args.uname || args.tag || "all"}`;
        const handle = await context.writeResource(
          "messages",
          name,
          {
            query: qs,
            messages,
            count: messages.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    getThread: {
      description: "Get a full thread (post + comments) by message ID",
      arguments: z.object({
        mid: z.number().describe("Message ID"),
      }),
      execute: async (args, context) => {
        const {
          apiUrl,
          allowedHosts = ["api.juick.com"],
          timeout = 30000,
        } = context.globalArgs;
        const data = await juickApi(
          apiUrl,
          `/thread?mid=${args.mid}`,
          allowedHosts,
          timeout,
        );
        // LB5: a non-array truthy response previously threw a bare
        // TypeError from `.slice(1)` before any resource was written.
        // Coercing to [] here means post/comments always default cleanly.
        const items = Array.isArray(data) ? data : [];
        const post = items[0] || {};
        const comments = items.slice(1);
        const handle = await context.writeResource(
          "thread",
          `thread_${args.mid}`,
          {
            mid: args.mid,
            post,
            comments,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    getUser: {
      description: "Get user profile",
      arguments: z.object({
        uname: z.string().describe("Username"),
      }),
      execute: async (args, context) => {
        const {
          apiUrl,
          allowedHosts = ["api.juick.com"],
          timeout = 30000,
        } = context.globalArgs;
        const data = await juickApi(
          apiUrl,
          `/users?uname=${encodeURIComponent(args.uname)}`,
          allowedHosts,
          timeout,
        );
        const rawUser = Array.isArray(data) ? data[0] : data;
        // LB5: validate against UserSchema and throw a domain error instead
        // of writing a hostile/malformed shape (or `undefined`) through
        // as-is.
        const parsed = UserSchema.safeParse(rawUser);
        if (!parsed.success) {
          throw new Error(
            `Juick getUser(${args.uname}): invalid user response`,
          );
        }
        const handle = await context.writeResource(
          "userProfile",
          `user_${args.uname}`,
          parsed.data,
        );
        return { dataHandles: [handle] };
      },
    },

    getUserPosts: {
      description:
        "Get ALL posts by a user with pagination, fetch comments for each, format for Obsidian",
      arguments: z.object({
        uname: z.string().describe("Username"),
        folder: z.string().default("juick").describe(
          "Obsidian folder for notes",
        ),
        withComments: z.boolean().default(true).describe(
          "Fetch comments for each post",
        ),
      }),
      execute: async (args, context) => {
        const {
          allowedHosts = ["api.juick.com"],
          timeout = 30000,
          maxPages = 1000,
        } = context.globalArgs;
        const apiUrl = context.globalArgs.apiUrl.replace(/\/$/, "");

        // Paginate through all posts
        const allMessages: Array<Record<string, unknown>> = [];
        let beforeMid: number | null = null;
        let pageCount = 0;

        while (true) {
          pageCount++;
          // LB3: hard cap on the number of pages -- a server that keeps
          // answering (whether because before_mid never advances or because
          // it plain ignores the cursor) can no longer loop forever.
          if (pageCount > maxPages) {
            context.logger.warn(
              `getUserPosts(${args.uname}): stopped after ${maxPages} pages (maxPages cap reached)`,
            );
            break;
          }

          let url = `/messages?uname=${encodeURIComponent(args.uname)}`;
          if (beforeMid) url += `&before_mid=${beforeMid}`;

          const batch = await juickApi(apiUrl, url, allowedHosts, timeout);
          if (!batch || batch.length === 0) break;

          allMessages.push(...batch);

          // LB3: if the cursor didn't advance (the last message in the
          // batch has no `mid`, or the server echoed the same before_mid
          // back) the NEXT request would be identical to this one -- stop
          // instead of looping on it forever.
          const nextBeforeMid = batch[batch.length - 1].mid;
          if (!nextBeforeMid || nextBeforeMid === beforeMid) {
            context.logger.warn(
              `getUserPosts(${args.uname}): pagination cursor did not advance past before_mid=${
                beforeMid ?? "(none)"
              } -- stopping to avoid an infinite loop`,
            );
            break;
          }
          beforeMid = nextBeforeMid;

          context.logger.info(
            `Fetched ${batch.length} messages, total: ${allMessages.length}`,
          );
        }

        context.logger.info(
          `Total posts for ${args.uname}: ${allMessages.length}`,
        );

        // Fetch comments and build Obsidian notes
        const posts: Array<Record<string, unknown>> = [];

        for (const msg of allMessages) {
          const mid = msg.mid as number;
          const body = (msg.body as string) || "";
          const tags = (msg.tags as string[]) || [];
          const likes = (msg.likes as number) || 0;
          const replyCount = (msg.replies as number) || 0;
          const timestamp = (msg.timestamp as string) || "";
          const attach = msg.attach as string | undefined;
          const photo = msg.photo as Record<string, string> | undefined;

          // Image URL
          let imageUrl: string | undefined;
          if (photo?.medium) {
            imageUrl = photo.medium;
          } else if (attach) {
            imageUrl = `https://juick.com/i/p/${mid}.${attach}`;
          }

          // Fetch comments if requested and post has replies
          let comments: Array<Record<string, unknown>> = [];
          if (args.withComments && replyCount > 0) {
            try {
              const thread = await juickApi(
                apiUrl,
                `/thread?mid=${mid}`,
                allowedHosts,
                timeout,
              );
              comments = (thread || []).slice(1);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              context.logger.warn(
                `Could not fetch thread ${mid}: ${msg}`,
              );
            }
          }

          // Format date
          const date = timestamp ? timestamp.split(" ")[0] : "";

          // Build Obsidian markdown
          // LB6: slice the first line by CODE POINT, not UTF-16 code unit,
          // so an astral character (surrogate pair) landing exactly at the
          // 80-character boundary is kept whole instead of split into a
          // lone, unpaired surrogate.
          const firstLine = body.split("\n")[0];
          const title = Array.from(firstLine).slice(0, 80).join("").replace(
            /[\/\\:*?"<>|#%\[\]{}]/g,
            "-",
          ).replace(/\.+$/, "").replace(/\s+$/, "").trim() || `juick-${mid}`;
          // LB2: uname is interpolated into the YAML frontmatter's
          // source:/author: lines -- escape it as a double-quoted scalar so
          // an embedded quote or newline can't break out of the value or
          // inject a new frontmatter key (title was already escaped; uname
          // was not).
          const safeUname = yamlDq(args.uname);
          let md = "---\n";
          md += `title: "${title.replace(/"/g, '\\"')}"\n`;
          md += `source: "https://juick.com/${safeUname}/${mid}"\n`;
          md += `mid: ${mid}\n`;
          md += `author: "${safeUname}"\n`;
          if (date) md += `date: ${date}\n`;
          md += `likes: ${likes}\n`;
          md += `comment_count: ${comments.length}\n`;
          if (tags.length > 0) {
            md += "tags:\n  - juick\n";
            for (const tag of tags) {
              // LB2: colons still become hyphens (unchanged); newlines are
              // additionally collapsed to spaces and any remaining control
              // character is stripped, so a hostile tag can no longer inject
              // an extra YAML list item.
              const safeTag = tag
                .replace(/:/g, "-")
                .replace(/[\r\n]+/g, " ")
                // deno-lint-ignore no-control-regex
                .replace(/[\x00-\x1f]/g, "");
              md += `  - ${safeTag}\n`;
            }
          } else {
            md += "tags:\n  - juick\n";
          }
          md += "---\n\n";

          // Post body
          md += `${body}\n\n`;

          // Image
          if (imageUrl) {
            md += `![](${imageUrl})\n\n`;
          }

          // Source link
          md += "---\n\n";
          md +=
            `> Original: [juick.com/${args.uname}/${mid}](https://juick.com/${args.uname}/${mid})\n\n`;

          // Comments
          if (comments.length > 0) {
            md += `## Comments (${comments.length})\n\n`;
            for (const c of comments) {
              const cUser = (c.user as Record<string, unknown>)?.uname ||
                "Anonymous";
              const cDate = ((c.timestamp as string) || "").split(" ")[0];
              const quote = c.replyQuote as string | undefined;
              md += `### ${cUser}`;
              if (cDate) md += ` — ${cDate}`;
              md += "\n\n";
              if (quote) md += `> ${quote}\n\n`;
              md += `${(c.body as string) || ""}\n\n`;
            }
          }

          const obsidianPath = `${args.folder}/${
            date ? date + " " : ""
          }${title}`;

          posts.push({
            mid,
            body,
            timestamp,
            tags,
            likes,
            replyCount,
            imageUrl,
            comments,
            obsidianPath,
            obsidianContent: md,
          });
        }

        const handle = await context.writeResource(
          "userPosts",
          `posts_${args.uname}`,
          {
            userSlug: args.uname,
            posts,
            count: posts.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
