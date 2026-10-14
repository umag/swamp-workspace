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

/** Porkbun rate-limits domain availability checks; pace them. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Porkbun echoes names as FQDNs and hosts sometimes carry a trailing dot. */
const normContent = (v: unknown) =>
  String(v ?? "").trim().replace(/\.$/, "").toLowerCase();

/** "" / undefined both mean the zone root. */
const normSub = (v: unknown) =>
  String(v ?? "").trim().replace(/\.$/, "").toLowerCase();

/** MX and SRV carry a priority; everything else compares as absent. */
const normPrio = (type: string, v: unknown) =>
  type === "MX" || type === "SRV" ? String(v ?? "0").trim() : "";

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
  version: "2026.10.15.2",
  upgrades: [
    {
      toVersion: "2026.09.19.2",
      description:
        "Version bump — repo-wide maintenance release; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.14.2",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
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
  ],
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
    "dns-reconciled": {
      schema: z.object({
        domain: z.string(),
        groups: z.any(),
        created: z.number(),
        deleted: z.number(),
        kept: z.number(),
        changed: z.boolean(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "domain-check": {
      schema: z.object({
        domain: z.string(),
        // null when the check itself failed — never conflate an error with
        // "not available".
        available: z.boolean().nullable(),
        premium: z.boolean().nullable(),
        registration: z.string().nullable(),
        renewal: z.string().nullable(),
        transfer: z.string().nullable(),
        regularPrice: z.string().nullable(),
        firstYearPromo: z.boolean(),
        error: z.string().nullable(),
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

    applyRecords: {
      description:
        "Reconcile a desired set of DNS records in one run. Only the (subdomain, type) groups named in the input are touched: within each, records not desired are deleted and missing ones created. Running it twice changes nothing.",
      arguments: z.object({
        records: z
          .array(
            z.object({
              subdomain: z
                .string()
                .optional()
                .describe("Subdomain, empty or omitted for the zone root"),
              type: DnsRecordType,
              content: z.string(),
              ttl: z.number().optional().default(600),
              prio: z.number().optional().describe("MX / SRV priority"),
            }),
          )
          .min(1)
          .describe("The complete desired state for each group it mentions"),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe("Report the plan without creating or deleting anything"),
      }),
      execute: async (args, context) => {
        const { domain, apiKey, secretApiKey } = context.globalArgs;
        const { records, dryRun } = args;

        /* Group the desired state by (subdomain, type). A group is the unit of
           reconciliation: anything in it that we did not ask for is removed. */
        type Desired = (typeof records)[number];
        type Group = { subdomain: string; type: string; desired: Desired[] };
        const groups = new Map<string, Group>();
        for (const r of records) {
          const sub = normSub(r.subdomain);
          const key = `${sub}|${r.type}`;
          if (!groups.has(key)) {
            groups.set(key, { subdomain: sub, type: r.type, desired: [] });
          }
          groups.get(key)!.desired.push(r);
        }

        const report: {
          name: string;
          type: string;
          deleted: string[];
          created: string[];
          kept: string[];
        }[] = [];
        let created = 0;
        let deleted = 0;
        let kept = 0;

        for (const group of groups.values()) {
          const { subdomain, type, desired } = group;
          const fqdn = subdomain ? `${subdomain}.${domain}` : domain;

          /* Read before writing. Only an explicit "no records" answer counts as
             empty: any other failure (auth, network, rate limit) must abort,
             or the plan below would re-create records that already exist. */
          type Existing = { id: string; content: string; prio?: string };
          let existing: Existing[] = [];
          try {
            const endpoint = subdomain
              ? `/dns/retrieveByNameType/${domain}/${type}/${subdomain}`
              : `/dns/retrieveByNameType/${domain}/${type}`;
            const data = await porkbunRequest(endpoint, apiKey, secretApiKey);
            existing = data.records || [];
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/not found|no record/i.test(msg)) throw e;
            existing = [];
          }

          const wanted = desired.map((r) => ({
            spec: r,
            sig: normContent(r.content) + "|" + normPrio(type, r.prio),
          }));
          const have = existing.map((r) => ({
            record: r,
            sig: normContent(r.content) + "|" + normPrio(type, r.prio),
          }));

          const stale = have.filter((h) =>
            !wanted.some((w) => w.sig === h.sig)
          );
          const missing = wanted.filter((w) =>
            !have.some((h) => h.sig === w.sig)
          );
          const matched = have.filter((h) =>
            wanted.some((w) => w.sig === h.sig)
          );

          if (!dryRun) {
            for (const s of stale) {
              await porkbunRequest(
                `/dns/delete/${domain}/${s.record.id}`,
                apiKey,
                secretApiKey,
              );
            }
            for (const m of missing) {
              const body: Record<string, unknown> = {
                type,
                content: m.spec.content,
                ttl: m.spec.ttl ?? 600,
              };
              if (subdomain) body.name = subdomain;
              if (m.spec.prio !== undefined) body.prio = m.spec.prio;
              await porkbunRequest(
                `/dns/create/${domain}`,
                apiKey,
                secretApiKey,
                body,
              );
            }
          }

          deleted += stale.length;
          created += missing.length;
          kept += matched.length;

          report.push({
            name: fqdn,
            type,
            deleted: stale.map((s) => s.record.content),
            created: missing.map((m) => m.spec.content),
            kept: matched.map((h) => h.record.content),
          });
        }

        await context.writeResource("dns-reconciled", "dns-reconciled", {
          domain,
          groups: report,
          created,
          deleted,
          kept,
          changed: created + deleted > 0,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    checkDomains: {
      description:
        "Check availability and Porkbun price (including registry premium) for one or more domains",
      arguments: z.object({
        domains: z
          .array(
            z.string().regex(
              /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i,
              "a domain name such as example.com",
            ),
          )
          .min(1)
          .describe("Fully qualified domains to check, e.g. ['mk.tools']"),
        delayMs: z
          .number()
          .optional()
          .default(10500)
          .describe(
            "Pause between checks. Porkbun allows 1 availability check per 10 seconds; going faster returns an error, not a result.",
          ),
      }),
      execute: async (args, context) => {
        const { apiKey, secretApiKey } = context.globalArgs;
        const { domains, delayMs } = args;

        let checked = 0;
        for (const candidate of domains) {
          if (checked > 0) await delay(delayMs ?? 10500);
          checked++;

          const record = {
            domain: candidate,
            available: null as boolean | null,
            premium: null as boolean | null,
            registration: null as string | null,
            renewal: null as string | null,
            transfer: null as string | null,
            regularPrice: null as string | null,
            firstYearPromo: false,
            error: null as string | null,
            timestamp: new Date().toISOString(),
          };

          try {
            const data = await porkbunRequest(
              `/domain/checkDomain/${candidate}`,
              apiKey,
              secretApiKey,
            );
            const r = data.response || {};
            const additional = r.additional || {};

            record.available = r.avail === "yes";
            record.premium = r.premium === "yes";
            record.registration = r.price ?? null;
            record.renewal = additional.renewal?.price ?? null;
            record.transfer = additional.transfer?.price ?? null;
            record.regularPrice = r.regularPrice ?? null;
            record.firstYearPromo = r.firstYearPromo === "yes";
          } catch (e) {
            record.error = e instanceof Error ? e.message : String(e);
          }

          await context.writeResource(
            "domain-check",
            `check-${candidate}`,
            record,
          );
        }
        return {};
      },
    },
  },
};
