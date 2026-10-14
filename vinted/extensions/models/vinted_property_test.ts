/**
 * Property tests (fast-check). Honors FC_NUM_RUNS.
 *  (a) parseMeasurements: never throws; every value is within [10, 500].
 *  (b) grabJson round-trips any JSON array placed after a key.
 *  (c) decodeRsc inverts JSON-string encoding of push chunks.
 *  (d) slug: output is [a-z0-9-]{1,60}, no leading/trailing dash.
 */
import fc from "npm:fast-check@4.8.0";
import { decodeRsc, grabJson, parseMeasurements, slug } from "./vinted.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? 200);

Deno.test("(a) parseMeasurements bounded", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 400 }),
      (s) =>
        Object.values(parseMeasurements(s)).every((v) => v >= 10 && v <= 500),
    ),
    { numRuns },
  );
});
Deno.test("(b) grabJson round-trip", () => {
  fc.assert(
    fc.property(
      fc.array(fc.jsonValue(), { maxLength: 5 }),
      fc.string({ maxLength: 20 }),
      (arr, pre) => {
        const got = grabJson(
          `${pre.replace(/"items":\[/g, "")}{"items":${
            JSON.stringify(arr)
          },"x":1}`,
          '"items":[',
        );
        return JSON.stringify(got) ===
          JSON.stringify(JSON.parse(JSON.stringify(arr)));
      },
    ),
    { numRuns },
  );
});
Deno.test("(c) decodeRsc inverts chunk encoding", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ maxLength: 50 }), { maxLength: 4 }),
      (parts) =>
        decodeRsc(
          parts.map((p) =>
            `<script>self.__next_f.push([1,${JSON.stringify(p)}])</script>`
          ).join(""),
        ) === parts.join(""),
    ),
    { numRuns },
  );
});
Deno.test("(d) slug shape", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 100 }),
      (s) => /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/.test(slug(s)),
    ),
    { numRuns },
  );
});
