// Pins operaton-moddle.json against a bare BpmnModdle: moddle drops an undeclared extension child with only a
// document-level warning, keeps only the last of two values in a single-valued property, and omits a boolean
// attribute at its declared default on write.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';

const here = dirname(fileURLToPath(import.meta.url));

const OPERATON_EXTENSION: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(here, '../src/operaton-moddle.json'), 'utf-8'),
);

function operatonModdle(): InstanceType<typeof BpmnModdle> {
  return new BpmnModdle({ operaton: OPERATON_EXTENSION });
}

const XML_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">`;

async function parseProcess(
  moddle: InstanceType<typeof BpmnModdle>,
  xmlStr: string,
): Promise<{
  definitions: ModdleElement;
  process: ModdleElement;
  warnings: Error[];
}> {
  const { rootElement, warnings } = await moddle.fromXML(xmlStr);
  const roots = (rootElement as { rootElements: ModdleElement[] }).rootElements;
  const process = roots.find((e) => e.$type === 'bpmn:Process');
  if (process === undefined) {
    throw new Error('No bpmn:Process found in parsed output.');
  }
  return { definitions: rootElement, process, warnings };
}

function extensionValues(el: ModdleElement): ModdleElement[] {
  const extensionElements = el.get('extensionElements') as
    ModdleElement | undefined;
  return extensionElements === undefined
    ? []
    : (extensionElements.get('values') as ModdleElement[]);
}

const elementsOf = (process: ModdleElement): ModdleElement[] =>
  process.get('flowElements') as ModdleElement[];

const definitionsOf = (parameter: ModdleElement): ModdleElement[] =>
  parameter.get('definitions') as ModdleElement[];

function inputParameters(process: ModdleElement): ModdleElement[] {
  const [io] = extensionValues(elementsOf(process)[0]);
  return io.get('inputParameters') as ModdleElement[];
}

describe('every declared type parses with zero warnings, every child at its expected path, and round-trips byte for byte', () => {
  const EVERY_TYPE_FIXTURE = `${XML_HEADER}
  <bpmn:process id="Process_1" isExecutable="true" operaton:versionTag="1.2.3"
                operaton:candidateStarterUsers="demo,manager" operaton:candidateStarterGroups="adjusters">
    <bpmn:startEvent id="Start" operaton:initiator="claimant" />
    <bpmn:userTask id="Review" operaton:assignee="alice" operaton:candidateUsers="bob,carol"
                   operaton:candidateGroups="approvers" operaton:dueDate="P1D"
                   operaton:followUpDate="P2D" operaton:priority="50">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="config">
            <operaton:list>
              <operaton:map>
                <operaton:entry key="nested">
                  <operaton:list>
                    <operaton:value>x</operaton:value>
                    <operaton:value>y</operaton:value>
                  </operaton:list>
                </operaton:entry>
              </operaton:map>
            </operaton:list>
          </operaton:inputParameter>
        </operaton:inputOutput>
        <operaton:taskListener event="create" id="listener1" class="com.example.Listener">
          <operaton:script scriptFormat="groovy" resource="deployment:my.groovy">println 'hi'</operaton:script>
          <operaton:field name="config" stringValue="value1">
            <operaton:expression>\${someExpr}</operaton:expression>
          </operaton:field>
        </operaton:taskListener>
        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:scriptTask id="Compute" operaton:resultVariable="computed" operaton:exclusive="false" operaton:jobPriority="30">
      <bpmn:script>1 + 1</bpmn:script>
    </bpmn:scriptTask>
    <bpmn:serviceTask id="Notify" operaton:class="com.example.Notifier">
      <bpmn:extensionElements>
        <operaton:executionListener event="end" delegateExpression="\${notifyListener}">
          <operaton:field name="target" stringValue="ops-team" />
        </operaton:executionListener>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

  function everyTypeSnapshot(process: ModdleElement): unknown {
    const [start, review, compute, notify] = elementsOf(process);

    const [io, listener, failedJob] = extensionValues(review);
    const param = (io.get('inputParameters') as ModdleElement[])[0];
    const list = (param.get('definitions') as ModdleElement[])[0];
    const map = (list.get('items') as ModdleElement[])[0];
    const entry = (map.get('entries') as ModdleElement[])[0];
    const nestedList = (entry.get('definitions') as ModdleElement[])[0];
    const script = listener.get('script') as ModdleElement;
    const field = (listener.get('fields') as ModdleElement[])[0];

    const [execListener] = extensionValues(notify);
    const execField = (execListener.get('fields') as ModdleElement[])[0];

    return {
      versionTag: process.get('versionTag'),
      candidateStarterUsers: process.get('candidateStarterUsers'),
      candidateStarterGroups: process.get('candidateStarterGroups'),
      start: {
        initiator: start.get('initiator'),
      },
      review: {
        assignee: review.get('assignee'),
        candidateUsers: review.get('candidateUsers'),
        candidateGroups: review.get('candidateGroups'),
        dueDate: review.get('dueDate'),
        followUpDate: review.get('followUpDate'),
        priority: review.get('priority'),
      },
      nestedListValues: (nestedList.get('items') as ModdleElement[]).map((v) =>
        v.get('value'),
      ),
      entryKey: entry.get('key'),
      listener: {
        id: listener.get('id'),
        event: listener.get('event'),
        class: listener.get('class'),
        script: {
          scriptFormat: script.get('scriptFormat'),
          resource: script.get('resource'),
          value: script.get('value'),
        },
        field: {
          name: field.get('name'),
          stringValue: field.get('stringValue'),
          expression: field.get('expression'),
        },
      },
      failedJobRetryTimeCycleBody: failedJob.get('body'),
      compute: {
        resultVariable: compute.get('resultVariable'),
        exclusive: compute.get('exclusive'),
        jobPriority: compute.get('jobPriority'),
      },
      execListener: {
        event: execListener.get('event'),
        delegateExpression: execListener.get('delegateExpression'),
        fieldName: execField.get('name'),
        fieldStringValue: execField.get('stringValue'),
      },
    };
  }

  const EVERY_TYPE_EXPECTED = {
    versionTag: '1.2.3',
    candidateStarterUsers: 'demo,manager',
    candidateStarterGroups: 'adjusters',
    start: {
      initiator: 'claimant',
    },
    review: {
      assignee: 'alice',
      candidateUsers: 'bob,carol',
      candidateGroups: 'approvers',
      dueDate: 'P1D',
      followUpDate: 'P2D',
      priority: '50',
    },
    nestedListValues: ['x', 'y'],
    entryKey: 'nested',
    listener: {
      id: 'listener1',
      event: 'create',
      class: 'com.example.Listener',
      script: {
        scriptFormat: 'groovy',
        resource: 'deployment:my.groovy',
        value: "println 'hi'",
      },
      field: {
        name: 'config',
        stringValue: 'value1',
        expression: '${someExpr}',
      },
    },
    failedJobRetryTimeCycleBody: 'R3/PT10M',
    compute: {
      resultVariable: 'computed',
      exclusive: false,
      jobPriority: '30',
    },
    execListener: {
      event: 'end',
      delegateExpression: '${notifyListener}',
      fieldName: 'target',
      fieldStringValue: 'ops-team',
    },
  };

  const LIST_AND_MAP_FIXTURE = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:serviceTask id="T">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="config"><operaton:list/><operaton:map/></operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

  const ENTRY_FIXTURE = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:serviceTask id="T">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="inList"><operaton:list><operaton:entry key="a">1</operaton:entry></operaton:list></operaton:inputParameter>
          <operaton:inputParameter name="bare"><operaton:entry key="b">2</operaton:entry></operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

  const TEXT_AND_SCRIPT_FIXTURE = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:serviceTask id="T">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="config">text<operaton:script scriptFormat="groovy">1+1</operaton:script></operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

  const FORM_FIELD_FIXTURE = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:userTask id="T">
      <bpmn:extensionElements>
        <operaton:formData>
          <operaton:formField id="plan" label="Plan" type="enum" defaultValue="silver"
                              datePattern="dd/MM/yyyy">
            <operaton:properties>
              <operaton:property id="hint" name="Hint" value="pick one" />
            </operaton:properties>
            <operaton:validation>
              <operaton:constraint name="required" />
              <operaton:constraint name="validator" config="com.example.PlanValidator" />
            </operaton:validation>
            <operaton:value id="silver" name="Silver" />
            <operaton:value id="gold" name="Gold" />
          </operaton:formField>
        </operaton:formData>
      </bpmn:extensionElements>
    </bpmn:userTask>
  </bpmn:process>
</bpmn:definitions>`;

  function formFieldSnapshot(process: ModdleElement): unknown {
    const [formData] = extensionValues(elementsOf(process)[0]);
    const [field] = formData.get('fields') as ModdleElement[];
    const properties = field.get('properties') as ModdleElement;
    const [property] = properties.get('values') as ModdleElement[];
    const validation = field.get('validation') as ModdleElement;
    const constraints = validation.get('constraints') as ModdleElement[];
    const values = field.get('values') as ModdleElement[];

    return {
      datePattern: field.get('datePattern'),
      property: {
        id: property.get('id'),
        name: property.get('name'),
        value: property.get('value'),
      },
      constraints: constraints.map((c) => ({
        name: c.get('name'),
        config: c.get('config'),
      })),
      values: values.map((v) => ({ id: v.get('id'), name: v.get('name') })),
    };
  }

  const EXTERNAL_TASK_FIXTURE = `${XML_HEADER}
  <bpmn:error id="Error_1" errorCode="DECLINED" />
  <bpmn:process id="P">
    <bpmn:serviceTask id="T" operaton:type="external" operaton:topic="t" operaton:taskPriority="42">
      <bpmn:extensionElements>
        <operaton:properties>
          <operaton:property name="k" value="v" />
        </operaton:properties>
        <operaton:errorEventDefinition id="Def_1" errorRef="Error_1" expression="\${x}" operaton:errorCodeVariable="c" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

  function externalTaskSnapshot(process: ModdleElement): unknown {
    const task = elementsOf(process)[0];
    const [propertiesEl, definitionEl] = extensionValues(task);
    const property = (propertiesEl.get('values') as ModdleElement[])[0];
    const errorRoot = definitionEl.get('errorRef') as ModdleElement;

    return {
      taskPriority: task.get('taskPriority'),
      property: { name: property.get('name'), value: property.get('value') },
      definitionType: definitionEl.$type,
      expression: definitionEl.get('expression'),
      errorCodeVariable: definitionEl.get('errorCodeVariable'),
      errorRoot: {
        type: errorRoot.$type,
        errorCode: errorRoot.get('errorCode'),
      },
    };
  }

  const LOOP_SETTINGS_FIXTURE = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:serviceTask id="T" operaton:class="com.example.Delegate">
      <bpmn:multiInstanceLoopCharacteristics operaton:asyncBefore="true" operaton:asyncAfter="true" operaton:exclusive="false">
        <bpmn:extensionElements>
          <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>
        </bpmn:extensionElements>
        <bpmn:loopCardinality>3</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

  const TIMEOUT_LISTENER_FIXTURE = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:userTask id="T">
      <bpmn:extensionElements>
        <operaton:taskListener event="timeout" class="com.example.L">
          <bpmn:timerEventDefinition>
            <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </operaton:taskListener>
      </bpmn:extensionElements>
    </bpmn:userTask>
  </bpmn:process>
</bpmn:definitions>`;

  it.each([
    [
      'every declared type, nested values included',
      EVERY_TYPE_FIXTURE,
      everyTypeSnapshot,
      EVERY_TYPE_EXPECTED,
    ],
    [
      'InputOutputParameterDefinition is isMany: a parameter carrying a list and a map keeps both, in document order',
      LIST_AND_MAP_FIXTURE,
      (process: ModdleElement) =>
        definitionsOf(inputParameters(process)[0]).map((d) => d.$type),
      ['operaton:List', 'operaton:Map'],
    ],
    [
      // Refusing an entry outside a map is the importer's job, so the descriptor keeps it visible.
      'operaton:entry is accepted inside a list and directly under an input parameter',
      ENTRY_FIXTURE,
      (process: ModdleElement) => {
        const [inList, bare] = inputParameters(process);
        const listed = (
          definitionsOf(inList)[0].get('items') as ModdleElement[]
        )[0];
        const direct = definitionsOf(bare)[0];
        return [
          [listed.$type, listed.get('key')],
          [direct.$type, direct.get('key')],
        ];
      },
      [
        ['operaton:Entry', 'a'],
        ['operaton:Entry', 'b'],
      ],
    ],
    [
      'a parameter carrying body text beside a nested definition keeps both, so a reader must check both forms',
      TEXT_AND_SCRIPT_FIXTURE,
      (process: ModdleElement) => {
        const [param] = inputParameters(process);
        return {
          value: param.get('value'),
          definitions: definitionsOf(param).map((d) => d.$type),
        };
      },
      { value: 'text', definitions: ['operaton:Script'] },
    ],
    [
      'a full formField declares datePattern, properties, validation and values',
      FORM_FIELD_FIXTURE,
      formFieldSnapshot,
      {
        datePattern: 'dd/MM/yyyy',
        property: { id: 'hint', name: 'Hint', value: 'pick one' },
        constraints: [
          { name: 'required', config: undefined },
          { name: 'validator', config: 'com.example.PlanValidator' },
        ],
        values: [
          { id: 'silver', name: 'Silver' },
          { id: 'gold', name: 'Gold' },
        ],
      },
    ],
    [
      'operaton:ErrorEventDefinition is a concrete type, distinct from the ErrorEventDefinitionExtension trait, so errorRef resolves to the coded root',
      EXTERNAL_TASK_FIXTURE,
      externalTaskSnapshot,
      {
        taskPriority: '42',
        property: { name: 'k', value: 'v' },
        definitionType: 'operaton:ErrorEventDefinition',
        expression: '${x}',
        errorCodeVariable: 'c',
        errorRoot: { type: 'bpmn:Error', errorCode: 'DECLINED' },
      },
    ],
    [
      'AsyncCapable extends the multi-instance element, so a repetition carries per-run job settings and its retry child',
      LOOP_SETTINGS_FIXTURE,
      (process: ModdleElement) => {
        const loop = elementsOf(process)[0].get(
          'loopCharacteristics',
        ) as ModdleElement;
        const [retryCycle] = extensionValues(loop);
        return {
          asyncBefore: loop.get('asyncBefore'),
          asyncAfter: loop.get('asyncAfter'),
          exclusive: loop.get('exclusive'),
          retryCycle: retryCycle.get('body'),
        };
      },
      {
        asyncBefore: true,
        asyncAfter: true,
        exclusive: false,
        retryCycle: 'R3/PT10M',
      },
    ],
    [
      'a timeout task listener parses its bpmn:timerEventDefinition child into eventDefinitions',
      TIMEOUT_LISTENER_FIXTURE,
      (process: ModdleElement) => {
        const [listener] = extensionValues(elementsOf(process)[0]);
        const [definition] = listener.get(
          'eventDefinitions',
        ) as ModdleElement[];
        return {
          type: definition.$type,
          timeDuration: (definition.get('timeDuration') as ModdleElement).body,
        };
      },
      { type: 'bpmn:TimerEventDefinition', timeDuration: 'PT1H' },
    ],
  ])('%s', async (_title, fixture, snapshot, expected) => {
    const first = operatonModdle();
    const { definitions, process, warnings } = await parseProcess(
      first,
      fixture,
    );
    expect(warnings).toHaveLength(0);
    expect(snapshot(process)).toEqual(expected);

    const { xml } = await first.toXML(definitions, { format: false });
    const second = operatonModdle();
    const {
      definitions: reparsedDefs,
      process: reparsed,
      warnings: warnings2,
    } = await parseProcess(second, xml);
    expect(warnings2).toHaveLength(0);
    expect(snapshot(reparsed)).toEqual(expected);

    const { xml: xml2 } = await second.toXML(reparsedDefs, { format: false });
    expect(xml2).toBe(xml);
  });
});

describe('per-element attribution of a dropped extension child', () => {
  it('a declared child materializes, an undeclared one produces exactly one warning naming it', async () => {
    const fixture = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:serviceTask id="T">
      <bpmn:extensionElements>
        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>
        <operaton:formProperty />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

    const { process, warnings } = await parseProcess(operatonModdle(), fixture);

    expect(extensionValues(elementsOf(process)[0]).map((v) => v.$type)).toEqual(
      ['operaton:FailedJobRetryTimeCycle'],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('operaton:formProperty');
  });
});

describe('a potential starter declares the formal expression BpmnParse.parseStartAuthorization reads off it', () => {
  it('parses the resourceAssignmentExpression as a typed bpmn child and writes it back', async () => {
    const fixture = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:extensionElements>
      <operaton:potentialStarter>
        <bpmn:resourceAssignmentExpression>
          <bpmn:formalExpression>user(a), group(g)</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>
      </operaton:potentialStarter>
    </bpmn:extensionElements>
  </bpmn:process>
</bpmn:definitions>`;

    const moddle = operatonModdle();
    const { definitions, process, warnings } = await parseProcess(
      moddle,
      fixture,
    );
    expect(warnings).toHaveLength(0);

    const [starter] = extensionValues(process);
    const rae = starter.get('resourceAssignmentExpression') as ModdleElement;
    expect([
      starter.$type,
      rae.$type,
      rae.get('expression').get('body'),
    ]).toEqual([
      'operaton:PotentialStarter',
      'bpmn:ResourceAssignmentExpression',
      'user(a), group(g)',
    ]);

    // The engine finds formalExpression by tag, not through this xsi:type, so the import respells the starter.
    const { xml } = await moddle.toXML(definitions, { format: false });
    expect(xml).toContain(
      '<operaton:potentialStarter><bpmn:resourceAssignmentExpression>' +
        '<bpmn:expression xsi:type="bpmn:tFormalExpression">user(a), group(g)' +
        '</bpmn:expression>',
    );
  });
});

describe('AsyncCapable defaults are omitted on write', () => {
  it('serializes only the settings written away from their engine default', async () => {
    const moddle = operatonModdle();
    const atDefault = await moddle.toXML(
      moddle.create('bpmn:ServiceTask', {
        id: 'Task1',
        'operaton:exclusive': true,
        'operaton:asyncBefore': false,
      }),
    );
    expect(atDefault.xml).not.toContain('operaton:exclusive');
    expect(atDefault.xml).not.toContain('operaton:asyncBefore');

    const offDefault = await moddle.toXML(
      moddle.create('bpmn:ServiceTask', {
        id: 'Task2',
        'operaton:exclusive': false,
        'operaton:jobPriority': '30',
      }),
    );
    expect(offDefault.xml).toContain('operaton:exclusive="false"');
    expect(offDefault.xml).toContain('operaton:jobPriority="30"');
  });
});

describe('a timer definition declares the lock BpmnParse.parseTimer reads off it', () => {
  it('parses operaton:exclusive on bpmn:timerEventDefinition as a typed boolean and writes it back off its default only', async () => {
    const fixture = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:startEvent id="S">
      <bpmn:timerEventDefinition operaton:exclusive="false">
        <bpmn:timeCycle>R/PT1H</bpmn:timeCycle>
      </bpmn:timerEventDefinition>
    </bpmn:startEvent>
    <bpmn:intermediateCatchEvent id="C">
      <bpmn:timerEventDefinition operaton:exclusive="true">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
  </bpmn:process>
</bpmn:definitions>`;

    const moddle = operatonModdle();
    const { definitions, process, warnings } = await parseProcess(
      moddle,
      fixture,
    );
    expect(warnings).toHaveLength(0);

    const [start, wait] = elementsOf(process);
    const definitionOf = (el: ModdleElement): ModdleElement =>
      (el.get('eventDefinitions') as ModdleElement[])[0];
    expect([
      definitionOf(start).get('exclusive'),
      definitionOf(wait).get('exclusive'),
    ]).toEqual([false, true]);

    const { xml } = await moddle.toXML(definitions, { format: false });
    expect(xml).toContain(
      '<bpmn:timerEventDefinition operaton:exclusive="false">',
    );
    expect(xml).toContain('<bpmn:timerEventDefinition><bpmn:timeDuration>PT1H');
  });
});
