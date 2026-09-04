// These tests run the grammar's begin/end patterns through JS RegExp instead of
// a TextMate engine. That only holds because the patterns stick to constructs
// JS and Oniguruma agree on: literal backticks, alternation, \s, $, character
// classes. Add an Oniguruma-only construct and this file stops modeling VS Code.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRIPT_FORMAT_ALIASES } from '@bpmn-script/language';

// The TextMate scope each canonical script format embeds. A format missing here
// has no installed grammar, and every fence tag reaching it must say so below.
const EMBEDDED_SCOPE_BY_FORMAT: Readonly<Record<string, string>> = {
  javascript: 'source.js',
  python: 'source.python',
  ruby: 'source.ruby',
  groovy: 'source.groovy',
};

// Tags deliberately left unhighlighted: VS Code ships no grammar for them.
const NO_INSTALLED_GRAMMAR = new Set(['feel']);

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
  it('injects into source.bpmn-script and is registered with injectTo', () => {
    expect(injection.injectionSelector).toContain('source.bpmn-script');

    const entry = pkg.contributes.grammars.find(
      (g: { scopeName: string }) => g.scopeName === injection.scopeName,
    );
    expect(entry).toBeDefined();
    expect(entry.injectTo).toContain('source.bpmn-script');
    expect(entry.path).toBe('syntaxes/bpmn-script.injection.tmLanguage.json');
  });

  it('build:prepare copies the injection asset into the runtime syntaxes dir', () => {
    expect(pkg.scripts['build:prepare']).toContain(
      './injection/bpmn-script.injection.tmLanguage.json',
    );
    expect(pkg.scripts['build:prepare']).toContain(
      './syntaxes/bpmn-script.injection.tmLanguage.json',
    );
    expect(() =>
      readFileSync(
        path.join(
          EXTENSION_DIR,
          'syntaxes',
          'bpmn-script.injection.tmLanguage.json',
        ),
      ),
    ).not.toThrow();
  });

  // Driven off the alias table, so a new alias fails here until it is either
  // routed by the grammar or declared as having no installed grammar.
  it.each(Object.keys(SCRIPT_FORMAT_ALIASES))(
    'tag ```%s routes to its embedded scope, or is a declared miss',
    (tag) => {
      const match = matchFence('script demo ```' + tag);
      expect(match).toBeDefined();
      if (NO_INSTALLED_GRAMMAR.has(tag)) {
        expect(match!.name).toBe('plain-block');
        expect(match!.rule.contentName).toBeUndefined();
        expect(match!.rule.patterns).toBeUndefined();
        return;
      }
      const format = SCRIPT_FORMAT_ALIASES[tag];
      const embedded = EMBEDDED_SCOPE_BY_FORMAT[format];
      expect(
        embedded,
        `tag '${tag}' normalizes to '${format}': give it an injection block and an EMBEDDED_SCOPE_BY_FORMAT entry, or add the tag to NO_INSTALLED_GRAMMAR`,
      ).toBeDefined();
      expect(match!.rule.contentName).toBe(`meta.embedded.block.${format}`);
      expect(match!.rule.patterns).toContainEqual({ include: embedded });
    },
  );

  it.each([['kotlin'], ['sql']])(
    'unknown tag ```%s falls back to a plain block (no embedded include)',
    (tag) => {
      expect(SCRIPT_FORMAT_ALIASES[tag]).toBeUndefined();
      const match = matchFence('script demo ```' + tag);
      expect(match).toBeDefined();
      expect(match!.name).toBe('plain-block');
      expect(match!.rule.contentName).toBeUndefined();
      expect(match!.rule.patterns).toBeUndefined();
    },
  );

  it('a bare closing fence starts no block and matches an end pattern', () => {
    expect(matchFence('```')).toBeUndefined();
    for (const { rule } of orderedBlocks()) {
      expect(new RegExp(rule.end).test('```')).toBe(true);
    }
  });
});
