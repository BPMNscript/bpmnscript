/**
 * `bpmn-auto-layout` is mocked here rather than provoking its real crash
 * (`packages/extension/test/conversion-core.test.ts` does that with a
 * validator-clean `goto` graph): this file only needs
 * `irToXml` to see some throw and wrap it, not the library's own defect.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('bpmn-auto-layout', () => ({
  layoutProcess: vi.fn(() => {
    throw new TypeError('Cannot set properties of undefined');
  }),
}));

import { irToXml } from '../src/ir-to-xml.js';
import { LayoutError } from '../src/errors.js';
import { chainedSub, minimalProcess } from './helpers/ir-fixtures.js';

describe('irToXml: layoutProcess guard', () => {
  it('wraps a layoutProcess throw in LayoutError carrying the DI-less document', async () => {
    const err = await irToXml(
      minimalProcess([{ kind: 'task', id: 'X' }]),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LayoutError);
    const layoutError = err as LayoutError;
    expect(layoutError.message).toContain('Cannot set properties of undefined');
    expect(layoutError.xml).toContain('<bpmn:process');
    expect(layoutError.xml).not.toContain('bpmndi:');
  });

  // Revert: fall back to the pre-layout `xml`, which still carries the
  // sub-process expansion hint for a process holding one, and this goes red.
  it('drops the diagram entirely for a process holding a sub-process', async () => {
    const err = await irToXml(
      minimalProcess([
        { kind: 'task', id: 'X' },
        chainedSub('Sub', [{ kind: 'task', id: 'Sub_X' }]),
      ]),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LayoutError);
    expect((err as LayoutError).xml).not.toContain('bpmndi:');
    expect((err as LayoutError).xml).toContain('<bpmn:subProcess');
  });
});
