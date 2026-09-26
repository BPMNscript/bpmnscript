import { it, expect } from 'vitest';

import { ENGINE_KEYS } from '@bpmn-script/language';
import { isGateway } from '@bpmn-script/transform';
import type { FlowContainer, JobSettings } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { bpmnDoc } from './helpers/bpmn-doc.js';
import { allElements } from './helpers/ir-query.js';
import { describeImportFirst } from './helpers/import-first.js';
import { roundTrip, validationErrors } from './helpers/pipeline.js';
import { modelSignature } from './helpers/model-equivalence.js';

const rt = roundTripFixture('gateway-settings', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

// Bare gateways included, so a setting nothing wrote fails too.
const GATEWAY_SETTINGS: Record<string, JobSettings> = {
  'Gateway_loan-application_2_split': {
    asyncBefore: true,
    exclusive: false,
    jobPriority: '30',
  },
  'Gateway_loan-application_2_join': { asyncBefore: true, jobPriority: '20' },
  'Gateway_loan-application_3_loop': {
    asyncAfter: true,
    retryCycle: 'R3/PT10M',
  },
  'Gateway_loan-application_3_1_split': {},
  'Gateway_loan-application_3_1_join': {},
  'Gateway_loan-application_4_0_loop': {
    asyncBefore: true,
    exclusive: false,
    jobPriority: '10',
  },
  'Gateway_loan-application_5_fork': { asyncBefore: true },
  'Gateway_loan-application_5_join': {
    asyncAfter: true,
    exclusive: false,
    retryCycle: 'R2/PT1M',
  },
  'Gateway_loan-application_6_fork': {
    asyncBefore: true,
    jobPriority: '${selfEmployed ? 90 : 50}',
  },
  'Gateway_loan-application_6_join': { asyncBefore: true },
  'Gateway_loan-application_8_race': { asyncBefore: true, jobPriority: '5' },
  'Gateway_loan-application_8_join': { asyncBefore: true },
};

function settingsByGateway(ir: FlowContainer): Record<string, JobSettings> {
  return Object.fromEntries(
    allElements(ir)
      .filter(isGateway)
      .map((gw) => [
        gw.id,
        Object.fromEntries(
          ENGINE_KEYS.filter((key) => key in gw).map((key) => [
            key,
            (gw as unknown as Record<string, unknown>)[key],
          ]),
        ),
      ]),
  );
}

// Every `operaton:` attribute on a gateway open tag, then the retry child in
// its body, as `[id, attribute or child, value]` in document order.
function gatewayWireSettings(xml: string): [string, string, string][] {
  const gateway =
    /<bpmn:(\w+Gateway) id="([^"]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/bpmn:\1>)/g;
  return [...xml.matchAll(gateway)].flatMap(([, , id, attrs, body]) => [
    ...[...attrs!.matchAll(/(operaton:\w+)="([^"]*)"/g)].map(
      ([, attribute, value]): [string, string, string] => [
        id!,
        attribute!,
        value!,
      ],
    ),
    ...[
      ...(body ?? '').matchAll(
        /<(operaton:failedJobRetryTimeCycle)>([^<]*)<\/operaton:failedJobRetryTimeCycle>/g,
      ),
    ].map(([, child, value]): [string, string, string] => [
      id!,
      child!,
      value!,
    ]),
  ]);
}

const HEAD_LINE = /^(if |} else if |while |} while |parallel|await)/;

it('keeps exactly the settings written for each gateway at every hop, on the wire and on the printed statement heads', () => {
  for (const [label, ir] of rt.hops) {
    expect(settingsByGateway(ir), label).toEqual(GATEWAY_SETTINGS);
  }
  expect(gatewayWireSettings(rt.frozenXml)).toEqual([
    ['Gateway_loan-application_2_split', 'operaton:asyncBefore', 'true'],
    ['Gateway_loan-application_2_split', 'operaton:exclusive', 'false'],
    ['Gateway_loan-application_2_split', 'operaton:jobPriority', '30'],
    ['Gateway_loan-application_2_join', 'operaton:asyncBefore', 'true'],
    ['Gateway_loan-application_2_join', 'operaton:jobPriority', '20'],
    ['Gateway_loan-application_3_loop', 'operaton:asyncAfter', 'true'],
    [
      'Gateway_loan-application_3_loop',
      'operaton:failedJobRetryTimeCycle',
      'R3/PT10M',
    ],
    ['Gateway_loan-application_4_0_loop', 'operaton:asyncBefore', 'true'],
    ['Gateway_loan-application_4_0_loop', 'operaton:exclusive', 'false'],
    ['Gateway_loan-application_4_0_loop', 'operaton:jobPriority', '10'],
    ['Gateway_loan-application_5_fork', 'operaton:asyncBefore', 'true'],
    ['Gateway_loan-application_5_join', 'operaton:asyncAfter', 'true'],
    ['Gateway_loan-application_5_join', 'operaton:exclusive', 'false'],
    [
      'Gateway_loan-application_5_join',
      'operaton:failedJobRetryTimeCycle',
      'R2/PT1M',
    ],
    ['Gateway_loan-application_6_fork', 'operaton:asyncBefore', 'true'],
    [
      'Gateway_loan-application_6_fork',
      'operaton:jobPriority',
      '${selfEmployed ? 90 : 50}',
    ],
    ['Gateway_loan-application_6_join', 'operaton:asyncBefore', 'true'],
    ['Gateway_loan-application_8_race', 'operaton:asyncBefore', 'true'],
    ['Gateway_loan-application_8_race', 'operaton:jobPriority', '5'],
    ['Gateway_loan-application_8_join', 'operaton:asyncBefore', 'true'],
  ]);
  const heads = rt.dslPrime
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => HEAD_LINE.test(line));
  expect(heads).toEqual([
    'if (creditScore >= 700) (asyncBefore: true, exclusive: false, jobPriority: 30, joinAsyncBefore: true, joinJobPriority: 20) {',
    '} else if (creditScore >= 600) {',
    'while (documentsMissing) (asyncAfter: true, retryCycle: "R3/PT10M") {',
    'if (selfEmployed) {',
    '} while (referencesPending) (asyncBefore: true, exclusive: false, jobPriority: 10)',
    'parallel (asyncBefore: true, joinAsyncAfter: true, joinExclusive: false, joinRetryCycle: "R2/PT1M") {',
    'parallel (asyncBefore: true, jobPriority: "${selfEmployed ? 90 : 50}", joinAsyncBefore: true) {',
    'if (amount > 250000) {',
    'await (asyncBefore: true, jobPriority: 5, joinAsyncBefore: true) {',
  ]);
});

// Authored gateway ids, so the `join*` keys are recovered from the shape alone.
const AUTHORED_SPLIT_AND_JOIN = bpmnDoc(
  '    <bpmn:startEvent id="Applied" />\n' +
    '    <bpmn:exclusiveGateway id="Score" default="Flow_Score_Review" operaton:jobPriority="7" />\n' +
    '    <bpmn:userTask id="Approve" operaton:assignee="demo" />\n' +
    '    <bpmn:userTask id="Review" operaton:assignee="demo" />\n' +
    '    <bpmn:exclusiveGateway id="Scored" operaton:asyncBefore="true" />\n' +
    '    <bpmn:endEvent id="Closed" />\n' +
    '    <bpmn:sequenceFlow id="Flow_Applied_Score" sourceRef="Applied" targetRef="Score" />\n' +
    '    <bpmn:sequenceFlow id="Flow_Score_Approve" sourceRef="Score" targetRef="Approve">\n' +
    '      <bpmn:conditionExpression>${creditScore &gt;= 700}</bpmn:conditionExpression>\n' +
    '    </bpmn:sequenceFlow>\n' +
    '    <bpmn:sequenceFlow id="Flow_Score_Review" sourceRef="Score" targetRef="Review" />\n' +
    '    <bpmn:sequenceFlow id="Flow_Approve_Scored" sourceRef="Approve" targetRef="Scored" />\n' +
    '    <bpmn:sequenceFlow id="Flow_Review_Scored" sourceRef="Review" targetRef="Scored" />\n' +
    '    <bpmn:sequenceFlow id="Flow_Scored_Closed" sourceRef="Scored" targetRef="Closed" />',
);

describeImportFirst(
  'an authored .bpmn with settings on a join imports onto the join keys',
  AUTHORED_SPLIT_AND_JOIN,
  (first) => {
    it('the head carries the split key and, join-prefixed, the join key', () => {
      expect(first.dsl).toBe(
        [
          'process p {',
          '  var creditScore: any',
          '  start Applied',
          '  if (creditScore >= 700) (jobPriority: 7, joinAsyncBefore: true) {',
          '    user Approve(assignee: "demo")',
          '  } else {',
          '    user Review(assignee: "demo")',
          '  }',
          '  end Closed',
          '}',
          '',
        ].join('\n'),
      );
      expect(settingsByGateway(first.reDesugared)).toEqual({
        Gateway_p_1_split: { jobPriority: '7' },
        Gateway_p_1_join: { asyncBefore: true },
      });
    });
  },
);

// The self-loop leaves no post-dominators, so only forward reachability sees
// the branch step running back into the join; jumped to from the branch, that
// step would leave the join's settings off the weighed route.
it('a branch step that loops back through a join with settings prints inside the branch, so every route passes the join', async () => {
  const source = [
    'process p {',
    '  var c: any',
    '  if (c) (joinAsyncBefore: true) {',
    '    receive X',
    '  }',
    '  goto X',
    '}',
    '',
  ].join('\n');
  const first = await roundTrip(source);
  expect(first.dsl).toBe(source);
  expect(await validationErrors(first.dsl)).toEqual([]);
  expect(modelSignature(first.ir3)).toEqual(modelSignature(first.ir1));
});
