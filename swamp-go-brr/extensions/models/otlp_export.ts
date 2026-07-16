// @magistr/swamp-go-brr/otlp-export — the ONLY network egress in the loop (issue
// gobrr-observability). gobrr stays PURE: it DERIVES the OTLP payload (traceOtlp /
// metricsOtlp resources); this side-effectful model POSTs it OTLP/HTTP to a
// configurable collector. The endpoint + token are GLOBAL ARGS the workflow wires
// from a vault CEL — this model never resolves vault itself, never persists or logs
// the resolved URL or key (only a redacted host), enforces https, and is
// BEST-EFFORT: a failed export records a typed status and never throws / aborts /
// corrupts the run.
import { z } from "npm:zod@4";

// ── pure helpers (unit-tested; no network) ────────────────────────────────────

/** Validate the collector endpoint — must be `https://` (rejects http/empty/no-scheme). */
export function validateEndpoint(
  url: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") {
      return { ok: false, reason: "endpoint must be https://" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unparseable endpoint URL" };
  }
}

/** Build the OTLP/HTTP request: token rides in the Authorization header only, never the URL or body. */
export function buildExportRequest(
  endpoint: string,
  token: string,
  payload: Record<string, unknown>,
): { url: string; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // token rides ONLY in the Authorization header — never the URL or body.
  return { url: endpoint, headers, body: JSON.stringify(payload) };
}

/** Strip userinfo + query so a logged/stored endpoint cannot leak inline creds
 * (https://user:pass@host or ?apikey=…). Host + path remain for diagnostics. */
export function redactEndpoint(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    return u.toString();
  } catch {
    return "[unparseable-endpoint]";
  }
}

/** Map an HTTP status to a typed result: 2xx -> ok, otherwise -> error. */
export function classifyResult(httpStatus: number): "ok" | "error" {
  return httpStatus >= 200 && httpStatus < 300 ? "ok" : "error";
}

// ── the model ─────────────────────────────────────────────────────────────────

type Ctx = {
  logger: { info: (msg: string, data?: Record<string, unknown>) => void };
  globalArgs: Record<string, unknown>;
  readResource:
    | ((name: string) => Promise<Record<string, unknown> | null>)
    | undefined;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  definition: { name: string };
};

const StatusSchema = z.object({
  status: z.enum(["ok", "skipped", "error"]),
  endpoint: z.string().default(""), // ALWAYS redacted before write
  reason: z.string().default(""),
  httpStatus: z.number().optional(),
});

/** @internal — recursively references private Zod internals; call via the CLI. */
export const model = {
  type: "@magistr/swamp-go-brr/otlp-export",
  version: "2026.07.16.2",
  // endpoint + token come from a vault CEL wired by the workflow; never resolved here.
  globalArguments: z.object({
    endpoint: z.string().default(""),
    token: z.string().default("").meta({ sensitive: true }),
    // which gobrr resource to ship — matches the resource name gobrr.emit_otlp writes
    payloadResource: z.string().default("traceOtlp"),
  }),

  resources: {
    exportStatus: {
      description:
        "Typed result of the last OTLP push {status: ok|skipped|error, endpoint(redacted), reason}. Read via `swamp data get <name> exportStatus --json | jq -r .content.status`. The resolved endpoint URL and token are NEVER stored — only a userinfo/query-stripped host.",
      schema: StatusSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    export_run: {
      description:
        "Best-effort POST of the derived OTLP payload (the gobrr `traceOtlp`/`metricsOtlp` resource named by globalArgs.payloadResource) to globalArgs.endpoint with a Bearer token from globalArgs.token (https only). Records a typed exportStatus; never throws/aborts the run. Skips (status=skipped) when no endpoint is configured.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const endpoint = String(context.globalArgs?.endpoint ?? "");
        const token = String(context.globalArgs?.token ?? "");
        const payloadResource = String(
          context.globalArgs?.payloadResource ?? "traceOtlp",
        );
        const write = (data: z.infer<typeof StatusSchema>) =>
          context.writeResource("exportStatus", "exportStatus", data);

        if (!endpoint) {
          context.logger.info("otlp-export: no endpoint configured — skipping");
          return {
            dataHandles: [
              await write({
                status: "skipped",
                endpoint: "",
                reason: "no endpoint configured",
              }),
            ],
          };
        }
        const v = validateEndpoint(endpoint);
        const redacted = redactEndpoint(endpoint);
        if (!v.ok) {
          return {
            dataHandles: [
              await write({
                status: "error",
                endpoint: redacted,
                reason: v.reason,
              }),
            ],
          };
        }

        let payload: Record<string, unknown> = {};
        try {
          // readResource returns the stored object directly (no `.content` wrapper —
          // that wrapper exists only in `swamp data get`; cf. gobrr.readRun).
          payload = (await context.readResource?.(payloadResource)) ?? {};
        } catch {
          // best-effort: if the resource is unavailable we post {}, the collector
          // rejects it, and we record status=error — never throw.
        }

        let status: "ok" | "error" = "ok";
        let httpStatus: number | undefined;
        let reason = "";
        try {
          const req = buildExportRequest(endpoint, token, payload);
          const res = await fetch(req.url, {
            method: "POST",
            headers: req.headers,
            body: req.body,
          });
          httpStatus = res.status;
          status = classifyResult(res.status);
          if (status === "error") reason = `collector returned ${res.status}`;
        } catch {
          // NEVER rethrow — a transport failure must not abort or corrupt the run.
          status = "error";
          reason = "transport error";
          context.logger.info("otlp-export transport failure for {ep}", {
            ep: redacted,
          });
        }
        return {
          dataHandles: [
            await write({ status, endpoint: redacted, reason, httpStatus }),
          ],
        };
      },
    },
  },
};
