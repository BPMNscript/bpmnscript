import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_PRESET, PRESETS } from '../src/presets';

const repo = join(import.meta.dirname, '../../..');

describe('presets', () => {
  test('every preset has a unique id, the default is one of them, and its extension matches its kind', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(PRESETS.some((p) => p.id === DEFAULT_PRESET)).toBe(true);
    for (const p of PRESETS)
      expect(
        p.path.endsWith(p.kind === 'source' ? '.bpmnscript' : '.bpmn'),
      ).toBe(true);
  });

  test('every preset names a file that exists in this repo', () => {
    for (const p of PRESETS)
      expect(existsSync(join(repo, p.path)), p.path).toBe(true);
  });
});
