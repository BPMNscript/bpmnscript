/**
 * The words BPMNscript accepts and where each one is legal. The grammar takes
 * any word in these positions; the validator rejects one out of place and the
 * completion provider offers the ones that fit, both from these tables.
 */

import type { AstNode } from 'langium';
import { isOnHandler } from './generated/ast.js';
import type {
  CallActivity,
  EmitStatement,
  EndEvent,
  IntermediateCatchEvent,
  OnHandler,
  ScriptTask,
  ServiceTask,
  StartEvent,
  SubProcess,
  ThrowStatement,
  UserTask,
} from './generated/ast.js';

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
 * unrecognised one is a validator diagnostic, not a parse error. The order is
 * the order diagnostics list them in.
 */
export const ON_TRIGGERS: readonly string[] = [
  'error',
  'escalation',
  'message',
  'signal',
  'timer',
  'condition',
  'compensation',
];

/**
 * Every kind with a terminal form. A message arrives through the engine's
 * correlation API, a timer fires off the clock, and a condition off data, so
 * none of them has anything to throw.
 */
export const THROW_TRIGGERS: readonly string[] = [
  'error',
  'escalation',
  'signal',
  'compensation',
];

/** Every kind with a continuing form; an error always ends its path. */
export const EMIT_TRIGGERS: readonly string[] = [
  'escalation',
  'signal',
  'compensation',
];

/**
 * The kinds with a blocking inline catch form. Error and escalation are raised
 * outward with `throw`/`emit`, and compensation runs through a subprocess's own
 * `on compensation` body, so none of the three can be awaited.
 */
export const CATCH_TRIGGERS: readonly string[] = [
  'message',
  'timer',
  'signal',
  'condition',
];

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
  ThrowStatement: withKeys({
    description: 'a throw statement',
    own: [],
    forms: false,
    parameters: false,
    taskListeners: false,
  }),
  EmitStatement: withKeys({
    description: 'an emit statement',
    own: [],
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

export function attributeBlockRuleOf(
  node: AstNode,
): AttributeBlockRule | undefined {
  const rules: Readonly<Record<string, AttributeBlockRule>> =
    ATTRIBUTE_BLOCK_RULES;
  const rule = rules[node.$type];
  if (rule && isOnHandler(node) && node.host === undefined) {
    return EVENT_SUB_PROCESS_RULE;
  }
  return rule;
}
