// Property-based tests (fast-check) for @bad-at-naming/libvirt's pure
// lib/connection.ts and lib/parse.ts functions — the formal invariants
// behind the example-based guards pinned in libvirt_connection_test.ts,
// libvirt_idempotency_test.ts, and libvirt_adversarial_test.ts. No I/O, no
// Deno.Command stub needed.
//
// Invariants under test:
//  - shellQuote is injection-safe and round-trips for any string (unquoting
//    its own output always recovers the original, single, token)
//  - buildInvocation's token-count property, phrased PER TRANSPORT: local
//    mode is 1:1 (every original argv element survives as exactly one args
//    element); SSH mode collapses the ENTIRE subcommand into one shell-
//    quoted remote string, regardless of how many argv elements went in
//  - redactSecrets is idempotent and total for any graphics passwd value,
//    and never touches the non-secret passwdValidTo timestamp
//  - isIdempotent stays false for arbitrary unrelated errors against every
//    anchored IDEMPOTENT_ERRORS set
//  - parseVmList / parseKV round-trip synthetic rows and never throw on
//    arbitrary input
//
// FC_NUM_RUNS overrides the run count for a larger nightly soak (see
// libvirt/deno.json's test:soak task).

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import fc from "npm:fast-check@4.8.0";
import {
  buildInvocation,
  IDEMPOTENT_ERRORS,
  includesAny,
  isIdempotent,
  redactSecrets,
  shellQuote,
  uriFlag,
} from "./lib/connection.ts";
import { parseKV, parseVmList } from "./lib/parse.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Reverse of shellQuote, test-only: parse a SINGLE POSIX single-quoted token
// back to its original string. Used only to state the round-trip property —
// the source itself never needs to unquote.
// ---------------------------------------------------------------------------

function unquoteOne(s: string): string {
  if (s[0] !== "'") throw new Error(`not a quoted token: ${JSON.stringify(s)}`);
  let i = 1;
  let tok = "";
  while (i < s.length) {
    if (s[i] === "'") {
      if (s.slice(i, i + 4) === "'\\''") {
        tok += "'";
        i += 4;
        continue;
      }
      i++;
      if (i !== s.length) {
        throw new Error(`trailing content after closing quote: ${s.slice(i)}`);
      }
      return tok;
    }
    tok += s[i];
    i++;
  }
  throw new Error(`unterminated quoted token: ${JSON.stringify(s)}`);
}

// ---------------------------------------------------------------------------
// shellQuote: injection-safety + round-trip
// ---------------------------------------------------------------------------

Deno.test("property: shellQuote round-trips for any string (unquoting recovers exactly the original)", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      return unquoteOne(shellQuote(s)) === s;
    }),
    FC_RUNS,
  );
});

Deno.test("property: shellQuote always wraps in a single leading/trailing quote, for any string", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const q = shellQuote(s);
      return q.startsWith("'") && q.endsWith("'") && q.length >= 2;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// buildInvocation: PER-TRANSPORT token-count property
// ---------------------------------------------------------------------------

const arbArgvElement = fc.string({ minLength: 0, maxLength: 24 });
const arbArgv = fc.array(arbArgvElement, { minLength: 1, maxLength: 6 });

Deno.test("property: buildInvocation LOCAL mode is 1:1 — every argv element survives as exactly one args element", () => {
  fc.assert(
    fc.property(arbArgv, (argv) => {
      const conn = {};
      const inv = buildInvocation(conn, argv);
      const prefixLen = uriFlag(conn).length;
      const tail = inv.args.slice(prefixLen);
      return (
        inv.command === "virsh" &&
        tail.length === argv.length &&
        tail.every((v, i) => v === argv[i])
      );
    }),
    FC_RUNS,
  );
});

Deno.test("property: buildInvocation SSH mode collapses the whole subcommand into ONE trailing string — the args array length never grows with argv length", () => {
  fc.assert(
    fc.property(arbArgv, (argv) => {
      const conn = { host: "h" };
      const inv = buildInvocation(conn, argv);
      const remote = inv.args[inv.args.length - 1];
      // Exactly SSH_OPTS(6) + [target, remote] regardless of how long argv
      // is — the whole subcommand is ONE trailing string, never N elements.
      return (
        inv.command === "ssh" &&
        typeof remote === "string" &&
        inv.args.length === 8
      );
    }),
    FC_RUNS,
  );
});

Deno.test("property: buildInvocation SSH mode's remote string recovers every original argv element via unquoting, in order", () => {
  fc.assert(
    fc.property(arbArgv, (argv) => {
      const conn = { host: "h" };
      const inv = buildInvocation(conn, argv);
      const remote = inv.args[inv.args.length - 1];
      // remote = "'virsh' '<uriFlag...>' '<argv[0]>' '<argv[1]>' ..."
      // Walk the remote string one quoted token at a time (mirrors
      // unquoteOne's escape handling) rather than a naive space-split, since
      // a generated argv element may itself contain a space.
      const recovered: string[] = [];
      let i = 0;
      while (i < remote.length) {
        if (remote[i] === " ") {
          i++;
          continue;
        }
        let j = i + 1;
        let tok = "";
        while (j < remote.length) {
          if (remote[j] === "'") {
            if (remote.slice(j, j + 4) === "'\\''") {
              tok += "'";
              j += 4;
              continue;
            }
            j++;
            break;
          }
          tok += remote[j];
          j++;
        }
        recovered.push(tok);
        i = j;
      }
      const prefixLen = 1 + uriFlag(conn).length; // "virsh" + optional -c uri
      const tail = recovered.slice(prefixLen);
      return (
        tail.length === argv.length &&
        tail.every((v, idx) => v === argv[idx])
      );
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// redactSecrets: idempotence, totality, and passwdValidTo is never touched
// ---------------------------------------------------------------------------

const arbSecret = fc.string({ minLength: 1, maxLength: 40 }).filter(
  (s) => !s.includes("'") && !s.includes('"') && s.length > 0,
);

// `before`/`after` deliberately exclude another "passwd=" marker: the
// regex's own non-greedy same-quote-closing behavior means an UNCLOSED
// "passwd='" earlier in the text can consume through our target's opening
// quote — a real property of the regex, not something this property intends
// to characterize (that failure mode belongs to a targeted example test, not
// this totality property).
const arbSurroundingText = fc.string().filter((s) => !s.includes("passwd="));

Deno.test("property: redactSecrets masks every single-quoted passwd= occurrence, for any secret value", () => {
  fc.assert(
    fc.property(
      arbSecret,
      arbSurroundingText,
      arbSurroundingText,
      (secret, before, after) => {
        const xml = `${before}<graphics passwd='${secret}'/>${after}`;
        const redacted = redactSecrets(xml);
        return !redacted.includes(`passwd='${secret}'`) &&
          redacted.includes("passwd='***'");
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: redactSecrets is idempotent — re-redacting an already-redacted string changes nothing", () => {
  fc.assert(
    fc.property(arbSecret, (secret) => {
      const xml = `<graphics passwd='${secret}'/>`;
      const once = redactSecrets(xml);
      return redactSecrets(once) === once;
    }),
    FC_RUNS,
  );
});

Deno.test("property: redactSecrets never touches passwdValidTo, for any timestamp-shaped value", () => {
  fc.assert(
    fc.property(
      arbSecret,
      fc.string({ minLength: 1, maxLength: 40 }).filter((s) =>
        !s.includes("'") && !s.includes('"')
      ),
      (secret, validTo) => {
        const xml = `<graphics passwd='${secret}' passwdValidTo='${validTo}'/>`;
        const redacted = redactSecrets(xml);
        return redacted.includes(`passwdValidTo='${validTo}'`);
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: redactSecrets is a no-op for arbitrary text containing no passwd= marker", () => {
  fc.assert(
    fc.property(
      fc.string().filter((s) => !s.includes("passwd=")),
      (text) => redactSecrets(text) === text,
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// isIdempotent: stays false for arbitrary unrelated errors, for every
// anchored IDEMPOTENT_ERRORS set.
// ---------------------------------------------------------------------------

const ALL_NEEDLES = Object.values(IDEMPOTENT_ERRORS).flat();

const arbUnrelatedError = fc.string({ minLength: 1, maxLength: 80 }).filter(
  (s) => !ALL_NEEDLES.some((needle) => s.includes(needle)),
);

Deno.test("property: isIdempotent stays false for arbitrary text containing none of the anchored needles, against every IDEMPOTENT_ERRORS set", () => {
  fc.assert(
    fc.property(arbUnrelatedError, arbUnrelatedError, (stderr, stdout) => {
      return Object.values(IDEMPOTENT_ERRORS).every(
        (needles) =>
          isIdempotent({ code: 1, stdout, stderr }, needles) === false,
      );
    }),
    FC_RUNS,
  );
});

Deno.test("property: includesAny is total — never throws for arbitrary haystack/needle-set combinations", () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.array(fc.string(), { maxLength: 5 }),
      (haystack, needles) => {
        includesAny(haystack, needles);
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// parseVmList / parseKV: round-trip synthetic rows, never throw
// ---------------------------------------------------------------------------

const VM_STATES = [
  "running",
  "idle",
  "paused",
  "in shutdown",
  "shut off",
  "crashed",
  "pmsuspended",
] as const;

// A domain name that cannot itself be mistaken for (or end with) a state
// string, and contains no newline/leading-digit-id ambiguity. Includes
// space-containing names (fc.oneof joining 1-3 word tokens) since the parser
// explicitly supports them — mirrored from the "my idle vm" example already
// pinned in libvirt_parse_test.ts, generalized here as a property.
const arbVmNameWord = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/);
const arbVmName = fc.oneof(
  arbVmNameWord,
  fc.tuple(arbVmNameWord, arbVmNameWord).map(([a, b]) => `${a} ${b}`),
  fc.tuple(arbVmNameWord, arbVmNameWord, arbVmNameWord).map(
    ([a, b, c]) => `${a} ${b} ${c}`,
  ),
).filter((s) => !VM_STATES.some((state) => s.endsWith(state)));

const arbVmRow = fc.record({
  id: fc.oneof(fc.nat(999).map(String), fc.constant("-")),
  name: arbVmName,
  state: fc.constantFrom(...VM_STATES),
});

function renderVmListTable(
  rows: { id: string; name: string; state: string }[],
): string {
  const header = " Id   Name   State\n----------------------------------\n";
  const body = rows.map((r) => ` ${r.id}    ${r.name}      ${r.state}`).join(
    "\n",
  );
  return header + body;
}

Deno.test("property: parseVmList round-trips synthetic id/name/state rows", () => {
  fc.assert(
    fc.property(fc.array(arbVmRow, { minLength: 1, maxLength: 8 }), (rows) => {
      const table = renderVmListTable(rows);
      const parsed = parseVmList(table);
      return (
        parsed.length === rows.length &&
        parsed.every((p, i) =>
          p.name === rows[i].name && p.state === rows[i].state
        )
      );
    }),
    FC_RUNS,
  );
});

Deno.test("property: parseVmList never throws on arbitrary text", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      parseVmList(text);
      return true;
    }),
    FC_RUNS,
  );
});

const arbKvKey = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ()]{0,20}$/).filter(
  (s) => !s.includes(":") && s.trim().length > 0,
);
const arbKvValue = fc.string({ maxLength: 30 }).filter((s) =>
  !s.includes("\n")
);

Deno.test("property: parseKV round-trips synthetic `Key: value` lines", () => {
  fc.assert(
    fc.property(
      // Keys must be unique (post-trim) — parseKV keeps the LAST occurrence
      // of a repeated key, by design (later lines override earlier ones), so
      // a generated duplicate key is not a round-trip counterexample.
      fc.uniqueArray(fc.tuple(arbKvKey, arbKvValue), {
        selector: ([k]) => k.trim(),
        minLength: 1,
        maxLength: 8,
      }),
      (pairs) => {
        const text = pairs.map(([k, v]) => `${k}: ${v}`).join("\n");
        const parsed = parseKV(text);
        return pairs.every(([k, v]) => parsed[k.trim()] === v.trim());
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: parseKV never throws on arbitrary text", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      parseKV(text);
      return true;
    }),
    FC_RUNS,
  );
});

// Explicit sanity pin: the property harness itself runs (guards against a
// silently-vacuous fc.assert due to a misconfigured arbitrary).
Deno.test("property harness sanity: FC_RUNS resolves to a positive integer", () => {
  assertEquals(Number.isInteger(FC_RUNS.numRuns) && FC_RUNS.numRuns > 0, true);
});

Deno.test("property harness sanity: fc.assert actually invokes the predicate (a broken filter can never satisfy minLength and would time out/throw instead of silently passing 0 runs)", () => {
  let invocations = 0;
  fc.assert(
    fc.property(fc.integer(), (n) => {
      invocations++;
      return typeof n === "number";
    }),
    FC_RUNS,
  );
  assert(invocations > 0, "fc.assert must actually invoke the predicate");
});
