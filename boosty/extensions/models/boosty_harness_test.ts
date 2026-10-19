/**
 * Shared harness for the @magistr/boosty suites: a fake method context that
 * records `writeResource` calls, a `fetch` stub that routes on URL and
 * snapshots each call, and a Boosty post-feed route builder.
 *
 * Named `_test.ts` so swamp's model loader skips it and `deno test` runs it
 * as a file with no tests.
 */

export type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

export function makeCtx(globalArgs: Record<string, unknown> = {}) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      logger: { info: () => {}, warn: () => {} },
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

export type Call = { url: URL; headers: Record<string, string> };
export type Route = (call: Call) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function png(status = 200): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status,
    headers: { "Content-Type": "image/png" },
  });
}

/** Replaces `globalThis.fetch` for the duration of `fn`. */
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

/** A text block as the API serves it. */
export function textBlock(text: string, end = false, style = "unstyled") {
  return {
    type: "text",
    content: JSON.stringify([text, style, []]),
    modificator: end ? "BLOCK_END" : "",
  };
}

export function imageBlock(id: string, url?: string) {
  return {
    type: "image",
    id,
    url: url ?? `https://images.boosty.to/image/${id}?w=800`,
  };
}

export function post(
  id: string,
  title: string,
  opts: {
    createdAt?: number;
    hasAccess?: boolean;
    data?: unknown[];
    teaser?: unknown[];
    tags?: string[];
  } = {},
) {
  return {
    id,
    title,
    createdAt: opts.createdAt ?? 1700000000,
    hasAccess: opts.hasAccess ?? true,
    data: opts.data ?? [textBlock(`body of ${title}`, true)],
    teaser: opts.teaser ?? [],
    tags: (opts.tags ?? []).map((t) => ({ title: t })),
  };
}

/**
 * Routes the post feed: pages are served in order, keyed by the `offset`
 * query param ("" for the first page). Image URLs on images.boosty.to get a
 * PNG; anything else is a 404.
 */
export function boostyRoute(pages: unknown[][]): Route {
  return (call) => {
    if (call.url.hostname === "api.boosty.to") {
      if (call.url.pathname === "/v1/user/current") {
        return call.headers["authorization"]
          ? json({ id: 1, name: "Tester" })
          : json({ error: "unauthorized" }, 401);
      }
      if (/^\/v1\/blog\/[^/]+\/post\/$/.test(call.url.pathname)) {
        const off = call.url.searchParams.get("offset") ?? "";
        const idx = off === "" ? 0 : Number(off);
        const data = pages[idx] ?? [];
        const isLast = idx >= pages.length - 1;
        return json({
          data,
          extra: { isLast, offset: isLast ? "" : String(idx + 1) },
        });
      }
    }
    if (call.url.hostname === "images.boosty.to") return png();
    return json({ error: "unrouted" }, 404);
  };
}

export async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "boosty-test-" });
}

export async function listDir(path: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(path)) out.push(e.name);
  return out.sort();
}
