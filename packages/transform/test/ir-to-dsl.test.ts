// The inline IR fixtures are what `astToIr` emits for the source they name,
// so a round trip is asserted exactly rather than by reachability.

import { describe, it, expect, beforeAll } from 'vitest';
import { AstUtils, EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import {
  createBpmnScriptServices,
  ENGINE_KEYS,
  gatewayStatementRuleOf,
  PROCESS_HEADER_KEYS,
} from '@bpmn-script/language';
import type { Model, ParenItem } from '@bpmn-script/language';

import {
  irToDsl as printDsl,
  PROCESS_HEADER_SETTINGS,
  UNSTRUCTURED_MARKER,
} from '../src/ir-to-dsl.js';
import { astToIr } from '../src/ast-to-ir.js';
import { xmlToIr } from '../src/xml-to-ir.js';
import { isGateway } from '../src/ir/types.js';
import { bpmnDoc } from './helpers/bpmn-doc.js';
import { byId, only } from './helpers/ir-query.js';
import {
  around,
  boundaryEvent,
  builtinBinding,
  callActivity,
  chained,
  chainedSub,
  classBinding,
  conditionDef,
  delegateBinding,
  edge,
  errorDef,
  escalationDef,
  eventHandler,
  exprBinding,
  externalBinding,
  flowChain,
  gateway,
  HANDWRITTEN_IMPORT_IR,
  ioParam,
  linkDef,
  listValue,
  mapEntry,
  mapValue,
  messageDef,
  minimalProcess,
  processIr,
  scriptTask,
  scriptValue,
  serviceTask,
  signalDef,
  textValue,
  timerDef,
  triggeredSub,
  typedEvent,
} from './helpers/ir-fixtures.js';
import type { PrintWarning } from '../src/ir-to-dsl.js';
import type {
  BpmnProcess,
  EventDefinition,
  ExecutionListener,
  FieldInjection,
  FlowElement,
  FormField,
  IntermediateCatchEvent,
  JobSettings,
  LoopCharacteristics,
  Repeatable,
  SequenceFlow,
  ServiceTask,
  ServiceTaskBinding,
  VersionBinding,
} from '../src/ir/types.js';

// The suite asserts printed source; the warnings channel has its own block.
const irToDsl = (process: BpmnProcess): string => printDsl(process).source;

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
});

// Round-trip equivalence is up to the ids the compiler mints, never byte for
// byte.
const SYNTH_GATEWAY = /^Gateway_.*_(split|join|fork|loop)$/;
const SYNTH_START = /^StartEvent_/;
const SYNTH_END = /^EndEvent_/;

function normId(id: string): string {
  if (SYNTH_GATEWAY.test(id)) return '<GW>';
  if (SYNTH_START.test(id)) return '<START>';
  if (SYNTH_END.test(id)) return '<END>';
  return id;
}

function elemKey(kind: string, id: string): string {
  return `${kind}:${normId(id)}`;
}

function edgeKey(f: SequenceFlow): string {
  const cond = f.conditionExpression ? `[${f.conditionExpression}]` : '';
  return `${normId(f.sourceRef)}->${normId(f.targetRef)}${cond}`;
}

function elementMultiset(ir: BpmnProcess): string[] {
  return ir.flowElements.map((e) => elemKey(e.kind, e.id)).sort();
}

function edgeMultiset(ir: BpmnProcess): string[] {
  return ir.sequenceFlows.map(edgeKey).sort();
}

async function reDesugar(dsl: string): Promise<BpmnProcess> {
  const doc = await parse(dsl);
  const errors = doc.parseResult.parserErrors;
  expect(
    errors,
    `Parser errors in generated DSL:\n${dsl}\n--\n${errors
      .map((e) => e.message)
      .join('\n')}`,
  ).toHaveLength(0);
  return astToIr(doc.parseResult.value);
}

// Errors the compiler draws on what the model holds rather than on how it was
// printed; a fixture feeding one names it, so `printed` stays a gate for
// everything else.
const MODEL_REFUSAL = {
  reservedId: 'matches a reserved synthesized-id pattern',
  mintedId: 'is the id the compiler generates for the implicit',
  cancelOutsideAttempt:
    "A cancel end belongs directly inside an 'attempt' block",
  undoOutsideBlock: 'An undo block belongs directly inside the',
  hostOutsideContainer:
    "No step named 'Elsewhere' in this process to attach to.",
  orphanStep: 'This step can never run',
  secondDefaultStart: "this is the process's second plain or timer start",
  deadElse: 'could never run',
  undoAlongside: 'there is no running flow to run alongside',
  formDefaultShape: 'The default ',
  emptyBlock: 'has no flow steps',
} as const;

// Re-parsing alone passes a print the compiler refuses: a statement a printed
// jump cut off parses fine and lowers to a step nothing reaches.
async function printed(
  ir: BpmnProcess,
  ...refused: (keyof typeof MODEL_REFUSAL)[]
): Promise<string> {
  const dsl = irToDsl(ir);
  await reDesugar(dsl);
  const allowed = refused.map((key) => MODEL_REFUSAL[key]);
  const errors = (await validate(dsl)).diagnostics
    .filter((d) => d.severity === 1)
    .map((d) => (typeof d.message === 'string' ? d.message : d.message.value))
    .filter((message) => !allowed.some((text) => message.includes(text)));
  expect(errors, `Validation errors in generated DSL:\n${dsl}`).toEqual([]);
  return dsl;
}

// The header declares every variable the model reads bare whether or not the
// print kept the reading position, so a dropped condition is asserted absent
// from the body, not from the source.
const bodyOf = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !line.startsWith('  var '))
    .join('\n');

async function expectIdempotent(
  ir: BpmnProcess,
  ...refused: (keyof typeof MODEL_REFUSAL)[]
): Promise<string> {
  const dsl = await printed(ir, ...refused);
  const ir2 = await reDesugar(dsl);
  expect(elementMultiset(ir2)).toEqual(elementMultiset(ir));
  expect(edgeMultiset(ir2)).toEqual(edgeMultiset(ir));
  return dsl;
}

// Degrading a graph to jumps re-mints gateways, so what a print must keep
// exactly is which real nodes reach which through any number of gateway hops.
function realReachability(ir: BpmnProcess): Set<string> {
  const real = new Set(
    ir.flowElements.filter((e) => !isGateway(e)).map((e) => e.id),
  );
  const adj = new Map<string, string[]>();
  for (const f of ir.sequenceFlows) {
    (adj.get(f.sourceRef) ?? adj.set(f.sourceRef, []).get(f.sourceRef)!).push(
      f.targetRef,
    );
  }
  const pairs = new Set<string>();
  for (const s of real) {
    const stack = [...(adj.get(s) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      if (real.has(n)) pairs.add(`${s}->${n}`);
      else for (const m of adj.get(n) ?? []) stack.push(m);
    }
  }
  return pairs;
}

/** `S -> end`: a typed end terminates the chain, so nothing follows it. */
const terminating = (end: FlowElement): BpmnProcess =>
  minimalProcess(
    [{ kind: 'startEvent', id: 'S' }, end],
    [{ id: 'F', sourceRef: 'S', targetRef: end.id }],
  );

/** Desugared `if (amount > 1000) { user B } else { service C }` at body index 2. */
const IF_ELSE_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'userTask', id: 'A', name: 'A task' },
    gateway('Gateway_p_2_split', 'Flow_Gateway_p_2_split_default'),
    gateway('Gateway_p_2_join'),
    { kind: 'userTask', id: 'B', name: 'B task' },
    serviceTask('C', classBinding('com.example.C')),
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('S', 'A'),
    edge('Gateway_p_2_split', 'B', { condition: '${amount > 1000}' }),
    edge('B', 'Gateway_p_2_join'),
    edge('Gateway_p_2_split', 'C', { id: 'Flow_Gateway_p_2_split_default' }),
    edge('C', 'Gateway_p_2_join'),
    edge('A', 'Gateway_p_2_split'),
    edge('Gateway_p_2_join', 'E'),
  ],
);

/** Desugared `while (count < 10) { user W }`. */
const WHILE_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    gateway('Gateway_p_1_loop', 'Flow_Gateway_p_1_loop_default'),
    { kind: 'userTask', id: 'W', name: 'Work' },
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('Gateway_p_1_loop', 'W', { condition: '${count < 10}' }),
    edge('W', 'Gateway_p_1_loop'),
    edge('S', 'Gateway_p_1_loop'),
    edge('Gateway_p_1_loop', 'E', { id: 'Flow_Gateway_p_1_loop_default' }),
  ],
);

/** Desugared `do { user W } while (count < 10)`. */
const DO_WHILE_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'userTask', id: 'W', name: 'Work' },
    gateway('Gateway_p_1_loop', 'Flow_Gateway_p_1_loop_default'),
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('W', 'Gateway_p_1_loop'),
    edge('Gateway_p_1_loop', 'W', { condition: '${count < 10}' }),
    edge('S', 'W'),
    edge('Gateway_p_1_loop', 'E', { id: 'Flow_Gateway_p_1_loop_default' }),
  ],
);

/** Desugared `parallel { { user X } { service Y } }`. */
const PARALLEL_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
    { kind: 'parallelGateway', id: 'Gateway_p_1_join' },
    { kind: 'userTask', id: 'X', name: 'X' },
    serviceTask('Y', classBinding('com.example.Y')),
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('Gateway_p_1_fork', 'X'),
    edge('X', 'Gateway_p_1_join'),
    edge('Gateway_p_1_fork', 'Y'),
    edge('Y', 'Gateway_p_1_join'),
    edge('S', 'Gateway_p_1_fork'),
    edge('Gateway_p_1_join', 'E'),
  ],
);

describe('irToDsl: structured restructuring', () => {
  // The whole source per row, so anything the emitter adds (a `gateway`
  // statement, a `goto`) fails it too.
  it.each([
    [
      'restructures a desugared if/else to `if (...) { } else { }`',
      IF_ELSE_IR,
      'process p {\n' +
        '  var amount: any\n' +
        '  start S\n' +
        '  user A(label: "A task")\n' +
        '  if (amount > 1000) {\n' +
        '    user B(label: "B task")\n' +
        '  } else {\n' +
        '    service C(class: "com.example.C")\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'restructures a desugared while to `while (...) { }`, with no process label where the IR has no name',
      WHILE_IR,
      'process p {\n' +
        '  var count: any\n' +
        '  start S\n' +
        '  while (count < 10) {\n' +
        '    user W(label: "Work")\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'restructures a desugared do-while to `do { } while (...)`',
      DO_WHILE_IR,
      'process p {\n' +
        '  var count: any\n' +
        '  start S\n' +
        '  do {\n' +
        '    user W(label: "Work")\n' +
        '  } while (count < 10)\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'restructures a desugared parallel to nested `parallel { { } { } }` blocks',
      PARALLEL_IR,
      'process p {\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    {\n' +
        '      user X(label: "X")\n' +
        '    }\n' +
        '    {\n' +
        '      service Y(class: "com.example.Y")\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    ],
  ])(
    '%s, and round-trips to an equivalent IR',
    async (_title, ir, expected) => {
      expect(await expectIdempotent(ir)).toBe(expected);
    },
  );

  it('restructures the handwritten invoice import to if/else under a labeled header, and its header, assignees, binding and condition survive the round trip', async () => {
    const ir: BpmnProcess = {
      ...HANDWRITTEN_IMPORT_IR,
      name: 'Invoice Approval',
    };
    const dsl = await printed(ir);
    expect(dsl).toBe(
      'process invoice-approval(label: "Invoice Approval") {\n' +
        '  var amount: any\n' +
        '  start ReviewStart\n' +
        '  user ReviewInvoice(label: "Review invoice", assignee: "demo")\n' +
        '  if (amount > 1000) {\n' +
        '    user SeniorApproval(label: "Senior approval", assignee: "manager")\n' +
        '  } else {\n' +
        '    service AutoApprove(label: "Auto-approve", class: "com.example.invoice.AutoApproveDelegate")\n' +
        '  }\n' +
        '  end Done\n' +
        '}\n',
    );

    const back = await reDesugar(dsl);
    expect([back.id, back.name, back.isExecutable]).toEqual([
      'invoice-approval',
      'Invoice Approval',
      true,
    ]);
    expect(back.flowElements.filter((e) => !isGateway(e))).toEqual(
      ir.flowElements.filter((e) => !isGateway(e)),
    );
    expect(
      back.sequenceFlows.flatMap((f) => f.conditionExpression ?? []),
    ).toEqual(['${amount > 1000}']);
  });
});

describe('irToDsl: goto degradation (every edge with a form keeps it)', () => {
  /** Two XOR splits whose branches cross (`G2` re-enters `A`, which `G1` also targets), so no join post-dominates either. */
  const IRREDUCIBLE_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('G1', 'd1'),
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      gateway('G2', 'd2'),
      { kind: 'endEvent', id: 'E' },
    ],
    [
      { id: 'f0', sourceRef: 'S', targetRef: 'G1' },
      edge('G1', 'A', { id: 'f1', condition: '${p}' }),
      { id: 'd1', sourceRef: 'G1', targetRef: 'B' },
      { id: 'f2', sourceRef: 'A', targetRef: 'E' },
      { id: 'f3', sourceRef: 'B', targetRef: 'G2' },
      edge('G2', 'A', { id: 'f4', condition: '${q}' }),
      { id: 'd2', sourceRef: 'G2', targetRef: 'E' },
    ],
  );

  it('emits valid source with at least one goto, losing no real-node connection', async () => {
    const dsl = await printed(IRREDUCIBLE_IR);
    expect(dsl).toMatch(/\bgoto\s+\w/);
    expect(realReachability(await reDesugar(dsl))).toEqual(
      realReachability(IRREDUCIBLE_IR),
    );
  });

  /**
   * An XOR split with three routes out, which no desugared source produces (the
   * compiler weighs at least one route) but the emitter must still be total
   * on; `weighed` conditions the first route.
   */
  const threeWayXor = (weighed?: string): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('G'),
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'userTask', id: 'C' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        { id: 'f0', sourceRef: 'S', targetRef: 'G' },
        edge('G', 'A', {
          id: 'f1',
          ...(weighed === undefined ? {} : { condition: weighed }),
        }),
        { id: 'f2', sourceRef: 'G', targetRef: 'B' },
        { id: 'f3', sourceRef: 'G', targetRef: 'C' },
        { id: 'f4', sourceRef: 'A', targetRef: 'E' },
        { id: 'f5', sourceRef: 'B', targetRef: 'E' },
        { id: 'f6', sourceRef: 'C', targetRef: 'E' },
      ],
    );

  // A naive emit would chain `if (true) { } else { } else { }`, which is not
  // valid source; the chain heads every route but the last with a condition
  // that holds instead, so no route vanishes and none of its targets dangle.
  it.each([
    ['every route unconditioned', undefined],
    ['one route weighed and two surplus ones (regression)', '${x > 1}'],
  ] as const)(
    'degrades a 3-way XOR with %s to source that compiles, losing no route',
    async (_title, weighed) => {
      const ir = threeWayXor(weighed);
      const dsl = await printed(ir);
      expect(dsl).toContain('} else if (true) {');
      expect((dsl.match(/}\s*else\s*{/g) ?? []).length).toBeLessThanOrEqual(1);
      expect(realReachability(await reDesugar(dsl))).toEqual(
        realReachability(ir),
      );
    },
  );

  it('never throws and always re-parses on degenerate graphs', async () => {
    const degenerate: BpmnProcess[] = [
      // No start event.
      minimalProcess(
        [
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        [{ id: 'f', sourceRef: 'A', targetRef: 'E' }],
      ),
      // Empty process.
      processIr('p', [], []),
      // Orphan (unreachable) node.
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'endEvent', id: 'E' },
          { kind: 'userTask', id: 'Orphan' },
        ],
        [{ id: 'f', sourceRef: 'S', targetRef: 'E' }],
      ),
      // Self-loop on a task.
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          { id: 'f0', sourceRef: 'S', targetRef: 'A' },
          { id: 'f1', sourceRef: 'A', targetRef: 'A' },
          { id: 'f2', sourceRef: 'A', targetRef: 'E' },
        ],
      ),
    ];

    for (const ir of degenerate) {
      const dsl = irToDsl(ir);
      expect(typeof dsl).toBe('string');
      await reDesugar(dsl);
    }
  });
});

describe('irToDsl: multiple and named ends', () => {
  /** Desugared XOR split routing to two distinct named ends (no join). */
  const TWO_ENDS_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Gateway_p_1_split', 'Flow_Gateway_p_1_split_default'),
      { kind: 'endEvent', id: 'Approved', name: 'Approved' },
      { kind: 'endEvent', id: 'Rejected', name: 'Rejected' },
    ],
    [
      edge('S', 'Gateway_p_1_split'),
      edge('Gateway_p_1_split', 'Approved', { condition: '${ok}' }),
      edge('Gateway_p_1_split', 'Rejected', {
        id: 'Flow_Gateway_p_1_split_default',
      }),
    ],
  );

  it('emits both named ends as explicit `end` statements, losing neither end connection', async () => {
    const dsl = await printed(TWO_ENDS_IR);
    expect(dsl).toBe(
      'process p {\n' +
        '  var ok: any\n' +
        '  start S\n' +
        '  if (ok) {\n' +
        '    end Approved(label: "Approved")\n' +
        '  }\n' +
        '  end Rejected(label: "Rejected")\n' +
        '}\n',
    );
    expect(realReachability(await reDesugar(dsl))).toEqual(
      realReachability(TWO_ENDS_IR),
    );
  });
});

describe('irToDsl: service-task bindings', () => {
  it.each([
    [
      'renders a class binding as `service X(class: "...")`',
      serviceTask('Charge', classBinding('com.example.Charge')),
      'service Charge(class: "com.example.Charge")',
      undefined,
      'class',
    ],
    [
      'keeps a labeled class binding on one line, the label leading',
      {
        kind: 'serviceTask',
        id: 'AutoApprove',
        name: 'Auto-approve',
        binding: classBinding('com.example.invoice.AutoApproveDelegate'),
      },
      'service AutoApprove(label: "Auto-approve", class: "com.example.invoice.AutoApproveDelegate")',
      undefined,
      'class',
    ],
    [
      'renders an expression binding as `service X(expression: "${...}")`',
      serviceTask('Calc', exprBinding('${greeter.hello(execution)}')),
      'service Calc(expression: "${greeter.hello(execution)}")',
      undefined,
      'expression',
    ],
    [
      'renders a delegateExpression binding with the `delegate` alias',
      serviceTask('Ship', delegateBinding('${shipDelegate}')),
      'service Ship(delegate: "${shipDelegate}")',
      'delegateExpression',
      'delegateExpression',
    ],
    [
      'renders an external binding as `service X(topic: "...")`',
      serviceTask('Notify', externalBinding('notifications')),
      'service Notify(topic: "notifications")',
      'external Notify',
      'external',
    ],
    // The last column is the binding kind the source lowers back to.
  ] as const)('%s', async (_title, node, statement, absent, bindingKind) => {
    const dsl = await printed(around(node));
    expect(dsl).toContain(statement);
    if (absent !== undefined) expect(dsl).not.toContain(absent);

    const svc = (await reDesugar(dsl)).flowElements.find(
      (e) => e.id === node.id,
    );
    expect(svc?.kind === 'serviceTask' && svc.binding.kind).toBe(bindingKind);
  });
});

// Operaton's own `operaton:type="mail"`/`"shell"` behaviours carry fields as a
// class binding does, and their checks refuse a mail task with no `to` or a
// shell task with no `command`, so a dropped field already fails `printed`.
describe('irToDsl: mail and shell task bindings', () => {
  const MAIL_FIELDS: FieldInjection[] = [
    { name: 'to', value: 'ops@example.com' },
    { name: 'text', value: '${incident.body}' },
  ];
  const SHELL_FIELDS: FieldInjection[] = [
    { name: 'command', value: 'echo' },
    { name: 'arg1', value: 'hello' },
  ];

  it.each([
    [
      'a mail binding on a service task',
      {
        kind: 'serviceTask',
        id: 'Notify',
        binding: builtinBinding('mail', MAIL_FIELDS),
      },
      'service Notify(type: "mail") {\n' +
        '    field to = "ops@example.com"\n' +
        '    field text = "${incident.body}"\n' +
        '  }',
    ],
    [
      'a shell binding on a decide task',
      {
        kind: 'serviceTask',
        id: 'Run',
        element: 'businessRule',
        binding: builtinBinding('shell', SHELL_FIELDS),
      },
      'decide Run(type: "shell") {\n' +
        '    field command = "echo"\n' +
        '    field arg1 = "hello"\n' +
        '  }',
    ],
  ] as const satisfies ReadonlyArray<readonly [string, ServiceTask, string]>)(
    '%s prints its type and fields and reads back as the same binding',
    async (_title, el, block) => {
      const dsl = await printed(around(el));
      expect(dsl).toContain(block);
      const back = (await reDesugar(dsl)).flowElements.find(
        (e) => e.id === el.id,
      )!;
      expect(back.kind === 'serviceTask' && back.binding).toEqual(el.binding);
    },
  );
});

describe('irToDsl: an external task prints its priority, properties and mappings only with something to print', () => {
  it.each<[string, ServiceTaskBinding, string]>([
    [
      'a topic alone prints no parens beyond it',
      { kind: 'external', topic: 't' },
      'service V(topic: "t")',
    ],
    [
      'an integer taskPriority prints bare, as jobPriority does',
      { kind: 'external', topic: 't', taskPriority: '42' },
      'service V(topic: "t", taskPriority: 42)',
    ],
    [
      'an expression taskPriority prints quoted so it re-lexes as raw EL',
      {
        kind: 'external',
        topic: 't',
        taskPriority: '${amount > 1000 ? 90 : 10}',
      },
      'service V(topic: "t", taskPriority: "${amount > 1000 ? 90 : 10}")',
    ],
    [
      'a taskPriority opening with #{ prints as written',
      { kind: 'external', topic: 't', taskPriority: '#{x}' },
      'service V(topic: "t", taskPriority: "#{x}")',
    ],
    [
      'an empty property value prints as "" and lowers back to the empty string, which both engine readers store',
      { kind: 'external', topic: 't', properties: [{ key: 'k', value: '' }] },
      'service V(topic: "t") {\n    property k = ""\n  }',
    ],
    [
      'properties then mappings print after the fields, a declared code by its name and an undeclared one under a synthesized header',
      {
        kind: 'external',
        topic: 't',
        properties: [
          { key: 'amount', value: '100' },
          { key: 'currency', value: 'EUR' },
        ],
        errorMappings: [
          {
            errorCode: 'DECLINED',
            condition: '${externalTask.errorMessage == "declined"}',
          },
          { errorCode: 'TIMEOUT', condition: '${externalTask.retries == 0}' },
        ],
      },
      'service V(topic: "t") {\n' +
        '    property amount = "100"\n' +
        '    property currency = "EUR"\n' +
        '    error PaymentDeclined when externalTask.errorMessage == "declined"\n' +
        '    error TIMEOUT when externalTask.retries == 0\n' +
        '  }',
    ],
  ])('%s', async (_title, binding, expected) => {
    const dsl = await printed({
      ...around(serviceTask('V', binding)),
      errorDecls: [{ name: 'PaymentDeclined', code: 'DECLINED' }],
    });
    expect(dsl).toContain(expected);
    const back = byId(await reDesugar(dsl), 'V');
    expect(back.kind === 'serviceTask' && back.binding).toEqual(binding);
  });
});

describe('irToDsl: task kinds', () => {
  const source = (statement: string): string =>
    `process p {\n  start S\n  ${statement}\n  end E\n}\n`;

  it.each([
    [
      'a plain task prints as a step statement',
      { kind: 'task', id: 'Draft' },
      'step Draft',
      'step Draft(label: "Draft it")',
    ],
    [
      'a receive task names its message in the parens',
      { kind: 'receiveTask', id: 'Wait', messageName: 'OrderPaid' },
      'receive Wait(message: "OrderPaid")',
      'receive Wait(label: "Draft it", message: "OrderPaid")',
    ],
    [
      'a receive task with no message name prints as a bare statement',
      { kind: 'receiveTask', id: 'Wait' },
      'receive Wait',
      'receive Wait(label: "Draft it")',
    ],
    [
      'a send element prints under the send keyword',
      {
        kind: 'serviceTask',
        id: 'Notify',
        element: 'send',
        binding: classBinding('com.example.Notify'),
      },
      'send Notify(class: "com.example.Notify")',
      'send Notify(label: "Draft it", class: "com.example.Notify")',
    ],
    [
      'a businessRule element prints under the decide keyword',
      {
        kind: 'serviceTask',
        id: 'Rate',
        element: 'businessRule',
        binding: { kind: 'decision', decisionRef: 'riskRating' },
      },
      'decide Rate(decision: "riskRating")',
      'decide Rate(label: "Draft it", decision: "riskRating")',
    ],
  ] as const)('%s', async (_title, node, nameless, labeled) => {
    expect(await printed(around(node))).toBe(source(nameless));
    expect(await printed(around({ ...node, name: 'Draft it' }))).toBe(
      source(labeled),
    );
  });

  it('prints a decision binding decision, version pin, mapping, result variable', async () => {
    const rate = around({
      kind: 'serviceTask',
      id: 'Rate',
      element: 'businessRule',
      binding: {
        kind: 'decision',
        decisionRef: 'riskRating',
        binding: { kind: 'latest' },
        mapDecisionResult: 'singleEntry',
      },
      resultVariable: 'risk',
    });
    expect(await printed(rate)).toContain(
      'decide Rate(decision: "riskRating", binding: latest, ' +
        'mapDecisionResult: singleEntry, resultVariable: "risk")',
    );
  });
});

describe('irToDsl: fenced script task', () => {
  it.each([
    [
      'emits the opening fence with its language tag, the body, and the closing fence',
      scriptTask(
        'Compute',
        'javascript',
        'var x = 1;\nexecution.setVariable("x", x);',
      ),
      'script Compute ```javascript\nvar x = 1;\nexecution.setVariable("x", x);```',
    ],
    [
      'reproduces a body carrying its own indentation byte-for-byte',
      scriptTask('Guard', 'groovy', 'if (ok) {\n  doThing();\n}'),
      '```groovy\nif (ok) {\n  doThing();\n}```',
    ],
    [
      'carries the label before the fence when present',
      {
        ...scriptTask('Compute', 'javascript', 'x = 1'),
        name: 'Compute totals',
      },
      'script Compute(label: "Compute totals") ```javascript',
    ],
  ])(
    '%s, and re-parses to the same scriptTask',
    async (_title, node, expected) => {
      const dsl = await printed(around(node));
      expect(dsl).toContain(expected);
      expect(byId(await reDesugar(dsl), node.id)).toEqual(node);
    },
  );
});

describe('irToDsl: sub-process emission', () => {
  /** `PStart -> Before -> sub(SubStart -> Work -> SubEnd) -> After -> PEnd`. */
  const NESTED_IR: BpmnProcess = processIr(
    'proc',
    [
      { kind: 'startEvent', id: 'PStart' },
      { kind: 'userTask', id: 'Before' },
      {
        kind: 'subProcess',
        id: 'sub',
        flowElements: [
          { kind: 'startEvent', id: 'SubStart' },
          { kind: 'userTask', id: 'Work', assignee: 'demo' },
          { kind: 'endEvent', id: 'SubEnd' },
        ],
        sequenceFlows: [
          { id: 'a', sourceRef: 'SubStart', targetRef: 'Work' },
          { id: 'b', sourceRef: 'Work', targetRef: 'SubEnd' },
        ],
      },
      { kind: 'userTask', id: 'After' },
      { kind: 'endEvent', id: 'PEnd' },
    ],
    [
      { id: 'f0', sourceRef: 'PStart', targetRef: 'Before' },
      { id: 'f1', sourceRef: 'Before', targetRef: 'sub' },
      { id: 'f2', sourceRef: 'sub', targetRef: 'After' },
      { id: 'f3', sourceRef: 'After', targetRef: 'PEnd' },
    ],
  );

  it('prints `subprocess sub { ... }` one indent level in, with the parent chain intact around it', async () => {
    expect(await printed(NESTED_IR)).toBe(
      'process proc {\n' +
        '  start PStart\n' +
        '  user Before\n' +
        '  subprocess sub {\n' +
        '    start SubStart\n' +
        '    user Work(assignee: "demo")\n' +
        '    end SubEnd\n' +
        '  }\n' +
        '  user After\n' +
        '  end PEnd\n' +
        '}\n',
    );
  });

  it('restructures an if/else inside a sub-process body (two indent levels)', async () => {
    const SUB_WITH_IF: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'sub',
          flowElements: [
            { kind: 'startEvent', id: 'SubStart' },
            gateway('Gateway_sub_0_split', 'df'),
            gateway('Gateway_sub_0_join'),
            { kind: 'userTask', id: 'Yes' },
            { kind: 'userTask', id: 'No' },
            { kind: 'endEvent', id: 'SubEnd' },
          ],
          sequenceFlows: [
            edge('SubStart', 'Gateway_sub_0_split', { id: 's0' }),
            edge('Gateway_sub_0_split', 'Yes', {
              id: 's1',
              condition: '${ok}',
            }),
            { id: 'df', sourceRef: 'Gateway_sub_0_split', targetRef: 'No' },
            { id: 's2', sourceRef: 'Yes', targetRef: 'Gateway_sub_0_join' },
            { id: 's3', sourceRef: 'No', targetRef: 'Gateway_sub_0_join' },
            edge('Gateway_sub_0_join', 'SubEnd', { id: 's4' }),
          ],
        },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      [
        { id: 'f0', sourceRef: 'PStart', targetRef: 'sub' },
        { id: 'f1', sourceRef: 'sub', targetRef: 'PEnd' },
      ],
    );

    expect(await printed(SUB_WITH_IF)).toBe(
      'process proc {\n' +
        '  var ok: any\n' +
        '  start PStart\n' +
        '  subprocess sub {\n' +
        '    start SubStart\n' +
        '    if (ok) {\n' +
        '      user Yes\n' +
        '    } else {\n' +
        '      user No\n' +
        '    }\n' +
        '    end SubEnd\n' +
        '  }\n' +
        '  end PEnd\n' +
        '}\n',
    );
  });

  // An empty body is the model's; the compiler refuses it on the way back.
  it.each([
    [
      'prints the quoted label for a named sub-process',
      {
        ...chainedSub('Sub', [{ kind: 'userTask', id: 'Do' }]),
        name: 'Handle order',
      },
      'subprocess Sub(label: "Handle order") {',
      [],
    ],
    [
      'prints an empty named sub-process body as an opening brace immediately followed by a closing one',
      { ...chainedSub('Sub', []), name: 'Handle order' },
      '  subprocess Sub(label: "Handle order") {\n  }\n',
      ['emptyBlock'],
    ],
    [
      'prints an unnamed empty sub-process body without a label',
      chainedSub('Sub', []),
      '  subprocess Sub {\n  }\n',
      ['emptyBlock'],
    ],
  ] as const)('%s', async (_title, node, expected, refused) => {
    expect(await printed(around(node), ...refused)).toContain(expected);
  });
});

describe('irToDsl: call activity', () => {
  it('prints every setting and every member in canonical order, shorthand mappings included', async () => {
    const dsl = await printed(
      around({
        kind: 'callActivity',
        id: 'CallSub',
        name: 'Call sub',
        calledElement: 'sub-process',
        binding: { kind: 'deployment' },
        businessKey: '${execution.processBusinessKey}',
        inMappings: [
          { kind: 'all' },
          { kind: 'variable', source: 'amount', target: 'amount' },
          { kind: 'variable', source: 'x', target: 'y' },
          {
            kind: 'expression',
            sourceExpression: '${total * 2}',
            target: 'doubled',
            local: true,
          },
        ],
        outMappings: [
          { kind: 'variable', source: 'result', target: 'outcome' },
          {
            kind: 'expression',
            sourceExpression: '${status}',
            target: 'final',
          },
          { kind: 'all', local: true },
        ],
      }),
    );
    expect(dsl).toContain(
      '  call CallSub(label: "Call sub", process: "sub-process", ' +
        'binding: deployment, businessKey: "${execution.processBusinessKey}") {\n' +
        '    in *\n' +
        '    in amount\n' +
        '    in y = x\n' +
        '    in local doubled = "${total * 2}"\n' +
        '    out outcome = result\n' +
        '    out final = "${status}"\n' +
        '    out local *\n' +
        '  }',
    );
  });

  it.each([
    [
      'prints a minimal call as `call X(process: "p")`',
      undefined,
      'call X(process: "p")',
      undefined,
    ],
    [
      'prints `binding = latest` for a latest binding',
      { kind: 'latest' },
      'call X(process: "p", binding: latest)',
      undefined,
    ],
    [
      'prints only `version = 3` for a numeric version binding (no `binding` key)',
      { kind: 'version', version: '3' },
      'call X(process: "p", version: 3)',
      'binding =',
    ],
    [
      'prints a non-numeric version quoted verbatim',
      { kind: 'version', version: '${v}' },
      'call X(process: "p", version: "${v}")',
      undefined,
    ],
  ] as const)('%s', async (_title, binding, statement, absent) => {
    const dsl = await printed(
      around({
        kind: 'callActivity',
        id: 'X',
        calledElement: 'p',
        ...(binding ? { binding } : {}),
      }),
    );
    expect(dsl).toContain(statement);
    if (absent !== undefined) expect(dsl).not.toContain(absent);
  });

  it('prints a call in mid-chain as a plain fall-through node (order preserved)', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Before' },
        callActivity('Mid', 'sub'),
        { kind: 'userTask', id: 'After' },
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Before', 'Mid', 'After', 'E'),
    );
    expect(await printed(ir)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  user Before\n' +
        '  call Mid(process: "sub")\n' +
        '  user After\n' +
        '  end E\n' +
        '}\n',
    );
  });
});

/** `S -> E` beside a handler `H` whose body is an `if` over `A`. */
const handlerWithIf = (eventDefinition: EventDefinition): BpmnProcess =>
  minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'endEvent', id: 'E' },
      {
        kind: 'subProcess',
        id: 'H',
        triggeredByEvent: true,
        flowElements: [
          { kind: 'startEvent', id: 'HS', eventDefinition },
          gateway('Gateway_HS_split', 'DF'),
          { kind: 'userTask', id: 'A' },
          gateway('Gateway_HS_join'),
          { kind: 'endEvent', id: 'HE' },
        ],
        sequenceFlows: [
          { id: 'F1', sourceRef: 'HS', targetRef: 'Gateway_HS_split' },
          edge('Gateway_HS_split', 'A', {
            id: 'F2',
            condition: '${amount > 1000}',
          }),
          edge('Gateway_HS_split', 'Gateway_HS_join', { id: 'DF' }),
          { id: 'F3', sourceRef: 'A', targetRef: 'Gateway_HS_join' },
          { id: 'F4', sourceRef: 'Gateway_HS_join', targetRef: 'HE' },
        ],
      },
    ],
    [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
  );

describe('irToDsl: event layer', () => {
  it('prints declarations, throws, emits, and trailing handlers in order', async () => {
    const ir: BpmnProcess = {
      ...chained(
        [
          { kind: 'startEvent', id: 'PStart' },
          { kind: 'userTask', id: 'Work' },
          typedEvent('intermediateThrowEvent', 'Ping', escalationDef('LS')),
          typedEvent('endEvent', 'Boom', errorDef('PF')),
        ],
        {
          unwired: [
            triggeredSub('OnPF', [
              typedEvent(
                'startEvent',
                'PFStart',
                errorDef('PF', { codeVariable: 'c', messageVariable: 'm' }),
              ),
              { kind: 'userTask', id: 'Recover' },
              { kind: 'endEvent', id: 'PFEnd' },
            ]),
            triggeredSub('OnLS', [
              typedEvent(
                'startEvent',
                'LSStart',
                escalationDef('LS', 'v'),
                false,
              ),
              { kind: 'userTask', id: 'Note' },
              { kind: 'endEvent', id: 'LSEnd' },
            ]),
          ],
        },
      ),
      errorDecls: [{ name: 'PF', code: 'PF', message: 'boom' }],
    };

    expect(await printed(ir)).toBe(
      [
        'process proc {',
        '  error PF(message: "boom")',
        '  escalation LS',
        '  start PStart',
        '  user Work',
        '  emit escalation Ping(LS)',
        '  throw error Boom(PF)',
        '  on error(PF, code: c, message: m) {',
        '    start PFStart',
        '    user Recover',
        '    end PFEnd',
        '  }',
        '  on escalation(LS, code: v, alongside) {',
        '    start LSStart',
        '    user Note',
        '    end LSEnd',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('declares every code in the header and raises each one by name', async () => {
    const ir = await reDesugar(
      [
        'process p {',
        '  error OUT_OF_STOCK(message: "Out of stock")',
        '  error OrderFailed(code: "order.failed")',
        '  escalation MANUAL_REVIEW',
        '  user Pack',
        '  throw error(OrderFailed)',
        '  on Pack: error(OUT_OF_STOCK, code: c) { user Restock }',
        '  on Pack: error { user Escalate }',
        '}',
      ].join('\n'),
    );

    // Whole source: a declaration is only right if the name it claims is the
    // one every use site raises.
    expect(await printed(ir)).toBe(
      [
        'process p {',
        '  error OrderFailed(code: "order.failed")',
        '  error OUT_OF_STOCK(message: "Out of stock")',
        '  escalation MANUAL_REVIEW',
        '  user Pack',
        '  throw error(OrderFailed)',
        '  on Pack: error(OUT_OF_STOCK, code: c) {',
        '    user Restock',
        '  }',
        '  on Pack: error {',
        '    user Escalate',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  // An undo block belongs inside the block whose work it undoes, so the
  // process-level fixture draws that refusal from the model.
  it.each([
    ['error', errorDef('C'), '\n  on error(C) {\n', undefined],
    [
      'compensation',
      { kind: 'compensation' } as EventDefinition,
      '\n  on compensation {\n',
      'undoOutsideBlock',
    ],
  ] as const)(
    'nests a construct two levels deep inside a %s handler body',
    async (_kind, def, header, refused) => {
      const dsl = await printed(
        handlerWithIf(def),
        ...(refused ? [refused] : []),
      );
      expect(dsl).toContain(header);
      expect(dsl).toContain('\n    if (amount > 1000) {\n');
      expect(dsl).toContain('\n      user A\n');
      expect(dsl).not.toContain('gateway');
    },
  );
});

describe('irToDsl: event layer (message / signal / timer / conditional)', () => {
  it('prints message/signal headers, the signal emit/throw, and trailing handlers', async () => {
    const ir: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        typedEvent('intermediateThrowEvent', 'EmitSig', signalDef('Cancelled')),
        typedEvent('endEvent', 'ThrowSig', signalDef('Cancelled')),
        eventHandler('OnMsg', 'MsgStart', messageDef('PaymentReceived')),
        eventHandler('OnSig', 'SigStart', signalDef('Cancelled'), false),
      ],
      [
        { id: 'SF_PStart_EmitSig', sourceRef: 'PStart', targetRef: 'EmitSig' },
        edge('EmitSig', 'ThrowSig', { id: 'SF_EmitSig_ThrowSig' }),
      ],
    );
    expect(await printed(ir)).toBe(
      [
        'process proc {',
        '  start PStart',
        '  emit signal EmitSig("Cancelled")',
        '  throw signal ThrowSig("Cancelled")',
        '  on message("PaymentReceived") {',
        '    start MsgStart',
        '    user OnMsg_Work',
        '    end OnMsg_End',
        '  }',
        '  on signal("Cancelled", alongside) {',
        '    start SigStart',
        '    user OnSig_Work',
        '    end OnSig_End',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  /** `S -> E` beside the trailing handlers under test. */
  const withHandlers = (...handlers: FlowElement[]): BpmnProcess =>
    processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        ...handlers,
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );

  // The last column marks a non-interrupting handler.
  it.each([
    [
      'a duration timer as `after`',
      timerDef('duration', 'PT1H'),
      '  on timer("PT1H") {\n',
      undefined,
    ],
    [
      'a date timer as `at`',
      timerDef('date', '2026-08-01T09:00:00'),
      '  on timer(at: "2026-08-01T09:00:00") {\n',
      undefined,
    ],
    [
      'a repeating timer as `every`, alongside for a non-interrupting handler',
      timerDef('cycle', 'R/PT10M'),
      '  on timer(every: "R/PT10M", alongside) {\n',
      false,
    ],
    [
      'a condition in the expression subset as bare DSL',
      conditionDef('${amount > 100}'),
      '  on condition(amount > 100) {\n',
      undefined,
    ],
    [
      'a condition out of the subset as a quoted raw fallback',
      conditionDef('${bean.check()}'),
      '  on condition("${bean.check()}") {\n',
      undefined,
    ],
    [
      'a message name that is an expression as a raw template',
      messageDef('${orderType}'),
      '  on message("${orderType}") {\n',
      undefined,
    ],
  ] as const)(
    'prints %s in the handler header',
    async (_title, def, header, interrupting) => {
      const ir = withHandlers(eventHandler('H', 'HS', def, interrupting));
      expect(await printed(ir)).toContain(header);
    },
  );

  it('prints the implementation a thrown or emitted message carries', async () => {
    const thrown = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          ...typedEvent('endEvent', 'Sent', messageDef('Ack')),
          binding: classBinding('com.example.Send'),
        },
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'Sent' }],
    );
    expect(await printed(thrown)).toContain(
      'throw message Sent("Ack", class: "com.example.Send")',
    );

    const emitted = around({
      ...typedEvent('intermediateThrowEvent', 'Ping', messageDef('Ack')),
      binding: externalBinding('send-ack'),
    });
    expect(await printed(emitted)).toContain(
      'emit message Ping("Ack", topic: "send-ack")',
    );
  });
});

// A top-level start's own trigger has nowhere else to print; an event
// sub-process's start puts its trigger in the `on` header instead.
describe('irToDsl: triggered start events', () => {
  it.each<
    [
      title: string,
      start: Partial<
        Omit<Extract<FlowElement, { kind: 'startEvent' }>, 'kind'>
      >,
      expected: string,
      refused: (keyof typeof MODEL_REFUSAL)[],
    ]
  >([
    [
      'a message trigger',
      { eventDefinition: messageDef('OrderReceived') },
      'start S message("OrderReceived")',
      [],
    ],
    [
      'a signal trigger',
      { eventDefinition: signalDef('Cancelled') },
      'start S signal("Cancelled")',
      [],
    ],
    [
      'a duration timer',
      { eventDefinition: timerDef('duration', 'PT1H') },
      'start S timer("PT1H")',
      [],
    ],
    [
      'a date timer as `at`',
      { eventDefinition: timerDef('date', '2026-08-01T09:00:00') },
      'start S timer(at: "2026-08-01T09:00:00")',
      [],
    ],
    [
      'a repeating timer as `every`',
      { eventDefinition: timerDef('cycle', 'R/PT10M') },
      'start S timer(every: "R/PT10M")',
      [],
    ],
    [
      'the label as a setting beside the trigger',
      { name: 'Order in', eventDefinition: messageDef('OrderReceived') },
      'start S message("OrderReceived", label: "Order in")',
      [],
    ],
    [
      'the trigger whole even under a synthesized StartEvent_ id',
      { id: 'StartEvent_p', eventDefinition: messageDef('OrderReceived') },
      'start StartEvent_p message("OrderReceived")',
      ['mintedId'],
    ],
  ])(
    'prints a top-level start carrying %s',
    async (_title, start, expected, refused) => {
      const { id = 'S', ...rest } = start;
      const ir = minimalProcess(
        [
          { kind: 'startEvent', id, ...rest },
          { kind: 'endEvent', id: 'E' },
        ],
        [edge(id, 'E')],
      );
      expect(await printed(ir, ...refused)).toContain(expected);
    },
  );
});

describe('irToDsl: event sub-process start-trigger suppression', () => {
  it("prints the trigger once, in the on header, never on the handler's own start; a synthesized start prints nothing", async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        eventHandler('OnMsg', 'MsgStart', messageDef('PaymentReceived')),
        triggeredSub('OnSig', [
          typedEvent('startEvent', 'StartEvent_OnSig', signalDef('Cancelled')),
          { kind: 'endEvent', id: 'SigEnd' },
        ]),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain(
      '  on message("PaymentReceived") {\n    start MsgStart\n',
    );
    expect(dsl).not.toContain('start MsgStart message');
    expect(dsl).not.toContain('StartEvent_OnSig');
    expect(dsl).toContain('  on signal("Cancelled") {\n    end SigEnd\n  }\n');
    expect(dsl.split('message("PaymentReceived")')).toHaveLength(2);
    expect(dsl.split('signal("Cancelled")')).toHaveLength(2);
  });
});

describe('irToDsl: ends spelling their own word', () => {
  // The third column names the refusals the model draws: a reserved id it
  // chose, a cancel end it puts outside an `attempt`.
  it.each([
    [
      'a terminate end',
      typedEvent('endEvent', 'Stop', { kind: 'terminate' }),
      [],
      'end Stop terminate',
    ],
    [
      'a terminate end with its label',
      {
        ...typedEvent('endEvent', 'Stop', { kind: 'terminate' }),
        name: 'All stop',
      },
      [],
      'end Stop terminate(label: "All stop")',
    ],
    [
      'a synthesized terminate end, rather than dropping it',
      typedEvent('endEvent', 'EndEvent_p', { kind: 'terminate' }),
      ['mintedId'],
      'end EndEvent_p terminate',
    ],
    [
      'a cancel end with its label',
      {
        ...typedEvent('endEvent', 'GiveUp', { kind: 'cancel' }),
        name: 'Give up the booking',
      },
      ['cancelOutsideAttempt'],
      'end GiveUp cancel(label: "Give up the booking")',
    ],
    [
      'a synthesized cancel end, rather than dropping it',
      typedEvent('endEvent', 'EndEvent_p', { kind: 'cancel' }),
      ['mintedId', 'cancelOutsideAttempt'],
      'end EndEvent_p cancel',
    ],
  ] as const)('prints %s', async (_title, end, refused, expected) => {
    expect(await printed(terminating(end), ...refused)).toContain(expected);
  });

  it('keeps the terminate and its label across an imported end event round trip', async () => {
    const ir = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'endEvent',
          id: 'EndEvent_1',
          name: 'Abandon all',
          eventDefinition: { kind: 'terminate' },
        },
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'EndEvent_1' }],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('end EndEvent_1 terminate(label: "Abandon all")');

    const ends = (await reDesugar(dsl)).flowElements.filter(
      (el) => el.kind === 'endEvent',
    );
    expect(ends).toEqual([
      {
        kind: 'endEvent',
        id: 'EndEvent_1',
        name: 'Abandon all',
        eventDefinition: { kind: 'terminate' },
      },
    ]);
  });
});

describe('irToDsl: blocks that can be given up', () => {
  /** The block under test, wired `St -> Book -> En` by {@link around}. */
  const book = (element?: 'transaction'): FlowElement => ({
    ...chainedSub('Book', [{ kind: 'userTask', id: 'Charge' }]),
    name: 'Book and pay',
    asyncBefore: true,
    loop: { collection: 'lines', elementVariable: 'line' },
    ...(element === undefined ? {} : { element }),
  });

  it('prints the block that can be given up under its own head, and a plain one under `subprocess`', async () => {
    expect(await printed(around(book('transaction')))).toContain(
      'attempt Book for each line in lines(label: "Book and pay", asyncBefore: true) {\n',
    );
    expect(await printed(around(book()))).toContain(
      'subprocess Book for each line in lines(label: "Book and pay", asyncBefore: true) {\n',
    );
  });

  it('prints the handler that catches the block being given up', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'St' },
        book('transaction'),
        { kind: 'endEvent', id: 'En' },
        boundaryEvent('Boundary_Book_cancel', 'Book', { kind: 'cancel' }),
        { kind: 'endEvent', id: 'Escaped' },
      ],
      [
        edge('St', 'Book', { id: 'f0' }),
        edge('Book', 'En', { id: 'f1' }),
        edge('Boundary_Book_cancel', 'Escaped', { id: 'f2' }),
      ],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('  on Book: cancel {\n');
    expect(dsl).toContain('    end Escaped\n');
  });
});

describe('irToDsl: event layer (intermediate catch / await)', () => {
  /** A `start -> task -> catch -> task -> end` body: the catch is on the main flow. */
  function catchBody(
    def: IntermediateCatchEvent['eventDefinition'],
  ): BpmnProcess {
    return processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Before' },
        typedEvent('intermediateCatchEvent', 'Catch_1', def),
        { kind: 'userTask', id: 'After' },
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Before', 'Catch_1', 'After', 'E'),
    );
  }

  // The whole source per row, so the missing id token is asserted too: a catch
  // has no name slot, and `Catch_1` appears nowhere.
  it.each([
    ['a message catch', messageDef('M'), '', '  await message("M")\n'],
    [
      'a duration timer catch',
      timerDef('duration', 'PT1H'),
      '',
      '  await timer("PT1H")\n',
    ],
    ['a signal catch', signalDef('S'), '', '  await signal("S")\n'],
    [
      'a conditional catch, bare DSL in the expression subset',
      conditionDef('${amount > 100}'),
      '  var amount: any\n',
      '  await condition(amount > 100)\n',
    ],
  ] as const)(
    'prints %s inline between the surrounding steps',
    async (_title, def, header, statement) => {
      expect(await printed(catchBody(def))).toBe(
        'process proc {\n' +
          header +
          '  start S\n  user Before\n' +
          statement +
          '  user After\n  end E\n}\n',
      );
    },
  );
});

describe('irToDsl: link pairs and named catches', () => {
  it('prints a link pair as a chain-ending emit link and a named await link opening the next chain', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'task', id: 'A' },
        typedEvent('intermediateThrowEvent', 'ToRetry', linkDef('Retry')),
        {
          ...typedEvent('intermediateCatchEvent', 'AtRetry', linkDef('Retry')),
          asyncBefore: true,
        },
        { kind: 'task', id: 'B' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'A'),
        edge('A', 'ToRetry'),
        edge('AtRetry', 'B'),
        edge('B', 'E'),
      ],
    );
    expect(await expectIdempotent(ir)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  step A\n' +
        '  emit link ToRetry("Retry")\n' +
        '  await link AtRetry("Retry", asyncBefore: true)\n' +
        '  step B\n' +
        '  end E\n' +
        '}\n',
    );
  });

  // `Catch_p_2` is the id the compiler mints for the second unnamed await in
  // `p`, so the round trip re-derives it.
  it('prints a named await of any trigger with its name and an unnamed one with none', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('intermediateCatchEvent', 'Wait', messageDef('M')),
        typedEvent('intermediateCatchEvent', 'Catch_p_2', messageDef('M')),
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Wait', 'Catch_p_2', 'E'),
    );
    const dsl = await expectIdempotent(ir);
    expect(dsl).toContain('await message Wait("M")\n  await message("M")');
  });

  it('prints a goto into a named await as a jump, not a dropped edge', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('intermediateCatchEvent', 'Wait', messageDef('M')),
        { kind: 'userTask', id: 'A' },
      ],
      [edge('S', 'Wait'), edge('Wait', 'A'), edge('A', 'Wait')],
    );
    const dsl = await expectIdempotent(ir);
    expect(dsl).not.toContain(UNSTRUCTURED_MARKER);
    expect(printDsl(ir).warnings).toEqual([]);
  });
});

describe('irToDsl: event layer (compensation)', () => {
  const COMPENSATION: EventDefinition = { kind: 'compensation' };

  /** An `emit` mid-chain, a terminal `throw` and a trailing handler, none carrying a code or a name. */
  const compensationIr: BpmnProcess = chained(
    [
      { kind: 'startEvent', id: 'PStart' },
      { kind: 'userTask', id: 'Work' },
      typedEvent('intermediateThrowEvent', 'EmitComp', COMPENSATION),
      typedEvent('endEvent', 'ThrowComp', COMPENSATION),
    ],
    {
      unwired: [
        triggeredSub('CompHandler', [
          typedEvent('startEvent', 'CompStart', COMPENSATION),
          { kind: 'userTask', id: 'Undo' },
          { kind: 'endEvent', id: 'CompEnd' },
        ]),
      ],
    },
  );

  it('prints a bare on-compensation handler after all flow, with emit/throw compensation carrying no trailing string', async () => {
    expect(await printed(compensationIr, 'undoOutsideBlock')).toBe(
      [
        'process proc {',
        '  start PStart',
        '  user Work',
        '  emit compensation EmitComp',
        '  throw compensation ThrowComp',
        '  on compensation {',
        '    start CompStart',
        '    user Undo',
        '    end CompEnd',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it("prints alongside for a malformed-IR compensation start with isInterrupting: false (the printer mirrors the IR; prohibiting it is the validator's job)", async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        triggeredSub('H', [
          typedEvent('startEvent', 'HS', { kind: 'compensation' }, false),
          { kind: 'endEvent', id: 'HE' },
        ]),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );
    expect(await printed(ir, 'undoOutsideBlock', 'undoAlongside')).toContain(
      '  on compensation(alongside) {\n',
    );
  });
});

describe('irToDsl: boundary events', () => {
  /** `S -> host -> E` with the boundary event, its escape chain and their edges appended. */
  const boundaryIr = (
    host: string,
    rest: readonly FlowElement[],
    flows: readonly SequenceFlow[],
  ): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: host },
        { kind: 'endEvent', id: 'E' },
        ...rest,
      ],
      [
        { id: 'F1', sourceRef: 'S', targetRef: host },
        { id: 'F2', sourceRef: host, targetRef: 'E' },
        ...flows,
      ],
    );

  it('prints an interrupting boundary as a hosted handler with its chain indented', async () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('duration', 'PT2H'),
        ),
        { kind: 'userTask', id: 'Escalate' },
        { kind: 'endEvent', id: 'Timeout' },
      ],
      [
        edge('Boundary_Review_timer', 'Escalate', { id: 'F3' }),
        { id: 'F4', sourceRef: 'Escalate', targetRef: 'Timeout' },
      ],
    );
    expect(await printed(ir)).toBe(
      [
        'process p {',
        '  start S',
        '  user Review',
        '  end E',
        '  on Review: timer("PT2H") {',
        '    user Escalate',
        '    end Timeout',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it.each([
    [
      'alongside for a non-interrupting boundary, its chain indented under it',
      'Pack',
      [
        boundaryEvent(
          'Boundary_Pack_message',
          'Pack',
          messageDef('Nudge'),
          false,
        ),
        serviceTask('Notify', exprBinding('${n.go()}')),
        { kind: 'endEvent', id: 'Nudged' },
      ],
      [
        edge('Boundary_Pack_message', 'Notify', { id: 'F3' }),
        edge('Notify', 'Nudged', { id: 'F4' }),
      ],
      ['  on Pack: message("Nudge", alongside) {\n', '    end Nudged\n'],
      [],
    ],
    [
      'an empty body for a boundary carrying no outgoing flow',
      'Review',
      [
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('cycle', 'R/PT1H'),
        ),
      ],
      [],
      ['  on Review: timer(every: "R/PT1H") {\n  }\n'],
      [],
    ],
    [
      'the header all the same when the host lives outside this container',
      'Review',
      [
        boundaryEvent(
          'Boundary_Elsewhere_message',
          'Elsewhere',
          messageDef('M'),
        ),
      ],
      [],
      ['  on Elsewhere: message("M") {\n  }\n'],
      ['hostOutsideContainer'],
    ],
  ] as const)('prints %s', async (_title, host, rest, flows, has, refused) => {
    const dsl = await printed(boundaryIr(host, rest, flows), ...refused);
    for (const text of has) expect(dsl).toContain(text);
  });

  // The compiler lays handlers down in statement order and derives an event
  // sub-process's id from its statement index, so a print that reorders them
  // renumbers the ids on the next compile.
  it('prints boundary handlers and event sub-processes in the order the model holds them', async () => {
    const ir = boundaryIr(
      'T',
      [
        eventHandler('OnM', 'MStart', messageDef('m'), false),
        boundaryEvent('Boundary_T_message', 'T', messageDef('n')),
        { kind: 'userTask', id: 'J' },
        { kind: 'endEvent', id: 'Caught' },
      ],
      [
        edge('Boundary_T_message', 'J', { id: 'F3' }),
        edge('J', 'Caught', { id: 'F4' }),
      ],
    );
    expect((await printed(ir)).split('\n').slice(4, -2)).toEqual([
      '  on message("m", alongside) {',
      '    start MStart',
      '    user OnM_Work',
      '    end OnM_End',
      '  }',
      '  on T: message("n") {',
      '    user J',
      '    end Caught',
      '  }',
    ]);
  });

  it('degrades a rejoin into the main flow to a goto and prints the main-flow node once', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Fetch' },
        { kind: 'userTask', id: 'Ship' },
        { kind: 'endEvent', id: 'E' },
        boundaryEvent('Boundary_Fetch_error', 'Fetch', errorDef('GONE')),
        { kind: 'userTask', id: 'Retry' },
      ],
      [
        { id: 'F1', sourceRef: 'S', targetRef: 'Fetch' },
        { id: 'F2', sourceRef: 'Fetch', targetRef: 'Ship' },
        { id: 'F3', sourceRef: 'Ship', targetRef: 'E' },
        { id: 'F4', sourceRef: 'Boundary_Fetch_error', targetRef: 'Retry' },
        { id: 'F5', sourceRef: 'Retry', targetRef: 'Ship' },
      ],
    );
    expect(await printed(ir)).toBe(
      [
        'process p {',
        '  error GONE',
        '  start S',
        '  user Fetch',
        '  user Ship',
        '  end E',
        '  on Fetch: error(GONE) {',
        '    user Retry',
        '    goto Ship',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('restructures an if/else inside an escape chain (the boundary is a second CFG entry)', async () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent('Boundary_Review_signal', 'Review', signalDef('Abort')),
        gateway('Gateway_p_9_split', 'B4'),
        gateway('Gateway_p_9_join'),
        { kind: 'userTask', id: 'Refund' },
        { kind: 'userTask', id: 'Keep' },
        { kind: 'endEvent', id: 'Aborted' },
      ],
      [
        edge('Boundary_Review_signal', 'Gateway_p_9_split', { id: 'B1' }),
        edge('Gateway_p_9_split', 'Refund', { id: 'B2', condition: '${paid}' }),
        { id: 'B3', sourceRef: 'Refund', targetRef: 'Gateway_p_9_join' },
        { id: 'B4', sourceRef: 'Gateway_p_9_split', targetRef: 'Keep' },
        { id: 'B5', sourceRef: 'Keep', targetRef: 'Gateway_p_9_join' },
        { id: 'B6', sourceRef: 'Gateway_p_9_join', targetRef: 'Aborted' },
      ],
    );
    expect(await printed(ir)).toBe(
      [
        'process p {',
        '  var paid: any',
        '  start S',
        '  user Review',
        '  end E',
        '  on Review: signal("Abort") {',
        '    if (paid) {',
        '      user Refund',
        '    } else {',
        '      user Keep',
        '    }',
        '    end Aborted',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('prints two boundaries on one host as two blocks in IR order', async () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('duration', 'PT2H'),
        ),
        { kind: 'endEvent', id: 'Late' },
        boundaryEvent(
          'Boundary_Review_escalation',
          'Review',
          escalationDef('LOUD', 'c'),
        ),
        { kind: 'endEvent', id: 'Loud' },
      ],
      [
        { id: 'F3', sourceRef: 'Boundary_Review_timer', targetRef: 'Late' },
        edge('Boundary_Review_escalation', 'Loud', { id: 'F4' }),
      ],
    );
    expect(await printed(ir)).toBe(
      [
        'process p {',
        '  escalation LOUD',
        '  start S',
        '  user Review',
        '  end E',
        '  on Review: timer("PT2H") {',
        '    end Late',
        '  }',
        '  on Review: escalation(LOUD, code: c) {',
        '    end Loud',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('keeps the handler block trailing when the container holds an orphan fragment', async () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent('Boundary_Review_error', 'Review', errorDef('X')),
        { kind: 'userTask', id: 'Fix' },
        // Unreachable from the start event and from the escape chain.
        { kind: 'userTask', id: 'Stranded' },
      ],
      [{ id: 'F3', sourceRef: 'Boundary_Review_error', targetRef: 'Fix' }],
    );
    expect(await printed(ir, 'orphanStep')).toBe(
      [
        'process p {',
        '  error X',
        '  start S',
        '  user Review',
        '  end E',
        '  user Stranded',
        '  on Review: error(X) {',
        '    user Fix',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('prints the handler block for a boundary event a malformed flow edge points at, once', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        boundaryEvent('Boundary_A_error', 'A', errorDef('X')),
        { kind: 'userTask', id: 'Fix' },
      ],
      flowChain('S', 'A', 'Boundary_A_error', 'Fix'),
    );
    expect(await printed(ir)).toBe(
      [
        'process p {',
        '  error X',
        '  start S',
        '  user A',
        '  on A: error(X) {',
        '    user Fix',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('prints a boundary event inside the sub-process container that holds its host', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'subProcess',
          id: 'Inner',
          flowElements: [
            { kind: 'startEvent', id: 'IS' },
            { kind: 'userTask', id: 'Check' },
            { kind: 'endEvent', id: 'IE' },
            boundaryEvent(
              'Boundary_Check_condition',
              'Check',
              conditionDef('${stale}'),
            ),
            { kind: 'endEvent', id: 'Stale' },
          ],
          sequenceFlows: [
            { id: 'I1', sourceRef: 'IS', targetRef: 'Check' },
            { id: 'I2', sourceRef: 'Check', targetRef: 'IE' },
            edge('Boundary_Check_condition', 'Stale', { id: 'I3' }),
          ],
        },
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Inner', 'E'),
    );
    expect(await printed(ir)).toContain('    on Check: condition(stale) {\n');
  });
});

// A reserved `StartEvent_`/`EndEvent_`/`Throw_` id is the compiler's own, so
// printing it as a name yields source the validator rejects: the start or end
// is left out, the throw or emit loses its name.
describe('irToDsl: synthesized terminal omission', () => {
  /** A synthesized start/end pair around a sub-process carrying its own authored ones. */
  const IMPLICIT_TERMINALS_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'StartEvent_p' },
      { kind: 'userTask', id: 'Work' },
      {
        kind: 'subProcess',
        id: 'Sub',
        flowElements: [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'Inner' },
          { kind: 'endEvent', id: 'Done' },
        ],
        sequenceFlows: [
          { id: 'SF1', sourceRef: 'S', targetRef: 'Inner' },
          { id: 'SF2', sourceRef: 'Inner', targetRef: 'Done' },
        ],
      },
      { kind: 'endEvent', id: 'EndEvent_p' },
    ],
    [
      { id: 'F1', sourceRef: 'StartEvent_p', targetRef: 'Work' },
      { id: 'F2', sourceRef: 'Work', targetRef: 'Sub' },
      { id: 'F3', sourceRef: 'Sub', targetRef: 'EndEvent_p' },
    ],
  );

  it('omits synthesized implicit start/end terminals but keeps authored ones in a nested container', async () => {
    const dsl = await expectIdempotent(IMPLICIT_TERMINALS_IR);
    expect(dsl).not.toContain('StartEvent_');
    expect(dsl).not.toContain('EndEvent_');
    expect(dsl).toContain('start S');
    expect(dsl).toContain('end Done');
  });

  // No row may leave `Throw_` anywhere in the source.
  it.each([
    [
      'an authored message end',
      'endEvent',
      'Ack',
      messageDef('Ack'),
      'throw message Ack("Ack")',
    ],
    [
      'an authored escalation end',
      'endEvent',
      'Esc',
      escalationDef('X'),
      'throw escalation Esc(X)',
    ],
    [
      'a synthesized message end',
      'endEvent',
      'Throw_p_1',
      messageDef('Ack'),
      'throw message("Ack")',
    ],
    [
      'an authored error end',
      'endEvent',
      'PaymentFailed',
      errorDef('PF'),
      'throw error PaymentFailed(PF)',
    ],
    [
      'a synthesized escalation end',
      'endEvent',
      'Throw_p_1',
      escalationDef('ESC'),
      'throw escalation(ESC)',
    ],
    [
      'an authored message emit',
      'intermediateThrowEvent',
      'Notify',
      messageDef('Ack'),
      'emit message Notify("Ack")',
    ],
    [
      'a synthesized message emit',
      'intermediateThrowEvent',
      'Throw_p_2',
      messageDef('Ack'),
      'emit message("Ack")',
    ],
    [
      'a synthesized signal emit',
      'intermediateThrowEvent',
      'Throw_p_2',
      signalDef('Ping'),
      'emit signal("Ping")',
    ],
  ] as const)('prints %s', async (_title, kind, id, def, expected) => {
    const node = typedEvent(kind, id, def);
    const dsl = await printed(
      kind === 'endEvent' ? terminating(node) : around(node),
    );
    expect(dsl).toContain(expected);
    expect(dsl).not.toContain('Throw_');
  });

  // Only the exact id the compiler mints for a container is synthesized;
  // `StartEvent_1` is a modelling tool's, an authored name like any other.
  it("prints a modelling tool's default start and end under their own ids, label and initiator kept", async () => {
    const { ir, warnings } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="StartEvent_1" name="Order Received" operaton:initiator="who" />
    <bpmn:userTask id="Approve" />
    <bpmn:endEvent id="EndEvent_1" name="Order Filed" />
    <bpmn:sequenceFlow id="F1" sourceRef="StartEvent_1" targetRef="Approve" />
    <bpmn:sequenceFlow id="F2" sourceRef="Approve" targetRef="EndEvent_1" />`);
    expect(warnings).toEqual([]);

    const { source, warnings: printWarnings } = printDsl(ir);
    expect(printWarnings).toEqual([]);
    expect(source).toBe(
      [
        'process p {',
        '  start StartEvent_1(label: "Order Received", initiator: "who")',
        '  user Approve',
        '  end EndEvent_1(label: "Order Filed")',
        '}',
        '',
      ].join('\n'),
    );
    expect((await validate(source)).diagnostics).toEqual([]);
    expect((await reDesugar(source)).flowElements).toEqual(ir.flowElements);
  });

  // The trigger moves into the `on` header, so a start under the handler's
  // minted id prints nothing; any other id is authored and keeps its statement.
  it.each([
    [
      "the handler's minted start id, so the label is reported and the start left out",
      'StartEvent_Handler',
      [['label', 'StartEvent_Handler']],
      '  on error {\n  }\n',
    ],
    [
      "a modelling tool's start id, so the start prints with its label",
      'StartEvent_9',
      [],
      '  on error {\n    start StartEvent_9(label: "Restock Heard")\n  }\n',
    ],
  ] as const)(
    "an event handler's trigger start carries %s",
    async (_title, startId, expectedWarnings, handler) => {
      const { ir, warnings } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="${startId}" name="Restock Heard">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`);
      expect(warnings.map((w) => [w.category, w.elementId])).toEqual(
        expectedWarnings,
      );
      expect(await printed(ir)).toContain(handler);
    },
  );
});

// An id the script cannot spell (`Task.1`, a keyword, a trailing hyphen) prints
// under a name minted from it at every site an id is written, with one report
// per rename.
describe('irToDsl: ids the script cannot spell print under a minted name', () => {
  const ir = processIr(
    'WFP-6-',
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'userTask', id: 'Task.1' },
      { kind: 'userTask', id: 'user' },
      chainedSub('Sub.1', [
        { kind: 'startEvent', id: 'S2' },
        { kind: 'task', id: 'Step.2' },
        { kind: 'endEvent', id: 'E2' },
      ]),
      typedEvent('intermediateThrowEvent', 'Notify.1', messageDef('M')),
      { kind: 'userTask', id: 'Review-' },
      { kind: 'endEvent', id: 'E' },
      boundaryEvent('B', 'Task.1', timerDef('duration', 'PT1H')),
    ],
    [
      ...flowChain('S', 'Task.1', 'user', 'Sub.1', 'Notify.1', 'Review-', 'E'),
      edge('B', 'Review-'),
    ],
  );

  // Revert: print `el.id` at any one site and the source stops parsing.
  it('prints every site under the minted name, reports each rename once, and the source compiles clean', async () => {
    const { source, warnings } = printDsl(ir);
    expect(source).toBe(
      [
        'process WFP_6_ {',
        '  start S',
        '  user Task_1',
        '  user _user',
        '  subprocess Sub_1 {',
        '    start S2',
        '    step Step_2',
        '    end E2',
        '  }',
        '  emit message Notify_1("M")',
        '  user Review_',
        '  end E',
        '  on Task_1: timer("PT1H") {',
        '    goto Review_',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expectReports(
      warnings,
      ['renamedId', 'WFP-6-'],
      ['renamedId', 'Task.1'],
      ['renamedId', 'user'],
      ['renamedId', 'Sub.1'],
      ['renamedId', 'Step.2'],
      ['renamedId', 'Notify.1'],
      ['renamedId', 'Review-'],
    );
    expect((await validate(source)).diagnostics).toEqual([]);
    expect((await reDesugar(source)).id).toBe('WFP_6_');
  });

  // The mint from `Task.1` lands on `Task_1`, which another element already
  // spells: minted names resolve against every id, not only the mints so far.
  it('a minted name that another id already spells takes the next free suffix, and the source compiles clean', async () => {
    const { source, warnings } = printDsl(
      chained([
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Task.1' },
        { kind: 'userTask', id: 'Task_1' },
        { kind: 'endEvent', id: 'E' },
      ]),
    );
    expect(source).toBe(
      [
        'process proc {',
        '  start S',
        '  user Task_1_2',
        '  user Task_1',
        '  end E',
        '}',
        '',
      ].join('\n'),
    );
    expectReports(warnings, ['renamedId', 'Task.1']);
    expect((await validate(source)).diagnostics).toEqual([]);
  });
});

// A synthesized plain end left out anywhere but its block's tail would wire its
// predecessor into whatever follows, so it prints under its reserved id and is
// reported. The compiler never mints one where rows 2 and 3 put it, so those
// rows compile an authored end there and rename it afterwards.
describe("irToDsl: a synthesized plain end that is not its block's tail", () => {
  const start = (id: string): FlowElement => ({ kind: 'startEvent', id });
  const step = (id: string): FlowElement => ({ kind: 'task', id });
  const end = (id: string): FlowElement => ({ kind: 'endEvent', id });
  const renamed = (ir: BpmnProcess, from: string, to: string): BpmnProcess => ({
    ...ir,
    flowElements: ir.flowElements.map((el) =>
      el.id === from ? { ...el, id: to } : el,
    ),
    sequenceFlows: ir.sequenceFlows.map((f) => ({
      ...f,
      sourceRef: f.sourceRef === from ? to : f.sourceRef,
      targetRef: f.targetRef === from ? to : f.targetRef,
    })),
  });

  it.each([
    [
      "a guard's throw with a single incoming flow inlines, so its tail end stays elided rather than deferred",
      'process p { error E  start S  step A  if (x) { throw error Named(E) }  step X }',
      [
        'process p {',
        '  error E',
        '  var x: any',
        '  start S',
        '  step A',
        '  if (x) {',
        '    throw error Named(E)',
        '  }',
        '  step X',
        '}',
      ],
      [],
    ],
    [
      // A link catch is an entry of its own, so its chain is never walked
      // inside the guard the way a chain the split owns is.
      "a plain end whose chain a link catch's chain follows prints before that catch, and its label rides along",
      'process p { start S  step A  if (x) { emit link L("x") }  step C  end Done(label: "Order filed")  await link M("x")  step B  end Fin }',
      [
        'process p {',
        '  var x: any',
        '  start S',
        '  step A',
        '  if (x) {',
        '    emit link L("x")',
        '  }',
        '  step C',
        '  end EndEvent_p(label: "Order filed")',
        '  await link M("x")',
        '  step B',
        '  end Fin',
        '}',
      ],
      [['refusedStatement', 'EndEvent_p']],
    ],
    [
      'a plain end inside a branch prints at once, so the branch does not fall through',
      'process p { start S  step A  if (x) { end Done }  step X  end Fin }',
      [
        'process p {',
        '  var x: any',
        '  start S',
        '  step A',
        '  if (x) {',
        '    end EndEvent_p',
        '  }',
        '  step X',
        '  end Fin',
        '}',
      ],
      [['refusedStatement', 'EndEvent_p']],
    ],
    [
      'of three chains, the synthesized end closing the first prints in place while the authored ends print as any end does',
      // The second and third starts carry a trigger: the validator refuses a
      // second plain start, as `BpmnParse.selectInitial` does.
      minimalProcess(
        [
          start('S1'),
          step('A'),
          end('EndEvent_p'),
          typedEvent('startEvent', 'S2', messageDef('M2')),
          step('B'),
          end('E2'),
          typedEvent('startEvent', 'S3', messageDef('M3')),
          step('C'),
          end('E3'),
        ],
        [
          edge('S1', 'A'),
          edge('A', 'EndEvent_p'),
          edge('S2', 'B'),
          edge('B', 'E2'),
          edge('S3', 'C'),
          edge('C', 'E3'),
        ],
      ),
      [
        'process p {',
        '  start S1',
        '  step A',
        '  end EndEvent_p',
        '  start S2 message("M2")',
        '  step B',
        '  end E2',
        '  start S3 message("M3")',
        '  step C',
        '  end E3',
        '}',
      ],
      [['refusedStatement', 'EndEvent_p']],
    ],
  ] as const)('%s', async (_title, fixture, source, reports) => {
    const ir =
      typeof fixture === 'string'
        ? renamed(await reDesugar(fixture), 'Done', 'EndEvent_p')
        : fixture;
    expect(await expectIdempotent(ir, 'mintedId')).toEqual(
      `${source.join('\n')}\n`,
    );
    expectReports(printDsl(ir).warnings, ...reports);
  });
});

describe('irToDsl: authored terminal in a guard clause', () => {
  it('keeps a goto for an authored end reached from more than one predecessor', async () => {
    // Without `split2`, `Done` would post-dominate `split` and the shape would
    // fold into a re-merging `if`/`else` before the terminal is ever asked about.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        gateway('split'),
        { kind: 'userTask', id: 'B' },
        gateway('split2'),
        { kind: 'endEvent', id: 'Done' },
        { kind: 'endEvent', id: 'End2' },
      ],
      [
        edge('S', 'A'),
        edge('A', 'split'),
        edge('split', 'Done', { condition: '${x}' }),
        edge('split', 'B'),
        edge('split2', 'Done', { condition: '${z}' }),
        edge('B', 'split2'),
        edge('split2', 'End2'),
      ],
    );
    const dsl = await printed(ir);
    expect(dsl).toEqual(`process p {
  var x: any
  var z: any
  start S
  user A
  if (x) {
    goto Done
  }
  user B
  if (z) {
    goto Done
  }
  end End2
  end Done
}
`);
  });
});

// A branch whose chain ends before the join is walked inline only where the
// block's tail is the end the printer leaves out: hoisted behind that end, the
// chain would push it off the tail and print it under its reserved id. Behind
// an authored end the chain stays a jump, so the coordinate ids of its unnamed
// events survive, which the multiset comparison pins.
describe('irToDsl: an authored chain a branch owns', () => {
  it.each([
    [
      'two branches whose chains end print them inline, and the implicit end stays unwritten',
      [
        'process p {',
        '  var a: any',
        '  var b: any',
        '  if (a) {',
        '    user A',
        '    throw message("Quote Received")',
        '  } else if (b) {',
        '    user B',
        '    await {',
        '      message("OrderReceived") {',
        '        end Done',
        '      }',
        '      message("Quote Received") {',
        '        user C',
        '      }',
        '    }',
        '  } else {',
        '    user D',
        '  }',
        '}',
      ],
    ],
    [
      'a guard clause whose branch runs a step into an end prints the step inside the branch',
      [
        'process p {',
        '  var a: any',
        '  if (a) {',
        '    user A',
        '    end Stop',
        '  }',
        '  user B',
        '}',
      ],
    ],
    [
      'a chain jumped to behind an authored end stays behind it, keeping the coordinate id of its unnamed throw',
      [
        'process p {',
        '  error E',
        '  var x: any',
        '  if (x) {',
        '    goto X',
        '  }',
        '  user C',
        '  end Done',
        '  user X',
        '  throw error(E)',
        '}',
      ],
    ],
    [
      'a chain that runs into the implicit end is the tail and stays a jump',
      [
        'process p {',
        '  var a: any',
        '  if (a) {',
        '    goto X',
        '  }',
        '  user B',
        '  end Done',
        '  user X',
        '}',
      ],
    ],
  ])('%s', async (_title, lines) => {
    const source = `${lines.join('\n')}\n`;
    const ir = await reDesugar(source);
    expect(await expectIdempotent(ir)).toBe(source);
    expect(printDsl(ir).warnings).toEqual([]);
  });
});

describe('irToDsl: routes leaving a loop beside the two it is built from', () => {
  /** The loop head routes back, escalates, or carries on; the loop is built from the first two. */
  const PRE_TEST_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Loop'),
      { kind: 'userTask', id: 'Work' },
      { kind: 'userTask', id: 'Escalate' },
      { kind: 'endEvent', id: 'E' },
      { kind: 'endEvent', id: 'E2' },
    ],
    [
      edge('S', 'Loop'),
      edge('Loop', 'Work', { condition: '${more}' }),
      edge('Work', 'Loop'),
      edge('Loop', 'Escalate', { condition: '${escalate}' }),
      edge('Loop', 'E'),
      edge('Escalate', 'E2'),
    ],
  );

  const POST_TEST_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'userTask', id: 'Review' },
      gateway('Decide'),
      { kind: 'userTask', id: 'Escalate' },
      { kind: 'userTask', id: 'Done' },
      { kind: 'endEvent', id: 'E' },
      { kind: 'endEvent', id: 'E2' },
    ],
    [
      edge('S', 'Review'),
      edge('Review', 'Decide'),
      edge('Decide', 'Review', { condition: '${rework}' }),
      edge('Decide', 'Escalate', { condition: '${escalate}' }),
      edge('Decide', 'Done'),
      edge('Done', 'E'),
      edge('Escalate', 'E2'),
    ],
  );

  it.each([
    [
      'pre-test',
      PRE_TEST_IR,
      'process p {\n' +
        '  var more: any\n' +
        '  var escalate: any\n' +
        '  start S\n' +
        '  while (more) {\n' +
        '    user Work\n' +
        '  }\n' +
        '  if (escalate) {\n' +
        '    user Escalate\n' +
        '  } else {\n' +
        '    end E\n' +
        '  }\n' +
        '  end E2\n' +
        '}\n',
    ],
    [
      'post-test',
      POST_TEST_IR,
      'process p {\n' +
        '  var rework: any\n' +
        '  var escalate: any\n' +
        '  start S\n' +
        '  do {\n' +
        '    user Review\n' +
        '  } while (rework)\n' +
        '  if (escalate) {\n' +
        '    goto Escalate\n' +
        '  }\n' +
        '  user Done\n' +
        '  end E\n' +
        '  user Escalate\n' +
        '  end E2\n' +
        '}\n',
    ],
  ])(
    'takes the surplus route as a choice after a %s loop closes',
    async (_title, ir, expected) => {
      const { source, warnings } = printDsl(ir);
      expect(source).toBe(expected);
      expect(warnings).toEqual([]);

      const lowered = await reDesugar(await printed(ir));
      expect(edgeMultiset(lowered)).toContain('<GW>->Escalate[${escalate}]');
      expect(realReachability(lowered)).toEqual(realReachability(ir));
    },
  );

  // Revert symptom: read the loop's settings again for its leftover routes ->
  // the choice after the loop carries a second copy.
  it.each([
    [
      'pre-test',
      PRE_TEST_IR,
      'Loop',
      'while (more) {',
      'while (more) (asyncBefore: true) {',
    ],
    [
      'post-test',
      POST_TEST_IR,
      'Decide',
      '} while (rework)',
      '} while (rework) (asyncBefore: true)',
    ],
  ] as const)(
    'writes the loop settings on the %s loop once, and none on the choice its surplus route becomes',
    async (_title, plain, loopId, plainHead, head) => {
      const ir = withJobSettings(plain, { [loopId]: { asyncBefore: true } });
      const { source, warnings } = printDsl(ir);

      expect(source).toBe(irToDsl(plain).replace(plainHead, head));
      expect(warnings).toEqual([]);
      await printed(ir);
    },
  );
});

describe('irToDsl: a split inside a loop body whose every route is conditioned', () => {
  /**
   * `Approve` splits under a condition per route, one leaving the loop for
   * `Pay` and the rest running through a step into the loop gateway. No route
   * is unconditioned and no split names a fallback: the shape a modeler draws.
   */
  const reviewLoopIr = (
    staying: readonly (readonly [step: string, condition: string])[],
    exit: 'E' | 'E2' = 'E2',
  ): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Approve' },
        gateway('G1'),
        ...staying.map(([id]): FlowElement => ({ kind: 'userTask', id })),
        gateway('G2'),
        { kind: 'userTask', id: 'Pay' },
        { kind: 'endEvent', id: 'E' },
        ...(exit === 'E2' ? [{ kind: 'endEvent', id: 'E2' } as const] : []),
      ],
      [
        edge('S', 'Approve'),
        edge('Approve', 'G1'),
        edge('G1', 'Pay', { condition: '${approved}' }),
        ...staying.map(([id, condition]) => edge('G1', id, { condition })),
        ...staying.map(([id]) => edge(id, 'G2')),
        edge('G2', 'Approve', { condition: '${clarified}' }),
        edge('G2', exit, { condition: '${!clarified}' }),
        edge('Pay', 'E'),
      ],
    );

  const loopHead = (declared: string): string =>
    `process p {\n${declared}  start S\n  do {\n    user Approve\n`;
  const loopTail = '    }\n' + '  } while (clarified)\n';
  const reviewBranch = '    } else if (!approved) {\n' + '      user Review\n';

  // Revert symptom: `cleanJoin` without the containment check takes `E` as
  // the shared-end row's join and prints `end E` inside the `do`.
  it.each([
    [
      'walks the one route that stays in the loop inline and jumps on the one that leaves',
      reviewLoopIr([['Review', '${!approved}']]),
      loopHead('  var approved: any\n  var clarified: any\n') +
        '    if (approved) {\n' +
        '      goto Pay\n' +
        reviewBranch +
        loopTail +
        '  end E2\n' +
        '  user Pay\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'walks both routes that stay in the loop inline',
      reviewLoopIr([
        ['Review', '${!approved && !escalated}'],
        ['Escalate', '${escalated}'],
      ]),
      loopHead(
        '  var approved: any\n  var escalated: any\n  var clarified: any\n',
      ) +
        '    if (approved) {\n' +
        '      goto Pay\n' +
        '    } else if (!approved && !escalated) {\n' +
        '      user Review\n' +
        '    } else if (escalated) {\n' +
        '      user Escalate\n' +
        loopTail +
        '  end E2\n' +
        '  user Pay\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'keeps the split inside the loop when its leaving route and the loop exit share one end',
      reviewLoopIr([['Review', '${!approved}']], 'E'),
      loopHead('  var approved: any\n  var clarified: any\n') +
        '    if (approved) {\n' +
        '      goto Pay\n' +
        reviewBranch +
        loopTail +
        '  end E\n' +
        '  user Pay\n' +
        '  goto E\n' +
        '}\n',
    ],
  ])('%s', async (_title, ir, expected) => {
    const { source, warnings } = printDsl(ir);
    expect(source).toBe(expected);
    // The chain closes with no `else`, so the printed split gains the fallback
    // the model never named; the loop's exit condition has no place after
    // `} while (clarified)`.
    expectReports(
      warnings,
      ['inventedFallback', 'G1'],
      ['droppedFlowCondition', 'G2'],
    );
    await printed(ir);
  });
});

/**
 * A step whose two routes end apart, so each keeps its edge as a jump, and the
 * second lands on a one-way gateway `G -> R`: a gateway cannot be named, so
 * the jump forwards through it to the real successor.
 */
const passThroughIr = (
  kind: 'exclusiveGateway' | 'inclusiveGateway' | 'eventBasedGateway',
  id = 'G',
): BpmnProcess =>
  minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'userTask', id: 'A' },
      { kind, id },
      { kind: 'userTask', id: 'R' },
      { kind: 'endEvent', id: 'E' },
      { kind: 'endEvent', id: 'E2' },
    ],
    [
      edge('S', 'A'),
      edge('A', 'E'),
      edge('A', id),
      edge(id, 'R'),
      edge('R', 'E2'),
    ],
  );

/** The pass-through under an id shaped like a compiler-minted merge. */
const PASS_THROUGH_IR = passThroughIr('exclusiveGateway', 'Gateway_p_9_join');

/**
 * A parallel fork with a back-edge into it (`B -> fork`): by the time the
 * arrival is realized every route out of the fork is consumed, so the edge
 * takes the hand-repair marker rather than an unresolvable `goto`. Only
 * hostile input reaches this shape; the compiler never lowers it.
 */
const GOTO_INTO_FORK_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
    { kind: 'userTask', id: 'A' },
    { kind: 'userTask', id: 'B' },
    { kind: 'endEvent', id: 'E' },
  ],
  [
    { id: 'f0', sourceRef: 'S', targetRef: 'Gateway_p_1_fork' },
    { id: 'f1', sourceRef: 'Gateway_p_1_fork', targetRef: 'A' },
    { id: 'f2', sourceRef: 'Gateway_p_1_fork', targetRef: 'B' },
    { id: 'f3', sourceRef: 'A', targetRef: 'E' },
    { id: 'f4', sourceRef: 'B', targetRef: 'Gateway_p_1_fork' },
  ],
);

describe('irToDsl: never emit a goto to a gateway', () => {
  it('writes the hand-repair marker for a goto into a fork, never a gateway-targeting goto, and reports the dropped edge', async () => {
    const { source, warnings } = printDsl(GOTO_INTO_FORK_IR);
    expect(source).toContain(
      `${UNSTRUCTURED_MARKER} (dropped edge into Gateway_p_1_fork)`,
    );
    expect(source).not.toContain('goto Gateway_');
    expectReports(
      warnings,
      ['degradedSplit', 'Gateway_p_1_fork'],
      ['droppedEdge', 'Gateway_p_1_fork'],
    );
    await printed(GOTO_INTO_FORK_IR);
  });
});

describe('irToDsl: the process header and the start it opens on', () => {
  /** Every key the header carries, an initiator, and a condition start. */
  const HEADER_IR: BpmnProcess = {
    id: 'stock-watch',
    isExecutable: true,
    versionTag: '3.1',
    historyTimeToLive: 'P90D',
    candidateStarterUsers: 'demo,manager',
    candidateStarterGroups: 'adjusters',
    flowElements: [
      {
        kind: 'startEvent',
        id: 'StockRanLow',
        formFields: [{ id: 'stockLevel', type: 'number' }],
        eventDefinition: conditionDef('${stockLevel < 5}'),
        initiator: 'claimant',
      },
      { kind: 'userTask', id: 'ReorderStock', assignee: 'demo' },
      { kind: 'endEvent', id: 'Restocked' },
    ],
    sequenceFlows: [
      edge('StockRanLow', 'ReorderStock'),
      edge('ReorderStock', 'Restocked'),
    ],
  };

  it('prints every key the header vocabulary declares, in the order it declares them', () => {
    expect([
      'label',
      'documentation',
      ...PROCESS_HEADER_SETTINGS.map(([key]) => key),
    ]).toEqual(PROCESS_HEADER_KEYS);
  });

  it('prints the header, the initiator and the condition, and re-desugars to the same IR', async () => {
    const dsl = await printed(HEADER_IR);
    expect(dsl).toBe(
      'process stock-watch(versionTag: "3.1", historyTimeToLive: "P90D", candidateStarterUsers: "demo,manager", candidateStarterGroups: "adjusters") {\n' +
        '  start StockRanLow condition(stockLevel < 5, initiator: "claimant") {\n' +
        '    form {\n' +
        '      stockLevel: number\n' +
        '    }\n' +
        '  }\n' +
        '  user ReorderStock(assignee: "demo")\n' +
        '  end Restocked\n' +
        '}\n',
    );
    expect(await reDesugar(dsl)).toEqual(HEADER_IR);
  });
});

/** The trimmed lines between `form {` and its `}`; a field's own block nests inside, hence the depth count. */
function formBlockLines(dsl: string): string[] {
  const lines = dsl.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'form {');
  const body: string[] = [];
  let depth = 1;
  for (let i = start + 1; depth > 0; i++) {
    const line = lines[i]!;
    depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
    if (depth > 0) body.push(line.trim());
  }
  return body;
}

describe('irToDsl: form fields print their parens and block only with something to print', () => {
  const PLAN_FIELD: FormField = {
    id: 'plan',
    type: 'enum',
    label: 'Plan',
    defaultValue: 'basic',
    values: [
      { id: 'basic', label: 'Basic' },
      { id: 'plus' },
      { id: 'weird', label: '${weird}' },
    ],
    properties: [{ key: 'hint', value: '${hint}' }],
  };

  const FIELD_ROWS: [string, FormField, string[]][] = [
    [
      'a plain field prints unchanged: no parens, no block',
      { id: 'ok', type: 'boolean' },
      ['ok: boolean'],
    ],
    [
      'a date field prints its pattern first, then the flag constraint',
      {
        id: 'birthDate',
        type: 'date',
        label: 'Date of birth',
        datePattern: 'dd/MM/yyyy',
        constraints: [{ name: 'required' }],
      },
      [
        'birthDate: date "Date of birth" (pattern: "dd/MM/yyyy", required: true)',
      ],
    ],
    [
      'a number default opening with #{ prints quoted so it re-lexes as a raw template',
      { id: 'seed', type: 'number', defaultValue: '#{seed}' },
      ['seed: number = "#{seed}"'],
    ],
    [
      'a number prints an all-digit bound bare and a negative bound quoted',
      {
        id: 'amount',
        type: 'number',
        constraints: [
          { name: 'min', config: '-5' },
          { name: 'max', config: '5000' },
        ],
      },
      ['amount: number (min: "-5", max: 5000)'],
    ],
    [
      'a string with a validator constraint opens a block for its property',
      {
        id: 'iban',
        type: 'string',
        constraints: [{ name: 'validator', config: 'com.example.Check' }],
        properties: [{ key: 'placeholder', value: 'Filled in later' }],
      },
      [
        'iban: string (validator: "com.example.Check") {',
        'property placeholder = "Filled in later"',
        '}',
      ],
    ],
    [
      'an enum prints its labelled, bare and escaped values before a raw property value',
      PLAN_FIELD,
      [
        'plan: enum "Plan" = "basic" {',
        'basic "Basic"',
        'plus',
        'weird "\\${weird}"',
        'property hint = "${hint}"',
        '}',
      ],
    ],
  ];

  it.each(FIELD_ROWS)('%s', async (_title, field, expected) => {
    const dsl = await printed(
      around({ kind: 'userTask', id: 'T', formFields: [field] }),
    );
    expect(formBlockLines(dsl)).toEqual(expected);
  });

  // The engine evaluates a default as an expression, so the text a modeler
  // wrote is the constant it sees; bare, `maybe` would read a variable and
  // `1 + 1` would compute, and a bare `-3` lowers to `${-3}`.
  it('prints a number or boolean default bare only when it re-lexes as the same literal', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'T',
        formFields: [
          { id: 'a', type: 'boolean', defaultValue: 'maybe' },
          { id: 'b', type: 'number', defaultValue: '1 + 1' },
          { id: 'c', type: 'number', defaultValue: '-3' },
          { id: 'd', type: 'number', defaultValue: '1.5' },
          { id: 'e', type: 'boolean', defaultValue: 'true' },
          { id: 'f', type: 'number', defaultValue: '${x}' },
          { id: 'g', type: 'number', defaultValue: '1.50' },
          { id: 'h', type: 'number', defaultValue: '1.0' },
          { id: 'i', type: 'number', defaultValue: '007' },
          { id: 'j', type: 'number', defaultValue: '0.5' },
          { id: 'k', type: 'number', defaultValue: '9007199254740993' },
        ],
      }),
      'formDefaultShape',
    );
    // A non-canonical number re-lexes but lowers to another text (`1.50` to
    // `1.5`), so it stays quoted, as does a value past 2^53, which the double
    // rounds before it reaches the literal.
    expect(formBlockLines(dsl)).toEqual([
      'a: boolean = "maybe"',
      'b: number = "1 + 1"',
      'c: number = "-3"',
      'd: number = 1.5',
      'e: boolean = true',
      'f: number = "${x}"',
      'g: number = "1.50"',
      'h: number = "1.0"',
      'i: number = "007"',
      'j: number = 0.5',
      'k: number = "9007199254740993"',
    ]);
  });
});

describe('irToDsl: engine attributes', () => {
  /** One of every statement kind that carries engine settings, each carrying at least one. */
  const ENGINE_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    versionTag: '3.1',
    flowElements: [
      { kind: 'startEvent', id: 'S', asyncAfter: true },
      {
        kind: 'userTask',
        id: 'U',
        name: 'Review',
        assignee: 'ana',
        formKey: 'embedded:app:forms/r.html',
        candidateGroups: 'ops',
        candidateUsers: 'ana,bo',
        dueDate: '${due}',
        followUpDate: 'P1D',
        priority: '20',
        asyncBefore: true,
        exclusive: false,
        jobPriority: '50',
        retryCycle: 'R3/PT10M',
        formFields: [{ id: 'amount', type: 'number' }],
      },
      {
        kind: 'serviceTask',
        id: 'V',
        binding: exprBinding('${c.run(execution)}'),
        resultVariable: 'res',
        asyncBefore: true,
      },
      {
        kind: 'scriptTask',
        id: 'Sc',
        format: 'javascript',
        code: 'x = 1;\n',
        resultVariable: 'out',
        asyncAfter: true,
      },
      {
        kind: 'callActivity',
        id: 'C',
        calledElement: 'other',
        businessKey: 'bk',
        inMappings: [{ kind: 'all' }],
        asyncBefore: true,
      },
      {
        kind: 'subProcess',
        id: 'Sub',
        asyncBefore: true,
        flowElements: [{ kind: 'userTask', id: 'Inner' }],
        sequenceFlows: [],
      },
      {
        kind: 'intermediateCatchEvent',
        id: 'Catch_p_1',
        eventDefinition: timerDef('duration', 'PT1H'),
        asyncBefore: true,
      },
      {
        kind: 'intermediateThrowEvent',
        id: 'Throw_p_1',
        eventDefinition: escalationDef('ESC'),
        exclusive: false,
      },
      { kind: 'endEvent', id: 'E', asyncBefore: true },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_U_error',
        attachedToRef: 'U',
        eventDefinition: errorDef('BOOM'),
        asyncBefore: true,
      },
      {
        kind: 'endEvent',
        id: 'Failed',
        eventDefinition: errorDef('PF'),
        asyncAfter: true,
      },
      {
        kind: 'subProcess',
        id: 'H',
        triggeredByEvent: true,
        asyncBefore: true,
        flowElements: [
          typedEvent('startEvent', 'StartEvent_H', escalationDef('ESC')),
        ],
        sequenceFlows: [],
      },
    ],
    sequenceFlows: [
      { id: 'F1', sourceRef: 'S', targetRef: 'U' },
      { id: 'F2', sourceRef: 'U', targetRef: 'V' },
      { id: 'F3', sourceRef: 'V', targetRef: 'Sc' },
      { id: 'F4', sourceRef: 'Sc', targetRef: 'C' },
      { id: 'F5', sourceRef: 'C', targetRef: 'Sub' },
      { id: 'F6', sourceRef: 'Sub', targetRef: 'Catch_p_1' },
      { id: 'F7', sourceRef: 'Catch_p_1', targetRef: 'Throw_p_1' },
      { id: 'F8', sourceRef: 'Throw_p_1', targetRef: 'E' },
      { id: 'F9', sourceRef: 'Boundary_U_error', targetRef: 'Failed' },
    ],
  };

  it('renders the parens on every statement kind that takes them, in a fixed setting order', async () => {
    expect(await printed(ENGINE_IR)).toBe(
      [
        'process p(versionTag: "3.1") {',
        '  error BOOM',
        '  error PF',
        '  escalation ESC',
        '  start S(asyncAfter: true)',
        '  user U(label: "Review", assignee: "ana", formKey: "embedded:app:forms/r.html", candidateGroups: "ops", candidateUsers: "ana,bo", dueDate: "${due}", followUpDate: "P1D", priority: 20, asyncBefore: true, exclusive: false, jobPriority: 50, retryCycle: "R3/PT10M") {',
        '    form {',
        '      amount: number',
        '    }',
        '  }',
        '  service V(expression: "${c.run(execution)}", resultVariable: "res", asyncBefore: true)',
        '  script Sc(resultVariable: "out", asyncAfter: true) ```javascript',
        'x = 1;',
        '```',
        '  call C(process: "other", businessKey: "bk", asyncBefore: true) {',
        '    in *',
        '  }',
        '  subprocess Sub(asyncBefore: true) {',
        '    user Inner',
        '  }',
        '  await timer("PT1H", asyncBefore: true)',
        '  emit escalation(ESC, exclusive: false)',
        '  end E(asyncBefore: true)',
        '  on U: error(BOOM, asyncBefore: true) {',
        '    throw error Failed(PF, asyncAfter: true)',
        '  }',
        '  on escalation(ESC, asyncBefore: true) {',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  /** `S -> E` beside one timer handler whose start `startId` carries the timer job's three settings. */
  const timerHandler = (
    startId: string,
    subProcessSettings: JobSettings = {},
  ): BpmnProcess =>
    processIr(
      'p',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        {
          ...triggeredSub('EventSubProcess_p_1', [
            {
              kind: 'startEvent',
              id: startId,
              eventDefinition: timerDef('cycle', 'R/PT1H'),
              isInterrupting: false,
              exclusive: false,
              jobPriority: '5',
              retryCycle: 'R1/PT1M',
            },
            { kind: 'endEvent', id: 'EndEvent_EventSubProcess_p_1' },
          ]),
          ...subProcessSettings,
        },
      ],
      [edge('S', 'E')],
    );

  // Revert: leave the start's settings off the `on` head and the first two
  // rows print a `start StartEvent_...(...)` statement under a reserved id.
  it.each<[string, BpmnProcess, string[]]>([
    [
      "a synthesized start's timer-job settings print on the `on timer` head",
      timerHandler('StartEvent_EventSubProcess_p_1'),
      [
        '  on timer(every: "R/PT1H", exclusive: false, jobPriority: 5, retryCycle: "R1/PT1M", alongside) {',
        '  }',
      ],
    ],
    [
      "the sub-process's async flags print ahead of the start's timer-job settings",
      timerHandler('StartEvent_EventSubProcess_p_1', { asyncBefore: true }),
      [
        '  on timer(every: "R/PT1H", asyncBefore: true, exclusive: false, jobPriority: 5, retryCycle: "R1/PT1M", alongside) {',
        '  }',
      ],
    ],
    [
      'an authored start keeps them on its own statement',
      timerHandler('Tick'),
      [
        '  on timer(every: "R/PT1H", alongside) {',
        '    start Tick(exclusive: false, jobPriority: 5, retryCycle: "R1/PT1M")',
        '  }',
      ],
    ],
  ])('%s', async (_title, ir, handlerLines) => {
    const dsl = await printed(ir);
    // The handler closes the process: its lines sit above the final brace.
    expect(dsl.split('\n').slice(-2 - handlerLines.length, -2)).toEqual(
      handlerLines,
    );
    // The compiler puts the three back on the start either way.
    const back = (await reDesugar(dsl)).flowElements.find(
      (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
    );
    const start = back?.kind === 'subProcess' && only(back, 'startEvent');
    expect(
      start && {
        exclusive: start.exclusive,
        jobPriority: start.jobPriority,
        retryCycle: start.retryCycle,
      },
    ).toEqual({ exclusive: false, jobPriority: '5', retryCycle: 'R1/PT1M' });
  });

  it.each<[string, FlowElement[], string[]]>([
    [
      'neither parens nor braces on a node carrying no engine attributes',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'U' },
        {
          kind: 'subProcess',
          id: 'Sub',
          flowElements: [{ kind: 'userTask', id: 'Inner' }],
          sequenceFlows: [],
        },
        typedEvent('intermediateCatchEvent', 'Catch_p_1', signalDef('Ping')),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        '  start S',
        '  user U',
        '  subprocess Sub {',
        '    user Inner',
        '  }',
        '  await signal("Ping")',
        '  end E',
      ],
    ],
    [
      'booleans bare and only in their non-default direction',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A', asyncBefore: true, asyncAfter: true },
        { kind: 'userTask', id: 'B', exclusive: false },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        '  start S',
        '  user A(asyncBefore: true, asyncAfter: true)',
        '  user B(exclusive: false)',
        '  end E',
      ],
    ],
    [
      'an all-digit priority bare and any other value quoted, a #{ opening as written and padding trimmed so it re-lexes as a raw template',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A', jobPriority: '50', priority: '7' },
        {
          kind: 'userTask',
          id: 'B',
          jobPriority: '${order.rush}',
          priority: '${p}',
        },
        {
          kind: 'userTask',
          id: 'C',
          jobPriority: '#{order.rush}',
          priority: '  ${p}',
        },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        '  start S',
        '  user A(priority: 7, jobPriority: 50)',
        '  user B(priority: "${p}", jobPriority: "${order.rush}")',
        '  user C(priority: "${p}", jobPriority: "#{order.rush}")',
        '  end E',
      ],
    ],
  ])('prints %s', async (_title, elements, body) => {
    const ir = minimalProcess(
      elements,
      flowChain(...elements.map((el) => el.id)),
    );
    expect(await printed(ir)).toBe(
      ['process p {', ...body, '}', ''].join('\n'),
    );
  });
});

/** A step whose two routes end apart, so the one landing on the end keeps its edge as a jump. */
const jumpToEndIr = (
  end: Partial<Omit<Extract<FlowElement, { kind: 'endEvent' }>, 'kind'>>,
): BpmnProcess => {
  const { id = 'EndEvent_p', ...attrs } = end;
  return minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'endEvent', id, ...attrs },
      { kind: 'endEvent', id: 'E2' },
    ],
    [
      { id: 'F1', sourceRef: 'S', targetRef: 'A' },
      { id: 'F2', sourceRef: 'A', targetRef: id },
      { id: 'F3', sourceRef: 'A', targetRef: 'B' },
      { id: 'F4', sourceRef: 'B', targetRef: 'E2' },
    ],
  );
};

/** A back edge to the start, which no loop form takes, so it is written as a jump. */
const backEdgeIr = (
  start: Partial<Omit<Extract<FlowElement, { kind: 'startEvent' }>, 'kind'>>,
): BpmnProcess => {
  const { id = 'StartEvent_p', ...attrs } = start;
  return minimalProcess(
    [
      { kind: 'startEvent', id, ...attrs },
      { kind: 'userTask', id: 'A' },
    ],
    flowChain(id, 'A', id),
  );
};

/** A listener is a further reason a synthesized terminal has something to print. */
const DONE_LISTENERS: ExecutionListener[] = [
  { event: 'end', binding: classBinding('com.example.Done') },
];

describe('irToDsl: whether a synthesized terminal prints', () => {
  // Content that cannot be re-derived prints the statement and the jump
  // resolves; anything else elides the terminal and the edge takes the marker.
  it.each([
    [
      'an engine attribute on an end',
      'end',
      { asyncBefore: true },
      'end EndEvent_p(asyncBefore: true)',
      ['mintedId'],
    ],
    [
      'a terminate on an end, which cannot be re-derived',
      'end',
      { eventDefinition: { kind: 'terminate' } },
      'end EndEvent_p terminate',
      ['mintedId'],
    ],
    [
      'a listener on an end',
      'end',
      { executionListeners: DONE_LISTENERS },
      'end EndEvent_p {\n    on end(class: "com.example.Done")\n  }',
      ['mintedId'],
    ],
    [
      "an id carrying another kind's synthesized prefix on an end, authored here",
      'end',
      { id: 'StartEvent_p' },
      'end StartEvent_p',
      ['mintedId'],
    ],
    ['nothing on an end', 'end', {}, null, []],
    [
      'a label alone on an end, a label not being printable content',
      'end',
      { name: 'Order Filed' },
      null,
      [],
    ],
    [
      'an engine attribute on a start',
      'start',
      { asyncBefore: true },
      'start StartEvent_p(asyncBefore: true)',
      ['mintedId'],
    ],
    [
      "an id carrying another kind's synthesized prefix on a start, authored here",
      'start',
      { id: 'EndEvent_p' },
      'start EndEvent_p',
      ['mintedId'],
    ],
    ['nothing on a start', 'start', {}, null, []],
    ['a label alone on a start', 'start', { name: 'Order Received' }, null, []],
  ] as const)(
    'carries %s',
    async (_title, side, payload, expected, refused) => {
      const id =
        'id' in payload
          ? payload.id
          : side === 'end'
            ? 'EndEvent_p'
            : 'StartEvent_p';
      const dsl = await printed(
        side === 'end' ? jumpToEndIr(payload) : backEdgeIr(payload),
        ...refused,
      );
      if (expected === null) {
        expect(dsl).not.toContain(`${side} ${id}`);
        expect(dsl).not.toContain(`goto ${id}`);
        if ('name' in payload) expect(dsl).not.toContain(payload.name);
        expect(dsl).toContain(`${UNSTRUCTURED_MARKER} (dropped edge into`);
      } else {
        expect(dsl).toContain(expected);
        expect(dsl).toContain(`goto ${id}`);
        expect(dsl).not.toContain('dropped edge');
      }
    },
  );
});

describe('irToDsl: input/output parameters', () => {
  it('prints every value form, inputs before outputs, in IR order', async () => {
    const dsl = await printed(
      around({
        kind: 'serviceTask',
        id: 'V',
        binding: externalBinding('charge'),
        inputParameters: [
          ioParam('plain', textValue('ready')),
          ioParam('expr', textValue('${order.id}')),
          ioParam('items', listValue([])),
        ],
        outputParameters: [
          ioParam('code', textValue('200')),
          ioParam('blank', mapValue([])),
        ],
      }),
    );
    expect(dsl).toContain(
      'service V(topic: "charge") {\n' +
        '    input plain = "ready"\n' +
        '    input expr = "${order.id}"\n' +
        '    input items = []\n' +
        '    output code = "200"\n' +
        '    output blank = {}\n' +
        '  }',
    );
  });

  it('nests a map inside a list and a list inside a map, keeping a keyword-shaped key quoted', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        inputParameters: [
          ioParam(
            'rows',
            listValue([
              textValue('a'),
              mapValue([
                mapEntry('k', textValue('v')),
                // `end` is a statement keyword, so it never lexes as an
                // identifier: only the quoted spelling survives re-parsing.
                mapEntry('end', textValue('z')),
              ]),
            ]),
          ),
          ioParam(
            'lookup',
            mapValue([
              mapEntry('ids', listValue([textValue('x')])),
              mapEntry('with space', textValue('w')),
            ]),
          ),
        ],
      }),
    );
    expect(dsl).toContain(
      'user U {\n' +
        '    input rows = ["a", { "k": "v", "end": "z" }]\n' +
        '    input lookup = { "ids": ["x"], "with space": "w" }\n' +
        '  }',
    );
  });

  it.each([
    [
      'an expression map key escapes its opener so it re-lexes as the literal it is',
      mapValue([
        mapEntry('${dyn}', textValue('v')),
        mapEntry('#{other}', textValue('w')),
      ]),
      '{ "\\${dyn}": "v", "\\#{other}": "w" }',
    ],
    [
      'a value with a line break prints on one line',
      textValue('l1\nl2'),
      '"l1\\nl2"',
    ],
    [
      'a raw template with a quote inside escapes it once',
      textValue('${fn("a")}'),
      '"${fn(\\"a\\")}"',
    ],
    ['a #{ template prints as written', textValue('#{x}'), '"#{x}"'],
  ] as const)('%s', async (_title, value, expected) => {
    const ir = around({
      kind: 'userTask',
      id: 'U',
      inputParameters: [ioParam('v', value)],
    });
    const dsl = await printed(ir);
    expect(dsl).toContain(`input v = ${expected}`);
    const task = byId(await reDesugar(dsl), 'U');
    expect(task.kind === 'userTask' && task.inputParameters).toEqual([
      ioParam('v', value),
    ]);
  });

  it('prints a script value as a fenced block carrying its format', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        inputParameters: [
          ioParam('total', scriptValue('groovy', 'sum(a, b)\n')),
        ],
      }),
    );
    expect(dsl).toContain(
      'user U {\n    input total = ```groovy\nsum(a, b)\n```\n  }',
    );
  });

  it('keeps a script task readable with a fenced value among its members', async () => {
    const dsl = await printed(
      around({
        kind: 'scriptTask',
        id: 'Sc',
        format: 'javascript',
        code: 'x = 1;\n',
        inputParameters: [ioParam('seed', scriptValue('groovy', 'seed()\n'))],
      }),
    );
    expect(dsl).toContain(
      'script Sc {\n' +
        '    input seed = ```groovy\nseed()\n```\n' +
        '  } ```javascript\nx = 1;\n```',
    );
  });

  it('prints the members before the body on a sub-process and before the mappings on a call', async () => {
    const dsl = await printed(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          {
            kind: 'subProcess',
            id: 'Sub',
            inputParameters: [
              ioParam('seed', textValue('1')),
              ioParam('extra', mapValue([])),
            ],
            flowElements: [{ kind: 'userTask', id: 'Inner' }],
            sequenceFlows: [],
          },
          {
            kind: 'callActivity',
            id: 'C',
            calledElement: 'other',
            outputParameters: [ioParam('total', textValue('${sum}'))],
            inMappings: [{ kind: 'all' }],
          },
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'Sub', 'C', 'E'),
      ),
    );
    // An empty map ending the members puts `{}` `}` `{` in a row, the sequence
    // the body brace has to be told apart from.
    expect(dsl).toContain(
      'subprocess Sub {\n' +
        '    input seed = "1"\n' +
        '    input extra = {}\n' +
        '  } {',
    );
    expect(dsl).toContain(
      'call C(process: "other") {\n' +
        '    output total = "${sum}"\n' +
        '    in *\n' +
        '  }',
    );
  });
});

describe('irToDsl: listeners', () => {
  it('prints each binding form, execution listeners before task listeners', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.Enter') },
          { event: 'end', binding: exprBinding('${audit.log()}') },
        ],
        taskListeners: [
          { event: 'create', binding: delegateBinding('${assignHook}') },
        ],
      }),
    );
    expect(dsl).toContain(
      'user U {\n' +
        '    on start(class: "com.example.Enter")\n' +
        '    on end(expression: "${audit.log()}")\n' +
        '    on create(delegate: "${assignHook}")\n' +
        '  }',
    );
  });

  it('prints a script-bound listener as a fenced block', async () => {
    const dsl = await printed(
      around({
        kind: 'serviceTask',
        id: 'V',
        binding: classBinding('com.example.C'),
        executionListeners: [
          { event: 'end', binding: scriptValue('groovy', "println 'bye'\n") },
        ],
      }),
    );
    expect(dsl).toContain(
      'service V(class: "com.example.C") {\n' +
        '    on end ```groovy\n' +
        "println 'bye'\n" +
        '```\n' +
        '  }',
    );
  });

  it('carries a timeout listener timer through the timer particle', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        taskListeners: [
          {
            event: 'timeout',
            binding: classBinding('com.example.T'),
            timer: timerDef('duration', 'PT1H'),
          },
          {
            event: 'timeout',
            binding: classBinding('com.example.D'),
            timer: timerDef('date', '${deadline}'),
          },
        ],
      }),
    );
    expect(dsl).toContain(
      'user U {\n' +
        '    on timeout after "PT1H"(class: "com.example.T")\n' +
        '    on timeout at "${deadline}"(class: "com.example.D")\n' +
        '  }',
    );
  });

  it('prints an execution listener on a handler header and an awaited event', async () => {
    const dsl = await printed(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          {
            kind: 'intermediateCatchEvent',
            id: 'Catch_p_1',
            eventDefinition: signalDef('Ping'),
            executionListeners: [
              { event: 'start', binding: classBinding('com.example.W') },
            ],
          },
          { kind: 'endEvent', id: 'E' },
          {
            kind: 'subProcess',
            id: 'H',
            triggeredByEvent: true,
            executionListeners: [
              { event: 'end', binding: classBinding('com.example.H') },
            ],
            flowElements: [
              typedEvent('startEvent', 'StartEvent_H', escalationDef('ESC')),
            ],
            sequenceFlows: [],
          },
        ],
        flowChain('S', 'Catch_p_1', 'E'),
      ),
    );
    expect(dsl).toContain(
      'await signal("Ping") {\n    on start(class: "com.example.W")\n  }',
    );
    expect(dsl).toContain(
      'on escalation(ESC) {\n    on end(class: "com.example.H")\n  } {',
    );
  });

  it('prints the settings in the parens and the form, the parameters and the listeners in the braces, in one fixed order', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        name: 'Review',
        assignee: 'ana',
        asyncBefore: true,
        inputParameters: [ioParam('seed', textValue('1'))],
        outputParameters: [ioParam('note', textValue('${n}'))],
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.Enter') },
        ],
        taskListeners: [
          { event: 'complete', binding: classBinding('com.example.Done') },
        ],
        formFields: [{ id: 'amount', type: 'number' }],
      }),
    );
    expect(dsl).toContain(
      'user U(label: "Review", assignee: "ana", asyncBefore: true) {\n' +
        '    form {\n' +
        '      amount: number\n' +
        '    }\n' +
        '    input seed = "1"\n' +
        '    output note = "${n}"\n' +
        '    on start(class: "com.example.Enter")\n' +
        '    on complete(class: "com.example.Done")\n' +
        '  }',
    );
  });
});

describe('irToDsl: field injection and form references', () => {
  // A field or a form reference printed where the compiler refuses it still
  // reads fine as text, so `printed` is the assertion.
  it('prints a field before the io parameters on every carrier, and a form reference beside its binding', async () => {
    const dsl = await printed(
      chained([
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'serviceTask',
          id: 'Ship',
          binding: {
            kind: 'class',
            className: 'com.example.Ship',
            fields: [
              { name: 'greeting', value: 'hello' },
              { name: 'target', value: '${order.address}' },
            ],
          },
          inputParameters: [ioParam('amount', textValue('${total}'))],
          executionListeners: [
            {
              event: 'start',
              binding: {
                kind: 'delegateExpression',
                expression: '${auditHook}',
                fields: [{ name: 'level', value: 'INFO' }],
              },
            },
          ],
        },
        {
          kind: 'userTask',
          id: 'Review',
          formRef: {
            key: 'review-form',
            binding: { kind: 'version', version: '3' },
          },
          taskListeners: [
            {
              event: 'create',
              binding: {
                kind: 'class',
                className: 'com.example.Assign',
                fields: [{ name: 'role', value: 'clerk' }],
              },
            },
          ],
        },
        { kind: 'endEvent', id: 'E' },
      ]),
    );

    expect(dsl).toContain(
      '  service Ship(class: "com.example.Ship") {\n' +
        '    field greeting = "hello"\n' +
        '    field target = "${order.address}"\n' +
        '    input amount = "${total}"\n' +
        '    on start(delegate: "${auditHook}") {\n' +
        '      field level = "INFO"\n' +
        '    }\n' +
        '  }\n' +
        '  user Review(formRef: "review-form", version: 3) {\n' +
        '    on create(class: "com.example.Assign") {\n' +
        '      field role = "clerk"\n' +
        '    }\n' +
        '  }\n',
    );
  });

  it('prints binding: latest and binding: deployment for the two unpinned form bindings', async () => {
    const printedWith = async (binding: VersionBinding): Promise<string> =>
      printed(
        around({
          kind: 'userTask',
          id: 'Review',
          formRef: { key: 'review-form', binding },
        }),
      );

    expect([
      await printedWith({ kind: 'latest' }),
      await printedWith({ kind: 'deployment' }),
    ]).toEqual([
      expect.stringContaining(
        'user Review(formRef: "review-form", binding: latest)',
      ),
      expect.stringContaining(
        'user Review(formRef: "review-form", binding: deployment)',
      ),
    ]);
  });
});

describe('irToDsl: repeated activities', () => {
  const OVER_LINES: LoopCharacteristics = {
    collection: 'lines',
    elementVariable: 'line',
  };

  type RepeatableElement = Extract<FlowElement, Repeatable>;

  /** Print one repeated element, wired `S -> el -> E`, with its settings. */
  const printRepeated = (
    el: RepeatableElement,
    loop: LoopCharacteristics,
  ): Promise<string> => printed(around({ ...el, asyncBefore: true, loop }));

  // Every kind that can repeat: the head its clause follows, its settings, and
  // what closes the statement.
  it.each([
    [
      'step Record',
      { kind: 'task', id: 'Record', name: 'Record it' },
      'label: "Record it", asyncBefore: true',
      '',
    ],
    [
      'user Approve',
      { kind: 'userTask', id: 'Approve', name: 'Approve it' },
      'label: "Approve it", asyncBefore: true',
      '',
    ],
    [
      'send Notify',
      {
        kind: 'serviceTask',
        id: 'Notify',
        name: 'Notify them',
        element: 'send',
        binding: classBinding('com.example.Notify'),
      },
      'label: "Notify them", class: "com.example.Notify", asyncBefore: true',
      '',
    ],
    [
      'script Compute',
      {
        kind: 'scriptTask',
        id: 'Compute',
        name: 'Compute it',
        format: 'javascript',
        code: 'x = 1',
      },
      'label: "Compute it", asyncBefore: true',
      ' ```javascript',
    ],
    [
      'receive Wait',
      {
        kind: 'receiveTask',
        id: 'Wait',
        name: 'Wait for it',
        messageName: 'OrderPaid',
      },
      'label: "Wait for it", message: "OrderPaid", asyncBefore: true',
      '',
    ],
    [
      'subprocess Fulfil',
      {
        ...chainedSub('Fulfil', [
          {
            kind: 'serviceTask',
            id: 'Pick',
            binding: classBinding('com.example.Pick'),
          },
        ]),
        name: 'Fulfil it',
      },
      'label: "Fulfil it", asyncBefore: true',
      ' {',
    ],
    [
      'call Regional',
      {
        kind: 'callActivity',
        id: 'Regional',
        name: 'Run it',
        calledElement: 'regional-report',
      },
      'label: "Run it", process: "regional-report", asyncBefore: true',
      '',
    ],
  ] as const satisfies ReadonlyArray<
    readonly [string, RepeatableElement, string, string]
  >)(
    'prints the clause of `%s` between the name and the settings, and none without a loop',
    async (head, el, settings, tail) => {
      expect(await printRepeated(el, OVER_LINES)).toContain(
        `${head} for each line in lines(${settings})${tail}`,
      );
      expect(await printed(around({ ...el, asyncBefore: true }))).toContain(
        `${head}(${settings})${tail}`,
      );
    },
  );

  it.each([
    [
      { collection: 'lines', elementVariable: 'line' },
      'for each line in lines',
    ],
    [{ collection: 'lines' }, 'for each in lines'],
    [{ collection: 'check-close' }, 'for each in check-close'],
    [
      { collection: '${order.lines}', elementVariable: 'line' },
      'for each line in "${order.lines}"',
    ],
    [{ cardinality: '3' }, 'for 3'],
    [{ cardinality: '${n}' }, 'for n'],
    [{ cardinality: '#{lineCount}' }, 'for lineCount'],
    [{ cardinality: '${a} #{b}' }, 'for "${a} #{b}"'],
    [
      { cardinality: '3', collection: 'lines', elementVariable: 'line' },
      'for 3 each line in lines',
    ],
    [
      { collection: 'lines', elementVariable: 'line', sequential: true },
      'for each line in lines sequentially',
    ],
    [
      {
        collection: 'lines',
        elementVariable: 'line',
        sequential: true,
        completionCondition: '${nrOfCompletedInstances >= 2}',
      },
      'for each line in lines sequentially until (nrOfCompletedInstances >= 2)',
    ],
  ] as const satisfies ReadonlyArray<readonly [LoopCharacteristics, string]>)(
    'prints %j as `%s`',
    async (loop, clause) => {
      expect(
        await printRepeated({ kind: 'task', id: 'Record' }, loop),
      ).toContain(`step Record ${clause}(asyncBefore: true)`);
    },
  );

  // A bare collection needs a declaration to lower back; anything the source
  // already types, or that is no name at all, must not get a second one.
  it.each([
    [
      'declares every bare collection once, at any depth',
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'task', id: 'Record', loop: OVER_LINES },
          { kind: 'task', id: 'Price', loop: OVER_LINES },
          chainedSub('Fulfil', [
            {
              kind: 'task',
              id: 'Pick',
              loop: { collection: 'parcels', elementVariable: 'parcel' },
            },
          ]),
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'Record', 'Price', 'Fulfil', 'E'),
      ),
      ['process p {\n  var lines: any\n  var parcels: any\n'],
      [],
      1,
    ],
    [
      'declares neither the element it binds nor a collection expression',
      around({
        kind: 'task',
        id: 'Record',
        loop: { collection: '${order.lines}', elementVariable: 'line' },
      }),
      [],
      ['var '],
      0,
    ],
    [
      'leaves a collection a form field already types undeclared',
      minimalProcess(
        [
          {
            kind: 'startEvent',
            id: 'S',
            formFields: [{ id: 'lines', type: 'string' }],
          },
          { kind: 'task', id: 'Record', loop: OVER_LINES },
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'Record', 'E'),
      ),
      ['form {\n      lines: string\n    }'],
      ['var lines'],
      0,
    ],
    [
      'leaves a collection a catch binding already types undeclared',
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'task', id: 'Record', loop: { collection: 'c' } },
          { kind: 'task', id: 'Note', loop: { collection: 'm' } },
          { kind: 'task', id: 'Escalate', loop: { collection: 'x' } },
          { kind: 'endEvent', id: 'E' },
          eventHandler(
            'H',
            'HS',
            errorDef('BOOM', { codeVariable: 'c', messageVariable: 'm' }),
          ),
          eventHandler('G', 'GS', escalationDef('OVER', 'x')),
        ],
        flowChain('S', 'Record', 'Note', 'Escalate', 'E'),
      ),
      ['on error(BOOM, code: c, message: m)', 'on escalation(OVER, code: x)'],
      ['var '],
      0,
    ],
  ] as const)('%s', async (_title, ir, has, hasNot, declarations) => {
    const dsl = await printed(ir);
    for (const text of has) expect(dsl).toContain(text);
    for (const text of hasNot) expect(dsl).not.toContain(text);
    expect(dsl.match(/var lines: any/g) ?? []).toHaveLength(declarations);
  });
});

// BPMN has no slot for `var`, so the print declares every root the validator
// would otherwise report as undeclared, and nothing a form field, a catch
// binding, an io parameter, an element variable or a repetition's engine
// counters already type.
describe('irToDsl: the header declares every variable the body reads bare', () => {
  it('declares each bare read once, typed any, in the order it appears', async () => {
    const ir = minimalProcess(
      [
        {
          kind: 'startEvent',
          id: 'S',
          formFields: [{ id: 'approved', type: 'boolean' }],
        },
        {
          kind: 'task',
          id: 'Batch',
          loop: {
            cardinality: '${count}',
            completionCondition: '${nrOfCompletedInstances > 1}',
          },
        },
        {
          ...callActivity('Sub', 'sub'),
          inMappings: [{ kind: 'variable', source: 'source', target: 'y' }],
          outMappings: [{ kind: 'variable', source: 'result', target: 'z' }],
        },
        {
          ...serviceTask('Fetch', {
            kind: 'external',
            topic: 't',
            errorMappings: [
              {
                errorCode: 'FAIL',
                condition: '${externalTask.retries > 2 && flag}',
              },
            ],
          }),
          outputParameters: [ioParam('x', textValue('1'))],
        },
        boundaryEvent(
          'Boundary_Fetch_error',
          'Fetch',
          errorDef('FAIL', { codeVariable: 'c' }),
        ),
        { kind: 'userTask', id: 'Repair' },
        { kind: 'endEvent', id: 'Failed' },
        typedEvent(
          'intermediateCatchEvent',
          'Wait',
          conditionDef('${x && c == "FAIL"}'),
        ),
        gateway('G', 'F_else'),
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        gateway('J'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        ...flowChain('S', 'Batch', 'Sub', 'Fetch', 'Wait', 'G'),
        edge('Boundary_Fetch_error', 'Repair'),
        edge('Repair', 'Failed'),
        edge('G', 'A', { condition: '${approved}' }),
        edge('G', 'B', { id: 'F_else' }),
        edge('A', 'J'),
        edge('B', 'J'),
        edge('J', 'E'),
      ],
    );

    const dsl = await printed(ir);
    expect(dsl.split('\n').filter((line) => line.startsWith('  var '))).toEqual(
      ['  var count: any', '  var source: any', '  var flag: any'],
    );
    const { diagnostics } = await validate(dsl);
    expect(diagnostics.map((d) => d.message)).toEqual([]);
  });
});

// The `run*` settings sit in the same parens as the statement's own, after
// them, and read back onto the loop rather than the step.
describe('irToDsl: per-run settings on a repetition', () => {
  const RUN_LOOP: LoopCharacteristics = {
    cardinality: '3',
    asyncBefore: true,
    asyncAfter: true,
    exclusive: false,
    retryCycle: 'R2/PT1M',
  };

  it.each([
    [
      "a service's run keys follow its own settings",
      {
        ...serviceTask(
          'WarmPricing',
          classBinding('com.example.WarmPricingDelegate'),
        ),
        asyncBefore: true,
        retryCycle: 'R3/PT10M',
        loop: RUN_LOOP,
      },
      'service WarmPricing for 3(class: "com.example.WarmPricingDelegate", ' +
        'asyncBefore: true, retryCycle: "R3/PT10M", runAsyncBefore: true, ' +
        'runAsyncAfter: true, runExclusive: false, runRetryCycle: "R2/PT1M")',
    ],
    [
      "a subprocess's run keys follow its own settings",
      {
        ...chainedSub('Fulfil', [{ kind: 'userTask', id: 'Inner' }]),
        asyncBefore: true,
        retryCycle: 'R3/PT10M',
        loop: RUN_LOOP,
      },
      'subprocess Fulfil for 3(asyncBefore: true, retryCycle: "R3/PT10M", ' +
        'runAsyncBefore: true, runAsyncAfter: true, runExclusive: false, ' +
        'runRetryCycle: "R2/PT1M") {',
    ],
  ] as const)('%s and read back onto the loop', async (_title, el, head) => {
    const dsl = await printed(around(el));
    expect(dsl).toContain(head);
    const back = (await reDesugar(dsl)).flowElements.find(
      (e): e is Extract<FlowElement, Repeatable> => e.id === el.id,
    )!;
    expect(back.loop).toEqual(RUN_LOOP);
    expect([back.asyncBefore, back.retryCycle]).toEqual([true, 'R3/PT10M']);
  });
});

// The printer's escaping and the lexer's unescaping have to be exact inverses,
// so the re-parse is the assertion, not the printed text. The adversarial rows
// open with `${`: that body lexes as a raw expression, whose reader strips the
// quotes without unescaping, so every escape inside would come back doubled.
describe('irToDsl: prose comes back byte for byte', () => {
  /** Each shape, the prose, and whether printing it needs a backslash at all. */
  const PROSE = [
    ['plain prose', 'Review the order', false],
    ['prose holding a quote', 'Review the "rush" order', true],
    ['prose holding a backslash', 'Review C:\\orders\\rush', true],
    ['prose opening with a template', '${orderId} is the reference', true],
    ['prose holding a template', 'Reference ${orderId} was confirmed', false],
    ['prose opening with a bare dollar', '$50 is the threshold', false],
    ['prose spanning two lines', 'Review the order.\nThen release it.', true],
    ['prose holding a carriage return', 'Review the order.\rNow.', true],
    [
      'prose spanning two lines the way a text editor ends them',
      'Review the order.\r\nThen release it.',
      true,
    ],
    [
      'prose opening with a template and holding a quote',
      '${orderId} is the "rush" reference',
      true,
    ],
    [
      'prose opening with a template and spanning two lines',
      '${orderId}\nis the reference',
      true,
    ],
  ] as const;

  /** Each prose setting and the IR field it is written from. */
  const SLOTS = [
    ['label', 'name'],
    ['documentation', 'documentation'],
  ] as const;

  it.each(
    PROSE.flatMap(([shape, text, escapes]) =>
      SLOTS.map(
        ([setting, field]) =>
          [`${setting}, ${shape}`, field, text, escapes] as const,
      ),
    ),
  )('%s', async (_title, field, text, escapes) => {
    const carrying = (
      value: string,
    ): { name?: string; documentation?: string } =>
      field === 'name' ? { name: value } : { documentation: value };
    const print = (value: string): Promise<string> =>
      printed(around({ kind: 'userTask', id: 'Review', ...carrying(value) }));

    const dsl = await print(text);
    // A statement prints on one line whatever its prose holds; a lone carriage
    // return breaks a line for every reader of the file, so it counts too.
    expect(dsl.split(/\r\n|\r|\n/)).toHaveLength(
      (await print('Review the order')).split(/\r\n|\r|\n/).length,
    );
    // An escape no terminal asks for is noise in source somebody reads.
    expect(dsl.includes('\\')).toBe(escapes);

    const back = await reDesugar(dsl);
    const [review] = back.flowElements.filter(
      (el): el is Extract<FlowElement, { kind: 'userTask' }> =>
        el.kind === 'userTask',
    );
    expect({
      name: review?.name,
      documentation: review?.documentation,
    }).toEqual({
      name: undefined,
      documentation: undefined,
      ...carrying(text),
    });
  });
});

/**
 * What each report says, keyed by the degradation it reports. `says` is every
 * phrase its message must carry; `never` is the phrase of a neighbouring report
 * it must not, which is what keeps two of them from collapsing into one.
 */
const REPORT = {
  label: { category: 'label', says: ['block structure'] },
  documentation: {
    category: 'documentation',
    says: ['block structure', 'carry it'],
    // The two facts are reported apart, so neither message may state the other.
    never: ['The label'],
  },
  refusedStatement: {
    category: 'refusedStatement',
    says: ['draws an error', 'Rename the step in the model'],
  },
  droppedEdge: {
    category: 'droppedEdge',
    says: ['unstructured region', 'hand-repair'],
  },
  degradedSplit: {
    category: 'degradedSplit',
    says: [
      'leaves as a jump',
      'or as a marker',
      'written on its jump',
      'at most one branch is left running',
    ],
  },
  emptySplit: {
    category: 'degradedSplit',
    says: ['no route out', 'left out of the script'],
  },
  crossBranchJump: {
    category: 'refusedStatement',
    says: ['crosses', 'draws an error'],
    // The reserved-name report's remedy, which renames nothing here.
    never: ['Rename the step'],
  },
  inventedFallback: {
    category: 'defaultFlow',
    says: ['names no fallback', 'what runs changes'],
  },
  raceCondition: {
    category: 'droppedCondition',
    says: [
      'weighs a branch of this wait',
      'takes the first to resolve',
      'the run is the same without it',
    ],
    never: ['stops the run with an error'],
  },
  droppedFlowCondition: {
    category: 'droppedCondition',
    says: ['stops the run with an error', 'carries straight on'],
  },
  divertedRun: {
    category: 'droppedCondition',
    says: ['leaves by another route'],
    never: ['stops the run with an error'],
  },
  unweighedBranch: {
    category: 'droppedCondition',
    says: ['takes every route', 'the run is the same without it'],
    never: ['stops the run'],
  },
  forkFallbackCondition: {
    category: 'defaultFlow',
    says: ['weighs the fallback', 'the run is the same without it'],
    never: ['stops the run'],
  },
  choiceFallbackCondition: {
    category: 'defaultFlow',
    says: ['weighs the fallback', 'refuses to deploy'],
    // What a fork that opens every branch reads instead: weighing the fallback
    // of a choice is what the engine refuses, so the run is not the same.
    never: ['the run is the same without it'],
  },
  deadFallback: {
    category: 'defaultFlow',
    says: ['nothing is ever left over', 'draws an error'],
  },
  droppedSetting: {
    category: 'droppedSetting',
    says: ['engine settings', 'block structure', 'runs without them'],
  },
  renamedId: {
    category: 'renamedId',
    says: ['written as', 'activity id'],
  },
} as const satisfies Record<
  string,
  {
    category: PrintWarning['category'];
    says: readonly string[];
    never?: readonly string[];
  }
>;

/** BPMN vocabulary no report may spend on a reader who never drew a diagram. */
const JARGON = ['flow node', 'gateway', 'token', 'sequence flow'];

/** The reports raised, in order, each matched on category, element, phrases and the plain-words rule. */
function expectReports(
  warnings: readonly PrintWarning[],
  ...expected: readonly (readonly [keyof typeof REPORT, string])[]
): void {
  expect(warnings.map((w) => [w.category, w.elementId])).toEqual(
    expected.map(([name, id]) => [REPORT[name].category, id]),
  );
  expected.forEach(([name], i) => {
    const report: { says: readonly string[]; never?: readonly string[] } =
      REPORT[name];
    const { message } = warnings[i]!;
    for (const phrase of report.says) expect(message).toContain(phrase);
    for (const phrase of report.never ?? []) {
      expect(message, `${name} must not say "${phrase}"`).not.toContain(phrase);
    }
    for (const word of JARGON) {
      expect(
        message.toLowerCase(),
        `${name} must not use "${word}": ${message}`,
      ).not.toContain(word);
    }
  });
}

/** How a route is written where the test cares: its flow id, its condition. */
type Route = { id?: string; condition?: string };

/** A loop closed by a second split, whose routes back round the loop and on to the end `back` and `on` name and weigh. */
const loopIntoSplitIr = (
  split: FlowElement,
  back: Route,
  on: Route,
): BpmnProcess =>
  minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Loop'),
      { kind: 'userTask', id: 'Review' },
      split,
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Loop'),
      edge('Loop', 'Review', { condition: '${again}' }),
      edge('Review', split.id),
      edge(split.id, 'Loop', back),
      edge(split.id, 'E', on),
      edge('Loop', 'E'),
    ],
  );

/**
 * A loop head before the body (a `while`) or after it (a `do`), the route
 * round it named and weighed by `back`, and weighed escapes each leaving the
 * head for a step that ends the run.
 */
const loopWithEscapesIr = ({
  shape = 'pre',
  head,
  body,
  back,
  escapes,
}: {
  shape?: 'pre' | 'post';
  head: FlowElement;
  body: string;
  back: Route;
  escapes: readonly (readonly [string, string])[];
}): BpmnProcess => {
  const pre = shape === 'pre';
  return minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      ...(pre ? [head] : []),
      { kind: 'userTask', id: body },
      ...(pre ? [] : [head]),
      ...escapes.map(([id]): FlowElement => ({ kind: 'userTask', id })),
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', pre ? head.id : body),
      pre ? edge(head.id, body, back) : edge(body, head.id),
      pre ? edge(body, head.id) : edge(head.id, body, back),
      ...escapes.map(([id, condition]) => edge(head.id, id, { condition })),
      ...escapes.map(([id]) => edge(id, 'E')),
    ],
  );
};

describe('warnings: text the script has nowhere to write', () => {
  const splitIr = (name?: string): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'exclusiveGateway',
          id: 'Split_1',
          ...(name === undefined ? {} : { name }),
        },
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'exclusiveGateway', id: 'Join_1' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Split_1'),
        edge('Split_1', 'A', { condition: 'ok' }),
        edge('Split_1', 'B'),
        edge('A', 'Join_1'),
        edge('B', 'Join_1'),
        edge('Join_1', 'E'),
      ],
    );

  it('reports the label on a split, says nothing about a split without one, and leaves the printed source alone', async () => {
    const named = printDsl(splitIr('Amount check'));
    const plain = printDsl(splitIr());

    expect(named.source).toBe(await printed(splitIr()));
    expect(plain.warnings).toEqual([]);
    expectReports(named.warnings, ['label', 'Split_1']);
    expect(named.warnings[0]?.message).toContain("'Amount check'");
  });

  const forkIr = (named: 'fork' | 'join'): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'parallelGateway',
          id: 'Fork_1',
          ...(named === 'fork' ? { name: 'Split work' } : {}),
        },
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        {
          kind: 'parallelGateway',
          id: 'Join_1',
          ...(named === 'join' ? { name: 'Split work' } : {}),
        },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Fork_1'),
        edge('Fork_1', 'A'),
        edge('Fork_1', 'B'),
        edge('A', 'Join_1'),
        edge('B', 'Join_1'),
        edge('Join_1', 'E'),
      ],
    );

  it.each([
    ['fork', 'Fork_1'],
    ['join', 'Join_1'],
  ] as const)('reports the label on a parallel %s', (which, id) => {
    expectReports(printDsl(forkIr(which)).warnings, ['label', id]);
  });

  it('reaches a split nested in a sub-process and one in an event handler', () => {
    const { warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          chainedSub('Sub', [
            { kind: 'startEvent', id: 'NS' },
            { kind: 'exclusiveGateway', id: 'NSplit', name: 'nested pick' },
            { kind: 'endEvent', id: 'NE' },
          ]),
          { kind: 'endEvent', id: 'E' },
          triggeredSub('H', [
            { kind: 'startEvent', id: 'HS', eventDefinition: signalDef('go') },
            { kind: 'exclusiveGateway', id: 'HSplit', name: 'handler pick' },
            { kind: 'endEvent', id: 'HE' },
          ]),
        ],
        flowChain('S', 'Sub', 'E'),
      ),
    );

    expectReports(warnings, ['label', 'NSplit'], ['label', 'HSplit']);
  });

  /** Every gateway has one way in and one out, so the print walks straight through them all. */
  const gatewayTextIr = (carried: boolean): BpmnProcess => {
    const text = (documentation: string) => (carried ? { documentation } : {});
    return minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'exclusiveGateway',
          id: 'Choice',
          ...(carried ? { name: 'Amount check' } : {}),
          ...text('Small orders skip the review.'),
        },
        { kind: 'parallelGateway', id: 'Fork', ...text('Both routes run.') },
        {
          kind: 'inclusiveGateway',
          id: 'Some',
          ...text('Whichever conditions hold.'),
        },
        { kind: 'eventBasedGateway', id: 'Race', ...text('First reply wins.') },
        chainedSub('Sub', [
          { kind: 'startEvent', id: 'NS' },
          {
            kind: 'exclusiveGateway',
            id: 'Nested',
            ...text('Nested, and reported all the same.'),
          },
          { kind: 'endEvent', id: 'NE' },
        ]),
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Choice', 'Fork', 'Some', 'Race', 'Sub', 'E'),
    );
  };

  it('reports the documentation on every gateway kind, at any depth, and leaves the printed source alone', async () => {
    const carried = printDsl(gatewayTextIr(true));
    const plain = printDsl(gatewayTextIr(false));

    expect(carried.source).toBe(await printed(gatewayTextIr(false)));
    expect(plain.warnings).toEqual([]);
    expectReports(
      carried.warnings,
      ['label', 'Choice'],
      ['documentation', 'Choice'],
      ['documentation', 'Fork'],
      ['documentation', 'Some'],
      ['documentation', 'Race'],
      ['documentation', 'Nested'],
    );
  });
});

describe('warnings: edges with no form in the script', () => {
  // `Ring1` and `Ring2` hand the forwarding walk to each other, so it comes
  // back to where it started and the edge takes the marker instead of a jump.
  it('drops an arrival at a ring of one-way gateways', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        gateway('Ring1'),
        gateway('Ring2'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'A'),
        edge('S', 'Ring1'),
        edge('A', 'E'),
        edge('Ring1', 'Ring2'),
        edge('Ring2', 'Ring1'),
      ],
    );
    const ring = printDsl(ir);

    expect(ring.source).toContain(
      `${UNSTRUCTURED_MARKER} (dropped edge into Ring1)`,
    );
    expect(ring.source).not.toContain('goto Ring');
    // `S` leaves on two routes with no merge to close them, which is its own
    // report, and the ring is reached twice: once from the jump that opens on
    // it, and once from the sweep that picks up what the walk left unprinted.
    expectReports(
      ring.warnings,
      ['degradedSplit', 'S'],
      ['droppedEdge', 'Ring1'],
      ['droppedEdge', 'Ring1'],
    );
    await printed(ir);
  });

  // Only the exact `StartEvent_p` is the compiler's; the suffixed id it mints
  // past a taken name is not, so a second plain start keeps its statement. The
  // two plain starts are the model's, so the print reports nothing and the
  // validator refuses them on the way back.
  it('a second plain start beside the synthesized one prints under its own id, and the validator reports the second default start', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'StartEvent_p' },
        { kind: 'startEvent', id: 'StartEvent_p_2' },
        { kind: 'userTask', id: 'V' },
        { kind: 'endEvent', id: 'E' },
      ],
      [edge('StartEvent_p', 'V'), edge('StartEvent_p_2', 'V'), edge('V', 'E')],
    );
    const { source, warnings } = printDsl(ir);

    expect(warnings).toEqual([]);
    expect(source.split('\n').filter((l) => l.startsWith('  start '))).toEqual([
      '  start StartEvent_p_2',
    ]);
    await printed(ir, 'secondDefaultStart');
  });
});

describe('irToDsl: several starts entering one step', () => {
  it.each([
    [
      'two starts that both end at once print back to back, and the implicit end stays unwritten',
      'process p { start S1  start S2 condition(x) }',
      [
        'process p {',
        '  var x: any',
        '  start S1',
        '  start S2 condition(x)',
        '}',
      ],
    ],
    [
      'starts entering a synthesized split print ahead of the branch, which prints once',
      'process p { start A  start B message("M")  if (x) { user T1 } else { user T2 }  end E }',
      [
        'process p {',
        '  var x: any',
        '  start A',
        '  start B message("M")',
        '  if (x) {',
        '    user T1',
        '  } else {',
        '    user T2',
        '  }',
        '  end E',
        '}',
      ],
    ],
    [
      // The compiler re-derives the elided start only at a body that opens
      // with no `start`, so its chain prints alone and the starts sharing its
      // step jump onto it as one group.
      'the unnamed plain start heads the body alone wherever the model lists it, and the starts sharing its step jump onto it together',
      minimalProcess(
        [
          typedEvent('startEvent', 'B', messageDef('M')),
          { kind: 'startEvent', id: 'StartEvent_p' },
          typedEvent('startEvent', 'C', signalDef('S')),
          { kind: 'userTask', id: 'V' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('B', 'V'),
          edge('StartEvent_p', 'V'),
          edge('C', 'V'),
          edge('V', 'E'),
        ],
      ),
      [
        'process p {',
        '  user V',
        '  end E',
        '  start B message("M")',
        '  start C signal("S")',
        '  goto V',
        '}',
      ],
    ],
  ] as const)('%s', async (_title, fixture, source) => {
    const ir = typeof fixture === 'string' ? await reDesugar(fixture) : fixture;
    expect(await expectIdempotent(ir)).toEqual(`${source.join('\n')}\n`);
    expect(printDsl(ir).warnings).toEqual([]);
  });
});

describe('warnings: a split the script has no form for', () => {
  // A fork with nothing to rejoin at: every edge keeps a jump, so nothing is
  // dropped and this report is the only trace that the split itself is gone.
  it('reports the fork it wrote as jumps, and drops no edge doing it', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
        { kind: 'endEvent', id: 'X' },
        { kind: 'endEvent', id: 'Y' },
      ],
      [
        edge('S', 'Gateway_p_1_fork'),
        edge('Gateway_p_1_fork', 'X'),
        edge('Gateway_p_1_fork', 'Y'),
      ],
    );
    const { warnings } = printDsl(ir);
    // Each jump in a branch of its own, so the source still compiles: a second
    // jump written beside the first could never run.
    const source = await printed(ir);

    expect(source).not.toContain('parallel {');
    expect(source).toContain('goto X');
    expect(source).toContain('goto Y');
    expect(source).toContain(
      `${UNSTRUCTURED_MARKER} (split Gateway_p_1_fork degraded to jumps; was parallel)`,
    );
    expect(source).not.toContain('dropped edge');
    expectReports(warnings, ['degradedSplit', 'Gateway_p_1_fork']);
  });
});

describe('irToDsl: a step whose own routes split', () => {
  /**
   * `A` leaves on `routes`, which meet again at `merge` before `E`. The engine
   * takes every route whose condition holds or that carries none, and the
   * fallback alone when none was taken, so they print as the fork block that
   * reads back the same way.
   */
  const stepSplitIr = (
    routes: readonly (readonly [target: string, route: Route])[],
    merge: FlowElement,
    defaultFlowId?: string,
  ): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'userTask',
          id: 'A',
          ...(defaultFlowId === undefined ? {} : { defaultFlowId }),
        },
        ...routes.map(([id]): FlowElement => ({ kind: 'userTask', id })),
        merge,
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'A'),
        ...routes.map(([id, route]) => edge('A', id, route)),
        ...routes.map(([id]) => edge(id, merge.id)),
        edge(merge.id, 'E'),
      ],
    );

  const block = (...body: string[]): string =>
    body.map((line) => `  ${line}\n`).join('');

  // Revert symptoms: `followLinear` handing every multi-route step to the
  // choice chain -> the two-plain-routes row prints `if (true)`; the
  // if/else shape not kept -> the fallback row prints `parallel {`;
  // `emitJumps` unweighed -> the implicit-merge row loses its marker line.
  it.each<
    [
      title: string,
      ir: BpmnProcess,
      body: string,
      reports: (readonly [keyof typeof REPORT, string])[],
      refused: (keyof typeof MODEL_REFUSAL)[],
      gains?: string[],
    ]
  >([
    [
      'two plain routes print as a parallel block',
      stepSplitIr(
        [
          ['B', {}],
          ['C', {}],
        ],
        { kind: 'parallelGateway', id: 'J' },
      ),
      block(
        'parallel {',
        '  {',
        '    user B',
        '  }',
        '  {',
        '    user C',
        '  }',
        '}',
        'end E',
      ),
      [],
      [],
    ],
    [
      'two plain routes into an implicit merge degrade to jumps under the marker',
      stepSplitIr(
        [
          ['B', {}],
          ['C', {}],
        ],
        { kind: 'userTask', id: 'D' },
      ),
      block(
        `${UNSTRUCTURED_MARKER} (split A degraded to jumps; was parallel)`,
        'if (true) {',
        '  goto B',
        '} else {',
        '  goto C',
        '}',
        'user B',
        'user D',
        'end E',
        'user C',
        'goto D',
      ),
      [['degradedSplit', 'A']],
      [],
    ],
    [
      'a weighed route beside a plain one prints as an inclusive block',
      stepSplitIr(
        [
          ['B', { condition: '${ok}' }],
          ['C', {}],
        ],
        { kind: 'inclusiveGateway', id: 'J' },
      ),
      block(
        'parallel {',
        '  if (ok) {',
        '    user B',
        '  }',
        '  {',
        '    user C',
        '  }',
        '}',
        'end E',
      ),
      [],
      [],
    ],
    [
      'one weighed route beside the fallback keeps the if/else, which routes the same',
      stepSplitIr(
        [
          ['B', { condition: '${ok}' }],
          ['C', { id: 'F_c' }],
        ],
        gateway('M'),
        'F_c',
      ),
      block('if (ok) {', '  user B', '} else {', '  user C', '}', 'end E'),
      [],
      [],
    ],
    [
      'a weighed route, a plain one and the fallback print as an inclusive block whose fallback nothing reaches',
      stepSplitIr(
        [
          ['B', { condition: '${ok}' }],
          ['C', {}],
          ['D', { id: 'F_d' }],
        ],
        { kind: 'inclusiveGateway', id: 'J' },
        'F_d',
      ),
      block(
        'parallel {',
        '  if (ok) {',
        '    user B',
        '  }',
        '  {',
        '    user C',
        '  }',
        '  else {',
        '    user D',
        '  }',
        '}',
        'end E',
      ),
      [['deadFallback', 'A']],
      ['deadElse'],
    ],
    [
      'two weighed routes and no fallback print as an inclusive block that invents one',
      stepSplitIr(
        [
          ['B', { condition: '${a}' }],
          ['C', { condition: '${b}' }],
        ],
        { kind: 'inclusiveGateway', id: 'J' },
      ),
      block(
        'parallel {',
        '  if (a) {',
        '    user B',
        '  }',
        '  if (b) {',
        '    user C',
        '  }',
        '}',
        'end E',
      ),
      [['inventedFallback', 'A']],
      [],
      // The block closes with no `else`, so the recompiled split gains a
      // fallback into the merge that the model never had.
      ['A->E'],
    ],
  ])('%s', async (_title, ir, body, reports, refused, gains = []) => {
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      'process p {\n  start S\n  user A\n' + body + '}\n',
    );
    expectReports(warnings, ...reports);
    await printed(ir, ...refused);
    expect(realReachability(await reDesugar(source))).toEqual(
      new Set([...realReachability(ir), ...gains]),
    );
  });

  it('prints the one route a loop left a step as the fall-through, as it does for a fork', () => {
    // The loop prints `Review`'s route back as its closing brace, leaving one
    // weighed route at the step's position, and plain flow has nowhere to
    // write its condition.
    const { warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          gateway('Loop'),
          { kind: 'userTask', id: 'Review' },
          { kind: 'userTask', id: 'Escalate' },
          { kind: 'userTask', id: 'Settle' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'Loop'),
          edge('Loop', 'Review', { condition: '${again}' }),
          edge('Loop', 'Settle'),
          edge('Review', 'Loop'),
          edge('Review', 'Escalate', { condition: '${overdue}' }),
          edge('Escalate', 'E'),
          edge('Settle', 'E'),
        ],
      ),
    );

    expectReports(warnings, ['droppedFlowCondition', 'Review']);
  });
});

describe('irToDsl: a split degraded to jumps keeps its conditions on them', () => {
  it('writes each weighed route on its own jump under a marker naming the split and its kind', async () => {
    // A boundary chain enters the merge too, so it is not the fork's own and
    // the fork has no block.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Order' },
        { kind: 'inclusiveGateway', id: 'Fork' },
        { kind: 'userTask', id: 'Charge' },
        { kind: 'userTask', id: 'Invoice' },
        { kind: 'inclusiveGateway', id: 'Join' },
        boundaryEvent('Late', 'Order', timerDef('duration', 'PT1M')),
        { kind: 'userTask', id: 'Remind' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Order'),
        edge('Order', 'Fork'),
        edge('Fork', 'Charge', { condition: '${online}' }),
        edge('Fork', 'Invoice', { condition: '${cash}' }),
        edge('Charge', 'Join'),
        edge('Invoice', 'Join'),
        edge('Late', 'Remind'),
        edge('Remind', 'Join'),
        edge('Join', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain(
      `  ${UNSTRUCTURED_MARKER} (split Fork degraded to jumps; was inclusive)\n` +
        '  if (online) {\n' +
        '    goto Charge\n' +
        '  } else if (cash) {\n' +
        '    goto Invoice\n' +
        '  }\n',
    );
    expectReports(warnings, ['degradedSplit', 'Fork']);
    await printed(ir);
  });

  it('keeps a race off the block form when a wait routes on twice, and forks the wait itself', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Race' },
        typedEvent(
          'intermediateCatchEvent',
          'C1',
          timerDef('duration', 'PT1M'),
        ),
        typedEvent('intermediateCatchEvent', 'C2', messageDef('m')),
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Race'),
        edge('Race', 'C1'),
        edge('Race', 'C2'),
        edge('C1', 'A'),
        edge('C1', 'B'),
        edge('C2', 'E'),
        edge('A', 'E'),
        edge('B', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain(
      `${UNSTRUCTURED_MARKER} (split Race degraded to jumps; was event-based)`,
    );
    expect(source).toContain(
      `${UNSTRUCTURED_MARKER} (split C1 degraded to jumps; was parallel)`,
    );
    expectReports(warnings, ['degradedSplit', 'Race'], ['degradedSplit', 'C1']);
    await printed(ir);
  });
});

describe('irToDsl: a split with no route out', () => {
  // Revert symptom: the check in `emitNode` removed -> every row's list is [].
  it.each([
    [
      'a parallel split ends the run there, as the script does',
      'parallelGateway',
      'ends the run here',
    ],
    [
      'an inclusive split stops the model with an error',
      'inclusiveGateway',
      'stops the run with an error',
    ],
    [
      'a wait with nothing to wait for holds the model forever',
      'eventBasedGateway',
      'waits here forever',
    ],
    [
      'an exclusive split keeps the model from deploying',
      'exclusiveGateway',
      'refuses to deploy',
    ],
  ] as const)('%s', async (_title, kind, says) => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind, id: 'G' },
      ],
      [edge('S', 'G')],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toBe('process p {\n  start S\n}\n');
    expectReports(warnings, ['emptySplit', 'G']);
    expect(warnings[0]!.message).toContain(says);
    await printed(ir);
  });
});

describe('irToDsl: a split that routes back into itself', () => {
  // Revert symptom: the same-node filter in `tryWhile` removed -> the plain
  // row prints `while (go) {`; in `tryDoWhileEntry` -> the weighed row prints
  // `do {`.
  it.each([
    [
      'a plain route back beside a weighed way on',
      gateway('G'),
      [edge('G', 'G'), edge('G', 'A', { condition: '${go}' })],
      '  if (go) {\n' +
        '  } else {\n' +
        `    ${UNSTRUCTURED_MARKER} (dropped edge into G)\n` +
        '  }\n',
    ],
    [
      'a weighed route back beside the fallback',
      gateway('G', 'F_on'),
      [
        edge('G', 'G', { condition: '${again}' }),
        edge('G', 'A', { id: 'F_on' }),
      ],
      '  if (again) {\n' +
        `    ${UNSTRUCTURED_MARKER} (dropped edge into G)\n` +
        '  }\n',
    ],
  ] as const)(
    '%s prints the marker rather than a loop',
    async (_title, split, routes, chain) => {
      const ir = minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          split,
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        [edge('S', 'G'), ...routes, edge('A', 'E')],
      );
      const { source, warnings } = printDsl(ir);

      expect(bodyOf(source)).toBe(
        'process p {\n  start S\n' + chain + '  user A\n  end E\n}\n',
      );
      expectReports(warnings, ['droppedEdge', 'G']);
      await printed(ir);
    },
  );
});

describe('irToDsl: a jump into a branch of a fork or a race', () => {
  it('reports the jump the script refuses, from the sibling branch it was printed in', async () => {
    // `B` is reached from the split inside the first branch and from the fork
    // itself. The first branch walks it inline, so the second branch reaches
    // it printed and jumps, across the border the validator guards.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'parallelGateway', id: 'Fork' },
        gateway('X'),
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'parallelGateway', id: 'Join' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Fork'),
        edge('Fork', 'X'),
        edge('X', 'A', { condition: '${a}' }),
        edge('X', 'B', { condition: '${b}' }),
        edge('A', 'Join'),
        edge('Fork', 'B'),
        edge('B', 'Join'),
        edge('Join', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    {\n' +
        '      if (a) {\n' +
        '        user A\n' +
        '      } else if (b) {\n' +
        '        user B\n' +
        '      }\n' +
        '    }\n' +
        '    {\n' +
        '      goto B\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expectReports(
      warnings,
      ['inventedFallback', 'X'],
      ['crossBranchJump', 'B'],
    );
    const errors = (await validate(source)).diagnostics
      .filter((d) => d.severity === 1)
      .map((d) =>
        typeof d.message === 'string' ? d.message : d.message.value,
      );
    expect(errors).toEqual([
      expect.stringContaining("'goto B' jumps into a branch of a 'parallel'"),
    ]);
  });

  it('says nothing about a jump written inside the branch it lands in', async () => {
    // A loop headed by a merge, closed by a jump to the merge's successor,
    // all of it inside the first branch.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'parallelGateway', id: 'Fork' },
        gateway('Head'),
        { kind: 'userTask', id: 'A' },
        gateway('Again', 'F_out'),
        { kind: 'userTask', id: 'Retry' },
        { kind: 'userTask', id: 'B' },
        { kind: 'parallelGateway', id: 'Join' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Fork'),
        edge('Fork', 'Head'),
        edge('Head', 'A'),
        edge('A', 'Again'),
        edge('Again', 'Retry', { condition: '${retry}' }),
        edge('Retry', 'Head'),
        edge('Again', 'Join', { id: 'F_out' }),
        edge('Fork', 'B'),
        edge('B', 'Join'),
        edge('Join', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('        user Retry\n        goto A\n');
    expect(warnings).toEqual([]);
    await printed(ir);
  });
});

describe('irToDsl: a guard clause whose branch opens on a split', () => {
  it('walks the branch inline instead of dropping the edge into the split', async () => {
    // The outer split names a fallback that carries the main flow, and the
    // branch it guards opens on a second split whose every route is weighed:
    // one ends, one runs on into the continuation.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('Outer', 'F_on'),
        gateway('Inner'),
        { kind: 'endEvent', id: 'Rejected' },
        { kind: 'userTask', id: 'Fix' },
        { kind: 'userTask', id: 'Ship' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Outer'),
        edge('Outer', 'Inner', { condition: '${flagged}' }),
        edge('Outer', 'Ship', { id: 'F_on' }),
        edge('Inner', 'Rejected', { condition: '${severe}' }),
        edge('Inner', 'Fix', { condition: '${minor}' }),
        edge('Fix', 'Ship'),
        edge('Ship', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  if (flagged) {\n' +
        '    if (severe) {\n' +
        '      end Rejected\n' +
        '    } else if (minor) {\n' +
        '      user Fix\n' +
        '    }\n' +
        '  }\n' +
        '  user Ship\n' +
        '  end E\n' +
        '}\n',
    );
    expectReports(warnings, ['inventedFallback', 'Inner']);
    await printed(ir);
  });
});

describe('irToDsl: a branch walk stops where the block comes back together', () => {
  // The post-dominator queries miss every one of these: a branch that can
  // end takes the split's post-dominator to the exit, and a step that loops
  // on itself leaves the whole graph with none. Each row is the shape as the
  // compiler lowers it, so the print has to come back as written.
  it.each([
    [
      'a throw guard with no else prints the continuation after it at the body level, no gateway named',
      [
        'process p {',
        '  error BOOM',
        '  start S',
        '  service Pre(class: "x.Pre")',
        '  if (amount > 1000) {',
        '    throw error(BOOM)',
        '  }',
        '  service Post(class: "x.Post")',
        '  end Done',
        '}',
      ],
    ],
    [
      'a throw guard inside a loop body keeps the statement after it inside the loop',
      [
        'process p {',
        '  error X',
        '  start S',
        '  while (retries < 3) {',
        '    service A(class: "x.A")',
        '    if (retries < 1) {',
        '      throw error(X)',
        '    }',
        '    service B(class: "x.B")',
        '  }',
        '  end Done',
        '}',
      ],
    ],
    [
      'a fork with a throwing branch prints the throw inline and the continuation after the block',
      [
        'process p {',
        '  error BOOM(message: "it broke")',
        '  start Begin',
        '  parallel {',
        '    {',
        '      service A(label: "a", class: "x.A")',
        '    }',
        '    {',
        '      throw error(BOOM)',
        '    }',
        '  }',
        '  end Finish',
        '}',
      ],
    ],
    [
      'a fork whose ending branch runs a step first still joins the survivor at the merge',
      [
        'process p {',
        '  start Begin',
        '  parallel {',
        '    {',
        '      user A',
        '    }',
        '    {',
        '      user B',
        '      end Abandoned terminate',
        '    }',
        '  }',
        '  end Finish',
        '}',
      ],
    ],
    [
      'a fork whose surviving branches each hold a nested fork resumes after the outer join, not the first inner one',
      [
        'process p {',
        '  error BOOM(message: "it broke")',
        '  start Begin',
        '  parallel {',
        '    {',
        '      parallel {',
        '        {',
        '          service A(label: "a", class: "x.A")',
        '        }',
        '        {',
        '          service B(label: "b", class: "x.B")',
        '        }',
        '      }',
        '    }',
        '    {',
        '      parallel {',
        '        {',
        '          service C(label: "c", class: "x.C")',
        '        }',
        '        {',
        '          service D(label: "d", class: "x.D")',
        '        }',
        '      }',
        '    }',
        '    {',
        '      throw error(BOOM)',
        '    }',
        '  }',
        '  end Finish',
        '}',
      ],
    ],
    [
      'a race with empty branches into a step that loops on itself prints the step after the block',
      [
        'process p {',
        '  await {',
        '    message("M") {',
        '    }',
        '    timer("PT1H") {',
        '    }',
        '  }',
        '  user A',
        '  goto A',
        '}',
      ],
    ],
    [
      'a race whose branch holds a throw guard stops at the merge, and the end prints after the block',
      [
        'process p {',
        '  await {',
        '    timer("PT1H") {',
        '      if (c) {',
        '        throw message("PaymentDone")',
        '      }',
        '    }',
        '    timer("PT2H") {',
        '    }',
        '  }',
        '  end Done',
        '}',
      ],
    ],
    [
      'an if chain with an ending branch, an empty branch and an else chain keeps the else, and the implicit end stays unwritten',
      [
        'process onboarding {',
        '  subprocess Sub4 {',
        '    if (true) {',
        '      end Done7',
        '    } else if (true) {',
        '    } else {',
        '      service Approve10(class: "org.acme.Audit")',
        '    }',
        '  }',
        '}',
      ],
    ],
    [
      'a fork branch holding an empty if with an ending else stops at the join, not at the else',
      [
        'process p {',
        '  parallel {',
        '    {',
        '      if (c) {',
        '      } else {',
        '        end X',
        '      }',
        '    }',
        '    {',
        '      user B',
        '    }',
        '  }',
        '  end Done',
        '}',
      ],
    ],
    [
      'a fork whose fallback runs straight into the join beside a nested fork and an ending branch takes that join',
      [
        'process p {',
        '  parallel {',
        '    if (a) {',
        '      parallel {',
        '        if (b) {',
        '          user P',
        '        }',
        '        if (c) {',
        '          user Q',
        '        }',
        '      }',
        '    }',
        '    if (d) {',
        '      end X',
        '    }',
        '  }',
        '  end Done',
        '}',
      ],
    ],
    [
      'an if whose one branch runs on to the implicit end beside two that end keeps the end unwritten',
      [
        'process p {',
        '  if (b) {',
        '    user A',
        '  } else if (c) {',
        '    user B',
        '    end D',
        '  } else {',
        '    user C',
        '    end E',
        '  }',
        '}',
      ],
    ],
    [
      'an if over a parallel beside two ending branches that share a step stops at its own join, not at that step',
      [
        'process p {',
        '  if (b) {',
        '    parallel {',
        '      {',
        '        user A1',
        '      }',
        '      {',
        '        user A2',
        '      }',
        '    }',
        '  } else if (c) {',
        '    user B',
        '    end D',
        '  } else {',
        '    user C',
        '    goto B',
        '  }',
        '}',
      ],
    ],
    [
      'an if over a parallel beside an ending else keeps the join settings on the parallel',
      [
        'process p {',
        '  if (b) {',
        '    parallel (joinAsyncBefore: true) {',
        '      {',
        '        user A1',
        '      }',
        '      {',
        '        user A2',
        '      }',
        '    }',
        '  } else {',
        '    end E',
        '  }',
        '}',
      ],
    ],
    [
      'an if with an ending else whose branch holds a nested if stops at its own join, not at the nested one',
      [
        'process p {',
        '  if (c) {',
        '    user A',
        '    if (b) {',
        '      user B1',
        '    }',
        '    user A2',
        '  } else {',
        '    end X',
        '  }',
        '}',
      ],
    ],
    [
      'a race whose one branch ends and whose other runs on to the implicit end keeps that branch whole',
      [
        'process p {',
        '  await {',
        '    message("M") {',
        '      if (x) {',
        '        emit message("PaymentDone")',
        '      } else {',
        '        user Charge',
        '      }',
        '      step Approve',
        '    }',
        '    timer("P3D") {',
        '      user Archive',
        '      end Done terminate',
        '    }',
        '  }',
        '}',
      ],
    ],
  ] as const)('%s', async (_title, lines) => {
    const source = `${lines.join('\n')}\n`;
    const ir = await reDesugar(source);
    expect(bodyOf(await expectIdempotent(ir))).toEqual(source);
    expect(printDsl(ir).warnings).toEqual([]);
  });

  // Every path into the split passes `P`, so `P` lies upstream of the block
  // and is no merge of it: taken as the join, the print would jump back to
  // it from a position nothing reaches, after a block whose every branch
  // jumps.
  it.each([
    [
      'an if whose branch and following chain both jump back to the step above the split',
      [
        'process p {',
        '  var a: any',
        '  user P',
        '  if (a) {',
        '    user A',
        '    goto P',
        '  }',
        '  user B',
        '  goto P',
        '}',
      ],
    ],
    [
      'an if whose two branches both jump back to the step above the split',
      [
        'process p {',
        '  var a: any',
        '  user P',
        '  if (a) {',
        '    user A',
        '    goto P',
        '  } else {',
        '    user B',
        '    goto P',
        '  }',
        '}',
      ],
    ],
  ] as const)(
    '%s prints as the guard clause, with the jump back outside the block',
    async (_title, lines) => {
      const ir = await reDesugar(`${lines.join('\n')}\n`);
      const source = await printed(ir);
      expect(bodyOf(source)).toEqual(
        [
          'process p {',
          '  user P',
          '  if (a) {',
          '    goto A',
          '  }',
          '  user B',
          '  goto P',
          '  user A',
          '  goto P',
          '}',
          '',
        ].join('\n'),
      );
      expect(printDsl(ir).warnings).toEqual([]);
      expect(realReachability(await reDesugar(source))).toEqual(
        realReachability(ir),
      );
    },
  );
});

describe('irToDsl: an event sub-process a flow edge leads into', () => {
  it('is refused as malformed, the import turning the flow down ahead of it', () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        eventHandler('H', 'H_Start', messageDef('m')),
      ],
      [edge('S', 'H')],
    );

    expect(() => printDsl(ir)).toThrow(/flow edge/);
  });
});

describe('warnings: a condition the script has nowhere to write', () => {
  /** `source` weighs its one route on, which the script writes as plain flow. */
  const oneWeighedRouteIr = (source: FlowElement, target = 'A'): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        source,
        { kind: 'userTask', id: 'A' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', source.id),
        edge(source.id, target, { condition: '${approved}' }),
        edge(target, 'E'),
      ],
    );

  // A split with one way out prints nothing of its own, so the report turns on
  // whether the engine reads a condition there at all: a fork opening every
  // route and a wait taking the first to resolve read none, so their reports
  // say the run is the same rather than telling the reader it changed.
  it.each([
    ['a step', { kind: 'userTask', id: 'T' }, 'droppedFlowCondition'],
    [
      'a one-way exclusive split',
      { kind: 'exclusiveGateway', id: 'G' },
      'droppedFlowCondition',
    ],
    [
      'a one-way inclusive split',
      { kind: 'inclusiveGateway', id: 'G' },
      'droppedFlowCondition',
    ],
    [
      // The fallback it names has no route, so the engine raises over the
      // missing route instead and the failure stands.
      'a split naming a fallback it has no route for',
      { kind: 'exclusiveGateway', id: 'G', defaultFlowId: 'Flow_absent' },
      'droppedFlowCondition',
    ],
    [
      'a fork that opens every route',
      { kind: 'parallelGateway', id: 'G' },
      'unweighedBranch',
    ],
    [
      'a wait that takes the first to resolve',
      { kind: 'eventBasedGateway', id: 'G' },
      'raceCondition',
    ],
  ] as const)(
    'reports the condition on the one route out of %s',
    async (_title, node, report) => {
      const ir = oneWeighedRouteIr(node);
      const { source, warnings } = printDsl(ir);

      expect(bodyOf(source)).not.toContain('approved');
      expectReports(warnings, [report, node.id]);
      await printed(ir);
    },
  );

  // A split that names a fallback is never left without a route, so the run
  // carries on by another one instead of failing; the loop spends the fallback
  // as its closing brace, leaving the weighed route to print as plain flow.
  it.each(['exclusiveGateway', 'inclusiveGateway'] as const)(
    'reports a weighed route out of a %s that names a fallback as a run that goes on elsewhere',
    async (kind) => {
      const ir = loopIntoSplitIr(
        { kind, id: 'Split', defaultFlowId: 'Flow_again' },
        { id: 'Flow_again' },
        { condition: '${settled}' },
      );
      const { source, warnings } = printDsl(ir);

      expect(source).toContain('while (again) {');
      expect(bodyOf(source)).not.toContain('settled');
      expectReports(warnings, ['divertedRun', 'Split']);
      await printed(ir);
    },
  );

  // A model the engine refuses to deploy takes no route, so the one this print
  // leaves out is not described as taken instead.
  it('keeps the run that goes on elsewhere off a split whose fallback is weighed', () => {
    const { warnings } = printDsl(
      loopIntoSplitIr(
        gateway('Split', 'Flow_again'),
        { id: 'Flow_again', condition: '${retry}' },
        { condition: '${settled}' },
      ),
    );

    expectReports(
      warnings,
      ['choiceFallbackCondition', 'Split'],
      ['droppedFlowCondition', 'Split'],
    );
  });

  it('reports it on a route the walk never reaches, which leaves as a bare jump', async () => {
    // Nothing walks a route whose source is outside the container, so the
    // closing sweep prints it as a jump, which carries nothing but the route.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'A'),
        edge('A', 'E'),
        edge('Detached', 'A', { condition: '${approved}' }),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('goto A');
    expect(bodyOf(source)).not.toContain('approved');
    expectReports(warnings, ['droppedFlowCondition', 'Detached']);
    await printed(ir, 'orphanStep');
  });
});

describe('warnings: source the compiler turns down, drawn from the model', () => {
  it('reports a name the script keeps for the names it derives itself', async () => {
    const ir = around({ kind: 'userTask', id: 'Catch_Order_Paid' });
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('user Catch_Order_Paid');
    expectReports(warnings, ['refusedStatement', 'Catch_Order_Paid']);
    await printed(ir, 'reservedId');
  });
});

const DEFAULT_FLOW_ID = 'Flow_Gateway_p_1_fork_default';

/**
 * Desugared `parallel { if (amount > 10000) { user Audit } { user Record } }`
 * with the fork's fallback placed on a third branch, the merge itself, the
 * second branch, or nowhere; `all-conditioned` names none and weighs the
 * second branch too. `fallbackCondition` weighs the fallback itself, which is
 * legal BPMN the fork never reads.
 */
function inclusiveIr(
  fallback: 'branch' | 'join' | 'none' | 'all-conditioned' | 'second-branch',
  fallbackCondition?: string,
): BpmnProcess {
  const third = fallback === 'branch';
  const named = fallback !== 'none' && fallback !== 'all-conditioned';
  const defaultEdge = {
    id: DEFAULT_FLOW_ID,
    ...(fallbackCondition === undefined
      ? {}
      : { condition: fallbackCondition }),
  };
  const recordEdge =
    fallback === 'second-branch'
      ? defaultEdge
      : fallback === 'all-conditioned'
        ? { condition: '${urgent}' }
        : {};
  return minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      {
        kind: 'inclusiveGateway',
        id: 'Gateway_p_1_fork',
        ...(named ? { defaultFlowId: DEFAULT_FLOW_ID } : {}),
      },
      { kind: 'inclusiveGateway', id: 'Gateway_p_1_join' },
      { kind: 'userTask', id: 'Audit' },
      { kind: 'userTask', id: 'Record' },
      ...(third ? [{ kind: 'userTask', id: 'Triage' } as FlowElement] : []),
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_fork'),
      edge('Gateway_p_1_fork', 'Audit', { condition: '${amount > 10000}' }),
      edge('Audit', 'Gateway_p_1_join'),
      edge('Gateway_p_1_fork', 'Record', recordEdge),
      edge('Record', 'Gateway_p_1_join'),
      ...(third
        ? [
            edge('Gateway_p_1_fork', 'Triage', defaultEdge),
            edge('Triage', 'Gateway_p_1_join'),
          ]
        : []),
      ...(fallback === 'join'
        ? [edge('Gateway_p_1_fork', 'Gateway_p_1_join', defaultEdge)]
        : []),
      edge('Gateway_p_1_join', 'E'),
    ],
  );
}

describe('irToDsl: conditioned parallel branches', () => {
  const block = (declared: string, ...branches: string[]): string =>
    'process p {\n' +
    declared +
    '  start S\n' +
    '  parallel {\n' +
    '    if (amount > 10000) {\n' +
    '      user Audit\n' +
    '    }\n' +
    branches.join('') +
    '  }\n' +
    '  end E\n' +
    '}\n';
  const plainRecord = '    {\n      user Record\n    }\n';
  const elseRecord = '    else {\n      user Record\n    }\n';
  const elseTriage = '    else {\n      user Triage\n    }\n';
  const AMOUNT = '  var amount: any\n';

  // `Record` runs whatever the conditions do, so a fallback behind `Triage` can
  // never fire: the print keeps the `else` (dropping it would move `Triage` off
  // the run) and the compiler refuses it. A weighed fallback is legal BPMN the
  // fork never reads, so it prints as the fallback and its condition is
  // reported.
  it.each<
    [
      title: string,
      ir: BpmnProcess,
      source: string,
      reports: (readonly [keyof typeof REPORT, string])[],
      lowersTo: BpmnProcess,
      refused: (keyof typeof MODEL_REFUSAL)[],
    ]
  >([
    [
      'prints the conditioned branch, the plain one and the fallback, and reports the fallback as one that can never fire',
      inclusiveIr('branch'),
      block(AMOUNT, plainRecord, elseTriage),
      [['deadFallback', 'Gateway_p_1_fork']],
      inclusiveIr('branch'),
      ['deadElse'],
    ],
    [
      'leaves out the fallback branch when it runs straight into the merge, and reports nothing',
      inclusiveIr('join'),
      block(AMOUNT, plainRecord),
      [],
      inclusiveIr('none'),
      [],
    ],
    [
      'prints one weighed branch beside a bare fallback as the block with an else, and reports nothing',
      inclusiveIr('second-branch'),
      block(AMOUNT, elseRecord),
      [],
      inclusiveIr('second-branch'),
      [],
    ],
    [
      'says nothing about a fallback while one branch is unconditioned, that branch being taken whatever the conditions do',
      inclusiveIr('none'),
      block(AMOUNT, plainRecord),
      [],
      inclusiveIr('none'),
      [],
    ],
    [
      'reports the fallback it had to invent when the model names none, which the source lowers to',
      inclusiveIr('all-conditioned'),
      block(
        '  var amount: any\n  var urgent: any\n',
        '    if (urgent) {\n      user Record\n    }\n',
      ),
      [['inventedFallback', 'Gateway_p_1_fork']],
      {
        ...inclusiveIr('all-conditioned'),
        sequenceFlows: [
          ...inclusiveIr('all-conditioned').sequenceFlows,
          edge('Gateway_p_1_fork', 'Gateway_p_1_join'),
        ],
      },
      [],
    ],
    [
      'writes a fallback the model weighs as the fallback, keeping it off a run of its own, and reports the condition it leaves out',
      inclusiveIr('second-branch', '${urgent}'),
      block('  var amount: any\n  var urgent: any\n', elseRecord),
      [['forkFallbackCondition', 'Gateway_p_1_fork']],
      inclusiveIr('second-branch'),
      [],
    ],
    [
      'leaves out a weighed fallback that runs straight into the merge, and reports the condition all the same',
      inclusiveIr('join', '${late}'),
      block('  var amount: any\n  var late: any\n', plainRecord),
      [['forkFallbackCondition', 'Gateway_p_1_fork']],
      inclusiveIr('none'),
      [],
    ],
    [
      'reports a weighed fallback that nothing can reach as one that can never fire, beside the condition it leaves out',
      inclusiveIr('branch', '${late}'),
      block('  var amount: any\n  var late: any\n', plainRecord, elseTriage),
      [
        ['forkFallbackCondition', 'Gateway_p_1_fork'],
        ['deadFallback', 'Gateway_p_1_fork'],
      ],
      inclusiveIr('branch'),
      ['deadElse'],
    ],
  ])('%s', async (_title, ir, source, reports, lowersTo, refused) => {
    const print = printDsl(ir);
    expect(print.source).toBe(source);
    expectReports(print.warnings, ...reports);

    const back = await reDesugar(await printed(ir, ...refused));
    expect(elementMultiset(back)).toEqual(elementMultiset(lowersTo));
    expect(edgeMultiset(back)).toEqual(edgeMultiset(lowersTo));
  });

  it('reports the weighed fallback of a fork a loop has left one route to print', async () => {
    // The loop prints the fork's route back as its closing brace, so the fork
    // reaches its position with its weighed fallback as the plain route on.
    const ir = loopIntoSplitIr(
      { kind: 'inclusiveGateway', id: 'Fork', defaultFlowId: 'Flow_settled' },
      {},
      { id: 'Flow_settled', condition: '${settled}' },
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('while (again) {');
    expect(bodyOf(source)).not.toContain('settled');
    expectReports(warnings, ['forkFallbackCondition', 'Fork']);
    await printed(ir);
  });

  it('keeps a conditioned branch that runs straight into the merge as an empty block', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'inclusiveGateway',
          id: 'Gateway_p_1_fork',
          defaultFlowId: DEFAULT_FLOW_ID,
        },
        { kind: 'inclusiveGateway', id: 'Gateway_p_1_join' },
        { kind: 'userTask', id: 'Record' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Gateway_p_1_fork'),
        edge('Gateway_p_1_fork', 'Gateway_p_1_join', {
          id: 'Flow_skip',
          condition: '${amount > 10000}',
        }),
        edge('Gateway_p_1_fork', 'Record'),
        edge('Record', 'Gateway_p_1_join'),
        edge('Gateway_p_1_fork', 'Gateway_p_1_join', { id: DEFAULT_FLOW_ID }),
        edge('Gateway_p_1_join', 'E'),
      ],
    );

    expect(await printed(ir)).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    if (amount > 10000) {\n' +
        '    }\n' +
        '    {\n' +
        '      user Record\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
  });

  it('degrades to jumps when no merge of its own kind closes the fork, inventing no fallback on the way', async () => {
    // The merge is an XOR one, so no block is printed and no fallback is
    // invented, though both branches are conditioned.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'inclusiveGateway', id: 'Gateway_p_1_fork' },
        { kind: 'userTask', id: 'Audit' },
        { kind: 'userTask', id: 'Record' },
        gateway('Gateway_p_1_join'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Gateway_p_1_fork'),
        edge('Gateway_p_1_fork', 'Audit', { condition: '${ok}' }),
        edge('Gateway_p_1_fork', 'Record', { condition: '${urgent}' }),
        edge('Audit', 'Gateway_p_1_join'),
        edge('Record', 'Gateway_p_1_join'),
        edge('Gateway_p_1_join', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).not.toContain('parallel {');
    expect(source).toContain('goto Audit');
    expect(source).toContain('goto Record');
    expectReports(warnings, ['degradedSplit', 'Gateway_p_1_fork']);
    await printed(ir);
  });
});

describe('irToDsl: a split left with nowhere to go when no condition holds', () => {
  /** `Pick` weighs both its routes and names none to take when neither holds. */
  const allConditionedChoice = (defaultFlowId?: string): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('Pick', defaultFlowId),
        { kind: 'userTask', id: 'Audit' },
        { kind: 'userTask', id: 'Record' },
        gateway('Merge'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Pick'),
        edge('Pick', 'Audit', {
          id: 'F_audit',
          condition: '${amount > 10000}',
        }),
        edge('Pick', 'Record', { id: 'F_record', condition: '${urgent}' }),
        edge('Audit', 'Merge'),
        edge('Record', 'Merge'),
        edge('Merge', 'E'),
      ],
    );

  it('reports the fallback it had to invent at a choice whose every route is weighed', async () => {
    const { source, warnings } = printDsl(allConditionedChoice());

    // The chain closes with a bare `}`, so the position after it carries the
    // run on where the model had nothing left to take.
    expect(source).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  var urgent: any\n' +
        '  start S\n' +
        '  if (amount > 10000) {\n' +
        '    user Audit\n' +
        '  } else if (urgent) {\n' +
        '    user Record\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expectReports(warnings, ['inventedFallback', 'Pick']);

    // The invention itself: the printed source lowers to a route the model
    // never had, unconditioned and straight to the merge.
    const relowered = await reDesugar(source);
    const split = relowered.flowElements.find(
      (e): e is Extract<FlowElement, { kind: 'exclusiveGateway' }> =>
        e.kind === 'exclusiveGateway' && e.defaultFlowId !== undefined,
    );
    const invented = relowered.sequenceFlows.find(
      (f) => f.id === split?.defaultFlowId,
    );
    expect(invented?.conditionExpression).toBeUndefined();
  });

  it('reads the fallback an imported step carries, and reports only the condition on it that is weighed nowhere', async () => {
    // The import carries the fallback the model named and says nothing; the
    // print writes it as the route the engine takes when the weighed one
    // fails, whatever the condition on the fallback says.
    const condition = (body: string): string =>
      `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${body}</bpmn:conditionExpression>`;
    const { ir, warnings: imported } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Triage" default="F2" />
    <bpmn:endEvent id="E1" />
    <bpmn:endEvent id="E2" />
    <bpmn:sequenceFlow id="F0" sourceRef="S" targetRef="Triage" />
    <bpmn:sequenceFlow id="F1" sourceRef="Triage" targetRef="E1">
      ${condition('${paid}')}
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F2" sourceRef="Triage" targetRef="E2">
      ${condition('${urgent}')}
    </bpmn:sequenceFlow>`);

    expect(imported).toEqual([]);
    expect(ir.flowElements.find((e) => e.id === 'Triage')).toEqual({
      kind: 'userTask',
      id: 'Triage',
      defaultFlowId: 'F2',
    });

    const { source, warnings } = printDsl(ir);
    expect(bodyOf(source)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  user Triage\n' +
        '  if (paid) {\n' +
        '    end E1\n' +
        '  }\n' +
        '  end E2\n' +
        '}\n',
    );
    expectReports(warnings, ['forkFallbackCondition', 'Triage']);
    await printed(ir);
  });

  it('says nothing about an invented fallback at a step whose route back into the loop the loop already printed', async () => {
    // The unconditioned route back means `Review` is never left with nowhere
    // to go; the loop prints it as the closing brace, so the weighed escapes
    // leave the step as jumps.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('Loop'),
        { kind: 'userTask', id: 'Review' },
        { kind: 'userTask', id: 'Escalate' },
        { kind: 'userTask', id: 'Reject' },
        { kind: 'userTask', id: 'Settle' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Loop'),
        edge('Loop', 'Review', { condition: '${again}' }),
        edge('Loop', 'Settle'),
        edge('Review', 'Loop'),
        edge('Review', 'Escalate', { condition: '${overdue}' }),
        edge('Review', 'Reject', { condition: '${abandoned}' }),
        edge('Escalate', 'E'),
        edge('Reject', 'E'),
        edge('Settle', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('while (again) {');
    expectReports(warnings, ['degradedSplit', 'Review']);
    await printed(ir);
  });

  it('keeps the guard-clause continuation when the route the split names carries a condition', async () => {
    // The route the split takes when nothing holds is the continuation whether
    // it carries a condition or not.
    const ir = await reDesugar(`process p {
  error BOOM
  start S
  if (amount > 1000) {
    throw error(BOOM)
  }
  service Post(class: "x.Post")
  end Done
}
`);
    const split = ir.flowElements.find(
      (e): e is Extract<FlowElement, { kind: 'exclusiveGateway' }> =>
        e.kind === 'exclusiveGateway' && e.defaultFlowId !== undefined,
    )!;
    const fallback = ir.sequenceFlows.find(
      (f) => f.id === split.defaultFlowId,
    )!;
    fallback.conditionExpression = '${urgent}';

    const { source, warnings } = printDsl(ir);

    expect(source).toContain('if (amount > 1000) {');
    expect(source).toContain('service Post');
    expect(source).not.toContain('goto ');
    expectReports(warnings, ['choiceFallbackCondition', split.id]);
    await printed(ir);
  });

  it('says nothing about an invented fallback at a fork that opens every branch', () => {
    // The fork opens every branch whatever the conditions say, so it is never
    // left with nowhere to go; the conditions it reads nowhere are all there
    // is to report.
    const { warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
          { kind: 'userTask', id: 'Audit' },
          { kind: 'userTask', id: 'Record' },
          { kind: 'parallelGateway', id: 'Gateway_p_1_join' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'Gateway_p_1_fork'),
          edge('Gateway_p_1_fork', 'Audit', { condition: '${amount > 10000}' }),
          edge('Gateway_p_1_fork', 'Record', { condition: '${urgent}' }),
          edge('Audit', 'Gateway_p_1_join'),
          edge('Record', 'Gateway_p_1_join'),
          edge('Gateway_p_1_join', 'E'),
        ],
      ),
    );

    expectReports(warnings, ['unweighedBranch', 'Gateway_p_1_fork']);
  });

  it('writes a weighed fallback of a choice as the plain else, and reports the model the engine will not deploy', async () => {
    // Heading the branch with the condition would put it on a run of its own
    // and leave the choice falling through where the model never did.
    const ir = allConditionedChoice('F_record');
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  var urgent: any\n' +
        '  start S\n' +
        '  if (amount > 10000) {\n' +
        '    user Audit\n' +
        '  } else {\n' +
        '    user Record\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expect(bodyOf(source)).not.toContain('urgent');
    expectReports(warnings, ['choiceFallbackCondition', 'Pick']);

    // What the round trip has to hold on to: `Record` is still what the split
    // takes when the other condition fails, and still carries no condition.
    const relowered = await reDesugar(source);
    const split = relowered.flowElements.find(
      (e): e is Extract<FlowElement, { kind: 'exclusiveGateway' }> =>
        e.kind === 'exclusiveGateway' && e.defaultFlowId !== undefined,
    );
    const fallback = relowered.sequenceFlows.find(
      (f) => f.id === split?.defaultFlowId,
    );
    expect(fallback?.targetRef).toBe('Record');
    expect(fallback?.conditionExpression).toBeUndefined();
  });

  // The loop spends the route round it (the `while` condition, the `do`
  // closing condition, or plain flow where one route is left), so the report
  // is asked of the routes the model gives the head, not of those left to print.
  const ESCAPES = [
    ['Escalate', '${overdue}'],
    ['Settle', '${paid}'],
  ] as const;

  it.each([
    [
      'names no fallback, so the choice after the loop invents one',
      loopWithEscapesIr({
        head: gateway('Loop'),
        body: 'Retry',
        back: { condition: '${again}' },
        escapes: ESCAPES,
      }),
      [['inventedFallback', 'Loop']],
      'while (again) {',
    ],
    [
      'weighs the fallback a pre-test loop prints as its condition, which the engine refuses at deployment',
      loopWithEscapesIr({
        head: gateway('Loop', 'F_body'),
        body: 'Review',
        back: { id: 'F_body', condition: '${again}' },
        escapes: ESCAPES,
      }),
      [['choiceFallbackCondition', 'Loop']],
      'while (again) {',
    ],
    [
      'weighs the fallback a post-test loop prints as its closing condition',
      loopWithEscapesIr({
        shape: 'post',
        head: gateway('Pick', 'F_again'),
        body: 'Review',
        back: { id: 'F_again', condition: '${again}' },
        escapes: ESCAPES,
      }),
      [['choiceFallbackCondition', 'Pick']],
      '} while (again)',
    ],
    [
      // One route left is the fall-through, which the head prints without a
      // choice around it, so the condition it leaves out is reported beside
      // the deployment refusal.
      'weighs the fallback where the loop leaves it one route to print',
      loopWithEscapesIr({
        shape: 'post',
        head: gateway('Pick', 'F_again'),
        body: 'Review',
        back: { id: 'F_again', condition: '${again}' },
        escapes: [['Settle', '${paid}']],
      }),
      [
        ['choiceFallbackCondition', 'Pick'],
        ['droppedFlowCondition', 'Pick'],
      ],
      '} while (again)',
    ],
  ] as const)(
    'reports a loop head that %s',
    async (_title, ir, reports, has) => {
      const { source, warnings } = printDsl(ir);
      expect(source).toContain(has);
      expectReports(warnings, ...reports);
      await printed(ir);
    },
  );

  it('reports the refusal alone when the one route the loop leaves is the weighed fallback itself', () => {
    // The condition plain flow leaves out is the one the refusal is about;
    // saying the engine reads it too would name a run the model never reaches.
    const { warnings } = printDsl(
      loopIntoSplitIr(
        gateway('Pick', 'Flow_settled'),
        {},
        {
          id: 'Flow_settled',
          condition: '${settled}',
        },
      ),
    );

    expectReports(warnings, ['choiceFallbackCondition', 'Pick']);
  });

  it('gives the else to the route the split names, over a plain route beside it', async () => {
    // The model takes the unconditioned `Triage` whenever the weighed route
    // fails and never reaches `Record`; an `else` on `Triage` would make the
    // plain route the one nothing reaches.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('Pick', 'F_record'),
        { kind: 'userTask', id: 'Audit' },
        { kind: 'userTask', id: 'Record' },
        { kind: 'userTask', id: 'Triage' },
        gateway('Merge'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Pick'),
        edge('Pick', 'Audit', {
          id: 'F_audit',
          condition: '${amount > 10000}',
        }),
        edge('Pick', 'Record', { id: 'F_record', condition: '${urgent}' }),
        edge('Pick', 'Triage', { id: 'F_triage' }),
        edge('Audit', 'Merge'),
        edge('Record', 'Merge'),
        edge('Triage', 'Merge'),
        edge('Merge', 'E'),
      ],
    );

    expect(await printed(ir)).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  var urgent: any\n' +
        '  start S\n' +
        '  if (amount > 10000) {\n' +
        '    user Audit\n' +
        '  } else if (true) {\n' +
        '    user Triage\n' +
        '  } else {\n' +
        '    user Record\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
  });
});

describe('irToDsl: a condition on a branch of a fork that weighs none', () => {
  // Legal BPMN the engine never reads, and a head written for it would read
  // back as the fork that weighs its branches, which is a different fork.
  const CONDITIONED_AND_FORK: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
      { kind: 'userTask', id: 'Audit' },
      { kind: 'userTask', id: 'Record' },
      { kind: 'parallelGateway', id: 'Gateway_p_1_join' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_fork'),
      edge('Gateway_p_1_fork', 'Audit', { condition: '${urgent}' }),
      edge('Gateway_p_1_fork', 'Record'),
      edge('Audit', 'Gateway_p_1_join'),
      edge('Record', 'Gateway_p_1_join'),
      edge('Gateway_p_1_join', 'E'),
    ],
  );

  it('leaves the condition out, keeping the fork the fork it was, and reports it naming the fork', async () => {
    expect(bodyOf(await printed(CONDITIONED_AND_FORK))).toBe(
      'process p {\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    {\n' +
        '      user Audit\n' +
        '    }\n' +
        '    {\n' +
        '      user Record\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expectReports(printDsl(CONDITIONED_AND_FORK).warnings, [
      'unweighedBranch',
      'Gateway_p_1_fork',
    ]);
  });
});

/** Desugared `await { message("Paid") { user Ship } timer("P3D") { user Chase } }`. */
const RACE_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
    typedEvent('intermediateCatchEvent', 'Catch_p_1_b0', messageDef('Paid')),
    typedEvent(
      'intermediateCatchEvent',
      'Catch_p_1_b1',
      timerDef('duration', 'P3D'),
    ),
    { kind: 'userTask', id: 'Ship' },
    { kind: 'userTask', id: 'Chase' },
    gateway('Gateway_p_1_join'),
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('S', 'Gateway_p_1_race'),
    edge('Gateway_p_1_race', 'Catch_p_1_b0'),
    edge('Catch_p_1_b0', 'Ship'),
    edge('Ship', 'Gateway_p_1_join'),
    edge('Gateway_p_1_race', 'Catch_p_1_b1'),
    edge('Catch_p_1_b1', 'Chase'),
    edge('Chase', 'Gateway_p_1_join'),
    edge('Gateway_p_1_join', 'E'),
  ],
);

describe('irToDsl: race', () => {
  it('prints one branch per wait, split, waits and merge all elided', async () => {
    const { source, warnings } = printDsl(RACE_IR);

    expect(source).toBe(
      'process p {\n' +
        '  start S\n' +
        '  await {\n' +
        '    message("Paid") {\n' +
        '      user Ship\n' +
        '    }\n' +
        '    timer("P3D") {\n' +
        '      user Chase\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expect(warnings).toEqual([]);
    await expectIdempotent(RACE_IR);
  });

  // A race opens every branch at once and takes the first to resolve, so a
  // condition on a branch decides nothing; one between the wait and the step
  // it opens on is read, and the block form writes the body straight under
  // the wait, so it has no place to go either way.
  it.each([
    [
      'a condition weighing a race branch, which the block form has nowhere to put',
      'Gateway_p_1_race',
      'Catch_p_1_b1',
      'raceCondition',
    ],
    [
      'a condition on the route from a wait into its own body, which the engine reads',
      'Catch_p_1_b0',
      'Ship',
      'droppedFlowCondition',
    ],
  ] as const)('reports %s', async (_title, sourceRef, targetRef, report) => {
    const ir: BpmnProcess = {
      ...RACE_IR,
      sequenceFlows: RACE_IR.sequenceFlows.map((f) =>
        f.sourceRef === sourceRef && f.targetRef === targetRef
          ? { ...f, conditionExpression: '${overdue}' }
          : f,
      ),
    };
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(bodyOf(irToDsl(RACE_IR)));
    expectReports(warnings, [report, sourceRef]);
    await printed(ir);
  });

  it('writes the branch settings in the header parens, and an empty body for a branch that only waits', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
        {
          ...typedEvent(
            'intermediateCatchEvent',
            'Catch_p_1_b0',
            messageDef('Paid'),
          ),
          asyncBefore: true,
        },
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b1',
          timerDef('duration', 'P3D'),
        ),
        { kind: 'userTask', id: 'Chase' },
        gateway('Gateway_p_1_join'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Gateway_p_1_race'),
        edge('Gateway_p_1_race', 'Catch_p_1_b0'),
        edge('Catch_p_1_b0', 'Gateway_p_1_join'),
        edge('Gateway_p_1_race', 'Catch_p_1_b1'),
        edge('Catch_p_1_b1', 'Chase'),
        edge('Chase', 'Gateway_p_1_join'),
        edge('Gateway_p_1_join', 'E'),
      ],
    );

    const dsl = irToDsl(ir);
    expect(dsl).toBe(
      'process p {\n' +
        '  start S\n' +
        '  await {\n' +
        '    message("Paid", asyncBefore: true) {\n' +
        '    }\n' +
        '    timer("P3D") {\n' +
        '      user Chase\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    await expectIdempotent(ir);
  });

  it('still prints a race whose every branch ends, the merge having been pruned away', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b0',
          messageDef('Paid'),
        ),
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b1',
          timerDef('duration', 'P3D'),
        ),
        { kind: 'endEvent', id: 'Done' },
        { kind: 'endEvent', id: 'Expired' },
      ],
      [
        edge('S', 'Gateway_p_1_race'),
        edge('Gateway_p_1_race', 'Catch_p_1_b0'),
        edge('Catch_p_1_b0', 'Done'),
        edge('Gateway_p_1_race', 'Catch_p_1_b1'),
        edge('Catch_p_1_b1', 'Expired'),
      ],
    );
    const dsl = irToDsl(ir);

    expect(dsl).toBe(
      'process p {\n' +
        '  start S\n' +
        '  await {\n' +
        '    message("Paid") {\n' +
        '      end Done\n' +
        '    }\n' +
        '    timer("P3D") {\n' +
        '      end Expired\n' +
        '    }\n' +
        '  }\n' +
        '}\n',
    );
    await expectIdempotent(ir);
  });

  // Revert: `raceWait` returning `undefined` for a wait with no route out
  // degrades the race to jumps instead of the empty branch.
  it('prints a wait with no route out as an empty branch, which ends the run where the model does when nothing follows the race', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b0',
          messageDef('Paid'),
        ),
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b1',
          timerDef('duration', 'P3D'),
        ),
        { kind: 'userTask', id: 'Chase' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Gateway_p_1_race'),
        edge('Gateway_p_1_race', 'Catch_p_1_b0'),
        edge('Gateway_p_1_race', 'Catch_p_1_b1'),
        edge('Catch_p_1_b1', 'Chase'),
        edge('Chase', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);
    expect(source).toBe(
      'process p {\n' +
        '  start S\n' +
        '  await {\n' +
        '    message("Paid") {\n' +
        '    }\n' +
        '    timer("P3D") {\n' +
        '      user Chase\n' +
        '      end E\n' +
        '    }\n' +
        '  }\n' +
        '}\n',
    );
    expect(warnings).toEqual([]);
    await printed(ir);
  });

  it('degrades when a branch does not open on a wait, and loses no edge doing it', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b0',
          messageDef('Paid'),
        ),
        { kind: 'userTask', id: 'Chase' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Gateway_p_1_race'),
        edge('Gateway_p_1_race', 'Catch_p_1_b0'),
        edge('Catch_p_1_b0', 'E'),
        edge('Gateway_p_1_race', 'Chase'),
        edge('Chase', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    // One edge takes a jump; the other lands on a wait, which has no name to
    // jump to, so it leaves the marker and the wait prints on its own.
    expect(source).toBe(
      'process p {\n' +
        '  start S\n' +
        `  ${UNSTRUCTURED_MARKER} (split Gateway_p_1_race degraded to jumps; was event-based)\n` +
        '  if (true) {\n' +
        `    ${UNSTRUCTURED_MARKER} (dropped edge into Catch_p_1_b0)\n` +
        '  } else {\n' +
        '    goto Chase\n' +
        '  }\n' +
        '  await message("Paid")\n' +
        '  end E\n' +
        '  user Chase\n' +
        '  goto E\n' +
        '}\n',
    );
    expectReports(
      warnings,
      ['degradedSplit', 'Gateway_p_1_race'],
      ['droppedEdge', 'Catch_p_1_b0'],
    );
    await printed(ir);
  });
});

describe('irToDsl: a split with one way out is transparent', () => {
  const oneOutIr = (kind: 'inclusiveGateway' | 'eventBasedGateway') =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind, id: 'G' },
        { kind: 'userTask', id: 'A' },
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'G', 'A', 'E'),
    );

  it.each(['inclusiveGateway', 'eventBasedGateway'] as const)(
    'walks straight through a one-way %s',
    async (kind) => {
      expect(await printed(oneOutIr(kind))).toBe(
        'process p {\n  start S\n  user A\n  end E\n}\n',
      );
    },
  );

  it.each([
    ['a one-way merge under a synthesized id', PASS_THROUGH_IR],
    ['a one-way inclusive split', passThroughIr('inclusiveGateway')],
    ['a one-way wait', passThroughIr('eventBasedGateway')],
  ])('forwards a jump through %s to the real successor', async (_title, ir) => {
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('goto R');
    expect(source).not.toContain('dropped edge');
    expectReports(warnings, ['degradedSplit', 'A']);
    await printed(ir);
  });
});

/** `ir` with each listed element carrying the job settings named for it. */
function withJobSettings(
  ir: BpmnProcess,
  settings: Record<string, JobSettings>,
): BpmnProcess {
  return {
    ...ir,
    flowElements: ir.flowElements.map((el) =>
      el.id in settings ? { ...el, ...settings[el.id] } : el,
    ),
  };
}

/** The parens of every gateway statement in `dsl`, in source order: which head the printer put the keys on. */
async function headParens(dsl: string): Promise<[string, string[]][]> {
  const doc = await parse(dsl);
  return AstUtils.streamAllContents(doc.parseResult.value)
    .filter((node) => gatewayStatementRuleOf(node) !== undefined)
    .map((node): [string, string[]] => [
      node.$type,
      ((node as { items?: ParenItem[] }).items ?? []).map(
        (item) => item.$cstNode!.text,
      ),
    ])
    .toArray();
}

/**
 * Every gateway of `ir` carrying a setting, as `[kind, settings]` sorted
 * without the ids: the compiler mints its own on re-parse, and a merge that
 * splits again comes back as a split beside a join the model never had.
 */
function gatewaySettings(ir: BpmnProcess): [string, JobSettings][] {
  return ir.flowElements
    .filter(isGateway)
    .map((el): [string, JobSettings] => [
      el.kind,
      Object.fromEntries(
        ENGINE_KEYS.filter((key) => key in el).map((key) => [
          key,
          (el as unknown as Record<string, unknown>)[key],
        ]),
      ),
    ])
    .filter(([, settings]) => Object.keys(settings).length > 0)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('irToDsl: gateway settings', () => {
  const CYCLE = 'R3/PT10M';

  /** `if (a) {A} else if (b) {B} else {C}` as the compiler lowers it: one split, one join. */
  const CHAIN_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Gateway_p_1_split', 'Flow_Gateway_p_1_split_default'),
      gateway('Gateway_p_1_join'),
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'userTask', id: 'C' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_split'),
      edge('Gateway_p_1_split', 'A', { condition: '${a}' }),
      edge('A', 'Gateway_p_1_join'),
      edge('Gateway_p_1_split', 'B', { condition: '${b}' }),
      edge('B', 'Gateway_p_1_join'),
      edge('Gateway_p_1_split', 'C', {
        id: 'Flow_Gateway_p_1_split_default',
      }),
      edge('C', 'Gateway_p_1_join'),
      edge('Gateway_p_1_join', 'E'),
    ],
  );

  /** A merge that is itself a two-route split, which prints as the `if` that follows the first. */
  const MERGE_THAT_SPLITS_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Gateway_p_1_split', 'Flow_Gateway_p_1_split_default'),
      gateway('Merge', 'Flow_Merge_default'),
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'userTask', id: 'X' },
      { kind: 'userTask', id: 'Y' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_split'),
      edge('Gateway_p_1_split', 'A', { condition: '${a}' }),
      edge('A', 'Merge'),
      edge('Gateway_p_1_split', 'B', {
        id: 'Flow_Gateway_p_1_split_default',
      }),
      edge('B', 'Merge'),
      edge('Merge', 'X', { condition: '${x}' }),
      edge('X', 'E'),
      edge('Merge', 'Y', { id: 'Flow_Merge_default' }),
      edge('Y', 'E'),
    ],
  );

  /**
   * `while (c) { if (a) {A} else {B} }` as the compiler lowers it: the inner
   * join's only route is the loop's back-edge, which the `while` spends before
   * the body is walked.
   */
  const IF_IN_WHILE_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Gateway_p_1_loop', 'Flow_Gateway_p_1_loop_default'),
      gateway('Gateway_p_1_b_0_split', 'Flow_Gateway_p_1_b_0_split_default'),
      gateway('Gateway_p_1_b_0_join'),
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_loop'),
      edge('Gateway_p_1_loop', 'Gateway_p_1_b_0_split', { condition: '${c}' }),
      edge('Gateway_p_1_b_0_split', 'A', { condition: '${a}' }),
      edge('A', 'Gateway_p_1_b_0_join'),
      edge('Gateway_p_1_b_0_split', 'B', {
        id: 'Flow_Gateway_p_1_b_0_split_default',
      }),
      edge('B', 'Gateway_p_1_b_0_join'),
      edge('Gateway_p_1_b_0_join', 'Gateway_p_1_loop'),
      edge('Gateway_p_1_loop', 'E', { id: 'Flow_Gateway_p_1_loop_default' }),
    ],
  );

  // Revert symptoms: `takeJoinSettings` reading a merge whatever its shape
  // prints the merge-that-splits row's settings as `join*` on the first `if`;
  // a compiler reading a join's keys onto the split leaves the text unchanged
  // and only the re-parse pin goes red.
  it.each([
    [
      'an if prints the split settings and, join-prefixed, the pass-through merge settings',
      withJobSettings(IF_ELSE_IR, {
        Gateway_p_2_split: { asyncBefore: true, jobPriority: '10' },
        Gateway_p_2_join: { asyncBefore: true, retryCycle: CYCLE },
      }),
      [
        'process p {',
        '  var amount: any',
        '  start S',
        '  user A(label: "A task")',
        '  if (amount > 1000) (asyncBefore: true, jobPriority: 10, joinAsyncBefore: true, joinRetryCycle: "R3/PT10M") {',
        '    user B(label: "B task")',
        '  } else {',
        '    service C(class: "com.example.C")',
        '  }',
        '  end E',
        '}',
      ],
      [
        [
          'IfStatement',
          [
            'asyncBefore: true',
            'jobPriority: 10',
            'joinAsyncBefore: true',
            'joinRetryCycle: "R3/PT10M"',
          ],
        ],
      ],
    ],
    [
      'an else-if chain is one split, so the head carries the parens and no else-if does',
      withJobSettings(CHAIN_IR, {
        Gateway_p_1_split: { exclusive: false },
        Gateway_p_1_join: { asyncAfter: true },
      }),
      [
        'process p {',
        '  var a: any',
        '  var b: any',
        '  start S',
        '  if (a) (exclusive: false, joinAsyncAfter: true) {',
        '    user A',
        '  } else if (b) {',
        '    user B',
        '  } else {',
        '    user C',
        '  }',
        '  end E',
        '}',
      ],
      [['IfStatement', ['exclusive: false', 'joinAsyncAfter: true']]],
    ],
    [
      'an if inside a while prints the merge settings although the loop already spent its back-edge',
      withJobSettings(IF_IN_WHILE_IR, {
        Gateway_p_1_b_0_join: { asyncBefore: true },
      }),
      [
        'process p {',
        '  var c: any',
        '  var a: any',
        '  start S',
        '  while (c) {',
        '    if (a) (joinAsyncBefore: true) {',
        '      user A',
        '    } else {',
        '      user B',
        '    }',
        '  }',
        '  end E',
        '}',
      ],
      [
        ['WhileStatement', []],
        ['IfStatement', ['joinAsyncBefore: true']],
      ],
    ],
    [
      'a merge that splits again keeps its settings for the if it opens, not as join settings on the first',
      withJobSettings(MERGE_THAT_SPLITS_IR, {
        Merge: { asyncBefore: true },
      }),
      [
        'process p {',
        '  var a: any',
        '  var x: any',
        '  start S',
        '  if (a) {',
        '    user A',
        '  } else {',
        '    user B',
        '  }',
        '  if (x) (asyncBefore: true) {',
        '    user X',
        '  } else {',
        '    user Y',
        '  }',
        '  end E',
        '}',
      ],
      [
        ['IfStatement', []],
        ['IfStatement', ['asyncBefore: true']],
      ],
    ],
    [
      'a while prints the loop settings on its head',
      withJobSettings(WHILE_IR, { Gateway_p_1_loop: { asyncAfter: true } }),
      [
        'process p {',
        '  var count: any',
        '  start S',
        '  while (count < 10) (asyncAfter: true) {',
        '    user W(label: "Work")',
        '  }',
        '  end E',
        '}',
      ],
      [['WhileStatement', ['asyncAfter: true']]],
    ],
    [
      'a do-while prints the loop settings after its condition',
      withJobSettings(DO_WHILE_IR, { Gateway_p_1_loop: { exclusive: false } }),
      [
        'process p {',
        '  var count: any',
        '  start S',
        '  do {',
        '    user W(label: "Work")',
        '  } while (count < 10) (exclusive: false)',
        '  end E',
        '}',
      ],
      [['DoWhileStatement', ['exclusive: false']]],
    ],
    [
      'a parallel prints the fork settings and, join-prefixed, the join settings',
      withJobSettings(PARALLEL_IR, {
        Gateway_p_1_fork: { jobPriority: '5' },
        Gateway_p_1_join: { asyncBefore: true },
      }),
      [
        'process p {',
        '  start S',
        '  parallel (jobPriority: 5, joinAsyncBefore: true) {',
        '    {',
        '      user X(label: "X")',
        '    }',
        '    {',
        '      service Y(class: "com.example.Y")',
        '    }',
        '  }',
        '  end E',
        '}',
      ],
      [['ParallelStatement', ['jobPriority: 5', 'joinAsyncBefore: true']]],
    ],
    [
      'a weighed parallel prints the same head ahead of its branch heads',
      withJobSettings(inclusiveIr('join'), {
        Gateway_p_1_fork: { retryCycle: CYCLE },
        Gateway_p_1_join: { exclusive: false },
      }),
      [
        'process p {',
        '  var amount: any',
        '  start S',
        '  parallel (retryCycle: "R3/PT10M", joinExclusive: false) {',
        '    if (amount > 10000) {',
        '      user Audit',
        '    }',
        '    {',
        '      user Record',
        '    }',
        '  }',
        '  end E',
        '}',
      ],
      [
        [
          'ParallelStatement',
          ['retryCycle: "R3/PT10M"', 'joinExclusive: false'],
        ],
      ],
    ],
    [
      'an await prints the race settings and, join-prefixed, the merge settings',
      withJobSettings(RACE_IR, {
        Gateway_p_1_race: { asyncBefore: true },
        Gateway_p_1_join: { asyncBefore: true },
      }),
      [
        'process p {',
        '  start S',
        '  await (asyncBefore: true, joinAsyncBefore: true) {',
        '    message("Paid") {',
        '      user Ship',
        '    }',
        '    timer("P3D") {',
        '      user Chase',
        '    }',
        '  }',
        '  end E',
        '}',
      ],
      [['RaceStatement', ['asyncBefore: true', 'joinAsyncBefore: true']]],
    ],
  ] as const)('%s', async (_title, ir, expected, parens) => {
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(`${expected.join('\n')}\n`);
    expect(warnings).toEqual([]);
    expect(await headParens(await printed(ir))).toEqual(parens);
    expect(gatewaySettings(await reDesugar(source))).toEqual(
      gatewaySettings(ir),
    );
  });

  /** `S -> G -> A -> E` with a one-way `G` no statement stands for. */
  const LONE_PASS_THROUGH_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('G'),
      { kind: 'userTask', id: 'A' },
      { kind: 'endEvent', id: 'E' },
    ],
    flowChain('S', 'G', 'A', 'E'),
  );

  // Revert symptom: delete the sweep at the end of `Emitter.emit` -> every row
  // red on the missing report.
  it.each([
    [
      'a one-way split the flow walks through',
      LONE_PASS_THROUGH_IR,
      'G',
      [['droppedSetting', 'G']],
    ],
    [
      'a merge a jump forwards through',
      PASS_THROUGH_IR,
      'Gateway_p_9_join',
      [
        ['degradedSplit', 'A'],
        ['droppedSetting', 'Gateway_p_9_join'],
      ],
    ],
    [
      'a fork degraded to jumps',
      GOTO_INTO_FORK_IR,
      'Gateway_p_1_fork',
      [
        ['degradedSplit', 'Gateway_p_1_fork'],
        ['droppedEdge', 'Gateway_p_1_fork'],
        ['droppedSetting', 'Gateway_p_1_fork'],
      ],
    ],
  ] as const)(
    'reports the settings of %s once and writes none of them',
    async (_title, ir, id, reports) => {
      const { source, warnings } = printDsl(
        withJobSettings(ir, { [id]: { asyncBefore: true, jobPriority: '7' } }),
      );

      expect(source).toBe(await printed(ir));
      expectReports(warnings, ...reports);
    },
  );
});
