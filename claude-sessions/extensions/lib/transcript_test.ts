import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  classify,
  daysBetween,
  encodeProjectDir,
  excerpt,
  extractText,
  isCardHousekeeping,
  isInterstitialNote,
  parseTranscript,
  stripNoise,
} from "./transcript.ts";

const NOW = "2026-07-19T12:00:00.000Z";

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

Deno.test("stripNoise removes hook wrappers but keeps the command itself", () => {
  const raw =
    `<command-message>voice-writer</command-message>\n<command-name>/voice-writer</command-name>\n<command-args>write about nvidia</command-args>`;
  const out = stripNoise(raw);
  assertStringIncludes(out, "/voice-writer");
  assertStringIncludes(out, "write about nvidia");
  assertEquals(out.includes("<command"), false);
});

Deno.test("stripNoise drops system-reminder blocks entirely", () => {
  const raw =
    "real prompt <system-reminder>ignore me\nmultiline</system-reminder> tail";
  assertEquals(stripNoise(raw), "real prompt tail");
});

Deno.test("extractText handles string and block-array content", () => {
  assertEquals(extractText("plain"), "plain");
  assertEquals(
    extractText([
      { type: "text", text: "a" },
      { type: "tool_use", name: "Bash" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
  assertEquals(extractText(undefined), "");
});

Deno.test("parseTranscript pulls metadata, counts turns and tools", () => {
  const text = jsonl(
    { type: "mode", mode: "normal", sessionId: "s1" },
    { type: "ai-title", aiTitle: "Fix the widget", sessionId: "s1" },
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-07-18T10:00:00.000Z",
      cwd: "/repo",
      gitBranch: "main",
      version: "2.1.178",
      message: { role: "user", content: "fix the widget" },
    },
    {
      type: "assistant",
      sessionId: "s1",
      timestamp: "2026-07-18T10:05:00.000Z",
      message: {
        role: "assistant",
        model: "claude-fable-5",
        content: [
          { type: "text", text: "Looking now." },
          { type: "tool_use", name: "Bash" },
          { type: "tool_use", name: "Bash" },
          { type: "tool_use", name: "Read" },
        ],
      },
    },
    {
      type: "assistant",
      sessionId: "s1",
      timestamp: "2026-07-18T11:00:00.000Z",
      message: {
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "Widget fixed and tests pass." }],
      },
    },
  );

  const s = parseTranscript(text, "fallback");
  assertEquals(s.sessionId, "s1");
  assertEquals(s.aiTitle, "Fix the widget");
  assertEquals(s.cwd, "/repo");
  assertEquals(s.gitBranch, "main");
  assertEquals(s.cliVersion, "2.1.178");
  assertEquals(s.models, ["claude-fable-5"]);
  assertEquals(s.userTurns, 1);
  assertEquals(s.assistantTurns, 2);
  assertEquals(s.toolCalls, 3);
  assertEquals(s.topTools[0], { name: "Bash", count: 2 });
  assertEquals(s.startedAt, "2026-07-18T10:00:00.000Z");
  assertEquals(s.lastActivityAt, "2026-07-18T11:00:00.000Z");
  assertEquals(s.spanHours, 1);
  assertEquals(s.lastAssistantText, "Widget fixed and tests pass.");
  assertEquals(s.firstUserPrompt, "fix the widget");
});

Deno.test("parseTranscript survives a truncated final line", () => {
  const good = JSON.stringify({
    type: "assistant",
    sessionId: "s2",
    timestamp: "2026-07-18T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  });
  const s = parseTranscript(`${good}\n{"type":"assist`, "s2");
  assertEquals(s.assistantTurns, 1);
  assertEquals(s.lastAssistantText, "ok");
});

Deno.test("parseTranscript ignores sidechain (subagent) turns", () => {
  const text = jsonl(
    {
      type: "assistant",
      sessionId: "s3",
      timestamp: "2026-07-18T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "main answer" }],
      },
    },
    {
      type: "assistant",
      sessionId: "s3",
      isSidechain: true,
      timestamp: "2026-07-18T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "subagent chatter" }],
      },
    },
  );
  const s = parseTranscript(text, "s3");
  assertEquals(s.assistantTurns, 1);
  assertEquals(s.lastAssistantText, "main answer");
});

Deno.test("classify: explicit nothing-left is high-confidence complete", () => {
  const c = classify({
    lastAssistantText: "Deployed and verified. Nothing left.",
    lastSubstantiveText: "Deployed and verified. Nothing left.",
    lastUserPrompt: "ship it",
    lastActivityAt: "2026-07-18T12:00:00.000Z",
  }, NOW);
  assertEquals(c.verdict, "likely-complete");
  assertEquals(c.confidence, "high");
  assertEquals(c.signals.declaresNothingLeft, true);
});

Deno.test("classify: follow-up language marks the session open", () => {
  const c = classify({
    lastAssistantText: "I wired the model. Next steps: add tests and publish.",
    lastSubstantiveText:
      "I wired the model. Next steps: add tests and publish.",
    lastUserPrompt: "build it",
    lastActivityAt: "2026-07-18T12:00:00.000Z",
  }, NOW);
  assertEquals(c.verdict, "likely-open");
  assertEquals(c.signals.hasOpenEndingPhrase, true);
});

Deno.test("classify: mixed signals resolve to open with low confidence", () => {
  const c = classify({
    lastAssistantText: "Model published. Remaining: wire the nightly workflow.",
    lastSubstantiveText:
      "Model published. Remaining: wire the nightly workflow.",
    lastUserPrompt: "go",
    lastActivityAt: "2026-07-18T12:00:00.000Z",
  }, NOW);
  assertEquals(c.verdict, "likely-open");
  assertEquals(c.confidence, "low");
});

Deno.test("classify judges the work turn when the session ends on card bookkeeping", () => {
  const c = classify({
    lastAssistantText:
      "Card already existed for this session — card-734dc8f4-1ee1-4b24 on the claude board, title updated.",
    lastSubstantiveText: "Shipped the model and verified it end to end.",
    lastUserPrompt: "/mk-card competing with nvidia",
    lastActivityAt: "2026-07-14T12:00:00.000Z",
  }, NOW);
  assertEquals(c.verdict, "likely-complete");
  // Confidence is discounted: the recap was not the session's last word.
  assertEquals(c.confidence, "low");
  assertEquals(c.signals.endedOnCardHousekeeping, true);
  assertStringIncludes(c.reason, "last substantive turn");
});

Deno.test("classify: a session that is ONLY card bookkeeping stays hook-noise", () => {
  const c = classify({
    lastAssistantText:
      "Card created on the claude board in the working column.",
    lastSubstantiveText: "",
    lastUserPrompt: "/mk-card",
    lastActivityAt: "2026-07-14T12:00:00.000Z",
  }, NOW);
  assertEquals(c.verdict, "hook-noise");
  assertStringIncludes(c.reason, "no work recap");
});

Deno.test("classify: empty transcript tail is hook-noise with no text", () => {
  const c = classify({
    lastAssistantText: "",
    lastSubstantiveText: "",
    lastUserPrompt: "",
    lastActivityAt: "2026-07-18T12:00:00.000Z",
  }, NOW);
  assertEquals(c.verdict, "hook-noise");
  assertStringIncludes(c.reason, "No assistant text");
});

Deno.test("isCardHousekeeping distinguishes bookkeeping from a recap citing a card", () => {
  assertEquals(
    isCardHousekeeping(
      "Card `card-d20c2109` created on the claude board in the `working` column.",
    ),
    true,
  );
  // A long work recap that merely mentions the card is NOT housekeeping.
  const recap = "Filed as Lab #1196. " + "The report rests on a contradiction. "
    .repeat(30) +
    "See card-d20c2109 on the claude board.";
  assertEquals(isCardHousekeeping(recap), false);
  assertEquals(isCardHousekeeping("Deployed and verified."), false);
  assertEquals(isCardHousekeeping(""), false);
});

Deno.test("isInterstitialNote spots tool-call narration, not recaps", () => {
  assertEquals(isInterstitialNote("Running the command directly:"), true);
  assertEquals(isInterstitialNote("Now the triage over open cards:"), true);
  assertEquals(isInterstitialNote("Deployed and verified."), false);
  // Long text ending in a colon is a recap introducing a list, not narration.
  assertEquals(
    isInterstitialNote("Here is what shipped. ".repeat(20) + "Details:"),
    false,
  );
  assertEquals(isInterstitialNote(""), false);
});

Deno.test("parseTranscript walks back past interstitial narration", () => {
  const text = jsonl(
    {
      type: "assistant",
      sessionId: "s5",
      timestamp: "2026-07-18T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Everything deployed and verified." }],
      },
    },
    {
      type: "assistant",
      sessionId: "s5",
      timestamp: "2026-07-18T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Running the command directly:" }],
      },
    },
  );
  const s = parseTranscript(text, "s5");
  assertEquals(s.lastSubstantiveText, "Everything deployed and verified.");
  assertEquals(s.housekeepingTailTurns, 1);
});

Deno.test("parseTranscript walks back past a housekeeping tail", () => {
  const text = jsonl(
    {
      type: "assistant",
      sessionId: "s4",
      timestamp: "2026-07-18T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: "The migration is done and verified.",
        }],
      },
    },
    {
      type: "assistant",
      sessionId: "s4",
      timestamp: "2026-07-18T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: "Card `card-abc123` created on the claude board, title set.",
        }],
      },
    },
  );
  const s = parseTranscript(text, "s4");
  assertEquals(
    s.lastAssistantText.startsWith("Card `card-abc123`"),
    true,
  );
  assertEquals(s.lastSubstantiveText, "The migration is done and verified.");
  assertEquals(s.housekeepingTailTurns, 1);
});

Deno.test("classify reports staleness in days", () => {
  const c = classify({
    lastAssistantText: "All good, done.",
    lastSubstantiveText: "All good, done.",
    lastUserPrompt: "go",
    lastActivityAt: "2026-07-12T12:00:00.000Z",
  }, NOW);
  assertEquals(c.signals.staleDays, 7);
});

Deno.test("daysBetween returns 0 for a missing timestamp", () => {
  assertEquals(daysBetween("", NOW), 0);
});

Deno.test("excerpt trims on a word boundary and marks truncation", () => {
  const long = "alpha beta gamma delta epsilon zeta eta theta";
  const out = excerpt(long, 20);
  assertEquals(out.endsWith("…"), true);
  assertEquals(out.length <= 21, true);
  assertEquals(excerpt("short", 20), "short");
});

Deno.test("encodeProjectDir matches the ~/.claude/projects convention", () => {
  assertEquals(
    encodeProjectDir("/Users/mag1/dev_tmp/swamp"),
    "-Users-mag1-dev-tmp-swamp",
  );
});
