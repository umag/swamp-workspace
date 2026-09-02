import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { clientAppName, clientCacheKey } from "./client.ts";
import { ConfigSchema, type MongoDatastoreConfig } from "./config.ts";

function cfg(overrides: Record<string, unknown> = {}): MongoDatastoreConfig {
  return ConfigSchema.parse({
    uri: "mongodb://mongo.example.com:27017/?replicaSet=rs0",
    username: "svc-swamp",
    namespace: "example",
    ...overrides,
  });
}

Deno.test("cache key ignores tenant and namespace", () => {
  // Tenant and namespace select collections, not connections. Keying on them
  // would open a second pool per namespace for no reason.
  assertEquals(
    clientCacheKey(cfg({ namespace: "a", tenantId: "x" }), "/repo"),
    clientCacheKey(cfg({ namespace: "b", tenantId: "y" }), "/repo"),
  );
});

Deno.test("cache key separates clusters, credentials, databases, repos", () => {
  const base = clientCacheKey(cfg(), "/repo");
  for (
    const [label, other] of [
      [
        "uri",
        clientCacheKey(
          cfg({ uri: "mongodb://other.example.com:27017" }),
          "/repo",
        ),
      ],
      ["username", clientCacheKey(cfg({ username: "someone" }), "/repo")],
      ["database", clientCacheKey(cfg({ database: "other" }), "/repo")],
      ["repoDir", clientCacheKey(cfg(), "/other-repo")],
    ] as const
  ) {
    assertNotEquals(base, other, `${label} must not collide`);
  }
});

Deno.test("app name identifies tenant, namespace, and process", () => {
  const name = clientAppName(cfg({ tenantId: "keeb", namespace: "media" }));
  assertEquals(name, `swamp:keeb/media#${Deno.pid}`);
});

Deno.test("app name stays within mongodb's 128-byte limit", () => {
  const name = clientAppName(cfg({ namespace: "n".repeat(200) }));
  assertEquals(name.length, 128);
});

Deno.test("pool bounds are explicit and overridable", () => {
  const c = cfg();
  // This fork keeps its documented 500 ceiling (minPoolSize is 0, so the
  // bound is never pre-allocated); upstream keeb picks 20.
  assertEquals(c.maxPoolSize, 500);
  assertEquals(c.maxIdleTimeMS, 60_000);
  assertEquals(cfg({ maxPoolSize: 5 }).maxPoolSize, 5);
});
