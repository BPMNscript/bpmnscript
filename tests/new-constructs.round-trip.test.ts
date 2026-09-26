// What the single-stage transform tests cannot catch is a field-name or
// binding-kind mismatch between stages, so one minimal program per construct
// goes through the whole pipeline here. Every row pins the same value at all
// three IR hops, the whole XML tag or line that carries it, and the printed
// statement that writes it back.

import { describe, it, expect } from 'vitest';

import type { BpmnProcess } from '@bpmn-script/transform';

import { theOnly } from './helpers/ir-query.js';
import { roundTrip, validate } from './helpers/pipeline.js';

const SCRIPT_CODE =
  'var discount = amount * 0.1;\n' +
  'execution.setVariable("discount", discount);\n';

describe('round-trip: one minimal program per construct', () => {
  it.each([
    [
      'a service task with an `expression` binding',
      'process shipping-quote {\n' +
        '  start OrderPlaced\n' +
        '  service QuoteShipping(expression: "${shippingBean.quote(order)}")\n' +
        '  end Done\n' +
        '}\n',
      (ir: BpmnProcess) => theOnly(ir, 'serviceTask').binding,
      { kind: 'expression', expression: '${shippingBean.quote(order)}' },
      [
        '<bpmn:serviceTask id="QuoteShipping" name="Quote Shipping" operaton:expression="${shippingBean.quote(order)}">',
      ],
      ['  service QuoteShipping(expression: "${shippingBean.quote(order)}")\n'],
    ],
    [
      'a service task with a `delegate` binding writes the real Operaton attribute and prints the alias again',
      'process payment-charge {\n' +
        '  start OrderPlaced\n' +
        '  service ChargeCustomer(delegate: "${chargeService}")\n' +
        '  end Done\n' +
        '}\n',
      (ir: BpmnProcess) => theOnly(ir, 'serviceTask').binding,
      { kind: 'delegateExpression', expression: '${chargeService}' },
      [
        '<bpmn:serviceTask id="ChargeCustomer" name="Charge Customer" operaton:delegateExpression="${chargeService}">',
      ],
      ['  service ChargeCustomer(delegate: "${chargeService}")\n'],
    ],
    [
      'a service task with a `topic` binding',
      'process shipment-label {\n' +
        '  start OrderPlaced\n' +
        '  service PrintLabel(topic: "print-label")\n' +
        '  end Done\n' +
        '}\n',
      (ir: BpmnProcess) => theOnly(ir, 'serviceTask').binding,
      { kind: 'external', topic: 'print-label' },
      [
        '<bpmn:serviceTask id="PrintLabel" name="Print Label" operaton:type="external" operaton:topic="print-label">',
      ],
      ['  service PrintLabel(topic: "print-label")\n'],
    ],
    [
      'a `script` task with a fenced body keeps the body verbatim and canonicalizes the `js` tag',
      'process order-discount {\n' +
        '  start OrderPlaced\n' +
        '  script ComputeDiscount ```js\n' +
        SCRIPT_CODE +
        '```\n' +
        '  end Done\n' +
        '}\n',
      (ir: BpmnProcess) => {
        const { format, code } = theOnly(ir, 'scriptTask');
        return { format, code };
      },
      { format: 'javascript', code: SCRIPT_CODE },
      [
        '<bpmn:scriptTask id="ComputeDiscount" name="Compute Discount" scriptFormat="javascript">',
        `<bpmn:script>${SCRIPT_CODE}</bpmn:script>`,
      ],
      [`  script ComputeDiscount \`\`\`javascript\n${SCRIPT_CODE}\`\`\`\n`],
    ],
    [
      'a process start with a timer trigger',
      'process nightly-audit {\n' +
        '  start AuditWindowOpens timer(at: "2099-01-01T00:00:00", label: "The audit window opens")\n' +
        '  user ReviewAudit(assignee: "demo")\n' +
        '  end AuditFiled\n' +
        '}\n',
      (ir: BpmnProcess) => theOnly(ir, 'startEvent').eventDefinition,
      { kind: 'timer', timerKind: 'date', expression: '2099-01-01T00:00:00' },
      [
        '<bpmn:timeDate xsi:type="bpmn:tFormalExpression">2099-01-01T00:00:00</bpmn:timeDate>',
      ],
      [
        '  start AuditWindowOpens timer(at: "2099-01-01T00:00:00", label: "The audit window opens")\n',
      ],
    ],
    [
      'a process start with a signal trigger derives exactly one signal root',
      'process stock-watch {\n' +
        '  start StockRunningLow signal("StockRunningLow")\n' +
        '  user ReorderStock(assignee: "demo")\n' +
        '  end Restocked\n' +
        '}\n',
      (ir: BpmnProcess) => theOnly(ir, 'startEvent').eventDefinition,
      { kind: 'signal', signalName: 'StockRunningLow' },
      [
        '<bpmn:signalEventDefinition signalRef="Signal_StockRunningLow" />',
        '</bpmn:process>\n' +
          '  <bpmn:signal id="Signal_StockRunningLow" name="StockRunningLow" />\n' +
          '  <bpmndi:',
      ],
      ['  start StockRunningLow signal("StockRunningLow")\n'],
    ],
    [
      // The form on the start declares the variable the condition reads, so
      // the printed source validates without a `var` the import hop would
      // have had nowhere to put.
      'a process start with a condition trigger',
      'process stock-watch {\n' +
        '  start StockRanLow condition(stockLevel < 5) {\n' +
        '    form {\n' +
        '      stockLevel: number "Stock on hand"\n' +
        '    }\n' +
        '  }\n' +
        '  user ReorderStock(assignee: "demo")\n' +
        '  end Restocked\n' +
        '}\n',
      (ir: BpmnProcess) => theOnly(ir, 'startEvent').eventDefinition,
      { kind: 'conditional', condition: '${stockLevel < 5}' },
      [
        '<bpmn:condition xsi:type="bpmn:tFormalExpression">${stockLevel &lt; 5}</bpmn:condition>',
      ],
      ['  start StockRanLow condition(stockLevel < 5) {\n'],
    ],
    [
      'an `end ... terminate` keeps its trigger and its label, and is never elided',
      'process order-abandon {\n' +
        '  start OrderPlaced\n' +
        '  user ReviewOrder(assignee: "demo")\n' +
        '  end OrderAbandoned terminate(label: "Abandon every path")\n' +
        '}\n',
      (ir: BpmnProcess) => {
        const { eventDefinition, name } = theOnly(ir, 'endEvent');
        return { eventDefinition, name };
      },
      { eventDefinition: { kind: 'terminate' }, name: 'Abandon every path' },
      [
        '<bpmn:endEvent id="OrderAbandoned" name="Abandon every path">',
        '<bpmn:terminateEventDefinition />',
      ],
      ['  end OrderAbandoned terminate(label: "Abandon every path")\n'],
    ],
    [
      // The literal takes the attribute slot and the `${...}` an expression
      // child. Written the other way round the engine injects the text of the
      // expression instead of what it evaluates to.
      'a `field` on a class binding and on a listener binding keeps its carrier, name and value',
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
        '}\n',
      (ir: BpmnProcess) => {
        const { binding, executionListeners } = theOnly(ir, 'serviceTask');
        return { binding, executionListeners };
      },
      {
        binding: {
          kind: 'class',
          className: 'com.acme.PrintLabelDelegate',
          fields: [
            { name: 'printer', value: 'warehouse-north' },
            { name: 'copies', value: '${order.parcelCount}' },
          ],
        },
        executionListeners: [
          {
            event: 'start',
            binding: {
              kind: 'delegateExpression',
              expression: '${dispatchAudit}',
              fields: [{ name: 'stage', value: 'label-printing' }],
            },
          },
        ],
      },
      [
        '<operaton:field name="printer" stringValue="warehouse-north" />',
        '<operaton:expression>${order.parcelCount}</operaton:expression>',
      ],
      [
        '    field printer = "warehouse-north"\n' +
          '    field copies = "${order.parcelCount}"\n' +
          '    on start(delegate: "${dispatchAudit}") {\n' +
          '      field stage = "label-printing"\n',
      ],
    ],
    [
      // Operaton refuses to deploy a form reference carrying no binding, so
      // the binding attribute is written even where it names the engine's own
      // default, and the version attribute only where a version was pinned.
      'a `formRef` on a user task keeps its key and binding',
      'process refund-approval {\n' +
        '  start RefundRequested\n' +
        '  user ApproveRefund(assignee: "demo", formRef: "refund-form", binding: latest)\n' +
        '  end RefundApproved\n' +
        '}\n',
      (ir: BpmnProcess) => theOnly(ir, 'userTask').formRef,
      { key: 'refund-form', binding: { kind: 'latest' } },
      [
        '<bpmn:userTask id="ApproveRefund" name="Approve Refund" operaton:assignee="demo" operaton:formRef="refund-form" operaton:formRefBinding="latest">',
      ],
      [
        '  user ApproveRefund(assignee: "demo", formRef: "refund-form", binding: latest)\n',
      ],
    ],
  ])(
    '%s',
    async (_title, source, pick, expected, xmlFragments, dslFragments) => {
      const run = await roundTrip(source);

      for (const [hop, ir] of run.hops) {
        expect(pick(ir), `the value differs in ${hop}`).toEqual(expected);
      }
      for (const fragment of xmlFragments) {
        expect(run.xml).toContain(fragment);
      }
      expect(run.warnings, 'import warnings').toEqual([]);
      for (const fragment of dslFragments) {
        expect(run.dsl).toContain(fragment);
      }
      const { diagnostics } = await validate(run.dsl);
      expect(diagnostics).toEqual([]);
    },
  );
});
