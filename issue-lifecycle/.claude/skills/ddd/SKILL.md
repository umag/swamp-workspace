---
name: ddd
description: >
  Domain Driven Design guidance for TypeScript/Deno codebases and swamp
  extensions. Apply when writing or modifying code to choose appropriate DDD
  building blocks (entities, value objects, aggregates, domain services,
  repositories, application services) and maintain ubiquitous language.
  Triggers on all code changes to ensure domain model consistency, "domain
  model", "entity", "value object", "aggregate", "domain service",
  "repository", "bounded context", "DDD", "building block".
---

# Domain Driven Design

Apply these patterns when implementing domain logic in TypeScript/Deno.

## Workflow: Applying DDD to a Code Change

Follow these steps whenever writing or modifying domain code:

1. **Identify the domain concept** — What real-world thing or operation does
   this code represent? Use domain expert language, not technical terms.
2. **Select the building block** — Use the decision flow below to choose the
   correct DDD type (Value Object, Entity, Aggregate, Domain Service,
   Application Service, Repository).
3. **Implement using the pattern** — Apply the TypeScript patterns (see inline
   example below and [references/patterns.md](references/patterns.md)).
4. **Verify naming against ubiquitous language** — Check that names match domain
   expert terminology and are consistent with the glossary.
5. **Validate invariants and boundaries** — Run through this checklist:
   - Every aggregate root has exactly one repository — no repository per plain
     entity.
   - No domain object imports from persistence layers or infrastructure
     packages.
   - Child entities are only mutated through the aggregate root — never
     directly.
   - Each swamp model owns a single consistency boundary; unrelated concerns
     live in separate models wired with CEL expressions.
   - All new domain terms are added to the ubiquitous language glossary.

## Building Block Selection

Choose the appropriate type based on these criteria:

| Type                    | Identity                 | Mutability              | Swamp mapping           |
| ----------------------- | ------------------------ | ----------------------- | ----------------------- |
| **Value Object**        | None (equality by value) | Immutable               | Zod schema (`z.object`) |
| **Entity**              | Has unique ID            | Mutable                 | resource instance       |
| **Aggregate**           | Root entity + children   | Root controls mutations | swamp model             |
| **Domain Service**      | None                     | Stateless               | model method            |
| **Repository**          | None                     | Stateless               | datastore provider      |
| **Application Service** | None                     | Stateless               | workflow job            |

> **Swamp-specific rule**: one swamp model = one aggregate = one consistency
> boundary. If two things change independently, they belong in separate models.

### Quick Decision Flow

```
Does it have a unique identity that matters?
├─ No → Value Object
└─ Yes → Does it enforce invariants over child objects?
         ├─ Yes → Aggregate Root (→ swamp model)
         └─ No → Entity (part of an aggregate, no own repository)

Does it orchestrate multiple domain objects for a use case?
└─ Yes → Application Service (→ workflow job in the application/libswamp layer)
```

## Inline Pattern Examples

### Value Object (TypeScript)

```typescript
// Good: wrap primitives in Value Objects to avoid primitive obsession
import { z } from "zod";

const EmailSchema = z.string().email().brand<"Email">();
type Email = z.infer<typeof EmailSchema>;

function createEmail(raw: string): Email {
  return EmailSchema.parse(raw); // throws if invalid
}
```

### Aggregate Root (TypeScript)

```typescript
// Good: Aggregate root controls all mutations and enforces invariants
class Order {
  private readonly _id: OrderId;
  private _items: OrderItem[] = [];
  private _status: OrderStatus;

  constructor(id: OrderId) {
    this._id = id;
    this._status = OrderStatus.Draft;
  }

  addItem(product: ProductId, quantity: Quantity): void {
    if (this._status !== OrderStatus.Draft) {
      throw new Error("Cannot modify a confirmed order");
    }
    // Invariant enforced here — never modify _items from outside
    this._items.push(new OrderItem(product, quantity));
  }

  confirm(): void {
    if (this._items.length === 0) {
      throw new Error("Cannot confirm an empty order");
    }
    this._status = OrderStatus.Confirmed;
  }
}
```

See [references/patterns.md](references/patterns.md) for full implementation
examples covering Value Objects, Entities, Aggregates, Domain Services,
Repositories, Application Services, Domain Events, and Notification Events.

## Ubiquitous Language

Update the project's ubiquitous language glossary when:

- **New domain concept** introduced (add term + definition)
- **Meaning clarified** through discussion (refine definition)
- **Naming conflicts** discovered (resolve and document)
- **Bounded context boundary** identified (note context for term)

Location: Document terms in code via types/interfaces. Add non-obvious terms to
project documentation.

### Naming Rules

- Use domain expert terminology, not technical jargon
- Prefer nouns for entities/value objects: `Order`, `Money`, `Address`
- Prefer verbs for domain services: `PricingService`, `ShippingCalculator`
- Name aggregates by their root: `Order` (not `OrderAggregate`)
- File names match the domain concept: `order.ts`, `pricing_service.ts`
- If the domain expert wouldn't recognize the name, it's wrong

See [references/ubiquitous-language.md](references/ubiquitous-language.md) for
glossary template and naming conventions.

## Anti-Patterns to Avoid

- **Anemic domain model**: Entities with only getters/setters, logic in services
  → move behavior into the entity
- **God aggregate**: Too many entities under one root → split by invariant
  boundary
- **Repository per entity**: Only aggregate roots get repositories
- **Leaking persistence**: Domain objects should not know about storage
- **Primitive obsession**: Using strings for emails, IDs, money → create Value
  Objects
- **Skipping aggregate boundary**: Modifying child entities directly → go
  through aggregate root
- **Technical naming**: "Handler", "Manager", "Processor" → use domain verbs

See [references/anti-patterns.md](references/anti-patterns.md) for expanded
examples with before/after code.
