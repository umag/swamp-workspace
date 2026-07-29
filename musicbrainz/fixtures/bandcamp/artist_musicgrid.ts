/**
 * Synthetic Bandcamp artist/discography page with NO JSON-LD block at all —
 * `parseBandcampArtistPage`'s `ld.album || ld.discography || []` collapses to
 * `[]`, so this fixture exercises the `#music-grid .music-grid-item` DOM
 * fallback exclusively.
 */
export const ARTIST_MUSICGRID_HTML = `<!doctype html>
<html>
<head></head>
<body>
<p id="band-name-location"><span class="title">Fixture Marin Holloway</span></p>
<div id="music-grid">
  <ol>
    <li class="music-grid-item">
      <a href="/album/fixture-drift-sessions">
        <p class="title">Fixture Drift Sessions</p>
      </a>
    </li>
    <li class="music-grid-item">
      <a href="/track/fixture-single-echo">
        <p class="title">Fixture Single Echo</p>
      </a>
    </li>
  </ol>
</div>
</body>
</html>`;
