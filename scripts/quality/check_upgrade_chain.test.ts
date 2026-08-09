/**
 * Tests for scripts/quality/check_upgrade_chain.ts — DOES NOT EXIST YET on
 * this branch. This is the RED half of plan v4 PR B step 7(b): the POLICY,
 * built on top of scripts/quality/model_declarations.ts's parser (tested
 * separately in model_declarations.test.ts). Every test below is expected
 * to fail with a module-resolution error until step 7 lands.
 *
 * THE RULE, from swamp's own push-time error text: for every MODEL
 * DECLARATION in every manifest-listed model file, if the declaration has a
 * NON-EMPTY literal `upgrades[]`, the LAST entry's `toVersion` must equal
 * that declaration's `version`. Per DECLARATION, not per file — a file with
 * N declarations produces N independent verdicts.
 *
 * DISCOVERY IS MANIFEST-DRIVEN, not glob-driven: `listExtensions()` gives
 * the extension set, and each extension's manifest.yaml `models:` list
 * gives exactly the files to scan — NOT a glob over
 * `<ext>/extensions/models/*.ts`, which in the real tree over-collects by
 * exactly one file (telegram-import's *_test_helpers.ts, shipped by no
 * manifest).
 *
 * FIVE FAIL-CLOSED RULES so no single parse error can produce a silent
 * pass, plus three policy verdicts built on a resolved literal chain — this
 * suite asserts the exact RULE NAME for each of the eight, per this task's
 * instruction: several of these are only distinguishable by name.
 *   model-source-unlexable        maskCode returned an error
 *   model-declaration-unreadable  a listed file yielded ZERO declarations
 *                                 carrying a version key
 *   model-version-unreadable      >1 depth-1 version key, or a malformed
 *                                 value
 *   model-declaration-indirect    the declaration itself carries a depth-1
 *                                 object SPREAD (ANY depth-1 spread — see
 *                                 the AMENDMENT below, not `...IDENT` only)
 *   upgrade-chain-unreadable      raw span matches
 *                                 `(^|[\s,{])["']?upgrades["']?\s*:` but the
 *                                 parser resolved no upgrades property — the
 *                                 belt-and-braces cross-check for a mask bug
 *   upgrade-chain-terminus        a literal chain's last toVersion !=
 *                                 version
 *   upgrade-chain-indirect        upgrades is present but not a readable
 *                                 array literal (identifier/call/member/
 *                                 spread-element)
 *   upgrade-chain-unparseable     a literal array with an unreadable
 *                                 element
 *
 * THREE THINGS THE GATE MUST DELIBERATELY NOT DO, each pinned below: it
 * must NOT require a chain to exist (28 of 59 real declarations have none);
 * it must NOT require the chain to be contiguous (swamp accepts a gapped
 * one); it must NOT re-check manifest-vs-model version parity (ci.yml:187-
 * 210 owns that).
 *
 * AMENDMENT, binding, agreed after plan v4 approval (see
 * scratchpad/cipg-implement.yaml): rule 5 (model-declaration-indirect) is
 * ANY depth-1 spread element, not `...IDENT` only. TWO required fixtures
 * (`{ ...CHAIN_BASE }` and `{ ...(LEGACY ? LEGACY_BASE : CHAIN_BASE) }`),
 * each asserting the rule NAME here — this is the file that owns rule
 * names, unlike model_declarations.test.ts's parser-level
 * `hasDepth1Spread` boolean, which the amendment's two fixtures ALSO cover
 * there at the parser level. The mutation "narrow the spread match back to
 * `...IDENT`" must redden the SECOND (conditional-expression) fixture here.
 *
 * Fixtures are built as small synthetic manifest trees in
 * `Deno.makeTempDir()`, exactly like check_property_harness.test.ts /
 * check_soak.test.ts. The REALITY PIN (asserting zero violations against
 * the real repo root) follows scripts/quality/extensions.test.ts's
 * precedent for depending on real tree state, and is written as "zero"
 * per plan v4 step 7's own instruction: this pin is meant to land together
 * with step 9's seanime repair, in the SAME PR B commit.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { checkUpgradeChain } from "./check_upgrade_chain.ts";
import { listExtensions } from "./extensions.ts";

// ============================================================================
// Fixture helpers
// ============================================================================

/** Writes one extension: a manifest.yaml whose `models:` list names exactly
 * the given relative paths, plus each file's content. `extraFiles` (if any)
 * are written to disk but deliberately NOT listed in the manifest, so tests
 * can prove discovery is manifest-driven rather than glob-driven. */
async function writeExtension(
  root: string,
  ext: string,
  modelFiles: Record<string, string>,
  extraFiles: Record<string, string> = {},
): Promise<void> {
  const modelsList = Object.keys(modelFiles).map((p) => `  - ${p}`).join(
    "\n",
  );
  await Deno.mkdir(join(root, ext), { recursive: true });
  await Deno.writeTextFile(
    join(root, ext, "manifest.yaml"),
    `manifestVersion: 1\nname: "@fixture/${ext}"\nversion: "1.0.0"\n` +
      `models:\n${modelsList}\n`,
  );
  for (const [relPath, content] of Object.entries(modelFiles)) {
    const full = join(root, ext, relPath);
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
  for (const [relPath, content] of Object.entries(extraFiles)) {
    const full = join(root, ext, relPath);
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
}

function lines(...ls: string[]): string {
  return ls.join("\n") + "\n";
}

async function withTempRoot(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "upgrade-chain-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// ============================================================================
// The five fail-closed rules
// ============================================================================

Deno.test("checkUpgradeChain: model-source-unlexable — an unterminated string in a manifest-listed model file is a violation, never a silent skip", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": 'const oops = "never closes\n' +
        "export const model = {\n" +
        '  version: "1.0.0",\n' +
        "};\n",
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-source-unlexable");
    assertEquals(violations[0].extension, "widget");
  });
});

Deno.test("checkUpgradeChain: model-declaration-unreadable — a manifest-listed model file that yields ZERO declarations carrying a version key is a violation, never silently skipped", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "// no model export in this file at all",
        "export function helper(): number {",
        "  return 1;",
        "}",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-declaration-unreadable");
  });
});

Deno.test("checkUpgradeChain: model-version-unreadable — a version value that is not a plain double-quoted string is a violation", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "const VERSION_CONST = " + '"1.0.0";',
        "export const model = {",
        '  type: "@fixture/widget",',
        "  version: VERSION_CONST,",
        "  upgrades: [],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-version-unreadable");
  });
});

Deno.test("checkUpgradeChain: model-declaration-indirect — a depth-1 '...IDENT' spread on the model object itself is a violation (AMENDMENT fixture 1/2)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        "  ...CHAIN_BASE,",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-declaration-indirect");
  });
});

Deno.test("checkUpgradeChain: model-declaration-indirect fires on ANY depth-1 spread element, not '...IDENT' only — a parenthesised conditional after the dots must ALSO be a violation (AMENDMENT fixture 2/2, mutation: narrow the spread match back to '...IDENT' -> this fixture reddens to 0 violations; this is exactly the false-pass the amendment exists to close, since 'export const model = { ...(LEGACY ? LEGACY_BASE : CHAIN_BASE) }' is deno-fmt-stable, type-clean, and swamp-push-clean)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        "  ...(LEGACY ? LEGACY_BASE : CHAIN_BASE),",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-declaration-indirect");
  });
});

// DELIBERATE, LOAD-BEARING FALSE POSITIVE — do not "fix" this by making the
// cross-check depth- or comment-aware. The plan specifies it as a RAW,
// depth-unaware, comment-unaware text scan over the declaration's span
// precisely so it can catch a masking bug the top-level parser itself
// cannot see (a bug in the mask would also hide the truth from a depth-
// aware or comment-aware backstop). The cost is that an unrelated nested
// `upgrades` field or a comment merely MENTIONING "upgrades:" also trips
// it — both fixtures below are exactly that cost, enumerated on purpose
// rather than left to be discovered in production. Swept against the real
// tree: zero false positives today (every `upgrades:` occurrence in a
// manifest-listed model file is the real property).
Deno.test("checkUpgradeChain: upgrade-chain-unreadable — the raw cross-check flags a declaration whose span contains 'upgrades:' text the top-level parser correctly does not resolve as a depth-1 property (mutation: drop the upgrade-chain-unreadable raw cross-check -> this fixture reddens to 0 violations instead of 1; this fixture uses an UNRELATED, deeper-nested 'upgrades' field to trigger it, since the cross-check is a raw, depth-unaware text scan over the declaration's span — see the DELIBERATE FALSE POSITIVE note above)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "  metadata: {",
        '    upgrades: "unrelated nested field, not the real chain",',
        "  },",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "upgrade-chain-unreadable");
  });
});

Deno.test("checkUpgradeChain: upgrade-chain-unreadable ALSO fires on a bare COMMENT mentioning 'upgrades:' in an otherwise chainless declaration — the second enumerated false-positive shape (mutation: same as above; this fixture pins that the cross-check is comment-unaware too, not merely nesting-unaware, which is the shape a future author is most likely to hit by writing a TODO)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        "  // upgrades: TODO add a migration chain once v2 ships",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "upgrade-chain-unreadable");
  });
});

// ============================================================================
// Policy verdicts on a resolved chain
// ============================================================================

Deno.test("checkUpgradeChain: upgrade-chain-terminus — a seanime-shaped mismatch (single entry ending short of the model version) is exactly one violation (mutation: flip the terminus comparison to '!==' -> this reddens on assertEquals(violations.length, 1))", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "seanime-like", {
      "extensions/models/seanime_like.ts": lines(
        "export const model = {",
        '  type: "@fixture/seanime-like",',
        '  version: "2026.07.16.2",',
        "  upgrades: [",
        "    {",
        '      fromVersion: "2026.04.05.1",',
        '      toVersion: "2026.04.05.2",',
        "    },",
        "  ],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "upgrade-chain-terminus");
  });
});

Deno.test("checkUpgradeChain: upgrade-chain-indirect — 'upgrades: CHAIN' (a hoisted identifier, not a readable array literal) is a violation", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "  upgrades: CHAIN,",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "upgrade-chain-indirect");
  });
});

Deno.test("checkUpgradeChain: upgrade-chain-unparseable — a literal array whose element does not start with '{' is a violation", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "  upgrades: [NOT_AN_OBJECT_LITERAL],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "upgrade-chain-unparseable");
  });
});

Deno.test("checkUpgradeChain: a QUOTED '\"upgrades\"' key with a wrong terminus reports the USEFUL verdict upgrade-chain-terminus, not the unreadable backstop — pins the downgrade the quoted-key branch exists to prevent (mutation: run the whitespace skip before the quoted-key branch, so a masked quote is silently missed -> this fixture reddens from 'upgrade-chain-terminus' to 'upgrade-chain-unreadable'; `\"upgrades\": [` is fmt-stable, type-clean, and a silent pass for a bare-identifier key scan)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        '  "upgrades": [',
        '    { fromVersion: "0.9.0", toVersion: "wrong" },',
        "  ],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "upgrade-chain-terminus");
  });
});

// ============================================================================
// Per-declaration, not per-file
// ============================================================================

Deno.test("checkUpgradeChain: evaluates EACH declaration independently — a file whose first declaration is broken and second is correct produces exactly ONE violation, naming the first (mutation: collapse per-declaration evaluation into a file-scoped scan -> this reddens: a file-scoped scan reports 0 where 1 is correct)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const modelA = {",
        '  type: "@fixture/widget-a",',
        '  version: "2.0.0",',
        "  upgrades: [",
        '    { fromVersion: "1.0.0", toVersion: "1.5.0" },',
        "  ],",
        "};",
        "",
        "export const modelB = {",
        '  type: "@fixture/widget-b",',
        '  version: "3.0.0",',
        "  upgrades: [",
        '    { fromVersion: "2.0.0", toVersion: "3.0.0" },',
        "  ],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "upgrade-chain-terminus");
  });
});

Deno.test("checkUpgradeChain: per-declaration evaluation, MIRRORED — a file whose FIRST declaration is correct and SECOND is broken also produces exactly ONE violation (mutation: evaluate only the first declaration in each file (e.g. models.slice(0, 1)) -> this fixture reddens to 0 violations, where the sibling test above (broken-first, correct-second) cannot catch that specific mutation, because it already gets the right count from the first declaration alone; libvirt ships 4 model files and swamp-go-brr 5, so multi-declaration files are the pattern this guards, not a hypothetical)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const modelA = {",
        '  type: "@fixture/widget-a",',
        '  version: "3.0.0",',
        "  upgrades: [",
        '    { fromVersion: "2.0.0", toVersion: "3.0.0" },',
        "  ],",
        "};",
        "",
        "export const modelB = {",
        '  type: "@fixture/widget-b",',
        '  version: "9.0.0",',
        "  upgrades: [",
        '    { fromVersion: "8.0.0", toVersion: "8.5.0" },',
        "  ],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "upgrade-chain-terminus");
  });
});

Deno.test("checkUpgradeChain: aggregates across multiple bad FILES rather than stopping at the first (mutation: return after the first violation instead of aggregating -> this two-bad-files fixture reddens on assertEquals(violations.length, 2))", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "alpha", {
      "extensions/models/alpha.ts": lines(
        "export const model = {",
        '  type: "@fixture/alpha",',
        '  version: "2.0.0",',
        "  upgrades: [",
        '    { fromVersion: "1.0.0", toVersion: "1.5.0" },',
        "  ],",
        "};",
      ),
    });
    await writeExtension(root, "beta", {
      "extensions/models/beta.ts": lines(
        "export const model = {",
        '  type: "@fixture/beta",',
        '  version: "9.0.0",',
        "  upgrades: [",
        '    { fromVersion: "8.0.0", toVersion: "8.5.0" },',
        "  ],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 2, JSON.stringify(violations));
    const extensions = violations.map((v: { extension: string }) => v.extension)
      .sort();
    assertEquals(extensions, ["alpha", "beta"]);
  });
});

// ============================================================================
// Three things the gate must deliberately NOT do
// ============================================================================

Deno.test("checkUpgradeChain: an ABSENT 'upgrades' key is legal — zero violations (mutation: ADD an upgrades.length > 0 requirement -> this reddens; 28 of 59 real declarations have no chain at all and are all published and healthy)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations, []);
  });
});

Deno.test("checkUpgradeChain: a GAPPED chain with a correct terminus is legal — zero violations (mutation: ADD a contiguity requirement -> this reddens; swamp itself accepts a gapped chain)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "2026.03.01.1",',
        "  upgrades: [",
        '    { fromVersion: "1.0.0", toVersion: "2.0.0" },',
        '    { fromVersion: "5.0.0", toVersion: "2026.03.01.1" },',
        "  ],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations, []);
  });
});

Deno.test("checkUpgradeChain: three fmt-stable, swamp-legal empty-chain SHAPES are all legal (mutation: treat an empty array as unparseable -> all three redden)", async () => {
  const shapes: Record<string, string> = {
    "plain empty array": lines(
      "export const model = {",
      '  type: "@fixture/widget",',
      '  version: "1.0.0",',
      "  upgrades: [],",
      "};",
    ),
    "comment-only array": lines(
      "export const model = {",
      '  type: "@fixture/widget",',
      '  version: "1.0.0",',
      "  upgrades: [",
      "    // no migrations yet",
      "  ],",
      "};",
    ),
    "empty array with a trailing comment": lines(
      "export const model = {",
      '  type: "@fixture/widget",',
      '  version: "1.0.0",',
      "  upgrades: [], // no migrations",
      "};",
    ),
  };
  for (const [label, source] of Object.entries(shapes)) {
    await withTempRoot(async (root) => {
      await writeExtension(root, "widget", {
        "extensions/models/widget.ts": source,
      });
      const { violations } = await checkUpgradeChain(root);
      assertEquals(
        violations,
        [],
        `expected '${label}' to be legal (empty chain), got: ${
          JSON.stringify(violations)
        }`,
      );
    });
  }
});

// ============================================================================
// Manifest-driven discovery
// ============================================================================

Deno.test("checkUpgradeChain: discovers model files from the manifest's models: list, NOT from a glob over extensions/models/*.ts (mutation: glob instead of reading models: -> an extra UNLISTED helper file with no model would produce a SPURIOUS model-declaration-unreadable violation)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(
      root,
      "widget",
      {
        "extensions/models/widget.ts": lines(
          "export const model = {",
          '  type: "@fixture/widget",',
          '  version: "1.0.0",',
          "  upgrades: [],",
          "};",
        ),
      },
      {
        // present on disk, but deliberately NOT in the manifest's models:
        // list — mirrors telegram-import's real
        // *_test_helpers.ts, shipped by no manifest.
        "extensions/models/widget_test_helpers.ts": lines(
          "export function helper(): number {",
          "  return 1;",
          "}",
        ),
      },
    );
    const { violations } = await checkUpgradeChain(root);
    assertEquals(
      violations,
      [],
      `an unlisted helper file must not be scanned at all, got: ${
        JSON.stringify(violations)
      }`,
    );
  });
});

// ============================================================================
// Discovery itself fails closed (PR B review fix) — five manifest shapes
// that previously left a broken chain unreported while the extension still
// counted as `checked`.
// ============================================================================

async function writeManifestOnly(
  root: string,
  ext: string,
  manifestBody: string,
  modelFiles: Record<string, string>,
): Promise<void> {
  await Deno.mkdir(join(root, ext), { recursive: true });
  await Deno.writeTextFile(join(root, ext, "manifest.yaml"), manifestBody);
  for (const [relPath, content] of Object.entries(modelFiles)) {
    const full = join(root, ext, relPath);
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
}

const brokenChainModel = lines(
  "export const model = {",
  '  type: "@fixture/widget",',
  '  version: "2026.08.09.1",',
  "  upgrades: [",
  '    { fromVersion: "1.0.0", toVersion: "0.0.0" },',
  "  ],",
  "};",
);

const discoveryFailOpenShapes: Record<string, string> = {
  "no 'models:' key at all":
    'manifestVersion: 1\nname: "@fixture/widget"\nversion: "1.0.0"\n',
  "'models:' as a list of mappings":
    'manifestVersion: 1\nname: "@fixture/widget"\nversion: "1.0.0"\n' +
    "models:\n  - path: extensions/models/widget.ts\n",
  "'models:' as a single scalar":
    'manifestVersion: 1\nname: "@fixture/widget"\nversion: "1.0.0"\n' +
    "models: extensions/models/widget.ts\n",
  "manifest is invalid YAML": "manifestVersion: 1\nname: [unterminated\n",
};

Deno.test("checkUpgradeChain: discovery fails CLOSED — manifest-models-unreadable, never a silent skip, across four manifest shapes that previously left a broken chain unreported (mutation: revert readManifestModels to 'return []' on any of these -> every one of these fixtures reddens from 1 violation back to 0)", async () => {
  for (const [label, manifestBody] of Object.entries(discoveryFailOpenShapes)) {
    await withTempRoot(async (root) => {
      await writeManifestOnly(root, "widget", manifestBody, {
        "extensions/models/widget.ts": brokenChainModel,
      });
      const { violations } = await checkUpgradeChain(root);
      assertEquals(
        violations.length,
        1,
        `expected '${label}' to be a fail-closed violation, got: ${
          JSON.stringify(violations)
        }`,
      );
      assertEquals(violations[0].rule, "manifest-models-unreadable", label);
    });
  }
});

Deno.test("checkUpgradeChain: discovery fails CLOSED — a manifest-listed path that does not resolve to a readable file is a violation, not a silent skip (mutation: revert the 'continue' in checkUpgradeChain's read loop to not push a violation -> reddens to 0)", async () => {
  await withTempRoot(async (root) => {
    await writeManifestOnly(
      root,
      "widget",
      'manifestVersion: 1\nname: "@fixture/widget"\nversion: "1.0.0"\n' +
        "models:\n  - extensions/models/widget_TYPO.ts\n",
      { "extensions/models/widget.ts": brokenChainModel },
    );
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "manifest-models-unreadable");
  });
});

Deno.test("checkUpgradeChain: a manifest 'models:' entry that escapes the extension directory is rejected, never read (mutation: drop the isContainedIn() check -> this fixture's sentinel file would be read and reddens to a DIFFERENT rule, model-declaration-unreadable, instead of manifest-models-unreadable)", async () => {
  await withTempRoot(async (root) => {
    await Deno.writeTextFile(
      join(root, "sentinel.ts"),
      "export const NOT_A_MODEL_FILE = true;\n",
    );
    await writeManifestOnly(
      root,
      "widget",
      'manifestVersion: 1\nname: "@fixture/widget"\nversion: "1.0.0"\n' +
        "models:\n  - ../sentinel.ts\n",
      {},
    );
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "manifest-models-unreadable");
    assert(
      violations[0].what.includes("escapes the extension directory"),
      JSON.stringify(violations),
    );
  });
});

// ============================================================================
// Model identity is the 'type' key, not merely 'version' (PR B review fix,
// HIGH: a false positive that stopped the whole repo, and a false negative
// that hid a broken chain behind an unrelated helper's version key).
// ============================================================================

Deno.test("checkUpgradeChain: an unrelated helper object with a 'version' key but no 'type' key is NOT a model and must not be flagged (mutation: filter 'versioned' on version presence alone, not hasTypeKey -> this fixture reddens with a spurious model-version-unreadable/model-declaration-unreadable on schemaInfo/httpDefaults/cacheSpec)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const schemaInfo = { version: 3, strict: true };",
        "const API_VERSION = 2;",
        "export const httpDefaults = { version: API_VERSION, timeoutMs: 30_000 };",
        "export const cacheSpec = { version: 2, upgrades: [{ from: 1, to: 2 }] };",
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations, [], JSON.stringify(violations));
  });
});

Deno.test("checkUpgradeChain: a real model (has 'type') whose 'version' key was stripped is flagged, even when an unrelated helper elsewhere in the same file has a 'version' key (mutation: filter 'versioned' on version presence alone -> this fixture's broken 5-entry chain goes completely unevaluated and reddens to 0 violations)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        "  upgrades: [",
        '    { fromVersion: "1.0.0", toVersion: "2.0.0" },',
        '    { fromVersion: "2.0.0", toVersion: "0.0.0" },',
        "  ],",
        "};",
        'export const pkg = { version: "1.0.0" };',
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-version-unreadable");
  });
});

// ============================================================================
// A depth-1 property whose key cannot be read (computed, numeric, or an
// accessor) must fail closed, exactly like a depth-1 spread (PR B review
// fix, HIGH: the property KEY was fail-open even though the chain VALUE
// already failed closed).
// ============================================================================

Deno.test("checkUpgradeChain: a computed '[\"upgrades\"]' key hides a broken chain from every other check — must be reported, not silently dropped (mutation: don't compute hasUnreadableProperty, or don't check it in checkModelFile -> reddens to 0 violations; fmt/lint/tsc all pass this shape clean)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "2026.08.09.1",',
        '  ["upgrades"]: [',
        '    { fromVersion: "1.0.0", toVersion: "0.0.0" },',
        "  ],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-declaration-indirect");
  });
});

Deno.test("checkUpgradeChain: a 'get upgrades()' accessor hides a broken chain the same way — must ALSO be reported (mutation: same as above)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        'const CHAIN = [{ fromVersion: "1.0.0", toVersion: "0.0.0" }];',
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "2026.08.09.1",',
        "  get upgrades() { return CHAIN; },",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-declaration-indirect");
  });
});

Deno.test("checkUpgradeChain: a duplicate depth-1 'upgrades' key is reported rather than silently reading only the first (mutation: read upgradesProps[0] without checking hasDuplicateUpgrades -> reddens: the FIRST chain here is correct, so this fixture goes fully clean instead of reporting the ambiguity)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "2026.08.09.1",',
        '  upgrades: [{ fromVersion: "1.0.0", toVersion: "2026.08.09.1" }],',
        '  "upgrades": [{ fromVersion: "a", toVersion: "9.9.9" }],',
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    assertEquals(violations[0].rule, "model-declaration-indirect");
  });
});

// ============================================================================
// Reality pin
// ============================================================================

Deno.test("checkUpgradeChain reports ZERO violations against the REAL repository root (mutation: reintroduce seanime's broken terminus -> this reddens; written as 'zero' per plan v4 step 7's own instruction, since this pin lands together with step 9's seanime repair in the same PR B commit — see scripts/quality/extensions.test.ts's precedent for asserting against real disk state)", async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const { violations, checked } = await checkUpgradeChain(root);
  assertEquals(
    violations,
    [],
    `${violations.length} model upgrade-chain violation(s) remain:\n` +
      violations.map((
        v: { extension: string; rule: string; what: string },
      ) => `  - ${v.extension}: [${v.rule}] ${v.what}`).join("\n"),
  );
  // The zero-violations assertion alone is satisfied just as well by a run
  // that discovered NOTHING (root resolution broken, manifests: reading
  // broken at scale) as by a genuinely clean tree. Pin the EXTENT too: the
  // real repo has 50+ extensions, and `checked` must cover them all.
  const exts = await listExtensions({ root });
  assertEquals(
    checked.sort(),
    exts.sort(),
    "checkUpgradeChain must have scanned every real extension, not silently discovered zero",
  );
});

Deno.test("checkUpgradeChain: 'checked' lists the extensions actually scanned, mirroring check_soak.ts's/check_property_harness.ts's Result shape", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "alpha", {
      "extensions/models/alpha.ts": lines(
        "export const model = {",
        '  type: "@fixture/alpha",',
        '  version: "1.0.0",',
        "};",
      ),
    });
    const { checked } = await checkUpgradeChain(root);
    assert(
      checked.includes("alpha"),
      `expected checked[] to include 'alpha', got: ${JSON.stringify(checked)}`,
    );
  });
});

Deno.test("checkUpgradeChain: every violation has non-empty extension/rule/what/why/fix (matches check_soak.ts / check_allowlist.ts / check_property_harness.ts's Violation shape exactly)", async () => {
  await withTempRoot(async (root) => {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "  upgrades: [",
        '    { fromVersion: "0.9.0", toVersion: "0.9.5" },',
        "  ],",
        "};",
      ),
    });
    const { violations } = await checkUpgradeChain(root);
    assert(violations.length > 0);
    for (const v of violations) {
      assert(v.extension.length > 0, "missing extension");
      assert(v.rule.length > 0, "missing rule");
      assert(v.what.length > 0, "missing WHAT");
      assert(v.why.length > 0, "missing WHY");
      assert(v.fix.length > 0, "missing FIX");
    }
  });
});

// ============================================================================
// CLI: --help, --json, exit codes, ::error annotations — the SAME contract
// every sibling checker in scripts/quality/ carries (check_soak.test.ts,
// check_property_harness.test.ts, check_allowlist.test.ts). This file
// imported ONLY checkUpgradeChain and never spawned the script at all: an
// implementation whose `if (import.meta.main)` block ends in an
// unconditional `Deno.exit(0)` — or whose block is deleted outright, with
// zero occurrences of `import.meta.main` left in the file — passed every
// test above green.
// ============================================================================

const CUC_SCRIPT = new URL("./check_upgrade_chain.ts", import.meta.url);

Deno.test("check_upgrade_chain.ts --help exits 0 with non-empty usage output", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", CUC_SCRIPT.pathname, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  assert(new TextDecoder().decode(stdout).length > 0);
});

Deno.test("check_upgrade_chain.ts CLI exits 0 and writes a --json summary with violations: [] for a clean fixture", async () => {
  const root = await Deno.makeTempDir({
    prefix: "check-upgrade-chain-cli-clean-",
  });
  try {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "};",
      ),
    });
    const jsonPath = join(root, "summary.json");
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env=QUALITY_REPO_ROOT",
        CUC_SCRIPT.pathname,
        "--json",
        jsonPath,
      ],
      env: { QUALITY_REPO_ROOT: root },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    const summary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(summary.violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check_upgrade_chain.ts CLI exits 1 and emits a ::error annotation for a broken-terminus fixture (mutation: end the import.meta.main block in an unconditional Deno.exit(0), or delete the block entirely -> this reddens on the exit code, and the ::error assertion catches a variant that exits 1 but never annotates)", async () => {
  const root = await Deno.makeTempDir({
    prefix: "check-upgrade-chain-cli-dirty-",
  });
  try {
    await writeExtension(root, "widget", {
      "extensions/models/widget.ts": lines(
        "export const model = {",
        '  type: "@fixture/widget",',
        '  version: "1.0.0",',
        "  upgrades: [",
        '    { fromVersion: "0.9.0", toVersion: "0.9.5" },',
        "  ],",
        "};",
      ),
    });
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env=QUALITY_REPO_ROOT",
        CUC_SCRIPT.pathname,
      ],
      env: { QUALITY_REPO_ROOT: root },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    assertEquals(code, 1);
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes("::error file="),
      `expected a ::error file= annotation on stdout, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ============================================================================
// deno.json wiring parity — plan v4 step 8(a) requires a `quality:upgrades`
// task granting --allow-write, because the CI invocation passes --json and
// a Deno program that calls Deno.writeTextFile under --allow-read alone
// exits 1 with NotCapable. A missing or wrongly-permissioned task is
// invisible to every test above, which spawns the script directly.
// ============================================================================

Deno.test("scripts/deno.json defines a 'quality:upgrades' task that grants --allow-write (mutation: omit the task, or grant only --allow-read -> reddens)", async () => {
  const denoJsonPath = join(
    dirname(fromFileUrl(import.meta.url)),
    "..",
    "deno.json",
  );
  const parsed = JSON.parse(await Deno.readTextFile(denoJsonPath)) as {
    tasks?: Record<string, string>;
  };
  const task = parsed.tasks?.["quality:upgrades"];
  assert(
    typeof task === "string" && task.length > 0,
    "scripts/deno.json must define a 'quality:upgrades' task",
  );
  assert(
    task!.includes("--allow-write"),
    `'quality:upgrades' task must grant --allow-write (CI passes --json), got: ${task}`,
  );
});
