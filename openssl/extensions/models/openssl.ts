/**
 * `@magistr/openssl` — inspect, create and convert X.509 material with the
 * local `openssl` CLI.
 *
 * - `version`  — which openssl binary runs (OpenSSL / LibreSSL) and its version.
 * - `inspect`  — parse certificates from files (PEM bundles or DER) and from
 *                live TLS endpoints (full chain), with days-to-expiry.
 * - `genkey`   — generate an RSA / EC / Ed25519 private key (mode 0600).
 * - `csr`      — create a certificate signing request with SANs.
 * - `selfsign` — create a self-signed certificate (leaf or CA).
 * - `sign`     — sign a CSR with a CA certificate + key.
 * - `verify`   — check chain trust, cert/key match and hostname.
 * - `convert`  — PEM ↔ DER, PEM → PKCS#12, PKCS#12 → PEM.
 *
 * Private keys never enter swamp data: only paths and public facts are
 * recorded. Passwords travel to openssl through the environment, never argv.
 * Every write is idempotent — an existing output is kept unless `overwrite`.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  binary: z.string().default("openssl").describe(
    "openssl executable (name on PATH or absolute path)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface ExecContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

// ---------------------------------------------------------------------------
// Process helper
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

async function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  let child;
  try {
    child = new Deno.Command(cmd, {
      args,
      env: opts.env,
      stdin: opts.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    }).spawn();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`${cmd} not found; install openssl or set binary`);
    }
    throw e;
  }
  if (opts.stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(opts.stdin));
    await w.close();
  }
  const out = await child.output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr).trim(),
  };
}

async function openssl(
  g: GlobalArgs,
  args: string[],
  opts: RunOptions = {},
): Promise<string> {
  const r = await run(g.binary, args, opts);
  if (r.code !== 0) {
    throw new Error(
      `openssl ${args[0]} failed (exit ${r.code}): ${
        (r.stderr || r.stdout).slice(-2000)
      }`,
    );
  }
  return r.stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-openssl-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const PEM_CERT =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Every PEM certificate block in `text`, in order. */
export function splitPemCertificates(text: string): string[] {
  return text.match(PEM_CERT) ?? [];
}

/** Parse `host`, `host:port` or `[v6]:port` (default port 443). */
export function parseTarget(target: string): { host: string; port: number } {
  const m = target.match(/^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/) ??
    target.match(/^([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d+))?$/);
  if (!m) throw new Error(`invalid host target: ${target}`);
  const port = Number(m[2] ?? 443);
  if (port < 1 || port > 65535) throw new Error(`invalid port in ${target}`);
  return { host: m[1], port };
}

/** Facts parsed from one certificate. */
export interface CertInfo {
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  daysLeft: number;
  expired: boolean;
  selfSigned: boolean;
  isCA: boolean;
  sans: string[];
  keyAlgorithm: string;
  keyBits: number | null;
  signatureAlgorithm: string;
  keyUsage: string[];
  extendedKeyUsage: string[];
  sha256: string;
}

function textSection(text: string, header: string): string | null {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim().startsWith(header));
  if (i < 0 || i + 1 >= lines.length) return null;
  return lines[i + 1].trim();
}

function toIso(opensslDate: string): string {
  const d = new Date(opensslDate.replace(/\s+/g, " ").trim());
  if (Number.isNaN(d.getTime())) {
    throw new Error(`unparseable openssl date: ${opensslDate}`);
  }
  return d.toISOString();
}

/**
 * Parse `openssl x509 -noout -subject -issuer -serial -startdate -enddate
 * -fingerprint -sha256 -nameopt RFC2253 -text` output.
 */
export function parseX509(out: string, now = new Date()): CertInfo {
  const line = (re: RegExp) => out.match(re)?.[1]?.trim() ?? "";
  const subject = line(/^subject=(.*)$/m);
  const issuer = line(/^issuer=(.*)$/m);
  const notAfter = toIso(line(/^notAfter=(.*)$/m));
  const notBefore = toIso(line(/^notBefore=(.*)$/m));
  const sanLine = textSection(out, "X509v3 Subject Alternative Name") ?? "";
  const sans = sanLine
    ? sanLine.split(/,\s*/).map((s) => s.replace(/^IP Address:/, "IP:"))
    : [];
  const list = (header: string) =>
    (textSection(out, header) ?? "").split(/,\s*/).filter(Boolean);
  const daysLeft = Math.floor(
    (Date.parse(notAfter) - now.getTime()) / 86_400_000,
  );
  return {
    subject,
    issuer,
    serial: line(/^serial=(.*)$/m),
    notBefore,
    notAfter,
    daysLeft,
    expired: Date.parse(notAfter) < now.getTime(),
    selfSigned: subject !== "" && subject === issuer,
    isCA: /CA:TRUE/.test(textSection(out, "X509v3 Basic Constraints") ?? ""),
    sans,
    keyAlgorithm: line(/Public Key Algorithm:\s*(.*)$/m),
    keyBits: Number(line(/Public-Key:\s*\((\d+) bit\)/m)) || null,
    signatureAlgorithm: line(/Signature Algorithm:\s*(.*)$/m),
    keyUsage: list("X509v3 Key Usage"),
    extendedKeyUsage: list("X509v3 Extended Key Usage"),
    sha256: line(/Fingerprint=(.*)$/m),
  };
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:.]*$/;

/** Classify one SAN string into an openssl config `TYPE.n = value` key. */
export function sanEntry(san: string): { type: string; value: string } {
  const explicit = san.match(/^(DNS|IP|email|URI):(.+)$/);
  if (explicit) return { type: explicit[1], value: explicit[2] };
  if (IPV4.test(san) || IPV6.test(san)) return { type: "IP", value: san };
  if (/^[^@\s]+@[^@\s]+$/.test(san)) return { type: "email", value: san };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(san)) return { type: "URI", value: san };
  return { type: "DNS", value: san };
}

const SubjectSchema = z.object({
  CN: z.string().optional(),
  O: z.string().optional(),
  OU: z.string().optional(),
  C: z.string().length(2).optional(),
  ST: z.string().optional(),
  L: z.string().optional(),
  emailAddress: z.string().optional(),
}).refine((s) => Object.values(s).some((v) => v), {
  message: "subject needs at least one field (usually CN)",
});

type Subject = z.infer<typeof SubjectSchema>;

/** Escape a value for an openssl config file (no `$` expansion, no newlines). */
function cfgValue(v: string): string {
  if (/[\r\n]/.test(v)) {
    throw new Error("config values cannot contain newlines");
  }
  return v.replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
}

/** Options for {@link buildConfig}. */
export interface ConfigOptions {
  subject?: Subject;
  sans: string[];
  ca: boolean;
  /** csr: request extensions; x509: certificate extensions. */
  target: "csr" | "x509";
  /** Add authorityKeyIdentifier (only when an issuer key exists). */
  authorityKeyId?: boolean;
}

/** Build an openssl config with a [dn] section and an [ext] section. */
export function buildConfig(o: ConfigOptions): string {
  const lines = ["[req]", "prompt = no", "distinguished_name = dn"];
  lines.push(
    o.target === "csr" ? "req_extensions = ext" : "x509_extensions = ext",
  );
  lines.push("", "[dn]");
  for (const [k, v] of Object.entries(o.subject ?? { CN: "unused" })) {
    if (v) lines.push(`${k} = ${cfgValue(v)}`);
  }
  lines.push("", "[ext]");
  if (o.ca) {
    lines.push(
      "basicConstraints = critical, CA:TRUE",
      "keyUsage = critical, keyCertSign, cRLSign, digitalSignature",
    );
  } else {
    lines.push(
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth, clientAuth",
    );
  }
  if (o.target === "x509") lines.push("subjectKeyIdentifier = hash");
  if (o.authorityKeyId) lines.push("authorityKeyIdentifier = keyid, issuer");
  if (o.sans.length) {
    lines.push("subjectAltName = @alt", "", "[alt]");
    const counts: Record<string, number> = {};
    for (const s of o.sans) {
      const { type, value } = sanEntry(s);
      counts[type] = (counts[type] ?? 0) + 1;
      lines.push(`${type}.${counts[type]} = ${cfgValue(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// openssl-backed operations
// ---------------------------------------------------------------------------

const X509_FIELDS = [
  "-noout",
  "-subject",
  "-issuer",
  "-serial",
  "-startdate",
  "-enddate",
  "-fingerprint",
  "-sha256",
  "-nameopt",
  "RFC2253",
  "-text",
];

async function inspectPem(g: GlobalArgs, pem: string): Promise<CertInfo> {
  return parseX509(await openssl(g, ["x509", ...X509_FIELDS], { stdin: pem }));
}

/** PEM certificates in a file; DER files are converted first. */
async function certsFromFile(g: GlobalArgs, path: string): Promise<string[]> {
  const bytes = await Deno.readFile(path);
  const text = new TextDecoder().decode(bytes);
  const pems = splitPemCertificates(text);
  if (pems.length) return pems;
  const pem = await openssl(g, [
    "x509",
    "-inform",
    "DER",
    "-in",
    path,
    "-outform",
    "PEM",
  ]);
  return splitPemCertificates(pem);
}

async function publicKeyDigest(
  g: GlobalArgs,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const pub = await openssl(g, args, { env });
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pub.trim()),
  );
  return Array.from(new Uint8Array(d)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function keyPubArgs(keyPath: string, pass: boolean): string[] {
  return [
    "pkey",
    "-in",
    keyPath,
    "-pubout",
    ...(pass ? ["-passin", "env:OPENSSL_PASSIN"] : []),
  ];
}

function passEnv(name: string, value?: string): Record<string, string> {
  return value === undefined ? {} : { [name]: value };
}

async function sansFromCsr(g: GlobalArgs, csrPath: string): Promise<string[]> {
  const text = await openssl(g, ["req", "-in", csrPath, "-noout", "-text"]);
  const line = textSection(text, "X509v3 Subject Alternative Name");
  return line
    ? line.split(/,\s*/).map((s) => s.replace(/^IP Address:/, "IP:"))
    : [];
}

function randomSerial(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[0] &= 0x7f; // keep it positive
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** Refuse to clobber an output unless `overwrite`; returns true to skip. */
async function keepExisting(path: string, overwrite: boolean) {
  return !overwrite && await exists(path);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CertInfoSchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  serial: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  daysLeft: z.number(),
  expired: z.boolean(),
  selfSigned: z.boolean(),
  isCA: z.boolean(),
  sans: z.array(z.string()),
  keyAlgorithm: z.string(),
  keyBits: z.number().nullable(),
  signatureAlgorithm: z.string(),
  keyUsage: z.array(z.string()),
  extendedKeyUsage: z.array(z.string()),
  sha256: z.string(),
});

const PathSchema = z.string().min(1).refine((p) => !p.startsWith("-"), {
  message: "paths cannot start with '-'",
});

const SansSchema = z.array(
  z.string().regex(/^[A-Za-z0-9*._:@/[\]+-]+$/, "invalid SAN"),
).default([]).describe(
  "Subject alternative names: example.com, *.example.com, 10.0.0.1, " +
    "a@b.c, https://x — or explicit DNS:/IP:/email:/URI: prefixes",
);

const SubjectArg = SubjectSchema.describe(
  "Distinguished name fields, e.g. { CN: 'example.com', O: 'Acme' }",
);

const InspectArgsSchema = z.object({
  paths: z.array(PathSchema).default([]).describe(
    "Certificate files (PEM bundles or DER)",
  ),
  hosts: z.array(z.string()).default([]).describe(
    "TLS endpoints: host, host:port or [v6]:port (default port 443)",
  ),
  servername: z.string().optional().describe(
    "SNI name for every host (default: the host itself)",
  ),
  warnDays: z.number().int().min(0).default(30).describe(
    "Flag certificates expiring within this many days",
  ),
  timeoutSeconds: z.number().int().min(1).max(120).default(15).describe(
    "Per-host connect timeout",
  ),
}).refine((a) => a.paths.length + a.hosts.length > 0, {
  message: "give at least one of paths or hosts",
});

const GenkeyArgsSchema = z.object({
  path: PathSchema.describe("Where to write the PEM private key"),
  type: z.enum(["rsa", "ec", "ed25519"]).default("ec").describe("Key type"),
  bits: z.number().int().min(2048).max(8192).default(3072).describe(
    "RSA modulus size",
  ),
  curve: z.enum(["prime256v1", "secp384r1", "secp521r1"]).default(
    "prime256v1",
  ).describe("EC curve"),
  overwrite: z.boolean().default(false).describe("Replace an existing key"),
});

const CsrArgsSchema = z.object({
  keyPath: PathSchema.describe("Private key to sign the request with"),
  path: PathSchema.describe("Where to write the PEM CSR"),
  subject: SubjectArg,
  sans: SansSchema,
  ca: z.boolean().default(false).describe("Request CA:TRUE extensions"),
  keyPassword: z.string().optional().describe("Passphrase of keyPath"),
  overwrite: z.boolean().default(false),
});

const SelfsignArgsSchema = z.object({
  keyPath: PathSchema.describe("Private key of the certificate"),
  path: PathSchema.describe("Where to write the PEM certificate"),
  subject: SubjectArg,
  sans: SansSchema,
  days: z.number().int().min(1).max(36500).default(365),
  ca: z.boolean().default(false).describe(
    "Make a CA (keyCertSign) instead of a TLS leaf",
  ),
  keyPassword: z.string().optional().describe("Passphrase of keyPath"),
  overwrite: z.boolean().default(false),
});

const SignArgsSchema = z.object({
  csrPath: PathSchema.describe("CSR to sign"),
  caCertPath: PathSchema.describe("Issuing CA certificate"),
  caKeyPath: PathSchema.describe("Issuing CA private key"),
  path: PathSchema.describe("Where to write the issued PEM certificate"),
  sans: z.array(z.string().regex(/^[A-Za-z0-9*._:@/[\]+-]+$/)).optional()
    .describe("Override SANs; default copies them from the CSR"),
  days: z.number().int().min(1).max(36500).default(397),
  ca: z.boolean().default(false).describe("Issue an intermediate CA"),
  caKeyPassword: z.string().optional().describe("Passphrase of caKeyPath"),
  overwrite: z.boolean().default(false),
});

const VerifyArgsSchema = z.object({
  certPath: PathSchema.describe("Certificate to verify"),
  caPath: PathSchema.optional().describe(
    "Trusted CA bundle; default is the system trust store",
  ),
  untrustedPath: PathSchema.optional().describe("Intermediate certificates"),
  keyPath: PathSchema.optional().describe("Check the cert matches this key"),
  keyPassword: z.string().optional(),
  hostname: z.string().regex(/^[A-Za-z0-9*.-]+$/).optional().describe(
    "Check the cert is valid for this DNS name",
  ),
});

const ConvertArgsSchema = z.object({
  inPath: PathSchema.describe("Input file"),
  outPath: PathSchema.describe("Output file"),
  to: z.enum(["pem", "der", "p12"]).describe(
    "pem: DER cert or PKCS#12 → PEM; der: PEM cert → DER; " +
      "p12: PEM cert + key → PKCS#12",
  ),
  keyPath: PathSchema.optional().describe("Private key (to=p12)"),
  chainPath: PathSchema.optional().describe("Extra certificates (to=p12)"),
  name: z.string().optional().describe("Friendly name inside the PKCS#12"),
  password: z.string().optional().describe(
    "PKCS#12 password (to=p12: export; from p12: import). " +
      "Pass via a vault expression",
  ),
  overwrite: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The `@magistr/openssl` model definition. */
export const model = {
  type: "@magistr/openssl",
  version: "2026.10.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    version: {
      description: "openssl binary and version",
      schema: z.object({
        binary: z.string(),
        flavor: z.enum(["OpenSSL", "LibreSSL", "unknown"]),
        version: z.string(),
        raw: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    certificates: {
      description: "Inspected certificates from files and TLS endpoints",
      schema: z.object({
        warnDays: z.number(),
        sources: z.array(z.object({
          source: z.string(),
          kind: z.enum(["file", "host"]),
          ok: z.boolean(),
          error: z.string().optional(),
          certificates: z.array(CertInfoSchema),
        })),
        expiringSoon: z.array(z.string()).describe(
          "source#index of certs expiring within warnDays (or expired)",
        ),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 50,
    },
    key: {
      description: "Generated private key (path + public key digest only)",
      schema: z.object({
        path: z.string(),
        type: z.string(),
        changed: z.boolean(),
        publicKeySha256: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    csr: {
      description: "Generated certificate signing request",
      schema: z.object({
        path: z.string(),
        keyPath: z.string(),
        changed: z.boolean(),
        subject: z.string(),
        sans: z.array(z.string()),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    certificate: {
      description: "Certificate written by selfsign or sign",
      schema: z.object({
        path: z.string(),
        changed: z.boolean(),
        issuedBy: z.string().nullable(),
        certificate: CertInfoSchema,
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 50,
    },
    verification: {
      description: "Result of verify",
      schema: z.object({
        certPath: z.string(),
        valid: z.boolean(),
        chainOk: z.boolean(),
        chainOutput: z.string(),
        keyMatches: z.boolean().nullable(),
        hostnameOk: z.boolean().nullable(),
        certificate: CertInfoSchema,
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 50,
    },
    conversion: {
      description: "Result of convert",
      schema: z.object({
        inPath: z.string(),
        outPath: z.string(),
        to: z.string(),
        changed: z.boolean(),
        bytes: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    version: {
      description: "Report which openssl binary runs and its version.",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: ExecContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const raw = (await openssl(g, ["version"])).trim();
        const m = raw.match(/^(OpenSSL|LibreSSL)\s+(\S+)/);
        await context.writeResource("version", "version", {
          binary: g.binary,
          flavor: m ? m[1] : "unknown",
          version: m ? m[2] : raw,
          raw,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
    inspect: {
      description: "Parse certificates from files (PEM bundles / DER) and " +
        "live TLS endpoints (full presented chain) in one run.",
      arguments: InspectArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = InspectArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        type Source = {
          source: string;
          kind: "file" | "host";
          ok: boolean;
          error?: string;
          certificates: CertInfo[];
        };
        const collect = async (
          source: string,
          kind: "file" | "host",
          load: () => Promise<string[]>,
        ): Promise<Source> => {
          try {
            const pems = await load();
            if (!pems.length) throw new Error("no certificates found");
            const certificates: CertInfo[] = [];
            for (const p of pems) certificates.push(await inspectPem(g, p));
            return { source, kind, ok: true, certificates };
          } catch (e) {
            return {
              source,
              kind,
              ok: false,
              error: (e as Error).message,
              certificates: [],
            };
          }
        };
        const sources = await Promise.all([
          ...args.paths.map((p) =>
            collect(p, "file", () => certsFromFile(g, p))
          ),
          ...args.hosts.map((h) =>
            collect(h, "host", async () => {
              const { host, port } = parseTarget(h);
              const r = await run(g.binary, [
                "s_client",
                "-connect",
                host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`,
                "-servername",
                args.servername ?? host,
                "-showcerts",
              ], { stdin: "", timeoutMs: args.timeoutSeconds * 1000 });
              const pems = splitPemCertificates(r.stdout);
              if (!pems.length) {
                throw new Error(
                  `TLS handshake failed: ${r.stderr.slice(-500) || "timeout"}`,
                );
              }
              return pems;
            })
          ),
        ]);
        const expiringSoon: string[] = [];
        for (const s of sources) {
          s.certificates.forEach((c, i) => {
            if (c.daysLeft < args.warnDays) {
              expiringSoon.push(`${s.source}#${i}`);
            }
          });
        }
        await context.writeResource("certificates", "certificates", {
          warnDays: args.warnDays,
          sources,
          expiringSoon,
          timestamp: new Date().toISOString(),
        });
        const failed = sources.filter((s) => !s.ok);
        if (failed.length === sources.length) {
          throw new Error(
            `no source could be read: ${
              failed.map((f) => `${f.source}: ${f.error}`).join("; ")
            }`,
          );
        }
        return {};
      },
    },
    genkey: {
      description: "Generate a private key (default EC P-256) with mode " +
        "0600. Keeps an existing key unless overwrite.",
      arguments: GenkeyArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = GenkeyArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const skip = await keepExisting(args.path, args.overwrite);
        if (!skip) {
          const algo = args.type === "rsa"
            ? ["-algorithm", "RSA", "-pkeyopt", `rsa_keygen_bits:${args.bits}`]
            : args.type === "ec"
            ? [
              "-algorithm",
              "EC",
              "-pkeyopt",
              `ec_paramgen_curve:${args.curve}`,
            ]
            : ["-algorithm", "ED25519"];
          await withTempDir(async (dir) => {
            // Generate beside nothing readable, then move into place 0600.
            const tmp = `${dir}/key.pem`;
            await openssl(g, ["genpkey", ...algo, "-out", tmp]);
            await Deno.chmod(tmp, 0o600);
            await Deno.copyFile(tmp, args.path);
            await Deno.chmod(args.path, 0o600);
          });
        }
        await context.writeResource("key", "key", {
          path: args.path,
          type: args.type,
          changed: !skip,
          publicKeySha256: await publicKeyDigest(
            g,
            keyPubArgs(args.path, false),
          ),
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
    csr: {
      description: "Create a PEM certificate signing request with subject " +
        "and SANs. Keeps an existing CSR unless overwrite.",
      arguments: CsrArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = CsrArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const skip = await keepExisting(args.path, args.overwrite);
        if (!skip) {
          await withTempDir(async (dir) => {
            const cfg = `${dir}/req.cnf`;
            await Deno.writeTextFile(
              cfg,
              buildConfig({
                subject: args.subject,
                sans: args.sans,
                ca: args.ca,
                target: "csr",
              }),
            );
            await openssl(g, [
              "req",
              "-new",
              "-sha256",
              "-key",
              args.keyPath,
              "-config",
              cfg,
              "-out",
              args.path,
              ...(args.keyPassword ? ["-passin", "env:OPENSSL_PASSIN"] : []),
            ], { env: passEnv("OPENSSL_PASSIN", args.keyPassword) });
          });
        }
        const subject = (await openssl(g, [
          "req",
          "-in",
          args.path,
          "-noout",
          "-subject",
          "-nameopt",
          "RFC2253",
        ])).trim().replace(/^subject=/, "");
        await context.writeResource("csr", "csr", {
          path: args.path,
          keyPath: args.keyPath,
          changed: !skip,
          subject,
          sans: await sansFromCsr(g, args.path),
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
    selfsign: {
      description: "Create a self-signed certificate — a TLS leaf, or a CA " +
        "root with ca=true. Keeps an existing cert unless overwrite.",
      arguments: SelfsignArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = SelfsignArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const skip = await keepExisting(args.path, args.overwrite);
        if (!skip) {
          await withTempDir(async (dir) => {
            const cfg = `${dir}/req.cnf`;
            await Deno.writeTextFile(
              cfg,
              buildConfig({
                subject: args.subject,
                sans: args.sans,
                ca: args.ca,
                target: "x509",
              }),
            );
            await openssl(g, [
              "req",
              "-x509",
              "-new",
              "-sha256",
              "-key",
              args.keyPath,
              "-days",
              String(args.days),
              "-set_serial",
              randomSerial(),
              "-config",
              cfg,
              "-out",
              args.path,
              ...(args.keyPassword ? ["-passin", "env:OPENSSL_PASSIN"] : []),
            ], { env: passEnv("OPENSSL_PASSIN", args.keyPassword) });
          });
        }
        const [pem] = await certsFromFile(g, args.path);
        await context.writeResource("certificate", "certificate", {
          path: args.path,
          changed: !skip,
          issuedBy: null,
          certificate: await inspectPem(g, pem),
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
    sign: {
      description: "Sign a CSR with a CA certificate and key. SANs are " +
        "copied from the CSR unless given. Keeps an existing cert unless " +
        "overwrite.",
      arguments: SignArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = SignArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const skip = await keepExisting(args.path, args.overwrite);
        if (!skip) {
          // Verify the CSR's self-signature before issuing anything.
          await openssl(g, ["req", "-in", args.csrPath, "-noout", "-verify"]);
          const sans = args.sans ?? await sansFromCsr(g, args.csrPath);
          await withTempDir(async (dir) => {
            const cfg = `${dir}/ext.cnf`;
            await Deno.writeTextFile(
              cfg,
              buildConfig({
                sans,
                ca: args.ca,
                target: "x509",
                authorityKeyId: true,
              }),
            );
            await openssl(g, [
              "x509",
              "-req",
              "-sha256",
              "-in",
              args.csrPath,
              "-CA",
              args.caCertPath,
              "-CAkey",
              args.caKeyPath,
              "-set_serial",
              randomSerial(),
              "-days",
              String(args.days),
              "-extfile",
              cfg,
              "-extensions",
              "ext",
              "-out",
              args.path,
              ...(args.caKeyPassword ? ["-passin", "env:OPENSSL_PASSIN"] : []),
            ], { env: passEnv("OPENSSL_PASSIN", args.caKeyPassword) });
          });
        }
        const [pem] = await certsFromFile(g, args.path);
        const [caPem] = await certsFromFile(g, args.caCertPath);
        await context.writeResource("certificate", "certificate", {
          path: args.path,
          changed: !skip,
          issuedBy: (await inspectPem(g, caPem)).subject,
          certificate: await inspectPem(g, pem),
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
    verify: {
      description: "Verify a certificate's chain (against caPath or the " +
        "system store), optionally that it matches a key and a hostname. " +
        "Records the result; fails when any requested check fails.",
      arguments: VerifyArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = VerifyArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const [pem] = await certsFromFile(g, args.certPath);
        const chain = await withTempDir(async (dir) => {
          // DER input is normalised to PEM so verify reads either format.
          const leaf = `${dir}/leaf.pem`;
          await Deno.writeTextFile(leaf, pem);
          return await run(g.binary, [
            "verify",
            ...(args.caPath ? ["-CAfile", args.caPath] : []),
            ...(args.untrustedPath ? ["-untrusted", args.untrustedPath] : []),
            leaf,
          ]);
        });
        const chainOk = chain.code === 0 && /: OK\s*$/.test(chain.stdout);
        let keyMatches: boolean | null = null;
        if (args.keyPath) {
          const fromKey = await publicKeyDigest(
            g,
            keyPubArgs(args.keyPath, args.keyPassword !== undefined),
            passEnv("OPENSSL_PASSIN", args.keyPassword),
          );
          const fromCert = await withTempDir(async (dir) => {
            const leaf = `${dir}/leaf.pem`;
            await Deno.writeTextFile(leaf, pem);
            const certPub = await openssl(g, [
              "x509",
              "-in",
              leaf,
              "-noout",
              "-pubkey",
            ]);
            await Deno.writeTextFile(`${dir}/pub.pem`, certPub);
            return await publicKeyDigest(g, [
              "pkey",
              "-pubin",
              "-in",
              `${dir}/pub.pem`,
              "-pubout",
            ]);
          });
          keyMatches = fromKey === fromCert;
        }
        let hostnameOk: boolean | null = null;
        if (args.hostname) {
          const out = await openssl(g, [
            "x509",
            "-noout",
            "-checkhost",
            args.hostname,
          ], { stdin: pem });
          hostnameOk = /does match certificate/.test(out);
        }
        const valid = chainOk && keyMatches !== false && hostnameOk !== false;
        await context.writeResource("verification", "verification", {
          certPath: args.certPath,
          valid,
          chainOk,
          chainOutput: `${chain.stdout}${chain.stderr}`.trim().slice(-2000),
          keyMatches,
          hostnameOk,
          certificate: await inspectPem(g, pem),
          timestamp: new Date().toISOString(),
        });
        if (!valid) {
          throw new Error(
            `verification failed: chainOk=${chainOk} keyMatches=${keyMatches} ` +
              `hostnameOk=${hostnameOk}`,
          );
        }
        return {};
      },
    },
    convert: {
      description: "Convert between PEM, DER and PKCS#12. Keeps an existing " +
        "output unless overwrite.",
      arguments: ConvertArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = ConvertArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const skip = await keepExisting(args.outPath, args.overwrite);
        if (!skip) {
          const input = await Deno.readFile(args.inPath);
          const isPem = new TextDecoder().decode(input.subarray(0, 4096))
            .includes("-----BEGIN");
          const env = passEnv("OPENSSL_PASS", args.password ?? "");
          if (args.to === "der") {
            if (!isPem) throw new Error(`${args.inPath} is not PEM`);
            await openssl(g, [
              "x509",
              "-in",
              args.inPath,
              "-outform",
              "DER",
              "-out",
              args.outPath,
            ]);
          } else if (args.to === "p12") {
            if (!args.keyPath) throw new Error("to=p12 needs keyPath");
            await openssl(g, [
              "pkcs12",
              "-export",
              "-in",
              args.inPath,
              "-inkey",
              args.keyPath,
              ...(args.chainPath ? ["-certfile", args.chainPath] : []),
              ...(args.name ? ["-name", args.name] : []),
              "-passout",
              "env:OPENSSL_PASS",
              "-out",
              args.outPath,
            ], { env });
          } else if (isPem) {
            throw new Error(`${args.inPath} is already PEM`);
          } else {
            // DER certificate first; fall back to PKCS#12.
            const der = await run(g.binary, [
              "x509",
              "-inform",
              "DER",
              "-in",
              args.inPath,
              "-out",
              args.outPath,
            ]);
            if (der.code !== 0) {
              await withTempDir(async (dir) => {
                // Write through a temp file so a wrong password leaves nothing.
                const tmp = `${dir}/out.pem`;
                await openssl(g, [
                  "pkcs12",
                  "-in",
                  args.inPath,
                  "-nodes",
                  "-passin",
                  "env:OPENSSL_PASS",
                  "-out",
                  tmp,
                ], { env });
                await Deno.chmod(tmp, 0o600);
                await Deno.copyFile(tmp, args.outPath);
                await Deno.chmod(args.outPath, 0o600);
              });
            }
          }
        }
        await context.writeResource("conversion", "conversion", {
          inPath: args.inPath,
          outPath: args.outPath,
          to: args.to,
          changed: !skip,
          bytes: (await Deno.stat(args.outPath)).size,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
  },
};
