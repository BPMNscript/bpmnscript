/**
 * Validation test suite for the BPMNscript AST.
 *
 * Fourteen validator families are exercised:
 *   - undeclared-variable WARNING (severity 2),
 *   - type-mismatch ERROR (severity 1),
 *   - duplicate attribute-key ERROR,
 *   - allowed attribute keys per element kind ERROR,
 *   - exactly-one service-task binding discriminator (`class`/`expression`/`delegate`),
 *   - external-task `topic` requirement,
 *   - script-task fence (language tag, non-empty body),
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
 * A call activity is checked like a function call at the process boundary: a
 * required `process` (the callee), an optional `binding`/`version` pinning
 * discriminator (mutually exclusive), and `in`/`out` variable mappings (the
 * call's arguments and return values) that must not repeat a target within one
 * direction. An `out` mapping's source is a callee-scope reference — evaluated
 * in the CALLED process, not the caller's — so it is exempt from the caller's
 * undeclared-variable and type-mismatch checks.
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

  test('a bareword expression value produces no undeclared-variable warning', async () => {
    // `expression` values are an EL binding, not a process variable — the
    // check skips them, same as `class`/`formKey` values.
    const { diagnostics } = await validate(
      `process p { service S { expression = someBareword } }`,
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

// ── Service-task binding discriminator ──────────────────────────────────────

describe('Validation — service task binding discriminator', () => {
  test('a service task with two distinct bindings is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  service S { class = com.example.X expression = "\${bean.method(execution)}" }
}
`);
    const errors = diagnosticsFor(diagnostics, 'more than one binding');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain('S');
  });

  test('a service task with an expression binding only has no discriminator error', async () => {
    const { diagnostics } = await validate(
      `process p { service S { expression = "\${bean.method(execution)}" } }`,
    );
    expect(diagnosticsFor(diagnostics, "must declare a 'class'")).toHaveLength(
      0,
    );
    expect(diagnosticsFor(diagnostics, 'more than one binding')).toHaveLength(
      0,
    );
  });

  test('a service task with a delegate binding only has no discriminator error', async () => {
    const { diagnostics } = await validate(
      `process p { service S { delegate = "\${beanName}" } }`,
    );
    expect(diagnosticsFor(diagnostics, "must declare a 'class'")).toHaveLength(
      0,
    );
    expect(diagnosticsFor(diagnostics, 'more than one binding')).toHaveLength(
      0,
    );
  });
});

// ── External task ───────────────────────────────────────────────────────────

describe('Validation — external task', () => {
  test('an external task without a topic is exactly one error', async () => {
    const { diagnostics } = await validate(`process p { external ship { } }`);
    const errors = diagnosticsFor(diagnostics, "must declare a 'topic'");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain('ship');
  });

  test('an external task with a non-topic key is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { external ship { class = com.example.X } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'is not valid');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('class');
    expect(errors[0]!.message).toContain('external');
  });

  test('an external task with a topic has no discriminator error', async () => {
    const { diagnostics } = await validate(
      `process p { external ship { topic = "shipping" } }`,
    );
    expect(diagnosticsFor(diagnostics, "must declare a 'topic'")).toHaveLength(
      0,
    );
  });
});

// ── Script task ──────────────────────────────────────────────────────────────

describe('Validation — script task', () => {
  // A triple-backtick fence, assembled without a literal fence in the test
  // source so it can be interpolated into JS template-literal DSL fixtures.
  const FENCE = '`' + '`' + '`';

  test('a script task with an unsupported language tag is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  script total ${FENCE}php
x = 1
${FENCE}
}
`);
    const errors = diagnosticsFor(diagnostics, 'unsupported language tag');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain('total');
  });

  test('a script task with an empty body is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  script total ${FENCE}js
${FENCE}
}
`);
    const errors = diagnosticsFor(diagnostics, 'empty script body');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain('total');
  });

  test('a valid script task produces no errors', async () => {
    const { diagnostics } = await validate(`
process p {
  script total ${FENCE}js
x = 1
${FENCE}
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
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

  test('a goto resolving to an external task produces no error', async () => {
    const { diagnostics } = await validate(`
process p {
  external Ship { topic = "shipping" }
  goto Ship
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });

  test('a goto resolving to a script task produces no error', async () => {
    const FENCE = '`' + '`' + '`';
    const { diagnostics } = await validate(`
process p {
  script Compute ${FENCE}js
x = 1
${FENCE}
  goto Compute
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });

  test('a goto resolving to a call activity produces no error', async () => {
    const { diagnostics } = await validate(`
process p {
  call F { process = "p" }
  goto F
}
`);
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

  test('an external task and a script task sharing a name is exactly one ambiguity error', async () => {
    const FENCE = '`' + '`' + '`';
    const { diagnostics } = await validate(`
process p {
  external A { topic = "shipping" }
  script A ${FENCE}js
x = 1
${FENCE}
}
`);
    const errors = diagnosticsFor(diagnostics, 'ambiguous');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain("'A'");
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

// ── Unreachable-statement warning ───────────────────────────────────────────

describe('Validation — unreachable statement', () => {
  const unreachable = (diagnostics: ValidationResult<Model>['diagnostics']) =>
    diagnosticsFor(diagnostics, 'can never run');

  test('a step after an `end` in the same block is flagged as unreachable', async () => {
    const { diagnostics } = await validate(
      `process p { start S end Done user Dead }`,
    );
    const warnings = unreachable(diagnostics);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe(SEVERITY_WARNING);
  });

  test('every dead step after an `end` is flagged, one warning each', async () => {
    const { diagnostics } = await validate(
      `process p { start S end Done user A user B }`,
    );
    expect(unreachable(diagnostics)).toHaveLength(2);
  });

  test('a step after a `goto` is unreachable (the jump always diverts the flow)', async () => {
    const { diagnostics } = await validate(
      `process p { user A goto A user Dead }`,
    );
    expect(unreachable(diagnostics)).toHaveLength(1);
  });

  test('a `goto` target after an `end` stays reachable — the jump re-enters there', async () => {
    // `Retry` sits after `end Done`, but a `goto` targets it, so control can
    // reach it; it must NOT be flagged.
    const { diagnostics } = await validate(
      `process p { start S if (cond) { goto Retry } end Done user Retry }`,
    );
    expect(unreachable(diagnostics)).toHaveLength(0);
  });

  test('an unreachable compound is reported once, not once per nested step', async () => {
    const { diagnostics } = await validate(
      `process p { start S end Done if (cond) { user A user B } }`,
    );
    expect(unreachable(diagnostics)).toHaveLength(1);
  });

  test('ordinary sequential flow yields no unreachable warning', async () => {
    const { diagnostics } = await validate(
      `process p { start S user A end Done }`,
    );
    expect(unreachable(diagnostics)).toHaveLength(0);
  });
});

// ── Sub-process statement ───────────────────────────────────────────────────

describe('Validation — subprocess start position', () => {
  test('an explicit `start` as the first statement of a subprocess body produces no error', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    start In
    user A
    end Out
  }
}
`);
    expect(
      diagnosticsFor(diagnostics, 'must be the first statement'),
    ).toHaveLength(0);
  });

  test('a `start` as the second statement of a subprocess body is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    user A
    start In
  }
}
`);
    const errors = diagnosticsFor(
      diagnostics,
      'must be the first statement',
    ).filter((d) => d.severity === SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('In');
  });

  test('a `start` inside an `if` block nested in a subprocess body is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    if (true) {
      start In
    }
  }
}
`);
    const errors = diagnosticsFor(
      diagnostics,
      'must be the first statement',
    ).filter((d) => d.severity === SEVERITY_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('In');
  });
});

describe('Validation — subprocess empty body', () => {
  test('an empty subprocess body is exactly one warning', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S { }
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('a non-empty subprocess body produces no empty-body warning', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S { user A }
}
`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(0);
  });
});

describe('Validation — subprocess reserved and duplicate names', () => {
  test('a subprocess named with a reserved synthesised-id pattern is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { subprocess Gateway_x_split { user A } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'reserved synthesised-id');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway_x_split');
  });

  test('a subprocess named with a StartEvent_ prefix is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { subprocess StartEvent_foo { user A } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'reserved synthesised-id');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('StartEvent_foo');
  });

  test('two subprocesses with the same name is exactly one ambiguity error', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S { user A }
  subprocess S { user B }
}
`);
    const errors = diagnosticsFor(diagnostics, 'ambiguous');
    expect(errors).toHaveLength(1);
  });

  test('a step nested inside a subprocess reusing a parent step name is exactly one ambiguity error', async () => {
    const { diagnostics } = await validate(`
process p {
  user A
  subprocess S { user A }
}
`);
    const errors = diagnosticsFor(diagnostics, 'ambiguous');
    expect(errors).toHaveLength(1);
  });
});

describe('Validation — subprocess unreachable statements', () => {
  const unreachable = (diagnostics: ValidationResult<Model>['diagnostics']) =>
    diagnosticsFor(diagnostics, 'can never run');

  test('a step after an `end` inside a subprocess body is flagged as unreachable', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    start In
    end Out
    user Dead
  }
}
`);
    expect(unreachable(diagnostics)).toHaveLength(1);
  });

  // The unreachable subprocess itself is flagged once; the check short-circuits
  // before recursing into its nested steps, so no per-nested-step warnings pile
  // up. (The nested-body recursion itself is pinned by the sibling test above.)
  test('an unreachable subprocess in the parent body warns once for the subprocess, not once per nested step', async () => {
    const { diagnostics } = await validate(`
process p {
  start S
  end Done
  subprocess Sub {
    user A
    user B
  }
}
`);
    expect(unreachable(diagnostics)).toHaveLength(1);
  });
});

// ── Call activity ───────────────────────────────────────────────────────────

describe('Validation — call activity valid programs', () => {
  test('a minimal call naming only `process` is diagnostic-free', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });

  test('a full-featured call (every attribute and mapping shape) is diagnostic-free', async () => {
    // Mirrors the parser's canonical fixture; `amount`/`tax`/`vipFlag` are the
    // caller-scope variables the `in` mappings read, so they must be declared
    // here. `confirmed` (the `out shipped = confirmed` source) is a
    // callee-scope reference and deliberately left undeclared.
    const { diagnostics } = await validate(`
process p {
  var amount: number
  var tax: number
  var vipFlag: boolean

  call Fulfilment "Fulfil order" {
    process = "fulfilment-process"
    binding = deployment
    businessKey = "\${execution.processBusinessKey}"
    in *
    in orderId
    in total = amount + tax
    in local vip = vipFlag
    out shipmentId
    out shipped = confirmed
  }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('an explicit `binding = latest` is diagnostic-free', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" binding = latest } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });
});

describe('Validation — call activity required `process`', () => {
  test('a call with no `process` attribute is exactly one error naming the requirement', async () => {
    const { diagnostics } = await validate(`process p { call X { } }`);
    const errors = diagnosticsFor(diagnostics, 'must name the process');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a call with an empty `process = ""` is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "" } }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR).filter((d) =>
      d.message.includes('empty'),
    );
    expect(errors).toHaveLength(1);
  });

  test('a call with a non-empty `process` produces no required-process error', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" } }`,
    );
    expect(diagnosticsFor(diagnostics, 'must name the process')).toHaveLength(
      0,
    );
  });
});

describe('Validation — call activity allowed keys cut both ways', () => {
  test('`assignee` on a call is exactly one not-valid-here error', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" assignee = "x" } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'is not valid');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('assignee');
    expect(errors[0]!.message).toContain('call');
  });

  test('`process` on a user task is exactly one not-valid-here error', async () => {
    const { diagnostics } = await validate(
      `process p { user T { process = "p" } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'is not valid');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('process');
    expect(errors[0]!.message).toContain('user');
  });
});

describe('Validation — call activity binding/version', () => {
  test('`binding = version` (only authorable quoted, since `version` is a reserved word and cannot parse as a bare identifier) is the teaching error', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" binding = "version" } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'version = ');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('an unrecognised `binding` value is exactly one error naming both legal values', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" binding = weekly } }`,
    );
    const errors = bySeverity(diagnostics, SEVERITY_ERROR).filter((d) =>
      d.message.includes("'binding'"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('latest');
    expect(errors[0]!.message).toContain('deployment');
  });

  test('`binding` and `version` together is exactly one mutual-exclusion error', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" binding = deployment version = 2 } }`,
    );
    const errors = diagnosticsFor(
      diagnostics,
      "combine 'binding' and 'version'",
    );
    expect(errors).toHaveLength(1);
  });

  test('`version` alone produces no diagnostic', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" version = 2 } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });
});

describe('Validation — call activity mapping duplicates', () => {
  test('two `in` mappings naming the same target is exactly one duplicate error, on the second', async () => {
    const { diagnostics } = await validate(`
process p {
  var a: number
  var b: number
  call X {
    process = "p"
    in x = a
    in x = b
  }
}
`);
    const errors = diagnosticsFor(diagnostics, 'Duplicate').filter(
      (d) => d.severity === SEVERITY_ERROR,
    );
    expect(errors).toHaveLength(1);
  });

  test('`in x` and `out x` (independent directions) produce no duplicate error', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" in x out x } }`,
    );
    expect(diagnosticsFor(diagnostics, 'Duplicate')).toHaveLength(0);
  });

  test('two `in *` mappings is exactly one duplicate error', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" in * in * } }`,
    );
    expect(diagnosticsFor(diagnostics, 'Duplicate')).toHaveLength(1);
  });

  test('`in *` alongside a named `in` mapping produces no duplicate error', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" in * in x } }`,
    );
    expect(diagnosticsFor(diagnostics, 'Duplicate')).toHaveLength(0);
  });
});

describe('Validation — call activity callee-scope exemption', () => {
  test('an undeclared `out` mapping source produces no undeclared-variable warning', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" out y = calleeVar } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });

  test('an `out` mapping source nested inside an operator is exempt from the type-mismatch check', async () => {
    // `calleeVar` happens to share a name with a caller-declared `string`
    // variable, and the source is nested two levels deep (inside a `Logical`
    // node, itself the mapping's source) — this only stays diagnostic-free
    // when the exemption walks the full container chain (`getContainerOfType`)
    // rather than checking only the mapping's direct `source` node.
    const { diagnostics } = await validate(`
process p {
  var calleeVar: string
  call X { process = "p" out y = calleeVar > 5 && true }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('an undeclared `in` mapping source still produces the usual undeclared-variable warning', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = "p" in y = callerVar } }`,
    );
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.includes('callerVar'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('a bareword `process` value produces no undeclared-variable warning', async () => {
    const { diagnostics } = await validate(
      `process p { call X { process = some-id } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });

  test('a bareword `businessKey` value still produces the undeclared-variable warning', async () => {
    // Unlike process/binding/version, businessKey is a real variable reference
    // (the assignee precedent), so it is NOT exempt from the check.
    const { diagnostics } = await validate(
      `process p { call X { process = "p" businessKey = someUndeclared } }`,
    );
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.includes('someUndeclared'),
    );
    expect(warnings).toHaveLength(1);
  });
});

describe('Validation — call activity membership', () => {
  test('a call and a task sharing a name is exactly one ambiguity error', async () => {
    const { diagnostics } = await validate(`
process p {
  user A
  call A { process = "p" }
}
`);
    const errors = diagnosticsFor(diagnostics, 'already used by another step');
    expect(errors).toHaveLength(1);
  });

  test('a call named with a reserved synthesised-id pattern is exactly one error', async () => {
    const { diagnostics } = await validate(
      `process p { call StartEvent_x { process = "p" } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'reserved synthesised-id');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('StartEvent_x');
  });

  test('a call after an `end` is flagged as unreachable', async () => {
    const { diagnostics } = await validate(
      `process p { start S end Done call Dead { process = "p" } }`,
    );
    const warnings = diagnosticsFor(diagnostics, 'can never run');
    expect(warnings).toHaveLength(1);
  });

  test('a `goto` targeting the call makes it reachable', async () => {
    const { diagnostics } = await validate(`
process p {
  start S
  if (cond) { goto Retry }
  end Done
  call Retry { process = "p" }
}
`);
    expect(diagnosticsFor(diagnostics, 'can never run')).toHaveLength(0);
  });
});

// ── Event handlers, throw / emit, error declaration ────────────────────────
//
// The event layer is validated as the DSL's try/catch: a handler sits at the
// end of the body it guards like a catch block, `throw` always ends its
// path, `emit` fires and continues, and a binding declares the process
// variable it fills. The trigger kind (`error`/`escalation`) and binding
// fields (`code`/`message`) are soft words (plain `ID`s in the grammar), so
// an unknown word is a validator diagnostic that names the legal options
// rather than a parse error.

describe('Validation — clean event-layer programs', () => {
  test('a surface block with coded/bound handlers and an alongside escalation is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  var c: string
  var m: string
  var v: string

  start S
  user A
  end E

  on error "PAYMENT_FAILED" (code c, message m) { user R }
  on escalation "LOW_STOCK" (code v) alongside { user Q }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('a handler inside a subprocess is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    user A
    on error "X" { user B }
  }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('a handler nested inside another handler is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" {
    on escalation "Y" { user A }
  }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('a coded handler and a catch-all of the same trigger coexist without a duplicate error', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" { user A }
  on error { user B }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('an explicit start opening a handler body is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" {
    start In
    user A
    end Out
  }
}
`);
    expect(diagnostics).toHaveLength(0);
  });
});

describe('Validation — event handler placement', () => {
  test('a handler nested inside an if block is exactly one placement error', async () => {
    const { diagnostics } = await validate(`
process p {
  if (true) {
    on error "X" { user A }
  }
}
`);
    const errors = diagnosticsFor(diagnostics, 'belongs directly in a process');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a handler directly in a process body has no placement error', async () => {
    const { diagnostics } = await validate(`
process p { on error "X" { user A } }
`);
    expect(
      diagnosticsFor(diagnostics, 'belongs directly in a process'),
    ).toHaveLength(0);
  });
});

describe('Validation — event handler trailing position', () => {
  test('a handler followed by a service task is exactly one trailing error', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" { user A }
  service S { class = "x.Y" }
}
`);
    const errors = diagnosticsFor(diagnostics, 'move it after the last step');
    expect(errors).toHaveLength(1);
  });

  test('a handler followed by another handler has no trailing error', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" { user A }
  on escalation "Y" { user B }
}
`);
    expect(
      diagnosticsFor(diagnostics, 'move it after the last step'),
    ).toHaveLength(0);
  });

  test('a handler after an end event produces no unreachable warning', async () => {
    const { diagnostics } = await validate(`
process p {
  start S
  end Done
  on error "X" { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'can never run')).toHaveLength(0);
  });
});

describe('Validation — event handler alongside and empty code', () => {
  test('`on error … alongside` is an error naming alongside', async () => {
    const { diagnostics } = await validate(`
process p { on error "X" alongside { user A } }
`);
    const errors = diagnosticsFor(diagnostics, 'alongside');
    expect(errors.some((d) => d.severity === SEVERITY_ERROR)).toBe(true);
  });

  test('`on escalation … alongside` produces no interrupting-only error', async () => {
    const { diagnostics } = await validate(`
process p { on escalation "X" alongside { user A } }
`);
    expect(
      diagnosticsFor(diagnostics, 'only available for escalations'),
    ).toHaveLength(0);
  });

  test('an empty code string on `on` is an error teaching catch-all by omission', async () => {
    const { diagnostics } = await validate(`
process p { on error "" { user A } }
`);
    const errors = diagnosticsFor(diagnostics, 'omit the string entirely');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });
});

describe('Validation — event handler duplicates', () => {
  test('two handlers with the same trigger and code is a duplicate error', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" { user A }
  on error "X" { user B }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR).length).toBeGreaterThan(0);
  });

  test('two catch-all handlers of the same trigger is a duplicate error', async () => {
    const { diagnostics } = await validate(`
process p {
  on error { user A }
  on error { user B }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR).length).toBeGreaterThan(0);
  });

  test('a coded handler and the same code marked alongside is still a duplicate error', async () => {
    const { diagnostics } = await validate(`
process p {
  on escalation "X" { user A }
  on escalation "X" alongside { user B }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR).length).toBeGreaterThan(0);
  });
});

describe('Validation — event handler bindings', () => {
  test('two bindings with the same field is a duplicate error', async () => {
    const { diagnostics } = await validate(`
process p { on error "X" (code c, code d) { user A } }
`);
    expect(
      diagnosticsFor(diagnostics, 'Duplicate catch-binding field'),
    ).toHaveLength(1);
  });

  test('a `message` binding on an escalation handler is an error', async () => {
    const { diagnostics } = await validate(`
process p { on escalation "X" (message m) { user A } }
`);
    expect(
      diagnosticsFor(diagnostics, 'carries a code but no message'),
    ).toHaveLength(1);
  });

  test('a binding variable already declared with a conflicting type is an agreement error', async () => {
    const { diagnostics } = await validate(`
process p {
  var c: number
  on error "X" (code c) { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'the types must agree')).toHaveLength(1);
  });

  test('a handler body referencing a binding variable produces no undeclared-variable warning', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" (code c, message m) {
    if (c == "y") { user A }
  }
}
`);
    expect(diagnosticsFor(diagnostics, 'is not declared')).toHaveLength(0);
  });
});

describe('Validation — throw and emit statements', () => {
  test('a statement after `throw error` is flagged unreachable', async () => {
    const { diagnostics } = await validate(`
process p { throw error "X" user Dead }
`);
    expect(diagnosticsFor(diagnostics, 'can never run')).toHaveLength(1);
  });

  test('a goto-targeted named statement after a `throw` stays reachable', async () => {
    const { diagnostics } = await validate(`
process p {
  var cond: boolean
  if (cond) { goto Retry }
  throw error "X"
  user Retry
}
`);
    expect(diagnosticsFor(diagnostics, 'can never run')).toHaveLength(0);
  });

  test('a statement after `emit escalation` produces no unreachable warning', async () => {
    const { diagnostics } = await validate(`
process p { emit escalation "X" user Alive }
`);
    expect(diagnosticsFor(diagnostics, 'can never run')).toHaveLength(0);
  });

  test('`emit error` is a teaching error pointing at `throw error`', async () => {
    const { diagnostics } = await validate(`process p { emit error "X" }`);
    const errors = diagnosticsFor(diagnostics, 'throw error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a task named with the Throw_ or EventSubProcess_ reserved prefix is an error', async () => {
    const throwPrefixed = await validate(`process p { user Throw_p_1 }`);
    expect(
      diagnosticsFor(throwPrefixed.diagnostics, 'reserved synthesised-id'),
    ).toHaveLength(1);

    const eventSubProcessPrefixed = await validate(
      `process p { user EventSubProcess_x }`,
    );
    expect(
      diagnosticsFor(
        eventSubProcessPrefixed.diagnostics,
        'reserved synthesised-id',
      ),
    ).toHaveLength(1);
  });

  test('two throws sharing an authored name is a duplicate-name error', async () => {
    const { diagnostics } = await validate(`
process p {
  throw error Same "X"
  throw escalation Same "Y"
}
`);
    expect(diagnosticsFor(diagnostics, 'ambiguous').length).toBeGreaterThan(0);
  });

  test('a goto targeting a named throw resolves with no unresolved-reference error', async () => {
    const { diagnostics } = await validate(`
process p {
  var cond: boolean
  start S
  if (cond) { goto Failed }
  throw error Failed "X"
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });
});

describe('Validation — error declaration', () => {
  test('a duplicate `error … message …` declaration for the same code is an error', async () => {
    const { diagnostics } = await validate(`
process p {
  error "X" message "A"
  error "X" message "B"
  start S
  end E
}
`);
    expect(
      diagnosticsFor(diagnostics, 'already has a message declared'),
    ).toHaveLength(1);
  });

  test('an empty declaration code is an error', async () => {
    const { diagnostics } = await validate(`
process p { error "" message "m" start S end E }
`);
    expect(diagnosticsFor(diagnostics, 'code cannot be empty')).toHaveLength(1);
  });

  test('a `start` carrying a form block inside a handler body is an error', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" {
    start In { form { a: string } }
    user A
  }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR).length).toBeGreaterThan(0);
  });

  test('an empty handler body is exactly one warning', async () => {
    const { diagnostics } = await validate(`process p { on error "X" { } }`);
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.toLowerCase().includes('no steps'),
    );
    expect(warnings).toHaveLength(1);
  });
});

describe('Validation — soft event words', () => {
  test('an unknown trigger word on `on` is exactly one diagnostic naming all seven kinds', async () => {
    const { diagnostics } = await validate(`process p { on erorr "X" { } }`);
    expect(diagnostics).toHaveLength(1);
    for (const kind of [
      'error',
      'escalation',
      'message',
      'signal',
      'timer',
      'condition',
      'compensation',
    ]) {
      expect(diagnostics[0]!.message).toContain(kind);
    }
  });

  test('an unknown trigger word on `throw` is exactly one diagnostic naming its legal kinds', async () => {
    const { diagnostics } = await validate(`process p { throw banana "X" }`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('error');
    expect(diagnostics[0]!.message).toContain('escalation');
    expect(diagnostics[0]!.message).toContain('signal');
    expect(diagnostics[0]!.message).toContain('compensation');
  });

  test('an unknown trigger word on `emit` is exactly one diagnostic naming its legal kinds', async () => {
    const { diagnostics } = await validate(`process p { emit banana "X" }`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('escalation');
    expect(diagnostics[0]!.message).toContain('signal');
    expect(diagnostics[0]!.message).toContain('compensation');
    expect(diagnostics[0]!.message).not.toContain('error');
  });

  test('an unknown binding field is exactly one diagnostic naming both valid fields', async () => {
    const { diagnostics } = await validate(`
process p { on error "X" (coed c) { user A } }
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('code');
    expect(diagnostics[0]!.message).toContain('message');
  });

  test('an unknown declaration kind is exactly one diagnostic naming the valid kind', async () => {
    const { diagnostics } = await validate(`
process p { banana "X" message "m" start S end E }
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('error');
  });

  test('a variable named `message` coexists with a handler binding field of the same word', async () => {
    const { diagnostics } = await validate(`
process p {
  var message: string
  if (message == "x") { user A }
  on error "X" (message m) { user B }
}
`);
    expect(diagnostics).toHaveLength(0);
  });
});

describe('Validation — trigger near-miss teaching messages', () => {
  test('`emit error` is a teaching error pointing at `throw error`', async () => {
    const { diagnostics } = await validate(`process p { emit error "X" }`);
    expect(diagnosticsFor(diagnostics, 'throw error')).toHaveLength(1);
  });

  test('`throw message` teaches that a message has nothing to send', async () => {
    const { diagnostics } = await validate(`process p { throw message "X" }`);
    expect(diagnosticsFor(diagnostics, 'on message')).toHaveLength(1);
  });

  test('`emit message` teaches the same nothing-to-send lesson', async () => {
    const { diagnostics } = await validate(`process p { emit message "X" }`);
    expect(diagnosticsFor(diagnostics, 'on message')).toHaveLength(1);
  });

  test('`on conditional` is a did-you-mean naming `condition`', async () => {
    const { diagnostics } = await validate(
      `process p { on conditional { user A } }`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('condition');
  });
});

describe('Validation — trigger payload matrix: clean programs', () => {
  test('a name-only `on message` handler is diagnostic-free', async () => {
    const { diagnostics } = await validate(
      `process p { on message "PaymentReceived" { user A } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });

  test('an `on signal … alongside` handler is diagnostic-free', async () => {
    const { diagnostics } = await validate(
      `process p { on signal "Cancelled" alongside { user A } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });

  test('all three timer particles are diagnostic-free', async () => {
    const after = await validate(
      `process p { on timer after "PT1H" { user A } }`,
    );
    expect(after.diagnostics).toHaveLength(0);

    const at = await validate(
      `process p { on timer at "2026-08-01T09:00:00" { user A } }`,
    );
    expect(at.diagnostics).toHaveLength(0);

    const every = await validate(
      `process p { on timer every "R/PT10M" alongside { user A } }`,
    );
    expect(every.diagnostics).toHaveLength(0);
  });

  test('an `on condition` handler with a declared variable is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  on condition (amount > 100) { user A }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('`throw signal`/`emit signal` in a body are diagnostic-free', async () => {
    const thrown = await validate(`process p { start S throw signal "Alert" }`);
    expect(thrown.diagnostics).toHaveLength(0);

    const emitted = await validate(
      `process p { start S emit signal "Ping" user A }`,
    );
    expect(emitted.diagnostics).toHaveLength(0);
  });
});

describe('Validation — trigger payload matrix: violations', () => {
  test('a name-less `on message` is exactly one diagnostic about the message name', async () => {
    const { diagnostics } = await validate(
      `process p { on message { user A } }`,
    );
    expect(diagnosticsFor(diagnostics, "message's name")).toHaveLength(1);
  });

  test('a name-less `on signal` is exactly one diagnostic about the message name', async () => {
    const { diagnostics } = await validate(
      `process p { on signal { user A } }`,
    );
    expect(diagnosticsFor(diagnostics, "message's name")).toHaveLength(1);
  });

  test('a payload-less `on timer` is exactly one diagnostic about reading the time', async () => {
    const { diagnostics } = await validate(`process p { on timer { user A } }`);
    expect(diagnosticsFor(diagnostics, 'read the time')).toHaveLength(1);
  });

  test('a bare STRING on `on timer` (no particle) is the same diagnostic', async () => {
    const { diagnostics } = await validate(
      `process p { on timer "PT1H" { user A } }`,
    );
    expect(diagnosticsFor(diagnostics, 'read the time')).toHaveLength(1);
  });

  test('a condition-less `on condition` is exactly one diagnostic', async () => {
    const { diagnostics } = await validate(
      `process p { on condition { user A } }`,
    );
    expect(diagnosticsFor(diagnostics, 'needs its condition')).toHaveLength(1);
  });

  test('bindings on `on message` are forbidden', async () => {
    const { diagnostics } = await validate(`
process p { on message "X" (code c) { user A } }
`);
    expect(
      diagnosticsFor(diagnostics, 'belong to error and escalation handlers'),
    ).toHaveLength(1);
  });

  test('a condition on `on error` is exactly one diagnostic', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  on error (amount > 100) { user A }
}
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("Only 'on condition'");
  });

  test('a particle on `on signal` is exactly one particle-forbidden diagnostic', async () => {
    const { diagnostics } = await validate(
      `process p { on signal after "PT1H" { user A } }`,
    );
    expect(
      diagnosticsFor(diagnostics, "Only 'on timer' takes a particle"),
    ).toHaveLength(1);
  });

  test('a STRING on `on condition` is exactly one diagnostic (parens still required)', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  on condition "X" (amount > 100) { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'takes no code string')).toHaveLength(1);
  });
});

describe('Validation — timer particle shape and interrupting warnings', () => {
  test('`after "banana"` is a duration-shape warning', async () => {
    const { diagnostics } = await validate(
      `process p { on timer after "banana" { user A } }`,
    );
    const warnings = diagnosticsFor(diagnostics, 'expects a duration');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe(SEVERITY_WARNING);
  });

  test('`after "${dueDate}"` is diagnostic-free (EL passes through)', async () => {
    const { diagnostics } = await validate(
      `process p { on timer after "\${dueDate}" { user A } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });

  test('`at "PT1H"` is a point-in-time-shape warning', async () => {
    const { diagnostics } = await validate(
      `process p { on timer at "PT1H" { user A } }`,
    );
    expect(diagnosticsFor(diagnostics, 'expects a point in time')).toHaveLength(
      1,
    );
  });

  test('`every` on an interrupting handler warns naming `alongside`; `alongside` is clean', async () => {
    const interrupting = await validate(
      `process p { on timer every "R/PT10M" { user A } }`,
    );
    expect(diagnosticsFor(interrupting.diagnostics, 'alongside')).toHaveLength(
      1,
    );

    const nonInterrupting = await validate(
      `process p { on timer every "R/PT10M" alongside { user A } }`,
    );
    expect(
      diagnosticsFor(nonInterrupting.diagnostics, 'fires at most once'),
    ).toHaveLength(0);
  });
});

describe('Validation — handler duplicates (message/signal/timer/condition)', () => {
  test('two `on message` handlers sharing one name is a duplicate error', async () => {
    const { diagnostics } = await validate(`
process p {
  on message "X" { user A }
  on message "X" { user B }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR).length).toBeGreaterThan(0);
  });

  test('`on message "X"` and `on message "Y"` coexist without a duplicate error', async () => {
    const { diagnostics } = await validate(`
process p {
  on message "X" { user A }
  on message "Y" { user B }
}
`);
    expect(diagnosticsFor(diagnostics, 'duplicate catch')).toHaveLength(0);
  });

  test('`on signal "X"` in two different containers is not a duplicate', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    user T
    on signal "X" { user B }
  }
  on signal "X" { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'duplicate catch')).toHaveLength(0);
  });

  test('two `on timer after "PT1H"` handlers in one container are legal', async () => {
    const { diagnostics } = await validate(`
process p {
  on timer after "PT1H" { user A }
  on timer after "PT1H" { user B }
}
`);
    expect(diagnosticsFor(diagnostics, 'duplicate catch')).toHaveLength(0);
  });
});

describe('Validation — condition expression variable checks', () => {
  test('an undeclared variable in an `on condition` expression is the standard warning', async () => {
    const { diagnostics } = await validate(
      `process p { on condition (amount > 100) { user A } }`,
    );
    const warnings = bySeverity(diagnostics, SEVERITY_WARNING).filter((d) =>
      d.message.includes('amount'),
    );
    expect(warnings).toHaveLength(1);
  });

  test('a declared numeric variable in an `on condition` expression is clean', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  on condition (amount > 100) { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'amount')).toHaveLength(0);
  });

  test('a string-typed variable in an `on condition` ordered comparison is the standard type-mismatch error', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: string
  on condition (amount > 100) { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'cannot be used in')).toHaveLength(1);
  });
});

describe('Validation — compensation clean programs', () => {
  test('a subprocess with an `on compensation` block is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    user A
    on compensation { user Undo }
  }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('a process-level `on error` handler with `emit compensation` and a named `throw compensation Undo` is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  user A
  on error "X" {
    emit compensation
    throw compensation Undo
  }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('a variable named `compensation` coexists with the trigger word', async () => {
    const { diagnostics } = await validate(`
process p {
  var compensation: number
  if (compensation > 1) { user A }
}
`);
    expect(diagnostics).toHaveLength(0);
  });
});

describe('Validation — compensation payload matrix', () => {
  test('a STRING on `on compensation` is the omission message', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    on compensation "X" { user A }
  }
}
`);
    expect(diagnosticsFor(diagnostics, 'omit the string')).toHaveLength(1);
  });

  test('bindings on `on compensation` are the no-values message', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    on compensation (code c) { user A }
  }
}
`);
    expect(diagnosticsFor(diagnostics, 'carries no values')).toHaveLength(1);
  });

  test('`alongside` on `on compensation` is the finished-work message', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    on compensation alongside { user A }
  }
}
`);
    expect(
      diagnosticsFor(diagnostics, 'no running flow to run alongside'),
    ).toHaveLength(1);
  });

  test('a particle on `on compensation` fires exactly the inherited particle-forbidden diagnostic', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    on compensation after "PT1H" { user A }
  }
}
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain(
      "Only 'on timer' takes a particle",
    );
  });

  test('a condition on `on compensation` fires exactly the inherited condition-only diagnostic', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  subprocess S {
    on compensation (amount > 100) { user A }
  }
}
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("Only 'on condition'");
  });
});

describe('Validation — compensation placement', () => {
  test('`on compensation` directly in a process body is the undo-block placement error', async () => {
    const { diagnostics } = await validate(`
process p { on compensation { user A } }
`);
    expect(
      diagnosticsFor(diagnostics, 'a process cannot undo itself'),
    ).toHaveLength(1);
  });

  test('`on compensation` inside an `on error` body gets the same placement error', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" {
    on compensation { user A }
  }
}
`);
    expect(
      diagnosticsFor(diagnostics, 'a process cannot undo itself'),
    ).toHaveLength(1);
  });

  test('`on compensation` inside an `if` inside a subprocess is exactly one (inherited) diagnostic', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    if (true) {
      on compensation { user A }
    }
  }
}
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain(
      'belongs directly in a process or subprocess body',
    );
  });

  test('`on compensation` directly inside a subprocess body is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    user A
    on compensation { user Undo }
  }
}
`);
    expect(diagnostics).toHaveLength(0);
  });
});

describe('Validation — compensation duplicates', () => {
  test('two `on compensation` in one subprocess is the merge-the-steps error', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    on compensation { user A }
    on compensation { user B }
  }
}
`);
    expect(diagnosticsFor(diagnostics, 'merge the steps')).toHaveLength(1);
  });

  test('one `on compensation` in each of two different subprocesses is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S1 {
    user A
    on compensation { user U1 }
  }
  subprocess S2 {
    user B
    on compensation { user U2 }
  }
}
`);
    expect(diagnostics).toHaveLength(0);
  });
});

describe('Validation — throw/emit code-required shift', () => {
  test('`throw error` with no code names the shape', async () => {
    const { diagnostics } = await validate(`process p { throw error }`);
    expect(diagnosticsFor(diagnostics, 'throw error "CODE"')).toHaveLength(1);
  });

  test('`emit signal` with no code names the shape (analog)', async () => {
    const { diagnostics } = await validate(`process p { emit signal }`);
    expect(diagnosticsFor(diagnostics, 'emit signal "CODE"')).toHaveLength(1);
  });

  test('`throw escalation ""` gets the same code-required family, reworded', async () => {
    const { diagnostics } = await validate(`process p { throw escalation "" }`);
    expect(
      diagnosticsFor(diagnostics, 'throw escalation "CODE"'),
    ).toHaveLength(1);
    // The old catch-all-by-omission phrasing stays on `on` only.
    expect(diagnosticsFor(diagnostics, 'omit the string entirely')).toHaveLength(
      0,
    );
  });

  test('`throw compensation "X"` is the nothing-to-name message', async () => {
    const { diagnostics } = await validate(
      `process p { throw compensation "X" }`,
    );
    expect(diagnosticsFor(diagnostics, 'nothing to name')).toHaveLength(1);
  });

  test('`throw compensation` in a valid context is diagnostic-free', async () => {
    const { diagnostics } = await validate(`process p { throw compensation }`);
    expect(diagnostics).toHaveLength(0);
  });
});

describe('Validation — compensation unreachable scan', () => {
  test('a statement after `throw compensation` is flagged unreachable', async () => {
    const { diagnostics } = await validate(
      `process p { throw compensation user Dead }`,
    );
    expect(diagnosticsFor(diagnostics, 'can never run')).toHaveLength(1);
  });

  test('a statement after `emit compensation` produces no unreachable warning', async () => {
    const { diagnostics } = await validate(
      `process p { emit compensation user Alive }`,
    );
    expect(diagnosticsFor(diagnostics, 'can never run')).toHaveLength(0);
  });
});

describe('Validation — compensation did-you-mean', () => {
  test('`on compensate` is exactly one diagnostic naming compensation', async () => {
    const { diagnostics } = await validate(
      `process p { on compensate { user A } }`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('compensation');
  });

  test('`throw compensate` is exactly one diagnostic naming compensation', async () => {
    const { diagnostics } = await validate(`process p { throw compensate }`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('compensation');
  });

  test('`emit compensate` is exactly one diagnostic naming compensation', async () => {
    const { diagnostics } = await validate(`process p { emit compensate }`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('compensation');
  });
});

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
