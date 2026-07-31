# Fixture provenance

Every byte produced by `builders.ts`, and every literal value passed into it
from the five test suites, is **100% SYNTHETIC** — hand-authored to match the
documented JAM / Squish / FTS-0001 on-disk formats, never captured from a real
FidoNet message base, BBS, or netmail packet. This mirrors the `porkbun` and
`comfyui` backfill precedent (synthetic fixtures, no live capture).

## What was NOT done (explicit prohibition)

`fidonet_msgbase.ts` is a pure filesystem reader — there is no live API to call,
but the equivalent temptation here is reusing a real historical msgbase dump.
That is **forbidden**, standing, for anyone regenerating these fixtures later:

- No real `.jhr`/`.jdt`/`.jdx`/`.sqd`/`.sqi`/`.msg` file — from an archive, a
  BBS door, a personal FidoNet node, or anywhere else — was read, copied, or
  transcribed into this corpus.
- No real sysop or user name, no real echomail/netmail body text, and no real
  FidoNet node/point address appears anywhere below.
- No real origin-line BBS name or tagline was reused.

## Every value is synthetic

- **FidoNet addresses**: zone/net/node/point tuples like `2:5020/1`,
  `2:5030/2.5`, `1:123/456` are small, round, documentation-style numbers — not
  addresses in FidoNet's actual, still-partly-active zone/net allocation (nets
  in the low thousands under real zones are frequently still assigned). None of
  these tuples were looked up against a real nodelist.
- **Names**: generic placeholders (`John Doe`, `Jane Roe`, `Bob Sender`,
  `Alice Receiver`) or an invented Cyrillic name (`Иван`) used solely to
  exercise the CP866 decode path — not a real correspondent.
- **BBS/origin names**: `Test BBS` — a generic placeholder, not a real system
  name (active or defunct).
- **Body text**: short generic placeholder sentences ("Hello there.", "Squish
  body text.") with no real conversational content.
- **Dates**: arbitrary calendar values chosen to exercise `parseScombo`'s DOS
  packed-date decode and `parseFtsDate`'s regex, not dates tied to any real
  message history.

## Byte-level provenance: this is a Factory, not a fixture dump

Unlike `porkbun`'s doc-derived JSON fixtures, `fidonet_msgbase.ts` has no wire
format to transcribe from a spec document verbatim — it reads three legacy
binary layouts (JAM, Squish, FTS-0001) that predate any JSON. `builders.ts` is
therefore a **Factory**: a set of functions that assemble the exact byte layout
`fidonet_msgbase.ts`'s parsers expect (offsets, field widths, and encodings
reverse-derived directly from reading `fidonet_msgbase.ts` itself — see the
offset table in `builders.ts`'s module docstring and the plan's "Byte
formats/offsets" section). Each test file calls these builders with its own
synthetic field values; there is no separate fixture JSON corpus to audit for
secrets the way `porkbun/fixtures/*.json` is audited — the adversarial suite's
fixtures-secret-scan instead greps `builders.ts` plus every test file in this
extension for the same credential-shaped patterns, as a mechanical backstop to
this provenance note.

## Per-format layout reference (matches `fidonet_msgbase.ts`, byte-frozen)

| Format   | Files             | Fixed header                                                                               | Message unit                                                                                                                            |
| -------- | ----------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| JAM      | `.jhr` + `.jdt`   | 1024B (`sig@0`, `activeMsgs@12`, `baseMsgNum@20`)                                          | 76B header (`sig@0`, `subfieldLen@8`, `dateWritten@36`, `msgNum@48`, `attr@52`, `txtOffset@60`, `txtLen@64`) + subfields (loID 0/2/3/6) |
| Squish   | `.sqd`            | ≥256B (`numMsg@4`, `beginFrame@104`)                                                       | SQHDR 28B (`id@0`=`0xafae4453`, `nextFrame@4`, `msgLength@16`, `clen@20`, `frameType@24`) + XMSG 238B                                   |
| FTS-0001 | `netmail/<n>.msg` | 190B (`from@0`, `to@36`, `subject@72`, `date@144`, node/net fields `@166-175`, `attr@188`) | body from `@190`, NUL-terminated                                                                                                        |

No new npm dependency was added for fixture generation — `builders.ts` uses only
`Uint8Array`/`DataView`, both Deno/JS built-ins.
