// Shared fake swamp context for the dieworkwear test suites.
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const PKG = join(dirname(fromFileUrl(import.meta.url)), "..");

/** Read a fixture file as text. */
export function fixture(name: string): string {
  return Deno.readTextFileSync(join(PKG, "fixtures", name));
}

/** In-memory context: writeResource stores JSON, dataRepository reads it back. */
export function makeCtx(globalArgs: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>();
  const writes: { spec: string; name: string; data: unknown }[] = [];
  const ctx = {
    globalArgs: {
      author: "dieworkwear",
      baseUrl: "https://threadreaderapp.com",
      claudeBin: "claude",
      claudeModel: "test-model",
      requestDelayMs: 0,
      ...globalArgs,
    },
    definition: { name: "test" },
    extensionFile: (rel: string) => join(PKG, rel),
    writeResource: (spec: string, name: string, data: unknown) => {
      store.set(name, JSON.parse(JSON.stringify(data)));
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    definitionRepository: {
      findByNameGlobal: () =>
        Promise.resolve({ type: "@magistr/dieworkwear", definition: { id: "x" } }),
    },
    dataRepository: {
      getContent: (_t: string, _i: string, name: string) =>
        Promise.resolve(
          store.has(name)
            ? new TextEncoder().encode(JSON.stringify(store.get(name)))
            : null,
        ),
    },
    logger: { info: () => {} },
  };
  return { ctx, store, writes };
}
