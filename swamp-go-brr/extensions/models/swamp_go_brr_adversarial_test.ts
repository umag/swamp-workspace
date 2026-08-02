// Adversarial suite for @magistr/swamp-go-brr: attacker's-perspective
// characterization of the real injection/leak surface at the EXECUTE level,
// plus pins for the eight latent bugs (B1..B8) tracked in the LOCAL
// `swamp-go-brr-latent-bugs` issue-lifecycle bug model (NEVER the Lab, per
// this repo's tracking convention). All eight are now REAL-FIXED (release
// 2026.08.02.1) — every "fixed: B<n>" test below asserts the FIXED behavior;
// none of them characterize a remaining gap.
//
// Bugs fixed here:
//   B1 (MED) — docker-verify's `verify()` (sshExecRaw) now enforces a
//      client-side timeout (new `verifyTimeoutMs` global arg) wrapping the
//      WHOLE ssh invocation (handshake + remote command); on expiry the child
//      is killed via AbortController and exitCode=124 is recorded
//      (fail-closed). ssh's own ConnectTimeout=10 still bounds only the
//      handshake, as before.
//   B2 (MED) — preflight's `scaffoldRepo` now pre-validates every
//      `ScaffoldFile.path` with `pathEscapes` BEFORE any write; a `../` path
//      is rejected (`unsafe scaffold path: …`) instead of escaping repoPath.
//   B3 (MED) — lib/ssh.ts now defaults to `StrictHostKeyChecking=accept-new`
//      (TOFU) with ssh's own known_hosts file — never a blanket
//      `UserKnownHostsFile=/dev/null`. The historical insecure pairing is
//      reachable only via the documented `sshStrictHostKeyChecking="no"`
//      opt-out.
//   B4 (LOW) — lib/scrub.ts's generic `key=value` pattern's value floor was
//      raised `{8,}` → `{11,}`, so a short (<11 char) benign `token=`-shaped
//      value like `abc12345` no longer false-positives; `scrubSecrets` now
//      imposes its own tail-preserving `MAX_SCRUB_BYTES` cap independent of
//      any caller-side bound.
//   B5 (LOW) — scrubSecrets now redacts a BARE high-entropy run (≥32 chars,
//      mixing lower/upper/digit) even with no recognizable key word ahead
//      of it.
//   B6 (LOW) — source-integration's local `jjRun` now carries `--no-pager`
//      on every invocation and enforces a client-side timeout (new
//      `jjTimeoutMs` global arg), mirroring lib/ssh.ts's AbortController
//      pattern.
//   B7 (LOW) — `parseGitDiffPaths` now splits a `diff --git a/<A> b/<B>`
//      header at the ` b/` boundary where the two halves are EQUAL, so a
//      path containing a literal " b/" substring (e.g. `weird b/file.ts`) no
//      longer mis-splits. Still unreachable via the real `apply()` flow
//      either way (`pathEscapes` rejects any whitespace-containing path
//      upstream), which the CONTRAST test below continues to pin unchanged.
//   B8 (LOW) — `apply()`'s per-file write now goes through
//      `lib/acl.ts`'s `safeWriteWithinRepo`: it refuses an existing symlink
//      at the final path component (no-follow) and, after the write lands,
//      re-confines the real path under repoRoot — detecting and best-effort
//      cleaning up a TOCTOU ancestor-symlink-swap race instead of silently
//      leaving an escaped write in place.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model as siModel } from "./source_integration.ts";
import { model as dvModel } from "./docker_verify.ts";
import { model as preflightModel } from "./preflight.ts";
import { model as otlpExportModel } from "./otlp_export.ts";
import {
  confineWrittenPath,
  pathEscapes,
  resolveWithinRepo,
} from "./lib/acl.ts";
import { MAX_SCRUB_BYTES, scrubSecrets } from "./lib/scrub.ts";
import { parseGitDiffPaths } from "./source_integration.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention — see the sibling
// _methods_test.ts / _coverage_test.ts / _property_test.ts files)
// ---------------------------------------------------------------------------

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function callMethod(
  m: { methods: unknown },
  name: string,
  args: Record<string, unknown>,
  ctx: unknown,
): Promise<unknown> {
  const method = (m.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function stubDirectOutput(
  responder: (cmd: string, args: string[]) => CommandResult,
): () => void {
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).Deno.Command;
  class FakeCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    output() {
      const r = responder(this.#cmd, this.#args);
      return Promise.resolve({
        code: r.code,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.Command = orig;
  };
}

function stubSpawnCommand(
  responder: (cmd: string, args: string[]) => CommandResult,
): () => void {
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).Deno.Command;
  class FakeChild {
    stdin = {
      getWriter: () => ({
        write: (_chunk: Uint8Array) => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    };
    constructor(private cmd: string, private args: string[]) {}
    output() {
      const r = responder(this.cmd, this.args);
      return Promise.resolve({
        code: r.code,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      });
    }
  }
  class FakeCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    spawn() {
      return new FakeChild(this.#cmd, this.#args);
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.Command = orig;
  };
}

/** Like stubDirectOutput, but also records whether `Deno.Command` received an
 * AbortSignal (`opts.signal`) — used by the B1/B6 client-side-timeout pins to
 * assert the timeout is actually WIRED, not just that a fast call still works. */
function stubDirectOutputCaptureSignal(
  responder: (cmd: string, args: string[]) => CommandResult,
): { restore: () => void; sawSignal: () => boolean } {
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).Deno.Command;
  let sawSignal = false;
  class FakeCommand {
    #cmd: string;
    #args: string[];
    constructor(
      cmd: string,
      opts?: { args?: string[]; signal?: AbortSignal },
    ) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
      if (opts?.signal) sawSignal = true;
    }
    output() {
      const r = responder(this.#cmd, this.#args);
      return Promise.resolve({
        code: r.code,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return {
    restore: () => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).Deno.Command = orig;
    },
    sawSignal: () => sawSignal,
  };
}

/** Simulates a HUNG child process: `output()` only resolves once the passed
 * AbortSignal fires 'abort' (as a real killed-by-signal Deno.Command child
 * eventually would), never on its own. Used by the B1/B6 timeout-FIRES pins —
 * proves the production code's own AbortController+setTimeout actually aborts
 * a genuinely-hanging call, rather than merely wiring an unused signal. */
function stubHangUntilAbort(): {
  restore: () => void;
  sawSignal: () => boolean;
} {
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).Deno.Command;
  let sawSignal = false;
  class FakeCommand {
    #signal?: AbortSignal;
    constructor(
      _cmd: string,
      opts?: { args?: string[]; signal?: AbortSignal },
    ) {
      this.#signal = opts?.signal;
      if (this.#signal) sawSignal = true;
    }
    output(): Promise<
      { code: number; stdout: Uint8Array; stderr: Uint8Array }
    > {
      return new Promise((resolve) => {
        const finish = () =>
          resolve({
            code: 137, // simulates a SIGTERM/SIGKILL-killed exit
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          });
        if (this.#signal?.aborted) {
          finish();
          return;
        }
        this.#signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return {
    restore: () => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).Deno.Command = orig;
    },
    sawSignal: () => sawSignal,
  };
}

type Written = { spec: string; name: string; data: Record<string, unknown> };

function collector(): {
  written: Written[];
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
} {
  const written: Written[] = [];
  return {
    written,
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      return Promise.resolve(data);
    },
  };
}

async function withTempRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoRoot}/.jj`, { recursive: true });
    await fn(repoRoot);
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
  }
}

// ===========================================================================
// Hostile input at the apply() execute level.
// ===========================================================================

Deno.test("apply: a hostile base revision starting with '-' (flag/-r injection) is rejected BEFORE any jj call", async () => {
  await withTempRepo(async (repoRoot) => {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { jjPath: "jj" },
      writeResource,
    };
    let sawCommand = false;
    const restore = stubDirectOutput(() => {
      sawCommand = true;
      return { code: 0, stdout: "", stderr: "" };
    });
    try {
      await assertRejects(
        () =>
          callMethod(siModel, "apply", {
            repoScope: repoRoot,
            base: "-r",
            tasks: [{
              taskId: "t1",
              rawStdout: "irrelevant",
              nonce: "n",
              writeAllowlist: ["a.ts"],
            }],
          }, ctx) as Promise<unknown>,
        Error,
        "unsafe base revision",
      );
    } finally {
      restore();
    }
    assert(!sawCommand, "no jj call must ever be attempted for an unsafe base");
    assertEquals(written.length, 0);
  });
});

Deno.test("apply: nonce_mismatch — a wrong-nonce fence in a hostile leaf reply is rejected as a forgery signal", async () => {
  await withTempRepo(async (repoRoot) => {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { jjPath: "jj" },
      writeResource,
    };
    const restore = stubDirectOutput(() => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    try {
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [{
          taskId: "t1",
          rawStdout:
            "<<<GOBRR:WRONGNONCE\n@@NEWFILE x\ny\n@@ENDFILE\nGOBRR:WRONGNONCE>>>",
          nonce: "realNonce",
          writeAllowlist: ["x"],
        }],
      }, ctx);
    } finally {
      restore();
    }
    const applied = written.find((w) => w.spec === "applied")!;
    const t1 = (applied.data.results as Record<string, unknown>).t1 as Record<
      string,
      unknown
    >;
    assertEquals(t1.failureKind, "nonce_mismatch");
  });
});

Deno.test("apply: unsafe_change — a @@NEWFILE targeting a denied control path (.git/hooks) is rejected even when allowlisted", async () => {
  await withTempRepo(async (repoRoot) => {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { jjPath: "jj" },
      writeResource,
    };
    const nonce = "n1";
    const restore = stubDirectOutput(() => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    try {
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [{
          taskId: "t1",
          rawStdout:
            `<<<GOBRR:${nonce}\n@@NEWFILE .git/hooks/pre-commit\n#!/bin/sh\n@@ENDFILE\nGOBRR:${nonce}>>>`,
          nonce,
          writeAllowlist: [".git/hooks/pre-commit"],
        }],
      }, ctx);
    } finally {
      restore();
    }
    const applied = written.find((w) => w.spec === "applied")!;
    const t1 = (applied.data.results as Record<string, unknown>).t1 as Record<
      string,
      unknown
    >;
    assertEquals(t1.failureKind, "unsafe_change");
  });
});

Deno.test("apply: out_of_allowlist — a @@NEWFILE targeting a path outside the task's writeAllowlist is rejected", async () => {
  await withTempRepo(async (repoRoot) => {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { jjPath: "jj" },
      writeResource,
    };
    const nonce = "n2";
    const restore = stubDirectOutput(() => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    try {
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [{
          taskId: "t1",
          rawStdout:
            `<<<GOBRR:${nonce}\n@@NEWFILE other/escape.ts\nz\n@@ENDFILE\nGOBRR:${nonce}>>>`,
          nonce,
          writeAllowlist: ["src/only.ts"],
        }],
      }, ctx);
    } finally {
      restore();
    }
    const applied = written.find((w) => w.spec === "applied")!;
    const t1 = (applied.data.results as Record<string, unknown>).t1 as Record<
      string,
      unknown
    >;
    assertEquals(t1.failureKind, "out_of_allowlist");
  });
});

Deno.test("apply: non-regular-file tripwire — a HOST-OBSERVED symlink in the post-apply jj diff fails closed as unsafe_change", async () => {
  await withTempRepo(async (repoRoot) => {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { jjPath: "jj" },
      writeResource,
    };
    const nonce = "n3";
    const restore = stubDirectOutput((_cmd, args) => {
      if (args.includes("new")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("diff")) {
        return {
          code: 0,
          stdout: [
            "diff --git a/link b/link",
            "new file mode 120000",
            "+/etc/passwd",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args.includes("log")) return { code: 0, stdout: "cid\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    try {
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [{
          taskId: "t1",
          rawStdout:
            `<<<GOBRR:${nonce}\n@@NEWFILE link\ncontent\n@@ENDFILE\nGOBRR:${nonce}>>>`,
          nonce,
          writeAllowlist: ["link"],
        }],
      }, ctx);
    } finally {
      restore();
    }
    const applied = written.find((w) => w.spec === "applied")!;
    const t1 = (applied.data.results as Record<string, unknown>).t1 as Record<
      string,
      unknown
    >;
    assertEquals(
      t1.failureKind,
      "unsafe_change",
      "a HOST-OBSERVED symlink must fail closed regardless of what the envelope declared",
    );
  });
});

// ===========================================================================
// Credential leak surfaces — docker-verify (ssh) + otlp-export (fetch).
// ===========================================================================

Deno.test("docker_verify.verify: a credential echoed in verify stdout on failure is scrubbed in the persisted result, even though the gate reads the RAW stdout", async () => {
  const restore = stubDirectOutput(() => ({
    code: 0,
    stdout: "FAIL: leaked aws=AKIAIOSFODNN7EXAMPLE\n__GOBRR_EXIT__:1\n",
    stderr: "",
  }));
  try {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { sshHost: "dv.example.com", sshUser: "root" },
      writeResource,
    };
    await callMethod(dvModel, "verify", {
      image: "reg/toolchain@sha256:" + "a".repeat(64),
      treePath: "/srv/runs/run1/tree",
      verifyCommand: "deno test",
    }, ctx);
    const res = written.find((w) => w.spec === "result")!;
    // gate correctness is unaffected by scrubbing (parses from the RAW stdout)
    assertEquals(res.data.exitCode, 1);
    assert(
      !(res.data.stdout as string).includes("AKIAIOSFODNN7EXAMPLE"),
      "the AWS credential must never reach the persisted result",
    );
  } finally {
    restore();
  }
});

const LEAK_TOKEN = "sk-ant-oat01-adversarial-do-not-leak";

Deno.test("otlp-export: a token embedded in the endpoint's userinfo never survives into the persisted exportStatus, even on a transport THROW", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network unreachable"));
  try {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: {
        endpoint: `https://user:${LEAK_TOKEN}@collector.example.com/v1/traces`,
        token: LEAK_TOKEN,
      },
      readResource: (_n: string) => Promise.resolve({ resourceSpans: [] }),
      writeResource,
      definition: { name: "x" },
    };
    // must resolve, NEVER reject/throw (a transport failure is best-effort).
    await callMethod(otlpExportModel, "export_run", {}, ctx);
    const status = written.find((w) => w.spec === "exportStatus")!;
    assertEquals(status.data.status, "error");
    assertEquals(status.data.reason, "transport error");
    assert(
      !(status.data.endpoint as string).includes(LEAK_TOKEN),
      "the userinfo-embedded token must be stripped from the persisted (redacted) endpoint",
    );
    assert(!JSON.stringify(status.data).includes(LEAK_TOKEN));
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("otlp-export: an http:// (non-https) endpoint is rejected at the execute level, never attempts fetch", async () => {
  let fetchCalled = false;
  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalled = true;
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  try {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: {
        endpoint: "http://collector.example.com/v1/traces",
        token: "t",
      },
      readResource: (_n: string) => Promise.resolve({}),
      writeResource,
      definition: { name: "x" },
    };
    await callMethod(otlpExportModel, "export_run", {}, ctx);
    const status = written.find((w) => w.spec === "exportStatus")!;
    assertEquals(status.data.status, "error");
    assert((status.data.reason as string).includes("https"));
    assert(!fetchCalled, "an invalid endpoint must never reach fetch");
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("otlp-export: a scheme-less endpoint is rejected at the execute level", async () => {
  const { written, writeResource } = collector();
  const ctx = {
    logger: { info: () => {} },
    globalArgs: { endpoint: "collector.example.com/v1/traces", token: "t" },
    readResource: (_n: string) => Promise.resolve({}),
    writeResource,
    definition: { name: "x" },
  };
  await callMethod(otlpExportModel, "export_run", {}, ctx);
  const status = written.find((w) => w.spec === "exportStatus")!;
  assertEquals(status.data.status, "error");
});

Deno.test("otlp-export: a fetch THROW (not just a bad status) never rethrows/aborts — records status=error", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { endpoint: "https://c.example.com/v1/traces", token: "t" },
      readResource: (_n: string) => Promise.resolve({ resourceSpans: [] }),
      writeResource,
      definition: { name: "x" },
    };
    await callMethod(otlpExportModel, "export_run", {}, ctx); // must not throw
    const status = written.find((w) => w.spec === "exportStatus")!;
    assertEquals(status.data.status, "error");
    assertEquals(status.data.reason, "transport error");
  } finally {
    globalThis.fetch = orig;
  }
});

// ===========================================================================
// B1 (MED) — docker-verify: client-side timeout on the remote command.
// ===========================================================================

Deno.test("fixed: B1 (swamp-go-brr-latent-bugs) — docker-verify's ssh transport wires a client-side AbortSignal, and a normal (fast) call is unaffected", async () => {
  const stub = stubDirectOutputCaptureSignal((_cmd, _args) => ({
    code: 0,
    stdout: "__GOBRR_EXIT__:0\n",
    stderr: "",
  }));
  try {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { sshHost: "dv.example.com", sshUser: "root" },
      writeResource,
    };
    await callMethod(dvModel, "verify", {
      image: "reg/toolchain@sha256:" + "a".repeat(64),
      treePath: "/srv/runs/run1/tree",
      verifyCommand: "deno test",
    }, ctx);
    assert(
      stub.sawSignal(),
      "Deno.Command must receive an AbortSignal wired to the client-side timeout",
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.data.exitCode, 0, "a normal completion is unaffected");
  } finally {
    stub.restore();
  }
});

Deno.test("fixed: B1 (swamp-go-brr-latent-bugs) — a hung remote verify command is fail-closed to a synthetic exit 124 once verifyTimeoutMs elapses", async () => {
  const stub = stubHangUntilAbort();
  try {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: {
        sshHost: "dv.example.com",
        sshUser: "root",
        verifyTimeoutMs: 20,
      },
      writeResource,
    };
    await callMethod(dvModel, "verify", {
      image: "reg/toolchain@sha256:" + "a".repeat(64),
      treePath: "/srv/runs/run1/tree",
      verifyCommand: "deno test",
    }, ctx);
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(
      res.data.exitCode,
      124,
      "a hung remote command must be fail-closed to a synthetic timeout exit " +
        "code, never left to hang past the client-side budget — ssh's own " +
        "ConnectTimeout bounds only the handshake, not the remote runtime.",
    );
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// B2 (MED, within-temp) — preflight scaffold: ScaffoldFile.path traversal.
// ===========================================================================

Deno.test("fixed: B2 (swamp-go-brr-latent-bugs) — preflight.scaffold rejects a ../-traversal ScaffoldFile.path BEFORE any write, leaving repoPath's parent untouched", async () => {
  const sandbox = await Deno.makeTempDir();
  const repoPath = `${sandbox}/inner`;
  await Deno.mkdir(repoPath, { recursive: true });
  const restore = stubSpawnCommand((_cmd, args) => {
    if (args.includes("log")) return { code: 0, stdout: "base1\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  try {
    const { writeResource } = collector();
    const ctx = {
      globalArgs: preflightModel.globalArguments.parse({}),
      writeResource,
    };
    await assertRejects(
      () =>
        callMethod(preflightModel, "scaffold", {
          repoPath,
          files: [{ path: "../escaped.txt", content: "ESCAPED" }],
        }, ctx) as Promise<unknown>,
      Error,
      "unsafe scaffold path",
    );
    await assertRejects(
      () => Deno.readTextFile(`${sandbox}/escaped.txt`),
      Deno.errors.NotFound,
      undefined,
      "a rejected scaffold must leave NO partial write outside repoPath",
    );
  } finally {
    restore();
    await Deno.remove(sandbox, { recursive: true });
  }
});

// ===========================================================================
// B3 (MED) — ssh.ts: secure-by-default host-key verification.
// ===========================================================================

Deno.test("fixed: B3 (swamp-go-brr-latent-bugs) — ssh host-key verification defaults to accept-new (TOFU), never a blanket /dev/null", async () => {
  let capturedArgs: string[] = [];
  const restore = stubDirectOutput((_cmd, args) => {
    capturedArgs = args;
    return { code: 0, stdout: "__GOBRR_EXIT__:0\n", stderr: "" };
  });
  try {
    const { writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { sshHost: "dv.example.com", sshUser: "root" },
      writeResource,
    };
    await callMethod(dvModel, "verify", {
      image: "reg/toolchain@sha256:" + "a".repeat(64),
      treePath: "/srv/runs/run1/tree",
      verifyCommand: "deno test",
    }, ctx);
  } finally {
    restore();
  }
  assert(capturedArgs.includes("StrictHostKeyChecking=accept-new"));
  assert(
    !capturedArgs.includes("UserKnownHostsFile=/dev/null"),
    "host-key verification is enabled by default (TOFU) — the blanket " +
      "/dev/null pairing is no longer the default, closing the MITM gap.",
  );
});

Deno.test('fixed: B3 opt-out — sshStrictHostKeyChecking="no" restores the documented insecure /dev/null behavior when explicitly requested', async () => {
  let capturedArgs: string[] = [];
  const restore = stubDirectOutput((_cmd, args) => {
    capturedArgs = args;
    return { code: 0, stdout: "__GOBRR_EXIT__:0\n", stderr: "" };
  });
  try {
    const { writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: {
        sshHost: "dv.example.com",
        sshUser: "root",
        sshStrictHostKeyChecking: "no",
      },
      writeResource,
    };
    await callMethod(dvModel, "verify", {
      image: "reg/toolchain@sha256:" + "a".repeat(64),
      treePath: "/srv/runs/run1/tree",
      verifyCommand: "deno test",
    }, ctx);
  } finally {
    restore();
  }
  assert(capturedArgs.includes("StrictHostKeyChecking=no"));
  assert(
    capturedArgs.includes("UserKnownHostsFile=/dev/null"),
    "the insecure opt-out must remain reachable for environments that " +
      "cannot maintain a known_hosts file — but only when explicitly requested",
  );
});

// ===========================================================================
// B4 (LOW) — scrub.ts: raised value floor + a size cap of its own.
// ===========================================================================

Deno.test("fixed: B4 (swamp-go-brr-latent-bugs) — scrubSecrets no longer false-positives on a short (<11 char) benign 'token=' value", () => {
  const benign = "the session token=abc12345 had expired, please retry";
  const out = scrubSecrets(benign);
  assert(
    out.includes("abc12345"),
    "an 8-char benign value now survives — the generic key=value floor was " +
      "raised from >=8 to >=11 to cut this false-positive class (secrets " +
      ">=11 chars, incl. all-lowercase-hex, are still caught, per lib/scrub.test.ts)",
  );
});

Deno.test("fixed: B4 (swamp-go-brr-latent-bugs) — scrubSecrets now enforces its own tail-preserving MAX_SCRUB_BYTES cap on an oversize adversarial payload", () => {
  const huge = "x".repeat(MAX_SCRUB_BYTES + 50_000) +
    " tail-marker token=Abc123xyz99";
  const out = scrubSecrets(huge);
  assert(
    out.length <= MAX_SCRUB_BYTES,
    "scrubSecrets must cap its OWN output length, independent of any " +
      "caller-side bound — a caller that forgets to bound its input (e.g. " +
      "build_workorder's raw file read) is no longer exposed to an unbounded scan",
  );
  assert(
    out.includes("tail-marker"),
    "the cap is TAIL-preserving, so trailing (most-recent) content survives",
  );
  assert(
    !out.includes("Abc123xyz99"),
    "the trailing secret, within the preserved tail, is still redacted",
  );
});

// ===========================================================================
// B5 (LOW) — scrub.ts: bare high-entropy secret with no key word.
// ===========================================================================

Deno.test("fixed: B5 (swamp-go-brr-latent-bugs) — a bare high-entropy secret with NO recognizable key word is now redacted", () => {
  const bareSecret = "aGVsbG8gd29ybGQgc2VjcmV0S2V5MTIzNDU2Nzg5MA";
  const out = scrubSecrets(`payload=${bareSecret} end`);
  assert(
    !out.includes(bareSecret),
    "a bare, ≥32-char run mixing lower/upper/digit is now redacted even " +
      "with no preceding key word (previously an accepted, documented gap)",
  );
});

// ===========================================================================
// B6 (LOW) — source-integration's jjRun: --no-pager + a client-side timeout.
// ===========================================================================

Deno.test("fixed: B6 (swamp-go-brr-latent-bugs) — every jj invocation now carries --no-pager and wires a client-side AbortSignal", async () => {
  await withTempRepo(async (repoRoot) => {
    const capturedArgSets: string[][] = [];
    const stub = stubDirectOutputCaptureSignal((_cmd, args) => {
      capturedArgSets.push(args);
      if (args.includes("new")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("diff")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("log")) return { code: 0, stdout: "cid\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    try {
      const { writeResource } = collector();
      const ctx = {
        logger: { info: () => {} },
        globalArgs: { jjPath: "jj" },
        writeResource,
      };
      const nonce = "n6";
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [{
          taskId: "t1",
          rawStdout:
            `<<<GOBRR:${nonce}\n@@NEWFILE a.ts\nx\n@@ENDFILE\nGOBRR:${nonce}>>>`,
          nonce,
          writeAllowlist: ["a.ts"],
        }],
      }, ctx);
    } finally {
      stub.restore();
    }
    assert(
      capturedArgSets.length >= 2,
      "jj new/diff/log must all be attempted",
    );
    for (const args of capturedArgSets) {
      assert(
        args.includes("--no-pager"),
        "every jj invocation must carry --no-pager, not rely solely on jj's " +
          "own non-tty auto-detection",
      );
    }
    assert(
      stub.sawSignal(),
      "jjRun must wire an AbortSignal for its client-side timeout",
    );
  });
});

Deno.test("fixed: B6 (swamp-go-brr-latent-bugs) — a hung jj invocation is fail-closed to a transport failure once jjTimeoutMs elapses", async () => {
  await withTempRepo(async (repoRoot) => {
    const stub = stubHangUntilAbort();
    try {
      const { written, writeResource } = collector();
      const ctx = {
        logger: { info: () => {} },
        globalArgs: { jjPath: "jj", jjTimeoutMs: 20 },
        writeResource,
      };
      const nonce = "n6b";
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [{
          taskId: "t1",
          rawStdout:
            `<<<GOBRR:${nonce}\n@@NEWFILE a.ts\nx\n@@ENDFILE\nGOBRR:${nonce}>>>`,
          nonce,
          writeAllowlist: ["a.ts"],
        }],
      }, ctx);
      const applied = written.find((w) => w.spec === "applied")!;
      const t1 = (applied.data.results as Record<string, unknown>).t1 as Record<
        string,
        unknown
      >;
      assertEquals(
        t1.failureKind,
        "transport",
        "a hung `jj new` must be fail-closed to a transport failure (never " +
          "left to hang indefinitely) once the client-side budget elapses",
      );
    } finally {
      stub.restore();
    }
  });
});

// ===========================================================================
// B7 (LOW) — parseGitDiffPaths: symmetric ' b/' split.
// ===========================================================================

Deno.test("fixed: B7 (swamp-go-brr-latent-bugs) — parseGitDiffPaths no longer mis-splits a path containing a literal ' b/' substring", () => {
  // The OLD non-greedy `a\/(.+?) b\/` stopped at the FIRST " b/" it found; the
  // new symmetric split scans every " b/" occurrence for the one where the
  // two halves are EQUAL (true for every non-rename diff).
  const diff = [
    "diff --git a/weird b/file.ts b/weird b/file.ts",
    "new file mode 100644",
  ].join("\n");
  const out = parseGitDiffPaths(diff);
  assert(out.length === 1, "still emits exactly one entry");
  assertEquals(
    out[0].path,
    "weird b/file.ts",
    "the true intended path is now recovered exactly, regardless of the " +
      "literal ' b/' substring inside the filename itself",
  );
});

Deno.test("safe: CONTRAST — B7 remains UNREACHABLE via the real apply() flow either way, because pathEscapes already rejects any whitespace-containing path upstream", () => {
  assert(
    pathEscapes("weird b/file.ts"),
    "a path containing a space is rejected by the ACL guard (planApply's " +
      "guard() calls pathEscapes) long before jj ever sees it, so " +
      "parseGitDiffPaths's behavior above — buggy or fixed — can never " +
      "actually be triggered through apply()'s real input surface.",
  );
});

// ===========================================================================
// B8 (LOW) — apply(): safeWriteWithinRepo closes the TOCTOU blast radius.
// ===========================================================================

Deno.test("fixed: B8 (swamp-go-brr-latent-bugs) — confineWrittenPath detects and cleans up a TOCTOU symlink-swap write that escaped the repo", async () => {
  // realpath'd up front — resolveWithinRepo requires an already-canonical
  // repoRoot (macOS's tmp dirs resolve through /var -> /private/var), exactly
  // as apply()'s execute() does internally via Deno.realPathSync(repoScope).
  const repoRoot = Deno.realPathSync(await Deno.makeTempDir());
  const outside = Deno.realPathSync(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${repoRoot}/sub`);
    // Step 1 (the CHECK) — exactly what safeWriteWithinRepo does first.
    const r = resolveWithinRepo(repoRoot, "sub/file.txt");
    assert(r.ok, "the check passes while sub/ is a real, contained directory");

    // TOCTOU WINDOW — an attacker with local filesystem access swaps `sub`
    // for a symlink pointing OUTSIDE the repo between the check and the
    // write, reproduced exactly as before.
    await Deno.remove(`${repoRoot}/sub`, { recursive: true });
    await Deno.symlink(outside, `${repoRoot}/sub`);

    // Step 2 (the WRITE) — same stale `abs`; this half of the race is not
    // closeable in userspace without directory-fd primitives, so it still
    // lands outside, exactly as the old code's write would have.
    await Deno.writeTextFile(r.abs, "escaped content");

    // Step 3 (the FIX) — the post-write confinement re-check now DETECTS the
    // escape, best-effort unlinks it, and throws, instead of silently
    // letting the escaped write stand forever.
    assertThrows(
      () => confineWrittenPath(repoRoot, r.abs),
      Error,
      "escaped repo",
    );
    await assertRejects(
      () => Deno.readTextFile(`${outside}/file.txt`),
      Deno.errors.NotFound,
      undefined,
      "confineWrittenPath must unlink the escaped file, not just report it",
    );
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});
