import { z } from "npm:zod@4";

/**
 * @magistr/observability/agent
 *
 * Installs and configures a host-native metrics + logs agent on a remote
 * Debian/Ubuntu host over SSH, for a VictoriaMetrics (pull) + VictoriaLogs
 * (push via Vector) backend:
 *
 *   - prometheus-node-exporter  — host metrics on <bindAddress>:<nodePort>
 *   - prometheus-blackbox-exporter — synthetic HTTP/ICMP probes on
 *     <bindAddress>:<blackboxPort>
 *   - vector — tails nginx + syslog files and ships them to VictoriaLogs'
 *     Elasticsearch-bulk ingestion endpoint
 *
 * Exporters bind to <bindAddress> only (set it to a WireGuard tunnel IP to
 * keep them off the public interface). Everything runs over SSH; no agent
 * daemon or compose stack is required on the swamp host.
 */

const GlobalArgsSchema = z.object({
  sshHost: z.string().describe("SSH hostname or IP of the target host"),
  sshUser: z.string().default("root").describe("SSH user (default root)"),
  sshPort: z.number().int().default(22).describe("SSH port (default 22)"),
  bindAddress: z
    .string()
    .default("0.0.0.0")
    .describe(
      "Address the exporters listen on. Set to a WireGuard tunnel IP to keep them off the public interface.",
    ),
  nodePort: z.number().int().default(9100).describe("node_exporter port"),
  blackboxPort: z.number().int().default(9115).describe("blackbox port"),
  logsEndpoint: z
    .string()
    .optional()
    .describe(
      "VictoriaLogs Elasticsearch-bulk endpoint, e.g. http://192.168.88.242:9428/insert/elasticsearch/ . When unset, Vector is not configured.",
    ),
  hostLabel: z
    .string()
    .optional()
    .describe("host label attached to shipped logs (defaults to sshHost)"),
  vectorVersion: z
    .string()
    .default("0.46.1")
    .describe("Vector .deb version to install from packages.timber.io"),
  bindWaitUnit: z
    .string()
    .optional()
    .describe(
      "systemd unit the exporters must start after (e.g. wg-quick@wg0.service) when bindAddress lives on an interface brought up late at boot — such as a WireGuard tunnel IP. Prevents a bind-before-interface-up race.",
    ),
});

const InstallSchema = z.object({
  nodeExporter: z.string(),
  blackbox: z.string(),
  vector: z.string(),
  timestamp: z.string(),
});

const ConfigSchema = z.object({
  bindAddress: z.string(),
  nodePort: z.number(),
  blackboxPort: z.number(),
  logsEndpoint: z.string().optional(),
  logFiles: z.array(z.string()),
  hostLabel: z.string(),
  vectorConfigured: z.boolean(),
  timestamp: z.string(),
});

const StatusSchema = z.object({
  services: z.record(z.string(), z.string()),
  listeners: z.record(z.string(), z.boolean()),
  timestamp: z.string(),
});

const InventorySchema = z.object({
  runningServices: z.array(z.string()),
  listeners: z.array(z.object({
    proto: z.string(),
    local: z.string(),
    process: z.string(),
  })),
  processes: z.array(z.object({ name: z.string(), count: z.number() })),
  serviceCount: z.number(),
  listenerCount: z.number(),
  timestamp: z.string(),
});

/** Run a bash script on the remote host over SSH, feeding it via stdin. */
async function sshScript(g, script) {
  // @ts-ignore - Deno API
  const proc = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-p",
      String(g.sshPort ?? 22),
      `${g.sshUser ?? "root"}@${g.sshHost}`,
      "bash -s",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = proc.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(script));
  await w.close();
  const result = await child.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0) {
    throw new Error(
      `SSH script failed on ${g.sshHost} (exit ${result.code}):\n${
        stderr.slice(-1200)
      }`,
    );
  }
  return { stdout, stderr };
}

/** Base64 a config blob and return a bash snippet that writes it to `path`. */
function writeRemoteFile(path, content) {
  const b64 = btoa(content);
  return [
    `mkdir -p "$(dirname '${path}')"`,
    `echo '${b64}' | base64 -d > '${path}'`,
  ].join("\n");
}

/** Parse "KEY=value" lines emitted by remote scripts into an object. */
function parseKv(stdout) {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function nodeDefaults(g) {
  const args = [
    `--web.listen-address=${g.bindAddress}:${g.nodePort}`,
    "--collector.textfile.directory=/var/lib/prometheus/node-exporter",
  ].join(" ");
  return `ARGS="${args}"\n`;
}

function blackboxDefaults(g) {
  const args =
    `--web.listen-address=${g.bindAddress}:${g.blackboxPort} --config.file=/etc/prometheus/blackbox.yml`;
  return `ARGS="${args}"\n`;
}

const BLACKBOX_YML = `modules:
  # For internal services fronted by a redirect (e.g. gonic -> 303). Accepts
  # the common "service is alive" status codes without following redirects.
  http_2xx:
    prober: http
    timeout: 8s
    http:
      valid_status_codes: [200, 204, 301, 302, 303, 307, 308, 401, 403]
      follow_redirects: false
      preferred_ip_protocol: ip4
      ip_protocol_fallback: false
  # End-to-end public probe: follows redirects, must terminate TLS, wants a 2xx.
  http_public:
    prober: http
    timeout: 10s
    http:
      follow_redirects: true
      fail_if_not_ssl: true
      valid_status_codes: []
      preferred_ip_protocol: ip4
      ip_protocol_fallback: false
  icmp:
    prober: icmp
    timeout: 5s
    icmp:
      preferred_ip_protocol: ip4
`;

const BLACKBOX_CAP_OVERRIDE = `[Service]
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
`;

const VECTOR_SVC_OVERRIDE = `[Service]
ExecStart=
ExecStart=/usr/bin/vector --config /etc/vector/vector.yaml
`;

/**
 * Boot-resilience drop-in: order the exporter after the interface that owns
 * bindAddress (when bindWaitUnit is set) and retry forever if the bind address
 * is not up yet. Without this, an exporter bound to a WireGuard tunnel IP
 * fails permanently at boot if it starts before wg0 is up.
 */
function bootDropin(g) {
  const waitLines = g.bindWaitUnit
    ? `After=${g.bindWaitUnit} network-online.target\n` +
      `Wants=${g.bindWaitUnit} network-online.target\n`
    : "";
  return `[Unit]
${waitLines}StartLimitIntervalSec=0
[Service]
Restart=on-failure
RestartSec=5
`;
}

function vectorConfig(g, logFiles) {
  const label = g.hostLabel ?? g.sshHost;
  const includes = logFiles.map((f) => `      - ${f}`).join("\n");
  return `data_dir: /var/lib/vector
api:
  enabled: false
sources:
  logs:
    type: file
    include:
${includes}
    ignore_older_secs: 86400
transforms:
  enrich:
    type: remap
    inputs: [logs]
    source: |
      .host = "${label}"
      .source_type = "file"
      .message = to_string(.message) ?? .message
sinks:
  victorialogs:
    type: elasticsearch
    inputs: [enrich]
    endpoints: ["${g.logsEndpoint}"]
    mode: bulk
    api_version: v8
    compression: gzip
    healthcheck:
      enabled: false
    request:
      headers:
        VL-Stream-Fields: host,source_type,file
        VL-Time-Field: timestamp
        VL-Msg-Field: message
        AccountID: "0"
        ProjectID: "0"
`;
}

export const model = {
  type: "@magistr/observability/agent",
  version: "2026.07.02.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    install: {
      description: "Installed agent package versions",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    config: {
      description: "Applied agent configuration",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "Live health of the agent services + listeners",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    inventory: {
      description:
        "Complete host inventory: running systemd services, all TCP/UDP listeners with owning process, and process rollup",
      schema: InventorySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    install: {
      description:
        "Install prometheus-node-exporter, prometheus-blackbox-exporter, and vector on the target host (idempotent).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const vv = g.vectorVersion ?? "0.46.1";
        const deb =
          `https://packages.timber.io/vector/${vv}/vector_${vv}-1_amd64.deb`;
        const script = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq prometheus-node-exporter prometheus-blackbox-exporter >/dev/null
if ! command -v vector >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/vector.deb" "${deb}"
  apt-get install -y -qq "$tmp/vector.deb" >/dev/null 2>&1 || { dpkg -i "$tmp/vector.deb" >/dev/null 2>&1 || true; apt-get -f install -y -qq >/dev/null; }
  rm -rf "$tmp"
fi
echo "NODE=$(prometheus-node-exporter --version 2>&1 | head -1 | awk '{print $3}')"
echo "BLACKBOX=$(prometheus-blackbox-exporter --version 2>&1 | head -1 | awk '{print $3}')"
echo "VECTOR=$(vector --version 2>&1 | head -1 | awk '{print $2}')"
`;
        const { stdout } = await sshScript(g, script);
        const kv = parseKv(stdout);
        const handle = await context.writeResource("install", "install", {
          nodeExporter: kv.NODE ?? "unknown",
          blackbox: kv.BLACKBOX ?? "unknown",
          vector: kv.VECTOR ?? "unknown",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description:
        "Write exporter + Vector configs (exporters bound to bindAddress), grant blackbox CAP_NET_RAW for ICMP, add the vector user to the adm group so it can read logs, then enable + restart all services.",
      arguments: z.object({
        logFiles: z
          .array(z.string())
          .default([
            "/var/log/nginx/access.log",
            "/var/log/nginx/error.log",
            "/var/log/syslog",
          ])
          .describe("Log files Vector should tail and ship to VictoriaLogs"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const logFiles = args.logFiles;
        const vectorConfigured = Boolean(g.logsEndpoint);

        const parts = [
          "set -euo pipefail",
          writeRemoteFile(
            "/etc/default/prometheus-node-exporter",
            nodeDefaults(g),
          ),
          "mkdir -p /var/lib/prometheus/node-exporter",
          writeRemoteFile("/etc/prometheus/blackbox.yml", BLACKBOX_YML),
          writeRemoteFile(
            "/etc/default/prometheus-blackbox-exporter",
            blackboxDefaults(g),
          ),
          writeRemoteFile(
            "/etc/systemd/system/prometheus-blackbox-exporter.service.d/override.conf",
            BLACKBOX_CAP_OVERRIDE,
          ),
          // boot-resilience: order after the tunnel + retry until the bind
          // address is available (fixes the wg0-not-up-yet race on reboot).
          writeRemoteFile(
            "/etc/systemd/system/prometheus-node-exporter.service.d/10-boot.conf",
            bootDropin(g),
          ),
          writeRemoteFile(
            "/etc/systemd/system/prometheus-blackbox-exporter.service.d/10-boot.conf",
            bootDropin(g),
          ),
          "systemctl daemon-reload",
          "systemctl enable --now prometheus-node-exporter >/dev/null 2>&1 || true",
          "systemctl restart prometheus-node-exporter",
          "systemctl enable --now prometheus-blackbox-exporter >/dev/null 2>&1 || true",
          "systemctl restart prometheus-blackbox-exporter",
        ];

        if (vectorConfigured) {
          parts.push(
            writeRemoteFile(
              "/etc/vector/vector.yaml",
              vectorConfig(g, logFiles),
            ),
            writeRemoteFile(
              "/etc/systemd/system/vector.service.d/override.conf",
              VECTOR_SVC_OVERRIDE,
            ),
            // vector runs as user `vector`; the adm group can read
            // /var/log/nginx + /var/log/syslog.
            "getent group adm >/dev/null && usermod -aG adm vector || true",
            "systemctl daemon-reload",
            "systemctl enable --now vector >/dev/null 2>&1 || true",
            "systemctl restart vector",
          );
        }

        parts.push(
          "sleep 2",
          'echo "NODE=$(systemctl is-active prometheus-node-exporter)"',
          'echo "BLACKBOX=$(systemctl is-active prometheus-blackbox-exporter)"',
          vectorConfigured
            ? 'echo "VECTOR=$(systemctl is-active vector)"'
            : 'echo "VECTOR=skipped"',
        );

        const { stdout } = await sshScript(g, parts.join("\n"));
        const kv = parseKv(stdout);
        const handle = await context.writeResource("config", "config", {
          bindAddress: g.bindAddress,
          nodePort: g.nodePort,
          blackboxPort: g.blackboxPort,
          logsEndpoint: g.logsEndpoint,
          logFiles,
          hostLabel: g.hostLabel ?? g.sshHost,
          vectorConfigured,
          timestamp: new Date().toISOString(),
        });
        // Surface non-active services as an error so the run fails loudly.
        const bad = Object.entries(kv).filter(
          ([, v]) => v !== "active" && v !== "skipped",
        );
        if (bad.length > 0) {
          throw new Error(
            `Service(s) not active after configure: ${
              bad.map(([k, v]) => `${k}=${v}`).join(", ")
            }`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report systemd state of the three agent services and whether each exporter is answering on its bound address.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const script = `set +e
echo "svc.node=$(systemctl is-active prometheus-node-exporter 2>/dev/null)"
echo "svc.blackbox=$(systemctl is-active prometheus-blackbox-exporter 2>/dev/null)"
echo "svc.vector=$(systemctl is-active vector 2>/dev/null)"
curl -sf --max-time 5 "http://${g.bindAddress}:${g.nodePort}/metrics" >/dev/null 2>&1 && echo "lst.node=ok" || echo "lst.node=fail"
curl -sf --max-time 5 "http://${g.bindAddress}:${g.blackboxPort}/metrics" >/dev/null 2>&1 && echo "lst.blackbox=ok" || echo "lst.blackbox=fail"
`;
        const { stdout } = await sshScript(g, script);
        const kv = parseKv(stdout);
        const services = {
          nodeExporter: kv["svc.node"] ?? "unknown",
          blackbox: kv["svc.blackbox"] ?? "unknown",
          vector: kv["svc.vector"] ?? "unknown",
        };
        const listeners = {
          nodeExporter: kv["lst.node"] === "ok",
          blackbox: kv["lst.blackbox"] === "ok",
        };
        const handle = await context.writeResource("status", "status", {
          services,
          listeners,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    inventory: {
      description:
        "Full host inventory over SSH: every running systemd service, every TCP/UDP listening socket with its owning process, and a process-name rollup. Use to audit exactly what is running/exposed on a host.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const script = `set +e
echo "===SERVICES==="
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}'
echo "===LISTENERS==="
ss -tulnpH 2>/dev/null
echo "===PROCS==="
ps -eo comm= 2>/dev/null | sort | uniq -c | sort -rn
`;
        const { stdout } = await sshScript(g, script);
        const runningServices: string[] = [];
        const listeners: {
          proto: string;
          local: string;
          process: string;
        }[] = [];
        const processes: { name: string; count: number }[] = [];
        let cur = "";
        for (const raw of stdout.split("\n")) {
          const line = raw.replace(/\r$/, "");
          if (line === "===SERVICES===") {
            cur = "services";
            continue;
          }
          if (line === "===LISTENERS===") {
            cur = "listeners";
            continue;
          }
          if (line === "===PROCS===") {
            cur = "procs";
            continue;
          }
          if (!line.trim()) continue;
          if (cur === "services") {
            runningServices.push(line.trim());
          } else if (cur === "listeners") {
            const f = line.trim().split(/\s+/);
            const pm = line.match(/users:\(\("([^"]+)"/);
            listeners.push({
              proto: f[0] ?? "",
              local: f[4] ?? "",
              process: pm ? pm[1] : "",
            });
          } else if (cur === "procs") {
            const m = line.trim().match(/^(\d+)\s+(.+)$/);
            if (m) processes.push({ name: m[2], count: Number(m[1]) });
          }
        }
        const handle = await context.writeResource(
          "inventory",
          "inventory",
          {
            runningServices,
            listeners,
            processes,
            serviceCount: runningServices.length,
            listenerCount: listeners.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
