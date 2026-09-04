import type { BpmnProcess } from '@bpmn-script/transform';

// Gateways are synthesized scaffolding and get fresh ids on every re-desugar,
// so the raw flow-endpoint sets of an imported graph and its round-tripped
// counterpart never match even when nothing was lost. Contracting each gateway
// to a transparent routing point leaves the authored-node connectivity, which a
// lossless round trip does preserve. Returns sorted `source->target` pairs.
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
    if (isGateway.get(node.id)) continue;
    const seen = new Set<string>();
    const stack = [...(outgoing.get(node.id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (isGateway.get(next)) {
        for (const t of outgoing.get(next) ?? []) stack.push(t);
      } else {
        pairs.add(`${node.id}->${next}`);
      }
    }
  }
  return [...pairs].sort();
}
