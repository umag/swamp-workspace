/**
 * Adversarial suite for @magistr/ryot: hostile snapshot URIs (curl argument
 * injection, non-https schemes, foreign hosts), spec-violating Ryot
 * responses, Cloudflare challenge pages, and token handling.
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
} from "jsr:@std/assert@1.0.13";
import {
  isChallengePage,
  isLetterboxdUri,
  model,
  parseTmdbFromFilmPage,
} from "./ryot.ts";
import {
  filmPage,
  importArgs,
  json,
  makeCtx,
  ryotRoute,
  snapshot,
  text,
  TOKEN,
  withCurl,
  withFetch,
} from "./ryot_harness_test.ts";

const HOSTILE_URIS = [
  "-o/tmp/pwned",
  "--config=/etc/passwd",
  "-K/etc/passwd",
  "file:///etc/passwd",
  "http://boxd.it/abc",
  "https://evil.example/boxd.it",
  "https://boxd.it.evil.example/x",
  "https://user:pw@boxd.it/x",
  "gopher://boxd.it/x",
  "",
  "not a url",
];

Deno.test("isLetterboxdUri rejects every hostile URI", () => {
  for (const u of HOSTILE_URIS) assertFalse(isLetterboxdUri(u), u);
  assert(isLetterboxdUri("https://boxd.it/2bxm"));
  assert(isLetterboxdUri("https://letterboxd.com/film/1984/"));
});

Deno.test("import_films: hostile URIs never reach curl and are reported", async () => {
  const { ctx, written } = makeCtx();
  const watched = HOSTILE_URIS.map((uri, i) => ({
    name: `bad${i}`,
    year: null,
    uri,
    date: null,
  }));
  await withCurl(
    () => ({ body: filmPage(1), status: 200 }),
    (curls) =>
      withFetch(ryotRoute(), async () => {
        await model.methods.import_films.execute(
          importArgs({ snapshot: snapshot({ watched }), dryRun: true }),
          ctx,
        );
        assertEquals(curls, []);
      }),
  );
  const p = written.find((w) => w.spec === "importResult")!.payload as {
    movies: number;
    unresolved: { name: string; reason: string }[];
  };
  assertEquals(p.movies, 0);
  assertEquals(p.unresolved.length, HOSTILE_URIS.length);
  for (const u of p.unresolved) assert(u.reason.includes("not a Letterboxd"));
});

Deno.test("import_films: a persistent Cloudflare challenge is retried then unresolved", async () => {
  const { ctx, written } = makeCtx();
  await withCurl(
    () => ({ body: "<title>Just a moment...</title>", status: 200 }),
    (curls) =>
      withFetch(ryotRoute(), async () => {
        await model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({
              watched: [{
                name: "X",
                year: null,
                uri: "https://boxd.it/x",
                date: null,
              }],
            }),
            dryRun: true,
          }),
          ctx,
        );
        assertEquals(curls.length, 3);
      }),
  );
  const p = written.find((w) => w.spec === "importResult")!.payload as {
    unresolved: { reason: string }[];
  };
  assert(p.unresolved[0].reason.includes("after 3 attempts"));
});

Deno.test("isChallengePage is case-insensitive", () => {
  assert(isChallengePage("ENABLE JAVASCRIPT AND COOKIES TO CONTINUE"));
  assert(isChallengePage("window._cf_chl_opt = {}"));
});

Deno.test("parseTmdbFromFilmPage ignores non-numeric and uppercase types", () => {
  assertEquals(
    parseTmdbFromFilmPage('data-tmdb-id="12a" data-tmdb-type="MOVIE"'),
    { tmdbId: null, tmdbType: null },
  );
});

Deno.test("upload: a non-array response is rejected, not indexed", async () => {
  const { ctx } = makeCtx();
  for (const body of ['"/tmp/path"', "{}", "[]", "[42]", '[""]']) {
    await withFetch(
      (c) =>
        c.url.pathname === "/backend/upload"
          ? text(body)
          : json({ data: { deployImportJob: "1" } }),
      (calls) =>
        assertRejects(
          async () => {
            await model.methods.import_films.execute(
              importArgs({ owned: [{ tmdbId: 1 }] }),
              ctx,
            );
            // Never reached: deployImportJob must not be called.
            assertEquals(calls.length, 1);
          },
          Error,
          "no path",
        ),
    );
  }
});

Deno.test("upload: non-JSON 200 body fails with a clear message", async () => {
  const { ctx } = makeCtx();
  await withFetch(() => text("<html>proxy</html>"), () =>
    assertRejects(
      () =>
        model.methods.import_films.execute(
          importArgs({ owned: [{ tmdbId: 1 }] }),
          ctx,
        ),
      Error,
      "non-JSON",
    ));
});

Deno.test("graphql: non-JSON 200 body fails with a clear message", async () => {
  const { ctx } = makeCtx();
  await withFetch(() => text("<html>login</html>"), () =>
    assertRejects(
      () => model.methods.import_reports.execute({}, ctx),
      Error,
      "Ryot GraphQL returned non-JSON",
    ));
});

Deno.test("auth token goes only in the Authorization header, never the URL or body", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(ryotRoute(), async (calls) => {
    await model.methods.import_films.execute(
      importArgs({ owned: [{ tmdbId: 1 }] }),
      ctx,
    );
    for (const c of calls) {
      assertFalse(c.url.toString().includes(TOKEN));
      assertFalse(JSON.stringify(c.body).includes(TOKEN));
    }
  });
  assertFalse(JSON.stringify(written).includes(TOKEN));
});
