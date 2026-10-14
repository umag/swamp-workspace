/**
 * Shared harness for the @magistr/ns-international suites: a fake method
 * context (records `writeResource`, serves `dataRepository.getContent` from an
 * in-memory store) and a `fetch` stub that routes on path and records each
 * call as an eager snapshot (method, URL, headers) — never a cloned Request,
 * which would leak a teed body stream per call under a high FC_NUM_RUNS soak.
 *
 * Named `_test.ts` so swamp's model loader skips it and `deno test` runs it
 * as a file with no tests.
 */

export const BASE = "https://ns.example/reisinformatie-api/api";
export const API_KEY = "test-key-0123456789";
export const GLOBAL_ARGS = {
  apiKey: API_KEY,
  baseUrl: BASE,
  userAgent: "swamp-ns-international/test",
};

export type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

export function makeCtx(
  opts: {
    globalArgs?: Record<string, unknown>;
    stored?: Record<string, unknown>;
    getContentThrows?: boolean;
  } = {},
) {
  const written: Written[] = [];
  const store: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(opts.stored ?? {})) {
    store[k] = new TextEncoder().encode(
      typeof v === "string" ? v : JSON.stringify(v),
    );
  }
  return {
    written,
    ctx: {
      globalArgs: (opts.globalArgs ?? GLOBAL_ARGS) as typeof GLOBAL_ARGS,
      modelType: "@magistr/ns-international",
      modelId: "ns-test",
      writeResource: (
        spec: string,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        written.push({ spec, name, payload });
        return Promise.resolve({ name });
      },
      dataRepository: {
        getContent: (_type: string, _id: string, name: string) => {
          if (opts.getContentThrows) {
            return Promise.reject(new Error("datastore unavailable"));
          }
          return Promise.resolve(store[name] ?? null);
        },
      },
    },
  };
}

export type Call = {
  method: string;
  url: URL;
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

/**
 * Replaces `globalThis.fetch` (and silences `console.log`) for the duration
 * of `fn`. Every call is snapshotted into `calls` before `route` sees it.
 */
export async function withFetch<T>(
  route: Route,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  const originalLog = console.log;
  const stub: typeof globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = { method: init?.method ?? "GET", url, headers };
    calls.push(call);
    return Promise.resolve(route(call));
  };
  globalThis.fetch = stub;
  console.log = () => {};
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    console.log = originalLog;
  }
}

/** A route that answers fixed bodies per path suffix, 404 otherwise. */
export function table(map: Record<string, () => Response>): Route {
  return (call) => {
    for (const [suffix, h] of Object.entries(map)) {
      if (call.url.pathname.endsWith(suffix)) return h();
    }
    return text(`unrouted ${call.url.pathname}`, 404);
  };
}
