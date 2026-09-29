/**
 * Property-based tests (fast-check) for @magistr/restic.
 *
 * Properties:
 *  (a) redact — for any secret (len >= 3) embedded anywhere in any text, the
 *      output never contains the secret.
 *  (b) secrets never in argv — for any password / rest password and any
 *      paths, excludes and tags, backup passes the secrets only via env.
 *  (c) jsonLines total — never throws, returns only plain objects.
 *  (d) forget flag mapping — every set keep rule appears exactly once with
 *      its value; --dry-run present iff dryRun.
 *  (e) flow — against an in-memory fake repository, any sequence of
 *      init/backup/status calls keeps init idempotent and the snapshot count
 *      equal to the number of backups.
 *
 * fast-check is PINNED at npm:fast-check@4.8.0 (CLAUDE.md rule 7).
 * FC_NUM_RUNS-gated: small by default (200), large in the nightly soak.
 */
import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BackupArgs,
  backupImpl,
  type CommandRunner,
  type Ctx,
  ForgetArgs,
  forgetImpl,
  GlobalArgsSchema,
  initImpl,
  jsonLines,
  redact,
  statusImpl,
} from "./restic.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// Secrets use an alphabet disjoint from generated paths/tags so a secret can
// never legitimately appear inside argv.
const secretArb = fc.string({
  minLength: 3,
  maxLength: 40,
  unit: fc.constantFrom(..."ABCDEFGHIJKLMNOP0123456789"),
})
  .map((s) => `S#${s}`);
const wordArb = fc.string({
  minLength: 1,
  maxLength: 12,
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz/._-*"),
});

function ctxFor(g: ReturnType<typeof GlobalArgsSchema.parse>) {
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

Deno.test("property: redact removes every occurrence of the secret", () => {
  fc.assert(
    fc.property(
      secretArb,
      fc.string(),
      fc.string(),
      fc.nat(3),
      (secret, pre, post, n) => {
        const g = GlobalArgsSchema.parse({ repository: "r", password: secret });
        const text = pre + Array(n + 1).fill(secret).join(post) + post;
        assert(!redact(text, g).includes(secret));
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: secrets never reach argv", async () => {
  await fc.assert(
    fc.asyncProperty(
      secretArb,
      secretArb,
      fc.array(wordArb, { minLength: 1, maxLength: 5 }),
      fc.array(wordArb, { maxLength: 5 }),
      fc.array(wordArb, { maxLength: 3 }),
      async (password, restPassword, paths, excludes, tags) => {
        const argvs: string[][] = [];
        const envs: Record<string, string>[] = [];
        const run: CommandRunner = (_b, args, env) => {
          argvs.push(args);
          envs.push(env);
          return Promise.resolve({
            code: 0,
            stdout: '{"message_type":"summary"}\n',
            stderr: "",
          });
        };
        const g = GlobalArgsSchema.parse({
          repository: "rest:http://h/r/",
          password,
          restPassword,
          paths,
          excludes,
          tags,
        });
        await backupImpl(run, BackupArgs.parse({}), ctxFor(g).ctx);
        const flat = argvs.flat().join("\u0000");
        assert(!flat.includes(password) && !flat.includes(restPassword));
        assertEquals(envs[0].RESTIC_PASSWORD, password);
        assertEquals(envs[0].RESTIC_REST_PASSWORD, restPassword);
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: jsonLines is total and yields objects only", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.string(), fc.json()), { maxLength: 10 }),
      (lines) => {
        const out = jsonLines(lines.join("\n"));
        for (const o of out) {
          assert(o !== null && typeof o === "object" && !Array.isArray(o));
        }
      },
    ),
    FC_RUNS,
  );
});

const FLAG: Record<string, string> = {
  keepLast: "--keep-last",
  keepHourly: "--keep-hourly",
  keepDaily: "--keep-daily",
  keepWeekly: "--keep-weekly",
  keepMonthly: "--keep-monthly",
  keepYearly: "--keep-yearly",
};

Deno.test("property: forget maps each keep rule to exactly one flag", async () => {
  const policyArb = fc.record(
    {
      keepLast: fc.integer({ min: 1, max: 999 }),
      keepHourly: fc.integer({ min: 1, max: 999 }),
      keepDaily: fc.integer({ min: 1, max: 999 }),
      keepWeekly: fc.integer({ min: 1, max: 999 }),
      keepMonthly: fc.integer({ min: 1, max: 999 }),
      keepYearly: fc.integer({ min: 1, max: 999 }),
    },
    { requiredKeys: [] },
  ).filter((p) => Object.keys(p).length > 0);
  await fc.assert(
    fc.asyncProperty(policyArb, fc.boolean(), async (policy, dryRun) => {
      let argv: string[] = [];
      const run: CommandRunner = (_b, args) => {
        argv = args;
        return Promise.resolve({ code: 0, stdout: "[]\n", stderr: "" });
      };
      const g = GlobalArgsSchema.parse({ repository: "r", password: "pw-x" });
      await forgetImpl(
        run,
        ForgetArgs.parse({ ...policy, dryRun }),
        ctxFor(g).ctx,
      );
      for (const [k, flag] of Object.entries(FLAG)) {
        const hits = argv.filter((a) => a === flag).length;
        const v = (policy as Record<string, number>)[k];
        if (v === undefined) {
          assertEquals(hits, 0);
        } else {
          assertEquals(hits, 1);
          assertEquals(argv[argv.indexOf(flag) + 1], String(v));
        }
      }
      assertEquals(argv.includes("--dry-run"), dryRun);
    }),
    FC_RUNS,
  );
});

/** In-memory restic: tracks whether the repo exists and how many snapshots. */
function fakeRepo() {
  const state = { exists: false, snapshots: 0, inits: 0 };
  const run: CommandRunner = (_b, args) => {
    const cmd = args[0];
    const ok = (stdout: string) =>
      Promise.resolve({ code: 0, stdout, stderr: "" });
    if (cmd === "cat") {
      return state.exists
        ? ok('{"id":"fake"}')
        : Promise.resolve({ code: 10, stdout: "", stderr: "no repo" });
    }
    if (cmd === "init") {
      state.exists = true;
      state.inits++;
      return ok('{"message_type":"initialized","id":"fake"}\n');
    }
    if (cmd === "backup") {
      if (!state.exists) {
        return Promise.resolve({ code: 10, stdout: "", stderr: "no repo" });
      }
      state.snapshots++;
      return ok(
        `{"message_type":"summary","snapshot_id":"s${state.snapshots}"}\n`,
      );
    }
    if (cmd === "snapshots") {
      const list = Array.from({ length: state.snapshots }, (_, i) => ({
        id: `s${i + 1}`,
        time: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      }));
      return ok(JSON.stringify(list));
    }
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `unexpected ${cmd}`,
    });
  };
  return { run, state };
}

Deno.test("property: init/backup/status flow keeps invariants", async () => {
  const opArb = fc.array(fc.constantFrom("init", "backup", "status"), {
    minLength: 1,
    maxLength: 15,
  });
  await fc.assert(
    fc.asyncProperty(opArb, async (ops) => {
      const { run, state } = fakeRepo();
      const g = GlobalArgsSchema.parse({
        repository: "r",
        password: "pw-x",
        paths: ["/p"],
      });
      const { ctx, written } = ctxFor(g);
      let backups = 0;
      for (const op of ops) {
        if (op === "init") await initImpl(run, ctx);
        if (op === "status") {
          await statusImpl(run, ctx);
          const s = written["repoStatus/status"];
          assertEquals(s.initialized, state.exists);
          assertEquals(s.snapshotCount, backups);
        }
        if (op === "backup") {
          if (state.exists) {
            await backupImpl(run, BackupArgs.parse({}), ctx);
            backups++;
          }
        }
      }
      assert(state.inits <= 1, "init must be idempotent");
      assertEquals(state.snapshots, backups);
    }),
    FC_RUNS,
  );
});
