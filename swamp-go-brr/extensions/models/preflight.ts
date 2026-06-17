import { z } from "npm:zod@4";

// @magistr/swamp-go-brr/preflight — codebase-AGNOSTIC substrate for a gobrr run.
// It does NOT bake any language toolchain: the gate image depends on the codebase
// being built, so the caller brings its own image (a build context or a prebuilt
// ref). This model: ensures the local OCI registry, digest-pins that image (the
// gate runs --network none, so it must be a RepoDigest present locally), and
// emits the run config (gate params, fabric_up inputs, the vault CEL for the
// OAuth token, and the si/dv/fab create commands). Shells to `docker` ONLY —
// never to `swamp`, which would deadlock on the per-process __global__ lock.

// ── injectable command runner (so the docker orchestration is testable) ──────

export type CommandRunner = (
  cmd: string,
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRunner: CommandRunner = async (cmd, args, stdin) => {
  const p = new Deno.Command(cmd, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = p.spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Extract the first `name@sha256:<64hex>` from `docker inspect {{.RepoDigests}}`. */
export function parseFirstRepoDigest(inspectOutput: string): string | null {
  const m = inspectOutput.match(/[^\s"'\[\]]+@sha256:[0-9a-f]{64}/);
  return m ? m[0] : null;
}

/** Generic homelab substrate — independent of the codebase being built. */
export interface SubstrateOpts {
  registryAddr: string;
  sshUser: string;
  jjPath: string;
  fcHost: string;
  snapshotPath: string;
  memFilePath: string;
  queueRoot: string;
  vaultName: string;
  oauthSecretKey: string;
}

export interface GateParams {
  user: string;
  cpus: string;
  memory: string;
  pidsLimit: number;
}

/** The swamp model-create commands for the shared instances (driver runs these). */
export function instanceCommands(o: SubstrateOpts): string[] {
  return [
    `swamp model create @magistr/swamp-go-brr/source-integration si --global-arg jjPath=${o.jjPath}`,
    `swamp model create @magistr/swamp-go-brr/docker-verify dv --global-arg sshHost=127.0.0.1 --global-arg sshUser=${o.sshUser}`,
    `swamp model create @magistr/firecracker fab --global-arg host=${o.fcHost} --global-arg user=root`,
  ];
}

/**
 * Assemble the config the gobrr loop consumes. `image` (digest-pinned) and
 * `verifyCommand` are codebase-specific INPUTS; everything else is the generic
 * homelab substrate.
 */
export function buildConfig(
  image: string,
  verifyCommand: string,
  gate: GateParams,
  o: SubstrateOpts,
) {
  return {
    image,
    verifyCommand,
    gate,
    instances: { si: "si", dv: "dv", fab: "fab" },
    instanceCommands: instanceCommands(o),
    fabricUp: {
      snapshotPath: o.snapshotPath,
      memFilePath: o.memFilePath,
      queueRoot: o.queueRoot,
      oauthToken: `\${{ vault.get(${o.vaultName}, ${o.oauthSecretKey}) }}`,
    },
  };
}

// ── docker orchestration (idempotent) ────────────────────────────────────────

async function dockerReachable(run: CommandRunner): Promise<void> {
  if ((await run("docker", ["info"])).code !== 0) {
    throw new Error(
      "docker is not reachable. Ensure the daemon runs and the user is in the 'docker' group (sudo usermod -aG docker <user>; re-login).",
    );
  }
}

export async function ensureRegistry(run: CommandRunner): Promise<boolean> {
  await dockerReachable(run);
  if ((await run("docker", ["inspect", "gobrr-registry"])).code === 0) {
    return false;
  }
  await run("docker", [
    "run",
    "-d",
    "-p",
    "127.0.0.1:5000:5000",
    "--restart",
    "unless-stopped",
    "--name",
    "gobrr-registry",
    "registry:2",
  ]);
  return true;
}

export interface PinImageInput {
  registryAddr: string;
  name: string;
  tag: string;
  /** Path to a build context the codebase owns (its Dockerfile decides the toolkit). */
  buildContext?: string;
  /** A prebuilt image ref to pin instead of building. */
  sourceImage?: string;
}

/**
 * Digest-pin the codebase's gate image: build its context (or tag a prebuilt
 * ref), push to the local registry, resolve the RepoDigest, and pull it back so
 * it is present locally for the --network none gate. Idempotent on the digest.
 */
export async function pinImage(
  run: CommandRunner,
  i: PinImageInput,
): Promise<{ image: string; built: boolean }> {
  await ensureRegistry(run);
  const tagged = `${i.registryAddr}/${i.name}:${i.tag}`;
  let built = false;
  if ((await run("docker", ["image", "inspect", tagged])).code !== 0) {
    if (i.buildContext) {
      const b = await run("docker", ["build", "-t", tagged, i.buildContext]);
      if (b.code !== 0) {
        throw new Error(`image build failed: ${b.stderr.slice(-400)}`);
      }
      built = true;
    } else if (i.sourceImage) {
      const t = await run("docker", ["tag", i.sourceImage, tagged]);
      if (t.code !== 0) {
        throw new Error(`docker tag failed: ${t.stderr.slice(-400)}`);
      }
    } else {
      throw new Error(
        `image ${tagged} not present and neither buildContext nor sourceImage was given`,
      );
    }
  }
  let inspect = await run("docker", [
    "inspect",
    tagged,
    "--format",
    "{{.RepoDigests}}",
  ]);
  if (!/sha256:/.test(inspect.stdout)) {
    const p = await run("docker", ["push", tagged]);
    if (p.code !== 0) {
      throw new Error(`docker push failed: ${p.stderr.slice(-400)}`);
    }
    inspect = await run("docker", [
      "inspect",
      tagged,
      "--format",
      "{{.RepoDigests}}",
    ]);
  }
  const image = parseFirstRepoDigest(inspect.stdout);
  if (!image) throw new Error("could not resolve a digest-pinned image ref");
  await run("docker", ["pull", image]); // present locally for the --network none gate
  return { image, built };
}

// ── greenfield scaffold (jj-only — never shells `swamp`) ─────────────────────

export type FileWriter = (path: string, content: string) => Promise<void>;

export const defaultWriter: FileWriter = async (path, content) => {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
};

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface ScaffoldInput {
  repoPath: string;
  files: ScaffoldFile[];
  describe: string;
}

/**
 * Write the caller-provided baseline files into a fresh repo, `jj git init
 * --colocate` it, describe the bootstrap change, and return the common base
 * change id that the gobrr `apply` step branches every task off. Toolchain-
 * agnostic (the caller brings the file set — e.g. the deno/swamp-extension
 * preset in references/preflight.md). jj-only, so no `__global__` deadlock.
 */
export async function scaffoldRepo(
  run: CommandRunner,
  write: FileWriter,
  i: ScaffoldInput,
): Promise<{ repoScope: string; base: string; changedPaths: string[] }> {
  const changedPaths: string[] = [];
  for (const f of i.files) {
    await write(`${i.repoPath}/${f.path}`, f.content);
    changedPaths.push(f.path);
  }
  const init = await run("jj", ["git", "init", "--colocate", i.repoPath]);
  if (init.code !== 0) {
    throw new Error(`jj git init failed: ${init.stderr.slice(-300)}`);
  }
  const desc = await run("jj", [
    "-R",
    i.repoPath,
    "describe",
    "-m",
    i.describe,
  ]);
  if (desc.code !== 0) {
    throw new Error(`jj describe failed: ${desc.stderr.slice(-300)}`);
  }
  const log = await run("jj", [
    "-R",
    i.repoPath,
    "log",
    "-r",
    "@",
    "--no-graph",
    "-T",
    "change_id.short()",
  ]);
  const base = log.stdout.trim();
  if (!base) throw new Error("could not read the base change id from jj log");
  return { repoScope: i.repoPath, base, changedPaths };
}

// ── model ────────────────────────────────────────────────────────────────────

const GlobalArgs = z.object({
  registryAddr: z.string().default("127.0.0.1:5000").describe(
    "Local OCI registry for the digest pin",
  ),
  sshUser: z.string().default("zeroclaw").describe(
    "SSH user for the local docker-verify gate",
  ),
  jjPath: z.string().default("/home/zeroclaw/.local/bin/jj"),
  fcHost: z.string().default("firecracker.aopab.art").describe(
    "Firecracker fabric host (fab instance)",
  ),
  snapshotPath: z.string().default("/opt/firecracker/agent-snapshot.snap"),
  memFilePath: z.string().default("/opt/firecracker/agent-snapshot.mem"),
  queueRoot: z.string().default("/tmp/fc-fabric"),
  vaultName: z.string().default("hashi"),
  oauthSecretKey: z.string().default("CLAUDE_CODE_OAUTH_TOKEN"),
});

type Ctx = {
  globalArgs: z.infer<typeof GlobalArgs>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

function substrateFrom(g: z.infer<typeof GlobalArgs>): SubstrateOpts {
  return {
    registryAddr: g.registryAddr,
    sshUser: g.sshUser,
    jjPath: g.jjPath,
    fcHost: g.fcHost,
    snapshotPath: g.snapshotPath,
    memFilePath: g.memFilePath,
    queueRoot: g.queueRoot,
    vaultName: g.vaultName,
    oauthSecretKey: g.oauthSecretKey,
  };
}

export const model = {
  type: "@magistr/swamp-go-brr/preflight",
  version: "2026.06.17.3",
  globalArguments: GlobalArgs,
  resources: {
    pinned: {
      description:
        "The digest-pinned gate image ref (and whether it was built this run).",
      schema: z.object({ image: z.string(), built: z.boolean() }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    config: {
      description:
        "The gobrr run substrate config: digest-pinned image, verifyCommand, gate params, fabric_up inputs, and the swamp model-create commands for si/dv/fab.",
      schema: z.object({
        image: z.string(),
        verifyCommand: z.string(),
        gate: z.object({
          user: z.string(),
          cpus: z.string(),
          memory: z.string(),
          pidsLimit: z.number(),
        }),
        instances: z.object({
          si: z.string(),
          dv: z.string(),
          fab: z.string(),
        }),
        instanceCommands: z.array(z.string()),
        fabricUp: z.object({
          snapshotPath: z.string(),
          memFilePath: z.string(),
          queueRoot: z.string(),
          oauthToken: z.string(),
        }),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    scaffold: {
      description:
        "The scaffolded greenfield base: repoScope, the jj common-base change id, and the files written.",
      schema: z.object({
        repoScope: z.string(),
        base: z.string(),
        changedPaths: z.array(z.string()),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    pin_image: {
      description:
        "Ensure the local registry, then digest-pin the codebase's gate image (build its `buildContext`, or pin a prebuilt `sourceImage`) and pull it back for the --network none gate. The toolkit/deps live in that image, not in this model.",
      arguments: z.object({
        name: z.string().describe(
          "Image name to store under in the local registry",
        ),
        tag: z.string().default("gate"),
        buildContext: z.string().optional().describe(
          "Path to a docker build context the codebase owns",
        ),
        sourceImage: z.string().optional().describe(
          "A prebuilt image ref to pin instead of building",
        ),
      }),
      execute: async (
        args: {
          name: string;
          tag: string;
          buildContext?: string;
          sourceImage?: string;
        },
        context: Ctx,
      ) => {
        const g = context.globalArgs;
        const res = await pinImage(defaultRunner, {
          registryAddr: g.registryAddr,
          name: args.name,
          tag: args.tag,
          buildContext: args.buildContext,
          sourceImage: args.sourceImage,
        });
        const handle = await context.writeResource("pinned", "pinned", res);
        return { dataHandles: [handle] };
      },
    },
    config: {
      description:
        "Emit the run config: pass the codebase-specific digest-pinned `image` and `verifyCommand`; the generic substrate (instances, fabric_up inputs, vault CEL, gate params) comes from globalArgs/defaults.",
      arguments: z.object({
        image: z.string().describe("Digest-pinned gate image (from pin_image)"),
        verifyCommand: z.string().describe(
          "Host-pinned verify command run inside the gate container",
        ),
        gateUser: z.string().default("root"),
        gateCpus: z.string().default("2"),
        gateMemory: z.string().default("2g"),
        gatePidsLimit: z.number().default(512),
      }),
      execute: async (
        args: {
          image: string;
          verifyCommand: string;
          gateUser: string;
          gateCpus: string;
          gateMemory: string;
          gatePidsLimit: number;
        },
        context: Ctx,
      ) => {
        const o = substrateFrom(context.globalArgs);
        const gate: GateParams = {
          user: args.gateUser,
          cpus: args.gateCpus,
          memory: args.gateMemory,
          pidsLimit: args.gatePidsLimit,
        };
        const cfg = buildConfig(args.image, args.verifyCommand, gate, o);
        const handle = await context.writeResource("config", "config", cfg);
        return { dataHandles: [handle] };
      },
    },
    scaffold: {
      description:
        "Scaffold a greenfield repo for a gobrr run: write the baseline files (caller brings the set — see the deno/swamp-extension preset in references/preflight.md), `jj git init --colocate`, describe the bootstrap change, and return the common base change id the loop branches every task off. jj-only.",
      arguments: z.object({
        repoPath: z.string().describe(
          "Absolute path of the new repo to scaffold",
        ),
        files: z.array(z.object({ path: z.string(), content: z.string() }))
          .describe(
            "Baseline files (repo-relative path + content): scaffold + model stub + the base.test smoke gate",
          ),
        describe: z.string().default(
          "bootstrap: scaffold + stub + base.test smoke gate (gobrr common base)",
        ),
      }),
      execute: async (
        args: {
          repoPath: string;
          files: { path: string; content: string }[];
          describe: string;
        },
        context: Ctx,
      ) => {
        const res = await scaffoldRepo(defaultRunner, defaultWriter, args);
        const handle = await context.writeResource("scaffold", "scaffold", res);
        return { dataHandles: [handle] };
      },
    },
  },
};
