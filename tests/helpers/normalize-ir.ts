// Canonicalizes authored vs synthesized ids before `toEqual`: gateways,
// boundaries, event sub-processes and flows are re-keyed by structure; task and
// event ids must survive verbatim. Flows never cross a sub-process, so this
// runs per container.

import { ENGINE_KEYS } from '@bpmn-script/language';
import {
  isGateway,
  type BpmnProcess,
  type EventDefinition,
  type FlowContainer,
  type FlowElement,
  type SequenceFlow,
} from '@bpmn-script/transform';

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
      return { ...withoutName, id, ...reKeyedDefault(fe), ...routeOrder(fe) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  // Operaton takes the first non-default flow of an exclusive gateway that
  // carries no condition or one that holds, in document order, so that order
  // is compared.
  function routeOrder(fe: FlowElement): { routeOrder?: string[] } {
    if (fe.kind !== 'exclusiveGateway') return {};
    const routes = inlined.sequenceFlows
      .filter((sf) => sf.sourceRef === fe.id && sf.id !== fe.defaultFlowId)
      .map(
        (sf) =>
          `${canonicalId(sf.targetRef)} ${sf.conditionExpression ?? '<none>'}`,
      );
    return routes.length > 1 ? { routeOrder: routes } : {};
  }

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
    .sort(
      (a, b) =>
        a.id.localeCompare(b.id) ||
        (a.conditionExpression ?? '').localeCompare(
          b.conditionExpression ?? '',
        ),
    );

  return {
    ...container,
    flowElements,
    sequenceFlows,
  } as T;
}

// A settings-free exclusive gateway with one outgoing flow merges without
// synchronizing, as an activity with several incoming flows does, so it is
// transparent unless the node it leads to is a parallel or inclusive join.
// A parallel or inclusive gateway is transparent only with one incoming flow,
// and an event-based one never is, since it waits for its event. One
// carrying a job setting stays, or a dropped `join*` key would vanish from
// both sides of the comparison.
function inlinePassThroughJoins(ir: FlowContainer): FlowContainer {
  const byId = new Map(ir.flowElements.map((fe) => [fe.id, fe]));
  const successorOf = new Map<string, string>();
  for (const fe of ir.flowElements) {
    if (!isGateway(fe) || fe.kind === 'eventBasedGateway') continue;
    if (ENGINE_KEYS.some((key) => key in fe) || fe.documentation !== undefined)
      continue;
    const outgoing = ir.sequenceFlows.filter((sf) => sf.sourceRef === fe.id);
    const incoming = ir.sequenceFlows.filter((sf) => sf.targetRef === fe.id);
    if (outgoing.length !== 1 || incoming.length === 0) continue;
    if (incoming.length === 1 || fe.kind === 'exclusiveGateway') {
      successorOf.set(fe.id, outgoing[0].targetRef);
    }
  }

  // A chain of joins resolves to the first node that stays; a gateway-only
  // cycle is kept whole.
  const resolve = (id: string): string | undefined => {
    const seen = new Set<string>();
    let at = id;
    while (successorOf.has(at)) {
      if (seen.has(at)) return undefined;
      seen.add(at);
      at = successorOf.get(at)!;
    }
    return at;
  };
  // Keeping a merge only shortens other chains, so the loop reaches the same
  // fixpoint whatever the element order.
  for (let kept = true; kept;) {
    kept = false;
    for (const [id] of successorOf) {
      const end = resolve(id);
      const kind = end === undefined ? undefined : byId.get(end)?.kind;
      const merges = ir.sequenceFlows.filter((sf) => sf.targetRef === id);
      const synchronizes =
        kind === 'parallelGateway' || kind === 'inclusiveGateway';
      if (end === undefined || (merges.length > 1 && synchronizes)) {
        successorOf.delete(id);
        kept = true;
      }
    }
  }
  if (successorOf.size === 0) return ir;

  const flowElements = ir.flowElements.filter((fe) => !successorOf.has(fe.id));
  const sequenceFlows = ir.sequenceFlows
    .filter((sf) => !successorOf.has(sf.sourceRef))
    .map((sf) =>
      successorOf.has(sf.targetRef)
        ? { ...sf, targetRef: resolve(sf.targetRef)! }
        : sf,
    );

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
// their adjacency. A neighbouring gateway is named by its kind, since its own
// id differs between the two sides.
function gatewaySignature(
  fe: FlowElement,
  ir: FlowContainer,
): string | undefined {
  if (!isGateway(fe)) return undefined;

  const name = (id: string): string => {
    const el = ir.flowElements.find((e) => e.id === id);
    return el !== undefined && isGateway(el) ? `gateway:${el.kind}` : id;
  };
  const incoming = ir.sequenceFlows
    .filter((sf) => sf.targetRef === fe.id)
    .map((sf) => name(sf.sourceRef))
    .sort();
  const outgoing = ir.sequenceFlows
    .filter((sf) => sf.sourceRef === fe.id)
    .map((sf) => name(sf.targetRef))
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

// The DSL has no syntax for a flow id, so every flow is keyed by its ends.
function normalizeFlow(
  sf: SequenceFlow,
  canonicalId: (id: string) => string,
): SequenceFlow {
  const sourceRef = canonicalId(sf.sourceRef);
  const targetRef = canonicalId(sf.targetRef);
  return { ...sf, id: `Flow_${sourceRef}_${targetRef}`, sourceRef, targetRef };
}
