// Each lookup asserts a hit, so a miss fails where it happened.

import { expect } from 'vitest';

import type {
  FlowContainer,
  FlowElement,
  SubProcess,
} from '../../src/ir/types.js';

export function only<K extends FlowElement['kind']>(
  container: FlowContainer,
  kind: K,
): Extract<FlowElement, { kind: K }> {
  const matches = container.flowElements.filter((fe) => fe.kind === kind);
  expect(matches).toHaveLength(1);
  return matches[0] as Extract<FlowElement, { kind: K }>;
}

export function byId(container: FlowContainer, id: string): FlowElement {
  const node = container.flowElements.find((fe) => fe.id === id);
  expect(node).toBeDefined();
  return node!;
}

export function subProcess(container: FlowContainer, id: string): SubProcess {
  const node = container.flowElements.find(
    (fe): fe is SubProcess => fe.kind === 'subProcess' && fe.id === id,
  );
  expect(node).toBeDefined();
  return node!;
}
