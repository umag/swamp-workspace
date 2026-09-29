import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  BackupArgs,
  backupImpl,
  CheckArgs,
  checkImpl,
  type CommandRunner,
  type Ctx,
  defaultRunner,
  ForgetArgs,
  forgetImpl,
  GlobalArgsSchema,
  initImpl,
  model,
  redact,
  type RunResult,
  SnapshotsArgs,
  snapshotsImpl,
  StatsArgs,
  statsImpl,
  statusImpl,
} from "./restic.ts";

const SECRET = "s3cret-pass";

function globals(extra: Record<string, unknown> = {}) {
  return GlobalArgsSchema.parse({
    repository: "rest:http://h:8000/laptop/",
    password: SECRET,
    restUsername: "laptop",
    restPassword: "rest-pw-xyz",
    paths: ["/Users/me"],
    ...extra,
  });
}

interface Call {
  bin: string;
  args: string[];
  env: Record<string, string>;
}

function scripted(handler: (args: string[]) => Partial<RunResult>) {
  const calls: Call[] = [];
  const run: CommandRunner = (bin, args, env) => {
    calls.push({ bin, args, env });
    const r = handler(args);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...r });
  };
  return { run, calls };
}

function fakeCtx(g = globals()) {
  const written: Record<string, Record<string, unknown>> = {};
  const ctx: Ctx = {
    globalArgs: g,
    writeResource: (spec, name, data) => {
      written[`${spec}/${name}`] = data;
      return Promise.resolve({ spec, name });
    },
  };
  return { ctx, written };
}

const CONFIG = JSON.stringify({ version: 2, id: "abc123" });

Deno.test("secrets travel via env only, never argv", async () => {
  const { run, calls } = scripted(() => ({ code: 10 }));
  const { ctx } = fakeCtx();
  await statusImpl(run, ctx);
  for (const c of calls) {
    assert(!c.args.join(" ").includes(SECRET));
    assertEquals(c.env.RESTIC_PASSWORD, SECRET);
    assertEquals(c.env.RESTIC_REST_USERNAME, "laptop");
    assertEquals(c.env.RESTIC_REST_PASSWORD, "rest-pw-xyz");
  }
});

Deno.test("status: missing repo is data, not an error", async () => {
  const { run } = scripted(() => ({ code: 10 }));
  const { ctx, written } = fakeCtx();
  await statusImpl(run, ctx);
  const s = written["repoStatus/status"];
  assertEquals(s.initialized, false);
  assertEquals(s.reachable, true);
});

Deno.test("status: unreachable backend recorded with redacted error", async () => {
  const { run } = scripted(() => ({
    code: 1,
    stderr: `Fatal: connect failed pw=${SECRET}`,
  }));
  const { ctx, written } = fakeCtx();
  await statusImpl(run, ctx);
  const s = written["repoStatus/status"];
  assertEquals(s.reachable, false);
  assert(!String(s.error).includes(SECRET));
});

Deno.test("status: wrong password throws", async () => {
  const { run } = scripted(() => ({ code: 12, stderr: "wrong password" }));
  const { ctx } = fakeCtx();
  await assertRejects(
    () => statusImpl(run, ctx),
    Error,
    "wrong repository password",
  );
});

Deno.test("status: reports newest snapshot", async () => {
  const { run } = scripted((a) =>
    a[0] === "cat" ? { stdout: CONFIG } : {
      stdout: JSON.stringify([
        {
          id: "bbbb",
          time: "2026-09-29T10:00:00Z",
          hostname: "laptop",
          paths: ["/"],
        },
        {
          id: "aaaa",
          time: "2026-09-28T10:00:00Z",
          hostname: "laptop",
          paths: ["/"],
        },
      ]),
    }
  );
  const { ctx, written } = fakeCtx();
  await statusImpl(run, ctx);
  const s = written["repoStatus/status"];
  assertEquals(s.snapshotCount, 2);
  assertEquals((s.latestSnapshot as { id: string }).id, "bbbb");
  assertEquals(s.repoId, "abc123");
});

Deno.test("init is idempotent", async () => {
  const { run, calls } = scripted(() => ({ stdout: CONFIG }));
  const { ctx, written } = fakeCtx();
  await initImpl(run, ctx);
  assertEquals(written["initResult/init"].action, "already-initialized");
  assert(!calls.some((c) => c.args.includes("init")));
});

Deno.test("init creates when absent", async () => {
  const { run } = scripted((a) =>
    a[0] === "cat" ? { code: 10 } : {
      stdout: '{"message_type":"initialized","id":"new1","repository":"x"}\n',
    }
  );
  const { ctx, written } = fakeCtx();
  await initImpl(run, ctx);
  assertEquals(written["initResult/init"].action, "created");
  assertEquals(written["initResult/init"].repoId, "new1");
});

const SUMMARY =
  '{"message_type":"summary","files_new":3,"files_changed":1,"data_added":100,"total_duration":2.5,"snapshot_id":"snap1"}';

Deno.test("backup builds flags and records summary", async () => {
  const { run, calls } = scripted(() => ({ stdout: SUMMARY }));
  const { ctx, written } = fakeCtx(
    globals({ excludes: ["*.tmp"], tags: ["mac"], hostname: "laptop" }),
  );
  await backupImpl(run, BackupArgs.parse({ tags: ["manual"] }), ctx);
  const a = calls[0].args;
  assertEquals(a.slice(0, 2), ["backup", "--json"]);
  assert(a.includes("--exclude-caches"));
  assertEquals(a.slice(a.indexOf("--"), a.length), ["--", "/Users/me"]);
  const s = written["backupSummary/backup"];
  assertEquals(s.snapshotId, "snap1");
  assertEquals(s.filesNew, 3);
  assertEquals(s.complete, true);
});

Deno.test("backup exit 3 is incomplete, errors captured and redacted", async () => {
  const { run } = scripted(() => ({
    code: 3,
    stdout: SUMMARY,
    stderr:
      `{"message_type":"error","error":{"message":"permission denied ${SECRET}"},"during":"archival","item":"/Users/me/Library/x"}\n`,
  }));
  const { ctx, written } = fakeCtx();
  await backupImpl(run, BackupArgs.parse({}), ctx);
  const s = written["backupSummary/backup"];
  assertEquals(s.complete, false);
  assertEquals(s.errorCount, 1);
  const errs = s.errors as { item: string; message: string }[];
  assertEquals(errs[0].item, "/Users/me/Library/x");
  assert(!errs[0].message.includes(SECRET));
});

Deno.test("backup fails without paths", async () => {
  const { run } = scripted(() => ({}));
  const { ctx } = fakeCtx(globals({ paths: [] }));
  await assertRejects(
    () => backupImpl(run, BackupArgs.parse({}), ctx),
    Error,
    "no paths",
  );
});

Deno.test("backup fatal error is thrown and redacted", async () => {
  const { run } = scripted(() => ({ code: 1, stderr: `boom ${SECRET}` }));
  const { ctx } = fakeCtx();
  const e = await assertRejects(() =>
    backupImpl(run, BackupArgs.parse({}), ctx)
  );
  assert(!(e as Error).message.includes(SECRET));
});

Deno.test("check failure is data", async () => {
  const { run } = scripted(() => ({
    code: 1,
    stdout:
      '{"message_type":"error","error":{"message":"pack abc: not referenced"}}\n{"message_type":"summary","num_errors":1,"suggest_repair_index":true}\n',
  }));
  const { ctx, written } = fakeCtx();
  await checkImpl(run, CheckArgs.parse({ readDataSubset: "5%" }), ctx);
  const c = written["checkResult/check"];
  assertEquals(c.ok, false);
  assertEquals(c.numErrors, 1);
  assertEquals(c.suggestRepairIndex, true);
});

Deno.test("check rejects bad subset", () => {
  assert(!CheckArgs.safeParse({ readDataSubset: "5; rm -rf /" }).success);
});

Deno.test("forget refuses empty policy", async () => {
  const { run } = scripted(() => ({}));
  const { ctx } = fakeCtx();
  await assertRejects(
    () => forgetImpl(run, ForgetArgs.parse({}), ctx),
    Error,
    "keep policy",
  );
});

Deno.test("forget defaults to dry-run and counts removals", async () => {
  const { run, calls } = scripted(() => ({
    stdout: JSON.stringify([{
      keep: [{ id: "k" }],
      remove: [{ id: "r1" }, { id: "r2" }],
    }]),
  }));
  const { ctx, written } = fakeCtx();
  await forgetImpl(run, ForgetArgs.parse({ keepDaily: 7 }), ctx);
  assert(calls[0].args.includes("--dry-run"));
  const f = written["forgetResult/forget"];
  assertEquals(f.removed, 2);
  assertEquals(f.kept, 1);
});

Deno.test("redact ignores trivially short secrets", () => {
  const g = globals({ restUsername: "a" });
  assertEquals(redact("a b", g), "a b");
});

Deno.test("model exposes all methods", () => {
  assertEquals(Object.keys(model.methods).sort(), [
    "backup",
    "check",
    "forget",
    "init",
    "snapshots",
    "stats",
    "status",
  ]);
});

// End-to-end against the real binary and a local repository.
const hasRestic = await defaultRunner("restic", ["version"], {}).then(
  (r) => r.code === 0,
  () => false,
);

Deno.test({
  name: "e2e: init → backup → snapshots → check → forget → stats",
  ignore: !hasRestic,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${dir}/src`);
      await Deno.writeTextFile(`${dir}/src/a.txt`, "hello");
      const g = GlobalArgsSchema.parse({
        repository: `${dir}/repo`,
        password: SECRET,
        paths: [`${dir}/src`],
        cacheDir: `${dir}/cache`,
      });
      const { ctx, written } = fakeCtx(g);
      await statusImpl(defaultRunner, ctx);
      assertEquals(written["repoStatus/status"].initialized, false);
      await initImpl(defaultRunner, ctx);
      assertEquals(written["initResult/init"].action, "created");
      await initImpl(defaultRunner, ctx);
      assertEquals(written["initResult/init"].action, "already-initialized");
      await backupImpl(defaultRunner, BackupArgs.parse({}), ctx);
      await backupImpl(defaultRunner, BackupArgs.parse({}), ctx);
      assertEquals(written["backupSummary/backup"].complete, true);
      await snapshotsImpl(defaultRunner, SnapshotsArgs.parse({}), ctx);
      assertEquals(written["snapshotList/snapshots"].count, 2);
      await checkImpl(
        defaultRunner,
        CheckArgs.parse({ readDataSubset: "100%" }),
        ctx,
      );
      assertEquals(written["checkResult/check"].ok, true);
      await forgetImpl(
        defaultRunner,
        ForgetArgs.parse({ keepLast: 1, dryRun: false }),
        ctx,
      );
      assertEquals(written["forgetResult/forget"].removed, 1);
      await statsImpl(defaultRunner, StatsArgs.parse({}), ctx);
      assertEquals(written["statsResult/stats"].snapshotsCount, 1);
      await statusImpl(defaultRunner, ctx);
      assertEquals(written["repoStatus/status"].snapshotCount, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("username is not redacted (it appears in repo URLs)", () => {
  const g = globals();
  assertEquals(
    redact("rest:http://h:8000/laptop/", g),
    "rest:http://h:8000/laptop/",
  );
  assertEquals(redact("x rest-pw-xyz", g), "x ***");
});
