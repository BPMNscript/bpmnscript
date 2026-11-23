import type { languages } from '@codingame/monaco-vscode-editor-api';

export const LANGUAGE_ID = 'bpmn-script';

/**
 * The editor model's URI for a file. Monaco titles peek views with its basename, so that is the
 * visible name; `createBpmnscriptEditor` hides the folder.
 */
export const modelUri = (name: string) =>
  `file:///playground/${encodeURIComponent(name)}`;

// Arrays, not tuples: an imported JSON file types its pairs as string[].
type Pair = string[] | { open: string; close: string; notIn?: string[] };

/** `language-configuration.json` as the web build writes it (VS Code's format). */
export type LanguageConfigurationJson = {
  comments: { lineComment: string; blockComment: string[] };
  brackets: string[][];
  autoClosingPairs: Pair[];
  surroundingPairs: Pair[];
  /** A regex source string. */
  wordPattern: string;
};

const pair = (p: Pair) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p);

/** VS Code's language configuration in the shape Monaco's `setLanguageConfiguration` takes. */
export function toLanguageConfiguration(
  c: LanguageConfigurationJson,
): languages.LanguageConfiguration {
  return {
    comments: {
      lineComment: c.comments.lineComment,
      blockComment: c.comments.blockComment as [string, string],
    },
    brackets: c.brackets as [string, string][],
    autoClosingPairs: c.autoClosingPairs.map(pair),
    surroundingPairs: c.surroundingPairs.map(pair),
    wordPattern: new RegExp(c.wordPattern),
  };
}

/** Compile now, as a key label ("Mod" is Ctrl, or Cmd on a Mac). */
export const COMPILE_SHORTCUT = 'Mod+Enter';

/** True for Ctrl+Enter or Cmd+Enter with no other modifier. */
export const isCompileShortcut = (
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
) =>
  (e.ctrlKey || e.metaKey) &&
  !e.altKey &&
  !e.shiftKey &&
  e.key.toLowerCase() === 'enter';
