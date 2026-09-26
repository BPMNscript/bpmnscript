/**
 * Two lists that have to agree with a list they cannot import.
 *
 * A TextMate grammar cannot read TypeScript, so its keyword alternation is a
 * second derivation of the keywords the parser reserves. It is generated into
 * `syntaxes/`, which is gitignored, so a stale copy never shows up in a diff.
 *
 * A trigger word and a listener event both follow `on`, so one word appearing
 * in both vocabularies would give `on <word>` two meanings.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import {
  CATCH_TRIGGERS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  EXECUTION_LISTENER_EVENTS,
  ON_TRIGGERS,
  splitFencedScript,
  START_TRIGGERS,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
  createBpmnScriptServices,
  reservedWordsOf,
} from '@bpmn-script/language';

const TEXTMATE_GRAMMAR = fileURLToPath(
  new URL('../syntaxes/bpmn-script.tmLanguage.json', import.meta.url),
);

/**
 * `(?<![\w-])(a|b|c)(?![\w-])` from the generated `keyword.control` pattern,
 * patched by `textmate-postprocess.mjs` so a hyphenated name (`invoice-start`)
 * does not colour the part that collides with a keyword.
 */
const ALTERNATION = /^\(\?<!\[\\w-\]\)\((.*)\)\(\?!\[\\w-\]\)$/;

function textMateKeywords(): string[] {
  let raw;
  try {
    raw = readFileSync(TEXTMATE_GRAMMAR, 'utf8');
  } catch {
    throw new Error(
      `${TEXTMATE_GRAMMAR} is missing. It is generated and gitignored; run \`npm run langium:generate\`.`,
    );
  }
  const grammar = JSON.parse(raw) as {
    patterns: { name?: string; match?: string }[];
  };
  const keywordPattern = grammar.patterns.find((p) =>
    p.name?.startsWith('keyword.control'),
  );
  const match = keywordPattern?.match?.match(ALTERNATION);
  if (!match) {
    throw new Error(
      'No `keyword.control` alternation in the generated TextMate grammar.',
    );
  }
  return match[1]!.split('|').sort();
}

describe('lists that must not drift apart', () => {
  test('the editor highlights exactly the words the parser reserves', () => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    const reserved = [...reservedWordsOf(services.BpmnScript.Grammar)].sort();
    expect(textMateKeywords()).toEqual(reserved);
  });

  test('no word is both a trigger a handler catches and an event a listener fires on', () => {
    const triggers = new Set<string>([
      ...ON_TRIGGERS,
      ...THROW_TRIGGERS,
      ...EMIT_TRIGGERS,
      ...CATCH_TRIGGERS,
      ...START_TRIGGERS,
      ...END_TRIGGERS,
    ]);
    const listenerEvents = [
      ...EXECUTION_LISTENER_EVENTS,
      ...TASK_LISTENER_EVENTS,
    ];
    expect(listenerEvents.filter((event) => triggers.has(event))).toEqual([]);
  });
});

function grammarPatterns(): { name?: string; match?: string }[] {
  const raw = readFileSync(TEXTMATE_GRAMMAR, 'utf8');
  return (JSON.parse(raw) as { patterns: { name?: string; match?: string }[] })
    .patterns;
}

/** Every match of the named top-level pattern, tried as a JS `RegExp` (both
 * engines agree on lookaround and the classes used here, the same assumption
 * `injection-grammar.test.ts` makes for the extension's Oniguruma grammar). */
function tokensOf(line: string, namePrefix: string): string[] {
  const pattern = grammarPatterns().find((p) => p.name?.startsWith(namePrefix));
  if (!pattern?.match) {
    throw new Error(
      `No ${namePrefix} pattern in the generated TextMate grammar.`,
    );
  }
  return [...line.matchAll(new RegExp(pattern.match, 'g'))].map((m) => m[0]);
}

describe('the TextMate grammar scopes a line', () => {
  test.each<[string, string, string[], string[], string[]]>([
    [
      'a hyphenated process name colours only the keyword',
      'process invoice-start {',
      ['process'],
      [],
      [],
    ],
    [
      'a hyphenated step name colours only the keyword',
      '  step end-of-day',
      ['step'],
      [],
      [],
    ],
    [
      'a hyphenated setting value colours only the keyword',
      '  user for-review(assignee: x)',
      ['user'],
      [],
      [],
    ],
    [
      'numbers and operators get their own scope, a hyphenated digit gets none',
      '  if (amount == 100 && count-2 > 0.5) {',
      ['if'],
      ['100', '0.5'],
      ['==', '&&', '>'],
    ],
  ])('%s', (_title, line, keywords, numbers, operators) => {
    expect(tokensOf(line, 'keyword.control')).toEqual(keywords);
    expect(tokensOf(line, 'constant.numeric')).toEqual(numbers);
    expect(tokensOf(line, 'keyword.operator')).toEqual(operators);
  });
});

describe('splitFencedScript', () => {
  test('a CRLF-checked-out source normalizes the body to LF', () => {
    expect(
      splitFencedScript('```groovy\r\ndef a = 1\r\ndef b = 2\r\n```'),
    ).toEqual({ tag: 'groovy', code: 'def a = 1\ndef b = 2\n' });
  });

  test('a one-line fence with no newline after the tag still splits it from the body', () => {
    expect(splitFencedScript('```groovy1 + 1```')).toEqual({
      tag: 'groovy',
      code: '1 + 1',
    });
  });
});
