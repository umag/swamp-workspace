import { MongoClient } from "npm:mongodb@6.17.0";
import { loadDotEnv, type MongoDatastoreConfig } from "./config.ts";

export interface ClientHandle {
  client: MongoClient;
  repoDir: string;
}

export function createClientFactory(
  cfg: MongoDatastoreConfig,
): (repoDir: string) => Promise<ClientHandle> {
  let cached: Promise<ClientHandle> | undefined;

  return (repoDir: string) => {
    if (cached) return cached;
    cached = (async () => {
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
        maxPoolSize: cfg.maxPoolSize,
        minPoolSize: 0,
        maxIdleTimeMS: cfg.maxIdleTimeMS,
        serverSelectionTimeoutMS: cfg.serverSelectionTimeoutMS,
      });
      await client.connect();

      globalThis.addEventListener("beforeunload", () => {
        client.close().catch(() => {});
      });

      return { client, repoDir };
    })();
    cached = cached.catch((err) => {
      cached = undefined;
      throw err;
    });
    return cached;
  };
}
