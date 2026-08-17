/**
 * IR normalization helper for the round-trip equivalence tests.
 *
 * The round-trip chain is
 *
 *   handwritten.bpmn -> xmlToIr (ir1) -> irToDsl -> parse -> astToIr
 *                    -> irToXml -> xmlToIr (ir3)
 *
 * `ir1` comes from the handwritten golden (hand-named ids), `ir3` from a full
 * round-trip. The two are semantically equivalent but differ mechanically, and
 * this helper canonicalizes the differences away before `toEqual`:
 *
 *   1. Array order. `flowElements` / `sequenceFlows` follow document/DSL order,
 *      which differs between the halves, so both arrays are sorted by canonical id.
 *
 *   2. Generated ids. Hand-authored ids (`AmountCheck`, `Flow_SeniorBranch`) meet
 *      deterministically synthesized ones (`Gateway_<coord>_split`,
 *      `Flow_<gatewayId>_default`, `Flow_<src>_<tgt>`), so every synthesized-shaped
 *      id is re-keyed to a structural key derived from the graph topology.
 *
 *   3. Synthesized pass-through join. `astToIr` re-synthesizes an `if/else` as a
 *      split gateway plus a join node the handwritten IR never had, adding a hop
 *      (`branch -> join -> Done` vs `branch -> Done`). A synthesized-family join
 *      with exactly one outgoing flow is inlined as transparent, so both halves
 *      have the same flow-element set (see {@link inlinePassThroughJoins}).
 *
 *   4. Elided gateway name. A modeler label on a gateway (`name: "Amount > 1000?"`)
 *      has no slot in `if (...) { ... } else { ... }`, so gateway names are
 *      stripped. Task and event names are load-bearing, survive verbatim, and are
 *      never stripped.
 *
 * A `subProcess` is itself a container whose flows never cross its boundary, so
 * all four steps run per container at every depth ({@link normalizeContainer}
 * recurses). A plain sub-process id is authored and never re-keyed, only its
 * children are.
 *
 * Three node families carry an id the DSL cannot express, so each is re-keyed to
 * a structural signature instead ({@link buildCanonicalIds} runs the shared
 * dedupe, one signature function per family):
 *
 *   - gateways, by adjacency ({@link gatewaySignature});
 *   - event sub-processes (`on` handlers), whose `EventSubProcess_<coord>` id
 *     shifts when a round-trip re-orders the container's statements, by what the
 *     handler catches ({@link eventSubProcessSignature});
 *   - boundary events, whose `_2`/`_3` collision suffix is positional and can
 *     flip on import, by host, trigger kind, payload, and interrupting
 *     ({@link boundarySignature}).
 *
 * A boundary event has outgoing flow, so its canonical id must also reach the
 * flows leaving it; an event sub-process is disconnected and needs no flow
 * rewrite.
 */

import type {
  BpmnProcess,
  EventDefinition,
  FlowContainer,
  FlowElement,
  SequenceFlow,
} from '@bpmn-script/transform';

/**
 * Matches the synthesized join gateway family from the id scheme:
 * `Gateway_<X>_join` (XOR join after `if/else`, AND join after `parallel`).
 * A hand-named gateway does not match.
 */
const SYNTHESIZED_JOIN_ID = /^Gateway_.+_join$/;

/**
 * Every gateway element is re-keyed by structural position rather than by the
 * synthesized-id regex, because the handwritten counterpart is hand-named and
 * does not match that shape. Non-gateway ids (tasks, events) are never re-keyed:
 * they must survive the round-trip verbatim.
 */
const GATEWAY_KINDS = new Set<FlowElement['kind']>([
  'exclusiveGateway',
  'parallelGateway',
]);

/**
 * Normalize an IR for round-trip deep-equality comparison. Pure: the input is
 * never mutated.
 *
 * @param ir - The IR to normalize.
 * @returns A new normalized copy of the IR.
 */
export function normalizeIr(ir: BpmnProcess): BpmnProcess {
  return normalizeContainer(ir);
}

/**
 * Normalize a single {@link FlowContainer} (the root process or a nested
 * sub-process) and, recursively, every sub-process it contains.
 *
 * Generic over the container type so the root call returns a `BpmnProcess` and
 * the recursive call a `SubProcess`, each keeping its own extra fields (`name`,
 * `isExecutable`, `kind`) through the spread.
 *
 * @param container - The container to normalize.
 * @returns A new normalized copy of the container.
 */
function normalizeContainer<T extends FlowContainer>(container: T): T {
  // Inlining first gives both halves the same flow-element set before re-keying.
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
      // A plain sub-process id is authored and preserved verbatim; an
      // event-handler (`triggeredByEvent`) sub-process has no surface id and is
      // re-keyed to its structural trigger signature.
      if (fe.kind === 'subProcess') {
        const normalized = normalizeContainer(fe);
        return fe.triggeredByEvent === true
          ? { ...normalized, id: handlerIdMap.get(fe.id) ?? fe.id }
          : normalized;
      }

      // Only the boundary event's own id moves; `attachedToRef` is an authored
      // host id and stays untouched.
      if (fe.kind === 'boundaryEvent') {
        return { ...fe, id: canonicalId(fe.id) };
      }

      if (!GATEWAY_KINDS.has(fe.kind)) return fe;
      const id = canonicalId(fe.id);

      // The structured syntax has no slot for a gateway label, so only gateways
      // lose their name. Task and event names survive the round-trip verbatim.
      const { name: _name, ...withoutName } = fe;

      // `defaultFlowId` points at a flow whose own id is re-keyed below, so the
      // pointer is re-keyed the same way.
      if (fe.kind === 'exclusiveGateway' && fe.defaultFlowId !== undefined) {
        const target = inlined.sequenceFlows.find(
          (sf) => sf.id === fe.defaultFlowId,
        );
        const defaultFlowId =
          target !== undefined
            ? canonicalFlowKey(target, canonicalId)
            : fe.defaultFlowId;
        return { ...withoutName, id, defaultFlowId };
      }
      return { ...withoutName, id };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const sequenceFlows: SequenceFlow[] = inlined.sequenceFlows
    .map((sf) => normalizeFlow(sf, canonicalId))
    .sort((a, b) => a.id.localeCompare(b.id));

  // The spread overrides only the two normalized arrays and keeps every other
  // field, so the result really is a `T`; the assertion tells the compiler that.
  return {
    ...container,
    flowElements,
    sequenceFlows,
  } as T;
}

/**
 * Inline (remove) synthesized pass-through join gateways, redirecting every
 * flow that targets the join straight to the join's single successor.
 *
 * After re-synthesis an `if/else` always grows a join that the hand-authored IR
 * never had; treating that shape as transparent lets the two halves compare
 * structurally. A node is inlined only when it is a gateway, its id matches
 * {@link SYNTHESIZED_JOIN_ID}, and it has exactly one outgoing and at least one
 * incoming flow. It runs per container, so a join is only ever inlined against
 * the sibling flows of its own container.
 *
 * @param ir - The container to inline joins in.
 * @returns A new container with pass-through joins removed and flows redirected.
 */
function inlinePassThroughJoins(ir: FlowContainer): FlowContainer {
  // Identify the inlinable joins and remember each one's single successor.
  const successorOf = new Map<string, string>();
  for (const fe of ir.flowElements) {
    if (!GATEWAY_KINDS.has(fe.kind)) continue;
    if (!SYNTHESIZED_JOIN_ID.test(fe.id)) continue;

    const outgoing = ir.sequenceFlows.filter((sf) => sf.sourceRef === fe.id);
    const incoming = ir.sequenceFlows.filter((sf) => sf.targetRef === fe.id);
    // Exactly one out, at least one in: a transparent convergence point.
    if (outgoing.length === 1 && incoming.length >= 1) {
      successorOf.set(fe.id, outgoing[0].targetRef);
    }
  }

  if (successorOf.size === 0) return ir;

  const flowElements = ir.flowElements.filter((fe) => !successorOf.has(fe.id));

  // Drop each join's single out-flow; redirect every flow that targeted the
  // join to the join's successor instead.
  const sequenceFlows = ir.sequenceFlows
    .filter((sf) => !successorOf.has(sf.sourceRef))
    .map((sf) => {
      const successor = successorOf.get(sf.targetRef);
      return successor !== undefined ? { ...sf, targetRef: successor } : sf;
    });

  return { ...ir, flowElements, sequenceFlows };
}

/**
 * Build a map from the current id of every element `signatureOf` accepts to a
 * canonical structural id derived from the graph rather than from the id.
 * Returning `undefined` skips an element, so each family's signature function
 * also decides its own membership. Two elements that produce the same signature
 * are disambiguated by a positional suffix (`#1`, `#2`, ...) assigned in
 * `flowElements` order.
 *
 * @param ir          - The (already join-inlined) container.
 * @param signatureOf - Structural signature, or `undefined` to skip.
 * @returns Map of original id to canonical id, empty when nothing matches.
 */
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

/**
 * A gateway keyed by its adjacency.
 *
 * A hand-named gateway and its synthesized counterpart share a topological
 * position once the join is inlined, so a key derived from that adjacency is
 * equal on both halves and unique per gateway position. The key uses only
 * neighbour ids (which survive the round-trip verbatim) plus the gateway `kind`,
 * so a XOR and an AND gateway in the same position never collapse together.
 */
function gatewaySignature(
  fe: FlowElement,
  ir: FlowContainer,
): string | undefined {
  if (!GATEWAY_KINDS.has(fe.kind)) return undefined;

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

/**
 * An event-handler sub-process keyed by what it catches.
 *
 * An `on` handler lowers to a `triggeredByEvent` sub-process whose id is a
 * synthesised coordinate with no surface slot, and that coordinate moves when a
 * round-trip re-orders the container's statements. The signature is read off the
 * handler's trigger start event instead: trigger kind, the payload that tells two
 * same-kind handlers apart (see {@link definitionPayloadKey}), and whether the
 * handler is non-interrupting. Keying on the payload keeps `on message "A"` and
 * `on message "B"` distinct. An identical signature is a validator error, so it
 * cannot arise from a valid program.
 *
 * A plain `subprocess` keeps its authored id and is skipped.
 */
function eventSubProcessSignature(fe: FlowElement): string | undefined {
  if (fe.kind !== 'subProcess' || fe.triggeredByEvent !== true)
    return undefined;

  // The trigger is carried by the handler body's single start event.
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

/**
 * A boundary event keyed by what it is attached to and what it catches.
 *
 * A hosted `on <Host>: <trigger>` handler lowers to a `boundaryEvent` with a
 * host-derived id (`Boundary_<hostId>_<trigger>`, collisions resolved with a
 * positional `_2`/`_3` suffix). That suffix is stable when generating but not on
 * import: `on Pack: error "A"` and `on Pack: error "B"` both base to
 * `Boundary_Pack_error`, and moddle may present the two children in either
 * order, so which one owns the `_2` is positional. The signature is therefore
 * built from the authored host id (`attachedToRef`), the trigger kind, the
 * definition payload (see {@link definitionPayloadKey}), and `cancelActivity`.
 * A duplicate signature is unreachable from a valid program (the validator's
 * duplicate check forbids it).
 */
function boundarySignature(fe: FlowElement): string | undefined {
  if (fe.kind !== 'boundaryEvent') return undefined;

  const code = definitionPayloadKey(fe.eventDefinition);
  const interrupting =
    fe.cancelActivity === false ? 'non-interrupting' : 'interrupting';

  return `Boundary_[host:${fe.attachedToRef}]_[trigger:${fe.eventDefinition.kind}]_[code:${code}]_[${interrupting}]`;
}

/**
 * The payload part of a handler's structural signature: whatever distinguishes
 * two handlers of the same trigger kind. Each kind contributes the datum the
 * engine and the DSL treat as the handler's identity within that kind:
 *
 *   - `error`/`escalation`: the caught code, or a catch-all marker when the
 *     definition names none.
 *   - `message`/`signal`: the correlation name.
 *   - `timer`: the particle kind and the verbatim time expression, so two timers
 *     in one scope with different deadlines stay apart.
 *   - `conditional`: the raw condition body.
 *   - `compensation`: a constant marker, since an undo block is payload-less.
 *
 * @param def - The handler trigger start's event definition, or `undefined`.
 * @returns A string that is equal for two structurally-equivalent handlers and
 *   distinct for two same-kind handlers that differ in payload.
 */
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
      // One undo block per container is a validator rule, so the constant is
      // collision-free.
      return '<compensation>';
    default: {
      const exhaustive: never = def;
      return JSON.stringify(exhaustive);
    }
  }
}

/**
 * Re-key a single sequence flow to a structural source-to-target key.
 *
 * A flow is re-keyed when its id starts with `Flow_` (the generated families) or
 * it touches a re-keyed node on either end, a gateway or a boundary event.
 * Flows that connect only untouched elements under a non-`Flow_` id are left
 * verbatim.
 *
 * @param sf          - The flow to re-key.
 * @param canonicalId - Maps a flow-element id to its canonical id.
 * @returns A new flow with a structural id (or the original if not re-keyed).
 */
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

/**
 * The canonical structural key for a flow: `Flow_<canonicalSource>_<canonicalTarget>`.
 *
 * Both the flow id and (separately) a gateway's `defaultFlowId` pointer are
 * keyed through this single function so they agree.
 */
function canonicalFlowKey(
  sf: SequenceFlow,
  canonicalId: (id: string) => string,
): string {
  return `Flow_${canonicalId(sf.sourceRef)}_${canonicalId(sf.targetRef)}`;
}
