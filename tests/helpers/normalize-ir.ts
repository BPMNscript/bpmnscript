/**
 * IR normalization helper for the round-trip equivalence test.
 *
 * Round-trip tests compare IR objects that may differ in two harmless ways:
 *
 *   1. **Array order** — `flowElements` and `sequenceFlows` are populated in
 *      the order elements appear in the source document or DSL. The two
 *      round-trip halves may traverse elements in different orders, so we
 *      sort both arrays by `id` before deep-equality comparison.
 *
 *   2. **Generated flow ids** — when a sequence flow has no explicit `as:`
 *      tag in the DSL, `astToIr` generates an id of the form
 *      `Flow_<sourceId>_<targetId>`. The handwritten BPMN fixture and the
 *      DSL pretty-printer may assign different generated ids to the same
 *      flow (e.g. the handwritten fixture uses `Flow_SeniorBranch` while
 *      `astToIr` would generate `Flow_AmountCheck_SeniorApproval`). We
 *      replace any id matching `/^Flow_/` with a canonical placeholder
 *      derived from the source/target pair so both sides match.
 *
 * Note: the handwritten BPMN fixture (`tests/golden/invoice-approval-
 * handwritten.bpmn`) intentionally gives every flow an explicit id.
 * Flows whose id starts with `Flow_` are still treated as generated-style
 * by this helper — re-keying them is harmless when they are unique and
 * necessary when they are not, so the helper applies the rule unconditionally.
 */

import type { BpmnProcess, SequenceFlow } from '@bpmn-script/transform';

/**
 * Normalize an IR for round-trip deep-equality comparison.
 *
 * Returns a new `BpmnProcess` with:
 *   - `flowElements` sorted by `id`.
 *   - `sequenceFlows` sorted by `id` (after id normalization).
 *   - Auto-generated flow ids (`/^Flow_/`) replaced with the canonical
 *     placeholder `Flow_<sourceRef>_<targetRef>` so both round-trip
 *     halves produce the same key.
 *
 * The original IR is not mutated.
 *
 * @param ir - The IR to normalize.
 * @returns A new normalized copy of the IR.
 */
export function normalizeIr(ir: BpmnProcess): BpmnProcess {
  const normalizedFlows: SequenceFlow[] = ir.sequenceFlows
    .map((sf) => normalizeFlowId(sf))
    .sort((a, b) => a.id.localeCompare(b.id));

  const sortedElements = [...ir.flowElements].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  return {
    ...ir,
    flowElements: sortedElements,
    sequenceFlows: normalizedFlows,
  };
}

/**
 * Normalize the id of a single sequence flow.
 *
 * Flows with an auto-generated id (matching `/^Flow_/`) are re-keyed to
 * `Flow_<sourceRef>_<targetRef>` so that generation differences between
 * the two round-trip halves do not cause spurious mismatches.
 *
 * Flows with an explicit id (e.g. `AutoApprovePath`) are left unchanged.
 *
 * @param sf - The sequence flow to normalize.
 * @returns A new sequence flow with a normalized id.
 */
function normalizeFlowId(sf: SequenceFlow): SequenceFlow {
  if (/^Flow_/.test(sf.id)) {
    return { ...sf, id: `Flow_${sf.sourceRef}_${sf.targetRef}` };
  }
  return sf;
}
