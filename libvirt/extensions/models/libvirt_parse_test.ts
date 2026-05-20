// Unit tests for lib/parse.ts — the pure virsh-output parsers.
// Run: deno test extensions/models/libvirt_parse_test.ts
//
// These import the REAL implementation (not a mirror), so a refactor that
// changes parsing behavior breaks these tests.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseKV,
  parseNetList,
  parsePoolList,
  parseTableOutput,
  parseVmList,
  parseVolList,
  parseXmlDisks,
  parseXmlGraphics,
  parseXmlInterfaces,
} from "./lib/parse.ts";

Deno.test("parseKV splits on the first colon and trims", () => {
  const out = `UUID:           1234-5678
State:          running
CPU time:       12.3s`;
  assertEquals(parseKV(out), {
    UUID: "1234-5678",
    State: "running",
    "CPU time": "12.3s",
  });
});

Deno.test("parseKV ignores lines without a colon", () => {
  assertEquals(parseKV("no colon here\nKey: val"), { Key: "val" });
});

Deno.test("parseVmList reads id/name/state incl. space-containing names", () => {
  const out = ` Id   Name            State
----------------------------------
 1    web-server      running
 -    my idle vm      shut off
 3    db              paused`;
  assertEquals(parseVmList(out), [
    { name: "web-server", state: "running" },
    { name: "my idle vm", state: "shut off" },
    { name: "db", state: "paused" },
  ]);
});

Deno.test("parseVmList skips the header and separator rows", () => {
  assertEquals(parseVmList(" Id Name State\n---\n"), []);
});

Deno.test("parseVmList handles multi-word states and state-like names", () => {
  const out = ` Id   Name        State
-------------------------------
 -    winxp       in shutdown
 -    sleeper     pmsuspended
 4    running     running`;
  assertEquals(parseVmList(out), [
    { name: "winxp", state: "in shutdown" },
    { name: "sleeper", state: "pmsuspended" },
    // A domain literally named "running" still parses (state = trailing token).
    { name: "running", state: "running" },
  ]);
});

Deno.test("parseNetList parses name/state/autostart/persistent", () => {
  const out = ` Name      State      Autostart   Persistent
----------------------------------------------
 default   active     yes         yes
 isolated  inactive   no          yes`;
  assertEquals(parseNetList(out), [
    { name: "default", state: "active", autostart: "yes", persistent: "yes" },
    {
      name: "isolated",
      state: "inactive",
      autostart: "no",
      persistent: "yes",
    },
  ]);
});

Deno.test("parsePoolList parses name/state/autostart", () => {
  const out = ` Name     State    Autostart
-----------------------------
 default  running  yes`;
  assertEquals(parsePoolList(out), [
    { name: "default", state: "running", autostart: "yes" },
  ]);
});

Deno.test("parseVolList parses name/path", () => {
  const out = ` Name        Path
------------------------------------
 disk.qcow2  /var/lib/libvirt/images/disk.qcow2`;
  assertEquals(parseVolList(out), [
    { name: "disk.qcow2", path: "/var/lib/libvirt/images/disk.qcow2" },
  ]);
});

Deno.test("parseTableOutput keys rows by header cells", () => {
  const out = ` Name         Creation Time              State
------------------------------------------------------
 snap1        2026-01-01 00:00:00 +0000  running`;
  assertEquals(parseTableOutput(out), [
    {
      Name: "snap1",
      "Creation Time": "2026-01-01 00:00:00 +0000",
      State: "running",
    },
  ]);
});

Deno.test("parseTableOutput returns [] for header-only output", () => {
  assertEquals(parseTableOutput(" Name State\n"), []);
});

Deno.test("parseXmlDisks extracts source/target/bus", () => {
  const xml = `<domain>
    <devices>
      <disk type='file' device='disk'>
        <source file='/images/vda.qcow2'/>
        <target dev='vda' bus='virtio'/>
      </disk>
      <disk type='block' device='disk'>
        <source dev='/dev/sdb'/>
        <target dev='vdb' bus='scsi'/>
      </disk>
    </devices>
  </domain>`;
  assertEquals(parseXmlDisks(xml), [
    { source: "/images/vda.qcow2", target: "vda", bus: "virtio" },
    { source: "/dev/sdb", target: "vdb", bus: "scsi" },
  ]);
});

Deno.test("parseXmlInterfaces extracts mac/source/model", () => {
  const xml = `<interface type='network'>
      <mac address='52:54:00:aa:bb:cc'/>
      <source network='default'/>
      <model type='virtio'/>
    </interface>`;
  assertEquals(parseXmlInterfaces(xml), [
    { mac: "52:54:00:aa:bb:cc", source: "default", model: "virtio" },
  ]);
});

Deno.test("parseXmlGraphics extracts type/port/listen", () => {
  const xml =
    `<graphics type='vnc' port='5900' listen='0.0.0.0'><listen type='address' address='0.0.0.0'/></graphics>`;
  assertEquals(parseXmlGraphics(xml), [
    { type: "vnc", port: "5900", listen: "0.0.0.0" },
  ]);
});
