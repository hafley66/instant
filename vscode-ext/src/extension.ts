// Reports active-editor context to the instant app's unified activity store,
// mirroring extension/background.js (the Chrome extension): fire-and-forget
// POST to the localhost ingest server, errors swallowed, nothing retried. The
// app may not be running; that's fine, the event is just dropped.
//
// Hard rule: never send file contents, selection text, or terminal buffers.
// Only paths, line numbers, language ids, and workspace (folder) names leave
// this process.
// todo(http): consume the generated activity ingest contract (depends: activity :8787 OpenAPI paths)
import * as vscode from "vscode";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787/ingest";
const CURSOR_THROTTLE_MS = 1000;

type EditorEvent =
  | { type: "editor"; event: "focus"; path: string; languageId: string; workspace: string; ts: number }
  | { type: "editor"; event: "cursor"; path: string; line: number; ts: number }
  | { type: "editor"; event: "save"; path: string; ts: number };

let endpoint = DEFAULT_ENDPOINT;
let lastCursorSent = 0;

function send(ev: EditorEvent): void {
  // Fire-and-forget; never surface a user-facing error for a missing/closed app.
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ev),
  }).catch(() => {
    // swallowed: app not running, or endpoint unreachable
  });
}

function workspaceName(uri: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(uri)?.name ?? vscode.workspace.name ?? "";
}

function readEndpoint(): string {
  return vscode.workspace.getConfiguration("instantActivity").get<string>("endpoint", DEFAULT_ENDPOINT);
}

export function activate(context: vscode.ExtensionContext): void {
  endpoint = readEndpoint();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("instantActivity.endpoint")) endpoint = readEndpoint();
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const doc = editor.document;
      send({
        type: "editor",
        event: "focus",
        path: doc.uri.fsPath,
        languageId: doc.languageId,
        workspace: workspaceName(doc.uri),
        ts: Date.now(),
      });
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const now = Date.now();
      if (now - lastCursorSent < CURSOR_THROTTLE_MS) return;
      lastCursorSent = now;
      const line = e.selections[0]?.active.line;
      if (line === undefined) return;
      send({
        type: "editor",
        event: "cursor",
        path: e.textEditor.document.uri.fsPath,
        line: line + 1, // 1-based, matching editor UI line numbers
        ts: now,
      });
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      send({
        type: "editor",
        event: "save",
        path: doc.uri.fsPath,
        ts: Date.now(),
      });
    }),
  );
}

export function deactivate(): void {
  // No teardown needed: subscriptions are disposed by the extension host.
}
