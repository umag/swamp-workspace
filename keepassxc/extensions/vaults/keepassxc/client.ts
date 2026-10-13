/**
 * KeePassXC-Browser session over an abstract frame transport, plus the
 * production transport that speaks to KeePassXC through `keepassxc-proxy`
 * (the same bridge the browser extension uses; it locates the GUI's local
 * socket on every OS, so this module never needs the socket path).
 *
 * @module
 */
import {
  encodeFrame,
  ErrorCode,
  FrameDecoder,
  fromBase64,
  incrementNonce,
  KeePassXCError,
  type KeyPair,
  newKeyPair,
  NONCE_BYTES,
  openJson,
  randomBytes,
  sealJson,
  toBase64,
} from "./protocol.ts";

/** Bidirectional stream of JSON frames. */
export interface Transport {
  /** Sends one frame. */
  send(frame: Record<string, unknown>): Promise<void>;
  /** Resolves with the next frame, or rejects after `timeoutMs`. */
  receive(timeoutMs: number): Promise<Record<string, unknown>>;
  /** Releases the underlying resources. Idempotent. */
  close(): Promise<void>;
}

/** Spawns `keepassxc-proxy` and exchanges length-prefixed frames with it. */
export class ProxyTransport implements Transport {
  #child: Deno.ChildProcess;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new FrameDecoder();
  #queue: Record<string, unknown>[] = [];
  #closed = false;

  constructor(proxyPath: string) {
    try {
      this.#child = new Deno.Command(proxyPath, {
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      }).spawn();
    } catch (err) {
      throw new KeePassXCError(
        ErrorCode.TIMEOUT_OR_NOT_CONNECTED,
        `cannot start keepassxc-proxy at '${proxyPath}': ${
          (err as Error).message
        }`,
      );
    }
    this.#writer = this.#child.stdin.getWriter();
    this.#reader = this.#child.stdout.getReader();
  }

  async send(frame: Record<string, unknown>): Promise<void> {
    await this.#writer.write(encodeFrame(frame));
  }

  async receive(timeoutMs: number): Promise<Record<string, unknown>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new KeePassXCError(
              ErrorCode.TIMEOUT_OR_NOT_CONNECTED,
              `no answer from KeePassXC within ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      );
    });
    try {
      while (this.#queue.length === 0) {
        const { value, done } = await Promise.race([
          this.#reader.read(),
          timeout,
        ]);
        if (done) {
          throw new KeePassXCError(
            ErrorCode.TIMEOUT_OR_NOT_CONNECTED,
            "keepassxc-proxy closed the connection — is KeePassXC running " +
              "with Browser Integration enabled?",
          );
        }
        this.#queue.push(...this.#decoder.push(value));
      }
      return this.#queue.shift()!;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writer.close().catch(() => {});
    await this.#reader.cancel().catch(() => {});
    try {
      this.#child.kill();
    } catch {
      // already exited
    }
    await this.#child.status.catch(() => {});
  }
}

/** Persisted KeePassXC association (one per database). */
export interface Association {
  /** Connection name the user typed in KeePassXC's association dialog. */
  id: string;
  /** Base64 identification public key registered with that database. */
  idKey: string;
}

/** Tuning knobs for a session. */
export interface SessionOptions {
  /** Per-request wait, long enough for a human to answer a GUI dialog. */
  timeoutMs: number;
  /** Ask KeePassXC to show its unlock dialog when the database is locked. */
  triggerUnlock: boolean;
}

/** An encrypted KeePassXC-Browser session. Call `handshake()` first. */
export class BrowserSession {
  readonly #transport: Transport;
  readonly #opts: SessionOptions;
  readonly #keys: KeyPair = newKeyPair();
  readonly #clientID = toBase64(randomBytes(NONCE_BYTES));
  #serverPublicKey: Uint8Array | null = null;

  constructor(transport: Transport, opts: SessionOptions) {
    this.#transport = transport;
    this.#opts = opts;
  }

  /** This session's public key, base64 (sent as `key` on `associate`). */
  get publicKey(): string {
    return toBase64(this.#keys.publicKey);
  }

  /** Exchanges public keys (`change-public-keys`, unencrypted). */
  async handshake(): Promise<void> {
    const nonce = randomBytes(NONCE_BYTES);
    const reply = await this.#roundTrip("change-public-keys", {
      action: "change-public-keys",
      publicKey: this.publicKey,
      nonce: toBase64(nonce),
      clientID: this.#clientID,
    });
    this.#checkError(reply);
    this.#checkNonce(reply, nonce);
    if (typeof reply.publicKey !== "string") {
      throw new KeePassXCError(
        ErrorCode.KEY_CHANGE_FAILED,
        "KeePassXC did not return a public key",
      );
    }
    const pk = fromBase64(reply.publicKey);
    if (pk.length !== 32) {
      throw new KeePassXCError(
        ErrorCode.KEY_CHANGE_FAILED,
        "KeePassXC returned a malformed public key",
      );
    }
    this.#serverPublicKey = pk;
  }

  /** Sends one encrypted action and returns the decrypted reply. */
  async call(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.#serverPublicKey) {
      throw new KeePassXCError(0, "handshake() must run before call()");
    }
    const unlock = this.#opts.triggerUnlock ? { triggerUnlock: "true" } : {};
    const nonce = randomBytes(NONCE_BYTES);
    const reply = await this.#roundTrip(action, {
      action,
      message: sealJson(
        { action, ...payload, ...unlock },
        nonce,
        this.#serverPublicKey,
        this.#keys.secretKey,
      ),
      nonce: toBase64(nonce),
      clientID: this.#clientID,
      ...unlock,
    });
    this.#checkError(reply);
    this.#checkNonce(reply, nonce);
    if (typeof reply.message !== "string") {
      throw new KeePassXCError(0, `KeePassXC '${action}' reply has no message`);
    }
    const inner = openJson(
      reply.message,
      fromBase64(String(reply.nonce)),
      this.#serverPublicKey,
      this.#keys.secretKey,
    );
    this.#checkError(inner);
    return inner;
  }

  /** Sends a frame, skipping unsolicited notifications until `action` replies. */
  async #roundTrip(
    action: string,
    frame: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.#transport.send(frame);
    const deadline = Date.now() + this.#opts.timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new KeePassXCError(
          ErrorCode.TIMEOUT_OR_NOT_CONNECTED,
          `no '${action}' answer from KeePassXC within ${this.#opts.timeoutMs} ms`,
        );
      }
      const reply = await this.#transport.receive(remaining);
      if (reply.action === action) return reply;
    }
  }

  #checkError(reply: Record<string, unknown>): void {
    if (reply.errorCode === undefined && reply.success !== "false") return;
    const code = Number(reply.errorCode ?? 0);
    const text = typeof reply.error === "string" && reply.error
      ? reply.error
      : `KeePassXC reported failure (code ${code})`;
    throw new KeePassXCError(Number.isFinite(code) ? code : 0, text);
  }

  #checkNonce(reply: Record<string, unknown>, sent: Uint8Array): void {
    if (reply.nonce !== toBase64(incrementNonce(sent))) {
      throw new KeePassXCError(
        0,
        "KeePassXC reply nonce is not the incremented request nonce",
      );
    }
  }
}
