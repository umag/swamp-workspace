// RED tests for verifier.ts additions: injectable hello port, core-vs-config
// namespace report, and a TLS warning now that the control plane (token
// secrets) rides the same connection.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { ConfigSchema, type MongoDatastoreConfig } from "./config.ts";
import { createVerifier as createVerifierTyped } from "./verifier.ts";
import { fakeClientFactory } from "./test_fakes.ts";

interface Hello {
  ok?: number;
  setName?: string;
  isWritablePrimary?: boolean;
  primary?: string;
}
interface VerifierDeps {
  hello?: () => Promise<Hello>;
  coreNamespace?: () => string | undefined;
}
interface HealthResult {
  healthy: boolean;
  message: string;
  details?: Record<string, string>;
}
type CreateVerifier = (
  cfg: MongoDatastoreConfig,
  getClient: ReturnType<typeof fakeClientFactory>["getClient"],
  repoDir: string,
  deps?: VerifierDeps,
) => { verify(): Promise<HealthResult> };

const createVerifier = createVerifierTyped as unknown as CreateVerifier;

function cfg(uri: string): MongoDatastoreConfig {
  return ConfigSchema.parse({
    uri,
    username: "swamp",
    namespace: "dev-tmp-swamp",
  });
}

const primary = () =>
  Promise.resolve({ ok: 1, setName: "rs0", isWritablePrimary: true });

Deno.test("verifier: reports config namespace and the core namespace seen by sync", async () => {
  const { getClient } = fakeClientFactory();
  const v = createVerifier(
    cfg("mongodb://127.0.0.1:27017/?replicaSet=rs0"),
    getClient,
    "/repo",
    {
      hello: primary,
      coreNamespace: () => "dev-tmp-swamp",
    },
  );
  const r = await v.verify();
  assertEquals(r.healthy, true);
  assertEquals(r.details?.configNamespace, "dev-tmp-swamp");
  assertEquals(r.details?.coreNamespace, "dev-tmp-swamp");
});

Deno.test("verifier: core namespace is omitted before the first sync (S3 reference reports none)", async () => {
  const { getClient } = fakeClientFactory();
  const v = createVerifier(
    cfg("mongodb://127.0.0.1:27017/"),
    getClient,
    "/repo",
    {
      hello: primary,
      coreNamespace: () => undefined,
    },
  );
  const r = await v.verify();
  assertEquals(r.details?.coreNamespace, undefined);
  assertEquals(r.details?.configNamespace, "dev-tmp-swamp");
});

Deno.test("verifier: warns on a plaintext URI to a non-loopback host", async () => {
  const { getClient } = fakeClientFactory();
  const v = createVerifier(
    cfg("mongodb://mongo.aopab.art:27017/?replicaSet=rs0&authSource=admin"),
    getClient,
    "/repo",
    {
      hello: primary,
    },
  );
  const r = await v.verify();
  assertEquals(r.healthy, true);
  assert(r.details?.tlsWarning !== undefined, "expected details.tlsWarning");
  assertStringIncludes(r.message, "TLS");
});

Deno.test("verifier: warns on directConnection to a LAN IP (serve's current config)", async () => {
  const { getClient } = fakeClientFactory();
  const v = createVerifier(
    cfg(
      "mongodb://192.168.88.242:27017/?directConnection=true&authSource=admin",
    ),
    getClient,
    "/repo",
    {
      hello: primary,
    },
  );
  const r = await v.verify();
  assert(r.details?.tlsWarning !== undefined);
});

Deno.test("verifier: no warning for loopback, tls=true, or mongodb+srv", async () => {
  const { getClient } = fakeClientFactory();
  for (
    const uri of [
      "mongodb://127.0.0.1:27017/?replicaSet=rs0",
      "mongodb://localhost:27017/",
      "mongodb://[::1]:27017/",
      "mongodb://mongo.aopab.art:27017/?tls=true",
      "mongodb://mongo.aopab.art:27017/?ssl=true",
      "mongodb+srv://cluster.example.net/admin",
    ]
  ) {
    const r = await createVerifier(cfg(uri), getClient, "/repo", {
      hello: primary,
    }).verify();
    assertEquals(r.details?.tlsWarning, undefined, uri);
  }
});

Deno.test("verifier: mongodb+srv with tls=false still warns", async () => {
  const { getClient } = fakeClientFactory();
  const r = await createVerifier(
    cfg("mongodb+srv://cluster.example.net/admin?tls=false"),
    getClient,
    "/repo",
    { hello: primary },
  ).verify();
  assert(r.details?.tlsWarning !== undefined);
});

Deno.test("verifier: a mixed host list warns when any host is non-loopback and plaintext", async () => {
  const { getClient } = fakeClientFactory();
  const r = await createVerifier(
    cfg("mongodb://127.0.0.1:27017,10.0.0.5:27017/?replicaSet=rs0"),
    getClient,
    "/repo",
    { hello: primary },
  ).verify();
  assert(r.details?.tlsWarning !== undefined);
});

Deno.test("verifier: unhealthy results are unchanged by the new fields", async () => {
  const { getClient } = fakeClientFactory();
  const r = await createVerifier(
    cfg("mongodb://127.0.0.1:27017/"),
    getClient,
    "/repo",
    {
      hello: () =>
        Promise.resolve({
          ok: 1,
          setName: "rs0",
          isWritablePrimary: false,
          primary: "other:27017",
        }),
    },
  ).verify();
  assertEquals(r.healthy, false);
  assertStringIncludes(r.message, "not the primary");
});
