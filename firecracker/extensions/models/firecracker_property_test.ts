/**
 * Property-based tests (fast-check) for @magistr/firecracker.
 *
 * firecracker.ts / lib/ssh.ts are UNMODIFIED — every property here is
 * observed either by calling an EXPORTED pure builder directly (shellEsc
 * itself is a private helper, so it is exercised indirectly through builders
 * that use it — see the local `shellEsc`/`unshellEsc` pair below, which
 * reimplements the exact production algorithm so its round-trip can be
 * trusted as a faithful stand-in), or by driving `model.methods.<m>.execute()`
 * against a stubbed `globalThis.Deno.Command`. Named invariants:
 *
 *  (a) shellEsc safety — arbitrary strings (no embedded newline, to keep this
 *      test's own line-based extraction unambiguous) round-trip losslessly
 *      through shellEsc's single-quote escaping, and the SAME escaped form
 *      appears verbatim in real builder output (buildKillVmmCmd,
 *      buildStartVmmCmd, buildDeployFabricCmd) for arbitrary path-like
 *      handles — these builders accept plain `string` params (no zod
 *      restriction at the pure-function layer), so this is a genuine
 *      end-to-end exercise of the escaping, not just the schema-restricted
 *      subset a method argument would allow.
 *  (b) addToIp / deriveVethAddrs — addToIp only touches the last octet and
 *      is restricted (per its own doc comment) to keep that octet in
 *      [0,255] (no carry); deriveVethAddrs derives host (.1) / ns (.2) from
 *      an arbitrary /30 veth subnet's third octet, injectively.
 *  (c) utf8ToBase64 ↔ decode round-trip for arbitrary strings (the property
 *      that unblocks non-ASCII task prompts/results — CJK, emoji, box-drawing
 *      — per CHANGELOG 2026.06.12.2).
 *  (d) shortHash — deterministic (same input -> same output) and, over a
 *      FIXED bounded integer domain mapped to distinct `fc-agent-<i>`
 *      strings, injective (no collision) — the property `bringUpWorker`
 *      relies on to keep concurrent VMs' root-side veth names apart.
 *  (e) workerIndexFromNetns — round-trips an in-range [1,256] worker index
 *      embedded in `<prefix>-<i>`, and rejects out-of-range / non-numeric
 *      suffixes.
 *  (f) buildQueuePayload never carries a "token" key, for arbitrary safe
 *      task field combinations (the credential-hygiene boundary `submit`
 *      relies on — the daemon injects the token at serve time instead).
 *
 * Property iteration count is overridable via FC_NUM_RUNS (small by default
 * here, large in `deno task test:soak`; verified manually at FC_NUM_RUNS=5000
 * per the ext-quality-bf-firecracker plan).
 */
import fc from "npm:fast-check@4.8.0";
import { assertEquals } from "jsr:@std/assert@1";
import {
  addToIp,
  buildDeployFabricCmd,
  buildKillVmmCmd,
  buildQueuePayload,
  buildStartVmmCmd,
  deriveVethAddrs,
  fabricPaths,
  shortHash,
  utf8ToBase64,
  workerIndexFromNetns,
} from "./firecracker.ts";

// Property iteration count — overridable for the nightly soak via FC_NUM_RUNS
// (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// (a) shellEsc — local reimplementation of the production (private) helper,
// used to build EXPECTED escaped substrings, plus a self-check that our
// reimplementation is a faithful, invertible stand-in.
// ---------------------------------------------------------------------------

function shellEsc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function unshellEsc(encoded: string): string {
  const middle = encoded.slice(1, -1);
  return middle.replace(/'\\''/g, "'");
}

const arbSafeStr = fc.string({ maxLength: 30 }).filter((s) =>
  !s.includes("\n")
);

Deno.test("sanity: unshellEsc correctly inverts shellEsc's single-quote escaping for arbitrary strings", () => {
  fc.assert(
    fc.property(arbSafeStr, (s) => unshellEsc(shellEsc(s)) === s),
    FC_RUNS,
  );
});

Deno.test("sanity: unshellEsc round-trip works even with an embedded single quote", () => {
  const tricky = "a'b'c";
  assertEquals(unshellEsc(shellEsc(tricky)), tricky);
});

Deno.test("property: buildKillVmmCmd shellEsc's an arbitrary socketPath verbatim (the exact single-quote-escaping algorithm)", () => {
  fc.assert(
    fc.property(arbSafeStr, (s) => {
      const cmd = buildKillVmmCmd(s);
      return cmd.includes(`rm -f ${shellEsc(s)}`);
    }),
    FC_RUNS,
  );
});

Deno.test("property: buildStartVmmCmd shellEsc's an arbitrary logPath verbatim", () => {
  fc.assert(
    fc.property(arbSafeStr, (logPath) => {
      const cmd = buildStartVmmCmd("/tmp/fc.socket", undefined, logPath);
      return cmd.includes(`>${shellEsc(logPath)} 2>&1`);
    }),
    FC_RUNS,
  );
});

Deno.test("property: buildDeployFabricCmd shellEsc's an arbitrary pidFile verbatim", () => {
  fc.assert(
    fc.property(arbSafeStr, (pidFile) => {
      const paths = fabricPaths("/tmp/fc-fabric");
      const cmd = buildDeployFabricCmd(
        "fcw-1",
        "172.16.0.1",
        8080,
        paths,
        "sk-ant-x",
        pidFile,
      );
      return cmd.includes(`> ${shellEsc(pidFile)}`);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) addToIp / deriveVethAddrs
// ---------------------------------------------------------------------------

const arbOctet = fc.integer({ min: 0, max: 252 });
const arbK = fc.integer({ min: 0, max: 3 }); // keeps octet+k in [0,255] (doc'd no-carry contract)

Deno.test("property: addToIp only changes the LAST octet, by exactly k, others untouched", () => {
  fc.assert(
    fc.property(
      arbOctet,
      arbOctet,
      arbOctet,
      arbOctet,
      arbK,
      (a, b, c, d, k) => {
        const ip = `${a}.${b}.${c}.${d}`;
        const out = addToIp(ip, k);
        const parts = out.split(".");
        return (
          parts[0] === String(a) &&
          parts[1] === String(b) &&
          parts[2] === String(c) &&
          parts[3] === String(d + k)
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: addToIp composes — addToIp(addToIp(ip,k1),k2) === addToIp(ip,k1+k2) when the sum stays in range", () => {
  fc.assert(
    fc.property(
      arbOctet,
      arbOctet,
      arbOctet,
      fc.integer({ min: 0, max: 250 }),
      fc.integer({ min: 0, max: 2 }),
      fc.integer({ min: 0, max: 2 }),
      (a, b, c, d, k1, k2) => {
        const ip = `${a}.${b}.${c}.${d}`;
        return addToIp(addToIp(ip, k1), k2) === addToIp(ip, k1 + k2);
      },
    ),
    FC_RUNS,
  );
});

const arbThirdOctet = fc.integer({ min: 0, max: 255 });

Deno.test("property: deriveVethAddrs derives host=.1 / ns=.2 / preserves prefix, for an arbitrary /30 veth subnet third octet", () => {
  fc.assert(
    fc.property(arbThirdOctet, (x) => {
      const { vethHostIp, vethNsIp, vethPrefix } = deriveVethAddrs(
        `10.0.${x}.0/30`,
      );
      return (
        vethHostIp === `10.0.${x}.1` &&
        vethNsIp === `10.0.${x}.2` &&
        vethPrefix === "30"
      );
    }),
    FC_RUNS,
  );
});

Deno.test("property: deriveVethAddrs is INJECTIVE across the third octet — distinct subnets never collide, identical subnets always agree", () => {
  fc.assert(
    fc.property(arbThirdOctet, arbThirdOctet, (x, y) => {
      const a = deriveVethAddrs(`10.0.${x}.0/30`);
      const b = deriveVethAddrs(`10.0.${y}.0/30`);
      const equal = JSON.stringify(a) === JSON.stringify(b);
      return x === y ? equal : !equal;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) utf8ToBase64 round-trip (the non-Latin1 fix, CHANGELOG 2026.06.12.2)
// ---------------------------------------------------------------------------

function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
  );
}

Deno.test("property: utf8ToBase64 round-trips arbitrary strings exactly (ASCII, emoji, CJK, box-drawing)", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 60 }),
      (s) => decodeBase64Utf8(utf8ToBase64(s)) === s,
    ),
    FC_RUNS,
  );
});

Deno.test("property: utf8ToBase64 never throws on non-Latin1 content (unlike plain btoa)", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 60 }), (s) => {
      utf8ToBase64(s); // must not throw
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) shortHash — deterministic + injective over a fixed bounded domain
// ---------------------------------------------------------------------------

Deno.test("property: shortHash is deterministic — the same input always yields the same output", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 40 }),
      (s) => shortHash(s) === shortHash(s),
    ),
    FC_RUNS,
  );
});

Deno.test("property: shortHash is hex", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 40 }),
      (s) => /^[0-9a-f]+$/.test(shortHash(s)),
    ),
    FC_RUNS,
  );
});

Deno.test("property: shortHash is injective over distinct `fc-agent-<i>` namespaces for i in a fixed bounded domain (no collision)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 500 }),
      fc.integer({ min: 0, max: 500 }),
      (i, j) => {
        const hi = shortHash(`fc-agent-${i}`);
        const hj = shortHash(`fc-agent-${j}`);
        return i === j ? hi === hj : hi !== hj;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("sanity: batch injectivity over a full fixed domain (i in 0..999) — deterministic, never flakes", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    seen.add(shortHash(`fc-agent-${i}`));
  }
  assertEquals(seen.size, 1000, "all 1000 namespace hashes are distinct");
});

// ---------------------------------------------------------------------------
// (e) workerIndexFromNetns
// ---------------------------------------------------------------------------

Deno.test("property: workerIndexFromNetns round-trips an in-range [1,256] index embedded in <prefix>-<i>", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 256 }),
      fc.constantFrom("fcw", "fc-w", "fc.w", "worker"),
      (i, prefix) => workerIndexFromNetns(`${prefix}-${i}`) === i,
    ),
    FC_RUNS,
  );
});

Deno.test("property: workerIndexFromNetns rejects any out-of-range NON-NEGATIVE integer (i===0 or i>256)", () => {
  // Restricted to non-negative i: a negative index embedded via template
  // interpolation (`fcw-${-1}` === "fcw--1") introduces a SECOND hyphen, and
  // workerIndexFromNetns splits on "-" and takes the trailing segment — so
  // "fcw--1".split("-").pop() is "1", not "-1". That's a property of the
  // hyphen-delimited STRING FORMAT, not of workerIndexFromNetns's numeric
  // range check, and it never arises in practice (fabric_up's own indices
  // start at 1 via Array.from). Testing it here would be an over-strong
  // invariant against a construction the function was never meant to parse.
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100000 }).filter((i) => i < 1 || i > 256),
      (i) => workerIndexFromNetns(`fcw-${i}`) === null,
    ),
    FC_RUNS,
  );
});

Deno.test("property: workerIndexFromNetns rejects a trailing segment that Number() cannot parse as an integer", () => {
  // Two things must both hold for `suffix` to be a fair probe of the
  // "non-numeric trailing segment" branch:
  //  1. No embedded hyphen — workerIndexFromNetns splits the WHOLE netns on
  //     EVERY "-" and takes the LAST segment, so a suffix containing its own
  //     "-" (e.g. "!-1") is not what actually reaches Number() once embedded
  //     in `fcw-${suffix}` (only the text after the suffix's OWN last hyphen
  //     does) — an over-strong invariant against the wrong string entirely.
  //  2. Filtered with the SAME predicate workerIndexFromNetns itself uses
  //     (Number.isInteger(Number(s))), not an approximating regex — Number()
  //     trims whitespace and accepts a leading "+"/"-", so `^-?\d+$` both
  //     over- and under-rejects relative to what Number() actually parses
  //     (e.g. Number(" 1") === 1).
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) =>
        !s.includes("-") && !Number.isInteger(Number(s))
      ),
      (suffix) => workerIndexFromNetns(`fcw-${suffix}`) === null,
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (f) buildQueuePayload — no-token-key credential-hygiene boundary
// ---------------------------------------------------------------------------

const arbPrompt = fc.string({ minLength: 1, maxLength: 40 });
const arbOptStr = fc.option(fc.string({ maxLength: 20 }), { nil: undefined });

Deno.test("property: buildQueuePayload never carries a 'token' key, for arbitrary task field combinations", () => {
  fc.assert(
    fc.property(
      arbPrompt,
      arbOptStr,
      arbOptStr,
      arbOptStr,
      fc.string({ maxLength: 6 }),
      (prompt, model, effort, gitRepoUrl, id) => {
        const p = buildQueuePayload(
          { prompt, model, effort, gitRepoUrl },
          id,
        ) as Record<
          string,
          unknown
        >;
        return !("token" in p);
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: buildQueuePayload's id/prompt pass through verbatim for arbitrary values", () => {
  fc.assert(
    fc.property(arbPrompt, fc.string({ maxLength: 12 }), (prompt, id) => {
      const p = buildQueuePayload({ prompt }, id) as Record<string, unknown>;
      return p.id === id && p.prompt === prompt;
    }),
    FC_RUNS,
  );
});

Deno.test("anti-vacuity: workerIndexFromNetns boundary values (0 and 257) are rejected outside the property sweep", () => {
  assertEquals(workerIndexFromNetns("fcw-0"), null);
  assertEquals(workerIndexFromNetns("fcw-257"), null);
});
