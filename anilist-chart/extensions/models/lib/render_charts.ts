// The four genre charts (/chart, /fresh, /bayes, /current) share one dark-theme
// poster table. The oracle carried four near-identical `generate_html_*`
// functions; this is one renderer parameterised by a per-mode config (title, H1,
// optional info line, per-cell tooltip). Ranking + cross-genre de-duplication
// already happened upstream (chart_rank.buildFinalChartData); this module only
// paints the resulting `Record<genre, (Rankable|null)[]>` grid.
//
// DEVIATION from the oracle (recorded): the oracle's chart templates do NOT
// escape titles or cover URLs (only `"` in the alt attribute). Here EVERY
// user-controlled field (title, cover URL, genre header) goes through esc, and
// every score into text/attribute goes through a finite-guarded formatter. This
// closes an XSS/`>NaN<` hole the oracle left open; byte-parity with the oracle
// chart pages is already abandoned (recomputation blessed), so the divergence is
// intentional. Chart CSS is NOT byte-parity-pinned (only board + landing are),
// so all four charts share one clean stylesheet.

import { esc } from "./format.ts";
import type { ChartMode, Rankable } from "./chart_rank.ts";

/** A chart cell: a Rankable plus the two fields only the /fresh tooltip needs. */
export interface ChartRow extends Rankable {
  start_year?: number | null;
  age_penalty_factor?: number;
}

export interface ChartRenderInput {
  mode: ChartMode;
  /** Output of buildFinalChartData: genre -> topK slots, null = empty cell. */
  final: Record<string, readonly (Rankable | null)[]>;
  topK: number;
  // /current context:
  season?: string;
  year?: number;
  // /bayes context:
  m?: number;
  c?: number;
  /** Deterministic clock for the /bayes footer (defaults to now). */
  now?: Date;
}

/** Fixed-2-decimal, finite-guarded. Throws on a non-finite value so the page
 * fails loudly into the fan-out's failed list rather than leaking `>NaN<`. */
function fx2(x: number, field: string): string {
  if (!Number.isFinite(x)) {
    throw new Error(`non-finite ${field} in chart cell: ${x}`);
  }
  return x.toFixed(2);
}

/** One clean dark-theme stylesheet for all four charts (not byte-pinned). */
const CHART_CSS =
  `body{font-family:sans-serif;margin:20px;background-color:#121212;color:#e0e0e0}
h1{text-align:center;color:#e0e0e0}
.info-text{text-align:center;color:#aaa;font-size:.9em;margin-bottom:15px}
.table-container{width:100%;overflow-x:auto;margin:20px 0}
table{border-collapse:collapse;margin:0 auto;min-width:1200px;border:1px solid #444}
th,td{border:1px solid #444;padding:5px;text-align:center;vertical-align:top;min-width:120px}
th{background-color:#333;color:#e0e0e0;font-size:14px;word-wrap:break-word;position:sticky;top:0;z-index:10}
td{height:auto;padding-bottom:10px;background-color:#1e1e1e}
img{max-width:100px;max-height:140px;display:block;margin:0 auto 5px auto;border:1px solid #555}
.title-text{font-size:11px;line-height:1.2;max-height:3.6em;overflow:hidden;margin:0 2px;color:#c0c0c0;overflow-wrap:break-word}
.rank-header{width:40px;min-width:40px;font-weight:bold;background-color:#3a3a3a;color:#e0e0e0;position:sticky;left:0;z-index:11;border-right:1px solid #555}
a{color:inherit;text-decoration:none;display:block}
.tooltip{position:relative;display:inline-block}
.tooltip .tooltiptext{visibility:hidden;width:180px;background-color:#f0f0f0;color:#111;text-align:center;border-radius:6px;padding:5px 8px;position:absolute;z-index:15;bottom:110%;left:50%;margin-left:-90px;opacity:0;transition:opacity .3s;font-size:12px;border:1px solid #ccc;white-space:normal;word-wrap:break-word}
.tooltip:hover .tooltiptext{visibility:visible;opacity:1}`;

interface ChartMeta {
  title: string;
  h1: string;
  infoText?: string;
  footer?: string;
  /** Tooltip lines for one cell (already-safe short strings, joined by <br>). */
  tooltip: (a: ChartRow) => string[];
}

function chartMeta(input: ChartRenderInput): ChartMeta {
  const k = input.topK;
  switch (input.mode) {
    case "chart":
      return {
        title: `Top ${k} Anime by Genre - Чатика АнимеДочки`,
        h1: `Top ${k} Anime by Genre (Based on User List Scores) - ` +
          `Чатика АнимеДочки`,
        tooltip: (a) => [
          `Avg: ${fx2(a.average_score, "average_score")} ` +
          `(${a.votes} votes)`,
        ],
      };
    case "current": {
      const season = input.season ?? "";
      const year = input.year ?? 0;
      const cap = season
        ? season[0].toUpperCase() + season.slice(1).toLowerCase()
        : season;
      return {
        title: `Top ${k} Anime of ${cap} ${year} by Genre`,
        h1: `Top ${k} Anime of ${cap} ${year} by Genre`,
        tooltip: (a) => [
          `Avg: ${fx2(a.average_score, "average_score")} ` +
          `(${a.votes} votes)`,
        ],
      };
    }
    case "fresh":
      return {
        title: `Top ${k} Anime by Genre (Season Penalized) - Чатика АнимеДочки`,
        h1: `Top ${k} Anime by Genre (Season Penalized Scores) - ` +
          `Чатика АнимеДочки`,
        tooltip: (a) => [
          `Score: ${fx2(a.penalized_score ?? a.average_score, "penalized")} ` +
          `(${fx2(a.average_score, "average_score")})`,
          `Votes: ${a.votes} | Year: ${a.start_year ?? "N/A"}`,
        ],
      };
    case "bayes": {
      const m = input.m ?? 5;
      const c = input.c ?? 50;
      const now = input.now ?? new Date();
      return {
        title: `Чатика АнимеДочки - Топ ${k} по жанрам (Bayesian Rating)`,
        h1: `Чатика АнимеДочки - Топ ${k} по жанрам (Bayesian Rating)`,
        infoText: `Ratings adjusted using Bayesian average (m=${m}, ` +
          `global avg C=${fx2(c, "C")}/100). Higher 'm' requires more votes ` +
          `for confidence.`,
        footer: `Generated on: ${now.toISOString()}`,
        tooltip: (a) => [
          `Bayesian: ${fx2(a.bayesian_rating ?? 0, "bayesian")}/100`,
          `Avg: ${fx2(a.average_score, "average_score")}/100`,
          `Votes: ${a.votes}`,
        ],
      };
    }
  }
}

function cell(a: ChartRow | null, meta: ChartMeta): string {
  if (!a) return "        <td></td>\n";
  const title = esc(a.title);
  const lines = meta.tooltip(a).map(esc);
  const span = [title, ...lines].join("<br>");
  const attr = [title, ...lines].join("\n");
  const cover = a.cover_url;
  const id = a.media_id;
  if (cover && id) {
    const url = `https://anilist.co/anime/${esc(id)}`;
    return `        <td>
          <div class="tooltip">
            <a href="${esc(url)}" target="_blank" title="View on AniList">
              <img src="${esc(cover)}" alt="${title}" title="${attr}">
            </a>
            <span class="tooltiptext">${span}</span>
          </div>
          <div class="title-text">${title}</div>
        </td>\n`;
  }
  if (cover) {
    return `        <td>
          <div class="tooltip">
            <img src="${esc(cover)}" alt="${title}" title="${attr}">
            <span class="tooltiptext">${span}</span>
          </div>
          <div class="title-text">${title}</div>
        </td>\n`;
  }
  return `        <td><div class="title-text">${title}<br>(No Poster)</div></td>\n`;
}

/** Render one genre chart to a full HTML page. */
export function renderChart(input: ChartRenderInput): string {
  const meta = chartMeta(input);
  const genres = Object.keys(input.final).slice().sort();
  const k = input.topK;

  let head = "";
  for (const g of genres) head += `                <th>${esc(g)}</th>\n`;

  let body = "";
  for (let rank = 0; rank < k; rank++) {
    body += `            <tr>\n` +
      `                <td class="rank-header">${rank + 1}</td>\n`;
    for (const g of genres) {
      const list = input.final[g] ?? [];
      body += cell((list[rank] ?? null) as ChartRow | null, meta);
    }
    body += `            </tr>\n`;
  }

  const info = meta.infoText
    ? `\n    <p class="info-text">${esc(meta.infoText)}</p>`
    : "";
  const foot = meta.footer
    ? `\n    <p style="text-align:center;margin-top:20px;font-size:.8em;` +
      `color:#888">${esc(meta.footer)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(meta.title)}</title>
    <style>
${CHART_CSS}
    </style>
</head>
<body>
    <h1>${esc(meta.h1)}</h1>${info}
    <div class="table-container">
    <table>
        <thead>
            <tr>
                <th class="rank-header">Rank</th>
${head}            </tr>
        </thead>
        <tbody>
${body}        </tbody>
    </table>
    </div>${foot}
</body>
</html>
`;
}

/**
 * The /bayes page's sidecar JSON (anilist_chart_bayesian.py:528 save_json_output).
 * Serialises the FULL per-genre sorted map BEFORE de-duplication, one record per
 * title, with the AniList URL derived from the id. This is the 7th artifact.
 */
export function renderBayesJson(
  genreMap: Record<string, readonly Rankable[]>,
): string {
  const out: Record<string, unknown[]> = {};
  for (const [genre, list] of Object.entries(genreMap)) {
    out[genre] = list.map((a) => ({
      id: a.media_id,
      title: a.title,
      bayesian_rating: a.bayesian_rating ?? 0,
      avg_score: a.average_score,
      votes: a.votes,
      cover_image: a.cover_url ?? null,
      anilist_url: `https://anilist.co/anime/${a.media_id}`,
    }));
  }
  return JSON.stringify(out, null, 4);
}
