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

Fixtures re-pinned to v0.10.1 on 2026-08-01 based on the published release notes
(additive/security changes, no documented stdio-MCP contract change) — not
re-observed, since Link is still US-only and not live-verifiable from this
maintainer's EU account. The v0.9.0 ground truth above remains the last
directly-observed transcript.

## Wrapper protocol (link-cli 0.19.1+, re-observed on 0.28.0, 2026-10-25)

link-cli's stdio server is built on `incur`, which defaults to **progressive
discovery**. `tools/list` returns only four tools: `search_tools`,
`get_tool_details`, `call_read_tool` and `call_write_tool`. A direct
`tools/call` of an inner tool such as `spend-request_create` fails with JSON-RPC
-32602 "Tool spend-request_create not found".

An inner tool is executed through a wrapper:

```json
{
  "method": "tools/call",
  "params": {
    "name": "call_write_tool",
    "arguments": {
      "name": "spend-request_retrieve",
      "arguments": { "id": "lsrq_..." }
    }
  }
}
```

- `call_read_tool` runs only tools annotated `readOnlyHint: true`, and
  `call_write_tool` runs only tools that are not. link-cli 0.28.0 annotates
  **none** of its tools, so every call, reads included, uses `call_write_tool`.
  `call_read_tool` answers `isError` `{"error":"Tool is not read-only: X"}`.
- An unknown inner name answers `isError` `{"error":"Unknown tool: X"}`.
- The wrapper returns the inner tool's result envelope unchanged: one text
  content block holding compact JSON. A rendered call-to-action can follow after
  a blank line.
- Generator commands (`spend-request_create`, `spend-request_retrieve`,
  `mpp_pay`) return a JSON **array** of yielded chunks; the result is the last
  chunk. A generator that ends with an error returns `[]` with no `isError`, so
  the model treats an empty stream as a failure.

The routing is pinned per tool in `LINK_TOOLS` (`lib/link_cli.ts`). If a new
link-cli release starts marking reads read-only, the version check fails first
and the table must be re-pinned.

## Tools used

| Model method                 | Inner tool (via `call_write_tool`) | Notes                     |
| ---------------------------- | ---------------------------------- | ------------------------- |
| `listConsumerPaymentMethods` | `payment-methods_list`             | returns `csmrpd_` ids     |
| `createSpendRequest`         | `spend-request_create`             | see the SPT args below    |
| `getSpendRequest`            | `spend-request_retrieve`           | single-shot (interval 0)  |
| `cancelSpendRequest`         | `spend-request_cancel`             | pending requests only     |
| `paySpendRequest`            | `mpp_pay` + `report`               | spend by `spendRequestId` |

`mpp_pay` returns the paid request's HTTP response (`{ status, headers, body }`)
as a successful result even when the seller rejects it; the model records a
status of 400 or above as `pay-failed`. `report` requires `domain`, which the
model takes from the paid URL's hostname.

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
- link-cli 0.28.0 accepts an optional `idempotencyKey`; the model does not send
  one yet

Statuses: `created → pending_approval → approved | denied | expired` (link-cli
uses **denied**, not "declined"); `cancelled` is reached only via
`spend-request_cancel` on a pending request.

## Transport contract (lib/link_cli.ts)

- `initialize` handshake returns `serverInfo.version`, asserted against the
  pinned `linkCliVersion` as **drift detection only** (a shadow binary can spoof
  it — the binary is spawned by absolute path so PATH cannot hijack it, and is
  the real integrity anchor).
- A top-level JSON-RPC `error`, a tool result with `isError: true` (a 2xx-shaped
  failure such as "Not authenticated", or a wrapper refusal), or an empty stream
  is treated as a failure BEFORE any domain parse — the tool result is the
  source of truth for whether a human approved a payment.
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
