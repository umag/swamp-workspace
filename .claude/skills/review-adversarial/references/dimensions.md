# Adversarial Review Dimensions — Expanded

## Dimension 1: Credentials & Secrets

Lightweight check only — flag obvious hardcoded secrets in the code under review.
For vault annotations, env-based auth, scoping, and deep credential audit, defer
to `/review-security`.

### Checklist
- [ ] No hardcoded API keys, tokens, or passwords in source
- [ ] No secrets visible in string literals or config objects

## Dimension 2: Logging Quality

### Checklist
- [ ] Method logs on entry: what it's about to do
- [ ] Method logs on completion: what it did
- [ ] Structured placeholders, no string interpolation
- [ ] Appropriate levels (debug/info/warning/error)
- [ ] No sensitive data in any log level

### Code Patterns
```typescript
// BAD: no entry log, string interpolation
await doThing();
context.logger.info(`Done with ${name}`);

// GOOD: entry + completion, structured
context.logger.info("Creating {resource}", { resource: name });
await doThing();
context.logger.info("Created {resource}", { resource: name });
```

## Dimension 3: Error Handling

### Checklist
- [ ] Validation throws BEFORE any writeResource/createFileWriter calls
- [ ] Error messages include: operation + resource + detail
- [ ] HTTP errors include status code and response body
- [ ] Transient vs permanent errors distinguished where relevant
- [ ] try/catch blocks are narrow, not wrapping entire functions

### Code Patterns
```typescript
// BAD: write before validation
context.writeResource("main", name, partialData);
if (!isValid) throw new Error("Invalid"); // too late!

// GOOD: validate first
if (!isValid) throw new Error("Invalid input for resource");
context.writeResource("main", name, validatedData);

// BAD: broad catch
try { /* 50 lines */ } catch { /* swallowed */ }

// GOOD: narrow catch with context
try {
  response = await fetch(url, { signal });
} catch (e) {
  throw new Error(`Failed to fetch ${url}: ${e.message}`);
}
```

## Dimension 4: Testing Completeness

### Checklist
- [ ] Test uses `createModelTestContext` (or appropriate test context)
- [ ] Success path tested
- [ ] API error response tested (4xx, 5xx)
- [ ] "Already exists" case tested (for create methods)
- [ ] "Not found" case tested (for update/delete methods)
- [ ] Invalid input tested
- [ ] Injectable client pattern used for external APIs

## Dimension 5: Idempotency & Resilience

### Checklist
- [ ] Create methods: "already exists" → return existing, not throw
- [ ] Delete methods: "already gone" → succeed, not throw on 404
- [ ] Partial failure: no orphaned resources on mid-execution interruption
- [ ] Network operations have retry with backoff for transient errors
- [ ] State is consistent after any point of failure

## Dimension 6: API Contracts

### Checklist
- [ ] API responses validated before field access
- [ ] Pagination handled for list endpoints
- [ ] Rate limiting respected (Retry-After, backoff)
- [ ] All network requests have AbortSignal with timeout
- [ ] URLs and methods match current provider documentation

## Dimension 7: Resource Management

### Checklist
- [ ] File handles closed in finally blocks
- [ ] Temp files cleaned up on all paths
- [ ] Cloud resources tracked by ID for cleanup
- [ ] No leaked AbortControllers or event listeners
- [ ] Network connections closed after use
- [ ] `using` keyword or try/finally for resource lifecycle
