// Every `bpmnscript` fence in any Markdown file must parse, validate and compile.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { astToIr, irToXml } from '@bpmn-script/transform';

import { parse, validate } from './helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROOT = resolve(__dirname, '..');

const UNVISITED = new Set(['node_modules', 'out', '.git', '.claude', 'target']);

// The opening run is back-referenced so a ``` inside a ```` block does not
// close it.
const FENCE = /^(`{3,})bpmnscript[ \t]*\r?\n([\s\S]*?)^\1`*[ \t]*$/gm;

interface Sample {
  where: string; // file:line
  source: string;
}

function markdownUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return UNVISITED.has(entry.name)
        ? []
        : markdownUnder(resolve(dir, entry.name));
    }
    return entry.name.endsWith('.md') ? [resolve(dir, entry.name)] : [];
  });
}

function samplesIn(file: string): Sample[] {
  const text = readFileSync(file, 'utf-8');
  return [...text.matchAll(FENCE)].map((match) => ({
    where: `${relative(ROOT, file)}:${text.slice(0, match.index).split('\n').length}`,
    source: match[2]!,
  }));
}

const SAMPLES = markdownUnder(ROOT).sort().flatMap(samplesIn);

// A directory-driven sweep that finds nothing would pass by asserting nothing.
if (SAMPLES.length === 0) {
  throw new Error(`no fenced bpmnscript samples found under ${ROOT}`);
}

describe('every bpmnscript sample published in the documentation', () => {
  it.each(SAMPLES.map((sample) => [sample.where, sample.source]))(
    '%s parses, validates and compiles',
    async (_where, source) => {
      const document = await parse(source);
      // A Chevrotain error carries its whole token table, which would bury
      // the sentence naming the slot.
      expect(document.parseResult.parserErrors.map((e) => e.message)).toEqual(
        [],
      );

      const { diagnostics } = await validate(source);
      expect(diagnostics).toEqual([]);

      expect(await irToXml(astToIr(document.parseResult.value))).toContain(
        '<bpmn:process',
      );
    },
  );
});
