/**
 * Validation checks for the BPMNscript AST, all registered through
 * {@link registerValidationChecks}.
 *
 * The checks fall into four families: structural checks (one process per
 * file, start-event position, empty bodies/blocks, goto into a parallel
 * branch), naming and id-collision checks (reserved synthesised-id patterns,
 * duplicate variable/label/statement names), variable and expression checks
 * (undeclared-variable warning, operator/type mismatch against the declared
 * Operaton-aligned types), and attribute checks (duplicate keys, allowed keys
 * per element kind, the service-task `class` requirement). Diagnostics attach
 * to the most specific property of the offending node (usually `name`, `key`,
 * or the offending operand).
 *
 * Attribute checks additionally cover the service-task binding discriminant
 * (`class`/`expression`/`delegate`/`topic`, exactly one required) and the
 * script-task fence (a supported language tag, a non-empty body).
 */

import {
  AstUtils,
  type AstNode,
  type ValidationAcceptor,
  type ValidationChecks,
} from 'langium';
import type {
  Additive,
  Attribute,
  Block,
  BpmnScriptAstType,
  CallActivity,
  DoWhileStatement,
  EmitStatement,
  EndEvent,
  ErrorDecl,
  Expr,
  FormBlock,
  GotoStatement,
  IfStatement,
  IntermediateCatchEvent,
  Logical,
  Model,
  Multiplicative,
  OnHandler,
  ParallelStatement,
  Process,
  Relational,
  ScriptTask,
  ServiceTask,
  StartEvent,
  Statement,
  SubProcess,
  ThrowStatement,
  UserTask,
  VarType,
  WhileStatement,
} from './generated/ast.js';
import {
  isAdditive,
  isAttribute,
  isBlock,
  isCallActivity,
  isDoWhileStatement,
  isEmitStatement,
  isEndEvent,
  isErrorDecl,
  isExpr,
  isGotoStatement,
  isIfStatement,
  isLiteralString,
  isLogical,
  isMultiplicative,
  isOnHandler,
  isParallelStatement,
  isProcess,
  isProcessLabel,
  isRelational,
  isScriptTask,
  isServiceTask,
  isStartEvent,
  isSubProcess,
  isThrowStatement,
  isUserTask,
  isVarDecl,
  isVariableMapping,
  isVarRef,
  isWhileStatement,
} from './generated/ast.js';
import type { BpmnScriptServices } from './bpmn-script-module.js';
import { enclosingFlowContainer } from './bpmn-script-scope-provider.js';
import type { VariableSymbolProvider } from './variable-symbol-provider.js';

/**
 * Register the BPMNscript validation checks against the AST node types.
 *
 * @param services The fully-injected language services (provides the validator
 *   instance and the validation registry).
 */
export function registerValidationChecks(services: BpmnScriptServices) {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.BpmnScriptValidator;
  const checks: ValidationChecks<BpmnScriptAstType> = {
    Model: validator.checkModel,
    Process: validator.checkProcess,
    StartEvent: validator.checkStartEvent,
    UserTask: validator.checkUserTaskAttributes,
    ServiceTask: validator.checkServiceTaskAttributes,
    ScriptTask: validator.checkScriptTask,
    IfStatement: validator.checkIfStatement,
    WhileStatement: validator.checkWhileStatement,
    DoWhileStatement: validator.checkDoWhileStatement,
    ParallelStatement: validator.checkParallelStatement,
    GotoStatement: validator.checkGotoStatement,
    SubProcess: validator.checkSubProcess,
    CallActivity: validator.checkCallActivity,
    OnHandler: validator.checkOnHandler,
    ThrowStatement: validator.checkThrowStatement,
    EmitStatement: validator.checkEmitStatement,
    IntermediateCatchEvent: validator.checkIntermediateCatchEvent,
  };
  registry.register(checks, validator);
}

/**
 * The legal attribute keys per element kind. The grammar accepts any key on
 * any element (a single `AttrKey` datatype rule); the validator restricts them.
 */
const USER_TASK_KEYS: ReadonlySet<string> = new Set(['assignee', 'formKey']);

/**
 * The service-task attribute keys. Every one of them is a binding key — a
 * service task must declare exactly one — so this set doubles as both the
 * allowed-keys set and the binding-key set (see
 * {@link BpmnScriptValidator.checkServiceTaskAttributes}). `topic` is the
 * fourth binding: it delegates the task to an external worker that polls the
 * engine for that topic, instead of the engine invoking `class`/`expression`/
 * `delegate` directly.
 */
const SERVICE_TASK_KEYS: ReadonlySet<string> = new Set([
  'class',
  'expression',
  'delegate',
  'topic',
]);

/**
 * The `call` attribute keys. `process` (the callee) is required; `binding`
 * and `version` are the mutually exclusive version-pinning discriminators;
 * `businessKey` sets the started process instance's business key. See
 * {@link BpmnScriptValidator.checkCallActivity}.
 */
const CALL_ACTIVITY_KEYS: ReadonlySet<string> = new Set([
  'process',
  'binding',
  'version',
  'businessKey',
]);

/**
 * The legal `binding` values (bare identifiers, read like the `latest`/
 * `deployment` process-engine binding modes).
 */
const CALL_BINDING_VALUES: ReadonlySet<string> = new Set([
  'latest',
  'deployment',
]);

/**
 * Attribute keys whose value identifies something other than a process
 * variable — a Java class, a form id, an EL binding, a worker topic, a called
 * process id, or a binding/version discriminant — so a bareword value there
 * must not trigger the undeclared-variable warning (see
 * {@link BpmnScriptValidator.checkExpression}). `businessKey` is deliberately
 * NOT included: a bare identifier there renders as a `${var}` JUEL expression
 * (the same reasoning as `assignee`), so it is a real variable reference.
 */
const NON_VARIABLE_ATTR_KEYS: ReadonlySet<string> = new Set([
  'class',
  'formKey',
  'expression',
  'delegate',
  'topic',
  'process',
  'binding',
  'version',
]);

/**
 * Accepted fence-tag aliases for a `script` task body. Mirrors
 * `ast-to-ir.ts`'s `SCRIPT_FORMAT_ALIASES` key set, which normalizes these
 * same tags to a canonical Operaton `scriptFormat`. Duplicated here (rather
 * than imported) because the validator lives in `packages/language`, which
 * cannot depend on `packages/transform`.
 */
const SUPPORTED_SCRIPT_TAGS: ReadonlySet<string> = new Set([
  'javascript',
  'js',
  'groovy',
  'python',
  'py',
  'ruby',
  'rb',
  'feel',
]);

/**
 * The per-trigger payload contract for an `on` handler: whether the STRING
 * head (`code`, immediately after the trigger word) is required, optional,
 * or forbidden; whether the timer particle clause (`particle` + `time`) is
 * required; what the parenthesized `(…)` slot may legally hold; whether a
 * non-interrupting `alongside` handler is legal; and whether the trigger may
 * name a host and attach as a `bpmn:boundaryEvent` at all. One record per
 * trigger word (the payload matrix), consumed by two checks — {@link
 * BpmnScriptValidator.checkHandlerPayload} for the code/timer/parens shape,
 * {@link BpmnScriptValidator.checkHandlerHost} for the boundary dimension —
 * that each walk a handler's properties against its row, so a new trigger
 * kind is a new row, not a new rule.
 */
interface TriggerPayloadRule {
  /** Whether the trigger's STRING head is required, optional, or forbidden. */
  readonly code: 'required' | 'optional' | 'forbidden';
  /** Whether the `particle`/`time` clause (`after`/`at`/`every` + a time string) is required. */
  readonly timer: boolean;
  /** What the parenthesized `(…)` slot may legally hold. */
  readonly parens: 'bindings' | 'condition' | 'forbidden';
  /** Whether a non-interrupting `alongside` handler is legal. */
  readonly alongside: boolean;
  /**
   * Whether the trigger may name a host and attach as a `bpmn:boundaryEvent`
   * instead of guarding its whole enclosing container. `false` only for
   * `compensation`: a compensation handler undoes a subprocess's
   * already-completed work through `bpmn:association`/`isForCompensation`, a
   * different attachment mechanism entirely, which this language surfaces as
   * the subprocess's own undo block rather than as something with a host.
   */
  readonly boundary: boolean;
}

/**
 * The soft trigger words `on` accepts, each mapped to its payload contract.
 * `error`/`escalation` read like a `catch` clause (an optional code,
 * optional catch-parameter bindings; `error` has no `alongside` since an
 * error always interrupts). `message`/`signal` are name-keyed subscriptions
 * — the engine matches by name, so the name is required and there is no
 * catch-all. `timer` reads its payload from the particle clause instead of
 * a code string. `condition` reads its payload from the parenthesized
 * expression instead of a code string. `compensation` is the undo block for
 * a subprocess's already-completed work: it takes no code, no bindings, and
 * no `alongside` — there is nothing to catch by name, and no running flow
 * to interrupt alongside, only finished work to reverse. These words lex as
 * plain `ID`s (not grammar keywords), so an unrecognised word is a
 * validator diagnostic, not a parse error.
 */
const TRIGGER_PAYLOAD: Readonly<Record<string, TriggerPayloadRule>> = {
  error: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    alongside: false,
    boundary: true,
  },
  escalation: {
    code: 'optional',
    timer: false,
    parens: 'bindings',
    alongside: true,
    boundary: true,
  },
  message: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
  },
  signal: {
    code: 'required',
    timer: false,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
  },
  timer: {
    code: 'forbidden',
    timer: true,
    parens: 'forbidden',
    alongside: true,
    boundary: true,
  },
  condition: {
    code: 'forbidden',
    timer: false,
    parens: 'condition',
    alongside: true,
    boundary: true,
  },
  compensation: {
    code: 'forbidden',
    timer: false,
    parens: 'forbidden',
    alongside: false,
    boundary: false,
  },
};

/** The legal `on` trigger words — the keys of {@link TRIGGER_PAYLOAD}. */
const ON_TRIGGERS: readonly string[] = Object.keys(TRIGGER_PAYLOAD);
const ON_TRIGGERS_SET: ReadonlySet<string> = new Set(ON_TRIGGERS);

/**
 * The legal `throw` trigger words: every kind with a terminal form. A
 * message arrives via the engine's correlation API, a timer fires off the
 * clock, and a condition fires off data — there is nothing for any of them
 * to throw. `compensation` throws the undo block of the nearest completed
 * subprocess; it carries no code (see {@link checkThrowEmitCode}).
 */
const THROW_TRIGGERS: readonly string[] = [
  'error',
  'escalation',
  'signal',
  'compensation',
];

/**
 * The legal `emit` trigger words: every kind with a continuing
 * (fire-and-keep-going) form. An error always ends its path, so it has no
 * `emit` form. `compensation` also fires and keeps going — reversing
 * completed work does not itself end the flow.
 */
const EMIT_TRIGGERS: readonly string[] = [
  'escalation',
  'signal',
  'compensation',
];

/**
 * The legal `await` trigger words: the four kinds with a blocking inline
 * catch form. Error and escalation are raised outward with `throw`/`emit`,
 * never awaited; compensation is a subprocess's undo block, run through its
 * own `on compensation` body, not a wait — none of the three has a catch
 * form for `await` to accept.
 */
const CATCH_TRIGGERS: readonly string[] = [
  'message',
  'timer',
  'signal',
  'condition',
];
const CATCH_TRIGGERS_SET: ReadonlySet<string> = new Set(CATCH_TRIGGERS);

/** The legal timer particle words, each mapping 1:1 to one BPMN timer shape. */
const TIMER_PARTICLES: ReadonlySet<string> = new Set(['after', 'at', 'every']);

/** The legal catch-binding `field` words inside an `on (…)` list. */
const EVENT_BINDING_FIELDS: ReadonlySet<string> = new Set(['code', 'message']);

/** The name-less `on message`/`on signal` teaching text. */
const MESSAGELESS_NAME_MESSAGE =
  "A message handler needs the message's name — the engine matches messages by name.";

/** The payload-less (or STRING-instead-of-particle) `on timer` teaching text. */
const TIMER_PAYLOAD_MESSAGE =
  `A timer needs to know how to read the time: write 'after "PT1H"', ` +
  `'at "2026-08-01T09:00:00"', or 'every "R/PT10M"'.`;

/** The condition-less `on condition` teaching text. */
const CONDITION_REQUIRED_MESSAGE =
  "A condition handler needs its condition: 'on condition (amount > 100)'.";

/** A code string on `on condition`, whose payload lives in the parens instead. */
const CONDITION_NO_CODE_MESSAGE =
  "A condition handler takes no code string — write the condition in parentheses: 'on condition (amount > 100)'.";

/** A condition expression in the parens of a trigger that does not read one. */
const CONDITION_ONLY_MESSAGE =
  "Only 'on condition' takes a condition expression.";

/** A timer particle clause on a trigger that does not read one. */
const PARTICLE_ONLY_MESSAGE = "Only 'on timer' takes a particle.";

/** The name-less `await message`/`await signal` teaching text. */
const CATCH_NAME_REQUIRED_MESSAGE =
  "An awaited message needs the message's name — the engine matches messages by name.";

/** The parens-less `await condition` teaching text. */
const CATCH_CONDITION_REQUIRED_MESSAGE =
  "An awaited condition needs its condition: 'await condition (amount > 100)'.";

/** A code string on `await condition`, whose payload lives in the parens instead. */
const CATCH_CONDITION_NO_CODE_MESSAGE =
  "An awaited condition takes no code string — write the condition in parentheses: 'await condition (amount > 100)'.";

/** A condition expression in the parens of a catch trigger that does not read one. */
const CATCH_CONDITION_ONLY_MESSAGE =
  "Only 'await condition' takes a condition expression.";

/** A timer particle clause on a catch trigger that does not read one. */
const CATCH_PARTICLE_ONLY_MESSAGE = "Only 'await timer' takes a particle.";

/** A message reaches this process from outside — `throw`/`emit` has nothing to send. */
const MESSAGE_NOTHING_TO_SEND_MESSAGE =
  "A message reaches this process from outside — there is nothing to send; write a message handler with 'on message'.";

/** A STRING on `on compensation`, which carries no code or name at all. */
const COMPENSATION_NO_CODE_MESSAGE =
  "Compensation has no code or name — 'on compensation { }' is the undo block for this subprocess; omit the string.";

/** `(code c)` bindings on `on compensation`, which carries no values at all. */
const COMPENSATION_BINDINGS_MESSAGE =
  "'(code c)' bindings belong to error and escalation handlers — compensation carries no values.";

/** `alongside` on `on compensation`: the work it reverses has already finished. */
const COMPENSATION_ALONGSIDE_MESSAGE =
  'The work an undo block reverses has already finished — there is no ' +
  "running flow to run alongside; remove 'alongside'.";

/** `on compensation` sitting anywhere but directly inside a `subprocess` body. */
const COMPENSATION_PLACEMENT_MESSAGE =
  "An undo block belongs directly inside the 'subprocess' whose work it " +
  'undoes — a process cannot undo itself.';

/** A second `on compensation` in one container — a subprocess has exactly one undo block. */
const COMPENSATION_DUPLICATE_MESSAGE =
  'A subprocess has one undo block — merge the steps.';

/** `on <host>: compensation` — compensation has no boundary form at all. */
const COMPENSATION_HOST_MESSAGE =
  "Compensation cannot attach to a host — it undoes a subprocess's " +
  'already-completed work through its own undo block, not through a ' +
  "boundary event; remove the host and write 'on compensation { … }' " +
  'directly inside the subprocess it reverses.';

/**
 * The {@link VarType}s an Operaton form field can carry. `json`/`any` have no
 * `operaton:formField` representation, so the grammar's permissive `VarType` is
 * restricted here.
 */
const FORM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'date',
]);

/**
 * Patterns for synthesised element ids produced by the `astToIr` desugarer
 * (`packages/transform/src/synthesize-ids.ts`). These prefixes are reserved —
 * an author-chosen statement name matching any of them would collide with a
 * desugarer-generated id, producing duplicate-id IR. Gateway ids in particular
 * bypass the `taken`/`resolveCollision` guard (see `ast-to-ir.ts` STRUCTURAL-
 * COORDINATE SCHEME docstring), so the guard must be applied here.
 *
 * Patterns are anchored.
 *
 * Synthesised flow ids always carry at least two trailing segments
 * (`Flow_<src>_<tgt>` and `Flow_<gatewayId>_default`) and are only assigned
 * to `SequenceFlow.id` — they never appear in the node-name namespace. A
 * single-segment name such as `Flow_Control` therefore cannot collide with
 * any synthesised id, so only the two-segment shape is reserved
 * (`/^Flow_.+_.+$/`).
 *
 * `Throw_` and `EventSubProcess_` are the unnamed `throw`/`emit`/`on`
 * positional ids (see `synthesize-ids.ts`'s `makeThrowEventId`/
 * `makeEventSubProcessId`): they bypass collision resolution the same way
 * gateway ids do, so an author-chosen name with either prefix is reserved
 * the same way.
 *
 * `Boundary_` is the host-derived id a hosted `on <Host>: <trigger>` handler
 * synthesises (see `synthesize-ids.ts`'s `makeBoundaryEventId`). It runs
 * through the same `taken`/`resolveCollision` guard as `StartEvent_`/
 * `EndEvent_` rather than bypassing it, but an author-chosen name with this
 * prefix would still be silently renamed with a numeric suffix on collision
 * instead of being flagged, so it is reserved the same way as every other
 * synthesised prefix here.
 */
const RESERVED_ID_PATTERNS: ReadonlyArray<RegExp> = [
  /^Gateway_.+_(split|join|fork|loop)$/,
  /^Flow_.+_.+$/,
  /^StartEvent_/,
  /^EndEvent_/,
  /^Throw_/,
  /^EventSubProcess_/,
  /^Boundary_/,
  /^Catch_/,
];

/**
 * The internal type lattice used by the type-mismatch check. It is the Operaton
 * variable types plus the literal-derived categories and the `unknown` top used
 * for anything we cannot (or deliberately do not) constrain.
 *
 * `any`/`json`/`unknown` are compatible with every operator (Operaton coerces),
 * so they never trigger a mismatch — keeping the lattice small and false
 * positives out.
 */
type ExprType = VarType | 'unknown';

/** Types that participate in arithmetic and ordered comparison without error. */
const NUMERIC_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'number',
  'any',
  'json',
  'unknown',
]);
/** Types that are valid operands of an ordered comparison (`< <= > >=`). */
const ORDERED_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'number',
  'date',
  'any',
  'json',
  'unknown',
]);

/**
 * The concrete `Statement` subtypes that carry a `name` and are therefore valid
 * `goto` targets. Shared by the reserved-name check and the duplicate-name
 * check so both address exactly the same set of nodes (expression `VarRef`s
 * are never part of this set). `SubProcess` is included: its name is both a
 * goto target (the container's entry point) and the seed for its implicit
 * start/end ids (`StartEvent_<name>`/`EndEvent_<name>`), so it must clear the
 * same reserved-pattern and duplicate-name checks as any other named step.
 * `CallActivity` is included for the same reason: a call is a goto target
 * (`name`) and a leaf step like any other, so it is subject to the same
 * reserved-name, duplicate-name, and reachability checks. `ThrowStatement`/
 * `EmitStatement` are included too, but their `name` is *optional* (the id
 * is synthesised when omitted, see `synthesize-ids.ts`), so every
 * consumer of this type skips an instance whose `name` is `undefined`: an
 * unnamed throw/emit is not a goto target and cannot collide with anything.
 */
type NamedStatement =
  | StartEvent
  | EndEvent
  | UserTask
  | ServiceTask
  | ScriptTask
  | SubProcess
  | CallActivity
  | (ThrowStatement & { name: string })
  | (EmitStatement & { name: string });

/**
 * Collect every goto-targetable named statement in `process`, in document
 * order, regardless of nesting depth (inside `if`/`while`/`parallel`/
 * `subprocess`/`on` blocks). An unnamed `throw`/`emit` (the common case — its
 * id is synthesised) is not a goto target and is excluded.
 *
 * @param process The process to scan.
 * @returns Every `StartEvent`/`EndEvent`/`UserTask`/`ServiceTask`/
 *   `ScriptTask`/`SubProcess`/`CallActivity`/named-`throw`/named-`emit` node.
 */
function collectNamedStatements(process: Process): NamedStatement[] {
  const result: NamedStatement[] = [];
  for (const node of AstUtils.streamAst(process)) {
    if (
      isStartEvent(node) ||
      isEndEvent(node) ||
      isUserTask(node) ||
      isServiceTask(node) ||
      isScriptTask(node) ||
      isSubProcess(node) ||
      isCallActivity(node)
    ) {
      result.push(node);
    } else if (
      (isThrowStatement(node) || isEmitStatement(node)) &&
      node.name !== undefined
    ) {
      // Runtime-verified above: only push a named instance, so the cast to
      // the narrowed (name required) union member is sound.
      result.push(node as NamedStatement);
    }
  }
  return result;
}

/**
 * The names referenced by every `goto` in `process`. A step whose name is in
 * this set is an explicit jump target, and so reachable even when it sits after
 * an `end`/`goto`.
 */
function collectGotoTargetNames(process: Process): Set<string> {
  const names = new Set<string>();
  for (const node of AstUtils.streamAst(process)) {
    if (isGotoStatement(node) && node.target.$refText.length > 0) {
      names.add(node.target.$refText);
    }
  }
  return names;
}

/**
 * The name of a step, or `undefined` for the unnamed constructs (`if`/
 * `while`/`parallel`/`goto`/`on`) and for a `throw`/`emit` whose id was
 * omitted (the common case — an id-less throw/emit is synthesised downstream).
 */
function statementName(stmt: Statement): string | undefined {
  if (
    isStartEvent(stmt) ||
    isEndEvent(stmt) ||
    isUserTask(stmt) ||
    isServiceTask(stmt) ||
    isScriptTask(stmt) ||
    isSubProcess(stmt) ||
    isCallActivity(stmt)
  ) {
    return stmt.name;
  }
  if (isThrowStatement(stmt) || isEmitStatement(stmt)) {
    return stmt.name;
  }
  return undefined;
}

/**
 * The statement lists nested directly inside a compound statement. A
 * `subprocess`/`on` body is a single `Block` (like a loop body — no branch
 * segment), which the manual reachability scan in
 * {@link BpmnScriptValidator.checkUnreachableStatements} relies on to
 * descend into it; `AstUtils.streamAst`-based scans elsewhere in this file
 * already reach a sub-process/handler body for free and need no equivalent
 * branch.
 */
function childBlocks(stmt: Statement): Block[] {
  if (isIfStatement(stmt)) {
    return [
      stmt.then,
      ...stmt.elseIfs.map((e) => e.body),
      ...(stmt.elseBlock ? [stmt.elseBlock] : []),
    ];
  }
  if (isWhileStatement(stmt) || isDoWhileStatement(stmt)) {
    return [stmt.body];
  }
  if (isParallelStatement(stmt)) {
    return stmt.branches;
  }
  if (isSubProcess(stmt) || isOnHandler(stmt)) {
    return [stmt.body];
  }
  return [];
}

/**
 * True when `statements` has no flow step for the desugarer to lower into a
 * start-reachable container: the body is empty, or every statement is an
 * `on` handler. A handler never joins the main sequence (it is a catch
 * block, not a step the flow passes through), so a handler-only body is the
 * same emptiness the zero-statement case is — a lone `on` guards nothing.
 */
function hasNoFlowStep(statements: Statement[]): boolean {
  return statements.every(isOnHandler);
}

/**
 * Whether `stmt`, once reached, always ends or diverts the flow so that
 * nothing after it in the same block is ever reached. The leaf cases are an
 * `end`, `goto`, or `throw`. A compound counts too when it can no longer
 * fall through: an `if` that has an `else` terminates when every branch does
 * — the `then`, every `else if`, and the `else` — and a `parallel`
 * terminates when every one of its branches does. This is the exact case
 * where `lowerIf`/`lowerParallel` in the transform prune the construct's
 * synthesized join to zero incoming flows, so there is no fall-through left
 * to reach. An `if` without an `else` and a `while`/`do-while` never count,
 * however their body ends: their gateway always keeps a non-terminating
 * exit (the implicit else, or the loop's false-condition edge).
 */
function statementTerminates(stmt: Statement): boolean {
  if (isEndEvent(stmt) || isGotoStatement(stmt) || isThrowStatement(stmt)) {
    return true;
  }
  if (isIfStatement(stmt) && stmt.elseBlock !== undefined) {
    return (
      blockTerminates(stmt.then.statements) &&
      stmt.elseIfs.every((elseIf) => blockTerminates(elseIf.body.statements)) &&
      blockTerminates(stmt.elseBlock.statements)
    );
  }
  if (isParallelStatement(stmt)) {
    return stmt.branches.every((branch) => blockTerminates(branch.statements));
  }
  return false;
}

/** Whether every path through `statements` is cut off by a terminator (see {@link statementTerminates}) before falling off the block's end. */
function blockTerminates(statements: Statement[]): boolean {
  return statements.some(
    (stmt) => !isOnHandler(stmt) && statementTerminates(stmt),
  );
}

/**
 * Invoke `onDuplicate` for every item whose key repeats an earlier occurrence.
 * `seen` can be pre-seeded with keys that count as already present before the
 * first item.
 */
function forEachDuplicate<T>(
  items: Iterable<T>,
  key: (item: T) => string,
  onDuplicate: (item: T) => void,
  seen: Set<string> = new Set(),
): void {
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) {
      onDuplicate(item);
    } else {
      seen.add(k);
    }
  }
}

/**
 * Structural + variable + attribute validator for BPMNscript processes.
 */
export class BpmnScriptValidator {
  private readonly variables: VariableSymbolProvider;

  /**
   * @param services The language services; the validator pulls the injected
   *   {@link VariableSymbolProvider} from the references service group so the
   *   symbol-collection seam is shared with any other consumer.
   */
  constructor(services: BpmnScriptServices) {
    this.variables = services.references.VariableSymbolProvider;
  }

  /**
   * Whole-model check: BPMNscript supports one process per file. The grammar
   * permits several so that a stray second `process` block produces a clear
   * diagnostic here rather than being silently dropped by the AST → IR
   * transform, which only converts the first process. Every process after
   * the first is flagged, which also covers reused process names.
   *
   * @param model The parsed model (all top-level processes).
   */
  checkModel = (model: Model, accept: ValidationAcceptor): void => {
    forEachDuplicate(
      model.processes,
      () => 'process',
      (extra) =>
        accept(
          'error',
          'Only one process is supported per file. ' +
            'Move additional processes into separate files.',
          { node: extra, property: 'name' },
        ),
    );
  };

  /**
   * An explicit `start` is only valid as the first statement of a *container*
   * body — the process body, the body of a `subprocess`, or the body of a
   * host-less `on` handler (the desugarer honours a sub-process's/handler's own
   * explicit start/end exactly like the process's; inside a host-less handler,
   * this explicit start is the trigger-carrying start — see
   * {@link checkOnHandler}). Anywhere else — later in a container body, or
   * nested inside an `if`/`while`/`parallel` block at any position — the
   * desugarer gives it an incoming sequence flow, and a start event with
   * incoming flows is invalid BPMN that Operaton rejects at deployment. (A
   * container whose first statement is not a `start` gets an implicit one;
   * that path never conflicts with this check.)
   *
   * A hosted handler's body is not a container of its own: it lowers inline
   * into the host's container and is entered by a flow from the boundary
   * event, so a `start` there would be a second none-start of the process
   * carrying an incoming flow — rejected with its own message.
   */
  private checkStartPosition(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    for (const node of AstUtils.streamAst(process)) {
      if (!isStartEvent(node)) continue;
      if (node === process.body[0]) continue;
      const container = node.$container;
      if (isBlock(container) && container.statements[0] === node) {
        if (isSubProcess(container.$container)) continue;
        if (isOnHandler(container.$container)) {
          if (container.$container.host === undefined) continue;
          accept('error', hostedHandlerStartMessage(node.name), {
            node,
            property: 'name',
          });
          continue;
        }
      }
      accept(
        'error',
        `'start ${node.name}' must be the first statement of its process, subprocess, or event-handler body. ` +
          'A start event cannot have incoming flows.',
        { node, property: 'name' },
      );
    }
  }

  /**
   * Process-level checks: the no-flow-step structural edge case, the variable
   * checks (undeclared warning, type-mismatch error) over every expression in
   * the process, and the whole-process integrity checks (duplicate variable
   * name, duplicate process label, duplicate statement name). Variable checks
   * run here, not per-`VarRef`, because variable visibility is *process-scoped*
   * and *position-independent* — the symbol table is built once per process and
   * consulted for every reference.
   *
   * @param process The process to validate.
   */
  checkProcess = (process: Process, accept: ValidationAcceptor): void => {
    // Structural: implicit start/end make a missing start/end impossible, but
    // a body with no flow step at all — empty, or every statement an `on`
    // handler — never starts a process (handlers alone never open one), so
    // it is rejected outright rather than silently lowering to a bare,
    // pointless start-end pair.
    if (hasNoFlowStep(process.body)) {
      accept(
        'error',
        `Process '${process.name}' has no flow steps: a process needs at least one step on its main flow (handlers alone do not start a process).`,
        { node: process, property: 'name' },
      );
    }

    const symbols = this.variables.collect(process);

    // Walk every expression in the process and run the variable checks. The
    // symbol table is flat/process-scoped, so a single table serves every
    // reference regardless of where the `var` was declared (position-independent).
    for (const expr of collectExpressions(process)) {
      this.checkExpression(expr, symbols, accept);
    }

    // Structural: an explicit `start` anywhere but first would deploy as
    // invalid BPMN (see checkStartPosition).
    this.checkStartPosition(process, accept);

    const named = collectNamedStatements(process);

    // Check every named statement for reserved synthesised-id name patterns.
    this.checkReservedNames(named, accept);

    // Whole-process integrity: duplicate declarations and duplicate step names.
    this.checkDuplicateVarDecls(process, accept);
    this.checkDuplicateProcessLabel(process, accept);
    this.checkDuplicateStatementNames(process, named, accept);
    this.checkFormVariableAgreement(process, accept);
    this.checkUnreachableStatements(process, accept);

    // Event layer: duplicate handlers need sibling comparison within a
    // container, and `error … message` declarations are process-header decls
    // like `label` — both run here, the `ProcessLabel` precedent.
    this.checkHandlerDuplicates(process, accept);
    this.checkErrorDecls(process, accept);
  };

  /**
   * Reject a step that control flow can never reach: it would lower to a
   * disconnected node with no incoming flow, which is invalid BPMN. A step is
   * unreachable once an earlier terminator in the same block — an `end`,
   * `throw`, `goto`, or an all-terminating `if`/`parallel` (see
   * {@link statementTerminates}) — has stopped or diverted the flow and
   * nothing jumps back to it. Reachability is tracked per statement list: it
   * starts reachable, turns unreachable after such a terminator, and turns
   * reachable again at a step some `goto` targets by name (an explicit jump
   * re-enters the flow there). Nested blocks are scanned only when their
   * owning construct is itself reachable, so an unreachable `if` is reported
   * once rather than once per step inside it.
   *
   * An `on` handler is never part of this sequential flow — it is a catch
   * block for the whole container, not a step the main path falls into or
   * out of — so it is skipped by the state machine entirely: it never turns
   * up as unreachable itself (a handler legally follows an `end`/`throw`,
   * exactly like a `catch` legally follows the end of a `try` body), and it
   * never resets `reachable`. Its own body is scanned as a fresh reachable
   * root regardless of the surrounding flow's state. `emit` is a plain
   * fall-through statement (it does not affect `reachable`).
   *
   * The scan is deliberately sound rather than exhaustive: it never flags a
   * step control can actually reach — an `if` without an `else`, and a
   * `while`/`do-while` whose body always ends, still fall through their
   * gateway's non-terminating exit, so neither counts as a terminator — so a
   * rarer dead step may go unreported, but a live one is never wrongly
   * rejected.
   */
  private checkUnreachableStatements(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const gotoTargets = collectGotoTargetNames(process);

    const scan = (statements: Statement[]): void => {
      let reachable = true;
      for (const stmt of statements) {
        if (isOnHandler(stmt)) {
          for (const block of childBlocks(stmt)) {
            scan(block.statements);
          }
          continue;
        }
        const name = statementName(stmt);
        if (!reachable && name !== undefined && gotoTargets.has(name)) {
          reachable = true;
        }
        if (!reachable) {
          accept(
            'error',
            'This step can never run: an earlier `end`, `throw`, `goto`, or ' +
              'an all-terminating `if`/`parallel` in the same block always ' +
              'ends or redirects the flow before reaching it, so this step ' +
              'would lower to a disconnected node with no incoming flow — ' +
              'invalid BPMN.',
            { node: stmt },
          );
        } else {
          for (const block of childBlocks(stmt)) {
            scan(block.statements);
          }
        }
        if (statementTerminates(stmt)) {
          reachable = false;
        }
      }
    };

    scan(process.body);
  }

  /**
   * Every declaration of a given variable name — explicit `var`s, `form`
   * fields, and event-handler catch bindings alike — must agree on the type.
   * A `form` field whose type conflicts with an earlier declaration of the
   * same name (a `var`, or another field) is flagged, because both bind the
   * same runtime process variable. A catch binding always fills a `string`
   * variable (the code/message text an event carries), so a binding whose
   * variable is already declared with a non-`string` type is the same kind
   * of conflict.
   */
  private checkFormVariableAgreement(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const declaredType = new Map<string, VarType>();
    for (const decl of process.decls) {
      if (isVarDecl(decl)) {
        declaredType.set(decl.name, decl.type);
      }
    }
    for (const node of AstUtils.streamAst(process)) {
      if (isOnHandler(node)) {
        for (const binding of node.bindings) {
          const prior = declaredType.get(binding.variable);
          if (prior === undefined) {
            declaredType.set(binding.variable, 'string');
          } else if (prior !== 'string') {
            accept(
              'error',
              `Catch-binding variable '${binding.variable}' is typed 'string', but '${binding.variable}' is already declared as '${prior}'; the types must agree.`,
              { node: binding, property: 'variable' },
            );
          }
        }
        continue;
      }
      if (!isStartEvent(node) && !isUserTask(node)) continue;
      for (const form of node.forms) {
        for (const field of form.fields) {
          const prior = declaredType.get(field.id);
          if (prior === undefined) {
            declaredType.set(field.id, field.type);
          } else if (prior !== field.type) {
            accept(
              'error',
              `Form field '${field.id}' is typed '${field.type}', but '${field.id}' is already declared as '${prior}'; the types must agree.`,
              { node: field, property: 'type' },
            );
          }
        }
      }
    }
  }

  /**
   * Reject statement names that match the reserved synthesised-id patterns.
   *
   * The `astToIr` desugarer produces gateway ids (`Gateway_<X>_split/join/…`),
   * sequence-flow ids (`Flow_<src>_<tgt>` and `Flow_<gatewayId>_default`), and
   * implicit event ids (`StartEvent_…`, `EndEvent_…`) from structural
   * coordinates. These ids bypass the `taken`/`resolveCollision` guard, so an
   * author-chosen name colliding with one of those patterns would produce
   * duplicate-id IR. Rejecting the name here at validation time surfaces the
   * conflict as a clear IDE error. Only the two-segment `Flow_*_*` shape is
   * reserved (single-segment `Flow_X` cannot collide — see {@link
   * RESERVED_ID_PATTERNS} comment).
   *
   * @param named The goto-targetable named statements of the process.
   */
  private checkReservedNames(
    named: NamedStatement[],
    accept: ValidationAcceptor,
  ): void {
    for (const node of named) {
      if (isReservedName(node.name)) {
        accept(
          'error',
          `Statement name '${node.name}' matches a reserved synthesised-id pattern. ` +
            `Prefixes 'Gateway_…_(split|join|fork|loop)', 'Flow_', 'StartEvent_', ` +
            `'EndEvent_', 'Throw_', 'EventSubProcess_', and 'Boundary_' are reserved ` +
            `for ids generated by the BPMNscript desugarer.`,
          { node, property: 'name' },
        );
      }
    }
  }

  /**
   * Flag every `var` declaration in the process header whose name repeats an
   * earlier declaration. The symbol provider itself stays last-wins; this
   * check is what actually surfaces the conflict to the DSL author.
   *
   * @param process The process to scan.
   */
  private checkDuplicateVarDecls(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      process.decls.filter(isVarDecl),
      (decl) => decl.name,
      (decl) =>
        accept(
          'error',
          `Variable '${decl.name}' is already declared in process '${process.name}'.`,
          { node: decl, property: 'name' },
        ),
    );
  }

  /**
   * Flag a second (or later) label declaration in one process. The inline
   * label string (`process P "…"`) counts as the first occurrence: `astToIr`
   * prefers the inline label and silently drops any `label = "…"` attribute,
   * so a `label = "…"` next to an inline label is dead text and an *error*.
   * The grammar also accepts any number of `ProcessLabel` decls in
   * `process.decls`; only the first is meaningful.
   *
   * @param process The process to scan.
   */
  private checkDuplicateProcessLabel(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      process.decls.filter(isProcessLabel),
      () => 'label',
      (decl) =>
        accept(
          'error',
          `Process '${process.name}' already has a label declared; a second 'label = …' is not allowed.`,
          { node: decl, property: 'value' },
        ),
      // The inline `process P "…"` label counts as the first occurrence.
      new Set(process.label !== undefined ? ['label'] : []),
    );
  }

  /**
   * Flag a goto-targetable step (`start`/`end`/`user`/`service`) whose name
   * repeats an earlier step's name anywhere in the process — regardless of
   * nesting — because `goto <name>` would then be ambiguous.
   *
   * @param process The process to scan.
   */
  private checkDuplicateStatementNames(
    process: Process,
    named: NamedStatement[],
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      named,
      (node) => node.name,
      (node) =>
        accept(
          'error',
          `Step name '${node.name}' is already used by another step in process ` +
            `'${process.name}'; 'goto ${node.name}' would be ambiguous.`,
          { node, property: 'name' },
        ),
    );
  }

  /**
   * Run the per-expression variable checks for a single expression node.
   *
   * @param expr The expression node.
   * @param symbols The process variable table.
   */
  private checkExpression(
    expr: Expr,
    symbols: ReturnType<VariableSymbolProvider['collect']>,
    accept: ValidationAcceptor,
  ): void {
    // 0. Callee-scope exemption: an `out` mapping's source (`out result =
    //    calleeVar`) is evaluated in the CALLED process's scope, not the
    //    caller's — the caller's symbol table cannot judge whether it exists
    //    or what type it has. `getContainerOfType` (rather than a direct
    //    `$container` check) is required so a VarRef nested inside an
    //    operator node of an `out` source (e.g. `out ok = a > 5 && flag`) is
    //    exempted too, not just a bare `out x = y` shorthand. `in` mapping
    //    sources stay fully checked — they are caller-scope.
    const enclosingMapping = AstUtils.getContainerOfType(
      expr,
      isVariableMapping,
    );
    if (enclosingMapping?.direction === 'out') {
      return;
    }

    // 1. Undeclared-variable warning: a VarRef root not in the symbol set.
    //    Skip VarRefs that are a `class`, `formKey`, `expression`, `delegate`,
    //    or `topic` attribute value: those identifiers name Java classes, form
    //    ids, EL bindings, or a worker topic — not process variables — so they
    //    must not fire a spurious "not declared" warning. An `assignee` value
    //    is NOT skipped — a bare identifier there renders as a `${var}` JUEL
    //    expression (see expression-render.ts), so it is a real variable
    //    reference. Only the direct attribute-value position is skipped —
    //    VarRefs inside conditions (and nested operands of a more complex
    //    attribute value) are still checked.
    const container = expr.$container;
    const isNonVariableAttrValue =
      isAttribute(container) && NON_VARIABLE_ATTR_KEYS.has(container.key);
    if (isVarRef(expr) && !isNonVariableAttrValue && !symbols.has(expr.name)) {
      accept(
        'warning',
        `Variable '${expr.name}' is not declared. Add 'var ${expr.name}: <type>' to the process.`,
        { node: expr, property: 'name' },
      );
    }

    // 2. Type-mismatch error: an operator used with an operand whose declared
    //    type is incompatible. Only binary operator nodes carry a constraint.
    if (isRelational(expr)) {
      this.checkBinaryTypes(
        expr,
        ORDERED_OK,
        'an ordered comparison',
        symbols,
        accept,
      );
    } else if (isAdditive(expr) || isMultiplicative(expr)) {
      this.checkBinaryTypes(
        expr,
        NUMERIC_OK,
        'an arithmetic expression',
        symbols,
        accept,
      );
    } else if (isLogical(expr)) {
      this.checkLogicalTypes(expr, symbols, accept);
    }
  }

  /**
   * Flag each operand of a numeric/ordered binary node whose *declared* variable
   * type is incompatible with the operator. Literal operands are typed too, so
   * `name(string) > 1000` is caught on the `name` side. A diagnostic is attached
   * to the offending operand and names the variable.
   */
  private checkBinaryTypes(
    node: Relational | Additive | Multiplicative,
    allowed: ReadonlySet<ExprType>,
    context: string,
    symbols: ReturnType<VariableSymbolProvider['collect']>,
    accept: ValidationAcceptor,
  ): void {
    for (const side of ['left', 'right'] as const) {
      const operand = node[side];
      if (!isVarRef(operand)) {
        continue; // Only flag declared variables, never literals.
      }
      const type = symbols.get(operand.name)?.type;
      if (type === undefined) {
        continue; // Undeclared — handled by the warning, not a type error.
      }
      if (!allowed.has(type)) {
        accept(
          'error',
          `Variable '${operand.name}' of type '${type}' cannot be used in ${context} (operator '${node.op}').`,
          { node, property: side },
        );
      }
    }
  }

  /**
   * Flag an operand of a logical (`&&`/`||`) node whose declared variable type
   * is not boolean-compatible.
   */
  private checkLogicalTypes(
    node: Logical,
    symbols: ReturnType<VariableSymbolProvider['collect']>,
    accept: ValidationAcceptor,
  ): void {
    const booleanOk: ReadonlySet<ExprType> = new Set<ExprType>([
      'boolean',
      'any',
      'json',
      'unknown',
    ]);
    for (const side of ['left', 'right'] as const) {
      const operand = node[side];
      if (!isVarRef(operand)) {
        continue;
      }
      const type = symbols.get(operand.name)?.type;
      if (type !== undefined && !booleanOk.has(type)) {
        accept(
          'error',
          `Variable '${operand.name}' of type '${type}' cannot be used in a logical expression (operator '${node.op}').`,
          { node, property: side },
        );
      }
    }
  }

  /**
   * StartEvent checks: a start event may carry a `form { … }` block but no
   * `assignee`/`formKey`/`class` attributes (those belong on tasks). A start
   * event opening an `on` handler body is the trigger-carrying start (the
   * desugarer stamps the event definition onto it); it has no form
   * semantics, so a `form` block there is rejected.
   *
   * @param start The start event.
   */
  checkStartEvent = (start: StartEvent, accept: ValidationAcceptor): void => {
    for (const attr of start.attrs) {
      accept(
        'error',
        `Attribute '${attr.key}' is not valid on a start event; only a 'form' block is allowed.`,
        { node: attr, property: 'key' },
      );
    }
    this.checkFormBlocks(start.forms, 'a start event', accept);

    const container = start.$container;
    if (isBlock(container) && isOnHandler(container.$container)) {
      for (const form of start.forms) {
        accept(
          'error',
          `The start of an event-handler body has no form; the event's data is bound by the handler's own '(…)' bindings, not by a form.`,
          { node: form },
        );
      }
    }
  };

  /**
   * UserTask attribute checks: duplicate keys, key-kind validity, and its form
   * blocks.
   *
   * @param task The user task.
   */
  checkUserTaskAttributes = (
    task: UserTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkDuplicateKeys(task.attrs, accept);
    this.checkAllowedKeys(task.attrs, USER_TASK_KEYS, 'a user task', accept);
    this.checkFormBlocks(task.forms, 'a user task', accept);
  };

  /**
   * ServiceTask attribute checks: duplicate keys, key-kind validity, and the
   * exactly-one-binding discriminator. A service task binds to exactly one of
   * `class` (Java delegate class), `expression` (`operaton:expression`),
   * `delegate` (`operaton:delegateExpression` alias), or `topic` (delegates
   * to an external worker that polls the engine, emitting
   * `operaton:type="external"` alongside `operaton:topic`) — zero bindings is
   * an error, and more than one *distinct* binding key is a separate error (a
   * repeated *same* key is already reported by the duplicate-key check). Also
   * rejects a form block: service tasks are automated and render no form.
   *
   * @param task The service task.
   */
  checkServiceTaskAttributes = (
    task: ServiceTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkDuplicateKeys(task.attrs, accept);
    this.checkAllowedKeys(
      task.attrs,
      SERVICE_TASK_KEYS,
      'a service task',
      accept,
    );

    const bindingKeys = new Set(
      task.attrs.map((a) => a.key).filter((key) => SERVICE_TASK_KEYS.has(key)),
    );
    if (bindingKeys.size === 0) {
      accept(
        'error',
        `Service task '${task.name}' must declare a 'class', 'expression', 'delegate', or 'topic' attribute.`,
        { node: task, property: 'name' },
      );
    } else if (bindingKeys.size > 1) {
      accept(
        'error',
        `Service task '${task.name}' declares more than one binding (${[...bindingKeys].join(', ')}); exactly one of 'class', 'expression', 'delegate', or 'topic' is allowed.`,
        { node: task, property: 'name' },
      );
    }

    this.rejectFormBlock(task.forms, 'A service task', accept);
  };

  /**
   * ScriptTask checks: the fence language tag must be one of the supported
   * aliases (see {@link SUPPORTED_SCRIPT_TAGS}), and the script body must be
   * non-empty. Both are checked against the raw `FENCED_SCRIPT` token, split
   * with {@link splitFencedScript} the same way `ast-to-ir.ts`'s desugarer
   * splits it.
   *
   * @param task The script task.
   */
  checkScriptTask = (task: ScriptTask, accept: ValidationAcceptor): void => {
    if (task.body === undefined) {
      // Parser error recovery: an unterminated fenced block (no closing
      // ```) is never lexed as FENCED_SCRIPT, so the parser recovers into a
      // ScriptTask with no body. `property: 'name'` is used because a
      // missing body has no CST node to attach a range to.
      accept(
        'error',
        `Script task '${task.name}' has a malformed or unterminated fenced ` +
          'script body; a script must be a closed ```<lang> … ``` block.',
        { node: task, property: 'name' },
      );
      return;
    }

    const { tag, code } = splitFencedScript(task.body);

    if (!SUPPORTED_SCRIPT_TAGS.has(tag)) {
      accept(
        'error',
        `Script task '${task.name}' has an unsupported language tag '${tag}'. ` +
          "Use 'javascript'/'js', 'groovy', 'python'/'py', 'ruby'/'rb', or 'feel'.",
        { node: task, property: 'body' },
      );
    }

    if (code.trim().length === 0) {
      accept('error', `Script task '${task.name}' has an empty script body.`, {
        node: task,
        property: 'body',
      });
    }
  };

  /**
   * Validate the `form { … }` block(s) on an element: at most one block, no
   * duplicate field ids within a block, and only form-compatible field types.
   * Cross-element agreement with a `var` of the same name is checked once at the
   * process level (see {@link checkFormVariableAgreement}).
   */
  private checkFormBlocks(
    forms: FormBlock[],
    ownerDescription: string,
    accept: ValidationAcceptor,
  ): void {
    forms.slice(1).forEach((form) => {
      accept(
        'error',
        `${ownerDescription} may declare at most one 'form' block.`,
        { node: form },
      );
    });

    for (const form of forms) {
      forEachDuplicate(
        form.fields,
        (field) => field.id,
        (field) =>
          accept('error', `Duplicate form field '${field.id}'.`, {
            node: field,
            property: 'id',
          }),
      );
      for (const field of form.fields) {
        if (!FORM_FIELD_TYPES.has(field.type)) {
          accept(
            'error',
            `Form field '${field.id}' has type '${field.type}', which a form cannot use. Use string, number, boolean, or date.`,
            { node: field, property: 'type' },
          );
        }
      }
    }
  }

  /**
   * Reject every `form { … }` block on an element that must not declare one.
   * Used by {@link checkServiceTaskAttributes} — a service task is an
   * automated step with no human actor to present a form to, regardless of
   * which of its four bindings it uses.
   *
   * @param description The element kind, as a full sentence-starting noun
   *   phrase with article (e.g. `'A service task'`).
   */
  private rejectFormBlock(
    forms: FormBlock[],
    description: string,
    accept: ValidationAcceptor,
  ): void {
    for (const form of forms) {
      accept(
        'error',
        `${description} cannot declare a 'form' block; forms belong on start events and user tasks.`,
        { node: form },
      );
    }
  }

  /**
   * Flag every attribute key that repeats within one block (one error per
   * duplicate *occurrence*, attached to the repeated entry's `key`).
   */
  private checkDuplicateKeys(
    attrs: Attribute[],
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      attrs,
      (attr) => attr.key,
      (attr) =>
        accept('error', `Duplicate attribute '${attr.key}'.`, {
          node: attr,
          property: 'key',
        }),
    );
  }

  /**
   * Flag every attribute whose key is not legal for this element kind.
   *
   * @param description The element kind, as a full noun phrase with article
   *   (e.g. `'a user task'`, `'a service task'`) for the diagnostic message.
   */
  private checkAllowedKeys(
    attrs: Attribute[],
    allowed: ReadonlySet<string>,
    description: string,
    accept: ValidationAcceptor,
  ): void {
    for (const attr of attrs) {
      if (!allowed.has(attr.key)) {
        accept(
          'error',
          `Attribute '${attr.key}' is not valid on ${description}.`,
          {
            node: attr,
            property: 'key',
          },
        );
      }
    }
  }

  /**
   * Warn on an empty `then` branch, each empty `else if` branch, and an empty
   * `else` branch. Syntactically legal (the grammar allows a `Block` with zero
   * statements) but almost always an authoring mistake, so this is a
   * *warning*, not an error.
   *
   * @param stmt The `if` statement.
   */
  checkIfStatement = (stmt: IfStatement, accept: ValidationAcceptor): void => {
    this.warnIfEmptyBlock(stmt.then, "The 'if' branch has no steps.", accept);
    for (const elseIf of stmt.elseIfs) {
      this.warnIfEmptyBlock(
        elseIf.body,
        "The 'else if' branch has no steps.",
        accept,
      );
    }
    if (stmt.elseBlock) {
      this.warnIfEmptyBlock(
        stmt.elseBlock,
        "The 'else' branch has no steps.",
        accept,
      );
    }
  };

  /**
   * Warn on an empty `while` body.
   *
   * @param stmt The `while` statement.
   */
  checkWhileStatement = (
    stmt: WhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.warnIfEmptyBlock(stmt.body, "The 'while' body has no steps.", accept);
  };

  /**
   * Warn on an empty `do … while` body.
   *
   * @param stmt The `do … while` statement.
   */
  checkDoWhileStatement = (
    stmt: DoWhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.warnIfEmptyBlock(stmt.body, "The 'do' body has no steps.", accept);
  };

  /**
   * Reject a `subprocess` body with no flow step — empty, or every statement
   * an `on` handler — the same structural rule {@link checkProcess} applies
   * to the top-level body: a subprocess whose main flow does nothing is not
   * a valid thing to compile.
   *
   * @param stmt The `subprocess` statement.
   */
  checkSubProcess = (stmt: SubProcess, accept: ValidationAcceptor): void => {
    if (hasNoFlowStep(stmt.body.statements)) {
      accept(
        'error',
        `Subprocess '${stmt.name}' has no flow steps: a subprocess needs at least one step on its main flow (handlers alone do not start it).`,
        { node: stmt, property: 'name' },
      );
    }
  };

  /**
   * Warn on each empty `parallel` branch.
   *
   * @param stmt The `parallel` statement.
   */
  checkParallelStatement = (
    stmt: ParallelStatement,
    accept: ValidationAcceptor,
  ): void => {
    stmt.branches.forEach((branch, index) => {
      this.warnIfEmptyBlock(
        branch,
        `Branch ${index + 1} of the 'parallel' statement has no steps.`,
        accept,
      );
    });
  };

  /**
   * Emit one warning if `block` has zero statements. Shared by every
   * empty-block check (if/else-if/else/while/do-while/parallel branch).
   */
  private warnIfEmptyBlock(
    block: Block,
    message: string,
    accept: ValidationAcceptor,
  ): void {
    if (block.statements.length === 0) {
      accept('warning', message, { node: block, property: 'statements' });
    }
  }

  /**
   * Flag a `goto` whose resolved target lies inside a `parallel` branch when
   * the `goto` itself is not inside that same branch's subtree — a
   * `parallel` branch's steps run only when the whole `parallel` statement is
   * reached, not via an external `goto` into the middle of one of its
   * branches.
   *
   * Guarded by `if (goto.target.ref)`: an unresolved `goto` is owned by the
   * linker, which already emits exactly one
   * "Could not resolve reference" error. Touching `target.ref` unguarded here
   * would double-report on top of that error, so an unresolved reference is
   * silently skipped by this check.
   *
   * @param goto The `goto` statement.
   */
  checkGotoStatement = (
    goto: GotoStatement,
    accept: ValidationAcceptor,
  ): void => {
    const target = goto.target.ref;
    if (!target) {
      return;
    }
    const branch = findEnclosingParallelBranch(target);
    if (branch && !isWithinBlock(goto, branch)) {
      const targetName = targetStatementName(target);
      accept(
        'error',
        `'goto ${targetName}' jumps into a branch of a 'parallel' statement from outside that branch; a 'parallel' branch's steps run only when the whole 'parallel' statement is reached, not via an external 'goto'.`,
        { node: goto, property: 'target' },
      );
    }
  };

  /**
   * `call` attribute and mapping checks, read like a function call at the
   * process boundary: `process` names the called process (required), an
   * optional `binding`/`version` pins which deployed version starts, and the
   * `in`/`out` mappings are the call's arguments and return values. Runs, in
   * order: duplicate keys, allowed keys, the required `process`, the
   * `binding` value, the `binding`/`version` mutual exclusion, and mapping
   * target duplicates within one direction.
   *
   * @param call The call activity.
   */
  checkCallActivity = (
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void => {
    this.checkDuplicateKeys(call.attrs, accept);
    this.checkAllowedKeys(call.attrs, CALL_ACTIVITY_KEYS, 'a call', accept);
    this.checkCallProcessAttribute(call, accept);
    this.checkCallBindingAttribute(call, accept);
    this.checkCallBindingVersionExclusion(call, accept);
    this.checkCallMappingDuplicates(call, accept);
  };

  /**
   * A call must name the process it starts. A missing `process` attribute has
   * no attribute node to attach to, so the diagnostic lands on the call's own
   * `name`; a present but empty `process = ""` is flagged on the attribute
   * itself.
   */
  private checkCallProcessAttribute(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    const processAttr = call.attrs.find((a) => a.key === 'process');
    if (!processAttr) {
      accept(
        'error',
        `A call must name the process it starts: add process = "<id>".`,
        { node: call, property: 'name' },
      );
      return;
    }
    if (
      isLiteralString(processAttr.value) &&
      processAttr.value.value.length === 0
    ) {
      accept(
        'error',
        `A call's 'process' attribute cannot be empty; name the process to start.`,
        { node: processAttr, property: 'value' },
      );
    }
  }

  /**
   * A `binding` value must be `latest` or `deployment` (the process-engine
   * binding modes). `version = version` is the one common authoring mistake
   * worth a dedicated teaching message instead of the generic "must be
   * latest/deployment" error — `version` itself is a reserved grammar keyword
   * and so can only reach this check as a quoted string (`binding =
   * "version"`); the bare-identifier spelling is already rejected by the
   * parser before validation ever runs.
   */
  private checkCallBindingAttribute(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    const bindingAttr = call.attrs.find((a) => a.key === 'binding');
    if (!bindingAttr) {
      return;
    }
    const value = bindingValueText(bindingAttr.value);
    if (value !== undefined && CALL_BINDING_VALUES.has(value)) {
      return;
    }
    if (value === 'version') {
      accept(
        'error',
        `Write 'version = <number>' instead of 'binding = version'.`,
        { node: bindingAttr, property: 'value' },
      );
      return;
    }
    accept('error', `Attribute 'binding' must be 'latest' or 'deployment'.`, {
      node: bindingAttr,
      property: 'value',
    });
  }

  /**
   * `binding` and `version` both pin which deployed version of the called
   * process starts; declaring both is one error, not two — the discriminators
   * are mutually exclusive regardless of what value either one carries.
   */
  private checkCallBindingVersionExclusion(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    const hasBinding = call.attrs.some((a) => a.key === 'binding');
    const hasVersion = call.attrs.some((a) => a.key === 'version');
    if (hasBinding && hasVersion) {
      accept(
        'error',
        `A call cannot combine 'binding' and 'version'; use 'version = <number>' to pin a specific version, or 'binding = latest'/'binding = deployment' for the other modes.`,
        { node: call, property: 'name' },
      );
    }
  }

  /**
   * Flag a mapping whose target repeats an earlier one in the *same*
   * direction — `in`/`out` are independent namespaces, and a bare `*` shares
   * the repeat check with named targets (keyed on direction plus `'*'`) so a
   * second `*` in one direction is caught the same way, while `*` alongside a
   * named mapping in that direction is legal (they key differently).
   */
  private checkCallMappingDuplicates(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      call.mappings,
      (mapping) => `${mapping.direction}:${mapping.all ? '*' : mapping.target}`,
      (mapping) =>
        accept(
          'error',
          mapping.all
            ? `Duplicate '${mapping.direction} *' mapping; a direction can copy every variable only once.`
            : `Duplicate '${mapping.direction}' mapping target '${mapping.target}'.`,
          mapping.all
            ? { node: mapping }
            : { node: mapping, property: 'target' },
        ),
    );
  }

  // ── Event layer: handlers, throw/emit, error declaration ────────────────
  //
  // The mental model is try/catch throughout: an `on` handler is a catch
  // block that must sit at the end of the body it guards; `throw` always
  // ends its path; `emit` fires and keeps going; a binding declares the
  // process variable it fills. The trigger kind and binding fields are soft
  // words — plain `ID`s, not grammar keywords — so an unknown word is a
  // diagnostic that names the (small) set of legal words rather than a parse
  // error. Exactly one diagnostic per mistake: an unknown trigger/field word
  // makes the owning check return immediately, since the remaining rules for
  // that node would either be meaningless (is `alongside` legal for a
  // trigger we don't recognise?) or would pile a second diagnostic onto the
  // same mistake.
  //
  // Beyond error/escalation, `on` accepts five more triggers — message,
  // signal, timer, condition, compensation — each with a differently-shaped
  // payload (a required name, a particle+time clause, a condition expression,
  // or nothing at all, instead of catch-parameter bindings). Which shape is
  // legal per trigger is the small table `TRIGGER_PAYLOAD`, walked by one
  // check ({@link checkHandlerPayload}), so a new trigger kind is a new row
  // rather than new rule plumbing. `throw`/`emit` gain their own, smaller
  // legal sets (`THROW_TRIGGERS`/`EMIT_TRIGGERS`) since only some kinds have
  // a throw form.
  //
  // A handler may additionally name a host and attach as a `bpmn:boundaryEvent`
  // instead of guarding its whole enclosing container ({@link
  // checkHandlerHost}). The scope provider already restricts a resolvable host
  // to a named step of the handler's own container — an unresolved host is
  // therefore the linker's problem, not this file's — so this check only ever
  // sees a *resolved* host and asks four questions of it: is the trigger one
  // that has a boundary form at all (`compensation` does not — it undoes
  // already-completed work through its own undo block, a different attachment
  // mechanism entirely); does it point back into the handler's own escape
  // path (structurally valid BPMN, but a step that only ever runs after this
  // handler has already fired can never host the event that starts that
  // path); is it an activity at all (a start/end event, a `throw`, or a named
  // `emit` cannot carry a boundary event); and, for `escalation` specifically,
  // is it one of the three host kinds Operaton allows one on. Duplicate
  // detection ({@link checkHandlerDuplicates}) folds the host into its key so
  // a container-scoped handler and a hosted one never collide with each
  // other, and two hosted handlers only collide when they share both host and
  // code.

  /**
   * `on` handler checks: the soft trigger word, placement (directly in a
   * process/subprocess/handler body — never a branch), trailing position
   * (only further handlers may follow), the error-is-always-interrupting
   * rule, an empty code string (catch-all is the *omitted* string, not an
   * empty one), the catch-parameter bindings, the host/boundary dimension,
   * and the empty-body warning. Sibling-duplicate detection runs once per
   * process in {@link checkHandlerDuplicates}, not here, since it compares a
   * handler against the others in its container.
   *
   * @param handler The `on` handler.
   */
  checkOnHandler = (handler: OnHandler, accept: ValidationAcceptor): void => {
    if (!ON_TRIGGERS_SET.has(handler.trigger)) {
      accept('error', onTriggerMessage(handler.trigger), {
        node: handler,
        property: 'trigger',
      });
      return;
    }

    this.checkHandlerPlacement(handler, accept);
    this.checkHandlerTrailing(handler, accept);

    const rule = TRIGGER_PAYLOAD[handler.trigger];

    this.checkHandlerHost(handler, rule, accept);

    if (handler.alongside && !rule.alongside) {
      accept(
        'error',
        handler.trigger === 'compensation'
          ? COMPENSATION_ALONGSIDE_MESSAGE
          : "An error always interrupts: the handler takes over from the failed scope; 'alongside' is only available for escalations.",
        { node: handler, property: 'alongside' },
      );
    }

    this.checkHandlerPayload(handler, rule, accept);

    if (rule.parens === 'bindings') {
      this.checkHandlerBindings(handler, accept);
    }

    this.warnIfEmptyBlock(
      handler.body,
      'The event handler has no steps.',
      accept,
    );
  };

  /**
   * Walk a handler's payload members against its trigger's row in {@link
   * TRIGGER_PAYLOAD}: the STRING head (`code`), the timer particle
   * clause (`particle`/`time`), and the parenthesized slot (bindings vs.
   * condition vs. forbidden). An empty string in a required slot is treated
   * the same as an omitted one — there is no "empty means catch-all"
   * shorthand for a name-keyed or timed trigger. `alongside` is checked by
   * the caller (its legality is a per-row flag, not a payload member).
   */
  private checkHandlerPayload(
    handler: OnHandler,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (rule.code === 'required') {
      if (!handler.code) {
        accept('error', MESSAGELESS_NAME_MESSAGE, {
          node: handler,
          property: 'trigger',
        });
      }
    } else if (rule.code === 'optional') {
      checkEmptyCode(handler.code, handler, accept);
    } else if (handler.trigger === 'condition' && handler.code !== undefined) {
      // Timer's forbidden code folds into the timer-payload branch below —
      // `on timer "PT1H"` is "missing particle+time", not "has a stray code".
      accept('error', CONDITION_NO_CODE_MESSAGE, {
        node: handler,
        property: 'code',
      });
    } else if (
      handler.trigger === 'compensation' &&
      handler.code !== undefined
    ) {
      accept('error', COMPENSATION_NO_CODE_MESSAGE, {
        node: handler,
        property: 'code',
      });
    }

    if (rule.timer) {
      if (!handler.particle || !handler.time) {
        accept('error', TIMER_PAYLOAD_MESSAGE, {
          node: handler,
          property: 'trigger',
        });
      } else {
        this.checkTimerParticle(handler, accept);
      }
    } else if (handler.particle !== undefined) {
      accept('error', PARTICLE_ONLY_MESSAGE, {
        node: handler,
        property: 'particle',
      });
    }

    if (rule.parens === 'condition') {
      if (handler.condition === undefined) {
        accept('error', CONDITION_REQUIRED_MESSAGE, {
          node: handler,
          property: 'trigger',
        });
      }
    } else if (rule.parens === 'forbidden' && handler.bindings.length > 0) {
      for (const binding of handler.bindings) {
        accept(
          'error',
          handler.trigger === 'compensation'
            ? COMPENSATION_BINDINGS_MESSAGE
            : `'(code c)' bindings belong to error and escalation handlers — a ${handler.trigger} carries no code.`,
          { node: binding, property: 'field' },
        );
      }
    }

    if (handler.trigger !== 'condition' && handler.condition !== undefined) {
      accept('error', CONDITION_ONLY_MESSAGE, {
        node: handler,
        property: 'condition',
      });
    }
  }

  /**
   * The particle word itself (`after`/`at`/`every`) — shared between the `on`
   * handler and the `await` catch, since both grammar rules accept any ID
   * there. Returns whether the particle is legal, so callers can skip
   * particle-dependent follow-up checks (the shape warnings below apply only
   * to a handler, not a catch) once it is not.
   */
  private checkTimerParticleWord(
    node: OnHandler | IntermediateCatchEvent,
    particle: string,
    accept: ValidationAcceptor,
  ): boolean {
    if (!TIMER_PARTICLES.has(particle)) {
      accept(
        'error',
        `Unknown timer particle '${particle}'; write 'after', 'at', or 'every'.`,
        { node, property: 'particle' },
      );
      return false;
    }
    return true;
  }

  /**
   * Timer-specific checks, run only once the required particle/time pair is
   * present: the particle word itself (`after`/`at`/`every`), two
   * mistake-guard shape warnings (an `after` value that does not read as a
   * duration, an `at` value that reads as one instead), and the
   * `every`-on-an-interrupting-handler warning — a repeating timer that also
   * interrupts its scope could only ever fire once.
   */
  private checkTimerParticle(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    const particle = handler.particle!;
    const time = handler.time!;
    if (!this.checkTimerParticleWord(handler, particle, accept)) {
      return;
    }

    if (particle === 'after' && !time.startsWith('P') && !time.includes('${')) {
      accept('warning', "'after' expects a duration such as PT1H.", {
        node: handler,
        property: 'time',
      });
    } else if (
      particle === 'at' &&
      (time.startsWith('P') || time.startsWith('R')) &&
      !time.includes('${')
    ) {
      accept(
        'warning',
        "'at' expects a point in time such as 2026-08-01T09:00:00.",
        { node: handler, property: 'time' },
      );
    }
    // `every` gets no shape check — cycles and cron are too varied to police
    // honestly.

    if (particle === 'every' && !handler.alongside) {
      accept(
        'warning',
        'A repeating timer that interrupts its scope fires at most once — ' +
          "add 'alongside' to let it repeat, or use 'after'.",
        { node: handler, property: 'particle' },
      );
    }
  }

  /**
   * A handler belongs directly in a process body, a `subprocess` body, or
   * another handler's body (BPMN allows nested event sub-processes) — never
   * inside an `if`/`while`/`do`/`parallel` branch, since an event handler
   * scopes to a whole container, not to one branch of it.
   *
   * `on compensation` tightens this further: an undo block reverses one
   * particular subprocess's completed work, so it belongs directly inside
   * that `subprocess` body and nowhere else — not the process body, not
   * another handler's body. That tightened rule only ever applies where the
   * generic placement rule above has already passed (a compensation handler
   * still inside an `if`/branch gets the generic message, never both).
   */
  private checkHandlerPlacement(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    const container = handler.$container;
    if (isProcess(container)) {
      if (handler.trigger === 'compensation') {
        accept('error', COMPENSATION_PLACEMENT_MESSAGE, { node: handler });
      }
      return;
    }
    const owner = container.$container;
    if (isSubProcess(owner) || isOnHandler(owner)) {
      if (handler.trigger === 'compensation' && !isSubProcess(owner)) {
        accept('error', COMPENSATION_PLACEMENT_MESSAGE, { node: handler });
      }
      return;
    }
    accept(
      'error',
      'An event handler belongs directly in a process or subprocess body — it handles events for that whole scope, not for a single branch.',
      { node: handler },
    );
  }

  /**
   * A handler reads like a catch block: only further handlers may follow it
   * in its statement list — it must sit at the end of the body it guards.
   */
  private checkHandlerTrailing(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    const list = statementListOf(handler);
    const index = list.indexOf(handler);
    const hasNonHandlerAfter = list
      .slice(index + 1)
      .some((stmt) => !isOnHandler(stmt));
    if (hasNonHandlerAfter) {
      accept(
        'error',
        'Event handlers read like catch blocks: move it after the last step of this body.',
        { node: handler },
      );
    }
  }

  /**
   * Catch-parameter binding checks: a duplicate `field` within one handler
   * (checked by the literal field text, regardless of word legality — the
   * {@link checkDuplicateKeys} precedent), then per binding, the soft `field`
   * word and the semantic rule that an escalation carries a code but no
   * message.
   */
  private checkHandlerBindings(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      handler.bindings,
      (binding) => binding.field,
      (binding) =>
        accept('error', `Duplicate catch-binding field '${binding.field}'.`, {
          node: binding,
          property: 'field',
        }),
    );

    for (const binding of handler.bindings) {
      if (!EVENT_BINDING_FIELDS.has(binding.field)) {
        accept(
          'error',
          `Unknown catch-binding field '${binding.field}'; write 'code' or 'message'.`,
          { node: binding, property: 'field' },
        );
        continue;
      }
      if (binding.field === 'message' && handler.trigger === 'escalation') {
        accept('error', 'An escalation carries a code but no message.', {
          node: binding,
          property: 'field',
        });
      }
    }
  }

  /**
   * The host/boundary dimension: whether this handler is even allowed to
   * name a host, and — once it does — whether the host it names is one this
   * handler could legally attach to. Runs in this order, stopping at the
   * first violation, so one mistake never stacks a second diagnostic on top
   * of itself:
   *
   *   1. `compensation` has no boundary form at all — a host on it is
   *      rejected outright, independent of whether the name even resolves.
   *   2. An unresolved host is the linker's problem: {@link
   *      BpmnScriptLinker} already reports it (a boundary-crossing
   *      explanation or the generic "could not resolve" message), so this
   *      check is guarded on `.ref` being present, the {@link
   *      checkGotoStatement} precedent — touching an unresolved reference
   *      unguarded here would double-report on top of that error.
   *   3. The host cannot be a descendant of this same handler's own body.
   *      The scope-provider transparency rule that lets a hosted handler's
   *      `goto` reach the main flow (and vice versa) also makes the
   *      handler's own escape-path steps visible as host candidates — but a
   *      step inside this handler's own body only ever runs *after* this
   *      boundary event has already fired, so attaching the event to it is
   *      circular: structurally valid BPMN the engine would deploy, but a
   *      path that can never be taken.
   *   4. The host must be an activity: a start/end event, a `throw`, or a
   *      named `emit` cannot carry an attached boundary event.
   *   5. An `escalation` boundary additionally restricts its host to a
   *      `subprocess`, a `call`, or a `user` task — Operaton's own
   *      restriction, read from `BpmnParse.parseBoundaryEvents`.
   */
  private checkHandlerHost(
    handler: OnHandler,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (handler.host === undefined) {
      return;
    }
    if (!rule.boundary) {
      accept('error', COMPENSATION_HOST_MESSAGE, {
        node: handler,
        property: 'host',
      });
      return;
    }

    const host = handler.host.ref;
    if (host === undefined) {
      return;
    }

    if (AstUtils.hasContainerOfType(host, (n) => n === handler)) {
      accept('error', selfAttachedHostMessage(targetStatementName(host)), {
        node: handler,
        property: 'host',
      });
      return;
    }

    if (!isActivityStatement(host)) {
      accept('error', illegalHostMessage(host), {
        node: handler,
        property: 'host',
      });
      return;
    }

    if (handler.trigger === 'escalation' && !isEscalationLegalHost(host)) {
      accept('error', escalationHostMessage(host), {
        node: handler,
        property: 'host',
      });
    }
  }

  /**
   * Two handlers in the same container catching the same host, trigger, and
   * code (or both catch-all) are ambiguous to the engine regardless of
   * `alongside` — Operaton rejects such a deployment. A coded handler and a
   * catch-all of the same trigger coexist legally (specific wins, catch-all
   * is the fallback), since they key differently, and so do two handlers
   * with the same trigger and code that attach to *different* hosts — each
   * host gets its own engine subscription. A host-less handler and a hosted
   * one sharing a trigger and code never collide either: the host segment is
   * empty only for the host-less side, so the keys differ. "Same container"
   * means the same *flow* container — the one the handler's node lowers into —
   * so a handler written inside a hosted handler's body is compared against
   * the surrounding flow's handlers, which is where it actually lands. Runs
   * once per process (not per handler) so a duplicate pair is reported once
   * per extra occurrence, not once per comparison direction.
   *
   * `on compensation` always carries no code and no host, so two of them in
   * one container always key identically and always collide; the message is
   * reworded away from the engine-ambiguity framing ({@link
   * COMPENSATION_DUPLICATE_MESSAGE}) since a subprocess having one undo
   * block is a simpler rule than a duplicate catch.
   */
  private checkHandlerDuplicates(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const byContainer = new Map<AstNode, OnHandler[]>();
    for (const node of AstUtils.streamAst(process)) {
      if (!isOnHandler(node)) continue;
      // Timer and conditional handlers key no engine subscription name — two
      // timers with different deadlines (or two conditions) in one scope is
      // a real pattern, so they never conflict and are excluded here.
      if (node.trigger === 'timer' || node.trigger === 'condition') continue;
      // An unresolved host is the linker's problem: its key segment is empty,
      // which would collide with every host-less handler here and stack a
      // second, misleading diagnostic on top of the resolution error.
      if (node.host !== undefined && node.host.ref === undefined) continue;
      // Group by the *flow* container, not the syntactic parent: a hosted
      // handler's body lowers inline into its host's container, so two
      // handlers written at different nesting depths can still land in one
      // container and key the same engine subscription.
      const container = enclosingFlowContainer(node);
      if (container === undefined) continue;
      const siblings = byContainer.get(container) ?? [];
      siblings.push(node);
      byContainer.set(container, siblings);
    }
    for (const siblings of byContainer.values()) {
      forEachDuplicate(
        siblings,
        (handler) =>
          `${handlerHostKey(handler)}:${handler.trigger}:${handler.code ?? ''}`,
        (handler) =>
          accept(
            'error',
            handler.trigger === 'compensation'
              ? COMPENSATION_DUPLICATE_MESSAGE
              : handlerDuplicateMessage(handler),
            { node: handler, property: 'trigger' },
          ),
      );
    }
  }

  /**
   * `throw <trigger> "<code>"` checks: the soft trigger word, and the
   * code-required shift ({@link checkThrowEmitCode}) — every
   * trigger but `compensation` must name its code, and `compensation` must
   * not carry one.
   *
   * @param stmt The `throw` statement.
   */
  checkThrowStatement = (
    stmt: ThrowStatement,
    accept: ValidationAcceptor,
  ): void => {
    if (!THROW_TRIGGERS.includes(stmt.trigger)) {
      accept('error', throwTriggerMessage(stmt.trigger), {
        node: stmt,
        property: 'trigger',
      });
      return;
    }
    checkThrowEmitCode(stmt, 'A thrown', 'throw', accept);
  };

  /**
   * `emit <trigger> "<code>"` checks: the soft trigger word (with the
   * impossible-verb teaching error for `emit error` — an error always ends
   * its path, so it can never be a continuing throw — folded into {@link
   * emitTriggerMessage}) and the code-required shift ({@link
   * checkThrowEmitCode}).
   *
   * @param stmt The `emit` statement.
   */
  checkEmitStatement = (
    stmt: EmitStatement,
    accept: ValidationAcceptor,
  ): void => {
    if (!EMIT_TRIGGERS.includes(stmt.trigger)) {
      accept('error', emitTriggerMessage(stmt.trigger), {
        node: stmt,
        property: 'trigger',
      });
      return;
    }
    checkThrowEmitCode(stmt, 'An emitted', 'emit', accept);
  };

  /**
   * `await <trigger> <payload>` checks: the soft trigger word, restricted to
   * the four kinds with a blocking catch form ({@link CATCH_TRIGGERS}), and
   * the payload shape for whichever kind it is. The grammar carries no host,
   * bindings, `alongside`, or body on this node, so there is nothing else to
   * check — {@link checkHandlerPayload} is the mirror for `on`, minus those
   * four members.
   *
   * @param catchEvent The `await` statement.
   */
  checkIntermediateCatchEvent = (
    catchEvent: IntermediateCatchEvent,
    accept: ValidationAcceptor,
  ): void => {
    if (!CATCH_TRIGGERS_SET.has(catchEvent.trigger)) {
      accept('error', catchTriggerMessage(catchEvent.trigger), {
        node: catchEvent,
        property: 'trigger',
      });
      return;
    }

    this.checkCatchPayload(
      catchEvent,
      TRIGGER_PAYLOAD[catchEvent.trigger]!,
      accept,
    );
  };

  /**
   * Walk a catch event's payload against its trigger's row in {@link
   * TRIGGER_PAYLOAD}: the STRING head (`code`) for message/signal, the timer
   * particle clause for timer, and the parenthesized condition for
   * condition. Mirrors {@link checkHandlerPayload}'s code/timer/parens walk;
   * the bindings and `alongside` dimensions do not apply here, since the
   * catch reads neither.
   */
  private checkCatchPayload(
    catchEvent: IntermediateCatchEvent,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (rule.code === 'required') {
      if (!catchEvent.code) {
        accept('error', CATCH_NAME_REQUIRED_MESSAGE, {
          node: catchEvent,
          property: 'trigger',
        });
      }
    } else if (
      catchEvent.trigger === 'condition' &&
      catchEvent.code !== undefined
    ) {
      // Timer's forbidden code folds into the timer-payload branch below —
      // `await timer "PT1H"` is "missing particle", not "has a stray code".
      accept('error', CATCH_CONDITION_NO_CODE_MESSAGE, {
        node: catchEvent,
        property: 'code',
      });
    }

    if (rule.timer) {
      if (!catchEvent.particle || !catchEvent.time) {
        accept('error', TIMER_PAYLOAD_MESSAGE, {
          node: catchEvent,
          property: 'trigger',
        });
      } else {
        this.checkTimerParticleWord(catchEvent, catchEvent.particle, accept);
      }
    } else if (catchEvent.particle !== undefined) {
      accept('error', CATCH_PARTICLE_ONLY_MESSAGE, {
        node: catchEvent,
        property: 'particle',
      });
    }

    if (rule.parens === 'condition' && catchEvent.condition === undefined) {
      accept('error', CATCH_CONDITION_REQUIRED_MESSAGE, {
        node: catchEvent,
        property: 'trigger',
      });
    }

    if (
      catchEvent.trigger !== 'condition' &&
      catchEvent.condition !== undefined
    ) {
      accept('error', CATCH_CONDITION_ONLY_MESSAGE, {
        node: catchEvent,
        property: 'condition',
      });
    }
  }

  /**
   * `error "<code>" message "<text>"` process-header declaration checks: the
   * soft `kind`/`field` words, an empty code or message string, and a
   * duplicate declaration for one code (the duplicate-process-label
   * precedent — a second declaration for a code that already has a message
   * is dead/conflicting text, not a merge).
   */
  private checkErrorDecls(process: Process, accept: ValidationAcceptor): void {
    const decls = process.decls.filter(isErrorDecl);
    const wellFormed: ErrorDecl[] = [];
    for (const decl of decls) {
      if (decl.kind !== 'error') {
        accept(
          'error',
          `Unknown declaration kind '${decl.kind}'; write 'error'.`,
          {
            node: decl,
            property: 'kind',
          },
        );
        continue;
      }
      if (decl.field !== 'message') {
        accept(
          'error',
          `Unknown declaration field '${decl.field}'; write 'message'.`,
          { node: decl, property: 'field' },
        );
        continue;
      }
      if (decl.code.length === 0) {
        accept('error', "An error declaration's code cannot be empty.", {
          node: decl,
          property: 'code',
        });
      }
      if (decl.message.length === 0) {
        accept('error', "An error declaration's message cannot be empty.", {
          node: decl,
          property: 'message',
        });
      }
      wellFormed.push(decl);
    }
    forEachDuplicate(
      wellFormed,
      (decl) => decl.code,
      (decl) =>
        accept(
          'error',
          `Error code '${decl.code}' already has a message declared; a second 'error "${decl.code}" message …' is not allowed.`,
          { node: decl, property: 'code' },
        ),
    );
  }
}

/**
 * Collect every expression node reachable from a process: conditions of
 * `if`/`else if`/`while`/`do … while` and attribute values. Returns flat list of
 * `Expr` nodes (including nested sub-expressions, via {@link AstUtils.streamAst}).
 *
 * @param process The process to scan.
 * @returns Every `Expr` node in the process.
 */
function collectExpressions(process: Process): Expr[] {
  const result: Expr[] = [];
  for (const node of AstUtils.streamAst(process)) {
    if (isExpr(node)) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Return `true` when `name` matches any reserved synthesised-id pattern.
 * Tests against {@link RESERVED_ID_PATTERNS}.
 */
function isReservedName(name: string): boolean {
  return RESERVED_ID_PATTERNS.some((re) => re.test(name));
}

/**
 * Render a legal-word list as a quoted English "or"/"…, or …" clause — the
 * shared tail of every soft-word naming diagnostic in this file.
 */
function formatWordList(words: readonly string[]): string {
  const quoted = words.map((w) => `'${w}'`);
  if (quoted.length === 1) return quoted[0]!;
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`;
}

/** The generic "unknown event kind" diagnostic, naming every legal word for the position. */
function unknownTriggerMessage(word: string, legal: readonly string[]): string {
  return `Unknown event kind '${word}'; write ${formatWordList(legal)}.`;
}

/**
 * The near-miss message for the `compensate` typo — the correct spelling
 * names an already-completed undo block, not a verb — shared by the `on`,
 * `throw`, and `emit` trigger diagnostics below.
 */
function compensateTypoMessage(): string {
  return `Unknown event kind 'compensate'; write 'compensation'.`;
}

/**
 * The `on` trigger diagnostic: near-miss teaching messages for `conditional`
 * (the one plausible typo for `condition`) and `compensate` (for
 * `compensation`), otherwise the generic naming message over all seven
 * legal words.
 */
function onTriggerMessage(word: string): string {
  if (word === 'conditional') {
    return `Unknown event kind 'conditional'; did you mean 'condition'?`;
  }
  if (word === 'compensate') {
    return compensateTypoMessage();
  }
  return unknownTriggerMessage(word, ON_TRIGGERS);
}

/**
 * The `throw` trigger diagnostic: near-miss teaching messages for `message`
 * (nothing to send on the throwing side — write a handler instead) and
 * `compensate` (for `compensation`), otherwise the generic naming message.
 */
function throwTriggerMessage(word: string): string {
  if (word === 'message') {
    return MESSAGE_NOTHING_TO_SEND_MESSAGE;
  }
  if (word === 'compensate') {
    return compensateTypoMessage();
  }
  return unknownTriggerMessage(word, THROW_TRIGGERS);
}

/**
 * The `emit` trigger diagnostic: near-miss teaching messages for `error`
 * (always terminal — write `throw error`), `message` (nothing to send), and
 * `compensate` (for `compensation`), otherwise the generic naming message.
 */
function emitTriggerMessage(word: string): string {
  if (word === 'error') {
    return "An error always aborts its path — write 'throw error'.";
  }
  if (word === 'message') {
    return MESSAGE_NOTHING_TO_SEND_MESSAGE;
  }
  if (word === 'compensate') {
    return compensateTypoMessage();
  }
  return unknownTriggerMessage(word, EMIT_TRIGGERS);
}

/**
 * The `await` trigger diagnostic: names the four legal catch words and
 * points at the right construct for everything else — error/escalation fire
 * outward through `throw`/`emit`, and compensation is a subprocess's own
 * undo block, so none of the three (nor any other unrecognised word) can be
 * awaited inline.
 */
function catchTriggerMessage(word: string): string {
  return (
    `Unknown event kind '${word}'; intermediate catch supports ${formatWordList(CATCH_TRIGGERS)}. ` +
    "Errors and escalations are raised with 'throw'/'emit', and compensation " +
    "is a subprocess's undo block, so none of them can be awaited inline."
  );
}

/**
 * The `Statement` kinds a boundary event may attach to: the five activities
 * Operaton lets a token dock at. Everything else in the `Statement` union is
 * a control construct, a terminal event, a `goto`, or another handler — none
 * of which an engine token is ever "at" the way it is at a running activity.
 */
function isActivityStatement(stmt: Statement): boolean {
  return (
    isUserTask(stmt) ||
    isServiceTask(stmt) ||
    isScriptTask(stmt) ||
    isSubProcess(stmt) ||
    isCallActivity(stmt)
  );
}

/**
 * Operaton additionally restricts an `escalation` boundary to exactly these
 * three host kinds (read from `BpmnParse.parseBoundaryEvents`) — narrower
 * than the general activity set every other boundary-capable trigger allows.
 */
function isEscalationLegalHost(stmt: Statement): boolean {
  return isSubProcess(stmt) || isCallActivity(stmt) || isUserTask(stmt);
}

/**
 * A human-readable name for a resolved host's `Statement` kind, used to tell
 * an author what their `host` actually named. `[Statement:ID]` only ever
 * matches a node that carries a `name` (see {@link targetStatementName}), so
 * a control construct (`if`/`while`/`parallel`), a `goto`, or another handler
 * can never reach here — none of them have a name to resolve against — and
 * the fallback below exists only so this function stays total.
 */
function describeStatementKind(stmt: Statement): string {
  if (isStartEvent(stmt)) return 'a start event';
  if (isEndEvent(stmt)) return 'an end event';
  if (isUserTask(stmt)) return 'a user task';
  if (isServiceTask(stmt)) return 'a service task';
  if (isScriptTask(stmt)) return 'a script task';
  if (isSubProcess(stmt)) return 'a subprocess';
  if (isCallActivity(stmt)) return 'a call';
  if (isThrowStatement(stmt)) return 'a throw statement';
  if (isEmitStatement(stmt)) return 'an emit statement';
  return 'not an activity';
}

/** A host resolving to a non-activity step: names what it actually is. */
function illegalHostMessage(host: Statement): string {
  return (
    'A boundary event can only attach to an activity — a user, service, ' +
    `or script task, a subprocess, or a call; '${targetStatementName(host)}' is ` +
    `${describeStatementKind(host)}.`
  );
}

/** An `escalation` boundary whose host is outside Operaton's three legal kinds. */
function escalationHostMessage(host: Statement): string {
  return (
    'An escalation boundary can only attach to a subprocess, a call, or a ' +
    `user task; '${targetStatementName(host)}' is ${describeStatementKind(host)}.`
  );
}

/**
 * A host resolving into a descendant of the handler's own body: the step
 * only ever runs after this same boundary event has already fired, so
 * attaching to it is circular — see {@link BpmnScriptValidator.checkHandlerHost}.
 */
function selfAttachedHostMessage(hostName: string): string {
  return (
    `A boundary event cannot attach to a step inside its own escape path: ` +
    `'${hostName}' only runs after this handler has already fired, so it ` +
    'can never host the event that starts that path.'
  );
}

/**
 * A `start` written as the first statement of a *hosted* handler's body — the
 * one place the container rule does not extend to, since such a body lowers
 * inline rather than into a scope of its own.
 */
function hostedHandlerStartMessage(name: string): string {
  return (
    `'start ${name}' cannot open a handler that names a host: the body runs ` +
    "inside the host's own container and is entered from the boundary event, " +
    'so it is not a scope with a start of its own. Remove the start; the ' +
    'first step of the body is where the escape path begins.'
  );
}

/**
 * The resolved host's name for use as a duplicate-detection key segment, or
 * `''` for a host-less handler (or one whose host did not resolve — the
 * linker's problem, not this check's). Kept as its own function because
 * `Statement`'s `name` is not a common property across every union member —
 * {@link targetStatementName} is the total accessor.
 */
function handlerHostKey(handler: OnHandler): string {
  return handler.host?.ref ? targetStatementName(handler.host.ref) : '';
}

/**
 * The sibling-duplicate message for a non-compensation handler. The
 * host-less phrasing ("in this scope") is byte-identical to the message this
 * file has always produced, so an existing host-less program's diagnostics
 * do not change; a hosted handler instead names the activity it attaches to.
 */
function handlerDuplicateMessage(handler: OnHandler): string {
  const caught =
    handler.code !== undefined
      ? `code '${handler.code}'`
      : 'every event of this kind';
  const hostKey = handlerHostKey(handler);
  const scope = hostKey ? `attached to '${hostKey}'` : 'in this scope';
  return `Another 'on ${handler.trigger}' handler ${scope} already catches ${caught}; a duplicate catch is ambiguous to the engine.`;
}

/**
 * Flag an empty code string on `on` (rule 4): catch-all is the *omitted*
 * string, so an empty one is always a mistake, never a shorthand for it.
 * `throw`/`emit` read an empty or omitted code differently — see {@link
 * checkThrowEmitCode} — since there is no catch-all concept on the throwing
 * side.
 */
function checkEmptyCode(
  code: string | undefined,
  node: AstNode,
  accept: ValidationAcceptor,
): void {
  if (code !== undefined && code.length === 0) {
    accept(
      'error',
      'An empty code ("") is not a catch-all; to catch every error, omit the string entirely.',
      { node, property: 'code' },
    );
  }
}

/**
 * `throw <trigger> "<code>"`/`emit <trigger> "<code>"` code-shape checks
 * (the code-required shift): every trigger but `compensation` must
 * name the code it throws/emits, so an omitted or empty code string is the
 * same mistake — there is no catch-all shorthand on the throwing/emitting
 * side, unlike a catch block. `compensation` is the mirror case: it undoes
 * already-completed work and names nothing, so carrying a code (even an
 * empty string) is the mistake there instead.
 *
 * @param stmt The `throw`/`emit` statement.
 * @param subject The diagnostic's leading noun phrase (`'A thrown'`/`'An emitted'`).
 * @param keyword The statement's own keyword (`'throw'`/`'emit'`), echoed in the message.
 */
function checkThrowEmitCode(
  stmt: ThrowStatement | EmitStatement,
  subject: 'A thrown' | 'An emitted',
  keyword: 'throw' | 'emit',
  accept: ValidationAcceptor,
): void {
  if (stmt.trigger === 'compensation') {
    if (stmt.code !== undefined) {
      accept(
        'error',
        'Compensation undoes completed work — there is nothing to name; ' +
          `write '${keyword} compensation'.`,
        { node: stmt, property: 'code' },
      );
    }
    return;
  }
  const message = `${subject} ${stmt.trigger} names its code: '${keyword} ${stmt.trigger} "CODE"'.`;
  if (stmt.code === undefined) {
    accept('error', message, { node: stmt, property: 'trigger' });
  } else if (stmt.code.length === 0) {
    accept('error', message, { node: stmt, property: 'code' });
  }
}

/**
 * The statement list a handler sits in — `process.body` when it is directly
 * in the process, or the enclosing `Block`'s `statements` otherwise (a
 * `subprocess`/`on` body). Used by {@link BpmnScriptValidator.checkHandlerTrailing}.
 */
function statementListOf(handler: OnHandler): Statement[] {
  const container = handler.$container;
  return isProcess(container) ? container.body : container.statements;
}

/**
 * The identifier-like text of a `binding` attribute value, however it parsed:
 * a bareword (`binding = latest`) is a `VarRef`, and a quoted spelling
 * (`binding = "latest"`) is a `LiteralString` — both mean the same value, so
 * {@link BpmnScriptValidator.checkCallBindingAttribute} reads either shape the
 * same way. `undefined` for any other expression shape (a number, a raw
 * template, an operator node, …), which is never a legal binding value.
 */
function bindingValueText(expr: Expr): string | undefined {
  if (isVarRef(expr)) {
    return expr.name;
  }
  if (isLiteralString(expr)) {
    return expr.value;
  }
  return undefined;
}

/**
 * Split a raw `FENCED_SCRIPT` token (the whole ```` ```<tag>\n…\n``` ````
 * block, captured verbatim by the grammar) into its language tag and inner
 * code body — mirroring `ast-to-ir.ts`'s `splitFencedScript`. Duplicated here
 * (rather than imported) because the validator lives in `packages/language`,
 * which cannot depend on `packages/transform`.
 *
 * The tag is the maximal run of ASCII letters immediately following the
 * opening fence. A single line terminator directly after the tag (`\r\n` or
 * `\n`) is dropped; nothing else is touched, so the code body is returned
 * exactly as the desugarer would see it.
 *
 * @param raw The raw fenced-script token, delimiters included.
 * @returns The extracted `tag` and `code`.
 */
function splitFencedScript(raw: string): { tag: string; code: string } {
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

/**
 * Walk up from `node` to the nearest `Block` whose direct container is a
 * `ParallelStatement` — i.e. the nearest enclosing `parallel` branch, if any.
 *
 * A `Block`'s only possible containers are `DoWhileStatement`, `ElseIf`,
 * `IfStatement`, `ParallelStatement`, and `WhileStatement` (per the grammar);
 * `ParallelStatement`'s only `Block`-typed property is `branches`, so a
 * `Block` whose container is a `ParallelStatement` is necessarily one of that
 * statement's branches — no separate membership check is needed.
 *
 * @param node The node to walk up from (typically a resolved `goto` target).
 * @returns The enclosing branch `Block`, or `undefined` if `node` is not
 *   nested inside any `parallel` branch.
 */
function findEnclosingParallelBranch(node: AstNode): Block | undefined {
  let child: AstNode = node;
  let parent: AstNode | undefined = node.$container;
  while (parent) {
    if (isBlock(child) && isParallelStatement(parent)) {
      return child;
    }
    child = parent;
    parent = parent.$container;
  }
  return undefined;
}

/**
 * Return `true` when `node` is `block` itself or nested anywhere inside it
 * (checked by walking up `node`'s own `$container` chain).
 *
 * @param node The node to test (typically a `goto` statement).
 * @param block The candidate enclosing block.
 */
function isWithinBlock(node: AstNode, block: Block): boolean {
  let current: AstNode | undefined = node;
  while (current) {
    if (current === block) {
      return true;
    }
    current = current.$container;
  }
  return false;
}

/**
 * The `name` of a resolved `goto` target for use in a diagnostic message.
 * Only `StartEvent`/`EndEvent`/`UserTask`/`ServiceTask`/`ScriptTask`/
 * `SubProcess`/`CallActivity`/named-`ThrowStatement`/named-`EmitStatement`
 * carry a resolvable `name` (a *resolved* cross-reference necessarily has
 * one — an unnamed throw/emit can never be a link target), so the `'?'`
 * fallback shouldn't be reachable.
 */
function targetStatementName(target: Statement): string {
  if (
    isStartEvent(target) ||
    isEndEvent(target) ||
    isUserTask(target) ||
    isServiceTask(target) ||
    isScriptTask(target) ||
    isSubProcess(target) ||
    isCallActivity(target)
  ) {
    return target.name;
  }
  if (isThrowStatement(target) || isEmitStatement(target)) {
    return target.name ?? '?';
  }
  return '?';
}
