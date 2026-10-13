/**
 * In-memory KeePassXC-Browser server for tests. It speaks the real protocol
 * (NaCl box with its own key pair, nonce increment, unencrypted error
 * replies) and models the behaviours observed live against KeePassXC 2.7.11:
 * host-level URL matching, NO_LOGINS_FOUND on an empty match, entry titles
 * taken from the URL host, and group creation returning the existing group.
 *
 * @module
 */
import nacl from "npm:tweetnacl@1.0.3";
import type { Transport } from "./client.ts";
import type { AssociationStore, Dependencies } from "./mod.ts";
import type { Association } from "./client.ts";
import {
  ErrorCode,
  fromBase64,
  incrementNonce,
  KeePassXCError,
  openJson,
  sealJson,
  toBase64,
} from "./protocol.ts";

/** One stored entry. */
export interface FakeEntry {
  uuid: string;
  title: string;
  url: string;
  login: string;
  password: string;
  groupUuid: string;
}

/** Knobs to make the fake misbehave. */
export interface FakeOptions {
  /** Name typed into the association dialog; null = user cancels. */
  associationName?: string | null;
  /** Number of encrypted calls answered with DATABASE_NOT_OPENED. */
  lockedCalls?: number;
  /** Corrupt the reply nonce on this action. */
  badNonceOn?: string;
  /** Flip a ciphertext byte on this action. */
  badMacOn?: string;
  /** Unsolicited notification frames sent before each reply. */
  notifications?: number;
  /** Omit `uuid` from get-logins entries. */
  omitUuid?: boolean;
  /** Return no uuid from create-new-group. */
  groupWithoutUuid?: boolean;
  /** Return no publicKey from change-public-keys. */
  noPublicKey?: boolean;
}

/** Shared state of one fake KeePassXC instance. */
export class FakeKeePassXC {
  readonly keys = nacl.box.keyPair();
  readonly entries: FakeEntry[] = [];
  readonly groups = new Map<string, string>([["Root", "root-uuid"]]);
  readonly associations = new Map<string, string>();
  readonly actions: string[] = [];
  readonly transports: FakeTransport[] = [];
  opts: FakeOptions;
  #seq = 0;

  constructor(opts: FakeOptions = {}) {
    this.opts = { associationName: "swamp", ...opts };
  }

  /** Opens a new client connection. */
  connect(): FakeTransport {
    const t = new FakeTransport(this);
    this.transports.push(t);
    return t;
  }

  /** Adds an entry directly, bypassing the protocol. */
  seed(url: string, login: string, password: string): FakeEntry {
    const e: FakeEntry = {
      uuid: this.nextUuid(),
      title: hostOf(url) ?? url,
      url,
      login,
      password,
      groupUuid: "root-uuid",
    };
    this.entries.push(e);
    return e;
  }

  nextUuid(): string {
    this.#seq += 1;
    return this.#seq.toString(16).padStart(32, "0");
  }
}

function hostOf(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url);
  return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}` : null;
}

/** One client connection to a FakeKeePassXC. */
export class FakeTransport implements Transport {
  readonly server: FakeKeePassXC;
  readonly sent: Record<string, unknown>[] = [];
  #queue: Record<string, unknown>[] = [];
  #clientPk: Uint8Array | null = null;
  closed = false;

  constructor(server: FakeKeePassXC) {
    this.server = server;
  }

  send(frame: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("send on closed transport");
    this.sent.push(frame);
    for (let i = 0; i < (this.server.opts.notifications ?? 0); i++) {
      this.#queue.push({ action: "database-unlocked" });
    }
    this.#queue.push(this.#handle(frame));
    return Promise.resolve();
  }

  receive(_timeoutMs: number): Promise<Record<string, unknown>> {
    const next = this.#queue.shift();
    if (!next) {
      return Promise.reject(
        new KeePassXCError(
          ErrorCode.TIMEOUT_OR_NOT_CONNECTED,
          "fake: no reply",
        ),
      );
    }
    return Promise.resolve(next);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  #error(action: string, code: number, error: string) {
    return { action, error, errorCode: String(code) };
  }

  #handle(frame: Record<string, unknown>): Record<string, unknown> {
    const s = this.server;
    const action = String(frame.action);
    s.actions.push(action);
    const nonce = fromBase64(String(frame.nonce));
    let replyNonce = toBase64(incrementNonce(nonce));
    if (s.opts.badNonceOn === action) replyNonce = toBase64(nonce);

    if (action === "change-public-keys") {
      this.#clientPk = fromBase64(String(frame.publicKey));
      return {
        action,
        version: "2.7.11",
        ...(s.opts.noPublicKey
          ? {}
          : { publicKey: toBase64(s.keys.publicKey) }),
        nonce: replyNonce,
        success: "true",
      };
    }
    if (!this.#clientPk) {
      return this.#error(
        action,
        ErrorCode.CLIENT_PUBLIC_KEY_NOT_RECEIVED,
        "no key",
      );
    }
    let msg: Record<string, unknown>;
    try {
      msg = openJson(
        String(frame.message),
        nonce,
        this.#clientPk,
        s.keys.secretKey,
      );
    } catch {
      return this.#error(
        action,
        ErrorCode.CANNOT_DECRYPT_MESSAGE,
        "cannot decrypt",
      );
    }
    if ((s.opts.lockedCalls ?? 0) > 0) {
      s.opts.lockedCalls = (s.opts.lockedCalls ?? 0) - 1;
      return this.#error(
        action,
        ErrorCode.DATABASE_NOT_OPENED,
        "Database not opened",
      );
    }
    const result = this.#dispatch(action, msg);
    if ("errorCode" in result) return result;
    const inner = {
      ...result,
      nonce: replyNonce,
      success: "true",
      version: "2.7.11",
    };
    let message = sealJson(
      inner,
      incrementNonce(nonce),
      this.#clientPk,
      s.keys.secretKey,
    );
    if (s.opts.badMacOn === action) {
      const bytes = fromBase64(message);
      bytes[bytes.length - 1] ^= 0xff;
      message = toBase64(bytes);
    }
    return { action, message, nonce: replyNonce };
  }

  #authorised(msg: Record<string, unknown>): boolean {
    const keys = Array.isArray(msg.keys) ? msg.keys : [];
    return keys.some((k) => {
      const r = k as Record<string, unknown>;
      return this.server.associations.get(String(r.id)) === String(r.key);
    });
  }

  #dispatch(
    action: string,
    msg: Record<string, unknown>,
  ): Record<string, unknown> {
    const s = this.server;
    switch (action) {
      case "associate": {
        if (s.opts.associationName === null) {
          return this.#error(
            action,
            ErrorCode.ACTION_CANCELLED_OR_DENIED,
            "cancelled",
          );
        }
        const id = s.opts.associationName ?? "swamp";
        s.associations.set(id, String(msg.idKey));
        return { id, hash: "fakehash" };
      }
      case "test-associate": {
        if (s.associations.get(String(msg.id)) !== String(msg.key)) {
          return this.#error(
            action,
            ErrorCode.ASSOCIATION_FAILED,
            "Association failed",
          );
        }
        return { id: msg.id, hash: "fakehash" };
      }
      case "get-logins": {
        if (!this.#authorised(msg)) {
          return this.#error(
            action,
            ErrorCode.ASSOCIATION_FAILED,
            "Association failed",
          );
        }
        if (!msg.url) {
          return this.#error(action, ErrorCode.NO_URL_PROVIDED, "No URL");
        }
        const host = hostOf(String(msg.url));
        const hits = s.entries.filter((e) => hostOf(e.url) === host);
        if (hits.length === 0) {
          return this.#error(
            action,
            ErrorCode.NO_LOGINS_FOUND,
            "No logins found",
          );
        }
        return {
          count: String(hits.length),
          entries: hits.map((e) => ({
            login: e.login,
            name: e.title,
            password: e.password,
            ...(s.opts.omitUuid ? {} : { uuid: e.uuid }),
          })),
        };
      }
      case "create-new-group": {
        const name = String(msg.groupName);
        if (!s.groups.has(name)) s.groups.set(name, s.nextUuid());
        return s.opts.groupWithoutUuid
          ? { name }
          : { name, uuid: s.groups.get(name) };
      }
      case "set-login": {
        if (!msg.url) {
          return this.#error(action, ErrorCode.NO_URL_PROVIDED, "No URL");
        }
        const uuid = String(msg.uuid ?? "");
        if (uuid) {
          const e = s.entries.find((x) => x.uuid === uuid);
          if (!e) {
            return this.#error(
              action,
              ErrorCode.NO_VALID_UUID_PROVIDED,
              "No valid UUID",
            );
          }
          e.login = String(msg.login);
          e.password = String(msg.password);
          e.url = String(msg.url);
        } else {
          s.entries.push({
            uuid: s.nextUuid(),
            title: hostOf(String(msg.url))?.replace(/^.*:\/\//, "") ?? "",
            url: String(msg.url),
            login: String(msg.login),
            password: String(msg.password),
            groupUuid: String(msg.groupUuid || "root-uuid"),
          });
        }
        return { count: null, entries: null, error: "" };
      }
      default:
        return this.#error(
          action,
          ErrorCode.INCORRECT_ACTION,
          "Incorrect action",
        );
    }
  }
}

/** Association store kept in memory. */
export class MemoryAssociationStore implements AssociationStore {
  readonly location = "memory://association";
  value: Association | null = null;
  saves = 0;

  load(): Promise<Association | null> {
    return Promise.resolve(this.value);
  }

  save(association: Association): Promise<void> {
    this.value = association;
    this.saves += 1;
    return Promise.resolve();
  }
}

/** Dependencies wired to a fake server and a virtual clock. */
export function fakeDeps(
  server: FakeKeePassXC,
  store: MemoryAssociationStore = new MemoryAssociationStore(),
): Dependencies & { store: MemoryAssociationStore; clock: { t: number } } {
  const clock = { t: 0 };
  return {
    store,
    clock,
    openTransport: () => server.connect(),
    associationStore: () => store,
    sleep: (ms) => {
      clock.t += ms;
      return Promise.resolve();
    },
    now: () => clock.t,
    env: (name) => (name === "HOME" ? "/home/test" : undefined),
    exists: () => false,
    os: "linux",
  };
}
