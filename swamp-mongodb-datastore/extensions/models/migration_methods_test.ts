// RED tests for the maintenance model's migration surface: the four new
// methods exist, their argument schemas default safely (dry-run on, force
// off), and the `migration` resource spec is declared.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { model as modelTyped } from "./maintenance.ts";

interface Schema {
  parse(v: unknown): Record<string, unknown>;
}
interface Method {
  description: string;
  arguments: Schema;
}
const model = modelTyped as unknown as {
  methods: Record<string, Method>;
  resources: Record<string, { schema: Schema; description: string }>;
};

Deno.test("maintenance: fold_namespace_prefix defaults to dry-run, 30-minute guard, no force", () => {
  const m = model.methods.fold_namespace_prefix;
  assert(m !== undefined, "method missing");
  const args = m.arguments.parse({ namespaces: ["dev-tmp-swamp"] });
  assertEquals(args.dryRun, true);
  assertEquals(args.recentWriterMinutes, 30);
  assertEquals(args.force, false);
  assertEquals(
    m.arguments.parse({ namespaces: ["x"], dryRun: false, force: true }).force,
    true,
  );
});

Deno.test("maintenance: prefix_namespace requires `since` and defaults to dry-run", () => {
  const m = model.methods.prefix_namespace;
  assert(m !== undefined, "method missing");
  assertThrows(() => m.arguments.parse({ namespaces: ["x"] }));
  const args = m.arguments.parse({
    namespaces: ["x"],
    since: "2026-09-02T12:00:00Z",
  });
  assertEquals(args.dryRun, true);
});

Deno.test("maintenance: import_control_records requires namespace and controlDir, defaults to dry-run", () => {
  const m = model.methods.import_control_records;
  assert(m !== undefined, "method missing");
  assertThrows(() => m.arguments.parse({ namespace: "x" }));
  const args = m.arguments.parse({
    namespace: "x",
    controlDir: "/workspace/.swamp/datastore/_control",
  });
  assertEquals(args.dryRun, true);
});

Deno.test("maintenance: revert_migration requires runId and namespace, defaults dry-run on and force off", () => {
  const m = model.methods.revert_migration;
  assert(m !== undefined, "method missing");
  assertThrows(() => m.arguments.parse({ namespace: "x" }));
  const args = m.arguments.parse({ namespace: "x", runId: "run-1" });
  assertEquals(args.dryRun, true);
  assertEquals(args.force, false);
});

Deno.test("maintenance: a `migration` resource spec is declared and accepts a fold result", () => {
  const spec = model.resources.migration;
  assert(spec !== undefined, "resource spec missing");
  const parsed = spec.schema.parse({
    namespace: "dev-tmp-swamp",
    kind: "fold",
    runId: "run-1",
    dryRun: true,
    refused: null,
    counts: { scanned: 3, droppedEqual: 1 },
    startedAt: "2026-09-02T12:00:00Z",
  });
  assertEquals(parsed.kind, "fold");
});

Deno.test("maintenance: fold and prefix accept legacyPrefix (the core namespace) and default it to empty", () => {
  const fold = model.methods.fold_namespace_prefix.arguments.parse({
    namespaces: ["parity"],
  });
  assertEquals(fold.legacyPrefix, "");
  const foldExplicit = model.methods.fold_namespace_prefix.arguments.parse({
    namespaces: ["parity"],
    legacyPrefix: "parity-a",
  });
  assertEquals(foldExplicit.legacyPrefix, "parity-a");
  const prefix = model.methods.prefix_namespace.arguments.parse({
    namespaces: ["parity"],
    since: "2026-09-02T12:00:00Z",
    legacyPrefix: "parity-a",
  });
  assertEquals(prefix.legacyPrefix, "parity-a");
});
