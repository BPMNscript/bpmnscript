/**
 * IR to BPMN 2.0 XML.
 *
 * Produces a document Operaton can parse and deploy. The `operaton:` namespace
 * is attached here through the local `operaton-moddle.json` extension; the IR
 * itself stays vendor-neutral (ADR 0006).
 *
 * Three steps are more than a mapping: `<bpmn:incoming>`/`<bpmn:outgoing>` are
 * computed per flow node, a `bpmndi:BPMNShape isExpanded` hint is authored per
 * sub-process (ADR 0015), and `bpmn-auto-layout` injects the `bpmndi:` data
 * that ADR 0003 regenerates on every export.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join } from 'node:path';

import {
  BpmnModdle,
  type BpmnModdleInstance,
  type ModdleElement,
} from 'bpmn-moddle';
// Pinned to 1.x: 0.3.x pulls `bpmn-moddle@^8`, which collides with the
// `bpmn-moddle@^10` this package locks, and exposes a constructor API instead.
import { layoutProcess } from 'bpmn-auto-layout';

import { humanize } from './humanize.js';
import { resolveCollision } from './synthesize-ids.js';
import type {
  BpmnProcess,
  CallActivity,
  CallVariableMapping,
  EventDefinition,
  ExecutionListener,
  FlowContainer,
  FlowElement,
  FormField,
  FormFieldType,
  IoParameter,
  IoValue,
  ListenerBinding,
  ScriptValue,
  SequenceFlow,
  TaskListener,
} from './ir/types.js';

/** Opaque to Operaton; it never has to resolve. */
const TARGET_NAMESPACE = 'http://bpmnscript.io/processes';

/**
 * `operaton:historyTimeToLive` on every process, not parameterised at the IR
 * level. Exported so the importer can pass a document carrying exactly this
 * value without a warning: re-export reproduces it.
 */
export const HISTORY_TIME_TO_LIVE = 'P30D';

/**
 * Read rather than imported with `with { type: 'json' }`, which would need
 * `resolveJsonModule` under TypeScript's `NodeNext` resolution.
 */
const operatonModdleExtension: unknown = JSON.parse(
  readFileSync(resolveOperatonModdlePath(), 'utf-8'),
);

/** Falls back to `src/` for an `out/` build that did not copy the file across. */
function resolveOperatonModdlePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, 'operaton-moddle.json'),
    join(moduleDir, '..', 'src', 'operaton-moddle.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not locate operaton-moddle.json. Looked in: ${candidates.join(', ')}`,
  );
}

/**
 * Both directions of the XML boundary build their moddle here, which is what
 * keeps the read and write paths symmetric.
 *
 * `camunda:` stays unregistered on purpose. `camunda-bpmn-moddle` defines the
 * same property names (`class`, `assignee`, `formKey`, `historyTimeToLive`) on
 * the same BPMN types as the Operaton fork, and moddle then refuses both with
 * `property <...> already defined; ... not allowed without redefines`. Reading
 * `camunda:*` needs no extension anyway: moddle falls through to `$attrs`.
 */
export function createModdle(): BpmnModdleInstance {
  return new BpmnModdle({
    operaton: operatonModdleExtension as Record<string, unknown>,
  });
}

export interface IrToXmlOptions {
  sourceFileName?: string;
  exporterVersion?: string;
}

export async function irToXml(
  process: BpmnProcess,
  options?: IrToXmlOptions,
): Promise<string> {
  const moddle = createModdle();

  // Before the process, so each catch and throw can wire its ref to the shared
  // root element as its own moddle element is created.
  const roots = synthesizeRootElements(moddle, process);

  const processAttrs: Record<string, unknown> = {
    id: process.id,
    name: process.name ?? humanize(process.id),
    isExecutable: process.isExecutable,
    'operaton:historyTimeToLive': HISTORY_TIME_TO_LIVE,
    ...(process.versionTag !== undefined
      ? { 'operaton:versionTag': process.versionTag }
      : {}),
    flowElements: buildContainerChildren(moddle, process, roots),
  };
  const processElement = moddle.create('bpmn:Process', processAttrs);

  const stem = options?.sourceFileName
    ? basename(options.sourceFileName, extname(options.sourceFileName))
    : process.id;
  const diagrams = buildSubProcessExpansionHint(moddle, processElement);
  const definitions = moddle.create('bpmn:Definitions', {
    id: `Definitions_${stem}`,
    targetNamespace: TARGET_NAMESPACE,
    exporter: 'BPMNscript',
    exporterVersion: options?.exporterVersion ?? '0.0.0',
    rootElements: [
      processElement,
      ...roots.errorByCode.values(),
      ...roots.escalationByCode.values(),
      ...roots.messageByName.values(),
      ...roots.signalByName.values(),
    ],
    ...(diagrams.length > 0 ? { diagrams } : {}),
  });

  // `format: true` is a debugging aid only: auto-layout re-serializes below
  // with its own formatting.
  const { xml } = await moddle.toXML(definitions, { format: true });

  const xmlWithDi = await layoutProcess(xml);

  return xmlWithDi;
}

/**
 * BPMN puts these at `bpmn:Definitions` level, deduped by code or name, so one
 * identity maps to one element. Map order is emission order.
 */
interface RootElementIndex {
  errorByCode: Map<string, ModdleElement>;
  escalationByCode: Map<string, ModdleElement>;
  messageByName: Map<string, ModdleElement>;
  signalByName: Map<string, ModdleElement>;
}

/**
 * Derive the `bpmn:Error`/`bpmn:Escalation`/`bpmn:Message`/`bpmn:Signal` roots
 * from usage: the IR carries codes and names inline and models no roots.
 * Distinct identities come out in first-appearance order, then any
 * `errorMessages` code not yet seen, so a declared code emits its root even
 * when unused. A catch-all (no code) contributes none.
 */
function synthesizeRootElements(
  moddle: BpmnModdleInstance,
  process: BpmnProcess,
): RootElementIndex {
  const errorCodes = new Set<string>();
  const escalationCodes = new Set<string>();
  const messageNames = new Set<string>();
  const signalNames = new Set<string>();
  for (const def of collectEventDefinitions(process)) {
    switch (def.kind) {
      case 'error':
        if (def.errorCode !== undefined) errorCodes.add(def.errorCode);
        break;
      case 'escalation':
        if (def.escalationCode !== undefined) {
          escalationCodes.add(def.escalationCode);
        }
        break;
      case 'message':
        messageNames.add(def.messageName);
        break;
      case 'signal':
        signalNames.add(def.signalName);
        break;
      // Compensation, timer, and conditional need no document-level element.
      case 'compensation':
        break;
      default:
        break;
    }
  }
  const messageByCode = new Map(
    (process.errorMessages ?? []).map((m) => [m.code, m.message]),
  );
  for (const code of messageByCode.keys()) errorCodes.add(code);

  // Seeded with every id already in the document so a root id shadows nothing.
  const taken = new Set<string>();
  collectElementIds(process, taken);

  const errorByCode = new Map<string, ModdleElement>();
  for (const code of errorCodes) {
    const id = resolveCollision(sanitizeRootId('Error_', code), taken);
    taken.add(id);
    const attrs: Record<string, unknown> = { id, name: code, errorCode: code };
    const message = messageByCode.get(code);
    if (message !== undefined) attrs['operaton:errorMessage'] = message;
    errorByCode.set(code, moddle.create('bpmn:Error', attrs));
  }

  const escalationByCode = new Map<string, ModdleElement>();
  for (const code of escalationCodes) {
    const id = resolveCollision(sanitizeRootId('Escalation_', code), taken);
    taken.add(id);
    escalationByCode.set(
      code,
      moddle.create('bpmn:Escalation', {
        id,
        name: code,
        escalationCode: code,
      }),
    );
  }

  // `taken` is threaded, so this order decides who wins an id collision.
  const messageByName = synthesizeNamedRoots(
    moddle,
    'bpmn:Message',
    'Message_',
    messageNames,
    taken,
  );
  const signalByName = synthesizeNamedRoots(
    moddle,
    'bpmn:Signal',
    'Signal_',
    signalNames,
    taken,
  );

  return { errorByCode, escalationByCode, messageByName, signalByName };
}

/** The name is the engine-side identity, so every use of it shares one root. */
function synthesizeNamedRoots(
  moddle: BpmnModdleInstance,
  type: 'bpmn:Message' | 'bpmn:Signal',
  prefix: string,
  names: Iterable<string>,
  taken: Set<string>,
): Map<string, ModdleElement> {
  const byName = new Map<string, ModdleElement>();
  for (const name of names) {
    const id = resolveCollision(sanitizeRootId(prefix, name), taken);
    taken.add(id);
    byName.set(name, moddle.create(type, { id, name }));
  }
  return byName;
}

/** Non-id characters become `_`, since the result is an XML ID. */
function sanitizeRootId(prefix: string, code: string): string {
  return prefix + code.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Depth-first, in first-appearance order. Every position contributes equally,
 * so a message caught by an `await` and one caught by a handler share a root.
 */
function collectEventDefinitions(container: FlowContainer): EventDefinition[] {
  const defs: EventDefinition[] = [];
  for (const el of container.flowElements) {
    switch (el.kind) {
      case 'startEvent':
      case 'endEvent':
        if (el.eventDefinition !== undefined) defs.push(el.eventDefinition);
        break;
      case 'intermediateThrowEvent':
      case 'intermediateCatchEvent':
      case 'boundaryEvent':
        defs.push(el.eventDefinition);
        break;
      case 'subProcess':
        defs.push(...collectEventDefinitions(el));
        break;
      default:
        break;
    }
  }
  return defs;
}

function collectElementIds(container: FlowContainer, into: Set<string>): void {
  into.add(container.id);
  for (const el of container.flowElements) {
    into.add(el.id);
    if (el.kind === 'subProcess') collectElementIds(el, into);
  }
  for (const flow of container.sequenceFlows) into.add(flow.id);
}

/** No code means no `errorRef`/`escalationRef`: a ref-less definition catches any. */
function buildEventDefinition(
  moddle: BpmnModdleInstance,
  def: EventDefinition,
  roots: RootElementIndex,
): ModdleElement {
  switch (def.kind) {
    case 'error': {
      const attrs: Record<string, unknown> = {};
      if (def.errorCode !== undefined) {
        attrs.errorRef = roots.errorByCode.get(def.errorCode);
      }
      if (def.codeVariable !== undefined) {
        attrs['operaton:errorCodeVariable'] = def.codeVariable;
      }
      if (def.messageVariable !== undefined) {
        attrs['operaton:errorMessageVariable'] = def.messageVariable;
      }
      return moddle.create('bpmn:ErrorEventDefinition', attrs);
    }
    case 'escalation': {
      const attrs: Record<string, unknown> = {};
      if (def.escalationCode !== undefined) {
        attrs.escalationRef = roots.escalationByCode.get(def.escalationCode);
      }
      if (def.codeVariable !== undefined) {
        attrs['operaton:escalationCodeVariable'] = def.codeVariable;
      }
      return moddle.create('bpmn:EscalationEventDefinition', attrs);
    }
    case 'message':
      return moddle.create('bpmn:MessageEventDefinition', {
        messageRef: roots.messageByName.get(def.messageName),
      });
    case 'signal':
      return moddle.create('bpmn:SignalEventDefinition', {
        signalRef: roots.signalByName.get(def.signalName),
      });
    case 'compensation':
      // Compensation carries no code and no ref, so the bare element is all.
      return moddle.create('bpmn:CompensateEventDefinition', {});
    case 'timer': {
      const expression = moddle.create('bpmn:FormalExpression', {
        body: def.expression,
      });
      return moddle.create('bpmn:TimerEventDefinition', {
        [TIMER_KIND_TO_CHILD[def.timerKind]]: expression,
      });
    }
    case 'conditional':
      return moddle.create('bpmn:ConditionalEventDefinition', {
        condition: moddle.create('bpmn:FormalExpression', {
          body: def.condition,
        }),
      });
    default: {
      const exhaustive: never = def;
      throw new Error(
        `Unhandled EventDefinition kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Nothing at all when there is no definition, which is a plain start or end. */
function eventDefinitionAttrs(
  moddle: BpmnModdleInstance,
  def: EventDefinition | undefined,
  roots: RootElementIndex,
): Record<string, unknown> {
  return def === undefined
    ? {}
    : { eventDefinitions: [buildEventDefinition(moddle, def, roots)] };
}

const TIMER_KIND_TO_CHILD: Record<
  Extract<EventDefinition, { kind: 'timer' }>['timerKind'],
  'timeDuration' | 'timeDate' | 'timeCycle'
> = {
  duration: 'timeDuration',
  date: 'timeDate',
  cycle: 'timeCycle',
};

/**
 * Fed DI-less XML with a `bpmn:SubProcess`, `bpmn-auto-layout` draws a
 * collapsed parent and scatters the nested children across the root plane at
 * coordinates that duplicate unrelated top-level elements. It reads
 * `isExpanded` off a pre-existing `bpmndi:BPMNShape` and propagates it before
 * laying out, recomputing any bounds given here, and finds that shape through
 * an id-keyed index, so each shape needs an `id` nothing references back.
 * See ADR 0015.
 */
function buildSubProcessExpansionHint(
  moddle: BpmnModdleInstance,
  processElement: ModdleElement,
): ModdleElement[] {
  const subProcessElements = collectSubProcessElements(processElement);
  if (subProcessElements.length === 0) {
    return [];
  }

  const shapes = subProcessElements.map((subProcessElement) =>
    moddle.create('bpmndi:BPMNShape', {
      id: `${subProcessElement.id}_di`,
      bpmnElement: subProcessElement,
      isExpanded: true,
    }),
  );
  const plane = moddle.create('bpmndi:BPMNPlane', {
    id: `BPMNPlane_${processElement.id}`,
    bpmnElement: processElement,
    planeElement: shapes,
  });
  return [
    moddle.create('bpmndi:BPMNDiagram', {
      id: `BPMNDiagram_${processElement.id}`,
      plane,
    }),
  ];
}

function collectSubProcessElements(container: ModdleElement): ModdleElement[] {
  const result: ModdleElement[] = [];
  for (const element of container.flowElements ?? []) {
    if (element.$type === 'bpmn:SubProcess') {
      result.push(element);
      result.push(...collectSubProcessElements(element));
    }
  }
  return result;
}

/**
 * Pass 1 creates a moddle element per flow node and sequence flow, keyed by id.
 * The three attach passes need moddle objects where the IR carries raw ids, so
 * they cannot run until pass 1 has built every node in this container.
 *
 * A nested sub-process re-enters here through {@link createFlowNode} and gets
 * its own maps.
 */
function buildContainerChildren(
  moddle: BpmnModdleInstance,
  container: FlowContainer,
  roots: RootElementIndex,
): ModdleElement[] {
  const flowNodeById = new Map<string, ModdleElement>();
  const sequenceFlowById = new Map<string, ModdleElement>();

  for (const node of container.flowElements) {
    flowNodeById.set(node.id, createFlowNode(moddle, node, roots));
  }

  for (const flow of container.sequenceFlows) {
    sequenceFlowById.set(
      flow.id,
      createSequenceFlow(moddle, flow, flowNodeById),
    );
  }

  attachIncomingOutgoing(container, flowNodeById, sequenceFlowById);
  attachGatewayDefaults(container, flowNodeById, sequenceFlowById);
  attachBoundaryHosts(container, flowNodeById);

  return [
    ...container.flowElements.map((n) => requireById(flowNodeById, n.id)),
    ...container.sequenceFlows.map((f) => requireById(sequenceFlowById, f.id)),
  ];
}

/** Operaton attributes use the qualified names `operaton-moddle.json` declares. */
function createFlowNode(
  moddle: BpmnModdleInstance,
  node: FlowElement,
  roots: RootElementIndex,
): ModdleElement {
  const name = flowNodeName(node);
  const baseAttrs: Record<string, unknown> = {
    id: node.id,
    ...(name === undefined ? {} : { name }),
    ...engineSettingAttrs(moddle, node, roots),
  };

  switch (node.kind) {
    case 'startEvent': {
      const attrs: Record<string, unknown> = {
        ...baseAttrs,
        ...eventDefinitionAttrs(moddle, node.eventDefinition, roots),
      };
      // BPMN defaults to interrupting, and the serializer drops a default.
      if (node.isInterrupting === false) {
        attrs.isInterrupting = false;
      }
      return moddle.create('bpmn:StartEvent', attrs);
    }

    case 'endEvent':
      return moddle.create('bpmn:EndEvent', {
        ...baseAttrs,
        ...eventDefinitionAttrs(moddle, node.eventDefinition, roots),
      });

    case 'intermediateThrowEvent':
      return moddle.create('bpmn:IntermediateThrowEvent', {
        ...baseAttrs,
        ...eventDefinitionAttrs(moddle, node.eventDefinition, roots),
      });

    case 'intermediateCatchEvent':
      return moddle.create('bpmn:IntermediateCatchEvent', {
        ...baseAttrs,
        ...eventDefinitionAttrs(moddle, node.eventDefinition, roots),
      });

    case 'boundaryEvent': {
      // `attachedToRef` is wired later, by `attachBoundaryHosts`.
      const attrs: Record<string, unknown> = {
        ...baseAttrs,
        ...eventDefinitionAttrs(moddle, node.eventDefinition, roots),
      };
      // BPMN defaults to interrupting, and the serializer drops a default.
      if (node.cancelActivity === false) {
        attrs.cancelActivity = false;
      }
      return moddle.create('bpmn:BoundaryEvent', attrs);
    }

    case 'userTask': {
      const attrs: Record<string, unknown> = { ...baseAttrs };
      for (const key of USER_TASK_ATTRIBUTES) {
        const value = node[key];
        if (value !== undefined) attrs[`operaton:${key}`] = value;
      }
      return moddle.create('bpmn:UserTask', attrs);
    }

    case 'serviceTask': {
      const attrs: Record<string, unknown> = { ...baseAttrs };
      switch (node.binding.kind) {
        case 'class':
          attrs['operaton:class'] = node.binding.className;
          break;
        case 'expression':
          attrs['operaton:expression'] = node.binding.expression;
          break;
        case 'delegateExpression':
          attrs['operaton:delegateExpression'] = node.binding.expression;
          break;
        case 'external':
          attrs['operaton:type'] = 'external';
          attrs['operaton:topic'] = node.binding.topic;
          break;
        default: {
          const exhaustive: never = node.binding;
          throw new Error(
            `Unhandled ServiceTaskBinding kind: ${JSON.stringify(exhaustive)}`,
          );
        }
      }
      if (node.resultVariable !== undefined) {
        attrs['operaton:resultVariable'] = node.resultVariable;
      }
      return moddle.create('bpmn:ServiceTask', attrs);
    }

    case 'scriptTask': {
      const attrs: Record<string, unknown> = {
        ...baseAttrs,
        scriptFormat: node.format,
        script: node.code,
      };
      if (node.resultVariable !== undefined) {
        attrs['operaton:resultVariable'] = node.resultVariable;
      }
      return moddle.create('bpmn:ScriptTask', attrs);
    }

    case 'exclusiveGateway':
      // `default` is wired later, by `attachGatewayDefaults`.
      return moddle.create('bpmn:ExclusiveGateway', baseAttrs);

    case 'parallelGateway':
      return moddle.create('bpmn:ParallelGateway', baseAttrs);

    case 'subProcess': {
      const attrs: Record<string, unknown> = {
        ...baseAttrs,
        flowElements: buildContainerChildren(moddle, node, roots),
      };
      if (node.triggeredByEvent === true) {
        attrs.triggeredByEvent = true;
      }
      return moddle.create('bpmn:SubProcess', attrs);
    }

    case 'callActivity': {
      const attrs: Record<string, unknown> = {
        ...baseAttrs,
        calledElement: node.calledElement,
      };
      if (node.binding !== undefined) {
        attrs['operaton:calledElementBinding'] = node.binding.kind;
        if (node.binding.kind === 'version') {
          attrs['operaton:calledElementVersion'] = node.binding.version;
        }
      }
      // The business key and the mappings are extension children, already
      // placed by `buildExtensionElements`.
      return moddle.create('bpmn:CallActivity', attrs);
    }

    default: {
      const exhaustive: never = node;
      throw new Error(
        `Unhandled FlowElement kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Derived from the id where the IR carries no name. A synthesized id
 * (`Gateway_..._split`, `StartEvent_<processId>`) would humanize to noise, so
 * the kinds that carry one derive nothing, and the surfaces with no label slot
 * (`emit`, `await`, `on`) get no name at all.
 */
function flowNodeName(node: FlowElement): string | undefined {
  switch (node.kind) {
    case 'intermediateThrowEvent':
    case 'intermediateCatchEvent':
    case 'boundaryEvent':
      return undefined;
    case 'exclusiveGateway':
    case 'parallelGateway':
    case 'startEvent':
    case 'endEvent':
      return node.name;
    case 'subProcess':
      return node.triggeredByEvent === true
        ? node.name
        : (node.name ?? humanize(node.id));
    default:
      return node.name ?? humanize(node.id);
  }
}

/** Nothing for the two gateways, which carry no engine settings. */
function engineSettingAttrs(
  moddle: BpmnModdleInstance,
  node: FlowElement,
  roots: RootElementIndex,
): Record<string, unknown> {
  if (node.kind === 'exclusiveGateway' || node.kind === 'parallelGateway') {
    return {};
  }
  const attrs: Record<string, unknown> = {};
  if (node.asyncBefore === true) attrs['operaton:asyncBefore'] = true;
  if (node.asyncAfter === true) attrs['operaton:asyncAfter'] = true;
  if (node.exclusive === false) attrs['operaton:exclusive'] = false;
  if (node.jobPriority !== undefined) {
    attrs['operaton:jobPriority'] = node.jobPriority;
  }
  const extensionElements = buildExtensionElements(moddle, node, roots);
  if (extensionElements !== undefined) {
    attrs.extensionElements = extensionElements;
  }
  return attrs;
}

/** IR fields whose `operaton:` attribute has the same name and takes the value verbatim. */
const USER_TASK_ATTRIBUTES = [
  'assignee',
  'formKey',
  'candidateUsers',
  'candidateGroups',
  'dueDate',
  'followUpDate',
  'priority',
] as const;

type EngineNode = Exclude<
  FlowElement,
  { kind: 'exclusiveGateway' | 'parallelGateway' }
>;

/**
 * One assembler for every group, so a node carrying two of them (a form and a
 * retry cycle, say) cannot have the first overwritten by the second. The order
 * below is fixed to keep the output byte-stable. `undefined` when the node
 * contributes nothing, so no empty wrapper is written.
 */
function buildExtensionElements(
  moddle: BpmnModdleInstance,
  node: EngineNode,
  roots: RootElementIndex,
): ModdleElement | undefined {
  const values: ModdleElement[] = [];
  const inputOutput = buildInputOutput(moddle, node);
  if (inputOutput !== undefined) {
    values.push(inputOutput);
  }
  if ('formFields' in node && node.formFields !== undefined) {
    values.push(buildFormData(moddle, node.formFields));
  }
  if (node.kind === 'callActivity') {
    values.push(...buildCallExtensionValues(moddle, node));
  }
  for (const listener of node.executionListeners ?? []) {
    values.push(
      buildListener(moddle, 'operaton:ExecutionListener', listener, roots),
    );
  }
  if (node.kind === 'userTask') {
    for (const listener of node.taskListeners ?? []) {
      values.push(
        buildListener(moddle, 'operaton:TaskListener', listener, roots),
      );
    }
  }
  if (node.retryCycle !== undefined) {
    values.push(
      moddle.create('operaton:FailedJobRetryTimeCycle', {
        body: node.retryCycle,
      }),
    );
  }
  return values.length > 0
    ? moddle.create('bpmn:ExtensionElements', { values })
    : undefined;
}

/**
 * An absent direction is not an empty one: an empty array still writes an empty
 * list and the block around it. Only both directions absent drops the block.
 */
function buildInputOutput(
  moddle: BpmnModdleInstance,
  node: EngineNode,
): ModdleElement | undefined {
  const inputs = 'inputParameters' in node ? node.inputParameters : undefined;
  const outputs =
    'outputParameters' in node ? node.outputParameters : undefined;
  if (inputs === undefined && outputs === undefined) {
    return undefined;
  }
  const attrs: Record<string, unknown> = {};
  if (inputs !== undefined) {
    attrs.inputParameters = inputs.map((parameter) =>
      buildIoParameter(moddle, 'operaton:InputParameter', parameter),
    );
  }
  if (outputs !== undefined) {
    attrs.outputParameters = outputs.map((parameter) =>
      buildIoParameter(moddle, 'operaton:OutputParameter', parameter),
    );
  }
  return moddle.create('operaton:InputOutput', attrs);
}

function buildIoParameter(
  moddle: BpmnModdleInstance,
  type: 'operaton:InputParameter' | 'operaton:OutputParameter',
  parameter: IoParameter,
): ModdleElement {
  return moddle.create(type, {
    name: parameter.name,
    ...ioValueAttrs(moddle, parameter.value),
  });
}

/**
 * Text goes in the body, every other form becomes the single `definitions`
 * entry. Exactly one of the two, so a carrier never holds both.
 */
function ioValueAttrs(
  moddle: BpmnModdleInstance,
  value: IoValue,
): Record<string, unknown> {
  return value.kind === 'text'
    ? { value: value.text }
    : { definitions: [buildIoValueElement(moddle, value)] };
}

/** Standalone: text becomes the `operaton:value` a list item is written as. */
function buildIoValueElement(
  moddle: BpmnModdleInstance,
  value: IoValue,
): ModdleElement {
  switch (value.kind) {
    case 'text':
      return moddle.create('operaton:Value', { value: value.text });
    case 'script':
      return buildScript(moddle, value);
    case 'list':
      return moddle.create('operaton:List', {
        items: value.items.map((item) => buildIoValueElement(moddle, item)),
      });
    case 'map':
      return moddle.create('operaton:Map', {
        entries: value.entries.map((entry) =>
          moddle.create('operaton:Entry', {
            key: entry.key,
            ...ioValueAttrs(moddle, entry.value),
          }),
        ),
      });
    default: {
      const exhaustive: never = value;
      throw new Error(`Unhandled IoValue kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A `timeout` task listener adds the `bpmn:timerEventDefinition` child. */
function buildListener(
  moddle: BpmnModdleInstance,
  type: 'operaton:ExecutionListener' | 'operaton:TaskListener',
  listener: ExecutionListener | TaskListener,
  roots: RootElementIndex,
): ModdleElement {
  const attrs: Record<string, unknown> = {
    event: listener.event,
    ...listenerBindingAttrs(moddle, listener.binding),
  };
  if ('timer' in listener && listener.timer !== undefined) {
    attrs.eventDefinitions = [
      buildEventDefinition(moddle, listener.timer, roots),
    ];
  }
  return moddle.create(type, attrs);
}

/**
 * The three reference forms are unprefixed attributes: the listener element is
 * already `operaton:`-qualified, unlike the same three names on a
 * `bpmn:serviceTask`. An inline script becomes an `operaton:script` child.
 */
function listenerBindingAttrs(
  moddle: BpmnModdleInstance,
  binding: ListenerBinding,
): Record<string, unknown> {
  switch (binding.kind) {
    case 'class':
      return { class: binding.className };
    case 'expression':
      return { expression: binding.expression };
    case 'delegateExpression':
      return { delegateExpression: binding.expression };
    case 'script':
      return { script: buildScript(moddle, binding) };
    default: {
      const exhaustive: never = binding;
      throw new Error(
        `Unhandled ListenerBinding kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function buildScript(
  moddle: BpmnModdleInstance,
  value: ScriptValue,
): ModdleElement {
  return moddle.create('operaton:Script', {
    scriptFormat: value.format,
    value: value.code,
  });
}

/** `number` becomes `long`, so the IR spelling can stay vendor-neutral (ADR 0006). */
const FORM_FIELD_TYPE_TO_OPERATON: Record<FormFieldType, string> = {
  string: 'string',
  number: 'long',
  boolean: 'boolean',
  date: 'date',
};

function buildFormData(
  moddle: BpmnModdleInstance,
  formFields: FormField[],
): ModdleElement {
  const fields = formFields.map((field) =>
    moddle.create('operaton:FormField', {
      id: field.id,
      type: FORM_FIELD_TYPE_TO_OPERATON[field.type],
      ...(field.label !== undefined ? { label: field.label } : {}),
      ...(field.defaultValue !== undefined
        ? { defaultValue: field.defaultValue }
        : {}),
    }),
  );
  return moddle.create('operaton:FormData', { fields });
}

/** Canonical order: the business key, then the in-mappings, then the out-mappings. */
function buildCallExtensionValues(
  moddle: BpmnModdleInstance,
  node: CallActivity,
): ModdleElement[] {
  const values: ModdleElement[] = [];
  if (node.businessKey !== undefined) {
    values.push(
      moddle.create('operaton:In', { businessKey: node.businessKey }),
    );
  }
  for (const mapping of node.inMappings ?? []) {
    values.push(moddle.create('operaton:In', callMappingAttrs(mapping)));
  }
  for (const mapping of node.outMappings ?? []) {
    values.push(moddle.create('operaton:Out', callMappingAttrs(mapping)));
  }
  return values;
}

function callMappingAttrs(
  mapping: CallVariableMapping,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  switch (mapping.kind) {
    case 'all':
      attrs.variables = 'all';
      break;
    case 'variable':
      attrs.source = mapping.source;
      attrs.target = mapping.target;
      break;
    case 'expression':
      attrs.sourceExpression = mapping.sourceExpression;
      attrs.target = mapping.target;
      break;
    default: {
      const exhaustive: never = mapping;
      throw new Error(
        `Unhandled CallVariableMapping kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
  if (mapping.local === true) {
    attrs.local = true;
  }
  return attrs;
}

/** `${amount > 1000}` -> `amount > 1000`. Anything undelimited passes through. */
function conditionLabel(conditionExpression: string): string {
  return conditionExpression.replace(/^\$\{([\s\S]*)\}$/, '$1');
}

/**
 * The condition body is passed through verbatim: bpmn-moddle's writer does the
 * XML escaping itself, turning `>` into `&gt;`.
 */
function createSequenceFlow(
  moddle: BpmnModdleInstance,
  flow: SequenceFlow,
  flowNodeById: Map<string, ModdleElement>,
): ModdleElement {
  const attrs: Record<string, unknown> = {
    id: flow.id,
    sourceRef: requireById(flowNodeById, flow.sourceRef),
    targetRef: requireById(flowNodeById, flow.targetRef),
  };
  if (flow.conditionExpression !== undefined) {
    // Viewers render a flow's `name`, not its `conditionExpression`, so the
    // condition is copied there to make the routing readable on the canvas.
    attrs.name = conditionLabel(flow.conditionExpression);
    attrs.conditionExpression = moddle.create('bpmn:FormalExpression', {
      body: flow.conditionExpression,
    });
  }
  return moddle.create('bpmn:SequenceFlow', attrs);
}

/**
 * MIWG requires these children and bpmn-moddle does not derive them. Built in
 * `sequenceFlows` order, so the output is deterministic.
 */
function attachIncomingOutgoing(
  container: FlowContainer,
  flowNodeById: Map<string, ModdleElement>,
  sequenceFlowById: Map<string, ModdleElement>,
): void {
  for (const node of flowNodeById.values()) {
    node.incoming = [];
    node.outgoing = [];
  }

  for (const flow of container.sequenceFlows) {
    const flowModdle = requireById(sequenceFlowById, flow.id);
    const source = flowNodeById.get(flow.sourceRef);
    const target = flowNodeById.get(flow.targetRef);
    if (source === undefined) {
      throw new Error(
        `SequenceFlow "${flow.id}" references unknown sourceRef "${flow.sourceRef}".`,
      );
    }
    if (target === undefined) {
      throw new Error(
        `SequenceFlow "${flow.id}" references unknown targetRef "${flow.targetRef}".`,
      );
    }
    source.outgoing.push(flowModdle);
    target.incoming.push(flowModdle);
  }
}

/** `bpmn:default` holds a moddle-element reference, not the raw id. */
function attachGatewayDefaults(
  container: FlowContainer,
  flowNodeById: Map<string, ModdleElement>,
  sequenceFlowById: Map<string, ModdleElement>,
): void {
  for (const node of container.flowElements) {
    if (node.kind !== 'exclusiveGateway') continue;
    if (node.defaultFlowId === undefined) continue;
    const gateway = requireById(flowNodeById, node.id);
    const defaultFlow = sequenceFlowById.get(node.defaultFlowId);
    if (defaultFlow === undefined) {
      throw new Error(
        `ExclusiveGateway "${node.id}" declares default flow "${node.defaultFlowId}" that does not exist.`,
      );
    }
    gateway.default = defaultFlow;
  }
}

/**
 * `attachedToRef` holds a moddle-element reference, not the raw id. An
 * unresolvable host is an internal bug, since the desugarer only ever emits a
 * boundary event alongside its host, so it throws.
 */
function attachBoundaryHosts(
  container: FlowContainer,
  flowNodeById: Map<string, ModdleElement>,
): void {
  for (const node of container.flowElements) {
    if (node.kind !== 'boundaryEvent') continue;
    const boundaryElement = requireById(flowNodeById, node.id);
    const host = flowNodeById.get(node.attachedToRef);
    if (host === undefined) {
      throw new Error(
        `BoundaryEvent "${node.id}" is attached to "${node.attachedToRef}", which is not a flow element of this container.`,
      );
    }
    boundaryElement.attachedToRef = host;
  }
}

/** Every caller's invariants guarantee presence, so an absence is a bug. */
function requireById<T>(map: Map<string, T>, id: string): T {
  const value = map.get(id);
  if (value === undefined) {
    throw new Error(
      `Internal error: no moddle element registered for id "${id}".`,
    );
  }
  return value;
}
