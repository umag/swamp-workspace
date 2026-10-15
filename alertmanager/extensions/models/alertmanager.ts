import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  url: z.string().url().describe(
    "Alertmanager base URL, e.g. http://alertmanager.example:9093",
  ),
  timeoutMs: z.number().int().positive().default(15000).describe(
    "Per-request timeout in milliseconds",
  ),
});

const MatcherSchema = z.object({
  name: z.string(),
  value: z.string(),
  isRegex: z.boolean(),
  isEqual: z.boolean(),
});

/** One label matcher in Alertmanager's v2 API shape. */
export type Matcher = z.infer<typeof MatcherSchema>;

const AlertSchema = z.object({
  alertname: z.string(),
  severity: z.union([z.string(), z.null()]),
  state: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  startsAt: z.string(),
  endsAt: z.string(),
  updatedAt: z.string(),
  fingerprint: z.string(),
  generatorURL: z.string(),
  receivers: z.array(z.string()),
  silencedBy: z.array(z.string()),
  inhibitedBy: z.array(z.string()),
});

/** An alert as stored in the `alerts` and `groups` resources. */
export type Alert = z.infer<typeof AlertSchema>;

const CountsSchema = z.object({
  total: z.number(),
  byState: z.record(z.string(), z.number()),
  bySeverity: z.record(z.string(), z.number()),
  byAlertname: z.record(z.string(), z.number()),
});

const AlertsResultSchema = z.object({
  query: z.object({
    active: z.boolean(),
    silenced: z.boolean(),
    inhibited: z.boolean(),
    unprocessed: z.boolean(),
    filter: z.array(z.string()),
    receiver: z.union([z.string(), z.null()]),
  }),
  alerts: z.array(AlertSchema),
  counts: CountsSchema,
  timestamp: z.string(),
});

const GroupsResultSchema = z.object({
  groups: z.array(z.object({
    receiver: z.string(),
    labels: z.record(z.string(), z.string()),
    alerts: z.array(AlertSchema),
  })),
  totalAlerts: z.number(),
  timestamp: z.string(),
});

const SilenceSchema = z.object({
  id: z.string(),
  state: z.string(),
  matchers: z.array(MatcherSchema),
  startsAt: z.string(),
  endsAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  comment: z.string(),
});

/** A silence as stored in the `silences` and `silence` resources. */
export type Silence = z.infer<typeof SilenceSchema>;

const SilencesResultSchema = z.object({
  state: z.string(),
  filter: z.array(z.string()),
  silences: z.array(SilenceSchema),
  timestamp: z.string(),
});

const StatusResultSchema = z.object({
  version: z.string(),
  revision: z.string(),
  goVersion: z.string(),
  uptime: z.string(),
  clusterStatus: z.string(),
  clusterName: z.string(),
  peers: z.array(z.object({ name: z.string(), address: z.string() })),
  configSha256: z.string(),
  timestamp: z.string(),
});

const SilenceActionSchema = SilenceSchema.extend({
  action: z.enum(["created", "extended", "unchanged", "expired"]),
  timestamp: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type Ctx = {
  globalArgs: Record<string, unknown>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
};

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SILENCE_ID = /^[0-9a-fA-F-]{8,64}$/;

/**
 * Splits a matcher list on commas that are not inside a double-quoted value,
 * so `msg="a,b",job=x` is two matchers, not three.
 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && quoted && i + 1 < input.length) {
      cur += ch + input[i + 1];
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quoted) throw new Error(`unterminated quote in matchers: ${input}`);
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return v;
}

/**
 * Parses a comma-separated matcher list in Alertmanager's own syntax —
 * `name=value`, `name!=value`, `name=~regex`, `name!~regex` — into v2 API
 * matchers. Values may be double-quoted to carry commas. Braces around the
 * whole list (`{a="b"}`) are accepted, as amtool prints them that way.
 */
export function parseMatchers(input: string): Matcher[] {
  let s = String(input).trim();
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1);
  return splitTopLevel(s).map((part) => {
    const m = part.match(/^([^=!~\s]+)\s*(=~|!~|!=|=)\s*(.*)$/s);
    if (!m) throw new Error(`invalid matcher: ${part}`);
    const [, name, op, rawValue] = m;
    if (!LABEL_NAME.test(name)) {
      throw new Error(`invalid label name in matcher: ${name}`);
    }
    const value = unquote(rawValue);
    if (op === "=~" || op === "!~") {
      try {
        new RegExp(`^(?:${value})$`);
      } catch {
        throw new Error(`invalid regex in matcher ${name}${op}${value}`);
      }
    }
    return {
      name,
      value,
      isRegex: op === "=~" || op === "!~",
      isEqual: op === "=" || op === "=~",
    };
  });
}

/**
 * Renders a matcher back to the `filter=` query-parameter syntax the v2 API
 * accepts, quoting and escaping the value so it round-trips through
 * `parseMatchers`.
 */
export function formatMatcher(m: Matcher): string {
  const op = m.isRegex ? (m.isEqual ? "=~" : "!~") : (m.isEqual ? "=" : "!=");
  const escaped = m.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${m.name}${op}"${escaped}"`;
}

/**
 * Order-insensitive matcher-set equality. Used to find an existing silence
 * that already covers a requested one, so `create-silence` is idempotent.
 */
export function sameMatchers(a: Matcher[], b: Matcher[]): boolean {
  if (a.length !== b.length) return false;
  const key = (m: Matcher) => formatMatcher(m);
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}

function strRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = String(val);
  }
  return out;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Flattens one v2 `gettableAlert` into the stored shape. Missing or wrongly
 * typed fields degrade to empty values rather than throwing, so one odd alert
 * cannot hide every other alert in the response.
 */
export function normalizeAlert(raw: unknown): Alert {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const labels = strRecord(a.labels);
  const status =
    (a.status && typeof a.status === "object" ? a.status : {}) as Record<
      string,
      unknown
    >;
  const receivers = Array.isArray(a.receivers)
    ? a.receivers.map((r) =>
      r && typeof r === "object"
        ? str((r as Record<string, unknown>).name)
        : str(r)
    )
    : [];
  return {
    alertname: labels.alertname ?? "",
    severity: labels.severity ?? null,
    state: str(status.state) || "unknown",
    labels,
    annotations: strRecord(a.annotations),
    startsAt: str(a.startsAt),
    endsAt: str(a.endsAt),
    updatedAt: str(a.updatedAt),
    fingerprint: str(a.fingerprint),
    generatorURL: str(a.generatorURL),
    receivers,
    silencedBy: strArray(status.silencedBy),
    inhibitedBy: strArray(status.inhibitedBy),
  };
}

/** Flattens one v2 `gettableSilence` into the stored shape. */
export function normalizeSilence(raw: unknown): Silence {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const status =
    (s.status && typeof s.status === "object" ? s.status : {}) as Record<
      string,
      unknown
    >;
  const matchers = Array.isArray(s.matchers)
    ? s.matchers.map((m) => {
      const r = (m && typeof m === "object" ? m : {}) as Record<
        string,
        unknown
      >;
      return {
        name: str(r.name),
        value: str(r.value),
        isRegex: r.isRegex === true,
        // The v2 API defaults isEqual to true when omitted.
        isEqual: r.isEqual !== false,
      };
    })
    : [];
  return {
    id: str(s.id),
    state: str(status.state) || "unknown",
    matchers,
    startsAt: str(s.startsAt),
    endsAt: str(s.endsAt),
    updatedAt: str(s.updatedAt),
    createdBy: str(s.createdBy),
    comment: str(s.comment),
  };
}

/** Tallies alerts by state, severity and alertname. */
export function countAlerts(alerts: Alert[]): z.infer<typeof CountsSchema> {
  const byState: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byAlertname: Record<string, number> = {};
  for (const a of alerts) {
    byState[a.state] = (byState[a.state] ?? 0) + 1;
    const sev = a.severity ?? "none";
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    byAlertname[a.alertname] = (byAlertname[a.alertname] ?? 0) + 1;
  }
  return { total: alerts.length, byState, bySeverity, byAlertname };
}

/**
 * Builds an API URL under the configured base. Query parameters may repeat
 * (`filter` is one parameter per matcher), so they are passed as pairs.
 */
export function buildUrl(
  base: string,
  path: string,
  params: [string, string][] = [],
): string {
  const u = new URL(base.replace(/\/+$/, "") + path);
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

async function amFetch(
  g: GlobalArgs,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: [string, string][] = [],
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = buildUrl(g.url, path, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), g.timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(
        `Alertmanager ${method} ${path} failed: HTTP ${res.status}: ${
          text.slice(0, 300)
        }`,
      );
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    let json: unknown = null;
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(
          `Alertmanager ${method} ${path} returned non-JSON: ${
            text.slice(0, 300)
          }`,
        );
      }
    }
    return { status: res.status, json };
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(
        `Alertmanager ${method} ${path} timed out after ${g.timeoutMs}ms`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function requireArray(json: unknown, what: string): unknown[] {
  if (!Array.isArray(json)) {
    throw new Error(`Alertmanager ${what} response is not an array`);
  }
  return json;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function alertFilterParams(args: {
  active: boolean;
  silenced: boolean;
  inhibited: boolean;
  unprocessed?: boolean;
  filter?: string;
  receiver?: string;
}): { params: [string, string][]; filters: string[] } {
  const filters = args.filter
    ? parseMatchers(args.filter).map(formatMatcher)
    : [];
  const params: [string, string][] = [
    ["active", String(args.active)],
    ["silenced", String(args.silenced)],
    ["inhibited", String(args.inhibited)],
  ];
  if (args.unprocessed !== undefined) {
    params.push(["unprocessed", String(args.unprocessed)]);
  }
  for (const f of filters) params.push(["filter", f]);
  if (args.receiver) params.push(["receiver", args.receiver]);
  return { params, filters };
}

const FilterArgs = {
  active: z.boolean().default(true).describe("Include active alerts"),
  silenced: z.boolean().default(false).describe("Include silenced alerts"),
  inhibited: z.boolean().default(false).describe("Include inhibited alerts"),
  filter: z.string().optional().describe(
    'Label matchers, comma-separated: alertname="X",severity=~"crit.*"',
  ),
  receiver: z.string().optional().describe(
    "Regex matched against receiver names",
  ),
};

const AlertsArgs = z.object({
  ...FilterArgs,
  unprocessed: z.boolean().default(false).describe(
    "Include alerts not yet processed by the dispatcher",
  ),
});
const GroupsArgs = z.object(FilterArgs);
const SilencesArgs = z.object({
  state: z.enum(["active", "pending", "expired", "all"]).default("active")
    .describe("Silence state to keep"),
  filter: z.string().optional().describe(
    "Label matchers, comma-separated, as for alerts",
  ),
});
const CreateSilenceArgs = z.object({
  matchers: z.string().min(1).describe(
    'Label matchers, comma-separated: alertname="X",instance="y"',
  ),
  durationMinutes: z.number().positive().max(60 * 24 * 365).default(60)
    .describe("How long the silence lasts, from now"),
  comment: z.string().min(1).describe("Why the alerts are silenced"),
  createdBy: z.string().min(1).default("swamp").describe(
    "Author recorded on the silence",
  ),
});
const ExpireSilenceArgs = z.object({
  id: z.string().regex(SILENCE_ID).describe("Silence id"),
});

function silenceId(id: string): string {
  if (!SILENCE_ID.test(id)) throw new Error(`invalid silence id: ${id}`);
  return id;
}

/**
 * `@magistr/alertmanager` — the Prometheus Alertmanager v2 HTTP API. Reads
 * alerts, alert groups, silences and server status; creates/extends and
 * expires silences idempotently.
 */
export const model = {
  type: "@magistr/alertmanager",
  version: "2026.10.15.6",
  upgrades: [
    {
      toVersion: "2026.10.15.1",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.2",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.3",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.4",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.5",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.6",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    "alerts": {
      description: "Alerts matching the query, with per-state counts",
      schema: AlertsResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "groups": {
      description: "Alerts grouped by the routing tree's group_by labels",
      schema: GroupsResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "silences": {
      description: "Silences in the requested state",
      schema: SilencesResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "status": {
      description:
        "Server version, uptime and cluster state; the config is recorded as a SHA-256 only, never as text",
      schema: StatusResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "silence": {
      description: "Outcome of a create-silence or expire-silence call",
      schema: SilenceActionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "alerts": {
      description:
        "List alerts. Defaults to active, not silenced, not inhibited — the alerts that are notifying now.",
      arguments: AlertsArgs,
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const args = AlertsArgs.parse(rawArgs);
        const { params, filters } = alertFilterParams(args);
        const { json } = await amFetch(g, "GET", "/api/v2/alerts", params);
        const alerts = requireArray(json, "alerts").map(normalizeAlert)
          .sort((a, b) =>
            a.alertname.localeCompare(b.alertname) ||
            a.startsAt.localeCompare(b.startsAt)
          );
        const counts = countAlerts(alerts);
        const handle = await context.writeResource("alerts", "alerts", {
          query: {
            active: args.active,
            silenced: args.silenced,
            inhibited: args.inhibited,
            unprocessed: args.unprocessed,
            filter: filters,
            receiver: args.receiver ?? null,
          },
          alerts,
          counts,
          timestamp: new Date().toISOString(),
        });
        const names = Object.entries(counts.byAlertname)
          .map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(", ");
        return {
          dataHandles: [handle],
          summary: `${counts.total} alert(s)${names ? `: ${names}` : ""}`,
        };
      },
    },

    "groups": {
      description: "List alert groups as the routing tree groups them",
      arguments: GroupsArgs,
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const args = GroupsArgs.parse(rawArgs);
        const { params } = alertFilterParams(args);
        const { json } = await amFetch(
          g,
          "GET",
          "/api/v2/alerts/groups",
          params,
        );
        const groups = requireArray(json, "groups").map((raw) => {
          const r = (raw && typeof raw === "object" ? raw : {}) as Record<
            string,
            unknown
          >;
          const recv = r.receiver && typeof r.receiver === "object"
            ? str((r.receiver as Record<string, unknown>).name)
            : str(r.receiver);
          return {
            receiver: recv,
            labels: strRecord(r.labels),
            alerts: Array.isArray(r.alerts) ? r.alerts.map(normalizeAlert) : [],
          };
        });
        const totalAlerts = groups.reduce((n, gr) => n + gr.alerts.length, 0);
        const handle = await context.writeResource("groups", "groups", {
          groups,
          totalAlerts,
          timestamp: new Date().toISOString(),
        });
        return {
          dataHandles: [handle],
          summary: `${groups.length} group(s), ${totalAlerts} alert(s)`,
        };
      },
    },

    "silences": {
      description: "List silences, filtered by state and label matchers",
      arguments: SilencesArgs,
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const args = SilencesArgs.parse(rawArgs);
        const filters = args.filter
          ? parseMatchers(args.filter).map(formatMatcher)
          : [];
        const { json } = await amFetch(
          g,
          "GET",
          "/api/v2/silences",
          filters.map((f): [string, string] => ["filter", f]),
        );
        const silences = requireArray(json, "silences").map(normalizeSilence)
          .filter((s) => args.state === "all" || s.state === args.state)
          .sort((a, b) => a.endsAt.localeCompare(b.endsAt));
        const handle = await context.writeResource("silences", "silences", {
          state: args.state,
          filter: filters,
          silences,
          timestamp: new Date().toISOString(),
        });
        return {
          dataHandles: [handle],
          summary: `${silences.length} ${args.state} silence(s)`,
        };
      },
    },

    "status": {
      description:
        "Read server version, uptime and cluster state. The running config is hashed, not stored — it can hold receiver secrets.",
      arguments: z.object({}),
      execute: async (_rawArgs: Record<string, unknown>, context: Ctx) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const { json } = await amFetch(g, "GET", "/api/v2/status");
        if (!json || typeof json !== "object" || Array.isArray(json)) {
          throw new Error("Alertmanager status response is not an object");
        }
        const s = json as Record<string, unknown>;
        const obj = (v: unknown) =>
          (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
        const cluster = obj(s.cluster);
        const ver = obj(s.versionInfo);
        const peers = Array.isArray(cluster.peers)
          ? cluster.peers.map((p) => ({
            name: str(obj(p).name),
            address: str(obj(p).address),
          }))
          : [];
        const handle = await context.writeResource("status", "status", {
          version: str(ver.version),
          revision: str(ver.revision),
          goVersion: str(ver.goVersion),
          uptime: str(s.uptime),
          clusterStatus: str(cluster.status),
          clusterName: str(cluster.name),
          peers,
          configSha256: await sha256Hex(str(obj(s.config).original)),
          timestamp: new Date().toISOString(),
        });
        return {
          dataHandles: [handle],
          summary: `Alertmanager ${str(ver.version)}, cluster ${
            str(cluster.status)
          }, ${peers.length} peer(s)`,
        };
      },
    },

    "create-silence": {
      description:
        "Silence alerts matching the given matchers. Idempotent: an existing active/pending silence with the same matchers and comment is reused, and extended only if it would end sooner than requested.",
      arguments: CreateSilenceArgs,
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const args = CreateSilenceArgs.parse(rawArgs);
        const matchers = parseMatchers(args.matchers);
        if (matchers.length === 0) {
          throw new Error("create-silence needs at least one matcher");
        }
        const now = Date.now();
        const startsAt = new Date(now).toISOString();
        const endsAt = new Date(now + args.durationMinutes * 60_000)
          .toISOString();

        // Read state first: reuse a silence that already covers this one.
        const { json } = await amFetch(g, "GET", "/api/v2/silences");
        const existing = requireArray(json, "silences").map(normalizeSilence)
          .find((s) =>
            (s.state === "active" || s.state === "pending") &&
            s.comment === args.comment && sameMatchers(s.matchers, matchers)
          );

        let action: "created" | "extended" | "unchanged";
        let id: string;
        let finalStart = startsAt;
        let finalEnd = endsAt;
        if (existing && Date.parse(existing.endsAt) >= Date.parse(endsAt)) {
          action = "unchanged";
          id = existing.id;
          finalStart = existing.startsAt;
          finalEnd = existing.endsAt;
        } else {
          const body: Record<string, unknown> = {
            matchers,
            startsAt: existing ? existing.startsAt : startsAt,
            endsAt,
            createdBy: args.createdBy,
            comment: args.comment,
          };
          if (existing) body.id = existing.id;
          const res = await amFetch(
            g,
            "POST",
            "/api/v2/silences",
            [],
            body,
          );
          const newId = str(
            (res.json as Record<string, unknown> | null)?.silenceID,
          );
          if (!newId) {
            throw new Error("Alertmanager did not return a silenceID");
          }
          id = newId;
          action = existing ? "extended" : "created";
          if (existing) finalStart = existing.startsAt;
        }

        const handle = await context.writeResource(
          "silence",
          `silence-${silenceId(id)}`,
          {
            id,
            state: action === "unchanged" ? existing!.state : "active",
            matchers,
            startsAt: finalStart,
            endsAt: finalEnd,
            updatedAt: new Date().toISOString(),
            createdBy: action === "unchanged"
              ? existing!.createdBy
              : args.createdBy,
            comment: args.comment,
            action,
            timestamp: new Date().toISOString(),
          },
        );
        return {
          dataHandles: [handle],
          summary: `Silence ${id} ${action}, ends ${finalEnd}`,
        };
      },
    },

    "expire-silence": {
      description:
        "Expire a silence by id. Reads it first; an already-expired silence is left alone.",
      arguments: ExpireSilenceArgs,
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const args = ExpireSilenceArgs.parse(rawArgs);
        const id = silenceId(args.id);
        const path = `/api/v2/silence/${encodeURIComponent(id)}`;
        const { json } = await amFetch(g, "GET", path);
        const current = normalizeSilence(json);
        let action: "expired" | "unchanged" = "unchanged";
        if (current.state !== "expired") {
          await amFetch(g, "DELETE", path);
          action = "expired";
        }
        const handle = await context.writeResource(
          "silence",
          `silence-${id}`,
          {
            ...current,
            id,
            state: "expired",
            action,
            timestamp: new Date().toISOString(),
          },
        );
        return {
          dataHandles: [handle],
          summary: `Silence ${id} ${action}`,
        };
      },
    },
  },
};
