// None of these settings changes control flow, so what this suite catches is a
// value that stops traveling in one of the four directions while the rest of
// the process looks unchanged.

import { describe, it, expect } from 'vitest';

import { isGateway } from '@bpmn-script/transform';
import type { EngineAttributes, FlowElement } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { describeDiContainment } from './helpers/di-bounds.js';
import { allElements, elementById, theOnly } from './helpers/ir-query.js';

const rt = roundTripFixture('engine-attributes', {
  dslPrimeFrom: 'generated',
  importPath: true,
  recompile: 'clean',
});

// Asserted as a whole rather than key by key, so a value that stops travelling
// and a value that appears out of nowhere both fail. `historyTimeToLive` is
// authored as something other than the exporter's own default on purpose: at
// `P30D` the importer reads it as unwritten and the hop would prove nothing.
const PROCESS_HEADER = {
  versionTag: '3.1.0',
  historyTimeToLive: 'P90D',
  candidateStarterUsers: 'demo,manager',
  candidateStarterGroups: 'adjusters',
};

// The tripwire for a regenerated golden: layout, flow ids, and synthesized
// handler and gateway ids may move, and no row here may. The three carriers
// with synthesized ids are pinned in the blocks below instead, located by what
// they are.
const ENGINE_ATTRIBUTE_CONTRACT: readonly (readonly [
  id: string,
  attribute: string,
  value: string | boolean | Record<string, unknown>,
])[] = [
  ['ClaimFiled', 'initiator', 'claimant'],
  ['ClaimFiled', 'asyncAfter', true],
  ['TriageClaim', 'assignee', 'demo'],
  ['TriageClaim', 'formKey', 'embedded:app:forms/claim-triage.html'],
  ['TriageClaim', 'candidateGroups', 'adjusters'],
  ['TriageClaim', 'candidateUsers', 'demo,manager'],
  ['TriageClaim', 'priority', '75'],
  ['TriageClaim', 'asyncBefore', true],
  ['InspectVehicle', 'asyncBefore', true],
  ['InspectVehicle', 'exclusive', false],
  ['AssessBodywork', 'resultVariable', 'bodyworkReport'],
  ['AssessBodywork', 'asyncBefore', true],
  ['AssessBodywork', 'retryCycle', 'R3/PT5M'],
  ['GradeMechanics', 'resultVariable', 'mechanicsGrade'],
  ['GradeMechanics', 'asyncBefore', true],
  ['GradeMechanics', 'jobPriority', '80'],
  ['OrderRepair', 'asyncAfter', true],
  ['OrderRepair', 'retryCycle', 'R5/PT10M'],
  ['PayoutReviewNeeded', 'asyncAfter', true],
  ['PayoutReviewNeeded', 'jobPriority', '40'],
  // The key and the binding are one value in the IR, so the whole reference is
  // one row: a version that stopped travelling fails it as loudly as a key that
  // did.
  [
    'ApprovePayout',
    'formRef',
    { key: 'payout-approval', binding: { kind: 'version', version: '2' } },
  ],
  ['ClaimSettled', 'asyncBefore', true],
];

// Spelled out rather than derived, because the sweep below reads it off a
// gateway, which declares the five job settings and never the listeners. The
// `satisfies` clause is what keeps the copy honest: a field added to the
// interface and not here stops compiling.
const ENGINE_ATTRIBUTE_KEYS = Object.keys({
  asyncBefore: 0,
  asyncAfter: 0,
  exclusive: 0,
  jobPriority: 0,
  retryCycle: 0,
  executionListeners: 0,
} satisfies Record<keyof EngineAttributes, number>);

// Indexed rather than a field access: the IR types keep these fields off the
// kinds that cannot carry them, and the gateway block below reads exactly those.
function setting(el: FlowElement, attribute: string): unknown {
  return (el as unknown as Record<string, unknown>)[attribute];
}

describe('the frozen engine-attribute contract', () => {
  it('every authored node keeps its settings and their values at every hop', () => {
    for (const [label, ir] of rt.hops) {
      for (const [id, attribute, value] of ENGINE_ATTRIBUTE_CONTRACT) {
        expect(
          setting(elementById(ir, id), attribute),
          `${id}.${attribute} differs in ${label}`,
        ).toStrictEqual(value);
      }
    }
  });

  it('the four engine settings on the header keep their values at every hop', () => {
    for (const [label, ir] of rt.hops) {
      const {
        versionTag,
        historyTimeToLive,
        candidateStarterUsers,
        candidateStarterGroups,
      } = ir;
      expect(
        {
          versionTag,
          historyTimeToLive,
          candidateStarterUsers,
          candidateStarterGroups,
        },
        `the process header differs in ${label}`,
      ).toEqual(PROCESS_HEADER);
    }
  });

  // Asserted as the whole opening tag: Operaton refuses to deploy a form
  // reference whose binding attribute is missing, so an emission that dropped
  // one of the three would still look plausible read on its own.
  it('the user task naming a deployed form writes all three reference attributes', () => {
    expect(rt.frozenXml).toContain(
      '<bpmn:userTask id="ApprovePayout" name="Approve the payout"' +
        ' operaton:assignee="manager" operaton:formRef="payout-approval"' +
        ' operaton:formRefBinding="version" operaton:formRefVersion="2">',
    );
  });

  it('the awaited catch keeps its async continuation at every hop', () => {
    for (const [label, ir] of rt.hops) {
      const awaited = theOnly(ir, 'intermediateCatchEvent');
      expect(awaited.asyncBefore, `await differs in ${label}`).toBe(true);
    }
  });
});

// The `gateway-settings` pair pins what a gateway written with settings
// carries; this artifact writes none, so what it pins is that no direction
// invents one, on either kind, at any depth.
describe('a gateway written without settings gains none at any hop', () => {
  it('neither gateway kind holds one, at any container depth or hop', () => {
    for (const [label, ir] of rt.hops) {
      const gateways = allElements(ir).filter(isGateway);
      expect(
        new Set(gateways.map((gw) => gw.kind)),
        `both gateway kinds must be present in ${label}`,
      ).toEqual(new Set(['exclusiveGateway', 'parallelGateway']));

      for (const gateway of gateways) {
        for (const key of ENGINE_ATTRIBUTE_KEYS) {
          expect(
            setting(gateway, key),
            `${gateway.id}.${key} in ${label}`,
          ).toBeUndefined();
        }
      }
    }
  });
});

describe('where a handler puts the settings written on it', () => {
  it("a hosted handler's settings land on the boundary event", () => {
    const boundary = theOnly(rt.ir2, 'boundaryEvent');
    expect(boundary.attachedToRef).toBe('ApprovePayout');
    expect(boundary.asyncAfter).toBe(true);
    expect(boundary.exclusive).toBe(false);
  });

  it("a host-less handler's settings land on the event sub-process, not on its trigger", () => {
    const handler = theOnly(
      rt.ir2,
      'subProcess',
      (sp) => sp.triggeredByEvent === true,
    );
    expect(handler.asyncBefore).toBe(true);
    expect(handler.jobPriority).toBe('60');
    expect(handler.retryCycle).toBe('R2/PT30S');

    const trigger = theOnly(handler, 'startEvent');
    expect(trigger.id).toBe('ReviewRequested');
    for (const key of ENGINE_ATTRIBUTE_KEYS) {
      expect(setting(trigger, key), `${trigger.id}.${key}`).toBeUndefined();
    }
  });
});

// Both nesting parents are named so the walk cannot pass on an empty tree.
describeDiContainment(rt, () => [
  'InspectVehicle',
  theOnly(rt.ir1, 'subProcess', (sp) => sp.triggeredByEvent === true).id,
]);
