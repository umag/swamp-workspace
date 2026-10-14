// Rating buttons: the "episode downloaded" notice carries Watched / 1-10
// inline buttons whose callback_data the telegram-callback workflow hands back
// to rate-episode. These pin the wire format and the AniList update rules.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRateKeyboard,
  parseEpisode,
  parseRateCallback,
  planRateUpdate,
  RATE_CALLBACK_KIND,
} from "./anime_cron.ts";

Deno.test("every button round-trips through parseRateCallback", () => {
  const kb = buildRateKeyboard(211778, 2);
  const buttons = kb.inline_keyboard.flat();
  assertEquals(buttons.length, 11);
  for (const b of buttons) {
    const colon = b.callback_data.indexOf(":");
    assertEquals(b.callback_data.slice(0, colon), RATE_CALLBACK_KIND);
    const tap = parseRateCallback(b.callback_data.slice(colon + 1));
    assertEquals([tap?.mediaId, tap?.episode], [211778, 2]);
    assertEquals(b.text, tap?.score === 0 ? "Watched" : String(tap?.score));
  }
});

Deno.test("callback_data stays within Telegram's 64-byte limit", () => {
  for (const b of buildRateKeyboard(999999999, 9999).inline_keyboard.flat()) {
    assertEquals(new TextEncoder().encode(b.callback_data).length <= 64, true);
  }
});

Deno.test("parseRateCallback rejects malformed or out-of-range taps", () => {
  for (
    const s of ["", "1:2", "a:1:2", "1:2:11", "0:1:1", "1:0:1", "1:2:3:4"]
  ) {
    assertEquals(parseRateCallback(s), null, s);
  }
});

Deno.test("planRateUpdate never moves progress backwards", () => {
  assertEquals(planRateUpdate({ progress: 9, status: "CURRENT" }, 7, 12), {
    progress: 9,
    status: null,
  });
  assertEquals(planRateUpdate({ progress: 6, status: "CURRENT" }, 7, 12), {
    progress: 7,
    status: null,
  });
});

Deno.test("planRateUpdate completes at the last episode", () => {
  assertEquals(planRateUpdate({ progress: 11, status: "CURRENT" }, 12, 12), {
    progress: 12,
    status: "COMPLETED",
  });
});

Deno.test("planRateUpdate adds a show not on the list as CURRENT", () => {
  assertEquals(planRateUpdate(null, 3, null), {
    progress: 3,
    status: "CURRENT",
  });
});

Deno.test("a season-renamed torrent still parses its episode", () => {
  assertEquals(
    parseEpisode("Kusuriya no Hitorigoto 3rd Season - 01 (1080p) [ABC].mkv"),
    1,
  );
});
