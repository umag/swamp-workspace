# Verification controls

The mechanical controls the lifecycle runs in Phase 4c (`verify`) before any PR
is opened. These are the checks CI would otherwise re-execute on every push;
running them here, in context, is what lets CI validate an attestation instead.

The model never hardcodes a build command. The skill reads this table, passes it
to `verify` as `controls`, and `verify` executes each one once.

## Controls

| name           | command | args             | cwd | tier  | required |
| -------------- | ------- | ---------------- | --- | ----- | -------- |
| `fmt`          | `deno`  | `task fmt:check` | `.` | local | yes      |
| `lint`         | `deno`  | `task lint`      | `.` | local | yes      |
| `check`        | `deno`  | `task check`     | `.` | local | yes      |
| `test`         | `deno`  | `task test`      | `.` | local | yes      |
| `scripts-fmt`  | `deno`  | `fmt --check`    | `.` | local | yes      |
| `scripts-lint` | `deno`  | `lint`           | `.` | local | yes      |

`cwd` is relative to the repository root and may not escape it — `verify`
rejects an absolute path or one containing `..`.

For an extension under `swamp-workspace`, run the first four with
`cwd: <extension>` and the `scripts-*` pair with `cwd: scripts`. They mirror the
`deno-check` job in `.github/workflows/ci.yml` step for step, which is what
makes the attestation a substitute for it.

## Tiers

- **`local`** — cheap, hermetic, safe to run in the branch checkout. Everything
  above is local.
- **`managed`** — reserved for a higher-assurance runner (a swamp worker on
  managed infrastructure). A `managed` control is recorded as `skipped` when the
  round runs with `runner: local`, and a skipped **required** control blocks
  `attest` exactly as a failure does. Nothing is declared `managed` today; the
  tier exists so a control can be moved without a schema change.

## What stays out

`compliance`, `property-soak`, `release-watch` and the live `canary:` checks are
deliberately **not** controls. They are independent outcome verification — they
check the thing being attested from the outside, on infrastructure the lifecycle
does not control. Folding them into the attestation would mean the change
verifies itself against its own claims.

## Status semantics

- `pass` — exit code 0.
- `fail` — the control ran and rejected the tree.
- `error` — the control could not be executed (binary missing, spawn failure).
- `skipped` — a `managed` control on a `local` runner.

`fail`, `error` and `skipped` all block `attest` when the control is `required`.
"The tool could not evaluate this" is never a benign outcome: a gate that treats
an unrunnable check as a pass reports success while verifying nothing.
