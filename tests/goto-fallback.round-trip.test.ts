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
  irToDsl,
  astToIr,
  irToXml,
  UNSTRUCTURED_MARKER,
} from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { realNodeReachability } from './helpers/real-node-reachability.js';
import { parse } from './helpers/pipeline.js';

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
  return { imported, warnings, dsl: irToDsl(imported) };
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

  it('emits no jump beside the fall-through', () => {
    // A `goto` here would end the chain and leave everything after it with no
    // incoming flow.
    expect(dsl).not.toContain('goto');
    expect(dsl).toContain(
      `${UNSTRUCTURED_MARKER} (dropped edge into Gateway_H_join)`,
    );
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
    const dsl = irToDsl(ir);
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

    const dsl = irToDsl(imported);
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
    expect(irToDsl(ir)).toBe(
      [
        'process NestedIf {',
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
    expect(irToDsl(ir)).toBe(
      [
        'process SiblingIfs {',
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
