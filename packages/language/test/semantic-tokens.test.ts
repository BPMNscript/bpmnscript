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
  test.each([
    'on <|error|> "X" { }',
    'throw <|escalation|> "C"',
    'emit <|escalation|> "C"',
  ])(
    '`%s` highlights the trigger word as a keyword token',
    async (statement) => {
      expectKeywordAt(await highlight(`process p {\n  ${statement}\n}\n`));
    },
  );
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

  test('`on condition (...)` highlights the trigger word, not the condition variable', async () => {
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

describe('trigger word and particle on a start and end event', () => {
  test('`start S message "M"` highlights the trigger word, not the start name', async () => {
    const result = await highlight(`
process p {
  start <|S|> <|message|> "M"
  user A
}
`);
    expectNoTokenAt(result, 0);
    expectKeywordAt(result, 1);
  });

  test('`start S timer after "PT1H"` highlights both the trigger word and the particle', async () => {
    const result = await highlight(`
process p {
  start S <|timer|> <|after|> "PT1H"
  user A
}
`);
    expectKeywordAt(result, 0);
    expectKeywordAt(result, 1);
  });

  test('`end E terminate` highlights the trigger word', async () => {
    const result = await highlight(`
process p {
  start S
  user A
  end E <|terminate|>
}
`);
    expectKeywordAt(result);
  });

  test('a plain `start`/`end` with no trigger carries no token on its name', async () => {
    const result = await highlight(`
process p {
  start <|S|>
  end <|E|>
}
`);
    expectNoTokenAt(result, 0);
    expectNoTokenAt(result, 1);
  });

  test('`var terminate: string` carries no token on the name', async () => {
    const result = await highlight(`
process p {
  var <|terminate|>: string
  end Done terminate
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
    expectKeywordAt(result, 0);
    expectKeywordAt(result, 1);
  });
});

describe('trigger word on compensation (on/throw/emit)', () => {
  test.each(['on <|compensation|> { }', 'throw <|compensation|>'])(
    '`%s` highlights the trigger word as a keyword token',
    async (statement) => {
      expectKeywordAt(await highlight(`process p {\n  ${statement}\n}\n`));
    },
  );

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

describe('attribute keys, parameter directions, and listener events', () => {
  test.each([
    'user T { <|assignee|> = "<|demo|>" }',
    'service S { <|input|> <|amount|> = 1 }',
    'user T { on timeout <|after|> "<|PT1H|>" { class = "com.acme.L" } }',
  ])(
    '`%s` highlights the key word, not the word beside it',
    async (statement) => {
      const result = await highlight(`process p {\n  ${statement}\n}\n`);
      expectKeywordAt(result, 0);
      expectNoTokenAt(result, 1);
    },
  );

  test('a process-header setting highlights its key', async () => {
    const result = await highlight(`
process p {
  <|versionTag|> = "1.4"
}
`);
    expectKeywordAt(result);
  });

  test('a listener event and its binding key both highlight', async () => {
    const result = await highlight(`
process p {
  user T { on <|create|> { <|class|> = "com.acme.L" } }
}
`);
    expectKeywordAt(result, 0);
    expectKeywordAt(result, 1);
  });
});

describe('negative: the same words used as ordinary identifiers stay plain', () => {
  test.each(['priority', 'message', 'compensation', 'after'])(
    '`var %s` carries no token on the name',
    async (word) => {
      expectNoTokenAt(
        await highlight(`
process p {
  var <|${word}|>: string
}
`),
      );
    },
  );

  test.each(['priority', 'code', 'compensation'])(
    '`if (%s ...)` carries no token on the operand',
    async (word) => {
      expectNoTokenAt(
        await highlight(`
process p {
  var ${word}: string
  if (<|${word}|> == "x") {
    end Done
  }
}
`),
      );
    },
  );

  test('`user input` carries no token on the step name', async () => {
    const result = await highlight(`
process p {
  user <|input|>
}
`);
    expectNoTokenAt(result);
  });
});
