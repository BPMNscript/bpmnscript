/**
 * Parsing test suite for the BPMNscript grammar.
 *
 * The surface is code-like: a `process` body is a sequence of statements
 * executed top-to-bottom (implicit sequence flow); control flow is `if`/
 * `else if`/`else`, `while`, `do … while`, `parallel { { } { } }`, and
 * `goto <id>`. Conditions and attribute values are an embedded JUEL-subset
 * expression sub-language parsed to a real AST (never an opaque string).
 *
 * These tests drive the grammar in isolation with Langium's `parseHelper`
 * (and the shared document builder where cross-reference linking must run,
 * e.g. `goto`). They cover the grammar surface plus the Langium-4 edge cases
 * (keyword-vs-ID in expression position, cross-reference scoping for goto,
 * parser-rule expressions, attribute-key vs identifier disambiguation,
 * duplicate attribute keys visible in the AST).
 *
 * Validation-level checks (undeclared variables, duplicate-key *errors*,
 * type mismatches) live in the validator suite.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { parseHelper } from 'langium/test';
import type {
  Model,
  IfStatement,
  WhileStatement,
  DoWhileStatement,
  ParallelStatement,
  GotoStatement,
  UserTask,
  ServiceTask,
  Relational,
  VarRef,
  Ternary,
  RawExpr,
  VarDecl,
  ProcessLabel,
} from '@bpmn-script/language';
import {
  createBpmnScriptServices,
  isModel,
  renderExpression,
} from '@bpmn-script/language';

let services: ReturnType<typeof createBpmnScriptServices>;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ── 1. Structured process parses zero-error ─────────────────────────────────

describe('Parsing — structured process', () => {
  test('a full structured process parses with zero lexer/parser errors', async () => {
    const source = `
process invoice "Invoice Approval" {
  var amount: number

  start Begin
  user Review "Review invoice" { assignee = "demo" }
  if (amount > 1000) {
    user Senior "Senior approval" { assignee = "manager" }
  } else {
    service Auto "Auto-approve" { class = com.example.invoice.AutoApproveDelegate }
  }
  while (rejected) {
    user Fix "Fix issues"
  }
  end Done
}
`.trim();

    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    expect(isModel(document.parseResult.value)).toBe(true);
    expect(document.parseResult.value.processes).toHaveLength(1);
  });

  test('process id and label are captured', async () => {
    const source = `process p "My Process" { start S end E }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const process = document.parseResult.value.processes[0]!;
    expect(process.name).toBe('p');
    expect(process.label).toBe('My Process');
  });
});

// ── 2. Implicit sequence ordering ───────────────────────────────────────────

describe('Parsing — implicit sequence', () => {
  test('three bare statements parse into three Statements in source order', async () => {
    const source = `process p { user A user B user C }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();

    const body = document.parseResult.value.processes[0]!.body;
    expect(body).toHaveLength(3);
    expect(body.map((s) => s.$type)).toEqual([
      'UserTask',
      'UserTask',
      'UserTask',
    ]);
    // Order is preserved: the desugarer (not the grammar) materialises the
    // implicit flows A→B→C from this order.
    expect(body.map((s) => (s as UserTask).name)).toEqual(['A', 'B', 'C']);
  });

  test('process-scope declarations are separated from executable statements', async () => {
    const source = `
process p "Lbl" {
  label = "Other Label"
  var amount: number
  var flag: boolean
  start S
  end E
}
`.trim();
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();

    const process = document.parseResult.value.processes[0]!;
    // decls holds the label attribute + two var declarations.
    expect(process.decls.map((d) => d.$type)).toEqual([
      'ProcessLabel',
      'VarDecl',
      'VarDecl',
    ]);
    expect((process.decls[0] as ProcessLabel).value).toBe('Other Label');
    const vars = process.decls.slice(1) as VarDecl[];
    expect(vars.map((v) => v.name)).toEqual(['amount', 'flag']);
    expect(vars.map((v) => v.type)).toEqual(['number', 'boolean']);
    // body holds only the executable statements.
    expect(process.body.map((s) => s.$type)).toEqual(['StartEvent', 'EndEvent']);
  });

  test('every VarType keyword parses', async () => {
    const source = `
process p {
  var a: string
  var b: number
  var c: boolean
  var d: date
  var e: json
  var f: any
  start S
  end E
}
`.trim();
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const vars = document.parseResult.value.processes[0]!.decls as VarDecl[];
    expect(vars.map((v) => v.type)).toEqual([
      'string',
      'number',
      'boolean',
      'date',
      'json',
      'any',
    ]);
  });
});

// ── 3. if / else if / else ──────────────────────────────────────────────────

describe('Parsing — if / else if / else', () => {
  test('an if with two else-ifs and an else populates elseIfs and elseBlock', async () => {
    const source = `
process p {
  if (a) { user A }
  else if (b) { user B }
  else if (c) { user C }
  else { user D }
}
`.trim();
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();

    const ifSt = document.parseResult.value.processes[0]!.body[0] as IfStatement;
    expect(ifSt.$type).toBe('IfStatement');
    expect(ifSt.then.statements).toHaveLength(1);
    expect(ifSt.elseIfs).toHaveLength(2);
    expect(ifSt.elseBlock).toBeDefined();
    expect(ifSt.elseBlock!.statements).toHaveLength(1);
  });

  test('a plain if with no else has empty elseIfs and undefined elseBlock', async () => {
    const source = `process p { if (a) { user A } }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const ifSt = document.parseResult.value.processes[0]!.body[0] as IfStatement;
    expect(ifSt.elseIfs).toHaveLength(0);
    expect(ifSt.elseBlock).toBeUndefined();
  });
});

// ── 4. while and do … while ─────────────────────────────────────────────────

describe('Parsing — loops', () => {
  test('while parses into a WhileStatement', async () => {
    const source = `process p { while (rejected) { user R } }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const st = document.parseResult.value.processes[0]!
      .body[0] as WhileStatement;
    expect(st.$type).toBe('WhileStatement');
    expect(st.body.statements).toHaveLength(1);
  });

  test('do … while parses into a DoWhileStatement', async () => {
    const source = `process p { do { user R } while (again) }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const st = document.parseResult.value.processes[0]!
      .body[0] as DoWhileStatement;
    expect(st.$type).toBe('DoWhileStatement');
    expect(st.body.statements).toHaveLength(1);
  });
});

// ── 5. parallel { { } { } } ──────────────────────────────────────────────────

describe('Parsing — parallel', () => {
  test('parallel with two branches parses into a ParallelStatement', async () => {
    const source = `process p { parallel { { user A } { user B } } }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const st = document.parseResult.value.processes[0]!
      .body[0] as ParallelStatement;
    expect(st.$type).toBe('ParallelStatement');
    expect(st.branches).toHaveLength(2);
  });

  test('parallel supports more than two branches', async () => {
    const source = `process p { parallel { { user A } { user B } { user C } } }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const st = document.parseResult.value.processes[0]!
      .body[0] as ParallelStatement;
    expect(st.branches).toHaveLength(3);
  });

  test('parallel requires at least two branches (single branch is a parse error)', async () => {
    // The grammar demands the first Block then one-or-more further Blocks, so a
    // lone branch must fail to parse.
    const source = `process p { parallel { { user A } } }`;
    const document = await parse(source);
    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
  });
});

// ── 6. goto cross-reference resolution ──────────────────────────────────────

describe('Parsing — goto', () => {
  test('goto resolves to a statement with the matching name', async () => {
    const source = `process p { user Foo goto Foo }`;
    const document = await parse(source, { validation: true });
    expect(formatParseFailure(document)).toBeUndefined();

    const goto = document.parseResult.value.processes[0]!
      .body[1] as GotoStatement;
    expect(goto.$type).toBe('GotoStatement');
    expect(goto.target.ref).toBeDefined();
    // The cross-reference target is the `Statement` union; only leaf statements
    // (here, the `user Foo` task) carry `name`, so narrow before reading it.
    expect((goto.target.ref as UserTask).name).toBe('Foo');

    // A resolved goto produces no diagnostics.
    const linkerErrors = (document.diagnostics ?? []).filter(
      (d) => d.severity === 1,
    );
    expect(linkerErrors).toHaveLength(0);
  });

  test('goto to an unknown target produces exactly one linker error', async () => {
    // The linker owns unresolved references; no custom validator double-reports
    // (CLAUDE.md guard-ref lesson).
    const source = `process p { user Foo goto Missing }`;
    const document = await parse(source, { validation: true });
    // No parser errors — the grammar accepts any ID here.
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const linkerErrors = (document.diagnostics ?? []).filter(
      (d) => d.severity === 1,
    );
    expect(linkerErrors).toHaveLength(1);
    expect(linkerErrors[0]!.message).toContain('Missing');
  });
});

// ── 7. Expression sub-language parses to a real AST ─────────────────────────

describe('Parsing — expression AST', () => {
  test('`amount > 1000` parses to a Relational node (not a string)', async () => {
    const cond = await parseCondition(`amount > 1000`);
    expect(cond.$type).toBe('Relational');
    const rel = cond as Relational;
    expect(rel.op).toBe('>');
    // The operands are themselves AST nodes, not strings.
    expect((rel.left as VarRef).$type).toBe('VarRef');
    expect((rel.left as VarRef).name).toBe('amount');
    expect((rel.right as { $type: string }).$type).toBe('LiteralInt');
  });

  test('`order.total` parses to a VarRef with one dot-accessor', async () => {
    const cond = await parseCondition(`order.total`);
    expect(cond.$type).toBe('VarRef');
    const ref = cond as VarRef;
    expect(ref.name).toBe('order');
    expect(ref.accessors).toHaveLength(1);
    expect(ref.accessors[0]!.prop).toBe('total');
    expect(ref.accessors[0]!.index).toBeUndefined();
  });

  test('`items[0]` parses to a VarRef with an index-accessor', async () => {
    const cond = await parseCondition(`items[0]`);
    expect(cond.$type).toBe('VarRef');
    const ref = cond as VarRef;
    expect(ref.name).toBe('items');
    expect(ref.accessors).toHaveLength(1);
    expect(ref.accessors[0]!.prop).toBeUndefined();
    expect(ref.accessors[0]!.index).toBeDefined();
    expect(ref.accessors[0]!.index!.$type).toBe('LiteralInt');
  });

  test('`"${bean.method()}"` parses to a RawExpr fallback', async () => {
    // A method/bean call is outside the parsed subset, so the quoted `${…}`
    // raw-string fallback is used.
    const cond = await parseCondition(`"\${bean.method()}"`);
    expect(cond.$type).toBe('RawExpr');
    // Document the exact quoted form Langium stores in RawExpr.raw: the
    // RAW_TEMPLATE terminal keeps the author's surrounding quotes verbatim.
    expect((cond as RawExpr).raw).toBe('"${bean.method()}"');
  });

  test('a ternary parses to a Ternary node', async () => {
    const cond = await parseCondition(`flag ? a : b`);
    expect(cond.$type).toBe('Ternary');
    const tern = cond as Ternary;
    expect(tern.condition.$type).toBe('VarRef');
    expect(tern.whenTrue.$type).toBe('VarRef');
    expect(tern.whenFalse.$type).toBe('VarRef');
  });

  test('non-reserved identifiers in expression position lex as VarRef', async () => {
    // `status`, `active`, `type` are JUEL identifiers that do not collide with
    // the reserved set; they must parse as VarRef even though attribute keys
    // and VarType names are keywords elsewhere.
    const cond = await parseCondition(`status == active`);
    expect(cond.$type).toBe('Equality');
    const eq = cond as { left: VarRef; right: VarRef };
    expect(eq.left.name).toBe('status');
    expect(eq.right.name).toBe('active');

    const dotted = await parseCondition(`order.type`);
    expect(dotted.$type).toBe('VarRef');
    expect((dotted as VarRef).accessors[0]!.prop).toBe('type');
  });
});

// ── 8. Attribute blocks ─────────────────────────────────────────────────────

describe('Parsing — attribute blocks', () => {
  test('a user task attribute value is a LiteralString, not a RawExpr', async () => {
    const source = `process p { user T "Review" { assignee = "demo" } }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const ut = document.parseResult.value.processes[0]!.body[0] as UserTask;
    expect(ut.attrs).toHaveLength(1);
    expect(ut.attrs[0]!.key).toBe('assignee');
    expect(ut.attrs[0]!.value.$type).toBe('LiteralString');
    expect((ut.attrs[0]!.value as { value: string }).value).toBe('demo');
  });

  test('a service class can be written as a dotted reference', async () => {
    const source = `process p { service A { class = com.example.invoice.AutoApproveDelegate } }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const st = document.parseResult.value.processes[0]!.body[0] as ServiceTask;
    expect(st.attrs[0]!.key).toBe('class');
    expect(st.attrs[0]!.value.$type).toBe('VarRef');
    expect(renderExpression(st.attrs[0]!.value)).toBe(
      '${com.example.invoice.AutoApproveDelegate}',
    );
  });

  test('duplicate attribute keys are visible as two AST attribute nodes', async () => {
    // The grammar accepts duplicates (repeated-list form) so the validator can
    // detect and flag them. This guards that input contract.
    const source = `process p { user T { assignee = "a" assignee = "b" } }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const ut = document.parseResult.value.processes[0]!.body[0] as UserTask;
    expect(ut.attrs).toHaveLength(2);
    expect(ut.attrs.map((a) => a.key)).toEqual(['assignee', 'assignee']);
    expect(
      ut.attrs.map((a) => (a.value as { value: string }).value),
    ).toEqual(['a', 'b']);
  });

  test('a task with no attribute block has an empty attrs list', async () => {
    const source = `process p { user T "No attrs" }`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const ut = document.parseResult.value.processes[0]!.body[0] as UserTask;
    expect(ut.attrs).toHaveLength(0);
  });
});

// ── 9. renderExpression round-trip ──────────────────────────────────────────

describe('renderExpression', () => {
  test('round-trips `amount > 1000` to `${amount > 1000}`', async () => {
    const cond = await parseCondition(`amount > 1000`);
    expect(renderExpression(cond)).toBe('${amount > 1000}');
  });

  test('renders a RawExpr to its verbatim body (quotes stripped)', async () => {
    const cond = await parseCondition(`"\${bean.method()}"`);
    expect(renderExpression(cond)).toBe('${bean.method()}');
  });

  test('renders nested logical / relational / accessor expressions', async () => {
    const cond = await parseCondition(`order.total > 1000 && items[0] == status`);
    expect(renderExpression(cond)).toBe(
      '${order.total > 1000 && items[0] == status}',
    );
  });

  test('renders a ternary', async () => {
    const cond = await parseCondition(`flag ? a : b`);
    expect(renderExpression(cond)).toBe('${flag ? a : b}');
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a bare expression by wrapping it as the condition of an `if`, then
 * return the parsed condition AST node. Fails the test if the wrapper does not
 * parse cleanly.
 */
async function parseCondition(expr: string) {
  const document = await parse(`process p { if (${expr}) { user A } }`);
  const failure = formatParseFailure(document);
  if (failure) {
    throw new Error(`condition '${expr}' failed to parse:\n${failure}`);
  }
  const ifSt = document.parseResult.value.processes[0]!.body[0] as IfStatement;
  return ifSt.condition;
}

/**
 * Format any parse failure in `document` into a single human-readable string,
 * or `undefined` when the document parses cleanly. Lexer errors are checked
 * first because they fire before the parser and would otherwise be masked.
 */
function formatParseFailure(document: LangiumDocument): string | undefined {
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
