# @magistr/jabber

Read, search, and import Psi/Psi+ Jabber (XMPP) chat history — both direct
messages (DMs) and multi-user conference (MUC) rooms — into an Obsidian vault as
markdown notes. The model parses the two on-disk log formats Psi/Psi+ produce:
pipe-delimited `.history` files (used for DMs and bare conference logs) and the
human-readable `account_in_room` plain-text conference logs that carry sender
nicknames. JIDs are decoded from the filename-safe `_at_` encoding, conferences
prefer the nickname-bearing plain-text logs when both exist, and the importer
writes one front-mattered markdown note per conversation grouped by day.

## Configuration

The only global argument is `historyDir` — the path to your Psi/Psi+ profile
directory. The model appends `/history` internally, so point `historyDir` at the
profile root (the directory that contains the `history/` subfolder).

```yaml
type: "@magistr/jabber/history"
version: "2026.03.29.3"
globalArguments:
  historyDir: "/path/to/psi/profile"
```

## Methods

- `list` — list all conversations (filter with
  `chatType: all | dm | conference`) with per-conversation message counts and
  first/last timestamps.
- `read` — read messages from conversations matching a `jid` substring; `limit`
  caps the number of returned messages (0 = all).
- `search` — full-text search message bodies across conversations; supports
  `chatType` filtering and a `limit` on results.
- `importToObsidian` — write each conversation as a markdown note. Provide
  either `vault` (resolved via the `obsidian` CLI) or `vaultPath` (a direct
  filesystem path); `folder` sets the in-vault target folder (default `Jabber`).

## Usage

```bash
# List every conversation with message counts
swamp model method run jabber list

# Read a single conversation by JID substring
swamp model method run jabber read --input jid=alice@jabber.example

# Search all DMs for a phrase
swamp model method run jabber search --input query="release" --input chatType=dm

# Import everything into an Obsidian vault folder
swamp model method run jabber importToObsidian \
  --input vaultPath=/path/to/obsidian/vault --input folder=Jabber
```

Each imported note carries YAML front matter (`title`, `type`, `jid`, message
count, first/last dates, and `jabber` tags) and groups messages under `### date`
headings, so the archive is searchable and linkable inside Obsidian.
