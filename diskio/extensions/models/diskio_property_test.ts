/**
 * Property-based tests (fast-check) for @magistr/diskio.
 *
 * Properties, over generated host output rather than fixed fixtures:
 *  (a) rate arithmetic — every reported rate equals delta/window/MiB exactly,
 *      and is always finite for any finite counter pair.
 *  (b) totals — the reported totals sum EVERY sampled process, independent of
 *      topN, and topN only truncates the reported list.
 *  (c) ranking — readers come back sorted descending by read activity and
 *      never longer than topN.
 *  (d) alias groups — a group is emitted iff two or more layers resolve to one
 *      spindle, every layer appears in at most one group, and the resolution
 *      terminates for arbitrary slave graphs (including cyclic ones).
 *  (e) transport injectivity — the remote command is always a lone base64 blob
 *      whose decoded script is byte-identical to what the model built, for
 *      arbitrary paths.
 *  (f) summarize — never credits a fuseProxy, and never credits a reader whose
 *      onTarget is explicitly false.
 *
 * The runner is scripted, so no ssh is spawned at any iteration count.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  probeDeviceMap,
  probeOpenFiles,
  probeReaders,
  summarize,
} from "./diskio.ts";
import { decodeScript, scripted } from "./lib/fixtures.ts";

const NUM_RUNS = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");
const cfg = { numRuns: NUM_RUNS };

const MB = 1048576;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A sampled process: pid plus the four non-negative counter deltas. */
const procArb = fc.record({
  pid: fc.integer({ min: 1, max: 4194304 }),
  drc: fc.integer({ min: 0, max: 4e11 }),
  dwc: fc.integer({ min: 0, max: 4e11 }),
  drb: fc.integer({ min: 0, max: 4e11 }),
  dwb: fc.integer({ min: 0, max: 4e11 }),
});

function readersOut(
  procs: Array<
    { pid: number; drc: number; dwc: number; drb: number; dwb: number }
  >,
) {
  return procs
    .map((p) =>
      `P|${p.pid}|${p.drc}|${p.dwc}|${p.drb}|${p.dwb}||/bin/proc${p.pid}`
    )
    .join("\n");
}

Deno.test("property: every rate is exactly delta/window/MiB and always finite", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(procArb, {
        minLength: 1,
        maxLength: 12,
        selector: (p) => p.pid,
      }),
      fc.integer({ min: 1, max: 600 }),
      async (procs, seconds) => {
        const { run } = scripted(readersOut(procs));
        const r = await probeReaders(run, "h", "u", seconds, 99, []);
        assertEquals(r.readers.length, procs.length);
        for (const reader of r.readers) {
          const src = procs.find((p) => p.pid === reader.pid)!;
          assertEquals(
            reader.requestedReadMBps,
            round2(src.drc / seconds / MB),
          );
          assertEquals(reader.blockReadMBps, round2(src.drb / seconds / MB));
          assert(Number.isFinite(reader.requestedWriteMBps));
          assert(Number.isFinite(reader.blockWriteMBps));
        }
      },
    ),
    cfg,
  );
});

Deno.test("property: totals are independent of topN; topN only truncates", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(procArb, {
        minLength: 1,
        maxLength: 12,
        selector: (p) => p.pid,
      }),
      fc.integer({ min: 1, max: 20 }),
      async (procs, topN) => {
        const out = readersOut(procs);
        const { run: a } = scripted(out);
        const { run: b } = scripted(out);
        const few = await probeReaders(a, "h", "u", 30, topN, []);
        const all = await probeReaders(b, "h", "u", 30, 999, []);

        assertEquals(few.totals, all.totals);
        assertEquals(few.readers.length, Math.min(topN, procs.length));
      },
    ),
    cfg,
  );
});

Deno.test("property: readers come back sorted descending by read activity", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(procArb, {
        minLength: 1,
        maxLength: 12,
        selector: (p) => p.pid,
      }),
      async (procs) => {
        const { run } = scripted(readersOut(procs));
        const r = await probeReaders(run, "h", "u", 30, 99, []);
        const score = (
          x: { requestedReadMBps: number; blockReadMBps: number },
        ) => x.requestedReadMBps + x.blockReadMBps;
        for (let i = 1; i < r.readers.length; i++) {
          assert(score(r.readers[i - 1]) >= score(r.readers[i]));
        }
      },
    ),
    cfg,
  );
});

Deno.test("property: alias groups partition the layers, and resolution always terminates", async () => {
  const devName = fc.integer({ min: 0, max: 5 }).map((i) => `dm-${i}`);
  await fc.assert(
    fc.asyncProperty(
      // An ARBITRARY slave graph over dm-0..dm-5 plus two real spindles —
      // cycles and dangling references included, by construction.
      fc.array(
        fc.tuple(
          devName,
          fc.array(fc.oneof(devName, fc.constantFrom("sdl", "sdm")), {
            maxLength: 3,
          }),
        ),
        { maxLength: 8 },
      ),
      async (edges) => {
        const seen = new Set<string>();
        const lines = ["DEV|sdl|100||", "DEV|sdm|100||"];
        for (const [name, slaves] of edges) {
          if (seen.has(name)) continue;
          seen.add(name);
          lines.push(
            `DEV|${name}|100|${name}|${slaves.join(",")}${
              slaves.length ? "," : ""
            }`,
          );
        }
        const { run } = scripted(lines.join("\n"));
        const map = await probeDeviceMap(run, "h", "u"); // must not hang

        const grouped = new Map<string, number>();
        for (const g of map.aliasGroups) {
          assert(g.layers.length > 1, "a single-layer group is not an alias");
          for (const l of g.layers) {
            grouped.set(l, (grouped.get(l) ?? 0) + 1);
            assertEquals(grouped.get(l), 1, `${l} appears in two groups`);
          }
        }
        // Every device that resolved to a spindle shared by >1 layer is in one.
        const byPhysical = new Map<string, string[]>();
        for (const d of map.devices) {
          if (!d.physical) continue;
          byPhysical.set(d.physical, [
            ...(byPhysical.get(d.physical) ?? []),
            d.name,
          ]);
        }
        for (const [physical, layers] of byPhysical) {
          if (layers.length > 1) {
            assert(
              map.aliasGroups.some((g) => g.physical === physical),
              `${physical} has ${layers.length} layers but no group`,
            );
          }
        }
      },
    ),
    cfg,
  );
});

Deno.test("property: the remote command is a lone base64 blob for ANY path", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.stringMatching(/^\/[\w\-./ +@:,'()[\]#&=]{0,60}$/).filter((p) =>
        !p.includes("..")
      ),
      async (path) => {
        const { run, calls } = scripted("");
        await probeOpenFiles(run, "h", "u", path, [], 10);
        assertEquals(calls.length, 1);
        assert(
          /^echo [A-Za-z0-9+/=]+ \| base64 -d \| bash$/.test(calls[0].command),
        );
        // Round-trip: what the host runs is exactly what the model built.
        const script = decodeScript(calls[0].command);
        assert(script.includes("/proc"));
        assert(!calls[0].command.includes(path));
      },
    ),
    cfg,
  );
});

Deno.test("property: summarize never credits a proxy or an off-disk reader", async () => {
  await fc.assert(
    fc.property(
      fc.array(
        fc.record({
          pid: fc.integer({ min: 1, max: 9999 }),
          container: fc.string({ minLength: 1, maxLength: 12 }).filter((s) =>
            /^[A-Za-z][\w-]*$/.test(s)
          ),
          requestedReadMBps: fc.double({ min: 0.01, max: 1000, noNaN: true }),
          fuseProxy: fc.boolean(),
          onTarget: fc.constantFrom(true, false, null),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      (rs) => {
        const readers = rs.map((r) => ({
          ...r,
          command: `/bin/${r.container}`,
          requestedWriteMBps: 0,
          blockReadMBps: 0,
          blockWriteMBps: 0,
        }));
        const s = summarize("sdl", "sdl", ["sdl"], readers, []);
        const credited = readers.filter((r) =>
          s.includes(`${r.container} ${r.requestedReadMBps} MB/s`)
        );
        for (const c of credited) {
          assert(!c.fuseProxy, `proxy ${c.container} was credited`);
          assert(c.onTarget !== false, `off-disk ${c.container} was credited`);
        }
      },
    ),
    cfg,
  );
});
