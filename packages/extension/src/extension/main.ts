import type {
  LanguageClientOptions,
  ServerOptions,
} from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import {
  compileCommand,
  decompileCommand,
  pickBpmnAndDecompileCommand,
} from './conversion.js';
import { SidebarViewProvider } from './sidebar-view-provider.js';

let client: LanguageClient;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const extensionVersion = String(
    (context.extension.packageJSON as { version?: string }).version ?? '0.0.1',
  );

  const decompile = decompileCommand();
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bpmnscript.compile',
      compileCommand(extensionVersion),
    ),
    vscode.commands.registerCommand('bpmnscript.decompile', decompile),
    vscode.commands.registerCommand(
      'bpmnscript.openAndDecompile',
      pickBpmnAndDecompileCommand(decompile),
    ),
  );

  const provider = new SidebarViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: false } },
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => void provider.refresh()),
  );

  // Safe before resolveWebviewView: refresh() no-ops until the view exists.
  void provider.refresh();

  client = await startLanguageClient(context);
}

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
  const debugOptions = {
    execArgv: [
      '--nolazy',
      `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`,
    ],
  };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: '*', language: 'bpmn-script' }],
  };

  const client = new LanguageClient(
    'bpmn-script',
    'BPMNscript',
    serverOptions,
    clientOptions,
  );

  await client.start();
  return client;
}
