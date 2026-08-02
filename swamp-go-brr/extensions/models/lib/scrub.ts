// Pure secret-scrub shared by the source-integration apply boundary AND the gobrr
// step-output audit boundary. This module imports NOTHING from gobrr.ts or
// source_integration.ts (source_integration imports `type FailureKind` from gobrr, so
// any model import here would form a cycle) — it depends only on the standard regex
// engine. Tested in isolation by lib/scrub.test.ts.
//
// Redacts credential VALUES from text persisted to a resource (the jj diff, and the
// docker-verify stdout tail). It is deliberately OVER-eager on the value side: for
// audit text we prefer redacting a benign-but-secret-shaped string to leaking a real
// credential. It does NOT redact the bare key WORDS (TOKEN/SECRET/...), only values.
//
// Caught: Anthropic sk-ant tokens; Authorization/Bearer header values; AWS access key
// ids (AKIA…); GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_); GitLab PATs (glpat-…); GCP
// service-account "private_key" JSON values; a generic api_key|token|secret|password
// = high-entropy-value pair (value must contain BOTH a letter and a digit and be ≥11
// chars, so plain identifiers/words like `token=examplevalue` or a short `token=abc12345`
// survive — the floor was raised issue swamp-go-brr-latent-bugs B4 to cut that
// false-positive class; secrets ≥11 chars, incl. all-lowercase-hex, are still caught);
// and (B5) a BARE high-entropy run (≥32 chars from [A-Za-z0-9+/=_-], mixing lower AND
// upper AND digit) with NO preceding key word at all.
// NOT caught (by design / accepted gaps): low-entropy custom secrets (<11 chars behind
// a key word, or any length with fewer than 3 mixed char-classes and no key word).
//
// Input-size cap (B4): scrubSecrets bounds its OWN input to the last MAX_SCRUB_BYTES
// characters (tail-preserving — callers that care about the HEAD should slice before
// calling, as source-integration's apply() diff capture now does) before running any
// pattern, so a much-larger-than-expected adversarial payload cannot force it to
// regex-scan an unbounded string. MAX_SCRUB_BYTES (262_144) is intentionally larger
// than source-integration's MAX_ENVELOPE_BYTES (200_000), so a build_workorder file
// slice is never truncated by this cap in practice — it is a backstop, not a normal
// operating bound.
export const MAX_SCRUB_BYTES = 262_144;

export function scrubSecrets(
  text: string,
  maxBytes: number = MAX_SCRUB_BYTES,
): string {
  const bounded = text.length > maxBytes ? text.slice(-maxBytes) : text;
  return bounded
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "[REDACTED-TOKEN]")
    .replace(
      /((?:Authorization|Bearer)\s*:?\s+)[A-Za-z0-9._~+/=\-]{8,}/gi,
      "$1[REDACTED]",
    )
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED-AWS-KEY]")
    .replace(/gh[oprsu]_[A-Za-z0-9]{36,}/g, "[REDACTED-GH-TOKEN]")
    .replace(/glpat-[A-Za-z0-9_-]{20}/g, "[REDACTED-GITLAB-TOKEN]")
    .replace(
      /("private_key"\s*:\s*")[^"]+(")/g,
      "$1[REDACTED]$2",
    )
    .replace(
      // key word, separator, then a high-entropy value (≥11 chars, has a letter AND a
      // digit). The two lookaheads enforce the entropy floor so plain words survive.
      /((?:api[-_]?key|token|secret|password)\s*[=:]\s*)((?=[A-Za-z0-9._/+\-]*[A-Za-z])(?=[A-Za-z0-9._/+\-]*\d)[A-Za-z0-9._/+\-]{11,})/gi,
      "$1[REDACTED]",
    )
    .replace(
      // B5: a BARE high-entropy run — no key word required — gated by all THREE
      // char-classes (lower AND upper AND digit) being present somewhere in the run,
      // and a length floor of 32 so ordinary mixed-case words/identifiers survive.
      // Deliberately NOT implemented as lookahead-gated quantifiers (e.g.
      // `(?=[...]*[A-Z])...{32,}`): an unbounded greedy lookahead scanning for a
      // rare character far from the match start is a textbook ReDoS — quadratic
      // backtracking on a long run lacking that class (exactly the kind of
      // adversarial payload this scrubber must survive, per B4). Matching the
      // run FIRST with a single non-backtracking character-class quantifier, then
      // classifying the (bounded) matched substring in a callback, is linear.
      /[A-Za-z0-9+/=_-]{32,}/g,
      (run) =>
        /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)
          ? "[REDACTED-SECRET]"
          : run,
    );
}
