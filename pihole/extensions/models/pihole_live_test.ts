// Env-gated LIVE suite for @magistr/pihole — NEVER runs by default. Exists
// so a human on the WireGuard-connected box can point this at
// the REAL aopab-local-dns instance later. Gated by LIVE_PIHOLE=1 plus
// PIHOLE_LIVE_HOST / PIHOLE_LIVE_PASSWORD in the environment (read from a
// vault by the OPERATOR at run time — never inlined here).
//
// This suite is READ-ONLY (list only) and asserts IN-MEMORY ONLY. It must
// NEVER write a file — fixture capture is exclusively the ext-canary-
// fixtures workflow's job, run separately with its own sanitizer and
// mandatory human diff-review.
//
// NON-GATING for allowlist removal: contract-fixture is already satisfied
// by pihole_dns_test.ts + the synthetic fixture suite in pihole_test.ts.
//
// This file must NEVER be run from a developer laptop against a real
// appliance — only from the WG-connected box, and only deliberately
// (`deno task test:live`).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./pihole.ts";

const LIVE_PIHOLE = Deno.env.get("LIVE_PIHOLE") === "1";

// Always-run (ungated): pins the default-off posture so a plain
// `deno task test` in ANY environment that has not explicitly opted in
// never executes the gated test below, and therefore never touches a real
// vault password.
Deno.test('LIVE_PIHOLE gate: the live suite is disabled unless LIVE_PIHOLE is exactly "1"', () => {
  const raw = Deno.env.get("LIVE_PIHOLE");
  assertEquals(LIVE_PIHOLE, raw === "1");
  if (raw !== "1") {
    assertEquals(
      LIVE_PIHOLE,
      false,
      "default posture: the live suite must stay off",
    );
  }
});

Deno.test({
  name:
    "LIVE: list against a real Pi-hole instance (read-only, in-memory assertions only)",
  ignore: !LIVE_PIHOLE,
  fn: async () => {
    const host = Deno.env.get("PIHOLE_LIVE_HOST");
    const password = Deno.env.get("PIHOLE_LIVE_PASSWORD");
    if (!host || !password) {
      throw new Error(
        "LIVE_PIHOLE=1 requires PIHOLE_LIVE_HOST and PIHOLE_LIVE_PASSWORD in the environment",
      );
    }
    const written: Array<{ spec: string; name: string; payload: unknown }> = [];
    const ctx = {
      globalArgs: { host, password, scheme: "https" as const },
      writeResource: (spec: string, name: string, payload: unknown) => {
        // In-memory only — this suite must never persist a file. Recording
        // into a local array (not Deno.writeTextFile) satisfies that.
        written.push({ spec, name, payload });
        return Promise.resolve();
      },
    };
    const method = model.methods.list;
    await method.execute(method.arguments.parse({}), ctx);
    if (written.length === 0) {
      throw new Error(
        "expected the live list method to write a dns-records resource",
      );
    }
  },
});
