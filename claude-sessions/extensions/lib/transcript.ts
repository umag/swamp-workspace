// Pure parsing and classification of Claude Code session transcripts.
//
// A transcript is a JSONL file under ~/.claude/projects/<encoded-cwd>/ named
// <sessionId>.jsonl. Every line is one entry; the ones that carry content are
// `user` and `assistant`, interleaved with bookkeeping entries the CLI writes
// for its own state (`mode`, `permission-mode`, `file-history-snapshot`,
// `attachment`, `last-prompt`, `ai-title`, `queue-operation`, `system`).
//
// Nothing here touches the filesystem — the model passes text in, so the
// parsing and the completion heuristics stay unit-testable.

/** Entry shapes we care about; everything else is ignored. */
export interface TranscriptEntry {
  type?: string;
  aiTitle?: string;
  lastPrompt?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  sessionId?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
}

export interface ParsedSession {
  sessionId: string;
  cwd: string;
  gitBranch: string;
  cliVersion: string;
  models: string[];
  aiTitle: string;
  startedAt: string;
  lastActivityAt: string;
  spanHours: number;
  lines: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  topTools: { name: string; count: number }[];
  firstUserPrompt: string;
  lastUserPrompt: string;
  lastAssistantText: string;
  /**
   * The last assistant message that is about the WORK rather than about the
   * session's own kanban card. A session closed with `/mk-card` or `/mk-done`
   * ends on hook bookkeeping, which says nothing about whether the work
   * finished — the real recap is one or more turns further up.
   */
  lastSubstantiveText: string;
  /** How many trailing housekeeping turns were skipped to find it. */
  housekeepingTailTurns: number;
}

/**
 * Text the CLI injects around a real prompt — hook output, command wrappers,
 * pasted-file attachments. Stripping it keeps the prompt fields readable and
 * keeps the classifier from scoring on boilerplate.
 */
const NOISE_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>([\s\S]*?)<\/command-name>/g,
  /<command-args>([\s\S]*?)<\/command-args>/g,
];

export function stripNoise(raw: string): string {
  let s = raw;
  for (const re of NOISE_BLOCKS) {
    // Keep the slash-command name and its args — they ARE the prompt when the
    // user drove the turn with a command.
    s = re.source.includes("command-name") || re.source.includes("command-args")
      ? s.replace(re, "$1 ")
      : s.replace(re, " ");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Assistant/user content is either a plain string or a content-block array. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out.join("\n");
}

function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string };
    if (b?.type === "tool_use" && typeof b.name === "string") out.push(b.name);
  }
  return out;
}

/**
 * Does this assistant message talk only about the session's mk card — created
 * it, retitled it, confirmed the hook state — rather than about the work?
 */
export function isCardHousekeeping(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const mentionsCard = /\bcard-[0-9a-z]/i.test(t) ||
    /\b(claude board|mk board)\b/i.test(t);
  if (!mentionsCard) return false;
  const aboutTheCard =
    /\b(card (?:already )?(?:created|exists?|existed)|created on the|title (?:updated|set|confirmed)|hook state|Stop\/SessionEnd hooks|working column|moved to done)\b/i
      .test(t);
  // A long message that merely cites a card id is a work recap that happens to
  // mention the card; housekeeping is short and is *about* the card.
  return aboutTheCard && t.length < 700;
}

export function parseTranscript(
  text: string,
  fallbackSessionId: string,
): ParsedSession {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      // A truncated tail line (session still being written) must not sink the
      // whole read — skip it and keep the rest of the transcript.
    }
  }

  let aiTitle = "";
  let cwd = "";
  let gitBranch = "";
  let cliVersion = "";
  let sessionId = fallbackSessionId;
  let startedAt = "";
  let lastActivityAt = "";
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  const tools = new Map<string, number>();
  const models = new Set<string>();
  const userPrompts: string[] = [];
  const assistantTexts: string[] = [];

  for (const e of entries) {
    if (e.sessionId) sessionId = e.sessionId;
    if (e.type === "ai-title" && e.aiTitle) aiTitle = e.aiTitle;
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch !== undefined && e.gitBranch !== "") {
      gitBranch = e.gitBranch;
    }
    if (e.version) cliVersion = e.version;
    if (e.timestamp) {
      if (!startedAt || e.timestamp < startedAt) startedAt = e.timestamp;
      if (!lastActivityAt || e.timestamp > lastActivityAt) {
        lastActivityAt = e.timestamp;
      }
    }

    // Sidechain entries are subagent turns — they are not the main thread's
    // conversation and would drown out the session's own last word.
    if (e.isSidechain) continue;

    if (e.type === "user" && e.message) {
      const t = stripNoise(extractText(e.message.content));
      if (t) {
        userTurns++;
        userPrompts.push(t);
      }
    } else if (e.type === "assistant" && e.message) {
      assistantTurns++;
      if (e.message.model) models.add(e.message.model);
      const t = extractText(e.message.content).trim();
      if (t) assistantTexts.push(t);
      for (const n of toolNames(e.message.content)) {
        toolCalls++;
        tools.set(n, (tools.get(n) ?? 0) + 1);
      }
    }
  }

  const topTools = [...tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8);

  const spanHours = startedAt && lastActivityAt
    ? Math.round(
      ((Date.parse(lastActivityAt) - Date.parse(startedAt)) / 3_600_000) * 10,
    ) / 10
    : 0;

  return {
    sessionId,
    cwd,
    gitBranch,
    cliVersion,
    models: [...models].sort(),
    aiTitle,
    startedAt,
    lastActivityAt,
    spanHours,
    lines: lines.length,
    userTurns,
    assistantTurns,
    toolCalls,
    topTools,
    firstUserPrompt: userPrompts[0] ?? "",
    lastUserPrompt: userPrompts.at(-1) ?? "",
    lastAssistantText: assistantTexts.at(-1) ?? "",
    ...findSubstantiveTail(assistantTexts),
  };
}

/**
 * A short turn that only narrates the next tool call ("Running it now:") —
 * the shape of an interstitial note, not a recap. A session killed mid-work
 * ends on one of these, and judging it would read as "unclear" when the real
 * state is visible one turn up.
 */
export function isInterstitialNote(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length < 240 && /:$/.test(t);
}

/** Walk back past trailing non-recap turns to the last real recap. */
function findSubstantiveTail(
  assistantTexts: string[],
): { lastSubstantiveText: string; housekeepingTailTurns: number } {
  let i = assistantTexts.length - 1;
  let skipped = 0;
  while (
    i >= 0 &&
    (isCardHousekeeping(assistantTexts[i]) ||
      isInterstitialNote(assistantTexts[i]))
  ) {
    i--;
    skipped++;
  }
  return {
    lastSubstantiveText: i >= 0 ? assistantTexts[i] : "",
    housekeepingTailTurns: skipped,
  };
}

// --- Completion heuristics ---
//
// These read the session's LAST assistant message, which by convention (the
// mk-session-card Stop hook) is a recap of what was done and what is left.
// The verdict is a heuristic ranking aid, not a judgment — `evidence` carries
// the text so a human or agent can decide.

const DONE_RE =
  /\b(done|completed?|complete|shipped|verified|deployed|published|fixed|resolved|passing|all green|closed|live|merged)\b|✅|Recap:/i;

const OPEN_RE =
  /\b(next steps?|remaining|still (?:need|needs|to|open)|not yet|TODO|to do|blocked|waiting on|left to do|follow[- ]?up|I'?ll |we'?ll |let me know|pending|in progress|outstanding|unfinished)\b/i;

const NOTHING_LEFT_RE =
  /\b(nothing (?:is )?left|nothing outstanding|nothing further|no (?:further )?(?:work|steps|action)s? (?:left|remaining|needed)|left:\s*(?:nothing|none)|fully (?:done|complete))\b/i;

export type Verdict =
  | "likely-complete"
  | "likely-open"
  | "hook-noise"
  | "unclear";

export interface Signals {
  hasCompletionPhrase: boolean;
  hasOpenEndingPhrase: boolean;
  declaresNothingLeft: boolean;
  endedOnSlashCommand: boolean;
  endedOnCardHousekeeping: boolean;
  staleDays: number;
}

export interface Classification {
  verdict: Verdict;
  confidence: "high" | "medium" | "low";
  signals: Signals;
  reason: string;
}

export function daysBetween(fromIso: string, nowIso: string): number {
  if (!fromIso) return 0;
  const ms = Date.parse(nowIso) - Date.parse(fromIso);
  return Math.round((ms / 86_400_000) * 10) / 10;
}

export function classify(
  session: Pick<
    ParsedSession,
    | "lastAssistantText"
    | "lastSubstantiveText"
    | "lastUserPrompt"
    | "lastActivityAt"
  >,
  nowIso: string,
): Classification {
  // Judge the last message that is about the work. When the session ended on
  // card bookkeeping that is an earlier turn — otherwise it is the same one.
  // If no substantive turn exists and the last turn is itself housekeeping,
  // there is genuinely nothing to judge.
  const substantive = session.lastSubstantiveText ?? "";
  const last = session.lastAssistantText ?? "";
  const text = substantive || (isCardHousekeeping(last) ? "" : last);
  const lastPrompt = session.lastUserPrompt ?? "";
  const judgedOnEarlierTurn = Boolean(
    substantive && last && substantive !== last,
  );
  const suffix = judgedOnEarlierTurn
    ? " (judged on the last substantive turn — the session ended on card bookkeeping)"
    : "";

  const signals: Signals = {
    hasCompletionPhrase: DONE_RE.test(text),
    hasOpenEndingPhrase: OPEN_RE.test(text),
    declaresNothingLeft: NOTHING_LEFT_RE.test(text),
    endedOnSlashCommand: /^\/\w/.test(lastPrompt.trim()),
    endedOnCardHousekeeping: /^\/mk-(card|done)\b/.test(lastPrompt.trim()) ||
      judgedOnEarlierTurn,
    staleDays: daysBetween(session.lastActivityAt, nowIso),
  };

  // Only when the whole session is card bookkeeping is there nothing to judge.
  if (!text) {
    return {
      verdict: "hook-noise",
      confidence: "high",
      signals,
      reason: last
        ? "Every assistant turn is mk card housekeeping — no work recap exists."
        : "No assistant text found in the transcript.",
    };
  }

  if (signals.declaresNothingLeft) {
    return {
      verdict: "likely-complete",
      confidence: "high",
      signals,
      reason: "Recap explicitly states nothing is left." + suffix,
    };
  }

  if (signals.hasCompletionPhrase && !signals.hasOpenEndingPhrase) {
    return {
      verdict: "likely-complete",
      confidence: judgedOnEarlierTurn ? "low" : "medium",
      signals,
      reason: "Recap reports completion with no open-ended follow-ups." +
        suffix,
    };
  }

  if (signals.hasOpenEndingPhrase && !signals.hasCompletionPhrase) {
    return {
      verdict: "likely-open",
      confidence: judgedOnEarlierTurn ? "low" : "medium",
      signals,
      reason: "Recap names follow-up work and claims no completion." + suffix,
    };
  }

  if (signals.hasOpenEndingPhrase && signals.hasCompletionPhrase) {
    return {
      verdict: "likely-open",
      confidence: "low",
      signals,
      reason:
        "Recap mixes completion and follow-up language — partial progress." +
        suffix,
    };
  }

  return {
    verdict: "unclear",
    confidence: "low",
    signals,
    reason: "Recap carries neither completion nor follow-up language." + suffix,
  };
}

/** Trim evidence text to a readable excerpt without cutting mid-word. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** ~/.claude/projects encodes the cwd by replacing every non-alnum with "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
