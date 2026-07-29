# Fixture provenance

Every JSON file in this directory is **pure doc-derived** — hand-authored from
the published
[Telegram Bot API documentation](https://core.telegram.org/bots/api) (`getMe`,
`sendMessage`, `sendPhoto`, `sendDocument`, the `Message`/`User`/
`Chat`/`PhotoSize`/`Document` object shapes, and the generic error envelope),
never captured from a live call. This mirrors the `porkbun`/`pihole` wave-1
precedent (synthetic fixtures, no live capture) and is a deliberate security
decision, not an oversight.

## What was NOT done (explicit prohibition)

Two live `@magistr/telegram/send` model instances (`tg-bot`, `tg-anilist`) and a
`telegram` vault **do exist** in this homelab. **Live capture from either
instance is FORBIDDEN** for this fixture corpus — not "not done this time", but
a standing rule for anyone regenerating these fixtures later:

- No `swamp model method run tg-bot <method>` or
  `swamp model method run tg-anilist <method>` call was made while authoring
  these fixtures — not `getMe`, not any `send*` method.
- No vault credential (`telegram` vault: `BOT_TOKEN`) was read, exported, or
  otherwise touched.
- No real Telegram chat, user, bot identity, or message content from either live
  instance appears anywhere below.
- The bot token **never appears in a Bot API response body** in the first place
  (Telegram embeds it only in the _request_ URL path, `/bot<token>/<method>`) —
  but the prohibition above stands independent of that fact, as a standing rule.

## The real homelab chat id is denylisted, not just avoided

`154348275` is the real homelab chat id used by the live `tg-bot`/`tg-anilist`
instances (routing PII, not a secret, but still real-world identifying data that
has no business in a synthetic fixture corpus). It does not appear anywhere in
this directory, and the adversarial suite's fixtures-secret-scan
(`../extensions/models/telegram_send_adversarial_test.ts`) asserts its literal
absence across every fixture as a mechanical backstop — the primary control is
this prohibition plus never running a live call in the first place.

## Every value is synthetic

- `id` fields (bot id `987654321`, chat id `555000111`, message ids
  `1001`-`1003`): synthetic sequential/round placeholders in the shape
  Telegram's own documentation examples use, never a real bot or chat id.
- `username`/`first_name` (`swamp_notify_bot`, `SwampNotifyBot`, `Jordan`,
  `jordan_example`): generic placeholder names, not any real Telegram account.
- `file_id`/`file_unique_id` values (`AgACAgIAAxkDAAIBAWEXAMPLE0001`,
  `BQACAgIAAxkDAAIBAmEXAMPLEDOC1`, …): shaped like real Telegram file
  identifiers (base64url-ish, no colon) but with an `EXAMPLE`/`DOC` marker
  spliced in — deliberately non-functional and provably not a real upload.
- `date` (Unix timestamps `1752600000`-`1752600120`): arbitrary round numbers in
  the correct epoch-seconds shape, not tied to any real message's send time.
- Text/caption content (`"Hello from swamp"`, `"build green"`,
  `"nightly report"`): generic placeholder strings, matching the README's own
  usage examples.
- `error.json`'s `description` (`"Bad Request: chat not found"`): a real,
  commonly-seen Telegram Bot API error string (documented behavior), not tied to
  any real send failure.

## No token ever appears in a fixture

None of the fixture files contain a bot token — Telegram's Bot API never echoes
the token back in a response body (see the token-in-URL note above). The
adversarial suite's fixtures-secret-scan still runs the real-token shape regex
(`/\d+:[A-Za-z0-9_-]{30,}/`) over every fixture as a mechanical backstop, and
the `FAKE`-prefixed token sentinel used in test _source_ (not fixtures) is
deliberately letters-first with no colon, so it structurally cannot match that
pattern either — see the adversarial suite's comment next to its
`TOKEN_SENTINEL` constant.

## Per-file mapping to the documented method

| File                | Documented method                                              |
| ------------------- | -------------------------------------------------------------- |
| `getMe.json`        | `POST /bot<token>/getMe`                                       |
| `sendMessage.json`  | `POST /bot<token>/sendMessage`                                 |
| `sendPhoto.json`    | `POST /bot<token>/sendPhoto` (JSON-body / URL or file_id form) |
| `sendDocument.json` | `POST /bot<token>/sendDocument` (JSON-body form)               |
| `error.json`        | Generic Bot API error envelope (`ok:false`, any method)        |

## A documented API asymmetry this corpus deliberately preserves

`sendMessage`'s result carries a `text` field; `sendPhoto`/`sendDocument`'s
results carry a `caption` field instead — the two are mutually exclusive on the
wire, matching how `telegram_send.ts`'s own `SentMessageSchema` declares both as
optional but each method's mapper only ever populates one of them (`text` for
`sendMessage`, `caption` for `sendPhoto`/`sendDocument`). The coverage suite
pins this asymmetry explicitly so a mapper refactor can't silently swap them
without a test going red.

## Scope note: no `sendRichMessage` fixture

The frozen source (`telegram_send.ts` v2026.07.16.2) exposes only `getMe`,
`sendMessage`, `sendPhoto`, `sendDocument` — there is no `sendRichMessage`
method and no MarkdownV2/HTML escaping helper to fixture. A `sendRichMessage`
port (tracked separately, see [`../CHANGELOG.md`](../CHANGELOG.md)) will need
its own fixture(s) when that method lands in this workspace's source.
