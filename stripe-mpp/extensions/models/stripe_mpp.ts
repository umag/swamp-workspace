/**
 * Stripe Machine Payments Protocol (MPP) — buyer and full seller sides of the
 * HTTP-402 "Payment" auth scheme (draft-ryan-httpauth-payment-01), fiat via
 * Shared Payment Tokens (SPTs).
 *
 * Reuse-first: the MPP wire protocol (challenge codec, credential envelope,
 * HMAC challenge-id binding, receipts) is delegated to `mppx` — the reference
 * library co-maintained with the specs — and the SPT lifecycle to the Stripe
 * public-preview SDK. This model adds the swamp-native layer:
 *
 *  - vault-backed secrets (`secretKey`, `serverSecret`)
 *  - an audit trail: a `payment` resource is written on EVERY pay outcome
 *    (success / failed / blocked), and a `refund` resource on every refund
 *    outcome
 *  - a spend guard: `pay` compares the challenge amount AND currency against
 *    the caller's ceiling BEFORE presenting the credential
 *  - `Idempotency-Key` on every money-moving Stripe POST
 *  - error redaction: secret keys and spt_ bearer ids never surface in errors
 *  - test-mode gates on test helpers
 *
 * Agent buyer:    probe, mintToken, pay, getIssuedToken, revokeToken
 * Consumer buyer: listConsumerPaymentMethods, createSpendRequest,
 *                 getSpendRequest, cancelSpendRequest, paySpendRequest
 *                 (a human WITHOUT a Stripe account grants a Shared Payment
 *                 Token from their Link wallet via `link-cli --mcp` over stdio;
 *                 spent BY REFERENCE — see lib/link_cli.ts)
 * Seller methods: createChallenge, verifyCredential, chargeToken,
 *                 issueReceipt, getCharge, listCharges, refundCharge,
 *                 getGrantedToken, createTestGrantedToken
 *
 * Caveats (see README): headless SPT minting requires an existing `pm_` and
 * an `active` mint result — `requires_action` (SCA) has no server-only
 * completion and fails loud. The Business Network Profile (`profile_...`)
 * is Dashboard-only. The consumer-buyer flow is US-only (Link), needs an
 * authenticated link-cli session co-located with the model, and is inert
 * (fail-closed) otherwise; the binding spend cap is the consumer-approved
 * grant, not paySpendRequest's advisory pre-flight.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { Challenge, Credential, Receipt } from "npm:mppx@0.8.12";
import { Mppx, stripe as stripeServer } from "npm:mppx@0.8.12/server";
import Stripe from "npm:stripe@22.4.0-beta.1";
import { callTool, type LinkCliConfig } from "./lib/link_cli.ts";

// ============================================================================
// Global arguments
// ============================================================================

/** SPT endpoints require this preview API version (docs.stripe.com). */
const PREVIEW_API_VERSION = "2026-04-22.preview";

const GlobalArgsSchema = z.object({
  secretKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Stripe secret key (sk_test_... / sk_live_...). Use a vault reference: " +
      "${{ vault.get(stripe-mpp, STRIPE_SECRET_KEY) }}",
  ),
  serverSecret: z.string().min(32).optional().meta({ sensitive: true })
    .describe(
      "Seller-side HMAC secret (>=32 chars) binding challenge ids " +
        "(draft-ryan-httpauth-payment-01). Required for createChallenge / " +
        "verifyCredential. Use a vault reference: " +
        "${{ vault.get(stripe-mpp, SERVER_SECRET) }}",
    ),
  networkId: z.string().optional().describe(
    "Stripe Business Network Profile id (profile_test_... / profile_...). " +
      "Dashboard-only to create. Default seller identity for challenges and " +
      "token minting.",
  ),
  realm: z.string().default("swamp-stripe-mpp").describe(
    "Protection-space identifier advertised in seller challenges (RFC 9110).",
  ),
  stripeVersion: z.string().default(PREVIEW_API_VERSION).describe(
    "Stripe-Version header. SPT endpoints need the preview channel.",
  ),
  testMode: z.boolean().default(true).describe(
    "Gates test helpers (createTestGrantedToken). Must match the key mode.",
  ),
  allowInsecure: z.boolean().default(false).describe(
    "Test-fixture escape: permit plain http:// to loopback, allow private/" +
      "loopback resource hosts, and skip DNS-resolution SSRF checks. " +
      "Cloud-metadata is refused regardless. Never enable in production.",
  ),
  timeoutMs: z.number().int().positive().default(30_000).describe(
    "Per-request timeout for resource fetches and Stripe calls.",
  ),
  paymentMethodTypes: z.array(z.string()).default(["card", "link"]).describe(
    "Payment method types advertised in seller challenges.",
  ),
  // ---- Consumer buyer (Link grant) — see lib/link_cli.ts. -----------------
  linkCliPath: z.string().optional().describe(
    "ABSOLUTE path to the installed @stripe/link-cli binary (a non-writable " +
      "install location is recommended). The consumer-grant methods fail " +
      "closed when this is unset or not absolute. The binary is spawned by " +
      "absolute path, so a PATH-shadowing binary cannot hijack which " +
      "executable runs. Requires an authenticated link-cli device session " +
      "(`link-cli auth login`, US Link account) on the same host.",
  ),
  linkCliVersion: z.string().default("0.9.0").describe(
    "Pinned link-cli version. The MCP initialize serverInfo.version is " +
      "checked against it as DRIFT DETECTION only (a shadow binary can spoof " +
      "it — this is not an integrity guarantee).",
  ),
  allowLiveGrants: z.boolean().default(false).describe(
    "Consumer-grant live-money opt-in. Default false forces link-cli test " +
      "mode. link-cli exposes NO session live/test signal, so this is " +
      "config-only — a documented regression vs the createTestGrantedToken " +
      "credential cross-check. Set true ONLY on a US Link account you intend " +
      "to move real money on.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ============================================================================
// Resource schemas
// ============================================================================

const ChallengeItemSchema = z.record(z.string(), z.unknown());

const ProbeSchema = z.object({
  url: z.string(),
  status: z.number(),
  challenges: z.array(ChallengeItemSchema),
  fetchedAt: z.string(),
}).passthrough();

const PaymentAttemptSchema = z.object({
  url: z.string(),
  outcome: z.enum(["success", "failed", "blocked", "no-payment-required"]),
  httpStatus: z.number().optional(),
  sptIdTruncated: z.string().optional(),
  challenge: z.object({
    id: z.string(),
    amount: z.string().optional(),
    currency: z.string().optional(),
  }).optional(),
  guard: z.object({ maxAmount: z.string(), currency: z.string() }).optional(),
  receipt: z.object({
    reference: z.string(),
    method: z.string(),
    timestamp: z.string(),
  }).optional(),
  error: z.string().optional(),
  externalId: z.string().optional(),
  fetchedAt: z.string(),
}).passthrough();

const IssuedTokenSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  livemode: z.boolean().optional(),
  usageLimits: z.record(z.string(), z.unknown()).optional(),
  fetchedAt: z.string(),
}).passthrough();

const ChallengeSpecSchema = z.object({
  wwwAuthenticate: z.string(),
  problemJson: z.record(z.string(), z.unknown()),
  amount: z.string(),
  currency: z.string(),
  expires: z.string().optional(),
  fetchedAt: z.string(),
}).passthrough();

const CredentialCheckSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
  challengeId: z.string().optional(),
  sptTruncated: z.string().optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
  fetchedAt: z.string(),
}).passthrough();

const ChargeSchema = z.object({
  piId: z.string(),
  status: z.string(),
  outcome: z.enum(["success", "failed"]),
  amount: z.number().optional(),
  currency: z.string().optional(),
  externalId: z.string().optional(),
  fetchedAt: z.string(),
}).passthrough();

const ReceiptOutSchema = z.object({
  chargeId: z.string(),
  header: z.string(),
  reference: z.string(),
  timestamp: z.string(),
  fetchedAt: z.string(),
}).passthrough();

const RefundSchema = z.object({
  chargeId: z.string(),
  outcome: z.enum(["success", "failed", "blocked"]),
  refundId: z.string().optional(),
  amount: z.string(),
  status: z.string().optional(),
  error: z.string().optional(),
  fetchedAt: z.string(),
}).passthrough();

const GrantedTokenSchema = z.object({
  id: z.string(),
  usageLimits: z.record(z.string(), z.unknown()).optional(),
  deactivatedAt: z.number().nullable().optional(),
  deactivatedReason: z.string().nullable().optional(),
  paymentMethod: z.record(z.string(), z.unknown()).optional(),
  fetchedAt: z.string(),
}).passthrough();

const SummarySchema = z.object({
  scope: z.string(),
  total: z.number(),
  ids: z.array(z.string()),
  truncated: z.boolean(),
  fetchedAt: z.string(),
}).passthrough();

// Consumer buyer (Link grant) resources. These use z.strictObject — DELIBERATELY
// breaking the .passthrough() house style — so a stray field (above all a raw
// spt_ bearer credential) fails the write STRUCTURALLY, not just via the
// adversarial /spt_/ regex test. Payloads are built field-by-field from named
// values, never spread from the link-cli response.
const SpendRequestSchema = z.strictObject({
  id: z.string(), // lsrq_
  status: z.string(), // created|pending_approval|approved|denied|expired|cancelled
  outcome: z.enum([
    "created",
    "retrieved",
    "approved",
    "denied",
    "expired",
    "cancelled",
    "blocked",
    "paid",
    "pay-failed",
  ]),
  amount: z.string().optional(), // minor units string (what we requested/pinned)
  currency: z.string().optional(),
  networkId: z.string().optional(), // resolved payee, for the audit trail
  paymentMethodId: z.string().optional(),
  intentKey: z.string().optional(), // deterministic correlation anchor (idemKey)
  error: z.string().optional(),
  fetchedAt: z.string(),
});

const ConsumerPaymentMethodSchema = z.strictObject({
  id: z.string(), // csmrpd_
  kind: z.string().optional(),
  display: z.string().optional(), // as link-cli returns it (assumed masked
  // upstream); redact() scrubs sk_/spt_ but does NOT mask PAN/holder text.
  fetchedAt: z.string(),
});

// ============================================================================
// Execution context
// ============================================================================

interface ExecCtx {
  globalArgs: Record<string, unknown>;
  writeResource: (
    specName: string,
    instanceName: string,
    payload: unknown,
  ) => Promise<unknown>;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Strip secret material from any outgoing message (errors, logs). */
export function redact(g: GlobalArgs, message: string): string {
  let out = message;
  if (g.secretKey) out = out.split(g.secretKey).join("sk_[redacted]");
  if (g.serverSecret) out = out.split(g.serverSecret).join("[redacted]");
  out = out.replace(/sk_(test|live)_[A-Za-z0-9]+/g, "sk_$1_[redacted]");
  out = out.replace(/spt_[A-Za-z0-9_]+/g, "spt_[redacted]");
  return out;
}

/** Truncate an spt bearer id for audit correlation without persisting it. */
export function truncateSpt(sptId: string): string {
  return sptId.length <= 8 ? "spt_…" : `${sptId.slice(0, 8)}…`;
}

/** Sanitize an arbitrary string into a stable, safe instance-name slug. */
export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 48);
  return out || "x";
}

/** Deterministic, collision-resistant Idempotency-Key derivation.
 *
 * SHA-256 (not a 32-bit hash — avoids birthday collisions) over the
 * length-prefixed parts so distinct inputs yield distinct keys. Positions are
 * length-prefixed rather than joined by a delimiter so `["a","bc"]` and
 * `["ab","c"]` can't collide, and `undefined` is distinct from `""`. The
 * caller MUST include a value that distinguishes separate logical operations
 * (externalId, or the unique HMAC-bound challenge id) — otherwise two genuine
 * operations with identical parameters intentionally share a key. */
export async function idemKey(
  op: string,
  parts: Array<string | undefined>,
): Promise<string> {
  const input = parts
    .map((p) => (p === undefined ? "∅" : `${p.length}:${p}`))
    .join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${op} ${input}`),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `swamp-mpp-${op}-${hex}`; // ~74 chars, within Stripe's 255 limit
}

/** True for a strictly-canonical minor-units amount: ASCII digits, no sign,
 * no leading zero (except "0"), no decimal/exponent/whitespace/unicode. This
 * fails closed on the whole money-parsing attack family (negative, `1e2`,
 * `010`, `10.00`, fullwidth/Arabic-Indic digits, overflow strings). */
export function isCanonicalMinorUnits(s: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(s);
}

/** Categorize a 32-bit IPv4 address for SSRF defense. */
function ipv4Category(
  ip: number,
): "loopback" | "metadata" | "private" | "public" {
  const oct = [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255];
  if (oct[0] === 127) return "loopback";
  if (oct[0] === 0) return "loopback"; // 0.0.0.0/8
  if (oct[0] === 169 && oct[1] === 254) return "metadata"; // 169.254.169.254
  if (oct[0] === 10) return "private";
  if (oct[0] === 172 && oct[1] >= 16 && oct[1] <= 31) return "private";
  if (oct[0] === 192 && oct[1] === 168) return "private";
  return "public";
}

/** Parse an IPv4 literal (dotted / bare-integer / hex) to a 32-bit int. */
function parseIpv4(h: string): number | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split(".").map(Number);
    if (parts.every((n) => n <= 255)) {
      return (
        ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
      );
    }
  } else if (/^0x[0-9a-f]+$/.test(h)) {
    return Number(h) >>> 0;
  } else if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isSafeInteger(n) && n <= 0xffffffff) return n >>> 0;
  }
  return undefined;
}

/** Classify a URL host for SSRF defense. Normalizes dotted-decimal, bare
 * integer, and hex IPv4 literals so `2130706433` / `0x7f000001` are seen as
 * loopback; decodes IPv6 loopback (`::1`, full-form) and IPv4-mapped
 * (`::ffff:a.b.c.d`) forms; flags metadata / private / link-local ranges. */
export function hostCategory(
  hostname: string,
): "loopback" | "metadata" | "private" | "public" {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";

  // IPv6. Detect it by the colon and classify defensively — decode any
  // embedded/mapped IPv4 first (::ffff:169.254.169.254 must NOT read public).
  if (h.includes(":")) {
    // Fully-expanded or compressed all-zero loopback: ::1 / 0:0:...:0:1.
    const groups = h.split("::");
    const isLoopback = h === "::1" ||
      /^(0+:)*0*:?0*1$/.test(h.replace(/\b0+/g, "0")) ||
      (groups.length === 2 && groups[0].replace(/[0:]/g, "") === "" &&
        groups[1] === "1");
    if (isLoopback) return "loopback";
    if (h === "::" || h === "::0") return "loopback"; // unspecified

    // IPv4-mapped/embedded, DOTTED form (defense-in-depth; most runtimes
    // re-serialize to hex before we see it).
    const embedded = h.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (embedded) {
      const ip = parseIpv4(embedded[1]);
      if (ip !== undefined) return ipv4Category(ip);
    }
    // IPv4-mapped/embedded, HEX form — what `new URL()` actually produces:
    // ::ffff:a9fe:a9fe (mapped) and 64:ff9b::a9fe:a9fe (NAT64). Without this,
    // ::ffff:169.254.169.254 canonicalizes to hex and evades the metadata
    // label (falling through to the weaker `private`).
    const mapped = h.match(
      /(?:^|:)(?:ffff|64:ff9b:):([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
    );
    if (mapped) {
      const ip = ((parseInt(mapped[1], 16) << 16) | parseInt(mapped[2], 16)) >>>
        0;
      return ipv4Category(ip);
    }
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^f[cd][0-9a-f]{2}$/.test(h)) {
      return "private"; // fc00::/7 unique-local
    }
    if (h.startsWith("fe80:") || h.startsWith("fe80::")) return "metadata"; // link-local
    // Any other IPv6 literal we can't positively classify as public → treat
    // as non-public (fail closed for a raw IPv6 resource host).
    return "private";
  }

  const ip = parseIpv4(h);
  if (ip === undefined) return "public";
  return ipv4Category(ip);
}

/** Enforce the resource-URL policy: https by default, no credential-smuggling
 * userinfo, and no SSRF into cloud-metadata / private / loopback ranges unless
 * explicitly allowed (localhost test fixtures via allowInsecure). */
export function assertUrlPolicy(g: GlobalArgs, rawUrl: string): URL {
  const url = new URL(rawUrl);

  // Userinfo (`user:pass@host`) is a parser-differential SSRF vector — the
  // validator may read one host while the client connects to another.
  if (url.username || url.password) {
    throw new Error(
      "Resource URL must not contain userinfo (user:pass@host) — refused.",
    );
  }

  const category = hostCategory(url.hostname);

  // Cloud metadata / link-local is never a legitimate payment resource.
  if (category === "metadata") {
    throw new Error(
      `Refusing to fetch a link-local / metadata address (${url.hostname}) — ` +
        "SSRF protection.",
    );
  }
  // Loopback / private ranges only with the explicit test escape.
  if ((category === "loopback" || category === "private") && !g.allowInsecure) {
    throw new Error(
      `Refusing to fetch a ${category} address (${url.hostname}) without ` +
        "allowInsecure=true — SSRF protection.",
    );
  }

  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && g.allowInsecure && category === "loopback") {
    return url;
  }
  throw new Error(
    `Resource URL must be https (got ${url.protocol}//${url.hostname}). ` +
      "Plain http is allowed only for loopback with allowInsecure=true.",
  );
}

function parseGlobals(context: ExecCtx): GlobalArgs {
  return GlobalArgsSchema.parse(context.globalArgs);
}

function sdk(g: GlobalArgs): Stripe {
  return new Stripe(g.secretKey, {
    // Preview version string is not in the SDK's literal union yet.
    apiVersion: g.stripeVersion as NonNullable<
      ConstructorParameters<typeof Stripe>[1]
    >["apiVersion"],
    // Route through fetch: keeps the swamp bundle off node:http and lets
    // tests intercept via a fetch stub.
    httpClient: Stripe.createFetchHttpClient(),
    timeout: g.timeoutMs,
    maxNetworkRetries: 0,
  });
}

/** Run a Stripe/library call, rethrowing with secrets redacted. */
async function redacting<T>(g: GlobalArgs, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(
      redact(g, err instanceof Error ? err.message : String(err)),
    );
  }
}

async function fetchWithTimeout(
  g: GlobalArgs,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), g.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

type ChallengeT = ReturnType<typeof Challenge.deserialize>;

/** Extract the stripe/charge challenge and its request payload, if any. */
function pickStripeChallenge(challenges: ChallengeT[]) {
  const ch = challenges.find((c) =>
    c.method === "stripe" && c.intent === "charge"
  );
  if (!ch) return undefined;
  const req = ch.request as Record<string, unknown>;
  const details = req.methodDetails as Record<string, unknown> | undefined;
  return {
    challenge: ch,
    amount: typeof req.amount === "string" ? req.amount : undefined,
    currency: typeof req.currency === "string" ? req.currency : undefined,
    // The payee: which Stripe Business Network Profile this challenge would
    // pay. A MITM that injects a challenge naming its OWN profile is a
    // recipient-swap attack — pinning expectedNetworkId defeats it.
    networkId: typeof details?.networkId === "string"
      ? details.networkId
      : undefined,
    realm: ch.realm,
  };
}

/** Read the route scope bound into a challenge (methodDetails.metadata.scope),
 * if any. HMAC-protected because it lives inside the `request` slot. */
function challengeScope(ch: ChallengeT): string | undefined {
  const req = ch.request as Record<string, unknown>;
  const details = req.methodDetails as Record<string, unknown> | undefined;
  const meta = details?.metadata as Record<string, unknown> | undefined;
  return typeof meta?.scope === "string" ? meta.scope : undefined;
}

/** Compare minor-unit amount strings without float corruption. */
export function amountExceeds(amount: string, maxAmount: string): boolean {
  try {
    return BigInt(amount) > BigInt(maxAmount);
  } catch {
    return true; // unparseable amounts never pass the guard
  }
}

/** A spend-guard violation, with the short form for the audit record and the
 * long form for the thrown error. */
export interface GuardViolation {
  recordError: string;
  throwError: string;
}

/** Evaluate a picked stripe/charge challenge against a spend guard
 * (payee, realm, currency, canonical amount, ceiling). Returns the first
 * violation or null. SHARED by `pay` (binding, atomic — the credential is
 * bound to this same challenge) and `paySpendRequest` (advisory pre-flight —
 * mpp_pay re-fetches and spends against its OWN challenge, so this is
 * defense-in-depth, NOT a binding cap). */
export function challengeGuardViolation(
  picked: {
    amount?: string;
    currency?: string;
    networkId?: string;
    realm?: string;
  },
  gp: {
    expectedNetworkId?: string;
    expectedRealm?: string;
    currency: string;
    maxAmount: string;
  },
): GuardViolation | null {
  const { amount, currency, networkId, realm } = picked;
  if (
    gp.expectedNetworkId !== undefined && networkId !== gp.expectedNetworkId
  ) {
    return {
      recordError: `challenge payee ${networkId} != expected ` +
        `${gp.expectedNetworkId}`,
      throwError:
        `Challenge payee (networkId ${networkId}) does not match the ` +
        `expected payee (${gp.expectedNetworkId}) — possible ` +
        "recipient-swap attack; payment blocked.",
    };
  }
  if (gp.expectedRealm !== undefined && realm !== gp.expectedRealm) {
    return {
      recordError: `challenge realm ${realm} != expected ${gp.expectedRealm}`,
      throwError: `Challenge realm (${realm}) does not match the expected ` +
        `realm (${gp.expectedRealm}) — payment blocked.`,
    };
  }
  if (!currency || currency.toLowerCase() !== gp.currency.toLowerCase()) {
    return {
      recordError: `challenge currency ${currency} != expected ${gp.currency}`,
      throwError: `Challenge currency (${currency}) does not match the ` +
        `expected currency (${gp.currency}) — payment blocked.`,
    };
  }
  if (!amount || !isCanonicalMinorUnits(amount)) {
    return {
      recordError: `challenge amount ${amount} is not canonical minor units`,
      throwError: `Challenge amount (${amount}) is not a canonical ` +
        "minor-units integer — payment blocked (defends against " +
        "amount-parsing confusion).",
    };
  }
  if (amountExceeds(amount, gp.maxAmount)) {
    return {
      recordError: `challenge amount ${amount} exceeds maxAmount ` +
        `${gp.maxAmount}`,
      throwError: `Challenge amount (${amount} ${currency}) exceeds the ` +
        `maxAmount guard (${gp.maxAmount}) — payment blocked.`,
    };
  }
  return null;
}

const now = () => new Date().toISOString();

// ---- Consumer buyer (Link grant) helpers ----------------------------------

/** Anchored id patterns — refuse anything that isn't a well-formed id before it
 * reaches link-cli (defence-in-depth alongside the leading-dash guard). */
const LSRQ = /^lsrq_[A-Za-z0-9]+$/;
const CSMRPD = /^csmrpd_[A-Za-z0-9]+$/;
const PROFILE = /^profile_(test_)?[A-Za-z0-9]+$/;

/** Card-network minimum per currency, minor units (docs-sourced — NOT a
 * link-cli input constraint; enforced here so a sub-minimum grant is refused
 * before a consumer is ever prompted). */
const MIN_CHARGE: Record<string, bigint> = { usd: 50n };

/** Build the link-cli MCP config from globals, failing CLOSED when the binary
 * path is unset or not absolute (a PATH-shadowing binary must not be able to
 * hijack which executable runs). */
function linkCliConfig(g: GlobalArgs): LinkCliConfig {
  const p = g.linkCliPath;
  if (!p || !p.startsWith("/")) {
    throw new Error(
      "Consumer-grant methods require an ABSOLUTE linkCliPath to an " +
        "installed @stripe/link-cli (fail-closed). Install it to a " +
        "non-writable location and set the linkCliPath global. These methods " +
        "also need an authenticated link-cli session (`link-cli auth login`, " +
        "US Link account) on this host; they are inert otherwise.",
    );
  }
  // Defense-in-depth cross-check: link-cli exposes no session live/test signal,
  // so allowLiveGrants is config-only. Refuse the contradictory combination
  // where the instance is nominally test (testMode) yet opts into live grants —
  // it would move real money on what reads as a test instance.
  if (g.testMode && g.allowLiveGrants) {
    throw new Error(
      "Contradictory config: testMode=true with allowLiveGrants=true would " +
        "create LIVE consumer grants on a test-labelled instance. Set " +
        "allowLiveGrants=false (test grants) or testMode=false (live instance).",
    );
  }
  return {
    binPath: p,
    version: g.linkCliVersion,
    // Live grants only when explicitly opted in; default is test mode.
    test: !g.allowLiveGrants,
    timeoutMs: g.timeoutMs,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
/** link-cli returns amount as an integer (minor units); persist as a string. */
function toAmountStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return undefined;
}

/** Reject a Link-origin id (lsrq_/csmrpd_) on the agent-token methods with an
 * actionable message: these are not platform-issued tokens, so
 * issuedTokens.retrieve/revoke (which use the platform secretKey) would 404/403.
 * A Link grant is spent by reference via paySpendRequest. */
function assertNotLinkOriginId(g: GlobalArgs, id: string): void {
  if (LSRQ.test(id) || CSMRPD.test(id)) {
    throw new Error(
      redact(
        g,
        `"${id}" is a Link-origin id (spend request / consumer payment ` +
          "method), not a platform-issued Shared Payment Token. Link grants " +
          "are spent by reference via paySpendRequest and cannot be retrieved " +
          "or revoked through the platform secret key.",
      ),
    );
  }
}

// ============================================================================
// Method argument schemas
// ============================================================================

const HttpArgs = {
  url: z.string().describe("Resource URL (https; http only for localhost)."),
  httpMethod: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET")
    .describe("HTTP method used against the resource."),
  body: z.string().optional().describe("Request body forwarded verbatim."),
  contentType: z.string().default("application/json").describe(
    "Content-Type when a body is sent.",
  ),
};

const ProbeArgs = z.object({ ...HttpArgs });

const MintTokenArgs = z.object({
  paymentMethodId: z.string().describe(
    "Existing payment method (pm_...). Raw-PAN creation is PCI-gated in " +
      "live mode; use a saved/test payment method.",
  ),
  maxAmount: z.string().describe("Usage-limit ceiling, minor units string."),
  currency: z.string().describe("Usage-limit currency (ISO, lowercase)."),
  expiresAt: z.number().int().optional().describe(
    "Unix timestamp for usage_limits.expires_at.",
  ),
  sellerNetworkId: z.string().optional().describe(
    "Seller network profile the token is granted to (defaults to networkId).",
  ),
  externalId: z.string().optional().describe(
    "Correlation id; also drives the Idempotency-Key.",
  ),
});

const PayArgs = z.object({
  ...HttpArgs,
  sptId: z.string().describe("Shared Payment Token (spt_...) to present."),
  maxAmount: z.string().describe(
    "Spend ceiling, minor units string. The challenge amount must not " +
      "exceed this.",
  ),
  currency: z.string().describe(
    "Expected challenge currency. Mismatch blocks the payment.",
  ),
  expectedNetworkId: z.string().optional().describe(
    "Pin the payee: the Stripe Business Network Profile (profile_...) the " +
      "challenge must name. Defends against a MITM/malicious 402 injecting a " +
      "challenge that pays the ATTACKER's profile. Recommended for any " +
      "payment to a known counterparty.",
  ),
  expectedRealm: z.string().optional().describe(
    "Pin the challenge realm (issuing authority); mismatch blocks the payment.",
  ),
  externalId: z.string().optional().describe("Correlation id."),
});

const SptIdArgs = z.object({
  sptId: z.string().describe("Shared Payment Token id (spt_...)."),
});

// ---- Consumer buyer (Link grant) argument schemas -------------------------

const ListConsumerPaymentMethodsArgs = z.object({});

const CreateSpendRequestArgs = z.object({
  amount: z.string().describe(
    'Amount to authorise, minor-units STRING (e.g. "500" = $5.00). ' +
      "Converted to an integer only at the JSON-RPC boundary. <=500000; must " +
      "meet the card-network minimum ($0.50 USD).",
  ),
  currency: z.string().default("usd").describe(
    "Currency (ISO, lowercase). US-only Link; default usd.",
  ),
  context: z.string().min(100).describe(
    "Purchase description + rationale the consumer READS when approving. " +
      "link-cli requires >= 100 characters.",
  ),
  networkId: z.string().optional().describe(
    "Payee Business Network Profile (profile_...). Defaults to the global " +
      "networkId; a per-call value must still be an anchored profile id.",
  ),
  paymentMethodId: z.string().optional().describe(
    "Consumer Link payment method (csmrpd_...). Omit to let the consumer pick " +
      "in the Link app.",
  ),
  externalId: z.string().optional().describe(
    "Correlation id; also anchors the deterministic intent key persisted on " +
      "the audit record. NOTE: link-cli has no idempotency key and this model " +
      "does no coalescing, so a duplicate identical createSpendRequest call " +
      "produces a duplicate consumer approval prompt.",
  ),
});

const SpendRequestIdArgs = z.object({
  id: z.string().describe("Spend request id (lsrq_...)."),
});

const PaySpendRequestArgs = z.object({
  ...HttpArgs,
  id: z.string().describe("Approved spend request id (lsrq_...) to spend."),
  maxAmount: z.string().describe(
    "ADVISORY pre-flight ceiling (minor units). NOTE: the binding cap is the " +
      "amount the consumer approved at grant time (Stripe-enforced) — mpp_pay " +
      "re-fetches and spends against its own challenge, so this pre-flight " +
      "cannot bind what link-cli actually pays.",
  ),
  currency: z.string().describe("Expected challenge currency (advisory)."),
  expectedNetworkId: z.string().optional().describe(
    "Advisory payee pin for the pre-flight challenge.",
  ),
  expectedRealm: z.string().optional().describe("Advisory realm pin."),
  externalId: z.string().optional().describe("Correlation id."),
});

const CreateChallengeArgs = z.object({
  amount: z.string().describe("Amount demanded, minor units string."),
  currency: z.string().describe("Currency (ISO, lowercase)."),
  description: z.string().optional(),
  externalId: z.string().optional(),
  expiresInSeconds: z.number().int().positive().optional().describe(
    "Challenge validity window; recommended to keep challenges short-lived.",
  ),
  networkId: z.string().optional().describe("Override the global networkId."),
  scope: z.string().optional().describe(
    "Bind the challenge to a specific resource/route. Carried inside the " +
      "HMAC-bound request (request.methodDetails.metadata.scope), so it is " +
      "tamper-evident. Pin it with expectedScope on verifyCredential/" +
      "chargeToken to stop a paid credential being replayed to a DIFFERENT " +
      "route of the same server.",
  ),
});

const VerifyCredentialArgs = z.object({
  authorizationHeader: z.string().describe(
    'The received Authorization value ("Payment <base64url>").',
  ),
  expectedAmount: z.string().optional(),
  expectedCurrency: z.string().optional(),
  expectedScope: z.string().optional().describe(
    "Require the credential's challenge `opaque` to equal this route scope " +
      "(anti cross-route replay). Mismatch → valid=false.",
  ),
});

const ChargeTokenArgs = z.object({
  sptId: z.string().optional().describe(
    "Granted token to settle (or pass authorizationHeader).",
  ),
  amount: z.string().optional().describe("Minor units string."),
  currency: z.string().optional(),
  authorizationHeader: z.string().optional().describe(
    "Full received credential; verified (HMAC + expiry) before settling.",
  ),
  expectedScope: z.string().optional().describe(
    "When settling from an authorizationHeader, require the challenge " +
      "`opaque` to equal this route scope (anti cross-route replay).",
  ),
  description: z.string().optional(),
  externalId: z.string().optional(),
});

const ChargeIdArgs = z.object({
  chargeId: z.string().describe("PaymentIntent id (pi_...)."),
});

const IssueReceiptArgs = z.object({
  chargeId: z.string().describe("Settled PaymentIntent id (pi_...)."),
  externalId: z.string().optional(),
});

const ListChargesArgs = z.object({
  externalId: z.string().regex(/^[A-Za-z0-9._-]+$/).optional().describe(
    "Filter by metadata externalId (uses /v1/payment_intents/search).",
  ),
  createdGte: z.number().int().optional().describe("Unix lower bound."),
  createdLte: z.number().int().optional().describe("Unix upper bound."),
  maxResults: z.number().int().positive().max(1000).default(100),
  pageSize: z.number().int().min(1).max(100).default(100),
});

const RefundChargeArgs = z.object({
  chargeId: z.string().describe("PaymentIntent id (pi_...) to refund."),
  amount: z.string().describe(
    "Refund amount, minor units string. Must not exceed the remaining " +
      "refundable amount (verified against live state first).",
  ),
  reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"])
    .optional(),
  externalId: z.string().optional(),
});

const TestGrantedTokenArgs = z.object({
  maxAmount: z.string().describe("Usage-limit ceiling, minor units string."),
  currency: z.string().describe("Usage-limit currency."),
  paymentMethodId: z.string().default("pm_card_visa").describe(
    "Payment method the fabricated granted token draws on (required by the " +
      "test helper). Defaults to Stripe's pm_card_visa test token.",
  ),
  expiresAt: z.number().int().optional(),
});

// ============================================================================
// Shared method bodies
// ============================================================================

/** True if the (bracket-stripped) host is an IP literal, not a DNS name. */
function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h.includes(":") || parseIpv4(h) !== undefined;
}

/** Resolve a DNS host and block if any resolved address is internal — defends
 * static-DNS SSRF (e.g. evil.com -> 169.254.169.254) that lexical
 * classification alone misses. Skipped under allowInsecure (test escape) and
 * for IP literals (already classified). Fails OPEN on resolution error so a
 * genuinely-unresolvable host still returns a normal connect failure rather
 * than a misleading SSRF error; the rebinding TOCTOU between resolve and
 * connect is a documented residual (see README). */
async function assertResolvedHostPublic(
  g: GlobalArgs,
  url: URL,
): Promise<void> {
  if (g.allowInsecure) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) return;
  const results = await Promise.allSettled([
    Deno.resolveDns(host, "A"),
    Deno.resolveDns(host, "AAAA"),
  ]);
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const addr of r.value) {
      const cat = hostCategory(addr);
      if (cat !== "public") {
        throw new Error(
          `Resource host ${host} resolves to a ${cat} address (${addr}) — ` +
            "SSRF protection.",
        );
      }
    }
  }
}

async function fetchResource(
  g: GlobalArgs,
  args: { url: string; httpMethod: string; body?: string; contentType: string },
  authorization?: string,
): Promise<Response> {
  const url = assertUrlPolicy(g, args.url);
  await assertResolvedHostPublic(g, url);
  const headers: Record<string, string> = {};
  if (args.body !== undefined) headers["Content-Type"] = args.contentType;
  if (authorization) headers["Authorization"] = authorization;
  return await fetchWithTimeout(g, args.url, {
    method: args.httpMethod,
    body: args.body,
    headers,
  });
}

async function retrievePaymentIntent(
  g: GlobalArgs,
  client: Stripe,
  chargeId: string,
  expandLatestCharge = false,
) {
  return await redacting(g, () =>
    client.paymentIntents.retrieve(
      chargeId,
      expandLatestCharge ? { expand: ["latest_charge"] } : {},
    ));
}

// ============================================================================
// Model
// ============================================================================

/** Stripe MPP model: agent buyer (probe/mint/pay) + consumer buyer (Link
 * grant, spend by reference) + full seller API. */
export const model = {
  type: "@magistr/stripe-mpp",
  version: "2026.07.21.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    challenge: {
      description: "Probe result: HTTP status + parsed payment challenges.",
      schema: ProbeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    payment: {
      description:
        "Buyer payment attempt — written on EVERY pay outcome (audit trail).",
      schema: PaymentAttemptSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    issuedToken: {
      description: "Issued Shared Payment Token (buyer view).",
      schema: IssuedTokenSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    challengeSpec: {
      description:
        "Seller challenge material: WWW-Authenticate value + problem+json body.",
      schema: ChallengeSpecSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    credential: {
      description: "Seller-side credential verification verdict.",
      schema: CredentialCheckSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    charge: {
      description: "Seller charge (PaymentIntent) state.",
      schema: ChargeSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    receipt: {
      description: "Issued Payment-Receipt header value for a settled charge.",
      schema: ReceiptOutSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    refund: {
      description:
        "Refund outcome — written on every refundCharge attempt (audit trail).",
      schema: RefundSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    grantedToken: {
      description:
        "Granted Shared Payment Token (seller view; card details trimmed).",
      schema: GrantedTokenSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    summary: {
      description: "Fan-out listing summary.",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spendRequest: {
      description:
        "Consumer Link spend-request lifecycle — written on EVERY outcome " +
        "(outcome ∈ created/retrieved/cancelled/blocked/paid/pay-failed; the " +
        "approval status approved|denied|expired is carried in the `status` " +
        "field of a retrieved record). " +
        "Holds the lsrq_ reference only; NEVER a raw spt_ credential.",
      schema: SpendRequestSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    consumerPaymentMethod: {
      description:
        "Consumer Link payment method (csmrpd_; display as link-cli returns " +
        "it, assumed masked upstream — not additionally masked here).",
      schema: ConsumerPaymentMethodSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    // ------------------------------------------------------------------ buyer
    probe: {
      description:
        "Request a resource WITHOUT paying and record the parsed payment " +
        "challenges from a 402 (WWW-Authenticate: Payment). Non-402 " +
        "responses are recorded with an empty challenge list.",
      arguments: ProbeArgs,
      execute: async (args: z.infer<typeof ProbeArgs>, context: ExecCtx) => {
        const g = parseGlobals(context);
        const res = await redacting(g, () => fetchResource(g, args));
        let challenges: ChallengeT[] = [];
        if (res.status === 402) {
          challenges = await redacting(
            g,
            () => Promise.resolve(Challenge.fromResponseList(res)),
          );
        }
        await res.body?.cancel().catch(() => {});
        const handle = await context.writeResource(
          "challenge",
          `probe-${slug(args.url)}`,
          {
            url: args.url,
            status: res.status,
            challenges: challenges as unknown as Array<
              Record<string, unknown>
            >,
            fetchedAt: now(),
          },
        );
        context.logger?.info("Probed {url}: {status}, {n} challenge(s)", {
          url: args.url,
          status: res.status,
          n: challenges.length,
        });
        return { dataHandles: [handle] };
      },
    },

    mintToken: {
      description:
        "Mint a fiat Shared Payment Token from an existing payment method " +
        "(POST /v1/shared_payment/issued_tokens, preview API). Headless " +
        "minting only succeeds when the token returns status=active — " +
        "requires_action (SCA) has no server-only completion and fails loud.",
      arguments: MintTokenArgs,
      sensitiveOutput: true,
      execute: async (
        args: z.infer<typeof MintTokenArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        if (!isCanonicalMinorUnits(args.maxAmount)) {
          throw new Error(
            `mintToken maxAmount (${args.maxAmount}) must be a canonical ` +
              "minor-units integer — refusing to mint an uncapped token.",
          );
        }
        const network = args.sellerNetworkId ?? g.networkId;
        if (!network) {
          throw new Error(
            "mintToken requires a seller network profile (profile_...) — " +
              "set the sellerNetworkId argument or the global networkId.",
          );
        }
        const client = sdk(g);
        // Typed params: seller_details is REQUIRED by the SDK, so letting the
        // compiler check it (no unknown-cast) guards against dropping it.
        const params: Stripe.SharedPayment.IssuedTokenCreateParams = {
          payment_method: args.paymentMethodId,
          usage_limits: {
            currency: args.currency,
            max_amount: Number(args.maxAmount),
            // One-time tokens require expires_at; default to +1h.
            expires_at: args.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
          },
          seller_details: { network_business_profile: network },
          ...(args.externalId
            ? { shared_metadata: { externalId: args.externalId } }
            : {}),
        };
        const mintKey = await idemKey("mint", [
          args.externalId,
          args.paymentMethodId,
          args.maxAmount,
          args.currency,
        ]);
        const token = await redacting(
          g,
          () =>
            client.sharedPayment.issuedTokens.create(params, {
              idempotencyKey: mintKey,
            }),
        ) as unknown as Record<string, unknown>;
        const handle = await context.writeResource(
          "issuedToken",
          `token-${slug(String(token.id))}`,
          {
            id: token.id,
            status: token.status,
            livemode: token.livemode,
            usageLimits: token.usage_limits,
            fetchedAt: now(),
          },
        );
        if (token.status !== "active") {
          throw new Error(
            `Minted token is status=${token.status} (expected active). ` +
              "requires_action means the payment method needs an " +
              "interactive step (e.g. SCA via next_action.use_stripe_sdk) " +
              "that cannot be completed headlessly — use a payment method " +
              "that does not require authentication, or complete the " +
              "action in a Stripe SDK context.",
          );
        }
        return { dataHandles: [handle] };
      },
    },

    pay: {
      description:
        "Pay for a resource end-to-end: request it, parse the 402 stripe " +
        "challenge, enforce the maxAmount+currency spend guard, retry with " +
        "the SPT credential, and decode the Payment-Receipt. A `payment` " +
        "resource is persisted on EVERY outcome (success/failed/blocked).",
      arguments: PayArgs,
      execute: async (args: z.infer<typeof PayArgs>, context: ExecCtx) => {
        const g = parseGlobals(context);
        // Disambiguate per attempt so repeated payments to the same metered
        // URL don't overwrite each other's audit record (externalId when
        // given, else a per-call timestamped suffix).
        const attemptName = `payment-${
          slug(args.externalId ?? `${args.url}-${now()}`)
        }`;
        const base = {
          url: args.url,
          sptIdTruncated: truncateSpt(args.sptId),
          guard: { maxAmount: args.maxAmount, currency: args.currency },
          externalId: args.externalId,
        };
        const record = (extra: Record<string, unknown>) =>
          context.writeResource("payment", attemptName, {
            ...base,
            ...extra,
            fetchedAt: now(),
          });

        const first = await redacting(g, () => fetchResource(g, args));
        if (first.status !== 402) {
          await first.body?.cancel().catch(() => {});
          const handle = await record({
            outcome: "no-payment-required",
            httpStatus: first.status,
          });
          return { dataHandles: [handle] };
        }

        const picked = pickStripeChallenge(Challenge.fromResponseList(first));
        await first.body?.cancel().catch(() => {});
        if (!picked) {
          await record({ outcome: "blocked", error: "no stripe challenge" });
          throw new Error(
            "402 response advertises no stripe/charge challenge this model " +
              "can satisfy.",
          );
        }
        const { challenge, amount, currency, networkId, realm } = picked;
        const challengeInfo = { id: challenge.id, amount, currency };

        // Recipient + spend guard — pin payee/realm/currency/amount BEFORE the
        // credential ever leaves this process. A MITM or hostile resource can
        // inject a well-formed stripe/charge challenge that names the attacker's
        // profile; without pinning, the amount/currency could look right while
        // the money goes elsewhere. `pay` is atomic: the credential below is
        // bound to this SAME challenge, so the guard is binding.
        const violation = challengeGuardViolation(
          { amount, currency, networkId, realm },
          {
            expectedNetworkId: args.expectedNetworkId,
            expectedRealm: args.expectedRealm,
            currency: args.currency,
            maxAmount: args.maxAmount,
          },
        );
        if (violation) {
          await record({
            outcome: "blocked",
            challenge: challengeInfo,
            error: violation.recordError,
          });
          throw new Error(violation.throwError);
        }

        const authorization = Credential.serialize(Credential.from({
          challenge,
          payload: {
            spt: args.sptId,
            ...(args.externalId ? { externalId: args.externalId } : {}),
          },
        }));
        const retry = await redacting(
          g,
          () => fetchResource(g, args, authorization),
        );

        if (!retry.ok) {
          const bodyText = await retry.text().catch(() => "");
          await record({
            outcome: "failed",
            httpStatus: retry.status,
            challenge: challengeInfo,
            error: redact(g, bodyText.slice(0, 300)),
          });
          throw new Error(
            redact(
              g,
              `Payment retry failed: ${retry.status} ${retry.statusText}` +
                (bodyText ? ` — ${bodyText.slice(0, 300)}` : ""),
            ),
          );
        }

        let receipt:
          | { reference: string; method: string; timestamp: string }
          | undefined;
        try {
          const r = Receipt.fromResponse(retry);
          receipt = {
            reference: r.reference,
            method: r.method,
            timestamp: r.timestamp,
          };
        } catch {
          // Receipt header absent — allowed; the 2xx is the delivery proof.
        }
        await retry.body?.cancel().catch(() => {});
        const handle = await record({
          outcome: "success",
          httpStatus: retry.status,
          challenge: challengeInfo,
          ...(receipt ? { receipt } : {}),
        });
        context.logger?.info("Paid {url}: {status}", {
          url: args.url,
          status: retry.status,
        });
        return { dataHandles: [handle] };
      },
    },

    getIssuedToken: {
      description: "Retrieve an issued Shared Payment Token " +
        "(GET /v1/shared_payment/issued_tokens/{spt}).",
      arguments: SptIdArgs,
      sensitiveOutput: true,
      execute: async (args: z.infer<typeof SptIdArgs>, context: ExecCtx) => {
        const g = parseGlobals(context);
        assertNotLinkOriginId(g, args.sptId);
        const client = sdk(g);
        const token = await redacting(
          g,
          () => client.sharedPayment.issuedTokens.retrieve(args.sptId),
        ) as unknown as Record<string, unknown>;
        const handle = await context.writeResource(
          "issuedToken",
          `token-${slug(args.sptId)}`,
          {
            id: token.id,
            status: token.status,
            livemode: token.livemode,
            usageLimits: token.usage_limits,
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    revokeToken: {
      description: "Revoke an issued Shared Payment Token " +
        "(POST /v1/shared_payment/issued_tokens/{spt}/revoke).",
      arguments: SptIdArgs,
      execute: async (args: z.infer<typeof SptIdArgs>, context: ExecCtx) => {
        const g = parseGlobals(context);
        assertNotLinkOriginId(g, args.sptId);
        const client = sdk(g);
        const token = await redacting(
          g,
          () => client.sharedPayment.issuedTokens.revoke(args.sptId),
        ) as unknown as Record<string, unknown>;
        const handle = await context.writeResource(
          "issuedToken",
          `token-${slug(args.sptId)}`,
          {
            id: token.id ?? args.sptId,
            status: token.status ?? "revoked",
            livemode: token.livemode,
            usageLimits: token.usage_limits,
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // ----------------------------------------------------------------- seller
    createChallenge: {
      description:
        "Produce seller challenge material for a payment-gated resource: " +
        "the WWW-Authenticate value (HMAC-bound id per the spec) and the " +
        "application/problem+json 402 body. Requires serverSecret and a " +
        "networkId.",
      arguments: CreateChallengeArgs,
      execute: async (
        args: z.infer<typeof CreateChallengeArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        if (!g.serverSecret) {
          throw new Error(
            "createChallenge requires the serverSecret global argument " +
              "(>=32 chars, vault-stored).",
          );
        }
        if (!isCanonicalMinorUnits(args.amount)) {
          throw new Error(
            `createChallenge amount (${args.amount}) must be a canonical ` +
              "minor-units integer.",
          );
        }
        const networkId = args.networkId ?? g.networkId;
        if (!networkId) {
          throw new Error(
            "createChallenge requires a networkId (profile_...) — set the " +
              "global argument or pass it explicitly.",
          );
        }
        const server = Mppx.create({
          methods: [
            stripeServer.charge({
              secretKey: g.secretKey,
              networkId,
              paymentMethodTypes: g.paymentMethodTypes,
            }),
          ],
          realm: g.realm,
          secretKey: g.serverSecret,
        });
        const expires = args.expiresInSeconds
          ? new Date(Date.now() + args.expiresInSeconds * 1000).toISOString()
          : undefined;
        const handler = Mppx.compose(
          server.stripe.charge({
            // Our model API is uniformly minor units; mppx multiplies its
            // `amount` option by 10^decimals to build the wire amount, so
            // decimals=0 passes our minor-unit string through verbatim.
            amount: args.amount,
            currency: args.currency,
            decimals: 0,
            ...(args.description ? { description: args.description } : {}),
            ...(args.externalId ? { externalId: args.externalId } : {}),
            ...(expires ? { expires } : {}),
            // Route scope carried inside the HMAC-bound `request` (as
            // methodDetails.metadata.scope) so tampering breaks verification.
            ...(args.scope ? { metadata: { scope: args.scope } } : {}),
          }),
        );
        const response = await redacting(
          g,
          () => handler(new Request(`https://${g.realm}/`, { method: "GET" })),
        );
        if (response.status !== 402) {
          throw new Error(
            `Expected a 402 challenge from the mppx server, got ${response.status}.`,
          );
        }
        const challengeResponse = response.challenge as Response;
        const wwwAuthenticate = challengeResponse.headers.get(
          "WWW-Authenticate",
        );
        if (!wwwAuthenticate) {
          throw new Error("mppx emitted a 402 without WWW-Authenticate.");
        }
        const problemJson = await challengeResponse.json().catch(() => ({
          status: 402,
          title: "Payment Required",
        }));
        const handle = await context.writeResource(
          "challengeSpec",
          `challenge-${
            slug(args.externalId ?? `${args.amount}-${args.currency}`)
          }`,
          {
            wwwAuthenticate,
            problemJson,
            amount: args.amount,
            currency: args.currency,
            ...(expires ? { expires } : {}),
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    verifyCredential: {
      description:
        "Verify a received Authorization: Payment credential — HMAC-bound " +
        "challenge id (constant-time inside mppx), expiry, method — and " +
        "record the verdict WITHOUT charging. Never throws on an invalid " +
        "credential; the verdict resource carries valid=false + reason.",
      arguments: VerifyCredentialArgs,
      execute: async (
        args: z.infer<typeof VerifyCredentialArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        if (!g.serverSecret) {
          throw new Error(
            "verifyCredential requires the serverSecret global argument.",
          );
        }
        const verdict = (
          valid: boolean,
          extra: Record<string, unknown>,
        ) =>
          context.writeResource(
            "credential",
            // Stable per-challenge instance name: re-verifying the same
            // credential updates one resource instead of growing unbounded.
            `credential-${slug(String(extra.challengeId ?? "invalid"))}`,
            { valid, ...extra, fetchedAt: now() },
          );

        let handle: unknown;
        try {
          const cred = Credential.deserialize<
            { spt?: string; externalId?: string }
          >(args.authorizationHeader);
          const ch = cred.challenge;
          const req = ch.request as Record<string, unknown>;
          const info = {
            challengeId: ch.id,
            sptTruncated: cred.payload?.spt
              ? truncateSpt(cred.payload.spt)
              : undefined,
            amount: typeof req.amount === "string" ? req.amount : undefined,
            currency: typeof req.currency === "string"
              ? req.currency
              : undefined,
          };
          if (ch.method !== "stripe") {
            handle = await verdict(false, { ...info, reason: "wrong method" });
          } else if (!Challenge.verify(ch, { secretKey: g.serverSecret })) {
            handle = await verdict(false, {
              ...info,
              reason: "challenge id failed HMAC verification (tampered?)",
            });
          } else if (
            ch.expires && new Date(ch.expires).getTime() < Date.now()
          ) {
            handle = await verdict(false, { ...info, reason: "expired" });
          } else if (!cred.payload?.spt) {
            handle = await verdict(false, {
              ...info,
              reason: "missing spt in credential payload",
            });
          } else if (
            args.expectedAmount !== undefined &&
            info.amount !== args.expectedAmount
          ) {
            handle = await verdict(false, {
              ...info,
              reason: "amount mismatch",
            });
          } else if (
            args.expectedCurrency !== undefined &&
            info.currency?.toLowerCase() !== args.expectedCurrency.toLowerCase()
          ) {
            handle = await verdict(false, {
              ...info,
              reason: "currency mismatch",
            });
          } else if (
            args.expectedScope !== undefined &&
            challengeScope(ch) !== args.expectedScope
          ) {
            handle = await verdict(false, {
              ...info,
              reason: "scope mismatch (cross-route replay?)",
            });
          } else {
            handle = await verdict(true, info);
          }
        } catch (err) {
          handle = await verdict(false, {
            reason: redact(
              g,
              `credential parse failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          });
        }
        return { dataHandles: [handle] };
      },
    },

    chargeToken: {
      description: "Settle a granted Shared Payment Token via a confirmed " +
        "PaymentIntent (payment_method_data.shared_payment_granted_token). " +
        "Success is recorded ONLY when the PaymentIntent is `succeeded`; " +
        "failed settlements are persisted and thrown. Accepts either " +
        "sptId+amount+currency or a full authorizationHeader (verified " +
        "before settling).",
      arguments: ChargeTokenArgs,
      execute: async (
        args: z.infer<typeof ChargeTokenArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        let spt = args.sptId;
        let amount = args.amount;
        let currency = args.currency;
        let externalId = args.externalId;
        // The HMAC-bound challenge id (when settling a credential) is a unique
        // per-challenge idempotency anchor — distinct challenges never collide.
        let challengeId: string | undefined;

        if (args.authorizationHeader) {
          if (!g.serverSecret) {
            throw new Error(
              "chargeToken with authorizationHeader requires serverSecret " +
                "to verify the challenge binding first.",
            );
          }
          let cred;
          try {
            cred = Credential.deserialize<{ spt: string; externalId?: string }>(
              args.authorizationHeader,
            );
          } catch (err) {
            throw new Error(
              redact(
                g,
                `Malformed authorizationHeader: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
          }
          if (
            !Challenge.verify(cred.challenge, { secretKey: g.serverSecret })
          ) {
            throw new Error(
              "Refusing to settle: credential challenge failed HMAC " +
                "verification.",
            );
          }
          if (
            cred.challenge.expires &&
            new Date(cred.challenge.expires).getTime() < Date.now()
          ) {
            throw new Error(
              "Refusing to settle: credential challenge has expired.",
            );
          }
          if (
            args.expectedScope !== undefined &&
            challengeScope(cred.challenge) !== args.expectedScope
          ) {
            throw new Error(
              "Refusing to settle: challenge scope does not match " +
                "expectedScope (possible cross-route replay).",
            );
          }
          const req = cred.challenge.request as Record<string, unknown>;
          spt = cred.payload.spt;
          amount = amount ?? (req.amount as string);
          currency = currency ?? (req.currency as string);
          externalId = externalId ?? cred.payload.externalId;
          challengeId = cred.challenge.id;
        }
        if (!spt || !amount || !currency) {
          throw new Error(
            "chargeToken needs sptId+amount+currency or an " +
              "authorizationHeader carrying them.",
          );
        }
        if (!isCanonicalMinorUnits(amount)) {
          throw new Error(
            `Refusing to settle a non-canonical amount (${amount}) — must be ` +
              "a minor-units integer.",
          );
        }

        const client = sdk(g);
        const params = {
          amount: Number(amount),
          currency,
          confirm: true,
          // Headless settlement: no redirect-based methods (matches mppx's
          // reference SPT charge) so a confirm:true intent with the payment
          // method supplied only via payment_method_data settles server-side.
          automatic_payment_methods: {
            enabled: true,
            allow_redirects: "never",
          },
          // Preview field not in GA typings yet (docs.stripe.com SPT settle).
          payment_method_data: { shared_payment_granted_token: spt },
          ...(args.description ? { description: args.description } : {}),
          ...(externalId ? { metadata: { externalId } } : {}),
        } as unknown as Parameters<typeof client.paymentIntents.create>[0];
        const chargeKey = await idemKey("charge", [
          challengeId,
          externalId,
          spt,
          amount,
        ]);
        const pi = await redacting(
          g,
          () =>
            client.paymentIntents.create(params, {
              idempotencyKey: chargeKey,
            }),
        ) as unknown as Record<string, unknown>;

        const outcome = pi.status === "succeeded" ? "success" : "failed";
        const handle = await context.writeResource(
          "charge",
          `charge-${slug(String(pi.id))}`,
          {
            piId: pi.id,
            status: pi.status,
            outcome,
            amount: pi.amount,
            currency: pi.currency,
            ...(externalId ? { externalId } : {}),
            fetchedAt: now(),
          },
        );
        if (outcome !== "success") {
          throw new Error(
            `Settlement did not succeed: PaymentIntent ${pi.id} is ` +
              `status=${pi.status} (spec requires status==succeeded before ` +
              "delivering the resource).",
          );
        }
        return { dataHandles: [handle] };
      },
    },

    issueReceipt: {
      description:
        "Produce the Payment-Receipt header value for a SETTLED charge " +
        "(spec: only after PaymentIntent status==succeeded).",
      arguments: IssueReceiptArgs,
      execute: async (
        args: z.infer<typeof IssueReceiptArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        const client = sdk(g);
        const pi = await retrievePaymentIntent(
          g,
          client,
          args.chargeId,
        ) as unknown as Record<string, unknown>;
        if (pi.status !== "succeeded") {
          throw new Error(
            `Refusing to issue a receipt: PaymentIntent ${args.chargeId} is ` +
              `status=${pi.status}, receipts require succeeded.`,
          );
        }
        const timestamp = now();
        const receipt = Receipt.from({
          method: "stripe",
          reference: String(pi.id),
          status: "success",
          timestamp,
          ...(args.externalId ? { externalId: args.externalId } : {}),
        });
        const handle = await context.writeResource(
          "receipt",
          `receipt-${slug(args.chargeId)}`,
          {
            chargeId: args.chargeId,
            header: Receipt.serialize(receipt),
            reference: String(pi.id),
            timestamp,
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    getCharge: {
      description: "Retrieve a charge (GET /v1/payment_intents/{id}).",
      arguments: ChargeIdArgs,
      execute: async (args: z.infer<typeof ChargeIdArgs>, context: ExecCtx) => {
        const g = parseGlobals(context);
        const client = sdk(g);
        const pi = await retrievePaymentIntent(
          g,
          client,
          args.chargeId,
        ) as unknown as Record<string, unknown>;
        const handle = await context.writeResource(
          "charge",
          `charge-${slug(String(pi.id))}`,
          {
            piId: pi.id,
            status: pi.status,
            outcome: pi.status === "succeeded" ? "success" : "failed",
            amount: pi.amount,
            currency: pi.currency,
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listCharges: {
      description: "Reconciliation fan-out: list charges by created range " +
        "(GET /v1/payment_intents) or by metadata externalId " +
        "(GET /v1/payment_intents/search). Writes one charge resource per " +
        "item plus a summary. Paginates internally up to maxResults.",
      arguments: ListChargesArgs,
      execute: async (
        args: z.infer<typeof ListChargesArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        const client = sdk(g);
        const handles: unknown[] = [];
        const ids: string[] = [];
        let truncated = false;

        const writeItem = async (pi: Record<string, unknown>) => {
          handles.push(
            await context.writeResource(
              "charge",
              `charge-${slug(String(pi.id))}`,
              {
                piId: pi.id,
                status: pi.status,
                outcome: pi.status === "succeeded" ? "success" : "failed",
                amount: pi.amount,
                currency: pi.currency,
                fetchedAt: now(),
              },
            ),
          );
          ids.push(String(pi.id));
        };

        if (args.externalId) {
          // Metadata filtering needs the search API — the plain list
          // endpoint cannot filter by metadata. externalId is regex-guarded
          // at the schema, so the query below cannot be injected into.
          let page: string | undefined;
          while (ids.length < args.maxResults) {
            const res = await redacting(g, () =>
              client.paymentIntents.search({
                query: `metadata['externalId']:'${args.externalId}'`,
                limit: Math.min(args.pageSize, args.maxResults - ids.length),
                ...(page ? { page } : {}),
              })) as unknown as {
                data: Array<Record<string, unknown>>;
                has_more: boolean;
                next_page?: string | null;
              };
            for (const pi of res.data) {
              if (ids.length >= args.maxResults) {
                truncated = true;
                break;
              }
              await writeItem(pi);
            }
            // Server still has results but we hit the local cap → truncated.
            if (res.has_more && ids.length >= args.maxResults) truncated = true;
            if (!res.has_more || !res.next_page) break;
            page = res.next_page;
          }
        } else {
          let startingAfter: string | undefined;
          while (ids.length < args.maxResults) {
            const created: Record<string, number> = {};
            if (args.createdGte) created.gte = args.createdGte;
            if (args.createdLte) created.lte = args.createdLte;
            const res = await redacting(g, () =>
              client.paymentIntents.list({
                limit: Math.min(args.pageSize, args.maxResults - ids.length),
                ...(Object.keys(created).length ? { created } : {}),
                ...(startingAfter ? { starting_after: startingAfter } : {}),
              })) as unknown as {
                data: Array<Record<string, unknown>>;
                has_more: boolean;
              };
            for (const pi of res.data) {
              if (ids.length >= args.maxResults) {
                truncated = true;
                break;
              }
              await writeItem(pi);
            }
            if (res.has_more && ids.length >= args.maxResults) truncated = true;
            if (!res.has_more || res.data.length === 0) break;
            startingAfter = String(res.data[res.data.length - 1].id);
          }
        }

        handles.push(
          await context.writeResource("summary", "summary-charges", {
            scope: "charges",
            total: ids.length,
            ids,
            truncated,
            fetchedAt: now(),
          }),
        );
        context.logger?.info("Listed {n} charge(s)", { n: ids.length });
        return { dataHandles: handles };
      },
    },

    refundCharge: {
      description: "Refund a settled charge (POST /v1/refunds) with " +
        "read-before-destructive verification: retrieves the PaymentIntent " +
        "first, requires status==succeeded, and enforces the " +
        "remaining-refundable ceiling (amount_received minus already " +
        "refunded). A refund resource is written on every outcome.",
      arguments: RefundChargeArgs,
      execute: async (
        args: z.infer<typeof RefundChargeArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        const client = sdk(g);
        const record = (extra: Record<string, unknown>) =>
          context.writeResource(
            "refund",
            // Disambiguate so a second partial refund of the same charge does
            // not overwrite the first refund's audit record.
            `refund-${slug(args.externalId ?? `${args.chargeId}-${now()}`)}`,
            {
              chargeId: args.chargeId,
              amount: args.amount,
              ...extra,
              fetchedAt: now(),
            },
          );

        if (!isCanonicalMinorUnits(args.amount)) {
          await record({
            outcome: "blocked",
            error: `refund amount ${args.amount} is not canonical minor units`,
          });
          throw new Error(
            `Refund amount (${args.amount}) must be a canonical minor-units ` +
              "integer.",
          );
        }

        // Rule 5: read and verify live state before the destructive call.
        const pi = await retrievePaymentIntent(
          g,
          client,
          args.chargeId,
          true,
        ) as unknown as Record<string, unknown>;
        if (pi.status !== "succeeded") {
          await record({
            outcome: "blocked",
            error: `PaymentIntent status=${pi.status}, refunds need succeeded`,
          });
          throw new Error(
            `Cannot refund ${args.chargeId}: status=${pi.status} ` +
              "(refunds require a succeeded PaymentIntent).",
          );
        }
        const received = Number(pi.amount_received ?? pi.amount ?? 0);
        const latestCharge = pi.latest_charge as
          | Record<string, unknown>
          | null;
        const alreadyRefunded = Number(latestCharge?.amount_refunded ?? 0);
        const remaining = received - alreadyRefunded;
        if (Number(args.amount) > remaining) {
          await record({
            outcome: "blocked",
            error:
              `refund ${args.amount} exceeds remaining refundable ${remaining}`,
          });
          throw new Error(
            `Refund amount ${args.amount} exceeds the remaining refundable ` +
              `amount (${remaining} of ${received}, ${alreadyRefunded} ` +
              "already refunded).",
          );
        }

        const refundKey = await idemKey("refund", [
          args.externalId,
          args.chargeId,
          args.amount,
        ]);
        try {
          const refund = await redacting(g, () =>
            client.refunds.create({
              payment_intent: args.chargeId,
              amount: Number(args.amount),
              ...(args.reason ? { reason: args.reason } : {}),
              ...(args.externalId
                ? { metadata: { externalId: args.externalId } }
                : {}),
            }, {
              idempotencyKey: refundKey,
            })) as unknown as Record<string, unknown>;
          const handle = await record({
            outcome: "success",
            refundId: refund.id,
            status: refund.status,
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await record({
            outcome: "failed",
            error: redact(g, err instanceof Error ? err.message : String(err)),
          });
          throw err;
        }
      },
    },

    getGrantedToken: {
      description:
        "Retrieve a granted Shared Payment Token (seller view). Card " +
        "details are trimmed to brand/last4/expiry — fingerprints and " +
        "numbers are never persisted.",
      arguments: SptIdArgs,
      sensitiveOutput: true,
      execute: async (args: z.infer<typeof SptIdArgs>, context: ExecCtx) => {
        const g = parseGlobals(context);
        const client = sdk(g);
        const token = await redacting(
          g,
          () => client.sharedPayment.grantedTokens.retrieve(args.sptId),
        ) as unknown as Record<string, unknown>;
        const details = token.payment_method_details as
          | Record<string, unknown>
          | undefined;
        const card = details?.card as Record<string, unknown> | undefined;
        const handle = await context.writeResource(
          "grantedToken",
          `granted-${slug(args.sptId)}`,
          {
            id: token.id,
            usageLimits: token.usage_limits,
            deactivatedAt: token.deactivated_at ?? null,
            deactivatedReason: token.deactivated_reason ?? null,
            ...(details
              ? {
                paymentMethod: {
                  type: details.type,
                  ...(card
                    ? {
                      card: {
                        brand: card.brand,
                        last4: card.last4,
                        expMonth: card.exp_month,
                        expYear: card.exp_year,
                      },
                    }
                    : {}),
                },
              }
              : {}),
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    createTestGrantedToken: {
      description:
        "TEST MODE ONLY: fabricate a granted Shared Payment Token via " +
        "/v1/test_helpers/shared_payment/granted_tokens for end-to-end " +
        "testing. Refuses to run outside test mode or with a live key.",
      arguments: TestGrantedTokenArgs,
      sensitiveOutput: true,
      execute: async (
        args: z.infer<typeof TestGrantedTokenArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        if (!g.testMode || !g.secretKey.startsWith("sk_test_")) {
          throw new Error(
            "createTestGrantedToken only runs in test mode with an " +
              "sk_test_ key — refusing.",
          );
        }
        if (!isCanonicalMinorUnits(args.maxAmount)) {
          throw new Error(
            `createTestGrantedToken maxAmount (${args.maxAmount}) must be a ` +
              "canonical minor-units integer.",
          );
        }
        const client = sdk(g);
        const token = await redacting(g, () =>
          client.rawRequest(
            "POST",
            "/v1/test_helpers/shared_payment/granted_tokens",
            {
              // The test helper requires a payment_method to draw on.
              payment_method: args.paymentMethodId,
              usage_limits: {
                currency: args.currency,
                max_amount: Number(args.maxAmount),
                // A one-time (non-recurring) token requires expires_at; default
                // to +1h so a caller that omits it still gets a valid token.
                expires_at: args.expiresAt ??
                  Math.floor(Date.now() / 1000) + 3600,
              },
            },
          ) as Promise<Record<string, unknown>>);
        const handle = await context.writeResource(
          "grantedToken",
          `granted-${slug(String(token.id))}`,
          {
            id: token.id,
            usageLimits: token.usage_limits,
            deactivatedAt: null,
            deactivatedReason: null,
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // -------------------------------------------- consumer buyer (Link grant)
    // A human WITHOUT a Stripe account grants a Shared Payment Token from their
    // Link wallet, which the model then spends BY REFERENCE (mpp_pay by lsrq_).
    // Transport is `link-cli --mcp` over stdio (see lib/link_cli.ts). US-only
    // Link; inert unless linkCliPath is set and a link-cli session is
    // authenticated on this host.
    listConsumerPaymentMethods: {
      description:
        "List the consumer's Link wallet payment methods (csmrpd_). Fan-out: " +
        "one consumerPaymentMethod resource per item plus a summary " +
        "(summary-consumer-payment-methods). Requires an authenticated " +
        "link-cli session; inert otherwise.",
      arguments: ListConsumerPaymentMethodsArgs,
      execute: async (
        _args: z.infer<typeof ListConsumerPaymentMethodsArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        const cfg = linkCliConfig(g);
        const red = (s: string) => redact(g, s);
        const res = await callTool(
          { tool: "payment-methods_list", args: {} },
          cfg,
          red,
        );
        const items: unknown[] = Array.isArray(res)
          ? res
          : (isRecord(res) && Array.isArray(res.data) ? res.data : []);
        const handles: unknown[] = [];
        const ids: string[] = [];
        for (const it of items) {
          if (!isRecord(it) || typeof it.id !== "string") continue;
          ids.push(it.id);
          const display = strOrUndef(it.display);
          const h = await context.writeResource(
            "consumerPaymentMethod",
            `cpm-${slug(it.id)}`,
            {
              id: it.id,
              kind: strOrUndef(it.type) ?? strOrUndef(it.kind),
              display: display ? red(display) : undefined,
              fetchedAt: now(),
            },
          );
          handles.push(h);
        }
        const summary = await context.writeResource(
          "summary",
          "summary-consumer-payment-methods",
          {
            scope: "consumer-payment-methods",
            total: ids.length,
            ids,
            truncated: false,
            fetchedAt: now(),
          },
        );
        handles.push(summary);
        return { dataHandles: handles };
      },
    },

    getSpendRequest: {
      description:
        "Retrieve a consumer spend request by lsrq_ (single-shot; interval 0). " +
        "Do NOT call in a poll loop — the ~10-minute approval wait is a " +
        "workflow's manual_approval step (timeout 600), not per-model-lock " +
        "contention. Statuses: created | pending_approval | approved | denied " +
        "| expired.",
      arguments: SpendRequestIdArgs,
      sensitiveOutput: true,
      execute: async (
        args: z.infer<typeof SpendRequestIdArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        if (!LSRQ.test(args.id)) {
          throw new Error(
            `Not a spend-request id (lsrq_...): ${redact(g, args.id)}`,
          );
        }
        const cfg = linkCliConfig(g);
        const red = (s: string) => redact(g, s);
        const res = await callTool(
          { tool: "spend-request_retrieve", args: { id: args.id } },
          cfg,
          red,
        );
        const sr = isRecord(res) ? res : {};
        const handle = await context.writeResource(
          "spendRequest",
          `spend-${slug(args.id)}`,
          {
            id: args.id,
            status: strOrUndef(sr.status) ?? "unknown",
            outcome: "retrieved" as const,
            amount: toAmountStr(sr.amount),
            currency: strOrUndef(sr.currency),
            networkId: strOrUndef(sr.network_id) ?? strOrUndef(sr.networkId),
            paymentMethodId: strOrUndef(sr.payment_method_id) ??
              strOrUndef(sr.paymentMethodId),
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    cancelSpendRequest: {
      description:
        "Cancel a PENDING consumer spend request (read-before-cancel). Note: " +
        "there is no revocation for an ALREADY-APPROVED grant — cancel covers " +
        "pending requests only.",
      arguments: SpendRequestIdArgs,
      execute: async (
        args: z.infer<typeof SpendRequestIdArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        if (!LSRQ.test(args.id)) {
          throw new Error(
            `Not a spend-request id (lsrq_...): ${redact(g, args.id)}`,
          );
        }
        const cfg = linkCliConfig(g);
        const red = (s: string) => redact(g, s);
        // Read before cancel so the audit trail records the prior state.
        await callTool(
          { tool: "spend-request_retrieve", args: { id: args.id } },
          cfg,
          red,
        );
        const res = await callTool(
          { tool: "spend-request_cancel", args: { id: args.id } },
          cfg,
          red,
        );
        const sr = isRecord(res) ? res : {};
        const handle = await context.writeResource(
          "spendRequest",
          `spend-${slug(args.id)}`,
          {
            id: args.id,
            status: strOrUndef(sr.status) ?? "cancelled",
            outcome: "cancelled" as const,
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    createSpendRequest: {
      description:
        "Create a consumer Link spend request — the PRIMARY (binding) guard " +
        "for the consumer flow. amount cap/floor, currency, and the " +
        "vault-pinned payee are enforced HERE, before the consumer is " +
        "prompted, because the consumer-APPROVED grant is the binding spend " +
        "cap (paySpendRequest's later pre-flight is only advisory). " +
        "requestApproval=false: this does NOT block; poll getSpendRequest via " +
        "a workflow manual_approval step for the terminal status.",
      arguments: CreateSpendRequestArgs,
      sensitiveOutput: true,
      execute: async (
        args: z.infer<typeof CreateSpendRequestArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        const cfg = linkCliConfig(g);
        const red = (s: string) => redact(g, s);
        const currency = args.currency.toLowerCase();
        const networkId = args.networkId ?? g.networkId;
        const intentKey = await idemKey("spend-request", [
          args.externalId,
          networkId,
          args.amount,
          currency,
          args.paymentMethodId,
        ]);
        // Write the audit record on EVERY outcome before throwing. Pre-lsrq
        // (blocked/guard) records are keyed by the intent; success by the lsrq_.
        const blocked = async (error: string): Promise<never> => {
          await context.writeResource(
            "spendRequest",
            `spend-${slug(args.externalId ?? intentKey)}`,
            {
              id: intentKey,
              status: "blocked",
              outcome: "blocked" as const,
              amount: args.amount,
              currency,
              networkId,
              paymentMethodId: args.paymentMethodId,
              intentKey,
              error,
              fetchedAt: now(),
            },
          );
          throw new Error(red(error));
        };

        // ---- Primary guards, BEFORE the consumer is ever prompted ----------
        if (!networkId) {
          await blocked(
            "createSpendRequest requires a payee Business Network Profile — " +
              "set the networkId global (fail-closed).",
          );
        }
        if (!PROFILE.test(networkId!)) {
          await blocked(
            `Not a Business Network Profile id (profile_...): ${networkId}`,
          );
        }
        if (args.paymentMethodId && !CSMRPD.test(args.paymentMethodId)) {
          await blocked(
            `Not a consumer payment method id (csmrpd_...): ${args.paymentMethodId}`,
          );
        }
        if (!isCanonicalMinorUnits(args.amount)) {
          await blocked(
            `Amount (${args.amount}) is not a canonical minor-units integer.`,
          );
        }
        if (amountExceeds(args.amount, "500000")) {
          await blocked(
            `Amount (${args.amount}) exceeds link-cli's 500000 minor-unit cap.`,
          );
        }
        const floor = MIN_CHARGE[currency];
        if (floor !== undefined && BigInt(args.amount) < floor) {
          await blocked(
            `Amount (${args.amount} ${currency}) is below the ${floor} ` +
              "minor-unit card-network minimum.",
          );
        }

        // ---- Create the grant. test mode is DERIVED from allowLiveGrants ---
        const res = await callTool(
          {
            tool: "spend-request_create",
            args: {
              credentialType: "shared_payment_token",
              networkId,
              amount: Number(args.amount), // canonical string -> integer at wire
              currency,
              context: args.context,
              requestApproval: false,
              test: cfg.test,
              ...(args.paymentMethodId
                ? { paymentMethodId: args.paymentMethodId }
                : {}),
            },
          },
          cfg,
          red,
        );
        const sr = isRecord(res) ? res : {};
        const lsrq = strOrUndef(sr.id);
        if (!lsrq || !LSRQ.test(lsrq)) {
          await blocked("link-cli returned no valid spend-request id.");
        }

        // ---- Response-echo verification: fail closed on a swapped grant ----
        const echoNet = strOrUndef(sr.network_id) ?? strOrUndef(sr.networkId);
        const echoAmt = toAmountStr(sr.amount);
        const echoCur = strOrUndef(sr.currency);
        if (echoNet !== undefined && echoNet !== networkId) {
          await blocked(
            `Grant echo mismatch: payee ${echoNet} != requested ${networkId}.`,
          );
        }
        if (echoAmt !== undefined && echoAmt !== args.amount) {
          await blocked(
            `Grant echo mismatch: amount ${echoAmt} != requested ${args.amount}.`,
          );
        }
        if (echoCur !== undefined && echoCur.toLowerCase() !== currency) {
          await blocked(
            `Grant echo mismatch: currency ${echoCur} != requested ${currency}.`,
          );
        }
        const echoPm = strOrUndef(sr.payment_method_id) ??
          strOrUndef(sr.paymentMethodId);
        if (
          args.paymentMethodId !== undefined && echoPm !== undefined &&
          echoPm !== args.paymentMethodId
        ) {
          await blocked(
            `Grant echo mismatch: payment method ${echoPm} != requested ` +
              `${args.paymentMethodId}.`,
          );
        }

        const handle = await context.writeResource(
          "spendRequest",
          `spend-${slug(lsrq!)}`,
          {
            id: lsrq!,
            status: strOrUndef(sr.status) ?? "created",
            outcome: "created" as const,
            amount: args.amount,
            currency,
            networkId,
            paymentMethodId: args.paymentMethodId,
            intentKey,
            fetchedAt: now(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    paySpendRequest: {
      description:
        "Spend an APPROVED consumer grant against an MPP-protected URL, by " +
        "reference (link-cli mpp_pay --spendRequestId). The pre-flight guard " +
        "against the 402 is ADVISORY only: mpp_pay re-fetches the URL and " +
        "spends against its OWN challenge, so it cannot bind our pins — the " +
        "binding cap is the consumer-approved grant (createSpendRequest). Our " +
        "own `pay` cannot spend a Link grant (it has no raw spt_).",
      arguments: PaySpendRequestArgs,
      sensitiveOutput: true,
      execute: async (
        args: z.infer<typeof PaySpendRequestArgs>,
        context: ExecCtx,
      ) => {
        const g = parseGlobals(context);
        if (!LSRQ.test(args.id)) {
          throw new Error(
            `Not a spend-request id (lsrq_...): ${redact(g, args.id)}`,
          );
        }
        const cfg = linkCliConfig(g);
        const red = (s: string) => redact(g, s);
        const record = (extra: Record<string, unknown>) =>
          context.writeResource("spendRequest", `spend-${slug(args.id)}`, {
            id: args.id,
            ...extra,
            fetchedAt: now(),
          });

        // ADVISORY pre-flight: probe the 402 and run the shared guard. This
        // catches an obviously-wrong target before spending, but is NOT binding.
        const first = await redacting(g, () => fetchResource(g, args));
        if (first.status === 402) {
          const picked = pickStripeChallenge(Challenge.fromResponseList(first));
          await first.body?.cancel().catch(() => {});
          if (picked) {
            const violation = challengeGuardViolation(
              {
                amount: picked.amount,
                currency: picked.currency,
                networkId: picked.networkId,
                realm: picked.realm,
              },
              {
                expectedNetworkId: args.expectedNetworkId,
                expectedRealm: args.expectedRealm,
                currency: args.currency,
                maxAmount: args.maxAmount,
              },
            );
            if (violation) {
              await record({
                status: "blocked",
                outcome: "blocked",
                error: violation.recordError,
              });
              throw new Error(violation.throwError);
            }
          }
        } else {
          await first.body?.cancel().catch(() => {});
        }

        // Delegate the actual spend to link-cli mpp_pay, by lsrq_ reference.
        const payArgs: Record<string, unknown> = {
          url: args.url,
          spendRequestId: args.id,
          method: args.httpMethod,
        };
        if (args.body) payArgs.data = args.body;
        let outcome: "paid" | "pay-failed" = "paid";
        let payErr: string | undefined;
        try {
          await callTool({ tool: "mpp_pay", args: payArgs }, cfg, red);
        } catch (e) {
          outcome = "pay-failed";
          payErr = (e as Error).message;
        }

        // Close out the grant with link-cli's outcome telemetry (best-effort).
        try {
          await callTool(
            {
              tool: "report",
              args: {
                spendRequestId: args.id,
                outcome: outcome === "paid" ? "success" : "blocked",
              },
            },
            cfg,
            red,
          );
        } catch { /* telemetry must not mask the payment outcome */ }

        const handle = await record({
          status: outcome,
          outcome,
          error: payErr,
        });
        if (outcome === "pay-failed") {
          throw new Error(payErr ?? "mpp_pay failed");
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
