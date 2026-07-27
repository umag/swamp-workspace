// The /anime landing (generate_landing.py render()): SHAFT-style cut-in cards
// fronting the board + four charts. Two things are threaded in from the render
// run rather than hard-coded:
//
//   - recordCount: the board's ACTUAL number of звания (generate_landing.py used
//     a hard-coded BOARD_RECORDS=15). Both the /board card's figure and the
//     Russian numeral in its description derive from it, so a skipped award
//     lowers what the landing advertises: no "пятнадцать" over a 14-record board.
//   - topK: the per-genre depth advertised on the /chart card. The oracle read
//     TOP_K from the environment; the port has no run.sh, so it is a method arg
//     threaded here AND into the chart compute, keeping the two consistent.
//
// DEVIATION (recorded): the oracle landing does not escape its interpolations;
// here every interpolated value goes through esc. The values are our own
// computed figures, so this only hardens the boundary.

import { esc, fmtInt, ruPlural, ruWord } from "./format.ts";
import { LANDING_CSS } from "./landing_css.ts";

export interface LandingStats {
  users: number;
  rows: number;
  rated: number;
  titles: number;
  genres: number;
  cur_titles: number;
  cur_users: number;
  movies: number;
  y_min: number;
  y_max: number;
  season: string; // e.g. "лето 2026"
}

export interface LandingInput {
  stats: LandingStats;
  /** The board's actual record count (render_board's recordCount). */
  recordCount: number;
  /** Per-genre depth, advertised on the /chart card. */
  topK: number;
}

const PART = ["其ノ壹", "其ノ貳", "其ノ參", "其ノ肆", "其ノ伍"];

interface Card {
  href: string;
  t: string;
  ground: string;
  d: string;
  n: string;
  u: string;
}

export function renderLanding(input: LandingInput): string {
  const st = input.stats;
  const rc = input.recordCount;

  const stats: [string, string][] = [
    [
      fmtInt(st.users),
      ruPlural(st.users, "участник", "участника", "участников"),
    ],
    [fmtInt(st.rows), ruPlural(st.rows, "оценка", "оценки", "оценок")],
    [fmtInt(st.titles), ruPlural(st.titles, "тайтл", "тайтла", "тайтлов")],
    [fmtInt(st.genres), ruPlural(st.genres, "жанр", "жанра", "жанров")],
  ];

  const pages: Card[] = [
    {
      href: "/board",
      t: "Доска почёта",
      ground: "red",
      d: `Кто чем известен: ${ruWord(rc)} званий, от археолога до защитника ` +
        "безнадёжных. Плюс пары, чьи вкусы совпали или разошлись полностью.",
      n: String(rc),
      u: `званий на ${st.users} человек`,
    },
    {
      href: "/chart",
      t: "Топ по жанрам",
      ground: "bone",
      d: "Средняя оценка чата по каждому жанру, лучшее в каждом. " +
        "Самая прямая таблица из пяти: никаких поправок, только среднее.",
      n: String(st.genres),
      u: `жанров, по ${input.topK} тайтлов`,
    },
    {
      href: "/fresh",
      t: "Свежесть",
      ground: "red",
      d: "То же самое, но со штрафом пять процентов за каждый сезон возраста. " +
        "Старое опускается, недавнее всплывает.",
      n: `${st.y_min}—${st.y_max}`,
      u: "разброс годов в базе",
    },
    {
      href: "/bayes",
      t: "Байес",
      ground: "bone",
      d: "Сглаженный рейтинг: тайтл с одной десяткой не обгоняет тайтл " +
        "с двадцатью восьмёрками. Полный метр исключён.",
      n: fmtInt(st.movies),
      u: ruPlural(
        st.movies,
        "фильм не участвует",
        "фильма не участвуют",
        "фильмов не участвуют",
      ),
    },
    {
      href: "/current",
      t: "Сезон",
      ground: "red",
      d: `Только то, что идёт прямо сейчас, ${st.season}. ` +
        "Пока чат посмотрел из сезона немного, так что страница честно короткая.",
      n: fmtInt(st.cur_titles),
      u: `${
        ruPlural(st.cur_titles, "тайтл", "тайтла", "тайтлов")
      } у ${st.cur_users} человек`,
    },
  ];

  const nums = stats
    .map(([n, u]) => `<div><b>${esc(n)}</b><span>${esc(u)}</span></div>`)
    .join("");

  let cards = "";
  pages.forEach((p, i) => {
    cards += `
<a class="card ${p.ground}" href="${esc(p.href)}">
  <div class="in dest">
    <div class="ord">${pad2(i + 1)}</div>
    <div>
      <div class="part"><i>${PART[i]}</i><span>${esc(p.href)}</span></div>
      <h2>${esc(p.t)}</h2>
      <p class="d">${esc(p.d)}</p>
      <p class="fig"><b>${esc(p.n)}</b><span>${esc(p.u)}</span></p>
      <span class="go">смотреть<i>→</i></span>
    </div>
  </div>
</a>
<div class="bar"></div>`;
  });

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Очень непослушные и бестыдные дочьки — статистика</title>
<link rel="preconnect" href="https://fonts.bunny.net">
<link href="https://fonts.bunny.net/css?family=golos-text:400,600,800&display=swap" rel="stylesheet">
<style>
${LANDING_CSS}</style>
</head>
<body>
<section class="card blk mast">
  <div class="in">
    <div class="part"><i>其ノ零</i><span>статистика чата</span></div>
    <h1>Очень<br>непослушные<br>и бестыдные<br>дочьки</h1>
    <p class="sub">Всё, что можно посчитать по спискам AniList ${st.users} человек. Пересчитывается раз в неделю.</p>
    <div class="nums">${nums}</div>
  </div>
</section>
<div class="bar"></div>
${cards}
<section class="card blk">
  <div class="in">
    <div class="part"><i>其ノ終</i><span>как это считается</span></div>
    <p class="foot">Раз в неделю по спискам COMPLETED и CURRENT ${st.users} участников. Из ${
    fmtInt(st.rows)
  } записей оценку имеют ${
    fmtInt(st.rated)
  } — остальные лежат в списках без балла и в средние не идут. Оценки сравниваются со средней по AniList. Данные тянутся из публичного API, ничего закрытого тут нет.</p>
  </div>
</section>
</body>
</html>`;
}

function pad2(i: number): string {
  return String(i).padStart(2, "0");
}
