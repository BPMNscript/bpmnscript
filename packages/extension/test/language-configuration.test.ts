import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_TERMINAL } from '@bpmn-script/language';

const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// JSONC: whole comment lines are stripped, not a trailing `//`, which would
// eat the "lineComment": "//" value.
function readWordPattern(): unknown {
  const raw = readFileSync(
    path.join(EXTENSION_DIR, 'language-configuration.json'),
    'utf8',
  );
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')).wordPattern;
}

describe('language configuration', () => {
  it("the editor's word pattern is the grammar's ID terminal", () => {
    expect(readWordPattern()).toBe(ID_TERMINAL.source);
  });
});
