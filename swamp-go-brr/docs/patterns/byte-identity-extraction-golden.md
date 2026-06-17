---
issue: gobrr-desired-state-workorders
date: 2026-06-17
kind: pattern
---

# Pin a behaviour-preserving extraction with a byte-identity golden

When extracting inline logic into a pure function WITHOUT intending to change
its output, freeze the current output as a golden literal in the test and assert
the extracted function reproduces it byte-for-byte (`got === want`). Authored
TDD-first, the golden is RED until the extraction lands and GREEN exactly when
the extraction is faithful — catching whitespace/ordering drift that structural
assertions miss. Confine any NEW behaviour (here: the desired-state branch) so
the golden path stays untouched.
