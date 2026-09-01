# Fixture provenance

## `Streaming_History_Audio_2023_1.json`

**Synthetic. Hand-authored, not captured from a real export.**

A Spotify "Extended streaming history" export is one of the most personal files
a person owns: every record carries `ip_addr`, and most carry `conn_country`,
`platform` and `incognito_mode` — a location and device trail spanning years.
Committing a redacted slice of a real export would put that trail one `git log`
away from being reconstructed, so no part of this fixture came from one.

What it does reproduce is the **record shape** documented in Spotify's
"Understanding my data" article, and the specific shapes the parser has to
survive. It is a contract fixture for the field names and value types, never a
sample of anyone's listening.

The nine records are chosen to exercise one decision each:

| # | Record                                                                  | Exercises                                                                                                                    |
| - | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1 | Japan — Ghosts, 214000ms                                                | an ordinary above-threshold music stream                                                                                     |
| 2 | byte-identical copy of #1                                               | a genuine export artifact, correct to collapse                                                                               |
| 3 | same `ts`/artist/track as #1, `ms_played` 31000, different `reason_end` | the multi-segment play that a (ts, artist, track) key would wrongly discard — the reason `streamKey` hashes the whole record |
| 4 | Za Frûmi — 4200ms, `skipped: true`                                      | a sub-30s play, the tail Last.fm structurally cannot hold; also the diacritic that `foldTitle` folds                         |
| 5 | Autechre, `2023-12-31T23:59:59Z`, `album: null`                         | the UTC year boundary, and a null album                                                                                      |
| 6 | Autechre, `2024-01-01T00:00:01Z`                                        | the other side of that boundary — two seconds apart, two different year chunks                                               |
| 7 | `episode_name` set                                                      | a podcast episode, excluded                                                                                                  |
| 8 | `audiobook_title` set                                                   | an audiobook chapter, excluded                                                                                               |
| 9 | every metadata field null                                               | an unusable record, counted not dropped silently                                                                             |

Every record carries `ip_addr`, `conn_country`, `platform` and `incognito_mode`
**on purpose**: the privacy boundary in `toStream` is only meaningfully tested
by a fixture that actually contains the fields it must refuse to copy. The IPs
are from `203.0.113.0/24` (TEST-NET-3, RFC 5737), reserved for documentation and
routable to nobody.

The `spotify:track:` URIs are zero-padded placeholders, not real track ids.

## Live capture

Do not add a fixture captured from a real export to this directory, redacted or
otherwise. If a future test needs a shape this file does not cover, extend this
file with another hand-authored record and add a row to the table above.
