// Failing-first (TDD RED) tests for scripts/release_watch.ts — the resolver
// that reads each extension's `<ext>/quality.yaml` `watch:` block and
// compares pinned/baseline upstream references against the live source.
//
// Every upstream response is treated as UNTRUSTED input: safeParse'd, fetched
// with a bounded AbortSignal.timeout, and 5xx/timeout/malformed responses
// resolve to "unreachable" (warn, no drift) — never a false "drift".
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type {
  GithubReleaseWatchSource,
  NpmWatchSource,
} from "./lib/watch_schema.ts";
import {
  buildDriftReports,
  discoverExtensionsWithQuality,
  issueTitleFor,
  parsePinFromSource,
  resolveExtensionWatch,
  resolveGithubReleaseSource,
  resolveHttpFingerprintSource,
  resolveNpmSource,
  resolveOpenapiHashSource,
} from "./release_watch.ts";

function fakeFetch(
  handler: (
    url: string,
  ) => { ok: boolean; status: number; json?: unknown; text?: string },
): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const res = handler(url);
    return Promise.resolve({
      ok: res.ok,
      status: res.status,
      json: () => {
        if (res.json === undefined) {
          return Promise.reject(new Error("no json body configured"));
        }
        return Promise.resolve(res.json);
      },
      text: () => Promise.resolve(res.text ?? ""),
    } as Response);
  }) as typeof fetch;
}

function rejectingFetch(err: unknown): typeof fetch {
  return (() => Promise.reject(err)) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// parsePinFromSource
// ---------------------------------------------------------------------------

Deno.test("parsePinFromSource: extracts the capture group from a real file", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/src.ts`;
  await Deno.writeTextFile(path, 'import x from "npm:mppx@0.8.12";\n');
  try {
    const pin = await parsePinFromSource(
      path,
      String.raw`npm:mppx@([0-9][^/"]*)`,
      true,
    );
    assertEquals(pin, "0.8.12");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parsePinFromSource: required=true throws when the pattern does not match", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/src.ts`;
  await Deno.writeTextFile(path, "no pin here\n");
  try {
    await assertRejects(() =>
      parsePinFromSource(path, String.raw`npm:mppx@([0-9][^/"]*)`, true)
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parsePinFromSource: required=false returns undefined when the pattern does not match", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/src.ts`;
  await Deno.writeTextFile(path, "no pin here\n");
  try {
    const pin = await parsePinFromSource(
      path,
      String.raw`linkCliVersion.*default\("([0-9][^"]*)"`,
      false,
    );
    assertEquals(pin, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parsePinFromSource: survives an embedded NUL byte + multibyte em-dash (2026-07-13 grep -a C-locale regression)", async () => {
  // Reproduces the exact pathology observed in stripe-mpp/extensions/models/
  // stripe_mpp.ts in production: a stray NUL byte plus multibyte UTF-8
  // (em-dash, —) makes `file(1)` classify the source as "data" and a
  // plain `grep` (without -a) silently return zero matches. The resolver
  // must use Deno.readTextFile — never shell out to grep — so this must pass.
  const dir = await Deno.makeTempDir();
  const path = `${dir}/stripe_mpp_like.ts`;
  const encoder = new TextEncoder();
  const before = encoder.encode(
    "/** Uses mppx — the reference lib — co-maintained upstream. */\n",
  );
  const after = encoder.encode('import { x } from "npm:mppx@0.8.12";\n');
  const withNul = new Uint8Array(before.length + 1 + after.length);
  withNul.set(before, 0);
  withNul[before.length] = 0; // the invisible control byte
  withNul.set(after, before.length + 1);
  await Deno.writeFile(path, withNul);
  try {
    const pin = await parsePinFromSource(
      path,
      String.raw`npm:mppx@([0-9][^/"]*)`,
      true,
    );
    assertEquals(pin, "0.8.12");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// resolveNpmSource
// ---------------------------------------------------------------------------

function npmSourceFixture(
  overrides: Partial<NpmWatchSource> = {},
): NpmWatchSource {
  return {
    kind: "npm",
    package: "mppx",
    channel: "latest",
    pin: {
      from: "source",
      file: "",
      pattern: String.raw`npm:mppx@([0-9][^/"]*)`,
      required: true,
    },
    ...overrides,
  } as NpmWatchSource;
}

async function withPinFile(
  pinLine: string,
  fn: (path: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/src.ts`;
  await Deno.writeTextFile(path, pinLine);
  try {
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("resolveNpmSource: drift when the pin is behind the dist-tag", async () => {
  await withPinFile('import x from "npm:mppx@0.8.11";\n', async (file) => {
    const source = npmSourceFixture({
      pin: {
        from: "source",
        file,
        pattern: String.raw`npm:mppx@([0-9][^/"]*)`,
        required: true,
      },
    });
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: { "dist-tags": { latest: "0.8.12" } },
    }));
    const result = await resolveNpmSource(source, { fetchImpl });
    assertEquals(result.status, "drift");
  });
});

Deno.test("resolveNpmSource: ok when the pin matches the dist-tag", async () => {
  await withPinFile('import x from "npm:mppx@0.8.12";\n', async (file) => {
    const source = npmSourceFixture({
      pin: {
        from: "source",
        file,
        pattern: String.raw`npm:mppx@([0-9][^/"]*)`,
        required: true,
      },
    });
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: { "dist-tags": { latest: "0.8.12" } },
    }));
    const result = await resolveNpmSource(source, { fetchImpl });
    assertEquals(result.status, "ok");
  });
});

Deno.test("resolveNpmSource: channel fallback used when the primary channel tag is absent (stripe public-preview -> beta)", async () => {
  await withPinFile(
    'import Stripe from "npm:stripe@22.4.0-beta.1";\n',
    async (file) => {
      const source: NpmWatchSource = {
        kind: "npm",
        package: "stripe",
        channel: "public-preview",
        channelFallback: "beta",
        pin: {
          from: "source",
          file,
          pattern: String.raw`npm:stripe@([0-9][^"]*)`,
          required: true,
        },
      };
      const fetchImpl = fakeFetch(() => ({
        ok: true,
        status: 200,
        // no "public-preview" tag published — must fall back to "beta"
        json: { "dist-tags": { latest: "23.0.0", beta: "22.4.0-beta.1" } },
      }));
      const result = await resolveNpmSource(source, { fetchImpl });
      assertEquals(result.status, "ok");
    },
  );
});

Deno.test("resolveNpmSource: optional pin absent from source is skipped, not unreachable/drift", async () => {
  await withPinFile("no link-cli pin here\n", async (file) => {
    const source: NpmWatchSource = {
      kind: "npm",
      package: "@stripe/link-cli",
      channel: "latest",
      pin: {
        from: "source",
        file,
        pattern: String.raw`linkCliVersion.*default\("([0-9][^"]*)"`,
        required: false,
      },
    };
    const fetchImpl = fakeFetch(() => {
      throw new Error("must not fetch when the optional pin is absent");
    });
    const result = await resolveNpmSource(source, { fetchImpl });
    assertEquals(result.status, "skipped");
  });
});

Deno.test("resolveNpmSource: 5xx upstream response resolves to unreachable, never drift", async () => {
  await withPinFile('import x from "npm:mppx@0.8.12";\n', async (file) => {
    const source = npmSourceFixture({
      pin: {
        from: "source",
        file,
        pattern: String.raw`npm:mppx@([0-9][^/"]*)`,
        required: true,
      },
    });
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 503 }));
    const result = await resolveNpmSource(source, { fetchImpl });
    assertEquals(result.status, "unreachable");
  });
});

Deno.test("resolveNpmSource: network failure / timeout resolves to unreachable, never drift", async () => {
  await withPinFile('import x from "npm:mppx@0.8.12";\n', async (file) => {
    const source = npmSourceFixture({
      pin: {
        from: "source",
        file,
        pattern: String.raw`npm:mppx@([0-9][^/"]*)`,
        required: true,
      },
    });
    const fetchImpl = rejectingFetch(
      new DOMException("timed out", "AbortError"),
    );
    const result = await resolveNpmSource(source, { fetchImpl });
    assertEquals(result.status, "unreachable");
  });
});

Deno.test("resolveNpmSource: malformed registry JSON resolves to unreachable, never throws", async () => {
  await withPinFile('import x from "npm:mppx@0.8.12";\n', async (file) => {
    const source = npmSourceFixture({
      pin: {
        from: "source",
        file,
        pattern: String.raw`npm:mppx@([0-9][^/"]*)`,
        required: true,
      },
    });
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: { unexpected: "shape" },
    }));
    const result = await resolveNpmSource(source, { fetchImpl });
    assertEquals(result.status, "unreachable");
  });
});

Deno.test("resolveNpmSource: required pin missing from source throws (local config bug, not upstream)", async () => {
  await withPinFile("nothing pinned here\n", async (file) => {
    const source = npmSourceFixture({
      pin: {
        from: "source",
        file,
        pattern: String.raw`npm:mppx@([0-9][^/"]*)`,
        required: true,
      },
    });
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: { "dist-tags": { latest: "0.8.12" } },
    }));
    await assertRejects(() => resolveNpmSource(source, { fetchImpl }));
  });
});

// ---------------------------------------------------------------------------
// resolveGithubReleaseSource
// ---------------------------------------------------------------------------

function ghSourceFixture(
  overrides: Partial<GithubReleaseWatchSource> = {},
): GithubReleaseWatchSource {
  return {
    kind: "github-release",
    repo: "pi-hole/FTL",
    baseline: "v6.0.0",
    match: "latest-published",
    includePrerelease: false,
    ...overrides,
  };
}

// Default path (match=latest-published, includePrerelease=false) hits
// GET /repos/{repo}/releases/latest — a single object, and BY DEFINITION
// already excludes prereleases/drafts (no pagination concern at all for the
// common case). The list endpoint `/releases` is used only when the request
// genuinely needs to enumerate multiple releases (includePrerelease=true, or
// match=highest-semver) — bounded to a 3-page cap (see the pagination test).

Deno.test("resolveGithubReleaseSource: ok when baseline matches the latest published release (via /releases/latest)", async () => {
  const source = ghSourceFixture();
  const fetchImpl = fakeFetch((url) => {
    assert(
      url.endsWith("/releases/latest"),
      `expected /releases/latest, got ${url}`,
    );
    return {
      ok: true,
      status: 200,
      json: {
        tag_name: "v6.0.0",
        prerelease: false,
        draft: false,
        created_at: "2026-01-01T00:00:00Z",
      },
    };
  });
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "ok");
});

Deno.test("resolveGithubReleaseSource: drift when a newer release has shipped (via /releases/latest)", async () => {
  const source = ghSourceFixture();
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: {
      tag_name: "v6.1.0",
      prerelease: false,
      draft: false,
      created_at: "2026-02-01T00:00:00Z",
    },
  }));
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "drift");
});

Deno.test("resolveGithubReleaseSource: 404 from /releases/latest (no stable release yet) resolves to unreachable", async () => {
  const source = ghSourceFixture();
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 404 }));
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "unreachable");
});

Deno.test("resolveGithubReleaseSource: 5xx from /releases/latest resolves to unreachable, never drift", async () => {
  const source = ghSourceFixture();
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 502 }));
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "unreachable");
});

Deno.test("resolveGithubReleaseSource: malformed JSON from /releases/latest resolves to unreachable", async () => {
  const source = ghSourceFixture();
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: { not: "a release" },
  }));
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "unreachable");
});

Deno.test("resolveGithubReleaseSource: match=highest-semver excludes prereleases and drafts when includePrerelease=false (via list endpoint)", async () => {
  const source = ghSourceFixture({
    match: "highest-semver",
    baseline: "v6.0.0",
  });
  const fetchImpl = fakeFetch((url) => {
    assert(
      url.includes("/releases?"),
      `expected the list endpoint, got ${url}`,
    );
    return {
      ok: true,
      status: 200,
      json: [
        {
          tag_name: "v6.1.0-rc1",
          prerelease: true,
          draft: false,
          created_at: "2026-03-01T00:00:00Z",
        },
        {
          tag_name: "v6.2.0-draft",
          prerelease: false,
          draft: true,
          created_at: "2026-02-15T00:00:00Z",
        },
        {
          tag_name: "v6.0.0",
          prerelease: false,
          draft: false,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };
  });
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "ok");
});

Deno.test("resolveGithubReleaseSource: includePrerelease=true considers prereleases (via list endpoint)", async () => {
  const source = ghSourceFixture({ includePrerelease: true });
  const fetchImpl = fakeFetch((url) => {
    assert(
      url.includes("/releases?"),
      `expected the list endpoint, got ${url}`,
    );
    return {
      ok: true,
      status: 200,
      json: [
        {
          tag_name: "v6.1.0-rc1",
          prerelease: true,
          draft: false,
          created_at: "2026-03-01T00:00:00Z",
        },
        {
          tag_name: "v6.0.0",
          prerelease: false,
          draft: false,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };
  });
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "drift");
});

Deno.test("resolveGithubReleaseSource: match=highest-semver picks the numerically highest tag regardless of API order (via list endpoint)", async () => {
  const source = ghSourceFixture({
    match: "highest-semver",
    baseline: "v6.2.0",
  });
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: [
      {
        tag_name: "v6.1.9",
        prerelease: false,
        draft: false,
        created_at: "2026-03-01T00:00:00Z",
      },
      {
        tag_name: "v6.2.0",
        prerelease: false,
        draft: false,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  }));
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "ok");
});

Deno.test("resolveGithubReleaseSource: 5xx from the list endpoint resolves to unreachable", async () => {
  const source = ghSourceFixture({ match: "highest-semver" });
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 502 }));
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "unreachable");
});

Deno.test("resolveGithubReleaseSource: malformed JSON from the list endpoint resolves to unreachable", async () => {
  const source = ghSourceFixture({ match: "highest-semver" });
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: { not: "an array" },
  }));
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "unreachable");
});

Deno.test("resolveGithubReleaseSource: network failure resolves to unreachable", async () => {
  const source = ghSourceFixture();
  const fetchImpl = rejectingFetch(new TypeError("network down"));
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "unreachable");
});

Deno.test("resolveGithubReleaseSource: paginates the list endpoint up to a bounded 3-page cap", async () => {
  const source = ghSourceFixture({
    match: "highest-semver",
    baseline: "v9.0.0",
  });
  const requestedPages: number[] = [];
  const perPage = 100;
  const fetchImpl = fakeFetch((url) => {
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    requestedPages.push(page);
    // Every page is completely full (perPage items) so the resolver keeps
    // paginating until it hits the 3-page cap, never because a short page
    // signalled "no more data".
    const json = Array.from({ length: perPage }, (_, i) => ({
      tag_name: `v1.${page}.${i}`,
      prerelease: false,
      draft: false,
      created_at: "2020-01-01T00:00:00Z",
    }));
    if (page === 2) {
      // The true highest version lives on page 2, inside the 3-page cap.
      json[0] = {
        tag_name: "v9.0.0",
        prerelease: false,
        draft: false,
        created_at: "2020-01-01T00:00:00Z",
      };
    }
    if (page === 4) {
      // A page-4-only release must NEVER be seen — the cap stops at page 3.
      json[0] = {
        tag_name: "v99.0.0",
        prerelease: false,
        draft: false,
        created_at: "2020-01-01T00:00:00Z",
      };
    }
    return { ok: true, status: 200, json };
  });
  const result = await resolveGithubReleaseSource(source, { fetchImpl });
  assertEquals(result.status, "ok"); // found v9.0.0 within the 3-page cap
  assertEquals(requestedPages, [1, 2, 3]); // page 4 never requested
});

Deno.test("resolveGithubReleaseSource: passes an Authorization header when githubToken is provided", async () => {
  const source = ghSourceFixture();
  let capturedAuth: string | null = null;
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    capturedAuth =
      (init?.headers as Record<string, string> | undefined)?.Authorization ??
        null;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          tag_name: "v6.0.0",
          prerelease: false,
          draft: false,
          created_at: "2026-01-01T00:00:00Z",
        }),
    } as Response);
  }) as typeof fetch;
  await resolveGithubReleaseSource(source, {
    fetchImpl,
    githubToken: "ghp_test123",
  });
  assertEquals(capturedAuth, "Bearer ghp_test123");
});

// ---------------------------------------------------------------------------
// resolveHttpFingerprintSource
// ---------------------------------------------------------------------------

Deno.test("resolveHttpFingerprintSource: ok when the normalized-body hash matches baseline", async () => {
  const body = '<html><body><div id="plans">Pro plan $9</div></body></html>';
  const { sha256Hex } = await import("./release_watch.ts");
  const baseline = await sha256Hex("Pro plan $9");
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, text: body }));
  const result = await resolveHttpFingerprintSource(
    {
      kind: "http-fingerprint",
      url: "https://example.com/pricing",
      selector: "#plans",
      baselineSha256: baseline,
    },
    { fetchImpl },
  );
  assertEquals(result.status, "ok");
});

Deno.test("resolveHttpFingerprintSource: drift when the fingerprint changes", async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    text: '<html><body><div id="plans">Pro plan $19</div></body></html>',
  }));
  const result = await resolveHttpFingerprintSource(
    {
      kind: "http-fingerprint",
      url: "https://example.com/pricing",
      selector: "#plans",
      baselineSha256: "0".repeat(64),
    },
    { fetchImpl },
  );
  assertEquals(result.status, "drift");
});

Deno.test("resolveHttpFingerprintSource: 5xx resolves to unreachable", async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 500 }));
  const result = await resolveHttpFingerprintSource(
    {
      kind: "http-fingerprint",
      url: "https://example.com/pricing",
      baselineSha256: "0".repeat(64),
    },
    { fetchImpl },
  );
  assertEquals(result.status, "unreachable");
});

Deno.test("resolveHttpFingerprintSource: selector no longer matching the page is unreachable, not drift", async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    text: '<html><body><div id="other">moved</div></body></html>',
  }));
  const result = await resolveHttpFingerprintSource(
    {
      kind: "http-fingerprint",
      url: "https://example.com/pricing",
      selector: "#plans",
      baselineSha256: "0".repeat(64),
    },
    { fetchImpl },
  );
  assertEquals(result.status, "unreachable");
});

Deno.test("resolveHttpFingerprintSource: defense-in-depth — re-enforces the SSRF guard even if called directly with a disallowed URL (bypassing schema parse)", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("must not fetch a disallowed host");
  });
  await assertRejects(() =>
    resolveHttpFingerprintSource(
      {
        kind: "http-fingerprint",
        url: "https://169.254.169.254/latest/meta-data/",
        baselineSha256: "0".repeat(64),
      },
      { fetchImpl },
    )
  );
});

// ---------------------------------------------------------------------------
// resolveOpenapiHashSource — schema-validated, resolver DEFERRED to Phase C
// ---------------------------------------------------------------------------

Deno.test("resolveOpenapiHashSource: defense-in-depth — re-enforces the SSRF guard even if called directly with a disallowed specUrl (bypassing schema parse)", async () => {
  await assertRejects(() =>
    resolveOpenapiHashSource({
      kind: "openapi-hash",
      specUrl: "https://127.0.0.1/openapi.json",
      baselineSha256: "0".repeat(64),
    })
  );
});

Deno.test("resolveOpenapiHashSource: always deferred, never fetches", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("openapi-hash must not fetch in Phase B");
  });
  const result = await resolveOpenapiHashSource(
    {
      kind: "openapi-hash",
      specUrl: "https://example.com/openapi.json",
      baselineSha256: "0".repeat(64),
    },
    { fetchImpl },
  );
  assertEquals(result.status, "deferred");
});

// ---------------------------------------------------------------------------
// issueTitleFor — single source of truth for the stable per-extension title
// ---------------------------------------------------------------------------

Deno.test("issueTitleFor: stable '<ext>: upstream release drift' format", () => {
  assertEquals(
    issueTitleFor("stripe-mpp"),
    "stripe-mpp: upstream release drift",
  );
});

// ---------------------------------------------------------------------------
// resolveExtensionWatch + discovery + full pipeline
// ---------------------------------------------------------------------------

Deno.test("resolveExtensionWatch: state=na produces a report with no results and no drift", async () => {
  const report = await resolveExtensionWatch(
    "demo-ext",
    { state: "na", justification: "no upstream" },
    {},
  );
  assertEquals(report.hasDrift, false);
  assertEquals(report.results.length, 0);
});

Deno.test("resolveExtensionWatch: aggregates multiple sources and flags hasDrift", async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: { "dist-tags": { latest: "9.9.9" } },
  }));
  await withPinFile('import x from "npm:demo@1.0.0";\n', async (file) => {
    const report = await resolveExtensionWatch(
      "demo-ext",
      {
        state: "present",
        issueLabel: "demo-ext-release-watch",
        sources: [
          {
            kind: "npm",
            package: "demo",
            channel: "latest",
            pin: {
              from: "source",
              file,
              pattern: String.raw`npm:demo@([0-9][^"]*)`,
              required: true,
            },
          },
        ],
      },
      { fetchImpl },
    );
    assertEquals(report.hasDrift, true);
    assertEquals(report.issueTitle, "demo-ext: upstream release drift");
  });
});

Deno.test("discoverExtensionsWithQuality: finds only top-level dirs with a quality.yaml", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/ext-a`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-a/quality.yaml`,
      "watch:\n  state: na\n  justification: x\n",
    );
    await Deno.mkdir(`${root}/ext-b`, { recursive: true });
    // no quality.yaml in ext-b — not yet migrated onto Phase A's schema
    await Deno.mkdir(`${root}/not-an-ext`, { recursive: true });
    const found = await discoverExtensionsWithQuality(root);
    assertEquals(found, ["ext-a"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildDriftReports: end-to-end over a synthetic root with mixed present/na extensions", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/ext-drift/extensions/models`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${root}/ext-drift/extensions/models/demo.ts`,
      'import x from "npm:demo@1.0.0";\n',
    );
    await Deno.writeTextFile(
      `${root}/ext-drift/quality.yaml`,
      [
        "watch:",
        "  state: present",
        "  issueLabel: ext-drift-release-watch",
        "  sources:",
        "    - kind: npm",
        "      package: demo",
        "      channel: latest",
        "      pin:",
        "        from: source",
        "        file: extensions/models/demo.ts",
        "        pattern: 'npm:demo@([0-9][^\"]*)'",
        "        required: true",
        "",
      ].join("\n"),
    );
    await Deno.mkdir(`${root}/ext-quiet`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-quiet/quality.yaml`,
      "watch:\n  state: na\n  justification: nothing upstream\n",
    );

    const fetchImpl = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: { "dist-tags": { latest: "2.0.0" } },
    }));
    const reports = await buildDriftReports(root, { fetchImpl });
    const drift = reports.find((r) => r.extension === "ext-drift");
    const quiet = reports.find((r) => r.extension === "ext-quiet");
    assert(drift);
    assert(quiet);
    assertEquals(drift.hasDrift, true);
    assertEquals(quiet.hasDrift, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildDriftReports: one extension's malformed quality.yaml does not abort the run for the others (per-extension error isolation)", async () => {
  const root = await Deno.makeTempDir();
  try {
    // ext-broken has a quality.yaml that fails watch_schema validation
    // entirely (missing required issueLabel for state=present).
    await Deno.mkdir(`${root}/ext-broken`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-broken/quality.yaml`,
      "watch:\n  state: present\n  sources:\n    - kind: npm\n      package: x\n      pin: {from: source, file: x.ts, pattern: 'x@([0-9]+)'}\n",
    );
    // ext-healthy is a normal, valid, state=na extension.
    await Deno.mkdir(`${root}/ext-healthy`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-healthy/quality.yaml`,
      "watch:\n  state: na\n  justification: nothing upstream\n",
    );

    const reports = await buildDriftReports(root, {});
    const healthy = reports.find((r) => r.extension === "ext-healthy");
    const broken = reports.find((r) => r.extension === "ext-broken");
    assert(healthy, "ext-healthy must still be processed and reported");
    assertEquals(healthy.hasDrift, false);
    assert(broken, "ext-broken must still appear in the report set");
    assert(
      typeof broken.loadError === "string" && broken.loadError.length > 0,
      "ext-broken must carry a loadError explaining why it could not be resolved",
    );
    assertEquals(broken.hasDrift, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
