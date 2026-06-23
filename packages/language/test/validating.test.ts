/**
 * Validation test suite for the BPMNscript AST.
 *
 * Five validator families are exercised (all `[unit]`):
 *   - undeclared-variable WARNING (severity 2),
 *   - type-mismatch ERROR (severity 1),
 *   - duplicate attribute-key ERROR,
 *   - exactly-one service `class` discriminator,
 *   - the unresolved-`goto` regression (linker owns it; no validator double-report).
 *
 * Diagnostics are produced through Langium's `validationHelper`, which parses,
 * links and runs the registered validation checks, returning the merged
 * diagnostic list. Severity follows the LSP convention: `1 = Error`,
 * `2 = Warning`.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { validationHelper, type ValidationResult } from 'langium/test';
import type { Model } from '@bpmn-script/language';
import { createBpmnScriptServices } from '@bpmn-script/language';

const SEVERITY_ERROR = 1;
const SEVERITY_WARNING = 2;

let services: ReturnType<typeof createBpmnScriptServices>;
let validate: (input: string) => Promise<ValidationResult<Model>>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem);
  validate = validationHelper<Model>(services.BpmnScript);
});

// ── Undeclared-variable warning ─────────────────────────────────────────────

describe('Validation — undeclared variable', () => {
  test('an undeclared variable in a condition yields exactly one warning naming it', async () => {
    const { diagnostics } = await validate(
      `process p { if (amount > 1000) { user A } }`,
    );
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('amount');
    // No errors — an undeclared variable is only a warning, never an error.
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });

  test('a declared variable used compatibly produces no diagnostic', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  if (amount > 1000) { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'amount')).toHaveLength(0);
  });

  test('var declarations are collected from the header section and visible throughout the body', async () => {
    // The grammar forces every `var` into the header section before any
    // statement; visibility is flat/process-scoped, so a header `var` is in
    // scope for every reference in the body regardless of textual position.
    // First, without the declaration the reference is undeclared (one warning).
    const { diagnostics } = await validate(`
process p {
  if (amount > 1000) { user A }
  end Done
}
`);
    expect(diagnosticsFor(diagnostics, 'amount')).toHaveLength(1);

    // With the declaration present in the header, the same body reference is in
    // scope and the warning disappears.
    const declaredInHeader = await validate(`
process p {
  var amount: number
  if (amount > 1000) { user A }
  end Done
}
`);
    expect(diagnosticsFor(declaredInHeader.diagnostics, 'amount')).toHaveLength(0);
  });
});

// ── Type-mismatch error ─────────────────────────────────────────────────────

describe('Validation — type mismatch', () => {
  test('a string-typed var compared with a number literal is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  var name: string
  if (name > 1000) { user A }
}
`);
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('name');
    // The variable IS declared, so there is no undeclared warning for it.
    expect(diagnosticsFor(diagnostics, "Variable 'name' is not declared")).toHaveLength(
      0,
    );
  });

  test('a number-typed var in an ordered comparison is not an error', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  if (amount >= 1000) { user A }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });

  test('a boolean-typed var used in arithmetic is an error', async () => {
    const { diagnostics } = await validate(`
process p {
  var flag: boolean
  if (flag + 1 > 0) { user A }
}
`);
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors.some((d) => d.message.includes('flag'))).toBe(true);
  });

  test('an any-typed var never triggers a type error', async () => {
    const { diagnostics } = await validate(`
process p {
  var x: any
  if (x > 1000) { user A }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });
});

// ── Duplicate attribute key ─────────────────────────────────────────────────

describe('Validation — duplicate attribute key', () => {
  test('a duplicate assignee in one user block is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { user T { assignee = "a" assignee = "b" } }`,
    );
    const dupErrors = diagnosticsFor(diagnostics, 'Duplicate attribute');
    expect(dupErrors).toHaveLength(1);
    expect(dupErrors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(dupErrors[0]!.message).toContain('assignee');
  });

  test('a non-duplicated attribute block produces no duplicate error', async () => {
    const { diagnostics } = await validate(
      `process p { user T { assignee = "a" formKey = "f" } }`,
    );
    expect(diagnosticsFor(diagnostics, 'Duplicate attribute')).toHaveLength(0);
  });
});

// ── Service-task discriminator ──────────────────────────────────────────────

describe('Validation — service task class discriminator', () => {
  test('a service task with no class is exactly one error', async () => {
    const { diagnostics } = await validate(`process p { service S { } }`);
    const classErrors = diagnosticsFor(diagnostics, "must declare a 'class'");
    expect(classErrors).toHaveLength(1);
    expect(classErrors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(classErrors[0]!.message).toContain('S');
  });

  test('a service task with a class has no discriminator error', async () => {
    const { diagnostics } = await validate(
      `process p { service S { class = com.example.X } }`,
    );
    expect(diagnosticsFor(diagnostics, "must declare a 'class'")).toHaveLength(0);
  });

  test('a dotted class reference produces no undeclared-variable warning', async () => {
    // `class = com.example.X` parses its value as a VarRef rooted at `com`. That
    // identifier names a Java class, not a process variable, so the
    // undeclared-variable check must skip attribute-value VarRefs entirely — zero
    // "Variable 'com' is not declared" warnings.
    const { diagnostics } = await validate(
      `process p { service S { class = com.example.X } }`,
    );
    expect(diagnosticsFor(diagnostics, 'is not declared')).toHaveLength(0);
    expect(bySeverity(diagnostics, SEVERITY_WARNING)).toHaveLength(0);
  });
});

// ── goto regression (CLAUDE.md guard-ref lesson) ────────────────────────────

describe('Validation — goto reference', () => {
  test('an unresolved goto produces ONLY the linker error, no extra validator diagnostic', async () => {
    const { diagnostics } = await validate(
      `process p { user Foo goto Missing }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    // Exactly one error — the linker's unresolved-reference error. No custom
    // validator fires on top of it (guard-ref lesson).
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Missing');
  });

  test('a resolved goto produces no error', async () => {
    const { diagnostics } = await validate(`process p { user Foo goto Foo }`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });
});

// ── Structural ──────────────────────────────────────────────────────────────

describe('Validation — structural', () => {
  test('a process with an empty body produces a warning', async () => {
    const { diagnostics } = await validate(`process empty { }`);
    const warnings = diagnosticsFor(diagnostics, 'empty body');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe(SEVERITY_WARNING);
  });

  test('a non-empty process produces no empty-body warning', async () => {
    const { diagnostics } = await validate(`process p { start S end E }`);
    expect(diagnosticsFor(diagnostics, 'empty body')).toHaveLength(0);
  });
});

// ── Reserved synthesised-id name check ─────────────────────────────────────

describe('Validation — reserved synthesised-id name', () => {
  test('a start event named with a Gateway_*_split pattern is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { start Gateway_foo_split }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway_foo_split');
    expect(errors[0]!.message).toContain('reserved');
  });

  test('a user task named with a Gateway_*_join pattern is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { user Gateway_invoice-approval_2_join }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway_invoice-approval_2_join');
  });

  test('a service task named with a Gateway_*_fork pattern is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { service Gateway_p_0_fork { class = com.example.X } }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR).filter((d) =>
      d.message.includes('reserved'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway_p_0_fork');
  });

  test('a user task named with a Gateway_*_loop pattern is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { user Gateway_p_1_loop }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway_p_1_loop');
  });

  test('a start event named with an id-shaped Flow_<src>_<tgt> pattern is exactly one error', async () => {
    // Only the two-segment form matches synthesised flow ids (Flow_<src>_<tgt>,
    // Flow_<gatewayId>_default). Single-segment names like Flow_Control cannot
    // collide with a SequenceFlow.id and are therefore NOT reserved.
    const { diagnostics } = await validate(
      `process p { start Flow_A_B }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Flow_A_B');
  });

  test('a single-segment Flow_Control name is accepted (no diagnostic)', async () => {
    // Flow_Control has only one trailing segment — it cannot match the synthesised
    // Flow_<src>_<tgt> shape and therefore must NOT be rejected.
    const { diagnostics } = await validate(
      `process p { user Flow_Control }`,
    );
    const reservedErrors = diagnosticsFor(diagnostics, 'reserved synthesised-id');
    expect(reservedErrors).toHaveLength(0);
  });

  test('a single-segment Flow_State name is accepted (no diagnostic)', async () => {
    // Same rationale as Flow_Control: single-segment names are outside the
    // reserved id-shaped pattern and must be accepted.
    const { diagnostics } = await validate(
      `process p { user Flow_State }`,
    );
    const reservedErrors = diagnosticsFor(diagnostics, 'reserved synthesised-id');
    expect(reservedErrors).toHaveLength(0);
  });

  test('an end event named with a StartEvent_ prefix is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { end StartEvent_p }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('StartEvent_p');
  });

  test('a user task named with an EndEvent_ prefix is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { user EndEvent_p }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('EndEvent_p');
  });

  test('normal names including Gateway-prefixed ones without suffix produce no error', async () => {
    // GatewayCheck does not end in _split|join|fork|loop → not reserved.
    // MyFlow_Thing → lacks the Flow_ prefix (starts with My).
    // Flow_Control, Flow_State → single-segment; cannot match Flow_<src>_<tgt>.
    // StartEventHandler → lacks StartEvent_ prefix (no trailing underscore anchor).
    const cases = [
      `process p { user GatewayCheck }`,
      `process p { user MyFlow_Thing }`,
      `process p { user Flow_Control }`,
      `process p { user Flow_State }`,
      `process p { user StartEventHandler }`,
      `process p { user EndEventHandler }`,
      `process p { user Gateway_split }`,
      `process p { start S end E }`,
    ];
    for (const src of cases) {
      const { diagnostics } = await validate(src);
      const reservedErrors = diagnosticsFor(diagnostics, 'reserved synthesised-id');
      expect(reservedErrors, `src: ${src}`).toHaveLength(0);
    }
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** All diagnostics of the given LSP severity (1 = Error, 2 = Warning). */
function bySeverity(
  diagnostics: ValidationResult<Model>['diagnostics'],
  severity: number,
) {
  return diagnostics.filter((d) => d.severity === severity);
}

/** All diagnostics whose message contains `needle`. */
function diagnosticsFor(
  diagnostics: ValidationResult<Model>['diagnostics'],
  needle: string,
) {
  return diagnostics.filter((d) => d.message.includes(needle));
}
