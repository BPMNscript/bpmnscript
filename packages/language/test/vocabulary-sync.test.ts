// The TextMate grammar cannot import TypeScript, and its generated copy under
// the gitignored `syntaxes/` never shows in a diff, so these pin the two lists.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import {
  CATCH_TRIGGERS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  EXECUTION_LISTENER_EVENTS,
  FLAG_WORD_RULE,
  ON_TRIGGERS,
  SETTING_KEY_RULE,
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

/** The `keyword.control` alternation as `textmate-postprocess.mjs` leaves it, hyphen-aware so `invoice-start` colours no `start`. */
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

  test('the completion provider names datatype rules the grammar has', () => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    const rules = new Set(
      services.BpmnScript.Grammar.rules.map((rule) => rule.name),
    );
    expect(
      [SETTING_KEY_RULE, FLAG_WORD_RULE].filter((name) => !rules.has(name)),
    ).toEqual([]);
  });
});

function grammarPatterns(): { name?: string; match?: string }[] {
  const raw = readFileSync(TEXTMATE_GRAMMAR, 'utf8');
  return (JSON.parse(raw) as { patterns: { name?: string; match?: string }[] })
    .patterns;
}

/** Oniguruma agrees with JS `RegExp` on the lookaround and classes used here. */
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

  test('the tag runs to the first whitespace', () => {
    expect([
      splitFencedScript('```groovy 1 + 1```'),
      splitFencedScript('```http://www.java.com/java\nx```'),
    ]).toEqual([
      { tag: 'groovy', code: ' 1 + 1' },
      { tag: 'http://www.java.com/java', code: 'x' },
    ]);
  });
});
