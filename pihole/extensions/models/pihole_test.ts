// Fixture-backed contract enrichment for @magistr/pihole — consumes
// SYNTHETIC, hand-authored wire-shape fixtures under pihole/fixtures/ (no
// real host, no real credentials, RFC-5737 documentation IPs only). These
// are a stand-in for a real sanitized capture via the ext-canary-fixtures
// workflow, which must run on the WG-connected box against
// aopab-local-dns — NOT from this machine (see pihole/fixtures/README.md).
//
// Every test here SKIPS CLEANLY if pihole/fixtures/ is absent, so a
// checkout without the fixtures directory never fails CI. The directory IS
// committed in this change; the guard is defensive against future drift
// (a lean checkout, a partial sparse-checkout, etc).
//
// contract-fixture is already `present` via pihole_dns_test.ts independent
// of this file — this suite strengthens, not gates, that suite's presence.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseHostsEntries } from "./lib/dns.ts";

const FIXTURES_DIR = new URL("../../fixtures/", import.meta.url);

async function fixturesAvailable(): Promise<boolean> {
  try {
    const stat = await Deno.stat(FIXTURES_DIR);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

const HAVE_FIXTURES = await fixturesAvailable();

async function readFixtureText(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIXTURES_DIR));
}

async function readFixtureJson(name: string): Promise<unknown> {
  return JSON.parse(await readFixtureText(name));
}

Deno.test({
  name:
    "fixture contract: list-response.json matches the FTL /api/config/dns/hosts wire shape parseHostsEntries expects",
  ignore: !HAVE_FIXTURES,
  fn: async () => {
    const data = await readFixtureJson("list-response.json") as {
      config?: { dns?: { hosts?: string[] } };
    };
    const hosts = data.config?.dns?.hosts;
    assert(Array.isArray(hosts), "fixture must carry config.dns.hosts[]");
    const records = parseHostsEntries(hosts!);
    assert(records.length > 0, "fixture must decode to at least one record");
    for (const r of records) {
      assert(r.ip.length > 0 && r.hostname.length > 0);
    }
    assertEquals(records[0], {
      ip: "192.0.2.10",
      hostname: "nas.example.test",
    });
  },
});

Deno.test({
  name:
    "fixture safety: list-response.json contains no real internal topology (no 192.168.x, no *.aopab.art)",
  ignore: !HAVE_FIXTURES,
  fn: async () => {
    const text = await readFixtureText("list-response.json");
    assertEquals(
      /192\.168\.\d{1,3}\.\d{1,3}/.test(text),
      false,
      "no real LAN IP",
    );
    assertEquals(/aopab\.art/i.test(text), false, "no real internal hostname");
  },
});

Deno.test({
  name:
    "fixture contract: auth-response.json matches the session.{valid,sid,csrf} shape the client reads",
  ignore: !HAVE_FIXTURES,
  fn: async () => {
    const data = await readFixtureJson("auth-response.json") as {
      session?: { valid?: boolean; sid?: string; csrf?: string };
    };
    assertEquals(data.session?.valid, true);
    assert(
      typeof data.session?.sid === "string" && data.session.sid.length > 0,
    );
    assert(
      typeof data.session?.csrf === "string" && data.session.csrf.length > 0,
    );
  },
});

Deno.test({
  name:
    "fixture safety: auth-response.json carries an obviously-fake sid/csrf, never a real captured session",
  ignore: !HAVE_FIXTURES,
  fn: async () => {
    const data = await readFixtureJson("auth-response.json") as {
      session?: { sid?: string; csrf?: string };
    };
    const sid = data.session?.sid ?? "";
    const csrf = data.session?.csrf ?? "";
    assert(
      /FAKE|SYNTHETIC/i.test(sid),
      "sid must be an obviously-fake placeholder",
    );
    assert(
      /FAKE|SYNTHETIC/i.test(csrf),
      "csrf must be an obviously-fake placeholder",
    );
  },
});
