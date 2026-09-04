/**
 * Pins the behaviour of `operaton-moddle.json` directly against a real
 * `BpmnModdle` instance, with no `xmlToIr`/`irToXml` involved. Three traps
 * this descriptor exists to close:
 *
 *   - `extensionElements` splits its children three ways: a declared type
 *     becomes a typed entry in `values`, an unregistered namespace becomes a
 *     generic value with no warning, and a registered namespace carrying an
 *     undeclared type is dropped with only a document-level warning and no
 *     back-pointer to the element that lost it. A type has to be declared
 *     here before it can be attributed to the step that carries it.
 *   - `InputParameter`/`OutputParameter`/`Entry` declare their nested value
 *     as an `isMany` `definitions` array. A single-valued property would
 *     silently keep only the last of two co-present nested values, with zero
 *     warnings and no way for a reader to detect the loss.
 *   - `default` on `exclusive`/`asyncBefore`/`asyncAfter` makes moddle omit
 *     those attributes on write when they hold the default value, matching
 *     the IR convention of storing only non-default booleans.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';

const here = dirname(fileURLToPath(import.meta.url));

/** The Operaton moddle extension descriptor under test, read from source. */
const OPERATON_EXTENSION: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(here, '../src/operaton-moddle.json'), 'utf-8'),
);

/** A raw `BpmnModdle` carrying only the Operaton extension (no `camunda-bpmn-moddle`). */
function operatonModdle(): InstanceType<typeof BpmnModdle> {
  return new BpmnModdle({ operaton: OPERATON_EXTENSION });
}

const XML_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">`;

/**
 * Parse a full document and return its single `bpmn:Process` root element,
 * alongside the `bpmn:Definitions` root that holds it. A re-serialize has to
 * start from the definitions root: `toXML` writes its own XML declaration, so
 * serializing the process alone and pasting the result under a header would put
 * a declaration in the middle of the document.
 */
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

/** The typed `extensionElements.values` of a flow node, or `[]` if none. */
function extensionValues(el: ModdleElement): ModdleElement[] {
  const extensionElements = el.get('extensionElements') as
    ModdleElement | undefined;
  return extensionElements === undefined
    ? []
    : (extensionElements.get('values') as ModdleElement[]);
}

describe('every new type parses and re-serializes with nested values intact', () => {
  const fixture = `${XML_HEADER}
  <bpmn:process id="Process_1" isExecutable="true" operaton:versionTag="1.2.3">
    <bpmn:userTask id="Review" operaton:assignee="alice" operaton:candidateUsers="bob,carol"
                   operaton:candidateGroups="reviewers" operaton:dueDate="P1D"
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

  /** Read every value this test cares about out of a parsed process tree. */
  function snapshot(process: ModdleElement): unknown {
    const review = (process.get('flowElements') as ModdleElement[]).find(
      (e) => e.id === 'Review',
    )!;
    const compute = (process.get('flowElements') as ModdleElement[]).find(
      (e) => e.id === 'Compute',
    )!;
    const notify = (process.get('flowElements') as ModdleElement[]).find(
      (e) => e.id === 'Notify',
    )!;

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

  const expected = {
    versionTag: '1.2.3',
    review: {
      assignee: 'alice',
      candidateUsers: 'bob,carol',
      candidateGroups: 'reviewers',
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

  it('parses with zero warnings and every nested value at its expected path', async () => {
    const { process, warnings } = await parseProcess(operatonModdle(), fixture);
    expect(warnings).toHaveLength(0);
    expect(snapshot(process)).toEqual(expected);
  });

  it('round-trips through toXML unchanged', async () => {
    const first = operatonModdle();
    const { definitions } = await parseProcess(first, fixture);
    const { xml } = await first.toXML(definitions, { format: false });

    const second = operatonModdle();
    const { process: reparsed, warnings } = await parseProcess(second, xml);
    expect(warnings).toHaveLength(0);
    expect(snapshot(reparsed)).toEqual(expected);
  });
});

describe('InputOutputParameterDefinition is isMany, not a single-valued definition', () => {
  it('a parameter carrying a list and a map keeps both, in document order', async () => {
    const fixture = `${XML_HEADER}
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

    const { process, warnings } = await parseProcess(operatonModdle(), fixture);
    expect(warnings).toHaveLength(0);

    const task = (process.get('flowElements') as ModdleElement[])[0];
    const [io] = extensionValues(task);
    const param = (io.get('inputParameters') as ModdleElement[])[0];
    const definitions = param.get('definitions') as ModdleElement[];

    // The trap: a single-valued `definition` property would keep only the
    // last of these two (the map), with zero warnings and no signal that
    // the list was ever there.
    expect(definitions.map((d) => d.$type)).toEqual([
      'operaton:List',
      'operaton:Map',
    ]);
  });
});

describe('operaton:entry is accepted wherever a definition is accepted', () => {
  it('parses warning-free inside a list and directly under an input parameter', async () => {
    const fixture = `${XML_HEADER}
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

    const { process, warnings } = await parseProcess(operatonModdle(), fixture);
    expect(warnings).toHaveLength(0);

    const task = (process.get('flowElements') as ModdleElement[])[0];
    const [io] = extensionValues(task);
    const [inList, bare] = io.get('inputParameters') as ModdleElement[];

    // `Entry` subclasses `InputOutputParameterDefinition`, so it satisfies both
    // `List.items` and `InputParameter.definitions`. The descriptor accepts a
    // stray entry outside a map; rejecting that shape is the importer's job,
    // and this pins that the tolerance is where the rejection can see it.
    const inListEntry = (
      (inList.get('definitions') as ModdleElement[])[0].get(
        'items',
      ) as ModdleElement[]
    )[0];
    expect([inListEntry.$type, inListEntry.get('key')]).toEqual([
      'operaton:Entry',
      'a',
    ]);

    const bareEntry = (bare.get('definitions') as ModdleElement[])[0];
    expect([bareEntry.$type, bareEntry.get('key')]).toEqual([
      'operaton:Entry',
      'b',
    ]);
  });
});

describe('a parameter carrying both body text and a nested definition keeps both', () => {
  it('yields both `value` and a `definitions` entry', async () => {
    const fixture = `${XML_HEADER}
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

    const { process, warnings } = await parseProcess(operatonModdle(), fixture);
    expect(warnings).toHaveLength(0);

    const task = (process.get('flowElements') as ModdleElement[])[0];
    const [io] = extensionValues(task);
    const param = (io.get('inputParameters') as ModdleElement[])[0];

    // A reader must check both forms rather than returning on the first hit.
    expect(param.get('value')).toBe('text');
    const definitions = param.get('definitions') as ModdleElement[];
    expect(definitions).toHaveLength(1);
    expect(definitions[0].$type).toBe('operaton:Script');
  });
});

describe('per-element attribution of a dropped extension child', () => {
  it('a declared child materialises, an undeclared one produces exactly one warning naming it', async () => {
    const fixture = `${XML_HEADER}
  <bpmn:process id="P">
    <bpmn:serviceTask id="T">
      <bpmn:extensionElements>
        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>
        <operaton:properties>
          <operaton:property name="x" value="y" />
        </operaton:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

    const { process, warnings } = await parseProcess(operatonModdle(), fixture);

    const task = (process.get('flowElements') as ModdleElement[])[0];
    const values = extensionValues(task);

    // The declared element survives as a typed value; the undeclared one is
    // dropped from `values` entirely (no back-pointer to `task`). The surviving
    // child is one this descriptor introduces, so the assertion measures the
    // declaration rather than what `bpmn-moddle` already knew.
    expect(values.map((v) => v.$type)).toEqual([
      'operaton:FailedJobRetryTimeCycle',
    ]);

    // Never infer a per-element drop from a document-level boolean: assert
    // the exact warning count and that its message names the dropped type.
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('operaton:properties');
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

describe('TaskListener timer event definition', () => {
  it('a bpmn:timerEventDefinition child parses into eventDefinitions and re-serializes', async () => {
    const fixture = `${XML_HEADER}
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

    const first = operatonModdle();
    const { process, warnings } = await parseProcess(first, fixture);
    expect(warnings).toHaveLength(0);

    const task = (process.get('flowElements') as ModdleElement[])[0];
    const [listener] = extensionValues(task);
    const eventDefinitions = listener.get(
      'eventDefinitions',
    ) as ModdleElement[];
    expect(eventDefinitions).toHaveLength(1);
    expect(eventDefinitions[0].$type).toBe('bpmn:TimerEventDefinition');
    expect(
      (eventDefinitions[0].get('timeDuration') as ModdleElement).body,
    ).toBe('PT1H');

    const { xml } = await first.toXML(process, { format: false });
    expect(xml).toContain('timerEventDefinition');
    expect(xml).toContain('PT1H');
  });
});
