import { it, expect } from 'vitest';

import { ENGINE_KEYS, type EngineKey } from '@bpmn-script/language';
import { isGateway } from '@bpmn-script/transform';
import type { EngineAttributes, FlowElement } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { allElements, elementById, theOnly } from './helpers/ir-query.js';

const rt = roundTripFixture('engine-attributes', {
  dslPrimeFrom: 'generated',
  importPath: true,
  recompile: 'clean',
});

// Not the exporter's `P30D` default, which the importer reads as unwritten.
const PROCESS_HEADER = {
  versionTag: '3.1.0',
  historyTimeToLive: 'P90D',
  candidateStarterUsers: 'demo,manager',
  candidateStarterGroups: 'adjusters',
};

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
  [
    'ApprovePayout',
    'formRef',
    { key: 'payout-approval', binding: { kind: 'version', version: '2' } },
  ],
  ['ClaimSettled', 'asyncBefore', true],
];

// `satisfies` fails to compile when `EngineAttributes` gains a field not listed.
const ENGINE_ATTRIBUTE_KEYS = [
  ...ENGINE_KEYS,
  ...Object.keys({ executionListeners: 0 } satisfies Record<
    Exclude<keyof EngineAttributes, EngineKey>,
    number
  >),
];

// Indexed: the IR types keep these fields off the kinds that cannot carry them.
function setting(el: FlowElement, attribute: string): unknown {
  return (el as unknown as Record<string, unknown>)[attribute];
}

it('keeps every authored setting, the header settings and the async await at every hop, and invents none on a gateway', () => {
  for (const [label, ir] of rt.hops) {
    for (const [id, attribute, value] of ENGINE_ATTRIBUTE_CONTRACT) {
      expect(
        setting(elementById(ir, id), attribute),
        `${id}.${attribute} in ${label}`,
      ).toStrictEqual(value);
    }
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
      label,
    ).toEqual(PROCESS_HEADER);
    expect(theOnly(ir, 'intermediateCatchEvent').asyncBefore, label).toBe(true);
    const gateways = allElements(ir).filter(isGateway);
    expect(new Set(gateways.map((gw) => gw.kind)), label).toEqual(
      new Set(['exclusiveGateway', 'parallelGateway']),
    );
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

it('writes all three form reference attributes, and puts handler settings on the boundary or the event sub-process, never the trigger', () => {
  // Operaton refuses to deploy a form reference missing its binding.
  expect(rt.frozenXml).toContain(
    '<bpmn:userTask id="ApprovePayout" name="Approve the payout"' +
      ' operaton:assignee="manager" operaton:formRef="payout-approval"' +
      ' operaton:formRefBinding="version" operaton:formRefVersion="2">',
  );
  // The lock is written twice: `BpmnParse.parseTimer` reads it off the
  // definition, `parseAsynchronousContinuation` off the tag.
  expect(rt.frozenXml).toContain(
    '<bpmn:boundaryEvent id="Boundary_ApprovePayout_timer" cancelActivity="false"' +
      ' attachedToRef="ApprovePayout" operaton:asyncAfter="true" operaton:exclusive="false">\n' +
      '      <bpmn:outgoing>Flow_Boundary_ApprovePayout_timer_NudgeApprover</bpmn:outgoing>\n' +
      '      <bpmn:timerEventDefinition operaton:exclusive="false">',
  );
  const boundary = theOnly(rt.ir2, 'boundaryEvent');
  expect([
    boundary.attachedToRef,
    boundary.asyncAfter,
    boundary.exclusive,
  ]).toEqual(['ApprovePayout', true, false]);
  const handler = theOnly(
    rt.ir2,
    'subProcess',
    (sp) => sp.triggeredByEvent === true,
  );
  expect([
    handler.asyncBefore,
    handler.jobPriority,
    handler.retryCycle,
  ]).toEqual([true, '60', 'R2/PT30S']);
  const trigger = theOnly(handler, 'startEvent');
  expect(trigger.id).toBe('ReviewRequested');
  for (const key of ENGINE_ATTRIBUTE_KEYS) {
    expect(setting(trigger, key), `${trigger.id}.${key}`).toBeUndefined();
  }
});
