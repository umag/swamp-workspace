/**
 * Synthetic Bandcamp album page — the JSON-LD ("schema.org/MusicAlbum") path.
 * `parseBandcampAlbumPage` reads `ld.track.itemListElement` here directly, so
 * the TralbumData fallback is never reached. One track uses an ISO-8601
 * duration WITH an hours component ("PT1H2M30S") to pin the documented gap:
 * `durationMs` correctly includes the hour, but the recomputed `duration`
 * display string only formats `${minutes}:${seconds}`, silently dropping the
 * hour ("2:30" instead of "1:02:30"). See fixtures/PROVENANCE.md.
 */
export const ALBUM_JSONLD_HTML = `<!doctype html>
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MusicAlbum",
  "name": "Fixture Nightfall Static",
  "byArtist": { "@type": "MusicGroup", "name": "Fixture Aurora Static" },
  "datePublished": "2021-05-14",
  "track": {
    "@type": "ItemList",
    "numberOfItems": 3,
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "item": { "@type": "MusicRecording", "name": "Fixture Opening Static", "duration": "PT3M12S" } },
      { "@type": "ListItem", "position": 2, "item": { "@type": "MusicRecording", "name": "Fixture Long Static Drift", "duration": "PT1H2M30S" } },
      { "@type": "ListItem", "position": 3, "item": { "@type": "MusicRecording", "name": "Fixture Closing Static", "duration": "PT4M05S" } }
    ]
  }
}
</script>
</head>
<body>
<div id="name-section"><h2 class="trackTitle">Fixture Nightfall Static</h2></div>
<div id="band-name-location"><span class="title">Fixture Aurora Static</span></div>
<div class="tralbumData tralbum-tags">
  <a class="tag" href="/tag/ambient">ambient</a>
  <a class="tag" href="/tag/synthwave">synthwave</a>
</div>
</body>
</html>`;
