// Idempotency-substring tests for the @magistr/libvirt models.
// Run: deno test extensions/models/libvirt_idempotency_test.ts
//
// The models call virshTry() and inspect the result's stderr for known virsh
// error substrings (the shared IDEMPOTENT_ERRORS sets in lib/connection.ts) to
// stay idempotent — e.g. starting an already-running VM is a no-op success
// rather than an error. This test imports those exact sets (so they cannot
// drift from the models) and pins them against representative virsh 8.7 stderr.
//
// FIXTURES are real libvirt 8.7 error message formats. Re-confirm against live
// captures during the SSH smoke test when the hypervisor is reachable.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  IDEMPOTENT_ERRORS,
  includesAny,
  isIdempotent,
} from "./lib/connection.ts";

// One realistic fixture per needle, keyed by the substring it must match. This
// proves EVERY alternative in every set matches at least one real error (a typo
// in any needle fails the data-driven test below).
const FIXTURES_BY_NEEDLE: Record<string, string> = {
  "already active": "error: Domain is already active",
  "is already running": "error: Domain is already running",
  "domain is not running":
    "error: Requested operation is not valid: domain is not running",
  "failed to get domain": "error: failed to get domain 'ghost'",
  "Domain not found":
    "error: Domain not found: no domain with matching name 'ghost'",
  "No disk found": "error: No disk found whose source path or target is vdz",
  "disk not found": "error: device not found: disk not found 'vdz'",
  "no target device": "error: no target device vdz",
  "already exists": "error: operation failed: pool 'default' already exists",
  "is not active":
    "error: Requested operation is not valid: network 'routed' is not active",
};

// Unrelated failures that must NOT be treated as idempotent by any set.
const UNRELATED = [
  "error: Cannot access storage file (permission denied)",
  "error: Failed to connect socket to '/var/run/libvirt/...': No such file or directory",
  "error: network 'br0' not found", // contains bare "not found" — must NOT match diskNotFound
  "error: cannot open file '/x': file not found",
];

Deno.test("every IDEMPOTENT_ERRORS needle matches a realistic virsh error", () => {
  for (const [setName, needles] of Object.entries(IDEMPOTENT_ERRORS)) {
    for (const needle of needles) {
      const fixture = FIXTURES_BY_NEEDLE[needle];
      assert(
        fixture !== undefined,
        `missing fixture for needle "${needle}" in set ${setName}`,
      );
      assert(
        includesAny(fixture, needles),
        `set ${setName} should match its own fixture for "${needle}"`,
      );
    }
  }
});

Deno.test("idempotency sets do NOT swallow unrelated failures (incl. bare 'not found')", () => {
  for (const [setName, needles] of Object.entries(IDEMPOTENT_ERRORS)) {
    for (const err of UNRELATED) {
      assertEquals(
        includesAny(err, needles),
        false,
        `set ${setName} wrongly matched unrelated error: ${err}`,
      );
    }
  }
});

Deno.test("diskNotFound is anchored — a bare 'not found' is not idempotent", () => {
  // Regression guard for the original over-broad ["not found","doesn't exist"].
  assertEquals(
    includesAny(
      "error: network 'br0' not found",
      IDEMPOTENT_ERRORS.diskNotFound,
    ),
    false,
  );
  assert(
    includesAny(
      "error: No disk found whose source path or target is vdz",
      IDEMPOTENT_ERRORS.diskNotFound,
    ),
  );
});

Deno.test("isIdempotent matches on stdout as well as stderr", () => {
  // virsh writes errors to stderr, but the original code also checked stdout —
  // preserve that: a needle on stdout (empty stderr) still counts.
  assert(
    isIdempotent(
      { code: 1, stdout: "Domain is already active", stderr: "" },
      IDEMPOTENT_ERRORS.vmAlreadyRunning,
    ),
  );
  assertEquals(
    isIdempotent(
      { code: 1, stdout: "totally unrelated", stderr: "also unrelated" },
      IDEMPOTENT_ERRORS.vmAlreadyRunning,
    ),
    false,
  );
});

Deno.test("vmNotRunning requires the 'domain' anchor, not a bare 'not running'", () => {
  assertEquals(
    includesAny(
      "error: guest agent is not running",
      IDEMPOTENT_ERRORS.vmNotRunning,
    ),
    false,
  );
  assert(
    includesAny(
      "error: Requested operation is not valid: domain is not running",
      IDEMPOTENT_ERRORS.vmNotRunning,
    ),
  );
});

// --- Network lifecycle idempotency (issue umag/swamp-workspace#1) ---
// Real virsh strings captured live on host 192.168.88.242:
//   net-start on an already-active network:
//     "error: Requested operation is not valid: network is already active"
//   net-destroy on an inactive network:
//     "error: Requested operation is not valid: network 'routed' is not active"

Deno.test("network start is a no-op on an already-active network", () => {
  assert(
    isIdempotent(
      {
        code: 1,
        stdout: "",
        stderr:
          "error: Failed to start network routed\nerror: Requested operation is not valid: network is already active",
      },
      IDEMPOTENT_ERRORS.networkAlreadyActive,
    ),
  );
});

Deno.test("network stop is a no-op on an already-inactive network", () => {
  assert(
    isIdempotent(
      {
        code: 1,
        stdout: "",
        stderr:
          "error: Failed to destroy network routed\nerror: Requested operation is not valid: network 'routed' is not active",
      },
      IDEMPOTENT_ERRORS.networkNotActive,
    ),
  );
});

Deno.test("networkNotActive does not swallow a VM 'domain is not running'", () => {
  assertEquals(
    isIdempotent(
      {
        code: 1,
        stdout: "",
        stderr:
          "error: Requested operation is not valid: domain is not running",
      },
      IDEMPOTENT_ERRORS.networkNotActive,
    ),
    false,
  );
});
