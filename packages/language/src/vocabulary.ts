/**
 * The words BPMNscript accepts and where each one is legal. The grammar takes
 * any word in these positions; the validator rejects one out of place and the
 * completion provider offers the ones that fit, both from these tables.
 *
 * Every trigger list is a literal tuple, so a table keyed by one either carries
 * a row per word or fails to compile.
 */

import type { AstNode, Grammar } from 'langium';
import { AstUtils, GrammarAST } from 'langium';
import { isOnHandler, isSubProcess } from './generated/ast.js';
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
 * The keywords that cannot be written where a plain name belongs, read out of
 * the grammar so the set stays correct as keywords change. A keyword's lexer
 * token is named after its literal value, so these strings match a token type
 * name as well as the source text; operators cannot be mistaken for a name and
 * are excluded. Memoized per grammar, which every caller shares.
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

/** The same clause with every word quoted: `'a'`, `'b'`, or `'c'`. */
export function formatWordList(words: readonly string[]): string {
  return formatPlainWordList(words.map((w) => `'${w}'`));
}

/**
 * The engine execution settings Operaton reads off any flow node, gateways
 * included: `BpmnParse.parseExclusiveGateway`, `parseInclusiveGateway`,
 * `parseParallelGateway` and `parseEventBasedGateway` each go through
 * `parseAsynchronousContinuationForActivity` for the async flags and
 * `createActivityOnScope` for `jobPriority`, and
 * `DefaultFailedJobParseListener.parseActivity` reads the retry cycle on the
 * same four.
 */
export const ENGINE_KEYS: readonly string[] = [
  'asyncBefore',
  'asyncAfter',
  'exclusive',
  'jobPriority',
  'retryCycle',
];

/** `key` spelled for a second carrier in the same parens: `join` + `asyncBefore` is `joinAsyncBefore`. */
export function prefixedSettingKey(prefix: string, key: string): string {
  return prefix + key.charAt(0).toUpperCase() + key.slice(1);
}

/** `key` spelled for the synthesized join gateway: `join` + `asyncBefore` is `joinAsyncBefore`. */
export function joinSettingKey(key: string): string {
  return prefixedSettingKey('join', key);
}

/** The join gateway's spelling of each engine setting, keyed by the split's. */
export const JOIN_KEY_BY_ENGINE_KEY: Readonly<Record<string, string>> =
  Object.fromEntries(ENGINE_KEYS.map((key) => [key, joinSettingKey(key)]));

/** The join spellings alone, in {@link ENGINE_KEYS} order. */
export const JOIN_ENGINE_KEYS: readonly string[] = Object.values(
  JOIN_KEY_BY_ENGINE_KEY,
);

/** `key` spelled for the per-run carrier: `run` + `asyncBefore` is `runAsyncBefore`. */
export function runSettingKey(key: string): string {
  return prefixedSettingKey('run', key);
}

/**
 * The four settings a repetition writes on its `multiInstanceLoopCharacteristics`
 * element rather than on the repeated activity itself.
 * `BpmnParse.parseAsynchronousContinuationForActivity` hands that element to
 * `parseAsynchronousContinuation`, which reads the three async settings onto
 * each run, and `DefaultFailedJobParseListener.parseActivity` reads the retry
 * cycle there the same way; `createActivityOnScope` reads a job priority off
 * the activity element alone, which is why there is no `runJobPriority`.
 */
export const RUN_ENGINE_KEYS: readonly string[] = ENGINE_KEYS.filter(
  (key) => key !== 'jobPriority',
).map((key) => runSettingKey(key));

/**
 * The fifth binding: `BpmnParse.parseServiceTaskLike` dispatches on this key's
 * value before it looks at any code attribute.
 */
export const TYPE_BINDING_KEY = 'type';

/**
 * Exactly one of these binds a service task. `topic` delegates to an external
 * worker polling the engine rather than the engine invoking the binding, and
 * `type` selects a behaviour the engine builds itself.
 * {@link BUSINESS_RULE_BINDING_KEYS} inherits it since `parseBusinessRuleTask`
 * without a `decisionRef` reaches `parseServiceTaskLike`.
 */
export const SERVICE_TASK_BINDING_KEYS: readonly string[] = [
  'class',
  'expression',
  'delegate',
  'topic',
  TYPE_BINDING_KEY,
];

/**
 * What a thrown or emitted message binds: a thrown message has no member
 * block, so the fields a built-in behaviour requires cannot be written on it.
 */
export const THROW_BINDING_KEYS: readonly string[] =
  SERVICE_TASK_BINDING_KEYS.filter((key) => key !== TYPE_BINDING_KEY);

/** The two `operaton:type` values `parseServiceTaskLike` routes to a built-in behaviour. */
export const TYPE_BINDING_VALUES = ['mail', 'shell'] as const;

export type BuiltinTaskType = (typeof TYPE_BINDING_VALUES)[number];

/**
 * The field names each built-in behaviour class declares, in declaration
 * order. `ClassDelegateUtil.applyFieldDeclaration` throws "Field definition
 * uses unexisting field '<name>' on class ..." for any other name, reached
 * through `instantiateDelegate` from both `parseEmailServiceTask` and
 * `parseShellServiceTask`.
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

/**
 * The field combinations `validateFieldDeclarationsForEmail` and
 * `validateFieldDeclarationsForShell` require before a mail or shell task
 * deploys, in the order the engine checks them. A mail task needs `to` and one
 * of `text`/`html`; `cc`/`bcc` satisfy neither. A shell task needs only
 * `command`.
 */
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

/**
 * A decision step binds to a decision table or, as a service task does, to
 * code. The engine requires one, and a decision key wins when both are written.
 */
export const BUSINESS_RULE_BINDING_KEYS: readonly string[] = [
  ...SERVICE_TASK_BINDING_KEYS,
  'decision',
];

/**
 * What lands in `resultVariable`, and what `operaton:mapDecisionResult` holds:
 * one entry, one row, one column, or every row.
 */
export const DECISION_RESULT_MAPPINGS = [
  'singleEntry',
  'singleResult',
  'collectEntries',
  'resultList',
] as const;

/** The service-task rule minus `topic`; a fenced body binds a listener too. */
export const LISTENER_BINDING_KEYS: readonly string[] = [
  'class',
  'expression',
  'delegate',
];

/**
 * The bindings an injected field reaches. Operaton hands the field list to
 * the class a `class` binding names, to the delegate a `delegate` expression
 * resolves, and to the two built-in behaviours a `type` selects
 * (`BpmnParse.parseEmailServiceTask` and `parseShellServiceTask` both go
 * through `instantiateDelegate`), and to no other: an `expression` binding is
 * constructed from its expression and its result variable alone, a `topic`
 * hands the work to an external worker the engine injects nothing into, and a
 * `decision` binding runs no implementation at all. A task and both listener
 * kinds split the same way, a listener binding no `type`.
 */
export const FIELD_BINDING_KEYS: readonly string[] = [
  'class',
  'delegate',
  TYPE_BINDING_KEY,
];

/**
 * A call activity's variable-mapping delegate computes its in/out mapping in
 * code, keyed by the IR mapper kind each spells. It is not `class`/`delegate`
 * because Operaton hands this binding no field list, which is exactly what
 * {@link FIELD_BINDING_KEYS} keys on.
 */
export const CALL_MAPPER_KEY_BY_KIND = {
  class: 'mapper',
  delegateExpression: 'mapperDelegate',
} as const;

/** How a call or a decision step pins which deployed version the engine runs. */
export const CALL_BINDING_VALUES: readonly string[] = ['latest', 'deployment'];

/**
 * The settings a process header takes, in the order they are offered and
 * printed. Each attaches to the `bpmn:process` element itself rather than to
 * any node inside it.
 */
export const PROCESS_HEADER_KEYS: readonly string[] = [
  'label',
  'documentation',
  'versionTag',
  'historyTimeToLive',
  'candidateStarterUsers',
  'candidateStarterGroups',
];

export const IO_DIRECTIONS: readonly string[] = ['input', 'output'];

/**
 * The third direction a member of a block is written with. It names a property
 * of the class, delegate, or built-in behaviour the element binds, set once as
 * that implementation is instantiated, so it is neither read from nor written
 * to a process variable. See {@link FIELD_BINDING_KEYS} for where one is legal.
 */
export const FIELD_DIRECTION = 'field';

/**
 * The fourth direction: a member of a form field's block or an external
 * task's, written to `operaton:properties` as text. On a form field
 * `DefaultFormHandler.parseProperties` reads it keyed by `id` and hands it to
 * Tasklist; on an external task `BpmnParseUtil.parseOperatonExtensionProperties`
 * reads it keyed by `name` and hands it to the worker. It declares no process
 * variable.
 */
export const PROPERTY_DIRECTION = 'property';

/**
 * Read by `BpmnParse.parsePriority` inside `parseExternalServiceTask` and
 * nowhere else on a step; the process header's own `operaton:taskPriority` is
 * a separate site this surface does not carry. An integer or an expression.
 */
export const TASK_PRIORITY_KEY = 'taskPriority';

/**
 * The name `VariableScopeElResolver` resolves to the external task entity in
 * an expression evaluated on its execution, which is where a mapping's
 * condition runs (`ExternalTaskEntity.evaluateThrowBpmnError`). A process
 * variable everywhere else, so it is admitted inside a mapping alone.
 */
export const EXTERNAL_TASK_EL_NAME = 'externalTask';

/** The two soft words of a mapping line; the validator holds each to its word. */
export const ERROR_MAPPING_HEAD = 'error';
export const ERROR_MAPPING_WHEN = 'when';

/**
 * The particle a timer clause is written with, keyed by the BPMN timer
 * definition it selects (`timeDuration`, `timeDate`, `timeCycle`). Read in
 * both directions, so the pairing cannot drift.
 */
export const TIMER_PARTICLE_BY_KIND: Readonly<
  Record<'duration' | 'date' | 'cycle', string>
> = {
  duration: 'after',
  date: 'at',
  cycle: 'every',
};

/** The particles alone, in the order diagnostics and completion list them. */
export const TIMER_PARTICLES: readonly string[] = Object.values(
  TIMER_PARTICLE_BY_KIND,
);

export const EVENT_BINDING_FIELDS: readonly string[] = ['code', 'message'];

/** Legal on every element with a member block, since each lowers to a flow node. */
export const EXECUTION_LISTENER_EVENTS = ['start', 'end'] as const;

/** Legal on a user task alone; `timeout` is the one carrying a timer clause. */
export const TASK_LISTENER_EVENTS = [
  'create',
  'assign',
  'complete',
  'update',
  'delete',
  'timeout',
] as const;

/**
 * The types a form field takes, in vendor-neutral spellings: `number` becomes
 * the Operaton `long` at export, and `json`/`any` have no `operaton:formField`
 * representation at all. `enum` is a form type and not a `var` type, so the
 * grammar's field type rule admits it beside `VarType` and the validator holds
 * the word to this list.
 */
export const FORM_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'enum',
] as const;

/**
 * The process variable a form field of `type` binds: an `enum` stores the
 * chosen value's id as a string (`EnumFormType.convertValue`), every other
 * form type is a `VarType` of the same name, and a word outside the list is
 * no type at all.
 */
export function formFieldVariableType(type: string): VarType | undefined {
  const found = FORM_FIELD_TYPES.find((t) => t === type);
  return found === 'enum' ? 'string' : found;
}

/**
 * The names a form field's `operaton:constraint` takes. The first six are the
 * validators `ProcessEngineConfigurationImpl.initFormFieldValidators`
 * registers; `FormValidators.createValidator` reads a class name or an
 * expression off `validator`'s `config` and fails the deployment on any other
 * name.
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
 * The field types each constraint is legal on.
 * `AbstractNumericValidator.validate` throws on any submitted value that is
 * not a Java number and `AbstractTextValueValidator.validate` on any that is
 * not a string, so the bounds fit one type each; the rest never read the
 * value's type. The `satisfies` clause forces a row per name in
 * {@link FORM_CONSTRAINT_NAMES}, while the annotation keeps the lookup open to
 * a word of any origin.
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
 * The text a bound's `config` may hold, bare or quoted in the script. A
 * `number` field is an Operaton `long`, so `AbstractNumericValidator.validate`
 * parses a `min`/`max` config with `Long.parseLong`, and
 * `MinLengthValidator.validate` a length with `Integer.parseInt`; neither
 * reads an expression, and a decimal bound deploys and then fails every
 * submission with `FormFieldConfigurationException`.
 */
export const FORM_BOUND_TEXT = /^-?\d+$/;

/**
 * What `StringUtil.isExpression` counts as one: an opening at the start of
 * the trimmed text. A body with an opening further in is a constant to the
 * engine, and `BpmnParse.parsePriority` fails the deployment on it.
 */
export const EXPRESSION_OPEN = /^\s*[$#]\{/;

/**
 * Written to `datePattern`, which `FormTypes.parseFormPropertyType` reads on
 * a `date` field alone. A type parameter rather than a constraint, so it is
 * not in {@link FORM_CONSTRAINT_NAMES}.
 */
export const DATE_PATTERN_KEY = 'pattern';

/** Everything a form field's parens take, in the order diagnostics list them. */
export const FORM_FIELD_SETTING_KEYS: readonly string[] = [
  ...FORM_CONSTRAINT_NAMES,
  DATE_PATTERN_KEY,
];

/**
 * Soft trigger words: they lex as plain `ID`s rather than keywords, so an
 * unrecognized one is a validator diagnostic, not a parse error. The order is
 * the order diagnostics list them in.
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
 * Every kind with a terminal form. A timer fires off the clock and a condition
 * off data, so neither has anything to throw, and a cancel is written on the
 * end that gives up an `attempt` block.
 */
export const THROW_TRIGGERS = [
  'error',
  'escalation',
  'message',
  'signal',
  'compensation',
] as const;

/**
 * Every kind with a continuing form; an error always ends its path. A link
 * continues at its catch rather than at the next statement here, and `throw`
 * has no link form because a link throw is intermediate, never an end.
 */
export const EMIT_TRIGGERS = [
  'escalation',
  'message',
  'signal',
  'compensation',
  'link',
] as const;

/**
 * The triggers legal behind an event-based gateway. `link` is left out:
 * `BpmnParse.parseIntermediateCatchEvent` addErrors a link catch there, so a
 * plain `await` is the only place one may stand.
 */
export const RACE_TRIGGERS = [
  'message',
  'timer',
  'signal',
  'condition',
] as const;

/**
 * The kinds with a blocking inline catch form: {@link RACE_TRIGGERS} plus
 * `link`, which only a plain `await` may head. Error and escalation travel
 * outward, compensation runs through a subprocess's own `on compensation`
 * body, and a cancel is caught by `on <block>: cancel`.
 */
export const CATCH_TRIGGERS = [...RACE_TRIGGERS, 'link'] as const;

/**
 * The triggers Operaton dispatches a start behaviour for. It ignores an error,
 * escalation, or compensation trigger there and starts as if none were
 * written, so those stay off rather than emitting XML the engine disregards.
 */
export const START_TRIGGERS = [
  'message',
  'signal',
  'timer',
  'condition',
] as const;

/**
 * The two kinds an end event carries rather than raises. A terminate stops
 * every running path of its scope at once; a cancel gives up the `attempt`
 * block it sits in and hands the flow to that block's handler.
 */
export const END_TRIGGERS = ['terminate', 'cancel'] as const;

export interface TriggerPayloadRule {
  readonly code: 'required' | 'optional' | 'forbidden';
  /** Whether the `particle`/`time` clause is required. */
  readonly timer: boolean;
  readonly parens: 'bindings' | 'condition' | 'forbidden';
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

/**
 * An error always interrupts, so it has no `alongside`. `message`/`signal` are
 * name-keyed subscriptions, so the name is required. `compensation` reverses
 * finished work: nothing to catch by name, no flow to run alongside. `cancel`
 * mirrors it, legal only on a host where compensation is legal only without
 * one. `link` opens no `on` handler: it keys the engine's per-file link table
 * by name alone, so it has no handler, boundary, or start form. The
 * `satisfies` clause forces a row per word in {@link ON_TRIGGERS} plus `link`,
 * while the annotation keeps the lookup open to a word of any origin.
 */
export const TRIGGER_PAYLOAD: Readonly<Record<string, TriggerPayloadRule>> = {
  error: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    alongside: false,
    boundary: true,
    hostless: true,
  },
  escalation: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  message: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  signal: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  timer: {
    code: 'forbidden',
    timer: true,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  condition: {
    code: 'forbidden',
    timer: false,
    parens: 'condition',
    alongside: true,
    boundary: true,
    hostless: true,
  },
  compensation: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    alongside: false,
    boundary: false,
    hostless: true,
  },
  cancel: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    alongside: false,
    boundary: true,
    hostless: false,
  },
  link: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: false,
    boundary: false,
    hostless: false,
  },
} satisfies Record<(typeof ON_TRIGGERS)[number] | 'link', TriggerPayloadRule>;

/**
 * The triggers whose payload refers to a declaration rather than carrying a
 * name of its own: `throw error(OUT_OF_STOCK)` names a code declared in the
 * process header, while `message("OrderReceived")` names the subscription the
 * engine keys on and declares nothing. This is the pair a bare word in the
 * parens is resolved as a cross-reference under, and {@link namesACode} is the
 * wider question, taking `message` and `signal` too.
 */
export const DECLARED_CODE_TRIGGERS: ReadonlySet<string> = new Set([
  'error',
  'escalation',
]);

/**
 * Whether the trigger names a code, as opposed to reading a timer, a condition,
 * or nothing at all. The completion snippets that scaffold a `"CODE"` string
 * offer exactly the words of their statement that pass.
 */
export function namesACode(trigger: string): boolean {
  const code = TRIGGER_PAYLOAD[trigger]?.code;
  return code === 'required' || code === 'optional';
}

/**
 * Fence-tag aliases and the canonical Operaton `scriptFormat` they normalize
 * to; the printer emits the canonical tag, so `js` round-trips to `javascript`.
 */
export const SCRIPT_FORMAT_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  javascript: 'javascript',
  groovy: 'groovy',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  ruby: 'ruby',
  feel: 'feel',
};

/**
 * Split a raw `FENCED_SCRIPT` token into the fence tag
 * {@link SCRIPT_FORMAT_ALIASES} is keyed by and the code body. The tag is the
 * maximal run of ASCII letters after the opening fence, and one line terminator
 * right after it is dropped; nothing else is touched, so indentation and
 * trailing newlines inside the body survive verbatim.
 */
export function splitFencedScript(raw: string): { tag: string; code: string } {
  const inner = raw.slice(3, -3); // strip the opening/closing ``` delimiters
  const tag = /^[a-zA-Z]+/.exec(inner)?.[0] ?? '';
  const rest = inner.slice(tag.length);
  const code = rest.startsWith('\r\n')
    ? rest.slice(2)
    : rest.startsWith('\n')
      ? rest.slice(1)
      : rest;
  return { tag, code };
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
   * The keys this kind owns, in the order they are offered. `label` and
   * `documentation` are both present wherever the element lowers to a BPMN
   * node carrying a diagram name; an `on` handler, a `throw`, and an `emit`
   * have no `label` key, so either written there is an unknown key rather
   * than a dropped one. An `await`'s own name is a grammar identifier for
   * `goto`, not this key: a link pair's element name is stamped from the link
   * name instead.
   */
  readonly own: readonly string[];
  /** {@link own} and the engine settings together, for membership tests. */
  readonly keys: ReadonlySet<string>;
  /**
   * The bare words legal in the parens. Every flag word lexes as a flag
   * wherever parens are written, being a keyword elsewhere in the grammar, so a
   * kind that takes none still needs the empty row to refuse them.
   */
  readonly flags: readonly string[];
  readonly forms: boolean;
  /**
   * Whether the statement takes a `for` clause, and so its parens the
   * {@link RUN_ENGINE_KEYS}: the settings of the job each run gets, written
   * on the `multiInstanceLoopCharacteristics` element the clause lowers to.
   */
  readonly repeats: boolean;
  readonly parameters: boolean;
  /**
   * Whether the kind lowers to an element with an implementation to inject
   * into. It answers for the element's own block: a listener's block follows
   * the listener's own binding, so a task listener carries a field on a kind
   * this says `false` for.
   */
  readonly fields: boolean;
  readonly taskListeners: boolean;
  /**
   * Whether the kind takes an external task's extras: `taskPriority` in the
   * parens, and `property` and `error ... when` lines in the block, each
   * checked against the binding actually written. A thrown message can bind a
   * topic too and takes none of them.
   */
  readonly externalExtras: boolean;
}

/** Derive `keys` from `own` and `repeats` so they cannot disagree. */
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
 * `process` is required on a call, and `binding`/`version` are mutually
 * exclusive version-pinning discriminators for whichever key they sit beside.
 * All of it is checked separately.
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
    own: [
      'label',
      'documentation',
      'assignee',
      'formKey',
      'formRef',
      'binding',
      'version',
      'candidateGroups',
      'candidateUsers',
      'dueDate',
      'followUpDate',
      'priority',
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
  /** The statement as a noun phrase with article, for diagnostics. */
  readonly description: string;
  /**
   * Whether the statement synthesizes a join gateway beside its split, and so
   * takes the {@link JOIN_ENGINE_KEYS}. A loop is one gateway with a
   * back-edge, so its parens take the {@link ENGINE_KEYS} alone.
   */
  readonly join: boolean;
  /**
   * The {@link ENGINE_KEYS} the head does not take: the validator refuses
   * them and completion leaves them out.
   */
  readonly refuses: readonly string[];
}

/**
 * The statements whose parens carry a gateway's engine settings. The head
 * takes the {@link ENGINE_KEYS} for the split, the loop gateway, or the
 * event-based gateway, less what its row refuses.
 */
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

/**
 * A host-less `on` handler lowers to an event sub-process, so it carries
 * parameters as a `subprocess` does. A hosted one lowers to a boundary event,
 * which has none, and keeps the plain row.
 */
const EVENT_SUB_PROCESS_RULE: AttributeBlockRule = {
  ...ATTRIBUTE_BLOCK_RULES.OnHandler,
  parameters: true,
};

export function listenerEventsFor(rule: AttributeBlockRule): readonly string[] {
  return rule.taskListeners
    ? [...EXECUTION_LISTENER_EVENTS, ...TASK_LISTENER_EVENTS]
    : EXECUTION_LISTENER_EVENTS;
}

/** The directions a member of this kind's block is written with. */
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
 * The `attempt` head takes the same block as `subprocess`, so only the noun
 * differs. It stays out of {@link ATTRIBUTE_BLOCK_RULES} because that map is
 * keyed by AST type and the two heads share one, so a diagnostic enumerating
 * the kinds a setting is legal on adds it back alongside the map's rows.
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
  if (rule && isOnHandler(node) && node.host === undefined) {
    return EVENT_SUB_PROCESS_RULE;
  }
  if (rule && isSubProcess(node) && node.transactional) {
    return ATTEMPT_BLOCK_RULE;
  }
  return rule;
}
