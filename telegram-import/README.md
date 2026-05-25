# @magistr/telegram-import

A swamp model that imports a Telegram channel/chat export (a `result.json` zip
produced by Telegram Desktop's "Export chat history" feature) into an
[Obsidian](https://obsidian.md) vault. Each message becomes a Markdown note with
YAML frontmatter (date, channel, telegram id, forwarded-from, reply-to), and any
attached images, files (PDFs, etc.), and videos are copied into an attachments
folder and embedded with Obsidian `![[...]]` wikilinks. Telegram rich-text
entities (bold, italic, code, links, strikethrough) are converted to Markdown.
Service messages are skipped, and the model emits a per-import summary plus one
data record per imported post for downstream querying.

## Requirements

- The `obsidian` CLI on `PATH` (used to resolve the vault path and create
  notes), plus `unzip` and `find`.
- A Telegram export unpacked from `Export chat history` as a `.zip` containing
  `result.json`.

## Configuration

Configure the model instance with the export zip path and the target vault.
`folder` and `attachmentsFolder` default to `Telegram` and `attachments`.

```yaml
type: "@magistr/telegram/import"
typeVersion: "2026.03.28.2"
name: telegram-import
version: 1
globalArguments:
  zipPath: "/path/to/export.zip"
  vault: "my-vault"
  folder: "Telegram"
  attachmentsFolder: "attachments"
methods: {}
```

| Argument            | Required | Default        | Description                                       |
| ------------------- | -------- | -------------- | ------------------------------------------------- |
| `zipPath`           | yes      | —              | Path to the Telegram export zip file.             |
| `vault`             | yes      | —              | Obsidian vault name.                              |
| `folder`            | no       | `Telegram`     | Target folder in the vault for imported notes.    |
| `attachmentsFolder` | no       | `attachments`  | Attachments folder name inside the target folder. |

## Usage

Run the `import` method to parse the zip and write notes plus attachments:

```bash
swamp model method run telegram-import import
```

After it completes, inspect the import summary and the per-post records via the
swamp data tools:

```bash
swamp data query telegram-import result --json
swamp data query telegram-import post --json
```

## Outputs

- `result` — a single import summary (`channel`, `totalMessages`,
  `notesCreated`, `imagesCopied`, `filesCopied`, `errors`, `timestamp`).
- `post` — one record per imported message (`id`, `date`, truncated `text`,
  `photo`, `forwardedFrom`, `replyTo`, `timestamp`).

## License

MIT — see [LICENSE.md](LICENSE.md).
