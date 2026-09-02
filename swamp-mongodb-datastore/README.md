# MongoDB Datastore

Custom swamp `DatastoreProvider` backed by MongoDB.

Built for a **mega swamp** — one shared `.swamp` that many users and agents
read/write concurrently.

Replaces the coarse per-model file lock of the filesystem/S3 backends with
finer-grained, event-driven coordination.

## Requirements

- MongoDB 4.0+ running as a replica set in any configuration - single node is
  fine.
- Swamp CLI with extension support.

## Install

Three steps. You need a swamp repo and a MongoDB replica set you can reach.

**1. Pull the extension into your swamp repo:**

```bash
swamp extension pull @magistr/mongodb-datastore
```

**2. Add it as the datastore in your repo's `.swamp.yaml`:**

```yaml
datastore:
  type: "@magistr/mongodb-datastore"
  config:
    uri: "mongodb://mongo.example.com:27017/?replicaSet=rs0&authSource=admin"
    username: "swamp-user"
    passwordEnv: "MONGO_PASSWORD"
    database: "swamp"
    tenantId: "my-org"
    namespace: "my-repo"
```

See [Configuration](#configuration) for field-by-field descriptions.

**3. Put your MongoDB password in `<repoDir>/.env` (gitignored):**

```
MONGO_PASSWORD=...
```

Swamp picks it up on the next invocation.

## Configuration

| Field              | Type   | Required | Default          | Description                                                                 |
| ------------------ | ------ | -------- | ---------------- | --------------------------------------------------------------------------- |
| `uri`              | string | yes      | —                | MongoDB URI. Must resolve to a replica set.                                 |
| `username`         | string | yes      | —                | Mongo user, passed to the driver as an auth option.                         |
| `passwordEnv`      | string | no       | `MONGO_PASSWORD` | Env var name holding the password. Loaded from `<repoDir>/.env` at startup. |
| `database`         | string | no       | `swamp`          | Shared database; per-repo isolation is by collection prefix.                |
| `tenantId`         | string | no       | `default`        | Tenant identifier; part of the collection prefix.                           |
| `namespace`        | string | yes      | —                | Per-repo identifier; part of the collection prefix.                         |
| `defaultLockTtlMs` | number | no       | `30000`          | Default lock TTL. Must exceed your longest critical section.                |

Collections are prefixed `t_<tenantId>_r_<namespace>_*` — `_locks` for lock
docs, `_paths` for the manifest, `_blobs` for content-addressed bytes.

## What it does

- **Distributed lock.** `findOneAndUpdate` on a lock doc, TTL + heartbeat
  refresh, nonce fenced on `release` and `forceRelease`. Global + per-model
  keys.
- **Manifest + content-addressed blob sync.** The datastore-tier cache tree
  (`.swamp/<cache>/{data,outputs,workflow-runs,...}`) is split across two
  collections: `_paths` holds one doc per file
  (`{_id: relPath, hash, size,
  updatedAt, deletedAt}`) and `_blobs` holds
  bytes keyed by their sha256. Pull = cursor over `_paths` since the last
  watermark + bulk `$in` over `_blobs` for the unique hashes the host doesn't
  already have. Push = hash locally, upsert any blob that's missing (idempotent
  on the hash `_id`), upsert path docs in bulk. Identical bytes pushed by N
  agents collapse to one blob server-side; renames are free; the cursor itself
  is the wire transport (no per-file roundtrips).
- **Dirty tracking via an append-only journal.** `markDirty` appends one line to
  `<cache>/.datastore-dirty.log` — no read, no parse, no rewrite. The JSON
  sidecar next to it (`.datastore-sync-state.json`) holds only scalars
  (watermarks and flags) and is rewritten only when one of them changes. On
  push, the journal is deduped and **coalesced**: a dirty directory absorbs
  every dirty path beneath it, since the push walks a dirty directory in full.
  Past `MAX_DIRTY_PATHS` (10k) tracking degrades to a single full walk, which is
  cheaper than reconciling that many roots individually.
- **Health verifier.** Rejects non-replica-set clusters and reports
  primary/secondary state, latency, both namespaces (config vs core) and a
  warning when the connection is plaintext to a non-loopback host.
- **Control plane.** `_control` holds swamp serve's coordination records
  (instance heartbeats, active and pending runs, cron fire records, reconcile
  claims, token secrets) with `putIfAbsent` = `insertOne` + duplicate-key. With
  it serve reports deployment mode `durable`: runs survive instance replacement
  and two instances never fire the same schedule twice.
- **Two-phase push.** `preparePush` uploads blobs outside swamp's global lock;
  `commitPush` merges path docs under it and releases only the dirty paths it
  consumed. A `markDirty` that lands between the phases survives.

### Capabilities and layout (2026.09.03.1)

| Capability       | Meaning                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `scopedSync`     | Per-model pulls scoped to `data/<type>/<id>/`.                                                                              |
| `lazyHydration`  | Metadata-only setup pull; content fetched on first read.                                                                    |
| `namespacedSync` | Core's `datastore.namespace` shapes the **local** cache (`<cache>/<ns>/…`); remote ids are always tier-relative (`data/…`). |
| `twoPhaseSync`   | `preparePush` / `commitPush` split.                                                                                         |
| `controlPlane`   | `_control` collection, `putIfAbsent` supported.                                                                             |
| `configRefresh`  | `pullChanged({subdirs})` fetches only the listed prefixes (serve's config and access pollers).                              |

Collections per namespace: `_paths`, `_blobs`, `_locks`, `_control`,
`_migrations`, `_migration_ops`. Anyone with the database user can read all of
them — blobs, the path manifest, locks, control records **including serve's
token secrets**, and migration before-images (path metadata only; control
records are journaled as hashes). Give the user `readWrite` on the `swamp`
database and nothing cluster-wide, and put `?tls=true` in the URI unless the
network is trusted; the verifier warns otherwise. Every push also stamps
`_control/clients/<user@hostname>` with the extension version (the same identity
the lock documents already carry) so migrations can refuse while an old client
is still writing.

Two things are both called "namespace": **core's** `datastore.namespace`
(`swamp datastore namespace set`) and this extension's `config.namespace`
(collection prefix). Only core's drives the on-disk layout. Do **not** run
`swamp datastore namespace migrate` or `namespace unset --migrate` against this
extension — the local tier is laid out by this extension, and those commands
move or delete files core cannot account for (Lab #1280, #1304).

## Maintenance

- **Blob GC.** `_blobs` is append-only by design — dedup means no push can know
  whether some other path still references a hash — so tombstoning a path leaves
  its bytes behind.

  Reclamation runs through the `sweep` method — see
  [Run it as a workflow](#run-all-of-the-above-as-a-workflow) below. It sweeps
  every namespace in the cluster by default, including ones whose owning
  checkout has moved away:

  ```bash
  # Dry run is the default; nothing is deleted until you say so.
  swamp model method run datastore-maintenance sweep

  swamp model method run datastore-maintenance sweep --input '{"dryRun":false}'
  swamp model method run datastore-maintenance sweep \
    --input '{"dryRun":false,"namespaces":["other-repo"],"skipBlobs":true}'
  ```

  A push inserts a blob _before_ upserting the path doc that references it, so a
  sweep landing between the two would delete bytes a peer is about to point at.
  Two defenses, in order of importance:

  1. **Grace window (the real one).** Blobs carry `createdAt`; anything younger
     than `graceMinutes` (default 60) is spared regardless of reachability.
  2. **Global lock**, held for the sweep's duration — defense in depth only.
     Swamp core does not funnel every write through it. A real sweep that held
     the lock still lost one blob to a concurrent push, which is why the grace
     window exists. Blobs written before 2026.08.19.1 have no `createdAt` and
     are always eligible, so the first sweep after upgrading is the risky one:
     run it when the cluster is quiet.

  Concretely: a namespace that is **actively written** and whose blobs **all
  predate `createdAt`** has no protection at all — every unreferenced blob looks
  eligible, including one a push inserted a second ago. Either quiesce the
  writer first, or set `skipBlobs: true` to take just the tombstones (which have
  no such race) and come back for the bytes during a maintenance window.

  A dangling reference is not fatal — pull skips a path whose blob is missing,
  and the owning host re-uploads the bytes on its next full walk, since the push
  probes blob existence independently of the path diff. Do **not** "fix" one by
  tombstoning the path: that deletes the owning host's local copy on its next
  pull.

- **Tombstone pruning.** Always runs as part of `sweep`, before the blob pass —
  tombstones are not blob references, so dropping them never strands bytes, and
  doing it first lets the blob pass collect whatever they were the last trace
  of. A tombstone is how a deletion reaches peers — pull sees `deletedAt` and
  unlinks the local copy — so `_paths` accumulates them forever. On one real
  repo they were 855,438 docs against 21,171 live.

  Pruned tombstones are hard-deleted, which makes the deletion **invisible**: a
  peer whose `lastPulledAt` predates it never learns the file is gone and will
  re-upload it on its next full walk. The grace window (`tombstoneDays`,
  default 30) must therefore exceed the longest gap between any peer's syncs —
  the same trade-off as Cassandra's `gc_grace_seconds`, with the same failure
  mode if set too low. A host dormant longer than the window should be
  re-bootstrapped rather than allowed to push.

- **Reclaiming disk after a sweep.** Deleting documents returns space to
  WiredTiger's free list, not to the filesystem — a swept cluster still reports
  its old disk usage until compacted. `_blobs` sat at 44.4 GB allocated with
  44.1 GB reusable; compacting took it to 185 MB.

  ```bash
  swamp model method run datastore-maintenance compact
  ```

  The method issues `compact` with `force: true`, which is required on a
  replica-set primary and slows concurrent operations for its duration — it is
  the slow step of the workflow (15 minutes on a 44 GB collection), so run it
  when the cluster is quiet. Collections holding less than `minReusableMb`
  (default 1) are skipped.

- **Version retention is swamp's job, not the datastore's.** The largest sync
  costs come from unbounded data versions, which this extension faithfully
  mirrors. Check `garbageCollection` on your model types' output specs and run
  `swamp data gc` — on one real repo that took `data/` from 229,598 files to
  1,258. `autoGc: true` in `.swamp.yaml` did **not** keep up; schedule it.

- **Run all of the above as a workflow.** The extension ships a companion model
  type, `@magistr/mongodb-datastore/maintenance`, so reclamation composes into
  swamp rather than sitting in a shell script beside it. A `DatastoreProvider`
  has no method surface a workflow can call; this model closes that gap, using
  the same sweep functions the CLI uses.

  ```bash
  swamp vault create local_encryption datastore-vault
  swamp vault put datastore-vault MONGO_PASSWORD

  swamp model create @magistr/mongodb-datastore/maintenance datastore-maintenance \
    --global-arg uri='mongodb://mongo.example.com:27017/?replicaSet=rs0&authSource=admin' \
    --global-arg username=swamp-user \
    --global-arg 'password=${{ vault.get(datastore-vault, MONGO_PASSWORD) }}' \
    --global-arg database=swamp --global-arg tenantId=my-org

  swamp workflow run @magistr/datastore-maintenance
  ```

  Three methods, each fanning out over every namespace in one execution —
  looping `model method run` against a single model serializes on its lock:

  | Method      | Does                                                                  |
  | ----------- | --------------------------------------------------------------------- |
  | `inventory` | Live paths, tombstones, blobs, allocated vs reusable bytes, idle days |
  | `sweep`     | Prune tombstones past grace + blobs no live path references           |
  | `compact`   | Return freed space to the filesystem                                  |

  `sweep` defaults to `dryRun: true` — opt in to deletion. It also refuses to
  sweep blobs in a namespace that is both actively written and holding only
  pre-`createdAt` blobs, recording `blobsSkipped` and `skipReason` in its output
  instead of racing an in-flight push.

  Results are ordinary swamp data, tagged with workflow provenance:

  ```bash
  swamp data query 'modelName == "datastore-maintenance" && specName == "sweep"'
  ```

  This is the piece that prevents a repeat. The incident that motivated the
  2026.08.19.1 rewrite was not a protocol bug — it was retention drift nobody
  was watching. Pair it with `swamp data gc`, which is what actually keeps the
  corpus small; everything here cleans up after it.

## Migrating to 2026.09.03.1 (path layout + control plane)

Versions before 2026.09.03.1 stored the cache-relative path — core namespace
included — as the remote id, so a client with a core namespace wrote
`<ns>/data/…` while a client without one wrote `data/…`, and neither saw the
other's writes. The new layout is tier-relative everywhere. Pull tolerates both
during the transition (newer `updatedAt` wins, tie to the bare id); the
`fold_namespace_prefix` maintenance method retires the prefixed docs.

Every migration is journaled (`_migrations`, `_migration_ops`) and revertable
with `revert_migration`. Blobs are never touched; prefixed docs are tombstoned,
never removed.

Runbook, in order:

1. Stop every client still on the old version (the fold guard refuses while a
   prefixed doc was written in the last 30 minutes or a client stamped with an
   older version synced in the last 24 hours).
2. Upgrade every client (Macs and serve) to this version.
3. `swamp model method run datastore-maintenance fold_namespace_prefix --input
   '{"legacyPrefix":"<core namespace>"}'`
   — `legacyPrefix` is the core `datastore.namespace` the old clients wrote
   (`dev-tmp-swamp` here). It defaults to the config namespace, which is only
   right when the two are equal. Dry run by default; read the counts, then
   re-run with `"dryRun":false`. Keep the `runId` from the `migration` resource.
4. Inside the serve container, before its first restart on this version:
   `import_control_records` with
   `controlDir=/workspace/.swamp/datastore/_control` and `coreNamespace` set to
   serve's core namespace (empty if unset). It copies — never moves — serve's
   filesystem control records, including the token secrets, so existing worker
   and access tokens keep working.
5. Restart serve. `/ready` should report `deploymentMode: durable`;
   `swamp datastore status` should show `coreNamespace` and no TLS warning.

Rollback, in order: `revert_migration` for the import run, then for the fold run
(dry run first; conflicts are records a client wrote after the migration and are
skipped unless `force`), then `prefix_namespace` with `since` = the fold run's
`startedAt` to give post-upgrade writes a prefixed twin, then pin the previous
extension version and restart serve. The old version reads its filesystem
control records again because the import never removed them. The new version
never deletes old root-tier files from a cache, so a downgraded client finds
them where it left them.

Journal retention: `sweep` prunes migration runs older than the tombstone grace
window (30 days by default) — revert within that window.

## Important Information

- **Vault secrets do not travel.** Swamp's `local_encryption` vault reads and
  writes `<repoDir>/.swamp/secrets/...` on local disk regardless of datastore.
  This extension excludes the `secrets/` tier from sync entirely — neither the
  symmetric `.key` files nor their `.enc` ciphertext are ever pushed to MongoDB,
  and any `secrets/*` docs left in the remote by an older version are skipped on
  pull. Vault contents stay per-host; use a non-local (KMS-backed) vault if you
  need cross-host secrets.

  > **Security note (versions ≤ 2026.05.25.1):** earlier releases listed
  > `secrets` in the synced tier, so a repo that switched to this datastore
  > pushed every vault `.key` next to its `.enc` ciphertext into the shared
  > MongoDB — anyone with read access could decrypt them (CVE-class
  > encryption-at-rest defeat). After upgrading, **rotate every secret that was
  > synced** and purge the leaked docs from MongoDB, e.g.:
  >
  > ```js
  > // hashes of the now-orphaned secret blobs, to drop after tombstoning paths
  > const hashes = db["<prefix>_paths"].find(
  >   { _id: /^secrets\// },
  >   { hash: 1 },
  > ).map((d) => d.hash);
  > db["<prefix>_paths"].deleteMany({ _id: /^secrets\// });
  > db["<prefix>_blobs"].deleteMany({ _id: { $in: hashes } });
  > ```
- **TTL must exceed your critical section.** The lock's nonce fences `release` /
  `forceRelease` only; it does not fence writes performed inside the critical
  section. If a holder pauses past TTL, another process can legitimately take
  over while the first still believes it holds the lock. Size `defaultLockTtlMs`
  with margin.
- **`swamp datastore setup` can OOM on large existing `.swamp/` trees.** Swamp
  core's migrator reads the tree into memory; at ~1 GB / ~100k files it dies.
  Purge `.swamp/` first, or use `--skip-migration` and let workflows repopulate.
- **Host-local files are never synced.** `*.db`, `*.db-wal`, `*.db-shm` (swamp's
  SQLite catalogs) and in-flight `*.tmp.<pid>.<uuid>` staging files are excluded
  on both legs. A `-shm` file is a mmap'd shared-memory region that means
  nothing off the machine that made it, and both it and `-wal` churn on every
  command — syncing them re-uploaded a blob per invocation for bytes no peer
  could correctly consume.
- **Two watermarks, not one.** `lastPulledAt` tracks hydrated content and drives
  pull; `lastReconciledAt` tracks when this cache last enumerated the complete
  remote path list and drives the push tombstone pass. They must stay separate:
  a push stamps `updatedAt = now` on every path it writes, so those docs sort
  newer than `lastPulledAt` and the tombstone pass — which skips anything newer,
  to protect a peer's concurrent writes — would refuse to ever delete them. The
  symptom is a host that cannot propagate deletion of data it pushed itself:
  `swamp data gc` prunes locally and the remote keeps every version.

## Related

[`@keeb/mongodb`](https://github.com/keeb/swamp-mongodb) — sibling extension for
querying MongoDB collections from swamp workflows. Different extension (a
_model_ , not a datastore).

## Development

Contributor notes: [CLAUDE.md](CLAUDE.md) and [SWAMP.md](SWAMP.md).

## License

MIT.
