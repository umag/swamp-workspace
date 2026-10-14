# Fixture provenance

Hand-written to the shapes documented at
https://developer.themoviedb.org/reference (v3): `/search/movie`,
`/search/tv`, `/movie/{id}` and `/tv/{id}` with
`append_to_response=credits,keywords,external_ids,release_dates|content_ratings`,
and the documented error envelope (`status_code`, `status_message`,
`success`). Values are trimmed real-world data for Forrest Gump (13) and
Sherlock (19885); `search-movie.json` adds a malformed row and a `person`
row to exercise the normalizer's filtering.
