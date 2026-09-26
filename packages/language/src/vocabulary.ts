/**
 * The words BPMNscript accepts and where each one is legal. The grammar takes
 * any word in these positions; the validator rejects one out of place and the
 * completion provider offers the ones that fit, both from these tables and in
 * list order.
 *
 * A trigger or constraint list is a literal tuple. A table keyed by one is
 * annotated `Record<string, ...>` so any word can be looked up, and
 * `satisfies` the tuple so a missing row fails to compile.
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

/**
 * A keyword's lexer token is named after its literal value, so these strings
 * match a token type name as well as the source text. Operators are left out;
 * they cannot be mistaken for a name.
 */
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

/** An English clause: `a`, `a or b`, `a, b, or c`; the same with `and`. */
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

/** The two flags that create a continuation job (`BpmnParse.parseAsynchronousContinuation`). */
export const ASYNC_FLAG_KEYS = ['asyncBefore', 'asyncAfter'] as const;

/**
 * The three settings that only configure a job something else declares, and
 * that a timer job takes off the element declaring the timer: the lock and
 * the priority in `BpmnParse.parseTimer`, the retry cycle in
 * `DefaultFailedJobParseListener.parseStartEvent`, `parseBoundaryEvent` and
 * `parseIntermediateCatchEvent`.
 */
export const TIMER_JOB_KEYS = [
  'exclusive',
  'jobPriority',
  'retryCycle',
] as const;
export type TimerJobKey = (typeof TIMER_JOB_KEYS)[number];

export type EngineKey = (typeof ASYNC_FLAG_KEYS)[number] | TimerJobKey;

/**
 * The engine keys `BpmnParse.isAsyncBefore`, `isAsyncAfter` and `isExclusive`
 * read with a case-sensitive `"true"` comparison, so any other text deploys
 * as the setting turned off.
 */
export const BOOLEAN_ENGINE_KEYS: readonly EngineKey[] = [
  ...ASYNC_FLAG_KEYS,
  'exclusive',
];

/**
 * The settings Operaton reads off any flow node, gateways included:
 * `BpmnParse.parseExclusiveGateway`, `parseInclusiveGateway`,
 * `parseParallelGateway` and `parseEventBasedGateway` each go through
 * `parseAsynchronousContinuationForActivity` and `createActivityOnScope`, and
 * `DefaultFailedJobParseListener.parseActivity` reads the retry cycle on the
 * same four.
 */
export const ENGINE_KEYS: readonly EngineKey[] = [
  ...ASYNC_FLAG_KEYS,
  ...TIMER_JOB_KEYS,
];

/**
 * The variables Operaton sets around a repeated step: three counters on the
 * repetition and `loopCounter` on each run (`MultiInstanceActivityBehavior`).
 * They exist undeclared, so a process that repeats anything has them in scope.
 */
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

/** An engine key under each spelling a parens carries it; the value shape is the same under all three. */
export const engineSpellings = (key: string): string[] => [
  key,
  joinSettingKey(key),
  runSettingKey(key),
];

/**
 * The settings a repetition writes on its `multiInstanceLoopCharacteristics`
 * element, which `BpmnParse.parseAsynchronousContinuationForActivity` and
 * `DefaultFailedJobParseListener.parseActivity` read onto each run. There is
 * no `runJobPriority`: `BpmnParse.parseActivity` makes the multi-instance body
 * the scope before `createActivityOnScope` runs, so the plain `jobPriority` in
 * the same parens already prices each run.
 */
export const RUN_ENGINE_KEYS: readonly string[] = ENGINE_KEYS.filter(
  (key) => key !== 'jobPriority',
).map((key) => runSettingKey(key));

/** `BpmnParse.parseServiceTaskLike` dispatches on this key's value before it looks at any code attribute. */
export const TYPE_BINDING_KEY = 'type';

export const EXTERNAL_BINDING_KEY = 'topic';

/**
 * Exactly one of these binds a service task; `topic` hands the step to an
 * external worker polling the engine instead of the engine invoking anything.
 * `parseBusinessRuleTask` without a `decisionRef` reaches the same
 * `parseServiceTaskLike`, so {@link BUSINESS_RULE_BINDING_KEYS} inherits it.
 */
export const SERVICE_TASK_BINDING_KEYS: readonly string[] = [
  'class',
  'expression',
  'delegate',
  EXTERNAL_BINDING_KEY,
  TYPE_BINDING_KEY,
];

/** A thrown message has no member block, so the fields a built-in `type` requires cannot be written on it. */
export const THROW_BINDING_KEYS: readonly string[] =
  SERVICE_TASK_BINDING_KEYS.filter((key) => key !== TYPE_BINDING_KEY);

export const THROW_BINDING_TRIGGER = 'message';

/** The two `operaton:type` values `parseServiceTaskLike` routes to a built-in behaviour. */
export const TYPE_BINDING_VALUES = ['mail', 'shell'] as const;

export type BuiltinTaskType = (typeof TYPE_BINDING_VALUES)[number];

/**
 * In declaration order. `ClassDelegateUtil.applyFieldDeclaration` throws
 * "Field definition uses unexisting field '<name>' on class ..." for any
 * other name, reached through `instantiateDelegate` from both
 * `parseEmailServiceTask` and `parseShellServiceTask`.
 */
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

/** A field group a built-in task must write at least one name of before it deploys. */
export interface RequiredFieldGroup {
  readonly names: readonly string[];
  /** The message the engine's parse throws when none of the names is written. */
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

/** The `BpmnParse` method that refuses a deployment missing one of the type's required fields. */
export const BUILTIN_FIELD_VALIDATOR: Readonly<
  Record<BuiltinTaskType, string>
> = {
  mail: 'validateFieldDeclarationsForEmail',
  shell: 'validateFieldDeclarationsForShell',
};

/**
 * The shell fields `validateFieldDeclarationsForShell` requires a fixed
 * `true`/`false` value on, case-insensitively. `ShellActivityBehavior.readFields`
 * then compares the deployed value with `"true".equals(...)`, case-sensitively,
 * so a value like `"True"` deploys and is read back as `false` at runtime.
 */
export const SHELL_FLAG_FIELDS: readonly string[] = [
  'wait',
  'redirectError',
  'cleanEnv',
];

/** The spellings `ShellActivityBehavior.readFields` compares a flag with. */
export const SHELL_FLAG_LITERALS: readonly string[] = ['true', 'false'];

/** The engine requires one, and `decision` wins when both are written. */
export const BUSINESS_RULE_BINDING_KEYS: readonly string[] = [
  ...SERVICE_TASK_BINDING_KEYS,
  'decision',
];

/** What `operaton:mapDecisionResult` holds: one entry, one row, one column, or every row. */
export const DECISION_RESULT_MAPPINGS = [
  'singleEntry',
  'singleResult',
  'collectEntries',
  'resultList',
] as const;

/** Outside this list, a fenced script body binds a listener too. */
export const LISTENER_BINDING_KEYS: readonly string[] =
  SERVICE_TASK_BINDING_KEYS.filter(
    (key) => key !== EXTERNAL_BINDING_KEY && key !== TYPE_BINDING_KEY,
  );

/**
 * The bindings Operaton hands a field list to: the class, the bean a
 * `delegate` expression resolves, and the two built-in behaviours
 * (`BpmnParse.parseEmailServiceTask` and `parseShellServiceTask` go through
 * `instantiateDelegate`). An `expression` is built from its expression and
 * result variable alone, a `topic` hands the work to a worker the engine
 * injects nothing into, and a `decision` runs no implementation.
 */
export const FIELD_BINDING_KEYS: readonly string[] = [
  'class',
  'delegate',
  TYPE_BINDING_KEY,
];

/**
 * A call's variable-mapping delegate, keyed by the IR mapper kind. It is not
 * spelled `class`/`delegate` because Operaton hands it no field list, which
 * is what {@link FIELD_BINDING_KEYS} keys on.
 */
export const CALL_MAPPER_KEY_BY_KIND = {
  class: 'mapper',
  delegateExpression: 'mapperDelegate',
} as const;

/** How a call or a decision step pins which deployed version the engine runs. */
export const CALL_BINDING_VALUES = ['latest', 'deployment'] as const;

export type CallBindingValue = (typeof CALL_BINDING_VALUES)[number];

/**
 * In the order they are offered and printed. `BpmnParse.parseProcess` also
 * reads `jobPriority`, `taskPriority` and `isStartableInTasklist` off the
 * process element, and `parseScope` a process-level listener and
 * `potentialStarter`; those are left out on purpose, not gaps.
 */
export const PROCESS_HEADER_KEYS: readonly string[] = [
  'label',
  'documentation',
  'versionTag',
  'historyTimeToLive',
  'candidateStarterUsers',
  'candidateStarterGroups',
];

export const INPUT_DIRECTION = 'input';
export const OUTPUT_DIRECTION = 'output';

export const IO_DIRECTIONS: readonly string[] = [
  INPUT_DIRECTION,
  OUTPUT_DIRECTION,
];

/**
 * A user task's settings that are the `operaton:` attribute of the same name,
 * value verbatim; the IR field is named the same. In print order.
 */
export const USER_TASK_VERBATIM_KEYS = [
  'assignee',
  'formKey',
  'candidateGroups',
  'candidateUsers',
  'dueDate',
  'followUpDate',
  'priority',
] as const;

/**
 * A field names a property of the bound implementation, set once as it is
 * instantiated, so it neither reads nor writes a process variable;
 * {@link FIELD_BINDING_KEYS} says where one is legal.
 */
export const FIELD_DIRECTION = 'field';

/**
 * Written to `operaton:properties` as text and declares no process variable.
 * A form field's are read by `DefaultFormHandler.parseProperties` keyed by
 * `id` and handed to Tasklist, an external task's by
 * `BpmnParseUtil.parseOperatonExtensionProperties` keyed by `name` and
 * handed to the worker.
 */
export const PROPERTY_DIRECTION = 'property';

/**
 * Read by `BpmnParse.parsePriority` inside `parseExternalServiceTask` and
 * nowhere else on a step; an integer or an expression.
 */
export const TASK_PRIORITY_KEY = 'taskPriority';

/**
 * `VariableScopeElResolver` resolves this name to the external task entity in
 * an expression evaluated on its execution, which is where a mapping's
 * condition runs (`ExternalTaskEntity.evaluateThrowBpmnError`); it is a
 * process variable everywhere else, so it is admitted inside a mapping alone.
 */
export const EXTERNAL_TASK_EL_NAME = 'externalTask';

/** The two soft words of a mapping line; the validator holds each to its word. */
export const ERROR_MAPPING_HEAD = 'error';
export const ERROR_MAPPING_WHEN = 'when';

export type TimerKind = 'duration' | 'date' | 'cycle';

/**
 * The particle a timer clause is written with, keyed by the BPMN timer
 * definition it selects (`timeDuration`, `timeDate`, `timeCycle`).
 */
export const TIMER_PARTICLE_BY_KIND: Readonly<Record<TimerKind, string>> = {
  duration: 'after',
  date: 'at',
  cycle: 'every',
};

export const TIMER_PARTICLES: readonly string[] = Object.values(
  TIMER_PARTICLE_BY_KIND,
);

export const EVENT_BINDING_FIELDS: readonly string[] = ['code', 'message'];

export const EVENT_BINDING_FIELD_SET: ReadonlySet<string> = new Set(
  EVENT_BINDING_FIELDS,
);

export function eventBindingFieldsFor(trigger: string): readonly string[] {
  return EVENT_BINDING_FIELDS.filter(
    (field) => field !== 'message' || TRIGGER_PAYLOAD[trigger]?.message,
  );
}

/** Legal on every element with a member block, since each lowers to a flow node. */
export const EXECUTION_LISTENER_EVENTS = ['start', 'end'] as const;

/**
 * Legal on a user task alone, spelled as `BpmnParse.parseTaskListeners`
 * accepts them; `timeout` is the one carrying a timer clause.
 */
export const TASK_LISTENER_EVENTS = [
  'create',
  'assignment',
  'complete',
  'update',
  'delete',
  'timeout',
] as const;

/**
 * Vendor-neutral spellings: `number` becomes the Operaton `long` at export,
 * and `json`/`any` have no `operaton:formField` representation. `enum` is a
 * form type and not a `var` type, so the grammar admits it beside `VarType`
 * and the validator holds the word to this list.
 */
export const FORM_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'enum',
] as const;

/**
 * An `enum` stores the chosen value's id as a string
 * (`EnumFormType.convertValue`); every other form type is the `VarType` of
 * the same name.
 */
export function formFieldVariableType(type: string): VarType | undefined {
  const found = FORM_FIELD_TYPES.find((t) => t === type);
  return found === 'enum' ? 'string' : found;
}

/**
 * The first six are the validators
 * `ProcessEngineConfigurationImpl.initFormFieldValidators` registers;
 * `FormValidators.createValidator` reads a class name or an expression off
 * `validator`'s `config` and fails the deployment on any other name.
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

/**
 * `AbstractNumericValidator.validate` throws on any submitted value that is
 * not a Java number and `AbstractTextValueValidator.validate` on any that is
 * not a string, so the bounds fit one type each; the rest never read the
 * value's type.
 */
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
 * `AbstractNumericValidator.validate` parses a `min`/`max` config with
 * `Long.parseLong` and `MinLengthValidator.validate` a length with
 * `Integer.parseInt`; neither reads an expression, and a decimal bound
 * deploys and then fails every submission with
 * `FormFieldConfigurationException`.
 */
export const FORM_BOUND_TEXT = /^-?\d+$/;

/** The grammar's `ID` terminal as the lexer runs it, unanchored. */
export const ID_TERMINAL: RegExp = GrammarUtils.terminalRegex(
  BpmnScriptGrammar().rules.find(
    (rule): rule is GrammarAST.TerminalRule =>
      GrammarAST.isTerminalRule(rule) && rule.name === 'ID',
  )!,
);

/** A whole string the lexer reads as one `ID` token. */
export const ID_TEXT = new RegExp(`^${ID_TERMINAL.source}$`, ID_TERMINAL.flags);

/**
 * What `StringUtil.isExpression` counts as one: an opening at the start of
 * the trimmed text. A body with an opening further in is a constant to the
 * engine, and `BpmnParse.parsePriority` fails the deployment on it.
 */
export const EXPRESSION_OPEN = /^\s*[$#]\{/;

/**
 * An opening anywhere in the text. `ExpressionManager.createExpression` hands
 * JUEL the string as it stands, and JUEL evaluates a composite such as
 * `a-${b}` as text around an expression; either opener marks an expression.
 */
export const EXPRESSION_ANYWHERE = /[$#]\{/;

/**
 * The words JUEL's `Scanner.addKeyToken` registers as operators besides
 * `true`, `false` and `null`, which the grammar spells as literals. A variable
 * or property named one of these renders as `${mod > 1}`, which the JUEL
 * parser refuses at deployment.
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

/**
 * The grammar spells these as literals, so only a raw template can carry one
 * as a name: `${order.true}` reaches `Scanner.nextIdentifier`, which returns
 * the keyword token, and `Parser.parseDotToken`'s `consumeToken(IDENTIFIER)`
 * refuses it.
 */
export const JUEL_LITERAL_WORDS = ['true', 'false', 'null'] as const;

/**
 * Written to `datePattern`, which `FormTypes.parseFormPropertyType` reads on
 * a `date` field alone. A type parameter rather than a constraint, so it is
 * not in {@link FORM_CONSTRAINT_NAMES}.
 */
export const DATE_PATTERN_KEY = 'pattern';

export const FORM_FIELD_SETTING_KEYS: readonly string[] = [
  ...FORM_CONSTRAINT_NAMES,
  DATE_PATTERN_KEY,
];

/**
 * Soft trigger words: they lex as plain `ID`s rather than keywords, so an
 * unrecognized one is a validator diagnostic, not a parse error.
 */
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

/**
 * A timer fires off the clock and a condition off data, so neither has
 * anything to throw; a cancel is written on the `end` that gives up an
 * `attempt` block.
 */
export const THROW_TRIGGERS = [
  'error',
  'escalation',
  'message',
  'signal',
  'compensation',
] as const;

/**
 * An error always ends its path, so it has no continuing form. A link
 * continues at its catch rather than at the next statement, and a link throw
 * is intermediate, never an end, so `throw` has no link form.
 */
export const EMIT_TRIGGERS = [
  'escalation',
  'message',
  'signal',
  'compensation',
  'link',
] as const;

/**
 * `link` is left out: `BpmnParse.parseIntermediateCatchEvent` refuses a link
 * catch behind an event-based gateway, so a plain `await` is the only place
 * one may stand.
 */
export const RACE_TRIGGERS = [
  'message',
  'timer',
  'signal',
  'condition',
] as const;

/**
 * Error and escalation travel outward, compensation runs through a
 * subprocess's own `on compensation` body, and a cancel is caught by
 * `on <block>: cancel`, so none of those has an inline catch.
 */
export const CATCH_TRIGGERS = [...RACE_TRIGGERS, 'link'] as const;

/**
 * `BpmnParse.parseProcessDefinitionStartEvent` looks only for a timer,
 * message, signal or conditional definition; an error, escalation or
 * compensation definition on a process-level start is never inspected, so it
 * starts as if none were written. Those three stay off rather than emitting
 * XML the engine disregards.
 */
export const START_TRIGGERS = [
  'message',
  'signal',
  'timer',
  'condition',
] as const;

/**
 * Carried by an end event rather than raised: a terminate stops every running
 * path of its scope at once, a cancel gives up the `attempt` block it sits in.
 */
export const END_TRIGGERS = ['terminate', 'cancel'] as const;

export interface TriggerPayloadRule {
  readonly code: 'required' | 'optional' | 'forbidden';
  /** Whether the `particle`/`time` clause is required. */
  readonly timer: boolean;
  readonly parens: 'bindings' | 'condition' | 'forbidden';
  /** Whether the event carries a message text beside its code. */
  readonly message: boolean;
  /** Whether a non-interrupting `alongside` handler is legal. */
  readonly alongside: boolean;
  /**
   * Whether the trigger may attach as a `bpmn:boundaryEvent`. `compensation`
   * instead attaches through `bpmn:association`/`isForCompensation`.
   */
  readonly boundary: boolean;
  /** Whether the trigger may open a host-less handler (an event sub-process). */
  readonly hostless: boolean;
}

export const TRIGGER_PAYLOAD: Readonly<Record<string, TriggerPayloadRule>> = {
  // An error always interrupts.
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
  // A message and a signal are name-keyed subscriptions.
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
  // Compensation reverses finished work: nothing to catch by name, no flow to
  // run alongside.
  compensation: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    message: false,
    alongside: false,
    boundary: false,
    hostless: true,
  },
  // A cancel is caught on its `attempt` host alone.
  cancel: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    message: false,
    alongside: false,
    boundary: true,
    hostless: false,
  },
  // A link keys the engine's per-file link table by name alone, so it opens
  // no `on` handler of any form.
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

/**
 * `throw error(OUT_OF_STOCK)` names a code declared in the process header and
 * is resolved as a cross-reference; `message("OrderReceived")` names the
 * subscription the engine keys on and declares nothing.
 */
export const DECLARED_CODE_TRIGGERS: ReadonlySet<string> = new Set([
  'error',
  'escalation',
]);

export function namesACode(trigger: string): boolean {
  const code = TRIGGER_PAYLOAD[trigger]?.code;
  return code === 'required' || code === 'optional';
}

/**
 * Fence tags and the canonical `scriptFormat` each normalizes to; the printer
 * emits the canonical one, so `js` round-trips to `javascript`. `juel` is the
 * one engine the jar always registers
 * (`ScriptingEngines.DEFAULT_SCRIPTING_LANGUAGE`); every other tag resolves a
 * JSR-223 engine off the classpath at first evaluation.
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

/**
 * Case-insensitive, as `ScriptingEngines.getScriptEngineForLanguage`
 * lowercases the language before looking an engine up.
 */
export function scriptFormatOf(tag: string): string | undefined {
  return SCRIPT_FORMAT_ALIASES[tag.toLowerCase()];
}

/**
 * The tag is the run of ASCII letters after the opening fence, one line
 * terminator after it is dropped, and the body is otherwise verbatim except
 * that every `\r\n` becomes `\n`: the terminal matches `\r` like any other
 * character, so a CRLF checkout would otherwise write a carriage return into
 * `<bpmn:script>` that an LF checkout never would.
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

/** Each carries `items`, `params`, and `listeners`; all but `call` also carry `forms`. */
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
  /** The element kind as a noun phrase with article, for diagnostics. */
  readonly description: string;
  /**
   * The keys this kind owns. `label` and `documentation` appear wherever the
   * element lowers to a BPMN node with a diagram name; a handler, a `throw`,
   * an `emit`, an `await` and a branch of one take neither, so either written
   * there is an unknown key, not a dropped one.
   */
  readonly own: readonly string[];
  /** {@link own} and the engine settings together, for membership tests. */
  readonly keys: ReadonlySet<string>;
  /**
   * The bare words legal in the parens. A flag word lexes as one wherever
   * parens are written, so a kind that takes none needs the empty row to
   * refuse them.
   */
  readonly flags: readonly string[];
  readonly forms: boolean;
  /** Whether the statement takes a `for` clause, and so its parens the {@link RUN_ENGINE_KEYS}. */
  readonly repeats: boolean;
  readonly parameters: boolean;
  /**
   * Answers for the element's own block: a listener's block follows the
   * listener's own binding, so a task listener carries a field on a kind this
   * says `false` for.
   */
  readonly fields: boolean;
  readonly taskListeners: boolean;
  /**
   * Whether the kind takes an external task's extras: `taskPriority` in the
   * parens, and `property` and `error ... when` lines in the block, each
   * checked against the binding written. A thrown message can bind a topic
   * too, but this surface writes none of them for it.
   */
  readonly externalExtras: boolean;
}

function withKeys(spec: Omit<AttributeBlockRule, 'keys'>): AttributeBlockRule {
  return {
    ...spec,
    keys: new Set([
      ...ENGINE_KEYS,
      ...spec.own,
      ...(spec.repeats ? RUN_ENGINE_KEYS : []),
    ]),
  };
}

/**
 * Required keys (`process` on a call) and pairings (`binding`/`version`
 * beside the key they pin) are checked separately; the table holds only what
 * is legal.
 */
export const ATTRIBUTE_BLOCK_RULES: Readonly<
  Record<AttributeOwner['$type'], AttributeBlockRule>
> = {
  StartEvent: withKeys({
    description: 'a start event',
    own: ['label', 'documentation', 'initiator'],
    flags: [],
    forms: true,
    repeats: false,
    parameters: false,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  EndEvent: withKeys({
    description: 'an end event',
    own: ['label', 'documentation'],
    flags: [],
    forms: false,
    repeats: false,
    parameters: false,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  UserTask: withKeys({
    description: 'a user task',
    // Offered in print order, the form-reference triple right after `formKey`.
    own: [
      'label',
      'documentation',
      ...USER_TASK_VERBATIM_KEYS.flatMap((key) =>
        key === 'formKey' ? [key, 'formRef', 'binding', 'version'] : [key],
      ),
    ],
    flags: [],
    forms: true,
    repeats: true,
    parameters: true,
    fields: false,
    taskListeners: true,
    externalExtras: false,
  }),
  ServiceTask: withKeys({
    description: 'a service task',
    own: [
      'label',
      'documentation',
      ...SERVICE_TASK_BINDING_KEYS,
      'resultVariable',
      TASK_PRIORITY_KEY,
    ],
    flags: [],
    forms: false,
    repeats: true,
    parameters: true,
    fields: true,
    taskListeners: false,
    externalExtras: true,
  }),
  ScriptTask: withKeys({
    description: 'a script task',
    own: ['label', 'documentation', 'resultVariable'],
    flags: [],
    forms: false,
    repeats: true,
    parameters: true,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  GenericTask: withKeys({
    description: 'a step',
    own: ['label', 'documentation'],
    flags: [],
    forms: false,
    repeats: true,
    parameters: true,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  SendTask: withKeys({
    description: 'a send task',
    own: [
      'label',
      'documentation',
      ...SERVICE_TASK_BINDING_KEYS,
      'resultVariable',
      TASK_PRIORITY_KEY,
    ],
    flags: [],
    forms: false,
    repeats: true,
    parameters: true,
    fields: true,
    taskListeners: false,
    externalExtras: true,
  }),
  ReceiveTask: withKeys({
    description: 'a receive task',
    own: ['label', 'documentation', 'message'],
    flags: [],
    forms: false,
    repeats: true,
    parameters: true,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  BusinessRuleTask: withKeys({
    description: 'a decision step',
    own: [
      'label',
      'documentation',
      ...BUSINESS_RULE_BINDING_KEYS,
      'binding',
      'version',
      'mapDecisionResult',
      'resultVariable',
      TASK_PRIORITY_KEY,
    ],
    flags: [],
    forms: false,
    repeats: true,
    parameters: true,
    fields: true,
    taskListeners: false,
    externalExtras: true,
  }),
  SubProcess: withKeys({
    description: 'a subprocess',
    own: ['label', 'documentation'],
    flags: [],
    forms: false,
    repeats: true,
    parameters: true,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  CallActivity: withKeys({
    description: 'a call',
    own: [
      'label',
      'documentation',
      'process',
      'binding',
      'version',
      'businessKey',
      'mapper',
      'mapperDelegate',
    ],
    flags: [],
    forms: false,
    repeats: true,
    parameters: true,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  // A hosted handler lowers to a boundary event, on which
  // `BpmnParse.parseBoundaryEvents` refuses a mapping, and a host-less one to
  // an event sub-process, which `BpmnParse.checkActivityInputOutputSupported`
  // refuses one on.
  OnHandler: withKeys({
    description: 'an event handler',
    own: [],
    flags: ['alongside'],
    forms: false,
    repeats: false,
    parameters: false,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  // The binding keys carry the implementation that makes the engine really
  // send a thrown message; the validator holds them to the `message` trigger.
  ThrowStatement: withKeys({
    description: 'a throw statement',
    own: [...THROW_BINDING_KEYS],
    flags: [],
    forms: false,
    repeats: false,
    parameters: false,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  EmitStatement: withKeys({
    description: 'an emit statement',
    own: [...THROW_BINDING_KEYS],
    flags: [],
    forms: false,
    repeats: false,
    parameters: false,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  IntermediateCatchEvent: withKeys({
    description: 'an awaited event',
    own: [],
    flags: [],
    forms: false,
    repeats: false,
    parameters: false,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
  // The same catch element with a body, so it takes the same keys.
  RaceBranch: withKeys({
    description: 'a branch of an await block',
    own: [],
    flags: [],
    forms: false,
    repeats: false,
    parameters: false,
    fields: false,
    taskListeners: false,
    externalExtras: false,
  }),
};

export interface GatewayStatementRule {
  readonly description: string;
  /**
   * Whether the statement synthesizes a join gateway beside its split, and so
   * takes the {@link JOIN_ENGINE_KEYS}; a loop is one gateway with a
   * back-edge.
   */
  readonly join: boolean;
  /** The {@link ENGINE_KEYS} the head does not take. */
  readonly refuses: readonly string[];
}

export const GATEWAY_STATEMENT_RULES: Readonly<
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
  // `BpmnParse.parseEventBasedGateway` refuses `asyncAfter` at deployment.
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

/**
 * Out of {@link ATTRIBUTE_BLOCK_RULES} because that map is keyed by AST type
 * and `attempt` shares `SubProcess`; a diagnostic enumerating the kinds a
 * setting is legal on adds it back beside the map's rows.
 */
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
