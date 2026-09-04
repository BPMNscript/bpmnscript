import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  diagnosticMessage,
  resolveOutputPath,
  CLI_VERSION,
} from '../src/util.js';

describe('resolveOutputPath', () => {
  it('derives the output path by swapping the extension when no override is given', () => {
    const input = path.resolve('/work/invoice-approval.bpmnscript');
    expect(resolveOutputPath(input, '.bpmn')).toBe(
      path.resolve('/work/invoice-approval.bpmn'),
    );
  });

  it('replaces only the final extension on dotted basenames', () => {
    const input = path.resolve('/work/my.invoice.bpmnscript');
    expect(resolveOutputPath(input, '.bpmn')).toBe(
      path.resolve('/work/my.invoice.bpmn'),
    );
  });

  it('uses the override path verbatim (resolved from cwd) when provided', () => {
    const input = path.resolve('/work/invoice-approval.bpmnscript');
    expect(resolveOutputPath(input, '.bpmn', 'out/custom.bpmn')).toBe(
      path.resolve('out/custom.bpmn'),
    );
  });
});

describe('diagnosticMessage', () => {
  const RANGE = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 4 },
  };

  it('reads a plain-text message as it stands', () => {
    expect(diagnosticMessage({ range: RANGE, message: 'no such step' })).toBe(
      'no such step',
    );
  });

  it('reads a markup message as its text, not as an object', () => {
    expect(
      diagnosticMessage({
        range: RANGE,
        message: { kind: 'markdown', value: 'no such step' },
      }),
    ).toBe('no such step');
  });
});

describe('CLI_VERSION', () => {
  it('is a non-empty string read from package.json', () => {
    expect(typeof CLI_VERSION).toBe('string');
    expect(CLI_VERSION.length).toBeGreaterThan(0);
  });
});
