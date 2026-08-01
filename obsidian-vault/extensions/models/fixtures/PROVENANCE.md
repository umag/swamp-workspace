# Fixture provenance

Every file in this directory is **pure synthetic data**, hand-authored to
exercise a specific parsing/serialization shape `obsidian_vault.ts` already
declares (YAML frontmatter block/flow styles, wikilinks, inline tags, PR/ticket
references) or a specific adversarial edge case (CRLF line endings, malformed
YAML, an unterminated frontmatter fence). Nothing here was captured from a
live vault.

## What was NOT done (explicit prohibition)

`obsidian-vault` (`@magistr/obsidian-vault`) models a **personal notes vault**
— the hardest privacy bar in this repo, harder even than a credential-bearing
REST API, because the payload is the user's own private writing rather than a
server's operational metadata. **Live capture from any real Obsidian vault is
FORBIDDEN** for this fixture corpus — not "not done this time", but a standing
rule for anyone regenerating or extending these fixtures later:

- No real note title, heading, body sentence, tag, wikilink target, or
  frontmatter property value from any actual vault appears anywhere below.
- No `swamp model method run <obsidian-vault-instance> <method>` call was ever
  made against a real vault to produce or "inspire" a fixture.
- No real filesystem path outside this fixture directory was read to author
  these files — every path referenced inside a fixture (`target-note`,
  `other-note`, etc.) is an invented placeholder that resolves to nothing.
- No real date, PR number, or ticket identifier appears — `first_post:
  2014-01-08`, `#1234`, `PR-5678`, `ABC-42` are all invented placeholders
  chosen only to exercise a regex shape (a plausible-looking but arbitrary
  value), not transcriptions of real GitHub/Jira activity.

## Why this bar is hard for a notes vault specifically

A REST API fixture corpus (see `seanime/fixtures/PROVENANCE.md` for the prior
precedent in this repo) risks leaking *credentials* if captured live and
redacted sloppily. A notes-vault fixture corpus risks leaking the user's
*actual private writing* — diary-style notes, health/financial/career
reflections, unpublished drafts — which cannot be "redacted" back to something
useful for a test without becoming synthetic anyway. The only safe path is
synthetic-from-the-start, which is what every file here is.

## Every value is synthetic

- Titles: `"@handle posts 2014"`, `Note carrying frontmatter comments`,
  `Inline flow list note`, `Note with a horizontal rule`, `Link and tag
  extraction fixture`, `CRLF sample note`, `Malformed frontmatter sample`,
  `Unterminated frontmatter sample` — all invented, generic placeholder titles.
- Wikilink/heading targets: `target-note`, `other-note`, `third-note` — invented
  placeholders that do not resolve to any real note.
- Tags: `#inline-tag`, `#nested/tag`, `social`, `social-posts`, `fixture`,
  `imported` — generic placeholder tag names.
- PR/ticket references: `#1234`, `PR-5678`, `ABC-42`, `LONGER-1` — syntactically
  valid but arbitrary placeholders, not references to any real PR or ticket in
  this or any other repository.
- Dates: `2014-01-08`, `2014-12-30`, `2026-02-31` (deliberately an *impossible*
  calendar date — see below) — invented or deliberately-invalid placeholders.
- No hostnames appear in these fixtures (the model operates on local paths, not
  URLs); where a CLI backend example needs a vault *name* in the test suites
  themselves rather than in a fixture file, it uses `testvault` /
  `myvault` — generic placeholders, never a real registered Obsidian vault
  name from this homelab.

## Per-file mapping to what it exercises

| File                            | Exercises                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `block-list.md`                  | Block-style YAML list (`tags:` with `- ` entries), a title needing quoting (leading `@`), key-order preservation |
| `flow-list.md`                   | Inline flow-style YAML lists (`tags: [a, b]`), boolean and float scalars |
| `no-frontmatter.md`              | A note with no frontmatter block at all — the "add a block" and "values needing quoting" paths |
| `hr-in-body.md`                  | A `---` horizontal rule in the body, which must not be mistaken for the frontmatter closing fence |
| `commented.md`                   | Leading and inline YAML comments inside the frontmatter block, which must survive a round trip |
| `links-and-tags.md`              | Headings (levels 1-5, level 5 excluded), plain/aliased/heading-anchored wikilinks, inline tags (incl. one nested under a `/`), a tag-shaped code span and URL fragment that must NOT be extracted, PR references in both `#1234` and `PR-5678` form, and ticket references (`ABC-42`, `LONGER-1`) |
| `crlf-frontmatter.md`            | **Adversarial.** A frontmatter block using Windows-style CRLF (`\r\n`) line endings throughout — pins `obsidian-vault-latent-bugs` #1 (the opening-fence check is LF-only, so this note's real properties are silently invisible to `readProperties`, and `setProperties`/`mergeProperties` corrupt it by prepending a second frontmatter block) |
| `malformed-frontmatter.md`       | **Adversarial.** A frontmatter block using a tab character for indentation — invalid YAML per the `yaml` package's block-mapping rules — characterizes that both the read path (`readProperties`, via `YAML.parse`) and the write path (`mergeProperties`, via `Document#toString` after `YAML.parseDocument`) throw rather than silently producing wrong data |
| `unterminated-frontmatter.md`    | **Adversarial.** A note that opens a `---` fence but never closes it — characterizes that `splitFrontmatter` falls all the way through to `hasFrontmatter: false` (the entire file, including the orphaned `---` line, becomes "body"), so `readProperties` returns `{}` silently and `mergeProperties` prepends a fresh frontmatter block ahead of the orphaned fence — the same "duplicate block" *shape* of bug as CRLF pin #1, but triggered from the missing-closing-fence side rather than the missing-opening-fence side. Not itself one of the seven catalogued pins (it is not asserted as a numbered `obsidian-vault-latent-bugs` entry), but documented here since a future reader of the CRLF pin will reasonably ask about this sibling case |

## A note on `crlf-frontmatter.md`'s bytes specifically

This file was written with `printf` (real `\r\n` byte pairs), not the
str-replace-based fixture-authoring path used for the other files, specifically
so the CRLF bytes survive a real `git add`/`git commit` unmodified — this repo
has no `.gitattributes` line-ending normalization rule (verified before
authoring this fixture), so no special Git configuration was required, but the
authoring method is called out here in case that ever changes. The adversarial
suite that reads this fixture (`obsidian_vault_adversarial_test.ts`) also
constructs the equivalent CRLF content **inline** as a JavaScript template
literal (not depending solely on the committed file's bytes) and additionally
asserts the fixture-on-disk genuinely contains a raw `\r` byte before relying
on it — so a future accidental Git normalization would fail loudly (a broken
assertion) rather than silently downgrading the pinned characterization to a
no-op.
