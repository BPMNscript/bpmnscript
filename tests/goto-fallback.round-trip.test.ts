// A `goto` names a statement, and gateways have no statement form, so an edge
// into a gateway is expressible only through the gateway's successor, and only
// while the gateway routes one way.

import { describe, it, expect } from 'vitest';

import {
  xmlToIr,
  astToIr,
  irToDsl,
  irToXml,
  UNSTRUCTURED_MARKER,
} from '@bpmn-script/transform';
import type { BpmnProcess, FlowElement } from '@bpmn-script/transform';

import { realNodeReachability } from './helpers/real-node-reachability.js';
import {
  parseToAst as parseUnvalidated,
  validationErrors,
} from './helpers/pipeline.js';

// A `goto` naming an elided node, or one that leaves a later statement
// unreachable, parses fine and fails only in the validator.
async function parseToAst(source: string) {
  const problems = await validationErrors(source);
  if (problems.length > 0) {
    throw new Error('Errors in emitted DSL:\n' + problems.join('\n'));
  }
  return parseUnvalidated(source);
}

const proc = (
  id: string,
  flowElements: FlowElement[],
  flows: [id: string, from: string, to: string, condition?: string][],
): BpmnProcess => ({
  id,
  isExecutable: true,
  flowElements,
  sequenceFlows: flows.map(([fid, sourceRef, targetRef, condition]) => ({
    id: fid,
    sourceRef,
    targetRef,
    ...(condition !== undefined ? { conditionExpression: condition } : {}),
  })),
});

const task = (id: string) => ({ kind: 'userTask' as const, id });
const xor = (id: string) => ({ kind: 'exclusiveGateway' as const, id });
const start = { kind: 'startEvent' as const, id: 'Start_1' };
const end = (id = 'End_1') => ({ kind: 'endEvent' as const, id });

// `gained` is what the recompiled print reaches beyond the import; null skips
// the check, for rows whose print drops an edge behind a marker.
describe('an edge with no statement form degrades without inventing a target, and clean shapes stay structured', () => {
  it.each<
    [title: string, ir: BpmnProcess, printed: string[], gained: string[] | null]
  >([
    [
      // Printing the join's out-edge does not stop it existing, so the jump
      // resolves through the join to `T1`.
      "a back-edge into a pass-through join whose out-edge is already printed is a `goto` naming the join's successor",
      proc(
        'JoinHeadedLoop',
        [
          start,
          xor('Gateway_H_join'),
          task('T1'),
          xor('Gateway_X_split'),
          task('T2'),
          end(),
        ],
        [
          ['f1', 'Start_1', 'Gateway_H_join'],
          ['f2', 'Gateway_H_join', 'T1'],
          ['f3', 'T1', 'Gateway_X_split'],
          ['f4', 'Gateway_X_split', 'T2', '${c}'],
          ['f5', 'Gateway_X_split', 'End_1'],
          ['f6', 'T2', 'Gateway_H_join'],
        ],
      ),
      [
        'process JoinHeadedLoop {',
        '  var c: any',
        '  start Start_1',
        '  user T1',
        '  if (c) {',
        '    user T2',
        '    goto T1',
        '  }',
        '  end End_1',
        '}',
        '',
      ],
      [],
    ],
    [
      // No loop pattern matches, so the back-edge still points at a two-way
      // gateway: a jump to the head would re-run the `done` test and a jump to
      // the body would skip it.
      'a conditioned back-edge into a two-way loop head is dropped with a marker naming the gateway',
      proc(
        'BackEdgeConditionLoop',
        [start, xor('Gateway_L_loop'), task('Body_1'), end()],
        [
          ['f1', 'Start_1', 'Gateway_L_loop'],
          ['f2', 'Gateway_L_loop', 'Body_1'],
          ['f3', 'Gateway_L_loop', 'End_1', '${done}'],
          ['f4', 'Body_1', 'Gateway_L_loop', '${more}'],
        ],
      ),
      [
        'process BackEdgeConditionLoop {',
        '  var done: any',
        '  var more: any',
        '  start Start_1',
        '  if (done) {',
        '  } else {',
        '    user Body_1',
        `    ${UNSTRUCTURED_MARKER} (dropped edge into Gateway_L_loop)`,
        '  }',
        '  end End_1',
        '}',
        '',
      ],
      null,
    ],
    [
      // Every route of both gateways is conditioned and none is a default, so
      // the split's post-dominator lies outside the loop. The chain closes with
      // no `else`, so the recompiled split falls through to the loop gateway:
      // `Approve` gains the two routes it takes.
      'a split inside a loop body whose every route is conditioned keeps the route that stays in the loop',
      proc(
        'ReviewLoop',
        [
          start,
          task('Approve'),
          xor('Gateway_approved'),
          task('Review'),
          xor('Gateway_clarified'),
          task('Pay'),
          end(),
          end('End_2'),
        ],
        [
          ['f1', 'Start_1', 'Approve'],
          ['f2', 'Approve', 'Gateway_approved'],
          ['f3', 'Gateway_approved', 'Pay', '${approved}'],
          ['f4', 'Gateway_approved', 'Review', '${!approved}'],
          ['f5', 'Review', 'Gateway_clarified'],
          ['f6', 'Gateway_clarified', 'Approve', '${clarified}'],
          ['f7', 'Gateway_clarified', 'End_2', '${!clarified}'],
          ['f8', 'Pay', 'End_1'],
        ],
      ),
      [
        'process ReviewLoop {',
        '  var approved: any',
        '  var clarified: any',
        '  start Start_1',
        '  do {',
        '    user Approve',
        '    if (approved) {',
        '      goto Pay',
        '    } else if (!approved) {',
        '      user Review',
        '    }',
        '  } while (clarified)',
        '  end End_2',
        '  user Pay',
        '  end End_1',
        '}',
        '',
      ],
      ['Approve->Approve', 'Approve->End_2'],
    ],
    [
      // A bare `goto` beside the fall-through would leave the rest
      // unreachable, so both routes head a branch.
      'a surplus out-edge on a plain node gives both routes a branch rather than a jump beside the fall-through',
      proc(
        'SurplusEdgeOnTask',
        [
          start,
          xor('Gateway_H_join'),
          task('T1'),
          task('Cont'),
          task('Later'),
          end(),
        ],
        [
          ['f1', 'Start_1', 'Gateway_H_join'],
          ['f2', 'Gateway_H_join', 'T1'],
          ['f3', 'T1', 'Cont'],
          ['f4', 'T1', 'Gateway_H_join'],
          ['f5', 'Cont', 'Later'],
          ['f6', 'Later', 'End_1'],
        ],
      ),
      [
        'process SurplusEdgeOnTask {',
        '  start Start_1',
        '  user T1',
        '  parallel {',
        '    {',
        '      user Cont',
        '      user Later',
        '      end End_1',
        '    }',
        '    {',
        '      goto T1',
        '    }',
        '  }',
        '}',
        '',
      ],
      [],
    ],
    [
      // A synthesized terminal is not printed, so a jump into it has nothing to name.
      'an edge into a synthesized terminal is marked, not a goto',
      proc(
        'ElidedTerminal',
        [
          start,
          task('T1'),
          xor('Gateway_E_join'),
          end('EndEvent_ElidedTerminal'),
        ],
        [
          ['f1', 'Start_1', 'T1'],
          ['f2', 'T1', 'Gateway_E_join'],
          ['f3', 'Gateway_E_join', 'EndEvent_ElidedTerminal'],
          ['f4', 'T1', 'Gateway_E_join'],
        ],
      ),
      [
        'process ElidedTerminal {',
        '  start Start_1',
        '  user T1',
        `  ${UNSTRUCTURED_MARKER} (split T1 degraded to jumps; was parallel)`,
        '  if (true) {',
        `    ${UNSTRUCTURED_MARKER} (dropped edge into Gateway_E_join)`,
        '  } else {',
        `    ${UNSTRUCTURED_MARKER} (dropped edge into Gateway_E_join)`,
        '  }',
        '}',
        '',
      ],
      null,
    ],
    [
      // `await` prints only its trigger, so a jump into it has nothing to name.
      'an edge into an awaited catch event is marked, not a goto',
      proc(
        'CatchLoop',
        [
          start,
          {
            kind: 'intermediateCatchEvent',
            id: 'Catch_1',
            eventDefinition: {
              kind: 'timer',
              timerKind: 'duration',
              expression: 'PT5M',
            },
          },
          task('T1'),
        ],
        [
          ['f1', 'Start_1', 'Catch_1'],
          ['f2', 'Catch_1', 'T1'],
          ['f3', 'T1', 'Catch_1'],
        ],
      ),
      [
        'process CatchLoop {',
        '  start Start_1',
        '  await timer("PT5M")',
        '  user T1',
        `  ${UNSTRUCTURED_MARKER} (dropped edge into Catch_1)`,
        '}',
        '',
      ],
      null,
    ],
    [
      'an `if` nested inside an `if` branch stays nested',
      proc(
        'NestedIf',
        [
          start,
          xor('Gateway_O_split'),
          xor('Gateway_I_split'),
          task('Inner_1'),
          task('Inner_2'),
          xor('Gateway_I_join'),
          task('Outer_1'),
          xor('Gateway_O_join'),
          end(),
        ],
        [
          ['f1', 'Start_1', 'Gateway_O_split'],
          ['f2', 'Gateway_O_split', 'Gateway_I_split', '${a}'],
          ['f3', 'Gateway_O_split', 'Outer_1'],
          ['f4', 'Gateway_I_split', 'Inner_1', '${b}'],
          ['f5', 'Gateway_I_split', 'Inner_2'],
          ['f6', 'Inner_1', 'Gateway_I_join'],
          ['f7', 'Inner_2', 'Gateway_I_join'],
          ['f8', 'Gateway_I_join', 'Gateway_O_join'],
          ['f9', 'Outer_1', 'Gateway_O_join'],
          ['f10', 'Gateway_O_join', 'End_1'],
        ],
      ),
      [
        'process NestedIf {',
        '  var a: any',
        '  var b: any',
        '  start Start_1',
        '  if (a) {',
        '    if (b) {',
        '      user Inner_1',
        '    } else {',
        '      user Inner_2',
        '    }',
        '  } else {',
        '    user Outer_1',
        '  }',
        '  end End_1',
        '}',
        '',
      ],
      [],
    ],
    [
      'two independent splits in sequence print as two sibling `if`s',
      proc(
        'SiblingIfs',
        [
          start,
          xor('Gateway_A_split'),
          task('A_1'),
          xor('Gateway_A_join'),
          xor('Gateway_B_split'),
          task('B_1'),
          xor('Gateway_B_join'),
          end(),
        ],
        [
          ['f1', 'Start_1', 'Gateway_A_split'],
          ['f2', 'Gateway_A_split', 'A_1', '${a}'],
          ['f3', 'Gateway_A_split', 'Gateway_A_join'],
          ['f4', 'A_1', 'Gateway_A_join'],
          ['f5', 'Gateway_A_join', 'Gateway_B_split'],
          ['f6', 'Gateway_B_split', 'B_1', '${b}'],
          ['f7', 'Gateway_B_split', 'Gateway_B_join'],
          ['f8', 'B_1', 'Gateway_B_join'],
          ['f9', 'Gateway_B_join', 'End_1'],
        ],
      ),
      [
        'process SiblingIfs {',
        '  var a: any',
        '  var b: any',
        '  start Start_1',
        '  if (a) {',
        '    user A_1',
        '  }',
        '  if (b) {',
        '    user B_1',
        '  }',
        '  end End_1',
        '}',
        '',
      ],
      [],
    ],
  ])('%s', async (_title, ir, printed, gained) => {
    const { ir: imported, warnings } = await xmlToIr(await irToXml(ir));
    expect(warnings).toEqual([]);
    // Any loss happens on emission, never on import.
    expect(imported.sequenceFlows).toEqual(ir.sequenceFlows);

    const { source: dsl } = irToDsl(imported);
    expect(dsl).toBe(printed.join('\n'));
    const reDesugared = astToIr(await parseToAst(dsl));
    if (gained !== null) {
      expect(realNodeReachability(reDesugared)).toEqual(
        [...realNodeReachability(imported), ...gained].sort(),
      );
    }
  });
});

const compiled = async (source: string) => astToIr(await parseToAst(source));

// `do { end X } while (true)` compiles to a loop gateway with no incoming flow,
// and the validator refuses the statement it proves unreachable, so those
// shapes skip validation or are built as IR, the way a Modeler file imports.
const compiledUnvalidated = async (source: string) =>
  astToIr(await parseUnvalidated(source));

// Fuzz-drawn shapes: each row pins the print's warning categories and whether
// it validates.
describe('composite shapes through compile, import and print', () => {
  it.each<
    [
      title: string,
      shape: () => Promise<BpmnProcess>,
      categories: string[],
      valid: boolean,
    ]
  >([
    [
      'a loop and a throw inside a guarded branch walk inline',
      () =>
        compiled(
          [
            'process p {',
            '  escalation E',
            '  start S',
            '  if (true) {',
            '    while (true) {',
            '      script A ```javascript',
            'x = 1',
            '```',
            '    }',
            '    throw escalation X(E)',
            '  }',
            '  end Done',
            '}',
          ].join('\n'),
        ),
      [],
      true,
    ],
    [
      'a pre-test loop whose body ends prints as a guard clause jumping to the body',
      () =>
        compiled(
          'process p {\n  start S\n  while (true) {\n    user A\n    end X\n  }\n  user B\n  end Done\n}',
        ),
      [],
      true,
    ],
    [
      'a fork with an empty weighed branch beside an ending one prints whole',
      () =>
        compiled(
          'process p {\n  start S\n  parallel {\n    if (true) {\n    }\n    {\n      end X\n    }\n  }\n  end Done\n}',
        ),
      [],
      true,
    ],
    [
      'a fork carrying settings with an ending branch prints whole',
      () =>
        compiled(
          'process p {\n  start S\n  parallel (retryCycle: "R1/PT1M") {\n    {\n      user A\n    }\n    {\n      end X\n    }\n  }\n  end Done\n}',
        ),
      [],
      true,
    ],
    [
      'a race branch holding a post-test loop whose body ends draws a jump into the branch',
      () =>
        compiledUnvalidated(
          'process p {\n  start S\n  await {\n    timer("PT1M") {\n    }\n    message("m") {\n      do {\n        end X\n      } while (true)\n    }\n  }\n  end Done\n}',
        ),
      ['refusedStatement'],
      false,
    ],
    [
      'a fork branch holding a post-test loop whose body ends draws a jump into the branch',
      () =>
        compiledUnvalidated(
          'process p {\n  start S\n  parallel {\n    {\n      user F\n    }\n    if (true) {\n      do {\n        end S2\n      } while (true)\n    }\n  }\n  end Done\n}',
        ),
      ['refusedStatement'],
      false,
    ],
    [
      'a post-test loop whose body ends prints its unreachable head as a jump',
      () =>
        Promise.resolve(
          proc(
            'DanglingLoopHead',
            [
              { kind: 'startEvent', id: 'S' },
              end('X'),
              {
                kind: 'exclusiveGateway',
                id: 'Gateway_L_loop',
                defaultFlowId: 'f3',
              },
              end('Done'),
            ],
            [
              ['f1', 'S', 'X'],
              ['f2', 'Gateway_L_loop', 'X', '${true}'],
              ['f3', 'Gateway_L_loop', 'Done'],
            ],
          ),
        ),
      [],
      false,
    ],
  ])('%s', async (_title, shape, categories, valid) => {
    const { ir: imported, warnings } = await xmlToIr(
      await irToXml(await shape()),
    );
    expect(warnings).toEqual([]);
    const printed = irToDsl(imported);

    expect(printed.warnings.map((w) => w.category)).toEqual(categories);
    expect(
      await parseToAst(printed.source).then(
        () => true,
        () => false,
      ),
    ).toBe(valid);
  });
});
