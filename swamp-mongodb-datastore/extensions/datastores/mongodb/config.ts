import { z } from "npm:zod@4";

export const ConfigSchema = z.object({
  uri: z.string().describe(
    "MongoDB URI (no auth baked in), e.g. mongodb://mongo.example.com:27017/?replicaSet=rs0&authSource=admin",
  ),
  username: z.string().describe(
    "MongoDB username — passed to the driver as an auth option, not baked into the URI",
  ),
  passwordEnv: z.string().default("MONGO_PASSWORD").describe(
    "Name of the env var (loaded from <repoDir>/.env) that holds the MongoDB password",
  ),
  database: z.string().default("swamp").describe(
    "Database name shared by all tenants/repos; isolation is via collection prefix",
  ),
  tenantId: z.string().default("default").describe(
    "Tenant identifier — today usually 'default'; becomes meaningful if this extension is offered as a service",
  ),
  namespace: z.string().describe(
    "Per-repo identifier used in collection prefixing (t_<tenant>_r_<namespace>_<purpose>)",
  ),
  defaultLockTtlMs: z.number().int().positive().default(30_000),
  maxPoolSize: z.number().int().min(1).max(10_000).default(500).describe(
    "Maximum number of connections in the driver pool. Default: 500",
  ),
  maxIdleTimeMS: z.number().int().min(0).default(60_000).describe(
    "Close idle connections after this many milliseconds. 0 = never. Default: 60000 (1 min)",
  ),
  serverSelectionTimeoutMS: z.number().int().min(1000).default(5_000).describe(
    "Timeout for server selection before failing. Default: 5000 (5 s)",
  ),
});

export type MongoDatastoreConfig = z.infer<typeof ConfigSchema>;

export function collectionPrefix(cfg: MongoDatastoreConfig): string {
  return `t_${cfg.tenantId}_r_${cfg.namespace}`;
}

export function lockCollectionName(cfg: MongoDatastoreConfig): string {
  return `${collectionPrefix(cfg)}_locks`;
}

export function pathsCollectionName(cfg: MongoDatastoreConfig): string {
  return `${collectionPrefix(cfg)}_paths`;
}

export function blobsCollectionName(cfg: MongoDatastoreConfig): string {
  return `${collectionPrefix(cfg)}_blobs`;
}

const ENV_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export async function loadDotEnv(repoDir: string): Promise<void> {
  const path = `${repoDir}/.env`;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(ENV_LINE);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (Deno.env.get(key) !== undefined) continue;
    const value = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue.startsWith("'") && rawValue.endsWith("'")
      ? rawValue.slice(1, -1)
      : rawValue;
    Deno.env.set(key, value);
  }
}

/** The `_control` collection: control-plane records (heartbeats, claims, token secrets). */
export function controlCollectionName(cfg: MongoDatastoreConfig): string {
  return `${collectionPrefix(cfg)}_control`;
}

/** Migration journal headers — one document per migration run. */
export function migrationsCollectionName(cfg: MongoDatastoreConfig): string {
  return `${collectionPrefix(cfg)}_migrations`;
}

/** Migration journal before/after images — one document per touched record. */
export function migrationOpsCollectionName(
  cfg: MongoDatastoreConfig,
): string {
  return `${collectionPrefix(cfg)}_migration_ops`;
}

// Stamped into `_control/clients/<holder>` on every push so migrations can
// refuse to run while an older client is still writing. Bump together with
// manifest.yaml.
export const EXTENSION_VERSION = "2026.09.03.1";

/**
 * Root of the datastore tier inside the local cache when only the extension's
 * own namespace is known.
 *
 * Swamp core hands `createSyncService` the BARE cache path but reads and
 * writes the tier through `DefaultDatastorePathResolver.datastorePath()`,
 * which prepends core's `datastore.namespace` as the OUTERMOST segment:
 * `{cache}/{namespace}/data/...`. The sync service prefers the namespace core
 * passes on each call (`options.namespace`) and falls back to this — the
 * behaviour 2026.09.01.2 shipped — when a call carries none. Remote `_id`s
 * stay tier-relative either way (`data/...`); the namespace scopes the local
 * side only (see path_mapping.ts).
 *
 * An empty namespace is solo mode and yields the bare cache path.
 */
export function tierRoot(cfg: MongoDatastoreConfig, cachePath: string): string {
  const ns = cfg.namespace.trim();
  if (ns.length === 0) return cachePath;
  return `${cachePath.replace(/\/+$/, "")}/${ns}`;
}
