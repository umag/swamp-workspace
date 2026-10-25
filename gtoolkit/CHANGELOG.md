# Changelog

## 2026.10.25.10

- Repo-wide republish; no functional change.

## 2026.10.15.9

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.8

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.7

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.6

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.5

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.4

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.3

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.1

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.14.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.09.28.1

- The bundled `gtoolkit` skill is now published with the extension (the manifest
  lacked `skills:`).
- Skill references: `pharo-syntax.md` (Smalltalk for evaluations), `gt-apis.md`
  (Phlow views, examples, Lepiter, the UI thread, Brick widgets, windows and
  screenshots, external processes, saving) and `pitfalls.md` (every failure seen
  driving GT, with the fix).

## 2026.09.27.1

- First release. `@magistr/gtoolkit` drives a running Glamorous Toolkit through
  GT's own MCP server (`GtLMcpServer` with `GtLTools gt`): `start`, `stop`,
  `status`, `eval`, `view`, `open`, `inspect`, `screenshot`, `tools`, `tool`.
- Views are rendered to rows through Phlow's declarative specifications (the
  Remote Phlow serialisation), following forward views; large results travel
  through files because GT truncates print strings at 50 000 characters.
- `inspect` queues the window on GT's UI frame (its main GtWorld): opening an
  inspector from the MCP worker process raised BrEditorWrongThreadError.
- Every caller value that becomes Smalltalk is a quoted literal or passes a
  strict identifier / selector / object-id grammar.
