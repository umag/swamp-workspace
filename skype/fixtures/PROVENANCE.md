# Fixture provenance

Every `.tsv` file in this directory is **pure hand-authored synthetic data** —
constructed to match the documented shape of
`sqlite3 -separator "\t" <db>
<sql>` list-mode output for the four query shapes
`skype.ts` issues against a Skype `main.db` (`Conversations`, `Messages`,
`Contacts`, and the 4-column per-conversation export projection). **No real
`main.db` was ever read, opened, or captured from.** This mirrors the
`porkbun`/`gonic` precedent (synthetic, doc/shape-derived fixtures, never a live
capture) and is a deliberate security decision, not an oversight.

## What was NOT done (explicit prohibition — standing rule, not "not this time")

- No `sqlite3` was ever pointed at a real Skype `main.db` while authoring these
  fixtures — every `.tsv` file was typed by hand from the column shapes
  `skype.ts`'s SQL literals declare (`extensions/models/skype.ts` L181-189,
  L224-227, L284-289, L337-345, L397-405, L429-432, L531-539, L581-585,
  L684-691).
- No real Skype handle, display name, phone number, city, or message body
  appears anywhere below. Every identity is an **invented handle** shaped like a
  real one but never registered: `live:.cid.fake0001`..`live:.cid.fake0007` (the
  modern Skype-name-less `live:.cid.` prefix) and one invented group thread id
  `19:fakegroupid001@thread.skype`.
- No production `swamp` instance of `@magistr/skype` exists in this homelab
  today (unlike `porkbun`/`gonic`, which have live instances with a standing
  capture prohibition) — there is nothing to have captured from even
  accidentally.
- Domains/IP addresses do not appear in the Skype `main.db` schema this model
  reads (unlike `porkbun`'s DNS records), so RFC 2606/5737 reserved ranges are
  not applicable here; the synthetic-identity convention above is this corpus's
  equivalent guardrail.

## Every value is synthetic

- Person names: `Ana Synthetic`, `Boris Placeholder`, `Carla Example`,
  `Deniz Sample`, `Fixture Four`, `Fixture Six`, `Fixture Seven` — generic
  placeholder-shaped names, never a real contact.
- Cities/countries: `Rotterdam`/`Amsterdam`/`Netherlands` — real place names
  used only as plausible filler for `Contacts.city`/`Contacts.country`, not tied
  to any real person's actual location.
- Group name: `Fixture Book Club` — invented, not a real Skype group.
- Timestamps: arbitrary Unix epoch integers (`1690000000`-`1700100000`, all
  2023-era) chosen only to exercise `tsToIso`'s ordering and cap logic, plus two
  deliberately out-of-domain values (`0` and `4200000000`) to pin the
  empty-string branches.
- Message bodies: generic filler text (`"found lunch plans"`,
  `"Hello there, exporting &amp; testing."`) or deliberately constructed hostile
  payloads (embedded raw newline/tab bytes, numeric XML entities) — never a real
  conversation excerpt.

## Per-file mapping to the query shape it characterizes

| File                              | Query shape (columns)                                                                                                                                      | Purpose                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversations.tsv`               | `id, identity, displayname, type, msg_count, first_ts, last_ts` (`listConversations`/export conv-list)                                                     | contract + methods happy path, empty-displayname fallback, `tsToIso` empty/cap branches                                                                                                                                                                 |
| `contacts.tsv`                    | `id, skypename, fullname, city, country` (`listContacts`)                                                                                                  | contract + methods happy path, missing-trailing-column `\|\| ""` fallback                                                                                                                                                                               |
| `messages_read.tsv`               | `id, convo_id, author, from_dispname, timestamp, type, body_xml, chatname, dialog_partner` (`readConversation`)                                            | contract + methods happy path, `authorDisplay` fallback, `stripXml` tag/entity decode                                                                                                                                                                   |
| `messages_search.tsv`             | as above + `c.displayname` (`searchBySender`/`searchByText`)                                                                                               | contract + methods happy path for the 10-column search projection                                                                                                                                                                                       |
| `messages_export.tsv`             | `from_dispname, author, timestamp, body_xml` (`exportToObsidian`/`importToObsidian` per-conversation fetch)                                                | contract + methods happy path for the narrow 4-column export projection                                                                                                                                                                                 |
| `messages_newline_corruption.tsv` | as `messages_read.tsv`, but `body_xml` contains a **literal embedded newline** byte                                                                        | adversarial: pins latent bug #1 (TSV row corruption — `queryDb` splits on `"\n"` before `"\t"`, so an unescaped in-field newline fabricates a second, garbage "row")                                                                                    |
| `messages_tab_corruption.tsv`     | as `messages_read.tsv`, but `body_xml` contains a **literal embedded tab** byte                                                                            | adversarial: pins latent bug #1's sibling (column-shift corruption — every field after the tab shifts one position right, and the final `dialog_partner` value is silently dropped)                                                                     |
| `messages_entities.tsv`           | as `messages_read.tsv`, `body_xml` contains one BMP numeric XML entity (`&#9731;`, snowman) and one astral numeric XML entity (`&#128512;`, grinning face) | adversarial: pins latent bug #8 (`stripXml`'s `&#(\d+);` decoder uses `String.fromCharCode`, which is correct for BMP code points but silently mis-decodes any code point above `0xFFFF` into an unrelated BMP character instead of the intended emoji) |

## A behavior this corpus deliberately preserves, not "fixes"

Real `sqlite3` CLI list-mode output (`-separator "\t"`, the mode `skype.ts`'s
`queryDb` uses) does **not** quote or escape embedded tab/newline bytes inside a
`TEXT` column's value — unlike `-json`/CSV mode.
`messages_newline_corruption.tsv` and `messages_tab_corruption.tsv` encode this
real CLI behavior faithfully (a raw `\n`/`\t` byte sitting inside what would be
one logical `body_xml` value) so the adversarial suite exercises the actual
corruption `queryDb`'s naive `text.split("\n").map(line => line.split("\t"))`
parser produces — not a hypothetical.
