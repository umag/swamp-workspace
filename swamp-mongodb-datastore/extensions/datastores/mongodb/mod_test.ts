// RED tests for mod.ts additions: namespace discovery from collection names
// and manifest-only namespace registration in the control plane.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import * as modTyped from "./mod.ts";
import { createControlPlaneStore } from "./control_plane.ts";
import { dec, enc, FakeCollection } from "./test_fakes.ts";

interface ControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
interface ModExtras {
  namespacesFromCollectionNames(names: string[], tenantId: string): string[];
  registerNamespaceIn(
    store: ControlPlaneStore,
    namespace: string,
    repoId: string,
  ): Promise<void>;
}
const mod = modTyped as unknown as ModExtras;

Deno.test("mod: listNamespaces derives slugs from *_paths collections of this tenant only", () => {
  assertEquals(
    mod.namespacesFromCollectionNames(
      [
        "t_default_r_dev-tmp-swamp_paths",
        "t_default_r_dev-tmp-swamp_blobs",
        "t_default_r_dev-tmp-swamp_locks",
        "t_default_r_dev-tmp-swamp_control",
        "t_default_r_dev-tmp-swamp_migrations",
        "t_default_r_move_paths",
        "t_other_r_secret_paths",
        "system.views",
      ],
      "default",
    ),
    ["dev-tmp-swamp", "move"],
  );
});

Deno.test("mod: registerNamespace writes a manifest under _control/namespaces/<slug> and is idempotent for the same repo", async () => {
  const cp = {
    createControlPlaneStore: createControlPlaneStore as unknown as (
      store: unknown,
      namespace?: string,
    ) => ControlPlaneStore,
  };
  const coll = new FakeCollection("control");
  const store = cp.createControlPlaneStore(coll, undefined);
  await mod.registerNamespaceIn(store, "dev-tmp-swamp", "repo-1");
  await mod.registerNamespaceIn(store, "dev-tmp-swamp", "repo-1");
  const raw = await store.get("namespaces/dev-tmp-swamp");
  const manifest = JSON.parse(dec(raw!)) as { slug: string; repoId: string };
  assertEquals(manifest.slug, "dev-tmp-swamp");
  assertEquals(manifest.repoId, "repo-1");
  assertEquals(await store.list("namespaces/"), ["namespaces/dev-tmp-swamp"]);
});

Deno.test("mod: registerNamespace refuses a slug already claimed by another repo", async () => {
  const cp = {
    createControlPlaneStore: createControlPlaneStore as unknown as (
      store: unknown,
      namespace?: string,
    ) => ControlPlaneStore,
  };
  const store = cp.createControlPlaneStore(
    new FakeCollection("control"),
    undefined,
  );
  await store.put(
    "namespaces/taken",
    enc(JSON.stringify({ slug: "taken", repoId: "repo-a" })),
  );
  await assertRejects(
    () => mod.registerNamespaceIn(store, "taken", "repo-b"),
    Error,
    "repo-a",
  );
});
