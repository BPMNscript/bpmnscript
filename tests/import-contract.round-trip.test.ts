// One document holding every construct the import converts or refuses, so an
// interaction between them (a spurious warning, a refusal naming the wrong
// construct) shows even when each construct's own test stays green.

import { describe, it, expect } from 'vitest';

import {
  astToIr,
  COMPENSATION_BOUNDARY_DETAIL,
  CONNECTOR_CONSTRUCT,
  dataConstructDropMessage,
  IS_FOR_COMPENSATION_DETAIL,
  loopDroppedMessage,
  manualTaskMessage,
  xmlToIr,
  UnsupportedConditionExpressionError,
  UnsupportedElementError,
  UnsupportedEventFeatureError,
  UnsupportedExtensionFormError,
  UnsupportedServiceTaskFormError,
} from '@bpmn-script/transform';
import type { ImportWarning } from '@bpmn-script/transform';

import { bpmnDoc } from './helpers/bpmn-doc.js';
import { normalizeIr } from './helpers/normalize-ir.js';
import { parseToAst, printDsl, validate } from './helpers/pipeline.js';

// moddle declares `GlobalScriptTask.script` an attribute where the XSD has an
// element; the root's unparsable child must not be reported again on the process.
const GLOBAL_SCRIPT_TASK_ROOT =
  '  <bpmn:globalScriptTask id="G3">\n' +
  '    <bpmn:script>x</bpmn:script>\n' +
  '  </bpmn:globalScriptTask>\n';

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
    // A free variable here would draw an unrelated "not declared" diagnostic.
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
  dataConstructDropMessage(`bpmn:${tag} '${id}'`);

const EXPECTED_WARNINGS: ImportWarning[] = [
  {
    elementId: 'SignOff',
    category: 'unmappedConstruct',
    message: manualTaskMessage('SignOff'),
  },
  {
    elementId: 'Review',
    category: 'unmappedConstruct',
    message: loopDroppedMessage('bpmn:standardLoopCharacteristics', 'Review'),
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

it('a document holding every construct the import converts warns exactly per the contract and prints a clean, equivalent script', async () => {
  const { ir, warnings } = await xmlToIr(FIXTURE);
  expect(warnings).toEqual(EXPECTED_WARNINGS);
  const dsl = printDsl(ir);
  const { diagnostics } = await validate(dsl);
  expect(diagnostics).toEqual([]);
  expect(normalizeIr(astToIr(await parseToAst(dsl)))).toEqual(normalizeIr(ir));
});

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

// Start `S` -> `id` -> end `E`, with `extra` after the flows.
const oneStep = (id: string, element: string, extra = '') =>
  bpmnDoc(
    '    <bpmn:startEvent id="S" />\n' +
      `    ${element}\n` +
      '    <bpmn:endEvent id="E" />\n' +
      `    <bpmn:sequenceFlow id="Flow_S_${id}" sourceRef="S" targetRef="${id}" />\n` +
      `    <bpmn:sequenceFlow id="Flow_${id}_E" sourceRef="${id}" targetRef="E" />` +
      extra,
  );

const CONNECTOR =
  '<bpmn:extensionElements><operaton:connector><operaton:connectorId>http-connector' +
  '</operaton:connectorId></operaton:connector></bpmn:extensionElements>';

const COMPENSATED_ROOM =
  '<bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />\n' +
  '    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">\n' +
  '      <bpmn:compensateEventDefinition id="d" />\n' +
  '    </bpmn:boundaryEvent>';

const association = (target: string) =>
  `\n    <bpmn:association id="Assoc1" sourceRef="CompensationBoundary" targetRef="${target}" />`;

describe('every construct the import refuses names itself in its own message', () => {
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
      oneStep(
        'Compute',
        '<bpmn:scriptTask id="Compute" scriptFormat="javascript" ' +
          'operaton:resource="deployment://check.groovy"><bpmn:script>1 + 1</bpmn:script></bpmn:scriptTask>',
      ),
      UnsupportedExtensionFormError,
      ['names an external resource ("deployment://check.groovy")', "'Compute'"],
    ],
    [
      'a connector as the only implementation names the connector',
      oneStep(
        'Notify',
        `<bpmn:serviceTask id="Notify">${CONNECTOR}</bpmn:serviceTask>`,
      ),
      UnsupportedServiceTaskFormError,
      [CONNECTOR_CONSTRUCT],
    ],
    [
      'a connector beside a class names the connector, not the class',
      oneStep(
        'NotifyBeta',
        `<bpmn:serviceTask id="NotifyBeta" operaton:class="com.example.Svc">${CONNECTOR}</bpmn:serviceTask>`,
      ),
      UnsupportedServiceTaskFormError,
      [CONNECTOR_CONSTRUCT],
    ],
    [
      'an unpaired isForCompensation activity falls back to the general wording',
      oneStep(
        'CancelReservation',
        '<bpmn:serviceTask id="CancelReservation" operaton:class="com.example.Cancel" isForCompensation="true" />',
      ),
      UnsupportedEventFeatureError,
      [IS_FOR_COMPENSATION_DETAIL],
    ],
    [
      'an unpaired compensation boundary event falls back to the general wording',
      oneStep('ReserveRoom', COMPENSATED_ROOM),
      UnsupportedEventFeatureError,
      [COMPENSATION_BOUNDARY_DETAIL],
    ],
    [
      'a paired compensation triple names the compensated activity, the boundary, and the handler',
      oneStep(
        'ReserveRoom',
        COMPENSATED_ROOM +
          '\n    <bpmn:userTask id="CancelReservation" isForCompensation="true" />',
        association('CancelReservation'),
      ),
      UnsupportedEventFeatureError,
      ['ReserveRoom', 'CompensationBoundary', 'CancelReservation'],
    ],
    [
      'a compensation association pointing at a non-handler falls back to the general wording',
      oneStep(
        'ReserveRoom',
        COMPENSATED_ROOM + '\n    <bpmn:task id="NotAHandler" />',
        association('NotAHandler'),
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
      oneStep(
        'T',
        '<bpmn:adHocSubProcess id="T"><bpmn:userTask id="A" /></bpmn:adHocSubProcess>',
      ),
      UnsupportedElementError,
      ['bpmn:AdHocSubProcess'],
    ],
    [
      'bpmn:complexGateway stays refused on engine evidence',
      oneStep('T', '<bpmn:complexGateway id="T" />'),
      UnsupportedElementError,
      ['bpmn:ComplexGateway'],
    ],
  ] as const)('%s', async (_title, xml, errorClass, needles) => {
    const error = await refusalError(xml, errorClass);
    for (const needle of needles) {
      expect(error.message).toContain(needle);
    }
  });
});
