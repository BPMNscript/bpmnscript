/**
 * Integration-level tests: `xmlToIr` runs against real BPMN XML strings,
 * including the golden fixture files under `tests/golden/`.
 *
 * `xmlToIr` returns `{ ir, warnings }`, where `warnings` reports non-semantic
 * content dropped on import (extra Operaton/camunda extension attributes and
 * elements, lanes, documentation). Semantic content the IR cannot express is
 * refused instead: an `UnsupportedConstructError` subclass is thrown before any
 * IR is produced.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr } from '../src/xml-to-ir.js';
import type { ImportWarning } from '../src/xml-to-ir.js';
import {
  UnsupportedCallActivityError,
  UnsupportedCollaborationError,
  UnsupportedConstructError,
  UnsupportedElementError,
  UnsupportedEventDefinitionError,
  UnsupportedEventFeatureError,
  UnsupportedExtensionFormError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedServiceTaskFormError,
} from '../src/errors.js';
import type {
  BpmnProcess,
  CallActivity,
  EventDefinition,
  FlowElement,
  IntermediateCatchEvent,
} from '../src/ir/types.js';
import { expectRefusal } from './helpers/expect-refusal.js';
import {
  boundaryEvent,
  chained,
  chainedSub,
  classBinding,
  conditionDef,
  delegateBinding,
  errorDef,
  escalationDef,
  eventSubProcess,
  exprBinding,
  externalBinding,
  gateway,
  HANDWRITTEN_IMPORT_IR,
  ioParam,
  listValue,
  mapEntry,
  mapValue,
  messageDef,
  minimalProcess,
  scriptValue,
  signalDef,
  textValue,
  timerDef,
  triggeredSub,
  typedEvent,
} from './helpers/ir-fixtures.js';
import type { XmlTag } from './helpers/bpmn-doc.js';
import {
  bpmnDefs,
  bpmnDoc,
  camundaDefs,
  camundaDoc,
  dualDefs,
  dualDoc,
  extensionElements,
  handlerDoc,
  oneNodeDoc,
  operatonDefs,
  operatonDoc,
} from './helpers/bpmn-doc.js';
import { importById, importOnly } from './helpers/import-node.js';
import { byId, only, subProcess } from './helpers/ir-query.js';

const here = dirname(fileURLToPath(import.meta.url));
const HANDWRITTEN_XML = readFileSync(
  resolve(here, '../../../tests/golden/invoice-approval-handwritten.bpmn'),
  'utf-8',
);

/** Only the warnings reporting dropped Operaton/camunda extension content. */
const extensionWarnings = (warnings: ImportWarning[]): ImportWarning[] =>
  warnings.filter((w) => w.category === 'extensionAttribute');

/** Only the warnings reporting BPMN content the transform does not map. */
const unmappedWarnings = (warnings: ImportWarning[]): ImportWarning[] =>
  warnings.filter((w) => w.category === 'unmappedConstruct');

/** The whole refusal an activity excluded from normal flow draws. */
const IS_FOR_COMPENSATION_DETAIL =
  'isForCompensation="true" marks this activity as excluded from normal ' +
  'flow: the boundary-event compensation-handler pattern, which this tool ' +
  'cannot import; wrap the steps in their own subprocess and target it with ' +
  '"on compensation" instead';

/**
 * Assert that exactly one warning was raised, and that it names the element and
 * says what was dropped. The count is half the contract: a drop reported twice,
 * or fanned out across clean elements, is as wrong as one never reported.
 */
const expectOneWarning = (
  warnings: ImportWarning[],
  expected: {
    elementId: string;
    category?: ImportWarning['category'];
    message: RegExp | string;
  },
): ImportWarning => {
  expect(warnings).toHaveLength(1);
  const [warning] = warnings;
  expect(warning.elementId).toBe(expected.elementId);
  if (expected.category !== undefined) {
    expect(warning.category).toBe(expected.category);
  }
  if (expected.message instanceof RegExp) {
    expect(warning.message).toMatch(expected.message);
  } else {
    expect(warning.message).toContain(expected.message);
  }
  return warning;
};

/**
 * A process opening on `<bpmn:startEvent id="S" />`, preceded by root-level
 * declarations and continued by a body written verbatim: the shape of every
 * fixture that pins a root (error, message, signal) against one event.
 */
const rootedDoc = (roots: string, body: string, defs = bpmnDefs): string =>
  defs`${roots}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
${body}
  </bpmn:process>`;

// ── 1. Canonical handwritten file -> canonical IR ────────────────────────────

describe('xmlToIr: canonical handwritten file', () => {
  it('parsing the canonical handwritten file yields the canonical IR (deep equality)', async () => {
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    expect(ir).toEqual(HANDWRITTEN_IMPORT_IR);
  });

  it('clean input produces no warnings', async () => {
    const { warnings } = await xmlToIr(HANDWRITTEN_XML);
    expect(warnings).toEqual([]);
  });

  it('process id equals "invoice-approval"', async () => {
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    expect(ir.id).toBe('invoice-approval');
  });

  it('process name is dropped on import when it equals humanize(id)', async () => {
    // "Invoice Approval" equals humanize("invoice-approval"), so it is
    // derivable and dropped.
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    expect(ir.name).toBeUndefined();
  });

  it('produces 6 flow elements', async () => {
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    expect(ir.flowElements).toHaveLength(6);
  });

  it('produces 6 sequence flows', async () => {
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    expect(ir.sequenceFlows).toHaveLength(6);
  });
});

// ── 2. camunda: prefix yields the same IR ───────────────────────────────────

describe('xmlToIr: camunda: prefix alias', () => {
  it('parsing the same file with camunda: prefixes yields the same IR', async () => {
    // Simulate a file exported by Camunda 7: the namespace declaration and
    // every attribute occurrence carry the deprecated prefix.
    const camundaXml = HANDWRITTEN_XML.replace(
      /xmlns:operaton="http:\/\/operaton\.org\/schema\/1\.0\/bpmn"/g,
      'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"',
    ).replace(/operaton:/g, 'camunda:');

    const { ir } = await xmlToIr(camundaXml);

    // The IR is identical: the dual-namespace accept contract.
    expect(ir).toEqual(HANDWRITTEN_IMPORT_IR);
  });

  it('camunda:assignee is read as UserTask.assignee', async () => {
    const { node } = await importOnly(
      oneNodeDoc('userTask', {
        attrs: 'name="My Task" camunda:assignee="alice"',
        doc: camundaDoc,
      }),
      'userTask',
    );
    expect(node.assignee).toBe('alice');
  });
});

// ── 3. Service task execution forms import to their bindings ─────────────────

describe('xmlToIr: service task binding forms', () => {
  const importServiceTask = (attrs: string, doc = operatonDoc) =>
    importOnly(oneNodeDoc('serviceTask', { attrs, doc }), 'serviceTask');

  it.each([
    [
      'operaton:expression imports to an expression binding carrying the raw text',
      'name="Expr Task" operaton:expression="${someBean.execute(execution)}"',
      exprBinding('${someBean.execute(execution)}'),
    ],
    [
      'operaton:delegateExpression imports to a delegateExpression binding',
      'name="Delegate Task" operaton:delegateExpression="${myDelegate}"',
      delegateBinding('${myDelegate}'),
    ],
    [
      'operaton:type="external" with a topic imports to an external binding',
      'name="Ship It" operaton:type="external" operaton:topic="shipping"',
      externalBinding('shipping'),
    ],
  ] as const)('%s', async (_title, attrs, binding) => {
    const { node } = await importServiceTask(attrs);
    expect(node.binding).toEqual(binding);
  });

  it('the camunda: prefix is accepted for the expression form', async () => {
    const { node } = await importServiceTask(
      'camunda:expression="${x}"',
      camundaDoc,
    );
    expect(node.binding.kind).toBe('expression');
  });

  it('an accepted external task produces no drop warnings for type/topic', async () => {
    const { warnings } = await importServiceTask(
      'operaton:type="external" operaton:topic="shipping"',
    );
    expect(warnings).toEqual([]);
  });

  it('operaton:type="external" WITHOUT a topic stays refused', async () => {
    await expect(
      xmlToIr(oneNodeDoc('serviceTask', { attrs: 'operaton:type="external"' })),
    ).rejects.toBeInstanceOf(UnsupportedServiceTaskFormError);
  });

  it.each([
    'operaton:class="com.example.Svc"',
    'operaton:expression="${someBean.execute(execution)}"',
    'operaton:delegateExpression="${myDelegate}"',
    'operaton:type="external" operaton:topic="shipping"',
  ])('a lone %s imports with no warning', async (attrs) => {
    const { warnings } = await importServiceTask(attrs);
    expect(warnings).toEqual([]);
  });

  it.each([
    [
      'a topic beside a class names no worker the engine reaches',
      'operaton:class="com.example.Svc" operaton:topic="shipping"',
      classBinding('com.example.Svc'),
      "The 'topic' setting on 'T' has no effect alongside operaton:class and was not imported.",
    ],
    [
      'an expression beside a class is never reached',
      'operaton:class="com.example.Svc" operaton:expression="${someBean.execute(execution)}"',
      classBinding('com.example.Svc'),
      "The 'expression' setting on 'T' has no effect alongside operaton:class and was not imported.",
    ],
    [
      'a delegateExpression outranks an expression, as it does in the engine',
      'operaton:expression="${someBean.execute(execution)}" operaton:delegateExpression="${myDelegate}"',
      delegateBinding('${myDelegate}'),
      "The 'expression' setting on 'T' has no effect alongside operaton:delegateExpression and was not imported.",
    ],
    [
      'an external type outranks every code attribute, as it does in the engine',
      'operaton:class="com.example.Svc" operaton:type="external" operaton:topic="shipping"',
      externalBinding('shipping'),
      "The 'class' setting on 'T' has no effect alongside operaton:type=\"external\" and was not imported.",
    ],
  ] as const)(
    'the binding the engine resolves wins and the rest are reported: %s',
    async (_title, attrs, binding, message) => {
      const { node, warnings } = await importServiceTask(attrs);
      expect(node.binding).toEqual(binding);
      expect(warnings.map((w) => w.message)).toEqual([message]);
    },
  );

  it.each(['sendTask', 'businessRuleTask'] as const)(
    'a bpmn:%s reports the passed-over attribute the same way',
    async (tag) => {
      const { node, warnings } = await importOnly(
        oneNodeDoc(tag, {
          attrs: 'operaton:class="com.example.Svc" operaton:topic="shipping"',
        }),
        'serviceTask',
      );
      expect(node.binding).toEqual(classBinding('com.example.Svc'));
      expect(warnings.map((w) => w.message)).toEqual([
        "The 'topic' setting on 'T' has no effect alongside operaton:class and was not imported.",
      ]);
    },
  );

  it('an operaton:type this surface cannot carry refuses rather than falling back to the class', async () => {
    const e = await expectRefusal<UnsupportedServiceTaskFormError>(
      xmlToIr(
        oneNodeDoc('serviceTask', {
          attrs: 'operaton:class="com.example.Svc" operaton:type="mail"',
        }),
      ),
      UnsupportedServiceTaskFormError,
    );
    expect(e.construct).toBe(
      'operaton:type="mail", which Operaton resolves ahead of the ' +
        'operaton:class alongside it',
    );
  });

  it('the refusal names every code attribute the type shadows', async () => {
    const e = await expectRefusal<UnsupportedServiceTaskFormError>(
      xmlToIr(
        oneNodeDoc('serviceTask', {
          attrs:
            'operaton:class="com.example.Svc" operaton:delegateExpression="${d}" operaton:type="External"',
        }),
      ),
      UnsupportedServiceTaskFormError,
    );
    expect(e.construct).toBe(
      'operaton:type="External" without an operaton:topic, which Operaton ' +
        'resolves ahead of the operaton:class and operaton:delegateExpression ' +
        'alongside it',
    );
  });

  it('a task naming nothing at all is refused with no shadowing clause', async () => {
    const e = await expectRefusal<UnsupportedServiceTaskFormError>(
      xmlToIr(oneNodeDoc('serviceTask', { attrs: 'name="Bare"' })),
      UnsupportedServiceTaskFormError,
    );
    expect(e.construct).toBe('no execution discriminator');
  });

  it('operaton:type="External" runs the external worker, as it does in the engine', async () => {
    const { node, warnings } = await importServiceTask(
      'operaton:type="External" operaton:topic="shipping"',
    );
    expect(node.binding).toEqual(externalBinding('shipping'));
    expect(warnings).toEqual([]);
  });
});

// ── 4. bpmn:parallelGateway is supported ─────────────────────────────────────

describe('xmlToIr: parallel gateway support', () => {
  const parallelGatewayXml = oneNodeDoc('parallelGateway', {
    id: 'PG',
    doc: bpmnDoc,
  });

  it('XML containing bpmn:parallelGateway is imported successfully (no error)', async () => {
    const { ir } = await xmlToIr(parallelGatewayXml);
    expect(ir.flowElements.some((fe) => fe.kind === 'parallelGateway')).toBe(
      true,
    );
  });

  it('imported parallelGateway carries the correct id', async () => {
    const { node } = await importOnly(parallelGatewayXml, 'parallelGateway');
    expect(node.id).toBe('PG');
  });
});

// ── 4b. Parallel split+join ──────────────────────────────────────────────────

describe('xmlToIr: parallel split+join (fork + join)', () => {
  /**
   * Parallel split+join shape:
   *   Start -> Fork (parallelGateway, 2 outgoing)
   *     -> BranchA (userTask)
   *     -> BranchB (userTask)
   *   BranchA, BranchB -> Join (parallelGateway, 2 incoming)
   *   Join -> End
   *
   * No conditionExpression on fork-outgoing flows.
   */
  const parallelSplitJoinXml = bpmnDefs`  <bpmn:process id="parallel-proc" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Fork" name="Fork" />
    <bpmn:userTask id="BranchA" name="Branch A" />
    <bpmn:userTask id="BranchB" name="Branch B" />
    <bpmn:parallelGateway id="Join" name="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F_Start_Fork" sourceRef="Start" targetRef="Fork" />
    <bpmn:sequenceFlow id="F_Fork_A" sourceRef="Fork" targetRef="BranchA" />
    <bpmn:sequenceFlow id="F_Fork_B" sourceRef="Fork" targetRef="BranchB" />
    <bpmn:sequenceFlow id="F_A_Join" sourceRef="BranchA" targetRef="Join" />
    <bpmn:sequenceFlow id="F_B_Join" sourceRef="BranchB" targetRef="Join" />
    <bpmn:sequenceFlow id="F_Join_End" sourceRef="Join" targetRef="End" />
  </bpmn:process>`;

  it('produces two parallelGateway elements in IR', async () => {
    const { ir } = await xmlToIr(parallelSplitJoinXml);
    const pgs = ir.flowElements.filter((fe) => fe.kind === 'parallelGateway');
    expect(pgs).toHaveLength(2);
  });

  it.each(['Fork', 'Join'])(
    '%s parallelGateway has correct id and name',
    async (id) => {
      const { ir } = await xmlToIr(parallelSplitJoinXml);
      const gateway = byId(ir, id);
      expect(gateway.kind === 'parallelGateway' && gateway.name).toBe(id);
    },
  );

  it('produces 6 sequence flows with no conditionExpression on fork-outgoing', async () => {
    const { ir } = await xmlToIr(parallelSplitJoinXml);
    expect(ir.sequenceFlows).toHaveLength(6);
    // Fork outgoing flows must have no conditionExpression.
    const forkOutgoing = ir.sequenceFlows.filter((f) => f.sourceRef === 'Fork');
    expect(forkOutgoing).toHaveLength(2);
    for (const flow of forkOutgoing) {
      expect(flow.conditionExpression).toBeUndefined();
    }
  });

  it('produces correct full IR for the parallel split+join process', async () => {
    const { ir } = await xmlToIr(parallelSplitJoinXml);
    expect(ir.id).toBe('parallel-proc');
    expect(ir.flowElements).toHaveLength(6); // Start, Fork, A, B, Join, End
    expect(ir.sequenceFlows).toHaveLength(6);
  });
});

// ── 4c. Script task imports to a scriptTask IR ───────────────────────────────

describe('xmlToIr: script task support', () => {
  const scriptTaskDoc = (body: string, attrs = '') =>
    oneNodeDoc('scriptTask', {
      id: 'ST',
      attrs: `scriptFormat="javascript" ${attrs}`,
      children: `<bpmn:script>${body}</bpmn:script>`,
      doc: bpmnDoc,
    });

  it('bpmn:scriptTask imports to a scriptTask IR carrying scriptFormat and body', async () => {
    const { node } = await importOnly(
      scriptTaskDoc('total = price * quantity;', 'name="Compute total"'),
      'scriptTask',
    );
    expect(node.format).toBe('javascript');
    expect(node.code).toBe('total = price * quantity;');
    expect(node.name).toBe('Compute total');
  });

  it('decodes an entity-escaped bpmn:script body to the literal text', async () => {
    const { node } = await importOnly(
      scriptTaskDoc('a &lt; b &amp;&amp; c'),
      'scriptTask',
    );
    expect(node.code).toBe('a < b && c');
  });
});

// ── 4d. UnsupportedElementError for genuinely unsupported kinds ───────────────

describe('xmlToIr: unsupported element (still refused kinds)', () => {
  it.each([
    ['bpmn:AdHocSubProcess', 'adHocSubProcess', '<bpmn:userTask id="A" />'],
    ['bpmn:InclusiveGateway', 'inclusiveGateway', ''],
  ])('%s raises UnsupportedElementError', async (qname, tag, children) => {
    const e = await expectRefusal<UnsupportedElementError>(
      xmlToIr(oneNodeDoc(tag, { children, doc: bpmnDoc })),
      UnsupportedElementError,
    );
    expect(e.qname).toBe(qname);
    expect(e.elementId).toBe('T');
    expect(e.message).toContain(
      'Only start/end events, throws, emits, boundary events, event ' +
        'handlers, plain tasks, user tasks, service tasks, send tasks, ' +
        'receive tasks, business rule tasks, script tasks, exclusive ' +
        'gateways, parallel gateways, embedded subprocesses, attempt ' +
        'blocks, call activities, and sequence flows are supported.',
    );
  });

  it('bpmn:callActivity is imported, not refused (see the "callActivity import" suite below)', async () => {
    const { ir } = await xmlToIr(
      oneNodeDoc('callActivity', {
        attrs: 'calledElement="other-process"',
        doc: bpmnDoc,
      }),
    );
    expect(ir.flowElements.some((fe) => fe.kind === 'callActivity')).toBe(true);
  });
});

// ── 5. Multi-process definitions raise a clear error ────────────────────────

describe('xmlToIr: multi-process error', () => {
  it('XML with two bpmn:process elements raises a clear multi-process error', async () => {
    const xml = bpmnDefs`  <bpmn:process id="p1" isExecutable="true">
    <bpmn:startEvent id="S1" />
    <bpmn:endEvent id="E1" />
    <bpmn:sequenceFlow id="F1" sourceRef="S1" targetRef="E1" />
  </bpmn:process>
  <bpmn:process id="p2" isExecutable="true">
    <bpmn:startEvent id="S2" />
    <bpmn:endEvent id="E2" />
    <bpmn:sequenceFlow id="F2" sourceRef="S2" targetRef="E2" />
  </bpmn:process>`;

    await expect(xmlToIr(xml)).rejects.toThrow(/multi.process|not supported/i);
  });
});

// ── 6. Bare service task (no discriminator) is refused ──────────────────────

describe('xmlToIr: bare service task', () => {
  const bareServiceTaskXml = (attrs = '') =>
    oneNodeDoc('serviceTask', { id: 'BareSvc', attrs, doc: bpmnDoc });

  it('service task with no execution discriminator raises UnsupportedServiceTaskFormError', async () => {
    await expect(
      xmlToIr(bareServiceTaskXml('name="Bare Service"')),
    ).rejects.toBeInstanceOf(UnsupportedServiceTaskFormError);
  });

  it('the bare service task error mentions "no execution discriminator"', async () => {
    const err = await expectRefusal(
      xmlToIr(bareServiceTaskXml()),
      UnsupportedServiceTaskFormError,
    );
    expect(err.message).toContain('no execution discriminator');
  });

  it('the bare service task error lists the decision reference alongside the code forms', async () => {
    const err = await expectRefusal(
      xmlToIr(bareServiceTaskXml()),
      UnsupportedServiceTaskFormError,
    );
    expect(err.message).toContain(
      'Supported forms are a Java class, an expression, a delegate expression, ' +
        'an external task topic, or, on a business rule task, a decision reference.',
    );
  });
});

// ── 7. DI nodes are dropped from IR ─────────────────────────────────────────

describe('xmlToIr: DI nodes dropped', () => {
  it('bpmndi:*, dc:*, di:* content does not appear in IR flowElements', async () => {
    // The handwritten file has a full <bpmndi:BPMNDiagram> block; none of
    // it should surface in the IR's flowElements array.
    const { ir } = await xmlToIr(HANDWRITTEN_XML);

    const validKinds = new Set([
      'startEvent',
      'endEvent',
      'userTask',
      'serviceTask',
      'exclusiveGateway',
      'parallelGateway',
    ]);
    for (const fe of ir.flowElements) {
      expect(validKinds.has(fe.kind)).toBe(true);
    }
  });

  it('IR flowElements count is exactly 6 (DI shapes are not counted)', async () => {
    // The handwritten file has 6 BPMNShapes inside bpmndi:, so a DI leak would
    // push this past 6.
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    expect(ir.flowElements).toHaveLength(6);
  });
});

// ── 8. incoming/outgoing children are dropped from IR ───────────────────────

describe('xmlToIr: incoming/outgoing children dropped', () => {
  // The IR types declare no `incoming`/`outgoing` fields, so the runtime
  // objects are inspected through an `unknown` cast rather than by narrowing.
  const wiring = (node: object): Record<string, unknown> =>
    node as Record<string, unknown>;

  it('IR SequenceFlow objects have no incoming or outgoing arrays', async () => {
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    for (const flow of ir.sequenceFlows) {
      expect(wiring(flow)['incoming']).toBeUndefined();
      expect(wiring(flow)['outgoing']).toBeUndefined();
    }
  });

  it('IR FlowElement objects have no incoming or outgoing arrays', async () => {
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    for (const node of ir.flowElements) {
      expect(wiring(node)['incoming']).toBeUndefined();
      expect(wiring(node)['outgoing']).toBeUndefined();
    }
  });

  it('sequenceFlows array length matches the number of bpmn:sequenceFlow elements', async () => {
    const { ir } = await xmlToIr(HANDWRITTEN_XML);
    expect(ir.sequenceFlows).toHaveLength(6);
  });
});

// ── 9. Triggers on start, end, and intermediate throw events ────────────────

describe('xmlToIr: start, end, and emit triggers', () => {
  const MESSAGE_ROOT =
    '  <bpmn:message id="Message_1" name="OrderReceived" />\n';
  const SIGNAL_ROOT = '  <bpmn:signal id="Signal_1" name="StockLow" />\n';
  const MESSAGE_DEF =
    '<bpmn:messageEventDefinition id="md" messageRef="Message_1" />';

  interface EventXmlOptions {
    /** Extra attributes on the event's opening tag. */
    attrs?: string;
    /** Root-level declarations before the process. */
    roots?: string;
    /** The `<bpmn:definitions>` wrapper. */
    defs?: typeof bpmnDefs;
  }

  /** `TStart -> E`, where the start carries the given trigger definition. */
  const startTriggerXml = (
    definition: string,
    { attrs = '', roots = '', defs = bpmnDefs }: EventXmlOptions = {},
  ): string =>
    defs`${roots}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="TStart" ${attrs}>
      ${definition}
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="TStart" targetRef="E" />
  </bpmn:process>`;

  /** `S -> Typed`, where the end carries the given definition. */
  const endTriggerXml = (
    definition: string,
    { attrs = '', roots = '', defs = bpmnDefs }: EventXmlOptions = {},
  ): string =>
    defs`${roots}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="Typed" ${attrs}>
      ${definition}
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Typed" />
  </bpmn:process>`;

  /** `S -> Emit1 -> E`, where the throw carries the given definition. */
  const emitXml = (
    definition: string,
    { attrs = '', roots = '', defs = bpmnDefs }: EventXmlOptions = {},
  ): string =>
    defs`${roots}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateThrowEvent id="Emit1" ${attrs}>
      ${definition}
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Emit1" />
    <bpmn:sequenceFlow id="F2" sourceRef="Emit1" targetRef="E" />
  </bpmn:process>`;

  describe('a start carries message, signal, or timer', () => {
    it.each([
      ['timeDuration', 'PT1H', 'duration'],
      ['timeDate', '2026-08-01T09:00:00Z', 'date'],
      ['timeCycle', 'R/PT10M', 'cycle'],
    ] as const)(
      'a %s timer start imports as that timer kind, verbatim',
      async (child, expression, timerKind) => {
        const { node, warnings } = await importById(
          startTriggerXml(
            `<bpmn:timerEventDefinition id="td">
        <bpmn:${child}>${expression}</bpmn:${child}>
      </bpmn:timerEventDefinition>`,
          ),
          'TStart',
          'startEvent',
        );
        expect(node.eventDefinition).toEqual(timerDef(timerKind, expression));
        expect(warnings).toEqual([]);
      },
    );

    it('a message start imports the name of the message root it references', async () => {
      const { node, warnings } = await importById(
        startTriggerXml(MESSAGE_DEF, { roots: MESSAGE_ROOT }),
        'TStart',
        'startEvent',
      );
      expect(node.eventDefinition).toEqual(messageDef('OrderReceived'));
      expect(warnings).toEqual([]);
    });

    it('a signal start imports the name of the signal root it references', async () => {
      const { node, warnings } = await importById(
        startTriggerXml(
          '<bpmn:signalEventDefinition id="sd" signalRef="Signal_1" />',
          { roots: SIGNAL_ROOT },
        ),
        'TStart',
        'startEvent',
      );
      expect(node.eventDefinition).toEqual(signalDef('StockLow'));
      expect(warnings).toEqual([]);
    });

    it('a triggered start keeps its form fields alongside the trigger', async () => {
      const { node } = await importById(
        startTriggerXml(
          `${MESSAGE_DEF}
      <bpmn:extensionElements>
        <operaton:formData>
          <operaton:formField id="amount" type="long" />
        </operaton:formData>
      </bpmn:extensionElements>`,
          { roots: MESSAGE_ROOT, defs: operatonDefs },
        ),
        'TStart',
        'startEvent',
      );
      expect(node.eventDefinition).toEqual(messageDef('OrderReceived'));
      expect(node.formFields).toEqual([{ id: 'amount', type: 'number' }]);
    });
  });

  describe('a start refuses every other trigger', () => {
    it.each([
      ['errorEventDefinition', 'an error', "Catch it with 'on error'"],
      [
        'escalationEventDefinition',
        'an escalation',
        "Catch it with 'on escalation'",
      ],
      [
        'compensateEventDefinition',
        'compensation',
        "belongs in an 'on compensation' block",
      ],
    ])(
      'a start on %s refuses: Operaton would ignore the trigger',
      async (tag, subject, remedy) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(startTriggerXml(`<bpmn:${tag} id="d" />`)),
          UnsupportedEventFeatureError,
          `a process cannot start on ${subject}; Operaton ignores the ` +
            'trigger and starts the process as if none were written, so ' +
            'importing it would write back a document the engine runs ' +
            'differently from what it says',
        );
        expect(e.elementId).toBe('TStart');
        expect(e.message).toContain(remedy);
        expect(e.message).not.toContain('Event handlers catch one');
      },
    );

    it('a conditional start refuses as an unsupported definition kind', async () => {
      const e = await expectRefusal<UnsupportedEventDefinitionError>(
        xmlToIr(
          startTriggerXml(`<bpmn:conditionalEventDefinition id="cd">
        <bpmn:condition>\${stockLevel &lt; 5}</bpmn:condition>
      </bpmn:conditionalEventDefinition>`),
        ),
        UnsupportedEventDefinitionError,
      );
      expect(e.elementId).toBe('TStart');
      expect(e.eventKind).toBe('start');
      expect(e.definitionType).toBe('bpmn:ConditionalEventDefinition');
    });

    it('a start carrying two event definitions refuses, naming the count', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(
          startTriggerXml(
            `<bpmn:messageEventDefinition id="md" messageRef="Message_1" />
      <bpmn:signalEventDefinition id="sd" signalRef="Signal_1" />`,
            { roots: MESSAGE_ROOT + SIGNAL_ROOT },
          ),
        ),
        UnsupportedEventFeatureError,
        'a start carries 2 event definitions: only a single message, ' +
          'signal, or timer trigger is supported',
      );
      expect(e.elementId).toBe('TStart');
    });

    it('a message start whose message name embeds an expression refuses', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(
          startTriggerXml(MESSAGE_DEF, {
            roots: '  <bpmn:message id="Message_1" name="Order-${type}" />\n',
          }),
        ),
        UnsupportedEventFeatureError,
        'a message start event\'s message name "Order-${type}" is an ' +
          'expression; Operaton rejects an expression there, because a ' +
          'process that has not started yet has no variables to evaluate it ' +
          'against',
      );
      expect(e.elementId).toBe('TStart');
      expect(e.message).toContain('Give the message a fixed name');
      expect(e.message).not.toContain('Event handlers catch one');
    });
  });

  describe('one start per container', () => {
    it('a process with two start events refuses, naming the count', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(bpmnDoc`    <bpmn:startEvent id="S1" />
    <bpmn:startEvent id="S2" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S1" targetRef="E" />`),
        UnsupportedEventFeatureError,
        'it has 2 start events; this tool writes one entry point per ' +
          'process or subprocess, so a second start has nowhere to go',
      );
      expect(e.elementId).toBe('p');
      expect(e.message).toContain('Leave one start');
      expect(e.message).not.toContain('Event handlers catch one');
    });

    it('a plain sub-process with two start events refuses, attributed to it', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="S1" />
      <bpmn:startEvent id="S2" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="S1" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />`),
        UnsupportedEventFeatureError,
        'it has 2 start events; this tool writes one entry point per ' +
          'process or subprocess, so a second start has nowhere to go',
      );
      expect(e.elementId).toBe('Sub');
    });
  });

  describe('an end carries terminate or a thrown message', () => {
    it('a terminate end imports as a terminate and keeps its label', async () => {
      const { node, warnings } = await importById(
        endTriggerXml('<bpmn:terminateEventDefinition id="te" />', {
          attrs: 'name="All Stop"',
        }),
        'Typed',
        'endEvent',
      );
      expect(node.eventDefinition).toEqual({ kind: 'terminate' });
      expect(node.name).toBe('All Stop');
      expect(warnings).toEqual([]);
    });

    it('an unread setting on a terminate definition warns rather than vanishing', async () => {
      const { warnings } = await xmlToIr(
        endTriggerXml(
          '<bpmn:terminateEventDefinition id="te" operaton:asyncBefore="true" />',
          { defs: operatonDefs },
        ),
      );
      expectOneWarning(extensionWarnings(warnings), {
        elementId: 'Typed',
        message: 'asyncBefore',
      });
    });

    it('an undeclared attribute on a terminate definition warns rather than vanishing', async () => {
      const { warnings } = await xmlToIr(
        endTriggerXml('<bpmn:terminateEventDefinition id="te" foo="1" />'),
      );
      expectOneWarning(unmappedWarnings(warnings), {
        elementId: 'Typed',
        message: 'foo',
      });
    });

    it('a message end imports the name of the message root it references', async () => {
      const { node, warnings } = await importById(
        endTriggerXml(MESSAGE_DEF, { roots: MESSAGE_ROOT }),
        'Typed',
        'endEvent',
      );
      expect(node.eventDefinition).toEqual(messageDef('OrderReceived'));
      expect(warnings).toEqual([]);
    });

    it('a genuine label on a message end warns: a throw has no label slot', async () => {
      const { node, warnings } = await importById(
        endTriggerXml(MESSAGE_DEF, {
          attrs: 'name="Tell The Warehouse"',
          roots: MESSAGE_ROOT,
        }),
        'Typed',
        'endEvent',
      );
      expect('name' in node).toBe(false);
      expectOneWarning(
        warnings.filter((w) => w.category === 'label'),
        { elementId: 'Typed', message: 'Tell The Warehouse' },
      );
    });

    it('a message end with no messageRef refuses: nothing names it', async () => {
      await expectRefusal(
        xmlToIr(endTriggerXml('<bpmn:messageEventDefinition id="md" />')),
        UnsupportedEventFeatureError,
        'a message definition must reference a bpmn:Message root with a ' +
          'non-empty name',
      );
    });
  });

  describe('a thrown message carries its send implementation', () => {
    /** The implementation sits on the definition, which is where the engine reads it. */
    const implementedMessageDef = (attrs: string): string =>
      `<bpmn:messageEventDefinition id="md" messageRef="Message_1" ${attrs} />`;

    /** The element form of the same send, under the given prefix. */
    const connectorMessageDef = (prefix: string): string =>
      `<bpmn:messageEventDefinition id="md" messageRef="Message_1">
        <bpmn:extensionElements>
          <${prefix}:connector>
            <${prefix}:connectorId>http-connector</${prefix}:connectorId>
            <${prefix}:inputOutput>
              <${prefix}:inputParameter name="url">http://warehouse</${prefix}:inputParameter>
            </${prefix}:inputOutput>
          </${prefix}:connector>
        </bpmn:extensionElements>
      </bpmn:messageEventDefinition>`;

    it.each([
      ['class="com.example.Send"', classBinding('com.example.Send')],
      [
        'expression="${sender.send(order)}"',
        exprBinding('${sender.send(order)}'),
      ],
      ['delegateExpression="${senderBean}"', delegateBinding('${senderBean}')],
      [
        'type="external" operaton:topic="send-ack"',
        externalBinding('send-ack'),
      ],
    ])(
      'operaton:%s on a message end imports as the binding it names',
      async (attrs, expected) => {
        const { node, warnings } = await importById(
          endTriggerXml(implementedMessageDef(`operaton:${attrs}`), {
            roots: MESSAGE_ROOT,
            defs: operatonDefs,
          }),
          'Typed',
          'endEvent',
        );
        expect(node.binding).toEqual(expected);
        expect(warnings).toEqual([]);
      },
    );

    it('the deprecated camunda: prefix of the same attribute reads alike', async () => {
      const { node, warnings } = await importById(
        endTriggerXml(
          implementedMessageDef('camunda:class="com.example.Send"'),
          { roots: MESSAGE_ROOT, defs: camundaDefs },
        ),
        'Typed',
        'endEvent',
      );
      expect(node.binding).toEqual(classBinding('com.example.Send'));
      expect(warnings).toEqual([]);
    });

    it('a message emit carries the implementation too', async () => {
      const { node, warnings } = await importById(
        emitXml(
          implementedMessageDef('operaton:delegateExpression="${sender}"'),
          { roots: MESSAGE_ROOT, defs: operatonDefs },
        ),
        'Emit1',
        'intermediateThrowEvent',
      );
      expect(node.binding).toEqual(delegateBinding('${sender}'));
      expect(warnings).toEqual([]);
    });

    it('a message end with no implementation imports with no binding at all', async () => {
      const { node } = await importById(
        endTriggerXml(MESSAGE_DEF, { roots: MESSAGE_ROOT }),
        'Typed',
        'endEvent',
      );
      expect('binding' in node).toBe(false);
    });

    it('an external type with no topic refuses: the send names no worker', async () => {
      const e = await expectRefusal<UnsupportedServiceTaskFormError>(
        xmlToIr(
          endTriggerXml(implementedMessageDef('operaton:type="external"'), {
            roots: MESSAGE_ROOT,
            defs: operatonDefs,
          }),
        ),
        UnsupportedServiceTaskFormError,
      );
      expect(e.subject).toBe('Thrown message');
      expect(e.construct).toBe(
        'operaton:type="external" without an operaton:topic',
      );
    });

    it('an external type on the definition outranks a class, which is reported', async () => {
      const { node, warnings } = await importById(
        endTriggerXml(
          implementedMessageDef(
            'operaton:class="com.example.Send" operaton:type="external" operaton:topic="send-ack"',
          ),
          { roots: MESSAGE_ROOT, defs: operatonDefs },
        ),
        'Typed',
        'endEvent',
      );
      expect(node.binding).toEqual(externalBinding('send-ack'));
      expect(warnings.map((w) => w.message)).toEqual([
        "The 'class' setting on 'Typed' has no effect alongside operaton:type=\"external\" and was not imported.",
      ]);
    });

    it('a topic with no external type warns: nothing names the worker', async () => {
      const { node, warnings } = await importById(
        endTriggerXml(implementedMessageDef('operaton:topic="send-ack"'), {
          roots: MESSAGE_ROOT,
          defs: operatonDefs,
        }),
        'Typed',
        'endEvent',
      );
      expect('binding' in node).toBe(false);
      expectOneWarning(extensionWarnings(warnings), {
        elementId: 'Typed',
        message:
          "The 'topic' setting on 'Typed' only takes effect alongside " +
          'operaton:type="external"; on its own it names no external worker ' +
          'and was not imported.',
      });
    });

    it('a connector on the definition refuses: the same send, in element form', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(
          endTriggerXml(connectorMessageDef('operaton'), {
            roots: MESSAGE_ROOT,
            defs: operatonDefs,
          }),
        ),
        UnsupportedEventFeatureError,
        'a thrown message carries a connector; that is what makes the ' +
          'engine really send it, and this surface has no place to keep it',
      );
      expect(e.elementId).toBe('Typed');
    });

    it('the deprecated camunda: prefix of the connector refuses alike, on an emit', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(
          emitXml(connectorMessageDef('camunda'), {
            roots: MESSAGE_ROOT,
            defs: camundaDefs,
          }),
        ),
        UnsupportedEventFeatureError,
        'a thrown message carries a connector; that is what makes the ' +
          'engine really send it, and this surface has no place to keep it',
      );
      expect(e.elementId).toBe('Emit1');
    });

    it('the same setting on the event itself warns: the engine reads it off the definition', async () => {
      const { node, warnings } = await importById(
        endTriggerXml(MESSAGE_DEF, {
          attrs: 'operaton:class="com.example.Send"',
          roots: MESSAGE_ROOT,
          defs: operatonDefs,
        }),
        'Typed',
        'endEvent',
      );
      expect('binding' in node).toBe(false);
      expectOneWarning(extensionWarnings(warnings), {
        elementId: 'Typed',
        message: "The 'operaton:class' setting on 'Typed' was not imported",
      });
    });

    it('an implementation on a caught message warns: only a throw sends one', async () => {
      const { warnings } = await xmlToIr(
        startTriggerXml(
          implementedMessageDef('operaton:class="com.example.Send"'),
          { roots: MESSAGE_ROOT, defs: operatonDefs },
        ),
      );
      expectOneWarning(extensionWarnings(warnings), {
        elementId: 'TStart',
        message: "The 'class' setting on 'TStart' only takes effect on a throw",
      });
    });

    it('a connector on a signal end still warns, attributed to the event itself', async () => {
      const { warnings } = await xmlToIr(
        endTriggerXml(
          `<bpmn:extensionElements>
        <operaton:connector>
          <operaton:connectorId>http-connector</operaton:connectorId>
        </operaton:connector>
      </bpmn:extensionElements>
      <bpmn:signalEventDefinition id="sd" signalRef="Signal_1" />`,
          { roots: SIGNAL_ROOT, defs: operatonDefs },
        ),
      );
      expectOneWarning(extensionWarnings(warnings), {
        elementId: 'Typed',
        message: 'operaton:Connector',
      });
    });
  });

  describe('a name that starts with an expression refuses everywhere', () => {
    const EXPR_MESSAGE_ROOT =
      '  <bpmn:message id="Message_1" name="${orderType}" />\n';
    const EXPR_SIGNAL_ROOT =
      '  <bpmn:signal id="Signal_1" name="${topic}" />\n';
    const SIGNAL_DEF =
      '<bpmn:signalEventDefinition id="sd" signalRef="Signal_1" />';

    /** The whole refusal an expression-leading message name draws. */
    const MESSAGE_EXPR_DETAIL =
      'a message name that starts with an expression ("${orderType}") ' +
      'cannot be written back: this tool writes the name in quotes, and a ' +
      'quoted name opening with "${" reads as an expression rather than as ' +
      "a name; give the message a fixed name, which the process's own start " +
      'needs in any case; anywhere else the same expression reads back ' +
      'written as "#{...}"';

    /** The same for a signal, whose remedy has no process-start exception. */
    const SIGNAL_EXPR_DETAIL =
      'a signal name that starts with an expression ("${topic}") cannot be ' +
      'written back: this tool writes the name in quotes, and a quoted ' +
      'name opening with "${" reads as an expression rather than as a name; ' +
      'give the signal a fixed name, or write the same expression as ' +
      '"#{...}"';

    it.each([
      [
        'a message end',
        endTriggerXml(MESSAGE_DEF, { roots: EXPR_MESSAGE_ROOT }),
        'Typed',
        MESSAGE_EXPR_DETAIL,
      ],
      [
        'a message emit',
        emitXml(MESSAGE_DEF, { roots: EXPR_MESSAGE_ROOT }),
        'Emit1',
        MESSAGE_EXPR_DETAIL,
      ],
      [
        'a signal end',
        endTriggerXml(SIGNAL_DEF, { roots: EXPR_SIGNAL_ROOT }),
        'Typed',
        SIGNAL_EXPR_DETAIL,
      ],
      [
        'a message start',
        startTriggerXml(MESSAGE_DEF, { roots: EXPR_MESSAGE_ROOT }),
        'TStart',
        MESSAGE_EXPR_DETAIL,
      ],
      [
        'a message handler start',
        handlerDoc(MESSAGE_DEF, { roots: EXPR_MESSAGE_ROOT, body: '' }),
        'HStart',
        MESSAGE_EXPR_DETAIL,
      ],
    ])(
      '%s refuses: the name would not read back as a name',
      async (_case, xml, elementId, detail) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
          detail,
        );
        expect(e.elementId).toBe(elementId);
      },
    );

    it('the "#{...}" remedy is offered to a message with the process start excepted, since a process start refuses an expression outright', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(startTriggerXml(MESSAGE_DEF, { roots: EXPR_MESSAGE_ROOT })),
        UnsupportedEventFeatureError,
        MESSAGE_EXPR_DETAIL,
      );
      expect(e.elementId).toBe('TStart');
    });

    it('a message handler start named "${orderType}" is refused with the same remedy: a handler start is not the process\'s own start', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(handlerDoc(MESSAGE_DEF, { roots: EXPR_MESSAGE_ROOT })),
        UnsupportedEventFeatureError,
        MESSAGE_EXPR_DETAIL,
      );
      expect(e.elementId).toBe('HStart');
    });

    it('a message handler start named with the "#{...}" spelling imports: the remedy applies there', async () => {
      const { ir, warnings } = await xmlToIr(
        handlerDoc(MESSAGE_DEF, {
          roots: '  <bpmn:message id="Message_1" name="#{orderType}" />\n',
        }),
      );
      expect(warnings).toEqual([]);
      const start = byId(subProcess(ir, 'Handler'), 'HStart');
      expect(start.kind === 'startEvent' && start.eventDefinition).toEqual(
        messageDef('#{orderType}'),
      );
    });

    it('the "#{...}" remedy is offered to a signal unqualified: a signal start takes an expression name', async () => {
      await expectRefusal(
        xmlToIr(startTriggerXml(SIGNAL_DEF, { roots: EXPR_SIGNAL_ROOT })),
        UnsupportedEventFeatureError,
        SIGNAL_EXPR_DETAIL,
      );
    });

    it('a signal start named with the "#{...}" spelling imports', async () => {
      const { node } = await importById(
        startTriggerXml(SIGNAL_DEF, {
          roots: '  <bpmn:signal id="Signal_1" name="#{topic}" />\n',
        }),
        'TStart',
        'startEvent',
      );
      expect(node.eventDefinition).toEqual({
        kind: 'signal',
        signalName: '#{topic}',
      });
    });

    it.each(['Order-${orderType}', '#{orderType}'])(
      'a message end named %s imports: it reads back as the name it is',
      async (name) => {
        const { node, warnings } = await importById(
          endTriggerXml(MESSAGE_DEF, {
            roots: `  <bpmn:message id="Message_1" name="${name}" />\n`,
          }),
          'Typed',
          'endEvent',
        );
        expect(node.eventDefinition).toEqual(messageDef(name));
        expect(warnings).toEqual([]);
      },
    );
  });

  it('a message emit imports the name of the message root it references', async () => {
    const { node, warnings } = await importById(
      emitXml(MESSAGE_DEF, { roots: MESSAGE_ROOT }),
      'Emit1',
      'intermediateThrowEvent',
    );
    expect(node.eventDefinition).toEqual(messageDef('OrderReceived'));
    expect(warnings).toEqual([]);
  });

  it.each(['startEvent', 'endEvent'] as const)(
    'a plain %s (empty/absent eventDefinitions) is NOT refused',
    async (kind) => {
      const xml = bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`;
      const { ir, warnings } = await xmlToIr(xml);
      expect(ir.flowElements.some((fe) => fe.kind === kind)).toBe(true);
      expect(warnings).toEqual([]);
    },
  );
});

// ── 9b. Repetition: multi-instance loop characteristics ─────────────────────

describe('xmlToIr: imports a repetition', () => {
  /** `<bpmn:multiInstanceLoopCharacteristics>` with the given attributes and children. */
  const repeat = (attrs = '', children = ''): string =>
    `<bpmn:multiInstanceLoopCharacteristics ${attrs}>${children}</bpmn:multiInstanceLoopCharacteristics>`;

  /** `S -> userTask -> E` where the task repeats. */
  const repeatedTaskDoc = (attrs = '', children = ''): string =>
    oneNodeDoc('userTask', { children: repeat(attrs, children) });

  /** Every tag that can repeat, and the IR kind it imports as. */
  const REPEATABLE_TAGS = [
    ['userTask', 'userTask', ''],
    ['task', 'task', ''],
    ['serviceTask', 'serviceTask', 'operaton:class="com.example.Svc"'],
    ['sendTask', 'serviceTask', 'operaton:class="com.example.Send"'],
    ['businessRuleTask', 'serviceTask', 'operaton:decisionRef="riskRating"'],
    ['receiveTask', 'receiveTask', ''],
    ['scriptTask', 'scriptTask', 'scriptFormat="groovy"'],
    ['subProcess', 'subProcess', ''],
    ['callActivity', 'callActivity', 'calledElement="sub-process"'],
  ] as const;

  it.each(REPEATABLE_TAGS)(
    'bpmn:%s imports its repetition, reporting nothing as dropped',
    async (tag, kind, attrs) => {
      const { node, warnings } = await importOnly(
        oneNodeDoc(tag, {
          attrs,
          children: repeat(
            'operaton:collection="lines" operaton:elementVariable="line"',
          ),
        }),
        kind,
      );
      expect(node.loop).toEqual({
        collection: 'lines',
        elementVariable: 'line',
      });
      expect(warnings).toEqual([]);
    },
  );

  it.each([
    ['isSequential="true"', { sequential: true }],
    ['isSequential="false"', {}],
    ['', {}],
  ])(
    '%s imports the runs as sequential only when true',
    async (attr, extra) => {
      const { node } = await importOnly(
        repeatedTaskDoc(`operaton:collection="lines" ${attr}`),
        'userTask',
      );
      expect(node.loop).toEqual({ collection: 'lines', ...extra });
    },
  );

  it.each([
    ['3', 0],
    ['${lineCount}', 0],
    // The rewrap this one is reported for is pinned by its own suite.
    ['#{lineCount}', 1],
  ] as const)(
    'a bpmn:loopCardinality of %s alone imports as the count',
    async (body, warned) => {
      const { node, warnings } = await importOnly(
        repeatedTaskDoc(
          '',
          `<bpmn:loopCardinality>${body}</bpmn:loopCardinality>`,
        ),
        'userTask',
      );
      expect(node.loop).toEqual({ cardinality: body });
      expect(warnings).toHaveLength(warned);
    },
  );

  it('a count, a collection and a completion condition import together', async () => {
    const { node, warnings } = await importOnly(
      repeatedTaskDoc(
        'operaton:collection="${order.lines}" operaton:elementVariable="line" isSequential="true"',
        `<bpmn:loopCardinality>3</bpmn:loopCardinality>
        <bpmn:completionCondition>\${nrOfCompletedInstances >= 2}</bpmn:completionCondition>`,
      ),
      'userTask',
    );
    expect(node.loop).toEqual({
      cardinality: '3',
      collection: '${order.lines}',
      elementVariable: 'line',
      completionCondition: '${nrOfCompletedInstances >= 2}',
      sequential: true,
    });
    expect(warnings).toEqual([]);
  });

  it('a bpmn:loopDataInputRef naming a process variable imports as the collection', async () => {
    const { node, warnings } = await importOnly(
      repeatedTaskDoc(
        '',
        `<bpmn:loopDataInputRef>assigneeList</bpmn:loopDataInputRef>
        <bpmn:inputDataItem name="assignee" />`,
      ),
      'userTask',
    );
    expect(node.loop).toEqual({
      collection: 'assigneeList',
      elementVariable: 'assignee',
    });
    expect(warnings).toEqual([]);
  });

  // A reference naming an element in the document resolves, and moddle answers
  // with that element; the fixture declares one so both paths stay covered.
  const dataDoc = (attrs: string, children: string): string =>
    oneNodeDoc('userTask', {
      children: `<bpmn:property id="lines" name="lines" />${repeat(attrs, children)}`,
    });

  it('a bpmn:loopDataInputRef imports as the collection', async () => {
    const { node } = await importById(
      dataDoc('', '<bpmn:loopDataInputRef>lines</bpmn:loopDataInputRef>'),
      'T',
      'userTask',
    );
    expect(node.loop).toEqual({ collection: 'lines' });
  });

  it('a bpmn:loopDataInputRef shadows operaton:collection, and the drop is reported', async () => {
    const { node, warnings } = await importById(
      dataDoc(
        'operaton:collection="items"',
        '<bpmn:loopDataInputRef>lines</bpmn:loopDataInputRef>',
      ),
      'T',
      'userTask',
    );
    expect(node.loop).toEqual({ collection: 'lines' });
    expect(warnings.map((w) => w.message)).toContainEqual(
      expect.stringContaining(
        "Both bpmn:loopDataInputRef and operaton:collection name the collection on 'T'; " +
          "Operaton reads bpmn:loopDataInputRef second, so 'lines' was imported and 'items' was dropped.",
      ),
    );
  });

  // Every shape the grammar's ID terminal takes, the hyphen form included: the
  // refusal beside it must not narrow what the clause can already write.
  it.each(['line', '_line', 'l1', 'line-item'])(
    'an element variable spelled %s imports as written',
    async (name) => {
      const { node, warnings } = await importOnly(
        repeatedTaskDoc(
          `operaton:collection="lines" operaton:elementVariable="${name}"`,
        ),
        'userTask',
      );
      expect(node.loop).toEqual({
        collection: 'lines',
        elementVariable: name,
      });
      expect(warnings).toEqual([]);
    },
  );

  it('a bpmn:inputDataItem name imports as the element variable', async () => {
    const { node, warnings } = await importOnly(
      repeatedTaskDoc(
        'operaton:collection="lines"',
        '<bpmn:inputDataItem id="Item" name="line" />',
      ),
      'userTask',
    );
    expect(node.loop).toEqual({ collection: 'lines', elementVariable: 'line' });
    expect(warnings).toEqual([]);
  });

  it('a bpmn:inputDataItem shadows operaton:elementVariable, and the drop is reported', async () => {
    const { node, warnings } = await importOnly(
      repeatedTaskDoc(
        'operaton:collection="lines" operaton:elementVariable="item"',
        '<bpmn:inputDataItem id="Item" name="line" />',
      ),
      'userTask',
    );
    expect(node.loop).toEqual({ collection: 'lines', elementVariable: 'line' });
    expectOneWarning(warnings, {
      elementId: 'T',
      category: 'extensionAttribute',
      message:
        "Both bpmn:inputDataItem and operaton:elementVariable name what each run sees on 'T'; " +
        "Operaton reads bpmn:inputDataItem second, so 'line' was imported and 'item' was dropped.",
    });
  });

  const IO_BLOCK = extensionElements(
    `        <operaton:inputOutput>
          <operaton:outputParameter name="result">ok</operaton:outputParameter>
        </operaton:inputOutput>`,
  );

  const countRefusalDetail = (body: string): string =>
    `its bpmn:loopCardinality is "${body}", which this tool cannot write back out unchanged; it ` +
    'writes a count as a plain whole number or as an expression, and this body is neither';

  const perRunJobDetail = (setting: string): string =>
    `it carries 'operaton:${setting}' on the repetition itself, which gives every run a job of ` +
    'its own; the same setting on the step makes one job around the whole repetition, and this ' +
    "tool's surface can only say the second";

  const elementNameRefusalDetail = (name: string): string =>
    `it names ${JSON.stringify(name)} for each run to see, which this tool cannot write back ` +
    'out unchanged; it writes that name as a plain identifier, and this name is not one';

  it.each([
    [
      'neither a count nor a collection',
      repeatedTaskDoc(),
      'it sets neither a number of runs nor a collection to run over, and Operaton refuses to deploy that',
    ],
    [
      'an empty bpmn:loopCardinality',
      repeatedTaskDoc('', '<bpmn:loopCardinality />'),
      'its bpmn:loopCardinality is empty, so Operaton has no number of runs to read',
    ],
    [
      'a bpmn:loopCardinality that is neither a whole number nor an expression',
      repeatedTaskDoc(
        '',
        '<bpmn:loopCardinality>order.lines</bpmn:loopCardinality>',
      ),
      countRefusalDetail('order.lines'),
    ],
    [
      'a fractional bpmn:loopCardinality',
      repeatedTaskDoc('', '<bpmn:loopCardinality>3.5</bpmn:loopCardinality>'),
      countRefusalDetail('3.5'),
    ],
    [
      'a negative bpmn:loopCardinality',
      repeatedTaskDoc('', '<bpmn:loopCardinality>-1</bpmn:loopCardinality>'),
      countRefusalDetail('-1'),
    ],
    [
      'a bpmn:loopCardinality carrying a leading plus',
      repeatedTaskDoc('', '<bpmn:loopCardinality>+3</bpmn:loopCardinality>'),
      countRefusalDetail('+3'),
    ],
    [
      'an element variable with no collection',
      repeatedTaskDoc(
        'operaton:elementVariable="line"',
        '<bpmn:loopCardinality>3</bpmn:loopCardinality>',
      ),
      "it names 'line' for each run to see but no collection to take it from, and Operaton refuses to deploy that",
    ],
    [
      'operaton:asyncBefore on the repetition itself',
      repeatedTaskDoc(
        'operaton:collection="lines" operaton:asyncBefore="true"',
      ),
      perRunJobDetail('asyncBefore'),
    ],
    [
      'operaton:asyncAfter on the repetition itself',
      repeatedTaskDoc('operaton:collection="lines" operaton:asyncAfter="true"'),
      perRunJobDetail('asyncAfter'),
    ],
    [
      'operaton:exclusive on the repetition itself',
      repeatedTaskDoc('operaton:collection="lines" operaton:exclusive="true"'),
      perRunJobDetail('exclusive'),
    ],
    [
      'an operaton:failedJobRetryTimeCycle on the repetition itself',
      repeatedTaskDoc(
        'operaton:collection="lines"',
        extensionElements(
          '        <operaton:failedJobRetryTimeCycle>R3/PT1M</operaton:failedJobRetryTimeCycle>',
        ),
      ),
      perRunJobDetail('failedJobRetryTimeCycle'),
    ],
    [
      'an operaton:elementVariable outside the identifier the clause writes',
      repeatedTaskDoc(
        'operaton:collection="lines" operaton:elementVariable="größe"',
      ),
      elementNameRefusalDetail('größe'),
    ],
    [
      'a bpmn:inputDataItem name outside the identifier the clause writes',
      repeatedTaskDoc(
        'operaton:collection="lines"',
        '<bpmn:inputDataItem id="Item" name="my var" />',
      ),
      elementNameRefusalDetail('my var'),
    ],
    [
      'an operaton:outputParameter on a repeated step',
      oneNodeDoc('userTask', {
        children: `${IO_BLOCK}${repeat('operaton:collection="lines"')}`,
      }),
      "it maps an 'operaton:outputParameter', which Operaton refuses to deploy on a repeated step",
    ],
  ])('%s is refused', async (_title, xml, detail) => {
    const e = await expectRefusal<UnsupportedLoopCharacteristicsError>(
      xmlToIr(xml),
      UnsupportedLoopCharacteristicsError,
      detail,
    );
    expect(e.elementId).toBe('T');
    expect(e.loopType).toBe('bpmn:MultiInstanceLoopCharacteristics');
    expect(e.message).toBe(
      `The repetition on 'T' cannot be imported: ${detail}.`,
    );
  });

  it('bpmn:standardLoopCharacteristics is refused, naming that Operaton runs the step once', async () => {
    const e = await expectRefusal<UnsupportedLoopCharacteristicsError>(
      xmlToIr(
        oneNodeDoc('serviceTask', {
          id: 'RepeatSvc',
          attrs: 'operaton:class="com.example.Svc"',
          children: '<bpmn:standardLoopCharacteristics />',
        }),
      ),
      UnsupportedConstructError,
      'Operaton does not run a bpmn:standardLoopCharacteristics at all: it deploys the step and ' +
        'runs it once, so importing this would hand back a script saying the step repeats when it ' +
        'does not',
    );
    expect(e.elementId).toBe('RepeatSvc');
    expect(e.loopType).toBe('bpmn:StandardLoopCharacteristics');
  });

  it('an event handler carrying a repetition is refused', async () => {
    await expectRefusal<UnsupportedLoopCharacteristicsError>(
      xmlToIr(
        handlerDoc('<bpmn:signalEventDefinition id="SigDef" />', {
          startAttrs: 'name="Escalate"',
        }).replace(
          '<bpmn:subProcess id="Handler" triggeredByEvent="true">',
          '<bpmn:subProcess id="Handler" triggeredByEvent="true">\n      ' +
            repeat('', '<bpmn:loopCardinality>2</bpmn:loopCardinality>'),
        ),
      ),
      UnsupportedLoopCharacteristicsError,
      'an event handler is entered by its trigger, so it cannot be repeated',
    );
  });

  it.each([
    [
      'a bpmn:loopDataOutputRef',
      '',
      '<bpmn:loopDataOutputRef>results</bpmn:loopDataOutputRef>',
      'The bpmn:loopDataOutputRef on the repetition',
    ],
    [
      'a bpmn:loopDataOutputRef naming an element in the document',
      '',
      '<bpmn:loopDataOutputRef>S</bpmn:loopDataOutputRef>',
      'The bpmn:loopDataOutputRef on the repetition',
    ],
    [
      'a bpmn:outputDataItem',
      '',
      '<bpmn:outputDataItem id="Item" name="result" />',
      "A bpmn:outputDataItem 'Item' on 'T' was not imported",
    ],
    [
      'a bpmn:complexBehaviorDefinition',
      '',
      '<bpmn:complexBehaviorDefinition id="CBD" />',
      "A bpmn:complexBehaviorDefinition 'CBD' on 'T' was not imported",
    ],
    [
      'behavior="One"',
      'behavior="One"',
      '',
      'The behavior="One" on the repetition',
    ],
    [
      'a oneBehaviorEventRef',
      'oneBehaviorEventRef="throwIt"',
      '',
      'The bpmn:oneBehaviorEventRef on the repetition',
    ],
    [
      'a noneBehaviorEventRef',
      'noneBehaviorEventRef="skipIt"',
      '',
      'The bpmn:noneBehaviorEventRef on the repetition',
    ],
    [
      'an operaton:jobPriority',
      'operaton:jobPriority="10"',
      '',
      "The operaton:jobPriority on the repetition of 'T' was not imported: " +
        'Operaton does not read it, so the imported process runs the same.',
    ],
    [
      'an attribute BPMN does not declare',
      'bogus="x"',
      '',
      "The 'bogus' attribute on 'T' is not declared by BPMN",
    ],
  ])(
    '%s on the repetition is reported as dropped',
    async (_title, attrs, children, message) => {
      const { warnings } = await importOnly(
        repeatedTaskDoc(`operaton:collection="lines" ${attrs}`, children),
        'userTask',
      );
      expectOneWarning(warnings, {
        elementId: 'T',
        category: 'unmappedConstruct',
        message,
      });
    },
  );
});

// ── 9b'. An expression body written with the other delimiter ────────────────

describe('xmlToIr: a #{...} expression body is rewrapped, and says so', () => {
  const loopDoc = (children: string): string =>
    oneNodeDoc('userTask', {
      children: `<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines">${children}</bpmn:multiInstanceLoopCharacteristics>`,
    });

  const rewrapped = (slot: string, id: string): string =>
    `The ${slot} on '${id}' is written with "#{...}", which this surface has ` +
    'no form for: its text is written back inside "${...}", which Operaton ' +
    'evaluates identically.';

  it.each([
    [
      'a loop cardinality',
      loopDoc('<bpmn:loopCardinality>#{lineCount}</bpmn:loopCardinality>'),
      rewrapped('bpmn:loopCardinality', 'T'),
    ],
    [
      'a completion condition',
      loopDoc('<bpmn:completionCondition>#{done}</bpmn:completionCondition>'),
      rewrapped('bpmn:completionCondition', 'T'),
    ],
    [
      'a sequence flow condition',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:exclusiveGateway id="X" />
    <bpmn:userTask id="T" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="X" />
    <bpmn:sequenceFlow id="F2" sourceRef="X" targetRef="T">
      <bpmn:conditionExpression>#{amount &gt; 1000}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F3" sourceRef="X" targetRef="E" />
    <bpmn:sequenceFlow id="F4" sourceRef="T" targetRef="E" />`,
      rewrapped('bpmn:conditionExpression', 'F2'),
    ],
    [
      'a conditional trigger',
      oneNodeDoc('intermediateCatchEvent', {
        children: `<bpmn:conditionalEventDefinition id="cd">
        <bpmn:condition>#{stock &lt; 5}</bpmn:condition>
      </bpmn:conditionalEventDefinition>`,
        doc: bpmnDoc,
      }),
      rewrapped('bpmn:condition', 'T'),
    ],
  ] as const)('%s reports the rewrap', async (_title, xml, message) => {
    const { warnings } = await xmlToIr(xml);
    expect(warnings.map((w) => w.message)).toEqual([message]);
    expect(warnings.map((w) => w.category)).toEqual(['unmappedConstruct']);
  });

  // Only a leading `#{` is rewritten: a `#{` later in the body leaves the
  // parse outside the subset, and the raw path returns it character for
  // character. Widening the test to `contains` reports a body nothing changed.
  it.each(['${lineCount}', '${a} #{b}'])(
    'a body opening with ${ imports verbatim and reports nothing: %s',
    async (body) => {
      const { node, warnings } = await importOnly(
        loopDoc(`<bpmn:loopCardinality>${body}</bpmn:loopCardinality>`),
        'userTask',
      );
      expect(node.loop).toEqual({ collection: 'lines', cardinality: body });
      expect(warnings).toEqual([]);
    },
  );
});

// ── 9c. Refusals: collaboration (pools / message flows) ─────────────────────

describe('xmlToIr: refuses collaborations (pools / message flows)', () => {
  const collaborationXml = bpmnDefs`  <bpmn:collaboration id="Collab">
    <bpmn:participant id="Pool1" name="Sales" processRef="p" />
    <bpmn:participant id="Pool2" name="Customer" />
  </bpmn:collaboration>
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

  it('a document containing a bpmn:Collaboration throws UnsupportedCollaborationError', async () => {
    await expect(xmlToIr(collaborationXml)).rejects.toBeInstanceOf(
      UnsupportedCollaborationError,
    );
  });

  it('the collaboration refusal extends UnsupportedConstructError', async () => {
    const err = await expectRefusal<UnsupportedCollaborationError>(
      xmlToIr(collaborationXml),
      UnsupportedConstructError,
    );
    expect(err.message.length).toBeGreaterThan(0);
  });
});

// ── 10. Warnings: dropped extension attributes and lanes ────────────────────

describe('xmlToIr: warns for dropped extension attributes', () => {
  const formRefXml = oneNodeDoc('userTask', {
    id: 'FormRefTask',
    attrs:
      'name="Form Ref Task" operaton:assignee="alice" operaton:formRef="review-form"',
  });

  it('surfaces one warning naming operaton:formRef and the owning element id', async () => {
    const { node, warnings } = await importOnly(formRefXml, 'userTask');
    // The supported assignee attribute is still read into the IR.
    expect(node.assignee).toBe('alice');

    const attrWarnings = extensionWarnings(warnings);
    expect(attrWarnings.length).toBeGreaterThanOrEqual(1);
    const w = attrWarnings.find((w) => w.message.includes('formRef'));
    expect(w).toBeDefined();
    expect(w?.elementId).toBe('FormRefTask');
  });

  it('does NOT warn for the supported assignee/formKey/class attributes', async () => {
    const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T" name="T" operaton:assignee="alice" operaton:formKey="form:x" />
    <bpmn:serviceTask id="Svc" operaton:class="com.example.Svc" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="Svc" />
    <bpmn:sequenceFlow id="F3" sourceRef="Svc" targetRef="E" />`;
    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
  });

  it('also warns for the deprecated camunda: prefix (dual-namespace)', async () => {
    const { warnings } = await xmlToIr(
      oneNodeDoc('userTask', {
        attrs: 'name="T" camunda:formRef="review-form"',
        doc: camundaDoc,
      }),
    );
    const w = warnings.find((w) => w.message.includes('formRef'));
    expect(w).toBeDefined();
    expect(w?.category).toBe('extensionAttribute');
    expect(w?.elementId).toBe('T');
  });

  // `historyTimeToLive` is declared in the moddle extension, so it parses
  // into a typed property (not `$attrs`) and needs the descriptor scan.
  const httlXml = (
    value: string,
  ): string => operatonDefs`  <bpmn:process id="p" isExecutable="true" operaton:historyTimeToLive="${value}">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

  it('warns when a custom operaton:historyTimeToLive would be lost', async () => {
    const { warnings } = await xmlToIr(httlXml('P90D'));
    const httlWarnings = warnings.filter((w) =>
      w.message.includes('operaton:historyTimeToLive'),
    );
    expect(httlWarnings).toHaveLength(1);
    expect(httlWarnings[0].category).toBe('extensionAttribute');
    expect(httlWarnings[0].elementId).toBe('p');
  });

  it('stays silent for the value the exporter re-stamps (P30D)', async () => {
    const { warnings } = await xmlToIr(httlXml('P30D'));
    expect(warnings).toEqual([]);
  });
});

describe('xmlToIr: warns for dropped lanes', () => {
  const lanesXml = bpmnDoc`    <bpmn:laneSet id="LS1">
      <bpmn:lane id="Lane_Sales" name="Sales">
        <bpmn:flowNodeRef>S</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Support" name="Support">
        <bpmn:flowNodeRef>E</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`;

  it('surfaces one lane warning per lane, naming the lane and its element id', async () => {
    const { warnings } = await xmlToIr(lanesXml);
    const laneWarnings = warnings.filter(
      (w: ImportWarning) => w.category === 'lane',
    );
    expect(laneWarnings).toHaveLength(2);

    const sales = laneWarnings.find((w) => w.elementId === 'Lane_Sales');
    expect(sales).toBeDefined();
    expect(sales?.message).toContain('Sales');

    const support = laneWarnings.find((w) => w.elementId === 'Lane_Support');
    expect(support).toBeDefined();
  });

  it('still imports the process body when lanes are present', async () => {
    const { ir } = await xmlToIr(lanesXml);
    expect(ir.flowElements.some((fe) => fe.kind === 'startEvent')).toBe(true);
    expect(ir.flowElements.some((fe) => fe.kind === 'endEvent')).toBe(true);
  });

  it('names a lane nested in a childLaneSet as well as the lane holding it', async () => {
    const xml = bpmnDoc`    <bpmn:laneSet id="LS1">
      <bpmn:lane id="Lane_Outer" name="Operations">
        <bpmn:childLaneSet id="LS2">
          <bpmn:lane id="Lane_Inner" name="Dispatch" />
        </bpmn:childLaneSet>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`;

    const { warnings } = await xmlToIr(xml);
    const laneWarnings = warnings.filter(
      (w: ImportWarning) => w.category === 'lane',
    );
    expect(laneWarnings.map((w) => w.elementId)).toEqual([
      'Lane_Outer',
      'Lane_Inner',
    ]);
    expect(laneWarnings[1].message).toContain('Dispatch');
  });
});

// ── 11. Warnings: dropped extension elements ────────────────────────────────

describe('xmlToIr: warns for dropped extension elements', () => {
  // `operaton:properties` is in the registered namespace but undeclared, so a
  // task carrying one keeps its drop attributable only through the residual
  // path; `operaton:field` is declared, materializes against its owning
  // element, and is genuinely not carried, which is what a per-element
  // extension-element drop looks like.
  const droppingSvcXml = oneNodeDoc('serviceTask', {
    id: 'ConfiguredSvc',
    attrs: 'operaton:class="com.example.Svc"',
    children: extensionElements(
      '        <operaton:field name="greeting" stringValue="hello" />',
    ),
  });

  it('warns (owner id) when a task carries engine-specific extension elements', async () => {
    const { warnings } = await xmlToIr(droppingSvcXml);
    const w = extensionWarnings(warnings).find(
      (w) => w.elementId === 'ConfiguredSvc',
    );
    expect(w).toBeDefined();
  });

  it('names the concrete dropped construct in the warning message', async () => {
    const { warnings } = await xmlToIr(droppingSvcXml);
    const w = warnings.find((w) => w.elementId === 'ConfiguredSvc');
    expect(w?.message).toContain("'greeting'");
  });
});

// ── 11b. Regression: a clean empty <extensionElements/> is not flagged
// when another element in the same document carries a real drop. ────────────

describe('xmlToIr: empty extensionElements is not flagged (regression)', () => {
  /**
   * One document, two elements: a user task with a genuinely empty
   * `<bpmn:extensionElements/>` (a stray stub modelers leave behind) and a
   * service task with a real `<operaton:field>`. A single document-level
   * "unparsable content" boolean cannot tell the two apart and would flag
   * both; typing the operaton extension elements makes the drop attributable
   * to the exact owning element, so exactly one warning must fire, on the
   * element that really drops content.
   */
  const twoElementXml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="CleanTask" name="Clean Task" operaton:assignee="alice">
      <bpmn:extensionElements/>
    </bpmn:userTask>
    <bpmn:serviceTask id="ConfiguredSvc" operaton:class="com.example.Svc">
      <bpmn:extensionElements>
        <operaton:field name="greeting" stringValue="hello" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CleanTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="CleanTask" targetRef="ConfiguredSvc" />
    <bpmn:sequenceFlow id="F3" sourceRef="ConfiguredSvc" targetRef="E" />`;

  it('emits exactly one extension warning, attributed to the real element only', async () => {
    const { warnings } = await xmlToIr(twoElementXml);
    const extWarnings = extensionWarnings(warnings);
    expect(extWarnings).toHaveLength(1);
    expect(extWarnings[0].elementId).toBe('ConfiguredSvc');
  });

  it('does not attribute any warning to the element with an empty extensionElements', async () => {
    const { warnings } = await xmlToIr(twoElementXml);
    expect(warnings.some((w) => w.elementId === 'CleanTask')).toBe(false);
  });

  it('still reads the supported assignee off the clean task', async () => {
    const { ir } = await xmlToIr(twoElementXml);
    const clean = byId(ir, 'CleanTask');
    expect(clean.kind === 'userTask' && clean.assignee).toBe('alice');
  });
});

// ── 11c. Foreign-namespace (camunda:) extension elements are attributed
// precisely per element (moddle keeps them as generic values). ──────────────

describe('xmlToIr: foreign-namespace extension elements are per-element', () => {
  it('names a camunda: extension element against its owning task', async () => {
    const xml = oneNodeDoc('serviceTask', {
      id: 'CamSvc',
      // The class keeps a supported form, so mapping does not refuse first.
      attrs: 'name="Cam Svc" camunda:class="com.example.Svc"',
      children: extensionElements(`        <camunda:connector>
          <camunda:connectorId>http-connector</camunda:connectorId>
        </camunda:connector>`),
      doc: camundaDoc,
    });
    const { warnings } = await xmlToIr(xml);
    const w = warnings.find((w) => w.elementId === 'CamSvc');
    expect(w).toBeDefined();
    expect(w?.category).toBe('extensionAttribute');
  });
});

// ── 11d. Undeclared operaton:* extension elements are reported once, not lost
// and not fanned out across clean elements. ─────────────────────────────────

describe('xmlToIr: undeclared operaton extension element residual', () => {
  const residualXml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="CleanTask" name="Clean Task">
      <bpmn:extensionElements/>
    </bpmn:userTask>
    <bpmn:userTask id="PropsTask" name="Props Task">
      <bpmn:extensionElements>
        <operaton:properties>
          <operaton:property name="k" value="v" />
        </operaton:properties>
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CleanTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="CleanTask" targetRef="PropsTask" />
    <bpmn:sequenceFlow id="F3" sourceRef="PropsTask" targetRef="E" />`;

  it('reports the undeclared element once (no silent loss) without flagging the clean task', async () => {
    const { warnings } = await xmlToIr(residualXml);
    const extWarnings = extensionWarnings(warnings);
    // Exactly one warning for the one real drop.
    expect(extWarnings).toHaveLength(1);
    // The clean empty stub is never flagged.
    expect(warnings.some((w) => w.elementId === 'CleanTask')).toBe(false);
    // The concrete construct is named in the message.
    expect(extWarnings[0].message).toMatch(/properties/i);
    // Attributed to the process id, the documented coarse attribution for
    // residual drops moddle cannot tie to a specific step.
    expect(extWarnings[0].elementId).toBe('p');
  });

  it('reports extension content on a referenced root element, attributed to the root', async () => {
    const { warnings } = await xmlToIr(
      operatonDefs`  <bpmn:message id="Message_1" name="OrderReceived">
    <bpmn:extensionElements>
      <operaton:inputOutput>
        <operaton:inputParameter name="url">http://x</operaton:inputParameter>
      </operaton:inputOutput>
    </bpmn:extensionElements>
  </bpmn:message>
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S">
      <bpmn:messageEventDefinition id="md" messageRef="Message_1" />
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`,
    );
    expectOneWarning(extensionWarnings(warnings), {
      elementId: 'Message_1',
      message: 'operaton:InputOutput',
    });
  });
});

// ── 11e. bpmn:documentation is warned-and-dropped, per owning element ───────

describe('xmlToIr: warns for dropped documentation', () => {
  const documentationXml = operatonDoc`    <bpmn:documentation>This process handles onboarding.</bpmn:documentation>
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="DocTask" name="Review the application" operaton:assignee="alice">
      <bpmn:documentation>Collect the signed form.</bpmn:documentation>
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="DocTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="DocTask" targetRef="E" />`;

  it('surfaces one documentation warning per owning element (process and task)', async () => {
    const { warnings } = await xmlToIr(documentationXml);
    const docWarnings = warnings.filter(
      (w: ImportWarning) => w.category === 'documentation',
    );
    expect(docWarnings).toHaveLength(2);

    const processWarning = docWarnings.find((w) => w.elementId === 'p');
    expect(processWarning).toBeDefined();
    expect(processWarning?.message).toMatch(/documentation/i);

    const taskWarning = docWarnings.find((w) => w.elementId === 'DocTask');
    expect(taskWarning).toBeDefined();
    expect(taskWarning?.message).toMatch(/documentation/i);
  });

  it('still imports the process body when documentation is present', async () => {
    const { ir } = await xmlToIr(documentationXml);
    expect(ir.flowElements.some((fe) => fe.kind === 'startEvent')).toBe(true);
    const task = byId(ir, 'DocTask');
    expect(task.kind === 'userTask' && task.name).toBe(
      'Review the application',
    );
    expect(task.kind === 'userTask' && task.assignee).toBe('alice');
  });

  it('does NOT warn when no element carries documentation (no false positives)', async () => {
    const { warnings } = await xmlToIr(
      oneNodeDoc('userTask', { attrs: 'name="T"', doc: bpmnDoc }),
    );
    expect(warnings.some((w) => w.category === 'documentation')).toBe(false);
  });
});

// ── 11f. BPMN content the IR does not map is reported, per construct ────────

describe('xmlToIr: warns for unmapped BPMN content', () => {
  it('reports a text annotation, an association, and a group against their container', async () => {
    const xml = bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
    <bpmn:textAnnotation id="Note_1">
      <bpmn:text>Check the customer tier first.</bpmn:text>
    </bpmn:textAnnotation>
    <bpmn:association id="Assoc_1" sourceRef="S" targetRef="Note_1" />
    <bpmn:group id="Group_1" />`;

    const warnings = unmappedWarnings((await xmlToIr(xml)).warnings);
    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.elementId)).toEqual(['p', 'p', 'p']);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining("bpmn:textAnnotation 'Note_1'"),
      expect.stringContaining("bpmn:association 'Assoc_1'"),
      expect.stringContaining("bpmn:group 'Group_1'"),
    ]);
    // Siblings of one kind stay tellable apart by their own id.
    expect(new Set(warnings.map((w) => w.message)).size).toBe(3);
  });

  it('reports an artifact inside a sub-process against that sub-process', async () => {
    const xml = bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubS" />
      <bpmn:endEvent id="SubE" />
      <bpmn:sequenceFlow id="SubF" sourceRef="SubS" targetRef="SubE" />
      <bpmn:textAnnotation id="Note_Inner">
        <bpmn:text>inner note</bpmn:text>
      </bpmn:textAnnotation>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />`;

    const warnings = unmappedWarnings((await xmlToIr(xml)).warnings);
    expectOneWarning(warnings, {
      elementId: 'Sub',
      message: "bpmn:textAnnotation 'Note_Inner'",
    });
  });

  const reviewTaskDoc = (children: string) =>
    oneNodeDoc('userTask', { id: 'Review', children, doc: bpmnDoc });

  it('reports an activity ioSpecification and every property on it', async () => {
    const xml = reviewTaskDoc(`<bpmn:ioSpecification id="IO_1">
        <bpmn:dataInput id="DataIn_1" name="payload" />
        <bpmn:inputSet id="InSet_1" />
        <bpmn:outputSet id="OutSet_1" />
      </bpmn:ioSpecification>
      <bpmn:property id="Prop_1" name="localVar" />
      <bpmn:property id="Prop_2" name="otherVar" />`);

    const warnings = unmappedWarnings((await xmlToIr(xml)).warnings);
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.elementId === 'Review')).toBe(true);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining("bpmn:ioSpecification 'IO_1'"),
      expect.stringContaining("bpmn:property 'Prop_1'"),
      expect.stringContaining("bpmn:property 'Prop_2'"),
    ]);
  });

  it('reports a resource assignment and a data association on a task', async () => {
    const xml = reviewTaskDoc(`<bpmn:dataOutputAssociation id="DataOut_1" />
      <bpmn:potentialOwner id="Owner_1">
        <bpmn:resourceAssignmentExpression id="Assign_1">
          <bpmn:formalExpression id="Expr_1">managers</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>
      </bpmn:potentialOwner>`);

    const warnings = unmappedWarnings((await xmlToIr(xml)).warnings);
    expect(warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("bpmn:dataOutputAssociation 'DataOut_1'"),
        expect.stringContaining("bpmn:potentialOwner 'Owner_1'"),
      ]),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.elementId === 'Review')).toBe(true);
  });

  it('reports an attribute BPMN does not declare, against each element carrying it', async () => {
    const xml = bpmnDoc`    <bpmn:startEvent id="S" wobble="yes" />
    <bpmn:userTask id="Review" wobble="yes" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="E" />`;

    const warnings = unmappedWarnings((await xmlToIr(xml)).warnings);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.elementId).sort()).toEqual(['Review', 'S']);
    expect(warnings.every((w) => w.message.includes("'wobble'"))).toBe(true);
    expect(new Set(warnings.map((w) => w.message)).size).toBe(2);
  });

  it('leaves a foreign-namespace attribute on a mapped element unreported', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:editor="http://example.com/editor"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Review" editor:parked="bookkeeping" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
  });

  it.each([
    [
      'reports a root element the transform does not handle',
      '  <bpmn:dataStore id="Store_1" name="Ledger" />',
      { elementId: 'Store_1', message: "bpmn:dataStore 'Store_1'" },
    ],
    [
      'reports content on bpmn:definitions itself against the process',
      '  <bpmn:import importType="http://www.w3.org/2001/XMLSchema" location="types.xsd" namespace="http://test/types" />',
      { elementId: 'p', message: 'bpmn:import' },
    ],
  ])('%s', async (_title, root, expected) => {
    const xml = bpmnDefs`${root}
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

    expectOneWarning(unmappedWarnings((await xmlToIr(xml)).warnings), expected);
  });

  it('reports isExecutable="false", which imports as executable regardless', async () => {
    const xml = bpmnDefs`  <bpmn:process id="p" isExecutable="false">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(ir.isExecutable).toBe(true);

    const reported = unmappedWarnings(warnings);
    expectOneWarning(reported, {
      elementId: 'p',
      message: 'isExecutable="false"',
    });
    expect(reported[0].message).toMatch(/deploy/i);
  });

  it('says nothing when the process omits isExecutable, which an engine reads as executable', async () => {
    const xml = bpmnDefs`  <bpmn:process id="p">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

    expect((await xmlToIr(xml)).warnings).toEqual([]);
  });

  it('reports nothing for a process built only from mapped constructs', async () => {
    const xml = oneNodeDoc('userTask', {
      id: 'Review',
      attrs: 'name="Review"',
      doc: bpmnDoc,
    });
    expect((await xmlToIr(xml)).warnings).toEqual([]);
  });
});

// ── 12. Embedded bpmn:subProcess imports recursively ─────────────────────────

describe('xmlToIr: embedded sub-process imports recursively', () => {
  const subProcessDoc = (children: string, attrs = '', doc = bpmnDoc) =>
    oneNodeDoc('subProcess', { id: 'Sub', attrs, children, doc });

  const nestedSubProcessXml = subProcessDoc(
    `<bpmn:startEvent id="SubStart" />
      <bpmn:userTask id="Review" name="Review" operaton:assignee="demo" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="Review" />
      <bpmn:sequenceFlow id="SF2" sourceRef="Review" targetRef="SubEnd" />`,
    'name="Sub Process"',
    operatonDoc,
  );

  it('maps to a recursive IR SubProcess carrying its own nested body', async () => {
    const { node: sub, warnings } = await importOnly(
      nestedSubProcessXml,
      'subProcess',
    );
    expect(warnings).toEqual([]);

    expect(sub.name).toBe('Sub Process');
    expect(sub.flowElements.map((fe) => fe.id)).toEqual([
      'SubStart',
      'Review',
      'SubEnd',
    ]);
    expect(sub.sequenceFlows.map((f) => f.id)).toEqual(['SF1', 'SF2']);
    const review = byId(sub, 'Review');
    expect(review.kind === 'userTask' && review.assignee).toBe('demo');
  });

  it('drops a sub-process name that exactly equals humanize(id)', async () => {
    const xml = subProcessDoc(
      `<bpmn:startEvent id="SubStart" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="SubEnd" />`,
      'name="Sub"',
    );
    const { node: sub } = await importOnly(xml, 'subProcess');
    expect('name' in sub).toBe(false);
  });

  it('leaks nothing from the nested body into the parent container', async () => {
    const { ir } = await xmlToIr(nestedSubProcessXml);
    expect(ir.flowElements.map((fe) => fe.id)).toEqual(['S', 'Sub', 'E']);
    expect(ir.sequenceFlows.map((f) => f.id)).toEqual(['F1', 'F2']);
  });

  it('an event sub-process (triggeredByEvent="true") is imported, not refused: see the "event layer import" suite below', async () => {
    const xml = operatonDefs`  <bpmn:error id="Error_PF" errorCode="PF" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub" triggeredByEvent="true">
      <bpmn:startEvent id="SubStart">
        <bpmn:errorEventDefinition id="SubStartDef" errorRef="Error_PF" />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

    const { ir } = await xmlToIr(xml);
    expect(
      ir.flowElements.some(
        (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
      ),
    ).toBe(true);
  });

  it('imports a repeated sub-process, keeping its body', async () => {
    const xml = subProcessDoc(
      `<bpmn:multiInstanceLoopCharacteristics isSequential="true">
        <bpmn:loopCardinality>2</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
      <bpmn:startEvent id="SubStart" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="SubEnd" />`,
    );

    const { node, warnings } = await importOnly(xml, 'subProcess');
    expect(node.loop).toEqual({ cardinality: '2', sequential: true });
    expect(node.flowElements).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('warns for an unsupported extension attribute on a task nested inside a sub-process', async () => {
    const xml = subProcessDoc(
      `<bpmn:startEvent id="SubStart" />
      <bpmn:userTask id="InnerTask" name="Inner Task"
                     operaton:assignee="alice" operaton:formRef="review-form" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="InnerTask" />
      <bpmn:sequenceFlow id="SF2" sourceRef="InnerTask" targetRef="SubEnd" />`,
      '',
      operatonDoc,
    );

    const { warnings } = await xmlToIr(xml);
    const w = warnings.find((w) => w.message.includes('formRef'));
    expect(w).toBeDefined();
    expect(w?.elementId).toBe('InnerTask');
  });

  it('refuses a trigger on a start event nested inside a sub-process', async () => {
    const xml = subProcessDoc(
      `<bpmn:startEvent id="SubStart">
        <bpmn:timerEventDefinition />
      </bpmn:startEvent>
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="SubEnd" />`,
    );

    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(xml),
      UnsupportedEventFeatureError,
      'a subprocess cannot start on a trigger: Operaton rejects one there ' +
        'when it parses the file; a subprocess is entered from the ' +
        'surrounding process, not by an event of its own',
    );
    expect(e.elementId).toBe('SubStart');
    expect(e.message).toContain("Put the trigger on an 'on' handler");
    expect(e.message).not.toContain('Event handlers catch one');
  });

  it('imports two-level nesting recursively', async () => {
    const xml = oneNodeDoc('subProcess', {
      id: 'Outer',
      doc: bpmnDoc,
      children: `<bpmn:startEvent id="OStart" />
      <bpmn:subProcess id="Inner">
        <bpmn:startEvent id="IStart" />
        <bpmn:userTask id="Deep" />
        <bpmn:endEvent id="IEnd" />
        <bpmn:sequenceFlow id="SF_IStart_Deep" sourceRef="IStart" targetRef="Deep" />
        <bpmn:sequenceFlow id="SF_Deep_IEnd" sourceRef="Deep" targetRef="IEnd" />
      </bpmn:subProcess>
      <bpmn:endEvent id="OEnd" />
      <bpmn:sequenceFlow id="SF_OStart_Inner" sourceRef="OStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="SF_Inner_OEnd" sourceRef="Inner" targetRef="OEnd" />`,
    });

    const { node: outer, warnings } = await importOnly(xml, 'subProcess');
    expect(warnings).toEqual([]);

    const inner = subProcess(outer, 'Inner');
    expect(inner.flowElements.map((fe) => fe.id)).toEqual([
      'IStart',
      'Deep',
      'IEnd',
    ]);
    expect(outer.flowElements.map((fe) => fe.id)).toEqual([
      'OStart',
      'Inner',
      'OEnd',
    ]);
  });
});

// ── 13. callActivity import ──────────────────────────────────────────────────

describe('xmlToIr: callActivity import', () => {
  const callDoc = (attrs = '', children = '', doc = operatonDoc) =>
    oneNodeDoc('callActivity', {
      id: 'CallSub',
      attrs: `calledElement="sub-process" ${attrs}`,
      children,
      doc,
    });

  const richCallXml = callDoc(
    'name="Call sub" operaton:calledElementBinding="version" operaton:calledElementVersion="3"',
    extensionElements(`        <operaton:in businessKey="\${execution.processBusinessKey}" />
        <operaton:in variables="all" />
        <operaton:in source="amount" target="amount" />
        <operaton:in sourceExpression="\${total * 2}" target="doubled" local="true" />
        <operaton:out source="result" target="outcome" />
        <operaton:out sourceExpression="\${status}" target="final" />`),
  );

  const EXPECTED_RICH_CALL: CallActivity = {
    kind: 'callActivity',
    id: 'CallSub',
    name: 'Call sub',
    calledElement: 'sub-process',
    binding: { kind: 'version', version: '3' },
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
      { kind: 'expression', sourceExpression: '${status}', target: 'final' },
    ],
  };

  it('a fully-featured call activity imports to the exact expected IR node (deep equality)', async () => {
    const { node } = await importOnly(richCallXml, 'callActivity');
    expect(node).toEqual(EXPECTED_RICH_CALL);
  });

  // ── Binding table ───────────────────────────────────────────────────────

  const callXmlWithBindingAttrs = (attrs: string): string =>
    callDoc(attrs, '', dualDoc);

  const importCall = (attrs: string) =>
    importOnly(callXmlWithBindingAttrs(attrs), 'callActivity');

  it('no binding attributes -> the IR binding is absent', async () => {
    const { node } = await importCall('');
    expect('binding' in node).toBe(false);
  });

  it.each([
    [
      'calledElementBinding="latest" -> { kind: "latest" }',
      'operaton:calledElementBinding="latest"',
      { kind: 'latest' },
    ],
    [
      'calledElementBinding="deployment" -> { kind: "deployment" }',
      'operaton:calledElementBinding="deployment"',
      { kind: 'deployment' },
    ],
    [
      'calledElementBinding="version" with calledElementVersion -> { kind: "version", version }',
      'operaton:calledElementBinding="version" operaton:calledElementVersion="7"',
      { kind: 'version', version: '7' },
    ],
    [
      'camunda:calledElementBinding is honored, matching the assignee dual-namespace contract',
      'camunda:calledElementBinding="latest"',
      { kind: 'latest' },
    ],
  ] as const)('%s', async (_title, attrs, binding) => {
    const { node } = await importCall(attrs);
    expect(node.binding).toEqual(binding);
  });

  it.each([
    [
      'calledElementBinding="version" WITHOUT a version is refused',
      'operaton:calledElementBinding="version"',
    ],
    [
      'an unrecognized calledElementBinding value (e.g. versionTag) is refused',
      'operaton:calledElementBinding="versionTag"',
    ],
  ])('%s', async (_title, attrs) => {
    await expect(
      xmlToIr(callXmlWithBindingAttrs(attrs)),
    ).rejects.toBeInstanceOf(UnsupportedCallActivityError);
  });

  it('a dangling calledElementVersion (binding absent) imports with NO binding and exactly one warning', async () => {
    const { node, warnings } = await importCall(
      'operaton:calledElementVersion="7"',
    );
    expect('binding' in node).toBe(false);

    const versionWarnings = warnings.filter((w) =>
      w.message.includes('calledElementVersion'),
    );
    expect(versionWarnings).toHaveLength(1);
    expect(versionWarnings[0].elementId).toBe('CallSub');
  });

  // ── Execution-affecting extension attributes ─────────────────────────────

  it.each([
    [
      'operaton:variableMappingClass is refused, naming the variable-mapping attribute',
      'operaton:variableMappingClass="com.acme.Mapper"',
      /variableMappingClass/,
    ],
    [
      'operaton:variableMappingDelegateExpression is refused, naming the variable-mapping attribute',
      'operaton:variableMappingDelegateExpression="${mapper}"',
      /variableMappingDelegateExpression/,
    ],
    [
      'operaton:calledElementTenantId is refused, naming the tenant attribute',
      'operaton:calledElementTenantId="tenant-a"',
      /calledElementTenantId/,
    ],
    [
      'camunda:calledElementTenantId is refused too, matching the dual-namespace contract',
      'camunda:calledElementTenantId="tenant-a"',
      /calledElementTenantId/,
    ],
  ] as const)('%s', async (_title, attributes, detail) => {
    await expectRefusal(
      xmlToIr(callXmlWithBindingAttrs(attributes)),
      UnsupportedCallActivityError,
      detail,
    );
  });

  // ── Mapping-shape refusals ────────────────────────────────────────────────

  const callXmlWithExtension = (extension: string): string =>
    callDoc('', extensionElements(extension));

  it.each([
    [
      'an operaton:in with both source and sourceExpression is refused, naming the shape',
      '<operaton:in source="a" sourceExpression="${b}" target="c" />',
      'an operaton:in carries both source and sourceExpression',
    ],
    [
      'an operaton:in with source but no target is refused, naming the shape',
      '<operaton:in source="a" />',
      'an operaton:in carries source without a target',
    ],
    [
      'an operaton:in with variables="foo" is refused, naming the shape',
      '<operaton:in variables="foo" />',
      'an operaton:in carries variables="foo", which this tool cannot import (only variables="all" is supported)',
    ],
    [
      'a businessKey In combined with a target is refused, naming the shape',
      '<operaton:in businessKey="${execution.processBusinessKey}" target="x" />',
      'an operaton:in businessKey is combined with source/sourceExpression/target/variables/local',
    ],
    [
      'two businessKey Ins are refused, naming the shape',
      '<operaton:in businessKey="${a}" /><operaton:in businessKey="${b}" />',
      'more than one operaton:in businessKey is set',
    ],
    [
      'an empty operaton:in with no recognized attribute is refused',
      '<operaton:in />',
      'an operaton:in carries none of the recognized shapes (source+target, sourceExpression+target, variables="all", or businessKey)',
    ],
    [
      'an operaton:in with sourceExpression but no target is refused, naming the shape',
      '<operaton:in sourceExpression="${a}" />',
      'an operaton:in carries sourceExpression without a target',
    ],
    [
      'an operaton:in with variables="all" combined with source/target is refused, naming the shape',
      '<operaton:in variables="all" source="a" target="b" />',
      'an operaton:in carries variables="all" combined with source/sourceExpression/target',
    ],
    [
      'a businessKey In combined with variables is refused, naming the shape',
      '<operaton:in businessKey="${a}" variables="all" />',
      'an operaton:in businessKey is combined with source/sourceExpression/target/variables/local',
    ],
    [
      'an operaton:out with source but no target is refused, naming the out tag',
      '<operaton:out source="a" />',
      'an operaton:out carries source without a target',
    ],
  ] as const)('%s', async (_title, extension, detail) => {
    await expectRefusal(
      xmlToIr(callXmlWithExtension(extension)),
      UnsupportedCallActivityError,
      detail,
    );
  });

  // ── The operaton:in/operaton:out honesty guard ───────────────────────────

  it('an operaton:in inside a user task still produces one drop warning attributed to that task', async () => {
    const xml = oneNodeDoc('userTask', {
      attrs: 'name="T" operaton:assignee="alice"',
      children: extensionElements(
        '        <operaton:in source="a" target="b" />',
      ),
    });

    const { warnings } = await xmlToIr(xml);
    const extWarnings = extensionWarnings(warnings).filter(
      (w) => w.elementId === 'T',
    );
    expect(extWarnings).toHaveLength(1);
  });

  it('a camunda:in on a call activity produces a drop warning (foreign-namespace element)', async () => {
    const xml = callDoc(
      '',
      extensionElements('        <camunda:in source="a" target="b" />'),
      camundaDoc,
    );

    const { warnings } = await xmlToIr(xml);
    const w = extensionWarnings(warnings).find(
      (w) => w.elementId === 'CallSub',
    );
    expect(w).toBeDefined();
  });

  it('a clean call-activity import produces no warnings', async () => {
    const { warnings } = await xmlToIr(richCallXml);
    expect(warnings).toEqual([]);
  });

  // ── Nesting and loop characteristics ─────────────────────────────────────

  it('a call activity inside a sub-process imports into the nested container', async () => {
    const xml = oneNodeDoc('subProcess', {
      id: 'Sub',
      doc: bpmnDoc,
      children: `<bpmn:startEvent id="SubStart" />
      <bpmn:callActivity id="InnerCall" calledElement="sub-process" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="InnerCall" />
      <bpmn:sequenceFlow id="SF2" sourceRef="InnerCall" targetRef="SubEnd" />`,
    });

    const { node: sub } = await importOnly(xml, 'subProcess');
    const inner = only(sub, 'callActivity');
    expect(inner.id).toBe('InnerCall');
    expect(inner.calledElement).toBe('sub-process');
  });

  it('a call activity with multiInstanceLoopCharacteristics imports its repetition', async () => {
    const xml = callDoc(
      '',
      `<bpmn:multiInstanceLoopCharacteristics>
        <bpmn:loopCardinality>2</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>`,
      bpmnDoc,
    );

    const { node, warnings } = await importOnly(xml, 'callActivity');
    expect(node.loop).toEqual({ cardinality: '2' });
    expect(warnings).toEqual([]);
  });

  // ── readDerivableName symmetry ────────────────────────────────────────────

  const namedCallXml = (name: string) =>
    oneNodeDoc('callActivity', {
      id: 'Fulfil_Order',
      attrs: `name="${name}" calledElement="sub-process"`,
      doc: bpmnDoc,
    });

  it('drops a call-activity name that exactly equals humanize(id)', async () => {
    const { node } = await importOnly(
      namedCallXml('Fulfil Order'),
      'callActivity',
    );
    expect('name' in node).toBe(false);
  });

  it('keeps a genuine call-activity label that differs from humanize(id)', async () => {
    const { node } = await importOnly(
      namedCallXml('Send the order to fulfilment'),
      'callActivity',
    );
    expect(node.name).toBe('Send the order to fulfilment');
  });
});

// ── 14. Event layer import: handlers, throws, emits, roots ──────────────────

describe('xmlToIr: event layer import', () => {
  // ── 14a. Full positive import (mirrors the ir-to-xml event-layer fixture) ─

  const fullEventXml = dualDefs`  <bpmn:error id="Error_PF" name="PF" errorCode="PF" operaton:errorMessage="boom" />
  <bpmn:escalation id="Escalation_LS" name="LS" escalationCode="LS" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="ErrHandler" triggeredByEvent="true">
      <bpmn:startEvent id="ErrStart">
        <bpmn:errorEventDefinition id="ErrStartDef" errorRef="Error_PF"
          operaton:errorCodeVariable="c" operaton:errorMessageVariable="m" />
      </bpmn:startEvent>
      <bpmn:userTask id="Recover" />
      <bpmn:endEvent id="ErrEnd" />
      <bpmn:sequenceFlow id="SF_ErrStart_Recover" sourceRef="ErrStart" targetRef="Recover" />
      <bpmn:sequenceFlow id="SF_Recover_ErrEnd" sourceRef="Recover" targetRef="ErrEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="EscHandler" triggeredByEvent="true">
      <bpmn:startEvent id="EscStart" isInterrupting="false">
        <bpmn:escalationEventDefinition id="EscStartDef" escalationRef="Escalation_LS"
          camunda:escalationCodeVariable="v" />
      </bpmn:startEvent>
      <bpmn:userTask id="Notify" />
      <bpmn:endEvent id="EscEnd" />
      <bpmn:sequenceFlow id="SF_EscStart_Notify" sourceRef="EscStart" targetRef="Notify" />
      <bpmn:sequenceFlow id="SF_Notify_EscEnd" sourceRef="Notify" targetRef="EscEnd" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="Emit1">
      <bpmn:escalationEventDefinition id="Emit1Def" escalationRef="Escalation_LS" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="ThrowPF">
      <bpmn:errorEventDefinition id="ThrowPFDef" errorRef="Error_PF" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Emit1" />
    <bpmn:sequenceFlow id="F2" sourceRef="Emit1" targetRef="ThrowPF" />
  </bpmn:process>`;

  const EXPECTED_EVENT_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    errorMessages: [{ code: 'PF', message: 'boom' }],
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      triggeredSub('ErrHandler', [
        typedEvent(
          'startEvent',
          'ErrStart',
          errorDef('PF', { codeVariable: 'c', messageVariable: 'm' }),
        ),
        { kind: 'userTask', id: 'Recover' },
        { kind: 'endEvent', id: 'ErrEnd' },
      ]),
      triggeredSub('EscHandler', [
        typedEvent('startEvent', 'EscStart', escalationDef('LS', 'v'), false),
        { kind: 'userTask', id: 'Notify' },
        { kind: 'endEvent', id: 'EscEnd' },
      ]),
      typedEvent('intermediateThrowEvent', 'Emit1', escalationDef('LS')),
      typedEvent('endEvent', 'ThrowPF', errorDef('PF')),
    ],
    sequenceFlows: [
      { id: 'F1', sourceRef: 'PStart', targetRef: 'Emit1' },
      { id: 'F2', sourceRef: 'Emit1', targetRef: 'ThrowPF' },
    ],
  };

  it('imports an interrupting error handler, an alongside escalation handler (camunda: binding alias), a typed end, and an emit, sharing their roots, into the exact expected IR (deep equality)', async () => {
    const { ir, warnings } = await xmlToIr(fullEventXml);
    expect(ir).toEqual(EXPECTED_EVENT_IR);
    expect(warnings).toEqual([]);
  });

  // ── 14b. Catch-all ────────────────────────────────────────────────────────

  /** The trigger definition on the handler start of a `handlerDoc` fixture. */
  const triggerOf = async (xml: string) => {
    const { node } = await importOnly(xml, 'subProcess');
    const start = byId(node, 'HStart');
    return start.kind === 'startEvent' ? start.eventDefinition : undefined;
  };

  const codelessRootXml = handlerDoc(
    '<bpmn:errorEventDefinition id="d" errorRef="Error_NoCode" />',
    { roots: '  <bpmn:error id="Error_NoCode" />\n' },
  );

  it.each([
    [
      'a handler definition without errorRef imports with the code absent (catch-all)',
      handlerDoc('<bpmn:errorEventDefinition id="d" />'),
    ],
    [
      'a ref to a code-less bpmn:Error root imports with the code absent',
      codelessRootXml,
    ],
  ])('%s', async (_title, xml) => {
    expect(await triggerOf(xml)).toEqual(errorDef());
  });

  it('a code-less bpmn:Error root warns about the missing code, not "never caught"', async () => {
    // The root is referenced (errorRef), so "never caught or thrown" would be
    // false. The message names the real reason: a code-less root cannot be
    // keyed or represented.
    const { warnings } = await xmlToIr(codelessRootXml);
    const w = warnings.find(
      (w) =>
        w.category === 'unreferencedRoot' && w.elementId === 'Error_NoCode',
    );
    expect(w).toBeDefined();
    expect(w?.message).toContain('has no code');
    expect(w?.message).not.toContain('never caught');
  });

  // ── 14c. Refusals (one per shape) ─────────────────────────────────────────

  describe('refusals', () => {
    it('a terminate definition on a handler start still refuses with UnsupportedEventDefinitionError', async () => {
      const e = await expectRefusal<UnsupportedEventDefinitionError>(
        xmlToIr(
          handlerDoc('<bpmn:terminateEventDefinition id="td" />', { body: '' }),
        ),
        UnsupportedEventDefinitionError,
      );
      expect(e.eventKind).toBe('start');
      expect(e.definitionType).toBe('bpmn:TerminateEventDefinition');
    });

    it.each([
      [
        'an event handler with zero start events',
        bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:userTask id="T" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      ],
      [
        'an event handler with two start events',
        bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="S1"><bpmn:errorEventDefinition /></bpmn:startEvent>
      <bpmn:startEvent id="S2"><bpmn:errorEventDefinition /></bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      ],
      [
        'a handler start with two event definitions',
        handlerDoc(
          `<bpmn:errorEventDefinition />
        <bpmn:escalationEventDefinition />`,
          { body: '' },
        ),
      ],
      [
        'an event handler with an incoming flow',
        bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:incoming>F1</bpmn:incoming>
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Handler" />`,
      ],
      [
        'isInterrupting="false" on an error handler',
        handlerDoc('<bpmn:errorEventDefinition errorRef="Error_X" />', {
          roots: '  <bpmn:error id="Error_X" errorCode="X" />\n',
          startAttrs: 'isInterrupting="false"',
        }),
      ],
      [
        'an error end event with no resolvable code',
        rootedDoc(
          '',
          `    <bpmn:endEvent id="ThrowNoCode">
      <bpmn:errorEventDefinition />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ThrowNoCode" />`,
        ),
      ],
      [
        'an error definition on an intermediate throw',
        rootedDoc(
          '  <bpmn:error id="Error_X" errorCode="X" />\n',
          `    <bpmn:intermediateThrowEvent id="BadEmit">
      <bpmn:errorEventDefinition errorRef="Error_X" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="BadEmit" />
    <bpmn:sequenceFlow id="F2" sourceRef="BadEmit" targetRef="E" />`,
        ),
      ],
      [
        'a "none" intermediate throw (no event definition)',
        rootedDoc(
          '',
          `    <bpmn:intermediateThrowEvent id="NoneEmit" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="NoneEmit" />
    <bpmn:sequenceFlow id="F2" sourceRef="NoneEmit" targetRef="E" />`,
        ),
      ],
      [
        'two bpmn:Error roots sharing a code but disagreeing on the message',
        rootedDoc(
          `  <bpmn:error id="Error_A" errorCode="DUP" operaton:errorMessage="first" />
  <bpmn:error id="Error_B" errorCode="DUP" operaton:errorMessage="second" />\n`,
          `    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
          operatonDefs,
        ),
      ],
      [
        'a declared message on a code-less bpmn:Error root',
        rootedDoc(
          '  <bpmn:error id="Error_NoCode" operaton:errorMessage="oops" />\n',
          `    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
          operatonDefs,
        ),
      ],
    ])('%s refuses with UnsupportedEventFeatureError', async (_title, xml) => {
      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });
  });

  // ── 14d. Warn-drops ───────────────────────────────────────────────────────

  describe('warn-drops', () => {
    const ERROR_X_ROOT = '  <bpmn:error id="Error_X" errorCode="X" />\n';

    /** `S -> ThrowX`, where the typed end carries the given definition. */
    const typedEndXml = (attrs: string, definition: string, defs = bpmnDefs) =>
      rootedDoc(
        ERROR_X_ROOT,
        `    <bpmn:endEvent id="ThrowX" ${attrs}>
      ${definition}
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ThrowX" />`,
        defs,
      );

    it('a genuine label on a typed end event warns once, attributed to it', async () => {
      const { ir, warnings } = await xmlToIr(
        typedEndXml(
          'name="Custom Label"',
          '<bpmn:errorEventDefinition errorRef="Error_X" />',
        ),
      );
      expect('name' in byId(ir, 'ThrowX')).toBe(false);

      const labelWarnings = warnings.filter((w) => w.category === 'label');
      expectOneWarning(labelWarnings, {
        elementId: 'ThrowX',
        message: 'Custom Label',
      });
    });

    it('a genuine label on an event handler warns once, attributed to it', async () => {
      const { ir, warnings } = await xmlToIr(
        bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true" name="Custom Handler Label">
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      );
      expect('name' in byId(ir, 'Handler')).toBe(false);

      const labelWarnings = warnings.filter((w) => w.category === 'label');
      expectOneWarning(labelWarnings, {
        elementId: 'Handler',
        message: 'Custom Handler Label',
      });
    });

    it('a genuine label on an event handler start is kept, not dropped', async () => {
      const { ir, warnings } = await xmlToIr(
        bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HandlerStart" name="Cancelled">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      );
      const start = byId(subProcess(ir, 'Handler'), 'HandlerStart');
      expect(start.kind === 'startEvent' && start.name).toBe('Cancelled');
      expect(warnings.filter((w) => w.category === 'label')).toEqual([]);
    });

    it('operaton:errorCodeVariable on an error end event (throw side) warns: it has no effect there', async () => {
      const { ir, warnings } = await xmlToIr(
        typedEndXml(
          '',
          '<bpmn:errorEventDefinition errorRef="Error_X" operaton:errorCodeVariable="c" />',
          operatonDefs,
        ),
      );
      // The binding attribute has no effect on the throw side, so the IR
      // carries only the code.
      const end = byId(ir, 'ThrowX');
      expect(end.kind === 'endEvent' && end.eventDefinition).toEqual(
        errorDef('X'),
      );

      const w = warnings.find((w) => w.message.includes('errorCodeVariable'));
      expect(w).toBeDefined();
      expect(w?.elementId).toBe('ThrowX');
    });

    it('an unrelated operaton: attribute on a mapped event definition warns', async () => {
      const { warnings } = await xmlToIr(
        handlerDoc(
          '<bpmn:errorEventDefinition errorRef="Error_X" operaton:asyncBefore="true" />',
          { roots: ERROR_X_ROOT, defs: operatonDefs },
        ),
      );
      const w = warnings.find((w) => w.message.includes('asyncBefore'));
      expect(w).toBeDefined();
      expect(w?.elementId).toBe('HStart');
    });

    /** A lone declared root with a `S -> E` process that never references it. */
    const unusedRootXml = (root: string, defs = bpmnDefs) =>
      rootedDoc(
        `${root}\n`,
        `    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
        defs,
      );

    it('an unreferenced message-less bpmn:Error root warns once', async () => {
      const { ir, warnings } = await xmlToIr(
        unusedRootXml('  <bpmn:error id="Error_Unused" errorCode="UNUSED" />'),
      );
      expect(ir.errorMessages).toBeUndefined();
      const unreferenced = warnings.filter(
        (w) => w.category === 'unreferencedRoot',
      );
      expect(unreferenced).toHaveLength(1);
      expect(unreferenced[0].elementId).toBe('Error_Unused');
    });

    it('an unreferenced root WITH code+message imports into errorMessages with NO warning', async () => {
      const { ir, warnings } = await xmlToIr(
        unusedRootXml(
          '  <bpmn:error id="Error_Declared" errorCode="DECL" operaton:errorMessage="declared but unused" />',
          operatonDefs,
        ),
      );
      expect(ir.errorMessages).toEqual([
        { code: 'DECL', message: 'declared but unused' },
      ]);
      expect(warnings).toEqual([]);
    });
  });

  // ── 14e. Nesting and still-refused kinds ─────────────────────────────────

  it('an event handler nested inside a plain sub-process imports into the nested container', async () => {
    const xml = bpmnDefs`  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Outer">
      <bpmn:startEvent id="OStart" />
      <bpmn:userTask id="Work" />
      <bpmn:endEvent id="OEnd" />
      <bpmn:subProcess id="InnerHandler" triggeredByEvent="true">
        <bpmn:startEvent id="IHStart">
          <bpmn:errorEventDefinition errorRef="Error_X" />
        </bpmn:startEvent>
        <bpmn:endEvent id="IHEnd" />
        <bpmn:sequenceFlow id="SF_IH" sourceRef="IHStart" targetRef="IHEnd" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="SF_OStart_Work" sourceRef="OStart" targetRef="Work" />
      <bpmn:sequenceFlow id="SF_Work_OEnd" sourceRef="Work" targetRef="OEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="F2" sourceRef="Outer" targetRef="PEnd" />
  </bpmn:process>`;

    const { node: outer, warnings } = await importOnly(xml, 'subProcess');
    expect(warnings).toEqual([]);

    const inner = subProcess(outer, 'InnerHandler');
    expect(inner.triggeredByEvent).toBe(true);
    const innerStart = byId(inner, 'IHStart');
    expect(
      innerStart.kind === 'startEvent' && innerStart.eventDefinition,
    ).toEqual(errorDef('X'));
  });

  it('bpmn:IntermediateCatchEvent is imported, not refused (see the "intermediate catch event import" suite below)', async () => {
    // An empty timer still refuses, but with UnsupportedEventFeatureError: an
    // unsupported shape rather than an unsupported kind.
    const xml = oneNodeDoc('intermediateCatchEvent', {
      id: 'Wait',
      children: '<bpmn:timerEventDefinition />',
      doc: bpmnDoc,
    });

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedEventFeatureError,
    );
    await expect(xmlToIr(xml)).rejects.not.toBeInstanceOf(
      UnsupportedElementError,
    );
  });

  it('a normal (non-handler) start event with an error definition still refuses', async () => {
    const xml = bpmnDefs`  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S">
      <bpmn:errorEventDefinition errorRef="Error_X" />
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(xml),
      UnsupportedEventFeatureError,
      'a process cannot start on an error; Operaton ignores the trigger ' +
        'and starts the process as if none were written, so importing it ' +
        'would write back a document the engine runs differently from what ' +
        'it says',
    );
    expect(e.elementId).toBe('S');
  });
});

// ── 15. Message/signal/timer/conditional import ─────────────────────────────

describe('xmlToIr: message/signal/timer/conditional import', () => {
  // ── 15a. Full positive import ───────────────────────────────────────────

  const fullNewKindsXml = bpmnDefs`  <bpmn:message id="Message_Pay" name="PaymentReceived" />
  <bpmn:signal id="Signal_Ping" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="MsgHandler" triggeredByEvent="true">
      <bpmn:startEvent id="MsgStart">
        <bpmn:messageEventDefinition id="MsgDef" messageRef="Message_Pay" />
      </bpmn:startEvent>
      <bpmn:endEvent id="MsgEnd" />
      <bpmn:sequenceFlow id="SF_Msg" sourceRef="MsgStart" targetRef="MsgEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="SigHandler" triggeredByEvent="true">
      <bpmn:startEvent id="SigStart" isInterrupting="false">
        <bpmn:signalEventDefinition id="SigDef" signalRef="Signal_Ping" />
      </bpmn:startEvent>
      <bpmn:endEvent id="SigEnd" />
      <bpmn:sequenceFlow id="SF_Sig" sourceRef="SigStart" targetRef="SigEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="DurationHandler" triggeredByEvent="true">
      <bpmn:startEvent id="DurStart">
        <bpmn:timerEventDefinition id="DurDef">
          <bpmn:timeDuration>PT1H</bpmn:timeDuration>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="DurEnd" />
      <bpmn:sequenceFlow id="SF_Dur" sourceRef="DurStart" targetRef="DurEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="DateHandler" triggeredByEvent="true">
      <bpmn:startEvent id="DateStart">
        <bpmn:timerEventDefinition id="DateDef">
          <bpmn:timeDate>2026-08-01T09:00:00</bpmn:timeDate>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="DateEnd" />
      <bpmn:sequenceFlow id="SF_Date" sourceRef="DateStart" targetRef="DateEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="CondHandler" triggeredByEvent="true">
      <bpmn:startEvent id="CondStart">
        <bpmn:conditionalEventDefinition id="CondDef">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="CondEnd" />
      <bpmn:sequenceFlow id="SF_Cond" sourceRef="CondStart" targetRef="CondEnd" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="EmitSig">
      <bpmn:signalEventDefinition id="EmitSigDef" signalRef="Signal_Ping" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="ThrowSig">
      <bpmn:signalEventDefinition id="ThrowSigDef" signalRef="Signal_Ping" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="EmitSig" />
    <bpmn:sequenceFlow id="F2" sourceRef="EmitSig" targetRef="ThrowSig" />
  </bpmn:process>`;

  const PING: EventDefinition = signalDef('Ping');

  const EXPECTED_NEW_KINDS_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'PStart' },
      eventSubProcess('Msg', messageDef('PaymentReceived')),
      eventSubProcess('Sig', PING, { isInterrupting: false }),
      eventSubProcess('Dur', timerDef('duration', 'PT1H'), {
        id: 'DurationHandler',
      }),
      eventSubProcess('Date', timerDef('date', '2026-08-01T09:00:00')),
      eventSubProcess('Cond', conditionDef('${amount > 100}')),
      typedEvent('intermediateThrowEvent', 'EmitSig', PING),
      typedEvent('endEvent', 'ThrowSig', PING),
    ],
    [
      { id: 'F1', sourceRef: 'PStart', targetRef: 'EmitSig' },
      { id: 'F2', sourceRef: 'EmitSig', targetRef: 'ThrowSig' },
    ],
  );

  it('imports a message handler, a non-interrupting signal handler, duration/date timer handlers, a conditional handler, and a signal end+emit sharing one root, into the exact expected IR (deep equality), warnings: []', async () => {
    const { ir, warnings } = await xmlToIr(fullNewKindsXml);
    expect(ir).toEqual(EXPECTED_NEW_KINDS_IR);
    expect(warnings).toEqual([]);
  });

  // ── 15b. Refusals (one per shape) ───────────────────────────────────────

  describe('refusals', () => {
    it.each([
      [
        'a ref-less message definition',
        handlerDoc('<bpmn:messageEventDefinition id="d" />', { body: '' }),
        'a message definition must reference a bpmn:Message root with a ' +
          'non-empty name',
      ],
      [
        'a signal ref to a nameless root',
        handlerDoc(
          '<bpmn:signalEventDefinition id="d" signalRef="Signal_NoName" />',
          { roots: '  <bpmn:signal id="Signal_NoName" />\n', body: '' },
        ),
        'a signal definition must reference a bpmn:Signal root with a ' +
          'non-empty name',
      ],
      [
        'a timer definition with zero time children',
        handlerDoc('<bpmn:timerEventDefinition id="d" />', { body: '' }),
        'a timer definition must carry exactly one of ' +
          'timeDuration/timeDate/timeCycle (found 0)',
      ],
      [
        'a timer definition with two time children',
        handlerDoc(
          `<bpmn:timerEventDefinition id="d">
          <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          <bpmn:timeDate>2026-08-01T09:00:00</bpmn:timeDate>
        </bpmn:timerEventDefinition>`,
          { body: '' },
        ),
        'a timer definition must carry exactly one of ' +
          'timeDuration/timeDate/timeCycle (found 2)',
      ],
      [
        'a timer definition with an empty body',
        handlerDoc(
          `<bpmn:timerEventDefinition id="d">
          <bpmn:timeDuration></bpmn:timeDuration>
        </bpmn:timerEventDefinition>`,
          { body: '' },
        ),
        "a timer definition's timeDuration has an empty body",
      ],
      [
        'a conditional definition without a condition child',
        handlerDoc('<bpmn:conditionalEventDefinition id="d" />', { body: '' }),
        'a conditional definition must carry a condition with a non-empty ' +
          'body',
      ],
      [
        'operaton:variableName on a conditional definition',
        handlerDoc(
          `<bpmn:conditionalEventDefinition id="d" operaton:variableName="amount">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>`,
          { body: '', defs: operatonDefs },
        ),
        "a conditional definition's operaton:variableName narrows when the " +
          'condition is (re-)evaluated, which this tool cannot represent',
      ],
      [
        'camunda:variableEvents on a conditional definition',
        handlerDoc(
          `<bpmn:conditionalEventDefinition id="d" camunda:variableEvents="update">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>`,
          { body: '', defs: camundaDefs },
        ),
        "a conditional definition's camunda:variableEvents narrows when the " +
          'condition is (re-)evaluated, which this tool cannot represent',
      ],
    ] as const)(
      '%s refuses with UnsupportedEventFeatureError naming the form',
      async (_title, xml, detail) => {
        await expectRefusal(xmlToIr(xml), UnsupportedEventFeatureError, detail);
      },
    );

    it.each([
      [
        'a link definition on an end event',
        rootedDoc(
          '',
          `    <bpmn:endEvent id="E">
      <bpmn:linkEventDefinition name="Resume" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
        ),
        'end',
        'bpmn:LinkEventDefinition',
        'A typed end event supports terminate, error, escalation, message, ' +
          'signal, or compensation, plus cancel inside a block that can be ' +
          'given up.',
      ],
      [
        'a conditional definition on an intermediate throw',
        oneNodeDoc('intermediateThrowEvent', {
          id: 'Emit',
          doc: bpmnDoc,
          children: `<bpmn:conditionalEventDefinition>
        <bpmn:condition>\${x}</bpmn:condition>
      </bpmn:conditionalEventDefinition>`,
        }),
        'intermediate throw',
        'bpmn:ConditionalEventDefinition',
        'An emit supports escalation, message, signal, or compensation.',
      ],
    ] as const)(
      '%s refuses with UnsupportedEventDefinitionError naming what the position does take',
      async (_title, xml, eventKind, definitionType, supported) => {
        const e = await expectRefusal<UnsupportedEventDefinitionError>(
          xmlToIr(xml),
          UnsupportedEventDefinitionError,
        );
        expect(e.eventKind).toBe(eventKind);
        expect(e.definitionType).toBe(definitionType);
        expect(e.message).toContain(supported);
      },
    );
  });

  // ── 15c. Root honesty ────────────────────────────────────────────────────

  describe('root honesty', () => {
    it('two bpmn:Signal roots sharing one name, each referenced, collapse to one IR name with no warning', async () => {
      const xml = bpmnDefs`  <bpmn:signal id="Signal_A" name="Ping" />
  <bpmn:signal id="Signal_B" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:signalEventDefinition id="d1" signalRef="Signal_A" />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="Emit">
      <bpmn:signalEventDefinition id="d2" signalRef="Signal_B" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Emit" />
    <bpmn:sequenceFlow id="F2" sourceRef="Emit" targetRef="PEnd" />
  </bpmn:process>`;

      const { ir, warnings } = await xmlToIr(xml);
      expect(warnings).toEqual([]);
      const start = byId(subProcess(ir, 'Handler'), 'HStart');
      expect(start.kind === 'startEvent' && start.eventDefinition).toEqual(
        PING,
      );
      const emit = byId(ir, 'Emit');
      expect(
        emit.kind === 'intermediateThrowEvent' && emit.eventDefinition,
      ).toEqual(PING);
    });

    it('an unreferenced bpmn:Message root warns once', async () => {
      const xml = rootedDoc(
        '  <bpmn:message id="Message_Unused" name="Unused" />\n',
        `    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      );

      const { warnings } = await xmlToIr(xml);
      const unreferenced = warnings.filter(
        (w) => w.category === 'unreferencedRoot',
      );
      expect(unreferenced).toHaveLength(1);
      expect(unreferenced[0].elementId).toBe('Message_Unused');
    });

    it('itemRef on a referenced bpmn:Message root warns once and still imports', async () => {
      const xml = handlerDoc(
        '<bpmn:messageEventDefinition id="d" messageRef="Message_X" />',
        {
          roots: `  <bpmn:itemDefinition id="Item_1" />
  <bpmn:message id="Message_X" name="X" itemRef="Item_1" />\n`,
        },
      );

      const { ir, warnings } = await xmlToIr(xml);
      const start = byId(subProcess(ir, 'Handler'), 'HStart');
      expect(start.kind === 'startEvent' && start.eventDefinition).toEqual(
        messageDef('X'),
      );

      expect(warnings).toHaveLength(2);
      const [itemRefWarning, rootWarning] = warnings;
      expect(itemRefWarning.elementId).toBe('Message_X');
      expect(itemRefWarning.message).toContain('itemRef');
      // The item definition the itemRef pointed at is dropped in its own
      // right, and is reported in its own right.
      expect(rootWarning.elementId).toBe('Item_1');
      expect(rootWarning.message).toContain("bpmn:itemDefinition 'Item_1'");
    });
  });

  // ── 15d. camunda: parity + nesting ───────────────────────────────────────

  it('camunda:variableName on a conditional definition refuses the same way as operaton:variableName', async () => {
    const xml = handlerDoc(
      `<bpmn:conditionalEventDefinition id="d" camunda:variableName="amount">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>`,
      { body: '', defs: camundaDefs },
    );

    await expectRefusal(
      xmlToIr(xml),
      UnsupportedEventFeatureError,
      "a conditional definition's camunda:variableName narrows when the " +
        'condition is (re-)evaluated, which this tool cannot represent',
    );
  });

  it('a clean camunda:-free conditional handler is not false-refused', async () => {
    const xml = handlerDoc(`<bpmn:conditionalEventDefinition id="d">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>`);

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
    const start = byId(subProcess(ir, 'Handler'), 'HStart');
    expect(start.kind === 'startEvent' && start.eventDefinition).toEqual(
      conditionDef('${amount > 100}'),
    );
  });

  it('a timer handler nested inside a plain sub-process imports into the nested container', async () => {
    const xml = oneNodeDoc('subProcess', {
      id: 'Outer',
      doc: bpmnDoc,
      children: `<bpmn:startEvent id="OStart" />
      <bpmn:userTask id="Work" />
      <bpmn:endEvent id="OEnd" />
      <bpmn:subProcess id="InnerTimerHandler" triggeredByEvent="true">
        <bpmn:startEvent id="ITStart">
          <bpmn:timerEventDefinition id="itd">
            <bpmn:timeDuration>PT30M</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </bpmn:startEvent>
        <bpmn:endEvent id="ITEnd" />
        <bpmn:sequenceFlow id="SF_IT" sourceRef="ITStart" targetRef="ITEnd" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="SF_OStart_Work" sourceRef="OStart" targetRef="Work" />
      <bpmn:sequenceFlow id="SF_Work_OEnd" sourceRef="Work" targetRef="OEnd" />`,
    });

    const { node: outer, warnings } = await importOnly(xml, 'subProcess');
    expect(warnings).toEqual([]);

    const inner = subProcess(outer, 'InnerTimerHandler');
    expect(inner.triggeredByEvent).toBe(true);
    const innerStart = byId(inner, 'ITStart');
    expect(
      innerStart.kind === 'startEvent' && innerStart.eventDefinition,
    ).toEqual(timerDef('duration', 'PT30M'));
  });
});

// ── 16. Compensation import ──────────────────────────────────────────────────

describe('xmlToIr: compensation import', () => {
  // ── 16a. Full positive import ────────────────────────────────────────────

  const compensationXml = bpmnDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Booking">
      <bpmn:startEvent id="BStart" />
      <bpmn:userTask id="ReserveRoom" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
        <bpmn:startEvent id="UndoStart">
          <bpmn:compensateEventDefinition id="UndoStartDef" />
        </bpmn:startEvent>
        <bpmn:userTask id="CancelRoom" />
        <bpmn:endEvent id="UndoEnd" />
        <bpmn:sequenceFlow id="Flow_UndoStart_CancelRoom" sourceRef="UndoStart" targetRef="CancelRoom" />
        <bpmn:sequenceFlow id="Flow_CancelRoom_UndoEnd" sourceRef="CancelRoom" targetRef="UndoEnd" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="Flow_BStart_ReserveRoom" sourceRef="BStart" targetRef="ReserveRoom" />
      <bpmn:sequenceFlow id="Flow_ReserveRoom_BEnd" sourceRef="ReserveRoom" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="EmitUndo">
      <bpmn:compensateEventDefinition id="EmitUndoDef" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="ThrowUndo">
      <bpmn:compensateEventDefinition id="ThrowUndoDef" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_PStart_Booking" sourceRef="PStart" targetRef="Booking" />
    <bpmn:sequenceFlow id="Flow_Booking_EmitUndo" sourceRef="Booking" targetRef="EmitUndo" />
    <bpmn:sequenceFlow id="Flow_EmitUndo_ThrowUndo" sourceRef="EmitUndo" targetRef="ThrowUndo" />`;

  const COMPENSATION: EventDefinition = { kind: 'compensation' };

  const EXPECTED_COMPENSATION_IR: BpmnProcess = {
    ...chained(
      [
        { kind: 'startEvent', id: 'PStart' },
        chainedSub(
          'Booking',
          [
            { kind: 'startEvent', id: 'BStart' },
            { kind: 'userTask', id: 'ReserveRoom' },
            { kind: 'endEvent', id: 'BEnd' },
          ],
          {
            prefix: 'Flow',
            unwired: [
              triggeredSub(
                'UndoBooking',
                [
                  typedEvent('startEvent', 'UndoStart', COMPENSATION),
                  { kind: 'userTask', id: 'CancelRoom' },
                  { kind: 'endEvent', id: 'UndoEnd' },
                ],
                { prefix: 'Flow' },
              ),
            ],
          },
        ),
        typedEvent('intermediateThrowEvent', 'EmitUndo', COMPENSATION),
        typedEvent('endEvent', 'ThrowUndo', COMPENSATION),
      ],
      { prefix: 'Flow' },
    ),
    id: 'p',
  };

  it('imports a compensation handler hosted by the plain sub-process it compensates, a compensation emit, and a compensation throw, into the exact expected IR (deep equality), warnings: []', async () => {
    const { ir, warnings } = await xmlToIr(compensationXml);
    expect(ir).toEqual(EXPECTED_COMPENSATION_IR);
    expect(warnings).toEqual([]);
  });

  it('an explicit waitForCompletion="true" on both throw positions imports identically to the default (absent) form', async () => {
    const xml = compensationXml
      .replace(
        '<bpmn:compensateEventDefinition id="EmitUndoDef" />',
        '<bpmn:compensateEventDefinition id="EmitUndoDef" waitForCompletion="true" />',
      )
      .replace(
        '<bpmn:compensateEventDefinition id="ThrowUndoDef" />',
        '<bpmn:compensateEventDefinition id="ThrowUndoDef" waitForCompletion="true" />',
      );

    const { ir, warnings } = await xmlToIr(xml);
    expect(ir).toEqual(EXPECTED_COMPENSATION_IR);
    expect(warnings).toEqual([]);
  });

  // ── 16b. Refusals (one per shape) ─────────────────────────────────────────

  describe('refusals', () => {
    /** An `UndoBooking` compensation handler, `UndoStart -> UndoEnd`. */
    const undoHandler = (startAttrs = '', definitionAttrs = '') =>
      `<bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
        <bpmn:startEvent id="UndoStart" ${startAttrs}>
          <bpmn:compensateEventDefinition id="d" ${definitionAttrs} />
        </bpmn:startEvent>
        <bpmn:endEvent id="UndoEnd" />
        <bpmn:sequenceFlow id="Flow_UndoStart_UndoEnd" sourceRef="UndoStart" targetRef="UndoEnd" />
      </bpmn:subProcess>`;

    /** `S -> Booking -> E`, where the plain sub-process hosts `body`. */
    const bookingDoc = (body: string) =>
      oneNodeDoc('subProcess', {
        id: 'Booking',
        doc: bpmnDoc,
        children: `<bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      ${body}
      <bpmn:sequenceFlow id="Flow_BStart_BEnd" sourceRef="BStart" targetRef="BEnd" />`,
      });

    it.each([
      [
        'an activityRef on a compensation handler-start definition',
        bookingDoc(
          `<bpmn:userTask id="ReserveRoom" />
      ${undoHandler('', 'activityRef="ReserveRoom"')}`,
        ),
        'a compensation definition targets one activity by reference ' +
          '(activityRef="ReserveRoom"); this tool always addresses the ' +
          'enclosing scope and cannot target a single activity',
      ],
      [
        'an activityRef on a compensation end-event definition',
        rootedDoc(
          '',
          `    <bpmn:userTask id="T" />
    <bpmn:endEvent id="ThrowUndo">
      <bpmn:compensateEventDefinition id="d" activityRef="T" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_S_T" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="Flow_T_ThrowUndo" sourceRef="T" targetRef="ThrowUndo" />`,
        ),
        'a compensation definition targets one activity by reference ' +
          '(activityRef="T"); this tool always addresses the enclosing ' +
          'scope and cannot target a single activity',
      ],
      [
        'waitForCompletion="false" on an intermediate throw',
        oneNodeDoc('intermediateThrowEvent', {
          id: 'EmitUndo',
          doc: bpmnDoc,
          children:
            '<bpmn:compensateEventDefinition id="d" waitForCompletion="false" />',
        }),
        'a compensation definition sets waitForCompletion="false"; this ' +
          'tool only imports the default (wait for the compensation to ' +
          'complete) behavior',
      ],
      [
        'waitForCompletion="false" on an end event',
        rootedDoc(
          '',
          `    <bpmn:endEvent id="ThrowUndo">
      <bpmn:compensateEventDefinition id="d" waitForCompletion="false" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_S_ThrowUndo" sourceRef="S" targetRef="ThrowUndo" />`,
        ),
        'a compensation definition sets waitForCompletion="false"; this ' +
          'tool only imports the default (wait for the compensation to ' +
          'complete) behavior',
      ],
      [
        'isInterrupting="false" on a compensation handler start',
        bookingDoc(undoHandler('isInterrupting="false"')),
        'a compensation handler cannot be non-interrupting ' +
          '(isInterrupting="false"); BPMN requires a compensation trigger ' +
          'to interrupt its scope',
      ],
    ] as const)(
      '%s refuses with UnsupportedEventFeatureError naming the feature',
      async (_title, xml, detail) => {
        await expectRefusal(xmlToIr(xml), UnsupportedEventFeatureError, detail);
      },
    );

    it.each([
      [
        'a compensation event sub-process hosted directly by the process',
        bpmnDoc`    <bpmn:startEvent id="S" />
    ${undoHandler()}
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
        'the process',
      ],
      [
        'a compensation event sub-process hosted by another event sub-process',
        bpmnDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="OuterHandler" triggeredByEvent="true">
      <bpmn:startEvent id="OuterStart">
        <bpmn:errorEventDefinition id="od" />
      </bpmn:startEvent>
      ${undoHandler()}
      <bpmn:endEvent id="OuterEnd" />
      <bpmn:sequenceFlow id="Flow_OuterStart_OuterEnd" sourceRef="OuterStart" targetRef="OuterEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="PEnd" />`,
        'another event subprocess',
      ],
    ] as const)(
      '%s refuses with UnsupportedEventFeatureError naming the host',
      async (_title, xml, host) => {
        const { detail } = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
        );
        expect(detail).toContain(host);
        expect(detail).toContain('compensat');
      },
    );

    it.each([
      [
        'a service task',
        oneNodeDoc('serviceTask', {
          id: 'CancelReservation',
          attrs: 'operaton:class="com.example.Cancel" isForCompensation="true"',
        }),
        'CancelReservation',
      ],
      [
        'a sub-process',
        oneNodeDoc('subProcess', {
          id: 'UndoBlock',
          attrs: 'isForCompensation="true"',
          doc: bpmnDoc,
          children: `<bpmn:startEvent id="US" />
      <bpmn:endEvent id="UE" />
      <bpmn:sequenceFlow id="Flow_US_UE" sourceRef="US" targetRef="UE" />`,
        }),
        'UndoBlock',
      ],
    ] as const)(
      'isForCompensation="true" on %s refuses with UnsupportedEventFeatureError',
      async (_title, xml, elementId) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
          IS_FOR_COMPENSATION_DETAIL,
        );
        expect(e.elementId).toBe(elementId);
      },
    );

    it('a compensation boundary event refuses with UnsupportedEventFeatureError naming the subprocess undo block', async () => {
      const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />
    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />`;

      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(xml),
        UnsupportedEventFeatureError,
      );
      expect(e.elementId).toBe('CompensationBoundary');
      expect(e.detail).toContain('compensation');
      expect(e.detail).toContain('on compensation');
    });
  });

  // ── 16c. Six prior kinds untouched + deeper nesting ──────────────────────

  it('a compensation handler nested inside a plain sub-process nested inside another plain sub-process imports into the deepest container', async () => {
    const xml = oneNodeDoc('subProcess', {
      id: 'Outer',
      doc: bpmnDoc,
      children: `<bpmn:startEvent id="OStart" />
      <bpmn:subProcess id="Inner">
        <bpmn:startEvent id="IStart" />
        <bpmn:userTask id="ReserveRoom" />
        <bpmn:endEvent id="IEnd" />
        <bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
          <bpmn:startEvent id="UndoStart">
            <bpmn:compensateEventDefinition id="UndoStartDef" />
          </bpmn:startEvent>
          <bpmn:endEvent id="UndoEnd" />
          <bpmn:sequenceFlow id="Flow_UndoStart_UndoEnd" sourceRef="UndoStart" targetRef="UndoEnd" />
        </bpmn:subProcess>
        <bpmn:sequenceFlow id="Flow_IStart_ReserveRoom" sourceRef="IStart" targetRef="ReserveRoom" />
        <bpmn:sequenceFlow id="Flow_ReserveRoom_IEnd" sourceRef="ReserveRoom" targetRef="IEnd" />
      </bpmn:subProcess>
      <bpmn:endEvent id="OEnd" />
      <bpmn:sequenceFlow id="Flow_OStart_Inner" sourceRef="OStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="Flow_Inner_OEnd" sourceRef="Inner" targetRef="OEnd" />`,
    });

    const { node: outer, warnings } = await importOnly(xml, 'subProcess');
    expect(warnings).toEqual([]);

    const handler = subProcess(subProcess(outer, 'Inner'), 'UndoBooking');
    expect(handler.triggeredByEvent).toBe(true);

    const start = byId(handler, 'UndoStart');
    expect(start.kind === 'startEvent' && start.eventDefinition).toEqual({
      kind: 'compensation',
    });
    expect(start.kind === 'startEvent' && start.isInterrupting).toBeUndefined();
  });
});

// ── 17. Boundary event import ────────────────────────────────────────────────

describe('xmlToIr: boundary event import', () => {
  // ── 17a. Full positive import: six triggers, cancelActivity, escalation host ─

  const boundaryXml = bpmnDefs`  <bpmn:error id="Error_Oops" errorCode="OOPS" />
  <bpmn:message id="Message_Ping" name="Ping" />
  <bpmn:signal id="Signal_Go" name="Go" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:subProcess id="Booking">
      <bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:sequenceFlow id="SF_Booking" sourceRef="BStart" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:boundaryEvent id="Boundary_Review_error" attachedToRef="Review">
      <bpmn:errorEventDefinition id="ErrDef" errorRef="Error_Oops" />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Review_message" attachedToRef="Review" cancelActivity="false">
      <bpmn:messageEventDefinition id="MsgDef" messageRef="Message_Ping" />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Review_signal" attachedToRef="Review">
      <bpmn:signalEventDefinition id="SigDef" signalRef="Signal_Go" />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT2H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Review_condition" attachedToRef="Review">
      <bpmn:conditionalEventDefinition id="CondDef">
        <bpmn:condition>\${flag}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Booking_escalation" attachedToRef="Booking">
      <bpmn:escalationEventDefinition id="EscDef" />
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Booking" />
    <bpmn:sequenceFlow id="F3" sourceRef="Booking" targetRef="PEnd" />
  </bpmn:process>`;

  const EXPECTED_BOUNDARY_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'PStart' },
      { kind: 'userTask', id: 'Review' },
      {
        kind: 'subProcess',
        id: 'Booking',
        flowElements: [
          { kind: 'startEvent', id: 'BStart' },
          { kind: 'endEvent', id: 'BEnd' },
        ],
        sequenceFlows: [
          { id: 'SF_Booking', sourceRef: 'BStart', targetRef: 'BEnd' },
        ],
      },
      { kind: 'endEvent', id: 'PEnd' },
      boundaryEvent('Boundary_Review_error', 'Review', errorDef('OOPS')),
      boundaryEvent(
        'Boundary_Review_message',
        'Review',
        messageDef('Ping'),
        false,
      ),
      boundaryEvent('Boundary_Review_signal', 'Review', signalDef('Go')),
      boundaryEvent(
        'Boundary_Review_timer',
        'Review',
        timerDef('duration', 'PT2H'),
      ),
      boundaryEvent(
        'Boundary_Review_condition',
        'Review',
        conditionDef('${flag}'),
      ),
      boundaryEvent('Boundary_Booking_escalation', 'Booking', {
        kind: 'escalation',
      }),
    ],
    [
      { id: 'F1', sourceRef: 'PStart', targetRef: 'Review' },
      { id: 'F2', sourceRef: 'Review', targetRef: 'Booking' },
      { id: 'F3', sourceRef: 'Booking', targetRef: 'PEnd' },
    ],
  );

  it('imports all six boundary triggers with the right attachedToRef, cancelActivity, and an escalation boundary on a sub-process host, with zero warnings', async () => {
    const { ir, warnings } = await xmlToIr(boundaryXml);
    expect(ir).toEqual(EXPECTED_BOUNDARY_IR);
    expect(warnings).toEqual([]);
  });

  it('a boundary event on a host nested inside a sub-process imports at that depth', async () => {
    const xml = bpmnDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Outer">
      <bpmn:startEvent id="OStart" />
      <bpmn:userTask id="Pack" />
      <bpmn:boundaryEvent id="Boundary_Pack_timer" attachedToRef="Pack">
        <bpmn:timerEventDefinition id="TimerDef">
          <bpmn:timeDuration>PT30M</bpmn:timeDuration>
        </bpmn:timerEventDefinition>
      </bpmn:boundaryEvent>
      <bpmn:endEvent id="OEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="OStart" targetRef="Pack" />
      <bpmn:sequenceFlow id="SF2" sourceRef="Pack" targetRef="OEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="F2" sourceRef="Outer" targetRef="PEnd" />`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);

    expect(byId(subProcess(ir, 'Outer'), 'Boundary_Pack_timer')).toEqual(
      boundaryEvent(
        'Boundary_Pack_timer',
        'Pack',
        timerDef('duration', 'PT30M'),
      ),
    );
  });

  // ── 17b. Refusals (one per shape) ───────────────────────────────────────

  const TIMER_1H = `<bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>`;

  /** `PStart -> Review -> PEnd`, carrying the given boundary block. */
  const reviewBoundaryDoc = (
    boundary: string,
    extraFlows = '',
    doc = bpmnDoc,
  ): string =>
    doc`    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    ${boundary}
    <bpmn:endEvent id="PEnd" />
${extraFlows}    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />`;

  describe('refusals', () => {
    /**
     * The whole refusal an attachedToRef that names nothing attachable draws.
     * It enumerates every host noun, so pinning it whole pins that list.
     */
    const unattachableDetail = (ref: string): string =>
      `attachedToRef "${ref}" does not name a plain task, user task, ` +
      'service task, send task, business rule task, receive task, script ' +
      'task, subprocess, attempt block, or call activity that is itself a ' +
      'flow element of this same container; a boundary event can only ' +
      'attach to an activity alongside it';

    it.each([
      [
        'a missing attachedToRef',
        reviewBoundaryDoc(`<bpmn:boundaryEvent id="Orphan">
      ${TIMER_1H}
    </bpmn:boundaryEvent>`),
        'a boundary event has no attachedToRef; BPMN requires every ' +
          'boundary event to attach to an activity in its own container',
        'Orphan',
      ],
      [
        'an incoming sequence flow',
        reviewBoundaryDoc(
          `<bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      <bpmn:incoming>F0</bpmn:incoming>
      ${TIMER_1H}
    </bpmn:boundaryEvent>`,
          '    <bpmn:sequenceFlow id="F0" sourceRef="PStart" targetRef="Boundary_Review_timer" />\n',
        ),
        'a boundary event carries an incoming sequence flow; it is ' +
          'triggered by its own event, not by an incoming flow',
        'Boundary_Review_timer',
      ],
      [
        'an operaton:inputOutput mapping',
        reviewBoundaryDoc(
          `<bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="foo">bar</operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
      ${TIMER_1H}
    </bpmn:boundaryEvent>`,
          '',
          operatonDoc,
        ),
        'a boundary event carries an operaton:inputOutput mapping; ' +
          'Operaton forbids input/output variable mappings on a boundary ' +
          'event',
        'Boundary_Review_timer',
      ],
      [
        'cancelActivity="false" on an error boundary',
        reviewBoundaryDoc(`<bpmn:boundaryEvent id="Boundary_Review_error" attachedToRef="Review" cancelActivity="false">
      <bpmn:errorEventDefinition id="ErrDef" />
    </bpmn:boundaryEvent>`),
        'an error boundary event cannot be non-interrupting ' +
          '(cancelActivity="false"); BPMN gives an error boundary no ' +
          'non-interrupting form',
        'Boundary_Review_error',
      ],
      [
        'an attachedToRef naming an activity in a different container',
        bpmnDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Elsewhere">
      <bpmn:startEvent id="EStart" />
      <bpmn:userTask id="Other" />
      <bpmn:endEvent id="EEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="EStart" targetRef="Other" />
      <bpmn:sequenceFlow id="SF2" sourceRef="Other" targetRef="EEnd" />
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="Boundary_Other_timer" attachedToRef="Other">
      ${TIMER_1H}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Elsewhere" />
    <bpmn:sequenceFlow id="F2" sourceRef="Elsewhere" targetRef="PEnd" />`,
        unattachableDetail('Other'),
        'Boundary_Other_timer',
      ],
      [
        // The mirror of the case above: nesting runs its own host check over
        // its own container, so an id one level out is not in scope.
        'a boundary event inside a sub-process attached to an id in the outer process',
        bpmnDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Outer" />
    <bpmn:subProcess id="Wrap">
      <bpmn:startEvent id="WStart" />
      <bpmn:userTask id="Inner" />
      <bpmn:boundaryEvent id="Boundary_Outer_timer" attachedToRef="Outer">
        ${TIMER_1H}
      </bpmn:boundaryEvent>
      <bpmn:endEvent id="WEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="WStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="SF2" sourceRef="Inner" targetRef="WEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="F2" sourceRef="Outer" targetRef="Wrap" />
    <bpmn:sequenceFlow id="F3" sourceRef="Wrap" targetRef="PEnd" />`,
        unattachableDetail('Outer'),
        'Boundary_Outer_timer',
      ],
      [
        'an attachedToRef naming a gateway in the same container',
        bpmnDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:exclusiveGateway id="Choose" />
    <bpmn:boundaryEvent id="Boundary_Choose_timer" attachedToRef="Choose">
      ${TIMER_1H}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Choose" />
    <bpmn:sequenceFlow id="F2" sourceRef="Choose" targetRef="PEnd" />`,
        unattachableDetail('Choose'),
        'Boundary_Choose_timer',
      ],
      [
        // An event sub-process is authored as a bare `on <trigger> { ... }` and
        // carries no id or name of its own, so nothing could name it as a host.
        'an attachedToRef naming an event sub-process',
        reviewBoundaryDoc(`<bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition id="HErrDef" />
      </bpmn:startEvent>
      <bpmn:userTask id="Recover" />
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="HF1" sourceRef="HStart" targetRef="Recover" />
      <bpmn:sequenceFlow id="HF2" sourceRef="Recover" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="Boundary_Handler_timer" attachedToRef="Handler">
      ${TIMER_1H}
    </bpmn:boundaryEvent>`),
        unattachableDetail('Handler'),
        'Boundary_Handler_timer',
      ],
      [
        // `<bpmn:incoming>` is optional in BPMN and moddle fills `incoming`
        // from those children alone, so the flow's own targetRef is what has
        // to be checked; Operaton reads it either way.
        'a sequence flow targeting a boundary event with no bpmn:incoming child',
        reviewBoundaryDoc(
          `<bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      ${TIMER_1H}
    </bpmn:boundaryEvent>`,
          '    <bpmn:sequenceFlow id="F0" sourceRef="PStart" targetRef="Boundary_Review_timer" />\n',
        ),
        'a boundary event carries an incoming sequence flow; it is ' +
          'triggered by its own event, not by an incoming flow',
        'Boundary_Review_timer',
      ],
    ] as const)(
      '%s refuses with UnsupportedEventFeatureError naming the feature',
      async (_title, xml, detail, elementId) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
          detail,
        );
        expect(e.elementId).toBe(elementId);
      },
    );

    it('the host refusal enumerates every kind a boundary may attach to', async () => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(
          bpmnDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:exclusiveGateway id="Choose" />
    <bpmn:boundaryEvent id="Boundary_Choose_timer" attachedToRef="Choose">
      ${TIMER_1H}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Choose" />
    <bpmn:sequenceFlow id="F2" sourceRef="Choose" targetRef="PEnd" />`,
        ),
        UnsupportedEventFeatureError,
      );
      expect(e.detail).toBe(
        'attachedToRef "Choose" does not name a plain task, user task, ' +
          'service task, send task, business rule task, receive task, script ' +
          'task, subprocess, attempt block, or call activity that is itself a ' +
          'flow element of this same container; a boundary event can only ' +
          'attach to an activity alongside it',
      );
    });

    it('a trigger definition kind the boundary position does not take refuses with UnsupportedEventDefinitionError naming it', async () => {
      const e = await expectRefusal<UnsupportedEventDefinitionError>(
        xmlToIr(
          reviewBoundaryDoc(`<bpmn:boundaryEvent id="Boundary_Review_link" attachedToRef="Review">
      <bpmn:linkEventDefinition id="LinkDef" name="Resume" />
    </bpmn:boundaryEvent>`),
        ),
        UnsupportedEventDefinitionError,
      );
      expect(e.eventKind).toBe('boundary');
      expect(e.definitionType).toBe('bpmn:LinkEventDefinition');
      expect(e.message).toContain(
        'A boundary event supports error, escalation, message, signal, ' +
          'timer, or conditional, plus cancel on a block that can be given up.',
      );
    });

    it('an escalation boundary on a service task refuses with UnsupportedEventFeatureError naming the legal host kinds', async () => {
      const xml = operatonDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:serviceTask id="Ship" operaton:class="com.example.Ship" />
    <bpmn:boundaryEvent id="Boundary_Ship_escalation" attachedToRef="Ship">
      <bpmn:escalationEventDefinition id="EscDef" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Ship" />
    <bpmn:sequenceFlow id="F2" sourceRef="Ship" targetRef="PEnd" />`;

      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(xml),
        UnsupportedEventFeatureError,
      );
      expect(e.elementId).toBe('Boundary_Ship_escalation');
      expect(e.detail).toBe(
        'an escalation boundary event attaches to "Ship", a service task; ' +
          'Operaton only allows an escalation boundary on a subprocess, a ' +
          'call activity, or a user task',
      );
    });
  });

  // ── 17c. Host resolution independent of document order, and the label drop ──

  it('a boundary event written before its host imports cleanly', async () => {
    // The whole reason host checking is a post-loop pass: moddle presents
    // children in document order, and BPMN does not require the host first.
    const xml = bpmnDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      ${TIMER_1H}
    </bpmn:boundaryEvent>
    <bpmn:userTask id="Review" />
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />`;

    const { node, warnings } = await importOnly(xml, 'boundaryEvent');
    expect(warnings).toEqual([]);
    expect(node).toEqual(
      boundaryEvent(
        'Boundary_Review_timer',
        'Review',
        timerDef('duration', 'PT1H'),
      ),
    );
  });

  it('a name on a boundary event is dropped with exactly one label warning', async () => {
    const xml =
      reviewBoundaryDoc(`<bpmn:boundaryEvent id="Boundary_Review_timer" name="Timed out" attachedToRef="Review">
      ${TIMER_1H}
    </bpmn:boundaryEvent>`);

    const { warnings } = await xmlToIr(xml);
    const labelWarnings = warnings.filter((w) => w.category === 'label');
    expect(labelWarnings).toHaveLength(1);
    expect(labelWarnings[0]!.elementId).toBe('Boundary_Review_timer');
    expect(labelWarnings[0]!.message).toContain('Timed out');
    expect(labelWarnings[0]!.message).toContain('a boundary event');
  });
});

// ── 18. Intermediate catch event import ──────────────────────────────────────

describe('xmlToIr: intermediate catch event import', () => {
  // ── 18a. Map: the four supported triggers, on the main flow ────────────────

  it('imports message, timer (duration/date/cycle), signal, and conditional catches into the exact expected IR, incoming/outgoing preserved, warnings: []', async () => {
    const xml = bpmnDefs`  <bpmn:message id="Message_Pay" name="PaymentReceived" />
  <bpmn:signal id="Signal_Ping" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="WaitMsg">
      <bpmn:messageEventDefinition id="WaitMsgDef" messageRef="Message_Pay" />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitDur">
      <bpmn:timerEventDefinition id="WaitDurDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitDate">
      <bpmn:timerEventDefinition id="WaitDateDef">
        <bpmn:timeDate>2026-08-01T09:00:00</bpmn:timeDate>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitCycle">
      <bpmn:timerEventDefinition id="WaitCycleDef">
        <bpmn:timeCycle>R3/PT10M</bpmn:timeCycle>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitSig">
      <bpmn:signalEventDefinition id="WaitSigDef" signalRef="Signal_Ping" />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitCond">
      <bpmn:conditionalEventDefinition id="WaitCondDef">
        <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="WaitMsg" />
    <bpmn:sequenceFlow id="F2" sourceRef="WaitMsg" targetRef="WaitDur" />
    <bpmn:sequenceFlow id="F3" sourceRef="WaitDur" targetRef="WaitDate" />
    <bpmn:sequenceFlow id="F4" sourceRef="WaitDate" targetRef="WaitCycle" />
    <bpmn:sequenceFlow id="F5" sourceRef="WaitCycle" targetRef="WaitSig" />
    <bpmn:sequenceFlow id="F6" sourceRef="WaitSig" targetRef="WaitCond" />
    <bpmn:sequenceFlow id="F7" sourceRef="WaitCond" targetRef="End" />
  </bpmn:process>`;

    const waits = (
      id: string,
      eventDefinition: IntermediateCatchEvent['eventDefinition'],
    ): FlowElement => ({ kind: 'intermediateCatchEvent', id, eventDefinition });

    const chain: FlowElement[] = [
      { kind: 'startEvent', id: 'Start' },
      waits('WaitMsg', messageDef('PaymentReceived')),
      waits('WaitDur', timerDef('duration', 'PT1H')),
      waits('WaitDate', timerDef('date', '2026-08-01T09:00:00')),
      waits('WaitCycle', timerDef('cycle', 'R3/PT10M')),
      waits('WaitSig', signalDef('Ping')),
      waits('WaitCond', conditionDef('${amount > 100}')),
      { kind: 'endEvent', id: 'End' },
    ];

    const expectedIr: BpmnProcess = minimalProcess(
      chain,
      chain.slice(1).map((el, i) => ({
        id: `F${i + 1}`,
        sourceRef: chain[i]!.id,
        targetRef: el.id,
      })),
    );

    const { ir, warnings } = await xmlToIr(xml);
    expect(ir).toEqual(expectedIr);
    expect(warnings).toEqual([]);

    // Every catch sits on the main flow: exactly one incoming and one
    // outgoing sequence flow apiece.
    for (const catchId of [
      'WaitMsg',
      'WaitDur',
      'WaitDate',
      'WaitCycle',
      'WaitSig',
      'WaitCond',
    ]) {
      expect(
        ir.sequenceFlows.filter((f) => f.targetRef === catchId),
      ).toHaveLength(1);
      expect(
        ir.sequenceFlows.filter((f) => f.sourceRef === catchId),
      ).toHaveLength(1);
    }
  });

  it('a genuine label on an intermediate catch is dropped with exactly one label warning', async () => {
    const xml = bpmnDefs`  <bpmn:message id="Message_Pay" name="PaymentReceived" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Wait" name="Awaiting payment">
      <bpmn:messageEventDefinition id="d" messageRef="Message_Pay" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />
  </bpmn:process>`;

    const { warnings } = await xmlToIr(xml);
    const labelWarnings = warnings.filter((w) => w.category === 'label');
    expect(labelWarnings).toHaveLength(1);
    expect(labelWarnings[0]!.elementId).toBe('Wait');
    expect(labelWarnings[0]!.message).toContain('Awaiting payment');
    expect(labelWarnings[0]!.message).toContain('an await');
  });

  // ── 18b. Refuse trigger: link, error, escalation, compensation, cancel ─────

  /** `S -> Wait -> E`, where the catch carries the given definition. */
  const unsupportedTriggerXml = (definitionXml: string, doc = bpmnDoc) =>
    oneNodeDoc('intermediateCatchEvent', {
      id: 'Wait',
      children: definitionXml,
      doc,
    });

  describe('refuses an unsupported trigger', () => {
    /**
     * The whole refusal a trigger no await admits draws. It enumerates where
     * each refused trigger does have a surface, so pinning it whole pins that.
     */
    const unawaitableDetail = (tag: string): string =>
      `an await cannot carry a bpmn:${tag}: only message, timer, signal, ` +
      'or conditional triggers can be awaited inline; error and escalation ' +
      'are caught by an event handler and raised with throw/emit, ' +
      'compensation is undone by a subprocess block, a link has no surface, ' +
      'and a cancel is written on the end that gives up an attempt block';

    it.each([
      [
        'link',
        '<bpmn:linkEventDefinition id="d" name="X" />',
        unawaitableDetail('LinkEventDefinition'),
      ],
      [
        'error',
        '<bpmn:errorEventDefinition id="d" />',
        unawaitableDetail('ErrorEventDefinition'),
      ],
      [
        'escalation',
        '<bpmn:escalationEventDefinition id="d" />',
        unawaitableDetail('EscalationEventDefinition'),
      ],
      [
        'compensation',
        '<bpmn:compensateEventDefinition id="d" />',
        unawaitableDetail('CompensateEventDefinition'),
      ],
      [
        'cancel',
        '<bpmn:cancelEventDefinition id="d" />',
        unawaitableDetail('CancelEventDefinition'),
      ],
    ] as const)(
      'a %s trigger refuses with UnsupportedEventFeatureError naming the form',
      async (_label, definitionXml, detail) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(unsupportedTriggerXml(definitionXml)),
          UnsupportedEventFeatureError,
          detail,
        );
        expect(e.elementId).toBe('Wait');
      },
    );
  });

  // ── 18c. Refuse multiple: >1 event definition, or parallelMultiple ─────────

  describe('refuses multiple triggers', () => {
    const signalRootDoc = (attrs: string, definitions: string) =>
      rootedDoc(
        '  <bpmn:signal id="Signal_Ping" name="Ping" />\n',
        `    <bpmn:intermediateCatchEvent id="Wait" ${attrs}>
${definitions}
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />`,
      );

    it.each([
      [
        'two event definitions on one catch',
        signalRootDoc(
          '',
          `      <bpmn:timerEventDefinition id="d1">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
      <bpmn:signalEventDefinition id="d2" signalRef="Signal_Ping" />`,
        ),
        'an await carries 2 event definitions: only a single message, ' +
          'timer, signal, or conditional trigger can be awaited',
      ],
      [
        'parallelMultiple="true"',
        signalRootDoc(
          'parallelMultiple="true"',
          '      <bpmn:signalEventDefinition id="d" signalRef="Signal_Ping" />',
        ),
        'an await with parallelMultiple="true" waits for several triggers ' +
          'together; only a single message, timer, signal, or conditional ' +
          'trigger can be awaited',
      ],
      [
        'a "none" catch with zero event definitions',
        oneNodeDoc('intermediateCatchEvent', { id: 'Wait', doc: bpmnDoc }),
        'an await with no event definition (a "none" intermediate catch) ' +
          'waits for nothing this tool can represent',
      ],
      [
        // Narrowing inherited from the shared catch-definition read.
        'operaton:variableName on a conditional catch',
        unsupportedTriggerXml(
          `<bpmn:conditionalEventDefinition id="d" operaton:variableName="amount">
        <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
      </bpmn:conditionalEventDefinition>`,
          operatonDoc,
        ),
        "a conditional definition's operaton:variableName narrows when the " +
          'condition is (re-)evaluated, which this tool cannot represent',
      ],
    ] as const)(
      '%s refuses with UnsupportedEventFeatureError naming the form',
      async (_title, xml, detail) => {
        await expectRefusal(xmlToIr(xml), UnsupportedEventFeatureError, detail);
      },
    );
  });
});

// ── 19. Flat engine settings import as named IR fields ───────────────────────

describe('xmlToIr: flat engine settings on a user task', () => {
  const importUserTask = (attrs: string, children = '') =>
    importOnly(oneNodeDoc('userTask', { attrs, children }), 'userTask');

  it('carries every setting written on the task verbatim, warning about none', async () => {
    const { node, warnings } = await importUserTask(
      'operaton:asyncBefore="true" operaton:asyncAfter="true" ' +
        'operaton:exclusive="false" operaton:jobPriority="50" ' +
        'operaton:candidateGroups="managers,ops" ' +
        'operaton:candidateUsers="alice,bob" ' +
        'operaton:dueDate="2026-08-01T09:00:00" ' +
        'operaton:followUpDate="${followUp}" ' +
        'operaton:priority="7"',
      // The form data and the retry cycle share one extensionElements wrapper,
      // so reading either has to leave the other for its own consumer.
      extensionElements(`        <operaton:formData>
          <operaton:formField id="amount" type="long" label="Amount" />
        </operaton:formData>
        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>`),
    );
    expect(node).toEqual({
      kind: 'userTask',
      id: 'T',
      asyncBefore: true,
      asyncAfter: true,
      exclusive: false,
      jobPriority: '50',
      candidateGroups: 'managers,ops',
      candidateUsers: 'alice,bob',
      dueDate: '2026-08-01T09:00:00',
      followUpDate: '${followUp}',
      priority: '7',
      formFields: [{ id: 'amount', type: 'number', label: 'Amount' }],
      retryCycle: 'R3/PT10M',
    });
    expect(warnings).toEqual([]);

    // A job priority takes an expression as readily as an integer.
    const expression = await importUserTask('operaton:jobPriority="${high}"');
    expect(expression.node.jobPriority).toBe('${high}');
    expect(expression.warnings).toEqual([]);
  });

  it('carries nothing, and warns nothing, for a flag written at its engine default', async () => {
    const { node, warnings } = await importUserTask(
      'operaton:asyncBefore="false" operaton:asyncAfter="false" ' +
        'operaton:exclusive="true"',
    );
    expect(node).toEqual({ kind: 'userTask', id: 'T' });
    expect(warnings).toEqual([]);
  });
});
describe('xmlToIr: flat engine settings honor the camunda: alias', () => {
  const importUserTask = (attrs: string) =>
    importOnly(oneNodeDoc('userTask', { attrs, doc: dualDoc }), 'userTask');

  it('reads camunda:asyncBefore, camunda:exclusive, and camunda:candidateGroups', async () => {
    const { node: task, warnings } = await importUserTask(
      'camunda:asyncBefore="true" camunda:exclusive="false" ' +
        'camunda:candidateGroups="managers"',
    );
    expect(task).toEqual({
      kind: 'userTask',
      id: 'T',
      asyncBefore: true,
      exclusive: false,
      candidateGroups: 'managers',
    });
    expect(warnings).toEqual([]);
  });

  it('operaton: wins over camunda: when both spell the same setting', async () => {
    const { node: task, warnings } = await importUserTask(
      'operaton:exclusive="true" camunda:exclusive="false"',
    );
    expect(task).toEqual({ kind: 'userTask', id: 'T' });
    expect(warnings).toEqual([]);
  });
});

describe('xmlToIr: flat engine settings on every carrying node kind', () => {
  const everyKindXml = operatonDefs`  <bpmn:escalation id="Escalation_Up" escalationCode="UP" />
  <bpmn:process id="p" isExecutable="true" operaton:versionTag="1.4">
    <bpmn:startEvent id="Start" operaton:asyncBefore="true" />
    <bpmn:userTask id="Review" operaton:asyncBefore="true" />
    <bpmn:serviceTask id="Charge" operaton:class="com.example.Charge"
                      operaton:asyncBefore="true" operaton:resultVariable="receipt" />
    <bpmn:scriptTask id="Calc" scriptFormat="javascript"
                     operaton:asyncBefore="true" operaton:resultVariable="total">
      <bpmn:script>1 + 1</bpmn:script>
    </bpmn:scriptTask>
    <bpmn:subProcess id="Booking" operaton:asyncBefore="true">
      <bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:sequenceFlow id="SF_Booking" sourceRef="BStart" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:callActivity id="Sub" calledElement="other" operaton:asyncBefore="true" />
    <bpmn:intermediateThrowEvent id="Emit" operaton:asyncBefore="true">
      <bpmn:escalationEventDefinition escalationRef="Escalation_Up" />
    </bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="Wait" operaton:asyncBefore="true">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" operaton:asyncBefore="true" />
    <bpmn:boundaryEvent id="Boundary" attachedToRef="Review" operaton:asyncBefore="true">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT2H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Charge" />
    <bpmn:sequenceFlow id="F3" sourceRef="Charge" targetRef="Calc" />
    <bpmn:sequenceFlow id="F4" sourceRef="Calc" targetRef="Booking" />
    <bpmn:sequenceFlow id="F5" sourceRef="Booking" targetRef="Sub" />
    <bpmn:sequenceFlow id="F6" sourceRef="Sub" targetRef="Emit" />
    <bpmn:sequenceFlow id="F7" sourceRef="Emit" targetRef="Wait" />
    <bpmn:sequenceFlow id="F8" sourceRef="Wait" targetRef="End" />
  </bpmn:process>`;

  it('every kind carries its own asyncBefore, alongside the process versionTag and the two resultVariables', async () => {
    const { ir, warnings } = await xmlToIr(everyKindXml);
    const asyncById = Object.fromEntries(
      ir.flowElements.map((fe) => [
        fe.id,
        fe.kind === 'exclusiveGateway' || fe.kind === 'parallelGateway'
          ? undefined
          : fe.asyncBefore,
      ]),
    );
    expect(asyncById).toEqual({
      Start: true,
      Review: true,
      Charge: true,
      Calc: true,
      Booking: true,
      Sub: true,
      Emit: true,
      Wait: true,
      End: true,
      Boundary: true,
    });
    expect(warnings).toEqual([]);

    const service = byId(ir, 'Charge');
    const script = byId(ir, 'Calc');
    expect(service.kind === 'serviceTask' && service.resultVariable).toBe(
      'receipt',
    );
    expect(script.kind === 'scriptTask' && script.resultVariable).toBe('total');
    expect(ir.versionTag).toBe('1.4');
  });

  it('an event handler and its trigger start each carry their own settings', async () => {
    const xml = operatonDefs`  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true" operaton:asyncBefore="true">
      <bpmn:startEvent id="HStart" operaton:asyncAfter="true">
        <bpmn:errorEventDefinition errorRef="Error_X" />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

    const { ir, warnings } = await xmlToIr(xml);
    const handler = subProcess(ir, 'Handler');
    expect(handler.asyncBefore).toBe(true);
    const start = byId(handler, 'HStart');
    expect(start.kind === 'startEvent' && start.asyncAfter).toBe(true);
    expect(warnings).toEqual([]);
  });
});

// ── 19b. The drop sweep is owner-aware: content is consumed only where it is
// actually read, and reported everywhere else. ───────────────────────────────

describe('xmlToIr: engine settings on a gateway stay a reported drop', () => {
  const gatewayXml = (attrs: string, children = ''): string =>
    oneNodeDoc('exclusiveGateway', { id: 'G', attrs, children });

  it.each([
    {
      carrier: 'an operaton:asyncBefore attribute',
      attrs: 'operaton:asyncBefore="true"',
      children: '',
      message: 'asyncBefore',
    },
    {
      carrier: 'an operaton:failedJobRetryTimeCycle child',
      attrs: '',
      children: extensionElements(
        '        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>',
      ),
      message: /FailedJobRetryTimeCycle/i,
    },
    {
      carrier: 'an operaton:inputOutput child (no gateway IR node carries one)',
      attrs: '',
      children: extensionElements(`        <operaton:inputOutput>
          <operaton:inputParameter name="foo">bar</operaton:inputParameter>
        </operaton:inputOutput>`),
      message: /InputOutput/i,
    },
  ])('warns for $carrier and carries nothing', async (row) => {
    const { ir, warnings } = await xmlToIr(gatewayXml(row.attrs, row.children));
    expect(byId(ir, 'G')).toEqual(gateway('G'));
    expectOneWarning(extensionWarnings(warnings), {
      elementId: 'G',
      message: row.message,
    });
  });
});

describe('xmlToIr: content is consumed only on the owner kind that reads it', () => {
  const serviceTaskXml = (attrs: string, children = ''): string =>
    oneNodeDoc('serviceTask', {
      id: 'Svc',
      attrs: `operaton:class="com.example.Svc" ${attrs}`,
      children,
    });

  it('an operaton:formData on a service task warns (form data is read off a start event or a user task)', async () => {
    const { warnings } = await xmlToIr(
      serviceTaskXml(
        '',
        `
      <bpmn:extensionElements>
        <operaton:formData>
          <operaton:formField id="amount" type="long" />
        </operaton:formData>
      </bpmn:extensionElements>
    `,
      ),
    );
    const extWarnings = extensionWarnings(warnings);
    expectOneWarning(extWarnings, { elementId: 'Svc', message: /FormData/i });
  });

  it('an operaton:assignee on a service task warns (the assignee is read off a user task)', async () => {
    const { warnings } = await xmlToIr(
      serviceTaskXml('operaton:assignee="alice"'),
    );
    const extWarnings = extensionWarnings(warnings);
    expectOneWarning(extWarnings, { elementId: 'Svc', message: 'assignee' });
  });

  it('an operaton:in on a user task warns, while the same element on a call activity does not', async () => {
    const mapping = `
      <bpmn:extensionElements>
        <operaton:in source="a" target="b" />
      </bpmn:extensionElements>
    `;
    const onUserTask = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T">${mapping}</bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />`;
    const onCallActivity = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:callActivity id="C" calledElement="other">${mapping}</bpmn:callActivity>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="C" />
    <bpmn:sequenceFlow id="F2" sourceRef="C" targetRef="E" />`;

    const taskResult = await xmlToIr(onUserTask);
    expect(extensionWarnings(taskResult.warnings)).toHaveLength(1);

    const callResult = await xmlToIr(onCallActivity);
    expect(callResult.warnings).toEqual([]);
    const call = byId(callResult.ir, 'C');
    expect(call.kind === 'callActivity' && call.inMappings).toEqual([
      { kind: 'variable', source: 'a', target: 'b' },
    ]);
  });
});

// ── 20. Input/output parameters import as ordered IR values ──────────────────

/**
 * A service task carrying an arbitrary `<bpmn:extensionElements>` body, the
 * shared subject of the input/output, listener, and refusal-matrix sections
 * below. A service task is an activity, so it carries both the io block and
 * execution listeners, and its own `operaton:class` keeps it importable.
 */
const serviceTaskWith = (children: string): string =>
  oneNodeDoc('serviceTask', {
    id: 'Svc',
    attrs: 'operaton:class="com.example.Svc"',
    children: extensionElements(children),
  });

const importServiceTask = (children: string) =>
  importById(serviceTaskWith(children), 'Svc', 'serviceTask');

/** The user-task counterpart of {@link serviceTaskWith}, for what only it carries. */
const userTaskWith = (children: string): string =>
  oneNodeDoc('userTask', {
    id: 'Review',
    children: extensionElements(children),
  });

const importUserTaskWith = (children: string) =>
  importById(userTaskWith(children), 'Review', 'userTask');

/** One `<operaton:inputOutput>` block wrapping the given parameter elements. */
const ioBlock = (params: string): string =>
  `        <operaton:inputOutput>\n${params}\n        </operaton:inputOutput>`;

describe('xmlToIr: input/output parameters', () => {
  it('each of the four value forms imports, in declaration order', async () => {
    const { node: task, warnings } = await importServiceTask(
      ioBlock(`          <operaton:inputParameter name="plain">bar</operaton:inputParameter>
          <operaton:inputParameter name="items">
            <operaton:list>
              <operaton:value>a</operaton:value>
              <operaton:value>b</operaton:value>
            </operaton:list>
          </operaton:inputParameter>
          <operaton:inputParameter name="lookup">
            <operaton:map>
              <operaton:entry key="k">v</operaton:entry>
            </operaton:map>
          </operaton:inputParameter>
          <operaton:inputParameter name="computed">
            <operaton:script scriptFormat="groovy">1 + 1</operaton:script>
          </operaton:inputParameter>
          <operaton:outputParameter name="result">\${execution.out}</operaton:outputParameter>`),
    );

    expect(task.inputParameters).toEqual([
      ioParam('plain', textValue('bar')),
      ioParam('items', listValue([textValue('a'), textValue('b')])),
      ioParam('lookup', mapValue([mapEntry('k', textValue('v'))])),
      ioParam('computed', scriptValue('groovy', '1 + 1')),
    ]);
    expect(task.outputParameters).toEqual([
      ioParam('result', textValue('${execution.out}')),
    ]);
    expect(warnings).toEqual([]);
  });

  it('a list of maps and a map of lists both import, nested either way', async () => {
    const { node: task, warnings } = await importServiceTask(
      ioBlock(`          <operaton:inputParameter name="listOfMaps">
            <operaton:list>
              <operaton:map>
                <operaton:entry key="k">v</operaton:entry>
              </operaton:map>
            </operaton:list>
          </operaton:inputParameter>
          <operaton:inputParameter name="mapOfLists">
            <operaton:map>
              <operaton:entry key="k">
                <operaton:list>
                  <operaton:value>z</operaton:value>
                </operaton:list>
              </operaton:entry>
            </operaton:map>
          </operaton:inputParameter>`),
    );

    expect(task.inputParameters).toEqual([
      ioParam(
        'listOfMaps',
        listValue([mapValue([mapEntry('k', textValue('v'))])]),
      ),
      ioParam(
        'mapOfLists',
        mapValue([mapEntry('k', listValue([textValue('z')]))]),
      ),
    ]);
    expect(warnings).toEqual([]);
  });

  it('a parameter with an empty body imports as empty text', async () => {
    const { node: task, warnings } = await importServiceTask(
      ioBlock('          <operaton:inputParameter name="nothing" />'),
    );
    expect(task.inputParameters).toEqual([ioParam('nothing', textValue(''))]);
    expect(warnings).toEqual([]);
  });

  it('parameter order is preserved across both directions', async () => {
    const { node: task } = await importServiceTask(
      ioBlock(`          <operaton:inputParameter name="one">1</operaton:inputParameter>
          <operaton:inputParameter name="two">2</operaton:inputParameter>
          <operaton:inputParameter name="three">3</operaton:inputParameter>
          <operaton:outputParameter name="first">a</operaton:outputParameter>
          <operaton:outputParameter name="second">b</operaton:outputParameter>`),
    );
    expect(task.inputParameters?.map((p) => p.name)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(task.outputParameters?.map((p) => p.name)).toEqual([
      'first',
      'second',
    ]);
  });

  it('every activity kind reads its own io block, and an event does not', async () => {
    const io = `      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="in">1</operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>`;
    const xml = operatonDoc`    <bpmn:startEvent id="Start">
${io}
    </bpmn:startEvent>
    <bpmn:userTask id="Review">
${io}
    </bpmn:userTask>
    <bpmn:scriptTask id="Calc" scriptFormat="javascript">
${io}
      <bpmn:script>1</bpmn:script>
    </bpmn:scriptTask>
    <bpmn:subProcess id="Booking">
${io}
      <bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:sequenceFlow id="SF_B" sourceRef="BStart" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:callActivity id="Sub" calledElement="other">
${io}
    </bpmn:callActivity>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Calc" />
    <bpmn:sequenceFlow id="F3" sourceRef="Calc" targetRef="Booking" />
    <bpmn:sequenceFlow id="F4" sourceRef="Booking" targetRef="Sub" />
    <bpmn:sequenceFlow id="F5" sourceRef="Sub" targetRef="End" />`;

    const { ir, warnings } = await xmlToIr(xml);
    const carried = ir.flowElements
      .filter(
        (fe) => 'inputParameters' in fe && fe.inputParameters !== undefined,
      )
      .map((fe) => fe.id);
    expect(carried).toEqual(['Review', 'Calc', 'Booking', 'Sub']);

    // The start event's IR node carries no io block, so its own stays a
    // reported drop rather than a silent one.
    expectOneWarning(warnings, {
      elementId: 'Start',
      category: 'extensionAttribute',
      message: /InputOutput/i,
    });
  });
});

// ── 21. Execution and task listeners import as IR listener records ───────────

describe('xmlToIr: execution listeners', () => {
  it('each of the four bindings imports, in emission order', async () => {
    const { node: task, warnings } = await importServiceTask(
      `        <operaton:executionListener event="start" class="com.example.L" />
        <operaton:executionListener event="end" expression="\${bean.done()}" />`,
    );
    expect(task.executionListeners).toEqual([
      { event: 'start', binding: classBinding('com.example.L') },
      { event: 'end', binding: exprBinding('${bean.done()}') },
    ]);
    expect(warnings).toEqual([]);

    const delegated = await importServiceTask(
      `        <operaton:executionListener event="start" delegateExpression="\${listenerBean}" />`,
    );
    expect(delegated.node.executionListeners).toEqual([
      { event: 'start', binding: delegateBinding('${listenerBean}') },
    ]);

    const scripted = await importServiceTask(
      `        <operaton:executionListener event="end">
          <operaton:script scriptFormat="groovy">println 'done'</operaton:script>
        </operaton:executionListener>`,
    );
    expect(scripted.node.executionListeners).toEqual([
      { event: 'end', binding: scriptValue('groovy', "println 'done'") },
    ]);
    expect(scripted.warnings).toEqual([]);
  });

  it('every node kind that carries engine settings carries listeners too', async () => {
    const listener = `      <bpmn:extensionElements>
        <operaton:executionListener event="start" class="com.example.L" />
      </bpmn:extensionElements>`;
    const xml = operatonDoc`    <bpmn:startEvent id="Start">
${listener}
    </bpmn:startEvent>
    <bpmn:userTask id="Review">
${listener}
    </bpmn:userTask>
    <bpmn:subProcess id="Booking">
${listener}
      <bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:sequenceFlow id="SF_B" sourceRef="BStart" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="Timeout" attachedToRef="Review">
${listener}
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End">
${listener}
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Booking" />
    <bpmn:sequenceFlow id="F3" sourceRef="Booking" targetRef="End" />
    <bpmn:sequenceFlow id="F4" sourceRef="Timeout" targetRef="End" />`;

    const { ir, warnings } = await xmlToIr(xml);
    const carrying = ir.flowElements
      .filter(
        (fe) =>
          'executionListeners' in fe && fe.executionListeners !== undefined,
      )
      .map((fe) => fe.id);
    expect(carrying).toEqual(['Start', 'Review', 'Booking', 'Timeout', 'End']);
    expect(warnings).toEqual([]);
  });

  it('an execution listener on a gateway stays a reported drop', async () => {
    const xml = oneNodeDoc('exclusiveGateway', {
      id: 'G',
      children: extensionElements(
        '        <operaton:executionListener event="start" class="com.example.L" />',
      ),
    });
    const { warnings } = await xmlToIr(xml);
    expectOneWarning(warnings, {
      elementId: 'G',
      message: /ExecutionListener/i,
    });
  });
});

describe('xmlToIr: task listeners', () => {
  it('the five non-timeout events import in emission order', async () => {
    const { node: task, warnings } = await importUserTaskWith(
      `        <operaton:taskListener event="create" class="com.example.C" />
        <operaton:taskListener event="assign" expression="\${bean.assign()}" />
        <operaton:taskListener event="complete" delegateExpression="\${bean}" />
        <operaton:taskListener event="update" class="com.example.U" />
        <operaton:taskListener event="delete" class="com.example.D" />`,
    );
    expect(task.taskListeners?.map((l) => l.event)).toEqual([
      'create',
      'assign',
      'complete',
      'update',
      'delete',
    ]);
    expect(task.taskListeners?.[1].binding).toEqual(
      exprBinding('${bean.assign()}'),
    );
    expect(warnings).toEqual([]);
  });

  it('a timeout listener carries its timer as a timer event definition', async () => {
    const { node: task, warnings } = await importUserTaskWith(
      `        <operaton:taskListener event="timeout" class="com.example.T">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT8H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
    );
    expect(task.taskListeners).toEqual([
      {
        event: 'timeout',
        binding: classBinding('com.example.T'),
        timer: timerDef('duration', 'PT8H'),
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it('a task listener on a service task stays a reported drop', async () => {
    const { warnings } = await importServiceTask(
      `        <operaton:taskListener event="create" class="com.example.C" />`,
    );
    expectOneWarning(warnings, { elementId: 'Svc', message: /TaskListener/i });
  });

  it('a listener id is reported, not swallowed with the listener that runs', async () => {
    const { node: task, warnings } = await importUserTaskWith(
      `        <operaton:taskListener id="TL_1" event="create" class="com.example.L" />`,
    );
    expect(task.taskListeners).toEqual([
      { event: 'create', binding: classBinding('com.example.L') },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].elementId).toBe('Review');
    expect(warnings[0].category).toBe('extensionAttribute');
    expect(warnings[0].message).toMatch(
      /'id' on an operaton:taskListener 'create'/,
    );
  });

  it('a timeout listener id is reported, the id Operaton addresses its job by', async () => {
    const { node: task, warnings } = await importUserTaskWith(
      `        <operaton:taskListener id="Escalate" event="timeout" class="com.example.T">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT8H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
    );
    expect(task.taskListeners?.[0].timer).toEqual(timerDef('duration', 'PT8H'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(
      /'id' on an operaton:taskListener 'timeout'/,
    );
  });

  it('an undeclared operaton attribute and a foreign one on a listener both report', async () => {
    const { node: task, warnings } = await importUserTaskWith(
      `        <operaton:taskListener event="create" class="com.example.L"
          xmlns:foo="http://foo.example" operaton:mystery="m" foo:bar="1" />`,
    );
    expect(task.taskListeners?.[0].binding).toEqual(
      classBinding('com.example.L'),
    );
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/'operaton:mystery' on an operaton:taskListener/),
      expect.stringMatching(/'foo:bar' on an operaton:taskListener/),
    ]);
  });
});

describe('xmlToIr: a consumed extension child reports its own unread attributes', () => {
  it('an operaton:value carrying a modeler id or name reports that drop', async () => {
    const { node: task, warnings } = await importServiceTask(
      ioBlock(`          <operaton:inputParameter name="x">
            <operaton:list>
              <operaton:value id="Item_1" name="First">z</operaton:value>
            </operaton:list>
          </operaton:inputParameter>`),
    );
    expect(task.inputParameters).toEqual([
      ioParam('x', listValue([textValue('z')])),
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.elementId)).toEqual(['Svc', 'Svc']);
    expect(warnings[0].message).toMatch(/'id' on an operaton:value/);
    expect(warnings[1].message).toMatch(/'name' on an operaton:value/);
    expect(warnings[0].message).toMatch(/operaton:inputParameter 'x'/);
  });

  it('an undeclared operaton attribute and a foreign one on an io parameter both report', async () => {
    const { node: task, warnings } = await importServiceTask(
      ioBlock(`          <operaton:inputParameter name="x"
            xmlns:foo="http://foo.example" operaton:mystery="m" foo:bar="1">v</operaton:inputParameter>`),
    );
    expect(task.inputParameters).toEqual([ioParam('x', textValue('v'))]);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(
        /'operaton:mystery' on an operaton:inputParameter 'x'/,
      ),
      expect.stringMatching(/'foo:bar' on an operaton:inputParameter 'x'/),
    ]);
  });

  it('a foreign attribute on the operaton:inputOutput block itself reports', async () => {
    const { warnings } = await importServiceTask(
      `        <operaton:inputOutput xmlns:foo="http://foo.example" foo:bar="1">
          <operaton:inputParameter name="x">v</operaton:inputParameter>
        </operaton:inputOutput>`,
    );
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/'foo:bar' on an operaton:inputOutput/),
    ]);
  });

  it('two form fields are told apart by the id their warnings name', async () => {
    const xml = oneNodeDoc('userTask', {
      id: 'Review',
      children: `
      <bpmn:extensionElements xmlns:foo="http://foo.example">
        <operaton:formData>
          <operaton:formField id="approve" type="boolean" foo:bar="1" />
          <operaton:formField id="comment" type="string" foo:bar="2" />
        </operaton:formData>
      </bpmn:extensionElements>
    `,
    });
    const { warnings } = await xmlToIr(xml);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/'foo:bar' on an operaton:formField 'approve'/),
      expect.stringMatching(/'foo:bar' on an operaton:formField 'comment'/),
    ]);
  });

  it('in and out mappings are told apart by the end their warnings name', async () => {
    const xml = oneNodeDoc('callActivity', {
      id: 'Call',
      attrs: 'calledElement="sub"',
      children: `
      <bpmn:extensionElements xmlns:foo="http://foo.example">
        <operaton:in source="amount" target="total" foo:bar="1" />
        <operaton:in source="customer" target="client" foo:bar="2" />
        <operaton:in sourceExpression="\${now()}" target="raised" foo:bar="3" />
        <operaton:out source="verdict" target="outcome" foo:bar="4" />
      </bpmn:extensionElements>
    `,
    });
    const { warnings } = await xmlToIr(xml);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/'foo:bar' on an operaton:in 'amount'/),
      expect.stringMatching(/'foo:bar' on an operaton:in 'customer'/),
      expect.stringMatching(/'foo:bar' on an operaton:in '\$\{now\(\)\}'/),
      expect.stringMatching(/'foo:bar' on an operaton:out 'verdict'/),
    ]);
  });
});

// ── 22. Content that is still dropped is dropped precisely, never silently ───

describe('xmlToIr: operaton:field is reported per field', () => {
  it('a field on a step names the field and refuses nothing', async () => {
    const { node: task, warnings } = await importServiceTask(
      `        <operaton:field name="greeting" stringValue="hello" />`,
    );
    expect(task.binding).toEqual(classBinding('com.example.Svc'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      elementId: 'Svc',
      category: 'extensionAttribute',
      message: expect.stringContaining("'greeting'"),
    });
  });

  it('a field on a listener is reported against the owning step', async () => {
    const { node: task, warnings } = await importServiceTask(
      `        <operaton:executionListener event="start" class="com.example.L">
          <operaton:field name="greeting" stringValue="hello" />
        </operaton:executionListener>`,
    );
    expect(task.executionListeners).toEqual([
      { event: 'start', binding: classBinding('com.example.L') },
    ]);
    expectOneWarning(warnings, { elementId: 'Svc', message: "'greeting'" });
    expect(warnings[0].message).toMatch(/listener/i);
  });

  it('one document carrying a carried element and a dropped element yields exactly one warning', async () => {
    const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="CleanTask" operaton:assignee="alice">
      <bpmn:extensionElements>
        <operaton:executionListener event="start" class="com.example.L" />
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:serviceTask id="ConfiguredSvc" operaton:class="com.example.Svc">
      <bpmn:extensionElements>
        <operaton:field name="greeting" stringValue="hello" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CleanTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="CleanTask" targetRef="ConfiguredSvc" />
    <bpmn:sequenceFlow id="F3" sourceRef="ConfiguredSvc" targetRef="E" />`;

    const { warnings } = await xmlToIr(xml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].elementId).toBe('ConfiguredSvc');
  });
});

describe('xmlToIr: a repeated extension block keeps the first and reports the rest', () => {
  it('a second operaton:failedJobRetryTimeCycle warns and the first is kept', async () => {
    const { node: task, warnings } = await importServiceTask(
      `        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>
        <operaton:failedJobRetryTimeCycle>R5/PT1H</operaton:failedJobRetryTimeCycle>`,
    );
    expect(task.retryCycle).toBe('R3/PT10M');
    expectOneWarning(warnings, {
      elementId: 'Svc',
      message: /FailedJobRetryTimeCycle/i,
    });
  });

  it('a second operaton:inputOutput warns and the first is kept', async () => {
    const { node: task, warnings } = await importServiceTask(
      `${ioBlock('          <operaton:inputParameter name="kept">1</operaton:inputParameter>')}
${ioBlock('          <operaton:inputParameter name="dropped">2</operaton:inputParameter>')}`,
    );
    expect(task.inputParameters).toEqual([ioParam('kept', textValue('1'))]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/InputOutput/i);
  });

  it('a second operaton:formData warns and the first is kept', async () => {
    const { node: task, warnings } = await importUserTaskWith(
      `        <operaton:formData>
          <operaton:formField id="kept" type="string" />
        </operaton:formData>
        <operaton:formData>
          <operaton:formField id="dropped" type="string" />
        </operaton:formData>`,
    );
    expect(task.formFields).toEqual([{ id: 'kept', type: 'string' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/FormData/i);
  });
});

describe('xmlToIr: form data on an event handler trigger start', () => {
  it('is read onto the trigger start event rather than dropped', async () => {
    const xml = handlerDoc(
      `<bpmn:extensionElements>
          <operaton:formData>
            <operaton:formField id="reason" type="string" />
          </operaton:formData>
        </bpmn:extensionElements>
        <bpmn:errorEventDefinition errorRef="Error_X" />`,
      {
        roots: '  <bpmn:error id="Error_X" errorCode="X" />\n',
        defs: operatonDefs,
      },
    );

    const { ir, warnings } = await xmlToIr(xml);
    const start = byId(subProcess(ir, 'Handler'), 'HStart');
    expect(start.kind === 'startEvent' && start.formFields).toEqual([
      { id: 'reason', type: 'string' },
    ]);
    expect(warnings).toEqual([]);
  });
});

// ── 23. The extension-form refusal matrix ────────────────────────────────────

/**
 * Every shape of `operaton:inputOutput` block or listener that carries content
 * this surface cannot express, one case per test. Each is semantic loss rather
 * than decoration, so each throws before any IR is produced.
 *
 * Two of them are visible only because the moddle descriptor declares a
 * parameter's nested value as a repeating property: with a single-valued one,
 * a parameter carrying two nested values and a parameter carrying a stray
 * `operaton:entry` both parse to something plausible with no warning at all,
 * and no reader could tell.
 */
describe('xmlToIr: the extension-form refusal matrix', () => {
  const refuse = (
    children: string,
    detail: RegExp | string,
  ): Promise<UnsupportedExtensionFormError> =>
    expectRefusal<UnsupportedExtensionFormError>(
      xmlToIr(serviceTaskWith(children)),
      UnsupportedExtensionFormError,
      detail,
    );

  const refuseOnUserTask = (
    children: string,
    detail: RegExp | string,
  ): Promise<UnsupportedExtensionFormError> =>
    expectRefusal<UnsupportedExtensionFormError>(
      xmlToIr(userTaskWith(children)),
      UnsupportedExtensionFormError,
      detail,
    );

  // The cases whose whole content is "this shape is refused, and the detail
  // names it". The ones that pin more than the detail string keep their own
  // test below.
  it.each([
    {
      case: '3. a map entry carrying both body text and a nested value',
      host: refuse,
      children: ioBlock(`          <operaton:inputParameter name="x">
            <operaton:map>
              <operaton:entry key="k">text<operaton:list /></operaton:entry>
            </operaton:map>
          </operaton:inputParameter>`),
      detail: /operaton:entry 'k'.*both body text and a nested/,
    },
    {
      case: '4. a map entry carrying two nested values',
      host: refuse,
      children: ioBlock(`          <operaton:inputParameter name="x">
            <operaton:map>
              <operaton:entry key="k"><operaton:list /><operaton:map /></operaton:entry>
            </operaton:map>
          </operaton:inputParameter>`),
      detail: /operaton:entry 'k'.*2 nested values/,
    },
    {
      case: '6. a script value naming an external resource',
      host: refuse,
      children: ioBlock(`          <operaton:inputParameter name="x">
            <operaton:script scriptFormat="groovy" resource="classpath://calc.groovy" />
          </operaton:inputParameter>`),
      detail: /external resource.*calc\.groovy/,
    },
    {
      case: '7. a script value with no scriptFormat',
      host: refuse,
      children: ioBlock(`          <operaton:inputParameter name="x">
            <operaton:script>1 + 1</operaton:script>
          </operaton:inputParameter>`),
      detail:
        "the operaton:script in operaton:inputParameter 'x' has no " +
        'scriptFormat, so there is no language to evaluate its body in',
    },
    {
      case: '10. a listener carrying no binding at all',
      host: refuse,
      children: `        <operaton:executionListener event="start" />`,
      detail:
        'an operaton:executionListener carries no binding: one of class, ' +
        'expression, delegateExpression, or an operaton:script child is ' +
        'what it runs',
    },
    {
      case: '11. a listener with no event',
      host: refuse,
      children: `        <operaton:executionListener class="com.example.L" />`,
      detail:
        'an operaton:executionListener has no event, so there is no point ' +
        'in the lifecycle for it to fire at',
    },
    {
      case: '12. an execution listener whose event is neither start nor end',
      host: refuse,
      children: `        <operaton:executionListener event="take" class="com.example.L" />`,
      detail: /event="take".*start, end/,
    },
    {
      case: '13. a task listener whose event is not one of the six task events',
      host: refuseOnUserTask,
      children: `        <operaton:taskListener event="start" class="com.example.L" />`,
      detail:
        /event="start".*create, assign, complete, update, delete, timeout/,
    },
    {
      case: '14. a timeout task listener with no timer',
      host: refuseOnUserTask,
      children: `        <operaton:taskListener event="timeout" class="com.example.L" />`,
      detail:
        'an operaton:taskListener with event="timeout" carries no ' +
        'bpmn:timerEventDefinition, so nothing would ever fire it',
    },
    {
      case: '15. a task listener carrying a timer on any other event',
      host: refuseOnUserTask,
      children: `        <operaton:taskListener event="create" class="com.example.L">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
      detail: /event="create".*only a timeout listener/,
    },
  ])('$case', async (row) => {
    await row.host(row.children, row.detail);
  });

  it('1. a parameter carrying both body text and a nested value', async () => {
    const err = await refuse(
      ioBlock(
        `          <operaton:inputParameter name="x">text<operaton:list /></operaton:inputParameter>`,
      ),
      "operaton:inputParameter 'x' carries both body text and a nested " +
        '<operaton:List> value, and a value is one or the other',
    );
    expect(err.elementId).toBe('Svc');
  });

  it('2. a parameter carrying two nested values', async () => {
    await refuse(
      ioBlock(
        `          <operaton:inputParameter name="x"><operaton:list /><operaton:map /></operaton:inputParameter>`,
      ),
      "operaton:inputParameter 'x' carries 2 nested values (operaton:List, " +
        'operaton:Map), and a value is one',
    );
  });

  it('5. a parameter with no name, or a map entry with no key', async () => {
    await refuse(
      ioBlock(
        `          <operaton:inputParameter>text</operaton:inputParameter>`,
      ),
      'an operaton:inputParameter has no name, so there is nothing to bind ' +
        'its value to',
    );
    await refuse(
      ioBlock(
        `          <operaton:outputParameter>text</operaton:outputParameter>`,
      ),
      'an operaton:outputParameter has no name, so there is nothing to ' +
        'bind its value to',
    );
    await refuse(
      ioBlock(`          <operaton:inputParameter name="x">
            <operaton:map>
              <operaton:entry>text</operaton:entry>
            </operaton:map>
          </operaton:inputParameter>`),
      /operaton:entry in .* has no key/,
    );
  });

  it('8. an operaton:entry inside an operaton:list', async () => {
    await refuse(
      ioBlock(`          <operaton:inputParameter name="x">
            <operaton:list>
              <operaton:entry key="k">v</operaton:entry>
            </operaton:list>
          </operaton:inputParameter>`),
      "an operaton:list in operaton:inputParameter 'x' carries a " +
        '<operaton:Entry>; a list holds values, and an entry belongs in an ' +
        'operaton:map',
    );
  });

  it('8b. an operaton:entry where a parameter value belongs', async () => {
    await refuse(
      ioBlock(
        `          <operaton:inputParameter name="x"><operaton:entry key="k">v</operaton:entry></operaton:inputParameter>`,
      ),
      "operaton:inputParameter 'x' carries a <operaton:Entry> where a value " +
        'belongs; an entry belongs in an operaton:map',
    );
  });

  it('9. a listener carrying more than one binding', async () => {
    await refuse(
      `        <operaton:executionListener event="start" class="C" expression="\${e}" />`,
      'an operaton:executionListener carries 2 bindings (class, ' +
        'expression), and a listener names exactly one',
    );

    await refuse(
      `        <operaton:executionListener event="start" class="C">
          <operaton:script scriptFormat="groovy">1</operaton:script>
        </operaton:executionListener>`,
      'an operaton:executionListener carries 2 bindings (class, an ' +
        'operaton:script child), and a listener names exactly one',
    );
  });

  it('16. two listeners on one element sharing an event', async () => {
    await refuse(
      `        <operaton:executionListener event="start" class="com.example.A" />
        <operaton:executionListener event="start" class="com.example.B" />`,
      /two operaton:executionListener children share event="start"/,
    );
    await refuseOnUserTask(
      `        <operaton:taskListener event="create" class="com.example.A" />
        <operaton:taskListener event="create" class="com.example.B" />`,
      /share event="create"/,
    );
  });

  it('17. two parameters of one direction sharing a name', async () => {
    await refuse(
      ioBlock(`          <operaton:inputParameter name="x">1</operaton:inputParameter>
          <operaton:inputParameter name="x">2</operaton:inputParameter>`),
      /two operaton:inputParameter children share name="x"/,
    );

    // The two directions are separate bindings, so the same name in each is
    // an ordinary mapping rather than a repeat.
    const { node: task } = await importServiceTask(
      ioBlock(`          <operaton:inputParameter name="x">1</operaton:inputParameter>
          <operaton:outputParameter name="x">2</operaton:outputParameter>`),
    );
    expect(task.inputParameters).toEqual([ioParam('x', textValue('1'))]);
    expect(task.outputParameters).toEqual([ioParam('x', textValue('2'))]);
  });
});

// ── 24. The four task kinds import to their IR nodes ─────────────────────────

describe('xmlToIr: task kinds', () => {
  /**
   * Each tag, the IR kind it imports as, the least it needs to bind, and the
   * noun a boundary-host refusal names it with.
   */
  const KINDS = [
    ['task', 'task', '', 'plain task'],
    [
      'sendTask',
      'serviceTask',
      'operaton:class="com.example.Send"',
      'send task',
    ],
    ['receiveTask', 'receiveTask', '', 'receive task'],
    [
      'businessRuleTask',
      'serviceTask',
      'operaton:decisionRef="riskRating"',
      'business rule task',
    ],
  ] as const;

  const ORDER_PAID_ROOT =
    '  <bpmn:message id="Msg_OrderPaid" name="OrderPaid" />\n';

  /** `S -> receiveTask -> E`, beside the roots the task may reference. */
  const receiveDoc = (attrs: string, roots = ''): string =>
    operatonDefs`${roots}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:receiveTask id="T" ${attrs} />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>`;

  /** `S -> node -> E` with one boundary event attached to the node. */
  const boundaryDoc = (tag: string, attrs: string, definition: string) =>
    operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:${tag} id="T" ${attrs} />
    <bpmn:boundaryEvent id="B" attachedToRef="T">
      ${definition}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />`;

  const TIMER_1H = `<bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>`;

  it.each(KINDS)(
    'bpmn:%s imports as a %s carrying its name and engine settings',
    async (tag, kind, binding) => {
      const { node, warnings } = await importOnly(
        oneNodeDoc(tag, {
          attrs:
            `name="Handle It" ${binding} ` +
            'operaton:asyncBefore="true" operaton:jobPriority="5"',
        }),
        kind,
      );
      expect(warnings).toEqual([]);
      expect(node.id).toBe('T');
      expect(node.name).toBe('Handle It');
      expect(node.asyncBefore).toBe(true);
      expect(node.jobPriority).toBe('5');
    },
  );

  it('a send task imports as a service task node tagged as a send', async () => {
    const { node } = await importOnly(
      oneNodeDoc('sendTask', { attrs: 'operaton:class="com.example.Send"' }),
      'serviceTask',
    );
    expect(node.element).toBe('send');
    expect(node.binding).toEqual(classBinding('com.example.Send'));
  });

  it('a send task with no binding refuses as a send task, not as a service task', async () => {
    const e = await expectRefusal<UnsupportedServiceTaskFormError>(
      xmlToIr(oneNodeDoc('sendTask')),
      UnsupportedServiceTaskFormError,
    );
    expect(e.subject).toBe('Send task');
    expect(e.message).toContain(
      "Send task 'T' uses unsupported execution form",
    );
  });

  it('a business rule task imports the whole decision binding', async () => {
    const { node, warnings } = await importOnly(
      oneNodeDoc('businessRuleTask', {
        attrs:
          'operaton:decisionRef="riskRating" ' +
          'operaton:decisionRefBinding="version" ' +
          'operaton:decisionRefVersion="3" ' +
          'operaton:mapDecisionResult="singleEntry" ' +
          'operaton:resultVariable="risk"',
      }),
      'serviceTask',
    );
    expect(warnings).toEqual([]);
    expect(node.element).toBe('businessRule');
    expect(node.binding).toEqual({
      kind: 'decision',
      decisionRef: 'riskRating',
      binding: { kind: 'version', version: '3' },
      mapDecisionResult: 'singleEntry',
    });
    expect(node.resultVariable).toBe('risk');
  });

  it('a business rule task bound to code imports that binding instead', async () => {
    const { node } = await importOnly(
      oneNodeDoc('businessRuleTask', {
        attrs: 'operaton:class="com.example.Rate"',
      }),
      'serviceTask',
    );
    expect(node.element).toBe('businessRule');
    expect(node.binding).toEqual(classBinding('com.example.Rate'));
  });

  it('a code-bound business rule task warns about the decision settings it drops', async () => {
    const { warnings } = await importOnly(
      oneNodeDoc('businessRuleTask', {
        attrs:
          'operaton:class="com.example.Rate" ' +
          'operaton:decisionRefBinding="latest" ' +
          'operaton:decisionRefVersion="3" ' +
          'operaton:mapDecisionResult="singleEntry"',
      }),
      'serviceTask',
    );
    expect(warnings.map((w) => w.message)).toEqual([
      "The 'decisionRefBinding' setting on 'T' has no effect without an operaton:decisionRef and was not imported.",
      "The 'decisionRefVersion' setting on 'T' has no effect without an operaton:decisionRef and was not imported.",
      "The 'mapDecisionResult' setting on 'T' has no effect without an operaton:decisionRef and was not imported.",
    ]);
  });

  it('a decision-bound business rule task warns about the implementation it drops', async () => {
    const { node, warnings } = await importOnly(
      oneNodeDoc('businessRuleTask', {
        attrs:
          'operaton:decisionRef="riskRating" ' +
          'operaton:class="com.example.Rate" ' +
          'operaton:type="external" operaton:topic="rate"',
      }),
      'serviceTask',
    );
    expect(node.binding).toEqual({
      kind: 'decision',
      decisionRef: 'riskRating',
    });
    expect(warnings.map((w) => w.message)).toEqual([
      "The 'class' setting on 'T' has no effect alongside an operaton:decisionRef and was not imported.",
      "The 'type' setting on 'T' has no effect alongside an operaton:decisionRef and was not imported.",
      "The 'topic' setting on 'T' has no effect alongside an operaton:decisionRef and was not imported.",
    ]);
  });

  it.each([
    [
      'a mapDecisionResult outside the four Operaton accepts',
      'operaton:mapDecisionResult="firstEntry"',
      'operaton:mapDecisionResult="firstEntry", which is not a way of ' +
        'filling the result variable this tool can represent',
    ],
    [
      'decisionRefBinding="version" without a decisionRefVersion',
      'operaton:decisionRefBinding="version"',
      'decisionRefBinding="version" is set without a decisionRefVersion, so ' +
        'the engine cannot resolve which version to use',
    ],
    [
      'an unrecognized decisionRefBinding',
      'operaton:decisionRefBinding="versionTag"',
      'decisionRefBinding="versionTag" is not a binding this tool can represent',
    ],
  ])(
    'a business rule task with %s refuses rather than importing without it',
    async (_title, attrs, construct) => {
      const e = await expectRefusal<UnsupportedServiceTaskFormError>(
        xmlToIr(
          oneNodeDoc('businessRuleTask', {
            attrs: `operaton:decisionRef="d" ${attrs}`,
          }),
        ),
        UnsupportedServiceTaskFormError,
      );
      expect(e.construct).toBe(construct);
    },
  );

  it('a receive task with a messageRef imports the message name', async () => {
    const { node, warnings } = await importOnly(
      receiveDoc('messageRef="Msg_OrderPaid"', ORDER_PAID_ROOT),
      'receiveTask',
    );
    expect(node.messageName).toBe('OrderPaid');
    expect(warnings).toEqual([]);
  });

  it('a receive task with no messageRef imports as a wait state, with no message name and no warning', async () => {
    const { node, warnings } = await importOnly(receiveDoc(''), 'receiveTask');
    expect(node).not.toHaveProperty('messageName');
    expect(warnings).toEqual([]);
  });

  it('a bpmn:message root used only by a receive task is not reported as unreferenced', async () => {
    const { warnings } = await xmlToIr(
      receiveDoc('messageRef="Msg_OrderPaid"', ORDER_PAID_ROOT),
    );
    expect(warnings.filter((w) => w.category === 'unreferencedRoot')).toEqual(
      [],
    );
  });

  it.each(KINDS)(
    'isForCompensation="true" on a bpmn:%s refuses rather than importing into normal flow',
    async (tag, _kind, binding) => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(
          oneNodeDoc(tag, { attrs: `isForCompensation="true" ${binding}` }),
        ),
        UnsupportedEventFeatureError,
        IS_FOR_COMPENSATION_DETAIL,
      );
      expect(e.elementId).toBe('T');
    },
  );

  it.each(KINDS)(
    'a timer boundary event attaches to a bpmn:%s',
    async (tag, _kind, binding) => {
      const { ir, warnings } = await xmlToIr(
        boundaryDoc(tag, binding, TIMER_1H),
      );
      expect(only(ir, 'boundaryEvent').attachedToRef).toBe('T');
      expect(warnings).toEqual([]);
    },
  );

  it.each(KINDS)(
    'an escalation boundary event on a bpmn:%s still refuses',
    async (tag, _kind, binding, noun) => {
      await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(
          boundaryDoc(
            tag,
            binding,
            '<bpmn:escalationEventDefinition id="EscDef" />',
          ),
        ),
        UnsupportedEventFeatureError,
        `an escalation boundary event attaches to "T", a ${noun}; ` +
          'Operaton only allows an escalation boundary on a subprocess, a ' +
          'call activity, or a user task',
      );
    },
  );

  it.each(KINDS)(
    'multi-instance loop characteristics on a bpmn:%s import as a repetition',
    async (tag, kind, binding) => {
      const { node, warnings } = await importOnly(
        oneNodeDoc(tag, {
          attrs: binding,
          children:
            '<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" />',
        }),
        kind,
      );
      expect(node.loop).toEqual({ collection: 'lines' });
      expect(warnings).toEqual([]);
    },
  );

  it('bpmn:manualTask stays refused, and the refusal names the four kinds among the supported ones', async () => {
    const e = await expectRefusal<UnsupportedElementError>(
      xmlToIr(oneNodeDoc('manualTask', { doc: bpmnDoc })),
      UnsupportedElementError,
    );
    expect(e.qname).toBe('bpmn:ManualTask');
    expect(e.message).toContain(
      'plain tasks, user tasks, service tasks, send tasks, receive tasks, ' +
        'business rule tasks, script tasks',
    );
  });

  it('a document holding all four kinds imports with no warnings at all', async () => {
    const ioBlock = (name: string, value: string) =>
      `
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="${name}">${value}</operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
    `;
    const xml = operatonDefs`${ORDER_PAID_ROOT}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:task id="Record" operaton:asyncBefore="true">${ioBlock('note', 'recorded')}</bpmn:task>
    <bpmn:sendTask id="Notify" operaton:type="external" operaton:topic="mail" operaton:resultVariable="sent">${ioBlock('to', 'ops@example.com')}</bpmn:sendTask>
    <bpmn:receiveTask id="AwaitPayment" messageRef="Msg_OrderPaid" operaton:asyncAfter="true">${ioBlock('reference', 'INV-1')}</bpmn:receiveTask>
    <bpmn:businessRuleTask id="Rate" operaton:decisionRef="riskRating" operaton:decisionRefBinding="latest" operaton:mapDecisionResult="singleEntry" operaton:resultVariable="risk">${ioBlock('applicant', 'acme')}</bpmn:businessRuleTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Record" />
    <bpmn:sequenceFlow id="F2" sourceRef="Record" targetRef="Notify" />
    <bpmn:sequenceFlow id="F3" sourceRef="Notify" targetRef="AwaitPayment" />
    <bpmn:sequenceFlow id="F4" sourceRef="AwaitPayment" targetRef="Rate" />
    <bpmn:sequenceFlow id="F5" sourceRef="Rate" targetRef="E" />
  </bpmn:process>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
    expect(ir.flowElements.map((fe) => fe.kind)).toEqual([
      'startEvent',
      'task',
      'serviceTask',
      'receiveTask',
      'serviceTask',
      'endEvent',
    ]);
    expect(only(ir, 'task').inputParameters).toEqual([
      ioParam('note', textValue('recorded')),
    ]);
  });
});

// ── 25. A block that can be given up, and the cancel pair ────────────────────

describe('xmlToIr: a block that can be given up', () => {
  /** The closing sentence {@link UnsupportedEventFeatureError} appends by default. */
  const EVENT_SURFACE_NOTE =
    'Event handlers catch one error, escalation, message, signal, timer, ' +
    'conditional, or compensation trigger on their single start event; ' +
    'throws and emits carry the code or name their kind requires, and ' +
    'compensation carries neither.';

  const BLOCK_BODY = `      <bpmn:userTask id="Charge" />
      <bpmn:endEvent id="Booked" />
      <bpmn:sequenceFlow id="BF1" sourceRef="BStart" targetRef="Charge" />
      <bpmn:sequenceFlow id="BF2" sourceRef="Charge" targetRef="Booked" />
`;

  const CANCEL_END = `      <bpmn:endEvent id="GiveUp" name="Give up the booking">
        <bpmn:cancelEventDefinition id="GiveUpDef" />
      </bpmn:endEvent>
`;

  const cancelBoundary = (id = 'Boundary_Book_cancel', attrs = ''): string =>
    `    <bpmn:boundaryEvent id="${id}" attachedToRef="Book" ${attrs}>
      <bpmn:cancelEventDefinition id="${id}_Def" />
    </bpmn:boundaryEvent>
`;

  interface BlockOptions {
    /** The tag the block is written with. Defaults to `transaction`. */
    tag?: string;
    /** Extra attributes on the block's opening tag. */
    attrs?: string;
    /** The block's body, written after its start event. */
    body?: string;
    /** Content written in the process beside the block. */
    beside?: string;
    /** The `<bpmn:definitions>` wrapper. Defaults to {@link operatonDoc}. */
    doc?: XmlTag;
  }

  /** `S -> Book -> E`, where `Book` is the block and `beside` sits alongside it. */
  const blockDoc = ({
    tag = 'transaction',
    attrs = '',
    body = BLOCK_BODY,
    beside = '',
    doc: wrapper = operatonDoc,
  }: BlockOptions = {}): string =>
    wrapper`    <bpmn:startEvent id="S" />
    <bpmn:${tag} id="Book" ${attrs}>
      <bpmn:startEvent id="BStart" />
${body}    </bpmn:${tag}>
${beside}    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Book" />
    <bpmn:sequenceFlow id="F2" sourceRef="Book" targetRef="E" />`;

  /** The pair: a cancel end inside the block and a cancel boundary on it. */
  const pairedDoc = (options: BlockOptions = {}): string =>
    blockDoc({
      body: BLOCK_BODY + CANCEL_END,
      beside: cancelBoundary(),
      ...options,
    });

  it('imports as a subprocess naming the tag it serializes to, with the children a plain one gets', async () => {
    const { ir: given } = await xmlToIr(blockDoc());
    const { ir: plain } = await xmlToIr(blockDoc({ tag: 'subProcess' }));

    expect(subProcess(given, 'Book')).toEqual({
      ...subProcess(plain, 'Book'),
      element: 'transaction',
    });
    expect(subProcess(plain, 'Book')).not.toHaveProperty('element');
  });

  it('imports the cancel pair: the end keeps its label, the boundary keeps its host', async () => {
    const { ir, warnings } = await xmlToIr(pairedDoc());

    expect(byId(subProcess(ir, 'Book'), 'GiveUp')).toEqual({
      kind: 'endEvent',
      id: 'GiveUp',
      name: 'Give up the booking',
      eventDefinition: { kind: 'cancel' },
    });
    expect(byId(ir, 'Boundary_Book_cancel')).toEqual({
      kind: 'boundaryEvent',
      id: 'Boundary_Book_cancel',
      attachedToRef: 'Book',
      eventDefinition: { kind: 'cancel' },
    });
    expect(warnings).toEqual([]);
  });

  it.each([
    [
      'a plain subprocess',
      blockDoc({ tag: 'subProcess', body: BLOCK_BODY + CANCEL_END }),
    ],
    [
      'an event handler',
      handlerDoc('<bpmn:errorEventDefinition id="HDef" />', {
        body: `      <bpmn:endEvent id="GiveUp" name="Give up the booking">
        <bpmn:cancelEventDefinition id="GiveUpDef" />
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="GiveUp" />
`,
      }),
    ],
    [
      'the process itself',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="GiveUp" name="Give up the booking">
      <bpmn:cancelEventDefinition id="GiveUpDef" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="GiveUp" />`,
    ],
  ])('a cancel end directly inside %s refuses', async (_where, xml) => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(xml),
      UnsupportedEventFeatureError,
    );
    expect(e.elementId).toBe('GiveUp');
    expect(e.message).toBe(
      "The event construct at 'GiveUp' cannot be imported: an end event " +
        'carries a cancel definition outside a block that can be given up; ' +
        'Operaton only accepts one directly inside a <bpmn:transaction>, and ' +
        'refuses to deploy the file otherwise. Move the end inside a ' +
        '<bpmn:transaction>, or take the cancel definition off it.',
    );
  });

  it.each([
    [
      'a user task',
      'user task',
      operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Book" />
${cancelBoundary()}    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Book" />
    <bpmn:sequenceFlow id="F2" sourceRef="Book" targetRef="E" />`,
    ],
    [
      'a plain subprocess',
      'subprocess',
      blockDoc({ tag: 'subProcess', beside: cancelBoundary() }),
    ],
  ])(
    'a cancel boundary on %s refuses, naming the host',
    async (_title, noun, xml) => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(xml),
        UnsupportedEventFeatureError,
      );
      expect(e.elementId).toBe('Boundary_Book_cancel');
      expect(e.message).toBe(
        "The event construct at 'Boundary_Book_cancel' cannot be imported: a " +
          `cancel boundary event attaches to "Book", a ${noun}; Operaton ` +
          'only allows a cancel boundary on a <bpmn:transaction>, and refuses ' +
          'to deploy the file otherwise. Attach it to a <bpmn:transaction>, ' +
          'or take the cancel definition off it.',
      );
    },
  );

  it('a second cancel boundary on the same block refuses', async () => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(
        pairedDoc({
          beside: cancelBoundary() + cancelBoundary('Boundary_Book_cancel2'),
        }),
      ),
      UnsupportedEventFeatureError,
    );
    expect(e.elementId).toBe('Boundary_Book_cancel2');
    expect(e.message).toBe(
      "The event construct at 'Boundary_Book_cancel2' cannot be imported: a " +
        'second cancel boundary event attaches to "Book"; Operaton allows ' +
        'one cancel boundary per block and refuses to deploy a file with two. ' +
        'Leave one cancel boundary event on the block.',
    );
  });

  it('a cancel definition on an event handler start refuses as a kind that position does not take', async () => {
    const e = await expectRefusal<UnsupportedEventDefinitionError>(
      xmlToIr(handlerDoc('<bpmn:cancelEventDefinition id="HDef" />')),
      UnsupportedEventDefinitionError,
    );
    expect(e.eventKind).toBe('start');
    expect(e.definitionType).toBe('bpmn:CancelEventDefinition');
  });

  it('a non-interrupting cancel boundary refuses', async () => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(
        pairedDoc({
          beside: cancelBoundary(
            'Boundary_Book_cancel',
            'cancelActivity="false"',
          ),
        }),
      ),
      UnsupportedEventFeatureError,
    );
    expect(e.message).toBe(
      "The event construct at 'Boundary_Book_cancel' cannot be imported: a " +
        'cancel boundary event cannot be non-interrupting ' +
        '(cancelActivity="false"); Operaton deploys it and lets what ' +
        'follows the boundary run beside the block instead of taking over ' +
        `from it, which this surface cannot write back. ${EVENT_SURFACE_NOTE}`,
    );
  });

  it('a cancel end with no cancel boundary on its block warns, naming the runtime failure', async () => {
    const { warnings } = await xmlToIr(
      blockDoc({ body: BLOCK_BODY + CANCEL_END }),
    );
    expectOneWarning(warnings, {
      elementId: 'Book',
      category: 'unmappedConstruct',
      message:
        "The block 'Book' holds an end event that gives it up, with no " +
        'cancel boundary event attached to it: Operaton deploys the file and ' +
        'then stops with an error the first time that end is reached. Write ' +
        "'on Book: cancel { ... }' beside the block to catch it.",
    });
  });

  it('a cancel boundary on a block that never gives itself up warns, naming the unreachable path', async () => {
    const { warnings } = await xmlToIr(blockDoc({ beside: cancelBoundary() }));
    expectOneWarning(warnings, {
      elementId: 'Boundary_Book_cancel',
      category: 'unmappedConstruct',
      message:
        "The cancel boundary event on 'Book' was imported, but nothing " +
        'inside the block gives it up, so what follows the boundary can ' +
        'never run.',
    });
  });

  it.each([
    [
      'method',
      'method="##Store"',
      'Operaton reads it on a <bpmn:transaction> not at all',
    ],
    [
      'protocol',
      'protocol="two-phase"',
      'Operaton reads it on a <bpmn:transaction> not at all',
    ],
    [
      'triggeredByEvent',
      'triggeredByEvent="true"',
      'Operaton ignores it on a <bpmn:transaction> and runs the block as an ' +
        'ordinary step of the surrounding flow',
    ],
  ])(
    '%s on the block warns exactly once and is dropped',
    async (name, attrs, reason) => {
      const { ir, warnings } = await xmlToIr(blockDoc({ attrs }));
      expect(subProcess(ir, 'Book')).not.toHaveProperty(name);
      expectOneWarning(warnings, {
        elementId: 'Book',
        category: 'unmappedConstruct',
        message:
          `The '${name}' attribute on 'Book' was not imported: ${reason}, so ` +
          'the imported block runs exactly as the source document does.',
      });
    },
  );

  it('a block writing none of the three warns about nothing', async () => {
    const { warnings } = await xmlToIr(blockDoc());
    expect(warnings).toEqual([]);
  });

  it('isForCompensation="true" on the block still refuses', async () => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(blockDoc({ attrs: 'isForCompensation="true"' })),
      UnsupportedEventFeatureError,
      IS_FOR_COMPENSATION_DETAIL,
    );
    expect(e.elementId).toBe('Book');
  });

  it('an undo handler directly inside the block imports, while one at process level still refuses', async () => {
    const undoHandler = `      <bpmn:subProcess id="UndoCharge" triggeredByEvent="true">
        <bpmn:startEvent id="UndoStart">
          <bpmn:compensateEventDefinition id="UndoStartDef" />
        </bpmn:startEvent>
        <bpmn:userTask id="RefundCard" />
        <bpmn:sequenceFlow id="UF1" sourceRef="UndoStart" targetRef="RefundCard" />
      </bpmn:subProcess>
`;
    const { ir, warnings } = await xmlToIr(
      blockDoc({ body: BLOCK_BODY + undoHandler }),
    );
    expect(
      subProcess(subProcess(ir, 'Book'), 'UndoCharge').triggeredByEvent,
    ).toBe(true);
    expect(warnings).toEqual([]);

    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(blockDoc({ beside: undoHandler })),
      UnsupportedEventFeatureError,
    );
    expect(e.detail).toBe(
      'a compensation handler must be hosted directly by the block whose ' +
        'completed work it undoes, not by the process; move it inside that ' +
        'block',
    );
  });

  it('engine settings, an input/output mapping and a repetition on the block import with no warnings', async () => {
    const { ir, warnings } = await xmlToIr(
      blockDoc({
        attrs: 'operaton:asyncBefore="true"',
        body: `      <bpmn:multiInstanceLoopCharacteristics operaton:collection="seats" />
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="seat">1A</operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
${BLOCK_BODY}`,
      }),
    );
    const block = subProcess(ir, 'Book');
    expect(block.asyncBefore).toBe(true);
    expect(block.inputParameters).toEqual([ioParam('seat', textValue('1A'))]);
    expect(block.loop).toEqual({ collection: 'seats' });
    expect(warnings).toEqual([]);
  });
});
