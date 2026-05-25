import { z } from "npm:zod@4";

const InputSchema = z.object({
  host: z.string().describe("Home Assistant host (e.g., homeassistant.local)"),
  token: z.string().describe(
    "Long-lived access token - use vault: ${{ vault.get(my-vault, HA_TOKEN) }}",
  ),
  protocol: z.string().optional().describe(
    "Protocol (http or https, default: https)",
  ),
});

async function fetchStatistics(
  host,
  token,
  protocol,
  statisticId,
  startTime,
  endTime,
  period,
): Promise<Record<string, unknown>[]> {
  const wsProto = (protocol || "https") === "https" ? "wss" : "ws";
  const wsUrl = `${wsProto}://${host}/api/websocket`;
  return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      reject(new Error("WebSocket timeout after 60s"));
    }, 60000);
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (msg.type === "auth_ok") {
        ws.send(JSON.stringify({
          id: 1,
          type: "recorder/statistics_during_period",
          start_time: startTime,
          end_time: endTime,
          statistic_ids: [statisticId],
          period,
        }));
      } else if (msg.type === "auth_invalid") {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
        reject(new Error(`Auth invalid: ${msg.message}`));
      } else if (msg.type === "result") {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
        if (!msg.success) {
          reject(new Error(`WS error: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolve((msg.result && msg.result[statisticId]) || []);
      }
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      const errEvent = e as Event & { message?: string };
      reject(new Error(`WS error: ${errEvent.message || errEvent.type}`));
    });
  });
}

async function haFetch(host, token, path, protocol, options: RequestInit = {}) {
  const proto = protocol || "https";
  const url = `${proto}://${host}/api${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `HA API ${
        options.method || "GET"
      } ${path} failed: ${response.status} - ${body}`,
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
  version: "2026.05.25.1",
  globalArguments: InputSchema,
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
          `/states/${entityId}`,
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
          `/services/${domain}/${service}`,
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
          `/config/automation/config/${automationId}`,
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

        const points = await fetchStatistics(
          host,
          token,
          protocol,
          statisticId,
          startTime,
          endTime,
          period,
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

        const lines: string[] = [];
        const summaries: Array<Record<string, unknown>> = [];
        let total = 0;

        for (const ent of args.entities) {
          const points = await fetchStatistics(
            host,
            token,
            protocol,
            ent.entityId,
            args.startTime,
            args.endTime,
            period,
          );

          let stateResp: Record<string, unknown> = {};
          try {
            stateResp = await haFetch(
              host,
              token,
              `/states/${ent.entityId}`,
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
            throw new Error(`VM import failed: ${resp.status} - ${text}`);
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
          `/config/automation/config/${automationId}`,
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
