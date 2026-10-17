import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  asyncRespellingMessage,
  CAMUNDA_ALIAS_MESSAGE,
  shadowedSpellingMessage,
  unimportedSettingMessage,
  xmlToIr,
} from '../src/xml-to-ir.js';
import type { ImportWarning } from '../src/xml-to-ir.js';
import { HISTORY_TIME_TO_LIVE, irToXml } from '../src/ir-to-xml.js';
import { irToDsl } from '../src/ir-to-dsl.js';
import {
  UnsupportedCallActivityError,
  UnsupportedVariableNameError,
  UnsupportedCollaborationError,
  UnsupportedConditionExpressionError,
  UnsupportedDocumentError,
  UnsupportedElementError,
  UnsupportedEventDefinitionError,
  UnsupportedAssignmentError,
  UnsupportedErrorMappingError,
  UnsupportedEventFeatureError,
  UnsupportedExtensionFormError,
  UnsupportedFormFieldConstraintError,
  UnsupportedFormReferenceError,
  UnsupportedGatewayShapeError,
  UnsupportedLoopCharacteristicsError,
  SUPPORTED_KINDS_MESSAGE,
  UnsupportedServiceTaskFormError,
} from '../src/errors.js';
import type {
  BpmnProcess,
  EventDefinition,
  FlowElement,
  FormField,
  ServiceTaskBinding,
} from '../src/ir/types.js';
import { isGateway } from '../src/ir/types.js';
import { expectRefusal } from './helpers/expect-refusal.js';
import {
  boundaryEvent,
  builtinBinding,
  classBinding,
  conditionDef,
  delegateBinding,
  errorDef,
  escalationDef,
  exprBinding,
  externalBinding,
  HANDWRITTEN_IMPORT_IR,
  ioParam,
  listValue,
  mapEntry,
  mapValue,
  messageDef,
  minimalProcess,
  signalDef,
  textValue,
  timerDef,
  triggeredSub,
  typedEvent,
} from './helpers/ir-fixtures.js';
import type { XmlTag } from './helpers/bpmn-doc.js';
import {
  bpmnDefs,
  TIME_TO_LIVE,
  bpmnDoc,
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
import { byId, subProcess } from './helpers/ir-query.js';
import { parse, validate } from './helpers/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const HANDWRITTEN_XML = readFileSync(
  resolve(here, '../../../tests/golden/invoice-approval-handwritten.bpmn'),
  'utf-8',
);

const expectParses = async (source: string): Promise<void> => {
  const doc = await parse(source, { validation: true });
  expect(doc.parseResult.parserErrors).toEqual([]);
  expect(doc.diagnostics ?? []).toEqual([]);
};

const HANDLER_TRIGGER =
  "note: an event handler catches one 'error', 'escalation', 'message', 'signal', 'timer', 'condition', or 'compensation' trigger on its single start event";
const THROW_CODE =
  'note: throws and emits carry the code or name their kind requires, and compensation carries neither';
const THROWN_MESSAGE_FORMS = [
  'note: the supported forms are a Java class, an expression, a delegate expression, or an external task topic',
  "note: their attributes are 'operaton:class' (or the deprecated 'camunda:class' alias), 'operaton:expression', 'operaton:delegateExpression', and 'operaton:type=\"external\"' with 'operaton:topic'",
];

const ONE_VALUE_SLOT =
  'note: an injected field names exactly one value slot, and Operaton refuses to deploy one that names none or both of its literal slots';

const expectExtensionRefusal = async (
  xml: string,
  elementId: string,
  detail: string,
  notes: readonly string[],
): Promise<void> => {
  const e = await expectRefusal<UnsupportedExtensionFormError>(
    xmlToIr(xml),
    UnsupportedExtensionFormError,
    detail,
  );
  expect([e.elementId, e.message]).toEqual([
    elementId,
    [
      `the Operaton extension content on '${elementId}' cannot be imported: ${detail}`,
      ...notes,
    ].join('\n'),
  ]);
};

const IS_FOR_COMPENSATION =
  '\'isForCompensation="true"\' marks this activity as excluded from normal flow';
const EXCLUDED_FROM_FLOW = [
  "note: that is BPMN's boundary-event compensation-handler pattern, which BPMNscript cannot import",
  "help: wrap the steps in their own subprocess and target it with 'on compensation'",
];

const expectEventRefusal = async (
  xml: string,
  elementId: string,
  detail: string,
  notes: readonly string[],
): Promise<UnsupportedEventFeatureError> => {
  const e = await expectRefusal<UnsupportedEventFeatureError>(
    xmlToIr(xml),
    UnsupportedEventFeatureError,
    detail,
  );
  expect([e.elementId, e.message]).toEqual([
    elementId,
    [`element '${elementId}' cannot be imported: ${detail}`, ...notes].join(
      '\n',
    ),
  ]);
  return e;
};

const warning = (
  elementId: string,
  message: string,
  category: ImportWarning['category'] = 'extensionAttribute',
): ImportWarning => ({ elementId, category, message });

const unread = (
  subject: string,
  id: string,
  tag: string,
  engine?: string,
): ImportWarning => ({
  elementId: id,
  category: 'extensionAttribute',
  message: unimportedSettingMessage(subject, id, tag, engine),
});

const danglingErrorRef = (ownerId: string, ref: string): ImportWarning => ({
  elementId: ownerId,
  category: 'rewritten',
  message:
    `'errorRef' '${ref}' on '${ownerId}' names no 'bpmn:error' root and imports as the code '${ref}'\n` +
    "note: Operaton takes a dangling reference's text as the code ('BpmnParse.parseBoundaryErrorEventDefinition', 'parseErrorStartEventDefinition', 'parseEndEvents', 'parseOperatonErrorEventDefinitions')\n" +
    'note: the rebuilt document declares an error root that carries it',
});

const CAMUNDA_ALIAS_WARNING = {
  elementId: 'p',
  category: 'rewritten',
  message: CAMUNDA_ALIAS_MESSAGE,
};

const rootedDoc = (roots: string, body: string, defs = bpmnDefs): string =>
  defs`${roots}  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
${body}
  </bpmn:process>`;

describe('xmlToIr: canonical handwritten file', () => {
  it.each([
    ['operaton:', HANDWRITTEN_XML, []],
    [
      'camunda:',
      HANDWRITTEN_XML.replace(
        /xmlns:operaton="http:\/\/operaton\.org\/schema\/1\.0\/bpmn"/g,
        'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"',
      ).replace(/operaton:/g, 'camunda:'),
      [{ ...CAMUNDA_ALIAS_WARNING, elementId: HANDWRITTEN_IMPORT_IR.id }],
    ],
  ])(
    'the %s spelling imports to the canonical IR, without diagram shapes, wiring or a derivable process name',
    async (_prefix, xml, expected) => {
      const { ir, warnings } = await xmlToIr(xml);
      expect(ir).toEqual(HANDWRITTEN_IMPORT_IR);
      expect(warnings).toEqual(expected);
    },
  );

  const constructsBody = (
    prefix: 'operaton' | 'camunda',
  ): string => `    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Review" name="Review" ${prefix}:assignee="alice">
      <bpmn:extensionElements>
        <${prefix}:taskListener event="create" class="com.example.C" />
        <${prefix}:inputOutput>
          <${prefix}:inputParameter name="amount">42</${prefix}:inputParameter>
        </${prefix}:inputOutput>
        <${prefix}:failedJobRetryTimeCycle>R3/PT10M</${prefix}:failedJobRetryTimeCycle>
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:callActivity id="Call" calledElement="other">
      <bpmn:extensionElements>
        <${prefix}:in source="a" target="b" />
      </bpmn:extensionElements>
    </bpmn:callActivity>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Call" />
    <bpmn:sequenceFlow id="F3" sourceRef="Call" targetRef="End" />`;

  const expectConstructsImported = (ir: BpmnProcess): void => {
    expect(byId(ir, 'Review')).toEqual({
      kind: 'userTask',
      id: 'Review',
      assignee: 'alice',
      taskListeners: [
        { event: 'create', binding: classBinding('com.example.C') },
      ],
      inputParameters: [ioParam('amount', textValue('42'))],
      retryCycle: 'R3/PT10M',
    });
    expect(byId(ir, 'Call')).toEqual({
      kind: 'callActivity',
      id: 'Call',
      calledElement: 'other',
      inMappings: [{ kind: 'variable', source: 'a', target: 'b' }],
    });
  };

  it('a camunda: file carrying an assignee, a task listener, an inputOutput, a call activity in mapping and a retry cycle imports every one of them, with exactly the one namespace warning', async () => {
    const { ir, warnings } = await xmlToIr(
      camundaDoc`${constructsBody('camunda')}`,
    );
    expectConstructsImported(ir);
    expect(warnings).toEqual([CAMUNDA_ALIAS_WARNING]);
  });
});

describe('xmlToIr: a document spelling one setting under both prefixes', () => {
  const listener = (prefix: string, className: string): string =>
    `<${prefix}:executionListener event="start" class="${className}" />`;
  const inputOutput = (prefix: string, name: string): string =>
    `<${prefix}:inputOutput><${prefix}:inputParameter name="${name}">1</${prefix}:inputParameter></${prefix}:inputOutput>`;
  const shadowed = (...names: string[]): ImportWarning => ({
    elementId: 'T',
    category: 'extensionAttribute',
    message: shadowedSpellingMessage('T', names),
  });

  it.each([
    {
      title: 'an attribute under both keeps the operaton: one',
      attrs: 'operaton:class="org.A" camunda:class="org.B"',
      children: '',
      node: { binding: classBinding('org.A') },
      warnings: [CAMUNDA_ALIAS_WARNING, shadowed('camunda:class')],
    },
    {
      title: 'an attribute under camunda: alone is read',
      attrs: 'camunda:class="org.B"',
      children: '',
      node: { binding: classBinding('org.B') },
      warnings: [CAMUNDA_ALIAS_WARNING],
    },
    {
      title:
        'a listener under both keeps every operaton: one and no camunda: one, whatever the order',
      attrs: 'operaton:class="org.A"',
      children: extensionElements(
        listener('camunda', 'org.B') +
          listener('operaton', 'org.C') +
          listener('camunda', 'org.D'),
      ),
      node: {
        binding: classBinding('org.A'),
        executionListeners: [
          { event: 'start', binding: classBinding('org.C') },
        ],
      },
      warnings: [
        CAMUNDA_ALIAS_WARNING,
        shadowed('<camunda:executionListener>'),
      ],
    },
    {
      title:
        'a listener under camunda: alone is read beside other operaton: content',
      attrs: 'operaton:class="org.A"',
      children: extensionElements(
        listener('camunda', 'org.B') + inputOutput('operaton', 'a'),
      ),
      node: {
        binding: classBinding('org.A'),
        executionListeners: [
          { event: 'start', binding: classBinding('org.B') },
        ],
        inputParameters: [ioParam('a', textValue('1'))],
      },
      warnings: [CAMUNDA_ALIAS_WARNING],
    },
    {
      title:
        'an extension element under both keeps the operaton: one, and one warning names every ignored spelling',
      attrs: 'operaton:class="org.A" camunda:class="org.B"',
      children: extensionElements(
        inputOutput('camunda', 'b') + inputOutput('operaton', 'a'),
      ),
      node: {
        binding: classBinding('org.A'),
        inputParameters: [ioParam('a', textValue('1'))],
      },
      warnings: [
        CAMUNDA_ALIAS_WARNING,
        shadowed('camunda:class', '<camunda:inputOutput>'),
      ],
    },
    {
      title:
        'list items and map entries under both are all read, since BpmnParseUtil reads them by tag alone',
      attrs: 'operaton:class="org.A"',
      children: extensionElements(
        '<operaton:inputOutput><operaton:inputParameter name="x"><operaton:list>' +
          '<camunda:value>b</camunda:value><operaton:value>a</operaton:value>' +
          '</operaton:list></operaton:inputParameter><operaton:inputParameter name="y"><operaton:map>' +
          '<camunda:entry key="k">b</camunda:entry><operaton:entry key="j">a</operaton:entry>' +
          '</operaton:map></operaton:inputParameter></operaton:inputOutput>',
      ),
      node: {
        binding: classBinding('org.A'),
        inputParameters: [
          ioParam('x', listValue([textValue('b'), textValue('a')])),
          ioParam(
            'y',
            mapValue([
              mapEntry('k', textValue('b')),
              mapEntry('j', textValue('a')),
            ]),
          ),
        ],
      },
      warnings: [CAMUNDA_ALIAS_WARNING],
    },
    {
      title:
        'error mappings under both are all read, since parseOperatonErrorEventDefinitions fetches them by tag alone',
      attrs: 'operaton:type="external" operaton:topic="t"',
      children: extensionElements(
        '<camunda:errorEventDefinition errorRef="B" expression="${x}" />' +
          '<operaton:errorEventDefinition errorRef="A" expression="${y}" />',
      ),
      node: {
        binding: {
          ...externalBinding('t'),
          errorMappings: [
            { errorCode: 'B', condition: '${x}' },
            { errorCode: 'A', condition: '${y}' },
          ],
        },
      },
      warnings: [
        danglingErrorRef('T', 'B'),
        danglingErrorRef('T', 'A'),
        CAMUNDA_ALIAS_WARNING,
      ],
    },
    {
      title:
        'a prefix redeclared onto the operaton URI on one element counts as operaton:',
      attrs:
        'xmlns:c="http://operaton.org/schema/1.0/bpmn" c:class="org.A" camunda:class="org.B"',
      children: '',
      node: { binding: classBinding('org.A') },
      warnings: [CAMUNDA_ALIAS_WARNING, shadowed('camunda:class')],
    },
    {
      title:
        'a default-namespace camunda: child is cut beside an operaton: one',
      attrs: 'operaton:class="org.A"',
      children: extensionElements(
        '<executionListener xmlns="http://camunda.org/schema/1.0/bpmn" event="start" class="org.B" />' +
          listener('operaton', 'org.C'),
      ),
      node: {
        binding: classBinding('org.A'),
        executionListeners: [
          { event: 'start', binding: classBinding('org.C') },
        ],
      },
      warnings: [CAMUNDA_ALIAS_WARNING, shadowed('<executionListener>')],
    },
    {
      title:
        'a > inside an earlier attribute value does not end the start tag early',
      attrs: 'name="a > b" operaton:class="org.A" camunda:class="org.B"',
      children: '',
      node: { name: 'a > b', binding: classBinding('org.A') },
      warnings: [CAMUNDA_ALIAS_WARNING, shadowed('camunda:class')],
    },
    {
      title:
        'CRLF line ends and a start tag over several lines still cut the right range',
      attrs:
        'operaton:class="org.A"\r\n        camunda:class="org.B"\r\n        ',
      children: extensionElements(
        '\r\n' +
          listener('camunda', 'org.B') +
          '\r\n' +
          listener('operaton', 'org.C'),
      ),
      node: {
        binding: classBinding('org.A'),
        executionListeners: [
          { event: 'start', binding: classBinding('org.C') },
        ],
      },
      warnings: [
        CAMUNDA_ALIAS_WARNING,
        shadowed('camunda:class', '<camunda:executionListener>'),
      ],
    },
    {
      title:
        'a camunda: child inside a cut camunda: child goes with it and adds no warning',
      attrs: 'operaton:class="org.A"',
      children: extensionElements(
        '<operaton:inputOutput><operaton:inputParameter name="a">1</operaton:inputParameter></operaton:inputOutput>' +
          '<camunda:inputOutput><operaton:inputParameter name="b">2</operaton:inputParameter>' +
          '<camunda:inputParameter name="c">3</camunda:inputParameter></camunda:inputOutput>',
      ),
      node: {
        binding: classBinding('org.A'),
        inputParameters: [ioParam('a', textValue('1'))],
      },
      warnings: [CAMUNDA_ALIAS_WARNING, shadowed('<camunda:inputOutput>')],
    },
  ])('$title', async ({ attrs, children, node, warnings: expected }) => {
    const { ir, warnings } = await xmlToIr(
      oneNodeDoc('serviceTask', { attrs, children, doc: dualDoc }),
    );
    expect(byId(ir, 'T')).toEqual({ kind: 'serviceTask', id: 'T', ...node });
    expect(warnings).toEqual(expected);
  });
});

describe('xmlToIr: a malformed document declaring both URIs', () => {
  it('is reported by moddle exactly as when it declares one', async () => {
    const malformed = dualDoc`<bpmn:startEvent id="S" camunda:x="1" operaton:x="2"></bpmn:task>`;
    const message = async (xml: string): Promise<string> =>
      xmlToIr(xml).then(
        () => 'imported',
        (e: unknown) => (e as Error).message,
      );
    const one = await message(
      malformed.replace('http://camunda.org/schema/1.0', 'http://other.org/x'),
    );
    expect(one).toMatch(/unparsable content/);
    expect(await message(malformed)).toBe(one);
  });
});

describe('xmlToIr: script task support', () => {
  const scriptTask = (attrs: string, children = '') =>
    oneNodeDoc('scriptTask', { id: 'ST', attrs, children, doc: bpmnDoc });

  it.each([
    [
      'a missing scriptFormat imports as juel, naming the engine default',
      '',
      '<bpmn:script>x = 1;</bpmn:script>',
      { format: 'juel' },
      'rewritten',
      "script on 'ST' has no 'scriptFormat' and imports as 'juel'\n" +
        "note: 'BpmnParse.parseScriptTaskElement' substitutes 'ScriptingEngines.DEFAULT_SCRIPTING_LANGUAGE', which is 'juel'",
    ],
    [
      'a scriptFormat outside the alias table is carried as written',
      'scriptFormat="cobol"',
      '<bpmn:script>1</bpmn:script>',
      { format: 'cobol' },
      'carriedAsWritten',
      "script on 'ST' names the language 'cobol', which BPMNscript has no fence alias for\n" +
        'note: it was imported as written, and the printed script draws an error there',
    ],
    [
      'a self-closing bpmn:script imports as an empty body without a warning, since ScriptUtil.getScript deploys it',
      'scriptFormat="javascript"',
      '<bpmn:script/>',
      { code: '' },
      undefined,
      undefined,
    ],
    [
      'a self-closing operaton:script on a listener imports as an empty body without a warning, since ScriptUtil.getScript deploys it',
      'scriptFormat="javascript"',
      `<bpmn:extensionElements>
        <operaton:executionListener event="start">
          <operaton:script scriptFormat="groovy" />
        </operaton:executionListener>
      </bpmn:extensionElements>
      <bpmn:script>x = 1;</bpmn:script>`,
      {
        code: 'x = 1;',
        executionListeners: [
          {
            event: 'start',
            binding: { kind: 'script', format: 'groovy', code: '' },
          },
        ],
      },
      undefined,
      undefined,
    ],
  ] as const)(
    '%s',
    async (_title, attrs, children, carried, category, message) => {
      const { node, warnings } = await importOnly(
        scriptTask(attrs, children),
        'scriptTask',
      );
      expect(node).toMatchObject(carried);
      expect(warnings).toEqual(
        category === undefined ? [] : [{ elementId: 'ST', category, message }],
      );
    },
  );

  it('a URI scriptFormat prints a fence whose error names the whole format', async () => {
    const { ir } = await xmlToIr(
      scriptTask(
        'scriptFormat="http://www.java.com/java"',
        '<bpmn:script>x = 1;</bpmn:script>',
      ),
    );
    const { diagnostics } = await validate(irToDsl(ir).source);
    expect(diagnostics.map((d) => [d.severity, d.message])).toEqual([
      [
        1,
        "script task 'ST' has an unsupported language tag 'http://www.java.com/java'\n" +
          "help: use 'juel', 'js', 'javascript', 'ecmascript', 'groovy', 'py', 'python', 'rb', 'ruby', or 'feel'",
      ],
    ]);
  });

  it.each([
    [
      'an empty scriptFormat refuses',
      'scriptFormat=""',
      '<bpmn:script>x = 1;</bpmn:script>',
      "the script on 'ST' has an empty 'scriptFormat'",
      "note: 'ScriptUtil.getScript' refuses to deploy it",
    ],
    [
      'no script body and no resource refuses',
      'scriptFormat="javascript"',
      '',
      "the script on 'ST' has neither a script body nor a resource",
      "note: 'ScriptUtil.getScript' refuses to deploy it with neither",
    ],
  ])('%s', async (_title, attrs, children, detail, note) => {
    await expectExtensionRefusal(scriptTask(attrs, children), 'ST', detail, [
      note,
    ]);
  });
});

describe('xmlToIr: unsupported element', () => {
  it.each([
    [
      'an ad-hoc subprocess names its id',
      oneNodeDoc('adHocSubProcess', {
        children: '<bpmn:userTask id="A" />',
        doc: bpmnDoc,
      }),
      'bpmn:AdHocSubProcess',
      'T',
      "element 'T' of the kind 'bpmn:AdHocSubProcess' cannot be imported",
    ],
    [
      'an element with no id is named by its kind alone',
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:complexGateway />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      'bpmn:ComplexGateway',
      undefined,
      "an element of the kind 'bpmn:ComplexGateway' cannot be imported",
    ],
  ])(
    '%s, and lists every kind that imports',
    async (_title, xml, qname, elementId, head) => {
      const e = await expectRefusal<UnsupportedElementError>(
        xmlToIr(xml),
        UnsupportedElementError,
      );
      expect([e.qname, e.elementId, e.message]).toEqual([
        qname,
        elementId,
        `${head}\n${SUPPORTED_KINDS_MESSAGE}`,
      ]);
    },
  );
});

describe('xmlToIr: the document level', () => {
  const STEPS = `    <bpmn:startEvent id="S" />
    <bpmn:userTask id="A" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="A" />
    <bpmn:sequenceFlow id="F2" sourceRef="A" targetRef="E" />`;
  const process = (attrs: string, id = 'p', content = STEPS): string =>
    `  <bpmn:process id="${id}" ${TIME_TO_LIVE}${attrs}>\n${content}\n  </bpmn:process>`;
  const EXECUTABLE = process(' isExecutable="true"');
  const collaboration = (children: string): string =>
    `  <bpmn:collaboration id="C">\n${children}\n  </bpmn:collaboration>`;
  const unmapped = (elementId: string, message: string) =>
    warning(elementId, message, 'unmappedConstruct');
  const twoPools =
    collaboration(`    <bpmn:participant id="P1" name="Approval" processRef="approval" />
    <bpmn:participant id="P2" name="Sketch" processRef="sketch" />`);
  const approval = process(' isExecutable="true"', 'approval');
  const sketch = process(
    ' isExecutable="false"',
    'sketch',
    '    <bpmn:startEvent id="S2" />',
  );
  const twoPoolsWarnings = [
    unmapped(
      'sketch',
      "process 'sketch' is not marked executable and was not imported\nnote: 'BpmnParse.parseProcessDefinitions' does not deploy it either",
    ),
    unmapped(
      'P1',
      "pool 'Approval' (P1) was not imported\nnote: it names the imported process 'approval'\nnote: 'BpmnParse.parseCollaboration' records it for the diagram alone\nnote: the rebuilt document has no pool",
    ),
    unmapped(
      'P2',
      "pool 'Sketch' (P2) was not imported\nnote: it names process 'sketch', which was not imported\nnote: 'BpmnParse.parseCollaboration' records it for the diagram alone\nnote: the rebuilt document has no pool",
    ),
  ];

  it.each([
    [
      'one participant plus a message flow import with both warned',
      bpmnDefs`${collaboration(`    <bpmn:participant id="P1" name="Approval" processRef="p" />
    <bpmn:messageFlow id="MF" sourceRef="A" targetRef="P1" />`)}
${EXECUTABLE}`,
      {
        imports: 'p',
        warnings: [
          unmapped(
            'P1',
            "pool 'Approval' (P1) was not imported\nnote: it names the imported process 'p'\nnote: 'BpmnParse.parseCollaboration' records it for the diagram alone\nnote: the rebuilt document has no pool",
          ),
          unmapped(
            'MF',
            "message flow 'MF' from 'A' to 'P1' was not imported\nnote: 'BpmnParse' reads no message flow, so the process runs the same without it",
          ),
        ],
      },
    ],
    [
      'two pools over one executable and one non-executable process import the executable one, written first',
      bpmnDefs`${twoPools}\n${approval}\n${sketch}`,
      { imports: 'approval', warnings: twoPoolsWarnings },
    ],
    [
      'two executable processes refuse, naming both',
      bpmnDefs`${process(' isExecutable="true"', 'p1')}\n${process(' isExecutable="true"', 'p2', '    <bpmn:startEvent id="S2" />')}`,
      {
        refusal: UnsupportedCollaborationError,
        message:
          "the file contains two executable processes ('p1', 'p2')\nnote: BPMNscript imports one process\nnote: 'BpmnParse.parseProcessDefinitions' deploys each of them",
      },
    ],
    [
      'two processes neither marked executable refuse: the engine deploys none of them',
      bpmnDefs`${process('', 'p1')}\n${process('', 'p2', '    <bpmn:startEvent id="S2" />')}`,
      {
        refusal: UnsupportedDocumentError,
        message:
          "the document cannot be imported: none of its 2 processes is marked 'isExecutable=\"true\"'\nnote: 'BpmnParse.parseProcessDefinitions' deploys none of them in a new deployment",
      },
    ],
    [
      'one process without isExecutable imports as executable and says so',
      bpmnDefs`${process('')}`,
      {
        imports: 'p',
        warnings: [
          warning(
            'p',
            "process 'p' was imported as executable although it is not marked 'isExecutable=\"true\"'\nnote: 'BpmnParse.parseProcessDefinitions' skips such a process in a new deployment\nnote: it is written back as executable",
            'behaviourChanged',
          ),
        ],
      },
    ],
    [
      'a DOCTYPE with an internal entity refuses',
      bpmnDefs`${EXECUTABLE}`.replace(
        '<bpmn:definitions',
        '<!DOCTYPE bpmn:definitions [<!ENTITY internal "VAL">]>\n<bpmn:definitions',
      ),
      {
        refusal: UnsupportedDocumentError,
        message:
          "the document cannot be imported: it carries a '<!DOCTYPE>' declaration\nnote: Operaton refuses to deploy it, since 'Parser.setXxeProcessing' sets 'disallow-doctype-decl' unless XXE processing is enabled\nnote: BPMNscript does not expand its entities",
      },
    ],
    [
      'an entity XML does not predefine refuses',
      bpmnDefs`${process(' isExecutable="true"', 'p', STEPS.replace('id="A"', 'id="A" name="A&nbsp;B"'))}`,
      {
        refusal: UnsupportedDocumentError,
        message:
          "the document cannot be imported: it references the entity '&nbsp;'\nnote: XML does not predefine it and no DOCTYPE declares it, so Operaton's parse fails on it\nnote: BPMNscript would keep it as literal text",
      },
    ],
    [
      'a predefined entity, and anything inside a comment or a CDATA section, import',
      bpmnDefs`${process(
        ' isExecutable="true"',
        'p',
        `    <!-- <!DOCTYPE x> &nbsp; -->
    <bpmn:startEvent id="S" />
    <bpmn:scriptTask id="A" name="A &amp; B" scriptFormat="javascript">
      <bpmn:script><![CDATA[x = "&nbsp;" + "<!DOCTYPE"]]></bpmn:script>
    </bpmn:scriptTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="A" />
    <bpmn:sequenceFlow id="F2" sourceRef="A" targetRef="E" />`,
      )}`,
      { imports: 'p', warnings: [] },
    ],
    [
      'isSequential outside true/false refuses, naming the validating parse',
      bpmnDefs`${process(' isExecutable="true"', 'p', STEPS.replace('<bpmn:userTask id="A" />', '<bpmn:userTask id="A"><bpmn:multiInstanceLoopCharacteristics isSequential="yes" /></bpmn:userTask>'))}`,
      {
        refusal: UnsupportedDocumentError,
        message:
          "the document cannot be imported: isSequential is 'yes', which is neither 'true' nor 'false'\n" +
          "note: BPMNscript reads the schema's boolean\n" +
          "note: Operaton's validating parse ('Parse.execute' against 'BPMN20.xsd', which types 'isSequential' as 'xsd:boolean') refuses the deployment before 'BpmnParse' reads it",
      },
    ],
    [
      'an id written on two elements refuses, naming the id',
      bpmnDefs`${process(' isExecutable="true"', 'p', STEPS.replace('<bpmn:userTask id="A" />', '<bpmn:userTask id="A" />\n    <bpmn:userTask id="A" />'))}`,
      {
        refusal: UnsupportedDocumentError,
        message:
          "the document cannot be imported: the id 'A' is written on two elements\nnote: Operaton validates every file against 'BPMN20.xsd' and refuses a duplicate 'xs:ID'",
      },
    ],
    [
      'an id outside the ASCII alphabet this tool reads refuses, naming the id',
      bpmnDefs`${process(' isExecutable="true"', 'p', STEPS.replaceAll('"A"', '"Auftrag_prüfen"'))}`,
      {
        refusal: UnsupportedDocumentError,
        detail: "the id 'Auftrag_prüfen' is outside what BPMNscript reads",
        message:
          "the document cannot be imported: the id 'Auftrag_prüfen' is outside what BPMNscript reads\n" +
          "note: BPMNscript reads ASCII letters, digits, '_', '-' and '.', starting with a letter or '_'\n" +
          'note: the schema admits any letter\n' +
          'help: rename it',
      },
    ],
    [
      'a bpmn:import refuses, naming its type',
      bpmnDefs`  <bpmn:import importType="http://www.w3.org/2001/XMLSchema" location="types.xsd" namespace="http://test/types" />
${EXECUTABLE}`,
      {
        refusal: UnsupportedDocumentError,
        message:
          "the document cannot be imported: it declares a 'bpmn:import' of type 'http://www.w3.org/2001/XMLSchema'\nnote: 'BpmnParse.parseImports' fails the deployment on every import type but WSDL, and on WSDL without 'CxfWSDLImporter' on the classpath",
      },
    ],
    [
      'two signal roots sharing a name refuse, naming both',
      bpmnDefs`  <bpmn:signal id="Signal_1" name="Go" />
  <bpmn:signal id="Signal_2" name="Go" />
${EXECUTABLE}`,
      {
        refusal: UnsupportedEventFeatureError,
        message:
          "element 'Signal_2' cannot be imported: signal roots 'Signal_1' and 'Signal_2' both declare the name 'Go'\nnote: 'BpmnParse.parseSignals' fails the deployment on a duplicate signal name\nhelp: leave one root per signal name",
      },
    ],
    [
      'a process without an id refuses',
      bpmnDefs`${EXECUTABLE.replace('id="p" ', '')}`,
      {
        refusal: UnsupportedDocumentError,
        detail: 'its process has no id',
        message:
          'the document cannot be imported: its process has no id\n' +
          'note: Operaton deploys a process under its id as the definition key, and the deployment fails without one',
      },
    ],
    [
      'a document with no bpmn:process refuses, since there is nothing to import',
      bpmnDefs`  <bpmn:message id="M" name="Ping" />`,
      {
        refusal: UnsupportedDocumentError,
        detail: "it holds no 'bpmn:process'",
        message: "the document cannot be imported: it holds no 'bpmn:process'",
      },
    ],
    [
      'a start without an id imports in a process the engine does not deploy',
      bpmnDefs`${approval}\n${process(' isExecutable="false"', 'sketch', '    <bpmn:startEvent />')}`,
      { imports: 'approval', warnings: [twoPoolsWarnings[0]] },
    ],
    [
      'an empty process refuses, since parseStartEvents fails the deployment without a start',
      bpmnDefs`${process(' isExecutable="true"', 'p', '')}`,
      {
        refusal: UnsupportedEventFeatureError,
        message:
          "element 'p' cannot be imported: it has no start event\nnote: 'BpmnParse.parseStartEvents' fails the deployment on it (\"process must define a startEvent element\")\nhelp: add a start event and lead it to the first step",
      },
    ],
  ] as const)('%s', async (_title, xml, expected) => {
    if ('refusal' in expected) {
      const e = await expectRefusal(
        xmlToIr(xml),
        expected.refusal,
        'detail' in expected ? expected.detail : undefined,
      );
      expect(e.message).toBe(expected.message);
      return;
    }
    const { ir, warnings } = await xmlToIr(xml);
    expect(ir.id).toBe(expected.imports);
    expect(warnings).toEqual(expected.warnings);
  });

  it.each([
    [
      'a sequence flow imports under a minted id clear of every authored one',
      `    <bpmn:sequenceFlow sourceRef="S" targetRef="A" />
    <bpmn:sequenceFlow id="Flow_S_A" sourceRef="A" targetRef="E" />`,
      ['S', 'A', 'E'],
      ['Flow_S_A_2', 'Flow_S_A'],
      [],
    ],
    [
      "two tasks and an end event import under distinct minted ids, the end clear of the compiler's implicit end",
      `    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="A" />
    <bpmn:sequenceFlow id="F2" sourceRef="A" targetRef="E" />
    <bpmn:userTask />
    <bpmn:userTask />
    <bpmn:endEvent />`,
      ['S', 'A', 'E', 'UserTask_p', 'UserTask_p_2', 'EndEvent_p_2'],
      ['F1', 'F2'],
      ['UserTask_p', 'UserTask_p_2', 'EndEvent_p_2'],
    ],
    [
      "an end event imports clear of a boundary escape's implicit end, whose boundary id is the container's with a counter",
      `    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="A" />
    <bpmn:sequenceFlow id="F2" sourceRef="A" targetRef="E" />
    <bpmn:sequenceFlow id="F3" sourceRef="p_2" targetRef="E2" />
    <bpmn:endEvent id="E2" />
    <bpmn:boundaryEvent id="p_2" attachedToRef="A"><bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:endEvent />`,
      ['S', 'A', 'E', 'E2', 'p_2', 'EndEvent_p_3'],
      ['F1', 'F2', 'F3'],
      ['EndEvent_p_3'],
    ],
  ])(
    'an element without an id, which the engine deploys: %s',
    async (_title, content, nodes, flows, leftOut) => {
      const { ir, warnings } = await xmlToIr(
        bpmnDefs`${process(' isExecutable="true"', 'p', `    <bpmn:startEvent id="S" />\n    <bpmn:userTask id="A" />\n    <bpmn:endEvent id="E" />\n${content}`)}`,
      );
      // Nothing can flow into a node without an id, so the print leaves it out.
      const printed = irToDsl(ir);
      const { diagnostics } = await validate(printed.source);
      expect([
        ir.flowElements.map((n) => n.id),
        ir.sequenceFlows.map((f) => f.id),
        warnings,
        printed.warnings
          .filter((w) => w.category === 'unreachable')
          .map((w) => w.elementId),
        diagnostics,
      ]).toEqual([nodes, flows, [], leftOut, []]);
    },
  );

  const TIMER =
    '<bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition>';
  const LINEAR =
    '    <bpmn:startEvent id="S" />\n    <bpmn:userTask id="A" />\n    <bpmn:endEvent id="E" />\n';

  const DEPLOY = (method: string, quote = ''): string =>
    `note: '${method}' fails the deployment on it${quote}`;
  const RUN = (method: string, when: string): string =>
    `note: Operaton deploys it, and '${method}' fails the run ${when}`;
  const NO_ID = '("boundary event has no id")';
  const boundary = (def: string): string =>
    `${LINEAR}    <bpmn:boundaryEvent attachedToRef="A">${def}</bpmn:boundaryEvent>`;

  it.each([
    [
      'a lone start event',
      '    <bpmn:startEvent />',
      'startEvent',
      'p',
      DEPLOY('BpmnParse.parseStartFormHandlers'),
    ],
    [
      'a message start where the process has no plain start',
      `    <bpmn:startEvent><bpmn:messageEventDefinition messageRef="M1" /></bpmn:startEvent>
    <bpmn:startEvent id="S2"><bpmn:messageEventDefinition messageRef="M2" /></bpmn:startEvent>`,
      'startEvent',
      'p',
      DEPLOY('BpmnParse.parseStartFormHandlers'),
    ],
    [
      'a timer start',
      `    <bpmn:startEvent>${TIMER}</bpmn:startEvent>`,
      'startEvent',
      'p',
      DEPLOY('BpmnParse.parseTimer', ` ('Attribute "id" is required!')`),
    ],
    [
      'the start event of a subprocess',
      `${LINEAR}    <bpmn:subProcess id="Sub"><bpmn:startEvent /></bpmn:subProcess>`,
      'startEvent',
      'Sub',
      DEPLOY('HistoryParseListener.parseStartEvent'),
    ],
    [
      'the start event of an event sub-process',
      `${LINEAR}    <bpmn:subProcess id="ES" triggeredByEvent="true"><bpmn:startEvent><bpmn:messageEventDefinition messageRef="M1" /></bpmn:startEvent></bpmn:subProcess>`,
      'startEvent',
      'ES',
      DEPLOY('HistoryParseListener.parseStartEvent'),
    ],
    [
      'a timer boundary event',
      boundary(TIMER),
      'boundaryEvent',
      'p',
      DEPLOY('BpmnParse.parseTimer', ` ('Attribute "id" is required!')`),
    ],
    [
      'a message boundary event',
      boundary('<bpmn:messageEventDefinition messageRef="M1" />'),
      'boundaryEvent',
      'p',
      DEPLOY('BpmnParse.parseBoundaryMessageEventDefinition', ` ${NO_ID}`),
    ],
    [
      'a signal boundary event',
      boundary('<bpmn:signalEventDefinition />'),
      'boundaryEvent',
      'p',
      DEPLOY('BpmnParse.parseBoundarySignalEventDefinition', ` ${NO_ID}`),
    ],
    [
      'an error boundary event, which deploys but fails the run the error reaches',
      boundary('<bpmn:errorEventDefinition />'),
      'boundaryEvent',
      'p',
      RUN(
        'ErrorDeclarationForProcessInstanceFinder.isReThrowingErrorEventSubprocess',
        'when an error is thrown inside its step',
      ),
    ],
    [
      'an escalation boundary event, which deploys but fails the run the escalation reaches',
      `${LINEAR}    <bpmn:subProcess id="Sub"><bpmn:startEvent id="SS" /></bpmn:subProcess>
    <bpmn:boundaryEvent attachedToRef="Sub"><bpmn:escalationEventDefinition /></bpmn:boundaryEvent>`,
      'boundaryEvent',
      'p',
      RUN(
        'ExecutionEntity.generateActivityInstanceId',
        'when an escalation reaches it',
      ),
    ],
    [
      'a cancel boundary event, which deploys but fails the run that cancels the transaction',
      `${LINEAR}    <bpmn:transaction id="Tx"><bpmn:startEvent id="SS" /></bpmn:transaction>
    <bpmn:boundaryEvent attachedToRef="Tx"><bpmn:cancelEventDefinition /></bpmn:boundaryEvent>`,
      'boundaryEvent',
      'p',
      RUN(
        'ExecutionEntity.generateActivityInstanceId',
        'when the transaction is cancelled',
      ),
    ],
    [
      'a conditional boundary event, which deploys but fails the run of its step',
      boundary(
        '<bpmn:conditionalEventDefinition><bpmn:condition>go</bpmn:condition></bpmn:conditionalEventDefinition>',
      ),
      'boundaryEvent',
      'p',
      RUN('ConditionalEventHandler.handleEvent', 'of its step'),
    ],
    [
      'a timer catch event',
      `${LINEAR}    <bpmn:intermediateCatchEvent>${TIMER}</bpmn:intermediateCatchEvent>`,
      'intermediateCatchEvent',
      'p',
      DEPLOY('BpmnParse.parseTimer', ` ('Attribute "id" is required!')`),
    ],
    [
      'an event-based gateway',
      `${LINEAR}    <bpmn:eventBasedGateway />`,
      'eventBasedGateway',
      'p',
      DEPLOY('BpmnParse.parseEventBasedGateway'),
    ],
  ])(
    'an element without an id, which the engine refuses: %s',
    async (_title, content, tag, container, failure) => {
      const err = await expectRefusal(
        xmlToIr(
          bpmnDefs`  <bpmn:message id="M1" name="One" />
  <bpmn:message id="M2" name="Two" />
${process(' isExecutable="true"', 'p', content)}`,
        ),
        UnsupportedDocumentError,
        `a 'bpmn:${tag}' in '${container}' has no id`,
      );
      expect(err.message.split('\n').slice(1)).toEqual([
        failure,
        'help: give it an id',
      ]);
    },
  );

  const HERE = "without an id in 'p')";
  const ELEMENT = (tag: string): string => `(a 'bpmn:${tag}' ${HERE}`;
  it.each([
    [
      'a compensation boundary, which the engine runs, reaches the compensation refusal',
      boundary('<bpmn:compensateEventDefinition />'),
      UnsupportedEventFeatureError,
      `element ${ELEMENT('boundaryEvent')} cannot be imported`,
    ],
    [
      'a boundary with no trigger definition reaches the one-trigger refusal',
      boundary(''),
      UnsupportedEventFeatureError,
      `element ${ELEMENT('boundaryEvent')} cannot be imported`,
    ],
    [
      'a boundary inside a sub-process without an id names neither minted id',
      `${LINEAR}    <bpmn:subProcess><bpmn:startEvent id="SS" /><bpmn:userTask id="B" /><bpmn:boundaryEvent attachedToRef="B"><bpmn:compensateEventDefinition /></bpmn:boundaryEvent></bpmn:subProcess>`,
      UnsupportedEventFeatureError,
      "element (a 'bpmn:boundaryEvent' without an id) cannot be imported",
    ],
    [
      'a compensation handler',
      `${LINEAR}    <bpmn:userTask isForCompensation="true" />`,
      UnsupportedEventFeatureError,
      `element ${ELEMENT('userTask')} cannot be imported`,
    ],
    [
      'a link throw naming no link',
      `${LINEAR}    <bpmn:intermediateThrowEvent><bpmn:linkEventDefinition /></bpmn:intermediateThrowEvent>`,
      UnsupportedEventFeatureError,
      `element ${ELEMENT('intermediateThrowEvent')} cannot be imported`,
    ],
    [
      'a service task with no binding',
      `${LINEAR}    <bpmn:serviceTask />`,
      UnsupportedServiceTaskFormError,
      `service task ${ELEMENT('serviceTask')} uses an unsupported execution form`,
    ],
    [
      'two input parameters sharing a name',
      `${LINEAR}    <bpmn:userTask><bpmn:extensionElements><operaton:inputOutput><operaton:inputParameter name="a">1</operaton:inputParameter><operaton:inputParameter name="a">2</operaton:inputParameter></operaton:inputOutput></bpmn:extensionElements></bpmn:userTask>`,
      UnsupportedExtensionFormError,
      `the Operaton extension content on ${ELEMENT('userTask')} cannot be imported`,
    ],
    [
      'a call activity naming nothing to call',
      `${LINEAR}    <bpmn:callActivity />`,
      UnsupportedCallActivityError,
      `call activity ${ELEMENT('callActivity')} cannot be imported`,
    ],
  ] as const)(
    'an element without an id refused past the id check names no minted id: %s',
    async (_title, content, refusal, subject) => {
      const err = await expectRefusal(
        xmlToIr(operatonDefs`${process(' isExecutable="true"', 'p', content)}`),
        refusal,
      );
      const minted = /\b[A-Z][A-Za-z]*_(p|SubProcess_p)(_\d+)?\b/;
      expect([
        err.message.split(': ')[0],
        Object.values(err).filter(
          (v) => typeof v === 'string' && minted.test(v),
        ),
      ]).toEqual([subject, []]);
    },
  );
});

describe('xmlToIr: start, end, and emit triggers', () => {
  const MESSAGE_ROOT =
    '  <bpmn:message id="Message_1" name="OrderReceived" />\n';
  const MESSAGE_DEF =
    '<bpmn:messageEventDefinition id="md" messageRef="Message_1" />';

  interface EventXmlOptions {
    attrs?: string;
    roots?: string;
    defs?: typeof bpmnDefs;
  }

  const startTriggerXml = (
    definition: string,
    { attrs = '', roots = '', defs = bpmnDefs }: EventXmlOptions = {},
  ): string =>
    defs`${roots}  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="TStart" ${attrs}>
      ${definition}
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="TStart" targetRef="E" />
  </bpmn:process>`;

  const endTriggerXml = (
    definition: string,
    {
      attrs = '',
      roots = MESSAGE_ROOT,
      defs = operatonDefs,
    }: EventXmlOptions = {},
  ): string =>
    defs`${roots}  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="Typed" ${attrs}>
      ${definition}
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Typed" />
  </bpmn:process>`;

  const emitXml = (definition: string): string =>
    operatonDefs`${MESSAGE_ROOT}  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    <bpmn:intermediateThrowEvent id="Emit1">
      ${definition}
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Emit1" />
    <bpmn:sequenceFlow id="F2" sourceRef="Emit1" targetRef="E" />
  </bpmn:process>`;

  const sendDef = (attrs: string): string =>
    `<bpmn:messageEventDefinition id="md" messageRef="Message_1" ${attrs} />`;

  const messageDefWith = (attrs: string, children: string): string =>
    `<bpmn:messageEventDefinition id="md" messageRef="Message_1" ${attrs}>
        <bpmn:extensionElements>
${children}
        </bpmn:extensionElements>
      </bpmn:messageEventDefinition>`;

  const IGNORED = [
    'note: Operaton ignores the trigger and starts the process as if none were written',
    'note: importing it would write back a document the engine runs differently from what it says',
  ];
  const subWith = (tag: string, content: string): string =>
    bpmnDoc`    <bpmn:startEvent id="S" />
    <${tag} id="Sub">
${content}
    </${tag}>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />`;

  it.each([
    [
      'a start on an error, which Operaton ignores',
      startTriggerXml('<bpmn:errorEventDefinition id="d" />'),
      'TStart',
      'a process cannot start on an error',
      [
        ...IGNORED,
        "help: catch it with 'on error' inside the scope that raises it",
      ],
    ],
    [
      'a start on an escalation, which Operaton ignores',
      startTriggerXml('<bpmn:escalationEventDefinition id="d" />'),
      'TStart',
      'a process cannot start on an escalation',
      [
        ...IGNORED,
        "help: catch it with 'on escalation' inside the scope that raises it",
      ],
    ],
    [
      'a start on compensation, which Operaton ignores',
      startTriggerXml('<bpmn:compensateEventDefinition id="d" />'),
      'TStart',
      'a process cannot start on compensation',
      [
        ...IGNORED,
        "help: compensation undoes a subprocess's completed work, so put it in an 'on compensation' block inside that subprocess",
      ],
    ],
    [
      'a message start whose message name embeds an expression',
      startTriggerXml(MESSAGE_DEF, {
        roots: '  <bpmn:message id="Message_1" name="Order-${type}" />\n',
      }),
      'TStart',
      "the message name 'Order-${type}' of a message start event is an expression",
      [
        'note: Operaton rejects an expression there, because a process that has not started yet has no variables to evaluate it against',
        'help: give the message a fixed name',
      ],
    ],
    [
      'two plain starts in a process, which selectInitial fails the deployment on',
      bpmnDefs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S1" />
    <bpmn:startEvent id="S2" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S1" targetRef="E" />
    <bpmn:sequenceFlow id="F2" sourceRef="S2" targetRef="E" />
  </bpmn:process>`,
      'S2',
      "the process 'p' has 2 plain or timer starts",
      [
        'note: \'BpmnParse.selectInitial\' fails the deployment on it ("multiple none start events or timer start events not supported on process definition")',
        'help: leave one plain or timer start, and give the others a message, signal or condition trigger',
      ],
    ],
    [
      'two starts in a subprocess',
      subWith(
        'bpmn:subProcess',
        `      <bpmn:startEvent id="S1" />
      <bpmn:startEvent id="S2" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="S1" targetRef="SubEnd" />`,
      ),
      'Sub',
      'it has 2 start events',
      [
        'note: BPMNscript writes one entry point per subprocess or transaction, so a second start has nowhere to go',
        'help: leave one start and connect the steps that followed the others onto it',
      ],
    ],
    [
      'a trigger on the start of a subprocess',
      oneNodeDoc('subProcess', {
        id: 'Sub',
        doc: bpmnDoc,
        children: `<bpmn:startEvent id="SubStart"><bpmn:timerEventDefinition /></bpmn:startEvent>
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="SubEnd" />`,
      }),
      'SubStart',
      'a subprocess cannot start on a trigger',
      [
        'note: Operaton rejects one there when it parses the file',
        'note: a subprocess is entered from the surrounding process, not by an event of its own',
        "help: put the trigger on an 'on' handler inside the subprocess if it should react to an event",
      ],
    ],
    [
      'a connector on a message end, the element form of the send',
      endTriggerXml(
        messageDefWith(
          '',
          `          <operaton:connector>
            <operaton:connectorId>http-connector</operaton:connectorId>
          </operaton:connector>`,
        ),
      ),
      'Typed',
      'a thrown message carries a connector',
      [
        'note: the connector is what makes the engine really send it, and BPMNscript has no place to keep it',
        ...THROWN_MESSAGE_FORMS,
      ],
    ],
    [
      'a class with a resultVariable on an emit, quoting the engine',
      emitXml(
        sendDef(
          'operaton:class="com.example.Send" operaton:resultVariable="r"',
        ),
      ),
      'Emit1',
      "its message definition binds a Java class with a result variable ('operaton:class', 'operaton:resultVariable')",
      [
        "note: Operaton refuses to deploy it with \"'resultVariableName' not supported for intermediateMessageThrowEvent elements using 'class'\" ('BpmnParse.parseServiceTaskLike')",
      ],
    ],
    [
      'an expression with a resultVariable on a message end, whose value the engine stores',
      endTriggerXml(
        sendDef(
          'operaton:expression="${sender.send()}" operaton:resultVariable="r"',
        ),
      ),
      'Typed',
      "its message definition binds an expression with a result variable ('operaton:expression', 'operaton:resultVariable=\"r\"')",
      [
        "note: 'BpmnParse.parseServiceTaskLike' stores the expression's value under it ('ServiceTaskExpressionActivityBehavior')",
        'note: a thrown message in BPMNscript takes no result variable, so dropping it would change what runs',
      ],
    ],
  ])('%s refuses', async (_title, xml, elementId, detail, notes) => {
    await expectEventRefusal(xml, elementId, detail, notes);
  });

  it('a bpmn:transaction with no start event imports and warns that the engine fails it on entry', async () => {
    const { ir, warnings } = await xmlToIr(
      subWith(
        'bpmn:transaction',
        `      <bpmn:userTask id="In" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="In" targetRef="SubEnd" />`,
      ),
    );
    expect(subProcess(ir, 'Sub').flowElements.map((fe) => fe.id)).toEqual([
      'In',
      'SubEnd',
    ]);
    expect(warnings).toEqual([
      {
        elementId: 'Sub',
        category: 'behaviourChanged',
        message:
          "transaction 'Sub' has no start event\n" +
          'note: Operaton deploys it, and \'SubProcessActivityBehavior.execute\' fails on entering it ("No initial activity found")\n' +
          'note: the printed script adds a start, so the imported block runs',
      },
    ]);
  });

  const EVENT_PROPERTIES = `<bpmn:extensionElements>
        <operaton:properties>
          <operaton:property name="k" value="v" />
        </operaton:properties>
      </bpmn:extensionElements>
      `;

  const neverWritten = (attr: string, binding: string): string =>
    `setting '${attr}' on 'Typed' was not imported\n` +
    "note: 'BpmnParse.parseServiceTaskLike' hands it to an expression " +
    `binding alone, so ${binding} never writes it`;

  const readOffThrow = (what: string, carrier: string): string =>
    `${what} on 'Typed' was not imported\n` +
    `note: 'BpmnParse.parseExternalServiceTask' reads it off ${carrier} of a ` +
    `thrown message bound with 'operaton:type="external"'\n` +
    'note: the throw in BPMNscript has no position for it, so the rebuilt ' +
    'document runs without it';

  const neverReadOnThrow = (what: string): string =>
    `${what} on 'Typed' was not imported\n` +
    "note: Operaton reads it in 'parseExternalServiceTask' alone, which " +
    `only a thrown message bound with 'operaton:type="external"' reaches\n` +
    'note: the event runs as written without it';

  const throwOnly = (what: string): string =>
    `${what} on 'TStart' was not imported\n` +
    "note: it only takes effect on a throw ('throw message' or 'emit " +
    "message'), and has no effect on a catch";

  const FIELD_HOME =
    'BPMNscript carries an injected field on the step or the listener ' +
    'whose class or delegate binding receives it, on the step whose ' +
    'built-in mail or shell behaviour does, and on no other position';

  const ERROR_ROOTS =
    MESSAGE_ROOT + '  <bpmn:error id="Error_X" errorCode="X" />\n';

  it.each([
    {
      case: 'a message emit carries its implementation',
      xml: emitXml(sendDef('operaton:delegateExpression="${sender}"')),
      id: 'Emit1',
      binding: delegateBinding('${sender}'),
      warnings: [],
    },
    {
      case: 'a topic with no external type names no worker and is dropped',
      xml: endTriggerXml(sendDef('operaton:topic="send-ack"')),
      id: 'Typed',
      binding: undefined,
      warnings: [
        "setting 'topic' on 'Typed' was not imported\n" +
          'note: it only takes effect alongside \'operaton:type="external"\', and on its own names no external worker',
      ],
    },
    {
      case: 'a result variable beside an external type is dropped: the type branch never writes it',
      xml: endTriggerXml(
        sendDef(
          'operaton:type="external" operaton:topic="send-ack" operaton:resultVariable="r"',
        ),
      ),
      id: 'Typed',
      binding: externalBinding('send-ack'),
      warnings: [
        neverWritten('resultVariable', `an 'operaton:type="external"' binding`),
      ],
    },
    {
      case: 'a result variable on a definition naming no implementation is dropped: nothing runs to write it',
      xml: endTriggerXml(sendDef('operaton:resultVariableName="r"')),
      id: 'Typed',
      binding: undefined,
      warnings: [
        neverWritten(
          'resultVariableName',
          'a definition naming no implementation',
        ),
      ],
    },
    {
      case: 'a field beside a class is dropped, naming the definition the engine reads it off',
      xml: endTriggerXml(
        messageDefWith(
          'operaton:class="com.example.Send"',
          '          <operaton:field name="to" stringValue="ops" />',
        ),
      ),
      id: 'Typed',
      binding: classBinding('com.example.Send'),
      warnings: [
        "injected field 'to' on the message definition of 'Typed' was not imported\n" +
          `note: ${FIELD_HOME}\n` +
          "note: 'BpmnParse.parseServiceTaskLike' reads it off the definition " +
          'into the class it names, so the rebuilt document runs that without it',
      ],
    },
    {
      case: 'a field beside an expression is dropped: the engine injects into a class or a delegate alone',
      xml: endTriggerXml(
        messageDefWith(
          'operaton:expression="${sender.send()}"',
          '          <operaton:field name="to" stringValue="ops" />',
        ),
      ),
      id: 'Typed',
      binding: exprBinding('${sender.send()}'),
      warnings: [
        "injected field 'to' on the message definition of 'Typed' was not imported\n" +
          `note: ${FIELD_HOME}\n` +
          'note: Operaton injects a field into a class or a delegate binding and into no other',
      ],
    },
    {
      case: 'a task priority and a property list beside an external type are two engine-read drops',
      xml: endTriggerXml(
        EVENT_PROPERTIES +
          sendDef(
            'operaton:type="external" operaton:topic="send-ack" operaton:taskPriority="7"',
          ),
      ),
      id: 'Typed',
      binding: externalBinding('send-ack'),
      warnings: [
        readOffThrow("setting 'taskPriority'", 'the message definition'),
        readOffThrow("'operaton:properties' block", 'the event element'),
      ],
    },
    {
      case: 'the three extras beside a class are each a setting the engine never reads there',
      xml: endTriggerXml(
        EVENT_PROPERTIES +
          messageDefWith(
            'operaton:class="com.example.Send" operaton:taskPriority="7"',
            '          <operaton:errorEventDefinition id="Map_1" errorRef="Error_X" expression="${true}" />',
          ),
        { roots: ERROR_ROOTS },
      ),
      id: 'Typed',
      binding: classBinding('com.example.Send'),
      warnings: [
        neverReadOnThrow("setting 'taskPriority'"),
        neverReadOnThrow("'operaton:errorEventDefinition' named 'Map_1'"),
        neverReadOnThrow("'operaton:properties' block"),
      ],
    },
    {
      case: 'the extras on a caught message are throw-only settings, one warning each',
      xml: startTriggerXml(
        messageDefWith(
          'operaton:taskPriority="7" operaton:resultVariable="r"',
          '          <operaton:field name="to" stringValue="ops" />\n' +
            '          <operaton:errorEventDefinition id="Map_1" errorRef="Error_X" expression="${true}" />',
        ),
        { roots: ERROR_ROOTS, defs: operatonDefs },
      ),
      id: 'TStart',
      binding: undefined,
      warnings: [
        throwOnly("setting 'taskPriority'"),
        throwOnly("setting 'resultVariable'"),
        throwOnly("'operaton:field' named 'to'"),
        throwOnly("'operaton:errorEventDefinition' named 'Map_1'"),
      ],
    },
  ])('$case', async ({ xml, id, binding, warnings: expected }) => {
    const { ir, warnings } = await xmlToIr(xml);
    const node = byId(ir, id);
    expect('binding' in node ? node.binding : undefined).toEqual(binding);
    expect(warnings.map((w) => w.message)).toEqual(expected);
  });
});

describe('xmlToIr: imports a repetition', () => {
  const repeat = (attrs = '', children = ''): string =>
    `<bpmn:multiInstanceLoopCharacteristics ${attrs}>${children}</bpmn:multiInstanceLoopCharacteristics>`;

  const repeatedTaskDoc = (attrs = '', children = ''): string =>
    oneNodeDoc('userTask', { children: repeat(attrs, children) });

  const on = (category: ImportWarning['category'], message: string) => ({
    elementId: 'T',
    category,
    message,
  });

  const both = (pair: string, rule: string, kept: string, dropped: string) =>
    on(
      'extensionAttribute',
      pair.replace(' name ', ` on 'T' both name `) +
        `, and '${dropped}' was dropped\nnote: ${rule}\nnote: '${kept}' was imported`,
    );

  const unreadOnRepetition = (what: string): string =>
    `${what} on the repetition of 'T' was not imported\n` +
    'note: Operaton does not read it, so the imported process runs the same';

  it.each<[string, string, string, object, unknown[]]>([
    [
      'isSequential="true" imports the runs as sequential',
      'operaton:collection="lines" isSequential="true"',
      '',
      { collection: 'lines', sequential: true },
      [],
    ],
    [
      'operaton:collection and bpmn:loopDataInputRef spelling two variable names import the second',
      'operaton:collection="items"',
      '<bpmn:loopDataInputRef>lines</bpmn:loopDataInputRef>',
      { collection: 'lines' },
      [
        both(
          "'operaton:collection' and 'bpmn:loopDataInputRef' name the collection",
          "'parseMultiInstanceLoopCharacteristics' writes both into the same field, and 'bpmn:loopDataInputRef' second",
          'lines',
          'items',
        ),
      ],
    ],
    [
      'an expression collection outranks a bpmn:loopDataInputRef variable name',
      'operaton:collection="${items}"',
      '<bpmn:loopDataInputRef>lines</bpmn:loopDataInputRef>',
      { collection: '${items}' },
      [
        both(
          "'operaton:collection' and 'bpmn:loopDataInputRef' name the collection",
          "'parseMultiInstanceLoopCharacteristics' stores an expression (a value " +
            "containing '{') and a variable name in two fields, and " +
            "'MultiInstanceActivityBehavior.resolveNrOfInstances' reads the expression " +
            'field first',
          '${items}',
          'lines',
        ),
      ],
    ],
    [
      'a bpmn:inputDataItem shadows operaton:elementVariable',
      'operaton:collection="lines" operaton:elementVariable="item"',
      '<bpmn:inputDataItem id="Item" name="line" />',
      { collection: 'lines', elementVariable: 'line' },
      [
        both(
          "'bpmn:inputDataItem' and 'operaton:elementVariable' name what each run sees",
          "'parseMultiInstanceLoopCharacteristics' writes both into the same field, and 'bpmn:inputDataItem' second",
          'line',
          'item',
        ),
      ],
    ],
    [
      'a bare bpmn:completionCondition carrying a language imports the text, warning about each thing the engine does with it',
      'operaton:collection="lines"',
      '<bpmn:completionCondition language="groovy">nrOfCompletedInstances &gt; 1</bpmn:completionCondition>',
      {
        collection: 'lines',
        completionCondition: 'nrOfCompletedInstances > 1',
      },
      [
        on(
          'behaviourChanged',
          "'bpmn:completionCondition' on 'T' is the bare text 'nrOfCompletedInstances > 1' and is rewritten as an expression\n" +
            "note: it has no '${...}' or '#{...}' opener\n" +
            "note: 'parseMultiInstanceLoopCharacteristics' hands it to 'createExpression' as a literal, and 'MultiInstanceActivityBehavior.completionConditionSatisfied' throws 'expressionNotBooleanException' when the first run completes\n" +
            "note: the script writes it inside '${...}', which evaluates it",
        ),
        on(
          'unmappedConstruct',
          "'language=\"groovy\"' on the 'bpmn:completionCondition' of 'T' was not imported\n" +
            "note: 'parseMultiInstanceLoopCharacteristics' hands the text alone to 'createExpression' and reads no language\n" +
            'note: the imported step runs the same',
        ),
      ],
    ],
    [
      'the older async spelling on the loop element carries asyncBefore and names the respelling',
      'operaton:collection="lines" operaton:async="true"',
      '',
      { collection: 'lines', asyncBefore: true },
      [on('rewritten', asyncRespellingMessage("the repetition of 'T'"))],
    ],
    ...(
      [
        [
          'a bpmn:loopDataOutputRef',
          '',
          '<bpmn:loopDataOutputRef>results</bpmn:loopDataOutputRef>',
          unreadOnRepetition("'bpmn:loopDataOutputRef'"),
        ],
        [
          'behavior="One"',
          'behavior="One"',
          '',
          unreadOnRepetition(`'behavior="One"'`),
        ],
        [
          'an operaton:jobPriority',
          'operaton:jobPriority="10"',
          '',
          unreadOnRepetition("'operaton:jobPriority'"),
        ],
        [
          'an attribute BPMN does not declare',
          'bogus="x"',
          '',
          "attribute 'bogus' on 'T' was not imported\n" +
            'note: BPMN does not declare it\n' +
            'note: BPMNscript imports the executable flow and the engine settings on its steps, and nothing declared or drawn beside it',
        ],
      ] as const
    ).map(
      ([what, attrs, children, message]): [
        string,
        string,
        string,
        object,
        unknown[],
      ] => [
        `${what} on the repetition is reported as dropped`,
        `operaton:collection="lines" ${attrs}`,
        children,
        { collection: 'lines' },
        [on('unmappedConstruct', message)],
      ],
    ),
  ])('%s', async (_title, attrs, children, loop, expected) => {
    const { node, warnings } = await importOnly(
      repeatedTaskDoc(attrs, children),
      'userTask',
    );
    expect(node.loop).toEqual(loop);
    expect(warnings).toEqual(expected);
  });

  it.each([
    [
      'neither a count nor a collection',
      repeatedTaskDoc(),
      'it sets neither a number of runs nor a collection to run over',
      'Operaton refuses to deploy that',
    ],
    [
      'an empty bpmn:loopCardinality',
      repeatedTaskDoc('', '<bpmn:loopCardinality />'),
      "its 'bpmn:loopCardinality' is empty",
      'Operaton has no number of runs to read',
    ],
    [
      'a fractional bpmn:loopCardinality',
      repeatedTaskDoc('', '<bpmn:loopCardinality>3.5</bpmn:loopCardinality>'),
      "its 'bpmn:loopCardinality' is '3.5', which BPMNscript cannot write back unchanged",
      'BPMNscript writes a count as a plain whole number or as an expression, and this body is neither',
    ],
    [
      'an element variable with no collection',
      repeatedTaskDoc(
        'operaton:elementVariable="line"',
        '<bpmn:loopCardinality>3</bpmn:loopCardinality>',
      ),
      "it names 'line' for each run to see but no collection to take it from",
      'Operaton refuses to deploy that',
    ],
    [
      'a bpmn:inputDataItem name outside the identifier the clause writes',
      repeatedTaskDoc(
        'operaton:collection="lines"',
        '<bpmn:inputDataItem id="Item" name="my var" />',
      ),
      "it names 'my var' for each run to see, which BPMNscript cannot write back unchanged",
      'BPMNscript writes that name as a plain identifier, and this name is not one',
    ],
    [
      'an element variable named by a keyword',
      repeatedTaskDoc(
        'operaton:collection="lines" operaton:elementVariable="var"',
      ),
      "it names 'var' for each run to see, which BPMNscript cannot write back unchanged",
      'BPMNscript writes that name as a plain identifier, and this name is not one',
    ],
    [
      'an operaton:outputParameter on a repeated step',
      oneNodeDoc('userTask', {
        children: `${extensionElements(
          `        <operaton:inputOutput>
          <operaton:outputParameter name="result">ok</operaton:outputParameter>
        </operaton:inputOutput>`,
        )}${repeat('operaton:collection="lines"')}`,
      }),
      "it maps an 'operaton:outputParameter'",
      '\'BpmnParse.checkActivityOutputParameterSupported\' fails the deployment on it ("operaton:outputParameter not allowed for multi-instance constructs")',
    ],
  ])('%s is refused', async (_title, xml, detail, note) => {
    const e = await expectRefusal<UnsupportedLoopCharacteristicsError>(
      xmlToIr(xml),
      UnsupportedLoopCharacteristicsError,
      detail,
    );
    expect([e.elementId, e.loopType, e.message]).toEqual([
      'T',
      'bpmn:MultiInstanceLoopCharacteristics',
      `repetition on 'T' cannot be imported: ${detail}\nnote: ${note}`,
    ]);
  });

  const loopedHandler = (loop: string, roots = ''): string =>
    handlerDoc(
      '<bpmn:signalEventDefinition id="SigDef" signalRef="Signal_Escalate" />',
      { roots },
    ).replace(
      '<bpmn:subProcess id="Handler" triggeredByEvent="true">',
      `<bpmn:subProcess id="Handler" triggeredByEvent="true">\n      ${loop}`,
    );

  it('an event handler carrying a multi-instance repetition is refused', async () => {
    const e = await expectRefusal(
      xmlToIr(
        loopedHandler(
          repeat('', '<bpmn:loopCardinality>2</bpmn:loopCardinality>'),
        ),
      ),
      UnsupportedLoopCharacteristicsError,
      'an event handler cannot be repeated',
    );
    expect(e.message).toBe(
      "repetition on 'Handler' cannot be imported: an event handler cannot be repeated\n" +
        'note: an event handler is entered by its trigger',
    );
  });

  it('an event handler carrying a standard loop imports as a step that runs once, same as any other host', async () => {
    const { ir, warnings } = await xmlToIr(
      loopedHandler(
        '<bpmn:standardLoopCharacteristics />',
        '  <bpmn:signal id="Signal_Escalate" name="Escalate" />\n',
      ),
    );
    expect(subProcess(ir, 'Handler').loop).toBeUndefined();
    expect(warnings).toEqual([
      {
        elementId: 'Handler',
        category: 'unmappedConstruct',
        message:
          "'bpmn:standardLoopCharacteristics' on 'Handler' was not imported\n" +
          'note: Operaton does not run one at all, it deploys the step and runs it once\n' +
          'note: the imported step runs once too',
      },
    ]);
  });
});

describe('xmlToIr: a #{...} body the printer spells bare is rebuilt inside ${...}, and says so', () => {
  const loopDoc = (children: string): string =>
    oneNodeDoc('userTask', {
      children: `<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines">${children}</bpmn:multiInstanceLoopCharacteristics>`,
    });

  const rewrapped = (slot: string, id: string): string =>
    `'${slot}' on '${id}' is rewritten from '#{...}' to '\${...}'\n` +
    'note: the script prints its body as bare DSL, and the rebuilt ' +
    "document writes it inside '${...}'\n" +
    'note: Operaton evaluates both the same';

  it('a loop cardinality reports the rewrap', async () => {
    const { warnings } = await xmlToIr(
      loopDoc('<bpmn:loopCardinality>#{lineCount}</bpmn:loopCardinality>'),
    );
    expect(warnings).toEqual([
      {
        elementId: 'T',
        category: 'rewritten',
        message: rewrapped('bpmn:loopCardinality', 'T'),
      },
    ]);
  });
});

describe('xmlToIr: a scripted condition on a sequence flow or a conditional event definition', () => {
  const flowDoc = (
    conditionAttrs: string,
    body = '${amount &gt; 1000}',
    flowAttrs = '',
    plainFlowAttrs = '',
  ): string =>
    operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:exclusiveGateway id="X" />
    <bpmn:userTask id="T" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="X" />
    <bpmn:sequenceFlow id="F2" sourceRef="X" targetRef="T" ${flowAttrs}>
      <bpmn:conditionExpression ${conditionAttrs}>${body}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F3" sourceRef="X" targetRef="E" ${plainFlowAttrs} />
    <bpmn:sequenceFlow id="F4" sourceRef="T" targetRef="E" />`;
  const conditionOf = (ir: BpmnProcess): string | undefined =>
    ir.sequenceFlows.find((f) => f.id === 'F2')?.conditionExpression;
  const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

  const boundaryConditionDoc = (conditionAttrs: string): string =>
    operatonDoc`    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Owner" attachedToRef="Review">
      <bpmn:conditionalEventDefinition id="CondDef">
        <bpmn:condition ${conditionAttrs}>amount &gt; 1000</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />`;

  const TEXPRESSION =
    'note: \'BpmnParse.parseConditionExpression\' fails the deployment on it ("Invalid type, only tFormalExpression is currently supported")';

  it.each([
    [
      'an unprefixed xsi:type dropped by moddle still reads language and resource, since parseConditionExpression resolves it against BPMN20_NS regardless',
      flowDoc(
        `xsi:type="tFormalExpression" ${XSI} language="groovy" operaton:resource="deployment://check.groovy"`,
      ),
      'F2',
      'it declares \'language="groovy"\' with \'operaton:resource="deployment://check.groovy"\'',
      'note: Operaton runs that deployed script rather than the body written here',
    ],
    [
      'xsi:type="bpmn:tExpression" fails the deployment',
      flowDoc(`xsi:type="bpmn:tExpression" ${XSI}`),
      'F2',
      'it is typed \'xsi:type="bpmn:tExpression"\'',
      TEXPRESSION,
    ],
    [
      'an unprefixed xsi:type="tExpression" in a bpmn:-prefixed document, which moddle drops before any reader sees it, fails the deployment',
      flowDoc(`xsi:type="tExpression" ${XSI}`),
      'F2',
      'it is typed \'xsi:type="tExpression"\'',
      TEXPRESSION,
    ],
    [
      'a language on a boundary conditional event hands it to a script engine',
      boundaryConditionDoc('language="groovy"'),
      'Owner',
      'it declares \'language="groovy"\'',
      'note: Operaton runs it in a script engine rather than evaluating it as UEL',
    ],
  ])('%s, and refuses', async (_title, xml, elementId, detail, note) => {
    const e = await expectRefusal<UnsupportedConditionExpressionError>(
      xmlToIr(xml),
      UnsupportedConditionExpressionError,
      detail,
    );
    expect([e.elementId, e.message]).toEqual([
      elementId,
      [
        `condition on '${elementId}' cannot be imported: ${detail}`,
        note,
        "note: BPMNscript writes a condition as a 'tFormalExpression', which Operaton evaluates as UEL",
        'note: a condition of another type, or one Operaton hands to a script engine, has no spelling in BPMNscript',
      ].join('\n'),
    ]);
  });

  it('a lone operaton:resource on a boundary conditional event warns that it takes effect only beside a language', async () => {
    const { warnings } = await xmlToIr(
      boundaryConditionDoc('operaton:resource="deployment://check.groovy"'),
    );
    expect(warnings).toEqual([
      {
        elementId: 'Owner',
        category: 'extensionAttribute',
        message:
          "setting 'operaton:resource' on 'Owner' was not imported\n" +
          "note: it only takes effect alongside a 'language' attribute\n" +
          'note: on its own the condition runs as the expression written in the body',
      },
    ]);
  });

  const EMPTY_BODY =
    "condition on 'F2' has an empty body and was dropped\n" +
    'note: \'UelExpressionCondition.evaluate\' reads it as a string and fails the flow on every run ("condition expression returns non-Boolean")\n' +
    'note: the flow was imported with no condition';

  it.each([
    [
      'an unprefixed xsi:type="tFormalExpression" in a bpmn:-prefixed document, which moddle drops and parseConditionExpression resolves against BPMN20_NS, imports as the formal expression the engine reads',
      flowDoc(`xsi:type="tFormalExpression" ${XSI}`),
      '${amount > 1000}',
      undefined,
    ],
    [
      'an unprefixed xsi:type="tFormalExpression" in a default-namespace document imports as the formal expression the engine reads',
      `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ${XSI} targetNamespace="http://test">
  <process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <startEvent id="S" />
    <exclusiveGateway id="X" />
    <userTask id="T" />
    <endEvent id="E" />
    <sequenceFlow id="F1" sourceRef="S" targetRef="X" />
    <sequenceFlow id="F2" sourceRef="X" targetRef="T">
      <conditionExpression xsi:type="tFormalExpression">\${amount &gt; 1000}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="F3" sourceRef="X" targetRef="E" />
    <sequenceFlow id="F4" sourceRef="T" targetRef="E" />
  </process>
</definitions>`,
      '${amount > 1000}',
      undefined,
    ],
    [
      'a body with no "${" or "#{" opener is rewrapped, since the engine fails the flow on every run',
      flowDoc(`xsi:type="bpmn:tFormalExpression" ${XSI}`, 'amount &gt; 1000'),
      'amount > 1000',
      "condition on 'F2' is the bare text 'amount > 1000' and is rewritten as an expression\n" +
        "note: it has no '${...}' or '#{...}' opener\n" +
        'note: \'UelExpressionCondition.evaluate\' reads it as a string and fails the flow on every run ("condition expression returns non-Boolean")\n' +
        "note: the script writes it inside '${...}', which evaluates it",
    ],
    [
      'an empty body is dropped, since the engine fails the flow on every run',
      flowDoc(`xsi:type="bpmn:tFormalExpression" ${XSI}`, ''),
      undefined,
      EMPTY_BODY,
    ],
    [
      'a whitespace-only body recovered past moddle, as moddle imports one, is dropped the same',
      flowDoc(`xsi:type="tFormalExpression" ${XSI}`, '   '),
      undefined,
      EMPTY_BODY,
    ],
  ])('%s', async (_title, xml, imported, message) => {
    const { ir, warnings } = await xmlToIr(xml);
    expect(conditionOf(ir)).toBe(imported);
    expect(warnings).toEqual(
      message === undefined
        ? []
        : [{ elementId: 'F2', category: 'behaviourChanged', message }],
    );
  });

  it.each([
    [
      'a conditioned flow named other than its condition text',
      'name="yes"',
      '',
      [
        {
          elementId: 'F2',
          category: 'label',
          message:
            "name 'yes' on the flow 'F2' was not imported\n" +
            'note: the script has no label for a flow\n' +
            "note: the rebuilt document names this flow by its condition ('amount > 1000')",
        },
      ],
    ],
    [
      'an unconditioned flow named at all',
      '',
      'name="no"',
      [
        {
          elementId: 'F3',
          category: 'label',
          message:
            "name 'no' on the flow 'F3' was not imported\n" +
            'note: the script has no label for a flow\n' +
            'note: the rebuilt document leaves this flow unnamed',
        },
      ],
    ],
  ])(
    '%s reports the label only when the rebuilt document would lose it',
    async (_title, flowAttrs, plainFlowAttrs, expected) => {
      const { warnings } = await xmlToIr(
        flowDoc('', '${amount &gt; 1000}', flowAttrs, plainFlowAttrs),
      );
      expect(warnings).toEqual(expected);
    },
  );
});

describe('xmlToIr: warns for dropped extension attributes', () => {
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

  const headerDoc = (
    processAttrs: string,
    startAttrs = '',
    startId = 'S',
  ): string =>
    operatonDefs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE} ${processAttrs}>
    <bpmn:startEvent id="${startId}" ${startAttrs} />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="${startId}" targetRef="E" />
  </bpmn:process>`;

  it.each([
    ['an authored history time to live is kept', 'P90D', 'P90D', []],
    [
      'the exported default is kept like any authored value',
      HISTORY_TIME_TO_LIVE,
      HISTORY_TIME_TO_LIVE,
      [],
    ],
    [
      'an absent history time to live warns that the rebuilt process deploys',
      undefined,
      undefined,
      [
        {
          elementId: 'p',
          category: 'behaviourChanged',
          message:
            "process 'p' sets no 'historyTimeToLive' and is written back with 'P30D'\n" +
            "note: 'HistoryTimeToLiveParser.parseAndValidate' refuses a process without it under the engine's default 'enforceHistoryTimeToLive'\n" +
            'note: the rebuilt process deploys where the original did not',
        },
      ],
    ],
  ])('%s', async (_title, authored, expected, expectedWarnings) => {
    const { ir, warnings } = await xmlToIr(
      operatonDefs`  <bpmn:process id="p" isExecutable="true"${authored === undefined ? '' : ` operaton:historyTimeToLive="${authored}"`}>
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`,
    );
    expect([ir.historyTimeToLive, warnings]).toEqual([
      expected,
      expectedWarnings,
    ]);
  });

  it('isStartableInTasklist imports as BpmnParse.isStartable reads it, true only for a case-insensitive "true"', async () => {
    const read = async (value: string) =>
      (await xmlToIr(headerDoc(`operaton:isStartableInTasklist="${value}"`))).ir
        .isStartableInTasklist;
    expect(
      await Promise.all(['TRUE', 'true', 'false', 'no'].map(read)),
    ).toEqual([true, true, false, false]);
  });

  const starterDoc = (processAttrs: string, children: string): string =>
    operatonDefs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE} ${processAttrs}>
    <bpmn:extensionElements>
${children}
    </bpmn:extensionElements>
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;
  const potentialStarter = (expression?: string): string =>
    `      <operaton:potentialStarter>${
      expression === undefined
        ? ''
        : `
        <bpmn:resourceAssignmentExpression>
          <bpmn:formalExpression>${expression}</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>`
    }
      </operaton:potentialStarter>`;

  it.each([
    {
      title:
        'an operaton:potentialStarter lands on the two header settings ahead of the attributes, as parseStartAuthorization builds its lists',
      processAttrs:
        'operaton:candidateStarterUsers="demo" operaton:candidateStarterGroups="ops"',
      children: potentialStarter('user(a), user(b), group(g), h'),
      header: {
        candidateStarterUsers: 'a,b,demo',
        candidateStarterGroups: 'g,h,ops',
      },
      warnings: [
        [
          'rewritten',
          'p',
          "'operaton:potentialStarter' on 'p' imports as 'candidateStarterUsers: \"a,b\"' and 'candidateStarterGroups: \"g,h\"'\n" +
            "note: Operaton reads its formal expression that way ('BpmnParse.parsePotentialStarterResourceAssignment')\n" +
            "note: BPMNscript writes it back as 'operaton:candidateStarterUsers' and 'operaton:candidateStarterGroups', which the engine reads the same",
        ],
      ],
    },
    {
      title:
        'an operaton:potentialStarter with no formal expression is dropped, saying the engine reads nothing else',
      processAttrs: '',
      children: potentialStarter(),
      header: {},
      warnings: [
        [
          'unmappedConstruct',
          'p',
          "'operaton:potentialStarter' on 'p' was not imported\n" +
            "note: it carries no formal expression, and Operaton reads nothing else off it ('BpmnParse.parsePotentialStarterResourceAssignment')",
        ],
      ],
    },
  ])(
    '$title',
    async ({ processAttrs, children, header, warnings: expected }) => {
      const { ir, warnings } = await xmlToIr(
        starterDoc(processAttrs, children),
      );
      expect([ir.candidateStarterUsers, ir.candidateStarterGroups]).toEqual([
        header.candidateStarterUsers,
        header.candidateStarterGroups,
      ]);
      expect(warnings.map((w) => [w.category, w.elementId, w.message])).toEqual(
        expected,
      );
    },
  );

  const signalDoc = (tag: string, defAttrs = ''): string =>
    rootedDoc(
      '  <bpmn:signal id="Sig" name="sig" />\n',
      `    <bpmn:${tag} id="Ev">
      <bpmn:signalEventDefinition signalRef="Sig" ${defAttrs}>
        <bpmn:extensionElements>
          <operaton:in source="a" target="b" />
        </bpmn:extensionElements>
      </bpmn:signalEventDefinition>
    </bpmn:${tag}>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Ev" />
    <bpmn:sequenceFlow id="F2" sourceRef="Ev" targetRef="E" />`,
      operatonDefs,
    );

  it.each([
    {
      title:
        'a retry cycle written as an attribute says the engine reads the element form alone',
      xml: oneNodeDoc('serviceTask', {
        id: 'Work',
        attrs:
          'operaton:class="com.example.W" operaton:failedJobRetryTimeCycle="R3/PT1M"',
      }),
      warnings: [
        {
          elementId: 'Work',
          category: 'extensionAttribute',
          message:
            "setting 'operaton:failedJobRetryTimeCycle' on 'Work' was not imported\n" +
            "note: Operaton reads a retry cycle as an 'operaton:failedJobRetryTimeCycle' element and never as an attribute ('DefaultFailedJobParseListener.setFailedJobRetryTimeCycleValue' through 'BpmnParseUtil.findOperatonExtensionElement')\n" +
            'note: the rebuilt document runs the same',
        },
      ],
    },
    {
      title:
        "async and an operaton:in on a thrown signal's definition name parseSignalEventDefinition",
      xml: signalDoc('intermediateThrowEvent', 'operaton:async="true"'),
      warnings: [
        unread(
          "setting 'operaton:async'",
          'Ev',
          "a 'bpmn:signalEventDefinition'",
          'reads it on a thrown signal as its async delivery ' +
            "('BpmnParse.parseSignalEventDefinition')",
        ),
        unread(
          "'operaton:in' named 'a'",
          'Ev',
          "a 'bpmn:signalEventDefinition'",
          'reads it on a thrown signal as its payload ' +
            "('BpmnParse.parseSignalEventDefinition' through 'parseInputParameter')",
        ),
      ],
    },
    {
      title:
        "an operaton:in on a caught signal's definition reads nowhere, since parseSignalEventDefinition only reads it on a throw",
      xml: signalDoc('intermediateCatchEvent'),
      warnings: [
        unread(
          "'operaton:in' named 'a'",
          'Ev',
          "a 'bpmn:signalEventDefinition'",
        ),
      ],
    },
    {
      title:
        'the job priority and task priority on the process name parseProcess',
      xml: headerDoc('operaton:jobPriority="3" operaton:taskPriority="4"'),
      warnings: [
        unread(
          "setting 'operaton:jobPriority'",
          'p',
          "a 'bpmn:process'",
          "reads it ('BpmnParse.parseProcess' through 'parsePriority')",
        ),
        unread(
          "setting 'operaton:taskPriority'",
          'p',
          "a 'bpmn:process'",
          "reads it ('BpmnParse.parseProcess' through 'parsePriority')",
        ),
      ],
    },
    {
      title:
        "a process's own start printing no statement says its initiator went with it",
      xml: headerDoc('', 'operaton:initiator="claimant"', 'StartEvent_p'),
      warnings: [
        {
          elementId: 'StartEvent_p',
          category: 'extensionAttribute',
          message:
            "'operaton:initiator' setting on 'StartEvent_p' was not written to the script\n" +
            "note: 'StartEvent_p' is the kind of name BPMNscript generates for itself, which a script cannot repeat\n" +
            'note: this start is left out entirely, and its initiator with it\n' +
            'help: rename it in the diagram to keep the initiator',
        },
      ],
    },
  ])('$title', async ({ xml, warnings: expected }) => {
    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual(expected);
  });
});

describe('xmlToIr: warns for dropped lanes', () => {
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
    expect(warnings).toEqual(
      [
        ['Lane_Outer', 'Operations'],
        ['Lane_Inner', 'Dispatch'],
      ].map(([id, name]) => ({
        elementId: id,
        category: 'lane',
        message: `lane '${name}' (${id}) was not imported\nnote: every step is placed in a single flat process`,
      })),
    );
  });
});

describe('xmlToIr: undeclared operaton extension element residual', () => {
  const residualXml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="CleanTask" name="Clean Task">
      <bpmn:extensionElements/>
    </bpmn:userTask>
    <bpmn:userTask id="PropsTask" name="Props Task">
      <bpmn:extensionElements>
        <operaton:formProperty />
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CleanTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="CleanTask" targetRef="PropsTask" />
    <bpmn:sequenceFlow id="F3" sourceRef="PropsTask" targetRef="E" />`;

  it('reports the undeclared element once (no silent loss) without flagging the clean task', async () => {
    const { warnings } = await xmlToIr(residualXml);
    // Moddle ties a residual drop to no step, so it lands on the process.
    expect(warnings).toEqual([
      {
        elementId: 'p',
        category: 'extensionAttribute',
        message:
          'engine-specific configuration (operaton:formProperty at line 11) was not imported\n' +
          'note: it could not be attributed to a specific step',
      },
    ]);
  });
});

describe('xmlToIr: bpmn:documentation', () => {
  const doc = (text: string): string =>
    `<bpmn:documentation>${text}</bpmn:documentation>`;

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

  const dropped = (id: string, position: string): ImportWarning => ({
    elementId: id,
    category: 'documentation',
    message: `documentation on '${id}' was not imported\nnote: ${position} has no documentation in BPMNscript`,
  });

  const TIMER =
    '<bpmn:timerEventDefinition><bpmn:timeDuration>P1D</bpmn:timeDuration></bpmn:timerEventDefinition>';

  const KINDS = [
    ['userTask', ''],
    ['serviceTask', 'operaton:class="com.example.Svc"'],
    ['sendTask', 'operaton:class="com.example.Svc"'],
    ['businessRuleTask', 'operaton:class="com.example.Svc"'],
    ['scriptTask', 'scriptFormat="javascript"'],
    ['receiveTask', ''],
    ['task', ''],
    ['callActivity', 'calledElement="other"'],
    ['subProcess', ''],
    ['exclusiveGateway', ''],
    ['inclusiveGateway', ''],
    ['parallelGateway', ''],
  ] as const;

  const CONTENT: Partial<Record<string, string>> = {
    scriptTask: '<bpmn:script>total = 1;</bpmn:script>',
    subProcess:
      '<bpmn:startEvent id="SubS" /><bpmn:endEvent id="SubE" /><bpmn:sequenceFlow id="SubF" sourceRef="SubS" targetRef="SubE" />',
  };

  it('every position that holds documentation carries it verbatim, and every other one reports it', async () => {
    const { ir, warnings } =
      await xmlToIr(operatonDefs`  ${doc('Exported by hand.')}
  <bpmn:error id="Err" name="Boom" errorCode="BOOM">${doc('Raised by the vendor.')}</bpmn:error>
  <bpmn:escalation id="Esc" name="Late" escalationCode="LATE">${doc('Raised on day three.')}</bpmn:escalation>
  <bpmn:message id="Msg" name="Paid">${doc('Sent by billing.')}</bpmn:message>
  <bpmn:signal id="Sig" name="Stocked">${doc('Broadcast by the warehouse.')}</bpmn:signal>
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>${doc('Onboarding, end to end.')}
    <bpmn:startEvent id="S">${doc('Fires when HR files the request.')}</bpmn:startEvent>
${KINDS.map(([tag, attrs]) => `    <bpmn:${tag} id="${tag}" ${attrs}>${doc(`On ${tag}.`)}${CONTENT[tag] ?? ''}</bpmn:${tag}>`).join('\n')}
    <bpmn:userTask id="Verbatim"><bpmn:documentation>
        Two lines.
      </bpmn:documentation></bpmn:userTask>
    <bpmn:userTask id="Empty"><bpmn:documentation></bpmn:documentation></bpmn:userTask>
    <bpmn:userTask id="Rep">${doc('Review one application.')}
      <bpmn:multiInstanceLoopCharacteristics>${doc('Once per applicant.')}
        <bpmn:loopCardinality>3</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:userTask>
    <bpmn:boundaryEvent id="B" attachedToRef="Rep">${doc('Give up after a day.')}${TIMER}</bpmn:boundaryEvent>
    <bpmn:intermediateCatchEvent id="Await">${doc('Wait a day.')}
      <bpmn:timerEventDefinition>${doc('The day itself.')}<bpmn:timeDuration>P1D</bpmn:timeDuration></bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateThrowEvent id="Emit">${doc('Tell the warehouse.')}
      <bpmn:signalEventDefinition signalRef="Sig">${doc('The broadcast itself.')}</bpmn:signalEventDefinition>
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="Throw">${doc('Give up here.')}
      <bpmn:errorEventDefinition errorRef="Err">${doc('The error itself.')}</bpmn:errorEventDefinition>
    </bpmn:endEvent>
    <bpmn:endEvent id="Stop">${doc('Nothing else runs.')}
      <bpmn:terminateEventDefinition>${doc('The terminate itself.')}</bpmn:terminateEventDefinition>
    </bpmn:endEvent>
    <bpmn:endEvent id="E">${doc('The hire is on the payroll.')}</bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E">${doc('Straight through.')}</bpmn:sequenceFlow>
${KINDS.filter(([tag]) => tag.endsWith('Gateway'))
  .map(
    ([tag]) =>
      `    <bpmn:sequenceFlow id="Out_${tag}" sourceRef="${tag}" targetRef="E" />`,
  )
  .join('\n')}
    <bpmn:subProcess id="Handler" triggeredByEvent="true">${doc('Runs when the deadline passes.')}
      <bpmn:startEvent id="HStart">${doc('The deadline itself.')}${TIMER}</bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
  </bpmn:process>`);
    expect(documented(ir)).toEqual([
      ['p', 'Onboarding, end to end.'],
      ['S', 'Fires when HR files the request.'],
      ...KINDS.map(([tag]) => [tag, `On ${tag}.`]),
      ['Verbatim', '\n        Two lines.\n      '],
      ['Empty', ''],
      ['Rep', 'Review one application.'],
      ['Stop', 'Nothing else runs.'],
      ['E', 'The hire is on the payroll.'],
      ['HStart', 'The deadline itself.'],
    ]);
    expect(warnings).toEqual([
      dropped('Rep', 'a repetition'),
      dropped('B', 'a boundary event'),
      dropped('Await', 'an event definition'),
      dropped('Await', 'an await'),
      dropped('Emit', 'an event definition'),
      dropped('Emit', 'an emit'),
      dropped('Throw', 'an event definition'),
      dropped('Throw', 'a throw'),
      dropped('Stop', 'an event definition'),
      dropped('F1', 'a sequence flow'),
      dropped('Handler', 'an event handler'),
      {
        elementId: 'Msg',
        category: 'unreferencedRoot',
        message:
          "message 'Paid' declared by root 'Msg' was not imported\n" +
          "note: no 'on', 'throw' or 'emit' uses it",
      },
      dropped('p', 'the definitions root'),
      dropped('Err', "a 'bpmn:error' root"),
      dropped('Esc', "a 'bpmn:escalation' root"),
      dropped('Msg', "a 'bpmn:message' root"),
      dropped('Sig', "a 'bpmn:signal' root"),
    ]);
  });

  it('a start and an end whose ids this tool writes for itself carry it and report that no script can spell it back', async () => {
    const { ir, warnings } = await xmlToIr(
      bpmnDoc`    <bpmn:startEvent id="StartEvent_p">${doc('Where it begins.')}</bpmn:startEvent>
    <bpmn:endEvent id="EndEvent_p">${doc('Where it stops.')}</bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="StartEvent_p" targetRef="EndEvent_p" />`,
    );
    expect(documented(ir)).toEqual([
      ['StartEvent_p', 'Where it begins.'],
      ['EndEvent_p', 'Where it stops.'],
    ]);
    expect(warnings).toEqual([
      warning(
        'StartEvent_p',
        "documentation on 'StartEvent_p' was not written to the script\nnote: 'StartEvent_p' is the kind of name BPMNscript generates for itself, which a script cannot repeat\nnote: this start is left out entirely, and its documentation with it\nhelp: rename it in the diagram to keep the documentation",
        'documentation',
      ),
      warning(
        'EndEvent_p',
        "documentation on 'EndEvent_p' cannot be kept as written\nnote: 'EndEvent_p' is the kind of name BPMNscript generates for itself, which a script cannot repeat\nnote: where the script can do without this end, it is left out, and its documentation with it\nnote: anywhere else it prints under that name and is refused when read back\nhelp: rename it in the diagram to keep the documentation",
        'documentation',
      ),
    ]);
  });

  it.each([
    [
      'a second documentation child leaves the element with none',
      `${doc('The first.')}${doc('The second.')}`,
      "documentation on 'T' was not imported\nnote: BPMNscript holds one 'bpmn:documentation' and 'T' carries 2",
    ],
    [
      'a textFormat naming anything but plain text leaves the element with none',
      '<bpmn:documentation textFormat="text/html">&lt;p&gt;Hi&lt;/p&gt;</bpmn:documentation>',
      "documentation on 'T' was not imported\nnote: BPMNscript holds plain text and its 'textFormat' is 'text/html'",
    ],
  ])('%s', async (_title, children, detail) => {
    const { ir, warnings } = await xmlToIr(
      oneNodeDoc('userTask', { children }),
    );
    expect(documented(ir)).toEqual([]);
    expect(warnings).toEqual([warning('T', detail, 'documentation')]);
  });
});

describe('xmlToIr: warns for unmapped BPMN content', () => {
  const withRoots = (
    roots: string,
    content = '',
    attrs = 'isExecutable="true"',
  ) =>
    bpmnDefs`${roots}
  <bpmn:process id="p" ${TIME_TO_LIVE} ${attrs}>
    <bpmn:startEvent id="S" />
    ${content}
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

  it.each([
    [
      'content on bpmn:definitions itself is reported against the process',
      withRoots('  <bpmn:extension mustUnderstand="false" />'),
      [
        warning(
          'p',
          "element 'bpmn:extension' on 'p' was not imported\n" +
            'note: BPMNscript imports the executable flow and the engine settings on its steps, and nothing declared or drawn beside it',
          'unmappedConstruct',
        ),
      ],
    ],
    [
      'a dataObject with a dataState child at process level is reported once, whole',
      withRoots(
        '',
        '<bpmn:dataObject id="Data1"><bpmn:dataState id="State1" name="ready" /></bpmn:dataObject>',
      ),
      [
        {
          elementId: 'Data1',
          category: 'unmappedConstruct',
          message:
            "'bpmn:dataObject' element 'Data1' was not imported\n" +
            'note: Operaton keeps process variables in its own store and never dispatches on it, so the imported process runs the same',
        },
      ],
    ],
    [
      'a globalScriptTask root is reported once, and its own script child is not blamed on the process',
      withRoots(
        '  <bpmn:globalScriptTask id="G3">\n    <bpmn:script>x</bpmn:script>\n  </bpmn:globalScriptTask>',
      ),
      [
        {
          elementId: 'G3',
          category: 'unmappedConstruct',
          message:
            "root 'bpmn:globalScriptTask' element 'G3' was not imported\n" +
            'note: BPMNscript imports the executable flow and the engine settings on its steps, and nothing declared or drawn beside it',
        },
      ],
    ],
    [
      'an eventDefinitionRef is reported on the event that names it, beside the root it names',
      withRoots('  <bpmn:terminateEventDefinition id="TED" />').replace(
        '<bpmn:startEvent id="S" />',
        '<bpmn:startEvent id="S">\n      <bpmn:eventDefinitionRef>TED</bpmn:eventDefinitionRef>\n    </bpmn:startEvent>',
      ),
      [
        {
          elementId: 'S',
          category: 'unmappedConstruct',
          message:
            "'eventDefinitionRef' 'TED' on 'S' was not imported\n" +
            "note: 'BpmnParse' reads only the event definitions nested in the event, so the rebuilt document runs the same",
        },
        {
          elementId: 'TED',
          category: 'unmappedConstruct',
          message:
            "root 'bpmn:terminateEventDefinition' element 'TED' was not imported\n" +
            'note: BPMNscript imports the executable flow and the engine settings on its steps, and nothing declared or drawn beside it',
        },
      ],
    ],
    [
      'isExecutable="false" is reported, and the process imports as executable regardless',
      withRoots('', '', 'isExecutable="false"'),
      [
        warning(
          'p',
          "process 'p' was imported as executable although it is marked 'isExecutable=\"false\"'\nnote: BPMNscript cannot express a process that is not executable\nnote: it is written back as executable, so an engine deploys and runs what the original document held back",
          'behaviourChanged',
        ),
      ],
    ],
  ])('%s', async (_title, xml, expected) => {
    const { ir, warnings } = await xmlToIr(xml);
    expect(ir.isExecutable).toBe(true);
    expect(warnings).toEqual(expected);
  });
});

describe('xmlToIr: callActivity import', () => {
  const callDoc = (attrs = '', extension = '', doc = operatonDoc) =>
    oneNodeDoc('callActivity', {
      id: 'CallSub',
      attrs: `calledElement="sub-process" ${attrs}`,
      children: extension && extensionElements(extension),
      doc,
    });

  it('a fully-featured call activity imports to the exact expected IR node, reporting nothing', async () => {
    const { node, warnings } = await importOnly(
      callDoc(
        'name="Call sub" operaton:calledElementBinding="version" operaton:calledElementVersion="3"',
        `        <operaton:in businessKey="\${execution.processBusinessKey}" />
        <operaton:in variables="all" />
        <operaton:in source="amount" target="amount" />
        <operaton:in sourceExpression="\${total * 2}" target="doubled" local="true" />
        <operaton:out source="result" target="outcome" />
        <operaton:out sourceExpression="\${status}" target="final" />`,
      ),
      'callActivity',
    );
    expect(node).toEqual({
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
    });
    expect(warnings).toEqual([]);
  });

  const onCall = (message: string, category = 'extensionAttribute') => ({
    elementId: 'CallSub',
    category,
    message,
  });

  const inIgnored = (attr: string, winner: string, why: string) =>
    onCall(
      `'${attr}' on an 'operaton:in' of 'CallSub' was not imported\n` +
        `note: it has no effect alongside '${winner}', since ${why}`,
    );
  const PROVIDER_READS_ALL =
    "'BpmnParse.parseCallableElementProvider' passes every variable and reads nothing else";
  const KEY_ALONE =
    "'BpmnParse.parseInputParameter' reads the business key alone off that element";

  it.each([
    {
      title:
        'a binding word parseBinding does not know imports as latest, naming the rewrite',
      xml: callDoc('camunda:calledElementBinding="bogus"', '', dualDoc),
      node: { binding: { kind: 'latest' } },
      warnings: [
        onCall(
          "'calledElementBinding=\"bogus\"' on 'CallSub' imports as 'binding: latest'\n" +
            "note: 'BpmnParse.parseBinding' sets no binding for that word, and 'BaseCallableElement.isLatestBinding' reads none as latest\n" +
            'note: BPMNscript writes it back as \'calledElementBinding="latest"\', which the engine reads the same',
          'rewritten',
        ),
        CAMUNDA_ALIAS_WARNING,
      ],
    },
    {
      title:
        'operaton:variableMappingDelegateExpression imports as a delegate mapper',
      xml: callDoc(
        'operaton:variableMappingDelegateExpression="${mapperBean}"',
      ),
      node: {
        mapper: { kind: 'delegateExpression', expression: '${mapperBean}' },
      },
      warnings: [],
    },
    {
      title:
        'both mapper attributes import the class and report the delegate as shadowed',
      xml: callDoc(
        'operaton:variableMappingClass="com.acme.Mapper" ' +
          'operaton:variableMappingDelegateExpression="${mapperBean}"',
      ),
      node: { mapper: { kind: 'class', className: 'com.acme.Mapper' } },
      warnings: [
        onCall(
          "setting 'variableMappingDelegateExpression' on 'CallSub' was not imported\n" +
            "note: it has no effect alongside 'operaton:variableMappingClass'",
        ),
      ],
    },
    {
      title: 'source beside sourceExpression keeps source',
      xml: callDoc(
        '',
        '<operaton:in source="a" sourceExpression="${b}" target="c" />',
      ),
      node: { inMappings: [{ kind: 'variable', source: 'a', target: 'c' }] },
      warnings: [
        inIgnored(
          'sourceExpression',
          'source',
          "'BpmnParse.parseCallableElementProvider' reads 'source' first",
        ),
      ],
    },
    {
      title: 'variables="all" beside source and target keeps all',
      xml: callDoc('', '<operaton:in variables="all" source="a" target="b" />'),
      node: { inMappings: [{ kind: 'all' }] },
      warnings: [
        inIgnored('source', 'variables="all"', PROVIDER_READS_ALL),
        inIgnored('target', 'variables="all"', PROVIDER_READS_ALL),
      ],
    },
    {
      title:
        'a businessKey beside source, target, variables and local keeps the key',
      xml: callDoc(
        '',
        '<operaton:in businessKey="${k}" source="a" target="b" variables="all" local="true" />',
      ),
      node: { businessKey: '${k}' },
      warnings: [
        inIgnored('source', 'businessKey', KEY_ALONE),
        inIgnored('target', 'businessKey', KEY_ALONE),
        inIgnored('variables', 'businessKey', KEY_ALONE),
        inIgnored('local', 'businessKey', KEY_ALONE),
      ],
    },
    {
      title: 'a second businessKey replaces the first',
      xml: callDoc(
        '',
        '<operaton:in businessKey="${a}" /><operaton:in businessKey="${b}" />',
      ),
      node: { businessKey: '${b}' },
      warnings: [
        onCall(
          "'operaton:in businessKey=\"${a}\"' on 'CallSub' was not imported\n" +
            'note: it has no effect alongside a later one\n' +
            "note: 'BpmnParse.parseInputParameter' hands each to 'setBusinessKeyValueProvider', and the last stands",
        ),
      ],
    },
  ])('$title', async ({ xml, node, warnings }) => {
    const imported = await importOnly(xml, 'callActivity');
    expect(imported.node).toEqual({
      kind: 'callActivity',
      id: 'CallSub',
      calledElement: 'sub-process',
      ...node,
    });
    expect(imported.warnings).toEqual(warnings);
  });

  it.each([
    [
      'calledElementBinding="version" without a version',
      callDoc('operaton:calledElementBinding="version"'),
      "'calledElementBinding=\"version\"' is set without a 'calledElementVersion'",
    ],
    [
      'calledElementBinding="versionTag", which this surface has no setting for',
      callDoc('operaton:calledElementBinding="versionTag"'),
      '\'calledElementBinding="versionTag"\' pins a version tag',
    ],
    [
      'operaton:calledElementTenantId',
      callDoc('operaton:calledElementTenantId="tenant-a"'),
      'it names \'operaton:calledElementTenantId="tenant-a"\'',
    ],
    [
      'a caseRef and no calledElement',
      oneNodeDoc('callActivity', {
        id: 'CallSub',
        attrs: 'operaton:caseRef="claims"',
      }),
      "it names 'operaton:caseRef=\"claims\"' and no 'calledElement'",
    ],
    [
      'neither a calledElement nor a caseRef',
      oneNodeDoc('callActivity', { id: 'CallSub' }),
      "it names neither a 'calledElement' nor an 'operaton:caseRef'",
    ],
    [
      'a calledElement beside a caseRef',
      callDoc('operaton:caseRef="claims"'),
      "it names a 'calledElement' beside 'operaton:caseRef=\"claims\"'",
    ],
    [
      'an operaton:in with source but no target',
      callDoc('', '<operaton:in source="a" />'),
      "an 'operaton:in' carries 'source' without a 'target'",
    ],
    [
      'an operaton:in with variables="foo"',
      callDoc('', '<operaton:in variables="foo" />'),
      "an 'operaton:in' carries a variables value other than all ('variables=\"foo\"')",
    ],
    [
      'an empty operaton:in',
      callDoc('', '<operaton:in />'),
      "an 'operaton:in' carries none of the recognized shapes",
    ],
    [
      'an operaton:in with an empty source, quoting the strict validation',
      callDoc('', '<operaton:in source="" target="b" />'),
      "an 'operaton:in' carries an empty source ('source=\"\"')",
    ],
    [
      'an operaton:in with sourceExpression but no target',
      callDoc('', '<operaton:in sourceExpression="${a}" />'),
      "an 'operaton:in' carries 'sourceExpression' without a 'target'",
    ],
  ])('a call activity with %s is refused', async (_title, xml, detail) => {
    await expectRefusal(xmlToIr(xml), UnsupportedCallActivityError, detail);
  });

  // The script writes a mapped variable as a plain name, which has no
  // backtick form.
  it.each([
    [
      'an operaton:out target',
      '<operaton:out sourceExpression="${bean.value}" target="var" />',
      "its 'operaton:out' target",
      'var',
    ],
    [
      'an operaton:in source',
      '<operaton:in source="end" target="total" />',
      "its 'operaton:in' source",
      'end',
    ],
    [
      'an operaton:in target',
      '<operaton:in source="total" target="a b" />',
      "its 'operaton:in' target",
      'a b',
    ],
  ])(
    'a call activity mapping %s no plain name spells is refused',
    async (_title, mapping, attribute, name) => {
      const e = await expectRefusal(
        xmlToIr(callDoc('', mapping)),
        UnsupportedVariableNameError,
        `${attribute} names the variable '${name}', which BPMNscript cannot write back unchanged`,
      );
      expect(e.message.split('\n').slice(1)).toEqual([
        'note: BPMNscript writes a variable as a plain name, and this name is not one',
        "note: a plain name is letters, digits and '_', with '-' between them, and no keyword",
      ]);
    },
  );
});

// The engine stores the caught value under any name, but the script writes a
// catch binding as an identifier.
it.each([
  ['error code', 'errorEventDefinition', 'errorCodeVariable', 'code', '208'],
  [
    'error message',
    'errorEventDefinition',
    'errorMessageVariable',
    'message',
    'var',
  ],
  [
    'escalation code',
    'escalationEventDefinition',
    'escalationCodeVariable',
    'code',
    'a b',
  ],
] as const)(
  'a caught %s stored in a variable no plain name spells is refused',
  async (_title, definition, attr, caught, name) => {
    const xml = rootedDoc(
      '',
      `    <bpmn:userTask id="A" />
    <bpmn:boundaryEvent id="B" attachedToRef="A"><bpmn:${definition} operaton:${attr}="${name}" /></bpmn:boundaryEvent>`,
    );
    const e = await expectRefusal(
      xmlToIr(xml),
      UnsupportedEventFeatureError,
      `it stores the caught ${caught} in '${name}', which BPMNscript cannot write back unchanged`,
    );
    expect(e.message.split('\n').slice(1)).toEqual([
      `note: 'operaton:${attr}' names a variable, which BPMNscript writes as a plain name, and this name is not one`,
      "note: a plain name is letters, digits and '_', with '-' between them, and no keyword",
    ]);
  },
);

describe('xmlToIr: event layer import', () => {
  const fullEventXml = dualDefs`  <bpmn:error id="Error_PF" name="PF" errorCode="PF" operaton:errorMessage="boom" />
  <bpmn:escalation id="Escalation_LS" name="LS" escalationCode="LS" />
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
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
    historyTimeToLive: HISTORY_TIME_TO_LIVE,
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
    expect(warnings).toEqual([CAMUNDA_ALIAS_WARNING]);
  });

  describe('refusals', () => {
    const wiredHandler = (flow: string): string =>
      bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
    ${flow}`;

    const workBoundaryDoc = (boundary: string): string =>
      rootedDoc(
        '',
        `    <bpmn:subProcess id="Work">
      <bpmn:startEvent id="WStart" />
      <bpmn:endEvent id="WEnd" />
      <bpmn:sequenceFlow id="WF" sourceRef="WStart" targetRef="WEnd" />
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="B" attachedToRef="Work">
      ${boundary}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:endEvent id="E2" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Work" />
    <bpmn:sequenceFlow id="F2" sourceRef="Work" targetRef="E" />
    <bpmn:sequenceFlow id="F3" sourceRef="B" targetRef="E2" />`,
      );

    const throwDoc = (definition: string, roots = ''): string =>
      rootedDoc(
        roots,
        `    <bpmn:endEvent id="Throw">
      ${definition}
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Throw" />`,
      );

    const rootsOnly = (roots: string): string =>
      rootedDoc(
        roots,
        `    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
        operatonDefs,
      );

    const DANGLING_ESCALATION =
      "its escalation reference ('escalationRef=\"Esc_Missing\"') names no 'bpmn:escalation' root";
    const missingEscalation = (method: string): string =>
      `note: Operaton refuses to deploy it ("could not find escalation with id 'Esc_Missing'", 'BpmnParse.${method}')`;
    const UNWIRED_HELP =
      "help: take the flow 'F2' off, since the handler runs when its trigger fires";

    it.each([
      [
        'an event handler with zero start events',
        bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:userTask id="T" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
        'Handler',
        'an event handler must have exactly one start event carrying its trigger (found 0)',
        [HANDLER_TRIGGER],
      ],
      [
        'a handler start with two event definitions',
        handlerDoc(
          `<bpmn:errorEventDefinition />
        <bpmn:escalationEventDefinition />`,
          { body: '' },
        ),
        'Handler',
        'its start event must carry exactly one trigger definition (found 2)',
        [HANDLER_TRIGGER],
      ],
      [
        'isInterrupting="false" on an error handler',
        handlerDoc('<bpmn:errorEventDefinition errorRef="Error_X" />', {
          roots: '  <bpmn:error id="Error_X" errorCode="X" />\n',
          startAttrs: 'isInterrupting="false"',
        }),
        'Handler',
        'an error handler cannot be non-interrupting (\'isInterrupting="false"\')',
        ['note: BPMN requires an error trigger to interrupt its scope'],
      ],
      [
        'a flow into an event handler written without incoming/outgoing children, on the flow itself',
        wiredHandler(
          '<bpmn:sequenceFlow id="F2" sourceRef="S" targetRef="Handler" />',
        ),
        'Handler',
        "the flow 'F2' enters the event handler 'Handler'",
        [
          'note: \'BpmnParse.parseSequenceFlow\' fails the deployment on it ("Invalid incoming sequence flow of event subprocess")',
          'note: a handler is entered by its trigger',
          UNWIRED_HELP,
        ],
      ],
      [
        'a flow out of an event handler written without incoming/outgoing children, on the flow itself',
        wiredHandler(
          '<bpmn:sequenceFlow id="F2" sourceRef="Handler" targetRef="E" />',
        ),
        'Handler',
        "the flow 'F2' leaves the event handler 'Handler'",
        [
          'note: \'BpmnParse.parseSequenceFlow\' fails the deployment on it ("Invalid outgoing sequence flow of event subprocess")',
          'note: a handler ends where its body ends',
          UNWIRED_HELP,
        ],
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
        'BadEmit',
        'an emit cannot carry an error',
        [
          'note: BPMN has no intermediate error throw',
          "help: write 'throw error' to end the path instead",
        ],
      ],
      [
        'two bpmn:Error roots sharing a code but disagreeing on the message',
        rootsOnly(`  <bpmn:error id="Error_A" errorCode="DUP" operaton:errorMessage="first" />
  <bpmn:error id="Error_B" errorCode="DUP" operaton:errorMessage="second" />\n`),
        'Error_B',
        "error roots 'Error_A' and 'Error_B' both declare code 'DUP' but disagree about the thrown message",
        [],
      ],
      [
        'a declared message on a code-less bpmn:Error root',
        rootsOnly(
          '  <bpmn:error id="Error_NoCode" operaton:errorMessage="oops" />\n',
        ),
        'Error_NoCode',
        "this error root declares an error message but no 'errorCode'",
        ['note: a declared error message needs a code to be keyed by'],
      ],
      [
        'a boundary catch whose escalationRef names no root',
        workBoundaryDoc(
          '<bpmn:escalationEventDefinition escalationRef="Esc_Missing" />',
        ),
        'B',
        DANGLING_ESCALATION,
        [
          missingEscalation(
            'createEscalationEventDefinitionForEscalationHandler',
          ),
        ],
      ],
      [
        'an escalation end whose escalationRef names no root',
        throwDoc(
          '<bpmn:escalationEventDefinition escalationRef="Esc_Missing" />',
        ),
        'Throw',
        DANGLING_ESCALATION,
        [
          missingEscalation('findEscalationForEscalationEventDefinition'),
          THROW_CODE,
        ],
      ],
      [
        'an escalation end with no escalationRef',
        throwDoc('<bpmn:escalationEventDefinition />'),
        'Throw',
        "its escalation definition carries no 'escalationRef'",
        [
          "note: Operaton refuses to deploy it (\"escalationEventDefinition does not have required attribute 'escalationRef'\", 'BpmnParse.findEscalationForEscalationEventDefinition')",
          THROW_CODE,
        ],
      ],
      [
        'an escalation end naming a code-less root',
        throwDoc(
          '<bpmn:escalationEventDefinition escalationRef="Esc_NoCode" />',
          '  <bpmn:escalation id="Esc_NoCode" />\n',
        ),
        'Throw',
        "its escalation reference names a root that carries no code ('Esc_NoCode')",
        [
          "note: Operaton refuses to deploy a throw of one (\"throwing escalation event must have an 'escalationCode'\", 'BpmnParse.parseIntermediateThrowEvent', and \"escalation end event must have an 'escalationCode'\", 'parseEndEvents')",
          THROW_CODE,
        ],
      ],
      [
        'an error end with no errorRef',
        throwDoc('<bpmn:errorEventDefinition />'),
        'Throw',
        "its error definition carries no 'errorRef'",
        [
          "note: Operaton refuses to deploy it (\"'errorRef' attribute is mandatory on error end event\", 'BpmnParse.parseEndEvents')",
          THROW_CODE,
        ],
      ],
      [
        'an error end naming a code-less root',
        throwDoc(
          '<bpmn:errorEventDefinition errorRef="Error_NoCode" />',
          '  <bpmn:error id="Error_NoCode" />\n',
        ),
        'Throw',
        "its error reference names a root that carries no code ('Error_NoCode')",
        [
          "note: Operaton refuses to deploy the throw (\"'errorCode' is mandatory on errors referenced by throwing error event definitions\", 'BpmnParse.parseEndEvents')",
          THROW_CODE,
        ],
      ],
    ])('%s refuses', async (_title, xml, elementId, detail, notes) => {
      await expectEventRefusal(xml, elementId, detail, notes);
    });

    it("an error end whose errorRef names no root imports the reference text as the code, the engine's reading, with one warning", async () => {
      const { ir, warnings } = await xmlToIr(
        throwDoc('<bpmn:errorEventDefinition errorRef="Error_Missing" />'),
      );
      const owner = byId(ir, 'Throw');
      expect('eventDefinition' in owner && owner.eventDefinition).toEqual(
        errorDef('Error_Missing'),
      );
      expect(warnings).toEqual([danglingErrorRef('Throw', 'Error_Missing')]);
      expect(ir.errorDecls).toBeUndefined();
      expect(await irToXml(ir)).toContain(
        '<bpmn:error id="Error_Error_Missing" name="Error_Missing" errorCode="Error_Missing" />',
      );
    });
  });
});

describe('xmlToIr: message/signal/timer/conditional import', () => {
  describe('refusals', () => {
    const UNRESOLVED_REF = [
      'note: BPMNscript matches the reference to a root id as written',
      "note: Operaton resolves a prefixed reference through the xmlns table ('BpmnParse.resolveName') and refuses an unresolved one",
    ];

    it.each([
      [
        'a ref-less message definition',
        handlerDoc('<bpmn:messageEventDefinition id="d" />', { body: '' }),
        'HStart',
        "a message definition must reference a 'bpmn:Message' root with a non-empty name",
        [],
      ],
      [
        'a prefixed messageRef, which the engine resolves and this tool does not',
        handlerDoc(
          '<bpmn:messageEventDefinition id="d" messageRef="tns:Message_1" />',
          {
            roots: '  <bpmn:message id="Message_1" name="Ping" />\n',
            body: '',
          },
        ),
        'HStart',
        "its message reference ('messageRef=\"tns:Message_1\"') names no 'bpmn:Message' root",
        UNRESOLVED_REF,
      ],
      [
        'a receive task whose messageRef names no message',
        rootedDoc(
          '',
          `    <bpmn:receiveTask id="R" messageRef="Missing" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="R" />`,
        ),
        'R',
        "its message reference ('messageRef=\"Missing\"') names no 'bpmn:Message' root",
        UNRESOLVED_REF,
      ],
      [
        'a timer definition with zero time children',
        handlerDoc('<bpmn:timerEventDefinition id="d" />', { body: '' }),
        'HStart',
        "a timer definition must carry exactly one of 'timeDuration', 'timeDate' and 'timeCycle' (found 0)",
        [],
      ],
      [
        'a timer definition with an empty body',
        handlerDoc(
          `<bpmn:timerEventDefinition id="d">
          <bpmn:timeDuration></bpmn:timeDuration>
        </bpmn:timerEventDefinition>`,
          { body: '' },
        ),
        'HStart',
        "the 'timeDuration' of a timer definition has an empty body",
        [],
      ],
      [
        'a conditional definition without a condition child',
        handlerDoc('<bpmn:conditionalEventDefinition id="d" />', { body: '' }),
        'HStart',
        'a conditional definition must carry a condition with a non-empty body',
        [],
      ],
      [
        'operaton:variableName on a conditional definition',
        handlerDoc(
          `<bpmn:conditionalEventDefinition id="d" operaton:variableName="amount">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>`,
          { body: '', defs: operatonDefs },
        ),
        'HStart',
        "a conditional definition sets 'operaton:variableName'",
        [
          'note: it narrows when the condition is evaluated again, which BPMNscript cannot represent',
        ],
      ],
    ] as const)(
      '%s refuses with UnsupportedEventFeatureError naming the form',
      async (_title, xml, elementId, detail, notes) => {
        await expectEventRefusal(xml, elementId, detail, notes);
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
        "end event 'E' carries an unsupported link definition 'bpmn:LinkEventDefinition'\n" +
          "note: a typed end event supports 'terminate', 'error', 'escalation', 'message', 'signal', or 'compensation', plus 'cancel' inside a block that can be given up",
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
        "intermediate throw event 'Emit' carries an unsupported conditional definition 'bpmn:ConditionalEventDefinition'\n" +
          "note: an emit supports 'escalation', 'message', 'signal', 'compensation', or 'link'",
      ],
      [
        'a link definition on a boundary event',
        rootedDoc(
          '',
          `    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Boundary_Review_link" attachedToRef="Review">
      <bpmn:linkEventDefinition id="LinkDef" name="Resume" />
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />`,
        ),
        'boundary',
        'bpmn:LinkEventDefinition',
        "boundary event 'Boundary_Review_link' carries an unsupported link definition 'bpmn:LinkEventDefinition'\n" +
          "note: a boundary event supports 'error', 'escalation', 'message', 'signal', 'timer', or 'condition', plus 'cancel' on a block that can be given up",
      ],
      [
        'the abstract bpmn:eventDefinition tag on a start, named a "special" definition',
        bpmnDoc`    <bpmn:startEvent id="S">
      <bpmn:eventDefinition id="Def" />
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
        'start',
        'bpmn:EventDefinition',
        "start event 'S' carries an unsupported special definition 'bpmn:EventDefinition'\n" +
          'note: a plain start event carries no definition\n' +
          "note: a process's start supports 'message', 'signal', 'timer', or 'condition'\n" +
          "note: an event handler's start supports 'error', 'escalation', 'message', 'signal', 'timer', 'condition', or 'compensation'",
      ],
    ] as const)(
      '%s refuses with UnsupportedEventDefinitionError naming what the position does take',
      async (_title, xml, eventKind, definitionType, supported) => {
        const e = await expectRefusal<UnsupportedEventDefinitionError>(
          xmlToIr(xml),
          UnsupportedEventDefinitionError,
        );
        expect([e.eventKind, e.definitionType, e.message]).toEqual([
          eventKind,
          definitionType,
          supported,
        ]);
      },
    );
  });

  describe('root honesty', () => {
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

      expect(warnings).toEqual([
        {
          elementId: 'Message_X',
          category: 'extensionAttribute',
          message:
            "setting 'itemRef' on message root 'Message_X' was not imported\n" +
            'note: it names a data structure Operaton does not execute',
        },
        {
          elementId: 'Item_1',
          category: 'unmappedConstruct',
          message:
            "root 'bpmn:itemDefinition' element 'Item_1' was not imported\n" +
            'note: BPMNscript imports the executable flow and the engine settings on its steps, and nothing declared or drawn beside it',
        },
      ]);
    });
  });
});

describe('xmlToIr: compensation import', () => {
  const undoHandler = (startAttrs = '', definitionAttrs = '') =>
    `<bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
        <bpmn:startEvent id="UndoStart" ${startAttrs}>
          <bpmn:compensateEventDefinition id="d" ${definitionAttrs} />
        </bpmn:startEvent>
        <bpmn:endEvent id="UndoEnd" />
        <bpmn:sequenceFlow id="Flow_UndoStart_UndoEnd" sourceRef="UndoStart" targetRef="UndoEnd" />
      </bpmn:subProcess>`;

  const bookingDoc = (body: string) =>
    oneNodeDoc('subProcess', {
      id: 'Booking',
      doc: bpmnDoc,
      children: `<bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      ${body}
      <bpmn:sequenceFlow id="Flow_BStart_BEnd" sourceRef="BStart" targetRef="BEnd" />`,
    });

  const BOUNDARY = `<bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>`;
  const HANDLER =
    '<bpmn:userTask id="CancelReservation" isForCompensation="true" />';
  const RESERVE =
    '<bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />';

  const reserveDoc = (nodes: string, association = ''): string =>
    operatonDoc`    <bpmn:startEvent id="S" />
    ${nodes}
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
    ${association}`;
  const association = (from: string, to: string): string =>
    `<bpmn:association id="Assoc1" sourceRef="${from}" targetRef="${to}" />`;

  const HOSTED = [
    'note: a compensation handler must be hosted directly by the block whose completed work it undoes',
    'help: move it inside that block',
  ];
  const BOUNDARY_REFUSED = [
    "note: BPMN attaches compensation through 'isForCompensation' and a 'bpmn:association' on the activity being compensated, not a boundary event",
    "help: wrap the steps in their own subprocess and target it with 'on compensation'",
  ];

  it.each([
    [
      'an activityRef on a compensation handler-start definition',
      bookingDoc(
        `<bpmn:userTask id="ReserveRoom" />
      ${undoHandler('', 'activityRef="ReserveRoom"')}`,
      ),
      'UndoStart',
      'a compensation definition targets one activity by reference (\'activityRef="ReserveRoom"\')',
      [
        'note: BPMNscript always addresses the enclosing scope and cannot target a single activity',
      ],
    ],
    [
      'waitForCompletion="false" on an intermediate throw',
      oneNodeDoc('intermediateThrowEvent', {
        id: 'EmitUndo',
        doc: bpmnDoc,
        children:
          '<bpmn:compensateEventDefinition id="d" waitForCompletion="false" />',
      }),
      'EmitUndo',
      'a compensation definition sets \'waitForCompletion="false"\'',
      [
        'note: BPMNscript only imports the default behaviour, which waits for the compensation to complete',
      ],
    ],
    [
      'isInterrupting="false" on a compensation handler start',
      bookingDoc(undoHandler('isInterrupting="false"')),
      'UndoBooking',
      'a compensation handler cannot be non-interrupting (\'isInterrupting="false"\')',
      ['note: BPMN requires a compensation trigger to interrupt its scope'],
    ],
    [
      'a compensation event sub-process hosted directly by the process',
      bpmnDoc`    <bpmn:startEvent id="S" />
    ${undoHandler()}
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      'UndoBooking',
      'a compensation handler is hosted by the process',
      HOSTED,
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
      'UndoBooking',
      'a compensation handler is hosted by another event subprocess',
      HOSTED,
    ],
    [
      'a compensation boundary event no bpmn:association leaves',
      reserveDoc(`${RESERVE}\n    ${BOUNDARY}`),
      'CompensationBoundary',
      'a compensation boundary event is not imported',
      BOUNDARY_REFUSED,
    ],
    [
      'a compensation boundary event whose bpmn:association targets a plain task that never declared isForCompensation',
      reserveDoc(
        `${RESERVE}\n    ${BOUNDARY}\n    <bpmn:task id="NotAHandler" />`,
        association('CompensationBoundary', 'NotAHandler'),
      ),
      'CompensationBoundary',
      'a compensation boundary event is not imported',
      BOUNDARY_REFUSED,
    ],
    [
      // Boundary first: only the rewrite preview's mapper meets the host before the container walk.
      'a paired compensation whose host carries content this tool cannot import at all, with the compensation refusal and not that unrelated one',
      reserveDoc(
        `${BOUNDARY}
    <bpmn:scriptTask id="ReserveRoom" scriptFormat="javascript" operaton:resource="deployment://check.groovy" />
    ${HANDLER}`,
        association('CompensationBoundary', 'CancelReservation'),
      ),
      'CompensationBoundary',
      'a compensation boundary event is not imported',
      BOUNDARY_REFUSED,
    ],
    [
      'a timer boundary associated with an isForCompensation handler, which is not the paired pattern',
      reserveDoc(
        `${RESERVE}
    <bpmn:boundaryEvent id="TimerBoundary" attachedToRef="ReserveRoom">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    ${HANDLER}`,
        association('TimerBoundary', 'CancelReservation'),
      ),
      'CancelReservation',
      IS_FOR_COMPENSATION,
      EXCLUDED_FROM_FLOW,
    ],
    [
      'a bpmn:association from a plain task to an isForCompensation handler, which is not the paired pattern either',
      reserveDoc(
        `${RESERVE}\n    <bpmn:task id="NotABoundary" />\n    ${HANDLER}`,
        association('NotABoundary', 'CancelReservation'),
      ),
      'CancelReservation',
      IS_FOR_COMPENSATION,
      EXCLUDED_FROM_FLOW,
    ],
  ] as const)('%s refuses', async (_title, xml, elementId, detail, notes) => {
    await expectEventRefusal(xml, elementId, detail, notes);
  });

  it.each([
    [
      'a task host with the handler first in document order',
      reserveDoc(
        `${RESERVE}\n    ${HANDLER}\n    ${BOUNDARY}`,
        association('CompensationBoundary', 'CancelReservation'),
      ),
      'CancelReservation',
      "'isForCompensation=\"true\"' marks 'CancelReservation' as the handler a 'bpmn:association' targets from boundary event 'CompensationBoundary' on 'ReserveRoom'",
      "note: BPMN's boundary-plus-association pattern is not imported",
      [
        'subprocess Compensated_ReserveRoom {',
        '  service ReserveRoom(class: "com.example.Reserve")',
        '  on compensation {',
        '    user CancelReservation',
        '  }',
        '}',
      ],
    ],
    [
      'a sub-process host, nested in the preview',
      reserveDoc(
        `<bpmn:subProcess id="ReserveRoom">
      <bpmn:startEvent id="RStart" />
      <bpmn:userTask id="Hold" />
      <bpmn:endEvent id="REnd" />
      <bpmn:sequenceFlow id="RF1" sourceRef="RStart" targetRef="Hold" />
      <bpmn:sequenceFlow id="RF2" sourceRef="Hold" targetRef="REnd" />
    </bpmn:subProcess>
    ${BOUNDARY}
    ${HANDLER}`,
        association('CompensationBoundary', 'CancelReservation'),
      ),
      'CompensationBoundary',
      "boundary event 'CompensationBoundary' compensates 'ReserveRoom' through the handler 'CancelReservation' its 'bpmn:association' targets",
      'note: a compensation boundary event is not imported',
      [
        'subprocess Compensated_ReserveRoom {',
        '  subprocess ReserveRoom {',
        '    start RStart',
        '    user Hold',
        '    end REnd',
        '  }',
        '  on compensation {',
        '    user CancelReservation',
        '  }',
        '}',
      ],
    ],
  ] as const)(
    'the paired compensation pattern on %s refuses with a rewrite preview that re-parses through the compiler',
    async (_title, xml, elementId, detail, note, preview) => {
      await expectEventRefusal(xml, elementId, detail, [
        note,
        'help: write it by hand instead',
        ...preview.map((line) => `    ${line}`),
      ]);
      await expectParses(`process Preview {\n${preview.join('\n')}\n}\n`);
    },
  );
});

describe('xmlToIr: boundary event import', () => {
  const boundaryXml = bpmnDefs`  <bpmn:error id="Error_Oops" errorCode="OOPS" />
  <bpmn:message id="Message_Ping" name="Ping" />
  <bpmn:signal id="Signal_Go" name="Go" />
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
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
      historyTimeToLive: HISTORY_TIME_TO_LIVE,
      errorDecls: [{ name: 'OOPS', code: 'OOPS' }],
    });
    expect(warnings).toEqual([]);
  });

  const TIMER_1H = `<bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>`;

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
    it.each([
      [
        'a missing attachedToRef',
        reviewBoundaryDoc(`<bpmn:boundaryEvent id="Orphan">
      ${TIMER_1H}
    </bpmn:boundaryEvent>`),
        'Orphan',
        "a boundary event has no 'attachedToRef'",
        'BPMN requires every boundary event to attach to an activity in its own container',
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
        'Boundary_Review_timer',
        'a boundary event carries an incoming sequence flow',
        'it is triggered by its own event, not by an incoming flow',
      ],
      [
        'cancelActivity="false" on an error boundary',
        reviewBoundaryDoc(`<bpmn:boundaryEvent id="Boundary_Review_error" attachedToRef="Review" cancelActivity="false">
      <bpmn:errorEventDefinition id="ErrDef" />
    </bpmn:boundaryEvent>`),
        'Boundary_Review_error',
        'an error boundary event cannot be non-interrupting (\'cancelActivity="false"\')',
        'BPMN gives an error boundary no non-interrupting form',
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
        'Boundary_Choose_timer',
        `'attachedToRef="Choose"' does not name a plain task, user task, service task, send task, business rule task, receive task, script task, subprocess, attempt block, or call activity that is itself a flow element of this same container`,
        'a boundary event can only attach to an activity alongside it',
      ],
      [
        // Moddle fills `incoming` from optional children alone; Operaton reads the flow's targetRef.
        'a sequence flow targeting a boundary event with no bpmn:incoming child',
        reviewBoundaryDoc(
          `<bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      ${TIMER_1H}
    </bpmn:boundaryEvent>`,
          '    <bpmn:sequenceFlow id="F0" sourceRef="PStart" targetRef="Boundary_Review_timer" />\n',
        ),
        'Boundary_Review_timer',
        'a boundary event carries an incoming sequence flow',
        'it is triggered by its own event, not by an incoming flow',
      ],
    ] as const)(
      '%s refuses with UnsupportedEventFeatureError naming the feature',
      async (_title, xml, elementId, detail, note) => {
        await expectEventRefusal(xml, elementId, detail, [`note: ${note}`]);
      },
    );
  });
});

describe('xmlToIr: intermediate catch event import', () => {
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
  const ONE_TRIGGER =
    "note: only a single 'message', 'timer', 'signal', 'condition', or 'link' trigger can be awaited";

  it.each([
    [
      'an error trigger',
      oneNodeDoc('intermediateCatchEvent', {
        id: 'Wait',
        children: '<bpmn:errorEventDefinition id="d" />',
        doc: bpmnDoc,
      }),
      "an await cannot carry a 'bpmn:ErrorEventDefinition'",
      [
        "note: only 'message', 'timer', 'signal', 'condition', or 'link' triggers can be awaited inline",
        "note: an error or an escalation is caught by an event handler and raised with 'throw' or 'emit'",
        'note: compensation is undone by a subprocess block',
        'note: a cancel is written on the end that gives up an attempt block',
      ],
    ],
    [
      'two event definitions on one catch',
      signalRootDoc(
        '',
        `      <bpmn:timerEventDefinition id="d1">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
      <bpmn:signalEventDefinition id="d2" signalRef="Signal_Ping" />`,
      ),
      'an await carries 2 event definitions',
      [ONE_TRIGGER],
    ],
    [
      'parallelMultiple="true"',
      signalRootDoc(
        'parallelMultiple="true"',
        '      <bpmn:signalEventDefinition id="d" signalRef="Signal_Ping" />',
      ),
      'an await with \'parallelMultiple="true"\' waits for several triggers together',
      [ONE_TRIGGER],
    ],
    [
      'a "none" catch with zero event definitions',
      oneNodeDoc('intermediateCatchEvent', { id: 'Wait', doc: bpmnDoc }),
      'an await has no event definition',
      [
        'note: a "none" intermediate catch waits for nothing BPMNscript can represent',
      ],
    ],
  ] as const)(
    '%s refuses with UnsupportedEventFeatureError naming the form',
    async (_title, xml, detail, notes) => {
      await expectEventRefusal(xml, 'Wait', detail, notes);
    },
  );
});

describe('xmlToIr: link events', () => {
  const LINK_DEF = '<bpmn:linkEventDefinition name="Retry" />';
  const link: EventDefinition = { kind: 'link', linkName: 'Retry' };

  interface PairOptions {
    throwAttrs?: string;
    throwChildren?: string;
    throwDef?: string;
    catchAttrs?: string;
    extraFlows?: string;
    defs?: XmlTag;
  }

  const pairDoc = ({
    throwAttrs = 'name="Retry"',
    throwChildren = '',
    throwDef = LINK_DEF,
    catchAttrs = 'name="Retry"',
    extraFlows = '',
    defs = bpmnDefs,
  }: PairOptions = {}): string =>
    defs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="A" />
    <bpmn:intermediateThrowEvent id="ToRetry" ${throwAttrs}>${throwChildren}
      ${throwDef}
    </bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="AtRetry" ${catchAttrs}>
      ${LINK_DEF}
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="A" />
    <bpmn:sequenceFlow id="F2" sourceRef="A" targetRef="ToRetry" />
    <bpmn:sequenceFlow id="F3" sourceRef="AtRetry" targetRef="E" />
${extraFlows}  </bpmn:process>`;

  it('engine settings and listeners on a link throw are reported one each and reach the IR on the catch alone', async () => {
    const { ir, warnings } = await xmlToIr(
      pairDoc({
        throwAttrs:
          'name="Retry" operaton:asyncBefore="true" operaton:jobPriority="5"',
        throwChildren: extensionElements(
          `        <operaton:failedJobRetryTimeCycle>R3/PT5M</operaton:failedJobRetryTimeCycle>
        <operaton:executionListener event="end" class="com.example.L" />
        <operaton:properties>
          <operaton:property name="k" value="v" />
        </operaton:properties>
        <operaton:inputOutput>
          <operaton:inputParameter name="x">1</operaton:inputParameter>
        </operaton:inputOutput>`,
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
        `${what} on 'ToRetry' was not imported\n` +
        `note: Operaton creates no activity for a link throw, so it never ${does} one`,
    });
    expect(warnings).toEqual([
      dropped("setting 'asyncBefore'", 'reads a setting on'),
      dropped("setting 'jobPriority'", 'reads a setting on'),
      dropped("setting 'retryCycle'", 'reads a setting on'),
      dropped("execution listener 'end'", 'runs a listener on'),
      dropped("'operaton:properties' block", 'reads a property list on'),
      dropped("'operaton:inputOutput' block", 'reads a mapping on'),
    ]);
  });

  const FLOW_HELP =
    "help: take the flow 'F4' off, and lead it from or to a step instead";

  it.each([
    [
      'a link definition with no name, on the throw',
      pairDoc({ throwDef: '<bpmn:linkEventDefinition />' }),
      'ToRetry',
      'a link definition carries no name',
      [
        'note: the name is what a link throw and its catch match on, so one without it has nothing to match',
        'help: give the link definition a name, and the same name to the throw and the catch it joins',
      ],
    ],
    [
      'a flow that leaves the link throw',
      pairDoc({
        extraFlows:
          '    <bpmn:sequenceFlow id="F4" sourceRef="ToRetry" targetRef="E" />\n',
      }),
      'ToRetry',
      "the flow 'F4' leaves the link throw 'ToRetry'",
      [
        'note: a link throw ends its path, and the token continues at the catch of the same name rather than along a flow',
        FLOW_HELP,
      ],
    ],
    [
      'a flow that enters the link catch',
      pairDoc({
        extraFlows:
          '    <bpmn:sequenceFlow id="F4" sourceRef="A" targetRef="AtRetry" />\n',
      }),
      'AtRetry',
      "the flow 'F4' enters the link catch 'AtRetry'",
      [
        'note: a link catch is entered by the throw of the same name rather than along a flow',
        FLOW_HELP,
      ],
    ],
  ] as const)('%s refuses', async (_title, xml, elementId, detail, notes) => {
    await expectEventRefusal(xml, elementId, detail, notes);
  });
});

describe('xmlToIr: a label on an event the surface gives no label to', () => {
  it.each([
    [
      'an emit',
      'its own',
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
      'an emit',
      'its id in words',
      'UndoBooking',
      'Undo Booking',
      oneNodeDoc('intermediateThrowEvent', {
        id: 'UndoBooking',
        attrs: 'name="Undo Booking"',
        children: '<bpmn:compensateEventDefinition id="d" />',
        doc: bpmnDoc,
      }),
    ],
  ] as const)(
    'on %s the label, %s, is dropped, and that is the only thing reported',
    async (surface, _which, id, label, xml) => {
      const { ir, warnings } = await xmlToIr(xml);
      expect(byId(ir, id)).not.toHaveProperty('name');
      expect(warnings).toEqual([
        {
          elementId: id,
          category: 'label',
          message:
            `label '${label}' on '${id}' was not imported\n` +
            `note: ${surface} has no label in BPMNscript`,
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
      // Form data and retry cycle share one extensionElements wrapper.
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

    const expression = await importUserTask('operaton:jobPriority="${high}"');
    expect(expression.node.jobPriority).toBe('${high}');
    expect(expression.warnings).toEqual([]);
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

  it.each([
    [
      'a humanPerformer beside operaton:assignee',
      'operaton:assignee="bob"',
      role('humanPerformer', 'Lead', 'demo'),
      "its 'bpmn:humanPerformer' element 'Lead' names an assignee ('demo') beside 'operaton:assignee=\"bob\"'",
      "note: 'BpmnParse.parseUserTaskCustomExtensions' refuses it as a duplicate assignee declaration",
    ],
    [
      'two humanPerformers',
      '',
      role('humanPerformer', 'Lead', 'demo') +
        role('humanPerformer', 'Backup', 'mary'),
      "it carries 2 'bpmn:humanPerformer' elements",
      "note: Operaton refuses to deploy more than one ('BpmnParse.parseHumanPerformer')",
    ],
  ])('%s is refused', async (_title, attrs, children, detail, note) => {
    const err = await expectRefusal<UnsupportedAssignmentError>(
      xmlToIr(oneNodeDoc('userTask', { id: 'Review', attrs, children })),
      UnsupportedAssignmentError,
      detail,
    );
    expect([err.elementId, err.message]).toEqual([
      'Review',
      [`assignment on 'Review' cannot be imported: ${detail}`, note].join('\n'),
    ]);
  });

  it.each([
    [
      'a comma inside an expression does not split',
      "user(${a}), group(x), ${groupOf(b, 'c')}",
      {
        candidateUsers: '${a}',
        candidateGroups: "x,${groupOf(b, 'c')}",
      },
      `'candidateUsers: "\${a}"' and 'candidateGroups: "x,\${groupOf(b, 'c')}"'`,
      "'operaton:candidateUsers' and 'operaton:candidateGroups'",
    ],
    [
      'a bare $ opens an expression no } closes, so the comma after it does not split either',
      'group(x), a$b, c',
      { candidateGroups: 'x,a$b, c' },
      `'candidateGroups: "x,a$b, c"'`,
      "'operaton:candidateGroups'",
    ],
    [
      'a trailing comma draws no empty candidate',
      'user(alice), user(bob),',
      { candidateUsers: 'alice,bob' },
      `'candidateUsers: "alice,bob"'`,
      "'operaton:candidateUsers'",
    ],
  ])(
    'splits a potentialOwner as parseCommaSeparatedList does: %s',
    async (_title, expression, imported, settings, attributes) => {
      const { node, warnings } = await importReview(
        '',
        role('potentialOwner', 'Team', expression),
      );
      expect(node).toEqual({ kind: 'userTask', id: 'Review', ...imported });
      expect(reported(warnings)).toEqual([
        [
          'rewritten',
          'Review',
          `'bpmn:potentialOwner' element 'Team' on 'Review' imports as ${settings}\n` +
            "note: Operaton reads its formal expression that way ('BpmnParse.parsePotentialOwnerResourceAssignment')\n" +
            `note: BPMNscript writes it back as ${attributes}, which the engine reads the same`,
        ],
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
        'rewritten',
        'Review',
        "'bpmn:humanPerformer' element 'Lead' on 'Review' imports as 'assignee: \"demo\"'\nnote: Operaton reads its formal expression that way ('BpmnParse.parseHumanPerformerResourceAssignment')\nnote: BPMNscript writes it back as 'operaton:assignee', which the engine reads the same",
      ],
      [
        'unmappedConstruct',
        'Review',
        "'resourceRef' on the 'bpmn:humanPerformer' element 'Lead' on 'Review' was not imported\nnote: Operaton reads the role's formal expression alone ('BpmnParse.parseHumanPerformerResourceAssignment')",
      ],
      [
        'unmappedConstruct',
        'Review',
        "'bpmn:potentialOwner' element 'Empty' on 'Review' was not imported\nnote: it carries no formal expression, and Operaton reads nothing else off it ('BpmnParse.parsePotentialOwnerResourceAssignment')",
      ],
      [
        'unmappedConstruct',
        'Review',
        "'bpmn:performer' element 'Actor' on 'Review' was not imported\nnote: Operaton reads a 'bpmn:humanPerformer' and a 'bpmn:potentialOwner' by tag ('BpmnParse.parseTaskDefinition') and no other resource role",
      ],
      [
        'unmappedConstruct',
        'Review',
        "'bpmn:potentialOwner' element 'XsiSpelled' on 'Review' was not imported\nnote: it carries no formal expression, and Operaton reads nothing else off it ('BpmnParse.parsePotentialOwnerResourceAssignment')",
      ],
      [
        'unmappedConstruct',
        'Svc',
        "'bpmn:potentialOwner' element 'Owner_1' on 'Svc' was not imported\nnote: BPMNscript imports the executable flow and the engine settings on its steps, and nothing declared or drawn beside it",
      ],
    ]);
  });

  it('a potential owner carrying resourceParameterBindings imports the expression and warns about the rest', async () => {
    const { node, warnings } = await importReview(
      '',
      `      <bpmn:potentialOwner id="PO_Bindings">
        <bpmn:resourceAssignmentExpression>
          <bpmn:formalExpression>user(alice)</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>
        <bpmn:resourceParameterBinding />
      </bpmn:potentialOwner>`,
    );
    expect(node).toEqual({
      kind: 'userTask',
      id: 'Review',
      candidateUsers: 'alice',
    });
    expect(reported(warnings)).toEqual([
      [
        'rewritten',
        'Review',
        "'bpmn:potentialOwner' element 'PO_Bindings' on 'Review' imports as 'candidateUsers: \"alice\"'\n" +
          "note: Operaton reads its formal expression that way ('BpmnParse.parsePotentialOwnerResourceAssignment')\n" +
          "note: BPMNscript writes it back as 'operaton:candidateUsers', which the engine reads the same",
      ],
      [
        'unmappedConstruct',
        'Review',
        "'resourceParameterBindings' on the 'bpmn:potentialOwner' element 'PO_Bindings' on 'Review' was not imported\n" +
          "note: Operaton reads the role's formal expression alone ('BpmnParse.parsePotentialOwnerResourceAssignment')",
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
        "attribute 'startQuantity' on 'Review' was not imported\nnote: Operaton's 'BpmnParse' never reads it, so the step runs as if it read 1, as the original document does",
      ],
      [
        'unmappedConstruct',
        'Svc',
        "attribute 'completionQuantity' on 'Svc' was not imported\nnote: Operaton's 'BpmnParse' never reads it, so the step runs as if it read 1, as the original document does",
      ],
    ]);
  });
});

describe('xmlToIr: flat engine settings on every carrying node kind', () => {
  const everyKindXml = operatonDefs`  <bpmn:escalation id="Escalation_Up" escalationCode="UP" />
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE} operaton:versionTag="1.4">
    <bpmn:startEvent id="Start" operaton:asyncBefore="true" />
    <bpmn:userTask id="Review" operaton:asyncBefore="true" />
    <bpmn:serviceTask id="Charge" operaton:expression="\${charge.run(execution)}"
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

  const RESPELLED_RESULT_VARIABLE = {
    elementId: 'T',
    category: 'rewritten',
    message:
      "'operaton:resultVariableName=\"out\"' on 'T' imports as 'resultVariable: \"out\"'\n" +
      "note: 'BpmnParse.parseResultVariable' reads the two spellings as one\n" +
      "note: BPMNscript writes it back as 'operaton:resultVariable', which the engine reads the same",
  };

  it.each([
    {
      title: 'a script task',
      tag: 'scriptTask',
      attrs: 'scriptFormat="groovy" operaton:resultVariableName="out"',
      children: '<bpmn:script>1</bpmn:script>',
      kind: 'scriptTask' as const,
      resultVariable: 'out',
      warnings: [RESPELLED_RESULT_VARIABLE],
    },
    {
      title:
        'both spellings written, which keeps resultVariable and reports the older one',
      tag: 'serviceTask',
      attrs:
        'operaton:expression="${svc.run()}" operaton:resultVariable="kept" ' +
        'operaton:resultVariableName="out"',
      children: '',
      kind: 'serviceTask' as const,
      resultVariable: 'kept',
      warnings: [
        {
          elementId: 'T',
          category: 'extensionAttribute',
          message:
            "setting 'resultVariableName' on 'T' was not imported\n" +
            "note: it has no effect alongside 'operaton:resultVariable'",
        },
      ],
    },
  ])(
    'the older resultVariableName spelling imports as resultVariable on $title',
    async ({ tag, attrs, children, kind, resultVariable, warnings }) => {
      const imported = await importOnly(
        oneNodeDoc(tag, { attrs, children }),
        kind,
      );
      expect(imported.node.resultVariable).toBe(resultVariable);
      expect(imported.warnings).toEqual(warnings);
    },
  );
});

describe("xmlToIr: a timer job's lock is read where BpmnParse.parseTimer reads it", () => {
  const boundaryTimerDoc = (tagAttrs: string, defAttrs: string): string =>
    operatonDefs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Host" />
    <bpmn:endEvent id="E" />
    <bpmn:boundaryEvent id="B" attachedToRef="Host" ${tagAttrs}>
      <bpmn:timerEventDefinition ${defAttrs}>
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="Escaped" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Host" />
    <bpmn:sequenceFlow id="F2" sourceRef="Host" targetRef="E" />
    <bpmn:sequenceFlow id="F3" sourceRef="B" targetRef="Escaped" />
  </bpmn:process>`;

  const handlerTimerDoc = (
    tagAttrs: string,
    defAttrs: string,
    subAttrs = '',
  ): string =>
    operatonDefs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true" ${subAttrs}>
      <bpmn:startEvent id="HStart" ${tagAttrs}>
        <bpmn:timerEventDefinition ${defAttrs}><bpmn:timeCycle>R/PT1H</bpmn:timeCycle></bpmn:timerEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>`;

  const CONTINUATION_COPY_WARNING = warning(
    'Handler',
    "setting 'jobPriority' on 'Handler' was not imported\nnote: the 'on timer' head's 'jobPriority' configures the timer job its start event creates\nnote: the event sub-process's own copy, which only its async continuation job takes, has no spelling in the script",
  );

  const BOTH_JOBS_WARNING = warning(
    'B',
    "'operaton:exclusive=\"true\"' on the event 'B' was dropped\nnote: it governs the async continuation job of the event\nnote: 'operaton:exclusive=\"false\"' on its timer definition governs the timer job\nnote: BPMNscript keeps one value for both and took the timer definition's",
  );

  it.each<
    [string, string, { tag?: string; def?: string; sub?: string }, unknown]
  >([
    [
      'the definition alone on a boundary',
      'B',
      { def: 'operaton:exclusive="false"' },
      { exclusive: false, warnings: [] },
    ],
    [
      'the tag true beside the definition false takes the definition and says which job each governs',
      'B',
      { tag: 'operaton:exclusive="true"', def: 'operaton:exclusive="false"' },
      { exclusive: false, warnings: [BOTH_JOBS_WARNING] },
    ],
    [
      "a timer job key on the event sub-process itself is dropped under one warning, since the head's copy is the start's",
      'Handler',
      { sub: 'operaton:asyncBefore="true" operaton:jobPriority="7"' },
      {
        asyncBefore: true,
        jobPriority: undefined,
        warnings: [CONTINUATION_COPY_WARNING],
      },
    ],
  ])('%s', async (_title, id, { tag = '', def = '', sub = '' }, expected) => {
    const xml =
      id === 'B' ? boundaryTimerDoc(tag, def) : handlerTimerDoc(tag, def, sub);
    const { ir, warnings } = await xmlToIr(xml);
    const node =
      id === 'Handler'
        ? subProcess(ir, id)
        : id === 'B'
          ? byId(ir, id)
          : byId(subProcess(ir, 'Handler'), id);
    const { asyncBefore, exclusive, jobPriority } = node;
    expect({ asyncBefore, exclusive, jobPriority, warnings }).toEqual(expected);
  });
});

const TIMER_CATCH = `<bpmn:intermediateCatchEvent id="C">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>P1D</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>`;

const gatewayDoc = (tag: string, attrs: string, children = ''): string =>
  operatonDoc`    <bpmn:${tag} id="G" ${attrs}>${children}</bpmn:${tag}>
    <bpmn:startEvent id="S" />
    ${TIMER_CATCH}
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="G" />
    <bpmn:sequenceFlow id="F2" sourceRef="G" targetRef="C" />
    <bpmn:sequenceFlow id="F3" sourceRef="C" targetRef="E" />`;

describe('xmlToIr: the job settings on a gateway', () => {
  it('a split written with the older async spelling carries asyncBefore and names the respelling', async () => {
    const { ir, warnings } = await xmlToIr(
      gatewayDoc('exclusiveGateway', 'operaton:async="true"'),
    );
    expect(byId(ir, 'G')).toEqual({
      kind: 'exclusiveGateway',
      id: 'G',
      asyncBefore: true,
    });
    expect(warnings.map((w) => [w.elementId, w.category, w.message])).toEqual([
      ['G', 'rewritten', asyncRespellingMessage("'G'")],
    ]);
  });
});

const serviceTaskWith = (children: string): string =>
  oneNodeDoc('serviceTask', {
    id: 'Svc',
    attrs: 'operaton:class="com.example.Svc"',
    children: extensionElements(children),
  });

const importServiceTask = (children: string) =>
  importById(serviceTaskWith(children), 'Svc', 'serviceTask');

const userTaskWith = (children: string): string =>
  oneNodeDoc('userTask', {
    id: 'Review',
    children: extensionElements(children),
  });

const importUserTaskWith = (children: string) =>
  importById(userTaskWith(children), 'Review', 'userTask');

const ioBlock = (params: string): string =>
  `        <operaton:inputOutput>\n${params}\n        </operaton:inputOutput>`;

describe('xmlToIr: input/output parameters', () => {
  it('every activity kind reads its own io block, and an event that runs one reports it naming parseActivityInputOutput', async () => {
    const xml = operatonDefs`  <bpmn:signal id="Sig" name="sig" />
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Review">${IO()}</bpmn:userTask>
    <bpmn:scriptTask id="Calc" scriptFormat="javascript">${IO()}
      <bpmn:script>1</bpmn:script>
    </bpmn:scriptTask>
    <bpmn:subProcess id="Booking">${IO()}
      <bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:sequenceFlow id="SF_B" sourceRef="BStart" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:callActivity id="Sub" calledElement="other">${IO()}</bpmn:callActivity>
    <bpmn:intermediateThrowEvent id="Throw">${IO()}
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="Wait">${IO()}
      <bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End">${IO()}</bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Calc" />
    <bpmn:sequenceFlow id="F3" sourceRef="Calc" targetRef="Booking" />
    <bpmn:sequenceFlow id="F4" sourceRef="Booking" targetRef="Sub" />
    <bpmn:sequenceFlow id="F5" sourceRef="Sub" targetRef="Throw" />
    <bpmn:sequenceFlow id="F6" sourceRef="Throw" targetRef="Wait" />
    <bpmn:sequenceFlow id="F7" sourceRef="Wait" targetRef="End" />
  </bpmn:process>`;

    const { ir, warnings } = await xmlToIr(xml);
    const carried = ir.flowElements
      .filter(
        (fe) => 'inputParameters' in fe && fe.inputParameters !== undefined,
      )
      .map((fe) => fe.id);
    expect(carried).toEqual(['Review', 'Calc', 'Booking', 'Sub']);
    expect(warnings).toEqual([
      unread(
        "'operaton:inputOutput'",
        'Throw',
        "a 'bpmn:intermediateThrowEvent'",
        "reads it on every throw but a link ('BpmnParse.parseActivityInputOutput')",
      ),
      unread(
        "'operaton:inputOutput'",
        'Wait',
        "a 'bpmn:intermediateCatchEvent'",
        "reads it ('BpmnParse.parseActivityInputOutput')",
      ),
      unread(
        "'operaton:inputOutput'",
        'End',
        "a 'bpmn:endEvent'",
        "reads its input parameters ('BpmnParse.parseActivityInputOutput')",
      ),
    ]);
  });

  const svcWarning = (message: string): ImportWarning => ({
    elementId: 'Svc',
    category: 'extensionAttribute',
    message,
  });
  const valueAttr = (attr: string): ImportWarning =>
    svcWarning(
      `'${attr}' on an 'operaton:value' in an 'operaton:list' in an 'operaton:inputParameter' named 'x' in an 'operaton:inputOutput' on 'Svc' was not imported\n` +
        "note: BPMNscript reads no such setting on an 'operaton:value'\n" +
        'note: the rebuilt document carries none',
    );

  it.each([
    {
      title: 'a parameter with an empty body imports as empty text',
      children: ioBlock('          <operaton:inputParameter name="nothing" />'),
      params: [ioParam('nothing', textValue(''))],
      warnings: [],
    },
    {
      title:
        'a parameter carrying body text beside one nested child keeps the child and warns on the text',
      children: ioBlock(
        `          <operaton:inputParameter name="x">text<operaton:list><operaton:value>a</operaton:value></operaton:list></operaton:inputParameter>`,
      ),
      params: [ioParam('x', listValue([textValue('a')]))],
      warnings: [
        svcWarning(
          "body text of 'operaton:inputParameter' 'x' was not imported\n" +
            "note: it carries a nested 'operaton:List' value beside it\n" +
            "note: 'BpmnParseUtil.parseNestedParamValueProvider' reads the nested value and never the text\n" +
            'note: the rebuilt document carries the nested value alone',
        ),
      ],
    },
    {
      title:
        'an operaton:value carrying a modeler id and name reports each, naming the path down to it',
      children: ioBlock(`          <operaton:inputParameter name="x">
            <operaton:list>
              <operaton:value id="Item_1" name="First">z</operaton:value>
            </operaton:list>
          </operaton:inputParameter>`),
      params: [ioParam('x', listValue([textValue('z')]))],
      warnings: [valueAttr('id'), valueAttr('name')],
    },
    {
      title:
        'a foreign attribute on the operaton:inputOutput block itself reports',
      children: `        <operaton:inputOutput xmlns:foo="http://foo.example" foo:bar="1">
          <operaton:inputParameter name="x">v</operaton:inputParameter>
        </operaton:inputOutput>`,
      params: [ioParam('x', textValue('v'))],
      warnings: [
        svcWarning(
          "'foo:bar' on an 'operaton:inputOutput' on 'Svc' was not imported\n" +
            "note: BPMNscript reads no such setting on an 'operaton:inputOutput'\n" +
            'note: the rebuilt document carries none',
        ),
      ],
    },
  ])('$title', async ({ children, params, warnings: expected }) => {
    const { node: task, warnings } = await importServiceTask(children);
    expect(task.inputParameters).toEqual(params);
    expect(warnings).toEqual(expected);
  });

  const IO = (
    params = '<operaton:inputParameter name="amount">1</operaton:inputParameter>',
  ): string =>
    extensionElements(`        <operaton:inputOutput>
          ${params}
        </operaton:inputOutput>`);

  const ioRefusal = (
    tag: string,
    method: string,
    suffix = '',
  ): [string, string[]] => [
    `an 'operaton:inputOutput' mapping on a 'bpmn:${tag}'`,
    [
      `note: 'BpmnParse.${method}' fails the deployment on it ("operaton:inputOutput mapping unsupported for element type '${tag}'${suffix}")`,
    ],
  ];

  const TRIGGERED = " with attribute 'triggeredByEvent = true'";

  it.each([
    [
      "the process's own start",
      operatonDoc`    <bpmn:startEvent id="S">${IO()}</bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      'S',
      ioRefusal('startEvent', 'ensureNoIoMappingDefined'),
    ],
    [
      "an event handler's start",
      handlerDoc(`<bpmn:errorEventDefinition />${IO()}`, {
        defs: operatonDefs,
      }),
      'HStart',
      ioRefusal('startEvent', 'ensureNoIoMappingDefined'),
    ],
    [
      'a boundary event',
      operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="B" attachedToRef="Review">${IO()}
      <bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="E" />
    <bpmn:sequenceFlow id="F3" sourceRef="B" targetRef="E" />`,
      'B',
      ioRefusal('boundaryEvent', 'ensureNoIoMappingDefined'),
    ],
    [
      'a parallelGateway',
      gatewayDoc('parallelGateway', '', IO()),
      'G',
      ioRefusal('parallelGateway', 'checkActivityInputOutputSupported'),
    ],
    [
      'an event sub-process',
      handlerDoc('<bpmn:errorEventDefinition />', {
        defs: operatonDefs,
        body: `${IO()}      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
`,
      }),
      'Handler',
      ioRefusal('subProcess', 'checkActivityInputOutputSupported', TRIGGERED),
    ],
    [
      'an output parameter on an end event',
      operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E">${IO('<operaton:outputParameter name="out">1</operaton:outputParameter>')}</bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      'E',
      [
        "an 'operaton:outputParameter' on a 'bpmn:endEvent'",
        [
          "note: 'BpmnParse.checkActivityOutputParameterSupported' fails the deployment on it (\"operaton:outputParameter not allowed for element type 'endEvent'\")",
        ],
      ],
    ],
  ] as const)(
    'an io mapping on %s refuses, quoting the parser that fails the deployment',
    async (_title, xml, elementId, [detail, notes]) => {
      await expectExtensionRefusal(xml, elementId, detail, notes);
    },
  );
});

describe('xmlToIr: execution listeners', () => {
  it('a listener on the process, a flow or a gateway is dropped naming the parser that runs it', async () => {
    const listener = (event: string): string =>
      extensionElements(
        `        <operaton:executionListener event="${event}" class="com.example.L" />`,
      );
    const { warnings } = await xmlToIr(
      operatonDefs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>${listener('start')}
    <bpmn:startEvent id="S" />
    <bpmn:exclusiveGateway id="G">${listener('end')}</bpmn:exclusiveGateway>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="G" />
    <bpmn:sequenceFlow id="F2" sourceRef="G" targetRef="E">${listener('take')}</bpmn:sequenceFlow>
  </bpmn:process>`,
    );
    expect(warnings).toEqual([
      unread(
        "'operaton:executionListener' named 'start'",
        'p',
        "a 'bpmn:process'",
        "runs it on the process instance ('BpmnParse.parseExecutionListenersOnScope')",
      ),
      unread(
        "'operaton:executionListener' named 'end'",
        'G',
        "a 'bpmn:exclusiveGateway'",
        "runs it ('BpmnParse.parseExecutionListenersOnScope')",
      ),
      unread(
        "'operaton:executionListener' named 'take'",
        'F2',
        "a 'bpmn:sequenceFlow'",
        'runs it when the flow is taken, whatever its event says ' +
          "('BpmnParse.parseExecutionListenersOnTransition')",
      ),
    ]);
  });

  it.each([
    {
      case: 'an empty expression carries as written, since ExpressionExecutionListener evaluates it rather than refusing it',
      children: `        <operaton:executionListener event="start" expression="" />`,
      listeners: [{ event: 'start', binding: exprBinding('') }],
      warnings: [
        {
          elementId: 'Svc',
          category: 'carriedAsWritten',
          message:
            "an 'operaton:executionListener' on 'Svc' has 'expression=\"\"'\n" +
            "note: 'ExpressionExecutionListener' evaluates the empty text rather than refusing it\n" +
            'note: the rebuilt document carries it',
        },
      ],
    },
    {
      case: 'a second attribute binding is shadowed by the one BpmnParse.parseExecutionListener resolves first',
      children: `        <operaton:executionListener event="start" class="com.example.A" expression="\${e}" />`,
      listeners: [{ event: 'start', binding: classBinding('com.example.A') }],
      warnings: [
        {
          elementId: 'Svc',
          category: 'extensionAttribute',
          message:
            "setting 'expression' on an 'operaton:executionListener' on 'Svc' was not imported\n" +
            "note: it has no effect alongside 'class'",
        },
      ],
    },
  ] as const)('$case', async ({ children, listeners, warnings: expected }) => {
    const { node: task, warnings } = await importServiceTask(children);
    expect(task.executionListeners).toEqual(listeners);
    expect(warnings).toEqual(expected);
  });
});

describe('xmlToIr: task listeners', () => {
  it.each([
    {
      case: 'the five non-timeout events import in emission order, each with its binding',
      children: `        <operaton:taskListener event="create" class="com.example.C" />
        <operaton:taskListener event="assignment" expression="\${bean.assign()}" />
        <operaton:taskListener event="complete" delegateExpression="\${bean}" />
        <operaton:taskListener event="update" class="com.example.U" />
        <operaton:taskListener event="delete" class="com.example.D" />`,
      listeners: [
        { event: 'create', binding: classBinding('com.example.C') },
        { event: 'assignment', binding: exprBinding('${bean.assign()}') },
        { event: 'complete', binding: delegateBinding('${bean}') },
        { event: 'update', binding: classBinding('com.example.U') },
        { event: 'delete', binding: classBinding('com.example.D') },
      ],
      warnings: [],
    },
    {
      case: 'a timeout listener carries its timer as a timer event definition',
      children: `        <operaton:taskListener event="timeout" class="com.example.T">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT8H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
      listeners: [
        {
          event: 'timeout',
          binding: classBinding('com.example.T'),
          timer: timerDef('duration', 'PT8H'),
        },
      ],
      warnings: [],
    },
    {
      case: 'an empty class carries as written, since parseTaskListener checks no attribute for emptiness',
      children: `        <operaton:taskListener event="create" class="" />`,
      listeners: [{ event: 'create', binding: classBinding('') }],
      warnings: [
        {
          elementId: 'Review',
          category: 'carriedAsWritten',
          message:
            "an 'operaton:taskListener' on 'Review' has 'class=\"\"' and fails when its event fires\n" +
            "note: 'BpmnParse.parseTaskListener' checks no listener attribute for emptiness, so the task deploys\n" +
            'note: the rebuilt document carries the empty text',
        },
      ],
    },
    {
      case: 'an empty expression on a task listener carries as written, since ExpressionTaskListener evaluates it rather than failing',
      children: `        <operaton:taskListener event="complete" expression="" />`,
      listeners: [{ event: 'complete', binding: exprBinding('') }],
      warnings: [
        {
          elementId: 'Review',
          category: 'carriedAsWritten',
          message:
            "an 'operaton:taskListener' on 'Review' has 'expression=\"\"'\n" +
            "note: 'ExpressionTaskListener' evaluates the empty text rather than refusing it\n" +
            'note: the rebuilt document carries it',
        },
      ],
    },
    {
      case: 'an empty delegateExpression on a task listener warns the same way as an empty class',
      children: `        <operaton:taskListener event="update" delegateExpression="" />`,
      listeners: [{ event: 'update', binding: delegateBinding('') }],
      warnings: [
        {
          elementId: 'Review',
          category: 'carriedAsWritten',
          message:
            "an 'operaton:taskListener' on 'Review' has 'delegateExpression=\"\"' and fails when its event fires\n" +
            "note: 'BpmnParse.parseTaskListener' checks no listener attribute for emptiness, so the task deploys\n" +
            'note: the rebuilt document carries the empty text',
        },
      ],
    },
    {
      case: 'operaton:exclusive on a timeout timer imports the timer and reports the lock flag the surface cannot carry',
      children: `        <operaton:taskListener event="timeout" class="com.example.T">
          <bpmn:timerEventDefinition operaton:exclusive="false">
            <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
      listeners: [
        {
          event: 'timeout',
          binding: classBinding('com.example.T'),
          timer: timerDef('duration', 'PT1H'),
        },
      ],
      warnings: [
        {
          elementId: 'Review',
          category: 'extensionAttribute',
          message:
            "'operaton:exclusive=\"false\"' on the timer of an 'operaton:taskListener' with 'event=\"timeout\"' on 'Review' was not imported\n" +
            'note: BPMNscript has no setting for it there\n' +
            "note: Operaton locks the timeout job by it ('BpmnParse.parseTimeoutTaskListener' through 'parseTimer'), so the rebuilt document runs without it",
        },
      ],
    },
    {
      case: 'a timer under a non-timeout listener warns and drops, since parseTaskListener reads no event definition there',
      children: `        <operaton:taskListener event="create" class="com.example.C">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
      listeners: [{ event: 'create', binding: classBinding('com.example.C') }],
      warnings: [
        {
          elementId: 'Review',
          category: 'extensionAttribute',
          message:
            "'bpmn:TimerEventDefinition' on an 'operaton:taskListener' with 'event=\"create\"' was not imported\n" +
            "note: 'BpmnParse.parseTaskListener' reads no event definition off a listener that is not a timeout\n" +
            'note: the rebuilt document carries none',
        },
      ],
    },
  ] as const)('$case', async ({ children, listeners, warnings: expected }) => {
    const { node: task, warnings } = await importUserTaskWith(children);
    expect(task.taskListeners).toEqual(listeners);
    expect(warnings).toEqual(expected);
  });
});

const field = (attrs: string, body = ''): string =>
  body === ''
    ? `        <operaton:field ${attrs} />`
    : `        <operaton:field ${attrs}>${body}</operaton:field>`;

const boundElsewhere = (binding: string): string =>
  'Operaton injects a field into a class, a delegate or a built-in mail or ' +
  `shell binding and into no other\nnote: this one is bound by ${binding}`;

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

  const warned = (message: string): ImportWarning => ({
    elementId: 'Svc',
    category: 'extensionAttribute',
    message,
  });

  const rewrote = (message: string): ImportWarning => ({
    ...warned(message),
    category: 'rewritten',
  });

  const dropped = (reason: string, name = "'greeting'"): ImportWarning =>
    warned(`injected field ${name} on 'Svc' was not imported\nnote: ${reason}`);

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
      'an operaton:string child carries, and warns that export writes it back as a stringValue attribute',
      'serviceTask',
      CLASS,
      field('name="greeting"', '<operaton:string>hello</operaton:string>'),
      SVC_INJECTED,
      [
        rewrote(
          "injected field 'greeting' on 'Svc' is rewritten from an 'operaton:string' child to a 'stringValue' attribute\n" +
            'note: the engine injects the same text either way',
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
          "a 'stringValue' attribute holding '${who}' would be written back " +
            "as an 'operaton:expression' child, and the engine would evaluate " +
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
          "an 'operaton:expression' child holding " +
            "'hello\\n          world' would be written back as a 'stringValue' " +
            'attribute, and the engine would inject that text rather than ' +
            'evaluate it',
        ),
      ],
    ],
    [
      'a pretty-printed operaton:expression child drops, because the engine evaluates the body it is handed untrimmed and the script has no template opening after whitespace',
      'serviceTask',
      CLASS,
      field(
        'name="greeting"',
        '\n          <operaton:expression>\n            ${who}\n          </operaton:expression>\n        ',
      ),
      SVC,
      [
        dropped(
          "an 'operaton:expression' child holding " +
            "'\\n            ${who}\\n          ' would be written back as a " +
            'quoted literal the compiler refuses, since a raw template opens ' +
            'directly after its quote',
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
          "'operaton:expression' child of the injected field 'greeting' on 'Svc' was not imported\n" +
            "note: it has no effect alongside a 'stringValue' attribute",
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
      'a decision binding receives no field list, so the field drops',
      'businessRuleTask',
      'operaton:decisionRef="riskRating" operaton:decisionRefBinding="latest"',
      GREETING,
      {
        kind: 'decision',
        decisionRef: 'riskRating',
        binding: { kind: 'latest' },
      },
      [dropped(boundElsewhere("an 'operaton:decisionRef'"))],
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
    expect(warnings).toEqual([
      {
        elementId: 'Review',
        category: 'extensionAttribute',
        message:
          "injected field 'greeting' on 'Review' was not imported\n" +
          'note: BPMNscript carries an injected field on the step or the listener whose class or delegate binding receives it, on the step whose built-in mail or shell behaviour does, and on no other position',
      },
    ]);
  });
});

describe('xmlToIr: a mail or shell task imports with its fields on the three tags', () => {
  const TO = field('name="to" stringValue="ops@example.com"');
  const COMMAND = field('name="command" stringValue="echo"');
  const MAIL_FIELDS = [
    TO,
    field(
      'name="text"',
      '<operaton:expression>${report}</operaton:expression>',
    ),
  ].join('\n');
  const SHELL_FIELDS = [
    COMMAND,
    field('name="outputVariable" stringValue="out"'),
  ].join('\n');
  const MAIL = builtinBinding('mail', [
    { name: 'to', value: 'ops@example.com' },
    { name: 'text', value: '${report}' },
  ]);
  const SHELL_INJECTED = [
    { name: 'command', value: 'echo' },
    { name: 'outputVariable', value: 'out' },
  ];
  const SHELL = builtinBinding('shell', SHELL_INJECTED);
  const shadowed = (attr: string, winner: string): ImportWarning => ({
    elementId: 'T',
    category: 'extensionAttribute',
    message: `setting '${attr}' on 'T' was not imported\nnote: it has no effect alongside '${winner}'`,
  });

  it.each([
    {
      title:
        'operaton:type="Shell" imports lower-case, and a resultVariable beside it stays on the node with the never-read warning',
      tag: 'serviceTask',
      attrs: 'operaton:type="Shell" operaton:resultVariable="out"',
      fields: SHELL_FIELDS,
      node: { binding: SHELL, resultVariable: 'out' },
      warnings: [
        {
          elementId: 'T',
          category: 'carriedAsWritten',
          message:
            "result variable 'out' on 'T' is never written\n" +
            'note: it was imported as written, and the printed script draws a warning at the step\n' +
            "note: 'BpmnParse.parseServiceTaskLike' hands it to an expression binding alone, so an 'operaton:type' binding never writes it",
        },
      ],
    },
    {
      title:
        'a shell flag spelled TRUE imports as written with a warning, since the engine deploys it and reads it as false',
      tag: 'serviceTask',
      attrs: 'operaton:type="shell"',
      fields: `${SHELL_FIELDS}\n${field('name="wait" stringValue="TRUE"')}`,
      node: {
        binding: builtinBinding('shell', [
          ...SHELL_INJECTED,
          { name: 'wait', value: 'TRUE' },
        ]),
      },
      warnings: [
        {
          elementId: 'T',
          category: 'carriedAsWritten',
          message:
            "shell field 'wait' on 'T' is 'TRUE', which the engine reads as false\n" +
            'note: it was imported as written, and the printed script draws an error at the field\n' +
            "note: 'ShellActivityBehavior.readFields' compares it with 'true' case-sensitively",
        },
      ],
    },
    {
      title:
        'a class and a topic beside type="mail" are reported as shadowed, as the engine never reaches them',
      tag: 'serviceTask',
      attrs:
        'operaton:class="com.example.Svc" operaton:type="mail" operaton:topic="notify"',
      fields: MAIL_FIELDS,
      node: { binding: MAIL },
      warnings: [
        shadowed('class', 'operaton:type="mail"'),
        shadowed('topic', 'operaton:type="mail"'),
      ],
    },
  ])('$title', async ({ tag, attrs, fields, node, warnings }) => {
    const imported = await importOnly(
      oneNodeDoc(tag, { attrs, children: extensionElements(fields) }),
      'serviceTask',
    );
    expect(imported.node).toEqual({ kind: 'serviceTask', id: 'T', ...node });
    expect(imported.warnings).toEqual(warnings);
  });
});

describe('xmlToIr: a service-like task the engine would refuse is refused with its rule', () => {
  const TO = field('name="to" stringValue="ops@example.com"');
  const TEXT = field('name="text" stringValue="Report attached"');
  const COMMAND = field('name="command" stringValue="echo"');
  const SUPPORTED_FORMS = [
    'note: the supported forms are a Java class, an expression, a delegate expression, an external task topic, a built-in mail or shell task with its fields, or a decision reference on a business rule task',
    "note: their attributes are 'operaton:class' (or the deprecated 'camunda:class' alias), 'operaton:expression', 'operaton:delegateExpression', 'operaton:type=\"external\"' with 'operaton:topic', 'operaton:type=\"mail\"' or 'operaton:type=\"shell\"' with their 'operaton:field' children, and 'operaton:decisionRef'",
  ];

  const typed = (type: string, fields: string[], attrs = ''): string =>
    oneNodeDoc('serviceTask', {
      attrs: `operaton:type="${type}" ${attrs}`,
      children: fields.length === 0 ? '' : extensionElements(fields.join('\n')),
    });

  it.each([
    [
      'an external type without a topic',
      oneNodeDoc('serviceTask', { attrs: 'operaton:type="external"' }),
      'Service task',
      'T',
      "'operaton:type=\"external\"' without an 'operaton:topic'",
      SUPPORTED_FORMS,
    ],
    [
      'a connector, which the Connect plugin runs in place of the binding beside it',
      oneNodeDoc('serviceTask', {
        children: extensionElements(
          '<operaton:connector><operaton:connectorId>http-connector</operaton:connectorId></operaton:connector>',
        ),
      }),
      'Service task',
      'T',
      "an 'operaton:connector' element",
      [
        "note: the Connect plugin runs it in place of whatever 'operaton:class', 'expression', 'delegateExpression' or 'type' names beside it",
        'note: an engine without the plugin runs that binding instead of it, so the same file has two possible executions',
        ...SUPPORTED_FORMS,
      ],
    ],
    [
      'a send task with no binding, named as a send task',
      oneNodeDoc('sendTask'),
      'Send task',
      'T',
      'no execution discriminator',
      SUPPORTED_FORMS,
    ],
    [
      'a shell task with a field written as an expression',
      typed('shell', [
        COMMAND,
        field('name="arg1"', '<operaton:expression>${x}</operaton:expression>'),
      ]),
      'Service task',
      'T',
      "'operaton:type=\"shell\"' with the field 'arg1' written as an 'operaton:expression'",
      [
        "note: Operaton fails to deploy it, since 'BpmnParse.validateFieldDeclarationsForShell' casts every shell field to a 'FixedValue', and an expression is not one",
      ],
    ],
    [
      'a shell wait flag outside true and false',
      typed('shell', [COMMAND, field('name="wait" stringValue="yes"')]),
      'Service task',
      'T',
      "'operaton:type=\"shell\"' with the field 'wait' set to 'yes'",
      [
        'note: Operaton refuses to deploy it with "undefined value for shell wait parameter :yes" (\'BpmnParse.validateFieldDeclarationsForShell\')',
      ],
    ],
    [
      'a mail task with no fields at all, the same as one missing "to"',
      typed('mail', []),
      'Service task',
      'T',
      "'operaton:type=\"mail\"' without a 'to' field",
      [
        'note: Operaton refuses to deploy it with "No recipient is defined on the mail activity" (\'BpmnParse.validateFieldDeclarationsForEmail\')',
      ],
    ],
    [
      'a mail field the behaviour does not declare',
      typed('mail', [TO, TEXT, field('name="recipient" stringValue="x"')]),
      'Service task',
      'T',
      "'operaton:type=\"mail\"' with a field 'recipient', which the mail behaviour does not declare",
      [
        "note: Operaton refuses to deploy it with \"Field definition uses unexisting field 'recipient'\" ('ClassDelegateUtil.applyFieldDeclaration')",
      ],
    ],
    [
      'an operaton:type outside mail, shell and external, beside the class it outranks',
      typed('ftp', [], 'operaton:class="com.example.Svc"'),
      'Service task',
      'T',
      '\'operaton:type="ftp"\'',
      [
        "note: Operaton resolves it ahead of the 'operaton:class' alongside it",
        ...SUPPORTED_FORMS,
      ],
    ],
    [
      'a business rule task with a mapDecisionResult outside the four Operaton accepts',
      oneNodeDoc('businessRuleTask', {
        attrs:
          'operaton:decisionRef="d" operaton:mapDecisionResult="firstEntry"',
      }),
      'Business rule task',
      'T',
      '\'operaton:mapDecisionResult="firstEntry"\'',
      [
        'note: it is not a way of filling the result variable BPMNscript can represent',
      ],
    ],
    [
      'a business rule task with a tenant, as the call activity does',
      oneNodeDoc('businessRuleTask', {
        attrs: 'operaton:decisionRef="d" operaton:decisionRefTenantId="acme"',
      }),
      'Business rule task',
      'T',
      'it names \'operaton:decisionRefTenantId="acme"\'',
      [
        "note: it pins the tenant 'BpmnParse.parseTenantId' resolves the decision against",
        'note: dropping it would change which decision runs, and BPMNscript has no tenant setting',
      ],
    ],
    [
      'a built-in type on the definition of a thrown message',
      operatonDefs`  <bpmn:message id="Message_1" name="OrderReceived" />
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="Typed">
      <bpmn:messageEventDefinition id="md" messageRef="Message_1" operaton:type="mail" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Typed" />
  </bpmn:process>`,
      'Thrown message',
      'Typed',
      '\'operaton:type="mail"\'',
      [
        'note: BPMNscript carries it on a service, send or business rule task alone',
        ...THROWN_MESSAGE_FORMS,
      ],
    ],
  ] as const)(
    '%s refuses',
    async (_title, xml, subject, id, construct, notes) => {
      const e = await expectRefusal<UnsupportedServiceTaskFormError>(
        xmlToIr(xml),
        UnsupportedServiceTaskFormError,
      );
      expect([e.subject, e.serviceTaskId, e.construct, e.message]).toEqual([
        subject,
        id,
        construct,
        [
          `${subject.toLowerCase()} '${id}' uses an unsupported execution form: ${construct}`,
          ...notes,
        ].join('\n'),
      ]);
    },
  );
});

describe('xmlToIr: a user task names a deployed form by reference', () => {
  const importFormRef = (attrs: string) =>
    importOnly(oneNodeDoc('userTask', { attrs }), 'userTask');

  it.each([
    [
      'a formRef resolving to the form deployed alongside the process imports the key and the binding together, reporting nothing',
      'operaton:formRef="review-form" operaton:formRefBinding="deployment"',
      { key: 'review-form', binding: { kind: 'deployment' } },
      [],
    ],
    [
      'a version the binding beside it never resolves is reported, and the reference still imports',
      'operaton:formRef="review-form" operaton:formRefBinding="latest" operaton:formRefVersion="3"',
      { key: 'review-form', binding: { kind: 'latest' } },
      [
        "setting 'formRefVersion' on 'T' was not imported\n" +
          'note: it has no effect without \'formRefBinding="version"\'',
      ],
    ],
    [
      'a binding and a version with no formRef to pin are both reported, and the task still imports',
      'operaton:formRefBinding="latest" operaton:formRefVersion="3"',
      undefined,
      [
        "setting 'formRefBinding' on 'T' was not imported\n" +
          "note: it has no effect without an 'operaton:formRef'",
        "setting 'formRefVersion' on 'T' was not imported\n" +
          "note: it has no effect without an 'operaton:formRef'",
      ],
    ],
  ] as const)('%s', async (_title, attrs, formRef, messages) => {
    const { node, warnings } = await importFormRef(attrs);
    expect(node).toEqual({
      kind: 'userTask',
      id: 'T',
      ...(formRef === undefined ? {} : { formRef }),
    });
    expect(warnings.map((w) => w.message)).toEqual(messages);
  });

  it.each([
    [
      'a formKey beside a formRef',
      'operaton:formKey="embedded:app:forms/review.html" operaton:formRef="review-form" operaton:formRefBinding="latest"',
      "it names an 'operaton:formKey' beside the 'operaton:formRef'",
      [
        'note: a task renders one form',
        'note: Operaton refuses to deploy a user task that names both a form key and a form reference',
      ],
    ],
    [
      'a formRef with no binding to resolve it',
      'operaton:formRef="review-form"',
      "its 'operaton:formRef' carries no 'operaton:formRefBinding'",
      [
        'note: the engine cannot resolve which deployed form to render',
        'note: Operaton refuses to deploy a user task whose form reference has no binding',
      ],
    ],
    [
      'a formRef bound by a word this tool cannot represent',
      'operaton:formRef="review-form" operaton:formRefBinding="versionTag"',
      "'formRefBinding=\"versionTag\"' is outside the bindings 'BpmnParse.parseFormDefinition' resolves",
      [
        "note: it resolves 'deployment', 'latest' and 'version', and the engine refuses to deploy any other",
      ],
    ],
  ])(
    '%s refuses, rather than importing a task Operaton would not deploy',
    async (_title, attrs, detail, notes) => {
      const error = await expectRefusal(
        xmlToIr(oneNodeDoc('userTask', { attrs })),
        UnsupportedFormReferenceError,
        detail,
      );
      expect(error.message).toBe(
        [`form reference on 'T' cannot be imported: ${detail}`, ...notes].join(
          '\n',
        ),
      );
    },
  );
});

describe('xmlToIr: an initiator and a form on a start that is not the process own', () => {
  const START_FORM = `<bpmn:extensionElements>
          <operaton:formData>
            <operaton:formField id="reason" type="string" />
          </operaton:formData>
        </bpmn:extensionElements>`;

  const dropped = (id: string): ImportWarning[] => [
    {
      elementId: id,
      category: 'extensionAttribute',
      message:
        `setting 'operaton:initiator' on '${id}' was not imported\n` +
        "note: 'BpmnParse.parseScopeStartEvent' reads no 'operaton:' attribute " +
        "off a start that is not the process's own\n" +
        "note: 'parseProcessDefinitionStartEvent' reads it on the process's own start alone\n" +
        'note: the rebuilt document runs the same',
    },
    {
      elementId: id,
      category: 'extensionAttribute',
      message:
        `'operaton:formData' block on '${id}' was not imported\n` +
        "note: 'BpmnParse.parseStartFormHandlers' runs for the process's own " +
        "start alone, and 'parseScopeStartEvent' reads no form\n" +
        'note: the rebuilt document runs the same',
    },
  ];

  it('a handler start drops both with one warning each, naming the reader that never runs there', async () => {
    const { ir, warnings } = await xmlToIr(
      handlerDoc(`${START_FORM}\n        <bpmn:errorEventDefinition />`, {
        startAttrs: 'operaton:initiator="who"',
        defs: operatonDefs,
      }),
    );
    const start = byId(subProcess(ir, 'Handler'), 'HStart');
    expect(start.kind === 'startEvent' && 'initiator' in start).toBe(false);
    expect(start.kind === 'startEvent' && 'formFields' in start).toBe(false);
    expect(warnings).toEqual(dropped('HStart'));
  });
});

const formOn = (fields: string): string =>
  `        <operaton:formData>\n${fields}\n        </operaton:formData>`;

const importForm = (fields: string) => importUserTaskWith(formOn(fields));

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

  const CONSTRAINT_NAMES = [
    "note: Operaton registers 'required', 'readonly', 'min', 'max', 'minlength', and 'maxlength', and reads a custom validator class or expression off 'validator'",
    "note: 'FormValidators.createValidator' fails the deployment on any other name",
  ];

  it.each([
    {
      case: 'a name Operaton registers no validator for',
      constraints:
        '              <operaton:constraint name="minimum" config="0" />',
      name: 'minimum',
      detail: 'no validator is registered under that name',
      notes: CONSTRAINT_NAMES,
    },
    {
      case: 'a constraint with no name',
      constraints: '              <operaton:constraint config="0" />',
      name: '(none)',
      detail: 'it has no name',
      notes: CONSTRAINT_NAMES,
    },
    {
      case: "a 'validator' with no config",
      constraints: '              <operaton:constraint name="validator" />',
      name: 'validator',
      detail: 'it has no config',
      notes: [
        "note: 'FormValidators.createValidator' needs a class name or an expression in its config",
      ],
    },
    {
      case: "a 'min' with no config",
      constraints: '              <operaton:constraint name="min" />',
      name: 'min',
      detail: 'it has no config',
      notes: [
        "note: 'MinValidator.validate' parses its config on every submission",
      ],
    },
    {
      case: "'required' written twice",
      constraints: `              <operaton:constraint name="required" />
              <operaton:constraint name="required" />`,
      name: 'required',
      detail: 'the field carries it twice',
      notes: [
        "note: 'DefaultFormHandler.parseValidation' deploys both, and BPMNscript holds each constraint once per field",
      ],
    },
  ])('refuses $case', async ({ constraints, name, detail, notes }) => {
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
    expect([
      err.elementId,
      err.fieldId,
      err.constraintName,
      err.message,
    ]).toEqual([
      'Review',
      'amount',
      name,
      [
        `constraint '${name}' on form field 'amount' of 'Review' cannot be imported: ${detail}`,
        ...notes,
      ].join('\n'),
    ]);
  });

  const reviewWarning = (message: string) => warning('Review', message);
  const carried = (message: string) =>
    warning('Review', message, 'carriedAsWritten');
  const rewrote = (message: string) => warning('Review', message, 'rewritten');

  it.each([
    {
      case: 'a datePattern on a string field is dropped',
      field: `          <operaton:formField id="note" type="string" datePattern="dd/MM/yyyy" />`,
      imported: { id: 'note', type: 'string' },
      warnings: [
        reviewWarning(
          "'datePattern' on form field 'note' of 'Review' was not imported\nnote: 'FormTypes.parseFormPropertyType' reads it on a date field alone",
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
          "2 'operaton:value' children of form field 'note' of 'Review' were not imported\nnote: 'FormTypes.parseFormPropertyType' reads them on an enum field alone",
        ),
      ],
    },
    {
      case: 'a single operaton:value on a string field is dropped, reported in the singular',
      field: `          <operaton:formField id="note" type="string">
            <operaton:value id="a" name="A" />
          </operaton:formField>`,
      imported: { id: 'note', type: 'string' },
      warnings: [
        reviewWarning(
          "1 'operaton:value' child of form field 'note' of 'Review' was not imported\nnote: 'FormTypes.parseFormPropertyType' reads them on an enum field alone",
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
        reviewWarning(
          "config 'true' on the 'required' constraint of form field 'note' of 'Review' was not imported\nnote: 'RequiredValidator.validate' never reads it",
        ),
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
        carried(
          "the engine cannot use 'min' constraint on form field 'note' of 'Review' as written\nnote: 'min' fits a number field alone, and 'note' is a string field, whose every submitted value 'MinValidator.validate' refuses\nnote: it was imported as written, and the printed script draws an error at the field",
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
        carried(
          "the engine cannot use 'min' constraint on form field 'amount' of 'Review' as written\nnote: 'MinValidator.validate' parses its config as an integer on every submission, and 'abc' is not one\nnote: it was imported as written, and the printed script draws an error at the field",
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
        carried(
          "the engine cannot use default 'zzz' on form field 'plan' of 'Review' as written\nnote: it names none of the field's values, and 'EnumFormType.validateValue' refuses it on every render of the form\nnote: it was imported as written, and the printed script draws an error at the field",
        ),
      ],
    },
    {
      case: 'a decimal default on a number field is carried and the script draws an error',
      field: `          <operaton:formField id="amount" type="long" defaultValue="1.5" />`,
      imported: { id: 'amount', type: 'number', defaultValue: '1.5' },
      warnings: [
        carried(
          "the engine cannot use default '1.5' on form field 'amount' of 'Review' as written\nnote: 'LongFormType.convertValue' parses it with 'Long.valueOf' on every render of the form, and it is not an integer\nnote: it was imported as written, and the printed script draws an error at the field",
        ),
      ],
    },
    {
      case: 'a word default on a boolean field is carried and the script draws an error',
      field: `          <operaton:formField id="flag" type="boolean" defaultValue="maybe" />`,
      imported: { id: 'flag', type: 'boolean', defaultValue: 'maybe' },
      warnings: [
        carried(
          "the engine cannot use default 'maybe' on form field 'flag' of 'Review' as written\nnote: 'BooleanFormType.convertValue' reads it through 'Boolean.valueOf' on every render of the form\nnote: it was imported as written, and the printed script draws an error at the field",
        ),
      ],
    },
    {
      case: 'an ISO default on a date field with no pattern is carried and the script draws an error',
      field: `          <operaton:formField id="due" type="date" defaultValue="2026-01-01" />`,
      imported: { id: 'due', type: 'date', defaultValue: '2026-01-01' },
      warnings: [
        carried(
          "the engine cannot use default '2026-01-01' on form field 'due' of 'Review' as written\nnote: 'DateFormType' parses it on every render of the form under the engine's own 'dd/MM/yyyy' ('ProcessEngineConfigurationImpl.initFormTypes'), since the field names no pattern, and an ISO date does not fit it\nnote: it was imported as written, and the printed script draws an error at the field",
        ),
      ],
    },
    {
      case: 'an empty label and an empty default are kept as written',
      field: `          <operaton:formField id="note" type="string" label="" defaultValue="" />`,
      imported: { id: 'note', type: 'string', label: '', defaultValue: '' },
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
      warnings: [
        rewrote(
          "'operaton:value' 'a' of form field 'plan' of 'Review' is written twice and was imported once\nnote: it keeps its first position and its last name, as 'FormTypes.parseFormPropertyType' keeps it ('LinkedHashMap.put')",
        ),
      ],
    },
    {
      case: 'an enum value with no id is dropped',
      field: `          <operaton:formField id="plan" type="enum">
            <operaton:value id="a" />
            <operaton:value name="Nameless" />
          </operaton:formField>`,
      imported: { id: 'plan', type: 'enum', values: [{ id: 'a' }] },
      warnings: [
        reviewWarning(
          "'operaton:value' #2 of form field 'plan' of 'Review' has no id and was not imported",
        ),
      ],
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
        rewrote(
          "'operaton:property' 'hint' of form field 'note' of 'Review' is written twice and was imported once\nnote: it keeps its first position and its last value, as 'DefaultFormHandler.parseProperties' keeps it ('LinkedHashMap.put')",
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
        reviewWarning(
          "'operaton:property' #1 of form field 'note' of 'Review' has no 'id' and was not imported",
        ),
        reviewWarning(
          "'operaton:property' 'empty' of form field 'note' of 'Review' has no 'value' and was not imported",
        ),
      ],
    },
  ] satisfies {
    case: string;
    field: string;
    imported: FormField;
    warnings: unknown[];
  }[])('$case', async ({ field, imported, warnings: expected }) => {
    // The clean field comes first, so a misattributed warning fails.
    const { node: task, warnings } = await importForm(
      `          <operaton:formField id="clean" type="string" />\n${field}`,
    );
    expect(task.formFields).toEqual([
      { id: 'clean', type: 'string' },
      imported,
    ]);
    expect(warnings).toEqual(expected);
  });
});

const codedErrorsDoc = (body: string): string =>
  operatonDefs`  <bpmn:error id="Err_Declined" errorCode="DECLINED" />
  <bpmn:error id="Err_Timeout" errorCode="TIMEOUT" />
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
${body}
    <bpmn:endEvent id="E" />
  </bpmn:process>`;

const externalTask = (attrs: string, children: string): string =>
  `    <bpmn:serviceTask id="Charge" operaton:type="external" operaton:topic="charge-card" ${attrs}>
${extensionElements(children)}</bpmn:serviceTask>`;

const errorMapping = (attrs: string): string =>
  `        <operaton:errorEventDefinition ${attrs} />`;

const propertiesOf = (entries: string): string =>
  `        <operaton:properties>\n${entries}\n        </operaton:properties>`;

describe('xmlToIr: external task extras', () => {
  const mappingDoc = (mapping: string): string =>
    operatonDefs`  <bpmn:error id="Err_Declined" errorCode="DECLINED" />
  <bpmn:error id="Err_Blank" />
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
${externalTask('', mapping)}
    <bpmn:endEvent id="E" />
  </bpmn:process>`;

  it.each([
    [
      'a mapping whose errorRef names no root and carries no expression, which the engine checks before the root',
      errorMapping('errorRef="Err_Missing"'),
      "the 'operaton:errorEventDefinition' carries no expression",
      "note: Operaton's 'parseOperatonErrorEventDefinitions' fails the deployment on an 'operaton:errorEventDefinition' that carries no expression",
    ],
    [
      'a mapping whose errorRef names a root with no code',
      errorMapping('errorRef="Err_Blank" expression="${true}"'),
      "its 'errorRef' names the error root 'Err_Blank', which carries no code",
      "note: BPMNscript needs its 'errorRef' to name an error root that carries a code",
    ],
  ])('%s is refused', async (_title, mapping, detail, note) => {
    const err = await expectRefusal<UnsupportedErrorMappingError>(
      xmlToIr(mappingDoc(mapping)),
      UnsupportedErrorMappingError,
      detail,
    );
    expect([err.elementId, err.message]).toEqual([
      'Charge',
      `error mapping on 'Charge' cannot be imported: ${detail}\n${note}`,
    ]);
  });

  const SKIPPED_MAPPING_WARNING: ImportWarning = {
    elementId: 'Charge',
    category: 'unmappedConstruct',
    message:
      "'operaton:errorEventDefinition' on 'Charge' was not imported\n" +
      "note: it carries no 'errorRef', and 'BpmnParse.parseOperatonErrorEventDefinitions' skips one without it\n" +
      'note: the rebuilt document runs the same',
  };

  it.each([
    {
      case: 'a mapping with no errorRef is skipped with a warning, as the engine skips it',
      body: externalTask('', errorMapping('expression="${true}"')),
      binding: externalBinding('charge-card'),
      warnings: [SKIPPED_MAPPING_WARNING],
    },
    {
      case: 'a property with no name is skipped and a repeated name is kept once with its last value, each naming which',
      body: externalTask(
        '',
        propertiesOf(`          <operaton:property name="k" value="v" />
          <operaton:property value="orphan" />
          <operaton:property name="k" value="w" />`),
      ),
      binding: {
        ...externalBinding('charge-card'),
        properties: [{ key: 'k', value: 'w' }],
      },
      warnings: [
        warning(
          'Charge',
          "'operaton:property' #2 of 'Charge' has no 'name' and was not imported",
        ),
        warning(
          'Charge',
          "'operaton:property' 'k' of 'Charge' is written twice and was imported once\nnote: it keeps its last value, as 'BpmnParseUtil.parseOperatonExtensionProperties' keeps it ('HashMap.put'), at its first position",
          'rewritten',
        ),
      ],
    },
    {
      case: 'the three extras on a class-bound service task are dropped, each naming the one reader',
      body: `    <bpmn:serviceTask id="Svc" operaton:class="com.example.Svc" operaton:taskPriority="42">
${extensionElements(`${propertiesOf('          <operaton:property name="k" value="v" />')}
${errorMapping('errorRef="Err_Declined" expression="${true}"')}`)}</bpmn:serviceTask>`,
      binding: classBinding('com.example.Svc'),
      warnings: [
        warning(
          'Svc',
          "setting 'taskPriority' on 'Svc' was not imported\nnote: Operaton reads it in 'parseExternalServiceTask' alone, which only 'operaton:type=\"external\"' reaches\nnote: the step runs as written without it",
        ),
        warning(
          'Svc',
          "'operaton:properties' block on 'Svc' was not imported\nnote: Operaton reads it in 'parseExternalServiceTask' alone, which only 'operaton:type=\"external\"' reaches\nnote: the step runs as written without it",
        ),
        warning(
          'Svc',
          "'operaton:errorEventDefinition' on 'Svc' was not imported\nnote: Operaton reads it in 'parseExternalServiceTask' alone, which only 'operaton:type=\"external\"' reaches\nnote: the step runs as written without it",
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
        warning(
          'Charge',
          "setting 'errorCodeVariable' on 'Charge' was not imported\nnote: it only takes effect on a catch (an 'on' handler), and has no effect on a throw",
        ),
      ],
    },
  ])('$case', async ({ body, binding, warnings: expected }) => {
    // The clean task comes first, so a misattributed warning fails.
    const xml = operatonDefs`  <bpmn:error id="Err_Declined" errorCode="DECLINED" />
  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="Clean" operaton:type="external" operaton:topic="clean" operaton:taskPriority="1">
${extensionElements(`${propertiesOf('          <operaton:property name="a" value="b" />')}
${errorMapping('errorRef="Err_Declined" expression="${true}"')}`)}</bpmn:serviceTask>
${body}
    <bpmn:endEvent id="E" />
  </bpmn:process>`;
    const { ir, warnings } = await xmlToIr(xml);
    const node = ir.flowElements.find(
      (fe) => fe.kind === 'serviceTask' && fe.id !== 'Clean',
    );
    expect(node?.kind === 'serviceTask' && node.binding).toEqual(binding);
    expect(warnings).toEqual(expected);
  });

  it('a decimal task priority refuses, quoting parsePriority', async () => {
    await expectExtensionRefusal(
      codedErrorsDoc(externalTask('operaton:taskPriority="1.5"', '')),
      'Charge',
      '\'operaton:taskPriority="1.5"\' is not a whole number or an expression',
      [
        "note: 'BpmnParse.parsePriority' refuses to deploy it (\"Value '1.5' for attribute 'taskPriority' is not a valid number\")",
      ],
    );
  });
});

// Moddle declares a parameter's nested value as repeating, which is what makes two values detectable.
describe('xmlToIr: the extension-form refusal matrix', () => {
  const HOSTS = { Svc: serviceTaskWith, Review: userTaskWith };

  const nested = (body: string): string =>
    ioBlock(`          <operaton:inputParameter name="x">
${body}
          </operaton:inputParameter>`);

  const EMPTY_ATTRIBUTE = (attr: string): string =>
    `note: 'BpmnParse.parseExecutionListener' refuses it ("Attribute '${attr}' cannot be empty")`;

  it.each([
    {
      case: 'a map entry carrying two nested values',
      on: 'Svc',
      children: nested(`            <operaton:map>
              <operaton:entry key="k"><operaton:list /><operaton:map /></operaton:entry>
            </operaton:map>`),
      detail:
        "'operaton:entry' 'k' in 'operaton:inputParameter' 'x' carries 2 nested values ('operaton:List', 'operaton:Map')",
      notes: ['note: a value is one'],
    },
    {
      case: 'an input parameter with no name',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:inputParameter>text</operaton:inputParameter>`,
      ),
      detail: "an 'operaton:inputParameter' has no name",
      notes: ['note: without a name there is nothing to bind its value to'],
    },
    {
      case: 'a map entry with no key',
      on: 'Svc',
      children: nested(`            <operaton:map>
              <operaton:entry>text</operaton:entry>
            </operaton:map>`),
      detail: "an 'operaton:entry' in 'operaton:inputParameter' 'x' has no key",
      notes: ['note: without a key there is nothing to look its value up by'],
    },
    {
      case: 'a script value naming an external resource',
      on: 'Svc',
      children: nested(
        '            <operaton:script scriptFormat="groovy" resource="classpath://calc.groovy" />',
      ),
      detail:
        "the 'operaton:script' in 'operaton:inputParameter' 'x' names an external resource ('classpath://calc.groovy')",
      notes: [
        "note: 'ScriptUtil.getScript' runs the resource in place of the body, and only an inline body can be written here",
      ],
    },
    {
      case: 'a script value with no scriptFormat',
      on: 'Svc',
      children: nested('            <operaton:script>1 + 1</operaton:script>'),
      detail:
        "the 'operaton:script' in 'operaton:inputParameter' 'x' has no 'scriptFormat'",
      notes: ['note: without it there is no language to evaluate its body in'],
    },
    {
      case: 'a listener script whose body holds three backticks',
      on: 'Svc',
      children: `        <operaton:executionListener event="start">
          <operaton:script scriptFormat="groovy">x = "\`\`\`"</operaton:script>
        </operaton:executionListener>`,
      detail:
        "the 'operaton:script' in an 'operaton:executionListener' contains three consecutive backticks",
      notes: ['note: no script fence in BPMNscript can enclose them'],
    },
    {
      case: 'an operaton:entry inside an operaton:list',
      on: 'Svc',
      children: nested(`            <operaton:list>
              <operaton:entry key="k">v</operaton:entry>
            </operaton:list>`),
      detail:
        "an 'operaton:list' in 'operaton:inputParameter' 'x' carries a 'operaton:Entry'",
      notes: [
        'note: a list holds values',
        "note: an entry belongs in an 'operaton:map'",
      ],
    },
    {
      case: 'an operaton:entry where a parameter value belongs',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:inputParameter name="x"><operaton:entry key="k">v</operaton:entry></operaton:inputParameter>`,
      ),
      detail:
        "'operaton:inputParameter' 'x' carries a 'operaton:Entry' where a value belongs",
      notes: ["note: an entry belongs in an 'operaton:map'"],
    },
    {
      case: 'two input parameters sharing a name',
      on: 'Svc',
      children:
        ioBlock(`          <operaton:inputParameter name="x">1</operaton:inputParameter>
          <operaton:inputParameter name="x">2</operaton:inputParameter>`),
      detail: "two 'operaton:inputParameter' children share 'name=\"x\"'",
      notes: [
        "note: Operaton runs both, the last write winning ('IoMapping.executeInputParameters')",
        'note: BPMNscript binds each parameter name once per direction',
      ],
    },
    {
      case: 'an input parameter whose name the script cannot spell',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:inputParameter name="my.param">1</operaton:inputParameter>`,
      ),
      detail:
        "'operaton:inputParameter' 'my.param' names a variable the script cannot spell",
      notes: [
        "note: a name is letters, digits and '_', with '-' between them, and no keyword",
        'note: the engine sets the variable under that name, so writing another would change what runs',
      ],
    },
    {
      case: 'an injected field naming no value slot',
      on: 'Svc',
      children: `        <operaton:field name="greeting" />`,
      detail: "the injected field 'greeting' on 'Svc' names no value",
      notes: [ONE_VALUE_SLOT],
    },
    {
      case: 'an injected field naming an attribute and a child of the same slot',
      on: 'Svc',
      children: `        <operaton:field name="greeting" stringValue="hello"><operaton:string>hi</operaton:string></operaton:field>`,
      detail:
        "the injected field 'greeting' on 'Svc' names a 'stringValue' attribute and an 'operaton:string' child",
      notes: [ONE_VALUE_SLOT],
    },
    {
      case: 'a listener carrying no binding at all',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" />`,
      detail: "an 'operaton:executionListener' carries no binding",
      notes: [
        "note: it runs one of 'class', 'expression', 'delegateExpression', or an 'operaton:script' child",
      ],
    },
    {
      case: 'an execution listener with class=""',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" class="" />`,
      detail:
        "an 'operaton:executionListener' has an empty class ('class=\"\"')",
      notes: [EMPTY_ATTRIBUTE('class')],
    },
    {
      case: 'an execution listener with delegateExpression=""',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" delegateExpression="" />`,
      detail:
        "an 'operaton:executionListener' has an empty delegate expression ('delegateExpression=\"\"')",
      notes: [EMPTY_ATTRIBUTE('delegateExpression')],
    },
    {
      case: 'a listener with no event',
      on: 'Svc',
      children: `        <operaton:executionListener class="com.example.L" />`,
      detail: "an 'operaton:executionListener' has no event",
      notes: [
        'note: without an event there is no point in the lifecycle for it to fire at',
      ],
    },
    {
      case: 'an execution listener whose event is neither start nor end',
      on: 'Svc',
      children: `        <operaton:executionListener event="take" class="com.example.L" />`,
      detail:
        "an 'operaton:executionListener' has an event its position does not accept ('event=\"take\"')",
      notes: ["note: the events it accepts are 'start' or 'end'"],
    },
    {
      case: 'a timeout task listener with no timer',
      on: 'Review',
      children: `        <operaton:taskListener event="timeout" class="com.example.L" />`,
      detail:
        "an 'operaton:taskListener' with 'event=\"timeout\"' carries no 'bpmn:timerEventDefinition'",
      notes: ['note: without one nothing would ever fire it'],
    },
    {
      // No listener binding: the timer is read before one is resolved.
      case: 'a timeout task listener with two timers, since a timeout has one due time',
      on: 'Review',
      children: `        <operaton:taskListener event="timeout">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT8H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
      detail:
        "an 'operaton:taskListener' with 'event=\"timeout\"' carries 2 'bpmn:timerEventDefinition' children",
      notes: ['note: a timeout has one due time'],
    },
    {
      case: 'a second operaton:formData, since Element.elementNS throws on it',
      on: 'Review',
      children: [1, 2]
        .map(
          () => `        <operaton:formData>
          <operaton:formField id="f" type="string" />
        </operaton:formData>`,
        )
        .join('\n'),
      detail: "2 'operaton:formData' blocks",
      notes: [
        "note: 'Element.elementNS' throws on them when 'DefaultFormHandler.parseFormData' reads them (\"Parsing exception: multiple elements with tag name 'formData' found\")",
        "note: 'BpmnParse.execute' lets that fail the deployment",
      ],
    },
  ] as const)(
    '$case is refused, naming the shape and the element',
    async ({ on, children, detail, notes }) => {
      await expectExtensionRefusal(HOSTS[on](children), on, detail, notes);
    },
  );
});

describe('xmlToIr: task kinds', () => {
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

  const KINDS = [
    ['task', '', 'plain task'],
    ['sendTask', 'operaton:class="com.example.Send"', 'send task'],
    ['receiveTask', '', 'receive task'],
    [
      'businessRuleTask',
      'operaton:decisionRef="riskRating"',
      'business rule task',
    ],
  ] as const;

  const ORDER_PAID_ROOT =
    '  <bpmn:message id="Msg_OrderPaid" name="OrderPaid" />\n';

  const receiveDoc = (attrs: string, roots = ''): string =>
    operatonDefs`${roots}  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    <bpmn:receiveTask id="T" ${attrs} />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>`;

  const boundaryDoc = (tag: string, attrs: string, definition: string) =>
    operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:${tag} id="T" ${attrs} />
    <bpmn:boundaryEvent id="B" attachedToRef="T">
      ${definition}
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />`;

  it('a receive task with a messageRef imports the message name, and the root it uses is not reported as unreferenced', async () => {
    const { node, warnings } = await importOnly(
      receiveDoc('messageRef="Msg_OrderPaid"', ORDER_PAID_ROOT),
      'receiveTask',
    );
    expect(node.messageName).toBe('OrderPaid');
    expect(warnings).toEqual([]);
  });

  it.each(KINDS)(
    'isForCompensation="true" on a bpmn:%s refuses rather than importing into normal flow',
    async (tag, binding) => {
      await expectEventRefusal(
        oneNodeDoc(tag, { attrs: `isForCompensation="true" ${binding}` }),
        'T',
        IS_FOR_COMPENSATION,
        EXCLUDED_FROM_FLOW,
      );
    },
  );

  it.each(KINDS)(
    'an escalation boundary event on a bpmn:%s still refuses',
    async (tag, binding, noun) => {
      await expectEventRefusal(
        boundaryDoc(
          tag,
          binding,
          '<bpmn:escalationEventDefinition id="EscDef" />',
        ),
        'B',
        `an escalation boundary event attaches to 'T', a ${noun}`,
        [
          'note: Operaton only allows an escalation boundary on a subprocess, a call activity, or a user task',
        ],
      );
    },
  );

  const MANUAL_TASK_WARNING = {
    elementId: 'M1',
    category: 'rewritten',
    message:
      "manual task 'M1' imports as a plain step\n" +
      'note: token flow, waiting, listeners, async and job configuration are all unchanged\n' +
      "note: history and Cockpit report its activity type as 'task' rather than 'manualTask'",
  };

  it('a manual task imports as a plain step, warning that history will report it as a task', async () => {
    const { node, warnings } = await importOnly(
      oneNodeDoc('manualTask', { id: 'M1', attrs: 'name="Sign off"' }),
      'task',
    );
    expect(node).toEqual({ kind: 'task', id: 'M1', name: 'Sign off' });
    expect(warnings).toEqual([MANUAL_TASK_WARNING]);
  });

  it('an intermediate throw with no definition (the Modeler milestone) imports as a plain step carrying its io mapping, prints and re-parses, warning that history will report it as a task', async () => {
    const { ir, warnings } = await xmlToIr(
      oneNodeDoc('intermediateThrowEvent', {
        id: 'M',
        attrs: 'name="Milestone reached" operaton:asyncBefore="true"',
        children: extensionElements(
          ioBlock(
            '          <operaton:inputParameter name="note">reached</operaton:inputParameter>',
          ),
        ),
      }),
    );
    expect(byId(ir, 'M')).toEqual({
      kind: 'task',
      id: 'M',
      name: 'Milestone reached',
      asyncBefore: true,
      inputParameters: [ioParam('note', textValue('reached'))],
    });
    expect(warnings).toEqual([
      {
        elementId: 'M',
        category: 'rewritten',
        message:
          "intermediate throw event 'M' carries no event definition and imports as a plain step\n" +
          "note: 'BpmnParse.parseIntermediateThrowEvent' gives it 'IntermediateThrowNoneEventActivityBehavior', which only leaves, as a task's behaviour does\n" +
          'note: token flow, listeners, async and job configuration are unchanged\n' +
          "note: history and Cockpit report its activity type as 'task' rather than 'intermediateNoneThrowEvent'",
      },
    ]);

    const { source } = irToDsl(ir);
    expect(source).toContain(
      'step M(label: "Milestone reached", asyncBefore: true)',
    );
    await expectParses(source);
  });
});

describe('xmlToIr: a block that can be given up', () => {
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
    tag?: string;
    attrs?: string;
    body?: string;
    beside?: string;
    doc?: XmlTag;
  }

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

  const pairedDoc = (options: BlockOptions = {}): string =>
    blockDoc({
      body: BLOCK_BODY + CANCEL_END,
      beside: cancelBoundary(),
      ...options,
    });

  it.each([
    [
      'a cancel end directly inside a plain subprocess',
      blockDoc({ tag: 'subProcess', body: BLOCK_BODY + CANCEL_END }),
      'GiveUp',
      'an end event carries a cancel definition outside a block that can be given up\n' +
        "note: Operaton only accepts one directly inside a 'bpmn:transaction', and " +
        'refuses to deploy the file otherwise\n' +
        "help: move the end inside a 'bpmn:transaction', or take the cancel definition off it",
    ],
    [
      'a cancel boundary on a plain subprocess',
      blockDoc({ tag: 'subProcess', beside: cancelBoundary() }),
      'Boundary_Book_cancel',
      "a cancel boundary event attaches to 'Book', a subprocess\n" +
        "note: Operaton only allows a cancel boundary on a 'bpmn:transaction', " +
        'and refuses to deploy the file otherwise\n' +
        "help: attach it to a 'bpmn:transaction', or take the cancel definition off it",
    ],
    [
      'a second cancel boundary on the same block',
      pairedDoc({
        beside: cancelBoundary() + cancelBoundary('Boundary_Book_cancel2'),
      }),
      'Boundary_Book_cancel2',
      "a second cancel boundary event attaches to 'Book'\n" +
        'note: Operaton allows one cancel boundary per block and refuses to ' +
        'deploy a file with two\n' +
        'help: leave one cancel boundary event on the block',
    ],
  ])('%s refuses', async (_title, xml, elementId, detail) => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(xml),
      UnsupportedEventFeatureError,
    );
    expect(e.elementId).toBe(elementId);
    expect(e.message).toBe(
      `element '${elementId}' cannot be imported: ${detail}`,
    );
  });

  it.each([
    [
      'a cancel end with no cancel boundary on its block warns, naming the runtime failure',
      blockDoc({ body: BLOCK_BODY + CANCEL_END }),
      'Book',
      "block 'Book' has an end event that gives it up, but no cancel boundary event\n" +
        'note: Operaton deploys the file, then stops with an error the first time that end is reached\n' +
        "help: write 'on Book: cancel { ... }' beside the block to catch it",
      'carriedAsWritten',
    ],
    [
      'a cancel boundary on a block that never gives itself up warns, naming the unreachable path',
      blockDoc({ beside: cancelBoundary() }),
      'Boundary_Book_cancel',
      "cancel boundary event on 'Book' can never fire\n" +
        'note: it was imported, but nothing inside the block gives it up\n' +
        'note: what follows the boundary can never run',
      'carriedAsWritten',
    ],
    [
      'a method on the block is dropped, since Operaton never reads it there',
      blockDoc({ attrs: 'method="##Store"' }),
      'Book',
      "attribute 'method' on 'Book' was not imported\n" +
        "note: Operaton does not read it on a 'bpmn:transaction'\n" +
        'note: the imported block runs exactly as the original document does',
      'unmappedConstruct',
    ],
    [
      'triggeredByEvent on the block is dropped, since Operaton runs it as an ordinary step',
      blockDoc({ attrs: 'triggeredByEvent="true"' }),
      'Book',
      "attribute 'triggeredByEvent' on 'Book' was not imported\n" +
        "note: Operaton ignores it on a 'bpmn:transaction' and runs the block as an ordinary step of the surrounding flow\n" +
        'note: the imported block runs exactly as the original document does',
      'unmappedConstruct',
    ],
  ])('%s', async (_title, xml, elementId, message, category) => {
    const { ir, warnings } = await xmlToIr(xml);
    const book = subProcess(ir, 'Book');
    expect(book.element).toBe('transaction');
    expect(book).not.toHaveProperty('method');
    expect(book).not.toHaveProperty('triggeredByEvent');
    expect(warnings).toEqual([{ elementId, category, message }]);
  });
});

describe('xmlToIr: an either-branch split', () => {
  const xorDoc = (gateway: string, routes: string): string =>
    bpmnDefs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
    ${gateway}
    <bpmn:userTask id="A" />
    <bpmn:userTask id="B" />
    <bpmn:userTask id="C" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="G" />
${routes}
    <bpmn:sequenceFlow id="fAe" sourceRef="A" targetRef="E" />
    <bpmn:sequenceFlow id="fBe" sourceRef="B" targetRef="E" />
    <bpmn:sequenceFlow id="fCe" sourceRef="C" targetRef="E" />
  </bpmn:process>`;
  const route = (id: string, target: string, condition?: string): string =>
    condition === undefined
      ? `    <bpmn:sequenceFlow id="${id}" sourceRef="G" targetRef="${target}" />`
      : `    <bpmn:sequenceFlow id="${id}" sourceRef="G" targetRef="${target}">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${condition}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>`;

  it.each([
    [
      'no outgoing flow',
      '<bpmn:exclusiveGateway id="G" />',
      '',
      "Exclusive Gateway 'G' has no outgoing sequence flows.",
    ],
    [
      'one outgoing flow carrying a condition',
      '<bpmn:exclusiveGateway id="G" />',
      route('fA', 'A', '${a}'),
      "Exclusive Gateway 'G' has only one outgoing sequence flow ('fA'). " +
        'This is not allowed to have a condition.',
    ],
    [
      'a default carrying a condition',
      '<bpmn:exclusiveGateway id="G" default="fA" />',
      [route('fA', 'A', '${a}'), route('fB', 'B')].join('\n'),
      "Exclusive Gateway 'G' has outgoing sequence flow 'fA' which is the " +
        'default flow but has a condition too.',
    ],
    [
      'an empty condition body beside an unconditioned route, which the engine counts as conditioned',
      '<bpmn:exclusiveGateway id="G" />',
      [route('fA', 'A', ''), route('fB', 'B'), route('fC', 'C')].join('\n'),
      "Exclusive Gateway 'G' has outgoing sequence flow 'fB' without " +
        'condition which is not the default flow.',
    ],
  ])(
    'an exclusive gateway with %s refuses with the sentence validateExclusiveGateway fails the deployment with',
    async (_title, gateway, routes, detail) => {
      const e = await expectRefusal<UnsupportedGatewayShapeError>(
        xmlToIr(xorDoc(gateway, routes)),
        UnsupportedGatewayShapeError,
        detail,
      );
      expect([e.elementId, e.message]).toEqual([
        'G',
        "exclusive gateway 'G' cannot be imported\n" +
          `note: Operaton's 'BpmnParse.validateExclusiveGateway' fails the deployment with "${detail}"\n` +
          'note: no running process exists to write back\n' +
          "help: give every route but the fallback a condition, and name the fallback in the gateway's 'default'",
      ]);
    },
  );
});

describe('xmlToIr: a fallback route named on a step', () => {
  const condition = (body: string): string =>
    `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${body}</bpmn:conditionExpression>`;

  const stepDoc = (element: string): string =>
    bpmnDefs`  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
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

  const once =
    '<bpmn:multiInstanceLoopCharacteristics><bpmn:loopCardinality>2</bpmn:loopCardinality></bpmn:multiInstanceLoopCharacteristics>';
  const loop = { cardinality: '2' };
  const repeated = (named: string, routes: boolean) => ({
    elementId: 'Triage',
    category: 'behaviourChanged',
    message:
      `repeated step 'Triage' names default flow '${named}' and can never complete\n` +
      'note: the engine hangs the routes out of a repeated step on the repetition around it, so a single run has no route to take as its default\n' +
      "note: every run fails on completion with 'missingDefaultFlowException', whatever the conditions\n" +
      (routes
        ? `note: the rebuilt process takes '${named}' as the fallback of a split after the step, which completes`
        : 'note: the imported step names no fallback and completes'),
  });

  it.each<[string, string, object, object[]]>([
    [
      'a default naming a flow that enters the step is dropped with the warning handleNoTransitions earns it',
      '<bpmn:userTask id="Triage" default="F0" />',
      { kind: 'userTask', id: 'Triage' },
      [
        {
          elementId: 'Triage',
          category: 'unmappedConstruct',
          message:
            "attribute 'default' on 'Triage' was not imported\n" +
            "note: it names 'F0', which is not a route out of the step\n" +
            "note: 'BpmnActivityBehavior.handleNoTransitions' finds no flow to take there and fails the step whenever no other route holds\n" +
            'note: the imported step names no fallback',
        },
      ],
    ],
    [
      'a repeated step keeps a default naming its own route and warns that the engine never takes it',
      `<bpmn:userTask id="Triage" default="F2">${once}</bpmn:userTask>`,
      { kind: 'userTask', id: 'Triage', loop, defaultFlowId: 'F2' },
      [repeated('F2', true)],
    ],
    [
      'a repeated step drops a default naming no route of its own and warns that the original always fails',
      `<bpmn:userTask id="Triage" default="F0">${once}</bpmn:userTask>`,
      { kind: 'userTask', id: 'Triage', loop },
      [repeated('F0', false)],
    ],
  ])('%s', async (_title, element, node, warnings) => {
    const imported = await importOnly(stepDoc(`    ${element}`), 'userTask');
    expect(imported.node).toEqual(node);
    expect(imported.warnings).toEqual(warnings);
  });
});

describe('xmlToIr: a wait with several branches', () => {
  interface WaitOptions {
    attrs?: string;
    children?: string;
    branches?: readonly { id: string; element: string }[];
    roots?: string;
    beside?: string;
    extraFlows?: string;
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

  const waitDoc = ({
    attrs = '',
    children = '',
    branches = [messageBranch, timerBranch],
    roots = MESSAGE_ROOT,
    beside = '',
    extraFlows = '',
    defs = bpmnDefs,
  }: WaitOptions = {}): string =>
    defs`${roots}  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
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

  const NOT_A_WAIT = [
    'note: every branch of a wait with several branches has to begin with something to wait for',
    'note: only a message, a timer, a signal or a condition counts as one here',
    'help: begin each branch with a message, timer, signal or condition to wait for, and put the steps that follow it inside that branch',
  ];

  it.each([
    [
      'a branch that does not begin with something to wait for',
      waitDoc({
        branches: [
          messageBranch,
          { id: 'Ship', element: '<bpmn:userTask id="Ship" />' },
        ],
      }),
      'Ship',
      "a branch of the wait 'Wait' leads to 'Ship', a user task",
      NOT_A_WAIT,
    ],
    [
      'a branch that leads straight into a bpmn:transaction, named "an attempt block"',
      waitDoc({
        branches: [
          timerBranch,
          {
            id: 'Attempt',
            element: `<bpmn:transaction id="Attempt">
      <bpmn:startEvent id="AttemptStart" />
      <bpmn:endEvent id="AttemptEnd" />
      <bpmn:sequenceFlow id="ASF1" sourceRef="AttemptStart" targetRef="AttemptEnd" />
    </bpmn:transaction>`,
          },
        ],
      }),
      'Attempt',
      "a branch of the wait 'Wait' leads to 'Attempt', an attempt block",
      NOT_A_WAIT,
    ],
    [
      'a branch reached by more than one path',
      waitDoc({
        beside: '    <bpmn:userTask id="Chase" />\n',
        extraFlows:
          '    <bpmn:sequenceFlow id="F_Chase" sourceRef="Chase" targetRef="OnPaid" />\n',
      }),
      'OnPaid',
      "'OnPaid' is reached by more than one path",
      [
        'note: a step inside a wait with several branches can only be reached through the wait that opens it',
        "help: leave 'OnPaid' with the one path into it that starts at 'Wait', and lead the rest elsewhere",
      ],
    ],
    [
      'a wait marked operaton:asyncAfter, naming the engine rule',
      waitDoc({ attrs: 'operaton:asyncAfter="true"', defs: operatonDefs }),
      'Wait',
      "'Wait' is marked 'asyncAfter'",
      [
        "note: 'BpmnParse.parseEventBasedGateway' refuses to deploy it on a wait with several branches",
        "help: drop the 'asyncAfter' setting from 'Wait'",
        'note: its other job settings are read as written',
      ],
    ],
  ] as const)('%s refuses', async (_title, xml, elementId, detail, notes) => {
    await expectEventRefusal(xml, elementId, detail, notes);
  });

  const unreadOnWait = (attr: string): ImportWarning => ({
    elementId: 'Wait',
    category: 'unmappedConstruct',
    message:
      `attribute '${attr}' on 'Wait' was not imported\n` +
      'note: Operaton does not read it on a wait with several branches\n' +
      'note: the imported process runs exactly as the original document does',
  });

  it.each([
    ['instantiate="true" is reported', 'instantiate="true"', ['instantiate']],
    [
      'eventGatewayType="Parallel" is reported',
      'eventGatewayType="Parallel"',
      ['eventGatewayType'],
    ],
    [
      'gatewayDirection, and instantiate and eventGatewayType at their defaults, say nothing',
      'gatewayDirection="Diverging" instantiate="false" eventGatewayType="Exclusive"',
      [],
    ],
  ])('%s', async (_title, attrs, reported) => {
    const { warnings } = await xmlToIr(waitDoc({ attrs }));
    expect(warnings).toEqual(reported.map(unreadOnWait));
  });
});

describe('xmlToIr: error and message roots', () => {
  const rootsDoc = (roots: string): string =>
    rootedDoc(
      roots,
      `    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
      operatonDefs,
    );

  it.each([
    ['both messageless', '', '', { name: 'DUP', code: 'DUP' }],
    [
      'only the second carrying a message',
      '',
      'operaton:errorMessage="Oops"',
      { name: 'DUP', code: 'DUP', message: 'Oops' },
    ],
    [
      'agreeing on the message',
      'operaton:errorMessage="Oops"',
      'operaton:errorMessage="Oops"',
      { name: 'DUP', code: 'DUP', message: 'Oops' },
    ],
  ])(
    'two bpmn:Error roots sharing a code, %s, merge into one declaration',
    async (_shape, first, second, decl) => {
      const { ir, warnings } = await xmlToIr(
        rootsDoc(
          `  <bpmn:error id="Error_A" errorCode="DUP" ${first} />\n` +
            `  <bpmn:error id="Error_B" errorCode="DUP" ${second} />\n`,
        ),
      );
      expect(ir.errorDecls).toEqual([decl]);
      expect(warnings).toEqual([]);
    },
  );

  it.each([
    [
      'an unnamed, unreferenced bpmn:message root',
      '  <bpmn:message id="M1" />\n',
      'M1',
      "message root 'M1' has no name and was not imported\n" +
        'note: without a name it cannot be keyed or represented in the script',
    ],
    [
      'an error root with no code',
      '  <bpmn:error id="Error_NoCode" name="NoCode" />\n',
      'Error_NoCode',
      "error root 'Error_NoCode' has no code and was not imported\n" +
        'note: without a code it cannot be keyed or represented in the script',
    ],
  ])(
    '%s warns that it cannot be keyed, and is dropped',
    async (_title, roots, id, message) => {
      const { ir, warnings } = await xmlToIr(rootsDoc(roots));
      expect([ir.errorDecls, ir.escalationDecls, warnings]).toEqual([
        undefined,
        undefined,
        [{ elementId: id, category: 'unreferencedRoot', message }],
      ]);
    },
  );
});
