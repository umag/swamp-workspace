/**
 * Synthetic Bandcamp artist/discography page — the JSON-LD ("schema.org")
 * path. `parseBandcampArtistPage` reads `ld.album[]` directly, so the
 * `#music-grid` DOM fallback is never reached.
 */
export const ARTIST_JSONLD_HTML = `<!doctype html>
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MusicGroup",
  "name": "Fixture Aurora Static",
  "album": [
    { "@id": "https://fixtureaurorastatic.bandcamp.com/album/fixture-nightfall-static", "name": "Fixture Nightfall Static", "datePublished": "2021-05-14", "numTracks": 3 },
    { "@id": "https://fixtureaurorastatic.bandcamp.com/album/fixture-static-interference-ep", "name": "Fixture Static Interference EP", "datePublished": "2019-11-02", "track": { "numberOfItems": 2 } }
  ]
}
</script>
</head>
<body>
<p id="band-name-location"><span class="title">Fixture Aurora Static</span></p>
</body>
</html>`;
