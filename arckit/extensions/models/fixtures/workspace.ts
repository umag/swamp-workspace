/**
 * Synthetic ArcKit workspace + templates fixture builder shared by the
 * methods/adversarial/coverage/property suites for @magistr/arckit
 * (arckit_workspace.ts). Two SEPARATE `Deno.makeTempDir()` roots:
 *
 *  - `root`         — the governance workspace (`context.globalArgs.path`);
 *    real `Deno.mkdir`/`writeTextFile`/`readDir`/`symlink`, no FS stubbing.
 *  - `templatesDir` — a synthetic stand-in for the bundled `templates/`
 *    directory the real extension ships (`context.extensionFile("templates/…")`
 *    resolves into it). Kept apart from the real bundled `arckit/templates/`
 *    that `arckit_workspace_test.ts` (the contract-fixture) reads — no test
 *    in these four suites ever touches the real bundled directory.
 *
 * All content here is synthetic scaffolding (empty marker files / short
 * placeholder markdown) — there is no real-world corpus to leak.
 */

/** Minimal shape of the runtime `context` the model's `execute()` bodies use. */
export interface FakeContext {
  globalArgs: { path: string };
  logger: { info: (msg: string, fields?: Record<string, unknown>) => void };
  writeResource: (
    spec: string,
    name: string,
    payload: unknown,
  ) => Promise<{ spec: string; name: string }>;
  readResource: (name: string) => Promise<unknown>;
  extensionFile: (rel: string) => string;
}

export interface Written {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
}

export interface LogEntry {
  msg: string;
  fields?: Record<string, unknown>;
}

export interface CtxHandle {
  ctx: FakeContext;
  written: Written[];
  seeded: Map<string, Record<string, unknown>>;
  logs: LogEntry[];
}

/**
 * Build a fresh fake context over `root` (workspace) / `templatesDir`
 * (synthetic bundled-templates stand-in). `writeResource` captures every
 * call AND mirrors the payload into an in-memory `seeded` map keyed on the
 * instance `name` — mirroring the real runtime's `readResource(name)`
 * contract (keyed on instance name only, per this repo's `context.readResource`
 * lesson). A fresh `makeCtx()` call means a fresh (empty) `seeded` map even
 * against the same disk `root` — used deliberately in a few tests/properties
 * to simulate "no prior swamp resource" against a workspace that may already
 * have artifacts on disk.
 */
export function makeCtx(root: string, templatesDir: string): CtxHandle {
  const written: Written[] = [];
  const seeded = new Map<string, Record<string, unknown>>();
  const logs: LogEntry[] = [];
  const ctx: FakeContext = {
    globalArgs: { path: root },
    logger: {
      info: (msg, fields) => {
        logs.push({ msg, fields });
      },
    },
    writeResource: (spec, name, payload) => {
      const entry = { spec, name, payload: payload as Record<string, unknown> };
      written.push(entry);
      seeded.set(name, entry.payload);
      return Promise.resolve({ spec, name });
    },
    readResource: (name) => Promise.resolve(seeded.get(name) ?? null),
    extensionFile: (rel) => `${templatesDir}/${rel}`,
  };
  return { ctx, written, seeded, logs };
}

/** Create the two temp roots, run `fn`, and always clean both up. */
export async function withTempWorkspace(
  fn: (root: string, templatesDir: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "arckit-ws-" });
  const templatesDir = await Deno.makeTempDir({ prefix: "arckit-tpl-" });
  try {
    await fn(root, templatesDir);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(templatesDir, { recursive: true });
  }
}

/** Write one ARC-* (or arbitrary) artifact file under projects/<projectDir>/. */
export async function writeArtifact(
  root: string,
  projectDir: string,
  filename: string,
  content = "# artifact\n",
): Promise<string> {
  const dir = `${root}/projects/${projectDir}`;
  await Deno.mkdir(dir, { recursive: true });
  const full = `${dir}/${filename}`;
  await Deno.writeTextFile(full, content);
  return full;
}

/** Write one synthetic bundled template file under `templatesDir/templates/`. */
export async function writeTemplateFile(
  templatesDir: string,
  relPath: string,
  content = "# template\n",
): Promise<void> {
  const full = `${templatesDir}/templates/${relPath}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, content);
}

/** A minimal Document Control table body carrying a Classification line. */
export function docControlContent(classification: string): string {
  return [
    "# Document",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| **Version** | 1.0 |",
    `| **Classification** | ${classification} |`,
    "",
  ].join("\n");
}

/** Build `ARC-{id}-{docCode}[-{instance}]-v{version}.{format}`. */
export function arcFilename(
  id: string,
  docCode: string,
  version = "1.0",
  format = "md",
  instance?: number,
): string {
  const middle = instance === undefined ? docCode : `${docCode}-${instance}`;
  return `ARC-${id}-${middle}-v${version}.${format}`;
}

export type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (args: unknown, ctx: unknown) => Promise<{ dataHandles: unknown[] }>;
}>;

/**
 * Run a model method by name against a fake context. `model` is accepted as
 * `unknown` and cast internally (never `as typeof <builtin>`, never
 * `explicit-any`) — the real `arckit_workspace.ts` methods each have their
 * own specific zod-inferred `execute(args, context)` signature, so a single
 * uniform call-site type needs a cast rather than a structural function
 * parameter (which `--strictFunctionTypes` would reject).
 *
 * Args are run through `method.arguments.parse()` first — exactly what the
 * real swamp runtime does before calling `execute` — so zod defaults (e.g.
 * `startProject`'s `profile: "standard"`) actually apply. Calling `execute`
 * directly with a raw args object would silently skip every default.
 */
export function run(
  model: unknown,
  name: string,
  args: Record<string, unknown>,
  ctx: FakeContext,
): Promise<{ dataHandles: unknown[] }> {
  const method = (model as { methods: MethodMap }).methods[name];
  return method.execute(method.arguments.parse(args), ctx);
}
