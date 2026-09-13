/**
 * Integration-level tests: `xmlToIr` runs against real BPMN XML strings,
 * including the golden fixture files under `tests/golden/`.
 *
 * `xmlToIr` returns `{ ir, warnings }`, where `warnings` reports non-semantic
 * content dropped on import (extra Operaton/camunda extension attributes and
 * elements, lanes, and documentation this surface has no slot for). Semantic
 * content the IR cannot express is refused instead: an
 * `UnsupportedConstructError` subclass is thrown before any IR is produced.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { fileURLToPath } from 'node:url';

import { xmlToIr } from '../src/xml-to-ir.js';
import type { ImportWarning } from '../src/xml-to-ir.js';
import { HISTORY_TIME_TO_LIVE, irToXml } from '../src/ir-to-xml.js';
import {
  UnsupportedCallActivityError,
  UnsupportedCollaborationError,
  UnsupportedConditionExpressionError,
  UnsupportedConstructError,
  UnsupportedElementError,
  UnsupportedEventDefinitionError,
  UnsupportedAssignmentError,
  UnsupportedErrorMappingError,
  UnsupportedEventFeatureError,
  UnsupportedExtensionFormError,
  UnsupportedFormFieldConstraintError,
  UnsupportedFormReferenceError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedServiceTaskFormError,
} from '../src/errors.js';
import type {
  BpmnProcess,
  CallActivity,
  EventDefinition,
  FlowElement,
  FormField,
  IntermediateCatchEvent,
  ListenerBinding,
  ServiceTaskBinding,
  VersionBinding,
} from '../src/ir/types.js';
import { isGateway } from '../src/ir/types.js';
import { expectRefusal } from './helpers/expect-refusal.js';
import {
  boundaryEvent,
  around,
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
  processIr,
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

// Only the compensation-rewrite-preview tests below re-parse printed DSL; every
// other test in this file asserts against the IR alone.
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/** Only the warnings reporting dropped Operaton/camunda extension content. */
const extensionWarnings = (warnings: ImportWarning[]): ImportWarning[] =>
  warnings.filter((w) => w.category === 'extensionAttribute');

/** Only the warnings reporting BPMN content the transform does not map. */
const unmappedWarnings = (warnings: ImportWarning[]): ImportWarning[] =>
  warnings.filter((w) => w.category === 'unmappedConstruct');

/** One expected warning, matched on its message; a dropped extension unless told otherwise. */
const warning = (
  elementId: string,
  message: RegExp,
  category: ImportWarning['category'] = 'extensionAttribute',
): { elementId: string; category: string; message: unknown } => ({
  elementId,
  category,
  message: expect.stringMatching(message),
});

/** The whole refusal an activity excluded from normal flow draws. */
const IS_FOR_COMPENSATION_DETAIL =
  'isForCompensation="true" marks this activity as excluded from normal ' +
  'flow: the boundary-event compensation-handler pattern, which this tool ' +
  'cannot import; wrap the steps in their own subprocess and target it with ' +
  '"on compensation" instead';

/** The whole refusal a compensation boundary event draws with no genuine pairing. */
const COMPENSATION_BOUNDARY_DETAIL =
  'a compensation boundary event is not imported: BPMN attaches ' +
  'compensation through isForCompensation and a bpmn:association on ' +
  'the activity being compensated, not a boundary event; wrap the ' +
  'steps in their own subprocess and target it with "on compensation" instead';

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

describe('xmlToIr: canonical handwritten file', () => {
  it('imports to the canonical IR, with the diagram shapes, the incoming/outgoing wiring and the derivable process name left out, and no warnings', async () => {
    const { ir, warnings } = await xmlToIr(HANDWRITTEN_XML);
    expect(ir).toEqual(HANDWRITTEN_IMPORT_IR);
    expect(warnings).toEqual([]);
  });
});

describe('xmlToIr: camunda: prefix alias', () => {
  it('parsing the same file with camunda: prefixes yields the same IR', async () => {
    const camundaXml = HANDWRITTEN_XML.replace(
      /xmlns:operaton="http:\/\/operaton\.org\/schema\/1\.0\/bpmn"/g,
      'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"',
    ).replace(/operaton:/g, 'camunda:');

    const { ir } = await xmlToIr(camundaXml);
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

describe('xmlToIr: service task binding forms', () => {
  const importServiceTask = (attrs: string, doc = operatonDoc) =>
    importOnly(oneNodeDoc('serviceTask', { attrs, doc }), 'serviceTask');

  it.each([
    [
      'operaton:class',
      'operaton:class="com.example.Svc"',
      classBinding('com.example.Svc'),
    ],
    [
      'operaton:expression, carrying the raw text',
      'name="Expr Task" operaton:expression="${someBean.execute(execution)}"',
      exprBinding('${someBean.execute(execution)}'),
    ],
    [
      'operaton:delegateExpression',
      'name="Delegate Task" operaton:delegateExpression="${myDelegate}"',
      delegateBinding('${myDelegate}'),
    ],
    [
      'operaton:type="external" with a topic',
      'name="Ship It" operaton:type="external" operaton:topic="shipping"',
      externalBinding('shipping'),
    ],
    [
      'operaton:type="External", which runs the external worker as it does in the engine',
      'operaton:type="External" operaton:topic="shipping"',
      externalBinding('shipping'),
    ],
  ] as const)(
    'a lone %s imports to the binding it names, reporting nothing',
    async (_title, attrs, binding) => {
      const { node, warnings } = await importServiceTask(attrs);
      expect(node.binding).toEqual(binding);
      expect(warnings).toEqual([]);
    },
  );

  it('the camunda: prefix is accepted for the expression form', async () => {
    const { node } = await importServiceTask(
      'camunda:expression="${x}"',
      camundaDoc,
    );
    expect(node.binding.kind).toBe('expression');
  });

  it('operaton:type="external" WITHOUT a topic stays refused', async () => {
    await expect(
      xmlToIr(oneNodeDoc('serviceTask', { attrs: 'operaton:type="external"' })),
    ).rejects.toBeInstanceOf(UnsupportedServiceTaskFormError);
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
    expect(e.message).toContain('no execution discriminator');
    expect(e.message).toContain(
      'Supported forms are a Java class, an expression, a delegate expression, ' +
        'an external task topic, or, on a business rule task, a decision reference.',
    );
  });

  /** The connector construct sentence every row below must refuse with. */
  const CONNECTOR_CONSTRUCT =
    'an <operaton:connector> element, which the Connect plugin runs in ' +
    'place of whatever operaton:class, expression, delegateExpression, or ' +
    'type names beside it, and which an engine without the plugin runs ' +
    'instead of, so the same file has two possible executions';

  const connectorChild = (prefix: 'operaton' | 'camunda'): string =>
    `        <${prefix}:connector><${prefix}:connectorId>http-connector` +
    `</${prefix}:connectorId></${prefix}:connector>`;

  it.each([
    [
      'a connector alone refuses, no longer as "no execution discriminator"',
      'serviceTask',
      '',
      'operaton',
      'Service task',
    ],
    [
      'a connector beside operaton:class refuses the connector, not the class',
      'serviceTask',
      'operaton:class="com.example.Svc"',
      'operaton',
      'Service task',
    ],
    [
      'a connector beside operaton:type="external" and a topic refuses the connector',
      'serviceTask',
      'operaton:type="external" operaton:topic="shipping"',
      'operaton',
      'Service task',
    ],
    [
      'the deprecated camunda:connector prefix beside a class refuses alike',
      'serviceTask',
      'camunda:class="com.example.Svc"',
      'camunda',
      'Service task',
    ],
    [
      'a bpmn:sendTask carrying a connector refuses, named as a send task',
      'sendTask',
      '',
      'operaton',
      'Send task',
    ],
    [
      'a bpmn:businessRuleTask naming a decision and a connector refuses on the connector',
      'businessRuleTask',
      'operaton:decisionRef="dec1"',
      'operaton',
      'Business rule task',
    ],
  ] as const)('%s', async (_title, tag, attrs, prefix, subject) => {
    const e = await expectRefusal<UnsupportedServiceTaskFormError>(
      xmlToIr(
        oneNodeDoc(tag, {
          attrs,
          children: extensionElements(connectorChild(prefix)),
          doc: prefix === 'camunda' ? camundaDoc : operatonDoc,
        }),
      ),
      UnsupportedServiceTaskFormError,
    );
    expect(e.construct).toBe(CONNECTOR_CONSTRUCT);
    expect(e.subject).toBe(subject);
  });
});

describe('xmlToIr: parallel gateway support', () => {
  it('a lone bpmn:parallelGateway imports carrying its id', async () => {
    const { node } = await importOnly(
      oneNodeDoc('parallelGateway', { id: 'PG', doc: bpmnDoc }),
      'parallelGateway',
    );
    expect(node.id).toBe('PG');
  });

  it('a fork and a join import with their labels, and no condition is invented on the branches', async () => {
    const { ir, warnings } = await xmlToIr(
      bpmnDefs`  <bpmn:process id="parallel-proc" isExecutable="true">
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
  </bpmn:process>`,
    );

    expect(ir).toEqual(
      processIr(
        'parallel-proc',
        [
          { kind: 'startEvent', id: 'Start' },
          { kind: 'parallelGateway', id: 'Fork', name: 'Fork' },
          // "Branch A" is humanize("BranchA"), so the label is derivable.
          { kind: 'userTask', id: 'BranchA' },
          { kind: 'userTask', id: 'BranchB' },
          { kind: 'parallelGateway', id: 'Join', name: 'Join' },
          { kind: 'endEvent', id: 'End' },
        ],
        [
          { id: 'F_Start_Fork', sourceRef: 'Start', targetRef: 'Fork' },
          { id: 'F_Fork_A', sourceRef: 'Fork', targetRef: 'BranchA' },
          { id: 'F_Fork_B', sourceRef: 'Fork', targetRef: 'BranchB' },
          { id: 'F_A_Join', sourceRef: 'BranchA', targetRef: 'Join' },
          { id: 'F_B_Join', sourceRef: 'BranchB', targetRef: 'Join' },
          { id: 'F_Join_End', sourceRef: 'Join', targetRef: 'End' },
        ],
      ),
    );
    expect(warnings).toEqual([]);
  });
});

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

  it('a deployment resource refuses instead of importing an empty script, in the same words as the operaton:script spelling', async () => {
    const resource = 'deployment://check.groovy';
    const e = await expectRefusal<UnsupportedExtensionFormError>(
      xmlToIr(
        oneNodeDoc('scriptTask', {
          id: 'ST',
          attrs: `scriptFormat="javascript" operaton:resource="${resource}"`,
          children: '<bpmn:script>1 + 1</bpmn:script>',
        }),
      ),
      UnsupportedExtensionFormError,
      `the script on 'ST' names an external resource ("${resource}"); ` +
        'only an inline script body can be written here',
    );
    expect(e.elementId).toBe('ST');

    // The listener spelling of the same attribute, which already refused:
    // both must throw the identical sentence, so the two cannot drift apart.
    const listenerErr = await expectRefusal<UnsupportedExtensionFormError>(
      xmlToIr(
        oneNodeDoc('serviceTask', {
          attrs: 'operaton:class="com.example.Svc"',
          children: extensionElements(
            `        <operaton:executionListener event="start">
          <operaton:script scriptFormat="groovy" resource="${resource}" />
        </operaton:executionListener>`,
          ),
        }),
      ),
      UnsupportedExtensionFormError,
      'the operaton:script in an operaton:executionListener names an ' +
        `external resource ("${resource}"); only an inline script body ` +
        'can be written here',
    );
    expect(listenerErr.elementId).toBe('T');
  });
});

describe('xmlToIr: unsupported element (still refused kinds)', () => {
  it.each([
    ['bpmn:AdHocSubProcess', 'adHocSubProcess', '<bpmn:userTask id="A" />'],
    ['bpmn:ComplexGateway', 'complexGateway', ''],
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
        'gateways, parallel gateways, inclusive gateways, event-based ' +
        'gateways, embedded subprocesses, attempt blocks, call activities, ' +
        'and sequence flows are supported.',
    );
  });
});

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

  describe('a start carries message, signal, timer, or condition', () => {
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

    it('a conditional start imports as the condition the engine waits on', async () => {
      const { node, warnings } = await importById(
        startTriggerXml(`<bpmn:conditionalEventDefinition id="cd">
        <bpmn:condition>\${stockLevel &lt; 5}</bpmn:condition>
      </bpmn:conditionalEventDefinition>`),
        'TStart',
        'startEvent',
      );
      expect(node.eventDefinition).toEqual(conditionDef('${stockLevel < 5}'));
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

    it('a link start refuses, naming every trigger a process start does take', async () => {
      const e = await expectRefusal<UnsupportedEventDefinitionError>(
        xmlToIr(
          startTriggerXml('<bpmn:linkEventDefinition id="ld" name="Resume" />'),
        ),
        UnsupportedEventDefinitionError,
      );
      expect([e.elementId, e.eventKind, e.definitionType]).toEqual([
        'TStart',
        'start',
        'bpmn:LinkEventDefinition',
      ]);
      expect(e.message).toContain(
        "a process's start supports message, signal, timer, or condition",
      );
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
          'signal, timer, or condition trigger is supported',
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

  describe('a process takes several starts, a subprocess or transaction takes one', () => {
    it('a process with two start events imports both, each keeping its outgoing flow', async () => {
      const { ir, warnings } =
        await xmlToIr(bpmnDoc`    <bpmn:startEvent id="S1" />
    <bpmn:startEvent id="S2" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S1" targetRef="E" />
    <bpmn:sequenceFlow id="F2" sourceRef="S2" targetRef="E" />`);
      expect(warnings).toEqual([]);
      expect(ir.flowElements.map((fe) => [fe.kind, fe.id])).toEqual([
        ['startEvent', 'S1'],
        ['startEvent', 'S2'],
        ['endEvent', 'E'],
      ]);
      expect(ir.sequenceFlows.map((f) => [f.sourceRef, f.targetRef])).toEqual([
        ['S1', 'E'],
        ['S2', 'E'],
      ]);
    });

    it.each(['bpmn:subProcess', 'bpmn:transaction'])(
      'a %s with two start events refuses, attributed to it',
      async (tag) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(bpmnDoc`    <bpmn:startEvent id="S" />
    <${tag} id="Sub">
      <bpmn:startEvent id="S1" />
      <bpmn:startEvent id="S2" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="S1" targetRef="SubEnd" />
    </${tag}>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />`),
          UnsupportedEventFeatureError,
          'it has 2 start events; this tool writes one entry point per ' +
            'subprocess or transaction, so a second start has nowhere to go',
        );
        expect(e.elementId).toBe('Sub');
      },
    );
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

    it('a message end imports the name of the message root it references, with no binding of its own', async () => {
      const { node, warnings } = await importById(
        endTriggerXml(MESSAGE_DEF, { roots: MESSAGE_ROOT }),
        'Typed',
        'endEvent',
      );
      expect(node.eventDefinition).toEqual(messageDef('OrderReceived'));
      expect('binding' in node).toBe(false);
      expect(warnings).toEqual([]);
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
      // The signal remedy is offered unqualified even at the start position:
      // a signal start does take an expression name, a message start does not.
      [
        'a signal start',
        startTriggerXml(SIGNAL_DEF, { roots: EXPR_SIGNAL_ROOT }),
        'TStart',
        SIGNAL_EXPR_DETAIL,
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

  it('a plain start and end (no event definition at all) are not refused', async () => {
    const { ir, warnings } = await xmlToIr(
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
    );
    expect(ir.flowElements.map((fe) => fe.kind)).toEqual([
      'startEvent',
      'endEvent',
    ]);
    expect(warnings).toEqual([]);
  });
});

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

  it('a standard loop imports the step that runs once and reports the dropped element', async () => {
    const { node, warnings } = await importOnly(
      oneNodeDoc('serviceTask', {
        id: 'RepeatSvc',
        attrs: 'operaton:class="com.example.Svc"',
        children: '<bpmn:standardLoopCharacteristics />',
      }),
      'serviceTask',
    );
    expect(node.loop).toBeUndefined();
    expect(warnings).toEqual([
      {
        elementId: 'RepeatSvc',
        category: 'unmappedConstruct',
        message:
          "The bpmn:standardLoopCharacteristics on 'RepeatSvc' was not " +
          'imported: Operaton does not run one at all, it deploys the step ' +
          'and runs it once, so the imported step runs once too.',
      },
    ]);
  });

  it('an event handler carrying a multi-instance repetition is refused', async () => {
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

  it('an event handler carrying a standard loop imports as a step that runs once and reports the dropped element, same as any other host', async () => {
    const { ir, warnings } = await xmlToIr(
      handlerDoc(
        '<bpmn:signalEventDefinition id="SigDef" signalRef="Signal_Escalate" />',
        { roots: '  <bpmn:signal id="Signal_Escalate" name="Escalate" />\n' },
      ).replace(
        '<bpmn:subProcess id="Handler" triggeredByEvent="true">',
        '<bpmn:subProcess id="Handler" triggeredByEvent="true">\n      ' +
          '<bpmn:standardLoopCharacteristics />',
      ),
    );
    const handler = ir.flowElements.find((el) => el.id === 'Handler');
    expect(handler?.kind === 'subProcess' && handler.loop).toBeUndefined();
    expect(warnings).toEqual([
      {
        elementId: 'Handler',
        category: 'unmappedConstruct',
        message:
          "The bpmn:standardLoopCharacteristics on 'Handler' was not " +
          'imported: Operaton does not run one at all, it deploys the step ' +
          'and runs it once, so the imported step runs once too.',
      },
    ]);
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
    [
      'a job priority',
      oneNodeDoc('userTask', { attrs: 'operaton:jobPriority="#{high}"' }),
      rewrapped("'jobPriority' setting", 'T'),
    ],
    [
      'a user task priority',
      oneNodeDoc('userTask', { attrs: 'operaton:priority="#{high}"' }),
      rewrapped("'priority' setting", 'T'),
    ],
    [
      'a call activity version binding',
      oneNodeDoc('callActivity', {
        attrs:
          'calledElement="sub" operaton:calledElementBinding="version" ' +
          'operaton:calledElementVersion="#{v}"',
      }),
      rewrapped('calledElementVersion', 'T'),
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

describe('xmlToIr: a scripted condition on a sequence flow or a conditional event definition', () => {
  /** `S -> X -> {T, E}`, `F2` carrying the condition under test. */
  const flowDoc = (
    conditionAttrs: string,
    doc: XmlTag = operatonDoc,
    body = 'amount &gt; 1000',
  ): string =>
    doc`    <bpmn:startEvent id="S" />
    <bpmn:exclusiveGateway id="X" />
    <bpmn:userTask id="T" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="X" />
    <bpmn:sequenceFlow id="F2" sourceRef="X" targetRef="T">
      <bpmn:conditionExpression ${conditionAttrs}>${body}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F3" sourceRef="X" targetRef="E" />
    <bpmn:sequenceFlow id="F4" sourceRef="T" targetRef="E" />`;

  it.each([
    [
      'language alone names the language the engine would run it in',
      'language="groovy"',
      operatonDoc,
      'it declares language="groovy", which Operaton runs in a script ' +
        'engine rather than evaluating as UEL',
    ],
    [
      'language with operaton:resource names both, since the resource is what actually runs',
      'language="groovy" operaton:resource="deployment://check.groovy"',
      operatonDoc,
      'it declares language="groovy" with ' +
        'operaton:resource="deployment://check.groovy", which Operaton ' +
        'runs as that deployed script rather than the body written here',
    ],
    [
      'language with camunda:resource behaves the same as the operaton: spelling',
      'language="groovy" camunda:resource="deployment://check.groovy"',
      camundaDoc,
      'it declares language="groovy" with ' +
        'operaton:resource="deployment://check.groovy", which Operaton ' +
        'runs as that deployed script rather than the body written here',
    ],
  ] as const)('%s', async (_title, attrs, doc, detail) => {
    await expectRefusal<UnsupportedConditionExpressionError>(
      xmlToIr(flowDoc(attrs, doc)),
      UnsupportedConditionExpressionError,
      detail,
    );
  });

  it.each([
    [
      'operaton:resource',
      'operaton:resource="deployment://check.groovy"',
      operatonDoc,
    ],
    [
      'camunda:resource',
      'camunda:resource="deployment://check.groovy"',
      camundaDoc,
    ],
  ] as const)(
    'a lone %s imports the inline expression and reports the dropped resource',
    async (_prefix, attrs, doc) => {
      const { ir, warnings } = await xmlToIr(flowDoc(attrs, doc));
      const flow = ir.sequenceFlows.find((f) => f.id === 'F2');
      expect(flow?.conditionExpression).toBe('amount > 1000');
      expect(warnings).toEqual([
        {
          elementId: 'F2',
          category: 'extensionAttribute',
          message:
            "The 'operaton:resource' setting on 'F2' only takes effect " +
            'alongside a language attribute; on its own the condition ' +
            'runs as the expression written in the body, and the ' +
            'attribute was not imported.',
        },
      ]);
    },
  );

  // Operaton's parseConditionExpression is the shared helper behind both a
  // sequence flow's conditionExpression and a conditional event definition's
  // condition, so the same language/resource handling applies at every
  // position a conditional event definition can occupy.
  const conditionalDoc = (
    conditionAttrs: string,
    position: 'boundary' | 'event-subprocess start' | 'intermediate catch',
    body = 'amount &gt; 1000',
  ): string => {
    const definition = `<bpmn:conditionalEventDefinition id="CondDef">
        <bpmn:condition ${conditionAttrs}>${body}</bpmn:condition>
      </bpmn:conditionalEventDefinition>`;
    if (position === 'boundary') {
      return operatonDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Owner" attachedToRef="Review">
      ${definition}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />`;
    }
    if (position === 'event-subprocess start') {
      return handlerDoc(definition, { defs: operatonDefs });
    }
    return oneNodeDoc('intermediateCatchEvent', {
      id: 'Owner',
      children: definition,
      doc: operatonDoc,
    });
  };

  it.each([
    ['a boundary conditional event', 'boundary', 'Owner'],
    [
      'an event sub-process start conditional trigger',
      'event-subprocess start',
      'HStart',
    ],
    [
      'an intermediate catch conditional trigger',
      'intermediate catch',
      'Owner',
    ],
  ] as const)(
    '%s refuses a language and warns on a lone operaton:resource on its bpmn:condition',
    async (_title, position, ownerId) => {
      await expectRefusal<UnsupportedConditionExpressionError>(
        xmlToIr(conditionalDoc('language="groovy"', position)),
        UnsupportedConditionExpressionError,
        'it declares language="groovy", which Operaton runs in a script ' +
          'engine rather than evaluating as UEL',
      );

      const { warnings } = await xmlToIr(
        conditionalDoc(
          'operaton:resource="deployment://check.groovy"',
          position,
        ),
      );
      expect(warnings).toEqual([
        {
          elementId: ownerId,
          category: 'extensionAttribute',
          message:
            `The 'operaton:resource' setting on '${ownerId}' only takes ` +
            'effect alongside a language attribute; on its own the ' +
            'condition runs as the expression written in the body, and ' +
            'the attribute was not imported.',
        },
      ]);
    },
  );
});

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

  it('a document containing a bpmn:Collaboration refuses, as an UnsupportedConstructError', async () => {
    const err = await expectRefusal<UnsupportedCollaborationError>(
      xmlToIr(collaborationXml),
      UnsupportedCollaborationError,
    );
    expect(err).toBeInstanceOf(UnsupportedConstructError);
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe('xmlToIr: warns for dropped extension attributes', () => {
  it.each([
    ['operaton', operatonDoc],
    ['camunda', camundaDoc],
  ] as const)(
    'a %s:formHandlerClass is reported against the task carrying it, while the assignee beside it is read',
    async (prefix, doc) => {
      const { node, warnings } = await importOnly(
        oneNodeDoc('userTask', {
          id: 'FormHandlerTask',
          attrs:
            `name="Form Handler Task" ${prefix}:assignee="alice" ` +
            `${prefix}:formHandlerClass="com.example.FormHandler"`,
          doc,
        }),
        'userTask',
      );
      expect(node.assignee).toBe('alice');
      expectOneWarning(warnings, {
        elementId: 'FormHandlerTask',
        category: 'extensionAttribute',
        message: 'formHandlerClass',
      });
    },
  );

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

  /** `start -> E`, with the given attributes on the process and on its start. */
  const headerDoc = (
    processAttrs: string,
    startAttrs = '',
    startId = 'S',
  ): string =>
    operatonDefs`  <bpmn:process id="p" isExecutable="true" ${processAttrs}>
    <bpmn:startEvent id="${startId}" ${startAttrs} />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="${startId}" targetRef="E" />
  </bpmn:process>`;

  // Each is declared in the moddle extension, so it parses into a typed
  // property (not `$attrs`) and is invisible to the raw-attribute sweep: read
  // it and the descriptor scan stays silent, drop it and the scan reports it.
  it.each([
    [
      'a process keeps the history time to live it authored',
      'operaton:historyTimeToLive="P90D"',
      '',
      (ir: BpmnProcess) => ir.historyTimeToLive,
      'P90D',
    ],
    [
      'the value the exporter stamps for a process that authored none reads as unwritten',
      `operaton:historyTimeToLive="${HISTORY_TIME_TO_LIVE}"`,
      '',
      (ir: BpmnProcess) => ir.historyTimeToLive,
      undefined,
    ],
    [
      'a process keeps the users allowed to start it',
      'operaton:candidateStarterUsers="demo,manager"',
      '',
      (ir: BpmnProcess) => ir.candidateStarterUsers,
      'demo,manager',
    ],
    [
      'a process keeps the groups allowed to start it',
      'operaton:candidateStarterGroups="adjusters"',
      '',
      (ir: BpmnProcess) => ir.candidateStarterGroups,
      'adjusters',
    ],
    [
      'a start keeps the variable the engine writes the starting user into',
      '',
      'operaton:initiator="claimant"',
      (ir: BpmnProcess) => only(ir, 'startEvent').initiator,
      'claimant',
    ],
  ])('%s', async (_title, processAttrs, startAttrs, read, expected) => {
    const { ir, warnings } = await xmlToIr(headerDoc(processAttrs, startAttrs));
    expect([read(ir), warnings]).toEqual([expected, []]);
  });

  // `CONSUMED_EXTENSION_ATTRS` is keyed by `$type`, so declaring `initiator`
  // read on `bpmn:StartEvent` silences the unread-attribute sweep for a
  // handler's start as much as for the process's own. Only this test stands
  // between a handler start's value and being dropped without a word.
  it('an event handler start keeps its initiator too', async () => {
    const { ir, warnings } = await xmlToIr(
      handlerDoc('<bpmn:signalEventDefinition id="d" signalRef="Signal_1" />', {
        startAttrs: 'operaton:initiator="claimant"',
        roots: '  <bpmn:signal id="Signal_1" name="StockLow" />\n',
        defs: operatonDefs,
      }),
    );
    const handlerStart = only(subProcess(ir, 'Handler'), 'startEvent');
    expect([handlerStart.initiator, warnings]).toEqual(['claimant', []]);
  });

  // A start the modeler left unnamed carries the id this tool mints for one it
  // synthesizes, which a script cannot repeat, so the whole statement is left
  // out and the initiator with it. The unread-attribute sweep no longer covers
  // it, so this report is all that stands between the value and a silent drop.
  it.each([
    [
      "a process's own start",
      headerDoc('', 'operaton:initiator="claimant"', 'StartEvent_1'),
    ],
    [
      'an event handler start, whose trigger prints in the header instead',
      operatonDefs`  <bpmn:signal id="Signal_1" name="StockLow" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="StartEvent_1" operaton:initiator="claimant">
        <bpmn:signalEventDefinition id="d" signalRef="Signal_1" />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`,
    ],
  ])(
    '%s printing no statement says its initiator went with it',
    async (_title, xml) => {
      const { warnings } = await xmlToIr(xml);
      expect(warnings).toEqual([
        {
          elementId: 'StartEvent_1',
          category: 'extensionAttribute',
          message:
            "The 'operaton:initiator' setting on 'StartEvent_1' was not " +
            "written to the script: 'StartEvent_1' is the kind of name this " +
            'tool generates for itself, which a script cannot repeat, so this ' +
            'start is left out entirely and its initiator with it. Rename it ' +
            'in the diagram to keep the initiator.',
        },
      ]);
    },
  );
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

  it('surfaces one lane warning per lane, naming the lane, and still imports the body', async () => {
    const { ir, warnings } = await xmlToIr(lanesXml);
    expect(ir.flowElements.map((fe) => fe.id)).toEqual(['S', 'E']);
    expect(warnings.map((w) => [w.category, w.elementId])).toEqual([
      ['lane', 'Lane_Sales'],
      ['lane', 'Lane_Support'],
    ]);
    expect(warnings[0].message).toContain('Sales');
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

describe('xmlToIr: an empty extensionElements is not flagged beside a real drop', () => {
  /**
   * A user task with a stray empty `<bpmn:extensionElements/>` beside a
   * service task with a real `<operaton:field>`. A document-level "unparsable
   * content" boolean cannot tell the two apart and would flag both; typing the
   * operaton extension elements makes the drop attributable to the exact
   * owning element.
   */
  it('reports the field against the service task alone, because an operaton:expression binding never receives an injected field, and reads the assignee off the clean task', async () => {
    const { ir, warnings } = await xmlToIr(
      operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="CleanTask" name="Clean Task" operaton:assignee="alice">
      <bpmn:extensionElements/>
    </bpmn:userTask>
    <bpmn:serviceTask id="ConfiguredSvc" operaton:expression="\${someBean.execute(execution)}">
      <bpmn:extensionElements>
        <operaton:field name="greeting" stringValue="hello" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CleanTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="CleanTask" targetRef="ConfiguredSvc" />
    <bpmn:sequenceFlow id="F3" sourceRef="ConfiguredSvc" targetRef="E" />`,
    );

    const clean = byId(ir, 'CleanTask');
    expect(clean.kind === 'userTask' && clean.assignee).toBe('alice');
    expectOneWarning(warnings, {
      elementId: 'ConfiguredSvc',
      category: 'extensionAttribute',
      message: "'greeting'",
    });
  });
});

describe('xmlToIr: foreign-namespace extension elements are per-element', () => {
  it('names a camunda: extension element against its owning task', async () => {
    const xml = oneNodeDoc('serviceTask', {
      id: 'CamSvc',
      // The class keeps a supported form, so mapping does not refuse first.
      attrs: 'name="Cam Svc" camunda:class="com.example.Svc"',
      // camunda:field, not camunda:connector: the element alias covers
      // attributes only, and a connector now refuses rather than warns.
      children: extensionElements(
        `        <camunda:field name="greeting" stringValue="hello" />`,
      ),
      doc: camundaDoc,
    });
    const { warnings } = await xmlToIr(xml);
    expectOneWarning(warnings, {
      elementId: 'CamSvc',
      category: 'extensionAttribute',
      message: 'Extra configuration (camunda:field)',
    });
  });
});

describe('xmlToIr: undeclared operaton extension element residual', () => {
  const residualXml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="CleanTask" name="Clean Task">
      <bpmn:extensionElements/>
    </bpmn:userTask>
    <bpmn:userTask id="PropsTask" name="Props Task">
      <bpmn:extensionElements>
        <operaton:potentialStarter />
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CleanTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="CleanTask" targetRef="PropsTask" />
    <bpmn:sequenceFlow id="F3" sourceRef="PropsTask" targetRef="E" />`;

  it('reports the undeclared element once (no silent loss) without flagging the clean task', async () => {
    const { warnings } = await xmlToIr(residualXml);
    // The process id is the coarse attribution for a residual drop moddle
    // cannot tie to a specific step.
    expectOneWarning(extensionWarnings(warnings), {
      elementId: 'p',
      message: /potentialStarter/i,
    });
    expect(warnings.some((w) => w.elementId === 'CleanTask')).toBe(false);
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

describe('xmlToIr: bpmn:documentation', () => {
  const doc = (text: string): string =>
    `<bpmn:documentation>${text}</bpmn:documentation>`;

  /** Every `(id, documentation)` the IR holds, the process itself included. */
  const documented = (ir: BpmnProcess): [string, string][] => {
    const carried: [string, string][] = [];
    const visit = (node: BpmnProcess | FlowElement): void => {
      if ('documentation' in node && node.documentation !== undefined) {
        carried.push([node.id, node.documentation]);
      }
      if ('flowElements' in node) node.flowElements.forEach(visit);
    };
    visit(ir);
    return carried;
  };

  const reported = (warnings: ImportWarning[]): unknown[] =>
    warnings.map((w) => [w.category, w.elementId, w.message]);

  const expected = (
    rows: readonly (readonly [ImportWarning['category'], string, string])[],
  ): unknown[] =>
    rows.map(([category, id, detail]) => [
      category,
      id,
      expect.stringContaining(detail),
    ]);

  const TIMER = `<bpmn:timerEventDefinition>
        <bpmn:timeDuration>P1D</bpmn:timeDuration>
      </bpmn:timerEventDefinition>`;

  /**
   * One row per position `bpmn:documentation` can sit on, each stating the text
   * the IR node holds and the warnings the document draws whole. A position
   * that carries draws none, and a position wired to neither branch fails both
   * columns rather than passing in silence.
   */
  const POSITIONS: [
    title: string,
    xml: string,
    carried: readonly (readonly [string, string])[],
    warned: readonly (readonly [ImportWarning['category'], string, string])[],
  ][] = [
    [
      'a process, its start and its end each carry their own',
      bpmnDoc`    ${doc('Onboarding, end to end.')}
    <bpmn:startEvent id="S">${doc('Fires when HR files the request.')}</bpmn:startEvent>
    <bpmn:endEvent id="E">${doc('The hire is on the payroll.')}</bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      [
        ['p', 'Onboarding, end to end.'],
        ['S', 'Fires when HR files the request.'],
        ['E', 'The hire is on the payroll.'],
      ],
      [],
    ],
    ...(
      [
        ['a user task', 'userTask', '', ''],
        [
          'a service task',
          'serviceTask',
          'operaton:class="com.example.Svc"',
          '',
        ],
        ['a send task', 'sendTask', 'operaton:class="com.example.Svc"', ''],
        [
          'a business rule task',
          'businessRuleTask',
          'operaton:class="com.example.Svc"',
          '',
        ],
        [
          'a script task',
          'scriptTask',
          'scriptFormat="javascript"',
          '<bpmn:script>total = 1;</bpmn:script>',
        ],
        ['a receive task', 'receiveTask', '', ''],
        ['a step', 'task', '', ''],
        ['a call activity', 'callActivity', 'calledElement="other"', ''],
        [
          'a subprocess',
          'subProcess',
          '',
          `<bpmn:startEvent id="SubS" />
      <bpmn:endEvent id="SubE" />
      <bpmn:sequenceFlow id="SubF" sourceRef="SubS" targetRef="SubE" />`,
        ],
        ['a branch point', 'exclusiveGateway', '', ''],
        ['a fork', 'inclusiveGateway', '', ''],
        ['a parallel fork', 'parallelGateway', '', ''],
      ] as const
    ).map(([subject, tag, attrs, extra]): (typeof POSITIONS)[number] => [
      `${subject} carries it`,
      oneNodeDoc(tag, { attrs, children: `${doc(`On ${tag}.`)}${extra}` }),
      [['T', `On ${tag}.`]],
      [],
    ]),
    [
      "the text is carried verbatim, the body's own whitespace included",
      oneNodeDoc('userTask', {
        children:
          '<bpmn:documentation>\n        Two lines.\n      </bpmn:documentation>',
      }),
      [['T', '\n        Two lines.\n      ']],
      [],
    ],
    [
      'an empty documentation body carries as an empty string',
      oneNodeDoc('userTask', {
        children: '<bpmn:documentation></bpmn:documentation>',
      }),
      [['T', '']],
      [],
    ],
    [
      'an event handler reports it, and the trigger start under it carries its own',
      bpmnDefs`  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">${doc('Runs when the deadline passes.')}
      <bpmn:startEvent id="HStart">${doc('The deadline itself.')}
      ${TIMER}
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
  </bpmn:process>`,
      [['HStart', 'The deadline itself.']],
      [['documentation', 'Handler', 'an event handler has no documentation']],
    ],
    [
      'a start and an end whose ids this tool writes for itself carry it and report that no script can spell it back',
      bpmnDoc`    <bpmn:startEvent id="StartEvent_1">${doc('Where it begins.')}</bpmn:startEvent>
    <bpmn:endEvent id="EndEvent_1">${doc('Where it stops.')}</bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="StartEvent_1" targetRef="EndEvent_1" />`,
      [
        ['StartEvent_1', 'Where it begins.'],
        ['EndEvent_1', 'Where it stops.'],
      ],
      [
        [
          'documentation',
          'StartEvent_1',
          'this start is left out entirely and its documentation with it',
        ],
        [
          'documentation',
          'EndEvent_1',
          'Where the script can do without this end, it is left out and its documentation with it',
        ],
      ],
    ],
    [
      'the definitions root reports it against the process',
      bpmnDefs`  ${doc('Exported by hand.')}
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`,
      [],
      [['documentation', 'p', 'the definitions root has no documentation']],
    ],
    [
      'an Error, an Escalation, a Message and a Signal root each report it',
      bpmnDefs`  <bpmn:error id="Err" name="Boom" errorCode="BOOM">${doc('Raised by the vendor.')}</bpmn:error>
  <bpmn:escalation id="Esc" name="Late" escalationCode="LATE">${doc('Raised on day three.')}</bpmn:escalation>
  <bpmn:message id="Msg" name="Paid">${doc('Sent by billing.')}</bpmn:message>
  <bpmn:signal id="Sig" name="Stocked">${doc('Broadcast by the warehouse.')}</bpmn:signal>
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`,
      [],
      [
        ['unreferencedRoot', 'Msg', 'is never used by an on/throw/emit'],
        ['unreferencedRoot', 'Sig', 'is never used by an on/throw/emit'],
        ['documentation', 'Err', 'a bpmn:error root has no documentation'],
        ['documentation', 'Esc', 'a bpmn:escalation root has no documentation'],
        ['documentation', 'Msg', 'a bpmn:message root has no documentation'],
        ['documentation', 'Sig', 'a bpmn:signal root has no documentation'],
      ],
    ],
    [
      'a repetition reports it, and the step it repeats carries its own',
      oneNodeDoc('userTask', {
        children: `${doc('Review one application.')}
      <bpmn:multiInstanceLoopCharacteristics>${doc('Once per applicant.')}
        <bpmn:loopCardinality>3</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>`,
      }),
      [['T', 'Review one application.']],
      [['documentation', 'T', 'a repetition has no documentation']],
    ],
    [
      'a sequence flow reports it',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E">${doc('Straight through.')}</bpmn:sequenceFlow>`,
      [],
      [['documentation', 'F1', 'a sequence flow has no documentation']],
    ],
    [
      'a boundary event reports it',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T" />
    <bpmn:boundaryEvent id="B" attachedToRef="T">${doc('Give up after a day.')}
      ${TIMER}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:endEvent id="Late" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
    <bpmn:sequenceFlow id="F3" sourceRef="B" targetRef="Late" />`,
      [],
      [['documentation', 'B', 'a boundary event has no documentation']],
    ],
    [
      'an await reports it, and so does the event definition inside it',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Await">${doc('Wait a day.')}
      <bpmn:timerEventDefinition>${doc('The day itself.')}
        <bpmn:timeDuration>P1D</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Await" />
    <bpmn:sequenceFlow id="F2" sourceRef="Await" targetRef="E" />`,
      [],
      [
        ['documentation', 'Await', 'an event definition has no documentation'],
        ['documentation', 'Await', 'an await has no documentation'],
      ],
    ],
    [
      'an emit reports it, and so does the event definition inside it',
      bpmnDefs`  <bpmn:signal id="Sig" name="Stocked" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateThrowEvent id="Emit">${doc('Tell the warehouse.')}
      <bpmn:signalEventDefinition signalRef="Sig">${doc('The broadcast itself.')}</bpmn:signalEventDefinition>
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Emit" />
    <bpmn:sequenceFlow id="F2" sourceRef="Emit" targetRef="E" />
  </bpmn:process>`,
      [],
      [
        ['documentation', 'Emit', 'an event definition has no documentation'],
        ['documentation', 'Emit', 'an emit has no documentation'],
      ],
    ],
    [
      'a throw reports it, and so does the event definition inside it',
      bpmnDefs`  <bpmn:error id="Err" name="Boom" errorCode="BOOM" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="Throw">${doc('Give up here.')}
      <bpmn:errorEventDefinition errorRef="Err">${doc('The error itself.')}</bpmn:errorEventDefinition>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Throw" />
  </bpmn:process>`,
      [],
      [
        ['documentation', 'Throw', 'an event definition has no documentation'],
        ['documentation', 'Throw', 'a throw has no documentation'],
      ],
    ],
    [
      'an end carrying a terminate definition carries its own and reports the definition',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="Stop">${doc('Nothing else runs.')}
      <bpmn:terminateEventDefinition>${doc('The terminate itself.')}</bpmn:terminateEventDefinition>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Stop" />`,
      [['Stop', 'Nothing else runs.']],
      [['documentation', 'Stop', 'an event definition has no documentation']],
    ],
  ];

  it.each(POSITIONS)('%s', async (_title, xml, carried, warned) => {
    const { ir, warnings } = await xmlToIr(xml);
    expect(documented(ir)).toEqual(carried);
    expect(reported(warnings)).toEqual(expected(warned));
  });

  it.each([
    [
      'a second documentation child leaves the element with none',
      `${doc('The first.')}${doc('The second.')}`,
      "this surface holds one <bpmn:documentation> and 'T' carries 2",
    ],
    [
      'a textFormat naming anything but plain text leaves the element with none',
      '<bpmn:documentation textFormat="text/html">&lt;p&gt;Hi&lt;/p&gt;</bpmn:documentation>',
      "this surface holds plain text and its textFormat is 'text/html'",
    ],
  ])('%s', async (_title, children, detail) => {
    const { ir, warnings } = await xmlToIr(
      oneNodeDoc('userTask', { children }),
    );
    expect(documented(ir)).toEqual([]);
    expect(reported(warnings)).toEqual(
      expected([['documentation', 'T', detail]]),
    );
  });
});

describe('xmlToIr: warns for unmapped BPMN content', () => {
  const reviewTaskDoc = (children: string) =>
    oneNodeDoc('userTask', { id: 'Review', children, doc: bpmnDoc });

  it.each([
    [
      'an artifact against the container holding it',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
    <bpmn:textAnnotation id="Note_1">
      <bpmn:text>Check the customer tier first.</bpmn:text>
    </bpmn:textAnnotation>
    <bpmn:association id="Assoc_1" sourceRef="S" targetRef="Note_1" />
    <bpmn:group id="Group_1" />`,
      [
        ['p', "bpmn:textAnnotation 'Note_1'"],
        ['p', "bpmn:association 'Assoc_1'"],
        ['p', "bpmn:group 'Group_1'"],
      ],
    ],
    [
      'an artifact inside a sub-process against that sub-process',
      bpmnDoc`    <bpmn:startEvent id="S" />
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
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />`,
      [['Sub', "bpmn:textAnnotation 'Note_Inner'"]],
    ],
    [
      'an activity ioSpecification and every property on it',
      reviewTaskDoc(`<bpmn:ioSpecification id="IO_1">
        <bpmn:dataInput id="DataIn_1" name="payload" />
        <bpmn:inputSet id="InSet_1" />
        <bpmn:outputSet id="OutSet_1" />
      </bpmn:ioSpecification>
      <bpmn:property id="Prop_1" name="localVar" />
      <bpmn:property id="Prop_2" name="otherVar" />`),
      [
        ['Review', "bpmn:ioSpecification 'IO_1'"],
        ['Review', "bpmn:property 'Prop_1'"],
        ['Review', "bpmn:property 'Prop_2'"],
      ],
    ],
    [
      'a data association on a user task, and a resource assignment on a service task, where the engine reads none',
      operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Review">
      <bpmn:dataOutputAssociation id="DataOut_1" />
    </bpmn:userTask>
    <bpmn:serviceTask id="Svc" operaton:class="com.example.Svc">
      <bpmn:potentialOwner id="Owner_1">
        <bpmn:resourceAssignmentExpression id="Assign_1">
          <bpmn:formalExpression id="Expr_1">managers</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>
      </bpmn:potentialOwner>
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Svc" />
    <bpmn:sequenceFlow id="F3" sourceRef="Svc" targetRef="E" />`,
      [
        ['Review', "bpmn:dataOutputAssociation 'DataOut_1'"],
        ['Svc', "bpmn:potentialOwner 'Owner_1'"],
      ],
    ],
    [
      'an attribute BPMN does not declare, against each element carrying it',
      bpmnDoc`    <bpmn:startEvent id="S" wobble="yes" />
    <bpmn:userTask id="Review" wobble="yes" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="E" />`,
      [
        ['S', "The 'wobble' attribute on 'S'"],
        ['Review', "The 'wobble' attribute on 'Review'"],
      ],
    ],
  ] as const)(
    // Each expected message names the construct's own id, so siblings of one
    // kind stay tellable apart.
    'reports %s',
    async (_title, xml, expected) => {
      const warnings = unmappedWarnings((await xmlToIr(xml)).warnings);
      expect(warnings.map((w) => [w.elementId, w.message])).toEqual(
        expected.map(([id, text]) => [id, expect.stringContaining(text)]),
      );
    },
  );

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

describe('xmlToIr: a data object, its reference, or a data store reference is dropped, not refused', () => {
  const DATA_OBJECT =
    '<bpmn:dataObject id="Data1"><bpmn:dataState id="State1" name="ready" /></bpmn:dataObject>';
  const DATA_OBJECT_REF = '<bpmn:dataObjectReference id="Data1" />';
  const DATA_STORE_REF = '<bpmn:dataStoreReference id="Data1" />';

  /** No `bpmn:sequenceFlow` names the data element: nothing can point at one. */
  const atProcessLevel = (el: string) =>
    operatonDoc`    <bpmn:startEvent id="S" />
    ${el}
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`;

  const insideSubProcess = (el: string) =>
    operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubS" />
      ${el}
      <bpmn:endEvent id="SubE" />
      <bpmn:sequenceFlow id="SubF" sourceRef="SubS" targetRef="SubE" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />`;

  const dropped = (tag: string) =>
    `A bpmn:${tag} 'Data1' was not imported: Operaton keeps process ` +
    'variables in its own store and never dispatches on it, so the ' +
    'imported process runs identically.';

  it.each([
    [
      'a dataObject with a dataState child at process level is reported once, whole',
      atProcessLevel(DATA_OBJECT),
      dropped('dataObject'),
    ],
    [
      'a dataObject with a dataState child inside a sub-process is reported once, whole',
      insideSubProcess(DATA_OBJECT),
      dropped('dataObject'),
    ],
    [
      'a dataObjectReference at process level is reported once, whole',
      atProcessLevel(DATA_OBJECT_REF),
      dropped('dataObjectReference'),
    ],
    [
      'a dataObjectReference inside a sub-process is reported once, whole',
      insideSubProcess(DATA_OBJECT_REF),
      dropped('dataObjectReference'),
    ],
    [
      'a dataStoreReference at process level is reported once, whole',
      atProcessLevel(DATA_STORE_REF),
      dropped('dataStoreReference'),
    ],
    [
      'a dataStoreReference inside a sub-process is reported once, whole',
      insideSubProcess(DATA_STORE_REF),
      dropped('dataStoreReference'),
    ],
  ] as const)('%s', async (_title, xml, message) => {
    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([
      { elementId: 'Data1', category: 'unmappedConstruct', message },
    ]);
  });
});

describe("xmlToIr: a root of a kind this tool does not model reports its own children once, and no one else's", () => {
  // `GlobalScriptTask.script` is declared `isAttr: true` in the moddle
  // schema, but the BPMN XSD makes `<bpmn:script>` an element, so moddle
  // cannot parse it and files it as residual "unparsable content" with no
  // owning element attached, only a source position.
  const GLOBAL_SCRIPT_TASK =
    '  <bpmn:globalScriptTask id="G3">\n' +
    '    <bpmn:script>x</bpmn:script>\n' +
    '  </bpmn:globalScriptTask>';

  const ROOT_DROP_NOTE =
    '(this tool imports the executable flow and the engine settings on ' +
    'its steps, and nothing declared or drawn beside it).';

  const KEPT_SETTINGS_NOTE =
    '(this tool keeps the assignee, form, form reference, script, ' +
    'service-task binding, injected fields, result variable, version tag, ' +
    "input/output mappings and listeners, an external task's priority, " +
    'properties and error mappings, and the async, retry, job-priority and ' +
    'task-assignment settings; a gateway carries no engine setting at all).';

  it.each([
    [
      'a globalScriptTask root is reported once, and its own script child is not blamed on the process',
      bpmnDefs`${GLOBAL_SCRIPT_TASK}
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`,
      [
        {
          elementId: 'G3',
          category: 'unmappedConstruct',
          message: `A bpmn:globalScriptTask 'G3' root element was not imported ${ROOT_DROP_NOTE}`,
        },
      ],
    ],
    [
      'a globalScriptTask root written after the process is reported once, and its script child is still not blamed on the process',
      bpmnDefs`  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:task id="T" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
${GLOBAL_SCRIPT_TASK}`,
      [
        {
          elementId: 'G3',
          category: 'unmappedConstruct',
          message: `A bpmn:globalScriptTask 'G3' root element was not imported ${ROOT_DROP_NOTE}`,
        },
      ],
    ],
    [
      'a self-closing root before a globalScriptTask leaves it recognised as a root, so its script child is still not blamed on the process',
      bpmnDefs`  <bpmn:globalTask id="G1" />
${GLOBAL_SCRIPT_TASK}
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`,
      [
        {
          elementId: 'G1',
          category: 'unmappedConstruct',
          message: `A bpmn:globalTask 'G1' root element was not imported ${ROOT_DROP_NOTE}`,
        },
        {
          elementId: 'G3',
          category: 'unmappedConstruct',
          message: `A bpmn:globalScriptTask 'G3' root element was not imported ${ROOT_DROP_NOTE}`,
        },
      ],
    ],
    [
      'a bpmn:name written as an element on a mapped task is still reported, with no unmapped root to hide behind',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:task id="T"><bpmn:name>x</bpmn:name></bpmn:task>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />`,
      [
        {
          elementId: 'p',
          category: 'extensionAttribute',
          message: `Extra engine-specific configuration (bpmn:name at line 5) was not imported; it could not be attributed to a specific step ${KEPT_SETTINGS_NOTE}`,
        },
      ],
    ],
    [
      'unmapped roots beside a mapped task written with a bpmn:name element draw one warning each, neither root swallowing the task',
      bpmnDefs`${GLOBAL_SCRIPT_TASK}
  <bpmn:globalTask id="G1" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:task id="T"><bpmn:name>x</bpmn:name></bpmn:task>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>`,
      [
        {
          elementId: 'G3',
          category: 'unmappedConstruct',
          message: `A bpmn:globalScriptTask 'G3' root element was not imported ${ROOT_DROP_NOTE}`,
        },
        {
          elementId: 'G1',
          category: 'unmappedConstruct',
          message: `A bpmn:globalTask 'G1' root element was not imported ${ROOT_DROP_NOTE}`,
        },
        {
          elementId: 'p',
          category: 'extensionAttribute',
          message: `Extra engine-specific configuration (bpmn:name at line 9) was not imported; it could not be attributed to a specific step ${KEPT_SETTINGS_NOTE}`,
        },
      ],
    ],
  ] as const)('%s', async (_title, xml, expected) => {
    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual(expected);
  });
});

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

  it('maps to a recursive IR SubProcess carrying its own nested body, and leaks none of it into the parent', async () => {
    const { ir, warnings } = await xmlToIr(nestedSubProcessXml);
    expect(ir).toEqual(
      around({
        kind: 'subProcess',
        id: 'Sub',
        name: 'Sub Process',
        flowElements: [
          { kind: 'startEvent', id: 'SubStart' },
          { kind: 'userTask', id: 'Review', assignee: 'demo' },
          { kind: 'endEvent', id: 'SubEnd' },
        ],
        sequenceFlows: [
          { id: 'SF1', sourceRef: 'SubStart', targetRef: 'Review' },
          { id: 'SF2', sourceRef: 'Review', targetRef: 'SubEnd' },
        ],
      }),
    );
    expect(warnings).toEqual([]);
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
                     operaton:assignee="alice" operaton:formHandlerClass="com.example.FormHandler" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="InnerTask" />
      <bpmn:sequenceFlow id="SF2" sourceRef="InnerTask" targetRef="SubEnd" />`,
      '',
      operatonDoc,
    );

    const { warnings } = await xmlToIr(xml);
    expectOneWarning(warnings, {
      elementId: 'InnerTask',
      message: 'formHandlerClass',
    });
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

  it('a fully-featured call activity imports to the exact expected IR node, reporting nothing', async () => {
    const { node, warnings } = await importOnly(richCallXml, 'callActivity');
    expect(node).toEqual(EXPECTED_RICH_CALL);
    expect(warnings).toEqual([]);
  });

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
      'operaton:calledElementVersion="#{v}"',
    );
    expect('binding' in node).toBe(false);
    expect(warnings).toEqual([
      {
        elementId: 'CallSub',
        category: 'extensionAttribute',
        message:
          "The 'calledElementVersion' setting on 'CallSub' has no effect " +
          'without calledElementBinding="version" and was not imported.',
      },
    ]);
  });

  it.each([
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

  it.each([
    [
      'operaton:variableMappingClass imports as a class mapper with no warning',
      'operaton:variableMappingClass="com.acme.Mapper"',
      { kind: 'class', className: 'com.acme.Mapper' },
      [],
    ],
    [
      'operaton:variableMappingDelegateExpression imports as a delegate mapper with no warning',
      'operaton:variableMappingDelegateExpression="${mapperBean}"',
      { kind: 'delegateExpression', expression: '${mapperBean}' },
      [],
    ],
    [
      'camunda:variableMappingClass imports the same way, matching the dual-namespace contract',
      'camunda:variableMappingClass="com.acme.Mapper"',
      { kind: 'class', className: 'com.acme.Mapper' },
      [],
    ],
    [
      'both attributes import the class and report the delegate as shadowed',
      'operaton:variableMappingClass="com.acme.Mapper" ' +
        'operaton:variableMappingDelegateExpression="${mapperBean}"',
      { kind: 'class', className: 'com.acme.Mapper' },
      [
        {
          elementId: 'CallSub',
          category: 'extensionAttribute',
          message:
            "The 'variableMappingDelegateExpression' setting on 'CallSub' " +
            'has no effect alongside operaton:variableMappingClass and was ' +
            'not imported.',
        },
      ],
    ],
  ] as const)(
    '%s',
    async (_title, attributes, expectedMapper, expectedWarnings) => {
      const { node, warnings } = await importCall(attributes);
      expect(node.mapper).toEqual(expectedMapper);
      expect(warnings).toEqual(expectedWarnings);
    },
  );

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

  it.each([
    ['equals humanize(id) is dropped', 'Fulfil Order', undefined],
    [
      'differs from humanize(id) is kept',
      'Send the order to fulfilment',
      'Send the order to fulfilment',
    ],
  ])('a call-activity label that %s', async (_title, written, kept) => {
    const { node } = await importOnly(
      oneNodeDoc('callActivity', {
        id: 'Fulfil_Order',
        attrs: `name="${written}" calledElement="sub-process"`,
        doc: bpmnDoc,
      }),
      'callActivity',
    );
    expect('name' in node).toBe(kept !== undefined);
    expect(node.name).toBe(kept);
  });
});

describe('xmlToIr: event layer import', () => {
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
    errorDecls: [{ name: 'PF', code: 'PF', message: 'boom' }],
    escalationDecls: [{ name: 'LS', code: 'LS' }],
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

  describe('warn-drops', () => {
    const ERROR_X_ROOT = '  <bpmn:error id="Error_X" errorCode="X" />\n';

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
        rootedDoc(
          ERROR_X_ROOT,
          `    <bpmn:endEvent id="ThrowX">
      <bpmn:errorEventDefinition errorRef="Error_X" operaton:errorCodeVariable="c" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ThrowX" />`,
          operatonDefs,
        ),
      );
      const end = byId(ir, 'ThrowX');
      expect(end.kind === 'endEvent' && end.eventDefinition).toEqual(
        errorDef('X'),
      );
      expectOneWarning(warnings, {
        elementId: 'ThrowX',
        message: 'errorCodeVariable',
      });
    });

    it('an unrelated operaton: attribute on a mapped event definition warns', async () => {
      const { warnings } = await xmlToIr(
        handlerDoc(
          '<bpmn:errorEventDefinition errorRef="Error_X" operaton:asyncBefore="true" />',
          { roots: ERROR_X_ROOT, defs: operatonDefs },
        ),
      );
      expectOneWarning(warnings, {
        elementId: 'HStart',
        message: 'asyncBefore',
      });
    });

    /** A lone declared root with a `S -> E` process that never references it. */
    const unusedRootXml = (root: string, defs = bpmnDefs) =>
      rootedDoc(
        `${root}\n`,
        `    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
        defs,
      );

    it('an unreferenced error root and an unreferenced escalation root both import as declarations, warning about neither', async () => {
      const { ir, warnings } = await xmlToIr(
        unusedRootXml(
          `  <bpmn:error id="Error_Unused" name="Unused" errorCode="UNUSED" />
  <bpmn:escalation id="Escalation_Review" name="Review" escalationCode="REVIEW" />`,
        ),
      );
      expect(warnings).toEqual([]);
      expect(ir.errorDecls).toEqual([{ name: 'Unused', code: 'UNUSED' }]);
      expect(ir.escalationDecls).toEqual([{ name: 'Review', code: 'REVIEW' }]);
    });

    it('an unreferenced root with a code and a message imports as a declaration carrying it', async () => {
      const { ir, warnings } = await xmlToIr(
        unusedRootXml(
          '  <bpmn:error id="Error_Declared" name="Declared" errorCode="DECL" operaton:errorMessage="declared but unused" />',
          operatonDefs,
        ),
      );
      expect(ir.errorDecls).toEqual([
        { name: 'Declared', code: 'DECL', message: 'declared but unused' },
      ]);
      expect(warnings).toEqual([]);
    });

    it.each([
      [
        'an error root with no code warns and is dropped',
        '  <bpmn:error id="Error_NoCode" name="NoCode" />',
        'Error_NoCode',
      ],
      [
        'an escalation root with no code warns and is dropped',
        '  <bpmn:escalation id="Escalation_NoCode" name="NoCode" />',
        'Escalation_NoCode',
      ],
    ])('%s', async (_title, root, elementId) => {
      const { ir, warnings } = await xmlToIr(unusedRootXml(root));
      expect(ir.errorDecls).toBeUndefined();
      expect(ir.escalationDecls).toBeUndefined();
      expect(
        warnings
          .filter((w) => w.category === 'unreferencedRoot')
          .map((w) => w.elementId),
      ).toEqual([elementId]);
    });

    it.each([
      [
        'a name no declaration could be written with is minted from the code',
        '<bpmn:error id="E1" name="not a name!" errorCode="order.failed" />',
        [{ name: 'order_failed', code: 'order.failed' }],
      ],
      [
        'a missing name falls back to the code where the code can be written as one',
        '<bpmn:error id="E1" errorCode="OUT_OF_STOCK" />',
        [{ name: 'OUT_OF_STOCK', code: 'OUT_OF_STOCK' }],
      ],
      [
        'a name that is a reserved word is prefixed, since a keyword cannot be an identifier',
        '<bpmn:error id="E1" name="while" errorCode="while" />',
        [{ name: '_while', code: 'while' }],
      ],
      [
        'a code opening on a digit is prefixed',
        '<bpmn:error id="E1" errorCode="404" />',
        [{ name: '_404', code: '404' }],
      ],
      [
        'two codes minting one name are told apart by a numeric suffix',
        `<bpmn:error id="E1" errorCode="order.failed" />
  <bpmn:error id="E2" errorCode="order/failed" />`,
        [
          { name: 'order_failed', code: 'order.failed' },
          { name: 'order_failed_2', code: 'order/failed' },
        ],
      ],
    ])('%s', async (_title, roots, expected) => {
      const { ir } = await xmlToIr(unusedRootXml(`  ${roots}`));
      expect(ir.errorDecls).toEqual(expected);

      const reexported = await irToXml(ir);
      expect(
        [
          ...reexported.matchAll(
            /<bpmn:error id="[^"]*" name="([^"]*)" errorCode="([^"]*)"/g,
          ),
        ].map(([, name, code]) => ({ name, code })),
      ).toEqual(expected);
    });
  });

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

describe('xmlToIr: message/signal/timer/conditional import', () => {
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
      [
        'camunda:variableName on a conditional definition, the deprecated spelling of the same narrowing',
        handlerDoc(
          `<bpmn:conditionalEventDefinition id="d" camunda:variableName="amount">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>`,
          { body: '', defs: camundaDefs },
        ),
        "a conditional definition's camunda:variableName narrows when the " +
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
        'An emit supports escalation, message, signal, compensation, or link.',
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

describe('xmlToIr: compensation import', () => {
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

    it.each([
      [
        'no bpmn:association leaves the boundary event at all',
        operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />
    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />`,
      ],
      [
        'the bpmn:association targets a plain task that never declared isForCompensation, so it is not a handler',
        operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />
    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>
    <bpmn:task id="NotAHandler" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
    <bpmn:association id="Assoc1" sourceRef="CompensationBoundary" targetRef="NotAHandler" />`,
      ],
    ] as const)(
      'a compensation boundary event refuses with the general wording, byte-for-byte, when %s',
      async (_title, xml) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
          COMPENSATION_BOUNDARY_DETAIL,
        );
        expect(e.elementId).toBe('CompensationBoundary');
      },
    );

    /** `S -> ReserveRoom -> E`, `ReserveRoom` compensated by `CancelReservation`. */
    const pairedDoc = (
      order: readonly ['boundary' | 'handler', 'boundary' | 'handler'],
    ) => {
      const boundary = `<bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>`;
      const handler =
        '<bpmn:userTask id="CancelReservation" isForCompensation="true" />';
      const byName = { boundary, handler };
      return operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />
    ${byName[order[0]]}
    ${byName[order[1]]}
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
    <bpmn:association id="Assoc1" sourceRef="CompensationBoundary" targetRef="CancelReservation" />`;
    };

    const REWRITE_PREVIEW = [
      'subprocess Compensated_ReserveRoom {',
      '  service ReserveRoom(class: "com.example.Reserve")',
      '  on compensation {',
      '    user CancelReservation',
      '  }',
      '}',
    ].join('\n');

    it.each([
      [
        'the boundary event comes first in document order',
        pairedDoc(['boundary', 'handler'] as const),
        'CompensationBoundary',
      ],
      [
        'the handler comes first in document order',
        pairedDoc(['handler', 'boundary'] as const),
        'CancelReservation',
      ],
    ] as const)(
      'a compensated activity, its boundary event and its association-linked handler are all named in the refusal, and the printed rewrite re-parses through the compiler (%s)',
      async (_title, xml, elementId) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
        );
        expect(e.elementId).toBe(elementId);
        expect(e.detail).toContain('ReserveRoom');
        expect(e.detail).toContain('CompensationBoundary');
        expect(e.detail).toContain('CancelReservation');

        const marker = 'Write it by hand instead:\n\n';
        const cut = e.detail.indexOf(marker);
        expect(cut).toBeGreaterThan(-1);
        const rewrite = e.detail.slice(cut + marker.length);
        expect(rewrite).toBe(REWRITE_PREVIEW);

        const wrapped = `process Preview {\n${rewrite}\n}\n`;
        const doc = await parse(wrapped, { validation: true });
        expect(doc.parseResult.parserErrors).toEqual([]);
        expect(doc.diagnostics ?? []).toEqual([]);
      },
    );

    it('a compensated activity carrying a repetition keeps the for-each clause in the printed rewrite', async () => {
      const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve">
      <bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" operaton:elementVariable="line" />
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>
    <bpmn:userTask id="CancelReservation" isForCompensation="true" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
    <bpmn:association id="Assoc1" sourceRef="CompensationBoundary" targetRef="CancelReservation" />`;

      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(xml),
        UnsupportedEventFeatureError,
      );
      const marker = 'Write it by hand instead:\n\n';
      const cut = e.detail.indexOf(marker);
      expect(cut).toBeGreaterThan(-1);
      const rewrite = e.detail.slice(cut + marker.length);
      expect(rewrite).toBe(
        [
          'var lines: any',
          'subprocess Compensated_ReserveRoom {',
          '  service ReserveRoom for each line in lines(class: "com.example.Reserve")',
          '  on compensation {',
          '    user CancelReservation',
          '  }',
          '}',
        ].join('\n'),
      );

      const wrapped = `process Preview {\n${rewrite}\n}\n`;
      const doc = await parse(wrapped, { validation: true });
      expect(doc.parseResult.parserErrors).toEqual([]);
      expect(doc.diagnostics ?? []).toEqual([]);
    });

    it('a compensated activity that independently carries content this tool cannot import at all still raises the compensation refusal, not that unrelated one', async () => {
      // The boundary comes first in document order, so `mapBoundaryEvent`
      // reaches it, and its rewrite preview, before the container walk ever
      // maps the host on its own: only the preview's own mapper call sees
      // the resource defect first.
      const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>
    <bpmn:scriptTask id="ReserveRoom" scriptFormat="javascript" operaton:resource="deployment://check.groovy" />
    <bpmn:userTask id="CancelReservation" isForCompensation="true" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
    <bpmn:association id="Assoc1" sourceRef="CompensationBoundary" targetRef="CancelReservation" />`;

      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(xml),
        UnsupportedEventFeatureError,
        COMPENSATION_BOUNDARY_DETAIL,
      );
      expect(e.elementId).toBe('CompensationBoundary');
    });
  });

  it('a document that imports successfully has the same warnings whether or not its bpmn:association goes through the compensation-refusal lookup', async () => {
    const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:task id="Review" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="E" />
    <bpmn:association id="Assoc1" sourceRef="Review" targetRef="E" />`;

    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([
      {
        elementId: 'p',
        category: 'unmappedConstruct',
        message:
          "A bpmn:association 'Assoc1' on 'p' was not imported " +
          '(this tool imports the executable flow and the engine settings ' +
          'on its steps, and nothing declared or drawn beside it).',
      },
    ]);
  });

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

describe('xmlToIr: boundary event import', () => {
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
    expect(ir).toEqual({
      ...EXPECTED_BOUNDARY_IR,
      errorDecls: [{ name: 'OOPS', code: 'OOPS' }],
    });
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
          'timer, or condition, plus cancel on a block that can be given up.',
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
});

describe('xmlToIr: intermediate catch event import', () => {
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
      'condition, or link triggers can be awaited inline; error and ' +
      'escalation are caught by an event handler and raised with ' +
      'throw/emit, compensation is undone by a subprocess block, and a ' +
      'cancel is written on the end that gives up an attempt block';

    it.each([
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
          'timer, signal, condition, or link trigger can be awaited',
      ],
      [
        'parallelMultiple="true"',
        signalRootDoc(
          'parallelMultiple="true"',
          '      <bpmn:signalEventDefinition id="d" signalRef="Signal_Ping" />',
        ),
        'an await with parallelMultiple="true" waits for several triggers ' +
          'together; only a single message, timer, signal, condition, or ' +
          'link trigger can be awaited',
      ],
      [
        'a "none" catch with zero event definitions',
        oneNodeDoc('intermediateCatchEvent', { id: 'Wait', doc: bpmnDoc }),
        'an await with no event definition (a "none" intermediate catch) ' +
          'waits for nothing this tool can represent',
      ],
      [
        // A timer catch is a supported kind: only the shape is refused, so
        // this is an UnsupportedEventFeatureError and not an
        // UnsupportedElementError.
        'a bodyless timerEventDefinition on a catch',
        unsupportedTriggerXml('<bpmn:timerEventDefinition id="d" />'),
        'a timer definition must carry exactly one of timeDuration/timeDate/' +
          'timeCycle (found 0)',
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

describe('xmlToIr: link events', () => {
  const LINK_DEF = '<bpmn:linkEventDefinition name="Retry" />';
  const link: EventDefinition = { kind: 'link', linkName: 'Retry' };

  interface PairOptions {
    throwAttrs?: string;
    /** Extension content written before the throw's definition. */
    throwChildren?: string;
    throwDef?: string;
    catchAttrs?: string;
    catchDef?: string;
    /** Flows written on top of the three the pair gets. */
    extraFlows?: string;
    defs?: XmlTag;
  }

  /** `S -> A -> ToRetry` (the throw) and `AtRetry` (the catch) `-> E`. */
  const pairDoc = ({
    throwAttrs = 'name="Retry"',
    throwChildren = '',
    throwDef = LINK_DEF,
    catchAttrs = 'name="Retry"',
    catchDef = LINK_DEF,
    extraFlows = '',
    defs = bpmnDefs,
  }: PairOptions = {}): string =>
    defs`  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="A" />
    <bpmn:intermediateThrowEvent id="ToRetry" ${throwAttrs}>${throwChildren}
      ${throwDef}
    </bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="AtRetry" ${catchAttrs}>
      ${catchDef}
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="A" />
    <bpmn:sequenceFlow id="F2" sourceRef="A" targetRef="ToRetry" />
    <bpmn:sequenceFlow id="F3" sourceRef="AtRetry" targetRef="E" />
${extraFlows}  </bpmn:process>`;

  it('a link pair imports as two disconnected events under one link name, and a name equal to the link name is nothing to report', async () => {
    const { ir, warnings } = await xmlToIr(pairDoc());
    expect(warnings).toEqual([]);
    expect([byId(ir, 'ToRetry'), byId(ir, 'AtRetry')]).toEqual([
      { kind: 'intermediateThrowEvent', id: 'ToRetry', eventDefinition: link },
      { kind: 'intermediateCatchEvent', id: 'AtRetry', eventDefinition: link },
    ]);
    expect(ir.sequenceFlows.map((f) => [f.sourceRef, f.targetRef])).toEqual([
      ['S', 'A'],
      ['A', 'ToRetry'],
      ['AtRetry', 'E'],
    ]);
  });

  it.each([
    ['the throw', 'ToRetry', 'an emit link', { throwAttrs: 'name="Go back"' }],
    ['the catch', 'AtRetry', 'an await link', { catchAttrs: 'name="Go back"' }],
  ] as const)(
    'a link event whose label is not its link name reports the label, on %s',
    async (_end, id, surface, options) => {
      const { ir, warnings } = await xmlToIr(pairDoc(options));
      expect(byId(ir, id)).not.toHaveProperty('name');
      expect(warnings).toEqual([
        {
          elementId: id,
          category: 'label',
          message:
            `The label 'Go back' on '${id}' was not imported: ${surface} ` +
            "has no label in this tool's surface.",
        },
      ]);
    },
  );

  it('engine settings and listeners on a link throw are reported one each and reach the IR on the catch alone', async () => {
    const { ir, warnings } = await xmlToIr(
      pairDoc({
        throwAttrs:
          'name="Retry" operaton:asyncBefore="true" operaton:jobPriority="5"',
        throwChildren: extensionElements(
          `        <operaton:failedJobRetryTimeCycle>R3/PT5M</operaton:failedJobRetryTimeCycle>
        <operaton:executionListener event="end" class="com.example.L" />`,
        ),
        catchAttrs: 'name="Retry" operaton:asyncBefore="true"',
        defs: operatonDefs,
      }),
    );
    expect([byId(ir, 'ToRetry'), byId(ir, 'AtRetry')]).toEqual([
      { kind: 'intermediateThrowEvent', id: 'ToRetry', eventDefinition: link },
      {
        kind: 'intermediateCatchEvent',
        id: 'AtRetry',
        eventDefinition: link,
        asyncBefore: true,
      },
    ]);
    const dropped = (what: string, does: string): ImportWarning => ({
      elementId: 'ToRetry',
      category: 'extensionAttribute',
      message:
        `The ${what} on 'ToRetry' was not imported: Operaton creates no ` +
        `activity for a link throw, so it never ${does} one.`,
    });
    expect(warnings).toEqual([
      dropped("'asyncBefore' setting", 'reads a setting on'),
      dropped("'jobPriority' setting", 'reads a setting on'),
      dropped("'retryCycle' setting", 'reads a setting on'),
      dropped("'end' execution listener", 'runs a listener on'),
    ]);
  });

  it.each([
    ['the throw', 'ToRetry', { throwDef: '<bpmn:linkEventDefinition />' }],
    ['the catch', 'AtRetry', { catchDef: '<bpmn:linkEventDefinition />' }],
    [
      'the throw, with an empty name',
      'ToRetry',
      { throwDef: '<bpmn:linkEventDefinition name="" />' },
    ],
  ] as const)(
    'a link definition with no name refuses, on %s',
    async (_end, id, options) => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(pairDoc(options)),
        UnsupportedEventFeatureError,
        'a link definition carries no name; the name is what a link throw ' +
          'and its catch match on, so one without it has nothing to match',
      );
      expect(e.elementId).toBe(id);
      expect(e.message).toContain(
        'Give the link definition a name, and the same name to the throw ' +
          'and the catch it joins.',
      );
    },
  );

  it.each([
    [
      'leaves the link throw',
      'ToRetry',
      '    <bpmn:sequenceFlow id="F4" sourceRef="ToRetry" targetRef="E" />\n',
      "the flow 'F4' leaves the link throw 'ToRetry'; a link throw ends its " +
        'path, and the token continues at the catch of the same name rather ' +
        'than along a flow',
    ],
    [
      'enters the link catch',
      'AtRetry',
      '    <bpmn:sequenceFlow id="F4" sourceRef="A" targetRef="AtRetry" />\n',
      "the flow 'F4' enters the link catch 'AtRetry'; a link catch is " +
        'entered by the throw of the same name rather than along a flow',
    ],
  ] as const)(
    'a flow that %s refuses, naming the flow',
    async (_shape, id, extraFlows, detail) => {
      const e = await expectRefusal<UnsupportedEventFeatureError>(
        xmlToIr(pairDoc({ extraFlows })),
        UnsupportedEventFeatureError,
        detail,
      );
      expect(e.elementId).toBe(id);
      expect(e.message).toContain(
        "Take the flow 'F4' off, and lead it from or to a step instead.",
      );
    },
  );

  it("a link on an event handler's start is still refused, like one on a process start, an end, or a boundary", async () => {
    const e = await expectRefusal<UnsupportedEventDefinitionError>(
      xmlToIr(handlerDoc(LINK_DEF)),
      UnsupportedEventDefinitionError,
    );
    expect([e.elementId, e.eventKind, e.definitionType]).toEqual([
      'HStart',
      'start',
      'bpmn:LinkEventDefinition',
    ]);
  });
});

describe('xmlToIr: a label on an event the surface gives no label to', () => {
  const TIMER = `<bpmn:timerEventDefinition id="d">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>`;

  it.each([
    [
      'a throw',
      'Throw',
      'Custom Label',
      rootedDoc(
        '  <bpmn:error id="Error_X" errorCode="X" />\n',
        `    <bpmn:endEvent id="Throw" name="Custom Label">
      <bpmn:errorEventDefinition errorRef="Error_X" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Throw" />`,
      ),
    ],
    [
      'an emit',
      'Emit',
      'Undo the booking',
      oneNodeDoc('intermediateThrowEvent', {
        id: 'Emit',
        attrs: 'name="Undo the booking"',
        children: '<bpmn:compensateEventDefinition id="d" />',
        doc: bpmnDoc,
      }),
    ],
    [
      'an event handler',
      'Handler',
      'Custom Handler Label',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true" name="Custom Handler Label">
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
    ],
    [
      'a boundary event',
      'Boundary',
      'Timed out',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Boundary" name="Timed out" attachedToRef="Review">
      ${TIMER}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="E" />`,
    ],
    [
      'an await',
      'Wait',
      'Awaiting payment',
      oneNodeDoc('intermediateCatchEvent', {
        id: 'Wait',
        attrs: 'name="Awaiting payment"',
        children: TIMER,
        doc: bpmnDoc,
      }),
    ],
  ] as const)(
    'on %s the label is dropped, and that is the only thing reported',
    async (surface, id, label, xml) => {
      const { ir, warnings } = await xmlToIr(xml);
      expect(byId(ir, id)).not.toHaveProperty('name');
      expect(warnings).toEqual([
        {
          elementId: id,
          category: 'label',
          message:
            `The label '${label}' on '${id}' was not imported: ${surface} ` +
            "has no label in this tool's surface.",
        },
      ]);
    },
  );
});

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
describe('xmlToIr: BPMN-native assignment and the quantity attributes', () => {
  const role = (
    tag: string,
    id: string,
    expression?: string,
    attrs = '',
  ): string =>
    `      <bpmn:${tag} id="${id}" ${attrs}>${
      expression === undefined
        ? ''
        : `
        <bpmn:resourceAssignmentExpression>
          <bpmn:formalExpression>${expression}</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>`
    }
      </bpmn:${tag}>`;
  const importReview = (attrs: string, children: string) =>
    importOnly(
      oneNodeDoc('userTask', { id: 'Review', attrs, children }),
      'userTask',
    );
  const reported = (warnings: ImportWarning[]) =>
    warnings.map((w) => [w.category, w.elementId, w.message]);

  it('merges the roles before the operaton: attributes, in the order the engine builds its lists, and names each rewrite', async () => {
    const { node, warnings } = await importReview(
      'operaton:candidateUsers="bob" operaton:candidateGroups="audit"',
      role('humanPerformer', 'Lead', 'demo') +
        role('potentialOwner', 'Team', 'user(mary), group(managers)') +
        role('potentialOwner', 'Finance', 'finance'),
    );
    expect(node).toEqual({
      kind: 'userTask',
      id: 'Review',
      assignee: 'demo',
      candidateUsers: 'mary,bob',
      candidateGroups: 'managers,finance,audit',
    });
    expect(reported(warnings)).toEqual([
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The bpmn:humanPerformer 'Lead' on 'Review' imports as assignee: "demo":.*parseHumanPerformerResourceAssignment.*operaton:assignee/,
        ),
      ],
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The bpmn:potentialOwner 'Team' on 'Review' imports as candidateUsers: "mary" and candidateGroups: "managers":.*parsePotentialOwnerResourceAssignment/,
        ),
      ],
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The bpmn:potentialOwner 'Finance' on 'Review' imports as candidateGroups: "finance":/,
        ),
      ],
    ]);
  });

  it.each([
    [
      'a humanPerformer beside operaton:assignee',
      'operaton:assignee="bob"',
      role('humanPerformer', 'Lead', 'demo'),
      /'Lead'.*"demo".*operaton:assignee="bob".*parseUserTaskCustomExtensions/,
    ],
    [
      'two humanPerformers',
      '',
      role('humanPerformer', 'Lead', 'demo') +
        role('humanPerformer', 'Backup', 'mary'),
      /2 bpmn:humanPerformer.*parseHumanPerformer/,
    ],
  ])('%s is refused', async (_title, attrs, children, detail) => {
    const err = await expectRefusal<UnsupportedAssignmentError>(
      xmlToIr(oneNodeDoc('userTask', { id: 'Review', attrs, children })),
      UnsupportedAssignmentError,
      detail,
    );
    expect(err.elementId).toBe('Review');
  });

  it.each([
    [
      'a comma inside an expression does not split',
      "user(${a}), group(x), ${groupOf(b, 'c')}",
      {
        candidateUsers: '${a}',
        candidateGroups: "x,${groupOf(b, 'c')}",
      },
      `imports as candidateUsers: "\${a}" and candidateGroups: "x,\${groupOf(b, 'c')}"`,
    ],
    [
      'a bare $ opens an expression no } closes, so the comma after it does not split either',
      'group(x), a$b, c',
      { candidateGroups: 'x,a$b, c' },
      'imports as candidateGroups: "x,a$b, c"',
    ],
  ])(
    'splits a potentialOwner as parseCommaSeparatedList does: %s',
    async (_title, expression, imported, detail) => {
      const { node, warnings } = await importReview(
        '',
        role('potentialOwner', 'Team', expression),
      );
      expect(node).toEqual({ kind: 'userTask', id: 'Review', ...imported });
      expect(reported(warnings)).toEqual([
        ['unmappedConstruct', 'Review', expect.stringContaining(detail)],
      ]);
    },
  );

  it('drops a role without a formal expression, any other resource role, and what a read role carries beside its expression, and leaves the generic drop on every other activity', async () => {
    const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Review">
${role('humanPerformer', 'Lead', 'demo', 'resourceRef="Res_1"')}
${role('potentialOwner', 'Empty')}
${role('performer', 'Actor', 'ops')}
      <bpmn:potentialOwner id="XsiSpelled">
        <bpmn:resourceAssignmentExpression>
          <bpmn:expression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">demo</bpmn:expression>
        </bpmn:resourceAssignmentExpression>
      </bpmn:potentialOwner>
    </bpmn:userTask>
    <bpmn:serviceTask id="Svc" operaton:class="com.example.Svc">
${role('potentialOwner', 'Owner_1', 'managers')}
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Svc" />
    <bpmn:sequenceFlow id="F3" sourceRef="Svc" targetRef="E" />`;
    const { ir, warnings } = await xmlToIr(xml);
    expect(byId(ir, 'Review')).toEqual({
      kind: 'userTask',
      id: 'Review',
      assignee: 'demo',
    });
    expect(reported(warnings)).toEqual([
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The bpmn:humanPerformer 'Lead' on 'Review' imports as assignee: "demo":/,
        ),
      ],
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The resourceRef on the bpmn:humanPerformer 'Lead' on 'Review' was not imported:.*formal expression alone/,
        ),
      ],
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The bpmn:potentialOwner 'Empty' on 'Review' was not imported: it carries no formal expression.*parsePotentialOwnerResourceAssignment/,
        ),
      ],
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The bpmn:performer 'Actor' on 'Review' was not imported:.*by tag.*parseTaskDefinition/,
        ),
      ],
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The bpmn:potentialOwner 'XsiSpelled' on 'Review' was not imported: it carries no formal expression.*parsePotentialOwnerResourceAssignment/,
        ),
      ],
      [
        'unmappedConstruct',
        'Svc',
        expect.stringMatching(
          /^A bpmn:potentialOwner 'Owner_1' on 'Svc' was not imported/,
        ),
      ],
    ]);
  });

  it('warns for a startQuantity or completionQuantity away from 1, which BpmnParse never reads', async () => {
    const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Review" startQuantity="3" />
    <bpmn:subProcess id="Sub" startQuantity="1">
      <bpmn:startEvent id="SubS" />
      <bpmn:serviceTask id="Svc" operaton:class="com.example.Svc" completionQuantity="2" />
      <bpmn:endEvent id="SubE" />
      <bpmn:sequenceFlow id="SubF1" sourceRef="SubS" targetRef="Svc" />
      <bpmn:sequenceFlow id="SubF2" sourceRef="Svc" targetRef="SubE" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Sub" />
    <bpmn:sequenceFlow id="F3" sourceRef="Sub" targetRef="E" />`;
    const { warnings } = await xmlToIr(xml);
    expect(reported(warnings)).toEqual([
      [
        'unmappedConstruct',
        'Review',
        expect.stringMatching(
          /^The 'startQuantity' attribute on 'Review' was not imported: .*BpmnParse never reads it/,
        ),
      ],
      [
        'unmappedConstruct',
        'Svc',
        expect.stringMatching(
          /^The 'completionQuantity' attribute on 'Svc' was not imported: .*BpmnParse never reads it/,
        ),
      ],
    ]);
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
        isGateway(fe) ? undefined : fe.asyncBefore,
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

  it.each([
    [
      'an operaton:formData, which is read off a start event or a user task',
      '',
      extensionElements(`        <operaton:formData>
          <operaton:formField id="amount" type="long" />
        </operaton:formData>`),
      /FormData/i,
    ],
    [
      'an operaton:assignee, which is read off a user task',
      'operaton:assignee="alice"',
      '',
      'assignee',
    ],
  ] as const)(
    'a service task carrying %s reports it as dropped',
    async (_title, attrs, children, message) => {
      const { warnings } = await xmlToIr(serviceTaskXml(attrs, children));
      expectOneWarning(extensionWarnings(warnings), {
        elementId: 'Svc',
        message,
      });
    },
  );

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
    expectOneWarning(extensionWarnings(taskResult.warnings), {
      elementId: 'T',
      message: /In/i,
    });

    const callResult = await xmlToIr(onCallActivity);
    expect(callResult.warnings).toEqual([]);
    const call = byId(callResult.ir, 'C');
    expect(call.kind === 'callActivity' && call.inMappings).toEqual([
      { kind: 'variable', source: 'a', target: 'b' },
    ]);
  });
});

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

/** The reason a field under a binding that receives no field list draws. */
const boundElsewhere = (binding: string): string =>
  'Operaton injects a field into a class or delegate binding and into no ' +
  `other, and this one is bound by ${binding}`;

describe('xmlToIr: an injected field rides a class or a delegate binding', () => {
  const importBound = (tag: string, attrs: string, fields: string) =>
    importById(
      oneNodeDoc(tag, {
        id: 'Svc',
        attrs,
        children: extensionElements(fields),
      }),
      'Svc',
      'serviceTask',
    );

  const field = (attrs: string, body = ''): string =>
    body === ''
      ? `        <operaton:field ${attrs} />`
      : `        <operaton:field ${attrs}>${body}</operaton:field>`;

  const warned = (message: string): ImportWarning => ({
    elementId: 'Svc',
    category: 'extensionAttribute',
    message,
  });

  const dropped = (reason: string, name = "'greeting'"): ImportWarning =>
    warned(`The injected field ${name} on 'Svc' was not imported: ${reason}.`);

  const CLASS = 'operaton:class="com.example.Svc"';
  const GREETING = field('name="greeting" stringValue="hello"');
  const SVC = classBinding('com.example.Svc');
  const INJECTED = [{ name: 'greeting', value: 'hello' }];
  const SVC_INJECTED: ServiceTaskBinding = {
    kind: 'class',
    className: 'com.example.Svc',
    fields: INJECTED,
  };

  const cases: readonly [
    string,
    string,
    string,
    string,
    ServiceTaskBinding,
    ImportWarning[],
  ][] = [
    [
      'a class binding carries a quoted value as the literal the engine injects',
      'serviceTask',
      CLASS,
      GREETING,
      SVC_INJECTED,
      [],
    ],
    [
      'a delegate binding carries an operaton:expression child as the expression the engine evaluates',
      'sendTask',
      'operaton:delegateExpression="${svcBean}"',
      field(
        'name="greeting"',
        '<operaton:expression>${who}</operaton:expression>',
      ),
      {
        kind: 'delegateExpression',
        expression: '${svcBean}',
        fields: [{ name: 'greeting', value: '${who}' }],
      },
      [],
    ],
    [
      'a code-bound business rule task keeps both of its fields in the order the document writes them',
      'businessRuleTask',
      CLASS,
      `${GREETING}\n${field('name="role" stringValue="clerk"')}`,
      {
        kind: 'class',
        className: 'com.example.Svc',
        fields: [...INJECTED, { name: 'role', value: 'clerk' }],
      },
      [],
    ],
    [
      'an operaton:string child carries, and warns that export writes it back as a stringValue attribute',
      'serviceTask',
      CLASS,
      field('name="greeting"', '<operaton:string>hello</operaton:string>'),
      SVC_INJECTED,
      [
        warned(
          "The injected field 'greeting' on 'Svc' writes its value in an " +
            'operaton:string child, which this tool writes back as a ' +
            'stringValue attribute; the engine injects the same text either way.',
        ),
      ],
    ],
    [
      'a stringValue that reads as an expression drops, because export would write it back as an operaton:expression the engine evaluates',
      'serviceTask',
      CLASS,
      field('name="greeting" stringValue="${who}"'),
      SVC,
      [
        dropped(
          "a stringValue attribute holding '${who}' would be written back " +
            'as an operaton:expression child, and the engine would evaluate ' +
            'it rather than inject the text',
        ),
      ],
    ],
    [
      'an operaton:expression child that does not read as an expression drops, because export would write it back as the literal stringValue, and its text is quoted on one line',
      'serviceTask',
      CLASS,
      field(
        'name="greeting"',
        '<operaton:expression>hello\n          world</operaton:expression>',
      ),
      SVC,
      [
        dropped(
          'an operaton:expression child holding ' +
            "'hello\\n          world' would be written back as a stringValue " +
            'attribute, and the engine would inject that text rather than ' +
            'evaluate it',
        ),
      ],
    ],
    [
      'a pretty-printed operaton:expression child drops, because the engine evaluates the body it is handed untrimmed and the indentation is part of the expression',
      'serviceTask',
      CLASS,
      field(
        'name="greeting"',
        '\n          <operaton:expression>\n            ${who}\n          </operaton:expression>\n        ',
      ),
      SVC,
      [
        dropped(
          'an operaton:expression child holding ' +
            "'\\n            ${who}\\n          ' would be written back as a " +
            'stringValue attribute, and the engine would inject that text ' +
            'rather than evaluate it',
        ),
      ],
    ],
    [
      'an operaton:string child keeps every space it carries, because the engine injects it verbatim',
      'serviceTask',
      CLASS,
      field('name="greeting"', '<operaton:string>  hello  </operaton:string>'),
      {
        kind: 'class',
        className: 'com.example.Svc',
        fields: [{ name: 'greeting', value: '  hello  ' }],
      },
      [
        warned(
          "The injected field 'greeting' on 'Svc' writes its value in an " +
            'operaton:string child, which this tool writes back as a ' +
            'stringValue attribute; the engine injects the same text either way.',
        ),
      ],
    ],
    [
      'a stringValue beside an operaton:expression child carries the stringValue Operaton reads, and reports the child it passes over',
      'serviceTask',
      CLASS,
      field(
        'name="greeting" stringValue="hello"',
        '<operaton:expression>${who}</operaton:expression>',
      ),
      SVC_INJECTED,
      [
        warned(
          "The 'operaton:expression' child of the injected field 'greeting' " +
            "on 'Svc' has no effect alongside a stringValue attribute and was " +
            'not imported.',
        ),
      ],
    ],
    [
      'a field declaring no name drops, because a field is injected under the name it declares',
      'serviceTask',
      CLASS,
      field('stringValue="hello"'),
      SVC,
      [
        dropped(
          'a field is injected under the name it declares, and this one ' +
            'declares none',
          '(unnamed)',
        ),
      ],
    ],
    [
      'an expression binding receives no field list, so the field drops',
      'serviceTask',
      'operaton:expression="${svcBean.run()}"',
      GREETING,
      exprBinding('${svcBean.run()}'),
      [dropped(boundElsewhere('operaton:expression'))],
    ],
    [
      'an external topic receives no field list, so the field drops',
      'serviceTask',
      'operaton:type="external" operaton:topic="rate"',
      GREETING,
      externalBinding('rate'),
      [dropped(boundElsewhere('operaton:type="external"'))],
    ],
    [
      'a decision binding receives no field list, so the field drops',
      'businessRuleTask',
      'operaton:decisionRef="riskRating" operaton:decisionRefBinding="latest"',
      GREETING,
      {
        kind: 'decision',
        decisionRef: 'riskRating',
        binding: { kind: 'latest' },
      },
      [dropped(boundElsewhere('an operaton:decisionRef'))],
    ],
  ];

  it.each(cases)(
    '%s',
    async (_title, tag, attrs, fields, binding, expected) => {
      const { node, warnings } = await importBound(tag, attrs, fields);
      expect(node.binding).toEqual(binding);
      expect(warnings).toEqual(expected);
    },
  );

  it('a field on a step with no binding to inject into is reported whole', async () => {
    const { warnings } = await importUserTaskWith(GREETING);
    expect(warnings.map((w) => w.message)).toEqual([
      "The injected field 'greeting' on 'Review' was not imported: this tool " +
        'carries an injected field on the step or the listener whose class ' +
        'or delegate binding receives it, and on no other position.',
    ]);
  });

  it('a carried field still reports the attributes no reader reads off it', async () => {
    const { node, warnings } = await importBound(
      'serviceTask',
      CLASS,
      field(
        'xmlns:foo="http://foo.example" name="greeting" stringValue="hello" foo:bar="1"',
      ),
    );
    expect(node.binding).toEqual(SVC_INJECTED);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/'foo:bar' on an operaton:field 'greeting'/),
    ]);
  });
});

describe('xmlToIr: a listener carries an injected field on the same two bindings', () => {
  const GREETING =
    '          <operaton:field name="greeting" stringValue="hello" />';
  const SCRIPT =
    '          <operaton:script scriptFormat="groovy">x = 1</operaton:script>\n';

  /** The single listener's binding, off the node each listener kind hangs on. */
  const importListener = async (
    kind: 'execution' | 'task',
    attrs: string,
    body = '',
  ): Promise<{ binding: ListenerBinding; warnings: ImportWarning[] }> => {
    const child = (tag: string, event: string): string =>
      `        <operaton:${tag} event="${event}" ${attrs}>\n${body}${GREETING}\n        </operaton:${tag}>`;

    if (kind === 'execution') {
      const { node, warnings } = await importServiceTask(
        child('executionListener', 'start'),
      );
      return { binding: node.executionListeners![0].binding, warnings };
    }
    const { node, warnings } = await importUserTaskWith(
      child('taskListener', 'create'),
    );
    return { binding: node.taskListeners![0].binding, warnings };
  };

  const cases: readonly [
    string,
    'execution' | 'task',
    string,
    string,
    ListenerBinding,
    ImportWarning[],
  ][] = [
    [
      'an execution listener bound by class carries the field onto its own binding',
      'execution',
      'class="com.example.L"',
      '',
      {
        kind: 'class',
        className: 'com.example.L',
        fields: [{ name: 'greeting', value: 'hello' }],
      },
      [],
    ],
    [
      'a task listener bound by a delegate expression carries the field onto its own binding',
      'task',
      'delegateExpression="${listenerBean}"',
      '',
      {
        kind: 'delegateExpression',
        expression: '${listenerBean}',
        fields: [{ name: 'greeting', value: 'hello' }],
      },
      [],
    ],
    [
      'a listener bound by a fenced script receives no field list, so the field drops',
      'execution',
      '',
      SCRIPT,
      scriptValue('groovy', 'x = 1'),
      [
        {
          elementId: 'Svc',
          category: 'extensionAttribute',
          message:
            "The injected field 'greeting' on an operaton:executionListener " +
            `on 'Svc' was not imported: ${boundElsewhere('an operaton:script child')}.`,
        },
      ],
    ],
  ];

  it.each(cases)('%s', async (_title, kind, attrs, body, binding, expected) => {
    const { binding: imported, warnings } = await importListener(
      kind,
      attrs,
      body,
    );
    expect(imported).toEqual(binding);
    expect(warnings).toEqual(expected);
  });
});

describe('xmlToIr: a user task names a deployed form by reference', () => {
  const importFormRef = (attrs: string, doc = operatonDoc) =>
    importOnly(oneNodeDoc('userTask', { attrs, doc }), 'userTask');

  const bound: readonly [string, string, VersionBinding][] = [
    [
      'the latest deployed form',
      'operaton:formRefBinding="latest"',
      { kind: 'latest' },
    ],
    [
      'the form deployed alongside the process',
      'operaton:formRefBinding="deployment"',
      { kind: 'deployment' },
    ],
    [
      'one pinned version of the form',
      'operaton:formRefBinding="version" operaton:formRefVersion="3"',
      { kind: 'version', version: '3' },
    ],
  ];

  it.each(bound)(
    'a formRef resolving to %s imports the key and the binding together, reporting nothing',
    async (_title, attrs, binding) => {
      const { node, warnings } = await importFormRef(
        `operaton:formRef="review-form" ${attrs}`,
      );
      expect(node).toEqual({
        kind: 'userTask',
        id: 'T',
        formRef: { key: 'review-form', binding },
      });
      expect(warnings).toEqual([]);
    },
  );

  it('the camunda: prefix spells the same form reference', async () => {
    const { node, warnings } = await importFormRef(
      'camunda:formRef="review-form" camunda:formRefBinding="version" ' +
        'camunda:formRefVersion="3"',
      camundaDoc,
    );
    expect(node).toEqual({
      kind: 'userTask',
      id: 'T',
      formRef: {
        key: 'review-form',
        binding: { kind: 'version', version: '3' },
      },
    });
    expect(warnings).toEqual([]);
  });

  it.each([
    [
      'a version the binding beside it never resolves is reported, and the reference still imports',
      'operaton:formRef="review-form" operaton:formRefBinding="latest" operaton:formRefVersion="3"',
      { key: 'review-form', binding: { kind: 'latest' } },
      [
        "The 'formRefVersion' setting on 'T' has no effect without " +
          'formRefBinding="version" and was not imported.',
      ],
    ],
    [
      'a binding and a version with no formRef to pin are both reported, and the task still imports',
      'operaton:formRefBinding="latest" operaton:formRefVersion="3"',
      undefined,
      [
        "The 'formRefBinding' setting on 'T' has no effect without an " +
          'operaton:formRef and was not imported.',
        "The 'formRefVersion' setting on 'T' has no effect without an " +
          'operaton:formRef and was not imported.',
      ],
    ],
  ] as const)('%s', async (_title, attrs, formRef, messages) => {
    const { node, warnings } = await importFormRef(attrs);
    expect(node.formRef).toEqual(formRef);
    expect(warnings.map((w) => w.message)).toEqual(messages);
  });

  it.each([
    [
      'a formKey beside a formRef',
      'operaton:formKey="embedded:app:forms/review.html" operaton:formRef="review-form" operaton:formRefBinding="latest"',
      'it names an operaton:formKey beside the operaton:formRef, and a task renders one form',
    ],
    [
      'a formRef with no binding to resolve it',
      'operaton:formRef="review-form"',
      'its operaton:formRef carries no operaton:formRefBinding, so the engine cannot resolve which deployed form to render',
    ],
    [
      'a formRef bound by a word this tool cannot represent',
      'operaton:formRef="review-form" operaton:formRefBinding="versionTag"',
      'formRefBinding="versionTag" is not a binding this tool can represent',
    ],
    [
      'a formRef pinned to a version it never names',
      'operaton:formRef="review-form" operaton:formRefBinding="version"',
      'formRefBinding="version" is set without a formRefVersion, so the engine cannot resolve which version to use',
    ],
  ])(
    '%s refuses, rather than importing a task Operaton would not deploy',
    async (_title, attrs, detail) => {
      const error = await expectRefusal(
        xmlToIr(oneNodeDoc('userTask', { attrs })),
        UnsupportedFormReferenceError,
        detail,
      );
      expect(error.message).toContain("The form reference on 'T'");
    },
  );
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

/** One `<operaton:formData>` block on the `Review` user task, wrapping the given fields. */
const formOn = (fields: string): string =>
  `        <operaton:formData>\n${fields}\n        </operaton:formData>`;

const importForm = (fields: string) => importUserTaskWith(formOn(fields));

/** The `validation` block of one field. */
const validation = (constraints: string): string =>
  `            <operaton:validation>\n${constraints}\n            </operaton:validation>`;

describe('xmlToIr: form field constraints, values, pattern and properties', () => {
  it('reads a date pattern, constraints in document order, properties and enum values, warning about none', async () => {
    const { node: task, warnings } = await importForm(
      `          <operaton:formField id="due" type="date" label="Due" datePattern="dd/MM/yyyy">
            <operaton:properties>
              <operaton:property id="hint" value="Pick a day" />
              <operaton:property id="group" value="dates" />
            </operaton:properties>
${validation(`              <operaton:constraint name="validator" config="com.example.DueCheck" />
              <operaton:constraint name="readonly" />
              <operaton:constraint name="required" />`)}
          </operaton:formField>
          <operaton:formField id="amount" type="long" defaultValue="5">
${validation(`              <operaton:constraint name="min" config="-15" />
              <operaton:constraint name="max" config="100" />`)}
          </operaton:formField>
          <operaton:formField id="note" type="string">
${validation(`              <operaton:constraint name="maxlength" config="40" />
              <operaton:constraint name="minlength" config="2" />`)}
          </operaton:formField>
          <operaton:formField id="plan" type="enum" defaultValue="pro">
            <operaton:value id="basic" name="Basic" />
            <operaton:value id="pro" />
          </operaton:formField>`,
    );
    const expected: FormField[] = [
      {
        id: 'due',
        type: 'date',
        label: 'Due',
        datePattern: 'dd/MM/yyyy',
        constraints: [
          { name: 'validator', config: 'com.example.DueCheck' },
          { name: 'readonly' },
          { name: 'required' },
        ],
        properties: [
          { key: 'hint', value: 'Pick a day' },
          { key: 'group', value: 'dates' },
        ],
      },
      {
        id: 'amount',
        type: 'number',
        defaultValue: '5',
        constraints: [
          { name: 'min', config: '-15' },
          { name: 'max', config: '100' },
        ],
      },
      {
        id: 'note',
        type: 'string',
        constraints: [
          { name: 'maxlength', config: '40' },
          { name: 'minlength', config: '2' },
        ],
      },
      {
        id: 'plan',
        type: 'enum',
        defaultValue: 'pro',
        values: [{ id: 'basic', label: 'Basic' }, { id: 'pro' }],
      },
    ];
    expect(task.formFields).toEqual(expected);
    expect(warnings).toEqual([]);
  });

  it.each([
    {
      case: 'a name Operaton registers no validator for',
      constraints:
        '              <operaton:constraint name="minimum" config="0" />',
      name: 'minimum',
      detail: /no validator is registered/,
    },
    {
      case: 'a constraint with no name',
      constraints: '              <operaton:constraint config="0" />',
      name: '(none)',
      detail: /no name/,
    },
    {
      case: "a 'validator' with no config",
      constraints: '              <operaton:constraint name="validator" />',
      name: 'validator',
      detail: /FormValidators\.createValidator/,
    },
    {
      case: "a 'min' with no config",
      constraints: '              <operaton:constraint name="min" />',
      name: 'min',
      detail: /every submission/,
    },
    {
      case: "'required' written twice",
      constraints: `              <operaton:constraint name="required" />
              <operaton:constraint name="required" />`,
      name: 'required',
      detail: /once per field/,
    },
  ])('refuses $case', async ({ constraints, name, detail }) => {
    const err = await expectRefusal<UnsupportedFormFieldConstraintError>(
      xmlToIr(
        userTaskWith(
          formOn(`          <operaton:formField id="amount" type="long">
${validation(constraints)}
          </operaton:formField>`),
        ),
      ),
      UnsupportedFormFieldConstraintError,
      detail,
    );
    expect([err.elementId, err.fieldId, err.constraintName]).toEqual([
      'Review',
      'amount',
      name,
    ]);
    expect(err.message).toMatch(
      /required, readonly, min, max, minlength, and maxlength/,
    );
    expect(err.message).toMatch(/'validator'/);
  });

  const reviewWarning = (message: RegExp) => warning('Review', message);

  it.each([
    {
      case: 'a datePattern on a string field is dropped',
      field: `          <operaton:formField id="note" type="string" datePattern="dd/MM/yyyy" />`,
      imported: { id: 'note', type: 'string' },
      warnings: [
        reviewWarning(
          /'datePattern'.*'note'.*FormTypes\.parseFormPropertyType/,
        ),
      ],
    },
    {
      case: 'operaton:value children on a string field are dropped, reported once',
      field: `          <operaton:formField id="note" type="string">
            <operaton:value id="a" name="A" />
            <operaton:value id="b" />
          </operaton:formField>`,
      imported: { id: 'note', type: 'string' },
      warnings: [
        reviewWarning(
          /2 operaton:value.*'note'.*FormTypes\.parseFormPropertyType/,
        ),
      ],
    },
    {
      case: "a config on 'required' is dropped and the constraint kept",
      field: `          <operaton:formField id="note" type="string">
${validation('              <operaton:constraint name="required" config="true" />')}
          </operaton:formField>`,
      imported: {
        id: 'note',
        type: 'string',
        constraints: [{ name: 'required' }],
      },
      warnings: [
        reviewWarning(/config 'true'.*'required'.*RequiredValidator\.validate/),
      ],
    },
    {
      case: "a 'min' on a string field is carried and the script draws an error",
      field: `          <operaton:formField id="note" type="string">
${validation('              <operaton:constraint name="min" config="0" />')}
          </operaton:formField>`,
      imported: {
        id: 'note',
        type: 'string',
        constraints: [{ name: 'min', config: '0' }],
      },
      warnings: [
        reviewWarning(
          /'min'.*imported as written.*number field.*MinValidator\.validate/,
        ),
      ],
    },
    {
      case: "a non-numeric 'min' is carried and the script draws an error",
      field: `          <operaton:formField id="amount" type="long">
${validation('              <operaton:constraint name="min" config="abc" />')}
          </operaton:formField>`,
      imported: {
        id: 'amount',
        type: 'number',
        constraints: [{ name: 'min', config: 'abc' }],
      },
      warnings: [
        reviewWarning(
          /'min'.*imported as written.*MinValidator\.validate.*'abc'/,
        ),
      ],
    },
    {
      case: "a decimal 'min' is carried and the script draws an error",
      field: `          <operaton:formField id="amount" type="long">
${validation('              <operaton:constraint name="min" config="1.5" />')}
          </operaton:formField>`,
      imported: {
        id: 'amount',
        type: 'number',
        constraints: [{ name: 'min', config: '1.5' }],
      },
      warnings: [
        reviewWarning(
          /'min'.*imported as written.*MinValidator\.validate.*'1\.5'/,
        ),
      ],
    },
    {
      case: "a decimal 'maxlength' is carried and the script draws an error",
      field: `          <operaton:formField id="note" type="string">
${validation('              <operaton:constraint name="maxlength" config="2.5" />')}
          </operaton:formField>`,
      imported: {
        id: 'note',
        type: 'string',
        constraints: [{ name: 'maxlength', config: '2.5' }],
      },
      warnings: [
        reviewWarning(
          /'maxlength'.*imported as written.*MaxLengthValidator\.validate.*'2\.5'/,
        ),
      ],
    },
    {
      case: 'an enum default naming no value is carried and the script draws an error',
      field: `          <operaton:formField id="plan" type="enum" defaultValue="zzz">
            <operaton:value id="a" />
            <operaton:value id="b" />
          </operaton:formField>`,
      imported: {
        id: 'plan',
        type: 'enum',
        defaultValue: 'zzz',
        values: [{ id: 'a' }, { id: 'b' }],
      },
      warnings: [
        reviewWarning(
          /'zzz'.*imported as written.*EnumFormType\.validateValue/,
        ),
      ],
    },
    {
      case: 'an enum default that is an expression is not checked against the values',
      field: `          <operaton:formField id="plan" type="enum" defaultValue="\${chosen}">
            <operaton:value id="a" />
          </operaton:formField>`,
      imported: {
        id: 'plan',
        type: 'enum',
        defaultValue: '${chosen}',
        values: [{ id: 'a' }],
      },
      warnings: [],
    },
    {
      case: 'a repeated enum value id keeps the first position and the last label',
      field: `          <operaton:formField id="plan" type="enum">
            <operaton:value id="a" name="A" />
            <operaton:value id="b" />
            <operaton:value id="a" name="Again" />
          </operaton:formField>`,
      imported: {
        id: 'plan',
        type: 'enum',
        values: [{ id: 'a', label: 'Again' }, { id: 'b' }],
      },
      warnings: [reviewWarning(/value 'a'.*'plan'.*LinkedHashMap/)],
    },
    {
      case: 'an enum value with no id is dropped',
      field: `          <operaton:formField id="plan" type="enum">
            <operaton:value id="a" />
            <operaton:value name="Nameless" />
          </operaton:formField>`,
      imported: { id: 'plan', type: 'enum', values: [{ id: 'a' }] },
      warnings: [reviewWarning(/operaton:value #2.*'plan'.*no id/)],
    },
    {
      case: 'a repeated property id keeps the first position and the last value',
      field: `          <operaton:formField id="note" type="string">
            <operaton:properties>
              <operaton:property id="hint" value="First" />
              <operaton:property id="group" value="dates" />
              <operaton:property id="hint" value="Again" />
            </operaton:properties>
          </operaton:formField>`,
      imported: {
        id: 'note',
        type: 'string',
        properties: [
          { key: 'hint', value: 'Again' },
          { key: 'group', value: 'dates' },
        ],
      },
      warnings: [
        reviewWarning(
          /property 'hint'.*'note'.*once, at its first position with its last value, as DefaultFormHandler.parseProperties keeps it \(LinkedHashMap.put\)/,
        ),
      ],
    },
    {
      case: 'a property missing its id or its value is dropped, naming which, and an empty value is kept as the engine map holds it',
      field: `          <operaton:formField id="note" type="string">
            <operaton:properties>
              <operaton:property value="orphan" />
              <operaton:property id="k" value="v" />
              <operaton:property id="empty" />
              <operaton:property id="blank" value="" />
            </operaton:properties>
          </operaton:formField>`,
      imported: {
        id: 'note',
        type: 'string',
        properties: [
          { key: 'k', value: 'v' },
          { key: 'blank', value: '' },
        ],
      },
      warnings: [
        reviewWarning(/operaton:property #1.*'note'.*no id/),
        reviewWarning(/operaton:property 'empty'.*'note'.*no value/),
      ],
    },
  ] satisfies {
    case: string;
    field: string;
    imported: FormField;
    warnings: unknown[];
  }[])('$case', async ({ field, imported, warnings: expected }) => {
    // The clean field first: a warning drawn against it, or against the
    // offending field twice, is as wrong as one never drawn.
    const { node: task, warnings } = await importForm(
      `          <operaton:formField id="clean" type="string" />\n${field}`,
    );
    expect(task.formFields).toEqual([
      { id: 'clean', type: 'string' },
      imported,
    ]);
    expect(warnings).toEqual(expected);
  });

  it("a property's name and a foreign attribute on a constraint are reported by the sweep", async () => {
    const { node: task, warnings } = await importUserTaskWith(
      `        <operaton:formData xmlns:foo="http://foo.example">
          <operaton:formField id="note" type="string">
            <operaton:properties>
              <operaton:property id="k" name="K" value="v" />
            </operaton:properties>
${validation('              <operaton:constraint name="required" foo:bar="1" />')}
          </operaton:formField>
        </operaton:formData>`,
    );
    expect(task.formFields).toEqual([
      {
        id: 'note',
        type: 'string',
        constraints: [{ name: 'required' }],
        properties: [{ key: 'k', value: 'v' }],
      },
    ]);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(
        /'name' on an operaton:property 'k' in an operaton:properties in an operaton:formField 'note'/,
      ),
      expect.stringMatching(
        /'foo:bar' on an operaton:constraint 'required' in an operaton:validation in an operaton:formField 'note'/,
      ),
    ]);
  });
});

/** Two coded error roots followed by a process body written verbatim. */
const codedErrorsDoc = (body: string): string =>
  operatonDefs`  <bpmn:error id="Err_Declined" errorCode="DECLINED" />
  <bpmn:error id="Err_Timeout" errorCode="TIMEOUT" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
${body}
    <bpmn:endEvent id="E" />
  </bpmn:process>`;

/** An external service task `Charge`, with the given attributes and extension children. */
const externalTask = (attrs: string, children: string): string =>
  `    <bpmn:serviceTask id="Charge" operaton:type="external" operaton:topic="charge-card" ${attrs}>
${extensionElements(children)}</bpmn:serviceTask>`;

const errorMapping = (attrs: string): string =>
  `        <operaton:errorEventDefinition ${attrs} />`;

const propertiesOf = (entries: string): string =>
  `        <operaton:properties>\n${entries}\n        </operaton:properties>`;

describe('xmlToIr: external task extras', () => {
  it('a service, send and business rule task each carry their priority, properties and error mappings on the external binding', async () => {
    const { ir, warnings } = await xmlToIr(
      codedErrorsDoc(
        `${externalTask(
          'operaton:taskPriority="42"',
          `${propertiesOf(`          <operaton:property name="gateway" value="stripe" />
          <operaton:property name="attempts" value="3" />`)}
${errorMapping(
  `id="Map_1" errorRef="Err_Declined" expression="\${externalTask.errorMessage == 'declined'}"`,
)}
${errorMapping('id="Map_2" errorRef="Err_Timeout" expression="${externalTask.retries == 0}"')}`,
        )}
    <bpmn:sendTask id="Notify" operaton:type="external" operaton:topic="notify" operaton:taskPriority="\${p}">
${extensionElements(propertiesOf('          <operaton:property name="channel" value="email" />'))}</bpmn:sendTask>
    <bpmn:businessRuleTask id="Decide" operaton:type="external" operaton:topic="decide">
${extensionElements(errorMapping('errorRef="Err_Timeout" expression="${false}"'))}</bpmn:businessRuleTask>`,
      ),
    );
    const bindingOf = (id: string): ServiceTaskBinding => {
      const node = byId(ir, id);
      expect(node.kind).toBe('serviceTask');
      return (node as { binding: ServiceTaskBinding }).binding;
    };
    expect(bindingOf('Charge')).toEqual({
      kind: 'external',
      topic: 'charge-card',
      taskPriority: '42',
      properties: [
        { key: 'gateway', value: 'stripe' },
        { key: 'attempts', value: '3' },
      ],
      errorMappings: [
        {
          errorCode: 'DECLINED',
          condition: "${externalTask.errorMessage == 'declined'}",
        },
        { errorCode: 'TIMEOUT', condition: '${externalTask.retries == 0}' },
      ],
    });
    expect(bindingOf('Notify')).toEqual({
      kind: 'external',
      topic: 'notify',
      taskPriority: '${p}',
      properties: [{ key: 'channel', value: 'email' }],
    });
    expect(bindingOf('Decide')).toEqual({
      kind: 'external',
      topic: 'decide',
      errorMappings: [{ errorCode: 'TIMEOUT', condition: '${false}' }],
    });
    expect(warnings).toEqual([]);
  });

  it.each([
    [
      'a mapping with no expression',
      errorMapping('errorRef="Err_Declined"'),
      /no expression/,
    ],
    [
      'a mapping whose errorRef names a root with no code',
      errorMapping('errorRef="Err_Blank" expression="${true}"'),
      /'Err_Blank'.*no code/,
    ],
    [
      'a mapping with no errorRef',
      errorMapping('expression="${true}"'),
      /names no error root/,
    ],
    [
      'a mapping with neither attribute',
      errorMapping(''),
      /names no error root/,
    ],
    [
      'a mapping whose errorRef names no root in the document',
      errorMapping('errorRef="Err_Missing" expression="${true}"'),
      /'Err_Missing'.*names no error root/,
    ],
  ])('%s is refused', async (_title, mapping, detail) => {
    const xml = operatonDefs`  <bpmn:error id="Err_Declined" errorCode="DECLINED" />
  <bpmn:error id="Err_Blank" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
${externalTask('', mapping)}
    <bpmn:endEvent id="E" />
  </bpmn:process>`;
    const err = await expectRefusal<UnsupportedErrorMappingError>(
      xmlToIr(xml),
      UnsupportedErrorMappingError,
      detail,
    );
    expect(err.elementId).toBe('Charge');
    expect(err.message).toContain('parseOperatonErrorEventDefinitions');
  });

  it.each([
    {
      case: 'the three extras on a class-bound service task are dropped, each naming the one reader',
      body: `    <bpmn:serviceTask id="Svc" operaton:class="com.example.Svc" operaton:taskPriority="42">
${extensionElements(`${propertiesOf('          <operaton:property name="k" value="v" />')}
${errorMapping('errorRef="Err_Declined" expression="${true}"')}`)}</bpmn:serviceTask>`,
      binding: classBinding('com.example.Svc'),
      warnings: [
        warning('Svc', /'taskPriority'.*parseExternalServiceTask/),
        warning('Svc', /operaton:properties.*parseExternalServiceTask/),
        warning(
          'Svc',
          /operaton:errorEventDefinition.*parseExternalServiceTask/,
        ),
      ],
    },
    {
      case: 'a mapping carrying a catch-side variable imports, and the variable is reported as a throw-side drop',
      body: externalTask(
        '',
        errorMapping(
          'errorRef="Err_Declined" expression="${true}" operaton:errorCodeVariable="c"',
        ),
      ),
      binding: {
        ...externalBinding('charge-card'),
        errorMappings: [{ errorCode: 'DECLINED', condition: '${true}' }],
      },
      warnings: [
        warning('Charge', /'errorCodeVariable'.*takes effect on a catch/),
      ],
    },
    {
      case: 'a mapping carrying documentation imports, and the documentation is reported as dropped',
      body: externalTask(
        '',
        `        <operaton:errorEventDefinition errorRef="Err_Declined" expression="\${true}">
          <bpmn:documentation>Declined by the issuer.</bpmn:documentation>
        </operaton:errorEventDefinition>`,
      ),
      binding: {
        ...externalBinding('charge-card'),
        errorMappings: [{ errorCode: 'DECLINED', condition: '${true}' }],
      },
      warnings: [
        warning(
          'Charge',
          /documentation on 'Charge'.*an error mapping has no documentation/,
          'documentation',
        ),
      ],
    },
    {
      case: 'a property with no name is skipped, naming which',
      body: externalTask(
        '',
        propertiesOf(`          <operaton:property name="k" value="v" />
          <operaton:property value="orphan" />`),
      ),
      binding: {
        ...externalBinding('charge-card'),
        properties: [{ key: 'k', value: 'v' }],
      },
      warnings: [warning('Charge', /operaton:property #2.*no name/)],
    },
    {
      case: 'a repeated property name keeps the first position and the last value, as the engine map does',
      body: externalTask(
        '',
        propertiesOf(`          <operaton:property name="k" value="first" />
          <operaton:property name="other" value="o" />
          <operaton:property name="k" value="last" />`),
      ),
      binding: {
        ...externalBinding('charge-card'),
        properties: [
          { key: 'k', value: 'last' },
          { key: 'other', value: 'o' },
        ],
      },
      warnings: [
        warning(
          'Charge',
          /property 'k'.*written twice.*once with its last value, as BpmnParseUtil.parseOperatonExtensionProperties keeps it \(HashMap.put\), at its first position/,
        ),
      ],
    },
    {
      case: "a property's id beside its name is reported by the sweep as unread",
      body: externalTask(
        '',
        propertiesOf(
          '          <operaton:property id="p1" name="k" value="v" />',
        ),
      ),
      binding: {
        ...externalBinding('charge-card'),
        properties: [{ key: 'k', value: 'v' }],
      },
      warnings: [warning('Charge', /'id' on an operaton:property 'k'/)],
    },
    {
      case: 'a decimal task priority is carried and the script draws an error',
      body: externalTask('operaton:taskPriority="1.5"', ''),
      binding: { ...externalBinding('charge-card'), taskPriority: '1.5' },
      warnings: [
        warning(
          'Charge',
          /taskPriority '1\.5' on 'Charge' was imported as written.*parsePriority/,
        ),
      ],
    },
    {
      case: 'a task priority opening with a digit before its expression is carried and the script draws an error',
      body: externalTask('operaton:taskPriority="1 ${x}"', ''),
      binding: { ...externalBinding('charge-card'), taskPriority: '1 ${x}' },
      warnings: [
        warning(
          'Charge',
          /taskPriority '1 \$\{x\}' on 'Charge' was imported as written.*parsePriority/,
        ),
      ],
    },
    {
      case: 'a task priority opening with #{ is carried and its rewrapping reported',
      body: externalTask('operaton:taskPriority="#{x}"', ''),
      binding: { ...externalBinding('charge-card'), taskPriority: '#{x}' },
      warnings: [
        warning(
          'Charge',
          /'taskPriority' setting on 'Charge' is written with "#\{\.\.\.\}".*written back inside "\$\{\.\.\.\}"/,
          'unmappedConstruct',
        ),
      ],
    },
    {
      case: 'a task priority on an external message throw is an unimported setting',
      roots: '  <bpmn:message id="Msg" name="ping" />\n',
      body: `    <bpmn:intermediateThrowEvent id="Ping">
      <bpmn:messageEventDefinition messageRef="Msg" operaton:type="external" operaton:topic="ping" operaton:taskPriority="7" />
    </bpmn:intermediateThrowEvent>`,
      binding: undefined,
      warnings: [
        warning(
          'Ping',
          /'operaton:taskPriority' setting on 'Ping' was not imported/,
        ),
      ],
    },
    {
      case: 'properties on a user task stay extra configuration',
      body: `    <bpmn:userTask id="Review">
${extensionElements(propertiesOf('          <operaton:property name="k" value="v" />'))}</bpmn:userTask>`,
      binding: undefined,
      warnings: [
        warning(
          'Review',
          /Extra configuration \(operaton:Properties\) on 'Review'/,
        ),
      ],
    },
  ])('$case', async ({ roots = '', body, binding, warnings: expected }) => {
    // The clean external task first, the offending element last: a warning
    // drawn against the clean one is as wrong as one never drawn.
    const xml = operatonDefs`  <bpmn:error id="Err_Declined" errorCode="DECLINED" />
${roots}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="Clean" operaton:type="external" operaton:topic="clean" operaton:taskPriority="1">
${extensionElements(`${propertiesOf('          <operaton:property name="a" value="b" />')}
${errorMapping('errorRef="Err_Declined" expression="${true}"')}`)}</bpmn:serviceTask>
${body}
    <bpmn:endEvent id="E" />
  </bpmn:process>`;
    const { ir, warnings } = await xmlToIr(xml);
    if (binding !== undefined) {
      const node = ir.flowElements.find(
        (fe) => fe.kind === 'serviceTask' && fe.id !== 'Clean',
      );
      expect(node?.kind === 'serviceTask' && node.binding).toEqual(binding);
    }
    expect(warnings).toEqual(expected);
  });
});

/**
 * Every shape of `operaton:inputOutput` block or listener that carries content
 * this surface cannot express. Each is semantic loss rather than decoration,
 * so each throws before any IR is produced, naming the shape and the element.
 *
 * Two of them are visible only because the moddle descriptor declares a
 * parameter's nested value as a repeating property: with a single-valued one,
 * a parameter carrying two nested values and a parameter carrying a stray
 * `operaton:entry` both parse to something plausible with no warning at all,
 * and no reader could tell.
 */
describe('xmlToIr: the extension-form refusal matrix', () => {
  /** The service task carries the io block and execution listeners, the user task the task listeners. */
  const HOSTS = { Svc: serviceTaskWith, Review: userTaskWith };

  const refuse = (
    on: keyof typeof HOSTS,
    children: string,
    detail: RegExp | string,
  ): Promise<UnsupportedExtensionFormError> =>
    expectRefusal<UnsupportedExtensionFormError>(
      xmlToIr(HOSTS[on](children)),
      UnsupportedExtensionFormError,
      detail,
    );

  const nested = (body: string): string =>
    ioBlock(`          <operaton:inputParameter name="x">
${body}
          </operaton:inputParameter>`);

  it.each([
    {
      case: 'a parameter carrying both body text and a nested value',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:inputParameter name="x">text<operaton:list /></operaton:inputParameter>`,
      ),
      detail:
        "operaton:inputParameter 'x' carries both body text and a nested " +
        '<operaton:List> value, and a value is one or the other',
    },
    {
      case: 'a parameter carrying two nested values',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:inputParameter name="x"><operaton:list /><operaton:map /></operaton:inputParameter>`,
      ),
      detail:
        "operaton:inputParameter 'x' carries 2 nested values (operaton:List, " +
        'operaton:Map), and a value is one',
    },
    {
      case: 'a map entry carrying both body text and a nested value',
      on: 'Svc',
      children: nested(`            <operaton:map>
              <operaton:entry key="k">text<operaton:list /></operaton:entry>
            </operaton:map>`),
      detail: /operaton:entry 'k'.*both body text and a nested/,
    },
    {
      case: 'a map entry carrying two nested values',
      on: 'Svc',
      children: nested(`            <operaton:map>
              <operaton:entry key="k"><operaton:list /><operaton:map /></operaton:entry>
            </operaton:map>`),
      detail: /operaton:entry 'k'.*2 nested values/,
    },
    {
      case: 'an input parameter with no name',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:inputParameter>text</operaton:inputParameter>`,
      ),
      detail:
        'an operaton:inputParameter has no name, so there is nothing to bind ' +
        'its value to',
    },
    {
      case: 'an output parameter with no name',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:outputParameter>text</operaton:outputParameter>`,
      ),
      detail:
        'an operaton:outputParameter has no name, so there is nothing to ' +
        'bind its value to',
    },
    {
      case: 'a map entry with no key',
      on: 'Svc',
      children: nested(`            <operaton:map>
              <operaton:entry>text</operaton:entry>
            </operaton:map>`),
      detail: /operaton:entry in .* has no key/,
    },
    {
      case: 'a script value naming an external resource',
      on: 'Svc',
      children: nested(
        '            <operaton:script scriptFormat="groovy" resource="classpath://calc.groovy" />',
      ),
      detail: /external resource.*calc\.groovy/,
    },
    {
      case: 'a script value with no scriptFormat',
      on: 'Svc',
      children: nested('            <operaton:script>1 + 1</operaton:script>'),
      detail:
        "the operaton:script in operaton:inputParameter 'x' has no " +
        'scriptFormat, so there is no language to evaluate its body in',
    },
    {
      case: 'an operaton:entry inside an operaton:list',
      on: 'Svc',
      children: nested(`            <operaton:list>
              <operaton:entry key="k">v</operaton:entry>
            </operaton:list>`),
      detail:
        "an operaton:list in operaton:inputParameter 'x' carries a " +
        '<operaton:Entry>; a list holds values, and an entry belongs in an ' +
        'operaton:map',
    },
    {
      case: 'an operaton:entry where a parameter value belongs',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:inputParameter name="x"><operaton:entry key="k">v</operaton:entry></operaton:inputParameter>`,
      ),
      detail:
        "operaton:inputParameter 'x' carries a <operaton:Entry> where a value " +
        'belongs; an entry belongs in an operaton:map',
    },
    {
      case: 'two input parameters sharing a name',
      on: 'Svc',
      children:
        ioBlock(`          <operaton:inputParameter name="x">1</operaton:inputParameter>
          <operaton:inputParameter name="x">2</operaton:inputParameter>`),
      detail: /two operaton:inputParameter children share name="x"/,
    },
    {
      case: 'an injected field naming no value slot',
      on: 'Svc',
      children: `        <operaton:field name="greeting" />`,
      detail: "the injected field 'greeting' on 'Svc' names no value",
    },
    {
      case: 'an injected field naming an attribute and a child of the same slot',
      on: 'Svc',
      children: `        <operaton:field name="greeting" stringValue="hello"><operaton:string>hi</operaton:string></operaton:field>`,
      detail:
        "the injected field 'greeting' on 'Svc' names a stringValue " +
        'attribute and an operaton:string child',
    },
    {
      case: 'a listener carrying no binding at all',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" />`,
      detail:
        'an operaton:executionListener carries no binding: one of class, ' +
        'expression, delegateExpression, or an operaton:script child is ' +
        'what it runs',
    },
    {
      case: 'a listener carrying two attribute bindings',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" class="C" expression="\${e}" />`,
      detail:
        'an operaton:executionListener carries 2 bindings (class, ' +
        'expression), and a listener names exactly one',
    },
    {
      case: 'a listener carrying an attribute binding and a script child',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" class="C">
          <operaton:script scriptFormat="groovy">1</operaton:script>
        </operaton:executionListener>`,
      detail:
        'an operaton:executionListener carries 2 bindings (class, an ' +
        'operaton:script child), and a listener names exactly one',
    },
    {
      case: 'a listener with no event',
      on: 'Svc',
      children: `        <operaton:executionListener class="com.example.L" />`,
      detail:
        'an operaton:executionListener has no event, so there is no point ' +
        'in the lifecycle for it to fire at',
    },
    {
      case: 'an execution listener whose event is neither start nor end',
      on: 'Svc',
      children: `        <operaton:executionListener event="take" class="com.example.L" />`,
      detail: /event="take".*start, end/,
    },
    {
      case: 'two execution listeners sharing an event',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" class="com.example.A" />
        <operaton:executionListener event="start" class="com.example.B" />`,
      detail: /two operaton:executionListener children share event="start"/,
    },
    {
      case: 'a task listener whose event is not one of the six task events',
      on: 'Review',
      children: `        <operaton:taskListener event="start" class="com.example.L" />`,
      detail:
        /event="start".*create, assign, complete, update, delete, timeout/,
    },
    {
      case: 'a timeout task listener with no timer',
      on: 'Review',
      children: `        <operaton:taskListener event="timeout" class="com.example.L" />`,
      detail:
        'an operaton:taskListener with event="timeout" carries no ' +
        'bpmn:timerEventDefinition, so nothing would ever fire it',
    },
    {
      case: 'a task listener carrying a timer on any other event',
      on: 'Review',
      children: `        <operaton:taskListener event="create" class="com.example.L">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
      detail: /event="create".*only a timeout listener/,
    },
    {
      case: 'two task listeners sharing an event',
      on: 'Review',
      children: `        <operaton:taskListener event="create" class="com.example.A" />
        <operaton:taskListener event="create" class="com.example.B" />`,
      detail: /share event="create"/,
    },
  ] as const)(
    '$case is refused, naming the shape and the element',
    async (row) => {
      const err = await refuse(row.on, row.children, row.detail);
      expect(err.elementId).toBe(row.on);
    },
  );

  it('the same name in each direction is an ordinary mapping, not a repeat', async () => {
    const { node: task } = await importServiceTask(
      ioBlock(`          <operaton:inputParameter name="x">1</operaton:inputParameter>
          <operaton:outputParameter name="x">2</operaton:outputParameter>`),
    );
    expect(task.inputParameters).toEqual([ioParam('x', textValue('1'))]);
    expect(task.outputParameters).toEqual([ioParam('x', textValue('2'))]);
  });
});

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

  it('a receive task with a messageRef imports the message name, and the root it uses is not reported as unreferenced', async () => {
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

  const MANUAL_TASK_WARNING = {
    elementId: 'M1',
    category: 'unmappedConstruct',
    message:
      "The bpmn:manualTask 'M1' imports as a plain step: token flow, " +
      'waiting, listeners, async and job configuration are all unchanged, ' +
      "but history and Cockpit will report its activity type as 'task' " +
      "rather than 'manualTask'.",
  };

  it('a manual task imports as a plain step, warning that history will report it as a task', async () => {
    const { node, warnings } = await importOnly(
      oneNodeDoc('manualTask', { id: 'M1', attrs: 'name="Sign off"' }),
      'task',
    );
    expect(node).toEqual({ kind: 'task', id: 'M1', name: 'Sign off' });
    expect(warnings).toEqual([MANUAL_TASK_WARNING]);
  });

  it('an engine setting on a manual task is read rather than reported as a drop', async () => {
    const { node, warnings } = await importOnly(
      oneNodeDoc('manualTask', {
        id: 'M1',
        attrs: 'operaton:asyncBefore="true"',
        children: extensionElements(
          '        <operaton:inputOutput>\n' +
            '          <operaton:inputParameter name="note">ok</operaton:inputParameter>\n' +
            '        </operaton:inputOutput>',
        ),
      }),
      'task',
    );
    expect(node.asyncBefore).toBe(true);
    expect(node.inputParameters).toEqual([ioParam('note', textValue('ok'))]);
    expect(warnings).toEqual([MANUAL_TASK_WARNING]);
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

describe('xmlToIr: a block that can be given up', () => {
  /** The closing sentence {@link UnsupportedEventFeatureError} appends by default. */
  const EVENT_SURFACE_NOTE =
    'Event handlers catch one error, escalation, message, signal, timer, ' +
    'condition, or compensation trigger on their single start event; ' +
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

describe('xmlToIr: an either-branch split', () => {
  /** `S -> Fork -> {A, B} -> Join -> Sub -> E`, `Sub` holding a split of its own. */
  const splitXml = bpmnDefs`  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:inclusiveGateway id="Fork" name="Which reviews?" default="F_Fork_B" />
    <bpmn:userTask id="Audit" />
    <bpmn:userTask id="Triage" />
    <bpmn:inclusiveGateway id="Join" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubS" />
      <bpmn:inclusiveGateway id="SubFork" />
      <bpmn:endEvent id="SubE" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubS" targetRef="SubFork" />
      <bpmn:sequenceFlow id="SF2" sourceRef="SubFork" targetRef="SubE" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F_S" sourceRef="S" targetRef="Fork" />
    <bpmn:sequenceFlow id="F_Fork_A" sourceRef="Fork" targetRef="Audit">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\${amount &gt; 10000}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F_Fork_B" sourceRef="Fork" targetRef="Triage" />
    <bpmn:sequenceFlow id="F_A_Join" sourceRef="Audit" targetRef="Join" />
    <bpmn:sequenceFlow id="F_B_Join" sourceRef="Triage" targetRef="Join" />
    <bpmn:sequenceFlow id="F_Join_Sub" sourceRef="Join" targetRef="Sub" />
    <bpmn:sequenceFlow id="F_Sub_E" sourceRef="Sub" targetRef="E" />
  </bpmn:process>`;

  it('imports with its label and its default, keeps no defaultFlowId key when none is written, and reaches a nested block', async () => {
    const { ir, warnings } = await xmlToIr(splitXml);

    expect(byId(ir, 'Fork')).toEqual({
      kind: 'inclusiveGateway',
      id: 'Fork',
      name: 'Which reviews?',
      defaultFlowId: 'F_Fork_B',
    });

    const join = byId(ir, 'Join');
    expect(join).toEqual({ kind: 'inclusiveGateway', id: 'Join' });
    expect(join).not.toHaveProperty('defaultFlowId');
    expect(join).not.toHaveProperty('name');

    expect(only(subProcess(ir, 'Sub'), 'inclusiveGateway').id).toBe('SubFork');
    expect(warnings).toEqual([]);
  });
});

describe('xmlToIr: a fallback route named on a step', () => {
  const condition = (body: string): string =>
    `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${body}</bpmn:conditionExpression>`;

  /** `S -> Triage -> {E1, E2}`, both routes out of the step weighed. */
  const stepDoc = (element: string): string =>
    bpmnDefs`  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
${element}
    <bpmn:endEvent id="E1" />
    <bpmn:endEvent id="E2" />
    <bpmn:sequenceFlow id="F0" sourceRef="S" targetRef="Triage" />
    <bpmn:sequenceFlow id="F1" sourceRef="Triage" targetRef="E1">
      ${condition('${paid}')}
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F2" sourceRef="Triage" targetRef="E2">
      ${condition('${urgent}')}
    </bpmn:sequenceFlow>
  </bpmn:process>`;

  it('reports the fallback named on a step, which no reader carries, and names the route', async () => {
    const { node, warnings } = await importOnly(
      stepDoc('    <bpmn:userTask id="Triage" default="F2" />'),
      'userTask',
    );

    expect(node).toEqual({ kind: 'userTask', id: 'Triage' });
    const warning = expectOneWarning(warnings, {
      elementId: 'Triage',
      category: 'unmappedConstruct',
      message: /The 'default' attribute on 'Triage' was not imported/,
    });
    expect(warning.message).toContain("route ('F2')");
    expect(warning.message).toContain(
      'when no other route out of the step is taken',
    );
  });

  it('reports it on a block and on a step nested in one, one warning each', async () => {
    const { warnings } = await xmlToIr(
      stepDoc(
        `    <bpmn:subProcess id="Triage" default="F2">
      <bpmn:startEvent id="SubS" />
      <bpmn:userTask id="Inner" default="SF2" />
      <bpmn:endEvent id="SubE1" />
      <bpmn:endEvent id="SubE2" />
      <bpmn:sequenceFlow id="SF0" sourceRef="SubS" targetRef="Inner" />
      <bpmn:sequenceFlow id="SF1" sourceRef="Inner" targetRef="SubE1">
        ${condition('${a}')}
      </bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="SF2" sourceRef="Inner" targetRef="SubE2">
        ${condition('${b}')}
      </bpmn:sequenceFlow>
    </bpmn:subProcess>`,
      ),
    );

    expect(warnings.map((w) => [w.elementId, w.category])).toEqual([
      ['Inner', 'unmappedConstruct'],
      ['Triage', 'unmappedConstruct'],
    ]);
  });

  it('reports it on a call activity, the kind that carries it furthest from a task', async () => {
    const { warnings } = await xmlToIr(
      stepDoc(
        '    <bpmn:callActivity id="Triage" calledElement="other" default="F2" />',
      ),
    );

    expectOneWarning(warnings, {
      elementId: 'Triage',
      category: 'unmappedConstruct',
      message: /The 'default' attribute on 'Triage' was not imported/,
    });
  });

  it('says nothing about the two split kinds that do carry it', async () => {
    for (const tag of ['exclusiveGateway', 'inclusiveGateway'] as const) {
      const { ir, warnings } = await xmlToIr(
        stepDoc(`    <bpmn:${tag} id="Triage" default="F2" />`),
      );

      expect(byId(ir, 'Triage')).toMatchObject({ defaultFlowId: 'F2' });
      expect(warnings).toEqual([]);
    }
  });
});

describe('xmlToIr: a wait with several branches', () => {
  interface WaitOptions {
    /** Extra attributes on the wait itself. */
    attrs?: string;
    /** Children of the wait, which make its tag an open one. */
    children?: string;
    /** The elements the branches begin with, each with the id a flow names. */
    branches?: readonly { id: string; element: string }[];
    /** Root declarations before the process. */
    roots?: string;
    /** Content written in the process beside the branches. */
    beside?: string;
    /** Flows written on top of the ones every branch gets. */
    extraFlows?: string;
    /** The `<bpmn:definitions>` wrapper. Defaults to {@link bpmnDefs}. */
    defs?: XmlTag;
  }

  const messageBranch = {
    id: 'OnPaid',
    element: `<bpmn:intermediateCatchEvent id="OnPaid">
      <bpmn:messageEventDefinition id="OnPaidDef" messageRef="Message_Pay" />
    </bpmn:intermediateCatchEvent>`,
  };

  const timerBranch = {
    id: 'OnLate',
    element: `<bpmn:intermediateCatchEvent id="OnLate">
      <bpmn:timerEventDefinition id="OnLateDef">
        <bpmn:timeDuration>P3D</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>`,
  };

  const MESSAGE_ROOT =
    '  <bpmn:message id="Message_Pay" name="PaymentReceived" />\n';

  /** `S -> Wait`, every branch merging into `Merge -> E`. */
  const waitDoc = ({
    attrs = '',
    children = '',
    branches = [messageBranch, timerBranch],
    roots = MESSAGE_ROOT,
    beside = '',
    extraFlows = '',
    defs = bpmnDefs,
  }: WaitOptions = {}): string =>
    defs`${roots}  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:eventBasedGateway id="Wait" ${attrs}${
      children === ''
        ? ' />'
        : `>\n      ${children}\n    </bpmn:eventBasedGateway>`
    }
${branches.map((b) => `    ${b.element}\n`).join('')}${beside}    <bpmn:exclusiveGateway id="Merge" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F_S" sourceRef="S" targetRef="Wait" />
${branches
  .map(
    (b) =>
      `    <bpmn:sequenceFlow id="F_${b.id}" sourceRef="Wait" targetRef="${b.id}" />\n` +
      `    <bpmn:sequenceFlow id="F_${b.id}_M" sourceRef="${b.id}" targetRef="Merge" />\n`,
  )
  .join(
    '',
  )}${extraFlows}    <bpmn:sequenceFlow id="F_Merge" sourceRef="Merge" targetRef="E" />
  </bpmn:process>`;

  it('imports the wait, every branch trigger it admits, and every flow, with no warnings', async () => {
    const signalBranch = {
      id: 'OnStock',
      element: `<bpmn:intermediateCatchEvent id="OnStock">
      <bpmn:signalEventDefinition id="OnStockDef" signalRef="Signal_Stock" />
    </bpmn:intermediateCatchEvent>`,
    };
    const conditionBranch = {
      id: 'OnCancelled',
      element: `<bpmn:intermediateCatchEvent id="OnCancelled">
      <bpmn:conditionalEventDefinition id="OnCancelledDef">
        <bpmn:condition>\${cancelled}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:intermediateCatchEvent>`,
    };

    const { ir, warnings } = await xmlToIr(
      waitDoc({
        attrs: 'gatewayDirection="Diverging"',
        branches: [messageBranch, timerBranch, signalBranch, conditionBranch],
        roots:
          MESSAGE_ROOT +
          '  <bpmn:signal id="Signal_Stock" name="StockArrived" />\n',
      }),
    );

    expect(only(ir, 'eventBasedGateway')).toEqual({
      kind: 'eventBasedGateway',
      id: 'Wait',
    });
    expect(
      ir.flowElements
        .filter((fe) => fe.kind === 'intermediateCatchEvent')
        .map((fe) => [fe.id, fe.eventDefinition.kind]),
    ).toEqual([
      ['OnPaid', 'message'],
      ['OnLate', 'timer'],
      ['OnStock', 'signal'],
      ['OnCancelled', 'conditional'],
    ]);
    expect(ir.sequenceFlows).toHaveLength(10);
    expect(warnings).toEqual([]);
  });

  it('reports instantiate and eventGatewayType once each, and says nothing about gatewayDirection', async () => {
    const { warnings: instantiate } = await xmlToIr(
      waitDoc({ attrs: 'instantiate="true"' }),
    );
    expectOneWarning(instantiate, {
      elementId: 'Wait',
      category: 'unmappedConstruct',
      message: /The 'instantiate' attribute on 'Wait' was not imported/,
    });
    expect(instantiate[0]!.message).toContain(
      'Operaton does not read it on a wait with several branches',
    );

    const { warnings: gatewayType } = await xmlToIr(
      waitDoc({ attrs: 'eventGatewayType="Parallel"' }),
    );
    expectOneWarning(gatewayType, {
      elementId: 'Wait',
      category: 'unmappedConstruct',
      message: /The 'eventGatewayType' attribute on 'Wait' was not imported/,
    });

    const { warnings: quiet } = await xmlToIr(
      waitDoc({
        attrs:
          'gatewayDirection="Diverging" instantiate="false" eventGatewayType="Exclusive"',
      }),
    );
    expect(quiet).toEqual([]);
  });

  it('speaks for the ignored attribute alone, beside a setting on the same wait that Operaton does read', async () => {
    // `parseEventBasedGateway` reads `operaton:asyncBefore` off the element it
    // is parsing, so a report claiming nothing on a wait is read would be
    // refuted by the report printed next to it.
    const { warnings } = await xmlToIr(
      waitDoc({
        attrs: 'instantiate="true" operaton:asyncBefore="true"',
        defs: operatonDefs,
      }),
    );

    const ignored = warnings.find((w) => w.message.includes("'instantiate'"));
    expect(
      warnings.some((w) => w.message.includes("'operaton:asyncBefore'")),
    ).toBe(true);
    expect(ignored?.message).toContain(
      'Operaton does not read it on a wait with several branches',
    );
    expect(ignored?.message).not.toContain('no attribute');
  });

  it('reads the name off a wait, and lets the generic sweeps report what it drops on either new gateway kind', async () => {
    // Neither gateway kind owns an engine-settings row, so what an author
    // writes on one has to reach them through the generic sweeps instead.
    const SWEPT_ATTRS =
      'operaton:asyncBefore="true" operaton:jobPriority="7" sortOrder="3"';
    const SWEPT_DOC = '<bpmn:documentation>Pick one.</bpmn:documentation>';

    const { ir, warnings } = await xmlToIr(
      waitDoc({
        attrs: `name="Whichever comes first" ${SWEPT_ATTRS}`,
        children: SWEPT_DOC,
        defs: operatonDefs,
      }),
    );

    expect(only(ir, 'eventBasedGateway')).toEqual({
      kind: 'eventBasedGateway',
      id: 'Wait',
      name: 'Whichever comes first',
      documentation: 'Pick one.',
    });
    const reported = (warning: ImportWarning) => [
      warning.category,
      warning.elementId,
      warning.message,
    ];
    const sweepsOn = (id: string) => [
      [
        'extensionAttribute',
        id,
        expect.stringContaining("'operaton:asyncBefore' setting"),
      ],
      [
        'extensionAttribute',
        id,
        expect.stringContaining("'operaton:jobPriority' setting"),
      ],
      [
        'unmappedConstruct',
        id,
        expect.stringContaining("'sortOrder' attribute"),
      ],
    ];

    expect(warnings.map(reported)).toEqual(sweepsOn('Wait'));
    expect(warnings[0]!.message).toContain(
      'a gateway carries no engine setting at all',
    );

    const fork = await xmlToIr(
      oneNodeDoc('inclusiveGateway', {
        id: 'Fork',
        attrs: SWEPT_ATTRS,
        children: SWEPT_DOC,
      }),
    );
    expect(fork.warnings.map(reported)).toEqual(sweepsOn('Fork'));
  });

  it('refuses a branch that does not begin with something to wait for, and one reached by more than one path', async () => {
    const notAWait = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(
        waitDoc({
          branches: [
            messageBranch,
            { id: 'Ship', element: '<bpmn:userTask id="Ship" />' },
          ],
        }),
      ),
      UnsupportedEventFeatureError,
    );
    expect(notAWait.elementId).toBe('Ship');
    expect(notAWait.detail).toContain(
      "a branch of the wait 'Wait' leads to 'Ship', a user task",
    );
    expect(notAWait.message).toContain(
      'every branch of a wait with several branches has to begin with ' +
        'something to wait for',
    );

    const reachedTwice = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(
        waitDoc({
          beside: '    <bpmn:userTask id="Chase" />\n',
          extraFlows:
            '    <bpmn:sequenceFlow id="F_Chase" sourceRef="Chase" targetRef="OnPaid" />\n',
        }),
      ),
      UnsupportedEventFeatureError,
    );
    expect(reachedTwice.elementId).toBe('OnPaid');
    expect(reachedTwice.detail).toContain(
      "'OnPaid' is reached by more than one path; a step inside a wait " +
        'with several branches can only be reached through the wait that ' +
        'opens it',
    );
  });

  it('refuses a link catch on a branch by the flow rule: the branch is a flow into the catch', async () => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(
        waitDoc({
          branches: [
            messageBranch,
            {
              id: 'OnLink',
              element: `<bpmn:intermediateCatchEvent id="OnLink" name="X">
      <bpmn:linkEventDefinition id="OnLinkDef" name="X" />
    </bpmn:intermediateCatchEvent>`,
            },
          ],
        }),
      ),
      UnsupportedEventFeatureError,
      "the flow 'F_OnLink' enters the link catch 'OnLink'; a link catch is " +
        'entered by the throw of the same name rather than along a flow',
    );
    expect(e.elementId).toBe('OnLink');
  });
});
