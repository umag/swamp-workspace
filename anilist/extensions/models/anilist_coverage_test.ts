/**
 * Coverage suite: regression tests closing gaps a code reviewer found — every
 * exported pure helper's guard/edge behavior, both sides of each branch.
 * Migrated verbatim (assertions unchanged) from the old `anilist.test.ts`
 * (deleted by this change — see CHANGELOG.md for the migration map and exact
 * before/after test counts), updated only to the standardized import
 * convention (`jsr:@std/assert@1` instead of the deprecated
 * `deno.land/std@0.224.0` URL import).
 *
 * Concrete EXAMPLE-based pins for compressRanges / mergeActivities /
 * buildRichMessage / formatActivityMessages live here (per the plan's test
 * strategy: "+ examples in coverage"); their fast-check GENERATIVE invariants
 * live in `anilist_property_test.ts`.
 *
 * anilist.ts is UNMODIFIED (byte-frozen) — every test here characterizes
 * already-shipped behavior; no new behavior is being driven out.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  advanceCursor,
  buildMetadataRow,
  buildRichMessage,
  buildScoreRows,
  collectMediaIds,
  compressRanges,
  escapeHtml,
  filterNewActivities,
  formatActivityMessages,
  formatDate,
  hasReachedOldActivities,
  isConsumptionActivity,
  isValidModelName,
  mergeActivities,
  parseUsernamesFile,
  TELEGRAM_MESSAGE_LIMIT,
} from "./anilist.ts";

// ---------- parseUsernamesFile ----------

Deno.test("parseUsernamesFile extracts usernames from anilist.co profile URLs", () => {
  const text = [
    "https://anilist.co/user/fixture_watcher/",
    "https://anilist.co/user/synth_traveler/",
    "https://anilist.co/user/testUserA",
  ].join("\n");
  const { accepted, rejected } = parseUsernamesFile(text);
  assertEquals(accepted, ["fixture_watcher", "synth_traveler", "testUserA"]);
  assertEquals(rejected, []);
});

Deno.test("parseUsernamesFile accepts bare usernames, skips blanks/comments, and surfaces malformed lines", () => {
  const text = [
    "",
    "# a comment",
    "testUserB",
    "https://anilist.co/user/testUserC/",
    "https://example.com/not-anilist",
    "   ",
  ].join("\n");
  const { accepted, rejected } = parseUsernamesFile(text);
  assertEquals(accepted, ["testUserB", "testUserC"]);
  assertEquals(rejected, [{
    line: 5,
    text: "https://example.com/not-anilist",
  }]);
});

Deno.test("parseUsernamesFile reports every rejected line with its 1-based number (no silent drops)", () => {
  const text = [
    "fixture_watcher", // 1 accepted
    "https://anilist.co/user/Foo/animelist", // 2 rejected: trailing path fails the URL regex
    "not a name", // 3 rejected: contains a space
    "synth_traveler", // 4 accepted
  ].join("\n");
  const { accepted, rejected } = parseUsernamesFile(text);
  assertEquals(accepted, ["fixture_watcher", "synth_traveler"]);
  assertEquals(rejected.map((r) => r.line), [2, 3]);
  assert(rejected.some((r) => r.text.includes("animelist")));
});

// ---------- isValidModelName ----------

Deno.test("isValidModelName accepts plain model names and rejects flag injection", () => {
  assert(isValidModelName("tg-bot"));
  assert(isValidModelName("tg_bot2"));
  assert(!isValidModelName(""));
  assert(!isValidModelName("--repo-dir"));
  assert(!isValidModelName("tg bot"));
  assert(!isValidModelName("tg;rm"));
});

// ---------- escapeHtml ----------

Deno.test("escapeHtml escapes ampersand, angle brackets", () => {
  assertEquals(
    escapeHtml("Steins;Gate <3 & more"),
    "Steins;Gate &lt;3 &amp; more",
  );
});

Deno.test("escapeHtml escapes double quotes (attribute context)", () => {
  assertEquals(escapeHtml('a"b'), "a&quot;b");
});

// ---------- filterNewActivities ----------

const act = (
  id: number,
  userName: string,
  createdAt: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  userName,
  userId: 1000 + userName.length,
  createdAt,
  status: "watched episode",
  progress: "5",
  mediaId: 90001,
  title: "Nebula Drifters",
  score: null as number | null,
  ...extra,
});

Deno.test("filterNewActivities keeps only activities newer than the user's cursor", () => {
  const cursor = {
    users: { fixture_watcher: { userId: 1, lastSeenActivityId: 100 } },
  };
  const acts = [
    act(101, "fixture_watcher", 2000),
    act(100, "fixture_watcher", 1500),
    act(99, "fixture_watcher", 1000),
  ];
  const kept = filterNewActivities(acts, cursor, 0);
  assertEquals(kept.map((a) => a.id), [101]);
});

Deno.test("filterNewActivities uses the lookback cutoff for users without a cursor entry", () => {
  const cursor = { users: {} };
  const acts = [act(5, "synth_traveler", 900), act(6, "synth_traveler", 1100)];
  const kept = filterNewActivities(acts, cursor, 1000);
  assertEquals(kept.map((a) => a.id), [6]);
});

Deno.test("filterNewActivities honours a pinned window floor for users that never delivered (failed-send retry)", () => {
  const cursor = {
    users: {
      synth_traveler: {
        userId: 2,
        lastSeenActivityId: 0,
        lastSeenCreatedAt: 800,
      },
    },
  };
  const kept = filterNewActivities(
    [act(5, "synth_traveler", 900)],
    cursor,
    1000,
  );
  assertEquals(kept.map((a) => a.id), [5]);
});

Deno.test("filterNewActivities isolates users: A's cursor never filters B", () => {
  const cursor = {
    users: { fixture_watcher: { userId: 1, lastSeenActivityId: 200 } },
  };
  const acts = [
    act(150, "fixture_watcher", 2000),
    act(150, "synth_traveler", 2000, { id: 151 }),
  ];
  const kept = filterNewActivities(acts, cursor, 1000);
  assertEquals(kept.map((a) => a.userName), ["synth_traveler"]);
});

// ---------- isConsumptionActivity ----------

Deno.test("isConsumptionActivity keeps watched/rewatched/completed/read and drops planning noise", () => {
  assert(isConsumptionActivity(act(1, "m", 1, { status: "watched episode" })));
  assert(
    isConsumptionActivity(act(1, "m", 1, { status: "rewatched episode" })),
  );
  assert(isConsumptionActivity(act(1, "m", 1, { status: "completed" })));
  assert(isConsumptionActivity(act(1, "m", 1, { status: "read chapter" })));
  assert(!isConsumptionActivity(act(1, "m", 1, { status: "plans to watch" })));
  assert(
    !isConsumptionActivity(act(1, "m", 1, { status: "paused watching" })),
  );
  assert(!isConsumptionActivity(act(1, "m", 1, { status: "dropped" })));
});

// ---------- hasReachedOldActivities (pagination stop condition) ----------

Deno.test("hasReachedOldActivities is false while the oldest page item may still be new", () => {
  const cursor = {
    users: { fixture_watcher: { userId: 1, lastSeenActivityId: 100 } },
  };
  const page = [
    act(200, "fixture_watcher", 3000),
    act(150, "fixture_watcher", 2500),
  ];
  assert(!hasReachedOldActivities(page, cursor, 1000));
});

Deno.test("hasReachedOldActivities is true when the oldest item is old for every user", () => {
  const cursor = {
    users: { fixture_watcher: { userId: 1, lastSeenActivityId: 100 } },
  };
  const page = [
    act(120, "fixture_watcher", 2000),
    act(90, "fixture_watcher", 500),
  ];
  assert(hasReachedOldActivities(page, cursor, 1000));
});

Deno.test("hasReachedOldActivities is true for an empty page", () => {
  assert(hasReachedOldActivities([], { users: {} }, 1000));
});

// ---------- advanceCursor ----------

Deno.test("advanceCursor moves each user's lastSeenActivityId to the max sent id", () => {
  const cursor = {
    users: { fixture_watcher: { userId: 1, lastSeenActivityId: 100 } },
  };
  const next = advanceCursor(cursor, [
    act(105, "fixture_watcher", 2000),
    act(110, "fixture_watcher", 2100),
    act(7, "synth_traveler", 2200, { userId: 2 }),
  ]);
  assertEquals(next.users.fixture_watcher.lastSeenActivityId, 110);
  assertEquals(next.users.fixture_watcher.userId, 1);
  assertEquals(next.users.synth_traveler.lastSeenActivityId, 7);
});

Deno.test("advanceCursor with no sent activities leaves the cursor unchanged (failed-send hold)", () => {
  const cursor = {
    users: { fixture_watcher: { userId: 1, lastSeenActivityId: 100 } },
  };
  const next = advanceCursor(cursor, []);
  assertEquals(next, cursor);
});

Deno.test("advanceCursor never moves a cursor backwards", () => {
  const cursor = {
    users: { fixture_watcher: { userId: 1, lastSeenActivityId: 100 } },
  };
  const next = advanceCursor(cursor, [act(90, "fixture_watcher", 100)]);
  assertEquals(next.users.fixture_watcher.lastSeenActivityId, 100);
});

// ---------- formatActivityMessages ----------

Deno.test("formatActivityMessages renders episode progress with score", () => {
  const [msg] = formatActivityMessages([
    act(1, "fixture_watcher", 1000, { progress: "5 - 7", score: 9 }),
  ]);
  assert(msg.includes("fixture_watcher"));
  assert(msg.includes("watched episode 5 - 7"));
  assert(msg.includes("Nebula Drifters"));
  assert(msg.includes("score 9"));
});

Deno.test("formatActivityMessages handles completed activities with null progress", () => {
  const [msg] = formatActivityMessages([
    act(1, "fixture_watcher", 1000, {
      status: "completed",
      progress: null,
      title: "Static Bloom",
      score: 10,
    }),
  ]);
  assert(msg.includes("completed"));
  assert(msg.includes("Static Bloom"));
  assert(!msg.includes("null"));
});

Deno.test("formatActivityMessages omits score when unset or zero", () => {
  const [msg] = formatActivityMessages([
    act(1, "fixture_watcher", 1000, { score: 0 }),
    act(2, "fixture_watcher", 1001, { score: null }),
  ]);
  assert(!msg.includes("score"));
});

Deno.test("formatActivityMessages HTML-escapes titles and usernames", () => {
  const [msg] = formatActivityMessages([
    act(1, "a<b>&c", 1000, { title: "Steins;Gate <3 & more" }),
  ]);
  assert(!msg.includes("<3"));
  assert(msg.includes("&lt;3"));
  assert(msg.includes("a&lt;b&gt;&amp;c"));
});

Deno.test("formatActivityMessages contains no emoji", () => {
  const [msg] = formatActivityMessages([act(1, "fixture_watcher", 1000)]);
  assert(/^[\x20-\x7E\n]*$/.test(msg), `non-ASCII content in: ${msg}`);
});

Deno.test("formatActivityMessages links titles to their AniList page", () => {
  const [msg] = formatActivityMessages([
    act(1, "fixture_watcher", 1000, {
      title: "Nebula Drifters",
      siteUrl: "https://anilist.co/anime/90001",
    }),
  ]);
  assert(
    msg.includes(
      '<a href="https://anilist.co/anime/90001">Nebula Drifters</a>',
    ),
  );
});

Deno.test("formatActivityMessages falls back to plain title without siteUrl", () => {
  const [msg] = formatActivityMessages([
    act(1, "fixture_watcher", 1000, {
      title: "Nebula Drifters",
      siteUrl: null,
    }),
  ]);
  assert(msg.includes("Nebula Drifters"));
  assert(!msg.includes("<a href"));
});

Deno.test("formatActivityMessages groups consecutive activities by user", () => {
  const [msg] = formatActivityMessages([
    act(1, "fixture_watcher", 1000, { title: "Nebula Drifters" }),
    act(2, "fixture_watcher", 1001, { title: "Static Bloom" }),
    act(3, "synth_traveler", 1002, { title: "Quiet Horizon" }),
  ]);
  assertEquals(msg.split("fixture_watcher").length - 1, 1);
});

Deno.test("formatActivityMessages chunks output at the Telegram limit", () => {
  const many = Array.from(
    { length: 400 },
    (_, i) =>
      act(i + 1, `user${i % 20}`, 1000 + i, {
        title: `A rather long anime title to inflate the message size ${i}`,
        score: 8,
      }),
  );
  const msgs = formatActivityMessages(many);
  assert(msgs.length > 1);
  for (const m of msgs) assert(m.length <= TELEGRAM_MESSAGE_LIMIT);
  const joined = msgs.join("\n");
  assert(joined.includes("size 0") && joined.includes("size 399"));
});

// ---------- compressRanges ----------

Deno.test("compressRanges collapses a contiguous run to a single range", () => {
  assertEquals(compressRanges([1, 2, 3]), "1-3");
  assertEquals(compressRanges([70, 71, 72, 73]), "70-73");
});

Deno.test("compressRanges renders a single number without a dash", () => {
  assertEquals(compressRanges([5]), "5");
});

Deno.test("compressRanges keeps gaps honest instead of inventing episodes", () => {
  assertEquals(compressRanges([1, 2, 3, 7]), "1-3, 7");
  assertEquals(compressRanges([1, 5]), "1, 5");
});

Deno.test("compressRanges dedupes and sorts unordered input", () => {
  assertEquals(compressRanges([3, 1, 2, 2, 1]), "1-3");
  assertEquals(compressRanges([]), "");
});

// ---------- mergeActivities ----------

Deno.test("mergeActivities collapses consecutive episodes into one ranged line", () => {
  const merged = mergeActivities([
    act(1, "fixture_watcher", 1000, {
      mediaId: 90003,
      title: "Quiet Horizon",
      progress: "1",
    }),
    act(2, "fixture_watcher", 1001, {
      mediaId: 90003,
      title: "Quiet Horizon",
      progress: "2",
    }),
    act(3, "fixture_watcher", 1002, {
      mediaId: 90003,
      title: "Quiet Horizon",
      progress: "3",
    }),
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].line, "watched episodes 1-3");
});

Deno.test("mergeActivities folds a completion into the show's progress line", () => {
  const merged = mergeActivities([
    act(1, "synth_traveler", 1000, {
      mediaId: 90002,
      title: "Static Bloom",
      progress: "1 - 12",
      score: 80,
    }),
    act(2, "synth_traveler", 1001, {
      mediaId: 90002,
      title: "Static Bloom",
      status: "completed",
      progress: null,
      score: 80,
    }),
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].line, "completed, episodes 1-12");
  assertEquals(merged[0].score, 80);
});

Deno.test("mergeActivities emits a bare 'completed' when there is no episode info", () => {
  const merged = mergeActivities([
    act(1, "testUserA", 1000, {
      mediaId: 90099,
      title: "Fixture Finale",
      status: "completed",
      progress: null,
      score: 60,
    }),
  ]);
  assertEquals(merged[0].line, "completed");
});

Deno.test("mergeActivities keeps a single episode singular", () => {
  const merged = mergeActivities([
    act(1, "fixture_watcher", 1000, {
      mediaId: 90001,
      title: "Nebula Drifters",
      progress: "5",
    }),
  ]);
  assertEquals(merged[0].line, "watched episode 5");
});

Deno.test("mergeActivities handles manga chapters with the right unit", () => {
  const merged = mergeActivities([
    act(1, "testUserB", 1000, {
      mediaId: 90002,
      title: "Static Bloom",
      status: "read chapter",
      progress: "70 - 71",
    }),
    act(2, "testUserB", 1001, {
      mediaId: 90002,
      title: "Static Bloom",
      status: "read chapter",
      progress: "72 - 73",
    }),
  ]);
  assertEquals(merged[0].line, "read chapters 70-73");
});

Deno.test("mergeActivities keeps different shows and users separate, in first-seen order", () => {
  const merged = mergeActivities([
    act(1, "fixture_watcher", 1000, {
      mediaId: 90001,
      title: "Nebula Drifters",
      progress: "5",
    }),
    act(2, "synth_traveler", 1001, {
      mediaId: 90003,
      title: "Quiet Horizon",
      progress: "1",
    }),
    act(3, "fixture_watcher", 1002, {
      mediaId: 90001,
      title: "Nebula Drifters",
      progress: "6",
    }),
  ]);
  assertEquals(merged.length, 2);
  assertEquals(merged[0].userName, "fixture_watcher");
  assertEquals(merged[0].line, "watched episodes 5-6");
  assertEquals(merged[1].userName, "synth_traveler");
});

Deno.test("mergeActivities does not mutate or reorder the caller's list (cursor safety)", () => {
  const input = [
    act(3, "fixture_watcher", 1002, { mediaId: 90001, progress: "6" }),
    act(1, "fixture_watcher", 1000, { mediaId: 90001, progress: "5" }),
  ];
  const before = input.map((a) => a.id);
  mergeActivities(input);
  assertEquals(input.map((a) => a.id), before);
});

// ---------- buildRichMessage ----------

const merged1 = () =>
  mergeActivities([
    act(1, "fixture_watcher", 1000, {
      mediaId: 90001,
      title: "Nebula Drifters",
      progress: "5",
      score: 7,
      siteUrl: "https://anilist.co/anime/90001",
    }),
  ]);

Deno.test("buildRichMessage links the title via a url node (not HTML)", () => {
  const rich = buildRichMessage(merged1()) as {
    blocks: Array<Record<string, unknown>>;
  };
  const json = JSON.stringify(rich);
  assert(json.includes('"type":"url"'));
  assert(json.includes("https://anilist.co/anime/90001"));
  assert(!json.includes("<a href"));
  assert(!json.includes("<b>"));
});

Deno.test("buildRichMessage bolds the username and shows the score", () => {
  const rich = buildRichMessage(merged1());
  const json = JSON.stringify(rich);
  assert(json.includes('"type":"bold"'));
  assert(json.includes("fixture_watcher"));
  assert(json.includes("score 7"));
});

Deno.test("buildRichMessage links the username to its AniList profile", () => {
  const rich = buildRichMessage(merged1());
  const json = JSON.stringify(rich);
  assert(json.includes("https://anilist.co/user/fixture_watcher"));
});

Deno.test("buildRichMessage never emits an image/photo block", () => {
  const rich = buildRichMessage(merged1()) as {
    blocks: Array<Record<string, unknown>>;
  };
  assert(!rich.blocks.some((b) => b.type === "photo"));
});

Deno.test("buildRichMessage opens with an 'AniList activity' header", () => {
  const rich = buildRichMessage(merged1()) as {
    blocks: Array<Record<string, unknown>>;
  };
  assertEquals(
    JSON.stringify(rich.blocks[0].text),
    JSON.stringify({ type: "bold", text: "AniList activity" }),
  );
});

Deno.test("buildRichMessage groups a user's shows under one linked heading (no orphaned lines)", () => {
  const merged = mergeActivities([
    act(1, "testUserA", 1000, {
      mediaId: 90001,
      title: "Nebula Drifters",
      progress: "23",
    }),
    act(2, "testUserA", 1001, {
      mediaId: 90002,
      title: "Static Bloom",
      progress: "15",
    }),
    act(3, "testUserA", 1002, {
      mediaId: 90003,
      title: "Quiet Horizon",
      progress: "1",
    }),
    act(4, "testUserA", 1003, {
      mediaId: 90003,
      title: "Quiet Horizon",
      progress: "2",
    }),
    act(5, "testUserA", 1004, {
      mediaId: 90003,
      title: "Quiet Horizon",
      progress: "3",
    }),
  ]);
  const rich = buildRichMessage(merged) as {
    blocks: Array<Record<string, unknown>>;
  };
  assertEquals(rich.blocks.map((b) => b.type), [
    "paragraph",
    "paragraph",
    "footer",
  ]);
  const userPara = JSON.stringify(rich.blocks[1]);
  assert(userPara.includes("https://anilist.co/user/testUserA"));
  assert(userPara.includes("watched episode 23"));
  assert(userPara.includes("completed") || userPara.includes("episode 15"));
  assert(userPara.includes("watched episodes 1-3"));
  assertEquals(userPara.split("\\n• ").length - 1, 3);
});

Deno.test("buildRichMessage gives each user their own paragraph", () => {
  const rich = buildRichMessage(
    mergeActivities([
      act(1, "fixture_watcher", 1000, {
        mediaId: 90001,
        title: "A",
        progress: "1",
      }),
      act(2, "synth_traveler", 1001, {
        mediaId: 90002,
        title: "B",
        progress: "1",
      }),
    ]),
  ) as { blocks: Array<Record<string, unknown>> };
  assertEquals(rich.blocks.length, 4);
  assert(JSON.stringify(rich.blocks[1]).includes("fixture_watcher"));
  assert(JSON.stringify(rich.blocks[2]).includes("synth_traveler"));
});

Deno.test("buildRichMessage ends with a footer summarising users and titles", () => {
  const rich = buildRichMessage(
    mergeActivities([
      act(1, "fixture_watcher", 1000, {
        mediaId: 90001,
        title: "A",
        progress: "1",
      }),
      act(2, "synth_traveler", 1001, {
        mediaId: 90002,
        title: "B",
        progress: "1",
      }),
    ]),
  ) as { blocks: Array<Record<string, unknown>> };
  const footer = rich.blocks[rich.blocks.length - 1] as {
    type: string;
    text: string;
  };
  assertEquals(footer.type, "footer");
  assertEquals(footer.text, "2 users · 2 titles");
});

Deno.test("buildRichMessage contains no emoji", () => {
  const rich = buildRichMessage(merged1());
  assert(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(JSON.stringify(rich)));
});

// ---------- buildScoreRows ----------

Deno.test("buildScoreRows keeps score 0 (ReplacingMergeTree tombstone) and drops null/out-of-range", () => {
  const rows = buildScoreRows("fixture_watcher", [
    { mediaId: 90001, score: 0 },
    { mediaId: 90002, score: 8.5 },
    { mediaId: 90003, score: null },
    { mediaId: 90004, score: 11 },
    { mediaId: 90005, score: -1 },
    { mediaId: 90006 }, // missing score
  ]);
  assertEquals(rows, [
    { user_name: "fixture_watcher", media_id: 90001, score: 0 },
    { user_name: "fixture_watcher", media_id: 90002, score: 8.5 },
  ]);
});

Deno.test("buildScoreRows preserves the file's exact username casing (never lowercased, never canonicalised)", () => {
  const rows = buildScoreRows("MixedCaseFixtureUser", [{
    mediaId: 90001,
    score: 7,
  }]);
  assertEquals(rows[0].user_name, "MixedCaseFixtureUser");
});

// ---------- collectMediaIds ----------

Deno.test("collectMediaIds gathers all media ids regardless of score, deduped", () => {
  const ids = collectMediaIds([
    { mediaId: 90001, score: 0 },
    { mediaId: 90002, score: null },
    { mediaId: 90001, score: 9 }, // dup
    {}, // no id
  ]);
  assertEquals(ids.slice().sort((a, b) => a - b), [90001, 90002]);
});

// ---------- formatDate ----------

Deno.test("formatDate returns YYYY-MM-DD for a real date, null for malformed/impossible/pre-1970", () => {
  assertEquals(formatDate({ year: 2023, month: 9, day: 29 }), "2023-09-29");
  assertEquals(formatDate({ year: 2023, month: 13, day: 40 }), null);
  assertEquals(formatDate({ year: 2023, month: 2, day: 30 }), null);
  assertEquals(formatDate({ year: 2023, month: 5, day: null }), null);
  assertEquals(formatDate({ year: 1969, month: 12, day: 31 }), null);
  assertEquals(formatDate(null), null);
});

// ---------- buildMetadataRow ----------

Deno.test("buildMetadataRow nulls a malformed start_date but still populates start_year, and coerces tag spoiler to 0/1", () => {
  const row = buildMetadataRow({
    id: 42,
    title: { romaji: "R", english: null, native: "N" },
    genres: ["Action"],
    tags: [{ name: "Isekai", rank: 80, isMediaSpoiler: true }],
    startDate: { year: 2020, month: 13, day: 40 }, // malformed
    endDate: null,
    format: "TV",
    status: "FINISHED",
    episodes: 12,
    duration: 24,
    averageScore: 77,
    popularity: 12345,
    studios: { nodes: [{ name: "Fixture Animation Works" }] },
    coverImage: { large: "http://fixtures.example/img" },
  });
  assertEquals(row.start_year, 2020);
  assertEquals(row.start_date, null);
  assertEquals(row.tags, [{ name: "Isekai", rank: 80, isMediaSpoiler: 1 }]);
  assertEquals(row.studios, ["Fixture Animation Works"]);
  assertEquals(row.media_id, 42);
});

Deno.test("buildMetadataRow: absent studios/tags/coverImage default to empty/null, no crash", () => {
  const row = buildMetadataRow({ id: 1 });
  assertEquals(row.studios, []);
  assertEquals(row.tags, []);
  assertEquals(row.cover_image_large, null);
  assertEquals(row.genres, []);
  assertEquals(row.title_romaji, null);
});
