import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { ir as parseIr } from './helpers/parse.js';
import {
  createModdle,
  irToXml,
  HISTORY_TIME_TO_LIVE,
  SERVICE_TASK_LIKE_TAG,
} from '../src/ir-to-xml.js';
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
  ioParam,
  linkDef,
  messageDef,
  minimalProcess,
  scriptTask,
  signalDef,
  textValue,
  timerDef,
  typedEvent,
} from './helpers/ir-fixtures.js';
import type {
  BpmnProcess,
  CatchEventDefinition,
  FlowElement,
  FormField,
  Gateway,
  LoopCharacteristics,
  ServiceTask,
} from '../src/ir/types.js';

/**
 * Every event identity at once: an error handler and a compensation handler
 * inside a sub-process, alongside escalation and signal handlers, a message
 * handler, and the matching throws.
 */
const eventIr: BpmnProcess = {
  ...chained(
    [
      { kind: 'startEvent', id: 'PStart' },
      chainedSub(
        'OuterSub',
        [
          { kind: 'startEvent', id: 'OSubStart' },
          { kind: 'userTask', id: 'OWork' },
          { kind: 'endEvent', id: 'OSubEnd' },
        ],
        {
          unwired: [
            eventHandler(
              'ErrHandler',
              'ErrStart',
              errorDef('PF', { codeVariable: 'c', messageVariable: 'm' }),
            ),
            eventHandler('CompHandler', 'CompStart', { kind: 'compensation' }),
          ],
        },
      ),
      typedEvent('intermediateThrowEvent', 'EmitEsc', escalationDef('LS')),
      typedEvent('intermediateThrowEvent', 'EmitSig', signalDef('Cancelled')),
      typedEvent('intermediateThrowEvent', 'EmitComp', {
        kind: 'compensation',
      }),
      typedEvent('endEvent', 'ThrowPF', errorDef('PF')),
    ],
    {
      unwired: [
        eventHandler('EscHandler', 'EscStart', escalationDef('LS', 'v'), false),
        eventHandler('MsgHandler', 'MsgStart', messageDef('PaymentReceived')),
        eventHandler('SigHandler', 'SigStart', signalDef('Cancelled'), false),
      ],
    },
  ),
  errorDecls: [{ name: 'PF', code: 'PF', message: 'boom' }],
};

/** A transaction whose body holds a sub-process, so the expansion hint has to descend. */
const transactionIr: BpmnProcess = chained([
  { kind: 'startEvent', id: 'PStart' },
  {
    ...chainedSub('Book', [
      { kind: 'startEvent', id: 'TxStart' },
      chainedSub('Settle', [
        { kind: 'startEvent', id: 'SStart' },
        { kind: 'userTask', id: 'Ledger' },
        { kind: 'endEvent', id: 'SEnd' },
      ]),
      typedEvent('endEvent', 'GiveUp', { kind: 'cancel' }),
    ]),
    element: 'transaction',
  },
  { kind: 'endEvent', id: 'PEnd' },
]);

describe('irToXml: document', () => {
  // The golden is what the engine E2E deploys. The example holds no
  // sub-process, so this also pins that the expansion hint is only added for one.
  it('serializes the invoice example byte-for-byte as the generated golden', async () => {
    const source = readFileSync(
      new URL(
        '../../../examples/spring-boot/processes/invoice-approval.bpmnscript',
        import.meta.url,
      ),
      'utf-8',
    );
    expect(await irToXml(await parseIr(source))).toBe(
      readFileSync(
        new URL(
          '../../../tests/golden/invoice-approval-generated.bpmn',
          import.meta.url,
        ),
        'utf-8',
      ),
    );
  });

  // The second host exists one container down, which is why the message names
  // the container rule rather than an unknown id.
  it.each<[string, BpmnProcess, string | RegExp]>([
    [
      'two elements sharing an id, naming the moddle warning',
      minimalProcess([
        { kind: 'task', id: 'X' },
        { kind: 'task', id: 'X' },
      ]),
      /duplicate ID/,
    ],
    [
      'a default flow that does not exist, naming the gateway kind',
      minimalProcess([
        { kind: 'inclusiveGateway', id: 'Fork', defaultFlowId: 'F_absent' },
      ]),
      'inclusiveGateway "Fork" declares default flow "F_absent"',
    ],
    [
      'a boundary event whose host sits inside a sub-process',
      minimalProcess([
        chainedSub('Sub', [{ kind: 'userTask', id: 'Host' }]),
        boundaryEvent('Boundary_Host_x', 'Host', messageDef('Ping')),
      ]),
      'BoundaryEvent "Boundary_Host_x" is attached to "Host", which is not a flow element of this container.',
    ],
  ])('refuses %s', async (_title, ir, message) => {
    await expect(irToXml(ir)).rejects.toThrow(message);
  });
});

/** moddle writes the `$type` name with its first letter lowered. */
function serviceTaskLikeXmlTag(element: ServiceTask['element']): string {
  return SERVICE_TASK_LIKE_TAG[element ?? 'service'].replace(
    /:[A-Z]/,
    (prefixed) => prefixed.toLowerCase(),
  );
}

describe('irToXml: service-task-like tags and their bindings', () => {
  it.each<[string, Omit<ServiceTask, 'kind' | 'id'>, string, string?]>([
    [
      'a class binding writes operaton:class',
      { binding: classBinding('com.example.Run') },
      'operaton:class="com.example.Run"',
    ],
    [
      'a builtin shell binding writes operaton:type and its fields as extension children',
      {
        element: 'businessRule',
        binding: builtinBinding('shell', [
          { name: 'command', value: 'echo hi' },
          { name: 'arg1', value: '${input}' },
        ]),
      },
      'operaton:type="shell"',
      '<bpmn:extensionElements>\n' +
        '        <operaton:field name="command" stringValue="echo hi" />\n' +
        '        <operaton:field name="arg1">\n' +
        '          <operaton:expression>${input}</operaton:expression>\n' +
        '        </operaton:field>\n' +
        '      </bpmn:extensionElements>',
    ],
    [
      'a decision binding with no modifier writes decisionRef alone',
      {
        element: 'businessRule',
        binding: { kind: 'decision', decisionRef: 'riskRating' },
      },
      'operaton:decisionRef="riskRating"',
    ],
    [
      'a decision binding with a pinned version and a result mapping writes all four DMN attributes beside resultVariable',
      {
        element: 'businessRule',
        binding: {
          kind: 'decision',
          decisionRef: 'riskRating',
          binding: { kind: 'version', version: '3' },
          mapDecisionResult: 'singleEntry',
        },
        resultVariable: 'risk',
      },
      'operaton:resultVariable="risk" operaton:decisionRef="riskRating" operaton:decisionRefBinding="version" operaton:decisionRefVersion="3" operaton:mapDecisionResult="singleEntry"',
    ],
  ])('%s', async (_title, task, attributes, extension) => {
    const xml = await irToXml(
      around({ kind: 'serviceTask', id: 'T', ...task }),
    );
    expect([
      openingTag(xml, 'T'),
      xml.includes('<bpmn:extensionElements>')
        ? extensionBlock(xml)
        : undefined,
    ]).toEqual([
      `<${serviceTaskLikeXmlTag(task.element)} id="T" name="T" ${attributes}>`,
      extension,
    ]);
  });

  // `properties` before the mappings, `name` (not `id`) on a task's property,
  // and `errorRef` resolving to a synthesized root for a code nothing declares.
  it("writes an external task's priority, properties and one error root plus mapping per code", async () => {
    const xml = await irToXml(
      around({
        kind: 'serviceTask',
        id: 'T',
        element: 'businessRule',
        binding: {
          kind: 'external',
          topic: 'charge-card',
          taskPriority: '42',
          properties: [
            { key: 'gateway', value: 'stripe' },
            { key: 'currency', value: 'USD' },
          ],
          errorMappings: [
            {
              errorCode: 'DECLINED',
              condition: '${externalTask.errorMessage == "declined"}',
            },
            { errorCode: 'TIMEOUT', condition: '${retries == 0}' },
          ],
        },
      }),
    );
    expect(openingTag(xml, 'T')).toBe(
      '<bpmn:businessRuleTask id="T" name="T" operaton:type="external" operaton:topic="charge-card" operaton:taskPriority="42">',
    );
    expect(extensionBlock(xml)).toBe(`<bpmn:extensionElements>
        <operaton:properties>
          <operaton:property name="gateway" value="stripe" />
          <operaton:property name="currency" value="USD" />
        </operaton:properties>
        <operaton:errorEventDefinition errorRef="Error_DECLINED" expression="\${externalTask.errorMessage == &#34;declined&#34;}" />
        <operaton:errorEventDefinition errorRef="Error_TIMEOUT" expression="\${retries == 0}" />
      </bpmn:extensionElements>`);
    expect(
      rootsOfType(await parseDefs(xml), 'bpmn:Error').map((r) => r.errorCode),
    ).toEqual(['DECLINED', 'TIMEOUT']);
  });
});

describe('irToXml: documentation', () => {
  it("writes a bpmn:documentation child with the exact text and no textFormat, before the node's other children, on the process and every carrying node", async () => {
    const xml = await irToXml({
      ...chained([
        { kind: 'startEvent', id: 'Start' },
        { kind: 'userTask', id: 'Review', documentation: 'Review the order.' },
        { kind: 'endEvent', id: 'End', documentation: 'Order handled.' },
      ]),
      documentation: 'Process notes.',
    });
    const proc = await parseProc(xml);
    expect(
      [
        proc,
        ...['Start', 'Review', 'End'].map((id) => childById(proc, id)),
      ].map((node) => (node.documentation ?? []).map((doc) => doc.text)),
    ).toEqual([
      ['Process notes.'],
      [],
      ['Review the order.'],
      ['Order handled.'],
    ]);
    expect(xml.match(/<bpmn:documentation[^>]*>/g)).toEqual([
      '<bpmn:documentation>',
      '<bpmn:documentation>',
      '<bpmn:documentation>',
    ]);
    expect(extractNodeBlock(xml, 'Review').split('\n')[1]!.trim()).toBe(
      '<bpmn:documentation>Review the order.</bpmn:documentation>',
    );
  });
});

describe('irToXml: call activities', () => {
  it('emits a bpmn:CallActivity carrying its name, calledElement, business key, then in-mappings, then out-mappings, re-read clean', async () => {
    const xml = await irToXml(
      minimalCallIr({
        kind: 'callActivity',
        id: 'CallSub',
        name: 'Call sub',
        calledElement: 'sub-process',
        businessKey: '${execution.processBusinessKey}',
        inMappings: [
          { kind: 'all' },
          { kind: 'variable', source: 'amount', target: 'amount' },
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
        ],
      }),
    );
    await expectNoModdleWarnings(xml);
    const call = childById(await parseProc(xml), 'CallSub');
    expect(pick(call, ['$type', 'name', 'calledElement'])).toEqual({
      $type: 'bpmn:CallActivity',
      name: 'Call sub',
      calledElement: 'sub-process',
    });
    expect(
      (call.extensionElements?.values ?? []).map((v) => [
        v.$type,
        pick(v, [
          'businessKey',
          'variables',
          'source',
          'sourceExpression',
          'target',
          'local',
        ]),
      ]),
    ).toEqual([
      ['operaton:In', { businessKey: '${execution.processBusinessKey}' }],
      ['operaton:In', { variables: 'all' }],
      ['operaton:In', { source: 'amount', target: 'amount' }],
      [
        'operaton:In',
        { sourceExpression: '${total * 2}', target: 'doubled', local: true },
      ],
      ['operaton:Out', { source: 'result', target: 'outcome' }],
      ['operaton:Out', { sourceExpression: '${status}', target: 'final' }],
    ]);
  });

  it.each<[string, Partial<FlowElement>, Record<string, string>]>([
    [
      'a version binding writes calledElementBinding and calledElementVersion',
      { binding: { kind: 'version', version: '7' } },
      { calledElementBinding: 'version', calledElementVersion: '7' },
    ],
    [
      'a class mapper writes operaton:variableMappingClass alone',
      { mapper: { kind: 'class', className: 'com.acme.Mapper' } },
      { variableMappingClass: 'com.acme.Mapper' },
    ],
    [
      'a delegate mapper writes operaton:variableMappingDelegateExpression alone',
      { mapper: { kind: 'delegateExpression', expression: '${mapperBean}' } },
      { variableMappingDelegateExpression: '${mapperBean}' },
    ],
  ])('%s', async (_title, extra, expected) => {
    const ir = minimalCallIr({
      ...callActivity('ProcessPayment', 'sub'),
      ...extra,
    } as FlowElement);
    expect(
      pick(childById(await parseProc(await irToXml(ir)), 'ProcessPayment'), [
        'name',
        'calledElementBinding',
        'calledElementVersion',
        'variableMappingClass',
        'variableMappingDelegateExpression',
        'extensionElements',
      ]),
    ).toEqual({ name: 'Process Payment', ...expected });
  });
});

describe('irToXml: event layer', () => {
  it('synthesizes one root per error, escalation, message and signal identity, in that order, shared by every referrer, none for compensation', async () => {
    const xml = await irToXml(eventIr);
    const defs = await parseDefs(xml);
    expect(
      defs.rootElements.map((r) =>
        pick(r, [
          '$type',
          'id',
          'name',
          'errorCode',
          'errorMessage',
          'escalationCode',
        ]),
      ),
    ).toEqual([
      { $type: 'bpmn:Process', id: 'proc', name: 'Proc' },
      {
        $type: 'bpmn:Error',
        id: 'Error_PF',
        name: 'PF',
        errorCode: 'PF',
        errorMessage: 'boom',
      },
      {
        $type: 'bpmn:Escalation',
        id: 'Escalation_LS',
        name: 'LS',
        escalationCode: 'LS',
      },
      {
        $type: 'bpmn:Message',
        id: 'Message_PaymentReceived',
        name: 'PaymentReceived',
      },
      { $type: 'bpmn:Signal', id: 'Signal_Cancelled', name: 'Cancelled' },
    ]);

    const referrers = [
      'ErrStart',
      'ThrowPF',
      'EscStart',
      'EmitEsc',
      'MsgStart',
      'SigStart',
      'EmitSig',
      'CompStart',
      'EmitComp',
    ];
    expect(
      referrers.map((id) => {
        const def = soleDef(requireDeep(defs, id));
        const ref =
          def.errorRef ?? def.escalationRef ?? def.messageRef ?? def.signalRef;
        return `${id} ${def.$type} ${ref?.id ?? '-'}`;
      }),
    ).toEqual([
      'ErrStart bpmn:ErrorEventDefinition Error_PF',
      'ThrowPF bpmn:ErrorEventDefinition Error_PF',
      'EscStart bpmn:EscalationEventDefinition Escalation_LS',
      'EmitEsc bpmn:EscalationEventDefinition Escalation_LS',
      'MsgStart bpmn:MessageEventDefinition Message_PaymentReceived',
      'SigStart bpmn:SignalEventDefinition Signal_Cancelled',
      'EmitSig bpmn:SignalEventDefinition Signal_Cancelled',
      'CompStart bpmn:CompensateEventDefinition -',
      'EmitComp bpmn:CompensateEventDefinition -',
    ]);

    expect(
      ['ErrHandler', 'EscHandler', 'MsgHandler', 'SigHandler'].map((id) => {
        const handler = requireDeep(defs, id);
        return [
          handler.triggeredByEvent,
          handler.flowElements![0]!.isInterrupting,
        ];
      }),
    ).toEqual([
      [true, true],
      [true, false],
      [true, true],
      [true, false],
    ]);
    expect([
      pick(soleDef(requireDeep(defs, 'ErrStart')), [
        'errorCodeVariable',
        'errorMessageVariable',
      ]),
      soleDef(requireDeep(defs, 'EscStart')).escalationCodeVariable,
    ]).toEqual([{ errorCodeVariable: 'c', errorMessageVariable: 'm' }, 'v']);
    expect(extractNodeBlock(xml, 'CompStart')).toBe(
      '<bpmn:startEvent id="CompStart">\n' +
        '          <bpmn:outgoing>SF_CompStart_CompHandler_Work</bpmn:outgoing>\n' +
        '          <bpmn:compensateEventDefinition />\n' +
        '        </bpmn:startEvent>',
    );
  });

  it('emits a root per declaration nothing raises, named by the declaration and keyed by its code, and none for a catch-all handler', async () => {
    const defs = await xmlDefs({
      ...chained(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'endEvent', id: 'E' },
        ],
        { unwired: [eventHandler('AnyErr', 'AnyStart', errorDef())] },
      ),
      errorDecls: [
        { name: 'OrderFailed', code: 'order.failed', message: 'gone' },
      ],
      escalationDecls: [{ name: 'ManualReview', code: 'MANUAL_REVIEW' }],
    });
    expect(
      defs.rootElements
        .slice(1)
        .map((r) =>
          pick(r, [
            'id',
            'name',
            'errorCode',
            'errorMessage',
            'escalationCode',
          ]),
        ),
    ).toEqual([
      {
        id: 'Error_order.failed',
        name: 'OrderFailed',
        errorCode: 'order.failed',
        errorMessage: 'gone',
      },
      {
        id: 'Escalation_MANUAL_REVIEW',
        name: 'ManualReview',
        escalationCode: 'MANUAL_REVIEW',
      },
    ]);
    expect(soleDef(requireDeep(defs, 'AnyStart')).errorRef).toBeUndefined();
  });

  // The engine reads a thrown message's implementation off the definition and
  // ignores the same attribute on the event.
  it('writes an emitted message binding onto the message definition, nothing on the event', async () => {
    const xml = await irToXml(
      around({
        ...typedEvent('intermediateThrowEvent', 'Sent', messageDef('Ack')),
        binding: delegateBinding('${senderBean}'),
      }),
    );
    expect([
      openingTag(xml, 'Sent'),
      childBlock(xml, 'Sent', 'bpmn:messageEventDefinition'),
    ]).toEqual([
      '<bpmn:intermediateThrowEvent id="Sent">',
      '<bpmn:messageEventDefinition messageRef="Message_Ack" operaton:delegateExpression="${senderBean}" />',
    ]);
  });
});

describe('irToXml: intermediate and boundary events', () => {
  it.each<[string, CatchEventDefinition, Record<string, string>]>([
    [
      'a date timer',
      timerDef('date', '${dueDate}'),
      { $type: 'bpmn:TimerEventDefinition', timeDate: '${dueDate}' },
    ],
    [
      'a cycle timer',
      timerDef('cycle', 'R/PT10M'),
      { $type: 'bpmn:TimerEventDefinition', timeCycle: 'R/PT10M' },
    ],
    [
      'a condition, its body the raw expression',
      conditionDef('${amount > 100}'),
      {
        $type: 'bpmn:ConditionalEventDefinition',
        condition: '${amount > 100}',
      },
    ],
  ])(
    'an await on %s writes that definition alone',
    async (_t, def, expected) => {
      const d = soleDef(
        requireDeep(
          await xmlDefs(
            around(typedEvent('intermediateCatchEvent', 'Wait', def)),
          ),
          'Wait',
        ),
      );
      expect(
        Object.fromEntries(
          Object.entries({
            $type: d.$type,
            timeDuration: d.timeDuration?.body,
            timeDate: d.timeDate?.body,
            timeCycle: d.timeCycle?.body,
            condition: d.condition?.body,
          }).filter(([, v]) => v !== undefined),
        ),
      ).toEqual(expected);
    },
  );

  it("writes a non-exclusive timer job's lock on the definition as well as the tag, where BpmnParse.parseTimer reads it", async () => {
    const xml = await irToXml(
      around({
        ...typedEvent(
          'intermediateCatchEvent',
          'Wait',
          timerDef('duration', 'PT1H'),
        ),
        exclusive: false,
      }),
    );
    expect([
      openingTag(xml, 'Wait'),
      openingTag(xml, 'Wait', 'bpmn:timerEventDefinition'),
    ]).toEqual([
      '<bpmn:intermediateCatchEvent id="Wait" operaton:exclusive="false">',
      '<bpmn:timerEventDefinition operaton:exclusive="false">',
    ]);
  });

  it('emits a link pair as two events named by the link, nothing leaving the throw, nothing entering the catch, both laid out, no root', async () => {
    const xml = await irToXml(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'PStart' },
          typedEvent('intermediateThrowEvent', 'ToRetry', linkDef('Retry')),
          typedEvent('intermediateCatchEvent', 'AtRetry', linkDef('Retry')),
          { kind: 'endEvent', id: 'PEnd' },
        ],
        [edge('PStart', 'ToRetry'), edge('AtRetry', 'PEnd')],
      ),
    );
    const defs = await parseDefs(xml);
    expect(
      ['ToRetry', 'AtRetry'].map((id) => {
        const node = requireDeep(defs, id);
        const def = soleDef(node);
        return [
          node.$type,
          node.name,
          def.$type,
          def.name,
          node.incoming?.length ?? 0,
          node.outgoing?.length ?? 0,
        ];
      }),
    ).toEqual([
      [
        'bpmn:IntermediateThrowEvent',
        'Retry',
        'bpmn:LinkEventDefinition',
        'Retry',
        1,
        0,
      ],
      [
        'bpmn:IntermediateCatchEvent',
        'Retry',
        'bpmn:LinkEventDefinition',
        'Retry',
        0,
        1,
      ],
    ]);
    expect(defs.rootElements).toHaveLength(1);
    expect([...(await diShapes(xml)).keys()].sort()).toEqual([
      'AtRetry',
      'PEnd',
      'PStart',
      'ToRetry',
    ]);
  });

  it('writes a non-interrupting boundary attached to its host, with no name, no incoming and its definition', async () => {
    const xml = await irToXml(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'PStart' },
          { kind: 'userTask', id: 'Host' },
          { kind: 'endEvent', id: 'PEnd' },
          boundaryEvent('Boundary_Host_x', 'Host', messageDef('Ping'), false),
          { kind: 'endEvent', id: 'BoundaryEnd' },
        ],
        [
          edge('PStart', 'Host'),
          edge('Host', 'PEnd'),
          edge('Boundary_Host_x', 'BoundaryEnd', { id: 'SF_Boundary' }),
        ],
      ),
    );
    expect(extractNodeBlock(xml, 'Boundary_Host_x')).toBe(
      '<bpmn:boundaryEvent id="Boundary_Host_x" cancelActivity="false" attachedToRef="Host">\n' +
        '      <bpmn:outgoing>SF_Boundary</bpmn:outgoing>\n' +
        '      <bpmn:messageEventDefinition messageRef="Message_Ping" />\n' +
        '    </bpmn:boundaryEvent>',
    );
  });
});

describe('irToXml: engine settings', () => {
  it('writes the whole set of Operaton attributes the process IR carries, and the exported history default when it carries none', async () => {
    const proc = await parseProc(
      await irToXml({
        ...minimalProcess([{ kind: 'startEvent', id: 'S' }]),
        versionTag: '1.4.2',
        historyTimeToLive: 'P90D',
        candidateStarterUsers: 'demo,manager',
        candidateStarterGroups: 'adjusters',
      }),
    );
    expect(
      pick(proc, [
        'versionTag',
        'historyTimeToLive',
        'candidateStarterUsers',
        'candidateStarterGroups',
      ]),
    ).toEqual({
      versionTag: '1.4.2',
      historyTimeToLive: 'P90D',
      candidateStarterUsers: 'demo,manager',
      candidateStarterGroups: 'adjusters',
    });
    // The projection covers every process property the descriptor declares,
    // so an empty `$attrs` closes the undeclared case.
    expect(proc.$attrs).toEqual({});

    const bare = await parseProc(
      await irToXml(minimalProcess([{ kind: 'startEvent', id: 'S' }])),
    );
    expect(bare.historyTimeToLive).toBe(HISTORY_TIME_TO_LIVE);
  });

  it("writes each node's settings as its own operaton: attributes and extension children, the retry cycle as a child, and nothing on a node carrying none", async () => {
    const xml = await irToXml(
      minimalProcess(
        [
          {
            kind: 'startEvent',
            id: 'Start',
            asyncAfter: true,
            jobPriority: '50',
            initiator: 'claimant',
          },
          {
            kind: 'userTask',
            id: 'Review',
            assignee: 'demo',
            formKey: 'embedded:app:forms/review.html',
            candidateUsers: 'ann,bob',
            candidateGroups: 'approvers',
            dueDate: '${dateTime().plusDays(2)}',
            followUpDate: '2026-01-31T12:00:00',
            priority: '75',
            asyncBefore: true,
            exclusive: false,
            formFields: [{ id: 'amount', type: 'number', label: 'Amount' }],
            retryCycle: 'R3/PT5M',
          },
          {
            kind: 'serviceTask',
            id: 'Auto',
            binding: exprBinding('${auto.run(execution)}'),
            resultVariable: 'outcome',
          },
          {
            kind: 'scriptTask',
            id: 'Calc',
            format: 'javascript',
            code: 'total = 1;',
            resultVariable: 'total',
            retryCycle: 'R3/PT10M',
          },
          { kind: 'endEvent', id: 'End' },
        ],
        flowChain('Start', 'Review', 'Auto', 'Calc', 'End'),
      ),
    );
    expect(
      ['Start', 'Review', 'Auto', 'Calc', 'End'].map((id) =>
        openingTag(xml, id),
      ),
    ).toEqual([
      '<bpmn:startEvent id="Start" operaton:asyncAfter="true" operaton:jobPriority="50" operaton:initiator="claimant">',
      '<bpmn:userTask id="Review" name="Review" operaton:asyncBefore="true" operaton:exclusive="false" operaton:assignee="demo" operaton:candidateUsers="ann,bob" operaton:candidateGroups="approvers" operaton:dueDate="${dateTime().plusDays(2)}" operaton:followUpDate="2026-01-31T12:00:00" operaton:priority="75" operaton:formKey="embedded:app:forms/review.html">',
      '<bpmn:serviceTask id="Auto" name="Auto" operaton:expression="${auto.run(execution)}" operaton:resultVariable="outcome">',
      '<bpmn:scriptTask id="Calc" name="Calc" scriptFormat="javascript" operaton:resultVariable="total">',
      '<bpmn:endEvent id="End">',
    ]);
    expect(
      ['Start', 'Review', 'Auto', 'Calc', 'End'].map((id) =>
        childBlock(xml, id, 'bpmn:extensionElements'),
      ),
    ).toEqual([
      undefined,
      '<bpmn:extensionElements>\n' +
        '        <operaton:formData>\n' +
        '          <operaton:formField id="amount" label="Amount" type="long" />\n' +
        '        </operaton:formData>\n' +
        '        <operaton:failedJobRetryTimeCycle>R3/PT5M</operaton:failedJobRetryTimeCycle>\n' +
        '      </bpmn:extensionElements>',
      undefined,
      '<bpmn:extensionElements>\n' +
        '        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>\n' +
        '      </bpmn:extensionElements>',
      undefined,
    ]);
  });

  it.each<[Gateway['kind'], string]>([
    ['parallelGateway', 'bpmn:parallelGateway'],
    ['eventBasedGateway', 'bpmn:eventBasedGateway'],
  ])(
    'a %s serializes its job settings like an activity, and none of its listeners',
    async (kind, tag) => {
      const settingsXml = await irToXml(
        around({
          kind,
          id: 'G',
          asyncBefore: true,
          asyncAfter: true,
          exclusive: false,
          jobPriority: '30',
          retryCycle: 'R3/PT1M',
        } as Gateway),
      );
      // The type forbids a listener on a gateway, so the cast supplies the
      // shape to see the guard.
      const listenerXml = await irToXml(
        around({
          kind,
          id: 'G',
          executionListeners: [
            { event: 'start', binding: classBinding('x.L') },
          ],
        } as unknown as Gateway),
      );
      expect([
        openingTag(settingsXml, 'G'),
        childBlock(settingsXml, 'G', 'bpmn:extensionElements'),
        openingTag(listenerXml, 'G'),
        childBlock(listenerXml, 'G', 'bpmn:extensionElements'),
      ]).toEqual([
        `<${tag} id="G" operaton:asyncBefore="true" operaton:asyncAfter="true" operaton:exclusive="false" operaton:jobPriority="30">`,
        '<bpmn:extensionElements>\n' +
          '        <operaton:failedJobRetryTimeCycle>R3/PT1M</operaton:failedJobRetryTimeCycle>\n' +
          '      </bpmn:extensionElements>',
        `<${tag} id="G">`,
        undefined,
      ]);
    },
  );
});

describe('irToXml: extension elements', () => {
  it('writes every group a user task carries under one wrapper in canonical order, parameters in IR order, listeners unprefixed', async () => {
    const xml = await irToXml(
      around({
        kind: 'userTask',
        id: 'Review',
        formFields: [{ id: 'amount', type: 'number' }],
        inputParameters: [
          { name: 'plain', value: { kind: 'text', text: 'hello' } },
          {
            name: 'scripted',
            value: { kind: 'script', format: 'groovy', code: 'a + b' },
          },
          {
            name: 'nested',
            value: {
              kind: 'list',
              items: [
                { kind: 'text', text: 'first' },
                {
                  kind: 'map',
                  entries: [
                    { key: 'inner', value: { kind: 'text', text: 'x' } },
                    {
                      key: 'deeper',
                      value: {
                        kind: 'list',
                        items: [{ kind: 'text', text: 'z' }],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
        outputParameters: [
          {
            name: 'result',
            value: {
              kind: 'map',
              entries: [{ key: 'code', value: { kind: 'text', text: '200' } }],
            },
          },
        ],
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.Enter') },
          {
            event: 'end',
            binding: { kind: 'script', format: 'javascript', code: 'log(1);' },
          },
        ],
        taskListeners: [
          { event: 'create', binding: exprBinding('${audit.log()}') },
          {
            event: 'timeout',
            binding: delegateBinding('${escalate}'),
            timer: timerDef('duration', 'PT2H'),
          },
        ],
        retryCycle: 'R3/PT5M',
      }),
    );
    expect(xml.match(/<bpmn:extensionElements/g)).toHaveLength(1);
    const review = childById(await parseProc(xml), 'Review');
    expect(review.extensionElements?.values.map((v) => v.$type)).toEqual([
      'operaton:InputOutput',
      'operaton:FormData',
      'operaton:ExecutionListener',
      'operaton:ExecutionListener',
      'operaton:TaskListener',
      'operaton:TaskListener',
      'operaton:FailedJobRetryTimeCycle',
    ]);

    const block = extensionBlock(xml);
    expect(
      [
        ...block.matchAll(/<operaton:(?:in|out)putParameter name="([^"]+)"/g),
      ].map((m) => m[1]),
    ).toEqual(['plain', 'scripted', 'nested', 'result']);
    expect(
      ['plain', 'scripted', 'nested', 'result'].map((name) =>
        parameterContent(block, name).replace(/\s*\n\s*/g, ''),
      ),
    ).toEqual([
      'hello',
      '<operaton:script scriptFormat="groovy">a + b</operaton:script>',
      '<operaton:list><operaton:value>first</operaton:value><operaton:map><operaton:entry key="inner">x</operaton:entry><operaton:entry key="deeper"><operaton:list><operaton:value>z</operaton:value></operaton:list></operaton:entry></operaton:map></operaton:list>',
      '<operaton:map><operaton:entry key="code">200</operaton:entry></operaton:map>',
    ]);

    // A prefixed attribute here would be one the engine ignores, and the
    // parsed tree reports the property either way, so this reads the text.
    expect(listenerTags(block)).toEqual([
      '<operaton:executionListener event="start" class="com.example.Enter" />',
      '<operaton:executionListener event="end">',
      '<operaton:taskListener event="create" expression="${audit.log()}" />',
      '<operaton:taskListener id="Review_timeout_1" event="timeout" delegateExpression="${escalate}">',
    ]);
    expect(block).toMatch(
      /<operaton:executionListener event="end">\s*<operaton:script scriptFormat="javascript">log\(1\);<\/operaton:script>\s*<\/operaton:executionListener>/,
    );
    expect(block).toMatch(
      /event="timeout"[^>]*>\s*<bpmn:timerEventDefinition>\s*<bpmn:timeDuration[^>]*>PT2H<\/bpmn:timeDuration>\s*<\/bpmn:timerEventDefinition>\s*<\/operaton:taskListener>/,
    );
  });

  it('a class-bound task listener writes a literal field as stringValue and a ${...} or #{...} one as an expression child', async () => {
    const xml = await irToXml(
      around({
        kind: 'userTask',
        id: 'Task',
        taskListeners: [
          {
            event: 'create',
            binding: {
              ...classBinding('com.example.Impl'),
              fields: [
                { name: 'literal', value: 'hello' },
                { name: 'raw', value: '${x}' },
                { name: 'deferred', value: '#{x}' },
              ],
            },
          },
        ],
      }),
    );
    expect(
      [
        ...xml.matchAll(/<operaton:field [\s\S]*?(?:\/>|<\/operaton:field>)/g),
      ].map((m) => m[0].replace(/\s*\n\s*/g, '')),
    ).toEqual([
      '<operaton:field name="literal" stringValue="hello" />',
      '<operaton:field name="raw"><operaton:expression>${x}</operaton:expression></operaton:field>',
      '<operaton:field name="deferred"><operaton:expression>#{x}</operaton:expression></operaton:field>',
    ]);
  });

  it("places a call activity's io block before its mappings and its retry cycle last", async () => {
    const xml = await irToXml(
      minimalCallIr({
        ...callActivity('CallSub', 'sub-process'),
        inputParameters: [ioParam('amount', textValue('${total}'))],
        inMappings: [{ kind: 'all' }],
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.Enter') },
        ],
        retryCycle: 'R5/PT1M',
      }),
    );
    const call = childById(await parseProc(xml), 'CallSub');
    expect(call.extensionElements?.values.map((v) => v.$type)).toEqual([
      'operaton:InputOutput',
      'operaton:In',
      'operaton:ExecutionListener',
      'operaton:FailedJobRetryTimeCycle',
    ]);
  });

  it('emits nothing but the io block for a node carrying only parameters', async () => {
    const xml = await irToXml(
      around({
        kind: 'serviceTask',
        id: 'Fetch',
        binding: externalBinding('fetch'),
        outputParameters: [ioParam('body', textValue('${response}'))],
      }),
    );
    expect(xml.match(/<bpmn:extensionElements/g)).toHaveLength(1);
    expect(extensionBlock(xml)).toMatch(
      /^<bpmn:extensionElements>\s*<operaton:inputOutput>\s*<operaton:outputParameter name="body">\$\{response\}<\/operaton:outputParameter>\s*<\/operaton:inputOutput>\s*<\/bpmn:extensionElements>$/,
    );
  });
});

describe('irToXml: user task forms', () => {
  it('writes a formRef with a latest binding as formRef and formRefBinding, no version', async () => {
    const xml = await irToXml(
      around({
        kind: 'userTask',
        id: 'Task',
        formRef: { key: 'review-form', binding: { kind: 'latest' } },
      }),
    );
    expect(
      pick(childById(await parseProc(xml), 'Task'), [
        'formRef',
        'formRefBinding',
        'formRefVersion',
      ]),
    ).toEqual({ formRef: 'review-form', formRefBinding: 'latest' });
  });

  it('serializes every extra a form field carries in descriptor order, datePattern and constraints in IR order, and no empty group for a field with none', async () => {
    const fields: FormField[] = [
      {
        id: 'plan',
        type: 'enum',
        label: 'Plan',
        defaultValue: 'basic',
        properties: [{ key: 'description', value: 'Sets the fee' }],
        constraints: [
          { name: 'required' },
          { name: 'validator', config: 'com.example.Check' },
        ],
        values: [{ id: 'basic', label: 'Basic' }, { id: 'plus' }],
      },
      { id: 'birthDate', type: 'date', datePattern: 'dd/MM/yyyy' },
      {
        id: 'amount',
        type: 'number',
        constraints: [
          { name: 'min', config: '0' },
          { name: 'max', config: '5000' },
        ],
      },
      { id: 'note', type: 'string' },
    ];
    const xml = await irToXml(
      around({ kind: 'userTask', id: 'Task', formFields: fields }),
    );
    expect(extensionBlock(xml)).toBe(`<bpmn:extensionElements>
        <operaton:formData>
          <operaton:formField id="plan" label="Plan" type="enum" defaultValue="basic">
            <operaton:properties>
              <operaton:property id="description" value="Sets the fee" />
            </operaton:properties>
            <operaton:validation>
              <operaton:constraint name="required" />
              <operaton:constraint name="validator" config="com.example.Check" />
            </operaton:validation>
            <operaton:value id="basic" name="Basic" />
            <operaton:value id="plus" />
          </operaton:formField>
          <operaton:formField id="birthDate" type="date" datePattern="dd/MM/yyyy" />
          <operaton:formField id="amount" type="long">
            <operaton:validation>
              <operaton:constraint name="min" config="0" />
              <operaton:constraint name="max" config="5000" />
            </operaton:validation>
          </operaton:formField>
          <operaton:formField id="note" type="string" />
        </operaton:formData>
      </bpmn:extensionElements>`);
  });
});

describe('irToXml: task kinds', () => {
  it('emits a bare bpmn:task, and one bpmn:Message root shared by a receive task and an await of its name, re-read clean', async () => {
    const xml = await irToXml(
      chained([
        { kind: 'startEvent', id: 'Start' },
        { kind: 'task', id: 'Step' },
        { kind: 'receiveTask', id: 'Wait', messageName: 'OrderPaid' },
        typedEvent('intermediateCatchEvent', 'Again', messageDef('OrderPaid')),
        {
          kind: 'serviceTask',
          id: 'Notify',
          element: 'send',
          binding: classBinding('com.example.Notify'),
        },
        {
          kind: 'serviceTask',
          id: 'Rate',
          element: 'businessRule',
          binding: {
            kind: 'decision',
            decisionRef: 'riskRating',
            binding: { kind: 'version', version: '3' },
            mapDecisionResult: 'singleEntry',
          },
          resultVariable: 'risk',
        },
        { kind: 'endEvent', id: 'End' },
      ]),
    );
    await expectNoModdleWarnings(xml);
    expect(openingTag(xml, 'Step')).toBe('<bpmn:task id="Step" name="Step">');
    const defs = await parseDefs(xml);
    expect(
      rootsOfType(defs, 'bpmn:Message').map((r) => pick(r, ['id', 'name'])),
    ).toEqual([{ id: 'Message_OrderPaid', name: 'OrderPaid' }]);
    const wait = requireDeep(defs, 'Wait');
    expect([
      wait.$type,
      wait.messageRef?.id,
      soleDef(requireDeep(defs, 'Again')).messageRef?.id,
    ]).toEqual(['bpmn:ReceiveTask', 'Message_OrderPaid', 'Message_OrderPaid']);
  });
});

const OVER_LINES: LoopCharacteristics = {
  collection: 'lines',
  elementVariable: 'line',
};
const OVER_LINES_TAG =
  '<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" operaton:elementVariable="line" />';

describe('irToXml: multi-instance loop characteristics', () => {
  it('writes the loop child under the own tag of every kind that can carry one, re-read clean', async () => {
    const xml = await irToXml(
      chained([
        { kind: 'startEvent', id: 'Start' },
        { kind: 'task', id: 'Step', loop: OVER_LINES },
        { kind: 'userTask', id: 'Approve', loop: OVER_LINES },
        {
          kind: 'serviceTask',
          id: 'Notify',
          element: 'send',
          binding: classBinding('com.example.Notify'),
          loop: OVER_LINES,
        },
        {
          ...scriptTask('Compute', 'javascript', 'var x = 1;'),
          loop: OVER_LINES,
        },
        { kind: 'receiveTask', id: 'Wait', loop: OVER_LINES },
        {
          ...chainedSub(
            'Fulfil',
            [
              { kind: 'startEvent', id: 'SubStart' },
              { kind: 'endEvent', id: 'SubEnd' },
            ],
            { prefix: 'SubFlow' },
          ),
          loop: OVER_LINES,
        },
        { ...callActivity('Regional', 'regional-report'), loop: OVER_LINES },
        { kind: 'endEvent', id: 'End' },
      ]),
    );
    await expectNoModdleWarnings(xml);
    expect(
      [
        'Step',
        'Approve',
        'Notify',
        'Compute',
        'Wait',
        'Fulfil',
        'Regional',
      ].map(
        (id) =>
          `${extractNodeBlock(xml, id).split(' ')[0]} ${childBlock(xml, id, 'bpmn:multiInstanceLoopCharacteristics')}`,
      ),
    ).toEqual(
      [
        '<bpmn:task',
        '<bpmn:userTask',
        '<bpmn:sendTask',
        '<bpmn:scriptTask',
        '<bpmn:receiveTask',
        '<bpmn:subProcess',
        '<bpmn:callActivity',
      ].map((tag) => `${tag} ${OVER_LINES_TAG}`),
    );
  });

  it.each<[string, LoopCharacteristics, string | undefined]>([
    [
      'a sequential loop writes isSequential before the collection',
      { ...OVER_LINES, sequential: true },
      '<bpmn:multiInstanceLoopCharacteristics isSequential="true" operaton:collection="lines" operaton:elementVariable="line" />',
    ],
    [
      'a count is the loopCardinality body',
      { cardinality: '${n}' },
      '<bpmn:multiInstanceLoopCharacteristics>\n' +
        '        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">${n}</bpmn:loopCardinality>\n' +
        '      </bpmn:multiInstanceLoopCharacteristics>',
    ],
    [
      'a completion condition is the completionCondition body, escaped by the writer',
      { ...OVER_LINES, completionCondition: '${nrOfCompletedInstances >= 2}' },
      '<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" operaton:elementVariable="line">\n' +
        '        <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">${nrOfCompletedInstances &gt;= 2}</bpmn:completionCondition>\n' +
        '      </bpmn:multiInstanceLoopCharacteristics>',
    ],
  ])('%s', async (_title, loop, expected) => {
    const xml = await irToXml(
      around({ kind: 'userTask', id: 'Approve', loop }),
    );
    expect(
      childBlock(xml, 'Approve', 'bpmn:multiInstanceLoopCharacteristics'),
    ).toBe(expected);
  });
});

describe('irToXml: sub-process layout', () => {
  it.each<[string, BpmnProcess, Record<string, string[]>]>([
    [
      'event sub-processes, nested and top-level',
      eventIr,
      {
        OuterSub: [
          'OSubStart',
          'OWork',
          'OSubEnd',
          'ErrHandler',
          'CompHandler',
        ],
        ErrHandler: ['ErrStart', 'ErrHandler_Work', 'ErrHandler_End'],
        CompHandler: ['CompStart', 'CompHandler_Work', 'CompHandler_End'],
        EscHandler: ['EscStart', 'EscHandler_Work', 'EscHandler_End'],
        MsgHandler: ['MsgStart', 'MsgHandler_Work', 'MsgHandler_End'],
        SigHandler: ['SigStart', 'SigHandler_Work', 'SigHandler_End'],
      },
    ],
    [
      'a transaction holding a sub-process',
      transactionIr,
      {
        Book: ['TxStart', 'Settle', 'GiveUp'],
        Settle: ['SStart', 'Ledger', 'SEnd'],
      },
    ],
  ])(
    'lays every child strictly inside its parent, under one diagram: %s',
    async (_title, ir, containment) => {
      const xml = await irToXml(ir);
      expect(xml.match(/<bpmndi:BPMNDiagram\b/g)).toHaveLength(1);
      const shapes = await diShapes(xml);
      for (const [parentId, childIds] of Object.entries(containment)) {
        const outer = requireShape(shapes, parentId);
        const outside = childIds.filter((id) => {
          const inner = requireShape(shapes, id);
          return !(
            inner.x > outer.x &&
            inner.y > outer.y &&
            inner.x + inner.width < outer.x + outer.width &&
            inner.y + inner.height < outer.y + outer.height
          );
        });
        expect(outside, parentId).toEqual([]);
      }
    },
  );
});

async function expectNoModdleWarnings(xml: string): Promise<void> {
  const { warnings } = await createModdle().fromXML(xml);
  expect(warnings).toEqual([]);
}

/** The listed properties of a parsed node, the `undefined` ones left out. */
function pick(
  node: Moddle,
  keys: readonly (keyof Moddle)[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((k) => node[k] !== undefined).map((k) => [k, node[k]]),
  );
}

/**
 * The first `<bpmn:extensionElements>` block, as raw text: the parsed tree
 * reports a property whether or not its prefix was written the way the engine
 * expects.
 */
function extensionBlock(xml: string): string {
  const closeTag = '</bpmn:extensionElements>';
  const open = xml.indexOf('<bpmn:extensionElements>');
  const close = xml.indexOf(closeTag);
  if (open === -1 || close === -1) {
    throw new Error('No <bpmn:extensionElements> block in the output.');
  }
  return xml.slice(open, close + closeTag.length);
}

function parameterContent(block: string, name: string): string {
  const match = block.match(
    new RegExp(
      `<operaton:(in|out)putParameter name="${name}">([\\s\\S]*?)</operaton:\\1putParameter>`,
    ),
  );
  if (match === null) throw new Error(`No parameter named "${name}".`);
  return match[2]!;
}

function listenerTags(block: string): string[] {
  return [...block.matchAll(/<operaton:(?:execution|task)Listener[^>]*>/g)].map(
    (m) => m[0],
  );
}

/** Parsed with the Operaton extension, so an undeclared `operaton:` name draws a warning. */
async function parseDefs(xml: string): Promise<Moddle> {
  const { rootElement } = await createModdle().fromXML(xml);
  return rootElement as unknown as Moddle;
}

const xmlDefs = async (ir: BpmnProcess): Promise<Moddle> =>
  parseDefs(await irToXml(ir));

const parseProc = async (xml: string): Promise<Moddle> =>
  processOf(await parseDefs(xml));

function processOf(defs: Moddle): Moddle {
  const proc = defs.rootElements.find((e) => e.$type === 'bpmn:Process');
  if (proc === undefined) throw new Error('No bpmn:Process in the output.');
  return proc;
}

function rootsOfType(defs: Moddle, $type: string): Moddle[] {
  return defs.rootElements.filter((r) => r.$type === $type);
}

function requireDeep(defs: Moddle, id: string): Moddle {
  const find = (container: Moddle): Moddle | undefined => {
    for (const el of container.flowElements ?? []) {
      if (el.id === id) return el;
      const nested = find(el);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const found = find(processOf(defs));
  if (found === undefined) throw new Error(`Flow node id="${id}" not found.`);
  return found;
}

function childById(container: Moddle, id: string): Moddle {
  const found = (container.flowElements ?? []).find((e) => e.id === id);
  if (found === undefined) throw new Error(`Child id="${id}" not found.`);
  return found;
}

function soleDef(node: Moddle): Moddle {
  const def = node.eventDefinitions?.[0];
  if (def === undefined)
    throw new Error(`Node id="${node.id}" has no event definition.`);
  return def;
}

function minimalCallIr(call: FlowElement): BpmnProcess {
  return minimalProcess(
    [
      { kind: 'startEvent', id: 'Start' },
      call,
      { kind: 'endEvent', id: 'End' },
    ],
    [edge('Start', call.id), edge(call.id, 'End')],
  );
}

interface DiBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every `bpmndi:BPMNShape` bounds, keyed by the id of the element it lays out. */
async function diShapes(xml: string): Promise<Map<string, DiBounds>> {
  const defs = (await createModdle().fromXML(xml)).rootElement as unknown as {
    diagrams?: {
      plane?: {
        planeElement?: {
          $type: string;
          bpmnElement?: { id: string };
          bounds?: DiBounds;
        }[];
      };
    }[];
  };
  const shapes = new Map<string, DiBounds>();
  for (const el of defs.diagrams?.[0]?.plane?.planeElement ?? []) {
    if (el.$type === 'bpmndi:BPMNShape' && el.bpmnElement && el.bounds) {
      shapes.set(el.bpmnElement.id, el.bounds);
    }
  }
  return shapes;
}

function requireShape(shapes: Map<string, DiBounds>, id: string): DiBounds {
  const shape = shapes.get(id);
  if (shape === undefined) throw new Error(`No BPMNShape for "${id}".`);
  return shape;
}

/** One loose type over every parsed moddle node. */
interface Moddle {
  $type: string;
  /** Attributes the descriptor does not declare for this type land here. */
  $attrs: Record<string, string>;
  id?: string;
  name?: string;
  body?: string;
  text?: string;
  documentation?: Moddle[];
  rootElements: Moddle[];
  flowElements?: Moddle[];
  eventDefinitions?: Moddle[];
  extensionElements?: { values: Moddle[] };
  incoming?: Moddle[];
  outgoing?: Moddle[];
  sourceRef?: Moddle;
  targetRef?: Moddle;
  default?: Moddle;
  attachedToRef?: Moddle;
  errorRef?: Moddle;
  escalationRef?: Moddle;
  messageRef?: Moddle;
  signalRef?: Moddle;
  condition?: Moddle;
  timeDuration?: Moddle;
  timeDate?: Moddle;
  timeCycle?: Moddle;
  errorCode?: string;
  errorMessage?: string;
  errorCodeVariable?: string;
  errorMessageVariable?: string;
  escalationCode?: string;
  escalationCodeVariable?: string;
  isInterrupting?: boolean;
  triggeredByEvent?: boolean;
  versionTag?: string;
  historyTimeToLive?: string;
  candidateStarterUsers?: string;
  candidateStarterGroups?: string;
  formRef?: string;
  formRefBinding?: string;
  formRefVersion?: string;
  calledElement?: string;
  calledElementBinding?: string;
  calledElementVersion?: string;
  variableMappingClass?: string;
  variableMappingDelegateExpression?: string;
  source?: string;
  sourceExpression?: string;
  variables?: string;
  target?: string;
  businessKey?: string;
  local?: boolean;
}

/** The opening tag of a node, or of its first `tag` child. */
function openingTag(xml: string, id: string, tag?: string): string {
  const block =
    tag === undefined ? extractNodeBlock(xml, id) : childBlock(xml, id, tag)!;
  return block.split('\n')[0]!;
}

/**
 * The serialized text of one flow node. Reading the text is how a test sees an
 * absent attribute: on read, moddle fills the schema default either way.
 */
function extractNodeBlock(xml: string, nodeId: string): string {
  const idPos = xml.indexOf(`id="${nodeId}"`);
  if (idPos === -1) throw new Error(`Node id="${nodeId}" not in the output.`);
  return elementAt(xml, xml.lastIndexOf('<', idPos));
}

function childBlock(
  xml: string,
  nodeId: string,
  tag: string,
): string | undefined {
  const node = extractNodeBlock(xml, nodeId);
  const start = node.indexOf(`<${tag}`);
  return start === -1 ? undefined : elementAt(node, start);
}

function elementAt(xml: string, tagStart: number): string {
  const tagName = /^<([^\s/>]+)/.exec(xml.slice(tagStart))?.[1];
  const openTagEnd = xml.indexOf('>', tagStart);
  if (tagName === undefined || openTagEnd === -1) {
    throw new Error(`No element opens at position ${tagStart}.`);
  }
  // Decided from the opening tag alone: scanning ahead for the first `/>`
  // would stop at a self-closing child, such as a repeated activity's loop.
  if (xml[openTagEnd - 1] === '/') return xml.slice(tagStart, openTagEnd + 1);
  const closeTag = `</${tagName}>`;
  const closeTagPos = xml.indexOf(closeTag, openTagEnd);
  if (closeTagPos === -1) throw new Error(`Unterminated <${tagName}>.`);
  return xml.slice(tagStart, closeTagPos + closeTag.length);
}
