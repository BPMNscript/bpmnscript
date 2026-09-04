/**
 * Deterministic ids for BPMN elements the DSL does not name.
 *
 * Every template here is frozen by ADR 0010, Use Deterministic Structural Ids
 * for Synthesized BPMN Elements: the printer recognizes an id it minted by the
 * template that minted it, so a changed template breaks round-trip stability.
 * Templates whose base can collide with an author-chosen name take a `taken`
 * set and claim their result in it; the positional ones are unique by
 * construction.
 */

/** The prefixes the printer matches on to tell a minted id from an authored one. */
export const START_EVENT_PREFIX = 'StartEvent_';
export const END_EVENT_PREFIX = 'EndEvent_';
export const THROW_EVENT_PREFIX = 'Throw_';

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

/** Names the event-based fork a multi-branch wait lowers to. */
export function makeGatewayRaceId(enclosingId: string): string {
  return `Gateway_${enclosingId}_race`;
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
  return claimId(`${START_EVENT_PREFIX}${processId}`, taken);
}

export function makeEndEventId(processId: string, taken: Set<string>): string {
  return claimId(`${END_EVENT_PREFIX}${processId}`, taken);
}

export function makeThrowEventId(coordinate: string): string {
  return `${THROW_EVENT_PREFIX}${coordinate}`;
}

export function makeEventSubProcessId(coordinate: string): string {
  return `EventSubProcess_${coordinate}`;
}

export function makeIntermediateCatchEventId(coordinate: string): string {
  return `Catch_${coordinate}`;
}

/**
 * Host-derived rather than positional, so the id stays put when the decompiler
 * moves handlers to the end of their container's body. Two boundaries sharing a
 * host and trigger collide on the base id and need the numeric suffix.
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
