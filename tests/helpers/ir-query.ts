/**
 * Small lookups over an IR container that the round-trip suites all reach for.
 */

import type { FlowContainer, FlowElement } from '@bpmn-script/transform';

/** The `kind` of the element with this id, or `undefined` if it is not here. */
export function kindOf(
  container: FlowContainer,
  id: string,
): string | undefined {
  return container.flowElements.find((fe) => fe.id === id)?.kind;
}

/** The ids of every direct flow element of a container. */
export function idsOf(container: FlowContainer): Set<string> {
  return new Set(container.flowElements.map((fe) => fe.id));
}

/**
 * The sub-process with this id, throwing when the container does not hold one.
 * Throwing rather than returning `undefined` keeps the caller free of null
 * checks, and a missing sub-process is always a test failure.
 */
export function subProcess(
  container: FlowContainer,
  id: string,
): Extract<FlowElement, { kind: 'subProcess' }> {
  const el = container.flowElements.find(
    (fe) => fe.kind === 'subProcess' && fe.id === id,
  );
  if (el === undefined || el.kind !== 'subProcess') {
    throw new Error(
      `expected a sub-process '${id}' in container '${container.id}'`,
    );
  }
  return el;
}
