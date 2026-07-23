// Flipper Snake survival bot (v2 — whole-map planning).
//
// Strategy:
//   1. Track the ORDERED body (head..tail) so we know where the tail is and
//      when it vacates.
//   2. BFS a shortest path head -> food over free cells.
//   3. Only take it if, after simulating the whole path (including the growth
//      from eating), the snake can STILL reach its own tail. That single
//      invariant is what prevents coiling into a closed loop.
//   4. Otherwise: survival mode — chase the tail (provably safe follow), else
//      the move with the largest reachable area.
//
// Run: ~/.swamp/deno/deno run --allow-all snake_bot.ts [seconds]

const PORT = Deno.args[1] || "/dev/cu.usbmodemflip_Zilxi1";
const SNAKE = Deno.args[2] || "/ext/apps/Games/snake_game.fap";
const RUN_MS = (Number(Deno.args[0]) || 30) * 1000;
// Long runs: render the board rarely, but always report mode switches.
const LOG_MS = RUN_MS > 90_000 ? 30_000 : 2_000;

const W = 128, H = 64, FBSZ = 1024;
const CELL = 4, OX = 2, OY = 2;
const COLS = 31, ROWS = 15;
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const START_STREAM = new Uint8Array([0x03, 0xa2, 0x01, 0x00]);
function inputEvent(k: number, type: number): Uint8Array {
  const m = [0xba, 0x01, 0x04, 0x08, k, 0x10, type];
  return new Uint8Array([m.length, ...m]);
}
const KEY = { UP: 0, DOWN: 1, RIGHT: 2, LEFT: 3 };
const DIRS = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
} as const;
type Dir = keyof typeof DIRS;
const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

type Cell = { c: number; r: number };
const key = (c: number, r: number) => c + "," + r;
const kOf = (x: Cell) => key(x.c, x.r);
const inBounds = (c: number, r: number) =>
  c >= 0 && c < COLS && r >= 0 && r < ROWS;

// ---------- framebuffer ----------
const pixel = (fb: Uint8Array, x: number, y: number) =>
  ((fb[(y >> 3) * W + x] >> (y & 7)) & 1) === 1;

function latestFrame(buf: Uint8Array): Uint8Array | null {
  for (let i = buf.length - (3 + FBSZ); i >= 0; i--) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x80 && buf[i + 2] === 0x08) {
      return buf.subarray(i + 3, i + 3 + FBSZ);
    }
  }
  return null;
}

// Dialog = a real BOX (two parallel long runs). A long snake is also 48px wide,
// so a single run must not count.
function hasDialog(fb: Uint8Array): boolean {
  const runs: { y: number; x0: number; x1: number }[] = [];
  for (let y = 2; y < H - 2; y++) {
    let s = -1;
    for (let x = 2; x <= W - 2; x++) {
      const on = x < W - 2 && pixel(fb, x, y);
      if (on && s < 0) s = x;
      else if (!on && s >= 0) {
        if (x - s >= 48) runs.push({ y, x0: s, x1: x - 1 });
        s = -1;
      }
    }
  }
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i], b = runs[j];
      if (
        b.y - a.y >= 15 && Math.abs(a.x0 - b.x0) <= 3 &&
        Math.abs(a.x1 - b.x1) <= 3
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseBoard(fb: Uint8Array) {
  const solid = new Set<string>();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = OX + c * CELL, cy = OY + r * CELL;
      if (pixel(fb, cx + 1, cy + 1) && pixel(fb, cx + 2, cy + 2)) {
        solid.add(key(c, r));
      }
    }
  }
  let fx = 0, fy = 0, fn = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!pixel(fb, x, y)) continue;
      const c = Math.floor((x - OX) / CELL), r = Math.floor((y - OY) / CELL);
      if (!inBounds(c, r) || solid.has(key(c, r))) continue;
      fx += x;
      fy += y;
      fn++;
    }
  }
  const dialog = hasDialog(fb);
  let food: Cell | null = null;
  if (fn > 0 && !dialog) {
    const c = Math.round((fx / fn - OX) / CELL),
      r = Math.round((fy / fn - OY) / CELL);
    if (inBounds(c, r)) food = { c, r };
  }
  return { solid, food, dialog };
}

// ---------- planning ----------
function bfsPath(from: Cell, to: Cell, blocked: Set<string>): Cell[] | null {
  const start = kOf(from), goal = kOf(to);
  if (start === goal) return [];
  const prev = new Map<string, string>();
  const seen = new Set<string>([start]);
  const q: Cell[] = [from];
  while (q.length) {
    const cur = q.shift()!;
    for (const [dc, dr] of NEIGH) {
      const nc = cur.c + dc, nr = cur.r + dr;
      if (!inBounds(nc, nr)) continue;
      const nk = key(nc, nr);
      if (seen.has(nk) || blocked.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, kOf(cur));
      if (nk === goal) {
        const path: Cell[] = [];
        let k = nk;
        while (k !== start) {
          const [c, r] = k.split(",").map(Number);
          path.unshift({ c, r });
          k = prev.get(k)!;
        }
        return path;
      }
      q.push({ c: nc, r: nr });
    }
  }
  return null;
}

// Body cells that block movement. The tail vacates as we move, so it is passable.
function blockedFrom(
  body: Cell[],
  opts: { freeTail: boolean; freeHead: boolean },
): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < body.length; i++) {
    if (opts.freeHead && i === 0) continue;
    if (opts.freeTail && i === body.length - 1) continue;
    s.add(kOf(body[i]));
  }
  return s;
}

// Advance the body along a path; it grows on the final step if it eats.
function simulate(body: Cell[], path: Cell[], eatsAtEnd: boolean): Cell[] {
  const b = body.map((x) => ({ ...x }));
  for (let i = 0; i < path.length; i++) {
    b.unshift({ ...path[i] });
    if (!(eatsAtEnd && i === path.length - 1)) b.pop();
  }
  return b;
}

// The safety invariant: from the head, can we still route to our own tail?
function tailReachable(body: Cell[]): boolean {
  if (body.length < 3) return true;
  const head = body[0], tail = body[body.length - 1];
  const blocked = blockedFrom(body, { freeTail: true, freeHead: true });
  return bfsPath(head, tail, blocked) !== null;
}

function areaFrom(start: Cell, blocked: Set<string>): number {
  if (blocked.has(kOf(start)) || !inBounds(start.c, start.r)) return 0;
  const seen = new Set([kOf(start)]);
  const st = [start];
  let n = 0;
  while (st.length) {
    const cur = st.pop()!;
    n++;
    for (const [dc, dr] of NEIGH) {
      const nc = cur.c + dc, nr = cur.r + dr, nk = key(nc, nr);
      if (!inBounds(nc, nr) || blocked.has(nk) || seen.has(nk)) continue;
      seen.add(nk);
      st.push({ c: nc, r: nr });
    }
  }
  return n;
}

function dirBetween(a: Cell, b: Cell): Dir | null {
  const dc = b.c - a.c, dr = b.r - a.r;
  for (const d of Object.keys(DIRS) as Dir[]) {
    if (DIRS[d][0] === dc && DIRS[d][1] === dr) return d;
  }
  return null;
}

function decide(
  body: Cell[],
  food: Cell | null,
): { dir: Dir | null; why: string } {
  const head = body[0];

  // 1) Path to food — but only if we can still reach our tail afterwards.
  if (food && !body.some((b) => b.c === food.c && b.r === food.r)) {
    const blocked = blockedFrom(body, { freeTail: true, freeHead: true });
    const path = bfsPath(head, food, blocked);
    if (path && path.length > 0) {
      const after = simulate(body, path, true);
      if (tailReachable(after)) {
        const d = dirBetween(head, path[0]);
        if (d) return { dir: d, why: "food" };
      }
    }
  }

  // 2) Survival: follow our own tail (keeps the loop open).
  if (body.length >= 3) {
    const tail = body[body.length - 1];
    const blocked = blockedFrom(body, { freeTail: true, freeHead: true });
    const tpath = bfsPath(head, tail, blocked);
    if (tpath && tpath.length > 0) {
      const step = tpath[0];
      const after = simulate(body, [step], false);
      if (tailReachable(after)) {
        const d = dirBetween(head, step);
        if (d) return { dir: d, why: "tail" };
      }
    }
  }

  // 3) Last resort: biggest reachable area, tail-safe if possible.
  const blocked = blockedFrom(body, { freeTail: true, freeHead: true });
  const cands: { dir: Dir; area: number; safe: boolean }[] = [];
  for (const d of Object.keys(DIRS) as Dir[]) {
    const nc = head.c + DIRS[d][0], nr = head.r + DIRS[d][1];
    if (!inBounds(nc, nr) || blocked.has(key(nc, nr))) continue;
    const after = simulate(body, [{ c: nc, r: nr }], false);
    cands.push({
      dir: d,
      area: areaFrom({ c: nc, r: nr }, blocked),
      safe: tailReachable(after),
    });
  }
  if (cands.length === 0) return { dir: null, why: "trapped" };
  cands.sort((a, b) => (b.safe ? 1 : 0) - (a.safe ? 1 : 0) || b.area - a.area);
  return { dir: cands[0].dir, why: cands[0].safe ? "space" : "desperate" };
}

// ---------- body tracking ----------
function traceBody(head: Cell, solid: Set<string>): Cell[] {
  const b: Cell[] = [head];
  const seen = new Set([kOf(head)]);
  let cur = head;
  for (;;) {
    let next: Cell | null = null;
    for (const [dc, dr] of NEIGH) {
      const nc = cur.c + dc, nr = cur.r + dr, nk = key(nc, nr);
      if (solid.has(nk) && !seen.has(nk)) {
        next = { c: nc, r: nr };
        break;
      }
    }
    if (!next) break;
    seen.add(kOf(next));
    b.push(next);
    cur = next;
  }
  return b;
}

function renderGrid(
  solid: Set<string>,
  body: Cell[],
  food: Cell | null,
): string {
  const head = body[0], tail = body[body.length - 1];
  let s = "";
  for (let r = 0; r < ROWS; r++) {
    let line = "";
    for (let c = 0; c < COLS; c++) {
      if (head && head.c === c && head.r === r) line += "@";
      else if (tail && tail.c === c && tail.r === r) line += "t";
      else if (food && food.c === c && food.r === r) line += "*";
      else if (solid.has(key(c, r))) line += "O";
      else line += "·";
    }
    s += line + "\n";
  }
  return s;
}

// ---------- main ----------
await new Deno.Command("stty", {
  args: ["-f", PORT, "230400", "raw", "-echo", "min", "0", "time", "1"],
}).output();
const f = await Deno.open(PORT, { read: true, write: true });
const write = (b: Uint8Array) => f.write(b);

console.log("clearing any running app...");
for (let i = 0; i < 2; i++) {
  await write(enc.encode("input send back press\r"));
  await sleep(650);
  await write(enc.encode("input send back release\r"));
  await sleep(450);
}
await write(enc.encode("loader close\r"));
await sleep(400);

console.log("launching snake...");
await write(enc.encode(`loader open ${SNAKE}\r`));
await sleep(700);
await write(enc.encode("input send up short\r"));
await sleep(220);
await write(enc.encode("input send left short\r"));
await sleep(150);
console.log("switching to RPC...");
await write(enc.encode("start_rpc_session\r"));
await sleep(450);
await write(START_STREAM);

const rb = new Uint8Array(8192);
let acc = new Uint8Array(0);
let prevSolid = new Set<string>();
let body: Cell[] = [];
let heading: Dir = "LEFT";
let food: Cell | null = null;
let ticks = 0, moves = 0, maxLen = 0, resyncs = 0;
let lastWhy = "";
const reasons: Record<string, number> = {};
const start = Date.now();
let lastTickAt = Date.now(), lastLog = 0;

while (Date.now() - start < RUN_MS) {
  let n: number | null = null;
  try {
    n = await f.read(rb);
  } catch {
    break;
  }
  if (n && n > 0) {
    const m = new Uint8Array(acc.length + n);
    m.set(acc);
    m.set(rb.subarray(0, n), acc.length);
    acc = m.length > 6000 ? m.subarray(m.length - 6000) : m;
  }
  const fb = latestFrame(acc);
  if (!fb) {
    await sleep(15);
    continue;
  }

  const board = parseBoard(fb);
  if (board.food) food = board.food;
  if (board.dialog) {
    console.log(
      `\n[${
        ((Date.now() - start) / 1000).toFixed(1)
      }s] GAME OVER. ticks=${ticks} moves=${moves} maxLen=${maxLen}`,
    );
    break;
  }
  const solid = board.solid;
  if (solid.size < 3) {
    await sleep(15);
    continue;
  }

  if (prevSolid.size === 0) {
    prevSolid = solid;
    lastTickAt = Date.now();
    await sleep(15);
    continue;
  }

  const added = [...solid].filter((k) => !prevSolid.has(k));
  if (added.length > 0) {
    ticks++;
    lastTickAt = Date.now();
    const removed = [...prevSolid].filter((k) => !solid.has(k));

    if (added.length === 1 && body.length > 0) {
      const [c, r] = added[0].split(",").map(Number);
      body.unshift({ c, r });
      if (removed.length > 0) body.pop();
    } else {
      // Ambiguous diff (or first tick): resync by tracing from the new head.
      const [c, r] = added[0].split(",").map(Number);
      body = traceBody({ c, r }, solid);
      resyncs++;
    }
    // Sanity: body must match what's on screen.
    if (body.length !== solid.size) {
      body = traceBody(body[0], solid);
      resyncs++;
    }
    maxLen = Math.max(maxLen, body.length);
    if (body.length >= 2) heading = dirBetween(body[1], body[0]) ?? heading;

    const { dir, why } = decide(body, food);
    reasons[why] = (reasons[why] ?? 0) + 1;
    // The interesting signal: when the food path is rejected as unsafe and the
    // bot drops into tail-chasing / desperate mode.
    if (why !== lastWhy) {
      console.log(
        `  [${
          ((Date.now() - start) / 1000).toFixed(1)
        }s] mode -> ${why} (len=${body.length}, tick=${ticks})`,
      );
      lastWhy = why;
    }
    if (dir && dir !== heading) {
      await write(inputEvent(KEY[dir], 0)); // PRESS (Snake ignores SHORT)
      await sleep(25);
      await write(inputEvent(KEY[dir], 1)); // RELEASE
      heading = dir;
      moves++;
    }
    prevSolid = solid;
  }

  if (ticks > 0 && Date.now() - lastTickAt > 2500) {
    console.log(
      `\n[${
        ((Date.now() - start) / 1000).toFixed(1)
      }s] STALLED. ticks=${ticks} moves=${moves} maxLen=${maxLen}`,
    );
    break;
  }

  const now = Date.now();
  if (now - lastLog > LOG_MS && body.length) {
    lastLog = now;
    console.log(
      `\n[${((now - start) / 1000).toFixed(1)}s] len=${body.length} head=${
        kOf(body[0])
      } heading=${heading} food=${food ? kOf(food) : "?"} ticks=${ticks}`,
    );
    console.log(renderGrid(solid, body, food));
  }
  await sleep(15);
}

try {
  await write(inputEvent(5, 0));
  await sleep(600);
  await write(inputEvent(5, 1));
  await sleep(300);
} catch { /* ignore */ }
f.close();
console.log(
  `\ndone. ${
    ((Date.now() - start) / 1000).toFixed(1)
  }s ticks=${ticks} moves=${moves} maxLen=${maxLen} resyncs=${resyncs} decisions=${
    JSON.stringify(reasons)
  }`,
);
