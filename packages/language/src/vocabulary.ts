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

/** An English "or" clause: `a`, `b`, or `c`. */
export function formatPlainWordList(words: readonly string[]): string {
  if (words.length === 1) return words[0]!;
  if (words.length === 2) return `${words[0]} or ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, or ${words[words.length - 1]}`;
}

/** The same clause with every word quoted: `'a'`, `'b'`, or `'c'`. */
export function formatWordList(words: readonly string[]): string {
  return formatPlainWordList(words.map((w) => `'${w}'`));
}

/** The engine execution settings Operaton reads off any flow node. */
export const ENGINE_KEYS: readonly string[] = [
  'asyncBefore',
  'asyncAfter',
  'exclusive',
  'jobPriority',
  'retryCycle',
];

/**
 * Exactly one of these binds a service task. `topic` delegates to an external
 * worker polling the engine rather than the engine invoking the binding.
 */
export const SERVICE_TASK_BINDING_KEYS: readonly string[] = [
  'class',
  'expression',
  'delegate',
  'topic',
];

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

/** How a call or a decision step pins which deployed version the engine runs. */
export const CALL_BINDING_VALUES: readonly string[] = ['latest', 'deployment'];

/** The only key a process header carries; `label` has a declaration of its own. */
export const PROCESS_HEADER_KEYS: readonly string[] = ['versionTag'];

export const IO_DIRECTIONS: readonly string[] = ['input', 'output'];

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

/** Legal on every element with an attribute block, since each lowers to a flow node. */
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
 * The form-field subset of `VarType`, in vendor-neutral spellings: `number`
 * becomes the Operaton `long` at export, and `json`/`any` have no
 * `operaton:formField` representation at all.
 */
export const FORM_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
] as const;

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

/** Every kind with a continuing form; an error always ends its path. */
export const EMIT_TRIGGERS = [
  'escalation',
  'message',
  'signal',
  'compensation',
] as const;

/**
 * The kinds with a blocking inline catch form. Error and escalation travel
 * outward, compensation runs through a subprocess's own `on compensation`
 * body, and a cancel is caught by `on <block>: cancel`.
 */
export const CATCH_TRIGGERS = [
  'message',
  'timer',
  'signal',
  'condition',
] as const;

/**
 * The triggers Operaton starts a process on. It ignores an error, escalation,
 * or compensation trigger there and starts as if none were written, so those
 * stay off rather than emitting XML the engine disregards.
 */
export const START_TRIGGERS = ['message', 'signal', 'timer'] as const;

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
 * one. The `satisfies` clause forces a row per word in {@link ON_TRIGGERS}
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
} satisfies Record<(typeof ON_TRIGGERS)[number], TriggerPayloadRule>;

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

/** Each carries `attrs`, `params`, and `listeners`; all but `call` also carry `forms`. */
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
  /** The keys this kind owns, in the order they are offered. */
  readonly own: readonly string[];
  /** {@link own} and the engine settings together, for membership tests. */
  readonly keys: ReadonlySet<string>;
  readonly forms: boolean;
  readonly parameters: boolean;
  readonly taskListeners: boolean;
}

/** Derive `keys` from `own` so the two cannot disagree. */
function withKeys(spec: Omit<AttributeBlockRule, 'keys'>): AttributeBlockRule {
  return { ...spec, keys: new Set([...ENGINE_KEYS, ...spec.own]) };
}

/**
 * `process` is required on a call, and `binding`/`version` there are mutually
 * exclusive version-pinning discriminators, all checked separately.
 */
export const ATTRIBUTE_BLOCK_RULES: Readonly<
  Record<AttributeOwner['$type'], AttributeBlockRule>
> = {
  StartEvent: withKeys({
    description: 'a start event',
    own: [],
    forms: true,
    parameters: false,
    taskListeners: false,
  }),
  EndEvent: withKeys({
    description: 'an end event',
    own: [],
    forms: false,
    parameters: false,
    taskListeners: false,
  }),
  UserTask: withKeys({
    description: 'a user task',
    own: [
      'assignee',
      'formKey',
      'candidateGroups',
      'candidateUsers',
      'dueDate',
      'followUpDate',
      'priority',
    ],
    forms: true,
    parameters: true,
    taskListeners: true,
  }),
  ServiceTask: withKeys({
    description: 'a service task',
    own: [...SERVICE_TASK_BINDING_KEYS, 'resultVariable'],
    forms: false,
    parameters: true,
    taskListeners: false,
  }),
  ScriptTask: withKeys({
    description: 'a script task',
    own: ['resultVariable'],
    forms: false,
    parameters: true,
    taskListeners: false,
  }),
  GenericTask: withKeys({
    description: 'a step',
    own: [],
    forms: false,
    parameters: true,
    taskListeners: false,
  }),
  SendTask: withKeys({
    description: 'a send task',
    own: [...SERVICE_TASK_BINDING_KEYS, 'resultVariable'],
    forms: false,
    parameters: true,
    taskListeners: false,
  }),
  ReceiveTask: withKeys({
    description: 'a receive task',
    own: ['message'],
    forms: false,
    parameters: true,
    taskListeners: false,
  }),
  BusinessRuleTask: withKeys({
    description: 'a decision step',
    own: [
      ...BUSINESS_RULE_BINDING_KEYS,
      'binding',
      'version',
      'mapDecisionResult',
      'resultVariable',
    ],
    forms: false,
    parameters: true,
    taskListeners: false,
  }),
  SubProcess: withKeys({
    description: 'a subprocess',
    own: [],
    forms: false,
    parameters: true,
    taskListeners: false,
  }),
  CallActivity: withKeys({
    description: 'a call',
    own: ['process', 'binding', 'version', 'businessKey'],
    forms: false,
    parameters: true,
    taskListeners: false,
  }),
  OnHandler: withKeys({
    description: 'an event handler',
    own: [],
    forms: false,
    parameters: false,
    taskListeners: false,
  }),
  // The binding keys carry the implementation that makes the engine really
  // send a thrown message; the validator holds them to the `message` trigger.
  ThrowStatement: withKeys({
    description: 'a throw statement',
    own: [...SERVICE_TASK_BINDING_KEYS],
    forms: false,
    parameters: false,
    taskListeners: false,
  }),
  EmitStatement: withKeys({
    description: 'an emit statement',
    own: [...SERVICE_TASK_BINDING_KEYS],
    forms: false,
    parameters: false,
    taskListeners: false,
  }),
  IntermediateCatchEvent: withKeys({
    description: 'an awaited event',
    own: [],
    forms: false,
    parameters: false,
    taskListeners: false,
  }),
  // The same catch element with a body, so it takes the same keys.
  RaceBranch: withKeys({
    description: 'a branch of an await block',
    own: [],
    forms: false,
    parameters: false,
    taskListeners: false,
  }),
};

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
