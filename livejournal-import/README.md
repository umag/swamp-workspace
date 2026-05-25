# @magistr/livejournal-import

A swamp model that imports a LiveJournal blog into an Obsidian vault. It walks
the journal index, fetches every entry in light format, converts the post HTML
to Markdown, downloads inline images as vault attachments, and writes one
Markdown note per post. Each note carries YAML frontmatter with the title,
date, source URL, LiveJournal post id, tags, and (when present) the entry's
mood and now-playing fields. Reader comments are extracted and appended to the
note under a Comments section. The model writes a per-post data resource plus a
final import summary (total posts, notes created, images copied, and any
errors). It relies on the local `obsidian` CLI to resolve the vault path and to
create notes.

## Configuration

Set the model's global arguments to point at the source journal and the target
vault:

```yaml
type: "@magistr/livejournal/import"
typeVersion: "2026.03.29.1"
name: livejournal-import
globalArguments:
  # The LiveJournal blog to import
  journalUrl: "https://username.livejournal.com/"
  # Obsidian vault name (resolved via the obsidian CLI)
  vault: "my-vault"
  # Target folder inside the vault (default: LiveJournal)
  folder: "LiveJournal"
  # Attachments subfolder for downloaded images (default: attachments)
  attachmentsFolder: "attachments"
methods: {}
```

## Usage

Run the single `import` method to fetch every entry and write the notes:

```bash
swamp model method run livejournal-import import
```

Inspect the import summary and per-post records afterwards:

```bash
swamp data query livejournal-import result
swamp data query livejournal-import post
```

## Requirements

- The `obsidian` CLI must be installed and able to resolve the target vault by
  name (used to look up the vault filesystem path and to create notes).
- Network access to the source LiveJournal site.
