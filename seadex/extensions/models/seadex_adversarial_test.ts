/**
 * Adversarial suite: attacker's-perspective tests over the two upstream
 * contracts (hostile Pocketbase torrent payloads, AniList error-swallowing),
 * fan-out partial failure vs the UN-isolated write phase, infoHash/tracker
 * field passthrough, and a mechanical fixtures-secret-scan.
 *
 * seadex.ts is UNMODIFIED — every test here PINS current behavior (including
 * behavior that is arguably risky). Where a test documents a real gap, it is
 * labeled "PIN" and says so explicitly; none of these are fixed here.
 *
 * HARNESS-FIDELITY NOTE (read before the BUG-6/BUG-3 tests below): the fake
 * `writeResource` in this file's `makeCtx()` does NOT validate against
 * `SeadexResultSchema` the way the real swamp runtime does. A hostile
 * Pocketbase file whose `length` arrives as a STRING (BUG-6) turns
 * `totalSizeBytes` into a string via `0 + "999"` JS coercion — the fake
 * writeResource happily captures that string, which would make the bug look
 * harmless. In the REAL runtime, the `entry` resource's schema
 * (`TorrentEntrySchema.totalSizeBytes: z.number()`) REJECTS that write — and
 * because `lookup-many`'s entry-writing loop runs OUTSIDE the per-item
 * try/catch, that rejection discards the ENTIRE batch (BUG-3). These are
 * pinned as two SEPARATE tests below: BUG-6 with the benign fake
 * writeResource (showing the raw type-confused value), and BUG-3 with an
 * EXPLICIT poisoned writeResource that manually rejects (since the fake
 * harness cannot reproduce real zod rejection). Do not lean on BUG-6 to
 * demonstrate the write failure — they are different observations.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./seadex.ts";
import pocketbaseEntry from "../../fixtures/pocketbase-entry.json" with {
  type: "json",
};
import pocketbaseEmpty from "../../fixtures/pocketbase-empty.json" with {
  type: "json",
};
import anilistMedia from "../../fixtures/anilist-media.json" with {
  type: "json",
};
import anilistNomatch from "../../fixtures/anilist-nomatch.json" with {
  type: "json",
};
import anilistGraphqlError from "../../fixtures/anilist-graphql-error.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "https://releases.moe",
  userAgent: "swamp-seadex-adversarial/1.0",
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
    },
  };
}

/** A context whose writeResource REJECTS for one specific (spec,name) pair —
 * simulating the REAL runtime's schema-validation rejection (which the fake
 * harness above cannot reproduce, since it never validates). Used ONLY to pin
 * BUG-3 (the un-isolated write phase), never to demonstrate BUG-6. */
function makePoisonedCtx(poisonSpec: string, poisonName: string) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      writeResource: (spec: string, name: string, payload: unknown) => {
        if (spec === poisonSpec && name === poisonName) {
          return Promise.reject(
            new Error(
              `simulated schema rejection: ${spec}/${name} failed validation`,
            ),
          );
        }
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
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

function pocketbaseRoute(body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.pathname === "/api/collections/entries/records"
      ? json(body, status)
      : undefined;
  };
}

function pocketbaseTextRoute(text: string, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.pathname === "/api/collections/entries/records"
      ? new Response(text, { status })
      : undefined;
  };
}

function anilistRoute(body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.hostname === "graphql.anilist.co"
      ? json(body, status)
      : undefined;
  };
}

function clonePocketbaseEntry(): typeof pocketbaseEntry {
  return JSON.parse(JSON.stringify(pocketbaseEntry));
}

// ---------------------------------------------------------------------------
// AniList HTTP-200-with-errors — swallowed and INDISTINGUISHABLE from no-match
// ---------------------------------------------------------------------------

Deno.test("PIN: an AniList HTTP-200-with-{errors,data:null} response is SWALLOWED — a caller sees the EXACT same outcome as a legitimate no-match, with no way to tell 'AniList errored' from 'no such anime'", async () => {
  const { ctx: errCtx, written: errWritten } = makeCtx();
  await withFetchStub([anilistRoute(anilistGraphqlError, 200)], async () => {
    await run("lookup-by-title", { title: "Errored Search" }, errCtx);
  });

  const { ctx: nomatchCtx, written: nomatchWritten } = makeCtx();
  await withFetchStub([anilistRoute(anilistNomatch, 200)], async () => {
    await run("lookup-by-title", { title: "Errored Search" }, nomatchCtx);
  });

  const errRes = errWritten.find((w) => w.name === "q-errored-search")!;
  const nomatchRes = nomatchWritten.find((w) => w.name === "q-errored-search")!;
  assert(errRes && nomatchRes);
  assertEquals(errRes.payload.found, false);
  assertEquals(errRes.payload.alID, 0);
  const { timestamp: _errTs, ...errRest } = errRes.payload;
  const { timestamp: _nomatchTs, ...nomatchRest } = nomatchRes.payload;
  assertEquals(
    errRest,
    nomatchRest,
    "the two outcomes are identical apart from the timestamp — anilistFindIdByTitle only ever inspects data.data?.Media and never looks at the errors[] array, so a GraphQL-level failure is silently treated as a legitimate no-match",
  );
});

Deno.test("PIN: an AniList Media object with NO `title` key at all (not merely empty) crashes with an uncaught TypeError — `m.title.english` dereferences `m.title` before the `??` fallback chain ever runs", async () => {
  const { ctx } = makeCtx();
  const mediaNoTitleAtAll = { data: { Media: { id: 123 } } };
  await withFetchStub([anilistRoute(mediaNoTitleAtAll)], async () => {
    const err = await assertRejects(
      () => run("lookup-by-title", { title: "Whatever" }, ctx),
      TypeError,
    );
    assert(
      (err as Error).message.includes("english"),
      `expected the \`m.title.english\` dereference to be the TypeError's cause, got: ${
        (err as Error).message
      }`,
    );
  });
});

Deno.test("PIN: a Pocketbase response with NO `items` key at all (not merely empty []) crashes with an uncaught TypeError — the SYMMETRIC Pocketbase-side parallel of the AniList title-absent crash above — `data.items[0]` dereferences `data.items` before the `?? null` fallback ever runs", async () => {
  const { ctx } = makeCtx();
  // A hostile/malformed Pocketbase list envelope missing `items` entirely.
  const noItemsKey = { page: 1, perPage: 30, totalItems: 0, totalPages: 0 };
  await withFetchStub([pocketbaseRoute(noItemsKey)], async () => {
    const err = await assertRejects(
      () => run("lookup-by-anilist-id", { anilistId: 70 }, ctx),
      TypeError,
    );
    assert(
      (err as Error).message.includes("items") ||
        (err as Error).message.includes("0"),
      `expected the \`data.items[0]\` dereference to be the TypeError's cause, got: ${
        (err as Error).message
      }`,
    );
  });
});

Deno.test("PIN: a 200-OK response with a non-JSON body crashes with an uncaught SyntaxError, on BOTH upstream contracts — resp.ok is checked before .json() is ever called, so a WAF/CDN error page served at HTTP 200 is NOT mapped into the 'fetch <url> →' / 'anilist search failed' error messages the contract suite pins for actual HTTP failures", async () => {
  const { ctx: pbCtx } = makeCtx();
  await withFetchStub(
    [pocketbaseTextRoute("<html>not json</html>", 200)],
    async () => {
      await assertRejects(
        () => run("lookup-by-anilist-id", { anilistId: 71 }, pbCtx),
        SyntaxError,
      );
    },
  );

  const { ctx: alCtx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      return url.hostname === "graphql.anilist.co"
        ? new Response("<html>not json</html>", { status: 200 })
        : undefined;
    }],
    async () => {
      await assertRejects(
        () => run("lookup-by-title", { title: "Whatever" }, alCtx),
        SyntaxError,
      );
    },
  );
});

Deno.test("PIN: a malformed `expand.trs` array element (e.g. `null`) crashes with an uncaught TypeError — symmetric to the items-absent/title-absent crashes above, normaliseTorrent assumes every trs[] entry is an object", async () => {
  const { ctx } = makeCtx();
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 72;
  // deno-lint-ignore no-explicit-any
  hostile.items[0].expand!.trs = [null as any];
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await assertRejects(
      () => run("lookup-by-anilist-id", { anilistId: 72 }, ctx),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// BUG-3 (pinned separately, with an EXPLICIT poisoned writeResource): the
// entry-writing loop in lookup-many runs OUTSIDE the per-item try/catch
// ---------------------------------------------------------------------------

Deno.test("PIN (BUG-3): the entry writeResource loop runs OUTSIDE the per-item try/catch — one write rejecting discards the WHOLE lookup-many call, and NO summary resource is ever written", async () => {
  const { ctx, written } = makePoisonedCtx("entry", "al-2");
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await assertRejects(
      () =>
        run("lookup-many", {
          items: [{ anilistId: 1 }, { anilistId: 2 }, { anilistId: 3 }],
        }, ctx),
      Error,
      "simulated schema rejection",
    );
  });
  assertEquals(
    written.find((w) => w.spec === "summary"),
    undefined,
    "the summary write happens AFTER the entries loop — it is never reached once any entry write rejects",
  );
  assert(
    written.filter((w) => w.spec === "entry").length < 3,
    "at most the entries written before the poisoned key can have landed; the poisoned key and everything after it in loop order are lost",
  );
});

// ---------------------------------------------------------------------------
// BUG-6 (harness-fidelity pin, see the file header note): hostile file.length
// as a string -> totalSizeBytes string-concatenation
// ---------------------------------------------------------------------------

Deno.test("HARNESS-FIDELITY PIN (BUG-6): a hostile file.length arriving as a STRING turns totalSizeBytes into a STRING via '0 + \"999\"' coercion — captured as-is by this fake writeResource (see file header: the REAL runtime's z.number() would reject this, which is BUG-3's failure mode, not reproduced here)", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 50;
  hostile.items[0].expand!.trs = [{
    id: "tr_hostile",
    releaseGroup: "HostileGroup",
    tracker: "HostileTracker",
    url: "https://tracker.example/hostile",
    infoHash: "cccccccccccccccccccccccccccccccccccccccc",
    isBest: true,
    dualAudio: false,
    tags: ["1080p"],
    // deno-lint-ignore no-explicit-any
    files: [{ name: "hostile.mkv", length: "999" as any }],
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 50 }, ctx);
  });
  const res = written.find((w) => w.name === "al-50")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(
    best.totalSizeBytes,
    "0999",
    "reduce()'s initial value 0 (number) + '999' (string) coerces to string concatenation, not addition",
  );
  assert(
    typeof best.totalSizeBytes === "string",
    "confirms the type-confusion: totalSizeBytes is a STRING here, not the z.number() the schema declares",
  );
});

Deno.test("PIN: a hostile non-array `tags` field passes through verbatim (?? only guards null/undefined, not wrong-type truthy values)", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 51;
  hostile.items[0].expand!.trs = [{
    id: "tr_hostile2",
    releaseGroup: "HostileGroup",
    tracker: "HostileTracker",
    url: "https://tracker.example/hostile2",
    infoHash: "dddddddddddddddddddddddddddddddddddddddd",
    isBest: true,
    dualAudio: false,
    // deno-lint-ignore no-explicit-any
    tags: "not-an-array" as any,
    files: [],
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 51 }, ctx);
  });
  const res = written.find((w) => w.name === "al-51")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(
    best.tags,
    "not-an-array",
    "a truthy non-array `tags` value is NOT coerced to an array — `?? []` only substitutes for null/undefined",
  );
});

Deno.test("PIN: a torrent with files entirely absent -> totalSizeBytes 0, fileCount 0, primaryFile null (no crash)", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 52;
  const trs = hostile.items[0].expand!.trs![0];
  // deno-lint-ignore no-explicit-any
  delete (trs as any).files;
  hostile.items[0].expand!.trs = [trs];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 52 }, ctx);
  });
  const res = written.find((w) => w.name === "al-52")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(best.totalSizeBytes, 0);
  assertEquals(best.fileCount, 0);
  assertEquals(best.primaryFile, null);
});

// ---------------------------------------------------------------------------
// Duplicate input IDs — al-<id> resource key clobber, summary.total oblivious
// ---------------------------------------------------------------------------

Deno.test("PIN: duplicate anilistId within one lookup-many call writes the SAME al-<id> key TWICE — a real datastore write would clobber the first with the second — while summary.total counts both", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run(
      "lookup-many",
      { items: [{ anilistId: 77 }, { anilistId: 77 }] },
      ctx,
    );
  });
  const entryWrites = written.filter((w) =>
    w.spec === "entry" && w.name === "al-77"
  );
  assertEquals(
    entryWrites.length,
    2,
    "the fake harness records both calls distinctly — in the real datastore, writing the SAME resource key twice clobbers the first with the second",
  );
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(
    summary.payload.total,
    2,
    "summary.total counts array length, oblivious to the al-77 key collision",
  );
  assertEquals((summary.payload.notInSeadex as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// Error undercount — an errored item is indistinguishable from not-found
// ---------------------------------------------------------------------------

Deno.test("PIN: an errored lookup-many item is lumped into summary.notInSeadex identically to a legitimate not-found result — the summary schema has NO separate error tally", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.searchParams.get("filter") === "(alID=1)") {
        return new Response("boom", { status: 500 });
      }
      return json(pocketbaseEmpty);
    }],
    async () => {
      await run(
        "lookup-many",
        { items: [{ anilistId: 1 }, { anilistId: 2 }] },
        ctx,
      );
    },
  );
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 2);
  assertEquals(summary.payload.found, 0);
  const notInSeadex = summary.payload.notInSeadex as Array<{ alID: number }>;
  assertEquals(notInSeadex.map((n) => n.alID).sort((a, b) => a - b), [1, 2]);
  assert(
    !("errors" in summary.payload) && !("errorCount" in summary.payload),
    "the summary resource has no error-tally field of any kind — an errored item and a legitimately-not-found item are indistinguishable from this resource alone",
  );
});

// ---------------------------------------------------------------------------
// infoHash passthrough — no normalization of any kind
// ---------------------------------------------------------------------------

Deno.test("PIN: infoHash is passed through byte-for-byte verbatim — no lowercase/trim/length validation, even for whitespace-padded, uppercase, or wrong-length values", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 60;
  hostile.items[0].expand!.trs = [{
    id: "tr_hostile3",
    releaseGroup: "G",
    tracker: "T",
    url: "https://tracker.example/x",
    infoHash: "  AABBCCDDEEFF00112233445566778899AABBCC  ",
    isBest: true,
    dualAudio: false,
    tags: [],
    files: [],
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 60 }, ctx);
  });
  const res = written.find((w) => w.name === "al-60")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(
    best.infoHash,
    "  AABBCCDDEEFF00112233445566778899AABBCC  ",
    "verbatim passthrough — whitespace and case survive untouched, and the (wrong, 36-char-plus-padding) length is never validated",
  );
});

// ---------------------------------------------------------------------------
// Server-alID-vs-key divergence
// ---------------------------------------------------------------------------

Deno.test("PIN: a hostile Pocketbase response whose alID field DIVERGES from the requested filter — the resource KEY uses the REQUESTED id, content.alID uses the SERVER's divergent value", async () => {
  const divergent = clonePocketbaseEntry();
  divergent.items[0].alID = 999999;
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(divergent)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 1 }, ctx);
  });
  const res = written.find((w) => w.name === "al-1")!;
  assert(
    res,
    "the resource key is derived from the REQUESTED anilistId (args.anilistId), not the server's response",
  );
  assertEquals(
    res.payload.alID,
    999999,
    "content.alID uses buildResult's entry.alID branch (the server's value) once an entry is found — diverging from the al-1 key",
  );
  assertEquals(
    written.find((w) => w.name === "al-999999"),
    undefined,
    "no resource is ever written under the server's divergent id — the divergence is invisible unless you compare key vs content",
  );
});

// ---------------------------------------------------------------------------
// Trust boundary — hostile upstream content echoes verbatim, no redaction
// ---------------------------------------------------------------------------

Deno.test("PIN: hostile upstream `notes` content is stored VERBATIM — seadex is credential-less (no vault secret exists to leak), so this is a hostile-CONTENT trust-boundary concern, not a credential leak", async () => {
  const hostile = clonePocketbaseEntry();
  const SENTINEL = "internal-tracker-invite-code-9f8e7d6c5b4a";
  hostile.items[0].notes = `See invite thread — code: ${SENTINEL}`;
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 1 }, ctx);
  });
  const res = written.find((w) => w.name === "al-1")!;
  assert(
    (res.payload.notes as string).includes(SENTINEL),
    "seadex.ts performs NO redaction of upstream content — whatever releases.moe returns in `notes` is stored verbatim",
  );
});

Deno.test("PIN: a hostile Pocketbase error body is embedded verbatim (up to 200 chars) into the thrown error — no redaction", async () => {
  const SENTINEL = "leak-marker-4b3c2a1f9e8d7c6b5a4938271605f4e3";
  const { ctx } = makeCtx();
  await withFetchStub(
    [pocketbaseTextRoute(`upstream failure, ref=${SENTINEL}`, 502)],
    async () => {
      const err = await assertRejects(
        () => run("lookup-by-anilist-id", { anilistId: 1 }, ctx),
        Error,
      );
      assert(
        (err as Error).message.includes(SENTINEL),
        "the thrown error embeds the upstream response body verbatim, no redaction of any kind",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — seadex-specific patterns + per-pattern poisoned
// sanity backstop
// ---------------------------------------------------------------------------

/** Count of DISTINCT characters in a string — a cheap proxy for entropy that
 * cleanly tells a real random-looking secret/hash (near-full alphabet usage)
 * apart from a repeated-character placeholder like our infoHash fixtures'
 * 40 lowercase 'a's / 'b's (1 distinct character), without pulling in a real
 * Shannon-entropy library for a test-only heuristic. */
function distinctCharCount(s: string): number {
  return new Set(s).size;
}

const SECRET_PATTERNS: Array<{ name: string; test: (s: string) => boolean }> = [
  {
    name: "generic secret/credential keyword",
    test: (s) => /\b(SECRET|PASSWORD|API[_-]?KEY|BEARER)\b/i.test(s),
  },
  // A real-looking 40-hex SHA-1-shaped infoHash. Our own fixtures use 40
  // REPEATED characters ('a's / 'b's / 'c's / 'd's) as placeholders — 1
  // distinct character each — so the entropy escape (>= 10 distinct chars)
  // is required directly on THIS pattern (unlike a generic hash-shape check,
  // seadex's own committed fixtures are hex-shaped-and-40-chars-long by
  // design, so the pattern must actively distinguish real from placeholder).
  {
    name: "real-looking 40-hex infoHash",
    test: (s) => /^[a-f0-9]{40}$/i.test(s) && distinctCharCount(s) >= 10,
  },
  // Generic high-entropy blob backstop: 32+ alnum/base64url characters with
  // meaningful character diversity — catches anything token/secret-shaped
  // that doesn't match the two patterns above.
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

// SCOPE NOTE (security review, test-review round 1): this scan covers only
// the 5 committed fixture JSON files below — it does NOT scan this file's
// (or the other suites') own inline hostile-payload string literals (e.g.
// SENTINEL constants, inline infoHash placeholders). Those are reviewed
// manually; a future test author adding a new inline "realistic" secret-like
// literal is not caught by this mechanical gate. Prefer adding new hostile
// wire-shape corpora to fixtures/ (where this scan protects them) over
// inline literals when the value could plausibly resemble a real secret.
const FIXTURES: Record<string, unknown> = {
  "pocketbase-entry.json": pocketbaseEntry,
  "pocketbase-empty.json": pocketbaseEmpty,
  "anilist-media.json": anilistMedia,
  "anilist-nomatch.json": anilistNomatch,
  "anilist-graphql-error.json": anilistGraphqlError,
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

Deno.test("fixtures-secret-scan: the LOW-entropy infoHash placeholders (40 repeated chars) pass cleanly — the entropy escape works both ways", () => {
  const placeholders = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  for (const p of placeholders) {
    assertEquals(distinctCharCount(p), 1);
    for (const { name, test } of SECRET_PATTERNS) {
      assert(
        !test(p),
        `placeholder "${p}" incorrectly matched pattern "${name}"`,
      );
    }
  }
});

Deno.test("fixtures-secret-scan: sanity — each of the three patterns is independently proven to fire against its OWN tailored poison (not just aggregate non-emptiness)", () => {
  const perPatternPoison: Record<string, string> = {
    "generic secret/credential keyword": "API_KEY=abc123def456",
    "real-looking 40-hex infoHash": "1a2b3c4d5e6f78901a2b3c4d5e6f78901a2b3c4d",
    "high-entropy token-shaped value": "Qx7Lm2Zp9Kv4Tn6Wy1Cs8Dg5Fh0Jr3Ub",
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
