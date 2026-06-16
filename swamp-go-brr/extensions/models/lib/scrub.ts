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
// service-account "private_key" JSON values; and a generic api_key|token|secret|password
// = high-entropy-value pair (value must contain BOTH a letter and a digit and be ≥8
// chars, so plain identifiers/words like `token=examplevalue` or `password=foo` survive).
// NOT caught (by design / accepted gaps): low-entropy custom secrets, secrets with no
// recognizable key word, and bare base64 blobs not behind a known key.
export function scrubSecrets(text: string): string {
  return text
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
      // key word, separator, then a high-entropy value (≥8 chars, has a letter AND a
      // digit). The two lookaheads enforce the entropy floor so plain words survive.
      /((?:api[-_]?key|token|secret|password)\s*[=:]\s*)((?=[A-Za-z0-9._/+\-]*[A-Za-z])(?=[A-Za-z0-9._/+\-]*\d)[A-Za-z0-9._/+\-]{8,})/gi,
      "$1[REDACTED]",
    );
}
