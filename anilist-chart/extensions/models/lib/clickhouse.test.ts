// LIVE ClickHouse tests. Run with:  deno task test:live
// (needs --allow-net --allow-env). These are DELIBERATELY excluded from the
// pure `test` task and are NEVER wrapped in a skip-on-error: they must connect
// to the real database and go green before the render methods (step 9) are
// trusted. Where there is no reachable ClickHouse (e.g. a dev box without the
// read-only user provisioned) they FAIL loudly rather than pass silently.
//
// Configure via env: CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_KEY,
// CLICKHOUSE_DATABASE (optional, defaults to "default").

import { assert } from "jsr:@std/assert@1";
import {
  ClickHouseClient,
  configFromEnv,
  EXPECTED_METADATA_COLUMNS,
  EXPECTED_SCORE_COLUMNS,
} from "./clickhouse.ts";

Deno.test("live: ClickHouse is reachable (SELECT 1)", async () => {
  const client = new ClickHouseClient(configFromEnv());
  assert(await client.ping(), "SELECT 1 did not return a single row");
});

// The must-be-able-to-fail test: read the LIVE table shape and assert the
// columns the render code depends on are present. One side is the live DESCRIBE
// result, the other is the MEASURED expectation — a membership check, not a
// constant-vs-constant compare, so it actually detects schema drift.
Deno.test("live: anilist_metadata DESCRIBE has every measured column", async () => {
  const client = new ClickHouseClient(configFromEnv());
  const cols = await client.describeTable("anilist_metadata");
  const live = new Set(cols.map((c) => c.name));
  assert(live.size > 0, "DESCRIBE returned no columns");
  for (const expected of EXPECTED_METADATA_COLUMNS) {
    assert(
      live.has(expected),
      `anilist_metadata is missing expected column '${expected}' (live columns: ${
        [...live].join(", ")
      })`,
    );
  }
});

Deno.test("live: user_scores DESCRIBE has every measured column", async () => {
  const client = new ClickHouseClient(configFromEnv());
  const cols = await client.describeTable("user_scores");
  const live = new Set(cols.map((c) => c.name));
  for (const expected of EXPECTED_SCORE_COLUMNS) {
    assert(
      live.has(expected),
      `user_scores is missing expected column '${expected}' (live columns: ${
        [...live].join(", ")
      })`,
    );
  }
});
