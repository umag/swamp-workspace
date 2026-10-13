/**
 * Pure building blocks of the KeePassXC-Browser protocol: native-messaging
 * framing, NaCl box encryption, nonce arithmetic, error codes, and the
 * swamp-key <-> entry-URL mapping. No I/O lives here.
 *
 * Wire format (verified against KeePassXC 2.7.11 through `keepassxc-proxy`):
 * every message is a 4-byte little-endian length followed by UTF-8 JSON.
 * Encrypted requests carry `{action, message, nonce, clientID}` where
 * `message` is `nacl.box(json, nonce, serverPublicKey, clientSecretKey)`.
 * The server answers with the request nonce incremented by one
 * (little-endian, libsodium `sodium_increment` semantics).
 *
 * @module
 */
import nacl from "npm:tweetnacl@1.0.3";

/** Size in bytes of an XSalsa20-Poly1305 nonce and of a KeePassXC clientID. */
export const NONCE_BYTES = 24;

/** Largest frame accepted from the proxy (KeePassXC caps messages at 1 MiB). */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Scheme of every entry URL written by this vault. */
export const URL_SCHEME = "swamp";

/** KeePassXC-Browser error codes (src/browser/BrowserShared.h). */
export const ErrorCode = {
  DATABASE_NOT_OPENED: 1,
  DATABASE_HASH_NOT_RECEIVED: 2,
  CLIENT_PUBLIC_KEY_NOT_RECEIVED: 3,
  CANNOT_DECRYPT_MESSAGE: 4,
  TIMEOUT_OR_NOT_CONNECTED: 5,
  ACTION_CANCELLED_OR_DENIED: 6,
  PUBLIC_KEY_NOT_FOUND: 7,
  ASSOCIATION_FAILED: 8,
  KEY_CHANGE_FAILED: 9,
  ENCRYPTION_KEY_UNRECOGNIZED: 10,
  NO_SAVED_DATABASES_FOUND: 11,
  INCORRECT_ACTION: 12,
  EMPTY_MESSAGE_RECEIVED: 13,
  NO_URL_PROVIDED: 14,
  NO_LOGINS_FOUND: 15,
  NO_GROUPS_FOUND: 16,
  CANNOT_CREATE_NEW_GROUP: 17,
  NO_VALID_UUID_PROVIDED: 18,
  ACCESS_TO_ALL_ENTRIES_DENIED: 19,
} as const;

/** Error raised for any protocol-level failure reported by KeePassXC. */
export class KeePassXCError extends Error {
  /** Numeric KeePassXC error code, or 0 for client-side protocol violations. */
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "KeePassXCError";
    this.code = code;
  }
}

/** Encodes bytes as standard base64. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decodes standard base64; throws KeePassXCError on malformed input. */
export function fromBase64(text: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(text);
  } catch {
    throw new KeePassXCError(0, "malformed base64 in KeePassXC response");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Returns a copy of `nonce` incremented by one, little-endian with carry. */
export function incrementNonce(nonce: Uint8Array): Uint8Array {
  const out = nonce.slice();
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] + 1) & 0xff;
    if (out[i] !== 0) break;
  }
  return out;
}

/** Fresh random bytes from tweetnacl's CSPRNG. */
export function randomBytes(n: number): Uint8Array {
  return nacl.randomBytes(n);
}

/** A Curve25519 key pair. */
export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Generates a Curve25519 key pair for `nacl.box`. */
export function newKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

/** Encrypts a JSON value with `nacl.box`; returns base64 ciphertext. */
export function sealJson(
  value: unknown,
  nonce: Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): string {
  const plain = new TextEncoder().encode(JSON.stringify(value));
  return toBase64(nacl.box(plain, nonce, theirPublicKey, mySecretKey));
}

/** Decrypts base64 `nacl.box` ciphertext to a JSON object. */
export function openJson(
  message: string,
  nonce: Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): Record<string, unknown> {
  const plain = nacl.box.open(
    fromBase64(message),
    nonce,
    theirPublicKey,
    mySecretKey,
  );
  if (!plain) {
    throw new KeePassXCError(
      ErrorCode.CANNOT_DECRYPT_MESSAGE,
      "cannot decrypt KeePassXC response (MAC check failed)",
    );
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KeePassXCError(
      0,
      "decrypted KeePassXC response is not an object",
    );
  }
  return parsed as Record<string, unknown>;
}

/** Frames a JSON value as a native-messaging message (u32 LE length + UTF-8). */
export function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

/**
 * Incremental native-messaging frame decoder. Feed it arbitrary chunks;
 * it yields each complete JSON frame exactly once.
 */
export class FrameDecoder {
  #buf = new Uint8Array(0);

  /** Appends a chunk and returns every frame completed by it. */
  push(chunk: Uint8Array): Record<string, unknown>[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf);
    merged.set(chunk, this.#buf.length);
    this.#buf = merged;
    const frames: Record<string, unknown>[] = [];
    while (this.#buf.length >= 4) {
      const len = new DataView(
        this.#buf.buffer,
        this.#buf.byteOffset,
        this.#buf.byteLength,
      ).getUint32(0, true);
      if (len > MAX_FRAME_BYTES) {
        throw new KeePassXCError(0, `KeePassXC frame too large: ${len} bytes`);
      }
      if (this.#buf.length < 4 + len) break;
      const body = this.#buf.slice(4, 4 + len);
      this.#buf = this.#buf.slice(4 + len);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new KeePassXCError(0, "KeePassXC sent a non-JSON frame");
      }
      if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      ) {
        throw new KeePassXCError(0, "KeePassXC sent a non-object frame");
      }
      frames.push(parsed as Record<string, unknown>);
    }
    return frames;
  }

  /** Bytes buffered but not yet forming a complete frame. */
  get pendingBytes(): number {
    return this.#buf.length;
  }
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** True when `ns` is usable as the host part of a `swamp://` URL. */
export function isValidNamespace(ns: string): boolean {
  return HOST_RE.test(ns);
}

/**
 * Derives a URL-host namespace from a swamp vault name: lowercased,
 * non-alphanumerics collapsed to `-`, trimmed, capped at 63 chars.
 * Returns "" when nothing usable remains.
 */
export function namespaceFromVaultName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/** Longest secret key accepted. */
export const MAX_KEY_LENGTH = 512;

/** Throws unless `key` is a non-empty, printable secret key. */
export function assertValidKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("secret key must be a non-empty string");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`secret key longer than ${MAX_KEY_LENGTH} characters`);
  }
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("secret key must not contain control characters");
  }
}

/** URL matching every entry of a namespace (`swamp://<ns>`). */
export function namespaceUrl(ns: string): string {
  return `${URL_SCHEME}://${ns}`;
}

/** Entry URL for one secret key (`swamp://<ns>/<percent-encoded key>`). */
export function entryUrl(ns: string, key: string): string {
  return `${URL_SCHEME}://${ns}/${encodeURIComponent(key)}`;
}
