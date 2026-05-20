// Unit tests for lib/connection.ts — transport selection, the pure
// buildInvocation, shell-quoting, and the idempotency substring predicate.
// Run: deno test extensions/models/libvirt_connection_test.ts
//
// Local mode cannot be executed on a machine without virsh, so the pure
// buildInvocation is the contract that pins local/SSH argv construction and
// the command-injection guarantees.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildInvocation,
  buildSshRaw,
  connLabel,
  includesAny,
  redactSecrets,
  runSshRaw,
  shellQuote,
  uriFlag,
} from "./lib/connection.ts";

// --- uriFlag -----------------------------------------------------------------

Deno.test("uriFlag: local mode defaults to qemu:///system", () => {
  assertEquals(uriFlag({}), ["-c", "qemu:///system"]);
});

Deno.test("uriFlag: local mode honors an explicit uri", () => {
  assertEquals(uriFlag({ uri: "qemu:///session" }), ["-c", "qemu:///session"]);
});

Deno.test("uriFlag: SSH mode omits -c unless uri is explicit", () => {
  assertEquals(uriFlag({ host: "h" }), []);
  assertEquals(uriFlag({ host: "h", uri: "qemu:///system" }), [
    "-c",
    "qemu:///system",
  ]);
});

// --- connLabel ---------------------------------------------------------------

Deno.test("connLabel prefers host, then uri, then default", () => {
  assertEquals(connLabel({ host: "1.2.3.4" }), "1.2.3.4");
  assertEquals(
    connLabel({ uri: "qemu+ssh://root@h/system" }),
    "qemu+ssh://root@h/system",
  );
  assertEquals(connLabel({}), "qemu:///system");
});

// --- shellQuote --------------------------------------------------------------

Deno.test("shellQuote wraps in single quotes and escapes embedded quotes", () => {
  assertEquals(shellQuote(""), "''");
  assertEquals(shellQuote("plain"), "'plain'");
  assertEquals(shellQuote("a b"), "'a b'");
  assertEquals(shellQuote("it's"), "'it'\\''s'");
});

Deno.test("shellQuote neutralizes shell metacharacters as literal data", () => {
  // Each stays inside single quotes => the remote shell treats it as data.
  assertEquals(shellQuote("$(touch /tmp/x)"), "'$(touch /tmp/x)'");
  assertEquals(shellQuote("`id`"), "'`id`'");
  assertEquals(shellQuote("a;b|c&d"), "'a;b|c&d'");
  assertEquals(shellQuote("line1\nline2"), "'line1\nline2'");
});

// --- buildInvocation: local mode --------------------------------------------

Deno.test("buildInvocation local: virsh with -c uri and raw argv (no shell)", () => {
  assertEquals(buildInvocation({}, ["list", "--all"]), {
    command: "virsh",
    args: ["-c", "qemu:///system", "list", "--all"],
  });
});

Deno.test("buildInvocation local: a malicious name is a single argv element", () => {
  // No shell is involved in local mode; Deno.Command passes args verbatim.
  const inv = buildInvocation({}, ["net-info", "default; reboot"]);
  assertEquals(inv.args, [
    "-c",
    "qemu:///system",
    "net-info",
    "default; reboot",
  ]);
});

// --- buildInvocation: SSH mode ----------------------------------------------

Deno.test("buildInvocation ssh: ssh + quoted remote virsh, no -c by default", () => {
  const inv = buildInvocation({ host: "10.0.0.1" }, ["list", "--all"]);
  assertEquals(inv.command, "ssh");
  assertEquals(inv.args[inv.args.length - 2], "root@10.0.0.1");
  assertEquals(inv.args[inv.args.length - 1], "'virsh' 'list' '--all'");
});

Deno.test("buildInvocation ssh: honors user and explicit uri", () => {
  const inv = buildInvocation(
    { host: "h", user: "bob", uri: "qemu:///system" },
    ["dominfo", "vm1"],
  );
  assertEquals(inv.args[inv.args.length - 2], "bob@h");
  assertEquals(
    inv.args[inv.args.length - 1],
    "'virsh' '-c' 'qemu:///system' 'dominfo' 'vm1'",
  );
});

Deno.test("buildInvocation ssh: injection in a NAME is quoted, not executed", () => {
  const inv = buildInvocation({ host: "h" }, ["net-info", "default; reboot"]);
  const remote = inv.args[inv.args.length - 1];
  // The whole malicious value is a single quoted token.
  assertStringIncludes(remote, "'default; reboot'");
  // There is no bare, unquoted semicolon that would start a new command.
  assert(!/[^']; /.test(remote.replace("'default; reboot'", "")));
});

Deno.test("buildInvocation ssh: injection in the URI is quoted", () => {
  const inv = buildInvocation(
    { host: "h", uri: "qemu:///system; touch /tmp/pwn" },
    ["list"],
  );
  assertStringIncludes(
    inv.args[inv.args.length - 1],
    "'-c' 'qemu:///system; touch /tmp/pwn'",
  );
});

Deno.test("buildInvocation ssh: every FLAG and flag-value is quoted (--cap/--mac)", () => {
  const cap = buildInvocation({ host: "h" }, [
    "nodedev-list",
    "--cap",
    "pci; rm -rf /",
  ]);
  assertStringIncludes(cap.args.at(-1)!, "'--cap' 'pci; rm -rf /'");
  const mac = buildInvocation({ host: "h" }, [
    "detach-interface",
    "vm",
    "network",
    "--mac",
    "$(id)",
  ]);
  assertStringIncludes(mac.args.at(-1)!, "'--mac' '$(id)'");
});

Deno.test("buildInvocation ssh: a guestinfo type with a space cannot inject an extra flag", () => {
  // Models split types on comma into --<type> tokens; even a crafted single
  // value stays one quoted token rather than expanding into two flags.
  const inv = buildInvocation({ host: "h" }, [
    "guestinfo",
    "vm",
    "--os --config",
  ]);
  assertStringIncludes(inv.args.at(-1)!, "'--os --config'");
});

Deno.test("buildInvocation ssh: define path streams to /dev/stdin", () => {
  const inv = buildInvocation({ host: "h" }, ["define", "/dev/stdin"]);
  assertEquals(inv.args.at(-1), "'virsh' 'define' '/dev/stdin'");
});

Deno.test("buildInvocation ssh: a flag-shaped NAME stays one quoted positional token", () => {
  // A name like "--connect qemu:///x" must not smuggle a new flag — quoting
  // keeps it a single positional argument to virsh.
  const inv = buildInvocation({ host: "h" }, [
    "dominfo",
    "--connect qemu:///x",
  ]);
  assertEquals(
    inv.args.at(-1),
    "'virsh' 'dominfo' '--connect qemu:///x'",
  );
});

// --- SSH host-key hardening (issue libvirt-ssh-hardening) --------------------

const HARDENED_SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
];

Deno.test("SSH path uses hardened opts (accept-new + BatchMode), not blind-accept", () => {
  for (
    const inv of [
      buildInvocation({ host: "h" }, ["list"]),
      buildSshRaw({ host: "h" }, ["ip", "route"]),
    ]
  ) {
    // SSH_OPTS is the argv prefix before [target, remoteCommand].
    assertEquals(
      inv.args.slice(0, HARDENED_SSH_OPTS.length),
      HARDENED_SSH_OPTS,
    );
    const joined = inv.args.join(" ");
    assert(!joined.includes("StrictHostKeyChecking=no"));
    assert(!joined.includes("UserKnownHostsFile=/dev/null"));
  }
});

// --- buildSshRaw (non-virsh remote commands, e.g. addRoute) ------------------

Deno.test("buildSshRaw: ssh + SSH_OPTS + target + quoted argv (no virsh prefix)", () => {
  const inv = buildSshRaw({ host: "h", user: "bob" }, [
    "ip",
    "route",
    "replace",
    "10.244.0.0/16",
    "via",
    "10.0.0.1",
  ]);
  assertEquals(inv.command, "ssh");
  assertEquals(inv.args.at(-2), "bob@h");
  assertEquals(
    inv.args.at(-1),
    "'ip' 'route' 'replace' '10.244.0.0/16' 'via' '10.0.0.1'",
  );
});

Deno.test("buildSshRaw: an injected token stays a single quoted element", () => {
  const inv = buildSshRaw({ host: "h" }, ["ip", "route", "add", "x; reboot"]);
  assertStringIncludes(inv.args.at(-1)!, "'x; reboot'");
});

Deno.test("buildSshRaw throws in local mode (no host)", () => {
  let threw = false;
  try {
    buildSshRaw({}, ["ip", "route"]);
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "requires SSH host mode");
  }
  assert(threw, "buildSshRaw should throw without a host");
});

// --- runSshRaw guard ---------------------------------------------------------

Deno.test("runSshRaw throws in local mode (no host)", async () => {
  await assertRejects(
    () => runSshRaw({}, ["ip", "route"]),
    Error,
    "requires SSH host mode",
  );
});

// --- redactSecrets (log redaction, issue libvirt-log-redaction) --------------

Deno.test("redactSecrets masks a single-quoted graphics password", () => {
  assertEquals(
    redactSecrets("<graphics type='vnc' port='5900' passwd='hunter2'/>"),
    "<graphics type='vnc' port='5900' passwd='***'/>",
  );
});

Deno.test("redactSecrets masks a double-quoted graphics password", () => {
  assertEquals(
    redactSecrets(`<graphics type="spice" passwd="s3cr3t"/>`),
    `<graphics type="spice" passwd="***"/>`,
  );
});

Deno.test("redactSecrets does NOT redact passwdValidTo timestamps", () => {
  const xml =
    "<graphics type='vnc' passwd='hunter2' passwdValidTo='2026-05-20T10:00:00'/>";
  assertEquals(
    redactSecrets(xml),
    "<graphics type='vnc' passwd='***' passwdValidTo='2026-05-20T10:00:00'/>",
  );
});

Deno.test("redactSecrets masks every occurrence and leaves other text intact", () => {
  const input = "a passwd='one' b passwd='two' c";
  assertEquals(redactSecrets(input), "a passwd='***' b passwd='***' c");
});

Deno.test("redactSecrets is a no-op when there is no password", () => {
  const xml = "<domain><name>web</name></domain>";
  assertEquals(redactSecrets(xml), xml);
});

// --- includesAny (idempotency predicate) ------------------------------------

Deno.test("includesAny matches any needle, case-sensitive", () => {
  assert(includesAny("error: Domain is already active", ["already active"]));
  assert(!includesAny("error: some other failure", ["already active"]));
  assert(includesAny("a b c", ["x", "b"]));
});
