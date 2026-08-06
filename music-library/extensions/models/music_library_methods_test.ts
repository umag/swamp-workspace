/**
 * Method-level tests for @magistr/music-library — every one of the 6 methods
 * (scan, dupes, verify, bpm, running, probe), happy path + a failure path
 * where one exists, driven through `model.methods.<m>.arguments.parse()` +
 * `.execute()`.
 *
 * music_library.ts is BYTE-FROZEN — every test here is a characterization
 * test that PINS the model's current, already-shipped behavior. It is not
 * red-green TDD: there is no new behavior to drive out.
 *
 * ONE seam: `sshRun` in music_library.ts calls `new Deno.Command("ssh", ...)`
 * .spawn()`, writes the SQL/file-list to stdin via `proc.stdin.getWriter()`,
 * then awaits `proc.output()` — the SAME dual-shape (spawn -> stdin.getWriter
 * -> write/close -> output()) as `observability-agent`'s stub, NOT skype's
 * `.output()`-only shape (that would never intercept this model's calls,
 * since sshRun always spawns). Every method funnels through this ONE
 * function, so a single stub covers scan/dupes/verify/bpm/probe; `running`
 * touches no ssh at all (reads a stored `bpm` resource via
 * `context.readResource`).
 *
 * The stub routes canned output by the SQL/command keyword CAPTURED FROM
 * STDIN (for the sqlite3 calls) or from the captured argv's trailing command
 * string (for the docker-wrapped ffmpeg/ffprobe/essentia calls) — never by
 * call order alone, since `scan` issues TRACKS_SQL then GENRES_SQL back to
 * back on the identical `sqlite3 -json -readonly '<dbPath>'` argv.
 *
 * Toolchain rule (deno 2.8.3 in CI): the `Deno.Command` seam is installed via
 * `(globalThis as any).Deno.Command = FakeCommand`, never a
 * `as typeof Deno.Command` cast; restored in `finally`.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { hash8, model, slugify } from "./music_library.ts";
import tracksFixture from "../../fixtures/tracks.json" with { type: "json" };
import genresFixture from "../../fixtures/genres.json" with { type: "json" };
import verifyFilesFixture from "../../fixtures/verify_files.json" with {
  type: "json",
};
import probeFixture from "../../fixtures/probe.json" with { type: "json" };
import headphonesArtistsFixture from "../../fixtures/headphones_artists.json" with {
  type: "json",
};
import mbReleaseGroupsFixture from "../../fixtures/mb_release_groups.json" with {
  type: "json",
};
import mbReleaseGroupsEmptyFixture from "../../fixtures/mb_release_groups_empty.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    host: "music.example",
    ...overrides,
  }) as Record<string, unknown>;
}

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type Store = Record<string, unknown>;

function makeCtx(
  globalArgOverrides: Record<string, unknown> = {},
  seed: Store = {},
) {
  const written: Written[] = [];
  const store: Store = { ...seed };
  return {
    written,
    store,
    ctx: {
      globalArgs: gArgs(globalArgOverrides),
      // Mirror the REAL MethodContext surface (swamp src/domain/models/model.ts).
      // There is no `context.modelName` — the instance name lives on
      // `definition.name`. A fake that invents `modelName` makes tests pass
      // against an API that does not exist at runtime.
      definition: {
        id: "f5fa0998-051a-4c25-acce-067692769c47",
        name: "music",
        version: 1,
        tags: {},
      },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        store[name] = payload;
        return Promise.resolve({ spec, name });
      },
      readResource: (name: string) => Promise.resolve(store[name] ?? null),
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

interface CapturedCall {
  binary: string;
  args: string[];
  stdin: string;
}
interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

function encodeOutput(r: CommandResult) {
  return {
    success: r.success,
    code: r.success ? 0 : 1,
    stdout: new TextEncoder().encode(r.stdout),
    stderr: new TextEncoder().encode(r.stderr),
  };
}

type Router = (call: CapturedCall) => CommandResult;

function installSshStub(router: Router) {
  const calls: CapturedCall[] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    #call: CapturedCall;
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      this.#call = {
        binary,
        args: (opts.args as string[] | undefined) ?? [],
        stdin: "",
      };
      calls.push(this.#call);
    }
    spawn() {
      const call = this.#call;
      return {
        stdin: {
          getWriter: () => ({
            write: (chunk: Uint8Array) => {
              call.stdin += new TextDecoder().decode(chunk);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => Promise.resolve(encodeOutput(router(call))),
      };
    }
  }
  g.Deno.Command = FakeCommand;
  return {
    calls,
    restore: () => {
      g.Deno.Command = original;
    },
  };
}

async function withSshStub(
  router: Router,
  fn: (stub: ReturnType<typeof installSshStub>) => Promise<unknown>,
) {
  const stub = installSshStub(router);
  try {
    await fn(stub);
  } finally {
    stub.restore();
  }
}

// The default containerMusicRoot ("/music") — used to build the cpath keys a
// router's outcome/record maps are keyed on, matching what the model itself
// computes.
const CROOT = "/music";

function relOfRow(
  r: { left_path: string; right_path: string; filename: string },
): string {
  return `${r.left_path}${r.right_path}/${r.filename}`;
}
function cpathOfRow(
  r: { left_path: string; right_path: string; filename: string },
): string {
  return `${CROOT}/${relOfRow(r)}`;
}

/** Builds a router that dispatches by content-sniffing the captured argv's
 * trailing command string and, for sqlite3 calls, the captured stdin SQL
 * text — exactly the boundary sshRun() presents for every method. */
function makeRouter(opts: {
  tracks?: unknown[];
  genres?: unknown[];
  verifyRows?: unknown[];
  probe?: unknown;
  verifyOutcomes?: Record<string, { rc: number; body: string }>;
  bpmRecords?: Record<string, string>;
} = {}): Router {
  return (call) => {
    const cmd = call.args[call.args.length - 1] ?? "";
    if (cmd.includes("sqlite3")) {
      if (call.stdin.includes("track_genres")) {
        return {
          success: true,
          stdout: JSON.stringify(opts.genres ?? []),
          stderr: "",
        };
      }
      if (call.stdin.includes("tag_title")) {
        return {
          success: true,
          stdout: JSON.stringify(opts.tracks ?? []),
          stderr: "",
        };
      }
      return {
        success: true,
        stdout: JSON.stringify(opts.verifyRows ?? []),
        stderr: "",
      };
    }
    if (cmd.includes("ffprobe")) {
      return {
        success: true,
        stdout: JSON.stringify(opts.probe ?? {}),
        stderr: "",
      };
    }
    if (cmd.includes("ffmpeg")) {
      const lines = call.stdin.split("\n").filter((l) => l.length > 0);
      const records = lines.map((line) => {
        const m = line.match(/^(\d+(?:\.\d+)?)\s(.+)$/);
        const path = m ? m[2] : line;
        const outcome = opts.verifyOutcomes?.[path] ??
          { rc: 0, body: "size=N/A time=00:03:00.00 bitrate=N/A speed=200x\n" };
        return `${path}\x1f${outcome.rc}\x1f${outcome.body}\x1e`;
      });
      return { success: true, stdout: records.join(""), stderr: "" };
    }
    if (cmd.includes("python3") || cmd.includes("essentia")) {
      const lines = call.stdin.split("\n").filter((l) => l.length > 0);
      const records = lines.map((path) =>
        opts.bpmRecords?.[path] ??
          JSON.stringify({ path, rc: 1, err: "no fixture for path" })
      );
      return { success: true, stdout: records.join("\n") + "\n", stderr: "" };
    }
    throw new Error(`unrouted ssh command: ${cmd}`);
  };
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

Deno.test("scan: happy path — writes album/artist/dimension/issues/library resources from TRACKS_SQL + GENRES_SQL", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ tracks: tracksFixture, genres: genresFixture }),
    () => run("scan", {}, ctx),
  );
  const albums = written.filter((w) => w.spec === "album");
  const artists = written.filter((w) => w.spec === "artist");
  const dims = written.filter((w) => w.spec === "dimension");
  const issues = written.find((w) => w.spec === "issues");
  const library = written.find((w) => w.spec === "library")!;

  // 8 fixture rows -> 5 album dirs (Aurora Drift, Night Drift, Vespro, the
  // 2-disc Box collapsed to 1, VA Night Radio)
  assertEquals(albums.length, 5);
  assertEquals(dims.length, 4, "genres/years/formats/quality rollups");
  assert(issues, "an issues resource is always written");
  assertEquals(library.name, "summary");
  assertEquals(library.payload.totals, {
    tracks: 8,
    albums: 5,
    artists: 6,
    genres: 3,
    durationSec: 2278,
    sizeBytes: 89100000,
  });
  assertEquals(artists.length, 6);
  assertEquals(library.payload.db, {
    host: "music.example",
    path: "/mnt/user/media-server/gonicdata/gonic.db",
  });

  // the cp1251 mojibake artist tag (id 4) is recovered and recorded
  const issuesPayload = issues!.payload as {
    encodingFixes: Array<{ before: string; after: string; encoding: string }>;
  };
  const fix = issuesPayload.encodingFixes.find((f) =>
    f.before === "Êëàóäèî Ìîíòåâåðäè"
  );
  assert(fix, "the mojibake artist tag must be recovered and recorded");
  assertEquals(fix!.after, "Клаудио Монтеверди");
});

Deno.test("scan: dryRun writes ONLY the library summary — no album/artist/dimension/issues resources", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ tracks: tracksFixture, genres: genresFixture }),
    () => run("scan", { dryRun: true }, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "library");
  assertEquals(
    (written[0].payload.params as { dryRun: boolean }).dryRun,
    true,
  );
});

Deno.test("scan: pathPrefix + maxAlbums are threaded through to buildCube via params", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ tracks: tracksFixture, genres: genresFixture }),
    () => run("scan", { pathPrefix: "Echo Fields", maxAlbums: 1 }, ctx),
  );
  const albums = written.filter((w) => w.spec === "album");
  assertEquals(albums.length, 1);
  assertEquals(
    (albums[0].payload.dir as string).startsWith("Echo Fields"),
    true,
  );
  const library = written.find((w) => w.spec === "library")!;
  assertEquals(library.payload.params, {
    pathPrefix: "Echo Fields",
    maxAlbums: 1,
    dryRun: false,
  });
});

// ---------------------------------------------------------------------------
// dupes
// ---------------------------------------------------------------------------

Deno.test("dupes: happy path — writes a dupes resource with stats + clusters, calling ONLY TRACKS_SQL (no genres query)", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ tracks: tracksFixture }),
    async (stub) => {
      await run("dupes", {}, ctx);
      assertEquals(stub.calls.length, 1, "dupes never queries GENRES_SQL");
    },
  );
  const res = written.find((w) => w.spec === "dupes")!;
  assertEquals(res.name, "dupes");
  assert(Array.isArray(res.payload.albumClusters));
  assert(Array.isArray(res.payload.trackClusters));
  assertEquals(
    (res.payload.stats as { trackClustersTruncated: boolean })
      .trackClustersTruncated,
    false,
  );
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

const V = verifyFilesFixture as Array<
  { filename: string; length: number; left_path: string; right_path: string }
>;
const [vOk1, vOk2, vFailed, vTruncated] = V;

function verifyOutcomes() {
  return {
    [cpathOfRow(vOk1)]: {
      rc: 0,
      body: "size=N/A time=00:04:05.00 bitrate=N/A speed=300x\n",
    }, // 245s, matches expected exactly -> ok
    [cpathOfRow(vOk2)]: {
      rc: 0,
      body: "size=N/A time=00:03:58.00 bitrate=N/A speed=300x\n",
    }, // 238s, matches expected exactly -> ok
    [cpathOfRow(vFailed)]: {
      rc: 1,
      body: "Error opening input: No such file or directory\n",
    },
    [cpathOfRow(vTruncated)]: {
      rc: 0,
      body: "size=N/A time=00:01:00.00 bitrate=N/A speed=300x\n",
    }, // decoded only 60s of an expected 240s -> truncated
  };
}

Deno.test("verify: happy path over the whole library — ok/failed/truncated are correctly classified and counted", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ verifyRows: V, verifyOutcomes: verifyOutcomes() }),
    () => run("verify", {}, ctx),
  );
  const res = written.find((w) => w.spec === "verify")!;
  assertEquals(res.name, "verify-library");
  assertEquals(res.payload.mode, "full");
  assertEquals(res.payload.checked, 4);
  assertEquals(res.payload.ok, 2);
  assertEquals(res.payload.failed, 1);
  assertEquals(res.payload.truncated, 1);
  assertEquals(res.payload.errors, 0);
  assertEquals(res.payload.missingRecords, 0);
  const problems = res.payload.problems as Array<
    { path: string; status: string }
  >;
  assertEquals(problems.length, 2);
  assert(problems.some((p) => p.status === "failed"));
  assert(problems.some((p) => p.status === "truncated"));
});

Deno.test("verify: a single explicit `path` forces full mode and skips the sqlite3 query entirely", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ verifyOutcomes: verifyOutcomes() }),
    async (stub) => {
      await run(
        "verify",
        { path: relOfRow(vOk1), mode: "quick" },
        ctx,
      );
      assertEquals(
        stub.calls.length,
        1,
        "no sqlite3 lookup for a single explicit path",
      );
      assert(stub.calls[0].args.join(" ").includes("ffmpeg"));
    },
  );
  const res = written.find((w) => w.spec === "verify")!;
  assertEquals(res.payload.mode, "full", "path= always forces full mode");
  const base = relOfRow(vOk1).split("/").pop()!;
  assertEquals(
    res.name,
    `verify-file-${slugify(base)}-${hash8(relOfRow(vOk1))}`,
  );
  assertEquals(res.payload.checked, 1);
  assertEquals(res.payload.ok, 1);
});

Deno.test("verify: quick mode prefixes each stdin line with a numeric seek offset (expectedSec - quickTailSec)", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({ verifyRows: [vOk1], verifyOutcomes: verifyOutcomes() }),
    async (stub) => {
      await run("verify", { mode: "quick", quickTailSec: 15 }, ctx);
      const stdin =
        stub.calls.find((c) => c.args.join(" ").includes("ffmpeg"))!.stdin;
      assertEquals(stdin.trim(), `${245 - 15} ${cpathOfRow(vOk1)}`);
    },
  );
});

Deno.test("verify: concurrency=1 sends every file over ONE ssh call, newline-joined", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({ verifyRows: V, verifyOutcomes: verifyOutcomes() }),
    async (stub) => {
      await run("verify", { concurrency: 1 }, ctx);
      const ffmpegCalls = stub.calls.filter((c) =>
        c.args.join(" ").includes("ffmpeg")
      );
      assertEquals(ffmpegCalls.length, 1);
      assertEquals(
        ffmpegCalls[0].stdin.trim().split("\n").length,
        4,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// bpm
// ---------------------------------------------------------------------------

function bpmRecord(
  r: { left_path: string; right_path: string; filename: string },
  over: Record<string, unknown> = {},
): string {
  const cpath = cpathOfRow(r);
  return JSON.stringify({
    path: cpath,
    lengthSec: 240,
    windowed: false,
    analyzedSec: 240,
    bpm: 128.4,
    beatsConfidence: 2.1,
    beatsCount: 500,
    ibiCv: 0.02,
    estStd: 1.5,
    key: "C",
    scale: "major",
    keyStrength: 0.7,
    danceability: 1.0,
    ms: 3000,
    rc: 0,
    ...over,
  });
}

Deno.test("bpm: happy path — analyzes every eligible track, carries no prior data on a first run", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({
      verifyRows: V,
      bpmRecords: {
        [cpathOfRow(vOk1)]: bpmRecord(vOk1),
        [cpathOfRow(vOk2)]: bpmRecord(vOk2, { bpm: 140 }),
        [cpathOfRow(vFailed)]: JSON.stringify({
          path: cpathOfRow(vFailed),
          rc: 1,
          err: "too short to analyze: 4.00s",
        }),
        [cpathOfRow(vTruncated)]: bpmRecord(vTruncated, { bpm: 90 }),
      },
    }),
    () => run("bpm", {}, ctx),
  );
  const res = written.find((w) => w.spec === "bpm")!;
  assertEquals(res.name, "bpm-library");
  assertEquals(res.payload.analyzed, 3);
  assertEquals(res.payload.carriedOver, 0);
  assertEquals(res.payload.failed, 1);
  assertEquals(res.payload.newlyFailed, 1);
  assertEquals(res.payload.skippedShort, 0);
  assertEquals(res.payload.skippedLong, 0);
});

Deno.test("bpm: reanalyze=false carries prior tracks/failures over instead of re-querying them", async () => {
  const priorTracks = [{
    path: relOfRow(vOk1),
    bpm: 128.4,
    beatsConfidence: 2.1,
    confidenceBand: "good",
    beatsCount: 500,
    ibiCv: 0.02,
    estStd: 1.5,
    key: "C",
    scale: "major",
    keyStrength: 0.7,
    danceability: 1.0,
    lengthSec: 245,
    analyzedSec: 245,
    windowed: false,
    ms: 3000,
  }];
  const { ctx, written } = makeCtx({}, {
    "bpm-library": { tracks: priorTracks, failures: [] },
  });
  await withSshStub(
    makeRouter({
      verifyRows: V,
      bpmRecords: {
        [cpathOfRow(vOk2)]: bpmRecord(vOk2, { bpm: 140 }),
        [cpathOfRow(vFailed)]: JSON.stringify({
          path: cpathOfRow(vFailed),
          rc: 1,
          err: "too short",
        }),
        [cpathOfRow(vTruncated)]: bpmRecord(vTruncated, { bpm: 90 }),
      },
    }),
    (stub) => {
      // vOk1 must never appear in what's sent for (re)analysis this run
      return run("bpm", {}, ctx).then(() => {
        const sent = stub.calls.filter((c) =>
          c.args.join(" ").includes("essentia")
        ).flatMap((c) => c.stdin.split("\n")).filter((l) => l.length > 0);
        assert(!sent.includes(cpathOfRow(vOk1)));
      });
    },
  );
  const res = written.find((w) => w.spec === "bpm")!;
  assertEquals(res.payload.carriedOver, 1);
  assertEquals(res.payload.analyzed, 2);
  const tracks = res.payload.tracks as Array<{ path: string }>;
  assert(tracks.some((t) => t.path === relOfRow(vOk1)));
});

Deno.test("bpm: a single explicit `path` skips the sqlite3 query", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ bpmRecords: { [cpathOfRow(vOk1)]: bpmRecord(vOk1) } }),
    async (stub) => {
      await run("bpm", { path: relOfRow(vOk1) }, ctx);
      assertEquals(stub.calls.length, 1);
    },
  );
  const res = written.find((w) => w.spec === "bpm")!;
  assertEquals(res.payload.analyzed, 1);
});

// ---------------------------------------------------------------------------
// running — touches NO ssh; reads a stored bpm resource via readResource
// ---------------------------------------------------------------------------

const RUN_TRACKS = [
  {
    path: "a/steady.flac",
    bpm: 180,
    beatsConfidence: 3.0,
    danceability: 1.0,
    key: "C",
    scale: "major",
    lengthSec: 200,
  },
  {
    path: "b/rubato.flac",
    bpm: 90,
    beatsConfidence: 0.4,
    danceability: 0.5,
    key: "D",
    scale: "minor",
    lengthSec: 300,
  },
];

Deno.test("running: happy path — builds a playlist from a seeded bpm resource, no ssh call made", async () => {
  const { ctx, written } = makeCtx({}, {
    "bpm-library": { tracks: RUN_TRACKS },
  });
  const stub = installSshStub(() => {
    throw new Error("running() must never touch ssh");
  });
  try {
    await run("running", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.calls.length, 0);
  const res = written.find((w) => w.spec === "playlist")!;
  assertEquals(res.name, "running-library-150-190");
  assertEquals(res.payload.source, "bpm-library");
  assertEquals(res.payload.sourceAnalyzed, 2);
  assertEquals(res.payload.eligible, 1);
  assertEquals(res.payload.excluded, { noPulse: 1, outOfRange: 0 });
});

Deno.test("running: no bpm data at the expected resource name throws a pointer to the bpm method", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () => run("running", {}, ctx),
    Error,
    "No bpm analysis found",
  );
});

// REGRESSION. The pointer above used to interpolate `context.modelName`, which
// is not a field on swamp's MethodContext (see model.ts — it exposes
// definition/modelId/modelType/methodName/..., and `modelName` appears in the
// runtime source only as a PARAMETER of readModelData). Users were therefore
// told to run `swamp model method run undefined bpm`. The bug survived because
// the assertion above stops at the static prefix and never inspects the
// interpolated value — and because the test fake used to invent a `modelName`
// field, so the double agreed with code the runtime disagreed with. Assert the
// resolved instance name, and assert "undefined" is absent.
Deno.test("running: the bpm pointer names the real instance, never 'undefined'", async () => {
  const { ctx } = makeCtx();
  const err = await assertRejects(
    () => run("running", {}, ctx),
    Error,
  );
  assertStringIncludes(err.message, "swamp model method run music bpm");
  assertEquals(
    err.message.includes("undefined"),
    false,
    `error message must not leak an unresolved interpolation: ${err.message}`,
  );
});

Deno.test("running: minSpm > maxSpm rejects before ever reading the bpm resource", async () => {
  const { ctx } = makeCtx({}, { "bpm-library": { tracks: RUN_TRACKS } });
  await assertRejects(
    () => run("running", { minSpm: 200, maxSpm: 100 }, ctx),
    Error,
    "is above maxSpm",
  );
});

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

Deno.test("probe: happy path — merges format+stream tags, recovers the mojibake artist tag, records the trace", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ probe: probeFixture }),
    () =>
      run("probe", {
        path: "Early Music Ensemble - Vespro (2001)/01 - Vespro.flac",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "probe")!;
  assertEquals(res.payload.tags, {
    artist: "Клаудио Монтеверди",
    album: "Vespro Della Beata Vergine",
    title: "Vespro",
  });
  const trace = res.payload.encodingTrace as Array<
    { field: string; before: string; after: string }
  >;
  assertEquals(trace.length, 1);
  assertEquals(trace[0].field, "artist");
  assertEquals(
    (res.payload.audioStream as { codec_name: string }).codec_name,
    "flac",
  );
});

// ---------------------------------------------------------------------------
// resolve-artists / wanted — RED phase: both `execute` bodies are stubs that
// `throw new Error("not implemented")`, so every test below fails on that
// thrown error (an uncaught rejection from the plain `await run(...)` calls,
// or an assertRejects message mismatch for the two "actionable error" tests)
// rather than on an import or type error — behaviour is missing, the
// signatures are not.
//
// Both methods are the first on this model to read ANOTHER swamp model
// instance's data via `context.readModelData(instanceName, specName)` — a
// NEW context capability the six pre-existing methods never needed (they
// only ever touch this model's own ssh/sqlite/ffmpeg/ffprobe/essentia
// surface via sshRun, or a single named resource of their OWN model via
// readResource/writeResource). Verified live: readModelData returns an
// ARRAY of ROW objects, and parsed content is reached via
// `row.attributes.<field>` (`row.data` does not exist).
//
// resolve-artists ALSO reads this model's own already-scanned `artist`
// dimension the same way — `context.readModelData(context.definition.name,
// "artist")` — because the artists that need MusicBrainz IDs are the ones
// actually OWNED in the library (scan's `artist` resource), not merely the
// subset headphones happens to track; headphones is a seed/cache, not the
// source of truth for which artists exist. `wanted` reads its own `album`
// dimension the same way (`context.readModelData(context.definition.name,
// "album")`) for the owned cube.
//
// NOTE the accessor: it is `context.definition.name`, NOT `context.modelName`.
// The real MethodContext (swamp src/domain/models/model.ts) exposes
// { signal, repoDir, modelType, modelId, globalArgs, definition, methodName,
// logger, ... } — `modelName` appears in that source only as a PARAMETER of
// readModelData, never as a field on the context.
// ---------------------------------------------------------------------------

/** Wraps a raw attributes payload the way a readModelData row is shaped. */
function mdRow(attributes: Record<string, unknown>) {
  return { attributes };
}

type ModelData = Record<string, Record<string, unknown[]>>;

/** A single context.runModel call, decoded to its named fields (the shape
 * resolve-artists actually passes: {definition, method, arguments}). */
type RunModelCall = {
  definition: string;
  method: string;
  arguments: Record<string, unknown>;
};

/** Extends makeCtx with a context.readModelData(instanceName, specName)
 * mock and a context.runModel spy, additive to the ssh-stub harness above
 * (readModelData/runModel are a seam scan/dupes/verify/bpm/running/probe
 * never exercise). The OPTIONAL `runModelHandler` may mutate `modelData` in
 * response to a call — e.g. synthesizing an artistSearchBatch row from the
 * RECORDED queries and echoing the caller's generated `batchId` — since the
 * batchId is generated at runtime and can never be pre-seeded into a static
 * fixture. Purely additive: the default (no handler) is unchanged from
 * before, so every existing call site is untouched. */
function makeModelDataCtx(
  modelData: ModelData = {},
  seed: Store = {},
  globalArgOverrides: Record<string, unknown> = {},
  runModelHandler?: (call: RunModelCall) => void,
) {
  const base = makeCtx(globalArgOverrides, seed);
  const runModelCalls: unknown[][] = [];
  const ctx = {
    ...base.ctx,
    readModelData: (instanceName: string, specName: string) =>
      Promise.resolve(modelData[instanceName]?.[specName] ?? []),
    runModel: (...callArgs: unknown[]) => {
      runModelCalls.push(callArgs);
      const [call] = callArgs as [RunModelCall];
      runModelHandler?.(call);
      return Promise.resolve({ dataHandles: [] });
    },
  };
  return { ...base, ctx, runModelCalls };
}

/** Same shape as installSshStub, for the MusicBrainz search fallback
 * resolve-artists reaches over `fetch` (not ssh — MusicBrainz is a public
 * HTTP API, unlike the gonic host). */
function installFetchStub(router: (url: string) => unknown) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(router(url)), { status: 200 }),
    );
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Outcome `resolve` may return for one query, fed to `mbBatchHandler`
 * below. `undefined` means the query is DEFERRED — absent from the
 * synthesized `queries[]` and present in `deferred[]`, exactly like a real
 * search-artists-batch run that hit a ceiling before reaching it. */
type BatchQueryOutcome =
  | { artists: Array<{ id: string; name: string; "sort-name"?: string }> }
  | { error: string }
  | undefined;

/**
 * Builds a context.runModel handler for `search-artists-batch` that
 * synthesizes an `artistSearchBatch` row from the RECORDED queries and
 * writes it into `modelData`, echoing the caller's GENERATED `batchId` —
 * this is required, not cosmetic: the caller generates `batchId` at
 * runtime, so a pre-seeded static row can never match it. `resolve(query)`
 * decides each query's outcome (see `BatchQueryOutcome`). The static
 * `mb_artist_search_batch.json` fixture is the SHAPE TEMPLATE for the
 * contract pin only — never this seam's data source.
 */
function mbBatchHandler(
  modelData: ModelData,
  resolve: (query: string) => BatchQueryOutcome,
  instanceName = "musicbrainz",
) {
  return (call: RunModelCall) => {
    if (call.method !== "search-artists-batch") return;
    const queries = call.arguments.queries as string[];
    const batchId = call.arguments.batchId as string;
    const queryRows: Array<Record<string, unknown>> = [];
    const deferred: string[] = [];
    let failed = 0;
    for (const q of queries) {
      const outcome = resolve(q);
      if (outcome === undefined) {
        deferred.push(q);
        continue;
      }
      if ("error" in outcome) {
        failed++;
        queryRows.push({
          query: q,
          artists: [],
          count: 0,
          error: outcome.error,
        });
      } else {
        queryRows.push({
          query: q,
          artists: outcome.artists,
          count: outcome.artists.length,
        });
      }
    }
    if (!modelData[instanceName]) modelData[instanceName] = {};
    const existing = modelData[instanceName]["artistSearchBatch"] ?? [];
    modelData[instanceName]["artistSearchBatch"] = [
      ...existing,
      mdRow({
        batchId,
        queries: queryRows,
        deferred,
        requested: queries.length,
        searched: queryRows.length,
        failed,
        truncated: deferred.length > 0,
        stopReason: deferred.length > 0 ? "max-queries" : "complete",
        timestamp: new Date().toISOString(),
      }),
    ];
  };
}

// A headphones seed that covers every artist the (mirrored) library reports,
// so resolving it never needs a MusicBrainz search.
const LIBRARY_ARTISTS_SEED_COVERED = (
  headphonesArtistsFixture as { artists: Array<{ ArtistName: string }> }
).artists.map((a) =>
  mdRow({ kind: "artist", key: a.ArtistName.toLowerCase(), name: a.ArtistName })
);

Deno.test("resolve-artists: seed rows are read via row.attributes.artists — a library fully covered by the headphones seed resolves without any MusicBrainz search", async () => {
  const { ctx, written, runModelCalls } = makeModelDataCtx({
    headphones: { artists: [mdRow(headphonesArtistsFixture)] },
    music: { artist: LIBRARY_ARTISTS_SEED_COVERED },
  });
  await run("resolve-artists", {}, ctx);
  // The MusicBrainz search fallback is reached via context.runModel (routed
  // through the @musicbrainz/api instance), not `fetch` — so the "seed
  // covers everything, no search happens" invariant is now asserted on
  // runModelCalls, the seam this fallback actually calls.
  assertEquals(runModelCalls.length, 0);
  const res = written.find((w) => w.spec === "artistMap")!;
  assertEquals(
    res.payload.resolved,
    (headphonesArtistsFixture as { artists: unknown[] }).artists.length,
  );
  assertEquals(res.payload.unresolved, 0);
  assertEquals(res.payload.ambiguous, 0);
  const entries = res.payload.entries as Array<
    { artistName: string; mbid: string; source: string }
  >;
  const velvet = entries.find((e) => e.artistName === "Velvet Static")!;
  assertEquals(velvet.mbid, "cafebabe-fa57-4f00-9dec-afbadcafebab");
  assertEquals(velvet.source, "seed");
});

Deno.test("resolve-artists: an artist the seed does not cover falls back to a MusicBrainz search routed through search-artists-batch + readModelData, resolving on a single candidate", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow(headphonesArtistsFixture)] },
    music: {
      artist: [
        ...LIBRARY_ARTISTS_SEED_COVERED,
        mdRow({ kind: "artist", key: "aurora-drift", name: "Aurora Drift" }),
      ],
    },
  };
  const { ctx, written, runModelCalls } = makeModelDataCtx(
    modelData,
    {},
    {},
    mbBatchHandler(modelData, (query) => {
      if (query === 'artist:"Aurora Drift"') {
        return {
          artists: [{
            id: "01234567-89ab-4cde-8f01-23456789abcd",
            name: "Aurora Drift",
            "sort-name": "Aurora Drift",
          }],
        };
      }
      return { artists: [] };
    }),
  );

  await run("resolve-artists", {}, ctx);

  // Exactly ONE batched call for every artist the seed doesn't cover — the
  // fix for musicbrainz-ratelimit-runmodel-fanout: N runModel calls (one per
  // artist, each losing rate-limit spacing across the fan-out) collapse into
  // one call to search-artists-batch, which loops internally.
  assertEquals(runModelCalls.length, 1);
  const [callArgs] = runModelCalls[0] as [
    { definition: string; method: string; arguments: { queries: string[] } },
  ];
  assertEquals(callArgs.definition, "musicbrainz");
  assertEquals(callArgs.method, "search-artists-batch");
  assertEquals(callArgs.arguments.queries, ['artist:"Aurora Drift"']);

  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    {
      artistName: string;
      mbid: string | null;
      status: string;
      source: string | null;
      checkedAt?: string;
    }
  >;
  const aurora = entries.find((e) => e.artistName === "Aurora Drift")!;
  assertEquals(aurora.status, "resolved");
  assertEquals(aurora.mbid, "01234567-89ab-4cde-8f01-23456789abcd");
  assertEquals(aurora.source, "search");
  assertEquals(
    typeof aurora.checkedAt,
    "string",
    "a search verdict must stamp checkedAt so a future run's freshness check has something to compare against",
  );
});

// ---------------------------------------------------------------------------
// resolve-artists: THE 25-CANDIDATE WINDOW — the deleted per-artist path
// called search-artist with no `limit`, so MusicBrainz applied its /ws/2
// default of 25 candidates. search-artists-batch defaults `limit` to 10
// (a deliberate plan decision for its OTHER callers), so without an
// explicit override here the candidate window silently narrowed 25 -> 10:
// a duplicate MBID ranked 11-25 becomes invisible to matchArtist, which
// reports `ambiguous` only when two or more DISTINCT MBIDs share the query's
// token set — an invisible duplicate lets a single top-ranked candidate get
// auto-picked as `resolved` instead of correctly parking as `ambiguous`.
// ---------------------------------------------------------------------------

Deno.test("resolve-artists: passes limit: 25 to search-artists-batch — restores the pre-batch candidate window search-artist got from MusicBrainz's own /ws/2 default", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-window-artist",
          name: "Fixture Window Artist",
        }),
      ],
    },
  };
  const { ctx, runModelCalls } = makeModelDataCtx(
    modelData,
    {},
    {},
    mbBatchHandler(modelData, () => ({ artists: [] })),
  );

  await run("resolve-artists", {}, ctx);

  assertEquals(runModelCalls.length, 1);
  const [callArgs] = runModelCalls[0] as [
    { arguments: { limit?: number } },
  ];
  assertEquals(
    callArgs.arguments.limit,
    25,
    "resolve-artists must explicitly request the pre-batch 25-candidate window, not search-artists-batch's own default of 10 — that default is a deliberate plan decision for OTHER callers and must not change",
  );
});

Deno.test("resolve-artists: a duplicate MBID ranked 11-25 is still visible with the restored limit:25 window — parks as ambiguous instead of auto-picking the top-ranked candidate", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-common-name",
          name: "Fixture Common Name",
        }),
      ],
    },
  };

  // 25 raw MusicBrainz search hits for the one query, simulating a phrase
  // query that returns many partial-token-overlap filler hits ranked ahead
  // of a genuine second matching artist — realistic for a short/common
  // name. Two DISTINCT ids match the FULL token set of "Fixture Common
  // Name": rank 0 (always visible) and rank 14 (position 15, inside
  // 11-25 — visible only when the full 25-candidate window is requested).
  const DUPLICATE_RANK = 14;
  const fullHits = Array.from({ length: 25 }, (_, i) => {
    if (i === 0) {
      return {
        id: "cafebabe-a001-4a57-8bad-f00dfeedca01",
        name: "Fixture Common Name",
        "sort-name": "Fixture Common Name",
      };
    }
    if (i === DUPLICATE_RANK) {
      return {
        id: "cafebabe-a002-4a57-8bad-f00dfeedca02",
        name: "Fixture Common Name",
        "sort-name": "Fixture Common Name",
      };
    }
    return {
      id: `deadbeef-0000-4a57-8bad-f00dfeed${i.toString(16).padStart(4, "0")}`,
      name: `Fixture Filler Artist ${i}`,
      "sort-name": `Fixture Filler Artist ${i}`,
    };
  });

  const { ctx, written, runModelCalls } = makeModelDataCtx(
    modelData,
    {},
    {},
    (call) => {
      if (call.method !== "search-artists-batch") return;
      const queries = call.arguments.queries as string[];
      // Mirrors search-artists-batch's OWN `args.limit ?? 10` default
      // (musicbrainz.ts:1140) — this is what makes the test fail without
      // resolve-artists' explicit `limit: 25`: an unset `limit` here
      // truncates to the top 10 hits, hiding the rank-14 duplicate.
      const limit = (call.arguments.limit as number | undefined) ?? 10;
      if (!modelData.musicbrainz) modelData.musicbrainz = {};
      modelData.musicbrainz.artistSearchBatch = [
        mdRow({
          batchId: call.arguments.batchId,
          queries: queries.map((q) => ({
            query: q,
            artists: fullHits.slice(0, limit),
            count: fullHits.length,
          })),
          deferred: [],
          requested: queries.length,
          searched: queries.length,
          failed: 0,
          truncated: false,
          stopReason: "complete",
          timestamp: "x",
        }),
      ];
    },
  );

  await run("resolve-artists", {}, ctx);

  assertEquals(runModelCalls.length, 1);
  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    { artistName: string; status: string; mbid: string | null }
  >;
  const entry = entries.find((e) => e.artistName === "Fixture Common Name")!;
  assertEquals(
    entry.status,
    "ambiguous",
    "the rank-14 duplicate MBID must be visible within the 25-candidate window, parking this artist as ambiguous rather than auto-picking the rank-0 candidate as resolved",
  );
  assertEquals(entry.mbid, null);
  assertEquals(res.payload.ambiguous, 1);
  assertEquals(res.payload.resolved, 0);
});

// ---------------------------------------------------------------------------
// resolve-artists: THE PRIOR-MAP READ AND MERGE SEMANTICS (steps 10-11 of
// musicbrainz-ratelimit-runmodel-fanout). Round 1's CRITICAL: without the
// prior-map load, "a converged re-run costs zero requests" never happens,
// and the naive improvisation — skip the search and fall through — wipes
// every resolved/ambiguous entry the live map holds. Test (a) below is the
// ONLY gate on that failure mode; its fixture is stated identically here
// and in the plan's testStrategy invariant (B) and must not drift.
// ---------------------------------------------------------------------------

const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

/** artist-map entries A, B, C, E, F — the PRIOR map. */
const PRIOR_ARTIST_MAP_ABCEF = {
  kind: "artistMap",
  scannedAt: "2026-08-04T00:00:00.000Z",
  params: {
    headphonesInstance: "headphones",
    musicbrainzInstance: "musicbrainz",
  },
  resolved: 3,
  ambiguous: 1,
  unresolved: 0,
  entries: [
    {
      artistKey: "fixture-artist-a",
      artistName: "Fixture Old Name",
      mbid: "deadbeef-0000-4000-8000-00000000000a",
      status: "resolved",
      source: "search",
      candidates: [],
      checkedAt: ONE_HOUR_AGO,
    },
    {
      artistKey: "fixture-artist-b",
      artistName: "Fixture Artist B",
      mbid: null,
      status: "ambiguous",
      source: null,
      candidates: [
        { id: "b1000000-0000-4000-8000-0000000000b1", name: "Fixture B One" },
        { id: "b2000000-0000-4000-8000-0000000000b2", name: "Fixture B Two" },
      ],
      checkedAt: ONE_HOUR_AGO,
    },
    {
      artistKey: "fixture-artist-c",
      artistName: "Fixture Artist C",
      mbid: "c0000000-0000-4000-8000-00000000000c",
      status: "resolved",
      source: "seed",
      candidates: [],
    },
    {
      artistKey: "fixture-artist-e",
      artistName: "Fixture Artist E Gone",
      mbid: "e0000000-0000-4000-8000-00000000000e",
      status: "resolved",
      source: "seed",
      candidates: [],
    },
    {
      artistKey: "fixture-artist-f",
      artistName: "Fixture Artist F",
      mbid: "f0000000-0000-4000-8000-priorstale0f",
      status: "resolved",
      source: "search",
      candidates: [],
      checkedAt: ONE_HOUR_AGO,
    },
  ],
};

/** LIBRARY holds A, B, C, D, F — E is gone, D is new. */
const LIBRARY_ROWS_ABCDF = [
  mdRow({ kind: "artist", key: "fixture-artist-a", name: "Fixture New Name" }),
  mdRow({ kind: "artist", key: "fixture-artist-b", name: "Fixture Artist B" }),
  mdRow({ kind: "artist", key: "fixture-artist-c", name: "Fixture Artist C" }),
  mdRow({ kind: "artist", key: "fixture-artist-d", name: "Fixture Artist D" }),
  mdRow({ kind: "artist", key: "fixture-artist-f", name: "Fixture Artist F" }),
];

/** HEADPHONES SEED covers C, D, F — with a NEW mbid for F, distinct from its
 * prior "f0000000-...-priorstale0f", to prove the seed's mbid wins on
 * re-derivation rather than the stale prior one. */
const HEADPHONES_SEED_CDF = {
  artists: [
    {
      ArtistID: "c0000000-0000-4000-8000-00000000000c",
      ArtistName: "Fixture Artist C",
      Status: "Active",
    },
    {
      ArtistID: "d0000000-0000-4000-8000-00000000000d",
      ArtistName: "Fixture Artist D",
      Status: "Active",
    },
    {
      ArtistID: "f1111111-0000-4000-8000-00000000000f",
      ArtistName: "Fixture Artist F",
      Status: "Active",
    },
  ],
  total: 3,
  timestamp: "2026-08-04T00:00:00.000Z",
};

Deno.test("resolve-artists (invariant B): PRESERVATION + IDENTITY — nothing needs a MusicBrainz verdict, so the batch never runs; the prior map's resolved/ambiguous verdicts are reused verbatim EXCEPT the library's current name, D is written, E is dropped, and F flips seed with NO checkedAt", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow(HEADPHONES_SEED_CDF)] },
    music: { artist: LIBRARY_ROWS_ABCDF },
  };
  const { ctx, written, runModelCalls } = makeModelDataCtx(
    modelData,
    { "artist-map": PRIOR_ARTIST_MAP_ABCEF },
  );

  await run("resolve-artists", {}, ctx);

  assertEquals(
    runModelCalls.length,
    0,
    "A/B are reused via a fresh prior, C/D/F resolve via the seed — nothing needs a search this run",
  );

  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    {
      artistKey: string;
      artistName: string;
      mbid: string | null;
      status: string;
      source: string | null;
      candidates: Array<{ id: string; name: string }>;
      checkedAt?: string;
    }
  >;

  const a = entries.find((e) => e.artistKey === "fixture-artist-a")!;
  assertEquals(
    a.artistName,
    "Fixture New Name",
    "the LIBRARY name must win, even though the prior mbid/status/source/checkedAt are reused verbatim — kills {...prior} and Object.assign({}, prior)",
  );
  assertEquals(a.mbid, "deadbeef-0000-4000-8000-00000000000a");
  assertEquals(a.status, "resolved");
  assertEquals(a.source, "search");
  assertEquals(a.checkedAt, ONE_HOUR_AGO);

  const b = entries.find((e) => e.artistKey === "fixture-artist-b")!;
  assertEquals(b.status, "ambiguous");
  assertEquals(
    b.candidates.map((c) => c.id).sort(),
    [
      "b1000000-0000-4000-8000-0000000000b1",
      "b2000000-0000-4000-8000-0000000000b2",
    ],
  );

  const d = entries.find((e) => e.artistKey === "fixture-artist-d");
  assert(
    d,
    "D exists in the library but not the prior map — it must be written (kills the 'write the prior map back verbatim' short-circuit)",
  );
  assertEquals(d!.status, "resolved");
  assertEquals(d!.source, "seed");

  const e = entries.find((e) => e.artistKey === "fixture-artist-e");
  assertEquals(
    e,
    undefined,
    "E is in the prior map but not the library — it must be ABSENT (kills 'write the prior map back verbatim')",
  );

  const f = entries.find((e) => e.artistKey === "fixture-artist-f")!;
  assertEquals(
    f.source,
    "seed",
    "F is now seed-covered, so its verdict must be RE-DERIVED, not carried forward as a stale search result",
  );
  assertEquals(f.mbid, "f1111111-0000-4000-8000-00000000000f");
  assertEquals(
    f.checkedAt,
    undefined,
    "a seed match must NEVER carry a search checkedAt stamp — the ONLY test of step 10 rule 4 / step 11 rule 3, since F's prior stamp was explicit",
  );

  assertEquals(res.payload.resolved, 4, "A, C, D, F");
  assertEquals(res.payload.ambiguous, 1, "B");
  assertEquals(res.payload.unresolved, 0);
  assertEquals(res.payload.pendingSearch, 0);
  assertEquals(res.payload.truncated, false);
});

Deno.test("resolve-artists (invariant B error path): a per-query ERROR preserves the prior verdict verbatim and leaves checkedAt UNCHANGED (still stale, so the next run retries), counted in pendingSearch", async () => {
  const staleA = {
    ...PRIOR_ARTIST_MAP_ABCEF.entries[0],
    checkedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString(), // 61 days ago, past the 30-day TTL
  };
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-a",
          name: "Fixture New Name",
        }),
      ],
    },
  };
  const { ctx, written, runModelCalls } = makeModelDataCtx(
    modelData,
    {
      "artist-map": {
        kind: "artistMap",
        scannedAt: "x",
        params: {
          headphonesInstance: "headphones",
          musicbrainzInstance: "musicbrainz",
        },
        resolved: 1,
        ambiguous: 0,
        unresolved: 0,
        entries: [staleA],
      },
    },
    {},
    mbBatchHandler(
      modelData,
      () => ({ error: "simulated MusicBrainz failure" }),
    ),
  );

  await run("resolve-artists", {}, ctx);

  assertEquals(
    runModelCalls.length,
    1,
    "A is now stale, so it must be searched this run",
  );
  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    {
      artistKey: string;
      mbid: string | null;
      status: string;
      source: string | null;
      checkedAt?: string;
    }
  >;
  const a = entries.find((e) => e.artistKey === "fixture-artist-a")!;
  assertEquals(a.mbid, staleA.mbid);
  assertEquals(a.status, "resolved");
  assertEquals(a.source, "search");
  assertEquals(
    a.checkedAt,
    staleA.checkedAt,
    "checkedAt must stay UNCHANGED — still stale, so the next run retries",
  );
  assert((res.payload.pendingSearch as number) >= 1);
  assertEquals(res.payload.truncated, true);
});

Deno.test("resolve-artists (invariant B deferred path): a query present in the batch's deferred[] preserves the prior verdict identically to a per-query error", async () => {
  const staleF = {
    ...PRIOR_ARTIST_MAP_ABCEF.entries[4],
    checkedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-f",
          name: "Fixture Artist F",
        }),
      ],
    },
  };
  const { ctx, written, runModelCalls } = makeModelDataCtx(
    modelData,
    {
      "artist-map": {
        kind: "artistMap",
        scannedAt: "x",
        params: {
          headphonesInstance: "headphones",
          musicbrainzInstance: "musicbrainz",
        },
        resolved: 1,
        ambiguous: 0,
        unresolved: 0,
        entries: [staleF],
      },
    },
    {},
    mbBatchHandler(modelData, () => undefined), // every query deferred
  );

  await run("resolve-artists", {}, ctx);

  assertEquals(runModelCalls.length, 1);
  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    {
      artistKey: string;
      mbid: string | null;
      status: string;
      source: string | null;
      checkedAt?: string;
    }
  >;
  const f = entries.find((e) => e.artistKey === "fixture-artist-f")!;
  assertEquals(f.mbid, staleF.mbid);
  assertEquals(f.status, "resolved");
  assertEquals(f.source, "search");
  assertEquals(f.checkedAt, staleF.checkedAt);
  assertEquals(res.payload.pendingSearch, 1);
  assertEquals(res.payload.truncated, true);
});

Deno.test("resolve-artists (invariant B, malformed batch row): a query missing from BOTH queries[] and deferred[] (a malformed upstream row) still preserves the prior defensively, never crashing", async () => {
  const staleF = {
    ...PRIOR_ARTIST_MAP_ABCEF.entries[4],
    checkedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-f",
          name: "Fixture Artist F",
        }),
      ],
    },
    musicbrainz: {
      artistSearchBatch: [], // batch row will be written below with an EMPTY queries/deferred
    },
  };
  const { ctx, written } = makeModelDataCtx(
    modelData,
    {
      "artist-map": {
        kind: "artistMap",
        scannedAt: "x",
        params: {
          headphonesInstance: "headphones",
          musicbrainzInstance: "musicbrainz",
        },
        resolved: 1,
        ambiguous: 0,
        unresolved: 0,
        entries: [staleF],
      },
    },
    {},
    (call) => {
      if (call.method !== "search-artists-batch") return;
      modelData.musicbrainz.artistSearchBatch = [
        mdRow({
          batchId: call.arguments.batchId,
          queries: [], // the query for F is malformed-absent from both arrays
          deferred: [],
          requested: 1,
          searched: 0,
          failed: 0,
          truncated: false,
          stopReason: "complete",
          timestamp: "x",
        }),
      ];
    },
  );

  await run("resolve-artists", {}, ctx);

  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    {
      artistKey: string;
      mbid: string | null;
      status: string;
      checkedAt?: string;
    }
  >;
  const f = entries.find((e) => e.artistKey === "fixture-artist-f")!;
  assertEquals(
    f.mbid,
    staleF.mbid,
    "the prior verdict must survive even a malformed batch row",
  );
  assertEquals(f.checkedAt, staleF.checkedAt);
  assertEquals(res.payload.pendingSearch, 1);
});

Deno.test("resolve-artists (invariant C): a genuine no-match (empty artists, no error) resolves to unresolved with checkedAt SET, and is NOT counted toward pendingSearch", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-x",
          name: "Fixture Unknown Artist",
        }),
      ],
    },
  };
  const { ctx, written } = makeModelDataCtx(
    modelData,
    {},
    {},
    mbBatchHandler(modelData, () => ({ artists: [] })),
  );

  await run("resolve-artists", {}, ctx);

  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    {
      artistKey: string;
      status: string;
      mbid: string | null;
      checkedAt?: string;
    }
  >;
  const x = entries.find((e) => e.artistKey === "fixture-artist-x")!;
  assertEquals(x.status, "unresolved");
  assertEquals(x.mbid, null);
  assertEquals(
    typeof x.checkedAt,
    "string",
    "a genuine no-match still got a real verdict this run, so checkedAt must be SET",
  );
  assertEquals(res.payload.pendingSearch, 0);
  assertEquals(res.payload.truncated, false);
  assertEquals(res.payload.stopReason, "complete");
});

Deno.test("resolve-artists (invariant C, completeness): a truncated batch (stopReason max-queries, non-empty deferred[]) produces a matching pendingSearch/truncated/stopReason on the written map", async () => {
  const libraryRows = [
    mdRow({
      kind: "artist",
      key: "fixture-artist-1",
      name: "Fixture Artist One",
    }),
    mdRow({
      kind: "artist",
      key: "fixture-artist-2",
      name: "Fixture Artist Two",
    }),
  ];
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: { artist: libraryRows },
  };
  const { ctx, written } = makeModelDataCtx(
    modelData,
    {},
    {},
    (call) => {
      if (call.method !== "search-artists-batch") return;
      const queries = call.arguments.queries as string[];
      if (!modelData.musicbrainz) modelData.musicbrainz = {};
      modelData.musicbrainz.artistSearchBatch = [
        mdRow({
          batchId: call.arguments.batchId,
          queries: [{ query: queries[0], artists: [], count: 0 }],
          deferred: queries.slice(1),
          requested: queries.length,
          searched: 1,
          failed: 0,
          truncated: true,
          stopReason: "max-queries",
          timestamp: "x",
        }),
      ];
    },
  );

  await run("resolve-artists", {}, ctx);

  const res = written.find((w) => w.spec === "artistMap")!;
  assertEquals(res.payload.pendingSearch, 1);
  assertEquals(res.payload.truncated, true);
  assertEquals(res.payload.stopReason, "max-queries");
});

Deno.test("resolve-artists (batch selection): the row matching the GENERATED batchId is used even when it is NOT last in the array", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-y",
          name: "Fixture Selected Artist",
        }),
      ],
    },
  };
  const { ctx, written } = makeModelDataCtx(
    modelData,
    {},
    {},
    (call) => {
      if (call.method !== "search-artists-batch") return;
      const query = (call.arguments.queries as string[])[0];
      const row = (id: string) => ({
        query,
        artists: [{ id, name: "Fixture Selected Artist" }],
        count: 1,
      });
      modelData.musicbrainz = {
        artistSearchBatch: [
          mdRow({
            batchId: "not-this-batch-1",
            queries: [row("11111111-0000-4000-8000-000000000001")],
            deferred: [],
            requested: 1,
            searched: 1,
            failed: 0,
            truncated: false,
            stopReason: "complete",
            timestamp: "x",
          }),
          // The MATCHING row, deliberately placed in the MIDDLE.
          mdRow({
            batchId: call.arguments.batchId,
            queries: [row("22222222-0000-4000-8000-000000000002")],
            deferred: [],
            requested: 1,
            searched: 1,
            failed: 0,
            truncated: false,
            stopReason: "complete",
            timestamp: "x",
          }),
          mdRow({
            batchId: "not-this-batch-3",
            queries: [row("33333333-0000-4000-8000-000000000003")],
            deferred: [],
            requested: 1,
            searched: 1,
            failed: 0,
            truncated: false,
            stopReason: "complete",
            timestamp: "x",
          }),
        ],
      };
    },
  );

  await run("resolve-artists", {}, ctx);

  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    { artistKey: string; mbid: string | null }
  >;
  const y = entries.find((e) => e.artistKey === "fixture-artist-y")!;
  assertEquals(y.mbid, "22222222-0000-4000-8000-000000000002");
});

Deno.test("resolve-artists (batch selection): no artistSearchBatch row matches the generated batchId -> THROWS, naming the instance and batchId, rather than silently parking every artist", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-z",
          name: "Fixture Missing Batch Artist",
        }),
      ],
    },
  };
  const { ctx } = makeModelDataCtx(
    modelData,
    {},
    {},
    (call) => {
      if (call.method !== "search-artists-batch") return;
      modelData.musicbrainz = {
        artistSearchBatch: [
          mdRow({
            batchId: "completely-unrelated-batch-id",
            queries: [],
            deferred: [],
            requested: 0,
            searched: 0,
            failed: 0,
            truncated: false,
            stopReason: "complete",
            timestamp: "x",
          }),
        ],
      };
    },
  );

  const err = await assertRejects(() => run("resolve-artists", {}, ctx), Error);
  assert(
    err.message.includes("musicbrainz"),
    "the error must name the instance it looked on",
  );
});

Deno.test("resolve-artists: a truncated batch is NOT finished by looping runModel — exactly ONE call regardless of truncation; the remainder is left for the NEXT run via pendingSearch", async () => {
  const libraryRows = [
    mdRow({
      kind: "artist",
      key: "fixture-artist-1",
      name: "Fixture Artist One",
    }),
    mdRow({
      kind: "artist",
      key: "fixture-artist-2",
      name: "Fixture Artist Two",
    }),
  ];
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: { artist: libraryRows },
  };
  const { ctx, runModelCalls, written } = makeModelDataCtx(
    modelData,
    {},
    {},
    (call) => {
      if (call.method !== "search-artists-batch") return;
      const queries = call.arguments.queries as string[];
      if (!modelData.musicbrainz) modelData.musicbrainz = {};
      modelData.musicbrainz.artistSearchBatch = [
        mdRow({
          batchId: call.arguments.batchId,
          queries: [{ query: queries[0], artists: [], count: 0 }],
          deferred: queries.slice(1),
          requested: queries.length,
          searched: 1,
          failed: 0,
          truncated: true,
          stopReason: "max-queries",
          timestamp: "x",
        }),
      ];
    },
  );

  await run("resolve-artists", {}, ctx);

  assertEquals(
    runModelCalls.length,
    1,
    "must NOT loop runModel to finish a truncated batch",
  );
  const res = written.find((w) => w.spec === "artistMap")!;
  assertEquals(res.payload.truncated, true);
  assert((res.payload.pendingSearch as number) >= 1);
});

Deno.test("resolve-artists: resolved/ambiguous/unresolved are TOP-LEVEL fields on the written artistMap resource, summing to entries.length", async () => {
  const { ctx, written } = makeModelDataCtx({
    headphones: { artists: [mdRow(headphonesArtistsFixture)] },
    music: { artist: LIBRARY_ARTISTS_SEED_COVERED },
  });
  await run("resolve-artists", {}, ctx);
  const res = written.find((w) => w.spec === "artistMap")!;
  assertEquals(typeof res.payload.resolved, "number");
  assertEquals(typeof res.payload.ambiguous, "number");
  assertEquals(typeof res.payload.unresolved, "number");
  const entries = res.payload.entries as unknown[];
  assertEquals(
    (res.payload.resolved as number) + (res.payload.ambiguous as number) +
      (res.payload.unresolved as number),
    entries.length,
  );
});

Deno.test("resolve-artists: idempotent — two runs over the same input produce the same map", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow(headphonesArtistsFixture)] },
    music: { artist: LIBRARY_ARTISTS_SEED_COVERED },
  };
  const first = makeModelDataCtx(structuredClone(modelData));
  await run("resolve-artists", {}, first.ctx);
  const firstEntries =
    first.written.find((w) => w.spec === "artistMap")!.payload.entries;

  const second = makeModelDataCtx(structuredClone(modelData));
  await run("resolve-artists", {}, second.ctx);
  const secondEntries =
    second.written.find((w) => w.spec === "artistMap")!.payload.entries;

  assertEquals(secondEntries, firstEntries);
});

// Two distinct headphones ArtistIDs sharing the exact same ArtistName: the
// library owns that artist too, so it must be resolved — but the seed alone
// cannot say WHICH MBID is correct.
const AMBIGUOUS_HEADPHONES_SEED = {
  artists: [
    {
      ArtistID: "11111111-1111-1111-1111-111111111111",
      ArtistName: "Bill Brown",
      Status: "Active",
    },
    {
      ArtistID: "22222222-2222-2222-2222-222222222222",
      ArtistName: "Bill Brown",
      Status: "Active",
    },
  ],
  total: 2,
  timestamp: "2025-11-03T00:00:00Z",
};

Deno.test("resolve-artists: an artist name with two distinct MBIDs in the seed is PARKED as ambiguous, never auto-resolved", async () => {
  const { ctx, written } = makeModelDataCtx({
    headphones: { artists: [mdRow(AMBIGUOUS_HEADPHONES_SEED)] },
    music: {
      artist: [
        mdRow({ kind: "artist", key: "bill-brown", name: "Bill Brown" }),
      ],
    },
  });
  await run("resolve-artists", {}, ctx);
  const res = written.find((w) => w.spec === "artistMap")!;
  const entries = res.payload.entries as Array<
    { artistName: string; status: string; mbid: string | null }
  >;
  const entry = entries.find((e) => e.artistName === "Bill Brown")!;
  assertEquals(entry.status, "ambiguous");
  assertEquals(entry.mbid, null);
  assertEquals(res.payload.ambiguous, 1);
  assertEquals(res.payload.resolved, 0);
  assertEquals(res.payload.unresolved, 0);
});

// ---------------------------------------------------------------------------
// wanted
// ---------------------------------------------------------------------------

const ARTIST_MAP_FIXTURE = {
  kind: "artistMap",
  scannedAt: "2026-08-01T00:00:00Z",
  params: {
    headphonesInstance: "headphones",
    musicbrainzInstance: "musicbrainz",
  },
  resolved: 2,
  ambiguous: 0,
  unresolved: 0,
  entries: [
    {
      artistKey: "halcyon",
      artistName: "Halcyon",
      mbid: "deadbeef-c001-4a57-8bad-f00ddeadbeef",
      status: "resolved",
      source: "seed",
      candidates: [],
    },
    {
      artistKey: "velvet-static",
      artistName: "Velvet Static",
      mbid: "cafebabe-fa57-4f00-9dec-afbadcafebab",
      status: "resolved",
      source: "seed",
      candidates: [],
    },
  ],
};

Deno.test("wanted: performs ZERO network calls — no ssh/sqlite, fetch, or runModel execution (pure derivation over already-cached data)", async () => {
  const { ctx, runModelCalls } = makeModelDataCtx(
    {
      musicbrainz: {
        browse: [
          mdRow(mbReleaseGroupsFixture),
          mdRow(mbReleaseGroupsEmptyFixture),
        ],
      },
      music: { album: [] },
    },
    { "artist-map": ARTIST_MAP_FIXTURE },
  );
  const sshStub = installSshStub(() => {
    throw new Error("wanted() must never touch ssh/sqlite");
  });
  const fetchStub = installFetchStub(() => {
    throw new Error("wanted() must never touch fetch");
  });
  try {
    await run("wanted", {}, ctx);
  } finally {
    sshStub.restore();
    fetchStub.restore();
  }
  assertEquals(sshStub.calls.length, 0);
  assertEquals(fetchStub.calls.length, 0);
  assertEquals(runModelCalls.length, 0);
});

Deno.test("wanted: missing artistMap resource fails with an actionable error naming the FULL prerequisite command, including the modelName", async () => {
  const { ctx } = makeModelDataCtx({
    musicbrainz: { browse: [mdRow(mbReleaseGroupsFixture)] },
    music: { album: [] },
  });
  await assertRejects(
    () => run("wanted", {}, ctx),
    Error,
    "swamp model method run music resolve-artists",
  );
});

Deno.test("wanted: missing MusicBrainz browse cache fails with an actionable error naming the RUNNABLE sync-artist-discographies command, not the nonexistent 'browse' method", async () => {
  const { ctx } = makeModelDataCtx(
    { musicbrainz: { browse: [] }, music: { album: [] } },
    { "artist-map": ARTIST_MAP_FIXTURE },
  );
  const err = await assertRejects(() => run("wanted", {}, ctx), Error);
  assert(
    err.message.includes(
      "swamp model method run musicbrainz sync-artist-discographies --input 'artistMbids:json=",
    ),
    "there is no 'browse' method (browse-release-groups/browse-releases/browse-recordings exist; 'browse' is a resource spec name) — the error must give the real runnable command",
  );
  assert(
    !err.message.includes('swamp model method run musicbrainz browse"'),
    "must not still tell the operator to run the nonexistent 'browse' method",
  );
  assert(
    err.message.includes(
      "--select 'attributes.entries.filter(e, e.status == \"resolved\").map(e, e.mbid)' --json",
    ),
    "must include the MBID extraction command",
  );
  assert(
    err.message.includes("query envelope") &&
      err.message.includes('{"results"') &&
      err.message.includes("total"),
    "must state the envelope clause — the extraction command prints {results, total}, not a bare array",
  );
  assert(
    err.message.includes("swamp workflow run music-wanted"),
    "must name the repo-local workflow that wires the whole sequence",
  );
});
