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
swamp extension pull @keeb/mongodb-datastore
```

**2. Add it as the datastore in your repo's `.swamp.yaml`:**

```yaml
datastore:
  type: "@keeb/mongodb-datastore"
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
- **Health verifier.** Rejects non-replica-set clusters and reports
  primary/secondary state, latency, and namespace.

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

## Related

[`@keeb/mongodb`](https://github.com/keeb/swamp-mongodb) — sibling extension for
querying MongoDB collections from swamp workflows. Different extension (a
_model_ , not a datastore).

## Development

Contributor notes: [CLAUDE.md](CLAUDE.md) and [SWAMP.md](SWAMP.md).

## License

MIT.
