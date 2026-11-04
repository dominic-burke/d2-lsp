import {
  createConnection,
  InitializeParams,
  InitializeResult,
  TextDocuments,
  TextDocumentPositionParams,
  ProposedFeatures,
  CompletionParams,
  TextDocumentSyncKind,
  ReferenceParams,
  RenameParams,
  DocumentFormattingParams,
  CodeActionParams,
  DocumentSymbolParams,
  WorkspaceSymbolParams,
  SymbolInformation,
  SymbolKind,
  CompletionItemKind
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { completionAt } from "./completion.js";
import { definitionAt, indexDocument, DocumentIndex, tokenAt } from "./documentIndex.js";
import {
  codeActions,
  documentSymbols,
  formatDocument,
  hoverAt,
  referencesAt,
  renameAt
} from "./features.js";
import { compilerDiagnostics, localDiagnostics } from "./diagnostics.js";
import { importedDefinition, importedDocuments, mergeImportedIndexes } from "./imports.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const indexes = new Map<string, DocumentIndex>();
const timers = new Map<string, NodeJS.Timeout>();
let d2Path = "d2";

const DIAGNOSTIC_DELAY_MS = 300;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const settings = params.initializationOptions as { d2Path?: string } | undefined;
  if (settings?.d2Path) {
    d2Path = settings.d2Path;
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [".", ":"] },
      definitionProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      renameProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      documentFormattingProvider: true,
      codeActionProvider: { codeActionKinds: ["quickfix"] }
    }
  };
});

connection.onDidChangeConfiguration(params => {
  const settings = params.settings as { d2LanguageSupport?: { d2Path?: string } } | undefined;
  const configured = settings?.d2LanguageSupport?.d2Path;
  if (configured) {
    d2Path = configured;
  }
});

function indexFor(document: TextDocument): DocumentIndex {
  const existing = indexes.get(document.uri);
  if (existing) {
    return existing;
  }
  const index = indexDocument(document);
  indexes.set(document.uri, index);
  return index;
}

async function refreshDiagnostics(document: TextDocument): Promise<void> {
  const index = indexFor(document);
  const compiler = await compilerDiagnostics(document, { d2Path });
  if (documents.get(document.uri)?.version !== document.version) {
    return;
  }
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: [...localDiagnostics(document, index), ...compiler]
  });
}

function scheduleDiagnostics(document: TextDocument): void {
  const pending = timers.get(document.uri);
  if (pending) {
    clearTimeout(pending);
  }
  timers.set(document.uri, setTimeout(() => {
    timers.delete(document.uri);
    void refreshDiagnostics(document);
  }, DIAGNOSTIC_DELAY_MS));
}

documents.onDidOpen(event => {
  indexes.set(event.document.uri, indexDocument(event.document));
  scheduleDiagnostics(event.document);
});
documents.onDidChangeContent(event => {
  indexes.set(event.document.uri, indexDocument(event.document));
  scheduleDiagnostics(event.document);
});
documents.onDidClose(event => {
  const pending = timers.get(event.document.uri);
  if (pending) {
    clearTimeout(pending);
    timers.delete(event.document.uri);
  }
  indexes.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion((params: CompletionParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const index = indexFor(document);
  return completionAt(document, params.position, mergeImportedIndexes(index, importedDocuments(document, index)));
});

connection.onDefinition((params: TextDocumentPositionParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const index = indexFor(document);
  return definitionAt(document, params, index)
    ?? importedDefinition(document, index, tokenAt(document, params.position)?.name ?? "");
});

connection.onHover(params => {
  const document = documents.get(params.textDocument.uri);
  return document ? hoverAt(document, params.position, indexFor(document)) : null;
});

connection.onReferences((params: ReferenceParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const index = indexFor(document);
  const highlights = referencesAt(document, params.position, index);
  const filtered = params.context.includeDeclaration
    ? highlights
    : highlights.filter(highlight => {
      const definition = index.definitions.find(item =>
        item.line === highlight.range.start.line && item.start === highlight.range.start.character);
      return !definition;
    });
  return filtered.map(highlight => ({ uri: document.uri, range: highlight.range }));
});

connection.onRenameRequest((params: RenameParams) => {
  const document = documents.get(params.textDocument.uri);
  return document ? renameAt(document, params.position, params.newName, indexFor(document)) : null;
});

connection.onDocumentSymbol((params: DocumentSymbolParams) => {
  const document = documents.get(params.textDocument.uri);
  return document ? documentSymbols(document, indexFor(document)) : [];
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): SymbolInformation[] => {
  const query = params.query.toLowerCase();
  const results: SymbolInformation[] = [];
  for (const [uri, index] of indexes) {
    for (const symbol of index.definitions) {
      if (symbol.kind === CompletionItemKind.Module || !symbol.name.toLowerCase().includes(query)) {
        continue;
      }
      results.push(SymbolInformation.create(
        symbol.name,
        symbol.kind === CompletionItemKind.Class ? SymbolKind.Class : SymbolKind.Object,
        { start: { line: symbol.line, character: symbol.start }, end: { line: symbol.line, character: symbol.end } },
        uri
      ));
    }
  }
  return results;
});

connection.onDocumentFormatting((params: DocumentFormattingParams) => {
  const document = documents.get(params.textDocument.uri);
  return document ? formatDocument(document) : [];
});

connection.onCodeAction((params: CodeActionParams) => {
  const document = documents.get(params.textDocument.uri);
  return document ? codeActions(document, params.range, indexFor(document)) : [];
});

documents.listen(connection);
connection.listen();
