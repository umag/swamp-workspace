// Unit tests for the @magistr/firecracker model — global/method schema
// validation and the pre-flight checks. These import the REAL model (not a
// mirror), so any change to a schema or a check's behaviour breaks these tests.
//
// Run: deno test extensions/models/firecracker_test.ts

import {
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addToIp,
  buildSetupTapScript,
  model,
  netnsExecPrefix,
  shortHash,
} from "./firecracker.ts";
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

// --- per-VM network isolation (netns) ---

const tapArgs = {
  tapName: "tap0",
  hostIp: "172.16.0.1",
  prefix: 24,
  guestSubnet: "172.16.0.0/24",
};

Deno.test("buildSetupTapScript: no-netns branch is byte-identical to the legacy recipe", () => {
  const expected = [
    `ip link show 'tap0' 2>/dev/null || ip tuntap add dev 'tap0' mode tap`,
    `ip addr show 'tap0' | grep -q '172.16.0.1' || ip addr add '172.16.0.1/24' dev 'tap0'`,
    `ip link set 'tap0' up`,
    `sysctl -w net.ipv4.ip_forward=1 -q`,
    `iptables -t nat -C POSTROUTING -s '172.16.0.0/24' -j MASQUERADE 2>/dev/null || ` +
    `iptables -t nat -A POSTROUTING -s '172.16.0.0/24' -j MASQUERADE`,
    `echo ok`,
  ].join("\n");
  assertEquals(buildSetupTapScript(tapArgs), expected);
});

Deno.test("buildSetupTapScript: netns branch builds the namespace + veth + scoped NAT", () => {
  const s = buildSetupTapScript({
    ...tapArgs,
    netns: "fc-1",
    vethSubnet: "10.0.5.0/30",
  });
  assertStringIncludes(s, "ip netns add 'fc-1'");
  // guest tap created INSIDE the namespace
  assertStringIncludes(
    s,
    "ip netns exec 'fc-1' ip tuntap add dev 'tap0' mode tap",
  );
  // ip_forward enabled inside the namespace (not just on the host)
  assertStringIncludes(
    s,
    "ip netns exec 'fc-1' sysctl -w net.ipv4.ip_forward=1 -q",
  );
  // in-ns egress NAT scoped to the guest subnet
  assertStringIncludes(s, "-s '172.16.0.0/24' -o fcveth0 -j MASQUERADE");
  // host egress NAT scoped to THIS VM's veth subnet + comment-tagged for teardown
  assertStringIncludes(
    s,
    "-s '10.0.5.0/30' -o \"$UP\" -m comment --comment 'fc-netns:fc-1' -j MASQUERADE",
  );
  // root-side veth name derived from the namespace hash (unique in root ns)
  assertStringIncludes(s, "fcv" + shortHash("fc-1"));
});

Deno.test("buildSetupTapScript: distinct namespaces get distinct root veth names", () => {
  // Match the shellEsc'd root-side veth ('fcv<hash>'). The unquoted ns-side peer
  // `fcveth0` also starts with "fcv" ("fcve" is valid hex), so anchor on the
  // surrounding quotes to extract the per-namespace root veth, not the constant
  // peer name.
  const veth = (ns: string) =>
    buildSetupTapScript({ ...tapArgs, netns: ns, vethSubnet: "10.0.0.0/30" })
      .match(/'(fcv[0-9a-f]+)'/)?.[1];
  assertEquals(veth("fc-1") === veth("fc-2"), false);
});

Deno.test("shortHash is deterministic and hex", () => {
  assertEquals(shortHash("fc-1"), shortHash("fc-1"));
  assertEquals(/^[0-9a-f]+$/.test(shortHash("fc-agent-7")), true);
});

Deno.test("buildSetupTapScript: netns branch uses scoped FORWARD, never -P FORWARD ACCEPT", () => {
  const s = buildSetupTapScript({
    ...tapArgs,
    netns: "fc-1",
    vethSubnet: "10.0.0.0/30",
  });
  assertStringIncludes(s, "-A FORWARD -i 'tap0' -o fcveth0 -j ACCEPT");
  assertFalse(s.includes("-P FORWARD ACCEPT"));
});

Deno.test("addToIp adds to the last octet", () => {
  assertEquals(addToIp("10.0.5.0", 1), "10.0.5.1");
  assertEquals(addToIp("10.0.5.0", 2), "10.0.5.2");
});

Deno.test("netnsExecPrefix: empty without a namespace, prefixed with one", () => {
  assertEquals(netnsExecPrefix(undefined), "");
  assertEquals(netnsExecPrefix("fc-1"), "ip netns exec 'fc-1' ");
});

// --- new argument schemas ---

Deno.test("setup_tap: accepts netns + a valid veth CIDR", () => {
  const r = model.methods.setup_tap.arguments.safeParse({
    netns: "fc-agent-1",
    vethSubnet: "10.0.7.0/30",
  });
  assertEquals(r.success, true);
});

Deno.test("setup_tap: rejects a malformed veth subnet", () => {
  const r = model.methods.setup_tap.arguments.safeParse({
    vethSubnet: "not-a-cidr",
  });
  assertFalse(r.success);
});

Deno.test("setup_tap: rejects a malformed hostIp and guestSubnet", () => {
  assertFalse(
    model.methods.setup_tap.arguments.safeParse({ hostIp: "999.1" })
      .success,
  );
  assertFalse(
    model.methods.setup_tap.arguments.safeParse({ guestSubnet: "10.0.0.0" })
      .success,
  );
});

Deno.test("globalArguments: rejects a netns name with shell metacharacters", () => {
  const r = model.globalArguments.safeParse({
    host: "fc.example.com",
    socketPath: "/run/fc.socket",
    netns: "fc; rm -rf /",
  });
  assertFalse(r.success);
});

Deno.test("restore: accepts ifaceId + hostDevName for network_overrides", () => {
  const r = model.methods.restore.arguments.safeParse({
    snapshotPath: "/opt/firecracker/agent-snapshot.snap",
    memFilePath: "/opt/firecracker/agent-snapshot.mem",
    ifaceId: "eth0",
    hostDevName: "tap0",
  });
  assertEquals(r.success, true);
});

Deno.test("globalArguments: accepts an empty netns (root-namespace default)", () => {
  const r = model.globalArguments.safeParse({
    host: "fc.example.com",
    socketPath: "/run/fc.socket",
    netns: "",
  });
  assertEquals(r.success, true);
});
