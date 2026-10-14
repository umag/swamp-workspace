/**
 * Shared test doubles for @magistr/tmdb: a host/path-routed fetch stub and
 * a fake swamp method context.
 */
export const FIXTURES = new URL("../../fixtures/", import.meta.url);

/** Load a fixture JSON file as text. */
export function fixture(name: string): string {
  return Deno.readTextFileSync(new URL(name, FIXTURES));
}

/** One recorded request. */
export type Call = { url: URL; headers: Record<string, string> };

/** Route table: first matching predicate answers. */
export type Route = [
  (u: URL) => boolean,
  (u: URL, n: number) => Response | Promise<Response>,
];

/** Install a fetch stub; returns the call log and a restore function. */
export function stubFetch(routes: Route[]): {
  calls: Call[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = Object.fromEntries(
      new Headers(init?.headers ?? {}).entries(),
    );
    calls.push({ url, headers });
    for (const [match, respond] of routes) {
      if (match(url)) return Promise.resolve(respond(url, calls.length));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** JSON response helper. */
export function json(body: string | unknown, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Fake method context capturing writes; readResource serves prior writes. */
export function fakeContext(
  globalArgs: Record<string, unknown>,
  prior: Record<string, unknown> = {},
) {
  const writes: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const store: Record<string, unknown> = { ...prior };
  const logs: string[] = [];
  return {
    writes,
    logs,
    context: {
      globalArgs: {
        minIntervalMs: 0,
        timeoutMs: 5000,
        language: "en-US",
        region: "NL",
        includeAdult: false,
        ...globalArgs,
      },
      logger: { info: (m: string) => logs.push(m) },
      readResource: (name: string) => Promise.resolve(store[name] ?? null),
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data: structuredClone(data) });
        store[name] = structuredClone(data);
        return Promise.resolve({ name, spec });
      },
    },
  };
}

/** A v4-style token (not 32 hex) used across tests. */
export const TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-token-value.signature";
