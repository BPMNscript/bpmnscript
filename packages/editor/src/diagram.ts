// Diagram helpers for compiled BPMN shown in bpmn-js: fitting the view, and layout fixes the
// compiler's layout (bpmn-auto-layout) leaves to the viewer. No bpmn-js import: the fixes take
// the viewer's services through the minimal shapes below.

export type Point = { x: number; y: number };
export type Box = Point & { width: number; height: number };

/** The parts of a diagram-js element the layout fixes read and move. */
export type LayoutElement = Box & {
  type: string;
  parent?: unknown;
  waypoints?: Point[];
  target?: Box;
  attachers?: LayoutElement[];
  outgoing?: LayoutElement[];
  label?: LayoutElement;
  labelTarget?: LayoutElement;
  di?: { label?: { bounds?: unknown } };
};
type LayoutRegistry = {
  filter(fn: (e: LayoutElement) => boolean): LayoutElement[];
  getGraphics(e: LayoutElement): Pick<SVGElement, 'querySelector'>;
};
type LayoutGraphics = {
  update(type: 'shape' | 'connection', e: LayoutElement, gfx: unknown): void;
};
/** A bpmn-js viewer, as far as the layout fixes use it. */
export type LayoutViewer = { get<T>(name: string): T };

/** bpmn-js's font size for names inside shapes; pass it to the text renderer too. */
export const DIAGRAM_LABEL_PX = 12;
// Where bpmn-js's task-type icons (user, gear, ...) end, from the task's top edge.
const ICON_BOTTOM = 24;

/** Runs every layout fix, in order, on a freshly imported diagram. */
export function fixLayout(viewer: LayoutViewer) {
  spreadBoundaryEvents(viewer);
  rerouteFlows(viewer);
  placeFlowLabels(viewer);
  clearTaskIcons(viewer);
}

type FitOptions = {
  /** Screen px kept around the diagram. */
  pad: number;
  minScale: number;
  /** Screen px above a diagram that starts at its top edge (clear of the zoom controls); defaults to `pad`. */
  padTop?: number;
};

/**
 * The viewbox that shows `inner` (the diagram) in a pane of `outer` size: scaled to fit with `pad`
 * px around it, never above 100 % and never below `minScale`, so labels stay readable. Centered on
 * each axis where the diagram fits; where it does not, it starts at the diagram's left or top edge.
 */
export function fitViewbox(
  inner: Box,
  outer: { width: number; height: number },
  { pad, minScale, padTop = pad }: FitOptions,
): Box {
  const roomW = Math.max(1, outer.width - 2 * pad);
  const roomH = Math.max(1, outer.height - 2 * pad);
  const scale = Math.max(
    minScale,
    Math.min(1, roomW / inner.width, roomH / inner.height),
  );
  const width = outer.width / scale;
  const height = outer.height / scale;
  const place = (
    start: number,
    size: number,
    view: number,
    room: number,
    lead: number,
  ) =>
    size * scale <= room + 0.5
      ? start + size / 2 - view / 2
      : start - lead / scale;
  return {
    x: place(inner.x, inner.width, width, roomW, pad),
    y: place(inner.y, inner.height, height, roomH, padTop),
    width,
    height,
  };
}

/**
 * Top-left corner for a `w` x `h` sequence-flow label beside the flow's middle segment (the one
 * bpmn-js labels): centered above a horizontal segment, or right of a vertical one, `gap` px clear.
 * A label wider than its horizontal segment moves back from the shape the flow enters, since that
 * shape rises above the edge, and up over the shape it leaves. The compiler writes no label bounds, and bpmn-js's own default
 * overlaps the edge once a label wraps or sits on a vertical segment.
 */
export function flowLabelBox(
  waypoints: readonly Point[],
  w: number,
  h: number,
  gap = 4,
): Point {
  const mid = waypoints.length / 2 - 1;
  const a = waypoints[Math.floor(mid)];
  const b = waypoints[Math.ceil(mid + 0.01)];
  if (Math.abs(b.x - a.x) < Math.abs(b.y - a.y))
    return { x: Math.max(a.x, b.x) + gap, y: (a.y + b.y) / 2 - h / 2 };
  const centered = (a.x + b.x) / 2 - w / 2;
  const x =
    b.x >= a.x
      ? Math.min(centered, b.x - gap - w)
      : Math.max(centered, b.x + gap);
  // Past the segment's start the label rises as far as it overhangs, clearing a gateway's 45-degree edge.
  const overhang = Math.max(0, b.x >= a.x ? a.x - x : x + w - a.x);
  return { x, y: Math.min(a.y, b.y) - gap - h - overhang };
}

/** True when the axis-parallel segment a-b passes through the open interior of `box`. */
const crosses = (a: Point, b: Point, box: Box) =>
  Math.max(a.x, b.x) > box.x &&
  Math.min(a.x, b.x) < box.x + box.width &&
  Math.max(a.y, b.y) > box.y &&
  Math.min(a.y, b.y) < box.y + box.height;

/**
 * A route into `target` that stays outside it until its last point (the docking point), or
 * `waypoints` unchanged when it already does or no single elbow fixes it. bpmn-auto-layout bends
 * flows into an expanded sub-process at the sub-process's middle, so they cross its inside.
 */
export function routeOutsideTarget(
  waypoints: readonly Point[],
  target: Box,
): readonly Point[] {
  const i = waypoints.findIndex(
    (p, k) => k < waypoints.length - 1 && crosses(p, waypoints[k + 1], target),
  );
  if (i < 0) return waypoints;
  const from = waypoints[i];
  const end = waypoints[waypoints.length - 1];
  const onSide = end.x === target.x || end.x === target.x + target.width;
  const elbow = onSide ? { x: from.x, y: end.y } : { x: end.x, y: from.y };
  if (crosses(from, elbow, target) || crosses(elbow, end, target))
    return waypoints;
  const route = [...waypoints.slice(0, i + 1), elbow, end];
  // Drop points in the middle of a straight run.
  return route.filter((p, k) => {
    const a = route[k - 1];
    const b = route[k + 1];
    return (
      !a ||
      !b ||
      !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y))
    );
  });
}

/**
 * New left edges for `size`-wide boundary events at `xs` on `host`'s border: unchanged when no two
 * overlap, else spread evenly around the host's middle, 4 px apart at least. bpmn-auto-layout
 * spaces them by the host's width, so three on a task overlap.
 */
export function spreadAttachers(
  host: Box,
  xs: readonly number[],
  size: number,
): number[] {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  if (order.every((k, r) => r === 0 || xs[k] - xs[order[r - 1]] >= size))
    return [...xs];
  const step = Math.max(size + 4, host.width / (xs.length + 1));
  const mid = host.x + host.width / 2;
  const out = [...xs];
  order.forEach(
    (k, r) => (out[k] = mid + (r - (xs.length - 1) / 2) * step - size / 2),
  );
  return out;
}

/** How far to move a task's label (spanning `top` to `bottom`) down so it clears an icon ending at `iconBottom`, staying 2 px inside the task. */
export function labelShift(
  top: number,
  bottom: number,
  height: number,
  iconBottom: number,
): number {
  return Math.max(0, Math.min(iconBottom - top, height - 2 - bottom));
}

/** Moves boundary events that overlap on their host apart (see spreadAttachers), with their flows' first segment. */
function spreadBoundaryEvents(viewer: LayoutViewer) {
  const registry = viewer.get<LayoutRegistry>('elementRegistry');
  const graphics = viewer.get<LayoutGraphics>('graphicsFactory');
  for (const host of registry.filter(
    (e: LayoutElement) => (e.attachers?.length ?? 0) > 1,
  )) {
    const events = host.attachers!;
    const xs = spreadAttachers(
      host,
      events.map((e: LayoutElement) => e.x),
      events[0].width,
    );
    events.forEach((event, i) => {
      const dx = xs[i] - event.x;
      if (!dx) return;
      event.x += dx;
      graphics.update('shape', event, registry.getGraphics(event));
      if (event.label) {
        event.label.x += dx;
        graphics.update(
          'shape',
          event.label,
          registry.getGraphics(event.label),
        );
      }
      for (const flow of event.outgoing ?? []) {
        const [a, b] = flow.waypoints!;
        // A vertical first segment moves whole; otherwise only its start.
        if (b && b.x === a.x) b.x += dx;
        a.x += dx;
        graphics.update('connection', flow, registry.getGraphics(flow));
      }
    });
  }
}

/** Moves task names that reach into the task-type icon down below it (see labelShift). */
function clearTaskIcons(viewer: LayoutViewer) {
  const registry = viewer.get<LayoutRegistry>('elementRegistry');
  for (const task of registry.filter((e: LayoutElement) =>
    /^bpmn:\w+Task$/.test(e.type),
  )) {
    const text = registry
      .getGraphics(task)
      .querySelector<SVGTextElement>('text.djs-label');
    const lines = [...(text?.querySelectorAll('tspan') ?? [])].map((t) =>
      Number(t.getAttribute('y')),
    );
    if (!text || !lines.length) continue;
    // From the lines' baselines, not getBBox: a hidden pane (phone tab) measures nothing.
    const dy = labelShift(
      lines[0] - DIAGRAM_LABEL_PX,
      lines[lines.length - 1] + DIAGRAM_LABEL_PX * 0.3,
      task.height,
      ICON_BOTTOM,
    );
    if (dy) text.setAttribute('transform', `translate(0 ${dy})`);
  }
}

/** Reroutes flows that run through the shape they enter (see routeOutsideTarget). */
function rerouteFlows(viewer: LayoutViewer) {
  const registry = viewer.get<LayoutRegistry>('elementRegistry');
  const graphics = viewer.get<LayoutGraphics>('graphicsFactory');
  for (const flow of registry.filter(
    (e: LayoutElement) => !!e.waypoints && !!e.target,
  )) {
    const route = routeOutsideTarget(flow.waypoints!, flow.target!);
    if (route === flow.waypoints) continue;
    flow.waypoints = [...route];
    graphics.update('connection', flow, registry.getGraphics(flow));
  }
}

/** Moves sequence-flow labels that have no stored position off their edge (see flowLabelBox). */
function placeFlowLabels(viewer: LayoutViewer) {
  const registry = viewer.get<LayoutRegistry>('elementRegistry');
  const graphics = viewer.get<LayoutGraphics>('graphicsFactory');
  for (const label of registry.filter(
    (e: LayoutElement) =>
      e.type === 'label' &&
      !!e.labelTarget?.waypoints &&
      !e.labelTarget.di?.label?.bounds,
  )) {
    Object.assign(
      label,
      flowLabelBox(label.labelTarget!.waypoints!, label.width, label.height),
    );
    graphics.update('shape', label, registry.getGraphics(label));
  }
}
