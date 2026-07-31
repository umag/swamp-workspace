/**
 * Adversarial suite: attacker's-perspective tests for @magistr/headphones —
 * apikey-in-URL non-leak GREEN pins, redaction tests proving api()/webUi()
 * now wrap and redact fetch-rejection and reflected-body messages AND cause
 * chains (closing the former credential leak, including the residual
 * cause-chain vector where a naive fix would preserve the raw original error
 * as `cause` — see `headphones-apikey-hardening`), hostile HTML-200 swallow
 * pins, a safe-encoding injection pin, the maxDepth/dbPath/musicDir
 * trusted-config-boundary pins, and a mechanical fixtures-secret-scan over
 * headphones/fixtures/*.
 *
 * headphones.ts's api()/webUi() request builders and get-artist/get-album
 * were FIXED by this change (redactSecrets wrapper + array unwrap); every
 * other test here still PINS current, unmodified behavior (including
 * behavior that is arguably risky, e.g. the maxDepth/dbPath/musicDir
 * trusted-config-boundary tests below, which remain real, deferred gaps).
 * Where a test documents a real remaining gap, it is labeled "pin" and says
 * so explicitly, tracking it via the local `headphones-apikey-hardening`
 * issue-lifecycle model. See fixtures/PROVENANCE.md for fixture provenance.
 *
 * Toolchain rule: no `as typeof <global-builtin>` casts — the fetch seam is
 * installed via `(globalThis as unknown as Record<string, unknown>).fetch`.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./headphones.ts";
import getVersionFixture from "../../fixtures/getVersion.json" with {
  type: "json",
};
import getIndexFixture from "../../fixtures/getIndex.json" with {
  type: "json",
};
import getArtistFixture from "../../fixtures/getArtist.json" with {
  type: "json",
};
import getArtistLoadingFixture from "../../fixtures/getArtist.loading.json" with {
  type: "json",
};
import findArtistFixture from "../../fixtures/findArtist.json" with {
  type: "json",
};
import getAlbumFixture from "../../fixtures/getAlbum.json" with {
  type: "json",
};
import getWantedFixture from "../../fixtures/getWanted.json" with {
  type: "json",
};
import getHistoryFixture from "../../fixtures/getHistory.json" with {
  type: "json",
};
import getLogsFixture from "../../fixtures/getLogs.json" with {
  type: "json",
};
import auditRowsFixture from "../../fixtures/audit.rows.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Deliberately NOT 32-hex (Headphones, like most *arr-family apps, uses a
// 32-hex-char apikey) — see the "provably non-32-hex" test near the bottom
// of this file, which asserts this constant cannot match the real-apikey
// shape regex.
const APIKEY_SENTINEL = "fixture-only-ZZZZ-not-a-real-headphones-key";

const GLOBAL_ARGS = {
  host: "http://headphones.example:8181",
  apiKey: APIKEY_SENTINEL,
};

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

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
  (globalThis as unknown as Record<string, unknown>).fetch = stub;
  try {
    await fn(calls);
  } finally {
    (globalThis as unknown as Record<string, unknown>).fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withOneJson(
  body: unknown,
  status: number,
  fn: () => Promise<unknown>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

/** Make fetch REJECT (not resolve-with-error-body) — models a network-layer
 * failure (DNS, TLS, connection reset), as opposed to a well-formed
 * ok:false API response. */
function withRejectingFetch(error: unknown, fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>).fetch = () =>
    Promise.reject(error);
  return fn().finally(() => {
    (globalThis as unknown as Record<string, unknown>).fetch = original;
  });
}

/**
 * Walk an error's `.cause` chain (bounded depth) and concatenate every
 * level's message text. A secret-absence assertion against JUST
 * `err.message` would miss a leak relocated to `.cause` — this proves the
 * ENTIRE chain (what a default Error/cause inspection, e.g. Deno's own
 * console formatting, would print) is clean, not only the top level.
 */
function fullErrorChainText(err: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current !== undefined && current !== null && depth < maxDepth) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
    depth++;
  }
  return parts.join(" | ");
}

// Deno's `with { type: "json" }` import attribute needs no runtime
// permission, but there is no equivalent for plain text without
// `--unstable-raw-imports` — the network-less/run-less/file-permission-less
// default test task deliberately does not enable that. Kept byte-identical
// to fixtures/error.html.
const ERROR_HTML = `<!DOCTYPE html>
<html>
  <head><title>500 Internal Server Error</title></head>
  <body>
    <h1>Internal Server Error</h1>
    <p>
      The server encountered an internal error and was unable to complete your
      request.
    </p>
  </body>
</html>
`;

// ---------------------------------------------------------------------------
// THE headline surface: apikey-in-URL-query
// ---------------------------------------------------------------------------

Deno.test("FIXED: a fetch-layer rejection through api() is wrapped and redacted end-to-end — message AND cause chain, closing the former apikey-in-URL leak", async () => {
  // Prior to this fix, api() called `await fetch(url.toString(), { signal:
  // ... })` with NO surrounding try/catch — ANY rejection (DNS failure, TLS
  // error, connection reset) propagated completely unchanged, all the way to
  // the caller. A REAL Deno fetch rejection for a network-layer failure
  // typically embeds the request URL in its error message (e.g. something
  // shaped like "error sending request for url
  // (http://host:8181/api?apikey=<KEY>&cmd=...)"); because api() builds its
  // URL via `url.searchParams.set("apikey", apiKey)`, that URL carries the
  // apiKey verbatim. This test simulates that exact shape directly
  // (embedding the sentinel apikey in the rejection's own message, as a real
  // Deno fetch failure would) and proves api() now wraps the rejection in a
  // NEW Error whose message has been redacted, with diagnostics preserved
  // via a REDACTED single-level `cause` — never the raw original error — so
  // the secret cannot resurface via a default cause-chain inspection either
  // (e.g. Deno's own console formatting, which recurses into `.cause`).
  // Tracked by the local `headphones-apikey-hardening` issue-lifecycle
  // model.
  const leakedUrl =
    `http://headphones.example:8181/api?apikey=${GLOBAL_ARGS.apiKey}&cmd=getVersion`;
  const SENTINEL = new Error(`error sending request for url (${leakedUrl})`);
  const { ctx } = makeCtx();
  await withRejectingFetch(SENTINEL, async () => {
    const thrown = await assertRejects(() => run("get-version", {}, ctx));
    assert(
      thrown !== SENTINEL,
      "api() must wrap the rejection in a new redacted Error, not propagate the original object unchanged",
    );
    assert(
      (thrown as Error).message.includes("apikey=REDACTED"),
      "the redacted message must show apikey=REDACTED",
    );
    const chainText = fullErrorChainText(thrown);
    assert(
      chainText.includes("apikey=REDACTED"),
      "apikey=REDACTED must appear somewhere in the full error chain",
    );
    assert(
      !chainText.includes(GLOBAL_ARGS.apiKey),
      "the real apiKey value must be absent from the ENTIRE error chain (message AND every cause level), not just the top-level message",
    );
    assert(
      (thrown as Error).cause !== SENTINEL,
      "cause must NOT be the raw original error object — that would relocate the leak from .message to .cause",
    );
    assert(
      (thrown as Error).cause instanceof Error,
      "cause must be a redacted Error, preserving diagnostic shape without the raw secret",
    );
    assertEquals(
      ((thrown as Error).cause as Error).message,
      "error sending request for url (http://headphones.example:8181/api?apikey=REDACTED&cmd=getVersion)",
      "the cause's own message must be redacted too, not just the top-level message",
    );
  });
});

Deno.test("FIXED: the SAME wrap-and-redact behavior holds through webUi() (set-extras), not just api()", async () => {
  // webUi() has its OWN independent `await fetch(...)` call. Although
  // webUi()'s URL does not itself carry the apiKey (getExtras is the
  // unauthenticated web-UI form — see reference_headphones_extension.md),
  // the wrap-and-redact mechanism must still cover it for defense-in-depth,
  // not just api(). redactSecrets() is a no-op on this message (no
  // apikey= substring), so the message text itself is unchanged — but the
  // wrapping (new Error, REDACTED single-level cause, never the raw
  // original) must still apply unconditionally, regardless of whether a
  // given message needs redaction.
  const SENTINEL = new Error(
    "NEUTRAL_WEBUI_FETCH_REJECTION_SENTINEL_NOT_AN_APIKEY",
  );
  const { ctx } = makeCtx();
  await withRejectingFetch(SENTINEL, async () => {
    const thrown = await assertRejects(
      () => run("set-extras", { id: "artist-1" }, ctx),
    );
    assert(
      thrown !== SENTINEL,
      "webUi() must also wrap the rejection in a new Error, not propagate the original object unchanged",
    );
    assertEquals(
      (thrown as Error).message,
      SENTINEL.message,
      "redactSecrets is a no-op here (no apikey= substring), so the message text itself is unchanged",
    );
    assert(
      (thrown as Error).cause !== SENTINEL,
      "cause must NOT be the raw original error object, even when redaction is a no-op — the wrapping mechanism applies unconditionally",
    );
    assert(
      (thrown as Error).cause instanceof Error,
      "cause must be a (here: no-op-redacted) Error, not the raw original",
    );
    assertEquals(
      ((thrown as Error).cause as Error).message,
      SENTINEL.message,
      "redactSecrets is a no-op on this message, so the cause's message text is unchanged even though it's a new object",
    );
  });
});

Deno.test("GREEN pin: a well-formed !response.ok error contains ONLY cmd, status, and a body slice — never the apiKey itself", async () => {
  const { ctx } = makeCtx();
  await withOneJson("quota exceeded", 429, async () => {
    const thrown = await assertRejects(() => run("get-version", {}, ctx));
    assertEquals(
      (thrown as Error).message,
      'API getVersion failed: 429 - "quota exceeded"',
    );
    assert(!(thrown as Error).message.includes(GLOBAL_ARGS.apiKey));
  });
});

Deno.test("FIXED: a hostile/misconfigured server that ECHOES the request URL (incl. apikey) in its error body no longer leaks it — the !response.ok message is redacted too", async () => {
  // Closes the residual noted in plan v2: `body.slice(0, 200)` is a
  // truncation, not a redaction on its own — a server that reflects the
  // request (a common failure-page pattern: "Bad request: <url>") used to
  // leak the apikey through this exact code path, the reflected-body vector
  // that a fetch-rejection-only fix would have missed. api()'s !response.ok
  // throw is now routed through redactSecrets() too.
  const { ctx } = makeCtx();
  const reflectedBody =
    `Bad request: url was http://headphones.example:8181/api?apikey=${GLOBAL_ARGS.apiKey}&cmd=getVersion`;
  await withOneJson(reflectedBody, 400, async () => {
    const thrown = await assertRejects(() => run("get-version", {}, ctx));
    assert(
      (thrown as Error).message.includes("apikey=REDACTED"),
      "the !response.ok message must show apikey=REDACTED",
    );
    assert(
      !(thrown as Error).message.includes(GLOBAL_ARGS.apiKey),
      "the real apikey value must be absent from the !response.ok message",
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile HTML-200 — swallowed-error pins
// ---------------------------------------------------------------------------

Deno.test("pin: a hostile HTML-200 response makes get-index silently swallow to an EMPTY list, no error surfaced", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      () =>
        new Response(ERROR_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    () => run("get-index", {}, ctx),
  );
  const res = written.find((w) => w.spec === "artists")!;
  assertEquals(
    res.payload.artists,
    [],
    "Array.isArray(data) is false for {raw: html} -> silently [] instead of surfacing a parse error",
  );
  assertEquals(res.payload.total, 0);
});

Deno.test("pin: a hostile HTML-200 response makes get-version write a {raw: <html>} resource instead of a clear parse error", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      () =>
        new Response(ERROR_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    () => run("get-version", {}, ctx),
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.raw, ERROR_HTML);
  assertEquals(res.payload.git_path, undefined);
});

// ---------------------------------------------------------------------------
// Injection — safe encoding GREEN pin
// ---------------------------------------------------------------------------

Deno.test("GREEN pin: a hostile `id` argument (querystring/injection characters) is safely URL-encoded by URLSearchParams, never concatenated raw", async () => {
  const hostileId = "abc&cmd=delArtist&apikey=stolen-value";
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        const url = new URL(req.url);
        assertEquals(
          url.searchParams.get("cmd"),
          "getArtist",
          "cmd must still resolve to getArtist — the hostile id cannot inject a second cmd param",
        );
        assertEquals(url.searchParams.get("id"), hostileId);
        assertEquals(url.searchParams.getAll("cmd").length, 1);
        return json(getArtistFixture);
      },
    ],
    () => run("get-artist", { id: hostileId }, ctx),
  );
});

// ---------------------------------------------------------------------------
// Trusted-config-boundary pins: audit-library's maxDepth / dbPath / musicDir
// ---------------------------------------------------------------------------

type CommandResult = { success: boolean; stdout: string; stderr: string };
type CommandRouter = (commandLine: string) => CommandResult;

function installCommandStub(router: CommandRouter) {
  const encoder = new TextEncoder();
  const calls: string[] = [];

  class FakeCommand {
    #commandLine: string;
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      const args = options.args ?? [];
      this.#commandLine = args[args.length - 1] ?? "";
      calls.push(this.#commandLine);
    }
    output() {
      const r = router(this.#commandLine);
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        stdout: encoder.encode(r.stdout),
        stderr: encoder.encode(r.stderr),
      });
    }
    spawn() {
      const commandLine = this.#commandLine;
      return {
        stdin: {
          getWriter: () => ({
            write: (_bytes: Uint8Array) => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          const r = router(commandLine);
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
  (Deno as unknown as Record<string, unknown>).Command = FakeCommand;
  return {
    calls,
    restore: () => {
      (Deno as unknown as Record<string, unknown>).Command = original;
    },
  };
}

function passthroughRouter(): CommandRouter {
  return (commandLine) => {
    if (commandLine.startsWith("find ")) {
      return { success: true, stdout: "", stderr: "" };
    }
    if (commandLine.startsWith("sqlite3")) {
      return {
        success: true,
        stdout: JSON.stringify(auditRowsFixture),
        stderr: "",
      };
    }
    return { success: false, stdout: "", stderr: `unrouted: ${commandLine}` };
  };
}

Deno.test("pin: maxDepth has no .int()/.min() constraint — a non-integer, negative value is accepted and interpolated straight into `find -maxdepth`", async () => {
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    sshHost: "media.headphones.example",
  });
  const stub = installCommandStub(passthroughRouter());
  try {
    await run("audit-library", { maxDepth: -3.5 }, ctx);
  } finally {
    stub.restore();
  }
  const findCall = stub.calls.find((c) => c.startsWith("find "))!;
  assert(
    findCall.includes("-maxdepth -3.5"),
    `documented gap: an invalid maxDepth reaches the shell command unvalidated ("${findCall}")`,
  );
});

Deno.test("pin: musicDir is interpolated into sshCommand's `find` invocation with single-quote wrapping and NO escaping — a value containing a quote breaks out (trusted-config boundary)", async () => {
  // musicDir/dbPath/sshHost/sshUser all come from globalArguments — operator
  // config, not per-call method arguments — but headphones.ts applies no
  // escaping regardless of source. Documented gap, explicitly out of scope
  // for the `headphones-apikey-hardening` redaction + array-unwrap fix
  // (audit-library's sshCommand/sshExecSql are untouched by that change).
  const hostileMusicDir = "/music' ; touch /tmp/pwned ; echo '";
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    sshHost: "media.headphones.example",
    musicDir: hostileMusicDir,
  });
  const stub = installCommandStub(passthroughRouter());
  try {
    await run("audit-library", {}, ctx);
  } finally {
    stub.restore();
  }
  const findCall = stub.calls.find((c) => c.startsWith("find "))!;
  assert(
    findCall.includes("touch /tmp/pwned"),
    `documented gap: musicDir breaks out of the single-quoted find command with no escaping ("${findCall}")`,
  );
});

Deno.test("pin: dbPath is interpolated into sshExecSql's `sqlite3 -json` invocation with single-quote wrapping and NO escaping (same trusted-config boundary)", async () => {
  const hostileDbPath = "/config/headphones.db' ; rm -rf / ; echo '";
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    sshHost: "media.headphones.example",
    dbPath: hostileDbPath,
  });
  const stub = installCommandStub(passthroughRouter());
  try {
    await run("audit-library", {}, ctx);
  } finally {
    stub.restore();
  }
  const sqlCall = stub.calls.find((c) => c.startsWith("sqlite3"))!;
  assert(
    sqlCall.includes("rm -rf /"),
    `documented gap: dbPath breaks out of the single-quoted sqlite3 command with no escaping ("${sqlCall}")`,
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

// The real live Headphones host in this homelab (see
// reference_headphones_extension.md) — denylisted explicitly, mirroring
// telegram-send's real-chat-id denylist.
const REAL_HEADPHONES_HOST = "headphones.aopab.art";

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "a 32-hex-char apikey shape (Headphones/*arr-family convention)",
    re: /\b[0-9a-f]{32}\b/i,
  },
  { name: "vault key name HEADPHONES_API_KEY", re: /\bHEADPHONES_API_KEY\b/ },
  {
    name: "the real homelab Headphones host",
    re: new RegExp(
      REAL_HEADPHONES_HOST.replace(/\./g, "\\."),
      "i",
    ),
  },
];

/** Recursively collect every string/number leaf value in a parsed JSON
 * structure. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (typeof value === "number") {
    out.push(String(value));
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
  "getVersion.json": getVersionFixture,
  "getIndex.json": getIndexFixture,
  "getArtist.json": getArtistFixture,
  "getArtist.loading.json": getArtistLoadingFixture,
  "findArtist.json": findArtistFixture,
  "getAlbum.json": getAlbumFixture,
  "getWanted.json": getWantedFixture,
  "getHistory.json": getHistoryFixture,
  "getLogs.json": getLogsFixture,
  "audit.rows.json": auditRowsFixture,
  "error.html": ERROR_HTML,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped apikey, the vault key name, or the real homelab host", () => {
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

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected 32-hex apikey shape", () => {
  const violations: string[] = [];
  const poisoned = { apikey: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a 32-hex apikey shape",
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects the real homelab host if it were present", () => {
  const violations: string[] = [];
  const poisoned = { host: `http://${REAL_HEADPHONES_HOST}:8181` };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag the real homelab host",
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects the vault key name if it were present", () => {
  const violations: string[] = [];
  const poisoned = {
    note: "see vault key HEADPHONES_API_KEY for the real key",
  };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag the vault key name",
  );
});

Deno.test("the APIKEY_SENTINEL used throughout this suite's test source is provably non-32-hex", () => {
  // Round-1-style guard (mirroring telegram-send's TOKEN sentinel pin): any
  // apikey sentinel embedded in test SOURCE (not fixtures) must not itself
  // be able to match the real-apikey-shape regex, so it can never mask a
  // real leak or false-positive a repo-wide secret-scanning gate.
  const hex32 = /\b[0-9a-f]{32}\b/i;
  assert(
    !hex32.test(APIKEY_SENTINEL),
    "APIKEY_SENTINEL must not be 32-hex-shaped",
  );
});
