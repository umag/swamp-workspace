# Spike: link-cli ground truth (2026-07-20, v0.9.0)

Timeboxed discovery against the REAL `@stripe/link-cli` before re-planning the
consumer-buyer (Link grant) feature. Every fact below was observed, not inferred
from docs. Files under `/tmp/spike-*`.

## Transport / security — the decisive reversal

- `link-cli serve` binds **`*:54321` (wildcard / all interfaces)**, verified via
  `lsof` (`TCP *:54321 LISTEN`), despite its banner "listening on
  http://localhost:54321/mcp". Wallet endpoint is reachable from the LAN.
- `/mcp` returns **`Access-Control-Allow-Origin: *`** — tested with
  `Origin: http://evil.example.com`, allowed. Any website the consumer visits
  can read wallet responses.
- **No MCP-layer auth.** `initialize`, `tools/list`, and tool `calls` all
  execute unauthenticated. Wallet ops gate ONLY on link-cli's on-disk session
  (`~/Library/Preferences/link-cli-nodejs/config.json`). Proof: `auth_status`
  ran unauthenticated and returned
  `{authenticated:false, credentials_path:...}`; `payment-methods_list` ran and
  returned `isError:true, "Not authenticated.
  Run link-cli auth login first."`
- `serve` has **no `--auth`, no `--bind`/`--host`** flag — cannot be secured.
- CONCLUSION: once the consumer runs `auth login` + `serve`, ANY local process,
  ANY LAN host, and ANY visited website can drive their authenticated wallet
  with zero further auth. **MCP-over-HTTP `serve` is MORE dangerous than a
  subprocess.** The v2 pivot rationale was backwards.
- link-cli offers **`--mcp` = MCP over STDIO** (top-level help). Same structured
  JSON-RPC tool contract, NO listening socket, no CORS, no LAN exposure. This is
  the safe transport: `Deno.Command(["link-cli","--mcp"])` + `clearEnv`
  allowlist.
- `initialize` returns `serverInfo:{name:"link-cli",version:"0.9.0"}` — a
  version/identity preflight IS possible.

## Deno.Command feasibility — CONFIRMED

- Subprocess execution is a proven, standard pattern under swamp: swamp-go-brr,
  libvirt, firecracker, observability-agent all use `Deno.Command` in shipped
  model code. v2's "unverified sandbox permission" concern was false.

## Credential model — dissolves the pivot-required CRITICAL

- The spend path is **`mpp_pay --spendRequestId <lsrq_> <url>`** — link-cli
  spends the SPT BY REFERENCE. NO command returns a raw `spt_` for the SPT flow
  (`--outputFile` / `--include card` are the CARD flow's PAN). Strong signal the
  model NEVER holds a raw spt_; it holds `lsrq_`, a safe identifier. => the
  "spendable bearer credential at rest" CRITICAL dissolves — there is no bearer
  token to persist. But our own `pay` cannot spend a grant (it needs a raw spt_
  we never get); spending must delegate to `mpp_pay`. [NEEDS LIVE CONFIRM: run
  `spend-request retrieve` on a real approved SPT grant to be 100% sure no raw
  token is ever returned.]
- **Auth is device-flow only** (`auth login` interactive,
  `--interval`/`--timeout`, persisted to disk). NO env-token headless auth in
  v0.9.0 (the earlier LINK_ACCESS_TOKEN/LINK_REFRESH_TOKEN web claim is false
  for this version). => the model NEVER handles Link tokens. link-cli owns its
  session. This dissolves the vault-custody, separation-of-duties-refine, and
  rotated-refresh-token redaction findings — the model has no Link credential to
  put in a vault, redact, or refuse alongside seller globals.

## Contract facts (correcting both plans)

- `spend-request create` for SPT: required =
  `credentialType=shared_payment_token`, `networkId` (from our own 402
  challenge, or `mpp_decode`), `amount` (integer cents, `0 < x <= 500000`),
  `currency` (default usd), `context` (**minLength 100**).
  `merchantName`/`merchantUrl` are **FORBIDDEN for SPT** (required only for
  card).
- **No idempotency key** anywhere — confirmed in the machine `--schema`
  (`additionalProperties:false`).
- `test` boolean, default false.
- MCP tool names (19 total, `<command>_<subcommand>`): `spend-request_create`,
  `spend-request_retrieve`, `spend-request_cancel`, `spend-request_list`,
  `spend-request_request-approval`, `spend-request_update`,
  `payment-methods_list`, `payment-methods_add`, `mpp_decode`, `mpp_pay`,
  `user-info_retrieve`, `auth_login`, `auth_logout`, `auth_status`, `report`,
  `demo`, `onboard`, `shipping-address_list`, `serve`.
- Statuses: `created -> pending_approval -> approved | denied | expired` (note
  **denied**, not "declined").
- Two waiting models: `spend-request create --requestApproval` (default TRUE)
  polls until terminal; `spend-request retrieve --interval 0` (default) is
  single-shot. So single-shot `getSpendRequest` = `retrieve` is feasible.
- `user-info retrieve` returns email/name/phone — NOT livemode/mode. No
  dedicated mode-signal command; test/live is the per-call `test` flag only.
- `report` tool: link-cli wants outcome telemetry after each purchase
  (`--spendRequestId`, outcome success|blocked|abandoned).

## v3 direction (grounded in the above)

1. Transport: `link-cli --mcp` over stdio via `Deno.Command` (NOT serve/HTTP).
   No socket, no CORS, params are JSON (no argv flag-smuggling), `clearEnv` +
   allowlist env, version preflight via `initialize.serverInfo.version`.
2. Spend: delegate to `mpp_pay` by `lsrq_` reference. Apply OUR guards
   (amount/currency/networkId vs the challenge) as a pre-flight BEFORE calling
   `mpp_pay`; wrap in our audit trail. Do NOT reuse `pay` for grants.
3. No Link-token custody: drop the vault keys, the separation-of-duties refine,
   and the rotated-token redaction layer — the model holds no Link credential.
   Residual: the operator must run `auth login`/serve; document not to run
   `--mcp` from a shell carrying seller Stripe creds (clearEnv handles the
   model's own spawn).
4. Idempotency: per-model lock + read-before-create via `spend-request_list`;
   document the residual (no server-side key).
5. Persist `lsrq_` (+ status, amount, currency, networkId, resolved payee) in a
   `spendRequest` resource; verify the response echoes the pinned fields.
6. Constraints to enforce/surface: US-only, `$0.50` card-network minimum,
   `context >= 100`, amount `<= 500000`, `merchant*` forbidden for SPT.
