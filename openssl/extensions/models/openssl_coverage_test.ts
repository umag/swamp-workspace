/**
 * Coverage tests for @magistr/openssl: the branches the method suite does
 * not reach — version flavours, binary resolution, DER and PKCS#12
 * fallbacks, warnDays/expiry flags, IPv6 targets, every genkey key type,
 * passphrase plumbing, SAN override/absence, and verify against the system
 * store with intermediates.
 */
import {
  assert,
  assertEquals,
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

// ---------------------------------------------------------------------------
// version flavours and binary resolution
// ---------------------------------------------------------------------------

Deno.test("version: LibreSSL and unknown flavours", async () => {
  const libre = await runMethod(
    "version",
    {},
    () => ({ stdout: "LibreSSL 3.3.6\n" }),
  );
  assertEquals(libre.writes.version.flavor, "LibreSSL");
  assertEquals(libre.writes.version.version, "3.3.6");
  const odd = await runMethod(
    "version",
    {},
    () => ({ stdout: "BoringSSL\n" }),
  );
  assertEquals(odd.writes.version.flavor, "unknown");
  assertEquals(odd.writes.version.version, "BoringSSL");
});

Deno.test("binary global is used and a missing binary is named", async () => {
  const ok = await runMethod("version", {}, emulate, {
    binary: "/opt/homebrew/bin/openssl",
  });
  assertEquals(ok.calls[0].cmd, "/opt/homebrew/bin/openssl");
  const { err } = await runFailing("version", {}, emulate, {
    binary: "missing-openssl",
  });
  assertStringIncludes(err.message, "missing-openssl not found");
});

// ---------------------------------------------------------------------------
// inspect branches
// ---------------------------------------------------------------------------

Deno.test("inspect: DER files are converted to PEM first", async () => {
  const d = await tempDir();
  try {
    await Deno.writeFile(`${d}/c.der`, new Uint8Array([0x30, 0x82, 1, 2]));
    const { writes, calls } = await runMethod("inspect", {
      paths: [`${d}/c.der`],
    });
    const der = calls.find((c) => c.args.includes("-inform"))!;
    assertEquals(val(der.args, "-inform"), "DER");
    assertEquals(val(der.args, "-in"), `${d}/c.der`);
    const s = (writes.certificates.sources as {
      certificates: { subject: string }[];
    }[])[0];
    assertEquals(s.certificates[0].subject, "CN=der");
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("inspect: warnDays flags soon-expiring and expired certs", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/b.pem`, cert("soon") + cert("old"));
    const soon = new Date(Date.now() + 5 * 86_400_000).toUTCString()
      .replace(/^\w+, /, "");
    const { writes } = await runMethod(
      "inspect",
      { paths: [`${d}/b.pem`], warnDays: 10 },
      (c) => {
        if (c.args[0] !== "x509") return emulate(c);
        if (c.stdin.includes(btoa("soon"))) {
          return { stdout: x509Text(c.stdin, soon) };
        }
        return { stdout: x509Text(c.stdin, "Jan  1 00:00:00 2020 GMT") };
      },
    );
    assertEquals(writes.certificates.expiringSoon, [
      `${d}/b.pem#0`,
      `${d}/b.pem#1`,
    ]);
    const certs = (writes.certificates.sources as {
      certificates: { expired: boolean; daysLeft: number }[];
    }[])[0].certificates;
    assertEquals(certs[0].expired, false);
    assert(certs[0].daysLeft >= 4 && certs[0].daysLeft <= 5);
    assertEquals(certs[1].expired, true);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("inspect: one failing source does not fail the run", async () => {
  const { writes } = await runMethod("inspect", {
    paths: ["/nonexistent.pem"],
    hosts: ["ok.example"],
  });
  const sources = writes.certificates.sources as { ok: boolean }[];
  assertEquals(sources.map((s) => s.ok), [false, true]);
});

Deno.test("inspect: IPv6 targets and an explicit servername", async () => {
  const { calls } = await runMethod("inspect", {
    hosts: ["[::1]:8443"],
    servername: "sni.example",
  });
  const sc = calls.find((c) => c.args[0] === "s_client")!;
  assertEquals(val(sc.args, "-connect"), "[::1]:8443");
  assertEquals(val(sc.args, "-servername"), "sni.example");
});

Deno.test("inspect: s_client stderr is carried into the error", async () => {
  const { writes } = await runFailing(
    "inspect",
    { hosts: ["nx.invalid"] },
    (c) =>
      c.args[0] === "s_client"
        ? { code: 1, stderr: "BIO_lookup_ex:system lib" }
        : emulate(c),
  );
  const s = (writes.certificates.sources as { error: string }[])[0];
  assertEquals(s.error, "TLS handshake failed: BIO_lookup_ex:system lib");
});

// ---------------------------------------------------------------------------
// genkey key types
// ---------------------------------------------------------------------------

Deno.test("genkey: rsa and ed25519 argv", async () => {
  const d = await tempDir();
  try {
    const rsa = await runMethod("genkey", {
      path: `${d}/rsa.pem`,
      type: "rsa",
      bits: 4096,
    });
    assertEquals(rsa.calls[0].args.slice(0, 5), [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:4096",
    ]);
    const ed = await runMethod("genkey", {
      path: `${d}/ed.pem`,
      type: "ed25519",
    });
    assertEquals(ed.calls[0].args.slice(0, 3), [
      "genpkey",
      "-algorithm",
      "ED25519",
    ]);
    assertEquals(ed.writes.key.type, "ed25519");
    const ec = await runMethod("genkey", {
      path: `${d}/ec.pem`,
      curve: "secp384r1",
    });
    assert(ec.calls[0].args.includes("ec_paramgen_curve:secp384r1"));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// csr / selfsign / sign option branches
// ---------------------------------------------------------------------------

Deno.test("csr and selfsign pass key passphrases via env", async () => {
  const d = await tempDir();
  try {
    const csr = await runMethod("csr", {
      keyPath: `${d}/k`,
      path: `${d}/r.csr`,
      subject: { CN: "a" },
      keyPassword: "pw1",
    });
    const req = csr.calls.find((c) => c.args.includes("-new"))!;
    assertEquals(val(req.args, "-passin"), "env:OPENSSL_PASSIN");
    assertEquals(req.env, { OPENSSL_PASSIN: "pw1" });
    const ss = await runMethod("selfsign", {
      keyPath: `${d}/k`,
      path: `${d}/c.crt`,
      subject: { CN: "a" },
      keyPassword: "pw2",
    });
    const x = ss.calls.find((c) => c.args.includes("-x509"))!;
    assertEquals(x.env, { OPENSSL_PASSIN: "pw2" });
    const plain = await runMethod("selfsign", {
      keyPath: `${d}/k`,
      path: `${d}/p.crt`,
      subject: { CN: "a" },
    });
    const px = plain.calls.find((c) => c.args.includes("-x509"))!;
    assert(!px.args.includes("-passin"));
    assertEquals(px.env, {});
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("csr with ca=true requests CA extensions", async () => {
  const d = await tempDir();
  let cfg = "";
  try {
    await runMethod("csr", {
      keyPath: `${d}/k`,
      path: `${d}/r.csr`,
      subject: { CN: "Intermediate" },
      ca: true,
    }, (c) => {
      const p = val(c.args, "-config");
      if (p) cfg = Deno.readTextFileSync(p);
      return emulate(c);
    });
    assertStringIncludes(cfg, "CA:TRUE");
    assert(!cfg.includes("subjectAltName"));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("sign: explicit SANs override the CSR and skip reading it", async () => {
  const d = await tempDir();
  let ext = "";
  try {
    await Deno.writeTextFile(`${d}/ca.crt`, cert("root"));
    const { calls } = await runMethod("sign", {
      csrPath: `${d}/r.csr`,
      caCertPath: `${d}/ca.crt`,
      caKeyPath: `${d}/ca.key`,
      path: `${d}/i.crt`,
      sans: ["only.example"],
      ca: true,
      days: 30,
    }, (c) => {
      const p = val(c.args, "-extfile");
      if (p) ext = Deno.readTextFileSync(p);
      return emulate(c);
    });
    assertStringIncludes(ext, "DNS.1 = only.example");
    assert(!ext.includes("app.test"));
    assertStringIncludes(ext, "CA:TRUE");
    const x = calls.find((c) => c.args.includes("-req"))!;
    assertEquals(val(x.args, "-days"), "30");
    assert(
      !calls.some((c) => c.args[0] === "req" && c.args.includes("-text")),
    );
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("sign: a CSR without SANs yields a certificate without SANs", async () => {
  const d = await tempDir();
  let ext = "";
  try {
    await Deno.writeTextFile(`${d}/ca.crt`, cert("root"));
    await runMethod("sign", {
      csrPath: `${d}/r.csr`,
      caCertPath: `${d}/ca.crt`,
      caKeyPath: `${d}/ca.key`,
      path: `${d}/l.crt`,
    }, (c) => {
      const p = val(c.args, "-extfile");
      if (p) ext = Deno.readTextFileSync(p);
      if (c.args[0] === "req" && c.args.includes("-text")) {
        return { stdout: "Certificate Request:\n" };
      }
      return emulate(c);
    });
    assert(!ext.includes("subjectAltName"));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// verify branches
// ---------------------------------------------------------------------------

Deno.test("verify: system store with intermediates, DER input normalised", async () => {
  const d = await tempDir();
  try {
    await Deno.writeFile(`${d}/leaf.der`, new Uint8Array([0x30, 0x82]));
    const { calls, writes } = await runMethod("verify", {
      certPath: `${d}/leaf.der`,
      untrustedPath: `${d}/chain.pem`,
    });
    const v = calls.find((c) => c.args[0] === "verify")!;
    assert(!v.args.includes("-CAfile"));
    assertEquals(val(v.args, "-untrusted"), `${d}/chain.pem`);
    assertStringIncludes(v.args.at(-1)!, "leaf.pem");
    assertEquals(writes.verification.keyMatches, null);
    assertEquals(writes.verification.hostnameOk, null);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("verify: hostname mismatch and key mismatch are both reported", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/leaf.crt`, cert("leaf"));
    const { writes, err } = await runFailing("verify", {
      certPath: `${d}/leaf.crt`,
      keyPath: `${d}/other.key`,
      keyPassword: "kp",
      hostname: "other.example",
    }, (c) => {
      if (c.args.includes("-checkhost")) {
        return {
          stdout: "Hostname other.example does NOT match certificate\n",
        };
      }
      if (c.args[0] === "pkey" && !c.args.includes("-pubin")) {
        assertEquals(c.env, { OPENSSL_PASSIN: "kp" });
        return { stdout: PUB.replace("PUB", "OTHER") };
      }
      return emulate(c);
    });
    assertStringIncludes(err.message, "keyMatches=false hostnameOk=false");
    assertEquals(writes.verification.chainOk, true);
    assertEquals(writes.verification.valid, false);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// convert branches
// ---------------------------------------------------------------------------

Deno.test("convert: DER certificate to PEM uses x509 directly", async () => {
  const d = await tempDir();
  try {
    await Deno.writeFile(`${d}/c.der`, new Uint8Array([0x30, 0x82, 0]));
    const { calls } = await runMethod("convert", {
      inPath: `${d}/c.der`,
      outPath: `${d}/c.pem`,
      to: "pem",
    });
    assertEquals(calls.length, 1);
    assertEquals(val(calls[0].args, "-inform"), "DER");
    assertStringIncludes(await Deno.readTextFile(`${d}/c.pem`), "CERTIFICATE");
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("convert: PKCS#12 to PEM falls back from x509 and writes 0600", async () => {
  const d = await tempDir();
  try {
    await Deno.writeFile(`${d}/b.p12`, new Uint8Array([0x30, 0x82, 9]));
    const { calls, writes } = await runMethod("convert", {
      inPath: `${d}/b.p12`,
      outPath: `${d}/b.pem`,
      to: "pem",
    }, (c) => c.args.includes("-inform") ? { code: 1 } : emulate(c));
    const p12 = calls.find((c) => c.args[0] === "pkcs12")!;
    assert(p12.args.includes("-nodes"));
    assertEquals(p12.env, { OPENSSL_PASS: "" });
    assertEquals((await Deno.stat(`${d}/b.pem`)).mode! & 0o777, 0o600);
    assertStringIncludes(await Deno.readTextFile(`${d}/b.pem`), "PRIVATE KEY");
    assertEquals(writes.conversion.to, "pem");
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("convert: PEM + key + chain to PKCS#12", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/c.pem`, cert("leaf"));
    const { calls } = await runMethod("convert", {
      inPath: `${d}/c.pem`,
      outPath: `${d}/c.p12`,
      to: "p12",
      keyPath: `${d}/k.pem`,
      chainPath: `${d}/chain.pem`,
      name: "My Cert",
      password: "pw",
    });
    const a = calls[0].args;
    assert(a.includes("-export"));
    assertEquals(val(a, "-inkey"), `${d}/k.pem`);
    assertEquals(val(a, "-certfile"), `${d}/chain.pem`);
    assertEquals(val(a, "-name"), "My Cert");
    assertEquals(val(a, "-passout"), "env:OPENSSL_PASS");
    assertEquals(calls[0].env, { OPENSSL_PASS: "pw" });
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("convert: wrong-direction requests are refused before openssl", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/c.pem`, cert("leaf"));
    await Deno.writeFile(`${d}/c.der`, new Uint8Array([0x30]));
    const a = await runFailing("convert", {
      inPath: `${d}/c.pem`,
      outPath: `${d}/x.pem`,
      to: "pem",
    });
    assertStringIncludes(a.err.message, "already PEM");
    const b = await runFailing("convert", {
      inPath: `${d}/c.der`,
      outPath: `${d}/x.der`,
      to: "der",
    });
    assertStringIncludes(b.err.message, "is not PEM");
    assertEquals(a.calls.length + b.calls.length, 0);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});
