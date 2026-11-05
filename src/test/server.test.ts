import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Position } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { completionAt } from "../server/completion.js";
import { definitionAt, indexDocument, scanLine, tokenAt } from "../server/documentIndex.js";
import {
  codeActions,
  documentSymbols,
  formatDocument,
  objectDefinitions,
  referencesAt,
  renameAt
} from "../server/features.js";
import { localDiagnostics } from "../server/diagnostics.js";
import { mergeImportedIndexes } from "../server/imports.js";

function document(text: string): TextDocument {
  return TextDocument.create("file:///sample.d2", "d2", 1, text);
}

// Import diagnostics resolve against the document's directory, so these tests need a URI that is
// valid on the host platform. `file:///sample.d2` has no drive letter and is rejected by
// `fileURLToPath` on Windows.
function fileDocument(text: string, directory: string): TextDocument {
  return TextDocument.create(pathToFileURL(path.join(directory, "sample.d2")).href, "d2", 1, text);
}

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "d2-lsp-test-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  const doc = document("a.b: c\na.d: e\na.style.stroke-width: 2\na.style.stroke-dash: 2");
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
  assert.ok(result.some(item => item.label === "stroke-width"));
});

// --- scanLine: masking, comments, and block string fences -------------------------------------

test("masks string contents but keeps offsets aligned", () => {
  const line = 'a: "x: y"';
  const { masked } = scanLine(line);
  assert.equal(masked.length, line.length);
  assert.equal(masked.indexOf(":"), 1);
  assert.equal(masked.indexOf("y"), -1);
});

test("treats a hash directly after a value as a comment", () => {
  const { masked } = scanLine("a: b#c");
  assert.equal(masked.trimEnd(), "a: b");
});

test("keeps a hash inside a key", () => {
  const { masked } = scanLine("a#b: c");
  assert.equal(masked, "a#b: c");
});

test("does not treat an escaped hash as a comment", () => {
  const { masked } = scanLine("a: b\\#c");
  assert.ok(masked.includes("#"));
});

test("recognizes both block string fences", () => {
  assert.equal(scanLine("a: |").blockStringTerminator, "|");
  assert.equal(scanLine("a: |md").blockStringTerminator, "|");
  assert.equal(scanLine("a: ||").blockStringTerminator, "||");
  assert.equal(scanLine("a: ||go").blockStringTerminator, "||");
  assert.equal(scanLine("a: b").blockStringTerminator, null);
});

// --- indexing: block strings, short names, connections, single-line maps ----------------------

test("does not index block string bodies as keys", () => {
  const doc = document("a: ||\n  x: y\n||\nb: c");
  const index = indexDocument(doc);
  assert.equal(index.symbols.has("x"), false);
  assert.equal(index.symbols.get("b")?.path, "b");
});

test("does not index |md block string bodies as keys", () => {
  const doc = document("a: |md\n  x: y\n|\nb: c");
  assert.equal(indexDocument(doc).symbols.has("x"), false);
});

test("resumes indexing after a block string closes", () => {
  const doc = document("a: ||\n  x: y\n||\nb: c");
  assert.equal(indexDocument(doc).symbols.get("b")?.line, 3);
});

test("prefers a top-level key over a nested key with the same name", () => {
  const doc = document("a.b: nested\nb: top");
  assert.equal(indexDocument(doc).symbols.get("b")?.path, "b");
});

test("does not let a connection shadow a real key", () => {
  const doc = document("a.b: nested\nb: top\nx -> b");
  assert.equal(indexDocument(doc).symbols.get("b")?.path, "b");
});

test("records class references from single-line maps", () => {
  const doc = document("classes: {\n  hi: {\n    style.fill: red\n  }\n}\nx: { class: hi }");
  const index = indexDocument(doc);
  assert.ok(index.references.some(reference => reference.name === "hi" && reference.line === 5));
});

test("records near references from single-line maps", () => {
  const doc = document("a: one\nb: { near: a }");
  const index = indexDocument(doc);
  assert.ok(index.references.some(reference => reference.name === "a" && reference.line === 1));
});

test("resolves a class used inside a single-line map", () => {
  const doc = document("classes: {\n  hi: {\n    style.fill: red\n  }\n}\nx: { class: hi }");
  const location = definitionAt(doc, {
    textDocument: { uri: doc.uri },
    position: Position.create(5, 13)
  }, indexDocument(doc));
  assert.equal(location?.range.start.line, 1);
});

test("reports the enclosing block for a line that closes a brace", () => {
  const doc = document("a: {\n  b: {\n    c: d\n  }\n}");
  const parents = indexDocument(doc).parentsByLine;
  assert.equal(parents[2], "a.b");
  assert.equal(parents[3], "a");
  assert.equal(parents[4], "");
});

// --- imports ---------------------------------------------------------------------------------

test("parses the ...@ import form", () => {
  const doc = document("...@lib\n...@\"./other\"");
  assert.deepEqual(indexDocument(doc).imports, ["lib", "./other"]);
});

test("ignores a bare @ which D2 rejects", () => {
  assert.deepEqual(indexDocument(document("@lib")).imports, []);
});

test("keeps URL imports intact", () => {
  const doc = document('...@"https://example.com/x"');
  assert.deepEqual(indexDocument(doc).imports, ["https://example.com/x"]);
});

test("records the line of each import", () => {
  const doc = document("a: b\n...@lib");
  assert.equal(indexDocument(doc).importReferences[0].line, 1);
});

test("does not report a missing import for a URL", () => {
  withTempDirectory(directory => {
    const doc = fileDocument('...@"https://example.com/x"', directory);
    assert.deepEqual(localDiagnostics(doc, indexDocument(doc)), []);
  });
});

test("points a missing import diagnostic at the import line", () => {
  withTempDirectory(directory => {
    const doc = fileDocument("a: b\n...@\"./missing\"", directory);
    const missing = localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("not found"));
    assert.equal(missing.length, 1);
    assert.equal(missing[0].range.start.line, 1);
  });
});

test("reports a resolved import as a hint", () => {
  withTempDirectory(directory => {
    writeFileSync(path.join(directory, "present.d2"), "x: y\n");
    const doc = fileDocument("...@\"./present\"", directory);
    const diagnostics = localDiagnostics(doc, indexDocument(doc));
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].message.includes("not found"), false);
    assert.equal(diagnostics[0].message.includes("Import resolved"), true);
  });
});

test("appends the .d2 extension when resolving an import", () => {
  withTempDirectory(directory => {
    writeFileSync(path.join(directory, "present.d2"), "x: y\n");
    const doc = fileDocument("...@\"./present.d2\"", directory);
    const diagnostics = localDiagnostics(doc, indexDocument(doc));
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].message.includes("Import resolved"), true);
  });
});

test("skips import diagnostics for documents without a file URI", () => {
  const doc = TextDocument.create("untitled:Untitled-1", "d2", 1, "...@\"./missing\"");
  assert.deepEqual(localDiagnostics(doc, indexDocument(doc)), []);
});

// --- diagnostics -----------------------------------------------------------------------------

test("does not report duplicates for connection endpoints", () => {
  const doc = document("a -> b");
  const duplicates = localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("Duplicate"));
  assert.deepEqual(duplicates, []);
});

test("does not report duplicates when a connection reuses a defined object", () => {
  const doc = document("a: one\nb: two\na -> b");
  const duplicates = localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("Duplicate"));
  assert.deepEqual(duplicates, []);
});

test("ignores shape text inside strings and comments", () => {
  const doc = document('a: {\n  label: "shape: bogus"\n}\n# shape: bogus\nb: c');
  assert.deepEqual(localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("shape")), []);
});

test("ignores shape text inside block strings", () => {
  const doc = document("a: ||\n  shape: bogus\n||");
  assert.deepEqual(localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("shape")), []);
});

test("still reports an unknown shape", () => {
  const doc = document("a: {\n  shape: bogus\n}");
  const shapes = localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("shape"));
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].range.start.line, 1);
  assert.equal(shapes[0].range.start.character, 9);
});

test("rejects style keywords that D2 does not support", () => {
  const doc = document("a: {\n  style.stroke-linecap: round\n}");
  const unknown = localDiagnostics(doc, indexDocument(doc)).filter(item => item.message.includes("style property"));
  assert.deepEqual(unknown.map(item => item.message), ["Unknown D2 style property 'stroke-linecap'."]);
});

// --- formatting ------------------------------------------------------------------------------

test("does not collapse whitespace inside strings when normalizing semicolons", () => {
  const doc = document('a:   "x;  y"');
  assert.equal(formatDocument(doc)[0]?.newText, 'a: "x;  y"');
});

test("normalizes semicolon separators outside strings", () => {
  const doc = document("a:   b;   c:   d");
  assert.equal(formatDocument(doc)[0]?.newText, "a: b; c: d");
});

test("preserves || block string bodies verbatim", () => {
  const doc = document("a:   ||\n  x:   y\n||\nb:   c");
  assert.equal(formatDocument(doc)[0]?.newText, "a: ||\n  x:   y\n||\nb: c");
});

test("indents a nested block string terminator with its opening line", () => {
  const doc = document("a:   {\n  b:   ||\n    x:   y\n  ||\n}");
  assert.equal(formatDocument(doc)[0]?.newText, "a: {\n  b: ||\n    x:   y\n  ||\n}");
});

test("formatting || blocks is idempotent", () => {
  const doc = document("a:   ||\n  x:   y\n||");
  const once = formatDocument(doc)[0].newText;
  assert.deepEqual(formatDocument(document(once)), []);
});

// --- symbols, references, rename -------------------------------------------------------------

test("does not emit connection endpoints as document symbols", () => {
  const doc = document("a: one\nb: two\na -> b");
  const names = documentSymbols(doc, indexDocument(doc)).map(symbol => symbol.name);
  assert.deepEqual(names, ["a", "b"]);
});

test("does not emit style properties as document symbols", () => {
  const doc = document("a: {\n  style.fill: red\n}");
  const names = documentSymbols(doc, indexDocument(doc)).map(symbol => symbol.name);
  assert.deepEqual(names, ["a"]);
});

test("refuses to rename a reserved field", () => {
  const doc = document("a: {\n  shape: rectangle\n}");
  assert.equal(renameAt(doc, Position.create(1, 3), "zz", indexDocument(doc)), null);
});

test("refuses to rename a style property", () => {
  const doc = document("a: {\n  style.fill: red\n}");
  assert.equal(renameAt(doc, Position.create(1, 9), "zz", indexDocument(doc)), null);
});

test("still renames a normal object", () => {
  const doc = document("alpha: one\nalpha -> beta");
  const edit = renameAt(doc, Position.create(0, 2), "gamma", indexDocument(doc));
  assert.deepEqual(
    edit?.changes?.[doc.uri].map(item => `${item.range.start.line}:${item.range.start.character}`),
    ["0:0", "1:0"]
  );
});

test("finds references to a quoted key", () => {
  const doc = document('"a b": one\nx -> "a b"');
  const ranges = referencesAt(doc, Position.create(0, 2), indexDocument(doc))
    .map(item => `${item.range.start.line}:${item.range.start.character}`);
  assert.deepEqual(ranges, ["0:1", "1:6"]);
});

test("resolves a definition from a quoted key usage", () => {
  const doc = document('"a b": one\nx -> "a b"');
  const location = definitionAt(doc, {
    textDocument: { uri: doc.uri },
    position: Position.create(1, 7)
  }, indexDocument(doc));
  assert.equal(location?.range.start.line, 0);
});

// --- completion ------------------------------------------------------------------------------

test("does not duplicate labels shared by keywords and shapes", () => {
  const doc = document("sh");
  const labels = completionAt(doc, Position.create(0, 2), indexDocument(doc)).map(item => item.label);
  assert.equal(new Set(labels).size, labels.length);
});

test("completes nested objects inside a block", () => {
  const doc = document("a: {\n  b.c: one\n  b.d: two\n  b.\n}");
  const labels = completionAt(doc, Position.create(3, 4), indexDocument(doc)).map(item => item.label);
  assert.deepEqual(labels.sort(), ["c", "d"]);
});

test("offers only style keywords that D2 accepts", () => {
  const doc = document("a: {\n  style: {\n    \n  }\n}");
  const labels = completionAt(doc, Position.create(2, 4), indexDocument(doc)).map(item => item.label);
  assert.ok(labels.includes("stroke-width"));
  assert.ok(!labels.includes("stroke-linecap"));
  assert.ok(!labels.includes("root"));
});

test("offers the documented text-transform values", () => {
  const doc = document("a: {\n  style.text-transform: \n}");
  const labels = completionAt(doc, Position.create(1, 24), indexDocument(doc)).map(item => item.label);
  assert.deepEqual(labels, ["none", "uppercase", "lowercase", "capitalize"]);
});

test("offers the documented fill-pattern values", () => {
  const doc = document("a: {\n  style.fill-pattern: \n}");
  const labels = completionAt(doc, Position.create(1, 22), indexDocument(doc)).map(item => item.label);
  assert.ok(labels.includes("paper"));
});

// --- shared symbol filtering -----------------------------------------------------------------

test("objectDefinitions excludes connections and style properties", () => {
  const doc = document("a: one\nb: two\na -> b\nc: {\n  style.fill: red\n}");
  const names = objectDefinitions(indexDocument(doc)).map(symbol => symbol.name);
  assert.deepEqual(names, ["a", "b", "c"]);
});

test("objectDefinitions keeps nested objects", () => {
  const doc = document("a: {\n  b: c\n}");
  const names = objectDefinitions(indexDocument(doc)).map(symbol => symbol.name);
  assert.deepEqual(names, ["a", "b"]);
});
