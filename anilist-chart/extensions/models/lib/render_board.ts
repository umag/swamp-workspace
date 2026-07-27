// «Доска почёта»: the school-register leaderboard page (generate_board.py
// render(), lines 739-906). compute() is already ported (awards.ts + pairs.ts);
// this module is the template only. It emits all 15 звания slots (3 top + 12
// register rows), the жанр keepers, and the two tipped-in pairs.
//
// Faithfulness carried from the plan:
//   - a null award slot (pickOrSkip found no eligible candidate) is COUNTED in
//     `skipped` and NOT rendered, never a `>None<`/`>undefined<` cell. So
//     recordCount + skipped.length is always the full 15.
//   - the landing advertises `recordCount`, so a skipped award must lower it.
//   - every field goes through esc (the board already escaped in the oracle),
//     and the keeper track width goes through a finite-guarded formatter into
//     the style attribute, never a raw float (the attribute-scan backstop
//     depends on this).

import { esc, fmtDec, fmtInt, ruPlural, ruWord } from "./format.ts";
import type { Award, Keeper } from "./awards.ts";
import type { Pair } from "./pairs.ts";
import { BOARD_CSS } from "./board_css.ts";

const MIN_LIST = 100; // жанр floor, echoed in the footer (generate_board.py:40)

const TICKS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const CORNERS = '<i class="cn cn1"></i><i class="cn cn2"></i>' +
  '<i class="cn cn3"></i><i class="cn cn4"></i>';

const RU_MONTHS_GEN = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

export interface BoardData {
  users: string[];
  nrows: number;
  top: readonly (Award | null)[]; // 3
  rest: readonly (Award | null)[]; // 12
  keepers: readonly Keeper[];
  pairs: readonly (Pair | null)[];
  /** Deterministic clock for the неделя/date line (defaults to now). */
  now?: Date;
}

export interface BoardResult {
  html: string;
  /** Non-null звания actually rendered (drives the landing's advertised count). */
  recordCount: number;
  /** Positional labels of the skipped (null) звания slots. */
  skipped: string[];
}

function pad2(i: number): string {
  return String(i).padStart(2, "0");
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** ISO-8601 week number (Python date.isocalendar()[1]). */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // nearest Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Keeper track width -> style attribute, finite-guarded (plan step 10). */
function pct(p: number): string {
  if (!Number.isFinite(p)) {
    throw new Error(`non-finite keeper share: ${p}`);
  }
  return String(p);
}

export function renderBoard(data: BoardData): BoardResult {
  const now = data.now ?? new Date();
  const week = isoWeek(now);
  const dateRu = `${now.getDate()} ${RU_MONTHS_GEN[now.getMonth()]} ` +
    `${now.getFullYear()}`;
  const nusers = data.users.length;
  const usersWord = capitalize(ruWord(nusers));

  const skipped: string[] = [];
  let recordCount = 0;

  let topHtml = "";
  data.top.forEach((a, i) => {
    if (!a) {
      skipped.push(`top-${pad2(i + 1)}`);
      return;
    }
    recordCount++;
    topHtml += `
      <article class="lead">
        <div class="lead-n">${pad2(i + 1)}</div>
        <div class="lead-mark"><span>${esc(a.n)}</span></div>
        <div class="lead-txt">
          <span class="lbl">${esc(a.u)}</span>
          <h3>${esc(a.t)}</h3>
          <span class="hand who">${esc(a.w)}</span>
          <p class="sub">${esc(a.s)}</p>
        </div>
      </article>`;
  });

  let rowsHtml = "";
  data.rest.forEach((a, i) => {
    if (!a) {
      skipped.push(`rest-${pad2(i + 4)}`);
      return;
    }
    recordCount++;
    rowsHtml += `
          <tr>
            <td class="nn">${pad2(i + 4)}</td>
            <td class="zv">${esc(a.t)}<span class="inl who-i">${
      esc(a.w)
    }</span><span class="inl pr-i">${esc(a.s)}</span></td>
            <td class="who hand">${esc(a.w)}</td>
            <td class="mk"><span class="mark">${esc(a.n)}</span></td>
            <td class="pr"><i class="unit">${esc(a.u)}</i>${esc(a.s)}</td>
          </tr>`;
  });

  let keepersHtml = "";
  for (const k of data.keepers) {
    keepersHtml += `
      <div class="vrow" style="--p:${esc(pct(k.p))}%">
        <span class="g nm">${esc(k.g)}</span>
        <span class="w hand nm">${esc(k.w)}</span>
        <div class="track"><b></b>${"<i></i>".repeat(TICKS.length)}</div>
        <div class="circ">${esc(fmtDec(k.p))}</div>
      </div>`;
  }

  let pairsHtml = "";
  for (const p of data.pairs) {
    if (!p) continue;
    let shots = "";
    for (let i = 0; i < p.covers.length; i++) {
      shots += `<img src="${esc(p.covers[i])}" alt="${
        esc(p.alt[i] ?? "")
      }" loading="lazy">`;
    }
    pairsHtml += `
      <article class="tip">
        <div class="mount">
          <div class="shots">${shots}</div>
          ${CORNERS}
        </div>
        <div class="tip-b">
          <div class="txt">
            <h3>${esc(p.t)}</h3>
            <span class="hand who">${esc(p.w)}</span>
            <p>${esc(p.p)}</p>
            <span class="hand cap">${esc(p.cap)}</span>
          </div>
          <div class="circ">${esc(p.n)}</div>
        </div>
      </article>`;
  }

  const ticks = TICKS.map((t) => `<span>${t}</span>`).join("");
  const restLen = data.rest.length;

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Доска почёта — очень непослушные и бестыдные дочьки</title>
<link rel="preconnect" href="https://fonts.bunny.net">
<link href="https://fonts.bunny.net/css?family=caveat:400,600&display=swap" rel="stylesheet">
<style>
${BOARD_CSS}</style>
</head>
<body>
<div class="jour">

  <header class="mast">
    <div class="mast-in">
      <span class="lbl top-lbl">Журнал успеваемости</span>
      <h1>Доска почёта</h1>
      <p class="klass"><span class="lbl">класс</span><span class="hand">очень непослушные и бестыдные дочьки</span></p>
      <p class="dek">${usersWord} человек, ${fmtInt(data.nrows)} ${
    ruPlural(data.nrows, "оценка", "оценки", "оценок")
  } и один общий вкус, который никак не сходится.</p>
      <div class="mast-run">
        <span class="lbl">неделя ${week} · ${dateRu}</span>
        <span class="lbl">учащихся — ${nusers}</span>
        <span class="lbl">записей — ${recordCount}</span>
        <i class="pen">пересчитано</i>
      </div>
    </div>
  </header>

  <section class="sec">
    <div class="sec-h">
      <h2>Главные звания</h2>
      <span class="lbl">первые три записи</span>
    </div>
    <div class="svod">
      <div class="svod-h">
        <span class="lbl">Сводный лист</span>
        <span class="lbl">отметка · звание · ученик</span>
      </div>${topHtml}
    </div>
  </section>

  <section class="sec">
    <div class="sec-h">
      <h2>И ещё звания</h2>
      <span class="lbl">записи ${pad2(4)}—${pad2(3 + restLen)}</span>
    </div>
    <div class="regwrap">
      <table class="reg">
        <thead>
          <tr>
            <th class="nn">№</th>
            <th class="zv">Звание</th>
            <th class="who">Ученик</th>
            <th class="mk">Отметка</th>
            <th class="pr">Примечание</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}
        </tbody>
      </table>
    </div>
  </section>

  <section class="sec">
    <div class="sec-h">
      <h2>Хранители жанров</h2>
      <span class="lbl">сводная ведомость</span>
    </div>
    <p class="note">Считается доля собственного списка, а не общее число. Иначе каждый жанр забирал бы тот, у кого список просто длиннее.</p>
    <div class="vedwrap">
      <div class="vhead">
        <span class="lbl">Жанр</span>
        <span class="lbl">Хранитель</span>
        <span class="lbl">Доля собственного списка, %<span class="tk">${ticks}</span></span>
        <span class="lbl" style="text-align:center">Итог</span>
      </div>
      <div class="vhead-n">
        <span class="lbl">Жанр · хранитель · доля списка</span>
        <span class="lbl" style="text-align:center">Итог</span>
      </div>${keepersHtml}
    </div>
  </section>

  <section class="sec">
    <div class="sec-h">
      <h2>Пары</h2>
      <span class="lbl">вклеено на форзац</span>
    </div>
    <div class="pairs">${pairsHtml}
    </div>
  </section>

  <footer class="foot">
    <span class="lbl">Как считалось</span>
    <p>Пересчитывается раз в неделю по спискам COMPLETED и CURRENT ${nusers} участников. Оценки сравниваются со средней по AniList. Звания за жанр — по доле собственного списка, минимум ${MIN_LIST} тайтлов.</p>
  </footer>

</div>
</body>
</html>`;

  return { html, recordCount, skipped };
}
