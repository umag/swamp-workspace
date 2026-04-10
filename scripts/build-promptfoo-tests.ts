// Copyright 2026 magistr. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Expands per-skill `evals/trigger_evals.json` files into a single
// `promptfoo.generated.yaml` that CI feeds to `promptfoo eval`.
//
// Source of truth: `.claude/skills/<name>/evals/trigger_evals.json`
// Template:        `promptfoo.config.yaml`
// Output:          `promptfoo.generated.yaml`
//
// Run: deno run --allow-read --allow-write scripts/build-promptfoo-tests.ts

import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "jsr:@std/yaml@1";
import { walk } from "jsr:@std/fs@1/walk";
import { basename, dirname, fromFileUrl, join } from "jsr:@std/path@1";

interface TriggerEntry {
  query: string;
  should_trigger: boolean;
}

interface PromptfooTest {
  vars: { query: string };
  assert: Array<
    | { type: "contains"; value: string }
    | { type: "not-contains"; value: string }
  >;
  description: string;
}

interface PromptfooConfig {
  description?: string;
  providers?: unknown;
  prompts?: unknown;
  tests?: PromptfooTest[];
  [k: string]: unknown;
}

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
// Scan all extension subdirs for skills (monorepo layout: <ext>/.claude/skills/)
const SKILLS_ROOT = REPO_ROOT;
const TEMPLATE = join(REPO_ROOT, "promptfoo.config.yaml");
const OUTPUT = join(REPO_ROOT, "promptfoo.generated.yaml");

async function loadTriggerEvals(): Promise<PromptfooTest[]> {
  const tests: PromptfooTest[] = [];
  const walker = walk(SKILLS_ROOT, {
    includeDirs: false,
    match: [/trigger_evals\.json$/],
  });
  for await (const entry of walker) {
    // path: .../.claude/skills/<skill>/evals/trigger_evals.json
    const skillDir = dirname(dirname(entry.path));
    const skill = basename(skillDir);
    const raw = await Deno.readTextFile(entry.path);
    const triggers = JSON.parse(raw) as TriggerEntry[];
    for (const t of triggers) {
      tests.push({
        vars: { query: t.query },
        description: `${skill}: ${
          t.should_trigger ? "route to" : "reject from"
        } "${t.query.slice(0, 60)}"`,
        assert: [
          t.should_trigger
            ? { type: "contains", value: skill }
            : { type: "not-contains", value: skill },
        ],
      });
    }
  }
  return tests;
}

async function main(): Promise<void> {
  const templateRaw = await Deno.readTextFile(TEMPLATE);
  const config = parseYaml(templateRaw) as PromptfooConfig;
  const tests = await loadTriggerEvals();
  if (tests.length === 0) {
    throw new Error(
      `No trigger_evals.json files found under ${SKILLS_ROOT}`,
    );
  }
  config.tests = tests;
  const out = stringifyYaml(config as Record<string, unknown>, {
    lineWidth: 100,
  });
  const banner = "# GENERATED FILE — do not edit. Source of truth:\n" +
    "#   - promptfoo.config.yaml (template)\n" +
    "#   - .claude/skills/<name>/evals/trigger_evals.json (per-skill)\n" +
    "# Regenerate: deno run --allow-read --allow-write scripts/build-promptfoo-tests.ts\n\n";
  await Deno.writeTextFile(OUTPUT, banner + out);
  console.log(
    `Wrote ${OUTPUT} — ${tests.length} tests across ${
      new Set(tests.map((t) => t.description.split(":")[0])).size
    } skills`,
  );
}

if (import.meta.main) {
  await main();
}
