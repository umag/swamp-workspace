// Pure parsers shared across the @magistr/libvirt models.
//
// Every function here is deterministic and side-effect free: it turns the text
// output of a `virsh` subcommand into typed data. They are exported so the unit
// tests exercise the real implementation rather than a mirror copy. This file
// is intentionally NOT listed in manifest `models:` — it has no `export const
// model`, so the bundler inlines it into each model bundle and the quality
// analyzer does not count its exports.

/** A parsed `Name: value` line, e.g. the output of `virsh dominfo`. */
export type KeyValues = Record<string, string>;

/**
 * Parse colon-separated `Key: value` output (virsh nodeinfo / dominfo /
 * pool-info / net-info / *stat). The first colon on each line is the
 * separator; lines without a colon are ignored.
 */
export function parseKV(stdout: string): KeyValues {
  const info: KeyValues = {};
  for (const line of stdout.trim().split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    info[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return info;
}

/** A row of `virsh net-list` (before per-network detail enrichment). */
export interface NetListRow {
  name: string;
  state: string;
  autostart: string;
  persistent: string;
}

/** Parse the table emitted by `virsh net-list --all`. */
export function parseNetList(stdout: string): NetListRow[] {
  const networks: NetListRow[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (line.match(/^[-\s]*$/) || line.match(/^\s*Name/)) continue;
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 3) {
      networks.push({
        name: parts[0],
        state: parts[1],
        autostart: parts[2],
        persistent: parts[3] || "",
      });
    }
  }
  return networks;
}

/** A row of `virsh pool-list` (before per-pool detail enrichment). */
export interface PoolListRow {
  name: string;
  state: string;
  autostart: string;
}

/** Parse the table emitted by `virsh pool-list --all --details`. */
export function parsePoolList(stdout: string): PoolListRow[] {
  const pools: PoolListRow[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (line.match(/^[-\s]*$/) || line.match(/^\s*Name/)) continue;
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 2) {
      pools.push({
        name: parts[0],
        state: parts[1],
        autostart: parts[2] || "",
      });
    }
  }
  return pools;
}

/** A row of `virsh vol-list` (name + path before per-volume detail). */
export interface VolListRow {
  name: string;
  path: string;
}

/** Parse the table emitted by `virsh vol-list <pool> --details`. */
export function parseVolList(stdout: string): VolListRow[] {
  const vols: VolListRow[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (line.match(/^[-\s]*$/) || line.match(/^\s*Name/)) continue;
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 2) {
      vols.push({ name: parts[0], path: parts[1] || "" });
    }
  }
  return vols;
}

/** A row of `virsh list --all` (domain name + libvirt state string). */
export interface VmListRow {
  name: string;
  state: string;
}

/** Libvirt domain state strings, longest-suffix-first is not required because
 * the parser matches the whole trailing token. */
const VM_STATES = [
  "running",
  "idle",
  "paused",
  "in shutdown",
  "shut off",
  "crashed",
  "pmsuspended",
];

/**
 * Parse `virsh list --all`. Each data row starts with an id column (`\d+` or
 * `-`); the trailing token is one of the known libvirt state strings and the
 * text between is the (possibly space-containing) domain name.
 */
export function parseVmList(stdout: string): VmListRow[] {
  const vms: VmListRow[] = [];
  for (const line of stdout.trim().split("\n")) {
    const idMatch = line.match(/^\s*(\d+|-)\s+/);
    if (!idMatch) continue;
    const rest = line.slice(idMatch[0].length);
    let name = "";
    let state = "";
    for (const s of VM_STATES) {
      if (rest.trimEnd().endsWith(s)) {
        name = rest.slice(0, rest.trimEnd().length - s.length).trim();
        state = s;
        break;
      }
    }
    if (!name || name === "Name") continue;
    vms.push({ name, state });
  }
  return vms;
}

/**
 * Parse a generic 2+-column whitespace-separated virsh table into row objects
 * keyed by the header cells. Used for `virsh snapshot-list`.
 */
export function parseTableOutput(stdout: string): KeyValues[] {
  const lines = stdout.trim().split("\n").filter((l) =>
    l.trim() && !l.match(/^[-\s]+$/)
  );
  if (lines.length < 2) return [];
  const headers = lines[0].trim().split(/\s{2,}/).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.trim().split(/\s{2,}/);
    const row: KeyValues = {};
    headers.forEach((h, i) => row[h] = vals[i]?.trim() || "");
    return row;
  });
}

/** A disk device extracted from domain XML. */
export interface XmlDisk {
  source: string;
  target: string;
  bus: string;
}

/** Extract `<disk>` source/target/bus tuples from `virsh dumpxml` output. */
export function parseXmlDisks(xml: string): XmlDisk[] {
  const disks: XmlDisk[] = [];
  for (const block of xml.matchAll(/<disk[^>]*>([\s\S]*?)<\/disk>/g)) {
    const src = block[1].match(/<source\s[^>]*(?:file|dev)=['"]([^'"]+)['"]/);
    const tgt = block[1].match(/<target\s[^>]*dev=['"]([^'"]+)['"]/);
    const bus = block[1].match(/<target\s[^>]*bus=['"]([^'"]+)['"]/);
    disks.push({
      source: src?.[1] || "",
      target: tgt?.[1] || "",
      bus: bus?.[1] || "",
    });
  }
  return disks;
}

/** A network interface extracted from domain XML. */
export interface XmlInterface {
  mac: string;
  source: string;
  model: string;
}

/** Extract `<interface>` mac/source/model tuples from domain XML. */
export function parseXmlInterfaces(xml: string): XmlInterface[] {
  const interfaces: XmlInterface[] = [];
  for (
    const block of xml.matchAll(/<interface[^>]*>([\s\S]*?)<\/interface>/g)
  ) {
    const mac = block[1].match(/<mac\s[^>]*address=['"]([^'"]+)['"]/);
    const src = block[1].match(
      /<source\s[^>]*(?:bridge|network)=['"]([^'"]+)['"]/,
    );
    const mdl = block[1].match(/<model\s[^>]*type=['"]([^'"]+)['"]/);
    interfaces.push({
      mac: mac?.[1] || "",
      source: src?.[1] || "",
      model: mdl?.[1] || "",
    });
  }
  return interfaces;
}

/** A graphics device extracted from domain XML. */
export interface XmlGraphics {
  type: string;
  port: string;
  listen: string;
}

/** Extract `<graphics>` type/port/listen tuples from domain XML. */
export function parseXmlGraphics(xml: string): XmlGraphics[] {
  const graphics: XmlGraphics[] = [];
  for (
    const block of xml.matchAll(
      /<graphics\s([^>]*)\/?>(?:[\s\S]*?<\/graphics>)?/g,
    )
  ) {
    const a = block[1];
    graphics.push({
      type: a.match(/type=['"]([^'"]+)['"]/)?.[1] || "",
      port: a.match(/port=['"]([^'"]+)['"]/)?.[1] || "",
      listen: a.match(/listen=['"]([^'"]+)['"]/)?.[1] || "",
    });
  }
  return graphics;
}
