import { describe, it, expect, beforeAll } from 'vitest';

import { Diagnostic } from 'vscode-languageserver-types';

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

import { describeNoOverlappingShapes } from './helpers/di-bounds.js';
import { idsOfTag } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

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

// A flow closes on itself unless it carries a condition, the only child a flow
// of this artifact has.
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

// Every line opening a branch or a wait, so a lost `else`, a bare branch that
// gained a head, or an `await` missing a trigger all show up in order.
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

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it('every hop keeps each fork kind and the default each inclusive fork carries', () => {
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

      // Only the first fork names a default: a join has one incoming path per
      // branch and nothing to fall back to, and the second fork's unheaded
      // branch always runs, so a fallback there could never be taken.
      const carried = ir.flowElements.filter(
        (fe) =>
          fe.kind === 'inclusiveGateway' && fe.defaultFlowId !== undefined,
      );
      expect(
        carried.map((fe) => fe.id),
        `defaults differ in ${label}`,
      ).toEqual(['Gateway_order-handling_2_fork']);
    }
  });

  it("the decompiled DSL' writes every branch head and both wait forms back", () => {
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
  });

  it("every edge folds into a block, so DSL' jumps nowhere", () => {
    expect(rt.dslPrime).not.toContain('goto');
    expect(rt.dslPrime).not.toContain(UNSTRUCTURED_MARKER);
  });

  it('printing the imported IR reports nothing at all', () => {
    // Every gateway of the artifact is nameless, and every fork either names
    // its default or has an unheaded branch that always runs, so neither the
    // elided-label nor the invented-fallback warning has anything to report.
    expect(irToDsl(rt.ir2).warnings).toEqual([]);
  });
});

describe('gateway shape pins on the frozen .bpmn', () => {
  it('freezes two inclusive pairs, one parallel pair, and an exclusive merge per race', () => {
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
    // A race merges on an exclusive join, since exactly one branch ever runs.
    expect(idsOfTag(rt.frozenXml, 'exclusiveGateway')).toEqual([
      'Gateway_order-handling_5_join',
      'Gateway_order-handling_6_join',
    ]);
  });

  it('the one fallback points at its else branch, and the fork beside an unheaded branch names none', () => {
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
  });

  it('each race gateway waits on one catch event per branch and weighs none of them', () => {
    expect(idsOfTag(rt.frozenXml, 'eventBasedGateway')).toEqual(RACE_GATEWAYS);

    const catchIds = idsOfTag(rt.frozenXml, 'intermediateCatchEvent');
    // A race branch's catch is named for its gateway and its position, and the
    // plain `await` for the statement alone, so a drift has a name here.
    expect(catchIds).toEqual([
      'Catch_order-handling_5_b0',
      'Catch_order-handling_5_b1',
      'Catch_order-handling_6_b0',
      'Catch_order-handling_6_b1',
      'Catch_order-handling_7',
    ]);
    const catchEvents = new Set(catchIds);
    const flows = sequenceFlows(rt.frozenXml);
    for (const gateway of RACE_GATEWAYS) {
      const outs = flows.filter((f) => f.sourceRef === gateway);
      expect(outs, `${gateway} does not fork`).toHaveLength(2);
      for (const out of outs) {
        // Operaton builds no transition for a flow out of an event-based
        // gateway and routes through the event scope instead, so a condition
        // there would be content nothing reads.
        expect(out.conditioned, `${out.id} carries a condition`).toBe(false);
        expect(catchEvents.has(out.targetRef), `${out.id} misses a catch`).toBe(
          true,
        );
      }
    }
  });
});

describeNoOverlappingShapes(rt);

// A fork the golden pair cannot carry: a fallback beside a branch with no
// condition, so nothing is ever left for the fallback. No script authors it
// (the validator refuses the `else` it prints), so the fixture is built as IR
// and taken in through XML, the way a modeled diagram arrives.
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

describe('a fork whose fallback can never fire', () => {
  let source: string;
  let printWarnings: ReturnType<typeof irToDsl>['warnings'];
  let errors: string[];

  beforeAll(async () => {
    const { ir } = await xmlToIr(await irToXml(inclusiveForkIr('TriageOrder')));
    ({ source, warnings: printWarnings } = irToDsl(ir));
    const { diagnostics } = await rt.validate(source);
    errors = diagnostics
      .filter((d) => d.severity === 1)
      .map((d) => Diagnostic.getMessageString(d));
  });

  it('writes the fallback out rather than dropping the step behind it', () => {
    // Leaving the `else` out would print source compiling to a different
    // model, with the triage step off the run instead of on the fallback.
    expect(source).toContain('else {');
    expect(source).toContain('user TriageOrder');
  });

  it('reports the fallback, naming the fork it belongs to', () => {
    expect(printWarnings.map((w) => [w.category, w.elementId])).toEqual([
      ['defaultFlow', 'Gateway_1_fork'],
    ]);
    expect(printWarnings[0]?.message).toContain('nothing is ever left over');
  });

  it('reports it because the printed source is what the validator refuses', () => {
    expect(errors).toEqual([expect.stringContaining('could never run')]);
  });

  it('says nothing when the fallback runs straight into the merge', async () => {
    // Same dead fallback, going nowhere the merge does not, so it is left out
    // of the print and there is no `else` to report or to refuse.
    const { ir } = await xmlToIr(
      await irToXml(inclusiveForkIr('Gateway_1_join')),
    );
    const printed = irToDsl(ir);
    const { diagnostics } = await rt.validate(printed.source);

    expect(printed.source).not.toContain('else');
    expect(printed.warnings).toEqual([]);
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});
