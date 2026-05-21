// Pure domain logic for @magistr/pihole — no I/O, fully unit-testable.

/** A single Pi-hole custom DNS record (an A-record host entry). */
export interface DnsRecord {
  ip: string;
  hostname: string;
}

/** The result of reconciling desired records against the existing set. */
export interface DiffResult {
  added: DnsRecord[];
  deleted: DnsRecord[];
  unchanged: DnsRecord[];
}

const REDACT_PLACEHOLDER = "[REDACTED]";
// Secrets shorter than this are NOT value-replaced (a short user-chosen value
// would mangle unrelated text); the field-name regex still masks them in
// structured positions.
const MIN_VALUE_REDACT_LEN = 8;
// Captured upstream bodies are bounded before they reach a log or a resource.
const MAX_REDACTED_LEN = 2048;

/** Build a normalized origin from a host and scheme.
 * A bare host becomes `<scheme>://<host>`. A host already carrying a scheme
 * and/or port is passed through. Any trailing slash is stripped. */
export function normalizeBaseUrl(
  host: string,
  scheme: "http" | "https",
): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${scheme}://${trimmed}`;
}

/** Parse Pi-hole "ip hostname" host entries into records. The first token is
 * the IP; the remainder (which may contain spaces) is the hostname. */
export function parseHostsEntries(entries: string[]): DnsRecord[] {
  const records: DnsRecord[] = [];
  for (const entry of entries) {
    const match = entry.trim().match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    records.push({ ip: match[1], hostname: match[2].trim() });
  }
  return records;
}

/** Percent-encode an "ip hostname" pair for a Pi-hole API path segment. */
export function encodeEntry(ip: string, hostname: string): string {
  return encodeURIComponent(`${ip} ${hostname}`);
}

function sameRecord(a: DnsRecord, b: DnsRecord): boolean {
  return a.ip === b.ip && a.hostname === b.hostname;
}

/** Reconcile desired vs existing records (equality on ip AND hostname).
 * `deleteExtras` defaults to false (non-destructive). */
export function diffRecords(
  existing: DnsRecord[],
  desired: DnsRecord[],
  opts?: { deleteExtras?: boolean },
): DiffResult {
  const deleteExtras = opts?.deleteExtras ?? false;
  const added: DnsRecord[] = [];
  const unchanged: DnsRecord[] = [];
  const deleted: DnsRecord[] = [];
  const seen: DnsRecord[] = [];

  for (const want of desired) {
    if (seen.some((s) => sameRecord(s, want))) continue;
    seen.push(want);
    if (existing.some((e) => sameRecord(e, want))) {
      unchanged.push(want);
    } else {
      added.push(want);
    }
  }

  if (deleteExtras) {
    for (const have of existing) {
      if (!desired.some((d) => sameRecord(d, have))) deleted.push(have);
    }
  }

  return { added, deleted, unchanged };
}

const SECRET_FIELD_RE =
  /("?(?:sid|csrf|session|sessionid|password|passwd|pwd)"?\s*[:=]\s*)("?)([^"&;,\s}]+)(\2)/gi;

/** Redact secret values from arbitrary text before logging/persisting.
 * Value-based (global, literal split/join so regex metacharacters are safe;
 * longest secrets first so a substring secret cannot leave a fragment; values
 * shorter than MIN_VALUE_REDACT_LEN are skipped to avoid corrupting unrelated
 * text) plus field-name regexes as defense-in-depth, then truncate. */
export function redactSecrets(
  text: string,
  secrets: Array<string | undefined>,
): string {
  let out = text;

  const values = secrets
    .filter((s): s is string =>
      typeof s === "string" && s.length >= MIN_VALUE_REDACT_LEN
    )
    .sort((a, b) => b.length - a.length);

  for (const value of values) {
    out = out.split(value).join(REDACT_PLACEHOLDER);
  }

  out = out.replace(
    SECRET_FIELD_RE,
    (_m, prefix, quote, _value, closing) =>
      `${prefix}${quote}${REDACT_PLACEHOLDER}${closing}`,
  );

  if (out.length > MAX_REDACTED_LEN) out = out.slice(0, MAX_REDACTED_LEN);
  return out;
}
