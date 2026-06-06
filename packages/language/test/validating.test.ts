/**
 * Structural BPMN validation tests for the BpmnScript language.
 *
 * Exercises the `BpmnScriptValidator` checks registered in
 * `bpmn-script-validator.ts`. Uses Langium's `validationHelper` from
 * `langium/test` to run both the linker and the custom validator in a single
 * step, then inspects the resulting `Diagnostic[]`.
 *
 * Test cases:
 *   1. Process with no start event → exactly one error mentioning "start".
 *   2. Process with no end event → exactly one error mentioning "end".
 *   3. Sequence flow whose source cross-ref doesn't resolve → exactly one
 *      Langium linker error.
 *   4. Orphan node (declared but referenced by no flow) → exactly one error.
 *   5. Gateway `default: X` where no flow has `as: X` → exactly one error
 *      (linker: dangling reference, because `default:` is a cross-ref to a
 *      `SequenceFlow` identified by its `as:` id in the grammar).
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { validationHelper } from 'langium/test';
import type { Model } from '@bpmn-script/language';
import { createBpmnScriptServices } from '@bpmn-script/language';

let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  validate = validationHelper<Model>(services.BpmnScript);
});

// ── 1. Missing start event ───────────────────────────────────────────────────

describe('Validation — missing start event', () => {
  test('process with no start event yields exactly one error', async () => {
    const source = `
process no-start {
  end E

  E -> E
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(1);
  });

  test('the missing-start error message mentions start event', async () => {
    const source = `
process no-start {
  end E

  E -> E
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors[0]!.message.toLowerCase()).toMatch(/start/);
  });
});

// ── 2. Missing end event ─────────────────────────────────────────────────────

describe('Validation — missing end event', () => {
  test('process with no end event yields exactly one error', async () => {
    const source = `
process no-end {
  start S

  S -> S
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(1);
  });

  test('the missing-end error message mentions end event', async () => {
    const source = `
process no-end {
  start S

  S -> S
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors[0]!.message.toLowerCase()).toMatch(/end/);
  });
});

// ── 3. Unresolvable targetRef ────────────────────────────────────────────────

describe('Validation — unresolved cross-reference', () => {
  test('sequence flow with unresolvable target id produces exactly one linker error', async () => {
    // "UnknownTarget" is never declared — the Langium linker raises exactly
    // one error for the dangling `->` target reference.
    // A second valid flow S -> E is present so that S and E are both
    // referenced (no orphan side-effect), keeping the error count at 1.
    const source = `
process bad-ref {
  start S
  end E

  S -> E
  S -> UnknownTarget
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(1);
  });

  test('the linker error message names the unresolvable reference', async () => {
    const source = `
process bad-ref {
  start S
  end E

  S -> E
  S -> UnknownTarget
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors[0]!.message).toContain('UnknownTarget');
  });
});

// ── 4. Orphan node ───────────────────────────────────────────────────────────

describe('Validation — orphan node', () => {
  test('a flow node that is not connected by any flow yields exactly one error', async () => {
    // "Orphan" is declared but never appears as source or target of any flow.
    const source = `
process with-orphan {
  start S
  user Orphan "Orphaned task"
  end E

  S -> E
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(1);
  });

  test('the orphan error message mentions the node name', async () => {
    const source = `
process with-orphan {
  start S
  user Orphan "Orphaned task"
  end E

  S -> E
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors[0]!.message).toContain('Orphan');
  });
});

// ── 5. Gateway default: references a non-existent flow ──────────────────────

describe('Validation — gateway default with no matching as: flow', () => {
  test('gateway default: X where no flow has as: X yields exactly one error', async () => {
    // In the grammar `default:` is a cross-reference `[SequenceFlow:ID]`
    // where the ID is the `as:` tag of a sequence flow. When no flow has
    // that tag, the Langium linker produces exactly one "Could not resolve
    // reference" error.
    const source = `
process bad-default {
  start S
  gateway G "Check" default: NonExistentFlow
  end E

  S -> G
  G -> E
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(1);
  });

  test('valid gateway with matching as: flow produces no errors', async () => {
    const source = `
process good-default {
  start S
  gateway G "Check" default: defaultPath
  user T "Task"
  end E

  S -> G
  G -> T when: "\${x > 0}"
  G -> E as: defaultPath
  T -> E
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(0);
  });
});

// ── 6b. Default flow must not carry a condition ──────────────────────────────

describe('Validation — default flow with a when: condition', () => {
  test('gateway default flow that also declares when: yields exactly one error', async () => {
    // `defaultPath` is both the gateway default and a conditional flow.
    // BPMN forbids a default flow from carrying a conditionExpression.
    const source = `
process bad-default-cond {
  start S
  gateway G "Check" default: defaultPath
  end E

  S -> G
  G -> E as: defaultPath when: "\${x > 0}"
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message.toLowerCase()).toMatch(/condition/);
  });
});

// ── 7. Valid process produces no errors ──────────────────────────────────────

describe('Validation — valid process', () => {
  test('a structurally correct process produces no validation errors', async () => {
    const source = `
process correct {
  start S
  user T "My Task" assignee: "alice"
  end E

  S -> T
  T -> E
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(0);
  });
});

// ── 8. Single process per file ───────────────────────────────────────────────

describe('Validation — single process per file', () => {
  test('two processes in one file yield exactly one error', async () => {
    // Each process is internally valid, so the only error is the
    // single-process rule fired on the second process block.
    const source = `
process first {
  start S
  end E

  S -> E
}

process second {
  start S2
  end E2

  S2 -> E2
}
`.trim();

    const result = await validate(source);
    const errors = result.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message.toLowerCase()).toMatch(/one process/);
  });
});
