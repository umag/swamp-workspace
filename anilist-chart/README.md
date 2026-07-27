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
