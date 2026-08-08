import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  classify,
  type Declared,
  drifted,
  type DriftRow,
  formatReport,
  parseArgs,
  parseManifest,
  publishedOn,
  type RegistryVersions,
  resolveChannel,
} from "./registry_drift.ts";

const decl = (over: Partial<Declared> = {}): Declared => ({
  dir: "musicbrainz",
  name: "@magistr/musicbrainz",
  version: "2026.08.07.1",
  channel: "stable",
  ...over,
});

const reg = (over: Partial<RegistryVersions> = {}): RegistryVersions => ({
  stable: null,
  beta: null,
  rc: null,
  ...over,
});

Deno.test("parseManifest reads a quoted name and version", () => {
  const got = parseManifest(
    'manifestVersion: 1\nname: "@magistr/musicbrainz"\nversion: "2026.08.07.1"\n',
  );
  assertEquals(got, { name: "@magistr/musicbrainz", version: "2026.08.07.1" });
});

Deno.test("parseManifest reads unquoted values", () => {
  const got = parseManifest("name: @magistr/gonic\nversion: 2026.08.02.1\n");
  assertEquals(got, { name: "@magistr/gonic", version: "2026.08.02.1" });
});

Deno.test("parseManifest takes the FIRST version, not a nested one", () => {
  // A `version:` nested under models/upgrades is indented, so it must not win
  // over the top-level key — the top-level one is what gets published.
  const got = parseManifest(
    'name: "@magistr/x"\nversion: "2026.01.01.1"\nmodels:\n  version: "1999.01.01.1"\n',
  );
  assertEquals(got?.version, "2026.01.01.1");
});

Deno.test("parseManifest ignores indented keys entirely", () => {
  // Only top-level (column-0) keys count. An indented `name:`/`version:` pair
  // with no top-level one is not a publishable manifest.
  assertEquals(parseManifest('  name: "@x/y"\n  version: "1.0.0"\n'), null);
});

Deno.test("parseManifest returns null when a key is missing", () => {
  assertEquals(parseManifest('name: "@magistr/x"\n'), null);
  assertEquals(parseManifest('version: "2026.01.01.1"\n'), null);
});

Deno.test("parseManifest returns null for a version line carrying a trailing comment (mutation: restore the loose unquote -> reddens; a loose unquote returns the whole string, quotes and comment included, which then selects a manifest nobody bumped and asks the extractor for a heading nothing declares)", () => {
  const got = parseManifest(
    'name: "@magistr/x"\nversion: "2026.08.08.1"  # bumped for the chain repair\n',
  );
  assertEquals(got, null);
});

Deno.test("parseManifest reads a single-quoted version (mutation: leave unquote double-quote-only -> reddens; a pure requoting of a scalar is a no-op in YAML but would make the two ends of the selector disagree about the value)", () => {
  const got = parseManifest(
    "name: \"@magistr/x\"\nversion: '2026.08.02.1'\n",
  );
  assertEquals(got?.version, "2026.08.02.1");
});

Deno.test("resolveChannel defaults to stable when the file is absent", () => {
  assertEquals(resolveChannel(null), "stable");
});

Deno.test("resolveChannel trims trailing newline", () => {
  assertEquals(resolveChannel("beta\n"), "beta");
  assertEquals(resolveChannel("  rc  "), "rc");
});

Deno.test("resolveChannel THROWS on an unrecognised value", () => {
  // Must not silently fall back to stable: that would compare a beta package
  // against the stable channel forever and report permanent false drift.
  assertThrows(
    () => resolveChannel("betaa"),
    Error,
    "stable | beta | rc",
  );
});

Deno.test("publishedOn selects the channel's version, not just stable", () => {
  const v = reg({ stable: "1.0.0", beta: "2.0.0", rc: "3.0.0" });
  assertEquals(publishedOn(v, "stable"), "1.0.0");
  assertEquals(publishedOn(v, "beta"), "2.0.0");
  assertEquals(publishedOn(v, "rc"), "3.0.0");
});

Deno.test("classify: matching version on the declared channel is in-sync", () => {
  const row = classify(decl(), reg({ stable: "2026.08.07.1" }));
  assertEquals(row.status, "in-sync");
  assertEquals(row.published, "2026.08.07.1");
});

Deno.test("classify: older registry version is behind", () => {
  const row = classify(decl(), reg({ stable: "2026.08.05.2" }));
  assertEquals(row.status, "behind");
  assertEquals(row.published, "2026.08.05.2");
});

Deno.test("classify: package absent from the registry is absent", () => {
  assertEquals(classify(decl(), null).status, "absent");
});

Deno.test("classify: package present but empty on its channel is absent", () => {
  const row = classify(decl({ channel: "beta" }), reg({ stable: "9.9.9.9" }));
  assertEquals(row.status, "absent");
  assertEquals(row.published, null);
});

Deno.test("classify: a beta package matching on beta is in-sync", () => {
  // THE REGRESSION THIS PINS. Reading `latestVersion` (stable) for a package
  // that publishes to beta reports it as never-published. stripe-mpp looked
  // exactly like that during the 2026-08-07 sweep, and the misreading nearly
  // produced a wrong backfill.
  const row = classify(
    decl({ dir: "stripe-mpp", name: "@magistr/stripe-mpp", channel: "beta" }),
    reg({ stable: null, beta: "2026.08.07.1" }),
  );
  assertEquals(row.status, "in-sync");
});

Deno.test("classify: a beta package is NOT satisfied by a stable release", () => {
  const row = classify(
    decl({ channel: "beta" }),
    reg({ stable: "2026.08.07.1", beta: "2026.07.21.2" }),
  );
  assertEquals(row.status, "behind");
  assertEquals(row.published, "2026.07.21.2");
});

Deno.test("drifted returns only non-in-sync rows", () => {
  const rows: DriftRow[] = [
    classify(decl({ dir: "a" }), reg({ stable: "2026.08.07.1" })),
    classify(decl({ dir: "b" }), reg({ stable: "2026.08.05.2" })),
    classify(decl({ dir: "c" }), null),
  ];
  assertEquals(drifted(rows).map((r) => r.dir), ["b", "c"]);
});

Deno.test("formatReport counts in-sync and drifted separately", () => {
  const rows: DriftRow[] = [
    classify(decl({ dir: "a" }), reg({ stable: "2026.08.07.1" })),
    classify(decl({ dir: "b" }), reg({ stable: "2026.08.05.2" })),
  ];
  const out = formatReport(rows);
  assertEquals(
    out.includes("Checked 2 extension(s): 1 in sync, 1 drifted."),
    true,
  );
});

Deno.test("formatReport names the drifted package and both versions", () => {
  const out = formatReport([
    classify(decl(), reg({ stable: "2026.08.05.2" })),
  ]);
  assertEquals(out.includes("@magistr/musicbrainz"), true);
  assertEquals(out.includes("declares 2026.08.07.1"), true);
  assertEquals(out.includes("registry has 2026.08.05.2"), true);
});

Deno.test("formatReport says which CHANNEL is empty when nothing is published", () => {
  const out = formatReport([classify(decl({ channel: "beta" }), null)]);
  assertEquals(out.includes("nothing published on 'beta'"), true);
});

Deno.test("formatReport omits the drift block entirely when all in sync", () => {
  const out = formatReport([
    classify(decl(), reg({ stable: "2026.08.07.1" })),
  ]);
  assertEquals(out.includes("Drifted"), false);
});

Deno.test("parseArgs defaults root to the working directory", () => {
  assertEquals(parseArgs([]), { root: "." });
  assertEquals(parseArgs(["--root", "/repo"]), { root: "/repo" });
});
