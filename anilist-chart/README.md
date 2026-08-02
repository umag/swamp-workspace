# @magistr/anilist-chart

Read-only render layer for the AniList chat statistics site — a faithful swamp
port of the legacy Python (`generate_board.py`, `generate_landing.py`,
`anilist_chart*.py`).

It reads two ClickHouse tables written by the `@anilist/api` ingest model —
`anilist_metadata` and `user_scores` — and produces the six static pages:

- `/board` — «Доска почёта», 15 awards + genre keepers + two pairs
- `/anime` — the landing that fronts all five stat pages
- `/chart`, `/current`, `/fresh`, `/bayes` — the four genre charts

The render boundary is strictly **read-only**: the worst failure is a
stale-looking page for a week, fixable by re-running. Writes (ingest) live in
`@anilist/api`, under a separate ClickHouse user.

## Layout

```
extensions/models/
  anilist_chart.ts        model entry (methods, resources)
  lib/
    clickhouse.ts         read-only HTTP ClickHouse client
    format.ts             ru_plural, fmt_int/dec/signed/score, esc, RU_WORDS
    rankable.ts           per-user stats, pickOrSkip, finite guards, CURATED
    awards.ts             the 15 board awards + genre keepers
    pairs.ts              the two correlation pairs
    chart_rank.ts         the three ranking rules + build_final_chart_data
    bayesian.ts           IMDB-style Bayesian rating
    age_penalty.ts        per-season age penalty factor
fixtures/                 vendored BOARD_CSS / LANDING_CSS for byte-parity tests
```

## Tasks

- `deno task test` — the pure library suite (no network, no env)
- `deno task test:live` — the ClickHouse column-parity + round-trip suite
  (`--allow-net --allow-env`), run only where the live DB is reachable
- `deno task check` / `deno task fmt` / `deno task lint`

## Ranking rules (why three)

Python's `list.sort()` is stable, so the **last** sort key is primary:

| Chart   | Primary        | Secondary  |
| ------- | -------------- | ---------- |
| chart   | votes desc     | avg desc   |
| current | votes desc     | avg desc   |
| fresh   | penalized desc | votes desc |
| bayes   | bayesian desc  | votes desc |

`age_penalty.py:258`'s "primarily by votes" comment is false — the code inverts
it. See `lib/chart_rank.ts`.

## Architecture — data flow through the three methods

The model exposes exactly three methods, always run in this order (a swamp
workflow, not something this model schedules itself):

```
settings  — echo resolved config (topK, bayesMinVotes, penaltyRate, whether
            ClickHouse is configured); makes no external calls.

render    — ClickHouseClient.query() x11 (one fetch, POST, SQL-in-body,
            FORMAT JSONEachRow) reads board rows, chart scores, distinct
            media_ids, chart metadata, and six landing aggregates, THEN a
            freshness-gate check, THEN buildRenderTasks -> runFanOut renders
            all 7 artifacts (board, landing, chart, fresh, bayes, bayes-json,
            current) and passes each through the publish_gate backstop before
            writing it as a `renderedPage` resource. One failing/refused page
            never suppresses the rest.

publish   — reads back the `renderedPage` artifacts by key and writes them to
            the serving node: a REAL filesystem write (Deno.stat sees a local
            directory -> atomic temp-file + rename) when the output dir is on
            this host, else one `ssh` subprocess per page (Deno.Command,
            stdin-piped). One failing page never suppresses the rest, but the
            method as a whole throws if ANY page failed to write, or if zero
            pages published — a partial publish must surface as a failed
            workflow step, never a silent success.
```

The **only** two IO seams in the whole model: `fetch` once (ClickHouse HTTP,
`lib/clickhouse.ts` — param-bound, `AbortSignal.timeout(30_000)`, response body
capped by `clickhouseMaxResponseBytes`) and `Deno.Command` once (the ssh publish
fallback, `anilist_chart.ts` — bounded by `sshTimeoutMs` via `AbortController`).
Everything else — the awards/pairs/bayesian/age-penalty math and all four render
templates — is pure, dependency-injected, and unit-tested without network or
filesystem access (`deno task test`).

Example: driving a render manually against a configured instance —

```bash
swamp model method run render my-anilist-chart --input topK=13 --json
swamp data get my-anilist-chart render-run --json
```

## Known latent bugs — Fixed in 2026.08.02.1

Seven LOW/MEDIUM-severity gaps (0 CRITICAL/HIGH), tracked in the LOCAL
`anilist-chart-latent-bugs` issue-lifecycle model (never the swamp.club Lab —
this is a `@magistr/*` extension, not a swamp-product issue), are ALL FIXED as
of `2026.08.02.1`: a read-phase ClickHouse failure now leaves a diagnostic
`renderRun` marker before re-throwing (LB1); the ssh publish spawn is now
bounded by an `AbortController` timeout (LB2, new `sshTimeoutMs` global arg);
the ClickHouse client now caps response bytes on a streamed read instead of
buffering unbounded (LB3, new `clickhouseMaxResponseBytes` global arg); a
malformed freshness timestamp now surfaces an explicit "unparseable" anomaly
instead of a silent gap (LB4); a non-numeric `media_id` is now filtered before
it can ever poison the metadata read (LB5); a ClickHouse error's response body
is now trimmed and redacted before it reaches the thrown error (LB6, the
credential itself never appeared even before this fix); and `arrayStringParam`
now escapes an embedded NUL byte (LB7). See `CHANGELOG.md` for the full per-bug
writeup, the two new DEFAULTED global args, and the defended-negative behavior
(HTML/CSS/SQL injection resistance) that the same suite pins as already correct.
