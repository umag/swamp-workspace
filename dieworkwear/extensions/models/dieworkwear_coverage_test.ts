/** Coverage tests: classifier branches and rule selection edges. */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { classifyFigure, type Rule, selectRules } from "./dieworkwear.ts";

Deno.test("classifyFigure branches", () => {
  assertEquals(
    classifyFigure({ heightCm: 190, weightKg: 110 }).figure,
    "big-tall",
  );
  assertEquals(
    classifyFigure({ heightCm: 180, weightKg: 85, chestCm: 112, waistCm: 90 })
      .figure,
    "athletic",
  );
  assertEquals(classifyFigure({ heightCm: 180, weightKg: 60 }).figure, "slim");
  assertEquals(
    classifyFigure({ heightCm: 180, weightKg: 75 }).figure,
    "average",
  );
  // BMI 25.5 but round torso -> kabanchik
  assertEquals(
    classifyFigure({ heightCm: 175, weightKg: 78, chestCm: 100, waistCm: 96 })
      .figure,
    "kabanchik",
  );
  const none = classifyFigure({ heightCm: 175, weightKg: 70 });
  assertEquals([none.dropCm, none.hipsMinusChestCm, none.inseamRatio], [
    null,
    null,
    null,
  ]);
});

const base: Rule = {
  id: "a",
  figures: ["kabanchik"],
  garment: "jacket",
  occasions: ["formal"],
  severity: "low",
  rule: "r",
  why: "w",
  check: "c",
  tweetId: "1",
};

Deno.test("selectRules: occasion, garment, dedupe, sort", () => {
  const rules: Rule[] = [
    base,
    { ...base, id: "b", severity: "high", garment: "any", occasions: ["any"] },
    { ...base, id: "a" },
    { ...base, id: "c", figures: ["slim"] },
    { ...base, id: "d", occasions: ["casual"] },
  ];
  assertEquals(
    selectRules(rules, "kabanchik", "formal", "jacket").map((r) => r.id),
    ["b", "a"],
  );
  assertEquals(
    selectRules(rules, "kabanchik", "casual", null).map((r) => r.id),
    ["b", "d"],
  );
  assertEquals(
    selectRules(rules, "kabanchik", "any", "trousers").map((r) => r.id),
    ["b"],
  );
  assert(selectRules(rules, "slim", "any", null).every((r) => r.id === "c"));
});
