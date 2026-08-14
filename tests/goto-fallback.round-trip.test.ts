/**
 * The `goto` fallback, where `irToDsl` sends every edge the structured
 * catalogue could not fold into a construct.
 *
 * A `goto` names a statement. Gateways have no statement form, so an edge
 * arriving at one is expressible only through the gateway's successor, and
 * only while the gateway's routing has a single outcome. Two shapes sit either
 * side of that line, and both are ordinary BPMN rather than hand-built
 * hostility:
 *
 *   - A loop whose head is a pass-through join. The join has one successor, so
 *     the back-edge is expressible — even though the structured walk has
 *     already consumed the join's out-edge by the time the back-edge is
 *     resolved. Consumption records that an edge was printed, not that it
 *     stopped existing.
 *   - A loop whose condition sits on the back-edge instead of on the forward
 *     edge into the body. No loop pattern matches it, so its head gateway is
 *     emitted as an `if`, and the back-edge is left pointing at a gateway that
 *     still chooses between two branches. Nothing names that, so the edge is
 *     dropped and the marker records where.
 *
 * The rest of the file pins the shapes that already structure cleanly, so a
 * change to the fallback cannot quietly turn a `while` into a jump.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { EmptyFileSystem } from 'langium';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import {
  xmlToIr,
  irToDsl,
  astToIr,
  irToXml,
  UNSTRUCTURED_MARKER,
} from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { realNodeReachability } from './helpers/real-node-reachability.js';

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/**
 * Parse emitted DSL and run the validator, failing the test on a parser error
 * or on any diagnostic of severity Error.
 *
 * Validation is the part that matters here. A `goto` naming a node the emitter
 * elides parses without complaint and only fails when the reference is linked,
 * and a `goto` written ahead of a statement leaves that statement unreachable,
 * which is also a validator finding rather than a syntax one. Checking parser
 * errors alone would miss both.
 */
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
        problems.map((d) => d.message).join('\n'),
    );
  }
  return document.parseResult.value;
}

const flow = (id: string, from: string, to: string, condition?: string) => ({
  id,
  sourceRef: from,
  targetRef: to,
  ...(condition !== undefined ? { conditionExpression: condition } : {}),
});

// ===========================================================================
// A loop whose head is a pass-through join gateway.
//
//   Start_1 → Join → T1 → Split      Split -[c]→ T2      Split → End_1
//   T2 → Join                        (the back-edge)
//
// Every node is inside the desugarer's image: the back-edge is unconditioned
// and leaves a task that has exactly one out-edge. The walk consumes
// `Join → T1` on the way in, so by the time it resolves the back-edge the join
// has no unconsumed out-edge left — yet the join still has exactly one
// successor, and `goto T1` carries the edge with nothing lost.
// ===========================================================================

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

  // Only the emission runs here. Re-desugaring belongs inside the test that
  // needs it, so a model that fails to validate reports as a failing test
  // rather than a suite that never ran.
  beforeAll(async () => {
    const xml = await irToXml(JOIN_HEADED_LOOP);
    ({ ir: imported, warnings } = await xmlToIr(xml));
    dsl = irToDsl(imported);
  });

  it('imports through the XML path with no warnings', () => {
    // Nothing about this model is lossy on the way in; the IR is faithful.
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
    // The loop edge T2 → T1 is the one at stake: resolving the jump through
    // the consumed join is what keeps it.
    const reDesugared = astToIr(await parseToAst(dsl));
    expect(realNodeReachability(reDesugared)).toEqual(
      realNodeReachability(imported),
    );
    expect(realNodeReachability(reDesugared)).toContain('T2->T1');
  });
});

// ===========================================================================
// A loop whose condition sits on the back-edge.
//
//   Start_1 → Loop        Loop → Body_1        Loop -[done]→ End_1
//   Body_1 -[more]→ Loop  (the conditioned back-edge)
//
// The desugarer only ever puts a condition on an edge leaving a gateway, so no
// DSL text produces this graph. The back-edge points at a gateway that still
// chooses between `done` and the body, which nothing in the surface names.
//
// An approximation exists — `if (done) { } else { do { user Body_1 } while
// (more) }` invents no terminal and preserves real-node reachability, loop
// edge included — but it moves `done` onto a synthesized gateway, so `done`
// stops being re-tested each iteration and the `more`-false path completes the
// process instead of the token dying. The emitter reports the loss rather than
// ship a model that looks right and runs differently. The contract under test
// is that the drop is visible.
// ===========================================================================

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
    const xml = await irToXml(BACK_EDGE_CONDITION_LOOP);
    ({ ir: imported, warnings } = await xmlToIr(xml));
    dsl = irToDsl(imported);
  });

  it('imports the conditioned back-edge faithfully and without warnings', () => {
    // The loss happens on emission, not on import — the IR still has the edge.
    expect(warnings).toHaveLength(0);
    const backEdge = imported.sequenceFlows.find(
      (f) => f.sourceRef === 'Body_1' && f.targetRef === 'Gateway_L_loop',
    );
    expect(backEdge?.conditionExpression).toBe('${more}');
  });

  it('marks the dropped edge and names the element it led into', () => {
    // Without the name the reader has to search the model for the damage.
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

// ===========================================================================
// A surplus out-edge on a plain node.
//
//   Start_1 → Join → T1     T1 → Cont → Later → End_1     T1 → Join
//
// T1 falls through to Cont and also loops back to the join, whose only
// out-edge the walk consumed on the way in. Only one of those two edges fits:
// a `goto` written beside the fall-through ends the chain when re-desugared
// and strands Cont, Later and End_1. The fall-through wins and the loop edge
// is marked, because losing the tail of the process silently is the worse of
// the two, and the marker is what makes the CLI report anything at all.
// ===========================================================================

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

  // Only the emission runs here. Re-desugaring belongs inside the test that
  // needs it, so a model that fails to validate reports as a failing test
  // rather than a suite that never ran.
  beforeAll(async () => {
    const xml = await irToXml(SURPLUS_EDGE_ON_TASK);
    const { ir: imported } = await xmlToIr(xml);
    dsl = irToDsl(imported);
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
    // parseToAst rejects the unreachable-statement diagnostic that the jump
    // used to cause; the reachability pins the edges that went with it.
    const reach = realNodeReachability(astToIr(await parseToAst(dsl)));
    expect(reach).toContain('T1->Cont');
    expect(reach).toContain('Cont->Later');
    expect(reach).toContain('Later->End_1');
  });
});

// ===========================================================================
// A jump resolving onto a node the emitter drops on print.
//
// Several kinds print a form that does not spell their id: a plain end event
// with a synthesized id prints nothing, and `await <trigger>` has no name slot
// in the grammar. Naming either in a `goto` yields source that parses and then
// fails to link, so the marker is the honest outcome.
// ===========================================================================

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
    // Source that links is the point; parseToAst fails on a broken reference.
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
    // Ordinary BPMN: the import has nothing to complain about.
    expect(warnings).toHaveLength(0);

    const dsl = irToDsl(imported);
    expect(dsl).not.toContain('goto Catch_1');
    expect(dsl).toContain(`${UNSTRUCTURED_MARKER} (dropped edge into Catch_1)`);
    await expect(parseToAst(dsl)).resolves.toBeDefined();
  });
});

// ===========================================================================
// Regression guards: shapes the catalogue already folds into constructs. Each
// must keep emitting exactly what it emits now — no `goto`, no marker.
// ===========================================================================

const task = (id: string) => ({ kind: 'userTask' as const, id });

describe('shapes that structure cleanly stay structured', () => {
  it('emits `while` for an unconditioned back-edge into the loop head', () => {
    const ir: BpmnProcess = {
      id: 'PreTestLoop',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'Start_1' },
        { kind: 'exclusiveGateway', id: 'Gateway_L_loop' },
        task('Body_1'),
        { kind: 'endEvent', id: 'End_1' },
      ],
      sequenceFlows: [
        flow('f1', 'Start_1', 'Gateway_L_loop'),
        flow('f2', 'Gateway_L_loop', 'Body_1', '${more}'),
        flow('f3', 'Gateway_L_loop', 'End_1'),
        flow('f4', 'Body_1', 'Gateway_L_loop'),
      ],
    };
    expect(irToDsl(ir)).toBe(
      [
        'process PreTestLoop {',
        '  start Start_1',
        '  while (more) {',
        '    user Body_1',
        '  }',
        '  end End_1',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('emits `do … while` for a test gateway below the body', () => {
    const ir: BpmnProcess = {
      id: 'PostTestLoop',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'Start_1' },
        task('Body_1'),
        { kind: 'exclusiveGateway', id: 'Gateway_T_loop' },
        { kind: 'endEvent', id: 'End_1' },
      ],
      sequenceFlows: [
        flow('f1', 'Start_1', 'Body_1'),
        flow('f2', 'Body_1', 'Gateway_T_loop'),
        flow('f3', 'Gateway_T_loop', 'Body_1', '${more}'),
        flow('f4', 'Gateway_T_loop', 'End_1'),
      ],
    };
    expect(irToDsl(ir)).toBe(
      [
        'process PostTestLoop {',
        '  start Start_1',
        '  do {',
        '    user Body_1',
        '  } while (more)',
        '  end End_1',
        '}',
        '',
      ].join('\n'),
    );
  });

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
