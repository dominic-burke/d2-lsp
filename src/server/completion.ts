import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { D2_KEYWORDS, D2_SHAPES, D2_STYLE_KEYWORDS } from "../shared/keywords.js";
import { DocumentIndex } from "./documentIndex.js";
import { valueCompletions } from "./features.js";

function items(values: readonly string[], kind: CompletionItemKind, detail: string): CompletionItem[] {
  return values.map(label => ({ label, kind, detail }));
}

/** Concatenates completion groups, keeping the first entry for each label. */
function unique(groups: CompletionItem[][]): CompletionItem[] {
  const seen = new Set<string>();
  const result: CompletionItem[] = [];
  for (const item of groups.flat()) {
    const key = item.label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function completionAt(document: TextDocument, position: Position, index: DocumentIndex): CompletionItem[] {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: position
  });
  const enclosing = index.parentsByLine[position.line] ?? "";
  const inStyleBlock = enclosing.toLowerCase() === "style" || enclosing.toLowerCase().endsWith(".style");
  if (inStyleBlock || /\bstyle\s*:\s*[{]?\s*[\w-]*$/i.test(line)) {
    return items(D2_STYLE_KEYWORDS, CompletionItemKind.Property, "D2 style property");
  }
  const valueMatch = line.match(/(?:^|[\s.])([A-Za-z_-]+)\s*:\s*[\w-]*$/);
  if (valueMatch) {
    const values = valueCompletions(valueMatch[1]);
    if (values.length > 0) {
      return items(values, CompletionItemKind.Value, `Value for ${valueMatch[1]}`);
    }
  }
  const beforeColon = line.match(/^\s*((?:[\w-]+\s*\.)*[\w-]*)$/);
  const afterDot = line.match(/(?:^|\s)((?:[\w-]+\.)+)([\w-]*)$/);
  if (afterDot) {
    // Inside a `{ }` block the typed prefix is relative to the enclosing path, so resolve it
    // against the block's parent before matching children.
    const typed = afterDot[1].split(".").filter(Boolean).join(".");
    const prefix = [enclosing, typed].filter(Boolean).join(".");
    const prefixLower = prefix.toLowerCase();
    const depth = prefix.split(".").length;
    const children = [...index.symbols.values()]
      .filter(symbol => symbol.path.toLowerCase().startsWith(`${prefixLower}.`))
      .filter(symbol => symbol.path.split(".").length === depth + 1)
      .map(symbol => symbol.name);
    return [...new Set(children)].map(label => ({
      label,
      kind: CompletionItemKind.Field,
      detail: `D2 object in ${prefix}`,
      insertText: label
    }));
  }
  if (beforeColon) {
    return unique([
      items(D2_KEYWORDS, CompletionItemKind.Keyword, "D2 keyword"),
      items(D2_SHAPES, CompletionItemKind.Value, "D2 shape")
    ]);
  }
  return unique([
    items([...index.symbols.values()].map(symbol => symbol.name), CompletionItemKind.Field, "D2 object"),
    items([...index.classes.values()].map(symbol => symbol.name), CompletionItemKind.Class, "D2 class"),
    items(D2_KEYWORDS, CompletionItemKind.Keyword, "D2 keyword")
  ]).map(item => ({ ...item, insertTextFormat: InsertTextFormat.PlainText }));
}
