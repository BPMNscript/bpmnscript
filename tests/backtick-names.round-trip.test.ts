// An engine id the plain name cannot spell imports, prints in backticks and
// compiles back to the same id; the engine keys history, migration and
// start-before-activity on it, so a renamed id would not be the same process.

import { describe, it, expect } from 'vitest';

import { astToIr, irToDsl, irToXml, xmlToIr } from '@bpmn-script/transform';
import type { BpmnProcess, FlowContainer } from '@bpmn-script/transform';

import { compareModels } from './helpers/model-equivalence.js';
import { parseToAst, validate } from './helpers/pipeline.js';

interface Ids {
  process: string;
  start: string;
  task: string;
  end: string;
}

const PLAIN: Ids = { process: 'P', start: 'S', task: 'T', end: 'E' };

/**
 * The timer loops back to its host, so `task` is an attach and a goto target
 * too. The boundary carries the id the compiler derives from its host, since a
 * handler has no name to keep its own.
 */
function document(ids: Ids): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
    'xmlns:operaton="http://operaton.org/schema/1.0/bpmn" targetNamespace="http://test">\n' +
    `  <bpmn:process id="${ids.process}" isExecutable="true" operaton:historyTimeToLive="P30D">\n` +
    `    <bpmn:startEvent id="${ids.start}" />\n` +
    `    <bpmn:userTask id="${ids.task}" operaton:assignee="demo" />\n` +
    `    <bpmn:boundaryEvent id="Boundary_${ids.task}_timer" attachedToRef="${ids.task}">\n` +
    '      <bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition>\n' +
    '    </bpmn:boundaryEvent>\n' +
    `    <bpmn:endEvent id="${ids.end}" />\n` +
    `    <bpmn:sequenceFlow id="f1" sourceRef="${ids.start}" targetRef="${ids.task}" />\n` +
    `    <bpmn:sequenceFlow id="f2" sourceRef="${ids.task}" targetRef="${ids.end}" />\n` +
    `    <bpmn:sequenceFlow id="f3" sourceRef="Boundary_${ids.task}_timer" targetRef="${ids.task}" />\n` +
    '  </bpmn:process>\n' +
    '</bpmn:definitions>'
  );
}

function script(names: Ids): string {
  return (
    `process ${names.process} {\n` +
    `  start ${names.start}\n` +
    `  user ${names.task}(assignee: "demo")\n` +
    `  end ${names.end}\n` +
    `  on ${names.task}: timer("PT1H") {\n` +
    `    goto ${names.task}\n` +
    '  }\n' +
    '}\n'
  );
}

function flowNodeIds(container: FlowContainer): string[] {
  return container.flowElements.flatMap((el) => [
    el.id,
    ...('flowElements' in el ? flowNodeIds(el) : []),
  ]);
}

async function compiled(source: string): Promise<BpmnProcess> {
  const xml = await irToXml(astToIr(await parseToAst(source)));
  return (await xmlToIr(xml)).ir;
}

describe('an id the plain form cannot spell round-trips in backticks', () => {
  it.each<[title: string, ids: Partial<Ids>, printed: Partial<Ids>]>([
    ['a plain id prints plain', {}, {}],
    ['a keyword process id', { process: 'process' }, { process: '`process`' }],
    ['a keyword start id', { start: 'start' }, { start: '`start`' }],
    ['a keyword end id', { end: 'end' }, { end: '`end`' }],
    ['a keyword task id', { task: 'var' }, { task: '`var`' }],
    ['a dotted task id', { task: 'Task.1' }, { task: '`Task.1`' }],
    ['a trailing hyphen', { task: 'Review-' }, { task: '`Review-`' }],
    ['a doubled hyphen', { task: 'a--b' }, { task: '`a--b`' }],
    ['a hyphen before a dot', { task: '_x-.y' }, { task: '`_x-.y`' }],
  ])('%s', async (_title, ids, printed) => {
    const imported = await xmlToIr(document({ ...PLAIN, ...ids }));
    expect(imported.warnings).toEqual([]);

    const { source, warnings } = irToDsl(imported.ir);
    expect(warnings).toEqual([]);
    expect(source).toBe(script({ ...PLAIN, ...printed }));
    expect((await validate(source)).diagnostics).toEqual([]);

    const rebuilt = await compiled(source);
    expect([rebuilt.id, ...flowNodeIds(rebuilt).sort()]).toEqual([
      imported.ir.id,
      ...flowNodeIds(imported.ir).sort(),
    ]);
    expect(compareModels(imported.ir, rebuilt).differences).toEqual([]);
  });

  it('an error name with a space is kept as the declared name', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
      'xmlns:operaton="http://operaton.org/schema/1.0/bpmn" targetNamespace="http://test">\n' +
      '  <bpmn:error id="Error_1" name="Payment failed" errorCode="PF" />\n' +
      '  <bpmn:process id="P" isExecutable="true" operaton:historyTimeToLive="P30D">\n' +
      '    <bpmn:startEvent id="S" />\n' +
      '    <bpmn:endEvent id="E"><bpmn:errorEventDefinition errorRef="Error_1" /></bpmn:endEvent>\n' +
      '    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="E" />\n' +
      '  </bpmn:process>\n' +
      '</bpmn:definitions>';
    const imported = await xmlToIr(xml);
    const { source, warnings } = irToDsl(imported.ir);
    expect([imported.warnings, warnings]).toEqual([[], []]);
    expect(source).toBe(
      'process P {\n' +
        '  error `Payment failed`(code: "PF")\n' +
        '  start S\n' +
        '  throw error E(`Payment failed`)\n' +
        '}\n',
    );
    expect((await validate(source)).diagnostics).toEqual([]);
    expect((await compiled(source)).errorDecls).toEqual(imported.ir.errorDecls);
  });

  it('an id with a colon is refused on import, since Operaton refuses it', async () => {
    await expect(
      xmlToIr(document({ ...PLAIN, task: 'ns:Task' })),
    ).rejects.toThrow("the id 'ns:Task' is not an id Operaton deploys");
  });
});
