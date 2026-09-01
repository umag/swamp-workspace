// @magistr/claude-sessions — read Claude Code's own session transcripts.
//
// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. This model turns that
// write-only log into queryable swamp data: session metadata, turn and tool
// counts, the opening prompt and the closing recap, plus a completion
// heuristic over the final assistant message.
//
// It also joins sessions to the mk kanban cards created by the
// mk-session-card hook (state files in ~/.claude/mk-session-cards/), which is
// what makes `triage` useful: it answers "which cards still sitting in the
// working column correspond to sessions that actually finished?".
//
// The verdict is a ranking aid, never a judgment — every triage row carries
// the closing text as evidence so a human or agent decides.

import { z } from "npm:zod@4";
import {
  classify,
  daysBetween,
  excerpt,
  parseTranscript,
} from "../lib/transcript.ts";

// --- Global arguments ---

const GlobalArgsSchema = z.object({
  projectsDir: z
    .string()
    .default("~/.claude/projects")
    .describe("Root that holds one directory of transcripts per project cwd"),
  cardStateDir: z
    .string()
    .default("~/.claude/mk-session-cards")
    .describe(
      "State dir written by the mk-session-card hook (sessionId -> mk cardId)",
    ),
  defaultProject: z
    .string()
    .default("")
    .describe(
      "Project directory name to read when a method is called without one (e.g. -Users-me-dev-myrepo); empty means every project",
    ),
});

// --- Filesystem helpers ---

function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  const home = Deno.env.get("HOME") ?? "";
  return home + p.slice(1);
}

async function listProjects(projectsDir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(projectsDir)) {
      if (e.isDirectory) out.push(e.name);
    }
  } catch (err) {
    throw new Error(
      `Cannot read projects dir ${projectsDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return out.sort();
}

interface TranscriptFile {
  project: string;
  sessionId: string;
  path: string;
  sizeBytes: number;
  mtime: string;
}

async function listTranscripts(
  projectsDir: string,
  projects: string[],
): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  for (const project of projects) {
    const dir = `${projectsDir}/${project}`;
    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isFile || !e.name.endsWith(".jsonl")) continue;
        const path = `${dir}/${e.name}`;
        const st = await Deno.stat(path);
        out.push({
          project,
          sessionId: e.name.replace(/\.jsonl$/, ""),
          path,
          sizeBytes: st.size,
          mtime: (st.mtime ?? new Date(0)).toISOString(),
        });
      }
    } catch {
      // A project dir that vanished between listing and reading is not fatal.
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

interface CardLink {
  cardId: string;
  sessionId: string;
  createdAt: string;
  closed: boolean;
  titleSet: boolean;
}

async function readCardLinks(dir: string): Promise<Map<string, CardLink>> {
  const bySession = new Map<string, CardLink>();
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      try {
        const s = JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`));
        if (typeof s?.sessionId === "string" && typeof s?.cardId === "string") {
          bySession.set(s.sessionId, {
            cardId: s.cardId,
            sessionId: s.sessionId,
            createdAt: s.createdAt ?? "",
            closed: s.closed === true,
            titleSet: s.titleSet === true,
          });
        }
      } catch {
        // Half-written state file — skip it rather than fail the whole run.
      }
    }
  } catch {
    // No hook state dir at all: sessions simply carry no card link.
  }
  return bySession;
}

/** Read + parse one transcript, joined with its mk card link if any. */
async function loadSession(
  file: TranscriptFile,
  cards: Map<string, CardLink>,
  nowIso: string,
  evidenceChars: number,
) {
  const text = await Deno.readTextFile(file.path);
  const parsed = parseTranscript(text, file.sessionId);
  const cls = classify(parsed, nowIso);
  const link = cards.get(parsed.sessionId);
  return {
    kind: "session",
    sessionId: parsed.sessionId,
    project: file.project,
    path: file.path,
    sizeBytes: file.sizeBytes,
    title: parsed.aiTitle,
    cwd: parsed.cwd,
    gitBranch: parsed.gitBranch,
    cliVersion: parsed.cliVersion,
    models: parsed.models,
    startedAt: parsed.startedAt,
    lastActivityAt: parsed.lastActivityAt,
    spanHours: parsed.spanHours,
    staleDays: daysBetween(parsed.lastActivityAt, nowIso),
    lines: parsed.lines,
    userTurns: parsed.userTurns,
    assistantTurns: parsed.assistantTurns,
    toolCalls: parsed.toolCalls,
    topTools: parsed.topTools,
    firstUserPrompt: excerpt(parsed.firstUserPrompt, evidenceChars),
    lastUserPrompt: excerpt(parsed.lastUserPrompt, evidenceChars),
    // closingText is the evidence the verdict rests on: the last message about
    // the WORK, which is an earlier turn when the session ended on /mk-card.
    closingText: excerpt(
      parsed.lastSubstantiveText || parsed.lastAssistantText,
      evidenceChars,
    ),
    lastTurnText: excerpt(parsed.lastAssistantText, evidenceChars),
    housekeepingTailTurns: parsed.housekeepingTailTurns,
    verdict: cls.verdict,
    confidence: cls.confidence,
    reason: cls.reason,
    signals: cls.signals,
    card: link
      ? { cardId: link.cardId, closed: link.closed, createdAt: link.createdAt }
      : null,
    scannedAt: nowIso,
  };
}

function resolveProjects(
  requested: string,
  fallback: string,
  available: string[],
): string[] {
  const want = requested || fallback;
  if (!want) return available;
  if (!available.includes(want)) {
    throw new Error(
      `Project "${want}" not found under the projects dir. Available: ${
        available.join(", ") || "(none)"
      }`,
    );
  }
  return [want];
}

// --- Resource schemas ---

const ToolCountSchema = z.object({
  name: z.string(),
  count: z.number(),
});

const SignalsSchema = z.object({
  hasCompletionPhrase: z.boolean(),
  hasOpenEndingPhrase: z.boolean(),
  declaresNothingLeft: z.boolean(),
  endedOnSlashCommand: z.boolean(),
  endedOnCardHousekeeping: z.boolean(),
  staleDays: z.number(),
});

const SessionSchema = z.object({
  kind: z.literal("session"),
  sessionId: z.string(),
  project: z.string(),
  path: z.string(),
  sizeBytes: z.number(),
  title: z.string(),
  cwd: z.string(),
  gitBranch: z.string(),
  cliVersion: z.string(),
  models: z.array(z.string()),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  spanHours: z.number(),
  staleDays: z.number(),
  lines: z.number(),
  userTurns: z.number(),
  assistantTurns: z.number(),
  toolCalls: z.number(),
  topTools: z.array(ToolCountSchema),
  firstUserPrompt: z.string(),
  lastUserPrompt: z.string(),
  closingText: z.string(),
  lastTurnText: z.string(),
  housekeepingTailTurns: z.number(),
  verdict: z.string(),
  confidence: z.string(),
  reason: z.string(),
  signals: SignalsSchema,
  card: z
    .object({
      cardId: z.string(),
      closed: z.boolean(),
      createdAt: z.string(),
    })
    .nullable(),
  scannedAt: z.string(),
});

const TriageRowSchema = z.object({
  cardId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  verdict: z.string(),
  confidence: z.string(),
  reason: z.string(),
  staleDays: z.number(),
  lastActivityAt: z.string(),
  userTurns: z.number(),
  toolCalls: z.number(),
  cardClosed: z.boolean(),
  closingText: z.string(),
  housekeepingTailTurns: z.number(),
});

const TriageSchema = z.object({
  kind: z.literal("triage"),
  scannedAt: z.string(),
  projects: z.array(z.string()),
  totals: z.record(z.string(), z.number()),
  rows: z.array(TriageRowSchema),
  sessionsWithoutCard: z.number(),
  cardsWithoutSession: z.array(z.string()),
});

const IndexSchema = z.object({
  kind: z.literal("index"),
  scannedAt: z.string(),
  projectsDir: z.string(),
  projects: z.array(
    z.object({
      project: z.string(),
      sessions: z.number(),
      bytes: z.number(),
      lastActivityAt: z.string(),
    }),
  ),
  totalSessions: z.number(),
  totalBytes: z.number(),
});

const SearchSchema = z.object({
  kind: z.literal("search"),
  query: z.string(),
  scannedAt: z.string(),
  matches: z.array(
    z.object({
      sessionId: z.string(),
      project: z.string(),
      title: z.string(),
      lastActivityAt: z.string(),
      hits: z.number(),
      snippets: z.array(z.string()),
      cardId: z.string(),
    }),
  ),
});

// --- Model ---

export const model = {
  type: "@magistr/claude-sessions",
  version: "2026.07.19.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    session: {
      description:
        "One Claude Code session: metadata, turn/tool counts, opening prompt, closing recap, completion verdict",
      schema: SessionSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    triage: {
      description:
        "Worklist joining sessions to their mk cards, ranked by completion verdict",
      schema: TriageSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    index: {
      description: "Per-project session counts and sizes",
      schema: IndexSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    search: {
      description: "Sessions matching a text query, with snippets",
      schema: SearchSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    index: {
      description:
        "Inventory the transcript store: one row per project with session count, bytes and last activity. Cheap — stats files without parsing them.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const projectsDir = expandHome(context.globalArgs.projectsDir);
        const nowIso = new Date().toISOString();
        const projects = await listProjects(projectsDir);
        const files = await listTranscripts(projectsDir, projects);

        const byProject = new Map<
          string,
          { sessions: number; bytes: number; lastActivityAt: string }
        >();
        for (const f of files) {
          const cur = byProject.get(f.project) ??
            { sessions: 0, bytes: 0, lastActivityAt: "" };
          cur.sessions++;
          cur.bytes += f.sizeBytes;
          if (f.mtime > cur.lastActivityAt) cur.lastActivityAt = f.mtime;
          byProject.set(f.project, cur);
        }

        const handle = await context.writeResource("index", "index", {
          kind: "index",
          scannedAt: nowIso,
          projectsDir,
          projects: [...byProject.entries()]
            .map(([project, v]) => ({ project, ...v }))
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
          totalSessions: files.length,
          totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
        });
        return { dataHandles: [handle] };
      },
    },

    listSessions: {
      description:
        "Parse transcripts and write one session resource each: metadata, turn/tool counts, opening prompt, closing recap and completion verdict. Fans out over every matching session in one run.",
      arguments: z.object({
        project: z
          .string()
          .default("")
          .describe(
            "Project dir name (e.g. -Users-me-dev-repo); empty uses defaultProject, or all projects",
          ),
        since: z
          .string()
          .default("")
          .describe(
            "Only sessions active on/after this ISO date (e.g. 2026-07-12)",
          ),
        limit: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Cap sessions parsed, newest first (0 = no cap)"),
        evidenceChars: z
          .number()
          .int()
          .min(80)
          .max(4000)
          .default(700)
          .describe("Max characters kept for each prompt/recap excerpt"),
      }),
      execute: async (args, context) => {
        const projectsDir = expandHome(context.globalArgs.projectsDir);
        const nowIso = new Date().toISOString();
        const available = await listProjects(projectsDir);
        const projects = resolveProjects(
          args.project,
          context.globalArgs.defaultProject,
          available,
        );
        const cards = await readCardLinks(
          expandHome(context.globalArgs.cardStateDir),
        );

        let files = await listTranscripts(projectsDir, projects);
        if (args.since) files = files.filter((f) => f.mtime >= args.since);
        if (args.limit > 0) files = files.slice(0, args.limit);

        const handles: unknown[] = [];
        for (const f of files) {
          const s = await loadSession(f, cards, nowIso, args.evidenceChars);
          if (args.since && s.lastActivityAt && s.lastActivityAt < args.since) {
            continue;
          }
          handles.push(
            await context.writeResource("session", `session-${s.sessionId}`, s),
          );
        }
        return { dataHandles: handles };
      },
    },

    triage: {
      description:
        "Join sessions to their mk cards and rank them by completion verdict — the answer to 'which working-column cards belong to sessions that actually finished?'. Writes a single triage worklist plus a session resource per row.",
      arguments: z.object({
        project: z
          .string()
          .default("")
          .describe("Project dir name; empty uses defaultProject, or all"),
        since: z
          .string()
          .default("")
          .describe("Only sessions active on/after this ISO date"),
        cardIds: z
          .array(z.string())
          .default([])
          .describe(
            "Restrict the worklist to these mk card ids (empty = every linked card)",
          ),
        openCardsOnly: z
          .boolean()
          .default(true)
          .describe(
            "Skip sessions whose hook state already marks the card closed",
          ),
        evidenceChars: z
          .number()
          .int()
          .min(80)
          .max(4000)
          .default(700)
          .describe("Max characters kept for the closing-recap excerpt"),
        writeSessions: z
          .boolean()
          .default(true)
          .describe("Also write one session resource per triaged row"),
      }),
      execute: async (args, context) => {
        const projectsDir = expandHome(context.globalArgs.projectsDir);
        const nowIso = new Date().toISOString();
        const available = await listProjects(projectsDir);
        const projects = resolveProjects(
          args.project,
          context.globalArgs.defaultProject,
          available,
        );
        const cards = await readCardLinks(
          expandHome(context.globalArgs.cardStateDir),
        );

        let files = await listTranscripts(projectsDir, projects);
        if (args.since) files = files.filter((f) => f.mtime >= args.since);

        const wanted = new Set(args.cardIds);
        const handles: unknown[] = [];
        const rows: z.infer<typeof TriageRowSchema>[] = [];
        const totals: Record<string, number> = {};
        const seenCards = new Set<string>();
        let sessionsWithoutCard = 0;

        for (const f of files) {
          const link = cards.get(f.sessionId);
          if (!link) {
            sessionsWithoutCard++;
            continue;
          }
          if (wanted.size > 0 && !wanted.has(link.cardId)) continue;
          if (args.openCardsOnly && link.closed) continue;

          const s = await loadSession(f, cards, nowIso, args.evidenceChars);
          seenCards.add(link.cardId);
          totals[s.verdict] = (totals[s.verdict] ?? 0) + 1;
          rows.push({
            cardId: link.cardId,
            sessionId: s.sessionId,
            title: s.title,
            verdict: s.verdict,
            confidence: s.confidence,
            reason: s.reason,
            staleDays: s.staleDays,
            lastActivityAt: s.lastActivityAt,
            userTurns: s.userTurns,
            toolCalls: s.toolCalls,
            cardClosed: link.closed,
            closingText: s.closingText,
            housekeepingTailTurns: s.housekeepingTailTurns,
          });
          if (args.writeSessions) {
            handles.push(
              await context.writeResource(
                "session",
                `session-${s.sessionId}`,
                s,
              ),
            );
          }
        }

        // Cards the hook knows about but whose transcript is gone or filtered
        // out — they cannot be judged from logs and need a human look.
        const cardsWithoutSession = [...cards.values()]
          .filter((l) => {
            if (wanted.size > 0 && !wanted.has(l.cardId)) return false;
            if (args.openCardsOnly && l.closed) return false;
            return !seenCards.has(l.cardId);
          })
          .map((l) => l.cardId)
          .sort();

        const order: Record<string, number> = {
          "likely-complete": 0,
          "hook-noise": 1,
          "unclear": 2,
          "likely-open": 3,
        };
        rows.sort((a, b) =>
          (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9) ||
          b.staleDays - a.staleDays
        );

        handles.push(
          await context.writeResource("triage", "triage", {
            kind: "triage",
            scannedAt: nowIso,
            projects,
            totals,
            rows,
            sessionsWithoutCard,
            cardsWithoutSession,
          }),
        );
        return { dataHandles: handles };
      },
    },

    search: {
      description:
        "Full-text search across transcripts — returns matching sessions with snippets, newest first.",
      arguments: z.object({
        q: z.string().min(1).describe("Case-insensitive substring to find"),
        project: z
          .string()
          .default("")
          .describe("Project dir name; empty uses defaultProject, or all"),
        since: z
          .string()
          .default("")
          .describe("Only sessions active on/after this ISO date"),
        maxSessions: z
          .number()
          .int()
          .min(1)
          .default(50)
          .describe("Stop after this many matching sessions"),
        snippetsPerSession: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(3)
          .describe("Snippets kept per matching session"),
      }),
      execute: async (args, context) => {
        const projectsDir = expandHome(context.globalArgs.projectsDir);
        const nowIso = new Date().toISOString();
        const available = await listProjects(projectsDir);
        const projects = resolveProjects(
          args.project,
          context.globalArgs.defaultProject,
          available,
        );
        const cards = await readCardLinks(
          expandHome(context.globalArgs.cardStateDir),
        );

        let files = await listTranscripts(projectsDir, projects);
        if (args.since) files = files.filter((f) => f.mtime >= args.since);

        const needle = args.q.toLowerCase();
        const matches: z.infer<typeof SearchSchema>["matches"] = [];

        for (const f of files) {
          if (matches.length >= args.maxSessions) break;
          const text = await Deno.readTextFile(f.path);
          if (!text.toLowerCase().includes(needle)) continue;

          const parsed = parseTranscript(text, f.sessionId);
          const snippets: string[] = [];
          let hits = 0;
          for (const line of text.split("\n")) {
            const idx = line.toLowerCase().indexOf(needle);
            if (idx < 0) continue;
            hits++;
            if (snippets.length < args.snippetsPerSession) {
              const from = Math.max(0, idx - 120);
              snippets.push(excerpt(line.slice(from, idx + 240), 360));
            }
          }
          matches.push({
            sessionId: parsed.sessionId,
            project: f.project,
            title: parsed.aiTitle,
            lastActivityAt: parsed.lastActivityAt,
            hits,
            snippets,
            cardId: cards.get(parsed.sessionId)?.cardId ?? "",
          });
        }

        const handle = await context.writeResource("search", "search", {
          kind: "search",
          query: args.q,
          scannedAt: nowIso,
          matches,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
