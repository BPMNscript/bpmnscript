import { it, expect } from 'vitest';

import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('repetition', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

// Each loop element with its host's tag and id, whitespace collapsed. A loop is
// written ahead of any nested child, so the last opening tag seen is its host.
function loops(): [tag: string, id: string, loop: string][] {
  const found: [string, string, string][] = [];
  let host: [tag: string, id: string] | undefined;
  const token =
    /<bpmn:(\w+) id="([^"]+)"|<bpmn:multiInstanceLoopCharacteristics[^>]*?(?:\/>|>[\s\S]*?<\/bpmn:multiInstanceLoopCharacteristics>)/g;
  for (const match of rt.frozenXml.matchAll(token)) {
    if (match[1] !== undefined) {
      host = [match[1], match[2]!];
    } else {
      found.push([host![0], host![1], match[0].replace(/\s+/g, ' ')]);
    }
  }
  return found;
}

it('writes each whole loop element under its own tag only, the step job around the repetition and one per run', () => {
  expect(loops()).toEqual([
    [
      'userTask',
      'ApproveLines',
      '<bpmn:multiInstanceLoopCharacteristics operaton:collection="approvers" operaton:elementVariable="approver" />',
    ],
    [
      'serviceTask',
      'ReserveStock',
      '<bpmn:multiInstanceLoopCharacteristics isSequential="true" operaton:collection="${order.lines}" operaton:elementVariable="line"> ' +
        '<bpmn:completionCondition xsi:type="bpmn:tFormalExpression">${nrOfCompletedInstances &gt;= 2}</bpmn:completionCondition> ' +
        '</bpmn:multiInstanceLoopCharacteristics>',
    ],
    [
      'serviceTask',
      'WarmPricing',
      '<bpmn:multiInstanceLoopCharacteristics operaton:asyncBefore="true" operaton:asyncAfter="true" operaton:exclusive="false"> ' +
        '<bpmn:extensionElements> ' +
        '<operaton:failedJobRetryTimeCycle>R2/PT1M</operaton:failedJobRetryTimeCycle> ' +
        '</bpmn:extensionElements> ' +
        '<bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality> ' +
        '</bpmn:multiInstanceLoopCharacteristics>',
    ],
    [
      'task',
      'RecordLine',
      '<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" operaton:elementVariable="line"> ' +
        '<bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">2</bpmn:loopCardinality> ' +
        '</bpmn:multiInstanceLoopCharacteristics>',
    ],
    [
      'receiveTask',
      'AwaitBatch',
      '<bpmn:multiInstanceLoopCharacteristics operaton:collection="batches" />',
    ],
    [
      'callActivity',
      'RegionalReport',
      '<bpmn:multiInstanceLoopCharacteristics operaton:collection="regions" operaton:elementVariable="region" />',
    ],
    [
      'scriptTask',
      'LabelParcel',
      '<bpmn:multiInstanceLoopCharacteristics operaton:collection="parcels" operaton:elementVariable="parcel" />',
    ],
    [
      'subProcess',
      'DispatchParcels',
      '<bpmn:multiInstanceLoopCharacteristics isSequential="true" operaton:collection="parcels" operaton:elementVariable="parcel" />',
    ],
  ]);
  // The step's settings sit on the task tag, the `run*` keys on the loop.
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

it("the decompiled DSL' writes every repeat clause back, and no other statement gains one", () => {
  const repeated = rt.dslPrime
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\w+ \w+ for /.test(line));
  expect(repeated).toEqual([
    'user ApproveLines for each approver in approvers(label: "Approve the order lines", assignee: "demo")',
    'service ReserveStock for each line in "${order.lines}" sequentially until (nrOfCompletedInstances >= 2)(label: "Reserve the stock", class: "com.example.orders.ReserveStockDelegate")',
    'service WarmPricing for 3(label: "Warm the pricing cache", class: "com.example.orders.WarmPricingDelegate", asyncBefore: true, retryCycle: "R3/PT10M", runAsyncBefore: true, runAsyncAfter: true, runExclusive: false, runRetryCycle: "R2/PT1M")',
    'step RecordLine for 2 each line in lines(label: "Record each line")',
    'receive AwaitBatch for each in batches(label: "Wait for each batch")',
    'call RegionalReport for each region in regions(label: "Run the regional report", process: "regional-report")',
    'script LabelParcel for each parcel in parcels(label: "Label each parcel", resultVariable: "parcelLabel") ```javascript',
    'subprocess DispatchParcels for each parcel in parcels sequentially(label: "Dispatch each parcel", asyncBefore: true) {',
  ]);
});
