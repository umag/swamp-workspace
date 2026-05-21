// Pi-hole FTL HTTP adapter for @magistr/pihole — the I/O boundary.
// Pure reconciliation/parse/redaction logic lives in ./dns.ts.

import {
  type DnsRecord,
  encodeEntry,
  normalizeBaseUrl,
  parseHostsEntries,
  redactSecrets,
} from "./dns.ts";

const REQUEST_TIMEOUT_MS = 30_000;

/** Connection settings for a Pi-hole FTL instance. */
export interface PiholeConfig {
  host: string;
  password: string;
  scheme: "http" | "https";
  caCert?: string;
}

/** An authenticated FTL session — its session id and CSRF token. */
export interface Session {
  sid: string;
  csrf: string;
}

/** Best-effort outcome of a single add/delete — never thrown, so batch/sync
 * can report per-record failures instead of aborting. */
export interface WriteOutcome {
  ok: boolean;
  status: number;
  errorBody?: string;
}

/** Record operations available within an authenticated session scope. */
export interface SessionContext {
  list(): Promise<DnsRecord[]>;
  add(ip: string, hostname: string): Promise<WriteOutcome>;
  del(ip: string, hostname: string): Promise<WriteOutcome>;
}

// Build a CA-trusting client based on the EFFECTIVE scheme of the resolved
// base URL (the host may carry its own https:// scheme), not just cfg.scheme,
// so a self-signed caCert is never silently ignored.
function buildClient(
  base: string,
  caCert: string | undefined,
): Deno.HttpClient | undefined {
  if (base.startsWith("https://") && caCert) {
    if (!/-----BEGIN CERTIFICATE-----/.test(caCert)) {
      throw new Error(
        "caCert must be inline PEM content beginning with -----BEGIN CERTIFICATE-----",
      );
    }
    return Deno.createHttpClient({ caCerts: [caCert] });
  }
  return undefined;
}

function authHeaders(session: Session): HeadersInit {
  return {
    "X-CSRF-Token": session.csrf,
    "Cookie": `sid=${session.sid}`,
  };
}

async function authenticate(
  base: string,
  password: string,
  client: Deno.HttpClient | undefined,
  secrets: Array<string | undefined>,
): Promise<Session> {
  const res = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    client,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      redactSecrets(
        `Auth failed: ${res.status} ${res.statusText} ${body}`,
        secrets,
      ),
    );
  }

  const data = await res.json();
  // Pi-hole returns 200 OK even on auth failure — must check session.valid.
  if (!data.session?.valid) {
    throw new Error(
      redactSecrets(
        `Auth failed: ${data.session?.message ?? "invalid credentials"}`,
        secrets,
      ),
    );
  }
  if (!data.session?.sid || !data.session?.csrf) {
    throw new Error("Auth failed: no session returned");
  }
  return { sid: data.session.sid, csrf: data.session.csrf };
}

async function listRecords(
  base: string,
  session: Session,
  client: Deno.HttpClient | undefined,
  secrets: Array<string | undefined>,
): Promise<DnsRecord[]> {
  const res = await fetch(`${base}/api/config/dns/hosts`, {
    method: "GET",
    headers: authHeaders(session),
    client,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      redactSecrets(
        `List failed: ${res.status} ${res.statusText} ${body}`,
        secrets,
      ),
    );
  }
  const data = await res.json();
  const hosts: string[] = data.config?.dns?.hosts ?? [];
  return parseHostsEntries(hosts);
}

async function writeRecord(
  method: "PUT" | "DELETE",
  base: string,
  session: Session,
  ip: string,
  hostname: string,
  client: Deno.HttpClient | undefined,
  secrets: Array<string | undefined>,
): Promise<WriteOutcome> {
  try {
    const res = await fetch(
      `${base}/api/config/dns/hosts/${encodeEntry(ip, hostname)}`,
      {
        method,
        headers: {
          ...authHeaders(session),
          "Content-Type": "application/json",
        },
        client,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      errorBody: redactSecrets(body, secrets),
    };
  } catch (e) {
    // A transport fault (timeout, DNS/connection error) becomes a captured
    // per-record failure so a batch/sync still records the records it already
    // processed instead of aborting and losing the audit artifact.
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, errorBody: redactSecrets(message, secrets) };
  }
}

async function logout(
  base: string,
  session: Session,
  client: Deno.HttpClient | undefined,
): Promise<void> {
  // Release the FTL session so we don't exhaust Pi-hole's concurrent-session
  // limit. Tolerate any response (incl. 401/410 if the sid already expired).
  await fetch(`${base}/api/auth`, {
    method: "DELETE",
    headers: authHeaders(session),
    client,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Acquire a session, run `fn`, then ALWAYS release the session and close the
 * HTTP client — even on failure. A logout error never masks the original
 * error. All thrown error text is redacted using the captured locals. */
export async function withSession<T>(
  cfg: PiholeConfig,
  fn: (ctx: SessionContext) => Promise<T>,
): Promise<T> {
  const base = normalizeBaseUrl(cfg.host, cfg.scheme);
  if (base.startsWith("http://")) {
    console.warn(
      "WARNING: Pi-hole web password is being sent over cleartext HTTP; set scheme: https to encrypt it.",
    );
  }
  const client = buildClient(base, cfg.caCert);
  let session: Session | undefined;

  try {
    session = await authenticate(base, cfg.password, client, [cfg.password]);
    const secrets: Array<string | undefined> = [
      cfg.password,
      session.sid,
      session.csrf,
    ];
    const ctx: SessionContext = {
      list: () => listRecords(base, session!, client, secrets),
      add: (ip, hostname) =>
        writeRecord("PUT", base, session!, ip, hostname, client, secrets),
      del: (ip, hostname) =>
        writeRecord("DELETE", base, session!, ip, hostname, client, secrets),
    };
    return await fn(ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      redactSecrets(message, [cfg.password, session?.sid, session?.csrf]),
    );
  } finally {
    if (session) {
      try {
        await logout(base, session, client);
      } catch {
        // Session release is best-effort; never mask the original outcome.
      }
    }
    client?.close();
  }
}
