/**
 * Structural + regex-behaviour checks for the fenced-script injection grammar.
 *
 * The injection grammar makes a `script X ```lang … ``` ` fenced body colorize
 * with the embedded language's grammar, the way a markdown fenced code block
 * does. The load-bearing questions this file pins down without a full TextMate
 * engine:
 *   1. the grammar is registered so VS Code injects it into `source.bpmn-script`;
 *   2. each opening fence tag routes to the right embedded scope
 *      (`meta.embedded.block.<lang>` + `source.<lang>`);
 *   3. an unrecognised tag (and `feel`, which has no installed grammar) falls
 *      back to a plain block — no embedded include, never an error.
 *
 * The `begin`/`end` patterns use only regex constructs that behave identically
 * in JS `RegExp` and Oniguruma (literal backticks, alternation, `\s`, `$`,
 * character classes), so running them here faithfully models the tokenizer's
 * first-match-wins routing across the ordered pattern list.
 */

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

/** Resolve `{ include: '#name' }` entries in `patterns` to their rules, in order. */
function orderedBlocks(): Array<{ name: string; rule: any }> {
  return injection.patterns.map((p: { include: string }) => {
    const name = p.include.replace(/^#/, '');
    return { name, rule: injection.repository[name] };
  });
}

/** Model TextMate first-match-wins: the first block whose `begin` matches wins. */
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
    // build:prepare has run — the copy exists next to the base grammar.
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

  // Every accepted tag → its canonical embedded scope. `feel` and any tag
  // without an installed grammar are intentionally absent here (see fallback).
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
    // No opening block matches a tag-less fence…
    expect(matchFence('```')).toBeUndefined();
    // …but every block closes on it.
    for (const { rule } of orderedBlocks()) {
      expect(new RegExp(rule.end).test('```')).toBe(true);
    }
  });
});
