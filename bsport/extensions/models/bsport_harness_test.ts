/**
 * Shared harness for the @magistr/bsport suites: a fake method context that
 * records `writeResource` calls, and a `fetch` stub that routes on method +
 * path and records each call as an eager snapshot (method, URL, headers,
 * parsed JSON body) — never a cloned Request, which would leak a teed body
 * stream per call under a high FC_NUM_RUNS soak.
 *
 * Named `_test.ts` so swamp's model loader skips it and `deno test` runs it
 * as a file with no tests.
 */

export const BASE = "https://api.bsport.example";
export const TOKEN = "tok-SECRET-abc123";
export const GLOBAL_ARGS: Record<string, unknown> = {
  token: TOKEN,
  baseUrl: BASE,
  companyId: "1234",
  memberId: "777",
  consumerId: "88001",
  timeoutMs: 15000,
  maxRetries: 2,
};

export type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

export function makeCtx(
  globalArgs: Record<string, unknown> = GLOBAL_ARGS,
) {
  const written: Written[] = [];
  const logs: string[] = [];
  return {
    written,
    logs,
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
      logger: {
        info: (msg: string) => {
          logs.push(msg);
        },
        warning: (msg: string) => {
          logs.push(msg);
        },
      },
    },
  };
}

export type Call = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
};

export type Route = (call: Call) => Response | Promise<Response>;

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function text(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
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
    const raw = init?.body;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
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

/** A route that answers fixed bodies per `METHOD path`, 404 otherwise. */
export function table(map: Record<string, (call: Call) => Response>): Route {
  return (call) => {
    const key = `${call.method} ${call.url.pathname}`;
    const h = map[key];
    if (!h) return text(`unrouted ${key}`, 404);
    return h(call);
  };
}

/** A DRF page envelope around `results`. */
export function page(
  results: unknown[],
  next: string | null = null,
): Record<string, unknown> {
  return { count: results.length, next, previous: null, results };
}
