import { isGateway, type BpmnProcess } from '@bpmn-script/transform';

// Sorted `source->target` pairs between non-gateway nodes, gateways contracted,
// since re-desugaring gives every gateway a fresh id.
export function realNodeReachability(ir: BpmnProcess): string[] {
  const gatewayById = new Map<string, boolean>(
    ir.flowElements.map((fe) => [fe.id, isGateway(fe)]),
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
    if (gatewayById.get(node.id)) continue;
    const seen = new Set<string>();
    const stack = [...(outgoing.get(node.id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (gatewayById.get(next)) {
        for (const t of outgoing.get(next) ?? []) stack.push(t);
      } else {
        pairs.add(`${node.id}->${next}`);
      }
    }
  }
  return [...pairs].sort();
}
