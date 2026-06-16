// @magistr/swamp-go-brr/source-integration — the host CODE-OWNERSHIP boundary.
//
// This is the Anti-Corruption Layer between UNTRUSTED microVM leaf output and the
// trusted jj repo (sacred rule 1). It is the only NEW side-effectful actor; gobrr
// stays a pure state machine and consumes the apply RESULT via `report`.
//
// Pure cores (unit-tested, no I/O): parseEnvelope (the @@EDIT wire format + the
// nonce-fence forgery defense) and planApply (allowlist/DENY/cap enforcement over
// an injectable file snapshot). The side-effectful methods (build_workorder, apply)
// wrap these with realpath-anchored FS access + jj, and are integration-tested.
import { z } from "npm:zod@4";
import {
  isDeniedPath,
  pathEscapes,
  pathInSet,
  resolveWithinRepo,
} from "./lib/acl.ts";
import type { FailureKind } from "./gobrr.ts";

export const MAX_ENVELOPE_BYTES = 200_000;
const MAX_BLOCKS = 200;

export interface Edit {
  path: string;
  old: string;
  new: string;
}
export interface NewFile {
  path: string;
  content: string;
}
export interface Envelope {
  edits: Edit[];
  newFiles: NewFile[];
}

// ── parseEnvelope — the @@EDIT / @@NEWFILE wire format inside a nonce fence ───

/**
 * Parse the leaf output. The host wraps the required output in a per-invocation
 * high-entropy NONCE fence so file content echoed into the prompt cannot forge it.
 * Returns the parsed envelope or a typed FailureKind (never a silent accept).
 */
export function parseEnvelope(
  stdout: string,
  nonce: string,
  maxBytes: number = MAX_ENVELOPE_BYTES,
): { env: Envelope } | { failureKind: FailureKind } {
  if (stdout.length > maxBytes) return { failureKind: "envelope_oversize" };
  if (/^ERROR:\s*claude exit=/m.test(stdout)) {
    return { failureKind: "claude_error" };
  }

  const open = "<<<GOBRR:" + nonce + "\n";
  const close = "\nGOBRR:" + nonce + ">>>";
  const i = stdout.indexOf(open);
  const j = i === -1 ? -1 : stdout.indexOf(close, i + open.length);
  if (i === -1 || j === -1) {
    // A fence with the wrong nonce is a forgery signal, not a plain parse miss.
    if (/<<<GOBRR:|GOBRR:[A-Za-z0-9]*>>>/.test(stdout)) {
      return { failureKind: "nonce_mismatch" };
    }
    return { failureKind: "envelope_parse" };
  }
  const body = stdout.slice(i + open.length, j);

  const edits: Edit[] = [];
  const editRe =
    /@@EDIT[ \t]+(\S+)[ \t]*\n@@OLD[ \t]*\n([\s\S]*?)\n@@NEW[ \t]*\n([\s\S]*?)\n@@ENDEDIT/g;
  for (let m = editRe.exec(body); m !== null; m = editRe.exec(body)) {
    edits.push({ path: m[1].trim(), old: m[2], new: m[3] });
  }
  const newFiles: NewFile[] = [];
  const fileRe = /@@NEWFILE[ \t]+(\S+)[ \t]*\n([\s\S]*?)\n?@@ENDFILE/g;
  for (let m = fileRe.exec(body); m !== null; m = fileRe.exec(body)) {
    newFiles.push({ path: m[1].trim(), content: m[2] });
  }
  if (edits.length === 0 && newFiles.length === 0) {
    return { failureKind: "envelope_parse" };
  }
  return { env: { edits, newFiles } };
}

// ── planApply — pure ACL/cap enforcement over a file snapshot (no I/O) ────────

export interface PlannedWrite {
  path: string;
  content: string;
}

/**
 * Decide what `apply` will write, enforcing the allowlist + DENY set + caps purely
 * over `snapshot` (path -> current content). Multiple @@EDIT blocks targeting the
 * SAME file are applied one after another over a per-path running copy of the
 * snapshot, so @@OLD inclusion/uniqueness and the size cap are checked against the
 * running (folded) content and each file yields exactly one cumulative write; a
 * path present in both @@EDIT and @@NEWFILE is rejected, and a no-op fold (content
 * unchanged from the snapshot) emits no write. Returns the planned writes + the
 * changed paths, or a typed FailureKind. Does NO filesystem work and NO secret
 * scrub (the scrub runs at the apply boundary on the final jj diff). A path that is
 * denied / traverses is `unsafe_change` (attack signal); a clean path merely
 * outside the allowlist is `out_of_allowlist`.
 */
export function planApply(
  env: Envelope,
  allowlist: string[],
  snapshot: Record<string, string>,
): { writes: PlannedWrite[]; changedPaths: string[] } | {
  failureKind: FailureKind;
  note: string;
} {
  if (env.edits.length + env.newFiles.length > MAX_BLOCKS) {
    return {
      failureKind: "envelope_oversize",
      note: "too many edit/newfile blocks",
    };
  }
  const guard = (
    path: string,
  ): { failureKind: FailureKind; note: string } | null => {
    if (pathEscapes(path) || isDeniedPath(path)) {
      return {
        failureKind: "unsafe_change",
        note: `denied/traversal path: ${path}`,
      };
    }
    if (!pathInSet(path, allowlist)) {
      return {
        failureKind: "out_of_allowlist",
        note: `outside allowlist: ${path}`,
      };
    }
    return null;
  };

  // A path may not be both edited and newly created in one envelope — the two
  // loops would race and the @@NEWFILE would silently clobber the @@EDIT result.
  const editPaths = new Set(env.edits.map((e) => e.path));
  for (const f of env.newFiles) {
    if (editPaths.has(f.path)) {
      return {
        failureKind: "envelope_parse",
        note: `path in both @@EDIT and @@NEWFILE: ${f.path}`,
      };
    }
  }

  // Apply blocks ONE AFTER ANOTHER over a per-path running working-copy (a copy of
  // the snapshot — never mutate the caller's). Each block sees the result of every
  // earlier block for its path, so @@OLD inclusion/uniqueness and the size cap are
  // evaluated against the running (folded) content and a file targeted by N blocks
  // yields exactly one cumulative write.
  const running: Record<string, string> = { ...snapshot };
  const touched = new Set<string>();

  for (const e of env.edits) {
    const bad = guard(e.path);
    if (bad) return bad;
    const cur = running[e.path];
    if (cur === undefined) {
      return {
        failureKind: "envelope_parse",
        note: `edit target missing: ${e.path}`,
      };
    }
    if (e.old === "" || !cur.includes(e.old)) {
      return {
        failureKind: "envelope_parse",
        note: `@@OLD not found in ${e.path}`,
      };
    }
    if (cur.indexOf(e.old) !== cur.lastIndexOf(e.old)) {
      return {
        failureKind: "envelope_parse",
        note: `@@OLD not unique in ${e.path}`,
      };
    }
    const next = cur.replace(e.old, e.new);
    if (next.length > MAX_ENVELOPE_BYTES) {
      return { failureKind: "envelope_oversize", note: e.path };
    }
    running[e.path] = next;
    touched.add(e.path);
  }

  for (const f of env.newFiles) {
    const bad = guard(f.path);
    if (bad) return bad;
    if (f.content.length > MAX_ENVELOPE_BYTES) {
      return { failureKind: "envelope_oversize", note: f.path };
    }
    running[f.path] = f.content;
    touched.add(f.path);
  }

  // Emit one write per touched path (sorted, deterministic), skipping a no-op fold
  // whose result equals the original snapshot — a no-op write only yields an empty
  // jj diff and a spurious host-observed changedPath downstream.
  const writes: PlannedWrite[] = [];
  const changed = new Set<string>();
  for (const path of [...touched].sort()) {
    if (running[path] === snapshot[path]) continue;
    writes.push({ path, content: running[path] });
    changed.add(path);
  }

  return { writes, changedPaths: [...changed].sort() };
}

// ── scrubSecrets — apply-boundary redaction of the persisted diff/commit ─────

/**
 * Redact credential VALUES from text persisted to a 24h resource (the final jj
 * diff + commit message). Targets Anthropic token values and bearer/authorization
 * values — not the bare words TOKEN/OAUTH (which legitimately appear in code).
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "[REDACTED-TOKEN]")
    .replace(
      /((?:Authorization|Bearer)\s*:?\s+)[A-Za-z0-9._~+/=\-]{8,}/gi,
      "$1[REDACTED]",
    );
}

// ── side-effectful model methods ─────────────────────────────────────────────
// These wrap the pure cores with realpath-anchored FS access + jj. Integration-
// tested via the step-9 fc-par proof run, not the unit lane.

type Ctx = {
  logger: { info: (msg: string, data?: Record<string, unknown>) => void };
  globalArgs: { jjPath?: string };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

async function jjRun(
  jjPath: string,
  repoRoot: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // jj runs LOCALLY (the repo is on this host) — never SSH. No git hooks/filters
  // are involved (jj is not git); we additionally only ever write regular files.
  const cmd = new Deno.Command(jjPath, {
    args,
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** Parse `jj diff --git` for the set of changed paths + whether each is a regular
 * file. A symlink (120000) / gitlink (160000) / mode change is flagged unsafe. */
export function parseGitDiffPaths(
  diff: string,
): { path: string; regular: boolean }[] {
  const out: { path: string; regular: boolean }[] = [];
  const lines = diff.split("\n");
  let cur: string | null = null;
  let regular = true;
  for (const ln of lines) {
    const m = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      if (cur !== null) out.push({ path: cur, regular });
      cur = m[2];
      regular = true;
      continue;
    }
    if (
      /^(new|old|deleted) file mode (12|16)0000/.test(ln) ||
      /^(new|old) mode (12|16)0000/.test(ln)
    ) {
      regular = false;
    }
  }
  if (cur !== null) out.push({ path: cur, regular });
  return out;
}

export const model = {
  type: "@magistr/swamp-go-brr/source-integration",
  version: "2026.06.15.1",

  globalArguments: z.object({
    jjPath: z.string().default("jj").describe(
      "jj binary (PATH-resolved by default)",
    ),
  }),

  resources: {
    workorder: {
      description:
        "A built leaf WorkOrder prompt (the inline file slice + practices + @@EDIT instructions).",
      schema: z.object({ prompt: z.string(), taskId: z.string() }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    applied: {
      description:
        "Per-task apply results: { taskId -> {changeId, changedPaths, diff, failureKind?} }. changedPaths are HOST-OBSERVED (jj diff), never agent-declared.",
      schema: z.object({ results: z.record(z.string(), z.unknown()) }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    build_workorder: {
      description:
        "Read the allowlist's existing files from repoScope (realpath-anchored, DENY-guarded, secret-scrubbed) and assemble the leaf WorkOrder prompt instructing the @@EDIT envelope. No clone — the file slice goes inline; the caller submits with gitRepoUrl=''.",
      arguments: z.object({
        taskId: z.string(),
        spec: z.string(),
        writeAllowlist: z.array(z.string()),
        repoScope: z.string(),
        practices: z.string().default(""),
        nonce: z.string(),
      }),
      execute: async (
        args: {
          taskId: string;
          spec: string;
          writeAllowlist: string[];
          repoScope: string;
          practices: string;
          nonce: string;
        },
        context: Ctx,
      ) => {
        const repoRoot = Deno.realPathSync(args.repoScope);
        const parts: string[] = [
          "You are a coding agent in NO-CLONE mode. Apply the requested fixes, then output ONLY a nonce-fenced @@EDIT envelope (no prose outside the fence).",
          "",
          "TASK:",
          args.spec,
          "",
          args.practices ? "PRACTICES:\n" + args.practices + "\n" : "",
          `You may create or modify ONLY these paths: ${
            JSON.stringify(args.writeAllowlist)
          }`,
          "",
          "CURRENT CONTENT of the existing files you may edit:",
        ];
        for (const rel of args.writeAllowlist) {
          const r = resolveWithinRepo(repoRoot, rel);
          if (!r.ok || isDeniedPath(rel)) continue; // never inline a denied / escaping path
          let body: string;
          try {
            body = Deno.readTextFileSync(r.abs);
          } catch {
            continue; // not an existing file (a to-be-created path) — skip
          }
          parts.push(
            `----- BEGIN ${rel} -----`,
            scrubSecrets(body),
            `----- END ${rel} -----`,
            "",
          );
        }
        parts.push(
          "Emit EXACTLY one fence. Use literal line markers (raw text between markers — newlines/quotes are fine):",
          `<<<GOBRR:${args.nonce}`,
          "@@EDIT <path>",
          "@@OLD",
          "<exact unique current text>",
          "@@NEW",
          "<replacement>",
          "@@ENDEDIT",
          "@@NEWFILE <path>",
          "<full file content>",
          "@@ENDFILE",
          `GOBRR:${args.nonce}>>>`,
          "",
          "Rules: @@OLD must be an exact, unique substring of the file's current content. @@NEWFILE for files that do not exist yet. Each marker alone on its own line. No JSON, no prose outside the fence.",
        );
        const handle = await context.writeResource("workorder", "workorder", {
          prompt: parts.join("\n"),
          taskId: args.taskId,
        });
        return { dataHandles: [handle] };
      },
    },

    apply: {
      description:
        "Fan-out apply of N completed leaves, each as a PER-TASK ISOLATED jj change off the COMMON BASE (siblings, never stacked) so each task's tree gates in isolation. Parses the @@EDIT envelope, enforces the allowlist/DENY/caps + realpath ACL, writes regular files only, runs the mode-aware re-walk tripwire, and returns per-task {changeId, host-observed changedPaths, scrubbed diff, failureKind?}.",
      arguments: z.object({
        repoScope: z.string(),
        base: z.string().describe(
          "the common base change id all task changes branch from",
        ),
        tasks: z.array(z.object({
          taskId: z.string(),
          rawStdout: z.string(),
          nonce: z.string(),
          writeAllowlist: z.array(z.string()),
        })).min(1),
      }),
      execute: async (
        args: {
          repoScope: string;
          base: string;
          tasks: {
            taskId: string;
            rawStdout: string;
            nonce: string;
            writeAllowlist: string[];
          }[];
        },
        context: Ctx,
      ) => {
        const jjPath = context.globalArgs.jjPath ?? "jj";
        // Assert repoScope is an absolute, clean, real jj repo (docker_verify-style).
        if (
          !args.repoScope.startsWith("/") ||
          /[\s;|&$`'"]|\.\.(\/|$)/.test(args.repoScope)
        ) {
          throw new Error("repoScope must be an absolute, clean host path");
        }
        const repoRoot = Deno.realPathSync(args.repoScope);
        try {
          if (!Deno.statSync(`${repoRoot}/.jj`).isDirectory) {
            throw new Error("no .jj");
          }
        } catch {
          throw new Error(`repoScope is not a jj repo: ${repoRoot}`);
        }

        const results: Record<string, unknown> = {};
        for (const t of args.tasks) {
          const fail = (failureKind: FailureKind, note: string) => {
            results[t.taskId] = { failureKind, note };
            context.logger.info("apply {tid} → {fk}", {
              tid: t.taskId,
              fk: failureKind,
            });
          };
          const pe = parseEnvelope(t.rawStdout, t.nonce);
          if ("failureKind" in pe) {
            fail(pe.failureKind, "parse");
            continue;
          }

          // snapshot the edit targets (realpath-anchored reads)
          const snapshot: Record<string, string> = {};
          let unsafe: { failureKind: FailureKind; note: string } | null = null;
          for (const e of pe.env.edits) {
            const r = resolveWithinRepo(repoRoot, e.path);
            if (!r.ok || isDeniedPath(e.path)) {
              unsafe = { failureKind: "unsafe_change", note: e.path };
              break;
            }
            try {
              snapshot[e.path] = Deno.readTextFileSync(r.abs);
            } catch {
              snapshot[e.path] = "";
            }
          }
          if (unsafe) {
            fail(unsafe.failureKind, unsafe.note);
            continue;
          }

          const plan = planApply(pe.env, t.writeAllowlist, snapshot);
          if ("failureKind" in plan) {
            fail(plan.failureKind, plan.note);
            continue;
          }

          // SIBLING off the common base — never stacked on the previous task's change.
          const mk = await jjRun(jjPath, repoRoot, [
            "new",
            args.base,
            "-m",
            `gobrr ${t.taskId}`,
          ]);
          if (mk.code !== 0) {
            fail("transport", `jj new: ${mk.stderr.slice(0, 200)}`);
            continue;
          }

          // write each planned file as a REGULAR file, intermediate dirs created
          // under the verified-real base (no-follow on the resolved leaf).
          let writeErr: { failureKind: FailureKind; note: string } | null =
            null;
          for (const w of plan.writes) {
            const r = resolveWithinRepo(repoRoot, w.path);
            if (!r.ok) {
              writeErr = { failureKind: "unsafe_change", note: w.path };
              break;
            }
            try {
              const dir = r.abs.slice(0, r.abs.lastIndexOf("/"));
              Deno.mkdirSync(dir, { recursive: true });
              Deno.writeTextFileSync(r.abs, w.content); // regular file — never a symlink/gitlink
            } catch (e) {
              writeErr = {
                failureKind: "transport",
                note: String(e).slice(0, 120),
              };
              break;
            }
          }
          if (writeErr) {
            fail(writeErr.failureKind, writeErr.note);
            continue;
          }

          // POST-APPLY RE-WALK tripwire: host-observed, mode-aware. Fail closed if
          // any changed path is out-of-allowlist, denied, or not a regular file.
          const dr = await jjRun(jjPath, repoRoot, [
            "diff",
            "--git",
            "-r",
            "@",
          ]);
          const observed = parseGitDiffPaths(dr.stdout);
          let tripwire: { failureKind: FailureKind; note: string } | null =
            null;
          for (const o of observed) {
            if (isDeniedPath(o.path) || !o.regular) {
              tripwire = { failureKind: "unsafe_change", note: o.path };
              break;
            }
            if (pathEscapes(o.path) || !pathInSet(o.path, t.writeAllowlist)) {
              tripwire = { failureKind: "out_of_allowlist", note: o.path };
              break;
            }
          }
          if (tripwire) {
            fail(tripwire.failureKind, tripwire.note);
            continue;
          }

          const idr = await jjRun(jjPath, repoRoot, [
            "log",
            "-r",
            "@",
            "-T",
            "change_id",
            "--no-graph",
          ]);
          results[t.taskId] = {
            changeId: idr.stdout.trim(),
            changedPaths: observed.map((o) => o.path).sort(), // HOST-OBSERVED, not agent-declared
            diff: scrubSecrets(dr.stdout).slice(0, 20000),
          };
          context.logger.info("apply {tid} → {n} path(s)", {
            tid: t.taskId,
            n: observed.length,
          });
        }
        const handle = await context.writeResource("applied", "applied", {
          results,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
