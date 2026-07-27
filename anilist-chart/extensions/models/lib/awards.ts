// The «Доска почёта» awards, ported from generate_board.py compute() (the 3 top
// honours + 12 register rows + the genre keepers). Pairs live in pairs.ts.
//
// Faithfulness rules carried from the plan:
//   - `list` is the UNFILTERED row count; only `rated` uses score>0 (rankable).
//   - every min/max goes through pickOrSkip -> null + skip warn (no crash on an
//     empty candidate set), so rendered+skipped is always the full 15.
//   - the skip CASCADES: «Золотая середина» (12) excludes «Глас народа»'s (10)
//     holder, and if vox was skipped, mid is skipped too — never a silent pick.
//   - CURATED notes fall back to computed text on a holder change, warning in a
//     SEPARATE channel (rankable.curatedNote).
//   - every value entering a formatter is finite-checked at the data layer.

import { fmtDec, fmtInt, fmtScore, fmtSigned, ruPlural } from "./format.ts";
import {
  assertFinite,
  curatedNote,
  type GroupedRows,
  pickOrSkip,
  type Row,
  titleOf,
  type Warn,
} from "./rankable.ts";

export interface Award {
  n: string; // the mark
  u: string; // unit label
  t: string; // звание
  w: string; // holder(s)
  s: string; // note
}

export interface Keeper {
  g: string; // genre (ru)
  w: string; // keeper
  p: number; // share %
}

export interface AwardsResult {
  top: (Award | null)[]; // length 3
  rest: (Award | null)[]; // length 12
  keepers: Keeper[];
  warn: Warn;
}

// Thresholds (generate_board.py:39-42).
const MIN_RATED = 100;
const MIN_LIST = 100;
const FLOP_OWN_MIN = 8.0;

// English -> Russian genre labels, in the board's fixed order (generate_board.py:44).
const GENRES_RU: [string, string][] = [
  ["Comedy", "Комедия"],
  ["Action", "Экшен"],
  ["Slice of Life", "Повседневность"],
  ["Drama", "Драма"],
  ["Fantasy", "Фэнтези"],
  ["Romance", "Романтика"],
  ["Mystery", "Мистика"],
  ["Adventure", "Приключения"],
];

const round1 = (x: number) => Math.round(x * 10) / 10;
const roundHundred = (x: number) => Math.round(x / 100) * 100;

export function computeAwards(
  grouped: GroupedRows,
  rows: Row[],
  warn: Warn,
): AwardsResult {
  const { users, byUser, owners, per } = grouped;
  const P = (u: string) => per.get(u)!;
  const RS = (u: string) => byUser.get(u)!;

  // ── 01 «Защитник безнадёжных» (flop): lowest-world title still loved ────────
  let top1: Award | null = null;
  const flops = rows.filter((r) => r.score >= FLOP_OWN_MIN && r.world);
  const fl = pickOrSkip(flops, (r) => r.world as number, "min", "flop", warn);
  if (fl) {
    const flUser = fl.user;
    const ownFlops = flops
      .filter((r) => r.user === flUser)
      .sort((a, b) => (a.world as number) - (b.world as number));
    const t2 = ownFlops.slice(0, 2).map(titleOf);
    const w0 = assertFinite(
      (ownFlops[0].world as number) / 10,
      "flop_world",
      ownFlops[0].media_id,
    );
    const computed = `«${t2[0]}»` +
      (t2.length > 1 ? ` и «${t2[1]}»` : "") +
      ` — у мира ${fmtDec(w0)}` +
      (t2.length > 1
        ? ` и ${
          fmtDec(
            assertFinite(
              (ownFlops[1].world as number) / 10,
              "flop_world",
              ownFlops[1].media_id,
            ),
          )
        }`
        : "") +
      ", у него высшие баллы";
    const flopNote = curatedNote("flop", flUser, computed, warn);
    const flWorld = assertFinite(
      (fl.world as number) / 10,
      "flop_world",
      fl.media_id,
    );
    top1 = {
      n: fmtDec(assertFinite(fl.score, "flop_score", fl.media_id), 1),
      u: `против ${fmtDec(flWorld)} у мира`,
      t: "Защитник безнадёжных",
      w: flUser,
      s: flopNote,
    };
  }

  // ── 02 «Археолог» (arch): most pre-1990 titles ──────────────────────────────
  let top2: Award | null = null;
  const oldCount = new Map<string, number>();
  const avgYear = new Map<string, number>();
  for (const u of users) {
    const rs = RS(u);
    oldCount.set(u, rs.filter((r) => r.year && r.year < 1990).length);
    const ys = rs.filter((r) => r.year).map((r) => r.year as number);
    avgYear.set(u, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0);
  }
  const arch = pickOrSkip(
    users,
    (u) => oldCount.get(u)!,
    "max",
    "archeolog",
    warn,
  );
  if (arch) {
    const oldest = pickOrSkip(
      RS(arch).filter((r) => r.year),
      (r) => r.year as number,
      "min",
      "archeolog-oldest",
      warn,
    );
    if (oldest) {
      const others = users
        .filter((u) => u !== arch && avgYear.get(u))
        .map((u) => avgYear.get(u)!);
      const dYears = others.length
        ? Math.round(Math.min(...others) - avgYear.get(arch)!)
        : 0;
      let archNote = `самое древнее — «${
        titleOf(oldest)
      }», ${oldest.year} · средний год списка ${
        Math.round(avgYear.get(arch)!)
      }`;
      if (dYears > 0) {
        archNote += `, на ${dYears} ${
          ruPlural(dYears, "год", "года", "лет")
        } раньше всех`;
      }
      top2 = {
        n: fmtInt(oldCount.get(arch)!),
        u: "тайтлов старше 1990 года",
        t: "Археолог",
        w: arch,
        s: archNote,
      };
    }
  }

  // ── 03 «Архивариус» (big): the biggest list ─────────────────────────────────
  let top3: Award | null = null;
  const big = pickOrSkip(users, (u) => P(u).list, "max", "archivist", warn);
  if (big) {
    const over1000 = users.filter((u) => P(u).list > 1000);
    let note = `${fmtInt(P(big).nrated)} из них с оценкой`;
    note += over1000.length === 1 && over1000[0] === big
      ? " · единственный список, переваливший за тысячу"
      : " · больше всех в чате";
    top3 = {
      n: fmtInt(P(big).list),
      u: "тайтлов в каталоге",
      t: "Архивариус",
      w: big,
      s: note,
    };
  }

  const rest: (Award | null)[] = [];

  // ── 04 «Повелитель времени» (tl): total runtime in days ─────────────────────
  const minutes = (u: string) =>
    RS(u).reduce((acc, r) => acc + (r.episodes || 0) * (r.duration || 24), 0);
  const tl = pickOrSkip(users, minutes, "max", "timelord", warn);
  if (tl) {
    const days = Math.floor(minutes(tl) / 1440);
    const eps = RS(tl).reduce((acc, r) => acc + (r.episodes || 0), 0);
    rest.push({
      n: fmtInt(days),
      u: `${ruPlural(days, "день", "дня", "дней")}, если смотреть подряд`,
      t: "Повелитель времени",
      w: tl,
      s: `${fmtInt(eps)} ${ruPlural(eps, "серия", "серии", "серий")} в сумме`,
    });
  } else rest.push(null);

  // ── 05 «Спортивная секция» (sp): Sports share vs the chat average ────────────
  const sportShare = (rs: Row[]) =>
    rs.filter((r) => (r.genres || []).includes("Sports")).length / rs.length;
  const chatSport = sportShare(rows);
  const spEligible = users.filter((u) => P(u).list >= MIN_LIST);
  const sp = pickOrSkip(
    spEligible,
    (u) => sportShare(RS(u)),
    "max",
    "sport",
    warn,
  );
  if (sp) {
    const spRatio = assertFinite(
      chatSport ? sportShare(RS(sp)) / chatSport : 0,
      "sport_ratio",
      sp,
    );
    const note = curatedNote(
      "sport",
      sp,
      `${
        fmtDec(assertFinite(sportShare(RS(sp)) * 100, "sport_pct", sp))
      }% списка — спорт, при ${
        fmtDec(assertFinite(chatSport * 100, "chat_sport_pct", "-"))
      }% у чата`,
      warn,
    );
    rest.push({
      n: "×" + fmtDec(spRatio),
      u: "спорта против среднего",
      t: "Спортивная секция",
      w: sp,
      s: note,
    });
  } else rest.push(null);

  // ── 06 «Совесть чата» (co): highest share of the list rated ──────────────────
  const coEligible = users.filter((u) => P(u).list >= MIN_LIST);
  const co = pickOrSkip(
    coEligible,
    (u) => P(u).nrated / P(u).list,
    "max",
    "conscience",
    warn,
  );
  if (co) {
    let coPct = round1(
      assertFinite(P(co).nrated / P(co).list * 100, "conscience_pct", co),
    );
    if (coPct >= 100 && P(co).nrated < P(co).list) coPct = 99.9;
    const note = curatedNote(
      "conscience",
      co,
      `${fmtInt(P(co).nrated)} из ${fmtInt(P(co).list)} с оценкой`,
      warn,
      { rated: fmtInt(P(co).nrated), total: fmtInt(P(co).list) },
    );
    rest.push({
      n: fmtDec(coPct),
      u: "% списка с оценкой",
      t: "Совесть чата",
      w: co,
      s: note,
    });
  } else rest.push(null);

  // ── 07 «Раздаёт десятки» (tn): highest share of 10s ──────────────────────────
  const tnEligible = users.filter((u) => P(u).nrated >= MIN_RATED);
  const tn = pickOrSkip(
    tnEligible,
    (u) => P(u).tens / P(u).nrated,
    "max",
    "tens",
    warn,
  );
  if (tn) {
    const tnShare = assertFinite(P(tn).tens / P(tn).nrated, "tens_share", tn);
    let note = `${fmtInt(P(tn).tens)} ${
      ruPlural(P(tn).tens, "десятка", "десятки", "десяток")
    } из ${fmtInt(P(tn).nrated)}`;
    const every = tnShare ? Math.round(1 / tnShare) : 0;
    const ORD: Record<number, string> = {
      3: "третья",
      4: "четвёртая",
      5: "пятая",
    };
    if (ORD[every]) note += `, почти каждая ${ORD[every]}`;
    rest.push({
      n: fmtInt(tnShare * 100),
      u: tn === "Magistr" ? "% всех его оценок" : "% всех оценок",
      t: "Раздаёт десятки",
      w: tn,
      s: note,
    });
  } else rest.push(null);

  // ── 08 «Взыскательный зритель» (st): lowest own average ──────────────────────
  const stEligible = users.filter((u) => P(u).nrated >= MIN_RATED);
  const st = pickOrSkip(stEligible, (u) => P(u).avg, "min", "strict", warn);
  if (st) {
    const note = P(st).tens === 0
      ? "ни одной лишней десятки"
      : `всего ${fmtInt(P(st).tens)} ${
        ruPlural(P(st).tens, "десятка", "десятки", "десяток")
      } на ${fmtInt(P(st).nrated)} оценок`;
    rest.push({
      n: fmtDec(assertFinite(P(st).avg, "strict_avg", st), 2),
      u: "средняя оценка",
      t: "Взыскательный зритель",
      w: st,
      s: note,
    });
  } else rest.push(null);

  // ── 09/10/12 deviation from the world mean (scores are 0-10, world 0-100) ────
  const devs = (u: string) =>
    P(u).rated.filter((r) => r.world).map((r) =>
      r.score * 10 - (r.world as number)
    );
  const signed = new Map<string, number>();
  const absdev = new Map<string, number>();
  for (const u of users) {
    if (P(u).nrated < MIN_RATED) continue;
    const d = devs(u);
    if (d.length === 0) continue;
    signed.set(u, d.reduce((a, b) => a + b, 0) / d.length);
    absdev.set(u, d.reduce((a, b) => a + Math.abs(b), 0) / d.length);
  }
  const signedUsers = [...signed.keys()]; // insertion order = users (sorted)

  // 09 «Против течения» (up): most above the world mean
  const up = pickOrSkip(signedUsers, (u) => signed.get(u)!, "max", "up", warn);
  if (up) {
    rest.push({
      n: fmtSignedGuarded(signed.get(up)!, "signed_up", up),
      u: "к мировой оценке",
      t: "Против течения",
      w: up,
      s: "выше, чем весь AniList",
    });
  } else rest.push(null);

  // 10 «Глас народа» (vox): closest to the world mean (per-title)
  const vox = pickOrSkip(
    signedUsers,
    (u) => absdev.get(u)!,
    "min",
    "vox",
    warn,
  );
  if (vox) {
    rest.push({
      n: fmtDec(assertFinite(absdev.get(vox)!, "absdev_vox", vox)),
      u: "отклонение от мира",
      t: "Глас народа",
      w: vox,
      s: "ближе всех к общему мнению",
    });
  } else rest.push(null);

  // 11 «Одинокий волк» (wolf): titles nobody else has
  const solo = new Map<string, number>();
  for (const u of users) {
    solo.set(u, RS(u).filter((r) => owners.get(r.media_id)!.size === 1).length);
  }
  const wolf = pickOrSkip(users, (u) => solo.get(u)!, "max", "wolf", warn);
  if (wolf) {
    rest.push({
      n: fmtInt(solo.get(wolf)!),
      u: ruPlural(solo.get(wolf)!, "тайтл", "тайтла", "тайтлов") +
        " в одиночку",
      t: "Одинокий волк",
      w: wolf,
      s: "столько нет больше ни у кого",
    });
  } else rest.push(null);

  // 12 «Золотая середина» (mid): smallest signed bias, EXCLUDING vox's holder.
  // CASCADE: if vox was skipped there is no holder to exclude and no defined
  // basis to pick from -> mid is skipped too (an undefined holder would compare
  // true against everyone and silently pick, which we refuse).
  if (vox === null) {
    warn.skips.push(
      "mid: skipped because vox (Глас народа) was skipped (cascade)",
    );
    rest.push(null);
  } else {
    const midCands = signedUsers.filter((u) => u !== vox);
    const mid = pickOrSkip(
      midCands,
      (u) => Math.abs(signed.get(u)!),
      "min",
      "mid",
      warn,
    );
    if (mid) {
      rest.push({
        n: fmtSignedGuarded(signed.get(mid)!, "signed_mid", mid),
        u: "к мировой оценке",
        t: "Золотая середина",
        w: mid,
        s: "самая спокойная шкала в чате",
      });
    } else rest.push(null);
  }

  // 13 «Экономная шкала» (ec): fewest distinct score values (half the floor)
  const ecEligible = users.filter((u) =>
    P(u).nrated >= Math.floor(MIN_RATED / 2)
  );
  const ec = pickOrSkip(
    ecEligible,
    (u) => P(u).distinct,
    "min",
    "economy",
    warn,
  );
  if (ec) {
    const ecScores = [...new Set(P(ec).rated.map((r) => r.score))].sort((
      a,
      b,
    ) => a - b);
    let note = `от ${fmtScore(ecScores[0])} до ${
      fmtScore(ecScores[ecScores.length - 1])
    }`;
    if (P(ec).tens === 0) note += ", и ни одной десятки";
    const nDistinct = P(ec).distinct;
    rest.push({
      n: fmtInt(nDistinct),
      u: (nDistinct >= 2 && nDistinct <= 4
        ? "разные оценки"
        : "разных оценок") + " на весь список",
      t: "Экономная шкала",
      w: ec,
      s: note,
    });
  } else rest.push(null);

  // 14 «Копает глубже всех» (dg): lowest average popularity
  const avgPop = (u: string) => {
    const ps = RS(u).filter((r) => r.popularity).map((r) =>
      r.popularity as number
    );
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
  };
  const dgEligible = users.filter((u) => P(u).list >= MIN_LIST);
  const dg = pickOrSkip(dgEligible, avgPop, "min", "digger", warn);
  if (dg) {
    rest.push({
      n: fmtInt(roundHundred(assertFinite(avgPop(dg), "avg_pop", dg))),
      u: "средняя популярность",
      t: "Копает глубже всех",
      w: dg,
      s: "смотрит то, до чего остальные не доходят",
    });
  } else rest.push(null);

  // 15 «Марафонцы» (mar): the longest series anyone finished
  let marSlot: Award | null = null;
  const finished = rows.filter((r) => r.score > 0 && r.episodes);
  const mar = pickOrSkip(
    finished,
    (r) => r.episodes as number,
    "max",
    "marathon",
    warn,
  );
  if (mar) {
    const marId = mar.media_id;
    const marFinished = finished.filter((r) => r.media_id === marId);
    const scoreOf = (u: string) => marFinished.find((r) => r.user === u)!.score;
    // Score desc; deterministic name-asc tiebreak (the oracle sorts an unordered
    // set, whose tie order is non-deterministic — we pin it).
    const holders = [...new Set(marFinished.map((r) => r.user))].sort(
      (a, b) => scoreOf(b) - scoreOf(a) || a.localeCompare(b),
    );
    const marT = holders.length > 1 ? "Марафонцы" : "Марафонец";
    const marS = holders.length > 1
      ? `дошли до конца «${titleOf(mar)}»`
      : `весь «${titleOf(mar)}», от первой серии до последней`;
    marSlot = {
      n: fmtInt(mar.episodes as number),
      u: ruPlural(mar.episodes as number, "серия", "серии", "серий") +
        " подряд",
      t: marT,
      w: holders.join(" · "),
      s: marS,
    };
  }
  rest.push(marSlot);

  // ── Хранители жанров: share of OWN list, min 100 titles ──────────────────────
  const keepers: Keeper[] = [];
  const eligible = users.filter((u) => P(u).list >= MIN_LIST);
  for (const [en, ru] of GENRES_RU) {
    const share = (u: string) =>
      RS(u).filter((r) => (r.genres || []).includes(en)).length / P(u).list;
    const k = pickOrSkip(eligible, share, "max", `keeper-${en}`, warn);
    if (k) {
      keepers.push({
        g: ru,
        w: k,
        p: round1(assertFinite(share(k) * 100, "keeper_pct", k)),
      });
    }
  }
  keepers.sort((a, b) => b.p - a.p);

  return { top: [top1, top2, top3], rest, keepers, warn };
}

// fmtSigned with a data-layer finite guard on the input.
function fmtSignedGuarded(
  x: number,
  field: string,
  id: number | string,
): string {
  return fmtSigned(assertFinite(x, field, id), 1);
}
