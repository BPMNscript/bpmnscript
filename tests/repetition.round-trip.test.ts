import { describe, it, expect } from 'vitest';

import {
  describeDiContainment,
  describeNoOverlappingShapes,
} from './helpers/di-bounds.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('repetition', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

interface Loop {
  tag: string;
  id: string;
  /** The attributes of the opening `multiInstanceLoopCharacteristics` tag. */
  open: string;
}

/**
 * Every multi-instance element of the frozen artifact in document order, each
 * paired with the tag and id it sits under: a loop is always written ahead of
 * any nested child, so the last opening tag seen is its host.
 */
function loops(): Loop[] {
  const found: Loop[] = [];
  let host: [tag: string, id: string] | undefined;
  const token =
    /<bpmn:(\w+) id="([^"]+)"|<bpmn:multiInstanceLoopCharacteristics([^>]*)>/g;
  for (const match of rt.frozenXml.matchAll(token)) {
    if (match[1] !== undefined) {
      host = [match[1], match[2]!];
    } else {
      found.push({ tag: host![0], id: host![1], open: match[3]! });
    }
  }
  return found;
}

function loopOf(id: string): Loop {
  const found = loops().find((loop) => loop.id === id);
  expect(found, `no multi-instance element on '${id}'`).toBeDefined();
  return found!;
}

describe('multi-instance placement on the frozen .bpmn', () => {
  it('every repeated statement carries a loop, under its own tag', () => {
    expect(loops().map((loop) => [loop.tag, loop.id])).toEqual([
      ['userTask', 'ApproveLines'],
      ['serviceTask', 'ReserveStock'],
      ['serviceTask', 'WarmPricing'],
      ['task', 'RecordLine'],
      ['receiveTask', 'AwaitBatch'],
      ['callActivity', 'RegionalReport'],
      ['scriptTask', 'LabelParcel'],
      ['subProcess', 'DispatchParcels'],
    ]);
  });

  it('isSequential marks the two statements that wrote it and nothing else', () => {
    const sequential = loops().filter((loop) =>
      loop.open.includes('isSequential="true"'),
    );
    expect(sequential.map((loop) => loop.id)).toEqual([
      'ReserveStock',
      'DispatchParcels',
    ]);
    expect(rt.frozenXml).not.toContain('isSequential="false"');
  });

  it('a collection expression keeps its ${} and a variable name stays bare', () => {
    expect(loopOf('ReserveStock').open).toContain(
      'operaton:collection="${order.lines}"',
    );
    expect(loopOf('ApproveLines').open).toContain(
      'operaton:collection="approvers"',
    );
    expect(loopOf('AwaitBatch').open).not.toContain('operaton:elementVariable');
  });

  it('the two counts are a bare one and one beside a collection', () => {
    const bodies = [
      ...rt.frozenXml.matchAll(/<bpmn:loopCardinality[^>]*>([^<]*)</g),
    ].map((match) => match[1]);
    expect(bodies).toEqual(['3', '2']);
    expect(loopOf('WarmPricing').open).not.toContain('operaton:collection');
    expect(loopOf('RecordLine').open).toContain('operaton:collection="lines"');
  });

  it('one completion condition, rendered as a formal expression', () => {
    expect(rt.frozenXml.match(/<bpmn:completionCondition/g)).toHaveLength(1);
    expect(rt.frozenXml).toContain(
      '<bpmn:completionCondition xsi:type="bpmn:tFormalExpression">' +
        '${nrOfCompletedInstances &gt;= 2}</bpmn:completionCondition>',
    );
  });

  // The step's own settings sit on the task tag and make one job around the
  // repetition; the `run*` keys sit on the loop element and make one per run.
  // Revert: any direction dropping a loop setting, or `irToXml` writing a run
  // key onto the task tag.
  it("WarmPricing carries the step's job around the repetition and one per run", () => {
    expect(
      rt.frozenXml.match(
        /<bpmn:serviceTask id="WarmPricing"[\s\S]*?<\/bpmn:serviceTask>/,
      )?.[0],
    ).toBe(
      '<bpmn:serviceTask id="WarmPricing" name="Warm the pricing cache" operaton:asyncBefore="true" operaton:class="com.example.orders.WarmPricingDelegate">\n' +
        '      <bpmn:extensionElements>\n' +
        '        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>\n' +
        '      </bpmn:extensionElements>\n' +
        '      <bpmn:incoming>Flow_ReserveStock_WarmPricing</bpmn:incoming>\n' +
        '      <bpmn:outgoing>Flow_WarmPricing_RecordLine</bpmn:outgoing>\n' +
        '      <bpmn:multiInstanceLoopCharacteristics operaton:asyncBefore="true" operaton:asyncAfter="true" operaton:exclusive="false">\n' +
        '        <bpmn:extensionElements>\n' +
        '          <operaton:failedJobRetryTimeCycle>R2/PT1M</operaton:failedJobRetryTimeCycle>\n' +
        '        </bpmn:extensionElements>\n' +
        '        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>\n' +
        '      </bpmn:multiInstanceLoopCharacteristics>\n' +
        '    </bpmn:serviceTask>',
    );
  });

  it('the run settings sit on the one loop element that wrote them and on no other', () => {
    const runSettings = (open: string): string[] =>
      [...open.matchAll(/operaton:(?:async\w+|exclusive)="[^"]*"/g)].map(
        (match) => match[0],
      );
    expect(
      Object.fromEntries(
        loops().map((loop) => [loop.id, runSettings(loop.open)]),
      ),
    ).toEqual({
      ApproveLines: [],
      ReserveStock: [],
      WarmPricing: [
        'operaton:asyncBefore="true"',
        'operaton:asyncAfter="true"',
        'operaton:exclusive="false"',
      ],
      RecordLine: [],
      AwaitBatch: [],
      RegionalReport: [],
      LabelParcel: [],
      DispatchParcels: [],
    });
  });
});

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it.each([
    'user ApproveLines for each approver in approvers(' +
      'label: "Approve the order lines", assignee: "demo")',
    'service ReserveStock for each line in "${order.lines}" ' +
      'sequentially until (nrOfCompletedInstances >= 2)(' +
      'label: "Reserve the stock", ' +
      'class: "com.example.orders.ReserveStockDelegate")',
    'service WarmPricing for 3(label: "Warm the pricing cache", ' +
      'class: "com.example.orders.WarmPricingDelegate", ' +
      'asyncBefore: true, retryCycle: "R3/PT10M", ' +
      'runAsyncBefore: true, runAsyncAfter: true, runExclusive: false, ' +
      'runRetryCycle: "R2/PT1M")',
    'step RecordLine for 2 each line in lines(label: "Record each line")',
    'receive AwaitBatch for each in batches(label: "Wait for each batch")',
    'call RegionalReport for each region in regions(' +
      'label: "Run the regional report", process: "regional-report")',
    'script LabelParcel for each parcel in parcels(' +
      'label: "Label each parcel", resultVariable: "parcelLabel")',
    'subprocess DispatchParcels for each parcel in parcels sequentially(' +
      'label: "Dispatch each parcel", asyncBefore: true)',
  ])("the decompiled DSL' writes back `%s`", (clause) => {
    expect(rt.dslPrime).toContain(clause);
  });
});

describeNoOverlappingShapes(rt);
describeDiContainment(rt, ['DispatchParcels', 'HandToCarrier']);
