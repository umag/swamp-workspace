# @magistr/olympus

Authoring harness for [Project Olympus](https://shipd.ai/quests/olympus)
challenge submissions.

A submission is five artifacts — a repo pinned to a commit, a problem
description, a test patch, a solution patch and a Dockerfile — and a long list
of rules about each one. This extension turns those rules into executable checks
and gates a state machine on them, so the expensive feedback (platform checks,
agent runs, reviewer round-trips) is spent on submissions that already clear the
documented bar.

## Model type

`@magistr/olympus/submission` — one workspace of submissions.

```yaml
globalArguments:
  path: /Users/you/olympus # contains submissions/
  dockerBin: docker # optional
  ghBin: gh # optional
  gitBin: git # optional
  buildTimeoutSeconds: 2400 # optional
  testTimeoutSeconds: 1800 # optional
```

Each submission lives in `submissions/<slug>/`:

```
submissions/frostdb-distinct/
  problem.md         the task, as a maintainer would write an issue
  test.patch         unified diff: test.sh + the new tests
  solution.patch     unified diff: the reference implementation
  Dockerfile         the environment everything runs in
  .work/             scratch clone and JUnit output (not submitted)
```

## Lifecycle

```
repo -> problem -> tests -> solution -> dockerfile -> review -> ready -> submitted
                                                                (abandon from any state)
```

`advance` re-runs every text-only validator live off disk and refuses to move
unless the current phase's gate is clean. Gates that need a clone or a container
are satisfied by a _recorded_ pass whose artifact fingerprint still matches disk
— edit an artifact after a green run and the gate reopens rather than coasting
on the stale result.

## Methods

| Method                | What it does                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                | Scaffold `submissions/`                                                                                                                                                      |
| `startSubmission`     | Create a submission and open it at the `repo` phase                                                                                                                          |
| `list`                | Inventory every submission with its phase                                                                                                                                    |
| `status`              | Current gate, blockers, artifact presence, per-check freshness, next action                                                                                                  |
| `advance`             | Move to the next phase if the gate is clean                                                                                                                                  |
| `abandon`             | Close a submission from any phase, with a reason                                                                                                                             |
| `checkRepo`           | Eligibility: public, not archived, 500+ stars, a commit in the last 12 months, permissive license, accepted language; resolves a ref to a SHA                                |
| `scanPriorArt`        | One fan-out across PRs (open, merged, closed), issues and Discussions; holds the repo gate when it returns hits (until acknowledged) or is truncated (until re-run narrower) |
| `acknowledgePriorArt` | Record a human's adjudication of the scanned hits (exact URL set); opens the gate when the scan was untruncated. Records a decision — it does not make one                   |
| `preflight`           | Every text-only validator in one pass, plus the effective-LOC count                                                                                                          |
| `checkPatches`        | Clone at the pinned commit and apply both patches                                                                                                                            |
| `localReview`         | The reviewer's loop in Docker, with `--network none`                                                                                                                         |
| `bundle`              | Assemble the four submission fields and list remaining blockers                                                                                                              |

### What `preflight` actually checks

_Problem description_ — headings, bullet lists, numbered lists and code fences
are errors (the doc asks for maintainer-style prose). Opening with a motivation
preamble, not opening with the ask, and naming source files or internal
identifiers are warnings, because the doc explicitly allows naming a detail that
is genuinely part of the contract.

_Test patch_ — `test.sh` must be added at the repo root with mode `100755`
(reviewers invoke `./test.sh`, so a non-executable harness fails the review for
the wrong reason), must handle both `base` and `new`, must honour
`--output_path`, and must not use fail-fast flags.

_Solution patch_ — flags a solution that edits the tests it is meant to pass.

_Dockerfile_ — an approved base image, `WORKDIR /app`, a final
`CMD ["/bin/bash"]`, no test invocation in any `RUN` step (line continuations
are joined first, so a test hidden behind a `\` is still caught), and a warning
when nothing is installed at build time, since the runtime container is offline.

_Leak scan_ — `olympus`, `shipd`, `quest`, `mars` and `challenge` in patch
content or patched paths. The mandated `olympus-base-*` image references in the
Dockerfile are masked before scanning, since the doc requires them.

_Effective LOC_ — added lines that actually implement the task. Blank lines,
comments, test files and generated files (lockfiles, vendored code, `.pb.go`,
`_pb2.py`) do not count, which is the arithmetic the reviewers apply.

### What `localReview` runs

1. Check out the pinned commit, `git clean -ffdx`
2. Apply `test.patch`
3. `docker build` from the submitted Dockerfile
4. `./test.sh base` with `--network none` — **must pass**
5. `./test.sh new` with `--network none` — **must fail**
6. Apply `solution.patch`, rebuild
7. `./test.sh base` — **must pass**
8. `./test.sh new` — **must pass**

Every stage reports its exit code, duration and JUnit counts, so a failure names
which of the four runs went wrong instead of just failing.

The Dockerfile is written into the scratch clone as `Dockerfile.review` and
passed with `-f`, so it never clobbers a Dockerfile the repo already has and
never appears in a patch.

## Development

```bash
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
~/.swamp/deno/deno task fmt
~/.swamp/deno/deno task lint
```

Wire into a swamp repo:

```bash
swamp extension source add /path/to/swamp-workspace/olympus
swamp model create @magistr/olympus/submission olympus
```
