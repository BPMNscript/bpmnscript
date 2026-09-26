// A `goto` names a statement, and gateways have no statement form, so an edge
// into a gateway is expressible only through the gateway's successor and only
// while the gateway's routing has a single outcome. Two ordinary BPMN shapes
// sit either side of that line:
//
//   - A loop headed by a pass-through join. One successor, so the back-edge is
//     expressible even though the structured walk already consumed the join's
//     out-edge. Consumption records that an edge was printed, not that it
//     stopped existing.
//   - A loop with the condition on the back-edge. No loop pattern matches, so
//     the head gateway prints as an `if` and the back-edge still points at a
//     two-way gateway. Nothing names that, so the edge is dropped and the
//     marker records where.
//
// The rest of the file pins the shapes that structure cleanly, so a change to
// the fallback cannot turn a `while` into a jump unnoticed.

import { describe, it, expect, beforeAll } from 'vitest';

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';

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
  parse,
  parseToAst as parseUnvalidated,
  printDsl,
} from './helpers/pipeline.js';

// Validation, not just parsing: a `goto` naming an elided node parses fine and
// fails only once the reference is linked, and a `goto` written ahead of a
// statement leaves that statement unreachable. Both are validator findings.
async function parseToAst(source: string) {
  const document = await parse(source, { validation: true });
  const errors = document.parseResult.parserErrors;
  if (errors.length > 0) {
    throw new Error(
      'Parser errors in emitted DSL:\n' +
        errors.map((e) => e.message).join('\n'),
    );
  }
  const problems = (document.diagnostics ?? []).filter(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  if (problems.length > 0) {
    throw new Error(
      'Validation errors in emitted DSL:\n' +
        problems.map((d) => Diagnostic.getMessageString(d)).join('\n'),
    );
  }
  return document.parseResult.value;
}

// Emission only. Re-desugaring belongs in the test that needs it, so a model
// that fails to validate fails a test rather than the whole suite's setup.
async function emit(ir: BpmnProcess) {
  const { ir: imported, warnings } = await xmlToIr(await irToXml(ir));
  return { imported, warnings, dsl: printDsl(imported) };
}

const flow = (id: string, from: string, to: string, condition?: string) => ({
  id,
  sourceRef: from,
  targetRef: to,
  ...(condition !== undefined ? { conditionExpression: condition } : {}),
});

const JOIN_HEADED_LOOP: BpmnProcess = {
  id: 'JoinHeadedLoop',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start_1' },
    { kind: 'exclusiveGateway', id: 'Gateway_H_join' },
    { kind: 'userTask', id: 'T1' },
    { kind: 'exclusiveGateway', id: 'Gateway_X_split' },
    { kind: 'userTask', id: 'T2' },
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
  let imported: BpmnProcess;
  let warnings: Awaited<ReturnType<typeof xmlToIr>>['warnings'];
  let dsl: string;

  beforeAll(async () => {
    ({ imported, warnings, dsl } = await emit(JOIN_HEADED_LOOP));
  });

  it('imports through the XML path with no warnings', () => {
    expect(warnings).toHaveLength(0);
    expect(imported.sequenceFlows).toHaveLength(6);
  });

  it("carries the back-edge as a `goto` naming the join's successor", () => {
    expect(dsl).toContain('goto T1');
    // The join is elided, so it must never be named.
    expect(dsl).not.toContain('goto Gateway_');
    expect(dsl).not.toContain(UNSTRUCTURED_MARKER);
  });

  it('preserves the real-node reachability across the round-trip', async () => {
    // The edge at stake: resolving the jump through the consumed join keeps it.
    const reDesugared = astToIr(await parseToAst(dsl));
    expect(realNodeReachability(reDesugared)).toEqual(
      realNodeReachability(imported),
    );
    expect(realNodeReachability(reDesugared)).toContain('T2->T1');
  });
});

const BACK_EDGE_CONDITION_LOOP: BpmnProcess = {
  id: 'BackEdgeConditionLoop',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start_1' },
    { kind: 'exclusiveGateway', id: 'Gateway_L_loop' },
    { kind: 'userTask', id: 'Body_1' },
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
  let imported: BpmnProcess;
  let warnings: Awaited<ReturnType<typeof xmlToIr>>['warnings'];
  let dsl: string;

  beforeAll(async () => {
    ({ imported, warnings, dsl } = await emit(BACK_EDGE_CONDITION_LOOP));
  });

  it('imports the conditioned back-edge faithfully and without warnings', () => {
    // The loss happens on emission, not on import: the IR still has the edge.
    expect(warnings).toHaveLength(0);
    const backEdge = imported.sequenceFlows.find(
      (f) => f.sourceRef === 'Body_1' && f.targetRef === 'Gateway_L_loop',
    );
    expect(backEdge?.conditionExpression).toBe('${more}');
  });

  it('marks the dropped edge and names the element it led into', () => {
    expect(dsl).toContain(UNSTRUCTURED_MARKER);
    expect(dsl).toContain(
      `${UNSTRUCTURED_MARKER} (dropped edge into Gateway_L_loop)`,
    );
    // Never invent a target: a jump to the loop head would re-run the `done`
    // test, and a jump to the body would skip it.
    expect(dsl).not.toContain('goto');
  });

  it('still emits source that re-parses', async () => {
    // The marker is a comment, so the output stays usable as a starting point.
    await expect(parseToAst(dsl)).resolves.toBeDefined();
  });
});

// The approve-review loop as a modeler draws it: the split inside the body
// carries a condition on both routes and names no default, and so does the
// loop gateway. The route leaving the loop puts the split's immediate
// post-dominator outside it, so the split has no clean join, and with no
// unconditioned route it has no guard clause either.
const REVIEW_LOOP: BpmnProcess = {
  id: 'ReviewLoop',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start_1' },
    { kind: 'userTask', id: 'Approve' },
    { kind: 'exclusiveGateway', id: 'Gateway_approved' },
    { kind: 'userTask', id: 'Review' },
    { kind: 'exclusiveGateway', id: 'Gateway_clarified' },
    { kind: 'userTask', id: 'Pay' },
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
    expect(dsl).not.toContain(UNSTRUCTURED_MARKER);

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
    { kind: 'userTask', id: 'T1' },
    { kind: 'userTask', id: 'Cont' },
    { kind: 'userTask', id: 'Later' },
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
  let dsl: string;

  beforeAll(async () => {
    ({ dsl } = await emit(SURPLUS_EDGE_ON_TASK));
  });

  it('gives both routes a branch rather than a jump beside the fall-through', () => {
    // A bare `goto` beside the fall-through would end the chain and leave
    // everything after it with no incoming flow. Both routes head a branch
    // instead, so the second route keeps its edge and the first keeps its
    // chain. The back edge names `T1` because the join it runs into has one
    // way out, and that is the step it leads to. The step forks in the model
    // and no merge closes it, which the marker names; no edge is dropped.
    expect(dsl).toContain('if (true) {');
    expect(dsl).toContain('goto Cont');
    expect(dsl).toContain('goto T1');
    expect(dsl).toContain(
      `${UNSTRUCTURED_MARKER} (split T1 degraded to jumps; was parallel)`,
    );
    expect(dsl).not.toContain('dropped edge');
  });

  it('keeps the rest of the process reachable and valid', async () => {
    const reach = realNodeReachability(astToIr(await parseToAst(dsl)));
    expect(reach).toContain('T1->Cont');
    expect(reach).toContain('Cont->Later');
    expect(reach).toContain('Later->End_1');
  });
});

describe('a goto never names a node the emitter elides', () => {
  it('marks the edge instead of naming a synthesized terminal', async () => {
    const ir: BpmnProcess = {
      id: 'ElidedTerminal',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'Start_1' },
        { kind: 'userTask', id: 'T1' },
        { kind: 'exclusiveGateway', id: 'Gateway_E_join' },
        { kind: 'endEvent', id: 'EndEvent_ElidedTerminal' },
      ],
      sequenceFlows: [
        flow('f1', 'Start_1', 'T1'),
        flow('f2', 'T1', 'Gateway_E_join'),
        flow('f3', 'Gateway_E_join', 'EndEvent_ElidedTerminal'),
        flow('f4', 'T1', 'Gateway_E_join'),
      ],
    };
    const dsl = printDsl(ir);
    expect(dsl).not.toMatch(/goto EndEvent_/);
    await expect(parseToAst(dsl)).resolves.toBeDefined();
  });

  it('marks the edge instead of naming an awaited catch event', async () => {
    // A timer the flow loops back to. `await` prints only the trigger, so
    // `goto Catch_1` would name something the output never declares.
    const ir: BpmnProcess = {
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
        { kind: 'userTask', id: 'T1' },
      ],
      sequenceFlows: [
        flow('f1', 'Start_1', 'Catch_1'),
        flow('f2', 'Catch_1', 'T1'),
        flow('f3', 'T1', 'Catch_1'),
      ],
    };
    const { ir: imported, warnings } = await xmlToIr(await irToXml(ir));
    expect(warnings).toHaveLength(0);

    const dsl = printDsl(imported);
    expect(dsl).not.toContain('goto Catch_1');
    expect(dsl).toContain(`${UNSTRUCTURED_MARKER} (dropped edge into Catch_1)`);
    await expect(parseToAst(dsl)).resolves.toBeDefined();
  });
});

const task = (id: string) => ({ kind: 'userTask' as const, id });

describe('shapes that structure cleanly stay structured', () => {
  it('nests an `if` inside an `if` branch', () => {
    const ir: BpmnProcess = {
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
    };
    expect(printDsl(ir)).toBe(
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
      ].join('\n'),
    );
  });

  it('emits two sibling `if`s for two independent splits in sequence', () => {
    const ir: BpmnProcess = {
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
    };
    expect(printDsl(ir)).toBe(
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
      ].join('\n'),
    );
  });
});

// Shapes a fuzz run drew, each compiled, exported, imported and printed. A
// row pins the print's whole warning list by category and whether the print
// validates, so a shape that stops being reported, or starts failing, turns
// the row red rather than the next fuzz run.
describe('composite shapes through compile, import and print', () => {
  it.each<
    [title: string, source: string, categories: string[], valid: boolean]
  >([
    [
      'a loop and a throw inside a guarded branch walk inline',
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
      [],
      true,
    ],
    [
      'a pre-test loop whose body ends prints as a guard clause jumping to the body',
      'process p {\n  start S\n  while (true) {\n    user A\n    end X\n  }\n  user B\n  end Done\n}',
      [],
      true,
    ],
    [
      'a fork with an empty weighed branch beside an ending one prints whole',
      'process p {\n  start S\n  parallel {\n    if (true) {\n    }\n    {\n      end X\n    }\n  }\n  end Done\n}',
      [],
      true,
    ],
    [
      'a fork carrying settings with an ending branch prints whole',
      'process p {\n  start S\n  parallel (retryCycle: "R1/PT1M") {\n    {\n      user A\n    }\n    {\n      end X\n    }\n  }\n  end Done\n}',
      [],
      true,
    ],
  ])('%s', async (_title, source, categories, valid) => {
    const { ir: imported, warnings } = await xmlToIr(
      await irToXml(astToIr(await parseToAst(source))),
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

  // `do { end X } while (true)` inside a branch is refused as source, since
  // the loop gateway would have no incoming flow, so the two shapes below
  // skip validation, the way a Modeler file carrying them would import.
  it.each<[string, string]>([
    [
      'a race branch holding a post-test loop whose body ends draws a jump into the branch',
      'process p {\n  start S\n  await {\n    timer("PT1M") {\n    }\n    message("m") {\n      do {\n        end X\n      } while (true)\n    }\n  }\n  end Done\n}',
    ],
    [
      'a fork branch holding a post-test loop whose body ends draws a jump into the branch',
      'process p {\n  start S\n  parallel {\n    {\n      user F\n    }\n    if (true) {\n      do {\n        end S2\n      } while (true)\n    }\n  }\n  end Done\n}',
    ],
  ])('%s', async (_title, source) => {
    const { ir: imported, warnings } = await xmlToIr(
      await irToXml(astToIr(await parseUnvalidated(source))),
    );
    expect(warnings).toEqual([]);
    const printed = irToDsl(imported);

    expect(printed.warnings.map((w) => w.category)).toEqual([
      'refusedStatement',
    ]);
    expect(
      await parseToAst(printed.source).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  // `do { end X } while (true)` compiles a loop gateway with no incoming
  // flow: the body always ends, so `lowerDoWhile` never wires the back edge
  // from the body into the gateway, only the gateway's two outgoing edges.
  // A step after such a loop can no longer be written as source, since the
  // validator now refuses a statement it can prove unreachable, so this
  // shape is built as IR directly, the way a Modeler file would import it.
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

  it('a post-test loop whose body ends prints its unreachable head as a jump', async () => {
    const { ir: imported, warnings } = await xmlToIr(
      await irToXml(DANGLING_LOOP_HEAD),
    );
    expect(warnings).toEqual([]);
    const printed = irToDsl(imported);

    expect(printed.warnings.map((w) => w.category)).toEqual([]);
    expect(
      await parseToAst(printed.source).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});
