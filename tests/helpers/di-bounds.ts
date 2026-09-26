import { describe, it, expect } from 'vitest';

import type { FlowContainer, FlowElement } from '@bpmn-script/transform';

import type { RoundTrip } from './round-trip-fixture.js';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Regex, for the reason xml-query.ts gives.
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

function overlaps(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

// A boundary shape is centered on the lower edge of the host it watches, so that
// one pair overlaps by design.
function sitsOnTheEdgeOf(attacher: FlowElement, host: FlowElement): boolean {
  return (
    attacher.kind === 'boundaryEvent' && attacher.attachedToRef === host.id
  );
}

export function describeNoOverlappingShapes(rt: RoundTrip): void {
  describe('DI layout on the frozen .bpmn', () => {
    it('every flow node has a shape and only a boundary and its own host overlap', () => {
      const bounds = parseShapeBounds(rt.frozenXml);
      const shapes = rt.ir1.flowElements.map(
        (fe) => [fe, boundsOf(bounds, fe.id)] as const,
      );

      for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
          const [aEl, a] = shapes[i]!;
          const [bEl, b] = shapes[j]!;
          if (sitsOnTheEdgeOf(aEl, bEl) || sitsOnTheEdgeOf(bEl, aEl)) {
            continue;
          }
          expect(
            overlaps(a, b),
            `${aEl.id} ${JSON.stringify(a)} overlaps ${bEl.id} ${JSON.stringify(b)}`,
          ).toBe(false);
        }
      }
    });
  });
}

export function describeSingleDiagram(rt: RoundTrip): void {
  describe('DI on the generated .bpmn', () => {
    it('exactly one bpmndi:BPMNDiagram is emitted', () => {
      expect(rt.generatedXml.match(/<bpmndi:BPMNDiagram\b/g)).toHaveLength(1);
    });
  });
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

// The layout library places a disconnected event sub-process and its children
// inside the parent only with the `isExpanded="true"` stub irToXml emits; drop
// the stub and this block fails. `requiredIds` keeps the walk from passing
// because the interesting containers are absent; a thunk defers ids that come
// from the IR, readable only once the pipeline has run.
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
