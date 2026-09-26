// Canonicalizes authored vs synthesized ids before `toEqual`: gateways,
// boundaries and event sub-processes are re-keyed by structure; task and event
// ids must survive verbatim. Flows never cross a sub-process, so this runs per
// container.

import { ENGINE_KEYS } from '@bpmn-script/language';
import {
  isGateway,
  type BpmnProcess,
  type EventDefinition,
  type FlowContainer,
  type FlowElement,
  type SequenceFlow,
} from '@bpmn-script/transform';

const SYNTHESIZED_JOIN_ID = /^Gateway_.+_join$/;

export function normalizeIr(ir: BpmnProcess): BpmnProcess {
  return normalizeContainer(ir);
}

function normalizeContainer<T extends FlowContainer>(container: T): T {
  // Before re-keying, so both halves have the same element set.
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
      // A `triggeredByEvent` one has no surface id. Its `defaultFlowId` names
      // a flow of this container, not of its body.
      if (fe.kind === 'subProcess') {
        const normalized = { ...normalizeContainer(fe), ...reKeyedDefault(fe) };
        return fe.triggeredByEvent === true
          ? { ...normalized, id: handlerIdMap.get(fe.id) ?? fe.id }
          : normalized;
      }

      if (fe.kind === 'boundaryEvent') {
        return { ...fe, id: canonicalId(fe.id) };
      }

      if (!isGateway(fe)) return { ...fe, ...reKeyedDefault(fe) };
      const id = canonicalId(fe.id);

      // The structured syntax has no slot for a gateway label.
      const { name: _name, ...withoutName } = fe;
      return { ...withoutName, id, ...reKeyedDefault(fe) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  function reKeyedDefault(fe: FlowElement): { defaultFlowId?: string } {
    const declared = 'defaultFlowId' in fe ? fe.defaultFlowId : undefined;
    if (declared === undefined) return {};
    const target = inlined.sequenceFlows.find((sf) => sf.id === declared);
    return {
      defaultFlowId:
        target === undefined ? declared : normalizeFlow(target, canonicalId).id,
    };
  }

  const sequenceFlows: SequenceFlow[] = inlined.sequenceFlows
    .map((sf) => normalizeFlow(sf, canonicalId))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    ...container,
    flowElements,
    sequenceFlows,
  } as T;
}

// A re-synthesized `if/else` grows a join the authored IR never had, so such a
// join is transparent. One carrying a job setting stays, or a dropped `join*`
// key would vanish from both sides of the comparison.
function inlinePassThroughJoins(ir: FlowContainer): FlowContainer {
  const successorOf = new Map<string, string>();
  for (const fe of ir.flowElements) {
    if (!isGateway(fe)) continue;
    if (!SYNTHESIZED_JOIN_ID.test(fe.id)) continue;
    if (ENGINE_KEYS.some((key) => key in fe)) continue;

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

// `undefined` skips the element; ties get a positional `#n` suffix.
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

// After join inlining, a hand-named gateway and its synthesized twin share
// their adjacency.
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

// A handler's synthesized id moves when statements re-order, so key it by its
// trigger; two handlers with one trigger are a validator error.
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

// The `_2` suffix separating two same-trigger boundaries on one host is not
// stable on import, since moddle may present them in either order.
function boundarySignature(fe: FlowElement): string | undefined {
  if (fe.kind !== 'boundaryEvent') return undefined;

  const code = definitionPayloadKey(fe.eventDefinition);
  const interrupting =
    fe.cancelActivity === false ? 'non-interrupting' : 'interrupting';

  return `Boundary_[host:${fe.attachedToRef}]_[trigger:${fe.eventDefinition.kind}]_[code:${code}]_[${interrupting}]`;
}

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
    case 'link':
      return def.linkName;
    case 'timer':
      return `${def.timerKind} ${def.expression}`;
    case 'conditional':
      return def.condition;
    // Constants cannot collide: one undo block per container, one cancel
    // handler per block, and terminate is never a trigger.
    case 'compensation':
      return '<compensation>';
    case 'terminate':
      return '<terminate>';
    case 'cancel':
      return '<cancel>';
    default: {
      const exhaustive: never = def;
      return JSON.stringify(exhaustive);
    }
  }
}

// `Flow_` prefixes every generated flow id.
function normalizeFlow(
  sf: SequenceFlow,
  canonicalId: (id: string) => string,
): SequenceFlow {
  const sourceRef = canonicalId(sf.sourceRef);
  const targetRef = canonicalId(sf.targetRef);
  const touchesReKeyedNode =
    sourceRef !== sf.sourceRef || targetRef !== sf.targetRef;

  if (/^Flow_/.test(sf.id) || touchesReKeyedNode) {
    return {
      ...sf,
      id: `Flow_${sourceRef}_${targetRef}`,
      sourceRef,
      targetRef,
    };
  }
  return sf;
}
