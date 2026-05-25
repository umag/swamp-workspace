import { z } from "npm:zod@4";

const API_BASE = "https://api.porkbun.com/api/json/v3";

const DnsRecordType = z.enum([
  "A",
  "AAAA",
  "MX",
  "CNAME",
  "ALIAS",
  "TXT",
  "NS",
  "SRV",
  "TLSA",
  "CAA",
  "HTTPS",
  "SVCB",
  "SSHFP",
]);

const InputSchema = z.object({
  domain: z.string().describe("The domain name (e.g., example.com)"),
  apiKey: z.string().describe("Porkbun API key"),
  secretApiKey: z.string().describe("Porkbun secret API key"),
});

async function porkbunRequest(endpoint, apiKey, secretApiKey, extraBody = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: apiKey,
      secretapikey: secretApiKey,
      ...extraBody,
    }),
  });

  const data = await response.json();

  if (data.status !== "SUCCESS") {
    throw new Error(data.message || `Porkbun API error: ${data.status}`);
  }

  return data;
}

/** The @magistr/porkbun model — Porkbun DNS record management with full CRUD for all common record types. */
export const model = {
  type: "@magistr/porkbun",
  version: "2026.05.25.1",
  globalArguments: InputSchema,
  resources: {
    "ping-result": {
      schema: z.object({
        status: z.string(),
        yourIp: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "dns-records": {
      schema: z.object({
        domain: z.string(),
        records: z.any(),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "dns-record": {
      schema: z.object({
        domain: z.string(),
        subdomain: z.string(),
        type: z.string(),
        records: z.any(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "dns-created": {
      schema: z.object({
        id: z.any(),
        domain: z.string(),
        subdomain: z.string(),
        type: z.string(),
        content: z.string(),
        ttl: z.number(),
        status: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "dns-updated": {
      schema: z.object({
        id: z.string(),
        domain: z.string(),
        subdomain: z.string(),
        type: z.string(),
        content: z.string(),
        status: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "delete-result": {
      schema: z.object({
        domain: z.string(),
        status: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ping: {
      description: "Test API credentials and get your public IP address",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { apiKey, secretApiKey } = context.globalArgs;

        const data = await porkbunRequest("/ping", apiKey, secretApiKey);

        await context.writeResource("ping-result", "ping-result", {
          status: data.status,
          yourIp: data.yourIp,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    list: {
      description: "List all DNS records for the domain",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { domain, apiKey, secretApiKey } = context.globalArgs;

        const data = await porkbunRequest(
          `/dns/retrieve/${domain}`,
          apiKey,
          secretApiKey,
        );

        await context.writeResource("dns-records", "dns-records", {
          domain,
          records: data.records || [],
          count: (data.records || []).length,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    get: {
      description: "Get DNS records by subdomain and type",
      arguments: z.object({
        subdomain: z.string().optional().describe("Subdomain (empty for root)"),
        type: DnsRecordType.describe("DNS record type"),
      }),
      execute: async (args, context) => {
        const { domain, apiKey, secretApiKey } = context.globalArgs;
        const type = args.type;
        const subdomain = args.subdomain || "";

        const endpoint = subdomain
          ? `/dns/retrieveByNameType/${domain}/${type}/${subdomain}`
          : `/dns/retrieveByNameType/${domain}/${type}`;

        const data = await porkbunRequest(endpoint, apiKey, secretApiKey);

        await context.writeResource("dns-record", "dns-record", {
          domain,
          subdomain: subdomain || "(root)",
          type,
          records: data.records || [],
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    create: {
      description: "Create a new DNS record",
      arguments: z.object({
        subdomain: z.string().optional().describe("Subdomain (empty for root)"),
        type: DnsRecordType.describe("DNS record type"),
        content: z.string().describe("Record content (IP, hostname, etc.)"),
        ttl: z.number().optional().default(600).describe("TTL in seconds"),
        prio: z.number().optional().describe("Priority (for MX, SRV)"),
        notes: z.string().optional().describe("Notes for this record"),
      }),
      execute: async (args, context) => {
        const { domain, apiKey, secretApiKey } = context.globalArgs;
        const { subdomain, type, content, ttl, prio, notes } = args;

        const body: Record<string, unknown> = {
          type,
          content,
          ttl: ttl || 600,
        };
        if (subdomain) body.name = subdomain;
        if (prio !== undefined) body.prio = prio;
        if (notes) body.notes = notes;

        const data = await porkbunRequest(
          `/dns/create/${domain}`,
          apiKey,
          secretApiKey,
          body,
        );

        await context.writeResource("dns-created", "dns-created", {
          id: data.id,
          domain,
          subdomain: subdomain || "(root)",
          type,
          content,
          ttl: ttl || 600,
          status: "created",
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    update: {
      description: "Update an existing DNS record by ID",
      arguments: z.object({
        recordId: z.string().describe("Record ID to update"),
        subdomain: z.string().optional().describe("New subdomain"),
        type: DnsRecordType.describe("DNS record type"),
        content: z.string().describe("New record content"),
        ttl: z.number().optional().describe("New TTL in seconds"),
        prio: z.number().optional().describe("New priority"),
      }),
      execute: async (args, context) => {
        const { domain, apiKey, secretApiKey } = context.globalArgs;
        const { recordId, subdomain, type, content, ttl, prio } = args;

        const body: Record<string, unknown> = { type, content };
        if (subdomain) body.name = subdomain;
        if (ttl !== undefined) body.ttl = ttl;
        if (prio !== undefined) body.prio = prio;

        await porkbunRequest(
          `/dns/edit/${domain}/${recordId}`,
          apiKey,
          secretApiKey,
          body,
        );

        await context.writeResource("dns-updated", "dns-updated", {
          id: recordId,
          domain,
          subdomain: subdomain || "(root)",
          type,
          content,
          status: "updated",
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    delete: {
      description: "Delete a DNS record by ID",
      arguments: z.object({
        recordId: z.string().describe("Record ID to delete"),
      }),
      execute: async (args, context) => {
        const { domain, apiKey, secretApiKey } = context.globalArgs;
        const recordId = args.recordId;

        await porkbunRequest(
          `/dns/delete/${domain}/${recordId}`,
          apiKey,
          secretApiKey,
        );

        await context.writeResource("delete-result", "delete-by-id", {
          domain,
          status: "deleted",
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    deleteByNameType: {
      description: "Delete DNS records by subdomain and type",
      arguments: z.object({
        subdomain: z.string().optional().describe("Subdomain (empty for root)"),
        type: DnsRecordType.describe("DNS record type to delete"),
      }),
      execute: async (args, context) => {
        const { domain, apiKey, secretApiKey } = context.globalArgs;
        const type = args.type;
        const subdomain = args.subdomain || "";

        const endpoint = subdomain
          ? `/dns/deleteByNameType/${domain}/${type}/${subdomain}`
          : `/dns/deleteByNameType/${domain}/${type}`;

        await porkbunRequest(endpoint, apiKey, secretApiKey);

        await context.writeResource("delete-result", "delete-by-name-type", {
          domain,
          status: "deleted",
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
  },
};
