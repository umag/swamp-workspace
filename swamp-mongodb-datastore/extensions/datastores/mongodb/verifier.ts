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

interface Hello {
  ok?: number;
  setName?: string;
  isWritablePrimary?: boolean;
  primary?: string;
}

/**
 * Injectable seams. `hello` replaces the driver round-trip in tests;
 * `coreNamespace` reports the last `options.namespace` the sync service saw
 * (core never hands the verifier its namespace directly).
 */
export interface VerifierDeps {
  hello?: () => Promise<Hello>;
  coreNamespace?: () => string | undefined;
}

const TYPE = "@magistr/mongodb-datastore";

export function createVerifier(
  cfg: MongoDatastoreConfig,
  getClient: (repoDir: string) => Promise<ClientHandle>,
  repoDir: string,
  deps: VerifierDeps = {},
): DatastoreVerifier {
  const hello = deps.hello ?? (async () => {
    const { client } = await getClient(repoDir);
    return await client.db("admin").command({ hello: 1 }) as Hello;
  });
  // Reported only once a sync in this process has established it; the S3
  // reference verifier reports the bucket alone, so an unknown value is
  // omitted rather than labelled.
  const coreNamespace = () => deps.coreNamespace?.();
  const prefix = `t_${cfg.tenantId}_r_${cfg.namespace}`;

  return {
    async verify(): Promise<DatastoreHealthResult> {
      const start = performance.now();
      try {
        const h = await hello();
        const latencyMs = Math.round(performance.now() - start);

        if (!h.setName) {
          return {
            healthy: false,
            message:
              "MongoDB is reachable but not running as a replica set — change streams require a replica set or sharded cluster",
            latencyMs,
            datastoreType: TYPE,
            details: { database: cfg.database },
          };
        }

        if (!h.isWritablePrimary) {
          return {
            healthy: false,
            message:
              `Connected to replica set ${h.setName} but this member is not the primary (primary: ${
                h.primary ?? "unknown"
              })`,
            latencyMs,
            datastoreType: TYPE,
            details: { database: cfg.database, replicaSet: h.setName },
          };
        }

        const tlsWarning = plaintextWarning(cfg.uri);
        const details: Record<string, string> = {
          database: cfg.database,
          replicaSet: h.setName,
          tenantId: cfg.tenantId,
          namespace: cfg.namespace,
          configNamespace: cfg.namespace,
        };
        const core = coreNamespace();
        if (core !== undefined) details.coreNamespace = core;
        if (tlsWarning) details.tlsWarning = tlsWarning;
        return {
          healthy: true,
          message:
            `OK — connected to ${h.setName} as primary, database '${cfg.database}', namespace '${prefix}'` +
            (tlsWarning ? ` — WARNING: ${tlsWarning}` : ""),
          latencyMs,
          datastoreType: TYPE,
          details,
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
    },
  };
}

function sanitizeUri(uri: string): string {
  return uri.replace(/\/\/([^@/]+)@/, "//***@");
}

/**
 * The control plane carries serve's token secrets over this connection, so a
 * plaintext URI to anything but loopback is worth a warning. Parsed by hand:
 * `URL` cannot handle mongodb's comma-separated host lists.
 */
export function plaintextWarning(uri: string): string | undefined {
  const m = uri.match(
    /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]*)(?:\/[^?]*)?(?:\?(.*))?$/i,
  );
  if (!m) return undefined;
  const [, scheme, hostList, query] = m;
  const params = new URLSearchParams(query ?? "");
  const tlsParam = params.get("tls") ?? params.get("ssl");
  const tls = tlsParam !== null
    ? tlsParam.toLowerCase() === "true"
    : scheme.toLowerCase() === "mongodb+srv";
  if (tls) return undefined;
  const hosts = hostList.split(",").map((h) => h.trim()).filter(Boolean);
  const nonLoopback = hosts.filter((h) => !isLoopback(h));
  if (nonLoopback.length === 0) return undefined;
  return `control-plane records (including serve token secrets) travel without TLS to ${
    nonLoopback.join(", ")
  }; add tls=true to the URI or keep this datastore on a trusted network`;
}

function isLoopback(hostPort: string): boolean {
  const host = hostPort.startsWith("[")
    ? hostPort.slice(1, hostPort.indexOf("]"))
    : hostPort.replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    host.startsWith("127.");
}
