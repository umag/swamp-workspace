# @magistr/musicbrainz

A swamp model for the [MusicBrainz](https://musicbrainz.org) open music
encyclopedia. Search, look up, and browse artists, release groups, releases,
recordings, and labels through the MusicBrainz Web Service v2 (JSON), with a
built-in 1 request/second rate limiter so you stay within the MusicBrainz usage
policy. Also includes Bandcamp-to-MusicBrainz helpers that scrape a Bandcamp
discography and generate release-editor seed URLs for releases that are missing
from MusicBrainz.

## Configuration

The model has a single required global argument, `userAgent`. MusicBrainz
**requires** a descriptive, application-identifying User-Agent string that
includes a contact address; requests without one may be blocked.

```yaml
type: "@magistr/musicbrainz"
typeVersion: "2026.05.25.1"
name: musicbrainz
globalArguments:
  userAgent: "MyApp/1.0.0 (contact@example.com)"
methods: {}
```

## Methods

| Method                  | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `search-artist`         | Search artists by name or Lucene query                      |
| `search-release-group`  | Search release groups (albums/EPs/singles)                  |
| `search-release`        | Search releases                                             |
| `search-recording`      | Search recordings (tracks)                                  |
| `search-label`          | Search record labels                                        |
| `search`                | Generic search over any entity type                         |
| `lookup-artist`         | Look up an artist by MBID (with optional `inc` includes)    |
| `lookup-release-group`  | Look up a release group by MBID                             |
| `lookup-release`        | Look up a release by MBID                                   |
| `lookup-recording`      | Look up a recording by MBID                                 |
| `lookup-label`          | Look up a label by MBID                                     |
| `browse-release-groups` | Browse release groups by artist MBID                        |
| `browse-releases`       | Browse releases by artist, label, or release-group MBID     |
| `browse-recordings`     | Browse recordings by artist or release MBID                 |
| `seed-from-bandcamp`    | Generate a MusicBrainz seed URL from one Bandcamp album     |
| `find-missing`          | Compare a Bandcamp discography to MusicBrainz, list missing |
| `seed-all-missing`      | Generate seed URLs for all missing releases of an artist    |

## Usage

```bash
# Search for an artist by name
swamp model method run musicbrainz search-artist --input query="Boards of Canada"

# Look up a release with its recordings and artist credits
swamp model method run musicbrainz lookup-release \
  --input id=<RELEASE_MBID> --input inc="recordings+artist-credits+labels"

# Browse all release groups for an artist
swamp model method run musicbrainz browse-release-groups --input artist=<ARTIST_MBID>

# Find releases on a Bandcamp page that are missing from MusicBrainz
swamp model method run musicbrainz find-missing \
  --input bandcampUrl="https://artist.bandcamp.com"
```

Results are written to swamp data and can be queried with CEL, e.g.
`data.latest("musicbrainz", "artists").attributes.artists`.

## License

MIT — see [LICENSE.md](LICENSE.md).
