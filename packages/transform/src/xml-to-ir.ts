/**
 * BPMN 2.0 XML to IR, the inverse of `irToXml`. Diagram interchange is dropped
 * (ADR 0003: the IR holds semantics only). Content the IR cannot express throws
 * an `UnsupportedConstructError` subclass before any IR exists; content it does
 * not carry comes back in `warnings`. See ADR 0014, Honest BPMN Import.
 *
 * `camunda:` is an accepted alias for `operaton:` on extension attributes,
 * `operaton:` winning when both are set. Extension elements get no alias.
 */

import type {
  BoundaryEvent,
  BpmnProcess,
  CalledElementBinding,
  CallActivity,
  CallVariableMapping,
  EndEvent,
  EngineAttributes,
  EventDefinition,
  ExclusiveGateway,
  ExecutionListener,
  FlowElement,
  FormField,
  FormFieldType,
  IntermediateCatchEvent,
  IntermediateThrowEvent,
  IoMapped,
  IoParameter,
  IoValue,
  ListenerBinding,
  ParallelGateway,
  ScriptTask,
  ScriptValue,
  SequenceFlow,
  ServiceTask,
  ServiceTaskBinding,
  StartEvent,
  SubProcess,
  TaskListener,
  UserTask,
} from './ir/types.js';
import { engineAttributes, ioMapped } from './ir/types.js';

import {
  UnsupportedCallActivityError,
  UnsupportedCollaborationError,
  UnsupportedElementError,
  UnsupportedEventDefinitionError,
  UnsupportedEventFeatureError,
  UnsupportedExtensionFormError,
  UnsupportedFormFieldTypeError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedServiceTaskFormError,
} from './errors.js';
import { humanize } from './humanize.js';
import { createModdle, HISTORY_TIME_TO_LIVE } from './ir-to-xml.js';

export type ImportWarningCategory =
  | 'extensionAttribute'
  | 'lane'
  | 'label'
  | 'unreferencedRoot'
  | 'documentation'
  | 'unmappedConstruct';

/** A non-fatal notice that `xmlToIr` dropped content. Refusals throw instead. */
export interface ImportWarning {
  elementId: string;
  category: ImportWarningCategory;
  message: string;
}

/**
 * Element `$type`s whose IR node carries the flat engine settings. Gateways are
 * absent on purpose: they are synthesized from `if`/`while`/`parallel` and have
 * no textual identity to hang a setting on, so a setting found on one is a drop.
 */
const ENGINE_ATTRIBUTE_OWNERS = [
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:IntermediateThrowEvent',
  'bpmn:IntermediateCatchEvent',
  'bpmn:BoundaryEvent',
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ScriptTask',
  'bpmn:SubProcess',
  'bpmn:CallActivity',
] as const;

const IO_MAPPED_OWNERS = [
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ScriptTask',
  'bpmn:SubProcess',
  'bpmn:CallActivity',
] as const;

function consumptionTable(
  entries: readonly (readonly [string, readonly string[]])[],
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(entries.map(([name, owners]) => [name, new Set(owners)]));
}

/**
 * Extension-attribute local names read into the IR, per owning `$type`. Matched
 * on the local part, so the `operaton:`/`camunda:` prefix does not matter.
 * Keying by owner is what keeps the sweep honest: `assignee` is real data on a
 * user task and unread decoration on a service task.
 *
 * The three `*Variable` names sit on an event definition, shared by the catch
 * and the throw side, and the engine honours them on the catch side only, so
 * {@link warnThrowSideBindingAttrs} reports the throw-side drop.
 */
const CONSUMED_EXTENSION_ATTRS = consumptionTable([
  ['asyncBefore', ENGINE_ATTRIBUTE_OWNERS],
  ['asyncAfter', ENGINE_ATTRIBUTE_OWNERS],
  ['exclusive', ENGINE_ATTRIBUTE_OWNERS],
  ['jobPriority', ENGINE_ATTRIBUTE_OWNERS],
  ['assignee', ['bpmn:UserTask']],
  ['formKey', ['bpmn:UserTask']],
  ['candidateGroups', ['bpmn:UserTask']],
  ['candidateUsers', ['bpmn:UserTask']],
  ['dueDate', ['bpmn:UserTask']],
  ['followUpDate', ['bpmn:UserTask']],
  ['priority', ['bpmn:UserTask']],
  ['class', ['bpmn:ServiceTask']],
  ['expression', ['bpmn:ServiceTask']],
  ['delegateExpression', ['bpmn:ServiceTask']],
  ['type', ['bpmn:ServiceTask']],
  ['topic', ['bpmn:ServiceTask']],
  ['resultVariable', ['bpmn:ServiceTask', 'bpmn:ScriptTask']],
  ['calledElementBinding', ['bpmn:CallActivity']],
  ['calledElementVersion', ['bpmn:CallActivity']],
  ['versionTag', ['bpmn:Process']],
  ['errorCodeVariable', ['bpmn:ErrorEventDefinition']],
  ['errorMessageVariable', ['bpmn:ErrorEventDefinition']],
  ['escalationCodeVariable', ['bpmn:EscalationEventDefinition']],
  ['errorMessage', ['bpmn:Error']],
]);

const CONSUMED_EXTENSION_ELEMENTS = consumptionTable([
  ['operaton:FormData', ['bpmn:StartEvent', 'bpmn:UserTask']],
  ['operaton:FailedJobRetryTimeCycle', ENGINE_ATTRIBUTE_OWNERS],
  ['operaton:In', ['bpmn:CallActivity']],
  ['operaton:Out', ['bpmn:CallActivity']],
  ['operaton:InputOutput', IO_MAPPED_OWNERS],
  ['operaton:ExecutionListener', ENGINE_ATTRIBUTE_OWNERS],
  ['operaton:TaskListener', ['bpmn:UserTask']],
]);

/**
 * Per extension element the IR reads, the attribute local names its reader
 * reads off it. Body text is not an attribute and is absent here.
 * {@link warnUnreadChildAttrs} sweeps against this table, so a `$type` missing
 * from it is never swept: an `operaton:field` is reported whole by
 * {@link warnFieldDrop} instead.
 */
const CONSUMED_CHILD_ATTRS = consumptionTable([
  ['operaton:FormData', []],
  ['operaton:FormField', ['id', 'label', 'type', 'defaultValue']],
  ['operaton:FailedJobRetryTimeCycle', []],
  [
    'operaton:In',
    [
      'source',
      'sourceExpression',
      'variables',
      'target',
      'businessKey',
      'local',
    ],
  ],
  [
    'operaton:Out',
    ['source', 'sourceExpression', 'variables', 'target', 'local'],
  ],
  ['operaton:InputOutput', []],
  ['operaton:InputParameter', ['name']],
  ['operaton:OutputParameter', ['name']],
  ['operaton:List', []],
  ['operaton:Map', []],
  ['operaton:Entry', ['key']],
  ['operaton:Value', []],
  ['operaton:Script', ['scriptFormat', 'resource']],
  [
    'operaton:ExecutionListener',
    ['event', 'class', 'expression', 'delegateExpression'],
  ],
  [
    'operaton:TaskListener',
    ['event', 'class', 'expression', 'delegateExpression'],
  ],
]);

/**
 * Tried in this order: the first one a child's reader reads names it in a
 * warning. An `operaton:value` has none, so list items stay unqualified.
 */
const CHILD_IDENTITY_ATTRS = [
  'name',
  'key',
  'event',
  'id',
  'source',
  'sourceExpression',
] as const;

function isConsumedHere(
  table: ReadonlyMap<string, ReadonlySet<string>>,
  ownerType: string,
  name: string,
): boolean {
  return table.get(name)?.has(ownerType) === true;
}

/** `operaton:formField` types the DSL can express; the export direction emits `long` for `number`. */
const OPERATON_TO_FORM_FIELD_TYPE: Readonly<Record<string, FormFieldType>> = {
  string: 'string',
  long: 'number',
  boolean: 'boolean',
  date: 'date',
};

const KEPT_SETTINGS_NOTE =
  '(this tool keeps the assignee, form, script, service-task binding, ' +
  'result variable, version tag, input/output mappings and listeners, and ' +
  'the async, retry, job-priority and task-assignment settings; a gateway ' +
  'carries no engine setting at all).';

const IMPORTED_FLOW_NOTE =
  '(this tool imports the executable flow and the engine settings on its ' +
  'steps, and nothing declared or drawn beside it).';

/**
 * Attributes the exporter re-stamps as a fixed constant. An imported value
 * equal to the constant loses nothing on re-export, so it raises no warning.
 */
const REEXPORTED_CONSTANT_ATTRS: ReadonlyMap<string, string> = new Map([
  ['operaton:historyTimeToLive', HISTORY_TIME_TO_LIVE],
]);

/** Loose moddle-element type: the tiny surface every moddle node shares. */
interface ModdleElement {
  readonly $type: string;
  readonly id?: string;
  readonly $attrs: Record<string, string | undefined>;
  readonly $descriptor?: {
    readonly properties?: readonly ModdlePropertyDescriptor[];
  };
  get(name: string): unknown;
}

/** A moddle descriptor property: `name` is the storage key, `ns.name` the form `get()` accepts. */
interface ModdlePropertyDescriptor {
  readonly name: string;
  readonly isAttr?: boolean;
  readonly isBody?: boolean;
  /** A back-reference moddle fills in from the other end, not content of its own. */
  readonly isReference?: boolean;
  readonly ns?: {
    readonly name: string;
    readonly prefix?: string;
    readonly localName: string;
  };
}

/**
 * Parse a BPMN 2.0 XML document into the IR. Throws when the XML is malformed,
 * has no `bpmn:Process`, or has more than one.
 */
export async function xmlToIr(
  xml: string,
): Promise<{ ir: BpmnProcess; warnings: ImportWarning[] }> {
  const moddle = createModdle();

  // moddle records "unparsable content" only for elements in the registered
  // `operaton:` namespace whose type the extension does not declare. Declared
  // operaton and foreign-namespace elements materialise as values instead.
  const { rootElement, warnings: moddleWarnings } = await moddle.fromXML(xml);

  const root = rootElement as ModdleElement;
  if (root.$type !== 'bpmn:Definitions') {
    throw new Error(
      `Expected root element 'bpmn:Definitions', got '${root.$type}'.`,
    );
  }

  const rootElements = (root.get('rootElements') as ModdleElement[]) ?? [];

  // The IR models a single standalone process, so pools and message flows are
  // refused before anything is mapped.
  if (rootElements.some((e) => e.$type === 'bpmn:Collaboration')) {
    throw new UnsupportedCollaborationError(
      'multiple linked processes (pools and message flows)',
    );
  }

  const processes = rootElements.filter((e) => e.$type === 'bpmn:Process');
  if (processes.length === 0) {
    throw new Error(
      'BPMN document contains no <bpmn:process> root element — nothing to import.',
    );
  }
  if (processes.length > 1) {
    throw new Error(
      'Multi-process definitions are not supported ' +
        `(found ${processes.length} <bpmn:process> elements).`,
    );
  }

  const warnings: ImportWarning[] = [];
  const mappedProcess = mapProcess(processes[0], warnings);

  // Fold declared error messages in before the unreferenced-root check: a
  // message-carrying root is never "unreferenced".
  const errorRoots = rootElements.filter((e) => e.$type === 'bpmn:Error');
  const escalationRoots = rootElements.filter(
    (e) => e.$type === 'bpmn:Escalation',
  );
  const messageRoots = rootElements.filter((e) => e.$type === 'bpmn:Message');
  const signalRoots = rootElements.filter((e) => e.$type === 'bpmn:Signal');
  const errorMessages = resolveErrorMessages(errorRoots);
  const ir: BpmnProcess = {
    ...mappedProcess,
    ...(errorMessages.length > 0 ? { errorMessages } : {}),
  };
  warnUnreferencedRoots(
    errorRoots,
    escalationRoots,
    messageRoots,
    signalRoots,
    ir,
    warnings,
  );

  const documentId = root.id ?? ir.id;
  collectExtensionDrops(root, documentId, warnings);
  collectUnmappedBpmnDrops(root, documentId, warnings);
  collectUnmappedRootDrops(rootElements, ir.id, warnings);

  // Undeclared `operaton:` elements surface only as document-level moddle
  // warnings, so they are attributed to the process.
  collectUnparsableResidualDrops(moddleWarnings, ir.id, warnings);
  return { ir, warnings };
}

/** The `{ code, message }` pairs `bpmn:Error` roots declare, in document order, deduped by code. */
function resolveErrorMessages(
  errorRoots: ModdleElement[],
): { code: string; message: string }[] {
  const seen = new Map<string, { message: string; rootId: string }>();
  const entries: { code: string; message: string }[] = [];

  for (const root of errorRoots) {
    const rootId = requireId(root);
    const message = readNamespacedAttr(root, 'errorMessage');
    if (message === undefined) continue;

    const code = readString(root, 'errorCode');
    if (code === undefined) {
      throw new UnsupportedEventFeatureError(
        rootId,
        'a declared error message needs a code to be keyed by, but this ' +
          'error root has no errorCode',
      );
    }

    const prior = seen.get(code);
    if (prior !== undefined && prior.message !== message) {
      throw new UnsupportedEventFeatureError(
        rootId,
        `error roots '${prior.rootId}' and '${rootId}' both declare code ` +
          `"${code}" but disagree about the thrown message`,
      );
    }
    if (prior === undefined) {
      seen.set(code, { message, rootId });
      entries.push({ code, message });
    }
  }

  return entries;
}

function collectReferencedCodes(process: BpmnProcess): {
  errorCodes: Set<string>;
  escalationCodes: Set<string>;
  messageNames: Set<string>;
  signalNames: Set<string>;
} {
  const errorCodes = new Set<string>();
  const escalationCodes = new Set<string>();
  const messageNames = new Set<string>();
  const signalNames = new Set<string>();

  const visit = (elements: FlowElement[]): void => {
    for (const el of elements) {
      const def: EventDefinition | undefined =
        el.kind === 'startEvent' ||
        el.kind === 'endEvent' ||
        el.kind === 'intermediateThrowEvent' ||
        el.kind === 'intermediateCatchEvent' ||
        el.kind === 'boundaryEvent'
          ? el.eventDefinition
          : undefined;
      if (def?.kind === 'error' && def.errorCode !== undefined) {
        errorCodes.add(def.errorCode);
      } else if (
        def?.kind === 'escalation' &&
        def.escalationCode !== undefined
      ) {
        escalationCodes.add(def.escalationCode);
      } else if (def?.kind === 'message') {
        messageNames.add(def.messageName);
      } else if (def?.kind === 'signal') {
        signalNames.add(def.signalName);
      }
      if (el.kind === 'subProcess') visit(el.flowElements);
    }
  };
  visit(process.flowElements);

  return { errorCodes, escalationCodes, messageNames, signalNames };
}

/**
 * Warn once per error/escalation/message/signal root nothing in the IR uses. An
 * error root carrying a declared message is exempt: {@link resolveErrorMessages}
 * folded it into `ir.errorMessages` regardless of usage.
 */
function warnUnreferencedRoots(
  errorRoots: ModdleElement[],
  escalationRoots: ModdleElement[],
  messageRoots: ModdleElement[],
  signalRoots: ModdleElement[],
  ir: BpmnProcess,
  warnings: ImportWarning[],
): void {
  const { errorCodes, escalationCodes, messageNames, signalNames } =
    collectReferencedCodes(ir);
  const declaredCodes = new Set((ir.errorMessages ?? []).map((m) => m.code));

  for (const root of errorRoots) {
    const rootId = requireId(root);
    const code = readString(root, 'errorCode');
    if (
      code !== undefined &&
      (errorCodes.has(code) || declaredCodes.has(code))
    ) {
      continue;
    }
    warnings.push({
      elementId: rootId,
      category: 'unreferencedRoot',
      message:
        code !== undefined
          ? `The error "${code}" declared by root '${rootId}' is never ` +
            'caught or thrown and carries no message; it was not imported.'
          : `The error root '${rootId}' has no code, so it cannot be keyed ` +
            'or represented in the model; it was not imported.',
    });
  }

  for (const root of escalationRoots) {
    const rootId = requireId(root);
    const code = readString(root, 'escalationCode');
    if (code !== undefined && escalationCodes.has(code)) continue;
    warnings.push({
      elementId: rootId,
      category: 'unreferencedRoot',
      message:
        code !== undefined
          ? `The escalation "${code}" declared by root '${rootId}' is never ` +
            'caught or thrown; it was not imported.'
          : `The escalation root '${rootId}' has no code, so it cannot be ` +
            'keyed or represented in the model; it was not imported.',
    });
  }

  for (const root of messageRoots) {
    warnUnreferencedNamedRoot(
      root,
      messageNames,
      'message',
      'itemRef',
      warnings,
    );
  }
  for (const root of signalRoots) {
    warnUnreferencedNamedRoot(
      root,
      signalNames,
      'signal',
      'structureRef',
      warnings,
    );
  }
}

/**
 * Check one message/signal root against the names the IR uses. moddle resolves
 * `itemRef`/`structureRef` as element references, so presence goes through
 * `.get()`.
 */
function warnUnreferencedNamedRoot(
  root: ModdleElement,
  referencedNames: ReadonlySet<string>,
  label: 'message' | 'signal',
  dataRefProperty: 'itemRef' | 'structureRef',
  warnings: ImportWarning[],
): void {
  const rootId = requireId(root);
  const name = readString(root, 'name');

  if (name !== undefined && referencedNames.has(name)) {
    if (getEl(root, dataRefProperty) !== undefined) {
      warnings.push({
        elementId: rootId,
        category: 'extensionAttribute',
        message:
          `The '${dataRefProperty}' setting on ${label} root '${rootId}' names a ` +
          'data structure Operaton does not execute; it was not imported.',
      });
    }
    return;
  }

  warnings.push({
    elementId: rootId,
    category: 'unreferencedRoot',
    message:
      name !== undefined
        ? `The ${label} "${name}" declared by root '${rootId}' is never used ` +
          'by an on/throw/emit; it was not imported.'
        : `The ${label} root '${rootId}' has no name, so it cannot be keyed ` +
          'or represented in the model; it was not imported.',
  });
}

/** A `bpmn-moddle` parse warning; only its `message` is read. */
interface ModdleWarning {
  readonly message?: string;
}

/**
 * One {@link ImportWarning} per residual "unparsable content" moddle warning,
 * attributed to the process because moddle cannot tie the dropped element to a
 * step. Declared operaton and foreign-namespace elements never reach here.
 */
function collectUnparsableResidualDrops(
  moddleWarnings: unknown,
  processId: string,
  warnings: ImportWarning[],
): void {
  const list = (moddleWarnings as ModdleWarning[] | undefined) ?? [];
  for (const warning of list) {
    const message = String(warning.message ?? '');
    const match = /unparsable content <([^>]+)>/i.exec(message);
    if (match === null) continue;
    const construct = match[1];
    const lineMatch = /line:\s*(\d+)/i.exec(message);
    const location = lineMatch ? ` at line ${lineMatch[1]}` : '';
    warnings.push({
      elementId: processId,
      category: 'extensionAttribute',
      message:
        `Extra engine-specific configuration (${construct}${location}) was not ` +
        `imported; it could not be attributed to a specific step ${KEPT_SETTINGS_NOTE}`,
    });
  }
}

/**
 * Map a `bpmn:Process` into the IR. All `bpmndi:`/`dc:`/`di:` content sits
 * outside the process subtree, so iterating `flowElements` drops DI for free.
 */
function mapProcess(
  processEl: ModdleElement,
  warnings: ImportWarning[],
): BpmnProcess {
  const id = processEl.id;
  if (id === undefined) {
    throw new Error("<bpmn:process> is missing its required 'id' attribute.");
  }
  const name = readDerivableName(processEl, id);

  // The one place import changes what the document says rather than leaving
  // something out, so it gets its own wording. An absent flag needs none.
  if (processEl.get('isExecutable') === false) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The process '${id}' is marked isExecutable="false", which this ` +
        'surface cannot express: it was imported as an executable process ' +
        'and is written back as one, so an engine will deploy and run what ' +
        'the source document held back.',
    });
  }

  collectLaneDrops(processEl, id, warnings);
  collectExtensionDrops(processEl, id, warnings);
  collectUnmappedBpmnDrops(processEl, id, warnings);

  const { flowElements, sequenceFlows } = mapContainer(
    processEl,
    warnings,
    'process',
  );

  const versionTag = readNamespacedAttr(processEl, 'versionTag');

  return {
    id,
    ...(name === undefined ? {} : { name }),
    isExecutable: true,
    ...(versionTag === undefined ? {} : { versionTag }),
    flowElements,
    sequenceFlows,
  };
}

/**
 * Which container hosts the element being mapped, threaded down so
 * {@link mapEventSubProcessStart} can check a compensation handler's host
 * without moddle's `$parent`. BPMN requires that handler to sit directly inside
 * the sub-process it compensates, so only `'subProcess'` passes there.
 */
type ContainerHostKind = 'process' | 'subProcess' | 'eventSubProcess';

function mapContainer(
  el: ModdleElement,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): { flowElements: FlowElement[]; sequenceFlows: SequenceFlow[] } {
  return mapContainerChildren(
    el,
    warnings,
    (startEl) => mapStartEvent(startEl, warnings),
    hostKind,
  );
}

/** The `Activity` subtypes this tool maps: the only kinds that carry `isForCompensation`. */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ScriptTask',
  'bpmn:SubProcess',
  'bpmn:CallActivity',
]);

function refuseIfForCompensation(child: ModdleElement): void {
  if (!ACTIVITY_TYPES.has(child.$type)) return;
  if (child.get('isForCompensation') !== true) return;
  throw new UnsupportedEventFeatureError(
    child.id ?? '(unknown)',
    'isForCompensation="true" marks this activity as excluded from normal ' +
      'flow — the boundary-event compensation-handler pattern, which this ' +
      'tool cannot import; wrap the steps in their own sub-process and ' +
      'target it with "on compensation" instead',
  );
}

/**
 * Per-child dispatch for a container's `flowElements`. `attachedToRef` is
 * validated afterwards by {@link checkBoundaryEventHosts}, not inline: moddle
 * may present a boundary event before its host, so the container's full
 * activity-id set exists only once the loop has finished.
 */
function mapContainerChildren(
  el: ModdleElement,
  warnings: ImportWarning[],
  mapStart: (startEl: ModdleElement) => StartEvent,
  hostKind: ContainerHostKind,
): { flowElements: FlowElement[]; sequenceFlows: SequenceFlow[] } {
  const flowElements: FlowElement[] = [];
  const sequenceFlows: SequenceFlow[] = [];

  const children = (el.get('flowElements') as ModdleElement[]) ?? [];
  for (const child of children) {
    refuseIfForCompensation(child);
    switch (child.$type) {
      case 'bpmn:StartEvent':
        flowElements.push(mapStart(child));
        break;
      case 'bpmn:EndEvent':
        flowElements.push(mapEndEvent(child, warnings));
        break;
      case 'bpmn:IntermediateThrowEvent':
        flowElements.push(mapIntermediateThrowEvent(child, warnings));
        break;
      case 'bpmn:IntermediateCatchEvent':
        flowElements.push(mapIntermediateCatchEvent(child, warnings));
        break;
      case 'bpmn:BoundaryEvent':
        flowElements.push(mapBoundaryEvent(child, warnings));
        break;
      case 'bpmn:UserTask':
        flowElements.push(mapUserTask(child, warnings));
        break;
      case 'bpmn:ServiceTask':
        flowElements.push(mapServiceTask(child, warnings));
        break;
      case 'bpmn:ScriptTask':
        flowElements.push(mapScriptTask(child, warnings));
        break;
      case 'bpmn:ExclusiveGateway':
        flowElements.push(mapExclusiveGateway(child));
        break;
      case 'bpmn:ParallelGateway':
        flowElements.push(mapParallelGateway(child));
        break;
      case 'bpmn:SubProcess':
        flowElements.push(
          child.get('triggeredByEvent') === true
            ? mapEventSubProcess(child, warnings, hostKind)
            : mapSubProcess(child, warnings),
        );
        break;
      case 'bpmn:CallActivity':
        flowElements.push(mapCallActivity(child, warnings));
        break;
      case 'bpmn:SequenceFlow':
        sequenceFlows.push(mapSequenceFlow(child));
        break;
      default:
        throw new UnsupportedElementError(child.$type, child.id);
    }
    if (child.id !== undefined) {
      collectExtensionDrops(child, child.id, warnings);
      collectUnmappedBpmnDrops(child, child.id, warnings);
    }
  }

  checkBoundaryEventHosts(flowElements, sequenceFlows);
  return { flowElements, sequenceFlows };
}

const BOUNDARY_HOST_KINDS: ReadonlySet<FlowElement['kind']> = new Set([
  'userTask',
  'serviceTask',
  'scriptTask',
  'subProcess',
  'callActivity',
]);

/**
 * The subset an escalation boundary may attach to, per Operaton's own
 * `BpmnParse.parseBoundaryEvents`: a service or script task is excluded.
 */
const ESCALATION_BOUNDARY_HOST_KINDS: ReadonlySet<FlowElement['kind']> =
  new Set(['subProcess', 'callActivity', 'userTask']);

/**
 * Validate every boundary event against the other elements of its own
 * container, after {@link mapContainerChildren}'s child loop: a host may be
 * written before or after the boundary event, so the activity-id set is only
 * complete then.
 *
 * The same pass catches an inbound flow written only as
 * `sequenceFlow/@targetRef`. {@link mapBoundaryEvent} sees only the `incoming`
 * list, which moddle fills from optional `<bpmn:incoming>` children, while
 * Operaton reads `targetRef` regardless.
 */
function checkBoundaryEventHosts(
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
): void {
  const activityById = new Map<string, FlowElement>();
  for (const el of flowElements) {
    // An event sub-process is written as a bare `on <trigger> { ... }` with no
    // authored id, so a boundary event on one could only print against a
    // synthesized id. Left out of the map, it hits the refusal below.
    if (
      BOUNDARY_HOST_KINDS.has(el.kind) &&
      !(el.kind === 'subProcess' && el.triggeredByEvent === true)
    ) {
      activityById.set(el.id, el);
    }
  }

  const boundaryIds = new Set(
    flowElements.filter((el) => el.kind === 'boundaryEvent').map((el) => el.id),
  );
  for (const sf of sequenceFlows) {
    if (!boundaryIds.has(sf.targetRef)) continue;
    throw new UnsupportedEventFeatureError(
      sf.targetRef,
      'a boundary event carries an incoming sequence flow — it is ' +
        'triggered by its own event, not by an incoming flow',
    );
  }

  for (const el of flowElements) {
    if (el.kind !== 'boundaryEvent') continue;

    const host = activityById.get(el.attachedToRef);
    if (host === undefined) {
      throw new UnsupportedEventFeatureError(
        el.id,
        `attachedToRef "${el.attachedToRef}" does not name a user task, ` +
          'service task, script task, sub-process, or call activity that is ' +
          'itself a flow element of this same container — a boundary event ' +
          'can only attach to an activity alongside it',
      );
    }
    if (
      el.eventDefinition.kind === 'escalation' &&
      !ESCALATION_BOUNDARY_HOST_KINDS.has(host.kind)
    ) {
      throw new UnsupportedEventFeatureError(
        el.id,
        `an escalation boundary event attaches to "${el.attachedToRef}", a ` +
          `${host.kind} — Operaton only allows an escalation boundary on a ` +
          'sub-process, a call activity, or a user task',
      );
    }
  }
}

/**
 * Map a plain `bpmn:SubProcess`. `bpmn:Transaction` and `bpmn:AdHocSubProcess`
 * carry their own `$type`s and hit the default refusal arm instead.
 */
function mapSubProcess(
  el: ModdleElement,
  warnings: ImportWarning[],
): SubProcess {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  collectLaneDrops(el, id, warnings);
  const name = readDerivableName(el, id);
  const { flowElements, sequenceFlows } = mapContainer(
    el,
    warnings,
    'subProcess',
  );

  return {
    kind: 'subProcess',
    id,
    ...(name === undefined ? {} : { name }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
    flowElements,
    sequenceFlows,
  };
}

function mapEventSubProcess(
  el: ModdleElement,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): SubProcess {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);

  const incoming = (el.get('incoming') as ModdleElement[] | undefined) ?? [];
  const outgoing = (el.get('outgoing') as ModdleElement[] | undefined) ?? [];
  if (incoming.length > 0 || outgoing.length > 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'an event handler carries incoming or outgoing sequence flows — it ' +
        'is triggered by its caught event, not wired into the surrounding flow',
    );
  }

  collectLaneDrops(el, id, warnings);
  warnGenuineLabel(el, id, 'an event handler', warnings);

  const children = (el.get('flowElements') as ModdleElement[]) ?? [];
  const startEvents = children.filter((c) => c.$type === 'bpmn:StartEvent');
  if (startEvents.length !== 1) {
    throw new UnsupportedEventFeatureError(
      id,
      'an event handler must have exactly one start event carrying its ' +
        `trigger (found ${startEvents.length})`,
    );
  }

  const { flowElements, sequenceFlows } = mapContainerChildren(
    el,
    warnings,
    (startEl) => mapEventSubProcessStart(startEl, id, warnings, hostKind),
    'eventSubProcess',
  );

  return {
    kind: 'subProcess',
    id,
    triggeredByEvent: true,
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
    flowElements,
    sequenceFlows,
  };
}

function mapEventSubProcessStart(
  startEl: ModdleElement,
  handlerId: string,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): StartEvent {
  const id = requireId(startEl);
  const defs = eventDefinitionsOf(startEl);
  if (defs.length !== 1) {
    throw new UnsupportedEventFeatureError(
      handlerId,
      'its start event must carry exactly one trigger definition ' +
        `(found ${defs.length})`,
    );
  }

  const eventDefinition = readCatchEventDefinition(
    defs[0],
    id,
    warnings,
    'start',
  );

  if (eventDefinition.kind === 'compensation' && hostKind !== 'subProcess') {
    throw new UnsupportedEventFeatureError(
      handlerId,
      'a compensation handler must be hosted directly by the plain ' +
        `sub-process it compensates, not by ${
          hostKind === 'process' ? 'the process' : 'another event sub-process'
        } — move it into the sub-process it compensates`,
    );
  }

  const isInterrupting =
    startEl.get('isInterrupting') === false ? false : undefined;
  if (
    isInterrupting === false &&
    (eventDefinition.kind === 'error' ||
      eventDefinition.kind === 'compensation')
  ) {
    throw new UnsupportedEventFeatureError(
      handlerId,
      eventDefinition.kind === 'error'
        ? 'an error handler cannot be non-interrupting (isInterrupting="false") ' +
            '— BPMN requires an error trigger to interrupt its scope'
        : 'a compensation handler cannot be non-interrupting ' +
            '(isInterrupting="false") — BPMN requires a compensation trigger ' +
            'to interrupt its scope',
    );
  }

  const formFields = readFormFields(startEl, id, warnings);
  return {
    kind: 'startEvent',
    id,
    eventDefinition,
    ...(isInterrupting === false ? { isInterrupting: false } : {}),
    ...(formFields === undefined ? {} : { formFields }),
    ...readEngineAttributes(startEl, id, warnings),
  };
}

/**
 * Map a `bpmn:BoundaryEvent`. `attachedToRef` resolves to the host element
 * (BPMN declares it `isReference: true`) and only its `id` is kept, so the IR
 * stays plain strings; {@link checkBoundaryEventHosts} validates it afterwards.
 */
function mapBoundaryEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
): BoundaryEvent {
  const id = requireId(el);

  const hostEl = getEl(el, 'attachedToRef');
  if (hostEl === undefined) {
    throw new UnsupportedEventFeatureError(
      id,
      'a boundary event has no attachedToRef — BPMN requires every ' +
        'boundary event to attach to an activity in its own container',
    );
  }

  const incoming = (el.get('incoming') as ModdleElement[] | undefined) ?? [];
  if (incoming.length > 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'a boundary event carries an incoming sequence flow — it is ' +
        'triggered by its own event, not by an incoming flow',
    );
  }

  refuseBoundaryInputOutput(el, id);

  const defs = eventDefinitionsOf(el);
  if (defs.length !== 1) {
    throw new UnsupportedEventFeatureError(
      id,
      `a boundary event must carry exactly one trigger definition (found ${defs.length})`,
    );
  }
  const [defEl] = defs;

  if (defEl.$type === 'bpmn:CompensateEventDefinition') {
    throw new UnsupportedEventFeatureError(
      id,
      'a compensation boundary event is not imported — BPMN attaches ' +
        'compensation through isForCompensation and a bpmn:association on ' +
        'the activity being compensated, not a boundary event; wrap the ' +
        'steps in their own sub-process and target it with "on compensation" instead',
    );
  }

  const eventDefinition = readCatchEventDefinition(
    defEl,
    id,
    warnings,
    'boundary',
  );
  warnGenuineLabel(el, id, 'a boundary event', warnings);

  const cancelActivity = el.get('cancelActivity') === false ? false : undefined;
  if (cancelActivity === false && eventDefinition.kind === 'error') {
    throw new UnsupportedEventFeatureError(
      id,
      'an error boundary event cannot be non-interrupting ' +
        '(cancelActivity="false") — BPMN gives an error boundary no ' +
        'non-interrupting form',
    );
  }

  return {
    kind: 'boundaryEvent',
    id,
    attachedToRef: requireId(hostEl),
    eventDefinition,
    ...(cancelActivity === false ? { cancelActivity: false } : {}),
    ...readEngineAttributes(el, id, warnings),
  };
}

function refuseBoundaryInputOutput(el: ModdleElement, id: string): void {
  const values = extensionValues(el);
  if (values.some((value) => value.$type === 'operaton:InputOutput')) {
    throw new UnsupportedEventFeatureError(
      id,
      'a boundary event carries an operaton:inputOutput mapping — Operaton ' +
        'forbids input/output variable mappings on a boundary event',
    );
  }
}

/**
 * Resolve one event definition on the CATCH side. An error or escalation
 * definition with no ref, or whose root carries no code, is catch-all: the
 * missing code is what makes the handler match anything.
 */
function readCatchEventDefinition(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
  position: 'start' | 'boundary' | 'intermediate catch',
): EventDefinition {
  collectExtensionDrops(defEl, ownerId, warnings);
  collectUnmappedBpmnDrops(defEl, ownerId, warnings);

  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    const ref = getEl(defEl, 'errorRef');
    const errorCode = ref ? readString(ref, 'errorCode') : undefined;
    const codeVariable = readNamespacedAttr(defEl, 'errorCodeVariable');
    const messageVariable = readNamespacedAttr(defEl, 'errorMessageVariable');
    return {
      kind: 'error',
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(codeVariable === undefined ? {} : { codeVariable }),
      ...(messageVariable === undefined ? {} : { messageVariable }),
    };
  }

  if (defEl.$type === 'bpmn:EscalationEventDefinition') {
    const ref = getEl(defEl, 'escalationRef');
    const escalationCode = ref ? readString(ref, 'escalationCode') : undefined;
    const codeVariable = readNamespacedAttr(defEl, 'escalationCodeVariable');
    return {
      kind: 'escalation',
      ...(escalationCode === undefined ? {} : { escalationCode }),
      ...(codeVariable === undefined ? {} : { codeVariable }),
    };
  }

  if (defEl.$type === 'bpmn:MessageEventDefinition') {
    return {
      kind: 'message',
      messageName: resolveNamedRootRef(defEl, 'messageRef', ownerId, 'message'),
    };
  }

  if (defEl.$type === 'bpmn:SignalEventDefinition') {
    return {
      kind: 'signal',
      signalName: resolveNamedRootRef(defEl, 'signalRef', ownerId, 'signal'),
    };
  }

  if (defEl.$type === 'bpmn:TimerEventDefinition') {
    return { kind: 'timer', ...readTimerDefinition(defEl, ownerId) };
  }

  if (defEl.$type === 'bpmn:ConditionalEventDefinition') {
    return {
      kind: 'conditional',
      condition: readConditionalDefinition(defEl, ownerId),
    };
  }

  if (defEl.$type === 'bpmn:CompensateEventDefinition') {
    refuseUnsupportedCompensateFeatures(defEl, ownerId);
    return { kind: 'compensation' };
  }

  throw new UnsupportedEventDefinitionError(ownerId, position, defEl.$type);
}

/**
 * The moddle schema defaults `waitForCompletion` to `true` and reads an absent
 * attribute back as `true`, so a bare definition and an explicit `"true"`
 * import identically; only an explicit `false` is refused.
 */
function refuseUnsupportedCompensateFeatures(
  defEl: ModdleElement,
  ownerId: string,
): void {
  const activityRef = getEl(defEl, 'activityRef');
  if (activityRef !== undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a compensation definition targets one activity by reference ' +
        `(activityRef="${activityRef.id ?? '(unknown)'}") — this tool always ` +
        'addresses the enclosing scope and cannot target a single activity',
    );
  }
  if (defEl.get('waitForCompletion') === false) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a compensation definition sets waitForCompletion="false" — this tool ' +
        'only imports the default (wait for the compensation to complete) behavior',
    );
  }
}

function resolveNamedRootRef(
  defEl: ModdleElement,
  refProperty: 'messageRef' | 'signalRef',
  ownerId: string,
  label: 'message' | 'signal',
): string {
  const ref = getEl(defEl, refProperty);
  const name = ref ? readString(ref, 'name') : undefined;
  if (name === undefined) {
    const rootKind = label === 'message' ? 'bpmn:Message' : 'bpmn:Signal';
    throw new UnsupportedEventFeatureError(
      ownerId,
      `a ${label} definition must reference a ${rootKind} root with a non-empty name`,
    );
  }
  return name;
}

/** Inverse of `ir-to-xml.ts`'s `TIMER_KIND_TO_CHILD`. */
const TIMER_CHILD_TO_KIND: Readonly<
  Record<
    'timeDuration' | 'timeDate' | 'timeCycle',
    'duration' | 'date' | 'cycle'
  >
> = {
  timeDuration: 'duration',
  timeDate: 'date',
  timeCycle: 'cycle',
};

function readTimerDefinition(
  defEl: ModdleElement,
  ownerId: string,
): { timerKind: 'duration' | 'date' | 'cycle'; expression: string } {
  const childNames = Object.keys(
    TIMER_CHILD_TO_KIND,
  ) as (keyof typeof TIMER_CHILD_TO_KIND)[];
  const present = childNames.filter(
    (childName) => getEl(defEl, childName) !== undefined,
  );

  if (present.length !== 1) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a timer definition must carry exactly one of timeDuration/timeDate/' +
        `timeCycle (found ${present.length})`,
    );
  }

  const [childName] = present;
  const expressionEl = defEl.get(childName) as ModdleElement;
  const expression = readString(expressionEl, 'body');
  if (expression === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      `a timer definition's ${childName} has an empty body`,
    );
  }
  return { timerKind: TIMER_CHILD_TO_KIND[childName], expression };
}

/**
 * The conditional-narrowing attribute names. Neither is declared by the moddle
 * extension, so both surface only in `$attrs`, under either prefix.
 */
const CONDITIONAL_NARROWING_ATTRS: readonly string[] = [
  'variableName',
  'variableEvents',
];

function readConditionalDefinition(
  defEl: ModdleElement,
  ownerId: string,
): string {
  const attrs = defEl.$attrs ?? {};
  for (const localName of CONDITIONAL_NARROWING_ATTRS) {
    for (const prefix of ['operaton', 'camunda']) {
      if (attrs[`${prefix}:${localName}`] !== undefined) {
        throw new UnsupportedEventFeatureError(
          ownerId,
          `a conditional definition's ${prefix}:${localName} narrows when the ` +
            'condition is (re-)evaluated, which this tool cannot represent',
        );
      }
    }
  }

  const conditionEl = getEl(defEl, 'condition');
  const condition = conditionEl ? readString(conditionEl, 'body') : undefined;
  if (condition === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a conditional definition must carry a condition with a non-empty body',
    );
  }
  return condition;
}

/**
 * Resolve one event definition on the THROW side. Binding attributes have no
 * effect on a throw, but {@link CONSUMED_EXTENSION_ATTRS} lists them against
 * the definition type, which is the same on both sides, so
 * {@link warnThrowSideBindingAttrs} reports them instead of the generic sweep.
 */
function readThrowEventDefinition(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): EventDefinition {
  collectExtensionDrops(defEl, ownerId, warnings);
  collectUnmappedBpmnDrops(defEl, ownerId, warnings);
  warnThrowSideBindingAttrs(defEl, ownerId, warnings);

  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    const ref = getEl(defEl, 'errorRef');
    const errorCode = ref ? readString(ref, 'errorCode') : undefined;
    if (errorCode === undefined) {
      throw new UnsupportedEventFeatureError(
        ownerId,
        'a throw must resolve to a non-empty code',
      );
    }
    return { kind: 'error', errorCode };
  }

  if (defEl.$type === 'bpmn:SignalEventDefinition') {
    return {
      kind: 'signal',
      signalName: resolveNamedRootRef(defEl, 'signalRef', ownerId, 'signal'),
    };
  }

  if (defEl.$type === 'bpmn:CompensateEventDefinition') {
    refuseUnsupportedCompensateFeatures(defEl, ownerId);
    return { kind: 'compensation' };
  }

  const ref = getEl(defEl, 'escalationRef');
  const escalationCode = ref ? readString(ref, 'escalationCode') : undefined;
  if (escalationCode === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a throw must resolve to a non-empty code',
    );
  }
  return { kind: 'escalation', escalationCode };
}

/**
 * The generic sweep cannot report these: throw and catch carry the same element
 * `$type`, and the catch side reads these names.
 */
function warnThrowSideBindingAttrs(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  const names =
    defEl.$type === 'bpmn:ErrorEventDefinition'
      ? ['errorCodeVariable', 'errorMessageVariable']
      : defEl.$type === 'bpmn:EscalationEventDefinition'
        ? ['escalationCodeVariable']
        : [];
  for (const name of names) {
    if (readNamespacedAttr(defEl, name) === undefined) continue;
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `The '${name}' setting on '${ownerId}' only takes effect on a ` +
        "catch (an 'on' handler); it has no effect on a throw and was not imported.",
    });
  }
}

function warnGenuineLabel(
  el: ModdleElement,
  id: string,
  surface: string,
  warnings: ImportWarning[],
): void {
  const name = readDerivableName(el, id);
  if (name === undefined) return;
  warnings.push({
    elementId: id,
    category: 'label',
    message:
      `The label '${name}' on '${id}' was not imported: ${surface} has no ` +
      "label in this tool's surface.",
  });
}

function mapCallActivity(
  el: ModdleElement,
  warnings: ImportWarning[],
): CallActivity {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);

  const calledElement = readString(el, 'calledElement');
  if (calledElement === undefined) {
    throw new UnsupportedCallActivityError(
      id,
      'it has no calledElement — there is nothing for the engine to invoke',
    );
  }
  refuseExecutionAffectingCallActivityAttrs(el, id);

  const binding = readCalledElementBinding(el, id, warnings);
  const { businessKey, inMappings, outMappings } = readCallMappings(el, id);

  return {
    kind: 'callActivity',
    id,
    ...(name === undefined ? {} : { name }),
    calledElement,
    ...(binding === undefined ? {} : { binding }),
    ...(businessKey === undefined ? {} : { businessKey }),
    ...(inMappings === undefined ? {} : { inMappings }),
    ...(outMappings === undefined ? {} : { outMappings }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

/** Refuse the call-activity attributes that change what the engine executes. */
function refuseExecutionAffectingCallActivityAttrs(
  el: ModdleElement,
  id: string,
): void {
  for (const [localName, detail] of EXECUTION_AFFECTING_CALL_ATTRS) {
    if (readNamespacedAttr(el, localName) !== undefined) {
      throw new UnsupportedCallActivityError(id, detail);
    }
  }
}

/** Checked in this order, so an element carrying two of them names the first. */
const EXECUTION_AFFECTING_CALL_ATTRS: readonly (readonly [string, string])[] = [
  [
    'variableMappingClass',
    'it sets variableMappingClass, which replaces the operaton:in/operaton:out ' +
      'mapping with a Java delegate — importing it would pass no variables ' +
      'into or out of the called process',
  ],
  [
    'variableMappingDelegateExpression',
    'it sets variableMappingDelegateExpression, which replaces the ' +
      'operaton:in/operaton:out mapping with a delegate expression — ' +
      'importing it would pass no variables into or out of the called process',
  ],
  [
    'calledElementTenantId',
    'it sets calledElementTenantId, which pins the tenant the engine ' +
      'resolves the called process against — dropping it would change ' +
      'which process is invoked',
  ],
];

/**
 * Resolve a call activity's version binding. The generic sweep cannot tell a
 * meaningful `calledElementVersion` from a dangling one (set while the binding
 * is absent or not `"version"`, where Operaton ignores it), so it is reported
 * here.
 */
function readCalledElementBinding(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): CalledElementBinding | undefined {
  const bindingValue = readNamespacedAttr(el, 'calledElementBinding');
  const version = readNamespacedAttr(el, 'calledElementVersion');

  let binding: CalledElementBinding | undefined;
  switch (bindingValue) {
    case undefined:
      binding = undefined;
      break;
    case 'latest':
      binding = { kind: 'latest' };
      break;
    case 'deployment':
      binding = { kind: 'deployment' };
      break;
    case 'version':
      if (version === undefined) {
        throw new UnsupportedCallActivityError(
          id,
          'calledElementBinding="version" is set without a ' +
            'calledElementVersion, so the engine cannot resolve which ' +
            'version to call',
        );
      }
      binding = { kind: 'version', version };
      break;
    default:
      throw new UnsupportedCallActivityError(
        id,
        `calledElementBinding="${bindingValue}" is not a binding this tool can represent`,
      );
  }

  if (version !== undefined && binding?.kind !== 'version') {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The 'calledElementVersion' setting on '${id}' has no effect ` +
        'without calledElementBinding="version" and was not imported.',
    });
  }

  return binding;
}

interface CallMappings {
  businessKey?: string;
  inMappings?: CallVariableMapping[];
  outMappings?: CallVariableMapping[];
}

function readCallMappings(el: ModdleElement, id: string): CallMappings {
  const values = extensionValues(el);

  let businessKey: string | undefined;
  let businessKeyCount = 0;
  const inMappings: CallVariableMapping[] = [];
  const outMappings: CallVariableMapping[] = [];

  for (const value of values) {
    if (value.$type === 'operaton:In') {
      const candidateBusinessKey = readString(value, 'businessKey');
      if (candidateBusinessKey !== undefined) {
        businessKeyCount += 1;
        if (businessKeyCount > 1) {
          throw new UnsupportedCallActivityError(
            id,
            'more than one operaton:in businessKey is set',
          );
        }
        if (
          readString(value, 'source') !== undefined ||
          readString(value, 'sourceExpression') !== undefined ||
          readString(value, 'target') !== undefined ||
          readString(value, 'variables') !== undefined ||
          value.get('local') === true
        ) {
          throw new UnsupportedCallActivityError(
            id,
            'an operaton:in businessKey is combined with ' +
              'source/sourceExpression/target/variables/local',
          );
        }
        businessKey = candidateBusinessKey;
        continue;
      }
      inMappings.push(readCallVariableMapping(value, id, 'operaton:in'));
    } else if (value.$type === 'operaton:Out') {
      outMappings.push(readCallVariableMapping(value, id, 'operaton:out'));
    }
  }

  return {
    ...(businessKey === undefined ? {} : { businessKey }),
    ...(inMappings.length > 0 ? { inMappings } : {}),
    ...(outMappings.length > 0 ? { outMappings } : {}),
  };
}

function readCallVariableMapping(
  value: ModdleElement,
  ownerId: string,
  tag: 'operaton:in' | 'operaton:out',
): CallVariableMapping {
  const source = readString(value, 'source');
  const sourceExpression = readString(value, 'sourceExpression');
  const variables = readString(value, 'variables');
  const target = readString(value, 'target');
  const local = value.get('local') === true ? true : undefined;

  if (source !== undefined && sourceExpression !== undefined) {
    throw new UnsupportedCallActivityError(
      ownerId,
      `a ${tag} carries both source and sourceExpression`,
    );
  }

  if (variables !== undefined) {
    if (variables !== 'all') {
      throw new UnsupportedCallActivityError(
        ownerId,
        `a ${tag} carries variables="${variables}", which this tool cannot ` +
          'import (only variables="all" is supported)',
      );
    }
    if (
      source !== undefined ||
      sourceExpression !== undefined ||
      target !== undefined
    ) {
      throw new UnsupportedCallActivityError(
        ownerId,
        `a ${tag} carries variables="all" combined with ` +
          'source/sourceExpression/target',
      );
    }
    return { kind: 'all', ...(local === true ? { local } : {}) };
  }

  if (source !== undefined) {
    if (target === undefined) {
      throw new UnsupportedCallActivityError(
        ownerId,
        `a ${tag} carries source without a target`,
      );
    }
    return {
      kind: 'variable',
      source,
      target,
      ...(local === true ? { local } : {}),
    };
  }

  if (sourceExpression !== undefined) {
    if (target === undefined) {
      throw new UnsupportedCallActivityError(
        ownerId,
        `a ${tag} carries sourceExpression without a target`,
      );
    }
    return {
      kind: 'expression',
      sourceExpression,
      target,
      ...(local === true ? { local } : {}),
    };
  }

  throw new UnsupportedCallActivityError(
    ownerId,
    `a ${tag} carries none of the recognized shapes (source+target, ` +
      'sourceExpression+target, variables="all", or businessKey)',
  );
}

/** One warning per `bpmn:Lane`: the flat IR has no lane concept. */
function collectLaneDrops(
  processEl: ModdleElement,
  processId: string,
  warnings: ImportWarning[],
): void {
  const laneSets = (processEl.get('laneSets') as ModdleElement[]) ?? [];
  for (const laneSet of laneSets) {
    warnLaneSetDrops(laneSet, processId, warnings);
  }
}

/**
 * Report every lane in one `bpmn:LaneSet`, descending into a lane's
 * `bpmn:childLaneSet`: a nested lane is a lane.
 */
function warnLaneSetDrops(
  laneSet: ModdleElement,
  fallbackId: string,
  warnings: ImportWarning[],
): void {
  const lanes = (laneSet.get('lanes') as ModdleElement[]) ?? [];
  for (const lane of lanes) {
    const laneId = lane.id ?? laneSet.id ?? fallbackId;
    const laneName = readString(lane, 'name');
    warnings.push({
      elementId: laneId,
      category: 'lane',
      message:
        `Lane ${laneName ? `'${laneName}' ` : ''}(${laneId}) was not imported; ` +
        'every step is placed in a single flat process.',
    });
    const childLaneSet = getEl(lane, 'childLaneSet');
    if (childLaneSet !== undefined) {
      warnLaneSetDrops(childLaneSet, fallbackId, warnings);
    }
  }
}

/**
 * The element-valued moddle properties some reader on this transform reads.
 * Every other BPMN child is content nothing reads, reported by
 * {@link collectUnmappedBpmnDrops}. Read but not mapped one-to-one:
 * `documentation` and `extensionElements` by {@link collectExtensionDrops},
 * `laneSets` by {@link collectLaneDrops}, `loopCharacteristics` refused by
 * {@link refuseLoopCharacteristics}, `rootElements` walked by {@link xmlToIr},
 * and `diagrams` is the DI data.
 */
const READ_BPMN_CHILDREN: ReadonlySet<string> = new Set([
  'condition',
  'conditionExpression',
  'diagrams',
  'documentation',
  'eventDefinitions',
  'extensionElements',
  'flowElements',
  'laneSets',
  'loopCharacteristics',
  'rootElements',
  'script',
  'timeCycle',
  'timeDate',
  'timeDuration',
]);

/**
 * One {@link ImportWarning} per piece of BPMN content on `el` that no reader
 * reads: a child outside {@link READ_BPMN_CHILDREN}, and an unnamespaced
 * attribute BPMN does not declare. A back-reference moddle fills in from the
 * other end is not content and is skipped, and an attribute in a foreign
 * namespace is left alone: that is where an editor parks its bookkeeping.
 */
function collectUnmappedBpmnDrops(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  for (const key of Object.keys(el.$attrs ?? {})) {
    if (key.includes(':') || key === 'xmlns') continue;
    warnings.push({
      elementId: ownerId,
      category: 'unmappedConstruct',
      message:
        `The '${key}' attribute on '${ownerId}' is not declared by BPMN and ` +
        `was not imported ${IMPORTED_FLOW_NOTE}`,
    });
  }

  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.isAttr === true || prop.isBody === true) continue;
    if (prop.isReference === true) continue;
    if (READ_BPMN_CHILDREN.has(prop.name)) continue;
    const value = el.get(prop.name);
    // A property holding one element is spelled as that property
    // (`<bpmn:ioSpecification>`), one holding a list as each item's own type.
    const items = Array.isArray(value) ? value : [value];
    const tag = Array.isArray(value) ? undefined : prop.ns?.name;
    for (const item of items) {
      const child = item as ModdleElement | undefined;
      if (typeof child?.$type !== 'string') continue;
      warnings.push({
        elementId: ownerId,
        category: 'unmappedConstruct',
        message:
          `A ${describeUnmapped(child, tag)} on '${ownerId}' was not ` +
          `imported ${IMPORTED_FLOW_NOTE}`,
      });
    }
  }
}

/** The root kinds {@link xmlToIr} handles; `bpmn:Collaboration` is refused before mapping. */
const HANDLED_ROOT_KINDS: ReadonlySet<string> = new Set([
  'bpmn:Process',
  'bpmn:Error',
  'bpmn:Escalation',
  'bpmn:Message',
  'bpmn:Signal',
]);

function collectUnmappedRootDrops(
  rootElements: ModdleElement[],
  processId: string,
  warnings: ImportWarning[],
): void {
  for (const root of rootElements) {
    if (HANDLED_ROOT_KINDS.has(root.$type)) continue;
    warnings.push({
      elementId: root.id ?? processId,
      category: 'unmappedConstruct',
      message:
        `A ${describeUnmapped(root)} root element was not imported ` +
        IMPORTED_FLOW_NOTE,
    });
  }
}

/**
 * Name one unmapped construct: its XML tag plus its id, or its `name` when it
 * has no id. `tag` overrides the tag derived from the type.
 */
function describeUnmapped(el: ModdleElement, tag?: string): string {
  const identity = el.id ?? readString(el, 'name');
  const name = tag ?? xmlTagOf(el.$type);
  return identity === undefined ? name : `${name} '${identity}'`;
}

function collectExtensionDrops(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  warnUnreadPrefixedAttrs(el, ownerId, warnings);
  warnUnreadExtensionElements(el, ownerId, warnings);
  warnUnreadDeclaredAttrs(el, ownerId, warnings);
  warnDocumentationDrop(el, ownerId, warnings);
}

/**
 * Report `operaton:`/`camunda:` attributes {@link CONSUMED_EXTENSION_ATTRS}
 * does not list for this owner kind. Any other namespace is left alone: that is
 * where an editor stamps its bookkeeping, and reporting it would bury the drops
 * that matter.
 */
function warnUnreadPrefixedAttrs(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  for (const key of Object.keys(el.$attrs ?? {})) {
    const colon = key.indexOf(':');
    if (colon === -1) continue;
    const prefix = key.slice(0, colon);
    const localName = key.slice(colon + 1);
    if (prefix !== 'operaton' && prefix !== 'camunda') continue;
    if (isConsumedHere(CONSUMED_EXTENSION_ATTRS, el.$type, localName)) continue;
    warnUnimportedSetting(warnings, ownerId, `'${key}' setting`);
  }
}

/**
 * Report the materialised `<bpmn:extensionElements>` children that
 * {@link CONSUMED_EXTENSION_ELEMENTS} does not list for this owner kind. An
 * undeclared `operaton:` element leaves no value behind and is reported against
 * the document by {@link collectUnparsableResidualDrops} instead.
 */
function warnUnreadExtensionElements(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  for (const value of extensionValues(el)) {
    if (isConsumedHere(CONSUMED_EXTENSION_ELEMENTS, el.$type, value.$type)) {
      warnUnreadChildAttrs(value, ownerId, describeChild(value), warnings);
      continue;
    }
    if (value.$type === 'operaton:Field') {
      warnFieldDrop(value, ownerId, `'${ownerId}'`, warnings);
      continue;
    }
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message: `Extra configuration (${value.$type}) on '${ownerId}' was not imported.`,
    });
  }
}

/**
 * Report the attributes the operaton moddle extension declares that the IR does
 * not read off this owner kind. A declared attribute parses into a typed
 * property, never into `$attrs`, so {@link warnUnreadPrefixedAttrs} cannot see
 * it.
 */
function warnUnreadDeclaredAttrs(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.ns === undefined || prop.ns.prefix !== 'operaton') continue;
    if (prop.isAttr !== true) continue;
    if (isConsumedHere(CONSUMED_EXTENSION_ATTRS, el.$type, prop.ns.localName)) {
      continue;
    }
    // Only what the document wrote: moddle stores a parsed value as an own property.
    if (!Object.prototype.hasOwnProperty.call(el, prop.name)) continue;
    if (el.get(prop.ns.name) === REEXPORTED_CONSTANT_ATTRS.get(prop.ns.name)) {
      continue;
    }
    warnUnimportedSetting(warnings, ownerId, `'${prop.ns.name}' setting`);
  }
}

/** One warning per element carrying `bpmn:documentation`, however many children. */
function warnDocumentationDrop(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  const documentation =
    (el.get('documentation') as ModdleElement[] | undefined) ?? [];
  if (documentation.length > 0) {
    warnings.push({
      elementId: ownerId,
      category: 'documentation',
      message: `Documentation on '${ownerId}' was not imported; documentation is not yet carried by this tool.`,
    });
  }
}

/** Report one engine setting re-export will not write back; `subject` names it in the sentence. */
function warnUnimportedSetting(
  warnings: ImportWarning[],
  ownerId: string,
  subject: string,
): void {
  warnings.push({
    elementId: ownerId,
    category: 'extensionAttribute',
    message: `The ${subject} on '${ownerId}' was not imported ${KEPT_SETTINGS_NOTE}`,
  });
}

/**
 * Report every attribute on a consumed extension child that no reader reads,
 * descending through the children the readers do read. An
 * `operaton:taskListener`'s `id` is the motivating case: Operaton addresses a
 * timeout listener's job by it and the id would otherwise leave no trace.
 *
 * Both spellings are swept, because moddle stores them apart: a declared
 * attribute parses into a typed property, an undeclared or foreign one lands in
 * `$attrs`.
 */
function warnUnreadChildAttrs(
  el: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): void {
  const consumed = CONSUMED_CHILD_ATTRS.get(el.$type);
  if (consumed === undefined) return;

  const report = (name: string): void =>
    warnUnimportedSetting(warnings, ownerId, `'${name}' on ${where}`);

  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.isAttr !== true) continue;
    const localName = prop.ns?.localName ?? prop.name;
    if (consumed.has(localName)) continue;
    // Only what the document wrote: moddle stores a parsed value as an own property.
    if (!Object.prototype.hasOwnProperty.call(el, prop.name)) continue;
    report(localName);
  }
  for (const key of Object.keys(el.$attrs ?? {})) {
    if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
    report(key);
  }
  for (const child of childElements(el)) {
    warnUnreadChildAttrs(
      child,
      ownerId,
      `${describeChild(child)} in ${where}`,
      warnings,
    );
  }
}

/** Name one extension child: its XML tag, plus the word that tells it from its siblings. */
function describeChild(el: ModdleElement): string {
  const consumed = CONSUMED_CHILD_ATTRS.get(el.$type);
  const identity = CHILD_IDENTITY_ATTRS.filter(
    (attr) => consumed?.has(attr) === true,
  )
    .map((attr) => readString(el, attr))
    .find((value) => value !== undefined);
  const tag = xmlTagOf(el.$type);
  return identity === undefined ? `an ${tag}` : `an ${tag} '${identity}'`;
}

/** The XML tag a moddle `$type` came from: `operaton:TaskListener` -> `operaton:taskListener`. */
function xmlTagOf(type: string): string {
  const local = type.indexOf(':') + 1;
  return (
    type.slice(0, local) +
    type.charAt(local).toLowerCase() +
    type.slice(local + 1)
  );
}

/**
 * The elements moddle materialised under `el`. A property declared as an
 * element but typed as a string (an `operaton:field`'s body) holds none.
 */
function childElements(el: ModdleElement): ModdleElement[] {
  const children: ModdleElement[] = [];
  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.isAttr === true || prop.isBody === true) continue;
    const value = el.get(prop.name);
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof (item as ModdleElement | undefined)?.$type === 'string') {
        children.push(item as ModdleElement);
      }
    }
  }
  return children;
}

/** Map a `bpmn:StartEvent`, refusing any event definition: plain starts only. */
function mapStartEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
): StartEvent {
  const id = requireId(el);
  refuseEventDefinitions(el, id);
  const name = readDerivableName(el, id);
  const formFields = readFormFields(el, id, warnings);
  return {
    kind: 'startEvent',
    id,
    ...(name === undefined ? {} : { name }),
    ...(formFields === undefined ? {} : { formFields }),
    ...readEngineAttributes(el, id, warnings),
  };
}

function mapEndEvent(el: ModdleElement, warnings: ImportWarning[]): EndEvent {
  const id = requireId(el);
  const defs = eventDefinitionsOf(el);

  if (defs.length === 0) {
    const name = readDerivableName(el, id);
    return {
      kind: 'endEvent',
      id,
      ...(name === undefined ? {} : { name }),
      ...readEngineAttributes(el, id, warnings),
    };
  }
  refuseMultipleEventDefinitions(
    id,
    defs,
    'a throw',
    'error, escalation, signal, or compensation is supported',
  );

  const [defEl] = defs;
  if (
    defEl.$type !== 'bpmn:ErrorEventDefinition' &&
    defEl.$type !== 'bpmn:EscalationEventDefinition' &&
    defEl.$type !== 'bpmn:SignalEventDefinition' &&
    defEl.$type !== 'bpmn:CompensateEventDefinition'
  ) {
    throw new UnsupportedEventDefinitionError(id, 'end', defEl.$type);
  }

  const eventDefinition = readThrowEventDefinition(defEl, id, warnings);
  warnGenuineLabel(el, id, 'a throw', warnings);

  return {
    kind: 'endEvent',
    id,
    eventDefinition,
    ...readEngineAttributes(el, id, warnings),
  };
}

function mapIntermediateThrowEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
): IntermediateThrowEvent {
  const id = requireId(el);
  const defs = eventDefinitionsOf(el);

  if (defs.length === 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'an emit with no event definition (a "none" intermediate throw) ' +
        'fires nothing this tool can represent',
    );
  }
  refuseMultipleEventDefinitions(
    id,
    defs,
    'an emit',
    'escalation, signal, or compensation is supported',
  );

  const [defEl] = defs;
  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    throw new UnsupportedEventFeatureError(
      id,
      'an emit cannot carry an error — BPMN has no intermediate error ' +
        'throw; write "throw error" to end the path instead',
    );
  }
  if (
    defEl.$type !== 'bpmn:EscalationEventDefinition' &&
    defEl.$type !== 'bpmn:SignalEventDefinition' &&
    defEl.$type !== 'bpmn:CompensateEventDefinition'
  ) {
    throw new UnsupportedEventDefinitionError(
      id,
      'intermediate throw',
      defEl.$type,
    );
  }

  const eventDefinition = readThrowEventDefinition(defEl, id, warnings);
  warnGenuineLabel(el, id, 'an emit', warnings);

  return {
    kind: 'intermediateThrowEvent',
    id,
    eventDefinition,
    ...readEngineAttributes(el, id, warnings),
  };
}

function mapIntermediateCatchEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
): IntermediateCatchEvent {
  const id = requireId(el);

  if (el.get('parallelMultiple') === true) {
    throw new UnsupportedEventFeatureError(
      id,
      'an await with parallelMultiple="true" waits for several triggers ' +
        'together — only a single message, timer, signal, or conditional ' +
        'trigger can be awaited',
    );
  }

  const defs = eventDefinitionsOf(el);

  if (defs.length === 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'an await with no event definition (a "none" intermediate catch) ' +
        'waits for nothing this tool can represent',
    );
  }
  refuseMultipleEventDefinitions(
    id,
    defs,
    'an await',
    'message, timer, signal, or conditional trigger can be awaited',
  );

  const [defEl] = defs;
  if (
    defEl.$type !== 'bpmn:MessageEventDefinition' &&
    defEl.$type !== 'bpmn:SignalEventDefinition' &&
    defEl.$type !== 'bpmn:TimerEventDefinition' &&
    defEl.$type !== 'bpmn:ConditionalEventDefinition'
  ) {
    throw new UnsupportedEventFeatureError(
      id,
      `an await cannot carry a ${defEl.$type} — only message, timer, ` +
        'signal, or conditional triggers can be awaited inline; error and ' +
        'escalation are caught by an event handler and raised with ' +
        'throw/emit, compensation is undone by a sub-process block, and ' +
        'link and cancel triggers have no surface',
    );
  }

  // Every kind reaching here is one readCatchEventDefinition maps, so its final
  // refusal is unreachable and the cast holds.
  const eventDefinition = readCatchEventDefinition(
    defEl,
    id,
    warnings,
    'intermediate catch',
  ) as IntermediateCatchEvent['eventDefinition'];
  warnGenuineLabel(el, id, 'an await', warnings);

  return {
    kind: 'intermediateCatchEvent',
    id,
    eventDefinition,
    ...readEngineAttributes(el, id, warnings),
  };
}

/**
 * Refuse any event definition on an ordinary container's start event. An event
 * handler's start goes through {@link mapEventSubProcessStart}, which requires one.
 */
function refuseEventDefinitions(el: ModdleElement, id: string): void {
  const defs = eventDefinitionsOf(el);
  if (defs.length > 0) {
    throw new UnsupportedEventDefinitionError(id, 'start', defs[0].$type);
  }
}

/** Refuse loop characteristics: the IR models elements that run exactly once. */
function refuseLoopCharacteristics(el: ModdleElement, id: string): void {
  const loop = getEl(el, 'loopCharacteristics');
  if (loop !== undefined) {
    throw new UnsupportedLoopCharacteristicsError(id, loop.$type);
  }
}

function mapUserTask(el: ModdleElement, warnings: ImportWarning[]): UserTask {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);
  const assignee = readNamespacedAttr(el, 'assignee');
  const formKey = readNamespacedAttr(el, 'formKey');
  const formFields = readFormFields(el, id, warnings);
  const taskListeners = readTaskListeners(el, id, warnings);
  const candidateGroups = readNamespacedAttr(el, 'candidateGroups');
  const candidateUsers = readNamespacedAttr(el, 'candidateUsers');
  const dueDate = readNamespacedAttr(el, 'dueDate');
  const followUpDate = readNamespacedAttr(el, 'followUpDate');
  const priority = readNamespacedAttr(el, 'priority');

  return {
    kind: 'userTask',
    id,
    ...(name === undefined ? {} : { name }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(formKey === undefined ? {} : { formKey }),
    ...(formFields === undefined ? {} : { formFields }),
    ...(candidateGroups === undefined ? {} : { candidateGroups }),
    ...(candidateUsers === undefined ? {} : { candidateUsers }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(followUpDate === undefined ? {} : { followUpDate }),
    ...(priority === undefined ? {} : { priority }),
    ...(taskListeners === undefined ? {} : { taskListeners }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

function mapServiceTask(
  el: ModdleElement,
  warnings: ImportWarning[],
): ServiceTask {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);
  const resultVariable = readNamespacedAttr(el, 'resultVariable');
  return {
    kind: 'serviceTask',
    id,
    ...(name === undefined ? {} : { name }),
    binding: readServiceTaskBinding(el, id),
    ...(resultVariable === undefined ? {} : { resultVariable }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

function readServiceTaskBinding(
  el: ModdleElement,
  id: string,
): ServiceTaskBinding {
  const className = readNamespacedAttr(el, 'class');
  if (className !== undefined) return { kind: 'class', className };

  const expression = readNamespacedAttr(el, 'expression');
  if (expression !== undefined) return { kind: 'expression', expression };

  const delegate = readNamespacedAttr(el, 'delegateExpression');
  if (delegate !== undefined) {
    return { kind: 'delegateExpression', expression: delegate };
  }

  const topic = readNamespacedAttr(el, 'topic');
  if (readNamespacedAttr(el, 'type') === 'external' && topic !== undefined) {
    return { kind: 'external', topic };
  }

  throw new UnsupportedServiceTaskFormError(
    id,
    detectUnsupportedServiceTaskForm(el),
  );
}

function detectUnsupportedServiceTaskForm(el: ModdleElement): string {
  const type = readNamespacedAttr(el, 'type');
  if (type === 'external') {
    return 'operaton:type="external" without an operaton:topic';
  }
  if (type !== undefined) return `operaton:type="${type}"`;
  return 'no execution discriminator';
}

function mapScriptTask(
  el: ModdleElement,
  warnings: ImportWarning[],
): ScriptTask {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);
  const format = readString(el, 'scriptFormat') ?? '';
  const body = el.get('script');
  const code = typeof body === 'string' ? body : '';
  const resultVariable = readNamespacedAttr(el, 'resultVariable');
  return {
    kind: 'scriptTask',
    id,
    ...(name === undefined ? {} : { name }),
    format,
    code,
    ...(resultVariable === undefined ? {} : { resultVariable }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

/** `default` parses into a moddle reference; only its `id` is kept, so the IR stays strings. */
function mapExclusiveGateway(el: ModdleElement): ExclusiveGateway {
  const id = requireId(el);
  const name = readString(el, 'name');
  const defaultFlowId = getEl(el, 'default')?.id;

  return {
    kind: 'exclusiveGateway',
    id,
    ...(name === undefined ? {} : { name }),
    ...(defaultFlowId === undefined ? {} : { defaultFlowId }),
  };
}

function mapParallelGateway(el: ModdleElement): ParallelGateway {
  const id = requireId(el);
  const name = readString(el, 'name');
  return {
    kind: 'parallelGateway',
    id,
    ...(name === undefined ? {} : { name }),
  };
}

function mapSequenceFlow(el: ModdleElement): SequenceFlow {
  const id = requireId(el);

  const sourceRef = requireFlowEndpoint(el, 'sourceRef', id);
  const targetRef = requireFlowEndpoint(el, 'targetRef', id);

  const expressionEl = el.get('conditionExpression') as
    ModdleElement | undefined;
  const conditionExpression =
    expressionEl !== undefined
      ? ((expressionEl.get('body') as string | undefined) ?? undefined)
      : undefined;

  return {
    id,
    sourceRef,
    targetRef,
    ...(conditionExpression === undefined ? {} : { conditionExpression }),
  };
}

function requireFlowEndpoint(
  el: ModdleElement,
  property: 'sourceRef' | 'targetRef',
  id: string,
): string {
  const endpoint = el.get(property) as ModdleElement | undefined;
  if (endpoint === undefined || endpoint.id === undefined) {
    throw new Error(
      `<bpmn:sequenceFlow id="${id}"> has no resolvable ${property}.`,
    );
  }
  return endpoint.id;
}

function refuseMultipleEventDefinitions(
  id: string,
  defs: ModdleElement[],
  subject: string,
  allowed: string,
): void {
  if (defs.length > 1) {
    throw new UnsupportedEventFeatureError(
      id,
      `${subject} carries ${defs.length} event definitions — only a single ` +
        allowed,
    );
  }
}

function eventDefinitionsOf(el: ModdleElement): ModdleElement[] {
  return (el.get('eventDefinitions') as ModdleElement[] | undefined) ?? [];
}

/** The element's `id`; every flow element in a well-formed BPMN file has one. */
function requireId(el: ModdleElement): string {
  if (el.id === undefined || el.id === '') {
    throw new Error(`<${el.$type}> is missing its required 'id' attribute.`);
  }
  return el.id;
}

/** An element-valued moddle property; moddle reports an absent one as `null`. */
function getEl(el: ModdleElement, name: string): ModdleElement | undefined {
  return (el.get(name) as ModdleElement | null | undefined) ?? undefined;
}

/** A string-valued moddle property, `undefined` when absent, empty, or non-string. */
function readString(el: ModdleElement, name: string): string | undefined {
  const value = el.get(name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a `name`, dropping it when it equals `humanize(id)`: that is the label
 * the export direction derives, so neither the IR nor any DSL printed from it
 * carries it back, which is what makes DSL -> XML -> DSL idempotent.
 */
function readDerivableName(el: ModdleElement, id: string): string | undefined {
  const name = readString(el, 'name');
  return name === undefined || name === humanize(id) ? undefined : name;
}

/**
 * Read an extension attribute under either prefix, `operaton:` winning when
 * both are set. Both lookups go through moddle's `get`, which falls back to the
 * raw `$attrs` map for an undeclared property. That is how `camunda:*` is read
 * without registering the conflicting `camunda-bpmn-moddle` extension.
 */
function readNamespacedAttr(
  el: ModdleElement,
  localName: string,
): string | undefined {
  const operaton = el.get(`operaton:${localName}`);
  if (typeof operaton === 'string' && operaton.length > 0) {
    return operaton;
  }
  const camunda = el.get(`camunda:${localName}`);
  if (typeof camunda === 'string' && camunda.length > 0) {
    return camunda;
  }
  return undefined;
}

function extensionValues(el: ModdleElement): ModdleElement[] {
  const extensionElements = el.get('extensionElements') as
    ModdleElement | undefined;
  if (extensionElements === undefined) return [];
  return (extensionElements.get('values') as ModdleElement[] | undefined) ?? [];
}

function readEngineAttributes(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): EngineAttributes {
  const retryCycleEl = firstExtensionElement(
    el,
    'operaton:FailedJobRetryTimeCycle',
    ownerId,
    warnings,
  );
  return engineAttributes({
    asyncBefore: readNamespacedFlag(el, 'asyncBefore'),
    asyncAfter: readNamespacedFlag(el, 'asyncAfter'),
    exclusive: readNamespacedFlag(el, 'exclusive'),
    jobPriority: readNamespacedAttr(el, 'jobPriority'),
    retryCycle:
      retryCycleEl === undefined ? undefined : readString(retryCycleEl, 'body'),
    executionListeners: readExecutionListeners(el, ownerId, warnings),
  });
}

/**
 * Read a boolean extension attribute under either prefix, `operaton:` winning.
 * The `operaton:` spelling is declared and carries a schema default, so `get`
 * answers with that default for an attribute the document never wrote; only an
 * own property is an authored value. `camunda:` is undeclared and arrives raw.
 */
function readNamespacedFlag(
  el: ModdleElement,
  localName: string,
): boolean | undefined {
  if (Object.prototype.hasOwnProperty.call(el, localName)) {
    const operaton = el.get(`operaton:${localName}`);
    if (typeof operaton === 'boolean') return operaton;
  }
  const camunda = el.get(`camunda:${localName}`);
  if (camunda === 'true') return true;
  if (camunda === 'false') return false;
  return undefined;
}

function readFormFields(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): FormField[] | undefined {
  const formData = firstExtensionElement(
    el,
    'operaton:FormData',
    ownerId,
    warnings,
  );
  if (formData === undefined) {
    return undefined;
  }
  const fields = (formData.get('fields') as ModdleElement[] | undefined) ?? [];
  if (fields.length === 0) {
    return undefined;
  }
  return fields.map((field) => {
    const fieldId = requireId(field);
    const type = importFormFieldType(
      readString(field, 'type'),
      fieldId,
      ownerId,
    );
    const label = readString(field, 'label');
    const defaultValue = readString(field, 'defaultValue');
    return {
      id: fieldId,
      type,
      ...(label === undefined ? {} : { label }),
      ...(defaultValue === undefined ? {} : { defaultValue }),
    };
  });
}

/** Map an `operaton:formField` type to its DSL type, refusing what the DSL lacks. */
function importFormFieldType(
  operatonType: string | undefined,
  fieldId: string,
  ownerId: string,
): FormFieldType {
  const mapped =
    operatonType === undefined
      ? undefined
      : OPERATON_TO_FORM_FIELD_TYPE[operatonType];
  if (mapped === undefined) {
    throw new UnsupportedFormFieldTypeError(
      ownerId,
      fieldId,
      operatonType ?? '(none)',
    );
  }
  return mapped;
}

/**
 * The first `<extensionElements>` child of `type`, reporting each further
 * occurrence as a drop. Operaton reads one per element, and the consumption
 * table answers per `(owner, $type)`, so it would mark every occurrence read.
 */
function firstExtensionElement(
  el: ModdleElement,
  type: string,
  ownerId: string,
  warnings: ImportWarning[],
): ModdleElement | undefined {
  const matches = extensionValues(el).filter((value) => value.$type === type);
  for (let i = 1; i < matches.length; i += 1) {
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `Extra configuration (${type} #${i + 1}) on '${ownerId}' was not ` +
        'imported; only the first one on an element is read.',
    });
  }
  return matches[0];
}

/** Read `operaton:inputOutput` in declaration order, which is Operaton's evaluation order. */
function readIoMapping(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): IoMapped {
  const io = firstExtensionElement(
    el,
    'operaton:InputOutput',
    ownerId,
    warnings,
  );
  if (io === undefined) return {};

  return ioMapped(
    readIoParameters(io, 'input', ownerId),
    readIoParameters(io, 'output', ownerId),
  );
}

function readIoParameters(
  io: ModdleElement,
  direction: 'input' | 'output',
  ownerId: string,
): IoParameter[] {
  const tag = `operaton:${direction}Parameter`;
  const params =
    (io.get(`${direction}Parameters`) as ModdleElement[] | undefined) ?? [];
  const read = params.map((param) => {
    const name = readString(param, 'name');
    if (name === undefined) {
      throw new UnsupportedExtensionFormError(
        ownerId,
        `an ${tag} has no name, so there is nothing to bind its value to`,
      );
    }
    return {
      name,
      value: readParameterValue(param, ownerId, `${tag} '${name}'`),
    };
  });
  refuseRepeatedExtensionKey(
    read.map((param) => param.name),
    ownerId,
    (name) =>
      `two ${tag} children share name="${name}", and one element binds each ` +
      'parameter name once per direction',
  );
  return read;
}

/**
 * Read the value of an `operaton:inputParameter`, `operaton:outputParameter`,
 * or `operaton:entry`: verbatim body text, or exactly one nested value.
 *
 * The moddle descriptor declares the nested value as a repeating property so
 * that body text alongside a nested value, or two nested values, stays visible
 * here; a single-valued property would keep only the last and hide the loss.
 */
function readParameterValue(
  holder: ModdleElement,
  ownerId: string,
  where: string,
): IoValue {
  const text = readString(holder, 'value');
  const nested =
    (holder.get('definitions') as ModdleElement[] | undefined) ?? [];

  if (text !== undefined && nested.length > 0) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `${where} carries both body text and a nested <${nested[0].$type}> ` +
        'value, and a value is one or the other',
    );
  }
  if (nested.length > 1) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `${where} carries ${nested.length} nested values ` +
        `(${nested.map((value) => value.$type).join(', ')}), and a value is one`,
    );
  }
  if (nested.length === 1) {
    return readNestedValue(nested[0], ownerId, where, 'value');
  }
  return { kind: 'text', text: text ?? '' };
}

/**
 * Map one nested `operaton:inputOutput` value, recursing through lists and
 * maps. The moddle descriptor declares both positions as the shared abstract
 * supertype, so an `operaton:entry` parses under a parameter as readily as in
 * an `operaton:map`; `position` is what tells the two apart and refuses the
 * first.
 */
function readNestedValue(
  def: ModdleElement,
  ownerId: string,
  where: string,
  position: 'value' | 'item',
): IoValue {
  switch (def.$type) {
    case 'operaton:List':
      return {
        kind: 'list',
        items: ((def.get('items') as ModdleElement[] | undefined) ?? []).map(
          (item) => readNestedValue(item, ownerId, where, 'item'),
        ),
      };
    case 'operaton:Map':
      return {
        kind: 'map',
        entries: (
          (def.get('entries') as ModdleElement[] | undefined) ?? []
        ).map((entry) => readMapEntry(entry, ownerId, where)),
      };
    case 'operaton:Script':
      return readScriptValue(def, ownerId, `the operaton:script in ${where}`);
    case 'operaton:Value':
      if (position === 'item') {
        return { kind: 'text', text: readString(def, 'value') ?? '' };
      }
      break;
    default:
      break;
  }
  throw new UnsupportedExtensionFormError(
    ownerId,
    position === 'item'
      ? `an operaton:list in ${where} carries a <${def.$type}>; a list holds ` +
          'values, and an entry belongs in an operaton:map'
      : `${where} carries a <${def.$type}> where a value belongs; an entry ` +
          'belongs in an operaton:map',
  );
}

function readMapEntry(
  entry: ModdleElement,
  ownerId: string,
  where: string,
): { key: string; value: IoValue } {
  const key = readString(entry, 'key');
  if (key === undefined) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `an operaton:entry in ${where} has no key, so there is nothing to look ` +
        'its value up by',
    );
  }
  return {
    key,
    value: readParameterValue(
      entry,
      ownerId,
      `operaton:entry '${key}' in ${where}`,
    ),
  };
}

function readScriptValue(
  script: ModdleElement,
  ownerId: string,
  where: string,
): ScriptValue {
  const resource = readString(script, 'resource');
  if (resource !== undefined) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `${where} names an external resource ("${resource}"); only an inline ` +
        'script body can be written here',
    );
  }
  const format = readString(script, 'scriptFormat');
  if (format === undefined) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `${where} has no scriptFormat, so there is no language to evaluate its ` +
        'body in',
    );
  }
  return { kind: 'script', format, code: readString(script, 'value') ?? '' };
}

const EXECUTION_LISTENER_EVENTS = ['start', 'end'] as const;

const TASK_LISTENER_EVENTS = [
  'create',
  'assign',
  'complete',
  'update',
  'delete',
  'timeout',
] as const;

interface ListenerSpec<E extends string> {
  type: string;
  tag: string;
  events: readonly E[];
  ownerId: string;
  warnings: ImportWarning[];
}

/**
 * Read the listener children of one kind in emission order. Members are read in
 * the order they are refused in: the event, then `extra`, then the binding.
 */
function readListeners<E extends string, X extends object>(
  el: ModdleElement,
  spec: ListenerSpec<E>,
  extra: (listener: ModdleElement, event: E) => X,
): ({ event: E; binding: ListenerBinding } & X)[] | undefined {
  const found = extensionValues(el).filter(
    (value) => value.$type === spec.type,
  );
  if (found.length === 0) return undefined;

  const listeners = found.map((listener) => {
    const event = readListenerEvent(listener, spec);
    const rest = extra(listener, event);
    return { event, binding: readListenerBinding(listener, spec), ...rest };
  });
  refuseRepeatedExtensionKey(
    listeners.map((listener) => listener.event),
    spec.ownerId,
    (event) =>
      `two ${spec.tag} children share event="${event}", and one element ` +
      'writes each listener event once',
  );
  return listeners;
}

function readExecutionListeners(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): ExecutionListener[] | undefined {
  return readListeners(
    el,
    {
      type: 'operaton:ExecutionListener',
      tag: 'operaton:executionListener',
      events: EXECUTION_LISTENER_EVENTS,
      ownerId,
      warnings,
    },
    () => ({}),
  );
}

/** A user task's `operaton:taskListener` children; a `timeout` also carries its timer. */
function readTaskListeners(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): TaskListener[] | undefined {
  return readListeners(
    el,
    {
      type: 'operaton:TaskListener',
      tag: 'operaton:taskListener',
      events: TASK_LISTENER_EVENTS,
      ownerId,
      warnings,
    },
    (listener, event) => {
      const timer = readListenerTimer(listener, ownerId, event);
      return timer === undefined ? {} : { timer };
    },
  );
}

function readListenerEvent<E extends string>(
  listener: ModdleElement,
  spec: ListenerSpec<E>,
): E {
  const event = readString(listener, 'event');
  if (event === undefined) {
    throw new UnsupportedExtensionFormError(
      spec.ownerId,
      `an ${spec.tag} has no event, so there is no point in the lifecycle ` +
        'for it to fire at',
    );
  }
  if (!(spec.events as readonly string[]).includes(event)) {
    throw new UnsupportedExtensionFormError(
      spec.ownerId,
      `an ${spec.tag} has event="${event}", which is not one of ` +
        spec.events.join(', '),
    );
  }
  return event as E;
}

/**
 * Resolve the single executable binding a listener names. Every alternative is
 * read before any is acted on: naming two leaves the engine to pick, naming
 * none never runs, so both refuse.
 */
function readListenerBinding(
  listener: ModdleElement,
  spec: ListenerSpec<string>,
): ListenerBinding {
  const { ownerId, tag, warnings } = spec;
  const className = readString(listener, 'class');
  const expression = readString(listener, 'expression');
  const delegate = readString(listener, 'delegateExpression');
  const script = getEl(listener, 'script');

  const present = [
    ...(className === undefined ? [] : ['class']),
    ...(expression === undefined ? [] : ['expression']),
    ...(delegate === undefined ? [] : ['delegateExpression']),
    ...(script === undefined ? [] : ['an operaton:script child']),
  ];
  if (present.length > 1) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `an ${tag} carries ${present.length} bindings (${present.join(', ')}), ` +
        'and a listener names exactly one',
    );
  }

  warnFieldDrops(listener, ownerId, `an ${tag} on '${ownerId}'`, warnings);

  if (className !== undefined) return { kind: 'class', className };
  if (expression !== undefined) return { kind: 'expression', expression };
  if (delegate !== undefined) {
    return { kind: 'delegateExpression', expression: delegate };
  }
  if (script !== undefined) {
    return readScriptValue(script, ownerId, `the operaton:script in an ${tag}`);
  }
  throw new UnsupportedExtensionFormError(
    ownerId,
    `an ${tag} carries no binding: one of class, expression, ` +
      'delegateExpression, or an operaton:script child is what it runs',
  );
}

function readListenerTimer(
  listener: ModdleElement,
  ownerId: string,
  event: (typeof TASK_LISTENER_EVENTS)[number],
): Extract<EventDefinition, { kind: 'timer' }> | undefined {
  const defs = eventDefinitionsOf(listener);

  if (event !== 'timeout') {
    if (defs.length > 0) {
      throw new UnsupportedExtensionFormError(
        ownerId,
        `an operaton:taskListener with event="${event}" carries a ` +
          `${defs[0].$type}, which only a timeout listener takes`,
      );
    }
    return undefined;
  }
  if (defs.length === 0) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      'an operaton:taskListener with event="timeout" carries no ' +
        'bpmn:timerEventDefinition, so nothing would ever fire it',
    );
  }
  if (defs.length > 1) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `an operaton:taskListener with event="timeout" carries ${defs.length} ` +
        'bpmn:timerEventDefinition children, and a timeout has one due time',
    );
  }
  return { kind: 'timer', ...readTimerDefinition(defs[0], ownerId) };
}

/**
 * Refuse two pieces of extension content on one element sharing the word that
 * tells them apart. This surface writes each as the word it repeats, so the
 * second has nowhere to go: importing it would produce a process that cannot be
 * written back, dropping it would change what the element runs.
 */
function refuseRepeatedExtensionKey(
  keys: readonly string[],
  ownerId: string,
  detail: (key: string) => string,
): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new UnsupportedExtensionFormError(ownerId, detail(key));
    }
    seen.add(key);
  }
}

/**
 * Report every `operaton:field` child as a drop. Field injection sets a
 * property on the bound class or expression before it runs, and the IR has no
 * surface for it.
 */
function warnFieldDrops(
  carrier: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): void {
  const fields = (carrier.get('fields') as ModdleElement[] | undefined) ?? [];
  for (const field of fields) {
    warnFieldDrop(field, ownerId, where, warnings);
  }
}

/** Report one `operaton:field` as a drop; see {@link warnFieldDrops}. */
function warnFieldDrop(
  field: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): void {
  const name = readString(field, 'name');
  warnings.push({
    elementId: ownerId,
    category: 'extensionAttribute',
    message:
      `The injected field ${name === undefined ? '(unnamed)' : `'${name}'`} ` +
      `on ${where} was not imported; field injection is not carried.`,
  });
}
