import { assertEquals } from "jsr:@std/assert@1";
import { ConfigSchema, type MongoDatastoreConfig, tierRoot } from "./config.ts";

function cfg(namespace: string): MongoDatastoreConfig {
  return ConfigSchema.parse({
    uri: "mongodb://localhost:27017/?replicaSet=rs0",
    username: "swamp",
    namespace,
  });
}

// The whole point of tierRoot: core hands the sync service the bare cache path
// but reads the tier at {cache}/{namespace}/..., so anything the sync service
// walks or writes has to be rooted one segment deeper (swamp-club#1458, #1554).
Deno.test("tierRoot appends the namespace as the outermost segment", () => {
  assertEquals(
    tierRoot(cfg("dev-tmp-swamp"), "/cache/repos/abc"),
    "/cache/repos/abc/dev-tmp-swamp",
  );
});

Deno.test("tierRoot leaves an empty namespace as solo mode (bare cache path)", () => {
  assertEquals(tierRoot(cfg(""), "/cache/repos/abc"), "/cache/repos/abc");
});

Deno.test("tierRoot treats a whitespace-only namespace as solo mode", () => {
  assertEquals(tierRoot(cfg("   "), "/cache/repos/abc"), "/cache/repos/abc");
});

Deno.test("tierRoot does not double the separator on a trailing slash", () => {
  assertEquals(
    tierRoot(cfg("ns"), "/cache/repos/abc/"),
    "/cache/repos/abc/ns",
  );
  assertEquals(
    tierRoot(cfg("ns"), "/cache/repos/abc///"),
    "/cache/repos/abc/ns",
  );
});

// A tier-relative path joined onto the root must reproduce exactly what core's
// DefaultDatastorePathResolver.datastorePath() builds, since both sides have to
// agree on where a given artifact lives.
Deno.test("tierRoot composes with a tier-relative path the way core reads it", () => {
  const root = tierRoot(cfg("dev-tmp-swamp"), "/cache/repos/abc");
  assertEquals(
    `${root}/data/@magistr/spotify-data/id/spotify.2023/5/raw`,
    "/cache/repos/abc/dev-tmp-swamp/data/@magistr/spotify-data/id/spotify.2023/5/raw",
  );
});

// Remote _ids stay tier-relative — this extension partitions by collection
// prefix, so a namespace leaking into the stored path would orphan every blob.
Deno.test("tierRoot does not alter the namespace used for collection prefixing", () => {
  const c = cfg("dev-tmp-swamp");
  tierRoot(c, "/cache/repos/abc");
  assertEquals(c.namespace, "dev-tmp-swamp");
});
