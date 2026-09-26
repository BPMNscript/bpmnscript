/**
 * Synthesized ids are seeded by a structural coordinate `<X>` (the statement's
 * static position in the block tree, never a traversal counter), so lowering
 * `irToDsl` output again yields identical ids. A sub-process body is rooted at
 * its coordinate, not its name: gateway ids skip `resolveCollision`, so a
 * sub-process named like a coordinate could otherwise duplicate one.
 *
 * Throws only on a program the validator rejects.
 */

import { AstUtils } from 'langium';
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
  isCodeDecl,
  isLiteralString,
  isLiteralBool,
  isLiteralInt,
  isLiteralDecimal,
  isVarRef,
  isListLiteral,
  isMapLiteral,
  isScriptLiteral,
  integerLiteralText,
  renderExpression,
  formatPlainWordList,
  scriptFormatOf,
  splitFencedScript,
  CALL_BINDING_VALUES,
  CALL_MAPPER_KEY_BY_KIND,
  CATCH_TRIGGERS,
  DATE_PATTERN_KEY,
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  ERROR_MAPPING_HEAD,
  EXECUTION_LISTENER_EVENTS,
  FIELD_DIRECTION,
  FORM_FIELD_TYPES,
  INPUT_DIRECTION,
  isFormConstraintName,
  ON_TRIGGERS,
  OUTPUT_DIRECTION,
  PROPERTY_DIRECTION,
  START_TRIGGERS,
  STARTABLE_KEY,
  TASK_PRIORITY_KEY,
  TYPE_BINDING_KEY,
  TYPE_BINDING_VALUES,
  caughtBindingsOf,
  declaredCodeOf,
  settingsOf,
  hasFlag,
  payloadTextOf,
  timerPayloadOf,
  payloadItemOf,
  joinSettingKey,
  runSettingKey,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
  TIMER_PARTICLE_BY_KIND,
  type TimerKind,
  isNamedStatement,
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
  ParenItem,
  Setting,
  IoParameter as AstIoParameter,
  IoValue as AstIoValue,
  Listener as AstListener,
  FormField as AstFormField,
  ErrorMapping as AstErrorMapping,
} from '@bpmn-script/language';
import type {
  BpmnProcess,
  CallVariableMapper,
  CallVariableMapping,
  CatchEventDefinition,
  CodeBinding,
  EmitEventDefinition,
  EndEventDefinition,
  EngineAttributes,
  ErrorMapping as IrErrorMapping,
  EventDefinition,
  ExecutionListener,
  ExtensionProperty,
  FieldInjection,
  FlowElement,
  FormConstraintName,
  FormField,
  FormFieldConstraint,
  FormFieldType,
  FormFieldValue,
  IoMapped,
  IoParameter,
  IoValue,
  JobSettings,
  Named,
  Repeatable,
  SequenceFlow as IrSequenceFlow,
  ListenerBinding,
  ServiceTask as IrServiceTask,
  ServiceTaskBinding,
  StartEvent as IrStartEvent,
  TaskListener,
  UserTask as IrUserTask,
  VersionBinding,
} from './ir/types.js';
import {
  carriesFields,
  eventIdentities,
  ioMapped,
  jobSettings,
  splitTimerJobSettings,
} from './ir/types.js';
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
  claimDeclarationName,
  resolveCollision,
} from './synthesize-ids.js';

/**
 * A `null` `exit` suppresses both the implicit flow to the next sibling and the
 * join/end continuation.
 */
interface Frontier {
  /** `null` for an empty block, whose caller routes to the join. */
  entry: string | null;
  exit: string | null;
  /**
   * A gateway's reserved default flow id for the fall-through out of `exit`;
   * only set beside a non-null `exit`.
   */
  exitFlowId?: string;
  /**
   * Starts beyond `exit` still waiting for a step; a container body routes them
   * to its end.
   */
  waitingStarts?: string[];
}

/** `taken` is shared document-wide and seeded with every authored name. */
interface Builder {
  readonly flowElements: FlowElement[];
  readonly sequenceFlows: IrSequenceFlow[];
  readonly taken: Set<string>;
}

function nestedBuilder(parent: Builder): Builder {
  return { flowElements: [], sequenceFlows: [], taken: parent.taken };
}

/** Only the first `process` block is read. */
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

  lowerContainerBody(builder, process.body, process.name, process.name);

  const versionTag = processSetting(process, 'versionTag');
  const historyTimeToLive = processSetting(process, 'historyTimeToLive');
  const candidateStarterUsers = processSetting(
    process,
    'candidateStarterUsers',
  );
  const candidateStarterGroups = processSetting(
    process,
    'candidateStarterGroups',
  );
  const isStartableInTasklist = boolAttrValue(
    settingsOf(process.items),
    STARTABLE_KEY,
  );
  const { errorCodes, escalationCodes } = eventIdentities({
    id: process.name,
    flowElements: builder.flowElements,
    sequenceFlows: builder.sequenceFlows,
  });
  const { errorDecls, escalationDecls } = collectCodeDecls(
    process,
    errorCodes,
    escalationCodes,
  );

  return {
    id: process.name,
    ...namedAttrs(process),
    isExecutable: true,
    ...(versionTag !== undefined ? { versionTag } : {}),
    ...(historyTimeToLive !== undefined ? { historyTimeToLive } : {}),
    ...(candidateStarterUsers !== undefined ? { candidateStarterUsers } : {}),
    ...(candidateStarterGroups !== undefined ? { candidateStarterGroups } : {}),
    ...(isStartableInTasklist !== undefined ? { isStartableInTasklist } : {}),
    flowElements: builder.flowElements,
    sequenceFlows: builder.sequenceFlows,
    ...(errorDecls.length > 0 ? { errorDecls } : {}),
    ...(escalationDecls.length > 0 ? { escalationDecls } : {}),
  };
}

interface DeclaredCode {
  name?: string;
  code: string;
  message?: string;
}

/**
 * Every used code in first-use order, then unused declarations in source
 * order: the order `irToXml` writes roots and `xmlToIr` reads them back. An
 * undeclared code still gets a declaration, since a use site refers to one by
 * name.
 */
function collectCodeDecls(
  process: Process,
  usedErrorCodes: ReadonlySet<string>,
  usedEscalationCodes: ReadonlySet<string>,
): {
  errorDecls: { name: string; code: string; message?: string }[];
  escalationDecls: { name: string; code: string }[];
} {
  const errors = new Map<string, DeclaredCode>();
  const escalations = new Map<string, DeclaredCode>();
  for (const decl of process.decls) {
    if (!isCodeDecl(decl)) continue;
    const into =
      decl.kind === 'error'
        ? errors
        : decl.kind === 'escalation'
          ? escalations
          : undefined;
    const code = declaredCodeOf(decl);
    if (into === undefined || code === undefined || into.has(code)) continue;
    into.set(code, {
      name: decl.name,
      code,
      message: attrValue(settingsOf(decl.items), 'message'),
    });
  }

  const canonical = (
    used: ReadonlySet<string>,
    from: Map<string, DeclaredCode>,
  ): DeclaredCode[] => [
    ...[...used].map((code) => from.get(code) ?? { code }),
    ...[...from.values()].filter((d) => !used.has(d.code)),
  ];

  // A use site resolves error and escalation names in one scope.
  const taken = new Set<string>();
  const errorDecls = canonical(usedErrorCodes, errors).map((d) => ({
    name: claimDeclarationName(d.code, taken, d.name),
    code: d.code,
    ...(d.message !== undefined ? { message: d.message } : {}),
  }));
  const escalationDecls = canonical(usedEscalationCodes, escalations).map(
    (d) => ({
      name: claimDeclarationName(d.code, taken, d.name),
      code: d.code,
    }),
  );
  return { errorDecls, escalationDecls };
}

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
    // Never an authored `end`: that statement reports `exit: null`.
    const endId = makeEndEventId(containerId, builder.taken);
    builder.flowElements.push({ kind: 'endEvent', id: endId });
    addFlow(builder, body.exit, endId, undefined, body.exitFlowId);
    for (const start of body.waitingStarts ?? []) {
      addFlow(builder, start, endId);
    }
  } else if (body.entry === null) {
    // Empty, or only `on` handlers.
    const startId = makeStartEventId(containerId, builder.taken);
    const endId = makeEndEventId(containerId, builder.taken);
    builder.flowElements.unshift({ kind: 'startEvent', id: startId });
    builder.flowElements.push({ kind: 'endEvent', id: endId });
    addFlow(builder, startId, endId);
  }
}

/**
 * After a `null` exit later statements are still lowered (they may be jump
 * targets), but no implicit flow bridges the gap. A `start` takes no incoming
 * flow and does not consume the waiting exit, so back-to-back starts all enter
 * the next step.
 */
function lowerBlockStatements(
  builder: Builder,
  statements: Statement[],
  coord: string,
): Frontier {
  let entry: string | null = null;
  let exit: string | null = null;
  let exitFlowId: string | undefined;
  let waitingStarts: string[] = [];

  statements.forEach((stmt, index) => {
    if (isOnHandler(stmt)) {
      if (stmt.host !== undefined) {
        // As in `lowerGoto`, `$refText` survives an unresolved host.
        lowerBoundaryHandler(builder, stmt, stmt.host.$refText, coord, index);
      } else {
        lowerOnHandler(builder, stmt, coord, index);
      }
      return;
    }

    const frontier = lowerStatement(builder, stmt, coord, index);
    const stmtEntry = frontier.entry!;

    if (entry === null) {
      entry = stmtEntry;
    }
    if (isStartEvent(stmt)) {
      if (exit === null) {
        exit = stmtEntry;
      } else {
        waitingStarts.push(stmtEntry);
      }
      return;
    }
    if (exit !== null) {
      addFlow(builder, exit, stmtEntry, undefined, exitFlowId);
    }
    for (const start of waitingStarts) {
      addFlow(builder, start, stmtEntry);
    }
    exit = frontier.exit;
    exitFlowId = frontier.exitFlowId;
    waitingStarts = [];
  });

  return {
    entry,
    exit,
    ...(exitFlowId !== undefined ? { exitFlowId } : {}),
    ...(waitingStarts.length > 0 ? { waitingStarts } : {}),
  };
}

/**
 * The caller's `coord` carries the branch segment (`<X>_t`, `<X>_e`,
 * `<X>_b<i>`).
 */
function lowerBlock(builder: Builder, block: Block, coord: string): Frontier {
  return lowerBlockStatements(builder, block.statements, coord);
}

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
  throw new Error(
    `astToIr: unexpected statement type '${(stmt as { $type: string }).$type}'.`,
  );
}

function lowerStartEvent(builder: Builder, stmt: AstStartEvent): Frontier {
  const formFields = lowerFormFields(stmt);
  const eventDefinition = startEventDefinition(stmt);
  const initiator = attrValue(settingsOf(stmt.items), 'initiator');
  builder.flowElements.push({
    kind: 'startEvent',
    id: stmt.name,
    ...namedAttrs(stmt),
    ...(formFields !== undefined ? { formFields } : {}),
    ...(eventDefinition !== undefined ? { eventDefinition } : {}),
    ...(initiator !== undefined ? { initiator } : {}),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * The literal return type forces every dispatch to carry an arm per admitted
 * word.
 */
function admittedTrigger<W extends string>(
  vocabulary: readonly W[],
  written: string | undefined,
): W | undefined {
  return written === undefined
    ? undefined
    : vocabulary.find((word) => word === written);
}

function startEventDefinition(
  stmt: AstStartEvent,
): EventDefinition | undefined {
  const trigger = admittedTrigger(START_TRIGGERS, stmt.trigger);
  return trigger === undefined
    ? undefined
    : namedTriggerDefinition(trigger, stmt);
}

function endEventDefinition(
  trigger: string | undefined,
): EndEventDefinition | undefined {
  const kind = admittedTrigger(END_TRIGGERS, trigger);
  return kind === undefined ? undefined : { kind };
}

function lowerEndEvent(builder: Builder, stmt: AstEndEvent): Frontier {
  const eventDefinition = endEventDefinition(stmt.trigger);
  builder.flowElements.push({
    kind: 'endEvent',
    id: stmt.name,
    ...namedAttrs(stmt),
    ...(eventDefinition !== undefined ? { eventDefinition } : {}),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: null };
}

function lowerUserTask(builder: Builder, stmt: AstUserTask): Frontier {
  const settings = settingsOf(stmt.items);
  const assignee = attrValue(settings, 'assignee');
  const formKey = attrValue(settings, 'formKey');
  const formRef = readFormRef(settings);
  const formFields = lowerFormFields(stmt);
  const candidateGroups = attrValue(settings, 'candidateGroups');
  const candidateUsers = attrValue(settings, 'candidateUsers');
  const dueDate = attrValue(settings, 'dueDate');
  const followUpDate = attrValue(settings, 'followUpDate');
  const priority = numericOrElAttrValue(settings, 'priority');
  const taskListeners = readTaskListeners(stmt.listeners);
  builder.flowElements.push({
    kind: 'userTask',
    id: stmt.name,
    ...namedAttrs(stmt),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(formKey !== undefined ? { formKey } : {}),
    ...(formRef !== undefined ? { formRef } : {}),
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

/**
 * Dropped without a binding, which Operaton refuses to deploy; the validator
 * reports it.
 */
function readFormRef(attrs: KeyValueAttr[]): IrUserTask['formRef'] {
  const key = attrValue(attrs, 'formRef');
  const binding = versionBinding(attrs);
  return key === undefined || binding === undefined
    ? undefined
    : { key, binding };
}

function lowerFormFields(
  node: AstStartEvent | AstUserTask,
): FormField[] | undefined {
  const fields = node.forms.flatMap((f) => f.fields);
  if (fields.length === 0) {
    return undefined;
  }
  return fields.map(lowerFormField);
}

function lowerFormField(f: AstFormField): FormField {
  const settings = settingsOf(f.items);
  const datePattern = attrValue(settings, DATE_PATTERN_KEY);
  const constraints = readFormFieldConstraints(settings);
  const values: FormFieldValue[] = f.values.map((v) => ({
    id: v.id,
    ...(v.label !== undefined ? { label: v.label } : {}),
  }));
  const properties = readExtensionProperties(f.params);
  return {
    id: f.id,
    type: toFormFieldType(f.type),
    ...(f.label !== undefined ? { label: f.label } : {}),
    ...(f.defaultValue !== undefined
      ? { defaultValue: renderFormDefault(f.defaultValue) }
      : {}),
    ...(datePattern !== undefined ? { datePattern } : {}),
    ...(values.length > 0 ? { values } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(properties !== undefined ? { properties } : {}),
  };
}

function toFormFieldType(type: string): FormFieldType {
  const mapped = FORM_FIELD_TYPES.find((t) => t === type);
  if (mapped === undefined) {
    throw new Error(
      `astToIr: unsupported form field type '${type}' (expected ${formatPlainWordList(FORM_FIELD_TYPES)}).`,
    );
  }
  return mapped;
}

/**
 * Source order, which the engine validates in. Other keys (`pattern` included)
 * are left to the validator.
 */
function readFormFieldConstraints(
  settings: KeyValueAttr[],
): FormFieldConstraint[] {
  return settings
    .filter((setting): setting is KeyValueAttr & { key: FormConstraintName } =>
      isFormConstraintName(setting.key),
    )
    .map((setting) => formFieldConstraint(setting.key, setting.value));
}

/** `validator` reads the shape a `class:` binding takes. */
function formFieldConstraint(
  name: FormConstraintName,
  value: Expr,
): FormFieldConstraint {
  switch (name) {
    case 'required':
    case 'readonly':
      return { name };
    case 'validator':
      return { name, config: exprText(value) };
    case 'min':
    case 'max':
    case 'minlength':
    case 'maxlength':
      return { name, config: numericOrElValue(value) };
  }
}

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

function lowerServiceTaskLike(
  builder: Builder,
  stmt: AstServiceTask | AstSendTask | AstBusinessRuleTask,
  binding: ServiceTaskBinding,
  element?: IrServiceTask['element'],
): Frontier {
  const resultVariable = attrValue(settingsOf(stmt.items), 'resultVariable');
  builder.flowElements.push({
    kind: 'serviceTask',
    id: stmt.name,
    ...namedAttrs(stmt),
    binding:
      binding.kind === 'external'
        ? withExternalExtras(binding, stmt)
        : binding.kind === 'decision'
          ? binding
          : withDeclaredFields(binding, stmt.params),
    ...(resultVariable !== undefined ? { resultVariable } : {}),
    ...(element !== undefined ? { element } : {}),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

function lowerServiceTask(builder: Builder, stmt: AstServiceTask): Frontier {
  return lowerServiceTaskLike(
    builder,
    stmt,
    serviceTaskBinding(settingsOf(stmt.items)),
  );
}

function codeBinding(attrs: KeyValueAttr[]): CodeBinding | undefined {
  const className = attrValue(attrs, 'class');
  if (className !== undefined) {
    return { kind: 'class', className };
  }
  const expression = elAttrValue(attrs, 'expression');
  if (expression !== undefined) {
    return { kind: 'expression', expression };
  }
  const delegate = elAttrValue(attrs, 'delegate');
  if (delegate !== undefined) {
    return { kind: 'delegateExpression', expression: delegate };
  }
  return undefined;
}

/** A binding block with no key; the validator reports it. */
const NO_BINDING: CodeBinding = { kind: 'class', className: '' };

function serviceTaskBinding(attrs: KeyValueAttr[]): ServiceTaskBinding {
  return writtenBinding(attrs) ?? NO_BINDING;
}

function writtenBinding(attrs: KeyValueAttr[]): ServiceTaskBinding | undefined {
  const code = codeBinding(attrs);
  if (code !== undefined) {
    return code;
  }
  const builtin = builtinBinding(attrs);
  if (builtin !== undefined) {
    return builtin;
  }
  const topic = attrValue(attrs, 'topic');
  return topic === undefined ? undefined : { kind: 'external', topic };
}

/**
 * Lower-cased: `BpmnParse.parseServiceTaskLike` compares the attribute
 * case-insensitively.
 */
function builtinBinding(attrs: KeyValueAttr[]): ServiceTaskBinding | undefined {
  const written = attrValue(attrs, TYPE_BINDING_KEY)?.toLowerCase();
  const type = TYPE_BINDING_VALUES.find((value) => value === written);
  return type === undefined ? undefined : { kind: 'builtin', type };
}

function lowerGenericTask(builder: Builder, stmt: AstGenericTask): Frontier {
  builder.flowElements.push({
    kind: 'task',
    id: stmt.name,
    ...namedAttrs(stmt),
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
    serviceTaskBinding(settingsOf(stmt.items)),
    'send',
  );
}

function lowerReceiveTask(builder: Builder, stmt: AstReceiveTask): Frontier {
  const messageName = attrValue(settingsOf(stmt.items), 'message');
  builder.flowElements.push({
    kind: 'receiveTask',
    id: stmt.name,
    ...namedAttrs(stmt),
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
    businessRuleBinding(settingsOf(stmt.items)),
    'businessRule',
  );
}

/** Without `decision` the block reads as a service task's. */
function businessRuleBinding(attrs: KeyValueAttr[]): ServiceTaskBinding {
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

function lowerScriptTask(builder: Builder, stmt: AstScriptTask): Frontier {
  const { tag, code } = splitFencedScript(stmt.body);
  const resultVariable = attrValue(settingsOf(stmt.items), 'resultVariable');
  builder.flowElements.push({
    kind: 'scriptTask',
    id: stmt.name,
    ...namedAttrs(stmt),
    format: scriptFormatOf(tag) ?? tag,
    code,
    ...(resultVariable !== undefined ? { resultVariable } : {}),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * One split for the whole chain, so an `else if` head takes no settings. The
 * `else` (or the fall-through standing in for it) is the default flow and
 * never conditioned: Operaton rejects a conditioned default.
 */
function lowerIf(builder: Builder, stmt: IfStatement, x: string): Frontier {
  const splitId = makeGatewaySplitId(x);
  const joinId = makeGatewayJoinId(x);
  const settings = settingsOf(stmt.items);
  const defaultFlowId = reserveDefaultFlowId(builder, splitId);

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: splitId,
    defaultFlowId,
    ...readJobSettings(settings),
  });
  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: joinId,
    ...readJobSettings(settings, joinSettingKey),
  });

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

interface ForkBranch {
  block: Block;
  coord: string;
  condition?: string;
  /** Forces the flow's id, marking this branch as the gateway's default. */
  flowId?: string;
}

/**
 * An unclaimed `defaultFlowId` runs fork -> join, so an all-conditioned fork
 * has somewhere to go when none holds.
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
    ...readJobSettings(settingsOf(stmt.items)),
  });

  const condition = renderExpression(stmt.condition);
  const body = lowerBlock(builder, stmt.body, x);

  if (body.entry !== null) {
    addFlow(builder, loopId, body.entry, condition);
  }
  if (body.exit !== null) {
    addFlow(builder, body.exit, loopId, undefined, body.exitFlowId);
  }

  return { entry: loopId, exit: loopId, exitFlowId: defaultFlowId };
}

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
    ...readJobSettings(settingsOf(stmt.items)),
  });

  if (body.exit !== null) {
    addFlow(builder, body.exit, loopId, undefined, body.exitFlowId);
  }
  if (body.entry !== null) {
    addFlow(builder, loopId, body.entry, condition);
  }

  return {
    entry: body.entry ?? loopId,
    exit: loopId,
    exitFlowId: defaultFlowId,
  };
}

/**
 * Inclusive when any branch is conditioned; Operaton ignores conditions on a
 * parallel gateway. The engine takes an inclusive default only when no other
 * flow was, and an unconditioned flow always is, so the fork gets a default
 * only onto an `else` or, when every branch is conditioned, to the join
 * (without it the first time no condition holds is a stuck execution). For the
 * same reason an `else` alone does not make the fork inclusive.
 */
function lowerParallel(
  builder: Builder,
  stmt: ParallelStatement,
  x: string,
): Frontier {
  const forkId = makeGatewayForkId(x);
  const joinId = makeGatewayJoinId(x);
  const inclusive = stmt.branches.some((b) => b.condition !== undefined);
  const settings = settingsOf(stmt.items);
  const fork = readJobSettings(settings);
  const join = readJobSettings(settings, joinSettingKey);

  const fallback =
    inclusive &&
    (stmt.branches.some((b) => b.otherwise) ||
      stmt.branches.every((b) => b.condition !== undefined));

  // An idle claim would rename an authored collider for nothing.
  let defaultFlowId: string | undefined;
  if (fallback) {
    defaultFlowId = reserveDefaultFlowId(builder, forkId);
  }
  if (inclusive) {
    builder.flowElements.push({
      kind: 'inclusiveGateway',
      id: forkId,
      ...(defaultFlowId === undefined ? {} : { defaultFlowId }),
      ...fork,
    });
    builder.flowElements.push({
      kind: 'inclusiveGateway',
      id: joinId,
      ...join,
    });
  } else {
    builder.flowElements.push({ kind: 'parallelGateway', id: forkId, ...fork });
    builder.flowElements.push({ kind: 'parallelGateway', id: joinId, ...join });
  }

  // Only the first `else`, so an invalid second one lowers deterministically.
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
 * The first branch to fire cancels the rest, so the merge is a plain XOR join.
 * Flows out of an event-based gateway carry no condition (Operaton routes
 * through the event scope); a branch's settings land on its catch event, where
 * the wait state is.
 */
function lowerRace(builder: Builder, stmt: RaceStatement, x: string): Frontier {
  const raceId = makeGatewayRaceId(x);
  const joinId = makeGatewayJoinId(x);
  const settings = settingsOf(stmt.items);

  builder.flowElements.push({
    kind: 'eventBasedGateway',
    id: raceId,
    ...readJobSettings(settings),
  });
  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: joinId,
    ...readJobSettings(settings, joinSettingKey),
  });

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

function lowerSubProcess(
  builder: Builder,
  stmt: AstSubProcess,
  x: string,
): Frontier {
  const nested = nestedBuilder(builder);
  lowerContainerBody(nested, stmt.body.statements, x, stmt.name);

  builder.flowElements.push({
    kind: 'subProcess',
    id: stmt.name,
    ...namedAttrs(stmt),
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
 * Settings land on the sub-process, except the timer-job ones, which the
 * engine reads only off the start event that declares the timer.
 */
function lowerOnHandler(
  builder: Builder,
  stmt: OnHandler,
  coord: string,
  index: number,
): void {
  const x = `${coord}_${index}`;
  const id = makeEventSubProcessId(x);

  const nested = nestedBuilder(builder);
  lowerContainerBody(nested, stmt.body.statements, x, id);

  const start = ensureHandlerStart(nested, id);
  start.eventDefinition = handlerEventDefinition(stmt);
  if (hasFlag(stmt.items, 'alongside')) {
    start.isInterrupting = false;
  }

  let settings = readEngineAttributes(stmt);
  if (start.eventDefinition.kind === 'timer') {
    const { timer, continuation } = splitTimerJobSettings(settings);
    Object.assign(start, timer);
    settings = continuation;
  }

  builder.flowElements.push({
    kind: 'subProcess',
    id,
    triggeredByEvent: true,
    flowElements: nested.flowElements,
    sequenceFlows: nested.sequenceFlows,
    ...settings,
  });
}

/**
 * The body lowers inline as siblings of the main flow, so a `goto` can cross
 * between the two, the only way an escape chain can rejoin. Its end id is
 * seeded from the boundary id so the main flow's end keeps its number.
 * The host must precede the boundary event: `bpmn-auto-layout` positions it
 * from the host's bounds.
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
    ...(hasFlag(stmt.items, 'alongside') ? { cancelActivity: false } : {}),
    ...readEngineAttributes(stmt),
  });

  const body = lowerBlockStatements(
    builder,
    stmt.body.statements,
    `${coord}_${index}`,
  );
  if (body.entry !== null) {
    addFlow(builder, id, body.entry);
  }

  // An empty body has no entry, so the boundary event itself falls through.
  const exit = body.entry === null ? id : body.exit;
  if (exit !== null) {
    const endId = makeEndEventId(id, builder.taken);
    builder.flowElements.push({ kind: 'endEvent', id: endId });
    addFlow(builder, exit, endId, undefined, body.exitFlowId);
  }
}

/**
 * Missing only when `pruneUnreachableJoin` spliced out an authored start named
 * like a later join (a name the validator refuses).
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
 * An unadmitted word falls back to error, the kind its validator message speaks
 * of.
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
      const code = raisedCodeOf(stmt.items);
      return {
        kind: 'escalation',
        ...(code !== undefined ? { escalationCode: code } : {}),
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
      const code = raisedCodeOf(stmt.items);
      return {
        kind: 'error',
        ...(code !== undefined ? { errorCode: code } : {}),
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

function timerParticleKind(particle: string | undefined): TimerKind {
  for (const [kind, word] of Object.entries(TIMER_PARTICLE_BY_KIND)) {
    if (word === particle) {
      return kind as TimerKind;
    }
  }
  return 'duration';
}

function bindingVariable(stmt: OnHandler, field: string): string | undefined {
  return caughtBindingsOf(stmt.items).find((b) => b.field === field)?.variable;
}

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
    ...thrownMessageBinding(eventDefinition, settingsOf(stmt.items)),
    ...readEngineAttributes(stmt),
  });
  return { entry: id, exit: null };
}

function thrownMessageBinding(
  def: EventDefinition,
  attrs: KeyValueAttr[],
): { binding?: ServiceTaskBinding } {
  if (def.kind !== 'message') {
    return {};
  }
  const binding = writtenBinding(attrs);
  return binding === undefined ? {} : { binding };
}

/**
 * A link ends the chain: `BpmnParse.parseSequenceFlow` refuses a flow out of a
 * link throw.
 */
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
    ...thrownMessageBinding(eventDefinition, settingsOf(stmt.items)),
    ...readEngineAttributes(stmt),
  });
  return eventDefinition.kind === 'link'
    ? { entry: id, exit: null }
    : { entry: id, exit: id };
}

/**
 * An unadmitted word lowers as an escalation, since BPMN has no intermediate
 * error throw.
 */
function emitEventDefinition(stmt: EmitStatement): EmitEventDefinition {
  const trigger = admittedTrigger(EMIT_TRIGGERS, stmt.trigger);
  const code = raisedCodeOf(stmt.items);
  switch (trigger) {
    case 'message':
      return { kind: 'message', messageName: code ?? '' };
    case 'signal':
      return { kind: 'signal', signalName: code ?? '' };
    case 'compensation':
      return { kind: 'compensation' };
    case 'link':
      return { kind: 'link', linkName: code ?? '' };
    case 'escalation':
    case undefined:
      return { kind: 'escalation', escalationCode: code };
    default: {
      const exhaustive: never = trigger;
      throw new Error(
        `astToIr: unhandled emit trigger: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function lowerIntermediateCatch(
  builder: Builder,
  stmt: IntermediateCatchEvent,
  coord: string,
  index: number,
): Frontier {
  const id = stmt.name ?? makeIntermediateCatchEventId(`${coord}_${index}`);
  builder.flowElements.push({
    kind: 'intermediateCatchEvent',
    id,
    eventDefinition: catchEventDefinition(stmt),
    ...readEngineAttributes(stmt),
  });
  return { entry: id, exit: id };
}

function throwEventDefinition(stmt: ThrowStatement): EndEventDefinition {
  const trigger = admittedTrigger(THROW_TRIGGERS, stmt.trigger);
  const code = raisedCodeOf(stmt.items);
  switch (trigger) {
    case 'escalation':
      return { kind: 'escalation', escalationCode: code };
    case 'compensation':
      return { kind: 'compensation' };
    case 'signal':
      return { kind: 'signal', signalName: code ?? '' };
    case 'message':
      return { kind: 'message', messageName: code ?? '' };
    case 'error':
    case undefined:
      return { kind: 'error', errorCode: code };
    default: {
      const exhaustive: never = trigger;
      throw new Error(
        `astToIr: unhandled throw trigger: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

const ALWAYS_TRUE = '${true}';

function catchEventDefinition(
  stmt: IntermediateCatchEvent | RaceBranch,
): CatchEventDefinition {
  const trigger = admittedTrigger(CATCH_TRIGGERS, stmt.trigger);
  return trigger === undefined
    ? { kind: 'conditional', condition: ALWAYS_TRUE }
    : namedTriggerDefinition(trigger, stmt);
}

/**
 * A bare word naming a declaration resolves to that declaration's `code`
 * setting.
 */
function raisedCodeOf(items: ParenItem[]): string | undefined {
  const payload = payloadItemOf(items)?.value;
  const declaration =
    payload !== undefined && isVarRef(payload) ? payload.ref.ref : undefined;
  return declaration !== undefined
    ? declaredCodeOf(declaration)
    : payloadTextOf(items);
}

type NamedTrigger = (typeof CATCH_TRIGGERS)[number];

function namedTriggerDefinition(
  trigger: NamedTrigger,
  stmt: { items: ParenItem[] },
): CatchEventDefinition {
  switch (trigger) {
    case 'message':
      return { kind: 'message', messageName: raisedCodeOf(stmt.items) ?? '' };
    case 'signal':
      return { kind: 'signal', signalName: raisedCodeOf(stmt.items) ?? '' };
    case 'timer': {
      const timer = timerPayloadOf(stmt.items);
      return {
        kind: 'timer',
        timerKind: timerParticleKind(timer?.particle),
        expression: timer?.time ?? '',
      };
    }
    case 'condition': {
      const expr = payloadItemOf(stmt.items)?.value;
      return {
        kind: 'conditional',
        condition: expr !== undefined ? renderExpression(expr) : ALWAYS_TRUE,
      };
    }
    case 'link':
      return { kind: 'link', linkName: raisedCodeOf(stmt.items) ?? '' };
    default: {
      const exhaustive: never = trigger;
      throw new Error(
        `astToIr: unhandled named trigger: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function lowerCallActivity(builder: Builder, stmt: AstCallActivity): Frontier {
  const settings = settingsOf(stmt.items);
  const calledElement = attrValue(settings, 'process') ?? '';
  const binding = versionBinding(settings);
  const businessKey = elAttrValue(settings, 'businessKey');
  const mapper = callVariableMapper(settings);
  const { inMappings, outMappings } = lowerCallMappings(stmt.mappings);

  builder.flowElements.push({
    kind: 'callActivity',
    id: stmt.name,
    ...namedAttrs(stmt),
    calledElement,
    ...(binding !== undefined ? { binding } : {}),
    ...(businessKey !== undefined ? { businessKey } : {}),
    ...(mapper !== undefined ? { mapper } : {}),
    ...(inMappings.length > 0 ? { inMappings } : {}),
    ...(outMappings.length > 0 ? { outMappings } : {}),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/** Class first, the order Operaton resolves them in. */
function callVariableMapper(
  attrs: KeyValueAttr[],
): CallVariableMapper | undefined {
  const className = attrValue(attrs, CALL_MAPPER_KEY_BY_KIND.class);
  if (className !== undefined) {
    return { kind: 'class', className };
  }
  const expression = elAttrValue(
    attrs,
    CALL_MAPPER_KEY_BY_KIND.delegateExpression,
  );
  if (expression !== undefined) {
    return { kind: 'delegateExpression', expression };
  }
  return undefined;
}

/** `version` wins over a stray `binding` (the pair is a validator error). */
function versionBinding(attrs: KeyValueAttr[]): VersionBinding | undefined {
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
    const word = bindingAttr.value.ref.$refText;
    const kind = CALL_BINDING_VALUES.find((value) => value === word);
    if (kind !== undefined) return { kind };
  }
  return undefined;
}

function numericOrElValue(expr: Expr): string {
  const integer = integerLiteralText(expr);
  if (integer !== undefined) {
    return integer;
  }
  if (isLiteralDecimal(expr)) {
    return String(expr.value);
  }
  return elText(expr);
}

function numericOrElAttrValue(
  attrs: KeyValueAttr[],
  key: string,
): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  return attr === undefined ? undefined : numericOrElValue(attr.value);
}

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
    return {
      kind: 'variable',
      source: mapping.source.ref.$refText,
      target,
      ...local,
    };
  }
  return {
    kind: 'expression',
    sourceExpression: elText(mapping.source),
    target,
    ...local,
  };
}

/** No node: `entry` is the target. `$refText` survives an unresolved link. */
function lowerGoto(stmt: GotoStatement): Frontier {
  return { entry: stmt.target.$refText, exit: null };
}

interface RepeatOwner {
  cardinality?: Expr;
  collection?: Expr;
  element?: string;
  completion?: Expr;
  sequential: boolean;
  items: ParenItem[];
}

/**
 * A clause is present iff it sets a count or collection (`sequential` is
 * `false` either way); without one even stray `run*` settings are dropped.
 * The engine reads no priority off the loop, so `runJobPriority` is dropped.
 */
function readLoop(stmt: RepeatOwner): Repeatable {
  if (stmt.cardinality === undefined && stmt.collection === undefined) {
    return {};
  }
  const { jobPriority, ...runSettings } = readJobSettings(
    settingsOf(stmt.items),
    runSettingKey,
  );
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
      ...(stmt.sequential ? { sequential: true as const } : {}),
      ...runSettings,
    },
  };
}

/**
 * The engine `Integer.parseInt`s a body without `${`, so only a plain integer
 * goes in bare.
 */
function loopCardinality(expr: Expr): string {
  if (isLiteralInt(expr)) {
    return String(expr.value);
  }
  return renderExpression(expr);
}

/**
 * Operaton reads `operaton:collection` as a variable name unless it carries
 * `${`, so an accessor such as `order.lines` must become an expression.
 */
function loopCollection(expr: Expr): string {
  if (isVarRef(expr) && expr.accessors.length === 0) {
    return expr.ref.$refText;
  }
  if (isLiteralString(expr)) {
    return expr.value;
  }
  return renderExpression(expr);
}

interface EngineAttributeOwner {
  items: ParenItem[];
  listeners: AstListener[];
}

function readEngineAttributes(owner: EngineAttributeOwner): EngineAttributes {
  const executionListeners = readExecutionListeners(owner.listeners);
  return {
    ...readJobSettings(settingsOf(owner.items)),
    ...(executionListeners === undefined ? {} : { executionListeners }),
  };
}

/**
 * `keyOf` respells the keys for a second carrier sharing the parens (join, loop
 * run).
 */
function readJobSettings(
  attrs: Setting[],
  keyOf: (key: string) => string = (key) => key,
): JobSettings {
  return jobSettings({
    asyncBefore: boolAttrValue(attrs, keyOf('asyncBefore')),
    asyncAfter: boolAttrValue(attrs, keyOf('asyncAfter')),
    exclusive: boolAttrValue(attrs, keyOf('exclusive')),
    jobPriority: numericOrElAttrValue(attrs, keyOf('jobPriority')),
    retryCycle: attrValue(attrs, keyOf('retryCycle')),
  });
}

/**
 * A task event on an element without a task lifecycle is dropped; the validator
 * reports it.
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

function listenersFor<E extends string>(
  listeners: AstListener[],
  events: readonly E[],
): (AstListener & { event: E })[] {
  return listeners.filter((listener): listener is AstListener & { event: E } =>
    (events as readonly string[]).includes(listener.event),
  );
}

function listenerBinding(listener: AstListener): ListenerBinding {
  if (listener.script !== undefined) {
    const { tag, code } = splitFencedScript(listener.script);
    return { kind: 'script', format: scriptFormatOf(tag) ?? tag, code };
  }
  return withDeclaredFields(
    codeBinding(settingsOf(listener.items)) ?? NO_BINDING,
    listener.params,
  );
}

function withDeclaredFields<
  B extends CodeBinding | Extract<ServiceTaskBinding, { kind: 'builtin' }>,
>(binding: B, params: AstIoParameter[]): B {
  if (!carriesFields(binding)) return binding;
  const fields = readFieldInjections(params);
  return fields.length === 0 ? binding : { ...binding, fields };
}

/**
 * A list, map, or script has no `operaton:field` form; the validator reports
 * it.
 */
function readFieldInjections(params: AstIoParameter[]): FieldInjection[] {
  return params
    .filter((param) => param.direction === FIELD_DIRECTION)
    .flatMap((param) => {
      const value = lowerIoValue(param.value);
      return value.kind === 'text'
        ? [{ name: param.name, value: value.text }]
        : [];
    });
}

function readExtensionProperties(
  params: AstIoParameter[],
): ExtensionProperty[] | undefined {
  const properties = params
    .filter((param) => param.direction === PROPERTY_DIRECTION)
    .flatMap((param) => {
      const value = lowerIoValue(param.value);
      return value.kind === 'text'
        ? [{ key: param.name, value: value.text }]
        : [];
    });
  return properties.length === 0 ? undefined : properties;
}

function withExternalExtras(
  binding: Extract<ServiceTaskBinding, { kind: 'external' }>,
  stmt: AstServiceTask | AstSendTask | AstBusinessRuleTask,
): Extract<ServiceTaskBinding, { kind: 'external' }> {
  const taskPriority = numericOrElAttrValue(
    settingsOf(stmt.items),
    TASK_PRIORITY_KEY,
  );
  const properties = readExtensionProperties(stmt.params);
  const errorMappings = lowerErrorMappings(stmt.errorMappings);
  return {
    ...binding,
    ...(taskPriority !== undefined ? { taskPriority } : {}),
    ...(properties !== undefined ? { properties } : {}),
    ...(errorMappings !== undefined ? { errorMappings } : {}),
  };
}

function lowerErrorMappings(
  mappings: AstErrorMapping[],
): IrErrorMapping[] | undefined {
  const lowered = mappings
    .filter((mapping) => mapping.trigger === ERROR_MAPPING_HEAD)
    .map((mapping) => ({
      errorCode: loweredErrorCode(mapping),
      condition: renderExpression(mapping.condition),
    }));
  return lowered.length === 0 ? undefined : lowered;
}

function loweredErrorCode(mapping: AstErrorMapping): string {
  const declaration = mapping.code.ref;
  const code =
    declaration !== undefined ? declaredCodeOf(declaration) : undefined;
  return code ?? mapping.code.$refText;
}

function readIoParameters(params: AstIoParameter[]): IoMapped {
  return ioMapped(
    lowerIoParameters(params, INPUT_DIRECTION),
    lowerIoParameters(params, OUTPUT_DIRECTION),
  );
}

function lowerIoParameters(
  params: AstIoParameter[],
  direction: string,
): IoParameter[] {
  return params
    .filter((param) => param.direction === direction)
    .map((param) => ({ name: param.name, value: lowerIoValue(param.value) }));
}

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
    return { kind: 'script', format: scriptFormatOf(tag) ?? tag, code };
  }
  return { kind: 'text', text: elText(value) };
}

function boolAttrValue(
  attrs: KeyValueAttr[],
  key: string,
): boolean | undefined {
  const attr = attrs.find((a) => a.key === key);
  if (attr === undefined || !isLiteralBool(attr.value)) {
    return undefined;
  }
  return attr.value.value === 'true';
}

/**
 * Claimed before branches lower, or a statement named `default` could take the
 * same flow id.
 */
function reserveDefaultFlowId(builder: Builder, gatewayId: string): string {
  const id = resolveCollision(makeDefaultFlowId(gatewayId), builder.taken);
  builder.taken.add(id);
  return id;
}

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

function joinContinuation(
  builder: Builder,
  branch: Frontier,
  joinId: string,
): void {
  if (branch.exit !== null) {
    addFlow(builder, branch.exit, joinId, undefined, branch.exitFlowId);
  }
}

/** A join with no incoming flow (every branch terminated) is invalid BPMN. */
function pruneUnreachableJoin(builder: Builder, joinId: string): string | null {
  if (builder.sequenceFlows.some((flow) => flow.targetRef === joinId)) {
    return joinId;
  }
  builder.flowElements.splice(
    builder.flowElements.findIndex((fe) => fe.id === joinId),
    1,
  );
  return null;
}

function collectNamedIds(process: Process): Set<string> {
  return new Set(
    AstUtils.streamAst(process)
      .filter(isNamedStatement)
      .map((stmt) => stmt.name),
  );
}

type KeyValueAttr = { key: string; value: Expr };

function namedAttrs(stmt: { items: ParenItem[] }): Named {
  const attrs = settingsOf(stmt.items);
  const name = attrValue(attrs, 'label');
  const documentation = attrValue(attrs, 'documentation');
  return {
    ...(name !== undefined ? { name } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
  };
}

function attrValue(attrs: KeyValueAttr[], key: string): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  return attr === undefined ? undefined : exprText(attr.value);
}

/**
 * For text the engine takes as written (`label`, `class`): a bareword or dotted
 * path stays verbatim. Keys the engine evaluates as EL use {@link elText},
 * which keeps a bareword wrapped so it stays a variable lookup.
 */
function exprText(value: Expr): string {
  if (isLiteralString(value)) {
    return value.value;
  }
  if (isVarRef(value) && value.accessors.length === 0) {
    return value.ref.$refText;
  }
  // A dotted VarRef renders as `${com.example.X}`; BPMN wants the bare path.
  const rendered = renderExpression(value);
  if (isVarRef(value)) {
    return stripExpressionWrapper(rendered);
  }
  return rendered;
}

function elText(value: Expr): string {
  if (isLiteralString(value)) {
    return value.value;
  }
  return renderExpression(value);
}

function elAttrValue(attrs: KeyValueAttr[], key: string): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  return attr === undefined ? undefined : elText(attr.value);
}

function stripExpressionWrapper(rendered: string): string {
  if (rendered.startsWith('${') && rendered.endsWith('}')) {
    return rendered.slice(2, -1);
  }
  return rendered;
}

function processSetting(process: Process, key: string): string | undefined {
  return attrValue(settingsOf(process.items), key);
}
