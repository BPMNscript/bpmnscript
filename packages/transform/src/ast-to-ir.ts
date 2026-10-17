/**
 * Synthesized ids are seeded by a structural coordinate `<X>` (the statement's
 * static position in the block tree, never a traversal counter), so lowering
 * `irToDsl` output again yields identical ids. A sub-process body is rooted at
 * its coordinate, not its name: gateway ids skip `resolveCollision`, so a
 * sub-process named like a coordinate could otherwise duplicate one. The
 * validator's reserved `Gateway_..._split` pattern relies on that too: it is
 * end-anchored, so a `_2` collision suffix would slip past it.
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
  DOCUMENTATION_KEY,
  VALUE_DOCUMENTATION_KEYS,
  EXPRESSION_ANYWHERE,
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
  claimId,
} from './synthesize-ids.js';
import { HISTORY_TIME_TO_LIVE } from './ir-to-xml.js';

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

  const settings = settingsOf(process.items);
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
    ...defined({ versionTag: attrValue(settings, 'versionTag') }),
    historyTimeToLive:
      attrValue(settings, 'historyTimeToLive') ?? HISTORY_TIME_TO_LIVE,
    ...defined({
      candidateStarterUsers: attrValue(settings, 'candidateStarterUsers'),
      candidateStarterGroups: attrValue(settings, 'candidateStarterGroups'),
      isStartableInTasklist: boolAttrValue(settings, STARTABLE_KEY),
    }),
    flowElements: builder.flowElements,
    sequenceFlows: builder.sequenceFlows,
    ...(errorDecls.length > 0 ? { errorDecls } : {}),
    ...(escalationDecls.length > 0 ? { escalationDecls } : {}),
  };
}

type CodeDecls = Required<Pick<BpmnProcess, 'errorDecls' | 'escalationDecls'>>;

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
): CodeDecls {
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
    ...defined({ message: d.message }),
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
  const body = lowerBlock(builder, statements, coord);

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
 * the next step. A branch's `coord` carries its segment (`<X>_t`, `<X>_e`,
 * `<X>_b<i>`); each statement's coordinate appends its index.
 */
function lowerBlock(
  builder: Builder,
  statements: Statement[],
  coord: string,
): Frontier {
  let entry: string | null = null;
  let exit: string | null = null;
  let exitFlowId: string | undefined;
  let waitingStarts: string[] = [];

  statements.forEach((stmt, index) => {
    const x = `${coord}_${index}`;
    if (isOnHandler(stmt)) {
      if (stmt.host !== undefined) {
        // As in `lowerGoto`, `$refText` survives an unresolved host.
        lowerBoundaryHandler(builder, stmt, stmt.host.$refText, x);
      } else {
        lowerOnHandler(builder, stmt, x);
      }
      return;
    }

    const frontier = lowerStatement(builder, stmt, x);
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
    ...defined({ exitFlowId }),
    ...(waitingStarts.length > 0 ? { waitingStarts } : {}),
  };
}

function lowerStatement(
  builder: Builder,
  stmt: Statement,
  x: string,
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
    return lowerServiceTaskLike(builder, stmt);
  }
  if (isGenericTask(stmt)) {
    return lowerGenericTask(builder, stmt);
  }
  if (isSendTask(stmt)) {
    return lowerServiceTaskLike(builder, stmt, 'send');
  }
  if (isReceiveTask(stmt)) {
    return lowerReceiveTask(builder, stmt);
  }
  if (isBusinessRuleTask(stmt)) {
    return lowerServiceTaskLike(builder, stmt, 'businessRule');
  }
  if (isScriptTask(stmt)) {
    return lowerScriptTask(builder, stmt);
  }
  if (isIfStatement(stmt)) {
    return lowerIf(builder, stmt, x);
  }
  if (isWhileStatement(stmt)) {
    return lowerWhile(builder, stmt, x);
  }
  if (isDoWhileStatement(stmt)) {
    return lowerDoWhile(builder, stmt, x);
  }
  if (isParallelStatement(stmt)) {
    return lowerParallel(builder, stmt, x);
  }
  if (isRaceStatement(stmt)) {
    return lowerRace(builder, stmt, x);
  }
  if (isGotoStatement(stmt)) {
    return lowerGoto(stmt);
  }
  if (isSubProcess(stmt)) {
    return lowerSubProcess(builder, stmt, x);
  }
  if (isCallActivity(stmt)) {
    return lowerCallActivity(builder, stmt);
  }
  if (isThrowStatement(stmt)) {
    return lowerThrow(builder, stmt, x);
  }
  if (isEmitStatement(stmt)) {
    return lowerEmit(builder, stmt, x);
  }
  if (isIntermediateCatchEvent(stmt)) {
    return lowerIntermediateCatch(builder, stmt, x);
  }
  throw new Error(
    `astToIr: unexpected statement type '${(stmt as { $type: string }).$type}'.`,
  );
}

function lowerStartEvent(builder: Builder, stmt: AstStartEvent): Frontier {
  builder.flowElements.push({
    kind: 'startEvent',
    id: stmt.name,
    ...namedAttrs(stmt),
    ...defined({
      formFields: lowerFormFields(stmt),
      eventDefinition: startEventDefinition(stmt),
      initiator: attrValue(settingsOf(stmt.items), 'initiator'),
    }),
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
  builder.flowElements.push({
    kind: 'endEvent',
    id: stmt.name,
    ...namedAttrs(stmt),
    ...defined({ eventDefinition: endEventDefinition(stmt.trigger) }),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: null };
}

function lowerUserTask(builder: Builder, stmt: AstUserTask): Frontier {
  const settings = settingsOf(stmt.items);
  builder.flowElements.push({
    kind: 'userTask',
    id: stmt.name,
    ...namedAttrs(stmt),
    ...defined({
      assignee: attrValue(settings, 'assignee'),
      formKey: attrValue(settings, 'formKey'),
      formRef: readFormRef(settings),
      formFields: lowerFormFields(stmt),
      candidateGroups: attrValue(settings, 'candidateGroups'),
      candidateUsers: attrValue(settings, 'candidateUsers'),
      dueDate: attrValue(settings, 'dueDate'),
      followUpDate: attrValue(settings, 'followUpDate'),
      priority: numericOrElAttrValue(settings, 'priority'),
      taskListeners: readTaskListeners(stmt.listeners),
    }),
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
  const constraints = readFormFieldConstraints(settings);
  const values: FormFieldValue[] = f.values.map((v) => ({
    id: v.id,
    ...defined({ label: v.label }),
  }));
  return {
    id: f.id,
    type: toFormFieldType(f.type),
    ...defined({
      label: f.label,
      defaultValue:
        f.defaultValue === undefined
          ? undefined
          : renderFormDefault(f.defaultValue),
      datePattern: attrValue(settings, DATE_PATTERN_KEY),
    }),
    ...(values.length > 0 ? { values } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...defined({ properties: readExtensionProperties(f.params) }),
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
  element?: IrServiceTask['element'],
): Frontier {
  const settings = settingsOf(stmt.items);
  const binding =
    element === 'businessRule'
      ? businessRuleBinding(settings)
      : serviceTaskBinding(settings);
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
    ...defined({
      resultVariable: attrValue(settings, 'resultVariable'),
      element,
    }),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
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

function lowerReceiveTask(builder: Builder, stmt: AstReceiveTask): Frontier {
  builder.flowElements.push({
    kind: 'receiveTask',
    id: stmt.name,
    ...namedAttrs(stmt),
    ...defined({ messageName: attrValue(settingsOf(stmt.items), 'message') }),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/** Without `decision` the block reads as a service task's. */
function businessRuleBinding(attrs: KeyValueAttr[]): ServiceTaskBinding {
  const decisionRef = attrValue(attrs, 'decision');
  if (decisionRef === undefined) {
    return serviceTaskBinding(attrs);
  }
  const mapping = attrValue(attrs, 'mapDecisionResult');
  return {
    kind: 'decision',
    decisionRef,
    ...defined({
      binding: versionBinding(attrs),
      mapDecisionResult:
        mapping === undefined ? undefined : toDecisionResultMapping(mapping),
    }),
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
  builder.flowElements.push({
    kind: 'scriptTask',
    id: stmt.name,
    ...namedAttrs(stmt),
    format: scriptFormatOf(tag) ?? tag,
    code,
    ...defined({
      resultVariable: attrValue(settingsOf(stmt.items), 'resultVariable'),
    }),
    ...readLoop(stmt),
    ...readIoParameters(stmt.params),
    ...readEngineAttributes(stmt),
  });
  return { entry: stmt.name, exit: stmt.name };
}

/**
 * One split for the whole chain, so an `else if` head takes no settings. The
 * `else` (or the fall-through standing in for it) is the default flow and
 * never conditioned: Operaton rejects a conditioned default. `else fail` has
 * none, so `ExclusiveGatewayActivityBehavior.doLeave` throws when no condition
 * holds.
 */
function lowerIf(builder: Builder, stmt: IfStatement, x: string): Frontier {
  const splitId = makeGatewaySplitId(x);
  const joinId = makeGatewayJoinId(x);
  const settings = settingsOf(stmt.items);
  const defaultFlowId =
    stmt.fail === undefined
      ? reserveDefaultFlowId(builder, splitId)
      : undefined;

  builder.flowElements.push({
    kind: 'exclusiveGateway',
    id: splitId,
    ...defined({ defaultFlowId }),
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
        condition: flowCondition(stmt),
      },
      ...stmt.elseIfs.map((ei, i) => ({
        block: ei.body,
        coord: `${x}_e${i}`,
        condition: flowCondition(ei),
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
  condition?: FlowCondition;
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
    const lowered = lowerBlock(builder, branch.block.statements, branch.coord);
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

  const condition = flowCondition(stmt);
  const body = lowerBlock(builder, stmt.body.statements, x);

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

  const condition = flowCondition(stmt);
  const body = lowerBlock(builder, stmt.body.statements, x);

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
 * (without it the first time no condition holds is a stuck execution, which is
 * what `else fail` asks for). For the same reason an `else` alone does not make
 * the fork inclusive.
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
      (stmt.fail === undefined &&
        stmt.branches.every((b) => b.condition !== undefined)));

  // An idle claim would rename an authored collider for nothing.
  const defaultFlowId = fallback
    ? reserveDefaultFlowId(builder, forkId)
    : undefined;
  if (inclusive) {
    builder.flowElements.push({
      kind: 'inclusiveGateway',
      id: forkId,
      ...defined({ defaultFlowId }),
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
      ? { condition: flowCondition({ ...branch, condition: branch.condition }) }
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

    const lowered = lowerBlock(builder, branch.body.statements, coord);
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
function lowerOnHandler(builder: Builder, stmt: OnHandler, x: string): void {
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
  x: string,
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

  const body = lowerBlock(builder, stmt.body.statements, x);
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
    case 'escalation':
      return {
        kind: 'escalation',
        ...defined({
          escalationCode: raisedCodeOf(stmt.items),
          codeVariable: bindingVariable(stmt, 'code'),
        }),
      };
    case 'compensation':
      return { kind: 'compensation' };
    case 'cancel':
      return { kind: 'cancel' };
    case 'error':
    case undefined:
      return {
        kind: 'error',
        ...defined({
          errorCode: raisedCodeOf(stmt.items),
          codeVariable: bindingVariable(stmt, 'code'),
          messageVariable: bindingVariable(stmt, 'message'),
        }),
      };
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
  x: string,
): Frontier {
  const id = stmt.name ?? makeThrowEventId(x);
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
function lowerEmit(builder: Builder, stmt: EmitStatement, x: string): Frontier {
  const id = stmt.name ?? makeThrowEventId(x);
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
  }
}

function lowerIntermediateCatch(
  builder: Builder,
  stmt: IntermediateCatchEvent,
  x: string,
): Frontier {
  const id = stmt.name ?? makeIntermediateCatchEventId(x);
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
      return timerDefinition(timer?.particle, timer?.time, stmt.items);
    }
    case 'condition': {
      const expr = payloadItemOf(stmt.items)?.value;
      return {
        kind: 'conditional',
        condition: expr !== undefined ? renderExpression(expr) : ALWAYS_TRUE,
        ...defined({
          conditionDocumentation: valueDocumentation(stmt.items, 'condition'),
        }),
      };
    }
    case 'link':
      return { kind: 'link', linkName: raisedCodeOf(stmt.items) ?? '' };
  }
}

function lowerCallActivity(builder: Builder, stmt: AstCallActivity): Frontier {
  const settings = settingsOf(stmt.items);
  const calledElement = attrValue(settings, 'process') ?? '';
  const { inMappings, outMappings } = lowerCallMappings(stmt.mappings);

  builder.flowElements.push({
    kind: 'callActivity',
    id: stmt.name,
    ...namedAttrs(stmt),
    calledElement,
    ...defined({
      binding: versionBinding(settings),
      businessKey: elAttrValue(settings, 'businessKey'),
      mapper: callVariableMapper(settings),
    }),
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
  completionItems: ParenItem[];
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
  const { cardinality, collection, element, completion } = stmt;
  return {
    loop: {
      ...(cardinality !== undefined
        ? defined({
            cardinality: loopCardinality(cardinality),
            cardinalityDocumentation: valueDocumentation(stmt.items, 'count'),
          })
        : {}),
      ...defined({
        collection:
          collection === undefined ? undefined : loopCollection(collection),
      }),
      ...(element !== undefined
        ? defined({
            elementVariable: element,
            elementVariableDocumentation: valueDocumentation(
              stmt.items,
              'each',
            ),
          })
        : {}),
      ...(completion !== undefined
        ? defined({
            completionCondition: renderExpression(completion),
            completionConditionDocumentation: valueDocumentation(
              stmt.completionItems,
              'condition',
            ),
          })
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
  // Text around a template is already the composite expression the engine evaluates.
  if (isLiteralString(expr) && EXPRESSION_ANYWHERE.test(expr.value)) {
    return expr.value;
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
  return {
    ...readJobSettings(settingsOf(owner.items)),
    ...defined({ executionListeners: readExecutionListeners(owner.listeners) }),
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
            timer: timerDefinition(
              listener.particle,
              listener.time,
              listener.items,
            ),
          }
        : {}),
    }),
  );
  return lowered.length > 0 ? lowered : undefined;
}

function timerDefinition(
  particle: string | undefined,
  time: string | undefined,
  items: ParenItem[],
): Extract<EventDefinition, { kind: 'timer' }> {
  return {
    kind: 'timer',
    timerKind: timerParticleKind(particle),
    expression: time ?? '',
    ...defined({ expressionDocumentation: valueDocumentation(items, 'timer') }),
  };
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
 * A list, map, or script has no `operaton:field` or `operaton:property` form;
 * the validator reports it.
 */
function textParams(
  params: AstIoParameter[],
  direction: string,
): { name: string; text: string }[] {
  return params
    .filter((param) => param.direction === direction)
    .flatMap((param) => {
      const value = lowerIoValue(param.value);
      return value.kind === 'text'
        ? [{ name: param.name, text: value.text }]
        : [];
    });
}

function readFieldInjections(params: AstIoParameter[]): FieldInjection[] {
  return textParams(params, FIELD_DIRECTION).map(({ name, text }) => ({
    name,
    value: text,
  }));
}

function readExtensionProperties(
  params: AstIoParameter[],
): ExtensionProperty[] | undefined {
  const properties = textParams(params, PROPERTY_DIRECTION).map(
    ({ name, text }) => ({ key: name, value: text }),
  );
  return properties.length === 0 ? undefined : properties;
}

function withExternalExtras(
  binding: Extract<ServiceTaskBinding, { kind: 'external' }>,
  stmt: AstServiceTask | AstSendTask | AstBusinessRuleTask,
): Extract<ServiceTaskBinding, { kind: 'external' }> {
  return {
    ...binding,
    ...defined({
      taskPriority: numericOrElAttrValue(
        settingsOf(stmt.items),
        TASK_PRIORITY_KEY,
      ),
      properties: readExtensionProperties(stmt.params),
      errorMappings: lowerErrorMappings(stmt.errorMappings),
    }),
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
  return claimId(makeDefaultFlowId(gatewayId), builder.taken);
}

type FlowCondition = Pick<
  IrSequenceFlow,
  'conditionExpression' | 'conditionDocumentation'
>;

function flowCondition(head: {
  condition: Expr;
  conditionItems: ParenItem[];
}): FlowCondition {
  return {
    conditionExpression: renderExpression(head.condition),
    ...defined({
      conditionDocumentation: valueDocumentation(
        head.conditionItems,
        'condition',
      ),
    }),
  };
}

function addFlow(
  builder: Builder,
  sourceRef: string,
  targetRef: string,
  condition?: FlowCondition,
  forcedId?: string,
): void {
  const id =
    forcedId ?? makeSequenceFlowId(sourceRef, targetRef, builder.taken);

  builder.sequenceFlows.push({
    id,
    ...condition,
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

/** The IR leaves an unset field out rather than holding `undefined`. */
function defined<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function namedAttrs(stmt: { items: ParenItem[] }): Named {
  const attrs = settingsOf(stmt.items);
  return defined({
    name: attrValue(attrs, 'label'),
    documentation: attrValue(attrs, DOCUMENTATION_KEY),
  });
}

function valueDocumentation(
  items: ParenItem[],
  value: keyof typeof VALUE_DOCUMENTATION_KEYS,
): string | undefined {
  return attrValue(settingsOf(items), VALUE_DOCUMENTATION_KEYS[value]);
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
