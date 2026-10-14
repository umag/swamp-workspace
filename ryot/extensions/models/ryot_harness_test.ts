/**
 * Shared harness for the @magistr/ryot suites: a fake method context that
 * records `writeResource` calls and serves `readResource` from a seeded map,
 * a `fetch` stub that records each call as an eager snapshot (method, URL,
 * headers, parsed body) — never a cloned Request, which would leak a teed
 * body stream per call under a high FC_NUM_RUNS soak — and a `Deno.Command`
 * stub standing in for the host `curl` used to scrape Letterboxd pages.
 *
 * Named `_test.ts` so swamp's model loader skips it and `deno test` runs it
 * as a file with no tests.
 */
import { curlTiming } from "./ryot.ts";

// Retries must not sleep in tests.
curlTiming.retryDelayMs = 0;

export const BASE = "https://ryot.example";
export const TOKEN = "tok-secret-123";
export const GLOBAL_ARGS = { baseUrl: BASE, authToken: TOKEN };

export type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

export function makeCtx(
  seeded: Record<string, Record<string, unknown>> = {},
  globalArgs: { baseUrl: string; authToken: string } = GLOBAL_ARGS,
) {
  const written: Written[] = [];
  const store = new Map(Object.entries(seeded));
  return {
    written,
    store,
    ctx: {
      globalArgs,
      writeResource: (
        spec: string,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        written.push({ spec, name, payload });
        store.set(name, payload);
        return Promise.resolve({ spec, name });
      },
      readResource: (name: string) => Promise.resolve(store.get(name) ?? null),
    },
  };
}

export type Call = {
  method: string;
  url: URL;
  headers: Headers;
  /** Parsed JSON for string bodies; the uploaded file's text for FormData. */
  body: unknown;
  fileName?: string;
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

/** Replaces `globalThis.fetch` for the duration of `fn`. */
export async function withFetch<T>(
  route: Route,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  const stub: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url,
    );
    const raw = init?.body;
    let body: unknown;
    let fileName: string | undefined;
    if (typeof raw === "string") body = JSON.parse(raw);
    else if (raw instanceof FormData) {
      const f = raw.get("files[]");
      if (f instanceof File) {
        fileName = f.name;
        body = JSON.parse(await f.text());
      }
    }
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body,
      fileName,
    };
    calls.push(call);
    return route(call);
  };
  globalThis.fetch = stub;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** A Ryot route answering upload and GraphQL with fixed bodies. */
export function ryotRoute(opts: {
  uploadPath?: string;
  gql?: (query: string) => Response;
} = {}): Route {
  return (call) => {
    if (call.method === "POST" && call.url.pathname === "/backend/upload") {
      return json([opts.uploadPath ?? "/tmp/ryot/swamp-films.json"]);
    }
    if (call.method === "POST" && call.url.pathname === "/backend/graphql") {
      const q = (call.body as { query: string }).query;
      return opts.gql ? opts.gql(q) : json({ data: { deployImportJob: "1" } });
    }
    return text(`unrouted ${call.method} ${call.url.pathname}`, 404);
  };
}

/** One recorded `curl` invocation. */
export type CurlCall = { cmd: string; args: string[]; url: string };

/** What a fake curl answers for one URL: body + HTTP status. */
export type CurlReply = { body: string; status: number; success?: boolean };

/** A Letterboxd film page carrying TMDB attributes. */
export function filmPage(tmdbId: number, type = "movie"): string {
  return `<html><body data-tmdb-type="${type}" data-tmdb-id="${tmdbId}">` +
    `</body></html>`;
}

/**
 * Replaces `Deno.Command` for the duration of `fn` with a fake `curl` that
 * answers each URL via `route`, appending the `-w` status marker the model
 * expects.
 */
export async function withCurl<T>(
  route: (url: string) => CurlReply,
  fn: (calls: CurlCall[]) => Promise<T>,
): Promise<T> {
  const calls: CurlCall[] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    constructor(
      private readonly cmd: string,
      private readonly opts: { args: string[] },
    ) {}
    output() {
      const args = this.opts.args;
      const url = args[args.length - 1];
      calls.push({ cmd: this.cmd, args: [...args], url });
      const r = route(url);
      const out = `${r.body}\n<<<HTTP_STATUS:${r.status}>>>`;
      return Promise.resolve({
        success: r.success ?? true,
        code: r.success === false ? 6 : 0,
        stdout: new TextEncoder().encode(out),
        stderr: new Uint8Array(),
      });
    }
  }
  g.Deno.Command = FakeCommand;
  try {
    return await fn(calls);
  } finally {
    g.Deno.Command = original;
  }
}

/** Letterboxd film entry as the snapshot carries it. */
export function film(name: string, id: string, year: number | null = 2000) {
  return { name, year, uri: `https://boxd.it/${id}`, date: null };
}

/** An empty snapshot, overridable per list. */
export function snapshot(parts: {
  ratings?: (ReturnType<typeof film> & { rating: number })[];
  watched?: ReturnType<typeof film>[];
  watchlist?: ReturnType<typeof film>[];
} = {}) {
  return {
    ratings: parts.ratings ?? [],
    watched: parts.watched ?? [],
    watchlist: parts.watchlist ?? [],
  };
}

/** Default import_films args. */
export function importArgs(
  over: Partial<{
    snapshot: ReturnType<typeof snapshot>;
    owned: { tmdbId: number; title?: string }[];
    ownedAsSeen: boolean;
    dryRun: boolean;
    force: boolean;
  }> = {},
) {
  return {
    snapshot: snapshot(),
    owned: [],
    ownedAsSeen: false,
    dryRun: false,
    force: false,
    ...over,
  };
}
