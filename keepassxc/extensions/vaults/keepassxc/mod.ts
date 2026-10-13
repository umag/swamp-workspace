/**
 * `@magistr/keepassxc` — a swamp vault backed by a running, unlocked
 * KeePassXC through its Browser Integration protocol.
 *
 * Each secret is one KeePassXC entry:
 *
 * - URL      `swamp://<namespace>/<percent-encoded key>`
 * - Username the swamp secret key
 * - Password the secret value
 * - Group    `config.group` (default `swamp`), created on first write
 *
 * `list()` asks KeePassXC for every login matching `swamp://<namespace>`.
 * No master password is stored anywhere: the first call pops KeePassXC's
 * "new connection" dialog and the resulting association key is kept in a
 * 0600 file (`associationFile`).
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type Association,
  BrowserSession,
  ProxyTransport,
  type Transport,
} from "./client.ts";
import {
  assertValidKey,
  entryUrl,
  ErrorCode,
  isValidNamespace,
  KeePassXCError,
  namespaceFromVaultName,
  namespaceUrl,
  newKeyPair,
  toBase64,
} from "./protocol.ts";

/** Config accepted in `.swamp.yaml` / `swamp vault create --config`. */
export const ConfigSchema = z.object({
  namespace: z.string().refine(isValidNamespace, {
    message: "namespace must be a lowercase hostname label (a-z, 0-9, '-')",
  }).optional().describe(
    "Host part of entry URLs (swamp://<namespace>/<key>). Defaults to the vault name, sanitised.",
  ),
  group: z.string().min(1).max(256).default("swamp").describe(
    "KeePassXC group path for new entries, e.g. 'swamp' or 'Infra/swamp'.",
  ),
  proxyPath: z.string().min(1).optional().describe(
    "Path to keepassxc-proxy. Defaults to the macOS app bundle, else PATH.",
  ),
  associationFile: z.string().min(1).optional().describe(
    "Where the association key is stored (mode 0600). Defaults to ~/.config/swamp/keepassxc/<vault>.json.",
  ),
  timeoutSeconds: z.number().int().min(1).max(3600).default(120).describe(
    "Per-request wait; covers time spent answering KeePassXC dialogs.",
  ),
  triggerUnlock: z.boolean().default(true).describe(
    "Ask KeePassXC to show its unlock dialog when the database is locked.",
  ),
  unlockWaitSeconds: z.number().int().min(0).max(600).default(60).describe(
    "How long to keep retrying while the database is locked.",
  ),
});

/** Parsed vault configuration. */
export type KeePassXCConfig = z.infer<typeof ConfigSchema>;

/** Persists the association between this vault and a KeePassXC database. */
export interface AssociationStore {
  /** Human-readable location, used in error messages. */
  readonly location: string;
  /** Returns the saved association, or null when none exists yet. */
  load(): Promise<Association | null>;
  /** Saves the association so later calls skip the GUI dialog. */
  save(association: Association): Promise<void>;
}

/** Association store backed by a JSON file with 0600 permissions. */
export class FileAssociationStore implements AssociationStore {
  readonly location: string;

  constructor(path: string) {
    this.location = path;
  }

  async load(): Promise<Association | null> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.location);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`association file ${this.location} is not valid JSON`);
    }
    const p = parsed as Partial<Association> | null;
    if (
      !p || typeof p.id !== "string" || !p.id ||
      typeof p.idKey !== "string" || !p.idKey
    ) {
      throw new Error(
        `association file ${this.location} is missing 'id' or 'idKey'`,
      );
    }
    return { id: p.id, idKey: p.idKey };
  }

  async save(association: Association): Promise<void> {
    const dir = this.location.replace(/\/[^/]*$/, "");
    if (dir && dir !== this.location) {
      await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await Deno.writeTextFile(
      this.location,
      JSON.stringify(association, null, 2) + "\n",
      { mode: 0o600 },
    );
    await Deno.chmod(this.location, 0o600);
  }
}

/** Injectable side effects; tests replace them with in-memory fakes. */
export interface Dependencies {
  openTransport(proxyPath: string): Transport;
  associationStore(path: string): AssociationStore;
  sleep(ms: number): Promise<void>;
  now(): number;
  env(name: string): string | undefined;
  exists(path: string): boolean;
  os: string;
}

const MAC_PROXY_PATHS = [
  "/Applications/KeePassXC.app/Contents/MacOS/keepassxc-proxy",
];

/** Production side effects. */
export const defaultDependencies: Dependencies = {
  openTransport: (proxyPath) => new ProxyTransport(proxyPath),
  associationStore: (path) => new FileAssociationStore(path),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  env: (name) => Deno.env.get(name),
  exists: (path) => {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  os: Deno.build.os,
};

/** Resolves `keepassxc-proxy`: explicit config, macOS app bundle, then PATH. */
export function resolveProxyPath(
  config: KeePassXCConfig,
  deps: Pick<Dependencies, "env" | "exists" | "os">,
): string {
  if (config.proxyPath) return config.proxyPath;
  if (deps.os === "darwin") {
    const home = deps.env("HOME");
    const candidates = [
      ...MAC_PROXY_PATHS,
      ...(home ? [`${home}${MAC_PROXY_PATHS[0]}`] : []),
    ];
    for (const c of candidates) if (deps.exists(c)) return c;
  }
  return "keepassxc-proxy";
}

/** Resolves the association file path. */
export function resolveAssociationFile(
  vaultName: string,
  config: KeePassXCConfig,
  deps: Pick<Dependencies, "env">,
): string {
  if (config.associationFile) return config.associationFile;
  const home = deps.env("HOME") ?? deps.env("USERPROFILE");
  if (!home) {
    throw new Error(
      "cannot locate a home directory for the association file; set 'associationFile'",
    );
  }
  const safe = vaultName.replace(/[^A-Za-z0-9._-]+/g, "_") || "default";
  return `${home}/.config/swamp/keepassxc/${safe}.json`;
}

/** Resolves the URL namespace from config or the vault name. */
export function resolveNamespace(
  vaultName: string,
  config: KeePassXCConfig,
): string {
  const ns = config.namespace ?? namespaceFromVaultName(vaultName);
  if (!isValidNamespace(ns)) {
    throw new Error(
      `vault name '${vaultName}' gives no usable URL namespace; set 'namespace' in the vault config`,
    );
  }
  return ns;
}

/** One login as returned by `get-logins`. */
interface LoginEntry {
  login: string;
  password: string;
  uuid: string;
}

function toLoginEntries(reply: Record<string, unknown>): LoginEntry[] {
  const entries = Array.isArray(reply.entries) ? reply.entries : [];
  const out: LoginEntry[] = [];
  for (const e of entries) {
    if (e === null || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.login !== "string" || typeof r.password !== "string") {
      continue;
    }
    out.push({
      login: r.login,
      password: r.password,
      uuid: typeof r.uuid === "string" ? r.uuid : "",
    });
  }
  return out;
}

/** The provider shape swamp expects from `createProvider`. */
export interface KeePassXCProvider {
  get(secretKey: string): Promise<string>;
  put(secretKey: string, secretValue: string): Promise<void>;
  list(): Promise<string[]>;
  getName(): string;
}

/** Builds a provider with injectable dependencies (used directly by tests). */
export function createKeePassXCProvider(
  name: string,
  rawConfig: Record<string, unknown>,
  deps: Dependencies = defaultDependencies,
): KeePassXCProvider {
  const config = ConfigSchema.parse(rawConfig ?? {});
  const ns = resolveNamespace(name, config);
  const timeoutMs = config.timeoutSeconds * 1000;

  async function associate(session: BrowserSession): Promise<Association> {
    const store = deps.associationStore(
      resolveAssociationFile(name, config, deps),
    );
    const saved = await store.load();
    if (saved) {
      try {
        await session.call("test-associate", {
          id: saved.id,
          key: saved.idKey,
        });
      } catch (err) {
        if (
          err instanceof KeePassXCError &&
          err.code === ErrorCode.ASSOCIATION_FAILED
        ) {
          throw new KeePassXCError(
            err.code,
            `KeePassXC rejected stored association '${saved.id}' (removed in ` +
              `Settings > Browser Integration, or another database is ` +
              `active). Delete ${store.location} to re-associate.`,
          );
        }
        throw err;
      }
      return saved;
    }
    const idKey = toBase64(newKeyPair().publicKey);
    const reply = await session.call("associate", {
      key: session.publicKey,
      idKey,
    });
    if (typeof reply.id !== "string" || !reply.id) {
      throw new KeePassXCError(
        ErrorCode.ASSOCIATION_FAILED,
        "KeePassXC associate reply carried no id",
      );
    }
    const association = { id: reply.id, idKey };
    await store.save(association);
    return association;
  }

  async function withSession<T>(
    fn: (session: BrowserSession, assoc: Association) => Promise<T>,
  ): Promise<T> {
    const deadline = deps.now() + config.unlockWaitSeconds * 1000;
    while (true) {
      const transport = deps.openTransport(resolveProxyPath(config, deps));
      try {
        const session = new BrowserSession(transport, {
          timeoutMs,
          triggerUnlock: config.triggerUnlock,
        });
        await session.handshake();
        const assoc = await associate(session);
        return await fn(session, assoc);
      } catch (err) {
        const locked = err instanceof KeePassXCError &&
          err.code === ErrorCode.DATABASE_NOT_OPENED;
        if (!locked || deps.now() >= deadline) throw err;
      } finally {
        await transport.close();
      }
      await deps.sleep(1000);
    }
  }

  async function findByKey(
    session: BrowserSession,
    assoc: Association,
    key: string,
  ): Promise<LoginEntry[]> {
    try {
      const reply = await session.call("get-logins", {
        url: entryUrl(ns, key),
        submitUrl: entryUrl(ns, key),
        keys: [{ id: assoc.id, key: assoc.idKey }],
      });
      return toLoginEntries(reply).filter((e) => e.login === key);
    } catch (err) {
      if (
        err instanceof KeePassXCError &&
        err.code === ErrorCode.NO_LOGINS_FOUND
      ) {
        return [];
      }
      throw err;
    }
  }

  function ambiguous(key: string, n: number): Error {
    return new Error(
      `${n} KeePassXC entries in namespace '${ns}' have username '${key}'; ` +
        `remove the duplicates so the secret is unambiguous`,
    );
  }

  return {
    get: (secretKey) => {
      assertValidKey(secretKey);
      return withSession(async (session, assoc) => {
        const found = await findByKey(session, assoc, secretKey);
        if (found.length === 0) {
          throw new Error(
            `Secret '${secretKey}' not found in vault '${name}'`,
          );
        }
        if (found.length > 1) throw ambiguous(secretKey, found.length);
        return found[0].password;
      });
    },

    put: (secretKey, secretValue) => {
      assertValidKey(secretKey);
      if (typeof secretValue !== "string") {
        throw new Error("secret value must be a string");
      }
      return withSession(async (session, assoc) => {
        const found = await findByKey(session, assoc, secretKey);
        if (found.length > 1) throw ambiguous(secretKey, found.length);
        const url = entryUrl(ns, secretKey);
        const base = {
          url,
          submitUrl: url,
          id: assoc.id,
          login: secretKey,
          password: secretValue,
          downloadFavicon: "false",
        };
        if (found.length === 1) {
          if (!found[0].uuid) {
            throw new Error(
              `KeePassXC returned no uuid for '${secretKey}'; cannot update it`,
            );
          }
          if (found[0].password === secretValue) return;
          await session.call("set-login", {
            ...base,
            uuid: found[0].uuid,
            group: "",
            groupUuid: "",
          });
          return;
        }
        const group = await session.call("create-new-group", {
          groupName: config.group,
        });
        if (typeof group.uuid !== "string" || !group.uuid) {
          throw new KeePassXCError(
            ErrorCode.CANNOT_CREATE_NEW_GROUP,
            `KeePassXC did not return a uuid for group '${config.group}'`,
          );
        }
        await session.call("set-login", {
          ...base,
          uuid: "",
          group: typeof group.name === "string" ? group.name : config.group,
          groupUuid: group.uuid,
        });
      });
    },

    list: () =>
      withSession(async (session, assoc) => {
        let reply: Record<string, unknown>;
        try {
          reply = await session.call("get-logins", {
            url: namespaceUrl(ns),
            submitUrl: namespaceUrl(ns),
            keys: [{ id: assoc.id, key: assoc.idKey }],
          });
        } catch (err) {
          if (
            err instanceof KeePassXCError &&
            err.code === ErrorCode.NO_LOGINS_FOUND
          ) {
            return [];
          }
          throw err;
        }
        const keys = toLoginEntries(reply)
          .map((e) => e.login)
          .filter((k) => k.length > 0);
        return [...new Set(keys)].sort();
      }),

    getName: () => name,
  };
}

/** Swamp vault export: KeePassXC via the Browser Integration protocol. */
export const vault = {
  type: "@magistr/keepassxc",
  name: "KeePassXC",
  description:
    "Secrets stored as entries in a running, unlocked KeePassXC, reached " +
    "through its Browser Integration protocol (keepassxc-proxy). No master " +
    "password is stored; access is granted once in KeePassXC's GUI.",
  configSchema: ConfigSchema,
  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ): KeePassXCProvider => createKeePassXCProvider(name, config),
};
