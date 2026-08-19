import { ConfigSchema, type MongoDatastoreConfig } from "./config.ts";
import { createClientFactory } from "./client.ts";
import { createVerifier } from "./verifier.ts";
import { createLock, type LockOptions } from "./lock.ts";
import { createSyncService } from "./sync.ts";

/**
 * Swamp `DatastoreProvider` for MongoDB.
 *
 * Wires distributed locking (`createLock`), replica-set health checks
 * (`createVerifier`), and manifest + content-addressed blob sync of the
 * datastore tier (`createSyncService`). Scoped per tenant + repo namespace
 * so many consumers can share one MongoDB cluster.
 *
 * Config is parsed from `ConfigSchema` — see `./config.ts`.
 */
export const datastore = {
  type: "@magistr/mongodb-datastore",
  name: "MongoDB",
  description:
    "Stores swamp runtime coordination and datastore bytes in MongoDB — distributed locks with TTL + heartbeat + nonce fencing, plus manifest + content-addressed blob sync of the datastore tier between local cache and MongoDB. Blobs over 15MB are transparently chunked across multiple docs so they fit under MongoDB's 16MB BSON limit. Scoped by tenant + repo namespace. Requires MongoDB 4.0+ running as a replica set.",
  configSchema: ConfigSchema,

  createProvider: (rawConfig: Record<string, unknown>) => {
    const cfg: MongoDatastoreConfig = ConfigSchema.parse(rawConfig);
    const getClient = createClientFactory(cfg);
    let lastRepoDir: string | undefined;

    return {
      createLock: (datastorePath: string, options?: LockOptions) => {
        const repoDir = repoDirFrom(datastorePath);
        lastRepoDir = repoDir;
        return createLock(cfg, getClient, repoDir, options);
      },

      createVerifier: () => {
        return createVerifier(cfg, getClient, lastRepoDir ?? Deno.cwd());
      },

      createSyncService: (repoDir: string, cachePath: string) => {
        lastRepoDir = repoDir;
        return createSyncService(cfg, getClient, repoDir, cachePath);
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
    };
  },
};

function repoDirFrom(datastorePath: string): string {
  const idx = datastorePath.lastIndexOf("/.swamp/");
  return idx > 0 ? datastorePath.slice(0, idx) : datastorePath;
}
