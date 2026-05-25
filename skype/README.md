# @magistr/skype

A swamp model that reads a desktop Skype SQLite database (`main.db`) and turns
it into queryable swamp data. It lists the profiles found under a Skype data
directory, enumerates conversations with message counts, lists contacts, reads a
single conversation, searches messages by sender or text, and exports every
conversation as Markdown chat logs (for Obsidian) either as swamp data or written
straight into a vault directory. All reads are done via the `sqlite3` CLI, so
`sqlite3` must be on `PATH`.

## Requirements

- The `sqlite3` command-line tool installed and on `PATH`.
- A Skype data directory containing one or more profile subdirectories, each
  with a `main.db` SQLite file.

## Configuration

The model takes two global arguments: `basePath` (the Skype data directory that
holds profile subdirectories) and `profile` (the profile directory name to read).

```yaml
type: "@magistr/skype"
typeVersion: "2026.03.29.1"
name: skype
globalArguments:
  basePath: "/path/to/skype/profile"
  profile: "your-skype-name"
methods: {}
```

## Methods

- `listProfiles` — list profile directories under `basePath` that contain a
  `main.db`.
- `listConversations` — list conversations with message counts (arg
  `minMessages`, default 1), ordered by last activity.
- `listContacts` — list permanent contacts.
- `readConversation` — read messages from one conversation (args `conversation`,
  `limit` default 500, `offset` default 0).
- `searchBySender` — find messages from a sender, partial match (args `sender`,
  `limit` default 200).
- `searchByText` — full-text search across message bodies (args `text`, `limit`
  default 200).
- `exportToObsidian` — format every conversation as an Obsidian note and emit it
  as swamp data (args `folder` default `Skype`, `minMessages` default 1).
- `importToObsidian` — same, but write the notes directly into a vault directory,
  chunking large conversations (args `folder`, `vaultPath`, `minMessages`).

## Usage

```bash
# Discover available profiles
swamp model method run skype listProfiles

# List conversations with at least 5 messages
swamp model method run skype listConversations --input minMessages=5

# Search all messages for some text
swamp model method run skype searchByText --input text="lunch"

# Export everything into an Obsidian vault folder
swamp model method run skype importToObsidian \
  --input vaultPath=/path/to/obsidian/vault --input folder=Skype
```
