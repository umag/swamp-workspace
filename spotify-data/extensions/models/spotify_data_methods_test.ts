/**
 * Methods suite for @magistr/spotify-data: every method's success and failure
 * paths, with the filesystem the only real dependency (this model makes no
 * network call and holds no credential, so there is nothing to stub but disk).
 *
 * Each test builds a throwaway export directory, runs the method against it,
 * and asserts on the captured writeResource payloads.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { chunkName, model } from "./spotify_data.ts";

type Written = { spec: string; name: string; data: Record<string, unknown> };

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: never, c: unknown) => Promise<{ dataHandles: unknown[] }>;
}>;

function makeCtx(exportPath: string, label = "spotify") {
  const written: Written[] = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs: { exportPath, label },
      logger: {
        info: (msg: string) => logs.push(msg),
        warning: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
      },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as unknown as MethodMap)[name];
  assert(method, `method ${name} must exist`);
  return method.execute(method.arguments.parse(args) as never, ctx);
}

/** A minimal export directory holding one history file with `records`. */
async function withExport(
  records: unknown[],
  fn: (dir: string) => Promise<void>,
  fileName = "Streaming_History_Audio_2023_1.json",
) {
  const dir = await Deno.makeTempDir({ prefix: "spotify_test_" });
  try {
    await Deno.writeTextFile(
      `${dir}/${fileName}`,
      JSON.stringify(records),
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const play = (
  ts: string,
  artist: string,
  track: string,
  msPlayed = 200000,
  extra: Record<string, unknown> = {},
) => ({
  ts,
  ms_played: msPlayed,
  ip_addr: "203.0.113.1",
  conn_country: "NL",
  platform: "osx",
  incognito_mode: false,
  master_metadata_track_name: track,
  master_metadata_album_artist_name: artist,
  master_metadata_album_album_name: "An Album",
  ...extra,
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

Deno.test("inspect: reports counts and years, and writes ONLY an inspection resource — never a year chunk", async () => {
  await withExport(
    [
      play("2023-04-01T18:22:05Z", "Japan", "Ghosts"),
      play("2024-01-02T10:00:00Z", "Autechre", "Rae"),
    ],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      const res = await run("inspect", {}, ctx);

      assertEquals(written.length, 1);
      assertEquals(written[0].spec, "inspection");
      assertEquals(written[0].name, "inspection.spotify");
      assertEquals(res.dataHandles.length, 1);

      const d = written[0].data;
      assertEquals(d.musicStreams, 2);
      assertEquals(d.totalRecords, 2);
      assertEquals(d.podcasts, 0);
      assertEquals(
        (d.years as Array<{ year: string }>).map((y) => y.year),
        ["2023", "2024"],
      );
      assertEquals(d.sourcePath, dir);
    },
  );
});

Deno.test("inspect: overThresholdStreams counts only plays that reached 30s, while musicStreams counts every play", async () => {
  await withExport(
    [
      play("2023-04-01T18:22:05Z", "A", "long", 45000),
      play("2023-04-01T19:00:00Z", "A", "short", 4200),
      play("2023-04-01T20:00:00Z", "A", "exactly", 30000),
    ],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("inspect", {}, ctx);
      const d = written[0].data;
      assertEquals(d.musicStreams, 3);
      // 30000 is >= threshold, so it counts: the boundary is inclusive.
      assertEquals(d.overThresholdStreams, 2);
    },
  );
});

Deno.test("inspect: filesFound reports basenames, not the temp-dir absolute paths", async () => {
  await withExport(
    [play("2023-04-01T18:22:05Z", "A", "b")],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("inspect", {}, ctx);
      assertEquals(written[0].data.filesFound, [
        "Streaming_History_Audio_2023_1.json",
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

Deno.test("import: writes one streams chunk per calendar year plus one import-state resource", async () => {
  await withExport(
    [
      play("2023-04-01T18:22:05Z", "Japan", "Ghosts"),
      play("2023-12-31T23:59:59Z", "Autechre", "Untitled"),
      play("2024-01-01T00:00:01Z", "Autechre", "Second Bad Vilbel"),
    ],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("import", {}, ctx);

      const chunks = written.filter((w) => w.spec === "streams");
      const states = written.filter((w) => w.spec === "imports");
      assertEquals(chunks.map((c) => c.name), [
        chunkName("2023"),
        chunkName("2024"),
      ]);
      assertEquals(states.length, 1);
      assertEquals(states[0].name, "import.spotify");

      assertEquals(chunks[0].data.count, 2);
      assertEquals(chunks[1].data.count, 1);
      assertEquals(states[0].data.streamsImported, 3);
      assertEquals(states[0].data.filesRead, 1);
    },
  );
});

Deno.test("import: streams inside a chunk are sorted by uts ascending regardless of file order", async () => {
  await withExport(
    [
      play("2023-08-01T00:00:00Z", "C", "third"),
      play("2023-02-01T00:00:00Z", "A", "first"),
      play("2023-05-01T00:00:00Z", "B", "second"),
    ],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("import", {}, ctx);
      const chunk = written.find((w) => w.spec === "streams")!;
      const streams = chunk.data.streams as Array<{ uts: number }>;
      const utsList = streams.map((s) => s.uts);
      assertEquals([...utsList].sort((a, b) => a - b), utsList);
      assertEquals(chunk.data.firstUts, utsList[0]);
      assertEquals(chunk.data.lastUts, utsList[utsList.length - 1]);
    },
  );
});

Deno.test("import: the year argument narrows to a single chunk, and the state reports only that year", async () => {
  await withExport(
    [
      play("2023-04-01T18:22:05Z", "Japan", "Ghosts"),
      play("2024-01-02T10:00:00Z", "Autechre", "Rae"),
    ],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("import", { year: "2024" }, ctx);
      const chunks = written.filter((w) => w.spec === "streams");
      assertEquals(chunks.length, 1);
      assertEquals(chunks[0].name, chunkName("2024"));
      const state = written.find((w) => w.spec === "imports")!;
      assertEquals(state.data.streamsImported, 1);
      assertEquals(
        (state.data.years as Array<{ year: string }>).map((y) => y.year),
        ["2024"],
      );
    },
  );
});

Deno.test("import: a year argument matching no data writes no chunk but still records state", async () => {
  await withExport(
    [play("2023-04-01T18:22:05Z", "Japan", "Ghosts")],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("import", { year: "1999" }, ctx);
      assertEquals(written.filter((w) => w.spec === "streams").length, 0);
      const state = written.find((w) => w.spec === "imports")!;
      assertEquals(state.data.streamsImported, 0);
      assertEquals(state.data.years, []);
      assertEquals(state.data.firstUts, undefined);
    },
  );
});

Deno.test("import: duplicatesCollapsed counts the byte-identical records dedupe removed", async () => {
  const one = play("2023-04-01T18:22:05Z", "Japan", "Ghosts");
  await withExport([one, { ...one }, { ...one }], async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await run("import", {}, ctx);
    const state = written.find((w) => w.spec === "imports")!;
    assertEquals(state.data.streamsImported, 1);
    assertEquals(state.data.duplicatesCollapsed, 2);
  });
});

Deno.test("import: podcast and audiobook records are counted as skipped, never imported", async () => {
  await withExport(
    [
      play("2023-04-01T18:22:05Z", "Japan", "Ghosts"),
      { ts: "2023-05-02T12:00:00Z", ms_played: 10, episode_name: "Ep" },
      { ts: "2023-05-03T12:00:00Z", ms_played: 10, audiobook_title: "Book" },
    ],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("import", {}, ctx);
      const state = written.find((w) => w.spec === "imports")!;
      assertEquals(state.data.streamsImported, 1);
      assertEquals(state.data.podcastsSkipped, 1);
      assertEquals(state.data.audiobooksSkipped, 1);
    },
  );
});

Deno.test("import: the label global argument names the state resource and is stamped into every chunk", async () => {
  await withExport(
    [play("2023-04-01T18:22:05Z", "Japan", "Ghosts")],
    async (dir) => {
      const { ctx, written } = makeCtx(dir, "second-account");
      await run("import", {}, ctx);
      const state = written.find((w) => w.spec === "imports")!;
      assertEquals(state.name, "import.second-account");
      assertEquals(state.data.label, "second-account");
      const chunk = written.find((w) => w.spec === "streams")!;
      assertEquals(chunk.data.label, "second-account");
      // The chunk NAME stays year-keyed, so two labels share year chunks by
      // design — the label lives in the payload, not the resource name.
      assertEquals(chunk.name, chunkName("2023"));
    },
  );
});

Deno.test("import: msPlayedTotal is the sum of the chunk's own streams", async () => {
  await withExport(
    [
      play("2023-04-01T18:22:05Z", "A", "a", 1000),
      play("2023-04-02T18:22:05Z", "B", "b", 2500),
    ],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("import", {}, ctx);
      const chunk = written.find((w) => w.spec === "streams")!;
      assertEquals(chunk.data.msPlayedTotal, 3500);
    },
  );
});

Deno.test("import: reads every history file in the directory, recursively", async () => {
  const dir = await Deno.makeTempDir({ prefix: "spotify_test_" });
  try {
    await Deno.mkdir(`${dir}/nested`);
    await Deno.writeTextFile(
      `${dir}/Streaming_History_Audio_2023_1.json`,
      JSON.stringify([play("2023-04-01T18:22:05Z", "A", "a")]),
    );
    await Deno.writeTextFile(
      `${dir}/nested/Streaming_History_Audio_2024_2.json`,
      JSON.stringify([play("2024-04-01T18:22:05Z", "B", "b")]),
    );
    // A non-history JSON file in the same tree must be ignored.
    await Deno.writeTextFile(`${dir}/Userdata.json`, JSON.stringify({ a: 1 }));

    const { ctx, written } = makeCtx(dir);
    await run("import", {}, ctx);
    const state = written.find((w) => w.spec === "imports")!;
    assertEquals(state.data.filesRead, 2);
    assertEquals(state.data.streamsImported, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// failure paths
// ---------------------------------------------------------------------------

Deno.test("inspect and import both reject a path that does not exist, naming it", async () => {
  const missing = "/nonexistent/spotify-export-does-not-exist";
  for (const method of ["inspect", "import"]) {
    const { ctx } = makeCtx(missing);
    await assertRejects(
      () => run(method, {}, ctx),
      Error,
      `Export path not found: ${missing}`,
    );
  }
});

Deno.test("import rejects a directory holding no Streaming_History_Audio_* file, pointing at the Account-data mistake", async () => {
  const dir = await Deno.makeTempDir({ prefix: "spotify_test_" });
  try {
    await Deno.writeTextFile(`${dir}/Userdata.json`, "[]");
    const { ctx } = makeCtx(dir);
    await assertRejects(
      () => run("import", {}, ctx),
      Error,
      "Extended streaming history",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("import rejects a non-zip, non-directory export path", async () => {
  const file = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const { ctx } = makeCtx(file);
    await assertRejects(
      () => run("import", {}, ctx),
      Error,
      "must be a directory or a .zip archive",
    );
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("import rejects a history file that is a JSON object rather than an array", async () => {
  await withExport(
    [],
    async (dir) => {
      await Deno.writeTextFile(
        `${dir}/Streaming_History_Audio_2023_1.json`,
        JSON.stringify({ not: "an array" }),
      );
      const { ctx } = makeCtx(dir);
      await assertRejects(
        () => run("import", {}, ctx),
        Error,
        "Malformed history file",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// argument schema
// ---------------------------------------------------------------------------

Deno.test("import's year argument accepts a 4-digit year and rejects anything else", () => {
  const args = (model.methods as unknown as MethodMap).import.arguments;
  assertEquals(args.parse({ year: "2024" }), { year: "2024" });
  assertEquals(args.parse({}), {});
  for (const bad of ["24", "20244", "20a4", "", "2024-01"]) {
    let threw = false;
    try {
      args.parse({ year: bad });
    } catch {
      threw = true;
    }
    assert(threw, `year "${bad}" must be rejected`);
  }
});

Deno.test("inspect takes no arguments", () => {
  const args = (model.methods as unknown as MethodMap).inspect.arguments;
  assertEquals(args.parse({}), {});
});
