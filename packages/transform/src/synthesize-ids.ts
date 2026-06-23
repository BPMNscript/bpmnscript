/**
 * Deterministic synthesized-id utility for BPMNscript.
 *
 * Pure functions — no I/O, no globals, no traversal-order-dependent counters.
 * Every id is derived exclusively from the structural coordinates passed in.
 *
 * ============================================================================
 * FROZEN ID CONTRACT (consumed by astToIr, irToDsl, and the round-trip normalizer)
 * ============================================================================
 *
 * Change any template here ONLY after updating the round-trip normalizer
 * (`tests/helpers/normalize-ir.ts`) and the desugaring / restructuring
 * transforms that call these helpers.
 *
 * Template                          Produced by           Example
 * ──────────────────────────────────────────────────────────────────────────
 * Gateway_<X>_split                 makeGatewaySplitId    Gateway_AmountCheck_split
 * Gateway_<X>_join                  makeGatewayJoinId     Gateway_AmountCheck_join
 * Gateway_<X>_fork                  makeGatewayForkId     Gateway_Step1_fork
 * Gateway_<X>_loop                  makeGatewayLoopId     Gateway_MyWhile_loop
 * Flow_<gatewayId>_default          makeDefaultFlowId     Flow_Gateway_AmountCheck_split_default
 * Flow_<sourceId>_<targetId>        makeSequenceFlowId    Flow_ReviewInvoice_AmountCheck
 * Flow_<sourceId>_<targetId>_2      makeSequenceFlowId    (second occurrence of same pair)
 * Flow_<sourceId>_<targetId>_3      makeSequenceFlowId    (third occurrence, etc.)
 * StartEvent_<processId>            makeStartEventId      StartEvent_invoice-approval
 * EndEvent_<processId>              makeEndEventId        EndEvent_invoice-approval
 * EndEvent_<processId>_2            makeEndEventId        (second implicit end)
 * EndEvent_<processId>_3            makeEndEventId        (third implicit end, etc.)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Collision resolution (used internally and exposed as `resolveCollision`):
 *   - If the base id is not in the taken set → return it unchanged.
 *   - Otherwise try `<base>_2`, `<base>_3`, … until a free slot is found.
 *   - The caller is responsible for adding the returned id to the taken set
 *     when using `resolveCollision` directly; `makeSequenceFlowId` and
 *     `makeEndEventId` update the set themselves.
 */

// ---------------------------------------------------------------------------
// Gateway id constructors
// ---------------------------------------------------------------------------

/**
 * Id for the XOR split gateway generated for an `if` statement.
 *
 * @param enclosingId  The id of the enclosing `if` statement or block coordinate.
 * @returns `Gateway_<enclosingId>_split`
 */
export function makeGatewaySplitId(enclosingId: string): string {
  return `Gateway_${enclosingId}_split`;
}

/**
 * Id for the XOR join gateway generated for an `if` statement or
 * the AND join gateway generated for a `parallel` block.
 *
 * Both the XOR join (after `if`/`else`) and the AND join (after `parallel`)
 * use this template because in both cases we need exactly one convergence
 * point per enclosing construct id.
 *
 * @param enclosingId  The id of the enclosing `if` or `parallel` statement.
 * @returns `Gateway_<enclosingId>_join`
 */
export function makeGatewayJoinId(enclosingId: string): string {
  return `Gateway_${enclosingId}_join`;
}

/**
 * Id for the AND fork (parallel split) gateway generated for a `parallel` block.
 *
 * @param enclosingId  The id of the enclosing `parallel` statement.
 * @returns `Gateway_<enclosingId>_fork`
 */
export function makeGatewayForkId(enclosingId: string): string {
  return `Gateway_${enclosingId}_fork`;
}

/**
 * Id for the XOR loop-head gateway generated for a `while` or do-while statement.
 *
 * @param enclosingId  The id of the enclosing `while` statement.
 * @returns `Gateway_<enclosingId>_loop`
 */
export function makeGatewayLoopId(enclosingId: string): string {
  return `Gateway_${enclosingId}_loop`;
}

// ---------------------------------------------------------------------------
// Flow id constructors
// ---------------------------------------------------------------------------

/**
 * Id for the default (else-branch) flow out of a gateway.
 *
 * @param gatewayId  The id of the gateway element.
 * @returns `Flow_<gatewayId>_default`
 */
export function makeDefaultFlowId(gatewayId: string): string {
  return `Flow_${gatewayId}_default`;
}

/**
 * Id for a plain sequence flow between two elements.
 *
 * Implements the sequence-flow id collision rule (the caller is `addFlow` in `ast-to-ir.ts`):
 *   - First occurrence of a `source → target` pair → `Flow_<sourceId>_<targetId>`
 *   - Second occurrence → `Flow_<sourceId>_<targetId>_2`
 *   - Third → `_3`, and so on.
 *
 * **Side effect:** the returned id is added to `taken` so that subsequent
 * calls with the same `sourceId`/`targetId` pair automatically receive the
 * next free suffix.
 *
 * @param sourceId  Id of the source flow element.
 * @param targetId  Id of the target flow element.
 * @param taken     Mutable set of ids already in use; updated in place.
 * @returns A unique, deterministic sequence flow id.
 */
export function makeSequenceFlowId(
  sourceId: string,
  targetId: string,
  taken: Set<string>,
): string {
  const base = `Flow_${sourceId}_${targetId}`;
  const id = resolveCollision(base, taken);
  taken.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Implicit start / end event id constructors
// ---------------------------------------------------------------------------

/**
 * Id for an implicit start event synthesized when the source omits `start`.
 *
 * There is exactly one implicit start event per process, but its base id
 * (`StartEvent_<processId>`) can still collide with an author-chosen statement
 * name (e.g. a task literally named `StartEvent_P` in process `P`). The `taken`
 * set guards against that: a collision is resolved with a numeric suffix via
 * {@link resolveCollision}, exactly as {@link makeEndEventId} does.
 *
 * **Side effect:** the returned id is added to `taken`.
 *
 * @param processId  The id of the enclosing process.
 * @param taken      Mutable set of ids already in use; updated in place.
 * @returns A unique, deterministic start event id (`StartEvent_<processId>`,
 *          or a `_2`/`_3`/… suffixed form on collision).
 */
export function makeStartEventId(processId: string, taken: Set<string>): string {
  const base = `StartEvent_${processId}`;
  const id = resolveCollision(base, taken);
  taken.add(id);
  return id;
}

/**
 * Id for an implicit end event synthesized when the source omits `end`.
 *
 * Multiple implicit ends are allowed; duplicates receive numeric suffixes
 * (`_2`, `_3`, …) via {@link resolveCollision}.
 *
 * **Side effect:** the returned id is added to `taken`.
 *
 * @param processId  The id of the enclosing process.
 * @param taken      Mutable set of ids already in use; updated in place.
 * @returns A unique, deterministic end event id.
 */
export function makeEndEventId(
  processId: string,
  taken: Set<string>,
): string {
  const base = `EndEvent_${processId}`;
  const id = resolveCollision(base, taken);
  taken.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Collision resolver
// ---------------------------------------------------------------------------

/**
 * Return a deterministic unique id derived from `base` that is not present
 * in `taken`.
 *
 * Strategy:
 *   - If `base` is not taken → return `base` unchanged.
 *   - Otherwise try `<base>_2`, `<base>_3`, … until a free slot is found.
 *
 * Does **not** mutate `taken`. The caller is responsible for recording the
 * returned id if needed.
 *
 * @param base   Preferred id.
 * @param taken  Set of ids already in use.
 * @returns The first id in the sequence `base`, `base_2`, `base_3`, … that
 *          is not present in `taken`.
 */
export function resolveCollision(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    return base;
  }

  let counter = 2;
  while (taken.has(`${base}_${counter}`)) {
    counter += 1;
  }
  return `${base}_${counter}`;
}
