# Test Organization

## Directory Layout

```
extensions/models/my-model/
  my_model.ts                    # Source
  my_model.test.ts               # Unit tests (next to source)
  _test_utils/
    mock_client.ts               # Shared test utilities
    factories.ts                 # Test data factories
  _fixtures/
    sample_api_response.json     # Test data snapshots

integration/
  my_model_integration.test.ts   # Cross-module tests
  _helpers/
    setup_test_env.ts            # Integration test setup

e2e/
  full_workflow.test.ts          # End-to-end scenarios
```

## Naming Helpers

| Prefix    | Purpose                  | Example                         |
| --------- | ------------------------ | ------------------------------- |
| `create*` | Test data factory        | `createTestOrder(overrides)`    |
| `mock*`   | Mock implementation      | `mockS3Client(responses)`       |
| `stub*`   | Stub with canned data    | `stubApiResponse(status, body)` |
| `fake*`   | In-memory implementation | `fakeOrderRepository()`         |
| `with*`   | Wrapper/context setup    | `withMockedFetch(fn)`           |

## When to Use Fixtures vs Inline Data

**Fixtures** (`_fixtures/`):

- Large response payloads (API responses, config files)
- Data shared across multiple test files
- Binary data or complex JSON structures
- Snapshot testing baselines

**Inline data**:

- Small, test-specific values
- Data that clarifies the test's intent
- Values that would lose context if separated from the test

```typescript
// Good: inline — the values are the point of the test
Deno.test("Money.add sums amounts", () => {
  const a = Money.create(10, "USD");
  const b = Money.create(20, "USD");
  assertEquals(a.add(b).amount, 30);
});

// Good: fixture — large API response is incidental
Deno.test("parseApiResponse extracts instances", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile("./_fixtures/ec2_response.json"),
  );
  const instances = parseApiResponse(raw);
  assertEquals(instances.length, 3);
});
```

## Organizing by Behavior vs by Function

**Prefer behavior-based grouping** using `t.step()`:

```typescript
Deno.test("ShoppingCart", async (t) => {
  await t.step("adding products", async (t) => {
    await t.step("creates new item for unknown product", () => {/* ... */});
    await t.step("increments quantity for known product", () => {/* ... */});
  });

  await t.step("removing products", async (t) => {
    await t.step("removes item entirely", () => {/* ... */});
    await t.step("no-ops for unknown product", () => {/* ... */});
  });

  await t.step("calculating total", async (t) => {
    await t.step("returns zero for empty cart", () => {/* ... */});
    await t.step("sums all line items", () => {/* ... */});
  });
});
```

## Sharing Test Utilities

Keep shared utilities in `_test_utils/` prefixed with underscore so Deno's test
runner doesn't try to execute them.

```typescript
// _test_utils/factories.ts
export function createTestOrder(overrides: Partial<OrderProps> = {}): Order {
  return Order.create({
    id: createOrderId("test-order-1"),
    status: "draft",
    items: [],
    ...overrides,
  });
}
```

Import in tests:

```typescript
import { createTestOrder } from "./_test_utils/factories.ts";

Deno.test("submit changes status to submitted", () => {
  const order = createTestOrder({ items: [sampleItem] });
  order.submit();
  assertEquals(order.status, "submitted");
});
```
