---
name: gtoolkit
description: Drive a running Glamorous Toolkit (GT, the moldable Pharo environment) from Claude through the @magistr/gtoolkit swamp model — start/stop GT with its MCP server, evaluate Smalltalk, read any inspector view as rows, drill into items, open inspector windows for the human, take PNG screenshots of windows or views, and call GT's own tools (class/method search, Lepiter pages, compile methods, run examples). Triggers on "glamorous toolkit", "gtoolkit", "GT inspector", "moldable development", "open in GT", "evaluate in GT", "pharo", "smalltalk", "lepiter", "gt view", "inspect in glamorous".
---

# Driving Glamorous Toolkit

The `@magistr/gtoolkit` model talks to GT's built-in MCP server
(`GtLMcpServer`). GT does the work; the model starts it, evaluates code, reads
views and forwards tool calls. The instance in this repo is usually named `gt`
(global arg `gtHome` = GT install directory).

## Loop

1. `swamp model method run gt status --json` → then read
   `swamp data get gt status --json`. `reachable: false` →
   `swamp model method run gt start` (waits until GT answers; opens GT's home
   window).
2. Make an object: `swamp model method run gt eval --input code="<Smalltalk>"`.
   Read `swamp data get gt evaluation --json`: `.content.objectId`,
   `.className`, `.printString`, `.string` (for String results), `.views` (the
   inspector tabs: `{selector, title}`), `.error`.
3. Read a view like the inspector shows it:
   `swamp model method run gt view --input objectId=<id> --input view=Items --input count=50`
   → `swamp data get gt view --json`: `.columns`, `.rows[] {index, cells}`,
   `.total`, `.text` (text views).
4. Drill in (what a click does):
   `swamp model method run gt open --input objectId=<id> --input view=Items --input index=<row>`
   → a new `evaluation` with its own objectId. Repeat 3–4.
5. Reuse objects in code with bindings:
   `--input code="obj size" --input 'bindings={"obj":"<id>"}'`.
6. Show the human: `swamp model method run gt inspect --input objectId=<id>`
   opens a GT window.
7. See it yourself:
   `swamp model method run gt screenshot --input objectId=<id> --input view=Tree`
   (a view offscreen) or `--input window="Glamorous"` (an open window), then
   Read the PNG at `swamp data get gt screenshot --json` → `.content.path`. Use
   this for graph/explicit views that `view` reports as
   `"view has no declarative form"` or with no rows.

## GT's own tools

`swamp model method run gt tools` lists them (`swamp data get gt tools --json`).
Call any with
`swamp model method run gt tool --input name=<tool> --input 'arguments={...}'` →
`swamp data get gt tool-result --json` (`.json` is the parsed answer). Useful
ones:

Shapes below were checked against GT v1.1.601:

| Tool                                                               | Arguments                                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `searchForClasses`                                                 | `{"query": "Lepiter"}`                                                                                |
| `getCodeOfMethods`                                                 | `{"methodDescriptors": [{"methodClassName": "LePage", "methodName": "title", "classSide": false}]}`   |
| `methodReferences` / `getImplementors`                             | `{"methodName": "gtItemsFor:"}`                                                                       |
| `lepiterKnowledgeBases`                                            | `{}` → each knowledge base's `uuidString` (the GT book is one of them)                                |
| `searchForLepiterPages`                                            | `{"knowledgeBases": ["<uuidString>"], "query": "Moldable"}` — ids, not names                          |
| `getLepiterPageContents`                                           | `{"databaseId": "<uuidString>", "pageUid": "<pageUid from search>"}`                                  |
| `createLepiterPage`, `createLepiterSnippets`, `editLepiterSnippet` | write notes into GT                                                                                   |
| `compileMethods`                                                   | `{"methods": [{"methodClassName": "X", "sourceCode": "…", "protocol": "views", "classSide": false}]}` |
| `exampleMethodRun`                                                 | `{"exampleReference": {"exampleClassName": "X", "methodName": "sel", "classSide": false}}`            |
| `examplesInClassesRun`                                             | `{"classNames": ["X"]}`                                                                               |

Check a tool's exact argument shape in its `description` from `tools` before
calling it.

## Smalltalk reminders

- Strings use single quotes; a quote inside is doubled: `'it''s'`. Double quotes
  are comments.
- Statements end with `.`; the last expression is the result. Temporaries:
  `| a b | a := 3. a + 4`.
- Views are methods `gtXxxFor: aView` with `<gtView>`; `view` accepts the
  selector or the tab title.
- A useful first move on any object: `eval` it, look at `.views`, `view` the
  first real tab.

## Adding a view to a class (molding)

Compile a method with `compileMethods`, e.g.

```smalltalk
gtNamesFor: aView
	<gtView>
	^ aView columnedList
		title: 'Names';
		priority: 5;
		items: [ self names ];
		column: 'Name' text: [ :each | each ]
```

then `eval` an instance again — the new tab is in `.views` at once, and
`inspect` shows it in GT.

## Cautions

- `stop` quits GT without saving unless `--input save=true`; unsaved code
  changes and objects are lost.
- `compileMethods`, `removeMethods`, `removeClass`, `createClassesAndTraits`
  change the image — confirm with the user first.
- Object ids live only as long as the GT process; after a restart, `eval` again.
- `start` refuses when the same image already runs without the MCP server and
  prints a snippet to evaluate in a GT playground instead.
