/**
 * Methods suite for @magistr/tmdb: every method's success and failure path
 * with fetch stubbed and a fake context.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./tmdb.ts";
import {
  fakeContext,
  fixture,
  json,
  stubFetch,
  TOKEN,
} from "./tmdb_test_helpers.ts";

const isPath = (p: string) => (u: URL) => u.pathname === `/3${p}`;
const routes = () =>
  [
    [isPath("/search/movie"), () => json(fixture("search-movie.json"))],
    [isPath("/search/tv"), () => json(fixture("search-tv.json"))],
    [isPath("/movie/13"), () => json(fixture("movie-13.json"))],
    [isPath("/tv/19885"), () => json(fixture("tv-19885.json"))],
  ] as Parameters<typeof stubFetch>[0];

Deno.test("search writes a scored search resource", async () => {
  const s = stubFetch(routes());
  try {
    const { context, writes } = fakeContext({ apiToken: TOKEN });
    await model.methods.search.execute(
      { query: "Forrest Gump", year: 1994, mediaType: "movie" },
      context,
    );
    assertEquals(writes[0].spec, "search");
    const r = writes[0].data.results as { id: number; score: number }[];
    assertEquals(r[0].id, 13);
    assertEquals(s.calls[0].url.searchParams.get("year"), "1994");
    assertEquals(s.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  } finally {
    s.restore();
  }
});

Deno.test("details writes title resource keyed kind-id", async () => {
  const s = stubFetch(routes());
  try {
    const { context, writes } = fakeContext({ apiToken: TOKEN });
    await model.methods.details.execute({ id: 19885, kind: "tv" }, context);
    assertEquals(writes[0].name, "tv-19885");
    assertEquals(
      s.calls[0].url.searchParams.get("append_to_response"),
      "credits,keywords,external_ids,content_ratings",
    );
  } finally {
    s.restore();
  }
});

Deno.test("match resolves, reuses the cache, and pins", async () => {
  const s = stubFetch(routes());
  try {
    const { context, writes } = fakeContext({ apiToken: TOKEN });
    const items = [
      {
        key: "a",
        title: "Forrest Gump",
        altTitles: [],
        year: 1994,
        kind: "movie" as const,
      },
      {
        key: "b",
        title: "Whatever",
        altTitles: [],
        year: null,
        kind: "movie" as const,
        tmdbId: 13,
      },
    ];
    await model.methods.match.execute(
      {
        items,
        name: "m",
        ttlDays: 30,
        refresh: false,
        refreshKeys: [],
        maxQueries: 0,
        minScore: 0.72,
        details: false,
        prune: false,
      },
      context,
    );
    const first = writes[0].data as {
      entries: { key: string; status: string; tmdbId: number }[];
      stats: { requests: number };
    };
    assertEquals(first.entries.map((e) => [e.key, e.status, e.tmdbId]), [
      ["a", "matched", 13],
      ["b", "pinned", 13],
    ]);
    const before = s.calls.length;
    await model.methods.match.execute(
      {
        items,
        name: "m",
        ttlDays: 30,
        refresh: false,
        refreshKeys: [],
        maxQueries: 0,
        minScore: 0.72,
        details: false,
        prune: false,
      },
      context,
    );
    assertEquals(s.calls.length, before, "converged re-run makes no requests");
    assertEquals((writes[1].data.stats as { reused: number }).reused, 2);
  } finally {
    s.restore();
  }
});

Deno.test("match: maxQueries leaves the rest pending", async () => {
  const s = stubFetch(routes());
  try {
    const { context, writes } = fakeContext({ apiToken: TOKEN });
    const items = ["x", "y", "z"].map((k) => ({
      key: k,
      title: "Forrest Gump",
      altTitles: [],
      year: 1994,
      kind: "movie" as const,
    }));
    await model.methods.match.execute(
      {
        items,
        name: "m",
        ttlDays: 30,
        refresh: false,
        refreshKeys: [],
        maxQueries: 1,
        minScore: 0.72,
        details: false,
        prune: false,
      },
      context,
    );
    const d = writes[0].data as { pending: string[]; stopReason: string };
    assertEquals(d.stopReason, "maxQueries");
    assertEquals(d.pending, ["y", "z"]);
  } finally {
    s.restore();
  }
});

Deno.test("match: 401 aborts the run instead of recording errors", async () => {
  const s = stubFetch([[
    () => true,
    () => json(fixture("error-401.json"), 401),
  ]]);
  try {
    const { context } = fakeContext({ apiToken: TOKEN });
    await assertRejects(
      () =>
        model.methods.match.execute(
          {
            items: [{ key: "a", title: "X", altTitles: [], kind: "movie" }],
            name: "m",
            ttlDays: 30,
            refresh: false,
            refreshKeys: [],
            maxQueries: 0,
            minScore: 0.72,
            details: false,
            prune: false,
          },
          context,
        ),
      Error,
      "401",
    );
  } finally {
    s.restore();
  }
});

Deno.test("match: a 404 on one item is an error entry, not a failure", async () => {
  const s = stubFetch([[
    () => true,
    () => json(fixture("error-404.json"), 404),
  ]]);
  try {
    const { context, writes } = fakeContext({ apiToken: TOKEN });
    await model.methods.match.execute(
      {
        items: [{ key: "a", title: "X", altTitles: [], kind: "movie" }],
        name: "m",
        ttlDays: 30,
        refresh: false,
        refreshKeys: [],
        maxQueries: 0,
        minScore: 0.72,
        details: false,
        prune: false,
      },
      context,
    );
    const e =
      (writes[0].data.entries as { status: string; error: string }[])[0];
    assertEquals(e.status, "error");
  } finally {
    s.restore();
  }
});

Deno.test("enrich fetches once, then reuses within TTL", async () => {
  const s = stubFetch(routes());
  try {
    const { context, writes } = fakeContext({ apiToken: TOKEN });
    const args = {
      ids: [{ id: 13, kind: "movie" as const }, {
        id: 19885,
        kind: "tv" as const,
      }, { id: 13, kind: "movie" as const }],
      name: "t",
      ttlDays: 90,
      refresh: false,
      maxRequests: 0,
      prune: false,
    };
    await model.methods.enrich.execute(args, context);
    const t1 = writes[0].data as {
      titles: Record<string, { title: string }>;
      stats: { fetched: number };
    };
    assertEquals(Object.keys(t1.titles).sort(), ["movie:13", "tv:19885"]);
    assertEquals(t1.stats.fetched, 2);
    const n = s.calls.length;
    await model.methods.enrich.execute(args, context);
    assertEquals(s.calls.length, n);
    assertEquals((writes[1].data.stats as { reused: number }).reused, 2);
  } finally {
    s.restore();
  }
});
