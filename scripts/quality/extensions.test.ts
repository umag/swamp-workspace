/**
 * Tests for the shared ExtensionSet discovery module. The critical test
 * (parity with ci.yml's discover job) reproduces the EXACT bash glob the
 * workflow uses over the real repo tree, so the two definitions of "what is
 * an extension" cannot silently diverge.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { listExtensions } from "./extensions.ts";

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");

async function makeTempExtensionTree(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "quality-ext-discover-" });
  await Deno.mkdir(join(root, "alpha"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "alpha", "manifest.yaml"),
    "name: alpha\n",
  );
  await Deno.mkdir(join(root, "beta"), { recursive: true });
  await Deno.writeTextFile(join(root, "beta", "manifest.yaml"), "name: beta\n");
  // Not an extension: no manifest.yaml.
  await Deno.mkdir(join(root, "not-an-extension"), { recursive: true });
  await Deno.writeTextFile(join(root, "not-an-extension", "README.md"), "hi\n");
  // A dotdir with a manifest.yaml must be excluded — bash's `*/manifest.yaml`
  // glob does not match dot-directories by default, and the shared module
  // must mirror that exactly.
  await Deno.mkdir(join(root, ".hidden"), { recursive: true });
  await Deno.writeTextFile(
    join(root, ".hidden", "manifest.yaml"),
    "name: hidden\n",
  );
  // A stray top-level file (not a directory) named manifest.yaml-ish must not
  // be treated as an extension either.
  await Deno.writeTextFile(join(root, "manifest.yaml"), "name: root-level\n");
  return root;
}

Deno.test("listExtensions finds every dir with a manifest.yaml, sorted", async () => {
  const root = await makeTempExtensionTree();
  try {
    const result = await listExtensions({ root });
    assertEquals(result, ["alpha", "beta"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("listExtensions excludes dot-directories, matching the bash glob", async () => {
  const root = await makeTempExtensionTree();
  try {
    const result = await listExtensions({ root });
    assertEquals(result.includes(".hidden"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("listExtensions matches ci.yml's discover-job glob over the REAL repo tree", async () => {
  // REPO_ROOT is derived from import.meta.url (this test file's own location
  // on disk) — a trusted, code-computed constant, never external/user input.
  // Do NOT copy this string-interpolation-into-bash shape for any path that
  // originates outside the source tree; production code (check_compliance.ts
  // et al.) must use Deno.Command array args exclusively.
  const cmd = new Deno.Command("bash", {
    args: [
      "-c",
      `cd '${REPO_ROOT}' && for m in */manifest.yaml; do [ -f "$m" ] && dirname "$m"; done | sort -u`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  assertEquals(success, true, new TextDecoder().decode(stderr));
  const glob = new TextDecoder().decode(stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  const discovered = await listExtensions({ root: REPO_ROOT });
  assertEquals(discovered, glob);
});
