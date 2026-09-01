/**
 * Validate an issue-lifecycle attestation manifest against the tree CI has
 * checked out.
 *
 * WHAT THIS REPLACES. `deno-check` re-executes fmt / lint / check / test on
 * every PR, discovering failures a verification loop already found and fixed
 * minutes earlier. When a manifest proves those controls ran against exactly
 * this commit under exactly these configs, re-running them buys nothing.
 *
 * WHAT IT DOES NOT REPLACE. The manifest's *result* integrity is trusted to
 * whoever ran the controls; only its *config* integrity is independently
 * verifiable, by recomputing every digest from the checked-out tree. So this
 * validator answers one narrow question — "is this evidence about this tree,
 * produced under these configs, and does it claim every required control
 * passed?" — and nothing about whether the runner was honest.
 *
 * FAIL CLOSED TO RE-EXECUTION. Every failure path here — missing manifest,
 * unreadable JSON, schema mismatch, wrong commit, changed checksum, a control
 * that did not pass — reports `valid=false`, which makes CI run the full
 * matrix. It NEVER reports `valid=true` on a check it could not perform.
 * This is the distinction `scripts/quality/score_ratchet.ts` had to learn the
 * hard way: "the gate could not evaluate this subject" and "this subject is
 * out of scope" are different outcomes, and only the second is skippable.
 * Here neither is — an unevaluable manifest costs a CI run.
 *
 * EXIT CODE IS ALWAYS 0 on a completed validation. The verdict travels in
 * `valid=` on stdout (and `$GITHUB_OUTPUT` when set), because an invalid
 * manifest is not a CI failure — it is a signal to do the work the old way.
 * A non-zero exit means the validator itself broke.
 */

import { z } from "zod";

/** One control result, as recorded by the model's `verify`. */
export const ControlResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  status: z.enum(["pass", "fail", "error", "skipped"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  runner: z.string(),
  required: z.boolean(),
  stderrTail: z.string(),
});

/** Per-reviewer finding summary, as recorded by the model's `attest`. */
export const AttestedReviewSchema = z.object({
  reviewer: z.string(),
  verdict: z.enum(["PASS", "FAIL", "SUGGEST_CHANGES"]),
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
});

/**
 * The manifest shape. Kept in lockstep with `AttestationSchema` in
 * `issue-lifecycle/extensions/models/issue_lifecycle.ts` — a manifest this
 * validator cannot parse is simply invalid, so a drift here costs a CI run
 * rather than a false pass.
 */
export const AttestationSchema = z.object({
  attestationVersion: z.literal(1),
  issue: z.string(),
  commitSha: z.string(),
  branch: z.string().optional(),
  planVersion: z.number().int().positive(),
  prUrl: z.string().optional(),
  configChecksums: z.record(z.string(), z.string()),
  controls: z.array(ControlResultSchema),
  reviews: z.array(AttestedReviewSchema),
  runner: z.string(),
  producedAt: z.string(),
  producedBy: z.string(),
  modelVersion: z.string(),
});

/** A parsed manifest. */
export type Attestation = z.infer<typeof AttestationSchema>;

/** Why a manifest was rejected, or that it was accepted. */
export interface ValidationResult {
  /** True only when every check ran AND passed. */
  valid: boolean;
  /** Human-readable reasons, most important first. Empty iff `valid`. */
  reasons: string[];
  /** The manifest, when it parsed. */
  attestation?: Attestation;
}

/** Injectable file reader, so tests never touch a real tree. */
export type FileReader = (path: string) => Promise<Uint8Array>;

/** Default reader. */
export const defaultFileReader: FileReader = (path) => Deno.readFile(path);

/** Lowercase hex SHA-256, matching the model's `sha256Hex`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Join a manifest-declared relative path onto the repo root, safely. */
export function joinRepoPath(repoDir: string, relative: string): string {
  if (relative === "" || relative === ".") return repoDir;
  if (relative.startsWith("/")) {
    throw new Error(`config path must be repo-relative, got '${relative}'`);
  }
  const segments = relative.split("/").filter((p) => p !== "" && p !== ".");
  if (segments.includes("..")) {
    throw new Error(`config path must stay inside the repo, got '${relative}'`);
  }
  return `${repoDir.replace(/\/$/, "")}/${segments.join("/")}`;
}

/**
 * Validate a manifest against a commit and a tree.
 *
 * `rawManifest` is the file's text — parsing is this function's job so a
 * malformed file is a reason, not a thrown exception the caller must guess at.
 */
export async function validateAttestation(
  readFile: FileReader,
  rawManifest: string | null,
  headSha: string,
  repoDir: string,
): Promise<ValidationResult> {
  const reasons: string[] = [];

  if (rawManifest === null) {
    return { valid: false, reasons: ["no attestation manifest found"] };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawManifest);
  } catch (err) {
    return {
      valid: false,
      reasons: [
        `manifest is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    };
  }

  const parsed = AttestationSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      valid: false,
      reasons: [
        `manifest does not match the attestation schema: ${parsed.error.message}`,
      ],
    };
  }
  const attestation = parsed.data;

  // 1. Does the evidence describe THIS commit?
  if (attestation.commitSha !== headSha) {
    reasons.push(
      `manifest attests ${
        attestation.commitSha.slice(0, 12)
      } but the head is ` +
        `${headSha.slice(0, 12)}`,
    );
  }

  // 2. Were the configs in force the ones in this tree? This is the half a
  //    validator can check without trusting anyone.
  if (Object.keys(attestation.configChecksums).length === 0) {
    reasons.push(
      "manifest declares no config checksums — nothing about the review " +
        "prompts or constraints can be verified",
    );
  }
  for (const [rel, expected] of Object.entries(attestation.configChecksums)) {
    if (expected === "MISSING") {
      reasons.push(`config '${rel}' was recorded as MISSING at attest time`);
      continue;
    }
    let actual: string;
    try {
      actual = await sha256Hex(await readFile(joinRepoPath(repoDir, rel)));
    } catch (err) {
      reasons.push(
        `config '${rel}' could not be read from the tree: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (actual !== expected) {
      reasons.push(
        `config '${rel}' changed since attestation ` +
          `(expected ${expected.slice(0, 12)}, tree has ${
            actual.slice(0, 12)
          })`,
      );
    }
  }

  // 3. Does it actually claim a clean run?
  const required = attestation.controls.filter((c) => c.required);
  if (required.length === 0) {
    reasons.push("manifest declares no required controls");
  }
  for (const c of required) {
    if (c.status !== "pass") {
      reasons.push(`required control '${c.name}' is '${c.status}', not 'pass'`);
    }
  }

  // 4. Did the reviewers agree?
  if (attestation.reviews.length === 0) {
    reasons.push("manifest records no reviewer results");
  }
  for (const r of attestation.reviews) {
    if (r.verdict === "FAIL") {
      reasons.push(`reviewer '${r.reviewer}' recorded a FAIL verdict`);
    }
    if (r.critical > 0 || r.high > 0) {
      reasons.push(
        `reviewer '${r.reviewer}' left ${r.critical} CRITICAL and ${r.high} ` +
          `HIGH findings open`,
      );
    }
  }

  return { valid: reasons.length === 0, reasons, attestation };
}

/** Locate the manifest for a commit, or null when there is none. */
export async function findManifest(
  readFile: FileReader,
  repoDir: string,
  headSha: string,
): Promise<string | null> {
  try {
    const bytes = await readFile(
      joinRepoPath(repoDir, `.attestations/${headSha}.json`),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): { headSha: string; repoDir: string } {
  let headSha = "";
  let repoDir = "..";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--head-sha") headSha = argv[++i] ?? "";
    else if (argv[i] === "--repo-dir") repoDir = argv[++i] ?? "..";
  }
  return { headSha, repoDir };
}

async function main(): Promise<void> {
  const { headSha, repoDir } = parseArgs(Deno.args);
  if (headSha === "") {
    // No head sha means we cannot even ask the question. Fail closed.
    await emit({ valid: false, reasons: ["--head-sha was not supplied"] });
    return;
  }

  const raw = await findManifest(defaultFileReader, repoDir, headSha);
  const result = await validateAttestation(
    defaultFileReader,
    raw,
    headSha,
    repoDir,
  );
  await emit(result);
}

async function emit(result: ValidationResult): Promise<void> {
  if (result.valid) {
    console.log("attestation VALID — deno-check may be skipped");
  } else {
    console.log("attestation NOT VALID — running the full matrix");
    for (const r of result.reasons) console.log(`  - ${r}`);
  }
  const line = `valid=${result.valid}\n`;
  console.log(line.trim());
  const out = Deno.env.get("GITHUB_OUTPUT");
  if (out) await Deno.writeTextFile(out, line, { append: true });
}

if (import.meta.main) await main();
