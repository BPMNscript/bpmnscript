import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  COMPILE_SHORTCUT,
  isCompileShortcut,
  modelUri,
  toLanguageConfiguration,
} from '../src/language';

// The source file is JSON with comments; the web build writes it without them.
const source = readFileSync(
  join(import.meta.dirname, '../../language/language-configuration.json'),
  'utf8',
);
const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));

describe('language registration', () => {
  test("the language configuration becomes Monaco's: pairs as objects, the word pattern as a RegExp", () => {
    const c = toLanguageConfiguration(config);
    expect(c.comments).toEqual({
      lineComment: '//',
      blockComment: ['/*', '*/'],
    });
    expect(c.brackets).toEqual([
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ]);
    expect(c.autoClosingPairs).toContainEqual({ open: '"', close: '"' });
    expect(c.surroundingPairs).toContainEqual({ open: '(', close: ')' });
    const word = c.wordPattern!;
    expect('order-handling'.match(word)?.[0]).toBe('order-handling');
    expect('`Task.1`'.match(word)?.[0]).toBe('`Task.1`');
  });

  test('pairs already given as objects are kept', () => {
    const c = toLanguageConfiguration({
      ...config,
      autoClosingPairs: [{ open: '{', close: '}', notIn: ['string'] }],
    });
    expect(c.autoClosingPairs).toEqual([
      { open: '{', close: '}', notIn: ['string'] },
    ]);
  });

  test("a file's model URI ends in its name, so peek and hover titles read as that name", () => {
    const uri = new URL(modelUri('invoice approval#2.bpmnscript'));
    expect(uri.protocol).toBe('file:');
    expect(decodeURIComponent(uri.pathname)).toBe(
      '/playground/invoice approval#2.bpmnscript',
    );
  });
});

describe('compile shortcut', () => {
  type Key = Parameters<typeof isCompileShortcut>[0];
  const key = (k: Partial<Key>): Key => ({
    key: 'Enter',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...k,
  });

  test('Ctrl+Enter and Cmd+Enter compile; Enter alone or with another modifier does not', () => {
    expect(COMPILE_SHORTCUT).toBe('Mod+Enter');
    expect(isCompileShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isCompileShortcut(key({ metaKey: true }))).toBe(true);
    expect(isCompileShortcut(key({}))).toBe(false);
    expect(isCompileShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isCompileShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCompileShortcut(key({ ctrlKey: true, key: 's' }))).toBe(false);
  });
});
