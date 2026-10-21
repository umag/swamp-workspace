/**
 * Method-level tests for @magistr/openssl — every method's happy path and
 * primary failure, driven through `model.methods.<m>.arguments.parse()` +
 * `.execute()` against a fake context and a stubbed `Deno.Command` (no
 * openssl binary needed).
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { model } from "./openssl.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per suite, per this repo's convention). ONE seam:
// `Deno.Command(...).spawn()` — stdin is collected, `output()` asks the
// router. `emulate()` is a minimal openssl stand-in that writes `-out` files
// so the methods' real filesystem logic runs unchanged.
// ---------------------------------------------------------------------------

type Call = {
  cmd: string;
  args: string[];
  stdin: string;
  env?: Record<string, string>;
};
type Reply = { stdout?: string; stderr?: string; code?: number };

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function toOutput(r: Reply) {
  const enc = new TextEncoder();
  return {
    success: (r.code ?? 0) === 0,
    code: r.code ?? 0,
    stdout: enc.encode(r.stdout ?? ""),
    stderr: enc.encode(r.stderr ?? ""),
  };
}

function installCommand(router: (c: Call) => Reply) {
  const calls: Call[] = [];
  const D = Deno as unknown as { Command: unknown };
  const original = D.Command;
  class FakeCommand {
    constructor(
      private cmd: string,
      private opts: { args?: string[]; env?: Record<string, string> } = {},
    ) {}
    spawn() {
      if (this.cmd === "missing-openssl") {
        throw new Deno.errors.NotFound("no such file");
      }
      const call: Call = {
        cmd: this.cmd,
        args: this.opts.args ?? [],
        stdin: "",
        env: this.opts.env,
      };
      const chunks: Uint8Array[] = [];
      return {
        stdin: new WritableStream<Uint8Array>({
          write(c) {
            chunks.push(c);
          },
        }),
        output: () => {
          call.stdin = new TextDecoder().decode(concat(chunks));
          calls.push(call);
          return Promise.resolve(toOutput(router(call)));
        },
      };
    }
  }
  D.Command = FakeCommand;
  return {
    calls,
    restore: () => {
      D.Command = original;
    },
  };
}

const PUB = "-----BEGIN PUBLIC KEY-----\nPUB\n-----END PUBLIC KEY-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n";
const CSR =
  "-----BEGIN CERTIFICATE REQUEST-----\nR\n-----END CERTIFICATE REQUEST-----\n";

function cert(cn: string): string {
  return `-----BEGIN CERTIFICATE-----\n${
    btoa(cn)
  }\n-----END CERTIFICATE-----\n`;
}

/** Canned `x509 -text` output whose subject is the CN encoded in the PEM. */
function x509Text(pem: string, notAfter = "Jan  1 00:00:00 2099 GMT"): string {
  const body = pem.split("\n")[1] ?? "";
  const cn = body ? atob(body) : "unknown";
  const ca = cn === "root" || cn === "self";
  return [
    `subject=CN=${cn}`,
    `issuer=CN=${ca ? cn : "root"}`,
    "serial=01",
    "notBefore=Jan  1 00:00:00 2026 GMT",
    `notAfter=${notAfter}`,
    "sha256 Fingerprint=AA:BB",
    "        Signature Algorithm: ecdsa-with-SHA256",
    "            Public Key Algorithm: id-ecPublicKey",
    "                Public-Key: (256 bit)",
    "            X509v3 Basic Constraints: critical",
    `                CA:${ca ? "TRUE" : "FALSE"}`,
    "            X509v3 Subject Alternative Name: ",
    `                DNS:${cn}.test, IP Address:10.0.0.1`,
    "",
  ].join("\n");
}

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Minimal openssl stand-in covering every subcommand the model calls. */
function emulate(c: Call): Reply {
  const a = c.args;
  const out = val(a, "-out");
  const write = (s: string) => out && Deno.writeTextFileSync(out, s);
  switch (a[0]) {
    case "version":
      return { stdout: "OpenSSL 3.3.1 4 Jun 2024 (Library: OpenSSL 3.3.1)\n" };
    case "genpkey":
      write(KEY);
      return {};
    case "pkey":
      return { stdout: PUB };
    case "req":
      if (a.includes("-x509")) {
        write(cert("self"));
        return {};
      }
      if (a.includes("-new")) {
        write(CSR);
        return {};
      }
      if (a.includes("-verify")) {
        return { stderr: "Certificate request self-signature verify OK" };
      }
      if (a.includes("-subject")) return { stdout: "subject=CN=app.test\n" };
      return {
        stdout: "            X509v3 Subject Alternative Name: \n" +
          "                DNS:app.test, IP Address:10.0.0.1\n",
      };
    case "x509":
      if (a.includes("-req")) {
        write(cert("leaf"));
        return {};
      }
      if (a.includes("-checkhost")) {
        return {
          stdout: `Hostname ${val(a, "-checkhost")} does match certificate\n`,
        };
      }
      if (a.includes("-pubkey")) return { stdout: PUB };
      if (a.includes("-inform")) {
        if (out) {
          write(cert("der"));
          return {};
        }
        return { stdout: cert("der") };
      }
      if (a.includes("-outform")) {
        write("DER-BYTES");
        return {};
      }
      return { stdout: x509Text(c.stdin) };
    case "verify":
      return { stdout: `${a.at(-1)}: OK\n` };
    case "pkcs12":
      write(a.includes("-export") ? "P12-BYTES" : cert("p12") + KEY);
      return {};
    case "s_client":
      return { stdout: "CONNECTED(00000003)\n" + cert("host") + cert("root") };
  }
  return { code: 1, stderr: `unhandled ${a.join(" ")}` };
}

function fakeContext(globalArgs: Record<string, unknown> = {}) {
  const writes: Record<string, Record<string, unknown>> = {};
  return {
    writes,
    ctx: {
      globalArgs: model.globalArguments.parse(globalArgs),
      writeResource: (
        spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        writes[spec] = structuredClone(data);
        return Promise.resolve({});
      },
    },
  };
}

type MethodName = keyof typeof model.methods;

/** Run one method with the router installed; always restores Deno.Command. */
async function runMethod(
  name: MethodName,
  args: Record<string, unknown>,
  router: (c: Call) => Reply = emulate,
  globalArgs: Record<string, unknown> = {},
) {
  const stub = installCommand(router);
  const { ctx, writes } = fakeContext(globalArgs);
  const m = model.methods[name];
  try {
    await m.execute(m.arguments.parse(args) as Record<string, unknown>, ctx);
    return { calls: stub.calls, writes };
  } finally {
    stub.restore();
  }
}

/** Like runMethod but expects a rejection; returns the error and calls. */
async function runFailing(
  name: MethodName,
  args: Record<string, unknown>,
  router: (c: Call) => Reply = emulate,
  globalArgs: Record<string, unknown> = {},
) {
  const stub = installCommand(router);
  const { ctx, writes } = fakeContext(globalArgs);
  const m = model.methods[name];
  try {
    const err = await assertRejects(() =>
      m.execute(m.arguments.parse(args) as Record<string, unknown>, ctx)
    );
    return { err: err as Error, calls: stub.calls, writes };
  } finally {
    stub.restore();
  }
}

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "openssl-test-" });
}

async function exists(p: string): Promise<boolean> {
  return await Deno.stat(p).then(() => true, () => false);
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

Deno.test("version: records flavor and version", async () => {
  const { writes, calls } = await runMethod("version", {});
  assertEquals(calls[0].args, ["version"]);
  assertEquals(writes.version.flavor, "OpenSSL");
  assertEquals(writes.version.version, "3.3.1");
  assertEquals(writes.version.binary, "openssl");
});

Deno.test("version: non-zero exit is an error", async () => {
  const { err, writes } = await runFailing(
    "version",
    {},
    () => ({ code: 1, stderr: "boom" }),
  );
  assertStringIncludes(err.message, "openssl version failed (exit 1): boom");
  assertEquals(writes.version, undefined);
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

Deno.test("inspect: reads a PEM bundle and a host chain", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/b.pem`, cert("leaf") + cert("root"));
    const { writes, calls } = await runMethod("inspect", {
      paths: [`${d}/b.pem`],
      hosts: ["example.com:8443"],
    });
    const sources = writes.certificates.sources as {
      source: string;
      ok: boolean;
      certificates: { subject: string; isCA: boolean }[];
    }[];
    assertEquals(sources.map((s) => s.ok), [true, true]);
    assertEquals(
      sources[0].certificates.map((c) => c.subject),
      ["CN=leaf", "CN=root"],
    );
    assertEquals(sources[1].certificates[1].isCA, true);
    const sc = calls.find((c) => c.args[0] === "s_client")!;
    assertEquals(val(sc.args, "-connect"), "example.com:8443");
    assertEquals(val(sc.args, "-servername"), "example.com");
    assertEquals(writes.certificates.expiringSoon, []);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("inspect: every source failing is an error but is recorded", async () => {
  const { err, writes } = await runFailing("inspect", {
    paths: ["/nonexistent/x.pem"],
  });
  assertStringIncludes(err.message, "no source could be read");
  const sources = writes.certificates.sources as { ok: boolean }[];
  assertEquals(sources[0].ok, false);
});

// ---------------------------------------------------------------------------
// genkey
// ---------------------------------------------------------------------------

Deno.test("genkey: writes an EC key 0600 and records the public digest", async () => {
  const d = await tempDir();
  try {
    const { writes, calls } = await runMethod("genkey", { path: `${d}/k.pem` });
    assertEquals(await Deno.readTextFile(`${d}/k.pem`), KEY);
    assertEquals((await Deno.stat(`${d}/k.pem`)).mode! & 0o777, 0o600);
    assert(calls[0].args.includes("ec_paramgen_curve:prime256v1"));
    assertEquals(writes.key.changed, true);
    assertEquals(writes.key.type, "ec");
    assertMatch(writes.key.publicKeySha256 as string, /^[0-9a-f]{64}$/);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("genkey: openssl failure leaves no key behind", async () => {
  const d = await tempDir();
  try {
    const { err } = await runFailing(
      "genkey",
      { path: `${d}/k.pem` },
      (c) => c.args[0] === "genpkey" ? { code: 1, stderr: "bad" } : emulate(c),
    );
    assertStringIncludes(err.message, "openssl genpkey failed");
    assert(!await exists(`${d}/k.pem`));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// csr
// ---------------------------------------------------------------------------

Deno.test("csr: builds a config with subject and SANs", async () => {
  const d = await tempDir();
  let cfg = "";
  try {
    const { writes } = await runMethod("csr", {
      keyPath: `${d}/k.pem`,
      path: `${d}/r.csr`,
      subject: { CN: "app.test", O: "Acme" },
      sans: ["app.test", "10.0.0.1"],
    }, (c) => {
      const p = val(c.args, "-config");
      if (p) cfg = Deno.readTextFileSync(p);
      return emulate(c);
    });
    assertStringIncludes(cfg, "req_extensions = ext");
    assertStringIncludes(cfg, "CN = app.test");
    assertStringIncludes(cfg, "DNS.1 = app.test");
    assertStringIncludes(cfg, "IP.1 = 10.0.0.1");
    assertEquals(writes.csr.subject, "CN=app.test");
    assertEquals(writes.csr.sans, ["DNS:app.test", "IP:10.0.0.1"]);
    assertEquals(writes.csr.changed, true);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("csr: unreadable key surfaces openssl's error", async () => {
  const d = await tempDir();
  try {
    const { err, writes } = await runFailing(
      "csr",
      { keyPath: `${d}/none`, path: `${d}/r.csr`, subject: { CN: "x" } },
      (c) =>
        c.args.includes("-new")
          ? { code: 1, stderr: "Could not open file or uri" }
          : emulate(c),
    );
    assertStringIncludes(err.message, "Could not open file");
    assertEquals(writes.csr, undefined);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// selfsign
// ---------------------------------------------------------------------------

Deno.test("selfsign: CA root with x509 extensions and random serial", async () => {
  const d = await tempDir();
  let cfg = "";
  try {
    const { writes, calls } = await runMethod("selfsign", {
      keyPath: `${d}/k.pem`,
      path: `${d}/ca.crt`,
      subject: { CN: "root" },
      ca: true,
      days: 10,
    }, (c) => {
      const p = val(c.args, "-config");
      if (p) cfg = Deno.readTextFileSync(p);
      return emulate(c);
    });
    const req = calls.find((c) => c.args.includes("-x509"))!;
    assertEquals(val(req.args, "-days"), "10");
    assertMatch(val(req.args, "-set_serial")!, /^0x[0-7][0-9a-f]{31}$/);
    assertStringIncludes(cfg, "basicConstraints = critical, CA:TRUE");
    assertStringIncludes(cfg, "x509_extensions = ext");
    const c = writes.certificate.certificate as { isCA: boolean };
    assertEquals(c.isCA, true);
    assertEquals(writes.certificate.issuedBy, null);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("selfsign: openssl failure propagates", async () => {
  const d = await tempDir();
  try {
    const { err } = await runFailing(
      "selfsign",
      { keyPath: `${d}/k`, path: `${d}/c.crt`, subject: { CN: "x" } },
      (c) =>
        c.args.includes("-x509") ? { code: 2, stderr: "nope" } : emulate(c),
    );
    assertStringIncludes(err.message, "openssl req failed (exit 2): nope");
    assert(!await exists(`${d}/c.crt`));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------

Deno.test("sign: copies SANs from the CSR and records the issuer", async () => {
  const d = await tempDir();
  let ext = "";
  try {
    await Deno.writeTextFile(`${d}/ca.crt`, cert("root"));
    const { writes } = await runMethod("sign", {
      csrPath: `${d}/r.csr`,
      caCertPath: `${d}/ca.crt`,
      caKeyPath: `${d}/ca.key`,
      path: `${d}/leaf.crt`,
    }, (c) => {
      const p = val(c.args, "-extfile");
      if (p) ext = Deno.readTextFileSync(p);
      return emulate(c);
    });
    assertStringIncludes(ext, "DNS.1 = app.test");
    assertStringIncludes(ext, "IP.1 = 10.0.0.1");
    assertStringIncludes(ext, "authorityKeyIdentifier = keyid, issuer");
    assertEquals(writes.certificate.issuedBy, "CN=root");
    assertEquals(writes.certificate.changed, true);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("sign: a CSR with a bad self-signature is never signed", async () => {
  const d = await tempDir();
  try {
    const { err, calls } = await runFailing(
      "sign",
      {
        csrPath: `${d}/r.csr`,
        caCertPath: `${d}/ca.crt`,
        caKeyPath: `${d}/ca.key`,
        path: `${d}/leaf.crt`,
      },
      (c) =>
        c.args.includes("-verify")
          ? { code: 1, stderr: "verify failure" }
          : emulate(c),
    );
    assertStringIncludes(err.message, "verify failure");
    assert(!calls.some((c) => c.args.includes("-req")));
    assert(!await exists(`${d}/leaf.crt`));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

Deno.test("verify: chain, key and hostname all pass", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/leaf.crt`, cert("leaf"));
    const { writes, calls } = await runMethod("verify", {
      certPath: `${d}/leaf.crt`,
      caPath: `${d}/ca.crt`,
      keyPath: `${d}/leaf.key`,
      hostname: "leaf.test",
    });
    assertEquals(writes.verification.valid, true);
    assertEquals(writes.verification.keyMatches, true);
    assertEquals(writes.verification.hostnameOk, true);
    const v = calls.find((c) => c.args[0] === "verify")!;
    assertEquals(val(v.args, "-CAfile"), `${d}/ca.crt`);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("verify: an untrusted chain fails and is recorded", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/leaf.crt`, cert("leaf"));
    const { err, writes } = await runFailing(
      "verify",
      { certPath: `${d}/leaf.crt` },
      (c) =>
        c.args[0] === "verify"
          ? {
            code: 2,
            stderr:
              "error 20 at 0 depth lookup: unable to get local issuer certificate",
          }
          : emulate(c),
    );
    assertStringIncludes(err.message, "chainOk=false");
    assertEquals(writes.verification.valid, false);
    assertStringIncludes(
      writes.verification.chainOutput as string,
      "unable to get local issuer",
    );
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

Deno.test("convert: PEM certificate to DER", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/c.pem`, cert("leaf"));
    const { writes, calls } = await runMethod("convert", {
      inPath: `${d}/c.pem`,
      outPath: `${d}/c.der`,
      to: "der",
    });
    assertEquals(val(calls[0].args, "-outform"), "DER");
    assertEquals(await Deno.readTextFile(`${d}/c.der`), "DER-BYTES");
    assertEquals(writes.conversion.changed, true);
    assertEquals(writes.conversion.bytes, 9);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("convert: to=p12 without keyPath is refused", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/c.pem`, cert("leaf"));
    const { err, calls } = await runFailing("convert", {
      inPath: `${d}/c.pem`,
      outPath: `${d}/c.p12`,
      to: "p12",
    });
    assertStringIncludes(err.message, "to=p12 needs keyPath");
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});
