// `tryWhile` and `tryDoWhileEntry` in `ir-to-dsl.ts` ask
// `CfgAnalysis.backEdges()` once per emitted node, so a straight chain of n
// tasks costs O(n^3) unless `backEdges()` is computed once and `dominates`
// answers in two map lookups. Reverting either guard alone leaves O(n^2),
// which still finishes inside the budget; only reverting both turns this red.
import { describe, expect, it } from 'vitest';
import { xmlToIr } from '@bpmn-script/transform';
import { parseToAst, printDsl } from './helpers/pipeline.js';

const TASK_COUNT = 1000;

function chainBpmn(taskCount: number): string {
  const flowElements: string[] = [
    '<bpmn:startEvent id="Begin"><bpmn:outgoing>Flow_0</bpmn:outgoing></bpmn:startEvent>',
  ];
  const sequenceFlows: string[] = [];
  let previousId = 'Begin';

  for (let i = 1; i <= taskCount; i++) {
    const taskId = `Task_${i}`;
    const flowId = `Flow_${i - 1}`;
    // `name` matches `humanize(taskId)`, so the printer drops the label.
    flowElements.push(
      `<bpmn:task id="${taskId}" name="Task ${i}"><bpmn:incoming>${flowId}</bpmn:incoming></bpmn:task>`,
    );
    sequenceFlows.push(
      `<bpmn:sequenceFlow id="${flowId}" sourceRef="${previousId}" targetRef="${taskId}" />`,
    );
    previousId = taskId;
  }

  const endFlowId = `Flow_${taskCount}`;
  flowElements.push(
    `<bpmn:endEvent id="Done"><bpmn:incoming>${endFlowId}</bpmn:incoming></bpmn:endEvent>`,
  );
  sequenceFlows.push(
    `<bpmn:sequenceFlow id="${endFlowId}" sourceRef="${previousId}" targetRef="Done" />`,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_chain" targetNamespace="http://bpmn.io/schema/bpmn">',
    '  <bpmn:process id="Process_chain" isExecutable="true">',
    ...flowElements.map((line) => `    ${line}`),
    ...sequenceFlows.map((line) => `    ${line}`),
    '  </bpmn:process>',
    '</bpmn:definitions>',
  ].join('\n');
}

describe('CFG analysis performance', () => {
  it('imports and prints a 1,000-task straight-line chain in under 3 s', async () => {
    const xml = chainBpmn(TASK_COUNT);

    const started = performance.now();
    const { ir } = await xmlToIr(xml);
    const source = printDsl(ir);
    const elapsed = performance.now() - started;

    const stepLines = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('step '));
    expect(stepLines).toEqual(
      Array.from({ length: TASK_COUNT }, (_, i) => `step Task_${i + 1}`),
    );
    expect(elapsed).toBeLessThan(3000);
    await parseToAst(source);
  });
});
