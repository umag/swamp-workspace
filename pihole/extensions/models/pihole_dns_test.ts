// Unit tests for lib/dns.ts — the pure domain logic of @magistr/pihole.
// Run: deno test extensions/models/pihole_dns_test.ts
//
// These import the REAL implementation, so a behaviour change breaks them.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  diffRecords,
  type DnsRecord,
  encodeEntry,
  normalizeBaseUrl,
  parseHostsEntries,
  redactSecrets,
} from "./lib/dns.ts";

// ---------------------------------------------------------------------------
// normalizeBaseUrl
// ---------------------------------------------------------------------------

Deno.test("normalizeBaseUrl: bare host + http reproduces the legacy base exactly", () => {
  // Back-compat guard: the existing instance has only host/password and the
  // old code did `http://${host}` — this must be byte-identical.
  assertEquals(normalizeBaseUrl("192.168.88.53", "http"), "http://192.168.88.53");
});

Deno.test("normalizeBaseUrl: bare host + https", () => {
  assertEquals(normalizeBaseUrl("pihole.lan", "https"), "https://pihole.lan");
});

Deno.test("normalizeBaseUrl: host already carrying a scheme is passed through", () => {
  assertEquals(normalizeBaseUrl("https://pi.lan", "http"), "https://pi.lan");
  assertEquals(normalizeBaseUrl("http://pi.lan", "https"), "http://pi.lan");
});

Deno.test("normalizeBaseUrl: host with port is preserved", () => {
  assertEquals(normalizeBaseUrl("pi.lan:8080", "http"), "http://pi.lan:8080");
  assertEquals(
    normalizeBaseUrl("https://pi.lan:8443", "http"),
    "https://pi.lan:8443",
  );
});

Deno.test("normalizeBaseUrl: trailing slash is stripped", () => {
  assertEquals(normalizeBaseUrl("pi.lan/", "http"), "http://pi.lan");
  assertEquals(normalizeBaseUrl("http://pi.lan/", "http"), "http://pi.lan");
});

Deno.test("normalizeBaseUrl: scheme + port + trailing slash together", () => {
  assertEquals(
    normalizeBaseUrl("https://pi.lan:8443/", "http"),
    "https://pi.lan:8443",
  );
});

// ---------------------------------------------------------------------------
// parseHostsEntries
// ---------------------------------------------------------------------------

Deno.test("parseHostsEntries: splits 'ip hostname' pairs", () => {
  assertEquals(
    parseHostsEntries(["10.0.0.1 router.lan", "10.0.0.2 nas.lan"]),
    [
      { ip: "10.0.0.1", hostname: "router.lan" },
      { ip: "10.0.0.2", hostname: "nas.lan" },
    ],
  );
});

Deno.test("parseHostsEntries: collapses extra whitespace and keeps multi-word hostname tail", () => {
  assertEquals(
    parseHostsEntries(["10.0.0.1    a.lan", "10.0.0.2 b.lan c.lan"]),
    [
      { ip: "10.0.0.1", hostname: "a.lan" },
      { ip: "10.0.0.2", hostname: "b.lan c.lan" },
    ],
  );
});

Deno.test("parseHostsEntries: empty input returns empty array", () => {
  assertEquals(parseHostsEntries([]), []);
});

// ---------------------------------------------------------------------------
// encodeEntry
// ---------------------------------------------------------------------------

Deno.test("encodeEntry: percent-encodes the space between ip and hostname", () => {
  assertEquals(encodeEntry("10.0.0.1", "router.lan"), "10.0.0.1%20router.lan");
});

Deno.test("encodeEntry: percent-encodes reserved characters (not just spaces)", () => {
  // A space-only replacer would leave '/' '?' raw and break the API path.
  const out = encodeEntry("10.0.0.1", "a/b?c");
  assertStringIncludes(out, "%2F");
  assertStringIncludes(out, "%3F");
  assertEquals(out.includes("/"), false);
  assertEquals(out.includes("?"), false);
});

// ---------------------------------------------------------------------------
// diffRecords
// ---------------------------------------------------------------------------

const A: DnsRecord = { ip: "10.0.0.1", hostname: "a.lan" };
const B: DnsRecord = { ip: "10.0.0.2", hostname: "b.lan" };
const C: DnsRecord = { ip: "10.0.0.3", hostname: "c.lan" };

Deno.test("diffRecords: add-only when nothing exists", () => {
  const d = diffRecords([], [A, B]);
  assertEquals(d.added, [A, B]);
  assertEquals(d.deleted, []);
  assertEquals(d.unchanged, []);
});

Deno.test("diffRecords: unchanged detected on ip AND hostname equality", () => {
  const d = diffRecords([A, B], [A, B]);
  assertEquals(d.added, []);
  assertEquals(d.deleted, []);
  assertEquals(d.unchanged, [A, B]);
});

Deno.test("diffRecords: deleteExtras=false keeps unknown existing records", () => {
  const d = diffRecords([A, C], [A, B], { deleteExtras: false });
  assertEquals(d.added, [B]);
  assertEquals(d.deleted, []);
  assertEquals(d.unchanged, [A]);
});

Deno.test("diffRecords: deleteExtras=true removes unknown existing records", () => {
  const d = diffRecords([A, C], [A, B], { deleteExtras: true });
  assertEquals(d.added, [B]);
  assertEquals(d.deleted, [C]);
  assertEquals(d.unchanged, [A]);
});

Deno.test("diffRecords: an IP change for the same hostname is one delete + one add", () => {
  const oldA: DnsRecord = { ip: "10.0.0.1", hostname: "a.lan" };
  const newA: DnsRecord = { ip: "10.0.0.9", hostname: "a.lan" };
  const d = diffRecords([oldA], [newA], { deleteExtras: true });
  assertEquals(d.added, [newA]);
  assertEquals(d.deleted, [oldA]);
  assertEquals(d.unchanged, []);
});

Deno.test("diffRecords: a hostname change for the same IP is one delete + one add (equality needs BOTH)", () => {
  const oldA: DnsRecord = { ip: "10.0.0.1", hostname: "a.lan" };
  const newA: DnsRecord = { ip: "10.0.0.1", hostname: "z.lan" };
  const d = diffRecords([oldA], [newA], { deleteExtras: true });
  assertEquals(d.added, [newA]);
  assertEquals(d.deleted, [oldA]);
  assertEquals(d.unchanged, []);
});

Deno.test("diffRecords: default (opts omitted) is non-destructive — keeps unknown records", () => {
  const d = diffRecords([A, C], [A, B]);
  assertEquals(d.added, [B]);
  assertEquals(d.deleted, []);
  assertEquals(d.unchanged, [A]);
});

Deno.test("diffRecords: empty desired with deleteExtras=true deletes everything", () => {
  const d = diffRecords([A, B], [], { deleteExtras: true });
  assertEquals(d.added, []);
  assertEquals(d.deleted, [A, B]);
  assertEquals(d.unchanged, []);
});

Deno.test("diffRecords: empty desired with deleteExtras=false deletes nothing", () => {
  const d = diffRecords([A, B], [], { deleteExtras: false });
  assertEquals(d.added, []);
  assertEquals(d.deleted, []);
  assertEquals(d.unchanged, []);
});

Deno.test("diffRecords: added preserves desired input order", () => {
  const d = diffRecords([], [C, A, B]);
  assertEquals(d.added, [C, A, B]);
});

Deno.test("diffRecords: duplicate desired entries do not double-add", () => {
  const d = diffRecords([], [A, A]);
  assertEquals(d.added, [A]);
  assertEquals(d.deleted, []);
  assertEquals(d.unchanged, []);
});

Deno.test("diffRecords: a desired duplicate of an existing record stays unchanged, not added", () => {
  const d = diffRecords([A], [A, A]);
  assertEquals(d.added, []);
  assertEquals(d.unchanged, [A]);
  assertEquals(d.deleted, []);
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

Deno.test("redactSecrets: masks an opaque secret value reflected in a Cookie header", () => {
  const sid = "abc123def456ghi";
  const out = redactSecrets(`Cookie: sid=${sid}; path=/`, [sid]);
  assertEquals(out.includes(sid), false);
});

Deno.test("redactSecrets: masks a secret value reflected in a URL", () => {
  const csrf = "csrftoken9988776655";
  const out = redactSecrets(`https://pi.lan/api?csrf=${csrf}`, [csrf]);
  assertEquals(out.includes(csrf), false);
});

Deno.test("redactSecrets: masks a bare reflected secret value", () => {
  const pw = "sup3rs3cretpass";
  const out = redactSecrets(`login failed for ${pw} oops`, [pw]);
  assertEquals(out.includes(pw), false);
});

Deno.test("redactSecrets: masks the field-name JSON shape regardless of value", () => {
  const out = redactSecrets(`{"sid":"xyz","csrf":"qrs"}`, []);
  assertEquals(out.includes("xyz"), false);
  assertEquals(out.includes("qrs"), false);
});

Deno.test("redactSecrets: masks ALL occurrences of a secret (global, not first-only)", () => {
  const sid = "abc123def456ghi";
  const out = redactSecrets(`sid=${sid}; later resent sid=${sid} again`, [sid]);
  assertEquals(out.includes(sid), false);
});

Deno.test("redactSecrets: masks every secret when multiple are passed", () => {
  const sid = "sidtoken11223344";
  const csrf = "csrftoken55667788";
  const out = redactSecrets(`sid=${sid} csrf=${csrf}`, [sid, csrf]);
  assertEquals(out.includes(sid), false);
  assertEquals(out.includes(csrf), false);
});

Deno.test("redactSecrets: masks a secret value containing regex metacharacters", () => {
  const pw = "a+b.c$d(ee)ff*g";
  const out = redactSecrets(`auth failed: ${pw} rejected`, [pw]);
  assertEquals(out.includes(pw), false);
});

Deno.test("redactSecrets: fully masks overlapping secrets (one a substring of another)", () => {
  const long = "longsecretvalue123";
  const short = "longsecret";
  const out = redactSecrets(`token=${long}`, [long, short]);
  assertEquals(out.includes(long), false);
  // no recoverable fragment of the longer secret survives
  assertEquals(out.includes("value123"), false);
});

Deno.test("redactSecrets: value-replaces a secret AT/above the length threshold (>=8)", () => {
  const tok = "tok45678"; // exactly 8 chars
  const out = redactSecrets(`x ${tok} y`, [tok]);
  assertEquals(out.includes(tok), false);
});

Deno.test("redactSecrets: a SHORT secret below threshold is NOT value-replaced (no corruption)", () => {
  // 2-char and 7-char secrets must NOT be value-replaced, or they would mangle
  // unrelated hostnames/IPs/tokens. Field-name regexes still cover the structured case.
  const out2 = redactSecrets("host pi-hole.lan at 10.0.0.1 ok", ["pi"]);
  assertStringIncludes(out2, "pi-hole.lan");
  assertStringIncludes(out2, "10.0.0.1");
  const out7 = redactSecrets("value 12345678 stays", ["1234567"]);
  assertStringIncludes(out7, "12345678");
});

Deno.test("redactSecrets: short secret in a field-name position is still masked (defense-in-depth)", () => {
  // "pi" is below the value-replace threshold, so only the field-name regex
  // can catch it in a structured position.
  const out = redactSecrets(`{"sid":"pi"}`, ["pi"]);
  assertEquals(out.includes(`"pi"`), false);
});

Deno.test("redactSecrets: tolerates empty/undefined entries without corrupting output", () => {
  const text = "plain text 10.0.0.1";
  const out = redactSecrets(text, ["", undefined]);
  assertEquals(out, text);
});

Deno.test("redactSecrets: input below the cap is returned untruncated", () => {
  const text = "a normal-length redacted log line";
  assertEquals(redactSecrets(text, []), text);
});

Deno.test("redactSecrets: redacts BEFORE truncating (secret near the cap is gone)", () => {
  const secret = "deepsecrettoken9999";
  const text = "y".repeat(2500) + secret + "z".repeat(2500);
  const out = redactSecrets(text, [secret]);
  assertEquals(out.includes(secret), false);
});

Deno.test("redactSecrets: truncates very long input to the fixed cap (2048)", () => {
  const out = redactSecrets("x".repeat(10_000), []);
  assertEquals(out.length, 2048);
});
