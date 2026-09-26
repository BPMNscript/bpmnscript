import { it, expect } from 'vitest';

import {
  irToDsl,
  irToXml,
  xmlToIr,
  UNSTRUCTURED_MARKER,
} from '@bpmn-script/transform';
import type {
  BpmnProcess,
  FlowContainer,
  FlowElement,
} from '@bpmn-script/transform';

import { idsOfTag } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { validationErrors } from './helpers/pipeline.js';

const rt = roundTripFixture('branch-and-race', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

interface Flow {
  id: string;
  sourceRef: string;
  targetRef: string;
  conditioned: boolean;
}

// A condition is the only child a flow of this artifact has.
function sequenceFlows(xml: string): Flow[] {
  const flow =
    /<bpmn:sequenceFlow id="([^"]+)"[^>]*\bsourceRef="([^"]+)" targetRef="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/bpmn:sequenceFlow>)/g;
  return [...xml.matchAll(flow)].map((m) => ({
    id: m[1]!,
    sourceRef: m[2]!,
    targetRef: m[3]!,
    conditioned: (m[4] ?? '').includes('<bpmn:conditionExpression'),
  }));
}

function declaredDefaults(xml: string): [string, string][] {
  return [
    ...xml.matchAll(/<bpmn:\w+Gateway id="([^"]+)" default="([^"]+)"/g),
  ].map((m) => [m[1]!, m[2]!]);
}

function countOfKind(
  container: FlowContainer,
  kind: FlowElement['kind'],
): number {
  return container.flowElements.filter((fe) => fe.kind === kind).length;
}

function blockHeads(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      /^(if |else|\{$|await|message\(|timer\(|signal\(|condition\()/.test(line),
    );
}

const RACE_GATEWAYS = [
  'Gateway_order-handling_5_race',
  'Gateway_order-handling_6_race',
];

it('keeps each fork kind and the one default at every hop, printing every branch head and wait with no jump and no warning', () => {
  for (const [label, ir] of rt.hops) {
    expect(
      countOfKind(ir, 'inclusiveGateway'),
      `inclusive pairs differ in ${label}`,
    ).toBe(4);
    expect(
      countOfKind(ir, 'parallelGateway'),
      `parallel pair differs in ${label}`,
    ).toBe(2);
    expect(
      countOfKind(ir, 'eventBasedGateway'),
      `race gateways differ in ${label}`,
    ).toBe(2);

    // The second fork's unheaded branch always runs, so it needs no fallback.
    const carried = ir.flowElements.filter(
      (fe) => fe.kind === 'inclusiveGateway' && fe.defaultFlowId !== undefined,
    );
    expect(
      carried.map((fe) => fe.id),
      `defaults differ in ${label}`,
    ).toEqual(['Gateway_order-handling_2_fork']);
  }
  expect(blockHeads(rt.dslPrime)).toEqual([
    'if (orderValue > 10000) {',
    'if (!stockShort) {',
    'else {',
    'if (overseas) {',
    '{',
    '{',
    '{',
    'await {',
    'message("PaymentReceived") {',
    'timer("P3D", asyncBefore: true) {',
    'await {',
    'signal("StockArrived") {',
    'condition(stockShort) {',
    'await message("CarrierBooked")',
  ]);
  expect(rt.dslPrime).not.toContain('goto');
  expect(rt.dslPrime).not.toContain(UNSTRUCTURED_MARKER);
  // Nameless gateways, and every fork names its default or has an unheaded
  // branch, so neither the elided-label nor the fallback warning applies.
  expect(irToDsl(rt.ir2).warnings).toEqual([]);
});

it('writes the gateway pairs, the one fallback onto its else branch, and each race waiting unweighed on one catch per branch', () => {
  expect(idsOfTag(rt.frozenXml, 'inclusiveGateway')).toEqual([
    'Gateway_order-handling_2_fork',
    'Gateway_order-handling_2_join',
    'Gateway_order-handling_3_fork',
    'Gateway_order-handling_3_join',
  ]);
  expect(idsOfTag(rt.frozenXml, 'parallelGateway')).toEqual([
    'Gateway_order-handling_4_fork',
    'Gateway_order-handling_4_join',
  ]);
  expect(idsOfTag(rt.frozenXml, 'exclusiveGateway')).toEqual([
    'Gateway_order-handling_5_join',
    'Gateway_order-handling_6_join',
  ]);
  expect(declaredDefaults(rt.frozenXml)).toEqual([
    [
      'Gateway_order-handling_2_fork',
      'Flow_Gateway_order-handling_2_fork_default',
    ],
  ]);

  const flows = sequenceFlows(rt.frozenXml);
  expect(
    flows.find((f) => f.id === 'Flow_Gateway_order-handling_2_fork_default')
      ?.targetRef,
  ).toBe('TriageOrder');
  expect(
    flows
      .filter((f) => f.sourceRef === 'Gateway_order-handling_3_fork')
      .map((f) => [f.targetRef, f.conditioned]),
  ).toEqual([
    ['PrepareCustoms', true],
    ['PrintLabel', false],
  ]);
  expect(idsOfTag(rt.frozenXml, 'eventBasedGateway')).toEqual(RACE_GATEWAYS);

  const catchIds = idsOfTag(rt.frozenXml, 'intermediateCatchEvent');
  expect(catchIds).toEqual([
    'Catch_order-handling_5_b0',
    'Catch_order-handling_5_b1',
    'Catch_order-handling_6_b0',
    'Catch_order-handling_6_b1',
    'Catch_order-handling_7',
  ]);
  const catchEvents = new Set(catchIds);
  for (const gateway of RACE_GATEWAYS) {
    const outs = flows.filter((f) => f.sourceRef === gateway);
    expect(outs, `${gateway} does not fork`).toHaveLength(2);
    for (const out of outs) {
      // Operaton routes an event-based gateway through the event scope, so a
      // condition on its flow is never read.
      expect(out.conditioned, `${out.id} carries a condition`).toBe(false);
      expect(catchEvents.has(out.targetRef), `${out.id} misses a catch`).toBe(
        true,
      );
    }
  }
});

// A fallback beside a branch with no condition, so nothing is ever left for
// it. No script authors this, so it is built as IR and taken in through XML.
const DEAD_FALLBACK_FLOW = 'Flow_Gateway_1_fork_default';

function inclusiveForkIr(fallbackTarget: string): BpmnProcess {
  return {
    id: 'dead-fallback',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'Start_1' },
      {
        kind: 'inclusiveGateway',
        id: 'Gateway_1_fork',
        defaultFlowId: DEAD_FALLBACK_FLOW,
      },
      { kind: 'userTask', id: 'AuditOrder' },
      { kind: 'userTask', id: 'ReserveStock' },
      ...(fallbackTarget === 'TriageOrder'
        ? [{ kind: 'userTask' as const, id: 'TriageOrder' }]
        : []),
      { kind: 'inclusiveGateway', id: 'Gateway_1_join' },
      { kind: 'endEvent', id: 'End_1' },
    ],
    sequenceFlows: [
      { id: 'f1', sourceRef: 'Start_1', targetRef: 'Gateway_1_fork' },
      {
        id: 'f2',
        sourceRef: 'Gateway_1_fork',
        targetRef: 'AuditOrder',
        conditionExpression: '${orderValue > 10000}',
      },
      { id: 'f3', sourceRef: 'Gateway_1_fork', targetRef: 'ReserveStock' },
      {
        id: DEAD_FALLBACK_FLOW,
        sourceRef: 'Gateway_1_fork',
        targetRef: fallbackTarget,
      },
      { id: 'f4', sourceRef: 'AuditOrder', targetRef: 'Gateway_1_join' },
      { id: 'f5', sourceRef: 'ReserveStock', targetRef: 'Gateway_1_join' },
      ...(fallbackTarget === 'TriageOrder'
        ? [
            {
              id: 'f6',
              sourceRef: 'TriageOrder',
              targetRef: 'Gateway_1_join',
            },
          ]
        : []),
      { id: 'f7', sourceRef: 'Gateway_1_join', targetRef: 'End_1' },
    ],
  };
}

it('prints a fork fallback that can never fire as an else the validator refuses, and reports it; one running into the merge prints nothing', async () => {
  const { ir } = await xmlToIr(await irToXml(inclusiveForkIr('TriageOrder')));
  const { source, warnings } = irToDsl(ir);
  // Leaving the `else` out would compile to a different model.
  expect(source).toContain('else {');
  expect(source).toContain('user TriageOrder');
  expect(warnings.map((w) => [w.category, w.elementId])).toEqual([
    ['defaultFlow', 'Gateway_1_fork'],
  ]);
  expect(warnings[0]?.message).toContain('nothing is ever left over');
  expect(await validationErrors(source)).toEqual([
    expect.stringContaining('could never run'),
  ]);

  const merged = irToDsl(
    (await xmlToIr(await irToXml(inclusiveForkIr('Gateway_1_join')))).ir,
  );
  expect(merged.source).not.toContain('else');
  expect(merged.warnings).toEqual([]);
  expect(await validationErrors(merged.source)).toEqual([]);
});
