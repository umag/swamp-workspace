// CSS byte-parity. The board + landing stylesheets are pinned to the vendored
// fixtures (extracted from the oracle in step 5). This test READS those files,
// so it needs --allow-read and lives in the separate `test:css` task; the pure
// `test` task stays flagless. If a stylesheet ever needs to change, change the
// fixture and regenerate the constant; never let them drift silently.

import { assertEquals } from "jsr:@std/assert@1";
import { BOARD_CSS } from "./board_css.ts";
import { LANDING_CSS } from "./landing_css.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`../../../fixtures/${name}`, import.meta.url));

Deno.test("BOARD_CSS equals fixtures/board_css.txt byte-for-byte", () => {
  assertEquals(BOARD_CSS, fixture("board_css.txt"));
});

Deno.test("LANDING_CSS equals fixtures/landing_css.txt byte-for-byte", () => {
  assertEquals(LANDING_CSS, fixture("landing_css.txt"));
});
