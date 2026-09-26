import type { BuiltinTaskType } from '@bpmn-script/language';
import type {
  BoundaryEvent,
  BpmnProcess,
  CallActivity,
  CodeBinding,
  EventDefinition,
  ExclusiveGateway,
  FieldInjection,
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

export const linkDef = (linkName: string): Def<'link'> => ({
  kind: 'link',
  linkName,
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

type EventNodeKind =
  | 'startEvent'
  | 'endEvent'
  | 'intermediateThrowEvent'
  | 'intermediateCatchEvent';

type EventNodeOf<K extends EventNodeKind> = Extract<FlowElement, { kind: K }>;

// `isInterrupting: false` marks the trigger start of an `alongside` handler.
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

export const classBinding = (
  className: string,
): Extract<CodeBinding, { kind: 'class' }> => ({
  kind: 'class',
  className,
});

export const exprBinding = (expression: string): CodeBinding => ({
  kind: 'expression',
  expression,
});

export const delegateBinding = (
  expression: string,
): Extract<CodeBinding, { kind: 'delegateExpression' }> => ({
  kind: 'delegateExpression',
  expression,
});

export const externalBinding = (topic: string): ServiceTaskBinding => ({
  kind: 'external',
  topic,
});

/** The behaviour Operaton builds itself for `operaton:type="mail"`/`"shell"`. */
export const builtinBinding = (
  type: BuiltinTaskType,
  fields?: FieldInjection[],
): ServiceTaskBinding => ({
  kind: 'builtin',
  type,
  ...(fields === undefined ? {} : { fields }),
});

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

export const mapEntry = (key: string, value: IoValue): MapEntry => ({
  key,
  value,
});

export const ioParam = (name: string, value: IoValue): IoParameter => ({
  name,
  value,
});

export const serviceTask = (
  id: string,
  binding: ServiceTaskBinding,
): ServiceTask => ({ kind: 'serviceTask', id, binding });

export const scriptTask = (
  id: string,
  format: string,
  code: string,
): ScriptTask => ({ kind: 'scriptTask', id, format, code });

export const callActivity = (
  id: string,
  calledElement: string,
): CallActivity => ({ kind: 'callActivity', id, calledElement });

export const gateway = (
  id: string,
  defaultFlowId?: string,
): ExclusiveGateway => ({
  kind: 'exclusiveGateway',
  id,
  ...(defaultFlowId === undefined ? {} : { defaultFlowId }),
});

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

export const processIr = (
  id: string,
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[] = [],
): BpmnProcess => ({ id, isExecutable: true, flowElements, sequenceFlows });

export const minimalProcess = (
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[] = [],
): BpmnProcess => processIr('p', flowElements, sequenceFlows);

export const around = (el: FlowElement): BpmnProcess =>
  minimalProcess(
    [{ kind: 'startEvent', id: 'S' }, el, { kind: 'endEvent', id: 'E' }],
    [
      { id: 'F1', sourceRef: 'S', targetRef: el.id },
      { id: 'F2', sourceRef: el.id, targetRef: 'E' },
    ],
  );

export const flowChain = (...ids: string[]): SequenceFlow[] =>
  ids.slice(1).map((target, i) => ({
    id: `F${i + 1}`,
    sourceRef: ids[i]!,
    targetRef: target,
  }));

interface EdgeOptions {
  id?: string;
  condition?: string;
}

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
  // Appended without flows: an event sub-process is triggered, not flow-connected.
  unwired?: FlowElement[];
  prefix?: string;
}

export const chained = (
  elements: FlowElement[],
  { unwired = [], prefix = 'SF' }: ChainOptions = {},
): BpmnProcess => ({
  id: 'proc',
  isExecutable: true,
  flowElements: [...elements, ...unwired],
  sequenceFlows: chainFlows(elements, prefix),
});

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

export const triggeredSub = (
  id: string,
  elements: FlowElement[],
  options: ChainOptions = {},
): SubProcess => ({
  ...chainedSub(id, elements, options),
  triggeredByEvent: true,
});

// An `on ...` handler whose body is `<id>_Work -> <id>_End`.
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
  id?: string;
  isInterrupting?: false;
}

// `<prefix>Start -> <prefix>End` over `SF_<prefix>`.
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

// The IR xmlToIr produces from tests/golden/invoice-approval-handwritten.bpmn. The process name is absent
// because "Invoice Approval" equals humanize("invoice-approval"), which import drops as derivable.
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
