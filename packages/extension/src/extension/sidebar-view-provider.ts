/**
 * Sidebar webview view provider for the BPMNscript activity-bar panel.
 *
 * Registers under the view ID `bpmnscript.sidebar` and renders a small VS Code
 * webview for the active file: one button that converts it to the other format
 * (`.bpmnscript` → `.bpmn` or back), a link to jump to its counterpart file
 * when one already exists, and a button to pick a `.bpmn` file from disk and
 * decompile it.
 *
 * All conversion logic is delegated to the `bpmnscript.compile`,
 * `bpmnscript.decompile`, and `bpmnscript.openAndDecompile` commands (registered
 * in `main.ts`). This provider only handles messaging between the webview and
 * those commands.
 *
 * Security model:
 * - Strict CSP with a per-render nonce (no inline scripts, no remote sources).
 * - `localResourceRoots` limited to the `media/` directory.
 * - All DOM manipulation in the webview uses `textContent`/`createElement`
 *   (see `media/sidebar.js`) — no `innerHTML` with untrusted data.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { swapExtension } from './conversion-core.js';

// -------------------------------------------------------------------------
// Types shared between host and webview (duplicated in sidebar.js as JSDoc)
// -------------------------------------------------------------------------

interface Counterpart {
  uri: string;
  name: string;
}

interface ActiveFile {
  uri: string;
  name: string;
  kind: 'dsl' | 'bpmn' | null;
  /** The existing twin file (other format), if one is present on disk. */
  counterpart: Counterpart | null;
}

// -------------------------------------------------------------------------
// Provider
// -------------------------------------------------------------------------

/**
 * Provides the BPMNscript sidebar webview view.
 *
 * Registered in `activate()` via `window.registerWebviewViewProvider`.
 * `refresh()` is called by the active-editor listener to keep the panel in
 * sync with whichever file is focused.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  /** The view type identifier contributed in `package.json`. */
  static readonly viewType = 'bpmnscript.sidebar';

  /** The currently resolved webview view, if any. */
  private _view?: vscode.WebviewView;

  /**
   * @param _extensionUri The URI of the extension's installation directory,
   *   used to resolve `media/` asset paths for `webview.asWebviewUri`.
   */
  constructor(private readonly _extensionUri: vscode.Uri) {}

  // -------------------------------------------------------------------------
  // WebviewViewProvider implementation
  // -------------------------------------------------------------------------

  /**
   * Called by VS Code when the sidebar view becomes visible for the first
   * time (or after the webview context is recreated when
   * `retainContextWhenHidden` is off).
   *
   * Sets up the webview options, injects the nonce-protected HTML, and wires
   * the message handler. The webview requests fresh state immediately by
   * posting `{type:'ready'}` on script load.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    // Restrict scripts to the media/ directory and enable JavaScript.
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    // Inject the nonce-protected HTML.
    webviewView.webview.html = this._buildHtml(webviewView.webview);

    // Handle messages from the webview. Collect the returned disposable so it
    // is cleaned up when the view is destroyed (retainContextWhenHidden:false
    // means the view is recreated on each show, so proper disposal matters).
    const disposables: vscode.Disposable[] = [];
    webviewView.webview.onDidReceiveMessage(
      (message: unknown) => void this._handleMessage(message),
      undefined,
      disposables,
    );
    webviewView.onDidDispose(() => disposables.forEach((d) => d.dispose()));
  }

  // -------------------------------------------------------------------------
  // Public API (called by the active-editor listener)
  // -------------------------------------------------------------------------

  /**
   * Gather the current active-editor file (and its counterpart, if any), then
   * post `{type:'state', activeFile}` to the webview.
   *
   * Safe to call before `resolveWebviewView` — it is a no-op when the view
   * has not yet been resolved.
   */
  async refresh(): Promise<void> {
    if (!this._view) return;
    await this._postState();
  }

  // -------------------------------------------------------------------------
  // Private — message handling
  // -------------------------------------------------------------------------

  /** Dispatch an incoming webview message to the appropriate handler. */
  private async _handleMessage(message: unknown): Promise<void> {
    const msg = message as { type: string; uri?: string };

    switch (msg.type) {
      case 'ready':
        // Webview has (re-)loaded; push current state.
        await this._postState();
        break;

      case 'compile':
        if (msg.uri) {
          await vscode.commands.executeCommand(
            'bpmnscript.compile',
            vscode.Uri.parse(msg.uri),
          );
        }
        break;

      case 'decompile':
        if (msg.uri) {
          await vscode.commands.executeCommand(
            'bpmnscript.decompile',
            vscode.Uri.parse(msg.uri),
          );
        }
        break;

      case 'open':
        // Jump to the counterpart (or any) file.
        if (msg.uri) {
          await vscode.window.showTextDocument(vscode.Uri.parse(msg.uri));
        }
        break;

      case 'pick':
        // Open a file picker, decompile the chosen .bpmn, and open the result.
        await vscode.commands.executeCommand('bpmnscript.openAndDecompile');
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Private — state gathering
  // -------------------------------------------------------------------------

  /**
   * Collect active-editor info (file name, kind, and existing counterpart),
   * then post `{type:'state', activeFile}` to the webview.
   */
  private async _postState(): Promise<void> {
    if (!this._view) return;

    const editor = vscode.window.activeTextEditor;
    let activeFile: ActiveFile | null = null;

    if (editor) {
      const uri = editor.document.uri;
      const ext = path.extname(uri.fsPath).toLowerCase();
      const kind: 'dsl' | 'bpmn' | null =
        ext === '.bpmnscript' ? 'dsl' : ext === '.bpmn' ? 'bpmn' : null;

      activeFile = {
        uri: uri.toString(),
        name: path.basename(uri.fsPath),
        kind,
        counterpart: kind ? await this._findCounterpart(uri, kind) : null,
      };
    }

    void this._view.webview.postMessage({ type: 'state', activeFile });
  }

  /**
   * Return the existing twin file in the other format, or `null` if none is
   * present on disk. A `.bpmnscript` maps to its `.bpmn` sibling and vice versa.
   */
  private async _findCounterpart(
    uri: vscode.Uri,
    kind: 'dsl' | 'bpmn',
  ): Promise<Counterpart | null> {
    const otherExt = kind === 'dsl' ? '.bpmn' : '.bpmnscript';
    const otherPath = swapExtension(uri.fsPath, otherExt);
    const otherUri = vscode.Uri.file(otherPath);
    try {
      await vscode.workspace.fs.stat(otherUri);
      return { uri: otherUri.toString(), name: path.basename(otherPath) };
    } catch {
      // Stat threw — the counterpart does not exist.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Private — HTML generation
  // -------------------------------------------------------------------------

  /**
   * Read `media/sidebar.html`, substitute per-render nonce and asset URIs,
   * and return the final HTML string to inject into the webview.
   *
   * A fresh 128-bit random nonce is generated on every call so each render
   * cycle gets a unique token — even if the webview is hidden and shown again.
   */
  private _buildHtml(webview: vscode.Webview): string {
    // Generate a per-render nonce (128 bits of entropy, hex-encoded).
    const nonce = randomBytes(16).toString('hex');
    const cspSource = webview.cspSource;

    // Resolve asset URIs so the webview can load them from the media/ directory.
    const cssUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css'),
      )
      .toString();
    const jsUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.js'),
      )
      .toString();

    // Read the HTML template from disk and substitute placeholders.
    const templatePath = vscode.Uri.joinPath(
      this._extensionUri,
      'media',
      'sidebar.html',
    ).fsPath;
    let html = fs.readFileSync(templatePath, 'utf-8');

    // {{NONCE}} appears in both the CSP meta tag and the <script> tag.
    html = html
      .replaceAll('{{NONCE}}', nonce)
      .replaceAll('{{CSP_SOURCE}}', cspSource)
      .replace('{{CSS_URI}}', cssUri)
      .replace('{{JS_URI}}', jsUri);

    return html;
  }
}
