import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let previewPanel: vscode.WebviewPanel | undefined;
const execFileAsync = promisify(execFile);

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("d2LanguageSupport");
}

export function activate(context: vscode.ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join("dist", "server", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio }
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "d2" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.d2")
    },
    initializationOptions: { d2Path: configuration().get<string>("d2Path", "d2") }
  };
  client = new LanguageClient("d2LanguageServer", "D2 Language Server", serverOptions, clientOptions);
  context.subscriptions.push(client);
  client.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`D2 language server failed to start: ${message}`);
  });
  context.subscriptions.push(vscode.commands.registerCommand("d2LanguageSupport.preview", () => previewActiveDocument()));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (document.languageId === "d2" && configuration().get<boolean>("previewOnSave", false)) {
      void previewDocument(document);
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("d2LanguageSupport.d2Path")) {
      void client?.sendNotification("workspace/didChangeConfiguration", {
        settings: { d2LanguageSupport: { d2Path: configuration().get<string>("d2Path", "d2") } }
      });
    }
  }));
}

export function deactivate(): Thenable<void> | undefined {
  previewPanel?.dispose();
  previewPanel = undefined;
  return client?.stop();
}

async function previewActiveDocument(): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.languageId !== "d2") {
    void vscode.window.showInformationMessage("Open a D2 document to preview it.");
    return;
  }
  await previewDocument(document);
}

async function previewDocument(document: vscode.TextDocument): Promise<void> {
  if (document.isUntitled) {
    void vscode.window.showWarningMessage("Save the D2 document before opening a preview.");
    return;
  }
  const d2Path = configuration().get<string>("d2Path", "d2");
  try {
    const result = await execFileAsync(d2Path, [document.uri.fsPath, "--stdout-format", "svg", "-"], {
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024
    });
    const svg = Buffer.from(result.stdout).toString("base64");
    if (!previewPanel) {
      previewPanel = vscode.window.createWebviewPanel(
        "d2Preview",
        "D2 Preview",
        vscode.ViewColumn.Beside,
        { enableScripts: false }
      );
      previewPanel.onDidDispose(() => {
        previewPanel = undefined;
      });
    }
    previewPanel.title = `D2 Preview: ${path.basename(document.fileName)}`;
    previewPanel.webview.html = `<!doctype html><html><body style="margin:0;background:#fff"><img style="display:block;width:100%;height:auto" src="data:image/svg+xml;base64,${svg}" /></body></html>`;
    previewPanel.reveal(undefined, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`D2 preview failed: ${message}`);
  }
}
