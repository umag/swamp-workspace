# Glamorous Toolkit APIs (checked against GT v1.1.601)

## Views (Phlow)

A view is a method on the object's class, `gtXxxFor: aView` with the `<gtView>`
pragma, that returns a view built from `aView`. Lower `priority:` = earlier tab.

```smalltalk
aView columnedList title: 'Items'; priority: 10; items: [ self items ];
	column: 'Name' text: [ :each | each name ];
	column: 'Size' text: [ :each | each size printString ] width: 80;
	send: [ :each | each ]                      "what a click opens"
aView list title: 'L'; items: [ ... ]; itemText: [ :each | ... ]
aView tree title: 'T'; items: [ roots ]; children: [ :each | each children ]
aView textEditor title: 'Text'; text: [ 'x' asRopedText ]
aView forward title: 'F'; object: [ self part ]; view: #gtItemsFor:
aView explicit title: 'E'; stencil: [ BrVerticalPane new ... ]    "any Bloc element"
aView empty                                     "hide the view when it does not apply"
```

Rows of any view as data:
`(obj perform: #gtItemsFor: with: GtPhlowEmptyView new) asGtDeclarativeView`
then `phlowDataSource retrieveTotalItemsCount`, `retrieveItems: n fromIndex: i`,
`retrieveSentItemAt: i`; text views `getText`; follow forwards with
`computeForwardedView` first. The model's `view` / `open` methods do this.

## Examples

```smalltalk
emptyGame
	<gtExample>
	<return: #Game>
	| game |
	game := Game new.
	self assert: game players size equals: 0.
	^ game
```

Examples may call other examples. Run with the `exampleMethodRun` /
`examplesInClassesRun` tools.

## Lepiter

- `LeDatabasesRegistry defaultLogicalDatabase pageNamed: 'Title'` finds a page
  in any knowledge base.
- `page children` → snippets (`LeTextSnippet string`,
  `LeExampleSnippet exampleSelector`); each has `children`, `uid asString`,
  `removeSelf`.
- Example snippets show a result instead of code with
  `noCode: true; previewExpanded: true; previewHeight: 400; previewShowSelector: #gtXxxFor:`.
- MCP tools address knowledge bases by `uuidString` (from
  `lepiterKnowledgeBases`), never by name. `createLepiterSnippets` takes
  `parentSnippetUid` (the base64 `uid asString`) to nest a snippet.
- Pages are stored on disk (`~/Documents/lepiter/…`) and survive restarts;
  classes do not unless the image is saved.

## The UI thread

MCP requests run in a worker process. Anything that builds or changes widgets
must run in GT's UI process:

```smalltalk
| world |
world := GtWorld allInstances detect: [ :w | w isOpened ].
BlTaskAction enqueueElement: world root action: [ obj inspect ].      "open a window"
anElement enqueueTask: (BlTaskAction new action: [ label text: 'done' ]).  "update from background"
```

Queue on a `GtWorld`: other spaces (e.g. "Scripter") may never run frames, so
tasks sent there never run.

## Background work and change notification

```smalltalk
[ result := slow value. announcer announce: Done new ]
	forkAt: Processor userBackgroundPriority named: 'my job'.
announcer weak when: Done send: #onDone: to: anElement.
```

## Widgets (Brick)

```smalltalk
BrVerticalPane new matchParent; padding: (BlInsets all: 8); addChild: x.
BrHorizontalPane new hMatchParent; vFitContent; alignCenterLeft; cellSpacing: 10.
BrLabel new aptitude: BrGlamorousLabelAptitude new; text: 'Label'.
BrButton new aptitude: BrGlamorousButtonWithIconAndLabelAptitude new;
	icon: BrGlamorousVectorIcons play; label: 'Run'; action: [ ... ].
BrEditor new aptitude: BrGlamorousCodeEditorAptitude; hMatchParent; vMatchParent;
	text: source asRopedText;
	addShortcut: (BlShortcutWithAction new combination: BlKeyCombination primaryS; action: [ ... ]).
```

## Windows and pictures

- Open windows: `BlSpace allSubInstances select: [ :s | s isOpened ]` (`title`,
  `close`, `extent:`). `allInstances` misses `GtWorld`. `GtWorld openDefault`
  opens a home window.
- PNG: `BlExporter png element: space root; fileName: '/tmp/w.png'; export`. A
  single view offscreen:
  `view asElementDo: [ :e | el := e ]. el size: 900 @ 600. el forceLayout.` then
  export (the model's `screenshot` method). Offscreen Lepiter text shows its raw
  markup.

## External processes

```smalltalk
out := GtExternalProcessBuilder new
	command: '/usr/local/bin/tool'; args: #('--flag' 'x');
	workingDirectory: '/some/dir'; addAllEnvVariablesFromParentWithoutOverride;
	output.
out stdout. out stderr. out status isSuccess.
```

`output` blocks: run it in a forked process when it takes long.

## Settings and saving

- `BlSpace userFontScale: 16 / 14` (base font is 14), `BlSpace userScale: 1.25`.
- Save without quitting, from the UI process:
  `BlTaskAction enqueueElement: world root action: [ Smalltalk snapshot: true andQuit: false ]`.
  The model's `stop` quits (`save=true` to save first).
