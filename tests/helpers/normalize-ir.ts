// One half of a round-trip comparison carries hand-authored ids, the other the
// deterministic ids the pipeline synthesizes (ADR 0010). They are semantically
// equal but mechanically different, so this canonicalizes the differences away
// before `toEqual`.
//
// A subProcess's flows never cross its boundary, so every step here runs per
// container at every depth.
//
// Gateways are re-keyed by structural position, not by the synthesized-id
// regex, because the handwritten counterpart is hand-named. Task and event ids
// are never re-keyed: they have to survive the round trip verbatim.

import {
  gatewayDefaultFlowId,
  isGateway,
  type BpmnProcess,
  type EventDefinition,
  type FlowContainer,
  type FlowElement,
  type SequenceFlow,
} from '@bpmn-script/transform';

// The synthesized join family: XOR after `if/else`, AND after `parallel`.
const SYNTHESIZED_JOIN_ID = /^Gateway_.+_join$/;

export function normalizeIr(ir: BpmnProcess): BpmnProcess {
  return normalizeContainer(ir);
}

function normalizeContainer<T extends FlowContainer>(container: T): T {
  // Must run before re-keying: it gives both halves the same element set.
  const inlined = inlinePassThroughJoins(container);

  const gatewayIdMap = buildCanonicalIds(inlined, (fe) =>
    gatewaySignature(fe, inlined),
  );
  const handlerIdMap = buildCanonicalIds(inlined, eventSubProcessSignature);
  const boundaryIdMap = buildCanonicalIds(inlined, boundarySignature);

  const canonicalId = (id: string): string =>
    gatewayIdMap.get(id) ?? boundaryIdMap.get(id) ?? id;

  const flowElements: FlowElement[] = inlined.flowElements
    .map((fe) => {
      // A plain sub-process id is authored, so it stays. A `triggeredByEvent`
      // one has no surface id and is re-keyed to its trigger signature.
      if (fe.kind === 'subProcess') {
        const normalized = normalizeContainer(fe);
        return fe.triggeredByEvent === true
          ? { ...normalized, id: handlerIdMap.get(fe.id) ?? fe.id }
          : normalized;
      }

      // Only its own id moves; `attachedToRef` is an authored host id.
      if (fe.kind === 'boundaryEvent') {
        return { ...fe, id: canonicalId(fe.id) };
      }

      if (!isGateway(fe)) return fe;
      const id = canonicalId(fe.id);

      // The structured syntax has no slot for a gateway label, so only gateways
      // lose their name. Task and event names survive verbatim.
      const { name: _name, ...withoutName } = fe;

      // `defaultFlowId` points at a flow that is itself re-keyed below.
      const declaredDefault = gatewayDefaultFlowId(fe);
      if (declaredDefault !== undefined) {
        const target = inlined.sequenceFlows.find(
          (sf) => sf.id === declaredDefault,
        );
        const defaultFlowId =
          target !== undefined
            ? canonicalFlowKey(target, canonicalId)
            : declaredDefault;
        return { ...withoutName, id, defaultFlowId };
      }
      return { ...withoutName, id };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const sequenceFlows: SequenceFlow[] = inlined.sequenceFlows
    .map((sf) => normalizeFlow(sf, canonicalId))
    .sort((a, b) => a.id.localeCompare(b.id));

  // The spread keeps every other field, so this really is a `T`.
  return {
    ...container,
    flowElements,
    sequenceFlows,
  } as T;
}

// A re-synthesized `if/else` always grows a join the hand-authored IR never
// had. Treating that join as transparent lets the two halves compare
// structurally. Only sibling flows of the same container are considered.
function inlinePassThroughJoins(ir: FlowContainer): FlowContainer {
  const successorOf = new Map<string, string>();
  for (const fe of ir.flowElements) {
    if (!isGateway(fe)) continue;
    if (!SYNTHESIZED_JOIN_ID.test(fe.id)) continue;

    const outgoing = ir.sequenceFlows.filter((sf) => sf.sourceRef === fe.id);
    const incoming = ir.sequenceFlows.filter((sf) => sf.targetRef === fe.id);
    if (outgoing.length === 1 && incoming.length >= 1) {
      successorOf.set(fe.id, outgoing[0].targetRef);
    }
  }

  if (successorOf.size === 0) return ir;

  const flowElements = ir.flowElements.filter((fe) => !successorOf.has(fe.id));

  const sequenceFlows = ir.sequenceFlows
    .filter((sf) => !successorOf.has(sf.sourceRef))
    .map((sf) => {
      const successor = successorOf.get(sf.targetRef);
      return successor !== undefined ? { ...sf, targetRef: successor } : sf;
    });

  return { ...ir, flowElements, sequenceFlows };
}

// A `signatureOf` returning undefined skips the element, so each signature
// function also decides its own membership. Ties get a positional `#1`, `#2`
// suffix in flowElements order.
function buildCanonicalIds(
  ir: FlowContainer,
  signatureOf: (fe: FlowElement) => string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  const signatureCount = new Map<string, number>();
  for (const fe of ir.flowElements) {
    const signature = signatureOf(fe);
    if (signature === undefined) continue;

    const seen = signatureCount.get(signature) ?? 0;
    signatureCount.set(signature, seen + 1);
    map.set(fe.id, seen === 0 ? signature : `${signature}#${seen}`);
  }
  return map;
}

// Once the join is inlined, a hand-named gateway and its synthesized twin sit
// at the same topological position, so adjacency keys them equally. `kind` is
// in the key so a XOR and an AND in one position never collapse together.
function gatewaySignature(
  fe: FlowElement,
  ir: FlowContainer,
): string | undefined {
  if (!isGateway(fe)) return undefined;

  const incoming = ir.sequenceFlows
    .filter((sf) => sf.targetRef === fe.id)
    .map((sf) => sf.sourceRef)
    .sort();
  const outgoing = ir.sequenceFlows
    .filter((sf) => sf.sourceRef === fe.id)
    .map((sf) => sf.targetRef)
    .sort();

  return `Gateway_${fe.kind}_[in:${incoming.join(',')}]_[out:${outgoing.join(',')}]`;
}

// An `on` handler's sub-process id is a synthesized coordinate that moves when
// a round trip re-orders the container's statements, so key it off the trigger
// start event instead. Two handlers with the same signature are a validator
// error, so they cannot reach here from a valid program.
function eventSubProcessSignature(fe: FlowElement): string | undefined {
  if (fe.kind !== 'subProcess' || fe.triggeredByEvent !== true)
    return undefined;

  const start = fe.flowElements.find((e) => e.kind === 'startEvent');
  const def = start?.kind === 'startEvent' ? start.eventDefinition : undefined;
  const kind = def?.kind ?? 'unknown';
  const code = definitionPayloadKey(def);
  const interrupting =
    start?.kind === 'startEvent' && start.isInterrupting === false
      ? 'non-interrupting'
      : 'interrupting';

  return `EventSubProcess_[trigger:${kind}]_[code:${code}]_[${interrupting}]`;
}

// `on Pack: error "A"` and `on Pack: error "B"` both base to
// `Boundary_Pack_error`, and the `_2` suffix that separates them is stable when
// generating but not on import, because moddle may present the children in
// either order. Keying on host plus trigger payload sidesteps that.
function boundarySignature(fe: FlowElement): string | undefined {
  if (fe.kind !== 'boundaryEvent') return undefined;

  const code = definitionPayloadKey(fe.eventDefinition);
  const interrupting =
    fe.cancelActivity === false ? 'non-interrupting' : 'interrupting';

  return `Boundary_[host:${fe.attachedToRef}]_[trigger:${fe.eventDefinition.kind}]_[code:${code}]_[${interrupting}]`;
}

// The datum that identifies a handler within its trigger kind, so two same-kind
// handlers with different payloads stay apart.
function definitionPayloadKey(def: EventDefinition | undefined): string {
  if (def === undefined) return '<none>';
  switch (def.kind) {
    case 'error':
      return def.errorCode ?? '<catch-all>';
    case 'escalation':
      return def.escalationCode ?? '<catch-all>';
    case 'message':
      return def.messageName;
    case 'signal':
      return def.signalName;
    case 'timer':
      return `${def.timerKind} ${def.expression}`;
    case 'conditional':
      return def.condition;
    case 'compensation':
      // The validator allows one undo block per container, so a constant here
      // cannot collide.
      return '<compensation>';
    case 'terminate':
      // Payload-free and at most one per container, so a constant cannot collide.
      return '<terminate>';
    case 'cancel':
      // Payload-free, and the engine takes at most one cancel handler per
      // block, so a constant cannot collide either.
      return '<cancel>';
    default: {
      const exhaustive: never = def;
      return JSON.stringify(exhaustive);
    }
  }
}

// Re-keyed when the id starts with `Flow_` (the generated families) or either
// end is itself re-keyed. Everything else stays verbatim.
function normalizeFlow(
  sf: SequenceFlow,
  canonicalId: (id: string) => string,
): SequenceFlow {
  const touchesReKeyedNode =
    canonicalId(sf.sourceRef) !== sf.sourceRef ||
    canonicalId(sf.targetRef) !== sf.targetRef;

  if (/^Flow_/.test(sf.id) || touchesReKeyedNode) {
    return {
      ...sf,
      id: canonicalFlowKey(sf, canonicalId),
      sourceRef: canonicalId(sf.sourceRef),
      targetRef: canonicalId(sf.targetRef),
    };
  }
  return sf;
}

// Flow ids and a gateway's `defaultFlowId` both route through here so they agree.
function canonicalFlowKey(
  sf: SequenceFlow,
  canonicalId: (id: string) => string,
): string {
  return `Flow_${canonicalId(sf.sourceRef)}_${canonicalId(sf.targetRef)}`;
}
