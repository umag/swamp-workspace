// Deno tests for the @anilist/api recent-activity helpers.
// Run: deno test extensions/models/anilist.test.ts
//
// These cover the deterministic logic: usernames-file parsing, cursor-based
// activity dedupe (incl. the pagination stop condition), cursor advancement
// policy (only confirmed-sent activities advance it), Telegram message
// formatting (HTML escaping, null progress, score omission, 4096 chunking),
// and model-name validation for the swamp CLI subprocess. Live GraphQL and
// resource IO are exercised by the staged dryRun/live verification runs.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
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
  LIST_INGEST_QUERY,
  mergeActivities,
  METADATA_INGEST_QUERY,
  model,
  parseUsernamesFile,
  TELEGRAM_MESSAGE_LIMIT,
  USERLIST_QUERY,
} from "./anilist.ts";

// ---------- parseUsernamesFile ----------

Deno.test("parseUsernamesFile extracts usernames from anilist.co profile URLs", () => {
  const text = [
    "https://anilist.co/user/Magistr/",
    "https://anilist.co/user/akemiv/",
    "https://anilist.co/user/rn144mg",
  ].join("\n");
  const { accepted, rejected } = parseUsernamesFile(text);
  assertEquals(accepted, ["Magistr", "akemiv", "rn144mg"]);
  assertEquals(rejected, []);
});

Deno.test("parseUsernamesFile accepts bare usernames, skips blanks/comments, and surfaces malformed lines", () => {
  const text = [
    "",
    "# a comment",
    "Seiya",
    "https://anilist.co/user/InFar/",
    "https://example.com/not-anilist",
    "   ",
  ].join("\n");
  const { accepted, rejected } = parseUsernamesFile(text);
  assertEquals(accepted, ["Seiya", "InFar"]);
  // The non-AniList URL is now reported (with its 1-based line number),
  // never silently dropped.
  assertEquals(rejected, [{
    line: 5,
    text: "https://example.com/not-anilist",
  }]);
});

Deno.test("parseUsernamesFile reports every rejected line with its 1-based number (no silent drops)", () => {
  const text = [
    "Magistr", // 1 accepted
    "https://anilist.co/user/Foo/animelist", // 2 rejected: trailing path fails the URL regex
    "not a name", // 3 rejected: contains a space
    "akemiv", // 4 accepted
  ].join("\n");
  const { accepted, rejected } = parseUsernamesFile(text);
  assertEquals(accepted, ["Magistr", "akemiv"]);
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
  mediaId: 1,
  title: "Frieren",
  score: null as number | null,
  ...extra,
});

Deno.test("filterNewActivities keeps only activities newer than the user's cursor", () => {
  const cursor = { users: { magistr: { userId: 1, lastSeenActivityId: 100 } } };
  const acts = [
    act(101, "Magistr", 2000),
    act(100, "Magistr", 1500),
    act(99, "Magistr", 1000),
  ];
  const kept = filterNewActivities(acts, cursor, 0);
  assertEquals(kept.map((a) => a.id), [101]);
});

Deno.test("filterNewActivities uses the lookback cutoff for users without a cursor entry", () => {
  const cursor = { users: {} };
  const acts = [act(5, "akemiv", 900), act(6, "akemiv", 1100)];
  const kept = filterNewActivities(acts, cursor, 1000);
  assertEquals(kept.map((a) => a.id), [6]);
});

Deno.test("filterNewActivities honours a pinned window floor for users that never delivered (failed-send retry)", () => {
  // A send failed at a run whose lookback cutoff was 800; the entry pinned
  // that floor. The next run's relative cutoff (1000) must NOT hide the
  // still-undelivered activity from 900.
  const cursor = {
    users: {
      akemiv: { userId: 2, lastSeenActivityId: 0, lastSeenCreatedAt: 800 },
    },
  };
  const kept = filterNewActivities([act(5, "akemiv", 900)], cursor, 1000);
  assertEquals(kept.map((a) => a.id), [5]);
});

Deno.test("filterNewActivities isolates users: A's cursor never filters B", () => {
  const cursor = { users: { magistr: { userId: 1, lastSeenActivityId: 200 } } };
  const acts = [
    act(150, "Magistr", 2000),
    act(150, "akemiv", 2000, { id: 151 }),
  ];
  const kept = filterNewActivities(acts, cursor, 1000);
  assertEquals(kept.map((a) => a.userName), ["akemiv"]);
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
  const cursor = { users: { magistr: { userId: 1, lastSeenActivityId: 100 } } };
  // oldest item id 150 > lastSeen 100 → more new items may follow on the next page
  const page = [act(200, "Magistr", 3000), act(150, "Magistr", 2500)];
  assert(!hasReachedOldActivities(page, cursor, 1000));
});

Deno.test("hasReachedOldActivities is true when the oldest item is old for every user", () => {
  const cursor = { users: { magistr: { userId: 1, lastSeenActivityId: 100 } } };
  // oldest id 90 < lastSeen 100 AND createdAt 500 < cutoff 1000 → stop
  const page = [act(120, "Magistr", 2000), act(90, "Magistr", 500)];
  assert(hasReachedOldActivities(page, cursor, 1000));
});

Deno.test("hasReachedOldActivities is true for an empty page", () => {
  assert(hasReachedOldActivities([], { users: {} }, 1000));
});

// ---------- advanceCursor ----------

Deno.test("advanceCursor moves each user's lastSeenActivityId to the max sent id", () => {
  const cursor = { users: { magistr: { userId: 1, lastSeenActivityId: 100 } } };
  const next = advanceCursor(cursor, [
    act(105, "Magistr", 2000),
    act(110, "Magistr", 2100),
    act(7, "akemiv", 2200, { userId: 2 }),
  ]);
  assertEquals(next.users.magistr.lastSeenActivityId, 110);
  assertEquals(next.users.magistr.userId, 1);
  assertEquals(next.users.akemiv.lastSeenActivityId, 7);
});

Deno.test("advanceCursor with no sent activities leaves the cursor unchanged (failed-send hold)", () => {
  const cursor = { users: { magistr: { userId: 1, lastSeenActivityId: 100 } } };
  const next = advanceCursor(cursor, []);
  assertEquals(next, cursor);
});

Deno.test("advanceCursor never moves a cursor backwards", () => {
  const cursor = { users: { magistr: { userId: 1, lastSeenActivityId: 100 } } };
  const next = advanceCursor(cursor, [act(90, "Magistr", 100)]);
  assertEquals(next.users.magistr.lastSeenActivityId, 100);
});

// ---------- formatActivityMessages ----------

Deno.test("formatActivityMessages renders episode progress with score", () => {
  const [msg] = formatActivityMessages([
    act(1, "Magistr", 1000, { progress: "5 - 7", score: 9 }),
  ]);
  assert(msg.includes("Magistr"));
  assert(msg.includes("watched episode 5 - 7"));
  assert(msg.includes("Frieren"));
  assert(msg.includes("score 9"));
});

Deno.test("formatActivityMessages handles completed activities with null progress", () => {
  const [msg] = formatActivityMessages([
    act(1, "Magistr", 1000, {
      status: "completed",
      progress: null,
      title: "Planetes",
      score: 10,
    }),
  ]);
  assert(msg.includes("completed"));
  assert(msg.includes("Planetes"));
  assert(!msg.includes("null"));
});

Deno.test("formatActivityMessages omits score when unset or zero", () => {
  const [msg] = formatActivityMessages([
    act(1, "Magistr", 1000, { score: 0 }),
    act(2, "Magistr", 1001, { score: null }),
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
  const [msg] = formatActivityMessages([act(1, "Magistr", 1000)]);
  assert(/^[\x20-\x7E\n]*$/.test(msg), `non-ASCII content in: ${msg}`);
});

Deno.test("formatActivityMessages links titles to their AniList page", () => {
  const [msg] = formatActivityMessages([
    act(1, "Magistr", 1000, {
      title: "Frieren",
      siteUrl: "https://anilist.co/anime/154587",
    }),
  ]);
  assert(msg.includes('<a href="https://anilist.co/anime/154587">Frieren</a>'));
});

Deno.test("formatActivityMessages falls back to plain title without siteUrl", () => {
  const [msg] = formatActivityMessages([
    act(1, "Magistr", 1000, { title: "Frieren", siteUrl: null }),
  ]);
  assert(msg.includes("Frieren"));
  assert(!msg.includes("<a href"));
});

Deno.test("formatActivityMessages groups consecutive activities by user", () => {
  const [msg] = formatActivityMessages([
    act(1, "Magistr", 1000, { title: "Frieren" }),
    act(2, "Magistr", 1001, { title: "Planetes" }),
    act(3, "akemiv", 1002, { title: "Lazarus" }),
  ]);
  // one user header per user, not per activity
  assertEquals(msg.split("Magistr").length - 1, 1);
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
  // no content lost: every title index appears in exactly one chunk
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
    act(1, "Magistr", 1000, { mediaId: 9, title: "BanG Dream", progress: "1" }),
    act(2, "Magistr", 1001, { mediaId: 9, title: "BanG Dream", progress: "2" }),
    act(3, "Magistr", 1002, { mediaId: 9, title: "BanG Dream", progress: "3" }),
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].line, "watched episodes 1-3");
});

Deno.test("mergeActivities folds a completion into the show's progress line", () => {
  const merged = mergeActivities([
    act(1, "maho", 1000, {
      mediaId: 4,
      title: "Watashi",
      progress: "1 - 12",
      score: 80,
    }),
    act(2, "maho", 1001, {
      mediaId: 4,
      title: "Watashi",
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
    act(1, "dd", 1000, {
      mediaId: 7,
      title: "Code Geass",
      status: "completed",
      progress: null,
      score: 60,
    }),
  ]);
  assertEquals(merged[0].line, "completed");
});

Deno.test("mergeActivities keeps a single episode singular", () => {
  const merged = mergeActivities([
    act(1, "Magistr", 1000, { mediaId: 1, title: "Frieren", progress: "5" }),
  ]);
  assertEquals(merged[0].line, "watched episode 5");
});

Deno.test("mergeActivities handles manga chapters with the right unit", () => {
  const merged = mergeActivities([
    act(1, "stak", 1000, {
      mediaId: 3,
      title: "Kage",
      status: "read chapter",
      progress: "70 - 71",
    }),
    act(2, "stak", 1001, {
      mediaId: 3,
      title: "Kage",
      status: "read chapter",
      progress: "72 - 73",
    }),
  ]);
  assertEquals(merged[0].line, "read chapters 70-73");
});

Deno.test("mergeActivities keeps different shows and users separate, in first-seen order", () => {
  const merged = mergeActivities([
    act(1, "Magistr", 1000, { mediaId: 1, title: "Frieren", progress: "5" }),
    act(2, "akemiv", 1001, { mediaId: 2, title: "Grand Blue", progress: "1" }),
    act(3, "Magistr", 1002, { mediaId: 1, title: "Frieren", progress: "6" }),
  ]);
  assertEquals(merged.length, 2);
  assertEquals(merged[0].userName, "Magistr");
  assertEquals(merged[0].line, "watched episodes 5-6");
  assertEquals(merged[1].userName, "akemiv");
});

Deno.test("mergeActivities does not mutate or reorder the caller's list (cursor safety)", () => {
  const input = [
    act(3, "Magistr", 1002, { mediaId: 1, progress: "6" }),
    act(1, "Magistr", 1000, { mediaId: 1, progress: "5" }),
  ];
  const before = input.map((a) => a.id);
  mergeActivities(input);
  assertEquals(input.map((a) => a.id), before);
});

// ---------- buildRichMessage ----------

const merged1 = () =>
  mergeActivities([
    act(1, "Magistr", 1000, {
      mediaId: 1,
      title: "Frieren",
      progress: "5",
      score: 7,
      siteUrl: "https://anilist.co/anime/1",
    }),
  ]);

Deno.test("buildRichMessage links the title via a url node (not HTML)", () => {
  const rich = buildRichMessage(merged1()) as {
    blocks: Array<Record<string, unknown>>;
  };
  const json = JSON.stringify(rich);
  // url node carries the link; no HTML anchor leaks into block text
  assert(json.includes('"type":"url"'));
  assert(json.includes("https://anilist.co/anime/1"));
  assert(!json.includes("<a href"));
  assert(!json.includes("<b>"));
});

Deno.test("buildRichMessage bolds the username and shows the score", () => {
  const rich = buildRichMessage(merged1());
  const json = JSON.stringify(rich);
  assert(json.includes('"type":"bold"'));
  assert(json.includes("Magistr"));
  assert(json.includes("score 7"));
});

Deno.test("buildRichMessage links the username to its AniList profile", () => {
  const rich = buildRichMessage(merged1());
  const json = JSON.stringify(rich);
  assert(json.includes("https://anilist.co/user/Magistr"));
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
    JSON.stringify({
      type: "bold",
      text: "AniList activity",
    }),
  );
});

Deno.test("buildRichMessage groups a user's shows under one linked heading (no orphaned lines)", () => {
  // Xyanide watches three shows: one grouped paragraph, all lines under the
  // single linked username — nothing is orphaned.
  const merged = mergeActivities([
    act(1, "Xyanide", 1000, { mediaId: 1, title: "Precure", progress: "23" }),
    act(2, "Xyanide", 1001, { mediaId: 2, title: "Youjitsu", progress: "15" }),
    act(3, "Xyanide", 1002, { mediaId: 3, title: "BanG Dream", progress: "1" }),
    act(4, "Xyanide", 1003, { mediaId: 3, title: "BanG Dream", progress: "2" }),
    act(5, "Xyanide", 1004, { mediaId: 3, title: "BanG Dream", progress: "3" }),
  ]);
  const rich = buildRichMessage(merged) as {
    blocks: Array<Record<string, unknown>>;
  };
  // header + one user paragraph + footer
  assertEquals(rich.blocks.map((b) => b.type), [
    "paragraph",
    "paragraph",
    "footer",
  ]);
  const userPara = JSON.stringify(rich.blocks[1]);
  assert(userPara.includes("https://anilist.co/user/Xyanide"));
  // all three shows live in that one paragraph
  assert(userPara.includes("watched episode 23"));
  assert(userPara.includes("completed") || userPara.includes("episode 15"));
  assert(userPara.includes("watched episodes 1-3"));
  // three bulleted lines
  assertEquals(userPara.split("\\n• ").length - 1, 3);
});

Deno.test("buildRichMessage gives each user their own paragraph", () => {
  const rich = buildRichMessage(
    mergeActivities([
      act(1, "Magistr", 1000, { mediaId: 1, title: "A", progress: "1" }),
      act(2, "akemiv", 1001, { mediaId: 2, title: "B", progress: "1" }),
    ]),
  ) as { blocks: Array<Record<string, unknown>> };
  // header + 2 user paragraphs + footer
  assertEquals(rich.blocks.length, 4);
  assert(JSON.stringify(rich.blocks[1]).includes("Magistr"));
  assert(JSON.stringify(rich.blocks[2]).includes("akemiv"));
});

Deno.test("buildRichMessage ends with a footer summarising users and titles", () => {
  const rich = buildRichMessage(
    mergeActivities([
      act(1, "Magistr", 1000, { mediaId: 1, title: "A", progress: "1" }),
      act(2, "akemiv", 1001, { mediaId: 2, title: "B", progress: "1" }),
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

// ===========================================================================
// INGEST side (charting pipeline): steps 1-4
// ===========================================================================

// ---------- Step 1: ingest query consts anchored to the 17-column schema ----

Deno.test("LIST_INGEST_QUERY selects the decimal score + status over MediaListCollection chunks", () => {
  // The per-user scored-list ingest query — decimal score lives ONLY here.
  assert(LIST_INGEST_QUERY.includes("score(format:"));
  assert(LIST_INGEST_QUERY.includes("POINT_10_DECIMAL"));
  assert(LIST_INGEST_QUERY.includes("MediaListCollection"));
  assert(LIST_INGEST_QUERY.includes("status_in"));
  assert(LIST_INGEST_QUERY.includes("chunk"));
  assert(LIST_INGEST_QUERY.includes("perChunk"));
  assert(LIST_INGEST_QUERY.includes("hasNextChunk"));
  assert(LIST_INGEST_QUERY.includes("mediaId"));
});

Deno.test("USERLIST_QUERY (notifier/userlist) keeps a bare score, never the ingest decimal format", () => {
  assert(!USERLIST_QUERY.includes("score(format:"));
  assert(/\bscore\b/.test(USERLIST_QUERY));
});

Deno.test("METADATA_INGEST_QUERY covers every anilist_metadata source field (17 columns)", () => {
  const q = METADATA_INGEST_QUERY;
  // start_year + start_date both fan out from the single startDate field.
  for (
    const field of [
      "id",
      "romaji",
      "english",
      "native",
      "genres",
      "tags",
      "name",
      "rank",
      "isMediaSpoiler",
      "startDate",
      "endDate",
      "format",
      "status",
      "episodes",
      "duration",
      "averageScore",
      "popularity",
      "studios",
      "coverImage",
      "large",
    ]
  ) {
    assert(q.includes(field), `metadata query missing source field: ${field}`);
  }
  // Decimal-format score belongs to the list-ingest query only.
  assert(!q.includes("score(format:"));
});

// ---------- Step 3: score-row + metadata-row transforms (pure) --------------

Deno.test("buildScoreRows keeps score 0 (ReplacingMergeTree tombstone) and drops null/out-of-range", () => {
  const rows = buildScoreRows("Magistr", [
    { mediaId: 1, score: 0 },
    { mediaId: 2, score: 8.5 },
    { mediaId: 3, score: null },
    { mediaId: 4, score: 11 },
    { mediaId: 5, score: -1 },
    { mediaId: 6 }, // missing score
  ]);
  assertEquals(rows, [
    { user_name: "Magistr", media_id: 1, score: 0 },
    { user_name: "Magistr", media_id: 2, score: 8.5 },
  ]);
});

Deno.test("buildScoreRows preserves the file's exact username casing (never lowercased, never canonicalised)", () => {
  const rows = buildScoreRows("MixedCaseUser", [{ mediaId: 1, score: 7 }]);
  assertEquals(rows[0].user_name, "MixedCaseUser");
});

Deno.test("collectMediaIds gathers all media ids regardless of score, deduped", () => {
  const ids = collectMediaIds([
    { mediaId: 1, score: 0 },
    { mediaId: 2, score: null },
    { mediaId: 1, score: 9 }, // dup
    {}, // no id
  ]);
  assertEquals(ids.slice().sort((a, b) => a - b), [1, 2]);
});

Deno.test("formatDate returns YYYY-MM-DD for a real date, null for malformed/impossible/pre-1970", () => {
  assertEquals(formatDate({ year: 2023, month: 9, day: 29 }), "2023-09-29");
  assertEquals(formatDate({ year: 2023, month: 13, day: 40 }), null); // components OOR
  assertEquals(formatDate({ year: 2023, month: 2, day: 30 }), null); // not a calendar date
  assertEquals(formatDate({ year: 2023, month: 5, day: null }), null); // missing day
  assertEquals(formatDate({ year: 1969, month: 12, day: 31 }), null); // below CH Date floor
  assertEquals(formatDate(null), null);
});

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
    studios: { nodes: [{ name: "Studio X" }] },
    coverImage: { large: "http://img" },
  });
  assertEquals(row.start_year, 2020);
  assertEquals(row.start_date, null);
  assertEquals(row.tags, [{ name: "Isekai", rank: 80, isMediaSpoiler: 1 }]);
  assertEquals(row.studios, ["Studio X"]);
  assertEquals(row.media_id, 42);
});

// ---------- Step 3: ingest-scores fan-out end-to-end (fetch stubbed) --------

Deno.test({
  name:
    "ingest-scores keeps score 0, drops invalid, preserves casing, nulls a bad start_date (end-to-end)",
  // gql()/clickhouseInsert schedule AbortSignal.timeout timers that the stub
  // never lets settle; they are harmless here.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const chInserts: { table: string; rows: Record<string, unknown>[] }[] = [];
    const origFetch = globalThis.fetch;
    const stub = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;

      if (url.startsWith("https://graphql.anilist.co")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          query: string;
        };
        if (body.query.includes("hasNextChunk")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  MediaListCollection: {
                    lists: [{
                      status: "COMPLETED",
                      entries: [
                        { mediaId: 1, score: 0, status: "COMPLETED" },
                        { mediaId: 2, score: 8.5, status: "COMPLETED" },
                        { mediaId: 3, score: null, status: "CURRENT" },
                        { mediaId: 4, score: 11, status: "COMPLETED" },
                      ],
                    }],
                    hasNextChunk: false,
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        // metadata id_in query
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                Page: {
                  pageInfo: { hasNextPage: false },
                  media: [
                    {
                      id: 1,
                      title: { romaji: "A", english: null, native: null },
                      genres: [],
                      tags: [],
                      startDate: { year: 2020, month: 13, day: 40 }, // malformed
                      endDate: null,
                      format: "TV",
                      status: "FINISHED",
                      episodes: 12,
                      duration: 24,
                      averageScore: 70,
                      popularity: 100,
                      studios: { nodes: [] },
                      coverImage: { large: null },
                    },
                    {
                      id: 2,
                      title: { romaji: "B", english: null, native: null },
                      genres: [],
                      tags: [],
                      startDate: { year: 2021, month: 1, day: 5 },
                      endDate: null,
                      format: "TV",
                      status: "FINISHED",
                      episodes: 24,
                      duration: 24,
                      averageScore: 80,
                      popularity: 200,
                      studios: { nodes: [] },
                      coverImage: { large: null },
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      // ClickHouse HTTP insert
      const u = new URL(url);
      const query = u.searchParams.get("query") ?? "";
      const table = /INSERT INTO \S+\.(\w+)/.exec(query)?.[1] ?? "?";
      const rows = String(init?.body ?? "")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      chInserts.push({ table, rows });
      // named-tuple setting must be pinned on the metadata insert
      if (table === "anilist_metadata") {
        assert(
          u.searchParams.get("input_format_json_named_tuples_as_objects") ===
            "1",
          "metadata insert must pin input_format_json_named_tuples_as_objects=1",
        );
      }
      return Promise.resolve(new Response("", { status: 200 }));
    };
    globalThis.fetch = stub as typeof fetch;

    try {
      const writes: { spec: string; key: string }[] = [];
      const ctx = {
        globalArgs: {
          mediaType: "ANIME" as const,
          clickhouseUrl: "http://ch:8123",
          clickhouseDatabase: "default",
          clickhouseUser: "default",
        },
        writeResource: (spec: string, key: string, _v: unknown) => {
          writes.push({ spec, key });
          return Promise.resolve({ spec, key });
        },
      };
      await model.methods["ingest-scores"].execute(
        {
          usernames: ["Magistr"],
          perChunk: 500,
          maxChunks: 20,
          metadataBatchSize: 50,
        },
        ctx,
      );

      const scoreInsert = chInserts.find((c) => c.table === "user_scores");
      assert(scoreInsert, "expected a user_scores insert");
      // score 0 kept, 8.5 kept; null + 11 dropped
      assertEquals(
        scoreInsert!.rows.map((r) => r.media_id).sort((a, b) =>
          (a as number) - (b as number)
        ),
        [1, 2],
      );
      assertEquals(
        scoreInsert!.rows.find((r) => r.media_id === 1)!.score,
        0,
      );
      // last_updated omitted so DDL DEFAULT now() fires
      for (const r of scoreInsert!.rows) {
        assertEquals(r.user_name, "Magistr"); // casing preserved verbatim
        assert(!("last_updated" in r));
      }

      const metaInsert = chInserts.find((c) => c.table === "anilist_metadata");
      assert(metaInsert, "expected an anilist_metadata insert");
      const bad = metaInsert!.rows.find((r) => r.media_id === 1)!;
      assertEquals(bad.start_date, null); // malformed → NULL
      assertEquals(bad.start_year, 2020); // year still populated
      assert(!("last_updated" in bad));

      // per-user resource + run marker were written
      assert(writes.some((w) => w.spec === "userlistScored"));
      assert(writes.some((w) => w.spec === "ingestRun"));
    } finally {
      globalThis.fetch = origFetch;
    }
  },
});
