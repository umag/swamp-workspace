/**
 * Property-based tests (fast-check) for @magistr/mitmproxy's pure helpers.
 * Named invariants:
 *
 *  (a) startArgs: every user option becomes exactly one `--set key=value`
 *      argv pair, listen/mode flags appear once, the capture is always
 *      appended (`+<flowsFile>`), and web options appear iff ui=web.
 *  (b) resolvePaths: every file lives directly in stateDir, which defaults
 *      to <confdir>/swamp; the CA cert lives in confdir.
 *  (c) summarizeHar: total counts every entry, flows is the newest
 *      min(limit, total) entries in order, timeMs is a rounded integer, and
 *      headers appear iff requested, with lower-cased keys.
 *  (d) webUrlFromLog: returns the LAST tokenised URL in the log, or null
 *      when no line carries one.
 */
import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  model,
  resolvePaths,
  startArgs,
  summarizeHar,
  webUrlFromLog,
} from "./mitmproxy.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? 200);
const G = model.globalArguments;

const dirArb = fc.stringMatching(/^\/[a-z0-9_/-]{0,30}[a-z0-9]$/);
const optionsArb = fc.dictionary(
  fc.stringMatching(/^[a-z_]{1,16}$/),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { maxKeys: 6 },
);

Deno.test("(a) startArgs maps options and flags faithfully", () => {
  fc.assert(
    fc.property(
      dirArb,
      fc.integer({ min: 1, max: 65535 }),
      fc.constantFrom("regular", "socks5", "upstream:http://u:3128"),
      fc.constantFrom("dump", "web"),
      optionsArb,
      (confdir, port, mode, ui, options) => {
        const g = G.parse({ confdir, listenPort: port, mode, ui, options });
        const paths = resolvePaths(g);
        const a = startArgs(g, paths);
        const count = (x: string) => a.filter((y) => y === x).length;
        assertEquals(count("--listen-port"), 1);
        assertEquals(a[a.indexOf("--listen-port") + 1], String(port));
        assertEquals(a[a.indexOf("--mode") + 1], mode);
        assertEquals(count(`+${paths.flowsFile}`), 1);
        for (const [k, v] of Object.entries(options)) {
          const i = a.indexOf(`${k}=${v}`);
          assert(i > 0, `${k} missing`);
          assertEquals(a[i - 1], "--set");
        }
        assertEquals(
          a.some((x) => x.startsWith("web_port=")),
          ui === "web",
        );
        // Every --set is followed by exactly one key=value element.
        a.forEach((x, i) => {
          if (x === "--set") assert(/^[a-z_]+=/.test(a[i + 1]));
        });
      },
    ),
    { numRuns },
  );
});

Deno.test("(b) resolvePaths keeps state files inside stateDir", () => {
  fc.assert(
    fc.property(dirArb, fc.option(dirArb, { nil: undefined }), (c, s) => {
      const p = resolvePaths(G.parse({ confdir: c, stateDir: s }));
      assertEquals(p.stateDir, s ?? `${c}/swamp`);
      for (const f of [p.pidFile, p.logFile, p.flowsFile]) {
        assertEquals(f.slice(0, f.lastIndexOf("/")), p.stateDir);
      }
      assertEquals(p.caCert, `${c}/mitmproxy-ca-cert.pem`);
    }),
    { numRuns },
  );
});

const headerArb = fc.record({
  name: fc.stringMatching(/^[A-Za-z-]{1,12}$/),
  value: fc.string({ maxLength: 20 }),
});

const entryArb = fc.record({
  startedDateTime: fc.constant("2026-10-21T00:00:00Z"),
  time: fc.double({ min: 0, max: 1e6, noNaN: true }),
  request: fc.record({
    method: fc.constantFrom("GET", "POST", "PUT"),
    url: fc.webUrl(),
    headers: fc.array(headerArb, { maxLength: 4 }),
  }),
  response: fc.record({
    status: fc.integer({ min: 100, max: 599 }),
    headers: fc.array(headerArb, { maxLength: 4 }),
    content: fc.record({
      size: fc.nat(),
      mimeType: fc.constantFrom("text/html", "application/json", ""),
    }),
  }),
});

Deno.test("(c) summarizeHar keeps the newest entries, faithfully", () => {
  fc.assert(
    fc.property(
      fc.array(entryArb, { maxLength: 30 }),
      fc.integer({ min: 1, max: 40 }),
      fc.boolean(),
      (entries, limit, withHeaders) => {
        const s = summarizeHar({ log: { entries } }, limit, withHeaders);
        assertEquals(s.total, entries.length);
        const kept = entries.slice(-limit);
        assertEquals(s.flows.length, Math.min(limit, entries.length));
        s.flows.forEach((f, i) => {
          assertEquals(f.url, kept[i].request.url);
          assertEquals(f.status, kept[i].response.status);
          assertEquals(f.timeMs, Math.round(kept[i].time));
          assert(Number.isInteger(f.timeMs));
          assertEquals("requestHeaders" in f, withHeaders);
          if (withHeaders) {
            for (const k of Object.keys(f.requestHeaders!)) {
              assertEquals(k, k.toLowerCase());
            }
          }
        });
      },
    ),
    { numRuns },
  );
});

Deno.test("(d) webUrlFromLog returns the last tokenised URL", () => {
  const tokenLine = fc.stringMatching(/^[a-z0-9]{1,12}$/).map((t) =>
    `Web server listening at http://127.0.0.1:8081/?token=${t}`
  );
  const noise = fc.string({ maxLength: 40 }).filter((s) =>
    !s.includes("?token=")
  );
  fc.assert(
    fc.property(
      fc.array(fc.oneof(tokenLine, noise), { maxLength: 15 }),
      (lines) => {
        const withToken = lines.filter((l) => l.includes("?token="));
        const got = webUrlFromLog(lines);
        if (!withToken.length) {
          assertEquals(got, null);
        } else {
          const last = withToken.at(-1)!;
          assertEquals(got, last.slice(last.indexOf("http")));
        }
      },
    ),
    { numRuns },
  );
});
