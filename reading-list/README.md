# @magistr/reading-list

A tiered reading list for a hand-picked set of writers. Reads the Swamp Club
feed first, then the Wardley-mapping crowd, and merges everything into one
priority-ordered digest.

Only article metadata and a short plain-text excerpt are stored — never full
article bodies.

## Install

```bash
swamp extension pull @magistr/reading-list
swamp model create @magistr/reading-list reading
```

The model ships with a curated default source set, so it works with no
configuration:

| Tier | Source                   | Kind       | Who                    |
| ---- | ------------------------ | ---------- | ---------------------- |
| 1    | `swamp-club`             | `rss`      | Swamp Club feed        |
| 2    | `joapen`                 | `rss`      | Joaquin Peña Fernández |
| 2    | `kdaniel`                | `rss`      | Chris Daniel           |
| 2    | `jon-ayre`               | `rss`      | Jon Ayre               |
| 2    | `adrianco`               | `rss`      | Adrian Cockcroft       |
| 2    | `simon-wardley-linkedin` | `linkedin` | Simon Wardley          |
| 2    | `simon-wardley-blog`     | `rss`      | Simon Wardley          |

Tier 1 leads the digest regardless of publication date; within a tier, newest
first.

## Use

```bash
# Read every source in one execution and build the digest
swamp model method run reading fetch

# What is in the reading list right now
swamp data get reading digest-latest --json

# Rebuild a filtered digest from stored feeds — no re-fetching
swamp model method run reading latest --input onlyNew=true
swamp model method run reading latest --input tier=1
swamp model method run reading latest --input sinceDays=7 --input limit=20
swamp model method run reading latest --input source=adrianco

# Show configured sources and tiers
swamp model method run reading sources
```

Find new authors from links you have already saved elsewhere — for example an mk
board of read-it-later cards:

```bash
swamp model method run reading discover \
  --input fromModelType=@magistr/mk \
  --input fromModelId=<mk model id> \
  --input specName=card \
  --input match=reading \
  --input minMentions=2

swamp data query 'modelName == "reading" && specName == "candidate" \
  && isLatest && attributes.feedUrl != null' \
  --select '{"host": attributes.host, "n": attributes.mentions,
             "feed": attributes.feedUrl}' --json
```

`discover` reads the other model's **stored** data — it never re-fetches the
source service. It groups saved links by host, drops aggregators that are not
authors (GitHub, arXiv, Amazon, …), flags hosts already configured, and probes
each remaining host for a feed via autodiscovery then the conventional paths.
Raise `minMentions` to separate authors you return to from one-off links.

Query the stored data directly with CEL:

```bash
swamp data query reading 'attributes.tier == 1' --json
swamp data query reading 'attributes.ok == false' --json
```

## Methods

| Method     | Description                                                                    |
| ---------- | ------------------------------------------------------------------------------ |
| `fetch`    | Read all enabled sources in one execution; write per-source feeds and a digest |
| `latest`   | Rebuild a filtered digest from stored feeds without re-fetching                |
| `discover` | Find candidate authors from links saved in another model's stored data         |
| `sources`  | List configured sources and tiers                                              |

`latest` accepts `tier`, `source`, `sinceDays`, `limit` and `onlyNew`.
`discover` accepts `fromModelType`, `fromModelId`, `specName`, `match`, `urls`,
`minMentions` and `probe`.

## Resources

| Spec        | Instance           | Contents                                            |
| ----------- | ------------------ | --------------------------------------------------- |
| `feed`      | `feed-<source>`    | One source: status, error, article list             |
| `digest`    | `digest-latest`    | Merged tier-ordered reading list across all sources |
| `candidate` | `candidate-<host>` | A discovered host, its mention count and feed       |

Each article carries `title`, `url`, `source`, `tier`, `author`, `publishedAt`,
`summary`, `firstSeenAt` and `isNew`.

## Configuring sources

Override `sources` in the model definition to read anyone else. Omitted fields
default to `kind: rss`, `tier: 2`, `enabled: true`.

```yaml
globalArguments:
  sources:
    - name: swamp-club
      kind: rss
      url: https://swamp.club/feed.xml
      author: Swamp Club
      tier: 1
    - name: adrianco
      url: https://medium.com/feed/@adrianco
      author: Adrian Cockcroft
  maxPerSource: 25
```

Set `enabled: false` to park a source without deleting it.

## Design notes

**CDATA.** Substack, Medium and WordPress wrap titles, authors and descriptions
in CDATA sections, which an XML parser reports as empty text content. Feeds are
normalised through a CDATA unwrap before parsing, so those fields survive.

**Fan-out, not loops.** `fetch` reads every source inside one execution, so the
per-model lock is acquired once. Do not loop `swamp model method run` per source
— parallel calls against one model contend on that lock.

**Failure isolation.** A source that 404s, times out or changes shape is
recorded as `ok: false` with its error and is counted in the digest's `failed`
list. It never aborts the run, so one dead feed cannot cost you the other six.

**Idempotency.** `firstSeenAt` is carried forward per article URL from the
previous run, so re-running `fetch` does not churn it and `isNew` stays
meaningful.

**LinkedIn is fragile by nature.** LinkedIn publishes no RSS. The `linkedin`
source kind reads the JSON-LD `@graph` embedded in the public guest profile,
which covers both short posts and Pulse articles. This is unauthenticated and
undocumented: LinkedIn can gate or restructure that markup at any time, at which
point the source starts reporting `no JSON-LD posts found` and the rest of the
reading list carries on unaffected. `simon-wardley-blog` is included alongside
it as a stable fallback.

## Development

```bash
~/.swamp/deno/deno check extensions/models/reading_list.ts
~/.swamp/deno/deno test extensions/models/ --permit-no-files
```

## Licence

MIT — see [LICENSE.md](LICENSE.md).
