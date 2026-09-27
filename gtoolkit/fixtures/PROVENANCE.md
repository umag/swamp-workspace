# Fixture provenance

Recorded 2026-09-27 from a real Glamorous Toolkit **v1.1.601** (macOS x86_64
download) running `GtLMcpServer new port: 4747; addTools: GtLTools gt; start`,
by POSTing JSON-RPC requests with curl:

| File                                                   | Request                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize.json`                                      | `initialize`                                                                                                                               |
| `tools-list.json`                                      | `tools/list` (30 tools)                                                                                                                    |
| `eval-string.json`                                     | `smalltalkCodeEvaluation` of `'it''s' , ' ok'`                                                                                             |
| `eval-object.json`                                     | `smalltalkCodeEvaluation` of `FileLocator root`                                                                                            |
| `eval-error.json`                                      | `smalltalkCodeEvaluation` of `1/0`                                                                                                         |
| `eval-syntax-error.json`                               | `smalltalkCodeEvaluation` of `FileLocator home / "not a string"`                                                                           |
| `unknown-method.json`                                  | JSON-RPC method `nope`                                                                                                                     |
| `view-items.json`, `view-tree.json`, `view-print.json` | the file written by `renderViewCode` (lib/smalltalk.ts) for `gtItemsFor:`, `gtTreeFor:`, `gtPrintFor:` of `FileLocator root`, first 3 rows |

The view fixtures list the top of `/` on the recording machine; nothing else
machine-specific is in them.
