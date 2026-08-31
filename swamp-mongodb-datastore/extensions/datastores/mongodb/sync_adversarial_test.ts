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
