// Canonicalizes authored vs synthesized ids before `toEqual`: gateways,
// boundaries, event sub-processes and flows are re-keyed by structure; task and
// event ids must survive verbatim. Flows never cross a sub-process, so this
// runs per container.
//
// Loaded outside vitest through Node's type stripping: import only the
// workspace packages and sibling files, with `.ts` extensions.

import { ENGINE_KEYS } from '@bpmn-script/language';
import {
  isGateway,
  type BpmnProcess,
  type EventDefinition,
  type FlowContainer,
  type FlowElement,
  type Named,
  type SequenceFlow,
} from '@bpmn-script/transform';

/** One per normalization the comparison helper can report. */
export const NORMALIZATIONS = [
  'synthesized-ids',
  'gateway-names',
  'pass-through-gateways',
  'element-order',
  'expression-parse-trees',
  'default-history-time-to-live',
  'implicit-end',
  'uncontrolled-flow',
  'unconditioned-last-route',
  'nested-forks',
] as const;

export type NormalizationName = (typeof NORMALIZATIONS)[number];

/**
 * `off` switches normalizations off. `expression-parse-trees`,
 * `default-history-time-to-live` and `implicit-end` are applied by the
 * caller, never here.
 */
export function normalizeIr(
  ir: BpmnProcess,
  off: ReadonlySet<NormalizationName> = new Set(),
): BpmnProcess {
  return normalizeContainer(ir, off);
}

export function hasOnly(x: object, keys: readonly string[]): boolean {
  return Object.entries(x).every(
    ([k, v]) => v === undefined || keys.includes(k),
  );
}

export function isPlainFlow(sf: SequenceFlow): boolean {
  return hasOnly(sf, ['id', 'sourceRef', 'targetRef']);
}

function normalizeContainer<T extends FlowContainer>(
  container: T,
  off: ReadonlySet<NormalizationName>,
): T {
  // Before re-keying, so both halves have the same element set.
  const joined = inlinePassThroughJoins(container, off);
  // Nested forks merge first, while the outer fork is still a gateway.
  const forks = off.has('nested-forks')
    ? joined
    : mergeNestedForks(joined, off);
  const split = off.has('uncontrolled-flow')
    ? forks
    : inlineImplicitSplits(forks, off);
  const inlined = off.has('unconditioned-last-route')
    ? split
    : withLastRouteDefaults(split);

  const keyed = (
    signatureOf: (fe: FlowElement) => string | undefined,
  ): Map<string, string> =>
    off.has('synthesized-ids')
      ? new Map()
      : buildCanonicalIds(inlined, signatureOf);
  const gatewayIdMap = keyed((fe) => gatewaySignature(fe, inlined));
  const handlerIdMap = keyed(eventSubProcessSignature);
  const boundaryIdMap = keyed(boundarySignature);

  const rekey = !off.has('synthesized-ids');
  const canonicalId = (id: string): string =>
    gatewayIdMap.get(id) ?? boundaryIdMap.get(id) ?? id;

  const flowElements: FlowElement[] = inlined.flowElements.map((fe) => {
    // A `triggeredByEvent` one has no surface id. Its `defaultFlowId` names
    // a flow of this container, not of its body.
    if (fe.kind === 'subProcess') {
      const normalized = {
        ...normalizeContainer(fe, off),
        ...reKeyedDefault(fe),
      };
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
    return {
      ...(off.has('gateway-names') ? fe : withoutName),
      id,
      ...reKeyedDefault(fe),
      ...routeOrder(fe),
    };
  });
  if (!off.has('element-order'))
    flowElements.sort((a, b) => a.id.localeCompare(b.id));

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
        target === undefined
          ? declared
          : normalizeFlow(target, canonicalId, rekey).id,
    };
  }

  const sequenceFlows: SequenceFlow[] = inlined.sequenceFlows.map((sf) =>
    normalizeFlow(sf, canonicalId, rekey),
  );
  if (!off.has('element-order'))
    sequenceFlows.sort(
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

// A gateway with one outgoing flow is only transparent when that flow is
// unconditioned: a condition decides whether the token moves at all.
// A settings-free exclusive gateway with one outgoing flow merges without
// synchronizing, as an activity with several incoming flows does, so it is
// transparent unless the node it leads to is a parallel or inclusive join.
// A parallel or inclusive gateway is transparent only with one incoming flow,
// and an event-based one never is, since it waits for its event.
// A merge of several flows that leads to a node other than a gateway is the
// implicit merge of `uncontrolled-flow`; any other is a pass-through gateway.
function inlinePassThroughJoins(
  ir: FlowContainer,
  off: ReadonlySet<NormalizationName>,
): FlowContainer {
  const byId = new Map(ir.flowElements.map((fe) => [fe.id, fe]));
  const successorOf = new Map<string, string>();
  for (const fe of ir.flowElements) {
    if (!isGateway(fe) || fe.kind === 'eventBasedGateway') continue;
    if (!isInlinable(fe, off)) continue;
    const outgoing = ir.sequenceFlows.filter((sf) => sf.sourceRef === fe.id);
    const incoming = ir.sequenceFlows.filter((sf) => sf.targetRef === fe.id);
    if (outgoing.length !== 1 || incoming.length === 0) continue;
    if (outgoing[0].conditionExpression !== undefined) continue;
    if (incoming.length === 1 && !off.has('pass-through-gateways')) {
      successorOf.set(fe.id, outgoing[0].targetRef);
    } else if (incoming.length > 1 && fe.kind === 'exclusiveGateway') {
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
      const target = end === undefined ? undefined : byId.get(end);
      const merges = ir.sequenceFlows.filter((sf) => sf.targetRef === id);
      const synchronizes =
        target?.kind === 'parallelGateway' ||
        target?.kind === 'inclusiveGateway';
      const switchedOff = off.has(
        target !== undefined && isGateway(target)
          ? 'pass-through-gateways'
          : 'uncontrolled-flow',
      );
      if (
        end === undefined ||
        (merges.length > 1 && (synchronizes || switchedOff))
      ) {
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

// Operaton leaves any node but a gateway through every outgoing flow whose
// condition holds or that has none, takes the node's `default` only when no
// other is taken, and refuses to continue when none is
// (`BpmnActivityBehavior.performOutgoingBehavior`). That is what an inclusive
// fork, or a parallel fork with unconditioned flows, does when it sits behind
// the node's only flow. The fork stays where the node routes differently:
// - `asyncAfter` makes each flow the node takes its own job: one job per
//   branch, where the node in front of a fork makes one.
// - a `class` or `delegateExpression` may be an `ActivityBehavior` that picks
//   its outgoing flow by id itself.
// - a multi-instance node's flows leave its body, so the node itself finds
//   no flow, looks for the `default` it names among its own, and fails.
// Where no condition holds and there is no default, both refuse, though the
// engine message then names the fork instead of the node.
function inlineImplicitSplits(
  ir: FlowContainer,
  off: ReadonlySet<NormalizationName>,
): FlowContainer {
  const byId = new Map(ir.flowElements.map((fe) => [fe.id, fe]));
  const hostOf = new Map<string, string>();
  const defaultOf = new Map<string, string>();
  for (const fork of ir.flowElements) {
    if (fork.kind !== 'parallelGateway' && fork.kind !== 'inclusiveGateway')
      continue;
    if (!isInlinable(fork, off)) continue;
    const incoming = ir.sequenceFlows.filter((sf) => sf.targetRef === fork.id);
    const outgoing = ir.sequenceFlows.filter((sf) => sf.sourceRef === fork.id);
    if (incoming.length !== 1 || !isPlainFlow(incoming[0])) continue;
    if (outgoing.length < 2) continue;
    if (
      fork.kind === 'parallelGateway' &&
      outgoing.some((sf) => sf.conditionExpression !== undefined)
    )
      continue;
    const host = byId.get(incoming[0].sourceRef);
    if (host === undefined || isGateway(host)) continue;
    if (ir.sequenceFlows.filter((sf) => sf.sourceRef === host.id).length > 1)
      continue;
    if (host.asyncAfter === true) continue;
    if ('loop' in host && host.loop !== undefined) {
      if (host.loop.asyncAfter === true) continue;
      if (fork.kind === 'inclusiveGateway' && fork.defaultFlowId !== undefined)
        continue;
    }
    if (
      'binding' in host &&
      (host.binding?.kind === 'class' ||
        host.binding?.kind === 'delegateExpression')
    )
      continue;
    hostOf.set(fork.id, host.id);
    if (fork.kind === 'inclusiveGateway' && fork.defaultFlowId !== undefined)
      defaultOf.set(host.id, fork.defaultFlowId);
  }
  if (hostOf.size === 0) return ir;

  const flowElements = ir.flowElements
    .filter((fe) => !hostOf.has(fe.id))
    .map((fe) =>
      defaultOf.has(fe.id)
        ? ({ ...fe, defaultFlowId: defaultOf.get(fe.id) } as FlowElement)
        : fe,
    );
  const sequenceFlows = ir.sequenceFlows
    .filter((sf) => !hostOf.has(sf.targetRef))
    .map((sf) => ({
      ...sf,
      sourceRef: hostOf.get(sf.sourceRef) ?? sf.sourceRef,
    }));
  return { ...ir, flowElements, sequenceFlows };
}

// The printer gives each join that takes only some of a parallel fork's routes
// a settings-free fork of its own behind that fork. Every route still starts
// at once, so the inner fork's routes are the outer one's. An outer fork with
// `asyncAfter` makes a job per outgoing flow, so it keeps its inner forks.
function mergeNestedForks(
  ir: FlowContainer,
  off: ReadonlySet<NormalizationName>,
): FlowContainer {
  const byId = new Map(ir.flowElements.map((fe) => [fe.id, fe]));
  const outerOf = new Map<string, string>();
  for (const fork of ir.flowElements) {
    if (fork.kind !== 'parallelGateway' || !isInlinable(fork, off)) continue;
    const incoming = ir.sequenceFlows.filter((sf) => sf.targetRef === fork.id);
    const outgoing = ir.sequenceFlows.filter((sf) => sf.sourceRef === fork.id);
    if (incoming.length !== 1 || !isPlainFlow(incoming[0])) continue;
    if (outgoing.length < 2) continue;
    if (outgoing.some((sf) => sf.conditionExpression !== undefined)) continue;
    const outer = byId.get(incoming[0].sourceRef);
    if (outer?.kind !== 'parallelGateway' || outer.asyncAfter === true)
      continue;
    outerOf.set(fork.id, outer.id);
  }
  // A fork nested in a nested fork resolves to the outermost; a cycle of
  // forks nothing enters is kept whole.
  const resolve = (id: string): string | undefined => {
    const seen = new Set<string>();
    let at = id;
    while (outerOf.has(at)) {
      if (seen.has(at)) return undefined;
      seen.add(at);
      at = outerOf.get(at)!;
    }
    return at;
  };
  // Decided before deleting: a deletion would let the rest of a cycle resolve.
  const cyclic = [...outerOf.keys()].filter((id) => resolve(id) === undefined);
  for (const id of cyclic) outerOf.delete(id);
  if (outerOf.size === 0) return ir;

  const flowElements = ir.flowElements.filter((fe) => !outerOf.has(fe.id));
  const sequenceFlows = ir.sequenceFlows
    .filter((sf) => !outerOf.has(sf.targetRef))
    .map((sf) =>
      outerOf.has(sf.sourceRef)
        ? { ...sf, sourceRef: resolve(sf.sourceRef)! }
        : sf,
    );
  return { ...ir, flowElements, sequenceFlows };
}

// Operaton's exclusive gateway skips its `default` and takes the first other
// flow in document order that has no condition or one that holds
// (`ExclusiveGatewayActivityBehavior`). An unconditioned last route behind
// only conditioned ones is therefore taken exactly when a default would be.
// An inclusive gateway always takes an unconditioned flow, so there it is no
// default.
function withLastRouteDefaults(ir: FlowContainer): FlowContainer {
  const flowElements = ir.flowElements.map((fe): FlowElement => {
    if (fe.kind !== 'exclusiveGateway' || fe.defaultFlowId !== undefined)
      return fe;
    const routes = ir.sequenceFlows.filter((sf) => sf.sourceRef === fe.id);
    const fallback = routes.findIndex(
      (sf) => sf.conditionExpression === undefined,
    );
    if (routes.length < 2 || fallback !== routes.length - 1) return fe;
    return { ...fe, defaultFlowId: routes[fallback].id };
  });
  return { ...ir, flowElements };
}

// One carrying a job setting or documentation stays, or that would vanish from
// both sides of the comparison; so does a named one while `gateway-names` is
// off, or a dropped name would go unreported.
function isInlinable(
  gateway: FlowElement & Named,
  off: ReadonlySet<NormalizationName>,
): boolean {
  return (
    !ENGINE_KEYS.some((key) => key in gateway) &&
    gateway.documentation === undefined &&
    (gateway.name === undefined || !off.has('gateway-names'))
  );
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
  rekey: boolean,
): SequenceFlow {
  const sourceRef = canonicalId(sf.sourceRef);
  const targetRef = canonicalId(sf.targetRef);
  return {
    ...sf,
    id: rekey ? `Flow_${sourceRef}_${targetRef}` : sf.id,
    sourceRef,
    targetRef,
  };
}
