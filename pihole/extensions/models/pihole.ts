// @magistr/pihole — Pi-hole custom DNS record management with full CRUD and
// declarative sync. Pure logic lives in ./lib/dns.ts; the HTTP adapter (session
// lifecycle, HTTPS/caCert, redaction) lives in ./lib/client.ts.

import { z } from "npm:zod@4";
import { diffRecords } from "./lib/dns.ts";
import {
  type PiholeConfig,
  type SessionContext,
  withSession,
} from "./lib/client.ts";

const InputSchema = z.object({
  host: z.string().describe(
    "Pi-hole host, e.g. pihole.local or 10.0.0.53 (a scheme/port may be included, e.g. https://pi.lan:8443)",
  ),
  password: z.string().meta({ sensitive: true }).describe(
    "Pi-hole web password — use a vault reference: ${{ vault.get(my-vault, PIHOLE_PASSWORD) }}",
  ),
  scheme: z.enum(["http", "https"]).default("http").describe(
    "URL scheme (default http). Use https to avoid sending the password over cleartext.",
  ),
  caCert: z.string().optional().describe(
    "Optional inline PEM CA certificate to trust a self-signed Pi-hole HTTPS certificate",
  ),
  records: z.array(z.object({
    hostname: z.string(),
    ip: z.string(),
  })).optional().describe("Declarative DNS records used by add/sync"),
});

const RecordSchema = z.object({
  hostname: z.string(),
  ip: z.string(),
});

const ResultEntry = z.object({
  ip: z.string(),
  hostname: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

const WriteResultSchema = z.object({
  results: z.array(ResultEntry),
  succeeded: z.number(),
  failed: z.number(),
  timestamp: z.string(),
});

interface ExecContext {
  globalArgs: z.infer<typeof InputSchema>;
  writeResource: (spec: string, name: string, data: unknown) => Promise<void>;
}

function configFrom(globalArgs: z.infer<typeof InputSchema>): PiholeConfig {
  return {
    host: globalArgs.host,
    password: globalArgs.password,
    scheme: globalArgs.scheme,
    caCert: globalArgs.caCert,
  };
}

function errorText(outcome: { status: number; errorBody?: string }): string {
  return `HTTP ${outcome.status}${
    outcome.errorBody ? `: ${outcome.errorBody}` : ""
  }`;
}

async function runSync(
  context: ExecContext,
  deleteExtras: boolean,
) {
  const globalArgs = context.globalArgs;
  const records = globalArgs.records;
  if (!records || records.length === 0) {
    throw new Error("No records specified in globalArguments.records");
  }

  const outcome = await withSession(
    configFrom(globalArgs),
    async (ctx: SessionContext) => {
      const existing = await ctx.list();
      const diff = diffRecords(existing, records, { deleteExtras });
      const added: Array<{ ip: string; hostname: string }> = [];
      const deleted: Array<{ ip: string; hostname: string }> = [];
      const failed: Array<{ ip: string; hostname: string; error: string }> = [];

      for (const r of diff.added) {
        const res = await ctx.add(r.ip, r.hostname);
        if (res.ok) added.push(r);
        else {failed.push({
            ip: r.ip,
            hostname: r.hostname,
            error: `add ${errorText(res)}`,
          });}
      }
      for (const r of diff.deleted) {
        const res = await ctx.del(r.ip, r.hostname);
        if (res.ok) deleted.push(r);
        else {failed.push({
            ip: r.ip,
            hostname: r.hostname,
            error: `delete ${errorText(res)}`,
          });}
      }
      return { added, deleted, unchanged: diff.unchanged, failed };
    },
  );

  await context.writeResource(
    "sync-result",
    deleteExtras ? "sync-clean-result" : "sync-result",
    {
      added: outcome.added,
      deleted: outcome.deleted,
      unchanged: outcome.unchanged,
      failed: outcome.failed,
      summary: {
        added: outcome.added.length,
        deleted: outcome.deleted.length,
        unchanged: outcome.unchanged.length,
        failed: outcome.failed.length,
      },
      timestamp: new Date().toISOString(),
    },
  );

  if (outcome.failed.length > 0) {
    throw new Error(`sync: ${outcome.failed.length} operation(s) failed`);
  }
  return {};
}

/** The @magistr/pihole model — Pi-hole custom DNS record CRUD + declarative sync. */
export const model = {
  type: "@magistr/pihole",
  version: "2026.07.16.2",
  globalArguments: InputSchema,
  resources: {
    "dns-records": {
      schema: z.object({
        records: z.array(RecordSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "add-result": {
      schema: WriteResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "delete-result": {
      schema: WriteResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "sync-result": {
      schema: z.object({
        added: z.array(RecordSchema),
        deleted: z.array(RecordSchema),
        unchanged: z.array(RecordSchema),
        failed: z.array(z.object({
          ip: z.string(),
          hostname: z.string(),
          error: z.string(),
        })),
        summary: z.object({
          added: z.number(),
          deleted: z.number(),
          unchanged: z.number(),
          failed: z.number(),
        }),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "List all custom DNS records",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const records = await withSession(
          configFrom(context.globalArgs),
          (ctx) => ctx.list(),
        );
        await context.writeResource("dns-records", "dns-records", {
          records,
          count: records.length,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    add: {
      description:
        "Add the DNS records from globalArguments.records (idempotent: already-present records are reported unchanged)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const records = context.globalArgs.records;
        if (!records || records.length === 0) {
          throw new Error("No records specified in globalArguments.records");
        }

        const results = await withSession(
          configFrom(context.globalArgs),
          async (ctx) => {
            const existing = await ctx.list();
            const toAdd = new Set(
              diffRecords(existing, records).added.map((r) =>
                `${r.ip} ${r.hostname}`
              ),
            );
            const seen = new Set<string>();
            const out: z.infer<typeof ResultEntry>[] = [];
            for (const r of records) {
              const key = `${r.ip} ${r.hostname}`;
              if (seen.has(key)) continue;
              seen.add(key);
              if (!toAdd.has(key)) {
                out.push({ ip: r.ip, hostname: r.hostname, success: true });
                continue;
              }
              const res = await ctx.add(r.ip, r.hostname);
              out.push({
                ip: r.ip,
                hostname: r.hostname,
                success: res.ok,
                ...(res.ok ? {} : { error: errorText(res) }),
              });
            }
            return out;
          },
        );

        const succeeded = results.filter((r) => r.success).length;
        const failed = results.length - succeeded;
        await context.writeResource("add-result", "add-result", {
          results,
          succeeded,
          failed,
          timestamp: new Date().toISOString(),
        });
        if (failed > 0) {
          throw new Error(
            `add: ${failed} of ${results.length} record(s) failed`,
          );
        }
        return {};
      },
    },

    "add-record": {
      description: "Add a single DNS record (idempotent)",
      arguments: RecordSchema,
      execute: async (args, context) => {
        const { ip, hostname } = args;
        const result = await withSession(
          configFrom(context.globalArgs),
          async (ctx) => {
            const existing = await ctx.list();
            if (existing.some((e) => e.ip === ip && e.hostname === hostname)) {
              return { ip, hostname, success: true };
            }
            const res = await ctx.add(ip, hostname);
            return {
              ip,
              hostname,
              success: res.ok,
              ...(res.ok ? {} : { error: errorText(res) }),
            };
          },
        );
        await context.writeResource("add-result", "add-record-result", {
          results: [result],
          succeeded: result.success ? 1 : 0,
          failed: result.success ? 0 : 1,
          timestamp: new Date().toISOString(),
        });
        if (!result.success) {
          throw new Error(`add-record failed: ${result.error ?? "unknown"}`);
        }
        return {};
      },
    },

    "delete-record": {
      description:
        "Delete a single DNS record (idempotent: absent records report success)",
      arguments: RecordSchema,
      execute: async (args, context) => {
        const { ip, hostname } = args;
        const result = await withSession(
          configFrom(context.globalArgs),
          async (ctx) => {
            const existing = await ctx.list();
            if (!existing.some((e) => e.ip === ip && e.hostname === hostname)) {
              return { ip, hostname, success: true };
            }
            const res = await ctx.del(ip, hostname);
            return {
              ip,
              hostname,
              success: res.ok,
              ...(res.ok ? {} : { error: errorText(res) }),
            };
          },
        );
        await context.writeResource("delete-result", "delete-record-result", {
          results: [result],
          succeeded: result.success ? 1 : 0,
          failed: result.success ? 0 : 1,
          timestamp: new Date().toISOString(),
        });
        if (!result.success) {
          throw new Error(`delete-record failed: ${result.error ?? "unknown"}`);
        }
        return {};
      },
    },

    sync: {
      description:
        "Add missing records from globalArguments.records; optionally delete extras",
      arguments: z.object({
        deleteExtras: z.boolean().optional().describe(
          "Delete records not present in globalArguments.records",
        ),
      }),
      execute: (args, context) => runSync(context, args?.deleteExtras ?? false),
    },

    "sync-clean": {
      description:
        "Sync records and delete any not in globalArguments.records (declarative)",
      arguments: z.object({}),
      execute: (_args, context) => runSync(context, true),
    },
  },
};
