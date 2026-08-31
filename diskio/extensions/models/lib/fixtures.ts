/**
 * Shared test doubles and fixtures for @magistr/diskio.
 *
 * Every fixture is real output shape from the array host (2026-08-30/31), the host that
 * produced the false positive this model exists to prevent: `dm-3` and `sdl`
 * were reported as two saturated disks when dm-3 = md4p1 = disk4 = /dev/sdl,
 * and `lsof /mnt/disk4` named only `shfs` while the actual reader was
 * a torrent daemon seeding a large library.
 */
import type { MethodContext, SshRunner } from "../diskio.ts";

/** Answers with `reply`, and records every command it was given. */
export function scripted(
  reply: string | ((cmd: string) => string),
  code = 0,
): {
  run: SshRunner;
  calls: Array<{ host: string; user: string; command: string }>;
} {
  const calls: Array<{ host: string; user: string; command: string }> = [];
  const run: SshRunner = (host, user, command) => {
    calls.push({ host, user, command });
    return Promise.resolve({
      code,
      stdout: typeof reply === "function" ? reply(command) : reply,
      stderr: code === 0 ? "" : "boom",
    });
  };
  return { run, calls };
}

/** Routes each probe by a marker unique to its script, so one runner can
 * answer the three calls `attribute` makes in order. */
export function routed(
  table: { map?: string; readers?: string; fds?: string },
): { run: SshRunner; calls: string[] } {
  const calls: string[] = [];
  const run: SshRunner = (_host, _user, command) => {
    const script = decodeScript(command);
    let stdout = "";
    if (script.includes("/sys/block")) {
      stdout = table.map ?? "";
      calls.push("map");
    } else if (script.includes("rchar")) {
      stdout = table.readers ?? "";
      calls.push("readers");
    } else {
      stdout = table.fds ?? "";
      calls.push("fds");
    }
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  return { run, calls };
}

/** The runner receives one base64 blob; decode it to assert on the script. */
export function decodeScript(command: string): string {
  const b64 = command.replace(/^echo /, "").replace(
    / \| base64 -d \| bash$/,
    "",
  );
  return atob(b64);
}

export interface Written {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
}

/** In-memory context double: records every writeResource call. */
export function makeCtx(
  globalArgs: Partial<MethodContext["globalArgs"]> = {},
): { ctx: MethodContext; written: Written[]; logged: string[] } {
  const written: Written[] = [];
  const logged: string[] = [];
  const ctx: MethodContext = {
    globalArgs: {
      sshHost: "arrayhost",
      sshUser: "root",
      fuseProxies: "shfs,unraidd,mergerfs,rclone",
      ...globalArgs,
    },
    logger: { info: (m: string) => logged.push(m) },
    writeResource: (spec, name, payload) => {
      written.push({ spec, name, payload: payload as Record<string, unknown> });
      return Promise.resolve({ spec, name });
    },
  };
  return { ctx, written, logged };
}

/** the array host's real stack: encrypted array slots, each dm-N -> mdXp1 -> sdX. */
export const MAP_OUT = [
  "DEV|dm-0|31251759104|md1p1|md1p1,",
  "DEV|dm-3|31251759104|md4p1|md4p1,",
  "DEV|dm-9|1000215216|nvme0n1p1|nvme0n1p1,",
  "DEV|loop2|41943040||",
  "DEV|nvme0n1|1000215216||",
  "DEV|sda|15633408||",
  "DEV|sde|31251759104||",
  "DEV|sdl|31251759104||",
  "MNT|/dev/mapper/md4p1|/mnt/disk4",
  "MNT|/dev/mapper/md1p1|/mnt/disk1",
  "MNT|/dev/mapper/nvme0n1p1|/mnt/cache",
  "SLOT|disk1|sde",
  "SLOT|disk4|sdl",
  "SLOT|cache|nvme0n1",
  "SLOT|flash|sda",
  "DF|/dev/mapper/md4p1|/mnt/disk4|16000900661248|13920783269888",
  "DF|/dev/mapper/md1p1|/mnt/disk1|16000900661248|8000450330624",
].join("\n");

/**
 * Real 60s sample. shfs carries the block I/O; transmission-daemon asked for
 * the bytes and registers none. swamp-serve out-reads both — on WEBSOCKETS,
 * which rchar also counts.
 */
export const READERS_OUT = [
  "P|9231|324000000|0|331000000|0||/usr/local/bin/shfs /mnt/user -disks 1023 -o noatime",
  "P|18267|1788000000|0|16800000|0|eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee|swamp serve --repo-dir=/workspace",
  "P|15272|138600000|0|0|0|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|/usr/bin/transmission-daemon -g /config -f",
  "P|11095|45600000|0|0|0|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|/usr/src/app/build/Shoko.CLI",
  "P|26299|22200000|60000000|0|61000000||clickhouse-server --config-file=/etc/clickhouse-server/config.xml",
  "C|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|transmission",
  "C|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|shoko_server",
  "C|eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee|swamp-serve",
].join("\n");

/**
 * shfs holds the array-side descriptor; transmission holds the same file under
 * its own container mount. Sizes agree, so they are the same file. swamp-serve
 * holds nothing on disk4.
 */
export const FD_OUT = [
  "M|9231||/usr/local/bin/shfs /mnt/user -disks 1023",
  "S|/proc/9231/fd/29|3094898496",
  "S|/proc/9231/fd/70|5198411859",
  "S|/proc/9231/fd/22|4931584",
  "F|9231|29|/mnt/disk4/anime/tv/[GroupA] Example Series S2 (BD 1080p)/ep07.mkv",
  "F|9231|70|/mnt/disk4/downloads/complete/Example.Film.2025.mkv",
  "F|9231|22|/mnt/disk4/media-server/himmich/postgres/base/16384/164025",
  "M|15272|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|/usr/bin/transmission-daemon -g /config -f",
  "S|/proc/15272/fd/41|3094898496",
  "S|/proc/15272/fd/55|5198411859",
  "F|15272|41|/anime/tv/[GroupA] Example Series S2 (BD 1080p)/ep07.mkv",
  "F|15272|55|/downloads/complete/Example.Film.2025.mkv",
  "M|31000||/usr/bin/other",
  "S|/proc/31000/fd/3|999",
  "F|31000|3|/srv/unrelated/ep07.mkv",
  "C|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|transmission",
].join("\n");
