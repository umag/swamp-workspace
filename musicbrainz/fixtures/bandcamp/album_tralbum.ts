/**
 * Synthetic Bandcamp album page exercising the TralbumData FALLBACK path —
 * the JSON-LD block deliberately omits `track`, so `parseBandcampAlbumPage`
 * finds `tracks.length === 0` after the JSON-LD pass and falls back to
 * regex-extracting `var TralbumData = {...};` from a `<script>` tag.
 * TralbumData is written on a SINGLE line (matching real, minified Bandcamp
 * output) and contains no "//" sequence, so the //-comment-strip cleanup is a
 * no-op here — this fixture is the WORKING fallback case. Contrast with
 * hostile.ts, which embeds an https:// URL to pin the corruption bug.
 */
export const ALBUM_TRALBUM_HTML = `<!doctype html>
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MusicAlbum",
  "name": "Fixture Static Interference EP",
  "byArtist": { "@type": "MusicGroup", "name": "Fixture Marin Holloway" },
  "datePublished": "2019-11-02"
}
</script>
</head>
<body>
<div id="name-section"><h2 class="trackTitle">Fixture Static Interference EP</h2></div>
<div id="band-name-location"><span class="title">Fixture Marin Holloway</span></div>
<script>
var TralbumData = {"current":{"title":"Fixture Static Interference EP"},"trackinfo":[{"track_num":1,"title":"Fixture Drift One","duration":187.5},{"track_num":2,"title":"Fixture Drift Two","duration":233.25}]};
</script>
</body>
</html>`;
