import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Location } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DocumentIndex, indexDocument } from "./documentIndex.js";

export interface ImportedDocument {
  document: TextDocument;
  index: DocumentIndex;
}

interface CacheEntry {
  mtimeMs: number;
  imported: ImportedDocument;
}

const cache = new Map<string, CacheEntry>();

function importFilePath(document: TextDocument, imported: string): string | null {
  if (!document.uri.startsWith("file:")) {
    return null;
  }
  try {
    const name = imported.endsWith(".d2") ? imported : `${imported}.d2`;
    return path.resolve(path.dirname(fileURLToPath(document.uri)), name);
  } catch {
    return null;
  }
}

export function importedDocuments(document: TextDocument, index: DocumentIndex): ImportedDocument[] {
  const results: ImportedDocument[] = [];
  for (const imported of index.imports) {
    if (imported.startsWith("http://") || imported.startsWith("https://")) {
      continue;
    }
    const filePath = importFilePath(document, imported);
    if (!filePath || !existsSync(filePath)) {
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      results.push(cached.imported);
      continue;
    }
    try {
      const uri = pathToFileURL(filePath).toString();
      const importedDocument = TextDocument.create(uri, "d2", 1, readFileSync(filePath, "utf8"));
      const entry: CacheEntry = { mtimeMs, imported: { document: importedDocument, index: indexDocument(importedDocument) } };
      cache.set(filePath, entry);
      results.push(entry.imported);
    } catch {
      continue;
    }
  }
  return results;
}

/** Returns a new index that also resolves symbols from imported documents. */
export function mergeImportedIndexes(index: DocumentIndex, imported: ImportedDocument[]): DocumentIndex {
  if (imported.length === 0) {
    return index;
  }
  const symbols = new Map(index.symbols);
  const classes = new Map(index.classes);
  for (const item of imported) {
    for (const [key, symbol] of item.index.symbols) {
      if (!symbols.has(key)) {
        symbols.set(key, symbol);
      }
    }
    for (const [key, symbol] of item.index.classes) {
      if (!classes.has(key)) {
        classes.set(key, symbol);
      }
    }
  }
  return { ...index, symbols, classes };
}

export function importedDefinition(document: TextDocument, index: DocumentIndex, token: string): Location | null {
  if (!token) {
    return null;
  }
  for (const item of importedDocuments(document, index)) {
    const symbol = item.index.classes.get(token.toLowerCase()) ?? item.index.symbols.get(token.toLowerCase());
    if (symbol) {
      return Location.create(
        item.document.uri,
        { start: { line: symbol.line, character: symbol.start }, end: { line: symbol.line, character: symbol.end } }
      );
    }
  }
  return null;
}
