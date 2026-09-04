/**
 * Validation test suite for the BPMNscript AST. Each validator family has its
 * own `describe` below.
 *
 * A call activity is checked like a function call at the process boundary: a
 * required `process` (the callee), an optional `binding`/`version` pinning
 * discriminator (mutually exclusive), and `in`/`out` variable mappings (the
 * call's arguments and return values) that must not repeat a target within one
 * direction. An `out` mapping's source is evaluated in the called process, so
 * it is exempt from the caller's undeclared-variable and type-mismatch checks.
 *
 * Diagnostics come from Langium's `validationHelper`, which parses, links, and
 * runs the registered checks. Severity follows the LSP convention: `1 = Error`,
 * `2 = Warning`.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { validationHelper, type ValidationResult } from 'langium/test';
import type { Model } from '@bpmn-script/language';
import { createBpmnScriptServices } from '@bpmn-script/language';
import {
  BLOCK_HOSTS,
  ENGINE_SETTINGS,
  FENCE,
  FORM_HOSTS,
  PARAMETER_HOSTS,
} from './helpers/block-hosts.js';

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
    // No errors: an undeclared variable is only a warning.
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
    // A bare identifier in `assignee` emits the bare text rather than a
    // `${var}` expression, so what makes it a variable reference is the
    // author's intent, not the rendering: a literal user id is written in
    // quotes, which leaves a bareword reading as a variable holding the user
    // to assign.
    const warnings = await warningsIn(
      `process p { user T { assignee = someUndeclared } }`,
    );
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
    // `formKey` values name form ids, not process variables, so the check skips
    // them, same as `class` values.
    const { diagnostics } = await validate(
      `process p { user T { formKey = forms.review } }`,
    );
    expect(diagnosticsFor(diagnostics, 'is not declared')).toHaveLength(0);
  });

  test('a bareword expression value produces no undeclared-variable warning', async () => {
    // `expression` values are an EL binding, not a process variable, so the
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
    const errors = await errorsIn(`
process p {
  var flag: boolean
  if (flag + 1 > 0) { user A }
}
`);
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

  test('the zero-binding error names all four legal attributes', async () => {
    const { diagnostics } = await validate(`process p { service S { } }`);
    const errors = diagnosticsFor(diagnostics, "must declare a 'class'");
    expect(errors).toHaveLength(1);
    for (const key of ['class', 'expression', 'delegate', 'topic']) {
      expect(errors[0]!.message).toContain(key);
    }
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
    // undeclared-variable check must skip attribute-value VarRefs entirely: zero
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

  test('a service task with a topic binding only has no discriminator error', async () => {
    const { diagnostics } = await validate(
      `process p { service S { topic = "shipping" } }`,
    );
    expect(diagnosticsFor(diagnostics, "must declare a 'class'")).toHaveLength(
      0,
    );
    expect(diagnosticsFor(diagnostics, 'more than one binding')).toHaveLength(
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

  test('a script task with an unterminated fence resolves to a clean error, not a crash', async () => {
    const { diagnostics } = await validate(`
process p {
  script total ${FENCE}js
x = 1
}
`);
    const errors = diagnosticsFor(diagnostics, 'malformed or unterminated');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain('total');
    // The uncaught-exception fallback message must not appear.
    expect(
      diagnosticsFor(diagnostics, 'An error occurred during validation'),
    ).toHaveLength(0);
  });
});

// ── goto regression ─────────────────────────────────────────────────────────

describe('Validation — goto reference', () => {
  test('an unresolved goto produces ONLY the linker error, no extra validator diagnostic', async () => {
    const errors = await errorsIn(`process p { user Foo goto Missing }`);
    // Exactly one error, the linker's unresolved-reference error. No custom
    // validator fires on top of it.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Missing');
  });

  test('a resolved goto produces no error', async () => {
    expect(await errorsIn(`process p { user Foo goto Foo }`)).toHaveLength(0);
  });

  test('a goto resolving to a service task with a topic binding produces no error', async () => {
    const { diagnostics } = await validate(`
process p {
  service Ship { topic = "shipping" }
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
  test('a process with an empty body produces an error', async () => {
    const errors = await diagnose(`process empty { }`, 'no flow steps');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a handler-only process body produces an error', async () => {
    const { diagnostics } = await validate(
      `process p { on error "Boom" { end H } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'no flow steps');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a start-only process body produces no no-flow-step error', async () => {
    const { diagnostics } = await validate(`process p { start S }`);
    expect(diagnosticsFor(diagnostics, 'no flow steps')).toHaveLength(0);
  });

  test('a non-empty process produces no no-flow-step error', async () => {
    const { diagnostics } = await validate(`process p { start S end E }`);
    expect(diagnosticsFor(diagnostics, 'no flow steps')).toHaveLength(0);
  });
});

// ── Reserved synthesised-id name check ─────────────────────────────────────

describe('Validation — reserved synthesised-id name', () => {
  test('a start event named with a Gateway_*_split pattern is exactly one error', async () => {
    const errors = await errorsIn(`process p { start Gateway_foo_split }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway_foo_split');
    expect(errors[0]!.message).toContain('reserved');
  });

  test('a user task named with a Gateway_*_join pattern is exactly one error', async () => {
    const errors = await errorsIn(
      `process p { user Gateway_invoice-approval_2_join }`,
    );
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
    // Process `_p` synthesises gateway ids like `Gateway__p_split`, where the
    // segment after `Gateway_` starts with an underscore, which the pattern
    // must still catch.
    const errors = await errorsIn(`process _p { user Gateway__p_split }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway__p_split');
    expect(errors[0]!.message).toContain('reserved');
  });

  test('a user task named with a Gateway_*_loop pattern is exactly one error', async () => {
    const errors = await errorsIn(`process p { user Gateway_p_1_loop }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Gateway_p_1_loop');
  });

  test('a start event named with an id-shaped Flow_<src>_<tgt> pattern is exactly one error', async () => {
    // Only the two-segment form matches synthesised flow ids (Flow_<src>_<tgt>,
    // Flow_<gatewayId>_default). Single-segment names like Flow_Control cannot
    // collide with a SequenceFlow.id and are therefore NOT reserved.
    const errors = await errorsIn(`process p { start Flow_A_B }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Flow_A_B');
  });

  test('a single-segment Flow_Control name is accepted (no diagnostic)', async () => {
    // Flow_Control has only one trailing segment, so it cannot match the
    // synthesised Flow_<src>_<tgt> shape and must NOT be rejected.
    const reservedErrors = await diagnose(
      `process p { user Flow_Control }`,
      'reserved synthesised-id',
    );
    expect(reservedErrors).toHaveLength(0);
  });

  test('a single-segment Flow_State name is accepted (no diagnostic)', async () => {
    // Same rationale as Flow_Control: single-segment names are outside the
    // reserved id-shaped pattern and must be accepted.
    const reservedErrors = await diagnose(
      `process p { user Flow_State }`,
      'reserved synthesised-id',
    );
    expect(reservedErrors).toHaveLength(0);
  });

  test('an end event named with a StartEvent_ prefix is exactly one error', async () => {
    const errors = await errorsIn(`process p { end StartEvent_p }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('StartEvent_p');
  });

  test('a user task named with an EndEvent_ prefix is exactly one error', async () => {
    const errors = await errorsIn(`process p { user EndEvent_p }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('EndEvent_p');
  });

  test('a user task named with a Boundary_X_error pattern is exactly one error', async () => {
    const errors = await errorsIn(`process p { user Boundary_X_error }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Boundary_X_error');
    expect(errors[0]!.message).toContain('reserved');
  });

  test('normal names including Gateway-prefixed ones without suffix produce no error', async () => {
    // GatewayCheck does not end in _split|join|fork|loop, so it is not reserved.
    // MyFlow_Thing lacks the Flow_ prefix (starts with My).
    // Flow_Control, Flow_State are single-segment; cannot match Flow_<src>_<tgt>.
    // StartEventHandler lacks the StartEvent_ prefix (no trailing underscore).
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

  test('a start opening a host-less handler body is legal', async () => {
    const { diagnostics } = await validate(`
process p {
  service A { class = "x.A" }
  on error "PF" { start S  service R { class = "x.R" } }
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });

  test('a start opening a hosted handler body is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  service A { class = "x.A" }
  on A: error "PF" { start S  service R { class = "x.R" } }
}
`);
    const errors = diagnosticsFor(diagnostics, 'cannot open a handler');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain('S');
    // The container-body wording belongs to the other arm and must not fire.
    expect(
      diagnosticsFor(diagnostics, 'must be the first statement'),
    ).toHaveLength(0);
  });
});

// ── Duplicate variable name ─────────────────────────────────────────────────

describe('Validation — duplicate variable name', () => {
  test('two `var` declarations with the same name is exactly one error naming it', async () => {
    const errors = await diagnose(
      `
process p {
  var total: number
  var total: string
  start S
  end E
}
`,
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
    // drops the `label = "..."` attribute, so the attribute is flagged.
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

  test('a topic-bound service task and a script task sharing a name is exactly one ambiguity error', async () => {
    const FENCE = '`' + '`' + '`';
    const { diagnostics } = await validate(`
process p {
  service A { topic = "shipping" }
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
    const errors = await errorsIn(`
process p {
  parallel {
    { user A }
    { user B }
  }
  goto A
}
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('A');
    expect(errors[0]!.message.toLowerCase()).toContain('branch');
  });

  test('a goto from a sibling branch into another branch is exactly one error', async () => {
    const errors = await errorsIn(`
process p {
  parallel {
    { user A goto B }
    { user B }
  }
}
`);
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
    const errors = await errorsIn(
      `process p { start Begin { form { blob: json "Blob" } } }`,
    );
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
    const errors = unreachable(diagnostics);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
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

  test('a step after an all-terminating `if`/`else` is flagged as unreachable, as an error', async () => {
    const { diagnostics } = await validate(
      `process p { if (cond) { end A } else { end B } user Dead }`,
    );
    const errors = unreachable(diagnostics);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a step after an all-terminating `parallel` is flagged as unreachable, as an error', async () => {
    const { diagnostics } = await validate(
      `process p { parallel { { end A } { end B } } user Dead }`,
    );
    const errors = unreachable(diagnostics);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a step after an `if` without `else` stays reachable even when its branch ends', async () => {
    const { diagnostics } = await validate(
      `process p { if (cond) { end A } user Alive }`,
    );
    expect(unreachable(diagnostics)).toHaveLength(0);
  });

  test('a step after a `while` whose body always ends stays reachable', async () => {
    const { diagnostics } = await validate(
      `process p { while (cond) { end A } user Alive }`,
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
  test('an empty subprocess body is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S { }
}
`);
    const errors = diagnosticsFor(diagnostics, 'no flow steps');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a handler-only subprocess body is exactly one error', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S { on error "Boom" { end H } }
}
`);
    const errors = diagnosticsFor(diagnostics, 'no flow steps');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a non-empty subprocess body produces no no-flow-step error', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S { user A }
}
`);
    expect(diagnosticsFor(diagnostics, 'no flow steps')).toHaveLength(0);
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
  // up.
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
    // `amount`/`tax`/`vipFlag` are the caller-scope variables the `in` mappings
    // read, so they must be declared here. `confirmed`, the source of
    // `out shipped = confirmed`, is a callee-scope reference and is left
    // undeclared on purpose.
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
    const errors = await diagnose(
      `process p { call X { process = "p" binding = deployment version = 2 } }`,
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
    // `calleeVar` shares a name with a caller-declared `string` variable, and
    // the source sits two levels deep inside a `Logical` node. That stays
    // diagnostic-free only when the exemption walks the full container chain
    // rather than checking the mapping's direct `source` node alone.
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
  start S
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
  start S
  on error "X" { user A }
  on error { user B }
}
`);
    expect(diagnostics).toHaveLength(0);
  });

  test('an explicit start opening a handler body is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  start S
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
    const { diagnostics } = await validate(
      `process p { start S on erorr "X" { } }`,
    );
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
process p { start S on error "X" (coed c) { user A } }
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
      `process p { start S on conditional { user A } }`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('condition');
  });
});

describe('Validation — trigger payload matrix: clean programs', () => {
  test('a name-only `on message` handler is diagnostic-free', async () => {
    const { diagnostics } = await validate(
      `process p { start S on message "PaymentReceived" { user A } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });

  test('an `on signal … alongside` handler is diagnostic-free', async () => {
    const { diagnostics } = await validate(
      `process p { start S on signal "Cancelled" alongside { user A } }`,
    );
    expect(diagnostics).toHaveLength(0);
  });

  test('all three timer particles are diagnostic-free', async () => {
    const after = await validate(
      `process p { start S on timer after "PT1H" { user A } }`,
    );
    expect(after.diagnostics).toHaveLength(0);

    const at = await validate(
      `process p { start S on timer at "2026-08-01T09:00:00" { user A } }`,
    );
    expect(at.diagnostics).toHaveLength(0);

    const every = await validate(
      `process p { start S on timer every "R/PT10M" alongside { user A } }`,
    );
    expect(every.diagnostics).toHaveLength(0);
  });

  test('an `on condition` handler with a declared variable is diagnostic-free', async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  start S
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
    expect(
      await diagnose(`process p { on message { user A } }`, "message's name"),
    ).toHaveLength(1);
  });

  test('a name-less `on signal` is exactly one diagnostic about the message name', async () => {
    expect(
      await diagnose(`process p { on signal { user A } }`, "message's name"),
    ).toHaveLength(1);
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
  start S
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
      `process p { start S on timer after "\${dueDate}" { user A } }`,
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

// ── Boundary host dimension ─────────────────────────────────────────────────
//
// A hosted handler (`on <Host>: <trigger> { ... }`) compiles to a
// `bpmn:boundaryEvent` instead of an event sub-process. An unresolved host
// never reaches these checks: the scope provider restricts a resolvable `host`
// to a named step of the handler's own container, so it stays a linker
// diagnostic. Only the resolvable illegal kinds, a start/end event and a named
// throw/emit, are exercised here.

describe('Validation — boundary host: compensation has no attached form', () => {
  test('`on <host>: compensation` is the host-forbidden error, naming the undo block', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    user A
    on A: compensation { user Undo }
  }
}
`);
    const errors = diagnosticsFor(diagnostics, 'undo block');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a host-less `on compensation` is unaffected by the host-forbidden rule', async () => {
    const { diagnostics } = await validate(`
process p {
  subprocess S {
    user A
    on compensation { user Undo }
  }
}
`);
    expect(diagnosticsFor(diagnostics, 'cannot attach to a host')).toHaveLength(
      0,
    );
  });
});

describe('Validation — boundary host: must be an activity', () => {
  test('a host naming a start event is exactly one "must attach to an activity" error', async () => {
    const errors = await diagnose(
      `
process p {
  start S
  on S: error "X" { user A }
}
`,
      'can only attach to an activity',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('a start event');
  });

  test('a host naming an emit statement names it as an emit', async () => {
    const errors = await diagnose(
      `
process p {
  user A
  emit signal Sig "S"
  on Sig: error "X" { user B }
}
`,
      'can only attach to an activity',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('an emit statement');
  });

  test('a host naming an end event is exactly one "must attach to an activity" error', async () => {
    const errors = await diagnose(
      `
process p {
  start S
  end E
  on E: error "X" { user A }
}
`,
      'can only attach to an activity',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('an end event');
  });

  test('a host naming a named throw statement is exactly one "must attach to an activity" error', async () => {
    const errors = await diagnose(
      `
process p {
  throw error Foo "PAYMENT_FAILED"
  on Foo: escalation { user A }
}
`,
      'can only attach to an activity',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('a throw statement');
  });

  test('a host naming a user/service/script/subprocess/call activity is clean', async () => {
    const FENCE = '`' + '`' + '`';
    const cases = [
      `process p { user U on U: error "X" { user A } }`,
      `process p { service Svc { class = "x.Y" } on Svc: error "X" { user A } }`,
      `process p { service Ext { topic = "t" } on Ext: error "X" { user A } }`,
      `process p {
  script Scr ${FENCE}js
x = 1
${FENCE}
  on Scr: error "X" { user A }
}`,
      `process p { subprocess Sub { user X } on Sub: error "X" { user A } }`,
      `process p { call C { process = "p" } on C: error "X" { user A } }`,
    ];
    for (const src of cases) {
      const { diagnostics } = await validate(src);
      expect(
        diagnosticsFor(diagnostics, 'can only attach to an activity'),
        `src: ${src}`,
      ).toHaveLength(0);
      // `validationHelper` folds parser errors into the same list, so a
      // fixture that stopped parsing would satisfy the assertion above.
      expect(
        bySeverity(diagnostics, SEVERITY_ERROR),
        `src: ${src}`,
      ).toHaveLength(0);
    }
  });
});

describe('Validation — boundary host: escalation host restriction', () => {
  test('an escalation on a service task is exactly one restriction error', async () => {
    const errors = await diagnose(
      `
process p {
  service Pack { class = "x.Y" }
  on Pack: escalation { user A }
}
`,
      'can only attach to a subprocess, a call, or a user task',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('a service task');
  });

  test('an escalation on a script task is exactly one restriction error', async () => {
    const FENCE = '`' + '`' + '`';
    const errors = await diagnose(
      `
process p {
  script Pack ${FENCE}js
x = 1
${FENCE}
  on Pack: escalation { user A }
}
`,
      'can only attach to a subprocess, a call, or a user task',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('a script task');
  });

  test('an escalation on a subprocess, a call, or a user task is clean', async () => {
    const cases = [
      `process p { subprocess Sub { user X } on Sub: escalation { user A } }`,
      `process p { call C { process = "p" } on C: escalation { user A } }`,
      `process p { user U on U: escalation { user A } }`,
    ];
    for (const src of cases) {
      const { diagnostics } = await validate(src);
      expect(
        diagnosticsFor(
          diagnostics,
          'can only attach to a subprocess, a call, or a user task',
        ),
        `src: ${src}`,
      ).toHaveLength(0);
      // `validationHelper` folds parser errors into the same list, so a
      // fixture that stopped parsing would satisfy the assertion above.
      expect(
        bySeverity(diagnostics, SEVERITY_ERROR),
        `src: ${src}`,
      ).toHaveLength(0);
    }
  });
});

describe('Validation — boundary host: self-attachment', () => {
  test('a handler hosted on a step of its own body is exactly one self-attachment error', async () => {
    const { diagnostics } = await validate(`
process p {
  user A
  on Self: error "X" { user Self }
}
`);
    const errors = diagnosticsFor(diagnostics, 'its own escape path');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a handler hosted on a step of a DIFFERENT handler’s escape path is clean', async () => {
    const { diagnostics } = await validate(`
process p {
  user A
  on A: error "X" { user Relay }
  on Relay: escalation "Y" { user B }
}
`);
    expect(diagnosticsFor(diagnostics, 'its own escape path')).toHaveLength(0);
  });
});

describe('Validation — boundary host: duplicates', () => {
  test('two hosted handlers on the same host with the same code is a duplicate error naming the host', async () => {
    const { diagnostics } = await validate(`
process p {
  user Pack
  on Pack: error "X" { user A }
  on Pack: error "X" { user B }
}
`);
    const errors = diagnosticsFor(diagnostics, "attached to 'Pack'");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('the same trigger and code on two DIFFERENT hosts is not a duplicate', async () => {
    const { diagnostics } = await validate(`
process p {
  user Pack1
  user Pack2
  on Pack1: error "X" { user A }
  on Pack2: error "X" { user B }
}
`);
    expect(diagnosticsFor(diagnostics, 'duplicate catch')).toHaveLength(0);
  });

  test('a hosted and a host-less handler sharing a trigger and code is not a duplicate', async () => {
    const { diagnostics } = await validate(`
process p {
  user Pack
  on error "X" { user A }
  on Pack: error "X" { user B }
}
`);
    expect(diagnosticsFor(diagnostics, 'duplicate catch')).toHaveLength(0);
  });

  test('two hosted timers on one host are legal (timer stays exempt)', async () => {
    const { diagnostics } = await validate(`
process p {
  user Pack
  on Pack: timer after "PT1H" { user A }
  on Pack: timer after "PT2H" { user B }
}
`);
    expect(diagnosticsFor(diagnostics, 'duplicate catch')).toHaveLength(0);
  });

  test('a handler nested inside a hosted handler body still collides with the outer one', async () => {
    // Both lower into the process container as a boundary event on `A` with
    // the same message subscription; the nesting is syntactic only.
    const { diagnostics } = await validate(`
process p {
  user A
  on A: message "M" {
    user B
    on A: message "M" { user C }
  }
}
`);
    const errors = diagnosticsFor(diagnostics, 'duplicate catch');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
    expect(errors[0]!.message).toContain("attached to 'A'");
  });

  test('a handler whose host does not resolve reports only the resolution error', async () => {
    const { diagnostics } = await validate(`
process p {
  start S
  on message "M" { user A }
  on Missing: message "M" { user B }
}
`);
    expect(diagnosticsFor(diagnostics, 'duplicate catch')).toHaveLength(0);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(1);
  });
});

describe('Validation — boundary host: regression for host-less programs', () => {
  test('a host-less duplicate-handler diagnostic is byte-identical to the pre-boundary wording', async () => {
    const { diagnostics } = await validate(`
process p {
  on error "X" { user A }
  on error "X" { user B }
}
`);
    const errors = diagnosticsFor(diagnostics, 'duplicate catch');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Another 'on error' handler in this scope already catches code 'X'; " +
        'a duplicate catch is ambiguous to the engine.',
    );
  });

  test('`on error … alongside` still fires the pre-existing interrupting-only message when hosted', async () => {
    const errors = await diagnose(
      `
process p { user Pack on Pack: error "X" alongside { user A } }
`,
      'only available for escalations',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe(SEVERITY_ERROR);
  });

  test('a fully host-less program is diagnostic-free (no boundary machinery fires)', async () => {
    const { diagnostics } = await validate(`
process p {
  var c: string
  start S
  user A
  end E
  on error "X" (code c) { user R }
  on escalation "Y" alongside { user Q }
}
`);
    expect(diagnostics).toHaveLength(0);
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
    start In
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
    start In
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
    expect(diagnosticsFor(diagnostics, 'throw escalation "CODE"')).toHaveLength(
      1,
    );
    // The catch-all-by-omission phrasing belongs to `on` only.
    expect(
      diagnosticsFor(diagnostics, 'omit the string entirely'),
    ).toHaveLength(0);
  });

  test('`throw compensation "X"` is the nothing-to-name message', async () => {
    expect(
      await diagnose(`process p { throw compensation "X" }`, 'nothing to name'),
    ).toHaveLength(1);
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
      `process p { start S on compensate { user A } }`,
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

describe('Validation — await trigger: accepted catch kinds', () => {
  test('`await message "M"` validates with zero error diagnostics', async () => {
    expect(await errorsIn(`process p { await message "M" }`)).toHaveLength(0);
  });

  test('`await timer after "PT1H"` validates with zero error diagnostics', async () => {
    expect(
      await errorsIn(`process p { await timer after "PT1H" }`),
    ).toHaveLength(0);
  });

  test('`await signal "S"` validates with zero error diagnostics', async () => {
    expect(await errorsIn(`process p { await signal "S" }`)).toHaveLength(0);
  });

  test('`await condition (x > 1)` validates with zero error diagnostics', async () => {
    const { diagnostics } = await validate(`
process p {
  var x: number
  await condition (x > 1)
}
`);
    expect(bySeverity(diagnostics, SEVERITY_ERROR)).toHaveLength(0);
  });
});

describe('Validation — await trigger: rejects non-catchable triggers', () => {
  test('`await error "E"` names the legal catch triggers and the throw/emit alternative', async () => {
    const errors = await errorsIn(`process p { await error "E" }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('message');
    expect(errors[0]!.message).toContain('timer');
    expect(errors[0]!.message).toContain('signal');
    expect(errors[0]!.message).toContain('condition');
    expect(errors[0]!.message).toContain('throw');
  });

  test('`await escalation "E"` names the legal catch triggers and the throw/emit alternative', async () => {
    const errors = await errorsIn(`process p { await escalation "E" }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('emit');
  });

  test('`await compensation` names the legal catch triggers and the undo-block alternative', async () => {
    const errors = await errorsIn(`process p { await compensation }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('undo block');
  });
});

describe('Validation — await trigger: rejects unknown words', () => {
  test('`await frobnicate "x"` is an options-naming diagnostic', async () => {
    const errors = await errorsIn(`process p { await frobnicate "x" }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('message');
    expect(errors[0]!.message).toContain('condition');
  });
});

describe('Validation — await trigger: rejects missing payload', () => {
  test('`await message` (no name) describes the missing name', async () => {
    const { diagnostics } = await validate(`process p { await message }`);
    expect(diagnosticsFor(diagnostics, "message's name")).toHaveLength(1);
  });

  test('`await signal` (no name) describes the missing name', async () => {
    const { diagnostics } = await validate(`process p { await signal }`);
    expect(diagnosticsFor(diagnostics, "message's name")).toHaveLength(1);
  });

  test('`await timer` (no particle/time) describes the missing time payload', async () => {
    const { diagnostics } = await validate(`process p { await timer }`);
    expect(diagnosticsFor(diagnostics, 'read the time')).toHaveLength(1);
  });

  test('`await condition` (no parens) describes the missing condition', async () => {
    const { diagnostics } = await validate(`process p { await condition }`);
    expect(diagnosticsFor(diagnostics, 'needs its condition')).toHaveLength(1);
  });
});

describe('Validation — await trigger: rejects payload on the wrong shape', () => {
  test('a particle on `await message` is a particle-forbidden diagnostic', async () => {
    const { diagnostics } = await validate(
      `process p { await message after "PT1H" }`,
    );
    expect(
      diagnosticsFor(diagnostics, "Only 'await timer' takes a particle"),
    ).toHaveLength(1);
  });

  test('a condition expression on `await message` is a condition-forbidden diagnostic', async () => {
    expect(
      await diagnose(
        `
process p {
  var x: number
  await message "M" (x > 1)
}
`,
        "Only 'await condition' takes a condition expression",
      ),
    ).toHaveLength(1);
  });

  test('a code string on `await condition` is a code-forbidden diagnostic (parens still required)', async () => {
    const { diagnostics } = await validate(`
process p {
  var x: number
  await condition "X" (x > 1)
}
`);
    expect(diagnosticsFor(diagnostics, 'takes no code string')).toHaveLength(1);
  });

  test('an unknown timer particle on `await timer` names the legal particles', async () => {
    const errors = await errorsIn(`process p { await timer foo "PT1H" }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('after');
    expect(errors[0]!.message).toContain('at');
    expect(errors[0]!.message).toContain('every');
  });
});

// ── Attribute blocks: engine settings, own keys, parameters, listeners ──────

describe('Validation — engine settings on every attribute block', () => {
  test.each(BLOCK_HOSTS)(
    'the engine settings are accepted on %s',
    async (_kind, _description, program) => {
      expect(await errorsIn(program(ENGINE_SETTINGS))).toHaveLength(0);
    },
  );

  test.each(BLOCK_HOSTS)(
    'an unknown key on %s is exactly one error naming the element kind',
    async (_kind, description, program) => {
      const errors = await errorsIn(program('wibble = 1'));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(
        `Attribute 'wibble' is not valid on ${description}.`,
      );
    },
  );
});

describe('Validation — element-owned attribute keys', () => {
  test.each([
    [
      'a user task',
      `process p { user U { assignee = "demo" formKey = "f" candidateGroups = "approvers" candidateUsers = "ada" dueDate = "2026-09-01T09:00:00" followUpDate = "2026-08-30T09:00:00" priority = 10 } }`,
    ],
    [
      'a service task',
      `process p { service V { class = com.example.X resultVariable = "outcome" } }`,
    ],
    [
      'a script task',
      `process p { script T { resultVariable = "total" } ${FENCE}js\n1 + 1\n${FENCE} }`,
    ],
    [
      'a version-pinned call',
      `process p { call C { process = "q" version = 1 businessKey = "k" } }`,
    ],
    [
      'a binding-pinned call',
      `process p { call C { process = "q" binding = latest } }`,
    ],
  ])('%s accepts the keys it owns', async (_kind, program) => {
    expect(await errorsIn(program)).toHaveLength(0);
  });

  test.each([
    ['resultVariable', `process p { user U { resultVariable = "r" } }`],
    ['businessKey', `process p { user U { businessKey = "k" } }`],
    ['assignee', `process p { subprocess S { assignee = "a" } { user U } }`],
    ['topic', `process p { start S end E { topic = "t" } }`],
  ])(
    "'%s' on an element that does not own it is an allowed-key error",
    async (key, program) => {
      const { diagnostics } = await validate(program);
      const errors = diagnosticsFor(diagnostics, 'is not valid on');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain(key);
    },
  );

  test('a service task keeps its exactly-one-binding rule now that other keys share the block', async () => {
    // `resultVariable` and the engine settings are legal but bind nothing, so a
    // block holding only those is still a service task with no binding.
    const errors = await errorsIn(
      `process p { service V { resultVariable = "r" asyncBefore = true } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("must declare a 'class'");
  });

  // `call` is absent from both lists: its body has no `form` member at all, so
  // a form written there is a parse error rather than this diagnostic.
  test.each(
    BLOCK_HOSTS.filter(([kind]) => !FORM_HOSTS.has(kind) && kind !== 'call'),
  )(
    'a form block on %s is exactly one error naming the element kind',
    async (_kind, description, program) => {
      const errors = await errorsIn(program('form { a: number }'));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(
        `${description[0]!.toUpperCase()}${description.slice(1)} cannot declare a 'form' block; ` +
          'forms belong on start events and user tasks.',
      );
    },
  );

  test.each(BLOCK_HOSTS.filter(([kind]) => FORM_HOSTS.has(kind)))(
    'a form block is accepted on %s',
    async (_kind, _description, program) => {
      expect(await errorsIn(program('form { a: number }'))).toHaveLength(0);
    },
  );
});

// ── Input/output parameters ─────────────────────────────────────────────────

/** The diagnostic an empty map-entry key produces, at any nesting depth. */
const EMPTY_MAP_KEY_ERROR =
  "A map entry's key cannot be empty; name the key its value is looked up by.";

describe('Validation — input/output parameters', () => {
  test.each(BLOCK_HOSTS.filter(([kind]) => PARAMETER_HOSTS.has(kind)))(
    'input and output parameters are accepted on %s',
    async (_kind, _description, program) => {
      expect(
        await errorsIn(program('input a = 1 output b = "two"')),
      ).toHaveLength(0);
    },
  );

  test.each(BLOCK_HOSTS.filter(([kind]) => !PARAMETER_HOSTS.has(kind)))(
    'a parameter on %s is exactly one error naming the element kind',
    async (_kind, description, program) => {
      const errors = await errorsIn(program('input a = 1'));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(
        `${description[0]!.toUpperCase()}${description.slice(1)} cannot declare an 'input' or 'output' parameter; ` +
          'parameters belong on a user task, a service task, a script task, ' +
          "a subprocess, a call, and an 'on' handler with no host.",
      );
    },
  );

  test('an unrecognised direction word names the two legal ones', async () => {
    const errors = await errorsIn(`process p { user U { inp a = 1 } }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Unknown parameter direction 'inp'; write 'input' or 'output'.",
    );
  });

  test('a repeated name within one direction is exactly one error', async () => {
    const errors = await errorsIn(
      `process p { user U { input a = 1 input a = 2 } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("Duplicate 'input' parameter 'a'.");
  });

  test('the two directions are independent namespaces', async () => {
    expect(
      await errorsIn(`process p { user U { input a = 1 output a = 2 } }`),
    ).toHaveLength(0);
  });

  test('a list, a map, and an inline script are accepted as parameter values', async () => {
    expect(
      await errorsIn(
        `process p { service V { topic = "t" input items = [1, 2] input rows = { k: "v" } input computed = ${FENCE}groovy\n1 + 1\n${FENCE} } }`,
      ),
    ).toHaveLength(0);
  });

  test('an empty map key is exactly one error saying what to write', async () => {
    const errors = await errorsIn(
      `process p { user U { input m = { "": "empty" } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(EMPTY_MAP_KEY_ERROR);
  });

  test('an empty map key is reached through a nested list and map', async () => {
    const errors = await errorsIn(
      `process p { user U { input m = { rows: [{ cells: { "": 1 } }] } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(EMPTY_MAP_KEY_ERROR);
  });

  test('a key holding a quote, a brace, a newline, or non-ASCII text is accepted', async () => {
    expect(
      await errorsIn(
        `process p { user U { input m = { "say \\"hi\\"": 1, "{ braces }": 2, "two
lines": 3, "Grüße 日本": 4 } } }`,
      ),
    ).toHaveLength(0);
  });
});

// ── Listeners ───────────────────────────────────────────────────────────────

describe('Validation — listeners', () => {
  test.each(BLOCK_HOSTS)(
    'an execution listener is accepted on %s',
    async (_kind, _description, program) => {
      expect(
        await errorsIn(program('on start { class = "com.example.L" }')),
      ).toHaveLength(0);
    },
  );

  test('every task-listener event is accepted on a user task', async () => {
    expect(
      await errorsIn(`
process p {
  user U {
    on create { class = "com.example.A" }
    on assign { expression = "\${bean.assign(task)}" }
    on complete { delegate = "\${listenerBean}" }
    on update ${FENCE}groovy
    log(task)
    ${FENCE}
    on delete { class = "com.example.D" }
    on timeout after "PT8H" { class = "com.example.T" }
  }
}
`),
    ).toHaveLength(0);
  });

  test('a task-listener event on a service task says only a user task has one', async () => {
    const errors = await errorsIn(
      `process p { service V { topic = "t" on create { class = "com.example.C" } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "'on create' is a task listener, which only a user task has; " +
        "a service task takes 'start' or 'end'.",
    );
  });

  test('an unknown event word lists both sets on a user task', async () => {
    const errors = await errorsIn(
      `process p { user U { on wibble { class = "com.example.C" } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Unknown listener event 'wibble'; write 'start', 'end', 'create', " +
        "'assign', 'complete', 'update', 'delete', or 'timeout'.",
    );
  });

  test('an unknown event word lists only the execution events elsewhere', async () => {
    const errors = await errorsIn(
      `process p { subprocess S { on wibble { class = "com.example.C" } } { user U } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Unknown listener event 'wibble'; write 'start' or 'end'.",
    );
  });

  test('a listener with no binding is exactly one error', async () => {
    const errors = await errorsIn(`process p { user U { on start { } } }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "The 'on start' listener must declare a 'class', 'expression', or " +
        "'delegate' attribute, or a fenced script body.",
    );
  });

  test('a listener with two bindings is exactly one error naming both', async () => {
    const errors = await errorsIn(
      `process p { user U { on start { class = "com.example.C" delegate = "\${bean}" } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('more than one binding');
    expect(errors[0]!.message).toContain('class, delegate');
  });

  test('a key that binds nothing is rejected inside a listener block', async () => {
    const { diagnostics } = await validate(
      `process p { user U { on start { topic = "t" } } }`,
    );
    const errors = diagnosticsFor(diagnostics, 'is not valid on');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Attribute 'topic' is not valid on a listener.",
    );
  });

  test('a timeout listener without a timer asks for the particle clause', async () => {
    const errors = await errorsIn(
      `process p { user U { on timeout { class = "com.example.T" } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('A timer needs to know how to read');
  });

  test('a timer on any other event is exactly one error', async () => {
    const errors = await errorsIn(
      `process p { user U { on create after "PT1H" { class = "com.example.C" } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("Only 'on timeout' takes a particle.");
  });

  test('an unknown particle on a timeout listener names the legal ones', async () => {
    const errors = await errorsIn(
      `process p { user U { on timeout whenever "PT1H" { class = "com.example.T" } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Unknown timer particle 'whenever'; write 'after', 'at', or 'every'.",
    );
  });

  test('a repeated event on one element is exactly one error', async () => {
    const errors = await errorsIn(
      `process p { user U { on start { class = "com.example.A" } on start { class = "com.example.B" } } }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("Duplicate 'on start' listener.");
  });

  test("a script binding follows the script task's fence rules", async () => {
    const unsupported = await errorsIn(
      `process p { user U { on start ${FENCE}php\necho 1;\n${FENCE} } }`,
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.message).toContain(
      "The 'on start' listener has an unsupported language tag 'php'.",
    );

    const empty = await errorsIn(
      `process p { user U { on start ${FENCE}groovy\n${FENCE} } }`,
    );
    expect(empty).toHaveLength(1);
    expect(empty[0]!.message).toBe(
      "The 'on start' listener has an empty script body.",
    );
  });
});

// ── Process-header attributes ───────────────────────────────────────────────

describe('Validation — process header attributes', () => {
  test('any other key in the header is exactly one error', async () => {
    const errors = await errorsIn(`process p { wibble = "x" start S }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Attribute 'wibble' is not valid on a process header.",
    );
  });

  test('an engine setting is rejected in the header', async () => {
    const errors = await errorsIn(`process p { asyncBefore = true start S }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('asyncBefore');
  });

  test('a repeated header key is exactly one error', async () => {
    const errors = await errorsIn(
      `process p { versionTag = "1.0.0" versionTag = "2.0.0" start S }`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("Duplicate attribute 'versionTag'.");
  });
});

// ── Barewords in engine-side attribute values ───────────────────────────────

describe('Validation — barewords in engine-side attribute values', () => {
  test.each([
    ['candidateGroups', `process p { user U { candidateGroups = approvers } }`],
    ['candidateUsers', `process p { user U { candidateUsers = approvers } }`],
    ['dueDate', `process p { user U { dueDate = approvers } }`],
    ['followUpDate', `process p { user U { followUpDate = approvers } }`],
    ['retryCycle', `process p { user U { retryCycle = approvers } }`],
    [
      'resultVariable',
      `process p { service V { topic = "t" resultVariable = approvers } }`,
    ],
  ])(
    "a bareword in '%s' lowers to a literal, so it is not a variable reference",
    async (_key, program) => {
      const { diagnostics } = await validate(program);
      expect(diagnosticsFor(diagnostics, 'is not declared')).toHaveLength(0);
    },
  );

  test('a bareword identity id stays clean, since the engine uses it as written', async () => {
    // The id reaches Operaton verbatim and resolves, so the quoted spelling is
    // a convention rather than the only working form.
    for (const key of ['candidateGroups', 'candidateUsers']) {
      expect(
        await errorsIn(`process p { user U { ${key} = approvers } }`),
        key,
      ).toEqual([]);
    }
  });

  test.each([
    ['priority', `process p { user U { priority = deadline } }`],
    ['jobPriority', `process p { user U { jobPriority = deadline } }`],
    [
      'businessKey',
      `process p { call C { process = "q" businessKey = deadline } }`,
    ],
  ])(
    "a bareword in '%s' lowers to an expression, so it warns when undeclared",
    async (_key, program) => {
      const warnings = await warningsIn(program);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain("Variable 'deadline'");
    },
  );
});

// ── Attribute value shapes ──────────────────────────────────────────────────

describe('Validation — attribute value shapes', () => {
  const BOOLEAN_KEYS = ['asyncBefore', 'asyncAfter', 'exclusive'] as const;

  test('a boolean attribute accepts either unquoted boolean', async () => {
    for (const key of BOOLEAN_KEYS) {
      expect(
        await errorsIn(`process p { user U { ${key} = true } }`),
        key,
      ).toEqual([]);
      expect(
        await errorsIn(`process p { user U { ${key} = false } }`),
        key,
      ).toEqual([]);
    }
  });

  test.each(BOOLEAN_KEYS)(
    'a quoted boolean in %s is one error naming the unquoted form',
    async (key) => {
      const errors = await errorsIn(`process p { user U { ${key} = "true" } }`);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(
        `Attribute '${key}' takes an unquoted boolean; ` +
          `write '${key} = true' or '${key} = false'.`,
      );
    },
  );

  test.each([
    ['a number', `process p { user U { asyncBefore = 1 } }`],
    ['a bareword', `process p { user U { asyncBefore = flag } }`],
    ['an expression', `process p { user U { asyncBefore = "\${flag}" } }`],
  ])(
    '%s in a boolean attribute is one error, since the lowering drops it',
    async (_shape, program) => {
      const errors = await errorsIn(program);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('takes an unquoted boolean');
    },
  );

  /** The same value written into every attribute that takes engine-side text. */
  const textKeyPrograms = (
    value: string,
  ): ReadonlyArray<[key: string, program: string]> => [
    ['versionTag', `process p { versionTag = ${value} start S }`],
    ['retryCycle', `process p { user U { retryCycle = ${value} } }`],
    ['dueDate', `process p { user U { dueDate = ${value} } }`],
    ['followUpDate', `process p { user U { followUpDate = ${value} } }`],
  ];

  test.each(textKeyPrograms('"text"'))(
    '%s accepts a quoted string',
    async (_key, program) => {
      expect(await errorsIn(program)).toEqual([]);
    },
  );

  test.each(textKeyPrograms('"${supplied}"'))(
    '%s accepts a raw expression',
    async (_key, program) => {
      expect(await errorsIn(program)).toEqual([]);
    },
  );

  test.each(textKeyPrograms('3'))(
    'a number in %s is one error asking for quotes',
    async (key, program) => {
      const errors = await errorsIn(program);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(
        `Attribute '${key}' takes a quoted string or a "\${...}" expression; ` +
          'put the value in quotes.',
      );
    },
  );

  test.each(textKeyPrograms('deadline'))(
    'a bareword in %s is one error asking for quotes',
    async (_key, program) => {
      const errors = await errorsIn(program);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('put the value in quotes');
    },
  );

  test('an expression in a numeric attribute carries no value-shape rule', async () => {
    expect(
      await errorsIn(`process p { user U { jobPriority = "\${weight}" } }`),
    ).toEqual([]);
  });

  test('a key the element does not own is reported once, not twice', async () => {
    const errors = await errorsIn(`process p { start S { dueDate = 3 } }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('is not valid on');
  });
});

/** Validate `source` and return the diagnostics whose message contains `needle`. */
async function diagnose(source: string, needle: string) {
  const { diagnostics } = await validate(source);
  return diagnosticsFor(diagnostics, needle);
}

/** Validate `source` and return its error diagnostics. */
async function errorsIn(source: string) {
  const { diagnostics } = await validate(source);
  return bySeverity(diagnostics, SEVERITY_ERROR);
}

/** Validate `source` and return its warning diagnostics. */
async function warningsIn(source: string) {
  const { diagnostics } = await validate(source);
  return bySeverity(diagnostics, SEVERITY_WARNING);
}

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
