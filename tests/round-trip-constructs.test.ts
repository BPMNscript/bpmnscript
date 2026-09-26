import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr, astToIr, isGateway } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { realNodeReachability } from './helpers/real-node-reachability.js';
import {
  parseToAst,
  printDsl,
  roundTrip,
  roundTripTwice,
  validate,
} from './helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf-8');

describe('structured control flow survives the round trip as written', () => {
  it('invoice-approval prints its if/else back, and a second print reproduces it byte for byte', async () => {
    const run = await roundTrip(
      read('../examples/spring-boot/processes/invoice-approval.bpmnscript'),
    );
    expect(run.dsl).toBe(
      [
        'process invoice-approval {',
        '  start ReviewStart {',
        '    form {',
        '      amount: number "Invoice amount"',
        '    }',
        '  }',
        '  user ReviewInvoice(assignee: "demo")',
        '  if (amount > 1000) {',
        '    user SeniorApproval(assignee: "manager")',
        '  } else {',
        '    service AutoApprove(class: "com.example.invoice.AutoApproveDelegate")',
        '  }',
        '  end Done',
        '}',
        '',
      ].join('\n'),
    );
    expect(printDsl(run.ir3)).toBe(run.dsl);
  });

  it('`while` lowers to a conditioned back-edge and `parallel` to one fork and join, and both print back', async () => {
    const run = await roundTrip(
      read('golden/structured-control-flow.bpmnscript'),
    );
    expect(run.xml).not.toContain('standardLoopCharacteristics');
    expect(run.xml.match(/<bpmn:parallelGateway\b/g)).toHaveLength(2);
    expect(run.dsl).toBe(
      [
        'process structured-control-flow {',
        '  var priority: any',
        '  var retries: any',
        '  start Begin',
        '  user Triage(label: "Triage request", assignee: "demo")',
        '  if (priority > 5) {',
        '    user EscalateReview(label: "Escalate review", assignee: "manager")',
        '  } else {',
        '    service AutoTriage(label: "Auto-triage", class: "com.example.flow.AutoTriageDelegate")',
        '  }',
        '  while (retries < 3) {',
        '    service RetryFetch(label: "Retry fetch", class: "com.example.flow.RetryFetchDelegate")',
        '  }',
        '  parallel {',
        '    {',
        '      user NotifyOwner(label: "Notify owner", assignee: "demo")',
        '    }',
        '    {',
        '      service AuditLog(label: "Write audit log", class: "com.example.flow.AuditLogDelegate")',
        '    }',
        '  }',
        '  end Finish',
        '}',
        '',
      ].join('\n'),
    );
  });
});

// Every edge in this fixture has a `goto` form; edges with none belong to the
// goto-fallback suite.
it('goto degradation keeps every authored node, edge and condition over two round trips', async () => {
  const { ir: irImport } = await xmlToIr(read('golden/unstructured-goto.bpmn'));
  const degradedDsl = printDsl(irImport);
  const irReDesugared = astToIr(await parseToAst(degradedDsl));
  const irSecondRound = astToIr(await parseToAst(printDsl(irReDesugared)));

  // A chain only one branch enters prints inline in that branch.
  expect(degradedDsl).toBe(
    [
      'process unstructured-goto {',
      '  var retry: any',
      '  var route: any',
      '  start Start',
      '  user Intake(assignee: "demo")',
      '  if (route == "A") {',
      '    user Alpha(assignee: "demo")',
      '    if (retry == true) {',
      '    } else {',
      '      end Done',
      '    }',
      '  }',
      '  user Beta(assignee: "manager")',
      '  end DoneBeta',
      '}',
      '',
    ].join('\n'),
  );

  // Raw flows cannot match: re-desugaring synthesizes fresh gateway ids and
  // grows joins, so compare connectivity with gateways contracted away.
  expect(realNodeReachability(irReDesugared)).toEqual(
    realNodeReachability(irImport),
  );
  expect(realNodeReachability(irSecondRound)).toEqual(
    realNodeReachability(irReDesugared),
  );
  expect(
    realNodeReachability({
      ...irImport,
      sequenceFlows: irImport.sequenceFlows.slice(1),
    }),
    'a dropped edge must change the reachability',
  ).not.toEqual(realNodeReachability(irImport));

  // Reachability ignores conditions. The fixture's single-quoted literal comes
  // back double-quoted.
  expect(
    irReDesugared.sequenceFlows
      .map((f) => f.conditionExpression)
      .filter((c): c is string => c !== undefined)
      .sort(),
  ).toEqual(['${retry == true}', '${route == "A"}'].sort());

  const realIds = (ir: BpmnProcess) =>
    ir.flowElements
      .filter((fe) => !isGateway(fe))
      .map((fe) => fe.id)
      .sort();
  expect(realIds(irImport)).toEqual([
    'Alpha',
    'Beta',
    'Done',
    'DoneBeta',
    'Intake',
    'Start',
  ]);
  expect(realIds(irReDesugared)).toEqual(realIds(irImport));
});

// Reads attribute values as a conforming XML parser does: a raw tab, carriage
// return or line feed becomes a space (XML 1.0, 3.3.3), a character reference
// keeps its character.
function decodeXmlEntities(xml: string): string {
  return xml
    .replace(/<[^>]*>/g, (tag) => tag.replace(/[\t\r\n]/g, ' '))
    .replace(/&#34;/g, '"')
    .replace(/&#10;/g, '\n')
    .replace(/&#9;/g, '\t')
    .replace(/&#13;/g, '\r');
}

describe('two-pass round trip: printed expression text stays engine-runnable and stable', () => {
  it.each([
    [
      // A bean method call is outside the native JUEL subset and takes the raw fallback.
      'a bean-call condition stays the same quoted raw form',
      [
        'process bean-cond(label: "Bean Cond") {',
        '  start S',
        '  if ("${myBean.check()}") {',
        '    user Approve(label: "Approve", assignee: "demo")',
        '  } else {',
        '    user Reject(label: "Reject", assignee: "demo")',
        '  }',
        '  end E',
        '}',
        '',
      ].join('\n'),
      ['>${myBean.check()}</bpmn:conditionExpression>'],
      ['  if ("${myBean.check()}") {\n'],
    ],
    [
      'a backslash inside a JUEL string literal prints as the doubled escape and compiles back to the same three characters',
      [
        'process order-fulfilment {',
        '  if ("${region == \\"a\\\\\\\\b\\"}") {',
        '    user A',
        '  }',
        '}',
        '',
      ].join('\n'),
      ['${region == "a\\\\b"}'],
      ['if (region == "a\\\\b") {'],
    ],
    [
      'an out-of-subset raw condition with a quoted method call keeps its inner quotes, not doubled escapes',
      [
        'process p {',
        '  if (\'${execution.getVariable("x")}\') {',
        '    user A',
        '  }',
        '}',
        '',
      ].join('\n'),
      ['${execution.getVariable("x")}'],
      [],
    ],
    [
      'a raw operand under a unary operator splices its body instead of nesting a second ${ }',
      ['process p {', "  if (!'${x}') {", '    user A', '  }', '}', ''].join(
        '\n',
      ),
      ['${!(x)}'],
      [],
    ],
    [
      'quoted-raw method-call bindings on delegate, expression and assignee keep their inner quotes',
      [
        'process p {',
        '  service S(delegate: \'${fn("a")}\')',
        '  service T(expression: "${bean.m(\\"a\\")}")',
        '  user U(assignee: "${who(\\"a\\")}")',
        '}',
        '',
      ].join('\n'),
      [
        'operaton:delegateExpression="${fn("a")}"',
        'operaton:expression="${bean.m("a")}"',
        'operaton:assignee="${who("a")}"',
      ],
      [],
    ],
    [
      'a bare variable in an io value, a list item or a map entry renders as ${var}, not as its name in text',
      [
        'process p {',
        '  var notify_sync: any',
        '  service A(class: "x") {',
        '    output a = notify_sync',
        '    input b = notify_sync.lines',
        '    input c = [notify_sync, 1, -644, "s"]',
        '    input d = { k: notify_sync, k2: null, k3: true }',
        '  }',
        '  call C(process: "x") {',
        '    in y = notify_sync',
        '  }',
        '}',
        '',
      ].join('\n'),
      [
        '<operaton:outputParameter name="a">${notify_sync}</operaton:outputParameter>',
        '<operaton:inputParameter name="b">${notify_sync.lines}</operaton:inputParameter>',
        '<operaton:value>${notify_sync}</operaton:value>',
        '<operaton:value>${1}</operaton:value>',
        '<operaton:value>${-644}</operaton:value>',
        '<operaton:value>s</operaton:value>',
        '<operaton:entry key="k">${notify_sync}</operaton:entry>',
        '<operaton:entry key="k2">${null}</operaton:entry>',
        '<operaton:entry key="k3">${true}</operaton:entry>',
        '<operaton:in source="notify_sync" target="y" />',
      ],
      [],
    ],
    [
      '#{ } bindings across a listener, tasks and a call activity print verbatim with the # opener kept',
      [
        'process p {',
        '  user Review(assignee: "#{initiator}", priority: "#{prio}") {',
        '    on end(delegate: "#{auditListener}")',
        '    on create(expression: "#{notifier.created(task)}")',
        '  }',
        '  service Notify(delegate: "#{emailAdapter}")',
        '  service Compute(expression: "#{calc.run(order)}", resultVariable: "result")',
        '  call Sub(process: "#{subKey}", businessKey: "#{execution.processBusinessKey}") {',
        '    in orderId = "#{order.id}"',
        '    out subResult = "#{result}"',
        '  }',
        '}',
        '',
      ].join('\n'),
      [
        'operaton:assignee="#{initiator}"',
        'operaton:priority="#{prio}"',
        '<operaton:executionListener event="end" delegateExpression="#{auditListener}" />',
        '<operaton:taskListener event="create" expression="#{notifier.created(task)}" />',
        'operaton:delegateExpression="#{emailAdapter}"',
        'operaton:expression="#{calc.run(order)}" operaton:resultVariable="result"',
        'calledElement="#{subKey}"',
        '<operaton:in businessKey="#{execution.processBusinessKey}" />',
        '<operaton:in sourceExpression="#{order.id}" target="orderId" />',
        '<operaton:out sourceExpression="#{result}" target="subResult" />',
      ],
      [],
    ],
    [
      'a real line feed, tab or carriage return in an io value, a map key, a field value or a label reaches the engine and prints as its two-character escape',
      [
        'process p {',
        '  service A(class: "x", label: "a\\tb\\rc") {',
        '    input m = { "a\\nb": 1 }',
        '    input s = "l1\\nl2"',
        '    field f = "f1\\nf2\\tf3\\rf4"',
        '  }',
        '}',
        '',
      ].join('\n'),
      [
        'name="a\tb\rc"',
        'stringValue="f1\nf2\tf3\rf4"',
        'key="a\nb"',
        '<operaton:inputParameter name="s">l1\nl2</operaton:inputParameter>',
      ],
      ['"a\\tb\\rc"', '"f1\\nf2\\tf3\\rf4"', '"l1\\nl2"'],
    ],
    [
      'a map key that is itself a template opener prints with a backslash so it re-parses as a literal key, not a raw template',
      [
        'process p {',
        '  service A(class: "x") {',
        '    input m = { "\\${dyn}": 1, "\\#{other}": 2, plain: 3 }',
        '  }',
        '}',
        '',
      ].join('\n'),
      [
        '<operaton:entry key="${dyn}">${1}</operaton:entry>',
        '<operaton:entry key="#{other}">${2}</operaton:entry>',
        '<operaton:entry key="plain">${3}</operaton:entry>',
      ],
      ['"\\${dyn}"', '"\\#{other}"'],
    ],
    [
      'a hyphenated collection variable prints as a bare operaton:collection reference, not a quoted string',
      [
        'process p {',
        '  var check-close: any',
        '  user A for each in check-close',
        '}',
        '',
      ].join('\n'),
      ['operaton:collection="check-close"'],
      ['for each in check-close'],
    ],
    [
      'a literal businessKey and a literal in-mapping source print as bare EL text, not a wrapped literal',
      [
        'process p {',
        '  call C(process: "x", businessKey: "abc") {',
        '    in y = "u"',
        '  }',
        '}',
        '',
      ].join('\n'),
      [
        '<operaton:in businessKey="abc" />',
        '<operaton:in sourceExpression="u" target="y" />',
      ],
      [],
    ],
    [
      'a variable a condition reads comes back declared, so the printed script validates clean',
      [
        'process p {',
        '  var shipPlan: any',
        '  await condition SendLoad(419 >= shipPlan)',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:condition xsi:type="bpmn:tFormalExpression">${419 &gt;= shipPlan}</bpmn:condition>',
      ],
      [
        '  var shipPlan: any\n',
        '  await condition SendLoad(419 >= shipPlan)\n',
      ],
    ],
    [
      'two starts sharing the implicit end print back to back, and the end stays unwritten',
      [
        'process claim-review {',
        '  var urgent: boolean',
        '  start FromDesk',
        '  start WhenUrgent condition(urgent)',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:sequenceFlow id="Flow_FromDesk_EndEvent_claim-review" sourceRef="FromDesk" targetRef="EndEvent_claim-review" />',
        '<bpmn:sequenceFlow id="Flow_WhenUrgent_EndEvent_claim-review" sourceRef="WhenUrgent" targetRef="EndEvent_claim-review" />',
      ],
      ['  start FromDesk\n  start WhenUrgent condition(urgent)\n}\n'],
    ],
    [
      'a process-level timer start keeps its date through the round trip',
      [
        'process audit {',
        '  start AuditWindowOpens timer(at: "2099-01-01T00:00:00")',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:timeDate xsi:type="bpmn:tFormalExpression">2099-01-01T00:00:00</bpmn:timeDate>',
      ],
      ['  start AuditWindowOpens timer(at: "2099-01-01T00:00:00")\n'],
    ],
    [
      // The looping step reaches no exit, so the container has no post-dominators.
      'a race with empty branches into a step that loops on itself keeps the step after the block',
      [
        'process claim-review {',
        '  await {',
        '    message("OrderReceived") {',
        '      user Log',
        '    }',
        '    condition("${fn(\\"a\\")}" * 0.91 == (247)) {',
        '      user Nudge',
        '    }',
        '  }',
        '  decide Ship6(decision: "approve-claim")',
        '  goto Ship6',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:sequenceFlow id="Flow_Gateway_claim-review_0_join_Ship6" sourceRef="Gateway_claim-review_0_join" targetRef="Ship6" />',
        '<bpmn:sequenceFlow id="Flow_Ship6_Ship6" sourceRef="Ship6" targetRef="Ship6" />',
      ],
      [
        '    }\n  }\n  decide Ship6(decision: "approve-claim")\n  goto Ship6\n}\n',
      ],
    ],
    [
      // The ending branch puts the split's post-dominator at the exit, so the join is read off the routes.
      'an if chain with an ending branch beside an else chain keeps the else, and the implicit end stays unwritten',
      [
        'process onboarding {',
        '  var a: boolean',
        '  var b: boolean',
        '  if (a) {',
        '    end Done7',
        '  } else if (b) {',
        '    user Log',
        '  } else {',
        '    service Approve10(class: "org.acme.Audit")',
        '  }',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:sequenceFlow id="Flow_Approve10_Gateway_onboarding_0_join" sourceRef="Approve10" targetRef="Gateway_onboarding_0_join" />',
      ],
      [
        '  } else if (b) {\n    user Log\n  } else {\n    service Approve10(class: "org.acme.Audit")\n  }\n}\n',
      ],
    ],
    [
      'a loop inside a branch prints inside it, not as a jump with the loop hoisted behind the end',
      [
        'process claim-review {',
        '  if (true) {',
        '    do {',
        '      await message Wait3("PaymentDone")',
        '    } while (true)',
        '  } else if (true) {',
        '    throw message("Quote Received")',
        '  } else {',
        '    service Escalate(class: "com.example.Delegate")',
        '  }',
        '  end Done9',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:sequenceFlow id="Flow_Gateway_claim-review_0_t_0_loop_Wait3" name="true" sourceRef="Gateway_claim-review_0_t_0_loop" targetRef="Wait3">',
        '<bpmn:sequenceFlow id="Flow_Gateway_claim-review_0_split_Wait3" name="true" sourceRef="Gateway_claim-review_0_split" targetRef="Wait3">',
      ],
      [
        '  if (true) {\n    do {\n      await message Wait3("PaymentDone")\n    } while (true)\n  } else if (true) {\n',
      ],
    ],
    [
      // Hoisted behind the implicit end as jump targets, the chains would push it off the tail.
      'two branches whose chains end print them inside the branches, and the implicit end stays unwritten',
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
        '',
      ].join('\n'),
      [
        '<bpmn:sequenceFlow id="Flow_A_Throw_p_0_t_1" sourceRef="A" targetRef="Throw_p_0_t_1" />',
        '<bpmn:sequenceFlow id="Flow_Catch_p_0_e0_1_b0_Done" sourceRef="Catch_p_0_e0_1_b0" targetRef="Done" />',
        '<bpmn:sequenceFlow id="Flow_Gateway_p_0_join_EndEvent_p" sourceRef="Gateway_p_0_join" targetRef="EndEvent_p" />',
      ],
      [
        '  if (a) {\n    user A\n    throw message("Quote Received")\n  } else if (b) {\n    user B\n    await {\n',
        '  } else {\n    user D\n  }\n}\n',
      ],
    ],
    [
      // The else route can end at `Done` without passing `X`, so `X` is no merge of the block.
      'two jumps from sibling branches into one step keep the step after the chain, not as the join',
      [
        'process p {',
        '  var a: any',
        '  var b: any',
        '  if (a) {',
        '    goto X',
        '  }',
        '  user B',
        '  if (b) {',
        '    goto X',
        '  }',
        '  user C',
        '  end Done',
        '  user X',
        '  throw message("M")',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:sequenceFlow id="Flow_Gateway_p_0_split_X" name="a" sourceRef="Gateway_p_0_split" targetRef="X">',
        '<bpmn:sequenceFlow id="Flow_Gateway_p_2_split_X" name="b" sourceRef="Gateway_p_2_split" targetRef="X">',
      ],
      [
        '  if (a) {\n    goto X\n  }\n  user B\n  if (b) {\n    goto X\n  }\n  user C\n  end Done\n  user X\n  throw message("M")\n}\n',
      ],
    ],
    [
      // A handler walked before the link-catch chain would pull the host into its own body.
      'a handler jumping back to its host keeps the host where the link catch reaches it',
      [
        'process invoice_batch {',
        '  emit link("Skip")',
        '  await link("Skip")',
        '  receive Hold14',
        '  on Hold14: message("Cancelled") {',
        '    goto Hold14',
        '  }',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:sequenceFlow id="Flow_Boundary_Hold14_message_Hold14" sourceRef="Boundary_Hold14_message" targetRef="Hold14" />',
      ],
      [
        '  await link("Skip")\n  receive Hold14\n  on Hold14: message("Cancelled") {\n    goto Hold14\n  }\n}\n',
      ],
    ],
    [
      'a handler jumping to a step the link catch reaches keeps the step, and the process end, outside the handler',
      [
        'process invoice_batch {',
        '  var order: any',
        '  var items: any',
        '  step Check6',
        '  emit link("Retry")',
        '  await link("Retry")',
        '  call Call(process: "payment-run")',
        '  on Check6: condition(order.name != items[0]) {',
        '    goto Call',
        '  }',
        '}',
        '',
      ].join('\n'),
      [
        '<bpmn:sequenceFlow id="Flow_Boundary_Check6_condition_Call" sourceRef="Boundary_Check6_condition" targetRef="Call" />',
        '<bpmn:sequenceFlow id="Flow_Call_EndEvent_invoice_batch" sourceRef="Call" targetRef="EndEvent_invoice_batch" />',
      ],
      [
        '  await link("Retry")\n  call Call(process: "payment-run")\n  on Check6: condition(order.name != items[0]) {\n    goto Call\n  }\n}\n',
      ],
    ],
  ] as const)('%s', async (_title, source, xmlContains, dslContains) => {
    const { xml1, dsl1, xml2, dsl2 } = await roundTripTwice(source);

    const decodedXml = decodeXmlEntities(xml1);
    for (const fragment of xmlContains) {
      expect(decodedXml).toContain(fragment);
    }
    for (const fragment of dslContains) {
      expect(dsl1).toContain(fragment);
    }

    const { diagnostics } = await validate(dsl1);
    expect(diagnostics.map((d) => d.message)).toEqual([]);

    expect(xml2).toBe(xml1);
    expect(dsl2).toBe(dsl1);
  });

  // Entry chains are walked before handler blocks and own what they reach, so
  // the model changes (the chain ends at the process end) but reachability holds.
  it("an entry chain jumping into a handler body owns the body's chain, and the handler degrades to a goto", async () => {
    const source = [
      'process p {',
      '  var order: any',
      '  step Host',
      '  emit link("L")',
      '  await link("L")',
      '  step B',
      '  goto A',
      '  on Host: condition(order.paid) {',
      '    step A',
      '  }',
      '}',
      '',
    ].join('\n');
    const { dsl1, dsl2, xml1, xml2 } = await roundTripTwice(source);

    expect(dsl1).toBe(
      [
        'process p {',
        '  var order: any',
        '  step Host',
        '  emit link("L")',
        '  await link("L")',
        '  step B',
        '  step A',
        '  on Host: condition(order.paid) {',
        '    goto A',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const { diagnostics } = await validate(dsl1);
    expect(diagnostics.map((d) => d.message)).toEqual([]);
    expect(dsl2).toBe(dsl1);

    const [ir1, ir2] = await Promise.all(
      [xml1, xml2].map(async (xml) => (await xmlToIr(xml)).ir),
    );
    const owned = (id: string): string =>
      id === 'EndEvent_Boundary_Host_condition' ? 'EndEvent_p' : id;
    expect(ir2.flowElements.map((el) => el.id).sort()).toEqual(
      ir1.flowElements.map((el) => owned(el.id)).sort(),
    );
    expect(realNodeReachability(ir2)).toEqual(
      realNodeReachability(ir1).map((pair) =>
        pair.split('->').map(owned).join('->'),
      ),
    );
  });
});
