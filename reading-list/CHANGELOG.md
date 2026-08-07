# Changelog

All notable changes to `@magistr/reading-list`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are CalVer (`YYYY.0M.0D.N`), matching the swamp registry.

## 2026.08.07.1

### Security

- **Feed links are now restricted to `http(s)` at the parse boundary.** Both
  `parseFeedXml` and `parseLinkedInProfile` accepted any string as an article
  URL, so a hostile or compromised feed could emit
  `<link>javascript:alert(1)</link>` and have it rendered into an `<a href="…">`
  in the Telegram digest. Escaping does not help here — an `href="javascript:…"`
  needs no metacharacter to fire. Links carrying any other scheme
  (`javascript:`, `data:`, `file:`, `mailto:`) and relative or protocol-relative
  links are now dropped, and the check lives in one place rather than being
  re-derived by each renderer. Found by the new adversarial suite.
- **`hostOf` no longer returns an empty string for a hostile scheme.**
  `new URL("javascript:alert(1)")` parses successfully with an empty hostname,
  so the previous try/catch let `""` through — falsy, but defined, leaving every
  caller to remember that `""` meant failure. It now returns `undefined` for
  anything that is not `http(s)` or that has no hostname.

### Changed

- `digestMessage`'s `telegramModel` send **fails loudly when the Telegram model
  returns no resource.** It previously logged `Sent digest via <model>`
  unconditionally on the line after the `await`, so a send that never happened
  was indistinguishable from one that did. Under `swamp serve`,
  `context.runModel` was observed returning without executing the callee — three
  consecutive green scheduled runs delivered nothing while logging success. A
  real send writes a `sentMessage` resource, so the returned handles are now
  required and their absence throws. Prefer a dedicated Telegram workflow
  **step** over this argument; a step and a direct method run both work where
  the in-method call did not.

### Added

- Four test suites completing the workspace quality standard, alongside the
  existing contract suite: `methods` (every method's success and failure paths,
  with `fetch` stubbed), `adversarial` (injection, malformed and gated
  responses, hostile selectors), `coverage` (regression locks on previously
  untested guards), and `property-invariant-flow` (fast-check, with an
  `FC_NUM_RUNS` soak knob). 109 tests total.
- `deno task test:soak` for a high-iteration property run.

## 2026.08.04.1

- Initial release: tiered RSS/Atom and LinkedIn reading list with `fetch`,
  `latest`, `digestMessage`, `markRead`, `markUnread`, `discover` and `sources`.
