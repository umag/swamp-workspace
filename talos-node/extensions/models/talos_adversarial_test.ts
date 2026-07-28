/**
 * Adversarial suite: destructive-op semantics pins, precise argv-injection
 * characterization, malformed/hostile talosctl output parsing, transient-
 * retry behavior (setTimeout neutralized), and a mechanical
 * fixtures-secret-scan over talos-node/fixtures/*.json.
 *
 * talos.ts is UNMODIFIED — every test here PINS current behavior (including
 * behavior that is arguably risky) rather than proposing a fix. Where a test
 * documents a real gap, it is labeled "pin" and says so explicitly.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./talos.ts";
import version from "../../fixtures/version.json" with { type: "json" };
import services from "../../fixtures/services.json" with { type: "json" };
import etcdMembers from "../../fixtures/etcd-members.json" with {
  type: "json",
};
import kubeconfig from "../../fixtures/kubeconfig.json" with { type: "json" };
import health from "../../fixtures/health.json" with { type: "json" };
import applyConfig from "../../fixtures/apply-config.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ENDPOINT = "192.0.2.10";
const GLOBAL_ARGS = { endpoint: ENDPOINT, insecure: false };

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
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

type CommandEnvelope = { success: boolean; stdout: string; stderr: string };
type CommandRecording = { cmd: string; args: string[] };

function withCommandStub(
  handler: (
    call: CommandRecording,
    callIndex: number,
  ) => CommandEnvelope | Promise<CommandEnvelope>,
  fn: (calls: CommandRecording[]) => Promise<void>,
) {
  const denoRecord = Deno as unknown as Record<string, unknown>;
  const original = denoRecord.Command;
  const calls: CommandRecording[] = [];
  let index = 0;
  class FakeCommand {
    #recording: CommandRecording;
    constructor(cmd: string, options: { args?: string[] }) {
      this.#recording = { cmd, args: options.args ?? [] };
    }
    output(): Promise<
      { success: boolean; stdout: Uint8Array; stderr: Uint8Array }
    > {
      calls.push(this.#recording);
      const i = index++;
      return Promise.resolve(handler(this.#recording, i)).then((r) => ({
        success: r.success,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      }));
    }
  }
  denoRecord.Command = FakeCommand;
  return fn(calls).finally(() => {
    denoRecord.Command = original;
  });
}

function withOneCommand(
  envelope: CommandEnvelope,
  fn: (calls: CommandRecording[]) => Promise<void>,
) {
  return withCommandStub(() => envelope, fn);
}

/** Neutralize the retry backoff sleep so a transient-retry test resolves
 * synchronously instead of waiting the real 15s `retryDelay`. Restored in
 * `finally` — a leaked stub would hang or corrupt every OTHER test file
 * sharing this Deno test-runner isolate. */
function withSyncSetTimeout(fn: () => Promise<void>) {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const original = globalRecord.setTimeout;
  globalRecord.setTimeout = (
    (cb: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      cb(...args);
      return 0 as unknown as number;
    }
  ) as unknown as typeof globalThis.setTimeout;
  return fn().finally(() => {
    globalRecord.setTimeout = original;
  });
}

const OK = (stdout = ""): CommandEnvelope => ({
  success: true,
  stdout,
  stderr: "",
});
const FAIL = (stderr: string): CommandEnvelope => ({
  success: false,
  stdout: "",
  stderr,
});
const ENDPOINT_SUFFIX = ["--endpoints", ENDPOINT, "--nodes", ENDPOINT];

// ---------------------------------------------------------------------------
// Destructive-op pins: success is exit-STATUS, not semantic success
// ---------------------------------------------------------------------------

Deno.test("pin: mutating methods report success:true purely from talosctl's exit code — stdout content is NEVER inspected for semantic failure", async () => {
  const scenarios: Array<[string, Record<string, unknown>]> = [
    ["bootstrap", {}],
    ["reboot", {}],
    ["shutdown", {}],
    ["reset", {}],
    ["upgrade", { image: "ghcr.io/siderolabs/installer:v1.9.5" }],
    ["applyConfig", { configFile: "/fake/x.yaml", mode: "auto" }],
    ["patchConfig", { patchFile: "/fake/patch.yaml", mode: "auto" }],
  ];
  for (const [name, args] of scenarios) {
    const { ctx, written } = makeCtx();
    // stdout/stderr deliberately say the OPPOSITE of success; exit 0 still
    // wins, because talos.ts never parses this text for a semantic verdict.
    await withOneCommand(
      OK("ERROR: this operation did not actually succeed"),
      async () => {
        await run(name, args, ctx);
      },
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(
      res.payload.success,
      true,
      `${name}: success reflects exit-status, not stdout content`,
    );
  }
});

Deno.test("pin: health's success:true and message are independent — a message full of failure-sounding text is still success:true", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK("2 of 3 control plane nodes NOT ready\n"),
    async () => {
      await run("health", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
  assertEquals(res.payload.message, "2 of 3 control plane nodes NOT ready");
});

// ---------------------------------------------------------------------------
// Precise argv-injection characterization — array-arg Deno.Command, no shell
// ---------------------------------------------------------------------------

Deno.test("a hostile configFile value (spaces, quotes, shell metacharacters) lands as ONE exact positional argv element — structurally shell-safe", async () => {
  const { ctx } = makeCtx();
  const hostile = '/tmp/my "file"; rm -rf ~ && echo pwned.yaml';
  await withOneCommand(OK(), async (calls) => {
    await run("applyConfig", { configFile: hostile, mode: "auto" }, ctx);
    assertEquals(
      calls[0].args,
      ["apply-config", "--file", hostile, "--mode", "auto", ...ENDPOINT_SUFFIX],
      "the hostile string is exactly one argv element, untouched by any shell",
    );
  });
});

Deno.test("a hostile patchFile value with embedded newlines is passed through as one argv element, not split", async () => {
  const { ctx } = makeCtx();
  const hostile = "/tmp/patch.yaml\n--reset\n--force";
  await withOneCommand(OK(), async (calls) => {
    await run("patchConfig", { patchFile: hostile, mode: "auto" }, ctx);
    assertEquals(
      calls[0].args,
      [
        "patch",
        "machineconfig",
        "--patch-file",
        hostile,
        "--mode",
        "auto",
        ...ENDPOINT_SUFFIX,
      ],
      "the newline-bearing string is exactly one argv element, not split into extra flags",
    );
  });
});

Deno.test("pin: an upgrade image value starting with '-' is passed through verbatim — no `--` end-of-options guard in talos.ts", async () => {
  // Documented residual (security review, plan v2): array-arg Deno.Command
  // means there is no SHELL to inject into, but a leading-dash value could
  // still be reinterpreted by talosctl itself as one of ITS OWN flags
  // (argument injection, not shell injection) since talos.ts never inserts
  // a `--` end-of-options marker before the image value. Not fixed here —
  // talos.ts is unmodified by this change. Callers must not pass
  // attacker-controlled image values.
  const { ctx } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("upgrade", { image: "--foo" }, ctx);
    assertEquals(calls[0].args, [
      "upgrade",
      "--image",
      "--foo",
      ...ENDPOINT_SUFFIX,
    ]);
  });
});

Deno.test("pin: a talosconfig path value starting with '-' is passed through verbatim in the same unguarded way", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(OK("{}"), async (calls) => {
    await run("version", {}, {
      ...ctx,
      globalArgs: { ...GLOBAL_ARGS, talosconfig: "--not-a-real-path" },
    });
    assertEquals(
      calls[0].args,
      [
        "version",
        "--json",
        ...ENDPOINT_SUFFIX,
        "--talosconfig",
        "--not-a-real-path",
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed / hostile talosctl output parsing
// ---------------------------------------------------------------------------

Deno.test("pin: a non-JSON version --json response surfaces as an unmapped SyntaxError", async () => {
  // talos.ts calls `JSON.parse(stdout)` unconditionally on version's output;
  // a truncated/corrupt/non-JSON response throws a raw SyntaxError, not a
  // domain-specific error. Documented gap, not fixed here.
  const { ctx } = makeCtx();
  await withOneCommand(OK("not json at all"), async () => {
    await assertRejects(() => run("version", {}, ctx), SyntaxError);
  });
});

Deno.test("pin: version JSON missing both `version` and `server.version` falls back to tag 'unknown', sha/arch/platform undefined", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK("{}"), async () => {
    await run("version", {}, ctx);
  });
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.tag, "unknown");
  assertEquals(res.payload.sha, undefined);
  assertEquals(res.payload.arch, undefined);
  assertEquals(res.payload.platform, undefined);
});

Deno.test("pin: a services row with fewer than 4 whitespace-split columns is silently skipped (no error, no resource)", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK("NODE SERVICE STATE HEALTH\n192.0.2.10 apid Running\n"),
    async () => {
      await run("services", {}, ctx);
    },
  );
  assertEquals(
    written.filter((w) => w.spec === "service").length,
    0,
    "a 3-column row (missing HEALTH) never produces a service resource",
  );
});

Deno.test("pin: a SERVICE value containing an internal space mis-columns the whitespace-split tabular parser", async () => {
  // talos.ts's services parser does `line.trim().split(/\s+/)` and reads
  // columns strictly by POSITION (parts[1]=id, parts[2]=state,
  // parts[3]=health). A malformed/hostile row whose SERVICE name itself
  // contains a space shifts every later column left by one, silently
  // mis-assigning state/health to fragments of the service name. This is a
  // real, documented gap — not fixed here (talos.ts is unmodified).
  const { ctx, written } = makeCtx();
  const hostileRow = "192.0.2.10   weird service name   Running   OK\n";
  await withOneCommand(
    OK(`NODE SERVICE STATE HEALTH\n${hostileRow}`),
    async () => {
      await run("services", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "service")!;
  assertEquals(res.name, "weird", "the id is only the FIRST token of the name");
  assertEquals(
    res.payload.state,
    "service",
    "state mis-reads the 2nd token of the name",
  );
  assertEquals(
    res.payload.health,
    "name",
    "health mis-reads the 3rd token of the name",
  );
});

Deno.test("pin: an etcd member row with fewer than 6 whitespace-split columns is silently skipped", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK(
      "NODE ID HOSTNAME PEER CLIENT LEARNER\n192.0.2.10 abc123 cp1 https://192.0.2.10:2380\n",
    ),
    async () => {
      await run("etcdMembers", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "etcdMember").length, 0);
});

Deno.test("pin: a HOSTNAME value containing an internal space mis-columns the etcd-members parser the same way", async () => {
  const { ctx, written } = makeCtx();
  const hostileRow =
    "192.0.2.10   abc123   cp one   https://192.0.2.10:2380   https://192.0.2.10:2379   false\n";
  await withOneCommand(
    OK(`NODE ID HOSTNAME PEER CLIENT LEARNER\n${hostileRow}`),
    async () => {
      await run("etcdMembers", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "etcdMember")!;
  // parts: [192.0.2.10, abc123, cp, one, https://.../2380, https://.../2379, false]
  assertEquals(res.name, "cp", "hostname mis-reads only the first token");
  assertEquals(
    res.payload.peerUrls,
    ["one"],
    "peerUrls mis-reads the 2nd token of the hostname",
  );
});

// ---------------------------------------------------------------------------
// Transient-retry behavior — setTimeout MUST be neutralized
// ---------------------------------------------------------------------------

Deno.test("bootstrap retries once on a transient error and succeeds on the second attempt", async () => {
  const { ctx, written } = makeCtx();
  await withSyncSetTimeout(async () => {
    await withCommandStub(
      (_call, i) =>
        i === 0
          ? FAIL("rpc error: code = Unavailable desc = connection refused")
          : OK(),
      async (calls) => {
        await run("bootstrap", {}, ctx);
        assertEquals(
          calls.length,
          2,
          "one failed attempt + one successful retry",
        );
      },
    );
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

Deno.test("bootstrap does NOT retry a non-transient error even though retries=20 — fails immediately", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    () => FAIL("rpc error: code = InvalidArgument desc = bad request"),
    async (calls) => {
      await assertRejects(
        () => run("bootstrap", {}, ctx),
        Error,
        "talosctl bootstrap failed: rpc error: code = InvalidArgument desc = bad request",
      );
      assertEquals(calls.length, 1, "no retry for a non-transient error");
    },
  );
});

Deno.test("bootstrap exhausts all 21 attempts (20 retries) on a persistently transient error, with setTimeout neutralized to avoid a 20*15s hang", async () => {
  const { ctx } = makeCtx();
  await withSyncSetTimeout(async () => {
    await withCommandStub(
      () => FAIL("rpc error: code = Unavailable desc = connection refused"),
      async (calls) => {
        await assertRejects(
          () => run("bootstrap", {}, ctx),
          Error,
          "talosctl bootstrap failed: rpc error: code = Unavailable desc = connection refused",
        );
        assertEquals(calls.length, 21, "20 retries + the initial attempt");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
//
// Unlike porkbun's fetch-boundary JSON fixtures (flat leaf-string values),
// talos-node's fixtures are {success, stdout, stderr} CLI-text envelopes —
// stdout/stderr are multi-line blobs, not isolated tokens. The scan below
// therefore searches WITHIN each line for secret-shaped substrings (an
// unanchored regex) rather than whole-string equality, since a real leaked
// credential would appear embedded in a larger line of output (e.g. a
// kubeconfig YAML field), not as the sole content of a JSON leaf.
// ---------------------------------------------------------------------------

const KUBECONFIG_ALLOWLISTED_FIELDS = [
  "certificate-authority-data",
  "client-certificate-data",
  "client-key-data",
];

const SECRET_PATTERNS: Array<
  { name: string; re: RegExp; nameScopedAllowlist: boolean }
> = [
  {
    name: "PEM block header",
    re: /-----BEGIN [A-Z ]+-----/,
    nameScopedAllowlist: false,
  },
  {
    name: "JWT-shaped token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    nameScopedAllowlist: false,
  },
  {
    name: "talosconfig PKI field (crt:/key:/ca: with a long base64 payload)",
    re: /\b(crt|key|ca):\s*[A-Za-z0-9+/=]{20,}/,
    nameScopedAllowlist: false,
  },
  {
    name: "high-entropy base64/hex token (32+ chars)",
    re: /\b[A-Za-z0-9+/_=-]{32,}\b/,
    // Allow-listed ONLY by field name, ONLY in kubeconfig.json, and ONLY for
    // this one pattern — the three PEM/JWT/talos-PKI patterns above are
    // NEVER allow-listed, so a genuinely captured credential still trips
    // the scan even inside an allow-listed field (see the sanity test).
    nameScopedAllowlist: true,
  },
];

function lineIsAllowlistedKubeconfigField(file: string, line: string): boolean {
  if (file !== "kubeconfig.json") return false;
  return KUBECONFIG_ALLOWLISTED_FIELDS.some((f) => line.includes(`${f}:`));
}

function scanTextForSecrets(
  file: string,
  label: string,
  text: string,
  violations: string[],
) {
  for (const line of text.split("\n")) {
    for (const { name, re, nameScopedAllowlist } of SECRET_PATTERNS) {
      if (!re.test(line)) continue;
      if (nameScopedAllowlist && lineIsAllowlistedKubeconfigField(file, line)) {
        continue;
      }
      violations.push(
        `${file} (${label}): line ${JSON.stringify(line)} matched "${name}"`,
      );
    }
  }
}

const FIXTURE_ENVELOPES: Record<
  string,
  { success: boolean; stdout: string; stderr: string }
> = {
  "version.json": version,
  "services.json": services,
  "etcd-members.json": etcdMembers,
  "kubeconfig.json": kubeconfig,
  "health.json": health,
  "apply-config.json": applyConfig,
  "error.json": errorFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string outside the name-scoped kubeconfig allow-list", () => {
  const violations: string[] = [];
  for (const [file, envelope] of Object.entries(FIXTURE_ENVELOPES)) {
    scanTextForSecrets(file, "stdout", envelope.stdout, violations);
    scanTextForSecrets(file, "stderr", envelope.stderr, violations);
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — a real-shaped PEM/JWT still trips the scan even inside an allow-listed kubeconfig field", () => {
  const violations: string[] = [];
  const poisonedPem =
    "    client-key-data: -----BEGIN RSA PRIVATE KEY-----MIIEow...";
  const poisonedJwt =
    "    client-key-data: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLWJsb2Ita2VlcC1nb2luZw";
  scanTextForSecrets(
    "kubeconfig.json",
    "poisoned-pem",
    poisonedPem,
    violations,
  );
  scanTextForSecrets(
    "kubeconfig.json",
    "poisoned-jwt",
    poisonedJwt,
    violations,
  );
  assert(
    violations.length >= 2,
    "sanity check: a real PEM/JWT embedded in an allow-listed field must still be flagged",
  );
});

Deno.test("fixtures-secret-scan: sanity — a bare high-entropy token OUTSIDE a kubeconfig-allow-listed field is flagged", () => {
  const violations: string[] = [];
  const poisoned = "token=" + "a".repeat(40);
  scanTextForSecrets("version.json", "poisoned-generic", poisoned, violations);
  assert(
    violations.length > 0,
    "sanity check: generic high-entropy scan must fire",
  );
});
