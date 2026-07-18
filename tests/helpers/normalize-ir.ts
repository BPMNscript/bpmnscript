/**
 * IR normalization helper for the round-trip equivalence test.
 *
 * The round-trip chain is
 *
 *   handwritten.bpmn → xmlToIr (ir1) → irToDsl → parse → astToIr
 *                    → irToXml → xmlToIr (ir3)
 *
 * `ir1` is imported from the handwritten golden (hand-named ids); `ir3` is the
 * re-synthesized IR after a full round-trip. The two are *semantically*
 * equivalent but differ in three harmless, mechanical ways that this helper
 * canonicalizes away before `toEqual`:
 *
 *   1. **Array order.** `flowElements` / `sequenceFlows` are populated in
 *      document/DSL order, which differs between the two halves. We sort both
 *      arrays by their canonical id.
 *
 *   2. **Generated ids.** The handwritten ids were hand-authored
 *      (`AmountCheck`, `AutoApprovePath`, `Flow_SeniorBranch`); the
 *      round-tripped ids are synthesized deterministically by the id scheme
 *      (`Gateway_<coord>_split`, `Flow_<gatewayId>_default`, `Flow_<src>_<tgt>`).
 *      We re-key every *generated-shaped* id to a structural key derived from
 *      the graph topology so equivalent elements/flows collapse to the same key.
 *
 *   3. **Synthesized pass-through join.** `irToDsl` collapses the hand-named
 *      gateway `AmountCheck` (one split, branches converging directly on
 *      `Done`) into an `if/else`; `astToIr` then re-synthesizes BOTH a split
 *      gateway AND a *new* XOR join node (`Gateway_<coord>_join`) that the
 *      handwritten IR never had. The join is a genuine extra node and an extra
 *      two-hop (`branch → join → Done` vs. the handwritten `branch → Done`).
 *      We inline this one specific shape — a synthesized-family XOR/AND join
 *      with exactly one outgoing flow — treating it as transparent, so the two
 *      halves have the same flow-element set (see {@link inlinePassThroughJoins}).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Concrete handwritten ↔ synthesized reconciliation table for `invoice-approval`:
 *
 *   handwritten (ir1)              synthesized (ir3, round-tripped)
 *   ───────────────────────────    ────────────────────────────────────────
 *   gateway  AmountCheck            Gateway_invoice-approval_2_split
 *   (none)                          Gateway_invoice-approval_2_join   ← inlined
 *   flow     AutoApprovePath        Flow_Gateway_invoice-approval_2_split_default
 *   flow     Flow_SeniorBranch      Flow_Gateway_invoice-approval_2_split_SeniorApproval
 *   flow     Flow_ReviewInvoice_…   Flow_ReviewInvoice_Gateway_…_split
 *   flow     SeniorApproval→Done    SeniorApproval→join→Done  (inlined to →Done)
 *   flow     AutoApprove→Done       AutoApprove→join→Done     (inlined to →Done)
 *   gateway  name "Amount > 1000?"  (no name)                 ← stripped
 *
 *   4. **Elided gateway name.** The handwritten gateway carries a modeler label
 *      (`name: "Amount > 1000?"`). `irToDsl` collapses the gateway into
 *      `if (amount > 1000) { … } else { … }`, and the structured syntax has no
 *      slot to carry a gateway label, so the name is unrecoverable by design
 *      (the language has no `gateway`/edge form). We strip `name` ONLY on
 *      gateway elements; task/event names are load-bearing — they survive the
 *      round-trip verbatim and are never stripped.
 *
 * After inlining the join, re-keying every gateway/flow id to its structural
 * (source→target) form, and stripping the elided gateway name, both halves
 * collapse to an identical `BpmnProcess`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * **Recursion into sub-process containers.** A `subProcess` flow element is
 * itself a container — its own `flowElements`/`sequenceFlows` describe the
 * nested body, and those flows never cross the container boundary. The four
 * canonicalizations above are therefore *per-container*: each nested container
 * needs the same join-inlining, gateway re-keying, flow re-keying, and sorting
 * applied to its own arrays, independently, at every depth. {@link normalizeIr}
 * delegates to {@link normalizeContainer}, which recurses into each nested
 * sub-process. A *plain* sub-process id is an authored name (never
 * gateway-shaped), so it is never re-keyed — only its children are. For a
 * container with no sub-processes the recursion never fires, so flat-IR
 * normalization is byte-identical to before.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * **Event-handler (event sub-process) ids.** An `on` handler lowers to a
 * `triggeredByEvent` sub-process, and — unlike a plain `subprocess` — the DSL
 * has no id slot for it: its id is synthesised from a structural coordinate
 * (`EventSubProcess_<coord>`) that shifts when a round-trip re-orders the
 * container's statements (the restructurer collects throws/ends and re-emits
 * handlers last, so index-derived coordinates move). Its id therefore does not
 * survive verbatim, exactly like a synthesised gateway id — so it is re-keyed
 * to a structural signature drawn from what the handler actually catches:
 * `(trigger kind, code-or-catch-all, interrupting?)` read off the handler's
 * trigger start event. A duplicate signature (which the validator forbids but
 * the IR permits) gets a deterministic positional suffix, mirroring
 * {@link buildGatewayCanonicalIds}. An event sub-process is a *disconnected*
 * node — no sequence flow references it — so re-keying its id needs no flow
 * rewrite. Its children keep their own ids: the trigger `start` and the `end`
 * are authored in the handler body (they print explicitly and survive
 * verbatim), and any nested gateway is re-keyed structurally like any other.
 * A container with no handlers never builds this map, so flat/plain-nested
 * normalization stays byte-identical.
 */

import type {
  BpmnProcess,
  EventDefinition,
  FlowContainer,
  FlowElement,
  SequenceFlow,
} from '@bpmn-script/transform';

/**
 * Matches the synthesized **join** gateway family from the id scheme:
 * `Gateway_<X>_join` (XOR join after `if/else`, AND join after `parallel`).
 * A hand-named gateway (e.g. `AmountCheck`) does not match.
 */
const SYNTHESIZED_JOIN_ID = /^Gateway_.+_join$/;

/**
 * Set of `FlowElement.kind`s that are gateways.
 *
 * The synthesized gateway families are `Gateway_<X>_split | _join | _fork |
 * _loop`; the handwritten gateway is hand-named (`AmountCheck`) and so does NOT
 * match that id shape. To reconcile the hand-name with the synthesized id we
 * therefore re-key *every gateway element* by its structural position rather
 * than gating on the synthesized-id regex — see {@link buildGatewayCanonicalIds}.
 *
 * Non-gateway ids (tasks, events) are NEVER re-keyed: those must survive the
 * round-trip verbatim and are load-bearing assertions in the round-trip test.
 */
const GATEWAY_KINDS = new Set<FlowElement['kind']>([
  'exclusiveGateway',
  'parallelGateway',
]);

/**
 * Normalize an IR for round-trip deep-equality comparison.
 *
 * Pipeline (each step is pure; the input is never mutated):
 *   1. Inline synthesized pass-through join gateways (transparent).
 *   2. Build a structural id map for every gateway element.
 *   3. Re-key gateway elements, every `/^Flow_/`- or generated-shaped flow,
 *      and the gateway `defaultFlowId` to source→target structural keys.
 *   4. Sort both arrays by canonical id.
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
 * Applies the four canonicalizations to this container's own arrays and then
 * descends into each `subProcess` child, so the whole containment tree is
 * normalized bottom-up. Generic over the container type so the root call
 * returns a `BpmnProcess` and the recursive call returns a `SubProcess`,
 * preserving each container's own extra fields (`name`, `isExecutable`, `kind`)
 * through the spread.
 *
 * @param container - The container to normalize.
 * @returns A new normalized copy of the container.
 */
function normalizeContainer<T extends FlowContainer>(container: T): T {
  // Make synthesized pass-through joins transparent so both halves have the
  // same flow-element/flow set before any re-keying.
  const inlined = inlinePassThroughJoins(container);

  // Derive a canonical structural id for every gateway element so the
  // hand-named gateway and the synthesized gateway map identically.
  const gatewayIdMap = buildGatewayCanonicalIds(inlined);

  // Derive a canonical structural id for every event-handler sub-process so a
  // handler whose synthesised coordinate shifted across the round-trip maps
  // identically to its counterpart.
  const handlerIdMap = buildEventSubProcessCanonicalIds(inlined);

  const canonicalId = (id: string): string => gatewayIdMap.get(id) ?? id;

  // Re-key flow-element ids (only gateways are re-keyed) and drop the
  // gateway `name` (only gateways; see below).
  const flowElements: FlowElement[] = inlined.flowElements
    .map((fe) => {
      // A nested container is normalized recursively: its body is its own
      // node/edge set, so it gets the identical per-container pipeline at its
      // own depth. A plain sub-process id is an authored name (never
      // gateway-shaped), so it is preserved verbatim; an event-handler
      // (`triggeredByEvent`) sub-process has no surface id and is re-keyed to
      // its structural trigger signature, exactly like a synthesised gateway.
      if (fe.kind === 'subProcess') {
        const normalized = normalizeContainer(fe);
        return fe.triggeredByEvent === true
          ? { ...normalized, id: handlerIdMap.get(fe.id) ?? fe.id }
          : normalized;
      }
      if (!GATEWAY_KINDS.has(fe.kind)) return fe;
      const id = canonicalId(fe.id);

      // Drop the gateway label: `irToDsl` collapses the gateway into
      // `if (…) { … } else { … }`, and the structured syntax has no slot to
      // carry a gateway label. Only gateways lose their name; task/event names
      // survive the round-trip verbatim and are never stripped here.
      const { name: _name, ...withoutName } = fe;

      // The gateway's `defaultFlowId` points at a flow whose own id we re-key
      // to its source→target form below; re-key the pointer the same way so
      // the hand-named `AutoApprovePath` and the synthesized `Flow_<gw>_default`
      // agree.
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

  // Re-key flow ids to their structural source→target key.
  const sequenceFlows: SequenceFlow[] = inlined.sequenceFlows
    .map((sf) => normalizeFlow(sf, canonicalId))
    .sort((a, b) => a.id.localeCompare(b.id));

  // The spread preserves every field of the concrete container (`name`,
  // `isExecutable`, `kind`) and overrides only the two normalized arrays, so
  // the result genuinely is a `T`; the assertion just tells the compiler that.
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
 * After `irToDsl→astToIr` re-synthesis, an `if/else` always grows a join that
 * the hand-authored IR never had; treating that shape as transparent lets the
 * two halves compare structurally. A node is inlined only when it is a gateway
 * (`exclusiveGateway`/`parallelGateway`), its id matches
 * {@link SYNTHESIZED_JOIN_ID}, and it has exactly one outgoing flow and at
 * least one incoming flow.
 *
 * Operates on a single container's own arrays; {@link normalizeContainer}
 * calls it once per container as it recurses, so a join is only ever inlined
 * against the sibling flows of its own container.
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
    // Exactly one out, at least one in → a transparent convergence point.
    if (outgoing.length === 1 && incoming.length >= 1) {
      successorOf.set(fe.id, outgoing[0].targetRef);
    }
  }

  if (successorOf.size === 0) return ir;

  // Remove the join nodes.
  const flowElements = ir.flowElements.filter((fe) => !successorOf.has(fe.id));

  // Drop each join's single out-flow; redirect every flow that targeted the
  // join to the join's successor instead.
  const sequenceFlows = ir.sequenceFlows
    .filter((sf) => !successorOf.has(sf.sourceRef)) // remove join→successor
    .map((sf) => {
      const successor = successorOf.get(sf.targetRef);
      return successor !== undefined ? { ...sf, targetRef: successor } : sf;
    });

  return { ...ir, flowElements, sequenceFlows };
}

/**
 * Build a map from each gateway's current id to a canonical structural id.
 *
 * A hand-named gateway (`AmountCheck`) and its synthesized counterpart
 * (`Gateway_<coord>_split`) share the identical topological position once the
 * join is inlined (incoming from `{ReviewInvoice}`, outgoing to
 * `{SeniorApproval, AutoApprove}`), so a key derived purely from that adjacency
 * is equal on both halves while being unique per distinct gateway position.
 *
 * The structural key is built only from non-gateway neighbour ids (which
 * survive the round-trip verbatim), so it does not depend on any other
 * gateway's possibly-different id. The gateway `kind` is included so a XOR
 * and an AND gateway in the same position never collapse together.
 *
 * Two gateways of the same `kind` with an identical neighbour signature (same
 * sorted in/out non-gateway neighbours) would map to the same canonical id;
 * same-signature gateways receive a deterministic positional suffix
 * (`#1`, `#2`, …) assigned in `flowElements` order, so distinct gateways
 * always get distinct canonical ids.
 *
 * @param ir - The (already join-inlined) container.
 * @returns Map of `originalGatewayId → canonicalGatewayId`.
 */
function buildGatewayCanonicalIds(ir: FlowContainer): Map<string, string> {
  const map = new Map<string, string>();
  // Track how many gateways have already claimed each structural signature, so a
  // second occurrence gets a distinct positional suffix instead of overwriting.
  const signatureCount = new Map<string, number>();
  for (const fe of ir.flowElements) {
    if (!GATEWAY_KINDS.has(fe.kind)) continue;

    const incoming = ir.sequenceFlows
      .filter((sf) => sf.targetRef === fe.id)
      .map((sf) => sf.sourceRef)
      .sort();
    const outgoing = ir.sequenceFlows
      .filter((sf) => sf.sourceRef === fe.id)
      .map((sf) => sf.targetRef)
      .sort();

    const signature = `Gateway_${fe.kind}_[in:${incoming.join(',')}]_[out:${outgoing.join(',')}]`;
    const seen = signatureCount.get(signature) ?? 0;
    signatureCount.set(signature, seen + 1);
    // The first occurrence keeps the bare signature (so the common single-gateway
    // case is unchanged); subsequent collisions are disambiguated with `#n`.
    const canonical = seen === 0 ? signature : `${signature}#${seen}`;

    map.set(fe.id, canonical);
  }
  return map;
}

/**
 * Build a map from each event-handler sub-process's current id to a canonical
 * structural id derived from what it catches.
 *
 * An `on` handler lowers to a `triggeredByEvent` sub-process whose id is a
 * synthesised coordinate with no surface slot; that coordinate moves when a
 * round-trip re-orders the container's statements, so the id does not survive
 * verbatim. The signature is drawn from the handler's *trigger start event*:
 * the trigger kind (`error`/`escalation`/`message`/`signal`/`timer`/
 * `conditional`/`compensation`), the definition payload that distinguishes two same-kind
 * handlers (see {@link definitionPayloadKey}), and whether the handler is
 * non-interrupting (`alongside`). The payload is what makes two same-kind
 * handlers of the name-keyed or expression-carrying kinds distinguishable: an
 * `on message "A"` and an `on message "B"` in one container share the trigger
 * kind but not the message name, so keying on the name (not just the kind)
 * keeps them apart. Two same-kind handlers with an identical payload in one
 * container are a validator error, so a signature collision cannot arise from a
 * valid program; should the IR contain one anyway, it receives a deterministic
 * positional suffix (`#1`, `#2`, …) assigned in `flowElements` order — the
 * {@link buildGatewayCanonicalIds} treatment.
 *
 * Only `triggeredByEvent` sub-processes are considered; a plain `subprocess`
 * keeps its authored id. A container with no handlers returns an empty map.
 *
 * @param ir - The (already join-inlined) container.
 * @returns Map of `originalHandlerId → canonicalHandlerId`.
 */
function buildEventSubProcessCanonicalIds(
  ir: FlowContainer,
): Map<string, string> {
  const map = new Map<string, string>();
  const signatureCount = new Map<string, number>();
  for (const fe of ir.flowElements) {
    if (fe.kind !== 'subProcess' || fe.triggeredByEvent !== true) continue;

    // The trigger is carried by the handler body's single start event.
    const start = fe.flowElements.find((e) => e.kind === 'startEvent');
    const def = start?.kind === 'startEvent' ? start.eventDefinition : undefined;
    const kind = def?.kind ?? 'unknown';
    const code = definitionPayloadKey(def);
    const interrupting =
      start?.kind === 'startEvent' && start.isInterrupting === false
        ? 'non-interrupting'
        : 'interrupting';

    const signature = `EventSubProcess_[trigger:${kind}]_[code:${code}]_[${interrupting}]`;
    const seen = signatureCount.get(signature) ?? 0;
    signatureCount.set(signature, seen + 1);
    map.set(fe.id, seen === 0 ? signature : `${signature}#${seen}`);
  }
  return map;
}

/**
 * The payload part of a handler's structural signature: whatever distinguishes
 * two handlers of the *same* trigger kind.
 *
 * Each kind contributes exactly the datum the engine (and the DSL) treats as
 * the handler's identity within its kind:
 *
 *   - `error`/`escalation` — the caught code, or a catch-all marker when the
 *     definition names none. This arm is byte-identical to the original
 *     error/escalation keying, so error-and-escalation normalization is
 *     unchanged and the prior round-trip suites stay green.
 *   - `message`/`signal` — the correlation name (the root's identity).
 *   - `timer` — the particle kind and the verbatim time expression, so two
 *     timers in one scope (a legal pattern) with different deadlines stay apart.
 *   - `conditional` — the raw condition body.
 *   - `compensation` — a single constant marker: an undo block is payload-less,
 *     so its identity within its container is just the trigger kind. A
 *     subprocess has at most one undo block, so this can never collide.
 *   - a handler with no definition — a single `<none>` marker (also unchanged).
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
      // Payload-less: an undo block carries no code, name, or expression, so
      // every occurrence keys identically. One undo block per container (a
      // validator rule) makes that constant collision-free.
      return '<compensation>';
    default: {
      const exhaustive: never = def;
      return JSON.stringify(exhaustive);
    }
  }
}

/**
 * Re-key a single sequence flow to a structural source→target key.
 *
 * A flow is re-keyed when either (a) its id starts with `Flow_` (generated
 * flows, including the `Flow_<gatewayId>_default` family), or (b) it touches a
 * gateway on either end (the hand-named `AutoApprovePath` / `Flow_SeniorBranch`).
 * Flows that connect only non-gateway elements with a non-`Flow_` id are left
 * verbatim.
 *
 * The re-keyed id is `Flow_<canonical(source)>_<canonical(target)>`, where
 * `canonical` maps gateway ids to their structural key (so a flow into/out of
 * a gateway keys identically on both halves).
 *
 * @param sf          - The flow to re-key.
 * @param canonicalId - Maps a flow-element id to its canonical id.
 * @returns A new flow with a structural id (or the original if not re-keyed).
 */
function normalizeFlow(
  sf: SequenceFlow,
  canonicalId: (id: string) => string,
): SequenceFlow {
  const touchesGateway =
    canonicalId(sf.sourceRef) !== sf.sourceRef ||
    canonicalId(sf.targetRef) !== sf.targetRef;

  if (/^Flow_/.test(sf.id) || touchesGateway) {
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
