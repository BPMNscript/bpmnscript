// A `goto` names a statement, and gateways have no statement form, so an edge
// into a gateway is expressible only through the gateway's successor, and only
// while the gateway routes one way. The shapes below sit on both sides of that
// line, and the clean ones at the end pin that the fallback never turns a
// `while` into a jump.

import { describe, it, expect } from 'vitest';

import { DiagnosticSeverity } from 'vscode-languageserver-types';

import {
  xmlToIr,
  astToIr,
  irToDsl,
  irToXml,
  UNSTRUCTURED_MARKER,
} from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { realNodeReachability } from './helpers/real-node-reachability.js';
import {
  parseToAst as parseUnvalidated,
  printDsl,
  validate,
} from './helpers/pipeline.js';

// Validates as well as parses: a `goto` naming an elided node, or one that
// leaves a later statement unreachable, parses fine and fails only in the
// validator.
async function parseToAst(source: string) {
  const { document, diagnostics } = await validate(source);
  const problems = diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  if (problems.length > 0) {
    throw new Error(
      'Errors in emitted DSL:\n' + problems.map((d) => d.message).join('\n'),
    );
  }
  return document.parseResult.value;
}

async function emit(ir: BpmnProcess) {
  const { ir: imported, warnings } = await xmlToIr(await irToXml(ir));
  expect(warnings).toEqual([]);
  return { imported, dsl: printDsl(imported) };
}

const flow = (id: string, from: string, to: string, condition?: string) => ({
  id,
  sourceRef: from,
  targetRef: to,
  ...(condition !== undefined ? { conditionExpression: condition } : {}),
});

const task = (id: string) => ({ kind: 'userTask' as const, id });

const JOIN_HEADED_LOOP: BpmnProcess = {
  id: 'JoinHeadedLoop',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start_1' },
    { kind: 'exclusiveGateway', id: 'Gateway_H_join' },
    task('T1'),
    { kind: 'exclusiveGateway', id: 'Gateway_X_split' },
    task('T2'),
    { kind: 'endEvent', id: 'End_1' },
  ],
  sequenceFlows: [
    flow('f1', 'Start_1', 'Gateway_H_join'),
    flow('f2', 'Gateway_H_join', 'T1'),
    flow('f3', 'T1', 'Gateway_X_split'),
    flow('f4', 'Gateway_X_split', 'T2', '${c}'),
    flow('f5', 'Gateway_X_split', 'End_1'),
    flow('f6', 'T2', 'Gateway_H_join'),
  ],
};

describe('back-edge into a pass-through join whose out-edge is already consumed', () => {
  // The structured walk printed the join's out-edge, but printing an edge does
  // not stop it existing, so the jump resolves through the join to `T1`.
  it("carries the back-edge as a `goto` naming the join's successor and keeps the reachability", async () => {
    const { imported, dsl } = await emit(JOIN_HEADED_LOOP);
    expect(dsl).toBe(
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
      ].join('\n'),
    );
    const reDesugared = astToIr(await parseToAst(dsl));
    expect(realNodeReachability(reDesugared)).toEqual(
      realNodeReachability(imported),
    );
  });
});

const BACK_EDGE_CONDITION_LOOP: BpmnProcess = {
  id: 'BackEdgeConditionLoop',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start_1' },
    { kind: 'exclusiveGateway', id: 'Gateway_L_loop' },
    task('Body_1'),
    { kind: 'endEvent', id: 'End_1' },
  ],
  sequenceFlows: [
    flow('f1', 'Start_1', 'Gateway_L_loop'),
    flow('f2', 'Gateway_L_loop', 'Body_1'),
    flow('f3', 'Gateway_L_loop', 'End_1', '${done}'),
    flow('f4', 'Body_1', 'Gateway_L_loop', '${more}'),
  ],
};

describe('loop condition on the back-edge (no expressible jump target)', () => {
  // No loop pattern matches, so the head prints as an `if` and the back-edge
  // still points at a two-way gateway. A jump to the head would re-run the
  // `done` test and a jump to the body would skip it, so the edge is dropped
  // and the marker names where.
  it('drops the conditioned back-edge with a marker naming the gateway, and never invents a target', async () => {
    const { imported, dsl } = await emit(BACK_EDGE_CONDITION_LOOP);
    // The loss happens on emission, not on import: the IR still has the edge.
    expect(
      imported.sequenceFlows.find(
        (f) => f.sourceRef === 'Body_1' && f.targetRef === 'Gateway_L_loop',
      )?.conditionExpression,
    ).toBe('${more}');
    expect(dsl).toBe(
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
      ].join('\n'),
    );
    await expect(parseToAst(dsl)).resolves.toBeDefined();
  });
});

// The approve-review loop as a modeler draws it: the split inside the body and
// the loop gateway both carry a condition on every route and name no default.
// The route leaving the loop puts the split's immediate post-dominator outside
// it, so the split has neither a clean join nor a guard clause.
const REVIEW_LOOP: BpmnProcess = {
  id: 'ReviewLoop',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start_1' },
    task('Approve'),
    { kind: 'exclusiveGateway', id: 'Gateway_approved' },
    task('Review'),
    { kind: 'exclusiveGateway', id: 'Gateway_clarified' },
    task('Pay'),
    { kind: 'endEvent', id: 'End_1' },
    { kind: 'endEvent', id: 'End_2' },
  ],
  sequenceFlows: [
    flow('f1', 'Start_1', 'Approve'),
    flow('f2', 'Approve', 'Gateway_approved'),
    flow('f3', 'Gateway_approved', 'Pay', '${approved}'),
    flow('f4', 'Gateway_approved', 'Review', '${!approved}'),
    flow('f5', 'Review', 'Gateway_clarified'),
    flow('f6', 'Gateway_clarified', 'Approve', '${clarified}'),
    flow('f7', 'Gateway_clarified', 'End_2', '${!clarified}'),
    flow('f8', 'Pay', 'End_1'),
  ],
};

describe('a split inside a loop body whose every route is conditioned', () => {
  it('keeps the route that stays in the loop, so only the leaving route is a jump', async () => {
    const { imported, dsl } = await emit(REVIEW_LOOP);
    expect(dsl).toBe(
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
      ].join('\n'),
    );

    // The chain closes with no `else`, so the recompiled split falls through
    // to the loop gateway where the model had no route: `Approve` gains the
    // two routes that gateway takes, and loses none it had.
    const reDesugared = astToIr(await parseToAst(dsl));
    expect(realNodeReachability(reDesugared)).toEqual(
      [
        ...realNodeReachability(imported),
        'Approve->Approve',
        'Approve->End_2',
      ].sort(),
    );
  });
});

const SURPLUS_EDGE_ON_TASK: BpmnProcess = {
  id: 'SurplusEdgeOnTask',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start_1' },
    { kind: 'exclusiveGateway', id: 'Gateway_H_join' },
    task('T1'),
    task('Cont'),
    task('Later'),
    { kind: 'endEvent', id: 'End_1' },
  ],
  sequenceFlows: [
    flow('f1', 'Start_1', 'Gateway_H_join'),
    flow('f2', 'Gateway_H_join', 'T1'),
    flow('f3', 'T1', 'Cont'),
    flow('f4', 'T1', 'Gateway_H_join'),
    flow('f5', 'Cont', 'Later'),
    flow('f6', 'Later', 'End_1'),
  ],
};

describe('surplus out-edge on a plain node keeps the fall-through', () => {
  // A bare `goto` beside the fall-through would end the chain and leave
  // everything after it unreachable, so both routes head a branch. The back
  // edge names `T1`, the one step the join leads to, and each route ends in
  // its own branch, so the fork needs no merge to print as a block.
  it('gives both routes a branch rather than a jump beside the fall-through, and keeps the rest reachable', async () => {
    const { imported, dsl } = await emit(SURPLUS_EDGE_ON_TASK);
    expect(dsl).toBe(
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
      ].join('\n'),
    );
    const reDesugared = astToIr(await parseToAst(dsl));
    expect(realNodeReachability(reDesugared)).toEqual(
      realNodeReachability(imported),
    );
  });
});

// A synthesized terminal is not printed at all, and `await` prints only its
// trigger, so a jump into either has nothing to name.
describe('a goto never names a node the emitter elides', () => {
  it.each<[title: string, ir: BpmnProcess, printed: string[]]>([
    [
      'marks the edge instead of naming a synthesized terminal',
      {
        id: 'ElidedTerminal',
        isExecutable: true,
        flowElements: [
          { kind: 'startEvent', id: 'Start_1' },
          task('T1'),
          { kind: 'exclusiveGateway', id: 'Gateway_E_join' },
          { kind: 'endEvent', id: 'EndEvent_ElidedTerminal' },
        ],
        sequenceFlows: [
          flow('f1', 'Start_1', 'T1'),
          flow('f2', 'T1', 'Gateway_E_join'),
          flow('f3', 'Gateway_E_join', 'EndEvent_ElidedTerminal'),
          flow('f4', 'T1', 'Gateway_E_join'),
        ],
      },
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
    ],
    [
      'marks the edge instead of naming an awaited catch event',
      {
        id: 'CatchLoop',
        isExecutable: true,
        flowElements: [
          { kind: 'startEvent', id: 'Start_1' },
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
        sequenceFlows: [
          flow('f1', 'Start_1', 'Catch_1'),
          flow('f2', 'Catch_1', 'T1'),
          flow('f3', 'T1', 'Catch_1'),
        ],
      },
      [
        'process CatchLoop {',
        '  start Start_1',
        '  await timer("PT5M")',
        '  user T1',
        `  ${UNSTRUCTURED_MARKER} (dropped edge into Catch_1)`,
        '}',
        '',
      ],
    ],
  ])('%s', async (_title, ir, printed) => {
    const { dsl } = await emit(ir);
    expect(dsl).toBe(printed.join('\n'));
    await expect(parseToAst(dsl)).resolves.toBeDefined();
  });
});

describe('shapes that structure cleanly stay structured', () => {
  it.each<[title: string, ir: BpmnProcess, printed: string[]]>([
    [
      'nests an `if` inside an `if` branch',
      {
        id: 'NestedIf',
        isExecutable: true,
        flowElements: [
          { kind: 'startEvent', id: 'Start_1' },
          { kind: 'exclusiveGateway', id: 'Gateway_O_split' },
          { kind: 'exclusiveGateway', id: 'Gateway_I_split' },
          task('Inner_1'),
          task('Inner_2'),
          { kind: 'exclusiveGateway', id: 'Gateway_I_join' },
          task('Outer_1'),
          { kind: 'exclusiveGateway', id: 'Gateway_O_join' },
          { kind: 'endEvent', id: 'End_1' },
        ],
        sequenceFlows: [
          flow('f1', 'Start_1', 'Gateway_O_split'),
          flow('f2', 'Gateway_O_split', 'Gateway_I_split', '${a}'),
          flow('f3', 'Gateway_O_split', 'Outer_1'),
          flow('f4', 'Gateway_I_split', 'Inner_1', '${b}'),
          flow('f5', 'Gateway_I_split', 'Inner_2'),
          flow('f6', 'Inner_1', 'Gateway_I_join'),
          flow('f7', 'Inner_2', 'Gateway_I_join'),
          flow('f8', 'Gateway_I_join', 'Gateway_O_join'),
          flow('f9', 'Outer_1', 'Gateway_O_join'),
          flow('f10', 'Gateway_O_join', 'End_1'),
        ],
      },
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
    ],
    [
      'emits two sibling `if`s for two independent splits in sequence',
      {
        id: 'SiblingIfs',
        isExecutable: true,
        flowElements: [
          { kind: 'startEvent', id: 'Start_1' },
          { kind: 'exclusiveGateway', id: 'Gateway_A_split' },
          task('A_1'),
          { kind: 'exclusiveGateway', id: 'Gateway_A_join' },
          { kind: 'exclusiveGateway', id: 'Gateway_B_split' },
          task('B_1'),
          { kind: 'exclusiveGateway', id: 'Gateway_B_join' },
          { kind: 'endEvent', id: 'End_1' },
        ],
        sequenceFlows: [
          flow('f1', 'Start_1', 'Gateway_A_split'),
          flow('f2', 'Gateway_A_split', 'A_1', '${a}'),
          flow('f3', 'Gateway_A_split', 'Gateway_A_join'),
          flow('f4', 'A_1', 'Gateway_A_join'),
          flow('f5', 'Gateway_A_join', 'Gateway_B_split'),
          flow('f6', 'Gateway_B_split', 'B_1', '${b}'),
          flow('f7', 'Gateway_B_split', 'Gateway_B_join'),
          flow('f8', 'B_1', 'Gateway_B_join'),
          flow('f9', 'Gateway_B_join', 'End_1'),
        ],
      },
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
    ],
  ])('%s', async (_title, ir, printed) => {
    const dsl = printDsl(ir);
    expect(dsl).toBe(printed.join('\n'));
    await expect(parseToAst(dsl)).resolves.toBeDefined();
  });
});

const compiled = async (source: string) => astToIr(await parseToAst(source));

// `do { end X } while (true)` compiles to a loop gateway with no incoming flow
// (the body always ends, so `lowerDoWhile` wires no back edge), and the
// validator refuses the statement it proves unreachable, so the shapes carrying
// it skip validation or are built as IR, the way a Modeler file would import.
const compiledUnvalidated = async (source: string) =>
  astToIr(await parseUnvalidated(source));

const DANGLING_LOOP_HEAD: BpmnProcess = {
  id: 'DanglingLoopHead',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'S' },
    { kind: 'endEvent', id: 'X' },
    { kind: 'exclusiveGateway', id: 'Gateway_L_loop', defaultFlowId: 'f3' },
    { kind: 'endEvent', id: 'Done' },
  ],
  sequenceFlows: [
    flow('f1', 'S', 'X'),
    flow('f2', 'Gateway_L_loop', 'X', '${true}'),
    flow('f3', 'Gateway_L_loop', 'Done'),
  ],
};

// Shapes a fuzz run drew, each exported, imported and printed. A row pins the
// print's whole warning list by category and whether the print validates, so a
// shape that stops being reported, or starts failing, turns the row red rather
// than the next fuzz run.
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
      () => Promise.resolve(DANGLING_LOOP_HEAD),
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
