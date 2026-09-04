import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  diagnosticMessage,
  resolveOutputPath,
  CLI_VERSION,
} from '../src/util.js';

describe('resolveOutputPath', () => {
  it.each([
    // No override: the default extension replaces the input's own.
    [
      '/work/invoice-approval.bpmnscript',
      undefined,
      '/work/invoice-approval.bpmn',
    ],
    // Only the final extension goes, so a dotted basename survives.
    ['/work/my.invoice.bpmnscript', undefined, '/work/my.invoice.bpmn'],
    // An override is taken verbatim, resolved from cwd.
    ['/work/invoice-approval.bpmnscript', 'out/custom.bpmn', 'out/custom.bpmn'],
  ] as const)('%s + %s -> %s', (input, override, expected) => {
    expect(resolveOutputPath(path.resolve(input), '.bpmn', override)).toBe(
      path.resolve(expected),
    );
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

describe('CLI_VERSION', () => {
  it('is a non-empty string read from package.json', () => {
    expect(typeof CLI_VERSION).toBe('string');
    expect(CLI_VERSION.length).toBeGreaterThan(0);
  });
});
