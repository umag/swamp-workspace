import {
  ConfigSchema,
  controlCollectionName,
  type MongoDatastoreConfig,
} from "./config.ts";
import { createClientFactory } from "./client.ts";
import { createVerifier } from "./verifier.ts";
import { createLock, type LockOptions } from "./lock.ts";
import { createSyncService, type NamespaceHolder } from "./sync.ts";
import {
  type ControlPlaneStore,
  createControlPlaneStore,
} from "./control_plane.ts";
import type { ControlStore } from "./stores.ts";

/**
 * Swamp `DatastoreProvider` for MongoDB.
 *
 * Wires distributed locking (`createLock`), replica-set health checks
 * (`createVerifier`), manifest + content-addressed blob sync of the datastore
 * tier (`createSyncService`), a control-plane store for serve HA, and
 * namespace registration. Scoped per tenant + repo namespace so many
 * consumers can share one MongoDB cluster.
 *
 * Config is parsed from `ConfigSchema` — see `./config.ts`.
 */
export const datastore = {
  type: "@magistr/mongodb-datastore",
  name: "MongoDB",
  description:
    "Stores swamp runtime coordination and datastore bytes in MongoDB — distributed locks with TTL + heartbeat + nonce fencing, a control-plane store for serve HA (heartbeats, cron de-dup, token secrets), and manifest + content-addressed blob sync of the datastore tier between local cache and MongoDB with two-phase push. Blobs over 15MB are transparently chunked across multiple docs so they fit under MongoDB's 16MB BSON limit. Scoped by tenant + repo namespace. Requires MongoDB 4.0+ running as a replica set.",
  configSchema: ConfigSchema,

  createProvider: (rawConfig: Record<string, unknown>) => {
    const cfg: MongoDatastoreConfig = ConfigSchema.parse(rawConfig);
    const getClient = createClientFactory(cfg);
    let lastRepoDir: string | undefined;
    // Shared with the sync service so the verifier can report the core
    // namespace the last sync ran under.
    const holder: NamespaceHolder = { current: undefined };

    const controlCollection = async (): Promise<ControlStore> => {
      const { client } = await getClient(lastRepoDir ?? Deno.cwd());
      return client.db(cfg.database).collection(
        controlCollectionName(cfg),
      ) as unknown as ControlStore;
    };

    return {
      createLock: (datastorePath: string, options?: LockOptions) => {
        const repoDir = repoDirFrom(datastorePath);
        lastRepoDir = repoDir;
        return createLock(cfg, getClient, repoDir, options);
      },

      createVerifier: () => {
        return createVerifier(cfg, getClient, lastRepoDir ?? Deno.cwd(), {
          coreNamespace: () => holder.current,
        });
      },

      createSyncService: (repoDir: string, cachePath: string) => {
        lastRepoDir = repoDir;
        return createSyncService(cfg, getClient, repoDir, cachePath, holder);
      },

      resolveDatastorePath: (repoDir: string): string => {
        lastRepoDir = repoDir;
        const path = `${repoDir}/.swamp/datastore`;
        try {
          Deno.mkdirSync(path, { recursive: true });
        } catch {
          // Swallow — swamp core surfaces permission errors via the verifier.
        }
        return path;
      },

      resolveCachePath: (_repoDir: string): string | undefined => {
        return undefined;
      },

      // Namespaces are the `t_<tenant>_r_<slug>_paths` collections. Read-only:
      // this makes `swamp datastore namespace list` truthful. Note that
      // `namespace migrate` / `namespace unset --migrate` must not be run
      // against this extension — see README.
      listNamespaces: async (_datastorePath: string): Promise<string[]> => {
        const { client } = await getClient(lastRepoDir ?? Deno.cwd());
        const names = (await client.db(cfg.database).listCollections({}, {
          nameOnly: true,
        }).toArray()).map((c) => c.name);
        return namespacesFromCollectionNames(names, cfg.tenantId);
      },

      registerNamespace: async (
        _datastorePath: string,
        namespace: string,
        repoId: string,
      ): Promise<void> => {
        const store = createControlPlaneStore(controlCollection, undefined);
        await registerNamespaceIn(store, namespace, repoId);
      },
    };
  },
};

function repoDirFrom(datastorePath: string): string {
  const idx = datastorePath.lastIndexOf("/.swamp/");
  return idx > 0 ? datastorePath.slice(0, idx) : datastorePath;
}

/** Namespace slugs, derived from this tenant's `*_paths` collections. */
export function namespacesFromCollectionNames(
  names: string[],
  tenantId: string,
): string[] {
  const re = new RegExp(`^t_${escapeRegex(tenantId)}_r_(.+)_paths$`);
  const out = new Set<string>();
  for (const n of names) {
    const m = n.match(re);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

interface NamespaceManifest {
  slug: string;
  repoId: string;
  registeredAt: string;
}

/**
 * Writes `_control/namespaces/<slug>` (manifest only — no data moves).
 * Idempotent for the same repo; refuses a slug another repo already holds.
 */
export async function registerNamespaceIn(
  store: ControlPlaneStore,
  namespace: string,
  repoId: string,
): Promise<void> {
  const key = `namespaces/${namespace}`;
  const existing = await store.get(key);
  if (existing !== null) {
    let manifest: Partial<NamespaceManifest>;
    try {
      manifest = JSON.parse(
        new TextDecoder().decode(existing),
      ) as Partial<NamespaceManifest>;
    } catch {
      throw new Error(
        `Namespace manifest for "${namespace}" is not valid JSON; inspect _control/${key}`,
      );
    }
    if (manifest.repoId === repoId) return;
    throw new Error(
      `Namespace "${namespace}" is already claimed by repo ${manifest.repoId}`,
    );
  }
  const manifest: NamespaceManifest = {
    slug: namespace,
    repoId,
    registeredAt: new Date().toISOString(),
  };
  await store.put(key, new TextEncoder().encode(JSON.stringify(manifest)));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
