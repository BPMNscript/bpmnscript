import { describe, it, expect, vi } from 'vitest';

// Mocked rather than provoking the library's real crash: this file only needs
// `irToXml` to see some throw and wrap it.
vi.mock('bpmn-auto-layout', () => ({
  layoutProcess: vi.fn(() => {
    throw new TypeError('Cannot set properties of undefined');
  }),
}));

import { irToXml } from '../src/ir-to-xml.js';
import { LayoutError } from '../src/errors.js';
import { chainedSub, minimalProcess } from './helpers/ir-fixtures.js';

describe('irToXml: layoutProcess guard', () => {
  // The pre-layout document of a process holding a sub-process carries the
  // bounds-less expansion hint, which must not survive into the fallback.
  it('wraps a layoutProcess throw in LayoutError carrying the document without its diagram', async () => {
    const err = await irToXml(
      minimalProcess([chainedSub('Sub', [{ kind: 'task', id: 'Sub_X' }])]),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LayoutError);
    const { message, xml } = err as LayoutError;
    expect(message).toContain('Cannot set properties of undefined');
    expect(xml).toContain('<bpmn:subProcess');
    expect(xml).not.toContain('bpmndi:');
  });
});
