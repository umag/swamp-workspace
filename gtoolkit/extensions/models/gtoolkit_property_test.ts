/**
 * Property / invariant / flow suite (fast-check). FC_NUM_RUNS sets the run
 * count: small by default in CI, large in the soak task.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  parseStringArray,
  runStart,
  runStatus,
  runStop,
  toEvaluation,
  unquoteSmalltalk,
} from "./gtoolkit.ts";
import { assertIdentifier, stString } from "./lib/smalltalk.ts";
import { escapeControlCharsInStrings, parseLenientJson } from "./lib/json.ts";
import {
  evalAnswer,
  fakeContext,
  fakeDeps,
  fakeGt,
} from "./lib/test_support.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? "200");

/** Reads one Smalltalk string literal the way the Smalltalk scanner does. */
function scanStringLiteral(src: string): { value: string; rest: string } {
  if (src[0] !== "'") throw new Error("not a literal");
  let value = "";
  let i = 1;
  while (i < src.length) {
    if (src[i] === "'") {
      if (src[i + 1] === "'") {
        value += "'";
        i += 2;
        continue;
      }
      return { value, rest: src.slice(i + 1) };
    }
    value += src[i++];
  }
  throw new Error("unterminated literal");
}

const noNul = fc.string({ unit: "grapheme" }).filter((s) =>
  !s.includes("\u0000")
);

Deno.test("stString: the scanner reads back exactly the input, and nothing follows the literal", () => {
  fc.assert(
    fc.property(noNul, (s) => {
      const { value, rest } = scanStringLiteral(stString(s));
      assertEquals(value, s);
      assertEquals(rest, "");
    }),
    { numRuns },
  );
});

Deno.test("GT print-string decoding inverts GT's encoding for any String", () => {
  fc.assert(
    fc.property(noNul, (s) => {
      const smalltalkPrint = stString(s); // what String>>printString gives
      const e = toEvaluation(
        "x",
        evalAnswer("ByteString", smalltalkPrint),
        "",
        new Date(0),
      );
      assertEquals(e.printString, smalltalkPrint);
      assertEquals(e.string, s);
      assertEquals(unquoteSmalltalk(smalltalkPrint), s);
    }),
    { numRuns },
  );
});

Deno.test("parseStringArray reads back any array of strings printed Smalltalk-style", () => {
  fc.assert(
    fc.property(fc.array(noNul, { maxLength: 8 }), (xs) => {
      const printed = `#(${xs.map(stString).join(" ")})`;
      assertEquals(parseStringArray(printed), xs);
    }),
    { numRuns },
  );
});

Deno.test("lenient JSON: identical to JSON.parse on valid JSON", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (v) => {
      const text = JSON.stringify(v, null, "\t");
      assertEquals(parseLenientJson(text), JSON.parse(text));
    }),
    { numRuns },
  );
});

Deno.test("lenient JSON: raw control characters inside strings parse to the same value", () => {
  const ctrl = fc.string({
    unit: fc.constantFrom("\t", "\r", "\n", "\u0001", "a", '"', "\\"),
  });
  fc.assert(
    fc.property(fc.dictionary(fc.string({ maxLength: 5 }), ctrl), (obj) => {
      // Serialize, then un-escape control characters back to raw bytes inside strings.
      const raw = JSON.stringify(obj, null, "\t")
        .replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\n/g, "\n")
        .replace(/\\u0001/g, "\u0001");
      // The un-escaping above could break an escaped backslash followed by t/r/n; only
      // check inputs where it did not change the meaning.
      if (/\\\\[trn]/.test(JSON.stringify(obj))) return;
      assertEquals(parseLenientJson(raw), obj);
    }),
    { numRuns },
  );
});

Deno.test("control-character escaping never touches text outside string literals", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (v) => {
      const text = JSON.stringify(v, null, "\t");
      assertEquals(escapeControlCharsInStrings(text), text);
    }),
    { numRuns },
  );
});

Deno.test("identifiers: accepted exactly when they match the grammar and are not reserved", () => {
  const reserved = new Set([
    "self",
    "super",
    "nil",
    "true",
    "false",
    "thisContext",
  ]);
  fc.assert(
    fc.property(fc.string({ maxLength: 70 }), (s) => {
      const expected = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(s) &&
        !reserved.has(s);
      let accepted = true;
      try {
        assertIdentifier(s);
      } catch {
        accepted = false;
      }
      assertEquals(accepted, expected, s);
    }),
    { numRuns },
  );
});

Deno.test("flow: any sequence of start/stop/status keeps the lifecycle invariants", async () => {
  const HOME = "/opt/gt";
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.array(fc.constantFrom("start", "stop", "status"), {
        minLength: 1,
        maxLength: 12,
      }),
      async (initiallyUp, ops) => {
        const gt = fakeGt({ up: initiallyUp });
        gt.onEval = (c) => {
          if (c.code.includes("andQuit: true")) gt.up = false;
          return evalAnswer("Array", "#()");
        };
        const deps = fakeDeps(gt, {
          existing: new Set([
            `${HOME}/GlamorousToolkit.image`,
            `${HOME}/bin/GlamorousToolkit-cli`,
          ]),
        });
        deps.spawnDetached = (cmd, args, cwd) => {
          deps.spawned.push({ cmd, args, cwd });
          gt.up = true; // GT comes up
          return 4242;
        };
        for (const op of ops) {
          const upBefore = gt.up;
          const spawnsBefore = deps.spawned.length;
          const ctx = fakeContext({ gtHome: HOME });
          if (op === "start") {
            await runStart(ctx, { timeoutMs: 3000 }, deps);
            // Never spawn a second GT while one answers; always end up answering.
            assertEquals(deps.spawned.length - spawnsBefore, upBefore ? 0 : 1);
            assert(gt.up);
            assertEquals(ctx.written[0].data.changed, !upBefore);
          } else if (op === "stop") {
            await runStop(ctx, { timeoutMs: 3000 }, deps);
            assert(!gt.up);
            assertEquals(ctx.written[0].data.changed, upBefore);
          } else {
            await runStatus(ctx, deps);
            assertEquals(ctx.written[0].data.reachable, gt.up);
            assertEquals(gt.up, upBefore, "status must not change state");
          }
        }
      },
    ),
    { numRuns: Math.max(20, Math.floor(numRuns / 5)) },
  );
});
