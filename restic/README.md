# @magistr/restic

Run [restic](https://restic.net) backups through swamp. Every method writes a
versioned resource, so backup history, integrity checks and repository growth
are queryable with `swamp data query` and usable from workflows via CEL.

## Requirements

- `restic` >= 0.17 on the machine that runs the method (`brew install restic`).
- On macOS, grant the `restic` binary **Full Disk Access** (System Settings →
  Privacy & Security), or backups of `~/Library`, Mail, Photos etc. finish with
  `complete: false` and permission errors.

## Instance

Keep secrets in a vault and reference them with `vault.get`:

```yaml
type: "@magistr/restic"
typeVersion: 2026.09.29.1
name: mac-backup
globalArguments:
  repository: rest:http://backup.example.lan:8000/laptop/
  password: ${{ vault.get(restic, RESTIC_PASSWORD) }}
  restUsername: laptop # plain: swamp masks every vault value in stored data
  restPassword: ${{ vault.get(restic, REST_PASSWORD) }}
  paths: ["/Users/me"]
  excludes: ["/Users/me/Library/Caches", "**/node_modules", "**/.Trash"]
  tags: ["mac"]
methods: {}
```

## Methods

| Method      | Changes repo | Resource        | Notes                                            |
| ----------- | ------------ | --------------- | ------------------------------------------------ |
| `status`    | no           | `repoStatus`    | initialized, snapshot count, `latestAgeHours`    |
| `init`      | yes          | `initResult`    | idempotent (`already-initialized`)               |
| `backup`    | yes          | `backupSummary` | exit 3 → `complete: false` + `errors[]`          |
| `snapshots` | no           | `snapshotList`  | `host`, `tag`, `latest` filters                  |
| `check`     | no           | `checkResult`   | `readDataSubset: "5%"`; failure → `ok: false`    |
| `forget`    | yes          | `forgetResult`  | `dryRun` defaults to **true**; needs a keep rule |
| `stats`     | no           | `statsResult`   | `mode: raw-data` by default                      |

## Workflow

Read state first, create the repository only if needed, back up, then verify:

```yaml
jobs:
  - name: backup
    steps:
      - name: status
        task: {
          type: model_method,
          modelIdOrName: mac-backup,
          methodName: status,
        }
        dependsOn: []
        weight: 0
      - name: init
        task: {
          type: model_method,
          modelIdOrName: mac-backup,
          methodName: init,
        }
        dependsOn: [{ step: status, condition: { type: succeeded } }]
        weight: 0
      - name: backup
        task: {
          type: model_method,
          modelIdOrName: mac-backup,
          methodName: backup,
        }
        dependsOn: [{ step: init, condition: { type: succeeded } }]
        weight: 0
    dependsOn: []
    weight: 0
```

## Append-only rest-server

Run rest-server with `--append-only` so a compromised client cannot delete its
own backups. `backup`, `snapshots`, `check` and `stats` work; `forget` fails by
design. Apply retention server-side against the local path (a second instance
with `repository: /data/laptop`).

## Security

The repository password and rest-server credentials are passed only as
`RESTIC_PASSWORD` / `RESTIC_REST_USERNAME` / `RESTIC_REST_PASSWORD` environment
variables — never on the command line — and are replaced with `***` in every
error message and recorded file error.
