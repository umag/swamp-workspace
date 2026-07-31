# Fixture provenance

All three `result.json` fixtures under this directory are **100% synthetic**,
hand-authored for the `ext-quality-bf-telegram-import` test backfill. None of
them was captured from a real Telegram Desktop export, a real channel, or a real
conversation.

- No real Telegram usernames, user IDs, phone numbers, channel names, or media
  filenames tied to real people appear anywhere in this corpus.
- Names (`Fixture Broadcast`, `Fixture Author`, `Fixture Attacker`,
  `Origin
  Channel`, `Fixture Edge Channel`) are invented labels, chosen to
  read as obviously synthetic.
- IDs (`1000000001`, `1999999999`, `1500000000`, per-message `id`s) are
  arbitrary invented integers, not real Telegram channel/user/message IDs.
- The email address (`fixture@example.test`) and phone number
  (`+1-202-555-0101`) use RFC 2606 reserved `.test` / RFC 5737-adjacent
  documentation conventions — `example.test` is a reserved-for-documentation
  hostname and `202-555-01xx` is the standard fictional North American
  phone-number block used in film/TV and documentation.
- The `href` in fixtures/basic (`https://example.test/post/3`) targets the RFC
  2606 reserved `example.test` domain.
- Media paths (`photos/photo_4@2x.jpg`, `files/fixture_report.pdf`,
  `video_files/fixture_clip.mp4`, `video_files/fixture_clip_thumb.jpg`) are
  invented filenames. No corresponding binary media files exist anywhere in this
  repository or corpus — every test drives the model through
  `telegram_import_test_helpers.ts`'s `Deno.copyFile` stub, which never performs
  a real file read or write, so these paths are never opened.

## fixtures/basic/result.json

A clean, well-formed export: one filtered-out `service` message (channel
creation) plus seven `message`-type entries covering plain text, rich
`text_entities` (bold/italic/code/text_link/strikethrough), a photo, a file
(PDF), a video, a `forwarded_from` post, and a `reply_to_message_id` post. Used
by the contract-fixture suite for the golden pipeline run.

## fixtures/malicious/result.json

Three deliberately hostile payloads, each pinning one tracked latent bug
(`telegram-import-latent-bugs`, LOCAL issue-lifecycle model — never filed to the
swamp.club Lab, this is our own extension):

- **LB-1** (`id: 100`) — `photo: "../../../../etc/hostname"`. This path is never
  actually opened: `Deno.copyFile` is always stubbed in these tests, so the
  traversal is asserted only against the captured `{src, dest}` invocation,
  never executed against a real filesystem.
- **LB-2** (`id: "101/../../../../tmp/evil-note"`) — a string `id` containing
  path-traversal segments, exercising `noteSlug`'s unsanitized
  `${date}-${msg.id}` interpolation. Asserted only against the captured
  `obsidian create path=...` argv, never against a real vault write.
- **LB-3** (`id: 102`) — `forwarded_from` containing an embedded `"` and YAML
  block-mapping syntax, exercising the unescaped
  `` `forwarded_from: "${msg.forwarded_from}"` `` frontmatter interpolation. The
  channel `name` at the top of this file carries the same payload shape for the
  `channel: "${channelName}"` frontmatter line.

## fixtures/edge/result.json

Structural edge cases with no attack payload: an empty-string `text`, a
`text_entities` array covering the remaining entity types not exercised in
`basic` (`mention`, `hashtag`, `email`, `phone`, and an unknown future entity
type falling through the `default` case), a `file` ending in `_thumb.jpg` (must
be silently skipped, per `telegram_import.ts`'s
`!fileName.endsWith("_thumb.jpg")` guard), and a `media_type: "video_file"`
message with no `file` field at all (the video-copy branch must not fire).

## What is deliberately NOT here

- No real hang, timeout, or long-running subprocess is encoded anywhere (LB-6 —
  no subprocess timeout — is documented as a characterization comment in the
  adversarial suite, never reproduced as an actual hang).
- No genuinely oversized payload is committed to exercise LB-8 (unbounded
  `JSON.parse`) — that bug is characterized with a moderately long `text` field
  (thousands of characters, not megabytes), enough to demonstrate the absence of
  a size guard without a slow test.
- The malformed-message-abort case (LB-4, one throwing message aborting the
  whole import) is NOT fixture-backed — it is constructed inline in
  `telegram_import_adversarial_test.ts` via `writeRealResultJson`, so the three
  committed fixtures here stay fully well-formed JSON and safe to reuse across
  every suite without any of them throwing.
