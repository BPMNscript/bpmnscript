import { describe, it, expect } from 'vitest';

import type { FlowContainer } from '@bpmn-script/transform';

import type { RoundTrip } from './round-trip-fixture.js';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Regex rather than a parser: the tests workspace declares no moddle dependency.
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

// The root process has no shape, so its direct children are unbounded. The
// recursion still descends into them.
function assertShapeContainment(
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

// An event sub-process is a disconnected node, so the layout library only
// places its box and its children inside the parent when the `isExpanded="true"`
// stub irToXml emits is present. Removing that stub fails this block.
//
// `requiredIds` stops the walk passing because the interesting containers are
// absent; pass a thunk when the ids come from the IR, which is readable only
// after the pipeline has run.
export function describeDiContainment(
  rt: RoundTrip,
  requiredIds: readonly string[] | (() => readonly string[]) = [],
  source: 'generated' | 'frozen' = 'frozen',
): void {
  describe(`DI containment on the ${source} .bpmn`, () => {
    it('every child shape lies strictly inside its parent sub-process bounds', () => {
      const bounds = parseShapeBounds(
        source === 'frozen' ? rt.frozenXml : rt.generatedXml,
      );

      const ids =
        typeof requiredIds === 'function' ? requiredIds() : requiredIds;
      for (const id of ids) {
        expect(bounds.has(id), `missing BPMNShape for ${id}`).toBe(true);
      }

      assertShapeContainment(rt.ir1, bounds, true);
    });
  });
}
