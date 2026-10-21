/**
 * Tests for @magistr/openssl — pure helpers, plus a full PKI round trip
 * (CA → key → CSR → sign → verify → convert) against the real openssl CLI
 * in a temp dir. The round trip is skipped when openssl is not on PATH.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  buildConfig,
  model,
  parseTarget,
  parseX509,
  sanEntry,
  splitPemCertificates,
} from "./openssl.ts";

Deno.test("parseTarget handles host, host:port and [v6]:port", () => {
  assertEquals(parseTarget("example.com"), { host: "example.com", port: 443 });
  assertEquals(parseTarget("a.b:8443"), { host: "a.b", port: 8443 });
  assertEquals(parseTarget("[::1]:9000"), { host: "::1", port: 9000 });
  assertThrows(() => parseTarget("-connect"));
  assertThrows(() => parseTarget("a:70000"));
});

Deno.test("sanEntry classifies SANs", () => {
  assertEquals(sanEntry("*.example.com"), {
    type: "DNS",
    value: "*.example.com",
  });
  assertEquals(sanEntry("10.0.0.1").type, "IP");
  assertEquals(sanEntry("fe80::1").type, "IP");
  assertEquals(sanEntry("a@b.c").type, "email");
  assertEquals(sanEntry("spiffe://x/y").type, "URI");
  assertEquals(sanEntry("DNS:10.0.0.1"), { type: "DNS", value: "10.0.0.1" });
});

Deno.test("buildConfig escapes values and numbers SANs per type", () => {
  const cfg = buildConfig({
    subject: { CN: "a$b", O: "x\\y" },
    sans: ["a.com", "b.com", "1.2.3.4"],
    ca: false,
    target: "csr",
  });
  assertStringIncludes(cfg, "req_extensions = ext");
  assertStringIncludes(cfg, "CN = a\\$b");
  assertStringIncludes(cfg, "O = x\\\\y");
  assertStringIncludes(cfg, "DNS.2 = b.com");
  assertStringIncludes(cfg, "IP.1 = 1.2.3.4");
  assert(!cfg.includes("subjectKeyIdentifier"));
  assertThrows(() =>
    buildConfig({ subject: { CN: "a\nb" }, sans: [], ca: true, target: "x509" })
  );
});

Deno.test("parseX509 reads the fields openssl prints", () => {
  const out = [
    "subject=CN=leaf,O=Acme",
    "issuer=CN=root",
    "serial=0A",
    "notBefore=Jan  1 00:00:00 2026 GMT",
    "notAfter=Jan 11 00:00:00 2026 GMT",
    "sha256 Fingerprint=AB:CD",
    "        Signature Algorithm: ecdsa-with-SHA256",
    "            Public Key Algorithm: id-ecPublicKey",
    "                Public-Key: (256 bit)",
    "            X509v3 Basic Constraints: critical",
    "                CA:FALSE",
    "            X509v3 Subject Alternative Name: ",
    "                DNS:a.com, IP Address:1.2.3.4",
  ].join("\n");
  const c = parseX509(out, new Date("2026-01-01T00:00:00Z"));
  assertEquals(c.subject, "CN=leaf,O=Acme");
  assertEquals(c.daysLeft, 10);
  assertEquals(c.expired, false);
  assertEquals(c.isCA, false);
  assertEquals(c.selfSigned, false);
  assertEquals(c.sans, ["DNS:a.com", "IP:1.2.3.4"]);
  assertEquals(c.keyBits, 256);
  assertEquals(c.sha256, "AB:CD");
});

Deno.test("splitPemCertificates returns every block", () => {
  const b = "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----";
  assertEquals(splitPemCertificates(`x\n${b}\ny\n${b}`).length, 2);
  assertEquals(splitPemCertificates("nothing"), []);
});

Deno.test("inspect requires at least one source", () => {
  assert(!model.methods.inspect.arguments.safeParse({}).success);
});

// ---------------------------------------------------------------------------
// Real openssl round trip
// ---------------------------------------------------------------------------

const hasOpenssl = await new Deno.Command("openssl", { args: ["version"] })
  .output().then((o) => o.success, () => false);

function fakeContext() {
  const writes: Record<string, Record<string, unknown>> = {};
  return {
    writes,
    ctx: {
      globalArgs: model.globalArguments.parse({}),
      writeResource: (
        spec: string,
        _n: string,
        data: Record<string, unknown>,
      ) => {
        writes[spec] = structuredClone(data);
        return Promise.resolve({});
      },
    },
  };
}

Deno.test({
  name: "PKI round trip: CA, leaf, verify, convert",
  ignore: !hasOpenssl,
  fn: async () => {
    const d = await Deno.makeTempDir();
    const { ctx, writes } = fakeContext();
    const m = model.methods;
    const call = (name: keyof typeof m, args: Record<string, unknown>) =>
      m[name].execute(m[name].arguments.parse(args), ctx);
    try {
      await call("genkey", { path: `${d}/ca.key`, type: "ec" });
      assertEquals((await Deno.stat(`${d}/ca.key`)).mode! & 0o777, 0o600);
      const caPub = writes.key.publicKeySha256;
      await call("genkey", { path: `${d}/ca.key` });
      assertEquals(writes.key.changed, false);
      assertEquals(writes.key.publicKeySha256, caPub);

      await call("selfsign", {
        keyPath: `${d}/ca.key`,
        path: `${d}/ca.crt`,
        subject: { CN: "Test Root", O: "Swamp" },
        ca: true,
        days: 30,
      });
      const ca = writes.certificate.certificate as Record<string, unknown>;
      assertEquals(ca.isCA, true);
      assertEquals(ca.selfSigned, true);

      await call("genkey", { path: `${d}/leaf.key`, type: "rsa", bits: 2048 });
      await call("csr", {
        keyPath: `${d}/leaf.key`,
        path: `${d}/leaf.csr`,
        subject: { CN: "app.test" },
        sans: ["app.test", "*.app.test", "10.1.2.3"],
      });
      assertEquals(writes.csr.sans, [
        "DNS:app.test",
        "DNS:*.app.test",
        "IP:10.1.2.3",
      ]);

      await call("sign", {
        csrPath: `${d}/leaf.csr`,
        caCertPath: `${d}/ca.crt`,
        caKeyPath: `${d}/ca.key`,
        path: `${d}/leaf.crt`,
      });
      const leaf = writes.certificate.certificate as Record<string, unknown>;
      assertEquals(writes.certificate.issuedBy, "O=Swamp,CN=Test Root");
      assertEquals(leaf.sans, [
        "DNS:app.test",
        "DNS:*.app.test",
        "IP:10.1.2.3",
      ]);
      assertEquals(leaf.isCA, false);

      await call("verify", {
        certPath: `${d}/leaf.crt`,
        caPath: `${d}/ca.crt`,
        keyPath: `${d}/leaf.key`,
        hostname: "x.app.test",
      });
      assertEquals(writes.verification.valid, true);

      await assertRejects(() =>
        call("verify", {
          certPath: `${d}/leaf.crt`,
          caPath: `${d}/ca.crt`,
          keyPath: `${d}/ca.key`,
        })
      );
      assertEquals(writes.verification.keyMatches, false);

      await call("convert", {
        inPath: `${d}/leaf.crt`,
        outPath: `${d}/leaf.der`,
        to: "der",
      });
      await call("inspect", { paths: [`${d}/leaf.der`, `${d}/ca.crt`] });
      const sources = writes.certificates.sources as { ok: boolean }[];
      assert(sources.every((s) => s.ok));
      assertEquals(writes.certificates.expiringSoon, [`${d}/ca.crt#0`]);

      await call("convert", {
        inPath: `${d}/leaf.crt`,
        keyPath: `${d}/leaf.key`,
        outPath: `${d}/leaf.p12`,
        to: "p12",
        password: "s3cret",
      });
      await call("convert", {
        inPath: `${d}/leaf.p12`,
        outPath: `${d}/back.pem`,
        to: "pem",
        password: "s3cret",
      });
      const back = await Deno.readTextFile(`${d}/back.pem`);
      assertStringIncludes(back, "BEGIN CERTIFICATE");
      assertStringIncludes(back, "PRIVATE KEY");
      await assertRejects(() =>
        call("convert", {
          inPath: `${d}/leaf.p12`,
          outPath: `${d}/bad.pem`,
          to: "pem",
          password: "wrong",
        })
      );
      assert(!(await Deno.stat(`${d}/bad.pem`).then(() => true, () => false)));
    } finally {
      await Deno.remove(d, { recursive: true });
    }
  },
});
