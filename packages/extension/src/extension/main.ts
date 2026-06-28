import type {
  LanguageClientOptions,
  ServerOptions,
} from 'vscode-languageclient/node.js';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node.js';
import {
  compileCommand,
  decompileCommand,
  pickBpmnAndDecompileCommand,
} from './conversion.js';
import { SidebarViewProvider } from './sidebar-view-provider.js';

let client: LanguageClient;

// This function is called when the extension is activated.
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // --- Conversion: diagnostic collection for the Problems panel ---
  const convDiagnostics = vscode.languages.createDiagnosticCollection('bpmnscript');
  context.subscriptions.push(convDiagnostics);

  // Read the extension version once; stamped into generated BPMN as exporterVersion.
  const extensionVersion = String(
    (context.extension.packageJSON as { version?: string }).version ?? '0.0.1',
  );

  // Register the conversion commands. `compile`/`decompile` return the output
  // Uri so callers can react to the produced file; the decompile handler is
  // reused by the file-picker command.
  const decompile = decompileCommand(convDiagnostics);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bpmnscript.compile',
      compileCommand(convDiagnostics, extensionVersion),
    ),
    vscode.commands.registerCommand('bpmnscript.decompile', decompile),
    vscode.commands.registerCommand(
      'bpmnscript.openAndDecompile',
      pickBpmnAndDecompileCommand(decompile),
    ),
  );

  // --- Sidebar webview view provider ---
  // The provider reference is kept in scope so the active-editor listener
  // (added below) can call provider.refresh().
  const provider = new SidebarViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: false } },
    ),
  );

  // --- Active-editor change listener ---
  // Keeps the active-file panel (name, convert button, counterpart link) in
  // sync when the user switches editor tabs.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => void provider.refresh()),
  );

  // --- Initial refresh ---
  // Populate the sidebar on activation. The webview also requests state via
  // {type:'ready'} when its script loads; the listener above keeps it current
  // thereafter. Safe to call before resolveWebviewView — refresh() is a no-op
  // until the view is resolved.
  void provider.refresh();

  // --- Language server (existing, untouched) ---
  client = await startLanguageClient(context);
}

// This function is called when the extension is deactivated.
export function deactivate(): Promise<void> | undefined {
  if (client) {
    return client.stop();
  }
  return undefined;
}

async function startLanguageClient(
  context: vscode.ExtensionContext,
): Promise<LanguageClient> {
  const serverModule = context.asAbsolutePath(
    path.join('out', 'language', 'main.cjs'),
  );
  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging.
  // By setting `process.env.DEBUG_BREAK` to a truthy value, the language server will wait until a debugger is attached.
  const debugOptions = {
    execArgv: [
      '--nolazy',
      `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`,
    ],
  };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: '*', language: 'bpmn-script' }],
  };

  // Create the language client and start the client.
  const client = new LanguageClient(
    'bpmn-script',
    'BpmnScript',
    serverOptions,
    clientOptions,
  );

  // Start the client. This will also launch the server
  await client.start();
  return client;
}
