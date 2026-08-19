import type { ClientHandle } from "./client.ts";
import type { MongoDatastoreConfig } from "./config.ts";

export interface DatastoreHealthResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly datastoreType: string;
  readonly details?: Record<string, string>;
}

export interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}

const TYPE = "@magistr/mongodb-datastore";

export function createVerifier(
  cfg: MongoDatastoreConfig,
  getClient: (repoDir: string) => Promise<ClientHandle>,
  repoDir: string,
): DatastoreVerifier {
  return {
    async verify(): Promise<DatastoreHealthResult> {
      const start = performance.now();
      try {
        const { client } = await getClient(repoDir);
        const admin = client.db("admin");
        const hello = await admin.command({ hello: 1 }) as {
          ok?: number;
          setName?: string;
          isWritablePrimary?: boolean;
          primary?: string;
        };
        const latencyMs = Math.round(performance.now() - start);

        if (!hello.setName) {
          return {
            healthy: false,
            message:
              "MongoDB is reachable but not running as a replica set — change streams require a replica set or sharded cluster",
            latencyMs,
            datastoreType: TYPE,
            details: { database: cfg.database },
          };
        }

        if (!hello.isWritablePrimary) {
          return {
            healthy: false,
            message:
              `Connected to replica set ${hello.setName} but this member is not the primary (primary: ${
                hello.primary ?? "unknown"
              })`,
            latencyMs,
            datastoreType: TYPE,
            details: {
              database: cfg.database,
              replicaSet: hello.setName,
            },
          };
        }

        return {
          healthy: true,
          message:
            `OK — connected to ${hello.setName} as primary, database '${cfg.database}', namespace '${collectionPrefix()}'`,
          latencyMs,
          datastoreType: TYPE,
          details: {
            database: cfg.database,
            replicaSet: hello.setName,
            tenantId: cfg.tenantId,
            namespace: cfg.namespace,
          },
        };
      } catch (error) {
        return {
          healthy: false,
          message: `Cannot reach MongoDB: ${
            error instanceof Error ? error.message : String(error)
          }`,
          latencyMs: Math.round(performance.now() - start),
          datastoreType: TYPE,
          details: { uri: sanitizeUri(cfg.uri) },
        };
      }

      function collectionPrefix(): string {
        return `t_${cfg.tenantId}_r_${cfg.namespace}`;
      }
    },
  };
}

function sanitizeUri(uri: string): string {
  return uri.replace(/\/\/([^@/]+)@/, "//***@");
}
