/**
 * Each test parses inline BpmnScript DSL through the real Langium grammar and
 * asserts the flat, BPMN-shaped IR that `astToIr` desugars it to. The expected
 * IR is inline rather than read from fixture files so the desugaring rules are
 * pinned here.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { astToIr } from '../src/ast-to-ir.js';
import {
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayLoopId,
  makeDefaultFlowId,
  makeStartEventId,
  makeEndEventId,
  makeThrowEventId,
  makeEventSubProcessId,
  makeBoundaryEventId,
  makeIntermediateCatchEventId,
} from '../src/synthesize-ids.js';
import type {
  BpmnProcess,
  CallActivity,
  ExclusiveGateway,
  FlowContainer,
  FlowElement,
  ParallelGateway,
  SequenceFlow,
  SubProcess,
  UserTask,
} from '../src/ir/types.js';

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Parse DSL source, assert no parser errors, and desugar to IR. */
async function ir(source: string): Promise<BpmnProcess> {
  const doc = await parse(source);
  expect(doc.parseResult.parserErrors).toHaveLength(0);
  return astToIr(doc.parseResult.value);
}

/**
 * Find the single flow element of a given kind (asserting exactly one). Takes
 * any {@link FlowContainer}, so it serves the root process and a nested
 * sub-process alike.
 */
function only<K extends FlowElement['kind']>(
  container: FlowContainer,
  kind: K,
): Extract<FlowElement, { kind: K }> {
  const matches = container.flowElements.filter((fe) => fe.kind === kind);
  expect(matches).toHaveLength(1);
  return matches[0] as Extract<FlowElement, { kind: K }>;
}

/** Find a flow by `source -> target` (asserting exactly one such pair). */
function flow(
  container: FlowContainer,
  source: string,
  target: string,
): SequenceFlow {
  const matches = container.sequenceFlows.filter(
    (f) => f.sourceRef === source && f.targetRef === target,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

// ── 1. Implicit sequence + implicit start/end ────────────────────────────────

describe('astToIr — implicit sequence and implicit start/end', () => {
  const SOURCE = `process P { user A user B }`;

  it('synthesizes start, A, B, synthesized end with chained flows', async () => {
    const startId = makeStartEventId('P', new Set());
    const endId = makeEndEventId('P', new Set());

    const expected: BpmnProcess = {
      id: 'P',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: startId },
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'endEvent', id: endId },
      ],
      sequenceFlows: [
        { id: 'Flow_A_B', sourceRef: 'A', targetRef: 'B' },
        {
          id: `Flow_${startId}_A`,
          sourceRef: startId,
          targetRef: 'A',
        },
        {
          id: `Flow_B_${endId}`,
          sourceRef: 'B',
          targetRef: endId,
        },
      ],
    };

    const result = await ir(SOURCE);

    // Order-insensitive structural equality: compare as sets keyed by id.
    expect(sortById(result.flowElements)).toEqual(
      sortById(expected.flowElements),
    );
    expect(sortById(result.sequenceFlows)).toEqual(
      sortById(expected.sequenceFlows),
    );
    expect(result.id).toBe('P');
    expect(result.isExecutable).toBe(true);
  });

  it('start → A → B → end is fully connected', async () => {
    const result = await ir(SOURCE);
    const start = only(result, 'startEvent');
    const end = only(result, 'endEvent');

    expect(flow(result, start.id, 'A').sourceRef).toBe(start.id);
    expect(flow(result, 'A', 'B')).toBeDefined();
    expect(flow(result, 'B', end.id)).toBeDefined();
  });

  it('keeps an explicit start/end verbatim and adds no implicit ones', async () => {
    const result = await ir(`process P { start S user A end E }`);

    expect(
      result.flowElements.filter((fe) => fe.kind === 'startEvent'),
    ).toEqual([{ kind: 'startEvent', id: 'S' }]);
    expect(result.flowElements.filter((fe) => fe.kind === 'endEvent')).toEqual([
      { kind: 'endEvent', id: 'E' },
    ]);
    expect(flow(result, 'S', 'A')).toBeDefined();
    expect(flow(result, 'A', 'E')).toBeDefined();
  });

  it('does not synthesize an end after an explicit terminal end', async () => {
    const result = await ir(`process P { user A end Done }`);
    // Only the explicit `Done` end; no synthesized EndEvent_P.
    expect(result.flowElements.filter((fe) => fe.kind === 'endEvent')).toEqual([
      { kind: 'endEvent', id: 'Done' },
    ]);
  });

  it('synthesizes a start/end pair for a handler-only body', async () => {
    const result = await ir(`process p { on error "Boom" { end H } }`);
    const startId = makeStartEventId('p', new Set());
    const endId = makeEndEventId('p', new Set());

    expect(only(result, 'startEvent').id).toBe(startId);
    expect(only(result, 'endEvent').id).toBe(endId);
    expect(flow(result, startId, endId)).toBeDefined();
  });

  it('synthesizes a start/end pair for a bodyless sub-process', async () => {
    const result = await ir(`process p { subprocess S { } }`);
    const sub = subProcess(result, 'S');
    const startId = makeStartEventId('S', new Set());
    const endId = makeEndEventId('S', new Set());

    expect(only(sub, 'startEvent').id).toBe(startId);
    expect(only(sub, 'endEvent').id).toBe(endId);
    expect(flow(sub, startId, endId)).toBeDefined();
  });
});

// ── 2. if / else -> XOR split + join ─────────────────────────────────────────

describe('astToIr — if/else exclusive gateway', () => {
  const SOURCE = `process P {
  if (amount > 1000) { user S } else { service A { class = "com.example.X" } }
}`;

  it('emits a split and a join exclusive gateway', async () => {
    const result = await ir(SOURCE);
    const gateways = result.flowElements.filter(
      (fe): fe is ExclusiveGateway => fe.kind === 'exclusiveGateway',
    );
    expect(gateways.map((g) => g.id).sort()).toEqual(
      [makeGatewaySplitId('P_0'), makeGatewayJoinId('P_0')].sort(),
    );
  });

  it('the if-branch flow carries conditionExpression ${amount > 1000}', async () => {
    const result = await ir(SOURCE);
    const splitId = makeGatewaySplitId('P_0');
    const ifFlow = flow(result, splitId, 'S');
    expect(ifFlow.conditionExpression).toBe('${amount > 1000}');
  });

  it('the else flow carries no condition and is the gateway default', async () => {
    const result = await ir(SOURCE);
    const splitId = makeGatewaySplitId('P_0');
    const split = result.flowElements.find(
      (fe): fe is ExclusiveGateway => fe.id === splitId,
    )!;
    const elseFlow = flow(result, splitId, 'A');

    expect(elseFlow.conditionExpression).toBeUndefined();
    expect(split.defaultFlowId).toBe(elseFlow.id);
    expect(elseFlow.id).toBe(makeDefaultFlowId(splitId));
  });

  it('both branches rejoin at the join gateway', async () => {
    const result = await ir(SOURCE);
    const joinId = makeGatewayJoinId('P_0');
    expect(flow(result, 'S', joinId)).toBeDefined();
    expect(flow(result, 'A', joinId)).toBeDefined();
  });

  it('a branch ending in an explicit end gets no join continuation', async () => {
    const result = await ir(
      `process P { if (x) { user S end Done } else { user A } }`,
    );
    const joinId = makeGatewayJoinId('P_0');
    // The if-branch terminates at `Done`; no flow from Done into the join.
    expect(
      result.sequenceFlows.filter(
        (f) => f.sourceRef === 'Done' && f.targetRef === joinId,
      ),
    ).toEqual([]);
    // The else branch still continues into the join.
    expect(flow(result, 'A', joinId)).toBeDefined();
  });

  it('the default flow never carries a condition (Operaton constraint)', async () => {
    const result = await ir(SOURCE);
    const splitId = makeGatewaySplitId('P_0');
    const gw = result.flowElements.find(
      (fe): fe is ExclusiveGateway => fe.id === splitId,
    )!;
    const defaultFlow = result.sequenceFlows.find(
      (f) => f.id === gw.defaultFlowId,
    )!;
    expect(defaultFlow.conditionExpression).toBeUndefined();
  });

  it('prunes the join when both the if and else branch terminate, and emits no implicit end', async () => {
    const result = await ir(
      `process P { if (c) { throw error B "e" } else { end S } }`,
    );
    const joinId = makeGatewayJoinId('P_0');
    expect(result.flowElements.some((fe) => fe.id === joinId)).toBe(false);
    // Nothing falls through out of the construct, so the container gets no
    // synthesized end either.
    const implicitEndId = makeEndEventId('P', new Set());
    expect(result.flowElements.some((fe) => fe.id === implicitEndId)).toBe(
      false,
    );
  });

  it('keeps the split→join default flow when there is no else (never pruned)', async () => {
    const result = await ir(`process P { if (c) { end A } }`);
    const splitId = makeGatewaySplitId('P_0');
    const joinId = makeGatewayJoinId('P_0');
    expect(result.flowElements.some((fe) => fe.id === joinId)).toBe(true);
    expect(flow(result, splitId, joinId)).toBeDefined();
  });
});

// ── 3. else-if chain -> conditioned split flows + one default ────────────────

describe('astToIr — else-if chain', () => {
  const SOURCE = `process P {
  if (a > 1) { user X }
  else if (a > 2) { user Y }
  else { user Z }
}`;

  it('emits one conditioned flow per if/else-if and one unconditioned default', async () => {
    const result = await ir(SOURCE);
    const splitId = makeGatewaySplitId('P_0');

    const xFlow = flow(result, splitId, 'X');
    const yFlow = flow(result, splitId, 'Y');
    const zFlow = flow(result, splitId, 'Z');

    expect(xFlow.conditionExpression).toBe('${a > 1}');
    expect(yFlow.conditionExpression).toBe('${a > 2}');
    expect(zFlow.conditionExpression).toBeUndefined();

    const split = result.flowElements.find(
      (fe): fe is ExclusiveGateway => fe.id === splitId,
    )!;
    expect(split.defaultFlowId).toBe(zFlow.id);
  });

  it('all three branches converge on the join gateway', async () => {
    const result = await ir(SOURCE);
    const joinId = makeGatewayJoinId('P_0');
    for (const branch of ['X', 'Y', 'Z']) {
      expect(flow(result, branch, joinId)).toBeDefined();
    }
  });
});

// ── 4. while -> pre-test XOR loop + back-edge ────────────────────────────────

describe('astToIr — while loop', () => {
  const SOURCE = `process P { user Pre while (rejected) { user R } user Post }`;

  it('emits a loop XOR gateway with conditioned body entry and default exit', async () => {
    const result = await ir(SOURCE);
    const loopId = makeGatewayLoopId('P_1');
    const loop = result.flowElements.find(
      (fe): fe is ExclusiveGateway => fe.id === loopId,
    );
    expect(loop?.kind).toBe('exclusiveGateway');

    const entryFlow = flow(result, loopId, 'R');
    expect(entryFlow.conditionExpression).toBe('${rejected}');

    const exitFlow = flow(result, loopId, 'Post');
    expect(exitFlow.conditionExpression).toBeUndefined();
    expect(loop!.defaultFlowId).toBe(exitFlow.id);
    expect(exitFlow.id).toBe(makeDefaultFlowId(loopId));
  });

  it('emits a back-edge from the body exit to the loop gateway', async () => {
    const result = await ir(SOURCE);
    const loopId = makeGatewayLoopId('P_1');
    const backEdge = flow(result, 'R', loopId);
    expect(backEdge.conditionExpression).toBeUndefined();
  });

  it('routes the entry into the loop head', async () => {
    const result = await ir(SOURCE);
    const loopId = makeGatewayLoopId('P_1');
    expect(flow(result, 'Pre', loopId)).toBeDefined();
  });

  it('emits NO standardLoopCharacteristics (loops are gateway + back-edge only)', async () => {
    const result = await ir(SOURCE);
    // No IR flow element ever carries any loop-characteristics field.
    for (const fe of result.flowElements) {
      expect(fe).not.toHaveProperty('loopCharacteristics');
      expect(fe).not.toHaveProperty('standardLoopCharacteristics');
    }
    // The serialized IR contains no such string anywhere.
    expect(JSON.stringify(result)).not.toMatch(/loopCharacteristics/i);
  });

  it('a body that always throws stays valid: the loop gateway keeps one incoming and two outgoing', async () => {
    const result = await ir(
      `process P { while (c) { throw error B "e" } end Done }`,
    );
    const loopId = makeGatewayLoopId('P_0');
    const incoming = result.sequenceFlows.filter((f) => f.targetRef === loopId);
    const outgoing = result.sequenceFlows.filter((f) => f.sourceRef === loopId);
    // Only the entry from start: the body throws, so there is no back-edge.
    expect(incoming).toHaveLength(1);
    // The conditioned entry into the body and the unconditioned exit.
    expect(outgoing).toHaveLength(2);
    expect(flow(result, loopId, 'Done')).toBeDefined();
  });
});

// ── 5. do ... while -> post-test XOR loop ────────────────────────────────────

describe('astToIr — do-while loop', () => {
  const SOURCE = `process P { do { user R } while (rejected) }`;

  it('runs the body first, then a conditioned back-edge and default exit', async () => {
    const result = await ir(SOURCE);
    const loopId = makeGatewayLoopId('P_0');
    const startId = makeStartEventId('P', new Set());
    const endId = makeEndEventId('P', new Set());

    // Start flows into the body entry, not the loop gateway (post-test).
    expect(flow(result, startId, 'R')).toBeDefined();
    // Body exit reaches the loop gateway.
    expect(flow(result, 'R', loopId)).toBeDefined();
    // Conditioned back-edge from the loop gateway into the body entry.
    const backEdge = flow(result, loopId, 'R');
    expect(backEdge.conditionExpression).toBe('${rejected}');
    // Unconditioned default exit out of the loop to the synthesized end.
    const exitFlow = flow(result, loopId, endId);
    expect(exitFlow.conditionExpression).toBeUndefined();
    const loop = result.flowElements.find(
      (fe): fe is ExclusiveGateway => fe.id === loopId,
    )!;
    expect(loop.defaultFlowId).toBe(exitFlow.id);
  });

  it('emits no loop characteristics', async () => {
    const result = await ir(SOURCE);
    expect(JSON.stringify(result)).not.toMatch(/loopCharacteristics/i);
  });
});

// ── 6. parallel -> fork/join parallelGateway pair ────────────────────────────

describe('astToIr — parallel fork/join', () => {
  const SOURCE = `process P { parallel { { user A } { user B } } }`;

  it('emits a fork and a join parallelGateway with unconditioned flows', async () => {
    const result = await ir(SOURCE);
    const forkId = makeGatewayForkId('P_0');
    const joinId = makeGatewayJoinId('P_0');

    const gateways = result.flowElements.filter(
      (fe): fe is ParallelGateway => fe.kind === 'parallelGateway',
    );
    expect(gateways.map((g) => g.id).sort()).toEqual([forkId, joinId].sort());

    for (const branch of ['A', 'B']) {
      const inFlow = flow(result, forkId, branch);
      const outFlow = flow(result, branch, joinId);
      expect(inFlow.conditionExpression).toBeUndefined();
      expect(outFlow.conditionExpression).toBeUndefined();
    }
  });

  it('parallel gateways never carry a defaultFlowId', async () => {
    const result = await ir(SOURCE);
    for (const fe of result.flowElements) {
      if (fe.kind === 'parallelGateway') {
        expect(fe).not.toHaveProperty('defaultFlowId');
      }
    }
  });

  it('prunes the join when every branch terminates', async () => {
    const result = await ir(
      `process P { parallel { { throw error B "e" } { end S } } }`,
    );
    const joinId = makeGatewayJoinId('P_0');
    expect(result.flowElements.some((fe) => fe.id === joinId)).toBe(false);
  });
});

// ── 7. goto -> raw sequence flow to the target node ──────────────────────────

describe('astToIr — goto', () => {
  it('emits a sequence flow to the node named Foo', async () => {
    const result = await ir(`process P { user A goto Foo user Foo end Done }`);
    // The implicit flow out of A lands on the goto target Foo.
    const gotoFlow = flow(result, 'A', 'Foo');
    expect(gotoFlow.targetRef).toBe('Foo');
    // No synthesized node is created for the goto itself.
    expect(result.flowElements.map((fe) => fe.id)).not.toContain('goto');
  });

  it('suppresses implicit fall-through after a goto', async () => {
    // After `goto Foo` control transfers, so no implicit end follows the goto.
    const result = await ir(`process P { user A goto A }`);
    // The only flows are start->A and the back-jump A->A.
    const selfJump = flow(result, 'A', 'A');
    expect(selfJump).toBeDefined();
    // No synthesized end (control never falls off the end).
    expect(result.flowElements.filter((fe) => fe.kind === 'endEvent')).toEqual(
      [],
    );
  });

  it('a goto into a compound block resolves to the compound body entry', async () => {
    // In the grammar only leaf statements expose `name=ID`, so a compound
    // statement's synthesized split-gateway id is not a nameable goto target.
    // A goto naming the first statement inside a compound block lands on that
    // statement, which is the entry node of the compound body.
    const result = await ir(
      `process P { user A goto Inner if (x) { user Inner } }`,
    );

    // The goto out of A lands directly on the compound's body entry `Inner`.
    expect(flow(result, 'A', 'Inner').targetRef).toBe('Inner');

    // The split gateway still routes the if's true branch to `Inner` via its
    // synthesized entry; the goto bypasses the gateway entirely (raw jump).
    const splitId = makeGatewaySplitId('P_2');
    expect(result.flowElements.map((fe) => fe.id)).toContain(splitId);
    expect(flow(result, splitId, 'Inner')).toBeDefined();
  });
});

// ── 8. Synthesized-id determinism guard ──────────────────────────────────────

describe('astToIr — synthesized id determinism', () => {
  it('if split/join ids match the id templates for the structural coord', async () => {
    const result = await ir(`process P { if (x) { user A } }`);
    const ids = result.flowElements.map((fe) => fe.id);
    expect(ids).toContain(makeGatewaySplitId('P_0'));
    expect(ids).toContain(makeGatewayJoinId('P_0'));
  });

  it('nested compound coordinates nest by structural index', async () => {
    // An `if` at body index 0 whose `then` block holds a `while` at index 0.
    const result = await ir(`process P { if (x) { while (y) { user A } } }`);
    const ids = result.flowElements.map((fe) => fe.id);
    expect(ids).toContain(makeGatewaySplitId('P_0'));
    // The while's coordinate is the if's coord (`P_0`) plus the `then` branch's
    // discriminating segment (`_t`) plus its own index (`_0`).
    expect(ids).toContain(makeGatewayLoopId('P_0_t_0'));
  });

  it('two re-parses of the same source produce byte-identical IR (determinism)', async () => {
    const source = `process P {
      user Pre
      if (amount > 1000) { user S } else { service A { class = "com.example.X" } }
      parallel { { user L } { user R } }
    }`;
    const a = await ir(source);
    const b = await ir(source);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('synthesized ids never collide with author-chosen statement names', async () => {
    // A user task literally named like a synthesized end forces a `_2` suffix.
    const result = await ir(`process P { user EndEvent_P }`);
    const ends = result.flowElements.filter((fe) => fe.kind === 'endEvent');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.id).toBe('EndEvent_P_2');
  });
});

// ── 9. Attribute mapping ─────────────────────────────────────────────────────

describe('astToIr — attribute mapping', () => {
  it('maps user assignee/formKey and service class to IR fields', async () => {
    const result = await ir(`process P {
      user T "Task" { assignee = "demo" formKey = "embedded:form" }
      service S "Svc" { class = "com.example.Delegate" }
    }`);

    const task = result.flowElements.find(
      (fe): fe is UserTask => fe.kind === 'userTask',
    )!;
    expect(task).toEqual({
      kind: 'userTask',
      id: 'T',
      name: 'Task',
      assignee: 'demo',
      formKey: 'embedded:form',
    });

    const svc = result.flowElements.find((fe) => fe.kind === 'serviceTask')!;
    expect(svc).toEqual({
      kind: 'serviceTask',
      id: 'S',
      name: 'Svc',
      binding: { kind: 'class', className: 'com.example.Delegate' },
    });
  });

  it('omits absent optional attributes (no assignee/formKey/name)', async () => {
    const result = await ir(`process P { user T }`);
    const task = result.flowElements.find(
      (fe): fe is UserTask => fe.kind === 'userTask',
    )!;
    expect(task.assignee).toBeUndefined();
    expect(task.formKey).toBeUndefined();
    expect(task.name).toBeUndefined();
  });

  it('carries the inline process label to the IR name', async () => {
    const result = await ir(`process P "My Process" { user A }`);
    expect(result.name).toBe('My Process');
  });

  it('carries a header label = "…" declaration to the IR name', async () => {
    const result = await ir(`process P { label = "Header Label" user A }`);
    expect(result.name).toBe('Header Label');
  });

  it('omits name when the process has no label', async () => {
    const result = await ir(`process P { user A }`);
    expect(result.name).toBeUndefined();
  });

  it('accepts a dotted bareword class value as a plain className binding', async () => {
    const result = await ir(
      `process P { service S { class = com.example.X } }`,
    );
    const svc = result.flowElements.find((fe) => fe.kind === 'serviceTask')!;
    expect((svc as { binding: { className: string } }).binding.className).toBe(
      'com.example.X',
    );
  });
});

// ── 9b. Service task binding variants (expression / delegate) ───────────────

describe('astToIr — service task binding variants', () => {
  it('maps `expression = "${…}"` to binding {kind:"expression"}, the raw ${…} carried verbatim', async () => {
    const result = await ir(
      'process P { service S { expression = "${bean.method(execution)}" } }',
    );
    const svc = result.flowElements.find((fe) => fe.kind === 'serviceTask')!;
    expect((svc as { binding: unknown }).binding).toEqual({
      kind: 'expression',
      expression: '${bean.method(execution)}',
    });
  });

  it('maps `delegate = "${…}"` to binding {kind:"delegateExpression"} (friendly alias)', async () => {
    const result = await ir(
      'process P { service S { delegate = "${beanName}" } }',
    );
    const svc = result.flowElements.find((fe) => fe.kind === 'serviceTask')!;
    expect((svc as { binding: unknown }).binding).toEqual({
      kind: 'delegateExpression',
      expression: '${beanName}',
    });
  });

  it('wraps a bareword `delegate = chargeService` (no quotes) in ${…} rather than stripping it', async () => {
    const result = await ir(
      'process P { service S { delegate = chargeService } }',
    );
    const svc = result.flowElements.find((fe) => fe.kind === 'serviceTask')!;
    expect((svc as { binding: unknown }).binding).toEqual({
      kind: 'delegateExpression',
      expression: '${chargeService}',
    });
  });

  it('wraps a dotted-VarRef `expression = svc.status` (no quotes) in ${…} rather than stripping it', async () => {
    // Unlike `class`, whose dotted-bareword value is a plain Java path and gets
    // the ${...} wrapper stripped, `expression`/`delegate` must keep the wrapper
    // so Operaton evaluates the value as EL, not a literal string.
    const result = await ir(
      'process P { service S { expression = svc.status } }',
    );
    const svc = result.flowElements.find((fe) => fe.kind === 'serviceTask')!;
    expect((svc as { binding: unknown }).binding).toEqual({
      kind: 'expression',
      expression: '${svc.status}',
    });
  });
});

// ── 9c. Service task's `topic` binding (the external-worker form) ───────────

describe('astToIr — service task topic binding', () => {
  it('maps `service ship { topic = "shipping" }` to a serviceTask with binding {kind:"external"}', async () => {
    const result = await ir(
      'process P { service ship { topic = "shipping" } }',
    );
    const svc = result.flowElements.find((fe) => fe.kind === 'serviceTask')!;
    expect(svc).toEqual({
      kind: 'serviceTask',
      id: 'ship',
      binding: { kind: 'external', topic: 'shipping' },
    });
  });
});

// ── 9d. Script task (fenced body -> format + code) ───────────────────────────

describe('astToIr — script task', () => {
  it('maps a fenced ```js``` script to scriptTask{format:"javascript", code:<inner body>}', async () => {
    const result = await ir(
      'process P { script total ```js\ntotal = amount * 1.1;\n``` }',
    );
    const script = result.flowElements.find((fe) => fe.kind === 'scriptTask')!;
    expect(script).toEqual({
      kind: 'scriptTask',
      id: 'total',
      format: 'javascript',
      code: 'total = amount * 1.1;\n',
    });
  });

  it('drops a trailing \\r from a \\r\\n-terminated opening fence line', async () => {
    const result = await ir(
      'process P { script total ```js\r\ntotal = amount * 1.1;\n``` }',
    );
    const script = result.flowElements.find((fe) => fe.kind === 'scriptTask')!;
    expect(script).toEqual({
      kind: 'scriptTask',
      id: 'total',
      format: 'javascript',
      code: 'total = amount * 1.1;\n',
    });
  });
});

// ── 9e. goto reserves + resolves a topic-bound service/script name ──────────

describe('astToIr — topic-bound service/script names are goto-targetable', () => {
  it('a topic-bound service task name reserves the collision seed and resolves a goto to it', async () => {
    const result = await ir(
      'process P { user A goto Ship service Ship { topic = "shipping" } }',
    );
    expect(flow(result, 'A', 'Ship').targetRef).toBe('Ship');

    // A service task named like a synthesized end forces that end to `_2`,
    // which only happens if `collectNamedIds` registered the name up front.
    const collision = await ir(
      'process P { service EndEvent_P { topic = "t" } }',
    );
    const ends = collision.flowElements.filter((fe) => fe.kind === 'endEvent');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.id).toBe('EndEvent_P_2');
  });

  it('a script task name reserves the collision seed and resolves a goto to it', async () => {
    const result = await ir(
      'process P { user A goto Calc script Calc ```js\nx = 1;\n``` }',
    );
    expect(flow(result, 'A', 'Calc').targetRef).toBe('Calc');

    const collision = await ir(
      'process P { script EndEvent_P ```js\nx = 1;\n``` }',
    );
    const ends = collision.flowElements.filter((fe) => fe.kind === 'endEvent');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.id).toBe('EndEvent_P_2');
  });
});

// ── 10. Empty model throws ───────────────────────────────────────────────────

describe('astToIr — empty model error', () => {
  it('throws when the model contains no process definitions', async () => {
    const doc = await parse('');
    expect(() => astToIr(doc.parseResult.value)).toThrow(
      /no process definitions/i,
    );
  });
});

// ── 11. Sibling-branch coordinate collision (regression) ─────────────────────

describe('astToIr — sibling-branch coordinate uniqueness', () => {
  it('nested compounds in `then` vs `else` get distinct gateway ids', async () => {
    // A nested compound at index 0 of `then` and one at index 0 of `else` must
    // not collide: each branch contributes its own coordinate segment.
    const result = await ir(
      `process P { if (a) { if (b) { user X } } else { if (c) { user Y } } }`,
    );

    const elementIds = allElementIds(result);
    // 10 elements: start, end, outer split/join, then-inner split/join,
    //              else-inner split/join, user X, user Y.
    expect(elementIds).toHaveLength(10);
    expect(new Set(elementIds).size).toBe(elementIds.length);

    // The branch-discriminating segments produce distinct coords:
    // `then` -> `P_0_t_0`, `else` -> `P_0_e_0`.
    const gatewayIds = result.flowElements
      .filter((fe) => fe.kind === 'exclusiveGateway')
      .map((fe) => fe.id);
    expect(gatewayIds).toContain(makeGatewaySplitId('P_0_t_0'));
    expect(gatewayIds).toContain(makeGatewaySplitId('P_0_e_0'));
  });

  it('nested compounds across all if-branch kinds (then/else-if/else) are unique', async () => {
    const result = await ir(
      `process P {
        if (a) { if (b) { user X } }
        else if (c) { if (d) { user Y } }
        else { if (e) { user Z } }
      }`,
    );
    const elementIds = allElementIds(result);
    expect(new Set(elementIds).size).toBe(elementIds.length);

    const gatewayIds = result.flowElements
      .filter((fe) => fe.kind === 'exclusiveGateway')
      .map((fe) => fe.id);
    // then -> `_t`, first else-if -> `_e0`, else -> `_e`.
    expect(gatewayIds).toContain(makeGatewaySplitId('P_0_t_0'));
    expect(gatewayIds).toContain(makeGatewaySplitId('P_0_e0_0'));
    expect(gatewayIds).toContain(makeGatewaySplitId('P_0_e_0'));
  });

  it('nested compounds inside while vs do-while loop bodies are unique', async () => {
    // Same collision class for loop bodies: two sibling loops each holding a
    // nested compound at index 0 of their body must not collide.
    const result = await ir(
      `process P {
        while (a) { if (b) { user X } }
        do { if (c) { user Y } } while (d)
      }`,
    );
    const elementIds = allElementIds(result);
    expect(new Set(elementIds).size).toBe(elementIds.length);
  });
});

// ── 12. All-element-ids-unique invariant across every desugar fixture ────────

describe('astToIr — all synthesized ids are globally unique (property check)', () => {
  // Every representative desugaring shape from the suite above. If any pair of
  // synthesized gateway/event ids collides, the resulting IR is malformed.
  const FIXTURES: { name: string; source: string }[] = [
    { name: 'implicit sequence', source: `process P { user A user B }` },
    {
      name: 'explicit start/end',
      source: `process P { start S user A end E }`,
    },
    {
      name: 'if/else',
      source: `process P { if (x) { user S } else { service A { class = "c" } } }`,
    },
    {
      name: 'else-if chain',
      source: `process P { if (a) { user X } else if (b) { user Y } else { user Z } }`,
    },
    {
      name: 'while',
      source: `process P { user Pre while (r) { user R } user Post }`,
    },
    { name: 'do-while', source: `process P { do { user R } while (r) }` },
    {
      name: 'parallel',
      source: `process P { parallel { { user A } { user B } } }`,
    },
    {
      name: 'nested if in if-then',
      source: `process P { if (x) { if (y) { user A } } }`,
    },
    {
      name: 'nested if in then vs else',
      source: `process P { if (a) { if (b) { user X } } else { if (c) { user Y } } }`,
    },
    {
      name: 'nested compound in parallel branches',
      source: `process P { parallel { { if (a) { user X } } { if (b) { user Y } } } }`,
    },
    {
      name: 'nested compounds in two sibling parallel branches and loops',
      source: `process P {
        while (a) { if (b) { user X } }
        do { if (c) { user Y } } while (d)
        parallel { { while (e) { user Z } } { while (f) { user W } } }
      }`,
    },
  ];

  for (const { name, source } of FIXTURES) {
    it(`${name}: every element id is unique`, async () => {
      const result = await ir(source);
      const ids = allElementIds(result);
      const seen = new Map<string, number>();
      for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
      const dups = [...seen.entries()]
        .filter(([, n]) => n > 1)
        .map(([id]) => id);
      expect(dups).toEqual([]);
    });
  }
});

// ── 13. Sub-process lowering (nested builder) ────────────────────────────────

describe('astToIr — sub-process lowering', () => {
  it('lowers a sub-process into its own container with implicit start/end', async () => {
    const result = await ir(
      `process p { subprocess S { user A { assignee = "x" } } }`,
    );

    expect(result.flowElements.map((fe) => fe.id)).toEqual([
      'StartEvent_p',
      'S',
      'EndEvent_p',
    ]);
    expect(flow(result, 'StartEvent_p', 'S')).toBeDefined();
    expect(flow(result, 'S', 'EndEvent_p')).toBeDefined();

    const sub = subProcess(result, 'S');
    expect(sub.kind).toBe('subProcess');
    expect(sub.flowElements.map((fe) => fe.id)).toEqual([
      'StartEvent_S',
      'A',
      'EndEvent_S',
    ]);
    expect(flow(sub, 'StartEvent_S', 'A')).toBeDefined();
    expect(flow(sub, 'A', 'EndEvent_S')).toBeDefined();

    const parentIds = result.flowElements.map((fe) => fe.id);
    for (const nested of ['StartEvent_S', 'A', 'EndEvent_S']) {
      expect(parentIds).not.toContain(nested);
    }
    for (const f of result.sequenceFlows) {
      expect(['StartEvent_S', 'A', 'EndEvent_S']).not.toContain(f.sourceRef);
      expect(['StartEvent_S', 'A', 'EndEvent_S']).not.toContain(f.targetRef);
    }
  });

  it('honours explicit start/end inside the body (no synthesized events)', async () => {
    const result = await ir(
      `process p { subprocess S { start In user A { assignee = "x" } end Out } }`,
    );
    const sub = subProcess(result, 'S');
    expect(sub.flowElements.map((fe) => fe.id)).toEqual(['In', 'A', 'Out']);
    const ids = sub.flowElements.map((fe) => fe.id);
    expect(ids).not.toContain('StartEvent_S');
    expect(ids).not.toContain('EndEvent_S');
    expect(flow(sub, 'In', 'A')).toBeDefined();
    expect(flow(sub, 'A', 'Out')).toBeDefined();
    expect(flow(result, 'StartEvent_p', 'S')).toBeDefined();
    expect(flow(result, 'S', 'EndEvent_p')).toBeDefined();
  });

  it('roots the body coordinate at the sub-process own structural coordinate', async () => {
    const result = await ir(
      `process p {
        user Pre { assignee = "x" }
        subprocess S { if (c) { user A { assignee = "y" } } }
      }`,
    );
    const sub = subProcess(result, 'S');
    const gatewayIds = sub.flowElements
      .filter((fe) => fe.kind === 'exclusiveGateway')
      .map((fe) => fe.id);
    // Positional coordinate `p_1` roots the body; the nested `if` is `p_1_0`.
    expect(gatewayIds).toContain(makeGatewaySplitId('p_1_0'));
    expect(gatewayIds).toContain(makeGatewayJoinId('p_1_0'));
  });

  it('composes coordinates through if-branch segments and nested sub-processes', async () => {
    // A sub-process at index 0 of the `then` block of an `if` at process index 2
    // has coordinate `p_2_t_0`; a compound in its body is `p_2_t_0_0`.
    const inThen = await ir(
      `process p {
        user A { assignee = "x" }
        user B { assignee = "x" }
        if (c) { subprocess S { if (d) { user X { assignee = "x" } } } }
      }`,
    );
    const sInThen = subProcess(inThen, 'S');
    expect(
      sInThen.flowElements
        .filter((fe) => fe.kind === 'exclusiveGateway')
        .map((fe) => fe.id),
    ).toContain(makeGatewaySplitId('p_2_t_0_0'));

    // A sub-process nested in a sub-process composes coordinates: outer `p_1`,
    // inner `p_1_0`; a compound in the inner body is `p_1_0_0`.
    const nested = await ir(
      `process p {
        user A { assignee = "x" }
        subprocess Outer { subprocess Inner { if (d) { user X { assignee = "x" } } } }
      }`,
    );
    const inner = subProcess(subProcess(nested, 'Outer'), 'Inner');
    expect(
      inner.flowElements
        .filter((fe) => fe.kind === 'exclusiveGateway')
        .map((fe) => fe.id),
    ).toContain(makeGatewaySplitId('p_1_0_0'));
  });

  it('maps an inline label to the container name', async () => {
    const result = await ir(`process p { subprocess S "Handle" { } }`);
    const sub = subProcess(result, 'S');
    expect(sub.name).toBe('Handle');
    // An empty body still needs a valid start event, so it gets the bare
    // start/end pair.
    expect(sub.flowElements.map((fe) => fe.id)).toEqual([
      'StartEvent_S',
      'EndEvent_S',
    ]);
    expect(flow(sub, 'StartEvent_S', 'EndEvent_S')).toBeDefined();
  });

  it('threads the parent chain into and out of the sub-process, goto-targetable', async () => {
    const result = await ir(
      `process p {
        start Begin
        user Before { assignee = "x" }
        subprocess S { user A { assignee = "x" } }
        user After { assignee = "x" }
        goto S
      }`,
    );
    expect(flow(result, 'Begin', 'Before')).toBeDefined();
    expect(flow(result, 'Before', 'S')).toBeDefined();
    expect(flow(result, 'S', 'After')).toBeDefined();
    // A `goto S` in the parent lands on the sub-process: its entry is its id.
    expect(flow(result, 'After', 'S')).toBeDefined();
  });

  it('collision-resolves name-seeded implicit ids against the process-wide taken set', async () => {
    // An explicit parent step already occupies `EndEvent_S`, so the
    // sub-process's implicit end falls back to `EndEvent_S_2`.
    const result = await ir(
      `process p {
        user EndEvent_S { assignee = "x" }
        subprocess S { user A { assignee = "x" } }
      }`,
    );
    expect(result.flowElements.map((fe) => fe.id)).toContain('EndEvent_S');
    const sub = subProcess(result, 'S');
    const ids = sub.flowElements.map((fe) => fe.id);
    expect(ids).toContain('StartEvent_S');
    expect(ids).toContain('EndEvent_S_2');
    expect(ids).not.toContain('EndEvent_S');

    const all = allElementIdsDeep(result);
    expect(new Set(all).size).toBe(all.length);
  });
});

// ── 14. Call activity lowering ───────────────────────────────────────────────

describe('astToIr — call activity lowering', () => {
  it('lowers a minimal call into the parent chain with no optional fields', async () => {
    const result = await ir(`process p { call F { process = "fulfilment" } }`);

    const startId = makeStartEventId('p', new Set());
    const endId = makeEndEventId('p', new Set());
    expect(flow(result, startId, 'F')).toBeDefined();
    expect(flow(result, 'F', endId)).toBeDefined();

    const call = only(result, 'callActivity');
    expect(call).toEqual({
      kind: 'callActivity',
      id: 'F',
      calledElement: 'fulfilment',
    });
  });

  it('lowers a full-featured call to the exact expected IR literal', async () => {
    const result = await ir(`process p {
      var amount: number
      var tax: number
      var vipFlag: boolean
      var confirmed: boolean
      call Fulfilment "Fulfil order" {
        process = "fulfilment-process"
        binding = deployment
        businessKey = "\${execution.processBusinessKey}"
        in *
        in orderId
        in total = amount + tax
        in local vip = vipFlag
        out shipmentId
        out shipped = confirmed
      }
    }`);

    const call = only(result, 'callActivity');
    const expected: CallActivity = {
      kind: 'callActivity',
      id: 'Fulfilment',
      name: 'Fulfil order',
      calledElement: 'fulfilment-process',
      binding: { kind: 'deployment' },
      businessKey: '${execution.processBusinessKey}',
      inMappings: [
        { kind: 'all' },
        { kind: 'variable', source: 'orderId', target: 'orderId' },
        {
          kind: 'expression',
          sourceExpression: '${amount + tax}',
          target: 'total',
        },
        { kind: 'variable', source: 'vipFlag', target: 'vip', local: true },
      ],
      outMappings: [
        { kind: 'variable', source: 'shipmentId', target: 'shipmentId' },
        { kind: 'variable', source: 'confirmed', target: 'shipped' },
      ],
    };
    expect(call).toEqual(expected);
  });

  it('lowers a dotted mapping source to the expression variant, not variable', async () => {
    const result = await ir(
      `process p { call X { process = "p" in doubled = order.total } }`,
    );
    // A VarRef carrying accessors is not a bare single-segment reference, so it
    // renders through renderExpression into the expression variant rather than
    // a plain variable copy.
    expect(only(result, 'callActivity').inMappings).toEqual([
      {
        kind: 'expression',
        sourceExpression: '${order.total}',
        target: 'doubled',
      },
    ]);
  });

  it('reads a pinned version from an int, a raw expression, and a bare latest binding', async () => {
    const intVersion = await ir(
      `process p { call X { process = "p" version = 3 } }`,
    );
    expect(only(intVersion, 'callActivity').binding).toEqual({
      kind: 'version',
      version: '3',
    });

    const rawVersion = await ir(
      'process p { call X { process = "p" version = "${v}" } }',
    );
    expect(only(rawVersion, 'callActivity').binding).toEqual({
      kind: 'version',
      version: '${v}',
    });

    const latest = await ir(
      `process p { call X { process = "p" binding = latest } }`,
    );
    expect(only(latest, 'callActivity').binding).toEqual({ kind: 'latest' });

    const none = await ir(`process p { call X { process = "p" } }`);
    expect(only(none, 'callActivity').binding).toBeUndefined();
  });

  it('reads a version from a quoted string literal and from a decimal', async () => {
    const stringVersion = await ir(
      'process p { call X { process = "p" version = "1.0-GA" } }',
    );
    expect(only(stringVersion, 'callActivity').binding).toEqual({
      kind: 'version',
      version: '1.0-GA',
    });

    const decimalVersion = await ir(
      `process p { call X { process = "p" version = 1.5 } }`,
    );
    expect(only(decimalVersion, 'callActivity').binding).toEqual({
      kind: 'version',
      version: '1.5',
    });
  });

  it('stays total: never throws on an incomplete or contradictory call body', async () => {
    const empty = await ir(`process p { call X { } }`);
    expect(only(empty, 'callActivity').calledElement).toBe('');

    // A `binding` value that is neither `latest` nor `deployment` is not a
    // resolvable strategy, so the desugarer leaves the binding absent and the
    // validator reports the bad value.
    const unknownBinding = await ir(
      `process p { call X { process = "p" binding = weekly } }`,
    );
    expect(only(unknownBinding, 'callActivity').binding).toBeUndefined();

    // With both `binding` and `version` present the derivation checks `version`
    // first, so it wins and the validator flags the contradiction.
    const bothPresent = await ir(
      `process p { call X { process = "p" binding = deployment version = 2 } }`,
    );
    expect(only(bothPresent, 'callActivity').binding).toEqual({
      kind: 'version',
      version: '2',
    });
  });

  it('maps the label to name and resolves a goto elsewhere to the call node', async () => {
    const result = await ir(
      `process p { user A goto F call F "Fulfil order" { process = "p" } }`,
    );
    const call = only(result, 'callActivity');
    expect(call.name).toBe('Fulfil order');
    expect(flow(result, 'A', 'F').targetRef).toBe('F');
  });

  it('reserves a call name as a collision seed for synthesized ids', async () => {
    // A call named like a synthesized end forces that end to `_2`, which only
    // happens if `collectNamedIds` registered the call's name up front.
    const collision = await ir(
      'process P { call EndEvent_P { process = "p" } }',
    );
    const ends = collision.flowElements.filter((fe) => fe.kind === 'endEvent');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.id).toBe('EndEvent_P_2');
  });

  it('lowers a call inside a subprocess body into the nested container', async () => {
    const result = await ir(
      `process p { subprocess S { call C { process = "p" } } }`,
    );
    const sub = subProcess(result, 'S');
    expect(only(sub, 'callActivity').id).toBe('C');
    expect(result.flowElements.map((fe) => fe.id)).not.toContain('C');
    expect(
      result.sequenceFlows.some(
        (f) => f.sourceRef === 'C' || f.targetRef === 'C',
      ),
    ).toBe(false);
    expect(flow(sub, 'StartEvent_S', 'C')).toBeDefined();
    expect(flow(sub, 'C', 'EndEvent_S')).toBeDefined();
  });
});

// ── 15. Event handlers (`on`): out-of-chain event sub-processes ──────────────

describe('astToIr — on-handler lowering', () => {
  it('lowers a handler outside the sequence chain (flows go around it)', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on error "PF" { service R { class = "x.R" } }
      }`,
    );

    expect(flow(result, 'StartEvent_p', 'A')).toBeDefined();
    expect(flow(result, 'A', 'EndEvent_p')).toBeDefined();
    const handlerId = makeEventSubProcessId('p_1');
    for (const f of result.sequenceFlows) {
      expect(f.sourceRef).not.toBe(handlerId);
      expect(f.targetRef).not.toBe(handlerId);
    }

    const handler = subProcess(result, handlerId);
    expect(handler.triggeredByEvent).toBe(true);

    const startId = makeStartEventId(handlerId, new Set());
    const endId = makeEndEventId(handlerId, new Set());
    expect(handler.flowElements.map((fe) => fe.id)).toEqual([
      startId,
      'R',
      endId,
    ]);
    expect(flow(handler, startId, 'R')).toBeDefined();
    expect(flow(handler, 'R', endId)).toBeDefined();

    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({ kind: 'error', errorCode: 'PF' });
    expect(start.isInterrupting).toBeUndefined();
  });

  it('maps escalation bindings and alongside onto the start event', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on escalation "LS" (code v) alongside { service R { class = "x.R" } }
      }`,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_1'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'escalation',
      escalationCode: 'LS',
      codeVariable: 'v',
    });
    expect(start.isInterrupting).toBe(false);
  });

  it('maps both error bindings (code + message)', async () => {
    const result = await ir(
      `process p {
        on error "PF" (code c, message m) { service R { class = "x.R" } }
      }`,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_0'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'error',
      errorCode: 'PF',
      codeVariable: 'c',
      messageVariable: 'm',
    });
  });

  it('lowers a catch-all handler without a code', async () => {
    const result = await ir(
      `process p { on error { service R { class = "x.R" } } }`,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_0'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({ kind: 'error' });
  });

  it('honours an explicit start as the trigger-carrying start (id + label kept)', async () => {
    const result = await ir(
      `process p {
        on error "PF" { start In "Caught" service R { class = "x.R" } }
      }`,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_0'));
    // No start event is synthesized: the explicit start is the trigger start.
    const ids = handler.flowElements.map((fe) => fe.id);
    expect(ids).toContain('In');
    expect(ids).not.toContain(
      makeStartEventId(makeEventSubProcessId('p_0'), new Set()),
    );
    const start = only(handler, 'startEvent');
    expect(start.id).toBe('In');
    expect(start.name).toBe('Caught');
    expect(start.eventDefinition).toEqual({ kind: 'error', errorCode: 'PF' });
  });

  it('roots the handler body coordinate at its own structural coordinate', async () => {
    // Handler at process index 2, `if` at handler-body index 1 -> coord p_2_1.
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        service B { class = "x.B" }
        on error "PF" {
          service X { class = "x.X" }
          if (c) { service Y { class = "x.Y" } }
        }
      }`,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_2'));
    const gatewayIds = handler.flowElements
      .filter((fe) => fe.kind === 'exclusiveGateway')
      .map((fe) => fe.id);
    expect(gatewayIds).toContain(makeGatewaySplitId('p_2_1'));
    expect(gatewayIds).toContain(makeGatewayJoinId('p_2_1'));
  });

  it('composes a handler nested inside a sub-process', async () => {
    const result = await ir(
      `process p {
        subprocess S {
          service A { class = "x.A" }
          on error "PF" { service R { class = "x.R" } }
        }
      }`,
    );
    // subprocess S is p_0, handler body index 1 -> EventSubProcess_p_0_1.
    const sub = subProcess(result, 'S');
    const handler = subProcess(sub, makeEventSubProcessId('p_0_1'));
    expect(handler.triggeredByEvent).toBe(true);
    const all = allElementIdsDeep(result);
    expect(new Set(all).size).toBe(all.length);
  });

  it('synthesizes start(def) → flow → end for an empty handler body', async () => {
    const result = await ir(`process p { on error "PF" { } }`);
    const handlerId = makeEventSubProcessId('p_0');
    const handler = subProcess(result, handlerId);
    const startId = makeStartEventId(handlerId, new Set());
    const endId = makeEndEventId(handlerId, new Set());
    expect(handler.flowElements.map((fe) => fe.id)).toEqual([startId, endId]);
    expect(handler.sequenceFlows).toHaveLength(1);
    expect(flow(handler, startId, endId)).toBeDefined();
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({ kind: 'error', errorCode: 'PF' });
  });
});

// ── 15b. Hosted handlers (`on <Host>:`): inline boundary events ──────────────

describe('astToIr — hosted-handler lowering', () => {
  it('emits a boundary event attached to the host, with the body inline in the same container', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on A: error "PF" { service R { class = "x.R" } }
      }`,
    );

    const boundaryId = makeBoundaryEventId('A', 'error', new Set());
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.id).toBe(boundaryId);
    expect(boundary.attachedToRef).toBe('A');
    expect(boundary.eventDefinition).toEqual({
      kind: 'error',
      errorCode: 'PF',
    });
    expect(boundary.cancelActivity).toBeUndefined();

    // No wrapping container: the body's step is a sibling of the main flow, and
    // the boundary node follows its host in the element list, because the layout
    // engine needs the host shape before the attacher.
    expect(
      result.flowElements.filter((fe) => fe.kind === 'subProcess'),
    ).toEqual([]);
    const ids = result.flowElements.map((fe) => fe.id);
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf(boundaryId));
    expect(ids).toContain('R');

    // The escape chain runs boundary -> R -> its own implicit end, seeded from
    // the boundary id, and never rejoins the main flow.
    const escapeEndId = makeEndEventId(boundaryId, new Set());
    expect(flow(result, boundaryId, 'R')).toBeDefined();
    expect(flow(result, 'R', escapeEndId)).toBeDefined();
    expect(byId(result, escapeEndId).kind).toBe('endEvent');

    // The main chain is untouched, and the container's own end id does not
    // shift because a handler is present.
    expect(flow(result, 'StartEvent_p', 'A')).toBeDefined();
    expect(flow(result, 'A', 'EndEvent_p')).toBeDefined();
    expect(result.sequenceFlows.some((f) => f.targetRef === boundaryId)).toBe(
      false,
    );
  });

  it('stores cancelActivity: false for an alongside handler only', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on A: timer after "PT2H" alongside { service R { class = "x.R" } }
      }`,
    );
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.id).toBe(makeBoundaryEventId('A', 'timer', new Set()));
    expect(boundary.cancelActivity).toBe(false);
    expect(boundary.eventDefinition).toEqual({
      kind: 'timer',
      timerKind: 'duration',
      expression: 'PT2H',
    });
  });

  it('resolves a goto out of the body onto a main-flow node as a real flow', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        service B { class = "x.B" }
        on A: error "PF" {
          service R { class = "x.R" }
          goto B
        }
      }`,
    );
    const boundaryId = makeBoundaryEventId('A', 'error', new Set());
    expect(flow(result, boundaryId, 'R')).toBeDefined();
    expect(flow(result, 'R', 'B')).toBeDefined();
    // The chain transferred control, so no implicit end terminates it.
    expect(result.flowElements.map((fe) => fe.id)).not.toContain(
      makeEndEventId(boundaryId, new Set()),
    );
  });

  it('still yields boundary → end for an empty body', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on A: error "PF" { }
      }`,
    );
    const boundaryId = makeBoundaryEventId('A', 'error', new Set());
    const endId = makeEndEventId(boundaryId, new Set());
    expect(flow(result, boundaryId, endId)).toBeDefined();
    expect(byId(result, endId).kind).toBe('endEvent');
  });

  it('suffixes the second boundary id when two handlers share a host and trigger', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on A: timer after "PT1H" { service R { class = "x.R" } }
        on A: timer after "PT2H" { service S { class = "x.S" } }
      }`,
    );
    const boundaries = result.flowElements.filter(
      (fe) => fe.kind === 'boundaryEvent',
    );
    // Statement order decides which handler keeps the unsuffixed id.
    expect(boundaries.map((fe) => fe.id)).toEqual([
      'Boundary_A_timer',
      'Boundary_A_timer_2',
    ]);
    expect(flow(result, 'Boundary_A_timer', 'R')).toBeDefined();
    expect(flow(result, 'Boundary_A_timer_2', 'S')).toBeDefined();
  });

  it('lands a handler hosted inside a sub-process in that sub-process container', async () => {
    const result = await ir(
      `process p {
        subprocess S {
          service A { class = "x.A" }
          on A: error "PF" { service R { class = "x.R" } }
        }
      }`,
    );
    const sub = subProcess(result, 'S');
    const boundary = only(sub, 'boundaryEvent');
    expect(boundary.attachedToRef).toBe('A');
    expect(sub.flowElements.map((fe) => fe.id)).toContain('R');
    expect(result.flowElements.some((fe) => fe.kind === 'boundaryEvent')).toBe(
      false,
    );
    const all = allElementIdsDeep(result);
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps a host-less handler an event sub-process when a hosted one shares the container', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on A: error "PF" { service R { class = "x.R" } }
        on escalation "LS" { service E { class = "x.E" } }
      }`,
    );
    // The hosted handler is inline; the host-less one still wraps its body in a
    // triggeredByEvent container with a trigger-carrying start.
    expect(only(result, 'boundaryEvent').attachedToRef).toBe('A');
    const handlerId = makeEventSubProcessId('p_2');
    const handler = subProcess(result, handlerId);
    expect(handler.triggeredByEvent).toBe(true);
    expect(handler.flowElements.map((fe) => fe.id)).toEqual([
      makeStartEventId(handlerId, new Set()),
      'E',
      makeEndEventId(handlerId, new Set()),
    ]);
    expect(only(handler, 'startEvent').eventDefinition).toEqual({
      kind: 'escalation',
      escalationCode: 'LS',
    });
    for (const f of result.sequenceFlows) {
      expect(f.sourceRef).not.toBe(handlerId);
      expect(f.targetRef).not.toBe(handlerId);
    }
    expect(byId(result, 'R')).toBeDefined();
  });

  it('lifts a host-less handler written inside a hosted body into the outer container', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on A: error "PF" {
          service R { class = "x.R" }
          on escalation "LS" { service E { class = "x.E" } }
        }
      }`,
    );
    // A hosted handler's body is not a scope of its own, so a host-less handler
    // written inside it guards the whole enclosing container. The event
    // sub-process lands beside the process body, not in the escape chain.
    const handler = result.flowElements.find(
      (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
    );
    expect(handler).toBeDefined();
    expect(only(result, 'boundaryEvent').attachedToRef).toBe('A');
    expect(result.flowElements.find((fe) => fe.id === 'E')).toBeUndefined();
    expect(byId(handler!, 'E')).toBeDefined();
  });

  it('carries a hyphenated host name into attachedToRef and the boundary id verbatim', async () => {
    const result = await ir(
      `process p {
        service Check-Stock-2 { class = "x.A" }
        on Check-Stock-2: timer after "PT1H" { service R { class = "x.R" } }
      }`,
    );
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.attachedToRef).toBe('Check-Stock-2');
    expect(boundary.id).toBe('Boundary_Check-Stock-2_timer');
  });

  it('lowers a handler whose host does not resolve to a boundary event all the same', async () => {
    // The desugarer is total: an unresolvable host is a validator diagnostic,
    // and the construct a handler lowers to is decided by the presence of the
    // host slot, not by whether it resolved.
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on Missing: timer after "PT1H" { service R { class = "x.R" } }
      }`,
    );
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.attachedToRef).toBe('Missing');
    expect(boundary.id).toBe('Boundary_Missing_timer');
    expect(
      result.flowElements.filter((fe) => fe.kind === 'subProcess'),
    ).toEqual([]);
  });
});

// ── 16. Throw / emit lowering ────────────────────────────────────────────────

describe('astToIr — throw/emit lowering', () => {
  it('lowers `throw` to a typed end event with no fall-through', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        throw error "PF"
        service B { class = "x.B" }
      }`,
    );
    const throwId = makeThrowEventId('p_1');
    const thrown = byId(result, throwId);
    expect(thrown.kind).toBe('endEvent');
    expect((thrown as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'error',
      errorCode: 'PF',
    });
    expect(flow(result, 'A', throwId)).toBeDefined();
    expect(result.sequenceFlows.some((f) => f.sourceRef === throwId)).toBe(
      false,
    );
    // B is still lowered as a possible jump target, but the throw is terminal.
    expect(byId(result, 'B')).toBeDefined();
  });

  it('honours an explicit id on a throw', async () => {
    const result = await ir(`process p { throw escalation Failed "X" }`);
    const thrown = byId(result, 'Failed');
    expect(thrown.kind).toBe('endEvent');
    expect((thrown as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'escalation',
      escalationCode: 'X',
    });
  });

  it('lowers `emit` to an intermediate throw wired into the chain', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        emit escalation "LS"
        service B { class = "x.B" }
      }`,
    );
    const emitId = makeThrowEventId('p_1');
    const emitted = byId(result, emitId);
    expect(emitted.kind).toBe('intermediateThrowEvent');
    expect((emitted as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'escalation',
      escalationCode: 'LS',
    });
    expect(flow(result, 'A', emitId)).toBeDefined();
    expect(flow(result, emitId, 'B')).toBeDefined();
  });

  it('honours an explicit id on an emit', async () => {
    const result = await ir(`process p { emit escalation Ping "LS" }`);
    expect(byId(result, 'Ping').kind).toBe('intermediateThrowEvent');
  });
});

// ── 17. Error-message declarations ───────────────────────────────────────────

describe('astToIr — error-message declarations', () => {
  it('collects declarations in order', async () => {
    const result = await ir(
      `process p {
        error "PF" message "boom"
        error "LS" message "low"
        service A { class = "x.A" }
      }`,
    );
    expect(result.errorMessages).toEqual([
      { code: 'PF', message: 'boom' },
      { code: 'LS', message: 'low' },
    ]);
  });

  it('keeps the first declaration of a duplicated code (no throw)', async () => {
    const result = await ir(
      `process p {
        error "PF" message "first"
        error "PF" message "second"
        service A { class = "x.A" }
      }`,
    );
    expect(result.errorMessages).toEqual([{ code: 'PF', message: 'first' }]);
  });

  it('omits errorMessages entirely when no declaration is present', async () => {
    const result = await ir(`process p { service A { class = "x.A" } }`);
    expect(result.errorMessages).toBeUndefined();
  });
});

// ── 18. Totality under mis-placed / unknown-word constructs ──────────────────

describe('astToIr — handler/throw/emit totality', () => {
  it('keeps the chain intact around a mid-body handler', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on error "X" { service R { class = "x.R" } }
        service B { class = "x.B" }
      }`,
    );
    expect(flow(result, 'A', 'B')).toBeDefined();
    const handlerId = makeEventSubProcessId('p_1');
    for (const f of result.sequenceFlows) {
      expect(f.sourceRef).not.toBe(handlerId);
      expect(f.targetRef).not.toBe(handlerId);
    }
  });

  // An empty code, an unknown trigger word and an unknown binding field all
  // stay total and fall back to an error definition.
  it.each([
    [`process p { on error "" { } }`, { kind: 'error', errorCode: '' }],
    [
      `process p { on banana "X" { service R { class = "x.R" } } }`,
      { kind: 'error', errorCode: 'X' },
    ],
    [
      `process p { on error "X" (coed c) { service R { class = "x.R" } } }`,
      { kind: 'error', errorCode: 'X' },
    ],
  ])('lowers a handler: %s', async (source, expected) => {
    expect(handlerStart(await ir(source), 'p_0').eventDefinition).toEqual(
      expected,
    );
  });

  // A `throw` becomes a typed end event, an `emit` an intermediate throw, for
  // every trigger word including one the grammar does not know.
  it.each([
    [
      `process p { throw banana "X" }`,
      'endEvent',
      { kind: 'error', errorCode: 'X' },
    ],
    [
      `process p { emit error "X" }`,
      'intermediateThrowEvent',
      { kind: 'escalation', escalationCode: 'X' },
    ],
    [
      `process p { emit banana "X" }`,
      'intermediateThrowEvent',
      { kind: 'escalation', escalationCode: 'X' },
    ],
  ])('lowers a throw/emit: %s', async (source, kind, expected) => {
    const node = byId(await ir(source), makeThrowEventId('p_0'));
    expect(node.kind).toBe(kind);
    expect((node as { eventDefinition?: unknown }).eventDefinition).toEqual(
      expected,
    );
  });
});

// ── 19. message / signal handler triggers ────────────────────────────────────

describe('astToIr — message/signal handler triggers', () => {
  it('lowers `on message` to a message event definition; the chain bypasses the handler', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        on message "PaymentReceived" { service R { class = "x.R" } }
        service B { class = "x.B" }
      }`,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_1'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'message',
      messageName: 'PaymentReceived',
    });
    expect(flow(result, 'A', 'B')).toBeDefined();
  });

  it('lowers `on signal … alongside` to a signal event definition with isInterrupting false', async () => {
    const result = await ir(`process p { on signal "X" alongside { } }`);
    const handler = subProcess(result, makeEventSubProcessId('p_0'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({ kind: 'signal', signalName: 'X' });
    expect(start.isInterrupting).toBe(false);
  });
});

// ── 20. timer / condition handler triggers ───────────────────────────────────

describe('astToIr — timer and condition handler triggers', () => {
  // Each timer particle maps to its BPMN timerKind with the expression carried
  // verbatim; a parsed condition renders to its ${…} body and a raw template
  // survives untouched.
  it.each([
    [
      `process p { on timer after "PT1H" { } }`,
      { kind: 'timer', timerKind: 'duration', expression: 'PT1H' },
    ],
    [
      `process p { on timer at "2024-01-01T00:00:00Z" { } }`,
      { kind: 'timer', timerKind: 'date', expression: '2024-01-01T00:00:00Z' },
    ],
    [
      `process p { on timer every "R/PT1H" { } }`,
      { kind: 'timer', timerKind: 'cycle', expression: 'R/PT1H' },
    ],
    [
      'process p { on timer after "${dueDate}" { } }',
      { kind: 'timer', timerKind: 'duration', expression: '${dueDate}' },
    ],
    [
      `process p { on condition (amount > 100) { } }`,
      { kind: 'conditional', condition: '${amount > 100}' },
    ],
    [
      'process p { on condition ("${bean.check()}") { } }',
      { kind: 'conditional', condition: '${bean.check()}' },
    ],
  ])('%s', async (source, expected) => {
    expect(handlerStart(await ir(source), 'p_0').eventDefinition).toEqual(
      expected,
    );
  });
});

// ── 21. signal throw / emit ───────────────────────────────────────────────────

describe('astToIr — signal throw/emit', () => {
  it('lowers `throw signal` to a typed end event with no fall-through', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        throw signal "S"
        service B { class = "x.B" }
      }`,
    );
    const throwId = makeThrowEventId('p_1');
    const thrown = byId(result, throwId);
    expect(thrown.kind).toBe('endEvent');
    expect((thrown as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'signal',
      signalName: 'S',
    });
    expect(flow(result, 'A', throwId)).toBeDefined();
    expect(result.sequenceFlows.some((f) => f.sourceRef === throwId)).toBe(
      false,
    );
  });

  it('lowers `emit signal` to an intermediate throw wired into the chain', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        emit signal Ping "S"
        service B { class = "x.B" }
      }`,
    );
    const emitted = byId(result, 'Ping');
    expect(emitted.kind).toBe('intermediateThrowEvent');
    expect((emitted as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'signal',
      signalName: 'S',
    });
    expect(flow(result, 'A', 'Ping')).toBeDefined();
    expect(flow(result, 'Ping', 'B')).toBeDefined();
  });
});

// ── 22. Totality of the new triggers ─────────────────────────────────────────

describe('astToIr — new-trigger totality', () => {
  // Every under-specified handler lowers without throwing; bindings on a
  // message handler are ignored, and an unknown trigger carrying a
  // particle/time payload falls back to a bare error definition.
  it.each([
    [`process p { on message { } }`, { kind: 'message', messageName: '' }],
    [
      `process p { on timer { } }`,
      { kind: 'timer', timerKind: 'duration', expression: '' },
    ],
    [
      `process p { on timer "PT1H" { } }`,
      { kind: 'timer', timerKind: 'duration', expression: 'PT1H' },
    ],
    [
      `process p { on condition { } }`,
      { kind: 'conditional', condition: '${true}' },
    ],
    [
      `process p { on message "X" (code c) { } }`,
      { kind: 'message', messageName: 'X' },
    ],
    [`process p { on banana every "x" { } }`, { kind: 'error' }],
  ])('%s', async (source, expected) => {
    expect(handlerStart(await ir(source), 'p_0').eventDefinition).toEqual(
      expected,
    );
  });

  // throw/emit stay total for trigger words outside their new special case.
  it.each([
    [
      `process p { emit message "X" }`,
      { kind: 'escalation', escalationCode: 'X' },
    ],
    [`process p { throw timer "X" }`, { kind: 'error', errorCode: 'X' }],
  ])('%s', async (source, expected) => {
    const node = byId(await ir(source), makeThrowEventId('p_0'));
    expect((node as { eventDefinition?: unknown }).eventDefinition).toEqual(
      expected,
    );
  });
});

// ── 23. New-trigger composition (nested coordinates) ─────────────────────────

describe('astToIr — new-trigger composition (nested coordinates)', () => {
  it('a timer handler inside a subprocess roots its coordinate at the subprocess body', async () => {
    const result = await ir(
      `process p {
        subprocess S {
          service A { class = "x.A" }
          on timer after "PT1H" { service R { class = "x.R" } }
        }
      }`,
    );
    const sub = subProcess(result, 'S');
    const handler = subProcess(sub, makeEventSubProcessId('p_0_1'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'timer',
      timerKind: 'duration',
      expression: 'PT1H',
    });
  });

  it('an on-condition handler containing an if nests gateway coordinates under its own handler id', async () => {
    const result = await ir(
      'process p { on condition (amount > 100) { service X { class = "x.X" } if (c) { service Y { class = "x.Y" } } } }',
    );
    const handler = subProcess(result, makeEventSubProcessId('p_0'));
    const gatewayIds = handler.flowElements
      .filter((fe) => fe.kind === 'exclusiveGateway')
      .map((fe) => fe.id);
    expect(gatewayIds).toContain(makeGatewaySplitId('p_0_1'));
    expect(gatewayIds).toContain(makeGatewayJoinId('p_0_1'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'conditional',
      condition: '${amount > 100}',
    });
  });
});

// ── 24. compensation trigger ─────────────────────────────────────────────────

describe('astToIr — compensation handler lowering', () => {
  it('lowers a compensation handler out of the sequence chain inside a subprocess', async () => {
    const result = await ir(
      `process p {
        subprocess S {
          service A { class = "x.A" }
          on compensation { service U { class = "x.U" } }
        }
      }`,
    );
    const sub = subProcess(result, 'S');
    expect(flow(sub, 'StartEvent_S', 'A')).toBeDefined();
    expect(flow(sub, 'A', 'EndEvent_S')).toBeDefined();

    const handlerId = makeEventSubProcessId('p_0_1');
    const handler = subProcess(sub, handlerId);
    expect(handler.triggeredByEvent).toBe(true);
    for (const f of sub.sequenceFlows) {
      expect(f.sourceRef).not.toBe(handlerId);
      expect(f.targetRef).not.toBe(handlerId);
    }

    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({ kind: 'compensation' });
    expect(start.isInterrupting).toBeUndefined();
  });

  it('honours an explicit start as the trigger-carrying start', async () => {
    const result = await ir(
      `process p {
        on compensation { start In "Undo" service R { class = "x.R" } }
      }`,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_0'));
    const ids = handler.flowElements.map((fe) => fe.id);
    expect(ids).toContain('In');
    expect(ids).not.toContain(
      makeStartEventId(makeEventSubProcessId('p_0'), new Set()),
    );
    const start = only(handler, 'startEvent');
    expect(start.id).toBe('In');
    expect(start.name).toBe('Undo');
    expect(start.eventDefinition).toEqual({ kind: 'compensation' });
  });

  it('synthesizes start(def) → flow → end for an empty handler body (validator owns placement)', async () => {
    const result = await ir(`process p { on compensation { } }`);
    const handlerId = makeEventSubProcessId('p_0');
    const handler = subProcess(result, handlerId);
    expect(handler.triggeredByEvent).toBe(true);
    const startId = makeStartEventId(handlerId, new Set());
    const endId = makeEndEventId(handlerId, new Set());
    expect(handler.flowElements.map((fe) => fe.id)).toEqual([startId, endId]);
    expect(handler.sequenceFlows).toHaveLength(1);
    expect(flow(handler, startId, endId)).toBeDefined();
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({ kind: 'compensation' });
  });

  it('is total over a stray code, binding, and condition on the handler, still stamping isInterrupting: false for alongside', async () => {
    const result = await ir(
      `process p { on compensation "X" (code c) alongside { } }`,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_0'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({ kind: 'compensation' });
    expect(start.isInterrupting).toBe(false);
  });
});

describe('astToIr — compensation throw/emit lowering', () => {
  it('lowers `throw compensation` to a typed end event with no fall-through', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        throw compensation
        service B { class = "x.B" }
      }`,
    );
    const throwId = makeThrowEventId('p_1');
    const thrown = byId(result, throwId);
    expect(thrown.kind).toBe('endEvent');
    expect((thrown as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'compensation',
    });
    expect(flow(result, 'A', throwId)).toBeDefined();
    expect(result.sequenceFlows.some((f) => f.sourceRef === throwId)).toBe(
      false,
    );
  });

  it('lowers `emit compensation Undo` to an intermediate throw wired into the chain', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        emit compensation Undo
        service B { class = "x.B" }
      }`,
    );
    const emitted = byId(result, 'Undo');
    expect(emitted.kind).toBe('intermediateThrowEvent');
    expect((emitted as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'compensation',
    });
    expect(flow(result, 'A', 'Undo')).toBeDefined();
    expect(flow(result, 'Undo', 'B')).toBeDefined();
  });

  it('lowers `emit compensation` normally inside an on-error handler body and inside an on-compensation body', async () => {
    const inErrorHandler = await ir(
      `process p { on error "PF" { emit compensation } }`,
    );
    const errorHandler = subProcess(
      inErrorHandler,
      makeEventSubProcessId('p_0'),
    );
    const emittedInError = byId(errorHandler, makeThrowEventId('p_0_0'));
    expect(emittedInError.kind).toBe('intermediateThrowEvent');
    expect(
      (emittedInError as { eventDefinition?: unknown }).eventDefinition,
    ).toEqual({ kind: 'compensation' });

    const inCompensationHandler = await ir(
      `process p { on compensation { emit compensation } }`,
    );
    const compHandler = subProcess(
      inCompensationHandler,
      makeEventSubProcessId('p_0'),
    );
    const emittedInComp = byId(compHandler, makeThrowEventId('p_0_0'));
    expect(emittedInComp.kind).toBe('intermediateThrowEvent');
    expect(
      (emittedInComp as { eventDefinition?: unknown }).eventDefinition,
    ).toEqual({ kind: 'compensation' });
  });

  it('ignores a stray code string on `throw compensation`', async () => {
    const result = await ir(`process p { throw compensation "X" }`);
    const thrown = byId(result, makeThrowEventId('p_0'));
    expect(thrown.kind).toBe('endEvent');
    expect((thrown as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'compensation',
    });
  });

  it('keeps the code-less error/signal sinks lowering unchanged (regression pin)', async () => {
    const thrown = await ir(`process p { throw error }`);
    const thrownDef = (
      byId(thrown, makeThrowEventId('p_0')) as {
        eventDefinition?: { errorCode?: string };
      }
    ).eventDefinition;
    expect(thrownDef).toEqual({ kind: 'error' });
    expect(thrownDef?.errorCode).toBeUndefined();

    const emitted = await ir(`process p { emit signal }`);
    expect(
      (byId(emitted, makeThrowEventId('p_0')) as { eventDefinition?: unknown })
        .eventDefinition,
    ).toEqual({ kind: 'signal', signalName: '' });
  });
});

describe('astToIr — compensation coordinate composition', () => {
  it('composes coordinates when a compensation handler and an if are siblings inside a subprocess', async () => {
    const result = await ir(
      `process p {
        subprocess S {
          if (c) { service Y { class = "x.Y" } }
          on compensation { service U { class = "x.U" } }
        }
      }`,
    );
    const sub = subProcess(result, 'S');
    // S's own coordinate is p_0, so the `if` at S-body index 0 is p_0_0.
    const gatewayIds = sub.flowElements
      .filter((fe) => fe.kind === 'exclusiveGateway')
      .map((fe) => fe.id);
    expect(gatewayIds).toContain(makeGatewaySplitId('p_0_0'));
    expect(gatewayIds).toContain(makeGatewayJoinId('p_0_0'));

    // The compensation handler at S-body index 1 is EventSubProcess_p_0_1.
    const handler = subProcess(sub, makeEventSubProcessId('p_0_1'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual({ kind: 'compensation' });
  });
});

// ── 25. await -> intermediate catch lowering ─────────────────────────────────

describe('astToIr — await intermediate catch lowering', () => {
  it('lowers `await message` to an intermediate catch wired into the chain', async () => {
    const result = await ir(
      `process p {
        service A { class = "x.A" }
        await message "M"
        service B { class = "x.B" }
      }`,
    );
    const catchId = makeIntermediateCatchEventId('p_1');
    const caught = byId(result, catchId);
    expect(caught.kind).toBe('intermediateCatchEvent');
    expect((caught as { eventDefinition?: unknown }).eventDefinition).toEqual({
      kind: 'message',
      messageName: 'M',
    });
    expect(flow(result, 'A', catchId)).toBeDefined();
    expect(flow(result, catchId, 'B')).toBeDefined();
  });

  // Each timer particle maps to its BPMN timerKind with the expression carried
  // verbatim; a condition renders through renderExpression, same as an `if`.
  it.each([
    [
      `process p { await timer after "PT1H" }`,
      { kind: 'timer', timerKind: 'duration', expression: 'PT1H' },
    ],
    [
      `process p { await timer at "2024-01-01T00:00:00Z" }`,
      { kind: 'timer', timerKind: 'date', expression: '2024-01-01T00:00:00Z' },
    ],
    [
      `process p { await timer every "R/PT1H" }`,
      { kind: 'timer', timerKind: 'cycle', expression: 'R/PT1H' },
    ],
    [`process p { await signal "S" }`, { kind: 'signal', signalName: 'S' }],
    [
      `process p { await condition (amount > 100) }`,
      { kind: 'conditional', condition: '${amount > 100}' },
    ],
  ])('%s', async (source, expected) => {
    const result = await ir(source);
    expect(definitionOf(result, makeIntermediateCatchEventId('p_0'))).toEqual(
      expected,
    );
  });

  it('gives two catches in one body distinct, non-colliding ids', async () => {
    const result = await ir(
      `process p {
        await message "First"
        await signal "Second"
      }`,
    );
    const firstId = makeIntermediateCatchEventId('p_0');
    const secondId = makeIntermediateCatchEventId('p_1');
    expect(firstId).not.toBe(secondId);
    expect(byId(result, firstId).kind).toBe('intermediateCatchEvent');
    expect(byId(result, secondId).kind).toBe('intermediateCatchEvent');
    expect(flow(result, firstId, secondId)).toBeDefined();
  });
});

// ── Local helpers ────────────────────────────────────────────────────────────

/** Find a flow element by id (asserting exactly one such element). */
function byId(container: FlowContainer, id: string): FlowElement {
  const node = container.flowElements.find((fe) => fe.id === id);
  expect(node).toBeDefined();
  return node!;
}

/** The event definition carried by the flow element with the given id. */
function definitionOf(container: FlowContainer, id: string): unknown {
  return (byId(container, id) as { eventDefinition?: unknown }).eventDefinition;
}

/** Stable sort an array of objects by their `id` field for set comparison. */
function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

/** Collect every flow-element id (events, tasks, gateways) of a process. */
function allElementIds(process: BpmnProcess): string[] {
  return process.flowElements.map((fe) => fe.id);
}

/**
 * Collect every flow-element id across a container and all of its nested
 * sub-process containers, the document-uniqueness view.
 */
function allElementIdsDeep(container: FlowContainer): string[] {
  const ids: string[] = [];
  for (const fe of container.flowElements) {
    ids.push(fe.id);
    if (fe.kind === 'subProcess') {
      ids.push(...allElementIdsDeep(fe));
    }
  }
  return ids;
}

/** The start event of the `on` handler lowered at the given coordinate. */
function handlerStart(container: FlowContainer, coordinate: string) {
  return only(
    subProcess(container, makeEventSubProcessId(coordinate)),
    'startEvent',
  );
}

/** Find the named sub-process node in a container (asserting exactly one). */
function subProcess(container: FlowContainer, id: string): SubProcess {
  const node = container.flowElements.find(
    (fe): fe is SubProcess => fe.kind === 'subProcess' && fe.id === id,
  );
  expect(node).toBeDefined();
  return node!;
}
