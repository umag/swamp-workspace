/**
 * Methods suite for @magistr/ryot: every method's success and failure paths
 * with fetch and the host curl stubbed.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./ryot.ts";
import {
  film,
  filmPage,
  importArgs,
  json,
  makeCtx,
  ryotRoute,
  snapshot,
  text,
  withCurl,
  withFetch,
} from "./ryot_harness_test.ts";

const PAGES: Record<string, string> = {
  "https://boxd.it/w1": filmPage(101),
  "https://boxd.it/r1": filmPage(102),
  "https://boxd.it/l1": filmPage(103),
  "https://boxd.it/tv": filmPage(555, "tv"),
  "https://boxd.it/none": "<html><body></body></html>",
};
const curlPages = (url: string) =>
  PAGES[url] ? { body: PAGES[url], status: 200 } : { body: "", status: 404 };

type Result = {
  dryRun: boolean;
  movies: number;
  seen: number;
  rated: number;
  watchlist: number;
  owned: number;
  unresolved: { name: string; reason: string }[];
  importJobDeployed: boolean;
};

Deno.test("import_films: counts watched, rated, watchlist and owned", async () => {
  const { ctx, written } = makeCtx();
  await withCurl(curlPages, () =>
    withFetch(ryotRoute(), async (calls) => {
      const r = await model.methods.import_films.execute(
        importArgs({
          snapshot: snapshot({
            watched: [film("W", "w1")],
            ratings: [{ ...film("R", "r1"), rating: 3.5 }],
            watchlist: [film("L", "l1")],
          }),
          owned: [{ tmdbId: 900, title: "Owned film" }],
        }),
        ctx,
      );
      assertEquals(r.dataHandles.length, 2);
      assertEquals(calls.length, 2);
    }));
  const res = written.find((w) => w.spec === "importResult")!;
  assertEquals(res.name, "films");
  const p = res.payload as Result;
  assertEquals(
    [p.movies, p.seen, p.rated, p.watchlist, p.owned],
    [4, 2, 1, 1, 1],
  );
  assertEquals(p.importJobDeployed, true);
  assertEquals(p.unresolved, []);
  const map = written.find((w) => w.spec === "letterboxdMap")!;
  assertEquals(map.name, "letterboxd-tmdb-map");
  assertEquals(Object.keys(map.payload.map as object).sort(), [
    "https://boxd.it/l1",
    "https://boxd.it/r1",
    "https://boxd.it/w1",
  ]);
});

Deno.test("import_films: dryRun makes no Ryot request and writes films-dry-run", async () => {
  const { ctx, written } = makeCtx();
  await withCurl(curlPages, () =>
    withFetch(ryotRoute(), async (calls) => {
      await model.methods.import_films.execute(
        importArgs({
          snapshot: snapshot({ watched: [film("W", "w1")] }),
          dryRun: true,
        }),
        ctx,
      );
      assertEquals(calls.length, 0);
    }));
  const res = written.find((w) => w.spec === "importResult")!;
  assertEquals(res.name, "films-dry-run");
  assertEquals((res.payload as Result).importJobDeployed, false);
  assertEquals((res.payload as Result).dryRun, true);
});

Deno.test("import_films: refuses a second real import without force", async () => {
  const { ctx } = makeCtx({
    films: { importJobDeployed: true, finishedAt: "2026-10-10T00:00:00Z" },
  });
  await withCurl(curlPages, () =>
    withFetch(ryotRoute(), async (calls) => {
      await assertRejects(
        () => model.methods.import_films.execute(importArgs(), ctx),
        Error,
        "already imported at 2026-10-10T00:00:00Z",
      );
      assertEquals(calls.length, 0);
    }));
});

Deno.test("import_films: force re-imports over a deployed import", async () => {
  const { ctx } = makeCtx({
    films: { importJobDeployed: true, finishedAt: "x" },
  });
  await withCurl(curlPages, () =>
    withFetch(ryotRoute(), async (calls) => {
      await model.methods.import_films.execute(
        importArgs({ force: true, owned: [{ tmdbId: 1 }] }),
        ctx,
      );
      assertEquals(calls.length, 2);
    }));
});

Deno.test("import_films: dryRun is allowed after a deployed import", async () => {
  const { ctx } = makeCtx({
    films: { importJobDeployed: true, finishedAt: "x" },
  });
  await withCurl(
    curlPages,
    () =>
      withFetch(
        ryotRoute(),
        () =>
          model.methods.import_films.execute(importArgs({ dryRun: true }), ctx),
      ),
  );
});

Deno.test("import_films: TV, id-less and 404 pages are reported unresolved", async () => {
  const { ctx, written } = makeCtx();
  await withCurl(
    curlPages,
    () =>
      withFetch(ryotRoute(), () =>
        model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({
              watched: [
                film("Show", "tv"),
                film("Blank", "none"),
                film("Gone", "missing"),
              ],
            }),
            dryRun: true,
          }),
          ctx,
        )),
  );
  const p = written.find((w) => w.spec === "importResult")!.payload as Result;
  assertEquals(p.movies, 0);
  const reasons = Object.fromEntries(
    p.unresolved.map((u) => [u.name, u.reason]),
  );
  assertEquals(reasons["Show"], "TMDB tv");
  assertEquals(reasons["Blank"], "no TMDB id");
  assert(reasons["https://boxd.it/missing"].includes("404"));
});

Deno.test("import_films: cached URIs are not fetched again", async () => {
  const { ctx } = makeCtx({
    "letterboxd-tmdb-map": {
      map: { "https://boxd.it/w1": { tmdbId: 101, tmdbType: "movie" } },
      updatedAt: "2026-10-01T00:00:00Z",
    },
  });
  await withCurl(curlPages, (curls) =>
    withFetch(ryotRoute(), async () => {
      await model.methods.import_films.execute(
        importArgs({
          snapshot: snapshot({ watched: [film("W", "w1"), film("R", "r1")] }),
          dryRun: true,
        }),
        ctx,
      );
      assertEquals(curls.map((c) => c.url), ["https://boxd.it/r1"]);
    }));
});

Deno.test("import_films: ownedAsSeen marks owned films seen", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(ryotRoute(), () =>
    model.methods.import_films.execute(
      importArgs({ owned: [{ tmdbId: 7 }], ownedAsSeen: true, dryRun: true }),
      ctx,
    ));
  const p = written.find((w) => w.spec === "importResult")!.payload as Result;
  assertEquals([p.seen, p.owned], [1, 1]);
});

Deno.test("import_films: upload HTTP error propagates and no result is written", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(() => text("boom", 500), async () => {
    await assertRejects(
      () =>
        model.methods.import_films.execute(
          importArgs({ owned: [{ tmdbId: 1 }] }),
          ctx,
        ),
      Error,
      "Ryot upload HTTP 500",
    );
  });
  assertEquals(written.filter((w) => w.spec === "importResult"), []);
});

Deno.test("import_films: GraphQL errors propagate", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    ryotRoute({ gql: () => json({ errors: [{ message: "bad path" }] }) }),
    () =>
      assertRejects(
        () =>
          model.methods.import_films.execute(
            importArgs({ owned: [{ tmdbId: 1 }] }),
            ctx,
          ),
        Error,
        "Ryot GraphQL: bad path",
      ),
  );
});

Deno.test("import_reports: empty data stores an empty list", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    ryotRoute({ gql: () => json({ data: {} }) }),
    () => model.methods.import_reports.execute({}, ctx),
  );
  assertEquals(written[0].payload.reports, []);
});

Deno.test("import_reports: HTTP error propagates", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(() => text("nope", 401), () =>
    assertRejects(
      () => model.methods.import_reports.execute({}, ctx),
      Error,
      "Ryot GraphQL HTTP 401",
    ));
  assertEquals(written, []);
});
