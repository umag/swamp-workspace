// Unit tests for the pure want-derivation logic in wanted.ts.
// Run: deno test --allow-env=FC_NUM_RUNS --permit-no-files extensions/lib/wanted_test.ts
//
// RED phase: wanted.ts is a stub that throws "not implemented", so every
// test below fails on that thrown error, not on an assertion. That is the
// correct failure mode here — behaviour is missing, imports/types are not.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveWanted,
  type DesiredReleaseGroup,
  type OwnedAlbum,
  type ResolvedArtist,
  type WantedInput,
  type WantedOpts,
} from "./wanted.ts";

const NOW = "2026-08-04";

function artist(over: Partial<ResolvedArtist> = {}): ResolvedArtist {
  return {
    artistKey: "voidcairn",
    artistName: "Voidcairn",
    mbid: "11111111-1111-1111-1111-111111111111",
    ...over,
  };
}

function rg(over: Partial<DesiredReleaseGroup> = {}): DesiredReleaseGroup {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    title: "Hollow Choir",
    primaryType: "Album",
    secondaryTypes: [],
    firstReleaseDate: "2018-05-04",
    ...over,
  };
}

function owned(over: Partial<OwnedAlbum> = {}): OwnedAlbum {
  return {
    artistKey: "voidcairn",
    title: "Hollow Choir",
    year: 2018,
    qualityBucket: "lossless",
    ...over,
  };
}

Deno.test("deriveWanted: a release-group absent from the library is missing", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: { voidcairn: [rg({ id: "rg-1", title: "Hollow Choir" })] },
    owned: [],
  };
  const r = deriveWanted(input, { now: NOW });
  assertEquals(r.wants.length, 1);
  assertEquals(r.wants[0].kind, "missing");
  assertEquals(r.wants[0].releaseGroupId, "rg-1");
  assertEquals(r.wants[0].artist, "voidcairn");
});

Deno.test("deriveWanted: an owned release-group produces no want", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: { voidcairn: [rg({ id: "rg-1", title: "Hollow Choir" })] },
    owned: [owned({ title: "Hollow Choir", qualityBucket: "lossless" })],
  };
  const r = deriveWanted(input, { now: NOW });
  assertEquals(r.wants.length, 0);
});

Deno.test("deriveWanted: title match tolerates the noise normDupeKey strips", () => {
  // "(Remastered)" is a noise bracket group normDupeKey drops entirely, so
  // "Hollow Choir (Remastered)" and "Hollow Choir" must key identically.
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [rg({ id: "rg-1", title: "Hollow Choir (Remastered)" })],
    },
    owned: [owned({ title: "Hollow Choir", qualityBucket: "lossless" })],
  };
  const r = deriveWanted(input, { now: NOW });
  assertEquals(r.wants.length, 0);
});

Deno.test("deriveWanted: an owned album below target quality is an upgrade want", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: { voidcairn: [rg({ id: "rg-1", title: "Hollow Choir" })] },
    owned: [owned({ title: "Hollow Choir", qualityBucket: "lossy-mid" })],
  };
  const r = deriveWanted(input, { now: NOW, targetQuality: "lossless" });
  assertEquals(r.wants.length, 1);
  assertEquals(r.wants[0].kind, "upgrade");
  assertEquals(r.wants[0].quality, "lossy-mid");
  assertEquals(r.wants[0].targetQuality, "lossless");
});

Deno.test("deriveWanted: an owned album already at the target quality is not an upgrade", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: { voidcairn: [rg({ id: "rg-1", title: "Hollow Choir" })] },
    owned: [owned({ title: "Hollow Choir", qualityBucket: "lossless" })],
  };
  const r = deriveWanted(input, { now: NOW, targetQuality: "lossless" });
  assertEquals(r.wants.length, 0);
});

Deno.test("deriveWanted: a live secondary type is excluded by default", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({
          id: "rg-live",
          title: "Hollow Choir: Live in Rotterdam",
          secondaryTypes: ["Live"],
        }),
      ],
    },
    owned: [],
  };
  const r = deriveWanted(input, { now: NOW });
  assertEquals(r.wants.length, 0);
});

Deno.test("deriveWanted: a compilation secondary type is excluded by default", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({
          id: "rg-comp",
          title: "Best of Voidcairn",
          secondaryTypes: ["Compilation"],
        }),
      ],
    },
    owned: [],
  };
  const r = deriveWanted(input, { now: NOW });
  assertEquals(r.wants.length, 0);
});

Deno.test("deriveWanted: an explicit type policy can opt live/compilation back in", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({
          id: "rg-live",
          title: "Hollow Choir: Live in Rotterdam",
          secondaryTypes: ["Live"],
        }),
      ],
    },
    owned: [],
  };
  const r = deriveWanted(input, {
    now: NOW,
    typePolicy: {
      includePrimaryTypes: ["Album", "EP"],
      excludeSecondaryTypes: [],
    },
  });
  assertEquals(r.wants.length, 1);
  assertEquals(r.wants[0].releaseGroupId, "rg-live");
});

Deno.test("deriveWanted: a release-group dated after now is excluded", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({
          id: "rg-future",
          title: "Unborn Album",
          firstReleaseDate: "2027-01-15",
        }),
      ],
    },
    owned: [],
  };
  const r = deriveWanted(input, { now: NOW });
  assertEquals(r.wants.length, 0);
});

Deno.test("deriveWanted: a release-group dated before now is not excluded", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({
          id: "rg-past",
          title: "Born Album",
          firstReleaseDate: "2025-01-15",
        }),
      ],
    },
    owned: [],
  };
  const r = deriveWanted(input, { now: NOW });
  assertEquals(r.wants.length, 1);
});

// "Uncertain" match: after normDupeKey the two titles are NOT equal (this
// is not the noise-tolerance case above), but they are not unrelated
// either — every normalized token of the owned title is a subset of the
// desired title's tokens (a regional bonus-track suffix). That is the
// deliberately-ambiguous case the bias option exists for:
//   normDupeKey("Voidwalker")                                => "voidwalker"
//   normDupeKey("Voidwalker (Japan Bonus Track Version)")    =>
//     "voidwalker japan track" ("bonus"/"version" are noise words, "japan"
//     and "track" are not, so the bracket survives and the keys diverge)
Deno.test("deriveWanted: an uncertain title match defaults to present (no want)", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({ id: "rg-1", title: "Voidwalker (Japan Bonus Track Version)" }),
      ],
    },
    owned: [owned({ title: "Voidwalker", qualityBucket: "lossless" })],
  };
  const r = deriveWanted(input, { now: NOW });
  assertEquals(r.wants.length, 0);
});

Deno.test("deriveWanted: uncertainMatchPresent: false emits a want for the same uncertain match", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({ id: "rg-1", title: "Voidwalker (Japan Bonus Track Version)" }),
      ],
    },
    owned: [owned({ title: "Voidwalker", qualityBucket: "lossless" })],
  };
  const r = deriveWanted(input, {
    now: NOW,
    uncertainMatchPresent: false,
  });
  assertEquals(r.wants.length, 1);
  assertEquals(r.wants[0].kind, "missing");
});

Deno.test("deriveWanted: every want entry exposes flat top-level keys", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({ id: "rg-missing", title: "New Album" }),
        rg({ id: "rg-upgrade", title: "Hollow Choir" }),
      ],
    },
    owned: [owned({ title: "Hollow Choir", qualityBucket: "lossy-mid" })],
  };
  const r = deriveWanted(input, { now: NOW, targetQuality: "lossless" });
  assertEquals(r.wants.length, 2);
  for (const w of r.wants) {
    assert(Object.hasOwn(w, "artist"));
    assert(Object.hasOwn(w, "releaseGroupId"));
    assert(Object.hasOwn(w, "kind"));
    assert(Object.hasOwn(w, "quality"));
  }
  const upgrade = r.wants.find((w) => w.kind === "upgrade");
  assert(upgrade);
  assertEquals(upgrade.quality, "lossy-mid");
  const missing = r.wants.find((w) => w.kind === "missing");
  assert(missing);
  assertEquals(missing.quality, null);
});

Deno.test("deriveWanted: identical input yields an identical result across calls", () => {
  const input: WantedInput = {
    artists: [artist()],
    desired: {
      voidcairn: [
        rg({ id: "rg-1", title: "Hollow Choir" }),
        rg({
          id: "rg-2",
          title: "New Album",
          firstReleaseDate: "2019-01-01",
        }),
      ],
    },
    owned: [owned({ title: "Hollow Choir", qualityBucket: "lossy-low" })],
  };
  const opts: WantedOpts = { now: NOW, targetQuality: "lossless" };
  const r1 = deriveWanted(input, opts);
  const r2 = deriveWanted(input, opts);
  assertEquals(r1, r2);
});
