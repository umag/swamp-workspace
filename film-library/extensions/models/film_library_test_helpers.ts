/**
 * Shared test doubles for @magistr/film-library: a listing builder in the
 * LIST_SCRIPT wire format, a fake method context, and an ssh stub.
 */
import type { MatchEntry } from "./film_library.ts";

/** One listed entry: [relPath, "d"|"f", sizeBytes]. */
export type Row = [string, "d" | "f", number?];

/** Encode rows exactly as LIST_SCRIPT prints them (US fields, RS records). */
export function listing(root: string, rows: Row[], missing: string[] = []) {
  let out = `R\x1f${root}\x1e`;
  for (const [rel, t, size] of rows) {
    out += `E\x1f${t === "d" ? "directory" : "regular file"}\x1f${
      size ?? 0
    }\x1f1700000000\x1f${root}/${rel}\x1e`;
  }
  for (const m of missing) out += `M\x1f${m}\x1e`;
  return out;
}

/** Fake swamp context: own resources in `store`, other models' rows in
 * `models` (by instance → spec → rows). */
export function fakeContext(
  globalArgs: Record<string, unknown>,
  models: Record<string, Record<string, unknown[]>> = {},
  store: Record<string, unknown> = {},
) {
  const writes: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const deletes: string[] = [];
  const specOf = new Map<string, string>(
    Object.entries((store.__specs ?? {}) as Record<string, string>),
  );
  return {
    writes,
    deletes,
    store,
    context: {
      globalArgs: { host: "h", ...globalArgs },
      logger: { info: (_m: string) => {} },
      readResource: (name: string) => Promise.resolve(store[name] ?? null),
      readModelData: (inst: string, spec: string) =>
        Promise.resolve(models[inst]?.[spec] ?? []),
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data: structuredClone(data) });
        specOf.set(name, spec);
        store[name] = structuredClone(data);
        return Promise.resolve({ name, spec });
      },
      modelType: "@magistr/film-library",
      modelId: "test-model",
      dataRepository: {
        findAllForModel: (_type: string, _id: string) =>
          Promise.resolve(
            [...specOf].map(([name, specName]) => ({
              name,
              tags: { specName },
            })),
          ),
      },
      deleteResource: (name: string) => {
        deletes.push(name);
        specOf.delete(name);
        delete store[name];
        return Promise.resolve();
      },
    },
  };
}

/** A tmdb match row as readModelData returns it. */
export function matchRow(
  name: string,
  entries: Partial<MatchEntry>[],
  version = 1,
) {
  return {
    name,
    version,
    attributes: {
      entries: entries.map((e) => ({
        status: "unmatched",
        score: null,
        tmdbId: null,
        candidates: [],
        error: null,
        ...e,
      })),
    },
  };
}

/** A typesafe-batch triageBatch row. */
export function jevRow(
  name: string,
  results: { id: string; answers: Record<string, unknown> }[],
  evaluatedAt = "2026-10-08T00:00:00Z",
) {
  return {
    name,
    version: 1,
    attributes: { results, failures: [], evaluatedAt },
  };
}

/** Replace Deno.Command with a stub returning `stdout`; captures args/stdin. */
export function stubSsh(stdout: string, success = true) {
  const original = Deno.Command;
  const seen: { args: string[]; stdin: string }[] = [];
  class FakeCommand {
    #args: string[];
    #stdin = "";
    constructor(_cmd: string, opts: { args: string[] }) {
      this.#args = opts.args;
    }
    spawn() {
      const chunks: Uint8Array[] = [];
      const setStdin = (s: string) => (this.#stdin = s);
      return {
        stdin: new WritableStream<Uint8Array>({
          write(c) {
            chunks.push(c);
          },
          close() {
            setStdin(new TextDecoder().decode(
              new Uint8Array(chunks.flatMap((c) => [...c])),
            ));
          },
        }),
        output: () => {
          seen.push({ args: this.#args, stdin: this.#stdin });
          return Promise.resolve({
            success,
            stdout: new TextEncoder().encode(stdout),
            stderr: new TextEncoder().encode(success ? "" : "boom"),
          });
        },
      };
    }
  }
  Object.defineProperty(Deno, "Command", {
    value: FakeCommand,
    configurable: true,
    writable: true,
  });
  return {
    seen,
    restore: () =>
      Object.defineProperty(Deno, "Command", {
        value: original,
        configurable: true,
        writable: true,
      }),
  };
}
