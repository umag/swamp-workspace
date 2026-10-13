/**
 * Property suite (fast-check). FC_NUM_RUNS-gated: small by default, large in
 * the nightly soak.
 *
 *  (a) framing: any sequence of JSON objects, split at any chunk boundaries,
 *      decodes to exactly the original sequence.
 *  (b) incrementNonce == (little-endian integer + 1) mod 2^192.
 *  (c) namespaceFromVaultName yields "" or a valid namespace, for any name.
 *  (d) flow: after any sequence of puts, get returns the last value per key
 *      and list returns exactly the set of keys put.
 */
import fc from "npm:fast-check@4.8.0";
import { assertEquals } from "jsr:@std/assert@1";
import { createKeePassXCProvider } from "../vaults/keepassxc/mod.ts";
import {
  fakeDeps,
  FakeKeePassXC,
} from "../vaults/keepassxc/fake_keepassxc_test_helper.ts";
import {
  encodeFrame,
  FrameDecoder,
  incrementNonce,
  isValidNamespace,
  namespaceFromVaultName,
} from "../vaults/keepassxc/protocol.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

const jsonObject = fc.dictionary(
  fc.string(),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
);

Deno.test("property: frames round-trip across arbitrary chunking", () => {
  fc.assert(
    fc.property(
      fc.array(jsonObject, { maxLength: 5 }),
      fc.array(fc.integer({ min: 1, max: 64 }), {
        minLength: 1,
        maxLength: 10,
      }),
      (objs, cuts) => {
        const bytes = objs.map(encodeFrame);
        const all = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
        let o = 0;
        for (const b of bytes) {
          all.set(b, o);
          o += b.length;
        }
        const d = new FrameDecoder();
        const out: Record<string, unknown>[] = [];
        let pos = 0;
        let i = 0;
        while (pos < all.length) {
          const step = cuts[i++ % cuts.length];
          out.push(...d.push(all.subarray(pos, pos + step)));
          pos += step;
        }
        assertEquals(out, objs.map((x) => JSON.parse(JSON.stringify(x))));
        assertEquals(d.pendingBytes, 0);
      },
    ),
    FC_RUNS,
  );
});

function leToBig(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

Deno.test("property: incrementNonce is little-endian +1 mod 2^192", () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 24, maxLength: 24 }), (n) => {
      const next = leToBig(incrementNonce(n));
      assertEquals(next, (leToBig(n) + 1n) % (1n << 192n));
    }),
    FC_RUNS,
  );
  const max = new Uint8Array(24).fill(0xff);
  assertEquals(leToBig(incrementNonce(max)), 0n);
});

Deno.test("property: derived namespaces are empty or valid", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (name) => {
      const ns = namespaceFromVaultName(name);
      assertEquals(ns === "" || isValidNamespace(ns), true);
    }),
    FC_RUNS,
  );
});

const key = fc.string({ minLength: 1, maxLength: 40 }).filter((k) =>
  // deno-lint-ignore no-control-regex
  !/[\u0000-\u001f\u007f]/.test(k)
);

Deno.test("property: put/get/list flow matches a Map model", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.tuple(key, fc.string()), { minLength: 1, maxLength: 8 }),
      async (ops) => {
        const server = new FakeKeePassXC();
        const p = createKeePassXCProvider("ci", {}, fakeDeps(server));
        const model = new Map<string, string>();
        for (const [k, v] of ops) {
          await p.put(k, v);
          model.set(k, v);
        }
        for (const [k, v] of model) assertEquals(await p.get(k), v);
        assertEquals(await p.list(), [...model.keys()].sort());
        assertEquals(server.entries.length, model.size);
      },
    ),
    { numRuns: NIGHT(50) },
  );
});
