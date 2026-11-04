import {
  CompletionItemKind,
  Position,
  TextDocumentPositionParams,
  Location,
  Range
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

export type SymbolOrigin = "key" | "parent" | "connection";

export interface SymbolDefinition {
  name: string;
  path: string;
  line: number;
  start: number;
  end: number;
  kind: CompletionItemKind;
  origin?: SymbolOrigin;
  uri?: string;
}

export interface SymbolReference {
  name: string;
  path?: string;
  line: number;
  start: number;
  end: number;
}

export interface DocumentIndex {
  symbols: Map<string, SymbolDefinition>;
  classes: Map<string, SymbolDefinition>;
  definitions: SymbolDefinition[];
  references: SymbolReference[];
  imports: string[];
  styleKeys: SymbolReference[];
  /** Enclosing block path for each line, used to resolve context-sensitive completions. */
  parentsByLine: string[];
}

export interface KeyPart {
  name: string;
  start: number;
  end: number;
}

export interface LineScan {
  /** The line with string contents and trailing comments replaced by filler characters. */
  masked: string;
  /** True when the line opens a `|` block string. */
  blockString: boolean;
}

const FILLER = "\u0001";
const WORD = /[A-Za-z0-9_-]/;
const BARE_KEY = /^[A-Za-z_][\w-]*/;
const IMPORT_PATH = /^[A-Za-z0-9_./-]+/;

/**
 * Replaces the contents of quoted strings and trailing comments with filler characters so that
 * structural characters (`:`, `{`, `}`, `@`, `.`) inside them are not mistaken for syntax.
 * The returned string always has the same length as the input, so offsets stay aligned.
 */
export function scanLine(line: string): LineScan {
  const masked = line.split("");
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      for (let k = i; k < line.length; k++) {
        masked[k] = " ";
      }
      break;
    }
    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === char) {
          break;
        }
        j++;
      }
      for (let k = i + 1; k < Math.min(j, line.length); k++) {
        masked[k] = FILLER;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  const text = masked.join("");
  return { masked: text, blockString: /:\s*\|[A-Za-z]*\s*$/.test(text) };
}

/** Parses a `a.b."c d":` key path from the start of a line. */
export function parseKeyPath(line: string, masked: string): { parts: KeyPart[]; colon: number } | null {
  const parts: KeyPart[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < masked.length && /\s/.test(masked[i])) {
      i++;
    }
  };
  skipSpace();
  while (i < masked.length) {
    const char = masked[i];
    if (char === '"' || char === "'") {
      const close = masked.indexOf(char, i + 1);
      if (close < 0) {
        return null;
      }
      parts.push({ name: line.slice(i + 1, close), start: i + 1, end: close });
      i = close + 1;
    } else {
      const match = BARE_KEY.exec(masked.slice(i));
      if (!match) {
        return null;
      }
      parts.push({ name: match[0], start: i, end: i + match[0].length });
      i += match[0].length;
    }
    skipSpace();
    if (masked[i] === ".") {
      i++;
      skipSpace();
      continue;
    }
    break;
  }
  if (parts.length === 0 || masked[i] !== ":") {
    return null;
  }
  return { parts, colon: i };
}

function parsePathParts(line: string, masked: string, start: number, end: number): KeyPart[] {
  const parts: KeyPart[] = [];
  let i = start;
  const skipSpace = () => {
    while (i < end && /\s/.test(masked[i])) {
      i++;
    }
  };
  skipSpace();
  while (i < end) {
    const char = masked[i];
    if (char === '"' || char === "'") {
      const close = masked.indexOf(char, i + 1);
      if (close < 0 || close >= end) {
        break;
      }
      parts.push({ name: line.slice(i + 1, close), start: i + 1, end: close });
      i = close + 1;
    } else {
      const match = BARE_KEY.exec(masked.slice(i, end));
      if (!match) {
        break;
      }
      parts.push({ name: match[0], start: i, end: i + match[0].length });
      i += match[0].length;
    }
    skipSpace();
    if (masked[i] === ".") {
      i++;
      skipSpace();
      continue;
    }
    break;
  }
  return parts;
}

function findArrows(masked: string, from: number): Array<{ index: number; length: number }> {
  const arrows: Array<{ index: number; length: number }> = [];
  for (let i = from; i < masked.length; i++) {
    if (masked.startsWith("<->", i)) {
      arrows.push({ index: i, length: 3 });
      i += 2;
      continue;
    }
    if (masked.startsWith("->", i) || masked.startsWith("<-", i)) {
      arrows.push({ index: i, length: 2 });
      i += 1;
      continue;
    }
    // `a--b` is a valid key, so only treat `--` as a connection when it is surrounded by spaces.
    if (masked.startsWith("--", i) && /\s/.test(masked[i - 1] ?? " ") && /\s/.test(masked[i + 2] ?? " ")) {
      arrows.push({ index: i, length: 2 });
      i += 1;
    }
  }
  return arrows;
}

function firstValueToken(line: string, masked: string, from: number): KeyPart | null {
  let i = from;
  while (i < masked.length && /\s/.test(masked[i])) {
    i++;
  }
  if (i >= masked.length) {
    return null;
  }
  const char = masked[i];
  if (char === '"' || char === "'") {
    const close = masked.indexOf(char, i + 1);
    if (close < 0) {
      return null;
    }
    return { name: line.slice(i + 1, close), start: i + 1, end: close };
  }
  const match = BARE_KEY.exec(masked.slice(i));
  if (!match) {
    return null;
  }
  return { name: match[0], start: i, end: i + match[0].length };
}

function parseImport(line: string, masked: string): KeyPart | null {
  const at = masked.indexOf("@");
  if (at < 0) {
    return null;
  }
  const before = masked.slice(0, at).trim();
  if (before !== "" && before !== "...") {
    return null;
  }
  const i = at + 1;
  if (line[i] === '"' || line[i] === "'") {
    const close = line.indexOf(line[i], i + 1);
    if (close < 0) {
      return null;
    }
    return { name: line.slice(i + 1, close), start: i + 1, end: close };
  }
  const match = IMPORT_PATH.exec(line.slice(i));
  if (!match) {
    return null;
  }
  return { name: match[0], start: i, end: i + match[0].length };
}

export function indexDocument(document: TextDocument): DocumentIndex {
  const symbols = new Map<string, SymbolDefinition>();
  const classes = new Map<string, SymbolDefinition>();
  const definitions: SymbolDefinition[] = [];
  const references: SymbolReference[] = [];
  const styleKeys: SymbolReference[] = [];
  const imports: string[] = [];
  const parentsByLine: string[] = [];
  const lines = document.getText().split(/\r?\n/);
  const parents: Array<{ indent: number; path: string; braceDepth: number }> = [];
  let braceDepth = 0;
  let inBlockString = false;

  const addDefinition = (definition: SymbolDefinition) => {
    definitions.push(definition);
    const fullKey = definition.path.toLowerCase();
    const existing = symbols.get(fullKey);
    if (!existing || (existing.origin === "parent" && definition.origin !== "parent")) {
      symbols.set(fullKey, definition);
    }
    const shortKey = definition.name.toLowerCase();
    const shortExisting = symbols.get(shortKey);
    if (!shortExisting || (shortExisting.origin === "parent" && definition.origin !== "parent")) {
      symbols.set(shortKey, definition);
    }
  };

  lines.forEach((line, lineNumber) => {
    if (inBlockString) {
      if (line.trim() === "|") {
        inBlockString = false;
      }
      return;
    }
    const { masked, blockString } = scanLine(line);
    if (blockString) {
      inBlockString = true;
    }
    if (!masked.trim()) {
      parentsByLine[lineNumber] = parents.at(-1)?.path ?? "";
      return;
    }

    const imported = parseImport(line, masked);
    if (imported) {
      imports.push(imported.name);
    }

    const indent = line.length - line.trimStart().length;
    while (parents.length > 0) {
      const top = parents[parents.length - 1];
      if (braceDepth > top.braceDepth) {
        break;
      }
      if (indent > top.indent) {
        break;
      }
      parents.pop();
    }

    const key = parseKeyPath(line, masked);
    const parentPath = parents.at(-1)?.path;
    parentsByLine[lineNumber] = parentPath ?? "";
    let currentPath: string | undefined;

    if (key) {
      const parts = key.parts;
      const pathParts = [...(parentPath ? parentPath.split(".") : []), ...parts.map(part => part.name)];
      const path = pathParts.join(".");
      currentPath = path;
      const first = parts[0].name.toLowerCase();
      const last = parts[parts.length - 1].name.toLowerCase();
      const isClassAttribute = parts.length === 1 && first === "class";
      const isClassesBlock = parts.length === 1 && first === "classes";
      const isDottedClass = parts.length === 2 && first === "classes";
      const isClassChild = parentPath?.toLowerCase() === "classes";
      const styleIndex = parts.findIndex(part => part.name.toLowerCase() === "style");
      const parentIsStyle = parentPath !== undefined
        && (parentPath.toLowerCase() === "style" || parentPath.toLowerCase().endsWith(".style"));

      parts.forEach((part, partIndex) => {
        const isLast = partIndex === parts.length - 1;
        const partPath = pathParts.slice(0, pathParts.length - parts.length + partIndex + 1).join(".");
        const definition: SymbolDefinition = {
          name: part.name,
          path: partPath,
          line: lineNumber,
          start: part.start,
          end: part.end,
          kind: isLast ? CompletionItemKind.Field : CompletionItemKind.Module,
          origin: isLast ? "key" : "parent"
        };
        if (isClassAttribute) {
          return;
        }
        if (isLast && (isClassChild || isDottedClass)) {
          definition.kind = CompletionItemKind.Class;
        }
        addDefinition(definition);
        if (isLast && (isClassChild || isDottedClass)) {
          classes.set(part.name.toLowerCase(), definition);
        }
        if (isLast && (parentIsStyle || (styleIndex >= 0 && partIndex === styleIndex + 1))) {
          styleKeys.push({ name: part.name, path: partPath, line: lineNumber, start: part.start, end: part.end });
        }
      });

      if (isClassAttribute || last === "near") {
        const value = firstValueToken(line, masked, key.colon + 1);
        if (value) {
          references.push({ name: value.name, path: value.name, line: lineNumber, start: value.start, end: value.end });
        }
      }

      if (isClassesBlock) {
        const arrayMatch = /^\s*\[([^\]]*)\]/.exec(masked.slice(key.colon + 1));
        if (arrayMatch) {
          const base = key.colon + 1 + arrayMatch[0].indexOf("[") + 1;
          for (const item of arrayMatch[1].matchAll(/[A-Za-z_][\w-]*/g)) {
            const start = base + (item.index ?? 0);
            const definition: SymbolDefinition = {
              name: item[0],
              path: item[0],
              line: lineNumber,
              start,
              end: start + item[0].length,
              kind: CompletionItemKind.Class,
              origin: "key"
            };
            addDefinition(definition);
            classes.set(item[0].toLowerCase(), definition);
          }
        }
      }
    }

    const arrowStart = key ? key.colon + 1 : 0;
    const arrows = findArrows(masked, arrowStart);
    if (arrows.length > 0) {
      const segments: Array<[number, number]> = [];
      let segmentStart = arrowStart;
      for (const arrow of arrows) {
        segments.push([segmentStart, arrow.index]);
        segmentStart = arrow.index + arrow.length;
      }
      segments.push([segmentStart, masked.length]);
      for (const [start, end] of segments) {
        let segmentEnd = end;
        const colon = masked.indexOf(":", start);
        if (colon >= 0 && colon < segmentEnd) {
          segmentEnd = colon;
        }
        const parts = parsePathParts(line, masked, start, segmentEnd);
        if (parts.length === 0) {
          continue;
        }
        const lastPart = parts[parts.length - 1];
        const path = parts.map(part => part.name).join(".");
        references.push({ name: lastPart.name, path, line: lineNumber, start: lastPart.start, end: lastPart.end });
        addDefinition({
          name: lastPart.name,
          path,
          line: lineNumber,
          start: lastPart.start,
          end: lastPart.end,
          kind: CompletionItemKind.Field,
          origin: "connection"
        });
      }
    }

    const opens = (masked.match(/\{/g) ?? []).length;
    const closes = (masked.match(/\}/g) ?? []).length;
    const delta = opens - closes;
    if (delta > 0) {
      if (currentPath) {
        parents.push({ indent, path: currentPath, braceDepth });
      }
      braceDepth += delta;
    } else if (delta < 0) {
      braceDepth = Math.max(0, braceDepth + delta);
      while (parents.length > 0 && parents[parents.length - 1].braceDepth > braceDepth) {
        parents.pop();
      }
    } else if (currentPath && /:\s*$/.test(masked)) {
      parents.push({ indent, path: currentPath, braceDepth });
    }
  });

  return { symbols, classes, definitions, references, imports, styleKeys, parentsByLine };
}

/** Returns the text of a single line without its line break. */
export function lineText(document: TextDocument, line: number): string {
  if (line < 0 || line >= document.lineCount) {
    return "";
  }
  return document.getText({
    start: { line, character: 0 },
    end: { line, character: Number.MAX_SAFE_INTEGER }
  }).split(/\r?\n/)[0];
}

/** Returns the identifier that the cursor is inside of or immediately after. */
export function tokenAt(document: TextDocument, position: Position): { name: string; range: Range } | null {
  if (position.line < 0 || position.line >= document.lineCount) {
    return null;
  }
  const line = lineText(document, position.line);
  let start = Math.min(position.character, line.length);
  let end = start;
  while (start > 0 && WORD.test(line[start - 1])) {
    start--;
  }
  while (end < line.length && WORD.test(line[end])) {
    end++;
  }
  if (start === end) {
    return null;
  }
  return {
    name: line.slice(start, end),
    range: Range.create(Position.create(position.line, start), Position.create(position.line, end))
  };
}

/**
 * Returns the dotted path ending at the cursor (`path`) and the whole dotted chain around it
 * (`fullPath`). For `a.b` with the cursor on `a`, `path` is `a` and `fullPath` is `a.b`.
 */
export function pathAt(
  document: TextDocument,
  position: Position
): { path: string; fullPath: string; range: Range } | null {
  const token = tokenAt(document, position);
  if (!token) {
    return null;
  }
  const line = lineText(document, position.line);
  let start = token.range.start.character;
  let end = token.range.end.character;
  while (start > 0 && (WORD.test(line[start - 1]) || line[start - 1] === ".")) {
    start--;
  }
  while (end < line.length && (WORD.test(line[end]) || line[end] === ".")) {
    end++;
  }
  while (start < end && line[start] === ".") {
    start++;
  }
  while (end > start && line[end - 1] === ".") {
    end--;
  }
  return {
    path: line.slice(start, token.range.end.character),
    fullPath: line.slice(start, end),
    range: Range.create(Position.create(position.line, start), Position.create(position.line, end))
  };
}

function toLocation(uri: string, definition: SymbolDefinition): Location {
  return Location.create(uri, Range.create(
    Position.create(definition.line, definition.start),
    Position.create(definition.line, definition.end)
  ));
}

function resolveSymbol(
  document: TextDocument,
  position: Position,
  index: DocumentIndex
): SymbolDefinition | null {
  const token = tokenAt(document, position);
  if (!token) {
    return null;
  }
  const paths = pathAt(document, position);
  const candidates = [paths?.path, paths?.fullPath, token.name]
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const definition = index.symbols.get(candidate.toLowerCase());
    if (definition) {
      return definition;
    }
  }
  return index.classes.get(token.name.toLowerCase()) ?? null;
}

export function definitionAt(
  document: TextDocument,
  params: TextDocumentPositionParams,
  index: DocumentIndex
): Location | null {
  const symbol = resolveSymbol(document, params.position, index);
  return symbol ? toLocation(document.uri, symbol) : null;
}

export function referenceAt(document: TextDocument, position: Position, index: DocumentIndex): SymbolDefinition | null {
  return resolveSymbol(document, position, index);
}
