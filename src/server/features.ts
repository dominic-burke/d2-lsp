import {
  CodeAction,
  CodeActionKind,
  CompletionItemKind,
  DocumentHighlight,
  DocumentSymbol,
  Hover,
  MarkupKind,
  Position,
  Range,
  SymbolKind,
  TextEdit,
  WorkspaceEdit
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { D2_KEYWORDS, D2_SHAPES, D2_STYLE_KEYWORDS, D2_VALUE_HINTS } from "../shared/keywords.js";
import {
  DocumentIndex,
  lineText,
  parseKeyPath,
  referenceAt,
  scanLine,
  SymbolDefinition,
  SymbolReference,
  tokenAt
} from "./documentIndex.js";

const docs: Record<string, string> = {
  shape: "Sets the D2 shape type. See the [shape catalog](https://d2lang.com/tour/shapes/).",
  label: "Overrides the displayed label for an object.",
  class: "Applies a reusable class to an object or connection.",
  classes: "Declares reusable classes that objects can reference with `class`.",
  style: "Contains styling properties such as `fill`, `stroke`, and `font-size`.",
  sql_table: "Uses the SQL table shape; child keys represent table rows and constraints.",
  direction: "Sets diagram direction: `up`, `down`, `left`, or `right`.",
  layout: "Selects the layout engine, such as `dagre` or `elk`.",
  near: "Positions an object near another object.",
  "source-arrowhead": "Configures the source arrowhead shape on a connection.",
  "target-arrowhead": "Configures the target arrowhead shape on a connection."
};

function lineLength(document: TextDocument, line: number): number {
  return lineText(document, line).length;
}

export function hoverAt(document: TextDocument, position: Position, index: DocumentIndex): Hover | null {
  const token = tokenAt(document, position);
  if (!token) {
    return null;
  }
  const name = token.name.toLowerCase();
  const symbol = referenceAt(document, position, index);
  const description = docs[name]
    ?? (D2_SHAPES.includes(token.name as typeof D2_SHAPES[number]) ? `D2 shape type \`${token.name}\`.` : undefined)
    ?? (D2_STYLE_KEYWORDS.includes(token.name as typeof D2_STYLE_KEYWORDS[number]) ? `D2 style property \`${token.name}\`.` : undefined)
    ?? (index.classes.has(name) ? `Reusable D2 class \`${token.name}\`.` : undefined)
    ?? (symbol ? `D2 object \`${symbol.path}\`.` : undefined);
  if (!description) {
    return null;
  }
  return {
    contents: { kind: MarkupKind.Markdown, value: description },
    range: token.range
  };
}

export function documentSymbols(document: TextDocument, index: DocumentIndex): DocumentSymbol[] {
  return index.definitions
    .filter(symbol => symbol.kind !== CompletionItemKind.Module)
    .map(symbol => DocumentSymbol.create(
      symbol.name,
      symbol.path,
      symbol.kind === CompletionItemKind.Class ? SymbolKind.Class : SymbolKind.Object,
      Range.create(
        { line: symbol.line, character: 0 },
        { line: symbol.line, character: lineLength(document, symbol.line) }
      ),
      Range.create(
        { line: symbol.line, character: symbol.start },
        { line: symbol.line, character: symbol.end }
      )
    ));
}

function matchesSymbol(reference: SymbolReference, symbol: SymbolDefinition): boolean {
  if (symbol.kind === CompletionItemKind.Class) {
    return reference.name.toLowerCase() === symbol.name.toLowerCase();
  }
  return (reference.path ?? reference.name).toLowerCase() === symbol.path.toLowerCase();
}

function matchingRanges(index: DocumentIndex, symbol: SymbolDefinition): Range[] {
  const ranges = new Map<string, Range>();
  const add = (line: number, start: number, end: number) => {
    const key = `${line}:${start}:${end}`;
    if (!ranges.has(key)) {
      ranges.set(key, Range.create({ line, character: start }, { line, character: end }));
    }
  };
  for (const definition of index.definitions) {
    if (matchesSymbol(definition, symbol)) {
      add(definition.line, definition.start, definition.end);
    }
  }
  for (const reference of index.references) {
    if (matchesSymbol(reference, symbol)) {
      add(reference.line, reference.start, reference.end);
    }
  }
  return [...ranges.values()];
}

export function referencesAt(document: TextDocument, position: Position, index: DocumentIndex): DocumentHighlight[] {
  const symbol = referenceAt(document, position, index);
  if (!symbol) {
    return [];
  }
  return matchingRanges(index, symbol).map(range => DocumentHighlight.create(range));
}

export function renameAt(
  document: TextDocument,
  position: Position,
  newName: string,
  index: DocumentIndex
): WorkspaceEdit | null {
  if (!/^[A-Za-z_][\w-]*$/.test(newName)) {
    return null;
  }
  const symbol = referenceAt(document, position, index);
  if (!symbol) {
    return null;
  }
  const edits = matchingRanges(index, symbol).map(range => TextEdit.replace(range, newName));
  if (edits.length === 0) {
    return null;
  }
  return { changes: { [document.uri]: edits } };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Normalizes spacing around key separators without touching strings, comments, or URLs. */
function normalizeKeyColons(line: string): string {
  const { masked } = scanLine(line);
  const edits: Edit[] = [];
  const segmentStarts = [0];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{" || masked[i] === ";") {
      segmentStarts.push(i + 1);
    }
  }
  for (const segmentStart of segmentStarts) {
    const key = parseKeyPath(line.slice(segmentStart), masked.slice(segmentStart));
    if (!key) {
      continue;
    }
    const colon = segmentStart + key.colon;
    let before = colon;
    while (before > segmentStart && line[before - 1] === " ") {
      before--;
    }
    let after = colon + 1;
    while (after < line.length && line[after] === " ") {
      after++;
    }
    const hasValue = after < line.length;
    edits.push({ start: before, end: after, text: hasValue ? ": " : ":" });
  }
  if (edits.length === 0) {
    return line;
  }
  let result = line;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result.replace(/;\s+/g, "; ");
}

export function formatDocument(document: TextDocument): TextEdit[] {
  const original = document.getText();
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  let indent = 0;
  let inBlockString = false;
  const output = lines.map(rawLine => {
    if (inBlockString) {
      if (rawLine.trim() === "|") {
        inBlockString = false;
        return `${"  ".repeat(indent)}|`;
      }
      return rawLine;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return "";
    }
    const { masked, blockString } = scanLine(trimmed);
    const opens = (masked.match(/[{[]/g) ?? []).length;
    const closes = (masked.match(/[}\]]/g) ?? []).length;
    if (closes > opens) {
      indent = Math.max(0, indent - (closes - opens));
    }
    const formatted = `${"  ".repeat(indent)}${normalizeKeyColons(trimmed)}`;
    if (blockString) {
      inBlockString = true;
      return formatted;
    }
    if (opens > closes || (opens === closes && /:\s*$/.test(masked))) {
      indent++;
    }
    return formatted;
  });
  const formatted = output.join(eol);
  if (formatted === original) {
    return [];
  }
  return [TextEdit.replace(Range.create(
    { line: 0, character: 0 },
    document.positionAt(original.length)
  ), formatted)];
}

function lineRange(document: TextDocument, range: Range): Range {
  const startLine = Math.max(0, Math.min(range.start.line, document.lineCount - 1));
  const endLine = Math.max(startLine, Math.min(range.end.line, document.lineCount - 1));
  return Range.create(
    { line: startLine, character: 0 },
    { line: endLine, character: lineLength(document, endLine) }
  );
}

export function codeActions(document: TextDocument, range: Range, index: DocumentIndex): CodeAction[] {
  const actions: CodeAction[] = [];
  const text = document.getText(lineRange(document, range));
  if (/\bshape\s*:\s*$/.test(text)) {
    actions.push(CodeAction.create(
      "Insert rectangle shape",
      { changes: { [document.uri]: [TextEdit.insert(range.end, " rectangle")] } },
      CodeActionKind.QuickFix
    ));
  }
  const unknownClass = text.match(/\bclass\s*:\s*([A-Za-z_][\w-]*)/);
  if (unknownClass && !index.classes.has(unknownClass[1].toLowerCase())) {
    actions.push(CodeAction.create(
      `Create class '${unknownClass[1]}'`,
      { changes: { [document.uri]: [TextEdit.insert(Position.create(0, 0), `classes.${unknownClass[1]}: {\n}\n\n`)] } },
      CodeActionKind.QuickFix
    ));
  }
  return actions;
}

export function valueCompletions(label: string): string[] {
  return D2_VALUE_HINTS[label] ?? [];
}

export const supportedKeywords = [...D2_KEYWORDS, ...D2_STYLE_KEYWORDS];
