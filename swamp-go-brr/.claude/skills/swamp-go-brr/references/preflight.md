# Preflight & bootstrap (Phase 0 — run BEFORE `start`)

Do this first. Skipping it is the #1 source of a slow, fumbling run
(hand-pinning the gate image, hunting for the OAuth token, a cold fabric pool
that silently drains nothing for minutes). The `@magistr/swamp-go-brr/preflight`
model does the substrate; two small driver recipes (fabric readiness, greenfield
scaffold) do what preflight deliberately can't.

## 1. Substrate via the `preflight` model

`preflight` shells to **docker only** (never `swamp` — that would deadlock on
the per-process `__global__` lock), so it owns the registry + image pin +
config:

```bash
swamp model create @magistr/swamp-go-brr/preflight pf   # once

# Digest-pin the gate image (the gate runs --network none, so it MUST be a
# RepoDigest present locally). Build the codebase's own image, or pin a prebuilt.
swamp model method run pf pin_image --input name=<proj>-gate --input buildContext=<path-to-dir-with-Dockerfile>
swamp data get pf pinned --json     # -> { image: "127.0.0.1:5000/<proj>-gate@sha256:…", built }

# Emit the run config: pass the codebase-specific digest image + verifyCommand;
# the substrate (si/dv/fab create cmds, fabric_up inputs, the OAuth vault CEL,
# gate params) comes from preflight globalArgs/defaults.
swamp model method run pf config \
  --input image='127.0.0.1:5000/<proj>-gate@sha256:…' \
  --input verifyCommand='TMPDIR=/work-tmp deno test --no-lock --cached-only -A'
swamp data get pf config --json
```

`config` hands you everything the loop needs, so you never hand-assemble it:

- `image` (digest-pinned) + `verifyCommand` + `gate` params for `dv verify`.
- `instanceCommands` — the `swamp model create` lines for `si`/`dv`/`fab`. Run
  them.
- `fabricUp` — `snapshotPath`/`memFilePath`/`queueRoot` and
  `oauthToken: ${{ vault.get(hashi, CLAUDE_CODE_OAUTH_TOKEN) }}` (the canonical
  token reference — do not go looking for it).

Then assert the substrate version pins (fail closed) — see
[concurrency.md](concurrency.md).

## 2. Fabric readiness (driver recipe — NOT a preflight method)

`fabric_up`/`fabric_recycle` are `swamp` calls, so they live with the driver,
not in `preflight`. **Never assume the pool is warm.** A submitted job against a
dead pool just sits `pending` forever (looks identical to "still running").
Always:

```bash
# probe: one trivial leaf
swamp model method run fab submit --input 'tasks=[{"prompt":"reply OK","model":"opus","effort":"low","gitRepoUrl":""}]'
# poll the returned id for ~90s. If it does NOT complete, the pool is cold → bring it up:
swamp model method run fab fabric_up --input concurrency=8 \
  --input 'oauthToken=${{ vault.get(hashi, CLAUDE_CODE_OAUTH_TOKEN) }}'   # token from config.fabricUp
# a cold pool restores in ~1–2 min before it starts draining — poll until the probe completes.
```

Only after the probe drains is the pool actually ready. `fabric_down` only at
run completion/abort (never between batches — it discards the warm workers).

## 3. Greenfield bootstrap (`preflight scaffold`)

`preflight scaffold` writes the baseline file set, `jj git init --colocate`s,
describes the bootstrap change, and returns the common `base` change id (and
`repoScope`) — so you never hand-run jj or fish out the change id. It's jj-only
(no `swamp`), and toolchain-agnostic: you bring the file set (the deno preset
below). Pipe the input as JSON (`--stdin`) so large file contents are clean:

```bash
swamp model method run pf scaffold --stdin <<'JSON'
{ "repoPath": "/abs/path/<repo>",
  "files": [
    { "path": "deno.json", "content": "…(fmt lineWidth 80 to match the publish gate)…" },
    { "path": "manifest.yaml", "content": "…" },
    { "path": "extensions/models/<model>.ts", "content": "export const model = { type, version, methods:{…} }  // STUB" },
    { "path": "extensions/models/base.test.ts", "content": "// smoke: asserts model.type + method names" } ] }
JSON
swamp data get pf scaffold --json    # -> { repoScope, base, changedPaths }
```

The two rules that make the loop run smoothly against the scaffold:

- **`verifyInputs` starts as the smoke test** (e.g. `base.test.ts`, asserting
  the model's `type` + method names so the common base stays green). Per-unit
  tests are NOT scaffolded — each is produced by a **test leaf** (with its
  contract) before its code leaf runs (see [work-contract.md](work-contract.md)
  "TDD ordering"). `verifyInputs` should cover the tests + contracts the leaves
  add.
- **Each leaf OWNS its file and CREATES it with `@@NEWFILE`.** Do NOT pre-stub a
  file a leaf will write — leaves botch `@@EDIT` on an existing stub (they drop
  imports). For the model file the smoke test imports: stub it at the bootstrap
  base, but at the leaf's apply base **remove the stub so the leaf `@@NEWFILE`s
  the real file** (see [practices.md](practices.md)).

## 4. The gate command + image (per language)

The gate runs `--network none` + read-only rootfs + a `/work-tmp` tmpfs, so the
verifyCommand must be **offline** and the gate image must bake the deps. The
loop runs TWO commands by leaf kind (work-contract "TDD ordering"): a **static
check** for test leaves and a **test run** for code leaves —

- **TS/deno:** run `TMPDIR=/work-tmp deno test --no-lock --cached-only -A`,
  check `deno check`; image `denoland/deno:<ver>` with `deno cache`d deps.
- **Rust:** run `cargo test --offline`, check `cargo check --offline`; image
  with a vendored / `CARGO_HOME`-baked registry.
- **Python:** run `pytest`, check `mypy` (or `pyright`); image with deps
  installed.

`dv verify` REQUIRES a digest-pinned image (`repo@sha256:…` — `pin_image` gives
it, §1; a tag is rejected). Its result lands in `dv`'s **`current`** resource
(`swamp data get dv current --json` → `{ exitCode, stdout, command }`), not
`result`.
