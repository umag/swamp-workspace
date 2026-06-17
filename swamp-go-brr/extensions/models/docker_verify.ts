// @magistr/swamp-go-brr/docker-verify — the deterministic green gate.
//
// A synchronous `docker run` to completion that executes the host-pinned verify
// command against the already-applied tree (bind-mounted READ-ONLY) and returns
// the raw exit code. No installed type does a sync-run-with-exit-code
// (@user/docker/engine.run is detached `docker run -d`), so this is a small
// purpose-built model (Rule-1 last resort, search done). The container is locked
// down: no network, no token, no docker socket, dropped caps. The exit code is
// the gate; the agent controls neither this command nor the tree's test surface.
import { z } from "npm:zod@4";
import { sshExecRaw } from "./lib/ssh.ts";
import { scrubSecrets } from "./lib/scrub.ts";

// Flags an attacker-influenced input must never introduce.
const FORBIDDEN = ["--privileged", "--pid=host", "--ipc=host", "--userns=host"];

export interface VerifySpec {
  image: string; // MUST be digest-pinned (contains @sha256:)
  treePath: string; // absolute host path to the applied tree (mounted ro)
  verifyCommand: string; // host-pinned test command, run inside the container
  user: string; // non-root, e.g. "65534:65534"
  pidsLimit: number;
  memory: string; // e.g. "2g"
  cpus: string; // e.g. "2"
}

/**
 * Build the hardened `docker run` argv. Pure + unit-tested: asserts the image is
 * digest-pinned, the tree path is absolute and clean, and that no forbidden
 * isolation-breaking flag is present. NO token env, NO docker socket mount.
 */
export function buildVerifyArgs(spec: VerifySpec): string[] {
  if (!/@sha256:[0-9a-f]{64}$/.test(spec.image)) {
    throw new Error("verify image must be digest-pinned (…@sha256:<64 hex>)");
  }
  if (
    !spec.treePath.startsWith("/") ||
    /[\s;|&$`'"]|\.\.(\/|$)/.test(spec.treePath)
  ) {
    throw new Error("treePath must be an absolute, clean host path");
  }
  if (spec.pidsLimit <= 0) throw new Error("pidsLimit must be positive");
  const args = [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/work-tmp",
    "--pids-limit",
    String(spec.pidsLimit),
    "--memory",
    spec.memory,
    "--cpus",
    spec.cpus,
    "--user",
    spec.user,
    "-v",
    `${spec.treePath}:/w:ro`,
    "-w",
    "/w",
    spec.image,
    "sh",
    "-c",
    spec.verifyCommand,
  ];
  for (const f of FORBIDDEN) {
    if (args.includes(f)) {
      throw new Error(`forbidden docker flag present: ${f}`);
    }
  }
  if (args.some((a) => /docker\.sock/.test(a))) {
    throw new Error("docker socket must not be mounted");
  }
  if (args.some((a) => /sk-ant|ANTHROPIC|OAUTH|TOKEN|Authorization/i.test(a))) {
    throw new Error("no credential may appear in the verify spec");
  }
  return args;
}

/** Shell-quote a single argv element for transport over `ssh host <command>`. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildVerifyCommandLine(spec: VerifySpec): string {
  return buildVerifyArgs(spec).map(shellQuote).join(" ") +
    '; echo "__GOBRR_EXIT__:$?"';
}

/** Pull the trailing exit-code sentinel out of the remote stdout. */
export function parseExitSentinel(stdout: string): number | null {
  const m = stdout.match(/__GOBRR_EXIT__:(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * The pure write-boundary transform for the persisted verify stdout: scrub secrets
 * UNCONDITIONALLY (raw verify output can echo env-var secrets on a test failure) and
 * tail-bound. The exitCode gate is computed from the RAW stdout via parseExitSentinel
 * before this runs, so scrubbing the stored copy never affects the gate.
 */
export function boundedStdout(stdout: string): string {
  return scrubSecrets(stdout).slice(-8000);
}

type Ctx = {
  logger: { info: (msg: string, data?: Record<string, unknown>) => void };
  globalArgs: { sshHost: string; sshUser?: string };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** @internal — call via the CLI / driver loop. */
export const model = {
  type: "@magistr/swamp-go-brr/docker-verify",
  version: "2026.06.17.1",

  globalArguments: z.object({
    sshHost: z.string().describe("Docker host running the applied tree (SSH)"),
    sshUser: z.string().default("root").describe("SSH username"),
  }),

  resources: {
    result: {
      description:
        "The verify run result: { exitCode, stdout }. exitCode is the gate.",
      schema: z.object({
        exitCode: z.number(),
        // scrubbed at write (boundedStdout); flagged sensitive for downstream redaction
        stdout: z.string().meta({ sensitive: true }),
        command: z.string(),
      }),
      // Bounded retention (issue si-applied-resource-lifetime): even scrubbed, the
      // verify stdout is the likeliest residual-secret field — do not keep it forever.
      lifetime: "24h" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    verify: {
      description:
        "Run the host-pinned verify command once to completion in a hardened, network-less, token-less container against the read-only applied tree; return the raw exit code (the green gate).",
      arguments: z.object({
        image: z.string(),
        treePath: z.string(),
        verifyCommand: z.string(),
        user: z.string().default("65534:65534"),
        pidsLimit: z.number().default(512),
        memory: z.string().default("2g"),
        cpus: z.string().default("2"),
      }),
      execute: async (
        args: {
          image: string;
          treePath: string;
          verifyCommand: string;
          user: string;
          pidsLimit: number;
          memory: string;
          cpus: string;
        },
        context: Ctx,
      ) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        const cmd = buildVerifyCommandLine(args as VerifySpec);
        context.logger.info("docker-verify on {host}: {verify}", {
          host: sshHost,
          verify: args.verifyCommand,
        });
        const res = await sshExecRaw(sshHost, sshUser, cmd);
        // The SSH layer's own exit code can be the docker exit; prefer the
        // sentinel we appended so a non-zero gate survives the transport.
        const sentinel = parseExitSentinel(res.stdout);
        const exitCode = sentinel ?? res.code;
        context.logger.info("docker-verify exit={code}", { code: exitCode });
        const handle = await context.writeResource("result", "current", {
          exitCode,
          stdout: boundedStdout(res.stdout), // scrub + tail-bound; gate uses raw above
          command: cmd,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
