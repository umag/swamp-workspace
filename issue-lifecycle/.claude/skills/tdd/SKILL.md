---
name: tdd
description: >
  Test-Driven Development workflow enforcement. Red-Green-Refactor cycle for all
  feature implementations and bug fixes. Covers test naming, file organization,
  mock/stub guidelines, and when to use unit vs integration vs e2e tests in
  Deno/TypeScript. Use when asked to "write test", "TDD", "red green refactor",
  "failing test", "test first", "unit test", "integration test", "implement with
  tests", "feature with TDD", "fix bug with test", or when test coverage or
  test-first workflow is explicitly requested.
---

# Test-Driven Development

## The Cycle

Every feature and bug fix follows this cycle. No exceptions.

### RED

Write a failing test that describes the desired behavior. Run it. Confirm it
fails **for the right reason** — a missing function or wrong return value, not a
syntax error or import failure.

### GREEN

Write the **minimum** code to make the test pass. No more.

### REFACTOR

Clean up while all tests stay green. Run tests after **every** change. If a test
breaks, undo and try a smaller refactoring.

### Repeat

Each cycle should take minutes, not hours. If you're stuck in RED for more than
15 minutes, the test is too ambitious — write a simpler one.

## Test File Organization

| Test Type   | Location                       | When to Use                                         |
| ----------- | ------------------------------ | --------------------------------------------------- |
| Unit        | `foo.test.ts` next to `foo.ts` | Pure logic, transformations, validators, single fn  |
| Integration | `integration/`                 | Cross-module, datastore ops, real file I/O          |
| E2E         | `e2e/`                         | Full workflow runs, CLI commands, model methods e2e |
| Helpers     | `_test_utils/`                 | Shared mocks, factories, fixtures                   |
| Fixtures    | `_fixtures/`                   | Sample data, response snapshots                     |

## Test Naming Convention

```typescript
Deno.test("<unit> <does thing> when <condition>", async () => {
  // ...
});
```

**Examples:**

- `"createVpc returns vpc ID when API succeeds"`
- `"sync throws when resource not found"`
- `"parseConfig ignores unknown fields when strict mode is off"`
- `"Money.add throws when currencies differ"`

Names should read as behavior specifications. A failing test name should tell
you exactly what broke without reading the test body.

## When to Use Which Test Type

```
Is the code pure logic with no side effects?
├─ Yes → Unit test
└─ No → Does it cross module/service boundaries?
         ├─ Yes → Integration test
         └─ No → Does it test a full user-facing workflow?
                  ├─ Yes → E2E test
                  └─ No → Unit test with mocked boundary
```

## Swamp-Specific Testing

### createModelTestContext

Use `createModelTestContext()` from `@systeminit/swamp-testing` for extension
model tests:

```typescript
import { createModelTestContext } from "@systeminit/swamp-testing";

Deno.test("sync refreshes state from API", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    storedResources: {
      main: { instanceId: "i-abc123", status: "running" },
    },
  });

  await model.methods.sync.execute({}, context);
  assertEquals(getWrittenResources()[0].data.instanceId, "i-abc123");
});
```

### Inspection Helpers

```typescript
const {
  context, // MethodContext to pass to execute()
  getWrittenResources, // Array<{ specName, name, data, handle }>
  getWrittenFiles, // Array<{ specName, name, content, handle }>
  getLogs, // Array<{ level, message, args }>
  getLogsByLevel, // (level) => filtered logs
  getEvents, // Array<{ type, ...fields }>
} = createModelTestContext();
```

### Injectable Client Pattern

Accept an optional client parameter so tests can inject a stub:

```typescript
// In the model
execute: (async (args, context) => {
  const s3 = args._s3Client ??
    new S3Client({ region: context.globalArgs.region });
  await s3.send(new CreateBucketCommand({ Bucket: context.globalArgs.bucket }));
});

// In the test
const mockS3 = { send: () => Promise.resolve({}) };
const { context } = createModelTestContext({
  globalArgs: { region: "us-east-1", bucket: "my-bucket" },
});
await model.methods.create.execute({ _s3Client: mockS3 }, context);
```

### Alternative: Extract Testable Functions

Extract business logic into separate functions with explicit dependencies:

```typescript
// extensions/models/_lib/vpc_ops.ts
export async function createVpc(
  client: { send: (cmd: unknown) => Promise<unknown> },
  cidr: string,
) {
  const result = await client.send({ CidrBlock: cidr });
  return { vpcId: result.Vpc.VpcId, cidr, status: "available" };
}

// Test directly — no createModelTestContext needed
const mockClient = {
  send: () => Promise.resolve({ Vpc: { VpcId: "vpc-123" } }),
};
const result = await createVpc(mockClient, "10.0.0.0/16");
assertEquals(result.vpcId, "vpc-123");
```

## Mock/Stub Guidelines

1. **Mock at the boundary** — network, filesystem, clock, external APIs. Never
   mock internal modules.
2. **Prefer dependency injection** over module-level mocking.
3. **Prefer stubs over mocks** — stubs return canned data; mocks assert on
   interactions. Stubs are less brittle.
4. **Never mock what you don't own** without a companion integration test.
5. **If you need 3+ mocks**, the code needs restructuring — too many
   dependencies signal a design problem.

Use `withMockedFetch` / `withMockedCommand` for network/shell mocks in swamp
extensions.

## TDD for Bug Fixes

Mandatory workflow — no exceptions:

1. **Write a test that reproduces the bug** — it should fail
2. **Confirm it fails for the right reason** — the bug, not a test setup issue
3. **Fix the bug** — minimum change required
4. **Confirm the test passes**
5. **This test is now a permanent regression guard** — never delete it

## TDD for New Features

Outside-in approach:

1. Start with a high-level test describing the feature behavior
2. Let compilation/runtime errors guide you to the next test
3. Build up from the inside: value objects → entities → services → orchestration
4. Each layer gets its own red-green-refactor cycle

## Common Mistakes

- **Making the test pass by hardcoding** — valid for first GREEN, but must
  generalize by the third test (triangulation)
- **Testing implementation details** — test behavior (what), not structure (how)
- **Skipping the REFACTOR step** — tech debt accumulates silently

See [references/test-patterns.md](references/test-patterns.md) for Deno-specific
patterns and [references/test-organization.md](references/test-organization.md)
for directory layout guidance.

## TDD inside the issue lifecycle

**This section applies only when the work is driven by the `issue-lifecycle`
skill** (the `@magistr/issue-lifecycle` model). Outside a lifecycle, the classic
interleaved cycle above applies unchanged.

The lifecycle splits red-green-refactor across two model states, with a review
gate between them:

- **RED happens en masse in `writing_tests`** (Phase 4a). All failing tests for
  the approved plan are authored together, run (failing for the right reasons),
  and submitted for review via `review_tests`. The diff may contain test files
  only — implementation code in this phase is an automatic CRITICAL review
  finding.
- **The gate**: the test suite iterates through review (`iterate_tests` →
  rewrite → `review_tests`) until zero CRITICAL/HIGH findings remain, then
  `tests_approved` fires **autonomously** and the model enters `implementing`.
- **GREEN and REFACTOR happen in `implementing`** (Phase 4b), against the
  approved suite: minimum code per test, run, refactor while green — per-test
  cadence as usual, but no new failing tests are written here. A genuine
  coverage gap discovered mid-implementation returns to Phase 4a.

Rationale: reviewing the tests before any code exists lets the review shape the
code. Interleaving (test, code, test, code) inside the lifecycle defeats that
gate — it is the failure mode this split exists to prevent.
