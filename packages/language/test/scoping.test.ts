/**
 * Scoping + reserved-word-guidance test suite for BPMNscript.
 *
 * Four concerns are exercised here, all driven through the real parser/linker
 * pipeline (`parseHelper`, with `{ validation: true }` where cross-reference
 * linking must run):
 *
 *   - **Process-scoped `goto`** (custom `ScopeProvider`): a `goto` resolves to
 *     any named step of its *own* process, including one nested inside a
 *     `parallel`/`if`/`while` block, and to no step of any *other* process.
 *   - **Container-scoped `goto`** (same `ScopeProvider`, narrowed further): a
 *     `goto` resolves only within its nearest enclosing container, the
 *     `process`, `subprocess`, or `on` handler body it directly sits in. A
 *     `subprocess` statement is itself a valid target by name. A cross-boundary
 *     `goto` fails to resolve and the custom `BpmnScriptLinker` replaces the
 *     stock "Could not resolve reference" message with a boundary explanation,
 *     replacing rather than adding, so exactly one diagnostic is emitted. A
 *     handler is named in that message by its header (trigger + code), since it
 *     has no name of its own.
 *   - **Container-scoped host resolution** (same provider and linker): an `on`
 *     handler that names a host activity attaches to it, so the host must be a
 *     step of the handler's own container, with no global fall-through. Such a
 *     handler lowers inline into its host's container rather than into one of
 *     its own, so its body is transparent to the container walk: a `goto`
 *     crosses between the handler body and the main flow in both directions,
 *     while a host-less handler nested inside it stays a boundary of its own.
 *   - **Reserved-word guidance** (custom `ParserErrorMessageProvider`): a
 *     reserved keyword used as a bare identifier yields a parse error that names
 *     the word and points to the quoted `"${...}"` raw-string fallback, instead
 *     of a raw Chevrotain "expected ID" / "no viable alternative" message.
 *
 * Diagnostic severity follows the LSP convention: `1 = Error`, `2 = Warning`.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type {
  GotoStatement,
  Model,
  OnHandler,
  SubProcess,
  UserTask,
} from '@bpmn-script/language';
import { createBpmnScriptServices, isProcess } from '@bpmn-script/language';

const SEVERITY_ERROR = 1;

let services: ReturnType<typeof createBpmnScriptServices>;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ── Process-scoped goto resolution ──────────────────────────────────────────

describe('Scoping — process-scoped goto', () => {
  test('a same-process goto to a top-level step still resolves', async () => {
    const document = await parse(`process p { user Foo goto Foo }`, {
      validation: true,
    });
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const goto = findGoto(document.parseResult.value);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Foo');

    expect(errorsOf(document)).toHaveLength(0);
  });

  test('a goto resolves to a step nested inside a parallel branch of the same process', async () => {
    // The stock (block-lexical) scope makes a step nested in a `parallel` branch
    // invisible to an outside goto, so this resolves only through the
    // process-scoped provider.
    const goto = await gotoIn(`
process p {
  parallel {
    { user A }
    { user B }
  }
  goto A
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('A');
  });

  test('a goto does not resolve to a same-named step in another process', async () => {
    const document = await link(`
process a { user Foo goto Only }
process b { user Only }
`);

    const goto = findGoto(document.parseResult.value);
    // `Only` exists only in process `b`; process-scoped goto cannot reach it.
    expect(goto.target.ref).toBeUndefined();

    const linkerErrors = errorsOf(document).filter((d) =>
      d.message.includes("'Only'"),
    );
    expect(linkerErrors).toHaveLength(1);
  });

  test('a goto resolves within its own process when the name also exists elsewhere', async () => {
    const document = await link(`
process a { user Dup goto Dup }
process b { user Dup }
`);

    const model = document.parseResult.value;
    const processA = model.processes[0]!;
    const goto = findGoto(model);
    expect(goto.target.ref).toBeDefined();
    // The resolved target must live inside process `a`, not the same-named `b`.
    expect(AstUtils.getContainerOfType(goto.target.ref!, isProcess)).toBe(
      processA,
    );
  });

  test('a goto to a name that exists in no process is unresolved (one linker error)', async () => {
    const document = await parse(`process p { user Foo goto Missing }`, {
      validation: true,
    });
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const goto = findGoto(document.parseResult.value);
    expect(goto.target.ref).toBeUndefined();
    const linkerErrors = errorsOf(document).filter((d) =>
      d.message.includes('Missing'),
    );
    expect(linkerErrors).toHaveLength(1);
  });
});

// ── Container-scoped goto across a subprocess boundary ──────────────────────

describe('Scoping — container-scoped goto (subprocess boundary)', () => {
  test('a parent-body goto cannot resolve a step inside a sub-process, but the same name resolves from inside it', async () => {
    const fromOutside = await link(`
process p {
  subprocess Sub {
    user Inner
  }
  goto Inner
}
`);
    expect(findGoto(fromOutside.parseResult.value).target.ref).toBeUndefined();

    const goto = await gotoIn(`
process p {
  subprocess Sub {
    user Inner
    goto Inner
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Inner');
  });

  test('a goto inside a sub-process resolves a sibling step nested inside an if block of the same body', async () => {
    const goto = await gotoIn(`
process p {
  subprocess Sub {
    if (true) {
      user Deep
    }
    goto Deep
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Deep');
  });

  test('a goto inside a sub-process cannot resolve a parent-body step', async () => {
    const goto = await gotoIn(`
process p {
  user Outer
  subprocess Sub {
    goto Outer
  }
}
`);
    expect(goto.target.ref).toBeUndefined();
  });

  test('a parent-body goto resolves a sub-process statement by its own name', async () => {
    const goto = await gotoIn(`
process p {
  subprocess Sub {
    user Inner
  }
  goto Sub
}
`);
    expect(goto.target.ref).toBeDefined();
    expect(goto.target.ref!.$type).toBe('SubProcess');
  });

  test('a goto in an outer sub-process cannot resolve a step inside an inner (nested) sub-process', async () => {
    const goto = await gotoIn(`
process p {
  subprocess Outer {
    subprocess Inner {
      user Deep
    }
    goto Deep
  }
}
`);
    expect(goto.target.ref).toBeUndefined();
  });

  test('boundary message names the sub-process the target is inside, when the goto is outside it (one diagnostic)', async () => {
    const document = await link(`
process p {
  subprocess Sub {
    user Inner
  }
  goto Inner
}
`);

    const errors = errorsOf(document);
    // Exactly one diagnostic on the document: the linker replaces the
    // message rather than a validator stacking a second one on top.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("'Inner'");
    expect(errors[0]!.message).toContain("subprocess 'Sub'");
    expect(errors[0]!.message.toLowerCase()).toContain(
      'cross a sub-process boundary',
    );
  });

  test('boundary message names the sub-process the goto is inside, when the target is outside it (one diagnostic)', async () => {
    const document = await link(`
process p {
  user Outer
  subprocess Sub {
    goto Outer
  }
}
`);

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("'Outer'");
    expect(errors[0]!.message).toContain("subprocess 'Sub'");
    expect(errors[0]!.message.toLowerCase()).toContain(
      'cross a sub-process boundary',
    );
  });

  test('a goto to a name that exists nowhere yields the unchanged generic message (one diagnostic)', async () => {
    const document = await link(`
process p {
  subprocess Sub {
    user Inner
  }
  goto Missing
}
`);
    expect(findGoto(document.parseResult.value).target.ref).toBeUndefined();

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Could not resolve reference to Statement named 'Missing'.",
    );
  });
});

// ── Container-scoped goto across an event-handler boundary ─────────────────

describe('Scoping — container-scoped goto (event-handler boundary)', () => {
  test('a container-body goto cannot resolve a step inside a handler, but the same name resolves from inside it', async () => {
    const fromOutside = await link(`
process p {
  goto Inner
  on error "PAYMENT_FAILED" {
    user Inner
  }
}
`);
    expect(findGoto(fromOutside.parseResult.value).target.ref).toBeUndefined();

    const goto = await gotoIn(`
process p {
  on error "PAYMENT_FAILED" {
    user Inner
    goto Inner
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Inner');
  });

  test('a goto inside a handler resolves a sibling step nested inside an if block of the same body', async () => {
    const goto = await gotoIn(`
process p {
  on error "PAYMENT_FAILED" {
    if (true) {
      user Deep
    }
    goto Deep
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Deep');
  });

  test('a goto inside a handler cannot resolve a step of the enclosing body', async () => {
    const document = await link(`
process p {
  user Outer
  on error "PAYMENT_FAILED" {
    goto Outer
  }
}
`);
    const goto = findGoto(document.parseResult.value);
    expect(goto.target.ref).toBeUndefined();

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("'Outer'");
    expect(errors[0]!.message).toContain(
      `the 'on error "PAYMENT_FAILED"' handler`,
    );
    expect(errors[0]!.message.toLowerCase()).toContain(
      'cross an event handler boundary',
    );
  });

  test('an outer handler goto cannot resolve a step inside a nested (inner) handler', async () => {
    const goto = await gotoIn(`
process p {
  on error "Outer" {
    goto Deep
    on escalation "Inner" {
      user Deep
    }
  }
}
`);
    expect(goto.target.ref).toBeUndefined();
  });

  test('boundary message names the coded handler the target is inside, when the goto is outside it (one diagnostic)', async () => {
    const document = await link(`
process p {
  goto Inner
  on error "PAYMENT_FAILED" {
    user Inner
  }
}
`);

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("'Inner'");
    expect(errors[0]!.message).toContain(
      `the 'on error "PAYMENT_FAILED"' handler`,
    );
    expect(errors[0]!.message.toLowerCase()).toContain(
      'cross an event handler boundary',
    );
    expect(errors[0]!.message.toLowerCase()).not.toContain(
      'sub-process boundary',
    );
  });

  test('boundary message names a catch-all handler without quoting a code', async () => {
    const document = await link(`
process p {
  goto Inner
  on error {
    user Inner
  }
}
`);

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(`an 'on error' handler`);
  });

  test('boundary message names the handler the goto is inside, when the target is outside it (one diagnostic)', async () => {
    const document = await link(`
process p {
  user Outer
  on escalation "LOW_STOCK" {
    goto Outer
  }
}
`);

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("'Outer'");
    expect(errors[0]!.message).toContain(
      `the 'on escalation "LOW_STOCK"' handler`,
    );
    expect(errors[0]!.message.toLowerCase()).toContain(
      'cross an event handler boundary',
    );
  });

  test('a goto to a name that exists nowhere yields the unchanged generic message (one diagnostic)', async () => {
    const document = await link(`
process p {
  goto Missing
  on error "PAYMENT_FAILED" {
    user Inner
  }
}
`);
    expect(findGoto(document.parseResult.value).target.ref).toBeUndefined();

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Could not resolve reference to Statement named 'Missing'.",
    );
  });

  test('a parent-body goto cannot resolve a step inside an `on timer` handler; the boundary message names it by its code-less header', async () => {
    // `on timer after "PT1H"` carries a particle and a time instead of a code,
    // so `handler.code` is undefined, as it is for a catch-all handler.
    // Diagnostics are filtered by target name rather than counted: a
    // trigger-legality check outside this linker's remit may also fire on
    // `timer`.
    const document = await link(`
process p {
  goto Inner
  on timer after "PT1H" {
    user Inner
  }
}
`);
    expect(findGoto(document.parseResult.value).target.ref).toBeUndefined();

    const boundaryErrors = errorsOf(document).filter((d) =>
      d.message.includes("'Inner'"),
    );
    expect(boundaryErrors).toHaveLength(1);
    expect(boundaryErrors[0]!.message).toContain(`an 'on timer' handler`);
    expect(boundaryErrors[0]!.message.toLowerCase()).toContain(
      'cross an event handler boundary',
    );
  });

  test('a goto inside an `on message` handler resolves a sibling step of the same body', async () => {
    const goto = await gotoIn(`
process p {
  on message "Invoice Received" {
    user Inner
    goto Inner
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Inner');
  });

  test('a goto resolves a named throw/emit in the same container', async () => {
    const document = await link(`
process p {
  goto Failed
  goto Ping
  throw error Failed "PAYMENT_FAILED"
  emit escalation Ping "LOW_STOCK"
}
`);

    const gotos = AstUtils.streamAst(document.parseResult.value)
      .filter((node): node is GotoStatement => node.$type === 'GotoStatement')
      .toArray();
    expect(gotos).toHaveLength(2);
    const [toFailed, toPing] = gotos;
    expect(toFailed!.target.ref).toBeDefined();
    expect(toFailed!.target.ref!.$type).toBe('ThrowStatement');
    expect(toPing!.target.ref).toBeDefined();
    expect(toPing!.target.ref!.$type).toBe('EmitStatement');
  });

  test('boundary message names the handler when a goto targets a named throw inside it', async () => {
    // A named throw/emit is a goto target, so a cross-boundary goto to one gets
    // the tailored boundary message rather than the generic "does not exist".
    const document = await link(`
process p {
  goto Failed
  on error "PAYMENT_FAILED" {
    throw error Failed "PAYMENT_FAILED"
  }
}
`);
    expect(findGoto(document.parseResult.value).target.ref).toBeUndefined();

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("'Failed'");
    expect(errors[0]!.message).toContain(
      `the 'on error "PAYMENT_FAILED"' handler`,
    );
    expect(errors[0]!.message.toLowerCase()).toContain(
      'cross an event handler boundary',
    );
  });
});

// ── Container-scoped host resolution for a hosted handler ──────────────────

describe('Scoping — hosted handler host reference', () => {
  test('a host resolves to an activity of the handler’s own container', async () => {
    const document = await link(`
process p {
  user Review
  on Review: timer after "PT2H" { }
}
`);

    const handler = findHostedHandler(document.parseResult.value);
    expect(handler.host!.ref).toBeDefined();
    expect((handler.host!.ref as UserTask).name).toBe('Review');
  });

  test('a host resolves to an activity nested inside an if block of the same container', async () => {
    const document = await link(`
process p {
  if (true) {
    user Deep
  }
  on Deep: message "Cancelled" { }
}
`);

    const handler = findHostedHandler(document.parseResult.value);
    expect(handler.host!.ref).toBeDefined();
    expect((handler.host!.ref as UserTask).name).toBe('Deep');
  });

  test('a host inside a sibling sub-process does not resolve', async () => {
    const document = await link(`
process p {
  subprocess Sub {
    user Inner
  }
  on Inner: error "X" { }
}
`);
    expect(
      findHostedHandler(document.parseResult.value).host!.ref,
    ).toBeUndefined();
  });

  test('a host inside a host-less handler body does not resolve', async () => {
    const document = await link(`
process p {
  user Review
  on error "X" {
    user Inner
  }
  on Inner: message "Cancelled" { }
}
`);
    expect(
      findHostedHandler(document.parseResult.value).host!.ref,
    ).toBeUndefined();
  });

  test('a host that names an activity of another process does not resolve', async () => {
    const document = await link(`
process a {
  user Review
  on Only: signal "Cancelled" { }
}
process b {
  user Only
}
`);
    expect(
      findHostedHandler(document.parseResult.value).host!.ref,
    ).toBeUndefined();
  });

  test('a host resolves against the handler’s container, not the handler’s own body', async () => {
    // A handler is itself a container node, so a scope seeded from the handler
    // rather than from the container around it comes out empty under the
    // transparency rule, leaving the host unresolved.
    const document = await link(`
process p {
  user Review
  on Review: error "X" {
    user Review2
  }
}
`);

    const handler = findHostedHandler(document.parseResult.value);
    const process = document.parseResult.value.processes[0]!;
    expect(handler.host!.ref).toBe(process.body[0]);
  });

  test('a host inside a sub-process resolves to that sub-process’s own step', async () => {
    const document = await link(`
process p {
  user Outer
  subprocess Sub {
    user Review
    on Review: error "X" { }
  }
}
`);

    const handler = findHostedHandler(document.parseResult.value);
    const sub = document.parseResult.value.processes[0]!.body[1] as SubProcess;
    expect(handler.host!.ref).toBe(sub.body.statements[0]);
  });

  test('a host inside a sub-process does not reach a step of the enclosing process', async () => {
    const document = await link(`
process p {
  user Outer
  subprocess Sub {
    user Review
    on Outer: error "X" { }
  }
}
`);
    expect(
      findHostedHandler(document.parseResult.value).host!.ref,
    ).toBeUndefined();

    const errors = errorsOf(document).filter((d) =>
      d.message.includes("'Outer'"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("subprocess 'Sub'");
  });

  test('a cross-container host gets the boundary message, not the generic one', async () => {
    const document = await link(`
process p {
  subprocess Sub {
    user Inner
  }
  on Inner: error "X" { }
}
`);

    const errors = errorsOf(document).filter((d) =>
      d.message.includes("'Inner'"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("subprocess 'Sub'");
    expect(errors[0]!.message.toLowerCase()).toContain(
      'a boundary event attaches to an activity in its own scope',
    );
    expect(errors[0]!.message).not.toContain('Could not resolve reference');
  });

  test('a host that names nothing anywhere keeps the unchanged generic message', async () => {
    const document = await link(`
process p {
  user Review
  on Missing: error "X" { }
}
`);

    const errors = errorsOf(document).filter((d) =>
      d.message.includes('Missing'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "Could not resolve reference to Statement named 'Missing'.",
    );
  });
});

// ── goto across a hosted handler body (transparent container) ──────────────

describe('Scoping — goto through a hosted handler body', () => {
  test('a goto inside a hosted handler body resolves a main-flow step', async () => {
    // A hosted handler lowers inline into its host's container, so its body's
    // steps and the main flow share one container and one sequence-flow scope.
    const goto = await gotoIn(`
process p {
  user Review
  user Next
  on Review: error "X" {
    goto Next
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Next');
  });

  test('a main-flow goto resolves a step inside a hosted handler body', async () => {
    const goto = await gotoIn(`
process p {
  user Review
  goto Fix
  on Review: error "X" {
    user Fix
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Fix');
  });

  test('a hosted handler body inside a sub-process stays isolated from the process body', async () => {
    const document = await link(`
process p {
  user Outer
  subprocess Sub {
    user Review
    on Review: error "X" {
      goto Outer
    }
  }
}
`);

    const goto = findGoto(document.parseResult.value);
    expect(goto.target.ref).toBeUndefined();

    const errors = errorsOf(document).filter((d) =>
      d.message.includes("'Outer'"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("subprocess 'Sub'");
  });

  test('a host-less handler nested in a hosted handler body is still its own container', async () => {
    const document = await link(`
process p {
  user Review
  on Review: error "X" {
    goto Inner
    on escalation "Y" {
      user Inner
    }
  }
}
`);
    expect(findGoto(document.parseResult.value).target.ref).toBeUndefined();
  });
});

// ── Container-scoped goto across a compensation handler boundary ───────────

describe('Scoping — container-scoped goto (compensation handler boundary)', () => {
  test('a subprocess-body goto cannot resolve a step inside its `on compensation` handler; the boundary message names it by its code-less header (one diagnostic)', async () => {
    const document = await link(`
process p {
  subprocess Sub {
    goto Inner
    on compensation {
      user Inner
    }
  }
}
`);
    expect(findGoto(document.parseResult.value).target.ref).toBeUndefined();

    const errors = errorsOf(document);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("'Inner'");
    expect(errors[0]!.message).toContain(`an 'on compensation' handler`);
    expect(errors[0]!.message.toLowerCase()).toContain(
      'cross an event handler boundary',
    );
  });

  test('a goto inside an `on compensation` handler resolves a sibling step of the same body', async () => {
    const goto = await gotoIn(`
process p {
  subprocess Sub {
    on compensation {
      user Inner
      goto Inner
    }
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Inner');
  });

  test('a goto resolves a named `throw compensation` in the same container (code is optional for compensation)', async () => {
    const goto = await gotoIn(`
process p {
  subprocess Sub {
    goto Undo
    throw compensation Undo
  }
}
`);
    expect(goto.target.ref).toBeDefined();
    expect(goto.target.ref!.$type).toBe('ThrowStatement');
  });
});

// ── Reserved-word guidance ──────────────────────────────────────────────────

describe('Scoping — reserved-word guidance', () => {
  test('a reserved word in expression position points to the raw-string fallback', async () => {
    // A reserved word inside a condition is a Chevrotain
    // no-viable-alternative error; the provider enriches it either way.
    const document = await parse(
      `process p { if (date > deadline) { user A } }`,
    );
    const message = parserErrorText(document);

    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
    expect(message).toContain('date');
    expect(message.toLowerCase()).toContain('reserved');
    // Points to the quoted "${...}" raw-string fallback for the offending name.
    expect(message).toContain('"${date}"');
  });

  test('a reserved word in a name position points to the raw-string fallback', async () => {
    // `user <name>` expects exactly ID, a Chevrotain mismatched-token error.
    const document = await parse(`process p { user date }`);
    const message = parserErrorText(document);

    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
    expect(message).toContain('date');
    expect(message.toLowerCase()).toContain('reserved');
    expect(message).toContain('"${date}"');
  });

  test('a non-keyword identifier in the same expression position parses cleanly', async () => {
    const document = await parse(
      `process p { if (status > deadline) { user A } }`,
    );
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The single `goto` of a cleanly parsed and linked `source`. */
async function gotoIn(source: string) {
  return findGoto((await link(source)).parseResult.value);
}

/** Parse `source` with linking enabled, asserting it parses cleanly. */
async function link(source: string) {
  const document = await parse(source, { validation: true });
  expect(document.parseResult.parserErrors).toHaveLength(0);
  return document;
}

/** The (assumed single) `GotoStatement` anywhere in the parsed model. */
function findGoto(model: Model): GotoStatement {
  const goto = AstUtils.streamAst(model).find(
    (node): node is GotoStatement => node.$type === 'GotoStatement',
  );
  if (!goto) {
    throw new Error('Test fixture must contain exactly one goto statement.');
  }
  return goto;
}

/** The (assumed single) `OnHandler` carrying a host anywhere in the model. */
function findHostedHandler(model: Model): OnHandler {
  const handler = AstUtils.streamAst(model).find(
    (node): node is OnHandler =>
      node.$type === 'OnHandler' && (node as OnHandler).host !== undefined,
  );
  if (!handler) {
    throw new Error('Test fixture must contain exactly one hosted handler.');
  }
  return handler;
}

/** All error-severity diagnostics of a built document. */
function errorsOf(document: {
  diagnostics?: Array<{ severity?: number; message: string }>;
}) {
  return (document.diagnostics ?? []).filter(
    (d) => d.severity === SEVERITY_ERROR,
  );
}

/** All parser-error messages of a document, joined for substring assertions. */
function parserErrorText(document: {
  parseResult: { parserErrors: Array<{ message: string }> };
}): string {
  return document.parseResult.parserErrors.map((e) => e.message).join('\n');
}
