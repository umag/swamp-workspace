# Fixture provenance

Every JSON file here is hand-authored to the response shape that Habr's public
`/kek/v2` API returns and that `extensions/models/habr.ts` parses:

- `feed_page1.json`, `feed_page2.json` — `GET /kek/v2/articles/?user=…&page=N`
  (`pagesCount`, `publicationIds[]`, `publicationRefs{id: ref}`). Page 2 lists
  an id (`900404`) with no matching ref, to pin that dangling ids are skipped.
- `article.json` — `GET /kek/v2/articles/<id>/`, a single ref plus `textHtml`.

None was captured from a live Habr response: the ids, aliases, titles and
statistics are invented, and no real user's data appears in them.
