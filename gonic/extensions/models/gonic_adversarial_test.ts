/**
 * Adversarial suite: attacker's-perspective tests for @magistr/gonic. The two
 * original HIGH findings tracked by the local `gonic-latent-bugs`
 * issue-lifecycle model are FIXED and verified below: TOKEN-auth (no more
 * URL-query credential leak) and shellEsc-quoted command injection via a
 * DB-sourced `root_dir`. This change ALSO fixes the remaining MED/LOW
 * findings from the same model: db-query's unenforced "read-only" guard now
 * really enforces read-only via `-readonly` (e), the db-exec change-count is
 * now derived from the write's own connection (f), a fetch-layer rejection
 * is now redacted (b), and the second-granular `dbResult` name clobber is
 * closed with a monotonic disambiguator (h). Hostile Subsonic responses (g)
 * are a separate, unrelated bug class and stay PINNED as characterized
 * (buggy) behavior — out of scope for this change.
 *
 * gonic.ts is no longer wholly byte-frozen — this change edits it to close
 * the HIGH findings above plus LB3/LB4/LB5/LB7/LB8; every OTHER test here
 * still PINS current behavior (including behavior that is arguably
 * risky/buggy). Where a test documents a real gap, it is labeled
 * "pin"/"HONEST GAP" and says so explicitly. Every finding here is filed
 * against the LOCAL `gonic-latent-bugs` issue-lifecycle model, never the
 * Lab. See fixtures/PROVENANCE.md for fixture provenance.
 *
 * Pagination: NOT APPLICABLE. Every Subsonic endpoint gonic.ts wraps
 * (getPodcasts, getPlaylists, getScanStatus, ping) returns a full set with no
 * paging parameters in the Subsonic REST API — there is no pagination edge
 * case to test here.
 *
 * Toolchain rule: no `as typeof <global-builtin>` casts — the fetch seam uses
 * the double-bridge `as unknown as typeof globalThis.fetch` cast; the
 * Deno.Command seam is reassigned via `FakeCommand as unknown as typeof
 * Deno.Command`.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { crypto as stdCrypto } from "jsr:@std/crypto@1";
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

const HOST = "gonic.example.com";
const PORT = 4747;
const USERNAME = "listener";
const PASSWORD = "fixture-only-not-a-real-password-000";
const GLOBAL_ARGS = {
  host: HOST,
  port: PORT,
  username: USERNAME,
  password: PASSWORD,
  sshUser: "root",
  dbPath: "/data/gonic.db",
};

function hexEncode(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
const PASSWORD_HEX = hexEncode(PASSWORD);

/** Independent md5hex(input) — used to recompute the expected Subsonic
 * token from a captured (random) per-request salt, never a fixed constant. */
async function md5Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await stdCrypto.subtle.digest("MD5", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Reverse of `shellEsc` (gonic.ts) via the actual POSIX single-quote
 * quoting grammar: `'<verbatim>'` segments concatenate with backslash-escaped
 * literal quotes (`\'`) between them into ONE shell word, exactly like
 * `'foo'\''bar'` => `foo'bar`. Used to PROVE a captured shellEsc'd argument
 * parses as exactly one inert word — not to execute a real shell. */
function posixUnquoteSingleArg(shellEscaped: string): string {
  let result = "";
  let i = 0;
  while (i < shellEscaped.length) {
    if (shellEscaped[i] === "'") {
      const end = shellEscaped.indexOf("'", i + 1);
      assert(end !== -1, `unterminated single quote at ${i}`);
      result += shellEscaped.slice(i + 1, end);
      i = end + 1;
    } else if (shellEscaped[i] === "\\" && shellEscaped[i + 1] === "'") {
      result += "'";
      i += 2;
    } else {
      throw new Error(
        `unexpected character outside single/backslash-quoting at ${i}: ${
          JSON.stringify(shellEscaped.slice(i, i + 5))
        }`,
      );
    }
  }
  return result;
}

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
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

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function restRoute(endpoint: string, body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname !== `/rest/${endpoint}`) return undefined;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function withOneEndpoint(
  endpoint: string,
  body: unknown,
  fn: (calls: Request[]) => Promise<unknown>,
) {
  await withFetchStub([restRoute(endpoint, body)], fn);
}

type CommandResult = { success: boolean; stdout: string; stderr: string };
type CommandInvocation = { commandLine: string; stdin: string };
type CommandRouter = (inv: CommandInvocation) => CommandResult;

function installCommandStub(router: CommandRouter) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const invocations: CommandInvocation[] = [];
  const constructions: string[] = [];

  class FakeCommand {
    #commandLine: string;
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      const args = options.args ?? [];
      this.#commandLine = args[args.length - 1] ?? "";
      constructions.push(this.#commandLine);
    }
    output() {
      const inv: CommandInvocation = {
        commandLine: this.#commandLine,
        stdin: "",
      };
      invocations.push(inv);
      const r = router(inv);
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        stdout: encoder.encode(r.stdout),
        stderr: encoder.encode(r.stderr),
      });
    }
    spawn() {
      const commandLine = this.#commandLine;
      let written = "";
      return {
        stdin: {
          getWriter: () => ({
            write: (bytes: Uint8Array) => {
              written += decoder.decode(bytes);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          const inv: CommandInvocation = { commandLine, stdin: written };
          invocations.push(inv);
          const r = router(inv);
          return Promise.resolve({
            success: r.success,
            code: r.success ? 0 : 1,
            stdout: encoder.encode(r.stdout),
            stderr: encoder.encode(r.stderr),
          });
        },
      };
    }
  }

  const original = Deno.Command;
  Deno.Command = FakeCommand as unknown as typeof Deno.Command;
  return {
    invocations,
    constructions,
    restore: () => {
      Deno.Command = original;
    },
  };
}

async function withCommandStub(
  router: CommandRouter,
  fn: (stub: ReturnType<typeof installCommandStub>) => Promise<unknown>,
) {
  const stub = installCommandStub(router);
  try {
    await fn(stub);
  } finally {
    stub.restore();
  }
}

// ---------------------------------------------------------------------------
// (a) FIXED — Subsonic TOKEN auth: t=md5hex(password+salt), s=salt, NO p
// param. The password is never sent (nor a reversible encoding of it) over
// the wire; token+salt for one request cannot be inverted back to the
// password.
// ---------------------------------------------------------------------------

Deno.test("fixed: the Subsonic auth uses TOKEN auth (t=md5hex(password+salt), s=salt) — NO p param, password NOT recoverable from the URL", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("ping", pingFixture, async (calls) => {
    await run("ping", {}, ctx);
    const url = new URL(calls[0].url);
    assertEquals(
      url.protocol,
      "http:",
      "gonic.ts hardcodes plaintext http:// (transport hardening is a separate, deferred concern)",
    );
    assertEquals(
      url.searchParams.get("p"),
      null,
      "no p param — the raw or reversibly-encoded password must never travel in the URL",
    );
    const s = url.searchParams.get("s")!;
    const t = url.searchParams.get("t")!;
    assert(/^[0-9a-f]+$/i.test(s), "salt s must be hex-shaped");
    const expectedToken = await md5Hex(PASSWORD + s);
    assertEquals(
      t,
      expectedToken,
      "t must equal md5hex(password + the emitted per-request salt)",
    );
    const raw = url.toString();
    assert(
      !raw.includes(PASSWORD),
      "the raw password must never appear anywhere in the URL",
    );
    assert(
      !raw.toLowerCase().includes(PASSWORD_HEX),
      "the hex-encoded password must not appear anywhere in the URL either",
    );
  });
});

// ---------------------------------------------------------------------------
// (b) FIXED — network-error credential leak: gonicApi now wraps `await
// fetch(url)` in a try/catch that redacts the password (and its hex form)
// from both the thrown error's message AND its (redacted-copy) cause/stack.
// ---------------------------------------------------------------------------

Deno.test("fixed: a fetch-layer rejection is REDACTED — no sentinel password/hex survives in the message, cause, or stack", async () => {
  // gonicApi now does `try { resp = await fetch(url); } catch (err) { throw
  // new Error(redactSecret(err, password), { cause: redactedCause(err,
  // password) }); }` — ANY rejection (DNS failure, TLS error, connection
  // reset) is redacted before it ever reaches the caller. This test uses a
  // clearly-synthetic sentinel password (never the real `gonic` vault key or
  // any real value) and frames the constructed rejection as a stand-in for
  // what SOME network-layer failure modes surface — the point being that
  // gonic.ts now redacts a credential even if the underlying error message
  // embedded one.
  const SENTINEL_PASSWORD = "sentinel-net-err-ZZZZ-not-a-real-password";
  const sentinelHex = hexEncode(SENTINEL_PASSWORD);
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, password: SENTINEL_PASSWORD });
  const leakedUrl =
    `http://${HOST}:${PORT}/rest/ping?u=${USERNAME}&p=enc:${sentinelHex}&v=1.15.0&c=swamp&f=json`;
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(
      new Error(`network error: connect ECONNRESET ${leakedUrl}`),
    )) as unknown as typeof globalThis.fetch;
  try {
    const err = await assertRejects(() => run("ping", {}, ctx), Error);
    assert(
      !err.message.includes(sentinelHex),
      "the redacted message must not contain the sentinel hex encoding",
    );
    assert(
      !err.message.includes(SENTINEL_PASSWORD),
      "the redacted message must not contain the raw sentinel password",
    );
    assert(
      err.message.includes("<redacted>"),
      "the redacted message must show the <redacted> marker in place of the credential",
    );
    if (err.cause instanceof Error) {
      assert(
        !err.cause.message.includes(sentinelHex),
        "the redacted cause's message must not contain the sentinel hex encoding",
      );
      if (typeof err.cause.stack === "string") {
        assert(
          !err.cause.stack.includes(sentinelHex),
          "the redacted cause's stack must not contain the sentinel hex encoding",
        );
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// (c) Domain-error NON-leak — a failed envelope's error message never
// carries the password (contrast with (b)'s gap).
// ---------------------------------------------------------------------------

Deno.test("a failed Subsonic envelope's error message never carries the password (server-controlled text only)", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("ping", errorFixture, async () => {
    const err = await assertRejects(() => run("ping", {}, ctx), Error);
    assert(!err.message.includes(PASSWORD));
    assert(!err.message.includes(PASSWORD_HEX));
  });
});

// ---------------------------------------------------------------------------
// (d) FIXED — ensure-podcast-dirs shellEsc-quotes a DB-sourced root_dir
// before interpolating it into `mkdir -p <hostDir>`; an embedded single
// quote is neutralized (escaped) rather than breaking out of the quoting.
// ---------------------------------------------------------------------------

Deno.test("fixed: ensure-podcast-dirs shellEsc-quotes a DB-sourced root_dir — an embedded single quote is NEUTRALIZED, the payload does NOT break out", async () => {
  const { ctx } = makeCtx();
  const maliciousRootDir = "/podcasts/Foo' && touch /tmp/pwned && echo '";
  const hostBase = "/mnt/user/podcasts";
  let capturedMkdir = "";
  await withCommandStub(
    (inv) => {
      if (inv.commandLine === "sqlite3 -json '/data/gonic.db'") {
        return {
          success: true,
          stdout: JSON.stringify([
            { id: "pd-1", title: "Foo", root_dir: maliciousRootDir },
          ]),
          stderr: "",
        };
      }
      if (inv.commandLine.startsWith("docker inspect gonic")) {
        return { success: true, stdout: hostBase + "\n", stderr: "" };
      }
      if (inv.commandLine.startsWith("mkdir -p ")) {
        capturedMkdir = inv.commandLine;
        return { success: true, stdout: "", stderr: "" };
      }
      throw new Error(`unrouted: ${inv.commandLine}`);
    },
    () => run("ensure-podcast-dirs", {}, ctx),
  );
  const subdir = "Foo' && touch /tmp/pwned && echo '";
  const hostDir = `${hostBase}/${subdir}`;
  // shellEsc: wrap in single quotes, each embedded `'` becomes `'\''`.
  const expectedEscaped = `'${hostDir.replace(/'/g, "'\\''")}'`;
  assertEquals(
    capturedMkdir,
    `mkdir -p ${expectedEscaped}`,
    "root_dir is shellEsc-quoted — every embedded single quote is escaped as '\\''",
  );
  // Ground truth via the actual POSIX single-quote quoting grammar (not a
  // fragile substring check — a naive "the raw substring doesn't appear"
  // assertion is WRONG here: shellEsc's own `'\''` escape sequences
  // necessarily contain adjacent quote characters, so raw substrings of the
  // payload can innocuously reappear inside a CORRECTLY escaped string).
  // posixUnquoteSingleArg parses `'<content>'` / `'\''`-escaped segments per
  // POSIX shell quoting rules and reconstructs the single word a real shell
  // would see. Reconstructing the EXACT original hostDir proves the whole
  // thing parses as ONE inert argument — `&&`, `touch`, `echo` are all just
  // DATA, never live shell syntax.
  const arg = capturedMkdir.slice("mkdir -p ".length);
  assertEquals(
    posixUnquoteSingleArg(arg),
    hostDir,
    "a real POSIX shell must parse the mkdir argument as exactly ONE word " +
      "equal to hostDir — metacharacters neutralized as data, not syntax",
  );
});

// ---------------------------------------------------------------------------
// (d2) FIXED — sshExecSql shellEsc-quotes dbPath (operator-controlled
// config — smaller blast radius than root_dir, but the same shellEsc
// mechanism, so it gets the same rigor here).
// ---------------------------------------------------------------------------

Deno.test("fixed: sshExecSql shellEsc-quotes dbPath — an embedded single quote is NEUTRALIZED, a real shell parses it as ONE word", async () => {
  const maliciousDbPath =
    "/data/gonic's-backup' && touch /tmp/pwned && echo '.db";
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, dbPath: maliciousDbPath });
  let capturedCommandLine = "";
  await withCommandStub(
    (inv) => {
      capturedCommandLine = inv.commandLine;
      return { success: true, stdout: "", stderr: "" };
    },
    () => run("db-query", { sql: "SELECT 1" }, ctx),
  );
  const expectedEscaped = `'${maliciousDbPath.replace(/'/g, "'\\''")}'`;
  assertEquals(
    capturedCommandLine,
    `sqlite3 -json -readonly ${expectedEscaped}`,
    "dbPath is shellEsc-quoted — every embedded single quote is escaped as '\\''",
  );
  const arg = capturedCommandLine.slice("sqlite3 -json -readonly ".length);
  assertEquals(
    posixUnquoteSingleArg(arg),
    maliciousDbPath,
    "a real POSIX shell must parse the sqlite3 dbPath argument as exactly " +
      "ONE word equal to dbPath — metacharacters neutralized as data",
  );
});

// ---------------------------------------------------------------------------
// (e) FIXED — db-query is now ENFORCED read-only via sqlite3's `-readonly`
// flag: a mutating statement against a real read-only connection is rejected
// by sqlite3 itself (non-zero exit, "attempt to write a readonly database"),
// which sshExecSql surfaces as a thrown error. This is stronger than
// SQL-string sniffing.
// ---------------------------------------------------------------------------

Deno.test("fixed: db-query enforces a REAL read-only guard via -readonly — a DELETE statement is rejected by sqlite3 itself, non-vacuously", async () => {
  const { ctx } = makeCtx();
  const deleteSql = "DELETE FROM podcasts WHERE id = 'pd-1'";
  await withCommandStub(
    (inv) => {
      assertEquals(
        inv.commandLine,
        "sqlite3 -json -readonly '/data/gonic.db'",
        "db-query must pass BOTH -json and -readonly to sqlite3",
      );
      assertEquals(
        inv.stdin,
        deleteSql + "\n",
        "the mutating SQL is still piped through unmodified — the guard is " +
          "sqlite3's own read-only connection enforcement, not string sniffing",
      );
      // Simulate what a REAL `-readonly` sqlite3 connection does when handed
      // a write: it rejects with a non-zero exit and this exact message.
      return {
        success: false,
        stdout: "",
        stderr: "Runtime error: attempt to write a readonly database\n",
      };
    },
    () =>
      assertRejects(
        () => run("db-query", { sql: deleteSql }, ctx),
        Error,
        "attempt to write a readonly database",
      ),
  );
});

// ---------------------------------------------------------------------------
// (f) FIXED — db-exec's change-count is now derived from the SAME sqlite3
// connection as the write (one combined `<sql>;\nSELECT changes();` session),
// not a fresh, structurally-disconnected connection.
// ---------------------------------------------------------------------------

Deno.test("fixed: db-exec's reported change-count derives from the write's OWN connection — a single combined session, not a fresh disconnected one", async () => {
  const { ctx, written } = makeCtx();
  const sql = "UPDATE podcasts SET title = 'X' WHERE 1=1";
  const combinedStdin = `${sql};\nSELECT changes();\n`;
  let constructionCount = 0;
  await withCommandStub(
    (inv) => {
      constructionCount++;
      assertEquals(
        inv.commandLine,
        "sqlite3  '/data/gonic.db'",
        "db-exec passes NO -json flag (jsonMode=false)",
      );
      assertEquals(
        inv.stdin,
        combinedStdin,
        "the write and SELECT changes() must run as ONE combined statement " +
          "on the SAME connection — not two separate sshExecSql calls",
      );
      // A real sqlite3 session: the write itself produces no stdout, then
      // the trailing SELECT changes() on the SAME connection reports the
      // write's ACTUAL effect — a non-zero value proves this is derived
      // from the real write, not a fresh connection's meaningless 0.
      return { success: true, stdout: "5\n", stderr: "" };
    },
    () => run("db-exec", { sql }, ctx),
  );
  assertEquals(
    constructionCount,
    1,
    "exactly ONE Deno.Command construction — a single connection, not two",
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(
    res.payload.rows,
    [{ changes: 5 }],
    "reports the write's own connection's changes() — non-zero, structurally derived from the real write, not a disconnected fresh connection's meaningless count",
  );
});

// ---------------------------------------------------------------------------
// (g) Hostile Subsonic responses
// ---------------------------------------------------------------------------

Deno.test("pin: a non-array truthy `channel` (hostile getPodcasts response) throws a TypeError from .map", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    {
      "subsonic-response": {
        status: "ok",
        podcasts: { channel: "not-an-array" },
      },
    },
    () => assertRejects(() => run("get-podcasts", {}, ctx), TypeError),
  );
});

Deno.test("pin: a non-array truthy `playlist` (hostile getPlaylists response) throws a TypeError from .map", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint(
    "getPlaylists",
    {
      "subsonic-response": {
        status: "ok",
        playlists: { playlist: { unexpected: "shape" } },
      },
    },
    () => assertRejects(() => run("get-playlists", {}, ctx), TypeError),
  );
});

Deno.test("pin: non-ok HTTP embeds the FULL response body verbatim — gonic.ts does not truncate/slice it", async () => {
  const { ctx } = makeCtx();
  const longBody = "x".repeat(500);
  await withFetchStub(
    [(req) => {
      if (new URL(req.url).pathname !== "/rest/ping") return undefined;
      return new Response(longBody, { status: 500 });
    }],
    () =>
      assertRejects(
        () => run("ping", {}, ctx),
        Error,
        `Gonic API ping failed: 500 ${longBody}`,
      ),
  );
});

// ---------------------------------------------------------------------------
// (h) FIXED — dbResult name clobber is closed via a monotonic disambiguator:
// two calls within the SAME (even frozen) wall-clock second/millisecond now
// get DISTINCT names.
// ---------------------------------------------------------------------------

Deno.test("fixed: db-query's resource name no longer clobbers under a FROZEN Date — two calls within the identical instant get DISTINCT names", async () => {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor() {
      super("2026-07-30T12:34:56.789Z");
    }
    override toISOString() {
      return "2026-07-30T12:34:56.789Z";
    }
  }
  (globalThis as unknown as Record<string, unknown>).Date = FrozenDate;
  const { ctx, written } = makeCtx();
  try {
    await withCommandStub(
      () => ({ success: true, stdout: "", stderr: "" }),
      async () => {
        await run("db-query", { sql: "SELECT 1" }, ctx);
        await run("db-query", { sql: "SELECT 2" }, ctx);
      },
    );
  } finally {
    (globalThis as unknown as Record<string, unknown>).Date = RealDate;
  }
  const names = written.filter((w) => w.spec === "dbResult").map((w) => w.name);
  assertEquals(names.length, 2);
  assertEquals(
    names[0] !== names[1],
    true,
    "two calls within the identical frozen instant must NOT collide on the same resource name — the monotonic counter disambiguates them",
  );
  for (const name of names) {
    assert(
      /^query-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-z]+$/.test(
        name,
      ),
      `name must keep full ms+Z precision AND a trailing monotonic sequence suffix, got: ${name}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (i) Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // The Subsonic enc:<hex> credential blob this model actually produces.
  { name: "gonic enc:<hex> credential blob", re: /\benc:[0-9a-f]{16,}\b/i },
  // A bare long lowercase-hex run (the hex-encoded password without its
  // "enc:" prefix, e.g. if it ever leaked into a log line unprefixed).
  { name: "bare long lowercase-hex run", re: /\b[0-9a-f]{32,}\b/i },
  // The vault key name backing gonic's globalArguments.password.
  { name: "vault key name PASSWORD", re: /\bPASSWORD\b/ },
  // Generic high-entropy blob: entirely 32+ alnum/base64url chars, no
  // separators — none of our authored fixture values (ids, urls, titles,
  // numeric fields) match this shape.
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9+/_=-]{32,}$/ },
];

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
  "ping.json": pingFixture,
  "get-podcasts.json": getPodcastsFixture,
  "scan-status.json": scanStatusFixture,
  "start-scan.json": startScanFixture,
  "get-playlists.json": getPlaylistsFixture,
  "error.json": errorFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected enc:<hex> secret shape", () => {
  // Guards against the scan test above being vacuously true.
  const violations: string[] = [];
  const poisoned = { auth: "enc:" + "a1b2c3d4".repeat(4) };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag an injected enc:<hex> shape",
  );
});
