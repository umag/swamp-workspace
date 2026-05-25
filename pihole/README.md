# @magistr/pihole

Pi-hole custom DNS record management for
[swamp](https://github.com/systeminit/swamp). List, add, delete, and
**declaratively sync** local DNS A-records on a [Pi-hole](https://pi-hole.net/)
v6 (FTL) appliance.

## Model

| Type              | What it manages                                                                 |
| ----------------- | ------------------------------------------------------------------------------- |
| `@magistr/pihole` | Custom DNS host records: list, add, add-record, delete-record, sync, sync-clean |

## globalArguments

| Field      | Required | Default | Description                                                                                          |
| ---------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `host`     | yes      | —       | Pi-hole host, e.g. `pihole.local` or `10.0.0.53`. May include a scheme/port (`https://pi.lan:8443`). |
| `password` | yes      | —       | Pi-hole web password. **Use a vault reference** — see below.                                         |
| `scheme`   | no       | `http`  | `http` or `https`. Use `https` so the password is not sent in cleartext.                             |
| `caCert`   | no       | —       | Inline PEM CA certificate to trust a self-signed Pi-hole HTTPS cert.                                 |
| `records`  | no       | —       | Declarative list of `{ ip, hostname }` used by `add`, `sync`, `sync-clean`.                          |

## Methods

| Method          | Arguments        | Description                                                                                       |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `list`          | —                | List all custom DNS records → `dns-records` resource.                                             |
| `add`           | —                | Add every record in `records` (idempotent: already-present records report `unchanged`/`success`). |
| `add-record`    | `ip`, `hostname` | Add a single record (idempotent).                                                                 |
| `delete-record` | `ip`, `hostname` | Delete a single record (idempotent: an absent record reports success).                            |
| `sync`          | `deleteExtras?`  | Add records from `records` that are missing; optionally delete extras.                            |
| `sync-clean`    | —                | Declarative converge: add missing **and** delete anything not in `records`.                       |

`add`, `sync`, and `sync-clean` are **best-effort**: every record is attempted,
per-record failures are captured in the result resource (with a redacted error),
and the method then throws if any operation failed — so a workflow `succeeded`
gate still reflects reality while the audit artifact is always written.

## Setup

```bash
# 1. Store the web password in a vault (never inline it)
swamp vault create local_encryption my-vault --json
swamp vault put my-vault PIHOLE_PASSWORD=your-pihole-password -f --json

# 2. Create and configure the model instance
swamp model create @magistr/pihole my-dns --json
swamp model edit my-dns --json <<'EOF'
globalArguments:
  host: "10.0.0.53"
  scheme: "http"
  password: "${{ vault.get(my-vault, PIHOLE_PASSWORD) }}"
  records:
    - { ip: "10.0.0.10", hostname: "nas.lan" }
    - { ip: "10.0.0.20", hostname: "printer.lan" }
EOF

# 3. Read state, then converge
swamp model method run my-dns list --json
swamp model method run my-dns sync --json
```

## Authentication & HTTPS

The web password is authenticated against the FTL API. **It is marked
sensitive** and is never persisted in cleartext; captured API error bodies are
redacted before they are logged or stored.

- **`scheme: http` (default)** sends the password over an unencrypted
  connection. Acceptable on a trusted LAN, but you will see a runtime warning.
  Prefer `https`.
- **`scheme: https`** with a publicly-trusted certificate needs nothing extra.
- **Self-signed HTTPS**: paste the appliance's CA certificate (PEM contents, not
  a path) into `caCert`:

  ```yaml
  globalArguments:
    host: "pi.lan"
    scheme: "https"
    caCert: |
      -----BEGIN CERTIFICATE-----
      MIIB...
      -----END CERTIFICATE-----
    password: "${{ vault.get(my-vault, PIHOLE_PASSWORD) }}"
  ```

  There is intentionally **no option to disable certificate verification** — use
  `caCert` to trust a self-signed appliance instead.

Every FTL session is released (`DELETE /api/auth`) after each method runs, so
long-running automation never exhausts Pi-hole's concurrent-session limit.

## Resources produced

- `dns-records` — `{ records[], count, timestamp }`
- `add-result` / `delete-result` —
  `{ results: [{ ip, hostname, success, error? }], succeeded, failed, timestamp }`
- `sync-result` —
  `{ added[], deleted[], unchanged[], failed: [{ ip, hostname, error }], summary, timestamp }`

Reference results downstream with CEL, e.g.
`data.latest("my-dns", "dns-records").attributes.count`.

## Migration from `@pihole/dns`

Earlier releases of this package used the model type **`@pihole/dns`**. To pass
swamp's collective-match validation the type is now **`@magistr/pihole`** (it
matches the package collective). This is a breaking change — a model instance is
bound to its type, so an existing instance must be re-created. Migration is
lossless if you reuse the same instance name:

```bash
# 1. Install the new package (keep any old @pihole/dns model installed for now)
swamp extension pull @magistr/pihole

# 2. Capture the FULL existing config — host, vault-ref password, every record, tags
swamp model get <instance-name> --json   # copy globalArguments verbatim

# 3. Re-create under the new type with the SAME name so workflows that reference
#    the instance by name keep working
swamp model delete <instance-name>
swamp model create @magistr/pihole <instance-name>
swamp model edit <instance-name> --json <<'EOF'
globalArguments:
  host: "..."                # from step 2
  password: "${{ vault.get(...) }}"
  records: [ ... ]           # ALL records from step 2
EOF

# 4. Re-populate data and verify
swamp model method run <instance-name> list --json

# 5. Update any consumers that hardcode the old type string (dashboards, docs),
#    then remove the old @pihole/dns extension source.
```

**Output-shape change:** `add-record` previously wrote top-level
`{ hostname, ip, success }`. It now writes the unified `results[]` shape, so any
external/manual consumer reading `.success` should read `.results[0].success`.

## License

[MIT](./LICENSE.md)
