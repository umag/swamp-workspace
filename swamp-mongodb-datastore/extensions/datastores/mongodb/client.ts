import { MongoClient } from "npm:mongodb@6.17.0";
import { loadDotEnv, type MongoDatastoreConfig } from "./config.ts";

export interface ClientHandle {
  client: MongoClient;
  repoDir: string;
}

/**
 * Process-wide client cache.
 *
 * This map MUST live at module scope, not inside `createClientFactory`. Swamp
 * core caches the extension *module* (one `import()` per process) but never
 * caches the provider: `resolveCustomProvider` calls `createProvider` fresh on
 * every lock acquisition, every sync, every workflow step, and every `serve`
 * health probe, and `resolve_datastore.ts` builds a whole provider just to ask
 * for `resolveDatastorePath`. A cache scoped to one `createProvider` call
 * therefore caches nothing — it yields a new `MongoClient`, and a new
 * connection pool, per operation.
 *
 * Nothing ever closes them: the `DatastoreProvider` interface has no dispose
 * hook, and neither do `DistributedLock`, `DatastoreSyncService`, or
 * `DatastoreVerifier`. So every client opened here lives until the process
 * exits. One shared client per cluster+repo is the only bounded shape
 * available. (Upstream keeb issue #9; merged here from keeb 2026.09.02.1.)
 */
const clients = new Map<string, Promise<ClientHandle>>();

/**
 * Identity of a connection: the cluster, the credentials, and the repo whose
 * `.env` supplies the password. Deliberately NOT keyed on tenant/namespace —
 * those select collections, not connections, so every namespace in a process
 * shares one pool.
 */
export function clientCacheKey(
  cfg: MongoDatastoreConfig,
  repoDir: string,
): string {
  return [cfg.uri, cfg.username, cfg.database, repoDir].join(" ");
}

/**
 * Stamped onto every connection so mongod's logs and `$currentOp` can say
 * which repo and which process a connection belongs to. Without it the server
 * sees an anonymous pile of connections from one IP.
 *
 * First provider to open the shared client wins the name; a process serving
 * two namespaces against one cluster reports the first. mongod also records
 * the remote IP, so the pid is the part that resolves ambiguity.
 */
export function clientAppName(cfg: MongoDatastoreConfig): string {
  return `swamp:${cfg.tenantId}/${cfg.namespace}#${Deno.pid}`.slice(0, 128);
}

export function createClientFactory(
  cfg: MongoDatastoreConfig,
): (repoDir: string) => Promise<ClientHandle> {
  return (repoDir: string) => {
    const key = clientCacheKey(cfg, repoDir);
    const existing = clients.get(key);
    if (existing) return existing;

    const handle = (async () => {
      await loadDotEnv(repoDir);
      const password = Deno.env.get(cfg.passwordEnv);
      if (!password) {
        throw new Error(
          `MongoDB password not found: env var '${cfg.passwordEnv}' is not set. ` +
            `Put '${cfg.passwordEnv}=<password>' in ${repoDir}/.env or export it in the shell.`,
        );
      }
      const client = new MongoClient(cfg.uri, {
        auth: { username: cfg.username, password },
        authSource: "admin",
        appName: clientAppName(cfg),
        // Explicit pool bounds; minPoolSize 0 so an idle process holds nothing.
        maxPoolSize: cfg.maxPoolSize,
        minPoolSize: 0,
        maxIdleTimeMS: cfg.maxIdleTimeMS,
        serverSelectionTimeoutMS: cfg.serverSelectionTimeoutMS,
      });
      await client.connect();

      // The shared client is closed on process exit; there is no earlier hook.
      globalThis.addEventListener("beforeunload", () => {
        client.close().catch(() => {});
      });

      return { client, repoDir };
    })();

    // Don't cache a failed connect — the next call should retry rather than
    // hand out a permanently rejected promise (e.g. the password arrives after
    // a `.env` is written).
    handle.catch(() => {
      if (clients.get(key) === handle) clients.delete(key);
    });

    clients.set(key, handle);
    return handle;
  };
}
