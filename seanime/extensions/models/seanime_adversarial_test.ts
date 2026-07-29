/**
 * Adversarial suite: partial-failure vs pre-loop-read-failure distinction,
 * per-method re-run idempotency (including the negative same-list pin for
 * set-planning-watching), hostile/malformed AniList payloads, title
 * path-traversal, duplicate-mediaId double-POST, server-echoed-token
 * persistence into written failure records, and a mechanical
 * fixtures-secret-scan over seanime/fixtures/*.json.
 *
 * seanime.ts is UNMODIFIED — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Where a test documents a real gap, it is labeled "pin" and says so
 * explicitly.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./seanime.ts";
import status from "../../fixtures/status.json" with { type: "json" };
import libraryCollection from "../../fixtures/library-collection.json" with {
  type: "json",
};
import missingEpisodes from "../../fixtures/missing-episodes.json" with {
  type: "json",
};
import torrentList from "../../fixtures/torrent-list.json" with {
  type: "json",
};
import anilistCollection from "../../fixtures/anilist-collection.json" with {
  type: "json",
};
import autoDownloaderRules from "../../fixtures/auto-downloader-rules.json" with {
  type: "json",
};
import listEntry from "../../fixtures/list-entry.json" with { type: "json" };
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "http://seanime.example.com:3211",
  token: "adv-fixture-token",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

/** Build a `/anilist/collection` fixture with a single PLANNING list holding
 * the given entries (each a bare `media` object, `entry.media` in the
 * model's shape). */
function collectionOf(entries: Array<Record<string, unknown> | null>) {
  return {
    data: {
      MediaListCollection: {
        lists: [
          {
            status: "PLANNING",
            entries: entries.map((media) => ({ media })),
          },
        ],
      },
    },
  };
}

function media(
  id: number,
  status: string,
  romaji: string,
): Record<string, unknown> {
  return { id, status, title: { romaji } };
}

// ---------------------------------------------------------------------------
// Partial-failure mid-bulk vs pre-loop-read failure — DISTINCT failure modes
// ---------------------------------------------------------------------------

Deno.test("sync-planning-rules: partial failure mid-bulk — one entry's rule POST throws, the rest still process", async () => {
  const collection = collectionOf([
    media(300001, "RELEASING", "Fixture Alpha"),
    media(300002, "RELEASING", "Fixture Beta"),
    media(300003, "RELEASING", "Fixture Gamma"),
  ]);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      if (url.pathname === "/api/v1/auto-downloader/rule") {
        return requestBody(req).then((body) =>
          body.rule &&
            (body.rule as Record<string, unknown>).mediaId === 300002
            ? new Response("server exploded", { status: 500 })
            : json({ data: { success: true } })
        );
      }
      return undefined;
    }],
    async () => {
      await run("sync-planning-rules", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  const created = res.payload.created as Array<{ mediaId: number }>;
  const failed = res.payload.failed as Array<
    { mediaId: number; error: string }
  >;
  assertEquals(created.map((c) => c.mediaId).sort(), [300001, 300003]);
  assertEquals(failed.length, 1);
  assertEquals(failed[0].mediaId, 300002);
});

Deno.test("set-planning-watching: partial failure mid-bulk — one entry's list-entry POST throws, the rest still process", async () => {
  const collection = collectionOf([
    media(300011, "RELEASING", "Fixture Delta"),
    media(300012, "RELEASING", "Fixture Epsilon"),
  ]);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/anilist/list-entry") {
        return requestBody(req).then((body) =>
          body.mediaId === 300012
            ? new Response("server exploded", { status: 500 })
            : json({ data: { success: true } })
        );
      }
      return undefined;
    }],
    async () => {
      await run("set-planning-watching", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "statusChangeResult")!;
  const updated = res.payload.updated as Array<{ mediaId: number }>;
  const failed = res.payload.failed as Array<{ mediaId: number }>;
  assertEquals(updated.map((u) => u.mediaId), [300011]);
  assertEquals(failed.map((f) => f.mediaId), [300012]);
});

Deno.test("sync-planning-rules: a failing PRE-LOOP /anilist/collection read aborts before any POST, writes NO result", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return new Response("boom", { status: 500 });
      }
      throw new Error(
        `unexpected call to ${url.pathname} before the read failed`,
      );
    }],
    async () => {
      await assertRejects(() => run("sync-planning-rules", {}, ctx), Error);
    },
  );
  assertEquals(written.find((w) => w.spec === "ruleSyncResult"), undefined);
});

Deno.test("sync-planning-rules: a failing PRE-LOOP /auto-downloader/rules read aborts before any rule POST, writes NO result", async () => {
  const collection = collectionOf([media(300021, "RELEASING", "Fixture Zeta")]);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return new Response("boom", { status: 500 });
      }
      throw new Error(
        `unexpected call to ${url.pathname} before the read failed`,
      );
    }],
    async () => {
      await assertRejects(() => run("sync-planning-rules", {}, ctx), Error);
    },
  );
  assertEquals(written.find((w) => w.spec === "ruleSyncResult"), undefined);
});

Deno.test("set-planning-watching: a failing PRE-LOOP /anilist/collection read aborts before any POST, writes NO result", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return new Response("boom", { status: 500 });
      }
      throw new Error(
        `unexpected call to ${url.pathname} before the read failed`,
      );
    }],
    async () => {
      await assertRejects(() => run("set-planning-watching", {}, ctx), Error);
    },
  );
  assertEquals(written.find((w) => w.spec === "statusChangeResult"), undefined);
});

// ---------------------------------------------------------------------------
// Re-run idempotency, per-method
// ---------------------------------------------------------------------------

Deno.test("sync-planning-rules: re-run idempotency — run-2's existing-rules include run-1's creations, so created==[]", async () => {
  const collection = collectionOf([media(300031, "RELEASING", "Fixture Eta")]);
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      if (url.pathname === "/api/v1/auto-downloader/rule") {
        return json({ data: { success: true } });
      }
      return undefined;
    }],
    async () => {
      await run("sync-planning-rules", {}, ctx);
    },
  );

  const { ctx: ctx2, written: written2 } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [{ mediaId: 300031 }] });
      }
      throw new Error(`unexpected POST on re-run: ${url.pathname}`);
    }],
    async () => {
      await run("sync-planning-rules", {}, ctx2);
    },
  );
  const res2 = written2.find((w) => w.spec === "ruleSyncResult")!;
  assertEquals(res2.payload.created, []);
  const skipped = res2.payload.skipped as Array<
    { mediaId: number; title: string; reason: string }
  >;
  assertEquals(skipped, [
    { mediaId: 300031, title: "Fixture Eta", reason: "rule already exists" },
  ]);
});

Deno.test("set-planning-watching: fresh run-2 PLANNING list EXCLUDING run-1's flipped entries -> zero re-POST", async () => {
  const run1Collection = collectionOf([
    media(300041, "RELEASING", "Fixture Theta"),
  ]);
  // run-2's fresh read: the entry has already left PLANNING (moved to
  // CURRENT on the real AniList account), so the list is now empty of it.
  const run2Collection = collectionOf([
    media(300042, "FINISHED", "Fixture Iota"), // ineligible by default anyway
  ]);

  const { ctx: ctx1 } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(run1Collection);
      }
      if (url.pathname === "/api/v1/anilist/list-entry") return json(listEntry);
      return undefined;
    }],
    async () => {
      await run("set-planning-watching", {}, ctx1);
    },
  );

  const { ctx: ctx2, written: written2 } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(run2Collection);
      }
      throw new Error(`unexpected POST on fresh re-run: ${url.pathname}`);
    }],
    async () => {
      await run("set-planning-watching", {}, ctx2);
    },
  );
  const res2 = written2.find((w) => w.spec === "statusChangeResult")!;
  assertEquals(res2.payload.updated, []);
});

Deno.test("NEGATIVE pin: set-planning-watching is NOT idempotent in isolation — a same-PLANNING-list run-2 DOES re-POST", async () => {
  const collection = collectionOf([
    media(300051, "RELEASING", "Fixture Kappa"),
  ]);
  let listEntryPosts = 0;
  const stub: Route = (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/anilist/collection") return json(collection);
    if (url.pathname === "/api/v1/anilist/list-entry") {
      listEntryPosts++;
      return json(listEntry);
    }
    return undefined;
  };

  const { ctx: ctx1, written: written1 } = makeCtx();
  await withFetchStub([stub], async () => {
    await run("set-planning-watching", {}, ctx1);
  });
  const { ctx: ctx2, written: written2 } = makeCtx();
  await withFetchStub([stub], async () => {
    await run("set-planning-watching", {}, ctx2);
  });

  assertEquals(
    listEntryPosts,
    2,
    "the exact same PLANNING list run twice re-POSTs both times — no client-side idempotency guard",
  );
  assertEquals(
    (written1.find((w) => w.spec === "statusChangeResult")!.payload
      .updated as unknown[]).length,
    1,
  );
  assertEquals(
    (written2.find((w) => w.spec === "statusChangeResult")!.payload
      .updated as unknown[]).length,
    1,
  );
});

Deno.test("pin: every set-planning-watching flip sends progress:0 — a data-reset hazard on re-run", async () => {
  const collection = collectionOf([
    media(300061, "RELEASING", "Fixture Lambda"),
  ]);
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/anilist/list-entry") return json(listEntry);
      return undefined;
    }],
    async (calls) => {
      await run("set-planning-watching", {}, ctx);
      const postCall = calls.find((c) =>
        new URL(c.url).pathname === "/api/v1/anilist/list-entry"
      )!;
      const body = await requestBody(postCall);
      assertEquals(body.progress, 0, "every flip resets progress to 0");
      assertEquals(body.status, "CURRENT");
      assertEquals(body.score, 0);
    },
  );
});

// ---------------------------------------------------------------------------
// Hostile / malformed AniList payloads
// ---------------------------------------------------------------------------

Deno.test("pin: a non-array truthy `lists` (hostile response) throws an unmapped TypeError from .find()", async () => {
  const hostile = { data: { MediaListCollection: { lists: "not-an-array" } } };
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json(hostile)],
    async () => {
      await assertRejects(
        () => run("sync-planning-rules", {}, ctx),
        TypeError,
      );
    },
  );
});

Deno.test("a response missing MediaListCollection entirely falls back to the top-level `lists` key", async () => {
  const topLevel = {
    data: {
      lists: [
        {
          status: "PLANNING",
          entries: [{ media: media(300071, "RELEASING", "Fixture Mu") }],
        },
      ],
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") return json(topLevel);
      return json({ data: { success: true } });
    }],
    async () => {
      await run("set-planning-watching", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "statusChangeResult")!;
  assertEquals(
    (res.payload.updated as Array<{ mediaId: number }>).map((u) => u.mediaId),
    [300071],
  );
});

Deno.test("malformed media (null) makes mediaId falsy -> entry is silently skipped (not in created/skipped/failed)", async () => {
  const collection = collectionOf([
    null,
    media(300081, "RELEASING", "Fixture Nu"),
  ]);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      return json({ data: { success: true } });
    }],
    async () => {
      await run("sync-planning-rules", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  const total = (res.payload.created as unknown[]).length +
    (res.payload.skipped as unknown[]).length +
    (res.payload.failed as unknown[]).length;
  assertEquals(total, 1, "the null-media entry contributes to no partition");
  assertEquals(
    (res.payload.created as Array<{ mediaId: number }>)[0].mediaId,
    300081,
  );
});

Deno.test("malformed media with no title at all falls back to the literal title 'Unknown' and is still processed", async () => {
  const collection = collectionOf([{ id: 300091, status: "RELEASING" }]);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      return json({ data: { success: true } });
    }],
    async () => {
      await run("sync-planning-rules", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  const created = res.payload.created as Array<
    { mediaId: number; title: string; destination: string }
  >;
  assertEquals(created, [
    { mediaId: 300091, title: "Unknown", destination: "/anime/tv/Unknown" },
  ]);
});

// ---------------------------------------------------------------------------
// Title path-traversal into the destination path
// ---------------------------------------------------------------------------

Deno.test("pin: a title of '..' survives the sanitizer untouched and traverses the destination path", async () => {
  // title.replace(/[/:*?\"<>|]/g, \"\") strips slashes/quotes/wildcards but
  // NOT dots — a title of exactly \"..\" (no forbidden characters) passes
  // through unchanged, so `${libraryPath}/${title}` becomes a traversal
  // segment. Documented gap, not fixed here (seanime.ts is unmodified).
  const collection = collectionOf([media(300101, "RELEASING", "..")]);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      return json({ data: { success: true } });
    }],
    async () => {
      await run("sync-planning-rules", { libraryPath: "/anime/tv" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  const created = res.payload.created as Array<{ destination: string }>;
  assertEquals(created[0].destination, "/anime/tv/..");
});

// ---------------------------------------------------------------------------
// Duplicate mediaId — existingMediaIds is a pre-loop snapshot, not updated
// in-loop, so a single run with a repeated mediaId double-POSTs
// ---------------------------------------------------------------------------

Deno.test("pin: duplicate mediaId within a single run is NOT deduped — two identical entries both POST", async () => {
  const collection = collectionOf([
    media(300111, "RELEASING", "Fixture Xi"),
    media(300111, "RELEASING", "Fixture Xi"),
  ]);
  let ruleCreates = 0;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      if (url.pathname === "/api/v1/auto-downloader/rule") {
        ruleCreates++;
        return json({ data: { success: true } });
      }
      return undefined;
    }],
    async () => {
      await run("sync-planning-rules", {}, ctx);
    },
  );
  assertEquals(ruleCreates, 2, "no in-loop dedup — two independent POSTs");
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  assertEquals((res.payload.created as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// Server-echoed token persisted into WRITTEN failed[].error (bulk methods)
// ---------------------------------------------------------------------------

Deno.test("pin: a failing per-entry POST whose body echoes a sentinel token lands that token in the WRITTEN failed[].error", async () => {
  const SENTINEL = "sntl_bulk_echo_do_not_log_9876543210";
  const collection = collectionOf([
    media(300121, "RELEASING", "Fixture Omicron"),
  ]);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      if (url.pathname === "/api/v1/auto-downloader/rule") {
        return new Response(`rejected: token ${SENTINEL} already used`, {
          status: 409,
        });
      }
      return undefined;
    }],
    async () => {
      await run("sync-planning-rules", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  const failed = res.payload.failed as Array<{ error: string }>;
  assertEquals(failed.length, 1);
  assert(
    failed[0].error.includes(SENTINEL),
    "the server-echoed token must surface verbatim in the persisted failed[].error (no redaction)",
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — seanime-specific patterns + poisoned sanity backstop
// ---------------------------------------------------------------------------

/** Count of DISTINCT characters in a string — a cheap proxy for entropy that
 * cleanly tells a real random-looking secret (near-full alphabet usage) apart
 * from a repeated-character placeholder like our torrent-hash fixture's
 * 40 lowercase 'a's (1 distinct character), without pulling in a real
 * Shannon-entropy library for a test-only heuristic. */
function distinctCharCount(s: string): number {
  return new Set(s).size;
}

const SECRET_PATTERNS: Array<{ name: string; test: (s: string) => boolean }> = [
  { name: "vault key name TOKEN", test: (s) => /\bTOKEN\b/.test(s) },
  // Seanime's X-Seanime-Token is documented as a server-password HASH — a
  // 64-hex-character SHA-256-shaped string.
  {
    name: "X-Seanime-Token hash shape (64 hex chars)",
    test: (s) => /^[a-f0-9]{64}$/i.test(s),
  },
  // Generic high-entropy blob: 32+ alnum/base64url characters with no
  // separators AND meaningful character diversity (>=10 distinct chars) —
  // this second condition is what lets the torrent-hash fixture's 40
  // repeated 'a' characters (1 distinct char, a deliberate low-entropy
  // placeholder) pass cleanly while still catching anything shaped like a
  // real random token or hash.
  {
    name: "high-entropy token-shaped value",
    test: (s) =>
      /^[A-Za-z0-9+/_=-]{32,}$/.test(s) && distinctCharCount(s) >= 10,
  },
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

const FIXTURES: Record<string, unknown> = {
  "status.json": status,
  "library-collection.json": libraryCollection,
  "missing-episodes.json": missingEpisodes,
  "torrent-list.json": torrentList,
  "anilist-collection.json": anilistCollection,
  "auto-downloader-rules.json": autoDownloaderRules,
  "list-entry.json": listEntry,
  "error.json": errorFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, test } of SECRET_PATTERNS) {
        if (test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
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

Deno.test("fixtures-secret-scan: sanity — each of the three patterns is independently proven to fire (not just aggregate non-emptiness)", () => {
  // Security/adversarial review finding (code-review round): a prior version
  // of this backstop only proved the vault-key and high-entropy patterns
  // fired, never the 64-hex X-Seanime-Token-hash-shape pattern specifically
  // (its poison value was 32 hex chars, not 64). Assert each pattern against
  // its own tailored poison value so a broken pattern cannot hide behind the
  // other two.
  const perPatternPoison: Record<string, string> = {
    "vault key name TOKEN": "TOKEN=abc123",
    "X-Seanime-Token hash shape (64 hex chars)": "a1b2c3d4e5f60718".repeat(4),
    "high-entropy token-shaped value": "aB3xQ9zL2mK7pR4nT6wY1cV8sD5fH0gJ",
  };
  for (const { name, test } of SECRET_PATTERNS) {
    const poison = perPatternPoison[name];
    assert(poison, `no tailored poison value defined for pattern "${name}"`);
    assert(
      test(poison),
      `pattern "${name}" failed to flag its own tailored poison value "${poison}"`,
    );
  }
});
