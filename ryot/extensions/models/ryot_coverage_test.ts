/**
 * Coverage suite for @magistr/ryot: one test per guard, so deleting the
 * guard turns a test red.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { letterboxdToRyotRating, model } from "./ryot.ts";
import {
  film,
  filmPage,
  importArgs,
  makeCtx,
  ryotRoute,
  snapshot,
  withCurl,
  withFetch,
} from "./ryot_harness_test.ts";

type Meta = {
  identifier: string;
  seen_history: unknown[];
  reviews: unknown[];
  collections: { collection_name: string }[];
};

Deno.test("baseUrl trailing slashes are stripped", async () => {
  const { ctx } = makeCtx({}, {
    baseUrl: "https://ryot.example///",
    authToken: "t",
  });
  await withFetch(ryotRoute(), async (calls) => {
    await model.methods.import_reports.execute({}, ctx);
    assertEquals(
      calls[0].url.toString(),
      "https://ryot.example/backend/graphql",
    );
  });
});

Deno.test("rating guard: non-finite and non-positive stars → null", () => {
  assertEquals(letterboxdToRyotRating(NaN), null);
  assertEquals(letterboxdToRyotRating(-1), null);
  assertEquals(letterboxdToRyotRating(Infinity), null);
});

Deno.test("rating clamp: stars above 5 cap at 100", () => {
  assertEquals(letterboxdToRyotRating(7), 100);
});

Deno.test("a watched film is removed from the Watchlist collection", async () => {
  const { ctx } = makeCtx();
  await withCurl(
    () => ({ body: filmPage(42), status: 200 }),
    () =>
      withFetch(ryotRoute(), async (calls) => {
        await model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({
              watched: [film("A", "a")],
              watchlist: [film("A", "a")],
            }),
          }),
          ctx,
        );
        const [m] = (calls[0].body as { metadata: Meta[] }).metadata;
        assertEquals(m.collections, []);
        assertEquals(m.seen_history.length, 1);
      }),
  );
});

Deno.test("guard only blocks when the previous import was deployed", async () => {
  const { ctx } = makeCtx({ films: { importJobDeployed: false } });
  await withFetch(ryotRoute(), (calls) =>
    model.methods.import_films.execute(
      importArgs({ owned: [{ tmdbId: 1 }] }),
      ctx,
    ).then(() => assertEquals(calls.length, 2)));
});

Deno.test("a successful real import blocks the next one", async () => {
  const { ctx } = makeCtx();
  await withFetch(ryotRoute(), async () => {
    await model.methods.import_films.execute(
      importArgs({ owned: [{ tmdbId: 1 }] }),
      ctx,
    );
    await assertRejects(
      () =>
        model.methods.import_films.execute(
          importArgs({ owned: [{ tmdbId: 1 }] }),
          ctx,
        ),
      Error,
      "force=true",
    );
  });
});

Deno.test("duplicate unresolved entries are deduped", async () => {
  const { ctx, written } = makeCtx();
  await withCurl(
    () => ({ body: filmPage(5, "tv"), status: 200 }),
    () =>
      withFetch(ryotRoute(), () =>
        model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({
              watched: [film("S", "s")],
              ratings: [{ ...film("S", "s"), rating: 4 }],
            }),
            dryRun: true,
          }),
          ctx,
        )),
  );
  const p = written.find((w) => w.spec === "importResult")!.payload as {
    unresolved: unknown[];
  };
  assertEquals(p.unresolved, [{ name: "S", reason: "TMDB tv" }]);
});

Deno.test("duplicate URIs across lists are fetched once", async () => {
  const { ctx } = makeCtx();
  await withCurl(
    () => ({ body: filmPage(5), status: 200 }),
    (curls) =>
      withFetch(ryotRoute(), async () => {
        await model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({
              watched: [film("S", "s")],
              ratings: [{ ...film("S", "s"), rating: 4 }],
              watchlist: [film("S", "s")],
            }),
            dryRun: true,
          }),
          ctx,
        );
        assertEquals(curls.length, 1);
      }),
  );
});

Deno.test("a 404 fails fast without retries", async () => {
  const { ctx } = makeCtx();
  await withCurl(
    () => ({ body: "", status: 404 }),
    (curls) =>
      withFetch(ryotRoute(), async () => {
        await model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({ watched: [film("X", "x")] }),
            dryRun: true,
          }),
          ctx,
        );
        assertEquals(curls.length, 1);
      }),
  );
});

Deno.test("a transient curl failure is retried and then succeeds", async () => {
  const { ctx, written } = makeCtx();
  let n = 0;
  await withCurl(
    () =>
      ++n < 3
        ? { body: "", status: 0, success: false }
        : { body: filmPage(77), status: 200 },
    (curls) =>
      withFetch(ryotRoute(), async () => {
        await model.methods.import_films.execute(
          importArgs({
            snapshot: snapshot({ watched: [film("X", "x")] }),
            dryRun: true,
          }),
          ctx,
        );
        assertEquals(curls.length, 3);
      }),
  );
  const p = written.find((w) => w.spec === "importResult")!.payload as {
    movies: number;
  };
  assertEquals(p.movies, 1);
});

Deno.test("owned film with no title uses its TMDB id as source_id", async () => {
  const { ctx } = makeCtx();
  await withFetch(ryotRoute(), async (calls) => {
    await model.methods.import_films.execute(
      importArgs({ owned: [{ tmdbId: 314 }] }),
      ctx,
    );
    const [m] = (calls[0].body as { metadata: Record<string, unknown>[] })
      .metadata;
    assertEquals(m.source_id, "314");
  });
});
