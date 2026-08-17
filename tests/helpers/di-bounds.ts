/**
 * Reading BPMN DI shape geometry out of generated XML, for the round-trip
 * suites that assert where `bpmn-auto-layout` put things.
 *
 * The suites keep their own DI assertions; only the geometry plumbing they all
 * need lives here.
 */

import { expect } from 'vitest';

import type { FlowContainer } from '@bpmn-script/transform';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bounds per `bpmnElement` id, read with a scoped regex because the tests
 * workspace declares no moddle dependency.
 */
export function parseShapeBounds(xml: string): Map<string, Bounds> {
  const shape =
    /<bpmndi:BPMNShape\b[^>]*\bbpmnElement="([^"]+)"[^>]*>\s*<dc:Bounds x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g;
  const bounds = new Map<string, Bounds>();
  for (let m = shape.exec(xml); m !== null; m = shape.exec(xml)) {
    bounds.set(m[1]!, {
      x: Number(m[2]),
      y: Number(m[3]),
      width: Number(m[4]),
      height: Number(m[5]),
    });
  }
  return bounds;
}

/** The bounds of one shape, failing the test when the shape is missing. */
export function boundsOf(bounds: Map<string, Bounds>, id: string): Bounds {
  const found = bounds.get(id);
  expect(found, `missing BPMNShape for ${id}`).toBeDefined();
  return found!;
}

function strictlyInside(child: Bounds, parent: Bounds): boolean {
  return (
    child.x > parent.x &&
    child.y > parent.y &&
    child.x + child.width < parent.x + parent.width &&
    child.y + child.height < parent.y + parent.height
  );
}

/**
 * Assert every direct child shape of every sub-process lies strictly inside that
 * sub-process's own shape, recursively. The root process has no shape, so its
 * direct children are unbounded; the recursion still descends into them.
 */
export function assertShapeContainment(
  container: FlowContainer,
  bounds: Map<string, Bounds>,
  isRoot: boolean,
): void {
  const parentBounds = isRoot ? undefined : bounds.get(container.id);
  if (!isRoot) {
    expect(
      parentBounds,
      `sub-process ${container.id} has no BPMNShape`,
    ).toBeDefined();
  }
  for (const fe of container.flowElements) {
    if (parentBounds !== undefined) {
      const childBounds = bounds.get(fe.id);
      expect(childBounds, `child ${fe.id} has no BPMNShape`).toBeDefined();
      expect(
        strictlyInside(childBounds!, parentBounds),
        `${fe.id} ${JSON.stringify(childBounds)} not inside ${container.id} ${JSON.stringify(parentBounds)}`,
      ).toBe(true);
    }
    if (fe.kind === 'subProcess') {
      assertShapeContainment(fe, bounds, false);
    }
  }
}
