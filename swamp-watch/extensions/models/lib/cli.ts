// Shared helpers for the @magistr/swamp-watch model.
//
// Three concerns live here, each independently testable without spawning a
// process or reaching a network:
//
//   1. `CommandRunner` — the injectable process runner. Production passes
//      `defaultRunner`; tests pass a scripted fake. See the repo convention in
//      herdr/extensions/models/lib/cli.ts.
//   2. Cron arithmetic — turning a `trigger.schedule` into the LONGEST gap the
//      schedule can produce, which is what a staleness budget must be built on.
//      `0 9,20 * * *` fires twice a day but its worst-case gap is 13h, not 12h.
//   3. Prometheus exposition — label escaping and line assembly for
//      `@magistr/victoriametrics` `push`.

/** Options accepted by a {@link CommandRunner}. */
export interface RunOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** The outcome of one child process. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * The injectable process runner. Production code passes {@link defaultRunner};
 * tests pass a scripted fake so no `swamp` binary is ever spawned.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: RunOptions,
) => Promise<RunResult>;

/** The default {@link CommandRunner}, backed by `Deno.Command`. */
export const defaultRunner: CommandRunner = async (cmd, args, opts = {}) => {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 0;
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  try {
    const child = new Deno.Command(cmd, {
      args,
      env: opts.env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();
    const { code, stdout, stderr } = await child.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      timedOut: controller.signal.aborted,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Raised when the `swamp` CLI fails or answers with something unparseable. */
export class SwampWatchError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "SwampWatchError";
  }
}

// --- swamp CLI ---------------------------------------------------------------

/**
 * Run `swamp <args> --json` and parse stdout.
 *
 * swamp writes source/loader warnings to STDERR and JSON to STDOUT, so stdout
 * is parsed on its own. A non-zero exit is still parsed first: several swamp
 * subcommands report structured errors as `{"error": "..."}` on stdout with a
 * non-zero code, and that message is far more useful than the exit status.
 */
export async function swampJson(
  run: CommandRunner,
  binary: string,
  args: string[],
  opts: RunOptions = {},
): Promise<unknown> {
  const res = await run(binary, args, opts);
  const out = res.stdout.trim();
  if (out.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new SwampWatchError(
        `swamp ${args.join(" ")} produced unparseable JSON`,
        out.slice(0, 400),
      );
    }
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof (parsed as { error?: unknown }).error === "string"
    ) {
      throw new SwampWatchError(
        `swamp ${args.join(" ")} failed: ${
          (parsed as { error: string }).error
        }`,
      );
    }
    return parsed;
  }
  throw new SwampWatchError(
    `swamp ${args.join(" ")} exited ${res.code} with no stdout`,
    res.stderr.trim().slice(0, 400),
  );
}

// --- cron --------------------------------------------------------------------

const FIELD_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (7 normalised to 0)
];

/**
 * Expand one cron field into the set of values it matches.
 * Supports star, `a`, `a-b`, `a-b/n`, star-slash-n, and comma lists of those.
 */
export function expandField(
  field: string,
  min: number,
  max: number,
  normaliseDow = false,
): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const piece = part.trim();
    if (piece === "") throw new SwampWatchError(`empty cron field part`);
    const [rangePart, stepPart] = piece.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new SwampWatchError(`bad cron step in "${piece}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new SwampWatchError(`bad cron value in "${piece}"`);
    }
    if (normaliseDow) {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
      if (hi < lo) hi = lo;
    }
    if (lo < min || hi > max || hi < lo) {
      throw new SwampWatchError(
        `cron value out of range in "${piece}" (${min}-${max})`,
      );
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new SwampWatchError(`cron field matched nothing`);
  return out;
}

/** A parsed 5-field cron expression. */
export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse a standard 5-field cron expression. Throws on anything else. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new SwampWatchError(
      `unsupported cron "${expr}": expected 5 fields, got ${fields.length}`,
    );
  }
  const sets = fields.map((f, i) =>
    expandField(f, FIELD_BOUNDS[i][0], FIELD_BOUNDS[i][1], i === 4)
  );
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

/**
 * Does `date` (UTC) match the cron?
 *
 * Standard Vixie-cron semantics: when BOTH day-of-month and day-of-week are
 * restricted the two are ORed, not ANDed. `0 0 1 * 0` means "the 1st, and every
 * Sunday" — getting this wrong makes a schedule look far rarer than it is and
 * inflates the staleness budget.
 */
export function cronMatches(c: ParsedCron, date: Date): boolean {
  if (!c.minute.has(date.getUTCMinutes())) return false;
  if (!c.hour.has(date.getUTCHours())) return false;
  if (!c.month.has(date.getUTCMonth() + 1)) return false;
  const domHit = c.dom.has(date.getUTCDate());
  const dowHit = c.dow.has(date.getUTCDay());
  if (c.domRestricted && c.dowRestricted) return domHit || dowHit;
  if (c.domRestricted) return domHit;
  if (c.dowRestricted) return dowHit;
  return true;
}

/** How far ahead {@link maxGapSeconds} walks looking for consecutive fires. */
export const CRON_HORIZON_DAYS = 400;

/**
 * The LONGEST interval, in seconds, between two consecutive fires of `expr`.
 *
 * This is the number a staleness budget must be built on: a schedule with
 * uneven spacing (`0 9,20 * * *`, gaps of 11h then 13h) is only "late" once the
 * biggest legal gap has passed. Using the average would page every night.
 *
 * Walks minute by minute from a fixed reference instant so the answer is
 * deterministic and never depends on when the scan ran. Returns null when the
 * horizon contains fewer than two fires (i.e. rarer than roughly yearly).
 */
export function maxGapSeconds(expr: string): number | null {
  const c = parseCron(expr);
  const start = Date.UTC(2027, 0, 1, 0, 0, 0);
  const horizonMinutes = CRON_HORIZON_DAYS * 24 * 60;
  let prev: number | null = null;
  let worst = 0;
  let fires = 0;
  const cursor = new Date(start);
  for (let i = 0; i < horizonMinutes; i++) {
    cursor.setTime(start + i * 60_000);
    if (!cronMatches(c, cursor)) continue;
    fires++;
    const t = cursor.getTime();
    if (prev !== null) worst = Math.max(worst, (t - prev) / 1000);
    prev = t;
  }
  if (fires < 2) return null;
  return worst;
}

/**
 * The age at which a workflow's last success counts as stale.
 *
 * One full period plus a grace band, rather than a flat multiple: a
 * two-minute workflow needs enough slack to survive scan jitter, and a monthly one must
 * not need three months of silence before anyone is told.
 */
export function staleAfterSeconds(
  periodSeconds: number,
  graceFactor: number,
  minGraceSeconds: number,
): number {
  const grace = Math.max(periodSeconds * graceFactor, minGraceSeconds);
  return Math.round(periodSeconds + grace);
}

// --- prometheus exposition ---------------------------------------------------

/** Escape a label VALUE per the Prometheus exposition format. */
export function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/** Render one exposition line: `name{k="v",...} value`. */
export function metricLine(
  name: string,
  labels: Record<string, string>,
  value: number,
): string {
  const entries = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`);
  const suffix = entries.length > 0 ? `{${entries.join(",")}}` : "";
  return `${name}${suffix} ${value}`;
}

/** Seconds since the unix epoch for an ISO timestamp, or 0 when unparseable. */
export function isoToUnixSeconds(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.floor(ms / 1000);
}

/**
 * Map over `items` with at most `limit` in flight, preserving input order.
 *
 * Probing a server once per declared workflow is unavoidable — `workflow list`
 * has no `--server` — so the probe has to be concurrent to finish in a sane
 * time. The limit is deliberately low: this server starts refusing auth on
 * roughly a dozen simultaneous connections, and a refused probe looks exactly
 * like a missing workflow unless it is classified apart.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Injectable delay, so retry backoff is testable without real waiting. */
export type Sleeper = (ms: number) => Promise<void>;

/** The default {@link Sleeper}. */
export const defaultSleep: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extract a top-level `trigger.schedule` from a workflow YAML document.
 *
 * Needed because `trigger` is not exposed by every swamp build: 20260815
 * returns it from neither `workflow list --json` nor `workflow get --json`,
 * even though the same binary reads the file and registers the schedule. The
 * file is the one source that does not depend on the CLI's version.
 *
 * Deliberately narrow rather than a full YAML parse: it only accepts a
 * `schedule:` that is indented directly under a COLUMN-ZERO `trigger:`, so a
 * `schedule:` line appearing inside a description block scalar — which these
 * workflows do contain — cannot be mistaken for the real one.
 */
export function scheduleFromWorkflowYaml(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^trigger:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") continue;
      // Dedent back to column zero ends the trigger block.
      if (!/^\s/.test(line)) break;
      const m = line.match(/^\s+schedule:\s*(.+?)\s*$/);
      if (!m) continue;
      let value = m[1];
      const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
      if (quoted) value = quoted[1];
      return value.length > 0 ? value : null;
    }
    return null;
  }
  return null;
}

/** Extract the top-level `name:` from a workflow YAML document. */
export function nameFromWorkflowYaml(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = line.match(/^name:\s*(.+?)\s*$/);
    if (!m) continue;
    let value = m[1];
    const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
    if (quoted) value = quoted[1];
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Minimal filesystem surface needed to read workflow definitions. */
export interface FsReader {
  readDir: (path: string) => AsyncIterable<{ name: string; isFile: boolean }>;
  readTextFile: (path: string) => Promise<string>;
}

/** The default {@link FsReader}, backed by Deno. */
export const defaultFs: FsReader = {
  readDir: (path) => Deno.readDir(path),
  readTextFile: (path) => Deno.readTextFile(path),
};

/**
 * Map workflow name to declared schedule by reading `<repoDir>/workflows`.
 *
 * The fallback for builds whose CLI does not expose `trigger`. Returns an empty
 * map when the directory cannot be read — a repo laid out differently should
 * degrade to whatever the CLI reported, not fail the whole scan.
 */
export async function readSchedulesFromDisk(
  fs: FsReader,
  repoDir: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = `${repoDir.replace(/\/+$/, "")}/workflows`;
  const entries: Array<{ name: string; isFile: boolean }> = [];
  try {
    for await (const e of fs.readDir(dir)) entries.push(e);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (!/\.ya?ml$/i.test(entry.name)) continue;
    let text: string;
    try {
      text = await fs.readTextFile(`${dir}/${entry.name}`);
    } catch {
      continue;
    }
    const name = nameFromWorkflowYaml(text);
    if (name === null) continue;
    const schedule = scheduleFromWorkflowYaml(text);
    if (schedule !== null) out.set(name, schedule);
  }
  return out;
}
