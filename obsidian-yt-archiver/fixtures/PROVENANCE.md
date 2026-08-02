# Fixture provenance

Every file in this directory is **pure synthetic / hand-authored** — built from
the documented shape of an Obsidian vault's Markdown notes and TubeArchivist's
[REST API](https://github.com/tubearchivist/tubearchivist) responses, **never
captured from a live vault or a live TubeArchivist instance**. This mirrors the
`bandcamp`/`porkbun`/`livejournal-import` precedent (synthetic fixtures, no live
capture) and is a deliberate security/privacy decision, not an oversight.

## What was NOT done (explicit prohibition)

**Live capture from any real Obsidian vault or TubeArchivist instance is
FORBIDDEN** for this fixture corpus — not "not done this time", but a standing
rule for anyone regenerating these fixtures later:

- No `swamp model method run <instance> scan|archive|resolve|sync` call was ever
  made against a real vault or a real TubeArchivist instance while authoring
  these fixtures.
- No real Obsidian vault path, note title, note body, or folder name appears
  anywhere below — every note is invented fixture prose.
- No real YouTube video id appears anywhere below — every id is an 11-character
  string prefixed `fixture` (e.g. `fixtureAAA1`) followed by three uppercase
  letters and a digit as a deliberate, greppable marker; none resolves to a real
  YouTube video.
- No real TubeArchivist API token, channel id, or channel name appears anywhere
  below — every value is prefixed `fixture`/`Fixture` as a marker.

The fixtures-secret-scan test in
`../extensions/models/obsidian_yt_archiver_adversarial_test.ts` is a
**mechanical backstop**, not the primary control — the primary control is this
prohibition plus never running a live call in the first place.

## Every value is synthetic

- Hosts: the TubeArchivist base URL used across every test is
  `https://ta.fixture.example.com` — IANA's reserved example domain
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)), never a real self-hosted
  TubeArchivist deployment.
- Video ids: `fixtureAAA1`, `fixtureBBB2`, `fixtureCCC3`, `fixtureDDD4`,
  `fixtureHID5`, `fixtureOUT6` — each exactly 11 characters (matching the
  `[a-zA-Z0-9_-]{11}` shape the source's `YT_PATTERNS` regexes capture),
  synthetic sequential placeholders, never real YouTube video ids.
- Names: `Fixture Archived Video Title`, `Fixture Channel One`, etc. — invented
  titles/channel names using the word `Fixture` as a marker.
- Tokens: `fixture-ta-token-do-not-log` (used as the `tubearchivistToken` global
  argument in every test) — a deliberately fake, greppable value; the
  credential-leak tests assert it never appears in any written resource.
- Dates: `2024-01-15` — an arbitrary placeholder date, never tied to a real
  publish event.

## Directory layout

```
fixtures/
  vault/                        -- synthetic Obsidian vault subtree
    notes/
      video-note.md              -- watch/youtu.be/embed links, one dup
      no-links.md                 -- contributes to totalFiles, zero links
    Clippings/
      clipped-video.md            -- shorts link + cross-file duplicate id
    .obsidian/
      config.md                   -- inside a dot-folder; must NEVER be walked
  outside/
    escape-note.md                -- LB2 traversal escape target, SIBLING to
                                      vault/ (never nested inside it)
  ta/                              -- synthetic TubeArchivist REST responses
    video_ok.json                  -- GET /api/video/{id}/, full fields
    video_ok_bare.json              -- GET /api/video/{id}/, no channel/title/
                                      published at all (fallback branches)
    download_queued.json            -- POST /api/download/ response body
    task_started.json               -- POST /api/task/by-name/download_pending/
    error_not_found.txt              -- 404 body
    error_unauthorized.txt           -- 401 body
    error_server.txt                 -- 500 body
    error_long.txt                    -- >200-char body (LB6 truncation pin)
    non_json_ok.txt                   -- 200 OK, text/plain (LB8 pin)
```

At test time, every suite copies `vault/` and `outside/` into a fresh
`Deno.makeTempDir()` tree (via `setupVault()` in each test file), preserving the
sibling relationship between `vault/` and `outside/` exactly as committed here —
the model under test always reads from that REAL temporary directory, never from
a stub. `ta/*.json` fixtures are imported directly as response bodies for a
stubbed `globalThis.fetch`; `ta/*.txt` fixtures are read at runtime the same way
the `.md` vault fixtures are.

## Byte-sensitive fixtures (`deno.json` `fmt.exclude`)

`vault/notes/video-note.md`, `vault/Clippings/clipped-video.md`, and
`outside/escape-note.md` each have specific **line numbers** pinned by tests
(the `line` field the model's `extractYoutubeIds` records). `deno fmt`'s
Markdown formatter can re-wrap/re-flow prose paragraphs and shift blank lines,
which would silently change which line a given link falls on — these three files
are listed in `deno.json`'s `fmt.exclude` so that never happens. Every other
fixture carries no line-pinned content and is left to ordinary `deno
fmt`
reformatting.

## Latent bugs this corpus exists to pin (all now FIXED)

Eight latent bugs were characterized against this corpus and are tracked in the
LOCAL `obsidian-yt-archiver-latent-bugs` issue-lifecycle model (never filed to
the swamp.club Lab); as of 2026.08.02.1 all eight are FIXED and this corpus now
regression-guards each fix: path traversal via the `folder` argument reaching
`outside/escape-note.md` (LB2, HIGH, fixed 2026.08.01.1), request-forgery via
arbitrary `videoIds` reaching other TubeArchivist endpoints on the same host
(LB1, MEDIUM), conflated fetch-fail/401/500 error handling causing mass re-queue
(LB3, MEDIUM), absence of any fetch timeout (LB4, MEDIUM), unbounded sequential
per-id fetches with no cap (LB5, LOW-MED), the 200-char raw error-body echo
(LB6, LOW — token never leaked), the default `redirect: "follow"` (LB7, LOW),
and a non-JSON 200 response resolving to a blank "archived" record (LB8, LOW).
See `../CHANGELOG.md` and the adversarial suite's per-test doc comments for the
full characterization of each fix.
