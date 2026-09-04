/**
 * Semantic-token test suite for the soft event words.
 *
 * `error`, `escalation`, `code`, and `message` lex as plain `ID` under the
 * grammar's soft-word convention, so the generated TextMate grammar (which
 * knows only the real keywords `on`, `throw`, `emit`, `alongside`) gives them
 * no highlighting. These tests drive `BpmnScriptSemanticTokenProvider` through
 * the real LSP semantic-tokens request and assert it marks a soft word with the
 * `keyword` token type exactly where it carries event meaning: `var message:
 * string` and a plain `code` variable reference stay untouched.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import {
  highlightHelper,
  type DecodedSemanticTokensWithRanges,
} from 'langium/test';
import { SemanticTokenTypes } from 'vscode-languageserver-types';
import { type Model, createBpmnScriptServices } from '@bpmn-script/language';

let highlight: (text: string) => Promise<DecodedSemanticTokensWithRanges>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  highlight = highlightHelper<Model>(services.BpmnScript);
});

const KEYWORD = SemanticTokenTypes.keyword;
/** No token covers the marked range at all. */
const PLAIN = 'plain';

/**
 * The token type covering each `<|...|>` range, in source order, as one list:
 * a range nothing covers reads as `plain`, and a range two tokens claim reads
 * as both joined, so neither a missing nor a doubled token can pass as one.
 */
function markedTokenTypes(
  result: DecodedSemanticTokensWithRanges,
): readonly string[] {
  return result.ranges.map(([start, end]) => {
    const covering = result.tokens.filter(
      (t) => t.offset === start && t.offset + t.text.length === end,
    );
    return covering.length === 0
      ? PLAIN
      : covering.map((t) => t.tokenType).join('+');
  });
}

/** A row: a title, a process body, and the token type of every marked range. */
type Row = readonly [title: string, body: string, expected: readonly string[]];

/** Soft words whose meaning is positional: as a variable name they are plain. */
const SOFT_WORDS_AS_VAR_NAME = [
  'at',
  'priority',
  'message',
  'compensation',
  'after',
];

/** The same, read in an expression rather than declared. */
const SOFT_WORDS_AS_OPERAND = ['priority', 'code', 'compensation'];

describe('Semantic tokens - soft event words', () => {
  test.each<Row>([
    [
      'the trigger word of an `on` handler is a keyword',
      'on <|error|> "X" { }',
      [KEYWORD],
    ],
    [
      'the trigger word of a `throw` is a keyword',
      'throw <|escalation|> "C"',
      [KEYWORD],
    ],
    [
      'the trigger word of an `emit` is a keyword',
      'emit <|escalation|> "C"',
      [KEYWORD],
    ],
    [
      'the field words of an error binding are keywords',
      'on error "X" (<|code|> c, <|message|> m) { }',
      [KEYWORD, KEYWORD],
    ],
    [
      'the variables an error binding introduces are not',
      'on error "X" (code <|c|>, message <|m|>) { }',
      [PLAIN, PLAIN],
    ],
    [
      'a message handler highlights its trigger word',
      'on <|message|> "X" { }',
      [KEYWORD],
    ],
    [
      'a condition handler highlights its trigger word, not the variable it tests',
      'on <|condition|> (<|amount|> > 100) { }',
      [KEYWORD, PLAIN],
    ],
    [
      'a timer handler highlights both the trigger word and the particle',
      'on <|timer|> <|after|> "PT1H" { }',
      [KEYWORD, KEYWORD],
    ],
    [
      'a timer particle in an expression is a plain operand',
      'var after: number\n  if (<|after|> > 2) {\n    end Done\n  }',
      [PLAIN],
    ],
    [
      'an awaited timer highlights both the trigger word and the particle',
      'await <|timer|> <|after|> "PT1H"',
      [KEYWORD, KEYWORD],
    ],
    [
      'every branch header of a race highlights its trigger word and particle',
      `await {
    <|message|> "M" { user A }
    <|timer|> <|after|> "PT1H" { user B }
  }`,
      [KEYWORD, KEYWORD, KEYWORD],
    ],
    [
      'a start event highlights its trigger word, not its name',
      'start <|S|> <|message|> "M"\n  user A',
      [PLAIN, KEYWORD],
    ],
    [
      'a timer start highlights both the trigger word and the particle',
      'start S <|timer|> <|after|> "PT1H"\n  user A',
      [KEYWORD, KEYWORD],
    ],
    [
      'a terminating end highlights its trigger word',
      'start S\n  user A\n  end E <|terminate|>',
      [KEYWORD],
    ],
    [
      'a start and an end with no trigger carry nothing on their names',
      'start <|S|>\n  end <|E|>',
      [PLAIN, PLAIN],
    ],
    [
      'a variable named after a trigger word stays plain where the word is also used as one',
      'var <|terminate|>: string\n  end Done terminate',
      [PLAIN],
    ],
    [
      'an error declaration highlights both its kind and its field word',
      '<|error|> "X" <|message|> "m"',
      [KEYWORD, KEYWORD],
    ],
    [
      'a compensation handler highlights its trigger word',
      'on <|compensation|> { }',
      [KEYWORD],
    ],
    [
      'a compensation throw highlights its trigger word',
      'throw <|compensation|>',
      [KEYWORD],
    ],
    [
      'a compensation emit highlights its trigger word, not the activity it names',
      'emit <|compensation|> <|Undo|>',
      [KEYWORD, PLAIN],
    ],
    [
      'a handler attached to an activity highlights the trigger and particle, not the host',
      'user Review\n  on <|Review|>: <|timer|> <|after|> "PT2H" { }',
      [PLAIN, KEYWORD, KEYWORD],
    ],
    [
      'an attribute key is a keyword, its value is not',
      'user T { <|assignee|> = "<|demo|>" }',
      [KEYWORD, PLAIN],
    ],
    [
      'a parameter direction is a keyword, the parameter name is not',
      'service S { <|input|> <|amount|> = 1 }',
      [KEYWORD, PLAIN],
    ],
    [
      'a timeout particle is a keyword, the duration it takes is not',
      'user T { on timeout <|after|> "<|PT1H|>" { class = "com.acme.L" } }',
      [KEYWORD, PLAIN],
    ],
    [
      'a process-header setting highlights its key',
      '<|versionTag|> = "1.4"',
      [KEYWORD],
    ],
    [
      'a listener event and its binding key are both keywords',
      'user T { on <|create|> { <|class|> = "com.acme.L" } }',
      [KEYWORD, KEYWORD],
    ],
    ['a step named after a soft word stays plain', 'user <|input|>', [PLAIN]],
    ...SOFT_WORDS_AS_VAR_NAME.map((word): Row => [
      `\`var ${word}\` carries no token on the name`,
      `var <|${word}|>: string`,
      [PLAIN],
    ]),
    ...SOFT_WORDS_AS_OPERAND.map((word): Row => [
      `\`if (${word} ...)\` carries no token on the operand`,
      `var ${word}: string\n  if (<|${word}|> == "x") {\n    end Done\n  }`,
      [PLAIN],
    ]),
  ])('%s', async (_title, body, expected) => {
    const result = await highlight(`process p {\n  ${body}\n}\n`);
    expect(markedTokenTypes(result)).toEqual(expected);
  });
});
