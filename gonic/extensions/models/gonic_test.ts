/**
 * Contract-fixture suite: pins the CONCRETE Subsonic REST API wire shape from
 * gonic/fixtures/*.json directly, independent of gonic.ts's zod resource
 * schemas. This suite hardcodes the expected field mapping from the
 * documented Subsonic `subsonic-response` envelope so a real wire-format
 * drift (or an accidental change to gonic.ts's unwrap logic) turns a test red
 * (see STANDARD.md's contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made.
 *
 * gonic.ts is BYTE-FROZEN by this change — every test characterizes
 * already-shipped behavior. It is not red-green TDD.
 *
 * Toolchain rule: no `as typeof <global-builtin>` casts — the fetch seam is
 * installed via the double-bridge `as unknown as typeof globalThis.fetch`
 * cast (CI runs deno 2.8.3; local dev may be on an older 2.7.x, and a direct
 * `as typeof globalThis.fetch` cast risks a CI-only deno-check break).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./gonic.ts";
import pingFixture from "../../fixtures/ping.json" with { type: "json" };
import getPodcastsFixture from "../../fixtures/get-podcasts.json" with {
  type: "json",
};
import scanStatusFixture from "../../fixtures/scan-status.json" with {
  type: "json",
};
import startScanFixture from "../../fixtures/start-scan.json" with {
  type: "json",
};
import getPlaylistsFixture from "../../fixtures/get-playlists.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  host: "gonic.example.com",
  port: 4747,
  username: "listener",
  password: "fixture-only-not-a-real-password",
  sshUser: "root",
  dbPath: "/data/gonic.db",
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
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

/** Install a fetch stub that returns `body` as a 200 JSON response for the
 * duration of `fn`. Double-bridge cast per the toolchain rule above. */
function withFixture(body: unknown, fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as unknown as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// ping — sr.status/version/type/serverVersion/openSubsonic
// ---------------------------------------------------------------------------

Deno.test("contract: ping pins the exact serverStatus field mapping from the fixture", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(pingFixture, () => run("ping", {}, ctx));
  const res = written.find((w) => w.spec === "serverStatus")!;
  assertEquals(res.payload.status, "ok");
  assertEquals(res.payload.version, "1.16.1");
  assertEquals(res.payload.type, "gonic");
  assertEquals(res.payload.serverVersion, "v0.16.2 (synthetic-fixture)");
  assertEquals(res.payload.openSubsonic, true);
  assert(
    typeof res.payload.timestamp === "string" &&
      !isNaN(Date.parse(res.payload.timestamp as string)),
    "timestamp must be a valid ISO date string",
  );
});

// ---------------------------------------------------------------------------
// get-podcasts — sr.podcasts.channel[].episode[]
// ---------------------------------------------------------------------------

Deno.test("contract: get-podcasts pins the channel/episode keyset and pd-/pe- id pass-through", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    getPodcastsFixture,
    () => run("get-podcasts", { includeEpisodes: true }, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  assertEquals(channels.length, 2);

  const ch1 = channels[0];
  assertEquals(ch1.id, "pd-1");
  assertEquals(ch1.url, "https://feeds.example.com/podcast-one.xml");
  assertEquals(ch1.title, "Example Podcast One");
  assertEquals(ch1.status, "completed");
  const episodes = ch1.episode as Array<Record<string, unknown>>;
  assertEquals(episodes.length, 2);
  assertEquals(episodes[0].id, "pe-1");
  assertEquals(episodes[0].channelId, "pd-1");
  assertEquals(episodes[0].size, 15728640);
  assertEquals(episodes[0].duration, 1830);
  assertEquals(
    episodes[0].path,
    "podcasts/Example Podcast One/Episode One.mp3",
  );
});

Deno.test("contract: get-podcasts — a channel with no episode key maps to episode: [] (not undefined)", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    getPodcastsFixture,
    () => run("get-podcasts", { includeEpisodes: true }, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  const pd2 = channels.find((c) => c.id === "pd-2")!;
  assertEquals(pd2.status, "error");
  assertEquals(pd2.errorMessage, "feed unreachable (synthetic)");
  assertEquals(pd2.episode, []);
});

Deno.test("contract: get-podcasts — a still-downloading episode's optional fields stay undefined, not defaulted", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    getPodcastsFixture,
    () => run("get-podcasts", { includeEpisodes: true }, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  const pe2 = (channels[0].episode as Array<Record<string, unknown>>).find(
    (e) => e.id === "pe-2",
  )!;
  assertEquals(pe2.status, "downloading");
  assertEquals(pe2.description, undefined);
  assertEquals(pe2.size, undefined);
  assertEquals(pe2.duration, undefined);
  assertEquals(pe2.path, undefined);
});

// ---------------------------------------------------------------------------
// scan-status / start-scan — sr.scanStatus
// ---------------------------------------------------------------------------

Deno.test("contract: scan-status pins the idle scanStatus shape (scanning:false)", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(scanStatusFixture, () => run("scan-status", {}, ctx));
  const res = written.find((w) => w.spec === "scanStatus")!;
  assertEquals(res.payload.scanning, false);
  assertEquals(res.payload.count, 5423);
});

Deno.test("contract: start-scan pins the active scanStatus shape (scanning:true)", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(startScanFixture, () => run("start-scan", {}, ctx));
  const res = written.find((w) => w.spec === "scanStatus")!;
  assertEquals(res.payload.scanning, true);
  assertEquals(res.payload.count, 128);
});

// ---------------------------------------------------------------------------
// get-playlists — sr.playlists.playlist[]
// ---------------------------------------------------------------------------

Deno.test("contract: get-playlists pins the playlist keyset and numeric songCount/duration types", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(getPlaylistsFixture, () => run("get-playlists", {}, ctx));
  const res = written.find((w) => w.spec === "playlists")!;
  const playlists = res.payload.playlists as Array<Record<string, unknown>>;
  assertEquals(playlists.length, 2);
  assertEquals(playlists[0].id, "pl-1");
  assertEquals(playlists[0].owner, "listener");
  assertEquals(typeof playlists[0].songCount, "number");
  assertEquals(typeof playlists[0].duration, "number");
  assertEquals(playlists[0].songCount, 42);
  assertEquals(playlists[0].duration, 10080);
});

Deno.test("contract: get-playlists — a playlist missing owner/created/changed defaults songCount/duration but leaves owner undefined", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(getPlaylistsFixture, () => run("get-playlists", {}, ctx));
  const res = written.find((w) => w.spec === "playlists")!;
  const playlists = res.payload.playlists as Array<Record<string, unknown>>;
  const pl2 = playlists.find((p) => p.id === "pl-2")!;
  assertEquals(pl2.owner, undefined);
  assertEquals(pl2.songCount, 0);
  assertEquals(pl2.duration, 0);
  assertEquals(pl2.created, undefined);
  assertEquals(pl2.changed, undefined);
});

// ---------------------------------------------------------------------------
// error.json — failed envelope -> thrown Error
// ---------------------------------------------------------------------------

Deno.test("contract: a failed envelope maps to 'Gonic API <ep>: <msg> (code <code>)'", async () => {
  const { ctx } = makeCtx();
  await withFixture(
    errorFixture,
    () =>
      assertRejects(
        () => run("ping", {}, ctx),
        Error,
        "Gonic API ping: Wrong username or password (synthetic fixture) (code 40)",
      ),
  );
});

// ---------------------------------------------------------------------------
// Missing "subsonic-response" wrapper entirely
// ---------------------------------------------------------------------------

Deno.test("contract: a body missing 'subsonic-response' throws 'unexpected response format'", async () => {
  const { ctx } = makeCtx();
  await withFixture(
    { unexpected: "shape" },
    () =>
      assertRejects(
        () => run("ping", {}, ctx),
        Error,
        "Gonic API ping: unexpected response format",
      ),
  );
});
