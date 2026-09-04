/**
 * The words BPMNscript accepts and where each one is legal. The grammar takes
 * any word in these positions; the validator rejects one out of place and the
 * completion provider offers the ones that fit, both from these tables.
 *
 * Every trigger list is a literal tuple. A table or a dispatch keyed by one of
 * them therefore either carries an entry for every word or fails to compile,
 * which is what keeps a word from being admitted here and then handled
 * nowhere.
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
 * the grammar itself so the set stays correct as keywords change. A keyword's
 * lexer token is named after its literal value, so these strings match a token
 * type name as well as the source text. Operators (`&&`, `+`, `{`) are
 * excluded: they cannot be mistaken for a name. Memoized per grammar, since
 * every caller passes the one the services were built from.
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

/** A quoted English "or" clause: `'a'`, `'b'`, or `'c'`. */
export function formatWordList(words: readonly string[]): string {
  const quoted = words.map((w) => `'${w}'`);
  if (quoted.length === 1) return quoted[0]!;
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`;
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
 * worker that polls the engine instead of the engine invoking the binding.
 */
export const SERVICE_TASK_BINDING_KEYS: readonly string[] = [
  'class',
  'expression',
  'delegate',
  'topic',
];

/**
 * A decision step binds either to a decision table or, like a service task, to
 * code. The engine requires one of them, and treats a decision key as the
 * discriminator when both are written.
 */
export const BUSINESS_RULE_BINDING_KEYS: readonly string[] = [
  ...SERVICE_TASK_BINDING_KEYS,
  'decision',
];

/** What lands in `resultVariable`: one entry, one row, one column, or every row. */
export const DECISION_RESULT_MAPPINGS: readonly string[] = [
  'singleEntry',
  'singleResult',
  'collectEntries',
  'resultList',
];

/**
 * The service-task rule minus the external `topic`. A fenced script body binds
 * a listener too, replacing the whole brace block.
 */
export const LISTENER_BINDING_KEYS: readonly string[] = [
  'class',
  'expression',
  'delegate',
];

/** The only key a process header carries; `label` has a declaration of its own. */
export const PROCESS_HEADER_KEYS: readonly string[] = ['versionTag'];

export const IO_DIRECTIONS: readonly string[] = ['input', 'output'];

export const TIMER_PARTICLES: readonly string[] = ['after', 'at', 'every'];

export const EVENT_BINDING_FIELDS: readonly string[] = ['code', 'message'];

/** Legal on every element with an attribute block, since each lowers to a flow node. */
export const EXECUTION_LISTENER_EVENTS: readonly string[] = ['start', 'end'];

/** Legal on a user task alone; `timeout` is the one carrying a timer clause. */
export const TASK_LISTENER_EVENTS: readonly string[] = [
  'create',
  'assign',
  'complete',
  'update',
  'delete',
  'timeout',
];

/**
 * Soft trigger words: they lex as plain `ID`s rather than keywords, so an
 * unrecognized one is a validator diagnostic, not a parse error. The order is
 * the order diagnostics list them in. The literal type is what makes the
 * validator's payload table carry a row for every word, since a word without
 * one would leave its payload rules unenforced.
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
 * off data, so neither has anything to throw. A cancel is not thrown either:
 * it is written on the end that gives up an `attempt` block.
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
 * The kinds with a blocking inline catch form. Error and escalation are raised
 * outward with `throw`/`emit`, compensation runs through a subprocess's own
 * `on compensation` body, and a cancel is caught by `on <block>: cancel`, so
 * none of them can be awaited.
 */
export const CATCH_TRIGGERS = [
  'message',
  'timer',
  'signal',
  'condition',
] as const;

/**
 * The three triggers Operaton starts a process on. It ignores an error,
 * escalation, or compensation trigger there and starts the process as if none
 * were written, so those stay off this list rather than emitting XML the engine
 * disregards.
 */
export const START_TRIGGERS = ['message', 'signal', 'timer'] as const;

/**
 * The two kinds an end event carries rather than raises. A terminate stops
 * every running path of its scope at once; a cancel gives up the `attempt`
 * block it sits in and hands the flow to that block's handler. Every other
 * kind is written with `throw`. The literal type is what makes the validator's
 * message table carry a row for every word.
 */
export const END_TRIGGERS = ['terminate', 'cancel'] as const;

/**
 * Fence-tag aliases and the canonical Operaton `scriptFormat` they normalize
 * to. The printer emits the canonical tag, so a round-trip turns `js` into
 * `javascript`.
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
 * {@link SCRIPT_FORMAT_ALIASES} is keyed by and the inner code body. The tag is
 * the maximal run of ASCII letters after the opening fence. One line terminator
 * directly after the tag is dropped; nothing else is touched, so indentation
 * and trailing newlines inside the body survive verbatim. A same-line fence
 * (` ```jsfoo``` `) has no split: the whole letter run is the tag and the body
 * is empty.
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
  | IntermediateCatchEvent;

/** One row per statement that takes a block, so a new element kind is a new row. */
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
};

/**
 * A host-less `on` handler lowers to an event sub-process, so it carries
 * `input`/`output` parameters exactly as a `subprocess` does. A hosted handler
 * lowers to a boundary event, which has none, and keeps the plain row.
 */
const EVENT_SUB_PROCESS_RULE: AttributeBlockRule = {
  ...ATTRIBUTE_BLOCK_RULES.OnHandler,
  parameters: true,
};

/** The two execution points every flow node has, plus the user task's lifecycle events. */
export function listenerEventsFor(rule: AttributeBlockRule): readonly string[] {
  return rule.taskListeners
    ? [...EXECUTION_LISTENER_EVENTS, ...TASK_LISTENER_EVENTS]
    : EXECUTION_LISTENER_EVENTS;
}

/**
 * The `attempt` head takes the same block as `subprocess`, so only the noun the
 * diagnostics name it by differs. It stays out of {@link ATTRIBUTE_BLOCK_RULES}
 * because the map is keyed by AST type and the two heads share one, so a
 * diagnostic enumerating the kinds a block setting is legal on has to add it
 * back alongside the map's own rows.
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
