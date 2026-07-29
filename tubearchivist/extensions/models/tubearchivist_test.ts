/**
 * Contract-fixture suite: pins the CONCRETE TubeArchivist API wire shape from
 * tubearchivist/fixtures/*.json directly, independent of tubearchivist.ts's
 * resource schemas (several of which use `.passthrough()` and would happily
 * accept a drifted shape). This suite hardcodes the expected field mapping
 * from the documented TubeArchivist REST API so a real wire-format drift
 * turns a test red (see STANDARD.md's contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made.
 *
 * tubearchivist.ts is BYTE-FROZEN by this change — every test characterizes
 * already-shipped behavior. It is not red-green TDD.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./tubearchivist.ts";
import videoList from "../../fixtures/video-list.json" with { type: "json" };
import videoDetail from "../../fixtures/video-detail.json" with {
  type: "json",
};
import channelList from "../../fixtures/channel-list.json" with {
  type: "json",
};
import queueList from "../../fixtures/queue-list.json" with { type: "json" };
import searchFixture from "../../fixtures/search.json" with { type: "json" };
import stats from "../../fixtures/stats.json" with { type: "json" };
import backupList from "../../fixtures/backup-list.json" with {
  type: "json",
};
import snapshotList from "../../fixtures/snapshot-list.json" with {
  type: "json",
};
import ping from "../../fixtures/ping.json" with { type: "json" };
import task from "../../fixtures/task.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  host: "https://tubearchivist.example.com",
  token: "ta_fixture_token_do_not_log",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

/** Install a fetch stub that returns `body` as a 200 JSON response for the
 * duration of `fn`. Uses the plan-mandated `as unknown as typeof
 * globalThis.fetch` bridge (not a direct `as typeof globalThis.fetch` cast) —
 * CI runs deno 2.8.3 while local dev may be on 2.7.x, and the direct cast
 * risks a CI-only deno-check break. */
function withFixture(body: unknown, fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as unknown as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// video-list.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: video-list.json — list-videos flattens each item to {youtube_id, title, channel_name, published, vid_type, active}", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(videoList, () => run("list-videos", {}, ctx));
  const res = written.find((w) => w.spec === "videos")!;
  const videos = res.payload.videos as Array<Record<string, unknown>>;
  assertEquals(videos.length, videoList.data.length);
  assertEquals(videos[0], {
    youtube_id: videoList.data[0].youtube_id,
    title: videoList.data[0].title,
    channel_name: videoList.data[0].channel.channel_name,
    published: videoList.data[0].published,
    vid_type: videoList.data[0].vid_type,
    active: videoList.data[0].active,
  });
});

Deno.test("contract: video-list.json — total/page come from data.paginate, not videos.length", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(videoList, () => run("list-videos", {}, ctx));
  const res = written.find((w) => w.spec === "videos")!;
  assertEquals(res.payload.total, videoList.paginate.total_hits);
  assertEquals(res.payload.page, videoList.paginate.current_page);
});

// ---------------------------------------------------------------------------
// video-detail.json contract — the documented NO-UNWRAP behavior
// ---------------------------------------------------------------------------

Deno.test("contract: video-detail.json — get-video does NOT unwrap a {data:...} envelope; the whole response becomes the video", async () => {
  // Pin: get-video's execute stores `[data]` directly, where `data` is the
  // raw parsed fetch response. video-detail.json is authored as the BARE
  // object the source consumes (see fixtures/PROVENANCE.md) — if this
  // fixture were wrapped in {data: {...}} like the list endpoints, this test
  // would be pinning a shape the code never produces.
  const { ctx, written } = makeCtx();
  await withFixture(
    videoDetail,
    () => run("get-video", { youtube_id: videoDetail.youtube_id }, ctx),
  );
  const res = written.find((w) => w.spec === "videos")!;
  const videos = res.payload.videos as unknown[];
  assertEquals(videos.length, 1);
  assertEquals(videos[0], videoDetail);
  assertEquals(res.payload.total, 1);
  assertEquals(res.payload.page, 0);
  assertEquals(res.name, videoDetail.youtube_id);
});

// ---------------------------------------------------------------------------
// channel-list.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: channel-list.json — list-channels flattens each item to {channel_id, channel_name, channel_subs, channel_subscribed}", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(channelList, () => run("list-channels", {}, ctx));
  const res = written.find((w) => w.spec === "channels")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  assertEquals(channels.length, channelList.data.length);
  assertEquals(channels[0], {
    channel_id: channelList.data[0].channel_id,
    channel_name: channelList.data[0].channel_name,
    channel_subs: channelList.data[0].channel_subs,
    channel_subscribed: channelList.data[0].channel_subscribed,
  });
  assertEquals(res.payload.total, channelList.paginate.total_hits);
});

Deno.test("contract: list-channels writes NO `page` field — asymmetric with list-videos", async () => {
  // Pin: unlike list-videos, the channels resource object omits `page`
  // entirely (tubearchivist.ts's list-channels writeResource call has no
  // page key at all). A "harmonizing" refactor that adds one must not slip
  // by unnoticed.
  const { ctx, written } = makeCtx();
  await withFixture(channelList, () => run("list-channels", {}, ctx));
  const res = written.find((w) => w.spec === "channels")!;
  assert(!("page" in res.payload), "list-channels resource has no page key");
});

// ---------------------------------------------------------------------------
// queue-list.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: queue-list.json — list-queue flattens each item to {youtube_id, status}", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(queueList, () => run("list-queue", {}, ctx));
  const res = written.find((w) => w.spec === "download")!;
  const items = res.payload.items as Array<Record<string, unknown>>;
  assertEquals(items.length, queueList.data.length);
  assertEquals(items[0], {
    youtube_id: queueList.data[0].youtube_id,
    status: queueList.data[0].status,
  });
  assertEquals(res.payload.total, queueList.paginate.total_hits);
  assertEquals(res.name, "queue-list");
});

// ---------------------------------------------------------------------------
// search.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: search.json — results pass through verbatim, total counts the array", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    searchFixture,
    () => run("search", { query: "keynote" }, ctx),
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, searchFixture.results);
  assertEquals(res.payload.total, searchFixture.results.length);
  assertEquals(res.payload.query, "keynote");
});

// ---------------------------------------------------------------------------
// stats.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: stats.json — every documented field is spread verbatim into the stats resource", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(stats, () => run("stats", {}, ctx));
  const res = written.find((w) => w.spec === "stats")!;
  assertEquals(res.payload.doc_count, stats.doc_count);
  assertEquals(res.payload.media_size, stats.media_size);
  assertEquals(res.payload.duration, stats.duration);
  assertEquals(res.payload.duration_str, stats.duration_str);
  assert(typeof res.payload.timestamp === "string");
});

// ---------------------------------------------------------------------------
// backup-list.json / snapshot-list.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: backup-list.json — list-backups reads backups from data.data", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(backupList, () => run("list-backups", {}, ctx));
  const res = written.find((w) => w.spec === "backup")!;
  assertEquals(res.payload.backups, backupList.data);
  assertEquals(res.name, "list");
});

Deno.test("contract: snapshot-list.json — list-snapshots reads snapshots from data.data", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(snapshotList, () => run("list-snapshots", {}, ctx));
  const res = written.find((w) => w.spec === "snapshot")!;
  assertEquals(res.payload.snapshots, snapshotList.data);
  assertEquals(res.name, "list");
});

// ---------------------------------------------------------------------------
// ping.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: ping.json — ping's message is JSON.stringify(data) verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(ping, () => run("ping", {}, ctx));
  const res = written.find((w) => w.spec === "task" && w.name === "ping")!;
  assertEquals(res.payload.message, JSON.stringify(ping));
  assertEquals(res.payload.task_id, "");
});

// ---------------------------------------------------------------------------
// task.json contract — the generic task-trigger envelope
// ---------------------------------------------------------------------------

Deno.test("contract: task.json — rescan pins task_id/message/status pass-through", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(task, () => run("rescan", {}, ctx));
  const res = written.find((w) => w.spec === "task" && w.name === "rescan")!;
  assertEquals(res.payload.task_id, task.task_id);
  assertEquals(res.payload.message, task.message);
  assertEquals(res.payload.status, task.status);
});

Deno.test("contract: task.json — refresh pins task_id/message/status pass-through", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(task, () => run("refresh", {}, ctx));
  const res = written.find((w) => w.spec === "task" && w.name === "refresh")!;
  assertEquals(res.payload.task_id, task.task_id);
  assertEquals(res.payload.message, task.message);
  assertEquals(res.payload.status, task.status);
});
