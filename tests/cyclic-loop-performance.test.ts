// `loopEntries` re-runs `loopTestRank` once per nested SCC, so gotos tying
// every loop into one cycle print in roughly cubic time; the budget keeps that
// known limit from growing.
import { describe, expect, it } from 'vitest';
import { astToIr, irToDsl } from '@bpmn-script/transform';
import { parseToAst } from './helpers/pipeline.js';

const WHILE_COUNT = 150;
const BUDGET_MS = 60_000;

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

describe('CFG analysis performance on tied loops', () => {
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
