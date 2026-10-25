// Unit tests for lib/provision.ts and the vm.provision / vm.connection /
// vm.plan / vm.sync methods. The pure builders are tested directly; the
// orchestration runs against a stubbed Deno.Command in SSH mode (multiplex
// off), so every call is one `ssh … '<quoted argv>'` that the stub decodes.
// Run: deno test extensions/models/libvirt_provision_test.ts

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertFilesOnHypervisor,
  buildDomainXml,
  buildSeedIso,
  defaultChecksumsUrl,
  defaultMac,
  DesiredVmSchema,
  imageFileName,
  isSafeAbsPath,
  isSwampManaged,
  makeNoCloudIso,
  parseChecksums,
  parseDomIfAddr,
  planVms,
  primaryIpv4,
  type ProvisionSpec,
  ProvisionSpecSchema,
  provisionVm,
  renderMetaData,
  renderNetworkConfig,
  renderUserData,
  SWAMP_METADATA_NS,
  vmPaths,
  waitForAddress,
  xmlEscape,
} from "./lib/provision.ts";
import { model as vmModel } from "./libvirt_vm.ts";

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop";
const SHA = "a".repeat(64);
const IMG =
  "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";

function spec(over: Record<string, unknown> = {}): ProvisionSpec {
  return ProvisionSpecSchema.parse({
    name: "web1",
    image: { url: IMG, checksum: `sha256:${SHA}` },
    cloudInit: { sshAuthorizedKeys: [KEY] },
    ...over,
  });
}

// --- schema --------------------------------------------------------------------

Deno.test("ProvisionSpecSchema: defaults", () => {
  const s = spec();
  assertEquals(s.storageDir, "/var/lib/libvirt/images");
  assertEquals(s.diskMode, "copy");
  assertEquals(s.diskSizeGb, 20);
  assertEquals(s.memoryMiB, 2048);
  assertEquals(s.vcpus, 2);
  assertEquals(s.firmware, "bios");
  assertEquals(s.network, { type: "network", source: "default" });
  assertEquals(s.cloudInit.guestAgent, true);
  assertEquals(s.start, true);
  assertEquals(s.waitForIpSeconds, 600);
  assertEquals(s.image.format, "qcow2");
});

Deno.test("ProvisionSpecSchema: rejects names, paths, keys and URLs that would break files, XML or argv", () => {
  const bad: Record<string, unknown>[] = [
    { name: "../etc" },
    { name: "a b" },
    { name: "-x" },
    { name: "a'b" },
    { storageDir: "relative/dir" },
    { storageDir: "/mnt/user/../etc" },
    { storageDir: "/mnt/user domains" },
    { cacheDir: "/tmp/./x" },
    { image: { url: "file:///etc/passwd" } },
    { image: { url: "https://x/y.img'; reboot" } },
    { image: { url: IMG, checksum: "md5:abc" } },
    { cloudInit: { sshAuthorizedKeys: ["not a key"] } },
    { cloudInit: { sshAuthorizedKeys: [`${KEY}\nssh-rsa AAAA`] } },
    { cloudInit: { user: "Root" } },
    { cloudInit: { packages: ["-oDebug=1"] } },
    { cloudInit: { userData: "users: []" } },
    { network: { type: "bridge", source: "br0'/><x" } },
    { network: { mac: "52:54:00:AA:BB:CC" } },
  ];
  for (const over of bad) {
    const r = ProvisionSpecSchema.safeParse({
      name: "web1",
      image: { url: IMG },
      ...over,
    });
    assert(!r.success, `should reject ${JSON.stringify(over)}`);
  }
});

Deno.test("isSafeAbsPath", () => {
  assert(isSafeAbsPath("/mnt/user/domains"));
  assert(isSafeAbsPath("/var/lib/libvirt/images/"));
  for (const p of ["mnt", "/a/../b", "/a/./b", "/a b", "/a$b", "/a'b", ""]) {
    assert(!isSafeAbsPath(p), p);
  }
});

Deno.test("DesiredVmSchema: image optional, state defaults to running", () => {
  const d = DesiredVmSchema.parse({ name: "x" });
  assertEquals(d.state, "running");
  assertEquals(d.image, undefined);
});

// --- paths, mac, xml -----------------------------------------------------------

Deno.test("vmPaths: per-VM folder under storageDir, cache beside it", () => {
  assertEquals(vmPaths({ name: "web1", storageDir: "/mnt/user/domains/" }), {
    vmDir: "/mnt/user/domains/web1",
    disk: "/mnt/user/domains/web1/web1.qcow2",
    seed: "/mnt/user/domains/web1/web1-cidata.iso",
    cacheDir: "/mnt/user/domains/.swamp-image-cache",
  });
  assertEquals(
    vmPaths({ name: "a", storageDir: "/s", cacheDir: "/c" }).cacheDir,
    "/c",
  );
});

Deno.test("defaultMac: stable, KVM prefix, differs per name", async () => {
  const a = await defaultMac("web1");
  assert(/^52:54:00(:[0-9a-f]{2}){3}$/.test(a));
  assertEquals(a, await defaultMac("web1"));
  assert(a !== await defaultMac("web2"));
});

Deno.test("xmlEscape escapes the five XML specials", () => {
  assertEquals(
    xmlEscape(`<a href="x" b='y'>&`),
    "&lt;a href=&quot;x&quot; b=&apos;y&apos;&gt;&amp;",
  );
});

Deno.test("buildDomainXml: libvirt network, BIOS, swamp metadata, agent channel, seed as a read-only virtio disk", () => {
  const xml = buildDomainXml(spec(), {
    disk: "/d/web1/web1.qcow2",
    seed: "/d/web1/web1-cidata.iso",
    mac: "52:54:00:01:02:03",
  });
  assertStringIncludes(xml, "<name>web1</name>");
  assertStringIncludes(xml, `xmlns:swamp='${SWAMP_METADATA_NS}'`);
  assertStringIncludes(xml, "<memory unit='MiB'>2048</memory>");
  assertStringIncludes(xml, "<vcpu>2</vcpu>");
  assertStringIncludes(xml, "<os>\n");
  assertStringIncludes(xml, "machine='q35'");
  assertStringIncludes(xml, "<source file='/d/web1/web1.qcow2'/>");
  assertStringIncludes(xml, "<source file='/d/web1/web1-cidata.iso'/>");
  assertStringIncludes(
    xml,
    "<target dev='vdb' bus='virtio'/>\n      <readonly/>",
  );
  assert(!xml.includes("cdrom"), "virtio-only kernels have no CD-ROM driver");
  assertStringIncludes(xml, "<interface type='network'>");
  assertStringIncludes(xml, "<source network='default'/>");
  assertStringIncludes(xml, "<mac address='52:54:00:01:02:03'/>");
  assertStringIncludes(xml, "name='org.qemu.guest_agent.0'");
});

Deno.test("buildDomainXml: bridge + UEFI", () => {
  const xml = buildDomainXml(
    spec({ network: { type: "bridge", source: "br0" }, firmware: "uefi" }),
    { disk: "/d", seed: "/s", mac: "52:54:00:01:02:03" },
  );
  assertStringIncludes(xml, "<interface type='bridge'>");
  assertStringIncludes(xml, "<source bridge='br0'/>");
  assertStringIncludes(xml, "<os firmware='efi'>");
});

// --- cloud-init ------------------------------------------------------------------

function userDataJson(text: string) {
  assert(text.startsWith("#cloud-config\n"));
  return JSON.parse(text.slice("#cloud-config\n".length));
}

Deno.test("renderUserData: default user gets the keys; guest agent installed and started", () => {
  const cfg = userDataJson(renderUserData(spec()));
  assertEquals(cfg.hostname, "web1");
  assertEquals(cfg.ssh_authorized_keys, [KEY]);
  assertEquals(cfg.ssh_pwauth, false);
  assertEquals(cfg.packages, ["qemu-guest-agent"]);
  assertEquals(cfg.runcmd, [[
    "systemctl",
    "enable",
    "--now",
    "qemu-guest-agent",
  ]]);
  assertEquals(cfg.users, undefined);
});

Deno.test("renderUserData: named user with sudo, keys and an optional password hash", () => {
  const cfg = userDataJson(renderUserData(spec({
    cloudInit: {
      user: "ops",
      sshAuthorizedKeys: [KEY],
      passwordHash: "$6$salt$hash",
      packages: ["htop", "qemu-guest-agent"],
      fqdn: "web1.lab.example",
    },
  })));
  assertEquals(cfg.users[0], "default");
  assertEquals(cfg.users[1].name, "ops");
  assertEquals(cfg.users[1].sudo, "ALL=(ALL) NOPASSWD:ALL");
  assertEquals(cfg.users[1].lock_passwd, false);
  assertEquals(cfg.users[1].passwd, "$6$salt$hash");
  assertEquals(cfg.users[1].ssh_authorized_keys, [KEY]);
  assertEquals(cfg.packages, ["qemu-guest-agent", "htop"]);
  assertEquals(cfg.fqdn, "web1.lab.example");
  assertEquals(cfg.ssh_authorized_keys, undefined);
});

Deno.test("renderUserData: guestAgent false adds nothing; raw userData is used verbatim", () => {
  const cfg = userDataJson(
    renderUserData(spec({ cloudInit: { guestAgent: false } })),
  );
  assertEquals(cfg.packages, undefined);
  assertEquals(cfg.runcmd, undefined);
  const raw = "#cloud-config\nusers: []\n";
  assertEquals(renderUserData(spec({ cloudInit: { userData: raw } })), raw);
});

Deno.test("renderUserData: a VM name that is not a valid hostname is not used as one", () => {
  const cfg = userDataJson(renderUserData(spec({ name: "web_1" })));
  assertEquals(cfg.hostname, undefined);
});

Deno.test("renderMetaData: instance-id and local-hostname", () => {
  assertEquals(JSON.parse(renderMetaData(spec())), {
    "instance-id": "swamp-web1",
    "local-hostname": "web1",
  });
});

Deno.test("renderNetworkConfig: DHCP by default; static IP matches the NIC by MAC", () => {
  assertEquals(renderNetworkConfig(spec(), "52:54:00:01:02:03"), undefined);
  const net = JSON.parse(
    renderNetworkConfig(
      spec({
        cloudInit: {
          staticIp: {
            address: "192.0.2.10/24",
            gateway: "192.0.2.1",
            nameservers: ["192.0.2.53"],
          },
        },
      }),
      "52:54:00:01:02:03",
    )!,
  );
  assertEquals(net.version, 2);
  assertEquals(net.ethernets.primary.match, {
    macaddress: "52:54:00:01:02:03",
  });
  assertEquals(net.ethernets.primary.addresses, ["192.0.2.10/24"]);
  assertEquals(net.ethernets.primary.routes, [{
    to: "default",
    via: "192.0.2.1",
  }]);
  assertEquals(net.ethernets.primary.nameservers, {
    addresses: ["192.0.2.53"],
  });
});

// --- ISO 9660 --------------------------------------------------------------------

const dec = new TextDecoder();

function isoFiles(iso: Uint8Array) {
  const root = iso.subarray(18 * 2048, 19 * 2048);
  const out: Record<string, string> = {};
  let off = 0;
  while (off < root.length && root[off] > 0) {
    const len = root[off];
    const lba = root[off + 2] | root[off + 3] << 8 | root[off + 4] << 16;
    const size = root[off + 10] | root[off + 11] << 8 | root[off + 12] << 16;
    const nameLen = root[off + 32];
    const name = dec.decode(root.subarray(off + 33, off + 33 + nameLen));
    if (nameLen > 1) {
      out[name] = dec.decode(iso.subarray(lba * 2048, lba * 2048 + size));
    }
    off += len;
  }
  return out;
}

Deno.test("makeNoCloudIso: CIDATA label, CD001 descriptors, files readable from the root directory", () => {
  const big = "x".repeat(5000); // spans 3 sectors
  const iso = makeNoCloudIso([["meta-data", "m"], ["user-data", big]]);
  assertEquals(dec.decode(iso.subarray(16 * 2048 + 1, 16 * 2048 + 6)), "CD001");
  assertEquals(
    dec.decode(iso.subarray(16 * 2048 + 40, 16 * 2048 + 46)),
    "CIDATA",
  );
  assertEquals(iso[17 * 2048], 255);
  assertEquals(iso.length % 2048, 0);
  assertEquals(isoFiles(iso), { "META-DATA": "m", "USER-DATA": big });
});

Deno.test("makeNoCloudIso: rejects no files, bad or duplicate names, and an overfull root", () => {
  assertThrows(() => makeNoCloudIso([]));
  assertThrows(() => makeNoCloudIso([["../x", ""]]));
  assertThrows(() => makeNoCloudIso([["a", ""], ["A", ""]]));
  const many = Array.from(
    { length: 60 },
    (_, i) => [`file-${i}`, ""] as [string, string],
  );
  assertThrows(() => makeNoCloudIso(many), Error, "one-sector");
});

Deno.test("buildSeedIso: meta-data + user-data, plus network-config with a static IP", () => {
  const plain = isoFiles(buildSeedIso(spec(), "52:54:00:01:02:03"));
  assertEquals(Object.keys(plain).sort(), ["META-DATA", "USER-DATA"]);
  const withNet = isoFiles(buildSeedIso(
    spec({ cloudInit: { staticIp: { address: "192.0.2.10/24" } } }),
    "52:54:00:01:02:03",
  ));
  assert("NETWORK-CONFIG" in withNet);
});

// --- checksums, domifaddr --------------------------------------------------------

Deno.test("image URL helpers", () => {
  assertEquals(imageFileName(`${IMG}?x=1`), "noble-server-cloudimg-amd64.img");
  assertEquals(
    defaultChecksumsUrl(IMG),
    "https://cloud-images.ubuntu.com/noble/current/SHA256SUMS",
  );
});

Deno.test("parseChecksums: text and binary markers, sha512 by length, ./ prefix, missing file", () => {
  const s512 = "b".repeat(128);
  const text = [
    `${SHA} *noble-server-cloudimg-amd64.img`,
    `${"c".repeat(64)}  other.img`,
    `${s512}  ./debian-12-genericcloud-amd64.qcow2`,
  ].join("\n");
  assertEquals(
    parseChecksums(text, "noble-server-cloudimg-amd64.img"),
    `sha256:${SHA}`,
  );
  assertEquals(
    parseChecksums(text, "debian-12-genericcloud-amd64.qcow2"),
    `sha512:${s512}`,
  );
  assertEquals(parseChecksums(text, "missing.img"), null);
});

const DOMIFADDR = ` Name       MAC address          Protocol     Address
-------------------------------------------------------------------------------
 lo         00:00:00:00:00:00    ipv4         127.0.0.1/8
 -          -                    ipv6         ::1/128
 enp1s0     52:54:00:01:02:03    ipv4         192.168.122.50/24
 -          -                    ipv6         fe80::5054:ff:fe01:203/64
`;

Deno.test("parseDomIfAddr: continuation rows inherit interface + MAC; primaryIpv4 skips loopback", () => {
  const addrs = parseDomIfAddr(DOMIFADDR);
  assertEquals(addrs.length, 4);
  assertEquals(addrs[3], {
    interface: "enp1s0",
    mac: "52:54:00:01:02:03",
    family: "ipv6",
    address: "fe80::5054:ff:fe01:203",
    prefix: 64,
  });
  assertEquals(primaryIpv4(addrs)?.address, "192.168.122.50");
  assertEquals(primaryIpv4(parseDomIfAddr("")), undefined);
});

// --- planVms ---------------------------------------------------------------------

Deno.test("planVms: every action", () => {
  const want = (name: string, state: "running" | "stopped" | "absent") => ({
    name,
    state,
    memoryMiB: 2048,
    vcpus: 2,
  });
  const obs = (state: string, managed = true, memoryMiB = 2048) => ({
    state,
    memoryMiB,
    vcpus: 2,
    managed,
    disks: [],
  });
  const items = planVms(
    [
      want("new", "running"),
      want("gone", "absent"),
      want("off", "running"),
      want("on", "stopped"),
      want("del", "absent"),
      want("foreign", "absent"),
      want("ok", "running"),
      want("nap", "running"),
      want("nap2", "stopped"),
    ],
    new Map([
      ["off", obs("shut off")],
      ["on", obs("running")],
      ["del", obs("running")],
      ["foreign", obs("running", false)],
      ["ok", obs("running", true, 4096)],
      ["nap", obs("paused")],
      ["nap2", obs("paused")],
    ]),
  );
  assertEquals(items.map((i) => [i.name, i.action]), [
    ["new", "create"],
    ["gone", "none"],
    ["off", "start"],
    ["on", "stop"],
    ["del", "delete"],
    ["foreign", "refuse"],
    ["ok", "none"],
    ["nap", "resume"],
    ["nap2", "stop"],
  ]);
  assertEquals(items[6].drift, ["memoryMiB 4096 != desired 2048"]);
  assert(items.every((i) => i.result === "planned"));
});

// --- orchestration (stubbed ssh) -------------------------------------------------

type Route = (argv: string[], stdin?: Uint8Array) =>
  | { code: number; stdout?: string; stderr?: string }
  | undefined;

/** Decode the remote command string of an ssh invocation back into argv. */
function remoteArgv(args: string[]): string[] {
  const remote = args[args.length - 1];
  return [...remote.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) =>
    m[1].replaceAll("'\\''", "'")
  );
}

async function withSsh(
  routes: Route[],
  fn: (calls: { argv: string[]; stdin?: Uint8Array }[]) => Promise<void>,
) {
  const original = Deno.Command;
  const calls: { argv: string[]; stdin?: Uint8Array }[] = [];
  const enc = new TextEncoder();
  const respond = (argv: string[], stdin?: Uint8Array) => {
    calls.push({ argv, stdin });
    for (const r of routes) {
      const res = r(argv, stdin);
      if (res) {
        return Promise.resolve({
          code: res.code,
          success: res.code === 0,
          stdout: enc.encode(res.stdout ?? ""),
          stderr: enc.encode(res.stderr ?? ""),
        });
      }
    }
    throw new Error(`unrouted: ${JSON.stringify(argv)}`);
  };
  class FakeCommand {
    #args: string[];
    constructor(_cmd: string, opts: { args: string[] }) {
      this.#args = opts.args;
    }
    output() {
      return respond(remoteArgv(this.#args));
    }
    spawn() {
      const chunks: Uint8Array[] = [];
      const args = this.#args;
      return {
        stdin: {
          getWriter: () => ({
            write: (c: Uint8Array) => {
              chunks.push(c);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => respond(remoteArgv(args), chunks[0]),
      };
    }
  }
  // @ts-ignore test stub replaces the Deno global
  Deno.Command = FakeCommand;
  try {
    await fn(calls);
  } finally {
    // @ts-ignore restore
    Deno.Command = original;
  }
}

const CONN = { host: "hv", multiplex: false };
const ok = (stdout = "") => ({ code: 0, stdout });
const is = (...prefix: string[]) => (argv: string[]) =>
  prefix.every((p, i) => argv[i] === p);
/** `sh -c 'test -e "$1" || test -L "$1"' sh <path>` — the exists() probe. */
const isExists = (a: string[]) =>
  is("sh", "-c")(a) && a[2].startsWith("test -e");
const MANAGED_XML =
  `<domain><metadata><swamp:vm xmlns:swamp='${SWAMP_METADATA_NS}'><swamp:managed>true</swamp:managed></swamp:vm></metadata></domain>`;
const IMAGE_INFO = JSON.stringify({
  format: "qcow2",
  "virtual-size": 3758096384,
});

function happyRoutes(state: { domain: boolean; cached: boolean }): Route[] {
  return [
    (a) =>
      is("virsh", "domstate")(a)
        ? state.domain
          ? ok("running\n")
          : { code: 1, stderr: "error: failed to get domain 'web1'" }
        : undefined,
    (a) => is("virsh", "dumpxml")(a) ? ok(MANAGED_XML) : undefined,
    (a) => is("mkdir")(a) ? ok() : undefined,
    (a) =>
      isExists(a)
        ? { code: a[4].includes(".swamp-image-cache") && state.cached ? 0 : 1 }
        : undefined,
    (a) => is("sha256sum")(a) ? ok(`${SHA}  ${a[1]}\n`) : undefined,
    (a) => is("curl")(a) ? ok() : undefined,
    (a) => is("chmod")(a) ? ok() : undefined,
    (a) => is("mv")(a) ? ok() : undefined,
    (a) => is("qemu-img", "info")(a) ? ok(IMAGE_INFO) : undefined,
    (a) => is("qemu-img")(a) ? ok() : undefined,
    (a) => is("sh", "-c")(a) ? ok() : undefined,
    (a) =>
      is("virsh", "define", "/dev/stdin")(a)
        ? ok("Domain 'web1' defined")
        : undefined,
    (a) => is("virsh", "start")(a) ? ok() : undefined,
    (a) => is("virsh", "resume")(a) ? ok() : undefined,
    (a) => is("virsh", "autostart")(a) ? ok() : undefined,
    (a) => is("rm")(a) ? ok() : undefined,
    (a) => is("rmdir")(a) ? ok() : undefined,
    (a) => is("virsh", "destroy")(a) ? ok() : undefined,
    (a) => is("virsh", "undefine")(a) ? ok() : undefined,
  ];
}

Deno.test("provisionVm: new VM — claim folder, download, verify, inspect, copy + resize, seed ISO over stdin, define, start", async () => {
  await withSsh(
    happyRoutes({ domain: false, cached: false }),
    async (calls) => {
      const res = await provisionVm(
        CONN,
        spec({ storageDir: "/mnt/user/domains" }),
        () => {},
      );
      assertEquals(res.action, "created");
      assertEquals(res.state, "running");
      const seq = calls.map((c) =>
        isExists(c.argv) ? "exists" : c.argv.slice(0, 2).join(" ")
      );
      assertEquals(seq, [
        "virsh domstate",
        "mkdir -p",
        "mkdir -p",
        "mkdir -m",
        "exists",
        "curl -fsSL",
        "sha256sum " + calls[6].argv[1],
        "chmod 0444",
        "mv -f",
        "qemu-img info",
        "qemu-img convert",
        "qemu-img resize",
        "chmod 0600",
        "sh -c",
        "virsh define",
        "virsh start",
      ]);
      // the folder claim is a plain mkdir (atomic, fails if it exists)
      assertEquals(calls[3].argv, [
        "mkdir",
        "-m",
        "0755",
        "--",
        "/mnt/user/domains/web1",
      ]);
      assertEquals(calls[5].argv.at(-1), IMG);
      assert(calls[5].argv.includes("--proto"));
      assertEquals(calls[11].argv.slice(-2), [
        "/mnt/user/domains/web1/web1.qcow2",
        "20G",
      ]);
      const seed = calls[13];
      assertStringIncludes(seed.argv[2], "set -C"); // no-clobber
      assertEquals(seed.argv.at(-1), "/mnt/user/domains/web1/web1-cidata.iso");
      assert(
        seed.stdin && seed.stdin.length % 2048 === 0,
        "seed ISO bytes on stdin",
      );
    },
  );
});

Deno.test("provisionVm: cache hit skips the download; overlay mode uses a backing file", async () => {
  await withSsh(happyRoutes({ domain: false, cached: true }), async (calls) => {
    await provisionVm(
      CONN,
      spec({ diskMode: "overlay", diskSizeGb: 8 }),
      () => {},
    );
    assert(!calls.some((c) => c.argv[0] === "curl"));
    const create = calls.find((c) => is("qemu-img", "create")(c.argv))!.argv;
    assert(create.includes("-b"));
    assertEquals(create.at(-1), "8G");
  });
});

Deno.test("provisionVm: existing swamp domain is never rebuilt, only started/resumed", async () => {
  await withSsh(happyRoutes({ domain: true, cached: false }), async (calls) => {
    const res = await provisionVm(CONN, spec(), () => {});
    assertEquals(res.action, "exists");
    assertEquals(calls.map((c) => c.argv[1]), ["domstate", "dumpxml"]);
  });
  const routes = happyRoutes({ domain: true, cached: false });
  routes.unshift((a) =>
    is("virsh", "domstate")(a) ? ok("paused\n") : undefined
  );
  await withSsh(routes, async (calls) => {
    await provisionVm(CONN, spec(), () => {});
    assert(calls.some((c) => is("virsh", "resume", "web1")(c.argv)));
  });
});

Deno.test("provisionVm: a same-named domain swamp did not create is an error, never started", async () => {
  const routes = happyRoutes({ domain: true, cached: false });
  routes.unshift((a) =>
    is("virsh", "dumpxml")(a) ? ok("<domain/>") : undefined
  );
  await withSsh(routes, async (calls) => {
    await assertRejects(
      () => provisionVm(CONN, spec(), () => {}),
      Error,
      "not created by swamp",
    );
    assert(!calls.some((c) => c.argv[1] === "start"));
  });
});

Deno.test("provisionVm: a leftover folder (or a concurrent provision) fails the claim, nothing is written or removed", async () => {
  const routes = happyRoutes({ domain: false, cached: false });
  routes.unshift((a) =>
    is("mkdir", "-m")(a) ? { code: 1, stderr: "mkdir: File exists" } : undefined
  );
  await withSsh(routes, async (calls) => {
    await assertRejects(
      () => provisionVm(CONN, spec(), () => {}),
      Error,
      "already exists",
    );
    assert(
      !calls.some((c) =>
        ["qemu-img", "rm", "rmdir", "curl"].includes(c.argv[0])
      ),
    );
  });
});

Deno.test("provisionVm: checksum mismatch removes the partial download and the claimed folder", async () => {
  const routes = happyRoutes({ domain: false, cached: false });
  routes.unshift((a) =>
    is("sha256sum")(a) ? ok(`${"f".repeat(64)}  x\n`) : undefined
  );
  await withSsh(routes, async (calls) => {
    await assertRejects(
      () => provisionVm(CONN, spec(), () => {}),
      Error,
      "does not match",
    );
    const rms = calls.filter((c) => c.argv[0] === "rm").map((c) =>
      c.argv.at(-1)!
    );
    assert(rms[0].includes(".part-"));
    assert(!calls.some((c) => c.argv[0] === "mv"));
    assert(
      calls.some((c) =>
        is("rmdir", "--", "/var/lib/libvirt/images/web1")(c.argv)
      ),
    );
  });
});

Deno.test("provisionVm: an image with a backing file or the wrong format is refused", async () => {
  for (
    const info of [
      { format: "qcow2", "virtual-size": 1, "backing-filename": "/dev/sda" },
      { format: "raw", "virtual-size": 1 },
    ]
  ) {
    const routes = happyRoutes({ domain: false, cached: true });
    routes.unshift((a) =>
      is("qemu-img", "info")(a) ? ok(JSON.stringify(info)) : undefined
    );
    await withSsh(routes, async (calls) => {
      await assertRejects(() => provisionVm(CONN, spec(), () => {}), Error);
      assert(!calls.some((c) => is("qemu-img", "convert")(c.argv)));
    });
  }
});

Deno.test("provisionVm: diskSizeGb smaller than the image is refused (overlay would truncate)", async () => {
  await withSsh(happyRoutes({ domain: false, cached: true }), async (calls) => {
    await assertRejects(
      () =>
        provisionVm(
          CONN,
          spec({ diskMode: "overlay", diskSizeGb: 2 }),
          () => {},
        ),
      Error,
      "smaller than the image",
    );
    assert(!calls.some((c) => is("qemu-img", "create")(c.argv)));
  });
});

Deno.test("provisionVm: a start failure undefines the domain and removes its files and folder", async () => {
  const routes = happyRoutes({ domain: false, cached: true });
  routes.unshift((a) =>
    is("virsh", "start")(a)
      ? { code: 1, stderr: "error: no bridge" }
      : undefined
  );
  await withSsh(routes, async (calls) => {
    await assertRejects(
      () => provisionVm(CONN, spec(), () => {}),
      Error,
      "no bridge",
    );
    const after = calls.slice(
      calls.findIndex((c) => is("virsh", "start")(c.argv)),
    );
    assert(after.some((c) => is("virsh", "undefine")(c.argv)));
    const rm = after.find((c) => c.argv[0] === "rm")!.argv;
    assertEquals(rm.slice(3).sort(), [
      "/var/lib/libvirt/images/web1/web1-cidata.iso",
      "/var/lib/libvirt/images/web1/web1.qcow2",
    ]);
    assert(
      after.some((c) =>
        is("rmdir", "--", "/var/lib/libvirt/images/web1")(c.argv)
      ),
    );
  });
});

Deno.test("provisionVm: checksum read from SHA256SUMS next to the image when not pinned", async () => {
  const routes = happyRoutes({ domain: false, cached: true });
  routes.unshift((a) =>
    is("curl")(a) && a.at(-1)!.endsWith("SHA256SUMS")
      ? ok(`${SHA} *noble-server-cloudimg-amd64.img\n`)
      : undefined
  );
  await withSsh(routes, async () => {
    const res = await provisionVm(
      CONN,
      spec({ image: { url: IMG } }),
      () => {},
    );
    assertEquals(res.checksum, `sha256:${SHA}`);
  });
});

Deno.test("provisionVm: an http image without a pinned checksum is refused before anything runs on the host", async () => {
  await withSsh(happyRoutes({ domain: false, cached: true }), async (calls) => {
    await assertRejects(
      () =>
        provisionVm(
          CONN,
          spec({ image: { url: "http://mirror.example/x.img" } }),
          () => {},
        ),
      Error,
      "plain http",
    );
    assertEquals(calls.map((c) => c.argv[1]), ["domstate"]);
  });
});

Deno.test("assertFilesOnHypervisor: local mode with a remote uri is refused", () => {
  assertThrows(() =>
    assertFilesOnHypervisor({ uri: "qemu+ssh://root@h/system" })
  );
  assertFilesOnHypervisor({ uri: "qemu:///system" });
  assertFilesOnHypervisor({});
  assertFilesOnHypervisor({ host: "h", uri: "qemu+ssh://x/system" });
});

Deno.test("isSwampManaged: needs the managed element in swamp's namespace, whatever the prefix", () => {
  assert(isSwampManaged(MANAGED_XML));
  assert(
    isSwampManaged(
      MANAGED_XML.replaceAll("swamp:", "ns0:").replace(
        "xmlns:swamp",
        "xmlns:ns0",
      ),
    ),
  );
  assert(!isSwampManaged(`<description>${SWAMP_METADATA_NS}</description>`));
  assert(!isSwampManaged("<domain/>"));
});

// --- methods ------------------------------------------------------------------------

function ctx() {
  const written: {
    spec: string;
    name: string;
    payload: Record<string, unknown>;
  }[] = [];
  return {
    written,
    ctx: {
      globalArgs: CONN,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      writeResource: (
        spec: string,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        written.push({ spec, name, payload });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

// deno-lint-ignore no-explicit-any
const methods = vmModel.methods as any;

Deno.test("vm.provision: writes actionResult + connection with the agent address", async () => {
  const routes = happyRoutes({ domain: false, cached: true });
  routes.unshift((a) =>
    is("virsh", "domifaddr")(a) ? ok(DOMIFADDR) : undefined
  );
  await withSsh(routes, async () => {
    const { ctx: c, written } = ctx();
    await methods.provision.execute(
      spec({ cloudInit: { user: "ops", sshAuthorizedKeys: [KEY] } }),
      c,
    );
    const conn = written.find((w) => w.spec === "connection")!;
    assertEquals(conn.name, "web1");
    assertEquals(conn.payload.ip, "192.168.122.50");
    assertEquals(conn.payload.source, "agent");
    assertEquals(conn.payload.sshUser, "ops");
    assertEquals(conn.payload.hostname, "web1");
    assertEquals(
      written.find((w) => w.spec === "actionResult")!.payload.action,
      "provision:created",
    );
  });
});

Deno.test("vm.connection: a flag-shaped name is rejected by the schema", () => {
  assert(!methods.connection.arguments.safeParse({ name: "--help" }).success);
});

const LIST = ` Id   Name      State
------------------------------
 1    on        running
 -    del       shut off
 2    foreign   running
 3    nap       paused
`;
const INFO = "CPU(s):         2\nMax memory:     2097152 KiB\n";
const DEL_XML = MANAGED_XML.replace(
  "</domain>",
  "<devices><disk><source file='/mnt/user/domains/del/del.qcow2'/><target dev='vda' bus='virtio'/></disk><disk><source file='/mnt/user/domains/del/del-cidata.iso'/><target dev='vdb' bus='virtio'/></disk></devices></domain>",
);

function syncRoutes(delXml = DEL_XML): Route[] {
  return [
    (a) => is("virsh", "list")(a) ? ok(LIST) : undefined,
    (a) => is("virsh", "dominfo")(a) ? ok(INFO) : undefined,
    (a) =>
      is("virsh", "dumpxml")(a)
        ? ok(
          a[2] === "foreign"
            ? "<domain/>"
            : a[2] === "del"
            ? delXml
            : MANAGED_XML,
        )
        : undefined,
    (a) => is("virsh", "shutdown")(a) ? ok() : undefined,
    (a) => is("virsh", "domstate")(a) ? ok("shut off\n") : undefined,
    (a) => is("virsh", "resume")(a) ? ok() : undefined,
    (a) =>
      is("virsh", "destroy")(a)
        ? { code: 1, stderr: "error: domain is not running" }
        : undefined,
    (a) => is("virsh", "undefine")(a) ? ok() : undefined,
    (a) => is("rm", "-f")(a) ? ok() : undefined,
    (a) => is("rmdir")(a) ? ok() : undefined,
  ];
}

const DESIRED = [
  { name: "on", state: "stopped" },
  { name: "del", state: "absent", storageDir: "/mnt/user/domains" },
  { name: "foreign", state: "absent" },
  { name: "nap", state: "running" },
];
const syncArgs = (over: Record<string, unknown> = {}) => ({
  vms: DESIRED.map((d) => DesiredVmSchema.parse(d)),
  allowDelete: false,
  deleteStorage: false,
  stopWaitSeconds: 5,
  forceStopAfterWait: false,
  ...over,
});

Deno.test("vm.plan: stores the plan and changes nothing", async () => {
  await withSsh(syncRoutes(), async (calls) => {
    const { ctx: c, written } = ctx();
    await methods.plan.execute(
      { vms: DESIRED.map((d) => DesiredVmSchema.parse(d)) },
      c,
    );
    const plan = written[0].payload as {
      items: { name: string; action: string }[];
      mode: string;
      changes: number;
    };
    assertEquals(plan.mode, "plan");
    assertEquals(plan.items.map((i) => i.action), [
      "stop",
      "delete",
      "refuse",
      "resume",
    ]);
    assertEquals(plan.changes, 3); // refuse is not a change
    assert(
      !calls.some((x) =>
        ["shutdown", "undefine", "destroy", "resume"].includes(x.argv[1])
      ),
    );
  });
});

Deno.test("vm.sync: without allowDelete deletes nothing; stop and resume run; unmanaged is refused", async () => {
  await withSsh(syncRoutes(), async (calls) => {
    const { ctx: c, written } = ctx();
    await methods.sync.execute(syncArgs(), c);
    const items =
      (written.at(-1)!.payload as { items: { name: string; result: string }[] })
        .items;
    assertEquals(items.map((i) => [i.name, i.result]), [
      ["on", "done"],
      ["del", "skipped"],
      ["foreign", "skipped"],
      ["nap", "done"],
    ]);
    assert(calls.some((x) => is("virsh", "shutdown", "on")(x.argv)));
    assert(calls.some((x) => is("virsh", "resume", "nap")(x.argv)));
    assert(!calls.some((x) => x.argv[1] === "undefine"));
  });
});

Deno.test("vm.sync: allowDelete + deleteStorage removes exactly the two provision files and rmdirs the folder — never rm -rf", async () => {
  await withSsh(syncRoutes(), async (calls) => {
    const { ctx: c } = ctx();
    await methods.sync.execute(
      syncArgs({ allowDelete: true, deleteStorage: true }),
      c,
    );
    assert(
      calls.some((x) =>
        is("virsh", "undefine", "del", "--nvram", "--snapshots-metadata")(
          x.argv,
        )
      ),
    );
    assert(!calls.some((x) => is("virsh", "undefine", "foreign")(x.argv)));
    assert(!calls.some((x) => x.argv.includes("-rf")));
    const rm = calls.find((x) => is("rm", "-f")(x.argv))!.argv;
    assertEquals(rm.slice(3), [
      "/mnt/user/domains/del/del.qcow2",
      "/mnt/user/domains/del/del-cidata.iso",
    ]);
    assert(
      calls.some((x) => is("rmdir", "--", "/mnt/user/domains/del")(x.argv)),
    );
  });
});

Deno.test("vm.sync: deleteStorage with a storageDir that does not match the domain's disks removes no files", async () => {
  const wrongDir = [
    { name: "del", state: "absent", storageDir: "/var/lib/libvirt/images" },
  ];
  await withSsh(syncRoutes(), async (calls) => {
    const { ctx: c, written } = ctx();
    await assertRejects(
      () =>
        methods.sync.execute(
          syncArgs({
            vms: wrongDir.map((d) => DesiredVmSchema.parse(d)),
            allowDelete: true,
            deleteStorage: true,
          }),
          c,
        ),
      Error,
      "storage left in place",
    );
    assert(!calls.some((x) => x.argv[0] === "rm" || x.argv[0] === "rmdir"));
    assertEquals((written.at(-1)!.payload as { failed: number }).failed, 1);
  });
});

Deno.test("vm.sync: a stop that times out can be forced with forceStopAfterWait", async () => {
  const routes = syncRoutes();
  routes.unshift((a) =>
    is("virsh", "domstate")(a) ? ok("running\n") : undefined
  );
  routes.unshift((a) => is("virsh", "destroy", "on")(a) ? ok() : undefined);
  await withSsh(routes, async (calls) => {
    const { ctx: c } = ctx();
    await methods.sync.execute(
      syncArgs({
        vms: [DesiredVmSchema.parse({ name: "on", state: "stopped" })],
        stopWaitSeconds: 0,
        forceStopAfterWait: true,
      }),
      c,
    );
    assert(calls.some((x) => is("virsh", "destroy", "on")(x.argv)));
  });
});

Deno.test("vm.sync: a failure is recorded per VM, the others still run, and the method throws at the end", async () => {
  const routes = syncRoutes();
  routes.unshift((a) =>
    is("virsh", "shutdown")(a) ? { code: 1, stderr: "error: boom" } : undefined
  );
  await withSsh(routes, async (calls) => {
    const { ctx: c, written } = ctx();
    await assertRejects(
      () => methods.sync.execute(syncArgs({ allowDelete: true }), c),
      Error,
      "1 of 4 failed",
    );
    const plan = written.at(-1)!.payload as {
      failed: number;
      items: { result: string; error: string }[];
    };
    assertEquals(plan.failed, 1);
    assertStringIncludes(plan.items[0].error, "boom");
    assert(calls.some((x) => is("virsh", "undefine", "del")(x.argv)));
  });
});

Deno.test("vm.sync: create without an image fails that VM only", async () => {
  await withSsh(syncRoutes(), async () => {
    const { ctx: c, written } = ctx();
    await assertRejects(
      () =>
        methods.sync.execute(
          syncArgs({ vms: [DesiredVmSchema.parse({ name: "brandnew" })] }),
          c,
        ),
      Error,
      "image is required",
    );
    assertEquals((written.at(-1)!.payload as { failed: number }).failed, 1);
  });
});

Deno.test("waitForAddress: with the guest agent, a stale lease is not taken while the agent is still booting", async () => {
  const STALE = DOMIFADDR.replace("192.168.122.50", "192.168.122.44");
  let agentCalls = 0;
  await withSsh([
    (a) => {
      if (!is("virsh", "domifaddr")(a)) return undefined;
      if (a.at(-1) === "lease") return ok(STALE);
      agentCalls++;
      return agentCalls < 3
        ? { code: 1, stderr: "error: Guest agent is not responding" }
        : ok(DOMIFADDR);
    },
  ], async (calls) => {
    const found = await waitForAddress(CONN, "web1", 5, {
      guestAgent: true,
      pollMs: 1,
    });
    assertEquals(found.source, "agent");
    assertEquals(primaryIpv4(found.addrs)?.address, "192.168.122.50");
    assert(!calls.some((c) => c.argv.at(-1) === "lease"));
  });
});

Deno.test("waitForAddress: agent never answers -> lease fallback at the deadline, logged as possibly stale", async () => {
  const logs: string[] = [];
  await withSsh([
    (a) =>
      is("virsh", "domifaddr")(a)
        ? a.at(-1) === "lease" ? ok(DOMIFADDR) : { code: 1, stderr: "no agent" }
        : undefined,
  ], async () => {
    const found = await waitForAddress(CONN, "web1", 0, {
      guestAgent: true,
      pollMs: 1,
      log: (m) => logs.push(m),
    });
    assertEquals(found.source, "lease");
    assertStringIncludes(logs.join("\n"), "may be stale");
  });
});

Deno.test("waitForAddress: without the guest agent, leases are the source", async () => {
  await withSsh([
    (a) =>
      is("virsh", "domifaddr")(a) && a.at(-1) === "lease"
        ? ok(DOMIFADDR)
        : undefined,
  ], async (calls) => {
    const found = await waitForAddress(CONN, "web1", 5, {
      guestAgent: false,
      pollMs: 1,
    });
    assertEquals(found.source, "lease");
    assert(!calls.some((c) => c.argv.at(-1) === "agent"));
  });
});
