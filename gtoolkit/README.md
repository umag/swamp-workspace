# @magistr/gtoolkit

Drive a running [Glamorous Toolkit](https://gtoolkit.com) (GT) from swamp — and
so from Claude.

GT ships its own MCP server, `GtLMcpServer`, with the tools of its LLM harness
(`GtLTools gt`): class and method search, Lepiter pages and snippets, compiling
methods, running examples, Smalltalk evaluation with an object storage. This
model starts GT with that server on and talks to it. It does not reimplement GT;
it adds only what GT's tools do not return directly: inspector views as rows,
drilling into an item, opening inspector windows, and PNG screenshots.

## Setup

```sh
swamp extension source add <path-to>/gtoolkit --only models
swamp model create @magistr/gtoolkit gt --global-arg gtHome=/path/to/GlamorousToolkit-MacOS-x86_64-v1.1.601
swamp model method run gt start          # launches GT with the MCP server, waits until it answers
```

| Global argument    | Default                  |                                                                                                     |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `gtHome`           | —                        | GT install directory (holds `GlamorousToolkit.app` or `bin/`, and the image); only `start` needs it |
| `image`            | `GlamorousToolkit.image` | image inside `gtHome`                                                                               |
| `host`, `port`     | `127.0.0.1`, `4747`      | where GT's MCP server listens                                                                       |
| `exchangeDir`      | `$TMPDIR/swamp-gtoolkit` | where GT writes large results and screenshots                                                       |
| `requestTimeoutMs` | `120000`                 | per request                                                                                         |

## Methods

| Method           | Does                                                                                                                    | Writes                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `status`         | Is GT answering? tool count, open windows, GT processes. Never fails when GT is down                                    | `status`                |
| `start`          | Launch GT (`GlamorousToolkit-cli --interactive <image> st --no-quit boot.st`), wait for it; no-op if it already answers | `action`                |
| `stop`           | Quit GT, `save=true` to save the image first; no-op if not answering                                                    | `action`                |
| `eval`           | Evaluate Smalltalk; `bindings={"name":"<objectId>"}` refers to stored objects                                           | `evaluation`            |
| `view`           | Render one view (`view` = selector or tab title) to `columns` + `rows`, or `text`                                       | `view`                  |
| `open`           | Open row `index` of a view, as a click would                                                                            | `evaluation`            |
| `inspect`        | Open a GT inspector window on an object (by id, or on the result of `code`)                                             | `action`                |
| `screenshot`     | PNG of an open window (`window` = title substring) or of one view offscreen                                             | `screenshot`            |
| `tools` / `tool` | List / call any GT MCP tool                                                                                             | `tools` / `tool-result` |

A session:

```sh
swamp model method run gt eval --input code="FileLocator home / 'dev_tmp'"
swamp data get gt evaluation --json | jq '.content | {objectId, views}'
swamp model method run gt view --input objectId=<id> --input view=Items --input count=20
swamp model method run gt open --input objectId=<id> --input view=Items --input index=3
swamp model method run gt screenshot --input objectId=<id> --input view=Tree
swamp model method run gt tool --input name=searchForClasses --input 'arguments={"query":"LePage"}'
```

The bundled skill (`.claude/skills/gtoolkit/SKILL.md`) teaches Claude this loop
and the argument shapes of GT's tools.

## How views become data

`view` evaluates `(obj perform: #gtXxxFor: with: GtPhlowEmptyView new)`, follows
forward views (`computeForwardedView`), converts the view with
`asGtDeclarativeView` — the serialisable specification Remote Phlow uses to show
Python and GemStone objects in GT — and asks its data source for
`retrieveItems:fromIndex:` or `getText`. GT writes the result as JSON to a file
in `exchangeDir`, which the model reads and deletes: GT's evaluation tool cuts
print strings at 50 000 characters. Views with no declarative form (custom Bloc
elements, graphs) are reported as such; use `screenshot` for those.

## Safety

- Every caller value that becomes Smalltalk is either a quoted string literal
  (quotes doubled) or checked against a strict grammar: binding names are
  identifiers and not reserved words, view selectors are one-argument keyword
  selectors, object ids are lowercase alphanumerics, numbers are integers in
  range. The adversarial suite tries to break each of these.
- `start` passes the image and boot script as argv elements; there is no shell.
- `stop` without `save` loses unsaved changes in the image. Tools such as
  `compileMethods` and `removeClass` change the image.
- GT's MCP server is, in feenk's words, "not hardened": it binds a local port
  and evaluates code. Keep `host` on loopback.

## Development

```sh
deno task check
deno task test        # 78 tests, no GT needed: a fake MCP server + recorded GT fixtures
deno task test:soak   # property suite at 5000 runs
```

Fixtures in `fixtures/` were recorded from GT v1.1.601 (see
`fixtures/PROVENANCE.md`).
