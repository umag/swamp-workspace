import { z } from "npm:zod@4";

export const ConfigSchema = z.object({
  uri: z.string().describe(
    "MongoDB URI (no auth baked in), e.g. mongodb://hancock:27017/?replicaSet=rs0&authSource=admin",
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

/**
 * Root of the datastore tier inside the local cache.
 *
 * Swamp core hands `createSyncService` the BARE cache path (the repoId-keyed
 * default, since `resolveCachePath` returns undefined here as it does for every
 * remote datastore) but reads and writes the tier through
 * `DefaultDatastorePathResolver.datastorePath()`, which prepends the namespace
 * as the OUTERMOST segment: `{cache}/{namespace}/data/...`. Walking or writing
 * the bare cache path therefore builds a second, invisible copy of the tier at
 * the cache root — the reader never sees it, `sync --push` refuses with
 * "un-migrated data found at root level", and `datastore namespace migrate`
 * cannot recover once both layouts exist (swamp-club#1458 and #1554 are the
 * same defect in @swamp/s3-datastore).
 *
 * Remote `_id`s stay tier-relative (`data/...`): this extension partitions by
 * collection prefix, not by key prefix, so the namespace must NOT appear in the
 * stored path. It scopes the local side only.
 *
 * An empty namespace is solo mode and yields the bare cache path, byte-identical
 * to a non-namespaced repo — matching core's own `namespace.length > 0` guard.
 */
export function tierRoot(cfg: MongoDatastoreConfig, cachePath: string): string {
  const ns = cfg.namespace.trim();
  if (ns.length === 0) return cachePath;
  return `${cachePath.replace(/\/+$/, "")}/${ns}`;
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
