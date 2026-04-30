# DDD Anti-Patterns

## 1. Anemic Domain Model

Data classes with only getters/setters — all logic lives in services.

**Before** (anemic):

```typescript
class Order {
  id: string;
  status: string;
  items: OrderItem[];
}

class OrderService {
  submit(order: Order): void {
    if (order.items.length === 0) throw new Error("Empty order");
    order.status = "submitted"; // Logic outside the entity
  }
}
```

**After** (rich domain model):

```typescript
class Order {
  submit(): void {
    if (this._items.length === 0) {
      throw new Error("Cannot submit empty order");
    }
    this._status = "submitted"; // Entity owns its behavior
  }
}
```

## 2. God Aggregate

One aggregate with too many entities and responsibilities.

**Symptom**: aggregate with 20+ fields, methods for unrelated concerns, long
transaction times, frequent merge conflicts.

**Fix**: Split by invariant boundary. Ask: "Which entities MUST be consistent
with each other in a single transaction?" Only those belong in the same
aggregate.

## 3. Leaking Domain Logic

Business rules in controllers, workflows, or CLI commands instead of domain
layer.

**Before** (leaked):

```typescript
// In a workflow step or CLI command
if (customer.balance < order.total) {
  throw new Error("Insufficient funds");
}
order.status = "approved";
```

**After** (encapsulated):

```typescript
// In the domain
class Order {
  approve(customer: Customer): void {
    if (customer.balance.lessThan(this.total)) {
      throw new InsufficientFundsError(customer.id, this.total);
    }
    this._status = "approved";
  }
}
```

## 4. Technical Naming

Using implementation words instead of domain words.

| Bad (Technical)  | Good (Domain)            | Why                                    |
| ---------------- | ------------------------ | -------------------------------------- |
| `DataProcessor`  | `InvoiceGenerator`       | Says what it actually does             |
| `EventHandler`   | `PaymentReceivedPolicy`  | Names the domain event and its purpose |
| `RequestManager` | `OrderSubmissionService` | Names the domain operation             |
| `BaseEntity`     | (just use the entity)    | No need for inheritance marker         |
| `Utils`          | (spread into domain)     | Utility classes hide domain concepts   |

## 5. Skipping the Aggregate Boundary

Modifying child entities without going through the aggregate root.

**Before** (boundary violation):

```typescript
const item = order.items[0]; // Direct child access
item.quantity = 5; // Mutation bypasses aggregate
```

**After** (through the root):

```typescript
order.updateItemQuantity(item.id, 5); // Root enforces invariants
```

## 6. Primitive Obsession

Using raw strings/numbers for domain concepts.

**Before** (primitives):

```typescript
function sendEmail(to: string, amount: number, currency: string) {}
```

**After** (value objects):

```typescript
function sendEmail(to: EmailAddress, amount: Money) {}
```

Value Objects make invalid states unrepresentable and carry domain behavior
(validation, formatting, comparison).

## 7. Repository for Non-Aggregates

Creating repositories for entities that are part of an aggregate.

**Rule**: Only aggregate roots get repositories. Child entities are loaded and
saved through their aggregate root's repository.

**Bad**: `OrderItemRepository` — order items are part of the Order aggregate
**Good**: `OrderRepository` — loads the full Order including its items
