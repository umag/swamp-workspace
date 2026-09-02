// RED tests for ./path_mapping.ts — the local/remote path mapping keyed on
// swamp core's datastore.namespace (options.namespace), never on the
// extension's config.namespace.
import { assertEquals } from "jsr:@std/assert@1";
import * as pmModule from "./path_mapping.ts";

interface PathMappingModule {
  localRel(remoteRel: string, namespace?: string): string;
  remoteRel(localRel: string, namespace?: string): string;
  stripLegacyPrefix(remoteId: string, namespace?: string): string;
}

function mod(): Promise<PathMappingModule> {
  return Promise.resolve(pmModule as unknown as PathMappingModule);
}

Deno.test("path mapping: solo mode is the identity", async () => {
  const m = await mod();
  assertEquals(
    m.localRel("data/host/vm-1/out/1/raw"),
    "data/host/vm-1/out/1/raw",
  );
  assertEquals(
    m.localRel("data/host/vm-1/out/1/raw", ""),
    "data/host/vm-1/out/1/raw",
  );
  assertEquals(
    m.remoteRel("data/host/vm-1/out/1/raw", undefined),
    "data/host/vm-1/out/1/raw",
  );
});

Deno.test("path mapping: a core namespace is the outermost local segment and absent remotely", async () => {
  const m = await mod();
  assertEquals(
    m.localRel("data/x/1/raw", "dev-tmp-swamp"),
    "dev-tmp-swamp/data/x/1/raw",
  );
  assertEquals(
    m.remoteRel("dev-tmp-swamp/data/x/1/raw", "dev-tmp-swamp"),
    "data/x/1/raw",
  );
});

Deno.test("path mapping: remoteRel of an already tier-relative local path is unchanged (serve without core namespace)", async () => {
  const m = await mod();
  assertEquals(m.remoteRel("data/x/1/raw", "dev-tmp-swamp"), "data/x/1/raw");
});

Deno.test("path mapping: stripLegacyPrefix removes exactly one leading <ns>/ and nothing else", async () => {
  const m = await mod();
  assertEquals(
    m.stripLegacyPrefix("dev-tmp-swamp/data/x", "dev-tmp-swamp"),
    "data/x",
  );
  assertEquals(m.stripLegacyPrefix("data/x", "dev-tmp-swamp"), "data/x");
  assertEquals(
    m.stripLegacyPrefix("dev-tmp-swampx/data/x", "dev-tmp-swamp"),
    "dev-tmp-swampx/data/x",
  );
  assertEquals(
    m.stripLegacyPrefix("dev-tmp-swamp/dev-tmp-swamp/data/x", "dev-tmp-swamp"),
    "dev-tmp-swamp/data/x",
  );
  assertEquals(
    m.stripLegacyPrefix("dev-tmp-swamp/data/x", undefined),
    "dev-tmp-swamp/data/x",
  );
});

// Property: for every path and namespace (including empty), mapping to local
// and back is the identity. The domain is generated independently of any
// constant in the module: random segment counts, random characters that are
// legal in swamp names, namespaces that may equal a path segment.
Deno.test("path mapping: remoteRel(localRel(p, ns), ns) == p for random p and ns", async () => {
  const m = await mod();
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_.@";
  let seed = 20260902;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const segment = () => {
    const len = 1 + Math.floor(rnd() * 12);
    let s = "";
    for (let i = 0; i < len; i++) {
      s += alphabet[Math.floor(rnd() * alphabet.length)];
    }
    return s;
  };
  for (let i = 0; i < 2000; i++) {
    const depth = 1 + Math.floor(rnd() * 8);
    const segs = Array.from({ length: depth }, segment);
    const p = segs.join("/");
    const ns = rnd() < 0.2 ? "" : rnd() < 0.3 ? segs[0] : segment();
    const nsArg = ns === "" ? undefined : ns;
    assertEquals(
      m.remoteRel(m.localRel(p, nsArg), nsArg),
      p,
      `p=${p} ns=${ns}`,
    );
    if (nsArg) assertEquals(m.localRel(p, nsArg).startsWith(`${nsArg}/`), true);
    else assertEquals(m.localRel(p, nsArg), p);
  }
});
