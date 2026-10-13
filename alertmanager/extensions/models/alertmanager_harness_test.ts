/**
 * Shared harness for the @magistr/alertmanager suites: a fake method context
 * that records `writeResource` calls, and a `fetch` stub that routes on
 * method + path and records each call as an eager snapshot (method, URL,
 * parsed JSON body) — never a cloned Request, which would leak a teed body
 * stream per call under a high FC_NUM_RUNS soak.
 *
 * Named `_test.ts` so swamp's model loader skips it and `deno test` runs it
 * as a file with no tests.
 */

export const BASE = "http://am.example:9093";
export const GLOBAL_ARGS = { url: BASE, timeoutMs: 15000 };

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
  method: string;
  url: URL;
  body: unknown;
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
    const call: Call = {
      method: init?.method ?? "GET",
      url,
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
export function table(map: Record<string, () => Response>): Route {
  return (call) => {
    const key = `${call.method} ${call.url.pathname}`;
    const h = map[key];
    if (!h) return text(`unrouted ${key}`, 404);
    return h();
  };
}
