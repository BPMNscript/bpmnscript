import { describe, it, expect } from 'vitest';

import { irToDsl as printDsl, UNSTRUCTURED_MARKER } from '../src/ir-to-dsl.js';
import { astToIr } from '../src/ast-to-ir.js';
import { xmlToIr } from '../src/xml-to-ir.js';
import { isGateway } from '../src/ir/types.js';
import { bpmnDoc } from './helpers/bpmn-doc.js';
import { parse, validate } from './helpers/parse.js';
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
  ExecutionListener,
  FieldInjection,
  FlowElement,
  FormField,
  JobSettings,
  LoopCharacteristics,
  Repeatable,
  SequenceFlow,
  ServiceTask,
  StartEvent,
  Task,
  UserTask,
  EndEvent,
  ServiceTaskBinding,
  VersionBinding,
} from '../src/ir/types.js';

const start = (id: string): StartEvent => ({ kind: 'startEvent', id });
const user = (id: string): UserTask => ({ kind: 'userTask', id });
const task = (id: string): Task => ({ kind: 'task', id });
const end = (id: string): EndEvent => ({ kind: 'endEvent', id });
const chain = (...ids: string[]): SequenceFlow[] =>
  ids.slice(1).map((target, i) => edge(ids[i]!, target));

const irToDsl = (process: BpmnProcess): string => printDsl(process).source;

// Round trips compare up to the ids the compiler mints.
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

// Errors the model itself draws; a fixture feeding one names it.
const MODEL_REFUSAL = {
  mintedId: 'is the id the compiler generates for the implicit',
  orphanStep: 'This step can never run',
  deadElse: 'could never run',
} as const;

// Re-parsing alone accepts a statement a printed jump cut off.
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

// `var` lines come from the model, so a dropped condition is checked on the body.
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

// Degrading to jumps re-mints gateways, so a print keeps real-node reachability.
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

describe('irToDsl: goto degradation', () => {
  it('prints crossing splits no join closes with a goto, losing no real-node connection', async () => {
    // `G2` re-enters `A`, which `G1` also targets, so no join post-dominates either.
    const ir = minimalProcess(
      [
        start('S'),
        gateway('G1', 'd1'),
        user('A'),
        user('B'),
        gateway('G2', 'd2'),
        end('E'),
      ],
      [
        edge('S', 'G1'),
        edge('G1', 'A', { condition: '${p}' }),
        edge('G1', 'B', { id: 'd1' }),
        edge('A', 'E'),
        edge('B', 'G2'),
        edge('G2', 'A', { condition: '${q}' }),
        edge('G2', 'E', { id: 'd2' }),
      ],
    );
    const dsl = await printed(ir);
    expect(dsl).toMatch(/\bgoto\s+\w/);
    expect(realReachability(await reDesugar(dsl))).toEqual(
      realReachability(ir),
    );
  });
});

// Operaton refuses mail without `to` and shell without `command`, so `printed` catches a dropped field.
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
      task('Draft'),
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

describe('irToDsl: call activity', () => {
  it('prints every setting, every mapping form and each version binding, calls falling through in chain order', async () => {
    const call = (id: string, binding?: VersionBinding): FlowElement => ({
      ...callActivity(id, 'p'),
      ...(binding ? { binding } : {}),
    });
    const dsl = await printed(
      chained([
        start('S'),
        {
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
        },
        call('Plain'),
        call('Latest', { kind: 'latest' }),
        call('Pinned', { kind: 'version', version: '3' }),
        call('Dynamic', { kind: 'version', version: '${v}' }),
        end('E'),
      ]),
    );
    expect(dsl).toBe(
      'process proc {\n' +
        '  var x: any\n' +
        '  start S\n' +
        '  call CallSub(label: "Call sub", process: "sub-process", ' +
        'binding: deployment, businessKey: "${execution.processBusinessKey}") {\n' +
        '    in *\n' +
        '    in amount\n' +
        '    in y = x\n' +
        '    in local doubled = "${total * 2}"\n' +
        '    out outcome = result\n' +
        '    out final = "${status}"\n' +
        '    out local *\n' +
        '  }\n' +
        '  call Plain(process: "p")\n' +
        '  call Latest(process: "p", binding: latest)\n' +
        '  call Pinned(process: "p", version: 3)\n' +
        '  call Dynamic(process: "p", version: "${v}")\n' +
        '  end E\n' +
        '}\n',
    );
  });
});

describe('irToDsl: event layer', () => {
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

    expect(await printed(ir)).toBe(
      `process p {
  error OrderFailed(code: "order.failed")
  error OUT_OF_STOCK(message: "Out of stock")
  escalation MANUAL_REVIEW
  user Pack
  throw error(OrderFailed)
  on Pack: error(OUT_OF_STOCK, code: c) {
    user Restock
  }
  on Pack: error {
    user Escalate
  }
}
`,
    );
  });
});

describe('irToDsl: event layer (message / signal / timer / conditional)', () => {
  it('prints the implementation a thrown or emitted message carries', async () => {
    const thrown = minimalProcess(
      [
        start('S'),
        {
          ...typedEvent('endEvent', 'Sent', messageDef('Ack')),
          binding: classBinding('com.example.Send'),
        },
      ],
      [edge('S', 'Sent', { id: 'F' })],
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

describe('irToDsl: blocks that can be given up', () => {
  const book = (element?: 'transaction'): FlowElement => ({
    ...chainedSub('Book', [user('Charge')]),
    name: 'Book and pay',
    asyncBefore: true,
    loop: { collection: 'lines', elementVariable: 'line' },
    ...(element === undefined ? {} : { element }),
  });

  it('prints the handler that catches the block being given up', async () => {
    const ir = minimalProcess(
      [
        start('St'),
        book('transaction'),
        end('En'),
        boundaryEvent('Boundary_Book_cancel', 'Book', { kind: 'cancel' }),
        end('Escaped'),
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

describe('irToDsl: link pairs and named catches', () => {
  it('prints a link pair as a chain-ending emit link and a named await link opening the next chain', async () => {
    const ir = minimalProcess(
      [
        start('S'),
        task('A'),
        typedEvent('intermediateThrowEvent', 'ToRetry', linkDef('Retry')),
        {
          ...typedEvent('intermediateCatchEvent', 'AtRetry', linkDef('Retry')),
          asyncBefore: true,
        },
        task('B'),
        end('E'),
      ],
      [...chain('S', 'A', 'ToRetry'), ...chain('AtRetry', 'B', 'E')],
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

  it('of several throws of one link name, none takes the catch along, so no throw strands behind the process end', async () => {
    const ir = await reDesugar(
      'process p { var c: any var x: any  start S  if (c) { if (x) { emit link("L") } else { step Q  emit link("L") }  await link("L")  step B }  step Z  end Done }',
    );
    expect(await printed(ir)).toBe(
      `process p {
  var c: any
  var x: any
  start S
  if (c) {
    if (x) {
      emit link("L")
    }
    step Q
    emit link("L")
  }
  step Z
  end Done
  await link("L")
  step B
  goto Z
}
`,
    );
  });
});

describe('irToDsl: boundary events', () => {
  it('prints the handler block for a boundary event a malformed flow edge points at, once', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        start('S'),
        user('A'),
        boundaryEvent('Boundary_A_error', 'A', errorDef('X')),
        user('Fix'),
      ],
      flowChain('S', 'A', 'Boundary_A_error', 'Fix'),
    );
    expect(await printed(ir)).toBe(
      `process p {
  error X
  start S
  user A
  on A: error(X) {
    user Fix
  }
}
`,
    );
  });

  it('prints a boundary event inside the sub-process container that holds its host', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        start('S'),
        {
          kind: 'subProcess',
          id: 'Inner',
          flowElements: [
            start('IS'),
            user('Check'),
            end('IE'),
            boundaryEvent(
              'Boundary_Check_condition',
              'Check',
              conditionDef('${stale}'),
            ),
            end('Stale'),
          ],
          sequenceFlows: [
            edge('IS', 'Check', { id: 'I1' }),
            edge('Check', 'IE', { id: 'I2' }),
            edge('Boundary_Check_condition', 'Stale', { id: 'I3' }),
          ],
        },
        end('E'),
      ],
      flowChain('S', 'Inner', 'E'),
    );
    expect(await printed(ir)).toContain('    on Check: condition(stale) {\n');
  });
});

describe('irToDsl: synthesized terminal omission', () => {
  // Only the exact minted id is synthesized; `StartEvent_1` is authored.
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
      `process p {
  start StartEvent_1(label: "Order Received", initiator: "who")
  user Approve
  end EndEvent_1(label: "Order Filed")
}
`,
    );
    expect((await validate(source)).diagnostics).toEqual([]);
    expect((await reDesugar(source)).flowElements).toEqual(ir.flowElements);
  });

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

describe('irToDsl: ids the script cannot spell print under a minted name', () => {
  const ir = processIr(
    'WFP-6-',
    [
      start('S'),
      user('Task.1'),
      user('user'),
      chainedSub('Sub.1', [start('S2'), task('Step.2'), end('E2')]),
      typedEvent('intermediateThrowEvent', 'Notify.1', messageDef('M')),
      user('Review-'),
      end('E'),
      boundaryEvent('B', 'Task.1', timerDef('duration', 'PT1H')),
    ],
    [
      ...flowChain('S', 'Task.1', 'user', 'Sub.1', 'Notify.1', 'Review-', 'E'),
      edge('B', 'Review-'),
    ],
  );

  it('prints every site under the minted name, reports each rename once, and the source compiles clean', async () => {
    const { source, warnings } = printDsl(ir);
    expect(source).toBe(
      `process WFP_6_ {
  start S
  user Task_1
  user _user
  subprocess Sub_1 {
    start S2
    step Step_2
    end E2
  }
  emit message Notify_1("M")
  user Review_
  end E
  on Task_1: timer("PT1H") {
    goto Review_
  }
}
`,
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
});

// The compiler never mints a plain end where the source rows put one, so they rename an authored end.
describe("irToDsl: a synthesized plain end that is not its block's tail", () => {
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
      `process p {
  error E
  var x: any
  start S
  step A
  if (x) {
    throw error Named(E)
  }
  step X
}
`,
      [],
    ],
    [
      "a plain end whose chain a second start's chain follows prints before that start, and its label rides along",
      'process p { start S  step A  end Done(label: "Order filed")  start T message("M")  step B  end Fin }',
      `process p {
  start S
  step A
  end EndEvent_p(label: "Order filed")
  start T message("M")
  step B
  end Fin
}
`,
      [['refusedStatement', 'EndEvent_p']],
    ],
    [
      'a plain end inside a branch prints at once, so the branch does not fall through',
      'process p { start S  step A  if (x) { end Done }  step X  end Fin }',
      `process p {
  var x: any
  start S
  step A
  if (x) {
    end EndEvent_p
  }
  step X
  end Fin
}
`,
      [['refusedStatement', 'EndEvent_p']],
    ],
    [
      'a link catch whose chain never reaches the plain end prints behind its throw, so that end stays the tail',
      'process p { start S  step A  if (x) { emit link T("L") }  step C  end Done  await link C2("L")  step B  end Fin }',
      `process p {
  var x: any
  start S
  step A
  if (x) {
    emit link T("L")
    await link C2("L")
    step B
    end Fin
  }
  step C
}
`,
      [],
    ],
    [
      'of three chains, the one whose own end is the synthesized tail prints last so that end stays implicit',
      // The validator refuses a second plain start, as `BpmnParse.selectInitial` does.
      minimalProcess(
        [
          start('S1'),
          task('A'),
          end('EndEvent_p'),
          typedEvent('startEvent', 'S2', messageDef('M2')),
          task('B'),
          end('E2'),
          typedEvent('startEvent', 'S3', messageDef('M3')),
          task('C'),
          end('E3'),
        ],
        [
          ...chain('S1', 'A', 'EndEvent_p'),
          ...chain('S2', 'B', 'E2'),
          ...chain('S3', 'C', 'E3'),
        ],
      ),
      `process p {
  start S2 message("M2")
  step B
  end E2
  start S3 message("M3")
  step C
  end E3
  start S1
  step A
}
`,
      [],
    ],
  ] as const)('%s', async (_title, fixture, source, reports) => {
    const ir =
      typeof fixture === 'string'
        ? renamed(await reDesugar(fixture), 'Done', 'EndEvent_p')
        : fixture;
    expect(await expectIdempotent(ir, 'mintedId')).toEqual(source);
    expectReports(printDsl(ir).warnings, ...reports);
  });
});

// Behind an authored end the chain stays a jump, keeping the coordinate ids of its unnamed events.
describe('irToDsl: an authored chain a branch owns', () => {
  it.each([
    [
      'two branches whose chains end print them inline, and the implicit end stays unwritten',
      `process p {
  var a: any
  var b: any
  if (a) {
    user A
    throw message("Quote Received")
  } else if (b) {
    user B
    await {
      message("OrderReceived") {
        end Done
      }
      message("Quote Received") {
        user C
      }
    }
  } else {
    user D
  }
}
`,
    ],
    [
      'a guard clause whose branch runs a step into an end prints the step inside the branch',
      `process p {
  var a: any
  if (a) {
    user A
    end Stop
  }
  user B
}
`,
    ],
    [
      'a chain jumped to behind an authored end stays behind it, keeping the coordinate id of its unnamed throw',
      `process p {
  error E
  var x: any
  if (x) {
    goto X
  }
  user C
  end Done
  user X
  throw error(E)
}
`,
    ],
    [
      'a chain that runs into the implicit end is the tail and stays a jump',
      `process p {
  var a: any
  if (a) {
    goto X
  }
  user B
  end Done
  user X
}
`,
    ],
  ])('%s', async (_title, source) => {
    const ir = await reDesugar(source);
    expect(await expectIdempotent(ir)).toBe(source);
    expect(printDsl(ir).warnings).toEqual([]);
  });
});

describe('irToDsl: routes leaving a loop beside the two it is built from', () => {
  const PRE_TEST_IR: BpmnProcess = minimalProcess(
    [
      start('S'),
      gateway('Loop'),
      user('Work'),
      user('Escalate'),
      end('E'),
      end('E2'),
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
      start('S'),
      user('Review'),
      gateway('Decide'),
      user('Escalate'),
      user('Done'),
      end('E'),
      end('E2'),
    ],
    [
      ...chain('S', 'Review', 'Decide'),
      edge('Decide', 'Review', { condition: '${rework}' }),
      edge('Decide', 'Escalate', { condition: '${escalate}' }),
      ...chain('Decide', 'Done', 'E'),
      edge('Escalate', 'E2'),
    ],
  );

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

describe('irToDsl: a loop head whose exit is listed before its route into the body', () => {
  // The engine tests the exit first, which `while (c)` cannot say, so the loop
  // stays unfolded and its back edge becomes the hand-repair marker.
  const marker = `${UNSTRUCTURED_MARKER} (dropped edge into L)`;
  it.each<[title: string, exits: SequenceFlow[], body: string[]]>([
    [
      'an exit listed first keeps its place ahead of the body',
      [edge('L', 'A', { condition: '${x > 1}' })],
      [
        '  if (x > 1) {',
        '  } else if (n > 100) {',
        '    user T',
        `    ${marker}`,
        '  }',
        '  user A',
        '  end EA',
      ],
    ],
    [
      'an exit listed first keeps its place with another exit after the body',
      [
        edge('L', 'A', { condition: '${x > 1}' }),
        edge('L', 'B', { condition: '${y > 1}' }),
      ],
      [
        '  if (x > 1) {',
        '    user A',
        '    end EA',
        '  } else if (n > 100) {',
        '    goto T',
        '  }',
        '  user B',
        '  end EB',
        '  user T',
        `  ${marker}`,
      ],
    ],
  ])('%s', async (_, exits, body) => {
    const [first, ...after] = exits;
    const exitSteps = exits.map((f) => f.targetRef);
    const ir = minimalProcess(
      [
        start('S'),
        gateway('L'),
        user('T'),
        ...exitSteps.map(user),
        ...exitSteps.map((id) => end(`E${id}`)),
      ],
      [
        edge('S', 'L'),
        first!,
        edge('L', 'T', { condition: '${n > 100}' }),
        ...after,
        edge('T', 'L'),
        ...exitSteps.map((id) => edge(id, `E${id}`)),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      ['process p {', '  start S', ...body, '}', ''].join('\n'),
    );
    expectReports(warnings, ['inventedFallback', 'L'], ['droppedEdge', 'L']);
    const second = irToDsl(await reDesugar(await printed(ir)));
    const withoutMarker = bodyOf(source)
      .split('\n')
      .filter((line) => line.trim() !== marker)
      .join('\n');
    expect(bodyOf(second)).toBe(withoutMarker);
  });
});

describe('irToDsl: a loop route with no condition listed before a conditioned one', () => {
  // Operaton's exclusive split: the first route but the default, in document
  // order, with no condition or one that holds, else the default.
  const run = (ir: BpmnProcess, vars: Record<string, unknown>): string[] => {
    const holds = (c: string): boolean =>
      Boolean(
        new Function(...Object.keys(vars), `return ${c.slice(2, -1)};`)(
          ...Object.values(vars),
        ),
      );
    const trace: string[] = [];
    let at: FlowElement = only(ir, 'startEvent');
    while (at.kind !== 'endEvent' && trace.length < 4) {
      if (at.kind === 'userTask') trace.push(at.id);
      const fallback = 'defaultFlowId' in at ? at.defaultFlowId : undefined;
      const outs = ir.sequenceFlows.filter((f) => f.sourceRef === at.id);
      const next =
        outs.find(
          (f) =>
            f.id !== fallback &&
            (f.conditionExpression === undefined ||
              holds(f.conditionExpression)),
        ) ?? outs.find((f) => f.id === fallback);
      if (next === undefined) return [...trace, 'stuck'];
      at = byId(ir, next.targetRef);
    }
    return trace;
  };
  const marker = `${UNSTRUCTURED_MARKER} (dropped edge into L)`;

  it.each<
    [
      title: string,
      elements: FlowElement[],
      flows: SequenceFlow[],
      body: string[],
      reports: [keyof typeof REPORT, string][],
      runs: Record<string, unknown>[],
    ]
  >([
    [
      'an exit listed before the back edge of a do-while stays tested first',
      [start('S'), user('T'), gateway('L'), end('E')],
      [...chain('S', 'T', 'L', 'E'), edge('L', 'T', { condition: '${c}' })],
      [
        '  user T',
        '  if (true) {',
        '  } else if (c) {',
        '    goto T',
        '  }',
        '  end E',
      ],
      [],
      [{ c: true }, { c: false }],
    ],
    [
      'an exit listed before a route back into a printed step stays tested first',
      [start('S'), user('T'), gateway('G'), user('A'), end('EA')],
      [
        ...chain('S', 'T', 'G', 'A', 'EA'),
        edge('G', 'T', { condition: '${x > 5}' }),
      ],
      [
        '  user T',
        '  if (true) {',
        '  } else if (x > 5) {',
        '    goto T',
        '  }',
        '  user A',
        '  end EA',
      ],
      [],
      [{ x: 0 }, { x: 10 }],
    ],
    [
      'a back edge to a while head listed before a conditioned route is marked',
      [
        start('S'),
        gateway('L', 'Flow_L_E'),
        user('T'),
        gateway('G'),
        user('B'),
        end('EB'),
        end('E'),
      ],
      [
        edge('S', 'L'),
        edge('L', 'T', { condition: '${n > 100}' }),
        edge('L', 'E'),
        ...chain('T', 'G', 'L'),
        edge('G', 'B', { condition: '${x > 1}' }),
        edge('B', 'EB'),
      ],
      [
        '  if (n > 100) {',
        '    user T',
        '    if (true) {',
        `      ${marker}`,
        '    } else if (x > 1) {',
        '      user B',
        '    }',
        '  } else {',
        '    end E',
        '  }',
        '  end EB',
      ],
      [['droppedEdge', 'L']],
      [],
    ],
  ])('%s', async (_, elements, flows, body, reports, runs) => {
    const ir = minimalProcess(elements, flows);
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      ['process p {', '  start S', ...body, '}', ''].join('\n'),
    );
    expectReports(warnings, ...reports);
    const rebuilt = await reDesugar(await printed(ir));
    const withoutMarker = bodyOf(source)
      .split('\n')
      .filter((line) => line.trim() !== marker)
      .join('\n');
    expect(bodyOf(irToDsl(rebuilt))).toBe(withoutMarker);
    expect(runs.map((vars) => run(rebuilt, vars))).toEqual(
      runs.map((vars) => run(ir, vars)),
    );
  });
});

describe('irToDsl: a split inside a loop body whose every route is conditioned', () => {
  const reviewLoopIr = (
    staying: readonly (readonly [step: string, condition: string])[],
    exit: 'E' | 'E2' = 'E2',
  ): BpmnProcess =>
    minimalProcess(
      [
        start('S'),
        user('Approve'),
        gateway('G1'),
        ...staying.map(([id]): FlowElement => ({ kind: 'userTask', id })),
        gateway('G2'),
        user('Pay'),
        end('E'),
        ...(exit === 'E2' ? [{ kind: 'endEvent', id: 'E2' } as const] : []),
      ],
      [
        ...chain('S', 'Approve', 'G1'),
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
        '  var approved: any\n  var clarified: any\n  var escalated: any\n',
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
    expectReports(
      warnings,
      ['inventedFallback', 'G1'],
      ['droppedFlowCondition', 'G2'],
    );
    await printed(ir);
  });
});

// A jump into one-way gateway `G` forwards through it to `R`.
const passThroughIr = (
  kind: 'exclusiveGateway' | 'inclusiveGateway' | 'eventBasedGateway',
  id = 'G',
): BpmnProcess =>
  minimalProcess(
    [start('S'), user('A'), { kind, id }, user('R'), end('E')],
    [...chain('S', 'A', 'E'), edge('A', id), edge(id, 'R'), edge('R', 'E')],
  );

const PASS_THROUGH_IR = passThroughIr('exclusiveGateway', 'Gateway_p_9_join');

// Hostile input: a back edge into a parallel fork, which no goto can name.
const GOTO_INTO_FORK_IR: BpmnProcess = minimalProcess(
  [
    start('S'),
    { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
    user('A'),
    user('B'),
    end('E'),
  ],
  [
    edge('S', 'Gateway_p_1_fork', { id: 'f0' }),
    edge('Gateway_p_1_fork', 'A', { id: 'f1' }),
    edge('Gateway_p_1_fork', 'B', { id: 'f2' }),
    edge('A', 'E', { id: 'f3' }),
    edge('B', 'Gateway_p_1_fork', { id: 'f4' }),
  ],
);

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
});

describe('irToDsl: engine attributes', () => {
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
        flowElements: [user('Inner')],
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
      ...flowChain(
        'S',
        'U',
        'V',
        'Sc',
        'C',
        'Sub',
        'Catch_p_1',
        'Throw_p_1',
        'E',
      ),
      edge('Boundary_U_error', 'Failed', { id: 'F9' }),
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

  const timerHandler = (
    startId: string,
    subProcessSettings: JobSettings = {},
  ): BpmnProcess =>
    processIr(
      'p',
      [
        start('S'),
        end('E'),
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
            end('EndEvent_EventSubProcess_p_1'),
          ]),
          ...subProcessSettings,
        },
      ],
      [edge('S', 'E')],
    );

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
    expect(dsl.split('\n').slice(-2 - handlerLines.length, -2)).toEqual(
      handlerLines,
    );
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
});

const jumpToEndIr = (
  end: Partial<Omit<Extract<FlowElement, { kind: 'endEvent' }>, 'kind'>>,
): BpmnProcess => {
  const { id = 'EndEvent_p', ...attrs } = end;
  return minimalProcess(
    [start('S'), user('A'), user('B'), { kind: 'endEvent', id, ...attrs }],
    [
      edge('S', 'A', { id: 'F1' }),
      { id: 'F2', sourceRef: 'A', targetRef: id },
      edge('A', 'B', { id: 'F3' }),
      { id: 'F4', sourceRef: 'B', targetRef: id },
    ],
  );
};

const backEdgeIr = (
  start: Partial<Omit<Extract<FlowElement, { kind: 'startEvent' }>, 'kind'>>,
): BpmnProcess => {
  const { id = 'StartEvent_p', ...attrs } = start;
  return minimalProcess(
    [{ kind: 'startEvent', id, ...attrs }, user('A')],
    flowChain(id, 'A', id),
  );
};

const DONE_LISTENERS: ExecutionListener[] = [
  { event: 'end', binding: classBinding('com.example.Done') },
];

describe('irToDsl: whether a synthesized terminal prints', () => {
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
      'a label alone on an end, which nothing else can carry, forces the print',
      'end',
      { name: 'Order Filed' },
      'end EndEvent_p(label: "Order Filed")',
      ['mintedId'],
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

describe('irToDsl: members inside the braces', () => {
  it('prints fields, the form, parameters and listeners in one fixed order on every carrier', async () => {
    const ir = minimalProcess(
      [
        start('S'),
        {
          ...serviceTask('V', externalBinding('charge')),
          inputParameters: [
            ioParam('plain', textValue('ready')),
            ioParam('expr', textValue('${order.id}')),
            ioParam('items', listValue([])),
          ],
          outputParameters: [
            ioParam('code', textValue('200')),
            ioParam('blank', mapValue([])),
          ],
        },
        {
          ...user('Nested'),
          inputParameters: [
            ioParam(
              'rows',
              listValue([
                textValue('a'),
                // `end` is a keyword, so only the quoted key re-parses.
                mapValue([
                  mapEntry('k', textValue('v')),
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
            ioParam('total', scriptValue('groovy', 'sum(a, b)\n')),
          ],
        },
        {
          ...scriptTask('Sc', 'javascript', 'x = 1;\n'),
          inputParameters: [ioParam('seed', scriptValue('groovy', 'seed()\n'))],
        },
        {
          ...chainedSub('Sub', [user('Inner')]),
          // An empty map ending the members puts `{}` `}` `{` in a row.
          inputParameters: [
            ioParam('seed', textValue('1')),
            ioParam('extra', mapValue([])),
          ],
        },
        {
          ...callActivity('C', 'other'),
          outputParameters: [ioParam('total', textValue('${sum}'))],
          inMappings: [{ kind: 'all' }],
        },
        {
          ...user('Listened'),
          executionListeners: [
            { event: 'start', binding: classBinding('com.example.Enter') },
            { event: 'end', binding: exprBinding('${audit.log()}') },
          ],
          taskListeners: [
            { event: 'create', binding: delegateBinding('${assignHook}') },
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
        },
        {
          ...serviceTask('Scripted', classBinding('com.example.C')),
          executionListeners: [
            { event: 'end', binding: scriptValue('groovy', "println 'bye'\n") },
          ],
        },
        {
          ...user('Ordered'),
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
        },
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
          ...user('Review'),
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
        {
          ...user('Latest'),
          formRef: { key: 'f', binding: { kind: 'latest' } },
        },
        {
          ...user('Deployed'),
          formRef: { key: 'f', binding: { kind: 'deployment' } },
        },
        {
          ...typedEvent(
            'intermediateCatchEvent',
            'Catch_p_1',
            signalDef('Ping'),
          ),
          executionListeners: [
            { event: 'start', binding: classBinding('com.example.W') },
          ],
        },
        end('E'),
        {
          ...triggeredSub('H', [
            typedEvent('startEvent', 'StartEvent_H', escalationDef('ESC')),
          ]),
          executionListeners: [
            { event: 'end', binding: classBinding('com.example.H') },
          ],
        },
      ],
      flowChain(
        'S',
        'V',
        'Nested',
        'Sc',
        'Sub',
        'C',
        'Listened',
        'Scripted',
        'Ordered',
        'Ship',
        'Review',
        'Latest',
        'Deployed',
        'Catch_p_1',
        'E',
      ),
    );
    expect(await printed(ir)).toBe(`process p {
  escalation ESC
  start S
  service V(topic: "charge") {
    input plain = "ready"
    input expr = "\${order.id}"
    input items = []
    output code = "200"
    output blank = {}
  }
  user Nested {
    input rows = ["a", { "k": "v", "end": "z" }]
    input lookup = { "ids": ["x"], "with space": "w" }
    input total = \`\`\`groovy
sum(a, b)
\`\`\`
  }
  script Sc {
    input seed = \`\`\`groovy
seed()
\`\`\`
  } \`\`\`javascript
x = 1;
\`\`\`
  subprocess Sub {
    input seed = "1"
    input extra = {}
  } {
    user Inner
  }
  call C(process: "other") {
    output total = "\${sum}"
    in *
  }
  user Listened {
    on start(class: "com.example.Enter")
    on end(expression: "\${audit.log()}")
    on create(delegate: "\${assignHook}")
    on timeout after "PT1H"(class: "com.example.T")
    on timeout at "\${deadline}"(class: "com.example.D")
  }
  service Scripted(class: "com.example.C") {
    on end \`\`\`groovy
println 'bye'
\`\`\`
  }
  user Ordered(label: "Review", assignee: "ana", asyncBefore: true) {
    form {
      amount: number
    }
    input seed = "1"
    output note = "\${n}"
    on start(class: "com.example.Enter")
    on complete(class: "com.example.Done")
  }
  service Ship(class: "com.example.Ship") {
    field greeting = "hello"
    field target = "\${order.address}"
    input amount = "\${total}"
    on start(delegate: "\${auditHook}") {
      field level = "INFO"
    }
  }
  user Review(formRef: "review-form", version: 3) {
    on create(class: "com.example.Assign") {
      field role = "clerk"
    }
  }
  user Latest(formRef: "f", binding: latest)
  user Deployed(formRef: "f", binding: deployment)
  await signal("Ping") {
    on start(class: "com.example.W")
  }
  end E
  on escalation(ESC) {
    on end(class: "com.example.H")
  } {
  }
}
`);
  });
});

describe('irToDsl: repeated activities', () => {
  const OVER_LINES: LoopCharacteristics = {
    collection: 'lines',
    elementVariable: 'line',
  };

  type RepeatableElement = Extract<FlowElement, Repeatable>;

  const printRepeated = (
    el: RepeatableElement,
    loop: LoopCharacteristics,
  ): Promise<string> => printed(around({ ...el, asyncBefore: true, loop }));

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
      expect(await printRepeated(task('Record'), loop)).toContain(
        `step Record ${clause}(asyncBefore: true)`,
      );
    },
  );

  it.each([
    [
      'declares every bare collection once, at any depth',
      minimalProcess(
        [
          start('S'),
          { kind: 'task', id: 'Record', loop: OVER_LINES },
          { kind: 'task', id: 'Price', loop: OVER_LINES },
          chainedSub('Fulfil', [
            {
              kind: 'task',
              id: 'Pick',
              loop: { collection: 'parcels', elementVariable: 'parcel' },
            },
          ]),
          end('E'),
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
          end('E'),
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
          start('S'),
          { kind: 'task', id: 'Record', loop: { collection: 'c' } },
          { kind: 'task', id: 'Note', loop: { collection: 'm' } },
          { kind: 'task', id: 'Escalate', loop: { collection: 'x' } },
          end('E'),
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

// Rows opening with `${` lex as a raw expression, whose reader does not unescape.
describe('irToDsl: prose comes back byte for byte', () => {
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

  it.each(PROSE)(
    'label and documentation, %s',
    async (_title, text, escapes) => {
      const print = (prose: string): Promise<string> =>
        printed(
          around({ ...user('Review'), name: prose, documentation: prose }),
        );

      const dsl = await print(text);
      // A lone carriage return breaks a line for every reader too.
      expect(dsl.split(/\r\n|\r|\n/)).toHaveLength(
        (await print('Review the order')).split(/\r\n|\r|\n/).length,
      );
      expect(dsl.includes('\\')).toBe(escapes);
      const { name, documentation } = only(await reDesugar(dsl), 'userTask');
      expect({ name, documentation }).toEqual({
        name: text,
        documentation: text,
      });
    },
  );
});

// `never` holds a neighbouring report's phrase, keeping two reports apart.
const REPORT = {
  label: { category: 'label', says: ['block structure'] },
  documentation: {
    category: 'documentation',
    says: ['block structure', 'carry it'],
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

const JARGON = ['flow node', 'gateway', 'token', 'sequence flow'];

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

type Route = { id?: string; condition?: string };

const loopIntoSplitIr = (
  split: FlowElement,
  back: Route,
  on: Route,
): BpmnProcess =>
  minimalProcess(
    [start('S'), gateway('Loop'), user('Review'), split, end('E')],
    [
      edge('S', 'Loop'),
      edge('Loop', 'Review', { condition: '${again}' }),
      edge('Review', split.id),
      edge(split.id, 'Loop', back),
      edge(split.id, 'E', on),
      edge('Loop', 'E'),
    ],
  );

describe('warnings: text the script has nowhere to write', () => {
  const gatewayTextIr = (carried: boolean): BpmnProcess => {
    const text = (documentation: string) => (carried ? { documentation } : {});
    return minimalProcess(
      [
        start('S'),
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
          start('NS'),
          {
            kind: 'exclusiveGateway',
            id: 'Nested',
            ...text('Nested, and reported all the same.'),
          },
          end('NE'),
        ]),
        end('E'),
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
  // `Ring1` and `Ring2` forward to each other, so the walk comes back round.
  it('drops an arrival at a ring of one-way gateways', async () => {
    const ir = minimalProcess(
      [start('S'), user('A'), gateway('Ring1'), gateway('Ring2'), end('E')],
      [
        edge('S', 'A'),
        edge('S', 'Ring1'),
        edge('A', 'E'),
        ...chain('Ring1', 'Ring2', 'Ring1'),
      ],
    );
    const ring = printDsl(ir);

    expect(ring.source).toContain(
      `${UNSTRUCTURED_MARKER} (dropped edge into Ring1)`,
    );
    expect(ring.source).not.toContain('goto Ring');
    // The ring is reached from the jump and again from the closing sweep.
    expectReports(
      ring.warnings,
      ['degradedSplit', 'S'],
      ['droppedEdge', 'Ring1'],
      ['droppedEdge', 'Ring1'],
    );
    await printed(ir);
  });
});

describe('warnings: a split the script has no form for', () => {
  it('prints a step split whose route loops straight back to the step as a parallel block with a goto', async () => {
    const ir = minimalProcess(
      [start('S'), user('T1'), user('Cont'), end('E')],
      [...chain('S', 'T1', 'T1', 'Cont', 'E')],
    );

    const { source, warnings } = printDsl(ir);
    const again = await reDesugar(await printed(ir));

    expect(source).toBe(
      `process p {
  start S
  user T1
  parallel {
    {
      goto T1
    }
    {
      user Cont
      end E
    }
  }
}
`,
    );
    expect(warnings).toEqual([]);
    expect(realReachability(again)).toEqual(realReachability(ir));
    expect(irToDsl(again)).toBe(source);
  });
});

describe('irToDsl: a split degraded to jumps keeps its conditions on them', () => {
  it('keeps a race off the block form when a wait routes on twice, and forks the wait itself', async () => {
    const ir = minimalProcess(
      [
        start('S'),
        { kind: 'eventBasedGateway', id: 'Race' },
        typedEvent(
          'intermediateCatchEvent',
          'C1',
          timerDef('duration', 'PT1M'),
        ),
        typedEvent('intermediateCatchEvent', 'C2', messageDef('m')),
        user('A'),
        user('B'),
        end('E'),
      ],
      [
        ...chain('S', 'Race', 'C1'),
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
      [start('S'), { kind, id: 'G' }],
      [edge('S', 'G')],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toBe('process p {\n  start S\n}\n');
    expectReports(warnings, ['emptySplit', 'G']);
    expect(warnings[0]!.message).toContain(says);
    await printed(ir);
  });
});

describe('irToDsl: a route with no condition at an exclusive split', () => {
  // Operaton takes the first route in document order that carries no condition
  // or one that holds, so a `true` head keeps an early one in its place.
  it.each<
    [title: string, split: FlowElement, routes: SequenceFlow[], body: string[]]
  >([
    [
      'listed before a conditioned route, it heads the chain as true',
      gateway('G'),
      [edge('G', 'A'), edge('G', 'B', { condition: '${x > 5}' })],
      [
        '  if (true) {',
        '    user A',
        '  } else if (x > 5) {',
        '    user B',
        '  }',
        '  end E',
      ],
    ],
    [
      'listed between two conditioned routes, it heads its place as true',
      gateway('G'),
      [
        edge('G', 'B', { condition: '${x > 5}' }),
        edge('G', 'A'),
        edge('G', 'C', { condition: '${x > 9}' }),
      ],
      [
        '  if (x > 5) {',
        '    user B',
        '  } else if (true) {',
        '    user A',
        '  } else if (x > 9) {',
        '    user C',
        '  }',
        '  end E',
      ],
    ],
    [
      'listed last, it is the continuation as drawn',
      gateway('G'),
      [edge('G', 'B', { condition: '${x > 5}' }), edge('G', 'A')],
      [
        '  if (x > 5) {',
        '    user B',
        '  } else {',
        '    user A',
        '  }',
        '  end E',
      ],
    ],
    [
      'named as the default, it is tried last wherever it is listed',
      gateway('G', 'F_A'),
      [
        edge('G', 'A', { id: 'F_A' }),
        edge('G', 'B', { condition: '${x > 5}' }),
      ],
      [
        '  if (x > 5) {',
        '    user B',
        '  } else {',
        '    user A',
        '  }',
        '  end E',
      ],
    ],
  ])('%s', async (_, split, routes, body) => {
    const steps = routes.map((f) => f.targetRef);
    const ir = minimalProcess(
      [start('S'), split, ...steps.map(user), end('E')],
      [edge('S', 'G'), ...routes, ...steps.map((id) => edge(id, 'E'))],
    );
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      ['process p {', '  start S', ...body, '}', ''].join('\n'),
    );
    expect(warnings).toEqual([]);
    expect(irToDsl(await reDesugar(await printed(ir)))).toBe(source);
  });
});

describe('irToDsl: a split that routes back into itself', () => {
  it.each([
    [
      'a plain route back beside a weighed way on',
      gateway('G'),
      [edge('G', 'G'), edge('G', 'A', { condition: '${go}' })],
      '  if (true) {\n' +
        `    ${UNSTRUCTURED_MARKER} (dropped edge into G)\n` +
        '  } else if (go) {\n' +
        '  }\n',
      [['droppedEdge', 'G']],
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
      [['droppedEdge', 'G']],
    ],
  ] as const)(
    '%s prints the marker rather than a loop',
    async (_title, split, routes, chain, reports) => {
      const ir = minimalProcess(
        [start('S'), split, user('A'), end('E')],
        [edge('S', 'G'), ...routes, edge('A', 'E')],
      );
      const { source, warnings } = printDsl(ir);

      expect(bodyOf(source)).toBe(
        'process p {\n  start S\n' + chain + '  user A\n  end E\n}\n',
      );
      expectReports(warnings, ...reports);
      await printed(ir);
    },
  );
});

describe('irToDsl: a jump into a branch of a fork or a race', () => {
  it('reports the jump the script refuses, from the sibling branch it was printed in', async () => {
    // The first branch walks `B` inline, so the second jumps across the branch border.
    const ir = minimalProcess(
      [
        start('S'),
        { kind: 'parallelGateway', id: 'Fork' },
        gateway('X'),
        user('A'),
        user('B'),
        { kind: 'parallelGateway', id: 'Join' },
        end('E'),
      ],
      [
        ...chain('S', 'Fork', 'X'),
        edge('X', 'A', { condition: '${a}' }),
        edge('X', 'B', { condition: '${b}' }),
        edge('A', 'Join'),
        ...chain('Fork', 'B', 'Join', 'E'),
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
    const ir = minimalProcess(
      [
        start('S'),
        { kind: 'parallelGateway', id: 'Fork' },
        gateway('Head'),
        user('A'),
        gateway('Again', 'F_out'),
        user('Retry'),
        user('B'),
        { kind: 'parallelGateway', id: 'Join' },
        end('E'),
      ],
      [
        ...chain('S', 'Fork', 'Head', 'A', 'Again'),
        edge('Again', 'Retry', { condition: '${retry}' }),
        edge('Retry', 'Head'),
        edge('Again', 'Join', { id: 'F_out' }),
        ...chain('Fork', 'B', 'Join', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('        user Retry\n        goto A\n');
    expect(warnings).toEqual([]);
    await printed(ir);
  });
});

describe('irToDsl: a branch walk stops where the block comes back together', () => {
  // The post-dominator queries miss every one of these shapes.
  it.each([
    [
      'a do-while prints back as written',
      `process p {
  start S
  do {
    user W
  } while (count < 10)
  end E
}
`,
    ],
    [
      'a throw guard with no else prints the continuation after it at the body level, no gateway named',
      `process p {
  error BOOM
  start S
  service Pre(class: "x.Pre")
  if (amount > 1000) {
    throw error(BOOM)
  }
  service Post(class: "x.Post")
  end Done
}
`,
    ],
    [
      'a throw guard inside a loop body keeps the statement after it inside the loop',
      `process p {
  error X
  start S
  while (retries < 3) {
    service A(class: "x.A")
    if (retries < 1) {
      throw error(X)
    }
    service B(class: "x.B")
  }
  end Done
}
`,
    ],
    [
      'a fork with a throwing branch prints the throw inline and the continuation after the block',
      `process p {
  error BOOM(message: "it broke")
  start Begin
  parallel {
    {
      service A(label: "a", class: "x.A")
    }
    {
      throw error(BOOM)
    }
  }
  end Finish
}
`,
    ],
    [
      'a fork whose ending branch runs a step first still joins the survivor at the merge',
      `process p {
  start Begin
  parallel {
    {
      user A
    }
    {
      user B
      end Abandoned terminate
    }
  }
  end Finish
}
`,
    ],
    [
      'a fork whose surviving branches each hold a nested fork resumes after the outer join, not the first inner one',
      `process p {
  error BOOM(message: "it broke")
  start Begin
  parallel {
    {
      parallel {
        {
          service A(label: "a", class: "x.A")
        }
        {
          service B(label: "b", class: "x.B")
        }
      }
    }
    {
      parallel {
        {
          service C(label: "c", class: "x.C")
        }
        {
          service D(label: "d", class: "x.D")
        }
      }
    }
    {
      throw error(BOOM)
    }
  }
  end Finish
}
`,
    ],
    [
      'a race with empty branches into a step that loops on itself prints the step after the block',
      `process p {
  await {
    message("M") {
    }
    timer("PT1H") {
    }
  }
  user A
  goto A
}
`,
    ],
    [
      'a race whose branch holds a throw guard stops at the merge, and the end prints after the block',
      `process p {
  await {
    timer("PT1H") {
      if (c) {
        throw message("PaymentDone")
      }
    }
    timer("PT2H") {
    }
  }
  end Done
}
`,
    ],
    [
      'an if chain with an ending branch, an empty branch and an else chain keeps the else, and the implicit end stays unwritten',
      `process onboarding {
  subprocess Sub4 {
    if (true) {
      end Done7
    } else if (true) {
    } else {
      service Approve10(class: "org.acme.Audit")
    }
  }
}
`,
    ],
    [
      'a fork branch holding an empty if with an ending else stops at the join, not at the else',
      `process p {
  parallel {
    {
      if (c) {
      } else {
        end X
      }
    }
    {
      user B
    }
  }
  end Done
}
`,
    ],
    [
      'a fork whose fallback runs straight into the join beside a nested fork and an ending branch takes that join',
      `process p {
  parallel {
    if (a) {
      parallel {
        if (b) {
          user P
        }
        if (c) {
          user Q
        }
      }
    }
    if (d) {
      end X
    }
  }
  end Done
}
`,
    ],
    [
      'an if whose one branch runs on to the implicit end beside two that end keeps the end unwritten',
      `process p {
  if (b) {
    user A
  } else if (c) {
    user B
    end D
  } else {
    user C
    end E
  }
}
`,
    ],
    [
      'an if over a parallel beside two ending branches that share a step stops at its own join, not at that step',
      `process p {
  if (b) {
    parallel {
      {
        user A1
      }
      {
        user A2
      }
    }
  } else if (c) {
    user B
    end D
  } else {
    user C
    goto B
  }
}
`,
    ],
    [
      'an if over a parallel beside an ending else keeps the join settings on the parallel',
      `process p {
  if (b) {
    parallel (joinAsyncBefore: true) {
      {
        user A1
      }
      {
        user A2
      }
    }
  } else {
    end E
  }
}
`,
    ],
    [
      'an if with an ending else whose branch holds a nested if stops at its own join, not at the nested one',
      `process p {
  if (c) {
    user A
    if (b) {
      user B1
    }
    user A2
  } else {
    end X
  }
}
`,
    ],
    [
      'a race whose one branch ends and whose other runs on to the implicit end keeps that branch whole',
      `process p {
  await {
    message("M") {
      if (x) {
        emit message("PaymentDone")
      } else {
        user Charge
      }
      step Approve
    }
    timer("P3D") {
      user Archive
      end Done terminate
    }
  }
}
`,
    ],
  ] as const)('%s', async (_title, source) => {
    const ir = await reDesugar(source);
    expect(bodyOf(await expectIdempotent(ir))).toEqual(source);
    expect(printDsl(ir).warnings).toEqual([]);
  });

  // `P` is upstream of the split, so it is no merge of it.
  it.each([
    [
      'an if whose branch and following chain both jump back to the step above the split',
      `process p {
  var a: any
  user P
  if (a) {
    user A
    goto P
  }
  user B
  goto P
}
`,
    ],
    [
      'an if whose two branches both jump back to the step above the split',
      `process p {
  var a: any
  user P
  if (a) {
    user A
    goto P
  } else {
    user B
    goto P
  }
}
`,
    ],
  ] as const)(
    '%s prints as the guard clause, with the jump back outside the block',
    async (_title, authored) => {
      const ir = await reDesugar(authored);
      const source = await printed(ir);
      expect(bodyOf(source)).toEqual(
        `process p {
  user P
  if (a) {
    goto A
  }
  user B
  goto P
  user A
  goto P
}
`,
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
      [start('S'), eventHandler('H', 'H_Start', messageDef('m'))],
      [edge('S', 'H')],
    );

    expect(() => printDsl(ir)).toThrow(/flow edge/);
  });
});

describe('warnings: a condition the script has nowhere to write', () => {
  const oneWeighedRouteIr = (source: FlowElement, target = 'A'): BpmnProcess =>
    minimalProcess(
      [start('S'), source, user('A'), end('E')],
      [
        edge('S', source.id),
        edge(source.id, target, { condition: '${approved}' }),
        edge(target, 'E'),
      ],
    );

  it.each([
    ['a step', user('T'), 'droppedFlowCondition'],
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

  it.each([
    ['an exclusive split keeps it as an if', 'exclusiveGateway', true, []],
    [
      'an inclusive split reports a run that goes on elsewhere',
      'inclusiveGateway',
      false,
      [['divertedRun', 'Split']],
    ],
  ] as const)(
    'a weighed route beside a fallback that closes a loop: %s',
    async (_title, kind, keepsIf, reports) => {
      const ir = loopIntoSplitIr(
        { kind, id: 'Split', defaultFlowId: 'Flow_again' },
        { id: 'Flow_again' },
        { condition: '${settled}' },
      );
      const { source, warnings } = printDsl(ir);

      expect(source).toContain('while (again) {');
      expect(bodyOf(source).includes('settled')).toBe(keepsIf);
      expectReports(warnings, ...reports);
      await printed(ir);
    },
  );

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
      ['droppedEdge', 'Loop'],
    );
  });

  it('reports it on a route the walk never reaches, which leaves as a bare jump', async () => {
    const ir = minimalProcess(
      [start('S'), user('A'), end('E')],
      [
        ...chain('S', 'A', 'E'),
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

const DEFAULT_FLOW_ID = 'Flow_Gateway_p_1_fork_default';

// Desugared `parallel { if (amount > 10000) { user Audit } { user Record } }`, the fallback placed per `fallback`.
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
      start('S'),
      {
        kind: 'inclusiveGateway',
        id: 'Gateway_p_1_fork',
        ...(named ? { defaultFlowId: DEFAULT_FLOW_ID } : {}),
      },
      { kind: 'inclusiveGateway', id: 'Gateway_p_1_join' },
      user('Audit'),
      user('Record'),
      ...(third ? [user('Triage') as FlowElement] : []),
      end('E'),
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

  it('keeps a conditioned branch that runs straight into the merge as an empty block', async () => {
    const ir = minimalProcess(
      [
        start('S'),
        {
          kind: 'inclusiveGateway',
          id: 'Gateway_p_1_fork',
          defaultFlowId: DEFAULT_FLOW_ID,
        },
        { kind: 'inclusiveGateway', id: 'Gateway_p_1_join' },
        user('Record'),
        end('E'),
      ],
      [
        edge('S', 'Gateway_p_1_fork'),
        edge('Gateway_p_1_fork', 'Gateway_p_1_join', {
          id: 'Flow_skip',
          condition: '${amount > 10000}',
        }),
        ...chain('Gateway_p_1_fork', 'Record', 'Gateway_p_1_join'),
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
});

describe('irToDsl: a split left with nowhere to go when no condition holds', () => {
  // Operaton tries an exclusive split's routes in document order, so only the
  // last one may print as the fall-through and give up its condition.
  const invoiceIr = (
    approval: [condition: string, target: string][],
  ): BpmnProcess =>
    minimalProcess(
      [
        start('S'),
        user('Approve'),
        gateway('G'),
        user('Pay'),
        user('Review'),
        gateway('G2'),
        end('E1'),
        end('E2'),
      ],
      [
        ...chain('S', 'Approve', 'G'),
        ...approval.map(([condition, target]) =>
          edge('G', target, { condition }),
        ),
        edge('Pay', 'E1'),
        edge('Review', 'G2'),
        edge('G2', 'E2', { condition: '${!clarified}' }),
        edge('G2', 'Approve', { condition: '${clarified}' }),
      ],
    );
  it.each<
    [
      title: string,
      ir: BpmnProcess,
      body: string[],
      reports: (readonly [keyof typeof REPORT, string])[],
    ]
  >([
    [
      'overlapping conditions keep their order: the first keeps its condition and the last falls through',
      minimalProcess(
        [start('S'), gateway('G'), user('A'), user('B'), end('EA'), end('EB')],
        [
          edge('S', 'G'),
          edge('G', 'A', { condition: '${x > 1}' }),
          edge('G', 'B', { condition: '${x > 5}' }),
          edge('A', 'EA'),
          edge('B', 'EB'),
        ],
      ),
      [
        '  start S',
        '  if (x > 1) {',
        '    user A',
        '    end EA',
        '  }',
        '  user B',
        '  end EB',
      ],
      [['inventedFallback', 'G']],
    ],
    [
      'an approval listed before its review falls through to the review',
      invoiceIr([
        ['${approved}', 'Pay'],
        ['${!approved}', 'Review'],
      ]),
      [
        '  start S',
        '  user Approve',
        '  if (approved) {',
        '    user Pay',
        '    end E1',
        '  }',
        '  user Review',
        '  if (!clarified) {',
        '    end E2',
        '  } else if (clarified) {',
        '    goto Approve',
        '  }',
        '  goto E1',
      ],
      [
        ['inventedFallback', 'G'],
        ['inventedFallback', 'G2'],
      ],
    ],
    [
      'an approval listed after its review falls through to the approval',
      invoiceIr([
        ['${!approved}', 'Review'],
        ['${approved}', 'Pay'],
      ]),
      [
        '  start S',
        '  user Approve',
        '  if (!approved) {',
        '    user Review',
        '    if (!clarified) {',
        '      end E2',
        '    } else if (clarified) {',
        '      goto Approve',
        '    }',
        '  }',
        '  user Pay',
        '  end E1',
      ],
      [
        ['inventedFallback', 'G'],
        ['inventedFallback', 'G2'],
      ],
    ],
    [
      'a last route into a step reached from elsewhere keeps its condition behind an empty first branch',
      minimalProcess(
        [
          start('S'),
          gateway('G0'),
          gateway('G'),
          user('A'),
          user('B'),
          end('EA'),
          end('EB'),
        ],
        [
          edge('S', 'G0'),
          edge('G0', 'B', { condition: '${p}' }),
          edge('G0', 'G'),
          edge('G', 'A', { condition: '${a}' }),
          edge('G', 'B', { condition: '${b}' }),
          edge('A', 'EA'),
          edge('B', 'EB'),
        ],
      ),
      [
        '  start S',
        '  if (p) {',
        '    goto B',
        '  }',
        '  if (a) {',
        '  } else if (b) {',
        '    goto B',
        '  }',
        '  user A',
        '  end EA',
        '  user B',
        '  end EB',
      ],
      [['inventedFallback', 'G']],
    ],
  ])('%s', async (_, ir, body, reports) => {
    const { source, warnings } = printDsl(ir);
    expect(bodyOf(source)).toBe(['process p {', ...body, '}', ''].join('\n'));
    expectReports(warnings, ...reports);
    await printed(ir);
  });

  it('reads the fallback an imported step carries, and reports only the condition on it that is weighed nowhere', async () => {
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

  it('an empty condition body leaves two routes unconditioned, so none is resumed', async () => {
    // The import refusal counts the empty body as a condition, as Operaton
    // does, but the flow imports without one.
    const { ir, warnings: imported } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="S" />
    <bpmn:exclusiveGateway id="G" />
    <bpmn:userTask id="A" />
    <bpmn:userTask id="B" />
    <bpmn:userTask id="C" />
    <bpmn:endEvent id="EA" />
    <bpmn:endEvent id="EB" />
    <bpmn:endEvent id="EC" />
    <bpmn:sequenceFlow id="F0" sourceRef="S" targetRef="G" />
    <bpmn:sequenceFlow id="F1" sourceRef="G" targetRef="A">
      <bpmn:conditionExpression />
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F2" sourceRef="G" targetRef="B" />
    <bpmn:sequenceFlow id="F3" sourceRef="G" targetRef="C">
      <bpmn:conditionExpression>${'${c}'}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="FA" sourceRef="A" targetRef="EA" />
    <bpmn:sequenceFlow id="FB" sourceRef="B" targetRef="EB" />
    <bpmn:sequenceFlow id="FC" sourceRef="C" targetRef="EC" />`);

    expect(imported.map((w) => w.elementId)).toEqual(['F1']);
    const { source, warnings } = printDsl(ir);
    expect(bodyOf(source)).toBe(
      [
        'process p {',
        '  start S',
        '  if (true) {',
        '    goto A',
        '  } else if (true) {',
        '    goto B',
        '  } else if (c) {',
        '    goto C',
        '  }',
        '  user A',
        '  end EA',
        '  user B',
        '  end EB',
        '  user C',
        '  end EC',
        '}',
        '',
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
    await printed(ir);
  });

  it('says nothing about an invented fallback at a step whose route back into the loop the loop already printed', async () => {
    const ir = minimalProcess(
      [
        start('S'),
        gateway('Loop'),
        user('Review'),
        user('Escalate'),
        user('Reject'),
        user('Settle'),
        end('E'),
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

  it('says nothing about an invented fallback at a fork that opens every branch', () => {
    const { warnings } = printDsl(
      minimalProcess(
        [
          start('S'),
          { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
          user('Audit'),
          user('Record'),
          { kind: 'parallelGateway', id: 'Gateway_p_1_join' },
          end('E'),
        ],
        [
          edge('S', 'Gateway_p_1_fork'),
          edge('Gateway_p_1_fork', 'Audit', { condition: '${amount > 10000}' }),
          edge('Gateway_p_1_fork', 'Record', { condition: '${urgent}' }),
          edge('Audit', 'Gateway_p_1_join'),
          ...chain('Record', 'Gateway_p_1_join', 'E'),
        ],
      ),
    );

    expectReports(warnings, ['unweighedBranch', 'Gateway_p_1_fork']);
  });

  it('reports the refusal alone when the one route the loop leaves is the weighed fallback itself', () => {
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
});

const RACE_IR: BpmnProcess = minimalProcess(
  [
    start('S'),
    { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
    typedEvent('intermediateCatchEvent', 'Catch_p_1_b0', messageDef('Paid')),
    typedEvent(
      'intermediateCatchEvent',
      'Catch_p_1_b1',
      timerDef('duration', 'P3D'),
    ),
    user('Ship'),
    user('Chase'),
    gateway('Gateway_p_1_join'),
    end('E'),
  ],
  [
    ...chain(
      'S',
      'Gateway_p_1_race',
      'Catch_p_1_b0',
      'Ship',
      'Gateway_p_1_join',
    ),
    ...chain(
      'Gateway_p_1_race',
      'Catch_p_1_b1',
      'Chase',
      'Gateway_p_1_join',
      'E',
    ),
  ],
);

describe('irToDsl: race', () => {
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

  it('prints a wait with no route out as an empty branch, which ends the run where the model does when nothing follows the race', async () => {
    const ir = minimalProcess(
      [
        start('S'),
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
        user('Chase'),
        end('E'),
      ],
      [
        ...chain('S', 'Gateway_p_1_race', 'Catch_p_1_b0'),
        ...chain('Gateway_p_1_race', 'Catch_p_1_b1', 'Chase', 'E'),
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
        start('S'),
        { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b0',
          messageDef('Paid'),
        ),
        user('Chase'),
        end('E'),
      ],
      [
        ...chain('S', 'Gateway_p_1_race', 'Catch_p_1_b0', 'E'),
        ...chain('Gateway_p_1_race', 'Chase', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

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

describe('irToDsl: gateway settings', () => {
  const LONE_PASS_THROUGH_IR: BpmnProcess = minimalProcess(
    [start('S'), gateway('G'), user('A'), end('E')],
    flowChain('S', 'G', 'A', 'E'),
  );

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
