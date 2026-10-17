// Its own file because `vi.mock` applies to the whole file.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@bpmn-script/transform', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@bpmn-script/transform')>();
  return {
    ...actual,
    xmlToIr: vi.fn(actual.xmlToIr),
    irToXml: vi.fn(() => {
      throw new Error('boom in irToXml');
    }),
    irToDsl: vi.fn(() => {
      throw new Error('boom in irToDsl');
    }),
  };
});

import { xmlToIr } from '@bpmn-script/transform';
import { runBuild, runParse } from './helpers/actions.js';

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

describe('an exception inside a transform', () => {
  it.each([
    [
      'build exits 3 and writes nothing',
      () => runBuild({ text: 'process p { start S end E }' }),
      'boom in irToXml',
    ],
    [
      'parse exits 3 and writes nothing',
      () => runParse({ text: BPMN }),
      'boom in irToDsl',
    ],
    [
      'parse exits 3 on an exception inside the importer',
      () => {
        vi.mocked(xmlToIr).mockRejectedValueOnce(new Error('boom in xmlToIr'));
        return runParse({ text: BPMN });
      },
      'boom in xmlToIr',
    ],
  ])('%s', async (_title, go, boom) => {
    const run = await go();

    expect(run.exit).toBe(3);
    expect(run.stderr).toEqual([
      `Error: internal error (a bug in bpmns): ${boom}`,
    ]);
    expect(run.output).toBeUndefined();
  });
});
