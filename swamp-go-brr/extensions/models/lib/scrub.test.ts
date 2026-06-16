// Tests for the pure, model-import-FREE lib/scrub.ts (issue gobrr-record-step-outputs).
// scrubSecrets was extracted from source_integration.ts and broadened with a
// high-precision secret-pattern set so docker-verify stdout (verifyTail) can be
// persisted safely. Contract:
//   export function scrubSecrets(text: string): string
// Invariant asserted: the RAW secret value is ABSENT from the output (we do not
// couple to the exact redaction marker); low-entropy/plain values are preserved.
import { scrubSecrets } from "./scrub.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("scrub redacts legacy Anthropic sk-ant tokens", () => {
  const raw = "sk-ant-abc123DEF456ghi789";
  const out = scrubSecrets(`leaked token=${raw} trailing`);
  assert(!out.includes(raw), "sk-ant token must be redacted");
});

Deno.test("scrub redacts Authorization/Bearer header values", () => {
  const out = scrubSecrets("Authorization: abcDEF1234567890xyz");
  assert(!out.includes("abcDEF1234567890xyz"), "bearer value must be redacted");
  // a structurally different (JWT-shaped) bearer value must also be redacted
  const jwt = scrubSecrets(
    "bearer eyJhbGciOiJIUzI1NiJ9.payload12345.signature678",
  );
  assert(
    !jwt.includes("eyJhbGciOiJIUzI1NiJ9"),
    "JWT header segment must be redacted",
  );
  assert(
    !jwt.includes("payload12345"),
    "the full JWT value must be redacted, not just the header",
  );
});

Deno.test("scrub redacts AWS access key ids (AKIA...)", () => {
  const raw = "AKIAIOSFODNN7EXAMPLE"; // AKIA + 16
  const out = scrubSecrets(`aws_access_key_id = ${raw}`);
  assert(!out.includes(raw), "AKIA key id must be redacted");
});

Deno.test("scrub redacts GitHub tokens (ghp_/gho_)", () => {
  const ghp = "ghp_" + "a1B2c3D4e5".repeat(3) + "abcdef"; // 36 alnum
  const gho = "gho_" + "Z9y8X7w6V5".repeat(3) + "uvwxyz"; // 36 alnum
  const out = scrubSecrets(`${ghp} then ${gho}`);
  assert(!out.includes(ghp), "ghp_ token must be redacted");
  assert(!out.includes(gho), "gho_ token must be redacted");
});

Deno.test("scrub redacts GitLab personal access tokens (glpat-)", () => {
  // prefix split across literals so GitHub push-protection doesn't flag the FIXTURE
  // as a live GitLab PAT; the runtime value is still glpat- + 20 chars.
  const raw = "gl" + "pat-" + "aB3dE6gH9jK2mN5pQ8sT";
  const out = scrubSecrets(`PRIVATE-TOKEN: ${raw}`);
  assert(!out.includes(raw), "glpat- token must be redacted");
});

Deno.test("scrub redacts GCP service-account private_key json", () => {
  const out = scrubSecrets('{"private_key":"SUPERSECRETKEYMATERIAL0001"}');
  assert(
    !out.includes("SUPERSECRETKEYMATERIAL0001"),
    "private_key body must be redacted",
  );
});

Deno.test("scrub redacts a generic high-entropy KEY=VALUE", () => {
  const out = scrubSecrets("api_key=Abc123xyz789def");
  assert(
    !out.includes("Abc123xyz789def"),
    "high-entropy api_key must be redacted",
  );
});

Deno.test("scrub PRECISION: plain low-entropy values are NOT redacted", () => {
  // short, letters-only → not a secret
  const o1 = scrubSecrets("password=foo");
  assert(o1.includes("foo"), "short plain word must be kept");
  // letters only, no digit → not high-entropy
  const o2 = scrubSecrets("token=examplevalue");
  assert(o2.includes("examplevalue"), "letters-only value must be kept");
  // mixed case + digits + long → redacted
  const o3 = scrubSecrets("password=Abc123xyz99");
  assert(!o3.includes("Abc123xyz99"), "high-entropy value must be redacted");
  // mid-entropy boundary (12 chars, mixed letters+digits) → still redacted (threshold not too lax)
  const o4 = scrubSecrets("token=Abc12345efgh");
  assert(!o4.includes("Abc12345efgh"), "mid-entropy value must be redacted");
});
