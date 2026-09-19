// Property-invariant suite: fast-check properties over the pure domain
// helpers. FC_NUM_RUNS controls iteration count for the nightly soak.
import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildRenderArgs,
  type FileEntry,
  formatExtension,
  FORMATS,
  QUALITIES,
  qualityLetter,
  selectOutputFile,
} from "./types.ts";

const qualityArb = fc.constantFrom(...QUALITIES);
const formatArb = fc.constantFrom(...FORMATS);
const sceneArb = fc.array(fc.string({ minLength: 1 }), { maxLength: 5 });

Deno.test("buildRenderArgs: always renders headless with the right flags", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      sceneArb,
      qualityArb,
      formatArb,
      (scriptPath, sceneNames, quality, format) => {
        const args = buildRenderArgs({
          scriptPath,
          sceneNames,
          quality,
          format,
          mediaDir: "/m",
          transparent: false,
          extraArgs: [],
        });
        // subcommand + quality + format always present and correct
        assertEquals(args[0], "render");
        assertEquals(
          args[args.indexOf("--quality") + 1],
          qualityLetter(quality),
        );
        assertEquals(args[args.indexOf("--format") + 1], format);
        // script path always present
        assert(args.includes(scriptPath));
        // headless: either -a (no scenes) or every named scene, never a prompt
        if (sceneNames.length === 0) {
          assert(args.includes("-a"));
        } else {
          for (const s of sceneNames) assert(args.includes(s));
          assert(!args.includes("-a"));
        }
      },
    ),
  );
});

Deno.test("selectOutputFile: result matches format and is the max by (mtime,size)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          path: fc.string({ minLength: 1 }),
          mtimeMs: fc.integer({ min: 0, max: 1_000_000 }),
          size: fc.integer({ min: 0, max: 1_000_000 }),
        }),
        { maxLength: 20 },
      ),
      formatArb,
      (files: FileEntry[], format) => {
        const ext = formatExtension(format).toLowerCase();
        const chosen = selectOutputFile(files, format);
        const matches = files.filter((f) => f.path.toLowerCase().endsWith(ext));
        if (matches.length === 0) {
          assertEquals(chosen, null);
        } else {
          assert(chosen !== null);
          assert(chosen.path.toLowerCase().endsWith(ext));
          // no matching file is strictly newer, or same mtime and larger
          for (const m of matches) {
            const newer = m.mtimeMs > chosen.mtimeMs;
            const sameTimeBigger = m.mtimeMs === chosen.mtimeMs &&
              m.size > chosen.size;
            assert(!newer && !sameTimeBigger);
          }
        }
      },
    ),
  );
});
