/**
 * IR → BPMN 2.0 XML transform.
 *
 * Takes a {@link BpmnProcess} and produces a BPMN 2.0
 * XML string that Operaton can parse and deploy. The Operaton extension
 * namespace (`operaton:`) is attached at serialization time via the
 * local `operaton-moddle.json` extension — the IR itself stays
 * vendor-neutral per ADR 0006.
 *
 * Pipeline:
 *   1. Build a `bpmn-moddle` instance with the local Operaton extension.
 *   2. Construct a `bpmn:Definitions` tree containing one `bpmn:Process`.
 *   3. Map each {@link FlowElement} / {@link SequenceFlow} to its moddle
 *      counterpart, including Operaton extension attributes.
 *   4. Compute and attach `<bpmn:incoming>` / `<bpmn:outgoing>` references
 *      on every flow node (MIWG-compliant; required by Operaton Modeler).
 *   5. If the process contains at least one sub-process, attach a minimal
 *      `bpmndi:BPMNShape isExpanded="true"` hint per sub-process (see
 *      {@link buildSubProcessExpansionHint} and ADR 0015) so that step 7 lays
 *      its children out inside its bounds instead of scattering them.
 *   6. Serialize via `moddle.toXML(..., { format: true })`.
 *   7. Pass the string through `bpmn-auto-layout` to inject `bpmndi:`
 *      diagram-interchange data (ADR 0003: DI regenerated on export).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join } from 'node:path';

import {
  BpmnModdle,
  type BpmnModdleInstance,
  type ModdleElement,
} from 'bpmn-moddle';
import { layoutProcess } from 'bpmn-auto-layout';

import { humanize } from './humanize.js';
import { resolveCollision } from './synthesize-ids.js';
import type {
  BpmnProcess,
  CallActivity,
  CallVariableMapping,
  EventDefinition,
  FlowContainer,
  FlowElement,
  FormField,
  FormFieldType,
  SequenceFlow,
} from './ir/types.js';

/**
 * Stable project-local namespace for all generated processes. Operaton
 * uses this only as an opaque identifier; it does not need to resolve.
 */
const TARGET_NAMESPACE = 'http://bpmnscript.io/processes';

/**
 * Constant `operaton:historyTimeToLive` emitted on every process:
 * thirty-day retention, not parameterised at the IR level. Exported so the
 * importer can stay silent when a document carries exactly this value —
 * re-export reproduces it, so no information is lost.
 */
export const HISTORY_TIME_TO_LIVE = 'P30D';

/**
 * Load the local Operaton moddle extension at module-init time. Read via
 * `fs.readFileSync` rather than an `import ... with { type: 'json' }`
 * attribute so the package compiles cleanly under TypeScript's
 * `NodeNext` resolution without requiring `resolveJsonModule`.
 *
 * The JSON file lives in `src/` only — the package `build` script does
 * not copy it into `out/`. To stay correct in both contexts (vitest
 * running source directly, and consumers importing the compiled `out/`
 * tree) we look for the file next to the current module first, then
 * fall back to `../src/` relative to the module location.
 */
const operatonModdleExtension: unknown = JSON.parse(
  readFileSync(resolveOperatonModdlePath(), 'utf-8'),
);

/**
 * Resolve the path to `operaton-moddle.json`. Tried locations, in order:
 *
 *   1. `./operaton-moddle.json`   — vitest reads source directly.
 *   2. `../src/operaton-moddle.json` — compiled `out/` consumer.
 */
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
 * Serialize an IR process to a BPMN 2.0 XML string with diagram
 * interchange data.
 *
 * @param process The IR process to serialize.
 * @param options Optional metadata for the BPMN definitions element.
 * @returns A full BPMN XML document (with `bpmndi:` layout) ready for
 *   deployment to an Operaton engine.
 */
export interface IrToXmlOptions {
  sourceFileName?: string;
  exporterVersion?: string;
}

export async function irToXml(
  process: BpmnProcess,
  options?: IrToXmlOptions,
): Promise<string> {
  const moddle = new BpmnModdle({
    operaton: operatonModdleExtension as Record<string, unknown>,
  });

  // Synthesize the document-level error/escalation root elements from usage
  // before building the process, so each catch/throw can wire its
  // `errorRef`/`escalationRef` to the shared root as it is created.
  const roots = synthesizeRootElements(moddle, process);

  // Assemble the process and the definitions root. The process is one
  // FlowContainer; its ordered moddle children (nodes then flows, with
  // incoming/outgoing and gateway defaults wired) are built by the shared
  // per-container pass, which recurses through any nested sub-process.
  const processAttrs: Record<string, unknown> = {
    id: process.id,
    // The process is always labelable: when no explicit name is carried in the
    // IR, derive a human-readable one from the id so the BPMN stays meaningful.
    name: process.name ?? humanize(process.id),
    isExecutable: process.isExecutable,
    'operaton:historyTimeToLive': HISTORY_TIME_TO_LIVE,
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
    // The process first (today's output shape), then the synthesized root
    // elements grouped by kind: errors, escalations, messages, signals.
    rootElements: [
      processElement,
      ...roots.errorElements,
      ...roots.escalationElements,
      ...roots.messageElements,
      ...roots.signalElements,
    ],
    ...(diagrams.length > 0 ? { diagrams } : {}),
  });

  // Serialize. `format: true` produces indented output; the formatted
  // XML is then handed to bpmn-auto-layout, which re-serializes with
  // its own formatting, so the intermediate formatting is purely a
  // debugging aid.
  const { xml } = await moddle.toXML(definitions, { format: true });

  // Apply auto-layout to generate `bpmndi:` data. This returns a new
  // XML string with a `<bpmndi:BPMNDiagram>` block injected.
  const xmlWithDi = await layoutProcess(xml);

  return xmlWithDi;
}

/**
 * The synthesized document-level root elements, plus lookups for wiring each
 * event definition's reference to the shared root.
 *
 * Error and escalation roots are keyed by code; message and signal roots by
 * name. All uses of one code (or one name) share a single root element — BPMN
 * puts error/escalation/message/signal definitions at `bpmn:Definitions` level,
 * deduped by that identity — so a code or name maps to exactly one element here.
 */
interface RootElementIndex {
  errorElements: ModdleElement[];
  escalationElements: ModdleElement[];
  messageElements: ModdleElement[];
  signalElements: ModdleElement[];
  errorByCode: Map<string, ModdleElement>;
  escalationByCode: Map<string, ModdleElement>;
  messageByName: Map<string, ModdleElement>;
  signalByName: Map<string, ModdleElement>;
}

/**
 * Build the document-level `bpmn:Error`/`bpmn:Escalation`/`bpmn:Message`/
 * `bpmn:Signal` root elements from usage. The root elements are not modeled in
 * the IR: event definitions carry their codes/names inline, and the roots are
 * derived here from where those identities appear (the
 * `operaton:historyTimeToLive` precedent — vendor/serialization concerns attach
 * at the transform).
 *
 * Collection order: a single depth-first walk over every container collects the
 * distinct error/escalation codes and message/signal names in first-appearance
 * order, then any `errorMessages` code not yet seen (a declared code emits its
 * root even when otherwise unused — the declaration is explicit authorial
 * intent). Catch-all error/escalation definitions (no code) contribute no root;
 * message/signal names are always present (the surface requires them);
 * compensation contributes no root at all — it is payload-less, so there is no
 * identity to synthesize one from.
 *
 * Ids: `Error_<code>` / `Escalation_<code>` / `Message_<name>` / `Signal_<name>`
 * with any character outside `[A-Za-z0-9_.-]` replaced by `_`. Collisions — two
 * identities sanitizing identically, or a sanitized id clashing with any element
 * id already in the document — get `_2`, `_3`, … in synthesis order (errors,
 * then escalations, then messages, then signals). The root `name` carries the
 * code/name verbatim; `errorCode`/`escalationCode` carry the code; a declared
 * error message is stamped as `operaton:errorMessage`.
 */
function synthesizeRootElements(
  moddle: BpmnModdleInstance,
  process: BpmnProcess,
): RootElementIndex {
  const errorCodes: string[] = [];
  const escalationCodes: string[] = [];
  const messageNames: string[] = [];
  const signalNames: string[] = [];
  for (const def of collectEventDefinitions(process)) {
    switch (def.kind) {
      case 'error':
        if (
          def.errorCode !== undefined &&
          !errorCodes.includes(def.errorCode)
        ) {
          errorCodes.push(def.errorCode);
        }
        break;
      case 'escalation':
        if (
          def.escalationCode !== undefined &&
          !escalationCodes.includes(def.escalationCode)
        ) {
          escalationCodes.push(def.escalationCode);
        }
        break;
      case 'message':
        if (!messageNames.includes(def.messageName)) {
          messageNames.push(def.messageName);
        }
        break;
      case 'signal':
        if (!signalNames.includes(def.signalName)) {
          signalNames.push(def.signalName);
        }
        break;
      case 'compensation':
        // No document-level element exists for compensation.
        break;
      default:
        // Timer and conditional carry their payloads inline; no root element.
        break;
    }
  }
  const messageByCode = new Map(
    (process.errorMessages ?? []).map((m) => [m.code, m.message]),
  );
  for (const code of messageByCode.keys()) {
    if (!errorCodes.includes(code)) errorCodes.push(code);
  }

  // Seed the collision set with every id already present in the document so a
  // synthesized root id never shadows a flow node, flow, or container id.
  const taken = new Set<string>();
  collectElementIds(process, taken);

  const errorElements: ModdleElement[] = [];
  const errorByCode = new Map<string, ModdleElement>();
  for (const code of errorCodes) {
    const id = resolveCollision(sanitizeRootId('Error_', code), taken);
    taken.add(id);
    const attrs: Record<string, unknown> = { id, name: code, errorCode: code };
    const message = messageByCode.get(code);
    if (message !== undefined) attrs['operaton:errorMessage'] = message;
    const element = moddle.create('bpmn:Error', attrs);
    errorElements.push(element);
    errorByCode.set(code, element);
  }

  const escalationElements: ModdleElement[] = [];
  const escalationByCode = new Map<string, ModdleElement>();
  for (const code of escalationCodes) {
    const id = resolveCollision(sanitizeRootId('Escalation_', code), taken);
    taken.add(id);
    const element = moddle.create('bpmn:Escalation', {
      id,
      name: code,
      escalationCode: code,
    });
    escalationElements.push(element);
    escalationByCode.set(code, element);
  }

  const { elements: messageElements, byName: messageByName } =
    synthesizeNamedRoots(
      moddle,
      'bpmn:Message',
      'Message_',
      messageNames,
      taken,
    );
  const { elements: signalElements, byName: signalByName } =
    synthesizeNamedRoots(moddle, 'bpmn:Signal', 'Signal_', signalNames, taken);

  return {
    errorElements,
    escalationElements,
    messageElements,
    signalElements,
    errorByCode,
    escalationByCode,
    messageByName,
    signalByName,
  };
}

/**
 * Build the name-keyed `bpmn:Message` / `bpmn:Signal` roots for a set of
 * distinct names in first-appearance order. Each root carries a sanitized,
 * collision-suffixed id (`<prefix><sanitized name>`) and the name verbatim; the
 * name is the engine-side identity, so every use of one name shares this one
 * root. `taken` is threaded through so ids stay document-wide unique.
 */
function synthesizeNamedRoots(
  moddle: BpmnModdleInstance,
  type: 'bpmn:Message' | 'bpmn:Signal',
  prefix: string,
  names: string[],
  taken: Set<string>,
): { elements: ModdleElement[]; byName: Map<string, ModdleElement> } {
  const elements: ModdleElement[] = [];
  const byName = new Map<string, ModdleElement>();
  for (const name of names) {
    const id = resolveCollision(sanitizeRootId(prefix, name), taken);
    taken.add(id);
    const element = moddle.create(type, { id, name });
    elements.push(element);
    byName.set(name, element);
  }
  return { elements, byName };
}

/** Prefix + code with non-id characters replaced by `_` (an XML-safe id). */
function sanitizeRootId(prefix: string, code: string): string {
  return prefix + code.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Depth-first collect every event definition carried by a start event, end
 * event, boundary event, intermediate throw, or intermediate catch anywhere
 * under a container (recursing into sub-processes), in first-appearance
 * order. A boundary event's or intermediate catch's code/name must be
 * collected here exactly like a handler start's: it shares the same
 * document-level `bpmn:Error`/`bpmn:Escalation`/`bpmn:Message`/`bpmn:Signal`
 * root as every other catch or throw of that identity, so a message caught
 * by an `await` and one caught by a host-less handler reference one root,
 * not two.
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

/**
 * Collect every id that occupies the document's id space — the container id,
 * every flow node id (recursing into sub-processes), and every sequence flow
 * id — so synthesized root-element ids can be checked against them.
 */
function collectElementIds(container: FlowContainer, into: Set<string>): void {
  into.add(container.id);
  for (const el of container.flowElements) {
    into.add(el.id);
    if (el.kind === 'subProcess') collectElementIds(el, into);
  }
  for (const flow of container.sequenceFlows) into.add(flow.id);
}

/**
 * Build the concrete `bpmn:*EventDefinition` for one IR {@link EventDefinition}:
 *   - `error`/`escalation` — the `errorRef`/`escalationRef` is wired to the
 *     shared root (omitted for a catch-all, so a ref-less definition catches
 *     any code); catch bindings become the Operaton
 *     `errorCodeVariable`/`errorMessageVariable`/`escalationCodeVariable`
 *     attributes when set (the moddle fork resolves these onto the definition).
 *   - `message`/`signal` — the `messageRef`/`signalRef` is wired to the shared
 *     name-keyed root (all uses of one name reference the same root).
 *   - `compensation` — a `bpmn:CompensateEventDefinition` with no properties at
 *     all: the moddle schema defaults `waitForCompletion` to `true`, the only
 *     value Operaton supports, and there is no code to wire a ref for, so the
 *     element serializes as the bare `<bpmn:compensateEventDefinition />`.
 *   - `timer` — a `bpmn:TimerEventDefinition` with exactly one child
 *     (`timeDuration`/`timeDate`/`timeCycle` per `timerKind`), a
 *     `bpmn:FormalExpression` whose `body` is the verbatim time text.
 *   - `conditional` — a `bpmn:ConditionalEventDefinition` whose `condition` is a
 *     `bpmn:FormalExpression` carrying the raw `${…}` body (the
 *     `conditionExpression` precedent).
 */
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
      // No properties: the moddle schema defaults `waitForCompletion` to
      // `true` (the only value Operaton supports), and compensation carries
      // no code or ref, so the bare element is the whole definition.
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

/**
 * The `bpmn:TimerEventDefinition` child element that carries each timer kind:
 * a duration, a fixed date, or a repeating cycle, mapped 1:1 to the three BPMN
 * time forms.
 */
const TIMER_KIND_TO_CHILD: Record<
  Extract<EventDefinition, { kind: 'timer' }>['timerKind'],
  'timeDuration' | 'timeDate' | 'timeCycle'
> = {
  duration: 'timeDuration',
  date: 'timeDate',
  cycle: 'timeCycle',
};

/**
 * Author a minimal diagram-interchange hint so `bpmn-auto-layout` expands
 * every sub-process instead of laying it out collapsed (ADR 0015).
 *
 * Fed DI-less XML containing a `bpmn:SubProcess`, `bpmn-auto-layout` renders
 * a collapsed parent box and scatters shapes for the nested children into the
 * root plane at coordinates that duplicate unrelated top-level elements. The
 * library reads the `isExpanded` boolean off a pre-existing
 * `bpmndi:BPMNShape` for a given element and propagates it onto that
 * element before laying out — any bounds supplied here are recomputed and
 * discarded — but it only finds the shape at all by looking it up in its own
 * id-keyed element index, so every shape needs an `id` even though nothing
 * ever references it back. One shape per sub-process at any nesting depth,
 * referencing the process as its plane's root element.
 *
 * Returns an empty array when the process has no sub-process anywhere, so
 * `irToXml` omits the `diagrams` property entirely and sub-process-free
 * output stays byte-identical.
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

/**
 * Recursively collect every `bpmn:SubProcess` moddle element under a
 * container's `flowElements`, at any nesting depth (depth-first,
 * outer-before-inner).
 */
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
 * Build the ordered moddle children of one {@link FlowContainer} — a process
 * or a sub-process body — with all references wired.
 *
 * Runs the same four passes for every container:
 *   - Pass 1: create a moddle element for each flow node and sequence flow,
 *     held by id so references can be wired.
 *   - Pass 2: attach `<bpmn:incoming>` / `<bpmn:outgoing>` on every flow node
 *     (MIWG requires them; bpmn-moddle does not auto-derive them).
 *   - Pass 3: attach the gateway `default` references (these need the
 *     SequenceFlow moddle objects, so they run after pass 1).
 *   - Pass 4: attach each boundary event's `attachedToRef` to its host's
 *     moddle element — the identical deferred-wiring constraint pass 3
 *     already solves: the reference must be a moddle object, not a raw id
 *     string, and the host's element only exists once pass 1 has built every
 *     node in this container.
 *
 * The returned array preserves the container's own order: every flow node
 * first (in `flowElements` order), then every sequence flow (in
 * `sequenceFlows` order).
 *
 * A nested sub-process node reaches this function again through
 * {@link createFlowNode} (mutual recursion), building its body into its own
 * maps; the parent never sees the child's nodes or flows.
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

/**
 * Build a single flow-node moddle element for one IR FlowElement.
 * Operaton extension attributes are attached using the namespace-qualified
 * property names defined in `operaton-moddle.json`.
 */
function createFlowNode(
  moddle: BpmnModdleInstance,
  node: FlowElement,
  roots: RootElementIndex,
): ModdleElement {
  const baseAttrs: Record<string, unknown> = { id: node.id };
  // Derive a human-readable `name` from the id for labelable nodes when the IR
  // carries none. Gateways and start/end events are excluded: their ids are
  // synthesized structural coordinates (e.g. `Gateway_…_split`,
  // `StartEvent_<processId>`) that would humanize to noise, and such elements
  // are conventionally unnamed. An intermediate throw, an intermediate catch,
  // a boundary event, and an event sub-process are excluded too: their
  // surface (`emit`, `await`, `on`) carries no label slot, so a humanized
  // name would be spurious — a boundary event's id is a synthesized
  // structural coordinate (`Boundary_<hostId>_<trigger>`) exactly like a
  // gateway's, and the type carries no `name` field at all. Explicit names
  // from the IR are always kept (a plain sub-process still humanizes so
  // viewers label the expanded box).
  const derivedName =
    node.kind === 'intermediateThrowEvent' ||
    node.kind === 'intermediateCatchEvent' ||
    node.kind === 'boundaryEvent'
      ? undefined
      : (node.name ??
        (node.kind === 'exclusiveGateway' ||
        node.kind === 'parallelGateway' ||
        node.kind === 'startEvent' ||
        node.kind === 'endEvent' ||
        (node.kind === 'subProcess' && node.triggeredByEvent === true)
          ? undefined
          : humanize(node.id)));
  if (derivedName !== undefined) {
    baseAttrs.name = derivedName;
  }

  switch (node.kind) {
    case 'startEvent': {
      const attrs: Record<string, unknown> = { ...baseAttrs };
      if (node.formFields !== undefined) {
        attrs.extensionElements = buildFormExtension(moddle, node.formFields);
      }
      if (node.eventDefinition !== undefined) {
        attrs.eventDefinitions = [
          buildEventDefinition(moddle, node.eventDefinition, roots),
        ];
      }
      // BPMN defaults to interrupting; store the attribute only for the
      // non-default `alongside` handler start (the serializer drops the default).
      if (node.isInterrupting === false) {
        attrs.isInterrupting = false;
      }
      return moddle.create('bpmn:StartEvent', attrs);
    }

    case 'endEvent': {
      const attrs: Record<string, unknown> = { ...baseAttrs };
      if (node.eventDefinition !== undefined) {
        attrs.eventDefinitions = [
          buildEventDefinition(moddle, node.eventDefinition, roots),
        ];
      }
      return moddle.create('bpmn:EndEvent', attrs);
    }

    case 'intermediateThrowEvent':
      // An `emit` fires the event and lets flow continue: incoming/outgoing are
      // wired generically by `attachIncomingOutgoing`, exactly as for a task.
      return moddle.create('bpmn:IntermediateThrowEvent', {
        ...baseAttrs,
        eventDefinitions: [
          buildEventDefinition(moddle, node.eventDefinition, roots),
        ],
      });

    case 'intermediateCatchEvent':
      // An `await` blocks on the main flow until the trigger fires, then
      // continues: incoming/outgoing are wired generically by
      // `attachIncomingOutgoing`, exactly as for a task or an intermediate
      // throw.
      return moddle.create('bpmn:IntermediateCatchEvent', {
        ...baseAttrs,
        eventDefinitions: [
          buildEventDefinition(moddle, node.eventDefinition, roots),
        ],
      });

    case 'boundaryEvent': {
      // `attachedToRef` is wired in a deferred pass (`attachBoundaryHosts`,
      // below) once every node in this container has a moddle element to
      // reference — not here, where only this node's own element exists.
      // Incoming/outgoing are wired generically by `attachIncomingOutgoing`;
      // a well-formed boundary event ends up with an empty `incoming` (it is
      // never the target of a sequence flow) and one or more `outgoing`.
      const attrs: Record<string, unknown> = {
        ...baseAttrs,
        eventDefinitions: [
          buildEventDefinition(moddle, node.eventDefinition, roots),
        ],
      };
      // BPMN defaults a boundary event to interrupting; store the attribute
      // only for the non-default `alongside` boundary (the serializer drops
      // the default), mirroring the handler-start `isInterrupting` treatment.
      if (node.cancelActivity === false) {
        attrs.cancelActivity = false;
      }
      return moddle.create('bpmn:BoundaryEvent', attrs);
    }

    case 'userTask': {
      const attrs: Record<string, unknown> = { ...baseAttrs };
      if (node.assignee !== undefined) {
        attrs['operaton:assignee'] = node.assignee;
      }
      if (node.formKey !== undefined) {
        attrs['operaton:formKey'] = node.formKey;
      }
      if (node.formFields !== undefined) {
        attrs.extensionElements = buildFormExtension(moddle, node.formFields);
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
          // Exhaustiveness check — every variant of ServiceTaskBinding is
          // handled.
          const exhaustive: never = node.binding;
          throw new Error(
            `Unhandled ServiceTaskBinding kind: ${JSON.stringify(exhaustive)}`,
          );
        }
      }
      return moddle.create('bpmn:ServiceTask', attrs);
    }

    case 'scriptTask': {
      const attrs: Record<string, unknown> = {
        ...baseAttrs,
        scriptFormat: node.format,
        script: node.code,
      };
      return moddle.create('bpmn:ScriptTask', attrs);
    }

    case 'exclusiveGateway':
      // The `default` reference is wired up in a second pass — see
      // attachGatewayDefaults — because it needs the SequenceFlow
      // moddle objects to exist.
      return moddle.create('bpmn:ExclusiveGateway', baseAttrs);

    case 'parallelGateway':
      // Parallel gateways carry no `default` attribute — every outgoing
      // path is executed unconditionally. Incoming/outgoing wiring is
      // handled generically by `attachIncomingOutgoing` below.
      return moddle.create('bpmn:ParallelGateway', baseAttrs);

    case 'subProcess': {
      // An embedded sub-process is an activity whose body is a nested
      // container. Its children are built by the same per-container pass
      // (mutual recursion); the parent's incoming/outgoing into this
      // sub-process node are wired generically by `attachIncomingOutgoing`,
      // exactly as for any other activity. A plain sub-process carries a
      // humanized `name` (via the derived-name path above) so viewers label the
      // expanded box; an event sub-process (`triggeredByEvent`) is unlabeled and
      // has no flow connections — it is triggered by its start event's caught
      // error/escalation.
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
      // A call activity invokes another process by id. `calledElement` is a
      // core BPMN attribute; the version-resolution strategy is carried by the
      // Operaton `calledElementBinding`/`calledElementVersion` attributes.
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
      // Business key and variable mappings are extension-element children, not
      // attributes. They emit in one canonical order so the round-trip is
      // stable: the business-key `in`, then the in-mappings, then the
      // out-mappings.
      const values = buildCallExtensionValues(moddle, node);
      if (values.length > 0) {
        attrs.extensionElements = moddle.create('bpmn:ExtensionElements', {
          values,
        });
      }
      return moddle.create('bpmn:CallActivity', attrs);
    }

    default: {
      // Exhaustiveness check — every variant of FlowElement is handled.
      const exhaustive: never = node;
      throw new Error(
        `Unhandled FlowElement kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * DSL-level form field type mapped to the `operaton:formField` `type`
 * attribute. `number` becomes `long`; keeping this mapping at the
 * serialization boundary lets the IR spelling stay vendor-neutral (ADR 0006).
 */
const FORM_FIELD_TYPE_TO_OPERATON: Record<FormFieldType, string> = {
  string: 'string',
  number: 'long',
  boolean: 'boolean',
  date: 'date',
};

/**
 * Build a `<bpmn:extensionElements>` wrapper holding one `<operaton:formData>`
 * with an `<operaton:formField>` per IR {@link FormField}. Attached to the
 * owning start event or user task so Operaton Tasklist renders a labeled form.
 */
function buildFormExtension(
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
  const formData = moddle.create('operaton:FormData', { fields });
  return moddle.create('bpmn:ExtensionElements', { values: [formData] });
}

/**
 * Build the ordered `extensionElements` children of a {@link CallActivity} in
 * canonical order: a single `operaton:in` carrying the business key (when set),
 * then one `operaton:in` per in-mapping in IR order, then one `operaton:out`
 * per out-mapping in IR order. Returns an empty array when the call activity
 * carries no business key and no mappings, so the caller omits the
 * `extensionElements` wrapper entirely.
 */
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

/**
 * Map one {@link CallVariableMapping} to the attributes of its
 * `operaton:in` / `operaton:out` element: `all` copies every variable
 * (`variables="all"`), `variable` copies one named source into a target, and
 * `expression` evaluates a source expression into a target. `local="true"` is
 * added only when the mapping is scope-local.
 */
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

/**
 * The diagram label for a conditioned flow: the condition with its `${…}` EL
 * delimiters removed (`${amount > 1000}` → `amount > 1000`). A condition body is
 * always delimited; the regex leaves anything else untouched as a safe fallback.
 */
function conditionLabel(conditionExpression: string): string {
  return conditionExpression.replace(/^\$\{([\s\S]*)\}$/, '$1');
}

/**
 * Build a single `bpmn:SequenceFlow` moddle element. `sourceRef` and
 * `targetRef` are wired as moddle-element references (not raw ids) so
 * the writer can serialize them correctly.
 *
 * `conditionExpression` is wrapped in a `bpmn:FormalExpression` whose
 * `body` carries the raw expression text. The body is passed through
 * verbatim — bpmn-moddle's XML writer escapes XML entities itself
 * (`>` becomes `&gt;` etc.).
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
    // Label the flow with its condition so the routing is readable on the
    // generated diagram's canvas — viewers render a flow's `name`, not its
    // `conditionExpression`. The label drops the `${…}` EL delimiters, which
    // only matter for execution.
    attrs.name = conditionLabel(flow.conditionExpression);
    attrs.conditionExpression = moddle.create('bpmn:FormalExpression', {
      body: flow.conditionExpression,
    });
  }
  return moddle.create('bpmn:SequenceFlow', attrs);
}

/**
 * For each flow node, attach the SequenceFlow moddle elements whose
 * `sourceRef` / `targetRef` point at it as `outgoing` / `incoming`
 * children. The order follows the order in which sequence flows appear
 * in `process.sequenceFlows`, so the output is deterministic.
 */
function attachIncomingOutgoing(
  container: FlowContainer,
  flowNodeById: Map<string, ModdleElement>,
  sequenceFlowById: Map<string, ModdleElement>,
): void {
  // Initialise empty incoming/outgoing on every node.
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

/**
 * Wire up the `bpmn:default` attribute on every gateway that has a
 * `defaultFlowId`. The attribute is a reference to the SequenceFlow
 * moddle element, not a raw id.
 */
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
 * Wire the `attachedToRef` reference on every boundary event to its host's
 * moddle element. Deferred to run after pass 1 has built every node in this
 * container — the identical constraint {@link attachGatewayDefaults} already
 * solves for a gateway's `default` flow: the reference must be a moddle
 * object, not the raw id string the IR carries, so it cannot be assigned
 * while {@link createFlowNode} is still building the boundary event's own
 * element. A host id that resolves to nothing in this container is an
 * internal bug (the desugarer only ever emits a boundary event alongside its
 * host, in the same container), not a user error, so it throws rather than
 * silently dropping the reference.
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

/**
 * Helper used in several places: look up a moddle element by id and
 * throw with a clear message if it is absent (every consumer of the
 * map has invariants that guarantee presence, so a missing entry is
 * an internal bug rather than a user error).
 */
function requireById<T>(map: Map<string, T>, id: string): T {
  const value = map.get(id);
  if (value === undefined) {
    throw new Error(
      `Internal error: no moddle element registered for id "${id}".`,
    );
  }
  return value;
}
