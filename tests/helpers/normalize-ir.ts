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
 *      Each rule below is paired to the exact handwritten-id ↔ synthesized-id
 *      it reconciles.
 *
 *   3. **Synthesized pass-through join.** `irToDsl` collapses the hand-named
 *      gateway `AmountCheck` (one split, branches converging directly on
 *      `Done`) into an `if/else`; `astToIr` then re-synthesizes BOTH a split
 *      gateway AND a *new* XOR join node (`Gateway_<coord>_join`) that the
 *      handwritten IR never had. The join is a genuine extra node and an extra
 *      two-hop (`branch → join → Done` vs. the handwritten `branch → Done`).
 *      We inline this ONE specific shape — a synthesized-family XOR/AND join
 *      with exactly one outgoing flow — treating it as transparent, so the two
 *      halves have the same flow-element set. The rule is deliberately narrow
 *      (see {@link inlinePassThroughJoins}): a non-synthesized join, a join
 *      with more than one out-flow, or any *real* gateway is never inlined, so
 *      a genuinely-missing or mis-targeted gateway/flow still fails the test.
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
 */

import type {
  BpmnProcess,
  FlowElement,
  SequenceFlow,
} from '@bpmn-script/transform';

/**
 * Matches the synthesized **join** gateway family from the id scheme:
 * `Gateway_<X>_join` (XOR join after `if/else`, AND join after `parallel`).
 *
 * Used ONLY by {@link inlinePassThroughJoins}, and only in combination with
 * the structural guard "exactly one outgoing flow". A hand-named gateway
 * (e.g. `AmountCheck`) does NOT match, so this rule cannot accidentally
 * delete a real convergence node.
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
  // Step 1 — make synthesized pass-through joins transparent so both halves
  // have the same flow-element/flow set before any re-keying.
  const inlined = inlinePassThroughJoins(ir);

  // Step 2 — derive a canonical structural id for every gateway element so
  // the hand-named gateway and the synthesized gateway map identically.
  const gatewayIdMap = buildGatewayCanonicalIds(inlined);

  const canonicalId = (id: string): string => gatewayIdMap.get(id) ?? id;

  // Step 3a — re-key flow-element ids (only gateways are re-keyed) and drop the
  // gateway `name` (only gateways; see below).
  const flowElements: FlowElement[] = inlined.flowElements
    .map((fe) => {
      if (!GATEWAY_KINDS.has(fe.kind)) return fe;
      const id = canonicalId(fe.id);

      // **Reconciles:** the hand-named gateway's modeler label
      // `name: "Amount > 1000?"` against the synthesized gateway, which has NO
      // name. `irToDsl` collapses the gateway into
      // `if (amount > 1000) { … } else { … }`, and the structured syntax has no
      // slot to carry a gateway label — so the name is unrecoverable by design
      // (the language has no `gateway`/edge form). We strip the name ONLY on
      // gateways; task/event names are load-bearing and DO survive the
      // round-trip verbatim, so they are never stripped here.
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

  // Step 3b — re-key flow ids to their structural source→target key.
  const sequenceFlows: SequenceFlow[] = inlined.sequenceFlows
    .map((sf) => normalizeFlow(sf, canonicalId))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    ...ir,
    flowElements,
    sequenceFlows,
  };
}

/**
 * Inline (remove) synthesized pass-through join gateways, redirecting every
 * flow that targets the join straight to the join's single successor.
 *
 * **Reconciles:** ir3's extra `Gateway_<coord>_join` node (and the resulting
 * `branch → join → Done` two-hop) against ir1's direct `branch → Done`. After
 * `irToDsl→astToIr` re-synthesis, an `if/else` always grows a join that the
 * hand-authored IR never had; treating that one specific shape as transparent
 * lets the two halves compare structurally.
 *
 * **Narrowness guarantees (each is a guard, not a heuristic):**
 *   - The node must be a gateway (`exclusiveGateway`/`parallelGateway`).
 *   - Its id must match {@link SYNTHESIZED_JOIN_ID} — a hand-named or non-join
 *     gateway is left untouched.
 *   - It must have **exactly one** outgoing flow. A join that fans out to more
 *     than one successor is NOT a pass-through and is left untouched.
 *   - It must have at least one incoming flow (otherwise there is nothing to
 *     redirect and the join is structurally meaningful as a source).
 *
 * A *real* gateway — one the user authored, or one with multiple out-edges, or
 * one whose absence changes routing — never matches all four guards, so a
 * genuinely-missing or mis-wired gateway still fails the equality assertion.
 *
 * @param ir - The IR to inline joins in.
 * @returns A new IR with pass-through joins removed and flows redirected.
 */
function inlinePassThroughJoins(ir: BpmnProcess): BpmnProcess {
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
 * **Reconciles:** the hand-named gateway `AmountCheck` with the synthesized
 * `Gateway_<coord>_split`. Both gateways have the identical
 * topological position once the join is inlined (incoming from
 * `{ReviewInvoice}`, outgoing to `{SeniorApproval, AutoApprove}`), so a key
 * derived purely from that adjacency is equal on both halves while being
 * unique per distinct gateway position.
 *
 * The structural key is built ONLY from non-gateway neighbour ids (which
 * survive the round-trip verbatim), so it does not depend on any other
 * gateway's possibly-different id. The gateway `kind` is included so a XOR
 * and an AND gateway in the same position never collapse together.
 *
 * **Collision handling:** two gateways of the same `kind` with an identical
 * neighbour signature (same sorted in/out non-gateway neighbours) would map to
 * the same canonical id. Rather than silently collapse them — which could mask a
 * genuine structural difference — same-signature gateways receive a
 * deterministic positional suffix (`#1`, `#2`, …) assigned in `flowElements`
 * order, so distinct gateways always get distinct canonical ids.
 *
 * @param ir - The (already join-inlined) IR.
 * @returns Map of `originalGatewayId → canonicalGatewayId`.
 */
function buildGatewayCanonicalIds(ir: BpmnProcess): Map<string, string> {
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
 * Re-key a single sequence flow.
 *
 * **Reconciles** (all to a structural source→target key):
 *   - the synthesized `/^Flow_/` generated flows
 *     (e.g. `Flow_ReviewStart_ReviewInvoice`,
 *     `Flow_Gateway_<coord>_split_SeniorApproval`),
 *   - the synthesized default flow `Flow_<gatewayId>_default`,
 *   - the hand-authored flow ids that are NOT in `Flow_<src>_<tgt>` form but
 *     still connect a gateway: `AutoApprovePath` and `Flow_SeniorBranch`.
 *
 * A flow is re-keyed when either (a) its id starts with `Flow_` (the original
 * generated-flow rule, now also catching the `_default` family), or (b) it
 * touches a gateway on either end (so the hand-named `AutoApprovePath` /
 * `Flow_SeniorBranch`, which start a hand-named gateway, are reconciled with
 * their synthesized counterparts). Flows that connect only non-gateway elements
 * with a non-`Flow_` id are left verbatim — there are none in scope, and
 * leaving them keeps the rule from masking a hand-id mismatch between
 * non-gateway nodes.
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
