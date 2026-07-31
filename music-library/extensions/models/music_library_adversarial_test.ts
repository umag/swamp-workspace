/**
 * Adversarial suite for @magistr/music-library: attacker's-perspective
 * characterization of the model's real injection/robustness surface, plus a
 * mechanical fixtures secret-scan.
 *
 * music_library.ts is BYTE-FROZEN — every "pin: KNOWN BUG" test here
 * characterizes a REAL, already-shipped gap rather than proposing a fix (a
 * fix is out of scope for this test-only backfill). Six latent bugs found
 * during this backfill, filed against the LOCAL
 * `music-library-latent-bugs` issue-lifecycle model (never the Lab):
 *
 *   LB1 (MEDIUM) — verify's remote ffmpeg decode loop has NO per-file
 *        timeout (contrast with bpm's ANALYZE_PY, which wraps every file in
 *        `signal.alarm(timeout)`): a single wedged/huge file hangs the rest
 *        of that worker's chunk forever.
 *   LB2 (MEDIUM) — verify/bpm/probe's `path` argument only strips LEADING
 *        slashes (`replace(/^\/+/, "")`), never `../` — a hostile `path`
 *        traverses outside `containerMusicRoot` verbatim.
 *   LB3 (LOW) — `probe` on an ffprobe call that exits 0 with empty stdout
 *        crashes with a raw, unwrapped `SyntaxError` from `JSON.parse("")`
 *        instead of a clean, actionable error.
 *   LB4 (LOW) — `verify`'s US(0x1f)/RS(0x1e) record framing is not RS-safe:
 *        the `safe` filter only screens INPUT filenames for control bytes,
 *        never ffmpeg's OWN captured stderr/stdout text. An embedded RS byte
 *        in that text splits one real record into two, and the genuine
 *        error content can land in the discarded half — silently
 *        MISCLASSIFYING a corrupt file as "ok".
 *   LB5 (LOW) — `bpmMedian` on an EVEN track count returns the UPPER of the
 *        two middle values (`bpms[Math.floor(n/2)]`) instead of averaging
 *        them.
 *   LB6 (LOW) — `bpm`'s carried-over `tracks`/`failures` arrays have NO size
 *        cap or truncation flag, unlike `verify`'s explicit
 *        `problems.slice(0, 2000)` + `problemsTruncated`.
 *
 * PLUS two regression-pinned POSITIVES (deliberately checked and confirmed
 * to hold, not just assumed):
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
import { model } from "./music_library.ts";
import tracksFixture from "../../fixtures/tracks.json" with { type: "json" };
import genresFixture from "../../fixtures/genres.json" with { type: "json" };
import verifyFilesFixture from "../../fixtures/verify_files.json" with {
  type: "json",
};
import probeFixture from "../../fixtures/probe.json" with { type: "json" };

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

Deno.test("pin: KNOWN BUG (MEDIUM, music-library-latent-bugs LB1) — verify's remote ffmpeg loop has NO per-file decode timeout, unlike bpm's essentia analyzer", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({ verifyRows: [vOk1] }),
    async (stub) => {
      await run("verify", {}, ctx);
      const script = stub.calls
        .find((c) => c.args.join(" ").includes("ffmpeg"))!
        .args.join(" ");
      assert(
        !/\btimeout\b/.test(script),
        "no `timeout` wrapper appears anywhere around the remote ffmpeg " +
          "invocation — a single wedged or oversized file blocks that " +
          "worker's ENTIRE remaining chunk forever (contrast with bpm's " +
          "ANALYZE_PY, which wraps every file in signal.alarm(timeout))",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// LB2 (MEDIUM) — path traversal via the `path` argument
// ---------------------------------------------------------------------------

const TRAVERSAL = "../../../etc/passwd";

Deno.test("pin: KNOWN BUG (MEDIUM, music-library-latent-bugs LB2) — verify's `path` argument strips only LEADING slashes, so '../' traverses outside containerMusicRoot", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({}),
    async (stub) => {
      await run("verify", { path: TRAVERSAL }, ctx);
      const ffmpegCall = stub.calls.find((c) =>
        c.args.join(" ").includes("ffmpeg")
      )!;
      assertEquals(
        ffmpegCall.stdin.trim(),
        `${CROOT}/${TRAVERSAL}`,
        "the '../' sequence survives verbatim into the container path fed " +
          "to ffmpeg — containerMusicRoot is never actually enforced as a " +
          "traversal boundary, only prepended as a string",
      );
    },
  );
});

Deno.test("pin: KNOWN BUG (MEDIUM, music-library-latent-bugs LB2 sibling) — bpm's `path` argument has the identical traversal gap", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({}),
    async (stub) => {
      await run("bpm", { path: TRAVERSAL }, ctx);
      const essentiaCall = stub.calls.find((c) =>
        c.args.join(" ").includes("python3")
      )!;
      assertEquals(essentiaCall.stdin.trim(), `${CROOT}/${TRAVERSAL}`);
    },
  );
});

Deno.test("pin: KNOWN BUG (MEDIUM, music-library-latent-bugs LB2 sibling) — probe's `path` argument has the identical traversal gap", async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    makeRouter({ probe: probeFixture }),
    async (stub) => {
      await run("probe", { path: TRAVERSAL }, ctx);
      const cmd = stub.calls[0].args.join(" ");
      assert(
        cmd.includes(`${CROOT}/${TRAVERSAL}`),
        "the traversal path is embedded verbatim (only shQuote-escaped, " +
          "never validated) into the ffprobe command",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// LB3 (LOW) — probe crashes with a raw SyntaxError on empty ffprobe stdout
// ---------------------------------------------------------------------------

Deno.test('pin: KNOWN BUG (LOW, music-library-latent-bugs LB3) — probe on an ffprobe call that exits 0 with EMPTY stdout crashes with a raw, unwrapped SyntaxError from JSON.parse("")', async () => {
  const { ctx } = makeCtx();
  await withSshStub(
    () => ({ success: true, stdout: "", stderr: "" }),
    () =>
      assertRejects(
        () => run("probe", { path: "any/file.mp3" }, ctx),
        SyntaxError,
      ),
  );
});

// ---------------------------------------------------------------------------
// LB4 (LOW) — verify's US/RS record framing is not RS-safe
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN BUG (LOW, music-library-latent-bugs LB4) — an RS(0x1e) byte embedded in ffmpeg's OWN captured output splits one real record in two, silently MISCLASSIFYING a corrupt file as ok", async () => {
  const cpath = cpathOfRow(vOk1);
  // Only the file LIST fed to ffmpeg is filtered for control bytes (the
  // `safe` filter, applied to args.path/pathPrefix-derived paths) — nothing
  // filters or escapes ffmpeg's OWN stderr/stdout text ($out) before it is
  // embedded into the printf-framed record. A clean-looking progress line
  // BEFORE the embedded RS byte, followed by the file's REAL corruption
  // report AFTER it, demonstrates the file being wrongly accepted as "ok"
  // while the genuine error text is silently discarded.
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
    1,
    "the file is (WRONGLY) counted as ok — the RS byte truncated the " +
      "record to just the clean-looking progress line before it",
  );
  assertEquals(res.payload.errors, 0);
  assertEquals(res.payload.failed, 0);
  assertEquals(
    res.payload.missingRecords,
    0,
    "the file IS seen — just misclassified, not lost outright",
  );
  assert(
    !JSON.stringify(res.payload).includes("Header missing"),
    "the file's REAL decode error ('Header missing') never appears " +
      "anywhere in the written resource — it landed in the second, " +
      "orphaned half of the split record, whose parts[0] does not match " +
      "any known cpath and is therefore silently dropped",
  );
});

// ---------------------------------------------------------------------------
// LB5 (LOW) — bpmMedian off-by-one on an even track count
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN BUG (LOW, music-library-latent-bugs LB5) — bpmMedian on an EVEN track count returns the UPPER-middle value instead of averaging the two middle values", async () => {
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
    200,
    "the mathematically correct median of [100, 200] is 150; " +
      "bpms[Math.floor(n / 2)] instead indexes the UPPER of the two " +
      "middle sorted values for any even-length bpm array",
  );
});

// ---------------------------------------------------------------------------
// LB6 (LOW) — bpm's carried tracks/failures arrays have no size cap
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN BUG (LOW, music-library-latent-bugs LB6) — bpm's carried-over tracks array has NO size cap or truncation flag, unlike verify's explicit 2000-entry cap", async () => {
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
    () => run("bpm", {}, ctx),
  );
  const res = written.find((w) => w.spec === "bpm")!;
  const tracks = res.payload.tracks as unknown[];
  assertEquals(
    tracks.length,
    2501,
    "all 2500 carried tracks plus the 1 newly analyzed one are written " +
      "back verbatim into a SINGLE resource — BpmSchema has no cap field " +
      "and the code applies no .slice(...) anywhere, contrast with " +
      "verify's `problems: problemsTruncated ? problems.slice(0, 2000) : " +
      "problems`",
  );
  assertEquals(
    "tracksTruncated" in (res.payload as Record<string, unknown>),
    false,
  );
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
