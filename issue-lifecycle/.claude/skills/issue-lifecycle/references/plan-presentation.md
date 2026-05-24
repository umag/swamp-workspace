# Plan presentation format

This file governs **how you present the plan to the human** at
[planning.md](planning.md) Step 9 — the approve / refine / reject decision
point. It is about *presentation*, not the stored plan YAML (that shape lives
in planning.md Step 7). The presentation is a rendering of the stored
`summary`, `steps`, `dddAnalysis`, `potentialChallenges`, and the aggregated
`reviews` — re-shaped for a 30-second human scan.

## Core principle: the reader skims, not reads

The human does not read a plan top to bottom — they skim it to make one
binary decision (ship / refine / reject). Optimize for a 30-second scan, not
for completeness. Two consequences:

- **Misinterpreted scope is the failure to catch.** The single most common
  way a plan is wrong is that the agent understood the task differently than
  the human meant. That must surface in the first 10 seconds (the Goal line
  and the Scope table), not on line 80.
- **Inverted pyramid / BLUF.** Bottom line up front. The first 5–8 lines
  contain the whole plan condensed; detail follows in decreasing order of
  importance. The reader should be able to stop at any line and still have
  the gist.

> This presentation format is the human-facing render. The **full verbatim
> plan content** still governs the strict `approve_plan` gate — see
> planning.md / SKILL.md. When the human is at the final approval question,
> they must be able to see every step, finding, and risk. Skimmable ≠
> truncated: the scan layer goes on top, the full content stays available.

## Output structure (in this order)

1. **Goal** — one sentence. What you'll build, in the user's own terms. This
   is where misinterpretation is caught.
2. **Approach** — 2–3 sentences. The direction chosen, not the how-to.
   Example: "Centralized middleware instead of per-endpoint decorators,
   because config must be runtime-tunable."
3. **Domain impact** — exactly 4 lines (see DDD section). Mandatory in this
   codebase.
4. **Scope** — a markdown table of files: `| File | Op | DDD role |`. `Op` is
   one of `A` add, `M` modify, `D` delete, `R` rename. This is the most
   important block for fast verification — a surprising file here means
   "refine".
5. **Risks** — only if any: breaking changes, migrations, new env vars,
   schema changes, public API changes, DDD red flags. Prefix `## ⚠ Risks`.
   If there are none, **omit the section entirely** — don't write "no risks".
6. **Steps** — numbered list, **one clause each**: `verb + object + location`.
   No commas chaining clauses, no colons introducing sub-lists, no "and" / "then"
   joining actions. Push rationale and invariants into Risks, not into the step
   line. One action per step — if a step does two things, split it. Max 10 steps;
   if you need more, split the work.
   - Good: `Add JsonFormatter in src/formatters/json_formatter.py`
   - Bad: `Add JsonFormatter, wire it into the CLI, and add tests` (three clauses)
7. **Review coverage** — one prose line naming the reviewers that will run,
   with the trigger for any non-default one. `code` and `adversarial` **always**
   run. Add `security` when the change touches credentials, network calls,
   user input, or file I/O; add `ux` when it changes CLI output, help text,
   error messages, or JSON mode; add `skill` when it edits SKILL.md or skill
   references. Write it as prose, **not** a YAML/code block (the no-code-blocks
   rule applies). Example: `Review coverage: code, adversarial, ux (changes
   CLI/JSON output).` See [review-matrix.md](review-matrix.md) for the full
   activation table.
8. **Non-goals** — optional, max 3 bullets. What you're consciously not doing.
9. **Open questions** — only if you genuinely need input. Otherwise omit.

## Hard rules

- **Length: 40–80 lines** for a medium feature. Under that, probably
  under-thought. Over ~100, escalate to an HTML artifact
  ([plan-html-artifacts.md](plan-html-artifacts.md)).
- **No code in the plan.** Only file paths and operation labels. The one
  exception: a new public API signature where the meaning is otherwise
  unclear.
- **No marketing words**: robust, comprehensive, elegant, seamless, modern.
- **No "why this matters"** — the human ordered it; no justification needed.
  A plan is a contract, not an RFC.
- **Bold only for filenames and final decision verbs.** Never for emphasis.
- **One line = one idea.** Multi-clause sentences are banned in steps.
- **No rejected alternatives** unless the choice is non-obvious — then one
  line: "chose A over B because X".

## Terminal rendering

A terminal is ~80 columns × ~30 rows. Optimize for it:

- **Hierarchy via typography, not indentation.** `##` / `###` headings render
  with distinct weight/colour in the Claude Code CLI — that is the primary
  scanning tool.
- **The file table is the single most important pattern.** It replaces a
  paragraph of "I will modify X, then update Y, then create Z" with a block
  the reader can stop on at any row.
- **Unicode markers, sparingly** (F-pattern anchors): `⚠` / `!` for risks,
  `✓` for resolved, `→` for steps/consequences. More than ~3 symbol types is
  noise, and some SSH/tmux setups break them. If
  `agent-constraints/planning-conventions.md` sets a "no-unicode" flag,
  honour it and drop the markers.

## DDD-aware additions (mandatory — this codebase is tactical DDD)

The codebase uses tactical DDD (entities, aggregates, value objects,
repositories) and the team works in code and prose, not diagrams. The change
DDD brings to a plan is **vocabulary, not visualization**. A DDD-aware plan
speaks the ubiquitous language; file paths are derived from domain decisions,
not the other way around. "Adding value object `EmailAddress` to aggregate
`User` in the `Identity` context" lets the reader check *semantics*
(invariants, boundary leaks), which is where plan quality lives.

### 1. Domain impact section (after Approach, before Scope) — exactly 4 lines

```markdown
## Domain impact
Context: Identity (existing, core)
Aggregates touched: User (root)
New tactical patterns: EmailAddress (VO), UserActivated (event)
Crosses context boundary: No
```

- **Context** — existing or new; classify core / supporting / generic.
- **Aggregates touched** — mark roots.
- **New tactical patterns** — entity / VO / event / service / repository.
- **Crosses context boundary** — Yes/No; if Yes, name the integration
  pattern (OHS / ACL / SK / CF / PL).

Source this from the plan's `dddAnalysis` field.

### 2. Scope table uses a "DDD role" column

Format each row's role as "Pattern: Name [+ op]":

```markdown
| File                          | Op | DDD role                    |
|-------------------------------|----|-----------------------------|
| domain/identity/user.py       | M  | Aggregate root: User        |
| domain/identity/email.py      | A  | VO: EmailAddress            |
| domain/identity/events.py     | M  | Domain event: UserActivated |
| application/identity/svc.py   | M  | Application service         |
| infra/identity/repo.py        | M  | Repository: UserRepository  |
```

The DDD role column is the skim anchor: at a glance the reader sees whether an
**aggregate root** is changing (dangerous — invariants), a **value object**
is being added (safe), or a **repository** is touched (boundary changed).

### 3. Red flags as explicit risks

This is the highest-leverage DDD output. If the plan involves any of these,
list them in the `Risks` section in plain text — do **not** skip, do **not**
soften:

- **Aggregate boundary change** (split, merge, new aggregate) — high risk of
  invariant breakage.
- **New cross-aggregate reference NOT by id** — violates aggregate isolation;
  transactional consequences.
- **Domain logic in the application or infra layer** — anemic-model smell.
- **Synchronous call across a bounded context boundary** — should be
  event-driven or via an ACL.
- **Aggregate root method that mutates another aggregate's state** — violates
  one-aggregate-per-transaction.

These are exactly the things that pass code review in DDD projects and hurt
later. Catching them at plan-approve is where the value is.

## Refine behavior

When the human asks for a change rather than approving:

- **Show a diff, not a fresh wall.** Present what changed against the previous
  plan version, not the entire plan re-rendered. (Each `plan` call bumps
  `planVersion`; the prior round is preserved.)
- **Self-prompt "what might surprise the user?"** before re-presenting.
  Empirically this surfaces risks better than asking "what are the risks"
  directly — it forces you to look at the plan from the reader's side.
- **Persisted plan, drift detection.** The approved plan lives in the model
  state (and Claude Code persists plan-mode plans under `~/.claude/plans/`).
  If implementation later drifts from the approved plan, diff against it and
  re-plan rather than silently diverging.

## Diagrams: OFF by default

Do **not** generate Mermaid diagrams in the plan. The team works in prose,
and tactical DDD is largely readable from the types (roots by type, VOs by
immutability, repositories by interface). When you would otherwise draw a
diagram, write 1–2 sentences of prose instead: "This adds a dependency from
Billing to Identity via an anti-corruption layer at
`billing/infra/identity_acl.py`."

Two exceptions, both opt-in:

- **3+ bounded contexts / a genuinely complex integration** — end the plan
  with one line: *"A context map could clarify this — generate one?"* and
  wait. Conventions live in
  [plan-ddd-diagrams.md](plan-ddd-diagrams.md).
- **Strategic build-vs-buy framing** (own implementation vs managed service,
  custom→commodity migration, 3+ alternatives at different maturity) — a
  Wardley map may belong, but as a *discovery/scoping* step before the plan,
  not inside it. See [plan-wardley.md](plan-wardley.md).

## Escalating to an HTML artifact

If the plan is large or comparative, propose an HTML artifact instead of the
terminal render. Triggers and content: [plan-html-artifacts.md](plan-html-artifacts.md).
The short version: **>4 files touched, OR migration/schema/breaking change,
OR 3+ alternatives to compare, OR multi-issue/multi-PR** → offer HTML
proactively.

## Canonical example (DDD, terminal, ~35 lines)

```markdown
## Goal
Add email-based account activation for new users.

## Approach
Activation as an explicit domain concept: EmailAddress VO, ActivationToken VO,
UserActivated domain event emitted when activate() succeeds. Token has a 24h
TTL invariant.

## Domain impact
Context: Identity (existing, core)
Aggregates touched: User (root)
New tactical patterns: EmailAddress (VO), ActivationToken (VO), UserActivated (event)
Crosses context boundary: No (event emitted locally; no cross-context sync calls)

## Scope

| File                                | Op | DDD role                     |
|-------------------------------------|----|------------------------------|
| domain/identity/user.py             | M  | Aggregate root: + activate() |
| domain/identity/email.py            | A  | VO: EmailAddress             |
| domain/identity/activation_token.py | A  | VO: ActivationToken          |
| domain/identity/events.py           | M  | Event: UserActivated         |
| application/identity/service.py     | M  | Use case: ActivateUser       |
| infra/identity/repo.py              | M  | Repository: UserRepository   |
| tests/domain/identity/test_user.py  | M  | Invariant tests              |

## ⚠ Risks
- Token TTL is a new invariant — must be tested in both branches
  (within window / expired).
- activate() is a new state-changing method on the User aggregate root.
  Verify it can't be called twice (idempotency invariant).

## Steps
1. Add EmailAddress VO in domain/identity/email.py
2. Add ActivationToken VO in domain/identity/activation_token.py
3. Add UserActivated event in domain/identity/events.py
4. Add User.activate(token) method in domain/identity/user.py
5. Persist activation state in infra/identity/repo.py
6. Add ActivateUserService in application/identity/service.py
7. Add invariant tests in tests/domain/identity/test_user.py

## Review coverage
code, adversarial, security (handles activation tokens)

## Non-goals
- Email re-send flow (separate issue)
- Manual activation by admin (separate issue)

## Open questions
- Should expired-token cleanup be in this issue or separate? (recommend separate)
```

No diagram. The plan stands on its own — and the decision takes ~10 seconds:
scan the Scope table and Risks; if files and risks match expectation,
approve; if not, refine.
