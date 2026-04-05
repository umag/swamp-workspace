# Deno Test Patterns

## Basic Test

```typescript
import { assertEquals, assertThrows, assertRejects } from "@std/assert";

Deno.test("add returns sum of two numbers", () => {
  assertEquals(add(2, 3), 5);
});
```

## Async Test

```typescript
Deno.test("fetchUser returns user data", async () => {
  const user = await fetchUser("abc-123");
  assertEquals(user.name, "Alice");
});
```

## Sub-tests with t.step()

```typescript
Deno.test("Order lifecycle", async (t) => {
  const order = Order.create(createOrderId("test-1"));

  await t.step("starts in draft status", () => {
    assertEquals(order.status, "draft");
  });

  await t.step("allows adding items when draft", () => {
    order.addItem(sampleItem);
    assertEquals(order.items.length, 1);
  });

  await t.step("can be submitted with items", () => {
    order.submit();
    assertEquals(order.status, "submitted");
  });
});
```

## Asserting Throws

```typescript
// Sync
Deno.test("Money.create throws on negative amount", () => {
  assertThrows(
    () => Money.create(-1, "USD"),
    Error,
    "Amount cannot be negative",
  );
});

// Async
Deno.test("fetchUser rejects when not found", async () => {
  await assertRejects(
    () => fetchUser("nonexistent"),
    Error,
    "User not found",
  );
});
```

## Regex Assertions

```typescript
import { assertMatch } from "@std/assert";

Deno.test("error message includes resource ID", () => {
  assertMatch(errorMsg, /resource-\d+/);
});
```

## Timeout Testing with AbortController

```typescript
Deno.test("operation respects abort signal", async () => {
  const controller = new AbortController();
  const promise = longRunningOp({ signal: controller.signal });
  controller.abort();
  await assertRejects(() => promise, DOMException, "aborted");
});
```

## FakeTime for Time-Dependent Tests

```typescript
import { FakeTime } from "@std/testing/time";

Deno.test("cache expires after TTL", () => {
  using time = new FakeTime();
  const cache = new Cache({ ttl: 60_000 });
  cache.set("key", "value");

  time.tick(59_000);
  assertEquals(cache.get("key"), "value");

  time.tick(2_000);
  assertEquals(cache.get("key"), undefined);
});
```

## Test Filtering

```bash
# Run only tests matching a pattern
deno test --filter "Order"

# Run a specific test file
deno test extensions/models/my_model/my_model.test.ts
```

## Test Permissions

```typescript
Deno.test({
  name: "reads config from filesystem",
  permissions: { read: ["."] },
  fn: async () => {
    const config = await readConfig("./config.json");
    assertEquals(config.version, "1.0");
  },
});
```

## Asserting Logs

Using swamp's `createModelTestContext`:

```typescript
Deno.test("method logs progress", async () => {
  const { context, getLogsByLevel } = createModelTestContext();
  await model.methods.sync.execute({}, context);

  const infoLogs = getLogsByLevel("info");
  assertEquals(infoLogs.length >= 2, true); // entry + completion
  assertMatch(infoLogs[0].message, /syncing/i);
});
```

## Asserting Events

```typescript
Deno.test("method emits domain events", async () => {
  const { context, getEvents } = createModelTestContext();
  await model.methods.create.execute({}, context);

  const events = getEvents();
  assertEquals(events[0].type, "resourceCreated");
});
```
