import { z } from "npm:zod@4";

// FidoNet JAM/Squish message base reader
// Parses .jhr/.jdx/.jdt/.jlr (JAM) and .sqd/.sqi/.sql (Squish) files

const GlobalArgsSchema = z.object({
  basePath: z.string().describe(
    "Path to directory containing message base files",
  ),
});

const MessageSchema = z.object({
  area: z.string(),
  msgNum: z.number(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  date: z.string(),
  timestamp: z.number(),
  body: z.string(),
  origin: z.string().optional(),
  address: z.string().optional(),
  flags: z.number().optional(),
  format: z.string(),
}).passthrough();

const AreaInfoSchema = z.object({
  name: z.string(),
  format: z.string(),
  activeMessages: z.number(),
  baseMsgNum: z.number().optional(),
});

// --- JAM parser ---

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    ((buf[offset + 3] << 24) >>> 0)
  ) >>> 0;
}

function readUint16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function decodeCP866(buf: Uint8Array, start: number, len: number): string {
  const cp866Upper = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп";
  const cp866Lower = "рстуфхцчшщъыьэюя";
  const cp866Extra: Record<number, string> = {
    0xb0: "░",
    0xb1: "▒",
    0xb2: "▓",
    0xf0: "Ё",
    0xf1: "ё",
    0xf2: "Є",
    0xf3: "є",
    0xf4: "Ї",
    0xf5: "ї",
    0xf6: "Ў",
    0xf7: "ў",
    0xf8: "°",
    0xfc: "№",
  };

  let result = "";
  for (let i = start; i < start + len; i++) {
    const b = buf[i];
    if (b < 0x80) {
      result += String.fromCharCode(b);
    } else if (b >= 0x80 && b <= 0xaf) {
      result += cp866Upper[b - 0x80] || "?";
    } else if (b >= 0xe0 && b <= 0xef) {
      result += cp866Lower[b - 0xe0] || "?";
    } else if (cp866Extra[b]) {
      result += cp866Extra[b];
    } else {
      result += String.fromCharCode(b);
    }
  }
  return result;
}

function decodeText(buf: Uint8Array, start: number, len: number): string {
  // Try UTF-8 first, fall back to CP866
  try {
    const slice = buf.slice(start, start + len);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    // If no high bytes, it's ASCII — fine either way
    if (slice.some((b) => b >= 0x80)) return text;
    return text;
  } catch {
    // Not valid UTF-8, use CP866
  }
  return decodeCP866(buf, start, len);
}

interface JamHeader {
  activeMsgs: number;
  baseMsgNum: number;
}

interface JamMessage {
  msgNum: number;
  from: string;
  to: string;
  subject: string;
  dateWritten: number;
  txtOffset: number;
  txtLen: number;
  attr: number;
  subfieldLen: number;
  address: string;
  origin: string;
}

function parseJamFixedHeader(jhr: Uint8Array): JamHeader | null {
  if (jhr.length < 24) return null;
  const sig = String.fromCharCode(jhr[0], jhr[1], jhr[2]);
  if (sig !== "JAM") return null;
  return {
    activeMsgs: readUint32LE(jhr, 12),
    baseMsgNum: readUint32LE(jhr, 20),
  };
}

function parseJamMessages(jhr: Uint8Array): JamMessage[] {
  const messages: JamMessage[] = [];
  let offset = 1024; // Skip fixed header

  while (offset + 76 <= jhr.length) {
    const sig = String.fromCharCode(
      jhr[offset],
      jhr[offset + 1],
      jhr[offset + 2],
    );
    if (sig !== "JAM") break;

    const subfieldLen = readUint32LE(jhr, offset + 8);
    const dateWritten = readUint32LE(jhr, offset + 36);
    const msgNum = readUint32LE(jhr, offset + 48);
    const attr = readUint32LE(jhr, offset + 52);
    const txtOffset = readUint32LE(jhr, offset + 60);
    const txtLen = readUint32LE(jhr, offset + 64);

    // Parse subfields
    let from = "";
    let to = "";
    let subject = "";
    let address = "";
    const origin = "";

    const sfStart = offset + 76;
    let sfPos = 0;
    while (sfPos + 8 <= subfieldLen) {
      const loID = readUint16LE(jhr, sfStart + sfPos);
      const datLen = readUint32LE(jhr, sfStart + sfPos + 4);
      const bufStart = sfStart + sfPos + 8;

      if (bufStart + datLen > jhr.length) break;

      const text = decodeText(jhr, bufStart, datLen);

      switch (loID) {
        case 0:
          address = text;
          break; // OADDRESS
        case 2:
          from = text;
          break; // SENDERNAME
        case 3:
          to = text;
          break; // RECEIVERNAME
        case 6:
          subject = text;
          break; // SUBJECT
      }

      sfPos += 8 + datLen;
    }

    // Check for deleted
    if ((attr & 0x80000000) === 0) {
      messages.push({
        msgNum,
        from,
        to,
        subject,
        dateWritten,
        txtOffset,
        txtLen,
        attr,
        subfieldLen,
        address,
        origin,
      });
    }

    offset += 76 + subfieldLen;
  }

  return messages;
}

function readJamText(
  jdt: Uint8Array,
  txtOffset: number,
  txtLen: number,
): string {
  if (txtOffset + txtLen > jdt.length) {
    return decodeText(jdt, txtOffset, jdt.length - txtOffset);
  }
  const raw = decodeText(jdt, txtOffset, txtLen);
  // Extract origin line
  return raw.replace(/\r/g, "\n");
}

function extractOrigin(body: string): string {
  const m = body.match(/\* Origin: (.+?)(?:\n|$)/);
  return m ? m[1] : "";
}

function extractAddressFromOrigin(body: string): string {
  const m = body.match(
    /\* Origin:.*\((\d+:\d+\/\d+(?:\.\d+)?)\)\s*(?:\n|$)/,
  );
  return m ? m[1] : "";
}

// --- Squish parser ---

interface SquishMessage {
  msgNum: number;
  from: string;
  to: string;
  subject: string;
  dateWritten: number;
  body: string;
  attr: number;
  address: string;
  origin: string;
}

function parseScombo(val: number): number {
  const date16 = val & 0xffff;
  const time16 = (val >>> 16) & 0xffff;
  const day = date16 & 0x1f;
  const month = (date16 >>> 5) & 0x0f;
  const year = ((date16 >>> 9) & 0x7f) + 1980;
  const sec = (time16 & 0x1f) * 2;
  const min = (time16 >>> 5) & 0x3f;
  const hour = (time16 >>> 11) & 0x1f;
  return Math.floor(
    new Date(year, month - 1, day, hour, min, sec).getTime() / 1000,
  );
}

function parseSquishMessages(sqd: Uint8Array): SquishMessage[] {
  const messages: SquishMessage[] = [];
  if (sqd.length < 256) return messages;

  // Read area header
  const beginFrame = readUint32LE(sqd, 104);

  let frameOfs = beginFrame;
  let msgCounter = 0;

  while (frameOfs > 0 && frameOfs + 28 <= sqd.length) {
    // Read SQHDR
    const id = readUint32LE(sqd, frameOfs);
    if (id !== 0xafae4453) break;

    const nextFrame = readUint32LE(sqd, frameOfs + 4);
    const msgLength = readUint32LE(sqd, frameOfs + 16);
    const clen = readUint32LE(sqd, frameOfs + 20);
    const frameType = readUint16LE(sqd, frameOfs + 24);

    if (frameType === 0 && msgLength >= 238) {
      // Normal frame — read XMSG
      const xmsgOfs = frameOfs + 28;
      const attr = readUint32LE(sqd, xmsgOfs);
      const from = decodeText(sqd, xmsgOfs + 4, 36).replace(/\0.*/, "");
      const to = decodeText(sqd, xmsgOfs + 40, 36).replace(/\0.*/, "");
      const subject = decodeText(sqd, xmsgOfs + 76, 72).replace(/\0.*/, "");

      // Origin address
      const origZone = readUint16LE(sqd, xmsgOfs + 148);
      const origNet = readUint16LE(sqd, xmsgOfs + 150);
      const origNode = readUint16LE(sqd, xmsgOfs + 152);
      const origPoint = readUint16LE(sqd, xmsgOfs + 154);
      const address = origPoint > 0
        ? `${origZone}:${origNet}/${origNode}.${origPoint}`
        : `${origZone}:${origNet}/${origNode}`;

      const dateVal = readUint32LE(sqd, xmsgOfs + 164);
      const dateWritten = parseScombo(dateVal);

      // Body text
      const bodyStart = xmsgOfs + 238 + clen;
      const bodyLen = msgLength - 238 - clen;
      let body = "";
      if (bodyLen > 0 && bodyStart + bodyLen <= sqd.length) {
        body = decodeText(sqd, bodyStart, bodyLen).replace(/\r/g, "\n");
      }

      msgCounter++;
      messages.push({
        msgNum: msgCounter,
        from,
        to,
        subject,
        dateWritten,
        body,
        attr,
        address,
        origin: extractOrigin(body),
      });
    }

    frameOfs = nextFrame;
  }

  return messages;
}

// --- FTS-0001 .msg parser ---

interface FtsMessage {
  msgNum: number;
  from: string;
  to: string;
  subject: string;
  dateStr: string;
  dateWritten: number;
  body: string;
  attr: number;
  origAddress: string;
  destAddress: string;
  origin: string;
  kludges: Record<string, string>;
}

function parseFtsDate(dateStr: string): number {
  // "28 Aug 05  00:07:48" or "01 Jan 07 12:00:00"
  const months: Record<string, number> = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };
  const m = dateStr.match(/(\d+)\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  let year = parseInt(m[3]);
  if (year < 80) year += 2000;
  else if (year < 100) year += 1900;
  const d = new Date(
    year,
    months[m[2]] ?? 0,
    parseInt(m[1]),
    parseInt(m[4]),
    parseInt(m[5]),
    parseInt(m[6]),
  );
  return Math.floor(d.getTime() / 1000);
}

function parseFtsMsg(data: Uint8Array, msgNum: number): FtsMessage | null {
  if (data.length < 190) return null;

  const from = decodeText(data, 0, 36).split("\0")[0];
  const to = decodeText(data, 36, 36).split("\0")[0];
  const subject = decodeText(data, 72, 72).split("\0")[0];
  const dateStr = decodeText(data, 144, 20).split("\0")[0];

  const destNode = readUint16LE(data, 166);
  const origNode = readUint16LE(data, 168);
  const origNet = readUint16LE(data, 172);
  const destNet = readUint16LE(data, 174);
  const attr = readUint16LE(data, 188);

  // Body starts at offset 190, null-terminated
  let bodyEnd = data.indexOf(0, 190);
  if (bodyEnd === -1) bodyEnd = data.length;
  const bodyRaw = decodeText(data, 190, bodyEnd - 190);

  // Parse kludges and build clean body
  const lines = bodyRaw.split("\r");
  const kludges: Record<string, string> = {};
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("\x01")) {
      const k = line.slice(1);
      const spIdx = k.indexOf(" ");
      if (spIdx > 0) {
        kludges[k.slice(0, spIdx).replace(/:$/, "")] = k.slice(spIdx + 1);
      }
    } else {
      bodyLines.push(line);
    }
  }

  // Build addresses from INTL, FMPT, TOPT kludges
  let origAddress = "";
  let destAddress = "";
  if (kludges["INTL"]) {
    const parts = kludges["INTL"].split(" ");
    if (parts.length === 2) {
      destAddress = parts[0];
      origAddress = parts[1];
      const fmpt = kludges["FMPT"];
      const topt = kludges["TOPT"];
      if (fmpt) origAddress += `.${fmpt}`;
      if (topt) destAddress += `.${topt}`;
    }
  }
  if (!origAddress && origNet > 0) {
    origAddress = `0:${origNet}/${origNode}`;
  }
  if (!destAddress && destNet > 0) {
    destAddress = `0:${destNet}/${destNode}`;
  }

  const body = bodyLines.join("\n");
  const dateWritten = parseFtsDate(dateStr);

  return {
    msgNum,
    from,
    to,
    subject,
    dateStr,
    dateWritten,
    body,
    attr,
    origAddress,
    destAddress,
    origin: extractOrigin(body),
    kludges,
  };
}

async function readNetmailDir(
  netmailPath: string,
): Promise<FtsMessage[]> {
  const messages: FtsMessage[] = [];
  try {
    for await (const entry of Deno.readDir(netmailPath)) {
      if (!entry.isFile || !entry.name.endsWith(".msg")) continue;
      const num = parseInt(entry.name);
      if (isNaN(num)) continue;
      try {
        const data = await Deno.readFile(`${netmailPath}/${entry.name}`);
        const msg = parseFtsMsg(data, num);
        if (msg) messages.push(msg);
      } catch {
        // skip unreadable
      }
    }
  } catch {
    // directory doesn't exist
  }
  messages.sort((a, b) => a.dateWritten - b.dateWritten);
  return messages;
}

function ftsToRecord(
  msg: FtsMessage,
): Record<string, unknown> {
  return {
    area: "netmail",
    msgNum: msg.msgNum,
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    date: msg.dateWritten > 0
      ? new Date(msg.dateWritten * 1000).toISOString()
      : msg.dateStr,
    timestamp: msg.dateWritten,
    body: msg.body,
    origin: msg.origin,
    address: msg.origAddress,
    destAddress: msg.destAddress,
    flags: msg.attr,
    format: "fts-0001",
  };
}

// --- Model ---

/** FidoNet JAM/Squish/FTS-0001 message base reader: list areas, read areas and netmail, and search messages by sender, FidoNet address, or text. */
export const model = {
  type: "@magistr/fidonet-msgbase",
  version: "2026.07.16.2",
  globalArguments: GlobalArgsSchema,

  reports: ["@magistr/fidonet-summary", "@magistr/fidonet-messages"],

  resources: {
    areas: {
      description: "List of message areas",
      schema: z.object({
        areas: z.array(AreaInfoSchema),
        totalMessages: z.number(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    messages: {
      description: "Messages from an area or search results",
      schema: z.object({
        area: z.string().optional(),
        query: z.string().optional(),
        messages: z.array(MessageSchema),
        count: z.number(),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
  },

  methods: {
    listAreas: {
      description: "List all message areas with message counts",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const basePath = context.globalArgs.basePath;
        const areas: Array<{
          name: string;
          format: string;
          activeMessages: number;
          baseMsgNum?: number;
        }> = [];

        for await (const entry of Deno.readDir(basePath)) {
          if (!entry.isFile) continue;

          if (entry.name.endsWith(".jhr")) {
            const name = entry.name.slice(0, -4);
            const data = await Deno.readFile(`${basePath}/${entry.name}`);
            const header = parseJamFixedHeader(data);
            if (header) {
              areas.push({
                name,
                format: "jam",
                activeMessages: header.activeMsgs,
                baseMsgNum: header.baseMsgNum,
              });
            }
          } else if (entry.name.endsWith(".sqd")) {
            const name = entry.name.slice(0, -4);
            const data = await Deno.readFile(`${basePath}/${entry.name}`);
            if (data.length >= 12) {
              const numMsg = readUint32LE(data, 4);
              areas.push({ name, format: "squish", activeMessages: numMsg });
            }
          }
        }

        // Count netmail
        try {
          let netmailCount = 0;
          for await (
            const entry of Deno.readDir(`${basePath}/netmail`)
          ) {
            if (entry.isFile && entry.name.endsWith(".msg")) {
              netmailCount++;
            }
          }
          if (netmailCount > 0) {
            areas.push({
              name: "netmail",
              format: "fts-0001",
              activeMessages: netmailCount,
            });
          }
        } catch {
          // no netmail dir
        }

        areas.sort((a, b) => b.activeMessages - a.activeMessages);
        const totalMessages = areas.reduce(
          (s, a) => s + a.activeMessages,
          0,
        );

        const handle = await context.writeResource("areas", "areas_list", {
          areas,
          totalMessages,
        });
        return { dataHandles: [handle] };
      },
    },

    readArea: {
      description: "Read all messages from a specific area",
      arguments: z.object({
        area: z.string().describe("Area name (e.g. fido.general)"),
        limit: z.number().default(100).describe("Max messages to return"),
        offset: z.number().default(0).describe("Skip first N messages"),
      }),
      execute: async (args, context) => {
        const basePath = context.globalArgs.basePath;
        const areaName = args.area;

        // Try JAM first
        const jhrPath = `${basePath}/${areaName}.jhr`;
        const jdtPath = `${basePath}/${areaName}.jdt`;

        let messages: Array<Record<string, unknown>> = [];

        try {
          const jhrData = await Deno.readFile(jhrPath);
          const header = parseJamFixedHeader(jhrData);
          if (!header) throw new Error("Invalid JAM header");

          const jamMsgs = parseJamMessages(jhrData);

          let jdtData: Uint8Array | null = null;
          try {
            jdtData = await Deno.readFile(jdtPath);
          } catch {
            // No text file — messages may have no body
          }

          const sliced = jamMsgs.slice(
            args.offset,
            args.offset + args.limit,
          );
          for (const msg of sliced) {
            let body = "";
            if (jdtData && msg.txtLen > 0) {
              body = readJamText(jdtData, msg.txtOffset, msg.txtLen);
            }
            const origin = extractOrigin(body);
            const date = new Date(msg.dateWritten * 1000).toISOString();

            const address = msg.address ||
              extractAddressFromOrigin(body);

            messages.push({
              area: areaName,
              msgNum: msg.msgNum,
              from: msg.from,
              to: msg.to,
              subject: msg.subject,
              date,
              timestamp: msg.dateWritten,
              body,
              origin,
              address,
              flags: msg.attr,
              format: "jam",
            });
          }
        } catch {
          // Try Squish
          const sqdPath = `${basePath}/${areaName}.sqd`;
          try {
            const sqdData = await Deno.readFile(sqdPath);
            const sqMsgs = parseSquishMessages(sqdData);
            const sliced = sqMsgs.slice(
              args.offset,
              args.offset + args.limit,
            );
            messages = sliced.map((msg) => ({
              area: areaName,
              msgNum: msg.msgNum,
              from: msg.from,
              to: msg.to,
              subject: msg.subject,
              date: new Date(msg.dateWritten * 1000).toISOString(),
              timestamp: msg.dateWritten,
              body: msg.body,
              origin: msg.origin,
              address: msg.address,
              flags: msg.attr,
              format: "squish",
            }));
          } catch (e) {
            throw new Error(
              `Area '${areaName}' not found or unreadable: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }

        const handle = await context.writeResource(
          "messages",
          `area_${areaName}`,
          {
            area: areaName,
            messages,
            count: messages.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    readNetmail: {
      description: "Read netmail messages (FTS-0001 .msg files)",
      arguments: z.object({
        limit: z.number().default(200).describe("Max messages to return"),
        offset: z.number().default(0).describe("Skip first N messages"),
      }),
      execute: async (args, context) => {
        const netmailPath = `${context.globalArgs.basePath}/netmail`;
        const allMsgs = await readNetmailDir(netmailPath);
        const sliced = allMsgs.slice(args.offset, args.offset + args.limit);
        const messages = sliced.map(ftsToRecord);

        const handle = await context.writeResource(
          "messages",
          "netmail",
          {
            area: "netmail",
            messages,
            count: messages.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    searchBySender: {
      description:
        "Search all areas for messages from a specific sender (case-insensitive partial match)",
      arguments: z.object({
        sender: z.string().describe("Sender name to search for"),
        limit: z.number().default(200).describe("Max results"),
      }),
      execute: async (args, context) => {
        const basePath = context.globalArgs.basePath;
        const needle = args.sender.toLowerCase();
        const results: Array<Record<string, unknown>> = [];

        for await (const entry of Deno.readDir(basePath)) {
          if (!entry.isFile) continue;
          if (results.length >= args.limit) break;

          if (entry.name.endsWith(".jhr")) {
            const areaName = entry.name.slice(0, -4);
            try {
              const jhrData = await Deno.readFile(
                `${basePath}/${entry.name}`,
              );
              const jamMsgs = parseJamMessages(jhrData);
              const matches = jamMsgs.filter((m) =>
                m.from.toLowerCase().includes(needle)
              );

              if (matches.length === 0) continue;

              let jdtData: Uint8Array | null = null;
              try {
                jdtData = await Deno.readFile(
                  `${basePath}/${areaName}.jdt`,
                );
              } catch {
                // no text
              }

              for (const msg of matches) {
                if (results.length >= args.limit) break;
                let body = "";
                if (jdtData && msg.txtLen > 0) {
                  body = readJamText(jdtData, msg.txtOffset, msg.txtLen);
                }
                results.push({
                  area: areaName,
                  msgNum: msg.msgNum,
                  from: msg.from,
                  to: msg.to,
                  subject: msg.subject,
                  date: new Date(msg.dateWritten * 1000).toISOString(),
                  timestamp: msg.dateWritten,
                  body,
                  origin: extractOrigin(body),
                  address: msg.address || extractAddressFromOrigin(body),
                  flags: msg.attr,
                  format: "jam",
                });
              }
            } catch {
              // skip unreadable areas
            }
          } else if (entry.name.endsWith(".sqd")) {
            const areaName = entry.name.slice(0, -4);
            try {
              const sqdData = await Deno.readFile(
                `${basePath}/${entry.name}`,
              );
              const sqMsgs = parseSquishMessages(sqdData);
              const matches = sqMsgs.filter((m) =>
                m.from.toLowerCase().includes(needle)
              );

              for (const msg of matches) {
                if (results.length >= args.limit) break;
                results.push({
                  area: areaName,
                  msgNum: msg.msgNum,
                  from: msg.from,
                  to: msg.to,
                  subject: msg.subject,
                  date: new Date(msg.dateWritten * 1000).toISOString(),
                  timestamp: msg.dateWritten,
                  body: msg.body,
                  origin: msg.origin,
                  address: msg.address,
                  flags: msg.attr,
                  format: "squish",
                });
              }
            } catch {
              // skip
            }
          }
        }

        // Scan netmail
        if (results.length < args.limit) {
          const netmailMsgs = await readNetmailDir(
            `${basePath}/netmail`,
          );
          for (const msg of netmailMsgs) {
            if (results.length >= args.limit) break;
            if (msg.from.toLowerCase().includes(needle)) {
              results.push(ftsToRecord(msg));
            }
          }
        }

        results.sort((a, b) =>
          (a.timestamp as number) - (b.timestamp as number)
        );

        const senderKey = args.sender.replace(/[^a-zA-Z0-9]/g, "_");
        const handle = await context.writeResource(
          "messages",
          `sender_${senderKey}`,
          {
            query: `sender:${args.sender}`,
            messages: results,
            count: results.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    searchByAddress: {
      description:
        "Search all areas by FidoNet address — full node (2:5020/1) or point (2:5020/1.28)",
      arguments: z.object({
        address: z.string().describe(
          "FidoNet address to match (e.g. 2:5020/1 or 2:5020/1.28)",
        ),
        limit: z.number().default(200).describe("Max results"),
      }),
      execute: async (args, context) => {
        const basePath = context.globalArgs.basePath;
        const needle = args.address;
        // If searching by node (no point), match node prefix
        const isPointSearch = needle.includes(".");
        const results: Array<Record<string, unknown>> = [];

        for await (const entry of Deno.readDir(basePath)) {
          if (!entry.isFile) continue;
          if (results.length >= args.limit) break;

          if (entry.name.endsWith(".jhr")) {
            const areaName = entry.name.slice(0, -4);
            try {
              const jhrData = await Deno.readFile(
                `${basePath}/${entry.name}`,
              );
              const jamMsgs = parseJamMessages(jhrData);

              // Quick pre-filter on subfield address
              const hasCandidates = jamMsgs.some((m) => m.address) ||
                true; // always scan — address may be in origin line
              if (!hasCandidates) continue;

              let jdtData: Uint8Array | null = null;
              try {
                jdtData = await Deno.readFile(
                  `${basePath}/${areaName}.jdt`,
                );
              } catch {
                // no text
              }

              for (const msg of jamMsgs) {
                if (results.length >= args.limit) break;
                let body = "";
                if (jdtData && msg.txtLen > 0) {
                  body = readJamText(jdtData, msg.txtOffset, msg.txtLen);
                }
                const addr = msg.address ||
                  extractAddressFromOrigin(body);
                if (!addr) continue;

                const matched = isPointSearch
                  ? addr === needle
                  : addr === needle || addr.startsWith(needle + ".");
                if (!matched) continue;

                results.push({
                  area: areaName,
                  msgNum: msg.msgNum,
                  from: msg.from,
                  to: msg.to,
                  subject: msg.subject,
                  date: new Date(msg.dateWritten * 1000).toISOString(),
                  timestamp: msg.dateWritten,
                  body,
                  origin: extractOrigin(body),
                  address: addr,
                  flags: msg.attr,
                  format: "jam",
                });
              }
            } catch {
              // skip
            }
          } else if (entry.name.endsWith(".sqd")) {
            const areaName = entry.name.slice(0, -4);
            try {
              const sqdData = await Deno.readFile(
                `${basePath}/${entry.name}`,
              );
              const sqMsgs = parseSquishMessages(sqdData);
              const matches = sqMsgs.filter((m) => {
                if (!m.address) return false;
                if (isPointSearch) return m.address === needle;
                return m.address === needle ||
                  m.address.startsWith(needle + ".");
              });

              for (const msg of matches) {
                if (results.length >= args.limit) break;
                results.push({
                  area: areaName,
                  msgNum: msg.msgNum,
                  from: msg.from,
                  to: msg.to,
                  subject: msg.subject,
                  date: new Date(msg.dateWritten * 1000).toISOString(),
                  timestamp: msg.dateWritten,
                  body: msg.body,
                  origin: msg.origin,
                  address: msg.address,
                  flags: msg.attr,
                  format: "squish",
                });
              }
            } catch {
              // skip
            }
          }
        }

        // Scan netmail
        if (results.length < args.limit) {
          const netmailMsgs = await readNetmailDir(
            `${basePath}/netmail`,
          );
          for (const msg of netmailMsgs) {
            if (results.length >= args.limit) break;
            const addr = msg.origAddress;
            if (!addr) continue;
            const matched = isPointSearch
              ? addr === needle
              : addr === needle || addr.startsWith(needle + ".");
            if (matched) results.push(ftsToRecord(msg));
          }
        }

        results.sort((a, b) =>
          (a.timestamp as number) - (b.timestamp as number)
        );

        const addrKey = args.address.replace(/[^a-zA-Z0-9]/g, "_");
        const handle = await context.writeResource(
          "messages",
          `address_${addrKey}`,
          {
            query: `address:${args.address}`,
            messages: results,
            count: results.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    formatForObsidian: {
      description:
        "Format stored search/read results as Obsidian markdown notes",
      arguments: z.object({
        source: z.string().describe(
          "Data instance name from a previous search (e.g. sender_John_Doe, netmail, address_2_5020_1_28)",
        ),
        folder: z.string().default("FidoNet").describe(
          "Obsidian folder for notes",
        ),
      }),
      execute: async (args, context) => {
        const stored = await context.readResource(args.source);
        if (!stored) {
          throw new Error(
            `No stored data '${args.source}'. Run a search/read method first.`,
          );
        }
        const messages = (stored.messages as Array<Record<string, unknown>>) ||
          [];
        if (messages.length === 0) {
          throw new Error("No messages in stored data.");
        }

        const notes: Array<Record<string, unknown>> = [];

        for (const m of messages) {
          const from = (m.from as string) || "?";
          const to = (m.to as string) || "?";
          const subject = (m.subject as string) || "(no subject)";
          const date = ((m.date as string) || "").slice(0, 10);
          const area = (m.area as string) || "";
          const address = (m.address as string) || "";
          const destAddress = (m.destAddress as string) || "";
          const body = ((m.body as string) || "").trim();
          const origin = (m.origin as string) || "";
          const msgNum = m.msgNum as number;
          const format = (m.format as string) || "";

          const cleanBody = body
            // deno-lint-ignore no-control-regex
            .replace(/^\x01[^\n]*\n/gm, "")
            .replace(/^---.*$/m, "")
            .replace(/^\* Origin:.*$/m, "")
            .replace(/^ *SEEN-BY:.*$/gm, "")
            .trim();

          const safeSubject = subject
            .replace(/[\/\\:*?"<>|#%\[\]{}]/g, "-")
            .replace(/\.+$/, "")
            .replace(/\s+$/, "")
            .trim()
            .slice(0, 80);

          let md = "---\n";
          md += `title: "${safeSubject.replace(/"/g, '\\"')}"\n`;
          md += `from: "${from}"\n`;
          md += `to: "${to}"\n`;
          md += `area: "${area}"\n`;
          if (date) md += `date: ${date}\n`;
          if (address) md += `address: "${address}"\n`;
          if (destAddress) md += `dest_address: "${destAddress}"\n`;
          md += `format: "${format}"\n`;
          md += "tags:\n  - fidonet\n";
          if (area === "netmail") md += "  - netmail\n";
          else md += `  - ${area.replace(/\./g, "-")}\n`;
          md += "---\n\n";

          md += `**From:** ${from}`;
          if (address) md += ` (${address})`;
          md += ` **To:** ${to}`;
          if (destAddress) md += ` (${destAddress})`;
          md += "\n\n";

          md += `${cleanBody}\n\n`;

          if (origin) md += `> *Origin: ${origin}*\n`;

          const baseFileName = `${args.folder}/${date ? date + " " : ""}${
            safeSubject || "msg-" + msgNum
          }`;

          // Deduplicate: append sequence number if same path already used
          const usedCount = notes.filter((n) =>
            (n.obsidianPath as string) === baseFileName ||
            (n.obsidianPath as string).startsWith(baseFileName + " (")
          ).length;
          const fileName = usedCount > 0
            ? `${baseFileName} (${usedCount + 1})`
            : baseFileName;

          notes.push({
            ...m,
            obsidianPath: fileName,
            obsidianContent: md,
          });
        }

        const handle = await context.writeResource(
          "messages",
          `obsidian_${args.source}`,
          {
            query: `obsidian:${args.source}`,
            messages: notes,
            count: notes.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    searchByText: {
      description:
        "Search all areas for messages containing text (case-insensitive)",
      arguments: z.object({
        text: z.string().describe("Text to search for in message bodies"),
        limit: z.number().default(100).describe("Max results"),
      }),
      execute: async (args, context) => {
        const basePath = context.globalArgs.basePath;
        const needle = args.text.toLowerCase();
        const results: Array<Record<string, unknown>> = [];

        for await (const entry of Deno.readDir(basePath)) {
          if (!entry.isFile) continue;
          if (results.length >= args.limit) break;

          if (entry.name.endsWith(".jhr")) {
            const areaName = entry.name.slice(0, -4);
            try {
              const jhrData = await Deno.readFile(
                `${basePath}/${entry.name}`,
              );
              const jamMsgs = parseJamMessages(jhrData);

              let jdtData: Uint8Array | null = null;
              try {
                jdtData = await Deno.readFile(
                  `${basePath}/${areaName}.jdt`,
                );
              } catch {
                continue;
              }

              for (const msg of jamMsgs) {
                if (results.length >= args.limit) break;
                let body = "";
                if (jdtData && msg.txtLen > 0) {
                  body = readJamText(jdtData, msg.txtOffset, msg.txtLen);
                }
                const searchable = `${msg.subject} ${body} ${msg.from}`
                  .toLowerCase();
                if (searchable.includes(needle)) {
                  results.push({
                    area: areaName,
                    msgNum: msg.msgNum,
                    from: msg.from,
                    to: msg.to,
                    subject: msg.subject,
                    date: new Date(msg.dateWritten * 1000).toISOString(),
                    timestamp: msg.dateWritten,
                    body,
                    origin: extractOrigin(body),
                    address: msg.address,
                    flags: msg.attr,
                    format: "jam",
                  });
                }
              }
            } catch {
              // skip
            }
          }
        }

        // Scan netmail
        if (results.length < args.limit) {
          const netmailMsgs = await readNetmailDir(
            `${basePath}/netmail`,
          );
          for (const msg of netmailMsgs) {
            if (results.length >= args.limit) break;
            const searchable = `${msg.subject} ${msg.body} ${msg.from}`
              .toLowerCase();
            if (searchable.includes(needle)) {
              results.push(ftsToRecord(msg));
            }
          }
        }

        results.sort((a, b) =>
          (a.timestamp as number) - (b.timestamp as number)
        );

        const textKey = args.text.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "_");
        const handle = await context.writeResource(
          "messages",
          `search_${textKey}`,
          {
            query: `text:${args.text}`,
            messages: results,
            count: results.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
