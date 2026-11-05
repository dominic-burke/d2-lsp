import { spawn } from "node:child_process";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DocumentIndex, lineText, scanLine } from "./documentIndex.js";
import { D2_SHAPES, D2_STYLE_KEYWORDS } from "../shared/keywords.js";

export interface CompilerOptions {
  d2Path?: string;
}

function documentDirectory(document: TextDocument): string | undefined {
  if (!document.uri.startsWith("file:")) {
    return undefined;
  }
  try {
    return path.dirname(fileURLToPath(document.uri));
  } catch {
    return undefined;
  }
}

function validateWithCli(
  document: TextDocument,
  options: CompilerOptions
): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const child = spawn(options.d2Path || "d2", ["validate", "-"], { cwd: documentDirectory(document) });
    let output = "";
    let settled = false;
    const finish = (code: number, text: string) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ code, output: text });
    };
    child.stdout.on("data", chunk => output += chunk.toString());
    child.stderr.on("data", chunk => output += chunk.toString());
    child.on("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(1, code === "ENOENT"
        ? `D2 CLI not found: ${options.d2Path || "d2"}. Install D2 or set "d2.path".`
        : error.message);
    });
    child.on("close", code => finish(code ?? 1, output));
    child.stdin.on("error", () => {
      // The child may exit before consuming stdin; the close handler reports the real result.
    });
    child.stdin.end(document.getText());
  });
}

function lineLength(document: TextDocument, line: number): number {
  return lineText(document, Math.max(0, Math.min(line, document.lineCount - 1))).length;
}

export function localDiagnostics(document: TextDocument, index: DocumentIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, number>();
  for (const definition of index.definitions) {
    // Parents are implied by dotted keys and connections only reference existing objects, so
    // neither is a duplicate declaration.
    if (definition.origin === "parent" || definition.origin === "connection") {
      continue;
    }
    const key = definition.path.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined && previous !== definition.line) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: Range.create(
          Position.create(definition.line, definition.start),
          Position.create(definition.line, definition.end)
        ),
        message: `Duplicate D2 object '${definition.path}'.`,
        source: "d2"
      });
    }
    seen.set(key, definition.line);
  }

  const directory = documentDirectory(document);
  index.imports.forEach((imported, position) => {
    if (imported.startsWith("http://") || imported.startsWith("https://")) {
      return;
    }
    if (!directory) {
      return;
    }
    const reference = index.importReferences[position];
    const line = reference?.line ?? 0;
    const importPath = path.resolve(directory, imported.endsWith(".d2") ? imported : `${imported}.d2`);
    const resolved = existsSync(importPath);
    diagnostics.push({
      severity: resolved ? DiagnosticSeverity.Hint : DiagnosticSeverity.Error,
      range: Range.create(Position.create(line, 0), Position.create(line, lineLength(document, line))),
      message: resolved ? `Import resolved from ${importPath}.` : `D2 import not found: ${importPath}.`,
      source: "d2"
    });
  });

  for (const styleKey of index.styleKeys) {
    if (D2_STYLE_KEYWORDS.includes(styleKey.name as typeof D2_STYLE_KEYWORDS[number])) {
      continue;
    }
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: Range.create(
        Position.create(styleKey.line, styleKey.start),
        Position.create(styleKey.line, styleKey.end)
      ),
      message: `Unknown D2 style property '${styleKey.name}'.`,
      source: "d2"
    });
  }

  // Shape values are scanned on the masked line so that `label: "shape: bogus"`, comments, and
  // block string bodies do not produce false positives.
  const lines = document.getText().split(/\r?\n/);
  let blockStringTerminator: string | null = null;
  lines.forEach((line, lineNumber) => {
    if (blockStringTerminator) {
      if (line.trim() === blockStringTerminator) {
        blockStringTerminator = null;
      }
      return;
    }
    const { masked, blockStringTerminator: terminator } = scanLine(line);
    if (terminator) {
      blockStringTerminator = terminator;
    }
    for (const shape of masked.matchAll(/\bshape\s*:\s*([A-Za-z_][\w-]*)/g)) {
      const name = shape[1];
      if (D2_SHAPES.includes(name as typeof D2_SHAPES[number])) {
        continue;
      }
      const start = (shape.index ?? 0) + shape[0].length - name.length;
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: Range.create(Position.create(lineNumber, start), Position.create(lineNumber, start + name.length)),
        message: `Unknown D2 shape '${name}'.`,
        source: "d2"
      });
    }
  });
  return diagnostics;
}

export async function compilerDiagnostics(
  document: TextDocument,
  options: CompilerOptions = {}
): Promise<Diagnostic[]> {
  const result = await validateWithCli(document, options);
  if (result.code === 0) {
    return [];
  }
  const message = result.output.trim() || "D2 validation failed.";
  const match = message.match(/(\d+):(\d+):/);
  const line = match ? Math.max(0, Number(match[1]) - 1) : 0;
  const character = match ? Math.max(0, Number(match[2]) - 1) : 0;
  return [{
    severity: DiagnosticSeverity.Error,
    range: Range.create(
      Position.create(line, Math.min(character, lineLength(document, line))),
      Position.create(line, lineLength(document, line))
    ),
    message,
    source: "d2"
  }];
}
