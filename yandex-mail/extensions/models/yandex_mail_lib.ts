/**
 * Pure helpers for the Yandex Mail model: email-id codec, IMAP search
 * construction, address formatting, and reply/forward header derivation.
 *
 * Nothing in here touches the network, so every function is unit-testable.
 *
 * @module
 */

// ── Email IDs ───────────────────────────────────────────────────────────────

/**
 * An IMAP message is addressed by (mailbox path, UID). The model exposes that
 * pair as one opaque string `<mailbox>:<uid>` so it can travel through CEL and
 * workflow inputs like a JMAP id does. The split is on the LAST colon, so a
 * mailbox path that contains `:` still round-trips.
 */
export function encodeEmailId(mailbox: string, uid: number): string {
  return `${mailbox}:${uid}`;
}

/** Inverse of {@link encodeEmailId}; throws on a malformed id. */
export function decodeEmailId(id: string): { mailbox: string; uid: number } {
  const i = id.lastIndexOf(":");
  if (i <= 0 || i === id.length - 1) {
    throw new Error(
      `Invalid emailId "${id}" — expected "<mailbox>:<uid>", e.g. "INBOX:1234"`,
    );
  }
  const digits = id.slice(i + 1);
  const uid = /^\d+$/.test(digits) ? Number(digits) : NaN;
  // IMAP UIDs are non-zero 32-bit unsigned integers (RFC 3501 §2.3.1.1).
  if (!Number.isInteger(uid) || uid <= 0 || uid > 0xffffffff) {
    throw new Error(`Invalid emailId "${id}" — UID must be a positive integer`);
  }
  const mailbox = id.slice(0, i);
  if (/[\r\n\0]/.test(mailbox)) {
    throw new Error(
      `Invalid emailId — the mailbox must not contain CR, LF or NUL`,
    );
  }
  return { mailbox, uid };
}

/** Group email ids by mailbox so each mailbox is opened (locked) once. */
export function groupByMailbox(ids: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const id of ids) {
    const { mailbox, uid } = decodeEmailId(id);
    const list = out.get(mailbox) ?? [];
    if (!list.includes(uid)) list.push(uid);
    out.set(mailbox, list);
  }
  return out;
}

// ── IMAP search ─────────────────────────────────────────────────────────────

/** Filters accepted by `query-emails`. */
export interface EmailFilter {
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  unseen?: boolean;
  flagged?: boolean;
}

/**
 * Translate a filter into an imapflow search query. IMAP SINCE/BEFORE are
 * date-granular (time is ignored by the server); an empty filter selects all.
 */
export function buildSearchQuery(f: EmailFilter): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (f.after) q.since = parseDateArg(f.after, "after");
  if (f.before) q.before = parseDateArg(f.before, "before");
  if (f.from) q.from = f.from;
  if (f.to) q.to = f.to;
  if (f.subject) q.subject = f.subject;
  if (f.text) q.text = f.text;
  if (f.unseen !== undefined) q.seen = !f.unseen;
  if (f.flagged !== undefined) q.flagged = f.flagged;
  if (Object.keys(q).length === 0) q.all = true;
  return q;
}

function parseDateArg(v: string, name: string): Date {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${name} date "${v}" — use ISO 8601`);
  }
  return d;
}

/** Keep the newest `limit` UIDs (UIDs grow monotonically within a mailbox). */
export function newestUids(uids: number[], limit: number): number[] {
  return [...uids].sort((a, b) => b - a).slice(0, Math.max(0, limit));
}

// ── Addresses & reply headers ───────────────────────────────────────────────

/** A parsed address as returned by postal-mime / imapflow envelopes. */
export interface Addr {
  name?: string;
  address?: string;
}

/** Render one address as `Name <a@b>` (or bare `a@b`). */
export function formatAddr(a: Addr): string {
  if (!a.address) return a.name ?? "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** Lower-case bare email, or "" when missing. */
export function bareAddr(a: Addr | string): string {
  if (typeof a === "string") {
    const m = a.match(/<([^>]+)>/);
    return (m ? m[1] : a).trim().toLowerCase();
  }
  return (a.address ?? "").trim().toLowerCase();
}

/** Prefix a subject once (`Re:` / `Fwd:`), case-insensitively. */
export function prefixSubject(subject: string, prefix: "Re" | "Fwd"): string {
  const s = subject.trim();
  const re = prefix === "Re" ? /^re\s*:/i : /^(fwd?|fw)\s*:/i;
  return re.test(s) ? s : `${prefix}: ${s}`;
}

/**
 * Work out recipients for a reply. Reply goes to Reply-To (else From);
 * reply-all also copies the original To+Cc, minus our own address and
 * anyone already in To.
 */
export function replyRecipients(
  original: { from?: Addr; replyTo?: Addr[]; to?: Addr[]; cc?: Addr[] },
  self: string,
  replyAll: boolean,
): { to: string[]; cc: string[] } {
  const me = bareAddr(self);
  const primary = original.replyTo?.length
    ? original.replyTo
    : original.from
    ? [original.from]
    : [];
  const to = dedupe(primary.map(formatAddr).filter(Boolean), new Set([me]));
  if (!replyAll) return { to, cc: [] };
  const seen = new Set([me, ...to.map(bareAddr)]);
  const cc = dedupe(
    [...(original.to ?? []), ...(original.cc ?? [])].map(formatAddr).filter(
      Boolean,
    ),
    seen,
  );
  return { to, cc };
}

function dedupe(list: string[], exclude: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set(exclude);
  for (const a of list) {
    const k = bareAddr(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** Build the References chain for a reply (RFC 5322 §3.6.4). */
export function replyReferences(
  messageId: string | undefined,
  references: string | string[] | undefined,
): string[] {
  const prior = Array.isArray(references)
    ? references
    : (references ?? "").split(/\s+/).filter(Boolean);
  const out = [...prior];
  if (messageId && !out.includes(messageId)) out.push(messageId);
  return out;
}

/** Quote a plain-text body with `> ` prefixes under an attribution line. */
export function quoteText(
  body: string,
  from: string,
  date: string | undefined,
): string {
  const when = date ? `On ${date}, ` : "";
  const quoted = body.replace(/\r\n/g, "\n").split("\n").map((l) => `> ${l}`)
    .join("\n");
  return `${when}${from} wrote:\n${quoted}`;
}

// ── Mailboxes ───────────────────────────────────────────────────────────────

/** Minimal mailbox shape we need from imapflow's `list()`. */
export interface MailboxEntry {
  path: string;
  specialUse?: string;
  flags?: Set<string> | string[];
}

/**
 * Find a mailbox by RFC 6154 special-use (`\Sent`, `\Trash`, `\Drafts`,
 * `\Archive`, `\Junk`), falling back to well-known English names Yandex uses
 * when a server omits the attribute.
 */
export function findSpecialUse(
  boxes: MailboxEntry[],
  use: "\\Sent" | "\\Trash" | "\\Drafts" | "\\Archive" | "\\Junk",
): string | undefined {
  const hit = boxes.find((b) =>
    b.specialUse === use || [...(b.flags ?? [])].includes(use)
  );
  if (hit) return hit.path;
  const names: Record<string, string[]> = {
    "\\Sent": ["Sent"],
    "\\Trash": ["Trash"],
    "\\Drafts": ["Drafts"],
    "\\Archive": ["Archive"],
    "\\Junk": ["Spam", "Junk"],
  };
  const lower = names[use].map((n) => n.toLowerCase());
  return boxes.find((b) => lower.includes(b.path.toLowerCase()))?.path;
}

// ── Maildir archive ─────────────────────────────────────────────────────────

const MAILDIR_FLAGS: Record<string, string> = {
  "\\Draft": "D",
  "\\Flagged": "F",
  "\\Answered": "R",
  "\\Seen": "S",
  "\\Deleted": "T",
};

/** Maildir info suffix (`2,FRS`) for IMAP flags; letters in ASCII order. */
export function maildirInfo(flags: Iterable<string>): string {
  const letters = [...new Set([...flags].map((f) => MAILDIR_FLAGS[f]))]
    .filter(Boolean).sort().join("");
  return `2,${letters}`;
}

/** Maildir file name for one message: `<uidvalidity>-<uid>:2,<flags>`. */
export function maildirName(
  uidValidity: string,
  uid: number,
  flags: Iterable<string>,
): string {
  return `${uidValidity}-${uid}:${maildirInfo(flags)}`;
}

/** Parse a name written by {@link maildirName}; null for foreign files. */
export function parseMaildirName(
  name: string,
): { uidValidity: string; uid: number } | null {
  const m = name.match(/^(\d+)-(\d+)(?::|$)/);
  return m ? { uidValidity: m[1], uid: Number(m[2]) } : null;
}

/**
 * Directory name for a mailbox: hierarchy delimiter becomes `.` (Maildir++
 * style, one flat directory per folder) and filesystem-unsafe characters are
 * replaced. Non-ASCII names (e.g. Cyrillic) are kept as-is.
 */
export function mailboxDirName(path: string, delimiter = "|"): string {
  const parts = delimiter ? path.split(delimiter) : [path];
  // deno-lint-ignore no-control-regex -- strip control chars from file names
  const name = parts.map((p) => p.replace(/[/\\:*?"<>.\x00-\x1f]/g, "_"))
    .join(".").trim();
  return name && name !== "." && name !== ".." ? name : "_";
}

/** UIDs already archived for the given UIDVALIDITY, from Maildir names. */
export function archivedUids(
  names: string[],
  uidValidity: string,
): Set<number> {
  const out = new Set<number>();
  for (const n of names) {
    const p = parseMaildirName(n);
    if (p && p.uidValidity === uidValidity) out.add(p.uid);
  }
  return out;
}

// ── Apple Mail cache ────────────────────────────────────────────────────────

/**
 * Extract the RFC 5322 message from an Apple Mail `.emlx` file: a decimal
 * byte count on the first line, then exactly that many bytes of message,
 * then an XML plist of Mail's metadata.
 */
export function parseEmlx(bytes: Uint8Array): Uint8Array {
  const nl = bytes.indexOf(0x0a);
  if (nl <= 0 || nl > 32) throw new Error("Not an emlx file: no length line");
  const len = Number(new TextDecoder().decode(bytes.subarray(0, nl)).trim());
  if (!Number.isInteger(len) || len <= 0 || nl + 1 + len > bytes.length) {
    throw new Error(`Not an emlx file: bad length ${len}`);
  }
  return bytes.subarray(nl + 1, nl + 1 + len);
}

/** IMAP flags from Apple Mail's `messages.flags` bit field. */
export function appleMailFlags(bits: number): string[] {
  const out: string[] = [];
  if (bits & 1) out.push("\\Seen");
  if (bits & 4) out.push("\\Answered");
  if (bits & 16) out.push("\\Flagged");
  return out;
}

/** Apple Mail's `mailboxes.url` for an IMAP folder of an account. */
export function appleMailboxUrl(
  accountId: string,
  path: string,
  delimiter = "|",
): string {
  const parts = delimiter ? path.split(delimiter) : [path];
  return `imap://${accountId}/${parts.map(encodeURIComponent).join("/")}`;
}

/** Map `<rowid>.emlx` / `<rowid>.partial.emlx` file names to their ROWID. */
export function emlxRowId(
  name: string,
): { rowId: number; partial: boolean } | null {
  const m = name.match(/^(\d+)(\.partial)?\.emlx$/);
  return m ? { rowId: Number(m[1]), partial: Boolean(m[2]) } : null;
}
