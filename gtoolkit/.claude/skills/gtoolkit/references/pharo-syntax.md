# Pharo Smalltalk for GT evaluations

Everything below runs through `eval` (GT's `smalltalkCodeEvaluation`). The value
of the last statement is the result.

## Literals

| Kind               | Example                      | Note                                                                        |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------- |
| String             | `'it''s'`                    | single quotes; a quote inside is doubled. Double quotes start a **comment** |
| Symbol             | `#title`, `#gtItemsFor:`     | selectors are symbols                                                       |
| Character          | `$a`, `$`, `$\`              |                                                                             |
| Number             | `42`, `3.14`, `16r1F`, `2/3` | `2/3` stays a Fraction; `(2/3) asFloat`                                     |
| Literal array      | `#(1 'a' #b)`                | constants only                                                              |
| Dynamic array      | `{ 1 + 1. x. 'a' }`          | expressions separated by `.`                                                |
| nil / true / false | `nil` `true` `false`         | reserved words                                                              |

## Messages and statements

- Precedence: unary (`x size`) → binary (`a + b`, `a , b`) → keyword
  (`d at: k put: v`). Parenthesise to change it: `(a max: b) printString`.
- Temporaries: `| a b |` at the start. Assignment `:=`. Return `^ expr`.
  Statements end with `.`
- Cascade: send several messages to one receiver with `;`, end with `yourself`
  to get the receiver: `OrderedCollection new add: 1; add: 2; yourself`.
- Blocks: `[ :x :y | x + y ]`, run with `value:value:`. `[ ... ] value`.

## Control flow is messages

```smalltalk
x > 3 ifTrue: [ 'big' ] ifFalse: [ 'small' ].
obj ifNil: [ 'none' ] ifNotNil: [ :o | o printString ].
1 to: 10 do: [ :i | ... ].
[ n > 0 ] whileTrue: [ n := n - 1 ].
[ risky value ] on: Error do: [ :e | e messageText ].
[ work value ] ensure: [ cleanup value ].
Error signal: 'something failed'.
```

`a or: [ b ]` and `a and: [ b ]` take a block; there is no `or:or:` — nest them.

## Collections

`do:` `collect:` `select:` `reject:` `detect:ifNone:` `inject:into:`
`anySatisfy:` `allSatisfy:` `includes:` `isEmpty` `ifEmpty:` (not on every
collection-like object, e.g. Lepiter's `LeSnippets`) — convert with `asArray`
first. `asSortedCollection` `asSet` `first` `last` `allButFirst`. Dictionary:
`at:` `at:ifAbsent:` `at:put:` `keysAndValuesDo:` `includesKey:`.

## Strings and streams

`,` concatenates. `printString` (with quotes for strings) vs `asString`.
`lines`, `trimBoth`, `includesSubstring:`, `beginsWith:`,
`copyReplaceAll:with:`, `substrings: '/'`, `String cr`, `String lf`,
`String cr join: aCollection`. Build text with
`String streamContents: [ :s | s nextPutAll: 'a'; print: 3; cr ]`.

## Files and JSON

```smalltalk
FileLocator home / 'dev_tmp' / 'x.txt'          "one segment per /; never put '/' inside a segment"
'/tmp/out.json' asFileReference ensureDelete; writeStreamDo: [ :s | s nextPutAll: text ].
ref contents.  ref exists.  ref parent.  ref basename.  ref copyTo: other.
STONJSON fromString: aString.   STONJSON toString: aDictionary.
```

## Reflection (finding things)

`Smalltalk at: #Name ifAbsent: [ nil ]`, `Smalltalk includesKey: #Name`,
`Class selectors`, `Class class selectors` (class side),
`(Class >> #sel) sourceCode`, `obj respondsTo: #sel`,
`Class canUnderstand: #sel`, `Class allSubclasses`, `Class allSubInstances`,
`SystemNavigation default allClasses`. GT's MCP tools (`searchForClasses`,
`getImplementors`, `methodReferences`, `getCodeOfMethods`) are usually faster.

## Methods (as sent to `compileMethods`)

```smalltalk
gtNamesFor: aView
	"Comment."
	<gtView>
	| temp |
	^ aView columnedList title: 'Names'; items: [ self names ]; column: 'Name' text: [ :each | each ]
```

Selector and arguments on the first line, pragmas (`<gtView>`, `<gtExample>`)
before the body.
