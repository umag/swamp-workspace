<!-- BEGIN swamp managed section - DO NOT EDIT -->
# Project

This repository is managed with [swamp](https://github.com/systeminit/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search local types with `swamp model type search <query>`, (b) search community extensions with `swamp extension search <query>`, (c) if a community extension exists, install it with `swamp extension pull <package>` instead of building from scratch, (d) only create a custom extension model in `extensions/models/` if nothing exists. Use the `swamp-extension-model` skill for guidance. The `command/shell` model is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** When a model covers the domain but lacks the method you need, extend it with `export const extension` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use `swamp model type describe <type> --json` to check available methods.
3. **Use the data model.** Once data exists in a model (via `lookup`, `start`, `sync`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire models together with CEL expressions. Always prefer `data.latest("<name>", "<dataName>").attributes.<field>` over the deprecated `model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.
5. **Verify before destructive operations.** Always `swamp model get <name> --json` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate `swamp model method run` calls against the same model. Multiple parallel calls against the same model contend on the per-model lock, causing timeouts. A single fan-out method acquires the lock once and produces all outputs in one execution. Check `swamp model type describe` for methods that accept filters or produce multiple outputs.
7. **Extension npm deps are bundled, not lockfile-tracked.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. `deno.lock` and `package.json` do NOT cover extension model dependencies — this is by design. Always pin explicit versions in `npm:` import specifiers (e.g., `npm:lodash-es@4.17.21`).
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze model output (security reports, cost analysis, compliance checks, summaries), create a report extension. Use the `swamp-report` skill for guidance.

## Skills

**IMPORTANT:** Always load swamp skills, even when in plan mode. The skills provide
essential context for working with this repository.

- `swamp-model` - Work with swamp models (creating, editing, validating)
- `swamp-workflow` - Work with workflows (creating, editing, running)
- `swamp-vault` - Manage secrets and credentials
- `swamp-data` - Manage model data lifecycle
- `swamp-report` - Create and run reports for models and workflows
- `swamp-repo` - Repository management
- `swamp-extension-model` - Create custom TypeScript models
- `swamp-extension-driver` - Create custom execution drivers
- `swamp-extension-datastore` - Create custom datastore backends
- `swamp-extension-vault` - Create custom vault providers
- `swamp-issue` - Submit bug reports and feature requests
- `swamp-troubleshooting` - Debug and diagnose swamp issues

## Getting Started

Always start by using the `swamp-model` skill to work with swamp models.

## Commands

Use `swamp --help` to see available commands.
<!-- END swamp managed section -->

## Development Practices

### Domain-Driven Design
- Every model/extension maps to a domain concept. Use the `ddd` skill.
- Swamp models = Aggregates, methods = Domain Services, workflows = Application Services.
- Name everything using domain language, not technical jargon.

### Test-Driven Development
- All features and bug fixes follow Red-Green-Refactor. Use the `tdd` skill.
- Write the failing test FIRST. No code without a test.
- Unit tests: `foo.test.ts` next to `foo.ts`. Integration: `integration/`. E2E: `e2e/`.

### Moldable Development
- Query live data before reading source code.
- Build domain-specific views with reports instead of ad-hoc scripts.
- Every investigation starts with the domain tool, not generic shell commands.
- Reduce time-to-answer (ttA) by building contextual micro tools.

### Code Review (5 Local Reviewers)
- `/review-code` — general review before committing (CLAUDE.md, DDD, TDD, types)
- `/review-adversarial` — adversarial review for core/extension code (7 dimensions)
- `/review-ux` — UX review for CLI output, help text, error messages
- `/review-security` — security audit for credential/API/input handling code
- `/review-skill` — quality review for new/modified skills

## Additional Skills
- `ddd` - Domain-Driven Design building block selection and patterns
- `tdd` - Test-Driven Development workflow enforcement
- `moldable-dev` - Moldable development principles and domain inspectors
- `review-code` - General code review (CLAUDE.md compliance, architecture, tests)
- `review-adversarial` - Adversarial review (7 dimensions, assumes broken)
- `review-ux` - UX review (CLI output, help text, JSON mode, consistency)
- `review-security` - Security review (injection, OWASP, secrets, supply chain)
- `review-skill` - Skill quality review (structure, triggers, progressive disclosure)
