// RED tests for the sidecar's bulk sequence counter, which lets commitPush
// tell whether a bulk invalidation arrived after preparePush walked the tree.
import { assertEquals } from "jsr:@std/assert@1";
import { getSidecar } from "./sidecar.ts";

interface StateWithSeq {
  bulkInvalidated: boolean;
  bulkSeq: number;
}

Deno.test("sidecar: bulkSeq starts at 0 and increments on every bulk invalidation", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sidecar-seq-" });
  const sc = getSidecar(dir);
  try {
    assertEquals((await sc.read() as unknown as StateWithSeq).bulkSeq, 0);
    await sc.recordDirty(undefined);
    assertEquals((await sc.read() as unknown as StateWithSeq).bulkSeq, 1);
    await sc.recordDirty("data/a");
    assertEquals(
      (await sc.read() as unknown as StateWithSeq).bulkSeq,
      1,
      "a per-path mark is not a bulk signal",
    );
    await sc.recordDirty(undefined);
    assertEquals((await sc.read() as unknown as StateWithSeq).bulkSeq, 2);
  } finally {
    await sc.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sidecar: bulkSeq survives clearDirty and is persisted across instances", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sidecar-seq-" });
  const sc = getSidecar(dir);
  try {
    await sc.recordDirty(undefined);
    await sc.clearDirty();
    const s = await sc.read() as unknown as StateWithSeq;
    assertEquals(s.bulkInvalidated, false);
    assertEquals(s.bulkSeq, 1);
    const raw = JSON.parse(
      await Deno.readTextFile(`${dir}/.datastore-sync-state.json`),
    ) as { bulkSeq?: number };
    assertEquals(raw.bulkSeq, 1);
  } finally {
    await sc.close();
    await Deno.remove(dir, { recursive: true });
  }
});
