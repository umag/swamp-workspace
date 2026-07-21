/**
 * OPT-IN live test-mode e2e for the consumer buyer (Link grant) flow.
 *
 * BLOCKED for the current maintainer: Stripe Link is US-only and the maintainer
 * is in the EU, so `link-cli auth login` cannot complete. The consumer surface
 * was therefore built on the OBSERVED link-cli v0.9.0 tool contract
 * (SPIKE-link-cli.md), pinned by the fixtures in stripe_mpp_test.ts, and NOT
 * live-verified. This file is the procedure for whoever CAN run it (a US Link
 * account): a Marshland US pilot user or a US CI runner.
 *
 * It is ignored unless `LIVE_LINK_CLI=1`, so the default offline suite never
 * runs it. Enable with `deno task test:live`.
 *
 * Preconditions for a real run:
 *   1. `npm i -g @stripe/link-cli` (or install to an absolute, non-writable
 *      path) and `link-cli auth login` (US Link account, test mode).
 *   2. export LINK_CLI_PATH=/abs/path/to/link-cli
 *   3. export SPT_NETWORK_ID=profile_test_...   (a Business Network Profile)
 *   4. deno task test:live
 *
 * The run is NOT fully automated: `createSpendRequest` returns a `pending`
 * lsrq_ and a human must approve it in the Link app within ~10 minutes; the
 * test prints the id and polls `getSpendRequest`. Every contract surprise it
 * finds should be folded back into stripe_mpp_coverage_test.ts as a regression.
 */
import { assert } from "jsr:@std/assert@1";
import { model } from "./stripe_mpp.ts";

const LIVE = Deno.env.get("LIVE_LINK_CLI") === "1";

function ctx(globalArgs: Record<string, unknown>) {
  const written: Array<{ spec: string; name: string; payload: unknown }> = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({ spec, name, payload });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

Deno.test({
  name:
    "LIVE: createSpendRequest returns a pending lsrq_ against a real Link session",
  ignore: !LIVE,
  fn: async () => {
    const binPath = Deno.env.get("LINK_CLI_PATH");
    const networkId = Deno.env.get("SPT_NETWORK_ID");
    assert(binPath, "set LINK_CLI_PATH to the absolute link-cli path");
    assert(networkId, "set SPT_NETWORK_ID to a profile_test_ id");

    const { ctx: c, written } = ctx({
      secretKey: "sk_test_placeholder", // not used by the consumer path
      networkId,
      linkCliPath: binPath,
      linkCliVersion: "0.9.0",
      allowLiveGrants: false, // test mode
    });

    await model.methods.createSpendRequest.execute({
      amount: "500",
      currency: "usd",
      context:
        "Live e2e smoke: authorising a $5.00 test-mode Shared Payment Token " +
        "grant from the Link wallet to exercise the consumer buyer flow.",
    }, c);

    const sr = written.find((w) => w.spec === "spendRequest");
    assert(sr, "a spendRequest resource was written");
    const payload = sr.payload as { id: string; status: string };
    assert(payload.id.startsWith("lsrq_"), "returned a real spend-request id");
    // The token is granted only after the human approves in the Link app.
    // A follow-up getSpendRequest (polled from a workflow) reaches
    // approved | denied | expired. paySpendRequest then spends it by reference.
    console.log(
      `Approve ${payload.id} in the Link app, then run getSpendRequest.`,
    );
  },
});
