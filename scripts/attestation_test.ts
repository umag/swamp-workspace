// Tests for the attestation validator.
//
// The interesting assertions are the NEGATIVE ones: every way a manifest can
// be unverifiable must produce `valid: false`, because `valid: true` lets CI
// skip the work. A validator that fails open is worse than no validator.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  type FileReader,
  findManifest,
  joinRepoPath,
  sha256Hex,
  validateAttestation,
} from "./attestation.ts";

const HEAD = "a".repeat(40);
const CONFIG = "agent-constraints/verification-controls.md";
const CONFIG_BODY = "controls: fmt lint check test\n";

async function configDigest(): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(CONFIG_BODY));
}

/** A tree containing exactly the one config file, with the right bytes. */
const goodTree: FileReader = (path: string) => {
  if (path.endsWith(CONFIG)) {
    return Promise.resolve(new TextEncoder().encode(CONFIG_BODY));
  }
  return Promise.reject(new Deno.errors.NotFound(path));
};

async function validManifest(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return JSON.stringify({
    attestationVersion: 1,
    issue: "test-issue",
    commitSha: HEAD,
    branch: "feat/x",
    planVersion: 1,
    configChecksums: { [CONFIG]: await configDigest() },
    controls: [{
      name: "test",
      command: "deno task test",
      status: "pass",
      exitCode: 0,
      durationMs: 42,
      runner: "local",
      required: true,
      stderrTail: "",
    }],
    reviews: [{
      reviewer: "review-code",
      verdict: "PASS",
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    }],
    runner: "local",
    producedAt: new Date().toISOString(),
    producedBy: "test-host",
    modelVersion: "2026.08.31.1",
    ...overrides,
  });
}

Deno.test("a well-formed manifest matching the tree is valid", async () => {
  const result = await validateAttestation(
    goodTree,
    await validManifest(),
    HEAD,
    "/repo",
  );
  assertEquals(result.reasons, []);
  assert(result.valid);
});

// ---------------------------------------------------------------------------
// Fail-closed paths
// ---------------------------------------------------------------------------

Deno.test("a missing manifest is not valid", async () => {
  const result = await validateAttestation(goodTree, null, HEAD, "/repo");
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "no attestation manifest");
});

Deno.test("unparseable JSON is not valid", async () => {
  const result = await validateAttestation(
    goodTree,
    "{ not json",
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "not valid JSON");
});

Deno.test("a manifest that does not match the schema is not valid", async () => {
  const result = await validateAttestation(
    goodTree,
    JSON.stringify({ attestationVersion: 1 }),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(
    result.reasons[0],
    "does not match the attestation schema",
  );
});

Deno.test("a manifest attesting a different commit is not valid", async () => {
  const result = await validateAttestation(
    goodTree,
    await validManifest({ commitSha: "b".repeat(40) }),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "but the head is");
});

Deno.test("a changed config file invalidates the manifest", async () => {
  const editedTree: FileReader = (path: string) => {
    if (path.endsWith(CONFIG)) {
      return Promise.resolve(new TextEncoder().encode("controls: (edited)\n"));
    }
    return Promise.reject(new Deno.errors.NotFound(path));
  };
  const result = await validateAttestation(
    editedTree,
    await validManifest(),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "changed since attestation");
});

Deno.test("a config file deleted from the tree invalidates the manifest", async () => {
  const emptyTree: FileReader = (path: string) =>
    Promise.reject(new Deno.errors.NotFound(path));
  const result = await validateAttestation(
    emptyTree,
    await validManifest(),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "could not be read from the tree");
});

Deno.test("a manifest with no config checksums is not valid", async () => {
  const result = await validateAttestation(
    goodTree,
    await validManifest({ configChecksums: {} }),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "declares no config checksums");
});

Deno.test("a MISSING checksum recorded at attest time is not valid", async () => {
  const result = await validateAttestation(
    goodTree,
    await validManifest({ configChecksums: { [CONFIG]: "MISSING" } }),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "recorded as MISSING");
});

Deno.test("every non-pass required control status invalidates the manifest", async () => {
  for (const status of ["fail", "error", "skipped"]) {
    const result = await validateAttestation(
      goodTree,
      await validManifest({
        controls: [{
          name: "test",
          command: "deno task test",
          status,
          exitCode: status === "fail" ? 1 : null,
          durationMs: 1,
          runner: "local",
          required: true,
          stderrTail: "",
        }],
      }),
      HEAD,
      "/repo",
    );
    assertEquals(result.valid, false, `status '${status}' should invalidate`);
    assertStringIncludes(result.reasons[0], `is '${status}', not 'pass'`);
  }
});

Deno.test("a manifest with no required controls is not valid", async () => {
  const result = await validateAttestation(
    goodTree,
    await validManifest({ controls: [] }),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "declares no required controls");
});

Deno.test("a FAIL reviewer verdict invalidates the manifest", async () => {
  const result = await validateAttestation(
    goodTree,
    await validManifest({
      reviews: [{
        reviewer: "review-security",
        verdict: "FAIL",
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      }],
    }),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "recorded a FAIL verdict");
});

Deno.test("open CRITICAL or HIGH findings invalidate the manifest", async () => {
  const result = await validateAttestation(
    goodTree,
    await validManifest({
      reviews: [{
        reviewer: "review-code",
        verdict: "SUGGEST_CHANGES",
        critical: 1,
        high: 2,
        medium: 0,
        low: 0,
      }],
    }),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "1 CRITICAL and 2 HIGH");
});

Deno.test("a manifest with no reviewer results is not valid", async () => {
  const result = await validateAttestation(
    goodTree,
    await validManifest({ reviews: [] }),
    HEAD,
    "/repo",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.reasons[0], "records no reviewer results");
});

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

Deno.test("joinRepoPath refuses a config path that escapes the repo", () => {
  for (const bad of ["../secrets", "a/../../b", "/etc/passwd"]) {
    let threw = false;
    try {
      joinRepoPath("/repo", bad);
    } catch {
      threw = true;
    }
    assert(threw, `'${bad}' should be rejected`);
  }
});

Deno.test("findManifest returns null when the commit has no manifest", async () => {
  const emptyTree: FileReader = (path: string) =>
    Promise.reject(new Deno.errors.NotFound(path));
  assertEquals(await findManifest(emptyTree, "/repo", HEAD), null);
});

Deno.test("findManifest reads .attestations/<sha>.json", async () => {
  const tree: FileReader = (path: string) => {
    assertStringIncludes(path, `.attestations/${HEAD}.json`);
    return Promise.resolve(new TextEncoder().encode("{}"));
  };
  assertEquals(await findManifest(tree, "/repo", HEAD), "{}");
});
