import { describe, expect, test } from 'vitest';
import {
  fitViewbox,
  fixLayout,
  flowLabelBox,
  labelShift,
  routeOutsideTarget,
  spreadAttachers,
  type LayoutElement,
} from '../src/diagram';

describe('flow labels', () => {
  test('a label on a horizontal middle segment sits centered above the edge, clear of it', () => {
    const box = flowLabelBox(
      [
        { x: 400, y: 70 },
        { x: 475, y: 70 },
      ],
      60,
      30,
    );
    expect(box).toEqual({ x: 407.5, y: 70 - 4 - 30 });
  });

  test('a label wider than its segment keeps clear of the shape the flow enters, and rises over the one it leaves', () => {
    // Gateway to task, 75 apart: centered, an 80-wide label would run into the task at 475. Moved
    // back, it starts 9 before the gateway's corner, whose 45-degree edge rises 9 there.
    const box = flowLabelBox(
      [
        { x: 400, y: 70 },
        { x: 475, y: 70 },
      ],
      80,
      15,
    );
    expect(box).toEqual({ x: 475 - 4 - 80, y: 70 - 4 - 15 - 9 });
  });

  test('a label wider than a right-to-left segment keeps clear of the shape on the left', () => {
    const box = flowLabelBox(
      [
        { x: 475, y: 70 },
        { x: 400, y: 70 },
      ],
      80,
      15,
    );
    expect(box).toEqual({ x: 400 + 4, y: 70 - 4 - 15 - 9 });
  });

  test('a label on a vertical middle segment sits right of the edge, vertically centered', () => {
    // Three waypoints: bpmn-js labels the segment from the first to the second point.
    const box = flowLabelBox(
      [
        { x: 375, y: 95 },
        { x: 375, y: 210 },
        { x: 475, y: 210 },
      ],
      50,
      20,
    );
    expect(box).toEqual({ x: 375 + 4, y: 152.5 - 10 });
  });

  test('four waypoints label the middle segment', () => {
    const box = flowLabelBox(
      [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 0 },
      ],
      40,
      10,
    );
    expect(box).toEqual({ x: 80, y: 100 - 4 - 10 });
  });
});

describe('flow routes', () => {
  // The order-handling preset as compiled: a flow into the expanded sub-process "Payment" bends at
  // the sub-process's middle column, so it runs through the sub-process and over its inner flows.
  const payment = { x: 475, y: 30, width: 850, height: 220 };
  const intoPayment = [
    { x: 425, y: 770 },
    { x: 450, y: 770 },
    { x: 450, y: 210 },
    { x: 825, y: 210 },
    { x: 825, y: 140 },
    { x: 475, y: 140 },
  ];

  test('a flow that runs through its target is rerouted to reach the same docking point from outside', () => {
    expect(routeOutsideTarget(intoPayment, payment)).toEqual([
      { x: 425, y: 770 },
      { x: 450, y: 770 },
      { x: 450, y: 140 },
      { x: 475, y: 140 },
    ]);
  });

  test('a flow that stays outside its target keeps its route', () => {
    const route = [
      { x: 275, y: 70 },
      { x: 475, y: 70 },
    ];
    expect(routeOutsideTarget(route, payment)).toBe(route);
  });

  test('a route that cannot reach the docking point from outside is left alone', () => {
    // Enters through the right edge to dock on the left edge: no elbow fixes that.
    const route = [
      { x: 1400, y: 140 },
      { x: 475, y: 140 },
    ];
    expect(routeOutsideTarget(route, payment)).toBe(route);
  });
});

describe('diagram fit', () => {
  const pad = 24;

  test('a diagram that fits at 100 % is shown at 100 %, centered', () => {
    const inner = { x: 0, y: 0, width: 200, height: 100 };
    expect(
      fitViewbox(inner, { width: 600, height: 400 }, { pad, minScale: 0.9 }),
    ).toEqual({ x: -200, y: -150, width: 600, height: 400 });
  });

  test('a diagram between the minimum and 100 % is scaled down to fit, centered', () => {
    // 552 px of room for 600 units: 0.92.
    const inner = { x: 0, y: 0, width: 600, height: 100 };
    const box = fitViewbox(
      inner,
      { width: 600, height: 400 },
      { pad, minScale: 0.9 },
    );
    expect(600 / box.width).toBeCloseTo(0.92, 5);
    expect(box.x + box.width / 2).toBeCloseTo(300, 5);
    expect(box.y + box.height / 2).toBeCloseTo(50, 5);
  });

  test('a diagram too wide to fit at the minimum zoom stays at the minimum, starting at its left edge', () => {
    const inner = { x: 50, y: 0, width: 790, height: 200 };
    const box = fitViewbox(
      inner,
      { width: 600, height: 600 },
      { pad, minScale: 0.9 },
    );
    expect(600 / box.width).toBeCloseTo(0.9, 5);
    expect(box.x).toBeCloseTo(50 - pad / 0.9, 5);
    expect(box.y + box.height / 2).toBeCloseTo(100, 5);
  });

  test('a diagram too tall to fit at the minimum zoom starts at its top edge, below the zoom controls', () => {
    const inner = { x: 0, y: 30, width: 100, height: 2000 };
    const box = fitViewbox(
      inner,
      { width: 600, height: 600 },
      { pad, minScale: 0.9, padTop: 60 },
    );
    expect(box.y).toBeCloseTo(30 - 60 / 0.9, 5);
    expect(box.x + box.width / 2).toBeCloseTo(50, 5);
  });
});

describe('boundary events', () => {
  // Three events on a 100-wide task, as compiled: 25 apart, so the 36-wide circles overlap.
  const host = { x: 175, y: 30, width: 100, height: 80 };

  test('events that overlap on their host are spread evenly around its middle, 4 px apart', () => {
    expect(spreadAttachers(host, [182, 207, 232], 36)).toEqual([167, 207, 247]);
  });

  test('events keep their left-to-right order, also when two share a place', () => {
    expect(spreadAttachers(host, [232, 182, 182], 36)).toEqual([247, 167, 207]);
  });

  test('events that already sit clear of each other keep their places', () => {
    expect(spreadAttachers(host, [190], 36)).toEqual([190]);
    expect(spreadAttachers({ ...host, width: 300 }, [220, 320], 36)).toEqual([
      220, 320,
    ]);
  });
});

describe('task labels', () => {
  test('a label that reaches into the task icon moves down below it', () => {
    // Three 14.4 px lines centered in an 80 px task start at 18.4; the icon ends at 22.
    expect(labelShift(18.4, 61.6, 80, 22)).toBeCloseTo(3.6, 5);
  });

  test('a label clear of the icon stays', () => {
    expect(labelShift(32.8, 47.2, 80, 22)).toBe(0);
  });

  test('a label never moves past the bottom of its task', () => {
    expect(labelShift(4, 76, 80, 22)).toBe(2);
  });
});

describe('layout fixes on an imported diagram', () => {
  test('overlapping boundary events are spread with their outgoing flows, and an unplaced flow label leaves its edge', () => {
    const host = {
      type: 'bpmn:UserTask',
      x: 175,
      y: 30,
      width: 100,
      height: 80,
    };
    const flows: LayoutElement[] = [];
    const events = [182, 207, 232].map((x) => {
      const flow: LayoutElement = {
        type: 'bpmn:SequenceFlow',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        waypoints: [
          { x: x + 18, y: 128 },
          { x: x + 18, y: 200 },
        ],
      };
      flows.push(flow);
      return {
        type: 'bpmn:BoundaryEvent',
        x,
        y: 92,
        width: 36,
        height: 36,
        outgoing: [flow],
      };
    });
    const label: LayoutElement = {
      type: 'label',
      x: 0,
      y: 0,
      width: 60,
      height: 30,
      labelTarget: {
        type: 'bpmn:SequenceFlow',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        waypoints: [
          { x: 400, y: 70 },
          { x: 475, y: 70 },
        ],
      },
    };
    const all: LayoutElement[] = [
      { ...host, attachers: events },
      ...events,
      ...flows,
      label,
    ];
    const updated: LayoutElement[] = [];
    const viewer = {
      get: (name: string) =>
        name === 'elementRegistry'
          ? {
              filter: (fn: (e: LayoutElement) => boolean) => all.filter(fn),
              getGraphics: () => ({ querySelector: () => null }),
            }
          : { update: (_: string, e: LayoutElement) => updated.push(e) },
    };

    fixLayout(viewer as never);

    expect(events.map((e) => e.x)).toEqual([167, 207, 247]);
    expect(flows.map((f) => f.waypoints!.map((p) => p.x))).toEqual([
      [185, 185],
      [225, 225],
      [265, 265],
    ]);
    expect({ x: label.x, y: label.y }).toEqual({ x: 407.5, y: 36 });
    expect(updated).toContain(label);
  });
});
