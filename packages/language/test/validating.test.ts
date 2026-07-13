/**
 * Validation test suite for the BPMNscript AST.
 *
 * Fourteen validator families are exercised:
 *   - undeclared-variable WARNING (severity 2),
 *   - type-mismatch ERROR (severity 1),
 *   - duplicate attribute-key ERROR,
 *   - allowed attribute keys per element kind ERROR,
 *   - exactly-one service `class` discriminator,
 *   - the unresolved-`goto` regression (linker owns it; no validator double-report),
 *   - structural empty-process-body WARNING,
 *   - reserved synthesised-id name ERROR,
 *   - duplicate process name ERROR,
 *   - duplicate variable name ERROR,
 *   - duplicate process label ERROR,
 *   - duplicate statement name (goto-ambiguity) ERROR,
 *   - empty-block WARNING (if/else-if/else/while/do-while/parallel branch),
 *   - goto-into-parallel-branch-from-outside ERROR.
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

let validate: (input: string) => Promise<ValidationResult<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
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
    expect(diagnosticsFor(declaredInHeader.diagnostics, 'amount')).toHaveLength(
      0,
    );
  });

  test('an undeclared bare identifier as an assignee value is exactly one warning', async () => {
    // A bare identifier in `assignee` renders as a `${var}` JUEL expression, so
    // it is a real variable reference and must be checked like any other.
    const { diagnostics } = await validate(
      `process p { user T { assignee = someUndeclared } }`,
    );
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('someUndeclared');
  });

  test('a declared variable as an assignee value produces no warning', async () => {
    const { diagnostics } = await validate(`
process p {
  var reviewer: string
  user T { assignee = reviewer }
}
`);
    expect(diagnosticsFor(diagnostics, 'is not declared')).toHaveLength(0);
  });

  test('a dotted formKey value produces no undeclared-variable warning', async () => {
    // `formKey` values name form ids, not process variables — the check skips
    // them, same as `class` values.
    const { diagnostics } = await validate(
      `process p { user T { formKey = forms.review } }`,
    );
    expect(diagnosticsFor(diagnostics, 'is not declared')).toHaveLength(0);
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
    expect(
      diagnosticsFor(diagnostics, "Variable 'name' is not declared"),
    ).toHaveLength(0);
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

// ── Allowed attribute keys per element kind ─────────────────────────────────

describe('Validation — allowed attribute keys', () => {
  test('assignee on a service task is exactly one error naming it', async () => {
    const { diagnostics } = await validate(
      `process p { service S { assignee = "x" } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'is not valid');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain('assignee');
    expect(errors[0]!.message).toContain('service');
  });

  test('class on a user task is exactly one error naming it', async () => {
    const { diagnostics } = await validate(
      `process p { user T { class = com.example.X } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'is not valid');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain('class');
    expect(errors[0]!.message).toContain('user');
  });

  test('formKey on a service task is exactly one error naming it', async () => {
    const { diagnostics } = await validate(
      `process p { service S { class = com.example.X formKey = "f" } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'is not valid');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('formKey');
  });

  test('only legal keys on each kind produce no allowed-key error', async () => {
    const { diagnostics } = await validate(`
process p {
  user T { assignee = "a" formKey = "f" }
  service S { class = com.example.X }
}
`);
    expect(diagnosticsFor(diagnostics, 'is not valid')).toHaveLength(0);
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
    expect(diagnosticsFor(diagnostics, "must declare a 'class'")).toHaveLength(
      0,
    );
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

// ── goto regression ─────────────────────────────────────────────────────────

describe('Validation — goto reference', () => {
  test('an unresolved goto produces ONLY the linker error, no extra validator diagnostic', async () => {
    const { diagnostics } = await validate(
      `process p { user Foo goto Missing }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    // Exactly one error — the linker's unresolved-reference error. No custom
    // validator fires on top of it.
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

  test('a Gateway_ name derived from an underscore-prefixed process id is exactly one error', async () => {
    // Process `_p` synthesises gateway ids like `Gateway__p_split` — the
    // segment after `Gateway_` starts with an underscore, which the pattern
    // must still catch.
    const { diagnostics } = await validate(
      `process _p { user Gateway__p_split }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway__p_split');
    expect(errors[0]!.message).toContain('reserved');
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
    const { diagnostics } = await validate(`process p { start Flow_A_B }`);
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Flow_A_B');
  });

  test('a single-segment Flow_Control name is accepted (no diagnostic)', async () => {
    // Flow_Control has only one trailing segment — it cannot match the synthesised
    // Flow_<src>_<tgt> shape and therefore must NOT be rejected.
    const { diagnostics } = await validate(`process p { user Flow_Control }`);
    const reservedErrors = diagnosticsFor(
      diagnostics,
      'reserved synthesised-id',
    );
    expect(reservedErrors).toHaveLength(0);
  });

  test('a single-segment Flow_State name is accepted (no diagnostic)', async () => {
    // Same rationale as Flow_Control: single-segment names are outside the
    // reserved id-shaped pattern and must be accepted.
    const { diagnostics } = await validate(`process p { user Flow_State }`);
    const reservedErrors = diagnosticsFor(
      diagnostics,
      'reserved synthesised-id',
    );
    expect(reservedErrors).toHaveLength(0);
  });

  test('an end event named with a StartEvent_ prefix is exactly one error', async () => {
    const { diagnostics } = await validate(`process p { end StartEvent_p }`);
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('StartEvent_p');
  });

  test('a user task named with an EndEvent_ prefix is exactly one error', async () => {
    const { diagnostics } = await validate(`process p { user EndEvent_p }`);
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
      const reservedErrors = diagnosticsFor(
        diagnostics,
        'reserved synthesised-id',
      );
      expect(reservedErrors, `src: ${src}`).toHaveLength(0);
    }
  });
});

// ── One process per file ────────────────────────────────────────────────────

describe('Validation — one process per file', () => {
  test('a second process block is exactly one error, on the extra block', async () => {
    const { diagnostics } = await validate(`
process Invoice { start S end E }
process Shipping { start S end E }
`);
    const errors = diagnosticsFor(
      diagnostics,
      'Only one process is supported per file',
    ).filter((d) => d.severity === SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
  });

  test('a duplicate-named second process is flagged the same way', async () => {
    const { diagnostics } = await validate(`
process Invoice { start S end E }
process Invoice { start S end E }
`);
    const errors = diagnosticsFor(
      diagnostics,
      'Only one process is supported per file',
    ).filter((d) => d.severity === SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
  });

  test('a single process produces no such error', async () => {
    const { diagnostics } = await validate(`
process Invoice { start S end E }
`);
    expect(
      diagnosticsFor(diagnostics, 'Only one process is supported'),
    ).toHaveLength(0);
  });
});

// ── Start position ──────────────────────────────────────────────────────────

describe('Validation — explicit start must come first', () => {
  test('a start after another statement is exactly one error naming it', async () => {
    const { diagnostics } = await validate(`
process p {
  user A
  start S
  end E
}
`);
    const errors = diagnosticsFor(
      diagnostics,
      'must be the first statement',
    ).filter((d) => d.severity === SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('S');
  });

  test('a start nested in a branch is an error', async () => {
    const { diagnostics } = await validate(`
process p {
  start S
  if (true) {
    start Nested
  }
  end E
}
`);
    const errors = diagnosticsFor(
      diagnostics,
      'must be the first statement',
    ).filter((d) => d.severity === SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Nested');
  });

  test('a start as the first statement produces no error', async () => {
    const { diagnostics } = await validate(`
process p { start S user A end E }
`);
    expect(
      diagnosticsFor(diagnostics, 'must be the first statement'),
    ).toHaveLength(0);
  });

  test('a process without an explicit start produces no error', async () => {
    const { diagnostics } = await validate(`
process p { user A end E }
`);
    expect(
      diagnosticsFor(diagnostics, 'must be the first statement'),
    ).toHaveLength(0);
  });
});

// ── Duplicate variable name ─────────────────────────────────────────────────

describe('Validation — duplicate variable name', () => {
  test('two `var` declarations with the same name is exactly one error naming it', async () => {
    const { diagnostics } = await validate(`
process p {
  var total: number
  var total: string
  start S
  end E
}
`);
    const errors = diagnosticsFor(
      diagnostics,
      "Variable 'total' is already declared",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('two `var` declarations with different names produce no duplicate-variable error', async () => {
    const { diagnostics } = await validate(`
process p {
  var total: number
  var quantity: number
  start S
  end E
}
`);
    expect(diagnosticsFor(diagnostics, 'is already declared')).toHaveLength(0);
  });
});

// ── Duplicate process label ─────────────────────────────────────────────────

describe('Validation — duplicate process label', () => {
  test('two `label = …` declarations in one process is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  label = "First"
  label = "Second"
  start S
  end E
}
`);
    const errors = diagnosticsFor(diagnostics, 'label').filter(
      (d) => d.severity === SEVERITY_ERROR,
    );
    expect(errors).toHaveLength(1);
  });

  test('a `label = …` declaration next to an inline process label is exactly one error', async () => {
    // The inline label counts as the first occurrence: astToIr prefers it and
    // silently drops the `label = "…"` attribute, so the attribute is flagged.
    const { diagnostics } = await validate(`
process P "A" {
  label = "B"
  start S
  end E
}
`);
    const errors = diagnosticsFor(
      diagnostics,
      'already has a label declared',
    ).filter((d) => d.severity === SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
  });

  test('a single `label = …` declaration produces no duplicate-label error', async () => {
    const { diagnostics } = await validate(`
process p {
  label = "Only"
  start S
  end E
}
`);
    const errors = diagnosticsFor(diagnostics, 'label').filter(
      (d) => d.severity === SEVERITY_ERROR,
    );
    expect(errors).toHaveLength(0);
  });
});

// ── Duplicate statement name (goto ambiguity) ───────────────────────────────

describe('Validation — duplicate statement name', () => {
  test('two steps with the same name is exactly one ambiguity error naming it', async () => {
    const { diagnostics } = await validate(`
process p {
  user Review
  user Review
}
`);
    const errors = bySeverity(diagnostics, SEVERITY_ERROR).filter((d) =>
      d.message.includes('Review'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message.toLowerCase()).toContain('ambiguous');
  });

  test('two steps with different names produce no ambiguity error', async () => {
    const { diagnostics } = await validate(`
process p {
  user Review
  user Approve
}
`);
    expect(diagnosticsFor(diagnostics, 'ambiguous')).toHaveLength(0);
  });
});

// ── Empty-block warnings ────────────────────────────────────────────────────

describe('Validation — empty blocks', () => {
  test('an empty `then` branch is exactly one warning', async () => {
    const { diagnostics } = await validate(`
process p {
  if (flag == true) { }
  start S
  end E
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('an empty `else if` branch is exactly one warning', async () => {
    const { diagnostics } = await validate(`
process p {
  if (flag == true) { user A } else if (flag == false) { }
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('an empty `else` branch is exactly one warning', async () => {
    const { diagnostics } = await validate(`
process p {
  if (flag == true) { user A } else { }
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('an empty `while` body is exactly one warning', async () => {
    const { diagnostics } = await validate(`
process p {
  while (flag == true) { }
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('an empty `do … while` body is exactly one warning', async () => {
    const { diagnostics } = await validate(`
process p {
  do { } while (flag == true)
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('an empty `parallel` branch is exactly one warning', async () => {
    const { diagnostics } = await validate(`
process p {
  parallel {
    { user A }
    { }
  }
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('fully populated branches produce no empty-block warning', async () => {
    const { diagnostics } = await validate(`
process p {
  if (flag == true) { user A } else if (flag == false) { user B } else { user C }
  while (flag == true) { user D }
  do { user E } while (flag == true)
  parallel {
    { user F }
    { user G }
  }
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(0);
  });
});

// ── Goto into a parallel branch from outside ────────────────────────────────
//
// All four cases run end-to-end through the real `validate()` pipeline. The two
// "positive" (error-firing) cases resolve their `goto` target through the
// process-scoped `ScopeProvider`: a step nested in a `parallel` branch is
// reachable from a `goto` elsewhere in the *same* process, which is exactly the
// situation the goto-into-parallel check exists to reject.

describe('Validation — goto into a parallel branch', () => {
  test('a goto from outside jumping into a parallel branch is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  parallel {
    { user A }
    { user B }
  }
  goto A
}
`);
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('A');
    expect(errors[0]!.message.toLowerCase()).toContain('branch');
  });

  test('a goto from a sibling branch into another branch is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  parallel {
    { user A goto B }
    { user B }
  }
}
`);
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('B');
    expect(errors[0]!.message.toLowerCase()).toContain('branch');
  });

  test('a goto from within the same branch to a step in that branch produces no error', async () => {
    const { diagnostics } = await validate(`
process p {
  parallel {
    { user A goto A }
    { user B }
  }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });

  test('a goto entirely outside any parallel statement produces no error', async () => {
    const { diagnostics } = await validate(`
process p {
  user A
  goto A
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });
});

// ── Form fields ─────────────────────────────────────────────────────────────

describe('Validation — form fields', () => {
  test('a valid form on a start event and a user task produces no errors', async () => {
    const { diagnostics } = await validate(`
process p {
  start Begin { form { amount: number "Amount" } }
  user Approve { assignee = "demo" form { approved: boolean "OK?" = false } }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });

  test('a form field declares the variable it binds (no undeclared warning)', async () => {
    const { diagnostics } = await validate(`
process p {
  start Begin { form { amount: number "Amount" } }
  if (amount > 1000) { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'not declared')).toHaveLength(0);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });

  test('a form field type outside string/number/boolean/date is an error', async () => {
    const { diagnostics } = await validate(
      `process p { start Begin { form { blob: json "Blob" } } }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('which a form cannot use');
  });

  test('a form block on a service task is an error', async () => {
    const { diagnostics } = await validate(
      `process p { service S { class = "com.x.Y" form { a: number } } }`,
    );
    expect(
      diagnosticsFor(diagnostics, "cannot declare a 'form' block"),
    ).toHaveLength(1);
  });

  test('a bare attribute on a start event is an error', async () => {
    const { diagnostics } = await validate(
      `process p { start Begin { assignee = "demo" } }`,
    );
    expect(
      diagnosticsFor(diagnostics, 'not valid on a start event'),
    ).toHaveLength(1);
  });

  test('duplicate field ids within a form block are flagged', async () => {
    const { diagnostics } = await validate(
      `process p { start Begin { form { a: number a: string } } }`,
    );
    expect(diagnosticsFor(diagnostics, 'Duplicate form field')).toHaveLength(1);
  });

  test('a second form block on one element is an error', async () => {
    const { diagnostics } = await validate(
      `process p { start Begin { form { a: number } form { b: string } } }`,
    );
    expect(
      diagnosticsFor(diagnostics, "at most one 'form' block"),
    ).toHaveLength(1);
  });

  test('a form field must agree with a var of the same name', async () => {
    const conflict = await validate(`
process p {
  var amount: string
  start Begin { form { amount: number "Amount" } }
}
`);
    expect(
      diagnosticsFor(conflict.diagnostics, 'the types must agree'),
    ).toHaveLength(1);

    const agrees = await validate(`
process p {
  var amount: number
  start Begin { form { amount: number "Amount" } }
}
`);
    expect(
      diagnosticsFor(agrees.diagnostics, 'the types must agree'),
    ).toHaveLength(0);
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
