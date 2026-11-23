import { describe, expect, test } from 'vitest';
import { compileView, exportName, importView } from '../src/outcome';

const d = (line: number) => ({
  line,
  character: 0,
  endLine: line,
  endCharacter: 1,
  message: 'm',
  severity: 1 as const,
  text: 't',
});

describe('compile and import outcomes', () => {
  test('a compile result counts errors only and names the first error line, 1-based', () => {
    expect(
      compileView({ ok: false, kind: 'validation', diagnostics: [d(4), d(9)] }),
    ).toMatchObject({ state: 'error', errors: 2, firstErrorLine: 5 });
    expect(
      compileView({
        ok: false,
        kind: 'validation',
        diagnostics: [{ ...d(1), severity: 2 }, d(6)],
      }),
    ).toMatchObject({ errors: 1, firstErrorLine: 7 });
    expect(
      compileView({ ok: true, output: '<x/>', layoutWarning: 'w' }),
    ).toMatchObject({
      state: 'ok',
      xml: '<x/>',
      layoutWarning: 'w',
      errors: 0,
    });
    expect(
      compileView({ ok: false, kind: 'error', message: 'boom' }),
    ).toMatchObject({ state: 'error', message: 'boom' });
  });

  test('an import splits each message into its headline and its note and help lines', () => {
    const w = {
      elementId: 'a',
      category: 'c',
      message: 'head\nnote: n1\nhelp: h1',
    };
    expect(
      importView({ ok: true, output: 's', warnings: [w], buildErrors: [] }),
    ).toEqual({
      kind: 'warning',
      source: 's',
      warnings: [{ headline: 'head', notes: ['note: n1', 'help: h1'] }],
    });
    expect(
      importView({ ok: true, output: 's', warnings: [], buildErrors: [] }),
    ).toMatchObject({ kind: 'ok', source: 's' });
    expect(
      importView({ ok: false, kind: 'unsupported', message: 'no\nnote: why' }),
    ).toMatchObject({
      kind: 'refused',
      message: { headline: 'no', notes: ['note: why'] },
    });
    expect(importView({ ok: false, kind: 'error', message: 'e' }).kind).toBe(
      'refused',
    );
  });

  test('an export is named after the process id, skipping comments', () => {
    expect(exportName('process loan-approval(\n', '.bpmnscript')).toBe(
      'loan-approval.bpmnscript',
    );
    expect(exportName('<bpmn:process id="p-1_x">', '.bpmn')).toBe('p-1_x.bpmn');
    expect(
      exportName('// process fake {\nprocess real(\n', '.bpmnscript'),
    ).toBe('real.bpmnscript');
    expect(
      exportName('<!-- process x -->\n<bpmn:process id="p">', '.bpmn'),
    ).toBe('p.bpmn');
    expect(exportName('nothing', '.bpmn')).toBe('process.bpmn');
    expect(exportName('process a/b {', '.bpmn')).toBe('a_b.bpmn');
  });
});
