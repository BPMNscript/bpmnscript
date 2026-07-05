/**
 * BPMNscript sidebar webview client script.
 *
 * Runs inside the VS Code webview (Chromium sandbox). Communicates with the
 * extension host exclusively via postMessage (no DOM event handlers in HTML).
 *
 * Message protocol (host → webview):
 *   {type:'state', activeFile}  — active-file state push
 *
 * Message protocol (webview → host):
 *   {type:'ready'}            — page loaded; request current state
 *   {type:'compile', uri}     — run bpmnscript.compile on this URI
 *   {type:'decompile', uri}   — run bpmnscript.decompile on this URI
 *   {type:'open', uri}        — open this URI in the editor (counterpart jump)
 *   {type:'pick'}             — open a .bpmn file picker and decompile it
 */
(function () {
  'use strict';

  // Acquire the VS Code API handle (can only be called once per webview).
  const vscode = acquireVsCodeApi();

  /** Current active-file state received from the host. */
  let activeFile = null;

  // Signal readiness immediately so the host pushes the current state.
  vscode.postMessage({ type: 'ready' });

  // -------------------------------------------------------------------------
  // Message handling (host → webview)
  // -------------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'state') {
      activeFile = msg.activeFile || null;
      render();
    }
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Re-render the active-file panel and the (static) file-picker button. */
  function render() {
    renderActivePanel(activeFile);
    renderPickPanel();
  }

  /** Render the active-file panel: file name, convert button, counterpart link. */
  function renderActivePanel(file) {
    const panel = document.getElementById('active-panel');
    if (!panel) return;
    clearElement(panel);

    if (!file || file.kind === null) {
      panel.appendChild(
        placeholder('Open a .bpmnscript or .bpmn file to convert it.'),
      );
      return;
    }

    const container = document.createElement('div');
    container.className = 'panel';

    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = file.name;
    nameEl.title = file.name;
    container.appendChild(nameEl);

    const convertBtn = document.createElement('button');
    convertBtn.className = 'action';
    const uri = file.uri;
    if (file.kind === 'dsl') {
      convertBtn.textContent = 'Convert to BPMN';
      convertBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'compile', uri: uri });
      });
    } else {
      convertBtn.textContent = 'Convert to BPMNscript';
      convertBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'decompile', uri: uri });
      });
    }
    container.appendChild(convertBtn);

    if (file.counterpart) {
      container.appendChild(
        linkButton(
          'Open ' + file.counterpart.name + ' →',
          file.counterpart.uri,
        ),
      );
    }

    panel.appendChild(container);
  }

  /** Render the always-available "pick a BPMN file" button. */
  function renderPickPanel() {
    const panel = document.getElementById('pick-panel');
    if (!panel) return;
    if (panel.firstChild) return; // static — render once.

    const pickBtn = document.createElement('button');
    pickBtn.className = 'action secondary';
    pickBtn.textContent = 'Pick a BPMN file…';
    pickBtn.title = 'Choose a .bpmn file to convert to BPMNscript';
    pickBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'pick' });
    });
    panel.appendChild(pickBtn);
  }

  // -------------------------------------------------------------------------
  // Element helpers
  // -------------------------------------------------------------------------

  /** Build a link-styled button that opens a file URI in the editor. */
  function linkButton(label, uri) {
    const link = document.createElement('button');
    link.className = 'link';
    link.textContent = label;
    link.title = label;
    link.addEventListener('click', function () {
      vscode.postMessage({ type: 'open', uri: uri });
    });
    return link;
  }

  /** Build a muted placeholder paragraph. */
  function placeholder(text) {
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = text;
    return p;
  }

  /** Remove all child nodes from an element. */
  function clearElement(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }
})();
