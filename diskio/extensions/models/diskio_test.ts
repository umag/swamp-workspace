/**
 * Contract-fixture suite for @magistr/diskio.
 *
 * Pins the shape of what each probe returns against captured real host output,
 * so a parser change that still "works" but drops or renames a field reddens
 * here. See lib/fixtures.ts for the provenance of every fixture.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { probeDeviceMap, probeOpenFiles, probeReaders } from "./diskio.ts";
import { FD_OUT, MAP_OUT, READERS_OUT, scripted } from "./lib/fixtures.ts";

Deno.test("contract: deviceMap carries the full documented keyset", async () => {
  const { run } = scripted(MAP_OUT);
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assertEquals(Object.keys(map).sort(), [
    "aliasGroups",
    "devices",
    "host",
    "timestamp",
  ]);
  assertEquals(Object.keys(map.devices[0]).sort(), [
    "dmName",
    "kind",
    "mountpoint",
    "name",
    "physical",
    "sizeBytes",
    "slaves",
    "slot",
    "usedPercent",
  ]);
  assertEquals(Object.keys(map.aliasGroups[0]).sort(), [
    "layers",
    "physical",
    "slot",
  ]);
});

Deno.test("contract: the array host's map yields the exact pinned dm-3 row", async () => {
  const { run } = scripted(MAP_OUT);
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assertEquals(map.devices.find((d) => d.name === "dm-3"), {
    name: "dm-3",
    kind: "dm",
    dmName: "md4p1",
    slaves: ["md4p1"],
    physical: "sdl",
    slot: "disk4",
    mountpoint: "/mnt/disk4",
    sizeBytes: 31251759104 * 512,
    usedPercent: 87,
  });
});

Deno.test("contract: readers carries the full documented keyset", async () => {
  const { run } = scripted(READERS_OUT);
  const r = await probeReaders(run, "arrayhost", "root", 60, 10, ["shfs"]);
  assertEquals(Object.keys(r).sort(), [
    "host",
    "readers",
    "sampleSeconds",
    "timestamp",
    "totals",
  ]);
  assertEquals(Object.keys(r.readers[0]).sort(), [
    "blockReadMBps",
    "blockWriteMBps",
    "command",
    "container",
    "fuseProxy",
    "onTarget",
    "pid",
    "requestedReadMBps",
    "requestedWriteMBps",
  ]);
  assertEquals(Object.keys(r.totals).sort(), [
    "blockReadMBps",
    "blockWriteMBps",
    "proxyBlockReadMBps",
    "requestedReadMBps",
  ]);
});

Deno.test("contract: openFiles carries the full documented keyset", async () => {
  const { run } = scripted(FD_OUT);
  const r = await probeOpenFiles(
    run,
    "arrayhost",
    "root",
    "/mnt/disk4",
    ["shfs"],
    40,
  );
  assertEquals(Object.keys(r).sort(), [
    "files",
    "host",
    "path",
    "scanned",
    "timestamp",
    "truncated",
  ]);
  assertEquals(
    Object.keys(r.files[0]).sort(),
    [
      "command",
      "consumers",
      "container",
      "fd",
      "fuseProxy",
      "path",
      "sizeBytes",
      "pid",
    ].sort(),
  );
  assertEquals(Object.keys(r.files[0].consumers[0]).sort(), [
    "command",
    "container",
    "path",
    "pid",
  ]);
});

Deno.test("contract: every timestamp is an ISO-8601 instant", async () => {
  const { run } = scripted(MAP_OUT);
  const map = await probeDeviceMap(run, "arrayhost", "root");
  assert(!Number.isNaN(Date.parse(map.timestamp)));
  assertEquals(map.timestamp, new Date(map.timestamp).toISOString());
});
