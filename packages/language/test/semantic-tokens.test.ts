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
const PLAIN = 'plain';

/** The token type covering each `<|...|>` range; two tokens on one range read joined. */
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

type Row = readonly [title: string, body: string, expected: readonly string[]];

const SOFT_WORDS_AS_VAR_NAME = [
  'at',
  'priority',
  'message',
  'compensation',
  'after',
  'terminate',
];

const SOFT_WORDS_AS_OPERAND = ['priority', 'code', 'compensation', 'after'];

describe('Semantic tokens - soft event words', () => {
  test.each<Row>([
    [
      'trigger words highlight as keywords, distinct from the names they carry',
      `on <|error|>("X") { }
  throw <|escalation|>("C")
  on error("X", <|code|>: <|c|>) { }
  on <|condition|> (<|amount|> > 100) { }
  await <|timer|>("<|PT1H|>")
  await {
    <|message|>("M") { user A }
    <|timer|>("PT1H") { user B }
  }
  start <|S|> <|message|>("M")
  user A
  start S
  user A
  end E <|terminate|>
  start <|S|>
  end <|E|>`,
      [
        KEYWORD,
        KEYWORD,
        KEYWORD,
        PLAIN,
        KEYWORD,
        PLAIN,
        KEYWORD,
        PLAIN,
        KEYWORD,
        KEYWORD,
        PLAIN,
        KEYWORD,
        KEYWORD,
        PLAIN,
        PLAIN,
      ],
    ],
    [
      'soft keywords highlight correctly, distinct from the identifiers beside them',
      `<|error|> X(<|message|>: "m")
  <|escalation|> <|MANUAL_REVIEW|>
  emit <|compensation|> <|Undo|>
  user Review
  on <|Review|>: <|timer|>("PT2H") { }
  user T(<|assignee|>: "<|demo|>")
  service S { <|input|> <|amount|> = 1 }
  user T { on timeout <|after|> "<|PT1H|>" (class: "com.acme.L") }
  user T { on <|create|>(<|class|>: "com.acme.L") }
  error E
  service V(topic: "t") { <|error|> <|E|> <|when|> <|ready|> }
  user <|input|>
  start S { form { <|amount|>: <|number|> "Weight" } }`,
      [
        KEYWORD,
        KEYWORD,
        KEYWORD,
        PLAIN,
        KEYWORD,
        PLAIN,
        PLAIN,
        KEYWORD,
        KEYWORD,
        PLAIN,
        KEYWORD,
        PLAIN,
        KEYWORD,
        PLAIN,
        KEYWORD,
        KEYWORD,
        KEYWORD,
        PLAIN,
        KEYWORD,
        PLAIN,
        PLAIN,
        PLAIN,
        KEYWORD,
      ],
    ],
    [
      'a soft word as a variable name carries no token, declared or read',
      [
        ...SOFT_WORDS_AS_VAR_NAME.map((word) => `var <|${word}|>: string`),
        ...SOFT_WORDS_AS_OPERAND.filter(
          (word) => !SOFT_WORDS_AS_VAR_NAME.includes(word),
        ).map((word) => `var ${word}: string`),
        ...SOFT_WORDS_AS_OPERAND.map(
          (word, i) => `if (<|${word}|> == "x") { end Done${i} }`,
        ),
      ].join('\n  '),
      [...SOFT_WORDS_AS_VAR_NAME, ...SOFT_WORDS_AS_OPERAND].map(() => PLAIN),
    ],
  ])('%s', async (_title, body, expected) => {
    const result = await highlight(`process p {\n  ${body}\n}\n`);
    expect(markedTokenTypes(result)).toEqual(expected);
  });
});
