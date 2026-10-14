/**
 * Contract-fixture suite for @magistr/ryot: pins the Ryot generic-JSON
 * `CompleteExport` shape, the upload/GraphQL wire format, the Letterboxd
 * page attributes the TMDB scrape relies on, and the curl invocation.
 * If a test here breaks, the contract with Ryot or Letterboxd changed.
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import {
  buildCompleteExport,
  isChallengePage,
  letterboxdToRyotRating,
  model,
  parseTmdbFromFilmPage,
} from "./ryot.ts";
import {
  BASE,
  film,
  filmPage,
  importArgs,
  json,
  makeCtx,
  ryotRoute,
  snapshot,
  TOKEN,
  withCurl,
  withFetch,
} from "./ryot_harness_test.ts";

Deno.test("letterboxdToRyotRating maps half stars to 0-100", () => {
  assertEquals(letterboxdToRyotRating(0.5), 10);
  assertEquals(letterboxdToRyotRating(3.5), 70);
  assertEquals(letterboxdToRyotRating(5), 100);
  assertEquals(letterboxdToRyotRating(0), null);
});

Deno.test("parseTmdbFromFilmPage reads the tmdb id and type", () => {
  assertEquals(
    parseTmdbFromFilmPage('<body data-tmdb-type="movie" data-tmdb-id="9314">'),
    { tmdbId: 9314, tmdbType: "movie" },
  );
  assertEquals(parseTmdbFromFilmPage("<body>"), {
    tmdbId: null,
    tmdbType: null,
  });
});

Deno.test("isChallengePage ignores the normal challenge-platform beacon", () => {
  assertEquals(
    isChallengePage('<script src="/cdn-cgi/challenge-platform/">'),
    false,
  );
  assertEquals(isChallengePage("<title>Just a moment...</title>"), true);
});

Deno.test("buildCompleteExport emits tmdb movie items", () => {
  const out = buildCompleteExport(
    new Map([
      [9314, {
        title: "1984",
        seen: true,
        rating: 80,
        collections: new Set(["Owned"]),
      }],
      [687163, {
        title: "Project Hail Mary",
        seen: false,
        rating: null,
        collections: new Set(["Watchlist"]),
      }],
    ]),
    "2026-10-10T00:00:00.000Z",
  ) as { metadata: Record<string, unknown>[] };
  assertEquals(out.metadata.length, 2);
  const [seen, listed] = out.metadata;
  assertEquals(
    [seen.identifier, seen.source, seen.lot],
    ["9314", "tmdb", "movie"],
  );
  assertEquals(seen.seen_history, [{ ended_on: null, state: "completed" }]);
  assertEquals(seen.reviews, [{ rating: "80" }]);
  assertEquals(
    (seen.collections as { collection_name: string }[])[0].collection_name,
    "Owned",
  );
  assertEquals([listed.seen_history, listed.reviews], [[], []]);
});

// ---- wire format: upload + deployImportJob + import reports -------------

Deno.test("import_films: multipart upload then deployImportJob(GENERIC_JSON)", async () => {
  const { ctx } = makeCtx();
  await withCurl(
    () => ({ body: filmPage(9314), status: 200 }),
    () =>
      withFetch(
        ryotRoute({ uploadPath: "/tmp/x/swamp-films.json" }),
        async (calls) => {
          await model.methods.import_films.execute(
            importArgs({
              snapshot: snapshot({ watched: [film("1984", "a1")] }),
            }),
            ctx,
          );
          assertEquals(calls.length, 2);
          const [up, gql] = calls;
          assertEquals(up.method, "POST");
          assertEquals(up.url.toString(), `${BASE}/backend/upload`);
          assertEquals(up.headers.get("authorization"), `Bearer ${TOKEN}`);
          assertEquals(up.fileName, "swamp-films.json");
          assertEquals(gql.url.toString(), `${BASE}/backend/graphql`);
          assertEquals(gql.headers.get("content-type"), "application/json");
          assertEquals(gql.headers.get("authorization"), `Bearer ${TOKEN}`);
          const b = gql.body as { query: string; variables: unknown };
          assert(b.query.includes("deployImportJob(input: $input)"));
          assertEquals(b.variables, {
            input: {
              source: "GENERIC_JSON",
              path: { exportPath: "/tmp/x/swamp-films.json" },
            },
          });
        },
      ),
  );
});

Deno.test("import_films: uploaded file is a CompleteExport with every top-level key", async () => {
  const { ctx } = makeCtx();
  await withCurl(
    () => ({ body: filmPage(9314), status: 200 }),
    () =>
      withFetch(ryotRoute(), async (calls) => {
        await model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({
              ratings: [{ ...film("1984", "a1"), rating: 4 }],
            }),
          }),
          ctx,
        );
        const exp = calls[0].body as Record<string, unknown>;
        assertEquals(Object.keys(exp).sort(), [
          "collections",
          "exercises",
          "measurements",
          "metadata",
          "metadata_groups",
          "people",
          "workout_templates",
          "workouts",
        ]);
        const [m] = exp.metadata as Record<string, unknown>[];
        assertEquals(m.identifier, "9314");
        assertEquals(m.reviews, [{ rating: "80" }]);
      }),
  );
});

Deno.test("import_films: curl is invoked with the status marker and https-only proto", async () => {
  const { ctx } = makeCtx();
  await withCurl(
    () => ({ body: filmPage(1), status: 200 }),
    (curls) =>
      withFetch(ryotRoute(), async () => {
        await model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({ watched: [film("A", "a1")] }),
            dryRun: true,
          }),
          ctx,
        );
        assertEquals(curls.length, 1);
        assertEquals(curls[0].cmd, "curl");
        assertEquals(curls[0].url, "https://boxd.it/a1");
        const a = curls[0].args;
        assertEquals(a[a.indexOf("--proto") + 1], "=https");
        assert(a[a.indexOf("-w") + 1].includes("%{http_code}"));
      }),
  );
});

Deno.test("import_reports: queries userImportReports and stores them", async () => {
  const reports = [{
    id: "r1",
    source: "GENERIC_JSON",
    progress: "100",
    startedOn: "2026-10-10T00:00:00Z",
    finishedOn: "2026-10-10T00:01:00Z",
    wasSuccess: true,
    details: { import: { total: 2 }, failedItems: [] },
  }];
  const { ctx, written } = makeCtx();
  await withFetch(
    ryotRoute({ gql: () => json({ data: { userImportReports: reports } }) }),
    async (calls) => {
      await model.methods.import_reports.execute({}, ctx);
      const q = (calls[0].body as { query: string }).query;
      assert(q.includes("userImportReports"));
      assert(q.includes("failedItems { identifier step error }"));
    },
  );
  assertEquals(written.length, 1);
  assertEquals([written[0].spec, written[0].name], [
    "importReports",
    "reports",
  ]);
  assertEquals(written[0].payload.reports, reports);
});
