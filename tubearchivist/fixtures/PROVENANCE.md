# Fixture provenance

Every JSON file in this directory is **pure doc-derived** — hand-authored from
the published
[TubeArchivist API documentation](https://docs.tubearchivist.com/api/introduction/),
never captured from a live call. This mirrors the `porkbun`/`lastfm` precedent
(synthetic fixtures, no live capture) and is a deliberate security decision, not
an oversight.

## What was NOT done (explicit prohibition)

A live `tubearchivist` (`@magistr/tubearchivist`) model instance **does exist**
in this homelab. **Live capture from that instance is FORBIDDEN** for this
fixture corpus — not "not done this time", but a standing rule for anyone
regenerating these fixtures later:

- No `swamp model method run <live-tubearchivist-instance> <method>` call was
  made while authoring these fixtures.
- No vault credential (the TubeArchivist API `token`) was read, exported, or
  otherwise touched.
- No real video, channel, or download-queue content from any archive this
  instance manages appears anywhere below.
- The mutating endpoints (`add-to-queue`, `subscribe`, `start-download`,
  `delete-video`, `mark-watched`, `refresh`, `rescan`, `backup`,
  `create-snapshot`) were never invoked against the live API — their fixture
  shapes are transcribed from the documentation's example responses, not
  observed side effects.

The fixtures-secret-scan test in
`../extensions/models/tubearchivist_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero; do not treat the heuristic scan as a
guarantee that would also hold for genuinely captured data.

## Every value is synthetic

- YouTube video ids: `synVid00001` / `synVid00002` — 11-character synthetic ids
  in the correct base64url-ish shape, deliberately never a real video id (e.g.
  never `dQw4w9WgXcQ`).
- Download-queue ids: `synQue00001` / `synQue00002` — same synthetic
  11-character shape, distinct namespace from the video ids above.
- Channel ids: `UCsynthetic0000000001` / `UCsynthetic0000000002` — `UC`-prefixed
  to match YouTube's documented channel-id shape, obviously synthetic.
- Host: none appears inside the fixture JSON itself (the host is supplied by
  test harness `GLOBAL_ARGS`, always `https://tubearchivist.example.com` —
  IANA's reserved example domain,
  [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)).
- Task ids: `d290f1ee-6c54-4b01-90e6-d701748f0851` — an RFC 4122 example-shaped
  UUID, not a real TubeArchivist task id.
- Timestamps / dates: `2026-01-01` / `2026-01-08` and Unix time `1767225600`
  (2026-01-01T00:00:00Z) — placeholders, not observed data.

## Per-file mapping to the documented endpoint

| File                 | Documented endpoint                                    | Consumed by                                                                                       |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `video-list.json`    | `GET /api/video/`                                      | `list-videos`                                                                                     |
| `video-detail.json`  | `GET /api/video/<id>/`                                 | `get-video`                                                                                       |
| `channel-list.json`  | `GET /api/channel/`                                    | `list-channels`                                                                                   |
| `queue-list.json`    | `GET /api/download/`                                   | `list-queue`                                                                                      |
| `search.json`        | `GET /api/search/?query=`                              | `search`                                                                                          |
| `stats.json`         | `GET /api/stats/video/`                                | `stats`                                                                                           |
| `backup-list.json`   | `GET /api/appsettings/backup/`                         | `list-backups`                                                                                    |
| `snapshot-list.json` | `GET /api/appsettings/snapshot/`                       | `list-snapshots`                                                                                  |
| `ping.json`          | `GET /api/ping/`                                       | `ping`                                                                                            |
| `task.json`          | Generic task-trigger envelope (any task-kind endpoint) | `subscribe`, `add-to-queue`, `start-download`, `rescan`, `refresh`, `update-subscribed`, `backup` |

## A documented API quirk this corpus deliberately preserves

`video-detail.json` is authored as the **BARE video object** the source actually
consumes — `get-video` does **not** unwrap a `{data: {...}}` envelope; it stores
the entire fetched response as the single video (`tubearchivist.ts` lines
~253-259:
`context.writeResource("videos",
args.youtube_id, { videos: [data], ... })`,
where `data` is the raw parsed JSON). Wrapping `video-detail.json` in a
`{data: {...}}` envelope — the shape `list-videos`/`list-channels`/`list-queue`
all expect — would pin a contract the code never produces. The contract suite
documents this no-unwrap behavior explicitly rather than "fixing" the fixture to
match the (wrong) intuition that every endpoint shares one envelope shape.

`list-videos`/`list-channels`/`list-queue` all read from a `data.data[]` array
plus an optional `data.paginate` block; `list-backups`/`list-snapshots` fall
back through `data.data || data || []` (no `paginate` in the documented
backup/snapshot payloads); `search` reads `data.results || data.data || []`.
Each fixture above is shaped to match exactly the branch its consuming method
takes on the _documented_ (well-formed) response — the adversarial and coverage
suites cover the other branches of each fallback with small inline literals, not
separate fixture files, since those alternate shapes are edge-case-shaped rather
than another real documented response.
