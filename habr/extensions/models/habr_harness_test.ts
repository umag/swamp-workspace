/**
 * Shared harness for the @magistr/habr suites: a fake method context that
 * records `writeResource` calls, and a `fetch` stub that routes on path and
 * records each call as an eager snapshot (URL, redirect mode, headers) —
 * never a cloned Request, which would leak a teed body stream per call under
 * a high FC_NUM_RUNS soak.
 *
 * Named `_test.ts` so swamp's model loader skips it and `deno test` runs it
 * as a file with no tests.
 */

export const BASE = "https://habr.example";
export const GLOBAL_ARGS = { baseUrl: BASE, timeoutMs: 5000 };

export type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

export function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (
        spec: string,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        written.push({ spec, name, payload });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

export type Call = {
  url: URL;
  redirect: string | undefined;
  headers: Record<string, string>;
};

export type Route = (call: Call) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function text(body: string, status = 200): Response {
  return new Response(body, { status });
}

export function redirect(location: string | null, status = 302): Response {
  const headers = new Headers();
  if (location !== null) headers.set("location", location);
  return new Response(null, { status, headers });
}

/**
 * Replaces `globalThis.fetch` for the duration of `fn`. Every call is
 * snapshotted into `calls` before `route` sees it.
 */
export async function withFetch<T>(
  route: Route,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  const stub: typeof globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url,
    );
    const call: Call = {
      url,
      redirect: init?.redirect,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    return Promise.resolve(route(call));
  };
  globalThis.fetch = stub;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A route for the feed endpoint (keyed by `page` query param) and the
 * single-article endpoint (keyed by id), 404 otherwise.
 */
export function habrRoute(opts: {
  pages?: Record<string, unknown>;
  articles?: Record<string, unknown>;
}): Route {
  return (call) => {
    const p = call.url.pathname;
    if (p === "/kek/v2/articles/" && opts.pages) {
      const body = opts.pages[call.url.searchParams.get("page") ?? ""];
      if (body !== undefined) return json(body);
    }
    const m = p.match(/^\/kek\/v2\/articles\/(\d+)\/$/);
    if (m && opts.articles && opts.articles[m[1]] !== undefined) {
      return json(opts.articles[m[1]]);
    }
    return text(`unrouted ${p}${call.url.search}`, 404);
  };
}
