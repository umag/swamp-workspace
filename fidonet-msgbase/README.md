# @magistr/fidonet-msgbase

A read-only FidoNet message base reader for swamp. It parses classic echomail
and netmail stores directly off disk — JAM (`.jhr`/`.jdx`/`.jdt`), Squish
(`.sqd`/`.sqi`), and FTS-0001 `.msg` files — without any external tooling. Areas
are listed with their message counts, individual areas and the netmail folder
can be read, and every area can be searched by sender name, FidoNet address, or
free text. Bodies are decoded as UTF-8 with an automatic fall back to CP866 so
legacy Cyrillic messages render correctly, and origin lines and node/point
addresses are extracted from the message text.

## Configuration

The model takes a single global argument, `basePath`, pointing at the directory
that holds the message base files. JAM/Squish area files live directly in this
directory; netmail `.msg` files are expected under a `netmail/` subdirectory.

```yaml
type: "@magistr/fidonet-msgbase"
typeVersion: "2026.03.29.1"
name: fidonet
globalArguments:
  basePath: "/path/to/msgbase"
methods: {}
```

## Usage

```bash
# List all areas with message counts and detected format
swamp model method run fidonet listAreas

# Read the first 100 messages of an area
swamp model method run fidonet readArea --input area=fido.general --input limit=100

# Read netmail (FTS-0001 .msg files under basePath/netmail)
swamp model method run fidonet readNetmail

# Search every area by sender, FidoNet address, or text
swamp model method run fidonet searchBySender --input sender="John Doe"
swamp model method run fidonet searchByAddress --input address=2:5020/1
swamp model method run fidonet searchByText --input text="hello world"

# Turn a stored result set into Obsidian markdown notes
swamp model method run fidonet formatForObsidian --input source=netmail
```

## Methods

- `listAreas` — enumerate JAM/Squish areas plus netmail, sorted by count.
- `readArea` — read one area (`area`, `limit`, `offset`).
- `readNetmail` — read the netmail folder (`limit`, `offset`).
- `searchBySender` — partial, case-insensitive sender match across all areas.
- `searchByAddress` — match a full node (`2:5020/1`) or point (`2:5020/1.28`).
- `searchByText` — case-insensitive body/subject/sender text search.
- `formatForObsidian` — render a stored result set as Obsidian notes.

## Reports

Both reports run on method output and are wired into the model:

- `@magistr/fidonet-summary` — area stats, top senders, date range, and a
  monthly message distribution.
- `@magistr/fidonet-messages` — renders the found messages as readable Markdown,
  stripping kludges, tearlines, and SEEN-BY control lines.

## License

MIT — see [LICENSE.md](LICENSE.md).
