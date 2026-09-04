// These tests run the grammar's begin/end patterns through JS RegExp instead of
// a TextMate engine. That only holds because the patterns stick to constructs
// JS and Oniguruma agree on: literal backticks, alternation, \s, $, character
// classes. Add an Oniguruma-only construct and this file stops modeling VS Code.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // `feel` and any other tag with no installed grammar belong in the fallback
  // table below, not here.
  it.each([
    ['js', 'meta.embedded.block.javascript', 'source.js'],
    ['javascript', 'meta.embedded.block.javascript', 'source.js'],
    ['py', 'meta.embedded.block.python', 'source.python'],
    ['python', 'meta.embedded.block.python', 'source.python'],
    ['rb', 'meta.embedded.block.ruby', 'source.ruby'],
    ['ruby', 'meta.embedded.block.ruby', 'source.ruby'],
    ['groovy', 'meta.embedded.block.groovy', 'source.groovy'],
  ])('tag ```%s routes to the embedded scope', (tag, contentName, embedded) => {
    const match = matchFence('script demo ```' + tag);
    expect(match).toBeDefined();
    expect(match!.rule.contentName).toBe(contentName);
    expect(match!.rule.patterns).toContainEqual({ include: embedded });
  });

  it.each([['feel'], ['kotlin'], ['sql']])(
    'unknown/feel tag ```%s falls back to a plain block (no embedded include)',
    (tag) => {
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
