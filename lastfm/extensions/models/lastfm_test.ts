/**
 * Contract-fixture suite for @magistr/lastfm.
 *
 * Replays the committed fixture corpus under `../../fixtures/` through the
 * model's own methods (with `globalThis.fetch` stubbed to serve a fixture) so
 * that the anti-corruption layer — the zod boundary schemas plus the
 * normalizers — is pinned against the *documented response shapes* rather than
 * against inline strings invented at the point of assertion. A drift in the
 * corpus is therefore visible in a diff, not buried in a test body.
 *
 * Fixtures are pure doc-derived synthetic data. **No live call was made and no
 * vault credential was read to produce them** — see `fixtures/PROVENANCE.md`
 * for the standing prohibition. `lastfm.ts` is BYTE-FROZEN by this suite: every
 * assertion characterizes already-shipped behavior.
 *
 * The Last.fm credential travels in the *request* query string, never in a
 * response body, so this corpus has no credential surface by construction. The
 * mechanical scan at the bottom is a backstop for that invariant, not the
 * primary control.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./lastfm.ts";

const FIXTURES = new URL("../../fixtures/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(new URL(name, FIXTURES)));
}

const KEY = "0123456789abcdef0123456789abcdef";
const GLOBAL_ARGS = { user: "fixtureuser", apiKey: KEY, minIntervalMs: 0 };

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
      logger: { info: () => {}, warning: () => {}, error: () => {} },
    },
  };
}

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

/** Serve one fixture body for every request made during `fn`. */
async function serving(body: unknown, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// user.getInfo — stringified counts, registered.unixtime, image[]
// ---------------------------------------------------------------------------

Deno.test("contract: user-getinfo.json — counts arrive as strings and become numbers", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("user-getinfo.json"), async () => {
    await run("profile", {}, ctx);
  });
  const p = written[0].payload;
  assertEquals(written[0].spec, "profile");
  assertEquals(p.user, "fixtureuser");
  assertEquals(p.playcount, 4212);
  assertEquals(p.artistCount, 310);
  assertEquals(p.albumCount, 455);
  assertEquals(p.trackCount, 1180);
  assertEquals(p.country, "Netherlands");
});

Deno.test("contract: user-getinfo.json — registered.unixtime becomes an ISO instant", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("user-getinfo.json"), async () => {
    await run("profile", {}, ctx);
  });
  assertEquals(
    written[0].payload.registeredAt,
    new Date(1173116542 * 1000).toISOString(),
  );
});

Deno.test("contract: user-getinfo.json — image[] keeps size and maps #text to url", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("user-getinfo.json"), async () => {
    await run("profile", {}, ctx);
  });
  const images = written[0].payload.images as Array<
    { size?: string; url?: string }
  >;
  assertEquals(images.length, 4);
  assertEquals(images[0], {
    size: "small",
    url: "https://lastfm.example/i/small.png",
  });
});

// ---------------------------------------------------------------------------
// user.getRecentTracks — the shapes that make the ACL necessary
// ---------------------------------------------------------------------------

Deno.test("contract: recent-tracks.json — 4 track entries yield 3 scrobbles; now-playing is excluded", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("recent-tracks.json"), async () => {
    await run("sync-history", {}, ctx);
  });
  const rows = written
    .filter((w) => w.spec === "scrobbles")
    .flatMap((w) => (w.payload.scrobbles as Array<{ track: string }>) ?? []);
  assertEquals(
    rows.length,
    3,
    "the now-playing entry must not become a scrobble",
  );
  assert(
    !rows.some((r) => r.track === "Third Track"),
    "the now-playing track must be absent from history",
  );

  const history = written.find((w) => w.spec === "history");
  assertEquals(
    (history?.payload.nowPlaying as { track?: string } | undefined)?.track,
    "Third Track",
    "the now-playing track must be surfaced separately",
  );
});

Deno.test("contract: recent-tracks.json — a year boundary inside one page splits the partitions", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("recent-tracks.json"), async () => {
    await run("sync-history", {}, ctx);
  });
  const names = written
    .filter((w) => w.spec === "scrobbles")
    .map((w) => w.name)
    .sort();
  assertEquals(names, ["scrobbles.2007", "scrobbles.2008"]);
});

Deno.test("contract: recent-tracks.json — an empty-string mbid normalizes to absent", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("recent-tracks.json"), async () => {
    await run("sync-history", {}, ctx);
  });
  const rows = written
    .filter((w) => w.spec === "scrobbles")
    .flatMap((w) =>
      (w.payload.scrobbles as Array<
        { track: string; artistMbid?: string; album?: string }
      >) ?? []
    );
  const second = rows.find((r) => r.track === "Second Track");
  assert(second, "Second Track must be present");
  assertEquals(second.artistMbid, undefined, '"" mbid must become absent');
  assertEquals(second.album, undefined, '"" album must become absent');

  const opening = rows.find((r) => r.track === "Opening Track");
  assertEquals(opening?.artistMbid, "00000000-0000-4000-8000-000000000001");
});

Deno.test("contract: recent-tracks-single.json — a lone track arrives as an object, not an array", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("recent-tracks-single.json"), async () => {
    await run("sync-history", {}, ctx);
  });
  const rows = written
    .filter((w) => w.spec === "scrobbles")
    .flatMap((w) => (w.payload.scrobbles as unknown[]) ?? []);
  assertEquals(rows.length, 1);
});

Deno.test("contract: recent-tracks-empty.json — empty history writes no chunk but records state", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("recent-tracks-empty.json"), async () => {
    await run("sync-history", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "scrobbles").length, 0);
  const history = written.find((w) => w.spec === "history");
  assert(history, "state is recorded even with nothing to store");
  assertEquals(history.payload.added, 0);
});

// ---------------------------------------------------------------------------
// Charts and lookups
// ---------------------------------------------------------------------------

Deno.test("contract: top-artists.json — rank and playcount survive as numbers", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("top-artists.json"), async () => {
    await run("top-artists", { period: "7day" }, ctx);
  });
  const entries = written[0].payload.entries as Array<{
    rank?: number;
    name: string;
    artist?: string;
    playcount?: number;
    mbid?: string;
    url?: string;
  }>;
  assertEquals(written[0].payload.kind, "artists");
  assertEquals(entries[0], {
    rank: 1,
    name: "Testband",
    artist: undefined,
    playcount: 412,
    mbid: "00000000-0000-4000-8000-000000000001",
    url: "https://lastfm.example/music/Testband",
  });
  assertEquals(entries[1].mbid, undefined, '"" mbid normalizes to absent');
});

Deno.test("contract: top-albums.json — the nested artist.name is lifted", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("top-albums.json"), async () => {
    await run("top-albums", {}, ctx);
  });
  const entries = written[0].payload.entries as Array<
    { name: string; artist?: string }
  >;
  assertEquals(written[0].payload.kind, "albums");
  assertEquals(entries[0].name, "First Album");
  assertEquals(entries[0].artist, "Testband");
});

Deno.test("contract: top-tracks.json — the nested artist.name is lifted", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("top-tracks.json"), async () => {
    await run("top-tracks", {}, ctx);
  });
  const entries = written[0].payload.entries as Array<
    { name: string; artist?: string }
  >;
  assertEquals(written[0].payload.kind, "tracks");
  assertEquals(entries[0].artist, "Testband");
});

Deno.test("contract: loved-tracks.json — total and lovedAt are numbers", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("loved-tracks.json"), async () => {
    await run("loved-tracks", {}, ctx);
  });
  const p = written[0].payload;
  assertEquals(written[0].spec, "loved");
  assertEquals(p.total, 2);
  const tracks = p.tracks as Array<{ name: string; lovedAt?: number }>;
  assertEquals(tracks[0].lovedAt, 1199300000);
});

Deno.test("contract: weekly-chart-list.json — ranges become numeric from/to pairs", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("weekly-chart-list.json"), async () => {
    await run("weekly-chart-list", {}, ctx);
  });
  const ranges = written[0].payload.ranges as Array<
    { from: number; to: number }
  >;
  assertEquals(written[0].spec, "weekly");
  assertEquals(ranges.length, 3);
  assertEquals(ranges[0], { from: 1108296000, to: 1108900800 });
});

Deno.test("contract: artist-info.json — stats, tags and the wiki summary are lifted", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("artist-info.json"), async () => {
    await run("artist-info", { artist: "Testband" }, ctx);
  });
  const p = written[0].payload;
  assertEquals(written[0].spec, "entity");
  assertEquals(p.kind, "artist");
  assertEquals(p.listeners, 1204);
  assertEquals(p.playcount, 9931);
  assertEquals(p.userPlaycount, 412);
  assertEquals(p.tags, ["dungeon synth", "ambient"]);
  assert(String(p.summary).startsWith("Testband is a synthetic artist"));
});

Deno.test("contract: album-info.json — top-level userplaycount is lifted", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("album-info.json"), async () => {
    await run("album-info", { artist: "Testband", album: "First Album" }, ctx);
  });
  const p = written[0].payload;
  assertEquals(p.kind, "album");
  assertEquals(p.artist, "Testband");
  assertEquals(p.userPlaycount, 230);
});

Deno.test("contract: track-info.json — the nested artist.name and toptags are lifted", async () => {
  const { ctx, written } = makeCtx();
  await serving(await fixture("track-info.json"), async () => {
    await run(
      "track-info",
      { artist: "Testband", track: "Opening Track" },
      ctx,
    );
  });
  const p = written[0].payload;
  assertEquals(p.kind, "track");
  assertEquals(p.artist, "Testband");
  assertEquals(p.userPlaycount, 188);
  assertEquals(p.tags, ["ambient"]);
});

// ---------------------------------------------------------------------------
// The error protocol — HTTP 200 carrying {error, message}
// ---------------------------------------------------------------------------

for (
  const [file, code] of [
    ["error-6.json", 6],
    ["error-10.json", 10],
    ["error-26.json", 26],
  ] as const
) {
  Deno.test(`contract: ${file} — permanent code ${code} surfaces with its code and message`, async () => {
    const { ctx } = makeCtx();
    const body = await fixture(file) as { message: string };
    await serving(body, async () => {
      const err = await assertRejects(
        () => run("profile", {}, ctx) as Promise<unknown>,
      );
      const text = String(err);
      assert(text.includes(String(code)), `code missing from: ${text}`);
      assert(!text.includes(KEY), "api_key must never reach the error");
    });
  });
}

Deno.test("contract: error-29.json — the rate-limit code is classified transient and retried", async () => {
  const body = await fixture("error-29.json");
  // Tiny backoff so the retry path is exercised without slowing the suite.
  const ctx = {
    ...makeCtx().ctx,
    globalArgs: { ...GLOBAL_ARGS, maxRetries: 2, retryBaseMs: 1 },
  };
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    await assertRejects(() => run("profile", {}, ctx) as Promise<unknown>);
    assert(calls > 1, `code 29 must be retried, saw ${calls} call(s)`);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Mechanical backstop over the corpus itself
// ---------------------------------------------------------------------------

Deno.test("contract: no fixture contains a secret-shaped value or a real Last.fm host", async () => {
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(FIXTURES)) {
    if (!entry.isFile) continue;
    const text = await Deno.readTextFile(new URL(entry.name, FIXTURES));
    // A 32-hex run is the shape of a Last.fm api_key / api_sig.
    for (const hit of text.match(/\b[0-9a-f]{32}\b/g) ?? []) {
      offenders.push(`${entry.name}: secret-shaped ${hit.slice(0, 6)}…`);
    }
    for (const param of ["api_key=", "api_sig=", "&sk="]) {
      if (text.includes(param)) {
        offenders.push(`${entry.name}: contains ${param}`);
      }
    }
    // Guard the real hosts in URL POSITION only. Last.fm's own documented
    // error strings say "granted a valid key by last.fm" as brand prose, and
    // error-10.json quotes that message verbatim on purpose — a bare substring
    // match would reject the very text the fixture exists to pin.
    if (entry.name.endsWith(".json")) {
      for (const host of ["last.fm", "ws.audioscrobbler.com"]) {
        if (
          new RegExp(`//(?:[\\w.-]*\\.)?${host.replace(".", "\\.")}`).test(text)
        ) {
          offenders.push(`${entry.name}: real host ${host} in a URL`);
        }
      }
    }
  }
  assertEquals(
    offenders,
    [],
    `fixture corpus must stay synthetic:\n${offenders.join("\n")}`,
  );
});
