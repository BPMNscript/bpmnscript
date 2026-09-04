/**
 * Completion for the BPMNscript language server, driven through the real
 * `CompletionProvider` on the shared services so the DI wiring is exercised too.
 *
 * The default Langium completion inserts bare keywords, leaving the caret at
 * `process|`, a position the grammar continues with an id then `{`, where
 * nothing is suggestible. The custom provider emits LSP snippet items for the
 * structural keywords instead, so accepting one scaffolds the whole construct
 * and drops the caret inside the body. Non-structural keywords still fall
 * through to plain keyword completion.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, URI } from 'langium';
import {
  type CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from 'vscode-languageserver-types';
import {
  ATTRIBUTE_BLOCK_RULES,
  type BpmnScriptServices,
  createBpmnScriptServices,
} from '@bpmn-script/language';
import { BLOCK_HOSTS, caretInBlock } from './helpers/block-hosts.js';

/** Every trigger word an `on` handler accepts, save the payload-less one. */
const TRIGGERS = [
  'error',
  'escalation',
  'message',
  'signal',
  'timer',
  'condition',
];

let services: BpmnScriptServices;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem).BpmnScript;
});

async function completionItems(
  text: string,
  line: number,
  character: number,
): Promise<CompletionItem[]> {
  const factory = services.shared.workspace.LangiumDocumentFactory;
  const documents = services.shared.workspace.LangiumDocuments;
  const uri = URI.parse('file:///completion.bpmnscript');
  if (documents.hasDocument(uri)) {
    documents.deleteDocument(uri);
  }
  const document = factory.fromString(text, uri);
  documents.addDocument(document);
  await services.shared.workspace.DocumentBuilder.build([document]);
  const result = await services.lsp.CompletionProvider!.getCompletion(
    document,
    {
      textDocument: { uri: uri.toString() },
      position: { line, character },
    },
  );
  return result?.items ?? [];
}

/** The completion item labeled `label` at the given caret position. */
async function itemAt(
  text: string,
  line: number,
  character: number,
  label: string,
) {
  return (await completionItems(text, line, character)).find(
    (i) => i.label === label,
  );
}

async function labelsAt(
  text: string,
  line: number,
  character: number,
): Promise<string[]> {
  return (await completionItems(text, line, character)).map((i) => i.label);
}

/** The text an LSP client would actually insert (textEdit wins over insertText). */
function inserted(item: CompletionItem): string | undefined {
  if (item.textEdit && 'newText' in item.textEdit) {
    return item.textEdit.newText;
  }
  return item.insertText;
}

/**
 * The text an editor leaves behind when a snippet is accepted and every tab
 * stop is tabbed past: choices collapse to their first option, defaults to
 * their default, bare stops to nothing.
 */
function accepted(item: CompletionItem): string {
  return inserted(item)!
    .replace(/\$\{\d+\|([^,|]*)[^|]*\|\}/g, '$1')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\d+/g, '');
}

let parseCounter = 0;

/**
 * The lexer and parser errors `text` produces, so a scaffold can be checked as
 * accepted. Both arrays matter: an unlexable character never reaches the parser,
 * so parser errors alone would report a rejected input as clean.
 */
async function parseErrors(text: string): Promise<string[]> {
  const uri = URI.parse(`file:///parse-${parseCounter++}.bpmnscript`);
  const document = services.shared.workspace.LangiumDocumentFactory.fromString(
    text,
    uri,
  );
  services.shared.workspace.LangiumDocuments.addDocument(document);
  await services.shared.workspace.DocumentBuilder.build([document]);
  const { lexerErrors, parserErrors } = document.parseResult;
  return [...lexerErrors, ...parserErrors].map((e) => e.message);
}

describe('the parse helper', () => {
  test('reports a lexer error, not only a parser one', async () => {
    expect(await parseErrors('process p {\n  @@@\n}')).not.toEqual([]);
  });
});

describe('structural keyword snippets', () => {
  test('`process` is offered as a snippet that scaffolds a brace body', async () => {
    const process = await itemAt('pro', 0, 3, 'process');
    expect(process).toBeDefined();
    expect(process!.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(process!)!;
    expect(text).toContain('{');
    expect(text).toContain('}');
    expect(text).toContain('${1:name}');
  });

  test.each([
    ['if', ['(', '{']],
    ['service', ['class =']],
    ['script', ['```', '${2|javascript,groovy,python,ruby,feel|}']],
    ['subprocess', ['${1:id}', '{', '}']],
    ['attempt', ['${1:id}', '{', '}']],
    ['step', ['${1:id}']],
    ['send', ['${1:id}', 'class =']],
    ['receive', ['${1:id}', 'message =']],
    ['decide', ['${1:id}', 'decision =']],
  ])(
    '`%s` scaffolds its whole construct as one snippet',
    async (keyword, parts) => {
      const item = await itemAt('process p {\n  \n}', 1, 2, keyword);
      expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
      for (const part of parts) expect(inserted(item!)).toContain(part);
    },
  );

  test('`parallel` scaffolds two branch blocks', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'parallel');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toMatch(
      /\{[\s\S]*\{[\s\S]*\}[\s\S]*\{[\s\S]*\}[\s\S]*\}/,
    );
  });

  // The `\$` escape must survive into the inserted text, or an EL default such
  // as `${beanName}` reads as an empty snippet placeholder instead of literal EL.
  test.each([
    ['service s', 'topic', ['topic =']],
    ['service s', 'delegate', ['delegate =', '${beanName}']],
    ['service s', 'expression', ['expression =', '${bean.method(execution)}']],
    ['call C', 'binding', ['binding =', '${1|latest,deployment|}']],
    [
      'call C',
      'businessKey',
      ['businessKey =', '${execution.processBusinessKey}'],
    ],
    ['receive R', 'message', ['message =']],
    ['decide D', 'decision', ['decision =']],
    [
      'decide D',
      'mapDecisionResult',
      ['mapDecisionResult =', '${1|singleEntry,singleResult'],
    ],
  ])('a `%s` block offers `%s` as a snippet', async (head, label, parts) => {
    const item = (
      await completionItems(`process p {\n  ${head} {\n    \n  }\n}`, 2, 4)
    ).find((i) => i.label === label);
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    for (const part of parts) expect(inserted(item!)).toContain(part);
  });

  test('the full body keyword set is still offered', async () => {
    const labels = await labelsAt('process p {\n  \n}', 1, 2);
    expect(labels).toEqual(
      expect.arrayContaining([
        'start',
        'end',
        'user',
        'service',
        'step',
        'send',
        'receive',
        'decide',
        'if',
        'while',
        'do',
        'parallel',
        'subprocess',
        'attempt',
        'goto',
      ]),
    );
  });

  test('`call` is offered as a snippet that scaffolds `process`/`in`/`out`', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'call');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('process =');
    expect(text).toContain('in ');
    expect(text).toContain('out ');
    // The detail reads as the function-call analogy, not BPMN vocabulary.
    expect(item!.detail).toMatch(/function/i);
  });

  test('the caret after a statement name offers both repeat-clause forms', async () => {
    const text = 'process p {\n  user U \n}';
    const caret = [1, 9] as const;
    expect(await labelsAt(text, ...caret)).toEqual(
      expect.arrayContaining(['for each', 'for']),
    );

    const collection = await itemAt(text, ...caret, 'for each');
    expect(collection?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(collection!)).toBe('for each ${1:item} in ${2:collection}');

    const count = await itemAt(text, ...caret, 'for');
    expect(count?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(count!)).toBe('for ${1:3}');

    for (const item of [collection!, count!]) {
      expect(
        await parseErrors(`process p {\n  user U ${accepted(item)}\n}`),
      ).toEqual([]);
    }
  });

  // The caption is keyed on the keyword, so every form a keyword opens gets it.
  test('both repeat-clause forms carry the caption written for the keyword', async () => {
    const text = 'process p {\n  user U \n}';
    for (const label of ['for each', 'for']) {
      const item = await itemAt(text, 1, 9, label);
      expect(item?.detail).toBe('how often the preceding step runs');
    }
  });
});

describe('event-layer structure snippets', () => {
  test.each([
    ['on', ['${1|error,escalation,message,signal|}', '{', '}']],
    ['throw', ['${1|error,escalation,message,signal|}']],
    ['emit', ['${1|escalation,message,signal|}']],
  ])(
    '`%s` scaffolds its trigger choice as one snippet',
    async (keyword, parts) => {
      const item = await itemAt('process p {\n  \n}', 1, 2, keyword);
      expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
      for (const part of parts) expect(inserted(item!)).toContain(part);
    },
  );

  test('`on` after a preceding statement still scaffolds the handler, and it parses when accepted', async () => {
    const item = await itemAt(
      'process p {\n  emit signal "S"\n  \n}',
      2,
      2,
      'on',
    );
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('${1|error,escalation,message,signal|}');
    const body = accepted(item!).replace(/\n/g, '\n  ');
    expect(
      await parseErrors(`process p {\n  emit signal "S"\n  ${body}\n}`),
    ).toEqual([]);
  });
});

describe('event-layer ID-position completion (soft trigger/field words)', () => {
  test.each([
    ['  on ', TRIGGERS, []],
    ['  throw ', ['error', 'escalation', 'message', 'signal'], []],
    ['  emit ', ['escalation', 'message', 'signal'], ['error']],
    ['  on error "X" (', ['code', 'message'], []],
    ['  on timer ', ['after', 'at', 'every'], []],
  ])(
    '`%s` offers exactly the words legal there',
    async (line, offered, withheld) => {
      const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
      expect(labels).toEqual(expect.arrayContaining(offered));
      for (const word of withheld) expect(labels).not.toContain(word);
    },
  );

  test.each([
    ['timer', 'after "${1:PT1H}"'],
    ['condition', 'condition ($1)'],
  ])(
    'accepting `%s` at the `on` trigger position inserts its scaffold',
    async (label, scaffold) => {
      const line = '  on ';
      const item = (
        await completionItems(`process p {\n${line}\n}`, 1, line.length)
      ).find((i) => i.label === label);
      expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
      expect(inserted(item!)).toContain(scaffold);
    },
  );

  test.each([
    ['  on ', 'undo block of this subprocess'],
    ['  throw ', 'then end this path'],
    ['  emit ', 'then continue'],
  ])(
    '`compensation` is offered after `%s`, detailed for that verb',
    async (line, detail) => {
      const item = await itemAt(
        `process p {\n${line}\n}`,
        1,
        line.length,
        'compensation',
      );
      expect(item?.kind).toBe(CompletionItemKind.Keyword);
      expect(item!.detail).toContain(detail);
    },
  );

  test('the `on` keyword snippet choice list offers the four coded triggers, not `compensation`', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'on');
    expect(inserted(item!)).toContain('${1|error,escalation,message,signal|}');
    expect(inserted(item!)).not.toContain('compensation');
  });
});

describe('event-layer ID-position completion (await trigger words)', () => {
  test.each([
    [
      '  await ',
      ['message', 'timer', 'signal', 'condition'],
      ['error', 'escalation', 'compensation'],
    ],
    ['  await timer ', ['after', 'at', 'every'], []],
  ])(
    '`%s` offers exactly the words legal there',
    async (line, offered, withheld) => {
      const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
      expect(labels).toEqual(expect.arrayContaining(offered));
      for (const word of withheld) expect(labels).not.toContain(word);
    },
  );
});

// The caret sits in a body that already holds statements around it, so the
// completion has to resolve the start/end node it follows rather than the
// enclosing process it would fall back to in an empty body.
describe('event-layer ID-position completion (start and end trigger words)', () => {
  const PROGRAM = 'process p {\n  start S \n  user A\n  end E \n}';
  const START_CARET = '  start S '.length;
  const END_CARET = '  end E '.length;

  test('the start trigger position offers the kinds a process can start on', async () => {
    const labels = await labelsAt(PROGRAM, 1, START_CARET);
    expect(labels).toEqual(
      expect.arrayContaining(['message', 'signal', 'timer']),
    );
    for (const word of [
      'error',
      'escalation',
      'compensation',
      'condition',
      'terminate',
      'cancel',
    ]) {
      expect(labels).not.toContain(word);
    }
  });

  test('the end trigger position offers the two words an end carries and no other', async () => {
    const labels = await labelsAt(PROGRAM, 3, END_CARET);
    expect(labels).toEqual(expect.arrayContaining(['terminate', 'cancel']));
    for (const word of [
      'error',
      'escalation',
      'message',
      'signal',
      'timer',
      'condition',
      'compensation',
    ]) {
      expect(labels).not.toContain(word);
    }
  });

  test('`terminate` is captioned with what it stops', async () => {
    const item = await itemAt(PROGRAM, 3, END_CARET, 'terminate');
    expect(item?.kind).toBe(CompletionItemKind.Keyword);
    expect(item!.detail).toBe('stop every running path in this scope');
  });

  test('`cancel` is captioned with the block it gives up', async () => {
    const item = await itemAt(PROGRAM, 3, END_CARET, 'cancel');
    expect(item?.kind).toBe(CompletionItemKind.Keyword);
    expect(item!.detail).toBe('give up the surrounding attempt block');
  });

  test('accepting `timer` at the start trigger position inserts its scaffold', async () => {
    const item = await itemAt(PROGRAM, 1, START_CARET, 'timer');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('after "${1:PT1H}"');
  });

  test('the particle position on a timer start offers the three particles', async () => {
    const line = '  start S timer ';
    const labels = await labelsAt(
      `process p {\n${line}\n  user A\n}`,
      1,
      line.length,
    );
    expect(labels).toEqual(expect.arrayContaining(['after', 'at', 'every']));
  });
});

describe('the host slot on a handler attached to an activity', () => {
  test("the host position offers the container's activity names and nothing from another scope", async () => {
    // `Decoy` (another process) and `Inner` (a nested subprocess body) are both
    // named statements the scope must keep out. A presence-only assertion would
    // pass even if every named step in the file leaked in.
    const text =
      'process p {\n  user Review\n  service Ship\n  subprocess Sub {\n    user Inner\n  }\n  on \n}\nprocess q { user Decoy }';
    // Line 6 is `  on `, right after the keyword: the host slot.
    const labels = await labelsAt(text, 6, '  on '.length);
    expect(labels).toEqual(expect.arrayContaining(['Review', 'Ship']));
    expect(labels).not.toContain('Decoy');
    expect(labels).not.toContain('Inner');
  });

  test('the position after the colon offers the seven trigger items, exactly as the host-less position does', async () => {
    const text = 'process p {\n  user Review\n  on Review: \n}';
    const line = '  on Review: ';
    const labels = await labelsAt(text, 2, line.length);
    expect(labels).toEqual(
      expect.arrayContaining([
        'error',
        'escalation',
        'message',
        'signal',
        'timer',
        'condition',
        'compensation',
      ]),
    );
  });

  test('accepting `timer` after the colon still inserts the particle scaffold', async () => {
    const text = 'process p {\n  user Review\n  on Review: \n}';
    const line = '  on Review: ';
    const item = await itemAt(text, 2, line.length, 'timer');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('after "${1:PT1H}"');
  });
});

describe('attribute-key completion is narrowed to the element kind', () => {
  /** The labels offered inside `<head> { │ }`. */
  async function keysInBlock(head: string): Promise<string[]> {
    const text = `process p {\n  ${head} {\n    \n  }\n}`;
    return labelsAt(text, 2, 4);
  }

  test('a user block offers the user-task keys and none of the service ones', async () => {
    const labels = await keysInBlock('user T');
    expect(labels).toEqual(
      expect.arrayContaining([
        'assignee',
        'formKey',
        'candidateGroups',
        'candidateUsers',
        'dueDate',
        'followUpDate',
        'priority',
      ]),
    );
    expect(labels).not.toContain('class');
    expect(labels).not.toContain('topic');
    expect(labels).not.toContain('businessKey');
  });

  test('a service block offers the binding keys and none of the user-task ones', async () => {
    const labels = await keysInBlock('service S');
    expect(labels).toEqual(
      expect.arrayContaining([
        'class',
        'expression',
        'delegate',
        'topic',
        'resultVariable',
      ]),
    );
    expect(labels).not.toContain('assignee');
    expect(labels).not.toContain('candidateGroups');
  });

  test('a call block offers the call keys, `process` among them, exactly once', async () => {
    const items = await completionItems(
      'process p {\n  call C {\n    \n  }\n}',
      2,
      4,
    );
    const labels = items.map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining(['process', 'binding', 'version', 'businessKey']),
    );
    const processItems = items.filter((i) => i.label === 'process');
    expect(processItems).toHaveLength(1);
    expect(inserted(processItems[0]!)).toContain('process =');
  });

  test.each(BLOCK_HOSTS)(
    'the engine settings are offered inside the block of %s',
    async (_kind, _description, program) => {
      const { text, line, character } = caretInBlock(
        program,
        'asyncBefore = true ',
      );
      expect(await labelsAt(text, line, character)).toEqual(
        expect.arrayContaining([
          'asyncBefore',
          'asyncAfter',
          'exclusive',
          'jobPriority',
          'retryCycle',
        ]),
      );
    },
  );

  test.each([
    ['user T', ATTRIBUTE_BLOCK_RULES.UserTask],
    ['decide D', ATTRIBUTE_BLOCK_RULES.BusinessRuleTask],
    ['receive R', ATTRIBUTE_BLOCK_RULES.ReceiveTask],
  ])(
    'a `%s` block offers exactly the attribute keys the validator accepts',
    async (head, rule) => {
      const items = await completionItems(
        `process p {\n  ${head} {\n    \n  }\n}`,
        2,
        4,
      );
      const offered = items
        .filter((i) => i.detail === 'BPMNscript setting')
        .map((i) => i.label);
      expect(new Set(offered)).toEqual(rule.keys);
    },
  );

  test('the process header offers `versionTag`', async () => {
    const labels = await labelsAt('process p {\n  \n}', 1, 2);
    expect(labels).toContain('versionTag');
  });
});

describe('settings completion at a caret after a preceding member', () => {
  /**
   * The labels offered on the blank line following `member` inside
   * `<head> { ... }`, which is where an author stands once the first entry of a
   * block is typed. At that caret the node under the cursor is the preceding
   * member, not the block's element, so every offer here depends on the element
   * being resolved through it.
   */
  async function labelsAfter(head: string, member: string): Promise<string[]> {
    const lines = member.split('\n');
    const body = lines.map((line) => `    ${line}`).join('\n');
    return labelsAt(
      `process p {\n  ${head} {\n${body}\n    \n  }\n}`,
      2 + lines.length,
      4,
    );
  }

  const USER_TASK_KEYS = [
    'assignee',
    'formKey',
    'candidateGroups',
    'candidateUsers',
    'dueDate',
    'followUpDate',
    'priority',
    'asyncBefore',
    'asyncAfter',
    'exclusive',
    'jobPriority',
    'retryCycle',
  ];

  test.each([
    ['an attribute', 'assignee = "demo"'],
    ['a form block', 'form {\n  amount: number\n}'],
    ['an io parameter', 'input x = 1'],
    ['a closed listener', 'on create {\n  class = "com.example.L"\n}'],
  ])(
    'a user block offers its whole member set after %s',
    async (_kind, member) => {
      const labels = await labelsAfter('user T', member);
      expect(labels).toEqual(
        expect.arrayContaining([
          ...USER_TASK_KEYS,
          'form',
          'input',
          'output',
          'on',
        ]),
      );
      // A closed listener block must not capture the caret that follows it,
      // and the `process` keyword `AttrKey` carries must not stand in for the
      // key set.
      expect(labels).not.toContain('class');
      expect(labels).not.toContain('process');
    },
  );

  test('a service block offers the binding keys after a preceding attribute', async () => {
    const labels = await labelsAfter('service S', 'class = "com.example.D"');
    expect(labels).toEqual(
      expect.arrayContaining([
        'class',
        'expression',
        'delegate',
        'topic',
        'resultVariable',
        'asyncBefore',
        'form',
        'input',
        'output',
        'on',
      ]),
    );
    expect(labels).not.toContain('assignee');
  });

  test('a call block offers the call keys after a preceding attribute, `process` among them as the key', async () => {
    const items = await completionItems(
      'process p {\n  call C {\n    binding = latest\n    \n  }\n}',
      3,
      4,
    );
    const labels = items.map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'process',
        'binding',
        'version',
        'businessKey',
        'asyncBefore',
        'input',
        'output',
        'in',
        'out',
        'on',
      ]),
    );
    expect(labels).not.toContain('assignee');
    const processItems = items.filter((i) => i.label === 'process');
    expect(processItems).toHaveLength(1);
    expect(inserted(processItems[0]!)).toContain('process =');
  });

  test('a listener binding block offers the binding keys, empty or after a preceding one', async () => {
    const afterOne = await labelsAt(
      'process p {\n  user T {\n    on create {\n      class = "com.example.L"\n      \n    }\n  }\n}',
      4,
      6,
    );
    expect(afterOne).toEqual(
      expect.arrayContaining(['class', 'expression', 'delegate']),
    );
    expect(afterOne).not.toContain('assignee');

    const empty = await labelsAt(
      'process p {\n  user T {\n    on create {\n      \n    }\n  }\n}',
      3,
      6,
    );
    expect(empty).toEqual(
      expect.arrayContaining(['class', 'expression', 'delegate']),
    );
  });

  test('the process header offers `versionTag` after a preceding declaration', async () => {
    const labels = await labelsAt('process p {\n  var x: string\n  \n}', 2, 2);
    expect(labels).toEqual(
      expect.arrayContaining(['versionTag', 'label', 'var', 'user', 'if']),
    );
    expect(labels).not.toContain('process');
  });

  test('a user block offers the task listener events after a preceding attribute', async () => {
    const line = '    on ';
    const labels = await labelsAt(
      `process p {\n  user T {\n    assignee = "demo"\n${line}\n  }\n}`,
      3,
      line.length,
    );
    expect(labels).toEqual(
      expect.arrayContaining(['start', 'end', 'create', 'timeout']),
    );
  });

  test('an unclosed block still offers the keys of the element it belongs to', async () => {
    expect(await labelsAt('process p {\n  user T {\n    ', 2, 4)).toEqual(
      expect.arrayContaining(['assignee', 'asyncBefore']),
    );
    expect(
      await labelsAt('process p {\n  user T {\n    on create {\n      ', 3, 6),
    ).toEqual(expect.arrayContaining(['class', 'expression', 'delegate']));
  });

  test('a map key inside a parameter value is left to the default completion', async () => {
    const labels = await labelsAt(
      'process p {\n  user T {\n    input x = {\n      \n    }\n  }\n}',
      3,
      6,
    );
    expect(labels).not.toContain('assignee');
    expect(labels).not.toContain('asyncBefore');
    expect(labels).not.toContain('versionTag');
  });
});

describe('parameter and listener completion inside a block', () => {
  test('`input` and `output` are offered where parameters are legal', async () => {
    const items = await completionItems(
      'process p {\n  service S {\n    \n  }\n}',
      2,
      4,
    );
    const labels = items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['input', 'output']));
    const input = items.find((i) => i.label === 'input');
    expect(input?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(input!)).toContain('input ');
  });

  test('a host-less `on` handler offers `input` and `output`', async () => {
    // The handler lowers to an event sub-process, which carries parameters;
    // the hosted form lowers to a boundary event, which does not.
    const labels = await labelsAt(
      'process p {\n  start S\n  on error {\n    asyncBefore = true\n    \n  } {\n    end Failed\n  }\n}',
      4,
      4,
    );
    expect(labels).toEqual(expect.arrayContaining(['input', 'output']));
  });

  test('a user block offers the task listener events as well as the execution ones', async () => {
    const line = '    on ';
    const labels = await labelsAt(
      `process p {\n  user T {\n${line}\n  }\n}`,
      2,
      line.length,
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        'start',
        'end',
        'create',
        'assign',
        'complete',
        'update',
        'delete',
        'timeout',
      ]),
    );
  });

  test('a service block offers only the execution listener events', async () => {
    const line = '    on ';
    const labels = await labelsAt(
      `process p {\n  service S {\n${line}\n  }\n}`,
      2,
      line.length,
    );
    expect(labels).toEqual(expect.arrayContaining(['start', 'end']));
    expect(labels).not.toContain('create');
    expect(labels).not.toContain('timeout');
  });

  test('`on` inside a user block scaffolds a listener binding, and it parses when accepted', async () => {
    const item = await itemAt(
      'process p {\n  user T {\n    \n  }\n}',
      2,
      4,
      'on',
    );
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('${1|start,end|}');
    expect(text).toContain('class =');
    const body = accepted(item!).replace(/\n/g, '\n    ');
    expect(
      await parseErrors(`process p {\n  user T {\n    ${body}\n  }\n}`),
    ).toEqual([]);
  });
});

describe('non-structural keywords fall through', () => {
  test('`VarType` literals stay plain keyword completions, not snippets', async () => {
    // After `var x:` the grammar expects a VarType; those keywords are not snippets.
    const string = await itemAt('process p {\n  var x: \n}', 1, 9, 'string');
    expect(string).toBeDefined();
    expect(string!.insertTextFormat).not.toBe(InsertTextFormat.Snippet);
  });
});
