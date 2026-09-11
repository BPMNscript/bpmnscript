// What the single-stage transform tests cannot catch is a field-name or
// binding-kind mismatch between stages, so one minimal program per construct
// goes through the whole pipeline here.

import { describe, it, expect } from 'vitest';

import type { BpmnProcess } from '@bpmn-script/transform';

import { theOnly } from './helpers/ir-query.js';
import { parse, roundTripOf, validate } from './helpers/pipeline.js';
import type { RoundTripRun } from './helpers/pipeline.js';

// Labelled so a value that stops travelling at one hop names the hop it stopped
// at rather than failing as a bare inequality.
function hops(run: RoundTripRun): readonly (readonly [string, BpmnProcess])[] {
  return [
    ['IR1', run.ir1],
    ['IR2', run.ir2],
    ['IR3', run.ir3],
  ];
}

const SERVICE_EXPRESSION_SRC =
  'process shipping-quote {\n' +
  '  start OrderPlaced\n' +
  '  service QuoteShipping(expression: "${shippingBean.quote(order)}")\n' +
  '  end Done\n' +
  '}\n';

const SERVICE_DELEGATE_SRC =
  'process payment-charge {\n' +
  '  start OrderPlaced\n' +
  '  service ChargeCustomer(delegate: "${chargeService}")\n' +
  '  end Done\n' +
  '}\n';

const SERVICE_TOPIC_SRC =
  'process shipment-label {\n' +
  '  start OrderPlaced\n' +
  '  service PrintLabel(topic: "print-label")\n' +
  '  end Done\n' +
  '}\n';

const SCRIPT_TASK_SRC =
  'process order-discount {\n' +
  '  start OrderPlaced\n' +
  '  script ComputeDiscount ```js\n' +
  'var discount = amount * 0.1;\n' +
  'execution.setVariable("discount", discount);\n' +
  '```\n' +
  '  end Done\n' +
  '}\n';

const TIMER_START_SRC =
  'process nightly-audit {\n' +
  '  start AuditWindowOpens timer(at: "2099-01-01T00:00:00", label: "The audit window opens")\n' +
  '  user ReviewAudit(assignee: "demo")\n' +
  '  end AuditFiled\n' +
  '}\n';

const SIGNAL_START_SRC =
  'process stock-watch {\n' +
  '  start StockRunningLow signal("StockRunningLow")\n' +
  '  user ReorderStock(assignee: "demo")\n' +
  '  end Restocked\n' +
  '}\n';

// The condition reads a variable, and the form on the start is what declares it,
// so the printed source validates without a `var` the import hop would have had
// nowhere to put.
const CONDITION_START_SRC =
  'process stock-watch {\n' +
  '  start StockRanLow condition(stockLevel < 5) {\n' +
  '    form {\n' +
  '      stockLevel: number "Stock on hand"\n' +
  '    }\n' +
  '  }\n' +
  '  user ReorderStock(assignee: "demo")\n' +
  '  end Restocked\n' +
  '}\n';

// Both value forms on the element and one on a listener, so the two carriers
// and the two slots are in one program.
const FIELD_INJECTION_SRC =
  'process shipment-dispatch {\n' +
  '  start OrderPacked\n' +
  '  service PrintLabel(class: "com.acme.PrintLabelDelegate") {\n' +
  '    field printer = "warehouse-north"\n' +
  '    field copies = "${order.parcelCount}"\n' +
  '    on start(delegate: "${dispatchAudit}") {\n' +
  '      field stage = "label-printing"\n' +
  '    }\n' +
  '  }\n' +
  '  end LabelPrinted\n' +
  '}\n';

const FORM_REF_SRC =
  'process refund-approval {\n' +
  '  start RefundRequested\n' +
  '  user ApproveRefund(assignee: "demo", formRef: "refund-form", binding: latest)\n' +
  '  end RefundApproved\n' +
  '}\n';

const TERMINATE_END_SRC =
  'process order-abandon {\n' +
  '  start OrderPlaced\n' +
  '  user ReviewOrder(assignee: "demo")\n' +
  '  end OrderAbandoned terminate(label: "Abandon every path")\n' +
  '}\n';

describe('round-trip: service task with an `expression` binding', () => {
  const run = roundTripOf(SERVICE_EXPRESSION_SRC);

  it('desugars to an `expression` binding carrying the raw ${...} text', () => {
    const binding = theOnly(run.ir1, 'serviceTask').binding;
    expect(binding).toEqual({
      kind: 'expression',
      expression: '${shippingBean.quote(order)}',
    });
  });

  it('generates `operaton:expression` in the BPMN XML', () => {
    expect(run.xml).toContain(
      'operaton:expression="${shippingBean.quote(order)}"',
    );
  });

  it('re-imports to the same `expression` binding', () => {
    expect(theOnly(run.ir2, 'serviceTask').binding).toEqual({
      kind: 'expression',
      expression: '${shippingBean.quote(order)}',
    });
  });

  it('re-emits `expression = "${...}"` and re-parses with zero errors', async () => {
    expect(run.dsl).toContain('expression: "${shippingBean.quote(order)}"');
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: service task with a `delegate` binding (delegateExpression alias)', () => {
  const run = roundTripOf(SERVICE_DELEGATE_SRC);

  it('desugars `delegate = "${...}"` to a `delegateExpression` binding', () => {
    expect(theOnly(run.ir1, 'serviceTask').binding).toEqual({
      kind: 'delegateExpression',
      expression: '${chargeService}',
    });
  });

  it('both directions: DSL `delegate` generates XML `operaton:delegateExpression`, and the re-emitted DSL is `delegate` again', () => {
    // DSL -> XML: the generated attribute is the real Operaton name, never the
    // DSL-only alias.
    expect(run.xml).toContain('operaton:delegateExpression="${chargeService}"');
    expect(run.xml).not.toContain('operaton:delegate=');

    // XML -> DSL: the importer reads `delegateExpression` back to the same
    // binding kind and the printer emits the `delegate` alias.
    expect(theOnly(run.ir2, 'serviceTask').binding).toEqual({
      kind: 'delegateExpression',
      expression: '${chargeService}',
    });
    expect(run.dsl).toContain('delegate: "${chargeService}"');
    expect(run.dsl).not.toContain('delegateExpression');
  });

  it('the re-emitted DSL re-parses with zero errors and re-desugars to the same binding', () => {
    expect(theOnly(run.ir3, 'serviceTask').binding).toEqual({
      kind: 'delegateExpression',
      expression: '${chargeService}',
    });
  });
});

describe('round-trip: service task with a `topic` binding', () => {
  const run = roundTripOf(SERVICE_TOPIC_SRC);

  it('desugars to an `external` binding carrying the topic', () => {
    expect(theOnly(run.ir1, 'serviceTask').binding).toEqual({
      kind: 'external',
      topic: 'print-label',
    });
  });

  it('generates `operaton:type="external"` and `operaton:topic` in the BPMN XML', () => {
    expect(run.xml).toContain('operaton:type="external"');
    expect(run.xml).toContain('operaton:topic="print-label"');
  });

  it('re-imports to the same `external` binding', () => {
    expect(theOnly(run.ir2, 'serviceTask').binding).toEqual({
      kind: 'external',
      topic: 'print-label',
    });
  });

  it('re-emits `service ...(topic: "...")` and re-parses with zero errors', async () => {
    expect(run.dsl).toContain('service PrintLabel');
    expect(run.dsl).toContain('topic: "print-label"');
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: `script` task with a fenced body', () => {
  const EXPECTED_CODE =
    'var discount = amount * 0.1;\n' +
    'execution.setVariable("discount", discount);\n';

  const run = roundTripOf(SCRIPT_TASK_SRC);

  it('desugars the `js` fence tag to canonical scriptFormat "javascript" and keeps the body verbatim', () => {
    const scriptTask = theOnly(run.ir1, 'scriptTask');
    expect(scriptTask.format).toBe('javascript');
    expect(scriptTask.code).toBe(EXPECTED_CODE);
  });

  it('generates `scriptFormat="javascript"` and the script body in the BPMN XML', () => {
    expect(run.xml).toContain('scriptFormat="javascript"');
    expect(run.xml).toContain('var discount = amount * 0.1;');
  });

  it('re-imports to the same scriptFormat and body', () => {
    const scriptTask = theOnly(run.ir2, 'scriptTask');
    expect(scriptTask.format).toBe('javascript');
    expect(scriptTask.code).toBe(EXPECTED_CODE);
  });

  it('re-emits a fenced `script ... ```javascript ... ``` ` block and re-parses with zero errors', async () => {
    expect(run.dsl).toContain(
      `script ComputeDiscount \`\`\`javascript\n${EXPECTED_CODE}\`\`\``,
    );
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });

  it('the decompiled DSL recompiles without validation errors', async () => {
    const { diagnostics } = await validate(run.dsl);
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});

describe('round-trip: process start event with a timer trigger', () => {
  const run = roundTripOf(TIMER_START_SRC);

  it('desugars to a timer trigger on the start event', () => {
    const start = theOnly(run.ir1, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'timer',
      timerKind: 'date',
      expression: '2099-01-01T00:00:00',
    });
  });

  it('generates a `bpmn:timeDate` element carrying the date', () => {
    expect(run.xml).toContain('<bpmn:timeDate');
    expect(run.xml).toContain('2099-01-01T00:00:00');
  });

  it('re-imports to the same timer trigger', () => {
    const start = theOnly(run.ir2, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'timer',
      timerKind: 'date',
      expression: '2099-01-01T00:00:00',
    });
  });

  it('re-emits the trigger head on `start` and re-parses with zero errors', async () => {
    expect(run.dsl).toContain(
      'start AuditWindowOpens timer(at: "2099-01-01T00:00:00", ' +
        'label: "The audit window opens")',
    );
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: process start event with a signal trigger', () => {
  const run = roundTripOf(SIGNAL_START_SRC);

  it('desugars to a signal trigger on the start event', () => {
    const start = theOnly(run.ir1, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'signal',
      signalName: 'StockRunningLow',
    });
  });

  it('generates one `bpmn:signal` root and a `signalRef` on the start event', () => {
    expect(run.xml.match(/<bpmn:signal /g)).toHaveLength(1);
    expect(run.xml).toContain('signalRef=');
  });

  it('re-imports to the same signal trigger', () => {
    const start = theOnly(run.ir2, 'startEvent');
    expect(start.eventDefinition).toEqual({
      kind: 'signal',
      signalName: 'StockRunningLow',
    });
  });

  it('re-emits the trigger head on `start` and re-parses with zero errors', async () => {
    expect(run.dsl).toContain(
      'start StockRunningLow signal("StockRunningLow")',
    );
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: process start event with a condition trigger', () => {
  const run = roundTripOf(CONDITION_START_SRC);

  it('keeps the condition through every hop and re-emits a start that validates clean', async () => {
    const conditional = {
      kind: 'conditional',
      condition: '${stockLevel < 5}',
    };

    expect(theOnly(run.ir1, 'startEvent').eventDefinition, 'IR1').toEqual(
      conditional,
    );

    expect(run.xml, 'XML').toContain(
      '<bpmn:condition xsi:type="bpmn:tFormalExpression">' +
        '${stockLevel &lt; 5}</bpmn:condition>',
    );

    expect(theOnly(run.ir2, 'startEvent').eventDefinition, 'IR2').toEqual(
      conditional,
    );

    expect(run.dsl, 'DSL').toContain(
      'start StockRanLow condition(stockLevel < 5)',
    );
    const { diagnostics } = await validate(run.dsl);
    expect(diagnostics).toEqual([]);
  });
});

describe('round-trip: `end ... terminate`', () => {
  const run = roundTripOf(TERMINATE_END_SRC);

  it('desugars to a terminate end event that keeps its label', () => {
    const end = theOnly(run.ir1, 'endEvent');
    expect(end.eventDefinition).toEqual({ kind: 'terminate' });
    expect(end.name).toBe('Abandon every path');
  });

  it('generates `bpmn:terminateEventDefinition` and keeps the label as the `name` attribute', () => {
    expect(run.xml).toContain('<bpmn:terminateEventDefinition');
    expect(run.xml).toContain('name="Abandon every path"');
  });

  it('re-imports to the same terminate end event with no label warning', () => {
    const end = theOnly(run.ir2, 'endEvent');
    expect(end.eventDefinition).toEqual({ kind: 'terminate' });
    expect(end.name).toBe('Abandon every path');
    expect(run.warnings.filter((w) => w.category === 'label')).toEqual([]);
  });

  it('re-emits `end ... terminate`, never eliding it, and re-parses with zero errors', async () => {
    expect(run.dsl).toContain(
      'end OrderAbandoned terminate(label: "Abandon every path")',
    );
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: `field` on a class binding and on a listener binding', () => {
  const run = roundTripOf(FIELD_INJECTION_SRC);

  it('every field keeps its carrier, name, and value through every hop, and the re-emitted DSL validates clean', async () => {
    const taskBinding = {
      kind: 'class',
      className: 'com.acme.PrintLabelDelegate',
      fields: [
        { name: 'printer', value: 'warehouse-north' },
        { name: 'copies', value: '${order.parcelCount}' },
      ],
    };
    const listener = {
      event: 'start',
      binding: {
        kind: 'delegateExpression',
        expression: '${dispatchAudit}',
        fields: [{ name: 'stage', value: 'label-printing' }],
      },
    };

    for (const [label, ir] of hops(run)) {
      const task = theOnly(ir, 'serviceTask');
      expect(task.binding, `the task binding differs in ${label}`).toEqual(
        taskBinding,
      );
      expect(
        task.executionListeners,
        `the listener differs in ${label}`,
      ).toEqual([listener]);
    }

    // The literal takes the attribute slot and the `${...}` an expression
    // child. Written the other way round the engine injects the text of the
    // expression instead of what it evaluates to.
    expect(run.xml, 'XML').toContain(
      '<operaton:field name="printer" stringValue="warehouse-north" />',
    );
    expect(run.xml, 'XML').toContain(
      '<operaton:expression>${order.parcelCount}</operaton:expression>',
    );
    expect(run.warnings, 'import warnings').toEqual([]);

    expect(run.dsl, 'DSL').toContain('field printer = "warehouse-north"');
    expect(run.dsl, 'DSL').toContain('field copies = "${order.parcelCount}"');
    expect(run.dsl, 'DSL').toContain('field stage = "label-printing"');
    const { diagnostics } = await validate(run.dsl);
    expect(diagnostics).toEqual([]);
  });
});

describe('round-trip: `formRef` on a user task', () => {
  const run = roundTripOf(FORM_REF_SRC);

  it('the form reference keeps its key and binding through every hop, and the re-emitted DSL validates clean', async () => {
    for (const [label, ir] of hops(run)) {
      expect(
        theOnly(ir, 'userTask').formRef,
        `the form reference differs in ${label}`,
      ).toEqual({ key: 'refund-form', binding: { kind: 'latest' } });
    }

    // Operaton refuses to deploy a form reference carrying no binding, so the
    // binding attribute is written even where it names the engine's own
    // default, and the version attribute only where a version was pinned.
    expect(run.xml, 'XML').toContain(
      'operaton:formRef="refund-form" operaton:formRefBinding="latest"',
    );
    expect(run.xml, 'XML').not.toContain('formRefVersion');
    expect(run.warnings, 'import warnings').toEqual([]);

    expect(run.dsl, 'DSL').toContain('formRef: "refund-form", binding: latest');
    const { diagnostics } = await validate(run.dsl);
    expect(diagnostics).toEqual([]);
  });
});
