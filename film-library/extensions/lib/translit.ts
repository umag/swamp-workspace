// Latin → Cyrillic back-transliteration for Russian titles that were
// romanised in file names ("Gadkiy.ya.2" → "Гадкий я 2"). Lossy by nature —
// it only has to produce a reading close enough for Jev to recognise and
// TMDB's search to find. Pure functions only.

const MULTI: [RegExp, string][] = [
  [/shch|sch/g, "щ"],
  [/nj/g, "нь"],
  [/lj/g, "ль"],
  [/zh/g, "ж"],
  [/kh/g, "х"],
  [/ts/g, "ц"],
  [/ch/g, "ч"],
  [/sh/g, "ш"],
  [/ya|ja/g, "я"],
  [/yu|ju/g, "ю"],
  [/yo|jo/g, "ё"],
  [/ye|je/g, "е"],
  [/(?<=[aeiou])[iy](?=$|[^a-z])/g, "й"],
  [/iy|ij/g, "ий"],
  [/yy|yi|yj/g, "ый"],
  [/j/g, "й"],
];

const SINGLE: Record<string, string> = {
  a: "а",
  b: "б",
  v: "в",
  w: "в",
  g: "г",
  d: "д",
  e: "е",
  z: "з",
  i: "и",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  f: "ф",
  h: "х",
  c: "ц",
  x: "кс",
  y: "ы",
  q: "к",
  "'": "ь",
};

const ENGLISH = new Set([
  "the",
  "of",
  "and",
  "a",
  "an",
  "in",
  "to",
  "with",
  "is",
  "for",
  "on",
  "at",
  "my",
  "me",
  "you",
  "man",
  "love",
  "day",
  "night",
  "world",
  "life",
  "story",
  "movie",
  "part",
  "war",
  "king",
  "last",
  "first",
  "new",
  "black",
  "dark",
]);

/** True for an all-Latin title that reads like romanised Russian: no common
 * English word, at least one transliteration digraph or Russian ending. */
export function looksTranslit(title: string): boolean {
  if (!/\p{Script=Latin}/u.test(title) || /\p{Script=Cyrillic}/u.test(title)) {
    return false;
  }
  const words = title.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  if (words.length === 0 || words.some((w) => ENGLISH.has(w))) return false;
  return words.some((w) =>
    /zh|kh|shch|ch|sh|ts|iy|yy|yi|ya|yu|yo|ja|ju|jo/.test(w) ||
    /(ogo|aya|oy|ov|ev|iy|yh|ih|nyi|skiy|skij|ah|ami|yu|om)$/.test(w) ||
    /^(v|s|k|na|po|za|ot|iz|do|bez|pro)$/.test(w)
  ) || words.filter((w) => /[^aeiou][ieo]$/.test(w)).length >= 2;
}

/** Transliterate one Latin title to Cyrillic, preserving digits/spacing and
 * capitalising the first letter. */
export function toCyrillic(title: string): string {
  let s = title.toLowerCase();
  for (const [re, v] of MULTI) s = s.replace(re, v);
  s = [...s].map((ch) => SINGLE[ch] ?? ch).join("");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
