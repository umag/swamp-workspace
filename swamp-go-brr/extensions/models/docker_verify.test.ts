// Deno tests for @magistr/swamp-go-brr/docker-verify — the PURE command builder.
// Live `docker run` is an Unraid integration test; here we assert the hardening.
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  boundedStdout,
  buildVerifyArgs,
  buildVerifyCommandLine,
  model,
  parseExitSentinel,
  type VerifySpec,
} from "./docker_verify.ts";

const SPEC: VerifySpec = {
  image: "reg/toolchain@sha256:" + "a".repeat(64),
  treePath: "/srv/runs/run1/tree",
  verifyCommand: "deno test",
  user: "65534:65534",
  pidsLimit: 512,
  memory: "2g",
  cpus: "2",
};

Deno.test("buildVerifyArgs emits every hardening flag", () => {
  const a = buildVerifyArgs(SPEC).join(" ");
  for (
    const flag of [
      "--rm",
      "--network none",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--read-only",
      "--pids-limit 512",
      "--memory 2g",
      "--cpus 2",
      "--user 65534:65534",
      "/srv/runs/run1/tree:/w:ro",
    ]
  ) {
    assert(a.includes(flag), `missing: ${flag}`);
  }
});

Deno.test("buildVerifyArgs carries NO token and NO docker socket", () => {
  const a = buildVerifyArgs(SPEC).join(" ");
  assert(!/sk-ant|TOKEN|Authorization|ANTHROPIC|OAUTH/i.test(a));
  assert(!/docker\.sock/.test(a));
});

Deno.test("buildVerifyArgs rejects a non-digest-pinned image", () => {
  assertThrows(() =>
    buildVerifyArgs({ ...SPEC, image: "reg/toolchain:latest" })
  );
});

Deno.test("buildVerifyArgs rejects an unsafe / relative tree path", () => {
  assertThrows(() => buildVerifyArgs({ ...SPEC, treePath: "../escape" }));
  assertThrows(() => buildVerifyArgs({ ...SPEC, treePath: "/a/../b" }));
  assertThrows(() => buildVerifyArgs({ ...SPEC, treePath: "relative/path" }));
});

Deno.test("buildVerifyArgs rejects a token smuggled into the verify command", () => {
  assertThrows(() =>
    buildVerifyArgs({ ...SPEC, verifyCommand: "echo sk-ant-leak" })
  );
});

Deno.test("buildVerifyCommandLine appends the exit-code sentinel", () => {
  const line = buildVerifyCommandLine(SPEC);
  assert(line.includes("__GOBRR_EXIT__"));
  assert(line.includes("'deno test'"));
});

Deno.test("parseExitSentinel recovers the exit code from stdout", () => {
  assertEquals(parseExitSentinel("...test output...\n__GOBRR_EXIT__:0\n"), 0);
  assertEquals(parseExitSentinel("boom\n__GOBRR_EXIT__:1"), 1);
  assertEquals(parseExitSentinel("no sentinel here"), null);
});

// Characterization (assessment-boundary audit): the sentinel is appended by the HOST
// shell (echo "__GOBRR_EXIT__:$?") AFTER `docker run` returns, so a container that emits
// its own __GOBRR_EXIT__:0 cannot forge a green — the host's trailing sentinel wins
// (the $-anchored regex takes the LAST match). A future m-flag regex change would break
// this; the test pins it.
Deno.test("parseExitSentinel: a container-forged sentinel loses to the host's trailing one", () => {
  assertEquals(
    parseExitSentinel("test ok\n__GOBRR_EXIT__:0\nmore\n__GOBRR_EXIT__:1\n"),
    1,
  );
  assertEquals(parseExitSentinel("__GOBRR_EXIT__:0\n__GOBRR_EXIT__:1"), 1);
  // last-wins, NOT max-picking: the trailing host sentinel is 0 here
  assertEquals(
    parseExitSentinel("__GOBRR_EXIT__:0\n__GOBRR_EXIT__:1\n__GOBRR_EXIT__:0\n"),
    0,
  );
});

// ── retention guard (issue si-applied-resource-lifetime) ─────────────────────
// The verify result holds (scrubbed) verify stdout — bound it so a missed secret
// does not persist forever. Read via `as string` to avoid the `as const`
// literal-overlap; RED until the lifetime is flipped from "infinite" to "24h".
Deno.test("docker_verify result resource is bounded to 24h, not infinite", () => {
  const lt = model.resources.result.lifetime as string;
  assertEquals(lt, "24h");
  assert(lt !== "infinite", "result must not retain verify stdout forever");
});

// boundedStdout is the pure write-boundary transform for result.stdout: scrub secrets
// UNCONDITIONALLY (raw verify stdout can echo env-var secrets on failure) then tail-bound.
// RED until the helper exists; scrubSecrets itself is unit-covered in lib/scrub.test.ts.
Deno.test("boundedStdout scrubs secrets in verify stdout and tail-bounds it", () => {
  const out = boundedStdout(
    "FAIL aws=AKIAIOSFODNN7EXAMPLE tok=sk-ant-LEAKEDsecret123456\nstack trace",
  );
  assert(!out.includes("AKIAIOSFODNN7EXAMPLE"), "AWS key scrubbed");
  assert(
    !out.includes("sk-ant-LEAKEDsecret123456"),
    "anthropic token scrubbed",
  );
  assert(out.includes("stack trace"), "non-secret content preserved");
  assertEquals(boundedStdout("x".repeat(9000)).length, 8000); // tail-bounded
  // keeps the TAIL, not the head (a slice(0,N) impl would fail this)
  assert(
    boundedStdout("A".repeat(9000) + "TAIL-MARKER").endsWith("TAIL-MARKER"),
    "boundedStdout keeps the tail",
  );
});
