# @magistr/obsidian-vault

A swamp model that manages an [Obsidian](https://obsidian.md) vault through the
official Obsidian CLI (v1.12+). It wraps the `obsidian` binary to read and write
notes, run full-text searches, list and filter tags, inspect outgoing links and
backlinks, find orphans and unresolved links, manage today's daily note, and
read or mutate frontmatter properties. Every method writes its result into a
typed swamp data resource so you can query it with CEL afterwards.

## Requirements

- The official Obsidian CLI (`obsidian`) v1.12 or newer on `PATH`.
- A configured Obsidian vault (the `vault` global argument is its registered
  vault name).

## Configuration

The model has a single global argument: `vault`, the registered Obsidian vault
name to operate on.

```yaml
type: "@magistr/obsidian/vault"
typeVersion: "2026.03.28.2"
name: my-vault
version: 1
tags: {}
globalArguments:
  vault: "my-vault"
methods: {}
```

## Usage

```bash
# Create the model instance and point it at your vault
swamp model create @magistr/obsidian/vault my-vault --json
swamp model edit my-vault --json <<'EOF'
{ "globalArguments": { "vault": "my-vault" } }
EOF

# List all notes
swamp model method run my-vault list --json

# Read a note
swamp model method run my-vault read --input file="folder/note.md" --json

# Full-text search with matching line context
swamp model method run my-vault search --input query="project plan" --json

# Create a note
swamp model method run my-vault create \
  --input name="inbox/idea.md" --input content="# Idea" --json

# Append to today's daily note
swamp model method run my-vault dailyAppend --input content="- did a thing" --json

# Set a frontmatter property
swamp model method run my-vault propertySet \
  --input file="note.md" --input name="status" --input value="active" --json
```

## Methods

File operations: `list`, `read`, `fileInfo`, `create`, `append`, `prepend`,
`delete`, `move`.

Search: `search` (full-text with line context).

Tags: `tags` (all tags, optional counts), `tag` (files with a given tag).

Links: `links` (outgoing), `backlinks` (incoming), `orphans` (no incoming
links), `unresolved` (broken links).

Daily notes: `daily`, `dailyRead`, `dailyAppend`, `dailyPrepend`.

Properties (frontmatter): `properties`, `propertySet`, `propertyRemove`.

## License

MIT — see [LICENSE.md](./LICENSE.md).
