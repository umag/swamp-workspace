---
title: Link and tag extraction fixture
tags:
  - fixture
---

# Heading one

Some prose linking to [[target-note]] and [[other-note|with an alias]] and
[[third-note#a-heading]].

## Heading two

An inline #inline-tag and a #nested/tag here. Not a tag: `#in-code-span` and
https://example.com/#fragment should both be ignored.

### Heading three

Refs: fixes #1234 and PR-5678, ticket ABC-42 and LONGER-1.

#### Heading four

##### Heading five is too deep to extract
