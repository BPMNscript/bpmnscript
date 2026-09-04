/**
 * Desugaring AST -> IR. Lowers the Langium AST into the flat, BPMN-shaped
 * {@link BpmnProcess}: control-flow keywords become gateways and sequence
 * flows, implicit flow and implicit start/end events are materialised, and
 * conditions render to `${...}` bodies.
 *
 * Every synthesised id comes from `./synthesize-ids.js`, seeded by a structural
 * coordinate `<X>`: the statement's static position in the block tree, never a
 * traversal counter, so re-running this on `irToDsl` output yields identical
 * ids. See ADR 0010, Use Deterministic Structural Ids for Synthesized BPMN
 * Elements. Two things the ADR leaves open: an `on` handler owns a single
 * block, so like a loop body it needs no segment and its enclosing coordinate
 * is its own `<X>`; and a sub-process body is rooted at that coordinate rather
 * than at the sub-process's name, because gateway ids skip `resolveCollision`
 * and a sub-process named like a coordinate could otherwise duplicate one.
 *
 * The desugarer is total: it never throws on a program the validator rejects.
 */

import {
  isStartEvent,
  isEndEvent,
  isUserTask,
  isServiceTask,
  isScriptTask,
  isIfStatement,
  isWhileStatement,
  isDoWhileStatement,
  isParallelStatement,
  isGotoStatement,
  isSubProcess,
  isCallActivity,
  isOnHandler,
  isThrowStatement,
  isEmitStatement,
  isIntermediateCatchEvent,
  isErrorDecl,
  isLiteralString,
  isLiteralBool,
  isLiteralInt,
  isLiteralDecimal,
  isVarRef,
  isListLiteral,
  isMapLiteral,
  isScriptLiteral,
  renderExpression,
  SCRIPT_FORMAT_ALIASES,
  splitFencedScript,
} from '@bpmn-script/language';
import type {
  Model,
  Process,
  Statement,
  Block,
  Expr,
  StartEvent as AstStartEvent,
  EndEvent as AstEndEvent,
  UserTask as AstUserTask,
  ServiceTask as AstServiceTask,
  ScriptTask as AstScriptTask,
  IfStatement,
  WhileStatement,
  DoWhileStatement,
  ParallelStatement,
  GotoStatement,
  SubProcess as AstSubProcess,
  CallActivity as AstCallActivity,
  OnHandler,
  ThrowStatement,
  EmitStatement,
  IntermediateCatchEvent,
  VariableMapping,
  Attribute,
  IoParameter as AstIoParameter,
  IoValue as AstIoValue,
  Listener as AstListener,
} from '@bpmn-script/language';
import type {
  BpmnProcess,
  CalledElementBinding,
  CallVariableMapping,
  CodeBinding,
  EngineAttributes,
  EventDefinition,
  ExecutionListener,
  FlowElement,
  FormField,
  FormFieldType,
  IoMapped,
  IoParameter,
  IoValue,
  SequenceFlow as IrSequenceFlow,
  ListenerBinding,
  ServiceTaskBinding,
  StartEvent as IrStartEvent,
  TaskListener,
} from './ir/types.js';
import { engineAttributes, ioMapped } from './ir/types.js';
import {
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayLoopId,
  makeDefaultFlowId,
  makeSequenceFlowId,
  makeStartEventId,
  makeEndEventId,
  makeThrowEventId,
  makeEventSubProcessId,
  makeBoundaryEventId,
  makeIntermediateCatchEventId,
} from './synthesize-ids.js';

/**
 * The fall-through boundary of a lowered statement or block. A `null` `exit`
 * suppresses both the implicit flow to the next sibling and the join/end
 * continuation.
 */
interface Frontier {
  /** Node an incoming flow targets; `null` for an empty block, whose caller routes to the join. */
  entry: string | null;
  exit: string | null;
  /**
   * When set, the fall-through flow out of `exit` uses this exact id and
   * becomes its source gateway's default flow. `while` reserves
   * `Flow_<loopId>_default` so the gateway's `defaultFlowId` matches.
   */
  exitFlowId?: string;
}

/**
 * Mutable accumulator threaded through the walk. Each flow container gets its
 * own `flowElements`/`sequenceFlows`, but one `taken` set is shared document-
 * wide, pre-seeded with every named element id, so a synthesised id never
 * clashes with an author-chosen name. BPMN requires that (`id` is an XML ID).
 */
interface Builder {
  readonly flowElements: FlowElement[];
  readonly sequenceFlows: IrSequenceFlow[];
  readonly taken: Set<string>;
}

/** Convert an AST `Model` into a {@link BpmnProcess}. Only the first `process` block is read. */
export function astToIr(model: Model): BpmnProcess {
  const process = model.processes[0];
  if (!process) {
    throw new Error('astToIr: the model contains no process definitions.');
  }

  const builder: Builder = {
    flowElements: [],
    sequenceFlows: [],
    taken: collectNamedIds(process),
  };

  // Both the top-level coordinate and the implicit-event seed are the process id.
  lowerContainerBody(builder, process.body, process.name, process.name);

  const label = processLabel(process);
  const versionTag = processVersionTag(process);
  const errorMessages = collectErrorMessages(process);

  return {
    id: process.name,
    ...(label !== undefined ? { name: label } : {}),
    isExecutable: true,
    ...(versionTag !== undefined ? { versionTag } : {}),
    flowElements: builder.flowElements,
    sequenceFlows: builder.sequenceFlows,
    ...(errorMessages.length > 0 ? { errorMessages } : {}),
  };
}

/**
 * The header `error "CODE" message "..."` declarations, in order. The message
 * text is the one root-element datum usage alone cannot recover: two throws of
 * a code share one root. A duplicate code keeps the first.
 */
function collectErrorMessages(
  process: Process,
): { code: string; message: string }[] {
  const messages: { code: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const decl of process.decls) {
    if (isErrorDecl(decl) && !seen.has(decl.code)) {
      seen.add(decl.code);
      messages.push({ code: decl.code, message: decl.message });
    }
  }
  return messages;
}

/**
 * Lower one flow container's body, plus the implicit start/end events. `coord`
 * is the enclosing block's structural coordinate; `containerId` seeds the
 * implicit start/end ids through `resolveCollision` against `taken`.
 */
function lowerContainerBody(
  builder: Builder,
  statements: Statement[],
  coord: string,
  containerId: string,
): void {
  const body = lowerBlockStatements(builder, statements, coord);

  if (body.entry !== null) {
    const firstIsExplicitStart =
      statements.length > 0 && isStartEvent(statements[0]!);
    if (!firstIsExplicitStart) {
      const startId = makeStartEventId(containerId, builder.taken);
      builder.flowElements.unshift({ kind: 'startEvent', id: startId });
      addFlow(builder, startId, body.entry);
    }
  }

  if (body.exit !== null) {
    const last = statements[statements.length - 1];
    const lastIsExplicitEnd = last !== undefined && isEndEvent(last);
    if (!lastIsExplicitEnd) {
      const endId = makeEndEventId(containerId, builder.taken);
      builder.flowElements.push({ kind: 'endEvent', id: endId });
      // Honour a reserved exit-flow id, e.g. a `while` loop's default exit.
      addFlow(builder, body.exit, endId, undefined, body.exitFlowId);
    }
  } else if (body.entry === null) {
    // No flow step at all (empty, or every statement is an `on` handler), so
    // neither branch above ran and the container would have no start event.
    const startId = makeStartEventId(containerId, builder.taken);
    const endId = makeEndEventId(containerId, builder.taken);
    builder.flowElements.unshift({ kind: 'startEvent', id: startId });
    builder.flowElements.push({ kind: 'endEvent', id: endId });
    addFlow(builder, startId, endId);
  }
}

/**
 * Lower a flat statement list with implicit top-to-bottom flow. A `null` exit
 * breaks the chain: later statements are still lowered, since they may be jump
 * targets, but no implicit flow bridges the gap.
 */
function lowerBlockStatements(
  builder: Builder,
  statements: Statement[],
  coord: string,
): Frontier {
  let entry: string | null = null;
  let prevExit: string | null = null;
  let prevExitFlowId: string | undefined;
  let lastFrontier: Frontier | undefined;

  statements.forEach((stmt, index) => {
    // An `on` handler catches an event rather than being a flow step, so it
    // lowers out-of-chain and leaves `prevExit`/`entry` untouched.
    if (isOnHandler(stmt)) {
      if (stmt.host !== undefined) {
        // `$refText` is there even when the linker could not resolve the host.
        // Dispatching on the slot keeps this in step with the scope provider.
        lowerBoundaryHandler(builder, stmt, stmt.host.$refText, coord, index);
      } else {
        lowerOnHandler(builder, stmt, coord, index);
      }
      return;
    }

    const frontier = lowerStatement(builder, stmt, coord, index);
    // A statement always has a concrete entry node; only an empty *block*,
    // never a top-level statement, yields a null entry.
    const stmtEntry = frontier.entry!;

    if (entry === null) {
      entry = stmtEntry;
    }
    if (prevExit !== null) {
      addFlow(builder, prevExit, stmtEntry, undefined, prevExitFlowId);
    }
    prevExit = frontier.exit;
    prevExitFlowId = frontier.exitFlowId;
    lastFrontier = frontier;
  });

  // Propagate the trailing `exitFlowId` so the block's own exit flow honours a
  // reserved default-flow id when the block ends in a `while`.
  return {
    entry,
    exit: prevExit,
    ...(lastFrontier?.exitFlowId !== undefined
      ? { exitFlowId: lastFrontier.exitFlowId }
      : {}),
  };
}

/**
 * Lower a brace-delimited {@link Block}. The caller passes the fully-formed
 * coordinate including any branch segment (`<X>_t`, `<X>_e`, `<X>_b<i>`) so
 * sibling blocks never share one.
 */
function lowerBlock(builder: Builder, block: Block, coord: string): Frontier {
  return lowerBlockStatements(builder, block.statements, coord);
}

/** Dispatch one statement. `index` is its position in the block, forming `<coord>_<index>`. */
function lowerStatement(
  builder: Builder,
  stmt: Statement,
  coord: string,
  index: number,
): Frontier {
  if (isStartEvent(stmt)) {
    return lowerStartEvent(builder, stmt);
  }
  if (isEndEvent(stmt)) {
    return lowerEndEvent(builder, stmt);
  }
  if (isUserTask(stmt)) {
    return lowerUserTask(builder, stmt);
  }
  if (isServiceTask(stmt)) {
    return lowerServiceTask(builder, stmt);
  }
  if (isScriptTask(stmt)) {
    return lowerScriptTask(builder, stmt);
  }
  if (isIfStatement(stmt)) {
    return lowerIf(builder, stmt, `${coord}_${index}`);
  }
  if (isWhileStatement(stmt)) {
    return lowerWhile(builder, stmt, `${coord}_${index}`);
  }
  if (isDoWhileStatement(stmt)) {
    return lowerDoWhile(builder, stmt, `${coord}_${index}`);
  }
  if (isParallelStatement(stmt)) {
    return lowerParallel(builder, stmt, `${coord}_${index}`);
  }
  if (isGotoStatement(stmt)) {
    return lowerGoto(stmt);
  }
  if (isSubProcess(stmt)) {
    return lowerSubProcess(builder, stmt, `${coord}_${index}`);
  }
  if (isCallActivity(stmt)) {
    return lowerCallActivity(builder, stmt);
  }
  if (isThrowStatement(stmt)) {
    return lowerThrow(builder, stmt, coord, index);
  }
  if (isEmitStatement(stmt)) {
    return lowerEmit(builder, stmt, coord, index);
  }
  if (isIntermediateCatchEvent(stmt)) {
    return lowerIntermediateCatch(builder, stmt, coord, index);
  }
  // `OnHandler` is intercepted by `lowerBlockStatements` and never reaches here.
  throw new Error(
    `astToIr: unexpected statement type '${(stmt as { $type: string }).$type}'.`,
  );
}

function lowerStartEvent(builder: Builder, stmt: AstStartEvent): Frontier {
  const formFields = lowerFormFields(stmt);
  builder.flowElements.push({
    kind: 'startEvent',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...(formFields !== undefined ? { formFields } : {}),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

function lowerEndEvent(builder: Builder, stmt: AstEndEvent): Frontier {
  builder.flowElements.push({
    kind: 'endEvent',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: null };
}

/**
 * A user task is the one element with a human lifecycle, so its listener list
 * splits two ways: task events into `taskListeners` here, `start`/`end` into
 * `executionListeners` with every other element's.
 */
function lowerUserTask(builder: Builder, stmt: AstUserTask): Frontier {
  const assignee = attrValue(stmt.attrs, 'assignee');
  const formKey = attrValue(stmt.attrs, 'formKey');
  const formFields = lowerFormFields(stmt);
  const candidateGroups = attrValue(stmt.attrs, 'candidateGroups');
  const candidateUsers = attrValue(stmt.attrs, 'candidateUsers');
  const dueDate = attrValue(stmt.attrs, 'dueDate');
  const followUpDate = attrValue(stmt.attrs, 'followUpDate');
  const priority = numericOrElAttrValue(stmt.attrs, 'priority');
  const taskListeners = readTaskListeners(stmt.listeners);
  builder.flowElements.push({
    kind: 'userTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(formKey !== undefined ? { formKey } : {}),
    ...(formFields !== undefined ? { formFields } : {}),
    ...(candidateGroups !== undefined ? { candidateGroups } : {}),
    ...(candidateUsers !== undefined ? { candidateUsers } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(followUpDate !== undefined ? { followUpDate } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(taskListeners !== undefined ? { taskListeners } : {}),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/** DSL form-field types that map to an Operaton `operaton:formField`. */
const FORM_FIELD_TYPES = new Set<string>([
  'string',
  'number',
  'boolean',
  'date',
]);

function lowerFormFields(
  node: AstStartEvent | AstUserTask,
): FormField[] | undefined {
  const fields = node.forms.flatMap((f) => f.fields);
  if (fields.length === 0) {
    return undefined;
  }
  return fields.map((f) => ({
    id: f.id,
    type: toFormFieldType(f.type),
    ...(f.label !== undefined ? { label: f.label } : {}),
    ...(f.defaultValue !== undefined
      ? { defaultValue: renderFormDefault(f.defaultValue) }
      : {}),
  }));
}

function toFormFieldType(type: string): FormFieldType {
  if (FORM_FIELD_TYPES.has(type)) {
    return type as FormFieldType;
  }
  throw new Error(
    `astToIr: unsupported form field type '${type}' (expected string, number, boolean, or date).`,
  );
}

/** Literals yield their bare value; anything else falls back to its `${...}` body, evaluated as EL. */
function renderFormDefault(expr: Expr): string {
  if (isLiteralString(expr)) {
    return expr.value;
  }
  if (isLiteralBool(expr)) {
    return expr.value;
  }
  if (isLiteralInt(expr) || isLiteralDecimal(expr)) {
    return String(expr.value);
  }
  return renderExpression(expr);
}

function lowerServiceTask(builder: Builder, stmt: AstServiceTask): Frontier {
  const resultVariable = attrValue(stmt.attrs, 'resultVariable');
  builder.flowElements.push({
    kind: 'serviceTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    binding: serviceTaskBinding(stmt.attrs),
    ...(resultVariable !== undefined ? { resultVariable } : {}),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * Build the {@link CodeBinding} whichever of `class`/`expression`/`delegate`
 * the block names, in that order. `class` reads through {@link attrValue},
 * which strips the `${...}` wrapper so a bareword stays a dotted Java path; the
 * other two keep it, that text being what Operaton evaluates as EL.
 */
function codeBinding(attrs: Attribute[]): CodeBinding | undefined {
  const className = attrValue(attrs, 'class');
  if (className !== undefined) {
    return { kind: 'class', className };
  }
  const expression = rawExpressionAttrValue(attrs, 'expression');
  if (expression !== undefined) {
    return { kind: 'expression', expression };
  }
  const delegate = rawExpressionAttrValue(attrs, 'delegate');
  if (delegate !== undefined) {
    return { kind: 'delegateExpression', expression: delegate };
  }
  return undefined;
}

/** What a binding block with no key resolves to; the validator owns the diagnostic. */
const NO_BINDING: CodeBinding = { kind: 'class', className: '' };

/** The three code forms first, then `topic`, which emits `operaton:type="external"`. */
function serviceTaskBinding(attrs: Attribute[]): ServiceTaskBinding {
  const code = codeBinding(attrs);
  if (code !== undefined) {
    return code;
  }
  const topic = attrValue(attrs, 'topic');
  if (topic !== undefined) {
    return { kind: 'external', topic };
  }
  return NO_BINDING;
}

/** An unrecognized language tag is carried through as-is; the validator rejects it first. */
function lowerScriptTask(builder: Builder, stmt: AstScriptTask): Frontier {
  const { tag, code } = splitFencedScript(stmt.body);
  const resultVariable = attrValue(stmt.attrs, 'resultVariable');
  builder.flowElements.push({
    kind: 'scriptTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    format: SCRIPT_FORMAT_ALIASES[tag] ?? tag,
    code,
    ...(resultVariable !== undefined ? { resultVariable } : {}),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * Lower `if`/`else if`/`else` to an exclusive-gateway split and join.
 *
 * The trailing `else`, or the implicit fall-through standing in for an absent
 * one, is the split's default flow and never carries a condition: Operaton
 * rejects a conditioned default. With an `else` present and every branch
 * terminating, the join has no incoming flow and is pruned (see
 * {@link pruneUnreachableJoin}), reporting `exit: null`.
 */
function lowerIf(builder: Builder, stmt: IfStatement, x: string): Frontier {
  const splitId = makeGatewaySplitId(x);
  const joinId = makeGatewayJoinId(x);

  // Reserved up-front so it is stable regardless of branch count.
  const defaultFlowId = makeDefaultFlowId(splitId);

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: splitId,
    defaultFlowId,
  });
  builder.flowElements.push({ kind: 'exclusiveGateway', id: joinId });

  lowerConditionedBranches(builder, stmt, x, splitId, joinId);

  // The trailing `else`, or an implicit fall-through, is the default flow.
  if (stmt.elseBlock !== undefined) {
    const elseBranch = lowerBlock(builder, stmt.elseBlock, `${x}_e`);
    if (elseBranch.entry !== null) {
      addFlow(builder, splitId, elseBranch.entry, undefined, defaultFlowId);
    } else {
      addFlow(builder, splitId, joinId, undefined, defaultFlowId);
    }
    joinContinuation(builder, elseBranch, joinId);
  } else {
    addFlow(builder, splitId, joinId, undefined, defaultFlowId);
  }

  return { entry: splitId, exit: pruneUnreachableJoin(builder, joinId) };
}

/** An empty conditioned branch routes its condition straight to the join. */
function lowerConditionedBranches(
  builder: Builder,
  stmt: IfStatement,
  x: string,
  splitId: string,
  joinId: string,
): void {
  const conditioned: { condition: string; block: Block; seg: string }[] = [
    { condition: renderExpression(stmt.condition), block: stmt.then, seg: 't' },
    ...stmt.elseIfs.map((ei, i) => ({
      condition: renderExpression(ei.condition),
      block: ei.body,
      seg: `e${i}`,
    })),
  ];

  for (const { condition, block, seg } of conditioned) {
    const branch = lowerBlock(builder, block, `${x}_${seg}`);
    if (branch.entry !== null) {
      addFlow(builder, splitId, branch.entry, condition);
    } else {
      addFlow(builder, splitId, joinId, condition);
    }
    joinContinuation(builder, branch, joinId);
  }
}

/**
 * Lower `while (c) { body }` to a pre-test XOR loop: a loop-head gateway with a
 * conditioned flow into the body, an unconditioned default flow out, and a
 * back-edge from the body's exit. Never emits `standardLoopCharacteristics`.
 */
function lowerWhile(
  builder: Builder,
  stmt: WhileStatement,
  x: string,
): Frontier {
  const loopId = makeGatewayLoopId(x);
  const defaultFlowId = makeDefaultFlowId(loopId);

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: loopId,
    defaultFlowId,
  });

  const condition = renderExpression(stmt.condition);
  const body = lowerBlock(builder, stmt.body, x);

  if (body.entry !== null) {
    addFlow(builder, loopId, body.entry, condition);
  }
  if (body.exit !== null) {
    addFlow(builder, body.exit, loopId);
  }

  // The loop gateway's one non-back-edge outgoing flow is its unconditioned
  // default exit; surface the reserved id so the enclosing chain stamps it.
  return { entry: loopId, exit: loopId, exitFlowId: defaultFlowId };
}

/**
 * Lower `do { body } while (c)` to a post-test XOR loop: the body runs first,
 * and the loop gateway after it holds the conditioned back-edge into the body
 * plus an unconditioned default flow out.
 */
function lowerDoWhile(
  builder: Builder,
  stmt: DoWhileStatement,
  x: string,
): Frontier {
  const loopId = makeGatewayLoopId(x);
  const defaultFlowId = makeDefaultFlowId(loopId);

  const condition = renderExpression(stmt.condition);
  const body = lowerBlock(builder, stmt.body, x);

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: loopId,
    defaultFlowId,
  });

  if (body.exit !== null) {
    addFlow(builder, body.exit, loopId, undefined, body.exitFlowId);
  }
  if (body.entry !== null) {
    addFlow(builder, loopId, body.entry, condition);
  }

  // Surface the reserved default-exit id so the enclosing chain stamps it.
  const entry = body.entry ?? loopId;
  return { entry, exit: loopId, exitFlowId: defaultFlowId };
}

/**
 * Lower `parallel { { A } { B } ... }` to an AND fork/join pair; the join is
 * pruned when every branch terminates. No condition is emitted on a
 * fork-outgoing flow, Operaton ignoring one there.
 */
function lowerParallel(
  builder: Builder,
  stmt: ParallelStatement,
  x: string,
): Frontier {
  const forkId = makeGatewayForkId(x);
  const joinId = makeGatewayJoinId(x);

  builder.flowElements.push({ kind: 'parallelGateway', id: forkId });
  builder.flowElements.push({ kind: 'parallelGateway', id: joinId });

  stmt.branches.forEach((branch, branchIndex) => {
    const lowered = lowerBlock(builder, branch, `${x}_b${branchIndex}`);
    if (lowered.entry !== null) {
      addFlow(builder, forkId, lowered.entry);
    } else {
      addFlow(builder, forkId, joinId);
    }
    joinContinuation(builder, lowered, joinId);
  });

  return { entry: forkId, exit: pruneUnreachableJoin(builder, joinId) };
}

/**
 * Lower a `subprocess` into a nested flow container: its own
 * `flowElements`/`sequenceFlows`, the parent's `taken` set. Implicit start/end
 * are seeded from the sub-process name, mirroring the top level's process id.
 * The container is one opaque activity node, so `entry === exit === name`.
 */
function lowerSubProcess(
  builder: Builder,
  stmt: AstSubProcess,
  x: string,
): Frontier {
  const nested: Builder = {
    flowElements: [],
    sequenceFlows: [],
    taken: builder.taken,
  };
  lowerContainerBody(nested, stmt.body.statements, x, stmt.name);

  builder.flowElements.push({
    kind: 'subProcess',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    flowElements: nested.flowElements,
    sequenceFlows: nested.sequenceFlows,
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * Lower a host-less `on` handler into a `triggeredByEvent` sub-process. The
 * caught trigger lands on the body's start event, explicit or synthesized. The
 * sub-process is not wired into the parent's flow, so this returns nothing; it
 * is also invalid BPMN without its trigger start, so an empty body still gets
 * start -> flow -> end for {@link ensureHandlerStart} to attach the trigger to.
 *
 * The handler's attribute block lands on this sub-process node, never on the
 * trigger start it wraps: that start is elided on print, so anything stored
 * there would be unrecoverable on the way back.
 */
function lowerOnHandler(
  builder: Builder,
  stmt: OnHandler,
  coord: string,
  index: number,
): void {
  const x = `${coord}_${index}`;
  const id = makeEventSubProcessId(x);

  const nested: Builder = {
    flowElements: [],
    sequenceFlows: [],
    taken: builder.taken,
  };
  lowerContainerBody(nested, stmt.body.statements, x, id);

  const start = ensureHandlerStart(nested, id);
  start.eventDefinition = handlerEventDefinition(stmt);
  if (stmt.alongside) {
    start.isInterrupting = false;
  }

  builder.flowElements.push({
    kind: 'subProcess',
    id,
    triggeredByEvent: true,
    flowElements: nested.flowElements,
    sequenceFlows: nested.sequenceFlows,
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
}

/**
 * Lower a hosted `on <Host>: <trigger>` handler into a boundary event inline in
 * the host's own container: the node plus its whole body, pushed onto the very
 * builder the host was lowered into.
 *
 * There is no wrapping container. The body's statements become siblings of the
 * main flow, so a `goto` crosses between the two in either direction, the only
 * way an escape chain can rejoin. The chain runs boundary -> body -> its own
 * end event, seeded from the boundary event id so the main flow's
 * `EndEvent_<containerId>` keeps its number whatever handlers the container has.
 *
 * Element order is a constraint. `bpmn-auto-layout` positions an attached event
 * from `attachedTo.di.bounds`, so the host shape has to exist before the
 * attacher is laid out. The boundary node is pushed when the handler statement
 * is reached, and a handler always follows its host in the statement list, so
 * the host always precedes it in `flowElements`.
 */
function lowerBoundaryHandler(
  builder: Builder,
  stmt: OnHandler,
  hostId: string,
  coord: string,
  index: number,
): void {
  const id = makeBoundaryEventId(hostId, stmt.trigger, builder.taken);
  builder.flowElements.push({
    kind: 'boundaryEvent',
    id,
    attachedToRef: hostId,
    eventDefinition: handlerEventDefinition(stmt),
    ...(stmt.alongside ? { cancelActivity: false } : {}),
    ...readEngineAttributes(stmt),
  });

  // A handler is a single-block compound, so its body's enclosing coordinate is
  // the handler's own `<X>`, the sole-block rule loop bodies follow.
  const body = lowerBlockStatements(
    builder,
    stmt.body.statements,
    `${coord}_${index}`,
  );
  if (body.entry !== null) {
    addFlow(builder, id, body.entry);
  }

  // Terminate the escape chain. An empty body has no entry at all, so the
  // boundary event itself is what falls through to the end.
  const exit = body.entry === null ? id : body.exit;
  if (exit !== null) {
    const endId = makeEndEventId(id, builder.taken);
    builder.flowElements.push({ kind: 'endEvent', id: endId });
    // Honour a reserved exit-flow id, as a container body does.
    addFlow(builder, exit, endId, undefined, body.exitFlowId);
  }
}

/**
 * The handler body's single start event. `lowerContainerBody` always leaves one
 * behind; the synthesis below is a fallback if that guarantee stops holding.
 */
function ensureHandlerStart(nested: Builder, id: string): IrStartEvent {
  const existing = nested.flowElements.find(
    (fe): fe is IrStartEvent => fe.kind === 'startEvent',
  );
  if (existing !== undefined) {
    return existing;
  }
  const startId = makeStartEventId(id, nested.taken);
  const endId = makeEndEventId(id, nested.taken);
  const start: IrStartEvent = { kind: 'startEvent', id: startId };
  nested.flowElements.push(start, { kind: 'endEvent', id: endId });
  addFlow(nested, startId, endId);
  return start;
}

/**
 * Build the caught {@link EventDefinition} for an `on` handler. An unrecognized
 * trigger word falls back to error, fields with nowhere to go (a code on
 * `compensation`, bindings on `message`/`signal`) are dropped, and a missing
 * code is catch-all.
 */
function handlerEventDefinition(stmt: OnHandler): EventDefinition {
  if (stmt.trigger === 'escalation') {
    const codeVariable = bindingVariable(stmt, 'code');
    return {
      kind: 'escalation',
      ...(stmt.code !== undefined ? { escalationCode: stmt.code } : {}),
      ...(codeVariable !== undefined ? { codeVariable } : {}),
    };
  }
  if (stmt.trigger === 'compensation') {
    return { kind: 'compensation' };
  }
  const named = namedTriggerDefinition(stmt);
  if (named !== undefined) {
    return named;
  }
  const codeVariable = bindingVariable(stmt, 'code');
  const messageVariable = bindingVariable(stmt, 'message');
  return {
    kind: 'error',
    ...(stmt.code !== undefined ? { errorCode: stmt.code } : {}),
    ...(codeVariable !== undefined ? { codeVariable } : {}),
    ...(messageVariable !== undefined ? { messageVariable } : {}),
  };
}

/** Falls back to `duration`, which is what a bare `on timer "PT1H"` with no particle needs. */
function timerParticleKind(
  particle: string | undefined,
): 'duration' | 'date' | 'cycle' {
  if (particle === 'at') {
    return 'date';
  }
  if (particle === 'every') {
    return 'cycle';
  }
  return 'duration';
}

function bindingVariable(stmt: OnHandler, field: string): string | undefined {
  return stmt.bindings.find((b) => b.field === field)?.variable;
}

/** The id is the authored `name` when present, else the positional `Throw_<coord>_<index>`. */
function lowerThrow(
  builder: Builder,
  stmt: ThrowStatement,
  coord: string,
  index: number,
): Frontier {
  const id = stmt.name ?? makeThrowEventId(`${coord}_${index}`);
  builder.flowElements.push({
    kind: 'endEvent',
    id,
    eventDefinition: throwEventDefinition(stmt),
    ...readEngineAttributes(stmt),
  });
  return { entry: id, exit: null };
}

/**
 * Lower an `emit` to an intermediate throw event. BPMN has no intermediate
 * error throw, so every trigger word other than `signal`/`compensation` lowers
 * as an escalation and the validator points the author at `throw error`.
 */
function lowerEmit(
  builder: Builder,
  stmt: EmitStatement,
  coord: string,
  index: number,
): Frontier {
  const id = stmt.name ?? makeThrowEventId(`${coord}_${index}`);
  builder.flowElements.push({
    kind: 'intermediateThrowEvent',
    id,
    eventDefinition:
      stmt.trigger === 'signal'
        ? { kind: 'signal', signalName: stmt.code ?? '' }
        : stmt.trigger === 'compensation'
          ? { kind: 'compensation' }
          : { kind: 'escalation', escalationCode: stmt.code },
    ...readEngineAttributes(stmt),
  });
  return { entry: id, exit: id };
}

/** The `await` surface carries no name slot, so the id is always `Catch_<coord>_<index>`. */
function lowerIntermediateCatch(
  builder: Builder,
  stmt: IntermediateCatchEvent,
  coord: string,
  index: number,
): Frontier {
  const id = makeIntermediateCatchEventId(`${coord}_${index}`);
  builder.flowElements.push({
    kind: 'intermediateCatchEvent',
    id,
    eventDefinition: catchEventDefinition(stmt),
    ...readEngineAttributes(stmt),
  });
  return { entry: id, exit: id };
}

/** Every trigger word other than `escalation`/`compensation`/`signal` maps to `error`. */
function throwEventDefinition(stmt: ThrowStatement): EventDefinition {
  if (stmt.trigger === 'escalation') {
    return { kind: 'escalation', escalationCode: stmt.code };
  }
  if (stmt.trigger === 'compensation') {
    return { kind: 'compensation' };
  }
  if (stmt.trigger === 'signal') {
    return { kind: 'signal', signalName: stmt.code ?? '' };
  }
  return { kind: 'error', errorCode: stmt.code };
}

/**
 * The caught {@link EventDefinition} for an `await`, narrowed to message,
 * signal, timer, and conditional: error, escalation, and compensation are
 * raised with `throw`/`emit` and never awaited inline. Any other word falls
 * back to the always-true conditional.
 */
function catchEventDefinition(
  stmt: IntermediateCatchEvent,
): Extract<
  EventDefinition,
  { kind: 'message' | 'signal' | 'timer' | 'conditional' }
> {
  return (
    namedTriggerDefinition(stmt) ?? {
      kind: 'conditional',
      condition: '${true}',
    }
  );
}

/**
 * The {@link EventDefinition} for the four trigger words that mean the same
 * thing wherever they are written. A bare `on timer "PT1H"` with no particle
 * parses its time text into `code`, hence the expression fallback.
 */
function namedTriggerDefinition(stmt: {
  trigger: string;
  code?: string;
  particle?: string;
  time?: string;
  condition?: Expr;
}):
  | Extract<
      EventDefinition,
      { kind: 'message' | 'signal' | 'timer' | 'conditional' }
    >
  | undefined {
  if (stmt.trigger === 'message') {
    return { kind: 'message', messageName: stmt.code ?? '' };
  }
  if (stmt.trigger === 'signal') {
    return { kind: 'signal', signalName: stmt.code ?? '' };
  }
  if (stmt.trigger === 'timer') {
    return {
      kind: 'timer',
      timerKind: timerParticleKind(stmt.particle),
      expression: stmt.time ?? stmt.code ?? '',
    };
  }
  if (stmt.trigger === 'condition') {
    return {
      kind: 'conditional',
      condition:
        stmt.condition !== undefined
          ? renderExpression(stmt.condition)
          : '${true}',
    };
  }
  return undefined;
}

/** `calledElement` falls back to `''` when the `process` attribute is absent. */
function lowerCallActivity(builder: Builder, stmt: AstCallActivity): Frontier {
  const calledElement = attrValue(stmt.attrs, 'process') ?? '';
  const binding = callActivityBinding(stmt.attrs);
  const businessKey = rawExpressionAttrValue(stmt.attrs, 'businessKey');
  const { inMappings, outMappings } = lowerCallMappings(stmt.mappings);

  builder.flowElements.push({
    kind: 'callActivity',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    calledElement,
    ...(binding !== undefined ? { binding } : {}),
    ...(businessKey !== undefined ? { businessKey } : {}),
    ...(inMappings.length > 0 ? { inMappings } : {}),
    ...(outMappings.length > 0 ? { outMappings } : {}),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * A call activity's {@link CalledElementBinding}, the inverse of
 * `renderCallActivity` in `ir-to-dsl.ts`. `version` wins whenever present, even
 * alongside a stray `binding`: the two together are a validator error, so the
 * desugarer picks the one BPMN can use. A `binding` resolves only for a bare
 * `latest` or `deployment`.
 */
function callActivityBinding(
  attrs: Attribute[],
): CalledElementBinding | undefined {
  const versionAttr = attrs.find((a) => a.key === 'version');
  if (versionAttr !== undefined) {
    return { kind: 'version', version: numericOrElValue(versionAttr.value) };
  }
  const bindingAttr = attrs.find((a) => a.key === 'binding');
  if (
    bindingAttr !== undefined &&
    isVarRef(bindingAttr.value) &&
    bindingAttr.value.accessors.length === 0
  ) {
    if (bindingAttr.value.name === 'latest') {
      return { kind: 'latest' };
    }
    if (bindingAttr.value.name === 'deployment') {
      return { kind: 'deployment' };
    }
  }
  return undefined;
}

/**
 * Render a numeric-or-EL attribute value into plain BPMN text: an int or
 * decimal yields its digits, a string its bare text, anything else its `${...}`
 * body. Shared by a pinned `version` and the `jobPriority`/`priority` settings.
 */
function numericOrElValue(expr: Expr): string {
  if (isLiteralInt(expr) || isLiteralDecimal(expr)) {
    return String(expr.value);
  }
  if (isLiteralString(expr)) {
    return expr.value;
  }
  return renderExpression(expr);
}

/** First match wins, as in {@link attrValue}. */
function numericOrElAttrValue(
  attrs: Attribute[],
  key: string,
): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  return attr === undefined ? undefined : numericOrElValue(attr.value);
}

/** Each direction keeps its relative source order. */
function lowerCallMappings(mappings: VariableMapping[]): {
  inMappings: CallVariableMapping[];
  outMappings: CallVariableMapping[];
} {
  const inMappings: CallVariableMapping[] = [];
  const outMappings: CallVariableMapping[] = [];
  for (const mapping of mappings) {
    const lowered = lowerCallMapping(mapping);
    (mapping.direction === 'in' ? inMappings : outMappings).push(lowered);
  }
  return { inMappings, outMappings };
}

/**
 * Lower one `in`/`out` mapping. `all` (`*`) copies everything; a bare `target`
 * is the same-name shorthand; a single-segment `VarRef` source copies that
 * variable by name; anything else renders to a `${...}` body. `local` is
 * stamped only when set, so the IR never carries `local: false`.
 */
function lowerCallMapping(mapping: VariableMapping): CallVariableMapping {
  const local = mapping.local ? ({ local: true } as const) : {};
  if (mapping.all) {
    return { kind: 'all', ...local };
  }
  const target = mapping.target ?? '';
  if (mapping.source === undefined) {
    return { kind: 'variable', source: target, target, ...local };
  }
  if (isVarRef(mapping.source) && mapping.source.accessors.length === 0) {
    return { kind: 'variable', source: mapping.source.name, target, ...local };
  }
  return {
    kind: 'expression',
    sourceExpression: renderExpression(mapping.source),
    target,
    ...local,
  };
}

/**
 * The `goto` produces no node: its `entry` is the target's id and its `exit` is
 * `null`, so the enclosing chain's implicit flow lands on the target.
 */
function lowerGoto(stmt: GotoStatement): Frontier {
  // `$refText` is the target id verbatim and is there even when the linker could
  // not resolve it, which keeps the desugarer total over unresolved gotos.
  const targetId = stmt.target.$refText;
  return { entry: targetId, exit: null };
}

/** Structural rather than a union of statement types, so either kind of carrier reads the same. */
interface EngineAttributeOwner {
  attrs: Attribute[];
  listeners: AstListener[];
}

/** {@link engineAttributes} decides what is kept; this says how each field is spelled. */
function readEngineAttributes(owner: EngineAttributeOwner): EngineAttributes {
  const attrs = owner.attrs;
  return engineAttributes({
    asyncBefore: boolAttrValue(attrs, 'asyncBefore'),
    asyncAfter: boolAttrValue(attrs, 'asyncAfter'),
    exclusive: boolAttrValue(attrs, 'exclusive'),
    jobPriority: numericOrElAttrValue(attrs, 'jobPriority'),
    retryCycle: attrValue(attrs, 'retryCycle'),
    executionListeners: readExecutionListeners(owner.listeners),
  });
}

const EXECUTION_LISTENER_EVENTS: readonly ExecutionListener['event'][] = [
  'start',
  'end',
];

const TASK_LISTENER_EVENTS: readonly TaskListener['event'][] = [
  'create',
  'assign',
  'complete',
  'update',
  'delete',
  'timeout',
];

/**
 * The `on start`/`on end` callbacks, in source order. The event word, not the
 * element, splits execution from task listeners, so a task event on an element
 * with no such lifecycle is dropped here for the validator.
 */
function readExecutionListeners(
  listeners: AstListener[],
): ExecutionListener[] | undefined {
  const lowered = listenersFor(listeners, EXECUTION_LISTENER_EVENTS).map(
    (listener) => ({
      event: listener.event,
      binding: listenerBinding(listener),
    }),
  );
  return lowered.length > 0 ? lowered : undefined;
}

/**
 * The task-lifecycle callbacks, in source order. `timeout` has no lifecycle
 * transition of its own, so it carries the timer that says when it runs.
 */
function readTaskListeners(
  listeners: AstListener[],
): TaskListener[] | undefined {
  const lowered = listenersFor(listeners, TASK_LISTENER_EVENTS).map(
    (listener) => ({
      event: listener.event,
      binding: listenerBinding(listener),
      ...(listener.event === 'timeout'
        ? {
            timer: {
              kind: 'timer' as const,
              timerKind: timerParticleKind(listener.particle),
              expression: listener.time ?? '',
            },
          }
        : {}),
    }),
  );
  return lowered.length > 0 ? lowered : undefined;
}

/** The event word is a soft identifier, so membership picks the list; a word in neither is dropped. */
function listenersFor<E extends string>(
  listeners: AstListener[],
  events: readonly E[],
): (AstListener & { event: E })[] {
  return listeners.filter((listener): listener is AstListener & { event: E } =>
    (events as readonly string[]).includes(listener.event),
  );
}

/** A fenced body replaces the brace block entirely, so it is checked first. */
function listenerBinding(listener: AstListener): ListenerBinding {
  if (listener.script !== undefined) {
    const { tag, code } = splitFencedScript(listener.script);
    return { kind: 'script', format: SCRIPT_FORMAT_ALIASES[tag] ?? tag, code };
  }
  return codeBinding(listener.attrs) ?? NO_BINDING;
}

/**
 * Partition `input`/`output` into the two {@link IoMapped} lists, keeping each
 * direction's source order: the serializer emits and the engine applies in it.
 */
function readIoParameters(params: AstIoParameter[]): IoMapped {
  return ioMapped(
    lowerIoParameters(params, 'input'),
    lowerIoParameters(params, 'output'),
  );
}

/** The parameters of one direction, in source order. */
function lowerIoParameters(
  params: AstIoParameter[],
  direction: string,
): IoParameter[] {
  return params
    .filter((param) => param.direction === direction)
    .map((param) => ({ name: param.name, value: lowerIoValue(param.value) }));
}

/** Lists and maps recurse; anything else becomes the plain text {@link attrValue} resolves. */
function lowerIoValue(value: AstIoValue): IoValue {
  if (isListLiteral(value)) {
    return { kind: 'list', items: value.items.map(lowerIoValue) };
  }
  if (isMapLiteral(value)) {
    return {
      kind: 'map',
      entries: value.entries.map((entry) => ({
        key: entry.key,
        value: lowerIoValue(entry.value),
      })),
    };
  }
  if (isScriptLiteral(value)) {
    const { tag, code } = splitFencedScript(value.body);
    return { kind: 'script', format: SCRIPT_FORMAT_ALIASES[tag] ?? tag, code };
  }
  return { kind: 'text', text: exprText(value) };
}

function boolAttrValue(attrs: Attribute[], key: string): boolean | undefined {
  const attr = attrs.find((a) => a.key === key);
  if (attr === undefined || !isLiteralBool(attr.value)) {
    return undefined;
  }
  return attr.value.value === 'true';
}

/**
 * Emit a sequence flow. `forcedId` creates it with that exact id, for a
 * gateway's reserved default flow and a `while` loop's reserved default exit.
 */
function addFlow(
  builder: Builder,
  sourceRef: string,
  targetRef: string,
  condition?: string,
  forcedId?: string,
): void {
  const id =
    forcedId !== undefined
      ? forcedId
      : makeSequenceFlowId(sourceRef, targetRef, builder.taken);
  // Register a forced id in the collision set so a later synthesised flow with
  // the same source/target pair gets a `_2` suffix rather than colliding.
  if (forcedId !== undefined) {
    builder.taken.add(forcedId);
  }

  builder.sequenceFlows.push({
    id,
    ...(condition !== undefined ? { conditionExpression: condition } : {}),
    sourceRef,
    targetRef,
  });
}

/** Honours a reserved `exitFlowId`; a branch that terminated gets no continuation. */
function joinContinuation(
  builder: Builder,
  branch: Frontier,
  joinId: string,
): void {
  if (branch.exit !== null) {
    addFlow(builder, branch.exit, joinId, undefined, branch.exitFlowId);
  }
}

/**
 * Drop the synthesized join gateway when nothing flows into it, which happens
 * when every branch terminates via `end`/`throw`/`goto` or a nested compound
 * that never falls through. A join with zero incoming flows is invalid BPMN.
 */
function pruneUnreachableJoin(builder: Builder, joinId: string): string | null {
  if (builder.sequenceFlows.some((flow) => flow.targetRef === joinId)) {
    return joinId;
  }
  const index = builder.flowElements.findIndex((fe) => fe.id === joinId);
  if (index !== -1) {
    builder.flowElements.splice(index, 1);
  }
  return null;
}

/** Seeds the collision set, so a synthesised id never clashes with a named element. */
function collectNamedIds(process: Process): Set<string> {
  const taken = new Set<string>();
  const visit = (statements: Statement[]): void => {
    for (const stmt of statements) {
      if (
        isStartEvent(stmt) ||
        isEndEvent(stmt) ||
        isUserTask(stmt) ||
        isServiceTask(stmt) ||
        isScriptTask(stmt) ||
        isCallActivity(stmt)
      ) {
        taken.add(stmt.name);
      } else if (isIfStatement(stmt)) {
        visit(stmt.then.statements);
        for (const ei of stmt.elseIfs) visit(ei.body.statements);
        if (stmt.elseBlock) visit(stmt.elseBlock.statements);
      } else if (isWhileStatement(stmt) || isDoWhileStatement(stmt)) {
        visit(stmt.body.statements);
      } else if (isParallelStatement(stmt)) {
        for (const branch of stmt.branches) visit(branch.statements);
      } else if (isSubProcess(stmt)) {
        // A sub-process name is itself a document id (a goto target).
        taken.add(stmt.name);
        visit(stmt.body.statements);
      } else if (isOnHandler(stmt)) {
        // The handler id is positional and never registered, but its body's names are.
        visit(stmt.body.statements);
      } else if (isThrowStatement(stmt) || isEmitStatement(stmt)) {
        // An authored id on a throw/emit is used verbatim; an unnamed one is positional.
        if (stmt.name !== undefined) {
          taken.add(stmt.name);
        }
      }
    }
  };
  visit(process.body);
  return taken;
}

/** The `key`/`value` shape shared by an {@link Attribute} and a `ProcessAttribute`. */
type KeyValueAttr = { key: string; value: Expr };

/**
 * The first matching attribute's value, as the plain string the IR carries. NOT
 * for `expression`/`delegate`: {@link rawExpressionAttrValue} keeps their
 * `${...}` wrapper instead of stripping it.
 */
function attrValue(attrs: KeyValueAttr[], key: string): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  return attr === undefined ? undefined : exprText(attr.value);
}

/**
 * Read an expression as the plain BPMN text a body or attribute carries rather
 * than as a `${...}` body: a string literal yields its bare value, a bareword
 * its dotted path verbatim, anything else its canonical `${...}` body.
 */
function exprText(value: Expr): string {
  if (isLiteralString(value)) {
    // The lexer already stripped the surrounding quotes.
    return value.value;
  }
  if (isVarRef(value) && value.accessors.length === 0) {
    return value.name;
  }
  // A dotted VarRef renders as `${com.example.X}`; strip the `${...}` wrapper so
  // the IR carries the plain dotted path the BPMN attribute expects.
  const rendered = renderExpression(value);
  if (isVarRef(value)) {
    return stripExpressionWrapper(rendered);
  }
  return rendered;
}

/**
 * The first matching attribute's value as the `${...}` body a raw JUEL
 * attribute carries verbatim. Unlike {@link attrValue} this never strips the
 * wrapper: a bareword or dotted `VarRef` is wrapped instead, which is what
 * Operaton evaluates as EL.
 */
function rawExpressionAttrValue(
  attrs: Attribute[],
  key: string,
): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  return attr === undefined ? undefined : renderExpression(attr.value);
}

/** For dotted-identifier values the grammar parses as a `VarRef` but BPMN wants as text. */
function stripExpressionWrapper(rendered: string): string {
  if (rendered.startsWith('${') && rendered.endsWith('}')) {
    return rendered.slice(2, -1);
  }
  return rendered;
}

/** Authored inline after the process id or as a header `label = "..."`; inline wins. */
function processLabel(process: Process): string | undefined {
  if (process.label !== undefined) {
    return process.label;
  }
  for (const decl of process.decls) {
    if (decl.$type === 'ProcessLabel') {
      return decl.value;
    }
  }
  return undefined;
}

/** `operaton:versionTag`, an author-supplied label distinct from the deployment version. */
function processVersionTag(process: Process): string | undefined {
  for (const decl of process.decls) {
    if (decl.$type === 'ProcessAttribute' && decl.key === 'versionTag') {
      return attrValue([decl], 'versionTag');
    }
  }
  return undefined;
}
