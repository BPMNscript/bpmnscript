/**
 * Deterministic ids for BPMN elements the DSL does not name.
 *
 * Every template here is frozen by ADR 0010, Use Deterministic Structural Ids
 * for Synthesized BPMN Elements. `ast-to-ir.ts`, `ir-to-dsl.ts` and the
 * round-trip normalizer all reproduce these strings verbatim, so a changed
 * template breaks decompile round-trip stability. Templates whose base can
 * collide with an author-chosen name take a `taken` set and claim their result
 * in it; the positional ones are unique by construction.
 */

export function makeGatewaySplitId(enclosingId: string): string {
  return `Gateway_${enclosingId}_split`;
}

/** Shared by the XOR join after `if`/`else` and the AND join after `parallel`. */
export function makeGatewayJoinId(enclosingId: string): string {
  return `Gateway_${enclosingId}_join`;
}

export function makeGatewayForkId(enclosingId: string): string {
  return `Gateway_${enclosingId}_fork`;
}

export function makeGatewayLoopId(enclosingId: string): string {
  return `Gateway_${enclosingId}_loop`;
}

export function makeDefaultFlowId(gatewayId: string): string {
  return `Flow_${gatewayId}_default`;
}

export function makeSequenceFlowId(
  sourceId: string,
  targetId: string,
  taken: Set<string>,
): string {
  return claimId(`Flow_${sourceId}_${targetId}`, taken);
}

export function makeStartEventId(
  processId: string,
  taken: Set<string>,
): string {
  return claimId(`StartEvent_${processId}`, taken);
}

export function makeEndEventId(processId: string, taken: Set<string>): string {
  return claimId(`EndEvent_${processId}`, taken);
}

export function makeThrowEventId(coordinate: string): string {
  return `Throw_${coordinate}`;
}

export function makeEventSubProcessId(coordinate: string): string {
  return `EventSubProcess_${coordinate}`;
}

export function makeIntermediateCatchEventId(coordinate: string): string {
  return `Catch_${coordinate}`;
}

/**
 * Host-derived rather than positional, so the id stays put when the decompiler
 * moves handlers to the end of their container's body. Two boundaries sharing
 * a host and trigger collide on the base id and need the numeric suffix.
 */
export function makeBoundaryEventId(
  hostId: string,
  trigger: string,
  taken: Set<string>,
): string {
  return claimId(`Boundary_${hostId}_${trigger}`, taken);
}

function claimId(base: string, taken: Set<string>): string {
  const id = resolveCollision(base, taken);
  taken.add(id);
  return id;
}

/** First free id in `base`, `base_2`, `base_3`, ... Does not mutate `taken`. */
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
