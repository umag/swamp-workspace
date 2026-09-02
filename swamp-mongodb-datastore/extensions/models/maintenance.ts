import { z } from "npm:zod@4";
import { MongoClient } from "npm:mongodb@6.17.0";
import {
  type BlobDocLike,
  type ClientStamp,
  controlCollectionNameFor,
  type ControlPort,
  foldNamespacePrefix,
  importControlRecords,
  journalCollectionNamesFor,
  type PathDocLike,
  type PathsPort,
  prefixNamespace,
  sweepOrphanBlobs,
  sweepTombstones,
} from "./sweeps.ts";
import {
  createJournal,
  type Journal,
  type JournalStore,
  type OpDoc,
  type PrunableJournalStore,
  pruneJournal,
  type RunDoc,
  type TargetStore,
} from "./journal.ts";

// Must match EXTENSION_VERSION in ../datastores/mongodb/config.ts (not
// imported — packaging). The fold guard refuses while a client stamped with
// an older version is still syncing.
const REQUIRED_CLIENT_VERSION = "2026.09.03.1";

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

// One resource per migration run (or dry-run report). `counts` is
// kind-specific; `runId` is null for dry runs and refusals.
const MigrationSchema = z.object({
  namespace: z.string(),
  kind: z.enum(["fold", "prefix", "import-control", "revert"]),
  runId: z.union([z.string(), z.null()]),
  dryRun: z.boolean(),
  refused: z.union([z.string(), z.null()]),
  counts: z.record(z.string(), z.number()),
  conflicts: z.array(z.string()).default([]),
  startedAt: z.string(),
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
  version: "2026.09.03.1",
  upgrades: [
    {
      fromVersion: "2026.08.19.1",
      toVersion: "2026.09.01.2",
      description:
        "Carries the model into the @magistr fork at the fork's own package version — the model's code is unchanged from upstream keeb 2026.08.19.2, but this repo publishes it in lockstep with manifest.yaml, so the version moves 2026.08.19.1 -> 2026.09.01.2. An instance created against the upstream 2026.08.19.1 build keeps every stored resource: no schema, resource shape or argument changed.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.09.01.2",
      toVersion: "2026.09.03.1",
      description:
        "Adds the journaled migrations (fold_namespace_prefix, prefix_namespace, import_control_records, revert_migration) and the `migration` resource. Existing inventory, sweep and compaction resources and every global argument are unchanged; sweep additionally prunes the migration journal past the tombstone window.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
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
    migration: {
      description:
        "Result of a journaled migration (fold, prefix, import-control) or a revert. runId is null for dry runs and refusals; keep it — revert_migration needs it.",
      schema: MigrationSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    fold_namespace_prefix: {
      description:
        "Fold legacy `<namespace>/…` path ids onto their tier-relative twins (layout change in 2026.09.03.1). Journaled and revertable via revert_migration. Refuses while a prefixed doc was written within recentWriterMinutes or a client stamped with an older extension version synced in the last 24h. Defaults to dryRun.",
      arguments: z.object({
        namespaces: z.array(z.string()).default([]).describe(
          "Namespaces to fold; empty means every namespace found",
        ),
        dryRun: z.boolean().default(true).describe(
          "Report counts without writing. Defaults true — opt in to the migration.",
        ),
        legacyPrefix: z.string().default("").describe(
          "The core datastore.namespace old clients used as the id prefix (e.g. dev-tmp-swamp). Defaults to the config namespace, which is only right when the two are equal.",
        ),
        recentWriterMinutes: z.number().default(30).describe(
          "Refuse if any prefixed path doc was updated within this window (an old client is still writing)",
        ),
        force: z.boolean().default(false).describe(
          "Override the recent-writer and client-version guards",
        ),
      }),
      execute: async (
        args: {
          namespaces: string[];
          dryRun: boolean;
          legacyPrefix: string;
          recentWriterMinutes: number;
          force: boolean;
        },
        context: Ctx,
      ) => {
        const { database, tenantId } = context.globalArgs;
        return await withClient(context, async (client) => {
          const targets = args.namespaces.length > 0
            ? args.namespaces
            : await discoverNamespaces(client, database, tenantId);
          const handles = [];
          for (const ns of targets) {
            const { paths, journal, control } = migrationDeps(
              client,
              database,
              tenantId,
              ns,
            );
            const clientStamps = await readClientStamps(control, ns);
            const startedAt = new Date();
            const r = await foldNamespacePrefix(paths, journal, {
              namespace: args.legacyPrefix || ns,
              dryRun: args.dryRun,
              recentWriterMinutes: args.recentWriterMinutes,
              force: args.force,
              clientStamps,
              requiredVersion: REQUIRED_CLIENT_VERSION,
            });
            if (r.refused) {
              context.logger.warning("fold refused for {namespace}: {reason}", {
                namespace: ns,
                reason: r.refused,
              });
            }
            handles.push(
              await context.writeResource("migration", `fold-${ns}`, {
                namespace: ns,
                kind: "fold",
                runId: r.runId,
                dryRun: r.dryRun,
                refused: r.refused,
                counts: {
                  scanned: r.scanned,
                  droppedEqual: r.droppedEqual,
                  bareWon: r.bareWon,
                  prefixedWon: r.prefixedWon,
                  created: r.created,
                  tombstonesFolded: r.tombstonesFolded,
                },
                conflicts: [],
                startedAt: startedAt.toISOString(),
              }),
            );
          }
          return { dataHandles: handles };
        });
      },
    },

    prefix_namespace: {
      description:
        "Inverse of fold for the post-upgrade delta: give every tier-relative path doc written after `since` a `<namespace>/`-prefixed twin, so a client rolled back to the old extension version sees it. Journaled and revertable. Defaults to dryRun.",
      arguments: z.object({
        namespaces: z.array(z.string()).default([]).describe(
          "Namespaces to prefix; empty means every namespace found",
        ),
        legacyPrefix: z.string().default("").describe(
          "Core namespace to prefix with; defaults to the config namespace",
        ),
        since: z.string().describe(
          "ISO timestamp; docs updated after it are prefixed (use the fold run's startedAt)",
        ),
        dryRun: z.boolean().default(true),
      }),
      execute: async (
        args: {
          namespaces: string[];
          legacyPrefix: string;
          since: string;
          dryRun: boolean;
        },
        context: Ctx,
      ) => {
        const { database, tenantId } = context.globalArgs;
        const since = new Date(args.since);
        if (Number.isNaN(since.getTime())) {
          throw new Error(`since is not an ISO timestamp: ${args.since}`);
        }
        return await withClient(context, async (client) => {
          const targets = args.namespaces.length > 0
            ? args.namespaces
            : await discoverNamespaces(client, database, tenantId);
          const handles = [];
          for (const ns of targets) {
            const { paths, journal } = migrationDeps(
              client,
              database,
              tenantId,
              ns,
            );
            const startedAt = new Date();
            const r = await prefixNamespace(paths, journal, {
              namespace: args.legacyPrefix || ns,
              since,
              dryRun: args.dryRun,
            });
            handles.push(
              await context.writeResource("migration", `prefix-${ns}`, {
                namespace: ns,
                kind: "prefix",
                runId: r.runId,
                dryRun: r.dryRun,
                refused: null,
                counts: { prefixed: r.prefixed },
                conflicts: [],
                startedAt: startedAt.toISOString(),
              }),
            );
          }
          return { dataHandles: handles };
        });
      },
    },

    import_control_records: {
      description:
        "Copy serve's filesystem control-plane tree (<repo>/.swamp/datastore/_control, including token secrets) into the namespace's _control collection with put-if-absent semantics. Run inside the serve container before its first restart on a control-plane-capable version. Copies, never moves. Journaled (hashes only) and revertable. Defaults to dryRun.",
      arguments: z.object({
        namespace: z.string().describe(
          "Namespace whose _control collection receives the records (the serve repo's core namespace, or the config namespace when core's is unset)",
        ),
        controlDir: z.string().describe(
          "Absolute path of the filesystem _control directory to import",
        ),
        coreNamespace: z.string().default("").describe(
          "Core datastore.namespace of the serve repo; keys are stored under <coreNamespace>/_control/ when set, _control/ otherwise",
        ),
        dryRun: z.boolean().default(true),
        maxBytes: z.number().int().positive().default(1024 * 1024).describe(
          "Reject files larger than this",
        ),
      }),
      execute: async (
        args: {
          namespace: string;
          controlDir: string;
          coreNamespace: string;
          dryRun: boolean;
          maxBytes: number;
        },
        context: Ctx,
      ) => {
        const { database, tenantId } = context.globalArgs;
        return await withClient(context, async (client) => {
          const { journal, control } = migrationDeps(
            client,
            database,
            tenantId,
            args.namespace,
          );
          const store = minimalControlStore(
            control,
            args.coreNamespace || undefined,
          );
          const startedAt = new Date();
          const r = await importControlRecords(store, journal, {
            controlDir: args.controlDir,
            dryRun: args.dryRun,
            maxBytes: args.maxBytes,
          });
          if (r.rejected.length > 0) {
            context.logger.warning("import rejected {count} entries", {
              count: r.rejected.length,
            });
          }
          const handle = await context.writeResource(
            "migration",
            `import-control-${args.namespace}`,
            {
              namespace: args.namespace,
              kind: "import-control",
              runId: r.runId,
              dryRun: r.dryRun,
              refused: null,
              counts: {
                inserted: r.inserted,
                skipped: r.skipped,
                rejected: r.rejected.length,
              },
              conflicts: r.rejected,
              startedAt: startedAt.toISOString(),
            },
          );
          return { dataHandles: [handle] };
        });
      },
    },

    revert_migration: {
      description:
        "Replay a journaled migration run in reverse. Applies an op only when the current document still equals the run's after-image; conflicts (client writes made after the migration) are reported and skipped unless force is set. Refuses when a later non-reverted migration touched the same ids. Defaults to dryRun.",
      arguments: z.object({
        namespace: z.string().describe("Namespace the run belongs to"),
        runId: z.string().describe("Run id from a previous migration result"),
        dryRun: z.boolean().default(true),
        force: z.boolean().default(false).describe(
          "Overwrite records that changed after the migration. Echoes the conflict count; use only after a dry run.",
        ),
      }),
      execute: async (
        args: {
          namespace: string;
          runId: string;
          dryRun: boolean;
          force: boolean;
        },
        context: Ctx,
      ) => {
        const { database, tenantId } = context.globalArgs;
        return await withClient(context, async (client) => {
          const { journal } = migrationDeps(
            client,
            database,
            tenantId,
            args.namespace,
          );
          const startedAt = new Date();
          const r = await journal.revert(args.runId, {
            dryRun: args.dryRun,
            force: args.force,
          });
          if (r.refused) {
            context.logger.warning("revert refused: {reason}", {
              reason: r.refused,
            });
          }
          if (r.skippedConflicts.length > 0) {
            context.logger.warning(
              "revert skipped {count} conflicting records (pass force to overwrite)",
              { count: r.skippedConflicts.length },
            );
          }
          const handle = await context.writeResource(
            "migration",
            `revert-${args.runId}`,
            {
              namespace: args.namespace,
              kind: "revert",
              runId: r.revertRunId,
              dryRun: r.dryRun,
              refused: r.refused,
              counts: {
                opsTotal: r.opsTotal,
                restored: r.restored,
                deleted: r.deleted,
                conflicts: r.skippedConflicts.length,
              },
              conflicts: r.skippedConflicts,
              startedAt: startedAt.toISOString(),
            },
          );
          return { dataHandles: [handle] };
        });
      },
    },

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

            // Migration journal shares the tombstone window: a run is
            // revertable for as long as a deletion is visible to peers.
            const jn = journalCollectionNamesFor(tenantId, ns);
            const pruned = await pruneJournal(
              db.collection(jn.runs) as unknown as PrunableJournalStore<RunDoc>,
              db.collection(jn.ops) as unknown as PrunableJournalStore<OpDoc>,
              {
                olderThanMs: args.tombstoneDays * 86_400_000,
                dryRun: args.dryRun,
              },
            );
            if (pruned.runsDeleted > 0) {
              context.logger.info(
                "Pruned {runs} migration run(s) older than {cutoff}",
                { runs: pruned.runsDeleted, cutoff: pruned.cutoff },
              );
            }

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

// ---- migration wiring -------------------------------------------------------

interface ControlRow {
  _id: string;
  data: { buffer?: Uint8Array } | Uint8Array;
  updatedAt: Date;
}

function migrationDeps(
  client: MongoClient,
  database: string,
  tenantId: string,
  ns: string,
): {
  paths: PathsPort;
  journal: Journal;
  control: ControlCollection;
} {
  const db = client.db(database);
  const p = prefix(tenantId, ns);
  const names = journalCollectionNamesFor(tenantId, ns);
  const paths = db.collection(`${p}_paths`) as unknown as PathsPort;
  const control = db.collection<ControlRow>(
    controlCollectionNameFor(tenantId, ns),
  ) as unknown as ControlCollection;
  const journal = createJournal({
    runs: db.collection(names.runs) as unknown as JournalStore<RunDoc>,
    ops: db.collection(names.ops) as unknown as JournalStore<OpDoc>,
    target: (collection: string): TargetStore => {
      if (collection === "paths") return paths as unknown as TargetStore;
      if (collection === "control") return control as unknown as TargetStore;
      throw new Error(`unknown journal target collection: ${collection}`);
    },
  });
  return { paths, journal, control };
}

// `_control/clients/<holder>` stamps written by every sync push. Read for the
// fold guard. Both key layouts (core namespace set or not) are accepted.
// The three driver calls the migrations make on `_control`.
interface ControlCollection {
  find(filter: Record<string, unknown>): AsyncIterable<ControlRow>;
  findOne(filter: Record<string, unknown>): Promise<ControlRow | null>;
  insertOne(doc: ControlRow): Promise<unknown>;
}

async function readClientStamps(
  control: ControlCollection,
  ns: string,
): Promise<ClientStamp[]> {
  const out: ClientStamp[] = [];
  const re = `^(?:${
    ns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }/)?_control/clients/`;
  for await (const row of control.find({ _id: { $regex: re } })) {
    try {
      const bytes = row.data instanceof Uint8Array
        ? row.data
        : (row.data as { buffer?: Uint8Array }).buffer ?? new Uint8Array();
      const body = JSON.parse(new TextDecoder().decode(bytes)) as {
        holder?: string;
        version?: string;
        at?: string;
      };
      if (body.version && body.at) {
        out.push({
          holder: body.holder ?? row._id,
          version: body.version,
          at: new Date(body.at),
        });
      }
    } catch {
      // A malformed stamp is not a reason to refuse or proceed; skip it.
    }
  }
  return out;
}

// The slice of the datastore's ControlPlaneStore the import needs, re-derived
// here because models/ cannot import datastores/mongodb/control_plane.ts.
// Same key layout: `<coreNamespace>/_control/<key>` or `_control/<key>`.
function minimalControlStore(
  control: ControlCollection,
  coreNamespace: string | undefined,
): ControlPort {
  const rawKey = (key: string) =>
    coreNamespace ? `${coreNamespace}/_control/${key}` : `_control/${key}`;
  return {
    rawKey,
    async get(key) {
      const doc = await control.findOne({ _id: rawKey(key) });
      if (doc === null) return null;
      return doc.data instanceof Uint8Array
        ? doc.data
        : (doc.data as { buffer?: Uint8Array }).buffer ?? new Uint8Array();
    },
    async putIfAbsent(key, data) {
      try {
        await control.insertOne({
          _id: rawKey(key),
          data,
          updatedAt: new Date(),
        });
        return true;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) return false;
        throw err;
      }
    },
  };
}
