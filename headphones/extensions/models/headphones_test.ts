/**
 * Contract-fixture suite: pins the CONCRETE Headphones JSON API wire shape
 * from headphones/fixtures/*.json (+ error.html) directly — independent of
 * headphones.ts's resource schemas, several of which use `.passthrough()`.
 * A suite that only asserted "the written resource validates against the
 * model's own schema" would be toothless; this suite hardcodes the expected
 * shape derived from the Headphones API docs and (where the docs were silent
 * or ambiguous) the upstream `rembo10/headphones` Python source, so a real
 * wire-format drift turns a test red (see STANDARD.md's contract-fixture
 * role).
 *
 * All fixtures are PURE doc/source-derived synthetic data — see
 * fixtures/PROVENANCE.md. Every test here is offline: fixtures are fed
 * through a stubbed fetch, no network call is made. Toolchain rule: no
 * `as typeof <global-builtin>` casts — the fetch seam is installed via
 * `(globalThis as unknown as Record<string, unknown>).fetch`.
 *
 * get-artist/get-album's array-unwrap was FIXED by this change (see
 * `headphones-apikey-hardening`); the two tests below assert the corrected,
 * unwrapped shape. Every other test here is a characterization test pinning
 * the model's current, already-shipped behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./headphones.ts";
import getVersionFixture from "../../fixtures/getVersion.json" with {
  type: "json",
};
import getIndexFixture from "../../fixtures/getIndex.json" with {
  type: "json",
};
import getArtistFixture from "../../fixtures/getArtist.json" with {
  type: "json",
};
import getArtistLoadingFixture from "../../fixtures/getArtist.loading.json" with {
  type: "json",
};
import findArtistFixture from "../../fixtures/findArtist.json" with {
  type: "json",
};
import getAlbumFixture from "../../fixtures/getAlbum.json" with {
  type: "json",
};
import getWantedFixture from "../../fixtures/getWanted.json" with {
  type: "json",
};
import getHistoryFixture from "../../fixtures/getHistory.json" with {
  type: "json",
};
import getLogsFixture from "../../fixtures/getLogs.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  host: "http://headphones.example:8181",
  apiKey: "fixture-apikey-not-real-0000000000",
};

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

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

/** Install a fetch stub for the duration of `fn`. Cast-free seam per the
 * toolchain rule: no `as typeof globalThis.fetch`. */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  (globalThis as unknown as Record<string, unknown>).fetch = stub;
  try {
    await fn(calls);
  } finally {
    (globalThis as unknown as Record<string, unknown>).fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withOneJson(
  body: unknown,
  fn: (calls: Request[]) => Promise<unknown>,
) {
  return withFetchStub([() => json(body)], fn);
}

// ---------------------------------------------------------------------------
// getVersion.json contract — flat object envelope
// ---------------------------------------------------------------------------

Deno.test("contract: getVersion.json — flat object, all 5 documented keys pass through untouched", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(getVersionFixture, () => run("get-version", {}, ctx));
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.git_path, getVersionFixture.git_path);
  assertEquals(res.payload.install_type, getVersionFixture.install_type);
  assertEquals(res.payload.current_version, getVersionFixture.current_version);
  assertEquals(res.payload.latest_version, getVersionFixture.latest_version);
  assertEquals(res.payload.commits_behind, getVersionFixture.commits_behind);
  assertEquals(typeof res.payload.commits_behind, "number");
});

// ---------------------------------------------------------------------------
// getIndex.json contract — bare array envelope
// ---------------------------------------------------------------------------

Deno.test("contract: getIndex.json — bare array of artist rows, total == length, rows pass through", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(getIndexFixture, () => run("get-index", {}, ctx));
  const res = written.find((w) => w.spec === "artists")!;
  const artists = res.payload.artists as Array<Record<string, unknown>>;
  assertEquals(artists.length, getIndexFixture.length);
  assertEquals(res.payload.total, getIndexFixture.length);
  assertEquals(artists, getIndexFixture);
  for (const a of artists) {
    assertEquals(typeof a.ArtistID, "string");
    assertEquals(typeof a.ArtistName, "string");
  }
});

// ---------------------------------------------------------------------------
// getArtist.json contract — the REAL wire shape: `artist` is a
// single-element ARRAY, resolved from upstream source (see PROVENANCE.md);
// get-artist's non-unwrapping defect was fixed to unwrap it
// ---------------------------------------------------------------------------

Deno.test("contract: getArtist.json — the REAL Headphones wire shape has `artist` as a single-element ARRAY (not an object)", () => {
  // Ground truth per fixtures/PROVENANCE.md: headphones/api.py's _getArtist
  // builds `self.data = {'artist': artist, ...}` where `artist` comes
  // straight from `_dic_from_query(...)`, which always returns a list — no
  // `[0]` indexing anywhere in _getArtist. This fixture is authored to that
  // REAL shape, not a convenient object, per plan v2's round-1 HIGH fix.
  assert(
    Array.isArray(getArtistFixture.artist),
    "fixture must model reality: artist is an array on the wire",
  );
  assertEquals(getArtistFixture.artist.length, 1);
});

Deno.test("FIXED: get-artist unwraps the wire ARRAY into the single artist object, matching onboard-artists' existing precedent", async () => {
  // `execute` now does `(Array.isArray(data.artist) ? data.artist[0] :
  // data.artist) || data`. Given the REAL wire response, data.artist is a
  // truthy one-element array, so this now evaluates to that array's single
  // element — the artist object ArtistSchema expects. onboard-artists
  // (elsewhere in this same file) already unwrapped via `Array.isArray(data
  // .artist) ? data.artist[0] : data.artist`; get-artist now mirrors that
  // same guard. Fixed via the local `headphones-apikey-hardening`
  // issue-lifecycle model (see ../../CHANGELOG.md).
  const { ctx, written } = makeCtx();
  await withOneJson(
    getArtistFixture,
    () => run("get-artist", { id: getArtistFixture.artist[0].ArtistID }, ctx),
  );
  const res = written.find((w) => w.spec === "artist")!;
  assert(
    !Array.isArray(res.payload.artist),
    "fixed: the `artist` resource field now holds the unwrapped single object, matching ArtistSchema's expectation",
  );
  assertEquals(res.payload.artist, getArtistFixture.artist[0]);
  assertEquals(res.payload.albums, getArtistFixture.albums);
});

Deno.test("contract: getArtist.loading.json — Status Loading, albums not yet populated (mid-import shape)", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(
    getArtistLoadingFixture,
    () =>
      run("get-artist", {
        id: getArtistLoadingFixture.artist[0].ArtistID,
      }, ctx),
  );
  const res = written.find((w) => w.spec === "artist")!;
  const artist = res.payload.artist as Record<string, unknown>;
  assertEquals(artist.Status, "Loading");
  assertEquals(res.payload.albums, []);
});

// ---------------------------------------------------------------------------
// findArtist.json contract — bare array (MusicBrainz search results)
// ---------------------------------------------------------------------------

Deno.test("contract: findArtist.json — bare array, every row keeps its documented keyset", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(
    findArtistFixture,
    () => run("find-artist", { name: "Boards of Canada" }, ctx),
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, findArtistFixture);
  assertEquals(res.payload.total, findArtistFixture.length);
  const EXPECTED_KEYS = ["url", "score", "name", "uniquename", "id"].sort();
  for (const row of res.payload.results as Array<Record<string, unknown>>) {
    assertEquals(Object.keys(row).sort(), EXPECTED_KEYS);
  }
});

// ---------------------------------------------------------------------------
// getAlbum.json contract — object envelope {album, tracks}; `album` is ALSO
// a single-element ARRAY on the real wire (same _dic_from_query mechanism as
// getArtist — see PROVENANCE.md); get-album shared the same non-unwrap
// defect and was fixed identically (free-rider, same fix path as get-artist)
// ---------------------------------------------------------------------------

Deno.test("contract: getAlbum.json — object envelope {album, tracks}; `album` is a single-element ARRAY on the real wire (same mechanism as getArtist)", () => {
  assert(
    Array.isArray(getAlbumFixture.album),
    "fixture must model reality: album is an array on the wire, per headphones/api.py's _getAlbum (same _dic_from_query, no [0] indexing)",
  );
  assertEquals(getAlbumFixture.album.length, 1);
  assert(Array.isArray(getAlbumFixture.tracks));
});

Deno.test("FIXED: get-album ALSO unwraps the wire ARRAY into the single album object (same defect class and fix as get-artist)", async () => {
  // Discovered as a direct, same-evidence-quality extension of plan v2's
  // Step 2 diligence: _getAlbum in headphones/api.py builds
  // `{'album': album, 'tracks': tracks, ...}` where `album` comes from the
  // exact same `_dic_from_query` helper as `_getArtist`'s `artist`, with no
  // `[0]` indexing. get-album's `album: data.album || data` had the
  // identical non-unwrap shape as get-artist and got the identical fix.
  // Fixed via the local `headphones-apikey-hardening` issue-lifecycle model.
  const { ctx, written } = makeCtx();
  await withOneJson(
    getAlbumFixture,
    () => run("get-album", { id: getAlbumFixture.album[0].AlbumID }, ctx),
  );
  const res = written.find((w) => w.spec === "album")!;
  assert(
    !Array.isArray(res.payload.album),
    "fixed: the `album` resource field now holds the unwrapped single object, matching AlbumSchema's expectation",
  );
  assertEquals(res.payload.album, getAlbumFixture.album[0]);
  assertEquals(res.payload.tracks, getAlbumFixture.tracks);
});

// ---------------------------------------------------------------------------
// getWanted.json contract — bare array (identical shape backs get-snatched /
// get-upcoming in the methods suite: same `albums` table, different Status
// filter server-side)
// ---------------------------------------------------------------------------

Deno.test("contract: getWanted.json — bare array of album rows, total == length, rows pass through", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(getWantedFixture, () => run("get-wanted", {}, ctx));
  const res = written.find((w) => w.spec === "albums")!;
  assertEquals(res.payload.albums, getWantedFixture);
  assertEquals(res.payload.total, getWantedFixture.length);
  assertEquals(res.payload.category, "wanted");
});

// ---------------------------------------------------------------------------
// getHistory.json contract — bare array
// ---------------------------------------------------------------------------

Deno.test("contract: getHistory.json — bare array of history rows, total == length", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(getHistoryFixture, () => run("get-history", {}, ctx));
  const res = written.find((w) => w.spec === "history")!;
  assertEquals(res.payload.items, getHistoryFixture);
  assertEquals(res.payload.total, getHistoryFixture.length);
});

// ---------------------------------------------------------------------------
// getLogs.json contract — bare array of strings (per headphones.ts's own
// declared LogsSchema; see PROVENANCE.md for the tuple-vs-string caveat)
// ---------------------------------------------------------------------------

Deno.test("contract: getLogs.json — bare array of strings, passed through verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(getLogsFixture, () => run("get-logs", {}, ctx));
  const res = written.find((w) => w.spec === "logs")!;
  assertEquals(res.payload.logs, getLogsFixture);
  for (const line of res.payload.logs as unknown[]) {
    assertEquals(typeof line, "string");
  }
});

// ---------------------------------------------------------------------------
// error.html contract — the JSON.parse -> {raw} fallback, fed via a
// dedicated text/HTML-200 response (NOT json()), pinning api()'s swallow
// path at the wire-format level
// ---------------------------------------------------------------------------

// Deno's `with { type: "json" }` import attribute needs no runtime
// permission (resolved by the module loader), but there is no equivalent for
// plain text without `--unstable-raw-imports` — which the network-less,
// run-less, file-permission-less default test task deliberately does not
// enable (see deno.json). Kept byte-identical to fixtures/error.html; that
// file remains the canonical, PROVENANCE-documented artifact.
const ERROR_HTML = `<!DOCTYPE html>
<html>
  <head><title>500 Internal Server Error</title></head>
  <body>
    <h1>Internal Server Error</h1>
    <p>
      The server encountered an internal error and was unable to complete your
      request.
    </p>
  </body>
</html>
`;

Deno.test("contract: a 200 OK response with an HTML (non-JSON) body falls back to {raw: <text>} — api()'s JSON.parse catch path", async () => {
  const errorHtml = ERROR_HTML;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      () =>
        new Response(errorHtml, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    () => run("get-version", {}, ctx),
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.raw, errorHtml);
});
