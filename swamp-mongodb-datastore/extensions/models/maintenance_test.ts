import { assertEquals } from "jsr:@std/assert@1";
import {
  datastoreHost,
  model,
  namespaceFromCollection,
} from "./maintenance.ts";

Deno.test("datastoreHost never leaks credentials embedded in the URI", () => {
  // The whole point: a URI may carry user:pass@, and this string is logged.
  assertEquals(
    datastoreHost(
      "mongodb://alice:hunter2@db.example.com:27017/?replicaSet=rs0",
    ),
    "db.example.com:27017",
  );
  assertEquals(
    datastoreHost("mongodb+srv://svc:p%40ss@cluster.example.net/admin"),
    "cluster.example.net",
  );
  // No userinfo, no scheme, trailing query — all still reduce to host[:port].
  assertEquals(
    datastoreHost("mongodb://db.example.com:27017/?replicaSet=rs0"),
    "db.example.com:27017",
  );
  assertEquals(datastoreHost("db.example.com"), "db.example.com");
  assertEquals(datastoreHost(""), "unknown");
});

Deno.test("namespaceFromCollection extracts the namespace for the right tenant", () => {
  assertEquals(
    namespaceFromCollection("t_keeb_r_proxmox-manager_paths", "keeb"),
    "proxmox-manager",
  );
  assertEquals(
    namespaceFromCollection("t_keeb_r_proxmox-manager_blobs", "keeb"),
    "proxmox-manager",
  );
  assertEquals(
    namespaceFromCollection("t_keeb_r_proxmox-manager_locks", "keeb"),
    "proxmox-manager",
  );
  // Namespaces may contain underscores and hyphens; the suffix is what anchors.
  assertEquals(
    namespaceFromCollection("t_keeb_r_my_repo-2_paths", "keeb"),
    "my_repo-2",
  );
});

Deno.test("namespaceFromCollection ignores other tenants and foreign collections", () => {
  // Sweeping another tenant's data would be a cross-tenant breach.
  assertEquals(
    namespaceFromCollection("t_other_r_proxmox-manager_paths", "keeb"),
    null,
  );
  // Legacy GridFS leftovers and unrelated collections are not namespaces.
  assertEquals(
    namespaceFromCollection("t_keeb_r_bog-demo_fs.chunks", "keeb"),
    null,
  );
  assertEquals(namespaceFromCollection("system.views", "keeb"), null);
  assertEquals(namespaceFromCollection("", "keeb"), null);
});

Deno.test("model declares the expected surface", () => {
  assertEquals(model.type, "@magistr/mongodb-datastore/maintenance");
  assertEquals(Object.keys(model.methods).sort(), [
    "compact",
    "inventory",
    "sweep",
  ]);
  // compact writes its own spec rather than reusing `inventory` with zeroed
  // fields — placeholder writes are exactly what the schema-conformance check
  // exists to catch.
  assertEquals(Object.keys(model.resources).sort(), [
    "compaction",
    "inventory",
    "sweep",
  ]);
  // Both specs must bound their own retention, or the maintenance model
  // becomes the thing that needs maintaining.
  for (const spec of Object.values(model.resources)) {
    assertEquals(spec.lifetime, "infinite");
    assertEquals(spec.garbageCollection, 30);
  }
});

Deno.test("sweep defaults to a dry run", () => {
  // Deleting is opt-in; a bare `model method run ... sweep` must not destroy.
  const parsed = model.methods.sweep.arguments.parse({});
  assertEquals(parsed.dryRun, true);
  assertEquals(parsed.skipBlobs, false);
  assertEquals(parsed.graceMinutes, 60);
  assertEquals(parsed.tombstoneDays, 30);
  assertEquals(parsed.namespaces, []);
});
