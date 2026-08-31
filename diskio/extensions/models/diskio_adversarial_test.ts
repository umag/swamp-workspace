/**
 * Adversarial suite for @magistr/diskio: hostile input, hostile transport,
 * degenerate host output, and the three defects the LIVE runs of 2026-08-30/31
 * exposed after the first implementation already passed its own tests.
 *
 * Every "live-run" test below is a regression for a bug that shipped green.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  assertSafePath,
  assertSafeTarget,
  attributeImpl,
  FD_SCRIPT,
  probeDeviceMap,
  probeOpenFiles,
  probeReaders,
} from "./diskio.ts";
import {
  decodeScript,
  FD_OUT,
  makeCtx,
  MAP_OUT,
  READERS_OUT,
  routed,
  scripted,
} from "./lib/fixtures.ts";

/* --------------------------------------------------------- hostile input */

Deno.test("path guard rejects everything that is not a plain absolute path", () => {
  assertEquals(assertSafePath("/mnt/disk4"), "/mnt/disk4");
  assertEquals(
    assertSafePath("/mnt/user/Media [2026]/a.mkv"),
    "/mnt/user/Media [2026]/a.mkv",
  );
  for (
    const bad of [
      "relative/path",
      "/mnt/../etc",
      "/mnt\nrm -rf /",
      "/mnt/$(id)",
      "/mnt/`id`",
      "",
      "/mnt/a|b",
      "/mnt/a;b",
    ]
  ) {
    let threw = false;
    try {
      assertSafePath(bad);
    } catch (e) {
      threw = true;
      assert((e as Error).message.startsWith("Refusing to scan"));
    }
    assert(threw, `${JSON.stringify(bad)} must be rejected`);
  }
});

Deno.test("target guard rejects command separators and traversal", () => {
  for (const ok of ["sdl", "dm-3", "md4p1", "disk4", "/mnt/disk4", "nvme0n1"]) {
    assertEquals(assertSafeTarget(ok), ok);
  }
  for (
    const bad of ["sdl;reboot", "../../etc", "a b", "sd$(id)", "x".repeat(129)]
  ) {
    let threw = false;
    try {
      assertSafeTarget(bad);
    } catch {
      threw = true;
    }
    assert(threw, `${JSON.stringify(bad)} must be rejected`);
  }
});

Deno.test("no caller-supplied text ever reaches the remote command line", async () => {
  const { run, calls } = scripted(FD_OUT);
  const nasty = "/mnt/disk4/it's a [test] & more";
  await probeOpenFiles(run, "arrayhost", "root", nasty, [], 40);
  assertEquals(calls.length, 1);
  assert(
    /^echo [A-Za-z0-9+/=]+ \| base64 -d \| bash$/.test(calls[0].command),
    `command must be a lone base64 blob, got: ${calls[0].command}`,
  );
  assert(!calls[0].command.includes(nasty));
});

Deno.test("a rejected target is refused BEFORE any ssh call is made", async () => {
  const { run, calls } = routed({ map: MAP_OUT });
  const { ctx } = makeCtx();
  await assertRejects(() =>
    attributeImpl(
      run,
      { target: "sdl;reboot", sampleSeconds: 5, topN: 3, limit: 3 },
      ctx,
    )
  );
  assertEquals(calls, [], "nothing may be executed on a rejected target");
});

/* ----------------------------------------------------- hostile transport */

Deno.test("a non-zero exit reports the host, the code and the remote stderr", async () => {
  const { run } = scripted("", 255);
  await assertRejects(
    () => probeDeviceMap(run, "arrayhost", "root"),
    Error,
    "diskio probe failed on arrayhost (exit 255)",
  );
});

Deno.test("empty or junk host output yields empty results, never a crash", async () => {
  for (const junk of ["", "\n\n", "garbage", "DEV|", "P|", "F|", "|||"]) {
    const { run } = scripted(junk);
    const map = await probeDeviceMap(run, "arrayhost", "root");
    assertEquals(map.aliasGroups, []);
    const r = await probeReaders(run, "arrayhost", "root", 10, 5, ["shfs"]);
    assertEquals(r.totals.blockReadMBps, 0);
    const f = await probeOpenFiles(
      run,
      "arrayhost",
      "root",
      "/mnt/disk4",
      [],
      5,
    );
    assertEquals(f.files, []);
  }
});

Deno.test("a non-numeric byte counter becomes 0, not NaN", async () => {
  const { run } = scripted("P|1|abc|-|xyz||name|/bin/thing");
  const r = await probeReaders(run, "arrayhost", "root", 10, 5, []);
  for (const v of Object.values(r.totals)) assert(Number.isFinite(v));
  assertEquals(r.readers[0].requestedReadMBps, 0);
});

Deno.test("a zero-length sampling window is refused, not clamped", async () => {
  // Dividing by it produced Infinity MB/s. Clamping to 1s would be worse: it
  // reports a number nobody measured. The window is the measurement.
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { run, calls } = scripted(READERS_OUT);
    await assertRejects(
      () => probeReaders(run, "arrayhost", "root", bad, 5, ["shfs"]),
      Error,
      "sampleSeconds must be at least 1",
    );
    assertEquals(calls, [], "a bad window must not reach the host");
  }
});

/* --------------------------------------------- degenerate device topology */

Deno.test("a device-mapper cycle terminates instead of recursing forever", async () => {
  const { run } = scripted(
    ["DEV|dm-0|100|a|dm-1,", "DEV|dm-1|100|b|dm-0,"].join("\n"),
  );
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assertEquals(map.devices.map((d) => d.physical), [null, null]);
  assertEquals(map.aliasGroups, []);
});

Deno.test("a dm device naming itself as its own slave does not loop", async () => {
  const { run } = scripted("DEV|dm-3|100|dm-3|dm-3,");
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assertEquals(map.devices[0].physical, null);
});

Deno.test("a spindle exported under one name is not an alias group", async () => {
  const { run } = scripted(MAP_OUT);
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assert(!map.aliasGroups.some((g) => g.physical === "sda"));
});

/* ------------------------------------------------- live-run regressions */

Deno.test("LIVE REGRESSION: md4p1 -> sdl exists ONLY in disks.ini", async () => {
  // Unraid's md driver is not Linux md: /sys/block/md4 exposes no slaves, so
  // the dm layer of an encrypted slot dead-ends there. The first
  // implementation walked only /sys/block and returned physical:null for
  // every array disk. Slot N is diskN by construction.
  const noSlots = MAP_OUT.split("\n").filter((l) => !l.startsWith("SLOT|"))
    .join("\n");
  const { run } = scripted(noSlots);
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assertEquals(
    map.devices.find((d) => d.name === "dm-3")!.physical,
    null,
    "without disks.ini there is genuinely no link, and guessing one would be worse",
  );

  const { run: withSlots } = scripted(MAP_OUT);
  const full = await probeDeviceMap(withSlots, "arrayhost", "root");
  assertEquals(full.devices.find((d) => d.name === "dm-3")!.physical, "sdl");
});

Deno.test("LIVE REGRESSION: the fd script stats an ABSOLUTE path", () => {
  // The script ran `stat "$pid"/fd/*` after `cd /proc`, so %n printed
  // `9231/fd/70` while the parser looked up `/proc/9231/fd/70`. Every size
  // came back null, which sorted real media files below zero-length rows AND
  // silently disabled the size check below.
  assert(
    /stat -Lc 'S\|%n\|%s' \/proc\//.test(FD_SCRIPT),
    "stat must be given an absolute path so %n matches the parser's key",
  );
});

Deno.test("LIVE REGRESSION: an unsized pair is never reported as a consumer", async () => {
  // Postgres relfilenodes collide across databases: .../16384/2688 exists
  // under both immich and himmich. Without a size to agree on, basename
  // equality is not evidence — the live run credited the wrong container.
  const { run } = scripted([
    "M|9231||/usr/local/bin/shfs /mnt/user",
    "F|9231|10|/mnt/disk4/media-server/immich/postgres/base/16384/2688",
    "M|500|cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc|postgres",
    "F|500|11|/var/lib/postgresql/data/base/16384/2688",
    "C|cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc|himmich_postgres",
  ].join("\n"));
  const r = await probeOpenFiles(
    run,
    "arrayhost",
    "root",
    "/mnt/disk4",
    ["shfs"],
    40,
  );
  assertEquals(r.files[0].consumers, []);
});

Deno.test("LIVE REGRESSION: rchar counts sockets, so an off-disk process is not credited", async () => {
  // swamp-serve topped the ranking at 29.8 MB/s of websocket traffic while
  // transmission at 6.34 MB/s was the actual reader of sdl.
  const { run } = routed({ map: MAP_OUT, readers: READERS_OUT, fds: FD_OUT });
  const { ctx, written } = makeCtx();
  await attributeImpl(
    run,
    { target: "sdl", sampleSeconds: 60, topN: 8, limit: 5 },
    ctx,
  );
  const summary = written[0].payload.summary as string;
  assert(!summary.includes("swamp-serve"));
  assert(summary.includes("busier process(es) excluded"));
});

/* --------------------------------------------------- proxy attribution */

Deno.test("the FUSE proxy is never itself reported as the reader", async () => {
  const { run } = scripted(READERS_OUT);
  const r = await probeReaders(run, "arrayhost", "root", 60, 10, ["shfs"]);
  const shfs = r.readers.find((x) => x.pid === 9231)!;
  assert(shfs.fuseProxy);
  assert(shfs.blockReadMBps > 0, "the proxy carries the block I/O");
  const tx = r.readers.find((x) => x.pid === 15272)!;
  assertEquals(tx.fuseProxy, false);
  assertEquals(
    tx.blockReadMBps,
    0,
    "the real consumer registers NO block I/O — why cgroup and cadvisor miss it",
  );
});

Deno.test("an empty fuseProxies config makes every process a candidate", async () => {
  const { run } = scripted(READERS_OUT);
  const r = await probeReaders(run, "arrayhost", "root", 60, 10, []);
  assert(r.readers.every((x) => !x.fuseProxy));
  assertEquals(r.totals.proxyBlockReadMBps, 0);
});

Deno.test("prefix matching happens on a path boundary, never a substring", async () => {
  const { run } = scripted([
    "M|1||/bin/a",
    "S|/proc/1/fd/3|10",
    "S|/proc/1/fd/4|10",
    "S|/proc/1/fd/5|10",
    "F|1|3|/mnt/disk4/keep.bin",
    "F|1|4|/mnt/disk40/other.bin",
    "F|1|5|/mnt/disk4",
  ].join("\n"));
  const r = await probeOpenFiles(
    run,
    "arrayhost",
    "root",
    "/mnt/disk4",
    [],
    40,
  );
  assertEquals(r.files.map((f) => f.path).sort(), [
    "/mnt/disk4",
    "/mnt/disk4/keep.bin",
  ]);
});

Deno.test("the sampling window reaches the host verbatim", async () => {
  const { run, calls } = scripted(READERS_OUT);
  await probeReaders(run, "arrayhost", "root", 42, 5, ["shfs"]);
  const script = decodeScript(calls[0].command);
  assert(script.includes("sleep 42"));
  assert(script.includes("read_bytes") && script.includes("rchar"));
});
