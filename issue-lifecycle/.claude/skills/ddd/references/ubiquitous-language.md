# Ubiquitous Language

## Why It Matters

Every translation between human language and code is a bug waiting to happen. If
the domain expert says "fulfillment" and the code says "processing", someone
will eventually misunderstand the requirement. Ubiquitous language eliminates
this gap.

## Extracting Domain Terms

1. **Listen to domain experts** — the nouns they repeat are your entities/value
   objects; the verbs are your services/methods
2. **Watch for synonyms** — if two people use different words for the same
   thing, pick one and enforce it
3. **Challenge technical defaults** — "Handler", "Manager", "Service" are code
   smells unless the domain expert uses those words
4. **Map bounded contexts** — the same word may mean different things in
   different contexts (e.g., "account" in billing vs authentication)

## Naming Conventions

| Concept            | Convention | Examples                                   |
| ------------------ | ---------- | ------------------------------------------ |
| Aggregate / Entity | PascalCase | `Order`, `Invoice`, `Customer`             |
| Value Object       | PascalCase | `Money`, `Address`, `EmailAddress`         |
| Domain Service     | PascalCase | `PricingService`, `ShippingCalculator`     |
| Method / Operation | camelCase  | `submitOrder`, `calculateDiscount`         |
| Repository         | PascalCase | `OrderRepository`, `CustomerRepository`    |
| File name          | snake_case | `order.ts`, `pricing_service.ts`           |
| Swamp model name   | kebab-case | `order-fulfillment`, `customer-onboarding` |
| Swamp method name  | snake_case | `validate`, `sync`, `create`               |

## Glossary Template

Maintain a glossary for non-obvious domain terms. Keep it in your project docs
or as a comment block in key files:

| Term        | Definition                                    | Code Artifact        | Example                              |
| ----------- | --------------------------------------------- | -------------------- | ------------------------------------ |
| Fulfillment | Process of completing an order for delivery   | `FulfillmentService` | Order moves from "paid" to "shipped" |
| Line Item   | A single product entry within an order        | `OrderItem` (VO)     | "2x Widget @ $9.99"                  |
| Settlement  | Financial reconciliation of a completed order | `settle` method      | Invoice marked as reconciled         |

## Anti-Pattern: Technical Naming

**Bad** — names that describe implementation, not domain:

- `DataProcessor` → What data? What processing?
- `EventHandler` → Which event? What does handling mean?
- `RequestManager` → Managing what about requests?

**Good** — names that describe domain concepts:

- `OrderFulfiller` → Fulfills orders
- `PaymentReceivedListener` → Reacts to payment received events
- `ShipmentTracker` → Tracks shipments
