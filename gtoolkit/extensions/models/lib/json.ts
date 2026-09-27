/**
 * Tool results are JSON *inside* a JSON string, and their values carry
 * Smalltalk source and stack traces full of tabs and carriage returns. GT
 * escapes them correctly today (every recorded fixture parses strictly); this
 * is a guard in case a tool or a future GT writes them raw, which strict
 * parsers reject. It escapes control characters ONLY inside string literals,
 * leaving the whitespace between tokens untouched, then parses.
 */
export function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (code < 0x20) {
      out += CONTROL_ESCAPES[code] ??
        `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return out;
}

const CONTROL_ESCAPES: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
};

/** JSON.parse that tolerates raw control characters inside strings. */
export function parseLenientJson(text: string): unknown {
  return JSON.parse(escapeControlCharsInStrings(text));
}
