/**
 * Adversarial tests for @magistr/openssl: argv injection through paths and
 * host targets, openssl-config injection through subject/SAN values,
 * garbage or missing openssl output, wrong passwords and passwords leaking
 * into argv, and outputs clobbered without `overwrite`.
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

async function exists(p: string): Promise<boolean> {
  return await Deno.stat(p).then(() => true, () => false);
}

// ---------------------------------------------------------------------------
// argv injection: paths and hosts that look like options
// ---------------------------------------------------------------------------

Deno.test("every path argument rejects a leading '-'", () => {
  const cases: [MethodName, Record<string, unknown>][] = [
    ["inspect", { paths: ["-engine"] }],
    ["genkey", { path: "-out" }],
    ["csr", { keyPath: "-x", path: "/tmp/r", subject: { CN: "a" } }],
    ["csr", { keyPath: "/k", path: "-config", subject: { CN: "a" } }],
    ["selfsign", { keyPath: "/k", path: "-x", subject: { CN: "a" } }],
    ["sign", {
      csrPath: "-in",
      caCertPath: "/c",
      caKeyPath: "/k",
      path: "/o",
    }],
    ["sign", {
      csrPath: "/r",
      caCertPath: "/c",
      caKeyPath: "-passin",
      path: "/o",
    }],
    ["verify", { certPath: "/c", untrustedPath: "-trusted" }],
    ["convert", { inPath: "/a", outPath: "-out", to: "der" }],
    ["convert", { inPath: "/a", outPath: "/b", to: "p12", keyPath: "-k" }],
  ];
  for (const [name, args] of cases) {
    const r = model.methods[name].arguments.safeParse(args);
    assert(!r.success, `${name} accepted ${JSON.stringify(args)}`);
  }
});

Deno.test("hostile host targets fail per-source without running s_client", async () => {
  const { err, calls, writes } = await runFailing("inspect", {
    hosts: [
      "-proxy=evil:1",
      "a.com;rm -rf /",
      "a.com:99999",
      "$(id)",
      "a.com:80:80",
    ],
  });
  assertStringIncludes(err.message, "no source could be read");
  assertEquals(calls.filter((c) => c.args[0] === "s_client").length, 0);
  const sources = writes.certificates.sources as {
    ok: boolean;
    error: string;
  }[];
  assert(sources.every((s) => !s.ok && /invalid/.test(s.error)));
});

Deno.test("hostname for verify cannot carry spaces or options", () => {
  const p = model.methods.verify.arguments;
  assert(!p.safeParse({ certPath: "/c", hostname: "a b" }).success);
  assert(!p.safeParse({ certPath: "/c", hostname: "a;b" }).success);
  assert(p.safeParse({ certPath: "/c", hostname: "*.a.b" }).success);
});

// ---------------------------------------------------------------------------
// config injection: subject / SAN values
// ---------------------------------------------------------------------------

Deno.test("SANs with newlines, spaces, '=' or quotes are rejected", () => {
  const p = model.methods.csr.arguments;
  const base = { keyPath: "/k", path: "/r", subject: { CN: "a" } };
  for (const san of ["a.com\nDNS.9 = evil", "a b", "a=b", 'a"b', "a\rb"]) {
    assert(!p.safeParse({ ...base, sans: [san] }).success, san);
  }
});

Deno.test("subject newline cannot inject config sections; openssl never runs", async () => {
  const d = await tempDir();
  try {
    const { err, calls } = await runFailing("csr", {
      keyPath: `${d}/k`,
      path: `${d}/r.csr`,
      subject: { CN: "a\n[ext]\nbasicConstraints = CA:TRUE" },
    });
    assertStringIncludes(err.message, "newlines");
    assertEquals(calls.length, 0);
    assert(!await exists(`${d}/r.csr`));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("subject '$' and '\\' are escaped so openssl cannot expand them", async () => {
  const d = await tempDir();
  let cfg = "";
  try {
    await runMethod("selfsign", {
      keyPath: `${d}/k`,
      path: `${d}/c.crt`,
      subject: { CN: "${ENV::HOME}", O: "a\\b = c" },
    }, (c) => {
      const p = val(c.args, "-config");
      if (p) cfg = Deno.readTextFileSync(p);
      return emulate(c);
    });
    assertStringIncludes(cfg, "CN = \\${ENV::HOME}");
    assertStringIncludes(cfg, "O = a\\\\b = c");
    assert(!/[^\\]\$\{/.test(cfg));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// garbage / missing openssl output
// ---------------------------------------------------------------------------

Deno.test("garbage x509 output marks the source failed, not the run", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/a.pem`, cert("a"));
    await Deno.writeTextFile(`${d}/b.pem`, cert("b"));
    const { writes } = await runMethod(
      "inspect",
      { paths: [`${d}/a.pem`, `${d}/b.pem`] },
      (c) =>
        c.args[0] === "x509" && c.stdin.includes(btoa("b"))
          ? { stdout: "notAfter=not a date\nnotBefore=garbage\n" }
          : emulate(c),
    );
    const sources = writes.certificates.sources as {
      ok: boolean;
      error?: string;
    }[];
    assertEquals(sources[0].ok, true);
    assertEquals(sources[1].ok, false);
    assertStringIncludes(sources[1].error!, "unparseable openssl date");
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("s_client timeout with no certificates reports a handshake failure", async () => {
  const { err, writes } = await runFailing(
    "inspect",
    { hosts: ["slow.example"], timeoutSeconds: 1 },
    (c) => c.args[0] === "s_client" ? { code: 143 } : emulate(c),
  );
  assertStringIncludes(err.message, "TLS handshake failed: timeout");
  const s = (writes.certificates.sources as { error: string }[])[0];
  assertEquals(s.error, "TLS handshake failed: timeout");
});

Deno.test("a file with neither PEM nor parsable DER has no certificates", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/junk.bin`, "\x00\x01junk");
    const { err } = await runFailing(
      "inspect",
      { paths: [`${d}/junk.bin`] },
      (c) =>
        c.args.includes("-inform")
          ? { code: 1, stderr: "Could not read certificate" }
          : emulate(c),
    );
    assertStringIncludes(err.message, "Could not read certificate");
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// passwords
// ---------------------------------------------------------------------------

Deno.test("a wrong PKCS#12 password leaves no output and never hits argv", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/in.p12`, "\x30\x82binary");
    const { err, calls } = await runFailing(
      "convert",
      {
        inPath: `${d}/in.p12`,
        outPath: `${d}/out.pem`,
        to: "pem",
        password: "hunter2",
      },
      (c) => {
        if (c.args.includes("-inform")) return { code: 1 };
        if (c.args[0] === "pkcs12") {
          return { code: 1, stderr: "Mac verify error: invalid password?" };
        }
        return emulate(c);
      },
    );
    assertStringIncludes(err.message, "invalid password");
    assert(!await exists(`${d}/out.pem`));
    for (const c of calls) assert(!c.args.join(" ").includes("hunter2"));
    const p12 = calls.find((c) => c.args[0] === "pkcs12")!;
    assertEquals(p12.env, { OPENSSL_PASS: "hunter2" });
    assertEquals(val(p12.args, "-passin"), "env:OPENSSL_PASS");
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("a CA key passphrase travels via env, not argv", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/ca.crt`, cert("root"));
    const { calls } = await runMethod("sign", {
      csrPath: `${d}/r.csr`,
      caCertPath: `${d}/ca.crt`,
      caKeyPath: `${d}/ca.key`,
      path: `${d}/leaf.crt`,
      caKeyPassword: "s3cr3t",
    });
    const x = calls.find((c) => c.args.includes("-req"))!;
    assertEquals(val(x.args, "-passin"), "env:OPENSSL_PASSIN");
    assertEquals(x.env, { OPENSSL_PASSIN: "s3cr3t" });
    for (const c of calls) assert(!c.args.includes("s3cr3t"));
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// overwrite=false never clobbers
// ---------------------------------------------------------------------------

Deno.test("existing outputs are never rewritten without overwrite", async () => {
  const d = await tempDir();
  try {
    const sentinel = cert("existing");
    const paths = ["k.pem", "r.csr", "c.crt", "l.crt", "o.der"];
    for (const p of paths) await Deno.writeTextFile(`${d}/${p}`, sentinel);
    await Deno.writeTextFile(`${d}/ca.crt`, cert("root"));
    const writers = (c: Call) =>
      ["genpkey", "pkcs12"].includes(c.args[0]) ||
      c.args.includes("-new") || c.args.includes("-req") ||
      c.args.includes("-outform");

    const runs: [MethodName, Record<string, unknown>, string][] = [
      ["genkey", { path: `${d}/k.pem` }, "key"],
      ["csr", {
        keyPath: `${d}/k.pem`,
        path: `${d}/r.csr`,
        subject: { CN: "a" },
      }, "csr"],
      ["selfsign", {
        keyPath: `${d}/k.pem`,
        path: `${d}/c.crt`,
        subject: { CN: "a" },
      }, "certificate"],
      ["sign", {
        csrPath: `${d}/r.csr`,
        caCertPath: `${d}/ca.crt`,
        caKeyPath: `${d}/k.pem`,
        path: `${d}/l.crt`,
      }, "certificate"],
      ["convert", {
        inPath: `${d}/c.crt`,
        outPath: `${d}/o.der`,
        to: "der",
      }, "conversion"],
    ];
    for (const [name, args, spec] of runs) {
      const { calls, writes } = await runMethod(name, args);
      assertEquals(calls.filter(writers).length, 0, `${name} wrote`);
      assertEquals(writes[spec].changed, false, name);
    }
    for (const p of paths) {
      assertEquals(await Deno.readTextFile(`${d}/${p}`), sentinel, p);
    }
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

Deno.test("genkey never exposes a world-readable key, even on overwrite", async () => {
  const d = await tempDir();
  try {
    await Deno.writeTextFile(`${d}/k.pem`, "old", { mode: 0o644 });
    await Deno.chmod(`${d}/k.pem`, 0o644);
    await runMethod("genkey", { path: `${d}/k.pem`, overwrite: true });
    assertEquals((await Deno.stat(`${d}/k.pem`)).mode! & 0o777, 0o600);
    assertEquals(await Deno.readTextFile(`${d}/k.pem`), KEY);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});
