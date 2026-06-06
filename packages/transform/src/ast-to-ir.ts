/**
 * AST → IR transform for BPMNscript.
 *
 * Walks the Langium-generated AST produced by the BpmnScript grammar and
 * converts it into the engine-agnostic {@link BpmnProcess} IR defined in
 * `./ir/types.ts`.
 *
 * Langium-specific conventions observed here:
 *  - `node.name` is the DSL identifier (used as the BPMN `id`).
 *  - `node.label` is the optional quoted human-readable label (maps to
 *    BPMN `name`). Langium strips surrounding quotes from STRING tokens.
 *  - `reference.$refText` is the textual reference text; call `.ref?.name`
 *    to get the resolved target's identifier.
 *  - `flow.condition` carries the raw expression body (e.g. `${amount > 1000}`)
 *    already stripped of its surrounding quotes by Langium.
 *
 * Sequence-flow id strategy:
 *  - If the DSL flow has an `as: <id>` tag, `flow.name` is that id and it
 *    becomes the IR flow's `id` directly.
 *  - Otherwise an id is generated as `Flow_<sourceId>_<targetId>`. A
 *    numeric suffix (`_2`, `_3`, …) is appended when the same source↔target
 *    pair appears more than once (degenerate but legal BPMN).
 */

import type {
  Model,
  SequenceFlow as AstSequenceFlow,
  FlowNode,
} from '@bpmn-script/language';
import type {
  BpmnProcess,
  FlowElement,
  SequenceFlow as IrSequenceFlow,
} from './ir/types.js';

/**
 * Convert a BpmnScript AST `Model` into an engine-agnostic {@link BpmnProcess}.
 *
 * Only the **first** `process` block in the model is converted; any further
 * `process` blocks are ignored. The grammar permits multiple processes, so
 * this is a deliberate single-process limitation, not a parser guarantee.
 *
 * @param model The root AST node produced by `parseHelper<Model>` or the
 *   Langium document builder.
 * @returns A fully-populated `BpmnProcess` ready for downstream transforms.
 * @throws {Error} When the model contains no processes.
 */
export function astToIr(model: Model): BpmnProcess {
  const process = model.processes[0];
  if (!process) {
    throw new Error('astToIr: the model contains no process definitions.');
  }

  // Build sequence-flow ids first so the gateway default resolution can look
  // them up by their DSL `as:` tag (flow.name) rather than the generated id.
  const flowIds = buildFlowIds(process.flows);

  const flowElements: FlowElement[] = process.nodes.map((node) =>
    mapFlowNode(node, process.flows, flowIds),
  );

  const sequenceFlows: IrSequenceFlow[] = process.flows.map((flow, idx) =>
    mapSequenceFlow(flow, flowIds[idx]!),
  );

  return {
    id: process.name,
    ...(process.label !== undefined ? { name: process.label } : {}),
    isExecutable: true,
    flowElements,
    sequenceFlows,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the IR id for every sequence flow in declaration order.
 *
 * A flow that carries `as: <id>` uses that identifier verbatim. Unnamed
 * flows get a generated id `Flow_<sourceRef>_<targetRef>`. If the same
 * source↔target pair appears more than once the second occurrence gets
 * `_2`, the third `_3`, and so on.
 */
function buildFlowIds(flows: AstSequenceFlow[]): string[] {
  // Counter map for duplicate generated ids.
  const usedGenerated = new Map<string, number>();

  return flows.map((flow) => {
    if (flow.name !== undefined) {
      // The flow has an `as: <id>` tag — use it directly.
      return flow.name;
    }

    const srcId = flow.source.ref?.name ?? flow.source.$refText;
    const tgtId = flow.target.ref?.name ?? flow.target.$refText;
    const base = `Flow_${srcId}_${tgtId}`;

    const count = usedGenerated.get(base) ?? 0;
    usedGenerated.set(base, count + 1);

    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

/**
 * Map a single AST `FlowNode` (union of StartEvent | EndEvent | UserTask |
 * ServiceTask | ExclusiveGateway) to its IR counterpart.
 *
 * For `ExclusiveGateway` the `defaultFlowId` is resolved by finding the
 * sequence flow whose `name` (the `as:` tag) matches the gateway's
 * `default.$refText` and returning the id that was assigned to that flow.
 */
function mapFlowNode(
  node: FlowNode,
  flows: AstSequenceFlow[],
  flowIds: string[],
): FlowElement {
  switch (node.$type) {
    case 'StartEvent':
      return {
        kind: 'startEvent',
        id: node.name,
        ...(node.label !== undefined ? { name: node.label } : {}),
      };

    case 'EndEvent':
      return {
        kind: 'endEvent',
        id: node.name,
        ...(node.label !== undefined ? { name: node.label } : {}),
      };

    case 'UserTask':
      return {
        kind: 'userTask',
        id: node.name,
        ...(node.label !== undefined ? { name: node.label } : {}),
        ...(node.assignee !== undefined ? { assignee: node.assignee } : {}),
        ...(node.formKey !== undefined ? { formKey: node.formKey } : {}),
      };

    case 'ServiceTask':
      return {
        kind: 'serviceTask',
        id: node.name,
        ...(node.label !== undefined ? { name: node.label } : {}),
        javaClass: node.javaClass,
      };

    case 'ExclusiveGateway': {
      let defaultFlowId: string | undefined;

      if (node.default !== undefined) {
        // The gateway's `default:` is a cross-reference to a SequenceFlow
        // identified by its `as:` tag (which is the flow's `name` property).
        // Resolve the reference text to find the matching flow's assigned id.
        const defaultRefName = node.default.ref?.name ?? node.default.$refText;
        const matchIdx = flows.findIndex((f) => f.name === defaultRefName);
        if (matchIdx !== -1) {
          defaultFlowId = flowIds[matchIdx];
        }
      }

      return {
        kind: 'exclusiveGateway',
        id: node.name,
        ...(node.label !== undefined ? { name: node.label } : {}),
        ...(defaultFlowId !== undefined ? { defaultFlowId } : {}),
      };
    }

    default:
      // TypeScript exhaustiveness guard — the grammar union is closed, so
      // this branch is unreachable at runtime.
      throw new Error(
        `astToIr: unexpected AST node type '${(node as { $type: string }).$type}'.`,
      );
  }
}

/**
 * Map a single AST `SequenceFlow` to its IR counterpart, using the
 * pre-computed `id` from {@link buildFlowIds}.
 */
function mapSequenceFlow(flow: AstSequenceFlow, id: string): IrSequenceFlow {
  const sourceRef = flow.source.ref?.name ?? flow.source.$refText;
  const targetRef = flow.target.ref?.name ?? flow.target.$refText;

  return {
    id,
    ...(flow.condition !== undefined
      ? { conditionExpression: flow.condition }
      : {}),
    sourceRef,
    targetRef,
  };
}
