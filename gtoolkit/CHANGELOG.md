# Changelog

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
