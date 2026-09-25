import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CATALOG_EXPORT_BASENAME,
  catalogRowKey,
  type CatalogRowsStore,
  iterateExportRows,
  readForeignCatalog,
  syncCatalogRows,
} from "./catalog_rows.ts";
import { FakeCollection } from "./test_fakes.ts";

function row(name: string, version: number, isLatest = 1, tags = "{}") {
  return {
    namespace: "ns",
    type_normalized: "@a/b",
    model_id: "m1",
    data_name: name,
    id: `${name}-${version}`,
    version,
    is_latest: isLatest,
    model_name: "model",
    spec_name: "spec",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 10,
    created_at: "2026-09-25T00:00:00.000Z",
    tags,
    owner_ref: "m1",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
  };
}

type Row = ReturnType<typeof row>;

// Same bytes core's writeCatalogExport produces: compact rows, `,`-joined.
async function writeExport(root: string, rows: Row[]): Promise<void> {
  await Deno.writeTextFile(
    `${root}/${CATALOG_EXPORT_BASENAME}`,
    `[${rows.map((r) => JSON.stringify(r)).join(",")}]\n`,
  );
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "catalog-rows-test-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function store(): FakeCollection & CatalogRowsStore {
  return new FakeCollection("t_default_r_ns_catalog") as
    & FakeCollection
    & CatalogRowsStore;
}

function upserts(c: FakeCollection): number {
  return c.writes
    .filter((w) => w.op === "bulkWrite")
    .flatMap((w) => w.args as Record<string, unknown>[])
    .filter((op) => "updateOne" in op).length;
}

Deno.test("iterateExportRows splits rows whose strings hold braces, commas and escapes", async () => {
  await withRoot(async (root) => {
    const tricky = row("x", 1, 1, '{"k":"},{\\"a\\":[1,2]}"}');
    await writeExport(root, [tricky, row("y", 2)]);
    const raws: string[] = [];
    for await (
      const raw of iterateExportRows(`${root}/${CATALOG_EXPORT_BASENAME}`, 7)
    ) raws.push(raw);
    assertEquals(raws.map((r) => JSON.parse(r)), [tricky, row("y", 2)]);
  });
});

Deno.test("iterateExportRows yields nothing for an empty export", async () => {
  await withRoot(async (root) => {
    await writeExport(root, []);
    const raws: string[] = [];
    for await (
      const raw of iterateExportRows(`${root}/${CATALOG_EXPORT_BASENAME}`)
    ) raws.push(raw);
    assertEquals(raws, []);
  });
});

Deno.test("syncCatalogRows: first sync upserts one document per row, keyed by the catalog primary key", async () => {
  await withRoot(async (root) => {
    const c = store();
    await writeExport(root, [row("a", 1), row("b", 1)]);
    assertEquals(await syncCatalogRows(c, root), 2);
    assertEquals(c.docs().map((d) => d._id), [
      catalogRowKey(row("a", 1)),
      catalogRowKey(row("b", 1)),
    ]);
    const { _id, h, ...fields } = c.docs()[0];
    assert(typeof h === "number" && _id !== undefined);
    assertEquals(fields, row("a", 1));
  });
});

Deno.test("syncCatalogRows: an unchanged export is a no-op — no reads of the rows, no writes", async () => {
  await withRoot(async (root) => {
    const c = store();
    await writeExport(root, [row("a", 1)]);
    await syncCatalogRows(c, root);
    const writesBefore = c.writes.length;
    assertEquals(await syncCatalogRows(c, root), 0);
    assertEquals(c.writes.length, writesBefore);
  });
});

Deno.test("syncCatalogRows: a rewrite pushes only the changed and new rows", async () => {
  await withRoot(async (root) => {
    const c = store();
    await writeExport(root, [row("a", 1), row("b", 1)]);
    await syncCatalogRows(c, root);
    const before = upserts(c);
    // New version of `a` arrives: v1 loses is_latest, v2 is new; `b` untouched.
    await writeExport(root, [row("a", 1, 0), row("b", 1), row("a", 2)]);
    assertEquals(await syncCatalogRows(c, root), 2);
    assertEquals(upserts(c) - before, 2);
    const byId = new Map(c.docs().map((d) => [d._id, d]));
    assertEquals(byId.get(catalogRowKey(row("a", 1)))?.is_latest, 0);
    assert(byId.has(catalogRowKey(row("a", 2))));
  });
});

Deno.test("syncCatalogRows: a row this host pushed and no longer holds is deleted", async () => {
  await withRoot(async (root) => {
    const c = store();
    await writeExport(root, [row("a", 1), row("b", 1)]);
    await syncCatalogRows(c, root);
    await writeExport(root, [row("a", 1)]);
    assertEquals(await syncCatalogRows(c, root), 1);
    assertEquals(c.docs().map((d) => d._id), [catalogRowKey(row("a", 1))]);
  });
});

Deno.test("syncCatalogRows: a host's first sync never deletes rows other peers pushed", async () => {
  await withRoot(async (root) => {
    const c = store();
    // Another peer already published `peer-only`, and `a` identical to ours.
    const peerRoot = await Deno.makeTempDir({ prefix: "catalog-rows-peer-" });
    try {
      await writeExport(peerRoot, [row("a", 1), row("peer-only", 1)]);
      await syncCatalogRows(c, peerRoot);
    } finally {
      await Deno.remove(peerRoot, { recursive: true });
    }
    const before = upserts(c);
    await writeExport(root, [row("a", 1)]);
    assertEquals(await syncCatalogRows(c, root), 0);
    assertEquals(upserts(c) - before, 0, "identical remote row not rewritten");
    assert(c.store.has(catalogRowKey(row("peer-only", 1))));
  });
});

Deno.test("syncCatalogRows: an emptied remote collection is repopulated despite local state", async () => {
  await withRoot(async (root) => {
    const c = store();
    await writeExport(root, [row("a", 1)]);
    await syncCatalogRows(c, root);
    c.store.clear();
    await writeExport(root, [row("a", 1), row("b", 1)]);
    assertEquals(await syncCatalogRows(c, root), 2);
    assertEquals(c.docs().length, 2);
  });
});

Deno.test("syncCatalogRows: no export on disk means nothing to do", async () => {
  await withRoot(async (root) => {
    const c = store();
    assertEquals(await syncCatalogRows(c, root), 0);
    assertEquals(c.writes.length, 0);
  });
});

Deno.test("syncCatalogRows: a failed write leaves state untouched so the next push retries", async () => {
  await withRoot(async (root) => {
    const c = store();
    await writeExport(root, [row("a", 1)]);
    c.failNextBulkWrite = new Error("network");
    let threw = false;
    try {
      await syncCatalogRows(c, root);
    } catch {
      threw = true;
    }
    assert(threw);
    assertEquals(await syncCatalogRows(c, root), 1);
    assert(c.store.has(catalogRowKey(row("a", 1))));
  });
});

Deno.test("readForeignCatalog returns the stored rows without the bookkeeping fields", async () => {
  await withRoot(async (root) => {
    const c = store();
    await writeExport(root, [row("a", 1), row("b", 2)]);
    await syncCatalogRows(c, root);
    assertEquals(await readForeignCatalog(c), [row("a", 1), row("b", 2)]);
    assertEquals(await readForeignCatalog(store()), []);
  });
});
