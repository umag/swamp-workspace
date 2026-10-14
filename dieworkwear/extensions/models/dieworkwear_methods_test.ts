/** Methods tests: every method's execute() against stubbed network / claude. */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { deps, model } from "./dieworkwear.ts";
import { fixture, makeCtx } from "../../fixtures/ctx.ts";

const ID = "1615828613731078146";
const realDeps = { ...deps };
function restore() {
  Object.assign(deps, realDeps);
}

Deno.test("discover: paginates with before= until no new cards", async () => {
  const urls: string[] = [];
  const page = fixture("user_dieworkwear.html");
  deps.fetchText = (u) => {
    urls.push(u);
    return Promise.resolve(urls.length === 1 ? page : page); // 2nd page repeats -> stop
  };
  try {
    const { ctx, store } = makeCtx();
    await model.methods.discover.execute({ maxPages: 5 }, ctx as never);
    const idx = store.get("index") as {
      threadCount: number;
      pagesFetched: number;
    };
    assertEquals(idx.threadCount, 21);
    assertEquals(idx.pagesFetched, 2);
    assert(urls[1].includes("&before="));
  } finally {
    restore();
  }
});

Deno.test("fetch: writes thread + corpus, second call is a no-op", async () => {
  let calls = 0;
  deps.fetchText =
    () => (calls++, Promise.resolve(fixture(`thread_${ID}.html`)));
  try {
    const { ctx, store } = makeCtx();
    await model.methods.fetch.execute(
      { ids: [ID], limit: 50, refresh: false },
      ctx as never,
    );
    await model.methods.fetch.execute(
      { ids: [ID], limit: 50, refresh: false },
      ctx as never,
    );
    assertEquals(calls, 1);
    assertEquals(
      (store.get("corpus") as { threadCount: number }).threadCount,
      1,
    );
    assertEquals(
      (store.get(`thread-${ID}`) as { tweetCount: number }).tweetCount,
      19,
    );
  } finally {
    restore();
  }
});

Deno.test("fetch: match without index rejects", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () =>
      model.methods.fetch.execute({
        ids: [],
        match: "large",
        limit: 5,
        refresh: false,
      }, ctx as never),
    Error,
    "discover",
  );
});

Deno.test("advise: alias кабанчик, trousers only, high severity first", async () => {
  const { ctx, store } = makeCtx();
  await model.methods.advise.execute(
    {
      figure: "кабанчик",
      occasion: "work",
      garment: "trousers",
      includeExtracted: true,
      synthesize: false,
    },
    ctx as never,
  );
  const a = store.get("advice") as {
    figure: string;
    rules: { garment: string; severity: string; sourceUrl: string }[];
  };
  assertEquals(a.figure, "kabanchik");
  assert(a.rules.length > 0);
  assert(a.rules.every((r) => r.garment === "trousers" || r.garment === "any"));
  assertEquals(a.rules[0].severity, "high");
  assert(a.rules[0].sourceUrl.startsWith("https://x.com/dieworkwear/status/"));
});

Deno.test("advise synthesize + extract use the corpus via claude stub", async () => {
  deps.fetchText = () => Promise.resolve(fixture(`thread_${ID}.html`));
  const prompts: string[] = [];
  deps.runClaude = (_b, _m, p) => {
    prompts.push(p);
    return Promise.resolve(
      p.startsWith("Extract")
        ? '```json\n[{"id":"hem","figures":["kabanchik","nope"],"garment":"jacket","occasions":["any"],"severity":"high","rule":"r","why":"w","check":"c","tweetId":"1615828643800059907"},{"id":"fake","figures":["kabanchik"],"garment":"any","occasions":["any"],"severity":"low","rule":"r","why":"w","check":"c","tweetId":"999"}]\n```'
        : "Narrative.",
    );
  };
  try {
    const { ctx, store } = makeCtx();
    await model.methods.fetch.execute(
      { ids: [ID], limit: 5, refresh: false },
      ctx as never,
    );
    await model.methods.extract.execute({ refresh: false }, ctx as never);
    const rs = store.get("extracted") as {
      rules: { id: string; figures: string[] }[];
    };
    assertEquals(
      rs.rules.map((r) => r.id),
      [`${ID}:hem`],
      "hallucinated tweet dropped",
    );
    assertEquals(rs.rules[0].figures, ["kabanchik"]);
    await model.methods.extract.execute({ refresh: false }, ctx as never);
    assertEquals(prompts.length, 1, "resume skips processed thread");
    await model.methods.advise.execute(
      {
        figure: "stocky",
        occasion: "any",
        includeExtracted: true,
        synthesize: true,
      },
      ctx as never,
    );
    const a = store.get("advice") as {
      narrative: string;
      rules: { id: string }[];
    };
    assertEquals(a.narrative, "Narrative.");
    assert(a.rules.some((r) => r.id === `${ID}:hem`));
    assert(prompts[1].includes("<corpus>"));
  } finally {
    restore();
  }
});

Deno.test("critique: keeps only known rule ids", async () => {
  const img = await Deno.makeTempFile({ suffix: ".jpg" });
  deps.runClaude = () =>
    Promise.resolve(
      '{"verdicts":[{"ruleId":"high-rise-trousers","status":"fail","note":"low rise"},{"ruleId":"bogus","status":"pass","note":""}],"summary":"s"}',
    );
  try {
    const { ctx, store } = makeCtx();
    await model.methods.critique.execute({
      imagePath: img,
      figure: "kabanchik",
      occasion: "any",
    }, ctx as never);
    const c = store.get("critique") as { verdicts: { ruleId: string }[] };
    assertEquals(c.verdicts.map((v) => v.ruleId), ["high-rise-trousers"]);
  } finally {
    restore();
    await Deno.remove(img);
  }
});
