/**
 * Building Smalltalk source from caller input. Every value that reaches GT
 * as code goes through one of these helpers: strings become quoted literals,
 * identifiers and selectors are validated against a strict grammar, so no
 * argument can close a literal or smuggle in a statement.
 */

/** A Smalltalk string literal: single quotes, embedded quotes doubled. */
export function stString(value: string): string {
  if (value.includes("\u0000")) throw new Error("string contains a NUL byte");
  return `'${value.replaceAll("'", "''")}'`;
}

const RESERVED = new Set([
  "self",
  "super",
  "nil",
  "true",
  "false",
  "thisContext",
]);

/** A temporary/binding name: a letter, then letters, digits or underscores. */
export function assertIdentifier(name: string, what = "identifier"): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || RESERVED.has(name)) {
    throw new Error(
      `${what} ${
        JSON.stringify(name)
      } must match [A-Za-z][A-Za-z0-9_]* and not be a Smalltalk reserved word`,
    );
  }
  return name;
}

/** A one-argument keyword selector such as gtItemsFor:. */
export function assertViewSelector(selector: string): string {
  if (!/^[a-z][A-Za-z0-9_]{0,127}:$/.test(selector)) {
    throw new Error(
      `view selector ${
        JSON.stringify(selector)
      } must be a one-argument keyword selector like gtItemsFor:`,
    );
  }
  return selector;
}

/** An object id from GT's object storage. */
export function assertObjectId(id: string): string {
  if (!/^[a-z0-9]{8,64}$/.test(id)) {
    throw new Error(
      `object id ${
        JSON.stringify(id)
      } is not a GT object-storage id (lowercase letters and digits)`,
    );
  }
  return id;
}

export function assertPositiveInt(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
    throw new Error(`${what} must be an integer between 1 and 1000000`);
  }
  return n;
}

/**
 * Code that resolves a view of `obj` (a binding) by selector, following
 * forward views to the view they show. Leaves it in the temp `view`.
 */
export function resolveViewCode(selector: string): string {
  const sel = assertViewSelector(selector);
  return `view := obj perform: #${sel} with: GtPhlowEmptyView new.
	(view respondsTo: #computeForwardedView) ifTrue: [ view := view computeForwardedView ].`;
}

/** Writes `expr` (a String) to `path`, replacing the file. */
export function writeFileCode(path: string, expr: string): string {
  return `${
    stString(path)
  } asFileReference ensureDelete; writeStreamDo: [ :aStream | aStream nextPutAll: (${expr}) ].`;
}

/**
 * Renders one view of `obj` to JSON at `path` through Phlow's declarative
 * specifications — the same serialisation Remote Phlow uses — so any list,
 * columned list, tree or text view becomes data. Errors are written as data.
 */
export function renderViewCode(
  selector: string,
  start: number,
  count: number,
  path: string,
): string {
  assertPositiveInt(start, "start");
  assertPositiveInt(count, "count");
  return `| view spec ds out n text |
out := Dictionary new.
[ ${resolveViewCode(selector)}
	spec := view asGtDeclarativeView.
	spec
		ifNil: [ out at: 'error' put: 'view has no declarative form: ' , view class name ]
		ifNotNil: [
			out at: 'spec' put: spec asDictionaryForExport.
			ds := spec phlowDataSource.
			(ds respondsTo: #retrieveTotalItemsCount) ifTrue: [
				n := ds retrieveTotalItemsCount.
				out at: 'total' put: n.
				out at: 'items' put: (${start} > n
					ifTrue: [ #() ]
					ifFalse: [ ds retrieveItems: (${count} min: n - ${start} + 1) fromIndex: ${start} ]) ].
			(ds respondsTo: #getText) ifTrue: [
				text := ds getText.
				out at: 'text' put: ((text isKindOf: Dictionary)
					ifTrue: [ (text at: 'string' ifAbsent: [ text printString ]) asString ]
					ifFalse: [ text asString ]) ] ] ]
	on: Error do: [ :anError | out at: 'error' put: anError messageText asString ].
${writeFileCode(path, "STONJSON toString: out")}
'ok'`;
}

/** The object behind item `index` of a view — what a click in GT would open. */
export function sentItemCode(selector: string, index: number): string {
  assertPositiveInt(index, "index");
  return `| view |
${resolveViewCode(selector)}
view asGtDeclarativeView phlowDataSource retrieveSentItemAt: ${index}`;
}

/** Renders a view (or, without a selector, a window) to a PNG file. */
export function viewPngCode(
  selector: string,
  width: number,
  height: number,
  path: string,
): string {
  assertPositiveInt(width, "width");
  assertPositiveInt(height, "height");
  return `| view element |
${resolveViewCode(selector)}
view asElementDo: [ :anElement | element := anElement ].
element size: ${width} @ ${height}.
element forceLayout.
BlExporter png element: element; fileName: ${stString(path)}; export.
'ok'`;
}

export function windowPngCode(titleSubstring: string, path: string): string {
  return `| spaces space |
spaces := BlSpace allSubInstances select: [ :each | each isOpened ].
space := ${
    titleSubstring === ""
      ? "spaces ifEmpty: [ nil ] ifNotEmpty: [ :all | all last ]"
      : `spaces detect: [ :each | each title asString includesSubstring: ${
        stString(titleSubstring)
      } ] ifNone: [ nil ]`
  }.
space ifNil: [ Error signal: 'no open GT window matches' ].
BlExporter png element: space root; fileName: ${stString(path)}; export.
space title asString`;
}

/**
 * Opens an inspector on `obj` from GT's UI process. MCP requests run in a worker process, and
 * building editors there raises BrEditorWrongThreadError, so the inspect is queued as a task on
 * GT's main window (a GtWorld; other spaces such as "Scripter" may never run frames).
 */
export const INSPECT_CODE = `| world |
world := (GtWorld allInstances select: [ :each | each isOpened ])
	ifEmpty: [ nil ]
	ifNotEmpty: [ :all | all first ].
world
	ifNil: [ obj inspect ]
	ifNotNil: [ BlTaskAction enqueueElement: world root action: [ obj inspect ] ].
obj`;

export const WINDOWS_CODE =
  `((BlSpace allSubInstances select: [ :each | each isOpened ]) collect: [ :each | each title asString ]) asArray`;

/** Boot script: start GT's MCP server with its full tool set. */
export function bootScript(port: number, openWorld: boolean): string {
  assertPositiveInt(port, "port");
  return `| server |
GtLMcpServer current ifNotNil: [ :old | [ old stop ] on: Error do: [ :e | ] ].
server := GtLMcpServer new port: ${port}; yourself.
server addTools: GtLTools gt.
server start.
GtLMcpServer current: server.
${openWorld ? "[ GtWorld openDefault ] on: Error do: [ :e | ].\n" : ""}`;
}
