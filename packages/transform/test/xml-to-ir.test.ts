import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  asyncRespellingMessage,
  CAMUNDA_ALIAS_MESSAGE,
  COMPENSATION_BOUNDARY_DETAIL,
  IS_FOR_COMPENSATION_DETAIL,
  priorityRefusal,
  unimportedSettingMessage,
  xmlToIr,
} from '../src/xml-to-ir.js';
import type { ImportWarning } from '../src/xml-to-ir.js';
import { irToXml } from '../src/ir-to-xml.js';
import { irToDsl } from '../src/ir-to-dsl.js';
import {
  UnsupportedCallActivityError,
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

const expectRewrite = async (
  e: UnsupportedEventFeatureError,
  lines: readonly string[],
): Promise<void> => {
  const marker = 'Write it by hand instead:\n\n';
  const cut = e.detail.indexOf(marker);
  expect(cut).toBeGreaterThan(-1);
  const rewrite = e.detail.slice(cut + marker.length);
  expect(rewrite).toBe(lines.join('\n'));
  await expectParses(`process Preview {\n${rewrite}\n}\n`);
};

const extensionWarnings = (warnings: ImportWarning[]): ImportWarning[] =>
  warnings.filter((w) => w.category === 'extensionAttribute');

const warning = (
  elementId: string,
  message: RegExp,
  category: ImportWarning['category'] = 'extensionAttribute',
): { elementId: string; category: string; message: unknown } => ({
  elementId,
  category,
  message: expect.stringMatching(message),
});

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

const CAMUNDA_ALIAS_WARNING = {
  elementId: 'p',
  category: 'rewritten',
  message: CAMUNDA_ALIAS_MESSAGE,
};

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

describe('xmlToIr: service task binding forms', () => {
  it('an external type without a topic refuses', async () => {
    await expectRefusal(
      xmlToIr(oneNodeDoc('serviceTask', { attrs: 'operaton:type="external"' })),
      UnsupportedServiceTaskFormError,
    );
  });

  it('a connector refuses as a connector', async () => {
    const e = await expectRefusal<UnsupportedServiceTaskFormError>(
      xmlToIr(
        oneNodeDoc('serviceTask', {
          children: extensionElements(
            '<operaton:connector><operaton:connectorId>http-connector</operaton:connectorId></operaton:connector>',
          ),
        }),
      ),
      UnsupportedServiceTaskFormError,
    );
    expect(e.construct).toBe(
      'an <operaton:connector> element, which the Connect plugin runs in ' +
        'place of whatever operaton:class, expression, delegateExpression, or ' +
        'type names beside it, and which an engine without the plugin runs ' +
        'instead of, so the same file has two possible executions',
    );
    expect(e.subject).toBe('Service task');
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
      "The script on 'ST' has no scriptFormat; " +
        '`BpmnParse.parseScriptTaskElement` substitutes ' +
        '`ScriptingEngines.DEFAULT_SCRIPTING_LANGUAGE` (juel), and it was ' +
        'imported as such.',
    ],
    [
      'a scriptFormat outside the alias table is carried as written',
      'scriptFormat="cobol"',
      '<bpmn:script>1</bpmn:script>',
      { format: 'cobol' },
      'carriedAsWritten',
      "The script on 'ST' names the language 'cobol', which the DSL " +
        'has no fence alias for; it was imported as written, and the ' +
        'printed script draws an error there.',
    ],
    [
      'a self-closing bpmn:script imports as an empty body, since ScriptUtil.getScript deploys it',
      'scriptFormat="javascript"',
      '<bpmn:script/>',
      { code: '' },
      'carriedAsWritten',
      "The body of the script on 'ST' is empty: ScriptUtil.getScript " +
        'deploys it, since it checks the source for null and not for ' +
        'emptiness, and the printed script draws an empty-body error there.',
    ],
    [
      'a self-closing operaton:script on a listener imports as an empty body, since ScriptUtil.getScript deploys it',
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
      'carriedAsWritten',
      'The body of the operaton:script in an operaton:executionListener is ' +
        'empty: ScriptUtil.getScript deploys it, since it checks the source ' +
        'for null and not for emptiness, and the printed script draws an ' +
        'empty-body error there.',
    ],
  ] as const)(
    '%s',
    async (_title, attrs, children, carried, category, message) => {
      const { node, warnings } = await importOnly(
        scriptTask(attrs, children),
        'scriptTask',
      );
      expect(node).toMatchObject(carried);
      expect(warnings).toEqual([{ elementId: 'ST', category, message }]);
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
        "Script task 'ST' has an unsupported language tag " +
          "'http://www.java.com/java'. Use 'juel', 'js', 'javascript', " +
          "'ecmascript', 'groovy', 'py', 'python', 'rb', 'ruby', or 'feel'.",
      ],
    ]);
  });

  it.each([
    [
      'an empty scriptFormat refuses',
      'scriptFormat=""',
      '<bpmn:script>x = 1;</bpmn:script>',
      "the script on 'ST' has an empty scriptFormat; " +
        '`ScriptUtil.getScript` refuses to deploy it',
    ],
    [
      'no script body and no resource refuses',
      'scriptFormat="javascript"',
      '',
      "the script on 'ST' has neither a script body nor a resource; " +
        '`ScriptUtil.getScript` refuses to deploy it with neither',
    ],
  ])('%s', async (_title, attrs, children, detail) => {
    await expectRefusal(
      xmlToIr(scriptTask(attrs, children)),
      UnsupportedExtensionFormError,
      detail,
    );
  });
});

describe('xmlToIr: unsupported element', () => {
  it('bpmn:AdHocSubProcess raises UnsupportedElementError', async () => {
    const e = await expectRefusal<UnsupportedElementError>(
      xmlToIr(
        oneNodeDoc('adHocSubProcess', {
          children: '<bpmn:userTask id="A" />',
          doc: bpmnDoc,
        }),
      ),
      UnsupportedElementError,
    );
    expect(e.qname).toBe('bpmn:AdHocSubProcess');
    expect(e.elementId).toBe('T');
    expect(e.message).toContain(SUPPORTED_KINDS_MESSAGE);
  });
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
  const unmapped = (elementId: string, message: RegExp) =>
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
      /^The process 'sketch' is not marked executable and was not imported; `BpmnParse.parseProcessDefinitions` does not deploy it either\.$/,
    ),
    unmapped(
      'P1',
      /^The pool 'Approval' \(P1\) names the imported process 'approval'; `BpmnParse.parseCollaboration` records it for the diagram alone, and the document written back has no pool\.$/,
    ),
    unmapped(
      'P2',
      /^The pool 'Sketch' \(P2\) names process 'sketch', which was not imported; `BpmnParse\.parseCollaboration`/,
    ),
  ];
  const VALIDATING_PARSE =
    /Operaton's validating parse \(`Parse\.execute` against `BPMN20\.xsd`/;

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
            /^The pool 'Approval' \(P1\) names the imported process 'p'/,
          ),
          unmapped(
            'MF',
            /^The message flow 'MF' from 'A' to 'P1' was not imported; `BpmnParse` reads no message flow, so the process runs identically without it\.$/,
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
        detail: /^two executable processes \('p1', 'p2'\)$/,
      },
    ],
    [
      'two processes neither marked executable refuse: the engine deploys none of them',
      bpmnDefs`${process('', 'p1')}\n${process('', 'p2', '    <bpmn:startEvent id="S2" />')}`,
      {
        refusal: UnsupportedDocumentError,
        detail:
          /^none of its 2 processes is marked isExecutable="true"; `BpmnParse\.parseProcessDefinitions` deploys none of them/,
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
            /^The process 'p' is not marked isExecutable="true", which `BpmnParse\.parseProcessDefinitions` skips in a new deployment; it was imported as an executable process and is written back as one\.$/,
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
        detail: /^it carries a <!DOCTYPE> declaration.*disallow-doctype-decl/,
      },
    ],
    [
      'an entity XML does not predefine refuses',
      bpmnDefs`${process(' isExecutable="true"', 'p', STEPS.replace('id="A"', 'id="A" name="A&nbsp;B"'))}`,
      {
        refusal: UnsupportedDocumentError,
        detail:
          /^it references the entity '&nbsp;', which XML does not predefine and no DOCTYPE declares/,
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
        detail: new RegExp(
          `^isSequential="yes" is outside true and false.*${VALIDATING_PARSE.source}`,
        ),
      },
    ],
    [
      'an id written on two elements refuses, naming the id',
      bpmnDefs`${process(' isExecutable="true"', 'p', STEPS.replace('<bpmn:userTask id="A" />', '<bpmn:userTask id="A" />\n    <bpmn:userTask id="A" />'))}`,
      {
        refusal: UnsupportedDocumentError,
        detail:
          /^the id 'A' is written on two elements; Operaton validates every file against BPMN20\.xsd/,
      },
    ],
    [
      'an id outside the ASCII alphabet this tool reads refuses, naming the id',
      bpmnDefs`${process(' isExecutable="true"', 'p', STEPS.replaceAll('"A"', '"Auftrag_prüfen"'))}`,
      {
        refusal: UnsupportedDocumentError,
        detail:
          "the id 'Auftrag_prüfen' is outside what this tool reads: ASCII " +
          "letters, digits, '_', '-' and '.', starting with a letter or '_', " +
          'where the schema admits any letter; rename it',
      },
    ],
    [
      'a bpmn:import refuses, naming its type',
      bpmnDefs`  <bpmn:import importType="http://www.w3.org/2001/XMLSchema" location="types.xsd" namespace="http://test/types" />
${EXECUTABLE}`,
      {
        refusal: UnsupportedDocumentError,
        detail:
          /^it declares a bpmn:import of type 'http:\/\/www\.w3\.org\/2001\/XMLSchema'; `BpmnParse\.parseImports` fails the deployment/,
      },
    ],
    [
      'two signal roots sharing a name refuse, naming both',
      bpmnDefs`  <bpmn:signal id="Signal_1" name="Go" />
  <bpmn:signal id="Signal_2" name="Go" />
${EXECUTABLE}`,
      {
        refusal: UnsupportedEventFeatureError,
        detail:
          /^signal roots 'Signal_1' and 'Signal_2' both declare the name "Go"; `BpmnParse\.parseSignals` fails the deployment/,
      },
    ],
    [
      'a process without an id refuses',
      bpmnDefs`${EXECUTABLE.replace('id="p" ', '')}`,
      {
        refusal: UnsupportedDocumentError,
        detail:
          'its process has no id; Operaton deploys a process under its id as ' +
          'the definition key, and the deployment fails without one',
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
        detail:
          /^it has no start event, which BpmnParse\.parseStartEvents fails the deployment on \("process must define a startEvent element"\)/,
      },
    ],
  ] as const)('%s', async (_title, xml, expected) => {
    if ('refusal' in expected) {
      await expectRefusal(xmlToIr(xml), expected.refusal, expected.detail);
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
      [4, 5, 6],
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
      [4],
    ],
  ])(
    'an element without an id, which the engine deploys: %s',
    async (_title, content, nodes, flows, neverRunLines) => {
      const { ir, warnings } = await xmlToIr(
        bpmnDefs`${process(' isExecutable="true"', 'p', `    <bpmn:startEvent id="S" />\n    <bpmn:userTask id="A" />\n    <bpmn:endEvent id="E" />\n${content}`)}`,
      );
      // Nothing can flow into a node without an id, so its step never runs.
      const { diagnostics } = await validate(irToDsl(ir).source);
      expect([
        ir.flowElements.map((n) => n.id),
        ir.sequenceFlows.map((f) => f.id),
        warnings,
        diagnostics.map((d) => [d.range.start.line, d.message]),
      ]).toEqual([
        nodes,
        flows,
        [],
        neverRunLines.map((line) => [
          line,
          expect.stringMatching(/^This step can never run:/),
        ]),
      ]);
    },
  );

  const TIMER =
    '<bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition>';
  const LINEAR =
    '    <bpmn:startEvent id="S" />\n    <bpmn:userTask id="A" />\n    <bpmn:endEvent id="E" />\n';

  const DEPLOY = (method: string, quote = ''): string =>
    `, which ${method} fails the deployment on${quote}`;
  const RUN = (method: string, when: string): string =>
    `: Operaton deploys it and ${method} fails the run ${when}`;
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
      await expectRefusal(
        xmlToIr(
          bpmnDefs`  <bpmn:message id="M1" name="One" />
  <bpmn:message id="M2" name="Two" />
${process(' isExecutable="true"', 'p', content)}`,
        ),
        UnsupportedDocumentError,
        `a bpmn:${tag} in '${container}' has no id${failure}; give it one`,
      );
    },
  );

  const HERE = "without an id in 'p')";
  it.each([
    [
      'a compensation boundary, which the engine runs, reaches the compensation refusal',
      boundary('<bpmn:compensateEventDefinition />'),
      UnsupportedEventFeatureError,
      `The element (a bpmn:boundaryEvent ${HERE} cannot be imported`,
    ],
    [
      'a boundary with no trigger definition reaches the one-trigger refusal',
      boundary(''),
      UnsupportedEventFeatureError,
      `The element (a bpmn:boundaryEvent ${HERE} cannot be imported`,
    ],
    [
      'a boundary inside a sub-process without an id names neither minted id',
      `${LINEAR}    <bpmn:subProcess><bpmn:startEvent id="SS" /><bpmn:userTask id="B" /><bpmn:boundaryEvent attachedToRef="B"><bpmn:compensateEventDefinition /></bpmn:boundaryEvent></bpmn:subProcess>`,
      UnsupportedEventFeatureError,
      'The element (a bpmn:boundaryEvent without an id) cannot be imported',
    ],
    [
      'a compensation handler',
      `${LINEAR}    <bpmn:userTask isForCompensation="true" />`,
      UnsupportedEventFeatureError,
      `The element (a bpmn:userTask ${HERE} cannot be imported`,
    ],
    [
      'a link throw naming no link',
      `${LINEAR}    <bpmn:intermediateThrowEvent><bpmn:linkEventDefinition /></bpmn:intermediateThrowEvent>`,
      UnsupportedEventFeatureError,
      `The element (a bpmn:intermediateThrowEvent ${HERE} cannot be imported`,
    ],
    [
      'a service task with no binding',
      `${LINEAR}    <bpmn:serviceTask />`,
      UnsupportedServiceTaskFormError,
      `Service task (a bpmn:serviceTask ${HERE} uses unsupported execution form`,
    ],
    [
      'two input parameters sharing a name',
      `${LINEAR}    <bpmn:userTask><bpmn:extensionElements><operaton:inputOutput><operaton:inputParameter name="a">1</operaton:inputParameter><operaton:inputParameter name="a">2</operaton:inputParameter></operaton:inputOutput></bpmn:extensionElements></bpmn:userTask>`,
      UnsupportedExtensionFormError,
      `The Operaton extension content on (a bpmn:userTask ${HERE} cannot be imported`,
    ],
    [
      'a call activity naming nothing to call',
      `${LINEAR}    <bpmn:callActivity />`,
      UnsupportedCallActivityError,
      `The call activity (a bpmn:callActivity ${HERE} cannot be imported`,
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
      'a process cannot start on an error; Operaton ignores the trigger and ' +
        'starts the process as if none were written, so importing it would ' +
        'write back a document the engine runs differently from what it says',
      "Catch it with 'on error' inside the scope that raises it.",
    ],
    [
      'a start on an escalation, which Operaton ignores',
      startTriggerXml('<bpmn:escalationEventDefinition id="d" />'),
      'TStart',
      'a process cannot start on an escalation; Operaton ignores the trigger ' +
        'and starts the process as if none were written, so importing it ' +
        'would write back a document the engine runs differently from ' +
        'what it says',
      "Catch it with 'on escalation' inside the scope that raises it.",
    ],
    [
      'a start on compensation, which Operaton ignores',
      startTriggerXml('<bpmn:compensateEventDefinition id="d" />'),
      'TStart',
      'a process cannot start on compensation; Operaton ignores the trigger ' +
        'and starts the process as if none were written, so importing it ' +
        'would write back a document the engine runs differently from ' +
        'what it says',
      "Compensation undoes a subprocess's completed work, so it belongs " +
        "in an 'on compensation' block inside that subprocess.",
    ],
    [
      'a message start whose message name embeds an expression',
      startTriggerXml(MESSAGE_DEF, {
        roots: '  <bpmn:message id="Message_1" name="Order-${type}" />\n',
      }),
      'TStart',
      'a message start event\'s message name "Order-${type}" is an ' +
        'expression; Operaton rejects an expression there, because a ' +
        'process that has not started yet has no variables to evaluate it ' +
        'against',
      'Give the message a fixed name.',
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
      "the process 'p' has 2 plain or timer starts, which " +
        'BpmnParse.selectInitial fails the deployment on ("multiple ' +
        'none start events or timer start events not supported on ' +
        'process definition")',
      undefined,
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
      'it has 2 start events; this tool writes one entry point per ' +
        'subprocess or transaction, so a second start has nowhere to go',
      undefined,
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
      'a thrown message carries a connector; that is what makes the ' +
        'engine really send it, and this surface has no place to keep it',
      undefined,
    ],
    [
      'a class with a resultVariable on an emit, quoting the engine',
      emitXml(
        sendDef(
          'operaton:class="com.example.Send" operaton:resultVariable="r"',
        ),
      ),
      'Emit1',
      'its message definition binds operaton:class with ' +
        "operaton:resultVariable, which Operaton refuses to deploy: \"'resultVariableName' not supported " +
        "for intermediateMessageThrowEvent elements using 'class'\" " +
        '(BpmnParse.parseServiceTaskLike)',
      undefined,
    ],
    [
      'an expression with a resultVariable on a message end, whose value the engine stores',
      endTriggerXml(
        sendDef(
          'operaton:expression="${sender.send()}" operaton:resultVariable="r"',
        ),
      ),
      'Typed',
      'its message definition binds operaton:expression with ' +
        'operaton:resultVariable="r", under which ' +
        "BpmnParse.parseServiceTaskLike stores the expression's value " +
        '(ServiceTaskExpressionActivityBehavior); a thrown message in ' +
        'this script takes no result variable, so dropping it would ' +
        'change what runs',
      undefined,
    ],
  ])('%s refuses', async (_title, xml, elementId, detail, remedy) => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(xml),
      UnsupportedEventFeatureError,
      detail,
    );
    expect(e.elementId).toBe(elementId);
    if (remedy !== undefined) {
      expect(e.message).toBe(
        `The element '${elementId}' cannot be imported: ${detail}. ${remedy}`,
      );
    }
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
          "The bpmn:transaction 'Sub' has no start event: Operaton " +
          'deploys it and SubProcessActivityBehavior.execute fails on ' +
          'entering it ("No initial activity found"); the script adds a ' +
          'start, so the imported block runs.',
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
    `The '${attr}' setting on 'Typed' was not imported: ` +
    'BpmnParse.parseServiceTaskLike hands it to an expression binding ' +
    `alone, so ${binding} never writes it.`;

  const readOffThrow = (what: string, carrier: string): string =>
    `The ${what} on 'Typed' was not imported: ` +
    `BpmnParse.parseExternalServiceTask reads it off ${carrier} of a ` +
    'thrown message bound with operaton:type="external", and this ' +
    "surface's throw has no position for it, so the document written " +
    'back runs without it.';

  const neverReadOnThrow = (what: string): string =>
    `The ${what} on 'Typed' was not imported: Operaton reads it in ` +
    'parseExternalServiceTask alone, which only a thrown message bound ' +
    'with operaton:type="external" reaches, so the event runs as written ' +
    'without it.';

  const throwOnly = (what: string): string =>
    `The ${what} on 'TStart' only takes effect on a throw ('throw ` +
    "message' or 'emit message'); it has no effect on a catch and was " +
    'not imported.';

  const FIELD_HOME =
    'this tool carries an injected field on the step or the listener ' +
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
        "The 'topic' setting on 'Typed' only takes effect alongside " +
          'operaton:type="external"; on its own it names no external worker ' +
          'and was not imported.',
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
        neverWritten('resultVariable', 'an operaton:type="external" binding'),
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
        "The injected field 'to' on the message definition of 'Typed' " +
          `was not imported: ${FIELD_HOME}; BpmnParse.parseServiceTaskLike ` +
          'reads it off the definition into the class it names, so the ' +
          'document written back runs that without it.',
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
        "The injected field 'to' on the message definition of 'Typed' " +
          `was not imported: ${FIELD_HOME}, and Operaton injects a field ` +
          'into a class or a delegate binding and into no other.',
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
        readOffThrow("'taskPriority' setting", 'the message definition'),
        readOffThrow('operaton:properties block', 'the event element'),
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
        neverReadOnThrow("'taskPriority' setting"),
        neverReadOnThrow("operaton:errorEventDefinition 'Map_1'"),
        neverReadOnThrow('operaton:properties block'),
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
        throwOnly("'taskPriority' setting"),
        throwOnly("'resultVariable' setting"),
        throwOnly("operaton:field 'to'"),
        throwOnly("operaton:errorEventDefinition 'Map_1'"),
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

  const on = (
    category: ImportWarning['category'],
    message: string | ReturnType<typeof expect.stringContaining>,
  ) => ({ elementId: 'T', category, message });

  const both = (pair: string, rule: string, kept: string, dropped: string) =>
    on(
      'extensionAttribute',
      `Both ${pair} on 'T'; ${rule}, so '${kept}' was imported and '${dropped}' was dropped.`,
    );

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
          'operaton:collection and bpmn:loopDataInputRef name the collection',
          'parseMultiInstanceLoopCharacteristics writes both into the same field and bpmn:loopDataInputRef second',
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
          'operaton:collection and bpmn:loopDataInputRef name the collection',
          'parseMultiInstanceLoopCharacteristics stores an expression (a value ' +
            'containing "{") and a variable name in two fields, and ' +
            'MultiInstanceActivityBehavior.resolveNrOfInstances reads the expression ' +
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
          'bpmn:inputDataItem and operaton:elementVariable name what each run sees',
          'parseMultiInstanceLoopCharacteristics writes both into the same field and bpmn:inputDataItem second',
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
          "The bpmn:completionCondition on 'T' is the bare text " +
            '"nrOfCompletedInstances > 1" with no "${...}" or "#{...}" opener: ' +
            'parseMultiInstanceLoopCharacteristics hands it to createExpression as ' +
            'a literal and MultiInstanceActivityBehavior.completionConditionSatisfied ' +
            'throws expressionNotBooleanException when the first run completes; ' +
            'the script writes it inside "${...}", which evaluates it.',
        ),
        on(
          'unmappedConstruct',
          'The language="groovy" on the bpmn:completionCondition of \'T\' ' +
            'was not imported: parseMultiInstanceLoopCharacteristics hands ' +
            'the text alone to createExpression and reads no language, so ' +
            'the imported step runs the same.',
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
          'The bpmn:loopDataOutputRef on the repetition',
        ],
        [
          'behavior="One"',
          'behavior="One"',
          '',
          'The behavior="One" on the repetition',
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
        [on('unmappedConstruct', expect.stringContaining(message))],
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
      'it sets neither a number of runs nor a collection to run over, and Operaton refuses to deploy that',
    ],
    [
      'an empty bpmn:loopCardinality',
      repeatedTaskDoc('', '<bpmn:loopCardinality />'),
      'its bpmn:loopCardinality is empty, so Operaton has no number of runs to read',
    ],
    [
      'a fractional bpmn:loopCardinality',
      repeatedTaskDoc('', '<bpmn:loopCardinality>3.5</bpmn:loopCardinality>'),
      'its bpmn:loopCardinality is "3.5", which this tool cannot write back out unchanged; it ' +
        'writes a count as a plain whole number or as an expression, and this body is neither',
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
      'a bpmn:inputDataItem name outside the identifier the clause writes',
      repeatedTaskDoc(
        'operaton:collection="lines"',
        '<bpmn:inputDataItem id="Item" name="my var" />',
      ),
      'it names "my var" for each run to see, which this tool cannot write back ' +
        'out unchanged; it writes that name as a plain identifier, and this name is not one',
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
      'it maps an \'operaton:outputParameter\', which BpmnParse.checkActivityOutputParameterSupported fails the deployment on ("operaton:outputParameter not allowed for multi-instance constructs")',
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

  const loopedHandler = (loop: string, roots = ''): string =>
    handlerDoc(
      '<bpmn:signalEventDefinition id="SigDef" signalRef="Signal_Escalate" />',
      { roots },
    ).replace(
      '<bpmn:subProcess id="Handler" triggeredByEvent="true">',
      `<bpmn:subProcess id="Handler" triggeredByEvent="true">\n      ${loop}`,
    );

  it('an event handler carrying a multi-instance repetition is refused', async () => {
    await expectRefusal(
      xmlToIr(
        loopedHandler(
          repeat('', '<bpmn:loopCardinality>2</bpmn:loopCardinality>'),
        ),
      ),
      UnsupportedLoopCharacteristicsError,
      'an event handler is entered by its trigger, so it cannot be repeated',
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
          "The bpmn:standardLoopCharacteristics on 'Handler' was not " +
          'imported: Operaton does not run one at all, it deploys the step ' +
          'and runs it once, so the imported step runs once too.',
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
    `The ${slot} on '${id}' is written with "#{...}"; the script prints its ` +
    'body as bare DSL and the rebuilt document writes it inside "${...}", ' +
    'which Operaton evaluates identically.';

  it.each([
    [
      'a loop cardinality',
      loopDoc('<bpmn:loopCardinality>#{lineCount}</bpmn:loopCardinality>'),
      rewrapped('bpmn:loopCardinality', 'T'),
    ],
  ] as const)('%s reports the rewrap', async (_title, xml, message) => {
    const { warnings } = await xmlToIr(xml);
    expect(warnings.map((w) => w.message)).toEqual([message]);
    expect(warnings.map((w) => w.category)).toEqual(['rewritten']);
  });
});

describe('xmlToIr: a scripted condition on a sequence flow or a conditional event definition', () => {
  const flowDoc = (
    conditionAttrs: string,
    doc: XmlTag = operatonDoc,
    body = '${amount &gt; 1000}',
    flowAttrs = '',
    plainFlowAttrs = '',
  ): string =>
    doc`    <bpmn:startEvent id="S" />
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

  it.each([
    [
      'an unprefixed xsi:type dropped by moddle still reads language and resource, since parseConditionExpression resolves it against BPMN20_NS regardless',
      'xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'language="groovy" operaton:resource="deployment://check.groovy"',
      operatonDoc,
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
    ['xsi:type="bpmn:tExpression"', 'bpmn:tExpression'],
    [
      'an unprefixed xsi:type="tExpression" in a bpmn:-prefixed document, which moddle drops before any reader sees it',
      'tExpression',
    ],
  ])(
    '%s refuses with the sentence parseConditionExpression fails the deployment with',
    async (_title, xsiType) => {
      const e = await expectRefusal<UnsupportedConditionExpressionError>(
        xmlToIr(
          flowDoc(
            `xsi:type="${xsiType}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`,
          ),
        ),
        UnsupportedConditionExpressionError,
        `it is typed xsi:type="${xsiType}", which ` +
          'BpmnParse.parseConditionExpression fails the deployment on ' +
          '("Invalid type, only tFormalExpression is currently supported")',
      );
      expect(e.elementId).toBe('F2');
    },
  );

  it.each([
    [
      'an unprefixed xsi:type="tFormalExpression" in a bpmn:-prefixed document, which moddle drops and parseConditionExpression resolves against BPMN20_NS',
      flowDoc(
        'xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      ),
    ],
    [
      'an unprefixed xsi:type="tFormalExpression" in a default-namespace document',
      `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" targetNamespace="http://test">
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
    ],
  ])(
    'a condition with %s imports as the formal expression the engine reads it as',
    async (_title, xml) => {
      const { ir, warnings } = await xmlToIr(xml);
      expect(conditionOf(ir)).toBe('${amount > 1000}');
      expect(warnings).toEqual([]);
    },
  );

  const EMPTY_BODY =
    "The condition on 'F2' has an empty body: " +
    'UelExpressionCondition.evaluate reads it as a string and fails the ' +
    'flow on every run ("condition expression returns non-Boolean"); ' +
    'the flow was imported with no condition.';

  it.each([
    [
      'a body with no "${" or "#{" opener',
      'bpmn:tFormalExpression',
      'amount &gt; 1000',
      'amount > 1000',
      'The condition on \'F2\' is the bare text "amount > 1000" with no ' +
        '"${...}" or "#{...}" opener: UelExpressionCondition.evaluate reads ' +
        'it as a string and fails the flow on every run ("condition ' +
        'expression returns non-Boolean"); the script writes it inside ' +
        '"${...}", which evaluates it.',
    ],
    ['an empty body', 'bpmn:tFormalExpression', '', undefined, EMPTY_BODY],
    [
      'a whitespace-only body recovered past moddle, as moddle imports one',
      'tFormalExpression',
      '   ',
      undefined,
      EMPTY_BODY,
    ],
  ])(
    'a condition with %s warns that the engine fails the flow on every run',
    async (_title, xsiType, body, imported, message) => {
      const { ir, warnings } = await xmlToIr(
        flowDoc(
          `xsi:type="${xsiType}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`,
          operatonDoc,
          body,
        ),
      );
      expect(conditionOf(ir)).toBe(imported);
      expect(warnings).toEqual([
        { elementId: 'F2', category: 'behaviourChanged', message },
      ]);
    },
  );

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
            'The name "yes" on the flow \'F2\' was not imported: the script ' +
            'has no label for a flow, and the rebuilt document names this ' +
            'one by its condition ("amount > 1000").',
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
            'The name "no" on the flow \'F3\' was not imported: the script ' +
            'has no label for a flow, and the rebuilt document leaves this ' +
            'one unnamed.',
        },
      ],
    ],
  ])(
    '%s reports the label only when the rebuilt document would lose it',
    async (_title, flowAttrs, plainFlowAttrs, expected) => {
      const { warnings } = await xmlToIr(
        flowDoc(
          '',
          operatonDoc,
          '${amount &gt; 1000}',
          flowAttrs,
          plainFlowAttrs,
        ),
      );
      expect(warnings).toEqual(expected);
    },
  );

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

  it.each([['a boundary conditional event', 'boundary', 'Owner']] as const)(
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
    ['the exported default reads back as absent', 'P30D', undefined, []],
    [
      'an absent history time to live warns that the rebuilt process deploys',
      undefined,
      undefined,
      [
        {
          elementId: 'p',
          category: 'behaviourChanged',
          message:
            "The process 'p' sets no historyTimeToLive, which " +
            'HistoryTimeToLiveParser.parseAndValidate refuses under the ' +
            "engine's default enforceHistoryTimeToLive; it is written back " +
            "with 'P30D', so the rebuilt process deploys where the source " +
            'did not.',
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
          "The operaton:potentialStarter on 'p' imports as " +
            'candidateStarterUsers: "a,b" and candidateStarterGroups: "g,h": ' +
            'Operaton reads its formal expression that way ' +
            '(BpmnParse.parsePotentialStarterResourceAssignment), and this ' +
            'tool writes it back as operaton:candidateStarterUsers and ' +
            'operaton:candidateStarterGroups, which the engine reads the same.',
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
          "The operaton:potentialStarter on 'p' was not imported: it carries " +
            'no formal expression, and Operaton reads nothing else off it ' +
            '(BpmnParse.parsePotentialStarterResourceAssignment).',
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
            "The 'operaton:failedJobRetryTimeCycle' setting on 'Work' was " +
            'not imported: Operaton reads a retry cycle as an ' +
            '<operaton:failedJobRetryTimeCycle> element and never as an ' +
            'attribute (DefaultFailedJobParseListener.' +
            'setFailedJobRetryTimeCycleValue through ' +
            'BpmnParseUtil.findOperatonExtensionElement), so the document ' +
            'written back runs the same.',
        },
      ],
    },
    {
      title:
        "async and an operaton:in on a thrown signal's definition name parseSignalEventDefinition",
      xml: signalDoc('intermediateThrowEvent', 'operaton:async="true"'),
      warnings: [
        unread(
          "'operaton:async' setting",
          'Ev',
          'a <bpmn:signalEventDefinition>',
          'reads it on a thrown signal as its async delivery ' +
            '(BpmnParse.parseSignalEventDefinition)',
        ),
        unread(
          "operaton:in 'a'",
          'Ev',
          'a <bpmn:signalEventDefinition>',
          'reads it on a thrown signal as its payload ' +
            '(BpmnParse.parseSignalEventDefinition through parseInputParameter)',
        ),
      ],
    },
    {
      title:
        "an operaton:in on a caught signal's definition reads nowhere, since parseSignalEventDefinition only reads it on a throw",
      xml: signalDoc('intermediateCatchEvent'),
      warnings: [
        unread("operaton:in 'a'", 'Ev', 'a <bpmn:signalEventDefinition>'),
      ],
    },
    {
      title:
        'the job priority and task priority on the process name parseProcess',
      xml: headerDoc('operaton:jobPriority="3" operaton:taskPriority="4"'),
      warnings: [
        unread(
          "'operaton:jobPriority' setting",
          'p',
          'a <bpmn:process>',
          'reads it (BpmnParse.parseProcess through parsePriority)',
        ),
        unread(
          "'operaton:taskPriority' setting",
          'p',
          'a <bpmn:process>',
          'reads it (BpmnParse.parseProcess through parsePriority)',
        ),
      ],
    },
  ])('$title', async ({ xml, warnings: expected }) => {
    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual(expected);
  });

  it("a process's own start printing no statement says its initiator went with it", async () => {
    const { warnings } = await xmlToIr(
      headerDoc('', 'operaton:initiator="claimant"', 'StartEvent_p'),
    );
    expect(warnings).toEqual([
      {
        elementId: 'StartEvent_p',
        category: 'extensionAttribute',
        message:
          "The 'operaton:initiator' setting on 'StartEvent_p' was not " +
          "written to the script: 'StartEvent_p' is the kind of name this " +
          'tool generates for itself, which a script cannot repeat, so this ' +
          'start is left out entirely and its initiator with it. Rename it ' +
          'in the diagram to keep the initiator.',
      },
    ]);
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
    expectOneWarning(extensionWarnings(warnings), {
      elementId: 'p',
      message: /formProperty/i,
    });
    expect(warnings.some((w) => w.elementId === 'CleanTask')).toBe(false);
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
    message: `The documentation on '${id}' was not imported: ${position} has no documentation in this tool's surface.`,
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
          'The message "Paid" declared by root \'Msg\' is never used by an on/throw/emit; it was not imported.',
      },
      dropped('p', 'the definitions root'),
      dropped('Err', 'a bpmn:error root'),
      dropped('Esc', 'a bpmn:escalation root'),
      dropped('Msg', 'a bpmn:message root'),
      dropped('Sig', 'a bpmn:signal root'),
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
        /this start is left out entirely and its documentation with it/,
        'documentation',
      ),
      warning(
        'EndEvent_p',
        /Where the script can do without this end, it is left out and its documentation with it/,
        'documentation',
      ),
    ]);
  });

  it.each([
    [
      'a second documentation child leaves the element with none',
      `${doc('The first.')}${doc('The second.')}`,
      /this surface holds one <bpmn:documentation> and 'T' carries 2/,
    ],
    [
      'a textFormat naming anything but plain text leaves the element with none',
      '<bpmn:documentation textFormat="text/html">&lt;p&gt;Hi&lt;/p&gt;</bpmn:documentation>',
      /this surface holds plain text and its textFormat is 'text\/html'/,
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
      [warning('p', /bpmn:extension/, 'unmappedConstruct')],
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
            "A bpmn:dataObject 'Data1' was not imported: Operaton keeps process " +
            'variables in its own store and never dispatches on it, so the ' +
            'imported process runs identically.',
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
            "A bpmn:globalScriptTask 'G3' root element was not imported " +
            '(this tool imports the executable flow and the engine settings on ' +
            'its steps, and nothing declared or drawn beside it).',
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
            "The eventDefinitionRef 'TED' on 'S' was not imported: BpmnParse " +
            'reads only the event definitions nested in the event, so the ' +
            'document written back runs the same.',
        },
        {
          elementId: 'TED',
          category: 'unmappedConstruct',
          message:
            "A bpmn:terminateEventDefinition 'TED' root element was not " +
            'imported (this tool imports the executable flow and the engine ' +
            'settings on its steps, and nothing declared or drawn beside it).',
        },
      ],
    ],
    [
      'isExecutable="false" is reported, and the process imports as executable regardless',
      withRoots('', '', 'isExecutable="false"'),
      [warning('p', /isExecutable="false".*deploy/i, 'behaviourChanged')],
    ],
  ])('%s', async (_title, xml, expected) => {
    const { ir, warnings } = await xmlToIr(xml);
    expect(ir.isExecutable).toBe(true);
    expect(warnings).toEqual(expected);
  });

  it('a trigger on a start event nested inside a sub-process refuses', async () => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(
        oneNodeDoc('subProcess', {
          id: 'Sub',
          doc: bpmnDoc,
          children: `<bpmn:startEvent id="SubStart">
        <bpmn:timerEventDefinition />
      </bpmn:startEvent>
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="SubEnd" />`,
        }),
      ),
      UnsupportedEventFeatureError,
      'a subprocess cannot start on a trigger: Operaton rejects one there ' +
        'when it parses the file; a subprocess is entered from the ' +
        'surrounding process, not by an event of its own',
    );
    expect(e.elementId).toBe('SubStart');
    expect(e.message).toContain("Put the trigger on an 'on' handler");
    expect(e.message).not.toContain('Event handlers catch one');
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
      `The '${attr}' on an operaton:in of 'CallSub' has no effect alongside ` +
        `${winner} and was not imported: ${why}.`,
    );
  const PROVIDER_READS_ALL =
    'BpmnParse.parseCallableElementProvider passes every variable and reads nothing else';
  const KEY_ALONE =
    'BpmnParse.parseInputParameter reads the business key alone off that element';

  it.each([
    {
      title:
        'a binding word parseBinding does not know imports as latest, naming the rewrite',
      xml: callDoc('camunda:calledElementBinding="bogus"', '', dualDoc),
      node: { binding: { kind: 'latest' } },
      warnings: [
        onCall(
          'The calledElementBinding="bogus" on \'CallSub\' imports as ' +
            'binding: latest: BpmnParse.parseBinding sets no binding for that ' +
            'word and BaseCallableElement.isLatestBinding reads none as ' +
            'latest, and this tool writes it back as ' +
            'calledElementBinding="latest", which the engine reads the same.',
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
          "The 'variableMappingDelegateExpression' setting on 'CallSub' " +
            'has no effect alongside operaton:variableMappingClass and was ' +
            'not imported.',
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
          'BpmnParse.parseCallableElementProvider reads source first',
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
          'The operaton:in businessKey="${a}" on \'CallSub\' has no effect ' +
            'alongside a later one and was not imported: ' +
            'BpmnParse.parseInputParameter hands each to ' +
            'setBusinessKeyValueProvider, and the last stands.',
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
      'calledElementBinding="version" is set without a calledElementVersion, ' +
        'so the engine cannot resolve which version to use',
    ],
    [
      'calledElementBinding="versionTag", which this surface has no setting for',
      callDoc('operaton:calledElementBinding="versionTag"'),
      'calledElementBinding="versionTag" pins a version tag, which this ' +
        'surface has no setting for',
    ],
    [
      'operaton:calledElementTenantId',
      callDoc('operaton:calledElementTenantId="tenant-a"'),
      /calledElementTenantId/,
    ],
    [
      'a caseRef and no calledElement',
      oneNodeDoc('callActivity', {
        id: 'CallSub',
        attrs: 'operaton:caseRef="claims"',
      }),
      'it names operaton:caseRef="claims" and no calledElement, so ' +
        'BpmnParse.parseCallActivity runs a case through ' +
        'CaseCallActivityBehavior, which this surface has no form for',
    ],
    [
      'neither a calledElement nor a caseRef',
      oneNodeDoc('callActivity', { id: 'CallSub' }),
      'it names neither a calledElement nor an operaton:caseRef, which ' +
        'BpmnParse.parseCallActivity refuses to deploy ("Missing attribute ' +
        "'calledElement' or 'caseRef'\")",
    ],
    [
      'a calledElement beside a caseRef',
      callDoc('operaton:caseRef="claims"'),
      'it names a calledElement beside operaton:caseRef="claims", which ' +
        'BpmnParse.parseCallActivity refuses to deploy ("The attributes ' +
        "'calledElement' or 'caseRef' cannot be used together\")",
    ],
    [
      'an operaton:in with source but no target',
      callDoc('', '<operaton:in source="a" />'),
      'an operaton:in carries source without a target',
    ],
    [
      'an operaton:in with variables="foo"',
      callDoc('', '<operaton:in variables="foo" />'),
      'an operaton:in carries variables="foo", which this tool cannot import (only variables="all" is supported)',
    ],
    [
      'an empty operaton:in',
      callDoc('', '<operaton:in />'),
      'an operaton:in carries none of the recognized shapes (source+target, sourceExpression+target, variables="all", or businessKey)',
    ],
    [
      'an operaton:in with an empty source, quoting the strict validation',
      callDoc('', '<operaton:in source="" target="b" />'),
      'an operaton:in carries source="", which BpmnParse.parseCallableElementProvider refuses to deploy ("Empty attribute \'source\' when passing variables")',
    ],
    [
      'an operaton:in with sourceExpression but no target',
      callDoc('', '<operaton:in sourceExpression="${a}" />'),
      'an operaton:in carries sourceExpression without a target',
    ],
  ])('a call activity with %s is refused', async (_title, xml, detail) => {
    await expectRefusal(xmlToIr(xml), UnsupportedCallActivityError, detail);
  });
});

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
        'a handler start with two event definitions',
        handlerDoc(
          `<bpmn:errorEventDefinition />
        <bpmn:escalationEventDefinition />`,
          { body: '' },
        ),
      ],
      [
        'isInterrupting="false" on an error handler',
        handlerDoc('<bpmn:errorEventDefinition errorRef="Error_X" />', {
          roots: '  <bpmn:error id="Error_X" errorCode="X" />\n',
          startAttrs: 'isInterrupting="false"',
        }),
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

    it.each([
      [
        'into',
        '<bpmn:sequenceFlow id="F2" sourceRef="S" targetRef="Handler" />',
        "the flow 'F2' enters the event handler 'Handler', which " +
          'BpmnParse.parseSequenceFlow fails the deployment on ("Invalid ' +
          'incoming sequence flow of event subprocess"); a handler is ' +
          'entered by its trigger',
      ],
      [
        'out of',
        '<bpmn:sequenceFlow id="F2" sourceRef="Handler" targetRef="E" />',
        "the flow 'F2' leaves the event handler 'Handler', which " +
          'BpmnParse.parseSequenceFlow fails the deployment on ("Invalid ' +
          'outgoing sequence flow of event subprocess"); a handler ends ' +
          'where its body ends',
      ],
    ])(
      'a flow %s an event handler written without incoming/outgoing children refuses on the flow itself',
      async (_direction, flow, detail) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(wiredHandler(flow)),
          UnsupportedEventFeatureError,
          detail,
        );
        expect(e.elementId).toBe('Handler');
        expect(e.message).toContain("Take the flow 'F2' off");
      },
    );

    const workBoundaryDoc = (boundary: string, roots = ''): string =>
      rootedDoc(
        roots,
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

    const danglingEscalation = (method: string): string =>
      "its escalationRef 'Esc_Missing' names no bpmn:escalation root, " +
      'which Operaton refuses to deploy ("could not find escalation with ' +
      `id 'Esc_Missing'", BpmnParse.${method})`;

    it.each([
      [
        'a boundary catch whose escalationRef names no root',
        workBoundaryDoc(
          '<bpmn:escalationEventDefinition escalationRef="Esc_Missing" />',
        ),
        'B',
        danglingEscalation(
          'createEscalationEventDefinitionForEscalationHandler',
        ),
      ],
      [
        'an escalation end whose escalationRef names no root',
        throwDoc(
          '<bpmn:escalationEventDefinition escalationRef="Esc_Missing" />',
        ),
        'Throw',
        danglingEscalation('findEscalationForEscalationEventDefinition'),
      ],
      [
        'an escalation end with no escalationRef',
        throwDoc('<bpmn:escalationEventDefinition />'),
        'Throw',
        'its escalation definition carries no escalationRef, which Operaton ' +
          'refuses to deploy ("escalationEventDefinition does not have ' +
          "required attribute 'escalationRef'\", " +
          'BpmnParse.findEscalationForEscalationEventDefinition)',
      ],
      [
        'an escalation end naming a code-less root',
        throwDoc(
          '<bpmn:escalationEventDefinition escalationRef="Esc_NoCode" />',
          '  <bpmn:escalation id="Esc_NoCode" />\n',
        ),
        'Throw',
        "its escalationRef names the bpmn:escalation root 'Esc_NoCode', " +
          'which carries no code; Operaton refuses to deploy a throw of one ' +
          '("throwing escalation event must have an \'escalationCode\'", ' +
          'BpmnParse.parseIntermediateThrowEvent; "escalation end event ' +
          "must have an 'escalationCode'\", parseEndEvents)",
      ],
      [
        'an error end with no errorRef',
        throwDoc('<bpmn:errorEventDefinition />'),
        'Throw',
        'its error definition carries no errorRef, which Operaton refuses ' +
          "to deploy (\"'errorRef' attribute is mandatory on error end " +
          'event", BpmnParse.parseEndEvents)',
      ],
      [
        'an error end naming a code-less root',
        throwDoc(
          '<bpmn:errorEventDefinition errorRef="Error_NoCode" />',
          '  <bpmn:error id="Error_NoCode" />\n',
        ),
        'Throw',
        "its errorRef names the bpmn:error root 'Error_NoCode', which " +
          'carries no code; Operaton refuses to deploy the throw ' +
          "(\"'errorCode' is mandatory on errors referenced by throwing " +
          'error event definitions", BpmnParse.parseEndEvents)',
      ],
    ])(
      '%s refuses with UnsupportedEventFeatureError quoting the engine',
      async (_title, xml, elementId, detail) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
          detail,
        );
        expect(e.elementId).toBe(elementId);
      },
    );

    const danglingErrorRef = (ownerId: string): ImportWarning => ({
      elementId: ownerId,
      category: 'rewritten',
      message:
        `The errorRef 'Error_Missing' on '${ownerId}' names no bpmn:error ` +
        "root and imports as the code 'Error_Missing': Operaton takes a " +
        "dangling reference's text as the code " +
        '(BpmnParse.parseBoundaryErrorEventDefinition, ' +
        'parseErrorStartEventDefinition, parseEndEvents, ' +
        'parseOperatonErrorEventDefinitions), and the document written ' +
        'back declares an error root carrying it.',
    });

    it("an error end whose errorRef names no root imports the reference text as the code, the engine's reading, with one warning", async () => {
      const { ir, warnings } = await xmlToIr(
        throwDoc('<bpmn:errorEventDefinition errorRef="Error_Missing" />'),
      );
      const owner = byId(ir, 'Throw');
      expect('eventDefinition' in owner && owner.eventDefinition).toEqual(
        errorDef('Error_Missing'),
      );
      expect(warnings).toEqual([danglingErrorRef('Throw')]);
      expect(ir.errorDecls).toBeUndefined();
      expect(await irToXml(ir)).toContain(
        '<bpmn:error id="Error_Error_Missing" name="Error_Missing" errorCode="Error_Missing" />',
      );
    });
  });

  describe('warn-drops', () => {
    const unusedRootXml = (root: string, defs = bpmnDefs) =>
      rootedDoc(
        `${root}\n`,
        `    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`,
        defs,
      );

    it('an error root with no code warns and is dropped', async () => {
      const { ir, warnings } = await xmlToIr(
        unusedRootXml('  <bpmn:error id="Error_NoCode" name="NoCode" />'),
      );
      expect(ir.errorDecls).toBeUndefined();
      expect(ir.escalationDecls).toBeUndefined();
      expect(
        warnings
          .filter((w) => w.category === 'unreferencedRoot')
          .map((w) => w.elementId),
      ).toEqual(['Error_NoCode']);
    });
  });
});

describe('xmlToIr: message/signal/timer/conditional import', () => {
  describe('refusals', () => {
    it.each([
      [
        'a ref-less message definition',
        handlerDoc('<bpmn:messageEventDefinition id="d" />', { body: '' }),
        'a message definition must reference a bpmn:Message root with a ' +
          'non-empty name',
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
        "its messageRef 'tns:Message_1' names no bpmn:Message root: this " +
          'tool matches the reference to a root id as written, where ' +
          'Operaton resolves a prefixed reference through the xmlns table ' +
          '(BpmnParse.resolveName) and refuses an unresolved one',
      ],
      [
        'a timer definition with zero time children',
        handlerDoc('<bpmn:timerEventDefinition id="d" />', { body: '' }),
        'a timer definition must carry exactly one of ' +
          'timeDuration/timeDate/timeCycle (found 0)',
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
      expect(rootWarning.elementId).toBe('Item_1');
      expect(rootWarning.message).toContain("bpmn:itemDefinition 'Item_1'");
    });
  });
});

describe('xmlToIr: compensation import', () => {
  describe('refusals', () => {
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

    const BOUNDARY = `<bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>`;
    const HANDLER =
      '<bpmn:userTask id="CancelReservation" isForCompensation="true" />';
    const RESERVE =
      '<bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />';

    const pairedDoc = (...nodes: readonly string[]): string =>
      operatonDoc`    <bpmn:startEvent id="S" />
    ${nodes.join('\n    ')}
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
    <bpmn:association id="Assoc1" sourceRef="CompensationBoundary" targetRef="CancelReservation" />`;

    const REWRITE_PREVIEW = [
      'subprocess Compensated_ReserveRoom {',
      '  service ReserveRoom(class: "com.example.Reserve")',
      '  on compensation {',
      '    user CancelReservation',
      '  }',
      '}',
    ];

    it.each([
      [
        'the handler comes first in document order',
        pairedDoc(RESERVE, HANDLER, BOUNDARY),
        'CancelReservation',
        REWRITE_PREVIEW,
      ],
    ] as const)(
      'a compensated activity, its boundary event and its association-linked handler are all named in the refusal, and the printed rewrite re-parses through the compiler (%s)',
      async (_title, xml, elementId, preview) => {
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
        );
        expect(e.elementId).toBe(elementId);
        expect(e.detail).toContain('ReserveRoom');
        expect(e.detail).toContain('CompensationBoundary');
        expect(e.detail).toContain('CancelReservation');
        await expectRewrite(e, preview);
      },
    );

    it('a compensated activity that independently carries content this tool cannot import at all still raises the compensation refusal, not that unrelated one', async () => {
      // Boundary first: only the rewrite preview's mapper meets the host before the container walk.
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
        // Moddle fills `incoming` from optional children alone; Operaton reads the flow's targetRef.
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
  });
});

describe('xmlToIr: intermediate catch event import', () => {
  const unsupportedTriggerXml = (definitionXml: string, doc = bpmnDoc) =>
    oneNodeDoc('intermediateCatchEvent', {
      id: 'Wait',
      children: definitionXml,
      doc,
    });

  describe('refuses an unsupported trigger', () => {
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
    throwChildren?: string;
    throwDef?: string;
    catchAttrs?: string;
    catchDef?: string;
    extraFlows?: string;
    defs?: XmlTag;
  }

  const pairDoc = ({
    throwAttrs = 'name="Retry"',
    throwChildren = '',
    throwDef = LINK_DEF,
    catchAttrs = 'name="Retry"',
    catchDef = LINK_DEF,
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
      ${catchDef}
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
        `The ${what} on 'ToRetry' was not imported: Operaton creates no ` +
        `activity for a link throw, so it never ${does} one.`,
    });
    expect(warnings).toEqual([
      dropped("'asyncBefore' setting", 'reads a setting on'),
      dropped("'jobPriority' setting", 'reads a setting on'),
      dropped("'retryCycle' setting", 'reads a setting on'),
      dropped("'end' execution listener", 'runs a listener on'),
      dropped('operaton:properties block', 'reads a property list on'),
      dropped('operaton:inputOutput block', 'reads a mapping on'),
    ]);
  });

  it.each([
    ['the throw', 'ToRetry', { throwDef: '<bpmn:linkEventDefinition />' }],
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
});

describe('xmlToIr: a label on an event the surface gives no label to', () => {
  it.each([
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
        ['rewritten', 'Review', expect.stringContaining(detail)],
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
      'The operaton:resultVariableName="out" on \'T\' imports as ' +
      'resultVariable: "out": BpmnParse.parseResultVariable reads the two ' +
      'spellings as one, and this tool writes it back as ' +
      'operaton:resultVariable, which the engine reads the same.',
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
            "The 'resultVariableName' setting on 'T' has no effect alongside " +
            'operaton:resultVariable and was not imported.',
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
    /'jobPriority' setting on 'Handler' was not imported: the 'on timer' head.*timer job.*continuation job/,
  );

  const BOTH_JOBS_WARNING = warning(
    'B',
    /operaton:exclusive="true" on the event.*continuation job.*operaton:exclusive="false" on its timer definition.*timer job.*took the timer definition's/,
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

// The gateway is written first or last, so a sweep keyed on document position meets it at either end.
const gatewayDoc = (
  tag: string,
  attrs: string,
  {
    children = '',
    placement = 'first',
    doc: wrapper = operatonDoc,
  }: { children?: string; placement?: 'first' | 'last'; doc?: XmlTag } = {},
): string => {
  const node = `<bpmn:${tag} id="G" ${attrs}>${children}</bpmn:${tag}>`;
  const others = `<bpmn:startEvent id="S" />
    ${TIMER_CATCH}
    <bpmn:endEvent id="E" />`;
  const [head, tail] = placement === 'first' ? [node, others] : [others, node];
  return wrapper`    ${head}
    ${tail}
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="G" />
    <bpmn:sequenceFlow id="F2" sourceRef="G" targetRef="C" />
    <bpmn:sequenceFlow id="F3" sourceRef="C" targetRef="E" />`;
};

describe('xmlToIr: the job settings on a gateway', () => {
  it('a split written with the older async spelling carries asyncBefore and names the respelling', async () => {
    const { ir, warnings } = await xmlToIr(
      gatewayDoc('exclusiveGateway', 'operaton:async="true"', {
        placement: 'first',
      }),
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
        'operaton:inputOutput',
        'Throw',
        'a <bpmn:intermediateThrowEvent>',
        'reads it on every throw but a link (BpmnParse.parseActivityInputOutput)',
      ),
      unread(
        'operaton:inputOutput',
        'Wait',
        'a <bpmn:intermediateCatchEvent>',
        'reads it (BpmnParse.parseActivityInputOutput)',
      ),
      unread(
        'operaton:inputOutput',
        'End',
        'a <bpmn:endEvent>',
        'reads its input parameters (BpmnParse.parseActivityInputOutput)',
      ),
    ]);
  });

  it('a parameter with an empty body imports as empty text', async () => {
    const { node: task, warnings } = await importServiceTask(
      ioBlock('          <operaton:inputParameter name="nothing" />'),
    );
    expect(task.inputParameters).toEqual([ioParam('nothing', textValue(''))]);
    expect(warnings).toEqual([]);
  });

  const IO = (
    params = '<operaton:inputParameter name="amount">1</operaton:inputParameter>',
  ): string =>
    extensionElements(`        <operaton:inputOutput>
          ${params}
        </operaton:inputOutput>`);

  const ioRefusal = (tag: string, method: string, suffix = ''): string =>
    `an operaton:inputOutput mapping on a <bpmn:${tag}>, which ` +
    `BpmnParse.${method} fails the deployment on ("operaton:inputOutput ` +
    `mapping unsupported for element type '${tag}'${suffix}")`;

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
      gatewayDoc('parallelGateway', '', { children: IO() }),
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
      'an operaton:outputParameter on a <bpmn:endEvent>, which ' +
        'BpmnParse.checkActivityOutputParameterSupported fails the ' +
        'deployment on ("operaton:outputParameter not allowed for element ' +
        "type 'endEvent'\")",
    ],
  ])(
    'an io mapping on %s refuses, quoting the parser that fails the deployment',
    async (_title, xml, elementId, detail) => {
      const e = await expectRefusal<UnsupportedExtensionFormError>(
        xmlToIr(xml),
        UnsupportedExtensionFormError,
        detail,
      );
      expect(e.elementId).toBe(elementId);
    },
  );

  it('a parameter carrying body text beside one nested child keeps the child and warns on the text', async () => {
    const { node: task, warnings } = await importServiceTask(
      ioBlock(
        `          <operaton:inputParameter name="x">text<operaton:list><operaton:value>a</operaton:value></operaton:list></operaton:inputParameter>`,
      ),
    );
    expect(task.inputParameters).toEqual([
      ioParam('x', listValue([textValue('a')])),
    ]);
    expect(warnings).toEqual([
      {
        elementId: 'Svc',
        category: 'extensionAttribute',
        message:
          "operaton:inputParameter 'x' carries both body text and a " +
          'nested <operaton:List> value: BpmnParseUtil' +
          '.parseNestedParamValueProvider reads the nested value and ' +
          'never the text, and the document written back carries the ' +
          'nested value alone.',
      },
    ]);
  });
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
        "operaton:executionListener 'start'",
        'p',
        'a <bpmn:process>',
        'runs it on the process instance (BpmnParse.parseExecutionListenersOnScope)',
      ),
      unread(
        "operaton:executionListener 'end'",
        'G',
        'a <bpmn:exclusiveGateway>',
        'runs it (BpmnParse.parseExecutionListenersOnScope)',
      ),
      unread(
        "operaton:executionListener 'take'",
        'F2',
        'a <bpmn:sequenceFlow>',
        'runs it when the flow is taken, whatever its event says ' +
          '(BpmnParse.parseExecutionListenersOnTransition)',
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
            'An operaton:executionListener on \'Svc\' has expression="": ' +
            'ExpressionExecutionListener evaluates the empty text rather ' +
            'than refusing it, and the document written back carries it.',
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
            "The 'expression' setting on an operaton:executionListener on " +
            "'Svc' has no effect alongside class and was not imported.",
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
  it('the five non-timeout events import in emission order', async () => {
    const { node: task, warnings } = await importUserTaskWith(
      `        <operaton:taskListener event="create" class="com.example.C" />
        <operaton:taskListener event="assignment" expression="\${bean.assign()}" />
        <operaton:taskListener event="complete" delegateExpression="\${bean}" />
        <operaton:taskListener event="update" class="com.example.U" />
        <operaton:taskListener event="delete" class="com.example.D" />`,
    );
    expect(task.taskListeners?.map((l) => l.event)).toEqual([
      'create',
      'assignment',
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

  it.each([
    {
      case: 'an empty class carries as written, since parseTaskListener checks no attribute for emptiness',
      children: `        <operaton:taskListener event="create" class="" />`,
      listeners: [{ event: 'create', binding: classBinding('') }],
      warnings: [
        {
          elementId: 'Review',
          category: 'carriedAsWritten',
          message:
            'An operaton:taskListener on \'Review\' has class="": ' +
            'BpmnParse.parseTaskListener checks no listener attribute for ' +
            'emptiness, so the task deploys and the listener fails when ' +
            'its event fires, and the document written back carries the ' +
            'empty text.',
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
            'An operaton:taskListener on \'Review\' has expression="": ' +
            'ExpressionTaskListener evaluates the empty text rather than ' +
            'refusing it, and the document written back carries it.',
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
            "An operaton:taskListener on 'Review' has " +
            'delegateExpression="": BpmnParse.parseTaskListener checks no ' +
            'listener attribute for emptiness, so the task deploys and the ' +
            'listener fails when its event fires, and the document written ' +
            'back carries the empty text.',
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
            'The operaton:exclusive="false" on the timer of an ' +
            'operaton:taskListener with event="timeout" on \'Review\' was ' +
            'not imported: this tool has no setting for it there, though ' +
            'Operaton locks the timeout job by it ' +
            '(BpmnParse.parseTimeoutTaskListener through parseTimer), so the ' +
            'document written back runs without it.',
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
            'The bpmn:TimerEventDefinition on an operaton:taskListener ' +
            'with event="create" was not imported: BpmnParse.parseTaskListener ' +
            'reads no event definition off a listener that is not a ' +
            'timeout, and the document written back carries none.',
        },
      ],
    },
  ] as const)('$case', async ({ children, listeners, warnings: expected }) => {
    const { node: task, warnings } = await importUserTaskWith(children);
    expect(task.taskListeners).toEqual(listeners);
    expect(warnings).toEqual(expected);
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

  it.each([
    [
      'a foreign attribute on the operaton:inputOutput block itself reports',
      serviceTaskWith(
        `        <operaton:inputOutput xmlns:foo="http://foo.example" foo:bar="1">
          <operaton:inputParameter name="x">v</operaton:inputParameter>
        </operaton:inputOutput>`,
      ),
      [/'foo:bar' on an operaton:inputOutput/],
    ],
  ] as const)('%s', async (_title, xml, expected) => {
    const { warnings } = await xmlToIr(xml);
    expect(warnings.map((w) => w.message)).toEqual(
      expected.map((pattern) => expect.stringMatching(pattern)),
    );
  });
});

const field = (attrs: string, body = ''): string =>
  body === ''
    ? `        <operaton:field ${attrs} />`
    : `        <operaton:field ${attrs}>${body}</operaton:field>`;

const boundElsewhere = (binding: string): string =>
  'Operaton injects a field into a class, a delegate or a built-in mail or ' +
  `shell binding and into no other, and this one is bound by ${binding}`;

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
      'an operaton:string child carries, and warns that export writes it back as a stringValue attribute',
      'serviceTask',
      CLASS,
      field('name="greeting"', '<operaton:string>hello</operaton:string>'),
      SVC_INJECTED,
      [
        rewrote(
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
          'an operaton:expression child holding ' +
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
        'or delegate binding receives it, on the step whose built-in mail or ' +
        'shell behaviour does, and on no other position.',
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
    message: `The '${attr}' setting on 'T' has no effect alongside ${winner} and was not imported.`,
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
            "The resultVariable 'out' on 'T' was imported as written, and " +
            'the printed script draws a warning at the step: ' +
            'BpmnParse.parseServiceTaskLike hands it to an expression ' +
            'binding alone, so an operaton:type binding never writes it.',
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
            "The shell field 'wait' spelled 'TRUE' on 'T' was imported as " +
            'written, and the printed script draws an error at the field: ' +
            'ShellActivityBehavior.readFields compares it with "true" ' +
            'case-sensitively, so the engine reads it as false.',
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

  const typed = (type: string, fields: string[], attrs = ''): string =>
    oneNodeDoc('serviceTask', {
      attrs: `operaton:type="${type}" ${attrs}`,
      children: fields.length === 0 ? '' : extensionElements(fields.join('\n')),
    });

  it.each([
    [
      'a shell task with a field written as an expression',
      typed('shell', [
        COMMAND,
        field('name="arg1"', '<operaton:expression>${x}</operaton:expression>'),
      ]),
      'Service task',
      'operaton:type="shell" with the field \'arg1\' written as an ' +
        'operaton:expression, which Operaton fails to deploy: ' +
        'BpmnParse.validateFieldDeclarationsForShell casts every shell field ' +
        'to a FixedValue, and an expression is not one',
    ],
    [
      'a shell wait flag outside true and false',
      typed('shell', [COMMAND, field('name="wait" stringValue="yes"')]),
      'Service task',
      "operaton:type=\"shell\" with the field 'wait' set to 'yes', which " +
        'Operaton refuses to deploy: "undefined value for shell wait ' +
        'parameter :yes" (BpmnParse.validateFieldDeclarationsForShell)',
    ],
    [
      'a mail field the behaviour does not declare',
      typed('mail', [TO, TEXT, field('name="recipient" stringValue="x"')]),
      'Service task',
      'operaton:type="mail" with a field \'recipient\', which the mail ' +
        'behaviour does not declare; Operaton refuses to deploy it: "Field ' +
        "definition uses unexisting field 'recipient'\" " +
        '(ClassDelegateUtil.applyFieldDeclaration)',
    ],
    [
      'an operaton:type outside mail, shell and external, beside the class it outranks',
      typed('ftp', [], 'operaton:class="com.example.Svc"'),
      'Service task',
      'operaton:type="ftp", which Operaton resolves ahead of the ' +
        'operaton:class alongside it',
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
      'operaton:type="mail", which this surface carries on a service, send ' +
        'or business rule task alone',
    ],
  ])('%s', async (_title, xml, subject, construct) => {
    const e = await expectRefusal<UnsupportedServiceTaskFormError>(
      xmlToIr(xml),
      UnsupportedServiceTaskFormError,
    );
    expect(e.subject).toBe(subject);
    expect(e.construct).toBe(construct);
  });
});

describe('xmlToIr: a user task names a deployed form by reference', () => {
  const importFormRef = (attrs: string) =>
    importOnly(oneNodeDoc('userTask', { attrs }), 'userTask');

  it('a formRef resolving to the form deployed alongside the process imports the key and the binding together, reporting nothing', async () => {
    const { node, warnings } = await importFormRef(
      'operaton:formRef="review-form" operaton:formRefBinding="deployment"',
    );
    expect(node).toEqual({
      kind: 'userTask',
      id: 'T',
      formRef: { key: 'review-form', binding: { kind: 'deployment' } },
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
      'formRefBinding="versionTag" is outside the bindings ' +
        'BpmnParse.parseFormDefinition resolves (deployment, latest, ' +
        'version), so the engine refuses to deploy it',
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

describe('xmlToIr: a second extension block of one kind refuses, since Element.elementNS throws on it', () => {
  const twice = (block: string): string => `${block}\n${block}`;

  it('a second operaton:formData refuses, naming the reader that meets both', async () => {
    const e = await expectRefusal<UnsupportedExtensionFormError>(
      xmlToIr(
        userTaskWith(
          twice(`        <operaton:formData>
          <operaton:formField id="f" type="string" />
        </operaton:formData>`),
        ),
      ),
      UnsupportedExtensionFormError,
      '2 <operaton:formData> blocks, which Element.elementNS throws on ' +
        'when DefaultFormHandler.parseFormData reads them ("Parsing ' +
        "exception: multiple elements with tag name 'formData' found\"), " +
        'and BpmnParse.execute lets that fail the deployment',
    );
    expect(e.elementId).toBe('Review');
  });
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
        `The 'operaton:initiator' setting on '${id}' was not imported: ` +
        'BpmnParse.parseScopeStartEvent reads no operaton: attribute off a ' +
        "start that is not the process's own " +
        '(parseProcessDefinitionStartEvent reads it there alone), so the ' +
        'document written back runs the same.',
    },
    {
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The operaton:formData block on '${id}' was not imported: ` +
        "BpmnParse.parseStartFormHandlers runs for the process's own start " +
        'alone and parseScopeStartEvent reads no form, so the document ' +
        'written back runs the same.',
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
      detail:
        'DefaultFormHandler.parseValidation deploys both, and this script ' +
        'holds each constraint once per field',
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
  const carried = (message: RegExp) =>
    warning('Review', message, 'carriedAsWritten');
  const rewrote = (message: RegExp) => warning('Review', message, 'rewritten');

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
        carried(
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
        carried(/'min'.*imported as written.*MinValidator\.validate.*'abc'/),
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
        carried(/'zzz'.*imported as written.*EnumFormType\.validateValue/),
      ],
    },
    {
      case: 'a decimal default on a number field is carried and the script draws an error',
      field: `          <operaton:formField id="amount" type="long" defaultValue="1.5" />`,
      imported: { id: 'amount', type: 'number', defaultValue: '1.5' },
      warnings: [
        carried(
          /^The default '1\.5' on form field 'amount' of 'Review' was imported as written.*LongFormType\.convertValue.*Long\.valueOf/,
        ),
      ],
    },
    {
      case: 'a word default on a boolean field is carried and the script draws an error',
      field: `          <operaton:formField id="flag" type="boolean" defaultValue="maybe" />`,
      imported: { id: 'flag', type: 'boolean', defaultValue: 'maybe' },
      warnings: [
        carried(
          /^The default 'maybe' on form field 'flag' of 'Review' was imported as written.*BooleanFormType\.convertValue.*Boolean\.valueOf/,
        ),
      ],
    },
    {
      case: 'an ISO default on a date field with no pattern is carried and the script draws an error',
      field: `          <operaton:formField id="due" type="date" defaultValue="2026-01-01" />`,
      imported: { id: 'due', type: 'date', defaultValue: '2026-01-01' },
      warnings: [
        carried(
          /^The default '2026-01-01' on form field 'due' of 'Review' was imported as written.*DateFormType.*dd\/MM\/yyyy/,
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
      warnings: [rewrote(/value 'a'.*'plan'.*LinkedHashMap/)],
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
        rewrote(
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
  const CODED_ROOT =
    '  <bpmn:error id="Err_Declined" errorCode="DECLINED" />\n';
  const BLANK_ROOT = '  <bpmn:error id="Err_Blank" />\n';

  const mappingDoc = (mapping: string, roots = CODED_ROOT): string =>
    operatonDefs`${roots}  <bpmn:process id="p" isExecutable="true" ${TIME_TO_LIVE}>
    <bpmn:startEvent id="S" />
${externalTask('', mapping)}
    <bpmn:endEvent id="E" />
  </bpmn:process>`;

  it.each([
    [
      'a mapping whose errorRef names no root and carries no expression, which the engine checks before the root',
      errorMapping('errorRef="Err_Missing"'),
      /no expression/,
    ],
    [
      'a mapping whose errorRef names a root with no code',
      errorMapping('errorRef="Err_Blank" expression="${true}"'),
      /'Err_Blank'.*no code/,
    ],
  ])('%s is refused', async (_title, mapping, detail) => {
    const err = await expectRefusal<UnsupportedErrorMappingError>(
      xmlToIr(mappingDoc(mapping, CODED_ROOT + BLANK_ROOT)),
      UnsupportedErrorMappingError,
      detail,
    );
    expect(err.elementId).toBe('Charge');
    expect(err.message).toContain('parseOperatonErrorEventDefinitions');
  });

  const SKIPPED_MAPPING_WARNING: ImportWarning = {
    elementId: 'Charge',
    category: 'unmappedConstruct',
    message:
      "The operaton:errorEventDefinition on 'Charge' carries no errorRef " +
      'and was not imported: BpmnParse.parseOperatonErrorEventDefinitions ' +
      'skips one without it, so the document written back runs the same.',
  };

  it.each([
    [
      'a mapping with no errorRef is skipped with a warning, as the engine skips it',
      errorMapping('expression="${true}"'),
      undefined,
      [SKIPPED_MAPPING_WARNING],
    ],
  ] as const)('%s', async (_title, mapping, errorMappings, expected) => {
    const { node, warnings } = await importById(
      mappingDoc(mapping),
      'Charge',
      'serviceTask',
    );
    expect(node.binding).toEqual({
      ...externalBinding('charge-card'),
      ...(errorMappings === undefined ? {} : { errorMappings }),
    });
    expect(warnings).toEqual(expected);
  });

  it.each([
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
        warning('Charge', /operaton:property #2.*no name/),
        warning(
          'Charge',
          /operaton:property 'k'.*written twice.*HashMap\.put/,
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
    if (binding !== undefined) {
      const node = ir.flowElements.find(
        (fe) => fe.kind === 'serviceTask' && fe.id !== 'Clean',
      );
      expect(node?.kind === 'serviceTask' && node.binding).toEqual(binding);
    }
    expect(warnings).toEqual(expected);
  });

  it('a decimal task priority refuses, quoting parsePriority', async () => {
    const err = await expectRefusal<UnsupportedExtensionFormError>(
      xmlToIr(codedErrorsDoc(externalTask('operaton:taskPriority="1.5"', ''))),
      UnsupportedExtensionFormError,
      priorityRefusal('taskPriority', '1.5'),
    );
    expect(err.elementId).toBe('Charge');
  });
});

// Moddle declares a parameter's nested value as repeating, which is what makes two values detectable.
describe('xmlToIr: the extension-form refusal matrix', () => {
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

  const unspellable = (subject: string): string =>
    `${subject} names a variable the script cannot spell (a name is ` +
    "letters, digits and '_', with '-' between them, and no keyword), and " +
    'the engine sets the variable under that name, so writing another ' +
    'would change what runs';

  it.each([
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
      case: 'a listener script whose body holds three backticks',
      on: 'Svc',
      children: `        <operaton:executionListener event="start">
          <operaton:script scriptFormat="groovy">x = "\`\`\`"</operaton:script>
        </operaton:executionListener>`,
      detail:
        'the operaton:script in an operaton:executionListener contains ' +
        'three consecutive backticks, which no script fence this language ' +
        'has can enclose',
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
      detail:
        /two operaton:inputParameter children share name="x"; Operaton runs both, the last write winning \(IoMapping\.executeInputParameters\)/,
    },
    // The engine sets this variable under a name the script cannot spell.
    {
      case: 'an input parameter whose name the script cannot spell',
      on: 'Svc',
      children: ioBlock(
        `          <operaton:inputParameter name="my.param">1</operaton:inputParameter>`,
      ),
      detail: unspellable("operaton:inputParameter 'my.param'"),
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
      case: 'an execution listener with class=""',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" class="" />`,
      detail:
        'an operaton:executionListener has class="", which ' +
        "BpmnParse.parseExecutionListener refuses (\"Attribute 'class' " +
        'cannot be empty")',
    },
    {
      case: 'an execution listener with delegateExpression=""',
      on: 'Svc',
      children: `        <operaton:executionListener event="start" delegateExpression="" />`,
      detail:
        'an operaton:executionListener has delegateExpression="", which ' +
        'BpmnParse.parseExecutionListener refuses ("Attribute ' +
        "'delegateExpression' cannot be empty\")",
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
      case: 'a timeout task listener with no timer',
      on: 'Review',
      children: `        <operaton:taskListener event="timeout" class="com.example.L" />`,
      detail:
        'an operaton:taskListener with event="timeout" carries no ' +
        'bpmn:timerEventDefinition, so nothing would ever fire it',
    },
  ] as const)(
    '$case is refused, naming the shape and the element',
    async (row) => {
      const err = await refuse(row.on, row.children, row.detail);
      expect(err.elementId).toBe(row.on);
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

  it.each([
    [
      'a mapDecisionResult outside the four Operaton accepts',
      'operaton:mapDecisionResult="firstEntry"',
      'operaton:mapDecisionResult="firstEntry", which is not a way of ' +
        'filling the result variable this tool can represent',
    ],
    [
      'a tenant, as the call activity does',
      'operaton:decisionRefTenantId="acme"',
      'it names operaton:decisionRefTenantId="acme", which pins the tenant ' +
        'BpmnParse.parseTenantId resolves the decision against; dropping it ' +
        'would change which decision runs, and this surface has no tenant ' +
        'setting',
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
      expect([e.serviceTaskId, e.construct]).toEqual(['T', construct]);
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

  const MANUAL_TASK_WARNING = {
    elementId: 'M1',
    category: 'rewritten',
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
          "The bpmn:intermediateThrowEvent 'M' carries no event definition " +
          'and imports as a plain step: BpmnParse.parseIntermediateThrowEvent ' +
          'gives it IntermediateThrowNoneEventActivityBehavior, which only ' +
          "leaves, as a task's behaviour does, so token flow, listeners, " +
          'async and job configuration are unchanged, but history and ' +
          "Cockpit will report its activity type as 'task' rather than " +
          "'intermediateNoneThrowEvent'.",
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
      'an end event carries a cancel definition outside a block that can be given up; ' +
        'Operaton only accepts one directly inside a <bpmn:transaction>, and ' +
        'refuses to deploy the file otherwise. Move the end inside a ' +
        '<bpmn:transaction>, or take the cancel definition off it.',
    ],
    [
      'a cancel boundary on a plain subprocess',
      blockDoc({ tag: 'subProcess', beside: cancelBoundary() }),
      'Boundary_Book_cancel',
      'a cancel boundary event attaches to "Book", a subprocess; Operaton ' +
        'only allows a cancel boundary on a <bpmn:transaction>, and refuses ' +
        'to deploy the file otherwise. Attach it to a <bpmn:transaction>, ' +
        'or take the cancel definition off it.',
    ],
    [
      'a second cancel boundary on the same block',
      pairedDoc({
        beside: cancelBoundary() + cancelBoundary('Boundary_Book_cancel2'),
      }),
      'Boundary_Book_cancel2',
      'a second cancel boundary event attaches to "Book"; Operaton allows ' +
        'one cancel boundary per block and refuses to deploy a file with two. ' +
        'Leave one cancel boundary event on the block.',
    ],
  ])('%s refuses', async (_title, xml, elementId, detail) => {
    const e = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(xml),
      UnsupportedEventFeatureError,
    );
    expect(e.elementId).toBe(elementId);
    expect(e.message).toBe(
      `The element '${elementId}' cannot be imported: ${detail}`,
    );
  });

  it.each([
    [
      'a cancel end with no cancel boundary on its block warns, naming the runtime failure',
      blockDoc({ body: BLOCK_BODY + CANCEL_END }),
      'Book',
      "The block 'Book' holds an end event that gives it up, with no " +
        'cancel boundary event attached to it: Operaton deploys the file and ' +
        'then stops with an error the first time that end is reached. Write ' +
        "'on Book: cancel { ... }' beside the block to catch it.",
      'carriedAsWritten',
    ],
    [
      'a cancel boundary on a block that never gives itself up warns, naming the unreachable path',
      blockDoc({ beside: cancelBoundary() }),
      'Boundary_Book_cancel',
      "The cancel boundary event on 'Book' was imported, but nothing " +
        'inside the block gives it up, so what follows the boundary can ' +
        'never run.',
      'carriedAsWritten',
    ],
    [
      'a method on the block is dropped, since Operaton never reads it there',
      blockDoc({ attrs: 'method="##Store"' }),
      'Book',
      "The 'method' attribute on 'Book' was not imported: Operaton reads it " +
        'on a <bpmn:transaction> not at all, so the imported block runs ' +
        'exactly as the source document does.',
      'unmappedConstruct',
    ],
    [
      'triggeredByEvent on the block is dropped, since Operaton runs it as an ordinary step',
      blockDoc({ attrs: 'triggeredByEvent="true"' }),
      'Book',
      "The 'triggeredByEvent' attribute on 'Book' was not imported: " +
        'Operaton ignores it on a <bpmn:transaction> and runs the block as ' +
        'an ordinary step of the surrounding flow, so the imported block ' +
        'runs exactly as the source document does.',
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
      expect(e.elementId).toBe('G');
      expect(e.message).toContain('BpmnParse.validateExclusiveGateway');
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

  it('a default naming a flow that enters the step is dropped with the warning handleNoTransitions earns it', async () => {
    const { node, warnings } = await importOnly(
      stepDoc('    <bpmn:userTask id="Triage" default="F0" />'),
      'userTask',
    );
    expect(node).toEqual({ kind: 'userTask', id: 'Triage' });
    expect(warnings).toEqual([
      {
        elementId: 'Triage',
        category: 'unmappedConstruct',
        message:
          "The 'default' attribute on 'Triage' was not imported: it names " +
          "'F0', which is not a route out of the step, so " +
          'BpmnActivityBehavior.handleNoTransitions finds no flow to take ' +
          'and fails the step whenever no other route holds; the imported ' +
          'step names no fallback.',
      },
    ]);
  });
});

describe('xmlToIr: a wait with several branches', () => {
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

  it('a wait marked operaton:asyncAfter is refused, naming the engine rule', async () => {
    const err = await expectRefusal<UnsupportedEventFeatureError>(
      xmlToIr(
        waitDoc({ attrs: 'operaton:asyncAfter="true"', defs: operatonDefs }),
      ),
      UnsupportedEventFeatureError,
      "'Wait' is marked asyncAfter, which BpmnParse.parseEventBasedGateway " +
        'refuses to deploy on a wait with several branches',
    );
    expect(err.elementId).toBe('Wait');
    expect(err.message).toBe(
      "The element 'Wait' cannot be imported: 'Wait' is marked " +
        'asyncAfter, which BpmnParse.parseEventBasedGateway refuses to ' +
        'deploy on a wait with several branches. Drop the asyncAfter ' +
        "setting from 'Wait'; its other job settings are read as written.",
    );
  });
});

describe('xmlToIr: refusal and warning wording', () => {
  const potentialOwnerXml = (
    id: string,
    expression: string,
    extra = '',
  ): string =>
    oneNodeDoc('userTask', {
      id: 'Review',
      children: `
      <bpmn:potentialOwner id="${id}">
        <bpmn:resourceAssignmentExpression>
          <bpmn:formalExpression>${expression}</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>
        ${extra}
      </bpmn:potentialOwner>`,
    });

  const candidateUsersWarning = (id: string, users: string) => ({
    elementId: 'Review',
    category: 'rewritten' as const,
    message:
      `The bpmn:potentialOwner '${id}' on 'Review' imports as ` +
      `candidateUsers: "${users}": Operaton reads its formal expression ` +
      'that way (BpmnParse.parsePotentialOwnerResourceAssignment), and ' +
      'this tool writes it back as operaton:candidateUsers, which the ' +
      'engine reads the same.',
  });

  const rows: [title: string, run: () => Promise<void>][] = [
    [
      'a document with no bpmn:process refuses, since there is nothing to import',
      async () => {
        await expectRefusal(
          xmlToIr(bpmnDefs`  <bpmn:message id="M" name="Ping" />`),
          UnsupportedDocumentError,
          'it holds no bpmn:process, so there is nothing to import',
        );
      },
    ],
    ...(
      [
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
      ] as const
    ).map(([shape, first, second, decl]): (typeof rows)[number] => [
      `two bpmn:Error roots sharing a code, ${shape}, merge into one declaration`,
      async () => {
        const { ir, warnings } = await xmlToIr(
          rootedDoc(
            `  <bpmn:error id="Error_A" errorCode="DUP" ${first} />\n` +
              `  <bpmn:error id="Error_B" errorCode="DUP" ${second} />\n`,
            '    <bpmn:endEvent id="E" />\n' +
              '    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />',
            operatonDefs,
          ),
        );
        expect(ir.errorDecls).toEqual([decl]);
        expect(warnings).toEqual([]);
      },
    ]),
    [
      'an unnamed, unreferenced bpmn:message root warns that it cannot be keyed, and is dropped',
      async () => {
        const { warnings } = await xmlToIr(
          rootedDoc(
            '  <bpmn:message id="M1" />\n',
            '    <bpmn:endEvent id="E" />\n' +
              '    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />',
          ),
        );
        expect(warnings).toEqual([
          {
            elementId: 'M1',
            category: 'unreferencedRoot',
            message:
              "The message root 'M1' has no name, so it cannot be keyed " +
              'or represented in the model; it was not imported.',
          },
        ]);
      },
    ],
    [
      'operaton:type="mail" with no fields at all refuses the same as one missing "to"',
      async () => {
        const e = await expectRefusal<UnsupportedServiceTaskFormError>(
          xmlToIr(oneNodeDoc('serviceTask', { attrs: 'operaton:type="mail"' })),
          UnsupportedServiceTaskFormError,
        );
        expect(e.subject).toBe('Service task');
        expect(e.construct).toBe(
          'operaton:type="mail" without a \'to\' field, which Operaton ' +
            'refuses to deploy: "No recipient is defined on the mail ' +
            'activity" (BpmnParse.validateFieldDeclarationsForEmail)',
        );
      },
    ],
    [
      'a timeout listener with two timer event definitions refuses, since a timeout has one due time',
      async () => {
        const xml = oneNodeDoc('userTask', {
          id: 'Review',
          children: extensionElements(
            `        <operaton:taskListener event="timeout">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT8H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>`,
          ),
        });
        // No listener binding: the timer is read before one is resolved.
        await expectRefusal(
          xmlToIr(xml),
          UnsupportedExtensionFormError,
          'an operaton:taskListener with event="timeout" carries 2 ' +
            'bpmn:timerEventDefinition children, and a timeout has one due time',
        );
      },
    ],
    [
      'a single operaton:value on a non-enum field warns in the singular',
      async () => {
        const { warnings } = await importForm(
          `          <operaton:formField id="note" type="string">
            <operaton:value id="a" name="A" />
          </operaton:formField>`,
        );
        expect(warnings).toEqual([
          {
            elementId: 'Review',
            category: 'extensionAttribute',
            message:
              "The 1 operaton:value child of form field 'note' of " +
              "'Review' was not imported; FormTypes.parseFormPropertyType " +
              'reads them on an enum field alone.',
          },
        ]);
      },
    ],
    [
      'a timer boundary on an isForCompensation handler is not the paired pattern, and refuses with the general wording',
      async () => {
        const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />
    <bpmn:boundaryEvent id="TimerBoundary" attachedToRef="ReserveRoom">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:userTask id="CancelReservation" isForCompensation="true" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
    <bpmn:association id="Assoc1" sourceRef="TimerBoundary" targetRef="CancelReservation" />`;
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
          IS_FOR_COMPENSATION_DETAIL,
        );
        expect(e.elementId).toBe('CancelReservation');
      },
    ],
    [
      'a bpmn:association from a plain task to an isForCompensation handler is not the paired pattern either',
      async () => {
        const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />
    <bpmn:task id="NotABoundary" />
    <bpmn:userTask id="CancelReservation" isForCompensation="true" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
    <bpmn:association id="Assoc1" sourceRef="NotABoundary" targetRef="CancelReservation" />`;
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
          IS_FOR_COMPENSATION_DETAIL,
        );
        expect(e.elementId).toBe('CancelReservation');
      },
    ],
    [
      'a sub-process compensated host nests correctly in the rewrite preview, and the preview re-parses through the compiler',
      async () => {
        const xml = operatonDoc`    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="ReserveRoom">
      <bpmn:startEvent id="RStart" />
      <bpmn:userTask id="Hold" />
      <bpmn:endEvent id="REnd" />
      <bpmn:sequenceFlow id="RF1" sourceRef="RStart" targetRef="Hold" />
      <bpmn:sequenceFlow id="RF2" sourceRef="Hold" targetRef="REnd" />
    </bpmn:subProcess>
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
        expect(e.elementId).toBe('CompensationBoundary');
        await expectRewrite(e, [
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
        ]);
      },
    ],
    [
      'a wait branch that leads straight into a bpmn:transaction refuses, naming it "an attempt block"',
      async () => {
        const xml = bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:eventBasedGateway id="Wait" />
    <bpmn:intermediateCatchEvent id="OnLate">
      <bpmn:timerEventDefinition id="OnLateDef">
        <bpmn:timeDuration>P3D</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:transaction id="Attempt">
      <bpmn:startEvent id="AttemptStart" />
      <bpmn:endEvent id="AttemptEnd" />
      <bpmn:sequenceFlow id="ASF1" sourceRef="AttemptStart" targetRef="AttemptEnd" />
    </bpmn:transaction>
    <bpmn:exclusiveGateway id="Merge" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F_S" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F_OnLate" sourceRef="Wait" targetRef="OnLate" />
    <bpmn:sequenceFlow id="F_OnLate_M" sourceRef="OnLate" targetRef="Merge" />
    <bpmn:sequenceFlow id="F_Attempt" sourceRef="Wait" targetRef="Attempt" />
    <bpmn:sequenceFlow id="F_Attempt_M" sourceRef="Attempt" targetRef="Merge" />
    <bpmn:sequenceFlow id="F_Merge" sourceRef="Merge" targetRef="E" />`;
        const e = await expectRefusal<UnsupportedEventFeatureError>(
          xmlToIr(xml),
          UnsupportedEventFeatureError,
        );
        expect(e.elementId).toBe('Attempt');
        expect(e.detail).toBe(
          "a branch of the wait 'Wait' leads to 'Attempt', an attempt " +
            'block; every branch of a wait with several branches has to ' +
            'begin with something to wait for, and only a message, a ' +
            'timer, a signal, or a condition counts as one here',
        );
      },
    ],
    [
      'a potential owner expression with a trailing comma draws no empty candidate',
      async () => {
        const { node, warnings } = await importOnly(
          potentialOwnerXml('PO_Trailing', 'user(alice), user(bob),'),
          'userTask',
        );
        expect(node).toEqual({
          kind: 'userTask',
          id: 'Review',
          candidateUsers: 'alice,bob',
        });
        expect(warnings).toEqual([
          candidateUsersWarning('PO_Trailing', 'alice,bob'),
        ]);
      },
    ],
    [
      'a potential owner carrying resourceParameterBindings imports the expression and warns about the rest',
      async () => {
        const { node, warnings } = await importOnly(
          potentialOwnerXml(
            'PO_Bindings',
            'user(alice)',
            '<bpmn:resourceParameterBinding />',
          ),
          'userTask',
        );
        expect(node).toEqual({
          kind: 'userTask',
          id: 'Review',
          candidateUsers: 'alice',
        });
        expect(warnings).toEqual([
          candidateUsersWarning('PO_Bindings', 'alice'),
          {
            elementId: 'Review',
            category: 'unmappedConstruct',
            message:
              'The resourceParameterBindings on the bpmn:potentialOwner ' +
              "'PO_Bindings' on 'Review' was not imported: Operaton reads " +
              "the role's formal expression alone " +
              '(BpmnParse.parsePotentialOwnerResourceAssignment).',
          },
        ]);
      },
    ],
    [
      'an unsupported element with no id is refused with no "(id=...)" clause',
      async () => {
        const xml = bpmnDoc`    <bpmn:startEvent id="S" />
    <bpmn:complexGateway />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`;
        const e = await expectRefusal<UnsupportedElementError>(
          xmlToIr(xml),
          UnsupportedElementError,
        );
        expect(e.qname).toBe('bpmn:ComplexGateway');
        expect(e.elementId).toBeUndefined();
        expect(e.message).toBe(
          'The BPMN element bpmn:ComplexGateway is a kind that this tool ' +
            `cannot import. ${SUPPORTED_KINDS_MESSAGE}`,
        );
      },
    ],
    [
      'a start carrying the abstract bpmn:eventDefinition tag names it a "special" definition',
      async () => {
        const xml = bpmnDoc`    <bpmn:startEvent id="S">
      <bpmn:eventDefinition id="Def" />
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`;
        const e = await expectRefusal<UnsupportedEventDefinitionError>(
          xmlToIr(xml),
          UnsupportedEventDefinitionError,
        );
        expect(e.definitionType).toBe('bpmn:EventDefinition');
        expect(e.message).toContain(
          'a special definition (bpmn:EventDefinition)',
        );
      },
    ],
  ];

  it.each(rows)('%s', async (_title, run) => {
    await run();
  });
});
