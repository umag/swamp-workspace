# swamp-workspace

Swamp extensions monorepo. Each subdirectory is a self-contained extension with
its own `manifest.yaml`, `.swamp.yaml`, skills, models, and tests.

## Quality standard

Every extension is held to a machine-checked bar defined in
[`STANDARD.md`](STANDARD.md): five required test suites, README/CHANGELOG/
bundled-skill docs, and a never-regress registry quality score. A shrink-only
`quality-allowlist.txt` tolerates today's backlog while it gets backfilled; the
`compliance` CI job enforces it globally on every PR.

## Extensions

### Development, automation & orchestration

| Directory                                       | Package                    | Description                                                                                                                                                                                                    |
| ----------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`swamp-go-brr/`](swamp-go-brr/README.md)       | `@magistr/swamp-go-brr`    | Autonomous merkle-DAG dev loop — 4 models (`gobrr` DAG state machine, `source-integration` allowlist-ACL, `docker-verify` gate, `preflight` substrate) driving `claude --print` leaves in Firecracker microVMs |
| [`issue-lifecycle/`](issue-lifecycle/README.md) | `@magistr/issue-lifecycle` | Drive an issue from triage → plan → review → implement → harvest; model + 9 bundled development skills                                                                                                         |
| [`good-planning/`](good-planning/README.md)     | `@magistr/good-planning`   | Bovolon four-layer planning architecture as queryable swamp state                                                                                                                                              |
| [`firecracker/`](firecracker/README.md)         | `@magistr/firecracker`     | Firecracker microVM lifecycle (SSH + Unix-socket REST) plus a warm parallel agent fabric                                                                                                                       |
| [`fc-task-server/`](fc-task-server/README.md)   | `@magistr/fc-task-server`  | Host↔guest task/result control-plane server for Firecracker microVM agents                                                                                                                                     |

### Infrastructure & self-hosting ops

| Directory                                             | Package                       | Description                                                                       |
| ----------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| [`libvirt/`](libvirt/README.md)                       | `@bad-at-naming/libvirt`      | libvirt/virsh management — VMs, networks, storage pools                           |
| [`talos-node/`](talos-node/README.md)                 | `@magistr/talos-node`         | Talos Linux node management via `talosctl` — provision, bootstrap, patch, upgrade |
| [`talm-cluster/`](talm-cluster/README.md)             | `@magistr/talm-cluster`       | Talos cluster lifecycle via `talm` — init, configure, template, apply             |
| [`cozystack-platform/`](cozystack-platform/README.md) | `@magistr/cozystack-platform` | Cozystack platform — operator install, package deploy, apps/tenants               |
| [`cozystack-linstor/`](cozystack-linstor/README.md)   | `@magistr/cozystack-linstor`  | Linstor distributed storage for Cozystack — ZFS pools, storage classes            |
| [`cadvisor/`](cadvisor/README.md)                     | `@magistr/cadvisor`           | cAdvisor container metrics — deploy over SSH and query                            |
| [`homeassistant/`](homeassistant/README.md)           | `@magistr/homeassistant`      | Home Assistant — entity states, service calls                                     |
| [`pihole/`](pihole/README.md)                         | `@magistr/pihole`             | Pi-hole custom DNS record management                                              |
| [`porkbun/`](porkbun/README.md)                       | `@magistr/porkbun`            | Porkbun DNS record CRUD for all common record types                               |
| [`victorialogs/`](victorialogs/README.md)             | `@magistr/victorialogs`       | VictoriaLogs query API — LogsQL, field/stream stats                               |
| [`victoriametrics/`](victoriametrics/README.md)       | `@magistr/victoriametrics`    | VictoriaMetrics query API — instant/range PromQL, scrape targets                  |
| [`dawarich/`](dawarich/README.md)                     | `@magistr/dawarich`           | Dawarich self-hosted location-tracking API                                        |

### Images & CAD

| Directory                                               | Package                        | Description                                                                          |
| ------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| [`comfyui/`](comfyui/README.md)                         | `@magistr/comfyui`             | Drive a ComfyUI server (local Ideogram 4.0) — idea → bbox'd caption (Claude) → image |
| [`jscad-cad/`](jscad-cad/README.md)                     | `@magistr/jscad-cad`           | JSCAD v2 code generation — text → STL/DXF/SVG/OBJ/3MF                                |
| [`jscad-stl-slicer/`](jscad-stl-slicer/README.md)       | `@magistr/jscad-stl-slicer`    | Slice STL geometry for fabrication                                                   |
| [`jscad-stl-validator/`](jscad-stl-validator/README.md) | `@magistr/jscad-stl-validator` | STL validator — triangle count, degenerate faces, bounding box                       |

### Media servers & metadata

| Directory                                   | Package                  | Description                                                             |
| ------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| [`gonic/`](gonic/README.md)                 | `@magistr/gonic`         | Gonic Subsonic-compatible music server API — browse, search             |
| [`headphones/`](headphones/README.md)       | `@magistr/headphones`    | Headphones music-download automation — artists, albums, queue           |
| [`musicbrainz/`](musicbrainz/README.md)     | `@magistr/musicbrainz`   | MusicBrainz metadata — search, look up, browse                          |
| [`bandcamp/`](bandcamp/README.md)           | `@magistr/bandcamp`      | Bandcamp search — artists, albums, tracks                               |
| [`seanime/`](seanime/README.md)             | `@magistr/seanime`       | Seanime self-hosted anime server — library, search, downloads, playback |
| [`shoko/`](shoko/README.md)                 | `@magistr/shoko`         | Shoko anime metadata server — series, episodes, files                   |
| [`anilist/`](anilist/README.md)             | `@magistr/anilist`       | AniList GraphQL — anime/manga, media details, user lists, trends        |
| [`seadex/`](seadex/README.md)               | `@magistr/seadex`        | SeaDex (releases.moe) best-release recommendations for anime            |
| [`tubearchivist/`](tubearchivist/README.md) | `@magistr/tubearchivist` | TubeArchivist API — videos, channels, downloads, search                 |

### Personal data, archival & import

| Directory                                                 | Package                         | Description                                                              |
| --------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| [`obsidian-vault/`](obsidian-vault/README.md)             | `@magistr/obsidian-vault`       | Manage Obsidian vaults via the official CLI — notes, search, tags, links |
| [`obsidian-yt-archiver/`](obsidian-yt-archiver/README.md) | `@magistr/obsidian-yt-archiver` | Archive vault YouTube links into TubeArchivist + reference notes         |
| [`livejournal-import/`](livejournal-import/README.md)     | `@magistr/livejournal-import`   | Import LiveJournal entries (images, tags, comments) into Obsidian        |
| [`telegram-import/`](telegram-import/README.md)           | `@magistr/telegram-import`      | Import a Telegram channel export (zip) into Obsidian                     |
| [`telegram-send/`](telegram-send/README.md)               | `@magistr/telegram-send`        | Send messages, photos, and documents to Telegram chats/channels          |
| [`juick/`](juick/README.md)                               | `@magistr/juick`                | Juick.com microblogging API — posts, comments, threads → Obsidian        |
| [`jabber/`](jabber/README.md)                             | `@magistr/jabber`               | Read, search, and import Psi/Psi+ XMPP history — DMs and MUCs            |
| [`skype/`](skype/README.md)                               | `@magistr/skype`                | Skype SQLite reader — conversations, contacts, messages → Obsidian       |
| [`fidonet-msgbase/`](fidonet-msgbase/README.md)           | `@magistr/fidonet-msgbase`      | FidoNet JAM/Squish/FTS-0001 message base reader                          |

## Adding a new extension

Create a new directory at the repo root:

```
my-extension/
  .swamp.yaml           # swamp repo init --tool claude
  manifest.yaml         # extension manifest
  deno.json             # Deno dev config
  extensions/models/    # model source + tests
  .claude/skills/       # bundled skills (optional)
  README.md
```

CI auto-discovers each extension (any `*/manifest.yaml`) and each skill (any
`*/.claude/skills/*/SKILL.md`), so no matrix edit is needed.

## CI

PR checks:

- `deno-check` — `deno fmt --check`, `lint`, type `check`, and `test` (per
  extension). The most common red is `deno fmt --check` — run `deno fmt` first.
- `compliance` — the [quality standard](STANDARD.md) gate: every extension's
  `quality.yaml` (five suites + docs), the shrink-only allowlist, and a
  never-regress registry score. Runs GLOBAL (every extension, every PR),
  tokenless. See `STANDARD.md` for how to run it locally and fix a failure.
- `release-notes-cap` — fail-closed: every manifest this PR is about to
  publish (see below) must have a present, non-blank, singly-declared
  `## <version>` CHANGELOG.md section that fits the registry's byte cap.
  Registry release notes are IMMUTABLE per version, so this is checked
  before merge, not after. A hard dependency of `extension-publish` — a red
  `release-notes-cap` blocks the push job outright. Selection is by the
  manifest's registry COORDINATE, its `name` AND its `version` together, not
  by a diff line: a rename or reformat that changes NEITHER publishes
  nothing, but changing `name:` alone (an in-place re-scope) does publish,
  even with `version:` untouched. Fix a red run by trimming the new section
  — never by editing an already-published one.
- `skill-review` — tessl quality review (per skill, threshold 90%)
- `skill-trigger-eval` — promptfoo routing eval on Sonnet (≥90% pass). A new
  skill must also be added to the routing prompt list in
  `promptfoo.config.yaml`.

Push to `master`:

- `extension-publish` — auto-publishes when a `manifest.yaml`'s declared
  `name`/`version` coordinate changes vs the push's diff base; gated on
  `deno-check` and `release-notes-cap` both passing first, and re-validates
  every release note immediately before pushing (the same check
  `release-notes-cap` already ran at PR time).
- `registry-drift` — `always()`, after publish: compares every extension's
  declared manifest version against what the registry actually has on its
  channel, so a publish that silently failed or got cancelled mid-run
  (dropping a version permanently) is caught rather than discovered later.

## Development

```bash
# Run an extension's tests
cd issue-lifecycle/extensions/models
deno test --no-lock -A

# Build and run skill routing evals
deno run --allow-read --allow-write scripts/build-promptfoo-tests.ts
npx promptfoo eval -c promptfoo.generated.yaml

# Validate / publish an extension
cd issue-lifecycle
swamp extension push manifest.yaml --dry-run
swamp extension push manifest.yaml --yes
```
