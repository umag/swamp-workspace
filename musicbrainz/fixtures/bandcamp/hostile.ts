/**
 * Hostile/malformed Bandcamp album page:
 *  - The JSON-LD `<script>` block is deliberately invalid JSON (unbalanced
 *    braces) -> `JSON.parse` throws inside `parseBandcampAlbumPage`'s own
 *    try/catch, silently leaving `ld = {}` (the malformed/empty JSON-LD pin).
 *  - The page title embeds a raw `<script>` tag (script-injection pin) —
 *    linkedom parses it as an actual (inert, in this parse context) element;
 *    the extracted `textContent` includes the surrounding literal text.
 *  - TralbumData is a SINGLE-LINE minified blob (matching real Bandcamp
 *    output) that embeds an `https://` URL in its `url` field. The source's
 *    comment-strip cleanup (a global regex removing "//" through end of
 *    line) matches the FIRST "//" occurrence (inside "https://") and deletes
 *    everything from there to the
 *    end of the (single) line — i.e. the rest of the URL AND the trailing
 *    `"}]}` that closes the object. The truncated string is unterminated
 *    JSON, so `JSON.parse` throws and is swallowed by the try/catch, leaving
 *    `tracks = []`. This is the pinned "TralbumData //-strip corrupts an
 *    embedded https:// URL" bug — see fixtures/PROVENANCE.md.
 */
export const HOSTILE_ALBUM_HTML = `<!doctype html>
<html>
<head>
<script type="application/ld+json">not valid json at all {{{</script>
</head>
<body>
<div id="name-section"><h2 class="trackTitle">Fixture Hostile <script>alert(1)</script> Static</h2></div>
<div id="band-name-location"><span class="title">Fixture Hostile Artist</span></div>
<script>
var TralbumData = {"current":{"title":"Fixture Hostile Corrupt"},"trackinfo":[{"track_num":1,"title":"Fixture Corrupt Track","duration":200,"url":"https://forceclosed.bandcamp.com/track/fixture-corrupt-track"}]};
</script>
</body>
</html>`;
