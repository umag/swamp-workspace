// Deno tests for @magistr/swamp-go-brr/docker-verify — the PURE command builder.
// Live `docker run` is an Unraid integration test; here we assert the hardening.
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildVerifyArgs,
  buildVerifyCommandLine,
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
