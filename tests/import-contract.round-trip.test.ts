// One document exercises every construct the import contract converts or
// refuses at once, so an interaction between them (a spurious warning, a
// refusal that stops naming its own construct) shows up here even when each
// construct's own isolated test stays green.

import { describe, it, expect, beforeAll } from 'vitest';

import {
  astToIr,
  xmlToIr,
  UnsupportedConditionExpressionError,
  UnsupportedElementError,
  UnsupportedEventFeatureError,
  UnsupportedExtensionFormError,
  UnsupportedServiceTaskFormError,
} from '@bpmn-script/transform';
import type { BpmnProcess, ImportWarning } from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';
import { parse, parseToAst, printDsl, validate } from './helpers/pipeline.js';

const NAMESPACES =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:operaton="http://operaton.org/schema/1.0/bpmn"';

/** One `<bpmn:definitions>` document: `roots` sit before the process, `body` inside it. */
function bpmnDoc(body: string, roots = ''): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<bpmn:definitions ${NAMESPACES} targetNamespace="http://test">\n` +
    roots +
    `  <bpmn:process id="p" isExecutable="true">\n${body}\n  </bpmn:process>\n` +
    '</bpmn:definitions>'
  );
}

// `GlobalScriptTask.script` is declared `isAttr: true` in the moddle schema,
// but the BPMN XSD makes `<bpmn:script>` an element, so this root exercises
// the case where a root's own unparsable child must not be reported a second
// time against the process.
const GLOBAL_SCRIPT_TASK_ROOT =
  '  <bpmn:globalScriptTask id="G3">\n' +
  '    <bpmn:script>x</bpmn:script>\n' +
  '  </bpmn:globalScriptTask>\n';

// A manual task, a de-looped step, all three data-plumbing kinds, and a
// scripted-looking condition (a lone operaton:resource, no language) that
// warns rather than refuses, all in one process alongside the compensation-free
// happy path so the interaction, not just each construct alone, is exercised.
const FIXTURE = bpmnDoc(
  '    <bpmn:startEvent id="S" />\n' +
    '    <bpmn:exclusiveGateway id="Decide" default="Flow_Decide_Review" />\n' +
    '    <bpmn:manualTask id="SignOff" />\n' +
    '    <bpmn:userTask id="Review" operaton:assignee="demo">\n' +
    '      <bpmn:standardLoopCharacteristics />\n' +
    '    </bpmn:userTask>\n' +
    '    <bpmn:endEvent id="E" />\n' +
    '    <bpmn:dataObject id="OrderDetails" />\n' +
    '    <bpmn:dataObjectReference id="OrderRef" />\n' +
    '    <bpmn:dataStoreReference id="ArchiveStore" />\n' +
    '    <bpmn:sequenceFlow id="Flow_S_Decide" sourceRef="S" targetRef="Decide" />\n' +
    '    <bpmn:sequenceFlow id="Flow_Decide_SignOff" sourceRef="Decide" targetRef="SignOff">\n' +
    // A literal comparison, not a process-variable read: the fixture is about
    // the dropped operaton:resource, not about declaring a variable, and a
    // free variable here would draw an unrelated "not declared" diagnostic.
    '      <bpmn:conditionExpression operaton:resource="deployment://check.groovy">${1 &lt; 2}</bpmn:conditionExpression>\n' +
    '    </bpmn:sequenceFlow>\n' +
    '    <bpmn:sequenceFlow id="Flow_Decide_Review" sourceRef="Decide" targetRef="Review" />\n' +
    '    <bpmn:sequenceFlow id="Flow_SignOff_E" sourceRef="SignOff" targetRef="E" />\n' +
    '    <bpmn:sequenceFlow id="Flow_Review_E" sourceRef="Review" targetRef="E" />',
  GLOBAL_SCRIPT_TASK_ROOT,
);

const IMPORTED_FLOW_NOTE =
  '(this tool imports the executable flow and the engine settings on its ' +
  'steps, and nothing declared or drawn beside it).';

const dataDropped = (tag: string, id: string) =>
  `A bpmn:${tag} '${id}' was not imported: Operaton keeps process ` +
  'variables in its own store and never dispatches on it, so the ' +
  'imported process runs identically.';

const EXPECTED_WARNINGS: ImportWarning[] = [
  {
    elementId: 'SignOff',
    category: 'unmappedConstruct',
    message:
      "The bpmn:manualTask 'SignOff' imports as a plain step: token flow, " +
      'waiting, listeners, async and job configuration are all unchanged, ' +
      "but history and Cockpit will report its activity type as 'task' " +
      "rather than 'manualTask'.",
  },
  {
    elementId: 'Review',
    category: 'unmappedConstruct',
    message:
      "The bpmn:standardLoopCharacteristics on 'Review' was not imported: " +
      'Operaton does not run one at all, it deploys the step and runs it ' +
      'once, so the imported step runs once too.',
  },
  {
    elementId: 'OrderDetails',
    category: 'unmappedConstruct',
    message: dataDropped('dataObject', 'OrderDetails'),
  },
  {
    elementId: 'OrderRef',
    category: 'unmappedConstruct',
    message: dataDropped('dataObjectReference', 'OrderRef'),
  },
  {
    elementId: 'ArchiveStore',
    category: 'unmappedConstruct',
    message: dataDropped('dataStoreReference', 'ArchiveStore'),
  },
  {
    elementId: 'Flow_Decide_SignOff',
    category: 'extensionAttribute',
    message:
      "The 'operaton:resource' setting on 'Flow_Decide_SignOff' only " +
      'takes effect alongside a language attribute; on its own the ' +
      'condition runs as the expression written in the body, and the ' +
      'attribute was not imported.',
  },
  {
    elementId: 'G3',
    category: 'unmappedConstruct',
    message: `A bpmn:globalScriptTask 'G3' root element was not imported ${IMPORTED_FLOW_NOTE}`,
  },
];

describe('a document holding every construct this phase converted', () => {
  const state = {} as {
    ir: BpmnProcess;
    warnings: ImportWarning[];
    dsl: string;
  };

  beforeAll(async () => {
    const { ir, warnings } = await xmlToIr(FIXTURE);
    state.ir = ir;
    state.warnings = warnings;
    state.dsl = printDsl(ir);
  });

  it('imports with exactly the warnings the contract names', () => {
    expect(state.warnings).toEqual(EXPECTED_WARNINGS);
  });

  it('the script printed from that import re-parses with no parser errors and validates clean', async () => {
    const document = await parse(state.dsl);
    expect(document.parseResult.parserErrors).toEqual([]);

    const { diagnostics } = await validate(state.dsl);
    expect(diagnostics).toEqual([]);
  });

  it('the re-desugared IR is normalized-equal to the import', async () => {
    const reDesugared = astToIr(await parseToAst(state.dsl));
    expect(normalizeIr(reDesugared)).toEqual(normalizeIr(state.ir));
  });
});

/**
 * Runs `xmlToIr(xml)` and asserts it refuses as `errorClass`, returning the
 * error. Typed to the `Error` base, not the refusal subclass: the table below
 * mixes every refusal class in one column, and narrowing per row is left to
 * the one caller (the paired-triple test) that reads a subclass-only field.
 */
async function refusalError(
  xml: string,
  errorClass: abstract new (...args: never[]) => Error,
): Promise<Error> {
  try {
    await xmlToIr(xml);
  } catch (e) {
    expect(e).toBeInstanceOf(errorClass);
    return e as Error;
  }
  throw new Error('expected xmlToIr to refuse the document');
}

const CONNECTOR_CONSTRUCT =
  'an <operaton:connector> element, which the Connect plugin runs in ' +
  'place of whatever operaton:class, expression, delegateExpression, or ' +
  'type names beside it, and which an engine without the plugin runs ' +
  'instead of, so the same file has two possible executions';

const CONNECTOR_CHILD =
  '<operaton:connector><operaton:connectorId>http-connector' +
  '</operaton:connectorId></operaton:connector>';

const IS_FOR_COMPENSATION_DETAIL =
  'isForCompensation="true" marks this activity as excluded from normal ' +
  'flow: the boundary-event compensation-handler pattern, which this ' +
  'tool cannot import; wrap the steps in their own subprocess and ' +
  'target it with "on compensation" instead';

const COMPENSATION_BOUNDARY_DETAIL =
  'a compensation boundary event is not imported: BPMN attaches ' +
  'compensation through isForCompensation and a bpmn:association on ' +
  'the activity being compensated, not a boundary event; wrap the ' +
  'steps in their own subprocess and target it with "on compensation" instead';

const PAIRED_TRIPLE_XML = bpmnDoc(
  '    <bpmn:startEvent id="S" />\n' +
    '    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />\n' +
    '    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">\n' +
    '      <bpmn:compensateEventDefinition id="d" />\n' +
    '    </bpmn:boundaryEvent>\n' +
    '    <bpmn:userTask id="CancelReservation" isForCompensation="true" />\n' +
    '    <bpmn:endEvent id="E" />\n' +
    '    <bpmn:sequenceFlow id="Flow_S_ReserveRoom" sourceRef="S" targetRef="ReserveRoom" />\n' +
    '    <bpmn:sequenceFlow id="Flow_ReserveRoom_E" sourceRef="ReserveRoom" targetRef="E" />\n' +
    '    <bpmn:association id="Assoc1" sourceRef="CompensationBoundary" targetRef="CancelReservation" />',
);

const REWRITE_PREVIEW = [
  'subprocess Compensated_ReserveRoom {',
  '  service ReserveRoom(class: "com.example.Reserve")',
  '  on compensation {',
  '    user CancelReservation',
  '  }',
  '}',
].join('\n');

describe('every construct this phase refuses names itself in its own message', () => {
  it.each([
    [
      'a scripted condition expression names the language it would run in',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:userTask id="T" />\n' +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_T" sourceRef="S" targetRef="T">\n' +
          '      <bpmn:conditionExpression language="groovy">${amount &gt; 1000}</bpmn:conditionExpression>\n' +
          '    </bpmn:sequenceFlow>\n' +
          '    <bpmn:sequenceFlow id="Flow_T_E" sourceRef="T" targetRef="E" />',
      ),
      UnsupportedConditionExpressionError,
      ['language="groovy"'],
    ],
    [
      'a script task with a deployment resource names the resource',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:scriptTask id="Compute" scriptFormat="javascript" ' +
          'operaton:resource="deployment://check.groovy"><bpmn:script>1 + 1</bpmn:script></bpmn:scriptTask>\n' +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_Compute" sourceRef="S" targetRef="Compute" />\n' +
          '    <bpmn:sequenceFlow id="Flow_Compute_E" sourceRef="Compute" targetRef="E" />',
      ),
      UnsupportedExtensionFormError,
      ['names an external resource ("deployment://check.groovy")', "'Compute'"],
    ],
    [
      'a connector as the only implementation names the connector',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          `    <bpmn:serviceTask id="Notify"><bpmn:extensionElements>${CONNECTOR_CHILD}</bpmn:extensionElements></bpmn:serviceTask>\n` +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_Notify" sourceRef="S" targetRef="Notify" />\n' +
          '    <bpmn:sequenceFlow id="Flow_Notify_E" sourceRef="Notify" targetRef="E" />',
      ),
      UnsupportedServiceTaskFormError,
      [CONNECTOR_CONSTRUCT],
    ],
    [
      'a connector beside a class names the connector, not the class',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:serviceTask id="NotifyBeta" operaton:class="com.example.Svc">' +
          `<bpmn:extensionElements>${CONNECTOR_CHILD}</bpmn:extensionElements></bpmn:serviceTask>\n` +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_NotifyBeta" sourceRef="S" targetRef="NotifyBeta" />\n' +
          '    <bpmn:sequenceFlow id="Flow_NotifyBeta_E" sourceRef="NotifyBeta" targetRef="E" />',
      ),
      UnsupportedServiceTaskFormError,
      [CONNECTOR_CONSTRUCT],
    ],
    [
      'an unpaired isForCompensation activity falls back to the general wording',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:serviceTask id="CancelReservation" operaton:class="com.example.Cancel" isForCompensation="true" />\n' +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_CancelReservation" sourceRef="S" targetRef="CancelReservation" />\n' +
          '    <bpmn:sequenceFlow id="Flow_CancelReservation_E" sourceRef="CancelReservation" targetRef="E" />',
      ),
      UnsupportedEventFeatureError,
      [IS_FOR_COMPENSATION_DETAIL],
    ],
    [
      'an unpaired compensation boundary event falls back to the general wording',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />\n' +
          '    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">\n' +
          '      <bpmn:compensateEventDefinition id="d" />\n' +
          '    </bpmn:boundaryEvent>\n' +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_ReserveRoom" sourceRef="S" targetRef="ReserveRoom" />\n' +
          '    <bpmn:sequenceFlow id="Flow_ReserveRoom_E" sourceRef="ReserveRoom" targetRef="E" />',
      ),
      UnsupportedEventFeatureError,
      [COMPENSATION_BOUNDARY_DETAIL],
    ],
    [
      'a paired compensation triple names the compensated activity, the boundary, and the handler',
      PAIRED_TRIPLE_XML,
      UnsupportedEventFeatureError,
      ['ReserveRoom', 'CompensationBoundary', 'CancelReservation'],
    ],
    [
      'a compensation association pointing at a non-handler falls back to the general wording',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />\n' +
          '    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">\n' +
          '      <bpmn:compensateEventDefinition id="d" />\n' +
          '    </bpmn:boundaryEvent>\n' +
          '    <bpmn:task id="NotAHandler" />\n' +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_ReserveRoom" sourceRef="S" targetRef="ReserveRoom" />\n' +
          '    <bpmn:sequenceFlow id="Flow_ReserveRoom_E" sourceRef="ReserveRoom" targetRef="E" />\n' +
          '    <bpmn:association id="Assoc1" sourceRef="CompensationBoundary" targetRef="NotAHandler" />',
      ),
      UnsupportedEventFeatureError,
      [COMPENSATION_BOUNDARY_DETAIL],
    ],
    [
      'an activityRef on a compensation definition names the attribute',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:userTask id="T" />\n' +
          '    <bpmn:endEvent id="ThrowUndo">\n' +
          '      <bpmn:compensateEventDefinition id="d" activityRef="T" />\n' +
          '    </bpmn:endEvent>\n' +
          '    <bpmn:sequenceFlow id="Flow_S_T" sourceRef="S" targetRef="T" />\n' +
          '    <bpmn:sequenceFlow id="Flow_T_ThrowUndo" sourceRef="T" targetRef="ThrowUndo" />',
      ),
      UnsupportedEventFeatureError,
      [
        'a compensation definition targets one activity by reference ' +
          '(activityRef="T"); this tool always addresses the enclosing ' +
          'scope and cannot target a single activity',
      ],
    ],
    [
      'waitForCompletion="false" names the attribute',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:endEvent id="ThrowUndo">\n' +
          '      <bpmn:compensateEventDefinition id="d" waitForCompletion="false" />\n' +
          '    </bpmn:endEvent>\n' +
          '    <bpmn:sequenceFlow id="Flow_S_ThrowUndo" sourceRef="S" targetRef="ThrowUndo" />',
      ),
      UnsupportedEventFeatureError,
      [
        'a compensation definition sets waitForCompletion="false"; this ' +
          'tool only imports the default (wait for the compensation to ' +
          'complete) behavior',
      ],
    ],
    [
      'bpmn:adHocSubProcess stays refused on engine evidence',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:adHocSubProcess id="T"><bpmn:userTask id="A" /></bpmn:adHocSubProcess>\n' +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_T" sourceRef="S" targetRef="T" />\n' +
          '    <bpmn:sequenceFlow id="Flow_T_E" sourceRef="T" targetRef="E" />',
      ),
      UnsupportedElementError,
      ['bpmn:AdHocSubProcess'],
    ],
    [
      'bpmn:complexGateway stays refused on engine evidence',
      bpmnDoc(
        '    <bpmn:startEvent id="S" />\n' +
          '    <bpmn:complexGateway id="T" />\n' +
          '    <bpmn:endEvent id="E" />\n' +
          '    <bpmn:sequenceFlow id="Flow_S_T" sourceRef="S" targetRef="T" />\n' +
          '    <bpmn:sequenceFlow id="Flow_T_E" sourceRef="T" targetRef="E" />',
      ),
      UnsupportedElementError,
      ['bpmn:ComplexGateway'],
    ],
  ] as const)('%s', async (_title, xml, errorClass, needles) => {
    const error = await refusalError(xml, errorClass);
    for (const needle of needles) {
      expect(error.message).toContain(needle);
    }
  });

  it("the paired triple's printed rewrite re-parses through the compiler", async () => {
    const error = (await refusalError(
      PAIRED_TRIPLE_XML,
      UnsupportedEventFeatureError,
    )) as UnsupportedEventFeatureError;
    // `.detail` is the raw refusal text, unlike `.message`, which trails it
    // with the generic event-surface closing sentence right after the
    // rewrite's own closing brace, with no blank line to split on.
    const marker = 'Write it by hand instead:\n\n';
    const cut = error.detail.indexOf(marker);
    expect(cut).toBeGreaterThan(-1);

    const rewrite = error.detail.slice(cut + marker.length);
    expect(rewrite).toBe(REWRITE_PREVIEW);

    const wrapped = `process Preview {\n${rewrite}\n}\n`;
    const document = await parse(wrapped);
    expect(document.parseResult.parserErrors).toEqual([]);

    const { diagnostics } = await validate(wrapped);
    expect(diagnostics).toEqual([]);
  });
});
