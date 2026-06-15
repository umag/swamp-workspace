import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildConfig,
  type CommandRunner,
  ensureRegistry,
  type FileWriter,
  type GateParams,
  instanceCommands,
  parseFirstRepoDigest,
  pinImage,
  scaffoldRepo,
  type SubstrateOpts,
} from "./preflight.ts";

const SUB: SubstrateOpts = {
  registryAddr: "127.0.0.1:5000",
  sshUser: "zeroclaw",
  jjPath: "/home/zeroclaw/.local/bin/jj",
  fcHost: "firecracker.aopab.art",
  snapshotPath: "/opt/firecracker/agent-snapshot.snap",
  memFilePath: "/opt/firecracker/agent-snapshot.mem",
  queueRoot: "/tmp/fc-fabric",
  vaultName: "hashi",
  oauthSecretKey: "CLAUDE_CODE_OAUTH_TOKEN",
};
const GATE: GateParams = {
  user: "deno",
  cpus: "2",
  memory: "2g",
  pidsLimit: 512,
};
const DIGEST = "127.0.0.1:5000/myproj@sha256:" + "a".repeat(64);

Deno.test("parseFirstRepoDigest extracts the digest ref", () => {
  assertEquals(parseFirstRepoDigest(`[${DIGEST}]`), DIGEST);
  assertEquals(parseFirstRepoDigest("[]"), null);
  assertEquals(parseFirstRepoDigest("[127.0.0.1:5000/x:gate]"), null);
});

Deno.test("instanceCommands wires si/dv/fab with global args", () => {
  const cmds = instanceCommands(SUB);
  assertEquals(cmds.length, 3);
  assertStringIncludes(
    cmds[0],
    "source-integration si --global-arg jjPath=/home/zeroclaw/.local/bin/jj",
  );
  assertStringIncludes(
    cmds[1],
    "docker-verify dv --global-arg sshHost=127.0.0.1 --global-arg sshUser=zeroclaw",
  );
  assertStringIncludes(
    cmds[2],
    "@magistr/firecracker fab --global-arg host=firecracker.aopab.art",
  );
});

Deno.test("buildConfig takes image+verifyCommand as inputs and adds the substrate", () => {
  const cfg = buildConfig(DIGEST, "deno test -A", GATE, SUB);
  assertEquals(cfg.image, DIGEST);
  assertEquals(cfg.verifyCommand, "deno test -A");
  assertEquals(cfg.gate.user, "deno");
  assertEquals(cfg.instances.fab, "fab");
  assertEquals(
    cfg.fabricUp.oauthToken,
    "${{ vault.get(hashi, CLAUDE_CODE_OAUTH_TOKEN) }}",
  );
  assertEquals(cfg.instanceCommands.length, 3);
});

// ── docker orchestration with a fake runner (no real docker) ─────────────────

function runnerOf(
  handler: (key: string) => { code: number; stdout?: string },
  log: string[],
): CommandRunner {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    log.push(key);
    const r = handler(key);
    return Promise.resolve({
      code: r.code,
      stdout: r.stdout ?? "",
      stderr: "",
    });
  };
}

Deno.test("ensureRegistry is idempotent when the registry exists", async () => {
  const log: string[] = [];
  const run = runnerOf(
    (k) =>
      (k.includes("info") || k.includes("inspect gobrr-registry"))
        ? { code: 0 }
        : { code: 0 },
    log,
  );
  const created = await ensureRegistry(run);
  assertEquals(created, false);
  assert(!log.some((l) => l.startsWith("docker run")));
});

Deno.test("ensureRegistry throws helpfully when docker is unreachable", async () => {
  const run = runnerOf(
    (k) => k.includes("info") ? { code: 1 } : { code: 0 },
    [],
  );
  let threw = false;
  try {
    await ensureRegistry(run);
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "'docker' group");
  }
  assert(threw);
});

Deno.test("pinImage tags a prebuilt sourceImage (no build) and resolves the digest", async () => {
  const log: string[] = [];
  const run = runnerOf((k) => {
    if (k.includes("image inspect")) return { code: 1 }; // not present under registry tag yet
    if (k.includes("--format {{.RepoDigests}}")) {
      return { code: 0, stdout: `[${DIGEST}]` };
    }
    return { code: 0 };
  }, log);
  const res = await pinImage(run, {
    registryAddr: "127.0.0.1:5000",
    name: "myproj",
    tag: "gate",
    sourceImage: "denoland/deno:2.8.3",
  });
  assertEquals(res.image, DIGEST);
  assertEquals(res.built, false);
  assert(
    log.some((l) =>
      l.startsWith("docker tag denoland/deno:2.8.3 127.0.0.1:5000/myproj:gate")
    ),
  );
  assert(!log.some((l) => l.startsWith("docker build")));
  assert(log.some((l) => l === `docker pull ${DIGEST}`));
});

Deno.test("pinImage builds a codebase buildContext when given one", async () => {
  const log: string[] = [];
  let pushed = false;
  const run = runnerOf((k) => {
    if (k.includes("image inspect")) return { code: 1 };
    if (k.startsWith("docker push")) {
      pushed = true;
      return { code: 0 };
    }
    if (k.includes("--format {{.RepoDigests}}")) {
      return { code: 0, stdout: pushed ? `[${DIGEST}]` : "[]" };
    }
    return { code: 0 };
  }, log);
  const res = await pinImage(run, {
    registryAddr: "127.0.0.1:5000",
    name: "myproj",
    tag: "gate",
    buildContext: "/path/to/codebase/.gate",
  });
  assertEquals(res.image, DIGEST);
  assertEquals(res.built, true);
  assert(
    log.some((l) =>
      l.startsWith(
        "docker build -t 127.0.0.1:5000/myproj:gate /path/to/codebase/.gate",
      )
    ),
  );
  assert(log.some((l) => l.startsWith("docker push")));
});

Deno.test("pinImage errors when the image is absent and no source/context given", async () => {
  const run = runnerOf(
    (k) => k.includes("image inspect") ? { code: 1 } : { code: 0 },
    [],
  );
  let threw = false;
  try {
    await pinImage(run, {
      registryAddr: "127.0.0.1:5000",
      name: "myproj",
      tag: "gate",
    });
  } catch (e) {
    threw = true;
    assertStringIncludes(
      (e as Error).message,
      "neither buildContext nor sourceImage",
    );
  }
  assert(threw);
});

Deno.test("scaffoldRepo writes files, inits jj, and returns the base change id", async () => {
  const log: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const run = runnerOf(
    (k) =>
      k.includes("log -r @")
        ? { code: 0, stdout: "qpvuntsmwlqt\n" }
        : { code: 0 },
    log,
  );
  const write: FileWriter = (path, content) => {
    writes.push({ path, content });
    return Promise.resolve();
  };
  const res = await scaffoldRepo(run, write, {
    repoPath: "/tmp/x",
    files: [
      { path: "deno.json", content: "{}" },
      { path: "extensions/models/base.test.ts", content: "// smoke" },
    ],
    describe: "bootstrap",
  });
  assertEquals(res.base, "qpvuntsmwlqt");
  assertEquals(res.repoScope, "/tmp/x");
  assertEquals(res.changedPaths, [
    "deno.json",
    "extensions/models/base.test.ts",
  ]);
  assertEquals(writes.length, 2);
  assertEquals(writes[0].path, "/tmp/x/deno.json");
  assert(log.some((l) => l === "jj git init --colocate /tmp/x"));
  assert(log.some((l) => l.startsWith("jj -R /tmp/x describe -m")));
});

Deno.test("scaffoldRepo throws when jj git init fails", async () => {
  const run = runnerOf(
    (k) => k.includes("git init") ? { code: 1 } : { code: 0 },
    [],
  );
  const write: FileWriter = () => Promise.resolve();
  let threw = false;
  try {
    await scaffoldRepo(run, write, {
      repoPath: "/tmp/x",
      files: [],
      describe: "b",
    });
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "jj git init failed");
  }
  assert(threw);
});
