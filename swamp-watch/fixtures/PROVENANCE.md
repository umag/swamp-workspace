# Fixture provenance

All fixtures are trimmed captures from a real swamp CLI, 2026-08-20, against
this repo and the live `swamp serve` at `https://swamp.aopab.art`
(server `20260815.023608.0-sha.a648c130`, client `20260819.011806.0-sha.a9c7ee9a`).

| File | Captured from |
|---|---|
| `workflow_list.json` | `swamp workflow list --json` — five entries kept, chosen to cover a two-minute schedule, an UNEVENLY spaced one (`0 9,20`), a daily, a never-deployed daily, and one workflow with no `trigger` at all |
| `workflow_history_fleet_health.json` | `swamp workflow history search fleet-health --server … --json` — four runs kept, covering `succeeded`, `failed` and `cancelled`, so status folding is pinned against a real third status rather than an invented one |
| `workflow_history_empty.json` | `swamp workflow history search ext-canary-nightly --server … --json` — the genuine empty response for a workflow the server does not have |

The field set is the contract that matters: a run record carries exactly
`runId`, `startedAt`, `status`, `workflowId`, `workflowName` — no duration and
no error. If a swamp release starts returning more, `contract-fixture` is where
that shows up.
