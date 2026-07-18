/**
 * Semantic-token test suite for the soft event words.
 *
 * `error`, `escalation`, `code`, and `message` lex as plain `ID` (the
 * grammar's soft-word convention — see `bpmn-script.langium`), so they get
 * no highlighting from the generated TextMate grammar, which only knows the
 * four real keywords (`on`, `throw`, `emit`, `alongside`). These tests drive
 * `BpmnScriptSemanticTokenProvider` through the real LSP semantic-tokens
 * request (`langium/test`'s `highlightHelper`) and assert it marks a soft
 * word with the `keyword` token type exactly where it carries event
 * meaning, and nowhere else — `var message: string` and a plain `code`
 * variable reference stay untouched.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import {
  expectSemanticToken,
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

/** Asserts that no token in `result` covers exactly the marked `<|…|>` range. */
function expectNoTokenAt(
  result: DecodedSemanticTokensWithRanges,
  rangeIndex = 0,
): void {
  const [start, end] = result.ranges[rangeIndex];
  const covering = result.tokens.filter(
    (t) => t.offset === start && t.offset + t.text.length === end,
  );
  expect(covering).toHaveLength(0);
}

describe('trigger words on OnHandler/ThrowStatement/EmitStatement', () => {
  test('`on error` highlights the trigger word as a keyword token', async () => {
    const result = await highlight(`
process p {
  on <|error|> "X" { }
}
`);
    expectSemanticToken(result, { tokenType: SemanticTokenTypes.keyword });
  });

  test('`throw escalation "C"` highlights the trigger word', async () => {
    const result = await highlight(`
process p {
  throw <|escalation|> "C"
}
`);
    expectSemanticToken(result, { tokenType: SemanticTokenTypes.keyword });
  });

  test('`emit escalation "C"` highlights the trigger word', async () => {
    const result = await highlight(`
process p {
  emit <|escalation|> "C"
}
`);
    expectSemanticToken(result, { tokenType: SemanticTokenTypes.keyword });
  });
});

describe('binding fields on EventBinding', () => {
  test('the field words in `(code c, message m)` highlight, the variable names do not', async () => {
    const result = await highlight(`
process p {
  on error "X" (<|code|> c, <|message|> m) { }
}
`);
    expectSemanticToken(result, {
      rangeIndex: 0,
      tokenType: SemanticTokenTypes.keyword,
    });
    expectSemanticToken(result, {
      rangeIndex: 1,
      tokenType: SemanticTokenTypes.keyword,
    });
    // The variable names sit right after each field word — mark them too and
    // assert they carry no token at all.
    const result2 = await highlight(`
process p {
  on error "X" (code <|c|>, message <|m|>) { }
}
`);
    expectNoTokenAt(result2, 0);
    expectNoTokenAt(result2, 1);
  });
});

describe('trigger word on the new on-handler kinds (timer/message)', () => {
  test('`on message "X"` highlights the trigger word', async () => {
    const result = await highlight(`
process p {
  on <|message|> "X" { }
}
`);
    expectSemanticToken(result, { tokenType: SemanticTokenTypes.keyword });
  });

  test('`on condition (…)` highlights the trigger word, not the condition variable', async () => {
    const result = await highlight(`
process p {
  on <|condition|> (<|amount|> > 100) { }
}
`);
    expectSemanticToken(result, {
      rangeIndex: 0,
      tokenType: SemanticTokenTypes.keyword,
    });
    expectNoTokenAt(result, 1);
  });
});

describe('timer particle on OnHandler', () => {
  test('`on timer after "PT1H"` highlights both the trigger word and the particle', async () => {
    const result = await highlight(`
process p {
  on <|timer|> <|after|> "PT1H" { }
}
`);
    expectSemanticToken(result, {
      rangeIndex: 0,
      tokenType: SemanticTokenTypes.keyword,
    });
    expectSemanticToken(result, {
      rangeIndex: 1,
      tokenType: SemanticTokenTypes.keyword,
    });
  });

  test('`var at: string` carries no token on `at`', async () => {
    const result = await highlight(`
process p {
  var <|at|>: string
}
`);
    expectNoTokenAt(result);
  });

  test('`if (after > 2)` carries no token on `after`', async () => {
    const result = await highlight(`
process p {
  var after: number
  if (<|after|> > 2) {
    end Done
  }
}
`);
    expectNoTokenAt(result);
  });
});

describe('kind/field on the ErrorDecl declaration', () => {
  test('`error "X" message "m"` highlights both words', async () => {
    const result = await highlight(`
process p {
  <|error|> "X" <|message|> "m"
}
`);
    expectSemanticToken(result, {
      rangeIndex: 0,
      tokenType: SemanticTokenTypes.keyword,
    });
    expectSemanticToken(result, {
      rangeIndex: 1,
      tokenType: SemanticTokenTypes.keyword,
    });
  });
});

describe('negative: the same words used as ordinary identifiers stay plain', () => {
  test('`var message: string` carries no token on `message`', async () => {
    const result = await highlight(`
process p {
  var <|message|>: string
}
`);
    expectNoTokenAt(result);
  });

  test('`if (code == "x")` carries no token on `code`', async () => {
    const result = await highlight(`
process p {
  var code: string
  if (<|code|> == "x") {
    end Done
  }
}
`);
    expectNoTokenAt(result);
  });
});
