// VM provisioning from a cloud image for the @bad-at-naming/libvirt vm model:
// vm.provision, vm.connection, vm.plan and vm.sync.
//
// Needs only `qemu-img`, `curl`, `sha256sum`/`sha512sum`, `sh` and `virsh` on
// the hypervisor — no virt-install, genisoimage or storage pool (Unraid has
// none of them). Steps for a new VM:
//   1. Download the cloud image once into `cacheDir`, verified against a pinned
//      checksum or the image directory's SHA256SUMS/SHA512SUMS.
//   2. Copy it into `<storageDir>/<name>/<name>.qcow2` (or a qcow2 overlay on
//      the cached image) and grow it to `diskSizeGb`.
//   3. Build the cloud-init NoCloud seed ISO here, in TypeScript, and write it
//      to `<storageDir>/<name>/<name>-cidata.iso`; it is attached as a
//      read-only virtio disk (minimal cloud kernels have no CD-ROM driver).
//   4. Define the domain from XML built here (marked with swamp metadata so
//      vm.sync only ever deletes domains it created), then start it.
//   5. Wait for the guest agent (or a DHCP lease) to report an address.
//
// The pure parts (ISO, user-data, XML, checksum and domifaddr parsing,
// planning) are exported and unit-tested; the I/O goes through runOnHost /
// virshTry / defineXml from connection.ts.
//
// `makeNoCloudIso` is adapted from @evrardjp/cloud-init-nocloud
// (github.com/evrardjp/swamp-extensions, Apache License 2.0, Copyright
// evrardjp). Changes: a root-directory size guard and comments.
//
// This file is intentionally NOT listed in manifest `models:`; the bundler
// inlines it into the vm model bundle.

import { z } from "npm:zod@4";
import {
  defineXml,
  IDEMPOTENT_ERRORS,
  isIdempotent,
  type LibvirtConn,
  runOnHost,
  virsh,
  type VirshResult,
  virshTry,
} from "./connection.ts";
import { parseKV, parseVmList, parseXmlDisks } from "./parse.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Used as a file name and in XML, so no path separators, spaces or quotes.
export const VM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const FQDN_RE =
  /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9.+_:-]*$/;
// An OpenSSH public key; its comment may not hold control characters.
const SSH_KEY_RE =
  // deno-lint-ignore no-control-regex
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}( [^\u0000-\u001f\u007f]*)?$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4_CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const URL_RE = /^https?:\/\/[^\s'"<>\\]+$/;
const CHECKSUM_RE = /^(sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128})$/;
const BRIDGE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** True for an absolute path made of plain characters, with no `.`/`..` part. */
export function isSafeAbsPath(p: string): boolean {
  if (!/^\/[A-Za-z0-9_./-]*$/.test(p)) return false;
  return !p.split("/").some((seg) => seg === "." || seg === "..");
}

const AbsPath = z.string().refine(isSafeAbsPath, {
  message:
    "must be an absolute path of [A-Za-z0-9_./-] with no '.' or '..' segments",
});

export const ImageSchema = z.object({
  url: z.string().regex(URL_RE).describe(
    "Cloud image URL (qcow2 or raw), e.g. https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
  ),
  checksum: z.string().regex(CHECKSUM_RE).optional().describe(
    "Pin the image: `sha256:<hex>` or `sha512:<hex>`. If omitted, the checksum is read from `checksumsUrl`.",
  ),
  checksumsUrl: z.string().regex(URL_RE).optional().describe(
    "A SHA256SUMS or SHA512SUMS file listing the image. Default: SHA256SUMS in the image URL's directory (Debian publishes only SHA512SUMS — set it).",
  ),
  format: z.enum(["qcow2", "raw"]).default("qcow2").describe(
    "Format of the downloaded image.",
  ),
});

const NetworkSchema = z.object({
  type: z.enum(["network", "bridge"]).default("network").describe(
    "`network`: a libvirt network (e.g. default, NAT). `bridge`: a host Linux bridge (e.g. Unraid br0).",
  ),
  source: z.string().regex(BRIDGE_RE).default("default").describe(
    "libvirt network name or host bridge name",
  ),
  mac: z.string().regex(MAC_RE).optional().describe(
    "Lower-case MAC. Default: 52:54:00 + 3 bytes of SHA-256(name), stable per VM name (useful for DHCP reservations).",
  ),
});

const StaticIpSchema = z.object({
  address: z.string().regex(IPV4_CIDR_RE).describe("e.g. 192.0.2.10/24"),
  gateway: z.string().regex(IPV4_RE).optional(),
  nameservers: z.array(z.string().regex(IPV4_RE)).default([]),
});

export const CloudInitSchema = z.object({
  hostname: z.string().regex(HOSTNAME_RE).optional().describe(
    "Guest hostname. Default: the VM name if it is a valid hostname.",
  ),
  fqdn: z.string().regex(FQDN_RE).optional(),
  user: z.string().regex(USER_RE).optional().describe(
    "Create this user with passwordless sudo and the SSH keys. If omitted, the keys go to the image's default user (ubuntu, debian, arch, …).",
  ),
  sshAuthorizedKeys: z.array(z.string().regex(SSH_KEY_RE)).default([])
    .describe("OpenSSH public keys"),
  passwordHash: z.string().regex(/^\$[0-9a-z]+\$[^\s:]+$/).optional().meta({
    sensitive: true,
  })
    .describe(
      "crypt(3) hash for `user` (e.g. from `mkpasswd -m sha-512`) for console login. SSH password login stays off.",
    ),
  packages: z.array(z.string().regex(PACKAGE_RE)).default([]),
  guestAgent: z.boolean().default(true).describe(
    "Install and start qemu-guest-agent (needed to read the address on a bridge).",
  ),
  staticIp: StaticIpSchema.optional().describe(
    "Static IPv4 for the NIC (netplan v2 network-config). Default: DHCP.",
  ),
  userData: z.string().refine(
    (s) => s.startsWith("#cloud-config") || s.startsWith("#!"),
    { message: "must start with #cloud-config or #!" },
  ).optional().describe(
    "Raw user-data used verbatim instead of the generated one (the fields above except hostname/staticIp are then ignored, including guestAgent).",
  ),
});

const ProvisionFields = {
  name: z.string().regex(VM_NAME_RE).describe("Domain name"),
  storageDir: AbsPath.default("/var/lib/libvirt/images").describe(
    "Directory that gets a `<name>/` folder with the disk and seed ISO. Unraid: /mnt/user/domains",
  ),
  cacheDir: AbsPath.optional().describe(
    "Where downloaded images are kept. Default: <storageDir>/.swamp-image-cache",
  ),
  diskMode: z.enum(["copy", "overlay"]).default("copy").describe(
    "`copy`: a standalone qcow2. `overlay`: a qcow2 backed by the cached image (smaller, but the cache file must stay).",
  ),
  diskSizeGb: z.number().int().min(1).max(65536).default(20),
  memoryMiB: z.number().int().min(128).max(4194304).default(2048),
  vcpus: z.number().int().min(1).max(512).default(2),
  arch: z.enum(["x86_64", "aarch64"]).default("x86_64"),
  machine: z.string().regex(/^[A-Za-z0-9_.-]+$/).default("q35"),
  firmware: z.enum(["bios", "uefi"]).default("bios").describe(
    "`uefi` uses libvirt firmware auto-selection (needs QEMU firmware descriptors on the host).",
  ),
  network: NetworkSchema.default({ type: "network", source: "default" }),
  cloudInit: CloudInitSchema.default({
    sshAuthorizedKeys: [],
    packages: [],
    guestAgent: true,
  }),
  autostart: z.boolean().default(false),
  start: z.boolean().default(true),
  waitForIpSeconds: z.number().int().min(0).max(3600).default(600).describe(
    "Wait this long for an address (guest agent, then DHCP lease). 0 = don't wait.",
  ),
};

export const ProvisionSpecSchema = z.object({
  ...ProvisionFields,
  image: ImageSchema,
});
export type ProvisionSpec = z.infer<typeof ProvisionSpecSchema>;

export const DesiredVmSchema = z.object({
  ...ProvisionFields,
  // Only needed when the VM must be created.
  image: ImageSchema.optional(),
  state: z.enum(["running", "stopped", "absent"]).default("running"),
});
export type DesiredVm = z.infer<typeof DesiredVmSchema>;

export const AddressSchema = z.object({
  interface: z.string(),
  mac: z.string(),
  family: z.string(),
  address: z.string(),
  prefix: z.number(),
});
export type Address = z.infer<typeof AddressSchema>;

export const ConnectionSchema = z.object({
  name: z.string(),
  host: z.string(),
  state: z.string(),
  // First non-loopback, non-link-local IPv4 ("" when none was reported).
  ip: z.string(),
  mac: z.string(),
  addresses: z.array(AddressSchema),
  source: z.enum(["agent", "lease", "arp", "none"]),
  sshUser: z.string(),
  hostname: z.string(),
  timestamp: z.string(),
});

export const PlanItemSchema = z.object({
  name: z.string(),
  desired: z.enum(["running", "stopped", "absent"]),
  observed: z.string(),
  action: z.enum([
    "create",
    "start",
    "resume",
    "stop",
    "delete",
    "none",
    "refuse",
  ]),
  reason: z.string(),
  drift: z.array(z.string()),
  // Filled by vm.sync: what happened when the action ran.
  result: z.enum(["planned", "done", "failed", "skipped"]),
  error: z.string(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PlanSchema = z.object({
  host: z.string(),
  mode: z.enum(["plan", "sync"]),
  items: z.array(PlanItemSchema),
  changes: z.number(),
  failed: z.number(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/** Where a VM's files live. Pure. */
export function vmPaths(spec: {
  name: string;
  storageDir: string;
  cacheDir?: string;
}) {
  const vmDir = `${spec.storageDir.replace(/\/+$/, "")}/${spec.name}`;
  return {
    vmDir,
    disk: `${vmDir}/${spec.name}.qcow2`,
    seed: `${vmDir}/${spec.name}-cidata.iso`,
    cacheDir: spec.cacheDir ??
      `${spec.storageDir.replace(/\/+$/, "")}/.swamp-image-cache`,
  };
}

/** XML-escape text for element content and single- or double-quoted attributes. */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Namespace URI of the metadata element that marks swamp-created domains. */
export const SWAMP_METADATA_NS =
  "https://github.com/umag/swamp-workspace/libvirt";

/** 52:54:00 (the QEMU/KVM prefix) + 3 bytes of SHA-256(name). */
export async function defaultMac(name: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)),
  );
  return [
    "52",
    "54",
    "00",
    ...[d[0], d[1], d[2]].map((b) => b.toString(16).padStart(2, "0")),
  ].join(":");
}

/** The domain XML for a provisioned VM. Pure; every value is escaped. */
export function buildDomainXml(
  spec: Pick<
    ProvisionSpec,
    | "name"
    | "memoryMiB"
    | "vcpus"
    | "arch"
    | "machine"
    | "firmware"
    | "network"
  >,
  files: { disk: string; seed: string; mac: string },
): string {
  const e = xmlEscape;
  const os = spec.firmware === "uefi" ? "<os firmware='efi'>" : "<os>";
  const iface = spec.network.type === "bridge"
    ? `<interface type='bridge'>\n      <source bridge='${
      e(spec.network.source)
    }'/>`
    : `<interface type='network'>\n      <source network='${
      e(spec.network.source)
    }'/>`;
  return `<domain type='kvm'>
  <name>${e(spec.name)}</name>
  <metadata>
    <swamp:vm xmlns:swamp='${SWAMP_METADATA_NS}'>
      <swamp:managed>true</swamp:managed>
    </swamp:vm>
  </metadata>
  <memory unit='MiB'>${spec.memoryMiB}</memory>
  <vcpu>${spec.vcpus}</vcpu>
  ${os}
    <type arch='${e(spec.arch)}' machine='${e(spec.machine)}'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-passthrough'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' discard='unmap'/>
      <source file='${e(files.disk)}'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <!-- cloud-init seed: a read-only virtio disk, not a CD-ROM, because
         virtio-only kernels (e.g. Ubuntu's linux-kvm in the minimal cloud
         images) have no SATA/AHCI CD-ROM driver. -->
    <disk type='file' device='disk'>
      <driver name='qemu' type='raw'/>
      <source file='${e(files.seed)}'/>
      <target dev='vdb' bus='virtio'/>
      <readonly/>
    </disk>
    ${iface}
      <mac address='${e(files.mac)}'/>
      <model type='virtio'/>
    </interface>
    <serial type='pty'>
      <target port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
    <channel type='unix'>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
    </channel>
    <rng model='virtio'>
      <backend model='random'>/dev/urandom</backend>
    </rng>
  </devices>
</domain>
`;
}

/** The guest hostname: the explicit one, else the VM name when it is valid. */
export function guestHostname(spec: Pick<ProvisionSpec, "name" | "cloudInit">) {
  return spec.cloudInit.hostname ??
    (HOSTNAME_RE.test(spec.name) ? spec.name : undefined);
}

/**
 * cloud-init user-data. JSON is valid YAML, so the config is emitted as JSON
 * after the `#cloud-config` header: no YAML quoting to get wrong. Pure.
 */
export function renderUserData(
  spec: Pick<ProvisionSpec, "name" | "cloudInit">,
): string {
  const ci = spec.cloudInit;
  if (ci.userData !== undefined) return ci.userData;
  const cfg: Record<string, unknown> = {};
  const hostname = guestHostname(spec);
  if (hostname) {
    cfg.hostname = hostname;
    cfg.manage_etc_hosts = true;
  }
  if (ci.fqdn) cfg.fqdn = ci.fqdn;
  if (ci.user) {
    cfg.users = [
      "default",
      {
        name: ci.user,
        sudo: "ALL=(ALL) NOPASSWD:ALL",
        lock_passwd: ci.passwordHash === undefined,
        ...(ci.passwordHash ? { passwd: ci.passwordHash } : {}),
        ssh_authorized_keys: ci.sshAuthorizedKeys,
      },
    ];
  } else if (ci.sshAuthorizedKeys.length > 0) {
    cfg.ssh_authorized_keys = ci.sshAuthorizedKeys;
  }
  cfg.ssh_pwauth = false;
  const packages = [
    ...new Set([
      ...(ci.guestAgent ? ["qemu-guest-agent"] : []),
      ...ci.packages,
    ]),
  ];
  if (packages.length > 0) {
    cfg.package_update = true;
    cfg.packages = packages;
  }
  if (ci.guestAgent) {
    cfg.runcmd = [["systemctl", "enable", "--now", "qemu-guest-agent"]];
  }
  return `#cloud-config\n${JSON.stringify(cfg, null, 2)}\n`;
}

/** cloud-init meta-data (JSON, which is valid YAML). Pure. */
export function renderMetaData(
  spec: Pick<ProvisionSpec, "name" | "cloudInit">,
): string {
  const hostname = guestHostname(spec);
  return `${
    JSON.stringify({
      "instance-id": `swamp-${spec.name}`,
      ...(hostname ? { "local-hostname": hostname } : {}),
    })
  }\n`;
}

/**
 * Netplan v2 network-config for `staticIp`, matching the NIC by its MAC, or
 * undefined for DHCP (cloud-init's default). Pure.
 */
export function renderNetworkConfig(
  spec: Pick<ProvisionSpec, "cloudInit">,
  mac: string,
): string | undefined {
  const s = spec.cloudInit.staticIp;
  if (!s) return undefined;
  return `${
    JSON.stringify({
      version: 2,
      ethernets: {
        primary: {
          match: { macaddress: mac },
          "set-name": "eth0",
          dhcp4: false,
          addresses: [s.address],
          ...(s.gateway ? { routes: [{ to: "default", via: s.gateway }] } : {}),
          ...(s.nameservers.length > 0
            ? { nameservers: { addresses: s.nameservers } }
            : {}),
        },
      },
    })
  }\n`;
}

const SECTOR_SIZE = 2048;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build a minimal ISO 9660 image with volume label CIDATA holding `files` in
 * its root directory — a cloud-init NoCloud seed. Adapted from
 * @evrardjp/cloud-init-nocloud (Apache-2.0); see the header. Pure.
 */
export function makeNoCloudIso(files: Array<[string, string]>): Uint8Array {
  if (files.length === 0) {
    throw new Error("At least one file is required to build a NoCloud ISO");
  }

  const seen = new Set<string>();
  const encoded: Array<[Uint8Array, Uint8Array]> = files
    .map(([name, content]): [Uint8Array, Uint8Array] => {
      const normalized = name.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
        throw new Error(`Invalid ISO filename ${JSON.stringify(name)}`);
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`Duplicate ISO filename ${normalized}`);
      }
      seen.add(key);
      return [
        encoder.encode(normalized.toUpperCase()),
        encoder.encode(content),
      ];
    })
    // ISO 9660 orders directory records by byte value, not locale.
    .sort((a, b) => {
      const x = decoder.decode(a[0]);
      const y = decoder.decode(b[0]);
      return x < y ? -1 : x > y ? 1 : 0;
    });

  // Sectors 0-15 system area, 16 PVD, 17 terminator, 18 root dir, 19+ files.
  let lba = 19;
  const extents: number[] = [];
  for (const [, data] of encoded) {
    extents.push(lba);
    lba += Math.ceil(data.length / SECTOR_SIZE) || 1;
  }
  const totalSectors = lba;

  // ISO 9660 "both-byte-order" integers: little-endian then big-endian.
  const u32b = (v: number): Uint8Array =>
    new Uint8Array([
      v & 0xFF,
      (v >> 8) & 0xFF,
      (v >> 16) & 0xFF,
      (v >> 24) & 0xFF,
      (v >> 24) & 0xFF,
      (v >> 16) & 0xFF,
      (v >> 8) & 0xFF,
      v & 0xFF,
    ]);
  const u16b = (v: number): Uint8Array =>
    new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);

  const dirRecord = (
    nameBytes: Uint8Array,
    isDir: boolean,
    extentLba: number,
    dataLen: number,
  ): Uint8Array => {
    const nameLength = nameBytes.length;
    const record = new Uint8Array(
      33 + nameLength + (nameLength % 2 === 0 ? 1 : 0),
    );
    let offset = 0;
    record[offset++] = record.length;
    record[offset++] = 0;
    record.set(u32b(extentLba), offset);
    offset += 8;
    record.set(u32b(dataLen), offset);
    offset += 8;
    record[offset++] = 126; // recording date: years since 1900
    record[offset++] = 6;
    record[offset++] = 25;
    record[offset++] = 0;
    record[offset++] = 0;
    record[offset++] = 0;
    record[offset++] = 0;
    record[offset++] = isDir ? 2 : 0;
    record[offset++] = 0;
    record[offset++] = 0;
    record.set(u16b(1), offset);
    offset += 4;
    record[offset++] = nameLength;
    record.set(nameBytes, offset);
    return record;
  };

  const dotRecord = dirRecord(new Uint8Array([0x00]), true, 18, SECTOR_SIZE);
  const dotdotRecord = dirRecord(new Uint8Array([0x01]), true, 18, SECTOR_SIZE);

  const records = [
    dotRecord,
    dotdotRecord,
    ...encoded.map(([name, data], i) =>
      dirRecord(name, false, extents[i], data.length)
    ),
  ];
  const dirBytes = records.reduce((n, r) => n + r.length, 0);
  if (dirBytes > SECTOR_SIZE) {
    throw new Error("Too many files for a one-sector ISO root directory");
  }
  const rootDir = new Uint8Array(SECTOR_SIZE);
  let dirOffset = 0;
  for (const record of records) {
    rootDir.set(record, dirOffset);
    dirOffset += record.length;
  }

  const primaryVolumeDescriptor = new Uint8Array(SECTOR_SIZE);
  primaryVolumeDescriptor[0] = 1;
  primaryVolumeDescriptor.set(encoder.encode("CD001"), 1);
  primaryVolumeDescriptor[6] = 1;
  primaryVolumeDescriptor.fill(0x20, 8, 40);
  primaryVolumeDescriptor.set(encoder.encode("CIDATA"), 40);
  primaryVolumeDescriptor.fill(0x20, 46, 72);
  primaryVolumeDescriptor.set(u32b(totalSectors), 80);
  primaryVolumeDescriptor.set(u16b(1), 120);
  primaryVolumeDescriptor.set(u16b(1), 124);
  primaryVolumeDescriptor.set(u16b(SECTOR_SIZE), 128);
  primaryVolumeDescriptor.set(u32b(0), 132);
  primaryVolumeDescriptor.set(dotRecord, 156);
  primaryVolumeDescriptor.fill(0x20, 190, 813);
  const emptyIsoDate = encoder.encode("0000000000000000");
  for (const offset of [813, 830, 847, 864]) {
    primaryVolumeDescriptor.set(emptyIsoDate, offset);
    primaryVolumeDescriptor[offset + 16] = 0;
  }
  primaryVolumeDescriptor[881] = 1;

  const volumeDescriptorTerminator = new Uint8Array(SECTOR_SIZE);
  volumeDescriptorTerminator[0] = 255;
  volumeDescriptorTerminator.set(encoder.encode("CD001"), 1);
  volumeDescriptorTerminator[6] = 1;

  const iso = new Uint8Array(totalSectors * SECTOR_SIZE);
  iso.set(primaryVolumeDescriptor, 16 * SECTOR_SIZE);
  iso.set(volumeDescriptorTerminator, 17 * SECTOR_SIZE);
  iso.set(rootDir, 18 * SECTOR_SIZE);
  for (let i = 0; i < encoded.length; i++) {
    iso.set(encoded[i][1], extents[i] * SECTOR_SIZE);
  }
  return iso;
}

/** The seed ISO for a spec. Pure. */
export function buildSeedIso(
  spec: Pick<ProvisionSpec, "name" | "cloudInit">,
  mac: string,
): Uint8Array {
  const files: Array<[string, string]> = [
    ["meta-data", renderMetaData(spec)],
    ["user-data", renderUserData(spec)],
  ];
  const net = renderNetworkConfig(spec, mac);
  if (net) files.push(["network-config", net]);
  return makeNoCloudIso(files);
}

/** The image file name a SHA*SUMS file lists it under: the URL's last segment. */
export function imageFileName(url: string): string {
  const path = url.split(/[?#]/)[0];
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
}

/** Default SHA256SUMS URL: next to the image. */
export function defaultChecksumsUrl(url: string): string {
  const path = url.split(/[?#]/)[0];
  return `${path.slice(0, path.lastIndexOf("/") + 1)}SHA256SUMS`;
}

/**
 * Find `fileName` in a SHA256SUMS / SHA512SUMS listing (`<hex>  name` or
 * `<hex> *name`) and return `sha256:<hex>` / `sha512:<hex>` by hex length,
 * or null. Pure.
 */
export function parseChecksums(text: string, fileName: string): string | null {
  for (const line of text.split("\n")) {
    const m = line.trim().match(
      /^([0-9a-fA-F]{64}|[0-9a-fA-F]{128}) [ *](.+)$/,
    );
    if (!m) continue;
    const name = m[2].trim().replace(/^\.\//, "");
    if (name !== fileName) continue;
    const hex = m[1].toLowerCase();
    return `${hex.length === 64 ? "sha256" : "sha512"}:${hex}`;
  }
  return null;
}

/**
 * Parse `virsh domifaddr` output. Rows with `-` in the name/MAC columns
 * continue the interface above them (virsh prints extra addresses that way).
 * Pure.
 */
export function parseDomIfAddr(stdout: string): Address[] {
  const out: Address[] = [];
  let iface = "";
  let mac = "";
  for (const raw of stdout.split("\n")) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 4 || !/^ipv[46]$/.test(cols[2])) continue;
    if (cols[0] !== "-") iface = cols[0];
    if (cols[1] !== "-") mac = cols[1];
    const [address, prefix] = cols[3].split("/");
    out.push({
      interface: iface,
      mac,
      family: cols[2],
      address,
      prefix: parseInt(prefix ?? "0") || 0,
    });
  }
  return out;
}

/** First usable IPv4: not loopback, not link-local. Pure. */
export function primaryIpv4(addrs: Address[]): Address | undefined {
  return addrs.find((a) =>
    a.family === "ipv4" && !a.address.startsWith("127.") &&
    !a.address.startsWith("169.254.")
  );
}

/** What vm.plan / vm.sync observe about one domain. */
export interface ObservedVm {
  state: string;
  memoryMiB: number;
  vcpus: number;
  managed: boolean;
  /** Disk source paths from the domain XML. */
  disks: string[];
}

/** True if domain XML carries the `<prefix:managed>true</…>` element of swamp's namespace. Pure. */
export function isSwampManaged(xml: string): boolean {
  const ns = xml.match(
    new RegExp(
      `xmlns:([A-Za-z_][A-Za-z0-9_.-]*)=['"]${
        SWAMP_METADATA_NS.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
      }['"]`,
    ),
  );
  if (!ns) return false;
  return new RegExp(`<${ns[1]}:managed>\\s*true\\s*</${ns[1]}:managed>`).test(
    xml,
  );
}

/** The actions that change something (counted in `changes`). */
export const CHANGE_ACTIONS = ["create", "start", "resume", "stop", "delete"];

/**
 * Decide the action for each desired VM. Pure. Drift in memory/vCPUs is
 * reported, never applied (that needs a reboot and is the operator's call).
 * A domain without swamp's metadata marker is never deleted ("refuse").
 * `paused` is resumed for `running` and stopped for `stopped`.
 */
export function planVms(
  desired: Array<Pick<DesiredVm, "name" | "state" | "memoryMiB" | "vcpus">>,
  observed: Map<string, ObservedVm>,
): PlanItem[] {
  return desired.map((d) => {
    const o = observed.get(d.name);
    const item: PlanItem = {
      name: d.name,
      desired: d.state,
      observed: o?.state ?? "absent",
      action: "none",
      reason: "",
      drift: [],
      result: "planned",
      error: "",
    };
    if (!o) {
      if (d.state !== "absent") {
        item.action = "create";
        item.reason = "domain does not exist";
      } else item.reason = "already absent";
      return item;
    }
    if (d.state === "absent") {
      if (o.managed) {
        item.action = "delete";
        item.reason = "desired absent";
      } else {
        item.action = "refuse";
        item.reason =
          "desired absent, but the domain was not created by swamp (no swamp metadata); delete it by hand";
      }
      return item;
    }
    if (o.memoryMiB !== d.memoryMiB) {
      item.drift.push(`memoryMiB ${o.memoryMiB} != desired ${d.memoryMiB}`);
    }
    if (o.vcpus !== d.vcpus) {
      item.drift.push(`vcpus ${o.vcpus} != desired ${d.vcpus}`);
    }
    if (d.state === "running" && o.state === "paused") {
      item.action = "resume";
      item.reason = "state is paused";
    } else if (d.state === "running" && o.state !== "running") {
      item.action = "start";
      item.reason = `state is ${o.state}`;
    } else if (
      d.state === "stopped" && (o.state === "running" || o.state === "paused")
    ) {
      item.action = "stop";
      item.reason = `state is ${o.state}`;
    } else item.reason = "in desired state";
    return item;
  });
}

// ---------------------------------------------------------------------------
// Host I/O
// ---------------------------------------------------------------------------

function tail(res: VirshResult): string {
  return (res.stderr || res.stdout).trim().slice(-500);
}

async function hostOk(
  conn: LibvirtConn,
  argv: string[],
  stdin?: string | Uint8Array,
): Promise<VirshResult> {
  const res = await runOnHost(conn, argv, stdin);
  if (res.code !== 0) {
    throw new Error(`${argv[0]} failed (exit ${res.code}): ${tail(res)}`);
  }
  return res;
}

/** True if `path` exists, or is a symlink (also a dangling one). */
async function exists(conn: LibvirtConn, path: string): Promise<boolean> {
  return (await runOnHost(conn, [
    "sh",
    "-c",
    'test -e "$1" || test -L "$1"',
    "sh",
    path,
  ])).code === 0;
}

/**
 * File steps run where `runOnHost` runs: on `host` over ssh, or on the swamp
 * host in local mode. In local mode with a REMOTE libvirt uri (qemu+ssh://,
 * qemu+tls://, …) virsh would drive another machine while the files land
 * here, so it is refused. Pure.
 */
export function assertFilesOnHypervisor(conn: LibvirtConn): void {
  if (conn.host || !conn.uri) return;
  if (/^[a-z0-9]+:\/\/\//.test(conn.uri)) return; // qemu:///system, …
  throw new Error(
    `vm.provision and deleteStorage need the files on the hypervisor: uri ${conn.uri} is remote, so set \`host\` (SSH mode) instead`,
  );
}

/** `<algo>sum` of a file on the hypervisor, as `<algo>:<hex>`. */
async function fileChecksum(
  conn: LibvirtConn,
  algo: string,
  path: string,
): Promise<string> {
  const res = await hostOk(conn, [`${algo}sum`, path]);
  return `${algo}:${res.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? ""}`;
}

/**
 * Resolve the expected checksum (pinned, or from the SUMS file via curl on the
 * hypervisor). An http image or SUMS URL gives no integrity, so it needs a
 * pinned checksum.
 */
export async function resolveChecksum(
  conn: LibvirtConn,
  image: ProvisionSpec["image"],
): Promise<string> {
  if (image.checksum) return image.checksum;
  const sumsUrl = image.checksumsUrl ?? defaultChecksumsUrl(image.url);
  if (!sumsUrl.startsWith("https://") || !image.url.startsWith("https://")) {
    throw new Error(
      `${
        image.url.startsWith("https://") ? sumsUrl : image.url
      } is plain http: pin image.checksum (an http checksum file proves nothing)`,
    );
  }
  const res = await runOnHost(conn, ["curl", "-fsSL", "--retry", "3", sumsUrl]);
  if (res.code !== 0) {
    throw new Error(
      `could not read checksums from ${sumsUrl} (curl exit ${res.code}): ${
        tail(res)
      } — set image.checksum or image.checksumsUrl`,
    );
  }
  const sum = parseChecksums(res.stdout, imageFileName(image.url));
  if (!sum) {
    throw new Error(
      `${
        imageFileName(image.url)
      } is not listed in ${sumsUrl} — set image.checksum or image.checksumsUrl`,
    );
  }
  return sum;
}

/** What `qemu-img info --output=json` says about an image. Pure. */
export function parseImageInfo(
  json: string,
): { format: string; virtualSize: number; backing: string } {
  const info = JSON.parse(json) as Record<string, unknown>;
  return {
    format: String(info["format"] ?? ""),
    virtualSize: Number(info["virtual-size"] ?? 0),
    backing: String(
      info["backing-filename"] ?? info["full-backing-filename"] ?? "",
    ),
  };
}

/**
 * Check a verified cached image before using it: it must be the declared
 * format and have NO backing file — a qcow2 can name any host file (e.g.
 * /dev/sda) as its backing file, which would then be copied into the guest
 * or read by it. Returns the virtual size in bytes.
 */
async function inspectImage(
  conn: LibvirtConn,
  path: string,
  format: string,
): Promise<number> {
  const res = await hostOk(conn, [
    "qemu-img",
    "info",
    "--output=json",
    "-f",
    format,
    path,
  ]);
  const info = parseImageInfo(res.stdout);
  if (info.format !== format) {
    throw new Error(`image ${path} is ${info.format}, not ${format}`);
  }
  if (info.backing) {
    throw new Error(
      `image ${path} has a backing file (${info.backing}); refusing to use it`,
    );
  }
  return info.virtualSize;
}

/**
 * Make sure the verified image is in the cache and return its path. A cached
 * file is re-verified; a mismatch is removed and downloaded again. Downloads
 * go to a unique `.part` file that is renamed only after it verifies, then
 * made read-only (0444) so a share user cannot swap it under an overlay.
 */
async function ensureCachedImage(
  conn: LibvirtConn,
  image: ProvisionSpec["image"],
  checksum: string,
  cacheDir: string,
  log: (m: string) => void,
): Promise<string> {
  const [algo, hex] = checksum.split(":");
  const cached = `${cacheDir}/${algo}-${hex.slice(0, 64)}.${image.format}`;
  if (await exists(conn, cached)) {
    if (await fileChecksum(conn, algo, cached) === checksum) {
      log(`Image cache hit: ${cached}`);
      return cached;
    }
    log(`Cached image ${cached} failed verification; downloading again`);
    await hostOk(conn, ["rm", "-f", "--", cached]);
  }
  const part = `${cached}.part-${crypto.randomUUID().slice(0, 8)}`;
  log(`Downloading ${image.url}`);
  try {
    await hostOk(conn, [
      "curl",
      "-fsSL",
      "--retry",
      "3",
      "--proto",
      "=https,http",
      "-o",
      part,
      image.url,
    ]);
    const got = await fileChecksum(conn, algo, part);
    if (got !== checksum) {
      throw new Error(
        `downloaded image checksum ${got} does not match ${checksum}`,
      );
    }
    await hostOk(conn, ["chmod", "0444", "--", part]);
    await hostOk(conn, ["mv", "-f", "--", part, cached]);
  } catch (e) {
    await runOnHost(conn, ["rm", "-f", "--", part]);
    throw e;
  }
  return cached;
}

export interface ProvisionResult {
  action: "created" | "exists";
  mac: string;
  disk: string;
  seed: string;
  checksum: string;
  state: string;
}

/**
 * Create the VM if it does not exist (see the file header for the steps).
 * Idempotent: an existing swamp-created domain is never rebuilt — it is only
 * started (or resumed) when `start` is set; a same-named domain swamp did not
 * create is an error. `<storageDir>/<name>/` is claimed with a plain `mkdir`
 * (atomic), so a leftover folder, or a second provision of the same name
 * running at the same time, fails instead of overwriting files. On a failure
 * after the claim, the domain, the files and the folder from this call are
 * removed again.
 */
export async function provisionVm(
  conn: LibvirtConn,
  spec: ProvisionSpec,
  log: (m: string) => void,
): Promise<ProvisionResult> {
  assertFilesOnHypervisor(conn);
  const paths = vmPaths(spec);
  const mac = spec.network.mac ?? await defaultMac(spec.name);
  const st = await virshTry(conn, ["domstate", spec.name]);
  if (st.code === 0) {
    let state = st.stdout.trim();
    const xml = (await virsh(conn, ["dumpxml", spec.name])).stdout;
    if (!isSwampManaged(xml)) {
      throw new Error(
        `domain ${spec.name} exists but was not created by swamp (no swamp metadata); choose another name`,
      );
    }
    log(`VM ${spec.name} exists (state: ${state}); not rebuilding`);
    if (spec.autostart) await virsh(conn, ["autostart", spec.name]);
    if (spec.start && state === "paused") {
      await virsh(conn, ["resume", spec.name]);
      state = "running";
    } else if (spec.start && state !== "running") {
      await virsh(conn, ["start", spec.name]);
      state = "running";
    }
    return {
      action: "exists",
      mac,
      disk: paths.disk,
      seed: paths.seed,
      checksum: spec.image.checksum ?? "",
      state,
    };
  }
  if (!isIdempotent(st, IDEMPOTENT_ERRORS.domainNotFound)) {
    throw new Error(`virsh domstate failed (exit ${st.code}): ${tail(st)}`);
  }

  const checksum = await resolveChecksum(conn, spec.image);
  await hostOk(conn, [
    "mkdir",
    "-p",
    "--",
    spec.storageDir,
  ]);
  await hostOk(conn, ["mkdir", "-p", "-m", "0755", "--", paths.cacheDir]);
  const claim = await runOnHost(conn, [
    "mkdir",
    "-m",
    "0755",
    "--",
    paths.vmDir,
  ]);
  if (claim.code !== 0) {
    throw new Error(
      `${paths.vmDir} already exists but domain ${spec.name} does not (a leftover, or another provision of this name is running); remove the folder or choose another name — it is never overwritten`,
    );
  }

  let defined = false;
  try {
    const cached = await ensureCachedImage(
      conn,
      spec.image,
      checksum,
      paths.cacheDir,
      log,
    );
    const virtualSize = await inspectImage(conn, cached, spec.image.format);
    const wanted = spec.diskSizeGb * 1024 ** 3;
    if (wanted < virtualSize) {
      throw new Error(
        `diskSizeGb ${spec.diskSizeGb} is smaller than the image (${
          Math.ceil(virtualSize / 1024 ** 3)
        } GiB); a smaller disk would cut off the filesystem`,
      );
    }
    const size = `${spec.diskSizeGb}G`;
    if (spec.diskMode === "overlay") {
      await hostOk(conn, [
        "qemu-img",
        "create",
        "-q",
        "-f",
        "qcow2",
        "-F",
        spec.image.format,
        "-b",
        cached,
        paths.disk,
        size,
      ]);
    } else {
      await hostOk(conn, [
        "qemu-img",
        "convert",
        "-f",
        spec.image.format,
        "-O",
        "qcow2",
        cached,
        paths.disk,
      ]);
      await hostOk(conn, ["qemu-img", "resize", "-q", paths.disk, size]);
    }
    await hostOk(conn, ["chmod", "0600", "--", paths.disk]);
    log(`Disk ${paths.disk} (${size}, ${spec.diskMode})`);

    await hostOk(
      conn,
      ["sh", "-c", 'umask 077 && set -C && cat > "$1"', "sh", paths.seed],
      buildSeedIso(spec, mac),
    );
    log(`Seed ISO ${paths.seed}`);

    await defineXml(
      conn,
      "define",
      buildDomainXml(spec, { disk: paths.disk, seed: paths.seed, mac }),
    );
    defined = true;
    if (spec.autostart) await virsh(conn, ["autostart", spec.name]);
    if (spec.start) await virsh(conn, ["start", spec.name]);
    log(`Defined${spec.start ? " and started" : ""} ${spec.name} (${mac})`);
  } catch (e) {
    if (defined) {
      await virshTry(conn, ["destroy", spec.name]);
      const undef = await virshTry(conn, ["undefine", spec.name, "--nvram"]);
      if (undef.code !== 0) await virshTry(conn, ["undefine", spec.name]);
    }
    // The folder was created by this call (the claim), so everything in it is ours.
    await runOnHost(conn, ["rm", "-f", "--", paths.disk, paths.seed]);
    await runOnHost(conn, ["rmdir", "--", paths.vmDir]);
    throw e;
  }
  return {
    action: "created",
    mac,
    disk: paths.disk,
    seed: paths.seed,
    checksum,
    state: spec.start ? "running" : "shut off",
  };
}

/**
 * Remove a deleted VM's files. Only the two files vm.provision creates are
 * removed, and only if the domain's own XML pointed at exactly those paths;
 * then the folder is removed with `rmdir`, which fails (and is reported) if
 * anything else is in it. Never `rm -rf`.
 */
export async function deleteVmStorage(
  conn: LibvirtConn,
  spec: { name: string; storageDir: string },
  domainDisks: string[],
): Promise<void> {
  assertFilesOnHypervisor(conn);
  const paths = vmPaths(spec);
  const expected = [paths.disk, paths.seed];
  const sources = domainDisks.filter((s) => s !== "");
  const unexpected = sources.filter((s) => !expected.includes(s));
  if (sources.length === 0 || unexpected.length > 0) {
    throw new Error(
      `domain ${spec.name} disks (${
        sources.join(", ") || "none"
      }) are not the files vm.provision makes under ${paths.vmDir}; storage left in place — check storageDir`,
    );
  }
  await hostOk(conn, ["rm", "-f", "--", ...expected]);
  await hostOk(conn, ["rmdir", "--", paths.vmDir]);
}

/** Read a domain's addresses: the given sources in order. */
export async function readAddresses(
  conn: LibvirtConn,
  name: string,
  sources: Array<"agent" | "lease" | "arp">,
): Promise<{ source: "agent" | "lease" | "arp" | "none"; addrs: Address[] }> {
  for (const source of sources) {
    const res = await virshTry(conn, ["domifaddr", name, "--source", source]);
    if (res.code !== 0) continue; // agent not up yet, no leases, …
    const addrs = parseDomIfAddr(res.stdout);
    if (primaryIpv4(addrs)) return { source, addrs };
  }
  return { source: "none", addrs: [] };
}

/**
 * Poll for an IPv4 until `seconds` pass. For the first `agentOnlySeconds` the
 * guest agent is the only source: a DHCP lease can be stale (left by an
 * earlier boot with the same MAC) and name an address the new guest never
 * gets — seen live on libvirt's default network. After that, leases are
 * accepted too, with a log line. Without the agent, leases are the source.
 */
export async function waitForAddress(
  conn: LibvirtConn,
  name: string,
  seconds: number,
  opts: {
    guestAgent: boolean;
    agentOnlySeconds?: number;
    pollMs?: number;
    log?: (m: string) => void;
  },
) {
  const pollMs = opts.pollMs ?? 5000;
  const start = Date.now();
  const deadline = start + seconds * 1000;
  const agentUntil = opts.guestAgent
    ? start + (opts.agentOnlySeconds ?? seconds) * 1000
    : start;
  const sources = (): Array<"agent" | "lease"> =>
    Date.now() < agentUntil
      ? ["agent"]
      : opts.guestAgent
      ? ["agent", "lease"]
      : ["lease"];
  let found = await readAddresses(conn, name, sources());
  while (found.source === "none" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    found = await readAddresses(conn, name, sources());
  }
  if (found.source === "none" && opts.guestAgent && Date.now() >= agentUntil) {
    found = await readAddresses(conn, name, ["agent", "lease"]);
  }
  if (found.source === "lease" && opts.guestAgent) {
    opts.log?.(
      `Guest agent of ${name} did not answer; using the DHCP lease, which may be stale`,
    );
  }
  if (found.source === "none" && seconds > 0) {
    opts.log?.(
      `No address for ${name} after ${seconds}s (guest agent not up yet, or no DHCP lease)`,
    );
  }
  return found;
}

/**
 * How waitForAddress should treat a spec: the generated user-data installs
 * the agent, so trust only it; raw `userData` may not, so give the agent 60 s
 * and then accept leases.
 */
export function addressWaitFor(spec: Pick<ProvisionSpec, "cloudInit">) {
  if (spec.cloudInit.userData !== undefined) {
    return { guestAgent: true, agentOnlySeconds: 60 };
  }
  return { guestAgent: spec.cloudInit.guestAgent };
}

/** Observe the domains named in `names` for vm.plan / vm.sync. */
export async function observeVms(
  conn: LibvirtConn,
  names: string[],
): Promise<Map<string, ObservedVm>> {
  const list = parseVmList((await virsh(conn, ["list", "--all"])).stdout);
  const out = new Map<string, ObservedVm>();
  for (const row of list) {
    if (!names.includes(row.name)) continue;
    const [info, xml] = await Promise.all([
      virsh(conn, ["dominfo", row.name]),
      virsh(conn, ["dumpxml", row.name]),
    ]);
    const kv = parseKV(info.stdout);
    out.set(row.name, {
      state: row.state,
      memoryMiB: Math.round(parseInt(kv["Max memory"] || "0") / 1024),
      vcpus: parseInt(kv["CPU(s)"] || "0"),
      managed: isSwampManaged(xml.stdout),
      disks: parseXmlDisks(xml.stdout).map((d) => d.source),
    });
  }
  return out;
}
