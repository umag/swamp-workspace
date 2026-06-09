// Unit tests for the @magistr/firecracker model — global/method schema
// validation and the pre-flight checks. These import the REAL model (not a
// mirror), so any change to a schema or a check's behaviour breaks these tests.
//
// Run: deno test extensions/models/firecracker_test.ts

import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./firecracker.ts";
import { isValidSshHost } from "./lib/ssh.ts";

const baseArgs = {
  host: "fc.example.com",
  user: "root",
  socketPath: "/run/fc.socket",
};

// --- globalArguments ---

Deno.test("globalArguments: accepts a valid host + socket path", () => {
  assertEquals(model.globalArguments.safeParse(baseArgs).success, true);
});

Deno.test("globalArguments: defaults user to root", () => {
  const parsed = model.globalArguments.parse({
    host: "fc.example.com",
    socketPath: "/run/fc.socket",
  });
  assertEquals(parsed.user, "root");
});

Deno.test("globalArguments: rejects a socket path with shell metacharacters", () => {
  const r = model.globalArguments.safeParse({
    host: "fc.example.com",
    socketPath: "/run/fc.socket; rm -rf /",
  });
  assertFalse(r.success);
});

// --- method argument schemas ---

Deno.test("set_drive: rejects a path containing a space", () => {
  const r = model.methods.set_drive.arguments.safeParse({
    driveId: "rootfs",
    pathOnHost: "/opt/my rootfs.ext4",
    isRootDevice: false,
  });
  assertFalse(r.success);
});

Deno.test("set_drive: accepts a clean path", () => {
  const r = model.methods.set_drive.arguments.safeParse({
    driveId: "rootfs",
    pathOnHost: "/opt/firecracker/rootfs.ext4",
    isRootDevice: true,
  });
  assertEquals(r.success, true);
});

Deno.test("set_network: rejects an over-length host tap device name", () => {
  const r = model.methods.set_network.arguments.safeParse({
    ifaceId: "eth0",
    hostDevName: "tap0123456789012", // 16 chars, IFACE_RE caps at 15
  });
  assertFalse(r.success);
});

Deno.test("set_network: accepts a well-formed interface (MAC optional)", () => {
  const r = model.methods.set_network.arguments.safeParse({
    ifaceId: "eth0",
    hostDevName: "tap0",
  });
  assertEquals(r.success, true);
});

Deno.test("configure: rejects a vcpu count above the maximum", () => {
  const r = model.methods.configure.arguments.safeParse({
    vcpuCount: 64,
    memSizeMib: 1024,
  });
  assertFalse(r.success);
});

// --- pre-flight checks ---

Deno.test("valid-ssh-host check: passes for a real host", async () => {
  const res = await model.checks["valid-ssh-host"].execute({
    globalArgs: baseArgs,
  });
  assertEquals(res.pass, true);
});

Deno.test("valid-ssh-host check: fails with an error for an empty host", async () => {
  const res = await model.checks["valid-ssh-host"].execute({
    globalArgs: { ...baseArgs, host: "" },
  });
  assertFalse(res.pass);
  assertEquals(typeof res.errors?.[0], "string");
});

Deno.test("host-reachable check: registered with the live label", () => {
  assertEquals(model.checks["host-reachable"].labels, ["live"]);
});

// --- shared ssh helper ---

Deno.test("isValidSshHost rejects empty and placeholder hosts", () => {
  assertEquals(isValidSshHost("fc.example.com"), true);
  assertFalse(isValidSshHost(""));
  assertFalse(isValidSshHost("null"));
  assertFalse(isValidSshHost("undefined"));
});
