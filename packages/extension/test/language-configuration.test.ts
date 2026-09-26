// language-configuration.json is JSONC (line comments), which JSON.parse
// rejects. Stripping whole comment lines, not a trailing `//`, keeps the
// "lineComment": "//" string value intact.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmptyFileSystem, GrammarAST, GrammarUtils } from 'langium';
import { createBpmnScriptServices } from '@bpmn-script/language';

const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function readWordPattern(): unknown {
  const raw = readFileSync(
    path.join(EXTENSION_DIR, 'language-configuration.json'),
    'utf8',
  );
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')).wordPattern;
}

describe('language configuration', () => {
  it("the editor's word pattern is the grammar's ID terminal", () => {
    const { Grammar } = createBpmnScriptServices(EmptyFileSystem).BpmnScript;
    const idRule = Grammar.rules.find(
      (rule) => GrammarAST.isTerminalRule(rule) && rule.name === 'ID',
    ) as GrammarAST.TerminalRule | undefined;
    if (!idRule) {
      throw new Error("grammar has no 'ID' terminal rule");
    }

    expect(readWordPattern()).toBe(GrammarUtils.terminalRegex(idRule).source);
  });
});
