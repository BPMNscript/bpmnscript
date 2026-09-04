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

async function labelsAt(
  text: string,
  line: number,
  character: number,
): Promise<string[]> {
  return (await completionItems(text, line, character)).map((i) => i.label);
}

/** The text an LSP client would actually insert (textEdit wins over insertText). */
function inserted(item: CompletionItem): string {
  if (item.textEdit && 'newText' in item.textEdit) {
    return item.textEdit.newText;
  }
  return item.insertText ?? item.label;
}

/**
 * The text an editor leaves behind when a snippet is accepted and every tab
 * stop is tabbed past: choices collapse to their first option, defaults to
 * their default, bare stops to nothing, and a `\$` escape to the EL `$` it
 * stands for.
 */
function accepted(item: CompletionItem): string {
  return inserted(item)
    .replace(/\$\{\d+\|([^,|]*)[^|]*\|\}/g, '$1')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\d+/g, '')
    .replace(/\\\$/g, '$');
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

/** A program with `|` marking the caret, split into text and position. */
function caretAt(program: string) {
  const offset = program.indexOf('|');
  const lines = program.slice(0, offset).split('\n');
  return {
    text: program.slice(0, offset) + program.slice(offset + 1),
    line: lines.length - 1,
    character: lines[lines.length - 1]!.length,
  };
}

/**
 * One offered completion, as `[label, detail, inserted text]`, with the kind
 * where it is neither of the two the harness derives: an item that inserts more
 * than its label is a `Snippet` and one that inserts its label is a `Keyword`,
 * so only a cross-reference row spells its own.
 */
type Item = readonly [
  label: string,
  detail: string,
  insertText: string,
  kind?: CompletionItemKind,
];

const CONSTRUCT = 'BPMNscript construct';
const SETTING = 'BPMNscript setting';
const EVENT_WORD = 'BPMNscript event word';
const LISTENER_EVENT = 'BPMNscript listener event';
/** Langium's own caption for a keyword it completes with no help from us. */
const KEYWORD = 'Keyword';

const TIMER: Item = [
  'timer',
  'a scheduled or relative deadline',
  'timer after "${1:PT1H}"',
];
const CONDITION: Item = [
  'condition',
  'a data-change watchdog',
  'condition ($1)',
];
const PARTICLES: Item[] = [
  ['after', 'a duration relative to when this scope starts', 'after'],
  ['at', 'a fixed point in time', 'at'],
  ['every', 'a repeating schedule', 'every'],
];

/** Every statement a body position opens, in the order they are offered. */
const STATEMENTS: Item[] = [
  ['start', CONSTRUCT, 'start ${1:name}'],
  ['end', CONSTRUCT, 'end ${1:name}'],
  ['user', CONSTRUCT, 'user ${1:id} {\n\tassignee = "${2:user}"\n}'],
  [
    'service',
    CONSTRUCT,
    'service ${1:id} {\n\tclass = "${2:com.example.Delegate}"\n}',
  ],
  [
    'script',
    CONSTRUCT,
    'script ${1:id} ```${2|javascript,groovy,python,ruby,feel|}\n\t$0\n```',
  ],
  ['step', CONSTRUCT, 'step ${1:id}'],
  [
    'send',
    CONSTRUCT,
    'send ${1:id} {\n\tclass = "${2:com.example.Delegate}"\n}',
  ],
  [
    'receive',
    CONSTRUCT,
    'receive ${1:id} {\n\tmessage = "${2:MessageName}"\n}',
  ],
  [
    'decide',
    CONSTRUCT,
    'decide ${1:id} {\n\tdecision = "${2:decision-key}"\n}',
  ],
  ['if', CONSTRUCT, 'if (${1:condition}) {\n\t$0\n}'],
  ['while', CONSTRUCT, 'while (${1:condition}) {\n\t$0\n}'],
  ['do', CONSTRUCT, 'do {\n\t$1\n} while (${2:condition})'],
  ['parallel', CONSTRUCT, 'parallel {\n\t{\n\t\t$1\n\t}\n\t{\n\t\t$2\n\t}\n}'],
  [
    'parallel if',
    CONSTRUCT,
    'parallel {\n\tif (${1:condition}) {\n\t\t$2\n\t}\n\telse {\n\t\t$3\n\t}\n}',
  ],
  ['goto', KEYWORD, 'goto'],
  ['attempt', CONSTRUCT, 'attempt ${1:id} {\n\t$0\n}'],
  ['subprocess', CONSTRUCT, 'subprocess ${1:id} {\n\t$0\n}'],
  [
    'call',
    'call another process like a function',
    'call ${1:id} {\n\tprocess = "${2:process-id}"\n\tin ${3:input}\n\tout ${4:result}\n}',
  ],
  [
    'on',
    CONSTRUCT,
    'on ${1|error,escalation,message,signal|} "${2:CODE}" {\n\t$0\n}',
  ],
  [
    'throw',
    CONSTRUCT,
    'throw ${1|error,escalation,message,signal|} "${2:CODE}"',
  ],
  ['emit', CONSTRUCT, 'emit ${1|escalation,message,signal|} "${2:CODE}"'],
  ['await', CONSTRUCT, 'await ${1|message,signal|} "${2:CODE}"'],
  [
    'await any',
    CONSTRUCT,
    'await {\n\t${1|message,signal|} "${2:CODE}" {\n\t\t$3\n\t}\n\t${4|message,signal|} "${5:CODE}" {\n\t\t$6\n\t}\n}',
  ],
];

/** The process-scope declarations, offered alongside the statements. */
const HEADER_DECLS: Item[] = [
  ['label', CONSTRUCT, 'label = "${1:label}"'],
  [
    'var',
    CONSTRUCT,
    'var ${1:name}: ${2|string,number,boolean,date,json,any|}',
  ],
  ['versionTag', SETTING, 'versionTag = "${1:1.0.0}"'],
];

const PROCESS_BODY: Item[] = [...HEADER_DECLS, ...STATEMENTS];

const REPEAT_FORMS: Item[] = [
  [
    'for each',
    'how often the preceding step runs',
    'for each ${1:item} in ${2:collection}',
  ],
  ['for', 'how often the preceding step runs', 'for ${1:3}'],
];

const ON_TRIGGERS: Item[] = [
  ['error', EVENT_WORD, 'error'],
  ['escalation', EVENT_WORD, 'escalation'],
  ['message', EVENT_WORD, 'message'],
  ['signal', EVENT_WORD, 'signal'],
  TIMER,
  CONDITION,
  ['compensation', 'the undo block of this subprocess', 'compensation'],
  ['cancel', EVENT_WORD, 'cancel'],
];

const CATCH_TRIGGERS: Item[] = [
  ['message', EVENT_WORD, 'message'],
  TIMER,
  ['signal', EVENT_WORD, 'signal'],
  CONDITION,
];

const ENGINE_SETTINGS: Item[] = [
  ['asyncBefore', SETTING, 'asyncBefore = ${1|true,false|}'],
  ['asyncAfter', SETTING, 'asyncAfter = ${1|true,false|}'],
  ['exclusive', SETTING, 'exclusive = ${1|false,true|}'],
  ['jobPriority', SETTING, 'jobPriority = ${1:50}'],
  ['retryCycle', SETTING, 'retryCycle = "${1:R3/PT10M}"'],
];

const PARAMETERS: Item[] = [
  ['input', 'a value handed to this step', 'input ${1:name} = ${2:value}'],
  ['output', 'a value this step hands back', 'output ${1:name} = ${2:value}'],
];

const LISTENER_KEYWORD: Item = [
  'on',
  'run code when this step reaches a lifecycle point',
  'on ${1|start,end|} {\n\tclass = "${2:com.example.Listener}"\n}',
];

/** The members every block-bearing element carries after its own keys. */
const BLOCK_MEMBERS: Item[] = [
  ['form', KEYWORD, 'form'],
  ...PARAMETERS,
  LISTENER_KEYWORD,
];

/** The three ways a listener binds; also the whole listener binding block. */
const BINDINGS: Item[] = [
  ['class', SETTING, 'class = "${1:com.example.Delegate}"'],
  ['expression', SETTING, 'expression = "${1:\\${bean.method(execution)}}"'],
  ['delegate', SETTING, 'delegate = "${1:\\${beanName}}"'],
];

const TOPIC: Item = ['topic', SETTING, 'topic = "${1:topic-name}"'];
const RESULT_VARIABLE: Item = [
  'resultVariable',
  SETTING,
  'resultVariable = "${1:result}"',
];
const BINDING: Item = ['binding', SETTING, 'binding = ${1|latest,deployment|}'];
const VERSION: Item = ['version', SETTING, 'version = ${1:1}'];

const USER_BLOCK: Item[] = [
  ['assignee', SETTING, 'assignee = "${1:user}"'],
  ['formKey', SETTING, 'formKey = "${1:form-key}"'],
  ['candidateGroups', SETTING, 'candidateGroups = "${1:group}"'],
  ['candidateUsers', SETTING, 'candidateUsers = "${1:user}"'],
  ['dueDate', SETTING, 'dueDate = "${1:\\${dateTime().plusDays(3)}}"'],
  [
    'followUpDate',
    SETTING,
    'followUpDate = "${1:\\${dateTime().plusDays(1)}}"',
  ],
  ['priority', SETTING, 'priority = ${1:50}'],
  ...ENGINE_SETTINGS,
  ...BLOCK_MEMBERS,
];

const SERVICE_BLOCK: Item[] = [
  ...BINDINGS,
  TOPIC,
  RESULT_VARIABLE,
  ...ENGINE_SETTINGS,
  ...BLOCK_MEMBERS,
];

const CALL_BLOCK: Item[] = [
  ['process', SETTING, 'process = "${1:process-id}"'],
  BINDING,
  VERSION,
  [
    'businessKey',
    SETTING,
    'businessKey = "${1:\\${execution.processBusinessKey}}"',
  ],
  ...ENGINE_SETTINGS,
  ['in', KEYWORD, 'in'],
  ['out', KEYWORD, 'out'],
  ...PARAMETERS,
  LISTENER_KEYWORD,
];

const RECEIVE_BLOCK: Item[] = [
  ['message', SETTING, 'message = "${1:MessageName}"'],
  ...ENGINE_SETTINGS,
  ...BLOCK_MEMBERS,
];

const DECIDE_BLOCK: Item[] = [
  ...BINDINGS,
  TOPIC,
  ['decision', SETTING, 'decision = "${1:decision-key}"'],
  BINDING,
  VERSION,
  [
    'mapDecisionResult',
    SETTING,
    'mapDecisionResult = ${1|singleEntry,singleResult,collectEntries,resultList|}',
  ],
  RESULT_VARIABLE,
  ...ENGINE_SETTINGS,
  ...BLOCK_MEMBERS,
];

/** A host-less handler lowers to an event sub-process, so it takes parameters. */
const HANDLER_BLOCK: Item[] = [...ENGINE_SETTINGS, ...BLOCK_MEMBERS];

const listenerEvent = (event: string): Item => [
  event,
  LISTENER_EVENT,
  `${event} {\n\tclass = "\${1:com.example.Listener}"\n}`,
];

const EXECUTION_EVENTS: Item[] = [listenerEvent('start'), listenerEvent('end')];

const TASK_EVENTS: Item[] = [
  ...EXECUTION_EVENTS,
  listenerEvent('create'),
  listenerEvent('assign'),
  listenerEvent('complete'),
  listenerEvent('update'),
  listenerEvent('delete'),
  [
    'timeout',
    LISTENER_EVENT,
    'timeout after "${1:PT1H}" {\n\tclass = "${2:com.example.Listener}"\n}',
  ],
];

describe('the completions offered at a caret', () => {
  test.each<readonly [string, string, Item[]]>([
    [
      'an empty process body offers the header declarations and every statement',
      'process p {\n  |\n}',
      PROCESS_BODY,
    ],
    [
      'the process header still offers its declarations after a var declaration',
      'process p {\n  var x: string\n  |\n}',
      PROCESS_BODY,
    ],
    [
      'a body position after a finished statement offers the statements again',
      'process p {\n  emit signal "S"\n  |\n}',
      STATEMENTS,
    ],
    [
      'the caret after a statement name offers both repeat-clause forms',
      'process p {\n  user U |\n}',
      [...REPEAT_FORMS, ...STATEMENTS],
    ],
    [
      'the top level offers only `process`',
      'pro|',
      [['process', CONSTRUCT, 'process ${1:name} {\n\t$0\n}']],
    ],
    [
      'the `on` trigger position offers the words a handler catches',
      'process p {\n  on |\n}',
      ON_TRIGGERS,
    ],
    [
      'the `throw` trigger position offers the words a throw ends on',
      'process p {\n  throw |\n}',
      [
        ['error', EVENT_WORD, 'error'],
        ['escalation', EVENT_WORD, 'escalation'],
        ['message', EVENT_WORD, 'message'],
        ['signal', EVENT_WORD, 'signal'],
        [
          'compensation',
          "undo this scope's completed work, then end this path",
          'compensation',
        ],
      ],
    ],
    [
      'the `emit` trigger position withholds `error`, which always ends its path',
      'process p {\n  emit |\n}',
      [
        ['escalation', EVENT_WORD, 'escalation'],
        ['message', EVENT_WORD, 'message'],
        ['signal', EVENT_WORD, 'signal'],
        [
          'compensation',
          "undo this scope's completed work, then continue",
          'compensation',
        ],
      ],
    ],
    [
      'the binding-list position offers the catchable event fields',
      'process p {\n  on error "X" (|\n}',
      [
        ['code', EVENT_WORD, 'code'],
        ['message', EVENT_WORD, 'message'],
        ['true', KEYWORD, 'true'],
        ['false', KEYWORD, 'false'],
        ['null', KEYWORD, 'null'],
      ],
    ],
    [
      'the particle position on a handler timer offers the three particles',
      'process p {\n  on timer |\n}',
      [...PARTICLES, ['alongside', KEYWORD, 'alongside']],
    ],
    [
      'the `await` trigger position offers only the triggers something can fire',
      'process p {\n  await |\n}',
      CATCH_TRIGGERS,
    ],
    [
      'a race branch header offers the same triggers a bare await does',
      'process p {\n  await { |\n}',
      CATCH_TRIGGERS,
    ],
    [
      'the particle position in a race branch offers the three particles',
      'process p {\n  await { timer |\n}',
      PARTICLES,
    ],
    [
      'the particle position on an awaited timer offers the particles and the statements',
      'process p {\n  await timer |\n}',
      [...PARTICLES, ...STATEMENTS],
    ],
    [
      'the start trigger position offers the kinds a process can start on',
      'process p {\n  start S |\n  user A\n  end E \n}',
      [
        ['message', EVENT_WORD, 'message'],
        ['signal', EVENT_WORD, 'signal'],
        TIMER,
        ...STATEMENTS,
      ],
    ],
    [
      'the end trigger position offers the two words an end carries and no other',
      'process p {\n  start S \n  user A\n  end E |\n}',
      [
        ['terminate', 'stop every running path in this scope', 'terminate'],
        ['cancel', 'give up the surrounding attempt block', 'cancel'],
        ...STATEMENTS,
      ],
    ],
    [
      'the particle position on a timer start offers the particles and the statements',
      'process p {\n  start S timer |\n  user A\n}',
      [...PARTICLES, ...STATEMENTS],
    ],
    // `Decoy` (another process) and `Inner` (a nested subprocess body) are both
    // named statements the scope must keep out.
    [
      "the host position offers the container's activities and nothing from another scope",
      'process p {\n  user Review\n  service Ship\n  subprocess Sub {\n    user Inner\n  }\n  on |\n}\nprocess q { user Decoy }',
      [
        ['Review', 'UserTask', 'Review', CompletionItemKind.Reference],
        ['Ship', 'ServiceTask', 'Ship', CompletionItemKind.Reference],
        ['Sub', 'SubProcess', 'Sub', CompletionItemKind.Reference],
        ...ON_TRIGGERS,
      ],
    ],
    [
      'the position after the colon offers the triggers the host-less position does',
      'process p {\n  user Review\n  on Review: |\n}',
      ON_TRIGGERS,
    ],
    [
      'a user block offers the user-task keys and none of the service ones',
      'process p {\n  user T {\n    |\n  }\n}',
      USER_BLOCK,
    ],
    [
      'a user block offers its whole member set after an attribute',
      'process p {\n  user T {\n    assignee = "demo"\n    |\n  }\n}',
      USER_BLOCK,
    ],
    [
      'a user block offers its whole member set after a form block',
      'process p {\n  user T {\n    form {\n      amount: number\n    }\n    |\n  }\n}',
      USER_BLOCK,
    ],
    [
      'a user block offers its whole member set after an io parameter',
      'process p {\n  user T {\n    input x = 1\n    |\n  }\n}',
      USER_BLOCK,
    ],
    // A closed listener block must not capture the caret that follows it.
    [
      'a user block offers its whole member set after a closed listener',
      'process p {\n  user T {\n    on create {\n      class = "com.example.L"\n    }\n    |\n  }\n}',
      USER_BLOCK,
    ],
    [
      'an unclosed user block still offers the keys of the element it belongs to',
      'process p {\n  user T {\n    |',
      USER_BLOCK,
    ],
    [
      'a service block offers the binding keys and none of the user-task ones',
      'process p {\n  service S {\n    |\n  }\n}',
      SERVICE_BLOCK,
    ],
    [
      'a service block offers the binding keys after a preceding attribute',
      'process p {\n  service S {\n    class = "com.example.D"\n    |\n  }\n}',
      SERVICE_BLOCK,
    ],
    [
      'a call block offers the call keys, `process` among them, exactly once',
      'process p {\n  call C {\n    |\n  }\n}',
      CALL_BLOCK,
    ],
    [
      'a call block offers the call keys after a preceding attribute',
      'process p {\n  call C {\n    binding = latest\n    |\n  }\n}',
      CALL_BLOCK,
    ],
    [
      'a receive block offers the message key',
      'process p {\n  receive R {\n    |\n  }\n}',
      RECEIVE_BLOCK,
    ],
    [
      'a decide block offers the decision keys alongside the binding ones',
      'process p {\n  decide D {\n    |\n  }\n}',
      DECIDE_BLOCK,
    ],
    [
      'a host-less handler block offers parameters, which a boundary event has none of',
      'process p {\n  start S\n  on error {\n    asyncBefore = true\n    |\n  } {\n    end Failed\n  }\n}',
      HANDLER_BLOCK,
    ],
    [
      'a listener binding block offers the three ways a listener binds',
      'process p {\n  user T {\n    on create {\n      |\n    }\n  }\n}',
      BINDINGS,
    ],
    [
      'a listener binding block offers them after a preceding binding too',
      'process p {\n  user T {\n    on create {\n      class = "com.example.L"\n      |\n    }\n  }\n}',
      BINDINGS,
    ],
    [
      'an unclosed listener binding block offers them as well',
      'process p {\n  user T {\n    on create {\n      |',
      BINDINGS,
    ],
    [
      'a user block offers the task listener events as well as the execution ones',
      'process p {\n  user T {\n    on |\n  }\n}',
      TASK_EVENTS,
    ],
    [
      'a user block offers the task listener events after a preceding attribute',
      'process p {\n  user T {\n    assignee = "demo"\n    on |\n  }\n}',
      TASK_EVENTS,
    ],
    [
      'a service block offers only the execution listener events',
      'process p {\n  service S {\n    on |\n  }\n}',
      EXECUTION_EVENTS,
    ],
    [
      'the VarType slot keeps plain keyword completions, not snippets',
      'process p {\n  var x: |\n}',
      [
        ['string', KEYWORD, 'string'],
        ['number', KEYWORD, 'number'],
        ['boolean', KEYWORD, 'boolean'],
        ['date', KEYWORD, 'date'],
        ['json', KEYWORD, 'json'],
        ['any', KEYWORD, 'any'],
      ],
    ],
    [
      'a map key inside a parameter value is left to the default completion',
      'process p {\n  user T {\n    input x = {\n      |\n    }\n  }\n}',
      [],
    ],
  ])('%s', async (_title, program, expected) => {
    const { text, line, character } = caretAt(program);
    const items = await completionItems(text, line, character);
    expect(items.map((i) => [i.label, i.detail, inserted(i)])).toEqual(
      expected.map(([label, detail, insert]) => [label, detail, insert]),
    );
    for (const [index, item] of items.entries()) {
      // An item that inserts more than its own label has to say it is a
      // snippet, or the editor writes the placeholders out literally. One that
      // inserts its label carries the kind its row names, a keyword unless the
      // row says otherwise.
      const scaffolds = inserted(item) !== item.label;
      expect(item.insertTextFormat === InsertTextFormat.Snippet).toBe(
        scaffolds,
      );
      expect(item.kind).toBe(
        scaffolds
          ? CompletionItemKind.Snippet
          : (expected[index]![3] ?? CompletionItemKind.Keyword),
      );
    }
  });
});

/** The rows of `items` that scaffold something, with the program they land in. */
function scaffolds(
  where: string,
  items: Item[],
  program: (accepted: string) => string,
): Array<readonly [string, string, (accepted: string) => string]> {
  return items
    .filter(([label, , insertText]) => insertText !== label)
    .map(([label]) => [`\`${label}\` in ${where}`, label, program] as const);
}

describe('a scaffold parses once accepted', () => {
  test('the parse helper reports a lexer error, not only a parser one', async () => {
    expect(await parseErrors('process p {\n  @@@\n}')).not.toEqual([]);
  });

  test.each([
    ...scaffolds(
      'a process body',
      PROCESS_BODY,
      (body) => `process p {\n${body}\n}`,
    ),
    ...scaffolds(
      'the position after a step name',
      REPEAT_FORMS,
      (clause) => `process p {\n  user U ${clause}\n}`,
    ),
    ...scaffolds(
      'a user block',
      USER_BLOCK,
      (member) => `process p {\n  user T {\n${member}\n  }\n}`,
    ),
    ...scaffolds(
      'a service block',
      SERVICE_BLOCK,
      (member) => `process p {\n  service S {\n${member}\n  }\n}`,
    ),
    ...scaffolds(
      'a call block',
      CALL_BLOCK,
      (member) => `process p {\n  call C {\n${member}\n  }\n}`,
    ),
    ...scaffolds(
      'a decide block',
      DECIDE_BLOCK,
      (member) => `process p {\n  decide D {\n${member}\n  }\n}`,
    ),
    ...scaffolds(
      'a listener binding block',
      BINDINGS,
      (binding) =>
        `process p {\n  user T {\n    on create {\n${binding}\n    }\n  }\n}`,
    ),
    ...scaffolds(
      'the listener event position',
      TASK_EVENTS,
      (listener) => `process p {\n  user T {\n    on ${listener}\n  }\n}`,
    ),
  ])('%s', async (_title, label, program) => {
    const { text, line, character } = caretAt(program('|'));
    const item = (await completionItems(text, line, character)).find(
      (i) => i.label === label,
    );
    expect(item).toBeDefined();
    expect(await parseErrors(program(accepted(item!)))).toEqual([]);
  });
});

describe('a settings block is narrowed to the element it belongs to', () => {
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
        .filter((i) => i.detail === SETTING)
        .map((i) => i.label);
      expect(new Set(offered)).toEqual(rule.keys);
    },
  );
});
