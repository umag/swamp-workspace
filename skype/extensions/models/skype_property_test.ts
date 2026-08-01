/**
 * Property-based tests (fast-check) for @magistr/skype.
 *
 * skype.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed `Deno.Command` (and,
 * for the flow test, a REAL filesystem via `Deno.makeTempDir`) and reading
 * back the written resource.
 *
 * Properties:
 *  (a) contacts round-trip — listContacts preserves every generated contact
 *      row, IN ORDER, with count == length, for any canonical (tab/newline-free)
 *      field values.
 *  (b) tsToIso validity — for any integer in (0, 4102444800], listConversations
 *      produces a valid, parseable ISO date string; for any integer <= 0 or
 *      > 4102444800, it produces "". Split per the porkbun/gonic canonical-
 *      subset precedent (there is no lossy-collapse case here — the boundary
 *      is a clean integer comparison — so this is a single two-sided
 *      property, not a split ALWAYS-TRUE/RECOVERY pair).
 *  (c) SQL single-quote-escaping invariant — for any string (canonical subset:
 *      no embedded tab/newline/CR, which would corrupt the STUBBED transport
 *      itself, not the property under test), readConversation's generated SQL
 *      contains the value with every `'` doubled, and never contains the raw
 *      un-doubled value as a substring whenever it contains at least one `'`.
 *  (d) multi-step flow: listProfiles (real fs) -> listConversations (stubbed)
 *      -> readConversation (stubbed, found case) for a randomly generated
 *      profile/identity/displayname triple.
 */
import fc from "npm:fast-check@4.8.0";
import { model } from "./skype.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  basePath: "/fixtures/skype-data",
  profile: "synthetic-user",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warn: () => {} },
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

type CommandResult = { success: boolean; stdout: string; stderr: string };
type SqlRouter = (sql: string) => CommandResult;

function installSqliteStub(router: SqlRouter) {
  const encoder = new TextEncoder();
  const calls: string[] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    #sql: string;
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      const args = options.args ?? [];
      this.#sql = args[args.length - 1] ?? "";
      calls.push(this.#sql);
    }
    output() {
      const r = router(this.#sql);
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        stdout: encoder.encode(r.stdout),
        stderr: encoder.encode(r.stderr),
      });
    }
  }
  g.Deno.Command = FakeCommand;
  return {
    calls,
    restore: () => {
      g.Deno.Command = original;
    },
  };
}

async function withSqliteStub(
  router: SqlRouter,
  fn: (stub: ReturnType<typeof installSqliteStub>) => Promise<unknown>,
) {
  const stub = installSqliteStub(router);
  try {
    await fn(stub);
  } finally {
    stub.restore();
  }
}

function byTable(
  routes: { conversations?: string; messages?: string; contacts?: string },
): SqlRouter {
  return (sql: string) => {
    if (routes.conversations !== undefined && /FROM Conversations/.test(sql)) {
      return { success: true, stdout: routes.conversations, stderr: "" };
    }
    if (routes.messages !== undefined && /FROM Messages/.test(sql)) {
      return { success: true, stdout: routes.messages, stderr: "" };
    }
    if (routes.contacts !== undefined && /FROM Contacts/.test(sql)) {
      return { success: true, stdout: routes.contacts, stderr: "" };
    }
    throw new Error(`unrouted sql: ${sql}`);
  };
}

/** Frame rows the way real `sqlite3 -ascii` does: columns joined by 0x1F
 * (unit separator), every record (including the last) terminated by 0x1E
 * (record separator). Mirrors queryDb's own parse exactly. */
function asciiTable(rows: string[][]): string {
  const US = "\x1F";
  const RS = "\x1E";
  return rows.map((r) => r.join(US) + RS).join("");
}

// ---------------------------------------------------------------------------
// (a) contacts round-trip
// ---------------------------------------------------------------------------

// Canonical field charset: no tab/newline/CR (which would corrupt the TSV
// framing itself — that corruption is what the adversarial suite pins on
// purpose), non-empty (so `|| ""` fallback never fires), and no leading/
// trailing whitespace — queryDb's `.trim()` runs on the WHOLE stdout blob
// once, so only the very first field's leading and the very last field's
// trailing whitespace are at risk of being silently stripped; restricting to
// values that already equal their own `.trim()` keeps this a clean,
// position-independent round-trip rather than an accidental partial one.
const arbField = fc.stringMatching(/^[a-zA-Z0-9 .'-]{1,20}$/).filter((s) =>
  s.length > 0 && s === s.trim()
);

const arbContactRow = fc.record({
  id: fc.integer({ min: 1, max: 999999 }),
  skypename: arbField,
  fullname: arbField,
  city: arbField,
  country: arbField,
});

function contactsTsv(rows: Array<Record<string, unknown>>): string {
  return asciiTable(
    rows.map((r) =>
      [r.id, r.skypename, r.fullname, r.city, r.country].map(String)
    ),
  );
}

Deno.test("property: listContacts preserves every generated contact row, IN ORDER, with count == length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbContactRow, { minLength: 0, maxLength: 15 }),
      async (rows) => {
        const { ctx, written } = makeCtx();
        await withSqliteStub(
          byTable({ contacts: contactsTsv(rows) }),
          () => run("listContacts", {}, ctx),
        );
        const res = written.find((w) => w.spec === "contacts")!;
        const out = res.payload.contacts as Array<Record<string, unknown>>;
        return out.length === rows.length &&
          res.payload.count === rows.length &&
          out.every((c, i) =>
            c.id === rows[i].id &&
            c.skypename === rows[i].skypename &&
            c.fullname === rows[i].fullname &&
            c.city === rows[i].city &&
            c.country === rows[i].country
          );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) tsToIso validity, pinned via listConversations
// ---------------------------------------------------------------------------

Deno.test("property: any ts in (0, 4102444800] produces a valid, parseable ISO date string", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 4102444800 }),
      async (ts) => {
        const { ctx, written } = makeCtx();
        const conversations = asciiTable([
          [
            "1",
            "live:.cid.fake0001",
            "Fixture",
            "1",
            "1",
            String(ts),
            String(ts),
          ],
        ]);
        await withSqliteStub(
          byTable({ conversations }),
          () => run("listConversations", {}, ctx),
        );
        const row =
          (written[0].payload.conversations as Array<Record<string, unknown>>)[
            0
          ];
        const s = row.firstMessage as string;
        return typeof s === "string" && s.length > 0 && !isNaN(Date.parse(s));
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: any ts <= 0 or > 4102444800 always produces ''", async () => {
  const arbOutOfRange = fc.oneof(
    fc.integer({ min: -1_000_000_000, max: 0 }),
    fc.integer({ min: 4102444801, max: 10_000_000_000 }),
  );
  await fc.assert(
    fc.asyncProperty(arbOutOfRange, async (ts) => {
      const { ctx, written } = makeCtx();
      const conversations = asciiTable([
        [
          "1",
          "live:.cid.fake0001",
          "Fixture",
          "1",
          "1",
          String(ts),
          String(ts),
        ],
      ]);
      await withSqliteStub(
        byTable({ conversations }),
        () => run("listConversations", {}, ctx),
      );
      const row =
        (written[0].payload.conversations as Array<Record<string, unknown>>)[0];
      return row.firstMessage === "" && row.lastMessage === "";
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) SQL single-quote-escaping invariant
// ---------------------------------------------------------------------------

// Canonical subset: printable ASCII, no tab/newline/CR (those would corrupt
// the STUBBED transport's own TSV/line framing, which is not what this
// property is about — that corruption is pinned deliberately in the
// adversarial suite instead).
const arbSearchTerm = fc.stringMatching(/^[ -~]{1,30}$/).filter((s) =>
  !s.includes("\t") && !s.includes("\n") && !s.includes("\r")
);

Deno.test("property: readConversation's generated SQL always doubles every single quote in the search term", async () => {
  await fc.assert(
    fc.asyncProperty(arbSearchTerm, async (term) => {
      const { ctx } = makeCtx();
      let sql = "";
      await withSqliteStub(byTable({ conversations: "" }), async (stub) => {
        try {
          await run("readConversation", { conversation: term }, ctx);
        } catch {
          // expected: not-found throw once queryDb returns []
        }
        sql = stub.calls[0];
      });
      // Extract the exact literal SQL embedded the escaped term as, by
      // anchoring on the unique "OR displayname" suffix that only ever
      // appears once — robust regardless of how many quotes `term` itself
      // contains (a naive substring-containment check is NOT robust here,
      // since an escaped '' can spuriously "contain" a shorter raw pattern).
      const m = sql.match(/identity = '([\s\S]*?)'\r?\n\s*OR displayname/);
      const expectedEscaped = term.replace(/'/g, "''");
      return m !== null && m[1] === expectedEscaped;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) Multi-step flow: listProfiles -> listConversations -> readConversation
// ---------------------------------------------------------------------------

const arbFlowInput = fc.record({
  profile: fc.stringMatching(/^[a-z][a-z0-9_-]{2,15}$/),
  identity: fc.stringMatching(/^live:\.cid\.[a-z0-9]{6,12}$/),
  // No leading/trailing whitespace — see arbField's comment above: as the
  // sole row's LAST field, a trailing space here would be silently stripped
  // by queryDb's whole-blob `.trim()`, which is a real but ORTHOGONAL
  // characteristic (not what this flow property is about).
  displayname: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{1,18}[A-Za-z0-9]$/),
});

Deno.test("property flow: listProfiles finds a real profile dir -> listConversations lists it -> readConversation resolves it by displayname", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbFlowInput,
      async ({ profile, identity, displayname }) => {
        const root = await Deno.makeTempDir();
        try {
          await Deno.mkdir(`${root}/${profile}`, { recursive: true });
          await Deno.writeTextFile(
            `${root}/${profile}/main.db`,
            "fixture-not-a-real-db",
          );
          // A sibling profile-shaped dir WITHOUT main.db must never appear.
          await Deno.mkdir(`${root}/${profile}-no-db`, { recursive: true });

          const { ctx: profilesCtx, written: profilesWritten } = makeCtx({
            basePath: root,
            profile,
          });
          await run("listProfiles", {}, profilesCtx);
          const profileNames = (
            profilesWritten[0].payload.conversations as Array<
              { identity: string }
            >
          ).map((c) => c.identity);
          if (!profileNames.includes(profile)) return false;
          if (profileNames.includes(`${profile}-no-db`)) return false;

          const conversations = asciiTable([
            ["1", identity, displayname, "1", "1", "1700000000", "1700000000"],
          ]);
          const { ctx: convCtx, written: convWritten } = makeCtx({
            basePath: root,
            profile,
          });
          await withSqliteStub(
            byTable({ conversations }),
            () => run("listConversations", {}, convCtx),
          );
          const listed = convWritten[0].payload.conversations as Array<
            { identity: string; displayname: string }
          >;
          if (listed.length !== 1 || listed[0].identity !== identity) {
            return false;
          }

          const lookupRow = asciiTable([["1", identity, displayname]]);
          const { ctx: readCtx, written: readWritten } = makeCtx({
            basePath: root,
            profile,
          });
          await withSqliteStub(
            byTable({ conversations: lookupRow, messages: "" }),
            () =>
              run("readConversation", { conversation: displayname }, readCtx),
          );
          const readRes = readWritten.find((w) => w.spec === "messages")!;
          return readRes.payload.conversation === displayname;
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      },
    ),
    { numRuns: NIGHT(50) },
  );
});
