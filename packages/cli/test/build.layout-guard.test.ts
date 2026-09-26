/**
 * `bpmn-auto-layout` is mocked here rather than provoking its real crash
 * (`ir-to-xml.layout-guard.test.ts` in `packages/transform` does that): this
 * file only needs `bpmns build`'s `LayoutError` fallback exercised end to
 * end, not the library's own defect.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('bpmn-auto-layout', () => ({
  layoutProcess: vi.fn(() => {
    throw new TypeError('Cannot set properties of undefined');
  }),
}));

import { runBuild } from './helpers/actions.js';

describe('bpmns build: layoutProcess guard', () => {
  it('falls back to writing the DI-less document with a warning instead of failing the build', async () => {
    const run = await runBuild({ text: 'process guard { start S end E }' });

    expect(run.exit).toBeUndefined();
    expect(run.stderr).toEqual([
      'Warning: no diagram could be drawn for this process (bpmn-auto-layout ' +
        'failed to lay out the process: Cannot set properties of undefined); ' +
        'the file deploys but opens without shapes in a modeler',
    ]);
    expect(run.output).toBeDefined();
    expect(run.output).not.toContain('bpmndi:');
  });
});
