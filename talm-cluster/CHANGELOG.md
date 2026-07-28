# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-1 full-build,
`ext-quality-bf-talm-cluster`, child of `ext-quality-test-backfill`). No
behavior change — `talm_cluster.ts` is unmodified and the model `version` stays
`2026.07.16.2`.

- Added `extensions/models/talm_cluster_test.ts` (contract-fixture),
  `talm_cluster_methods_test.ts` (methods), `talm_cluster_adversarial_test.ts`
  (adversarial), `talm_cluster_coverage_test.ts` (coverage),
  `talm_cluster_property_test.ts` (property-invariant-flow) — 0 tests before
  this change. Every suite drives `model.methods.<m>.execute()` /
  `model.checks.<c>.execute()` against a stubbed `globalThis.Deno.Command` (dual
  shape: `spawn()` → stdin writer + `output()`, AND a direct `output()`) and a
  fire-immediately `setTimeout` stub — mandatory for the four retry loops
  (templateNode/apply/bootstrap/health), each covered for transient-then-success
  and retry-exhaustion with its own transient-error vocabulary.
- Added `fixtures/` — pure doc-derived, synthetic Talos machine-config fixtures
  (`templateNode.controlplane.yaml` plus three edge-case variants: `multi-disk`,
  `no-sr`, `iface-no-routes`), CLI stdout transcripts
  (`init`/`bootstrap`/`health`), a `transient-errors.json` vocabulary reference,
  and `PROVENANCE.md`. No live call was made against any real talm/talosctl
  instance or cluster directory — every value is synthetic (RFC 5737 IP ranges,
  short non-base64 fake CA/token placeholders, content-free existence markers
  for talosconfig/kubeconfig/secrets.yaml).
- The adversarial suite pins three real, documented gaps rather than fixing them
  (a fix would be a separate issue + version bump): `configure`'s values.yaml
  YAML-injection via raw string interpolation; `templateNode`'s unguarded
  `${dir}/${outputFile}` path join (pinned hermetically — the escape target is a
  second temp directory, never a real location); and the substring-only
  transient-error classification in the four retry loops. It also adds a
  mechanical fixtures + `*_test.ts`-source secret-scan (PEM-marker check on
  both; a high-entropy-token check scoped to fixture data files only, to avoid
  false positives against ordinary source comments) with a self-poison sanity
  control.
- `deno.json`: default `test` task grants broad `--allow-read`/`--allow-write`
  mitigated by `--deny-write=$HOME/.talos,$HOME/.config/swamp` (verified green
  with `TMPDIR` unset), omits `--allow-run`/`--allow-net` entirely as a safety
  fuse against a stubbed-Deno.Command failure ever reaching a real destructive
  `talm`/`talosctl` invocation, and scopes `--allow-env` to `FC_NUM_RUNS`. Added
  `test:soak` for the high-count nightly property soak.
- `deno.lock`: added `npm:fast-check@4.8.0` (pinned exact) plus
  `jsr:@std/assert@1`, `jsr:@std/path@1`, `jsr:@std/yaml@1.0.10` — regenerated
  by actually running the test task, so committed integrity hashes are real.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (talm-cluster
  bundles no Claude skill). `ratchet` records the measured
  `swamp extension quality manifest.yaml --json` score at implementation time
  (100%, rubricVersion 3, "Grade A"). Removed from `quality-allowlist.txt` in
  the same change.

## 2026.07.16.2

Initial release: Talos cluster lifecycle management via `talm` —
`getClusterState`, `init`, `configure`, `templateNode`, `apply`, `bootstrap`,
`kubeconfig`, and `health`, plus `cluster-dir-exists`/`talm-available` checks.
