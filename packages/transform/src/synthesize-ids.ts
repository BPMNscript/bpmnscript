/**
 * Deterministic ids for elements the DSL does not name. Templates are frozen
 * (ADR 0010): the printer recognizes a minted id by its template, so changing
 * one breaks round-trip stability.
 */

import {
  BpmnScriptGrammar,
  ID_TEXT,
  reservedWordsOf,
} from '@bpmn-script/language';

const START_EVENT_PREFIX = 'StartEvent_';
const END_EVENT_PREFIX = 'EndEvent_';
export const THROW_EVENT_PREFIX = 'Throw_';
export const CATCH_EVENT_PREFIX = 'Catch_';

export function makeGatewaySplitId(enclosingId: string): string {
  return `Gateway_${enclosingId}_split`;
}

export function makeGatewayJoinId(enclosingId: string): string {
  return `Gateway_${enclosingId}_join`;
}

export function makeGatewayForkId(enclosingId: string): string {
  return `Gateway_${enclosingId}_fork`;
}

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

export function endIdOf(containerId: string): string {
  return `${END_EVENT_PREFIX}${containerId}`;
}

export function makeEndEventId(processId: string, taken: Set<string>): string {
  return claimId(endIdOf(processId), taken);
}

/**
 * Exact, not a prefix test: the Modeler's `StartEvent_1` is authored and must
 * print. The validator reserves the same forms.
 */
export function isMintedStartId(id: string, containerId: string): boolean {
  return id === `${START_EVENT_PREFIX}${containerId}`;
}

export function isMintedEndId(
  id: string,
  containerId: string,
  boundaryIds: Iterable<string>,
): boolean {
  if (id === endIdOf(containerId)) return true;
  for (const boundaryId of boundaryIds) {
    if (id === endIdOf(boundaryId)) return true;
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

/** Host-derived, so the id survives handlers moving to the end of the body. */
export function makeBoundaryEventId(
  hostId: string,
  trigger: string,
  taken: Set<string>,
): string {
  return claimId(boundaryEventIdBase(hostId, trigger), taken);
}

export function boundaryEventIdBase(hostId: string, trigger: string): string {
  return `Boundary_${hostId}_${trigger}`;
}

export function claimId(base: string, taken: Set<string>): string {
  const id = resolveCollision(base, taken);
  taken.add(id);
  return id;
}

export function isWritableName(word: string): boolean {
  return ID_TEXT.test(word) && !reservedWordsOf(BpmnScriptGrammar()).has(word);
}

/**
 * Claimed in `taken`: codes differing only in punctuation mint the same name,
 * which would make every use site ambiguous.
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

export function mintPrintableName(text: string): string {
  const sanitized = isWritableName(text) ? text : text.replace(/\W/g, '_');
  // Keywords and digit-led words do not lex as `ID`; a leading underscore
  // fixes both, and no keyword has one.
  return isWritableName(sanitized) ? sanitized : `_${sanitized}`;
}

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
