# link-cli MCP surface (consumer buyer)

The consumer-buyer methods drive Stripe's `@stripe/link-cli` as an MCP server
over **stdio** (`link-cli --mcp`), spawned by `Deno.Command` from
`extensions/models/lib/link_cli.ts`. This is deliberately NOT the HTTP `serve`
mode: the spike (`SPIKE-link-cli.md`) found `serve` binds all interfaces, sends
`Access-Control-Allow-Origin: *`, and requires no auth on `/mcp`, so any local
process or visited web page could drive the wallet. Stdio opens no socket.

Ground truth was captured against **link-cli v0.9.0** and is pinned by the
contract fixtures in `stripe_mpp_test.ts`; the release-watch cron flags a new
`@stripe/link-cli` release so the fixtures can be re-pinned.

## Tools used (of the 19 the server exposes)

| Model method                 | MCP tool                 | Notes                     |
| ---------------------------- | ------------------------ | ------------------------- |
| `listConsumerPaymentMethods` | `payment-methods_list`   | returns `csmrpd_` ids     |
| `createSpendRequest`         | `spend-request_create`   | see the SPT args below    |
| `getSpendRequest`            | `spend-request_retrieve` | single-shot (interval 0)  |
| `cancelSpendRequest`         | `spend-request_cancel`   | pending requests only     |
| `paySpendRequest`            | `mpp_pay` + `report`     | spend by `spendRequestId` |

## `spend-request_create` — the SPT (shared_payment_token) argument set

- `credentialType: "shared_payment_token"` (required for this flow)
- `networkId` — the payee Business Network Profile (`profile_...`)
- `amount` — **integer minor units**, `0 < amount ≤ 500000`
- `currency` — 3-letter ISO, default `usd`
- `context` — **minLength 100**; shown to the consumer at approval
- `requestApproval: false` — the model does not block; it polls via
  `spend-request_retrieve`
- `test` — derived from the `allowLiveGrants` global, never from caller args
- `merchantName` / `merchantUrl` — **FORBIDDEN** for the SPT flow (they are the
  card flow's fields)
- there is **no idempotency key** (confirmed in the machine schema,
  `additionalProperties: false`)

Statuses: `created → pending_approval → approved | denied | expired` (link-cli
uses **denied**, not "declined"); `cancelled` is reached only via
`spend-request_cancel` on a pending request.

## Transport contract (lib/link_cli.ts)

- `initialize` handshake returns `serverInfo.version`, asserted against the
  pinned `linkCliVersion` as **drift detection only** (a shadow binary can spoof
  it — the binary is spawned by absolute path so PATH cannot hijack it, and is
  the real integrity anchor).
- A top-level JSON-RPC `error`, or a tool result with `isError: true` (a
  2xx-shaped failure such as "Not authenticated"), is treated as a failure
  BEFORE any domain parse — the tool result is the source of truth for whether a
  human approved a payment.
- The subprocess is spawned `clearEnv` with only `HOME` and `PATH` allowlisted,
  so it never inherits `STRIPE_SECRET_KEY` / `SERVER_SECRET`.
- Arguments cross as JSON, never as argv; any value beginning with `-` is
  refused (flag-smuggling defense-in-depth).

## Waiting is a workflow's job

`getSpendRequest` is single-shot. Do NOT loop
`swamp model method run
stripe-mpp getSpendRequest` — that contends on the
per-model lock. Drive the ~10-minute approval window from a workflow
`manual_approval` step (`timeout:
600`), then read the terminal status once. See
the `swamp` skill's workflow guide for `manual_approval`.
