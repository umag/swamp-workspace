/**
 * Coverage suite for @magistr/diskio: exercises each branch of the pure
 * helpers directly, including the ones no fixture happens to reach.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  assertSafePath,
  probeDeviceMap,
  probeOpenFiles,
  probeReaders,
  summarize,
} from "./diskio.ts";
import { FD_OUT, MAP_OUT, READERS_OUT, scripted } from "./lib/fixtures.ts";

const reader = (over: Record<string, unknown> = {}) => ({
  pid: 1,
  command: "x",
  container: null as string | null,
  requestedReadMBps: 0,
  requestedWriteMBps: 0,
  blockReadMBps: 0,
  blockWriteMBps: 0,
  fuseProxy: false,
  onTarget: null as boolean | null,
  ...over,
});

Deno.test("device kind: every branch of the classifier", async () => {
  const { run } = scripted([
    "DEV|sdl|1||",
    "DEV|nvme0n1|1||",
    "DEV|vda|1||",
    "DEV|dm-3|1|md4p1|",
    "DEV|md4|1||",
    "DEV|loop2|1||",
    "DEV|sr0|1||",
    "DEV|weird0|1||",
  ].join("\n"));
  const map = await probeDeviceMap(run, "arrayhost", "root");
  const kind = (n: string) => map.devices.find((d) => d.name === n)!.kind;
  assertEquals(kind("sdl"), "physical");
  assertEquals(kind("nvme0n1"), "physical");
  assertEquals(kind("vda"), "physical");
  assertEquals(kind("dm-3"), "dm");
  assertEquals(kind("md4"), "md");
  assertEquals(kind("loop2"), "loop");
  assertEquals(kind("weird0"), "other");
});

Deno.test("usedPercent is null when df reports nothing for the mount", async () => {
  const noDf = MAP_OUT.split("\n").filter((l) => !l.startsWith("DF|")).join(
    "\n",
  );
  const { run } = scripted(noDf);
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assertEquals(map.devices.find((d) => d.name === "dm-3")!.usedPercent, null);
  assertEquals(
    map.devices.find((d) => d.name === "dm-3")!.mountpoint,
    "/mnt/disk4",
  );
});

Deno.test("sizeBytes is null when /sys/block reports no size", async () => {
  const { run } = scripted("DEV|sdl|||");
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assertEquals(map.devices[0].sizeBytes, null);
});

Deno.test("a df row whose size is zero does not produce a division", async () => {
  const { run } = scripted([
    "DEV|sdl|100||",
    "MNT|/dev/sdl|/mnt/x",
    "DF|/dev/sdl|/mnt/x|0|0",
  ].join("\n"));
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assertEquals(map.devices[0].usedPercent, null);
});

Deno.test("readers: topN larger than the sample returns everything", async () => {
  const { run } = scripted(READERS_OUT);
  const r = await probeReaders(run, "arrayhost", "root", 60, 999, ["shfs"]);
  assertEquals(r.readers.length, 5);
});

Deno.test("readers: a process with no cgroup line is a host process", async () => {
  const { run } = scripted(READERS_OUT);
  const r = await probeReaders(run, "arrayhost", "root", 60, 10, ["shfs"]);
  assertEquals(r.readers.find((x) => x.pid === 9231)!.container, null);
  assertEquals(r.readers.find((x) => x.pid === 26299)!.container, null);
});

Deno.test("readers: a cgroup id with no matching container stays unnamed", async () => {
  const { run } = scripted(
    "P|1|10|0|0|0|ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff|/bin/x",
  );
  const r = await probeReaders(run, "arrayhost", "root", 10, 5, []);
  assertEquals(r.readers[0].container, null);
});

Deno.test("readers: totals sum every sampled process, not just the reported topN", async () => {
  const { run } = scripted(READERS_OUT);
  const one = await probeReaders(run, "arrayhost", "root", 60, 1, ["shfs"]);
  const all = await probeReaders(run, "arrayhost", "root", 60, 99, ["shfs"]);
  assertEquals(one.readers.length, 1);
  assertEquals(one.totals.requestedReadMBps, all.totals.requestedReadMBps);
});

Deno.test("open-files: limit 0 reports nothing but still counts the scan", async () => {
  const { run } = scripted(FD_OUT);
  const r = await probeOpenFiles(
    run,
    "arrayhost",
    "root",
    "/mnt/disk4",
    ["shfs"],
    0,
  );
  assertEquals(r.files, []);
  assertEquals(r.scanned, 6);
});

Deno.test("open-files: a file a real process holds directly gets no consumers", async () => {
  const { run } = scripted(FD_OUT);
  const r = await probeOpenFiles(
    run,
    "arrayhost",
    "root",
    "/anime",
    ["shfs"],
    40,
  );
  const direct = r.files.find((f) => f.pid === 15272)!;
  assertEquals(direct.fuseProxy, false);
  assertEquals(direct.consumers, []);
});

Deno.test("open-files: one container reaching a file from many workers is one consumer", async () => {
  const { run } = scripted([
    "M|9231||/usr/local/bin/shfs /mnt/user",
    "S|/proc/9231/fd/10|4096",
    "F|9231|10|/mnt/disk4/db/rel",
    "M|501|dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd|postgres w1",
    "S|/proc/501/fd/11|4096",
    "F|501|11|/var/lib/postgresql/data/rel",
    "M|502|dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd|postgres w2",
    "S|/proc/502/fd/12|4096",
    "F|502|12|/var/lib/postgresql/data/rel",
    "C|dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd|immich_postgres",
  ].join("\n"));
  const r = await probeOpenFiles(
    run,
    "arrayhost",
    "root",
    "/mnt/disk4",
    ["shfs"],
    40,
  );
  assertEquals(r.files[0].consumers.length, 1);
  assertEquals(r.files[0].consumers[0].container, "immich_postgres");
});

Deno.test("open-files: a proxy holding a file nobody else has gets an empty consumer list", async () => {
  const { run } = scripted([
    "M|9231||/usr/local/bin/shfs /mnt/user",
    "S|/proc/9231/fd/10|4096",
    "F|9231|10|/mnt/disk4/orphan.bin",
  ].join("\n"));
  const r = await probeOpenFiles(
    run,
    "arrayhost",
    "root",
    "/mnt/disk4",
    ["shfs"],
    40,
  );
  assert(r.files[0].fuseProxy);
  assertEquals(r.files[0].consumers, []);
});

Deno.test("summarize: no layers means no identity sentence", () => {
  const s = summarize("sdl", "sdl", ["sdl"], [
    reader({ container: "transmission", requestedReadMBps: 1, onTarget: true }),
  ], []);
  assert(!s.includes("layers of that one device"));
  assert(s.includes("transmission 1 MB/s"));
});

Deno.test("summarize: falls back to the process name, then the pid", () => {
  assert(
    summarize("sdl", null, [], [
      reader({
        pid: 7,
        command: "/usr/bin/transmission-daemon -g /c",
        requestedReadMBps: 2,
      }),
    ], []).includes("transmission-daemon 2 MB/s"),
  );
  assert(
    summarize("sdl", null, [], [
      reader({ pid: 7, command: "", requestedReadMBps: 2 }),
    ], [])
      .includes("pid 7 2 MB/s"),
  );
});

Deno.test("summarize: an empty window and an all-off-disk window read differently", () => {
  assertEquals(
    summarize("sdl", "sdl", ["sdl"], [], []),
    "No process registered any read in the sample window.",
  );
  assert(
    summarize("sdl", "sdl", ["sdl"], [
      reader({ container: "svc", requestedReadMBps: 99, onTarget: false }),
    ], []).includes("No process holding a file on this disk registered a read"),
  );
});

Deno.test("summarize: unevaluated onTarget (null) is not treated as false", () => {
  const s = summarize("sdl", "sdl", ["sdl"], [
    reader({
      container: "transmission",
      requestedReadMBps: 6.34,
      onTarget: null,
    }),
  ], []);
  assert(s.includes("transmission 6.34 MB/s"));
  assert(!s.includes("excluded"));
});

Deno.test("summarize: names consumers behind a proxy and direct holders alike", () => {
  const s = summarize("sdl", "sdl", ["sdl"], [], [
    {
      pid: 9231,
      command: "shfs",
      container: null,
      fd: 1,
      path: "/mnt/disk4/a",
      sizeBytes: 1,
      fuseProxy: true,
      consumers: [{
        pid: 2,
        command: "t",
        container: "transmission",
        path: "/x",
      }],
    },
    {
      pid: 3,
      command: "/usr/bin/plex",
      container: null,
      fd: 2,
      path: "/mnt/disk4/b",
      sizeBytes: 1,
      fuseProxy: false,
      consumers: [],
    },
  ]);
  assert(s.includes("transmission"));
  assert(s.includes("plex"));
});

Deno.test("path guard accepts the punctuation real media paths contain", () => {
  for (
    const ok of [
      "/mnt/disk4",
      "/mnt/user/Media (2026)/a.mkv",
      "/mnt/user/[Judas] Show - S01E03.mkv",
      "/mnt/user/a+b&c=d,e#f/g",
      "/mnt/user/it's here",
    ]
  ) {
    assertEquals(assertSafePath(ok), ok);
  }
});
