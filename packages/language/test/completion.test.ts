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
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import {
  type CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  DiagnosticSeverity,
} from 'vscode-languageserver-types';
import {
  ATTEMPT_BLOCK_RULE,
  ATTRIBUTE_BLOCK_RULES,
  type BpmnScriptServices,
  createBpmnScriptServices,
  ENGINE_KEYS,
} from '@bpmn-script/language';
import { BLOCK_HOSTS, caretInSlot } from './helpers/block-hosts.js';
import { withTextMessages } from './helpers/diagnostics.js';

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
 * their default, bare stops to `fillStop`, and a `\$` escape to the EL `$` it
 * stands for.
 */
function accepted(
  item: CompletionItem,
  fillStop: (stop: string) => string = () => '',
): string {
  return inserted(item)
    .replace(/\$\{\d+\|([^,|]*)[^|]*\|\}/g, '$1')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$(\d+)/g, (_, stop: string) => fillStop(stop))
    .replace(/\\\$/g, '$');
}

/**
 * The same text with a step typed into every bare tab stop, which is what the
 * author does next: each one opens a body, and a container is only complete
 * once something runs in it. The stop's number keeps the steps apart, so two
 * branches of one scaffold do not collide on a name.
 */
const typedInto = (stop: string) => `user Step${stop}`;

let parseCounter = 0;

async function build(text: string, validation: boolean) {
  const uri = URI.parse(`file:///parse-${parseCounter++}.bpmnscript`);
  const document = services.shared.workspace.LangiumDocumentFactory.fromString(
    text,
    uri,
  );
  services.shared.workspace.LangiumDocuments.addDocument(document);
  await services.shared.workspace.DocumentBuilder.build([document], {
    validation,
  });
  return document;
}

/**
 * The lexer and parser errors `text` produces, so a scaffold can be checked as
 * accepted. Both arrays matter: an unlexable character never reaches the parser,
 * so parser errors alone would report a rejected input as clean.
 */
async function parseErrors(text: string): Promise<string[]> {
  const { parseResult } = await build(text, false);
  return [...parseResult.lexerErrors, ...parseResult.parserErrors].map(
    (e) => e.message,
  );
}

/**
 * The errors `text` raises once validated. Warnings are left out: a scaffold
 * writes an example value naming a variable the author has yet to declare, and
 * saying so is the editor doing its job rather than a defect in the scaffold.
 */
async function validationErrors(text: string): Promise<string[]> {
  const document: LangiumDocument = await build(text, true);
  return withTextMessages(document.diagnostics ?? [])
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => d.message);
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

/**
 * The words every settings position also offers: an unkeyed item there is an
 * event payload or a condition, which is an expression like any other.
 */
const LITERALS: Item[] = [
  ['true', KEYWORD, 'true'],
  ['false', KEYWORD, 'false'],
  ['null', KEYWORD, 'null'],
];

const TIMER: Item = [
  'timer',
  'a scheduled or relative deadline',
  'timer("${1:PT1H}")',
];
const CONDITION: Item = [
  'condition',
  'a data-change watchdog',
  'condition(${1:amount > 100})',
];
/** A duration is the bare payload the `timer` snippet already scaffolds. */
const TIMER_KEYS: Item[] = [
  ['at', SETTING, 'at: "${1:2026-08-01T09:00:00}"'],
  ['every', SETTING, 'every: "${1:R/PT10M}"'],
];

/** Opens the flow, so it belongs above the first step rather than after one. */
const START: Item = ['start', CONSTRUCT, 'start ${1:name}'];

/** Every statement a body position opens, in the order they are offered. */
const STATEMENTS: Item[] = [
  START,
  ['end', CONSTRUCT, 'end ${1:name}'],
  ['user', CONSTRUCT, 'user ${1:id}(assignee: "${2:user}")'],
  ['service', CONSTRUCT, 'service ${1:id}(class: "${2:com.example.Delegate}")'],
  [
    'script',
    CONSTRUCT,
    'script ${1:id} ```${2|javascript,groovy,python,ruby,feel|}\n\t$0\n```',
  ],
  ['step', CONSTRUCT, 'step ${1:id}'],
  ['send', CONSTRUCT, 'send ${1:id}(class: "${2:com.example.Delegate}")'],
  ['receive', CONSTRUCT, 'receive ${1:id}(message: "${2:MessageName}")'],
  ['decide', CONSTRUCT, 'decide ${1:id}(decision: "${2:decision-key}")'],
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
    'call ${1:id}(process: "${2:process-id}") {\n\tin ${3:input}\n\tout ${4:result}\n}',
  ],
  ['on', CONSTRUCT, 'on ${1|error,escalation|}(${2:CODE}) {\n\t$0\n}'],
  ['on message', CONSTRUCT, 'on ${1|message,signal|}("${2:NAME}") {\n\t$0\n}'],
  ['throw', CONSTRUCT, 'throw ${1|error,escalation|}(${2:CODE})'],
  ['throw message', CONSTRUCT, 'throw ${1|message,signal|}("${2:NAME}")'],
  ['emit', CONSTRUCT, 'emit ${1|escalation|}(${2:CODE})'],
  ['emit message', CONSTRUCT, 'emit ${1|message,signal|}("${2:NAME}")'],
  ['await', CONSTRUCT, 'await ${1|message,signal|}("${2:NAME}")'],
  [
    'await any',
    CONSTRUCT,
    'await {\n\t${1|message,signal|}("${2:NAME}") {\n\t\t$3\n\t}\n\t${4|message,signal|}("${5:OTHER}") {\n\t\t$6\n\t}\n}',
  ],
];

/**
 * The process-scope declarations, offered alongside the statements. A label is
 * a setting on the process head rather than a declaration, so it is not here.
 */
const HEADER_DECLS: Item[] = [
  [
    'var',
    CONSTRUCT,
    'var ${1:name}: ${2|string,number,boolean,date,json,any|}',
  ],
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

const LABEL: Item = ['label', SETTING, 'label: "${1:label}"'];
const DOCUMENTATION: Item = [
  'documentation',
  SETTING,
  'documentation: "${1:documentation}"',
];

const ENGINE_SETTINGS: Item[] = [
  ['asyncBefore', SETTING, 'asyncBefore: ${1|true,false|}'],
  ['asyncAfter', SETTING, 'asyncAfter: ${1|true,false|}'],
  ['exclusive', SETTING, 'exclusive: ${1|false,true|}'],
  ['jobPriority', SETTING, 'jobPriority: ${1:50}'],
  ['retryCycle', SETTING, 'retryCycle: "${1:R3/PT10M}"'],
];

const PARAMETERS: Item[] = [
  ['input', 'a value handed to this step', 'input ${1:name} = ${2:value}'],
  ['output', 'a value this step hands back', 'output ${1:name} = ${2:value}'],
];

const LISTENER_KEYWORD: Item = [
  'on',
  'run code when this step reaches a lifecycle point',
  'on ${1|start,end|}(class: "${2:com.example.Listener}")',
];

/** What the brace block of an element holds, its settings having moved out. */
const BLOCK_MEMBERS: Item[] = [
  ['form', KEYWORD, 'form'],
  ...PARAMETERS,
  LISTENER_KEYWORD,
];

/**
 * The first brace block of an element that also takes a body is ambiguous while
 * it is still open: no member commits it to being the member block, so a
 * statement stays possible and both sets are offered.
 */
const BLOCK_OR_BODY: Item[] = [...STATEMENTS, ...PARAMETERS];

/** The three ways a listener binds; also the whole listener parens. */
const BINDINGS: Item[] = [
  ['class', SETTING, 'class: "${1:com.example.Delegate}"'],
  ['expression', SETTING, 'expression: "${1:\\${bean.method(execution)}}"'],
  ['delegate', SETTING, 'delegate: "${1:\\${beanName}}"'],
];

const TOPIC: Item = ['topic', SETTING, 'topic: "${1:topic-name}"'];
const RESULT_VARIABLE: Item = [
  'resultVariable',
  SETTING,
  'resultVariable: "${1:result}"',
];
const BINDING: Item = ['binding', SETTING, 'binding: ${1|latest,deployment|}'];
const VERSION: Item = ['version', SETTING, 'version: ${1:1}'];

const USER_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ['assignee', SETTING, 'assignee: "${1:user}"'],
  ['formKey', SETTING, 'formKey: "${1:form-key}"'],
  ['candidateGroups', SETTING, 'candidateGroups: "${1:group}"'],
  ['candidateUsers', SETTING, 'candidateUsers: "${1:user}"'],
  ['dueDate', SETTING, 'dueDate: "${1:\\${dateTime().plusDays(3)}}"'],
  ['followUpDate', SETTING, 'followUpDate: "${1:\\${dateTime().plusDays(1)}}"'],
  ['priority', SETTING, 'priority: ${1:50}'],
  ...ENGINE_SETTINGS,
  ...LITERALS,
];

const SERVICE_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ...BINDINGS,
  TOPIC,
  RESULT_VARIABLE,
  ...ENGINE_SETTINGS,
  ...LITERALS,
];

const CALL_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ['process', SETTING, 'process: "${1:process-id}"'],
  BINDING,
  VERSION,
  [
    'businessKey',
    SETTING,
    'businessKey: "${1:\\${execution.processBusinessKey}}"',
  ],
  ...ENGINE_SETTINGS,
  ...LITERALS,
];

const RECEIVE_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ['message', SETTING, 'message: "${1:MessageName}"'],
  ...ENGINE_SETTINGS,
  ...LITERALS,
];

const DECIDE_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ...BINDINGS,
  TOPIC,
  ['decision', SETTING, 'decision: "${1:decision-key}"'],
  BINDING,
  VERSION,
  [
    'mapDecisionResult',
    SETTING,
    'mapDecisionResult: ${1|singleEntry,singleResult,collectEntries,resultList|}',
  ],
  RESULT_VARIABLE,
  ...ENGINE_SETTINGS,
  ...LITERALS,
];

/** A handler catching an error or an escalation binds what the event carries. */
const HANDLER_PARENS: Item[] = [
  ['code', SETTING, 'code: ${1:code}'],
  ['message', SETTING, 'message: ${1:message}'],
  ...ENGINE_SETTINGS,
  ...LITERALS,
];

const PROCESS_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ['versionTag', SETTING, 'versionTag: "${1:1.0.0}"'],
  ['historyTimeToLive', SETTING, 'historyTimeToLive: "${1:P30D}"'],
  [
    'candidateStarterUsers',
    SETTING,
    'candidateStarterUsers: "${1:demo,manager}"',
  ],
  [
    'candidateStarterGroups',
    SETTING,
    'candidateStarterGroups: "${1:adjusters}"',
  ],
  ...LITERALS,
];

const START_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ['initiator', SETTING, 'initiator: "${1:starter}"'],
  ...ENGINE_SETTINGS,
  ...LITERALS,
];

const LISTENER_PARENS: Item[] = [...BINDINGS, ...LITERALS];

const listenerEvent = (event: string): Item => [
  event,
  LISTENER_EVENT,
  `${event}(class: "\${1:com.example.Listener}")`,
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
    'timeout after "${1:PT1H}"(class: "${2:com.example.Listener}")',
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
      'process p {\n  emit signal("S")\n  |\n}',
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
      'the parens of a handler offer the bindings of the event it catches',
      'process p {\n  start S\n  on error(|) {\n    end Failed\n  }\n}',
      HANDLER_PARENS,
    ],
    [
      'the parens of a timer handler offer the keys naming a date and a cycle',
      'process p {\n  on timer(|) {\n    end Late\n  }\n}',
      [...TIMER_KEYS, ...ENGINE_SETTINGS, ...LITERALS],
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
      'the start trigger position offers the kinds a process can start on',
      'process p {\n  start S |\n  user A\n  end E \n}',
      [
        ['message', EVENT_WORD, 'message'],
        ['signal', EVENT_WORD, 'signal'],
        TIMER,
        CONDITION,
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
      'a user task offers the user-task settings and none of the service ones',
      'process p {\n  user T(|)\n}',
      USER_PARENS,
    ],
    [
      'a user task offers its whole settings list after a preceding setting',
      'process p {\n  user T(assignee: "demo", |)\n}',
      USER_PARENS,
    ],
    [
      'unclosed parens still offer the settings of the element they belong to',
      'process p {\n  user T(|',
      USER_PARENS,
    ],
    [
      'the process parens offer the settings a process header takes',
      'process p(|) {\n  user T\n}',
      PROCESS_PARENS,
    ],
    [
      'the start parens offer the settings a start event takes',
      'process p {\n  start S(|)\n  user T\n}',
      START_PARENS,
    ],
    [
      'a service task offers the binding settings and none of the user-task ones',
      'process p {\n  service S(|)\n}',
      SERVICE_PARENS,
    ],
    [
      'a call offers the call settings, `process` among them, exactly once',
      'process p {\n  call C(|)\n}',
      CALL_PARENS,
    ],
    [
      'a receive task offers the message setting',
      'process p {\n  receive R(|)\n}',
      RECEIVE_PARENS,
    ],
    [
      'a decision step offers the decision settings alongside the binding ones',
      'process p {\n  decide D(|)\n}',
      DECIDE_PARENS,
    ],
    [
      'a user block offers its members, the settings having moved to the parens',
      'process p {\n  user T {\n    |\n  }\n}',
      BLOCK_MEMBERS,
    ],
    [
      'a user block offers its whole member set after a form block',
      'process p {\n  user T {\n    form {\n      amount: number\n    }\n    |\n  }\n}',
      BLOCK_MEMBERS,
    ],
    [
      'a user block offers its whole member set after an io parameter',
      'process p {\n  user T {\n    input x = 1\n    |\n  }\n}',
      BLOCK_MEMBERS,
    ],
    // A closed listener must not capture the caret that follows it.
    [
      'a user block offers its whole member set after a closed listener',
      'process p {\n  user T {\n    on create(class: "com.example.L")\n    |\n  }\n}',
      BLOCK_MEMBERS,
    ],
    [
      'an unclosed user block still offers the members of the element it belongs to',
      'process p {\n  user T {\n    |',
      BLOCK_MEMBERS,
    ],
    [
      'a host-less handler block offers parameters, which a boundary event has none of',
      'process p {\n  start S\n  on error {\n    input x = 1\n    |\n  } {\n    end Failed\n  }\n}',
      BLOCK_OR_BODY,
    ],
    [
      'a hosted handler lowers to a boundary event, so its block offers no parameter',
      'process p {\n  user U\n  on U: error {\n    |\n  } {\n    end Failed\n  }\n}',
      STATEMENTS,
    ],
    [
      'a listener offers the three ways a listener binds',
      'process p {\n  user T {\n    on create(|)\n  }\n}',
      LISTENER_PARENS,
    ],
    [
      'a listener offers them after a preceding binding too',
      'process p {\n  user T {\n    on create(class: "com.example.L", |)\n  }\n}',
      LISTENER_PARENS,
    ],
    [
      'an unclosed listener offers them as well',
      'process p {\n  user T {\n    on create(|',
      LISTENER_PARENS,
    ],
    [
      'a user block offers the task listener events as well as the execution ones',
      'process p {\n  user T {\n    on |\n  }\n}',
      TASK_EVENTS,
    ],
    [
      'a user block offers the task listener events after a preceding member',
      'process p {\n  user T {\n    input x = 1\n    on |\n  }\n}',
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
    // Every identifier in an expression is a reference to a code declaration,
    // so the scope is what keeps the declared codes out of this list.
    [
      'an expression position offers no code declaration, only the literal words',
      'process p {\n  error PAYMENT_DECLINED(message: "x")\n  if (|) {\n    user A\n  }\n}',
      LITERALS,
    ],
    [
      'a code position offers the declared codes of its own kind and nothing else',
      'process p {\n  error PAYMENT_DECLINED(message: "x")\n  escalation PAYMENT_REVIEW\n  throw error(PAY|)\n}',
      [
        [
          'PAYMENT_DECLINED',
          'CodeDecl',
          'PAYMENT_DECLINED',
          CompletionItemKind.Reference,
        ],
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

/**
 * A setting the element it belongs to cannot do without. Each is offered
 * alongside the rest, so a host that already writes one would collide with the
 * row under test: they are checked in a host that writes none instead.
 */
const REQUIRED_BINDINGS = new Set([
  'class',
  'expression',
  'delegate',
  'topic',
  'decision',
  'process',
]);

const binds = ([label]: Item) => REQUIRED_BINDINGS.has(label);

/**
 * The declaration a statement scaffold needs in the header. Every scaffold
 * writes its code as the same placeholder name, and a code reaches only the
 * declarations of its own kind, so which kind is declared follows the
 * statement.
 */
const declarationNaming = (statement: string): string =>
  statement.includes('escalation')
    ? 'escalation CODE'
    : 'error CODE(message: "m")';

describe('a scaffold parses and validates once accepted', () => {
  test('the parse helper reports a lexer error, not only a parser one', async () => {
    expect(await parseErrors('process p {\n  @@@\n}')).not.toEqual([]);
  });

  test.each([
    ...scaffolds(
      'a process header',
      [...HEADER_DECLS, START],
      (decl) => `process p {\n${decl}\n  user Anchor\n}`,
    ),
    ...scaffolds(
      'a process body',
      STATEMENTS.filter((item) => item !== START),
      (statement) =>
        `process p {\n  ${declarationNaming(statement)}\n  user Anchor\n${statement}\n}`,
    ),
    ...scaffolds(
      'the position after a step name',
      REPEAT_FORMS,
      (clause) => `process p {\n  user U ${clause}\n}`,
    ),
    ...scaffolds(
      'the parens of a user task',
      USER_PARENS,
      (setting) => `process p {\n  user T(${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a receive task',
      RECEIVE_PARENS,
      (setting) => `process p {\n  receive R(${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a service task',
      SERVICE_PARENS.filter((item) => !binds(item)),
      (setting) =>
        `process p {\n  service S(class: "com.example.D", ${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a service task',
      SERVICE_PARENS.filter(binds),
      (binding) => `process p {\n  service S(${binding})\n}`,
    ),
    ...scaffolds(
      'the parens of a decision step',
      DECIDE_PARENS.filter((item) => !binds(item)),
      (setting) =>
        `process p {\n  decide D(decision: "riskRating", ${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a decision step',
      DECIDE_PARENS.filter(binds),
      (binding) => `process p {\n  decide D(${binding})\n}`,
    ),
    ...scaffolds(
      'the parens of a call',
      CALL_PARENS.filter((item) => !binds(item)),
      (setting) => `process p {\n  call C(process: "q", ${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a call',
      CALL_PARENS.filter(binds),
      (binding) => `process p {\n  call C(${binding})\n}`,
    ),
    ...scaffolds(
      'the parens of a handler',
      HANDLER_PARENS,
      (setting) =>
        `process p {\n  start S\n  on error(${setting}) {\n    user Caught\n  }\n}`,
    ),
    ...scaffolds(
      'the parens of a process',
      PROCESS_PARENS,
      (setting) => `process p(${setting}) {\n  user U\n}`,
    ),
    ...scaffolds(
      'a user block',
      BLOCK_MEMBERS,
      (member) => `process p {\n  user T {\n${member}\n  }\n}`,
    ),
    ...scaffolds(
      'the parens of a listener',
      LISTENER_PARENS,
      (binding) => `process p {\n  user T {\n    on create(${binding})\n  }\n}`,
    ),
    ...scaffolds(
      'the listener event position',
      TASK_EVENTS,
      (listener) => `process p {\n  user T {\n    on ${listener}\n  }\n}`,
    ),
    ...scaffolds(
      'the trigger position of a handler',
      ON_TRIGGERS,
      (trigger) =>
        `process p {\n  user U\n  on U: ${trigger} {\n    user Caught\n  }\n}`,
    ),
    ...scaffolds(
      'the trigger position of an await',
      CATCH_TRIGGERS,
      (trigger) => `process p {\n  user U\n  await ${trigger}\n}`,
    ),
  ])('%s', async (_title, label, program) => {
    const { text, line, character } = caretAt(program('|'));
    const item = (await completionItems(text, line, character)).find(
      (i) => i.label === label,
    );
    expect(item).toBeDefined();
    expect(await parseErrors(program(accepted(item!)))).toEqual([]);
    expect(await validationErrors(program(accepted(item!, typedInto)))).toEqual(
      [],
    );
  });
});

/** Keyed by description, which is the noun phrase a host row spells as well. */
const RULE_BY_DESCRIPTION = new Map(
  [...Object.values(ATTRIBUTE_BLOCK_RULES), ATTEMPT_BLOCK_RULE].map((rule) => [
    rule.description,
    rule,
  ]),
);

describe('an element offers exactly the settings it takes', () => {
  test.each(BLOCK_HOSTS)(
    'the parens of %s offer the keys the validator accepts there',
    async (_kind, description, _members, settings) => {
      const rule = RULE_BY_DESCRIPTION.get(description)!;
      const { text, line, character } = caretInSlot(
        settings,
        'asyncBefore: true, ',
      );
      expect(await labelsAt(text, line, character)).toEqual([
        ...rule.own,
        ...ENGINE_KEYS,
        ...LITERALS.map(([label]) => label),
      ]);
    },
  );
});
