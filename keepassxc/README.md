# @magistr/keepassxc

A swamp vault whose secrets live in your **KeePassXC** database. It talks to the
running KeePassXC GUI through the Browser Integration protocol — the same
channel the KeePassXC-Browser extension uses — via the `keepassxc-proxy` binary
that ships with KeePassXC. No master password is stored anywhere.

## How secrets are stored

Each swamp secret is one KeePassXC entry:

| Entry field | Value                                               |
| ----------- | --------------------------------------------------- |
| URL         | `swamp://<namespace>/<percent-encoded key>`         |
| Username    | the swamp secret key                                |
| Password    | the secret value (multi-line is fine)               |
| Group       | `group` config (default `swamp`)                    |
| Title       | the namespace (KeePassXC sets it from the URL host) |

`list()` returns every username whose URL host is `swamp://<namespace>`, so
several vaults can share one database without seeing each other's keys.

## Prerequisites

1. KeePassXC running, database unlocked.
2. **Settings → Browser Integration → Enable browser integration** ticked (no
   browser needs to be selected).
3. Recommended, under **Browser Integration → Advanced**:
   - _Never ask before accessing credentials_ — otherwise every new entry pops
     an "allow access" dialog the first time it is read.
   - _Never ask before updating credentials_ — otherwise every changed value
     asks for confirmation.
   - Leave _Return only best-matching credentials_ **off**; `list()` relies on
     host-level matching.

## Setup

```bash
swamp extension pull @magistr/keepassxc
swamp vault create @magistr/keepassxc keepass --config '{"group":"swamp"}'
swamp vault list-keys keepass   # first call: KeePassXC asks to name the connection
```

The first call shows KeePassXC's **new key association request**. Name it (e.g.
`swamp`) and click Save. The association key is written to
`~/.config/swamp/keepassxc/<vault>.json` with mode `0600`; later calls reuse it
silently. To revoke access, remove the connection in **Database → Database
Settings → Browser Integration** and delete that file.

## Use

```bash
swamp vault put keepass GITHUB_TOKEN  # prompts for the value (hidden input)
swamp vault get keepass GITHUB_TOKEN
```

```yaml
globalArguments:
  token: ${{ vault.get("keepass", "GITHUB_TOKEN") }}
```

## Configuration

| Key                 | Default                                  | Meaning                                        |
| ------------------- | ---------------------------------------- | ---------------------------------------------- |
| `namespace`         | vault name, lowercased, `[^a-z0-9]`→`-`  | Host part of entry URLs                        |
| `group`             | `swamp`                                  | Group path for new entries (`Infra/swamp` ok)  |
| `proxyPath`         | macOS app bundle, else `keepassxc-proxy` | The proxy binary                               |
| `associationFile`   | `~/.config/swamp/keepassxc/<vault>.json` | Where the association key is kept              |
| `timeoutSeconds`    | `120`                                    | Per-request wait (covers answering dialogs)    |
| `triggerUnlock`     | `true`                                   | Show KeePassXC's unlock dialog when locked     |
| `unlockWaitSeconds` | `60`                                     | How long to retry while the database is locked |

## Limits

- Needs the GUI: this backend cannot run on a headless `swamp serve` or CI. Use
  it for workstation secrets; keep server-side secrets in a server vault.
- The association belongs to the database that was active when it was made.
  Switching KeePassXC to another database makes calls fail with an association
  error until you switch back (or re-associate).
- The protocol cannot delete entries or set titles; remove entries in the GUI.
- If two entries in one namespace share a username, `get`/`put` refuse to guess
  and ask you to remove the duplicate.

## Security notes

- Traffic between swamp and KeePassXC is NaCl-box encrypted with per-session
  keys; reply nonces are checked to be the incremented request nonce.
- The association file is a credential: anyone who can read it can read this
  vault's entries **while your database is unlocked**. It is created `0600`
  inside a `0700` directory.
- Secret values never appear in error messages.
