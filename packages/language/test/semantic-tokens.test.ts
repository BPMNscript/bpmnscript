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

/** Asserts the marked `<|...|>` range at `rangeIndex` is a keyword token. */
function expectKeywordAt(
  result: DecodedSemanticTokensWithRanges,
  rangeIndex = 0,
): void {
  expectSemanticToken(result, {
    rangeIndex,
    tokenType: SemanticTokenTypes.keyword,
  });
}

/** Asserts that no token in `result` covers exactly the marked `<|...|>` range. */
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
    expectKeywordAt(result);
  });

  test('`throw escalation "C"` highlights the trigger word', async () => {
    const result = await highlight(`
process p {
  throw <|escalation|> "C"
}
`);
    expectKeywordAt(result);
  });

  test('`emit escalation "C"` highlights the trigger word', async () => {
    const result = await highlight(`
process p {
  emit <|escalation|> "C"
}
`);
    expectKeywordAt(result);
  });
});

describe('binding fields on EventBinding', () => {
  test('the field words in `(code c, message m)` highlight, the variable names do not', async () => {
    const result = await highlight(`
process p {
  on error "X" (<|code|> c, <|message|> m) { }
}
`);
    expectKeywordAt(result, 0);
    expectKeywordAt(result, 1);
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
    expectKeywordAt(result);
  });

  test('`on condition (…)` highlights the trigger word, not the condition variable', async () => {
    const result = await highlight(`
process p {
  on <|condition|> (<|amount|> > 100) { }
}
`);
    expectKeywordAt(result, 0);
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
    expectKeywordAt(result, 0);
    expectKeywordAt(result, 1);
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

describe('trigger word and timer particle on IntermediateCatchEvent', () => {
  test('`await timer after "PT1H"` highlights both the trigger word and the particle', async () => {
    const result = await highlight(`
process p {
  await <|timer|> <|after|> "PT1H"
}
`);
    expectKeywordAt(result, 0);
    expectKeywordAt(result, 1);
  });
});

describe('kind/field on the ErrorDecl declaration', () => {
  test('`error "X" message "m"` highlights both words', async () => {
    const result = await highlight(`
process p {
  <|error|> "X" <|message|> "m"
}
`);
    expectKeywordAt(result, 0);
    expectKeywordAt(result, 1);
  });
});

describe('trigger word on compensation (on/throw/emit)', () => {
  test('`on compensation { }` highlights the trigger word as a keyword token', async () => {
    const result = await highlight(`
process p {
  on <|compensation|> { }
}
`);
    expectKeywordAt(result);
  });

  test('`throw compensation` highlights the trigger word', async () => {
    const result = await highlight(`
process p {
  throw <|compensation|>
}
`);
    expectKeywordAt(result);
  });

  test('`emit compensation Undo` highlights the trigger word, not the name id', async () => {
    const result = await highlight(`
process p {
  emit <|compensation|> <|Undo|>
}
`);
    expectKeywordAt(result, 0);
    expectNoTokenAt(result, 1);
  });
});

describe('host slot on a handler attached to an activity', () => {
  test('`on Review: timer after "PT2H" { }` highlights the trigger and particle, not the host', async () => {
    const result = await highlight(`
process p {
  user Review
  on <|Review|>: <|timer|> <|after|> "PT2H" { }
}
`);
    expectNoTokenAt(result, 0);
    expectKeywordAt(result, 1);
    expectKeywordAt(result, 2);
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

  test('`var compensation: number` carries no token on `compensation`', async () => {
    const result = await highlight(`
process p {
  var <|compensation|>: number
}
`);
    expectNoTokenAt(result);
  });

  test('`if (compensation > 0)` carries no token on `compensation`', async () => {
    const result = await highlight(`
process p {
  var compensation: number
  if (<|compensation|> > 0) {
    end Done
  }
}
`);
    expectNoTokenAt(result);
  });
});
