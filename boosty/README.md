# @magistr/boosty

Archive a [Boosty](https://boosty.to) blog to a folder of Markdown notes with
images downloaded locally. The output is laid out for an Obsidian vault: one
note per post, YAML frontmatter, and relative image embeds into an
`attachments/` folder next to the notes.

It reads Boosty's JSON API (`api.boosty.to/v1/blog/<blog>/post/`) directly
and pages through the whole feed in one method run.

## Setup

Free posts need no credentials. Paid posts come back as teaser-only unless the
request carries the access token of an account that subscribes to the blog.
Store it in a vault and reference it from the instance:

```bash
swamp vault put secrets BOOSTY_ACCESS_TOKEN   # paste the `auth` cookie value
swamp behavior create @magistr/boosty boosty \
  --global-arg 'accessToken=${{ vault.get(secrets, BOOSTY_ACCESS_TOKEN) }}'
```

The value can be the bare token or the whole `auth` cookie from boosty.to
(URL-encoded JSON); the model extracts `accessToken` itself. Check it with:

```bash
swamp behavior run boosty whoami --input blog=rottenkepken
```

## Archive

```bash
swamp behavior run boosty archive \
  --input blog=rottenkepken \
  --input outputDir=/path/to/vault/Boosty/rottenkepken
```

Each post becomes `YYYY-MM-DD <title>.md` with frontmatter `title`, `date`,
`source`, `author`, `boosty_id`, `access` (`full` or `locked`) and `tags`.
Images are saved as `attachments/<blog>-<post>-<imageid>.<ext>`.

Reruns are idempotent: existing images are not downloaded again and notes
whose rendered text did not change are not rewritten. Re-run after adding a
token to fill in previously locked posts.

## Safety

- Only `https://boosty.to` and `*.boosty.to` are fetched; image URLs on any
  other host are left as remote links.
- The blog slug and image ids are validated before they reach a URL or a file
  name; titles are reduced to a single safe path segment.
- `outputDir` must be absolute.
