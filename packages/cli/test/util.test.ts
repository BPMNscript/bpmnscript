import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { diagnosticMessage, resolveOutputPath } from '../src/util.js';

describe('resolveOutputPath', () => {
  it.each([
    [
      'no override: the default extension replaces the input extension',
      '/work/invoice-approval.bpmnscript',
      undefined,
      '/work/invoice-approval.bpmn',
    ],
    [
      'only the final extension goes, so a dotted basename survives',
      '/work/my.invoice.bpmnscript',
      undefined,
      '/work/my.invoice.bpmn',
    ],
    [
      'an override is taken verbatim, resolved from cwd',
      '/work/invoice-approval.bpmnscript',
      'out/custom.bpmn',
      'out/custom.bpmn',
    ],
  ] as const)('%s', (_title, input, override, expected) => {
    expect(resolveOutputPath(path.resolve(input), '.bpmn', override)).toBe(
      path.resolve(expected),
    );
  });

  it('an override naming an existing directory writes inside it under the input basename', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmns-util-'));
    try {
      const input = path.join(dir, 'invoice-approval.bpmnscript');
      expect(resolveOutputPath(input, '.bpmn', dir)).toBe(
        path.join(dir, 'invoice-approval.bpmn'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('diagnosticMessage', () => {
  const RANGE = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 4 },
  };

  it.each([
    ['plain text', 'no such step'],
    ['markup', { kind: 'markdown', value: 'no such step' }],
  ] as const)('reads a %s message as its text', (_kind, message) => {
    expect(diagnosticMessage({ range: RANGE, message })).toBe('no such step');
  });
});
