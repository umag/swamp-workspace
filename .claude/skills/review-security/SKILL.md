---
name: review-security
description: |
  Security-focused code review covering command injection, input validation,
  secret handling, supply chain, file system safety, API security, and
  permission scope. OWASP Top 10 adapted for CLI/automation context. Triggers
  on "security review", "review security", "/review-security", "security
  audit", "vulnerability check", "security scan", "check for vulnerabilities".
---

# Security Review Skill

## Philosophy

Every input is hostile. Every dependency is a liability. Every credential is a target. Review from the attacker's perspective. Defense in depth: validate at the boundary, sanitize at use, encrypt at rest/in transit, audit at every layer.

## When to Run

- Code handling credentials, API keys, tokens, or auth material
- External API calls or network requests
- User input, CLI arguments, or data from external sources
- New npm dependencies added to extension models
- File system operations (read/write/delete/temp files)
- Vault configuration or secret handling changes
- CEL expressions referencing sensitive data
- Workflow definitions passing secrets between steps
- Extension models interacting with cloud APIs (AWS, GCP, Azure)
- Shell command or subprocess construction
- Permission scope, IAM policy, or access control changes

---

## Audit Categories

### 1. Command Injection — CRITICAL

**Grep targets:** `exec(`, `spawn(`, `Deno.run(`, `Deno.Command(`, template literals near those calls, CEL predicate construction, `JSON.stringify` absence near YAML generation.

**Patterns:**

```typescript
// BAD: interpolation in shell command
exec(`aws s3 cp ${userPath} s3://bucket/`)

// GOOD: array args
exec(["aws", "s3", "cp", userPath, "s3://bucket/"])

// BAD: CEL injection
const pred = `attributes.name == "${userInput}"`;

// GOOD: validate userInput matches /^[a-zA-Z0-9_-]+$/ first

// BAD: YAML/JSON via string interpolation — use JSON.stringify or a YAML library

// BAD: subprocess inherits full env — pass only required vars explicitly
```

**Audit steps:**
1. Find all `exec`/`spawn`/`Deno.run`/`Deno.Command` calls; trace each argument to its origin.
2. Confirm external input is either validated against a strict pattern or passed as a separate array element.
3. Check every CEL expression construction for embedded user input.
4. Check YAML/JSON generation for string interpolation.

---

### 2. Input Validation — HIGH

**Grep targets:** entry-point handlers (method handlers, CLI parsers, API routes), `.passthrough()`, `.catchall()`, `fetch(userUrl`, `path.join(`, `path.resolve(`.

**Patterns:**

```typescript
// BAD: unvalidated URL
const resp = await fetch(userUrl);

// GOOD
const parsed = new URL(userUrl);
if (parsed.protocol !== "https:") throw new Error("HTTPS required");

// BAD: schema allows unknown fields through
z.object({ name: z.string() }).passthrough()

// GOOD: strict schema (default z.object() rejects unknown keys — don't add .passthrough() without justification)
```

**Audit steps:**
1. Identify all entry points; verify a Zod schema (or equivalent) runs before any processing.
2. Flag any `.passthrough()` or `.catchall()` without a documented justification.
3. Trace URL/path inputs to verify protocol and `../` traversal checks.
4. Verify numeric inputs use `.min()`, `.max()`, `.int()`, `.finite()`; strings use `.max()`.

---

### 3. Secret Handling — CRITICAL (exposure) / HIGH (missing annotations)

**Grep targets:** `AKIA`, `ghp_`, `sk-`, `xoxb-`, `password =`, `secret =`, `apiKey =`, `accessKey =`; `logger.info`/`debug`/`warn`/`error`/`console.log`/`console.error` near credential variables; `sensitiveOutput` absence on methods producing secrets; `.meta(` absence on secret schema fields.

**Patterns:**

```typescript
// BAD: hardcoded credential — CRITICAL
const apiKey = "sk-abc123...";

// GOOD: read from vault / env

// BAD: missing sensitive annotation
z.object({ token: z.string() })

// GOOD
z.object({ token: z.string().meta({ sensitive: true }) })

// BAD: secret in log
logger.info(`Auth token: ${token}`);

// BAD: method producing tokens lacks flag
// method({ ... }) — no sensitiveOutput: true

// GOOD
// method({ ..., sensitiveOutput: true })
```

**Audit steps:**
1. Search for hardcoded credential patterns (see grep targets).
2. Review all Zod schema fields named `password`, `token`, `key`, `secret`, `credential`, `apiKey`, `accessKey` — each must have `.meta({ sensitive: true })`.
3. Search log and error output for references to credential variables.
4. Verify `sensitiveOutput: true` is set on methods that produce secrets.

---

### 4. Supply Chain — HIGH (unpinned) / CRITICAL (known CVEs)

**Grep targets:** `npm:` imports missing `@x.y.z`, `^`, `~` version prefixes, `https://` CDN imports outside `npm:` / `jsr:`.

**Patterns:**

```typescript
// BAD
import _ from "npm:lodash-es";
import _ from "npm:lodash-es@^4.17.0";

// GOOD
import _ from "npm:lodash-es@4.17.21";

// BAD: arbitrary URL import
import lib from "https://some-cdn.com/lib.js";
```

**Audit steps:**
1. List all `npm:` imports; confirm each has an exact version (no `^`, `~`, `*`, or missing version).
2. Flag trivially replaceable micro-packages (e.g., `is-odd`, `left-pad`).
3. Flag dependencies for CVE verification against npm advisory DB or Snyk.
4. Confirm all imports come from `npm:` or `jsr:`.

---

### 5. File System Safety — HIGH

**Grep targets:** `Deno.writeFile`, `Deno.writeTextFile`, `Deno.readFile`, `Deno.readTextFile`, `Deno.remove`, `Deno.mkdir`, `Deno.makeTempFile`, `Deno.stat(` (vs `Deno.lstat(`).

**Patterns:**

```typescript
// BAD: no traversal check
Deno.writeFile(path.join(baseDir, userInput), data);

// GOOD
const resolved = path.resolve(baseDir, userInput);
if (!resolved.startsWith(baseDir)) throw new Error("Path traversal detected");

// BAD: temp file not cleaned on error path
const tmp = await Deno.makeTempFile();
await processFile(tmp);   // error leaves tmp on disk
await Deno.remove(tmp);

// GOOD
const tmp = await Deno.makeTempFile();
try { await processFile(tmp); } finally { await Deno.remove(tmp).catch(() => {}); }

// BAD: Deno.stat() follows symlinks — use Deno.lstat() to detect symlink attacks

// BAD: secret file with default permissions
// GOOD: Deno.writeFile(path, data, { mode: 0o600 })
```

**Audit steps:**
1. Trace path arguments for user input; verify `path.resolve` + prefix check.
2. Confirm temp files are cleaned in `finally` blocks.
3. Check `Deno.stat` → should be `Deno.lstat` before writes to detect symlinks.
4. Check `mode` on files containing sensitive data.

---

### 6. API Security — HIGH (missing TLS) / MEDIUM (missing validation)

**Grep targets:** `http://` (non-localhost), `?token=`, `?key=`, `?api_key=`, `fetch(` without `AbortSignal.timeout`, API responses accessed without `.safeParse()`.

**Patterns:**

```typescript
// BAD: token in query string
fetch(`https://api.example.com/data?token=${apiKey}`)

// GOOD
fetch("https://api.example.com/data", {
  headers: { Authorization: `Bearer ${apiKey}` },
})

// BAD: no timeout
await fetch(url);

// GOOD
await fetch(url, { signal: AbortSignal.timeout(30_000) });

// BAD: unvalidated response
const data = await resp.json();
data.nested.field;   // may throw or corrupt state

// GOOD: ResponseSchema.safeParse(await resp.json())
```

**Audit steps:**
1. Find all `fetch()` calls; verify HTTPS for external endpoints.
2. Confirm auth tokens are in headers, not URLs.
3. Verify `AbortSignal.timeout()` on every call.
4. Verify Zod `.safeParse()` (or equivalent) on API responses before field access.
5. Check 429/`Retry-After` handling and exponential backoff.

---

### 7. Permission Scope — MEDIUM

**Grep targets:** vault references, IAM policy `Resource: "*"`, long-lived key usage, token caching without TTL check, shared credentials across environments.

**Audit steps:**
1. Review each credential's vault reference; determine minimum required permission set.
2. Flag wildcard IAM resources (`Resource: "*"`) when only specific resources are needed.
3. Prefer IAM roles / instance profiles over long-lived keys for AWS.
4. Verify token TTL is respected (cached token expiry ≤ actual TTL).
5. Confirm production and development credentials are separate.

---

## Review Workflow

1. **Scope** — identify files/diff under review.
2. **Automated checks** — run grep targets listed per category above; also search for `http://` (non-localhost), `npm:` without exact version, template literals in shell calls.
3. **Manual review** — walk all 7 categories in order; do not skip any.
4. **Cross-reference** — a missing input validation finding may also be a command injection finding if input reaches a shell call; surface these as linked findings.
5. **Report** — use the output format below.

---

## Output Format

```
## Security Review | <scope>

### Verdict: PASS | FAIL

### CRITICAL
- [file:line] [Category] <finding>
  **Risk:** <concrete attacker impact>
  **Fix:** <specific code change>

### HIGH
- [file:line] [Category] <finding>
  **Risk:** ...  **Fix:** ...

### MEDIUM
- [file:line] [Category] <finding>
  **Risk:** ...  **Fix:** ...

### LOW
- [file:line] [Category] <finding>
  **Risk:** ...  **Fix:** ...

### Summary
- X critical, Y high, Z medium, W low
- Verdict: PASS (zero CRITICAL + zero HIGH) or FAIL
- Top 3 recommended fixes
```

**Rules:**
- Every finding: specific file + line, concrete Risk (not generic), specific Fix (not generic).
- Omit severity sections with no findings.
- Any CRITICAL = automatic FAIL.
- Err toward reporting (false positives preferred over false negatives).
