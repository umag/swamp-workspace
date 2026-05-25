import { z } from "npm:zod@4";

// Juick.com API model
// Public JSON API at https://api.juick.com/
// No auth required for read operations

const GlobalArgsSchema = z.object({
  apiUrl: z.string().url().default("https://api.juick.com").describe(
    "Juick API base URL",
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

// --- HTTP helper ---

async function juickApi(apiUrl: string, path: string) {
  const url = `${apiUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  return text ? JSON.parse(text) : null;
}

// --- Model ---

/** Juick.com microblogging model: fetch feed messages, threads, user profiles, and import a user's full post history (with comments) as Obsidian-ready markdown. */
export const model = {
  type: "@magistr/juick",
  version: "2026.03.29.1",
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
        const params = new URLSearchParams();
        if (args.uname) params.set("uname", args.uname);
        if (args.tag) params.set("tag", args.tag);
        if (args.search) params.set("search", args.search);
        if (args.popular) params.set("popular", "1");

        const qs = params.toString();
        const data = await juickApi(
          context.globalArgs.apiUrl,
          `/messages${qs ? "?" + qs : ""}`,
        );
        const handle = await context.writeResource(
          "messages",
          `feed_${args.uname || args.tag || "all"}`,
          {
            query: qs,
            messages: data || [],
            count: (data || []).length,
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
        const data = await juickApi(
          context.globalArgs.apiUrl,
          `/thread?mid=${args.mid}`,
        );
        const items = data || [];
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
        const data = await juickApi(
          context.globalArgs.apiUrl,
          `/users?uname=${encodeURIComponent(args.uname)}`,
        );
        const user = Array.isArray(data) ? data[0] : data;
        const handle = await context.writeResource(
          "userProfile",
          `user_${args.uname}`,
          user,
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
        const apiUrl = context.globalArgs.apiUrl.replace(/\/$/, "");

        // Paginate through all posts
        const allMessages: Array<Record<string, unknown>> = [];
        let beforeMid: number | null = null;

        while (true) {
          let url = `/messages?uname=${encodeURIComponent(args.uname)}`;
          if (beforeMid) url += `&before_mid=${beforeMid}`;

          const batch = await juickApi(apiUrl, url);
          if (!batch || batch.length === 0) break;

          allMessages.push(...batch);
          beforeMid = batch[batch.length - 1].mid;
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
              const thread = await juickApi(apiUrl, `/thread?mid=${mid}`);
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
          const title = body.split("\n")[0].slice(0, 80).replace(
            /[\/\\:*?"<>|#%\[\]{}]/g,
            "-",
          ).replace(/\.+$/, "").replace(/\s+$/, "").trim() || `juick-${mid}`;
          let md = "---\n";
          md += `title: "${title.replace(/"/g, '\\"')}"\n`;
          md += `source: "https://juick.com/${args.uname}/${mid}"\n`;
          md += `mid: ${mid}\n`;
          md += `author: "${args.uname}"\n`;
          if (date) md += `date: ${date}\n`;
          md += `likes: ${likes}\n`;
          md += `comment_count: ${comments.length}\n`;
          if (tags.length > 0) {
            md += "tags:\n  - juick\n";
            for (const tag of tags) {
              md += `  - ${tag.replace(/:/g, "-")}\n`;
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
