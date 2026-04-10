# Security Review Checklist

Complete checklist for security review of swamp extensions, models, and workflows. Each item is a specific, verifiable check.

## 1. Command Injection

- [ ] **CI-1: No string interpolation in shell commands.** Every `exec()`, `Deno.Command()`, `Deno.run()`, or `spawn()` call uses array-form arguments. No template literals or string concatenation to build command strings.
- [ ] **CI-2: No CEL expression injection.** Any user input embedded in CEL predicates is validated against `/^[a-zA-Z0-9_.-]+$/` before inclusion. No raw string interpolation into CEL expressions.
- [ ] **CI-3: No YAML/JSON template injection.** All YAML and JSON generation uses serialization libraries (`JSON.stringify`, a YAML library), never string interpolation with user data.
- [ ] **CI-4: Environment variable isolation.** Subprocesses receive only explicitly listed environment variables, not the full inherited environment, when processing untrusted input.
- [ ] **CI-5: No eval or Function constructor.** No use of `eval()`, `new Function()`, or `import()` with user-controlled strings.

## 2. Input Validation

- [ ] **IV-1: Strict Zod schemas.** All `z.object()` schemas do not use `.passthrough()` or `.catchall()` unless explicitly documented as safe.
- [ ] **IV-2: Boundary validation.** Every method handler validates input with a Zod schema before any processing occurs. No unvalidated data flows into business logic.
- [ ] **IV-3: URL protocol validation.** All URL inputs are parsed with `new URL()` and `.protocol` is checked against an allowlist (typically `https:` only).
- [ ] **IV-4: Path traversal prevention.** All file path inputs are resolved with `path.resolve()` and checked to start with the expected base directory.
- [ ] **IV-5: Numeric bounds.** All numeric inputs use `.int()`, `.finite()`, `.min()`, `.max()` as appropriate. No unbounded numbers that could overflow or produce NaN.
- [ ] **IV-6: String length limits.** All string inputs have `.max()` constraints. No unbounded strings that could cause memory exhaustion.

## 3. Secret Handling

- [ ] **SH-1: No hardcoded credentials.** No string literals matching credential patterns: `AKIA*` (AWS), `ghp_*` (GitHub), `sk-*` (API keys), `xoxb-*` (Slack), `password = "..."`, or similar.
- [ ] **SH-2: Sensitive schema annotation.** Every Zod field holding a secret (password, token, key, apiKey, secret, connectionString) has `.meta({ sensitive: true })`.
- [ ] **SH-3: Sensitive output annotation.** Every method that produces credential output has `sensitiveOutput: true` in its definition.
- [ ] **SH-4: No secrets in logs.** No `logger.*()` or `console.*()` call interpolates or references a variable that holds a credential. This includes logging full request/response objects that may contain auth headers.
- [ ] **SH-5: No secrets in errors.** No `throw new Error()` or error return includes credential values. Error messages reference credential names, not values.
- [ ] **SH-6: Vault storage.** All credentials are retrieved from vault references (`vault.get()`, `${{ vault.* }}`), not from hardcoded values or plain config files.

## 4. Supply Chain

- [ ] **SC-1: Exact version pins.** Every `npm:` import specifies an exact version: `npm:pkg@1.2.3`. No caret (`^`), tilde (`~`), range (`>=`), or wildcard (`*`).
- [ ] **SC-2: No versionless imports.** No `npm:pkg` imports without a version specifier. Each must have `@x.y.z`.
- [ ] **SC-3: Known vulnerability check.** Each dependency version is checked against known CVE databases (npm advisories, Snyk, GitHub Security Advisories). Flag any dependency with known vulnerabilities at the pinned version.
- [ ] **SC-4: Minimal dependencies.** No dependency is used for trivially implementable functionality (fewer than 20 lines of code). Flag packages like `is-odd`, `left-pad`, `is-number`.
- [ ] **SC-5: Trusted sources only.** All imports come from `npm:` or `jsr:` registries. No imports from arbitrary URLs unless the URL is a well-known CDN with subresource integrity.

## 5. File System Safety

- [ ] **FS-1: Path traversal guard.** Every file operation with user-controlled paths uses `path.resolve()` + prefix check against the expected base directory.
- [ ] **FS-2: Symlink verification.** Before writing to user-controlled paths, `Deno.lstat()` is used to verify the target is not a symlink pointing outside the intended directory.
- [ ] **FS-3: Temp file cleanup.** Every `Deno.makeTempFile()` or `Deno.makeTempDir()` has a corresponding `Deno.remove()` in a `finally` block that runs on both success and error paths.
- [ ] **FS-4: Secure file permissions.** Files containing secrets are created with mode `0o600`. No world-readable files with sensitive content.
- [ ] **FS-5: Atomic writes.** Critical data files use write-to-temp-then-rename pattern to prevent partial writes on interruption.

## 6. API Security

- [ ] **AS-1: HTTPS only.** All external API calls use `https://`. `http://` is only acceptable for `localhost` / `127.0.0.1` in local development.
- [ ] **AS-2: Auth in headers.** Authentication tokens are sent in the `Authorization` header or custom headers, never in query string parameters.
- [ ] **AS-3: Response validation.** API responses are validated with `Zod.safeParse()` or equivalent before accessing nested fields. No unchecked property access on API responses.
- [ ] **AS-4: Rate limit handling.** Code handles HTTP 429 responses, reads `Retry-After` headers, and implements exponential backoff.
- [ ] **AS-5: Request timeouts.** Every `fetch()` call includes `signal: AbortSignal.timeout(N)` to prevent indefinite hangs. Timeout value is appropriate for the operation (typically 10-60 seconds).
- [ ] **AS-6: No open redirects.** If following redirects from user-controlled URLs, redirects are validated to prevent SSRF to internal addresses or `file://`/`data:` protocols.

## 7. Permission Scope

- [ ] **PS-1: Least privilege tokens.** Read-only operations use read-only tokens. Write tokens are only used when writes are needed.
- [ ] **PS-2: Resource-scoped credentials.** Credentials are scoped to specific resources (specific S3 buckets, specific repos) rather than wildcard access.
- [ ] **PS-3: Temporary credentials preferred.** IAM roles, instance profiles, and OIDC tokens are preferred over long-lived access keys.
- [ ] **PS-4: TTL respect.** Cached credentials are invalidated at or before their expiration time. No caching beyond TTL.
- [ ] **PS-5: Environment separation.** Production and development credentials are separate. No credential reuse across environments.

## Swamp-Specific Security Items

These checks are specific to the swamp platform and its extension model.

- [ ] **SW-1: CEL expression injection.** CEL predicates constructed with user input use parameterized values or strict input validation. No raw interpolation of external data into CEL strings.
- [ ] **SW-2: Vault reference leaks.** Vault expressions (`${{ vault.* }}`) are not logged, included in error messages, or written to non-sensitive output fields. Verify that workflow step outputs referencing vault values have `sensitiveOutput: true`.
- [ ] **SW-3: Extension model isolation.** Extension models do not access files outside their expected working directory. No path traversal from model methods into the host filesystem.
- [ ] **SW-4: Model method authorization.** Destructive methods (delete, destroy, stop) verify resource identity with `swamp model get` before execution, per project rules.
- [ ] **SW-5: Data model references.** Sensitive data flowing between models via `data.latest()` CEL expressions is not exposed in intermediate logging or workflow step summaries.
- [ ] **SW-6: Extension bundling safety.** Extension bundles do not include `.env` files, credential files, or other secrets. Check `.swampignore` or bundler configuration.
- [ ] **SW-7: Workflow secret propagation.** Secrets passed between workflow steps use vault references, not plaintext step outputs. Verify that `${{ vault.* }}` is used instead of `${{ steps.*.output.secret }}`.

## OWASP Top 10 Mapping for CLI/Automation Context

| # | OWASP Category | CLI/Automation Equivalent | Checklist Items |
|---|---|---|---|
| A01 | Broken Access Control | Over-privileged tokens, missing authorization on destructive operations | PS-1, PS-2, SW-4 |
| A02 | Cryptographic Failures | Hardcoded secrets, plain HTTP, missing sensitive annotations | SH-1, SH-2, AS-1 |
| A03 | Injection | Shell command injection, CEL injection, template injection | CI-1, CI-2, CI-3, SW-1 |
| A04 | Insecure Design | No input validation, no defense in depth, single point of failure | IV-1, IV-2, IV-3 |
| A05 | Security Misconfiguration | Default credentials, verbose error messages exposing internals | SH-5, SH-6, FS-4 |
| A06 | Vulnerable Components | Unpinned npm versions, known CVEs, unnecessary dependencies | SC-1, SC-2, SC-3, SC-4 |
| A07 | Auth Failures | Tokens in logs, tokens in URLs, expired token usage | SH-4, AS-2, PS-4 |
| A08 | Data Integrity Failures | Non-atomic writes, no checksum verification, unsigned bundles | FS-5, SW-6 |
| A09 | Logging & Monitoring Failures | Secrets in logs, missing audit trail for destructive ops | SH-4, SW-2, SW-5 |
| A10 | SSRF | Unvalidated URLs, following redirects to internal addresses | AS-6, IV-3 |

## Common Vulnerability Patterns in TypeScript/Deno

### Prototype Pollution
TypeScript objects are still JavaScript objects. Merging user-controlled objects with `Object.assign()` or spread (`{...userObj}`) can inject `__proto__`, `constructor`, or `prototype` keys. Use Zod's `.strict()` schemas to reject unknown keys before merging.

### Type Confusion via `any`
Using `any` type defeats TypeScript's safety. An `any`-typed variable from an API response can silently pass through type checks and corrupt downstream logic. Always parse API responses through Zod schemas to get properly typed values.

### Regex Denial of Service (ReDoS)
Regexes with nested quantifiers (e.g., `(a+)+$`) can cause catastrophic backtracking on crafted input. Avoid nested quantifiers in regexes applied to user input. Use `z.string().regex()` with tested patterns.

### Unhandled Promise Rejection
An unhandled `fetch()` rejection (network error, timeout) can crash the process or leave resources in an inconsistent state. All `fetch()` calls must be in try/catch blocks with proper error handling and resource cleanup.

### Deno Permission Escalation
Deno's permission system (`--allow-read`, `--allow-write`, `--allow-net`) can be overly broad. Granting `--allow-read=/` when only `--allow-read=./data` is needed expands the attack surface. Review Deno permission flags for least-privilege.

### JSON.parse Without Try/Catch
`JSON.parse()` throws on invalid input. In a CLI tool processing external data, this can crash the process. Always wrap `JSON.parse()` in try/catch or use `Zod.safeParse()` which handles parse errors gracefully.

### Race Conditions in Async Code
TOCTOU (time-of-check-time-of-use) bugs occur when checking a condition and acting on it are not atomic. In file operations, check-then-act patterns (if file exists, then write) are vulnerable to race conditions. Use atomic operations where possible.
