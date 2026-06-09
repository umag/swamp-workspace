import { z } from "npm:zod@4";
import { isValidSshHost, sshExec, sshExecRaw } from "./lib/ssh.ts";

function shellEsc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const HTTPS_URL_RE = /^https?:\/\/[a-zA-Z0-9._-]+(:[0-9]{1,5})?(\/.*)?$/;

const GlobalArgsSchema = z.object({
  host: z.string().describe("SSH host running Firecracker"),
  user: z.string().default("root").describe("SSH username"),
  tapIp: z.string().default("172.16.0.1").describe(
    "Host IP on the TAP interface — the task/result HTTP server binds here",
  ),
  tapPort: z.number().int().min(1024).max(65535).default(8080).describe(
    "TCP port for the task/result HTTP server (default: 8080)",
  ),
  // Validate the OAuth token prefix up front so a corrupted secret fails fast
  // with a clear message instead of silently 401-ing inside the microVM.
  // A valid Anthropic token starts with `sk-ant-` (e.g. sk-ant-oat01-…).
  oauthToken: z.string()
    .startsWith(
      "sk-ant",
      "Claude Code OAuth token must start with 'sk-ant' — a different prefix (e.g. a stray leading 'c' giving 'csk-') means the secret is corrupted.",
    )
    .meta({ sensitive: true })
    .describe(
      "Claude Code OAuth token (sk-ant…) — injected into task JSON served to guest",
    ),
});

// Simple TCP HTTP server: serves task JSON (with token) on GET /task,
// accepts result body on POST /result. NOT a proxy; Claude traffic goes
// direct to api.anthropic.com via the guest's TAP interface + host NAT.
const TAP_SERVER_PY = `#!/usr/bin/env python3
import socket, threading, json, os, sys, time

OAUTH_TOKEN = os.environ.get("FC_OAUTH_TOKEN", "")
TASK_PATH   = os.environ.get("FC_TASK_PATH", "/tmp/fc-task-8080.json")
RESULT_PATH = os.environ.get("FC_RESULT_PATH", "/tmp/fc-result-8080.txt")
BIND_IP     = os.environ.get("FC_BIND_IP", "0.0.0.0")
BIND_PORT   = int(os.environ.get("FC_BIND_PORT", "8080"))

def recv_request(conn):
    buf = b""
    conn.settimeout(10)
    try:
        while b"\\r\\n\\r\\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                return buf
            buf += chunk
    except socket.timeout:
        return buf
    header_end = buf.index(b"\\r\\n\\r\\n") + 4
    headers_raw = buf[:header_end]
    body = buf[header_end:]
    cl = 0
    for line in headers_raw.split(b"\\r\\n"):
        if line.lower().startswith(b"content-length:"):
            try:
                cl = int(line.split(b":", 1)[1].strip())
            except ValueError:
                pass
            break
    conn.settimeout(30)
    while len(body) < cl:
        chunk = conn.recv(min(4096, cl - len(body)))
        if not chunk:
            break
        body += chunk
    return headers_raw + body

def handle_task_get(conn):
    deadline = time.time() + 15
    while time.time() < deadline:
        if os.path.exists(TASK_PATH):
            try:
                with open(TASK_PATH, "rb") as f:
                    raw = f.read()
                task = json.loads(raw)
                task["token"] = OAUTH_TOKEN
                data = json.dumps(task).encode()
                os.unlink(TASK_PATH)
            except (FileNotFoundError, OSError, json.JSONDecodeError):
                pass
            else:
                conn.sendall(
                    b"HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n"
                    b"Content-Length: " + str(len(data)).encode() + b"\\r\\n"
                    b"Connection: close\\r\\n\\r\\n" + data
                )
                conn.close()
                return
        time.sleep(0.5)
    conn.sendall(b"HTTP/1.1 503 Service Unavailable\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")
    conn.close()

def handle_result_post(conn, body):
    with open(RESULT_PATH, "wb") as f:
        f.write(body)
    conn.sendall(b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")
    conn.close()

def handle_client(conn):
    try:
        data = recv_request(conn)
        if not data:
            conn.close()
            return
        parts = data.split(b"\\r\\n")[0].decode(errors="replace").split(" ")
        if len(parts) < 2:
            conn.close()
            return
        method, path = parts[0], parts[1]
        if method == "GET" and path == "/task":
            handle_task_get(conn)
            return
        if method == "POST" and path == "/result":
            header_end = data.index(b"\\r\\n\\r\\n") + 4
            handle_result_post(conn, data[header_end:])
            return
        conn.sendall(b"HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")
        conn.close()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "serve":
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((BIND_IP, BIND_PORT))
        server.listen(16)
        print(f"tap-server started: {BIND_IP}:{BIND_PORT}", flush=True)
        while True:
            conn, _ = server.accept()
            threading.Thread(target=handle_client, args=(conn,), daemon=True).start()
    elif cmd == "inject":
        task = json.loads(sys.argv[2])
        try:
            os.unlink(RESULT_PATH)
        except FileNotFoundError:
            pass
        with open(TASK_PATH, "w") as f:
            json.dump(task, f)
        print(f"injected: {TASK_PATH}", flush=True)
    elif cmd == "collect":
        timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 300
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(RESULT_PATH):
                with open(RESULT_PATH, "r", errors="replace") as f:
                    result = f.read()
                try:
                    os.unlink(RESULT_PATH)
                except FileNotFoundError:
                    pass
                print(result)
                sys.exit(0)
            time.sleep(2)
        print(f"TimeoutError: no result within {timeout}s", file=sys.stderr)
        sys.exit(1)
`;

const ServerStateSchema = z.object({
  pid: z.number().optional(),
  tapIp: z.string(),
  tapPort: z.number(),
  status: z.string(),
  timestamp: z.string(),
});

const TaskResultSchema = z.object({
  stdout: z.string(),
  timestamp: z.string(),
});

const ActionSchema = z.object({
  action: z.string(),
  success: z.boolean(),
  message: z.string(),
  timestamp: z.string(),
});

/**
 * The `@magistr/fc-task-server` model — a host↔guest task/result control-plane
 * server for Firecracker microVM agents (not an internet proxy). Deploys a small
 * Python TCP HTTP server on the host TAP interface that serves the per-run job
 * (prompt + model + OAuth token, injected at serve time) on `GET /task` and
 * collects the agent's output on `POST /result`.
 */
export const model = {
  type: "@magistr/fc-task-server",
  version: "2026.06.09.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    serverState: {
      description: "TAP server process state on the Firecracker host",
      schema: ServerStateSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    taskResult: {
      description: "Stdout captured from the agent run inside the microVM",
      schema: TaskResultSchema,
      lifetime: "24h",
      garbageCollection: 10,
    },
    action: {
      description: "Result of a server lifecycle action",
      schema: ActionSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
  },
  checks: {
    "valid-ssh-host": {
      description:
        "The host global argument must be a non-empty SSH host/IP, not a placeholder",
      labels: ["policy"],
      execute: (context) => {
        const host = context.globalArgs?.host;
        if (!isValidSshHost(host)) {
          return {
            pass: false,
            errors: [
              `globalArgs.host must be a non-empty SSH host/IP (got ${
                JSON.stringify(host)
              })`,
            ],
          };
        }
        return { pass: true };
      },
    },
    "host-reachable": {
      description:
        "The Firecracker host must answer over SSH before deploying or driving the task server",
      labels: ["live"],
      execute: async (context) => {
        const host = context.globalArgs?.host;
        const user = context.globalArgs?.user ?? "root";
        if (!isValidSshHost(host)) {
          return { pass: false, errors: ["globalArgs.host is not set"] };
        }
        const res = await sshExecRaw(host, user, "echo ready");
        if (res.code !== 0 || res.stdout.trim() !== "ready") {
          return {
            pass: false,
            errors: [
              `SSH host ${host} is not reachable (exit ${res.code}): ${
                res.stderr.trim().slice(-200)
              }`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    deploy: {
      description:
        "Write tap-server.py to the Firecracker host and start it. The server listens on tapIp:tapPort (TCP) and serves task JSON (with OAuth token injected) on GET /task and accepts results on POST /result.",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, tapIp, tapPort, oauthToken } = context.globalArgs;

        const serverPath = `/tmp/fc-tap-server-${tapPort}.py`;
        const pidFile = `/tmp/fc-tap-server-${tapPort}.pid`;
        const taskPath = `/tmp/fc-task-${tapPort}.json`;
        const resultPath = `/tmp/fc-result-${tapPort}.txt`;

        const b64Script = btoa(TAP_SERVER_PY);

        const startCmd = [
          // Precision-kill any existing server for this port
          `if [ -f ${shellEsc(pidFile)} ]; then`,
          `  OLD=$(cat ${shellEsc(pidFile)});`,
          `  kill "$OLD" 2>/dev/null; sleep 0.2; kill -9 "$OLD" 2>/dev/null;`,
          `  rm -f ${shellEsc(pidFile)};`,
          `fi`,
          `echo ${shellEsc(b64Script)} | base64 -d > ${shellEsc(serverPath)}`,
          `chmod +x ${shellEsc(serverPath)}`,
          `export FC_OAUTH_TOKEN=${shellEsc(oauthToken)}`,
          `export FC_TASK_PATH=${shellEsc(taskPath)}`,
          `export FC_RESULT_PATH=${shellEsc(resultPath)}`,
          `export FC_BIND_IP=${shellEsc(tapIp)}`,
          `export FC_BIND_PORT=${tapPort}`,
          `( python3 ${
            shellEsc(serverPath)
          } serve > /tmp/fc-tap-server-${tapPort}.log 2>&1 & SRV=$!; echo $SRV > ${
            shellEsc(pidFile)
          }; echo $SRV )`,
        ].join("\n");

        const result = await sshExec(host, user, startCmd);
        const pid = parseInt(result.stdout.trim(), 10);

        // Wait for server to bind TCP port before returning
        await sshExec(
          host,
          user,
          `for i in $(seq 1 30); do ` +
            `python3 -c "import socket; s=socket.socket(); s.settimeout(0.1); s.connect((${
              shellEsc(tapIp)
            }, ${tapPort})); s.close()" 2>/dev/null && exit 0; sleep 0.1; done; ` +
            `echo "tap-server not ready after 3s" >&2; exit 1`,
        );

        context.logger.info(
          `tap-server started and ready: pid=${pid} ${tapIp}:${tapPort}`,
        );
        const handle = await context.writeResource("serverState", "current", {
          pid,
          tapIp,
          tapPort,
          status: "running",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    inject_task: {
      description:
        "Write task manifest to file; tap-server's GET /task handler will include it in the next response to the guest.",
      arguments: z.object({
        prompt: z.string().describe("Task prompt for claude"),
        gitRepoUrl: z.union([z.literal(""), z.string().regex(HTTPS_URL_RE)])
          .optional().describe(
            "HTTPS git repo URL to clone inside the guest before running the task",
          ),
        model: z.string().optional().describe(
          "Claude model id passed to `claude --print --model` inside the guest (e.g. claude-opus-4-8, claude-haiku-4-5-20251001). Empty/omitted uses Claude Code's default.",
        ),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low")
          .describe(
            "Reasoning effort passed to `claude --print --effort` inside the guest. Defaults to 'low' to keep sandboxed agent runs fast and cheap; raise per task when the work is intelligence-sensitive. 'max' is Opus-tier only.",
          ),
      }),
      execute: async (args, context) => {
        const { host, user, tapPort } = context.globalArgs;

        const task = {
          prompt: args.prompt,
          ...(args.gitRepoUrl ? { gitRepoUrl: args.gitRepoUrl } : {}),
          ...(args.model ? { model: args.model } : {}),
          effort: args.effort,
        };
        const taskJson = shellEsc(JSON.stringify(task));

        const serverPath = `/tmp/fc-tap-server-${tapPort}.py`;
        const taskPath = `/tmp/fc-task-${tapPort}.json`;
        const resultPath = `/tmp/fc-result-${tapPort}.txt`;

        await sshExec(
          host,
          user,
          `FC_TASK_PATH=${shellEsc(taskPath)} FC_RESULT_PATH=${
            shellEsc(resultPath)
          } python3 ${shellEsc(serverPath)} inject ${taskJson}`,
        );
        context.logger.info(`task injected: "${args.prompt.slice(0, 60)}..."`);
        const handle = await context.writeResource("action", "inject_task", {
          action: "inject_task",
          success: true,
          message: `Task injected: ${args.prompt.slice(0, 80)}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    collect_result: {
      description:
        "Poll for result file written by guest POST /result. Blocks until agent completes or timeout.",
      arguments: z.object({
        timeoutSeconds: z.number().int().min(10).max(3600).default(300),
      }),
      execute: async (args, context) => {
        const { host, user, tapPort } = context.globalArgs;

        const serverPath = `/tmp/fc-tap-server-${tapPort}.py`;
        const taskPath = `/tmp/fc-task-${tapPort}.json`;
        const resultPath = `/tmp/fc-result-${tapPort}.txt`;

        const result = await sshExec(
          host,
          user,
          `FC_TASK_PATH=${shellEsc(taskPath)} FC_RESULT_PATH=${
            shellEsc(resultPath)
          } python3 ${shellEsc(serverPath)} collect ${args.timeoutSeconds}`,
        );

        const stdout = result.stdout;
        context.logger.info(`result collected: ${stdout.length} bytes`);
        const handle = await context.writeResource("taskResult", "output", {
          stdout,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Kill the tap-server process via PID sidecar.",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, tapPort } = context.globalArgs;

        const serverPath = `/tmp/fc-tap-server-${tapPort}.py`;
        const pidFile = `/tmp/fc-tap-server-${tapPort}.pid`;
        const cmd = [
          `if [ -f ${shellEsc(pidFile)} ]; then`,
          `  PID=$(cat ${shellEsc(pidFile)});`,
          `  kill "$PID" 2>/dev/null; sleep 0.3;`,
          `  kill -9 "$PID" 2>/dev/null;`,
          `  rm -f ${shellEsc(pidFile)};`,
          `fi`,
          `rm -f ${shellEsc(serverPath)}`,
          `echo stopped`,
        ].join("\n");
        await sshExec(host, user, cmd);

        context.logger.info("tap-server stopped");
        const handle = await context.writeResource("serverState", "current", {
          tapIp: context.globalArgs.tapIp,
          tapPort,
          status: "stopped",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
