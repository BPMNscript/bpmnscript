import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr, astToIr, isGateway } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';
import { realNodeReachability } from './helpers/real-node-reachability.js';
import {
  parse,
  parseToAst,
  printDsl,
  roundTripOf,
  roundTripTwice,
  validate,
} from './helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INVOICE_DSL_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/invoice-approval.bpmnscript',
);

const STRUCTURED_DSL_PATH = resolve(
  __dirname,
  'golden/structured-control-flow.bpmnscript',
);

const UNSTRUCTURED_BPMN_PATH = resolve(
  __dirname,
  'golden/unstructured-goto.bpmn',
);

describe('structured idempotence (invoice-approval, if/else)', () => {
  const run = roundTripOf(readFileSync(INVOICE_DSL_PATH, 'utf-8'));
  let dsl2: string;

  beforeAll(() => {
    dsl2 = printDsl(run.ir3);
  });

  it('final IR equals initial IR up to documented id normalization', () => {
    expect(normalizeIr(run.ir3)).toEqual(normalizeIr(run.ir1));
  });

  it('re-emitted DSL is byte-identical to the first emitted DSL', () => {
    // Deterministic structural ids make the emission byte-stable, so a second
    // irToDsl over the re-desugared IR reproduces the first exactly.
    expect(dsl2).toBe(run.dsl);
  });

  it('the emitted DSL is structured syntax (if/else, no gateway/edge form)', () => {
    expect(run.dsl).toContain('process invoice-approval');
    expect(run.dsl).toContain('if (amount > 1000)');
    expect(run.dsl).toContain('else');
    expect(run.dsl).not.toContain('gateway');
    expect(run.dsl).not.toContain('->');
  });

  it('the if-condition survives as a conditional flow in the final IR', () => {
    const conditional = run.ir3.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(conditional).toBeDefined();
    expect(conditional!.conditionExpression).toBe('${amount > 1000}');
  });
});

describe('loop round-trip (while => conditioned back-edge, never standardLoopCharacteristics)', () => {
  const run = roundTripOf(readFileSync(STRUCTURED_DSL_PATH, 'utf-8'));

  it('the BPMN XML contains no standardLoopCharacteristics', () => {
    // A `while` desugars to a conditioned back-edge, not a loop-marker task.
    expect(run.xml).not.toContain('standardLoopCharacteristics');
  });

  it('the re-emitted DSL reconstructs the loop as `while`, with no goto', () => {
    expect(run.dsl).toMatch(/\bwhile\s*\(/);
    expect(run.dsl).toContain('while (retries < 3)');
    expect(run.dsl).not.toContain('goto');
  });

  it('the loop body task survives the round-trip verbatim', () => {
    expect(run.dsl).toContain(
      'service RetryFetch(label: "Retry fetch", ' +
        'class: "com.example.flow.RetryFetchDelegate")',
    );
  });
});

describe('parallel round-trip (parallelGateway fork/join => parallel { { } { } })', () => {
  const run = roundTripOf(readFileSync(STRUCTURED_DSL_PATH, 'utf-8'));

  it('the BPMN XML contains a parallelGateway fork and join (two parallelGateways)', () => {
    expect(run.xml).toContain('bpmn:parallelGateway');
    const forkJoin = run.xml.match(/<bpmn:parallelGateway\b/g) ?? [];
    expect(forkJoin.length).toBe(2); // exactly one fork + one join
  });

  it('the re-emitted DSL reconstructs the nested `parallel { { } { } }` construct', () => {
    expect(run.dsl).toMatch(/\bparallel\s*\{/);
    expect(run.dsl).not.toContain('} and {');
    expect(run.dsl).not.toMatch(/\band\b/);
  });

  it('both parallel branch tasks survive the round-trip verbatim', () => {
    expect(run.dsl).toContain(
      'user NotifyOwner(label: "Notify owner", assignee: "demo")',
    );
    expect(run.dsl).toContain(
      'service AuditLog(label: "Write audit log", ' +
        'class: "com.example.flow.AuditLogDelegate")',
    );
  });
});

// Every edge in this fixture has a `goto` form, so the whole set of connections
// between authored nodes survives, over a second round trip too. Edges with no
// form at all belong to the goto-fallback suite.
describe('goto-degradation preserves the edges that have a goto form', () => {
  let irImport: BpmnProcess; // from xmlToIr(unstructured.bpmn)
  let degradedDsl: string; // printDsl(irImport), contains goto(s)
  let irReDesugared: BpmnProcess; // astToIr(parse(degradedDsl))
  let irSecondRound: BpmnProcess; // astToIr(parse(printDsl(irReDesugared)))

  beforeAll(async () => {
    const xml = readFileSync(UNSTRUCTURED_BPMN_PATH, 'utf-8');

    ({ ir: irImport } = await xmlToIr(xml));
    degradedDsl = printDsl(irImport);
    irReDesugared = astToIr(await parseToAst(degradedDsl));

    const dsl2 = printDsl(irReDesugared);
    irSecondRound = astToIr(await parseToAst(dsl2));
  });

  it('importing the unstructured fixture and re-emitting never throws', () => {
    // The beforeAll ran the whole chain, so reaching here is most of the
    // assertion. Pinning the import shape keeps it from being vacuous.
    expect(irImport.id).toBe('unstructured-goto');
    expect(irImport.sequenceFlows.length).toBeGreaterThan(0);
  });

  it('the degraded DSL falls back to at least one `goto`', () => {
    expect(degradedDsl).toContain('goto');
    const gotos = degradedDsl.match(/\bgoto\b/g) ?? [];
    expect(gotos.length).toBeGreaterThanOrEqual(1);
  });

  it('the re-desugared DSL re-parses with zero parser errors', async () => {
    const document = await parse(degradedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });

  it('the real-node reachability is identical after the round-trip', () => {
    // Raw flow endpoints cannot match: the import has hand-named gateways
    // (RouteA/RouteB) while re-desugaring synthesizes fresh ids and grows XOR
    // joins for the `if`s whose branches are pure `goto`s. Compare authored-node
    // connectivity with gateway routing contracted away instead.
    expect(realNodeReachability(irReDesugared)).toEqual(
      realNodeReachability(irImport),
    );
  });

  it('a SECOND round-trip preserves the same real-node reachability (idempotent totality)', () => {
    expect(realNodeReachability(irSecondRound)).toEqual(
      realNodeReachability(irReDesugared),
    );
  });

  it('the fixture conditions survive the goto-degradation round-trip', () => {
    // Reachability is condition-agnostic: a `conditionExpression` stripped off a
    // surviving edge passes every check above, so pin the conditions too. The
    // round trip canonicalizes the fixture's single-quoted literal to double
    // quotes, hence the shifted spelling in the expected set.
    const reConditions = irReDesugared.sequenceFlows
      .map((f) => f.conditionExpression)
      .filter((c): c is string => c !== undefined)
      .sort();
    expect(reConditions).toEqual(
      ['${retry == true}', '${route == "A"}'].sort(),
    );
  });

  it('every authored node from the import is still present after re-desugaring', () => {
    const realIds = (ir: BpmnProcess) =>
      ir.flowElements
        .filter((fe) => !isGateway(fe))
        .map((fe) => fe.id)
        .sort();
    expect(realIds(irReDesugared)).toEqual(realIds(irImport));
  });

  it('the meaningfulness guard: a dropped edge would make reachability differ', () => {
    // Removing one import flow changes the relation, so the equality above is
    // load-bearing rather than always-true.
    const corrupt: BpmnProcess = {
      ...irImport,
      sequenceFlows: irImport.sequenceFlows.slice(1),
    };
    expect(realNodeReachability(corrupt)).not.toEqual(
      realNodeReachability(irImport),
    );
  });
});

// A bean method call is outside the JUEL native subset: the trailing `()`
// leaves tokens unconsumed, so it takes the raw fallback and has to survive the
// round trip as the same quoted raw form.
describe('bean-call condition stays quoted-raw end-to-end', () => {
  const BEAN_DSL = [
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
  ].join('\n');

  const run = roundTripOf(BEAN_DSL);

  const condition = (ir: BpmnProcess) =>
    ir.sequenceFlows.find((sf) => sf.conditionExpression !== undefined)
      ?.conditionExpression;

  it('the bean call is preserved verbatim in the IR condition expression', () => {
    expect(condition(run.ir1)).toBe('${myBean.check()}');
    expect(condition(run.ir2)).toBe('${myBean.check()}');
  });

  it('the re-emitted DSL keeps the condition as the quoted raw `"${...}"` form', () => {
    expect(run.dsl).toContain('if ("${myBean.check()}")');
    // The bare (unquoted) form would signal a spurious parse-into-subset.
    expect(run.dsl).not.toContain('if (myBean.check())');
  });

  it('the re-emitted DSL re-parses, and re-desugars to the same raw condition', () => {
    expect(condition(run.ir3)).toBe('${myBean.check()}');
  });
});

// Every row below prints, rebuilds and prints again; the suites elsewhere in
// this repo stop after one hop each direction and never see a value that is
// stable on the first print but drifts on the second. `xml2`/`dsl2` come from
// feeding `dsl1` back through the same two hops, so a row pins idempotence,
// not just a single compile.
//
// Two attribute values below carry a literal `"`, which this pipeline's XML
// writer cannot place directly in an attribute and instead numeric-escapes
// (`&#34;`, `&#10;`); decoding those before the substring check lets a
// fragment read the same whether it landed in an attribute or an element body.
function decodeXmlEntities(xml: string): string {
  return xml.replace(/&#34;/g, '"').replace(/&#10;/g, '\n');
}

const RAW_CONDITION_QUOTE_SRC = [
  'process p {',
  '  if (\'${execution.getVariable("x")}\') {',
  '    user A',
  '  }',
  '}',
  '',
].join('\n');

const RAW_UNDER_UNARY_SRC = [
  'process p {',
  "  if (!'${x}') {",
  '    user A',
  '  }',
  '}',
  '',
].join('\n');

const QUOTED_RAW_BINDINGS_SRC = [
  'process p {',
  '  service S(delegate: \'${fn("a")}\')',
  '  service T(expression: "${bean.m(\\"a\\")}")',
  '  user U(assignee: "${who(\\"a\\")}")',
  '}',
  '',
].join('\n');

const BARE_VARIABLE_IO_SRC = [
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
].join('\n');

const HASH_TEMPLATE_POSITIONS_SRC = [
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
].join('\n');

const CONTROL_CHAR_BODIES_SRC = [
  'process p {',
  '  service A(class: "x") {',
  '    input m = { "a\\nb": 1 }',
  '    input s = "l1\\nl2"',
  '    field f = "f1\\nf2"',
  '  }',
  '}',
  '',
].join('\n');

const HYPHENATED_COLLECTION_SRC = [
  'process p {',
  '  var check-close: any',
  '  user A for each in check-close',
  '}',
  '',
].join('\n');

const LITERAL_BUSINESS_KEY_SRC = [
  'process p {',
  '  call C(process: "x", businessKey: "abc") {',
  '    in y = "u"',
  '  }',
  '}',
  '',
].join('\n');

const CONDITION_VARIABLE_SRC = [
  'process p {',
  '  var shipPlan: any',
  '  await condition SendLoad(419 >= shipPlan)',
  '}',
  '',
].join('\n');

const SHARED_END_STARTS_SRC = [
  'process claim-review {',
  '  var urgent: boolean',
  '  start FromDesk',
  '  start WhenUrgent condition(urgent)',
  '}',
  '',
].join('\n');

const RACE_INTO_SELF_LOOPING_STEP_SRC = [
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
].join('\n');

const ENDING_BRANCH_BESIDE_ELSE_CHAIN_SRC = [
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
].join('\n');

const LOOP_INSIDE_BRANCH_SRC = [
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
].join('\n');

const ENDING_CHAINS_IN_BRANCHES_SRC = [
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
].join('\n');

const EXPRESSION_MAP_KEY_SRC = [
  'process p {',
  '  service A(class: "x") {',
  '    input m = { "\\${dyn}": 1, "\\#{other}": 2, plain: 3 }',
  '  }',
  '}',
  '',
].join('\n');

const BACKSLASH_IN_JUEL_STRING_SRC = [
  'process order-fulfilment {',
  '  if ("${region == \\"a\\\\\\\\b\\"}") {',
  '    user A',
  '  }',
  '}',
  '',
].join('\n');

const HANDLER_JUMPING_TO_ITS_HOST_SRC = [
  'process invoice_batch {',
  '  emit link("Skip")',
  '  await link("Skip")',
  '  receive Hold14',
  '  on Hold14: message("Cancelled") {',
  '    goto Hold14',
  '  }',
  '}',
  '',
].join('\n');

const HANDLER_JUMPING_TO_A_LINKED_STEP_SRC = [
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
].join('\n');

const TWO_JUMPS_INTO_ONE_STEP_SRC = [
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
].join('\n');

describe('two-pass round trip: printed expression text stays engine-runnable and stable', () => {
  it.each([
    [
      'a backslash inside a JUEL string literal prints as the doubled escape and compiles back to the same three characters',
      BACKSLASH_IN_JUEL_STRING_SRC,
      ['${region == "a\\\\b"}'],
      ['if (region == "a\\\\b") {'],
    ],
    [
      'an out-of-subset raw condition with a quoted method call keeps its inner quotes, not doubled escapes',
      RAW_CONDITION_QUOTE_SRC,
      ['${execution.getVariable("x")}'],
      [],
    ],
    [
      'a raw operand under a unary operator splices its body instead of nesting a second ${ }',
      RAW_UNDER_UNARY_SRC,
      ['${!(x)}'],
      [],
    ],
    [
      'quoted-raw method-call bindings on delegate, expression and assignee keep their inner quotes',
      QUOTED_RAW_BINDINGS_SRC,
      [
        'operaton:delegateExpression="${fn("a")}"',
        'operaton:expression="${bean.m("a")}"',
        'operaton:assignee="${who("a")}"',
      ],
      [],
    ],
    [
      'a bare variable in an io value, a list item or a map entry renders as ${var}, not as its name in text',
      BARE_VARIABLE_IO_SRC,
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
      HASH_TEMPLATE_POSITIONS_SRC,
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
      // No tab sub-case: moddle-xml's attribute escaper does not escape a
      // tab, so a tab in an attribute value reaches a strict XML parser as a
      // space (XML attribute-value normalization). Pinning it here would only
      // pin this tool's own reader, not byte fidelity through a strict parser.
      'a real line feed in an io value, a map key or a field value prints as its two-character escape',
      CONTROL_CHAR_BODIES_SRC,
      [
        'stringValue="f1\nf2"',
        'key="a\nb"',
        '<operaton:inputParameter name="s">l1\nl2</operaton:inputParameter>',
      ],
      ['"f1\\nf2"', '"l1\\nl2"'],
    ],
    [
      'a map key that is itself a template opener prints with a backslash so it re-parses as a literal key, not a raw template',
      EXPRESSION_MAP_KEY_SRC,
      [
        '<operaton:entry key="${dyn}">${1}</operaton:entry>',
        '<operaton:entry key="#{other}">${2}</operaton:entry>',
        '<operaton:entry key="plain">${3}</operaton:entry>',
      ],
      ['"\\${dyn}"', '"\\#{other}"'],
    ],
    [
      'a hyphenated collection variable prints as a bare operaton:collection reference, not a quoted string',
      HYPHENATED_COLLECTION_SRC,
      ['operaton:collection="check-close"'],
      ['for each in check-close'],
    ],
    [
      'a literal businessKey and a literal in-mapping source print as bare EL text, not a wrapped literal',
      LITERAL_BUSINESS_KEY_SRC,
      [
        '<operaton:in businessKey="abc" />',
        '<operaton:in sourceExpression="u" target="y" />',
      ],
      [],
    ],
    [
      'a variable a condition reads comes back declared, so the printed script validates clean',
      CONDITION_VARIABLE_SRC,
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
      SHARED_END_STARTS_SRC,
      [
        '<bpmn:sequenceFlow id="Flow_FromDesk_EndEvent_claim-review" sourceRef="FromDesk" targetRef="EndEvent_claim-review" />',
        '<bpmn:sequenceFlow id="Flow_WhenUrgent_EndEvent_claim-review" sourceRef="WhenUrgent" targetRef="EndEvent_claim-review" />',
      ],
      ['  start FromDesk\n  start WhenUrgent condition(urgent)\n}\n'],
    ],
    [
      // The step after the race loops on itself, so no node reaches the exit
      // and the container has no post-dominators to find the merge with.
      'a race with empty branches into a step that loops on itself keeps the step after the block',
      RACE_INTO_SELF_LOOPING_STEP_SRC,
      [
        '<bpmn:sequenceFlow id="Flow_Gateway_claim-review_0_join_Ship6" sourceRef="Gateway_claim-review_0_join" targetRef="Ship6" />',
        '<bpmn:sequenceFlow id="Flow_Ship6_Ship6" sourceRef="Ship6" targetRef="Ship6" />',
      ],
      [
        '    }\n  }\n  decide Ship6(decision: "approve-claim")\n  goto Ship6\n}\n',
      ],
    ],
    [
      // The ending branch puts the split's post-dominator at the exit, so
      // the join is read off the routes: the middle branch and the else
      // chain come back together at it, and neither walks on to the
      // implicit end.
      'an if chain with an ending branch beside an else chain keeps the else, and the implicit end stays unwritten',
      ENDING_BRANCH_BESIDE_ELSE_CHAIN_SRC,
      [
        '<bpmn:sequenceFlow id="Flow_Approve10_Gateway_onboarding_0_join" sourceRef="Approve10" targetRef="Gateway_onboarding_0_join" />',
      ],
      [
        '  } else if (b) {\n    user Log\n  } else {\n    service Approve10(class: "org.acme.Audit")\n  }\n}\n',
      ],
    ],
    [
      // The branch's entry is the loop body, which the block's join
      // post-dominates, so the walk stays inside the branch and prints the
      // loop where it was written.
      'a loop inside a branch prints inside it, not as a jump with the loop hoisted behind the end',
      LOOP_INSIDE_BRANCH_SRC,
      [
        '<bpmn:sequenceFlow id="Flow_Gateway_claim-review_0_t_0_loop_Wait3" name="true" sourceRef="Gateway_claim-review_0_t_0_loop" targetRef="Wait3">',
        '<bpmn:sequenceFlow id="Flow_Gateway_claim-review_0_split_Wait3" name="true" sourceRef="Gateway_claim-review_0_split" targetRef="Wait3">',
      ],
      [
        '  if (true) {\n    do {\n      await message Wait3("PaymentDone")\n    } while (true)\n  } else if (true) {\n',
      ],
    ],
    [
      // Neither chain reaches the join, and the block's tail is the implicit
      // end; hoisted behind it as jump targets, the chains would push that
      // end off its tail and print it under its reserved id.
      'two branches whose chains end print them inside the branches, and the implicit end stays unwritten',
      ENDING_CHAINS_IN_BRANCHES_SRC,
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
      // Both routes of the first split reach `X`, and the else route can
      // also end at `Done` without passing it, so `X` is no merge of the
      // block: taken as one, the else chain prints nested inside the branch
      // and the next pass prints it hoisted.
      'two jumps from sibling branches into one step keep the step after the chain, not as the join',
      TWO_JUMPS_INTO_ONE_STEP_SRC,
      [
        '<bpmn:sequenceFlow id="Flow_Gateway_p_0_split_X" name="a" sourceRef="Gateway_p_0_split" targetRef="X">',
        '<bpmn:sequenceFlow id="Flow_Gateway_p_2_split_X" name="b" sourceRef="Gateway_p_2_split" targetRef="X">',
      ],
      [
        '  if (a) {\n    goto X\n  }\n  user B\n  if (b) {\n    goto X\n  }\n  user C\n  end Done\n  user X\n  throw message("M")\n}\n',
      ],
    ],
    [
      // The host is reached only through the link catch; a handler walked
      // before that chain would pull the host into its own body.
      'a handler jumping back to its host keeps the host where the link catch reaches it',
      HANDLER_JUMPING_TO_ITS_HOST_SRC,
      [
        '<bpmn:sequenceFlow id="Flow_Boundary_Hold14_message_Hold14" sourceRef="Boundary_Hold14_message" targetRef="Hold14" />',
      ],
      [
        '  await link("Skip")\n  receive Hold14\n  on Hold14: message("Cancelled") {\n    goto Hold14\n  }\n}\n',
      ],
    ],
    [
      'a handler jumping to a step the link catch reaches keeps the step, and the process end, outside the handler',
      HANDLER_JUMPING_TO_A_LINKED_STEP_SRC,
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

  // The pass that walks a node first owns it in the print, and the chains
  // the container's entries reach are walked before the handler blocks. The
  // owned chain then ends at the process end rather than the handler's, so
  // the model changes where the print is stable; what it keeps is which
  // steps reach which.
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
