// Want derivation — the pure diff between "the discography an artist
// should have" (MusicBrainz release-groups) and "the discography the
// library actually has" (the music_library cube), shared by the `wanted`
// method (which stores the want-set) and downstream reporting/automation
// that queries it. Pure — no I/O, no fetch, no Date.now().
//
// A Want is a VALUE OBJECT: immutable, no identity, fully defined by
// (artist, releaseGroupId, kind). The whole want-set is recomputed from
// scratch on every run — there is deliberately no mutable status field
// (queued/snatched/done). The system this replaces drifted because it had
// one: recomputing means a want simply stops appearing once it stops being
// true, instead of needing to be marked done by hand.
//
// Two policy calls shape the diff:
//
//   1. Type policy — a MusicBrainz release-group list mixes real studio
//      albums in with lives, compilations, and remixes. Only
//      primaryType/secondaryTypes the policy opts into become wants; the
//      default keeps studio albums and EPs and drops live/compilation/
//      remix secondary types.
//   2. Uncertain-match bias — title matching against the owned cube is
//      exact after `normDupeKey` (imported from ./norm.ts, not
//      re-implemented here), but a real library also turns up titles that
//      are CLOSE without being equal — genuinely uncertain whether it is
//      the same release. The default treats an uncertain match as PRESENT
//      (no want): a false want costs a junk download, a false "have"
//      costs only a missed album, so the default errs toward not
//      downloading. An option flips that bias for a completionist pass.

import { normDupeKey } from "./norm.ts";

/** Release-group as returned by a MusicBrainz release-group lookup. */
export interface DesiredReleaseGroup {
  id: string;
  title: string;
  primaryType: string | null;
  secondaryTypes: string[];
  /** ISO-8601 date (YYYY, YYYY-MM, or YYYY-MM-DD), or null if unknown. */
  firstReleaseDate: string | null;
}

/** An artist already resolved to a MusicBrainz identity. */
export interface ResolvedArtist {
  artistKey: string;
  artistName: string;
  mbid: string;
}

/** The quality buckets music_library.ts's qualityBucket() assigns. */
export type QualityBucket =
  | "lossless"
  | "lossy-high"
  | "lossy-mid"
  | "lossy-low"
  | "unknown";

/**
 * Quality buckets ranked worst to best. A higher index in this array beats
 * a lower one; used to decide whether an owned album falls short of the
 * target bucket.
 */
export const QUALITY_RANK: readonly QualityBucket[] = [
  "unknown",
  "lossy-low",
  "lossy-mid",
  "lossy-high",
  "lossless",
];

/**
 * An owned album fact from the local cube (buildCube's album records),
 * narrowed to what want-derivation needs.
 */
export interface OwnedAlbum {
  artistKey: string;
  title: string;
  year: number | null;
  qualityBucket: QualityBucket;
}

/**
 * primaryType/secondaryTypes policy deciding which release-groups are
 * candidates at all, independent of whether the library already has them.
 */
export interface TypePolicy {
  includePrimaryTypes: string[];
  excludeSecondaryTypes: string[];
}

export const DEFAULT_TYPE_POLICY: TypePolicy = {
  includePrimaryTypes: ["Album", "EP"],
  excludeSecondaryTypes: ["Live", "Compilation", "Remix"],
};

export const DEFAULT_TARGET_QUALITY: QualityBucket = "lossless";

/**
 * See module doc: an uncertain title match defaults to PRESENT (no want)
 * because a false want costs a junk download, a false "have" costs only a
 * missed album.
 */
export const DEFAULT_UNCERTAIN_MATCH_PRESENT = true;

export interface WantedOpts {
  /**
   * ISO-8601 reference "now". The only clock this pure function reads —
   * never call Date.now() inside deriveWanted.
   */
  now: string;
  targetQuality?: QualityBucket;
  typePolicy?: TypePolicy;
  /** Default: DEFAULT_UNCERTAIN_MATCH_PRESENT. */
  uncertainMatchPresent?: boolean;
}

export interface WantedInput {
  artists: ResolvedArtist[];
  /** Desired discography per artist, keyed by artistKey. */
  desired: Record<string, DesiredReleaseGroup[]>;
  owned: OwnedAlbum[];
}

export type WantKind = "missing" | "upgrade";

/**
 * A single want. FLAT by contract — artist, releaseGroupId, kind, and
 * quality are all top-level keys so `swamp data query --select` can reach
 * them without traversing nested optionals.
 */
export interface WantEntry {
  artist: string;
  artistName: string;
  releaseGroupId: string;
  title: string;
  kind: WantKind;
  /** Owned quality bucket; null for "missing" (nothing owned yet). */
  quality: QualityBucket | null;
  targetQuality: QualityBucket;
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
}

export interface WantedResult {
  wants: WantEntry[];
}

/** A release-group is a candidate at all only if the type policy allows it. */
function passesTypePolicy(
  rg: DesiredReleaseGroup,
  policy: TypePolicy,
): boolean {
  if (rg.primaryType === null) return false;
  if (!policy.includePrimaryTypes.includes(rg.primaryType)) return false;
  return !rg.secondaryTypes.some((t) =>
    policy.excludeSecondaryTypes.includes(t)
  );
}

/** True if `rg.firstReleaseDate` is strictly after `now` (excluded). */
function isFutureRelease(rg: DesiredReleaseGroup, now: string): boolean {
  if (rg.firstReleaseDate === null) return false;
  return rg.firstReleaseDate > now;
}

/**
 * Match confidence between a desired release-group and an owned album,
 * both reduced to `normDupeKey`. "certain" is an exact key match,
 * "uncertain" is a token-subset relationship in either direction (see the
 * module doc for the worked example), "none" is neither.
 */
type MatchConfidence = "certain" | "uncertain" | "none";

function matchConfidence(
  desiredTitle: string,
  ownedTitle: string,
): MatchConfidence {
  const desiredKey = normDupeKey(desiredTitle);
  const ownedKey = normDupeKey(ownedTitle);
  if (desiredKey === ownedKey) return "certain";

  const desiredTokens = new Set(desiredKey.split(" ").filter(Boolean));
  const ownedTokens = new Set(ownedKey.split(" ").filter(Boolean));
  const isSubset = (a: Set<string>, b: Set<string>) =>
    a.size > 0 && [...a].every((t) => b.has(t));
  if (
    isSubset(ownedTokens, desiredTokens) || isSubset(desiredTokens, ownedTokens)
  ) {
    return "uncertain";
  }
  return "none";
}

/** An owned album paired with the confidence of its title match. */
interface OwnedMatch {
  album: OwnedAlbum;
  confidence: MatchConfidence;
}

/** Best owned-album match for a release-group, if any ("none" excluded). */
function findBestOwnedMatch(
  rg: DesiredReleaseGroup,
  candidates: OwnedAlbum[],
): OwnedMatch | null {
  let best: OwnedMatch | null = null;
  for (const album of candidates) {
    const confidence = matchConfidence(rg.title, album.title);
    if (confidence === "none") continue;
    if (best === null || confidence === "certain") {
      best = { album, confidence };
      if (confidence === "certain") break;
    }
  }
  return best;
}

/**
 * Decide the want for a release-group given its best owned match: "missing"
 * when nothing counts as present (no match, or an uncertain match with the
 * bias flipped off), an "upgrade" when the owned copy sits below the target
 * quality, or null for no want at all (already at/above target).
 */
function decideWant(
  match: OwnedMatch | null,
  targetRank: number,
  uncertainMatchPresent: boolean,
): { kind: WantKind; quality: QualityBucket | null } | null {
  if (match === null) return { kind: "missing", quality: null };
  if (match.confidence === "uncertain" && !uncertainMatchPresent) {
    return { kind: "missing", quality: null };
  }
  // Present: a certain match, or an uncertain one treated as present.
  const ownedRank = QUALITY_RANK.indexOf(match.album.qualityBucket);
  if (ownedRank >= targetRank) return null;
  return { kind: "upgrade", quality: match.album.qualityBucket };
}

/**
 * Derive the want-set: a pure diff of desired MusicBrainz discography
 * against the owned cube, filtered by type policy and future-release
 * exclusion, biased by the uncertain-match option. See the module doc for
 * the value-object contract and the uncertain-match default. NO I/O —
 * every input is already-fetched data, and `opts.now` is the only clock.
 */
export function deriveWanted(
  input: WantedInput,
  opts: WantedOpts,
): WantedResult {
  const targetQuality = opts.targetQuality ?? DEFAULT_TARGET_QUALITY;
  const typePolicy = opts.typePolicy ?? DEFAULT_TYPE_POLICY;
  const uncertainMatchPresent = opts.uncertainMatchPresent ??
    DEFAULT_UNCERTAIN_MATCH_PRESENT;
  const targetRank = QUALITY_RANK.indexOf(targetQuality);

  const wants: WantEntry[] = [];

  for (const { artistKey, artistName } of input.artists) {
    const releaseGroups = input.desired[artistKey] ?? [];
    const ownedForArtist = input.owned.filter((a) => a.artistKey === artistKey);

    for (const rg of releaseGroups) {
      if (!passesTypePolicy(rg, typePolicy)) continue;
      if (isFutureRelease(rg, opts.now)) continue;

      const match = findBestOwnedMatch(rg, ownedForArtist);
      const decision = decideWant(match, targetRank, uncertainMatchPresent);
      if (decision === null) continue;

      wants.push({
        artist: artistKey,
        artistName,
        releaseGroupId: rg.id,
        title: rg.title,
        kind: decision.kind,
        quality: decision.quality,
        targetQuality,
        primaryType: rg.primaryType,
        secondaryTypes: rg.secondaryTypes,
        firstReleaseDate: rg.firstReleaseDate,
      });
    }
  }

  return { wants };
}
