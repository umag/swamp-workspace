/**
 * Contract-fixture suite for @magistr/spotify-data.
 *
 * Pins the parse boundary against the RECORD SHAPE Spotify actually emits, as
 * carried by fixtures/Streaming_History_Audio_2023_1.json (hand-authored — see
 * fixtures/PROVENANCE.md for why no real export is committed). If a test here
 * breaks, the export format changed, not this model's internals.
 *
 * The privacy pins are the load-bearing ones: `ip_addr`, `conn_country`,
 * `platform` and `incognito_mode` are present on every fixture record
 * precisely so their ABSENCE from a parsed Stream is observable.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  isAudiobook,
  isPodcast,
  parseHistoryFile,
  partitionByYear,
  SCROBBLE_THRESHOLD_MS,
  SPOTIFY_TS_IS_END_TIME,
  type Stream,
  toStream,
  toUts,
} from "./spotify_data.ts";
import history from "../../fixtures/Streaming_History_Audio_2023_1.json" with {
  type: "json",
};

const RAW = history as unknown[];

Deno.test("fixture: the committed export slice has the nine records the parse boundary is pinned against", () => {
  assertEquals(RAW.length, 9);
});

Deno.test("contract: parseHistoryFile classifies the fixture into 6 music streams, 1 podcast, 1 audiobook, 1 unusable", () => {
  const r = parseHistoryFile(RAW);
  assertEquals(r.streams.length, 6);
  assertEquals(r.podcasts, 1);
  assertEquals(r.audiobooks, 1);
  assertEquals(r.unusable, 1);
  // Every record is accounted for — a record can never vanish uncounted.
  assertEquals(
    r.streams.length + r.podcasts + r.audiobooks + r.unusable,
    RAW.length,
  );
});

Deno.test("PRIVACY contract: no parsed Stream carries ip_addr, conn_country, platform or incognito_mode, though every fixture record does", () => {
  // Guard the guard: if the fixture ever stops carrying these, this suite
  // would pass vacuously and the privacy boundary would be untested.
  for (const raw of RAW as Array<Record<string, unknown>>) {
    assert("ip_addr" in raw, "fixture record must carry ip_addr");
    assert("incognito_mode" in raw, "fixture record must carry incognito_mode");
  }

  const { streams } = parseHistoryFile(RAW);
  assert(streams.length > 0);
  for (const s of streams) {
    const keys = Object.keys(s);
    for (
      const banned of [
        "ip_addr",
        "conn_country",
        "platform",
        "incognito_mode",
      ]
    ) {
      assert(
        !keys.includes(banned),
        `Stream must never carry "${banned}" — the privacy boundary is toStream`,
      );
    }
    // Belt and braces: no VALUE from the trail survives either, under any key.
    const serialized = JSON.stringify(s);
    assert(
      !serialized.includes("203.0.113."),
      "no source IP may survive into a Stream under any key",
    );
  }
});

Deno.test("contract: Spotify's field names map onto Stream as documented", () => {
  const s = toStream(RAW[0]);
  assert(s);
  assertEquals(s.artist, "Japan"); // master_metadata_album_artist_name
  assertEquals(s.track, "Ghosts"); // master_metadata_track_name
  assertEquals(s.album, "Tin Drum"); // master_metadata_album_album_name
  assertEquals(s.msPlayed, 214000); // ms_played
  assertEquals(s.trackUri, "spotify:track:0000000000000000000001");
  assertEquals(s.reasonStart, "clickrow"); // reason_start
  assertEquals(s.reasonEnd, "trackdone"); // reason_end
  assertEquals(s.skipped, false);
  assertEquals(s.shuffle, false);
  assertEquals(s.offline, false);
});

Deno.test("contract: ts is parsed as UTC seconds, and is an END timestamp", () => {
  assertEquals(toUts("2023-04-01T18:22:05Z"), 1680373325);
  // The constant is part of the model's public contract: the overlap report
  // relies on it to justify a tolerance window rather than equality.
  assertEquals(SPOTIFY_TS_IS_END_TIME, true);
});

Deno.test("contract: a null master_metadata_album_album_name yields no album rather than the string 'null'", () => {
  const autechre = (RAW as Array<Record<string, unknown>>).find(
    (r) => r.spotify_track_uri === "spotify:track:0000000000000000000003",
  );
  assertEquals(autechre?.master_metadata_album_album_name, null);
  const s = toStream(autechre);
  assert(s);
  assertEquals(s.album, undefined);
});

Deno.test("contract: podcast episodes are identified by episode_name and excluded", () => {
  const podcast = (RAW as Array<Record<string, unknown>>).find((r) =>
    typeof r.episode_name === "string"
  );
  assert(podcast);
  assert(isPodcast(podcast));
  assertEquals(toStream(podcast), undefined);
});

Deno.test("contract: audiobook chapters are identified by audiobook_title and excluded", () => {
  const book = (RAW as Array<Record<string, unknown>>).find((r) =>
    typeof r.audiobook_title === "string"
  );
  assert(book);
  assert(isAudiobook(book));
  assertEquals(toStream(book), undefined);
});

Deno.test("FIDELITY contract: a 4.2s play survives parsing — the sub-threshold tail is the one thing a Last.fm history cannot hold", () => {
  const { streams } = parseHistoryFile(RAW);
  const short = streams.find((s) => s.artist === "Za Frûmi");
  assert(short, "the sub-threshold play must reach a Stream");
  assertEquals(short.msPlayed, 4200);
  assert(short.msPlayed < SCROBBLE_THRESHOLD_MS);
  assertEquals(short.skipped, true);
});

Deno.test("contract: the UTC year boundary splits two plays two seconds apart into different chunks", () => {
  const { streams } = parseHistoryFile(RAW);
  const parts = partitionByYear(streams);
  const nye = streams.find((s) => s.track === "Untitled");
  const nyd = streams.find((s) => s.track === "Second Bad Vilbel");
  assert(nye && nyd);
  assertEquals(nyd.uts - nye.uts, 2);
  assert(parts.get("2023")?.some((s) => s.track === "Untitled"));
  assert(parts.get("2024")?.some((s) => s.track === "Second Bad Vilbel"));
});

Deno.test("contract: the fixture's three same-second Ghosts records are NOT all duplicates — one differs in ms_played and reason_end", () => {
  const { streams } = parseHistoryFile(RAW);
  const ghosts = streams.filter((s: Stream) => s.track === "Ghosts");
  assertEquals(ghosts.length, 3, "all three parse; dedupe is a later step");
  const distinctMs = new Set(ghosts.map((s) => s.msPlayed));
  assertEquals(
    distinctMs.size,
    2,
    "two share ms_played, the third is a separate segment of the same play",
  );
});
