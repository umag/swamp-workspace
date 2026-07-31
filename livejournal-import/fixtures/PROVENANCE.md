# Fixture provenance

Every file in this directory is **pure synthetic / hand-authored** — built from
the observable structure of a LiveJournal `?format=light` index page and entry
page (the `aentry-*` BEM class markup, the embedded `Site.page = {...};`
comments blob) and the documented shape of the `import` method's
frontmatter/note output, **never captured from a live journal**. This mirrors
the `bandcamp`/`porkbun`/`musicbrainz` precedent (synthetic fixtures, no live
capture) and is a deliberate security/privacy decision, not an oversight.

## What was NOT done (explicit prohibition)

**Live capture from any real LiveJournal blog is FORBIDDEN** for this fixture
corpus — not "not done this time", but a standing rule for anyone regenerating
these fixtures later:

- No `swamp model method run livejournal-import import` call was ever made
  against a real LiveJournal journal while authoring these fixtures.
- No real LiveJournal page (`fetch`, browser, or otherwise) was ever scraped to
  produce the HTML fixtures — every `aentry-*` element, `Site.page` blob, and
  comment record was hand-written from the documented/observed shape, not copied
  from a live page.
- No real LiveJournal username, post title, post body, tag, mood, or comment
  author appears anywhere below — every name/title/body is prefixed
  `Fixture`/`fixture-` as a deliberate, greppable marker.
- No real vault path, Obsidian vault name, or filesystem content appears
  anywhere below — the vault name (`fixture-vault`) and every disk path produced
  from it are entirely synthetic and never resolve to a real path on any
  machine.

The fixtures-secret-scan test in
`../extensions/models/livejournal_import_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place.

## Every value is synthetic

- Hosts: every journal/post URL uses the `fixture-journal.example.com` subdomain
  — IANA's reserved example domain
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)), never a real
  `*.livejournal.com` blog. This is a deliberate departure from real LiveJournal
  URL shape, chosen so no fixture could ever be mistaken for — or accidentally
  resolve to — a real journal. The one exception is `post_full.html`'s and the
  coverage suite's dedicated href for the hardcoded `livejournal.com/profile`
  substring check in `htmlToMarkdown`
  (`https://fixture-user.livejournal.com/profile`) — the source checks that
  EXACT literal substring regardless of the configured `journalUrl`, so
  characterizing that branch requires a host containing it; the `fixture-`
  prefix and inert offline stubbed-fetch context make clear it is never a real
  reachable account.
- The SSRF-pin target addresses used in `post_ssrf.html` (`169.254.169.254`,
  `127.0.0.1:8200`) are well-known documentation/reserved examples for
  cloud-metadata and loopback-service scenarios (the same convention the
  `bandcamp` fixture corpus uses), never a real reachable host this repo's
  author controls. `post_ssrf.html` also embeds a third image
  (`f-pics.example.com/fixture-redirect-relay.jpg`) whose sole purpose is to be
  stubbed, in the adversarial test suite, to a 30x `Location` pointing at
  `203.0.113.7` — an [RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)
  TEST-NET-3 address, IANA-reserved for documentation and never publicly routed.
  This exercises the redirect-hop-rejection hardening (an allowlisted host's
  redirect target must be re-validated, not blindly followed). The adversarial
  suite's inline (non-fixture-file) rejected-multi-hop-chain test uses the
  adjacent `203.0.113.9` for the same reason. Those same inline tests also embed
  decimal-, hex-, and bracketed-IPv6/IPv4-mapped-encoded forms of the
  already-documented `169.254.169.254`/`127.0.0.1` loopback addresses (e.g.
  `2852039166`, `0xA9FEA9FE`, `[::1]`, `[::ffff:127.0.0.1]`) — these are
  alternate WHATWG-URL-parser-normalized spellings of the same two reserved
  addresses, not novel undocumented hosts.
- Names: `Fixture Full Post Title`, `Fixture Aurora`-style post titles,
  `fixture_alice`, `Fixture Bob`, `fixture_top`, `fixture_reply`,
  `Fixture
  Display Name`, etc. — invented author/commenter names using the
  word `fixture` as a marker.
- Post ids: `1001`, `1002`, `2001`, `2002`, `9001`+ — synthetic sequential
  placeholders, never real LiveJournal entry ids.
- Dates: `August 22 2010, 21:14`, `January 5 2011, 09:30`, etc. — arbitrary
  placeholder dates, never tied to a real post.
- Vault/folder: `fixture-vault`, `LiveJournal/attachments` — synthetic Obsidian
  configuration values; every mkdir/writeFile path produced from them in tests
  is captured by a stub, never touching a real filesystem.

## Per-file mapping to the documented page / blob shape

| File                     | Documented shape / endpoint                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`             | `GET <journal>/?format=light` index page, two entries, no further pages — the un-paginated `collectPostUrls` path                                                                                                                             |
| `index_paginated.html`   | The same index page but WITH a `skip=10` pagination marker — exercises the `skip += 10` loop and its "no new ids" termination                                                                                                                 |
| `index_empty.html`       | An index page with zero `href="<base>/<id>.html"` matches — pins the silent-empty-success path (latent bug LB3)                                                                                                                               |
| `post_full.html`         | A full entry page: title, date, mood, now-playing, tags, rich body (formatting/images/embeds), and a `Site.page` comments blob                                                                                                                |
| `post_ssrf.html`         | An entry whose body embeds `<img>` src values pointing at link-local/loopback administrative endpoints (latent bug LB1), plus an allowlisted relay host that 30x-redirects to an RFC 5737 documentation-only target (redirect-hardening test) |
| `post_injection.html`    | An entry whose title/mood/now-playing/tags embed raw newlines — exercises the unescaped-newline YAML frontmatter risk (LB2)                                                                                                                   |
| `post_bad_date.html`     | An entry whose date text does not match the `"Month D YYYY, HH:MM"` shape at all — pins `parseLjDate`'s silent fallthrough (LB8)                                                                                                              |
| `post_bad_comments.html` | An entry whose `Site.page` comments blob is corrupted (an unterminated JSON value) — pins the swallowed-parse-failure path (LB6)                                                                                                              |

## A documented quirk this corpus deliberately preserves

**The `Site.page = {...};` single-line convention.** Real LiveJournal entry
pages emit `Site.page = {...};` inline inside a `<script>` tag, immediately
followed by whitespace (a newline before further script statements or the
closing `</script>` tag). `post_full.html` and `post_bad_comments.html` both
preserve this convention deliberately: the source's extraction regex
(`/Site\.page\s*=\s*(\{.*?\});\s/s`) requires a literal `};` immediately
followed by whitespace to close its capture group. `post_injection.html`
separately preserves deliberately-embedded raw newlines inside the
mood/title/tag text nodes — the LB2 pin depends on those newlines surviving
byte-for-byte into the parsed field. All three files are listed in `deno.json`'s
`fmt.exclude` so `deno fmt` never reformats/re-flows them — `deno fmt`'s HTML
formatter collapses internal whitespace runs (including real newlines) when it
re-wraps text content for line width, which would silently defeat either the
`Site.page` terminator shape or the LB2 newline pin. The remaining five fixtures
(`index.html`, `index_empty.html`, `index_paginated.html`, `post_ssrf.html`,
`post_bad_date.html`) carry no such byte-sensitive content and are left to
`deno fmt`'s ordinary reformatting; the full test suite was re-run after
formatting to confirm nothing broke.

## Latent bugs this corpus exists to pin

Eight already-shipped latent bugs are characterized against this corpus and
tracked in the LOCAL `livejournal-import-latent-bugs` issue-lifecycle model
(never filed to the swamp.club Lab): SSRF via image `src` (`post_ssrf.html`),
YAML frontmatter injection via unescaped newlines (`post_injection.html`),
silent-empty success on zero collectible posts (`index_empty.html`), absence of
any fetch/subprocess timeout, unbounded pagination with no page cap, the fragile
`Site.page` comment-JSON extraction (`post_bad_comments.html`), unsanitized
`folder` path traversal on disk write, and `parseLjDate`'s silent fallthrough
for a non-matching date string (`post_bad_date.html`). See `../CHANGELOG.md` and
the adversarial suite's per-test doc comments for the full characterization of
each.
