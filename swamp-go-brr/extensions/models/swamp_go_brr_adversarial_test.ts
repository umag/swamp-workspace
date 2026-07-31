// Adversarial suite for @magistr/swamp-go-brr: attacker's-perspective
// characterization of the real injection/leak surface at the EXECUTE level,
// plus pins for the eight known-but-unfixed latent bugs (B1..B8) tracked in
// the LOCAL `swamp-go-brr-latent-bugs` issue-lifecycle bug model (NEVER the
// Lab, per this repo's tracking convention).
//
// gobrr.ts / docker_verify.ts / source_integration.ts / preflight.ts / lib/*
// are UNMODIFIED — every "pin: KNOWN <BUG-ID>" test here characterizes a REAL,
// already-shipped behavior; a fix is out of scope for this test-only backfill.
//
// Bugs pinned here:
//   B1 (MED) — docker-verify's `verify()` (sshExecRaw) has NO client-side
//      timeout on the remote command's runtime; ssh's own ConnectTimeout=10
//      bounds only the handshake.
//   B2 (MED) — preflight's `scaffoldRepo` joins `ScaffoldFile.path` directly
//      into `${repoPath}/${path}` with no traversal guard — a `../` path
//      escapes repoPath (blast radius is within-temp: the caller controls
//      repoPath, typically a freshly-created scratch dir).
//   B3 (MED) — lib/ssh.ts hardcodes `StrictHostKeyChecking=no` +
//      `UserKnownHostsFile=/dev/null` — MITM-susceptible.
//   B4 (LOW) — lib/scrub.ts's generic `key=value` pattern is a deliberate
//      false-positive-prone over-approximation (redacts benign text shaped
//      like a secret) and scrubSecrets has no input-size cap of its own —
//      callers tail-bound AFTER scrubbing, not before.
//   B5 (LOW) — scrubSecrets has NO coverage for a bare high-entropy secret
//      with no recognizable key word (documented as an accepted gap in the
//      source's own comment).
//   B6 (LOW) — source-integration's local `jjRun` has no timeout and does not
//      pass `--no-pager`.
//   B7 (LOW) — `parseGitDiffPaths`'s `a/(.+?) b/` regex mis-splits a path
//      containing a literal " b/" substring — UNREACHABLE via the real
//      `apply()` flow because `pathEscapes` already rejects any
//      whitespace-containing path upstream of the ACL guard.
//   B8 (LOW) — `apply()`'s per-file write is resolve-then-write, not atomic:
//      a symlink swapped into place between `resolveWithinRepo`'s check and
//      the actual `Deno.writeTextFileSync` escapes the repo (TOCTOU).
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model as siModel } from "./source_integration.ts";
import { model as dvModel } from "./docker_verify.ts";
import { model as preflightModel } from "./preflight.ts";
import { model as otlpExportModel } from "./otlp_export.ts";
import { pathEscapes, resolveWithinRepo } from "./lib/acl.ts";
import { scrubSecrets } from "./lib/scrub.ts";
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
// B1 (MED) — docker-verify: no client-side timeout on the remote command.
// ===========================================================================

Deno.test("pin: KNOWN GAP (MED, swamp-go-brr-latent-bugs B1) — docker-verify's ssh transport has NO client-side timeout on the remote docker run's runtime", async () => {
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
  assert(
    capturedArgs.some((a) => a === "ConnectTimeout=10"),
    "ssh's ConnectTimeout bounds only the HANDSHAKE",
  );
  const remoteCmd = capturedArgs[capturedArgs.length - 1];
  assert(
    !/^timeout\s|;\s*timeout\s/.test(remoteCmd),
    "the remote docker run command itself is never wrapped in a client-side " +
      "`timeout`, so a hung verify container can hang the ssh session " +
      "indefinitely past the handshake. pin: KNOWN GAP, not fixed here " +
      "(source frozen); see swamp-go-brr-latent-bugs B1.",
  );
});

// ===========================================================================
// B2 (MED, within-temp) — preflight scaffold: ScaffoldFile.path traversal.
// ===========================================================================

Deno.test("pin: KNOWN GAP (MED, swamp-go-brr-latent-bugs B2) — preflight.scaffold writes a ../-traversal ScaffoldFile.path OUTSIDE repoPath (within-temp blast radius)", async () => {
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
    await callMethod(preflightModel, "scaffold", {
      repoPath,
      files: [{ path: "../escaped.txt", content: "ESCAPED" }],
    }, ctx);
    const leaked = await Deno.readTextFile(`${sandbox}/escaped.txt`);
    assertEquals(
      leaked,
      "ESCAPED",
      "a ../ ScaffoldFile.path is written with NO traversal guard — escapes " +
        "repoPath into its parent. pin: KNOWN GAP, not fixed here (source " +
        "frozen); see swamp-go-brr-latent-bugs B2. Blast radius is bounded " +
        "to this test's own temp sandbox (within-temp).",
    );
  } finally {
    restore();
    await Deno.remove(sandbox, { recursive: true });
  }
});

// ===========================================================================
// B3 (MED) — ssh.ts: StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null.
// ===========================================================================

Deno.test("pin: KNOWN GAP (MED, swamp-go-brr-latent-bugs B3) — every ssh invocation disables host-key verification (MITM-susceptible)", async () => {
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
  assert(capturedArgs.includes("StrictHostKeyChecking=no"));
  assert(
    capturedArgs.includes("UserKnownHostsFile=/dev/null"),
    "host-key pinning is fully disabled — a network-position attacker can " +
      "MITM the ssh transport undetected. pin: KNOWN GAP, not fixed here " +
      "(source frozen); see swamp-go-brr-latent-bugs B3.",
  );
});

// ===========================================================================
// B4 (LOW) — scrub.ts: false-positive-prone generic pattern, no size cap.
// ===========================================================================

Deno.test("pin: KNOWN GAP (LOW, swamp-go-brr-latent-bugs B4) — scrubSecrets redacts a BENIGN, non-secret 'token=' value (false positive, by documented design)", () => {
  const benign = "the session token=abc12345 had expired, please retry";
  const out = scrubSecrets(benign);
  assert(
    !out.includes("abc12345"),
    "the high-entropy-shaped-but-benign value is redacted — an intentional " +
      "over-eager tradeoff (per the source's own doc comment: 'prefer " +
      "redacting a benign-but-secret-shaped string to leaking a real " +
      "credential'). pin: KNOWN GAP, not fixed here; see " +
      "swamp-go-brr-latent-bugs B4.",
  );
});

Deno.test("pin: KNOWN GAP (LOW, swamp-go-brr-latent-bugs B4) — scrubSecrets has no input-size cap of its own; callers tail-bound AFTER scrubbing, not before", () => {
  // A large adversarial payload with many false-trigger occurrences is still
  // scrubbed in full (6 sequential global regex passes over the WHOLE
  // string) before any caller applies a length cap — e.g. docker_verify's
  // boundedStdout is `scrubSecrets(stdout).slice(-8000)`, scrub-THEN-slice.
  const many = Array.from(
    { length: 500 },
    (_v, i) => `token=benignvalue${i}number`,
  ).join(" ");
  const start = performance.now();
  const out = scrubSecrets(many);
  const elapsed = performance.now() - start;
  assert(!out.includes("benignvalue0number"), "each occurrence is redacted");
  assert(
    elapsed < 5000,
    "scrubSecrets must not itself impose a size cap or bail out early — it " +
      "processes the FULL string regardless of size; a truly adversarial " +
      "(much larger) payload is bounded only by upstream transport limits, " +
      "not by scrubSecrets. pin: KNOWN GAP, not fixed here; see " +
      "swamp-go-brr-latent-bugs B4.",
  );
});

// ===========================================================================
// B5 (LOW) — scrub.ts: bare high-entropy secret with no key word survives.
// ===========================================================================

Deno.test("pin: KNOWN GAP (LOW, swamp-go-brr-latent-bugs B5) — a bare high-entropy secret with NO recognizable key word is NOT redacted", () => {
  const bareSecret = "aGVsbG8gd29ybGQgc2VjcmV0S2V5MTIzNDU2Nzg5MA";
  const out = scrubSecrets(`payload=${bareSecret} end`);
  assert(
    out.includes(bareSecret),
    "a bare base64-shaped blob with no 'token='/'secret='/etc. key word " +
      "ahead of it survives untouched — an accepted, DOCUMENTED gap (see " +
      "the source's own comment: 'NOT caught... secrets with no " +
      "recognizable key word, and bare base64 blobs not behind a known " +
      "key'). pin: KNOWN GAP, not fixed here; see swamp-go-brr-latent-bugs " +
      "B5.",
  );
});

// ===========================================================================
// B6 (LOW) — source-integration's jjRun: no timeout, no --no-pager.
// ===========================================================================

Deno.test("pin: KNOWN GAP (LOW, swamp-go-brr-latent-bugs B6) — apply()'s jj invocations carry no --no-pager flag and no timeout wiring", async () => {
  await withTempRepo(async (repoRoot) => {
    const capturedArgSets: string[][] = [];
    const restore = stubDirectOutput((_cmd, args) => {
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
      restore();
    }
    assert(
      capturedArgSets.length >= 2,
      "jj new/diff/log must all be attempted",
    );
    for (const args of capturedArgSets) {
      assert(
        !args.includes("--no-pager"),
        "no jj invocation passes --no-pager (relies on jj's own non-tty " +
          "auto-detection instead). pin: KNOWN GAP, not fixed here; see " +
          "swamp-go-brr-latent-bugs B6.",
      );
    }
  });
});

// ===========================================================================
// B7 (LOW) — parseGitDiffPaths: " b/" mis-split, unreachable via apply().
// ===========================================================================

Deno.test("pin: KNOWN GAP (LOW, swamp-go-brr-latent-bugs B7) — parseGitDiffPaths mis-splits a path containing a literal ' b/' substring", () => {
  // The non-greedy `a\/(.+?)` stops at the FIRST " b/" it finds, so a path
  // like "weird b/file.ts" mis-splits the header instead of matching the
  // true trailing " b/weird b/file.ts".
  const diff = [
    "diff --git a/weird b/file.ts b/weird b/file.ts",
    "new file mode 100644",
  ].join("\n");
  const out = parseGitDiffPaths(diff);
  assert(out.length === 1, "still emits exactly one entry");
  assert(
    out[0].path !== "weird b/file.ts",
    "the mis-split path does NOT equal the true intended path — the regex " +
      "stopped at the first ' b/' occurrence inside the filename itself. " +
      "pin: KNOWN GAP, not fixed here; see swamp-go-brr-latent-bugs B7.",
  );
});

Deno.test("safe: CONTRAST — B7 is UNREACHABLE via the real apply() flow, because pathEscapes already rejects any whitespace-containing path upstream", () => {
  assert(
    pathEscapes("weird b/file.ts"),
    "a path containing a space is rejected by the ACL guard (planApply's " +
      "guard() calls pathEscapes) long before jj ever sees it, so the " +
      "mis-split in parseGitDiffPaths above can never actually be triggered " +
      "through apply()'s real input surface.",
  );
});

// ===========================================================================
// B8 (LOW) — apply(): resolve-then-write TOCTOU symlink-swap.
// ===========================================================================

Deno.test("pin: KNOWN GAP (LOW, swamp-go-brr-latent-bugs B8) — apply()'s resolve-then-write is NOT atomic: a symlink swapped in between escapes the repo (TOCTOU)", async () => {
  // realpath'd up front — resolveWithinRepo requires an already-canonical
  // repoRoot (macOS's tmp dirs resolve through /var -> /private/var), exactly
  // as apply()'s execute() does internally via Deno.realPathSync(repoScope).
  const repoRoot = Deno.realPathSync(await Deno.makeTempDir());
  const outside = Deno.realPathSync(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${repoRoot}/sub`);
    // Step 1 (the CHECK) — exactly what apply()'s write loop does first.
    const r = resolveWithinRepo(repoRoot, "sub/file.txt");
    assert(r.ok, "the check passes while sub/ is a real, contained directory");

    // TOCTOU WINDOW — an attacker with local filesystem access swaps `sub`
    // for a symlink pointing OUTSIDE the repo between the check and the
    // write. apply() has no re-verification here; it reuses the resolved
    // `abs` from the stale check, exactly reproduced below.
    await Deno.remove(`${repoRoot}/sub`, { recursive: true });
    await Deno.symlink(outside, `${repoRoot}/sub`);

    // Step 2 (the WRITE) — same stale `abs`, no re-check, exactly apply()'s shape.
    await Deno.writeTextFile(r.abs, "escaped content");

    const leaked = await Deno.readTextFile(`${outside}/file.txt`);
    assertEquals(
      leaked,
      "escaped content",
      "the write landed OUTSIDE the repo through the swapped symlink — " +
        "TOCTOU escape confirmed. pin: KNOWN GAP, not fixed here (source " +
        "frozen); see swamp-go-brr-latent-bugs B8.",
    );
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});
