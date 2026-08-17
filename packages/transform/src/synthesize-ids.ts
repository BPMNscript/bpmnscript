/**
 * Deterministic synthesized-id utility for BPMNscript.
 *
 * Pure functions: no I/O, no globals, no traversal-order-dependent counters.
 * Every id is derived exclusively from the structural coordinates passed in.
 *
 * These templates change only in lockstep with their consumers (`ast-to-ir.ts`,
 * `ir-to-dsl.ts`, and the round-trip normalizer `tests/helpers/normalize-ir.ts`)
 * because decompile round-trip id stability depends on reproducing them exactly.
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
 * Throw_<X>                         makeThrowEventId      Throw_invoice-approval_2
 * EventSubProcess_<X>               makeEventSubProcessId EventSubProcess_invoice-approval_1
 * Catch_<X>                         makeIntermediateCatchEventId Catch_invoice-approval_1
 * Boundary_<hostId>_<trigger>       makeBoundaryEventId   Boundary_Pack_error
 * Boundary_<hostId>_<trigger>_2     makeBoundaryEventId   (second occurrence of same pair)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `Throw_<X>`, `EventSubProcess_<X>`, and `Catch_<X>` are positional: `<X>` is
 * the statement's unique static position, so they are collision-free by
 * construction and take no `taken` set. The validator reserves those prefixes
 * so an author-chosen name can never occupy one.
 *
 * `Boundary_<hostId>_<trigger>` is host-derived rather than positional, and so
 * takes a `taken` set. Host id and trigger are both authored text that survives
 * a round-trip verbatim, keeping the id put wherever the decompiler places the
 * handler in its container's statement list; a positional coordinate would
 * drift as soon as the printer moves handlers to the end of the body. Two
 * boundaries sharing one host and trigger (two `timer` boundaries, say) collide
 * on the base id and are told apart by the numeric suffix.
 *
 * Collision resolution (used internally and exposed as `resolveCollision`):
 *   - If the base id is not in the taken set, return it unchanged.
 *   - Otherwise try `<base>_2`, `<base>_3`, ... until a free slot is found.
 *   - `makeSequenceFlowId`, `makeStartEventId`, and `makeEndEventId` add the
 *     returned id to the taken set themselves; a caller using
 *     `resolveCollision` directly must record the returned id itself.
 */

// ---------------------------------------------------------------------------
// Gateway / flow id constructors: pure string templates over the enclosing
// compound statement's id (see the table above).
// ---------------------------------------------------------------------------

/** XOR split gateway generated for an `if`: `Gateway_<enclosingId>_split`. */
export function makeGatewaySplitId(enclosingId: string): string {
  return `Gateway_${enclosingId}_split`;
}

/**
 * Convergence gateway: `Gateway_<enclosingId>_join`. Shared by the XOR join
 * (after `if`/`else`) and the AND join (after `parallel`); either way there
 * is exactly one convergence point per enclosing construct id.
 */
export function makeGatewayJoinId(enclosingId: string): string {
  return `Gateway_${enclosingId}_join`;
}

/** AND fork generated for a `parallel` block: `Gateway_<enclosingId>_fork`. */
export function makeGatewayForkId(enclosingId: string): string {
  return `Gateway_${enclosingId}_fork`;
}

/** XOR loop-head gateway for a `while`/do-while: `Gateway_<enclosingId>_loop`. */
export function makeGatewayLoopId(enclosingId: string): string {
  return `Gateway_${enclosingId}_loop`;
}

/** Default (else-branch) flow out of a gateway: `Flow_<gatewayId>_default`. */
export function makeDefaultFlowId(gatewayId: string): string {
  return `Flow_${gatewayId}_default`;
}

/**
 * Id for a plain sequence flow between two elements:
 * `Flow_<sourceId>_<targetId>`, with `_2`/`_3`/... suffixes for repeated
 * occurrences of the same pair. Adds the returned id to `taken`.
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
 * Id for an implicit start event synthesized when the source omits `start`:
 * `StartEvent_<processId>`. There is exactly one implicit start event per
 * process, but the base id can still collide with an author-chosen statement
 * name (e.g. a task literally named `StartEvent_P` in process `P`); such a
 * collision gets a numeric suffix. Adds the returned id to `taken`.
 */
export function makeStartEventId(
  processId: string,
  taken: Set<string>,
): string {
  const base = `StartEvent_${processId}`;
  const id = resolveCollision(base, taken);
  taken.add(id);
  return id;
}

/**
 * Id for an implicit end event synthesized when the source omits `end`:
 * `EndEvent_<processId>`. Multiple implicit ends are allowed; duplicates
 * receive numeric suffixes (`_2`, `_3`, ...). Adds the returned id to `taken`.
 */
export function makeEndEventId(processId: string, taken: Set<string>): string {
  const base = `EndEvent_${processId}`;
  const id = resolveCollision(base, taken);
  taken.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Event id constructors: positional, collision-free by construction
// ---------------------------------------------------------------------------

/**
 * `Throw_<X>` for an unnamed `throw` (typed end event) or `emit` (intermediate
 * throw event). `<X>` is the enclosing-block coordinate joined with the
 * statement index, so the id is unique by position. An author-chosen name is
 * used verbatim instead of this template.
 */
export function makeThrowEventId(x: string): string {
  return `Throw_${x}`;
}

/**
 * `EventSubProcess_<X>` for an `on` handler at structural coordinate `<X>`. The
 * handler body's implicit start/end seed from this id (`StartEvent_<id>` /
 * `EndEvent_<id>`), following the container-id rule.
 */
export function makeEventSubProcessId(x: string): string {
  return `EventSubProcess_${x}`;
}

/**
 * `Catch_<X>` for an `await` (intermediate catch event). Positional like
 * `makeThrowEventId`; `await` carries no authored name, so there is nothing to
 * prefer over the synthesized id.
 */
export function makeIntermediateCatchEventId(x: string): string {
  return `Catch_${x}`;
}

/**
 * `Boundary_<hostId>_<trigger>` for a hosted `on <Host>: <trigger>` handler
 * attached to an activity. Host-derived rather than positional (see the header
 * for why), so it needs collision resolution. Adds the returned id to `taken`.
 */
export function makeBoundaryEventId(
  hostId: string,
  trigger: string,
  taken: Set<string>,
): string {
  const base = `Boundary_${hostId}_${trigger}`;
  const id = resolveCollision(base, taken);
  taken.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Collision resolver
// ---------------------------------------------------------------------------

/**
 * Return the first id in the sequence `base`, `base_2`, `base_3`, ... that is
 * not present in `taken`. Does not mutate `taken`; the caller records the
 * returned id if needed.
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
