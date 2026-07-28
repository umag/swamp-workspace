# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-1 full build of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `talos.ts` is unmodified and the model `version` stays
`2026.07.16.2`.

- Added `extensions/models/talos_test.ts` (contract-fixture),
  `talos_methods_test.ts` (methods), `talos_adversarial_test.ts` (adversarial),
  `talos_coverage_test.ts` (coverage), `talos_property_test.ts`
  (property-invariant-flow) — 0 tests before this change, 90 after.
- Added `fixtures/` — pure doc/help-derived, synthetic `talosctl`
  `{success, stdout, stderr}` wire-shape fixtures (`version`, `services`,
  `etcd-members`, `kubeconfig`, `health`, `apply-config`, `error`) plus
  `PROVENANCE.md`. No live call was made against any real Talos node, cluster,
  or talosconfig; every value is synthetic (RFC 5737 addresses, a fake cluster
  name, short fake kubeconfig cert/key sentinels).
- `deno.json`: default `test` task stays subprocess-less and network-less
  (`--allow-env=FC_NUM_RUNS` only — no `--allow-net`, `--allow-run`, or
  `--allow-read`). Omitting `--allow-run` is a deliberate safety failsafe: a
  mis-stubbed test that constructs a real `Deno.Command` fails with
  `PermissionDenied` instead of shelling out to a real `talosctl` (which could
  reboot/reset/wipe a live node). Broadening this permission set requires
  review. Added `test:soak` for the high-count nightly property soak.
- `deno.lock`: regenerated to lock the new dev-only test deps
  (`npm:fast-check@4.8.0`, `jsr:@std/assert@1`).
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (talos-node
  bundles no Claude skill); `ratchet` set to the measured score (rubricVersion
  3, 100%, Grade A). `watch`/`canary` stay `backlog` (allowlist-exempt per
  STANDARD.md). Removed from `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: Talos Linux node management via the `talosctl` CLI — version,
services, etcd members, kubeconfig, config apply/patch, bootstrap, reboot,
shutdown, reset, upgrade, and cluster health.
