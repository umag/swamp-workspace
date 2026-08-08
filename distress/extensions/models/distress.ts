import { z } from "npm:zod@4";

// ============================================================================
// Vocabulary
// ============================================================================

/**
 * Severity ladder, ordered least → most urgent. The order IS the semantics:
 * `severityRank` indexes into this array, and every routing decision
 * (`minSeverity`, `broadcastFrom`, the critical rate-limit bypass) is a
 * comparison of two ranks. Inserting a level in the middle re-ranks every
 * existing channel config, so append only.
 */
export const SEVERITIES = ["info", "concern", "urgent", "critical"] as const;

/** One rung of {@link SEVERITIES}. */
export type Severity = typeof SEVERITIES[number];

const SeveritySchema = z.enum(SEVERITIES);

/**
 * What the call is about. Kept deliberately small and non-overlapping — the
 * category drives the dedupe key and the message headline, so a long tail of
 * near-synonyms would split one recurring problem into several "new" pages.
 */
export const CATEGORIES = [
  "welfare",
  "stuck",
  "blocked",
  "user-problem",
  "backend-error",
  "clarification",
  "other",
] as const;

/** One member of {@link CATEGORIES}. */
export type Category = typeof CATEGORIES[number];

const CategorySchema = z.enum(CATEGORIES);

/** Lifecycle state of a distress call. */
export const STATUSES = ["open", "acked", "resolved"] as const;

/** One member of {@link STATUSES}. */
export type Status = typeof STATUSES[number];

const StatusSchema = z.enum(STATUSES);

/**
 * Why a given delivery attempt happened. Recorded on every delivery so the
 * history distinguishes the page that opened a call from the one that
 * escalated it, and both from the beacon's own rate-limit notice.
 */
export const DELIVERY_KINDS = [
  "initial",
  "escalation",
  "rate-notice",
  "test",
] as const;

/** One member of {@link DELIVERY_KINDS}. */
export type DeliveryKind = typeof DELIVERY_KINDS[number];

/**
 * Rank a severity for comparison. Unknown strings rank lowest rather than
 * throwing: a severity that fell out of a stored record from an older schema
 * must never make a live call un-routable.
 *
 * @param s Severity name.
 * @returns Index into {@link SEVERITIES}; 0 for anything unrecognized.
 */
export function severityRank(s: string): number {
  const i = (SEVERITIES as readonly string[]).indexOf(s);
  return i < 0 ? 0 : i;
}

// ============================================================================
// Channel configuration
// ============================================================================

/**
 * Argument shapes of the message-sending models this beacon can drive. A
 * preset is only a starting set of `{{template}}` arguments — `arguments` on
 * the channel is merged over it, so an unusual callee needs no preset at all.
 *
 * - `text`        → `{text}`         (`@magistr/telegram/send` sendMessage)
 * - `title-body`  → `{title, body}`  (`@magistr/herdr` notify)
 * - `message`     → `{message}`
 * - `content`     → `{content}`      (`@keeb/discord/webhook` send)
 */
export const PRESETS = {
  "text": { text: "{{text}}" },
  "title-body": { title: "{{title}}", body: "{{body}}" },
  "message": { message: "{{text}}" },
  "content": { content: "{{text}}" },
} as const;

const PresetSchema = z.enum(
  Object.keys(PRESETS) as [
    keyof typeof PRESETS,
    ...Array<keyof typeof PRESETS>,
  ],
);

const FormatSchema = z.enum(["plain", "html", "markdown"]);

const ChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Label for this channel in delivery records and logs"),
  definition: z
    .string()
    .min(1)
    .describe(
      "Name of the swamp model INSTANCE that sends the message, e.g. tg-bot",
    ),
  method: z
    .string()
    .min(1)
    .describe("Method on that instance, e.g. sendMessage / notify / send"),
  preset: PresetSchema
    .default("text")
    .describe(
      "Starting argument shape: text | title-body | message | content",
    ),
  arguments: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({})
    .describe(
      "Extra/override arguments merged over the preset. String values are " +
        "rendered with {{placeholder}} substitution.",
    ),
  minSeverity: SeveritySchema
    .default("info")
    .describe("Lowest severity this channel is used for"),
  proofSpec: z
    .string()
    .optional()
    .describe(
      "Resource spec the callee writes on a real send (e.g. sentMessage). " +
        "When set, delivery is only believed if a NEW record of this spec " +
        "appears.",
    ),
  proofRequire: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({})
    .describe(
      "Field values the new proof record must carry, as dot-paths (e.g. " +
        '{"changed": true} for @magistr/herdr, whose notify writes an ' +
        "action record saying it was SUPPRESSED when toasts are disabled). " +
        'Use "*" to require merely that a field is present and truthy. ' +
        "Without this, a callee that records a no-op counts as a delivery.",
    ),
  format: FormatSchema
    .default("plain")
    .describe("Body rendering: plain, html (Telegram HTML), or markdown"),
  maxChars: z
    .number()
    .int()
    .min(80)
    .max(100000)
    .optional()
    .describe("Per-channel message cap; overrides maxMessageChars"),
  enabled: z.boolean().default(true).describe("Set false to park a channel"),
});

/** A configured delivery channel. */
export type Channel = z.infer<typeof ChannelSchema>;

const GlobalArgsSchema = z.object({
  channels: z
    .array(ChannelSchema)
    .default([])
    .describe(
      "Ordered delivery channels. Order is priority order for failover.",
    ),
  dispatch: z
    .enum(["failover", "broadcast"])
    .default("failover")
    .describe(
      "failover: stop at the first channel that PROVES delivery. " +
        "broadcast: always attempt every eligible channel.",
    ),
  broadcastFrom: SeveritySchema
    .default("urgent")
    .describe(
      "At or above this severity, failover upgrades to broadcast — a real " +
        "emergency should not depend on one transport being healthy.",
    ),
  requireDelivery: z
    .boolean()
    .default(true)
    .describe(
      "Throw when a call reached nobody. A distress call that vanished " +
        "silently is the failure this model exists to prevent.",
    ),
  dedupeWindowSeconds: z
    .number()
    .int()
    .min(0)
    .default(900)
    .describe(
      "Repeat calls with the same dedupe key inside this window fold into " +
        "the open call instead of paging again. 0 disables dedupe.",
    ),
  escalateAfterRepeats: z
    .number()
    .int()
    .min(1)
    .default(10)
    .describe(
      'After this many folded repeats, page once more ("still stuck, N ' +
        'repeats") and reset the counter.',
    ),
  maxCallsPerHour: z
    .number()
    .int()
    .min(1)
    .default(12)
    .describe(
      "Hard cap on DELIVERIES per rolling hour. Calls beyond it are still " +
        "recorded — they just stop paging.",
    ),
  criticalBypassesRateLimit: z
    .boolean()
    .default(true)
    .describe(
      "Let severity=critical page through the hourly cap. Dedupe still " +
        "applies, so a loop cannot exploit this.",
    ),
  maxMessageChars: z
    .number()
    .int()
    .min(80)
    .max(100000)
    .default(3500)
    .describe("Default message cap (Telegram's own limit is 4096)"),
  historyLimit: z
    .number()
    .int()
    .min(10)
    .max(2000)
    .default(200)
    .describe("How many call entries the beacon index keeps"),
  operator: z
    .string()
    .optional()
    .describe("Who is being paged; shown in the message header"),
});

/** Resolved instance configuration. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ============================================================================
// Resource schemas
// ============================================================================

const AgentSchema = z.object({
  name: z.string().optional(),
  model: z.string().optional(),
  session: z.string().optional(),
  host: z.string().optional(),
});

const DeliverySchema = z.object({
  channel: z.string(),
  definition: z.string(),
  method: z.string(),
  at: z.string(),
  ok: z.boolean(),
  kind: z.enum(DELIVERY_KINDS),
  proof: z.string().optional(),
  error: z.string().optional(),
});

/**
 * The rendered page, stored on the call record.
 *
 * Recorded so a transport that this model cannot drive in-process can still
 * send the EXACT page a channel would have sent. `context.runModel` cannot
 * reach every callee — a vault-backed instance such as a Telegram bot stalls
 * and returns nothing — and the reliable path for those is a workflow STEP.
 * A step has no access to the renderer, so the renderer's output has to be in
 * the data. See the `distress-page` workflow in the README.
 */
const PageSchema = z.object({
  title: z.string(),
  body: z.string(),
  text: z.string(),
});

const CallSchema = z.object({
  callId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSeenAt: z.string(),
  status: StatusSchema,
  severity: SeveritySchema,
  category: CategorySchema,
  summary: z.string(),
  detail: z.string().optional(),
  task: z.string().optional(),
  suggestedAction: z.string().optional(),
  agent: AgentSchema,
  dedupeKey: z.string(),
  repeats: z.number().int(),
  repeatsSinceEscalation: z.number().int(),
  escalations: z.number().int(),
  delivered: z.boolean(),
  deliveries: z.array(DeliverySchema),
  page: PageSchema.optional(),
  suppressedReason: z.enum(["dedupe", "rate-limit", "no-channel"]).optional(),
  acknowledgement: z
    .object({
      at: z.string(),
      by: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  resolution: z
    .object({
      at: z.string(),
      by: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
});

/** A durable distress call record. */
export type Call = z.infer<typeof CallSchema>;

const IndexEntrySchema = z.object({
  callId: z.string(),
  dedupeKey: z.string(),
  status: StatusSchema,
  severity: SeveritySchema,
  category: CategorySchema,
  summary: z.string(),
  agentName: z.string().optional(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  repeats: z.number().int(),
  repeatsSinceEscalation: z.number().int(),
  escalations: z.number().int(),
  delivered: z.boolean(),
  ackNote: z.string().optional(),
});

/** Compact index row for one call. */
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

const BeaconSchema = z.object({
  schemaVersion: z.number().int(),
  updatedAt: z.string(),
  calls: z.array(IndexEntrySchema),
  deliveries: z.array(z.string()),
  suppressedSinceNotice: z.number().int(),
  lastRateNoticeAt: z.string().optional(),
  totals: z.object({
    raised: z.number().int(),
    delivered: z.number().int(),
    deduped: z.number().int(),
    suppressed: z.number().int(),
    failed: z.number().int(),
  }),
});

/** Operational state of the beacon: index, rate window, counters. */
export type Beacon = z.infer<typeof BeaconSchema>;

const OutboundSchema = z.object({
  callId: z.string(),
  createdAt: z.string(),
  severity: SeveritySchema,
  category: CategorySchema,
  summary: z.string(),
  title: z.string(),
  body: z.string(),
  text: z.string(),
  html: z.string(),
});

const ListingSchema = z.object({
  generatedAt: z.string(),
  filter: z.string(),
  count: z.number().int(),
  calls: z.array(IndexEntrySchema),
});

const ChannelTestSchema = z.object({
  at: z.string(),
  channels: z.array(
    z.object({
      channel: z.string(),
      definition: z.string(),
      method: z.string(),
      ok: z.boolean(),
      proof: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  okCount: z.number().int(),
  failCount: z.number().int(),
});

/** A fresh, empty beacon. */
export function emptyBeacon(nowIso: string): Beacon {
  return {
    schemaVersion: 1,
    updatedAt: nowIso,
    calls: [],
    deliveries: [],
    suppressedSinceNotice: 0,
    totals: { raised: 0, delivered: 0, deduped: 0, suppressed: 0, failed: 0 },
  };
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * FNV-1a, 32-bit, hex. Not a security primitive — it exists only to turn a
 * dedupe string into a short stable id, so speed and determinism matter and
 * collision resistance does not.
 *
 * @param s Input string.
 * @returns 8-character lowercase hex digest.
 */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Normalize a summary for dedupe. Lowercases, collapses whitespace, and
 * replaces every run of digits with `#`.
 *
 * The digit collapse is the loop detector: an agent spinning in a tool-call
 * loop emits "retry 12 failed", "retry 13 failed", … — distinct strings that
 * describe one incident. Collapsing them to "retry # failed" folds the whole
 * loop into a single call instead of one page per iteration.
 *
 * @param s Raw summary text.
 * @returns Normalized form used for key derivation only — never displayed.
 */
export function normalizeSummary(s: string): string {
  return s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * Derive the dedupe key for a call when the caller did not supply one.
 * Category + normalized summary + agent name: the same agent reporting the
 * same kind of problem in the same words is the same incident.
 *
 * @param input Category, summary and optional agent name.
 * @returns Stable `auto-<hex>` key.
 */
export function deriveDedupeKey(
  input: { category: string; summary: string; agentName?: string },
): string {
  const basis = [
    input.category,
    normalizeSummary(input.summary),
    (input.agentName ?? "").toLowerCase().trim(),
  ].join("|");
  return `auto-${fnv1a(basis)}`;
}

/**
 * Build a call id that is unique without randomness, so every test can
 * predict it and no run depends on `Math.random`.
 *
 * `seq` — the beacon's lifetime raised-count — is what actually guarantees
 * uniqueness. The instant alone does not: with `dedupeWindowSeconds: 0`, two
 * genuinely distinct calls raised inside the same millisecond hash to the
 * same id, and the second overwrites the first's record. A distress call
 * disappearing because another arrived in the same tick is precisely the
 * failure this model exists to prevent, so the id carries a counter that
 * never repeats on an instance.
 *
 * @param nowIso ISO instant the call was raised.
 * @param dedupeKey The call's dedupe key.
 * @param seq Monotonic per-instance sequence number.
 * @returns Id of the form `dc-20260809T142233Z-1a2b3c`.
 */
export function makeCallId(
  nowIso: string,
  dedupeKey: string,
  seq: number,
): string {
  const compact = nowIso.replace(/[-:]/g, "").replace(/\.\d+/, "");
  return `dc-${compact}-${fnv1a(`${nowIso}|${dedupeKey}|${seq}`).slice(0, 6)}`;
}

/**
 * Cut a string to `max` characters, marking the cut so a truncated page is
 * never mistaken for a complete one.
 *
 * @param s Text to bound.
 * @param max Maximum length of the result, including the marker.
 * @returns `s` unchanged, or a truncated form ending in `… [truncated]`.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const marker = "… [truncated]";
  if (max <= marker.length) return s.slice(0, max);
  return s.slice(0, max - marker.length) + marker;
}

/**
 * Escape the five characters that would otherwise be parsed as markup by
 * Telegram's HTML parse mode. Applied to every interpolated field — a summary
 * containing `<` must not be able to inject tags into the page, and must not
 * make Telegram reject the whole message as malformed entities.
 *
 * @param s Raw text.
 * @returns HTML-safe text.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape Telegram MarkdownV2's reserved punctuation.
 *
 * @param s Raw text.
 * @returns MarkdownV2-safe text.
 */
export function escapeMarkdown(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Apply the escaping a given render format requires.
 *
 * @param s Raw text.
 * @param format Channel render format.
 * @returns Escaped text.
 */
export function escapeFor(s: string, format: string): string {
  if (format === "html") return escapeHtml(s);
  if (format === "markdown") return escapeMarkdown(s);
  return s;
}

/**
 * Select the channels a call of this severity may use, in configured order.
 * Disabled channels and channels whose `minSeverity` outranks the call are
 * dropped.
 *
 * @param channels Configured channels.
 * @param severity Severity of the call.
 * @returns Eligible channels, priority-ordered.
 */
export function eligibleChannels(
  channels: Channel[],
  severity: string,
): Channel[] {
  const rank = severityRank(severity);
  return channels.filter(
    (c) => c.enabled !== false && rank >= severityRank(c.minSeverity),
  );
}

/**
 * Decide whether this call fans out to every eligible channel or stops at the
 * first proven delivery.
 *
 * @param cfg Instance configuration.
 * @param severity Severity of the call.
 * @returns True when every eligible channel should be attempted.
 */
export function shouldBroadcast(
  cfg: { dispatch: string; broadcastFrom: string },
  severity: string,
): boolean {
  if (cfg.dispatch === "broadcast") return true;
  return severityRank(severity) >= severityRank(cfg.broadcastFrom);
}

/**
 * Drop delivery timestamps that have fallen out of the rolling window.
 * Unparseable entries are dropped too — a corrupt timestamp must not be able
 * to pin the rate limiter open (or shut) forever.
 *
 * @param stamps ISO timestamps of past deliveries.
 * @param nowMs Current epoch millis.
 * @param windowMs Width of the rolling window.
 * @returns The timestamps still inside the window.
 */
export function pruneStamps(
  stamps: string[],
  nowMs: number,
  windowMs: number,
): string[] {
  return stamps.filter((s) => {
    const t = Date.parse(s);
    return Number.isFinite(t) && nowMs - t < windowMs;
  });
}

/**
 * Is this call over the hourly delivery cap?
 *
 * `critical` may be exempted (`criticalBypassesRateLimit`) because the cap
 * exists to contain a chatty agent, not to gag a real emergency — and dedupe,
 * which a loop cannot evade, still applies to critical calls.
 *
 * @param recent Delivery timestamps already inside the window.
 * @param cfg Rate-limit configuration.
 * @param severity Severity of the call.
 * @returns True when the call must not page.
 */
export function isRateLimited(
  recent: string[],
  cfg: { maxCallsPerHour: number; criticalBypassesRateLimit: boolean },
  severity: string,
): boolean {
  if (severity === "critical" && cfg.criticalBypassesRateLimit) return false;
  return recent.length >= cfg.maxCallsPerHour;
}

/**
 * Find the open call this one is a repeat of: same dedupe key, not resolved,
 * last seen inside the dedupe window.
 *
 * @param calls Beacon index.
 * @param dedupeKey Key of the incoming call.
 * @param nowMs Current epoch millis.
 * @param windowSeconds Dedupe window; 0 disables dedupe entirely.
 * @returns The matching entry, or null.
 */
export function findOpenDuplicate(
  calls: IndexEntry[],
  dedupeKey: string,
  nowMs: number,
  windowSeconds: number,
): IndexEntry | null {
  if (windowSeconds <= 0) return null;
  const windowMs = windowSeconds * 1000;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c.dedupeKey !== dedupeKey) continue;
    if (c.status === "resolved") continue;
    const t = Date.parse(c.lastSeenAt);
    if (!Number.isFinite(t)) continue;
    if (nowMs - t <= windowMs) return c;
  }
  return null;
}

// ============================================================================
// Message rendering
// ============================================================================

/**
 * The rendered page: a headline, a body, and the concatenation actually sent
 * to single-field channels.
 */
export type Message = { title: string; body: string; text: string };

/**
 * Render a distress call into a page.
 *
 * BLUF: the headline carries severity, category and the summary, so a phone
 * lock screen shows what happened without expanding anything. The body then
 * gives detail, who is calling, what they suggest, and the exact command to
 * answer them — a page you cannot act on from where you read it is a page
 * that will be read and forgotten.
 *
 * @param call The call to render.
 * @param opts Instance name (for the ack hint), format, cap, and kind.
 * @returns Title, body and combined text, already escaped and bounded.
 */
export function buildMessage(
  call: Call,
  opts: {
    instance: string;
    format: string;
    maxChars: number;
    kind: DeliveryKind;
    operator?: string;
  },
): Message {
  const e = (s: string) => escapeFor(s, opts.format);
  const isEscalation = opts.kind === "escalation";

  const head = isEscalation
    ? `STILL ${call.category.toUpperCase()} (${call.repeats} repeats)`
    : `${call.severity.toUpperCase()} ${call.category}`;
  const title = truncate(`${head}: ${call.summary}`, 200);

  const lines: string[] = [];
  if (isEscalation) {
    lines.push(
      `Unresolved since ${call.createdAt}; ${call.repeats} repeat(s) folded ` +
        `into this call.`,
    );
    lines.push("");
  }
  if (call.detail) {
    lines.push(e(call.detail));
    lines.push("");
  }

  const who = [
    call.agent.name,
    call.agent.model ? `(${call.agent.model})` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  if (who) lines.push(`Agent: ${e(who)}`);
  if (call.agent.session) lines.push(`Session: ${e(call.agent.session)}`);
  if (call.agent.host) lines.push(`Host: ${e(call.agent.host)}`);
  if (call.task) lines.push(`Task: ${e(call.task)}`);
  if (call.suggestedAction) {
    lines.push(`Suggested: ${e(call.suggestedAction)}`);
  }
  if (opts.operator) lines.push(`For: ${e(opts.operator)}`);
  lines.push(`Call: ${e(call.callId)} · raised ${e(call.createdAt)}`);
  lines.push(
    `Answer: swamp model method run ${e(opts.instance)} ack ` +
      `--input callId=${e(call.callId)} --input note='...'`,
  );

  const body = truncate(lines.join("\n"), Math.max(40, opts.maxChars - 220));
  const heading = opts.format === "html"
    ? `<b>${escapeHtml(title)}</b>`
    : opts.format === "markdown"
    ? `*${escapeMarkdown(title)}*`
    : title;

  return {
    title,
    body,
    text: truncate(`${heading}\n\n${body}`, opts.maxChars),
  };
}

/**
 * Render the beacon's own rate-limit notice. Sent once per hour, at most, so
 * that a muted beacon still tells the operator it is muted — silence caused
 * by throttling must not look like silence caused by nothing being wrong.
 *
 * @param opts Suppressed count, the latest summary, instance name, format,
 *             and message cap.
 * @returns Title, body and combined text.
 */
export function buildRateNotice(
  opts: {
    suppressed: number;
    latestSummary: string;
    instance: string;
    format: string;
    maxChars: number;
    maxCallsPerHour: number;
  },
): Message {
  const e = (s: string) => escapeFor(s, opts.format);
  const title = `distress beacon throttled: ${opts.suppressed} call(s) ` +
    `suppressed`;
  const body = [
    `The hourly cap (${opts.maxCallsPerHour} deliveries) is reached, so ` +
    `further calls are recorded but not paged.`,
    `Latest: ${e(truncate(opts.latestSummary, 300))}`,
    `Review: swamp model method run ${e(opts.instance)} list`,
  ].join("\n");
  const heading = opts.format === "html"
    ? `<b>${escapeHtml(title)}</b>`
    : opts.format === "markdown"
    ? `*${escapeMarkdown(title)}*`
    : title;
  return {
    title,
    body,
    text: truncate(`${heading}\n\n${body}`, opts.maxChars),
  };
}

/**
 * Substitute `{{placeholder}}` tokens. An unknown placeholder is left
 * untouched on purpose: a visible `{{typo}}` in a delivered page is a bug
 * report, whereas silently blanking it hides a broken channel config behind a
 * message that still looks fine.
 *
 * @param tpl Template string.
 * @param fields Available values.
 * @returns Rendered string.
 */
export function renderTemplate(
  tpl: string,
  fields: Record<string, string>,
): string {
  return tpl.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : whole,
  );
}

/**
 * Argument names never forwarded to a callee. Assigning `__proto__` through
 * `out[key]` mutates the object's prototype instead of adding an argument, so
 * a channel config carrying one would build a different object than it reads
 * as. Dropping them keeps `buildChannelArgs` a plain data transform.
 */
export const UNSAFE_ARG_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Build the argument object handed to a channel's model method: the preset,
 * overlaid with the channel's own `arguments`, with every string value
 * template-rendered.
 *
 * @param channel Channel configuration.
 * @param fields Template values.
 * @returns Arguments for `context.runModel`.
 */
export function buildChannelArgs(
  channel: Channel,
  fields: Record<string, string>,
): Record<string, unknown> {
  const preset = PRESETS[channel.preset as keyof typeof PRESETS] ??
    PRESETS.text;
  const merged: Record<string, string | number | boolean> = {
    ...preset,
    ...(channel.arguments ?? {}),
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (UNSAFE_ARG_KEYS.has(k)) continue;
    out[k] = typeof v === "string" ? renderTemplate(v, fields) : v;
  }
  return out;
}

/**
 * Template values exposed to channel `arguments`.
 *
 * @param message The rendered page.
 * @param call The call it describes.
 * @returns Flat string map for {@link renderTemplate}.
 */
export function messageFields(
  message: Message,
  call: Call,
): Record<string, string> {
  return {
    title: message.title,
    body: message.body,
    text: message.text,
    callId: call.callId,
    severity: call.severity,
    category: call.category,
    summary: call.summary,
    detail: call.detail ?? "",
    task: call.task ?? "",
    suggestedAction: call.suggestedAction ?? "",
    agentName: call.agent.name ?? "",
    agentModel: call.agent.model ?? "",
    agentSession: call.agent.session ?? "",
    host: call.agent.host ?? "",
    repeats: String(call.repeats),
    createdAt: call.createdAt,
  };
}

// ============================================================================
// Delivery
// ============================================================================

/** Longest channel error text kept in a durable delivery record. */
export const MAX_ERROR_CHARS = 500;

/**
 * Scrub a channel's error text before it is written to a durable record.
 *
 * This model holds no credentials — each transport keeps its own — but it
 * does persist whatever error a transport throws, and transports handle
 * secrets. A callee whose error text embeds its own token would otherwise
 * write that token into swamp data permanently, from a model that never had
 * any business seeing it. Bearer tokens, `/bot<token>/` URL segments,
 * `key=`/`token=` query parameters, and Basic-auth userinfo in a URL are
 * replaced; the text is then bounded, since an unbounded error is its own
 * kind of storage problem.
 *
 * @param message Raw error text.
 * @returns Redacted, length-bounded text.
 */
export function redactSecrets(message: string): string {
  const scrubbed = message
    .replace(/\/bot[^/\s]+\//gi, "/bot<redacted>/")
    .replace(/\b(bearer|basic)\s+[\w\-._~+/]+=*/gi, "$1 <redacted>")
    .replace(
      /\b(api[-_]?key|token|secret|password|passwd|pwd)(["'\s]*[:=]["'\s]*)[^\s"'&,}]+/gi,
      "$1$2<redacted>",
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
      "$1<redacted>@",
    );
  return truncate(scrubbed, MAX_ERROR_CHARS);
}

/** Outcome of one attempt to page one channel. */
export type DeliveryResult = {
  channel: string;
  definition: string;
  method: string;
  at: string;
  ok: boolean;
  kind: DeliveryKind;
  proof?: string;
  error?: string;
};

/** The slice of model context delivery needs. */
export type DeliveryCtx = {
  runModel?: (
    options: {
      definition: string;
      method: string;
      arguments: Record<string, unknown>;
    },
  ) => Promise<{ resources?: Array<{ name?: string }> } | undefined>;
  readModelData?: (
    name: string,
    specName?: string,
  ) => Promise<Array<Record<string, unknown>>>;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/**
 * Identify a data row across a before/after read. Prefers the row id, falls
 * back to name+version — enough to tell "the record that was already there"
 * from "the record this send just wrote".
 *
 * @param row A row from `readModelData`.
 * @returns Stable identity string.
 */
function rowKey(row: Record<string, unknown>): string {
  const id = row.id ?? row.dataId;
  if (typeof id === "string" && id) return id;
  return `${String(row.name ?? "")}@${String(row.version ?? "")}`;
}

/**
 * Read the callee's proof spec, tolerating a runtime that does not expose
 * `readModelData` at all.
 *
 * @param ctx Model context.
 * @param definition Callee instance name.
 * @param spec Resource spec to read.
 * @returns The rows currently present (empty when unreadable).
 */
async function proofRows(
  ctx: DeliveryCtx,
  definition: string,
  spec: string,
): Promise<Array<Record<string, unknown>>> {
  if (!ctx.readModelData) return [];
  try {
    return (await ctx.readModelData(definition, spec)) ?? [];
  } catch {
    return [];
  }
}

/**
 * Follow a dot-path into a record, looking under `.attributes` first —
 * `readModelData` rows carry their parsed payload there — and falling back to
 * the row's own top level and `.content`.
 *
 * @param row A data row.
 * @param path Dot-separated field path.
 * @returns The value, or undefined.
 */
export function readPath(
  row: Record<string, unknown>,
  path: string,
): unknown {
  const segments = path.split(".");
  const roots = [row.attributes, row, row.content];
  for (const root of roots) {
    let cursor: unknown = root;
    let ok = true;
    for (const segment of segments) {
      if (cursor === null || typeof cursor !== "object") {
        ok = false;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (ok && cursor !== undefined) return cursor;
  }
  return undefined;
}

/**
 * Check a proof record against a channel's `proofRequire`.
 *
 * This is what separates "the callee wrote something" from "the callee did
 * something". `@magistr/herdr`'s `notify` writes an `action` record either
 * way — when toasts are disabled in herdr's config it records
 * `changed: false, status: "suppressed", detail: "notification not shown
 * (disabled)"` — so a beacon that trusts the record's existence reports a
 * page nobody saw. Observed live: a channel test came back green while both
 * channels were dark.
 *
 * @param row The new proof record.
 * @param require Field dot-paths to required values; `"*"` means "present
 *                and truthy".
 * @returns An explanatory message when the record fails the check, else null.
 */
export function checkProofRequire(
  row: Record<string, unknown>,
  require: Record<string, string | number | boolean>,
): string | null {
  for (const [path, expected] of Object.entries(require ?? {})) {
    const actual = readPath(row, path);
    if (expected === "*") {
      if (!actual) {
        return `expected "${path}" to be present and truthy, got ` +
          `${JSON.stringify(actual)}`;
      }
      continue;
    }
    if (actual !== expected) {
      return `expected "${path}" to be ${JSON.stringify(expected)}, got ` +
        `${JSON.stringify(actual)}`;
    }
  }
  return null;
}

/**
 * Send one page through one channel and PROVE it landed.
 *
 * `await` returning is not evidence. Under `swamp serve`, `context.runModel`
 * has been observed to resolve without ever executing the callee — three days
 * of green runs delivered nothing. For a beacon that is the worst possible
 * failure, so delivery is believed only on evidence:
 *
 * 1. the call must return at least one resource handle, and
 * 2. when `proofSpec` is set, a NEW record of that spec must have appeared
 *    that was not there before the call.
 *
 * Anything less is reported as a failed delivery, which lets the caller fail
 * over to the next channel instead of going quiet.
 *
 * @param channel Channel to use.
 * @param args Arguments for the callee's method.
 * @param kind Why this delivery is happening.
 * @param nowIso Timestamp to record.
 * @param ctx Model context.
 * @returns The delivery outcome — never throws.
 */
export async function deliverVia(
  channel: Channel,
  args: Record<string, unknown>,
  kind: DeliveryKind,
  nowIso: string,
  ctx: DeliveryCtx,
): Promise<DeliveryResult> {
  const base = {
    channel: channel.name,
    definition: channel.definition,
    method: channel.method,
    at: nowIso,
    kind,
  };
  if (!ctx.runModel) {
    return {
      ...base,
      ok: false,
      error: "context.runModel is unavailable in this runtime",
    };
  }
  try {
    const before = channel.proofSpec
      ? await proofRows(ctx, channel.definition, channel.proofSpec)
      : null;
    const beforeKeys = new Set((before ?? []).map(rowKey));

    const res = await ctx.runModel({
      definition: channel.definition,
      method: channel.method,
      arguments: args,
    });
    const handles = res?.resources ?? [];
    if (handles.length === 0) {
      return {
        ...base,
        ok: false,
        error: `${channel.definition}.${channel.method} returned no resource ` +
          `handles — the call came back without delivering.`,
      };
    }

    if (channel.proofSpec && before) {
      const after = await proofRows(ctx, channel.definition, channel.proofSpec);
      const fresh = after.filter((r) => !beforeKeys.has(rowKey(r)));
      if (after.length > 0 && fresh.length === 0) {
        return {
          ...base,
          ok: false,
          error: `${channel.definition} wrote no new "${channel.proofSpec}" ` +
            `record — delivery could not be proven.`,
        };
      }
      if (fresh.length > 0) {
        // The record exists. Does it say anything HAPPENED? A callee that
        // records its own no-op must not read as a delivery.
        const complaint = checkProofRequire(
          fresh[0],
          channel.proofRequire ?? {},
        );
        if (complaint) {
          return {
            ...base,
            ok: false,
            error: `${channel.definition} recorded a "${channel.proofSpec}" ` +
              `that does not evidence delivery — ${complaint}.`,
          };
        }
        return { ...base, ok: true, proof: rowKey(fresh[0]) };
      }
    }

    return { ...base, ok: true, proof: handles[0]?.name ?? "handle" };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Page every channel this call is entitled to, in priority order.
 *
 * In failover mode the walk stops at the first PROVEN delivery; at or above
 * `broadcastFrom` (or with `dispatch: broadcast`) every eligible channel is
 * attempted, so an emergency never rides on one transport being healthy.
 *
 * Each channel gets its OWN rendering: format and length budget are
 * per-channel, so a herdr toast never carries a 3500-character Telegram page.
 *
 * @param channels Eligible channels, priority-ordered.
 * @param broadcast Attempt all rather than stopping at the first success.
 * @param call The call being paged.
 * @param kind Why this delivery is happening.
 * @param nowIso Timestamp to record.
 * @param cfg Default message cap, instance name, operator.
 * @param ctx Model context.
 * @returns One result per attempted channel.
 */
export async function dispatchAll(
  channels: Channel[],
  broadcast: boolean,
  call: Call,
  kind: DeliveryKind,
  nowIso: string,
  cfg: { maxMessageChars: number; instance: string; operator?: string },
  ctx: DeliveryCtx,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const channel of channels) {
    const perChannel = buildMessage(call, {
      instance: cfg.instance,
      format: channel.format,
      maxChars: channel.maxChars ?? cfg.maxMessageChars,
      kind,
      operator: cfg.operator,
    });
    const fields = messageFields(perChannel, call);
    const args = buildChannelArgs(channel, fields);
    const result = await deliverVia(channel, args, kind, nowIso, ctx);
    results.push(result);
    if (result.ok) {
      ctx.logger?.info("Distress {call} delivered via {channel}", {
        call: call.callId,
        channel: channel.name,
      });
      if (!broadcast) break;
    } else {
      ctx.logger?.warning("Distress {call} failed on {channel}: {error}", {
        call: call.callId,
        channel: channel.name,
        error: result.error ?? "unknown",
      });
    }
  }
  return results;
}

// ============================================================================
// Index maintenance
// ============================================================================

/**
 * Project a call into its compact index row.
 *
 * @param call The call.
 * @returns Index entry.
 */
export function toIndexEntry(call: Call): IndexEntry {
  return {
    callId: call.callId,
    dedupeKey: call.dedupeKey,
    status: call.status,
    severity: call.severity,
    category: call.category,
    summary: call.summary,
    agentName: call.agent.name,
    createdAt: call.createdAt,
    lastSeenAt: call.lastSeenAt,
    repeats: call.repeats,
    repeatsSinceEscalation: call.repeatsSinceEscalation,
    escalations: call.escalations,
    delivered: call.delivered,
    ackNote: call.acknowledgement?.note,
  };
}

/**
 * Insert or replace an index row, then bound the index to `limit` entries.
 *
 * Two rules, in this order:
 *
 * 1. **The upserted row always survives.** Dropping the row just written
 *    would lose the very call that is happening now — and `ack`/`resolve`
 *    find their target through this index, so a call missing from it is a
 *    call nobody can answer.
 * 2. **Live beats resolved.** The index is a worklist first and a history
 *    second, so the remaining slots go to open and acked calls (newest
 *    first) before any resolved one.
 *
 * Surviving rows keep their original relative order, with the upserted row
 * last, so the index reads oldest-to-newest.
 *
 * @param calls Current index.
 * @param entry Row to upsert.
 * @param limit Maximum rows to keep; must be at least 1.
 * @returns The new index.
 */
export function upsertEntry(
  calls: IndexEntry[],
  entry: IndexEntry,
  limit: number,
): IndexEntry[] {
  const rest = calls.filter((c) => c.callId !== entry.callId);
  if (rest.length + 1 <= limit) return [...rest, entry];

  const budget = Math.max(0, limit - 1);
  const live = rest.filter((c) => c.status !== "resolved");
  const closed = rest.filter((c) => c.status === "resolved");
  const keptLive = live.slice(Math.max(0, live.length - budget));
  const remaining = budget - keptLive.length;
  const keptClosed = remaining > 0
    ? closed.slice(Math.max(0, closed.length - remaining))
    : [];
  const keep = new Set<IndexEntry>([...keptLive, ...keptClosed]);
  return [...rest.filter((c) => keep.has(c)), entry];
}

// ============================================================================
// Model
// ============================================================================

type BaseCtx = {
  globalArgs: GlobalArgs;
  definition?: { name?: string };
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
} & DeliveryCtx;

const BEACON_RESOURCE = "current";
const HOUR_MS = 3600_000;

/**
 * Load the beacon index, tolerating a first run and a record written by an
 * older schema.
 *
 * @param ctx Model context.
 * @param nowIso Current instant, used to seed an empty beacon.
 * @returns The beacon state.
 */
async function loadBeacon(ctx: BaseCtx, nowIso: string): Promise<Beacon> {
  if (!ctx.readResource) return emptyBeacon(nowIso);
  const raw = await ctx.readResource(BEACON_RESOURCE);
  if (!raw) return emptyBeacon(nowIso);
  const parsed = BeaconSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyBeacon(nowIso);
}

/**
 * Load one call record by id.
 *
 * @param ctx Model context.
 * @param callId Call to read.
 * @returns The call, or null when absent/unparseable.
 */
async function loadCall(ctx: BaseCtx, callId: string): Promise<Call | null> {
  if (!ctx.readResource) return null;
  const raw = await ctx.readResource(callId);
  if (!raw) return null;
  const parsed = CallSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve the instance name for the ack hint printed in every page.
 *
 * @param ctx Model context.
 * @returns Instance name, or a sensible placeholder.
 */
function instanceName(ctx: BaseCtx): string {
  return ctx.definition?.name ?? "distress";
}

/**
 * `@magistr/distress` — a distress-call beacon for AI agents.
 *
 * Any agent, including a background agent with no user watching, can page a
 * human at any time and for any reason: a user problem, a backend failure, a
 * task it cannot finish, a request for clarification, or its own distress.
 *
 * Delivery is pluggable by configuration, not by code: a channel names an
 * existing swamp model instance and one of its methods, so `@magistr/telegram
 * /send`, `@magistr/herdr`, `@keeb/discord/webhook` — or anything else that
 * can send a message — becomes a channel without touching this extension.
 * This model holds no credentials of its own; each transport keeps its own.
 *
 * Two properties make it trustworthy enough to build on:
 *
 * - **Delivery is proven, never assumed.** `runModel` returning is not
 *   evidence; a send counts only when the callee returns a resource handle
 *   and (with `proofSpec`) writes a new record. Unproven sends fail over to
 *   the next channel, and a call that reached nobody fails loudly.
 * - **The beacon cannot become the loop.** Repeats inside the dedupe window
 *   fold into the open call instead of paging again, digits in the summary
 *   are collapsed so "retry 12/13/14 failed" is one incident, and an hourly
 *   cap bounds total pages while still recording every call.
 *
 * Methods: `call`, `ack`, `resolve`, `list`, `test`.
 *
 * @example
 * swamp model create @magistr/distress distress
 * swamp model method run distress call \
 *   --input summary='stuck retrying the same tool call' \
 *   --input severity=urgent --input category=stuck
 *
 * @internal The exported object's type references Zod internals; drive it
 * through the swamp CLI rather than importing it.
 */
export const model = {
  type: "@magistr/distress",
  version: "2026.08.09.1",

  globalArguments: GlobalArgsSchema,

  resources: {
    call: {
      description:
        "One distress call — severity, category, who raised it, every " +
        "delivery attempt, and its acknowledgement/resolution",
      schema: CallSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
    beacon: {
      description:
        "Operational state: the call index, the rolling delivery window " +
        "used for rate limiting, and lifetime counters",
      schema: BeaconSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    outbound: {
      description:
        "The most recent call's rendered page, under a STABLE name so a " +
        "workflow step can send it. Written only for a call that was " +
        "actually raised (not a folded repeat, not a throttled one), and " +
        "tagged with its run — the transports this model cannot drive " +
        "in-process are reached by a step that reads this.",
      schema: OutboundSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    listing: {
      description: "Result of the most recent `list` call",
      schema: ListingSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    channelTest: {
      description: "Per-channel result of the most recent `test` call",
      schema: ChannelTestSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    call: {
      description:
        "Raise a distress call. Routes by severity to the configured " +
        "channels, proves delivery, and records the call durably even when " +
        "no channel could be reached. Repeats inside the dedupe window fold " +
        "into the open call rather than paging again.",
      arguments: z.object({
        summary: z
          .string()
          .min(1)
          .describe("One line, bottom-line-first: what is wrong"),
        severity: SeveritySchema
          .default("concern")
          .describe("info | concern | urgent | critical"),
        category: CategorySchema
          .default("other")
          .describe(
            "welfare | stuck | blocked | user-problem | backend-error | " +
              "clarification | other",
          ),
        detail: z
          .string()
          .optional()
          .describe("Fuller description: what was tried, what happened"),
        task: z.string().optional().describe("What the agent was doing"),
        suggestedAction: z
          .string()
          .optional()
          .describe("What the human could do about it"),
        agentName: z.string().optional().describe("Who is calling"),
        agentModel: z.string().optional().describe("Model behind the agent"),
        agentSession: z.string().optional().describe("Session/run id"),
        host: z.string().optional().describe("Where the agent runs"),
        dedupeKey: z
          .string()
          .optional()
          .describe(
            "Explicit incident key. Omit to derive one from category, " +
              "summary and agent — digits are collapsed so a counting loop " +
              "folds into a single call.",
          ),
      }),
      execute: async (
        args: {
          summary: string;
          severity: Severity;
          category: Category;
          detail?: string;
          task?: string;
          suggestedAction?: string;
          agentName?: string;
          agentModel?: string;
          agentSession?: string;
          host?: string;
          dedupeKey?: string;
        },
        context: BaseCtx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const cfg = context.globalArgs;
        const now = new Date();
        const nowIso = now.toISOString();
        const nowMs = now.getTime();
        const instance = instanceName(context);

        const beacon = await loadBeacon(context, nowIso);
        beacon.deliveries = pruneStamps(beacon.deliveries, nowMs, HOUR_MS);

        const dedupeKey = args.dedupeKey ??
          deriveDedupeKey({
            category: args.category,
            summary: args.summary,
            agentName: args.agentName,
          });

        // ---- Repeat of an open call? Fold it in. --------------------------
        const dup = findOpenDuplicate(
          beacon.calls,
          dedupeKey,
          nowMs,
          cfg.dedupeWindowSeconds,
        );
        if (dup) {
          const existing = await loadCall(context, dup.callId);
          const folded: Call = existing ? { ...existing } : {
            callId: dup.callId,
            createdAt: dup.createdAt,
            updatedAt: nowIso,
            lastSeenAt: dup.lastSeenAt,
            status: dup.status,
            severity: dup.severity,
            category: dup.category,
            summary: dup.summary,
            agent: { name: dup.agentName },
            dedupeKey: dup.dedupeKey,
            repeats: dup.repeats,
            repeatsSinceEscalation: dup.repeatsSinceEscalation,
            escalations: dup.escalations,
            delivered: dup.delivered,
            deliveries: [],
          };
          folded.repeats += 1;
          folded.repeatsSinceEscalation += 1;
          folded.lastSeenAt = nowIso;
          folded.updatedAt = nowIso;
          // A repeat that arrives hotter than the original raises the call's
          // severity — an incident that escalates in the world should
          // escalate here rather than stay pinned at its first reading.
          if (severityRank(args.severity) > severityRank(folded.severity)) {
            folded.severity = args.severity;
          }
          if (args.detail) folded.detail = args.detail;
          folded.suppressedReason = "dedupe";

          let escalated = false;
          if (folded.repeatsSinceEscalation >= cfg.escalateAfterRepeats) {
            const eligible = eligibleChannels(cfg.channels, folded.severity);
            const results = await dispatchAll(
              eligible,
              shouldBroadcast(cfg, folded.severity),
              folded,
              "escalation",
              nowIso,
              {
                maxMessageChars: cfg.maxMessageChars,
                instance,
                operator: cfg.operator,
              },
              context,
            );
            folded.deliveries = [...folded.deliveries, ...results];
            if (results.some((r) => r.ok)) {
              folded.delivered = true;
              folded.repeatsSinceEscalation = 0;
              folded.escalations += 1;
              beacon.deliveries.push(nowIso);
              beacon.totals.delivered += 1;
              escalated = true;
            } else {
              beacon.totals.failed += 1;
            }
          }

          beacon.totals.deduped += 1;
          beacon.calls = upsertEntry(
            beacon.calls,
            toIndexEntry(folded),
            cfg.historyLimit,
          );
          beacon.updatedAt = nowIso;

          const callHandle = await context.writeResource(
            "call",
            folded.callId,
            folded as unknown as Record<string, unknown>,
          );
          const beaconHandle = await context.writeResource(
            "beacon",
            BEACON_RESOURCE,
            beacon as unknown as Record<string, unknown>,
          );
          context.logger?.info(
            escalated
              ? "Repeat #{n} of {call} escalated"
              : "Repeat #{n} of {call} folded in (no new page)",
            { n: folded.repeats, call: folded.callId },
          );
          return { dataHandles: [callHandle, beaconHandle] };
        }

        // ---- A new call. --------------------------------------------------
        // `totals.raised` is monotonic for the life of the instance, so it is
        // the one value that can keep two same-millisecond calls apart.
        const callId = makeCallId(nowIso, dedupeKey, beacon.totals.raised);
        const call: Call = {
          callId,
          createdAt: nowIso,
          updatedAt: nowIso,
          lastSeenAt: nowIso,
          status: "open",
          severity: args.severity,
          category: args.category,
          summary: args.summary,
          detail: args.detail,
          task: args.task,
          suggestedAction: args.suggestedAction,
          agent: {
            name: args.agentName,
            model: args.agentModel,
            session: args.agentSession,
            host: args.host,
          },
          dedupeKey,
          repeats: 0,
          repeatsSinceEscalation: 0,
          escalations: 0,
          delivered: false,
          deliveries: [],
        };
        beacon.totals.raised += 1;

        // Record the rendered page on the call itself. A transport this
        // model cannot drive in-process — a vault-backed Telegram bot, say —
        // is reached by a workflow STEP instead, and a step can only send
        // what is in the data.
        call.page = buildMessage(call, {
          instance,
          format: "plain",
          maxChars: cfg.maxMessageChars,
          kind: "initial",
          operator: cfg.operator,
        });

        const eligible = eligibleChannels(cfg.channels, call.severity);
        const throttled = isRateLimited(beacon.deliveries, cfg, call.severity);

        if (eligible.length === 0) {
          call.suppressedReason = "no-channel";
        } else if (throttled) {
          call.suppressedReason = "rate-limit";
          beacon.suppressedSinceNotice += 1;
          beacon.totals.suppressed += 1;
          // Tell the operator once per hour that the beacon is muted —
          // throttled silence must not be indistinguishable from calm.
          const lastNotice = beacon.lastRateNoticeAt
            ? Date.parse(beacon.lastRateNoticeAt)
            : NaN;
          const noticeDue = !Number.isFinite(lastNotice) ||
            nowMs - lastNotice >= HOUR_MS;
          if (noticeDue) {
            const target = eligible[0];
            const notice = buildRateNotice({
              suppressed: beacon.suppressedSinceNotice,
              latestSummary: call.summary,
              instance,
              format: target.format,
              maxChars: target.maxChars ?? cfg.maxMessageChars,
              maxCallsPerHour: cfg.maxCallsPerHour,
            });
            const noticeArgs = buildChannelArgs(
              target,
              messageFields(notice, call),
            );
            const res = await deliverVia(
              target,
              noticeArgs,
              "rate-notice",
              nowIso,
              context,
            );
            call.deliveries.push(res);
            if (res.ok) {
              beacon.lastRateNoticeAt = nowIso;
              beacon.suppressedSinceNotice = 0;
            }
          }
        } else {
          const results = await dispatchAll(
            eligible,
            shouldBroadcast(cfg, call.severity),
            call,
            "initial",
            nowIso,
            {
              maxMessageChars: cfg.maxMessageChars,
              instance,
              operator: cfg.operator,
            },
            context,
          );
          call.deliveries = results;
          call.delivered = results.some((r) => r.ok);
          if (call.delivered) {
            beacon.deliveries.push(nowIso);
            beacon.totals.delivered += 1;
          } else {
            beacon.totals.failed += 1;
          }
        }

        beacon.calls = upsertEntry(
          beacon.calls,
          toIndexEntry(call),
          cfg.historyLimit,
        );
        beacon.updatedAt = nowIso;

        // Persist BEFORE any throw: a call that could not be delivered is
        // exactly the one that must survive in the record.
        const callHandle = await context.writeResource(
          "call",
          callId,
          call as unknown as Record<string, unknown>,
        );
        const beaconHandle = await context.writeResource(
          "beacon",
          BEACON_RESOURCE,
          beacon as unknown as Record<string, unknown>,
        );
        const handles = [callHandle, beaconHandle];

        // Publish the page under a stable name for workflow-step transports,
        // but only for a call that genuinely went out: a throttled or
        // channel-less call must not be picked up and sent by a step, or the
        // rate limit would be trivially escaped by going around it.
        if (!call.suppressedReason) {
          const html = buildMessage(call, {
            instance,
            format: "html",
            maxChars: cfg.maxMessageChars,
            kind: "initial",
            operator: cfg.operator,
          });
          handles.push(
            await context.writeResource("outbound", "outbound", {
              callId,
              createdAt: nowIso,
              severity: call.severity,
              category: call.category,
              summary: call.summary,
              title: call.page?.title ?? html.title,
              body: call.page?.body ?? html.body,
              text: call.page?.text ?? html.text,
              html: html.text,
            }),
          );
        }

        if (!call.delivered && !throttled && cfg.requireDelivery) {
          const why = eligible.length === 0
            ? `no channel is configured for severity "${call.severity}" ` +
              `(${cfg.channels.length} channel(s) defined)`
            : call.deliveries
              .map((d) => `${d.channel}: ${d.error ?? "unknown error"}`)
              .join("; ");
          throw new Error(
            `Distress call ${callId} reached nobody — ${why}. The call is ` +
              `recorded; fix the channel or page manually.`,
          );
        }

        context.logger?.info(
          "Distress {call} raised ({severity}/{category}), delivered={ok}",
          {
            call: callId,
            severity: call.severity,
            category: call.category,
            ok: call.delivered,
          },
        );
        return { dataHandles: handles };
      },
    },

    record: {
      description:
        "Record a delivery made OUTSIDE this model — by a workflow step " +
        "driving a transport that `runModel` cannot reach in-process. " +
        "Without it the call record would claim nobody was paged when " +
        "someone was, which is the same lie as the reverse.",
      arguments: z.object({
        channel: z
          .string()
          .min(1)
          .describe("Label for the transport that sent it, e.g. telegram"),
        callId: z
          .string()
          .optional()
          .describe("Which call; defaults to the most recent outbound page"),
        ok: z.boolean().default(true).describe("Did it actually deliver?"),
        proof: z
          .string()
          .optional()
          .describe("Evidence, e.g. the message id the transport returned"),
        error: z.string().optional().describe("Why it failed, when it did"),
      }),
      execute: async (
        args: {
          channel: string;
          callId?: string;
          ok: boolean;
          proof?: string;
          error?: string;
        },
        context: BaseCtx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const cfg = context.globalArgs;
        const nowIso = new Date().toISOString();
        const beacon = await loadBeacon(context, nowIso);

        let callId = args.callId;
        if (!callId) {
          const outbound = await context.readResource?.("outbound");
          callId = typeof outbound?.callId === "string"
            ? outbound.callId
            : undefined;
        }
        if (!callId) {
          throw new Error(
            "No callId given and no outbound page to infer one from.",
          );
        }
        const call = await loadCall(context, callId);
        if (!call) {
          throw new Error(`No distress call "${callId}" on this instance.`);
        }

        call.deliveries = [...call.deliveries, {
          channel: args.channel,
          definition: "external",
          method: "workflow-step",
          at: nowIso,
          ok: args.ok,
          kind: "initial",
          proof: args.proof,
          error: args.error ? redactSecrets(args.error) : undefined,
        }];
        if (args.ok && !call.delivered) {
          call.delivered = true;
          beacon.deliveries.push(nowIso);
          beacon.totals.delivered += 1;
          beacon.totals.failed = Math.max(0, beacon.totals.failed - 1);
        }
        call.updatedAt = nowIso;

        beacon.calls = upsertEntry(
          beacon.calls,
          toIndexEntry(call),
          cfg.historyLimit,
        );
        beacon.updatedAt = nowIso;

        const callHandle = await context.writeResource(
          "call",
          call.callId,
          call as unknown as Record<string, unknown>,
        );
        const beaconHandle = await context.writeResource(
          "beacon",
          BEACON_RESOURCE,
          beacon as unknown as Record<string, unknown>,
        );
        context.logger?.info("Recorded {channel} delivery for {call}: {ok}", {
          channel: args.channel,
          call: call.callId,
          ok: args.ok,
        });
        return { dataHandles: [callHandle, beaconHandle] };
      },
    },

    ack: {
      description:
        "Acknowledge a call — the human's answer back to the agent. The " +
        "note is readable by the agent through `list`, which is how a " +
        "one-way page becomes a conversation.",
      arguments: z.object({
        callId: z
          .string()
          .optional()
          .describe(
            "Which call. Omit when exactly one call is open — otherwise " +
              "the ambiguity is refused rather than guessed.",
          ),
        note: z
          .string()
          .optional()
          .describe("Answer or instruction for the agent"),
        by: z.string().optional().describe("Who acknowledged"),
      }),
      execute: async (
        args: { callId?: string; note?: string; by?: string },
        context: BaseCtx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const cfg = context.globalArgs;
        const nowIso = new Date().toISOString();
        const beacon = await loadBeacon(context, nowIso);

        const callId = args.callId ?? soleOpenCallId(beacon);
        const call = await loadCall(context, callId);
        if (!call) {
          throw new Error(
            `No distress call "${callId}" on this instance. Run \`list\` to ` +
              `see open calls.`,
          );
        }
        if (call.status === "resolved") {
          throw new Error(
            `Call ${callId} is already resolved — nothing to acknowledge.`,
          );
        }

        call.status = "acked";
        call.updatedAt = nowIso;
        call.acknowledgement = { at: nowIso, by: args.by, note: args.note };

        beacon.calls = upsertEntry(
          beacon.calls,
          toIndexEntry(call),
          cfg.historyLimit,
        );
        beacon.updatedAt = nowIso;

        const callHandle = await context.writeResource(
          "call",
          call.callId,
          call as unknown as Record<string, unknown>,
        );
        const beaconHandle = await context.writeResource(
          "beacon",
          BEACON_RESOURCE,
          beacon as unknown as Record<string, unknown>,
        );
        context.logger?.info("Acknowledged {call}", { call: call.callId });
        return { dataHandles: [callHandle, beaconHandle] };
      },
    },

    resolve: {
      description:
        "Close a call out. A resolved call stops deduping, so the same " +
        "problem recurring later opens a genuinely new call.",
      arguments: z.object({
        callId: z
          .string()
          .optional()
          .describe("Which call. Omit when exactly one call is open."),
        note: z.string().optional().describe("What the resolution was"),
        by: z.string().optional().describe("Who resolved it"),
      }),
      execute: async (
        args: { callId?: string; note?: string; by?: string },
        context: BaseCtx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const cfg = context.globalArgs;
        const nowIso = new Date().toISOString();
        const beacon = await loadBeacon(context, nowIso);

        const callId = args.callId ?? soleOpenCallId(beacon);
        const call = await loadCall(context, callId);
        if (!call) {
          throw new Error(
            `No distress call "${callId}" on this instance. Run \`list\` to ` +
              `see open calls.`,
          );
        }
        if (call.status === "resolved") {
          // Idempotent: re-resolving is a no-op, not an error, so a retried
          // cleanup step never turns a green run red.
          context.logger?.info("Call {call} already resolved", {
            call: callId,
          });
          const handle = await context.writeResource(
            "call",
            call.callId,
            call as unknown as Record<string, unknown>,
          );
          return { dataHandles: [handle] };
        }

        call.status = "resolved";
        call.updatedAt = nowIso;
        call.resolution = { at: nowIso, by: args.by, note: args.note };

        beacon.calls = upsertEntry(
          beacon.calls,
          toIndexEntry(call),
          cfg.historyLimit,
        );
        beacon.updatedAt = nowIso;

        const callHandle = await context.writeResource(
          "call",
          call.callId,
          call as unknown as Record<string, unknown>,
        );
        const beaconHandle = await context.writeResource(
          "beacon",
          BEACON_RESOURCE,
          beacon as unknown as Record<string, unknown>,
        );
        context.logger?.info("Resolved {call}", { call: call.callId });
        return { dataHandles: [callHandle, beaconHandle] };
      },
    },

    list: {
      description:
        "List calls, newest last. An agent calls this after paging to see " +
        "whether a human acknowledged and what they said.",
      arguments: z.object({
        status: z
          .enum(["open", "acked", "resolved", "unresolved", "all"])
          .default("unresolved")
          .describe("unresolved = open + acked"),
        limit: z.number().int().min(1).max(500).default(50),
      }),
      execute: async (
        args: { status: string; limit: number },
        context: BaseCtx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const nowIso = new Date().toISOString();
        const beacon = await loadBeacon(context, nowIso);
        const filtered = filterCalls(beacon.calls, args.status).slice(
          -args.limit,
        );
        const handle = await context.writeResource("listing", "recent", {
          generatedAt: nowIso,
          filter: args.status,
          count: filtered.length,
          calls: filtered,
        });
        context.logger?.info("{n} {status} call(s)", {
          n: filtered.length,
          status: args.status,
        });
        for (const c of filtered) {
          context.logger?.info(
            "  {id} [{severity}/{category}] {summary}{ack}",
            {
              id: c.callId,
              severity: c.severity,
              category: c.category,
              summary: c.summary,
              ack: c.ackNote ? ` — acked: ${c.ackNote}` : "",
            },
          );
        }
        return { dataHandles: [handle] };
      },
    },

    test: {
      description:
        "Prove every configured channel can actually page you. Sends a test " +
        "message through each enabled channel — ignoring minSeverity, since " +
        "the point is to test the transport — and records per-channel proof. " +
        "Fails when no channel could be proven, because a beacon that cannot " +
        "reach anyone must not look healthy.",
      arguments: z.object({
        note: z
          .string()
          .default("distress beacon channel test")
          .describe("Text to send"),
        allowFailure: z
          .boolean()
          .default(false)
          .describe("Report failures without failing the run"),
      }),
      execute: async (
        args: { note: string; allowFailure: boolean },
        context: BaseCtx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const cfg = context.globalArgs;
        const nowIso = new Date().toISOString();
        const instance = instanceName(context);
        const channels = cfg.channels.filter((c) => c.enabled !== false);
        if (channels.length === 0) {
          throw new Error(
            "No channels configured — set `channels` on this instance " +
              "before testing.",
          );
        }

        const probe: Call = {
          callId: makeCallId(nowIso, "channel-test", 0),
          createdAt: nowIso,
          updatedAt: nowIso,
          lastSeenAt: nowIso,
          status: "open",
          severity: "info",
          category: "other",
          summary: args.note,
          detail:
            "This is a channel test, not a real distress call. No action " +
            "is needed.",
          agent: { name: "distress:test" },
          dedupeKey: "channel-test",
          repeats: 0,
          repeatsSinceEscalation: 0,
          escalations: 0,
          delivered: false,
          deliveries: [],
        };

        const rows: Array<{
          channel: string;
          definition: string;
          method: string;
          ok: boolean;
          proof?: string;
          error?: string;
        }> = [];
        for (const channel of channels) {
          const msg = buildMessage(probe, {
            instance,
            format: channel.format,
            maxChars: channel.maxChars ?? cfg.maxMessageChars,
            kind: "test",
            operator: cfg.operator,
          });
          const res = await deliverVia(
            channel,
            buildChannelArgs(channel, messageFields(msg, probe)),
            "test",
            nowIso,
            context,
          );
          rows.push({
            channel: channel.name,
            definition: channel.definition,
            method: channel.method,
            ok: res.ok,
            proof: res.proof,
            error: res.error,
          });
          context.logger?.info("Channel {name}: {state}", {
            name: channel.name,
            state: res.ok ? `ok (${res.proof})` : `FAILED — ${res.error}`,
          });
        }

        const okCount = rows.filter((r) => r.ok).length;
        const handle = await context.writeResource("channelTest", "channels", {
          at: nowIso,
          channels: rows,
          okCount,
          failCount: rows.length - okCount,
        });

        if (okCount === 0 && !args.allowFailure) {
          throw new Error(
            `All ${rows.length} channel(s) failed — this beacon cannot ` +
              `currently page anyone: ` +
              rows.map((r) => `${r.channel}: ${r.error}`).join("; "),
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Filter index rows by the `list` status vocabulary.
 *
 * @param calls Index rows.
 * @param status One of open/acked/resolved/unresolved/all.
 * @returns Matching rows, in index order.
 */
export function filterCalls(
  calls: IndexEntry[],
  status: string,
): IndexEntry[] {
  if (status === "all") return [...calls];
  if (status === "unresolved") {
    return calls.filter((c) => c.status !== "resolved");
  }
  return calls.filter((c) => c.status === status);
}

/**
 * Resolve the implicit target of `ack`/`resolve` when no id was given.
 * Refuses to guess: with several calls open, silently answering the wrong one
 * would leave a real distress call looking handled.
 *
 * @param beacon Beacon state.
 * @returns The single unresolved call's id.
 */
export function soleOpenCallId(beacon: Beacon): string {
  const open = beacon.calls.filter((c) => c.status !== "resolved");
  if (open.length === 1) return open[0].callId;
  if (open.length === 0) {
    throw new Error("No unresolved distress calls on this instance.");
  }
  throw new Error(
    `${open.length} unresolved calls — pass callId explicitly. Open: ` +
      open.map((c) => c.callId).join(", "),
  );
}
