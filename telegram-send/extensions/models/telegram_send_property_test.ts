/**
 * Property-based tests (fast-check) for @magistr/telegram/send.
 *
 * telegram_send.ts is UNMODIFIED — every property here is either observed
 * directly on the exported pure helpers (isLocalPath, resolveChatId) or by
 * driving `model.methods.<m>.execute()` against a stubbed fetch and reading
 * back the captured written resource, per the approved plan.
 *
 * Properties:
 *  (a) isLocalPath invariants — http(s) URLs never local; non-http(s) +
 *      slash always local; non-http(s) + no-slash never local.
 *  (b) resolveChatId invariants — non-empty arg always wins; omitted arg
 *      falls back to any non-empty default; both absent always throws.
 *  (c) token-non-leak — for any FAKE (non-token-shaped) token and any
 *      generated API-error description/code, the thrown error message never
 *      contains the token.
 *  (d) field-mapping round-trip — sendMessage's written messageId always
 *      equals the wire message_id, for any generated id/text/date.
 *
 * fast-check is PINNED at npm:fast-check@4.8.0 (CLAUDE.md rule 7).
 * FC_NUM_RUNS-gated: small by default (200), large in the nightly soak
 * (`deno task test:soak`, FC_NUM_RUNS=10000).
 */
import fc from "npm:fast-check@4.8.0";
import { isLocalPath, model, resolveChatId } from "./telegram_send.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness (methods-execute properties only — (a)/(b) exercise the pure
// helpers directly with no fetch involved)
// ---------------------------------------------------------------------------

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(botToken: string, defaultChatId = "555000111") {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: { botToken, defaultChatId },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

function withFetchStub(
  handler: (req: Request) => Response,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return Promise.resolve(handler(req));
  }) as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// (a) isLocalPath invariants
// ---------------------------------------------------------------------------

Deno.test("property: isLocalPath — any http(s) URL is NEVER a local path, for any host/path", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("http", "https", "HTTP", "HTTPS", "HtTpS"),
      fc.stringMatching(/^[a-z0-9.-]{1,20}$/),
      fc.stringMatching(/^[a-zA-Z0-9/_.-]{0,30}$/),
      (scheme, host, path) =>
        isLocalPath(`${scheme}://${host}/${path}`) === false,
    ),
    FC_RUNS,
  );
});

Deno.test("property: isLocalPath — any non-http(s)-scheme string containing a slash IS a local path", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-zA-Z0-9_.-]{0,10}$/),
      fc.stringMatching(/^[a-zA-Z0-9_.-]{1,20}$/),
      (prefix, suffix) => {
        const s = `${prefix}/${suffix}`;
        // Belt-and-suspenders: the charsets above cannot actually produce an
        // http(s):// prefix (no colon in either generator), so this guard is
        // currently unreachable — kept defensively in case the generator's
        // charset ever widens to include ":".
        if (/^https?:\/\//i.test(s)) return true;
        return isLocalPath(s) === true;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: isLocalPath — any slash-free, non-http(s) string is NOT a local path (assumed bare file_id)", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-zA-Z0-9_.-]{0,40}$/),
      (s) => {
        // Belt-and-suspenders: the charset above cannot actually produce a
        // "/" (not in the character class), so this guard is currently
        // unreachable — kept defensively in case the generator ever widens.
        if (s.includes("/")) return true;
        return isLocalPath(s) === false;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) resolveChatId invariants
// ---------------------------------------------------------------------------

Deno.test("property: resolveChatId — any non-empty chatId arg wins, regardless of defaultChatId", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
      (chatId, defaultChatId) =>
        resolveChatId({ chatId }, { globalArgs: { defaultChatId } }) ===
          chatId,
    ),
    FC_RUNS,
  );
});

Deno.test("property: resolveChatId — chatId omitted, any non-empty defaultChatId is used verbatim", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      (defaultChatId) =>
        resolveChatId({}, { globalArgs: { defaultChatId } }) === defaultChatId,
    ),
    FC_RUNS,
  );
});

Deno.test("property: resolveChatId — both chatId and defaultChatId absent ALWAYS throws 'chatId not provided'", () => {
  fc.assert(
    fc.property(fc.constant(null), () => {
      try {
        resolveChatId({}, { globalArgs: {} });
        return false;
      } catch (err) {
        return err instanceof Error &&
          err.message.includes("chatId not provided");
      }
    }),
    { numRuns: 1 },
  );
});

// ---------------------------------------------------------------------------
// (c) token-non-leak over generated FAKE tokens + arbitrary API-error
//     descriptions/codes
// ---------------------------------------------------------------------------

// Generated tokens are letters-first with hyphens only (no digit-colon
// prefix), so they can never coincidentally match the real-token shape regex
// /\d+:[A-Za-z0-9_-]{30,}/ the adversarial suite's fixtures-secret-scan runs.
const arbFakeToken = fc.stringMatching(
  /^[A-Za-z]{6,12}-FAKE-TOKEN-[A-Za-z0-9]{6,12}$/,
);

Deno.test("property: for any FAKE token and any API-error description/code, the thrown message never contains the token", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbFakeToken,
      fc.string({ maxLength: 60 }),
      fc.integer({ min: 400, max: 599 }),
      async (fakeToken, description, code) => {
        const { ctx } = makeCtx(fakeToken);
        let threw: unknown;
        await withFetchStub(
          () => json({ ok: false, error_code: code, description }),
          async () => {
            try {
              await run("getMe", {}, ctx);
            } catch (err) {
              threw = err;
            }
          },
        );
        return threw instanceof Error && !threw.message.includes(fakeToken);
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) field-mapping round-trip — messageId === wire message_id
// ---------------------------------------------------------------------------

Deno.test("property: sendMessage's written messageId always equals the wire message_id, and the resource name is msg-<id>", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      fc.string({ maxLength: 100 }),
      fc.integer({ min: 0, max: 2_000_000_000 }),
      async (messageId, text, date) => {
        const { ctx, written } = makeCtx("FAKE-TOKEN-PROPERTY-SUITE-0000");
        await withFetchStub(
          () =>
            json({
              ok: true,
              result: {
                message_id: messageId,
                chat: { id: 555000111, type: "private" },
                date,
                text,
              },
            }),
          async () => {
            await run("sendMessage", { text }, ctx);
          },
        );
        const res = written.find((w) => w.spec === "sentMessage")!;
        return res.payload.messageId === messageId &&
          res.name === `msg-${messageId}`;
      },
    ),
    FC_RUNS,
  );
});
