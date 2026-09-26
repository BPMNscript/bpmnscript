// The begin/end patterns run through JS RegExp instead of a TextMate engine,
// which holds only while they stick to constructs JS and Oniguruma agree on
// (literal backticks, alternation, \s, $, character classes).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRIPT_FORMAT_ALIASES } from '@bpmn-script/language';

const EMBEDDED_SCOPE_BY_FORMAT: Readonly<Record<string, string>> = {
  javascript: 'source.js',
  python: 'source.python',
  ruby: 'source.ruby',
  groovy: 'source.groovy',
};

// VS Code ships no grammar for these.
const NO_INSTALLED_GRAMMAR = new Set(['feel', 'juel']);

const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const injection = JSON.parse(
  readFileSync(
    path.join(
      EXTENSION_DIR,
      'injection',
      'bpmn-script.injection.tmLanguage.json',
    ),
    'utf8',
  ),
);

const pkg = JSON.parse(
  readFileSync(path.join(EXTENSION_DIR, 'package.json'), 'utf8'),
);

function orderedBlocks(): Array<{ name: string; rule: any }> {
  return injection.patterns.map((p: { include: string }) => {
    const name = p.include.replace(/^#/, '');
    return { name, rule: injection.repository[name] };
  });
}

// Models TextMate first-match-wins over the ordered pattern list.
function matchFence(line: string): { name: string; rule: any } | undefined {
  return orderedBlocks().find(({ rule }) => new RegExp(rule.begin).test(line));
}

describe('fenced-script injection grammar', () => {
  it('is registered against source.bpmn-script at a path build:prepare copies it to', () => {
    expect(injection.injectionSelector).toContain('source.bpmn-script');

    const entry = pkg.contributes.grammars.find(
      (g: { scopeName: string }) => g.scopeName === injection.scopeName,
    );
    expect(entry).toBeDefined();
    expect(entry.injectTo).toEqual(['source.bpmn-script']);
    expect(pkg.scripts['build:prepare']).toContain(
      `cp -f ./injection/bpmn-script.injection.tmLanguage.json ./${entry.path}`,
    );
    expect(() =>
      readFileSync(path.join(EXTENSION_DIR, entry.path)),
    ).not.toThrow();
  });

  // Driven off the alias table, so a new alias fails here until it is either
  // routed by the grammar or declared as having no installed grammar.
  it('every alias tag routes to its embedded scope or is a declared miss, and unknown tags fall back to a plain block', () => {
    for (const tag of [
      ...Object.keys(SCRIPT_FORMAT_ALIASES),
      'kotlin',
      'sql',
    ]) {
      const match = matchFence('script demo ```' + tag);
      expect(match, tag).toBeDefined();
      const format = SCRIPT_FORMAT_ALIASES[tag];
      if (format === undefined || NO_INSTALLED_GRAMMAR.has(tag)) {
        expect(
          [match!.name, match!.rule.contentName, match!.rule.patterns],
          tag,
        ).toEqual(['plain-block', undefined, undefined]);
        continue;
      }
      const embedded = EMBEDDED_SCOPE_BY_FORMAT[format];
      expect(
        embedded,
        `tag '${tag}' normalizes to '${format}': give it an injection block and an EMBEDDED_SCOPE_BY_FORMAT entry, or add the tag to NO_INSTALLED_GRAMMAR`,
      ).toBeDefined();
      expect(match!.rule.contentName, tag).toBe(
        `meta.embedded.block.${format}`,
      );
      expect(match!.rule.patterns, tag).toContainEqual({ include: embedded });
    }
  });

  it('a bare closing fence starts no block and matches an end pattern', () => {
    expect(matchFence('```')).toBeUndefined();
    for (const { rule } of orderedBlocks()) {
      expect(new RegExp(rule.end).test('```')).toBe(true);
    }
  });
});
