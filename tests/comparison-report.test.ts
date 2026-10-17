import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  HISTORY_TIME_TO_LIVE,
  xmlToIr,
  type BpmnProcess,
} from '@bpmn-script/transform';

import { bpmnDoc } from './helpers/bpmn-doc.js';
import {
  compareModels,
  type ModelReport,
} from './helpers/model-equivalence.js';
import { printDsl, roundTrip } from './helpers/pipeline.js';

type Pair = [BpmnProcess, BpmnProcess];

const flow = (id: string, from: string, to: string) =>
  `    <bpmn:sequenceFlow id="${id}" sourceRef="${from}" targetRef="${to}" />\n`;

// Elements are listed in the order the compiler emits them, so only the ids differ.
// The race has no id slot in the script, so the catch ids cannot survive the printer.
const IMPORTED_RACE = bpmnDoc(
  '    <bpmn:startEvent id="StartEvent_1" />\n' +
    '    <bpmn:eventBasedGateway id="Gateway_0xyz" />\n' +
    '    <bpmn:exclusiveGateway id="Gateway_Merge" />\n' +
    '    <bpmn:intermediateCatchEvent id="Event_0abc">\n' +
    '      <bpmn:messageEventDefinition messageRef="Message_Ok" />\n' +
    '    </bpmn:intermediateCatchEvent>\n' +
    '    <bpmn:task id="Activity_Pay" name="Pay" />\n' +
    '    <bpmn:intermediateCatchEvent id="Event_1def">\n' +
    '      <bpmn:timerEventDefinition><bpmn:timeDuration>PT1H</bpmn:timeDuration></bpmn:timerEventDefinition>\n' +
    '    </bpmn:intermediateCatchEvent>\n' +
    '    <bpmn:task id="Activity_Expire" name="Expire" />\n' +
    '    <bpmn:endEvent id="Event_End" />\n' +
    flow('Flow_2', 'Gateway_0xyz', 'Event_0abc') +
    flow('Flow_4', 'Event_0abc', 'Activity_Pay') +
    flow('Flow_6', 'Activity_Pay', 'Gateway_Merge') +
    flow('Flow_3', 'Gateway_0xyz', 'Event_1def') +
    flow('Flow_5', 'Event_1def', 'Activity_Expire') +
    flow('Flow_7', 'Activity_Expire', 'Gateway_Merge') +
    flow('Flow_1', 'StartEvent_1', 'Gateway_0xyz') +
    flow('Flow_8', 'Gateway_Merge', 'Event_End'),
  '  <bpmn:message id="Message_Ok" name="Ok" />\n',
);

describe('comparison report through the real pipeline', () => {
  const header = (ttl?: string) =>
    ttl === undefined ? '' : `(historyTimeToLive: "${ttl}")`;
  const script = (ttl?: string) =>
    `process p${header(ttl)} {\n  start S\n  user T(assignee: "demo")\n  end E\n}\n`;
  const fromScript = async (ttl?: string): Promise<Pair> => {
    const run = await roundTrip(script(ttl));
    return [run.ir1, run.ir3];
  };
  const imported = async (ttl?: string) =>
    (
      await xmlToIr(
        bpmnDoc(
          '    <bpmn:startEvent id="S" />\n' +
            '    <bpmn:endEvent id="E" />\n' +
            flow('Flow_S_E', 'S', 'E'),
        ).replace(
          ` operaton:historyTimeToLive="${HISTORY_TIME_TO_LIVE}"`,
          ttl === undefined ? '' : ` operaton:historyTimeToLive="${ttl}"`,
        ),
      )
    ).ir;
  const fromXml = async (ttl?: string): Promise<Pair> => {
    const original = await imported(ttl);
    return [original, (await roundTrip(printDsl(original))).ir3];
  };
  const unchanged: ModelReport = {
    level: 'same',
    normalizations: [],
    differences: [],
  };

  it.each<[string, () => Promise<Pair>, ModelReport]>([
    [
      'XML without a history time to live gains the default, reported as the default-history-time-to-live normalization',
      () => fromXml(),
      {
        level: 'same',
        normalizations: [
          { names: ['default-history-time-to-live'], elements: ['p'] },
        ],
        differences: [],
      },
    ],
    [
      'XML with the default history time to live keeps it with nothing reported',
      () => fromXml(HISTORY_TIME_TO_LIVE),
      unchanged,
    ],
    [
      'XML with a non-default history time to live keeps it with nothing reported',
      () => fromXml('P7D'),
      unchanged,
    ],
    [
      'a script without a history time to live round-trips with nothing reported',
      () => fromScript(),
      unchanged,
    ],
    [
      'a script with the default history time to live round-trips with nothing reported',
      () => fromScript(HISTORY_TIME_TO_LIVE),
      unchanged,
    ],
    [
      'a rebuild that drops an original default history time to live is a difference',
      async () => [await imported(HISTORY_TIME_TO_LIVE), await imported()],
      {
        level: 'changed',
        normalizations: [],
        differences: [
          {
            container: 'p',
            element: 'p',
            fields: [{ path: 'historyTimeToLive', a: HISTORY_TIME_TO_LIVE }],
          },
        ],
      },
    ],
  ])('%s', async (_, pair, expected) => {
    const [a, b] = await pair();
    expect(compareModels(a, b)).toEqual(expected);
  });

  it('an imported race whose catch events carry modeler ids round-trips with zero remaining differences and names the synthesized-ids normalization', async () => {
    const { ir: imported } = await xmlToIr(IMPORTED_RACE);
    const reread = (await roundTrip(printDsl(imported))).ir3;
    expect(compareModels(imported, reread)).toEqual({
      level: 'canonical',
      normalizations: [
        {
          names: ['synthesized-ids'],
          elements: [
            'p/Catch_p_1_b0',
            'p/Catch_p_1_b1',
            'p/Event_0abc',
            'p/Event_1def',
            'p/Flow_1',
            'p/Flow_2',
            'p/Flow_3',
            'p/Flow_4',
            'p/Flow_5',
            'p/Flow_6',
            'p/Flow_7',
            'p/Flow_Activity_Expire_Gateway_p_1_join',
            'p/Flow_Activity_Pay_Gateway_p_1_join',
            'p/Flow_Catch_p_1_b0_Activity_Pay',
            'p/Flow_Catch_p_1_b1_Activity_Expire',
            'p/Flow_Gateway_p_1_race_Catch_p_1_b0',
            'p/Flow_Gateway_p_1_race_Catch_p_1_b1',
            'p/Flow_StartEvent_1_Gateway_p_1_race',
            'p/Gateway_0xyz',
            'p/Gateway_p_1_race',
          ],
        },
      ],
      differences: [],
    });
  });

  it('the helper and the generator load and run outside vitest', () => {
    const url = (file: string) =>
      pathToFileURL(
        fileURLToPath(new URL(`./helpers/${file}`, import.meta.url)),
      ).href;
    const script =
      `const { compareModels } = await import(${JSON.stringify(url('model-equivalence.ts'))});\n` +
      `const { generateProgram, renderProgram } = await import(${JSON.stringify(url('fuzz-generator.ts'))});\n` +
      `const p = { id: 'p', flowElements: [], sequenceFlows: [] };\n` +
      `console.log(JSON.stringify({ report: compareModels(p, p), generated: renderProgram(generateProgram(1)).length > 0 }));\n`;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(out)).toEqual({
      report: { level: 'same', normalizations: [], differences: [] },
      generated: true,
    });
  });
});
