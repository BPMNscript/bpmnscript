import type {
  BoundaryEvent,
  BpmnProcess,
  CallActivity,
  CodeBinding,
  EventDefinition,
  ExclusiveGateway,
  FlowElement,
  IoParameter,
  IoValue,
  ScriptTask,
  ScriptValue,
  ServiceTask,
  SequenceFlow,
  ServiceTaskBinding,
  SubProcess,
} from '../../src/ir/types.js';

/** The {@link EventDefinition} variant of one kind. */
type Def<K extends EventDefinition['kind']> = Extract<
  EventDefinition,
  { kind: K }
>;

/** A caught or thrown error; `bindings` apply only on the catch side. */
export const errorDef = (
  errorCode?: string,
  bindings?: { codeVariable?: string; messageVariable?: string },
): Def<'error'> => ({
  kind: 'error',
  ...(errorCode === undefined ? {} : { errorCode }),
  ...bindings,
});

export const escalationDef = (
  escalationCode: string,
  codeVariable?: string,
): Def<'escalation'> => ({
  kind: 'escalation',
  escalationCode,
  ...(codeVariable === undefined ? {} : { codeVariable }),
});

export const messageDef = (messageName: string): Def<'message'> => ({
  kind: 'message',
  messageName,
});

export const signalDef = (signalName: string): Def<'signal'> => ({
  kind: 'signal',
  signalName,
});

export const conditionDef = (condition: string): Def<'conditional'> => ({
  kind: 'conditional',
  condition,
});

export const timerDef = (
  timerKind: Def<'timer'>['timerKind'],
  expression: string,
): Def<'timer'> => ({ kind: 'timer', timerKind, expression });

/** The event node kinds whose payload is an {@link EventDefinition}. */
type EventNodeKind =
  | 'startEvent'
  | 'endEvent'
  | 'intermediateThrowEvent'
  | 'intermediateCatchEvent';

type EventNodeOf<K extends EventNodeKind> = Extract<FlowElement, { kind: K }>;

/**
 * An event node of `kind` carrying the definition that kind admits.
 * `isInterrupting: false` marks the trigger start of an `alongside` handler.
 */
export const typedEvent = <K extends EventNodeKind>(
  kind: K,
  id: string,
  eventDefinition: EventNodeOf<K>['eventDefinition'],
  isInterrupting?: false,
): EventNodeOf<K> =>
  ({
    kind,
    id,
    ...(isInterrupting === false ? { isInterrupting } : {}),
    eventDefinition,
  }) as EventNodeOf<K>;

/** The code a service task or a listener runs. */
export const classBinding = (className: string): CodeBinding => ({
  kind: 'class',
  className,
});

export const exprBinding = (expression: string): CodeBinding => ({
  kind: 'expression',
  expression,
});

export const delegateBinding = (expression: string): CodeBinding => ({
  kind: 'delegateExpression',
  expression,
});

/** The external-task topic form, which only a service task has. */
export const externalBinding = (topic: string): ServiceTaskBinding => ({
  kind: 'external',
  topic,
});

/** The four forms an `operaton:inputOutput` value takes. */
export const textValue = (text: string): IoValue => ({ kind: 'text', text });

export const listValue = (items: IoValue[]): IoValue => ({
  kind: 'list',
  items,
});

export const mapValue = (entries: MapEntry[]): IoValue => ({
  kind: 'map',
  entries,
});

export const scriptValue = (format: string, code: string): ScriptValue => ({
  kind: 'script',
  format,
  code,
});

type MapEntry = { key: string; value: IoValue };

/** One `operaton:entry` of a {@link mapValue}. */
export const mapEntry = (key: string, value: IoValue): MapEntry => ({
  key,
  value,
});

/** One `operaton:inputParameter`/`operaton:outputParameter`. */
export const ioParam = (name: string, value: IoValue): IoParameter => ({
  name,
  value,
});

/** A service task, in the common shape: an id and the code it binds. */
export const serviceTask = (
  id: string,
  binding: ServiceTaskBinding,
): ServiceTask => ({ kind: 'serviceTask', id, binding });

/** A script task carrying its inline body. */
export const scriptTask = (
  id: string,
  format: string,
  code: string,
): ScriptTask => ({ kind: 'scriptTask', id, format, code });

/** A call activity naming the process it calls. */
export const callActivity = (
  id: string,
  calledElement: string,
): CallActivity => ({ kind: 'callActivity', id, calledElement });

/** An exclusive gateway, naming its default flow when it has one. */
export const gateway = (
  id: string,
  defaultFlowId?: string,
): ExclusiveGateway => ({
  kind: 'exclusiveGateway',
  id,
  ...(defaultFlowId === undefined ? {} : { defaultFlowId }),
});

/** A boundary event on `host`, non-interrupting when `cancelActivity` is false. */
export const boundaryEvent = (
  id: string,
  host: string,
  eventDefinition: EventDefinition,
  cancelActivity?: false,
): BoundaryEvent => ({
  kind: 'boundaryEvent',
  id,
  attachedToRef: host,
  eventDefinition,
  ...(cancelActivity === false ? { cancelActivity } : {}),
});

/** An executable process holding the given elements and flows. */
export const processIr = (
  id: string,
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[] = [],
): BpmnProcess => ({ id, isExecutable: true, flowElements, sequenceFlows });

/** {@link processIr} under the id `p`, the default every fixture shares. */
export const minimalProcess = (
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[] = [],
): BpmnProcess => processIr('p', flowElements, sequenceFlows);

/** A one-activity process wired `S -> el -> E`. */
export const around = (el: FlowElement): BpmnProcess =>
  minimalProcess(
    [{ kind: 'startEvent', id: 'S' }, el, { kind: 'endEvent', id: 'E' }],
    [
      { id: 'F1', sourceRef: 'S', targetRef: el.id },
      { id: 'F2', sourceRef: el.id, targetRef: 'E' },
    ],
  );

/** Flows `F1..Fn` wiring the given element ids head to tail. */
export const flowChain = (...ids: string[]): SequenceFlow[] =>
  ids.slice(1).map((target, i) => ({
    id: `F${i + 1}`,
    sourceRef: ids[i]!,
    targetRef: target,
  }));

interface EdgeOptions {
  /** The flow id. Defaults to `Flow_<source>_<target>`. */
  id?: string;
  /** The guard on the flow, written as the IR carries it. */
  condition?: string;
}

/** One sequence flow between two elements. */
export const edge = (
  source: string,
  target: string,
  { id = `Flow_${source}_${target}`, condition }: EdgeOptions = {},
): SequenceFlow => ({
  id,
  sourceRef: source,
  targetRef: target,
  ...(condition === undefined ? {} : { conditionExpression: condition }),
});

/** Flows wiring the elements head to tail, each named `<prefix>_<source>_<target>`. */
const chainFlows = (
  elements: readonly FlowElement[],
  prefix: string,
): SequenceFlow[] =>
  elements.slice(1).map((el, i) => ({
    id: `${prefix}_${elements[i]!.id}_${el.id}`,
    sourceRef: elements[i]!.id,
    targetRef: el.id,
  }));

interface ChainOptions {
  /**
   * Elements appended carrying no flow of their own, which is what an event
   * sub-process is: triggered rather than flow-connected.
   */
  unwired?: FlowElement[];
  /** The flow-id prefix. Defaults to `SF`. */
  prefix?: string;
}

/** A process whose elements run head to tail over generated flows. */
export const chained = (
  elements: FlowElement[],
  { unwired = [], prefix = 'SF' }: ChainOptions = {},
): BpmnProcess => ({
  id: 'proc',
  isExecutable: true,
  flowElements: [...elements, ...unwired],
  sequenceFlows: chainFlows(elements, prefix),
});

/** A sub-process whose body runs head to tail, in the shape {@link chained} uses. */
export const chainedSub = (
  id: string,
  elements: FlowElement[],
  { unwired = [], prefix = 'SF' }: ChainOptions = {},
): SubProcess => ({
  kind: 'subProcess',
  id,
  flowElements: [...elements, ...unwired],
  sequenceFlows: chainFlows(elements, prefix),
});

/** {@link chainedSub} as an event sub-process: triggered, not flow-connected. */
export const triggeredSub = (
  id: string,
  elements: FlowElement[],
  options: ChainOptions = {},
): SubProcess => ({
  ...chainedSub(id, elements, options),
  triggeredByEvent: true,
});

/**
 * An `on ...` handler: an event sub-process whose trigger start `startId`
 * carries `eventDefinition` and whose body is `<id>_Work -> <id>_End`.
 */
export const eventHandler = (
  id: string,
  startId: string,
  eventDefinition: EventDefinition,
  isInterrupting?: false,
): SubProcess =>
  triggeredSub(id, [
    {
      kind: 'startEvent',
      id: startId,
      ...(isInterrupting === false ? { isInterrupting } : {}),
      eventDefinition,
    },
    { kind: 'userTask', id: `${id}_Work` },
    { kind: 'endEvent', id: `${id}_End` },
  ]);

interface EventSubProcessOptions {
  /** The event sub-process id. Defaults to `<prefix>Handler`. */
  id?: string;
  /** Written on the trigger start for a non-interrupting handler. */
  isInterrupting?: false;
}

/**
 * An event sub-process whose trigger start `<prefix>Start` carries
 * `eventDefinition` and flows to `<prefix>End` over `SF_<prefix>`.
 */
export const eventSubProcess = (
  prefix: string,
  eventDefinition: EventDefinition,
  { id = `${prefix}Handler`, isInterrupting }: EventSubProcessOptions = {},
): SubProcess => ({
  kind: 'subProcess',
  id,
  triggeredByEvent: true,
  flowElements: [
    {
      kind: 'startEvent',
      id: `${prefix}Start`,
      ...(isInterrupting === false ? { isInterrupting } : {}),
      eventDefinition,
    },
    { kind: 'endEvent', id: `${prefix}End` },
  ],
  sequenceFlows: [
    {
      id: `SF_${prefix}`,
      sourceRef: `${prefix}Start`,
      targetRef: `${prefix}End`,
    },
  ],
});

/**
 * The IR `xmlToIr` produces from `tests/golden/invoice-approval-handwritten.bpmn`,
 * with the handwritten ids preserved verbatim on import.
 *
 * The start event (ReviewStart) and end event (Done) have no `name` because the
 * handwritten BPMN gives them no `name` attribute, and the gateway has no
 * synthesized join: both branches converge directly on `Done`. The process
 * `name` is absent for the same reason: "Invoice Approval" is exactly
 * `humanize("invoice-approval")`, so import treats it as derivable and drops
 * it. Fixtures that need the name back spread it in:
 * `{ ...HANDWRITTEN_IMPORT_IR, name: 'Invoice Approval' }`.
 */
export const HANDWRITTEN_IMPORT_IR: BpmnProcess = {
  id: 'invoice-approval',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'ReviewStart' },
    {
      kind: 'userTask',
      id: 'ReviewInvoice',
      name: 'Review invoice',
      assignee: 'demo',
    },
    {
      kind: 'exclusiveGateway',
      id: 'AmountCheck',
      name: 'Amount > 1000?',
      defaultFlowId: 'AutoApprovePath',
    },
    {
      kind: 'userTask',
      id: 'SeniorApproval',
      name: 'Senior approval',
      assignee: 'manager',
    },
    {
      kind: 'serviceTask',
      id: 'AutoApprove',
      name: 'Auto-approve',
      binding: classBinding('com.example.invoice.AutoApproveDelegate'),
    },
    { kind: 'endEvent', id: 'Done' },
  ],
  sequenceFlows: [
    {
      id: 'Flow_ReviewStart_ReviewInvoice',
      sourceRef: 'ReviewStart',
      targetRef: 'ReviewInvoice',
    },
    {
      id: 'Flow_ReviewInvoice_AmountCheck',
      sourceRef: 'ReviewInvoice',
      targetRef: 'AmountCheck',
    },
    {
      id: 'Flow_SeniorBranch',
      sourceRef: 'AmountCheck',
      targetRef: 'SeniorApproval',
      conditionExpression: '${amount > 1000}',
    },
    {
      id: 'AutoApprovePath',
      sourceRef: 'AmountCheck',
      targetRef: 'AutoApprove',
    },
    {
      id: 'Flow_SeniorApproval_Done',
      sourceRef: 'SeniorApproval',
      targetRef: 'Done',
    },
    {
      id: 'Flow_AutoApprove_Done',
      sourceRef: 'AutoApprove',
      targetRef: 'Done',
    },
  ],
};
