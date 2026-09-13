// One artifact carries all ten spellings a gateway statement takes, so what
// this suite catches is a setting that stops travelling in one of the four
// directions, or that lands on the wrong gateway of a split-and-join pair,
// while the control flow around it looks unchanged.

import { describe, it, expect } from 'vitest';

import { ENGINE_KEYS } from '@bpmn-script/language';
import { isGateway } from '@bpmn-script/transform';
import type { FlowContainer, JobSettings } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { describeDiContainment } from './helpers/di-bounds.js';
import { allElements } from './helpers/ir-query.js';
import { describeImportFirst } from './helpers/import-first.js';

const rt = roundTripFixture('gateway-settings', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

// Every gateway of the artifact, the ones written bare included, so a setting
// that appears on a gateway nothing wrote it for fails as loudly as one that
// stops travelling. Revert: any one direction dropping a `join*` key from the
// join it synthesizes, or reading a head key onto the join.
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
  'Gateway_loan-application_4_0_loop': { exclusive: false, jobPriority: '10' },
  'Gateway_loan-application_5_fork': { asyncBefore: true },
  'Gateway_loan-application_5_join': {
    asyncAfter: true,
    exclusive: false,
    retryCycle: 'R2/PT1M',
  },
  'Gateway_loan-application_6_fork': {
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

// Regex rather than a parser: the tests workspace declares no moddle dependency.
// Every `operaton:` attribute on a gateway open tag, then the retry child in
// its body, as `(id, attribute or child, value)` in document order.
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

describe('the frozen gateway-settings contract', () => {
  it('every gateway carries exactly the settings written for it at every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(
        settingsByGateway(ir),
        `gateway settings differ in ${label}`,
      ).toEqual(GATEWAY_SETTINGS);
    }
  });

  // Revert: `jobSettingAttrs` or `retryCycleElement` skipped for a gateway kind
  // in `irToXml` -> that gateway's rows gone.
  it('the wire carries the attributes and the retry child on the gateway elements', () => {
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
  });

  // The whole set of heads, the bare ones included, so a parens printed on a
  // gateway that carries nothing fails too. The harness re-parses and
  // validates DSL' as a whole. Revert: `takeJoinSettings` returning `[]` ->
  // every `join*` key gone from the heads.
  it('the printed script carries the settings on the statement heads', () => {
    const heads = rt.dslPrime
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => HEAD_LINE.test(line));
    expect(heads).toEqual([
      'if (creditScore >= 700) (asyncBefore: true, exclusive: false, jobPriority: 30, joinAsyncBefore: true, joinJobPriority: 20) {',
      '} else if (creditScore >= 600) {',
      'while (documentsMissing) (asyncAfter: true, retryCycle: "R3/PT10M") {',
      'if (selfEmployed) {',
      '} while (referencesPending) (exclusive: false, jobPriority: 10)',
      'parallel (asyncBefore: true, joinAsyncAfter: true, joinExclusive: false, joinRetryCycle: "R2/PT1M") {',
      'parallel (jobPriority: "${selfEmployed ? 90 : 50}", joinAsyncBefore: true) {',
      'if (amount > 250000) {',
      'await (asyncBefore: true, jobPriority: 5, joinAsyncBefore: true) {',
    ]);
  });
});

// A modeled document names its gateways, so the split and the join reach the
// printer under authored ids rather than the coordinate ids the frozen artifact
// carries, and the `join*` keys have to be recovered from the shape alone.
const AUTHORED_SPLIT_AND_JOIN =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:operaton="http://operaton.org/schema/1.0/bpmn" targetNamespace="http://test">\n' +
  '  <bpmn:process id="p" isExecutable="true">\n' +
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
  '    <bpmn:sequenceFlow id="Flow_Scored_Closed" sourceRef="Scored" targetRef="Closed" />\n' +
  '  </bpmn:process>\n' +
  '</bpmn:definitions>';

describeImportFirst(
  'an authored .bpmn with settings on a join imports onto the join keys',
  AUTHORED_SPLIT_AND_JOIN,
  (first) => {
    // Revert: `readJobSettings` skipped for `bpmn:exclusiveGateway` in
    // `xmlToIr` -> the head loses both keys.
    it('the head carries the split key and, join-prefixed, the join key', () => {
      expect(first.dsl).toBe(
        [
          'process p {',
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

describeDiContainment(rt, ['CollectReferences']);
