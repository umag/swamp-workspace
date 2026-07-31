# Fixture provenance

Every file under this directory is **pure synthetic / hand-authored** — built
from the documented Psi/Psi+ on-disk history format (the pipe-delimited
`|timestamp|version|direction|flags|body` line format and the `account_in_room`
plain-text MUC log convention), **never captured from a real Psi/Psi+ profile**.
This mirrors the `bandcamp`/`porkbun` precedent (synthetic fixtures, no live
capture) and is a deliberate security/privacy decision, not an oversight.

## What was NOT done (explicit prohibition)

**Capturing real Jabber/XMPP history from any real Psi/Psi+ profile is
FORBIDDEN** for this fixture corpus — not "not done this time", but a standing
rule for anyone regenerating these fixtures later:

- No real `~/.config/psi+/profiles/*/history` directory was ever read while
  authoring these fixtures.
- No real JID (contact, conference room, or own account), nickname, or message
  body appears anywhere below.
- No `swamp model method run jabber-history <method>` call was ever made against
  a real Psi/Psi+ profile directory while authoring these fixtures.

## Every value is synthetic

- Hosts: every JID uses the `example.com` domain — IANA's reserved example
  domain ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)). Conference JIDs
  use `conference.example.com`, following the real-world XMPP convention that a
  MUC service's domain is literally `conference.<server>` (this is what makes
  the model's own `baseName.includes("conference.")` conference-detection
  heuristic fire — not a fixture quirk, the actual shipped detection logic).
- Contacts/accounts: `alice@example.com`, `carol@example.com`,
  `dave@example.com`, `myaccount@example.com` — invented placeholder
  local-parts, never a real contact.
- Conference rooms: `room1@conference.example.com`,
  `room2@conference.example.com`, `room3@conference.example.com` — invented
  placeholder room names.
- Nicknames: `Nick2`, `Nick3`, `Nick4` — invented placeholder nicknames for the
  plain-text conference logs.
- Message bodies: generic placeholder sentences describing the fixture's own
  purpose (e.g. "This pipe copy should be dropped in favor of the plain-text
  log"), never real conversation content.
- Dates: `2024-01-01` through `2024-04-05`, and one deliberately-absurd
  `2099-01-01` inside the `.backup` fixture (see below) — arbitrary placeholder
  dates, never tied to a real conversation.

## Two fixture trees, deliberately separated

- `good/history/` — the well-formed tree used by the contract-fixture, methods,
  and coverage suites. `context.globalArgs.historyDir` points at `good/` (the
  model appends `/history` itself).
- `poison/history/` — contains exactly one file, `bad%ZZ.history`, whose
  filename carries a malformed `%` escape (`%ZZ` is not valid hex). This is kept
  in its OWN subtree, never mixed into `good/`, because `decodeJid()`'s
  `decodeURIComponent` call throws a `URIError` for this filename, and
  `listHistoryFiles`'s `for await` loop has no per-entry try/catch — one
  poisoned filename anywhere in a directory aborts listing for **every** file in
  that directory (jabber-latent-bugs #1). Mixing it into `good/` would make
  every other "good path" fixture test collateral damage of that one adversarial
  case instead of a dedicated, isolated pin.

## Per-file mapping to the documented format / model behavior

| File                                                   | Exercises                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `good/history/alice_at_example.com.history`            | DM, pipe format; one message with no trailing `Z` (gets appended), one already carrying `Z`           |
| `good/history/room1_at_conference.example.com.history` | Conference, pipe format, NO plain-text counterpart — must be KEPT by `importToObsidian`'s dedup       |
| `good/history/room2_at_conference.example.com.history` | Conference, pipe format, HAS a plain-text counterpart below — must be DROPPED by the dedup            |
| `good/history/myaccount_at_example.com_in_room2_...`   | Conference, plain-text format, same room as above — wins the dedup; carries `account`                 |
| `good/history/myaccount_at_example.com_in_room3_...`   | Conference, plain-text format, no pipe twin — exercises the plain-text path with no dedup interaction |
| `good/history/carol_at_example.com.history`            | DM, pipe format, EMPTY file — 0 messages; exercises the skip-empty branch in `importToObsidian`       |
| `good/history/dave_at_example.com.history.backup`      | A `.backup` file — must be invisible to `listHistoryFiles` entirely (never parsed, never counted)     |
| `poison/history/bad%ZZ.history`                        | A malformed-`%` filename — `decodeJid` throws, aborting listing for the whole directory (bug #1)      |

## Latent bugs this corpus (plus dynamically-built temp fixtures in the test

files themselves) exists to pin

Nine already-shipped latent bugs are characterized against this corpus and
tracked in the LOCAL `jabber-latent-bugs` issue-lifecycle model (never filed to
the swamp.club Lab). Several bugs (sanitize-filename collisions, frontmatter
injection, path traversal, PATH-hijack/no-shell-injection, lone-surrogate
truncation, malformed timestamp/direction) are pinned using
dynamically-generated temp-directory fixtures built inline in the adversarial
and coverage test files (via `Deno.makeTempDir`/`Deno.writeTextFile`), not
static files here — see `../CHANGELOG.md` and each suite's per-test doc comments
for the full characterization of each.
