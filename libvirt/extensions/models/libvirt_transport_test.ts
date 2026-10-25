// Unit tests for the SSH transport settings in lib/connection.ts: connection
// sharing (ControlMaster), port / identityFile / jumpHost / sshConfig,
// `become`, and the exit-255 SshConnectionError.
// Run: deno test extensions/models/libvirt_transport_test.ts

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { z } from "npm:zod@4";
import {
  buildInvocation,
  buildSshRaw,
  checkSshTransportConfig,
  controlTag,
  defineXml,
  SshConnectionError,
  sshOptions,
  SshTransportArgs,
  virshTry,
} from "./lib/connection.ts";

const HARDENED = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
];
const CP = "/tmp/swamp-libvirt-abc/0123456789abcdef";
const ED25519 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

// --- option order and content ------------------------------------------------

Deno.test("sshOptions: no transport settings = the original hardened set", () => {
  assertEquals(sshOptions({ host: "h" }), HARDENED);
});

Deno.test("sshOptions: host-key set first, then port, key, bastion, sshConfig, sharing", () => {
  const opts = sshOptions({
    host: "h",
    port: 2222,
    identityFile: "/keys/id_ed25519",
    jumpHost: "ops@bastion:22",
    sshConfig: { ServerAliveInterval: "15" },
  }, { controlPath: CP });
  assertEquals(opts, [
    ...HARDENED,
    "-p",
    "2222",
    "-i",
    "/keys/id_ed25519",
    "-o",
    "IdentitiesOnly=yes",
    "-J",
    "ops@bastion:22",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${CP}`,
    "-o",
    "ControlPersist=30",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
  ]);
});

Deno.test("sshOptions strict: pinned set still comes first, sharing after it", () => {
  const opts = sshOptions(
    { host: "h", hostKeyPolicy: "strict", knownHosts: [`h ${ED25519}`] },
    { knownHostsFile: "/tmp/kh", controlPath: CP },
  );
  assertEquals(opts[1], "StrictHostKeyChecking=yes");
  assertEquals(opts.slice(-10, -4), [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${CP}`,
    "-o",
    "ControlPersist=30",
  ]);
});

// --- become ------------------------------------------------------------------

Deno.test("buildInvocation become: virsh runs under sudo -n, every token quoted", () => {
  const inv = buildInvocation({ host: "h", user: "ops", become: true }, [
    "list",
    "--all",
  ]);
  assertEquals(inv.args.at(-2), "ops@h");
  assertEquals(inv.args.at(-1), "'sudo' '-n' 'virsh' 'list' '--all'");
});

Deno.test("buildSshRaw become: raw commands run under sudo -n too", () => {
  const inv = buildSshRaw({ host: "h", become: true }, ["ip", "route"]);
  assertEquals(inv.args.at(-1), "'sudo' '-n' 'ip' 'route'");
});

Deno.test("buildInvocation: become false/absent adds no sudo", () => {
  for (const become of [undefined, false]) {
    const inv = buildInvocation({ host: "h", become }, ["list"]);
    assertEquals(inv.args.at(-1), "'virsh' 'list'");
  }
});

// --- config guards (fail closed) -----------------------------------------------

Deno.test("checkSshTransportConfig: SSH-only settings in local mode are refused, by name", () => {
  for (
    const [conn, name] of [
      [{ port: 22 }, "port"],
      [{ identityFile: "/k" }, "identityFile"],
      [{ jumpHost: "b" }, "jumpHost"],
      [{ sshConfig: {} }, "sshConfig"],
      [{ become: true }, "become"],
    ] as const
  ) {
    const e = assertThrows(() => checkSshTransportConfig(conn));
    assertStringIncludes((e as Error).message, name);
  }
});

Deno.test("checkSshTransportConfig: local mode with the schema defaults passes", () => {
  checkSshTransportConfig({ become: false, multiplex: true });
  checkSshTransportConfig({ uri: "qemu:///session", multiplex: false });
});

Deno.test("checkSshTransportConfig: sshConfig is an allowlist — managed and dangerous keys are refused, any case", () => {
  for (
    const key of [
      "StrictHostKeyChecking",
      "stricthostkeychecking",
      "UserKnownHostsFile",
      "GlobalKnownHostsFile",
      "KnownHostsCommand",
      "UpdateHostKeys",
      "BatchMode",
      "ConnectTimeout",
      "ControlMaster",
      "CONTROLPATH",
      "ControlPersist",
      "VerifyHostKeyDNS",
      "HostKeyAlias",
      "ProxyCommand",
      "ProxyJump",
      "LocalCommand",
      "PermitLocalCommand",
      "RemoteCommand",
      "SessionType",
      "StdinNull",
      "ForwardAgent",
      "Hostname",
    ]
  ) {
    assertThrows(
      () => checkSshTransportConfig({ host: "h", sshConfig: { [key]: "x" } }),
      Error,
      "may not set",
    );
  }
  checkSshTransportConfig({
    host: "h",
    sshConfig: { serveraliveinterval: "15", TCPKeepAlive: "yes" },
  });
});

Deno.test("checkSshTransportConfig: bad user/host, any jump hop starting with -, and % in identityFile are refused", () => {
  for (
    const conn of [
      { host: "-oProxyCommand=x" },
      { host: "h", user: "-oProxyCommand=touch /tmp/x" },
      { host: "h", user: "a b" },
      { host: "a@b" },
      { host: "h", jumpHost: "a,-v" },
      { host: "h", jumpHost: "a,,b" },
      { host: "h", identityFile: "/k/%h" },
    ]
  ) {
    assertThrows(() => checkSshTransportConfig(conn), Error);
  }
  checkSshTransportConfig({ host: "h", user: "ops", jumpHost: "a@b:22,c" });
});

Deno.test("buildInvocation SSH: -- separates options from the destination", () => {
  const inv = buildInvocation({ host: "h" }, ["list"]);
  assertEquals(inv.args.slice(-3), ["--", "root@h", "'virsh' 'list'"]);
});

Deno.test("checkSshTransportConfig: malformed sshConfig keys/values and a '-' jumpHost are refused", () => {
  assertThrows(() =>
    checkSshTransportConfig({ host: "h", sshConfig: { "A=B": "x" } })
  );
  assertThrows(() =>
    checkSshTransportConfig({ host: "h", sshConfig: { A: "x\nB y" } })
  );
  assertThrows(() =>
    checkSshTransportConfig({ host: "h", jumpHost: "-oProxyCommand=x" })
  );
});

Deno.test("SshTransportArgs schema: defaults and rejections match the runtime guard", () => {
  const schema = z.object(SshTransportArgs);
  assertEquals(schema.parse({}), { become: false, multiplex: true });
  assert(!schema.safeParse({ sshConfig: { BatchMode: "no" } }).success);
  assert(!schema.safeParse({ sshConfig: { ProxyCommand: "nc h 22" } }).success);
  assert(!schema.safeParse({ jumpHost: "a,-v" }).success);
  assert(!schema.safeParse({ identityFile: "/k/%d" }).success);
  assert(!schema.safeParse({ jumpHost: "-J" }).success);
  assert(!schema.safeParse({ port: 0 }).success);
  assert(!schema.safeParse({ identityFile: "/k\n" }).success);
  assert(
    schema.safeParse({ port: 2222, sshConfig: { ServerAliveInterval: "15" } })
      .success,
  );
});

// --- controlTag ----------------------------------------------------------------

Deno.test("controlTag: stable for the same settings, different per host-key policy / keys / identity", async () => {
  const base = { host: "h" };
  const tag = await controlTag(base);
  assertEquals(tag, await controlTag({ ...base }));
  assert(/^[0-9a-f]{16}$/.test(tag));
  const strict = await controlTag({
    ...base,
    hostKeyPolicy: "strict",
    knownHosts: [`h ${ED25519}`],
  });
  assertNotEquals(tag, strict);
  assertNotEquals(
    strict,
    await controlTag({
      ...base,
      hostKeyPolicy: "strict",
      knownHosts: [`other ${ED25519}`],
    }),
  );
  assertNotEquals(tag, await controlTag({ ...base, identityFile: "/k" }));
  assertNotEquals(tag, await controlTag({ host: "h2" }));
  assertNotEquals(tag, await controlTag({ ...base, user: "ops" }));
  assertNotEquals(tag, await controlTag({ ...base, port: 2222 }));
  assertNotEquals(tag, await controlTag({ ...base, jumpHost: "b" }));
  assertNotEquals(
    tag,
    await controlTag({ ...base, sshConfig: { ServerAliveInterval: "5" } }),
  );
});

// --- exit 255 -------------------------------------------------------------------

async function withExitCode(
  code: number,
  stderr: string,
  fn: () => Promise<void>,
) {
  const original = Deno.Command;
  const enc = new TextEncoder();
  const out = () =>
    Promise.resolve({
      code,
      success: code === 0,
      stdout: enc.encode(""),
      stderr: enc.encode(stderr),
    });
  class FakeCommand {
    output() {
      return out();
    }
    spawn() {
      return {
        stdin: {
          getWriter: () => ({
            write: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        },
        output: out,
      };
    }
  }
  // @ts-ignore test stub replaces the Deno global
  Deno.Command = FakeCommand;
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    Deno.Command = original;
  }
}

Deno.test("virshTry SSH: exit 255 throws SshConnectionError instead of returning a result", async () => {
  await withExitCode(
    255,
    "ssh: connect to host h port 22: Connection refused",
    async () => {
      const e = await assertRejects(
        () => virshTry({ host: "h", multiplex: false }, ["domstate", "vm1"]),
        SshConnectionError,
      );
      assertStringIncludes(e.message, "root@h");
      assertStringIncludes(e.message, "Connection refused");
    },
  );
});

Deno.test("virshTry SSH: a virsh failure (exit 1) is still returned for idempotency matching", async () => {
  await withExitCode(1, "error: failed to get domain 'vm1'", async () => {
    const res = await virshTry({ host: "h", multiplex: false }, [
      "domstate",
      "vm1",
    ]);
    assertEquals(res.code, 1);
  });
});

Deno.test("defineXml SSH: exit 255 throws SshConnectionError", async () => {
  await withExitCode(255, "Host key verification failed.", async () => {
    await assertRejects(
      () => defineXml({ host: "h", multiplex: false }, "define", "<domain/>"),
      SshConnectionError,
    );
  });
});

Deno.test("virshTry local: exit 255 from virsh is not treated as an ssh failure", async () => {
  await withExitCode(255, "odd", async () => {
    const res = await virshTry({}, ["list"]);
    assertEquals(res.code, 255);
  });
});
