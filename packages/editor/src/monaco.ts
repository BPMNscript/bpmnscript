// Monaco (classic mode) for BPMNscript: the VS Code services, the language, the theme, the
// editor and its models. Browser-only; import it from client code.
import { getService, ILabelService } from '@codingame/monaco-vscode-api';
import { createModelReference } from '@codingame/monaco-vscode-api/monaco';
import {
  editor,
  languages,
  MarkerSeverity,
  Uri,
} from '@codingame/monaco-vscode-editor-api';
import {
  getEnhancedMonacoEnvironment,
  MonacoVscodeApiWrapper,
} from 'monaco-languageclient/vscodeApiWrapper';
import {
  LANGUAGE_ID,
  modelUri,
  toLanguageConfiguration,
  type LanguageConfigurationJson,
} from './language';
import type { ConvDiagnostic } from './protocol';
import { THEME_TOKENS, themeData, type ThemeColors } from './theme';

export type MonacoOptions = {
  /** URL of Monaco's editor worker (`editor.worker.js`), same-origin. */
  editorWorkerUrl: string;
};

let api: Promise<void> | null = null;

/** Starts Monaco's VS Code services once per page; the first call's options win. */
export function ensureMonacoApi({
  editorWorkerUrl,
}: MonacoOptions): Promise<void> {
  api ??= new MonacoVscodeApiWrapper({
    $type: 'classic',
    viewsConfig: { $type: 'EditorService' },
    // A model setting, so it goes through the configuration service, not the editor options.
    userConfiguration: {
      json: JSON.stringify({ 'editor.bracketPairColorization.enabled': false }),
    },
    // getWorker hands Monaco a same-origin worker directly; its default wraps the URL in a
    // blob: worker, which a CSP without `worker-src blob:` refuses.
    monacoWorkerFactory: () => {
      getEnhancedMonacoEnvironment().getWorker = () =>
        new Worker(editorWorkerUrl, { type: 'module', name: 'editor' });
    },
  })
    .start()
    .catch((e: unknown) => {
      api = null; // the next call tries again
      throw e;
    });
  return api;
}

let languageRegistered = false;

/**
 * Registers BPMNscript with Monaco, once per page. Both inputs are `@bpmn-script/web` build
 * outputs: `monarch.js` (default export) and `language-configuration.json`.
 */
export function registerBpmnscriptLanguage(grammar: {
  monarch: languages.IMonarchLanguage;
  languageConfiguration: LanguageConfigurationJson;
}) {
  if (languageRegistered) return;
  languageRegistered = true;
  languages.register({
    id: LANGUAGE_ID,
    extensions: ['.bpmnscript'],
    aliases: ['BPMNscript'],
  });
  languages.setMonarchTokensProvider(LANGUAGE_ID, grammar.monarch);
  languages.setLanguageConfiguration(
    LANGUAGE_ID,
    toLanguageConfiguration(grammar.languageConfiguration),
  );
}

let probe: CanvasRenderingContext2D | null = null;

/** Any CSS colour as #rrggbb. */
function hex(css: string): string {
  probe ??= document.createElement('canvas').getContext('2d');
  if (!probe) return css;
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  return probe.fillStyle;
}

/**
 * Builds the theme from the `<prefix><token>` custom properties on `root` (see `THEME_TOKENS`)
 * and activates it. Dark when `<html>` has the class `dark`.
 */
export function applyMonacoTheme(root: Element, prefix = '--pg-') {
  const cs = getComputedStyle(root);
  const colors = Object.fromEntries(
    THEME_TOKENS.map((t) => [t, hex(cs.getPropertyValue(prefix + t).trim())]),
  ) as ThemeColors;
  const dark = document.documentElement.classList.contains('dark');
  const name = dark ? 'pg-dark' : 'pg-light';
  editor.defineTheme(name, themeData(colors, dark));
  editor.setTheme(name);
}

/** Applies the theme now and again whenever `<html>`'s class changes; returns a stop function. */
export function followMonacoTheme(root: Element, prefix = '--pg-'): () => void {
  applyMonacoTheme(root, prefix);
  const mo = new MutationObserver(() => applyMonacoTheme(root, prefix));
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => mo.disconnect();
}

let labelsRegistered = false;

/**
 * A BPMNscript editor in `host`, with no model. Call `ensureMonacoApi` and
 * `registerBpmnscriptLanguage` first.
 */
export async function createBpmnscriptEditor(
  host: HTMLElement,
  { ariaLabel, fontFamily }: { ariaLabel: string; fontFamily: string },
): Promise<editor.IStandaloneCodeEditor> {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const ed = editor.create(host, {
    model: null,
    ariaLabel,
    fontFamily,
    // 16px on touch screens keeps iOS from zooming in on focus.
    fontSize: coarse ? 16 : 14,
    lineHeight: coarse ? 24 : 22,
    padding: { top: 8, bottom: 8 },
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    glyphMargin: false,
    folding: false,
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 10,
    renderLineHighlight: 'line',
    stickyScroll: { enabled: false },
    wordBasedSuggestions: 'off',
    fixedOverflowWidgets: true,
    // With fixed overflow widgets the context menu's shadow root sits in the window container,
    // outside the `.monaco-editor` scope that defines the theme's --vscode-* colours: it rendered
    // transparent. In the light DOM it carries `.monaco-component` and gets them.
    ...({ useShadowDOM: false } as object),
    cursorSmoothCaretAnimation: 'off',
    smoothScrolling: false,
    guides: { indentation: true, bracketPairs: false },
    scrollbar: {
      useShadows: false,
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
    },
  });
  // Catches a font swap after Monaco measured.
  editor.remeasureFonts();
  if (!labelsRegistered) {
    labelsRegistered = true;
    // Peek titles add the folder after the file name ("~/playground"); it means nothing to a visitor.
    (await getService(ILabelService)).registerFormatter({
      scheme: 'file',
      home: '/playground',
      formatting: { label: '', separator: '/' },
    });
  }
  return ed;
}

/** A BPMNscript model for file `name` holding `text`; dispose `ref` to drop it. */
export async function openBpmnscriptModel(name: string, text: string) {
  const ref = await createModelReference(Uri.parse(modelUri(name)), text);
  ref.object.setLanguageId(LANGUAGE_ID);
  const model = ref.object.textEditorModel!;
  if (model.getValue() !== text) model.setValue(text);
  return { ref, model };
}

/** Every marker on `model` (language server diagnostics), 0-based like the compiler's. */
export function modelDiagnostics(model: editor.ITextModel): ConvDiagnostic[] {
  return editor.getModelMarkers({ resource: model.uri }).map((m) => ({
    line: m.startLineNumber - 1,
    character: m.startColumn - 1,
    endLine: m.endLineNumber - 1,
    endCharacter: m.endColumn - 1,
    message: m.message,
    severity: m.severity === MarkerSeverity.Error ? 1 : 2,
    text: model.getValueInRange(m),
  }));
}
