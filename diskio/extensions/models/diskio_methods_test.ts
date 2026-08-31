/**
 * Methods suite for @magistr/diskio: drives each `model.methods.<m>` impl
 * against a scripted SshRunner and an in-memory context, and reads back the
 * resource that was written.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  attributeImpl,
  deviceMapImpl,
  model,
  openFilesImpl,
  readersImpl,
} from "./diskio.ts";
import {
  FD_OUT,
  makeCtx,
  MAP_OUT,
  READERS_OUT,
  routed,
  scripted,
} from "./lib/fixtures.ts";

Deno.test("the model declares four methods and four resources", () => {
  assertEquals(Object.keys(model.methods).sort(), [
    "attribute",
    "device-map",
    "open-files",
    "readers",
  ]);
  assertEquals(Object.keys(model.resources).sort(), [
    "attribution",
    "deviceMap",
    "openFiles",
    "readers",
  ]);
  assertEquals(model.type, "@magistr/diskio");
});

Deno.test("device-map writes deviceMap/current and logs each alias group", async () => {
  const { run } = scripted(MAP_OUT);
  const { ctx, written, logged } = makeCtx();
  await deviceMapImpl(run, ctx);

  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "deviceMap");
  assertEquals(written[0].name, "current");
  assert(logged.some((l) => l === "sdl (disk4) is exported as dm-3, sdl"));
});

Deno.test("readers passes the window through and writes readers/current", async () => {
  const { run, calls } = scripted(READERS_OUT);
  const { ctx, written } = makeCtx();
  await readersImpl(run, { sampleSeconds: 60, topN: 3 }, ctx);

  assertEquals(calls[0].host, "arrayhost");
  assertEquals(calls[0].user, "root");
  assertEquals(written[0].spec, "readers");
  assertEquals((written[0].payload.readers as unknown[]).length, 3);
  assertEquals(written[0].payload.sampleSeconds, 60);
});

Deno.test("open-files names the resource after the path it scanned", async () => {
  const { run } = scripted(FD_OUT);
  const { ctx, written } = makeCtx();
  await openFilesImpl(run, { path: "/mnt/disk4", limit: 40 }, ctx);
  assertEquals(written[0].spec, "openFiles");
  assertEquals(written[0].name, "open-files-mnt-disk4");
});

Deno.test("readers falls back to root when sshUser is unset", async () => {
  const { run, calls } = scripted(READERS_OUT);
  const { ctx } = makeCtx({ sshUser: undefined });
  await readersImpl(run, { sampleSeconds: 15, topN: 5 }, ctx);
  assertEquals(calls[0].user, "root");
});

Deno.test("attribute runs the three probes in order and joins them", async () => {
  const { run, calls } = routed({
    map: MAP_OUT,
    readers: READERS_OUT,
    fds: FD_OUT,
  });
  const { ctx, written, logged } = makeCtx();
  await attributeImpl(
    run,
    { target: "dm-3", sampleSeconds: 20, topN: 6, limit: 5 },
    ctx,
  );

  assertEquals(calls, ["map", "readers", "fds"]);
  const p = written[0].payload;
  assertEquals(written[0].spec, "attribution");
  assertEquals(p.target, "dm-3");
  assertEquals(p.physical, "sdl");
  assertEquals(p.slot, "disk4");
  assertEquals(p.layers, ["dm-3", "sdl"]);
  assertEquals(p.mountpoint, "/mnt/disk4");
  assert(logged[0].includes("dm-3 resolves to sdl"));
});

Deno.test("attribute credits transmission, not the busier off-disk swamp-serve", async () => {
  const { run } = routed({ map: MAP_OUT, readers: READERS_OUT, fds: FD_OUT });
  const { ctx, written } = makeCtx();
  await attributeImpl(
    run,
    { target: "sdl", sampleSeconds: 60, topN: 6, limit: 5 },
    ctx,
  );

  const summary = written[0].payload.summary as string;
  // swamp-serve reads 29.8 MB/s of websockets and holds nothing on disk4.
  assert(summary.includes("Top readers: transmission"));
  assert(!summary.includes("swamp-serve"));

  const readers = written[0].payload.topReaders as Array<
    { container: string | null; onTarget: boolean | null }
  >;
  assertEquals(
    readers.find((r) => r.container === "swamp-serve")!.onTarget,
    false,
  );
  assertEquals(
    readers.find((r) => r.container === "transmission")!.onTarget,
    true,
  );
});

Deno.test("attribute resolves an array slot and a mountpoint, not just a device", async () => {
  for (const target of ["disk4", "/mnt/disk4", "md4p1"]) {
    const { run } = routed({ map: MAP_OUT, readers: READERS_OUT, fds: FD_OUT });
    const { ctx, written } = makeCtx();
    await attributeImpl(
      run,
      { target, sampleSeconds: 5, topN: 3, limit: 3 },
      ctx,
    );
    assertEquals(written[0].payload.physical, "sdl", `target ${target}`);
  }
});

Deno.test("attribute refuses an unknown target with a message that says what to run", async () => {
  const { run } = routed({ map: MAP_OUT, readers: READERS_OUT, fds: FD_OUT });
  const { ctx, written } = makeCtx();
  await assertRejects(
    () =>
      attributeImpl(
        run,
        { target: "sdz", sampleSeconds: 5, topN: 3, limit: 3 },
        ctx,
      ),
    Error,
    "Run device-map to see what exists.",
  );
  assertEquals(written.length, 0, "nothing is written on a failed resolve");
});

Deno.test("attribute skips the fd scan when the disk has no mountpoint", async () => {
  const unmounted = ["DEV|sdz|100||", "SLOT|disk9|sdz"].join("\n");
  const { run, calls } = routed({ map: unmounted, readers: READERS_OUT });
  const { ctx, written } = makeCtx();
  await attributeImpl(
    run,
    { target: "sdz", sampleSeconds: 5, topN: 3, limit: 3 },
    ctx,
  );
  assertEquals(calls, ["map", "readers"]);
  assertEquals(written[0].payload.openFiles, []);
  // onTarget stays null: unevaluated is not the same as "holds nothing".
  const readers = written[0].payload.topReaders as Array<{ onTarget: null }>;
  assert(readers.every((r) => r.onTarget === null));
});
