/**
 * Contract-fixture suite (second file — `fragrantica_test.ts` stays UNCHANGED
 * and keeps its own inline-HTML pins of the four exported pures). This file
 * pins the same four exported pures (`refFromPerfumeUrl`, `parseAccords`,
 * `parseNotes`, `preferLinkName`) against the committed synthetic HTML
 * corpus under `../../fixtures/` — loaded via `Deno.readTextFile` rather than
 * inline strings, so a change to the corpus's shape (not just the parser)
 * would also be visible in a diff. It also runs a mechanical secret/host
 * scan over the whole fixture corpus.
 *
 * fragrantica.ts is UNMODIFIED by this change — every test here PINS
 * already-shipped, current behavior. All fixtures are pure hand-authored
 * synthetic data — see fixtures/PROVENANCE.md. No network call is made.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DOMParser } from "npm:linkedom@0.16.11";
import {
  parseAccords,
  parseNotes,
  preferLinkName,
  refFromPerfumeUrl,
} from "./fragrantica.ts";

const FIXTURES_DIR = new URL("../../fixtures/", import.meta.url);
const BASE = "https://fragrantica.example";

async function readFixture(relPath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relPath, FIXTURES_DIR));
}

// deno-lint-ignore no-explicit-any
function doc(html: string): any {
  return new DOMParser().parseFromString(html, "text/html");
}

// ---------------------------------------------------------------------------
// perfume.html — accords, notes, perfumer links, also-like carousel
// ---------------------------------------------------------------------------

Deno.test("contract: perfume.html — parseAccords pins name+strength, dedup and background-less bar skipped", async () => {
  const d = doc(await readFixture("perfume.html"));
  assertEquals(parseAccords(d), [
    { name: "fresh spicy", strength: 100 },
    { name: "amber", strength: 71 },
    { name: "green", strength: 22 },
  ]);
});

Deno.test("contract: perfume.html — parseNotes pins top/middle/base from the #pyramid heading+container pairing", async () => {
  const d = doc(await readFixture("perfume.html"));
  const notes = parseNotes(d.querySelector("#pyramid"));
  assertEquals(notes, {
    top: ["Bergamot", "Pink Pepper"],
    middle: ["Rose"],
    base: ["Musk"],
    general: [],
  });
});

Deno.test("contract: perfume.html — also-like carousel anchors resolve via refFromPerfumeUrl + preferLinkName", async () => {
  const d = doc(await readFixture("perfume.html"));
  const anchors = [...d.querySelectorAll(".also-like-container a")];
  assertEquals(anchors.length, 2);

  const first = refFromPerfumeUrl(anchors[0].getAttribute("href") ?? "", BASE);
  assertEquals(first.name, "Nova Extreme");
  assertEquals(first.brand, "Fakebloom");
  assertEquals(first.id, 102);
  assertEquals(
    first.url,
    `${BASE}/perfume/Fakebloom/Nova-Extreme-102.html`,
  );
  assertEquals(
    first.thumbnail,
    "https://fimgs.net/mdimg/perfume-thumbs/375x500.102.jpg",
  );
  assertEquals(preferLinkName(anchors[0], first), "Nova Extreme");

  const second = refFromPerfumeUrl(
    anchors[1].getAttribute("href") ?? "",
    BASE,
  );
  assertEquals(second.name, "Second Bloom");
  assertEquals(second.brand, "Otherhouse");
  assertEquals(preferLinkName(anchors[1], second), "Second Bloom");
});

Deno.test("contract: perfume.html — perfumer links: the empty /noses/ href is excluded by the length filter callers apply", async () => {
  // fragrantica.ts's own `[...doc.querySelectorAll('a[href*="/noses/"]')].filter(a =>
  // (a.getAttribute('href') ?? '').length > '/noses/'.length)` guard is private
  // (inside parsePerfume); pinned here at the fixture level so a corpus change
  // that removes the empty-href card silently loses this regression guard.
  const d = doc(await readFixture("perfume.html"));
  const hrefs = [...d.querySelectorAll('a[href*="/noses/"]')].map((a) =>
    a.getAttribute("href")
  );
  assertEquals(hrefs, ["/noses/Jane-Testperfumer.html", "/noses/"]);
  const kept = hrefs.filter((h) => (h ?? "").length > "/noses/".length);
  assertEquals(kept, ["/noses/Jane-Testperfumer.html"]);
});

// ---------------------------------------------------------------------------
// designer-listing.html / note-listing.html — refFromPerfumeUrl over a grid
// ---------------------------------------------------------------------------

Deno.test("contract: designer-listing.html — every /perfume/ href resolves to a valid ref, dup href included twice (dedup is collectPerfumeRefs's job, not refFromPerfumeUrl's)", async () => {
  const d = doc(await readFixture("designer-listing.html"));
  const hrefs = [...d.querySelectorAll('a[href*="/perfume/"]')].map((a) =>
    a.getAttribute("href") ?? ""
  );
  assertEquals(hrefs, [
    "/perfume/Testhouse/Fakebloom-Nova-101.html",
    "/perfume/Testhouse/Nova-Extreme-102.html",
    "/perfume/Testhouse/Fakebloom-Nova-101.html",
  ]);
  const refs = hrefs.map((h) => refFromPerfumeUrl(h, BASE));
  assertEquals(refs[0].name, "Fakebloom Nova");
  assertEquals(refs[0].id, 101);
  assertEquals(refs[1].name, "Nova Extreme");
  assertEquals(refs[1].id, 102);
  assertEquals(
    refs[2],
    refs[0],
    "the duplicated href resolves to an identical ref",
  );
});

Deno.test("contract: note-listing.html — every /perfume/ href resolves to a valid ref", async () => {
  const d = doc(await readFixture("note-listing.html"));
  const hrefs = [...d.querySelectorAll('a[href*="/perfume/"]')].map((a) =>
    a.getAttribute("href") ?? ""
  );
  assertEquals(hrefs, [
    "/perfume/Testhouse/Fakebloom-Nova-101.html",
    "/perfume/Otherhouse/Second-Bloom-103.html",
  ]);
  const refs = hrefs.map((h) => refFromPerfumeUrl(h, BASE));
  assertEquals(refs.map((r) => r.name), ["Fakebloom Nova", "Second Bloom"]);
  assertEquals(refs.map((r) => r.id), [101, 103]);
});

// ---------------------------------------------------------------------------
// ddg-results.html — DuckDuckGo's a.result__a / uddg= redirect-param markup
// ---------------------------------------------------------------------------

Deno.test("contract: ddg-results.html — every result__a with a uddg= param decodes to an allowed fragrantica.example target", async () => {
  const d = doc(await readFixture("ddg-results.html"));
  const hrefs = [...d.querySelectorAll("a.result__a")].map((a) =>
    a.getAttribute("href") ?? ""
  );
  assertEquals(hrefs.length, 4);
  const decoded = hrefs.map((href) => {
    const m = href.match(/[?&]uddg=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : href;
  });
  assertEquals(decoded, [
    "https://fragrantica.example/perfume/Testhouse/Fakebloom-Nova-101.html",
    "https://fragrantica.example/notes/Fakewood-42.html",
    "https://fragrantica.example/designers/Testhouse.html",
    // the fourth entry carries no uddg= param — the raw href passes through
    "https://unrelated.example/some-blog-post",
  ]);
});

// ---------------------------------------------------------------------------
// malformed/bad-percent.html — refFromPerfumeUrl THROWS on malformed % escape
// ---------------------------------------------------------------------------

Deno.test("contract: malformed/bad-percent.html — refFromPerfumeUrl now falls back to the raw slug on a malformed percent-escape instead of throwing (exported-function pin, fixed)", async () => {
  const d = doc(await readFixture("malformed/bad-percent.html"));
  const href = d.querySelector('a[href*="/perfume/"]')?.getAttribute("href") ??
    "";
  assertEquals(href, "/perfume/Bad%zzBrand/Broken-Name-201.html");
  const ref = refFromPerfumeUrl(href, BASE);
  assertEquals(
    ref.brand,
    "Bad%zzBrand",
    "brand falls back to the raw, undecoded slug rather than throwing",
  );
  assertEquals(ref.name, "Broken Name");
  assertEquals(ref.id, 201);
});

// ---------------------------------------------------------------------------
// malformed/accord-over-100.html — parseAccords never clamps strength
// ---------------------------------------------------------------------------

Deno.test("contract: malformed/accord-over-100.html — parseAccords pins the UNCLAMPED strength (120, not capped at 100)", async () => {
  const d = doc(await readFixture("malformed/accord-over-100.html"));
  assertEquals(parseAccords(d), [{ name: "overdriven", strength: 120 }]);
});

// ---------------------------------------------------------------------------
// malformed/missing-pyramid.html — parseNotes on a null #pyramid
// ---------------------------------------------------------------------------

Deno.test("contract: malformed/missing-pyramid.html — no #pyramid element -> parseNotes(null) yields all-empty levels", async () => {
  const d = doc(await readFixture("malformed/missing-pyramid.html"));
  assertEquals(d.querySelector("#pyramid"), null);
  assertEquals(parseNotes(d.querySelector("#pyramid")), {
    top: [],
    middle: [],
    base: [],
    general: [],
  });
});

// ---------------------------------------------------------------------------
// Mechanical fixtures scan — host allowlist + secret-shape backstop
// ---------------------------------------------------------------------------

const SCANNED_FILES = [
  "perfume.html",
  "designer-listing.html",
  "note-listing.html",
  "ddg-results.html",
  "malformed/bad-percent.html",
  "malformed/non-html.txt",
  "malformed/missing-pyramid.html",
  "malformed/cloudflare-challenge.html",
  "malformed/accord-over-100.html",
];

const ALLOWED_HOSTS = new Set([
  "fragrantica.example",
  "duckduckgo.com",
  "unrelated.example",
]);

/** Extract every `scheme://host` or protocol-relative `//host` occurrence. */
function extractHosts(text: string): string[] {
  const hosts: string[] = [];
  const re = /(?:https?:)?\/\/([a-zA-Z0-9.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hosts.push(m[1].toLowerCase());
  }
  // Also decode any `uddg=` redirect-param payloads, which embed a
  // percent-encoded absolute URL whose host must independently be allowed.
  const uddgRe = /uddg=([^&"'\s]+)/g;
  while ((m = uddgRe.exec(text)) !== null) {
    try {
      const decoded = decodeURIComponent(m[1]);
      const hm = decoded.match(/^https?:\/\/([a-zA-Z0-9.-]+)/);
      if (hm) hosts.push(hm[1].toLowerCase());
    } catch {
      // malformed uddg payload — not this scan's concern
    }
  }
  return hosts;
}

Deno.test("fixtures-host-scan: every host literal across the corpus is fragrantica.example, duckduckgo.com, or unrelated.example", async () => {
  const violations: string[] = [];
  for (const file of SCANNED_FILES) {
    const text = await readFixture(file);
    for (const host of extractHosts(text)) {
      if (!ALLOWED_HOSTS.has(host)) {
        violations.push(`${file}: disallowed host "${host}"`);
      }
    }
  }
  assertEquals(
    violations,
    [],
    `non-allowlisted host(s) found in fixtures:\n${violations.join("\n")}`,
  );
});

Deno.test("fixtures-host-scan: sanity — the scanner actually detects an injected foreign host", () => {
  const poisoned = 'href="https://not-a-real-fragrantica-host.invalid/x"';
  const hosts = extractHosts(poisoned);
  assertEquals(hosts, ["not-a-real-fragrantica-host.invalid"]);
});

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "generic bearer token", re: /Bearer\s+[A-Za-z0-9._-]{16,}/ },
  { name: "private key header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Authorization header value", re: /Authorization\s*:/i },
  { name: "Cookie header value", re: /^Cookie\s*:/im },
  // Generic high-entropy blob: 32+ alnum/base64url chars with no separators.
  { name: "high-entropy token-shaped value", re: /\b[A-Za-z0-9+/_=-]{40,}\b/ },
];

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string (fragrantica has no credentials, so this is a pure hygiene backstop)", async () => {
  const violations: string[] = [];
  for (const file of SCANNED_FILES) {
    const text = await readFixture(file);
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) {
        violations.push(`${file}: matched ${name}`);
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected secret shape", () => {
  const violations: string[] = [];
  const poisoned = "token=" + "a".repeat(40);
  for (const { re } of SECRET_PATTERNS) {
    if (re.test(poisoned)) violations.push(poisoned);
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a 40-char blob",
  );
});
