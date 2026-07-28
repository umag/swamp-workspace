/**
 * Adversarial suite for @magistr/talm-cluster: hostile/boundary inputs and a
 * mechanical fixtures + test-source secret-scan.
 *
 * talm_cluster.ts is UNMODIFIED — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Three real, documented gaps are pinned rather than fixed (a version bump
 * to actually fix them is out of scope for this test-only backfill; see
 * CHANGELOG.md):
 *
 *  1. `configure`'s values.yaml is built by raw string interpolation with no
 *     YAML-escaping — a hostile/careless value can inject an arbitrary
 *     top-level YAML key.
 *  2. `templateNode`'s `${dir}/${outputFile}` join performs no path
 *     containment check — a `../`-style outputFile can escape the cluster
 *     directory. Pinned HERMETICALLY: the escape target is a second temp
 *     directory created and torn down by the test, never a real location.
 *  3. The four retry loops (templateNode/apply/bootstrap/health) classify an
 *     attacker-controlled stderr string as transient purely by substring
 *     match — no signature/authentication of the subprocess's own output.
 *
 * See fixtures/PROVENANCE.md for the fixture corpus's provenance and the
 * secret-scan's scope/rationale.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { relative } from "jsr:@std/path@1";
import { model } from "./talm_cluster.ts";

// ---------------------------------------------------------------------------
// Harness (see talm_cluster_test.ts for the fuller doc comment; duplicated
// per this repo's suite convention).
// ---------------------------------------------------------------------------

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(clusterDir: string) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: { clusterDir },
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

interface CapturedCall {
  binary: string;
  args: string[];
  cwd?: string;
  stdin: string;
}

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

type ResultPicker =
  | CommandResult
  | CommandResult[]
  | ((call: CapturedCall, callIndex: number) => CommandResult);

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
  results: ResultPicker,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  let callIndex = 0;
  const original = Deno.Command;

  function pickResult(call: CapturedCall): CommandResult {
    const idx = callIndex++;
    if (typeof results === "function") return results(call, idx);
    if (Array.isArray(results)) {
      return results[idx] ?? results[results.length - 1];
    }
    return results;
  }

  class FakeCommand {
    #call: CapturedCall;
    #result: CommandResult;
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      this.#call = {
        binary,
        args: (opts.args as string[] | undefined) ?? [],
        cwd: opts.cwd as string | undefined,
        stdin: "",
      };
      calls.push(this.#call);
      this.#result = pickResult(this.#call);
    }
    spawn() {
      const call = this.#call;
      const result = this.#result;
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
      return Promise.resolve(encodeOutput(this.#result));
    }
  }

  (Deno as unknown as { Command: unknown }).Command = FakeCommand;
  return fn(calls).finally(() => {
    (Deno as unknown as { Command: unknown }).Command = original;
  });
}

async function withTempClusterDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// 1. values.yaml YAML-injection — PIN, not fixed
// ---------------------------------------------------------------------------

Deno.test("pin: configure's values.yaml is raw-interpolated — a value containing a newline injects an arbitrary top-level YAML key", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const injectedEndpoint = "https://192.0.2.17:6443\nadmin: true";
    await run("configure", {
      endpoint: injectedEndpoint,
      floatingIP: "192.0.2.20",
      image: "ghcr.io/x:v1",
    }, ctx);
    const written = await Deno.readTextFile(`${dir}/values.yaml`);
    assert(
      written.includes("\nadmin: true\n"),
      "the injected newline+key travels into values.yaml verbatim (no escaping)",
    );
    const parsed = parseYaml(written) as Record<string, unknown>;
    assertEquals(
      parsed.admin,
      true,
      "a hostile/careless endpoint value injects an arbitrary top-level YAML " +
        "key once the file is parsed by a real YAML consumer (talm) — a real, " +
        "documented gap, not fixed by this test-only change",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. templateNode path traversal — HERMETIC pin (escape into a SECOND temp
// dir, never a real location; no real write outside temp dirs on any path)
// ---------------------------------------------------------------------------

Deno.test("pin: templateNode's ${dir}/${outputFile} join performs no containment check — HERMETIC escape to a second temp dir", async () => {
  const dir = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    const { ctx } = makeCtx(dir);
    const escapePrefix = relative(dir, outside);
    const outputFile = `${escapePrefix}/evil.yaml`;
    await withCommandStub(
      {
        success: true,
        stdout: "machine:\n  install:\n    disk: /dev/sr0\n",
        stderr: "",
      },
      async () => {
        await run("templateNode", { nodeIP: "192.0.2.10", outputFile }, ctx);
      },
    );
    const landed = await Deno.readTextFile(`${outside}/evil.yaml`);
    assert(
      landed.includes("disk: /dev/vda"),
      "the traversal write landed in the SECOND temp dir (outside the " +
        "cluster dir), post-processed exactly like any other output — a " +
        "real, documented gap (no path containment check), pinned hermetically",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 3. No-sleep retry-storm classification — attacker-controlled stderr is
// classified transient WITHOUT the test ever really sleeping
// ---------------------------------------------------------------------------

Deno.test("pin: an attacker-shaped transient stderr is classified transient WITHOUT the retry loop's 15s sleep ever really elapsing", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const requestedDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const fakeSetTimeout = (
      (cb: (...args: unknown[]) => void, ms?: number) => {
        requestedDelays.push(ms ?? 0);
        cb();
        return 0;
      }
    ) as typeof globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: unknown }).setTimeout =
      fakeSetTimeout;

    const start = performance.now();
    try {
      await withCommandStub(
        [
          {
            success: false,
            stdout: "",
            stderr: 'connection refused (attacker payload: "; rm -rf /")',
          },
          { success: true, stdout: "applied", stderr: "" },
        ],
        async () => {
          await run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx);
        },
      );
    } finally {
      (globalThis as unknown as { setTimeout: unknown }).setTimeout =
        originalSetTimeout;
    }
    const elapsedMs = performance.now() - start;

    assertEquals(
      requestedDelays,
      [15000],
      "the retry loop always REQUESTS a 15s sleep on a transient classification",
    );
    assert(
      elapsedMs < 2000,
      `the stub fires immediately — wall-clock elapsed ${elapsedMs}ms; a ` +
        "real sleep would be 15000ms",
    );
  });
});

// ---------------------------------------------------------------------------
// Credential-content invariant (security-review residual LOW, plan v2):
// getClusterState only ever emits FILENAMES, never file content
// ---------------------------------------------------------------------------

Deno.test("getClusterState never surfaces credential-file CONTENT — only filenames, even when the files carry real-looking bytes", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    // Deliberately NOT a real PEM literal (that would collide with this very
    // file's own fixtures-secret-scan below, which also scans *_test.ts
    // sources) — any distinctive marker proves the same invariant: whatever
    // bytes these files hold, getClusterState never echoes them.
    const SECRET_MARKER = "content-marker-should-never-leak-into-a-resource";
    await Deno.writeTextFile(`${dir}/talosconfig`, SECRET_MARKER);
    await Deno.writeTextFile(`${dir}/kubeconfig`, SECRET_MARKER);
    await Deno.writeTextFile(`${dir}/secrets.yaml`, SECRET_MARKER);

    await run("getClusterState", {}, ctx);

    const res = written.find((w) => w.spec === "result")!;
    const serialized = JSON.stringify(res.payload);
    assert(
      !serialized.includes(SECRET_MARKER),
      "getClusterState must never echo credential file CONTENT into a resource",
    );
    assert(
      serialized.includes("talosconfig") && serialized.includes("kubeconfig") &&
        serialized.includes("secrets.yaml"),
      "getClusterState DOES report the filenames themselves (by design)",
    );
  });
});

// ---------------------------------------------------------------------------
// Fixtures + test-source secret-scan — mechanical backstop, not the primary
// control (see fixtures/PROVENANCE.md). Scope: every fixtures/*.{yaml,yml,
// txt,json} file (documentation .md files are prose, not fixture data — see
// PROVENANCE.md's own long doc URLs, which would otherwise be a source of
// false positives) PLUS every *_test.ts source in this directory, so a
// credential-shaped literal asserted inline in a test body is caught too.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "PEM block marker", re: /-----BEGIN [A-Z ]+-----/ },
];
// Standard base64 alphabet ONLY (no "-"/"_") — deliberately excludes
// base64url and hyphen/underscore-joined identifiers. This repo's fixtures
// never use base64url, and excluding "-" means a `// ---...---` section
// divider or a hyphenated-words identifier (e.g. "cluster-dir-exists")
// splits into short pieces at every hyphen instead of forming one long,
// zero-actual-entropy "token" that would otherwise false-positive.
const HIGH_ENTROPY_TOKEN = /^[A-Za-z0-9+/=]{32,}$/;

/** Split raw text into maximal runs of [A-Za-z0-9+/=] — the same charset the
 * high-entropy rule tests against, so a token can never be split by a
 * character the rule itself would treat as part of the blob. */
function tokensOf(text: string): string[] {
  return text.split(/[^A-Za-z0-9+/=]+/).filter((t) => t.length > 0);
}

/**
 * `checkEntropy: true` for fixture DATA files (yaml/yml/txt/json — pure
 * data, no prose): both the PEM-marker and generic high-entropy-token rules
 * apply. `checkEntropy: false` for `*_test.ts` SOURCE files: only the
 * unambiguous PEM-marker rule applies. Source files are full of natural-
 * language comments and slash/dot-joined identifiers (e.g.
 * "templateNode/apply/bootstrap/health") that a length+charset heuristic
 * cannot distinguish from a genuine credential blob — extending the
 * high-entropy rule to prose produces exactly the kind of noisy, ignorable
 * false positive that erodes trust in a secret scanner. The PEM-marker rule
 * has no such ambiguity (real code never legitimately contains a literal
 * "-----BEGIN ... -----" block), so it stays in scope for source too.
 */
async function scanFile(
  path: string,
  checkEntropy: boolean,
): Promise<string[]> {
  const text = await Deno.readTextFile(path);
  const violations: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) violations.push(`${path}: matched ${name}`);
  }
  if (checkEntropy) {
    for (const token of tokensOf(text)) {
      if (HIGH_ENTROPY_TOKEN.test(token)) {
        violations.push(
          `${path}: token "${token}" is high-entropy-shaped (32+ chars)`,
        );
      }
    }
  }
  return violations;
}

const FIXTURE_DATA_EXTENSIONS = [".yaml", ".yml", ".txt", ".json"];

Deno.test("fixtures-secret-scan: no committed fixture or *_test.ts source contains a secret-shaped string", async () => {
  const fixturesDir = new URL("../../fixtures/", import.meta.url);
  const modelsDir = new URL("./", import.meta.url);
  const violations: string[] = [];

  for await (const entry of Deno.readDir(fixturesDir)) {
    if (
      entry.isFile &&
      FIXTURE_DATA_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
    ) {
      violations.push(
        ...(await scanFile(new URL(entry.name, fixturesDir).pathname, true)),
      );
    }
  }
  for await (const entry of Deno.readDir(modelsDir)) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) {
      violations.push(
        ...(await scanFile(new URL(entry.name, modelsDir).pathname, false)),
      );
    }
  }

  assertEquals(
    violations,
    [],
    `secret-shaped content found:\n${violations.join("\n")}`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually flags an injected secret shape", () => {
  // Guards against the scan above passing vacuously (e.g. a broken regex
  // that never matches). Built at RUNTIME (never a literal 32+-char blob in
  // this file's own source) so this very test doesn't poison itself.
  const poisonToken = "a".repeat(40);
  assert(
    HIGH_ENTROPY_TOKEN.test(poisonToken),
    "sanity check: the high-entropy rule must flag a 40-char alnum blob",
  );
  // Assembled from two halves so the contiguous PEM marker never appears
  // literally in THIS file's own source (which the scan above also reads).
  const poisonPem = "-----BEGIN" + " PRIVATE KEY-----";
  assert(
    SECRET_PATTERNS[0].re.test(poisonPem),
    "sanity check: the PEM rule must flag a real BEGIN marker",
  );
});
