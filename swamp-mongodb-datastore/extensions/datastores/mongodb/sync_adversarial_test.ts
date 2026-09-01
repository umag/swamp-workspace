import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  isRawContentPath,
  isSafeRelPath,
  isSecretsPath,
  modelPrefixes,
  rawContentRegex,
  resolveWithinCache,
} from "./sync.ts";

// Adversarial suite: the network and the database are hostile.
//
// One MongoDB database holds every repo's tier; isolation is a collection
// prefix, not an account boundary. So a path doc's `_id` is attacker-influenced
// input that pull turns into a local filesystem write — and, when the doc
// carries `deletedAt`, into an unlink. These tests pin the guard that stands
// between a planted `_id` and the filesystem.

const CACHE = "/cache/repos/abc/dev-tmp-swamp";

Deno.test("resolveWithinCache refuses parent-directory escapes", () => {
  for (
    const evil of [
      "../evil",
      "../../etc/passwd",
      "data/../../../../.ssh/authorized_keys",
      "data/@magistr/../../../../tmp/pwned",
      "..",
      "../",
      "a/../../b",
    ]
  ) {
    assertThrows(
      () => resolveWithinCache(CACHE, evil),
      Error,
      "Refusing unsafe datastore path",
      `expected rejection for ${JSON.stringify(evil)}`,
    );
  }
});

Deno.test("resolveWithinCache refuses absolute paths", () => {
  for (const evil of ["/etc/passwd", "/", "//etc/shadow"]) {
    assertThrows(
      () => resolveWithinCache(CACHE, evil),
      Error,
      "Refusing unsafe datastore path",
      `expected rejection for ${JSON.stringify(evil)}`,
    );
  }
});

// A backslash is not a separator on POSIX, so `split("/")` walks straight past
// it; without an explicit check a Windows-style traversal would slip through.
Deno.test("resolveWithinCache refuses backslashes and NUL bytes", () => {
  for (
    const evil of [
      "..\\..\\windows\\system32",
      "data\\evil",
      "data/evil\0.txt",
      "\0",
    ]
  ) {
    assertThrows(
      () => resolveWithinCache(CACHE, evil),
      Error,
      "Refusing unsafe datastore path",
      `expected rejection for ${JSON.stringify(evil)}`,
    );
  }
});

Deno.test("resolveWithinCache refuses empty and empty-segment paths", () => {
  for (const evil of ["", "data//raw", "data/", "/data"]) {
    assertThrows(
      () => resolveWithinCache(CACHE, evil),
      Error,
      "Refusing unsafe datastore path",
      `expected rejection for ${JSON.stringify(evil)}`,
    );
  }
});

// The guard must not become so strict it rejects the tier's real paths — those
// carry dots inside segments, spaces, `@`, and unicode.
Deno.test("resolveWithinCache admits the legitimate paths this tier stores", () => {
  const ok = [
    "data/@magistr/spotify-data/56f906e3/spotify.2023/5/raw",
    "data/@adam/cfgmgmt/apt/2ec56715/192.168.88.18/3/metadata.yaml",
    "data/@anilist/api/31e8451a/3-gatsu no Lion/1/raw",
    "workflow-runs/2026-08-31/run.json",
    "data/@magistr/anime-cron/id/current/latest",
    "outputs/a.b.c",
  ];
  for (const relPath of ok) {
    assertEquals(
      resolveWithinCache(CACHE, relPath),
      `${CACHE}/${relPath}`,
      `expected ${JSON.stringify(relPath)} to be accepted`,
    );
  }
});

// A segment may CONTAIN dots; only a segment that IS "." or ".." is traversal.
Deno.test("isSafeRelPath distinguishes dotted names from dot segments", () => {
  assertEquals(isSafeRelPath("data/..evil/raw"), true);
  assertEquals(isSafeRelPath("data/evil../raw"), true);
  assertEquals(isSafeRelPath("data/.../raw"), true);
  assertEquals(isSafeRelPath("data/.hidden/raw"), true);
  assertEquals(isSafeRelPath("data/../raw"), false);
  assertEquals(isSafeRelPath("data/./raw"), false);
});

// The secrets tier must never round-trip, and the check must not be a loose
// prefix match that also swallows unrelated siblings.
Deno.test("isSecretsPath matches the tier without over-matching siblings", () => {
  assertEquals(isSecretsPath("secrets"), true);
  assertEquals(isSecretsPath("secrets/vault.key"), true);
  assertEquals(isSecretsPath("secrets/a/b.enc"), true);
  // Not the vault tier — must still sync.
  assertEquals(isSecretsPath("secretsfoo"), false);
  assertEquals(isSecretsPath("secrets-backup/x"), false);
  assertEquals(isSecretsPath("data/secrets/x"), false);
  assertEquals(isSecretsPath(""), false);
});

// A shared RegExp carries lastIndex; handing the same instance to successive
// queries would make matching depend on call order.
Deno.test("rawContentRegex hands out a fresh instance each call", () => {
  const a = rawContentRegex();
  const b = rawContentRegex();
  assertEquals(a === b, false);
  assertEquals(a.lastIndex, 0);
  assertEquals(a.source, b.source);
});

Deno.test("isRawContentPath matches only model content bytes", () => {
  assertEquals(isRawContentPath("data/@magistr/x/id/name/1/raw"), true);
  // Catalog files must survive a metadataOnly pull.
  assertEquals(
    isRawContentPath("data/@magistr/x/id/name/1/metadata.yaml"),
    false,
  );
  assertEquals(isRawContentPath("data/@magistr/x/id/name/latest"), false);
  // Outside the data tier entirely.
  assertEquals(isRawContentPath("outputs/raw"), false);
  assertEquals(isRawContentPath("raw"), false);
});

// modelPrefixes builds MongoDB query prefixes from caller-supplied model ids.
Deno.test("modelPrefixes is empty for empty or absent input", () => {
  assertEquals(modelPrefixes(undefined), []);
  assertEquals(modelPrefixes([]), []);
});

Deno.test("modelPrefixes anchors each prefix at the data tier with a trailing slash", () => {
  assertEquals(
    modelPrefixes([{ modelType: "@magistr/weather", modelId: "be01d528" }]),
    ["data/@magistr/weather/be01d528/"],
  );
  // Without the trailing slash, model id "abc" would also match "abcdef".
  const [prefix] = modelPrefixes([{ modelType: "t", modelId: "abc" }]);
  assertEquals(prefix.endsWith("/"), true);
  assertEquals("data/t/abcdef/x".startsWith(prefix), false);
});

// THE WIRING, not just the helper. Every test above exercises
// resolveWithinCache as a FUNCTION. None of them observes whether the pull
// path actually calls it — so reverting the call sites to raw concatenation
// while leaving the export in place keeps all of them green.
//
// That is not hypothetical: the upstream keeb 2026.08.19.2 tree composes
// `${cachePath}/${relPath}` directly at every site, and merging it verbatim
// left this whole suite passing with the confinement gone.
//
// Exercising the real call sites needs a live cluster, so this asserts over
// the source instead: outside the guard's own body, the only cache-path
// concatenation allowed is over DATASTORE_SUBDIRS, whose members are
// compile-time constants in this file rather than remote input.
Deno.test("every cache-path join over remote input goes through resolveWithinCache — no raw concatenation survives at a write site", async () => {
  const src = await Deno.readTextFile(new URL("./sync.ts", import.meta.url));
  const lines = src.split("\n");

  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (!line.includes("${cachePath}/")) return;
    // The guard's own return statement is the one legitimate join.
    if (line.includes("return `${cachePath}/${relPath}`;")) return;
    // Walking a fixed subdirectory: `sub` comes from DATASTORE_SUBDIRS, a
    // const tuple in this file, never from a remote document.
    if (line.includes("${cachePath}/${sub}")) return;
    offenders.push(`${i + 1}: ${line.trim()}`);
  });

  assertEquals(
    offenders,
    [],
    "raw cache-path concatenation found — a remote _id reaching one of these " +
      "escapes the cache root:\n" + offenders.join("\n"),
  );

  // Guard the guard: if the call sites were ever renamed away, the check above
  // would pass vacuously on a file that no longer confines anything.
  const callSites =
    lines.filter((l) => l.includes("resolveWithinCache(cachePath")).length;
  assertEquals(
    callSites >= 5,
    true,
    `expected at least 5 resolveWithinCache call sites, found ${callSites}`,
  );
});
