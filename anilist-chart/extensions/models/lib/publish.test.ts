import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  PAGE_FILES,
  type PublishPage,
  publishPages,
  remoteWriteCommand,
} from "./publish.ts";

Deno.test("PAGE_FILES maps all seven render keys to servable filenames", () => {
  const keys = Object.keys(PAGE_FILES).sort();
  assertEquals(keys, [
    "bayes",
    "bayes-json",
    "board",
    "chart",
    "current",
    "fresh",
    "landing",
  ]);
  // the bayes sidecar is JSON, every other page is HTML
  assertEquals(PAGE_FILES["bayes-json"], "genre_chart_bayesian.json");
  for (const [k, f] of Object.entries(PAGE_FILES)) {
    if (k !== "bayes-json") assert(f.endsWith(".html"), `${k} -> ${f}`);
  }
});

Deno.test("remoteWriteCommand is atomic (temp then rename) and quotes the dir", () => {
  const cmd = remoteWriteCommand("/srv/out", "board.html");
  assertEquals(
    cmd,
    "cat > '/srv/out/.board.html.tmp' && " +
      "mv -f '/srv/out/.board.html.tmp' '/srv/out/board.html'",
  );
});

Deno.test("publishPages: all pages written", async () => {
  const written: Record<string, string> = {};
  const pages: PublishPage[] = [
    { key: "board", content: "<board>" },
    { key: "landing", content: "<landing>" },
  ];
  const res = await publishPages(pages, (file, content) => {
    written[file] = content;
    return Promise.resolve();
  });
  assertEquals(res.published.sort(), ["board", "landing"]);
  assertEquals(res.failed, []);
  assertEquals(written["board.html"], "<board>");
  assertEquals(written["landing.html"], "<landing>");
});

Deno.test("publishPages: one page failing never suppresses the rest", async () => {
  const pages: PublishPage[] = [
    { key: "board", content: "a" },
    { key: "bayes", content: "b" },
    { key: "landing", content: "c" },
  ];
  const res = await publishPages(pages, (file) => {
    if (file === "genre_chart_bayesian.html") {
      return Promise.reject(new Error("ssh: connection refused"));
    }
    return Promise.resolve();
  });
  // board and landing still published; only bayes failed
  assertEquals(res.published.sort(), ["board", "landing"]);
  assertEquals(res.failed.length, 1);
  assertEquals(res.failed[0].key, "bayes");
  assert(res.failed[0].error.includes("connection refused"));
});

Deno.test("publishPages: an unmapped key is skipped, not written to a stray file", async () => {
  let calls = 0;
  const res = await publishPages(
    [{ key: "not-a-page", content: "x" }],
    () => {
      calls++;
      return Promise.resolve();
    },
  );
  assertEquals(calls, 0);
  assertEquals(res.published, []);
  assertEquals(res.skipped, ["not-a-page"]);
});
