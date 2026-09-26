import { expect } from 'vitest';

import type { FlowContainer, FlowElement } from '@bpmn-script/transform';

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

function strictlyInside(child: Bounds, parent: Bounds): boolean {
  return (
    child.x > parent.x &&
    child.y > parent.y &&
    child.x + child.width < parent.x + parent.width &&
    child.y + child.height < parent.y + parent.height
  );
}

// A boundary shape is centered on its host's lower edge, so it overlaps the
// host and may overlap a sibling on the same edge.
function attachedPair(a: FlowElement, b: FlowElement): boolean {
  const host = (fe: FlowElement): string | undefined =>
    fe.kind === 'boundaryEvent' ? fe.attachedToRef : undefined;
  return (
    host(a) === b.id ||
    host(b) === a.id ||
    (host(a) !== undefined && host(a) === host(b))
  );
}

function expectNoOverlap(
  container: FlowContainer,
  bounds: Map<string, Bounds>,
): void {
  const shapes = container.flowElements.map(
    (fe) => [fe, boundsOf(bounds, fe.id)] as const,
  );
  shapes.forEach(([aEl, a], i) => {
    for (const [bEl, b] of shapes.slice(i + 1)) {
      if (attachedPair(aEl, bEl)) continue;
      expect(
        overlaps(a, b),
        `${aEl.id} ${JSON.stringify(a)} overlaps ${bEl.id} ${JSON.stringify(b)}`,
      ).toBe(false);
    }
  });
}

// The layout library places a disconnected event sub-process and its children
// inside the parent only with the `isExpanded="true"` stub irToXml emits.
function expectContained(
  container: FlowContainer,
  bounds: Map<string, Bounds>,
  parent?: Bounds,
): void {
  for (const fe of container.flowElements) {
    const box = boundsOf(bounds, fe.id);
    if (parent !== undefined) {
      expect(
        strictlyInside(box, parent),
        `${fe.id} ${JSON.stringify(box)} not inside ${container.id} ${JSON.stringify(parent)}`,
      ).toBe(true);
    }
    if (fe.kind === 'subProcess') expectContained(fe, bounds, box);
  }
}

// One diagram, a shape per flow node, siblings apart (a boundary and its own
// host excepted), and every child strictly inside its sub-process.
export function expectSoundLayout(xml: string, process: FlowContainer): void {
  expect(xml.match(/<bpmndi:BPMNDiagram\b/g)).toHaveLength(1);
  const bounds = parseShapeBounds(xml);
  expectNoOverlap(process, bounds);
  expectContained(process, bounds);
}
