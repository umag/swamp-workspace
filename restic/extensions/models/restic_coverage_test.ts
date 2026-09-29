/**
 * Coverage suite for @magistr/restic: one test per guard, so deleting the
 * guard turns a test red. Everything runs against a scripted CommandRunner —
 * no restic process is spawned.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  BackupArgs,
  backupImpl,
  CheckArgs,
  checkImpl,
  type CommandRunner,
  type Ctx,
  ForgetArgs,
  forgetImpl,
  GlobalArgsSchema,
  jsonLines,
  restic,
  type RunResult,
  SnapshotsArgs,
  snapshotsImpl,
  StatsArgs,
  statsImpl,
  statusImpl,
} from "./restic.ts";

const SECRET = "cov-secret-9f3";

function globals(extra: Record<string, unknown> = {}) {
  return GlobalArgsSchema.parse({
    repository: "/tmp/repo",
    password: SECRET,
    paths: ["/src"],
    ...extra,
  });
}

function scripted(handler: (args: string[]) => Partial<RunResult>) {
  const calls: string[][] = [];
  const run: CommandRunner = (_bin, args) => {
    calls.push(args);
    return Promise.resolve({
      code: 0,
      stdout: "",
      stderr: "",
      ...handler(args),
    });
  };
  return { run, calls };
}

function ctxFor(g = globals()) {
  const written: Record<string, Record<string, unknown>> = {};
  const ctx: Ctx = {
    globalArgs: g,
    writeResource: (spec, name, data) => {
      written[`${spec}/${name}`] = data;
      return Promise.resolve({});
    },
  };
  return { ctx, written };
}

Deno.test("guard: spawn failure is wrapped and redacted", async () => {
  const run: CommandRunner = () => {
    throw new Error(`ENOENT restic ${SECRET}`);
  };
  const e = await assertRejects(() => restic(run, globals(), ["version"]));
  assert((e as Error).message.startsWith("failed to start restic"));
  assert(!(e as Error).message.includes(SECRET));
});

Deno.test("guard: cacheDir is prepended to every invocation", async () => {
  const { run, calls } = scripted(() => ({ stdout: "[]" }));
  const { ctx } = ctxFor(globals({ cacheDir: "/c" }));
  await snapshotsImpl(run, SnapshotsArgs.parse({}), ctx);
  assertEquals(calls[0].slice(0, 2), ["--cache-dir", "/c"]);
});

Deno.test("guard: lock failure (exit 11) is named", async () => {
  const { run } = scripted(() => ({ code: 11 }));
  await assertRejects(
    () => restic(run, globals(), ["check"]),
    Error,
    "locked by another process",
  );
});

Deno.test("guard: backup without a summary message throws", async () => {
  const { run } = scripted(() => ({ stdout: '{"message_type":"status"}\n' }));
  const { ctx } = ctxFor();
  await assertRejects(
    () => backupImpl(run, BackupArgs.parse({}), ctx),
    Error,
    "no summary",
  );
});

Deno.test("guard: backup errors are capped at maxErrors", async () => {
  const err = '{"message_type":"error","error":{"message":"x"},"item":"/f"}';
  const { run } = scripted(() => ({
    code: 3,
    stdout: `${err}\n${err}\n${err}\n{"message_type":"summary"}\n`,
  }));
  const { ctx, written } = ctxFor();
  await backupImpl(run, BackupArgs.parse({ maxErrors: 2 }), ctx);
  const s = written["backupSummary/backup"];
  assertEquals(s.errorCount, 3);
  assertEquals((s.errors as unknown[]).length, 2);
});

Deno.test("guard: arg paths override globalArguments.paths", async () => {
  const { run, calls } = scripted(() => ({
    stdout: '{"message_type":"summary"}\n',
  }));
  const { ctx } = ctxFor();
  await backupImpl(run, BackupArgs.parse({ paths: ["/other"] }), ctx);
  assertEquals(calls[0].at(-1), "/other");
  assert(!calls[0].includes("/src"));
});

Deno.test("guard: paths come after -- so a path cannot become a flag", async () => {
  const { run, calls } = scripted(() => ({
    stdout: '{"message_type":"summary"}\n',
  }));
  const { ctx } = ctxFor();
  await backupImpl(run, BackupArgs.parse({ paths: ["--delete"] }), ctx);
  const a = calls[0];
  assert(a.indexOf("--") < a.indexOf("--delete"));
});

Deno.test("guard: failed check with no JSON errors keeps stderr tail", async () => {
  const { run } = scripted(() => ({
    code: 1,
    stderr: `Fatal: boom ${SECRET}`,
  }));
  const { ctx, written } = ctxFor();
  await checkImpl(run, CheckArgs.parse({}), ctx);
  const c = written["checkResult/check"];
  assertEquals(c.ok, false);
  const errs = c.errors as string[];
  assert(errs[0].includes("Fatal: boom"));
  assert(!errs[0].includes(SECRET));
});

Deno.test("guard: check without subset omits --read-data-subset", async () => {
  const { run, calls } = scripted(() => ({
    stdout: '{"message_type":"summary","num_errors":0}\n',
  }));
  const { ctx } = ctxFor();
  await checkImpl(run, CheckArgs.parse({}), ctx);
  assert(!calls[0].some((a) => a.startsWith("--read-data-subset")));
});

Deno.test("guard: forget passes --host when hostname is set", async () => {
  const { run, calls } = scripted(() => ({ stdout: "[]\n" }));
  const { ctx } = ctxFor(globals({ hostname: "laptop" }));
  await forgetImpl(run, ForgetArgs.parse({ keepLast: 3 }), ctx);
  const a = calls[0];
  assertEquals(a[a.indexOf("--host") + 1], "laptop");
});

Deno.test("guard: forget with dryRun false omits --dry-run and adds --prune", async () => {
  const { run, calls } = scripted(() => ({ stdout: "[]\n" }));
  const { ctx } = ctxFor();
  await forgetImpl(
    run,
    ForgetArgs.parse({ keepDaily: 7, dryRun: false, prune: true }),
    ctx,
  );
  assert(!calls[0].includes("--dry-run"));
  assert(calls[0].includes("--prune"));
});

Deno.test("guard: keepWithin rejects shell-ish input", () => {
  assert(!ForgetArgs.safeParse({ keepWithin: "30d; rm -rf /" }).success);
  assert(ForgetArgs.safeParse({ keepWithin: "1y6M" }).success);
});

Deno.test("guard: snapshots 'null' JSON is an empty list", async () => {
  const { run } = scripted(() => ({ stdout: "null\n" }));
  const { ctx, written } = ctxFor();
  await snapshotsImpl(run, SnapshotsArgs.parse({}), ctx);
  assertEquals(written["snapshotList/snapshots"].count, 0);
});

Deno.test("guard: snapshot filters become flags", async () => {
  const { run, calls } = scripted(() => ({ stdout: "[]" }));
  const { ctx } = ctxFor();
  await snapshotsImpl(
    run,
    SnapshotsArgs.parse({ host: "h", tag: "t", latest: 2 }),
    ctx,
  );
  const a = calls[0];
  assertEquals(a[a.indexOf("--host") + 1], "h");
  assertEquals(a[a.indexOf("--tag") + 1], "t");
  assertEquals(a[a.indexOf("--latest") + 1], "2");
});

Deno.test("guard: stats optional fields become null when absent", async () => {
  const { run } = scripted(() => ({
    stdout: '{"total_size":10,"snapshots_count":1}',
  }));
  const { ctx, written } = ctxFor();
  await statsImpl(run, StatsArgs.parse({ mode: "restore-size" }), ctx);
  const s = written["statsResult/stats"];
  assertEquals(s.totalSize, 10);
  assertEquals(s.compressionRatio, null);
  assertEquals(s.mode, "restore-size");
});

Deno.test("guard: status with zero snapshots has null age", async () => {
  const { run } = scripted((a) =>
    a[0] === "cat" ? { stdout: '{"id":"r"}' } : { stdout: "[]" }
  );
  const { ctx, written } = ctxFor();
  await statusImpl(run, ctx);
  const s = written["repoStatus/status"];
  assertEquals(s.latestSnapshot, null);
  assertEquals(s.latestAgeHours, null);
});

Deno.test("guard: jsonLines skips partial and non-JSON lines", () => {
  assertEquals(
    jsonLines('{"a":1}\n{"broken\nplain text\n  {"b":2}  \n'),
    [{ a: 1 }, { b: 2 }],
  );
});
