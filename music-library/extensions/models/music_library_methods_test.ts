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
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { hash8, model, slugify } from "./music_library.ts";
import tracksFixture from "../../fixtures/tracks.json" with { type: "json" };
import genresFixture from "../../fixtures/genres.json" with { type: "json" };
import verifyFilesFixture from "../../fixtures/verify_files.json" with {
  type: "json",
};
import probeFixture from "../../fixtures/probe.json" with { type: "json" };

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
      modelName: "music",
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
