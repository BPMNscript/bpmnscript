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
});

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it.each([
    'user ApproveLines "Approve the order lines" for each approver in approvers',
    'service ReserveStock "Reserve the stock" for each line in "${order.lines}" ' +
      'sequentially until (nrOfCompletedInstances >= 2)',
    'service WarmPricing "Warm the pricing cache" for 3',
    'step RecordLine "Record each line" for 2 each line in lines',
    'receive AwaitBatch "Wait for each batch" for each in batches',
    'call RegionalReport "Run the regional report" for each region in regions',
    'script LabelParcel "Label each parcel" for each parcel in parcels',
    'subprocess DispatchParcels "Dispatch each parcel" for each parcel in parcels sequentially',
  ])("the decompiled DSL' writes back `%s`", (clause) => {
    expect(rt.dslPrime).toContain(clause);
  });
});

describeNoOverlappingShapes(rt);
describeDiContainment(rt, ['DispatchParcels', 'HandToCarrier']);
