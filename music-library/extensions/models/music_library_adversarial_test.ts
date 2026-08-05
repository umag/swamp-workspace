/**
 * Adversarial suite for @magistr/music-library: attacker's-perspective
 * characterization of the model's real injection/robustness surface, plus a
 * mechanical fixtures secret-scan.
 *
 * Six latent bugs found during the original test-only backfill (filed
 * against the LOCAL `music-library-latent-bugs` issue-lifecycle model, never
 * the Lab) are now REAL-FIXED in `music_library.ts` — the six
 * `pin: KNOWN BUG` tests below were flipped to `pin: fixed` assertions of
 * the corrected behavior in the same change that shipped the fixes
 * (model version `2026.08.02.1`):
 *
 *   LB1 (MEDIUM) — verify's remote ffmpeg decode loop now wraps every file
 *        in the shell `timeout` command (sized from the new defaulted
 *        `ffmpegDecodeTimeoutSec` global arg), mirroring bpm's ANALYZE_PY
 *        `signal.alarm(timeout)`; `sshRun` also gained a client-side
 *        AbortController transport ceiling as a belt-and-suspenders guard.
 *   LB2 (MEDIUM) — verify/bpm/probe's `path` argument now resolves through
 *        the shared `confineContainerPath`/`normalizeSegments` helpers,
 *        which throw rather than letting `../` escape `containerMusicRoot`.
 *   LB3 (LOW) — `probe` on an ffprobe call that exits 0 with empty stdout
 *        now throws a clean, actionable `Error` (never a raw `SyntaxError`).
 *   LB4 (LOW) — `verify`'s US(0x1f)/RS(0x1e) record framing now re-folds any
 *        fragment whose leading field is not a known cpath into the
 *        previous record before parsing, so a stray RS byte inside ffmpeg's
 *        OWN captured output can no longer split one real record in two.
 *   LB5 (LOW) — `bpmMedian` now averages the two middle values on an EVEN
 *        track count instead of returning the upper of the two
 *        (`bpms[Math.floor(n/2)]`).
 *   LB6 (LOW) — `bpm` now has a `maxTracks` method arg (default 50000) that
 *        caps the STORED `tracks`/`failures` arrays and sets
 *        `tracksTruncated`/`failuresTruncated`, mirroring verify's
 *        `problems.slice(0, 2000)` + `problemsTruncated` — while stats
 *        (median, histogram, confidence bands) stay computed over the FULL
 *        set before any truncation.
 *
 * PLUS two regression-pinned POSITIVES (deliberately checked and confirmed
 * to hold, not just assumed — UNCHANGED by the LB1-LB6 fixes):
 *   P1 — TRACKS_SQL/GENRES_SQL/VERIFY_SQL are fully static constants; no
 *        method argument or global argument is EVER concatenated into SQL
 *        text — so there is no SQL-injection surface at all.
 *   P2 — `shQuote`'s POSIX single-quote escaping is correct, AND the `safe`
 *        control-byte filename filter runs before any path reaches the
 *        newline-delimited ssh stdin protocol — together these mean no
 *        command injection is reachable via a hostile filename/dbPath.
 *
 * Toolchain rule (deno 2.8.3 in CI): the `Deno.Command` seam is installed via
 * `(globalThis as any).Deno.Command = FakeCommand`, never a
 * `as typeof Deno.Command` cast; restored in `finally`.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./music_library.ts";
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
import mbArtistSearchBatchFixture from "../../fixtures/mb_artist_search_batch.json" with {
  type: "json",
};

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS, copied verbatim from music_library_property_test.ts:47-50
// (CLAUDE.md rule 7 — pin explicit versions).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention)
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
      // Mirror the REAL MethodContext surface — no `modelName` field exists;
      // the instance name is `definition.name`. See methods_test.ts.
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
  signal?: AbortSignal;
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
        signal: opts.signal as AbortSignal | undefined,
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

function bpmRecord(
  r: { left_path: string; right_path: string; filename: string },
  over: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    path: cpathOfRow(r),
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

const V = verifyFilesFixture as Array<
  { filename: string; length: number; left_path: string; right_path: string }
>;
const [vOk1] = V;

// ---------------------------------------------------------------------------
// LB1 (MEDIUM) — verify has no per-file decode timeout
// ---------------------------------------------------------------------------

Deno.test("fixed (music-library-latent-bugs LB1) — verify's remote ffmpeg loop (full mode) wraps every file in the shell `timeout` command, mirroring bpm's essentia analyzer", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({ verifyRows: [vOk1] }),
    async (stub) => {
      await run("verify", {}, ctx);
      const script = stub.calls
        .find((c) => c.args.join(" ").includes("ffmpeg"))!
        .args.join(" ");
      assert(
        /\btimeout\b/.test(script),
        "a `timeout` wrapper now appears around the remote ffmpeg " +
          "invocation — a wedged or oversized file is recorded as failed " +
          "(rc=124) and the worker's chunk continues, instead of hanging " +
          "forever (mirrors bpm's ANALYZE_PY signal.alarm(timeout))",
      );
    },
  );
});

Deno.test("fixed (music-library-latent-bugs LB1) — the same `timeout` wrapper is present in quick mode's script too", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({ verifyRows: [vOk1] }),
    async (stub) => {
      await run("verify", { mode: "quick" }, ctx);
      const script = stub.calls
        .find((c) => c.args.join(" ").includes("ffmpeg"))!
        .args.join(" ");
      assert(/\btimeout\b/.test(script));
    },
  );
});

Deno.test("fixed (music-library-latent-bugs LB1) — sshRun passes an AbortSignal transport ceiling on verify's ssh call", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({ verifyRows: [vOk1] }),
    async (stub) => {
      await run("verify", {}, ctx);
      const ffmpegCall = stub.calls.find((c) =>
        c.args.join(" ").includes("ffmpeg")
      )!;
      assert(
        ffmpegCall.signal instanceof AbortSignal,
        "sshRun must pass an AbortSignal as the worker/transport ceiling",
      );
      assert(
        !ffmpegCall.signal!.aborted,
        "the ceiling must not already be tripped on a fast, successful call",
      );
    },
  );
});

Deno.test("fixed (music-library-latent-bugs LB1) — ffmpegDecodeTimeoutSec=0 disables both the remote `timeout` wrapper and the transport ceiling", async () => {
  const { ctx } = makeCtx({ ffmpegDecodeTimeoutSec: 0 });
  await withSshStub(
    makeRouter({ verifyRows: [vOk1] }),
    async (stub) => {
      await run("verify", {}, ctx);
      const ffmpegCall = stub.calls.find((c) =>
        c.args.join(" ").includes("ffmpeg")
      )!;
      assert(
        !/\btimeout\b/.test(ffmpegCall.args.join(" ")),
        "0 must skip the `timeout` wrapper entirely, not wrap with `timeout 0`",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// LB2 (MEDIUM) — path traversal via the `path` argument
// ---------------------------------------------------------------------------

const TRAVERSAL = "../../../etc/passwd";

Deno.test("fixed (music-library-latent-bugs LB2) — verify's `path` argument now rejects a '../' traversal instead of letting it escape containerMusicRoot", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({}),
    () =>
      assertRejects(
        () => run("verify", { path: TRAVERSAL }, ctx),
        Error,
        "escapes",
      ),
  );
});

Deno.test("fixed (music-library-latent-bugs LB2 sibling) — bpm's `path` argument now rejects the identical traversal", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({}),
    () =>
      assertRejects(
        () => run("bpm", { path: TRAVERSAL }, ctx),
        Error,
        "escapes",
      ),
  );
});

Deno.test("fixed (music-library-latent-bugs LB2 sibling) — probe's `path` argument now rejects the identical traversal", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({ probe: probeFixture }),
    () =>
      assertRejects(
        () => run("probe", { path: TRAVERSAL }, ctx),
        Error,
        "escapes",
      ),
  );
});

Deno.test("fixed (music-library-latent-bugs LB2, anti-over-rejection) — a clean, well-formed relative `path` still resolves under containerMusicRoot unchanged for verify/bpm/probe", async () => {
  const clean = relOfRow(vOk1);
  const { ctx: verifyCtx } = makeCtx();
  await withSshStub(
    makeRouter({}),
    async (stub) => {
      await run("verify", { path: clean }, verifyCtx);
      const ffmpegCall = stub.calls.find((c) =>
        c.args.join(" ").includes("ffmpeg")
      )!;
      assertEquals(ffmpegCall.stdin.trim(), `${CROOT}/${clean}`);
    },
  );
  const { ctx: bpmCtx } = makeCtx();
  await withSshStub(
    makeRouter({}),
    async (stub) => {
      await run("bpm", { path: clean }, bpmCtx);
      const essentiaCall = stub.calls.find((c) =>
        c.args.join(" ").includes("python3")
      )!;
      assertEquals(essentiaCall.stdin.trim(), `${CROOT}/${clean}`);
    },
  );
  const { ctx: probeCtx } = makeCtx();
  await withSshStub(
    makeRouter({ probe: probeFixture }),
    async (stub) => {
      await run("probe", { path: clean }, probeCtx);
      const cmd = stub.calls[0].args.join(" ");
      assert(cmd.includes(`${CROOT}/${clean}`));
    },
  );
});

// ---------------------------------------------------------------------------
// LB3 (LOW) — probe crashes with a raw SyntaxError on empty ffprobe stdout
// ---------------------------------------------------------------------------

Deno.test('fixed (music-library-latent-bugs LB3) — probe on an ffprobe call that exits 0 with EMPTY stdout now throws a clean, actionable Error (never a raw SyntaxError from JSON.parse(""))', async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    () => ({ success: true, stdout: "", stderr: "" }),
    async () => {
      const err = await assertRejects(
        () => run("probe", { path: "any/file.mp3" }, ctx),
        Error,
        "no output",
      );
      assert(
        !(err instanceof SyntaxError),
        "must be a clean domain Error, not a raw SyntaxError",
      );
    },
  );
});

Deno.test("fixed (music-library-latent-bugs LB3 sibling) — probe on an ffprobe call that exits 0 with UNPARSEABLE (non-empty, non-JSON) stdout also throws a clean, actionable Error, never a raw SyntaxError", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    () => ({ success: true, stdout: "not json at all", stderr: "" }),
    async () => {
      const err = await assertRejects(
        () => run("probe", { path: "any/file.mp3" }, ctx),
        Error,
        "invalid JSON",
      );
      assert(!(err instanceof SyntaxError));
    },
  );
});

// ---------------------------------------------------------------------------
// LB4 (LOW) — verify's US/RS record framing is not RS-safe
// ---------------------------------------------------------------------------

Deno.test("fixed (music-library-latent-bugs LB4) — an RS(0x1e) byte embedded in ffmpeg's OWN captured output no longer splits one real record in two; the file is correctly classified as errored, not silently accepted as ok", async () => {
  const cpath = cpathOfRow(vOk1);
  // Only the file LIST fed to ffmpeg is filtered for control bytes (the
  // `safe` filter, applied to args.path/pathPrefix-derived paths) — ffmpeg's
  // OWN stderr/stdout text ($out) is never itself filtered or escaped before
  // it is embedded into the printf-framed record. A clean-looking progress
  // line BEFORE the embedded RS byte, followed by the file's REAL corruption
  // report AFTER it, is exactly the shape that used to be silently
  // misclassified as "ok" — the RS-safe fragment reassembly now re-folds it
  // back into one record before parsing.
  const hostileBody = "size=N/A time=00:04:05.00 bitrate=N/A speed=300x" +
    "\x1e[mp3float @ 0x1] Header missing\n" +
    "Error while decoding stream #0:0: Invalid data found\n";
  const { ctx, written } = makeCtx();
  await withSshStub(
    (call) => {
      const cmd = call.args[call.args.length - 1] ?? "";
      if (cmd.includes("ffmpeg")) {
        return {
          success: true,
          stdout: `${cpath}\x1f0\x1f${hostileBody}\x1e`,
          stderr: "",
        };
      }
      throw new Error(`unrouted: ${cmd}`);
    },
    () => run("verify", { path: relOfRow(vOk1) }, ctx),
  );
  const res = written.find((w) => w.spec === "verify")!;
  assertEquals(
    res.payload.ok,
    0,
    "the file is no longer counted as ok — the reassembled record carries " +
      "the genuine decode-error line",
  );
  assertEquals(res.payload.errors, 1);
  assertEquals(res.payload.failed, 0);
  assertEquals(
    res.payload.missingRecords,
    0,
    "the file IS seen — correctly classified, not lost outright",
  );
  const problems = res.payload.problems as Array<{ errors: string[] }>;
  assert(
    problems.some((p) =>
      p.errors.some((e) => e.includes("Invalid data found"))
    ),
    "the genuine post-RS error line ('Invalid data found'/'Error while " +
      "decoding') is now surfaced in the written resource",
  );
  assert(
    !JSON.stringify(res.payload).includes("Header missing"),
    "'Header missing' still never appears — in this fixture it is glued " +
      "onto the time= progress line, which parseFfmpegVerifyOutput always " +
      "filters regardless of the RS fix",
  );
});

// ---------------------------------------------------------------------------
// LB5 (LOW) — bpmMedian off-by-one on an even track count
// ---------------------------------------------------------------------------

Deno.test("fixed (music-library-latent-bugs LB5) — bpmMedian on an EVEN track count now averages the two middle values instead of returning the upper one", async () => {
  const V2 = V.slice(0, 2);
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({
      verifyRows: V2,
      bpmRecords: {
        [cpathOfRow(V2[0])]: bpmRecord(V2[0], { bpm: 100 }),
        [cpathOfRow(V2[1])]: bpmRecord(V2[1], { bpm: 200 }),
      },
    }),
    () => run("bpm", {}, ctx),
  );
  const res = written.find((w) => w.spec === "bpm")!;
  assertEquals(
    (res.payload.stats as { bpmMedian: number }).bpmMedian,
    150,
    "the mathematically correct median of [100, 200] is 150 — the average " +
      "of the two middle sorted values, not the upper one",
  );
});

// ---------------------------------------------------------------------------
// LB6 (LOW) — bpm's carried tracks/failures arrays have no size cap
// ---------------------------------------------------------------------------

Deno.test("fixed (music-library-latent-bugs LB6) — an explicit maxTracks now caps bpm's STORED tracks array and sets tracksTruncated, while stats stay computed over the FULL set", async () => {
  const bigCarried = Array.from({ length: 2500 }, (_, i) => ({
    path: `synthetic/track-${i}.mp3`,
    bpm: 120,
    beatsConfidence: 2.0,
    confidenceBand: "good",
    beatsCount: 100,
    ibiCv: 0.01,
    estStd: 1.0,
    key: "C",
    scale: "major",
    keyStrength: 0.5,
    danceability: 1.0,
    lengthSec: 200,
    analyzedSec: 200,
    windowed: false,
    ms: 1000,
  }));
  const { ctx, written } = makeCtx({}, {
    "bpm-library": { tracks: bigCarried, failures: [] },
  });
  await withSshStub(
    makeRouter({
      verifyRows: [vOk1],
      bpmRecords: { [cpathOfRow(vOk1)]: bpmRecord(vOk1) },
    }),
    () => run("bpm", { maxTracks: 2000 }, ctx),
  );
  const res = written.find((w) => w.spec === "bpm")!;
  const tracks = res.payload.tracks as unknown[];
  assertEquals(
    tracks.length,
    2000,
    "an explicit maxTracks caps the STORED tracks array, mirroring " +
      "verify's `problems: problemsTruncated ? problems.slice(0, 2000) : " +
      "problems`",
  );
  assertEquals(res.payload.tracksTruncated, true);
  assertEquals(res.payload.failuresTruncated, false);
  const confidenceBands =
    (res.payload.stats as { confidenceBands: Record<string, number> })
      .confidenceBands;
  const totalBanded = Object.values(confidenceBands).reduce(
    (a, b) => a + b,
    0,
  );
  assertEquals(
    totalBanded,
    2501,
    "stats (confidenceBands here) are computed over the FULL 2501 tracks " +
      "BEFORE truncation, not just the 2000 that end up stored",
  );
});

Deno.test("fixed (music-library-latent-bugs LB6, default) — the default maxTracks (50000) does not truncate a realistic run and leaves tracksTruncated=false", async () => {
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({
      verifyRows: [vOk1],
      bpmRecords: { [cpathOfRow(vOk1)]: bpmRecord(vOk1) },
    }),
    () => run("bpm", {}, ctx),
  );
  const res = written.find((w) => w.spec === "bpm")!;
  assertEquals(res.payload.tracksTruncated, false);
  assertEquals(res.payload.failuresTruncated, false);
  assertEquals((res.payload.tracks as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// P1 (POSITIVE) — SQL is fully static; no argument ever reaches it
// ---------------------------------------------------------------------------

Deno.test("covered POSITIVE: TRACKS_SQL/GENRES_SQL/VERIFY_SQL are fully static — no method OR global argument is ever concatenated into the SQL text sent over stdin", async () => {
  const { ctx } = makeCtx({ dbPath: "/tmp/gonic.db'; DROP TABLE tracks; --" });
  await withSshStub(
    makeRouter({ tracks: tracksFixture, genres: genresFixture }),
    async (stub) => {
      await run(
        "scan",
        { pathPrefix: "'; DROP TABLE tracks; --", maxAlbums: 999 },
        ctx,
      );
      for (const call of stub.calls) {
        assert(
          !call.stdin.includes("DROP TABLE"),
          "no argument value ever appears in the SQL text — pathPrefix/" +
            "maxAlbums only filter the already-fetched JSON rows in JS, " +
            "and dbPath only ever reaches the shQuoted sqlite3 ARGV, never " +
            "the SQL body itself",
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// P2 (POSITIVE) — shQuote is correct + control-byte filenames are excluded
// ---------------------------------------------------------------------------

function expectedShQuote(s: string): string {
  return "'" + s.replaceAll("'", `'\\''`) + "'";
}

Deno.test("covered POSITIVE: shQuote's POSIX single-quote escaping is correct — a hostile dbPath containing a quote and shell metacharacters is safely embedded", async () => {
  const hostile = "/mnt/user/gonic.db'; rm -rf / #";
  const { ctx } = makeCtx({ dbPath: hostile });
  await withSshStub(
    makeRouter({ tracks: [] }),
    async (stub) => {
      await run("dupes", {}, ctx);
      const cmd = stub.calls[0].args[stub.calls[0].args.length - 1];
      assertEquals(cmd, `sqlite3 -json -readonly ${expectedShQuote(hostile)}`);
      const withoutEscapedLiteral = cmd.replace(expectedShQuote(hostile), "");
      assert(
        !/rm -rf \//.test(withoutEscapedLiteral),
        "outside the correctly-escaped literal, no raw shell metacharacter " +
          "from the hostile value survives",
      );
    },
  );
});

Deno.test("covered POSITIVE: a filename with an embedded newline is excluded BEFORE it ever reaches the newline-delimited ssh stdin protocol", async () => {
  const hostileRow = {
    filename: "evil\nfile.mp3",
    length: 100,
    left_path: "",
    right_path: "Hostile Album",
  };
  const { ctx, written } = makeCtx();
  await withSshStub(
    makeRouter({ verifyRows: [vOk1, hostileRow] }),
    async (stub) => {
      await run("verify", {}, ctx);
      const stdin =
        stub.calls.find((c) => c.args.join(" ").includes("ffmpeg"))!.stdin;
      assert(
        !stdin.includes("evil"),
        "the embedded-newline filename never reaches the stdin file list, " +
          "so it can never desynchronize the line-based read loop",
      );
    },
  );
  const res = written.find((w) => w.spec === "verify")!;
  assertEquals(res.payload.skippedUnsafePaths, 1);
});

Deno.test("safe: a hostile host/sshUser lands as ONE local argv element each — Deno.Command's array-arg form never spawns a local shell", async () => {
  const { ctx } = makeCtx({
    host: "music.example; rm -rf /",
    sshUser: "root; id",
  });
  await withSshStub(
    makeRouter({ tracks: [] }),
    async (stub) => {
      await run("dupes", {}, ctx);
      const args = stub.calls[0].args;
      assertEquals(args[args.length - 2], "root; id@music.example; rm -rf /");
      assert(args.every((a) => typeof a === "string"));
    },
  );
});

// ---------------------------------------------------------------------------
// resolve-artists / wanted — RED phase adversarial cases. Both `execute`
// bodies are stubs that `throw new Error("not implemented")`, so every test
// below fails on that thrown error today (an uncaught rejection from the
// plain `await run(...)` calls) — behaviour is missing, the signatures are
// not. Harness duplicated per this file's own convention (see the top-of-
// file comment).
//
// Two adversarial claims characterized here:
//  - a browse-cache row that WAS synced but came back with `count: 0` /
//    `results: []` is a legitimate empty discography, not an error;
//  - a readModelData row missing the field the method actually needs
//    (a malformed upstream row), or an upstream spec that legitimately
//    returns `[]` (nobody tracked yet / nothing scanned yet), must not
//    crash with a raw property-access error — both degrade to "nothing
//    contributed here", never an unhandled throw.
// ---------------------------------------------------------------------------

function mdRow(attributes: Record<string, unknown>) {
  return { attributes };
}

type ModelData = Record<string, Record<string, unknown[]>>;

/** A single context.runModel call, decoded to its named fields — mirrors
 * music_library_methods_test.ts:766-786's RunModelCall/makeModelDataCtx
 * exactly, ADDITIVE to this file's own copy (round-2 fix: this file's
 * makeModelDataCtx previously discarded runModel args entirely and returned
 * no calls array at all — invariant (A) below needs both). */
type RunModelCall = {
  definition: string;
  method: string;
  arguments: Record<string, unknown>;
};

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

// A single resolved artist (Halcyon — the SAME artist mb_release_groups_
// empty.json's linkedId belongs to) so the empty-discography test below
// isolates that one artist's browse row without any other moving part.
const ARTIST_MAP_HALCYON_ONLY = {
  kind: "artistMap",
  scannedAt: "2026-08-01T00:00:00Z",
  params: {
    headphonesInstance: "headphones",
    musicbrainzInstance: "musicbrainz",
  },
  resolved: 1,
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
  ],
};

const ARTIST_MAP_VELVET_STATIC_ONLY = {
  kind: "artistMap",
  scannedAt: "2026-08-01T00:00:00Z",
  params: {
    headphonesInstance: "headphones",
    musicbrainzInstance: "musicbrainz",
  },
  resolved: 1,
  ambiguous: 0,
  unresolved: 0,
  entries: [
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

Deno.test("wanted: a browse row with count:0/results:[] (Halcyon actually has no releases) is a LEGITIMATE empty discography — no error, zero wants for that artist", async () => {
  const { ctx, written } = makeModelDataCtx(
    {
      musicbrainz: { browse: [mdRow(mbReleaseGroupsEmptyFixture)] },
      music: { album: [] },
    },
    { "artist-map": ARTIST_MAP_HALCYON_ONLY },
  );
  await run("wanted", {}, ctx);
  const res = written.find((w) => w.spec === "wanted")!;
  assertEquals(res.payload.wants, []);
  assertEquals(res.payload.total, 0);
});

Deno.test("resolve-artists: a headphones row missing the 'artists' field entirely does not crash — treated as an empty seed contribution", async () => {
  const { ctx, written } = makeModelDataCtx({
    headphones: {
      artists: [mdRow({ total: 0, timestamp: "2025-11-03T00:00:00Z" })],
    },
    music: { artist: [] },
  });
  await run("resolve-artists", {}, ctx);
  const res = written.find((w) => w.spec === "artistMap")!;
  assertEquals(res.payload.entries, []);
  assertEquals(res.payload.resolved, 0);
  assertEquals(res.payload.ambiguous, 0);
  assertEquals(res.payload.unresolved, 0);
});

Deno.test("wanted: a browse row missing the 'results' field entirely does not crash — treated as no desired releases for that artist, not a property-access error", async () => {
  const { ctx, written } = makeModelDataCtx(
    {
      musicbrainz: {
        browse: [
          mdRow({
            entity: "release-group",
            linkedEntity: "artist",
            linkedId: "deadbeef-c001-4a57-8bad-f00ddeadbeef",
          }),
        ],
      },
      music: { album: [] },
    },
    { "artist-map": ARTIST_MAP_HALCYON_ONLY },
  );
  await run("wanted", {}, ctx);
  const res = written.find((w) => w.spec === "wanted")!;
  assertEquals(res.payload.wants, []);
});

Deno.test("wanted: readModelData returning [] for the album cube (nothing scanned/owned yet) is handled gracefully, not an error", async () => {
  const { ctx, written } = makeModelDataCtx(
    {
      musicbrainz: { browse: [mdRow(mbReleaseGroupsFixture)] },
      music: { album: [] },
    },
    { "artist-map": ARTIST_MAP_VELVET_STATIC_ONLY },
  );
  await run("wanted", {}, ctx);
  const res = written.find((w) => w.spec === "wanted")!;
  assert(Array.isArray(res.payload.wants));
  assertEquals(res.payload.total, (res.payload.wants as unknown[]).length);
});

// ---------------------------------------------------------------------------
// resolve-artists: the four invariants that would have caught the fan-out
// bug (musicbrainz-ratelimit-runmodel-fanout, testStrategy A/D) — (A)
// N-INDEPENDENCE: exactly one search-artists-batch call regardless of how
// many artists need one; (D) PRIORITY IS NOT ADVISORY, asserted as ORDER
// (the cut itself is pinned on the musicbrainz side, in
// musicbrainz_property_test.ts's planSearchBatch property — only ORDER is
// observable here, since maxQueries is applied on the OTHER side of the
// runModel boundary); plus refresh:true and Lucene escaping.
// ---------------------------------------------------------------------------

/** Builds a runModel handler for search-artists-batch that resolves every
 * query to an EMPTY result (genuine no-match) — sufficient for tests that
 * only care about the CALL SHAPE (count, arguments.queries), never the
 * resolved verdict. Mirrors music_library_methods_test.ts's mbBatchHandler,
 * scoped down since this file's invariants don't need per-query outcomes. */
function emptyBatchHandler(modelData: ModelData) {
  return (call: RunModelCall) => {
    if (call.method !== "search-artists-batch") return;
    const queries = call.arguments.queries as string[];
    if (!modelData[call.definition]) modelData[call.definition] = {};
    modelData[call.definition]["artistSearchBatch"] = [
      ...(modelData[call.definition]["artistSearchBatch"] ?? []),
      mdRow({
        batchId: call.arguments.batchId,
        queries: queries.map((q) => ({ query: q, artists: [], count: 0 })),
        deferred: [],
        requested: queries.length,
        searched: queries.length,
        failed: 0,
        truncated: false,
        stopReason: "complete",
        timestamp: "x",
      }),
    ];
  };
}

Deno.test("resolve-artists (invariant A, N-independence): for a library with N seed-unresolved artists (names may REPEAT across distinct artistKeys), resolve-artists issues EXACTLY ONE search-artists-batch call regardless of N, and its queries.length equals the number of DISTINCT names needing a search", async () => {
  // Drawn from a small, fixed pool (rather than one name per index) so a
  // generated library of any size can — and, across FC_RUNS, routinely
  // does — contain the SAME artistName under two different artistKeys
  // (e.g. inconsistent tagging producing two "album artist" groupings for
  // one real artist). Every prior version of this generator produced N
  // strictly DISTINCT names by construction (`Fixture Artist ${i}`), which
  // made the "DISTINCT names" half of this invariant's own name
  // untestable: deleting resolve-artists' per-name query dedup left this
  // property (and all 227 other tests) green.
  const NAME_POOL = [
    "Fixture Artist Alpha",
    "Fixture Artist Beta",
    "Fixture Artist Gamma",
    "Fixture Artist Delta",
  ];
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...NAME_POOL), { minLength: 0, maxLength: 50 }),
      async (names) => {
        const n = names.length;
        const libraryRows = names.map((name, i) =>
          mdRow({ kind: "artist", key: `artist-${i}`, name })
        );
        const modelData: ModelData = {
          headphones: {
            artists: [mdRow({ artists: [], total: 0, timestamp: "x" })],
          },
          music: { artist: libraryRows },
        };
        const { ctx, runModelCalls } = makeModelDataCtx(
          modelData,
          {},
          {},
          emptyBatchHandler(modelData),
        );
        await run("resolve-artists", {}, ctx);
        if (runModelCalls.length !== (n > 0 ? 1 : 0)) return false;
        if (n > 0) {
          const [callArgs] = runModelCalls[0] as [
            { arguments: { queries: string[] } },
          ];
          const distinctNames = new Set(names).size;
          if (callArgs.arguments.queries.length !== distinctNames) return false;
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("resolve-artists (invariant D, priority as order): a single refreshKeys member's query is FIRST in arguments.queries, ahead of every other artist needing a search", async () => {
  const libraryRows = [
    mdRow({ kind: "artist", key: "artist-1", name: "Fixture Artist One" }),
    mdRow({ kind: "artist", key: "artist-2", name: "Fixture Artist Two" }),
    mdRow({ kind: "artist", key: "artist-3", name: "Fixture Artist Three" }),
    mdRow({ kind: "artist", key: "artist-4", name: "Fixture Artist Four" }),
  ];
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: { artist: libraryRows },
  };
  const { ctx, runModelCalls } = makeModelDataCtx(
    modelData,
    {},
    {},
    emptyBatchHandler(modelData),
  );
  await run("resolve-artists", { refreshKeys: ["artist-3"] }, ctx);
  assertEquals(runModelCalls.length, 1);
  const [callArgs] = runModelCalls[0] as [{ arguments: { queries: string[] } }];
  assertEquals(callArgs.arguments.queries[0], 'artist:"Fixture Artist Three"');
});

Deno.test("resolve-artists (invariant D, priority as order): several refreshKeys members occupy the FIRST positions of arguments.queries, IN THE ORDER GIVEN, each index < maxQueries — never mere membership", async () => {
  const libraryRows = [1, 2, 3, 4, 5, 6].map((i) =>
    mdRow({ kind: "artist", key: `artist-${i}`, name: `Fixture Artist ${i}` })
  );
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: { artist: libraryRows },
  };
  const { ctx, runModelCalls } = makeModelDataCtx(
    modelData,
    {},
    {},
    emptyBatchHandler(modelData),
  );
  await run("resolve-artists", {
    refreshKeys: ["artist-5", "artist-2"],
    maxQueries: 400,
  }, ctx);
  const [callArgs] = runModelCalls[0] as [
    { arguments: { queries: string[]; maxQueries: number } },
  ];
  const queries = callArgs.arguments.queries;
  assertEquals(queries[0], 'artist:"Fixture Artist 5"');
  assertEquals(queries[1], 'artist:"Fixture Artist 2"');
  assert(queries.indexOf(queries[0]) < callArgs.arguments.maxQueries);
  assert(queries.indexOf(queries[1]) < callArgs.arguments.maxQueries);
});

Deno.test("resolve-artists: refresh:true re-searches every seed-unresolved artist, ignoring a fresh prior verdict, and the fresh verdict is actually OVERWRITTEN — not merely requested", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-a",
          name: "Fixture Artist A",
        }),
      ],
    },
  };
  const freshCheckedAt = new Date().toISOString();
  const freshPrior = {
    kind: "artistMap",
    scannedAt: "x",
    params: {
      headphonesInstance: "headphones",
      musicbrainzInstance: "musicbrainz",
    },
    resolved: 1,
    ambiguous: 0,
    unresolved: 0,
    entries: [{
      artistKey: "fixture-artist-a",
      artistName: "Fixture Artist A",
      mbid: "deadbeef-0000-4000-8000-00000000000a",
      status: "resolved",
      source: "search",
      candidates: [],
      checkedAt: freshCheckedAt,
    }],
  };
  const { ctx, written, runModelCalls } = makeModelDataCtx(
    modelData,
    { "artist-map": freshPrior },
    {},
    emptyBatchHandler(modelData),
  );
  await run("resolve-artists", { refresh: true }, ctx);
  assertEquals(
    runModelCalls.length,
    1,
    "refresh:true must force a search even though the prior is fresh",
  );
  // The EFFECT, not just the call: a call-count assertion alone passes
  // even against a broken implementation that triggers the search but
  // then still writes the stale prior verbatim (never applying the
  // result) — that bug would leave this test green on master. Assert
  // instead that the previously-fresh entry is genuinely re-searched:
  // emptyBatchHandler resolves every query to a real empty result (no
  // match, no error), so a working refresh must overwrite the prior's
  // "resolved" verdict with a fresh "unresolved" one and a NEW checkedAt
  // — never the untouched prior fields.
  const res = written.find((w) => w.spec === "artistMap")!;
  const entry = (res.payload.entries as Array<Record<string, unknown>>).find(
    (e) => e.artistKey === "fixture-artist-a",
  )!;
  assertEquals(
    entry.status,
    "unresolved",
    "the fresh 'resolved' prior must be overwritten by the empty re-search result",
  );
  assertEquals(
    entry.mbid,
    null,
    "the prior mbid must not survive a real re-search",
  );
  assertEquals(
    entry.checkedAt,
    "x",
    "checkedAt must move to THIS run's fresh search-batch timestamp (emptyBatchHandler's 'x'), not stay pinned at the prior's",
  );
  assert(
    entry.checkedAt !== freshCheckedAt,
    "checkedAt must differ from the untouched prior's checkedAt",
  );
});

Deno.test("resolve-artists: an already-aborted context.signal stops the per-artist loop immediately — no search-artists-batch call, the stale prior verdict is preserved verbatim, and stopReason/truncated say so", async () => {
  // Mirrors musicbrainz_adversarial_test.ts's "search-artists-batch (e)"
  // case (a REAL new AbortController().signal, already aborted, before any
  // work happens) — this is the pin for the HIGH finding: resolve-artists'
  // own two per-artist loops (PASS 1 classification, PASS 2 batch-result
  // scoring) never checked context.signal at all.
  const staleCheckedAt = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days old
  ).toISOString();
  const priorMap = {
    kind: "artistMap",
    scannedAt: "x",
    params: {
      headphonesInstance: "headphones",
      musicbrainzInstance: "musicbrainz",
    },
    resolved: 0,
    ambiguous: 0,
    unresolved: 1,
    entries: [{
      artistKey: "fixture-artist-a",
      artistName: "Fixture Artist A",
      mbid: null,
      status: "unresolved",
      source: "search",
      candidates: [],
      // Stale against the default 30-day ttlMs, so WITHOUT the abort
      // check this artist would normally need a fresh search this run.
      checkedAt: staleCheckedAt,
    }],
  };
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-a",
          name: "Fixture Artist A",
        }),
      ],
    },
  };
  const { ctx, written, runModelCalls } = makeModelDataCtx(
    modelData,
    { "artist-map": priorMap },
    {},
    emptyBatchHandler(modelData),
  );
  const controller = new AbortController();
  controller.abort();
  const ctxWithSignal = { ...ctx, signal: controller.signal };

  await run("resolve-artists", {}, ctxWithSignal);

  assertEquals(
    runModelCalls.length,
    0,
    "an already-aborted signal must prevent any search-artists-batch call — this is what fails if the abort check is removed (the stale entry would then need a search, triggering a real batch call)",
  );
  const res = written.find((w) => w.spec === "artistMap")!;
  assertEquals(res.payload.stopReason, "aborted");
  assertEquals(res.payload.truncated, true);
  const entry = (res.payload.entries as Array<Record<string, unknown>>).find(
    (e) => e.artistKey === "fixture-artist-a",
  )!;
  assertEquals(
    entry.checkedAt,
    staleCheckedAt,
    "the stale prior verdict is preserved verbatim, never refreshed, since the aborted signal must stop the loop before a fresh search happens",
  );
  assertEquals(entry.status, "unresolved");
});

Deno.test("resolve-artists: a signal that aborts DURING the search-artists-batch runModel call stops PASS 2's own loop, not just PASS 1's — PASS 1 completes normally (seed match resolved), the batch call still happens, and every seed-unresolved artist is unreached by PASS 2, falling back to its stale prior verbatim", async () => {
  // The test above uses an already-aborted signal, which breaks PASS 1 at
  // i=0 — the `if (!pass1Aborted && queries.length > 0)` block that is PASS
  // 2's ONLY home is then never entered, so PASS 2's own
  // `context.signal?.aborted` check (~line 3669) is completely unpinned:
  // deleting it leaves every test (including the one above) green. Here the
  // runModelHandler hook aborts the controller from INSIDE runModel, firing
  // synchronously while `await context.runModel(...)` is in flight — after
  // PASS 1 has already classified every library artist (proven below by the
  // seed match surviving) and after the batch row has been written (proven
  // by runModelCalls.length === 1), but before PASS 2 reads any of it.
  const staleCheckedAtA = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days old
  ).toISOString();
  const staleCheckedAtB = new Date(
    Date.now() - 45 * 24 * 60 * 60 * 1000, // 45 days old
  ).toISOString();
  const priorMap = {
    kind: "artistMap",
    scannedAt: "x",
    params: {
      headphonesInstance: "headphones",
      musicbrainzInstance: "musicbrainz",
    },
    resolved: 1,
    ambiguous: 0,
    unresolved: 1,
    entries: [
      {
        artistKey: "fixture-artist-a",
        artistName: "Fixture Artist A",
        mbid: null,
        status: "unresolved",
        source: "search",
        candidates: [],
        checkedAt: staleCheckedAtA,
      },
      {
        artistKey: "fixture-artist-b",
        artistName: "Fixture Artist B",
        mbid: "deadbeef-0000-4000-8000-0000000000b1",
        status: "resolved",
        source: "search",
        candidates: [],
        checkedAt: staleCheckedAtB,
      },
    ],
  };
  const modelData: ModelData = {
    headphones: {
      artists: [
        mdRow({
          artists: [{
            ArtistID: "cafebabe-0000-4000-8000-00000000feed",
            ArtistName: "Fixture Artist Seed",
          }],
          total: 1,
          timestamp: "x",
        }),
      ],
    },
    music: {
      artist: [
        mdRow({
          kind: "artist",
          key: "fixture-artist-seed",
          name: "Fixture Artist Seed",
        }),
        mdRow({
          kind: "artist",
          key: "fixture-artist-a",
          name: "Fixture Artist A",
        }),
        mdRow({
          kind: "artist",
          key: "fixture-artist-b",
          name: "Fixture Artist B",
        }),
      ],
    },
  };
  const controller = new AbortController();
  const { ctx, written, runModelCalls } = makeModelDataCtx(
    modelData,
    { "artist-map": priorMap },
    {},
    (call) => {
      // Write the batch row first, mirroring a real search-artists-batch
      // invocation actually completing (empty/no-match, no error) — so
      // PASS 2, if its own abort check were missing, would find a real
      // verdict sitting there to wrongly act on. THEN abort — the signal
      // is live for the loop that runs after this handler returns, never
      // for PASS 1, which has already finished by the time runModel is
      // even called.
      emptyBatchHandler(modelData)(call);
      controller.abort();
    },
  );
  const ctxWithSignal = { ...ctx, signal: controller.signal };

  await run("resolve-artists", {}, ctxWithSignal);

  assertEquals(
    runModelCalls.length,
    1,
    "PASS 1 must complete and dispatch exactly one search-artists-batch call before the abort (mid-call) lands",
  );
  const res = written.find((w) => w.spec === "artistMap")!;
  assertEquals(res.payload.stopReason, "aborted");
  assertEquals(res.payload.truncated, true);
  assertEquals(
    res.payload.pendingSearch,
    2,
    "both seed-unresolved artists (A and B) are unreached by PASS 2's loop, which breaks at i=0 — this fixture's own two pending artists, not a copied figure",
  );

  const entries = res.payload.entries as Array<Record<string, unknown>>;
  assertEquals(
    entries.map((e) => e.artistKey),
    ["fixture-artist-seed", "fixture-artist-a", "fixture-artist-b"],
    "every library artist is still present in the written map, in library order",
  );

  const seedEntry = entries.find((e) => e.artistKey === "fixture-artist-seed")!;
  assertEquals(
    seedEntry.status,
    "resolved",
    "PASS 1's seed classification still completed normally — proof the abort landed after PASS 1, not during it",
  );
  assertEquals(seedEntry.source, "seed");
  assertEquals(seedEntry.mbid, "cafebabe-0000-4000-8000-00000000feed");

  const entryA = entries.find((e) => e.artistKey === "fixture-artist-a")!;
  assertEquals(entryA.status, "unresolved");
  assertEquals(entryA.mbid, null);
  assertEquals(
    entryA.checkedAt,
    staleCheckedAtA,
    "A's stale prior verdict is preserved verbatim — PASS 2 never reached it to overwrite checkedAt with this run's fresh batch timestamp",
  );

  const entryB = entries.find((e) => e.artistKey === "fixture-artist-b")!;
  assertEquals(entryB.status, "resolved");
  assertEquals(entryB.mbid, "deadbeef-0000-4000-8000-0000000000b1");
  assertEquals(
    entryB.checkedAt,
    staleCheckedAtB,
    "B's stale prior verdict is preserved verbatim too, including its previously-resolved mbid",
  );
});

Deno.test("resolve-artists: Lucene metacharacters in a library artist name are escaped before reaching arguments.queries", async () => {
  const modelData: ModelData = {
    headphones: { artists: [mdRow({ artists: [], total: 0, timestamp: "x" })] },
    music: {
      artist: [
        mdRow({ kind: "artist", key: "fixture-ac-dc", name: "Fixture AC/DC?" }),
      ],
    },
  };
  const { ctx, runModelCalls } = makeModelDataCtx(
    modelData,
    {},
    {},
    emptyBatchHandler(modelData),
  );
  await run("resolve-artists", {}, ctx);
  const [callArgs] = runModelCalls[0] as [{ arguments: { queries: string[] } }];
  assertEquals(callArgs.arguments.queries[0], 'artist:"Fixture AC\\/DC\\?"');
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

const REAL_HOST_RE = /\.aopab\.art\b/i;
const RFC1918_RE =
  /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;
const PEM_RE = /-----BEGIN [A-Z ]+-----/;
const HIGH_ENTROPY_TOKEN = /^[A-Za-z0-9+/=]{32,}$/;

function tokensOf(text: string): string[] {
  return text.split(/[^A-Za-z0-9+/=]+/).filter((t) => t.length > 0);
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

const FIXTURES: Record<string, unknown> = {
  "tracks.json": tracksFixture,
  "genres.json": genresFixture,
  "verify_files.json": verifyFilesFixture,
  "probe.json": probeFixture,
  "headphones_artists.json": headphonesArtistsFixture,
  "mb_release_groups.json": mbReleaseGroupsFixture,
  "mb_release_groups_empty.json": mbReleaseGroupsEmptyFixture,
  "mb_artist_search_batch.json": mbArtistSearchBatchFixture,
};

Deno.test("fixtures-secret-scan: no string leaf in any committed fixture matches a real RFC1918 address, a real *.aopab.art host, a PEM marker, or a high-entropy token shape", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      if (RFC1918_RE.test(str)) {
        violations.push(`${file}: value "${str}" contains an RFC1918 address`);
      }
      if (REAL_HOST_RE.test(str)) {
        violations.push(
          `${file}: value "${str}" contains a real *.aopab.art host`,
        );
      }
      if (PEM_RE.test(str)) {
        violations.push(`${file}: value "${str}" matched a PEM block marker`);
      }
      for (const token of tokensOf(str)) {
        if (HIGH_ENTROPY_TOKEN.test(token)) {
          violations.push(
            `${file}: token "${token}" is high-entropy-shaped (32+ chars)`,
          );
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret/real-name-shaped content found:\n${violations.join("\n")}`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually flags an injected real-LAN address, real host, PEM marker, and high-entropy shape (anti-vacuity)", () => {
  assert(RFC1918_RE.test("192.168.88.242"), "must flag a real-LAN-shaped IP");
  assert(
    REAL_HOST_RE.test("mk.aopab.art"),
    "must flag a real *.aopab.art host",
  );
  const poisonPem = "-----BEGIN" + " PRIVATE KEY-----";
  assert(PEM_RE.test(poisonPem), "must flag a real BEGIN marker");
  const poisonToken = "a".repeat(40);
  assert(
    HIGH_ENTROPY_TOKEN.test(poisonToken),
    "must flag a 40-char alnum blob",
  );
});
