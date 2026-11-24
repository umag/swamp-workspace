/**
 * Property-based tests (fast-check) for @magistr/terminal-browser's pure
 * helpers. Run count comes from FC_NUM_RUNS (small in CI, large in soak).
 *
 *  (a) normalizeUrl is idempotent over hosts, ports, localhost and paths.
 *  (b) truncateBytes stays within the byte budget and returns a prefix.
 *  (c) assertPositional accepts exactly the non-empty values without a
 *      leading "-" and without NUL / CR / LF.
 *  (d) findTab finds a tab whatever normalisation-equivalent spelling of
 *      its url is asked for.
 *  (e) parseLs round-trips any well-formed browser list.
 */
import fc from "npm:fast-check@3.23.2";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertPositional,
  findTab,
  normalizeUrl,
  parseLs,
  truncateBytes,
} from "./terminal_browser.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? 200);

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const hostArb = fc.array(label, { minLength: 1, maxLength: 4 })
  .map((l) => l.join(".") + ".test");
const portArb = fc.integer({ min: 1, max: 65535 });
const pathArb = fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/), {
  maxLength: 3,
}).map((p) => p.length ? "/" + p.join("/") : "");

const urlInput = fc.oneof(
  fc.tuple(hostArb, pathArb).map(([h, p]) => h + p),
  fc.tuple(hostArb, pathArb).map(([h, p]) => `https://${h}${p}`),
  fc.tuple(hostArb, pathArb).map(([h, p]) => `http://${h.toUpperCase()}${p}`),
  portArb.map(String),
  portArb.map((p) => `:${p}`),
  fc.tuple(portArb, pathArb).map(([p, x]) => `localhost:${p}${x}`),
  fc.tuple(portArb, pathArb).map(([p, x]) => `127.0.0.1:${p}${x}`),
  pathArb.map((p) => `.${p || "/a"}.html`),
  pathArb.map((p) => `~${p || "/a"}.md`),
  fc.webUrl(),
);

Deno.test("(a) normalizeUrl is idempotent", () => {
  fc.assert(
    fc.property(urlInput, (u) => {
      const once = normalizeUrl(u);
      assertEquals(normalizeUrl(once), once);
    }),
    { numRuns },
  );
});

Deno.test("(b) truncateBytes respects the budget and returns a prefix", () => {
  fc.assert(
    fc.property(
      fc.fullUnicodeString({ maxLength: 200 }),
      fc.integer({ min: 0, max: 400 }),
      (text, max) => {
        const r = truncateBytes(text, max);
        const n = new TextEncoder().encode(r.text).length;
        assert(n <= Math.max(max, 0) || !r.truncated);
        assert(text.startsWith(r.text));
        assertEquals(r.truncated, new TextEncoder().encode(text).length > max);
        if (!r.truncated) assertEquals(r.text, text);
      },
    ),
    { numRuns },
  );
});

Deno.test("(c) assertPositional accepts iff safe", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }).map((s) => "-" + s),
        fc.tuple(fc.string(), fc.constantFrom("\0", "\r", "\n"), fc.string())
          .map(([a, b, c]) => a + b + c),
      ),
      (v) => {
        const safe = v.length > 0 && !v.startsWith("-") &&
          !/[\0\r\n]/.test(v);
        if (safe) assertEquals(assertPositional("v", v), v);
        else assertThrows(() => assertPositional("v", v));
      },
    ),
    { numRuns },
  );
});

Deno.test("(d) findTab matches any equivalent spelling", () => {
  fc.assert(
    fc.property(
      hostArb,
      pathArb,
      fc.constantFrom(
        (h: string, p: string) => h + p,
        (h: string, p: string) => `https://${h}${p}`,
        (h: string, p: string) => `HTTPS://${h.toUpperCase()}${p}`,
        (h: string, p: string) => `  ${h}${p}  `,
      ),
      (host, path, spell) => {
        const ls = parseLs(JSON.stringify({
          browsers: [{
            key: "1-1",
            inCurrentTab: true,
            tabs: [
              { id: 1, url: "https://other.example/" },
              { id: 2, url: normalizeUrl(`${host}${path}`) },
            ],
          }],
        }));
        assertEquals(findTab(ls.browsers[0], spell(host, path))?.id, 2);
      },
    ),
    { numRuns },
  );
});

Deno.test("(e) parseLs round-trips well-formed browser lists", () => {
  const tab = fc.record({
    id: fc.integer({ min: 1, max: 99 }),
    url: fc.webUrl(),
    title: fc.string({ maxLength: 10 }),
    active: fc.boolean(),
  });
  const browser = fc.record({
    key: fc.stringMatching(/^\d{1,6}-\d$/),
    inCurrentTab: fc.boolean(),
    tabs: fc.array(tab, { maxLength: 4 }),
  });
  fc.assert(
    fc.property(fc.array(browser, { maxLength: 4 }), (browsers) => {
      const ls = parseLs(JSON.stringify({ browsers }));
      assertEquals(ls.browsers.length, browsers.length);
      ls.browsers.forEach((b, i) => {
        assertEquals(b.key, browsers[i].key);
        assertEquals(b.inCurrentTab, browsers[i].inCurrentTab);
        assertEquals(
          b.tabs.map((t) => t.url),
          browsers[i].tabs.map((t) => t.url),
        );
      });
    }),
    { numRuns },
  );
});
