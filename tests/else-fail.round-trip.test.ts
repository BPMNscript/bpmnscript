// A split whose every route is conditioned and which names no fallback stops
// the run when no condition holds. `else fail` is its form in the script, so
// both directions keep that behaviour and neither reports a change.

import { describe, expect, it } from 'vitest';

import { astToIr, irToDsl, xmlToIr } from '@bpmn-script/transform';

import { bpmnDoc } from './helpers/bpmn-doc.js';
import { compareModels } from './helpers/model-equivalence.js';
import { parseToAst, roundTrip, validationErrors } from './helpers/pipeline.js';

const flow = (id: string, from: string, to: string, condition?: string) =>
  condition === undefined
    ? `    <bpmn:sequenceFlow id="${id}" sourceRef="${from}" targetRef="${to}" />`
    : `    <bpmn:sequenceFlow id="${id}" sourceRef="${from}" targetRef="${to}">` +
      `<bpmn:conditionExpression>${condition}</bpmn:conditionExpression></bpmn:sequenceFlow>`;

const twoConditionedRoutes = (kind: 'exclusiveGateway' | 'inclusiveGateway') =>
  bpmnDoc(
    [
      '    <bpmn:startEvent id="S" />',
      `    <bpmn:${kind} id="Split" />`,
      '    <bpmn:userTask id="Small" />',
      '    <bpmn:userTask id="Large" />',
      `    <bpmn:${kind} id="Merge" />`,
      '    <bpmn:endEvent id="E" />',
      flow('F0', 'S', 'Split'),
      flow('F1', 'Split', 'Small', '${amount &lt;= 1000}'),
      flow('F2', 'Split', 'Large', '${amount &gt; 5000}'),
      flow('F3', 'Small', 'Merge'),
      flow('F4', 'Large', 'Merge'),
      flow('F5', 'Merge', 'E'),
    ].join('\n'),
  );

describe("an imported split with no fallback prints as 'else fail'", () => {
  it.each([
    [
      'an exclusive gateway',
      twoConditionedRoutes('exclusiveGateway'),
      [
        '  if (amount <= 1000) {',
        '    user Small',
        '  } else if (amount > 5000) {',
        '    user Large',
        '  } else fail',
      ],
    ],
    [
      'an inclusive gateway',
      twoConditionedRoutes('inclusiveGateway'),
      [
        '  parallel {',
        '    if (amount <= 1000) {',
        '      user Small',
        '    }',
        '    if (amount > 5000) {',
        '      user Large',
        '    }',
        '    else fail',
        '  }',
      ],
    ],
  ])(
    '%s whose every route is conditioned compares with no differences and no warning',
    async (_title, xml, split) => {
      const { ir, warnings } = await xmlToIr(xml);
      const printed = irToDsl(ir);
      const rebuilt = astToIr(await parseToAst(printed.source));
      const { level, differences } = compareModels(ir, rebuilt);

      expect({
        warnings: [...warnings, ...printed.warnings],
        source: printed.source,
        errors: await validationErrors(printed.source),
        comparison: { level, differences },
      }).toEqual({
        warnings: [],
        source: [
          'process p {',
          '  var amount: any',
          '  start S',
          ...split,
          '  end E',
          '}',
          '',
        ].join('\n'),
        errors: [],
        comparison: { level: 'same', differences: [] },
      });
    },
  );
});

describe("'else fail' compiles to a split with no default and prints back unchanged", () => {
  it.each([
    [
      'an if chain',
      'if (amount <= 1000) {\n    user Small\n  } else if (amount > 5000) {\n    user Large\n  } else fail',
      'exclusiveGateway',
    ],
    [
      'a parallel block',
      'parallel {\n    if (amount <= 1000) {\n      user Small\n    }\n    if (amount > 5000) {\n      user Large\n    }\n    else fail\n  }',
      'inclusiveGateway',
    ],
  ])('%s', async (_title, split, kind) => {
    const source = `process p {\n  var amount: number\n  start S\n  ${split}\n  end E\n}\n`;
    const run = await roundTrip(source);
    const gateway = run.ir1.flowElements.find((fe) => fe.kind === kind)!;

    expect({
      default: 'defaultFlowId' in gateway ? gateway.defaultFlowId : undefined,
      routesOut: run.ir1.sequenceFlows.filter((f) => f.sourceRef === gateway.id)
        .length,
      warnings: run.warnings,
      dsl: run.dsl,
    }).toEqual({
      default: undefined,
      routesOut: 2,
      warnings: [],
      dsl: source.replace('number', 'any'),
    });
  });
});
