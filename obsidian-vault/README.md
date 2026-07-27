# @magistr/obsidian-vault

A swamp model for an [Obsidian](https://obsidian.md) vault, with two
interchangeable backends.

The **filesystem backend** reads and writes a mounted vault directory and needs
nothing running — use it from `swamp serve`, cron, or a container. The **CLI
backend** drives the official `obsidian` binary and can do the things only
Obsidian's own index knows: tags, links, backlinks, orphans, unresolved links,
daily notes, and moves that rewrite wikilinks. It requires the desktop app to be
running.

Every method writes its result into a typed swamp data resource, so you can
query it with CEL afterwards.

## Headless quickstart

Set `vaultRoot` and file operations work with Obsidian closed:

```bash
swamp model create @magistr/obsidian/vault my-vault --json
# edit models/@magistr/obsidian/vault/<uuid>.yaml:
#   globalArguments:
#     vault: my-vault                 # registered vault name, for the CLI backend
#     vaultRoot: /path/to/vault       # enables the filesystem backend

swamp model method run my-vault list --input folder=Notes --input limit=20 --json
swamp model method run my-vault read --input file="Notes/idea.md" --json
swamp model method run my-vault search --input query="project plan" --json
swamp model method run my-vault digest --input folder=Notes --json
```

## Backends

| Global argument                            | Meaning                                                                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault`                                    | Registered Obsidian vault name. Required by the CLI backend. Also used to look up `vaultRoot` in Obsidian's own vault registry when `vaultRoot` is omitted.                                          |
| `vaultRoot`                                | Absolute path to the vault directory. Setting it enables the filesystem backend and takes precedence over the registry lookup.                                                                       |
| `backend`                                  | `auto` (default) picks `fs` when `vaultRoot` is set and `cli` otherwise; `cli` always shells to the Obsidian binary; `fs` always reads the directory and refuses methods that need Obsidian's index. |
| `blockDotObsidian`                         | Default `true`. Refuses to read or write inside `.obsidian` unless a method is called with `allowDotObsidian=true`.                                                                                  |
| `defaultFileMode` / `defaultDirectoryMode` | Permissions applied to files and directories the filesystem backend creates.                                                                                                                         |

If `vaultRoot` is omitted the model looks the vault up by name in Obsidian's
registry (`~/Library/Application Support/obsidian/obsidian.json` on macOS,
`~/.config/obsidian/obsidian.json` on Linux). The registry keeps pointing at a
vault's old location after you move the directory, so the resolved path is
verified to exist before use and the error names both the registry file and the
missing directory. **Passing `vaultRoot` explicitly is more reliable** and
avoids reading Obsidian's config directory at all.

### Which backend serves which method

| Method                                              | Filesystem | CLI | Notes                                                                                |
| --------------------------------------------------- | ---------- | --- | ------------------------------------------------------------------------------------ |
| `list`                                              | yes        | yes | `recursive` and `limit` are filesystem-side; the CLI list is filtered after the fact |
| `read`                                              | yes        | yes |                                                                                      |
| `fileInfo`                                          | yes        | yes | reports `exists: false` rather than failing                                          |
| `create`                                            | yes        | yes | reports `created` / `updated` / `unchanged`; `template` is CLI-only                  |
| `append`                                            | yes        | yes |                                                                                      |
| `prepend`                                           | yes        | yes |                                                                                      |
| `delete`                                            | yes        | yes | trashes to `.trash/` by default on both; `permanent` and `dryRun` supported          |
| `search`                                            | yes        | yes | `regex` and `caseSensitive` are filesystem-only                                      |
| `digest`                                            | yes        | —   | needs a vault directory                                                              |
| `properties`                                        | yes        | yes |                                                                                      |
| `propertySet`                                       | yes        | yes |                                                                                      |
| `setProperties`                                     | yes        | yes | one call, many properties                                                            |
| `propertyRemove`                                    | yes        | yes |                                                                                      |
| `move`                                              | —          | yes | Obsidian rewrites the wikilinks that point at the note                               |
| `tags`, `tag`                                       | —          | yes | needs Obsidian's tag index                                                           |
| `links`, `backlinks`                                | —          | yes | needs Obsidian's link index                                                          |
| `orphans`, `unresolved`                             | —          | yes | needs Obsidian's link index                                                          |
| `daily`, `dailyRead`, `dailyAppend`, `dailyPrepend` | —          | yes | needs Obsidian's daily-note configuration                                            |

Calling a CLI-only method while the desktop app is closed reports which method
needs the index and that `vaultRoot` cannot serve it. Under `backend=fs` the
same call fails immediately and names the closest headless alternative —
`digest` for `tags`, `search` for `backlinks`.

## Frontmatter

Frontmatter goes through a real YAML document, not line matching. Key order,
list style (block or flow), and comments all survive, and a note whose
properties do not change comes back byte-identical — which is what makes the
`unchanged` write action meaningful.

This matters more than it sounds. `tags:` and `aliases:` block lists are the
most common frontmatter Obsidian produces, and a scalar-only parser turns

```yaml
tags:
  - twitter
  - twitter-tweets
```

into `tags:` with the entries silently dropped. The `npm:yaml` dependency exists
for exactly this reason — do not swap it for a smaller hand-rolled parser.

```bash
# merge several properties in one call, preserving everything else
swamp model method run my-vault setProperties --input-file - <<'YAML'
file: Notes/idea.md
properties:
  status: active
  reviewed: true
  related:
    - alpha
    - beta
YAML
```

## digest

`digest` walks the vault once and writes a queryable structural digest instead
of making you read notes one at a time: per-note headings, wikilinks, inline
tags, PR and ticket references, word counts, and inferred dates, plus
signal-keyword rollups with the matching line as a citation.

```bash
swamp model method run my-vault digest \
  --input folder=Analysis \
  --input-file signals.yaml   # signalKeywords: [risk, blocked, decision]

swamp data query 'modelName == "my-vault" && name == "current"' \
  --select '{"files": attributes.fileCount, "rollups": attributes.signalRollups}' --json
```

**`maxBodyChars` defaults to `0` — no note text is retained.** Raising it copies
that many characters of every scanned note into the swamp data resource, which
syncs to whatever datastore the repo is configured with. Only raise it if you
are comfortable with the vault's contents living there.

`maxFiles` (default 2000) bounds the walk; when it or the search deadline trips,
the result carries `truncated: true` rather than silently stopping short.

## Safety

- **Path confinement.** Every filesystem method resolves its path against the
  vault root and refuses anything that escapes — `..` traversal, absolute paths
  outside the root, and any symlink encountered inside the vault. Refusing
  symlinks outright is deliberate: a link pointing at `~/.ssh` is invisible to
  string-level path math.
- **Hidden directories.** `list`, `search`, and `digest` skip dot-directories,
  so notes you deleted into `.trash/` do not reappear in results and `.obsidian`
  internals stay out of the data model. Pass `allowDotObsidian` to opt in.
- **Atomic writes.** Writes go to a temp file in the same directory and are then
  renamed, so a sync client never sees a half-written note.
- **Logging.** Vault-relative paths and counts only — never note content or
  frontmatter values.
- **Permissions.** Overwriting a note preserves its existing mode;
  `defaultFileMode` applies only to notes the model creates.
- **Ordering.** `list` and `search` return results sorted by vault-relative
  path, so output is stable across runs and `limit` truncates predictably. An
  unreadable subdirectory is skipped rather than aborting the walk; an
  unreadable root is reported.

Deno permissions: read and write on `vaultRoot`, plus read on Obsidian's config
directory if you rely on the registry lookup, plus subprocess execution for the
CLI backend.

## Known limitation

Four sibling models in this workspace — `@magistr/jabber`,
`@magistr/livejournal-import`, `@magistr/telegram-import`, and
`hugo-to-obsidian` — each carry their own copy of the Obsidian CLI invocation
and are still desktop-app-only. Only this model has the filesystem backend.

## Requirements

- For the filesystem backend: a readable vault directory. Nothing else.
- For the CLI backend: the official Obsidian CLI (`obsidian`) v1.12+ on `PATH`,
  with the desktop app running.

## License

MIT — see [LICENSE.md](./LICENSE.md).
