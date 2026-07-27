// Publish: put the rendered artifacts onto the disk nginx serves.
//
// `render` writes HTML into swamp data artifacts (renderedPage, keyed by page);
// nginx serves FILES from a host directory. This module bridges the two. The
// key -> filename map is the one nginx.conf routes; anything not in it is not a
// servable page and is skipped rather than written to a stray file.
//
// Fan-out semantics mirror run.sh (and the render fan-out): each page is written
// independently, one failure never suppresses the rest, and every write is
// atomic (temp file + rename) so a serving page is never left half-written.

/** render page key -> the filename nginx serves it as (from deploy/nginx.conf). */
export const PAGE_FILES: Record<string, string> = {
  board: "board.html",
  landing: "landing.html",
  chart: "genre_chart.html",
  fresh: "genre_chart_age_penalty.html",
  bayes: "genre_chart_bayesian.html",
  current: "current_season_chart.html",
  "bayes-json": "genre_chart_bayesian.json",
};

export interface PublishPage {
  key: string;
  content: string;
}

export interface PublishResult {
  /** page keys written successfully */
  published: string[];
  /** page keys whose write threw, with the error */
  failed: { key: string; error: string }[];
  /** page keys with no filename mapping (not servable) */
  skipped: string[];
}

/**
 * The remote shell command that writes stdin to `dir/file` atomically: content
 * lands in a temp sibling, then a rename swaps it in, so nginx never serves a
 * partially written file and a failed write leaves the previous file intact.
 * `dir` is operator-supplied so it is single-quoted; `file` comes only from the
 * fixed PAGE_FILES map, never from user input.
 */
export function remoteWriteCommand(dir: string, file: string): string {
  const tmp = `${dir}/.${file}.tmp`;
  return `cat > '${tmp}' && mv -f '${tmp}' '${dir}/${file}'`;
}

/**
 * Write each page through `writer`, independently. A writer that throws marks
 * that page failed and the rest still publish. `writer` is injected so the fan-out
 * is unit-testable without touching SSH; the model supplies the real SSH writer.
 */
export async function publishPages(
  pages: PublishPage[],
  writer: (file: string, content: string) => Promise<void>,
): Promise<PublishResult> {
  const published: string[] = [];
  const failed: { key: string; error: string }[] = [];
  const skipped: string[] = [];

  for (const page of pages) {
    const file = PAGE_FILES[page.key];
    if (!file) {
      skipped.push(page.key);
      continue;
    }
    try {
      await writer(file, page.content);
      published.push(page.key);
    } catch (e) {
      failed.push({
        key: page.key,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { published, failed, skipped };
}
