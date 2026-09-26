/**
 * Deterministic ids for BPMN elements the DSL does not name, and the names
 * error and escalation declarations are written with.
 *
 * Every template here is frozen by ADR 0010, Use Deterministic Structural Ids
 * for Synthesized BPMN Elements: the printer recognizes an id it minted by the
 * template that minted it, so a changed template breaks round-trip stability.
 * Templates whose base can collide with an author-chosen name take a `taken`
 * set and claim their result in it; the positional ones are unique by
 * construction.
 */

import {
  BpmnScriptGrammar,
  ID_TEXT,
  reservedWordsOf,
} from '@bpmn-script/language';

const START_EVENT_PREFIX = 'StartEvent_';
const END_EVENT_PREFIX = 'EndEvent_';
/** The prefixes the printer matches on to tell a minted throw or catch from an authored one. */
export const THROW_EVENT_PREFIX = 'Throw_';
export const CATCH_EVENT_PREFIX = 'Catch_';

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

/**
 * Whether `id` is exactly the start the compiler mints for the container.
 * Exact rather than a prefix test: the Modeler names its default start
 * `StartEvent_1`, which is an authored id like any other and has to print.
 * The validator reserves the same two forms, so a script cannot spell them.
 */
export function isMintedStartId(id: string, containerId: string): boolean {
  return id === `${START_EVENT_PREFIX}${containerId}`;
}

/**
 * The end the compiler mints for the container, or for a boundary escape in
 * it, whose chain ends in `EndEvent_<boundaryId>` inside the host container.
 */
export function isMintedEndId(
  id: string,
  containerId: string,
  boundaryIds: Iterable<string>,
): boolean {
  if (id === `${END_EVENT_PREFIX}${containerId}`) return true;
  for (const boundaryId of boundaryIds) {
    if (id === `${END_EVENT_PREFIX}${boundaryId}`) return true;
  }
  return false;
}

export function makeThrowEventId(coordinate: string): string {
  return `${THROW_EVENT_PREFIX}${coordinate}`;
}

export function makeEventSubProcessId(coordinate: string): string {
  return `EventSubProcess_${coordinate}`;
}

export function makeIntermediateCatchEventId(coordinate: string): string {
  return `${CATCH_EVENT_PREFIX}${coordinate}`;
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

/** The one shape a name in the script has. */
export const ID_SHAPED = ID_TEXT;

/** Whether the script can spell `word` as a name: `ID`-shaped and no keyword. */
export function isWritableName(word: string): boolean {
  return (
    ID_SHAPED.test(word) && !reservedWordsOf(BpmnScriptGrammar()).has(word)
  );
}

/**
 * The name an error or escalation declaration is written with: `preferred`
 * where a declaration could carry it, otherwise one minted from the code. The
 * result is claimed in `taken`, since two codes differing only in punctuation
 * mint the same name and one name written twice leaves every use site
 * ambiguous.
 */
export function claimDeclarationName(
  code: string,
  taken: Set<string>,
  preferred?: string,
): string {
  const base =
    preferred !== undefined && isWritableName(preferred)
      ? preferred
      : mintPrintableName(code);
  return claimId(base, taken);
}

/**
 * The name the script writes for text it cannot spell, an error code or an
 * element id: the word characters kept and the rest replaced. Not claimed
 * here, since the callers resolve collisions against different sets.
 */
export function mintPrintableName(text: string): string {
  const sanitized = isWritableName(text) ? text : text.replace(/\W/g, '_');
  // A keyword lexes as itself rather than as an `ID`, and a word opening on a
  // digit does not lex as one at all, so neither can name a declaration. An
  // underscore fixes both, and no keyword carries one.
  return isWritableName(sanitized) ? sanitized : `_${sanitized}`;
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
