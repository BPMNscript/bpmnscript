/**
 * Full test suite for the desugaring AST → IR transform (`astToIr`).
 *
 * Unit-level tests: each parses inline BpmnScript DSL source through the real
 * Langium grammar and asserts the flat, BPMN-shaped IR produced by `astToIr`.
 *
 * No fixture files are read — the expected IR is expressed as inline literals so
 * the desugaring rules are pinned without depending on external fixtures.
 *
 * Coverage (one block per desugaring rule):
 *   1. Implicit sequence + implicit start/end.
 *   2. `if`/`else` → XOR split+join with conditioned + default flows.
 *   3. `else if` chain → multiple conditioned split flows + one default.
 *   4. `while` → pre-test XOR loop + back-edge, no loop characteristics.
 *   5. `do … while` → post-test XOR loop.
 *   6. `parallel` → fork/join `parallelGateway` pair, no conditions.
 *   7. `goto` → raw sequence flow to the target node.
 *   8. Synthesized-id determinism guard.
 *   9. Attribute mapping (assignee / formKey / javaClass / process label).
 *  10. Empty model throws `/no process definitions/i`.
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
} from '../src/synthesize-ids.js';
import type {
  BpmnProcess,
  ExclusiveGateway,
  ParallelGateway,
  SequenceFlow,
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

/** Find the single flow element of a given kind (asserting exactly one). */
function only<K extends BpmnProcess['flowElements'][number]['kind']>(
  process: BpmnProcess,
  kind: K,
): Extract<BpmnProcess['flowElements'][number], { kind: K }> {
  const matches = process.flowElements.filter((fe) => fe.kind === kind);
  expect(matches).toHaveLength(1);
  return matches[0] as Extract<
    BpmnProcess['flowElements'][number],
    { kind: K }
  >;
}

/** Find a flow by `source → target` (asserting exactly one such pair). */
function flow(
  process: BpmnProcess,
  source: string,
  target: string,
): SequenceFlow {
  const matches = process.sequenceFlows.filter(
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
});

// ── 2. if / else → XOR split + join ──────────────────────────────────────────

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
});

// ── 3. else-if chain → multiple conditioned split flows + one default ────────

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

// ── 4. while → pre-test XOR loop + back-edge ─────────────────────────────────

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
});

// ── 5. do … while → post-test XOR loop ───────────────────────────────────────

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

// ── 6. parallel → fork/join parallelGateway pair ─────────────────────────────

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
});

// ── 7. goto → raw sequence flow to the target node ───────────────────────────

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
    // After `goto Foo`, control transfers — no implicit end follows the goto.
    const result = await ir(`process P { user A goto A }`);
    // The only flows are start→A and the back-jump A→A.
    const selfJump = flow(result, 'A', 'A');
    expect(selfJump).toBeDefined();
    // No synthesized end (control never falls off the end).
    expect(result.flowElements.filter((fe) => fe.kind === 'endEvent')).toEqual(
      [],
    );
  });

  it('a goto into a compound block resolves to the compound body entry', async () => {
    // A goto can target a compound statement's id. In the grammar only leaf
    // statements expose `name=ID` (`goto [Statement:ID]`); compound statements
    // (if/while/…) have NO name, so
    // their synthesised split-gateway id is not a nameable target. The closest
    // realisable behaviour — and the one that matters — is a goto to the first
    // named statement INSIDE a compound block: it lands on that statement's
    // entry, which is the entry node of the compound body (not the synthesised
    // split gateway, which only convergent/implicit flow reaches).
    const result = await ir(
      `process P { user A goto Inner if (x) { user Inner } }`,
    );

    // The goto out of A lands directly on the compound's body entry `Inner`.
    expect(flow(result, 'A', 'Inner').targetRef).toBe('Inner');

    // The split gateway still routes the if's true branch to `Inner` via its
    // synthesised entry; the goto bypasses the gateway entirely (raw jump).
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
      javaClass: 'com.example.Delegate',
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

  it('accepts a dotted bareword class value as a plain javaClass', async () => {
    const result = await ir(
      `process P { service S { class = com.example.X } }`,
    );
    const svc = result.flowElements.find((fe) => fe.kind === 'serviceTask')!;
    expect((svc as { javaClass: string }).javaClass).toBe('com.example.X');
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
    // Regression for the BLOCKING defect: `lowerIf` passed the SAME coordinate
    // to the `then`, every `elseIf`, and the `else` block, so a nested compound
    // at index 0 of `then` and one at index 0 of `else` collided.
    const result = await ir(
      `process P { if (a) { if (b) { user X } } else { if (c) { user Y } } }`,
    );

    const elementIds = allElementIds(result);
    // 10 elements: start, end, outer split/join, then-inner split/join,
    //              else-inner split/join, user X, user Y.
    expect(elementIds).toHaveLength(10);
    expect(new Set(elementIds).size).toBe(elementIds.length);

    // The branch-discriminating segments produce structurally distinct coords:
    // `then` → `P_0_t_0`, `else` → `P_0_e_0`.
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
    // then → `_t`, first else-if → `_e0`, else → `_e`.
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

// ── Local helpers ────────────────────────────────────────────────────────────

/** Stable sort an array of objects by their `id` field for set comparison. */
function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

/** Collect every flow-element id (events, tasks, gateways) of a process. */
function allElementIds(process: BpmnProcess): string[] {
  return process.flowElements.map((fe) => fe.id);
}
