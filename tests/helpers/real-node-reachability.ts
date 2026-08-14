/**
 * Reachability helper for the round-trip degradation tests.
 *
 * Gateways are scaffolding. The desugarer synthesizes them, `irToDsl` elides
 * the ones it recognizes, and re-desugaring invents fresh ones with fresh ids,
 * so the raw flow-endpoint set of an imported graph never matches its
 * round-tripped counterpart even when nothing was lost. What must match is the
 * connectivity between the nodes an author actually wrote.
 */

import type { BpmnProcess } from '@bpmn-script/transform';

/**
 * The reachability relation between the real (non-gateway) flow nodes, with
 * every gateway contracted to a transparent routing point.
 *
 * For each real node `r`, walk forward across any number of gateways and
 * record `r -> t` for every real node `t` first reached. That collapses the
 * gateway scaffolding (splits, joins, phantom joins) which differs between an
 * imported graph and its re-desugared counterpart, leaving the authored-node
 * connectivity — the quantity a lossless round-trip preserves.
 *
 * @param ir The process to measure.
 * @returns Sorted `source->target` pairs over real nodes only.
 */
export function realNodeReachability(ir: BpmnProcess): string[] {
  const isGateway = new Map<string, boolean>(
    ir.flowElements.map((fe) => [
      fe.id,
      fe.kind === 'exclusiveGateway' || fe.kind === 'parallelGateway',
    ]),
  );

  const outgoing = new Map<string, string[]>();
  for (const sf of ir.sequenceFlows) {
    (
      outgoing.get(sf.sourceRef) ??
      outgoing.set(sf.sourceRef, []).get(sf.sourceRef)!
    ).push(sf.targetRef);
  }

  const pairs = new Set<string>();
  for (const node of ir.flowElements) {
    if (isGateway.get(node.id)) continue; // start from real nodes only
    const seen = new Set<string>();
    const stack = [...(outgoing.get(node.id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (isGateway.get(next)) {
        // Transparent: walk through the gateway to its successors.
        for (const t of outgoing.get(next) ?? []) stack.push(t);
      } else {
        pairs.add(`${node.id}->${next}`);
      }
    }
  }
  return [...pairs].sort();
}
