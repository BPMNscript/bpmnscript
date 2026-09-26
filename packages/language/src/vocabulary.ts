/**
 * The words BPMNscript accepts and where each is legal; the grammar takes any
 * word, the validator and the completion read these tables in list order.
 */

import type { AstNode, Grammar } from 'langium';
import { AstUtils, GrammarAST, GrammarUtils } from 'langium';
import { isSubProcess } from './generated/ast.js';
import { BpmnScriptGrammar } from './generated/grammar.js';
import type {
  BusinessRuleTask,
  CallActivity,
  EmitStatement,
  EndEvent,
  GenericTask,
  IntermediateCatchEvent,
  OnHandler,
  RaceBranch,
  ReceiveTask,
  ScriptTask,
  SendTask,
  ServiceTask,
  StartEvent,
  SubProcess,
  ThrowStatement,
  UserTask,
  VarType,
} from './generated/ast.js';

const RESERVED_WORDS_BY_GRAMMAR = new WeakMap<Grammar, ReadonlySet<string>>();

/** Keyword token types are named after their text; operators are left out. */
export function reservedWordsOf(grammar: Grammar): ReadonlySet<string> {
  let words = RESERVED_WORDS_BY_GRAMMAR.get(grammar);
  if (!words) {
    const found = new Set<string>();
    for (const node of AstUtils.streamAllContents(grammar)) {
      if (GrammarAST.isKeyword(node) && /^[A-Za-z_]/.test(node.value)) {
        found.add(node.value);
      }
    }
    words = found;
    RESERVED_WORDS_BY_GRAMMAR.set(grammar, words);
  }
  return words;
}

export function formatPlainWordList(
  words: readonly string[],
  conjunction: 'or' | 'and' = 'or',
): string {
  if (words.length === 1) return words[0]!;
  if (words.length === 2) return `${words[0]} ${conjunction} ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, ${conjunction} ${words[words.length - 1]}`;
}

export function formatWordList(words: readonly string[]): string {
  return formatPlainWordList(words.map((w) => `'${w}'`));
}

/** The flags that create a continuation job. */
export const ASYNC_FLAG_KEYS = ['asyncBefore', 'asyncAfter'] as const;

/**
 * Settings that configure a job something else declares; a timer job takes
 * them off the element declaring the timer (`BpmnParse.parseTimer`).
 */
export const TIMER_JOB_KEYS = [
  'exclusive',
  'jobPriority',
  'retryCycle',
] as const;
export type TimerJobKey = (typeof TIMER_JOB_KEYS)[number];

export type EngineKey = (typeof ASYNC_FLAG_KEYS)[number] | TimerJobKey;

/** Read with a case-sensitive `"true"` comparison; any other text deploys as off. */
export const BOOLEAN_ENGINE_KEYS: readonly EngineKey[] = [
  ...ASYNC_FLAG_KEYS,
  'exclusive',
];

/** Operaton reads these off any flow node, gateways included. */
export const ENGINE_KEYS: readonly EngineKey[] = [
  ...ASYNC_FLAG_KEYS,
  ...TIMER_JOB_KEYS,
];

/** Set by `MultiInstanceActivityBehavior`, so in scope undeclared wherever something repeats. */
export const LOOP_VARIABLES = [
  'nrOfInstances',
  'nrOfActiveInstances',
  'nrOfCompletedInstances',
  'loopCounter',
] as const;

function prefixedSettingKey(prefix: string, key: string): string {
  return prefix + key.charAt(0).toUpperCase() + key.slice(1);
}

export function joinSettingKey(key: string): string {
  return prefixedSettingKey('join', key);
}

export const JOIN_KEY_BY_ENGINE_KEY: Readonly<Record<string, string>> =
  Object.fromEntries(ENGINE_KEYS.map((key) => [key, joinSettingKey(key)]));

export const JOIN_ENGINE_KEYS: readonly string[] = Object.values(
  JOIN_KEY_BY_ENGINE_KEY,
);

export function runSettingKey(key: string): string {
  return prefixedSettingKey('run', key);
}

export const engineSpellings = (key: string): string[] => [
  key,
  joinSettingKey(key),
  runSettingKey(key),
];

export const BOOLEAN_SETTING_KEYS: ReadonlySet<string> = new Set(
  BOOLEAN_ENGINE_KEYS.flatMap(engineSpellings),
);

/**
 * Written on `multiInstanceLoopCharacteristics` and read onto each run. No
 * `runJobPriority`: the multi-instance body is the scope, so plain `jobPriority`
 * already prices each run.
 */
export const RUN_ENGINE_KEYS: readonly string[] = ENGINE_KEYS.filter(
  (key) => key !== 'jobPriority',
).map((key) => runSettingKey(key));

/** `parseServiceTaskLike` dispatches on this before any code attribute. */
export const TYPE_BINDING_KEY = 'type';

export const EXTERNAL_BINDING_KEY = 'topic';

/**
 * Exactly one binds a service task. A business rule task without a decision
 * reaches the same `parseServiceTaskLike`, hence {@link BUSINESS_RULE_BINDING_KEYS}.
 */
export const SERVICE_TASK_BINDING_KEYS: readonly string[] = [
  'class',
  'expression',
  'delegate',
  EXTERNAL_BINDING_KEY,
  TYPE_BINDING_KEY,
];

/** A thrown message has no member block for the fields a built-in `type` requires. */
export const THROW_BINDING_KEYS: readonly string[] =
  SERVICE_TASK_BINDING_KEYS.filter((key) => key !== TYPE_BINDING_KEY);

export const THROW_BINDING_TRIGGER = 'message';

export const TYPE_BINDING_VALUES = ['mail', 'shell'] as const;

export type BuiltinTaskType = (typeof TYPE_BINDING_VALUES)[number];

/** In declaration order; `ClassDelegateUtil.applyFieldDeclaration` throws on any other name. */
export const BUILTIN_FIELD_NAMES: Readonly<
  Record<BuiltinTaskType, readonly string[]>
> = {
  mail: ['to', 'from', 'cc', 'bcc', 'subject', 'text', 'html', 'charset'],
  shell: [
    'command',
    'wait',
    'arg1',
    'arg2',
    'arg3',
    'arg4',
    'arg5',
    'outputVariable',
    'errorCodeVariable',
    'redirectError',
    'cleanEnv',
    'directory',
  ],
};

export interface RequiredFieldGroup {
  readonly names: readonly string[];
  readonly error: string;
}

/** In the order {@link BUILTIN_FIELD_VALIDATOR} checks them; `cc`/`bcc` satisfy neither mail group. */
export const BUILTIN_REQUIRED_FIELDS: Readonly<
  Record<BuiltinTaskType, readonly RequiredFieldGroup[]>
> = {
  mail: [
    { names: ['to'], error: 'No recipient is defined on the mail activity' },
    { names: ['text', 'html'], error: 'Text or html field should be provided' },
  ],
  shell: [
    {
      names: ['command'],
      error: 'No shell command is defined on the shell activity',
    },
  ],
};

export const BUILTIN_FIELD_VALIDATOR: Readonly<
  Record<BuiltinTaskType, string>
> = {
  mail: 'validateFieldDeclarationsForEmail',
  shell: 'validateFieldDeclarationsForShell',
};

/**
 * Parsing accepts `true`/`false` in any case, but `ShellActivityBehavior`
 * compares with `"true".equals`, so `"True"` deploys and runs as `false`.
 */
export const SHELL_FLAG_FIELDS: readonly string[] = [
  'wait',
  'redirectError',
  'cleanEnv',
];

export const SHELL_FLAG_LITERALS: readonly string[] = ['true', 'false'];

/** One is required; `decision` wins when both are written. */
export const BUSINESS_RULE_BINDING_KEYS: readonly string[] = [
  ...SERVICE_TASK_BINDING_KEYS,
  'decision',
];

export const DECISION_MODIFIER_KEYS: readonly string[] = [
  'binding',
  'version',
  'mapDecisionResult',
];

export const DECISION_RESULT_MAPPINGS = [
  'singleEntry',
  'singleResult',
  'collectEntries',
  'resultList',
] as const;

/** A fenced script body binds a listener too. */
export const LISTENER_BINDING_KEYS: readonly string[] =
  SERVICE_TASK_BINDING_KEYS.filter(
    (key) => key !== EXTERNAL_BINDING_KEY && key !== TYPE_BINDING_KEY,
  );

/**
 * The bindings Operaton injects a field list into; an `expression`, a `topic`
 * and a `decision` take none.
 */
export const FIELD_BINDING_KEYS: readonly string[] = [
  'class',
  'delegate',
  TYPE_BINDING_KEY,
];

/** Not spelled `class`/`delegate`: Operaton hands a call mapper no field list. */
export const CALL_MAPPER_KEY_BY_KIND = {
  class: 'mapper',
  delegateExpression: 'mapperDelegate',
} as const;

export const CALL_BINDING_VALUES = ['latest', 'deployment'] as const;

export type CallBindingValue = (typeof CALL_BINDING_VALUES)[number];

const LABEL_KEYS = ['label', 'documentation'] as const;

export const PROCESS_ENGINE_HEADER_KEYS = [
  'versionTag',
  'historyTimeToLive',
  'candidateStarterUsers',
  'candidateStarterGroups',
] as const;

/**
 * In offer and print order. The `jobPriority`, `taskPriority`,
 * `isStartableInTasklist`, listeners and `potentialStarter` Operaton also reads
 * off a process are left out on purpose.
 */
export const PROCESS_HEADER_KEYS: readonly string[] = [
  ...LABEL_KEYS,
  ...PROCESS_ENGINE_HEADER_KEYS,
];

export const INPUT_DIRECTION = 'input';
export const OUTPUT_DIRECTION = 'output';

export const IO_DIRECTIONS: readonly string[] = [
  INPUT_DIRECTION,
  OUTPUT_DIRECTION,
];

/** Written verbatim as the `operaton:` attribute of the same name, in print order. */
export const USER_TASK_VERBATIM_KEYS = [
  'assignee',
  'formKey',
  'candidateGroups',
  'candidateUsers',
  'dueDate',
  'followUpDate',
  'priority',
] as const;

/** Set once on the bound implementation; reads and writes no process variable. */
export const FIELD_DIRECTION = 'field';

/**
 * Written to `operaton:properties` as text, declaring no variable; Tasklist
 * reads a form field's, the worker an external task's.
 */
export const PROPERTY_DIRECTION = 'property';

/** Read on an external service task alone; an integer or an expression. */
export const TASK_PRIORITY_KEY = 'taskPriority';

/**
 * Resolves to the external task entity only where a mapping's condition runs
 * (`ExternalTaskEntity.evaluateThrowBpmnError`), so it is legal there alone.
 */
export const EXTERNAL_TASK_EL_NAME = 'externalTask';

export const ERROR_MAPPING_HEAD = 'error';
export const ERROR_MAPPING_WHEN = 'when';

export type TimerKind = 'duration' | 'date' | 'cycle';

/** Keyed by the timer definition each selects (`timeDuration`, `timeDate`, `timeCycle`). */
export const TIMER_PARTICLE_BY_KIND = {
  duration: 'after',
  date: 'at',
  cycle: 'every',
} as const satisfies Record<TimerKind, string>;

export type TimerParticle = (typeof TIMER_PARTICLE_BY_KIND)[TimerKind];

export const TIMER_PARTICLES: readonly TimerParticle[] = Object.values(
  TIMER_PARTICLE_BY_KIND,
);

export const EVENT_CODE_FIELD = 'code';
export const EVENT_MESSAGE_FIELD = 'message';

export const EVENT_BINDING_FIELDS: readonly string[] = [
  EVENT_CODE_FIELD,
  EVENT_MESSAGE_FIELD,
];

export const EVENT_BINDING_FIELD_SET: ReadonlySet<string> = new Set(
  EVENT_BINDING_FIELDS,
);

export function eventBindingFieldsFor(trigger: string): readonly string[] {
  return EVENT_BINDING_FIELDS.filter(
    (field) =>
      field !== EVENT_MESSAGE_FIELD || TRIGGER_PAYLOAD[trigger]?.message,
  );
}

export const EXECUTION_LISTENER_EVENTS = ['start', 'end'] as const;

/** User tasks alone, spelled as `BpmnParse.parseTaskListeners` accepts them. */
export const TASK_LISTENER_EVENTS = [
  'create',
  'assignment',
  'complete',
  'update',
  'delete',
  'timeout',
] as const;

/** In completion order; the keys keep the list in step with the grammar's `VarType`. */
export const VAR_TYPES = Object.keys({
  string: true,
  number: true,
  boolean: true,
  date: true,
  json: true,
  any: true,
} satisfies Record<VarType, true>) as VarType[];

/**
 * `number` exports as Operaton's `long`; `json`/`any` have no form field type.
 * `enum` is no `var` type, so the grammar admits any word and the validator
 * holds it to this list.
 */
export const FORM_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'enum',
] as const;

/** An `enum` stores the chosen id as a string (`EnumFormType.convertValue`). */
export function formFieldVariableType(type: string): VarType | undefined {
  const found = FORM_FIELD_TYPES.find((t) => t === type);
  return found === 'enum' ? 'string' : found;
}

/**
 * The first six are Operaton's registered validators; `validator` takes a
 * class name or an expression, and any other name fails the deployment.
 */
export const FORM_CONSTRAINT_NAMES = [
  'required',
  'readonly',
  'min',
  'max',
  'minlength',
  'maxlength',
  'validator',
] as const;

export function isFormConstraintName(
  name: string,
): name is (typeof FORM_CONSTRAINT_NAMES)[number] {
  return (FORM_CONSTRAINT_NAMES as readonly string[]).includes(name);
}

/** The bounds throw on a submitted value of another type; the rest ignore the type. */
export const FORM_CONSTRAINT_TYPES: Readonly<
  Record<string, readonly (typeof FORM_FIELD_TYPES)[number][]>
> = {
  required: FORM_FIELD_TYPES,
  readonly: FORM_FIELD_TYPES,
  min: ['number'],
  max: ['number'],
  minlength: ['string'],
  maxlength: ['string'],
  validator: FORM_FIELD_TYPES,
} satisfies Record<
  (typeof FORM_CONSTRAINT_NAMES)[number],
  readonly (typeof FORM_FIELD_TYPES)[number][]
>;

/**
 * Parsed with `Long.parseLong`/`Integer.parseInt`, never as an expression; a
 * decimal bound deploys and then fails every submission.
 */
export const FORM_BOUND_TEXT = /^-?\d+$/;

export const ID_TERMINAL: RegExp = GrammarUtils.terminalRegex(
  BpmnScriptGrammar().rules.find(
    (rule): rule is GrammarAST.TerminalRule =>
      GrammarAST.isTerminalRule(rule) && rule.name === 'ID',
  )!,
);

export const ID_TEXT = new RegExp(`^${ID_TERMINAL.source}$`, ID_TERMINAL.flags);

/**
 * `StringUtil.isExpression`: an opening at the start only. An opening further
 * in is a constant, which `BpmnParse.parsePriority` refuses.
 */
export const EXPRESSION_OPEN = /^\s*[$#]\{/;

/** JUEL evaluates a composite such as `a-${b}`, so an opening anywhere counts. */
export const EXPRESSION_ANYWHERE = /[$#]\{/;

/**
 * JUEL operator words besides the literals; a variable of one of these names
 * renders as `${mod > 1}`, which JUEL refuses at deployment.
 */
export const JUEL_RESERVED_WORDS = [
  'empty',
  'div',
  'mod',
  'not',
  'and',
  'or',
  'le',
  'lt',
  'eq',
  'ne',
  'ge',
  'gt',
  'instanceof',
] as const;

/** Keyword tokens to JUEL, so `${order.true}` fails to parse. */
export const JUEL_LITERAL_WORDS = ['true', 'false', 'null'] as const;

/** Written to `datePattern`, read on a `date` field alone; a type parameter, not a constraint. */
export const DATE_PATTERN_KEY = 'pattern';

export const FORM_FIELD_SETTING_KEYS: readonly string[] = [
  ...FORM_CONSTRAINT_NAMES,
  DATE_PATTERN_KEY,
];

/** Soft words: an unknown one is a validator diagnostic, not a parse error. */
export const ON_TRIGGERS = [
  'error',
  'escalation',
  'message',
  'signal',
  'timer',
  'condition',
  'compensation',
  'cancel',
] as const;

/** A timer or condition has nothing to throw; a cancel is written on an `end`. */
export const THROW_TRIGGERS = [
  'error',
  'escalation',
  'message',
  'signal',
  'compensation',
] as const;

/** An error always ends its path; a link throw is intermediate, so `throw` has no link. */
export const EMIT_TRIGGERS = [
  'escalation',
  'message',
  'signal',
  'compensation',
  'link',
] as const;

/** No `link`: Operaton refuses a link catch behind an event-based gateway. */
export const RACE_TRIGGERS = [
  'message',
  'timer',
  'signal',
  'condition',
] as const;

/** Error, escalation, compensation and cancel are caught by an `on` handler alone. */
export const CATCH_TRIGGERS = [...RACE_TRIGGERS, 'link'] as const;

/**
 * The process-level start parser inspects only timer, message, signal and
 * conditional definitions; any other would start as if none were written.
 */
export const START_TRIGGERS = [
  'message',
  'signal',
  'timer',
  'condition',
] as const;

export const END_TRIGGERS = ['terminate', 'cancel'] as const;

export interface TriggerPayloadRule {
  readonly code: 'required' | 'optional' | 'forbidden';
  readonly timer: boolean;
  readonly parens: 'bindings' | 'condition' | 'forbidden';
  /** Whether the event carries a message text beside its code. */
  readonly message: boolean;
  readonly alongside: boolean;
  /** `compensation` attaches through an association, never as a `bpmn:boundaryEvent`. */
  readonly boundary: boolean;
  /** Whether the trigger may open a host-less handler (an event sub-process). */
  readonly hostless: boolean;
}

export const TRIGGER_PAYLOAD: Readonly<Record<string, TriggerPayloadRule>> = {
  error: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    message: true,
    alongside: false,
    boundary: true,
    hostless: true,
  },
  escalation: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    message: false,
    alongside: true,
    boundary: true,
    hostless: true,
  },
  message: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    message: false,
    alongside: true,
    boundary: true,
    hostless: true,
  },
  signal: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    message: false,
    alongside: true,
    boundary: true,
    hostless: true,
  },
  timer: {
    code: 'forbidden',
    timer: true,
    parens: 'forbidden',
    message: false,
    alongside: true,
    boundary: true,
    hostless: true,
  },
  condition: {
    code: 'forbidden',
    timer: false,
    parens: 'condition',
    message: false,
    alongside: true,
    boundary: true,
    hostless: true,
  },
  compensation: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    message: false,
    alongside: false,
    boundary: false,
    hostless: true,
  },
  cancel: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    message: false,
    alongside: false,
    boundary: true,
    hostless: false,
  },
  // The engine's link table is keyed by name alone, so a link opens no handler.
  link: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    message: false,
    alongside: false,
    boundary: false,
    hostless: false,
  },
} satisfies Record<(typeof ON_TRIGGERS)[number] | 'link', TriggerPayloadRule>;

export const HANDLER_START_TRIGGERS = ON_TRIGGERS.filter(
  (word) => TRIGGER_PAYLOAD[word].hostless,
);

export const BOUNDARY_TRIGGERS = ON_TRIGGERS.filter(
  (word) => TRIGGER_PAYLOAD[word].boundary,
);

/** A declared code is a cross-reference; a message or signal names its subscription. */
export const DECLARED_CODE_TRIGGERS: ReadonlySet<string> = new Set([
  'error',
  'escalation',
]);

export function namesACode(trigger: string): boolean {
  const code = TRIGGER_PAYLOAD[trigger]?.code;
  return code === 'required' || code === 'optional';
}

/**
 * Fence tag -> canonical `scriptFormat`; `juel` is the only engine always
 * registered, every other resolves a JSR-223 engine at first evaluation.
 */
export const SCRIPT_FORMAT_ALIASES: Readonly<Record<string, string>> = {
  juel: 'juel',
  js: 'javascript',
  javascript: 'javascript',
  ecmascript: 'javascript',
  groovy: 'groovy',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  ruby: 'ruby',
  feel: 'feel',
};

/** Case-insensitive, as Operaton lowercases the language before the engine lookup. */
export function scriptFormatOf(tag: string): string | undefined {
  return SCRIPT_FORMAT_ALIASES[tag.toLowerCase()];
}

/**
 * One line terminator after the tag is dropped and `\r\n` becomes `\n`, so a
 * CRLF checkout writes the same `<bpmn:script>` as an LF one.
 */
export function splitFencedScript(raw: string): { tag: string; code: string } {
  const inner = raw.slice(3, -3);
  const tag = /^[a-zA-Z]+/.exec(inner)?.[0] ?? '';
  const rest = inner.slice(tag.length);
  const afterOpeningLine = rest.startsWith('\r\n')
    ? rest.slice(2)
    : rest.startsWith('\n')
      ? rest.slice(1)
      : rest;
  return { tag, code: afterOpeningLine.replace(/\r\n/g, '\n') };
}

export type AttributeOwner =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTask
  | ScriptTask
  | GenericTask
  | SendTask
  | ReceiveTask
  | BusinessRuleTask
  | SubProcess
  | CallActivity
  | OnHandler
  | ThrowStatement
  | EmitStatement
  | IntermediateCatchEvent
  | RaceBranch;

export interface AttributeBlockRule {
  /** With article, for diagnostics. */
  readonly description: string;
  /**
   * `label` and `documentation` only where the element has a diagram name; a
   * handler, `throw`, `emit`, `await` or race branch refuses them as unknown.
   */
  readonly own: readonly string[];
  readonly keys: ReadonlySet<string>;
  /** Flag words lex everywhere, so a kind taking none needs the empty list to refuse them. */
  readonly flags: readonly string[];
  readonly forms: boolean;
  readonly repeats: boolean;
  readonly parameters: boolean;
  /** A listener's block follows its own binding, not this. */
  readonly fields: boolean;
  readonly taskListeners: boolean;
  /**
   * `taskPriority`, `property` and `error ... when` lines, each checked against
   * the binding. A thrown message could bind a topic, but none is written for it.
   */
  readonly externalExtras: boolean;
}

/** An omitted list is empty and an omitted switch is off. */
function withKeys(
  spec: Pick<AttributeBlockRule, 'description'> &
    Partial<Omit<AttributeBlockRule, 'keys'>>,
): AttributeBlockRule {
  const rule = {
    own: [],
    flags: [],
    forms: false,
    repeats: false,
    parameters: false,
    fields: false,
    taskListeners: false,
    externalExtras: false,
    ...spec,
  };
  return {
    ...rule,
    keys: new Set([
      ...ENGINE_KEYS,
      ...rule.own,
      ...(rule.repeats ? RUN_ENGINE_KEYS : []),
    ]),
  };
}

const SERVICE_TASK_LIKE = {
  own: [
    ...LABEL_KEYS,
    ...SERVICE_TASK_BINDING_KEYS,
    'resultVariable',
    TASK_PRIORITY_KEY,
  ],
  repeats: true,
  parameters: true,
  fields: true,
  externalExtras: true,
};

/** Legal keys only; required keys and pairings are checked separately. */
export const ATTRIBUTE_BLOCK_RULES: Readonly<
  Record<AttributeOwner['$type'], AttributeBlockRule>
> = {
  StartEvent: withKeys({
    description: 'a start event',
    own: [...LABEL_KEYS, 'initiator'],
    forms: true,
  }),
  EndEvent: withKeys({
    description: 'an end event',
    own: LABEL_KEYS,
  }),
  UserTask: withKeys({
    description: 'a user task',
    // In print order.
    own: [
      ...LABEL_KEYS,
      ...USER_TASK_VERBATIM_KEYS.flatMap((key) =>
        key === 'formKey' ? [key, 'formRef', 'binding', 'version'] : [key],
      ),
    ],
    forms: true,
    repeats: true,
    parameters: true,
    taskListeners: true,
  }),
  ServiceTask: withKeys({
    description: 'a service task',
    ...SERVICE_TASK_LIKE,
  }),
  ScriptTask: withKeys({
    description: 'a script task',
    own: [...LABEL_KEYS, 'resultVariable'],
    repeats: true,
    parameters: true,
  }),
  GenericTask: withKeys({
    description: 'a step',
    own: LABEL_KEYS,
    repeats: true,
    parameters: true,
  }),
  SendTask: withKeys({
    description: 'a send task',
    ...SERVICE_TASK_LIKE,
  }),
  ReceiveTask: withKeys({
    description: 'a receive task',
    own: [...LABEL_KEYS, 'message'],
    repeats: true,
    parameters: true,
  }),
  BusinessRuleTask: withKeys({
    description: 'a decision step',
    own: [
      ...LABEL_KEYS,
      ...BUSINESS_RULE_BINDING_KEYS,
      ...DECISION_MODIFIER_KEYS,
      'resultVariable',
      TASK_PRIORITY_KEY,
    ],
    repeats: true,
    parameters: true,
    fields: true,
    externalExtras: true,
  }),
  SubProcess: withKeys({
    description: 'a subprocess',
    own: LABEL_KEYS,
    repeats: true,
    parameters: true,
  }),
  CallActivity: withKeys({
    description: 'a call',
    own: [
      ...LABEL_KEYS,
      'process',
      'binding',
      'version',
      'businessKey',
      'mapper',
      'mapperDelegate',
    ],
    repeats: true,
    parameters: true,
  }),
  // A boundary event and an event sub-process both refuse a mapping in Operaton.
  OnHandler: withKeys({
    description: 'an event handler',
    flags: ['alongside'],
  }),
  // These make the engine really send a thrown message; `message` trigger only.
  ThrowStatement: withKeys({
    description: 'a throw statement',
    own: THROW_BINDING_KEYS,
  }),
  EmitStatement: withKeys({
    description: 'an emit statement',
    own: THROW_BINDING_KEYS,
  }),
  IntermediateCatchEvent: withKeys({
    description: 'an awaited event',
  }),
  RaceBranch: withKeys({
    description: 'a branch of an await block',
  }),
};

export interface GatewayStatementRule {
  readonly description: string;
  /** A synthesized join gateway beside the split; a loop is one gateway with a back-edge. */
  readonly join: boolean;
  readonly refuses: readonly string[];
}

const GATEWAY_STATEMENT_RULES: Readonly<
  Record<
    | 'IfStatement'
    | 'WhileStatement'
    | 'DoWhileStatement'
    | 'ParallelStatement'
    | 'RaceStatement',
    GatewayStatementRule
  >
> = {
  IfStatement: { description: 'an if statement', join: true, refuses: [] },
  WhileStatement: { description: 'a while loop', join: false, refuses: [] },
  DoWhileStatement: {
    description: 'a do-while loop',
    join: false,
    refuses: [],
  },
  ParallelStatement: {
    description: 'a parallel statement',
    join: true,
    refuses: [],
  },
  // `BpmnParse.parseEventBasedGateway` refuses `asyncAfter`.
  RaceStatement: {
    description: 'an await block',
    join: true,
    refuses: ['asyncAfter'],
  },
};

export function gatewayStatementRuleOf(
  node: AstNode,
): GatewayStatementRule | undefined {
  const rules: Readonly<Record<string, GatewayStatementRule>> =
    GATEWAY_STATEMENT_RULES;
  return rules[node.$type];
}

export function listenerEventsFor(rule: AttributeBlockRule): readonly string[] {
  return rule.taskListeners
    ? [...EXECUTION_LISTENER_EVENTS, ...TASK_LISTENER_EVENTS]
    : EXECUTION_LISTENER_EVENTS;
}

export function parameterDirectionsFor(
  rule: AttributeBlockRule,
): readonly string[] {
  return [
    ...(rule.parameters ? IO_DIRECTIONS : []),
    ...(rule.fields ? [FIELD_DIRECTION] : []),
    ...(rule.externalExtras ? [PROPERTY_DIRECTION] : []),
  ];
}

/** Apart because `attempt` shares the `SubProcess` AST type the rules are keyed by. */
export const ATTEMPT_BLOCK_RULE: AttributeBlockRule = {
  ...ATTRIBUTE_BLOCK_RULES.SubProcess,
  description: 'an attempt block',
};

export function attributeBlockRuleOf(
  node: AstNode,
): AttributeBlockRule | undefined {
  const rules: Readonly<Record<string, AttributeBlockRule>> =
    ATTRIBUTE_BLOCK_RULES;
  const rule = rules[node.$type];
  if (rule && isSubProcess(node) && node.transactional) {
    return ATTEMPT_BLOCK_RULE;
  }
  return rule;
}
