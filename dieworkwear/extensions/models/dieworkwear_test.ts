/**
 * Contract-fixture tests: pin the parsers against REAL Thread Reader App HTML
 * captured 2026-10-09 (fixtures/) and the bundled rule set against the thread.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model, parseIndex, parseThread, type Rule } from "./dieworkwear.ts";
import { fixture, makeCtx } from "../../fixtures/ctx.ts";

const ID = "1615828613731078146";

Deno.test("parseThread: larger-figures thread has 19 tweets in order", () => {
  const t = parseThread(
    fixture(`thread_${ID}.html`),
    ID,
    "https://threadreaderapp.com",
  );
  assertEquals(t.author, "dieworkwear");
  assertEquals(t.tweetCount, 19);
  assertEquals(t.title, "DRESSING FOR LARGER MALE FIGURES");
  assertEquals(t.postedAt, "2023-01-18T21:48:56.000Z");
  assertEquals(t.tweets[0].id, ID);
  assertEquals(
    t.tweets.map((x) => x.position),
    [...Array(19)].map((_, i) => i + 1),
  );
  assert(t.tweets[0].images[0].startsWith("https://pbs.twimg.com/media/"));
  assert(t.tweets[9].text.includes("The hem should be even"));
  assert(
    t.tweets[7].text.includes("halfway btw collar & floor"),
    "entity decoded",
  );
  assert(!t.tweets.some((x) => /<|>/.test(x.text)), "no markup left");
  assertEquals(t.tweets[17].links, [
    "https://putthison.com/real-people-building-a-holistic-wardrobe/",
  ]);
});

Deno.test("parseIndex: author page yields 21 dated cards", () => {
  const entries = parseIndex(fixture("user_dieworkwear.html"));
  assertEquals(entries.length, 21);
  assertEquals(entries[0].id, "2102443812585144414");
  assertEquals(entries[0].tweetCount, 9);
  assert(entries[0].preview.startsWith("It would be my pleasure"));
  assert(entries.every((e) => e.postedAt !== null));
});

Deno.test("bundled rules cite tweets that exist in the source thread", async () => {
  const t = parseThread(fixture(`thread_${ID}.html`), ID, "x");
  const ids = new Set(t.tweets.map((x) => x.id));
  const set = JSON.parse(
    await Deno.readTextFile(
      new URL("../../references/rules/kabanchik.json", import.meta.url),
    ),
  ) as { rules: Rule[] };
  for (const r of set.rules) {
    assert(ids.has(r.tweetId!), `${r.id} -> ${r.tweetId}`);
  }
  assertEquals(new Set(set.rules.map((r) => r.id)).size, set.rules.length);
});

Deno.test("figure: 172/86/102/98/106/70 classifies as kabanchik", async () => {
  const { ctx, store } = makeCtx();
  await model.methods.figure.execute(
    {
      heightCm: 172,
      weightKg: 86,
      chestCm: 102,
      waistCm: 98,
      hipsCm: 106,
      inseamCm: 70,
    },
    ctx as never,
  );
  const f = store.get("figure") as {
    figure: string;
    metrics: { bmi: number };
    signals: string[];
  };
  assertEquals(f.figure, "kabanchik");
  assertEquals(f.metrics.bmi, 29.1);
  assert(f.signals.some((s) => s.includes("short leg line")));
  assert(f.signals.some((s) => s.includes("hips exceed chest by 4")));
});

Deno.test("advise merges the ethandesu rule set with a source URL", async () => {
  const { ctx, store } = makeCtx();
  await model.methods.advise.execute(
    {
      figure: "kabanchik",
      occasion: "any",
      garment: "trousers",
      includeExtracted: false,
      synthesize: false,
    },
    ctx as never,
  );
  const a = store.get("advice") as {
    rules: { id: string; sourceUrl: string }[];
  };
  const deep = a.rules.find((r) => r.id === "deep-rise-seat");
  assert(
    deep?.sourceUrl.startsWith(
      "https://ethandesu.tumblr.com/post/159630981769",
    ),
  );
  assert(
    a.rules.some((r) =>
      r.sourceUrl.startsWith("https://x.com/dieworkwear/status/")
    ),
  );
});

Deno.test("every bundled rule file has a source url and unique ids", async () => {
  const figs = JSON.parse(
    await Deno.readTextFile(
      new URL("../../references/figures.json", import.meta.url),
    ),
  ) as { figures: { rulesFiles: string[] }[] };
  const files = [...new Set(figs.figures.flatMap((f) => f.rulesFiles))];
  assertEquals(files.length, 3);
  const ids = new Set<string>();
  for (const f of files) {
    const set = JSON.parse(
      await Deno.readTextFile(
        new URL(`../../references/${f}`, import.meta.url),
      ),
    ) as { source: { url: string }; rules: Rule[] };
    assert(set.source.url.startsWith("https://"), f);
    for (const r of set.rules) {
      assert(!ids.has(r.id), `duplicate rule id ${r.id}`);
      ids.add(r.id);
    }
  }
});
