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
  makeGatewayRaceId,
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
  ExecutionListener,
  FlowContainer,
  FlowElement,
  InclusiveGateway,
  IoValue,
  LoopCharacteristics,
  Repeatable,
  SequenceFlow,
  SubProcess,
} from '../src/ir/types.js';
import { byId, only, subProcess } from './helpers/ir-query.js';
import {
  callActivity,
  classBinding,
  conditionDef,
  delegateBinding,
  edge,
  errorDef,
  escalationDef,
  exprBinding,
  externalBinding,
  gateway,
  ioParam,
  listValue,
  mapEntry,
  mapValue,
  messageDef,
  processIr,
  scriptTask,
  scriptValue,
  serviceTask,
  signalDef,
  textValue,
  timerDef,
} from './helpers/ir-fixtures.js';

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

/** `service A` (the chain's host) followed by the given statements. */
const afterA = (statements: string): Promise<BpmnProcess> =>
  ir(`process p { service A { class = "x.A" } ${statements} }`);

/** The ids of every exclusive gateway in a container. */
const xorGatewayIds = (container: FlowContainer): string[] =>
  container.flowElements
    .filter((fe) => fe.kind === 'exclusiveGateway')
    .map((fe) => fe.id);

/** Assert `source` lowers to one end event, pushed to `_2` by a name collision. */
async function expectCollidedEnd(source: string): Promise<void> {
  const ends = (await ir(source)).flowElements.filter(
    (fe) => fe.kind === 'endEvent',
  );
  expect(ends).toHaveLength(1);
  expect(ends[0]!.id).toBe('EndEvent_P_2');
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

describe('astToIr: implicit sequence and implicit start/end', () => {
  it.each([
    [
      'chains bare statements and synthesizes the start and the end around them',
      `process P { user A user B }`,
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'StartEvent_P' },
          { kind: 'userTask', id: 'A' },
          { kind: 'userTask', id: 'B' },
          { kind: 'endEvent', id: 'EndEvent_P' },
        ],
        [edge('A', 'B'), edge('StartEvent_P', 'A'), edge('B', 'EndEvent_P')],
      ),
    ],
    [
      'keeps an explicit start and end verbatim, synthesizing neither',
      `process P { start S user A end E }`,
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        [edge('S', 'A'), edge('A', 'E')],
      ),
    ],
    [
      'synthesizes only the start when the body already ends in an end',
      `process P { user A end Done }`,
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'StartEvent_P' },
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'Done' },
        ],
        [edge('A', 'Done'), edge('StartEvent_P', 'A')],
      ),
    ],
  ])('%s', async (_title, source, expected) => {
    expect(await ir(source)).toEqual(expected);
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

describe('astToIr: if/else exclusive gateway', () => {
  const SOURCE = `process P {
  if (amount > 1000) { user S } else { service A { class = "com.example.X" } }
}`;

  it('splits on the condition, rejoins both branches, and makes the else the unconditioned default', async () => {
    const splitId = makeGatewaySplitId('P_0');
    const joinId = makeGatewayJoinId('P_0');
    const defaultFlowId = makeDefaultFlowId(splitId);

    expect(await ir(SOURCE)).toEqual(
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'StartEvent_P' },
          gateway(splitId, defaultFlowId),
          gateway(joinId),
          { kind: 'userTask', id: 'S' },
          serviceTask('A', classBinding('com.example.X')),
          { kind: 'endEvent', id: 'EndEvent_P' },
        ],
        [
          edge(splitId, 'S', { condition: '${amount > 1000}' }),
          edge('S', joinId),
          edge(splitId, 'A', { id: defaultFlowId }),
          edge('A', joinId),
          edge('StartEvent_P', splitId),
          edge(joinId, 'EndEvent_P'),
        ],
      ),
    );
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

  it('keeps the split->join default flow when there is no else (never pruned)', async () => {
    const result = await ir(`process P { if (c) { end A } }`);
    const splitId = makeGatewaySplitId('P_0');
    const joinId = makeGatewayJoinId('P_0');
    expect(result.flowElements.some((fe) => fe.id === joinId)).toBe(true);
    expect(flow(result, splitId, joinId)).toBeDefined();
  });
});

describe('astToIr: else-if chain', () => {
  const SOURCE = `process P {
  if (a > 1) { user X }
  else if (a > 2) { user Y }
  else { user Z }
}`;

  it('conditions one flow per if/else-if, leaves the else the default, and converges all three on the join', async () => {
    const splitId = makeGatewaySplitId('P_0');
    const joinId = makeGatewayJoinId('P_0');
    const defaultFlowId = makeDefaultFlowId(splitId);
    const result = await ir(SOURCE);

    expect(byId(result, splitId)).toEqual(gateway(splitId, defaultFlowId));
    expect(result.sequenceFlows).toEqual([
      edge(splitId, 'X', { condition: '${a > 1}' }),
      edge('X', joinId),
      edge(splitId, 'Y', { condition: '${a > 2}' }),
      edge('Y', joinId),
      edge(splitId, 'Z', { id: defaultFlowId }),
      edge('Z', joinId),
      edge('StartEvent_P', splitId),
      edge(joinId, 'EndEvent_P'),
    ]);
  });
});

describe('astToIr: while loop', () => {
  it('routes the entry into a loop gateway with a conditioned body entry, a back-edge and a default exit', async () => {
    const loopId = makeGatewayLoopId('P_1');
    const defaultFlowId = makeDefaultFlowId(loopId);

    // The exact element list is also what pins that a loop never lowers to
    // loop characteristics on an activity: it is gateway plus back-edge only.
    expect(
      await ir(`process P { user Pre while (rejected) { user R } user Post }`),
    ).toEqual(
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'StartEvent_P' },
          { kind: 'userTask', id: 'Pre' },
          gateway(loopId, defaultFlowId),
          { kind: 'userTask', id: 'R' },
          { kind: 'userTask', id: 'Post' },
          { kind: 'endEvent', id: 'EndEvent_P' },
        ],
        [
          edge(loopId, 'R', { condition: '${rejected}' }),
          edge('R', loopId),
          edge('Pre', loopId),
          edge(loopId, 'Post', { id: defaultFlowId }),
          edge('StartEvent_P', 'Pre'),
          edge('Post', 'EndEvent_P'),
        ],
      ),
    );
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

describe('astToIr: do-while loop', () => {
  it('runs the body first, the start entering it rather than the gateway, then loops back on the condition', async () => {
    const loopId = makeGatewayLoopId('P_0');
    const defaultFlowId = makeDefaultFlowId(loopId);

    expect(await ir(`process P { do { user R } while (rejected) }`)).toEqual(
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'StartEvent_P' },
          { kind: 'userTask', id: 'R' },
          gateway(loopId, defaultFlowId),
          { kind: 'endEvent', id: 'EndEvent_P' },
        ],
        [
          edge('R', loopId),
          edge(loopId, 'R', { condition: '${rejected}' }),
          edge('StartEvent_P', 'R'),
          edge(loopId, 'EndEvent_P', { id: defaultFlowId }),
        ],
      ),
    );
  });
});

describe('astToIr: goto', () => {
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
    // Only leaf statements expose `name=ID`, so a goto into a compound names
    // the first statement of its body and bypasses the split gateway, which
    // still routes the true branch there itself.
    const result = await ir(
      `process P { user A goto Inner if (x) { user Inner } }`,
    );
    const splitId = makeGatewaySplitId('P_2');

    expect(flow(result, 'A', 'Inner').targetRef).toBe('Inner');
    expect(flow(result, splitId, 'Inner')).toBeDefined();
  });

  it.each([
    [
      'a topic-bound service task',
      'service Ship { topic = "shipping" }',
      'Ship',
    ],
    ['a script task', 'script Calc ```js\nx = 1;\n```', 'Calc'],
  ])(
    'lands on %s, whose name is registered even though its head takes no plain block',
    async (_title, declaration, target) => {
      const result = await ir(
        `process P { user A goto ${target} ${declaration} }`,
      );
      expect(flow(result, 'A', target).targetRef).toBe(target);
    },
  );
});

describe('astToIr: synthesized id determinism', () => {
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

  // Gateway ids are purely positional and never consult `taken`; what
  // `collectNamedIds` guards is the implicit start/end ids, which do. A
  // statement named like the synthesized end pushes that end to `_2`.
  it.each([
    ['user EndEvent_P'],
    ['step EndEvent_P'],
    ['service EndEvent_P { topic = "t" }'],
    ['send EndEvent_P { class = "c" }'],
    ['receive EndEvent_P'],
    ['decide EndEvent_P { decision = "d" }'],
    ['script EndEvent_P ```js\nx = 1;\n```'],
    ['call EndEvent_P { process = "p" }'],
  ])(
    '`%s` reserves its name against the synthesized end',
    async (statement) => {
      await expectCollidedEnd(`process P { ${statement} }`);
    },
  );
});

describe('astToIr: attribute mapping', () => {
  it('maps user assignee/formKey and service class to IR fields', async () => {
    const result = await ir(`process P {
      user T "Task" { assignee = "demo" formKey = "embedded:form" }
      service S "Svc" { class = "com.example.Delegate" }
    }`);

    const task = only(result, 'userTask');
    expect(task).toEqual({
      kind: 'userTask',
      id: 'T',
      name: 'Task',
      assignee: 'demo',
      formKey: 'embedded:form',
    });

    const svc = only(result, 'serviceTask');
    expect(svc).toEqual({
      kind: 'serviceTask',
      id: 'S',
      name: 'Svc',
      binding: classBinding('com.example.Delegate'),
    });
  });

  it.each([
    [
      'an inline label becomes the process name',
      `process P "My Process" { user A }`,
      { name: 'My Process' },
    ],
    [
      'a header `label = "..."` declaration becomes the process name',
      `process P { label = "Header Label" user A }`,
      { name: 'Header Label' },
    ],
    [
      'a header carrying neither leaves both keys out',
      `process P { user A }`,
      {},
    ],
    [
      'a duplicated versionTag keeps the first (the validator owns the diagnostic)',
      `process p { versionTag = "1.4" versionTag = "2.0" user A }`,
      { versionTag: '1.4' },
    ],
    [
      'a label, a version tag and a var declaration coexist in any header order',
      `process p { label = "Invoice" versionTag = "1.4" var amount: number user A }`,
      { name: 'Invoice', versionTag: '1.4' },
    ],
  ])('%s', async (_title, source, expected) => {
    const { name, versionTag } = await ir(source);
    expect({ name, versionTag }).toEqual({
      name: undefined,
      versionTag: undefined,
      ...expected,
    });
  });
});

describe('astToIr: service task binding variants', () => {
  it.each([
    [
      'reads a dotted bareword `class` as a plain Java path, stripping the ${...} wrapper',
      'class = com.example.X',
      classBinding('com.example.X'),
    ],
    [
      'maps `topic` to the external-worker binding',
      'topic = "shipping"',
      externalBinding('shipping'),
    ],
    [
      'maps `expression = "${...}"` to binding {kind:"expression"}, the raw ${...} carried verbatim',
      'expression = "${bean.method(execution)}"',
      exprBinding('${bean.method(execution)}'),
    ],
    [
      'maps `delegate = "${...}"` to binding {kind:"delegateExpression"} (friendly alias)',
      'delegate = "${beanName}"',
      delegateBinding('${beanName}'),
    ],
    [
      'wraps a bareword `delegate = chargeService` (no quotes) in ${...} rather than stripping it',
      'delegate = chargeService',
      delegateBinding('${chargeService}'),
    ],
    [
      // Unlike `class`, whose dotted-bareword value is a plain Java path and
      // gets the ${...} wrapper stripped, `expression`/`delegate` must keep the
      // wrapper so Operaton evaluates the value as EL, not a literal string.
      'wraps a dotted-VarRef `expression = svc.status` (no quotes) in ${...} rather than stripping it',
      'expression = svc.status',
      exprBinding('${svc.status}'),
    ],
  ])('%s', async (_title, member, binding) => {
    const result = await ir(`process P { service S { ${member} } }`);
    expect(only(result, 'serviceTask').binding).toEqual(binding);
  });
});

describe('astToIr: script task', () => {
  it.each([
    [
      'maps a fenced ```js``` script to scriptTask{format:"javascript", code:<inner body>}',
      'process P { script total ```js\ntotal = amount * 1.1;\n``` }',
    ],
    [
      'drops a trailing \\r from a \\r\\n-terminated opening fence line',
      'process P { script total ```js\r\ntotal = amount * 1.1;\n``` }',
    ],
  ])('%s', async (_title, source) => {
    expect(only(await ir(source), 'scriptTask')).toEqual(
      scriptTask('total', 'javascript', 'total = amount * 1.1;\n'),
    );
  });
});

describe('astToIr: task-kind lowering (step/send/receive/decide)', () => {
  it('step S "Label" lowers to a task node with no other key', async () => {
    const result = await ir('process P { step S "Label" }');
    expect(only(result, 'task')).toEqual({
      kind: 'task',
      id: 'S',
      name: 'Label',
    });
  });

  it('send binds exactly as a service task does, tagged element: "send"', async () => {
    const classed = await ir(
      'process P { send N { class = "com.example.Send" } }',
    );
    expect(only(classed, 'serviceTask')).toEqual({
      kind: 'serviceTask',
      id: 'N',
      binding: classBinding('com.example.Send'),
      element: 'send',
    });

    const external = await ir('process P { send N { topic = "t" } }');
    expect(only(external, 'serviceTask').binding).toEqual(externalBinding('t'));
  });

  it('receive with a message key lowers with messageName; with none, no messageName key at all', async () => {
    const named = await ir('process P { receive R { message = "OrderPaid" } }');
    expect(only(named, 'receiveTask')).toEqual({
      kind: 'receiveTask',
      id: 'R',
      messageName: 'OrderPaid',
    });

    const unnamed = only(await ir('process P { receive R }'), 'receiveTask');
    expect(unnamed).toEqual({ kind: 'receiveTask', id: 'R' });
    expect('messageName' in unnamed).toBe(false);
  });

  /** The binding a `decide D { decision = "riskRating" <member> }` lowers to. */
  const decideBinding = async (member: string) =>
    only(
      await ir(`process P { decide D { decision = "riskRating" ${member} } }`),
      'serviceTask',
    ).binding;

  it('decide with a decision key lowers to element: "businessRule" with a decision binding', async () => {
    const result = await ir(
      'process P { decide D { decision = "riskRating" } }',
    );
    expect(only(result, 'serviceTask')).toEqual({
      kind: 'serviceTask',
      id: 'D',
      binding: { kind: 'decision', decisionRef: 'riskRating' },
      element: 'businessRule',
    });
  });

  it.each([
    ['binding = latest', { binding: { kind: 'latest' } }],
    ['version = 3', { binding: { kind: 'version', version: '3' } }],
    ['mapDecisionResult = singleEntry', { mapDecisionResult: 'singleEntry' }],
  ])(
    '`%s` lowers verbatim alongside the decision reference',
    async (member, extra) => {
      expect(await decideBinding(member)).toEqual({
        kind: 'decision',
        decisionRef: 'riskRating',
        ...extra,
      });
    },
  );

  it('decide falling through to a class binding when no decision key is written', async () => {
    const result = await ir('process P { decide D { class = "c" } }');
    expect(only(result, 'serviceTask')).toEqual({
      kind: 'serviceTask',
      id: 'D',
      binding: classBinding('c'),
      element: 'businessRule',
    });
  });

  it.each([
    ['step', ''],
    ['send', 'class = "c"'],
    ['receive', ''],
    ['decide', 'decision = "d"'],
  ])(
    '%s carries input/output parameters and engine settings into the IR',
    async (keyword, binding) => {
      const result = await ir(
        `process P { ${keyword} X { ${binding} input a = "x" output b = "y" asyncBefore = true jobPriority = 5 } }`,
      );
      const el = byId(result, 'X') as {
        inputParameters?: unknown;
        outputParameters?: unknown;
        asyncBefore?: boolean;
        jobPriority?: string;
      };
      expect(el.inputParameters).toEqual([
        { name: 'a', value: textValue('x') },
      ]);
      expect(el.outputParameters).toEqual([
        { name: 'b', value: textValue('y') },
      ]);
      expect(el.asyncBefore).toBe(true);
      expect(el.jobPriority).toBe('5');
    },
  );
});

describe('astToIr: empty model error', () => {
  it('throws when the model contains no process definitions', async () => {
    const doc = await parse('');
    expect(() => astToIr(doc.parseResult.value)).toThrow(
      /no process definitions/i,
    );
  });
});

describe('astToIr: sibling-branch coordinate uniqueness', () => {
  it('gives a nested compound in each if-branch kind its own coordinate segment', async () => {
    const result = await ir(
      `process P {
        if (a) { if (b) { user X } }
        else if (c) { if (d) { user Y } }
        else { if (e) { user Z } }
      }`,
    );
    expect(allElementIds(result)).toEqual([
      'StartEvent_P',
      'Gateway_P_0_split',
      'Gateway_P_0_join',
      'Gateway_P_0_t_0_split',
      'Gateway_P_0_t_0_join',
      'X',
      'Gateway_P_0_e0_0_split',
      'Gateway_P_0_e0_0_join',
      'Y',
      'Gateway_P_0_e_0_split',
      'Gateway_P_0_e_0_join',
      'Z',
      'EndEvent_P',
    ]);

    const gatewayIds = xorGatewayIds(result);
    // then -> `_t`, first else-if -> `_e0`, else -> `_e`.
    expect(gatewayIds).toContain(makeGatewaySplitId('P_0_t_0'));
    expect(gatewayIds).toContain(makeGatewaySplitId('P_0_e0_0'));
    expect(gatewayIds).toContain(makeGatewaySplitId('P_0_e_0'));
  });
});

describe('astToIr: all synthesized ids are globally unique (property check)', () => {
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
      name: 'race with a nested parallel branch',
      source: `process P {
        await {
          message "M" { parallel { { user X } { user Y } } }
          signal "S" { user Z }
        }
      }`,
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

  /**
   * The four shapes that hold an id back for a flow they have not pushed yet:
   * an `if` chain's fallback, an inclusive fork's fallback, and the exit of
   * either loop. The id is `Flow_<gateway>_default`, which is also what a
   * statement named `default` reached from that same gateway would take for
   * its own incoming flow, so the claim has to be made before the branch is
   * lowered or the document carries two flows under one id.
   */
  const RESERVING_SHAPES = [
    `process P { if (a) { user default } else { user B } }`,
    `process P { parallel { if (a) { user default } else { user B } } }`,
    `process P { while (a) { user default } }`,
    `process P { do { user default } while (a) }`,
  ];

  it('claims a gateway default-flow id, so no two sequence flows share one', async () => {
    const shared: Record<string, string[]> = {};
    for (const source of RESERVING_SHAPES) {
      const ids = (await ir(source)).sequenceFlows.map((f) => f.id);
      shared[source] = ids.filter((id, i) => ids.indexOf(id) !== i);
    }

    expect(shared).toEqual(
      Object.fromEntries(RESERVING_SHAPES.map((source) => [source, []])),
    );
  });

  it('holds no id back for a split that weighs nothing, so a `default` beside it keeps the plain one', async () => {
    // An AND split leaves no branch out, so it names no fallback and pushes no
    // flow under the reserved id. Claiming it anyway would move the authored
    // collider onto a suffixed id with nothing to show for it.
    const result = await ir(
      `process P { parallel { { user default } { user B } } }`,
    );

    const into = result.sequenceFlows.find((f) => f.targetRef === 'default');
    expect(into?.id).toBe('Flow_Gateway_P_0_fork_default');
  });
});

describe('astToIr: sub-process lowering', () => {
  it('lowers a sub-process body into its own container, the parent seeing one activity', async () => {
    expect(
      await ir(`process p { subprocess S { user A { assignee = "x" } } }`),
    ).toEqual(
      processIr(
        'p',
        [
          { kind: 'startEvent', id: 'StartEvent_p' },
          {
            kind: 'subProcess',
            id: 'S',
            flowElements: [
              { kind: 'startEvent', id: 'StartEvent_S' },
              { kind: 'userTask', id: 'A', assignee: 'x' },
              { kind: 'endEvent', id: 'EndEvent_S' },
            ],
            sequenceFlows: [edge('StartEvent_S', 'A'), edge('A', 'EndEvent_S')],
          },
          { kind: 'endEvent', id: 'EndEvent_p' },
        ],
        [edge('StartEvent_p', 'S'), edge('S', 'EndEvent_p')],
      ),
    );
  });

  it('honors explicit start/end inside the body (no synthesized events)', async () => {
    const result = await ir(
      `process p { subprocess S { start In user A { assignee = "x" } end Out } }`,
    );
    expect(subProcess(result, 'S')).toEqual({
      kind: 'subProcess',
      id: 'S',
      flowElements: [
        { kind: 'startEvent', id: 'In' },
        { kind: 'userTask', id: 'A', assignee: 'x' },
        { kind: 'endEvent', id: 'Out' },
      ],
      sequenceFlows: [edge('In', 'A'), edge('A', 'Out')],
    });
  });

  it('roots the body coordinate at the sub-process own structural coordinate', async () => {
    const result = await ir(
      `process p {
        user Pre { assignee = "x" }
        subprocess S { if (c) { user A { assignee = "y" } } }
      }`,
    );
    const sub = subProcess(result, 'S');
    const gatewayIds = xorGatewayIds(sub);
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
    expect(xorGatewayIds(sInThen)).toContain(makeGatewaySplitId('p_2_t_0_0'));

    // A sub-process nested in a sub-process composes coordinates: outer `p_1`,
    // inner `p_1_0`; a compound in the inner body is `p_1_0_0`.
    const nested = await ir(
      `process p {
        user A { assignee = "x" }
        subprocess Outer { subprocess Inner { if (d) { user X { assignee = "x" } } } }
      }`,
    );
    const inner = subProcess(subProcess(nested, 'Outer'), 'Inner');
    expect(xorGatewayIds(inner)).toContain(makeGatewaySplitId('p_1_0_0'));
  });

  it('maps an inline label to the container name, an empty body still getting its start/end pair', async () => {
    const result = await ir(`process p { subprocess S "Handle" { } }`);
    expect(subProcess(result, 'S')).toEqual({
      kind: 'subProcess',
      id: 'S',
      name: 'Handle',
      flowElements: [
        { kind: 'startEvent', id: 'StartEvent_S' },
        { kind: 'endEvent', id: 'EndEvent_S' },
      ],
      sequenceFlows: [edge('StartEvent_S', 'EndEvent_S')],
    });
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

  it('lowers everything but the tag identically under both heads', async () => {
    const tail =
      '"Try to book and pay" for 2 { asyncBefore = true } { user A { assignee = "x" } }';
    const attempted = subProcess(
      await ir(`process p { attempt B ${tail} }`),
      'B',
    );
    const plain = subProcess(
      await ir(`process p { subprocess B ${tail} }`),
      'B',
    );
    expect(attempted).toEqual({ ...plain, element: 'transaction' });
  });

  it('keeps the tag clear of the repeat clause loop variable', async () => {
    const block = subProcess(
      await ir(`process p { attempt B for each line in lines { step Q } }`),
      'B',
    );
    expect(block.element).toBe('transaction');
    expect(block.loop?.elementVariable).toBe('line');
  });

  it('tags each block by its own head when they nest', async () => {
    const result = await ir(
      `process p { attempt Outer { subprocess Inner { attempt Deep { } } } }`,
    );
    const outer = subProcess(result, 'Outer');
    const inner = subProcess(outer, 'Inner');
    expect(outer.element).toBe('transaction');
    expect('element' in inner).toBe(false);
    expect(subProcess(inner, 'Deep').element).toBe('transaction');
  });
});

describe('astToIr: call activity lowering', () => {
  it('lowers a minimal call into the parent chain with no optional fields', async () => {
    const result = await ir(`process p { call F { process = "fulfilment" } }`);

    const startId = makeStartEventId('p', new Set());
    const endId = makeEndEventId('p', new Set());
    expect(flow(result, startId, 'F')).toBeDefined();
    expect(flow(result, 'F', endId)).toBeDefined();

    const call = only(result, 'callActivity');
    expect(call).toEqual(callActivity('F', 'fulfilment'));
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

  /** The binding a `call X` carrying the given extra member lowers to. */
  const callBinding = async (member: string) =>
    only(
      await ir(`process p { call X { process = "p" ${member} } }`),
      'callActivity',
    ).binding;

  it.each([
    ['version = 3', { kind: 'version', version: '3' }],
    ['version = 1.5', { kind: 'version', version: '1.5' }],
    ['version = "1.0-GA"', { kind: 'version', version: '1.0-GA' }],
    ['version = "${v}"', { kind: 'version', version: '${v}' }],
    ['binding = latest', { kind: 'latest' }],
    // `version` is read first, so it wins the contradiction the validator flags.
    ['binding = deployment version = 2', { kind: 'version', version: '2' }],
    // Neither `latest` nor `deployment` resolves to a strategy, so none is stored.
    ['binding = weekly', undefined],
    ['', undefined],
  ])('reads `%s` as its version binding', async (member, expected) => {
    expect(await callBinding(member)).toEqual(expected);
  });

  it('stays total on an empty body, calledElement falling back to the empty string', async () => {
    const empty = await ir(`process p { call X { } }`);
    expect(only(empty, 'callActivity').calledElement).toBe('');
  });

  it('maps the label to name and resolves a goto elsewhere to the call node', async () => {
    const result = await ir(
      `process p { user A goto F call F "Fulfil order" { process = "p" } }`,
    );
    const call = only(result, 'callActivity');
    expect(call.name).toBe('Fulfil order');
    expect(flow(result, 'A', 'F').targetRef).toBe('F');
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

describe('astToIr: on-handler lowering', () => {
  it('lowers a handler outside the sequence chain (flows go around it)', async () => {
    const result = await afterA(
      'on error "PF" { service R { class = "x.R" } }',
    );
    const handlerId = makeEventSubProcessId('p_1');
    const startId = makeStartEventId(handlerId, new Set());
    const endId = makeEndEventId(handlerId, new Set());

    expect(subProcess(result, handlerId)).toEqual({
      kind: 'subProcess',
      id: handlerId,
      triggeredByEvent: true,
      flowElements: [
        { kind: 'startEvent', id: startId, eventDefinition: errorDef('PF') },
        serviceTask('R', classBinding('x.R')),
        { kind: 'endEvent', id: endId },
      ],
      sequenceFlows: [edge(startId, 'R'), edge('R', endId)],
    });

    expect(flow(result, 'StartEvent_p', 'A')).toBeDefined();
    expect(flow(result, 'A', 'EndEvent_p')).toBeDefined();
    for (const f of result.sequenceFlows) {
      expect(f.sourceRef).not.toBe(handlerId);
      expect(f.targetRef).not.toBe(handlerId);
    }
  });

  it.each([
    ['on error "PF"', errorDef('PF')],
    ['on compensation', { kind: 'compensation' }],
  ])(
    'honors an explicit start in an `%s` handler as the trigger-carrying start',
    async (head, expected) => {
      const result = await ir(
        `process p { ${head} { start In "Caught" service R { class = "x.R" } } }`,
      );
      const handler = subProcess(result, makeEventSubProcessId('p_0'));
      // No start event is synthesized: the explicit start is the trigger start.
      expect(handler.flowElements.map((fe) => fe.id)).not.toContain(
        makeStartEventId(makeEventSubProcessId('p_0'), new Set()),
      );
      const start = only(handler, 'startEvent');
      expect(start.id).toBe('In');
      expect(start.name).toBe('Caught');
      expect(start.eventDefinition).toEqual(expected);
    },
  );

  it('roots the handler body coordinate at its own structural coordinate', async () => {
    // Handler at process index 2, `if` at handler-body index 1 -> coord p_2_1.
    const result = await afterA(
      `        service B { class = "x.B" }
        on error "PF" {
          service X { class = "x.X" }
          if (c) { service Y { class = "x.Y" } }
        }
      `,
    );
    const handler = subProcess(result, makeEventSubProcessId('p_2'));
    const gatewayIds = xorGatewayIds(handler);
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

  it.each([
    ['on error "PF"', errorDef('PF')],
    ['on compensation', { kind: 'compensation' }],
  ])(
    'synthesizes start(def) -> flow -> end for an empty `%s` body',
    async (head, expected) => {
      const result = await ir(`process p { ${head} { } }`);
      const handlerId = makeEventSubProcessId('p_0');
      const startId = makeStartEventId(handlerId, new Set());
      const endId = makeEndEventId(handlerId, new Set());

      expect(subProcess(result, handlerId)).toEqual({
        kind: 'subProcess',
        id: handlerId,
        triggeredByEvent: true,
        flowElements: [
          { kind: 'startEvent', id: startId, eventDefinition: expected },
          { kind: 'endEvent', id: endId },
        ],
        sequenceFlows: [edge(startId, endId)],
      });
    },
  );
});

describe('astToIr: on-handler triggers', () => {
  // Every handler lowers, whatever it carries: a field with nowhere to go is
  // dropped, a missing code catches all, and a word the position does not
  // admit falls back to the error kind its validator message speaks of.
  it.each([
    [
      'on error "PF" (code c, message m)',
      errorDef('PF', { codeVariable: 'c', messageVariable: 'm' }),
    ],
    ['on error', errorDef()],
    ['on error ""', errorDef('')],
    ['on error "X" (coed c)', errorDef('X')],
    ['on escalation "LS" (code v)', escalationDef('LS', 'v')],
    ['on message "PaymentReceived"', messageDef('PaymentReceived')],
    ['on message', messageDef('')],
    ['on message "X" (code c)', messageDef('X')],
    ['on signal "X"', signalDef('X')],
    ['on timer after "PT1H"', timerDef('duration', 'PT1H')],
    [
      'on timer at "2024-01-01T00:00:00Z"',
      timerDef('date', '2024-01-01T00:00:00Z'),
    ],
    ['on timer every "R/PT1H"', timerDef('cycle', 'R/PT1H')],
    ['on timer after "${dueDate}"', timerDef('duration', '${dueDate}')],
    ['on timer', timerDef('duration', '')],
    ['on timer "PT1H"', timerDef('duration', 'PT1H')],
    ['on condition (amount > 100)', conditionDef('${amount > 100}')],
    ['on condition ("${bean.check()}")', conditionDef('${bean.check()}')],
    ['on condition', conditionDef('${true}')],
    ['on compensation "X" (code c)', { kind: 'compensation' }],
    ['on banana "X"', errorDef('X')],
    ['on banana every "x"', errorDef()],
  ])('lowers `%s { }` to %j', async (head, expected) => {
    expect(
      handlerStart(await ir(`process p { ${head} { } }`), 'p_0')
        .eventDefinition,
    ).toEqual(expected);
  });

  it.each([
    ['on escalation "LS" alongside', escalationDef('LS')],
    ['on signal "X" alongside', signalDef('X')],
    ['on compensation "X" (code c) alongside', { kind: 'compensation' }],
  ])(
    '`%s` marks the trigger start non-interrupting',
    async (head, expected) => {
      const start = handlerStart(await ir(`process p { ${head} { } }`), 'p_0');
      expect(start.eventDefinition).toEqual(expected);
      expect(start.isInterrupting).toBe(false);
    },
  );
});

describe('astToIr: hosted-handler lowering', () => {
  it('emits a boundary event attached to the host, with the body inline in the same container', async () => {
    const result = await afterA(
      'on A: error "PF" { service R { class = "x.R" } }',
    );

    const boundaryId = makeBoundaryEventId('A', 'error', new Set());
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.id).toBe(boundaryId);
    expect(boundary.attachedToRef).toBe('A');
    expect(boundary.eventDefinition).toEqual(errorDef('PF'));
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
    const result = await afterA(
      'on A: timer after "PT2H" alongside { service R { class = "x.R" } }',
    );
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.id).toBe(makeBoundaryEventId('A', 'timer', new Set()));
    expect(boundary.cancelActivity).toBe(false);
    expect(boundary.eventDefinition).toEqual(timerDef('duration', 'PT2H'));
  });

  it('lowers a cancel handler on a block to a cancel event definition', async () => {
    const result = await ir(
      `process p { start S attempt B { user A end X cancel } on B: cancel { user H } end E }`,
    );
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.id).toBe(makeBoundaryEventId('B', 'cancel', new Set()));
    expect(boundary.attachedToRef).toBe('B');
    expect(boundary.eventDefinition).toEqual({ kind: 'cancel' });
  });

  it('resolves a goto out of the body onto a main-flow node as a real flow', async () => {
    const result = await afterA(
      `        service B { class = "x.B" }
        on A: error "PF" {
          service R { class = "x.R" }
          goto B
        }
      `,
    );
    const boundaryId = makeBoundaryEventId('A', 'error', new Set());
    expect(flow(result, boundaryId, 'R')).toBeDefined();
    expect(flow(result, 'R', 'B')).toBeDefined();
    // The chain transferred control, so no implicit end terminates it.
    expect(result.flowElements.map((fe) => fe.id)).not.toContain(
      makeEndEventId(boundaryId, new Set()),
    );
  });

  it('still yields boundary -> end for an empty body', async () => {
    const result = await afterA('on A: error "PF" { }');
    const boundaryId = makeBoundaryEventId('A', 'error', new Set());
    const endId = makeEndEventId(boundaryId, new Set());
    expect(flow(result, boundaryId, endId)).toBeDefined();
    expect(byId(result, endId).kind).toBe('endEvent');
  });

  it('suffixes the second boundary id when two handlers share a host and trigger', async () => {
    const result = await afterA(
      `        on A: timer after "PT1H" { service R { class = "x.R" } }
        on A: timer after "PT2H" { service S { class = "x.S" } }
      `,
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
    const result = await afterA(
      `        on A: error "PF" { service R { class = "x.R" } }
        on escalation "LS" { service E { class = "x.E" } }
      `,
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
    expect(only(handler, 'startEvent').eventDefinition).toEqual(
      escalationDef('LS'),
    );
    for (const f of result.sequenceFlows) {
      expect(f.sourceRef).not.toBe(handlerId);
      expect(f.targetRef).not.toBe(handlerId);
    }
    expect(byId(result, 'R')).toBeDefined();
  });

  it('lifts a host-less handler written inside a hosted body into the outer container', async () => {
    const result = await afterA(
      `        on A: error "PF" {
          service R { class = "x.R" }
          on escalation "LS" { service E { class = "x.E" } }
        }
      `,
    );
    // A hosted handler's body is not a scope of its own, so a host-less handler
    // written inside it guards the whole enclosing container. The event
    // sub-process lands beside the process body, not in the escape chain.
    const handler = result.flowElements.find(
      (fe): fe is SubProcess =>
        fe.kind === 'subProcess' && fe.triggeredByEvent === true,
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
    const result = await afterA(
      'on Missing: timer after "PT1H" { service R { class = "x.R" } }',
    );
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.attachedToRef).toBe('Missing');
    expect(boundary.id).toBe('Boundary_Missing_timer');
    expect(
      result.flowElements.filter((fe) => fe.kind === 'subProcess'),
    ).toEqual([]);
  });
});

/** `A -> <statement> -> B`, the chain a throw or an emit is written into. */
const throwChain = (statement: string): Promise<BpmnProcess> =>
  afterA(
    `        ${statement}
        service B { class = "x.B" }
    `,
  );

describe('astToIr: throw/emit lowering', () => {
  // The id is the authored name where one is written, else the positional one.
  // A word the position does not admit still lowers: to `error` for a throw,
  // and to `escalation` for an emit, BPMN having no intermediate error throw.
  it.each([
    ['throw error "PF"', makeThrowEventId('p_1'), errorDef('PF')],
    ['throw error', makeThrowEventId('p_1'), errorDef()],
    ['throw signal "S"', makeThrowEventId('p_1'), signalDef('S')],
    ['throw escalation Failed "X"', 'Failed', escalationDef('X')],
    ['throw message Sent "Ack"', 'Sent', messageDef('Ack')],
    ['throw compensation', makeThrowEventId('p_1'), { kind: 'compensation' }],
    [
      'throw compensation "X"',
      makeThrowEventId('p_1'),
      { kind: 'compensation' },
    ],
    ['throw banana "X"', makeThrowEventId('p_1'), errorDef('X')],
    ['throw timer "X"', makeThrowEventId('p_1'), errorDef('X')],
  ])(
    'lowers `%s` to a typed end event with no fall-through',
    async (statement, throwId, expected) => {
      const result = await throwChain(statement);
      expect(byId(result, throwId).kind).toBe('endEvent');
      expect(definitionOf(result, throwId)).toEqual(expected);
      expect(flow(result, 'A', throwId)).toBeDefined();
      expect(result.sequenceFlows.some((f) => f.sourceRef === throwId)).toBe(
        false,
      );
      // B is still lowered as a possible jump target, but the throw is terminal.
      expect(byId(result, 'B')).toBeDefined();
    },
  );

  it.each([
    ['emit escalation "LS"', makeThrowEventId('p_1'), escalationDef('LS')],
    ['emit signal Ping "S"', 'Ping', signalDef('S')],
    ['emit signal', makeThrowEventId('p_1'), signalDef('')],
    ['emit message "X"', makeThrowEventId('p_1'), messageDef('X')],
    ['emit compensation Undo', 'Undo', { kind: 'compensation' }],
    ['emit error "X"', makeThrowEventId('p_1'), escalationDef('X')],
    ['emit banana "X"', makeThrowEventId('p_1'), escalationDef('X')],
  ])(
    'lowers `%s` to an intermediate throw wired into the chain',
    async (statement, emitId, expected) => {
      const result = await throwChain(statement);
      expect(byId(result, emitId).kind).toBe('intermediateThrowEvent');
      expect(definitionOf(result, emitId)).toEqual(expected);
      expect(flow(result, 'A', emitId)).toBeDefined();
      expect(flow(result, emitId, 'B')).toBeDefined();
    },
  );

  it('lowers the implementation a thrown or emitted message carries', async () => {
    const thrown = await ir(
      `process p { throw message Sent "Ack" { class = "com.example.Send" } }`,
    );
    expect(bindingOf(thrown, 'Sent')).toEqual(classBinding('com.example.Send'));

    const emitted = await ir(
      `process p { emit message Ping "Ack" { topic = "send-ack" } }`,
    );
    expect(bindingOf(emitted, 'Ping')).toEqual(externalBinding('send-ack'));
  });

  it('lowers a message throw with no implementation with no binding key', async () => {
    const result = await ir(`process p { throw message Sent "Ack" }`);
    expect(Object.keys(byId(result, 'Sent'))).not.toContain('binding');
  });
});

describe('astToIr: error-message declarations', () => {
  it.each([
    [
      'collects declarations in source order',
      'error "PF" message "boom" error "LS" message "low"',
      [
        { code: 'PF', message: 'boom' },
        { code: 'LS', message: 'low' },
      ],
    ],
    [
      'keeps the first declaration of a duplicated code',
      'error "PF" message "first" error "PF" message "second"',
      [{ code: 'PF', message: 'first' }],
    ],
    ['omits the key entirely when none is declared', '', undefined],
  ])('%s', async (_title, decls, expected) => {
    const result = await ir(
      `process p { ${decls} service A { class = "x.A" } }`,
    );
    expect(result.errorMessages).toEqual(expected);
  });
});

describe('astToIr: handler totality', () => {
  it('keeps the chain intact around a mid-body handler', async () => {
    const result = await afterA(
      `        on error "X" { service R { class = "x.R" } }
        service B { class = "x.B" }
      `,
    );
    expect(flow(result, 'A', 'B')).toBeDefined();
    const handlerId = makeEventSubProcessId('p_1');
    for (const f of result.sequenceFlows) {
      expect(f.sourceRef).not.toBe(handlerId);
      expect(f.targetRef).not.toBe(handlerId);
    }
  });
});

describe('astToIr: new-trigger composition (nested coordinates)', () => {
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
    const start = handlerStart(sub, 'p_0_1');
    expect(start.eventDefinition).toEqual(timerDef('duration', 'PT1H'));
  });

  it('an on-condition handler containing an if nests gateway coordinates under its own handler id', async () => {
    const result = await ir(
      'process p { on condition (amount > 100) { service X { class = "x.X" } if (c) { service Y { class = "x.Y" } } } }',
    );
    const handler = subProcess(result, makeEventSubProcessId('p_0'));
    const gatewayIds = xorGatewayIds(handler);
    expect(gatewayIds).toContain(makeGatewaySplitId('p_0_1'));
    expect(gatewayIds).toContain(makeGatewayJoinId('p_0_1'));
    const start = only(handler, 'startEvent');
    expect(start.eventDefinition).toEqual(conditionDef('${amount > 100}'));
  });
});

describe('astToIr: compensation handler lowering', () => {
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
});

describe('astToIr: compensation throw/emit lowering', () => {
  it('lowers `emit compensation` normally inside an on-error handler body and inside an on-compensation body', async () => {
    const inErrorHandler = await ir(
      `process p { on error "PF" { emit compensation } }`,
    );
    const errorHandler = subProcess(
      inErrorHandler,
      makeEventSubProcessId('p_0'),
    );
    const emitId = makeThrowEventId('p_0_0');
    expect(byId(errorHandler, emitId).kind).toBe('intermediateThrowEvent');
    expect(definitionOf(errorHandler, emitId)).toEqual({
      kind: 'compensation',
    });

    const inCompensationHandler = await ir(
      `process p { on compensation { emit compensation } }`,
    );
    const compHandler = subProcess(
      inCompensationHandler,
      makeEventSubProcessId('p_0'),
    );
    expect(byId(compHandler, emitId).kind).toBe('intermediateThrowEvent');
    expect(definitionOf(compHandler, emitId)).toEqual({ kind: 'compensation' });
  });
});

describe('astToIr: compensation coordinate composition', () => {
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
    const gatewayIds = xorGatewayIds(sub);
    expect(gatewayIds).toContain(makeGatewaySplitId('p_0_0'));
    expect(gatewayIds).toContain(makeGatewayJoinId('p_0_0'));

    // The compensation handler at S-body index 1 is EventSubProcess_p_0_1.
    const start = handlerStart(sub, 'p_0_1');
    expect(start.eventDefinition).toEqual({ kind: 'compensation' });
  });
});

describe('astToIr: await intermediate catch lowering', () => {
  it('lowers `await message` to an intermediate catch wired into the chain', async () => {
    const result = await throwChain('await message "M"');
    const catchId = makeIntermediateCatchEventId('p_1');
    expect(byId(result, catchId).kind).toBe('intermediateCatchEvent');
    expect(definitionOf(result, catchId)).toEqual(messageDef('M'));
    expect(flow(result, 'A', catchId)).toBeDefined();
    expect(flow(result, catchId, 'B')).toBeDefined();
  });

  // Each timer particle maps to its BPMN timerKind with the expression carried
  // verbatim; a condition renders through renderExpression, same as an `if`.
  it.each([
    [`process p { await timer after "PT1H" }`, timerDef('duration', 'PT1H')],
    [
      `process p { await timer at "2024-01-01T00:00:00Z" }`,
      timerDef('date', '2024-01-01T00:00:00Z'),
    ],
    [`process p { await timer every "R/PT1H" }`, timerDef('cycle', 'R/PT1H')],
    [`process p { await signal "S" }`, signalDef('S')],
    [
      `process p { await condition (amount > 100) }`,
      conditionDef('${amount > 100}'),
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

describe('astToIr: engine attributes (asyncBefore/asyncAfter/exclusive/jobPriority/retryCycle)', () => {
  const ENGINE_MEMBERS =
    'asyncBefore = true asyncAfter = true exclusive = false jobPriority = 50 retryCycle = "PT5M"';
  const ENGINE_BLOCK = `{ ${ENGINE_MEMBERS} }`;
  const SET = {
    asyncBefore: true,
    asyncAfter: true,
    exclusive: false,
    jobPriority: '50',
    retryCycle: 'PT5M',
  };
  const UNSET: Partial<typeof SET> = {
    asyncBefore: undefined,
    asyncAfter: undefined,
    exclusive: undefined,
    jobPriority: undefined,
    retryCycle: undefined,
  };

  /** The five engine fields of a node, whether or not it carries any. */
  const engineFields = (fe: FlowElement): Partial<typeof SET> => {
    const { asyncBefore, asyncAfter, exclusive, jobPriority, retryCycle } =
      fe as Partial<typeof SET>;
    return { asyncBefore, asyncAfter, exclusive, jobPriority, retryCycle };
  };

  /** Every flow element of a process, keyed by id, as its engine fields. */
  const engineFieldsById = (
    process: BpmnProcess,
  ): Record<string, Partial<typeof SET>> =>
    Object.fromEntries(
      process.flowElements.map((fe) => [fe.id, engineFields(fe)]),
    );

  it('every statement kind that takes a block reads all five fields off it', async () => {
    const result = await ir(
      [
        'process p {',
        `  start S ${ENGINE_BLOCK}`,
        `  user T ${ENGINE_BLOCK}`,
        `  service Sv { class = "x.S" ${ENGINE_MEMBERS} }`,
        `  script Sc { ${ENGINE_MEMBERS} } \`\`\`js\nx = 1;\n\`\`\``,
        `  subprocess Sub ${ENGINE_BLOCK} { }`,
        `  call C { process = "other" ${ENGINE_MEMBERS} }`,
        `  emit escalation "X" ${ENGINE_BLOCK}`,
        `  await message "M" ${ENGINE_BLOCK}`,
        `  end E ${ENGINE_BLOCK}`,
        '}',
      ].join('\n'),
    );
    expect(engineFieldsById(result)).toEqual({
      S: SET,
      T: SET,
      Sv: SET,
      Sc: SET,
      Sub: SET,
      C: SET,
      [makeThrowEventId('p_6')]: SET,
      [makeIntermediateCatchEventId('p_7')]: SET,
      E: SET,
    });

    // A `throw` is a typed end event, so it cannot share a body with `end`.
    const thrown = await ir(`process p { throw error "X" ${ENGINE_BLOCK} }`);
    expect(byId(thrown, makeThrowEventId('p_0'))).toMatchObject(SET);
  });

  it('reads nothing off a block that declares no engine attribute', async () => {
    const result = await ir('process p { user T }');
    expect(engineFields(only(result, 'userTask'))).toEqual(UNSET);
  });
});

describe('astToIr: an unauthored optional field is absent, never empty', () => {
  it('writes no assignment attribute, no parameter list, no listener list, no resultVariable', async () => {
    const result = await ir(
      'process p { user T service Sv { class = "x.S" } script Sc { } ```js\nx = 1;\n``` }',
    );
    expect(only(result, 'userTask')).toEqual({ kind: 'userTask', id: 'T' });
    expect(only(result, 'serviceTask')).toEqual(
      serviceTask('Sv', classBinding('x.S')),
    );
    expect(only(result, 'scriptTask')).toEqual(
      scriptTask('Sc', 'javascript', 'x = 1;\n'),
    );
  });
});

describe('astToIr: boolean engine flags store only their non-default value', () => {
  it.each([
    ['asyncBefore', true],
    ['asyncAfter', true],
    ['exclusive', false],
  ] as const)(
    '%s stores %s and stores nothing for the engine default',
    async (field, nonDefault) => {
      const stored = await ir(
        `process p { service S { class = "x" ${field} = ${String(nonDefault)} } }`,
      );
      expect(only(stored, 'serviceTask')[field]).toBe(nonDefault);

      const omitted = await ir(
        `process p { service S { class = "x" ${field} = ${String(!nonDefault)} } }`,
      );
      expect(only(omitted, 'serviceTask')[field]).toBeUndefined();
    },
  );
});

describe('astToIr: jobPriority/priority numeric-or-EL reading', () => {
  it('reads an int literal, a string literal and a ${...} template as bare text', async () => {
    const jobPriority = async (written: string) =>
      only(
        await ir(
          `process p { service S { class = "x" jobPriority = ${written} } }`,
        ),
        'serviceTask',
      ).jobPriority;

    expect(await jobPriority('50')).toBe('50');
    expect(await jobPriority('"7"')).toBe('7');
    expect(await jobPriority('"${priority}"')).toBe('${priority}');

    // A user task priority is the same reading on another field name.
    const task = await ir('process p { user T { priority = 20 } }');
    expect(only(task, 'userTask').priority).toBe('20');
  });
});

describe('astToIr: user task assignment attributes', () => {
  it('maps candidateGroups/candidateUsers/dueDate/followUpDate/priority verbatim', async () => {
    const result = await ir(
      `process p { user T {
        candidateGroups = "sales,support"
        candidateUsers = "alice,bob"
        dueDate = "2024-01-01T00:00:00Z"
        followUpDate = "2024-01-02T00:00:00Z"
        priority = 50
      } }`,
    );
    expect(only(result, 'userTask')).toEqual({
      kind: 'userTask',
      id: 'T',
      candidateGroups: 'sales,support',
      candidateUsers: 'alice,bob',
      dueDate: '2024-01-01T00:00:00Z',
      followUpDate: '2024-01-02T00:00:00Z',
      priority: '50',
    });
  });
});

describe('astToIr: resultVariable on service/script tasks', () => {
  it('maps a resultVariable on both the service task and the script task', async () => {
    const result = await ir(
      'process p { service Sv { class = "x.S" resultVariable = "outcome" } script Sc { resultVariable = "total" } ```js\nx = 1;\n``` }',
    );
    expect(only(result, 'serviceTask').resultVariable).toBe('outcome');
    expect(only(result, 'scriptTask').resultVariable).toBe('total');
  });
});

describe('astToIr: engine attributes on `on` handlers, placed by host slot', () => {
  it("places a host-less handler's engine attributes on the event sub-process node, never on its trigger start event", async () => {
    const result = await afterA(
      'on error "PF" { asyncBefore = true jobPriority = 50 } { service R { class = "x.R" } }',
    );
    const handler = subProcess(result, makeEventSubProcessId('p_1'));
    expect(handler.asyncBefore).toBe(true);
    expect(handler.jobPriority).toBe('50');

    const start = only(handler, 'startEvent');
    expect(start.asyncBefore).toBeUndefined();
    expect(start.jobPriority).toBeUndefined();
  });

  it('places a hosted handler engine attributes on the boundary event', async () => {
    const result = await afterA(
      'on A: error "PF" { asyncBefore = true jobPriority = 50 } { service R { class = "x.R" } }',
    );
    const boundary = only(result, 'boundaryEvent');
    expect(boundary.asyncBefore).toBe(true);
    expect(boundary.jobPriority).toBe('50');
  });

  // A host-less handler lowers to an event sub-process, which carries
  // `operaton:inputOutput` the way any sub-process does. Reachable on import
  // too: `mapEventSubProcess` reads the mapping, so dropping it here would
  // break the round trip in silence.
  it('carries a host-less handler io parameters onto the event sub-process node', async () => {
    const result = await afterA(
      'on error "PF" { input reason = "boom" output code = "c" } { service R { class = "x.R" } }',
    );
    const handler = subProcess(result, makeEventSubProcessId('p_1'));
    expect(handler.inputParameters).toEqual([
      ioParam('reason', textValue('boom')),
    ]);
    expect(handler.outputParameters).toEqual([ioParam('code', textValue('c'))]);

    const start = only(handler, 'startEvent');
    expect(start).not.toHaveProperty('inputParameters');
  });
});

describe('astToIr: input/output parameter value forms', () => {
  /** The single input parameter of the process's only user task. */
  async function firstInput(source: string) {
    const result = await ir(source);
    const params = only(result, 'userTask').inputParameters;
    expect(params).toHaveLength(1);
    return params![0]!;
  }

  // The two nested forms (a map inside a list, a list inside a map) are pinned
  // end to end by `tests/input-output.round-trip.test.ts`.
  it.each([
    {
      form: 'a string literal as text carrying its bare value',
      written: '"hello"',
      value: textValue('hello'),
    },
    {
      form: 'a ${...} template body verbatim as text',
      written: '"${amount}"',
      value: textValue('${amount}'),
    },
    {
      form: 'a dotted bareword as its plain path, stripping the ${...} wrapper',
      written: 'com.example.X',
      value: textValue('com.example.X'),
    },
    {
      form: 'a fenced script as its normalized format and inner code',
      written: '```js\nreturn 1;\n```',
      value: scriptValue('javascript', 'return 1;\n'),
    },
    {
      form: 'a list literal item by item, in source order',
      written: '["x", "y"]',
      value: listValue([textValue('x'), textValue('y')]),
    },
    {
      form: 'an empty list literal as an empty item list',
      written: '[]',
      value: listValue([]),
    },
    {
      form: 'a map literal, taking a quoted key as bare text',
      written: '{ k: "v", "with space": "w" }',
      value: mapValue([
        mapEntry('k', textValue('v')),
        mapEntry('with space', textValue('w')),
      ]),
    },
  ] satisfies Array<{ form: string; written: string; value: IoValue }>)(
    'lowers $form',
    async ({ written, value }) => {
      expect(
        await firstInput(`process p { user T { input a = ${written} } }`),
      ).toEqual({ name: 'a', value });
    },
  );
});

describe('astToIr: input/output parameter partition and ordering', () => {
  it('partitions by direction, preserving each direction relative source order', async () => {
    const result = await ir(
      `process p { user T {
        input a = "1"
        output x = "2"
        input b = "3"
        output y = "4"
      } }`,
    );
    const task = only(result, 'userTask');
    expect(task.inputParameters?.map((param) => param.name)).toEqual([
      'a',
      'b',
    ]);
    expect(task.outputParameters?.map((param) => param.name)).toEqual([
      'x',
      'y',
    ]);
  });

  it('reaches every activity kind, and a call activity keeps its variable mappings too', async () => {
    const result = await ir(
      `process p {
        service Sv { class = "x.S" input a = "1" output b = "2" }
        script Sc { input a = "1" } \`\`\`js\nx = 1;\n\`\`\`
        subprocess Sub { input a = "1" } { }
        call C { process = "sub" in orderId input a = "1" }
      }`,
    );
    const inputA = [ioParam('a', textValue('1'))];
    const service = only(result, 'serviceTask');
    expect(service.inputParameters).toEqual(inputA);
    expect(service.outputParameters).toEqual([ioParam('b', textValue('2'))]);
    expect(only(result, 'scriptTask').inputParameters).toEqual(inputA);
    expect(subProcess(result, 'Sub').inputParameters).toEqual(inputA);

    const call = only(result, 'callActivity');
    expect(call.inputParameters).toEqual(inputA);
    expect(call.inMappings).toEqual([
      { kind: 'variable', source: 'orderId', target: 'orderId' },
    ]);
  });

  it('drops a parameter written on an element that carries none', async () => {
    const result = await ir('process p { start S { input a = "1" } }');
    expect(Object.keys(only(result, 'startEvent'))).not.toContain(
      'inputParameters',
    );
  });
});

describe('astToIr: execution listeners', () => {
  /** The single execution listener of the process's only service task. */
  async function firstListener(source: string) {
    const result = await ir(source);
    const listeners = only(result, 'serviceTask').executionListeners;
    expect(listeners).toHaveLength(1);
    return listeners![0]!;
  }

  it.each([
    {
      form: 'a class binding, stripping the ${...} wrapper off a dotted path',
      written: 'on start { class = com.example.L }',
      listener: { event: 'start', binding: classBinding('com.example.L') },
    },
    {
      form: 'an expression binding, ${...} wrapper verbatim',
      written: 'on end { expression = "${bean.run(execution)}" }',
      listener: {
        event: 'end',
        binding: exprBinding('${bean.run(execution)}'),
      },
    },
    {
      form: 'delegate as a delegateExpression binding, wrapping a bareword',
      written: 'on end { delegate = auditBean }',
      listener: { event: 'end', binding: delegateBinding('${auditBean}') },
    },
    {
      form: 'a fenced body as a script binding with a normalized format',
      written: 'on end ```js\nx = 1;\n```',
      listener: {
        event: 'end',
        binding: scriptValue('javascript', 'x = 1;\n'),
      },
    },
    {
      form: 'an empty class binding when the block names none',
      written: 'on start { }',
      listener: { event: 'start', binding: classBinding('') },
    },
  ] satisfies Array<{
    form: string;
    written: string;
    listener: ExecutionListener;
  }>)('reads $form', async ({ written, listener }) => {
    expect(
      await firstListener(
        `process p { service S { class = "x.S" ${written} } }`,
      ),
    ).toEqual(listener);
  });

  it('keeps several listeners in source order', async () => {
    const result = await ir(
      'process p { service S { class = "x.S" on end { class = "x.B" } on start { class = "x.A" } } }',
    );
    expect(
      only(result, 'serviceTask').executionListeners?.map(
        (listener) => listener.event,
      ),
    ).toEqual(['end', 'start']);
  });

  it('reaches every event and activity kind that takes a block', async () => {
    const result = await ir(
      `process p {
        start S { on end { class = "x.L" } }
        call C { process = "sub" on end { class = "x.L" } }
        emit escalation "X" { on end { class = "x.L" } }
        await message "M" { on end { class = "x.L" } }
      }`,
    );
    const listenersById = Object.fromEntries(
      result.flowElements.map((fe) => [
        fe.id,
        (fe as { executionListeners?: unknown }).executionListeners,
      ]),
    );
    const onEnd = [{ event: 'end', binding: classBinding('x.L') }];
    expect(listenersById).toMatchObject({
      S: onEnd,
      C: onEnd,
      [makeThrowEventId('p_2')]: onEnd,
      [makeIntermediateCatchEventId('p_3')]: onEnd,
    });
  });

  it('places a host-less handler listener on the event sub-process, not its trigger start', async () => {
    const result = await afterA(
      'on error "PF" { on start { class = "x.L" } } { service R { class = "x.R" } }',
    );
    const handler = subProcess(result, makeEventSubProcessId('p_1'));
    expect(handler.executionListeners).toEqual([
      { event: 'start', binding: classBinding('x.L') },
    ]);
    expect(only(handler, 'startEvent').executionListeners).toBeUndefined();
  });

  it('places a hosted handler listener on the boundary event', async () => {
    const result = await afterA(
      'on A: error "PF" { on start { class = "x.L" } } { service R { class = "x.R" } }',
    );
    expect(only(result, 'boundaryEvent').executionListeners).toEqual([
      { event: 'start', binding: classBinding('x.L') },
    ]);
  });
});

describe('astToIr: task listeners', () => {
  it('splits the task lifecycle events off the execution listeners', async () => {
    const result = await ir(
      `process p { user T {
        on start { class = "x.S" }
        on create { class = "x.C" }
        on assign { class = "x.A" }
        on end { class = "x.E" }
        on complete { class = "x.K" }
        on update { class = "x.U" }
        on delete { class = "x.D" }
      } }`,
    );
    const task = only(result, 'userTask');
    expect(task.executionListeners?.map((l) => l.event)).toEqual([
      'start',
      'end',
    ]);
    expect(task.taskListeners?.map((l) => l.event)).toEqual([
      'create',
      'assign',
      'complete',
      'update',
      'delete',
    ]);
  });

  it('reads every binding form the execution listeners read', async () => {
    const result = await ir(
      'process p { user T { on create { expression = "${bean.run()}" } on assign ```groovy\nx = 1\n``` } }',
    );
    expect(only(result, 'userTask').taskListeners).toEqual([
      { event: 'create', binding: exprBinding('${bean.run()}') },
      { event: 'assign', binding: scriptValue('groovy', 'x = 1\n') },
    ]);
  });

  it.each([
    ['after "PT1H"', timerDef('duration', 'PT1H')],
    ['at "2024-01-01T00:00:00Z"', timerDef('date', '2024-01-01T00:00:00Z')],
    ['every "R3/PT1H"', timerDef('cycle', 'R3/PT1H')],
  ])(
    'carries the `%s` clause of a timeout listener as its timer',
    async (clause, timer) => {
      const result = await ir(
        `process p { user T { on timeout ${clause} { class = "x.T" } } }`,
      );
      expect(only(result, 'userTask').taskListeners).toEqual([
        { event: 'timeout', binding: classBinding('x.T'), timer },
      ]);
    },
  );

  it('omits the timer on a non-timeout task listener', async () => {
    const result = await ir(
      'process p { user T { on create { class = "x.C" } } }',
    );
    expect(only(result, 'userTask').taskListeners?.[0]?.timer).toBeUndefined();
  });

  it('omits the list when the block declares no task listener', async () => {
    const result = await ir(
      'process p { user T { on start { class = "x" } } }',
    );
    expect(only(result, 'userTask').taskListeners).toBeUndefined();
  });

  it.each([
    [
      'a task lifecycle event on an element that has none',
      'service S { class = "x.S" on create { class = "x.C" } }',
      'S',
    ],
    [
      'a listener whose event word is neither lifecycle',
      'user T { on nonsense { class = "x" } }',
      'T',
    ],
  ])('drops %s, leaving both lists out', async (_title, statement, id) => {
    const el = byId(await ir(`process p { ${statement} }`), id);
    expect(Object.keys(el)).not.toContain('executionListeners');
    expect(Object.keys(el)).not.toContain('taskListeners');
  });
});

describe('astToIr: start/end triggers and message throw/emit', () => {
  it.each([
    [`start S message "OrderReceived"`, messageDef('OrderReceived')],
    [`start S signal "Fired"`, signalDef('Fired')],
    [`start S timer after "PT1H"`, timerDef('duration', 'PT1H')],
    [
      `start S timer at "2026-08-01T09:00:00"`,
      timerDef('date', '2026-08-01T09:00:00'),
    ],
    [`start S timer every "R/PT10M"`, timerDef('cycle', 'R/PT10M')],
  ])('lowers `%s` to its event definition', async (statement, expected) => {
    const result = await ir(`process p { ${statement} }`);
    expect(only(result, 'startEvent').eventDefinition).toEqual(expected);
  });

  it('keeps a start label beside its trigger', async () => {
    const result = await ir(`process p { start S "Scheduled" message "M" }`);
    const start = only(result, 'startEvent');
    expect(start.name).toBe('Scheduled');
    expect(start.eventDefinition).toEqual(messageDef('M'));
  });

  it.each([
    ['a plain start', `process p { start S user A end E }`, 'startEvent'],
    [
      'a start carrying a trigger the position does not admit',
      `process p { start S condition user A end E }`,
      'startEvent',
    ],
    ['a plain end', `process p { start S user A end E }`, 'endEvent'],
    [
      'an end carrying a trigger it does not take',
      `process p { start S user A end E escalation "Late" }`,
      'endEvent',
    ],
  ] as const)(
    'lowers %s with no eventDefinition key at all',
    async (_title, source, kind) => {
      expect(Object.keys(only(await ir(source), kind))).not.toContain(
        'eventDefinition',
      );
    },
  );

  it('keeps a terminate end label beside its definition', async () => {
    const result = await ir(
      `process p { start S user A end E "All stop" terminate }`,
    );
    const end = only(result, 'endEvent');
    expect(end.name).toBe('All stop');
    expect(end.eventDefinition).toEqual({ kind: 'terminate' });
  });

  it('lowers a cancel end to a cancel event definition, keeping its label', async () => {
    const block = subProcess(
      await ir(
        `process p { attempt B { end E "Give up the booking" cancel } }`,
      ),
      'B',
    );
    const end = only(block, 'endEvent');
    expect(end.name).toBe('Give up the booking');
    expect(end.eventDefinition).toEqual({ kind: 'cancel' });
  });

  it('keeps a start trigger alongside its form fields', async () => {
    const result = await ir(
      `process p { start S message "M" { form { amount: number } } }`,
    );
    const start = only(result, 'startEvent');
    expect(start.eventDefinition).toEqual(messageDef('M'));
    expect(start.formFields).toEqual([{ id: 'amount', type: 'number' }]);
  });
});

describe('astToIr: repeat clause', () => {
  /** The loop of the one activity a statement lowers to, named `X` throughout. */
  const loopOf = async (
    statement: string,
  ): Promise<LoopCharacteristics | undefined> =>
    (byId(await ir(`process P { ${statement} }`), 'X') as Repeatable).loop;

  it.each([
    [
      'for each line in lines',
      { collection: 'lines', elementVariable: 'line' },
    ],
    ['for each in lines', { collection: 'lines' }],
    [
      'for 2 each line in lines',
      { cardinality: '2', collection: 'lines', elementVariable: 'line' },
    ],
    ['for 2 sequentially', { cardinality: '2', sequential: true }],
    [
      'for 2 until (nrOfCompletedInstances >= 2)',
      {
        cardinality: '2',
        completionCondition: '${nrOfCompletedInstances >= 2}',
      },
    ],
  ])('lowers `%s` to %j and to no other key', async (clause, expected) => {
    expect(await loopOf(`user X ${clause}`)).toEqual(expected);
  });

  it('leaves out every key the clause did not write', async () => {
    expect(
      'elementVariable' in (await loopOf('user X for each in lines'))!,
    ).toBe(false);
    expect('sequential' in (await loopOf('user X for 2'))!).toBe(false);
    expect('loop' in byId(await ir('process P { user X }'), 'X')).toBe(false);
  });

  // A bare name and a quoted name both name a variable to Operaton; every other
  // spelling has to become an expression or it names a variable nobody declared.
  it.each([
    ['a bare name stays a name', 'for each line in lines', 'lines'],
    [
      'a quoted name stays a name',
      'for each line in "order.lines"',
      'order.lines',
    ],
    [
      'an accessor becomes an expression',
      'for each line in order.lines',
      '${order.lines}',
    ],
    [
      'a raw body stays an expression',
      'for each line in "${order.lines}"',
      '${order.lines}',
    ],
  ])('%s', async (_title, clause, collection) => {
    expect((await loopOf(`user X ${clause}`))?.collection).toBe(collection);
  });

  // Only a whole number prints bare again, so only a whole number may lower
  // bare: a decimal has no fixed point, and a quoted count is a JUEL string
  // literal rather than the plain text an attribute value would carry.
  it.each([
    ['a literal count emits its digits', 'for 3', '3'],
    ['a decimal is wrapped', 'for 3.5', '${3.5}'],
    ['a quoted count is wrapped', 'for "order.lines"', '${"order.lines"}'],
    ['a raw body emits its expression', 'for "${n}"', '${n}'],
    ['anything else is wrapped', 'for (n)', '${(n)}'],
  ])('%s', async (_title, clause, cardinality) => {
    expect((await loopOf(`user X ${clause}`))?.cardinality).toBe(cardinality);
  });

  it.each([
    ['user', 'user X for 2'],
    ['service', 'service X for 2 { class = "c" }'],
    ['script', 'script X for 2 ```js\nx = 1;\n```'],
    ['step', 'step X for 2'],
    ['send', 'send X for 2 { class = "c" }'],
    ['receive', 'receive X for 2'],
    ['decide', 'decide X for 2 { decision = "d" }'],
    ['subprocess', 'subprocess X for 2 { step Q }'],
    ['call', 'call X for 2 { process = "p" }'],
  ])('a repeated %s carries the loop into the IR', async (_kind, statement) => {
    expect(await loopOf(statement)).toEqual({ cardinality: '2' });
  });
});

describe('astToIr: conditioned parallel branches', () => {
  const forkId = makeGatewayForkId('P_0');
  const joinId = makeGatewayJoinId('P_0');
  const defaultFlowId = makeDefaultFlowId(forkId);

  // The element is picked by one predicate, a condition on any branch, so an
  // `else` on its own still lowers to the AND split the braces already say.
  it.each([
    ['no branch head', `process P { parallel { { user A } { user B } } }`],
    [
      'an else head alone',
      `process P { parallel { else { user A } { user B } } }`,
    ],
  ])(
    '%s lowers to a parallelGateway pair with no default flow',
    async (_case, source) => {
      const result = await ir(source);
      expect(result.flowElements).toEqual([
        { kind: 'startEvent', id: 'StartEvent_P' },
        { kind: 'parallelGateway', id: forkId },
        { kind: 'parallelGateway', id: joinId },
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'endEvent', id: 'EndEvent_P' },
      ]);
      expect(result.sequenceFlows).toEqual([
        edge(forkId, 'A'),
        edge('A', joinId),
        edge(forkId, 'B'),
        edge('B', joinId),
        edge('StartEvent_P', forkId),
        edge(joinId, 'EndEvent_P'),
      ]);
    },
  );

  it('prunes the AND join when every branch terminates', async () => {
    const result = await ir(
      `process P { parallel { { throw error B "e" } { end S } } }`,
    );
    expect(result.flowElements.some((fe) => fe.id === joinId)).toBe(false);
  });

  it('a condition on one branch turns both gateways inclusive and adds the default flow to the join', async () => {
    const result = await ir(
      `process P { parallel { if (a > 1) { user A } { user B } } }`,
    );

    const gateways = result.flowElements.filter(
      (fe): fe is InclusiveGateway => fe.kind === 'inclusiveGateway',
    );
    expect(gateways.map((g) => g.id)).toEqual([forkId, joinId]);
    expect(gateways[0]!.defaultFlowId).toBe(defaultFlowId);
    expect('defaultFlowId' in gateways[1]!).toBe(false);
    expect(
      result.flowElements.some((fe) => fe.kind === 'parallelGateway'),
    ).toBe(false);

    expect(result.sequenceFlows).toEqual([
      edge(forkId, 'A', { condition: '${a > 1}' }),
      edge('A', joinId),
      edge(forkId, 'B'),
      edge('B', joinId),
      edge(forkId, joinId, { id: defaultFlowId }),
      edge('StartEvent_P', forkId),
      edge(joinId, 'EndEvent_P'),
    ]);
  });

  it('the first else branch takes the reserved default flow id and a second else is a plain branch', async () => {
    const result = await ir(
      `process P { parallel { if (a > 1) { user A } else { user B } else { user C } } }`,
    );

    const fork = byId(result, forkId) as InclusiveGateway;
    expect(fork.defaultFlowId).toBe(defaultFlowId);
    expect(flow(result, forkId, 'B').id).toBe(defaultFlowId);
    expect(flow(result, forkId, 'B').conditionExpression).toBeUndefined();
    expect(flow(result, forkId, 'C').id).toBe(`Flow_${forkId}_C`);
    expect(flow(result, forkId, 'C').conditionExpression).toBeUndefined();
    // The fallback flow is on the else branch, so none runs to the join.
    expect(
      result.sequenceFlows.filter(
        (f) => f.sourceRef === forkId && f.targetRef === joinId,
      ),
    ).toEqual([]);
  });

  it('an empty conditioned branch routes its condition straight to the join, and the join survives only while something can still reach it', async () => {
    const result = await ir(
      `process P { parallel { if (a > 1) { } { user B } } }`,
    );
    expect(
      result.sequenceFlows.filter(
        (f) => f.sourceRef === forkId && f.targetRef === joinId,
      ),
    ).toEqual([
      edge(forkId, joinId, { condition: '${a > 1}' }),
      edge(forkId, joinId, { id: defaultFlowId }),
    ]);

    // Every branch ends, so nothing walks out of the fork: written with an
    // otherwise, the fork needs no fallback flow and the join is pruned;
    // written without one, the invented fallback keeps the join alive. The
    // validator's termination guard reads the same rule the other way round.
    const otherwise = await ir(
      `process P { parallel { if (a > 1) { end X } else { end Y } } }`,
    );
    expect(otherwise.flowElements.some((fe) => fe.id === joinId)).toBe(false);

    const noOtherwise = await ir(
      `process P { parallel { if (a > 1) { end X } { end Y } } }`,
    );
    expect(noOtherwise.flowElements.some((fe) => fe.id === joinId)).toBe(true);
  });
});

describe('astToIr: race lowering', () => {
  const raceId = makeGatewayRaceId('P_0');
  const joinId = makeGatewayJoinId('P_0');
  const firstCatch = makeIntermediateCatchEventId('P_0_b0');
  const secondCatch = makeIntermediateCatchEventId('P_0_b1');

  it('lowers to an event-based fork, one catch per branch, and an exclusive join', async () => {
    const result = await ir(
      `process P { await { message "M" { user A } timer after "P3D" { user B } } }`,
    );

    expect(result.flowElements.map((fe) => [fe.kind, fe.id])).toEqual([
      ['startEvent', 'StartEvent_P'],
      ['eventBasedGateway', raceId],
      ['exclusiveGateway', joinId],
      ['intermediateCatchEvent', firstCatch],
      ['userTask', 'A'],
      ['intermediateCatchEvent', secondCatch],
      ['userTask', 'B'],
      ['endEvent', 'EndEvent_P'],
    ]);
    expect(definitionOf(result, firstCatch)).toEqual(messageDef('M'));
    expect(definitionOf(result, secondCatch)).toEqual(
      timerDef('duration', 'P3D'),
    );

    // No flow out of the gateway carries a condition: Operaton builds no
    // transition there at all and routes through the event scope instead.
    expect(result.sequenceFlows).toEqual([
      edge(raceId, firstCatch),
      edge(firstCatch, 'A'),
      edge('A', joinId),
      edge(raceId, secondCatch),
      edge(secondCatch, 'B'),
      edge('B', joinId),
      edge('StartEvent_P', raceId),
      edge(joinId, 'EndEvent_P'),
    ]);
  });

  it('an empty branch flows its catch to the join, and a race whose branches all terminate loses it', async () => {
    const empty = await ir(
      `process P { await { message "M" { } signal "S" { user B } } }`,
    );
    expect(flow(empty, firstCatch, joinId)).toBeDefined();

    const terminating = await ir(
      `process P { await { message "M" { end Done } signal "S" { throw error B "e" } } }`,
    );
    expect(terminating.flowElements.some((fe) => fe.id === joinId)).toBe(false);
    // Nothing falls through, so the container gets no synthesized end either.
    expect(terminating.flowElements.some((fe) => fe.id === 'EndEvent_P')).toBe(
      false,
    );
  });

  it('a branch settings block lands on the catch event, never on the gateway', async () => {
    const result = await ir(
      `process P { await { message "M" { asyncBefore = true } { user A } signal "S" { user B } } }`,
    );
    expect(byId(result, firstCatch)).toMatchObject({ asyncBefore: true });
    expect('asyncBefore' in byId(result, raceId)).toBe(false);
  });

  it('a name inside a race branch reserves the collision seed', async () => {
    await expectCollidedEnd(
      `process P { await { message "M" { user EndEvent_P } signal "S" { user B } } }`,
    );
  });

  it('nests with parallel in both directions without an id collision', async () => {
    const raceInParallel = await ir(
      `process P {
        parallel {
          { await { message "M" { user X } signal "S" { user Y } } }
          { user Z }
        }
      }`,
    );
    expect(allElementIds(raceInParallel)).toContain(
      makeGatewayRaceId('P_0_b0_0'),
    );
    expect(allElementIds(raceInParallel)).toContain(
      makeIntermediateCatchEventId('P_0_b0_0_b1'),
    );

    const parallelInRace = await ir(
      `process P {
        await {
          message "M" { parallel { { user X } { user Y } } }
          signal "S" { user Z }
        }
      }`,
    );
    expect(allElementIds(parallelInRace)).toContain(
      makeIntermediateCatchEventId('P_0_b0'),
    );
    expect(allElementIds(parallelInRace)).toContain(
      makeGatewayForkId('P_0_b0_0'),
    );

    for (const result of [raceInParallel, parallelInRace]) {
      const ids = allElementIds(result);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

// ── Local helpers ────────────────────────────────────────────────────────────

/** The event definition carried by the flow element with the given id. */
function definitionOf(container: FlowContainer, id: string): unknown {
  return (byId(container, id) as { eventDefinition?: unknown }).eventDefinition;
}

/** The execution binding carried by the flow element with the given id. */
function bindingOf(container: FlowContainer, id: string): unknown {
  return (byId(container, id) as { binding?: unknown }).binding;
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
