import assert from "node:assert/strict";
import test from "node:test";
import { Position } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { completionAt } from "../server/completion.js";
import { definitionAt, indexDocument, tokenAt } from "../server/documentIndex.js";
import { codeActions, documentSymbols, formatDocument, referencesAt, renameAt } from "../server/features.js";
import { localDiagnostics } from "../server/diagnostics.js";
import { mergeImportedIndexes } from "../server/imports.js";

function document(text: string): TextDocument {
  return TextDocument.create("file:///sample.d2", "d2", 1, text);
}

test("completes nested D2 objects after a dot", () => {
  const source = "a.b: one\na.c: two\na.d.e: three\n\n a.";
  const doc = document(source);
  const result = completionAt(doc, Position.create(4, 3), indexDocument(doc));
  assert.deepEqual(result.map(item => item.label).sort(), ["b", "c", "d"]);
});

test("completes D2 keywords in a key position", () => {
  const doc = document("sh");
  const result = completionAt(doc, Position.create(0, 2), indexDocument(doc));
  assert.ok(result.some(item => item.label === "shape"));
  assert.ok(result.some(item => item.label === "style"));
});

test("jumps to a nested object definition", () => {
  const doc = document("clouds:\n  api: server\nclouds.api");
  const location = definitionAt(doc, {
    textDocument: { uri: doc.uri },
    position: Position.create(2, 10)
  }, indexDocument(doc));
  assert.equal(location?.range.start.line, 1);
  assert.equal(location?.range.start.character, 2);
});

test("jumps to a class definition from a class attribute", () => {
  const doc = document("classes: {\n  highlighted: {\n    style.fill: yellow\n  }\n}\nshape: { class: highlighted }");
  const location = definitionAt(doc, {
    textDocument: { uri: doc.uri },
    position: Position.create(5, 27)
  }, indexDocument(doc));
  assert.equal(location?.range.start.line, 1);
});

test("resolves the token under the cursor instead of the last word on the line", () => {
  const doc = document("alpha: beta\ndelta: gamma");
  assert.equal(tokenAt(doc, Position.create(0, 2))?.name, "alpha");
  assert.equal(tokenAt(doc, Position.create(1, 2))?.name, "delta");
  assert.equal(tokenAt(doc, Position.create(1, 0))?.name, "delta");
  assert.equal(tokenAt(doc, Position.create(0, 6)), null);
  assert.equal(tokenAt(doc, Position.create(9, 0)), null);
});

test("jumps to a definition from the middle of a word", () => {
  const doc = document("alpha: beta\nalpha");
  const location = definitionAt(doc, {
    textDocument: { uri: doc.uri },
    position: Position.create(1, 2)
  }, indexDocument(doc));
  assert.equal(location?.range.start.line, 0);
});

test("keeps the class declaration when a class is used", () => {
  const doc = document("classes: {\n  hi: {\n    style.fill: red\n  }\n}\nx: { class: hi }");
  assert.equal(indexDocument(doc).classes.get("hi")?.line, 1);
});

test("indexes dotted class declarations", () => {
  const doc = document("classes.hi: {\n  style.fill: red\n}\nx: { class: hi }");
  assert.equal(indexDocument(doc).classes.get("hi")?.line, 0);
});

test("ignores @ and braces inside string literals", () => {
  const doc = document('a: {\n  label: "mail bob@example.com {x}"\n}\nb: c');
  const index = indexDocument(doc);
  assert.deepEqual(index.imports, []);
  assert.equal(index.symbols.get("b")?.path, "b");
});

test("does not leak scope from a single-line map", () => {
  const doc = document("a: { b: c }\nd: e");
  assert.equal(indexDocument(doc).symbols.get("d")?.path, "d");
});

test("keeps dots inside quoted keys", () => {
  const doc = document('"a.b": one');
  assert.deepEqual(indexDocument(doc).definitions.map(item => item.path), ["a.b"]);
});

test("finds references on connection lines", () => {
  const doc = document("a: one\nb: two\na -> b: link");
  const ranges = referencesAt(doc, Position.create(0, 0), indexDocument(doc))
    .map(item => `${item.range.start.line}:${item.range.start.character}`);
  assert.deepEqual(ranges, ["0:0", "2:0"]);
});

test("renames only the matching path", () => {
  const doc = document("a: one\nc.a: two\na -> c.a");
  const edit = renameAt(doc, Position.create(0, 0), "z", indexDocument(doc));
  const positions = edit?.changes?.[doc.uri].map(item => `${item.range.start.line}:${item.range.start.character}`);
  assert.deepEqual(positions, ["0:0", "2:0"]);
});

test("formats without corrupting URLs, strings, or block scalars", () => {
  const doc = document('a:   {\n    link:   https://example.com\n    label:   "time 12:30"\n}\nb:   |\n  hello\n  world\n|\nc:   d');
  const formatted = formatDocument(doc)[0]?.newText;
  assert.equal(formatted, 'a: {\n  link: https://example.com\n  label: "time 12:30"\n}\nb: |\n  hello\n  world\n|\nc: d');
});

test("preserves CRLF line endings when formatting", () => {
  const doc = document("a:  b\r\nc:  d");
  assert.equal(formatDocument(doc)[0]?.newText, "a: b\r\nc: d");
});

test("reports symbol ranges without the trailing newline", () => {
  const doc = document("alpha: beta\n");
  const symbol = documentSymbols(doc, indexDocument(doc))[0];
  assert.deepEqual(symbol.range.end, { line: 0, character: 11 });
  assert.deepEqual(symbol.selectionRange, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 }
  });
});

test("offers to create an unknown class", () => {
  const doc = document("x: { class: nope }");
  const actions = codeActions(doc, {
    start: Position.create(0, 0),
    end: Position.create(0, 17)
  }, indexDocument(doc));
  assert.deepEqual(actions.map(action => action.title), ["Create class 'nope'"]);
});

test("does not report parents or style properties as duplicates", () => {
  const doc = document("a.b: c\na.d: e\na.style.stroke-linecap: round\na.style.stroke-dash-gap: 2");
  const duplicates = localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("Duplicate"));
  assert.deepEqual(duplicates, []);
});

test("still reports genuinely duplicated objects", () => {
  const doc = document("a: one\na: two");
  const duplicates = localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("Duplicate"));
  assert.equal(duplicates.length, 1);
});

test("validates style properties declared in a style block", () => {
  const doc = document("a: {\n  style: {\n    bogusprop: 1\n  }\n}");
  assert.deepEqual(
    localDiagnostics(doc, indexDocument(doc)).map(item => item.message),
    ["Unknown D2 style property 'bogusprop'."]
  );
});

test("accepts every documented D2 shape", () => {
  const doc = document("a: {\n  shape: code\n}\nb: {\n  shape: image\n}\nc: {\n  shape: sequence_diagram\n}");
  assert.deepEqual(localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("shape")), []);
});

test("handles untitled documents without throwing", () => {
  const doc = TextDocument.create("untitled:Untitled-1", "d2", 1, "a: b");
  assert.doesNotThrow(() => localDiagnostics(doc, indexDocument(doc)));
});

test("does not mutate the cached index when merging imports", () => {
  const doc = document("a: b");
  const index = indexDocument(doc);
  const other = TextDocument.create("file:///other.d2", "d2", 1, "z: y");
  mergeImportedIndexes(index, [{ document: other, index: indexDocument(other) }]);
  assert.equal(index.symbols.has("z"), false);
});

test("formats nested blocks and semicolon-separated keys", () => {
  const doc = document("a:   {\n  b:   {\n    c:   d\n  }\n}\ng:   h;  i:   j");
  assert.equal(
    formatDocument(doc)[0]?.newText,
    "a: {\n  b: {\n    c: d\n  }\n}\ng: h; i: j"
  );
});

test("formatting is idempotent", () => {
  const doc = document("a:   {\n  b:   c\n}");
  const once = formatDocument(doc)[0].newText;
  assert.deepEqual(formatDocument(document(once)), []);
});

test("completes style properties inside a style block", () => {
  const doc = document("a: {\n  style: {\n    \n  }\n}");
  const result = completionAt(doc, Position.create(2, 4), indexDocument(doc));
  assert.ok(result.some(item => item.label === "stroke-linecap"));
});
