/**
 * IR → BPMN 2.0 XML transform.
 *
 * Takes an engine-agnostic {@link BpmnProcess} and produces a BPMN 2.0
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
 *   5. Serialize via `moddle.toXML(..., { format: true })`.
 *   6. Pass the string through `bpmn-auto-layout` to inject `bpmndi:`
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
import type { BpmnProcess, FlowElement, SequenceFlow } from './ir/types.js';

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

  // Pass 1: build moddle elements for every flow node and sequence flow.
  // We hold them by id so we can wire references in pass 2.
  const flowNodeById = new Map<string, ModdleElement>();
  const sequenceFlowById = new Map<string, ModdleElement>();

  for (const node of process.flowElements) {
    flowNodeById.set(node.id, createFlowNode(moddle, node));
  }

  for (const flow of process.sequenceFlows) {
    sequenceFlowById.set(
      flow.id,
      createSequenceFlow(moddle, flow, flowNodeById),
    );
  }

  // Pass 2: wire up incoming/outgoing on every flow node — MIWG requires
  // them and bpmn-moddle does not auto-derive them.
  attachIncomingOutgoing(process, flowNodeById, sequenceFlowById);

  // Pass 3: wire up the gateway `default` references (these need the
  // SequenceFlow moddle objects, so they have to happen after pass 1).
  attachGatewayDefaults(process, flowNodeById, sequenceFlowById);

  // Assemble the process and the definitions root.
  const processAttrs: Record<string, unknown> = {
    id: process.id,
    // The process is always labelable: when no explicit name is carried in the
    // IR, derive a human-readable one from the id so the BPMN stays meaningful.
    name: process.name ?? humanize(process.id),
    isExecutable: process.isExecutable,
    'operaton:historyTimeToLive': HISTORY_TIME_TO_LIVE,
    flowElements: [
      ...process.flowElements.map((n) => requireById(flowNodeById, n.id)),
      ...process.sequenceFlows.map((f) => requireById(sequenceFlowById, f.id)),
    ],
  };
  const processElement = moddle.create('bpmn:Process', processAttrs);

  const stem = options?.sourceFileName
    ? basename(options.sourceFileName, extname(options.sourceFileName))
    : process.id;
  const definitions = moddle.create('bpmn:Definitions', {
    id: `Definitions_${stem}`,
    targetNamespace: TARGET_NAMESPACE,
    exporter: 'BPMNscript',
    exporterVersion: options?.exporterVersion ?? '0.0.0',
    rootElements: [processElement],
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
 * Build a single flow-node moddle element for one IR FlowElement.
 * Operaton extension attributes are attached using the namespace-qualified
 * property names defined in `operaton-moddle.json`.
 */
function createFlowNode(
  moddle: BpmnModdleInstance,
  node: FlowElement,
): ModdleElement {
  const baseAttrs: Record<string, unknown> = { id: node.id };
  // Derive a human-readable `name` from the id for labelable nodes when the IR
  // carries none. Gateways and start/end events are excluded: their ids are
  // synthesized structural coordinates (e.g. `Gateway_…_split`,
  // `StartEvent_<processId>`) that would humanize to noise, and such elements
  // are conventionally unnamed. Explicit names from the IR are always kept.
  const derivedName =
    node.name ??
    (node.kind === 'exclusiveGateway' ||
    node.kind === 'parallelGateway' ||
    node.kind === 'startEvent' ||
    node.kind === 'endEvent'
      ? undefined
      : humanize(node.id));
  if (derivedName !== undefined) {
    baseAttrs.name = derivedName;
  }

  switch (node.kind) {
    case 'startEvent':
      return moddle.create('bpmn:StartEvent', baseAttrs);

    case 'endEvent':
      return moddle.create('bpmn:EndEvent', baseAttrs);

    case 'userTask': {
      const attrs: Record<string, unknown> = { ...baseAttrs };
      if (node.assignee !== undefined) {
        attrs['operaton:assignee'] = node.assignee;
      }
      if (node.formKey !== undefined) {
        attrs['operaton:formKey'] = node.formKey;
      }
      return moddle.create('bpmn:UserTask', attrs);
    }

    case 'serviceTask': {
      const attrs: Record<string, unknown> = {
        ...baseAttrs,
        'operaton:class': node.javaClass,
      };
      return moddle.create('bpmn:ServiceTask', attrs);
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
  process: BpmnProcess,
  flowNodeById: Map<string, ModdleElement>,
  sequenceFlowById: Map<string, ModdleElement>,
): void {
  // Initialise empty incoming/outgoing on every node.
  for (const node of flowNodeById.values()) {
    node.incoming = [];
    node.outgoing = [];
  }

  for (const flow of process.sequenceFlows) {
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
  process: BpmnProcess,
  flowNodeById: Map<string, ModdleElement>,
  sequenceFlowById: Map<string, ModdleElement>,
): void {
  for (const node of process.flowElements) {
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
