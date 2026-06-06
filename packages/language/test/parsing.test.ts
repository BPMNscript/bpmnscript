/**
 * Full grammar test suite for the BpmnScript language.
 *
 * Uses Langium's `parseHelper` from `langium/test` to drive the grammar
 * in isolation.
 *
 * Test cases:
 *   1. Canonical invoice-approval source parses without errors.
 *   2. Minimal process (one start, one end, one flow) parses cleanly.
 *   3. Service task without the required `class:` attribute fails to parse.
 *   4. Gateway with `default: X` where X is not a flow id parses (the
 *      linker, not the parser, catches the dangling reference).
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { parseHelper } from 'langium/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Model } from '@bpmn-script/language';
import { createBpmnScriptServices, isModel } from '@bpmn-script/language';

const here = dirname(fileURLToPath(import.meta.url));

let services: ReturnType<typeof createBpmnScriptServices>;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(async () => {
  services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ── 1. Canonical invoice-approval source ────────────────────────────────────

describe('Parsing — canonical invoice-approval', () => {
  test('canonical invoice-approval source parses without errors', async () => {
    const dslPath = resolve(
      here,
      '../../../examples/spring-boot/processes/invoice-approval.bpmnscript',
    );
    const source = readFileSync(dslPath, 'utf-8');

    const document = await parse(source);

    expect(formatParseFailure(document)).toBeUndefined();
    expect(isModel(document.parseResult.value)).toBe(true);
  });

  test('canonical source contains exactly one process', async () => {
    const dslPath = resolve(
      here,
      '../../../examples/spring-boot/processes/invoice-approval.bpmnscript',
    );
    const source = readFileSync(dslPath, 'utf-8');
    const document = await parse(source);

    expect(document.parseResult.parserErrors).toHaveLength(0);
    expect(document.parseResult.value.processes).toHaveLength(1);
  });

  test('canonical process has id "invoice-approval"', async () => {
    const dslPath = resolve(
      here,
      '../../../examples/spring-boot/processes/invoice-approval.bpmnscript',
    );
    const source = readFileSync(dslPath, 'utf-8');
    const document = await parse(source);

    const process = document.parseResult.value.processes[0];
    expect(process).toBeDefined();
    expect(process!.name).toBe('invoice-approval');
  });

  test('canonical process has label "Invoice Approval"', async () => {
    const dslPath = resolve(
      here,
      '../../../examples/spring-boot/processes/invoice-approval.bpmnscript',
    );
    const source = readFileSync(dslPath, 'utf-8');
    const document = await parse(source);

    const process = document.parseResult.value.processes[0];
    expect(process!.label).toBe('Invoice Approval');
  });

  test('canonical process has 6 flow nodes and 6 sequence flows', async () => {
    const dslPath = resolve(
      here,
      '../../../examples/spring-boot/processes/invoice-approval.bpmnscript',
    );
    const source = readFileSync(dslPath, 'utf-8');
    const document = await parse(source);

    const process = document.parseResult.value.processes[0]!;
    expect(process.nodes).toHaveLength(6);
    expect(process.flows).toHaveLength(6);
  });
});

// ── 2. Minimal process ───────────────────────────────────────────────────────

describe('Parsing — minimal process', () => {
  test('process with one start, one end, one flow parses without errors', async () => {
    const source = `
process minimal {
  start S
  end E

  S -> E
}
`.trim();

    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    expect(document.parseResult.value.processes).toHaveLength(1);
  });

  test('sequence flow written without spaces (S->E) lexes correctly', async () => {
    // The ID terminal stops at the first character that is neither a word
    // character nor an internal hyphen, so `S->E` tokenizes as ID `S`,
    // keyword `->`, ID `E` even with no surrounding whitespace.
    const source = `
process minimal {
  start S
  end E

  S->E
}
`.trim();

    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const process = document.parseResult.value.processes[0]!;
    expect(process.flows).toHaveLength(1);
  });

  test('minimal process node kinds are parsed correctly', async () => {
    const source = `
process minimal {
  start S
  end E

  S -> E
}
`.trim();

    const document = await parse(source);
    const process = document.parseResult.value.processes[0]!;
    const types = process.nodes.map((n) => n.$type);
    expect(types).toContain('StartEvent');
    expect(types).toContain('EndEvent');
  });

  test('process with optional process label parses', async () => {
    const source = `
process my-proc "My Process" {
  start S
  end E

  S -> E
}
`.trim();

    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const process = document.parseResult.value.processes[0]!;
    expect(process.label).toBe('My Process');
  });

  test('user task with assignee and formKey parses', async () => {
    const source = `
process p {
  start S
  user T "My Task" assignee: "alice" formKey: "my-form"
  end E

  S -> T
  T -> E
}
`.trim();

    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const process = document.parseResult.value.processes[0]!;
    const userTask = process.nodes.find((n) => n.$type === 'UserTask');
    expect(userTask).toBeDefined();
    // Langium strips surrounding quotes from STRING tokens
    expect((userTask as { assignee?: string }).assignee).toBe('alice');
    expect((userTask as { formKey?: string }).formKey).toBe('my-form');
  });

  test('sequence flow with condition parses', async () => {
    const source = `
process p {
  start S
  gateway G
  end E

  S -> G
  G -> E when: "\${amount > 1000}"
}
`.trim();

    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const process = document.parseResult.value.processes[0]!;
    const condFlow = process.flows.find((f) => f.condition !== undefined);
    expect(condFlow).toBeDefined();
    expect(condFlow!.condition).toBe('${amount > 1000}');
  });

  test('sequence flow with as: tag parses', async () => {
    const source = `
process p {
  start S
  gateway G "Check" default: myDefault
  end E

  S -> G
  G -> E as: myDefault
}
`.trim();

    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const process = document.parseResult.value.processes[0]!;
    const namedFlow = process.flows.find((f) => f.name !== undefined);
    expect(namedFlow).toBeDefined();
    expect(namedFlow!.name).toBe('myDefault');
  });
});

// ── 3. Service task without class: fails to parse ───────────────────────────

describe('Parsing — service task validation', () => {
  test('service task without class: fails to parse (class: is required)', async () => {
    // `class:` is a required keyword in the ServiceTask grammar rule.
    // The parser must reject a service task that omits it.
    const source = `
process p {
  start S
  service MyTask "My Service"
  end E

  S -> MyTask
  MyTask -> E
}
`.trim();

    const document = await parse(source);
    // The grammar requires `class:` after the optional label.
    // A missing `class:` is a syntax error, not a validation error.
    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
  });
});

// ── 4. Gateway with unresolvable default: parses (linker handles it) ─────────

describe('Parsing — gateway default reference', () => {
  test('gateway with default: X where X is not a flow id parses cleanly', async () => {
    // The parser only checks grammar structure. Whether "NonExistentFlow"
    // resolves as a cross-reference is the linker's responsibility, not the
    // parser's. The document must parse without parser errors even when the
    // reference is dangling.
    const source = `
process p {
  start S
  gateway G "Check" default: NonExistentFlow
  end E

  S -> G
  G -> E
}
`.trim();

    const document = await parse(source);
    // No parser errors (the grammar allows any ID here).
    expect(document.parseResult.parserErrors).toHaveLength(0);
    // The root AST node is well-formed.
    expect(isModel(document.parseResult.value)).toBe(true);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format any parse errors in `document` into a single human-readable string.
 * Returns `undefined` when the document parses cleanly so the value can be
 * fed straight into `expect(...).toBeUndefined()` to surface the failure cause
 * on a red test.
 */
function formatParseFailure(document: LangiumDocument): string | undefined {
  // Check lexer errors first — they indicate unrecognised tokens before the
  // parser even gets a chance to run, and a file with only lexer errors
  // would otherwise appear to parse cleanly.
  if (document.parseResult.lexerErrors.length) {
    return (
      'Lexer errors:\n  ' +
      document.parseResult.lexerErrors.map((e) => e.message).join('\n  ')
    );
  }
  if (document.parseResult.parserErrors.length) {
    return (
      'Parser errors:\n  ' +
      document.parseResult.parserErrors.map((e) => e.message).join('\n  ')
    );
  }
  if (document.parseResult.value === undefined) {
    return "ParseResult is 'undefined'.";
  }
  if (!isModel(document.parseResult.value)) {
    return `Root AST object is a ${document.parseResult.value.$type}, expected a 'Model'.`;
  }
  return undefined;
}
