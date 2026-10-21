/**
 * Property-based tests (fast-check) for @magistr/openssl's pure helpers.
 * Named invariants:
 *
 *  (a) parseTarget round-trips `host:port`, `[v6]:port` and bare hosts
 *      (default 443), and never accepts a host starting with '-' or a port
 *      outside 1..65535 — whatever the input.
 *  (b) sanEntry keeps explicit `TYPE:value` prefixes verbatim and classifies
 *      dotted quads as IP.
 *  (c) buildConfig never emits an unescaped `$` in a subject value, every
 *      value unescapes back to its input, and newlines always throw.
 *  (d) buildConfig numbers SANs 1..n per type, in input order, one line each.
 *  (e) splitPemCertificates returns exactly the certificate blocks embedded
 *      in arbitrary surrounding noise, in order.
 *  (f) parseX509's daysLeft/expired agree with notAfter and `now`, and
 *      selfSigned is exactly subject === issuer.
 */
import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildConfig,
  parseTarget,
  parseX509,
  sanEntry,
  splitPemCertificates,
} from "./openssl.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? 200);

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const hostArb = fc.array(label, { minLength: 1, maxLength: 4 }).map((l) =>
  l.join(".")
);
const portArb = fc.integer({ min: 1, max: 65535 });

Deno.test("(a) parseTarget round-trips host:port", () => {
  fc.assert(
    fc.property(hostArb, portArb, (host, port) => {
      assertEquals(parseTarget(`${host}:${port}`), { host, port });
      assertEquals(parseTarget(host), { host, port: 443 });
    }),
    { numRuns },
  );
});

Deno.test("(a) parseTarget round-trips [v6]:port", () => {
  fc.assert(
    fc.property(fc.ipV6(), portArb, (ip, port) => {
      assertEquals(parseTarget(`[${ip}]:${port}`), { host: ip, port });
    }),
    { numRuns },
  );
});

Deno.test("(a) parseTarget never yields an option-like host or bad port", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.string().map((s) => `-${s}`),
        fc.tuple(hostArb, fc.integer({ min: 0, max: 10_000_000 })).map((
          [h, p],
        ) => `${h}:${p}`),
        fc.tuple(fc.ipV6(), fc.integer({ min: 0, max: 10_000_000 })).map((
          [h, p],
        ) => `[${h}]:${p}`),
      ),
      (target) => {
        let r: { host: string; port: number };
        try {
          r = parseTarget(target);
        } catch {
          return;
        }
        assert(!r.host.startsWith("-"), target);
        assert(r.host.length > 0, target);
        assert(r.port >= 1 && r.port <= 65535, target);
        assert(!/[\s;$`'"=]/.test(r.host), target);
      },
    ),
    { numRuns },
  );
});

Deno.test("(b) sanEntry keeps explicit prefixes and classifies IPv4", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("DNS", "IP", "email", "URI"),
      fc.stringMatching(/^[A-Za-z0-9.@:/-]{1,30}$/),
      (type, value) => {
        assertEquals(sanEntry(`${type}:${value}`), { type, value });
      },
    ),
    { numRuns },
  );
  fc.assert(
    fc.property(fc.ipV4(), (ip) => {
      assertEquals(sanEntry(ip), { type: "IP", value: ip });
    }),
    { numRuns },
  );
});

/** Undo cfgValue's escaping, failing on any bare `$`. */
function unescapeStrict(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\") {
      out += v[i + 1] ?? "";
      i++;
    } else {
      assert(v[i] !== "$", `unescaped $ in ${JSON.stringify(v)}`);
      out += v[i];
    }
  }
  return out;
}

const noNewline = fc.string({ minLength: 1, maxLength: 40 }).filter((s) =>
  !/[\r\n]/.test(s)
);

Deno.test("(c) buildConfig escapes every subject value", () => {
  fc.assert(
    fc.property(
      noNewline,
      fc.option(noNewline, { nil: undefined }),
      fc.boolean(),
      (CN, O, ca) => {
        const cfg = buildConfig({
          subject: { CN, O },
          sans: [],
          ca,
          target: ca ? "x509" : "csr",
        });
        const dn = cfg.split("[dn]\n")[1].split("\n\n")[0].split("\n");
        const got: Record<string, string> = {};
        for (const line of dn) {
          const i = line.indexOf(" = ");
          got[line.slice(0, i)] = unescapeStrict(line.slice(i + 3));
        }
        assertEquals(got.CN, CN);
        assertEquals(got.O, O);
      },
    ),
    { numRuns },
  );
});

Deno.test("(c) buildConfig rejects newlines anywhere in a value", () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.constantFrom("\n", "\r"),
      fc.string(),
      (a, nl, b) => {
        assertThrows(() =>
          buildConfig({
            subject: { CN: `${a}${nl}${b}` },
            sans: [],
            ca: false,
            target: "csr",
          })
        );
      },
    ),
    { numRuns },
  );
});

const sanArb = fc.oneof(
  hostArb,
  fc.ipV4(),
  hostArb.map((h) => `admin@${h}`),
  hostArb.map((h) => `https://${h}`),
);

Deno.test("(d) buildConfig numbers SANs 1..n per type in order", () => {
  fc.assert(
    fc.property(fc.array(sanArb, { maxLength: 20 }), (sans) => {
      const cfg = buildConfig({ sans, ca: false, target: "x509" });
      if (!sans.length) {
        assert(!cfg.includes("subjectAltName"));
        return;
      }
      const alt = cfg.split("[alt]\n")[1].trim().split("\n");
      assertEquals(alt.length, sans.length);
      const seen: Record<string, number> = {};
      alt.forEach((line, i) => {
        const m = line.match(/^(DNS|IP|email|URI)\.(\d+) = (.*)$/)!;
        assert(m, line);
        seen[m[1]] = (seen[m[1]] ?? 0) + 1;
        assertEquals(Number(m[2]), seen[m[1]]);
        assertEquals({ type: m[1], value: m[3] }, sanEntry(sans[i]));
      });
    }),
    { numRuns },
  );
});

const b64 = fc.stringMatching(/^[A-Za-z0-9+/=]{1,64}$/);
const noise = fc.string({ maxLength: 30 }).filter((s) => !s.includes("-----"));

Deno.test("(e) splitPemCertificates finds exactly the embedded blocks", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(noise, b64), { maxLength: 6 }),
      noise,
      (parts, tail) => {
        const blocks = parts.map(([, body]) =>
          `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`
        );
        const text = parts.map(([n], i) => `${n}\n${blocks[i]}\n`).join("") +
          tail;
        assertEquals(splitPemCertificates(text), blocks);
      },
    ),
    { numRuns },
  );
});

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Format like openssl: `Jan  5 01:02:03 2030 GMT`. */
function opensslDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${
    String(d.getUTCDate()).padStart(2, " ")
  } ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${
    p(d.getUTCSeconds())
  } ${d.getUTCFullYear()} GMT`;
}

const secondsDate = fc.integer({
  min: Date.UTC(1990, 0, 1) / 1000,
  max: Date.UTC(2099, 11, 31) / 1000,
}).map((s) => new Date(s * 1000));

Deno.test("(f) parseX509 expiry fields agree with notAfter and now", () => {
  fc.assert(
    fc.property(
      secondsDate,
      secondsDate,
      fc.constantFrom("CN=a", "CN=b"),
      fc.constantFrom("CN=a", "CN=b"),
      (notAfter, now, subject, issuer) => {
        const out = [
          `subject=${subject}`,
          `issuer=${issuer}`,
          "notBefore=Jan  1 00:00:00 1990 GMT",
          `notAfter=${opensslDate(notAfter)}`,
        ].join("\n");
        const c = parseX509(out, now);
        assertEquals(c.notAfter, notAfter.toISOString());
        assertEquals(
          c.daysLeft,
          Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000),
        );
        assertEquals(c.expired, notAfter.getTime() < now.getTime());
        assertEquals(c.selfSigned, subject === issuer);
      },
    ),
    { numRuns },
  );
});
