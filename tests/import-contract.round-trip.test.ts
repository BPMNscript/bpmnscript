// One document holding every construct the import converts or refuses, so an
// interaction between them (a spurious warning, a refusal naming the wrong
// construct) shows even when each construct's own test stays green.

import { describe, it, expect } from 'vitest';

import {
  astToIr,
  irToXml,
  dataConstructDropMessage,
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
  'note: BPMNscript imports the executable flow and the engine settings on ' +
  'its steps, and nothing declared or drawn beside it';

const dataDropped = (tag: string, id: string) =>
  dataConstructDropMessage(`'bpmn:${tag}' element '${id}'`);

const EXPECTED_WARNINGS: ImportWarning[] = [
  {
    elementId: 'SignOff',
    category: 'rewritten',
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
      "setting 'operaton:resource' on 'Flow_Decide_SignOff' was not imported\n" +
      "note: it only takes effect alongside a 'language' attribute\n" +
      'note: on its own the condition runs as the expression written in the body',
  },
  {
    elementId: 'G3',
    category: 'unmappedConstruct',
    message: `root 'bpmn:globalScriptTask' element 'G3' was not imported\n${IMPORTED_FLOW_NOTE}`,
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

// Labels equal to the id in words are the ones an import may wrongly treat as
// derivable; the export derives a label only for tasks and sub-processes.
const LABELLED = bpmnDoc(
  '    <bpmn:startEvent id="OrderPlaced" name="Order Placed" />\n' +
    '    <bpmn:userTask id="ShipOrder" name="Ship the order" />\n' +
    '    <bpmn:subProcess id="Packing" name="Packing">\n' +
    '      <bpmn:startEvent id="PackingStarted" name="Packing Started" />\n' +
    '      <bpmn:endEvent id="Packed" name="Packed" />\n' +
    '      <bpmn:sequenceFlow id="P1" sourceRef="PackingStarted" targetRef="Packed" />\n' +
    '    </bpmn:subProcess>\n' +
    '    <bpmn:subProcess id="OnTimeout" triggeredByEvent="true">\n' +
    '      <bpmn:startEvent id="TimedOut" name="Timed Out">\n' +
    '        <bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition>\n' +
    '      </bpmn:startEvent>\n' +
    '      <bpmn:endEvent id="Abandoned" name="Abandoned" />\n' +
    '      <bpmn:sequenceFlow id="T1" sourceRef="TimedOut" targetRef="Abandoned" />\n' +
    '    </bpmn:subProcess>\n' +
    '    <bpmn:endEvent id="OrderShipped" name="Order Shipped" />\n' +
    '    <bpmn:sequenceFlow id="F1" sourceRef="OrderPlaced" targetRef="ShipOrder" />\n' +
    '    <bpmn:sequenceFlow id="F2" sourceRef="ShipOrder" targetRef="Packing" />\n' +
    '    <bpmn:sequenceFlow id="F3" sourceRef="Packing" targetRef="OrderShipped" />',
);

it('every label written on a surface that carries one survives XML -> script -> XML, also when it equals the id in words', async () => {
  const names = (xml: string) =>
    Object.fromEntries(
      [...xml.matchAll(/<bpmn:\w+ id="([^"]+)" name="([^"]*)"/g)].map(
        ([, id, name]) => [id, name],
      ),
    );
  const { ir, warnings } = await xmlToIr(LABELLED);
  expect(warnings).toEqual([]);
  const rebuilt = await irToXml(astToIr(await parseToAst(printDsl(ir))));
  const kept = names(rebuilt);
  expect(
    Object.fromEntries(
      Object.keys(names(LABELLED)).map((id) => [id, kept[id]]),
    ),
  ).toEqual(names(LABELLED));
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

// Notes several refusals share.
const CONNECTOR_NOTES = [
  "note: the Connect plugin runs it in place of whatever 'operaton:class', 'expression', 'delegateExpression' or 'type' names beside it",
  'note: an engine without the plugin runs that binding instead of it, so the same file has two possible executions',
  'note: the supported forms are a Java class, an expression, a delegate expression, an external task topic, a built-in mail or shell task with its fields, or a decision reference on a business rule task',
  "note: their attributes are 'operaton:class' (or the deprecated 'camunda:class' alias), 'operaton:expression', 'operaton:delegateExpression', 'operaton:type=\"external\"' with 'operaton:topic', 'operaton:type=\"mail\"' or 'operaton:type=\"shell\"' with their 'operaton:field' children, and 'operaton:decisionRef'",
];
const COMPENSATION_BOUNDARY_REFUSAL = [
  "element 'CompensationBoundary' cannot be imported: a compensation boundary event is not imported",
  "note: BPMN attaches compensation through 'isForCompensation' and a 'bpmn:association' on the activity being compensated, not a boundary event",
  "help: wrap the steps in their own subprocess and target it with 'on compensation'",
].join('\n');
const SUPPORTED_ELEMENTS_NOTE =
  'note: BPMNscript imports start and end events, throws, emits, boundary events, event handlers, plain tasks, user tasks, service tasks, send tasks, receive tasks, business rule tasks, script tasks, exclusive gateways, parallel gateways, inclusive gateways, event-based gateways, embedded subprocesses, attempt blocks, call activities and sequence flows';

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
      [
        "condition on 'Flow_S_T' cannot be imported: it declares 'language=\"groovy\"'",
        'note: Operaton runs it in a script engine rather than evaluating it as UEL',
        "note: BPMNscript writes a condition as a 'tFormalExpression', which Operaton evaluates as UEL",
        'note: a condition of another type, or one Operaton hands to a script engine, has no spelling in BPMNscript',
      ].join('\n'),
    ],
    [
      'a script task with a deployment resource names the resource',
      oneStep(
        'Compute',
        '<bpmn:scriptTask id="Compute" scriptFormat="javascript" ' +
          'operaton:resource="deployment://check.groovy"><bpmn:script>1 + 1</bpmn:script></bpmn:scriptTask>',
      ),
      UnsupportedExtensionFormError,
      [
        "the Operaton extension content on 'Compute' cannot be imported: the script on 'Compute' names an external resource ('deployment://check.groovy')",
        "note: 'ScriptUtil.getScript' runs the resource in place of the body, and only an inline body can be written here",
      ].join('\n'),
    ],
    [
      'a connector as the only implementation names the connector',
      oneStep(
        'Notify',
        `<bpmn:serviceTask id="Notify">${CONNECTOR}</bpmn:serviceTask>`,
      ),
      UnsupportedServiceTaskFormError,
      [
        "service task 'Notify' uses an unsupported execution form: an 'operaton:connector' element",
        ...CONNECTOR_NOTES,
      ].join('\n'),
    ],
    [
      'a connector beside a class names the connector, not the class',
      oneStep(
        'NotifyBeta',
        `<bpmn:serviceTask id="NotifyBeta" operaton:class="com.example.Svc">${CONNECTOR}</bpmn:serviceTask>`,
      ),
      UnsupportedServiceTaskFormError,
      [
        "service task 'NotifyBeta' uses an unsupported execution form: an 'operaton:connector' element",
        ...CONNECTOR_NOTES,
      ].join('\n'),
    ],
    [
      'an unpaired isForCompensation activity falls back to the general wording',
      oneStep(
        'CancelReservation',
        '<bpmn:serviceTask id="CancelReservation" operaton:class="com.example.Cancel" isForCompensation="true" />',
      ),
      UnsupportedEventFeatureError,
      [
        "element 'CancelReservation' cannot be imported: 'isForCompensation=\"true\"' marks this activity as excluded from normal flow",
        "note: that is BPMN's boundary-event compensation-handler pattern, which BPMNscript cannot import",
        "help: wrap the steps in their own subprocess and target it with 'on compensation'",
      ].join('\n'),
    ],
    [
      'an unpaired compensation boundary event falls back to the general wording',
      oneStep('ReserveRoom', COMPENSATED_ROOM),
      UnsupportedEventFeatureError,
      COMPENSATION_BOUNDARY_REFUSAL,
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
      [
        "element 'CompensationBoundary' cannot be imported: boundary event 'CompensationBoundary' compensates 'ReserveRoom' through the handler 'CancelReservation' its 'bpmn:association' targets",
        'note: a compensation boundary event is not imported',
        'help: write it by hand instead',
        '    subprocess Compensated_ReserveRoom {',
        '      service ReserveRoom(class: "com.example.Reserve")',
        '      on compensation {',
        '        user CancelReservation',
        '      }',
        '    }',
      ].join('\n'),
    ],
    [
      'a compensation association pointing at a non-handler falls back to the general wording',
      oneStep(
        'ReserveRoom',
        COMPENSATED_ROOM + '\n    <bpmn:task id="NotAHandler" />',
        association('NotAHandler'),
      ),
      UnsupportedEventFeatureError,
      COMPENSATION_BOUNDARY_REFUSAL,
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
        "element 'ThrowUndo' cannot be imported: a compensation definition targets one activity by reference ('activityRef=\"T\"')",
        'note: BPMNscript always addresses the enclosing scope and cannot target a single activity',
      ].join('\n'),
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
        "element 'ThrowUndo' cannot be imported: a compensation definition sets 'waitForCompletion=\"false\"'",
        'note: BPMNscript only imports the default behaviour, which waits for the compensation to complete',
      ].join('\n'),
    ],
    [
      'bpmn:adHocSubProcess stays refused on engine evidence',
      oneStep(
        'T',
        '<bpmn:adHocSubProcess id="T"><bpmn:userTask id="A" /></bpmn:adHocSubProcess>',
      ),
      UnsupportedElementError,
      "element 'T' of the kind 'bpmn:AdHocSubProcess' cannot be imported\n" +
        SUPPORTED_ELEMENTS_NOTE,
    ],
    [
      'bpmn:complexGateway stays refused on engine evidence',
      oneStep('T', '<bpmn:complexGateway id="T" />'),
      UnsupportedElementError,
      "element 'T' of the kind 'bpmn:ComplexGateway' cannot be imported\n" +
        SUPPORTED_ELEMENTS_NOTE,
    ],
  ] as const)('%s', async (_title, xml, errorClass, message) => {
    expect((await refusalError(xml, errorClass)).message).toBe(message);
  });
});
