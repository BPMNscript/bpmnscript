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
  CALL_BINDING_VALUES,
  createBpmnScriptServices,
  DECISION_RESULT_MAPPINGS,
  ENGINE_KEYS,
  FORM_CONSTRAINT_TYPES,
  FORM_FIELD_TYPES,
  TRIGGER_PAYLOAD,
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

/** The words an expression position offers on its own. */
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
    'script ${1:id} ```${2|juel,javascript,groovy,python,ruby,feel|}\n\t$0\n```',
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
  ['emit message', CONSTRUCT, 'emit ${1|message,signal,link|}("${2:NAME}")'],
  ['await', CONSTRUCT, 'await ${1|message,signal,link|}("${2:NAME}")'],
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
  [
    'error',
    'declare an error code',
    'error ${1:NAME}(message: "${2:message}")',
  ],
  ['escalation', 'declare an escalation code', 'escalation ${1:NAME}'],
];

const PROCESS_BODY: Item[] = [...HEADER_DECLS, ...STATEMENTS];

/** Two declared variables, and the items completion offers for them. */
const VARS = 'var amount: number\n  var ok: boolean';
const VARIABLES: Item[] = [
  ['amount', 'number', 'amount', CompletionItemKind.Variable],
  ['ok', 'boolean', 'ok', CompletionItemKind.Variable],
];

const REPEAT_FORMS: Item[] = [
  [
    'for each',
    'how often the preceding step runs',
    'for each ${1:item} in ${2:collection}',
  ],
  ['for', 'how often the preceding step runs', 'for ${1:3}'],
];

/**
 * The words a handler at process level catches, host-less or on a user task.
 * `compensation` joins them only directly inside a subprocess body, `cancel`
 * only on an attempt block as host, and a service task drops `escalation`.
 */
const ON_TRIGGERS: Item[] = [
  ['error', EVENT_WORD, 'error'],
  ['escalation', EVENT_WORD, 'escalation'],
  ['message', EVENT_WORD, 'message'],
  ['signal', EVENT_WORD, 'signal'],
  TIMER,
  CONDITION,
];

const RACE_TRIGGERS: Item[] = [
  ['message', EVENT_WORD, 'message'],
  TIMER,
  ['signal', EVENT_WORD, 'signal'],
  CONDITION,
];

const CATCH_TRIGGERS: Item[] = [
  ...RACE_TRIGGERS,
  ['link', "the target of an 'emit link' of the same name", 'link'],
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

/** The join gateway's settings: the same values under the prefixed keys. */
const JOIN_SETTINGS: Item[] = [
  ['joinAsyncBefore', SETTING, 'joinAsyncBefore: ${1|true,false|}'],
  ['joinAsyncAfter', SETTING, 'joinAsyncAfter: ${1|true,false|}'],
  ['joinExclusive', SETTING, 'joinExclusive: ${1|false,true|}'],
  ['joinJobPriority', SETTING, 'joinJobPriority: ${1:50}'],
  ['joinRetryCycle', SETTING, 'joinRetryCycle: "${1:R3/PT10M}"'],
];

/**
 * The per-run settings a repeated statement's parens take after the engine
 * ones: the same values under the `run` keys, a job priority having no per-run
 * carrier.
 */
const RUN_SETTINGS: Item[] = [
  ['runAsyncBefore', SETTING, 'runAsyncBefore: ${1|true,false|}'],
  ['runAsyncAfter', SETTING, 'runAsyncAfter: ${1|true,false|}'],
  ['runExclusive', SETTING, 'runExclusive: ${1|false,true|}'],
  ['runRetryCycle', SETTING, 'runRetryCycle: "${1:R3/PT10M}"'],
];

/** The head of a statement with a join: the split's keys, then the join's. */
const SPLIT_AND_JOIN_PARENS: Item[] = [...ENGINE_SETTINGS, ...JOIN_SETTINGS];

/** A loop has one gateway, so its parens take the bare keys alone. */
const LOOP_PARENS: Item[] = ENGINE_SETTINGS;

/** An await block's head leaves out the one key the validator refuses there. */
const AWAIT_PARENS: Item[] = [
  ...ENGINE_SETTINGS.filter(([label]) => label !== 'asyncAfter'),
  ...JOIN_SETTINGS,
];

const PARAMETERS: Item[] = [
  ['input', 'a value handed to this step', 'input ${1:name} = ${2:value}'],
  ['output', 'a value this step hands back', 'output ${1:name} = ${2:value}'],
];

const FIELD: Item = [
  'field',
  'a value injected into the class, delegate, or built-in behaviour this step names',
  'field ${1:name} = "${2:value}"',
];

const LISTENER_KEYWORD: Item = [
  'on',
  'run code when this step reaches a lifecycle point',
  'on ${1|start,end|}(class: "${2:com.example.Listener}")',
];

const FORM_KEYWORD: Item = ['form', KEYWORD, 'form'];

/** A form field's parens, in the order the constraints are registered. */
const FORM_FIELD_PARENS: Item[] = [
  ['required', SETTING, 'required: true'],
  ['readonly', SETTING, 'readonly: true'],
  ['min', SETTING, 'min: ${1:0}'],
  ['max', SETTING, 'max: ${1:100}'],
  ['minlength', SETTING, 'minlength: ${1:1}'],
  ['maxlength', SETTING, 'maxlength: ${1:80}'],
  ['validator', SETTING, 'validator: "${1:com.example.Validator}"'],
  ['pattern', SETTING, 'pattern: "${1:dd/MM/yyyy}"'],
];

const PROPERTY: Item = [
  'property',
  'a value Tasklist or a worker reads off the step, never a variable',
  'property ${1:name} = "${2:value}"',
];

/** The one field type each setting is legal on; `pattern` has no row and fits a date. */
const fieldTypeTaking = (key: string): string =>
  FORM_CONSTRAINT_TYPES[key]?.[0] ?? 'date';

/** A mapping's code is a declaration, so the scaffold writes it bare. */
const ERROR_MAPPING: Item = [
  'error',
  'raise a declared error when a reported failure matches',
  'error ${1:CODE} when ${2:condition}',
];

/** What the brace block of an element holds, its settings having moved out. */
const BLOCK_MEMBERS: Item[] = [FORM_KEYWORD, ...PARAMETERS, LISTENER_KEYWORD];

/** The block of a service task bound to a class, which the engine injects fields into. */
const CLASS_BLOCK_MEMBERS: Item[] = [...PARAMETERS, FIELD, LISTENER_KEYWORD];

/** The block of a service task handed to an external worker by topic. */
const TOPIC_BLOCK_MEMBERS: Item[] = [
  ...PARAMETERS,
  PROPERTY,
  LISTENER_KEYWORD,
  ERROR_MAPPING,
];

/** The three ways a listener binds; also the whole listener parens. */
const BINDINGS: Item[] = [
  ['class', SETTING, 'class: "${1:com.example.Delegate}"'],
  ['expression', SETTING, 'expression: "${1:\\${bean.method(execution)}}"'],
  ['delegate', SETTING, 'delegate: "${1:\\${beanName}}"'],
];

const TOPIC: Item = ['topic', SETTING, 'topic: "${1:topic-name}"'];
const TYPE: Item = ['type', SETTING, 'type: "${1|mail,shell|}"'];
const RESULT_VARIABLE: Item = [
  'resultVariable',
  SETTING,
  'resultVariable: "${1:result}"',
];
const BINDING: Item = ['binding', SETTING, 'binding: ${1|latest,deployment|}'];
const TASK_PRIORITY: Item = ['taskPriority', SETTING, 'taskPriority: ${1:50}'];
const VERSION: Item = ['version', SETTING, 'version: ${1:1}'];

const USER_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ['assignee', SETTING, 'assignee: "${1:user}"'],
  ['formKey', SETTING, 'formKey: "${1:form-key}"'],
  ['formRef', SETTING, 'formRef: "${1:form-id}"'],
  BINDING,
  VERSION,
  ['candidateGroups', SETTING, 'candidateGroups: "${1:group}"'],
  ['candidateUsers', SETTING, 'candidateUsers: "${1:user}"'],
  ['dueDate', SETTING, 'dueDate: "${1:\\${dateTime().plusDays(3)}}"'],
  ['followUpDate', SETTING, 'followUpDate: "${1:\\${dateTime().plusDays(1)}}"'],
  ['priority', SETTING, 'priority: ${1:50}'],
  ...ENGINE_SETTINGS,
];

const SERVICE_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ...BINDINGS,
  TOPIC,
  TYPE,
  RESULT_VARIABLE,
  TASK_PRIORITY,
  ...ENGINE_SETTINGS,
];

/** A repeated statement's parens offer the run keys after the engine ones. */
const REPEATED_SERVICE_PARENS: Item[] = [...SERVICE_PARENS, ...RUN_SETTINGS];

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
  ['mapper', SETTING, 'mapper: "${1:com.example.CallMapper}"'],
  ['mapperDelegate', SETTING, 'mapperDelegate: "${1:\\${callMapperBean}}"'],
  ...ENGINE_SETTINGS,
];

const RECEIVE_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ['message', SETTING, 'message: "${1:MessageName}"'],
  ...ENGINE_SETTINGS,
];

const DECIDE_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ...BINDINGS,
  TOPIC,
  TYPE,
  ['decision', SETTING, 'decision: "${1:decision-key}"'],
  BINDING,
  VERSION,
  [
    'mapDecisionResult',
    SETTING,
    'mapDecisionResult: ${1|singleEntry,singleResult,collectEntries,resultList|}',
  ],
  RESULT_VARIABLE,
  TASK_PRIORITY,
  ...ENGINE_SETTINGS,
];

const CODE_BINDING: Item = ['code', SETTING, 'code: ${1:code}'];

/** A handler catching an error binds what the event carries. */
const HANDLER_PARENS: Item[] = [
  CODE_BINDING,
  ['message', SETTING, 'message: ${1:message}'],
  ...ENGINE_SETTINGS,
];

const ALONGSIDE: Item = ['alongside', 'BPMNscript flag', 'alongside'];

/** An escalation carries no message, and its handler may run alongside the host. */
const ESCALATION_HANDLER_PARENS: Item[] = [
  CODE_BINDING,
  ...ENGINE_SETTINGS,
  ALONGSIDE,
];

/** A declaration's fields carry the event's text, so both are quoted. */
const DECLARATION_FIELDS: Item[] = [
  ['code', SETTING, 'code: "${1:code}"'],
  ['message', SETTING, 'message: "${1:message}"'],
];

const SETTING_VALUE = 'BPMNscript setting value';

/** The two built-in behaviours, quoted as the `type` setting reads them. */
const TYPE_VALUES: Item[] = [
  ['"mail"', SETTING_VALUE, '"mail"'],
  ['"shell"', SETTING_VALUE, '"shell"'],
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
];

const START_PARENS: Item[] = [
  LABEL,
  DOCUMENTATION,
  ['initiator', SETTING, 'initiator: "${1:starter}"'],
  ...ENGINE_SETTINGS,
];

const LISTENER_PARENS: Item[] = BINDINGS;

const listenerEvent = (event: string): Item => [
  event,
  LISTENER_EVENT,
  `${event}(class: "\${1:com.example.Listener}")`,
];

const EXECUTION_EVENTS: Item[] = [listenerEvent('start'), listenerEvent('end')];

const TASK_EVENTS: Item[] = [
  ...EXECUTION_EVENTS,
  listenerEvent('create'),
  listenerEvent('assignment'),
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
        ['link', "jump to the 'await link' of the same name", 'link'],
      ],
    ],
    [
      'the parens of a handler offer the bindings of the event it catches',
      'process p {\n  start S\n  on error(|) {\n    end Failed\n  }\n}',
      HANDLER_PARENS,
    ],
    [
      'an escalation handler offers the code binding and the flag after its code',
      'process p {\n  escalation X\n  start S\n  on escalation(X, |) {\n    end Failed\n  }\n}',
      ESCALATION_HANDLER_PARENS,
    ],
    [
      'the parens of a timer handler offer only the keys naming a date and a cycle until a time is written',
      'process p {\n  on timer(|) {\n    end Late\n  }\n}',
      TIMER_KEYS,
    ],
    [
      "an error declaration's parens offer its two fields, quoted",
      'process p {\n  error E(|)\n  user A\n}',
      DECLARATION_FIELDS,
    ],
    [
      "a service task's type slot offers the two built-in behaviours, quoted",
      'process p {\n  service S(type: |)\n}',
      TYPE_VALUES,
    ],
    [
      'the `await` trigger position offers only the triggers something can fire',
      'process p {\n  await |\n}',
      CATCH_TRIGGERS,
    ],
    [
      'a race branch header offers every await trigger but link',
      'process p {\n  await { |\n}',
      RACE_TRIGGERS,
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
      'a service task offers the binding settings, no run key, and none of the user-task ones',
      'process p {\n  service S(|)\n}',
      SERVICE_PARENS,
    ],
    // Revert: drop `isRepeated` from `settingFormsFor` and the unrepeated
    // service task above is offered the run keys.
    [
      'a repeated service task offers the run keys after the engine ones',
      'process p {\n  service S for 3(|)\n}',
      REPEATED_SERVICE_PARENS,
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
      'the parens of an if statement offer the split keys and the join keys',
      'process p {\n  var a: boolean\n  if (a) (|) {\n    user A\n  }\n}',
      SPLIT_AND_JOIN_PARENS,
    ],
    [
      'the parens of a while loop offer the bare keys alone',
      'process p {\n  var a: boolean\n  while (a) (|) {\n    user A\n  }\n}',
      LOOP_PARENS,
    ],
    [
      'the parens closing a do-while loop offer the bare keys alone',
      'process p {\n  var a: boolean\n  do {\n    user A\n  } while (a) (|)\n}',
      LOOP_PARENS,
    ],
    [
      'the parens of a parallel statement offer the fork keys and the join keys',
      'process p {\n  parallel (|) {\n    { user A }\n    { user B }\n  }\n}',
      SPLIT_AND_JOIN_PARENS,
    ],
    [
      'the parens of an await block offer the gateway keys, asyncAfter left out, and the join keys',
      'process p {\n  await (|) {\n    message("M") { user A }\n    signal("S") { user B }\n  }\n}',
      AWAIT_PARENS,
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
      'a class-bound service block offers `field` alongside the two io directions',
      'process p {\n  service S(class: "com.example.D") {\n    |\n  }\n}',
      CLASS_BLOCK_MEMBERS,
    ],
    [
      'a topic-bound service block offers its whole member set after a property line',
      'process p {\n  service S(topic: "t") {\n    property k = "v"\n    |\n  }\n}',
      TOPIC_BLOCK_MEMBERS,
    ],
    // The same brace opens the body, and a member written there belongs to
    // nothing, so the body position offers the statements alone.
    [
      'a subprocess body offers the statements and no member',
      'process p {\n  subprocess S {\n    |\n  }\n}',
      STATEMENTS,
    ],
    [
      'an attempt body offers the statements and no member',
      'process p {\n  attempt A {\n    |\n  }\n}',
      STATEMENTS,
    ],
    [
      'a subprocess body offers the statements alone after a step too',
      'process p {\n  subprocess S {\n    user A\n    |\n  }\n}',
      [...REPEAT_FORMS, ...STATEMENTS],
    ],
    [
      'a branch body offers the statements',
      'process p {\n  var a: boolean\n  if (a) {\n    |\n  }\n}',
      STATEMENTS,
    ],
    [
      'an unclosed user block still offers the task listener events',
      'process p {\n  user T {\n    on |',
      TASK_EVENTS,
    ],
    [
      "a listener's block holds an injected field and nothing else",
      'process p {\n  user T {\n    on create(class: "com.example.L") {\n      |\n    }\n  }\n}',
      [FIELD],
    ],
    // The engine refuses a mapping on an event sub-process and a boundary
    // event carries none, so neither handler form offers a parameter.
    [
      'a host-less handler block offers no parameter',
      'process p {\n  start S\n  on error {\n    |\n  } {\n    end Failed\n  }\n}',
      STATEMENTS,
    ],
    [
      'a hosted handler block offers no parameter either',
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
      "a mapping's code slot offers the declared errors and nothing else",
      'process p {\n  error PAYMENT_DECLINED(message: "x")\n  escalation PAYMENT_REVIEW\n  service S(topic: "t") {\n    error PAY| when "${x}"\n  }\n}',
      [
        [
          'PAYMENT_DECLINED',
          'CodeDecl',
          'PAYMENT_DECLINED',
          CompletionItemKind.Reference,
        ],
      ],
    ],
    // With nothing after the head word the mapping does not parse, so the
    // slot is told by the word alone.
    [
      "a mapping's code slot offers the declared errors before the rest of the line is written",
      'process p {\n  error PAYMENT_DECLINED(message: "x")\n  escalation PAYMENT_REVIEW\n  service S(topic: "t") {\n    error |\n  }\n}',
      [
        [
          'PAYMENT_DECLINED',
          'CodeDecl',
          'PAYMENT_DECLINED',
          CompletionItemKind.Reference,
        ],
      ],
    ],
    // The caret's own node is the preceding member here, not the service
    // task, so the owner has to be climbed rather than read off directly.
    [
      "a mapping's code slot offers the declared errors after a preceding member too",
      'process p {\n  error PAYMENT_DECLINED(message: "x")\n  escalation PAYMENT_REVIEW\n  service S(topic: "t") {\n    property k = "v"\n    error |\n  }\n}',
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
      'a class-bound service block offers no code at the head word, since it maps nothing',
      'process p {\n  error PAYMENT_DECLINED(message: "x")\n  service S(class: "c") {\n    error |\n  }\n}',
      [],
    ],
    // A bare variable is the prefix of the expression the author goes on to
    // write, so these rows pin the offer and not its validity; the two
    // variable items sort ahead of the literal words in the editor.
    [
      'a condition offers the declared variables beside the literal words',
      `process p {\n  ${VARS}\n  if (|) {\n    user A\n  }\n}`,
      [...LITERALS, ...VARIABLES],
    ],
    [
      'a typed prefix narrows the offer to the variables matching it',
      `process p {\n  ${VARS}\n  if (am|) {\n    user A\n  }\n}`,
      [VARIABLES[0]!],
    ],
    // The parameter's own name is a variable too, seeded after the declared ones.
    [
      "an io parameter's value offers the variables",
      `process p {\n  ${VARS}\n  user T {\n    input total = |\n  }\n}`,
      [
        ...LITERALS,
        ...VARIABLES,
        ['total', 'any', 'total', CompletionItemKind.Variable],
      ],
    ],
    [
      "a condition handler's open payload offers the variables",
      `process p {\n  ${VARS}\n  start S\n  on condition(|) {\n    end E\n  }\n}`,
      [LITERALS[0]!, LITERALS[1]!, ...VARIABLES],
    ],
    [
      'a number setting offers the variables alone',
      `process p {\n  ${VARS}\n  user T(jobPriority: |)\n}`,
      VARIABLES,
    ],
    [
      'a repeat clause offers the variables as its collection',
      `process p {\n  ${VARS}\n  user T for each item in |\n}`,
      [...LITERALS, ...VARIABLES],
    ],
    [
      "a call's in mapping offers the variables as its source",
      `process p {\n  ${VARS}\n  call C(process: "q") {\n    in x = |\n  }\n}`,
      [...LITERALS, ...VARIABLES],
    ],
    // An out mapping's source is read in the called process, whose variables
    // this one does not know.
    [
      "a call's out mapping offers no variable",
      `process p {\n  ${VARS}\n  call C(process: "q") {\n    out x = |\n  }\n}`,
      LITERALS,
    ],
    [
      'a message name slot offers no variable',
      `process p {\n  ${VARS}\n  user A\n  throw message(|)\n}`,
      [],
    ],
    [
      'a map key inside a parameter value is left to the default completion',
      'process p {\n  user T {\n    input x = {\n      |\n    }\n  }\n}',
      [],
    ],
    [
      "a form field's parens offer its settings after a preceding one",
      'process p {\n  start S {\n    form {\n      amount: number (required: true, |)\n    }\n  }\n}',
      FORM_FIELD_PARENS,
    ],
    [
      "a form field's block offers the property direction after a value line",
      'process p {\n  start S {\n    form {\n      plan: enum {\n        basic "Basic"\n        |\n      }\n    }\n  }\n}',
      [PROPERTY],
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
  'type',
  'decision',
  'process',
]);

const binds = ([label]: Item) => REQUIRED_BINDINGS.has(label);

/** A built-in behaviour needs its fields, so its host writes the mail ones. */
const bindsBuiltin = ([label]: Item) => label === 'type';

/**
 * A form reference and the binding pinning its version are legal only
 * together, so each half is checked in a host writing the other one.
 */
const FORM_REFERENCE_MODIFIERS = new Set(['binding', 'version']);

const pinsAForm = ([label]: Item) => FORM_REFERENCE_MODIFIERS.has(label);
const namesAForm = ([label]: Item) => label === 'formRef';

/** The settings a decision step carries only beside `decision`, so their host binds one. */
const DECISION_MODIFIERS = new Set(['binding', 'version', 'mapDecisionResult']);

const pinsADecision = ([label]: Item) => DECISION_MODIFIERS.has(label);

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
      USER_PARENS.filter((item) => !pinsAForm(item) && !namesAForm(item)),
      (setting) => `process p {\n  user T(${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a user task',
      USER_PARENS.filter(pinsAForm),
      (setting) => `process p {\n  user T(formRef: "f", ${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a user task',
      USER_PARENS.filter(namesAForm),
      (setting) => `process p {\n  user T(${setting}, binding: latest)\n}`,
    ),
    // `taskPriority` rides a `topic` binding alone, so the host binds one.
    ...scaffolds(
      'the parens of a service task',
      SERVICE_PARENS.filter((item) => !binds(item)),
      (setting) => `process p {\n  service S(topic: "t", ${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a service task',
      SERVICE_PARENS.filter((item) => binds(item) && !bindsBuiltin(item)),
      (binding) => `process p {\n  service S(${binding})\n}`,
    ),
    ...scaffolds(
      'the parens of a service task',
      SERVICE_PARENS.filter(bindsBuiltin),
      (binding) =>
        `process p {\n  service S(${binding}) {\n    field to = "a@b"\n    field text = "t"\n  }\n}`,
    ),
    ...scaffolds(
      'the parens of a repeated service task',
      RUN_SETTINGS,
      (setting) => `process p {\n  service S for 3(topic: "t", ${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a decision step',
      DECIDE_PARENS.filter((item) => !binds(item) && !pinsADecision(item)),
      (setting) => `process p {\n  decide D(topic: "t", ${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a decision step',
      DECIDE_PARENS.filter(pinsADecision),
      (setting) => `process p {\n  decide D(decision: "d", ${setting})\n}`,
    ),
    ...scaffolds(
      'the parens of a decision step',
      DECIDE_PARENS.filter((item) => binds(item) && !bindsBuiltin(item)),
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
      'a service block',
      [FIELD],
      (member) =>
        `process p {\n  service S(class: "com.example.D") {\n${member}\n  }\n}`,
    ),
    // The code is declared in the header, where the mapping's scaffold resolves it.
    ...scaffolds(
      'a topic-bound service block',
      [PROPERTY, ERROR_MAPPING],
      (member) =>
        `process p {\n  error CODE(message: "m")\n  service S(topic: "t") {\n${member}\n  }\n}`,
    ),
    ...scaffolds(
      "a listener's block",
      [FIELD],
      (member) =>
        `process p {\n  user T {\n    on create(class: "com.example.L") {\n${member}\n    }\n  }\n}`,
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
    // Each setting lands on a field of the one type it fits.
    ...FORM_FIELD_PARENS.map(
      ([label]) =>
        [
          `\`${label}\` in the parens of a form field`,
          label,
          (setting: string) =>
            `process p {\n  start S {\n    form {\n      f: ${fieldTypeTaking(label)} (${setting})\n    }\n  }\n}`,
        ] as const,
    ),
    ...scaffolds(
      "a form field's block",
      [PROPERTY],
      (member) =>
        `process p {\n  start S {\n    form {\n      plan: enum {\n        basic "Basic"\n${member}\n      }\n    }\n  }\n}`,
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
    async (kind, description, _members, settings) => {
      const rule = RULE_BY_DESCRIPTION.get(description)!;
      const { text, line, character } = caretInSlot(
        settings,
        'asyncBefore: true, ',
      );
      // The fixture emits a signal, which carries no implementation binding.
      expect(await labelsAt(text, line, character)).toEqual([
        ...(kind === 'emit' ? [] : rule.own),
        ...ENGINE_KEYS,
        ...rule.flags,
      ]);
    },
  );
});

const labels = (items: readonly Item[]): string[] =>
  items.map(([label]) => label);

/**
 * The keywords whose grammar rule continues with a mandatory token: each is a
 * prefix rather than an offer, so it cannot parse alone.
 */
const PREFIX_WORDS: ReadonlySet<string> = new Set(['goto', 'form']);

/**
 * A row is a program with one slot, so the caret and the spliced item come
 * from the same text. A parse error is forgiven for a bare {@link PREFIX_WORDS}
 * item and no other. A bare event word is spliced with the name its rule
 * requires. Warnings are the editor doing its job on an example value and do
 * not count; an error does, and one row reports every refused item with the
 * sentence the validator answered.
 */
describe('offered is a subset of accepted', () => {
  test.each<readonly [string, (inserted: string) => string, string[]]>([
    [
      'a thrown error takes engine settings and no implementation binding',
      (x) =>
        `process p {\n  error E(message: "m")\n  user A\n  throw error(E, ${x})\n}`,
      [...ENGINE_KEYS],
    ],
    [
      'a thrown escalation takes engine settings and no implementation binding',
      (x) =>
        `process p {\n  escalation E\n  user A\n  throw escalation(E, ${x})\n}`,
      [...ENGINE_KEYS],
    ],
    [
      'a thrown message keeps its bindings',
      (x) => `process p {\n  user A\n  throw message("M", ${x})\n}`,
      [...labels(BINDINGS), TOPIC[0], ...ENGINE_KEYS],
    ],
    [
      'an emitted signal takes engine settings alone',
      (x) => `process p {\n  user A\n  emit signal("S", ${x})\n}`,
      [...ENGINE_KEYS],
    ],
    [
      'an error handler binds both fields after its code',
      (x) =>
        `process p {\n  error X(message: "m")\n  start S\n  on error(X, ${x}) {\n    end Failed\n  }\n}`,
      labels(HANDLER_PARENS),
    ],
    [
      'an escalation handler binds the code alone and may run alongside',
      (x) =>
        `process p {\n  escalation X\n  start S\n  on escalation(X, ${x}) {\n    end Failed\n  }\n}`,
      labels(ESCALATION_HANDLER_PARENS),
    ],
    [
      'a hosted message handler takes the flag after its name',
      (x) =>
        `process p {\n  user U\n  on U: message("M", ${x}) {\n    end Failed\n  }\n}`,
      [...ENGINE_KEYS, ALONGSIDE[0]],
    ],
    [
      'a catch-all error handler offers its bindings at the first slot',
      (x) =>
        `process p {\n  start S\n  on error(${x}) {\n    end Failed\n  }\n}`,
      labels(HANDLER_PARENS),
    ],
    [
      'a timer handler offers only the clause keys until a time is written',
      (x) => `process p {\n  start S\n  on timer(${x}) {\n    end Late\n  }\n}`,
      labels(TIMER_KEYS),
    ],
    [
      'a timer handler offers settings and the flag after its duration',
      (x) =>
        `process p {\n  start S\n  on timer("PT1H", ${x}) {\n    end Late\n  }\n}`,
      [...ENGINE_KEYS, ALONGSIDE[0]],
    ],
    [
      'a condition handler offers the boolean words at its open payload',
      (x) =>
        `process p {\n  start S\n  on condition(${x}) {\n    end E\n  }\n}`,
      ['true', 'false'],
    ],
    [
      'a condition handler offers settings and the flag after its condition',
      (x) =>
        `process p {\n  var x: number\n  start S\n  on condition(x > 1, ${x}) {\n    end E\n  }\n}`,
      [...ENGINE_KEYS, ALONGSIDE[0]],
    ],
    [
      'a message handler offers nothing before its name is written',
      (x) => `process p {\n  start S\n  on message(${x}) {\n    end E\n  }\n}`,
      [],
    ],
    [
      'a thrown error offers only its declared codes before the code is written',
      (x) =>
        `process p {\n  error E(message: "m")\n  user A\n  throw error(${x})\n}`,
      ['E'],
    ],
    [
      'an error declaration takes its two fields, quoted',
      (x) => `process p {\n  error E(${x})\n  user A\n}`,
      labels(DECLARATION_FIELDS),
    ],
    [
      'an escalation declaration takes the code alone',
      (x) => `process p {\n  escalation E(${x})\n  user A\n}`,
      [DECLARATION_FIELDS[0]![0]],
    ],
    [
      'a form field offers the five form types and no variable type',
      (x) =>
        `process p {\n  start S {\n    form {\n      f: ${x}\n    }\n  }\n}`,
      [...FORM_FIELD_TYPES],
    ],
    [
      "a receive task's parens offer settings and no literal word",
      (x) => `process p {\n  receive R(${x})\n}`,
      labels(RECEIVE_PARENS),
    ],
    [
      "a gateway head's parens offer settings and no literal word",
      (x) =>
        `process p {\n  var a: boolean\n  if (a) (${x}) {\n    user A\n  }\n}`,
      labels(SPLIT_AND_JOIN_PARENS),
    ],
    [
      'a version pin on a user task offers its two words',
      (x) => `process p {\n  user T(formRef: "f", binding: ${x})\n}`,
      [...CALL_BINDING_VALUES],
    ],
    [
      'a version pin on a call offers its two words',
      (x) => `process p {\n  call C(process: "q", binding: ${x})\n}`,
      [...CALL_BINDING_VALUES],
    ],
    [
      'a decision result mapping offers its four words',
      (x) =>
        `process p {\n  decide D(decision: "d", mapDecisionResult: ${x})\n}`,
      [...DECISION_RESULT_MAPPINGS],
    ],
    [
      'a boolean setting offers true and false',
      (x) => `process p {\n  user T(asyncBefore: ${x})\n}`,
      ['true', 'false'],
    ],
    [
      'a text setting offers no literal word and no variable',
      (x) => `process p {\n  ${VARS}\n  user T(label: ${x})\n}`,
      [],
    ],
    [
      'a class-bound service block takes an injected field and no property',
      (x) => `process p {\n  service S(class: "c") {\n    ${x}\n  }\n}`,
      labels(CLASS_BLOCK_MEMBERS),
    ],
    [
      'a topic-bound service block takes a property and a mapping and no field',
      (x) =>
        `process p {\n  error CODE(message: "m")\n  service S(topic: "t") {\n    ${x}\n  }\n}`,
      labels(TOPIC_BLOCK_MEMBERS),
    ],
    [
      'an expression-bound service block takes neither',
      (x) =>
        `process p {\n  service S(expression: "\${e}") {\n    ${x}\n  }\n}`,
      [...labels(PARAMETERS), LISTENER_KEYWORD[0]],
    ],
    [
      'a user block takes a form and no field',
      (x) => `process p {\n  user T {\n    ${x}\n  }\n}`,
      labels(BLOCK_MEMBERS),
    ],
    [
      'a host-less handler at process level catches neither a cancel nor a compensation',
      (x) => `process p {\n  start S\n  on ${x} {\n    end Failed\n  }\n}`,
      labels(ON_TRIGGERS),
    ],
    [
      'a host-less handler in a subprocess body catches a compensation too',
      (x) =>
        `process p {\n  start S\n  subprocess Sub {\n    start Inner\n    on ${x} {\n      end Failed\n    }\n  }\n}`,
      [...labels(ON_TRIGGERS), 'compensation'],
    ],
    // A host alone is the prefix of `on Host: trigger`, so the row completes it.
    [
      'a host-less handler in a subprocess body offers the hosts of that body and none outside it',
      (x) =>
        `process p {\n  user Outside\n  subprocess Sub {\n    user Inside\n    on ${x === 'Inside' ? 'Inside: timer("PT1H")' : x} {\n      end Failed\n    }\n  }\n}`,
      ['Inside', ...labels(ON_TRIGGERS), 'compensation'],
    ],
    [
      'a partly typed host word inside a subprocess body still offers the hosts of that body',
      (x) =>
        `process p {\n  subprocess Sub {\n    user Inside\n    on ${x === '|' ? 'Ins|' : `${x}: timer("PT1H") {\n      end Failed\n    }`}\n  }\n}`,
      ['Inside'],
    ],
    [
      'a handler on a user task catches the boundary words and no cancel',
      (x) => `process p {\n  user U\n  on U: ${x} {\n    end Failed\n  }\n}`,
      labels(ON_TRIGGERS),
    ],
    [
      'a handler on an attempt block catches a cancel too',
      (x) =>
        `process p {\n  attempt A {\n    user B\n  }\n  on A: ${x} {\n    end Failed\n  }\n}`,
      [...labels(ON_TRIGGERS), 'cancel'],
    ],
    [
      'a handler on a service task catches no escalation',
      (x) =>
        `process p {\n  service U(class: "c")\n  on U: ${x} {\n    end Failed\n  }\n}`,
      labels(ON_TRIGGERS).filter((word) => word !== 'escalation'),
    ],
  ])('%s', async (_title, program, expectedLabels) => {
    const { text, line, character } = caretAt(program('|'));
    const items = await completionItems(text, line, character);
    expect(items.map((i) => i.label)).toEqual(expectedLabels);
    const refused: Array<[label: string, messages: string[]]> = [];
    for (const item of items) {
      const bare = accepted(item, typedInto) === item.label;
      const inserted =
        bare && TRIGGER_PAYLOAD[item.label]?.code === 'required'
          ? `${item.label}("N")`
          : accepted(item, typedInto);
      if (inserted.includes('undefined')) {
        refused.push([item.label, [`inserts '${inserted}'`]]);
        continue;
      }
      const source = program(inserted);
      const parse = await parseErrors(source);
      const prefix = bare && PREFIX_WORDS.has(item.label);
      if (parse.length > 0) {
        if (!prefix) refused.push([item.label, parse]);
        continue;
      }
      const errors = await validationErrors(source);
      if (errors.length > 0) refused.push([item.label, errors]);
    }
    expect(refused).toEqual([]);
  });
});
