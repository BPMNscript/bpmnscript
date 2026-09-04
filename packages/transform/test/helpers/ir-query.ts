/**
 * Small lookups over an IR container. Each asserts that what it looked for was
 * there, so a caller stays free of null checks and a miss fails where it
 * happened rather than as a downstream `undefined`.
 *
 * Every lookup takes a {@link FlowContainer}, so it serves the root process and
 * a nested sub-process alike.
 */

import { expect } from 'vitest';

import type {
  FlowContainer,
  FlowElement,
  SubProcess,
} from '../../src/ir/types.js';

/** The single flow element of a kind, asserting the container holds one. */
export function only<K extends FlowElement['kind']>(
  container: FlowContainer,
  kind: K,
): Extract<FlowElement, { kind: K }> {
  const matches = container.flowElements.filter((fe) => fe.kind === kind);
  expect(matches).toHaveLength(1);
  return matches[0] as Extract<FlowElement, { kind: K }>;
}

/** The flow element with this id, asserting the container holds one. */
export function byId(container: FlowContainer, id: string): FlowElement {
  const node = container.flowElements.find((fe) => fe.id === id);
  expect(node).toBeDefined();
  return node!;
}

/** The sub-process with this id, asserting the container holds one. */
export function subProcess(container: FlowContainer, id: string): SubProcess {
  const node = container.flowElements.find(
    (fe): fe is SubProcess => fe.kind === 'subProcess' && fe.id === id,
  );
  expect(node).toBeDefined();
  return node!;
}
