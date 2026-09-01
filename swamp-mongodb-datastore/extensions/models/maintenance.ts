import { z } from "npm:zod@4";
import { MongoClient } from "npm:mongodb@6.17.0";
import {
  type BlobDocLike,
  type PathDocLike,
  sweepOrphanBlobs,
  sweepTombstones,
} from "./sweeps.ts";

// Maintenance surface for @magistr/mongodb-datastore, exposed as model methods so
// it composes into swamp workflows.
//
// A DatastoreProvider has no method surface — it implements createLock /
// createSyncService / etc. for swamp core, and nothing a workflow can call.
// That left reclamation as a CLI-only concern, which is the wrong shape for
// work that should run on a schedule alongside the rest of a repo's
// automation. This model closes that gap.
//
// The sweep functions live in ./sweeps.ts rather than under
// ../datastores/mongodb/ because packaging only ships each declared entry
// point's transitive import graph. The datastore entry is mod.ts, which never
// imports the sweeps, so a cross-directory import from here resolved fine
// locally and then broke in the published tarball.
//
// Every method fans out over namespaces internally rather than expecting the
// caller to loop. Looping `swamp model method run` against one model
// serializes on that model's lock and is the documented way to cause timeouts.

const GlobalArgsSchema = z.object({
  uri: z.string().describe(
    "MongoDB URI for the cluster backing the datastore (no auth baked in)",
  ),
  username: z.string().describe("MongoDB username"),
  password: z.string().meta({ sensitive: true }).describe(
    "MongoDB password — supply a vault reference, never a literal",
  ),
  database: z.string().default("swamp").describe(
    "Database shared by all tenants/repos",
  ),
  tenantId: z.string().default("default").describe(
    "Tenant identifier; the collection prefix is t_<tenantId>_r_<namespace>",
  ),
});

const NamespaceStatsSchema = z.object({
  namespace: z.string(),
  livePaths: z.number(),
  tombstones: z.number(),
  blobs: z.number(),
  storageBytes: z.number(),
  reusableBytes: z.number(),
  lastWriteAt: z.union([z.string(), z.null()]),
  idleDays: z.union([z.number(), z.null()]),
});

// `bytesReclaimed` is a lower bound, not an exact figure: storageSize is read
// immediately after `compact` returns, and WiredTiger updates it on its own
// checkpoint schedule. A pass that genuinely freed space can therefore report
// 0 here while a later `inventory` shows the smaller collection. Treat it as
// "at least this much"; `inventory.reusableBytes` dropping is the real signal.
const CompactionSchema = z.object({
  namespace: z.string(),
  collectionsCompacted: z.number(),
  storageBytesBefore: z.number(),
  storageBytesAfter: z.number(),
  bytesReclaimed: z.number(),
  compactedAt: z.string(),
});

const SweepResultSchema = z.object({
  namespace: z.string(),
  dryRun: z.boolean(),
  tombstonesTotal: z.number(),
  tombstonesDeleted: z.number(),
  tombstonesKept: z.number(),
  blobsScanned: z.number(),
  orphanBlobs: z.number(),
  orphanChunks: z.number(),
  bytesReclaimed: z.number(),
  skippedTooYoung: z.number(),
  blobsSkipped: z.boolean(),
  skipReason: z.union([z.string(), z.null()]),
});

interface Ctx {
  globalArgs: Record<string, string>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<unknown>;
}

/**
 * Extracts just the host[:port] from a MongoDB URI, for logging.
 *
 * A connection URI may embed credentials as `scheme://user:pass@host/...`, so
 * logging the URI would leak them. This strips the scheme and any userinfo and
 * stops at the path or query, leaving only the host.
 */
export function datastoreHost(uri: string): string {
  return uri
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]*@/, "")
    .split(/[/?]/)[0] || "unknown";
}

/**
 * Pulls the namespace out of a prefixed collection name, or null if the name
 * belongs to a different tenant or is not one of this datastore's collections.
 */
export function namespaceFromCollection(
  collectionName: string,
  tenantId: string,
): string | null {
  const re = new RegExp(`^t_${tenantId}_r_(.+)_(?:paths|blobs|locks)$`);
  return collectionName.match(re)?.[1] ?? null;
}

async function withClient<T>(
  context: Ctx,
  fn: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const g = context.globalArgs;
  const host = datastoreHost(g.uri);
  context.logger.info("Connecting to MongoDB {host}", { host });
  const client = new MongoClient(g.uri, {
    auth: { username: g.username, password: g.password },
    serverSelectionTimeoutMS: 15_000,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close();
  }
}

const prefix = (tenant: string, ns: string) => `t_${tenant}_r_${ns}`;

// Namespaces present in the database, derived from collection names.
async function discoverNamespaces(
  client: MongoClient,
  database: string,
  tenantId: string,
): Promise<string[]> {
  const db = client.db(database);
  const found = new Set<string>();
  for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
    const ns = namespaceFromCollection(c.name, tenantId);
    if (ns !== null) found.add(ns);
  }
  return [...found].sort();
}

async function collStats(
  client: MongoClient,
  database: string,
  name: string,
): Promise<{ storage: number; reusable: number; count: number }> {
  try {
    const s = await client.db(database).command({ collStats: name });
    return {
      storage: s.storageSize ?? 0,
      reusable:
        s.wiredTiger?.["block-manager"]?.["file bytes available for reuse"] ??
          0,
      count: s.count ?? 0,
    };
  } catch {
    return { storage: 0, reusable: 0, count: 0 };
  }
}

/**
 * Model type `@magistr/mongodb-datastore/maintenance`.
 *
 * Reclamation surface for a MongoDB-backed swamp datastore, exposed as model
 * methods so it composes into workflows instead of living in a script beside
 * swamp.
 *
 * Methods (each fans out over every namespace in one execution):
 * - `inventory` — live paths, tombstones, blobs, allocated vs reusable bytes,
 *   idle days.
 * - `sweep` — prune tombstones past their grace window and delete blobs no
 *   live path references. Defaults to `dryRun: true`.
 * - `compact` — return freed space to the filesystem.
 *
 * Global arguments carry the cluster connection; `password` is marked
 * sensitive and should be a `vault.get(...)` expression, never a literal.
 */
export const model = {
  type: "@magistr/mongodb-datastore/maintenance",
  version: "2026.08.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    inventory: {
      description:
        "Per-namespace size and activity snapshot for the datastore cluster",
      schema: NamespaceStatsSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    sweep: {
      description: "Result of a tombstone + orphaned-blob sweep",
      schema: SweepResultSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    compaction: {
      description:
        "Storage returned to the filesystem by a compact pass. bytesReclaimed is a lower bound — storageSize lags WiredTiger's checkpoint, so a pass that freed space may report 0.",
      schema: CompactionSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    inventory: {
      description:
        "Snapshot every namespace in the cluster: live paths, tombstones, blob count, allocated vs reusable bytes, and how long since the last write. Fans out over all namespaces in one execution.",
      arguments: z.object({
        namespaces: z.array(z.string()).default([]).describe(
          "Namespaces to inspect; empty means every namespace found",
        ),
      }),
      execute: async (
        args: { namespaces: string[] },
        context: Ctx,
      ) => {
        const { database, tenantId } = context.globalArgs;
        return await withClient(context, async (client) => {
          const targets = args.namespaces.length > 0
            ? args.namespaces
            : await discoverNamespaces(client, database, tenantId);
          context.logger.info("Inspecting {count} namespaces", {
            count: targets.length,
          });

          const db = client.db(database);
          const handles = [];
          for (const ns of targets) {
            const p = prefix(tenantId, ns);
            const paths = db.collection<PathDocLike>(`${p}_paths`);
            const pStats = await collStats(client, database, `${p}_paths`);
            const bStats = await collStats(client, database, `${p}_blobs`);

            const livePaths = await paths.countDocuments({ deletedAt: null })
              .catch(() => 0);
            const tombstones = await paths.countDocuments({
              deletedAt: { $ne: null },
            }).catch(() => 0);
            const newest = await paths.find({}).sort({ updatedAt: -1 })
              .limit(1).project({ updatedAt: 1 }).toArray().catch(() => []);
            const last = (newest[0] as { updatedAt?: Date } | undefined)
              ?.updatedAt;

            handles.push(
              await context.writeResource("inventory", ns, {
                namespace: ns,
                livePaths,
                tombstones,
                blobs: bStats.count,
                storageBytes: pStats.storage + bStats.storage,
                reusableBytes: pStats.reusable + bStats.reusable,
                lastWriteAt: last ? last.toISOString() : null,
                idleDays: last
                  ? Number(
                    ((Date.now() - last.getTime()) / 86_400_000).toFixed(1),
                  )
                  : null,
              }),
            );
          }
          return { dataHandles: handles };
        });
      },
    },

    sweep: {
      description:
        "Prune tombstones past their grace window and delete blobs no live path references. Fans out over namespaces in one execution. Refuses to sweep blobs in a namespace written recently whose blobs predate the createdAt field, since nothing can distinguish an in-flight push there.",
      arguments: z.object({
        namespaces: z.array(z.string()).default([]).describe(
          "Namespaces to sweep; empty means every namespace found",
        ),
        dryRun: z.boolean().default(true).describe(
          "Report without deleting. Defaults true — opt in to deletion.",
        ),
        graceMinutes: z.number().default(60).describe(
          "Spare blobs created within this many minutes (in-flight pushes)",
        ),
        tombstoneDays: z.number().default(30).describe(
          "Spare tombstones deleted within this many days. Must exceed the longest gap between any peer's syncs, or a dormant peer resurrects deleted files.",
        ),
        skipBlobs: z.boolean().default(false).describe(
          "Prune tombstones only, leaving bytes for a maintenance window",
        ),
        activeIdleHours: z.number().default(24).describe(
          "A namespace written more recently than this counts as active; its blobs are swept only if they carry createdAt",
        ),
      }),
      execute: async (
        args: {
          namespaces: string[];
          dryRun: boolean;
          graceMinutes: number;
          tombstoneDays: number;
          skipBlobs: boolean;
          activeIdleHours: number;
        },
        context: Ctx,
      ) => {
        const { database, tenantId } = context.globalArgs;
        return await withClient(context, async (client) => {
          const targets = args.namespaces.length > 0
            ? args.namespaces
            : await discoverNamespaces(client, database, tenantId);
          const db = client.db(database);
          const handles = [];

          for (const ns of targets) {
            const p = prefix(tenantId, ns);
            const paths = db.collection<PathDocLike>(`${p}_paths`);
            const blobs = db.collection<BlobDocLike>(`${p}_blobs`);

            context.logger.info("Sweeping {namespace}", { namespace: ns });

            const tomb = await sweepTombstones(paths, {
              dryRun: args.dryRun,
              graceMs: args.tombstoneDays * 86_400_000,
            });

            // Decide whether the blob sweep is safe here. Blobs written before
            // 2026.08.19.1 have no createdAt, so the grace window cannot
            // protect them; combined with an active writer, every
            // unreferenced blob looks eligible including one inserted a
            // second ago.
            let skipReason: string | null = null;
            if (args.skipBlobs) {
              skipReason = "skipBlobs requested";
            } else {
              const newest = await paths.find({}).sort({ updatedAt: -1 })
                .limit(1).project({ updatedAt: 1 }).toArray().catch(() => []);
              const last = (newest[0] as { updatedAt?: Date } | undefined)
                ?.updatedAt;
              const idleHours = last
                ? (Date.now() - last.getTime()) / 3_600_000
                : Infinity;
              if (idleHours < args.activeIdleHours) {
                const stamped = await blobs.countDocuments({
                  createdAt: { $exists: true },
                }, { limit: 1 });
                if (stamped === 0) {
                  skipReason = `namespace active (${
                    idleHours.toFixed(1)
                  }h idle) and no blob carries createdAt`;
                  context.logger.warning(
                    "Skipping blob sweep for {namespace}: {reason}",
                    { namespace: ns, reason: skipReason },
                  );
                }
              }
            }

            const blobRes = skipReason === null
              ? await sweepOrphanBlobs(paths, blobs, {
                dryRun: args.dryRun,
                graceMs: args.graceMinutes * 60_000,
              })
              : null;

            handles.push(
              await context.writeResource("sweep", ns, {
                namespace: ns,
                dryRun: args.dryRun,
                tombstonesTotal: tomb.tombstonesTotal,
                tombstonesDeleted: tomb.tombstonesDeleted,
                tombstonesKept: tomb.tombstonesKept,
                blobsScanned: blobRes?.blobDocsScanned ?? 0,
                orphanBlobs: blobRes?.orphanBlobs ?? 0,
                orphanChunks: blobRes?.orphanChunks ?? 0,
                bytesReclaimed: blobRes?.bytesReclaimed ?? 0,
                skippedTooYoung: blobRes?.skippedTooYoung ?? 0,
                blobsSkipped: skipReason !== null,
                skipReason,
              }),
            );
          }
          return { dataHandles: handles };
        });
      },
    },

    compact: {
      description:
        "Return freed space to the filesystem. Deleting documents only moves space to WiredTiger's free list, so a swept cluster still reports its old size until this runs. Uses force:true, which is required on a replica-set primary and slows concurrent operations — schedule it.",
      arguments: z.object({
        namespaces: z.array(z.string()).default([]).describe(
          "Namespaces to compact; empty means every namespace found",
        ),
        minReusableMb: z.number().default(1).describe(
          "Skip collections holding less reusable space than this",
        ),
      }),
      execute: async (
        args: { namespaces: string[]; minReusableMb: number },
        context: Ctx,
      ) => {
        const { database, tenantId } = context.globalArgs;
        return await withClient(context, async (client) => {
          const targets = args.namespaces.length > 0
            ? args.namespaces
            : await discoverNamespaces(client, database, tenantId);
          const db = client.db(database);
          const handles = [];

          for (const ns of targets) {
            const p = prefix(tenantId, ns);
            let before = 0;
            let after = 0;
            let compacted = 0;
            for (const suffix of ["paths", "blobs"]) {
              const name = `${p}_${suffix}`;
              const s = await collStats(client, database, name);
              if (s.reusable < args.minReusableMb * 1024 * 1024) continue;
              before += s.storage;
              try {
                await db.command({ compact: name, force: true });
                compacted++;
              } catch (err) {
                context.logger.warning("compact {name} failed: {error}", {
                  name,
                  error: (err as Error).message,
                });
              }
              after += (await collStats(client, database, name)).storage;
            }
            // Nothing held enough reusable space to be worth compacting.
            if (compacted === 0) continue;
            context.logger.info(
              "Compacted {namespace}: {before} -> {after} bytes",
              { namespace: ns, before, after },
            );
            handles.push(
              await context.writeResource("compaction", ns, {
                namespace: ns,
                collectionsCompacted: compacted,
                storageBytesBefore: before,
                storageBytesAfter: after,
                bytesReclaimed: before - after,
                compactedAt: new Date().toISOString(),
              }),
            );
          }
          return { dataHandles: handles };
        });
      },
    },
  },
};
