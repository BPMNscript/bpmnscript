/**
 * Desugaring AST -> IR. Lowers the Langium AST into the flat, BPMN-shaped
 * {@link BpmnProcess}: control-flow keywords become gateways and sequence
 * flows, implicit flow and implicit start/end events are materialized, and
 * conditions render to `${...}` bodies.
 *
 * Every synthesized id comes from `./synthesize-ids.js`, seeded by a structural
 * coordinate `<X>`: the statement's static position in the block tree, never a
 * traversal counter, so re-running this on `irToDsl` output yields identical
 * ids. See ADR 0010, Use Deterministic Structural Ids for Synthesized BPMN
 * Elements. Two things the ADR leaves open: an `on` handler owns a single
 * block, so like a loop body its enclosing coordinate is its own `<X>`; and a
 * sub-process body is rooted at that coordinate rather than at the
 * sub-process's name, because gateway ids skip `resolveCollision` and a
 * sub-process named like a coordinate could otherwise duplicate one.
 *
 * The desugarer is total: it never throws on a program the validator rejects.
 */

import {
  isStartEvent,
  isEndEvent,
  isUserTask,
  isServiceTask,
  isScriptTask,
  isGenericTask,
  isSendTask,
  isReceiveTask,
  isBusinessRuleTask,
  isIfStatement,
  isWhileStatement,
  isDoWhileStatement,
  isParallelStatement,
  isRaceStatement,
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
  formatPlainWordList,
  SCRIPT_FORMAT_ALIASES,
  splitFencedScript,
  CATCH_TRIGGERS,
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  EXECUTION_LISTENER_EVENTS,
  FORM_FIELD_TYPES,
  ON_TRIGGERS,
  START_TRIGGERS,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
  TIMER_PARTICLE_BY_KIND,
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
  GenericTask as AstGenericTask,
  SendTask as AstSendTask,
  ReceiveTask as AstReceiveTask,
  BusinessRuleTask as AstBusinessRuleTask,
  IfStatement,
  WhileStatement,
  DoWhileStatement,
  ParallelStatement,
  RaceStatement,
  RaceBranch,
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
  Repeatable,
  SequenceFlow as IrSequenceFlow,
  ListenerBinding,
  ServiceTask as IrServiceTask,
  ServiceTaskBinding,
  StartEvent as IrStartEvent,
  TaskListener,
  VersionBinding,
} from './ir/types.js';
import { engineAttributes, ioMapped } from './ir/types.js';
import {
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayRaceId,
  makeGatewayLoopId,
  makeDefaultFlowId,
  makeSequenceFlowId,
  makeStartEventId,
  makeEndEventId,
  makeThrowEventId,
  makeEventSubProcessId,
  makeBoundaryEventId,
  makeIntermediateCatchEventId,
  resolveCollision,
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
 * wide, pre-seeded with every named element id, so a synthesized id never
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
      // Honor a reserved exit-flow id, e.g. a `while` loop's default exit.
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

  // Propagate the trailing `exitFlowId` so the block's own exit flow honors a
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
  if (isGenericTask(stmt)) {
    return lowerGenericTask(builder, stmt);
  }
  if (isSendTask(stmt)) {
    return lowerSendTask(builder, stmt);
  }
  if (isReceiveTask(stmt)) {
    return lowerReceiveTask(builder, stmt);
  }
  if (isBusinessRuleTask(stmt)) {
    return lowerBusinessRuleTask(builder, stmt);
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
  if (isRaceStatement(stmt)) {
    return lowerRace(builder, stmt, `${coord}_${index}`);
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
  const eventDefinition = startEventDefinition(stmt);
  builder.flowElements.push({
    kind: 'startEvent',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...(formFields !== undefined ? { formFields } : {}),
    ...(eventDefinition !== undefined ? { eventDefinition } : {}),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * The word a position admits, or `undefined` for one it does not. The literal
 * return type is what makes every dispatch below carry an arm per word its
 * vocabulary lists, so a word cannot be admitted here and lowered as something
 * else.
 */
function admittedTrigger<W extends string>(
  vocabulary: readonly W[],
  written: string | undefined,
): W | undefined {
  return written === undefined
    ? undefined
    : vocabulary.find((word) => word === written);
}

/**
 * The trigger a top-level start carries. A word outside the start vocabulary
 * lowers to nothing, which is where `start S condition` goes: the validator
 * rejects a condition at this position, and a conditional start is outside
 * what this surface emits.
 */
function startEventDefinition(
  stmt: AstStartEvent,
): EventDefinition | undefined {
  const trigger = admittedTrigger(START_TRIGGERS, stmt.trigger);
  return trigger === undefined
    ? undefined
    : namedTriggerDefinition(trigger, stmt);
}

/**
 * The definition an `end` head's trigger lowers to. Both end-carried words are
 * payload-free, so the word is the kind; any other word lowers to no
 * definition, leaving the validator to report it.
 */
function endEventDefinition(
  trigger: string | undefined,
): EventDefinition | undefined {
  const kind = admittedTrigger(END_TRIGGERS, trigger);
  return kind === undefined ? undefined : { kind };
}

function lowerEndEvent(builder: Builder, stmt: AstEndEvent): Frontier {
  const eventDefinition = endEventDefinition(stmt.trigger);
  builder.flowElements.push({
    kind: 'endEvent',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...(eventDefinition !== undefined ? { eventDefinition } : {}),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: null };
}

/**
 * A user task is the one element with a human lifecycle, so its listener list
 * splits two ways: task events into `taskListeners`, `start`/`end` into
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
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

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
  const mapped = FORM_FIELD_TYPES.find((t) => t === type);
  if (mapped === undefined) {
    throw new Error(
      `astToIr: unsupported form field type '${type}' (expected string, number, boolean, or date).`,
    );
  }
  return mapped;
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

/** The one node the three tags share; `element` picks the tag, absent is a service task. */
function lowerServiceTaskLike(
  builder: Builder,
  stmt: AstServiceTask | AstSendTask | AstBusinessRuleTask,
  binding: ServiceTaskBinding,
  element?: IrServiceTask['element'],
): Frontier {
  const resultVariable = attrValue(stmt.attrs, 'resultVariable');
  builder.flowElements.push({
    kind: 'serviceTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    binding,
    ...(resultVariable !== undefined ? { resultVariable } : {}),
    ...(element !== undefined ? { element } : {}),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

function lowerServiceTask(builder: Builder, stmt: AstServiceTask): Frontier {
  return lowerServiceTaskLike(builder, stmt, serviceTaskBinding(stmt.attrs));
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
  return writtenBinding(attrs) ?? NO_BINDING;
}

/** `undefined` where a binding is optional and the block names none. */
function writtenBinding(attrs: Attribute[]): ServiceTaskBinding | undefined {
  const code = codeBinding(attrs);
  if (code !== undefined) {
    return code;
  }
  const topic = attrValue(attrs, 'topic');
  return topic === undefined ? undefined : { kind: 'external', topic };
}

function lowerGenericTask(builder: Builder, stmt: AstGenericTask): Frontier {
  builder.flowElements.push({
    kind: 'task',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

function lowerSendTask(builder: Builder, stmt: AstSendTask): Frontier {
  return lowerServiceTaskLike(
    builder,
    stmt,
    serviceTaskBinding(stmt.attrs),
    'send',
  );
}

/** No `message` key lowers to no `messageName` at all, not `undefined`: a genuine wait with no correlation. */
function lowerReceiveTask(builder: Builder, stmt: AstReceiveTask): Frontier {
  const messageName = attrValue(stmt.attrs, 'message');
  builder.flowElements.push({
    kind: 'receiveTask',
    id: stmt.name,
    ...(stmt.label !== undefined ? { name: stmt.label } : {}),
    ...(messageName !== undefined ? { messageName } : {}),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

function lowerBusinessRuleTask(
  builder: Builder,
  stmt: AstBusinessRuleTask,
): Frontier {
  return lowerServiceTaskLike(
    builder,
    stmt,
    businessRuleBinding(stmt.attrs),
    'businessRule',
  );
}

/**
 * `decision` names a decision table and takes {@link versionBinding} and
 * `mapDecisionResult` alongside it; with no `decision` key the block falls
 * through to the same code/topic forms a service task reads.
 */
function businessRuleBinding(attrs: Attribute[]): ServiceTaskBinding {
  const decisionRef = attrValue(attrs, 'decision');
  if (decisionRef === undefined) {
    return serviceTaskBinding(attrs);
  }
  const binding = versionBinding(attrs);
  const mapping = attrValue(attrs, 'mapDecisionResult');
  const mapDecisionResult =
    mapping === undefined ? undefined : toDecisionResultMapping(mapping);
  return {
    kind: 'decision',
    decisionRef,
    ...(binding !== undefined ? { binding } : {}),
    ...(mapDecisionResult !== undefined ? { mapDecisionResult } : {}),
  };
}

function toDecisionResultMapping(mapping: string) {
  const mapped = DECISION_RESULT_MAPPINGS.find((m) => m === mapping);
  if (mapped === undefined) {
    throw new Error(
      `astToIr: unsupported decision result mapping '${mapping}' (expected ${formatPlainWordList(DECISION_RESULT_MAPPINGS)}).`,
    );
  }
  return mapped;
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
    ...readLoop(stmt),
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
  const defaultFlowId = reserveDefaultFlowId(builder, splitId);

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: splitId,
    defaultFlowId,
  });
  builder.flowElements.push({ kind: 'exclusiveGateway', id: joinId });

  lowerForkBranches(
    builder,
    [
      {
        block: stmt.then,
        coord: `${x}_t`,
        condition: renderExpression(stmt.condition),
      },
      ...stmt.elseIfs.map((ei, i) => ({
        block: ei.body,
        coord: `${x}_e${i}`,
        condition: renderExpression(ei.condition),
      })),
      // The trailing `else` is the default flow and never carries a condition.
      ...(stmt.elseBlock !== undefined
        ? [{ block: stmt.elseBlock, coord: `${x}_e`, flowId: defaultFlowId }]
        : []),
    ],
    splitId,
    joinId,
    defaultFlowId,
  );

  return { entry: splitId, exit: pruneUnreachableJoin(builder, joinId) };
}

/** One branch of a fork: its body, that body's coordinate, and its incoming flow. */
interface ForkBranch {
  block: Block;
  coord: string;
  /** Rendered condition on the flow into the branch; absent means unconditioned. */
  condition?: string;
  /** Forces the flow's id, marking this branch as the gateway's default. */
  flowId?: string;
}

/**
 * Lower every branch of a fork and rejoin it. An empty branch routes its flow
 * straight to the join, and a branch that terminates gets no continuation out
 * of it.
 *
 * `defaultFlowId` is the id the fork reserved for its default flow. When no
 * branch claimed it, the fallback runs from the fork to the join: a split whose
 * every branch is conditioned would otherwise have nowhere to go when none of
 * them holds.
 */
function lowerForkBranches(
  builder: Builder,
  branches: ForkBranch[],
  sourceId: string,
  joinId: string,
  defaultFlowId?: string,
): void {
  for (const branch of branches) {
    const lowered = lowerBlock(builder, branch.block, branch.coord);
    addFlow(
      builder,
      sourceId,
      lowered.entry ?? joinId,
      branch.condition,
      branch.flowId,
    );
    joinContinuation(builder, lowered, joinId);
  }

  if (
    defaultFlowId !== undefined &&
    !branches.some((branch) => branch.flowId === defaultFlowId)
  ) {
    addFlow(builder, sourceId, joinId, undefined, defaultFlowId);
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
  const defaultFlowId = reserveDefaultFlowId(builder, loopId);

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
  const defaultFlowId = reserveDefaultFlowId(builder, loopId);

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
 * Lower `parallel { { A } { B } ... }` to a fork/join pair; the join is pruned
 * when every branch terminates.
 *
 * A condition on any branch makes both gateways inclusive: every branch whose
 * condition holds runs, and the join waits for exactly those. With no condition
 * anywhere the pair is an AND fork/join, Operaton ignoring a condition there.
 * An `else` branch alone does not make the split inclusive: under inclusive
 * semantics the unconditioned siblings always run, so the fallback would be
 * dead.
 *
 * The inclusive fork always gets a default flow, stamped exactly as `if` stamps
 * its own: onto the `else` branch when one is written, otherwise straight to
 * the join. A gateway whose every branch is conditioned and that carries no
 * default deploys and runs, then throws a stuck execution in Operaton the first
 * time no condition holds.
 */
function lowerParallel(
  builder: Builder,
  stmt: ParallelStatement,
  x: string,
): Frontier {
  const forkId = makeGatewayForkId(x);
  const joinId = makeGatewayJoinId(x);
  const inclusive = stmt.branches.some((b) => b.condition !== undefined);

  // Reserved only where a fallback is named: an AND split pushes no flow under
  // the id, so claiming it would move an authored collider off it for nothing.
  let defaultFlowId: string | undefined;
  if (inclusive) {
    defaultFlowId = reserveDefaultFlowId(builder, forkId);
    builder.flowElements.push({
      kind: 'inclusiveGateway',
      id: forkId,
      defaultFlowId,
    });
    builder.flowElements.push({ kind: 'inclusiveGateway', id: joinId });
  } else {
    builder.flowElements.push({ kind: 'parallelGateway', id: forkId });
    builder.flowElements.push({ kind: 'parallelGateway', id: joinId });
  }

  // Only the first `else` carries the default flow; a second one lowers as a
  // plain branch, so invalid input still has one deterministic lowering.
  const defaultIndex = inclusive
    ? stmt.branches.findIndex((b) => b.otherwise)
    : -1;

  const branches = stmt.branches.map((branch, i): ForkBranch => ({
    block: branch.body,
    coord: `${x}_b${i}`,
    ...(branch.condition !== undefined
      ? { condition: renderExpression(branch.condition) }
      : {}),
    ...(i === defaultIndex ? { flowId: defaultFlowId } : {}),
  }));

  lowerForkBranches(builder, branches, forkId, joinId, defaultFlowId);

  return { entry: forkId, exit: pruneUnreachableJoin(builder, joinId) };
}

/**
 * Lower `await { <trigger> { A } <trigger> { B } ... }` to an event-based
 * gateway, one intermediate catch event per branch, and an exclusive join. The
 * first branch to fire cancels the rest, so exactly one ever runs and the merge
 * is a plain XOR join rather than a synchronizing one.
 *
 * No flow out of the gateway carries a condition: Operaton builds no transition
 * for one and routes through the event scope instead, so a condition there
 * would be content nothing reads. A branch's settings block lands on its catch
 * event, which is where the engine's wait state actually is.
 */
function lowerRace(builder: Builder, stmt: RaceStatement, x: string): Frontier {
  const raceId = makeGatewayRaceId(x);
  const joinId = makeGatewayJoinId(x);

  builder.flowElements.push({ kind: 'eventBasedGateway', id: raceId });
  builder.flowElements.push({ kind: 'exclusiveGateway', id: joinId });

  stmt.branches.forEach((branch, i) => {
    const coord = `${x}_b${i}`;
    const catchId = makeIntermediateCatchEventId(coord);
    builder.flowElements.push({
      kind: 'intermediateCatchEvent',
      id: catchId,
      eventDefinition: catchEventDefinition(branch),
      ...readEngineAttributes(branch),
    });
    addFlow(builder, raceId, catchId);

    const lowered = lowerBlock(builder, branch.body, coord);
    addFlow(builder, catchId, lowered.entry ?? joinId);
    joinContinuation(builder, lowered, joinId);
  });

  return { entry: raceId, exit: pruneUnreachableJoin(builder, joinId) };
}

/**
 * Lower a `subprocess` or an `attempt` into a nested flow container: its own
 * `flowElements`/`sequenceFlows`, the parent's `taken` set. Implicit start/end
 * are seeded from the sub-process name, mirroring the top level's process id.
 * The container is one opaque activity node, so `entry === exit === name`.
 *
 * The two heads lower alike apart from the tag: an `attempt` carries the one
 * the engine needs before it accepts a cancel end inside the block.
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
    ...(stmt.transactional ? { element: 'transaction' as const } : {}),
    flowElements: nested.flowElements,
    sequenceFlows: nested.sequenceFlows,
    ...readLoop(stmt),
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
 * end event, seeded from the boundary event id so the main flow's end keeps its
 * number whatever handlers the container has.
 *
 * Element order is a constraint: `bpmn-auto-layout` positions an attached event
 * from `attachedTo.di.bounds`, so the host shape has to exist before the
 * attacher is laid out. A handler always follows its host in the statement
 * list, so the host always precedes it in `flowElements`.
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
    // Honor a reserved exit-flow id, as a container body does.
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
 * Build the caught {@link EventDefinition} for an `on` handler. Fields with
 * nowhere to go (a code on `compensation` or `cancel`, bindings on
 * `message`/`signal`) are dropped, and a missing code is catch-all. A word the
 * handler position does not admit falls back to error, which is the kind its
 * validator message speaks of.
 */
function handlerEventDefinition(stmt: OnHandler): EventDefinition {
  const trigger = admittedTrigger(ON_TRIGGERS, stmt.trigger);
  switch (trigger) {
    case 'message':
    case 'signal':
    case 'timer':
    case 'condition':
      return namedTriggerDefinition(trigger, stmt);
    case 'escalation': {
      const codeVariable = bindingVariable(stmt, 'code');
      return {
        kind: 'escalation',
        ...(stmt.code !== undefined ? { escalationCode: stmt.code } : {}),
        ...(codeVariable !== undefined ? { codeVariable } : {}),
      };
    }
    case 'compensation':
      return { kind: 'compensation' };
    case 'cancel':
      return { kind: 'cancel' };
    case 'error':
    case undefined: {
      const codeVariable = bindingVariable(stmt, 'code');
      const messageVariable = bindingVariable(stmt, 'message');
      return {
        kind: 'error',
        ...(stmt.code !== undefined ? { errorCode: stmt.code } : {}),
        ...(codeVariable !== undefined ? { codeVariable } : {}),
        ...(messageVariable !== undefined ? { messageVariable } : {}),
      };
    }
    default: {
      const exhaustive: never = trigger;
      throw new Error(
        `astToIr: unhandled handler trigger: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * The vocabulary's particle table read backwards. Falls back to `duration`,
 * which is what a bare `on timer "PT1H"` with no particle needs.
 */
function timerParticleKind(
  particle: string | undefined,
): 'duration' | 'date' | 'cycle' {
  for (const [kind, word] of Object.entries(TIMER_PARTICLE_BY_KIND)) {
    if (word === particle) {
      return kind as 'duration' | 'date' | 'cycle';
    }
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
  const eventDefinition = throwEventDefinition(stmt);
  builder.flowElements.push({
    kind: 'endEvent',
    id,
    eventDefinition,
    ...thrownMessageBinding(eventDefinition, stmt.attrs),
    ...readEngineAttributes(stmt),
  });
  return { entry: id, exit: null };
}

/**
 * The implementation that makes the engine really send the message. The
 * validator holds the binding keys to the `message` trigger, so nothing else
 * reaches a binding here.
 */
function thrownMessageBinding(
  def: EventDefinition,
  attrs: Attribute[],
): { binding?: ServiceTaskBinding } {
  if (def.kind !== 'message') {
    return {};
  }
  const binding = writtenBinding(attrs);
  return binding === undefined ? {} : { binding };
}

function lowerEmit(
  builder: Builder,
  stmt: EmitStatement,
  coord: string,
  index: number,
): Frontier {
  const id = stmt.name ?? makeThrowEventId(`${coord}_${index}`);
  const eventDefinition = emitEventDefinition(stmt);
  builder.flowElements.push({
    kind: 'intermediateThrowEvent',
    id,
    eventDefinition,
    ...thrownMessageBinding(eventDefinition, stmt.attrs),
    ...readEngineAttributes(stmt),
  });
  return { entry: id, exit: id };
}

/**
 * BPMN has no intermediate error throw, so a word the emit position does not
 * admit lowers as an escalation and the validator points the author at
 * `throw error`.
 */
function emitEventDefinition(stmt: EmitStatement): EventDefinition {
  const trigger = admittedTrigger(EMIT_TRIGGERS, stmt.trigger);
  switch (trigger) {
    case 'message':
      return { kind: 'message', messageName: stmt.code ?? '' };
    case 'signal':
      return { kind: 'signal', signalName: stmt.code ?? '' };
    case 'compensation':
      return { kind: 'compensation' };
    case 'escalation':
    case undefined:
      return { kind: 'escalation', escalationCode: stmt.code };
    default: {
      const exhaustive: never = trigger;
      throw new Error(
        `astToIr: unhandled emit trigger: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
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

/** A word the throw position does not admit maps to `error`. */
function throwEventDefinition(stmt: ThrowStatement): EventDefinition {
  const trigger = admittedTrigger(THROW_TRIGGERS, stmt.trigger);
  switch (trigger) {
    case 'escalation':
      return { kind: 'escalation', escalationCode: stmt.code };
    case 'compensation':
      return { kind: 'compensation' };
    case 'signal':
      return { kind: 'signal', signalName: stmt.code ?? '' };
    case 'message':
      return { kind: 'message', messageName: stmt.code ?? '' };
    case 'error':
    case undefined:
      return { kind: 'error', errorCode: stmt.code };
    default: {
      const exhaustive: never = trigger;
      throw new Error(
        `astToIr: unhandled throw trigger: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * The caught {@link EventDefinition} for an `await`, narrowed to message,
 * signal, timer, and conditional: error, escalation, and compensation are
 * raised with `throw`/`emit` and never awaited inline. A word the await
 * position does not admit falls back to the always-true conditional.
 */
function catchEventDefinition(
  stmt: IntermediateCatchEvent | RaceBranch,
): Extract<
  EventDefinition,
  { kind: 'message' | 'signal' | 'timer' | 'conditional' }
> {
  const trigger = admittedTrigger(CATCH_TRIGGERS, stmt.trigger);
  return trigger === undefined
    ? { kind: 'conditional', condition: '${true}' }
    : namedTriggerDefinition(trigger, stmt);
}

/** The trigger words that mean the same thing in every position that takes them. */
type NamedTrigger = 'message' | 'signal' | 'timer' | 'condition';

/**
 * The {@link EventDefinition} for the four trigger words that mean the same
 * thing wherever they are written. A bare `on timer "PT1H"` with no particle
 * parses its time text into `code`, hence the expression fallback.
 */
function namedTriggerDefinition(
  trigger: NamedTrigger,
  stmt: {
    code?: string;
    particle?: string;
    time?: string;
    condition?: Expr;
  },
): Extract<
  EventDefinition,
  { kind: 'message' | 'signal' | 'timer' | 'conditional' }
> {
  switch (trigger) {
    case 'message':
      return { kind: 'message', messageName: stmt.code ?? '' };
    case 'signal':
      return { kind: 'signal', signalName: stmt.code ?? '' };
    case 'timer':
      return {
        kind: 'timer',
        timerKind: timerParticleKind(stmt.particle),
        expression: stmt.time ?? stmt.code ?? '',
      };
    case 'condition':
      return {
        kind: 'conditional',
        condition:
          stmt.condition !== undefined
            ? renderExpression(stmt.condition)
            : '${true}',
      };
    default: {
      const exhaustive: never = trigger;
      throw new Error(
        `astToIr: unhandled named trigger: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** `calledElement` falls back to `''` when the `process` attribute is absent. */
function lowerCallActivity(builder: Builder, stmt: AstCallActivity): Frontier {
  const calledElement = attrValue(stmt.attrs, 'process') ?? '';
  const binding = versionBinding(stmt.attrs);
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
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * A {@link VersionBinding} read off `binding`/`version`, shared by a call
 * activity's `calledElement` pin and a decision step's decision table pin.
 * `version` wins whenever present, even alongside a stray `binding`: the two
 * together are a validator error, so the desugarer picks the one BPMN can use.
 * A `binding` resolves only for a bare `latest` or `deployment`.
 */
function versionBinding(attrs: Attribute[]): VersionBinding | undefined {
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

/** Structural, as {@link EngineAttributeOwner} is: the nine statements that take a repeat clause. */
interface RepeatOwner {
  cardinality?: Expr;
  collection?: Expr;
  element?: string;
  completion?: Expr;
  sequential: boolean;
}

/**
 * The repeat clause of a statement, as the key it contributes: a statement
 * carrying none spreads nothing at all. A clause always sets a count, a
 * collection or both, which is what tells it apart from an absent one:
 * `sequential` is a plain boolean the parser leaves `false` either way.
 */
function readLoop(stmt: RepeatOwner): Repeatable {
  if (stmt.cardinality === undefined && stmt.collection === undefined) {
    return {};
  }
  return {
    loop: {
      ...(stmt.cardinality !== undefined
        ? { cardinality: loopCardinality(stmt.cardinality) }
        : {}),
      ...(stmt.collection !== undefined
        ? { collection: loopCollection(stmt.collection) }
        : {}),
      ...(stmt.element !== undefined ? { elementVariable: stmt.element } : {}),
      ...(stmt.completion !== undefined
        ? { completionCondition: renderExpression(stmt.completion) }
        : {}),
      // Parallel is the engine default, so only the marked form is stored.
      ...(stmt.sequential ? { sequential: true as const } : {}),
    },
  };
}

/**
 * A whole number is the one count that goes into the attribute bare: Operaton
 * parses a plain `loopCardinality` body as an integer and evaluates anything
 * else as EL, so a decimal has to be wrapped to yield a number at all.
 */
function loopCardinality(expr: Expr): string {
  if (isLiteralInt(expr)) {
    return String(expr.value);
  }
  return renderExpression(expr);
}

/**
 * Operaton reads `operaton:collection` as the name of a variable unless the
 * text carries `${`, so only the two spellings that mean a name emit one: a
 * bare identifier, and a quoted string for a name an identifier cannot spell.
 * An accessor such as `order.lines` names no variable that exists and has to
 * become an expression or the process cannot run.
 */
function loopCollection(expr: Expr): string {
  if (isVarRef(expr) && expr.accessors.length === 0) {
    return expr.name;
  }
  if (isLiteralString(expr)) {
    return expr.value;
  }
  return renderExpression(expr);
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
 * Claim the id a gateway holds back for its default flow, before any branch is
 * lowered. Without the claim a statement named `default` takes the same string
 * for its own incoming flow, since that flow is `Flow_<gateway>_<statement>`,
 * and the document ends up with two flows under one id, which BPMN forbids.
 * Every shape that holds an id back for a flow it has not pushed yet comes
 * through here.
 */
function reserveDefaultFlowId(builder: Builder, gatewayId: string): string {
  const id = resolveCollision(makeDefaultFlowId(gatewayId), builder.taken);
  builder.taken.add(id);
  return id;
}

/**
 * Emit a sequence flow. `forcedId` creates it with that exact id, for a
 * gateway's reserved default flow and a `while` loop's reserved default exit.
 * Every such id comes from {@link reserveDefaultFlowId}, which already claimed
 * it, so nothing else can be holding it by the time the flow is pushed.
 */
function addFlow(
  builder: Builder,
  sourceRef: string,
  targetRef: string,
  condition?: string,
  forcedId?: string,
): void {
  const id =
    forcedId ?? makeSequenceFlowId(sourceRef, targetRef, builder.taken);

  builder.sequenceFlows.push({
    id,
    ...(condition !== undefined ? { conditionExpression: condition } : {}),
    sourceRef,
    targetRef,
  });
}

/** Honors a reserved `exitFlowId`; a branch that terminated gets no continuation. */
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

/** Seeds the collision set, so a synthesized id never clashes with a named element. */
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
        isGenericTask(stmt) ||
        isSendTask(stmt) ||
        isReceiveTask(stmt) ||
        isBusinessRuleTask(stmt) ||
        isCallActivity(stmt)
      ) {
        taken.add(stmt.name);
      } else if (isIfStatement(stmt)) {
        visit(stmt.then.statements);
        for (const ei of stmt.elseIfs) visit(ei.body.statements);
        if (stmt.elseBlock) visit(stmt.elseBlock.statements);
      } else if (isWhileStatement(stmt) || isDoWhileStatement(stmt)) {
        visit(stmt.body.statements);
      } else if (isParallelStatement(stmt) || isRaceStatement(stmt)) {
        for (const branch of stmt.branches) visit(branch.body.statements);
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
