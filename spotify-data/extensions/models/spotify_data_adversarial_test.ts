/**
 * Adversarial suite for @magistr/spotify-data.
 *
 * The threat model is unusual for this repo and worth stating, because it
 * shapes every test here. This model has NO credential, makes NO network call,
 * and never writes to the export. So the attacker surface is not a hostile
 * server — it is:
 *
 *  1. A HOSTILE EXPORT FILE. The export is an untrusted archive the user
 *     downloaded; a malicious or corrupt one must never crash the importer
 *     into a partial write, smuggle a field past the privacy boundary, or
 *     escape the directory it was extracted into.
 *  2. THE PRIVACY BOUNDARY ITSELF. The location/device trail in the source is
 *     the sensitive asset. A record shaped to sneak `ip_addr` through under an
 *     alias, or to survive as a raw passthrough, is the leak this model exists
 *     to prevent.
 *  3. RESOURCE NAME COLLISION. A crafted year or label must not let one
 *     record's chunk overwrite another's.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  chunkName,
  dedupeStreams,
  model,
  parseHistoryFile,
  partitionByYear,
  streamKey,
  toStream,
  toUts,
} from "./spotify_data.ts";

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: never, c: unknown) => Promise<{ dataHandles: unknown[] }>;
}>;

function makeCtx(exportPath: string, label = "spotify") {
  const written: Array<{ spec: string; name: string; data: Json }> = [];
  return {
    written,
    ctx: {
      globalArgs: { exportPath, label },
      logger: { info: () => {}, warning: () => {}, error: () => {} },
      writeResource: (spec: string, name: string, data: Json) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

// deno-lint-ignore no-explicit-any
type Json = any;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as unknown as MethodMap)[name];
  return method.execute(method.arguments.parse(args) as never, ctx);
}

async function withRecords(
  records: unknown[],
  fn: (dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: "spotify_adv_" });
  try {
    await Deno.writeTextFile(
      `${dir}/Streaming_History_Audio_x.json`,
      JSON.stringify(records),
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Hostile / malformed export content
// ---------------------------------------------------------------------------

Deno.test("adversarial: a record whose every field is the wrong type is dropped as unusable, never crashes the parse", () => {
  const hostile = [
    { ts: 12345, ms_played: "lots", master_metadata_track_name: [] },
    {
      ts: null,
      master_metadata_track_name: {},
      master_metadata_album_artist_name: 7,
    },
    { ts: "2023-01-01T00:00:00Z", master_metadata_track_name: 5 },
    {},
    {
      ts: "not-a-date",
      master_metadata_track_name: "t",
      master_metadata_album_artist_name: "a",
    },
  ];
  const r = parseHistoryFile(hostile);
  assertEquals(r.streams.length, 0);
  assertEquals(r.unusable, hostile.length);
});

Deno.test("adversarial: null and primitive entries inside the array are counted, not thrown on", () => {
  const r = parseHistoryFile([null, undefined, 42, "string", true, []]);
  assertEquals(r.streams.length, 0);
  assertEquals(r.unusable, 6);
});

Deno.test("adversarial: a NEGATIVE ms_played is clamped to 0 rather than corrupting msPlayedTotal into a negative", () => {
  const s = toStream({
    ts: "2023-01-01T00:00:00Z",
    ms_played: -999999,
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
  });
  assert(s);
  assertEquals(s.msPlayed, 0);
});

Deno.test("adversarial: a non-finite or absurd timestamp cannot mint a chunk — NaN and Infinity are refused", () => {
  assertEquals(toUts("Invalid Date"), undefined);
  assertEquals(toUts(""), undefined);
  assertEquals(toUts(Infinity), undefined);
  assertEquals(toUts(NaN), undefined);
  assertEquals(toUts({}), undefined);
  // A record carrying one is dropped rather than partitioned into "NaN".
  const r = parseHistoryFile([{
    ts: "Invalid Date",
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
  }]);
  assertEquals(r.streams.length, 0);
});

Deno.test("adversarial: a corrupt history file fails the whole import rather than writing a partial chunk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "spotify_adv_" });
  try {
    await Deno.writeTextFile(
      `${dir}/Streaming_History_Audio_1.json`,
      JSON.stringify([{
        ts: "2023-01-01T00:00:00Z",
        ms_played: 1000,
        master_metadata_track_name: "t",
        master_metadata_album_artist_name: "a",
      }]),
    );
    await Deno.writeTextFile(
      `${dir}/Streaming_History_Audio_2.json`,
      "{ this is not json",
    );
    const { ctx, written } = makeCtx(dir);
    await assertRejects(() => run("import", {}, ctx));
    // Fail-closed: gather() reads every file BEFORE any write, so a corrupt
    // second file cannot leave a half-written first year behind.
    assertEquals(
      written.length,
      0,
      "no resource may be written when any history file fails to parse",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The privacy boundary under attack
// ---------------------------------------------------------------------------

Deno.test("adversarial: extra attacker-chosen fields on a record are NOT copied through — toStream allowlists, never spreads", () => {
  const s = toStream({
    ts: "2023-01-01T00:00:00Z",
    ms_played: 1000,
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
    ip_addr: "203.0.113.5",
    conn_country: "NL",
    platform: "osx",
    incognito_mode: true,
    // Fields that do not exist in the real export at all:
    user_email: "someone@example.test",
    __proto__polluter: "x",
    latitude: 52.37,
    longitude: 4.9,
  });
  assert(s);
  const keys = Object.keys(s).sort();
  assertEquals(keys, [
    "album",
    "artist",
    "msPlayed",
    "offline",
    "reasonEnd",
    "reasonStart",
    "shuffle",
    "skipped",
    "track",
    "trackUri",
    "uts",
  ]);
  const json = JSON.stringify(s);
  for (
    const secret of ["203.0.113.5", "someone@example.test", "52.37", "4.9"]
  ) {
    assert(!json.includes(secret), `"${secret}" must not survive toStream`);
  }
});

Deno.test("adversarial: the privacy trail does not survive a full import into any written resource", async () => {
  await withRecords(
    [{
      ts: "2023-01-01T00:00:00Z",
      ms_played: 1000,
      master_metadata_track_name: "t",
      master_metadata_album_artist_name: "a",
      ip_addr: "203.0.113.5",
      conn_country: "NL",
      platform: "osx-secret-build",
      incognito_mode: true,
    }],
    async (dir) => {
      const { ctx, written } = makeCtx(dir);
      await run("import", {}, ctx);
      assert(written.length > 0);
      for (const w of written) {
        const json = JSON.stringify(w.data);
        for (const secret of ["203.0.113.5", "osx-secret-build"]) {
          assert(
            !json.includes(secret),
            `"${secret}" leaked into resource ${w.spec}/${w.name}`,
          );
        }
      }
    },
  );
});

Deno.test("adversarial: incognito_mode true does not mark the resulting Stream in any way — the flag is dropped, not mirrored", () => {
  const open = toStream({
    ts: "2023-01-01T00:00:00Z",
    ms_played: 1000,
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
    incognito_mode: false,
  });
  const secret = toStream({
    ts: "2023-01-01T00:00:00Z",
    ms_played: 1000,
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
    incognito_mode: true,
  });
  // Byte-identical: an observer of the resource cannot tell the two apart,
  // which is the point of dropping the field rather than storing false.
  assertEquals(JSON.stringify(open), JSON.stringify(secret));
});

// ---------------------------------------------------------------------------
// 3. Key / name collision
// ---------------------------------------------------------------------------

Deno.test("adversarial: a NUL-free artist/track cannot forge another record's streamKey — the delimiter is unrepresentable in the input", () => {
  // With a printable delimiter, ("a b", "c") and ("a", "b c") collide.
  const base = {
    uts: 1,
    msPlayed: 0,
    album: undefined,
    trackUri: undefined,
    skipped: undefined,
    shuffle: undefined,
    offline: undefined,
    reasonStart: undefined,
    reasonEnd: undefined,
  };
  const left = streamKey({ ...base, artist: "a b", track: "c" });
  const right = streamKey({ ...base, artist: "a", track: "b c" });
  assert(left !== right, "a space-separated key would collide here");
});

Deno.test("adversarial: two records differing ONLY in a privacy field collapse to one — the trail cannot inflate a playcount", () => {
  const mk = (ip: string) => ({
    ts: "2023-01-01T00:00:00Z",
    ms_played: 1000,
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
    ip_addr: ip,
  });
  const { streams } = parseHistoryFile([mk("203.0.113.1"), mk("203.0.113.2")]);
  assertEquals(streams.length, 2, "both parse");
  assertEquals(
    dedupeStreams(streams).length,
    1,
    "but they are the same play — the dropped IP cannot distinguish them",
  );
});

Deno.test("adversarial: a record differing only in ms_played does NOT collapse — a real segment is never lost to dedupe", () => {
  const mk = (ms: number) => ({
    ts: "2023-01-01T00:00:00Z",
    ms_played: ms,
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
  });
  const { streams } = parseHistoryFile([mk(1000), mk(2000)]);
  assertEquals(dedupeStreams(streams).length, 2);
});

Deno.test("adversarial: chunkName is prefixed, so a year can never collide with the import-state resource name", () => {
  assertEquals(chunkName("2023"), "spotify.2023");
  assert(chunkName("2023") !== "import.spotify");
  // Even a hostile "year" stays inside the spotify. namespace.
  assert(chunkName("../../etc").startsWith("spotify."));
});

Deno.test("adversarial: the year argument's regex refuses traversal and separator characters outright", () => {
  const args = (model.methods as unknown as MethodMap).import.arguments;
  for (
    const bad of ["../2023", "2023/", "20 3", "2023 ", "%2e%2e", "*"]
  ) {
    let threw = false;
    try {
      args.parse({ year: bad });
    } catch {
      threw = true;
    }
    assert(threw, `year "${bad}" must be rejected before reaching the model`);
  }
});

Deno.test("adversarial: a far-future and a pre-epoch timestamp partition into their real UTC years, never into a shared bucket", () => {
  const rows = [
    {
      uts: toUts("1969-07-20T20:17:00Z")!,
      artist: "a",
      track: "t",
      msPlayed: 0,
    },
    {
      uts: toUts("2999-01-01T00:00:00Z")!,
      artist: "a",
      track: "t",
      msPlayed: 0,
    },
  ];
  const parts = partitionByYear(rows);
  assertEquals([...parts.keys()].sort(), ["1969", "2999"]);
});
