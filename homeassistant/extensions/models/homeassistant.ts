import { z } from "npm:zod@4";

const InputSchema = z.object({
  host: z.string().describe("Home Assistant host (e.g., homeassistant.local)"),
  token: z.string().meta({ sensitive: true }).describe(
    "Long-lived access token - use vault: ${{ vault.get(my-vault, HA_TOKEN) }}",
  ),
  protocol: z.string().optional().describe(
    "Protocol (http or https, default: https)",
  ),
  wsTimeoutMs: z.number().int().positive().default(60000).describe(
    "WebSocket statistics request timeout in ms (default: 60000)",
  ),
});

/**
 * Redact the caller's own token from a server-controlled string. Coerces
 * every input shape (an `Error`'s `.message`, or anything else via
 * `String()`) to a string first, then replaces the exact token with
 * `<redacted>`. Strict no-op when `token` is falsy or the text doesn't
 * contain it, so every benign message (no token echo) stays byte-identical —
 * mirrors telegram-send's `redactToken`.
 */
function redactToken(message: unknown, token: string): string {
  const text = typeof message === "string"
    ? message
    : message instanceof Error
    ? message.message
    : String(message);
  return token ? text.split(token).join("<redacted>") : text;
}

/**
 * Build a redacted stand-in for a caught error's cause chain. `cause` must
 * NEVER be the raw caught error: `Deno.inspect()`/console formatting and
 * Deno's uncaught-error printer walk `.cause` (including its `.stack`, whose
 * first line embeds the message), so attaching the original as-is would
 * silently reopen the leak this helper exists to close. Returns a FRESH
 * single-level `Error` preserving `.name` and a redacted `.stack`; any deeper
 * nested cause on the original is intentionally dropped (mirrors
 * telegram-send/headphones precedent).
 */
function redactedCause(err: unknown, token: string): unknown {
  if (err instanceof Error) {
    const redacted = new Error(redactToken(err, token));
    redacted.name = err.name;
    if (typeof err.stack === "string") {
      redacted.stack = redactToken(err.stack, token);
    }
    return redacted;
  }
  return redactToken(err, token);
}

/**
 * Close a WebSocket, swallowing (never re-throwing) a close-time failure so
 * it can never clobber the real rejection reason already in flight. Unlike
 * the former silent `catch {}`, the failure is surfaced via
 * `logger.warning` (redacted) so it's diagnosable without changing behavior.
 */
function closeQuietly(
  ws: WebSocket,
  token: string,
  logger?: { warning: (...args: unknown[]) => void },
) {
  try {
    ws.close();
  } catch (e) {
    logger?.warning(`WebSocket close failed: ${redactToken(e, token)}`);
  }
}

async function fetchStatistics(
  host,
  token,
  protocol,
  statisticId,
  startTime,
  endTime,
  period,
  timeoutMs = 60000,
  logger?: { warning: (...args: unknown[]) => void },
): Promise<Record<string, unknown>[]> {
  const wsProto = (protocol || "https") === "https" ? "wss" : "ws";
  const wsUrl = `${wsProto}://${host}/api/websocket`;
  const requestId = 1;
  return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      closeQuietly(ws, token, logger);
      reject(new Error(`WebSocket timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        // A non-JSON frame can never become our expected result — fail fast
        // rather than silently waiting out the full timeout. The message is
        // static (never echoes `ev.data`, which is server-controlled) so
        // this can't reopen the LB4 token-leak surface.
        done = true;
        clearTimeout(timer);
        closeQuietly(ws, token, logger);
        reject(new Error("WebSocket received a non-JSON frame"));
        return;
      }
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (msg.type === "auth_ok") {
        ws.send(JSON.stringify({
          id: requestId,
          type: "recorder/statistics_during_period",
          start_time: startTime,
          end_time: endTime,
          statistic_ids: [statisticId],
          period,
        }));
      } else if (msg.type === "auth_invalid") {
        done = true;
        clearTimeout(timer);
        closeQuietly(ws, token, logger);
        reject(new Error(redactToken(`Auth invalid: ${msg.message}`, token)));
      } else if (msg.type === "result") {
        if (msg.id !== requestId) {
          // Not our command's response (e.g. a foreign/stale id on a
          // multiplexed socket) — ignore and keep waiting for the matching
          // result.
          return;
        }
        done = true;
        clearTimeout(timer);
        closeQuietly(ws, token, logger);
        if (!msg.success) {
          reject(
            new Error(
              redactToken(`WS error: ${JSON.stringify(msg.error)}`, token),
            ),
          );
          return;
        }
        const result = msg.result;
        if (result && typeof result === "object") {
          if (statisticId in result) {
            // Present key (including an explicitly empty array) — pass
            // through verbatim.
            resolve(result[statisticId] || []);
            return;
          }
          if (Object.keys(result).length === 0) {
            // HA omits the key entirely for a legitimately empty range —
            // an empty object is NOT malformed, resolve to no points.
            resolve([]);
            return;
          }
          // The frame has OTHER keys but not ours — we only ever request one
          // statistic id, so this is anomalous, not a legit empty range.
          reject(
            new Error(
              `Statistics response omitted requested statistic '${statisticId}'`,
            ),
          );
          return;
        }
        reject(new Error("Statistics response missing result payload"));
      }
    });
    ws.addEventListener("error", (e) => {
      done = true;
      clearTimeout(timer);
      const errEvent = e as Event & { message?: string };
      reject(
        new Error(
          redactToken(
            `WS error: ${errEvent.message || errEvent.type}`,
            token,
          ),
        ),
      );
    });
    ws.addEventListener("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error("WebSocket closed before result"));
    });
  });
}

async function haFetch(host, token, path, protocol, options: RequestInit = {}) {
  const proto = protocol || "https";
  const url = `${proto}://${host}/api${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (e) {
    throw new Error(redactToken(e, token), { cause: redactedCause(e, token) });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      redactToken(
        `HA API ${
          options.method || "GET"
        } ${path} failed: ${response.status} - ${body}`,
        token,
      ),
    );
  }

  return response.json();
}

/**
 * Home Assistant REST + WebSocket integration. Query entity states, call
 * services, list automations, and pull history/long-term statistics (with
 * optional VictoriaMetrics backfill) from a Home Assistant instance.
 */
export const model = {
  type: "@magistr/homeassistant",
  version: "2026.08.19.1",
  globalArguments: InputSchema,
  upgrades: [
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.08.01.1",
      description:
        "Lineage-repair bridge for the LB1/LB2 WS-hardening release (no data migration).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.01.1",
      toVersion: "2026.08.02.1",
      description: "Real-fix LB3-LB9: non-JSON-frame error, token redaction, " +
        "encodeURIComponent REST paths, sensitive token meta, symmetric " +
        "backfill fan-out (+ optional backfill-report.error), statistics " +
        "missing-key/empty distinction, defaulted wsTimeoutMs global arg + " +
        "surfaced close errors. Additive schema + defaulted global arg " +
        "only; no data migration.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.19.1",
      description: "Version bump and smoke test",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "states": {
      schema: z.object({
        entities: z.array(z.any()),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "service-result": {
      schema: z.object({
        domain: z.string(),
        service: z.string(),
        entityId: z.string().optional(),
        entityIds: z.array(z.string()).optional(),
        data: z.any().optional(),
        result: z.any().optional(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "services": {
      schema: z.object({
        domains: z.array(z.any()),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "entity-state": {
      schema: z.object({
        entityId: z.string(),
        state: z.string(),
        attributes: z.any(),
        lastChanged: z.string().optional(),
        lastUpdated: z.string().optional(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "automations": {
      schema: z.object({
        automations: z.array(z.any()),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "history": {
      schema: z.object({
        entityId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        points: z.array(z.object({
          t: z.string(),
          state: z.string(),
        })),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "history-csv": {
      schema: z.object({
        entityId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        csv: z.string(),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "statistics": {
      schema: z.object({
        statisticId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        period: z.string(),
        points: z.array(z.any()),
        count: z.number(),
        csv: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "backfill-report": {
      schema: z.object({
        vmUrl: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        period: z.string(),
        aggregator: z.string(),
        entities: z.array(z.object({
          entityId: z.string(),
          metricName: z.string(),
          points: z.number(),
          firstTs: z.string().optional(),
          lastTs: z.string().optional(),
          error: z.string().optional().describe(
            "Set when this entity's statistics fetch failed; its samples " +
              "are skipped but the fan-out continues for the rest",
          ),
        })),
        totalSamples: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "list-entities": {
      description:
        "List all entities, optionally filtered by domain (e.g., light, switch, automation)",
      arguments: z.object({
        domain: z.string().optional().describe(
          "Filter by domain (e.g., light, switch, automation, input_boolean)",
        ),
        search: z.string().optional().describe(
          "Filter by name/entity_id substring",
        ),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;

        const states = await haFetch(host, token, "/states", protocol);

        let entities = states.map((s) => ({
          entityId: s.entity_id,
          state: s.state,
          friendlyName: s.attributes?.friendly_name || "",
          domain: s.entity_id.split(".")[0],
          attributes: s.attributes,
        }));

        if (args.domain) {
          entities = entities.filter((e) => e.domain === args.domain);
        }

        if (args.search) {
          const q = args.search.toLowerCase();
          entities = entities.filter(
            (e) =>
              e.entityId.toLowerCase().includes(q) ||
              e.friendlyName.toLowerCase().includes(q),
          );
        }

        await context.writeResource("states", "entities", {
          entities,
          count: entities.length,
          timestamp: new Date().toISOString(),
        });

        return {};
      },
    },

    "get-state": {
      description: "Get the current state and attributes of a single entity",
      arguments: z.object({
        entityId: z.string().describe("Entity ID (e.g., light.kitchen_lamp)"),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;
        const { entityId } = args;

        const state = await haFetch(
          host,
          token,
          `/states/${encodeURIComponent(entityId)}`,
          protocol,
        );

        await context.writeResource("entity-state", "entity-state", {
          entityId: state.entity_id,
          state: state.state,
          attributes: state.attributes,
          lastChanged: state.last_changed,
          lastUpdated: state.last_updated,
          timestamp: new Date().toISOString(),
        });

        return {};
      },
    },

    "call-service": {
      description:
        "Call a Home Assistant service (e.g., light.turn_on, switch.toggle)",
      arguments: z.object({
        domain: z.string().describe(
          "Service domain (e.g., light, switch, automation, input_boolean)",
        ),
        service: z.string().describe(
          "Service name (e.g., turn_on, turn_off, toggle)",
        ),
        entityId: z.string().optional().describe("Single entity ID to target"),
        entityIds: z.array(z.string()).optional().describe(
          "Multiple entity IDs to target",
        ),
        data: z.object({}).passthrough().optional().describe(
          "Additional service data (e.g., brightness, color_temp_kelvin)",
        ),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;
        const { domain, service, entityId, entityIds, data } = args;

        const serviceData = { ...data };
        if (entityId) {
          serviceData.entity_id = entityId;
        } else if (entityIds && entityIds.length > 0) {
          serviceData.entity_id = entityIds;
        }

        const result = await haFetch(
          host,
          token,
          `/services/${encodeURIComponent(domain)}/${
            encodeURIComponent(service)
          }`,
          protocol,
          {
            method: "POST",
            body: JSON.stringify(serviceData),
          },
        );

        await context.writeResource("service-result", "service-result", {
          domain,
          service,
          entityId,
          entityIds,
          data,
          result,
          timestamp: new Date().toISOString(),
        });

        return {};
      },
    },

    "list-services": {
      description: "List available services in Home Assistant",
      arguments: z.object({
        domain: z.string().optional().describe("Filter by domain"),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;

        const services = await haFetch(host, token, "/services", protocol);

        let domains = services.map((s) => ({
          domain: s.domain,
          services: Object.keys(s.services),
        }));

        if (args.domain) {
          domains = domains.filter((d) => d.domain === args.domain);
        }

        await context.writeResource("services", "services", {
          domains,
          count: domains.length,
          timestamp: new Date().toISOString(),
        });

        return {};
      },
    },

    "list-automations": {
      description: "List all automations with their state and configuration",
      arguments: z.object({
        search: z.string().optional().describe("Filter automations by name"),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;

        const states = await haFetch(host, token, "/states", protocol);
        let automations = states
          .filter((s) => s.entity_id.startsWith("automation."))
          .map((s) => ({
            entityId: s.entity_id,
            state: s.state,
            friendlyName: s.attributes?.friendly_name || "",
            lastTriggered: s.attributes?.last_triggered,
            id: s.attributes?.id,
          }));

        if (args.search) {
          const q = args.search.toLowerCase();
          automations = automations.filter(
            (a) =>
              a.entityId.toLowerCase().includes(q) ||
              a.friendlyName.toLowerCase().includes(q),
          );
        }

        await context.writeResource("automations", "automations", {
          automations,
          count: automations.length,
          timestamp: new Date().toISOString(),
        });

        return {};
      },
    },

    "get-automation-config": {
      description:
        "Get the full YAML/JSON config of an existing automation by its ID",
      arguments: z.object({
        automationId: z.string().describe(
          "Automation ID (from attributes.id, e.g., 1700954455641)",
        ),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;
        const { automationId } = args;

        const config = await haFetch(
          host,
          token,
          `/config/automation/config/${encodeURIComponent(automationId)}`,
          protocol,
        );

        await context.writeResource("service-result", "automation-config", {
          domain: "automation",
          service: "get-config",
          data: config,
          timestamp: new Date().toISOString(),
        });

        return {};
      },
    },

    "get-history": {
      description:
        "Fetch historical state points for one entity between startTime and endTime (ISO 8601). Writes JSON resource and CSV resource.",
      arguments: z.object({
        entityId: z.string().describe(
          "Entity ID (e.g., sensor.living_room_temperature)",
        ),
        startTime: z.string().describe(
          "ISO 8601 start timestamp (e.g., 2025-12-01T00:00:00Z)",
        ),
        endTime: z.string().describe(
          "ISO 8601 end timestamp (e.g., 2026-02-01T00:00:00Z)",
        ),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;
        const { entityId, startTime, endTime } = args;

        const path = `/history/period/${
          encodeURIComponent(startTime)
        }?filter_entity_id=${encodeURIComponent(entityId)}&end_time=${
          encodeURIComponent(endTime)
        }&minimal_response&no_attributes`;
        const result = await haFetch(host, token, path, protocol);

        const series = Array.isArray(result) && result.length > 0
          ? result[0]
          : [];
        const points = series.map((s) => ({
          t: s.last_changed || s.last_updated,
          state: String(s.state),
        }));

        const header = "timestamp,state";
        const rows = points.map((p) => `${p.t},${p.state.replace(/"/g, '""')}`);
        const csv = [header, ...rows].join("\n") + "\n";

        const now = new Date().toISOString();

        await context.writeResource("history", "history", {
          entityId,
          startTime,
          endTime,
          points,
          count: points.length,
          timestamp: now,
        });

        await context.writeResource("history-csv", "history-csv", {
          entityId,
          startTime,
          endTime,
          csv,
          count: points.length,
          timestamp: now,
        });

        return {};
      },
    },

    "get-statistics": {
      description:
        "Fetch long-term statistics (hourly/daily/etc aggregates) for an entity via the HA WebSocket API. Use for data older than the recorder retention window.",
      arguments: z.object({
        statisticId: z.string().describe(
          "Statistic ID, usually the entity_id (e.g., sensor.living_room_temperature)",
        ),
        startTime: z.string().describe("ISO 8601 start timestamp"),
        endTime: z.string().describe("ISO 8601 end timestamp"),
        period: z.enum(["5minute", "hour", "day", "week", "month"]).optional()
          .describe("Aggregation period (default: hour)"),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;
        const { statisticId, startTime, endTime } = args;
        const period = args.period || "hour";
        const timeoutMs = context.globalArgs.wsTimeoutMs ?? 60000;

        const points = await fetchStatistics(
          host,
          token,
          protocol,
          statisticId,
          startTime,
          endTime,
          period,
          timeoutMs,
          context.logger,
        );

        const header = "start,end,mean,min,max,last_reset,state,sum";
        const rows = points.map((p) => {
          const start = p.start
            ? new Date(p.start as string | number).toISOString()
            : "";
          const end = p.end
            ? new Date(p.end as string | number).toISOString()
            : "";
          return [
            start,
            end,
            p.mean ?? "",
            p.min ?? "",
            p.max ?? "",
            p.last_reset ?? "",
            p.state ?? "",
            p.sum ?? "",
          ].join(",");
        });
        const csv = [header, ...rows].join("\n") + "\n";

        await context.writeResource("statistics", "statistics", {
          statisticId,
          startTime,
          endTime,
          period,
          points,
          count: points.length,
          csv,
          timestamp: new Date().toISOString(),
        });

        return {};
      },
    },

    "backfill-to-vm": {
      description:
        "Pull HA long-term statistics for a list of entities and bulk-import them to VictoriaMetrics via /api/v1/import (JSONL), so historical data is queryable alongside live scrapes.",
      arguments: z.object({
        entities: z.array(z.object({
          entityId: z.string(),
          metricName: z.string(),
          extraLabels: z.record(z.string(), z.string()).optional(),
        })).min(1),
        startTime: z.string(),
        endTime: z.string(),
        period: z.enum(["5minute", "hour", "day", "week", "month"]).optional(),
        aggregator: z.enum(["mean", "min", "max", "sum", "state"]).optional(),
        vmUrl: z.string().optional(),
        instance: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;
        const period = args.period || "hour";
        const aggregator = args.aggregator || "mean";
        const vmUrl = args.vmUrl || "http://203.0.113.10:8428";
        const instance = args.instance || "203.0.113.10:8123";
        const timeoutMs = context.globalArgs.wsTimeoutMs ?? 60000;

        const lines: string[] = [];
        const summaries: Array<Record<string, unknown>> = [];
        let total = 0;

        for (const ent of args.entities) {
          // One entity's statistics fetch failing (auth hiccup, a bad
          // statistic id, a WS drop) must not tear down the whole fan-out —
          // record a per-entity `error` (redacted) and move on to the next
          // entity, mirroring the existing `/states` swallow-to-`{}` guard
          // just below (headphones onboard-artists / seadex summary.errors
          // precedent).
          let points: Record<string, unknown>[];
          try {
            points = await fetchStatistics(
              host,
              token,
              protocol,
              ent.entityId,
              args.startTime,
              args.endTime,
              period,
              timeoutMs,
              context.logger,
            );
          } catch (e) {
            const message = redactToken(e, token);
            context.logger?.warning?.(
              `backfill-to-vm: statistics fetch failed for ${ent.entityId}: ${message}`,
            );
            summaries.push({
              entityId: ent.entityId,
              metricName: ent.metricName,
              points: 0,
              error: message,
            });
            continue;
          }

          let stateResp: Record<string, unknown> = {};
          try {
            stateResp = await haFetch(
              host,
              token,
              `/states/${encodeURIComponent(ent.entityId)}`,
              protocol,
            );
          } catch {
            stateResp = {};
          }
          const stateAttrs =
            (stateResp.attributes as Record<string, unknown>) || {};
          const friendlyName = String(stateAttrs.friendly_name || ent.entityId);
          const domain = ent.entityId.split(".")[0];

          const labels: Record<string, string> = {
            __name__: ent.metricName,
            domain,
            entity: ent.entityId,
            friendly_name: friendlyName,
            instance,
            job: "homeassistant",
            ...(ent.extraLabels || {}),
          };

          const values: number[] = [];
          const timestamps: number[] = [];
          for (const p of points) {
            const v = (p as Record<string, unknown>)[aggregator];
            if (v === null || v === undefined) continue;
            const ts = (p as Record<string, unknown>).start as number;
            if (typeof ts !== "number") continue;
            values.push(Number(v));
            timestamps.push(ts);
          }

          if (values.length > 0) {
            lines.push(JSON.stringify({ metric: labels, values, timestamps }));
            total += values.length;
          }

          summaries.push({
            entityId: ent.entityId,
            metricName: ent.metricName,
            points: values.length,
            firstTs: timestamps.length
              ? new Date(timestamps[0]).toISOString()
              : undefined,
            lastTs: timestamps.length
              ? new Date(timestamps[timestamps.length - 1]).toISOString()
              : undefined,
          });
        }

        if (lines.length > 0) {
          const body = lines.join("\n") + "\n";
          const resp = await fetch(`${vmUrl}/api/v1/import`, {
            method: "POST",
            headers: { "Content-Type": "application/x-ndjson" },
            body,
          });
          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(
              redactToken(`VM import failed: ${resp.status} - ${text}`, token),
            );
          }
        }

        await context.writeResource("backfill-report", "backfill", {
          vmUrl,
          startTime: args.startTime,
          endTime: args.endTime,
          period,
          aggregator,
          entities: summaries,
          totalSamples: total,
          timestamp: new Date().toISOString(),
        });

        return {};
      },
    },

    "update-automation": {
      description:
        "Update an existing Home Assistant automation config by its ID",
      arguments: z.object({
        automationId: z.string().describe("Automation ID to update"),
        config: z.object({}).passthrough().describe(
          "Full automation config object to write",
        ),
      }),
      execute: async (args, context) => {
        const { host, token, protocol } = context.globalArgs;
        const { automationId, config } = args;

        const result = await haFetch(
          host,
          token,
          `/config/automation/config/${encodeURIComponent(automationId)}`,
          protocol,
          {
            method: "POST",
            body: JSON.stringify(config),
          },
        );

        await context.writeResource(
          "service-result",
          "update-automation-result",
          {
            domain: "automation",
            service: "update",
            data: { automationId, config },
            result,
            timestamp: new Date().toISOString(),
          },
        );

        return {};
      },
    },
  },
};
