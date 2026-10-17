import { describe, expect, it } from 'vitest';
import { astToIr, irToDsl, xmlToIr } from '@bpmn-script/transform';
import { parseToAst, printDsl } from './helpers/pipeline.js';

const TASK_COUNT = 1000;
const WHILE_COUNT = 150;
const BUDGET_MS = 60_000;

function chainBpmn(taskCount: number): string {
  const flowElements: string[] = [
    '<bpmn:startEvent id="Begin"><bpmn:outgoing>Flow_0</bpmn:outgoing></bpmn:startEvent>',
  ];
  const sequenceFlows: string[] = [];
  let previousId = 'Begin';

  for (let i = 1; i <= taskCount; i++) {
    const taskId = `Task_${i}`;
    const flowId = `Flow_${i - 1}`;
    // `name` is `humanize(taskId)`, so the printer drops it.
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

// Each `goto` ties a while into the previous one's body: one SCC overall.
function cyclicWhiles(n: number): string {
  const lines = ['process p {', '  var x: any', '  var c: any'];
  for (let i = 0; i < n; i++) {
    lines.push(`  while (x) {\n    user W${i}\n    user V${i}\n  }`);
    if (i > 0) lines.push(`  if (c) {\n    goto V${i - 1}\n  }`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

describe('CFG analysis performance', () => {
  // The printer asks `CfgAnalysis.backEdges()` once per emitted node, so a
  // chain of n tasks is O(n^3) unless `backEdges()` is cached and `dominates`
  // is two map lookups. Only reverting both guards turns this red.
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

  // `loopEntries` re-runs `loopTestRank` once per nested SCC, so gotos tying
  // every loop into one cycle print in roughly cubic time; the budget keeps
  // that known limit from growing.
  it(
    'prints 150 goto-tied whiles in under 60 s',
    async () => {
      const source = cyclicWhiles(WHILE_COUNT);
      const ir = astToIr(await parseToAst(source));

      const started = performance.now();
      const { source: printed, warnings } = irToDsl(ir);
      const elapsed = performance.now() - started;

      expect(elapsed).toBeLessThan(BUDGET_MS);
      expect(warnings).toEqual([]);
      const whileLines = printed
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('while ('));
      expect(whileLines).toEqual(Array(WHILE_COUNT).fill('while (x) {'));
      await parseToAst(printed);
    },
    BUDGET_MS + 15_000,
  );
});
