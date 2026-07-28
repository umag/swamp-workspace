// Failing-first (TDD RED) tests for scripts/lib/watch_schema.ts.
//
// watch_schema.ts is the single executable contract for the `watch:` block
// that lives inside each extension's `<ext>/quality.yaml` (approved amendment:
// there is no standalone watch.yaml — Phase A owns the rest of quality.yaml
// and treats `watch.sources[]` as passthrough; this module owns its deep
// validation).
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  assertPublicHttpsUrl,
  DEFERRED_RESOLVER_KINDS,
  hasCaptureGroup,
  isResolverDeferred,
  loadQualityWatch,
  parseWatchDeclaration,
  WatchDeclarationSchema,
  WatchSchemaError,
  WatchSourceSchema,
} from "./watch_schema.ts";

// ---------------------------------------------------------------------------
// WatchSourceSchema — the four-kind discriminated union
// ---------------------------------------------------------------------------

const validNpm = {
  kind: "npm",
  package: "mppx",
  channel: "latest",
  pin: {
    from: "source",
    file: "extensions/models/stripe_mpp.ts",
    pattern: String.raw`npm:mppx@([0-9][^/"]*)`,
    required: true,
  },
};

const validGithubRelease = {
  kind: "github-release",
  repo: "pi-hole/FTL",
  baseline: "v6.0.0",
  match: "latest-published",
  includePrerelease: false,
};

const validHttpFingerprint = {
  kind: "http-fingerprint",
  url: "https://example.com/pricing",
  selector: "#plans",
  baselineSha256: "a".repeat(64),
};

const validOpenapiHash = {
  kind: "openapi-hash",
  specUrl: "https://example.com/openapi.json",
  baselineSha256: "b".repeat(64),
};

Deno.test("WatchSourceSchema: parses a valid npm source", () => {
  const parsed = WatchSourceSchema.parse(validNpm);
  assertEquals(parsed.kind, "npm");
});

Deno.test("WatchSourceSchema: parses a valid github-release source", () => {
  const parsed = WatchSourceSchema.parse(validGithubRelease);
  assertEquals(parsed.kind, "github-release");
});

Deno.test("WatchSourceSchema: parses a valid http-fingerprint source", () => {
  const parsed = WatchSourceSchema.parse(validHttpFingerprint);
  assertEquals(parsed.kind, "http-fingerprint");
});

Deno.test("WatchSourceSchema: parses a valid openapi-hash source", () => {
  const parsed = WatchSourceSchema.parse(validOpenapiHash);
  assertEquals(parsed.kind, "openapi-hash");
});

Deno.test("isResolverDeferred: openapi-hash is deferred to Phase C, others are not", () => {
  assert(isResolverDeferred("openapi-hash"));
  assert(!isResolverDeferred("npm"));
  assert(!isResolverDeferred("github-release"));
  assert(!isResolverDeferred("http-fingerprint"));
  assert(DEFERRED_RESOLVER_KINDS.has("openapi-hash"));
  assertEquals(DEFERRED_RESOLVER_KINDS.size, 1);
});

Deno.test("WatchSourceSchema: rejects an unknown kind", () => {
  const result = WatchSourceSchema.safeParse({
    kind: "ftp-poll",
    url: "https://example.com",
  });
  assert(!result.success);
});

Deno.test("WatchSourceSchema: rejects npm source missing package", () => {
  const { package: _drop, ...rest } = validNpm;
  const result = WatchSourceSchema.safeParse(rest);
  assert(!result.success);
});

Deno.test("WatchSourceSchema: rejects github-release source missing baseline", () => {
  const { baseline: _drop, ...rest } = validGithubRelease;
  const result = WatchSourceSchema.safeParse(rest);
  assert(!result.success);
});

Deno.test("WatchSourceSchema: rejects github-release repo not shaped owner/repo", () => {
  const result = WatchSourceSchema.safeParse({
    ...validGithubRelease,
    repo: "not-a-repo-slug",
  });
  assert(!result.success);
});

Deno.test("WatchSourceSchema: rejects http-fingerprint with a plain http:// url", () => {
  const result = WatchSourceSchema.safeParse({
    ...validHttpFingerprint,
    url: "http://example.com/pricing",
  });
  assert(!result.success);
});

Deno.test("WatchSourceSchema: rejects openapi-hash with a plain http:// specUrl", () => {
  const result = WatchSourceSchema.safeParse({
    ...validOpenapiHash,
    specUrl: "http://example.com/openapi.json",
  });
  assert(!result.success);
});

const SSRF_HOSTS = [
  "http://localhost/x".replace("http", "https"),
  "https://127.0.0.1/x",
  "https://127.5.5.5/x",
  "https://0.0.0.0/x",
  "https://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
  "https://10.0.0.5/x",
  "https://172.16.0.5/x",
  "https://172.31.255.255/x",
  "https://192.168.1.1/x",
  "https://[::1]/x",
  "https://[fe80::1]/x",
  "https://[fc00::1]/x",
  "https://metadata.google.internal/computeMetadata/v1/",
  "https://foo.internal/x",
  "https://2130706433/x", // decimal-encoded 127.0.0.1
  "https://0x7f000001/x", // hex-encoded 127.0.0.1
];

for (const url of SSRF_HOSTS) {
  Deno.test(`WatchSourceSchema: rejects http-fingerprint SSRF-guarded host ${url}`, () => {
    const result = WatchSourceSchema.safeParse({
      ...validHttpFingerprint,
      url,
    });
    assert(!result.success, `expected ${url} to be rejected`);
  });
}

Deno.test("WatchSourceSchema: accepts a normal public https url for http-fingerprint", () => {
  const result = WatchSourceSchema.safeParse(validHttpFingerprint);
  assert(result.success);
});

Deno.test("WatchSourceSchema: rejects pin.pattern with no capture group", () => {
  const result = WatchSourceSchema.safeParse({
    ...validNpm,
    pin: { ...validNpm.pin, pattern: "npm:mppx@latest" },
  });
  assert(!result.success);
});

Deno.test("WatchSourceSchema: rejects pin.pattern that is not a valid regex", () => {
  const result = WatchSourceSchema.safeParse({
    ...validNpm,
    pin: { ...validNpm.pin, pattern: "(unterminated" },
  });
  assert(!result.success);
});

Deno.test("hasCaptureGroup: true for a pattern with one capture group", () => {
  assert(hasCaptureGroup(String.raw`npm:mppx@([0-9][^/"]*)`));
});

Deno.test("hasCaptureGroup: false for a pattern with only non-capturing groups", () => {
  assert(!hasCaptureGroup(String.raw`npm:mppx@(?:latest)`));
});

Deno.test("hasCaptureGroup: false for a pattern with no groups at all", () => {
  assert(!hasCaptureGroup("npm:mppx@latest"));
});

Deno.test("hasCaptureGroup: true even when an escaped paren precedes the real group", () => {
  assert(hasCaptureGroup(String.raw`\(literal\) npm:mppx@([0-9.]+)`));
});

// ---------------------------------------------------------------------------
// assertPublicHttpsUrl — standalone SSRF guard (also exercised via the schema)
// ---------------------------------------------------------------------------

Deno.test("assertPublicHttpsUrl: accepts a normal public https url", () => {
  const url = assertPublicHttpsUrl("https://example.com/a", "test");
  assertEquals(url.hostname, "example.com");
});

Deno.test("assertPublicHttpsUrl: throws WatchSchemaError for non-https", () => {
  assertThrows(
    () => assertPublicHttpsUrl("http://example.com/a", "test"),
    WatchSchemaError,
  );
});

Deno.test("assertPublicHttpsUrl: throws WatchSchemaError for an invalid URL", () => {
  assertThrows(
    () => assertPublicHttpsUrl("not a url", "test"),
    WatchSchemaError,
  );
});

Deno.test("assertPublicHttpsUrl: throws WatchSchemaError for link-local metadata host", () => {
  assertThrows(
    () => assertPublicHttpsUrl("https://169.254.169.254/", "test"),
    WatchSchemaError,
  );
});

// ---------------------------------------------------------------------------
// WatchDeclarationSchema — the `watch:` block: {state, sources, issueLabel,
// justification?} per the approved amendment (decision 1).
// ---------------------------------------------------------------------------

Deno.test("WatchDeclarationSchema: parses state=present with sources + issueLabel", () => {
  const parsed = WatchDeclarationSchema.parse({
    state: "present",
    sources: [validNpm],
    issueLabel: "stripe-mpp-release-watch",
  });
  assertEquals(parsed.state, "present");
  if (parsed.state === "present") {
    assertEquals(parsed.sources.length, 1);
    assertEquals(parsed.issueLabel, "stripe-mpp-release-watch");
  }
});

Deno.test("WatchDeclarationSchema: parses state=na with justification", () => {
  const parsed = WatchDeclarationSchema.parse({
    state: "na",
    justification: "Pure local automation, no upstream dependency to watch.",
  });
  assertEquals(parsed.state, "na");
});

Deno.test("WatchDeclarationSchema: rejects state=na without justification", () => {
  const result = WatchDeclarationSchema.safeParse({ state: "na" });
  assert(!result.success);
});

Deno.test("WatchDeclarationSchema: rejects state=present with an empty sources array", () => {
  const result = WatchDeclarationSchema.safeParse({
    state: "present",
    sources: [],
    issueLabel: "x-release-watch",
  });
  assert(!result.success);
});

Deno.test("WatchDeclarationSchema: rejects state=present without issueLabel", () => {
  const result = WatchDeclarationSchema.safeParse({
    state: "present",
    sources: [validNpm],
  });
  assert(!result.success);
});

Deno.test("WatchDeclarationSchema: rejects an unknown state value", () => {
  const result = WatchDeclarationSchema.safeParse({
    state: "maybe",
    sources: [validNpm],
  });
  assert(!result.success);
});

Deno.test("parseWatchDeclaration: throws WatchSchemaError (not a raw ZodError) on invalid input", () => {
  assertThrows(
    () => parseWatchDeclaration({ state: "na" }),
    WatchSchemaError,
  );
});

// ---------------------------------------------------------------------------
// loadQualityWatch — reads `<ext>/quality.yaml`, extracts + validates `watch:`
// ---------------------------------------------------------------------------

Deno.test("loadQualityWatch: reads a fixture quality.yaml with state=present", async () => {
  const decl = await loadQualityWatch(
    "testdata/quality-present.yaml",
  );
  assertEquals(decl.state, "present");
  if (decl.state === "present") {
    assertEquals(decl.issueLabel, "demo-ext-release-watch");
    assertEquals(decl.sources.length, 1);
  }
});

Deno.test("loadQualityWatch: reads a fixture quality.yaml with state=na", async () => {
  const decl = await loadQualityWatch("testdata/quality-na.yaml");
  assertEquals(decl.state, "na");
});

Deno.test("loadQualityWatch: throws a descriptive error when the watch: key is missing", async () => {
  await assertRejects(
    () => loadQualityWatch("testdata/quality-missing-watch.yaml"),
    WatchSchemaError,
    "watch",
  );
});

Deno.test("loadQualityWatch: passthrough — ignores unrelated Phase A quality.yaml keys", async () => {
  // Phase A owns schemaVersion/extension/other CI-gate keys; this module must
  // not choke on their presence, only validate `watch:` deeply.
  const decl = await loadQualityWatch(
    "testdata/quality-present.yaml",
  );
  assert(decl.state === "present" || decl.state === "na");
});
