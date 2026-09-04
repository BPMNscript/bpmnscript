/**
 * Parsing test suite for the BPMNscript grammar, driven in isolation through
 * Langium's `parseHelper`.
 *
 * Beyond the grammar surface these pin the edge cases Langium 4 makes easy to
 * get wrong: keyword versus ID in expression position, parser-rule expressions,
 * attribute-key versus identifier disambiguation, and duplicate attribute keys
 * reaching the AST. Whether a duplicate key is an error is the validator
 * suite's question, not this one's; where a `goto` may resolve to is the
 * scoping suite's.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { FENCE } from './helpers/block-hosts.js';
import { formatParseFailure } from './helpers/parse-failure.js';
import type {
  Model,
  IfStatement,
  WhileStatement,
  ParallelStatement,
  StartEvent,
  EndEvent,
  UserTask,
  ServiceTask,
  ScriptTask,
  SubProcess,
  CallActivity,
  Relational,
  Additive,
  VarRef,
  Ternary,
  RawExpr,
  VarDecl,
  ProcessLabel,
  OnHandler,
  ThrowStatement,
  EmitStatement,
  ErrorDecl,
  IntermediateCatchEvent,
  ProcessAttribute,
} from '@bpmn-script/language';
import {
  createBpmnScriptServices,
  isModel,
  renderExpression,
} from '@bpmn-script/language';

/** The one property every AST node exposes, enough to assert a node's kind. */
type AstLike = { $type: string };

let services: ReturnType<typeof createBpmnScriptServices>;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ── Structured process parses zero-error ─────────────────────────────────

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

    const document = await parseModel(source);
    expect(isModel(document)).toBe(true);
    expect(document.processes).toHaveLength(1);
  });

  test('process id and label are captured', async () => {
    const source = `process p "My Process" { start S end E }`;
    const document = await parseModel(source);
    const process = document.processes[0]!;
    expect(process.name).toBe('p');
    expect(process.label).toBe('My Process');
  });
});

// ── Implicit sequence ordering ───────────────────────────────────────────

describe('Parsing — implicit sequence', () => {
  test('three bare statements parse into three Statements in source order', async () => {
    const source = `process p { user A user B user C }`;
    const document = await parseModel(source);

    const body = document.processes[0]!.body;
    expect(body).toHaveLength(3);
    expect(body.map((s) => s.$type)).toEqual([
      'UserTask',
      'UserTask',
      'UserTask',
    ]);
    // Order is preserved: the desugarer (not the grammar) materialises the
    // implicit flows A->B->C from this order.
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
    const document = await parseModel(source);

    const process = document.processes[0]!;
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
    expect(process.body.map((s) => s.$type)).toEqual([
      'StartEvent',
      'EndEvent',
    ]);
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
    const document = await parseModel(source);
    const vars = document.processes[0]!.decls as VarDecl[];
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

// ── if / else if / else ──────────────────────────────────────────────────

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
    const ifSt = await statementAt<IfStatement>(source);
    expect(ifSt.$type).toBe('IfStatement');
    expect(ifSt.then.statements).toHaveLength(1);
    expect(ifSt.elseIfs).toHaveLength(2);
    expect(ifSt.elseBlock).toBeDefined();
    expect(ifSt.elseBlock!.statements).toHaveLength(1);
  });

  test('a plain if with no else has empty elseIfs and undefined elseBlock', async () => {
    const source = `process p { if (a) { user A } }`;
    const ifSt = await statementAt<IfStatement>(source);
    expect(ifSt.elseIfs).toHaveLength(0);
    expect(ifSt.elseBlock).toBeUndefined();
  });
});

// ── while and do ... while ───────────────────────────────────────────────

describe('Parsing — loops', () => {
  test.each([
    ['while (rejected) { user R }', 'WhileStatement'],
    ['do { user R } while (again)', 'DoWhileStatement'],
  ])('`%s` parses into a %s with a one-statement body', async (loop, type) => {
    const st = await statementAt<WhileStatement>(`process p { ${loop} }`);
    expect(st.$type).toBe(type);
    expect(st.body.statements).toHaveLength(1);
  });
});

// ── parallel { { } { } } ──────────────────────────────────────────────────

describe('Parsing — parallel', () => {
  test('parallel with two branches parses into a ParallelStatement', async () => {
    const source = `process p { parallel { { user A } { user B } } }`;
    const st = await statementAt<ParallelStatement>(source);
    expect(st.$type).toBe('ParallelStatement');
    expect(st.branches).toHaveLength(2);
  });

  test('parallel supports more than two branches', async () => {
    const source = `process p { parallel { { user A } { user B } { user C } } }`;
    const st = await statementAt<ParallelStatement>(source);
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

// ── subprocess ────────────────────────────────────────────────────────────

describe('Parsing — subprocess', () => {
  test('a labeled subprocess parses into a SubProcess with a body statement', async () => {
    const source = `process p { subprocess Handle "Handle order" { user Review { assignee = "demo" } } }`;
    const sub = await statementAt<SubProcess>(source);
    expect(sub.$type).toBe('SubProcess');
    expect(sub.name).toBe('Handle');
    expect(sub.label).toBe('Handle order');
    expect(sub.body.statements).toHaveLength(1);
    expect(sub.body.statements[0]!.$type).toBe('UserTask');
  });

  test('explicit start/end inside the body parse as ordinary StartEvent/EndEvent', async () => {
    const source = `process p { subprocess S { start In user A end Out } }`;
    const sub = await statementAt<SubProcess>(source);
    expect(sub.body.statements.map((s) => s.$type)).toEqual([
      'StartEvent',
      'UserTask',
      'EndEvent',
    ]);
    expect((sub.body.statements[0] as StartEvent).name).toBe('In');
    expect((sub.body.statements[2] as EndEvent).name).toBe('Out');
  });

  test('a subprocess nests inside a subprocess', async () => {
    const source = `process p { subprocess Outer { subprocess Inner { user A } } }`;
    const outer = await statementAt<SubProcess>(source);
    expect(outer.name).toBe('Outer');
    const inner = outer.body.statements[0] as SubProcess;
    expect(inner.$type).toBe('SubProcess');
    expect(inner.name).toBe('Inner');
    expect(inner.body.statements[0]!.$type).toBe('UserTask');
  });

  test('a subprocess nests inside an if block', async () => {
    const source = `process p { if (a) { subprocess S { user A } } }`;
    const ifSt = await statementAt<IfStatement>(source);
    const sub = ifSt.then.statements[0] as SubProcess;
    expect(sub.$type).toBe('SubProcess');
    expect(sub.name).toBe('S');
  });

  test('an empty subprocess body parses with zero statements', async () => {
    const source = `process p { subprocess S { } }`;
    const sub = await statementAt<SubProcess>(source);
    expect(sub.body.statements).toHaveLength(0);
  });

  test('a subprocess without a label leaves label undefined', async () => {
    const source = `process p { subprocess S { } }`;
    const sub = await statementAt<SubProcess>(source);
    expect(sub.label).toBeUndefined();
  });
});

// ── call activity ─────────────────────────────────────────────────────────

describe('Parsing — call activity', () => {
  test('a full call activity parses: attrs and every mapping shape', async () => {
    const source = `process p { call Fulfilment "Fulfil order" {
  process = "fulfilment-process"
  binding = deployment
  businessKey = "\${execution.processBusinessKey}"
  in *
  in orderId
  in total = amount + tax
  in local vip = vipFlag
  out shipmentId
  out shipped = confirmed
} }`;
    const call = await statementAt<CallActivity>(source);
    expect(call.$type).toBe('CallActivity');
    expect(call.name).toBe('Fulfilment');
    expect(call.label).toBe('Fulfil order');

    expect(call.attrs).toHaveLength(3);
    expect(call.attrs.map((a) => a.key)).toEqual([
      'process',
      'binding',
      'businessKey',
    ]);
    expect(call.attrs[0]!.value.$type).toBe('LiteralString');
    expect((call.attrs[0]!.value as { value: string }).value).toBe(
      'fulfilment-process',
    );
    // A bare identifier attribute value (no quotes) is a VarRef, not a string.
    expect(call.attrs[1]!.value.$type).toBe('VarRef');
    expect((call.attrs[1]!.value as VarRef).name).toBe('deployment');
    expect(call.attrs[2]!.value.$type).toBe('RawExpr');

    expect(call.mappings).toHaveLength(6);
    const [all, shorthand, arith, local, outShort, outExpr] = call.mappings;

    expect(all!.direction).toBe('in');
    expect(all!.all).toBe(true);
    expect(all!.target).toBeUndefined();

    // Shorthand `in orderId` names only the target; no explicit source is
    // parsed (the target doubles as the implied source downstream).
    expect(shorthand!.direction).toBe('in');
    expect(shorthand!.all).toBeFalsy();
    expect(shorthand!.local).toBeFalsy();
    expect(shorthand!.target).toBe('orderId');
    expect(shorthand!.source).toBeUndefined();

    expect(arith!.direction).toBe('in');
    expect(arith!.target).toBe('total');
    expect(arith!.source!.$type).toBe('Additive');
    expect((arith!.source as Additive).op).toBe('+');

    expect(local!.direction).toBe('in');
    expect(local!.local).toBe(true);
    expect(local!.target).toBe('vip');
    expect(local!.source!.$type).toBe('VarRef');
    expect((local!.source as VarRef).name).toBe('vipFlag');

    expect(outShort!.direction).toBe('out');
    expect(outShort!.local).toBeFalsy();
    expect(outShort!.target).toBe('shipmentId');
    expect(outShort!.source).toBeUndefined();

    expect(outExpr!.direction).toBe('out');
    expect(outExpr!.target).toBe('shipped');
    expect(outExpr!.source!.$type).toBe('VarRef');
    expect((outExpr!.source as VarRef).name).toBe('confirmed');
  });

  test('an integer attribute value is a LiteralInt', async () => {
    const source = `process p { call C { version = 3 } }`;
    const call = await statementAt<CallActivity>(source);
    expect(call.attrs[0]!.key).toBe('version');
    expect(call.attrs[0]!.value.$type).toBe('LiteralInt');
    expect((call.attrs[0]!.value as { value: number }).value).toBe(3);
  });

  test('a raw-template attribute value is a RawExpr', async () => {
    const source = `process p { call C { version = "\${v}" } }`;
    const call = await statementAt<CallActivity>(source);
    expect(call.attrs[0]!.value.$type).toBe('RawExpr');
  });

  test('a minimal call with only `process` parses', async () => {
    const source = `process p { call X { process = "p" } }`;
    const call = await statementAt<CallActivity>(source);
    expect(call.attrs).toHaveLength(1);
    expect(call.mappings).toHaveLength(0);
  });

  test('an empty call body parses — a missing `process` is a validator concern, not a parse error', async () => {
    const source = `process p { call X { } }`;
    const call = await statementAt<CallActivity>(source);
    expect(call.attrs).toHaveLength(0);
    expect(call.mappings).toHaveLength(0);
  });

  test('a call nests inside an if block', async () => {
    const source = `process p { if (a) { call X { process = "p" } } }`;
    const ifSt = await statementAt<IfStatement>(source);
    const call = ifSt.then.statements[0] as CallActivity;
    expect(call.$type).toBe('CallActivity');
    expect(call.name).toBe('X');
  });

  test('a call nests inside a subprocess body', async () => {
    const source = `process p { subprocess S { call X { process = "p" } } }`;
    const sub = await statementAt<SubProcess>(source);
    const call = sub.body.statements[0] as CallActivity;
    expect(call.$type).toBe('CallActivity');
    expect(call.name).toBe('X');
  });

  test('the call and mapping keywords are rejected as bare identifiers in expression position', async () => {
    for (const word of ['call', 'in', 'out', 'local']) {
      const document = await parse(`process p { if (${word} > 2) { user A } }`);
      expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
    }
  });

  test('the call attribute words are ordinary identifiers in expression position', async () => {
    for (const word of ['binding', 'version', 'businessKey']) {
      const cond = await parseCondition(`${word} > 2`);
      expect(cond.$type).toBe('Relational');
    }
  });

  test('the raw-template fallback still parses a reserved word as an identifier', async () => {
    const cond = await parseCondition(`"\${version > 2}"`);
    expect(cond.$type).toBe('RawExpr');
  });
});

// ── on handlers, throw / emit, error declaration ─────────────────────────

describe('Parsing — on handlers', () => {
  test('a full interrupting handler parses: trigger, code, two bindings, one body statement', async () => {
    const source = `process p {
  on error "PAYMENT_FAILED" (code c, message m) { service R { class = "x.Y" } }
}`;
    const handler = await statementAt<OnHandler>(source);
    expect(handler.$type).toBe('OnHandler');
    expect(handler.trigger).toBe('error');
    expect(handler.code).toBe('PAYMENT_FAILED');
    expect(handler.bindings).toHaveLength(2);
    expect(handler.bindings[0]!.field).toBe('code');
    expect(handler.bindings[0]!.variable).toBe('c');
    expect(handler.bindings[1]!.field).toBe('message');
    expect(handler.bindings[1]!.variable).toBe('m');
    expect(handler.body.statements).toHaveLength(1);
    expect(handler.body.statements[0]!.$type).toBe('ServiceTask');
    expect(handler.alongside).toBeFalsy();
    // Regression pin for the paren alternation: two adjacent
    // identifiers commit to a binding list, never a condition.
    expect(handler.condition).toBeUndefined();
  });

  test('message and signal handlers take a required name and no particle/condition/bindings', async () => {
    const messageHandler = await statementAt<OnHandler>(
      `process p { on message "PaymentReceived" { user Review { assignee = "demo" } } }`,
    );
    expect(messageHandler.trigger).toBe('message');
    expect(messageHandler.code).toBe('PaymentReceived');
    expect(messageHandler.particle).toBeUndefined();
    expect(messageHandler.time).toBeUndefined();
    expect(messageHandler.condition).toBeUndefined();
    expect(messageHandler.bindings).toHaveLength(0);
    expect(messageHandler.body.statements).toHaveLength(1);
    expect(messageHandler.body.statements[0]!.$type).toBe('UserTask');

    const signalHandler = await statementAt<OnHandler>(
      `process p { on signal "Cancelled" alongside { } }`,
    );
    expect(signalHandler.trigger).toBe('signal');
    expect(signalHandler.code).toBe('Cancelled');
    expect(signalHandler.alongside).toBe(true);
  });

  test('alongside marks a non-interrupting handler; a catch-all handler omits code', async () => {
    const alongsideHandler = await statementAt<OnHandler>(
      `process p { on escalation "X" (code v) alongside { } }`,
    );
    expect(alongsideHandler.alongside).toBe(true);

    const errorHandler = await statementAt<OnHandler>(
      `process p { on error { } }`,
    );
    expect(errorHandler.trigger).toBe('error');
    expect(errorHandler.code).toBeUndefined();

    const escalationHandler = await statementAt<OnHandler>(
      `process p { on escalation { } }`,
    );
    expect(escalationHandler.trigger).toBe('escalation');
    expect(escalationHandler.code).toBeUndefined();
  });
});

describe('Parsing — on timer handlers', () => {
  test('the three particles each carry their own time string', async () => {
    const afterHandler = await statementAt<OnHandler>(
      `process p { on timer after "PT1H" { } }`,
    );
    expect(afterHandler.trigger).toBe('timer');
    expect(afterHandler.particle).toBe('after');
    expect(afterHandler.time).toBe('PT1H');
    expect(afterHandler.code).toBeUndefined();

    const atHandler = await statementAt<OnHandler>(
      `process p { on timer at "2026-08-01T09:00:00" alongside { } }`,
    );
    expect(atHandler.particle).toBe('at');
    expect(atHandler.time).toBe('2026-08-01T09:00:00');
    expect(atHandler.alongside).toBe(true);

    const everyHandler = await statementAt<OnHandler>(
      `process p { on timer every "R/PT10M" alongside { } }`,
    );
    expect(everyHandler.particle).toBe('every');
    expect(everyHandler.time).toBe('R/PT10M');
    expect(everyHandler.alongside).toBe(true);
  });

  test('an EL time template normalizes to the same unquoted shape a plain string would carry', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { on timer after "\${dueDate}" { } }`,
    );
    expect(handler.particle).toBe('after');
    // The RAW_TEMPLATE alternative arrives through the value converter
    // unquoted, like the STRING alternative's content, so the author's
    // surrounding quotes are gone.
    expect(handler.time).toBe('${dueDate}');
  });
});

describe('Parsing — on condition handlers', () => {
  test('a relational condition parses to a Relational Expr with no bindings', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { on condition (amount > 100) { } }`,
    );
    expect(handler.trigger).toBe('condition');
    expect(handler.condition?.$type).toBe('Relational');
    expect((handler.condition as Relational).op).toBe('>');
    expect(handler.bindings).toHaveLength(0);
  });

  test('a lone identifier in the parens is a VarRef condition, not a binding attempt', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { on condition (approved) { } }`,
    );
    expect(handler.condition?.$type).toBe('VarRef');
    expect((handler.condition as VarRef).name).toBe('approved');
    expect(handler.bindings).toHaveLength(0);
  });

  test('a quoted raw template in the parens is a RawExpr condition', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { on condition ("\${bean.check()}") { } }`,
    );
    expect(handler.condition?.$type).toBe('RawExpr');
  });

  test('alongside is legal on a condition handler', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { on condition (amount > limit) alongside { } }`,
    );
    expect(handler.alongside).toBe(true);
    expect(handler.condition?.$type).toBe('Relational');
  });
});

describe('Parsing — hosted on handlers', () => {
  test('each trigger takes a host, and the host is never mistaken for the trigger', async () => {
    // Both the host and the trigger are bare `ID`s, so every trigger has to be
    // pinned individually: the word before the colon is the host, the word
    // after it is the trigger.
    for (const trigger of [
      'error',
      'escalation',
      'message',
      'signal',
      'timer',
      'condition',
      'compensation',
    ]) {
      const handler = await statementAt<OnHandler>(
        `process p { on Review: ${trigger} { } }`,
      );
      expect(handler.host?.$refText).toBe('Review');
      expect(handler.trigger).toBe(trigger);
    }
  });

  test('a hosted timer keeps its particle and time, with the host separate from both', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { user Review on Review: timer after "PT2H" { } }`,
      1,
    );
    expect(handler.host?.$refText).toBe('Review');
    expect(handler.trigger).toBe('timer');
    expect(handler.particle).toBe('after');
    expect(handler.time).toBe('PT2H');
    expect(handler.code).toBeUndefined();
  });

  test('a hosted handler carries a code, bindings, and a body exactly as a host-less one does', async () => {
    const handler = await statementAt<OnHandler>(
      `process p {
  user Pack
  on Pack: error "OUT_OF_STOCK" (code c, message m) { service R { class = "x.Y" } }
}`,
      1,
    );
    expect(handler.host?.$refText).toBe('Pack');
    expect(handler.trigger).toBe('error');
    expect(handler.code).toBe('OUT_OF_STOCK');
    expect(handler.bindings).toHaveLength(2);
    expect(handler.bindings[0]!.field).toBe('code');
    expect(handler.bindings[1]!.variable).toBe('m');
    expect(handler.body.statements).toHaveLength(1);
    expect(handler.alongside).toBeFalsy();
  });

  test('a hosted handler takes a parenthesized condition, and alongside after it', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { user Review on Review: condition (amount > 100) alongside { } }`,
      1,
    );
    expect(handler.host?.$refText).toBe('Review');
    expect(handler.trigger).toBe('condition');
    expect(handler.condition?.$type).toBe('Relational');
    expect(handler.alongside).toBe(true);
    expect(handler.bindings).toHaveLength(0);
  });

  test('alongside is legal on a hosted handler with a code', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { user Review on Review: message "Cancelled" alongside { } }`,
      1,
    );
    expect(handler.host?.$refText).toBe('Review');
    expect(handler.alongside).toBe(true);
  });

  test('a host-less handler leaves the host slot empty', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { on error "X" { } }`,
    );
    expect(handler.host).toBeUndefined();
    expect(handler.trigger).toBe('error');
  });

  test('a colon with no trigger after it is a parse error', async () => {
    const document = await parse(`process p { user Pack on Pack: { } }`);
    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
  });
});

describe('Parsing — throw / emit', () => {
  test('throw error / throw escalation parse as terminal statements carrying a code', async () => {
    const throwErrorSt = await statementAt<ThrowStatement>(
      `process p { throw error "C" }`,
    );
    expect(throwErrorSt.$type).toBe('ThrowStatement');
    expect(throwErrorSt.trigger).toBe('error');
    expect(throwErrorSt.code).toBe('C');
    expect(throwErrorSt.name).toBeUndefined();

    const throwEscalationSt = await statementAt<ThrowStatement>(
      `process p { throw escalation "C" }`,
    );
    expect(throwEscalationSt.trigger).toBe('escalation');
    expect(throwEscalationSt.code).toBe('C');
  });

  test('an explicit id (name) is optional on throw', async () => {
    const namedSt = await statementAt<ThrowStatement>(
      `process p { throw error Failed "C" }`,
    );
    expect(namedSt.name).toBe('Failed');
    expect(namedSt.code).toBe('C');
  });

  test('throw signal and emit signal parse under the existing rules — no grammar change needed', async () => {
    const throwBareSt = await statementAt<ThrowStatement>(
      `process p { throw signal "S" }`,
    );
    expect(throwBareSt.trigger).toBe('signal');
    expect(throwBareSt.name).toBeUndefined();
    expect(throwBareSt.code).toBe('S');

    const throwNamedSt = await statementAt<ThrowStatement>(
      `process p { throw signal Sent "S" }`,
    );
    expect(throwNamedSt.trigger).toBe('signal');
    expect(throwNamedSt.name).toBe('Sent');
    expect(throwNamedSt.code).toBe('S');

    const emitBareSt = await statementAt<EmitStatement>(
      `process p { emit signal "S" }`,
    );
    expect(emitBareSt.trigger).toBe('signal');
    expect(emitBareSt.name).toBeUndefined();
    expect(emitBareSt.code).toBe('S');

    const emitNamedSt = await statementAt<EmitStatement>(
      `process p { emit signal Ping "S" }`,
    );
    expect(emitNamedSt.trigger).toBe('signal');
    expect(emitNamedSt.name).toBe('Ping');
    expect(emitNamedSt.code).toBe('S');
  });

  test('emit escalation parses with and without an explicit id — one-token lookahead disambiguates', async () => {
    const bareSt = await statementAt<EmitStatement>(
      `process p { emit escalation "C" }`,
    );
    expect(bareSt.$type).toBe('EmitStatement');
    expect(bareSt.trigger).toBe('escalation');
    expect(bareSt.name).toBeUndefined();
    expect(bareSt.code).toBe('C');

    const namedSt = await statementAt<EmitStatement>(
      `process p { emit escalation Ping "C" }`,
    );
    expect(namedSt.name).toBe('Ping');
    expect(namedSt.code).toBe('C');
  });

  test('emit error parses at the grammar level — the impossible verb/kind pair is the validator’s job', async () => {
    const st = await statementAt<EmitStatement>(`process p { emit error "C" }`);
    expect(st.trigger).toBe('error');
  });
});

describe('Parsing — await (intermediate catch)', () => {
  test.each([
    ['message', 'Invoice Received'],
    ['signal', 'Ready'],
  ])('`await %s` takes a required name string', async (trigger, code) => {
    const catchEvent = await statementAt<IntermediateCatchEvent>(
      `process p { await ${trigger} "${code}" }`,
    );
    expect(catchEvent.$type).toBe('IntermediateCatchEvent');
    expect(catchEvent.trigger).toBe(trigger);
    expect(catchEvent.code).toBe(code);
    expect(catchEvent.particle).toBeUndefined();
    expect(catchEvent.time).toBeUndefined();
    expect(catchEvent.condition).toBeUndefined();
  });

  test('await timer keeps its particle and time — the particle is never swallowed as a name', async () => {
    const afterEvent = await statementAt<IntermediateCatchEvent>(
      `process p { await timer after "PT1H" }`,
    );
    expect(afterEvent.trigger).toBe('timer');
    expect(afterEvent.particle).toBe('after');
    expect(afterEvent.time).toBe('PT1H');
    expect(afterEvent.code).toBeUndefined();

    const atEvent = await statementAt<IntermediateCatchEvent>(
      `process p { await timer at "2026-08-01T09:00:00" }`,
    );
    expect(atEvent.particle).toBe('at');
    expect(atEvent.time).toBe('2026-08-01T09:00:00');

    const everyEvent = await statementAt<IntermediateCatchEvent>(
      `process p { await timer every "R/PT10M" }`,
    );
    expect(everyEvent.particle).toBe('every');
    expect(everyEvent.time).toBe('R/PT10M');
  });

  test('await condition takes a parenthesized expression, the same AST an if condition parses to', async () => {
    const catchEvent = await statementAt<IntermediateCatchEvent>(
      `process p { await condition (amount > 100) }`,
    );
    expect(catchEvent.trigger).toBe('condition');
    expect(catchEvent.condition?.$type).toBe('Relational');
    expect((catchEvent.condition as Relational).op).toBe('>');
    expect(catchEvent.code).toBeUndefined();
  });

  test('await is reserved: a bare `var await` does not parse, while the trigger/particle words stay soft', async () => {
    const reservedDoc = await parse(`process p { var await: string }`);
    expect(reservedDoc.parseResult.parserErrors.length).toBeGreaterThan(0);

    await parseModel(`process p { var message: string }`);

    const stepNamedEvery = await parseModel(`process p { user every }`);
    expect((stepNamedEvery.processes[0]!.body[0] as UserTask).name).toBe(
      'every',
    );
  });
});

// ── compensation: the code is optional on throw / emit ───────────────────
//
// Compensation undoes a subprocess's already-completed work rather than naming
// an error, escalation, or signal, so it carries no code at all. `code=STRING`
// is therefore optional on both `ThrowStatement` and `EmitStatement`, which
// makes it optional for every other trigger too. Word and payload legality per
// trigger stays the validator's job, not the parser's.
describe('Parsing — compensation (optional throw/emit code)', () => {
  test('a bare `throw compensation` / `emit compensation` carries no name and no code', async () => {
    const thrownSt = await statementAt<ThrowStatement>(
      `process p { throw compensation }`,
    );
    expect(thrownSt.$type).toBe('ThrowStatement');
    expect(thrownSt.trigger).toBe('compensation');
    expect(thrownSt.name).toBeUndefined();
    expect(thrownSt.code).toBeUndefined();

    const emittedSt = await statementAt<EmitStatement>(
      `process p { emit compensation }`,
    );
    expect(emittedSt.$type).toBe('EmitStatement');
    expect(emittedSt.trigger).toBe('compensation');
    expect(emittedSt.name).toBeUndefined();
    expect(emittedSt.code).toBeUndefined();
  });

  test('a named `throw compensation Undo` / `emit compensation Ping` carries a name but no code', async () => {
    const thrownSt = await statementAt<ThrowStatement>(
      `process p { throw compensation Undo }`,
    );
    expect(thrownSt.name).toBe('Undo');
    expect(thrownSt.code).toBeUndefined();

    const emittedSt = await statementAt<EmitStatement>(
      `process p { emit compensation Ping }`,
    );
    expect(emittedSt.name).toBe('Ping');
    expect(emittedSt.code).toBeUndefined();
  });

  test('regression: a coded throw/emit still parses exactly as before, name then code', async () => {
    const thrownSt = await statementAt<ThrowStatement>(
      `process p { throw error Failed "C" }`,
    );
    expect(thrownSt.trigger).toBe('error');
    expect(thrownSt.name).toBe('Failed');
    expect(thrownSt.code).toBe('C');

    const emittedSt = await statementAt<EmitStatement>(
      `process p { emit signal Ping "S" }`,
    );
    expect(emittedSt.trigger).toBe('signal');
    expect(emittedSt.name).toBe('Ping');
    expect(emittedSt.code).toBe('S');
  });

  test('a code-less throw/emit now parses for every trigger, not just compensation — word legality is the validator’s job', async () => {
    const throwError = await parseModel(`process p { throw error }`);
    expect(
      (throwError.processes[0]!.body[0] as ThrowStatement).code,
    ).toBeUndefined();

    const emitSignal = await parseModel(`process p { emit signal }`);
    expect(
      (emitSignal.processes[0]!.body[0] as EmitStatement).code,
    ).toBeUndefined();

    const throwBanana = await parseModel(`process p { throw banana }`);
    expect((throwBanana.processes[0]!.body[0] as ThrowStatement).trigger).toBe(
      'banana',
    );
  });

  test('a statement following a code-less throw is not swallowed as its name', async () => {
    const document = await parseModel(
      `process p { throw compensation service R { class = "x.Y" } }`,
    );
    const body = document.processes[0]!.body;
    expect(body).toHaveLength(2);
    expect(body.map((s) => s.$type)).toEqual(['ThrowStatement', 'ServiceTask']);
    expect((body[0] as ThrowStatement).name).toBeUndefined();
  });

  test('`on compensation { }` parses under the unchanged OnHandler rule, with no code/particle/bindings/condition', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { on compensation { } }`,
    );
    expect(handler.$type).toBe('OnHandler');
    expect(handler.trigger).toBe('compensation');
    expect(handler.code).toBeUndefined();
    expect(handler.particle).toBeUndefined();
    expect(handler.bindings).toHaveLength(0);
    expect(handler.condition).toBeUndefined();
    expect(handler.alongside).toBeFalsy();
  });

  test('`on compensation "X" { }` and `on compensation alongside { }` also parse — the validator rejects them later', async () => {
    const withCodeHandler = await statementAt<OnHandler>(
      `process p { on compensation "X" { } }`,
    );
    expect(withCodeHandler.trigger).toBe('compensation');
    expect(withCodeHandler.code).toBe('X');

    const withAlongsideHandler = await statementAt<OnHandler>(
      `process p { on compensation alongside { } }`,
    );
    expect(withAlongsideHandler.trigger).toBe('compensation');
    expect(withAlongsideHandler.alongside).toBe(true);
  });

  test('`compensation` stays a plain soft word: a var, a task name, and an expression identifier', async () => {
    await parseModel(`process p { var compensation: number start S end E }`);

    const taskDoc = await parseModel(`process p { user compensation }`);
    expect((taskDoc.processes[0]!.body[0] as UserTask).name).toBe(
      'compensation',
    );

    const cond = await parseCondition(`compensation > 0`);
    expect(cond.$type).toBe('Relational');
  });
});

describe('Parsing — error declaration', () => {
  test('`error "C" message "M"` parses as a process declaration alongside var decls', async () => {
    const source = `
process p {
  var amount: number
  error "PAYMENT_FAILED" message "Payment was declined"
  start S
  end E
}
`.trim();
    const document = await parseModel(source);
    const process = document.processes[0]!;
    expect(process.decls.map((d) => d.$type)).toEqual(['VarDecl', 'ErrorDecl']);
    const decl = process.decls[1] as ErrorDecl;
    expect(decl.kind).toBe('error');
    expect(decl.code).toBe('PAYMENT_FAILED');
    expect(decl.field).toBe('message');
    expect(decl.message).toBe('Payment was declined');
  });
});

describe('Parsing — handler / throw / emit nesting', () => {
  test('an on handler nests inside a subprocess body', async () => {
    const source = `process p { subprocess S { on error "X" { } } }`;
    const sub = await statementAt<SubProcess>(source);
    expect(sub.body.statements[0]!.$type).toBe('OnHandler');
  });

  test('an on handler nests inside another on handler body', async () => {
    const source = `process p { on error "X" { on escalation "Y" { } } }`;
    const outer = await statementAt<OnHandler>(source);
    expect(outer.body.statements[0]!.$type).toBe('OnHandler');
    expect((outer.body.statements[0] as OnHandler).trigger).toBe('escalation');
  });

  test('throw and emit nest inside an if block', async () => {
    const source = `process p { if (a) { throw error "X" } else { emit escalation "Y" } }`;
    const ifSt = await statementAt<IfStatement>(source);
    expect(ifSt.then.statements[0]!.$type).toBe('ThrowStatement');
    expect(ifSt.elseBlock!.statements[0]!.$type).toBe('EmitStatement');
  });

  test('an explicit start as the first statement of an on body parses', async () => {
    const source = `process p { on error "X" { start In } }`;
    const handler = await statementAt<OnHandler>(source);
    expect(handler.body.statements[0]!.$type).toBe('StartEvent');
    expect((handler.body.statements[0] as StartEvent).name).toBe('In');
  });
});

describe('Parsing — soft event words stay plain identifiers', () => {
  test('error/escalation/code/message are usable as ordinary var/task names and identifiers', async () => {
    await parseModel(`process p { var message: string start S end E }`);

    await parseModel(`process p { var code: string start S end E }`);

    const cond = await parseCondition(`error == "x"`);
    expect(cond.$type).toBe('Equality');

    const taskNamedError = await parseModel(`process p { user error }`);
    expect((taskNamedError.processes[0]!.body[0] as UserTask).name).toBe(
      'error',
    );
  });

  test('an unknown trigger word and an unknown binding field still parse — word legality is the validator’s job', async () => {
    await parseModel(`process p { on banana "X" { } }`);

    await parseModel(`process p { on error "X" (coed c) { } }`);
  });

  test('the new trigger and particle words stay usable as ordinary var/task names and identifiers', async () => {
    await parseModel(`process p { var at: string start S end E }`);

    await parseModel(`process p { var timer: number start S end E }`);

    const cond = await parseCondition(`after > 2`);
    expect(cond.$type).toBe('Relational');

    const taskNamedEvery = await parseModel(`process p { user every }`);
    expect((taskNamedEvery.processes[0]!.body[0] as UserTask).name).toBe(
      'every',
    );

    await parseModel(`process p { var condition: boolean start S end E }`);
  });

  test('nonsense trigger/payload pairings parse — word and payload legality are the validator’s job', async () => {
    const errorWithParticleHandler = await statementAt<OnHandler>(
      `process p { on error after "x" { } }`,
    );
    expect(errorWithParticleHandler.particle).toBe('after');
    expect(errorWithParticleHandler.time).toBe('x');

    const timerWithBareCodeHandler = await statementAt<OnHandler>(
      `process p { on timer "PT1H" { } }`,
    );
    expect(timerWithBareCodeHandler.code).toBe('PT1H');
    expect(timerWithBareCodeHandler.particle).toBeUndefined();

    const messageWithBindingsHandler = await statementAt<OnHandler>(
      `process p { on message (code c) { } }`,
    );
    expect(messageWithBindingsHandler.bindings).toHaveLength(1);
    expect(messageWithBindingsHandler.condition).toBeUndefined();

    const bananaWithEveryHandler = await statementAt<OnHandler>(
      `process p { on banana every "x" { } }`,
    );
    expect(bananaWithEveryHandler.trigger).toBe('banana');
    expect(bananaWithEveryHandler.particle).toBe('every');
    expect(bananaWithEveryHandler.time).toBe('x');
  });

  test('the four newly reserved keywords are rejected as bare identifiers in expression position', async () => {
    for (const word of ['on', 'throw', 'emit', 'alongside']) {
      const document = await parse(`process p { if (${word} > 2) { user A } }`);
      expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
    }
  });

  test('the raw-template fallback still parses a reserved event keyword as an identifier', async () => {
    const cond = await parseCondition(`"\${emit}"`);
    expect(cond.$type).toBe('RawExpr');
  });
});

describe('Parsing — header typo guidance', () => {
  test('a mistyped statement keyword in the header region gives the declaration-or-step message', async () => {
    const document = await parse(`process p { usr Review { } }`);
    const messages = document.parseResult.parserErrors.map((e) => e.message);
    expect(
      messages.some(
        (m) => m.includes("'usr'") && m.toLowerCase().includes('error'),
      ),
    ).toBe(true);
    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
  });

  // `ErrorDecl` has two STRING positions (`code`, `message`). When the second
  // one is malformed the token just consumed is the field word `message`, so
  // the header-typo guidance must never blame it. Chevrotain's resync may still
  // cascade a separate complaint about the actual leftover token, which names
  // that token rather than `message`.
  const TYPO_PHRASE = 'neither a known declaration nor a step keyword';
  const blamesFieldWord = (messages: string[]) =>
    messages.some((m) => m.includes("'message'") && m.includes(TYPO_PHRASE));

  test('a genuine `error` declaration with an unquoted message does not blame the field word', async () => {
    const document = await parse(`process p { error "PF" message oops }`);
    const messages = document.parseResult.parserErrors.map((e) => e.message);
    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
    expect(blamesFieldWord(messages)).toBe(false);
  });

  test('a genuine `error` declaration with a missing message does not blame the field word', async () => {
    const document = await parse(`process p { error "PF" message }`);
    const messages = document.parseResult.parserErrors.map((e) => e.message);
    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
    expect(blamesFieldWord(messages)).toBe(false);
  });
});

// ── Expression sub-language parses to a real AST ─────────────────────────

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
    // A method/bean call is outside the parsed subset, so the quoted `${...}`
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

// ── Attribute blocks ─────────────────────────────────────────────────────

describe('Parsing — attribute blocks', () => {
  test('a user task attribute value is a LiteralString, not a RawExpr', async () => {
    const source = `process p { user T "Review" { assignee = "demo" } }`;
    const ut = await statementAt<UserTask>(source);
    expect(ut.attrs).toHaveLength(1);
    expect(ut.attrs[0]!.key).toBe('assignee');
    expect(ut.attrs[0]!.value.$type).toBe('LiteralString');
    expect((ut.attrs[0]!.value as { value: string }).value).toBe('demo');
  });

  test('a service class can be written as a dotted reference', async () => {
    const source = `process p { service A { class = com.example.invoice.AutoApproveDelegate } }`;
    const st = await statementAt<ServiceTask>(source);
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
    const ut = await statementAt<UserTask>(source);
    expect(ut.attrs).toHaveLength(2);
    expect(ut.attrs.map((a) => a.key)).toEqual(['assignee', 'assignee']);
    expect(ut.attrs.map((a) => (a.value as { value: string }).value)).toEqual([
      'a',
      'b',
    ]);
  });

  test('a task with no attribute block has an empty attrs list', async () => {
    const source = `process p { user T "No attrs" }`;
    const ut = await statementAt<UserTask>(source);
    expect(ut.attrs).toHaveLength(0);
  });

  test('a start event and a user task accept a form block', async () => {
    const source = `process p {
  start Begin { form { amount: number "Amount" = 0 } }
  user Approve { assignee = "demo" form { ok: boolean "OK?" } }
}`;
    const document = await parseModel(source);
    const start = document.processes[0]!.body[0] as StartEvent;
    expect(start.forms).toHaveLength(1);
    expect(start.forms[0]!.fields[0]!.id).toBe('amount');
    expect(start.forms[0]!.fields[0]!.type).toBe('number');
    expect(start.forms[0]!.fields[0]!.label).toBe('Amount');
    const user = document.processes[0]!.body[1] as UserTask;
    expect(user.forms[0]!.fields[0]!.id).toBe('ok');
    expect(user.attrs[0]!.key).toBe('assignee');
  });
});

// ── Attribute keys are soft words ────────────────────────────────────────

describe('Parsing — attribute keys stay plain identifiers', () => {
  test('a step, a variable, and a goto target may be spelled like an attribute key', async () => {
    const document = await parseModel(`process p {
  var class: string
  user priority
  service input { class = "com.acme.X" }
  user output
  goto priority
}`);
    const process = document.processes[0]!;
    expect((process.decls[0] as VarDecl).name).toBe('class');
    expect(process.body.map((s) => (s as UserTask).name)).toEqual([
      'priority',
      'input',
      'output',
      undefined,
    ]);
    expect(process.body[3]!.$type).toBe('GotoStatement');
  });

  test('an attribute-key word is an ordinary identifier in expression position', async () => {
    const cond = await parseCondition(`priority > 5`);
    expect(cond.$type).toBe('Relational');
    expect((cond as Relational).left.$type).toBe('VarRef');
  });

  test('`process` is still accepted as the call attribute key', async () => {
    const call = await statementAt<CallActivity>(
      `process p { call C { process = "x" } }`,
    );
    expect(call.attrs).toHaveLength(1);
    expect(call.attrs[0]!.key).toBe('process');
    expect((call.attrs[0]!.value as { value: string }).value).toBe('x');
  });

  test('an unknown attribute key parses; key legality is the validator’s job', async () => {
    const ut = await statementAt<UserTask>(
      `process p { user T { wibble = 1 } }`,
    );
    expect(ut.attrs[0]!.key).toBe('wibble');
  });

  test('a bare `binding = version` parses as a value reference', async () => {
    const call = await statementAt<CallActivity>(
      `process p { call C { process = "x" binding = version } }`,
    );
    expect(call.attrs[1]!.key).toBe('binding');
    expect(call.attrs[1]!.value.$type).toBe('VarRef');
    expect((call.attrs[1]!.value as VarRef).name).toBe('version');
  });
});

// ── The attribute block sits before the body ─────────────────────────────

describe('Parsing — attribute block before the body', () => {
  test('an end event carries an attribute block', async () => {
    const end = await statementAt<EndEvent>(
      `process p { end E { asyncBefore = true } }`,
    );
    expect(end.$type).toBe('EndEvent');
    expect(end.attrs[0]!.key).toBe('asyncBefore');
  });

  test('a script task carries an attribute block before its fence', async () => {
    const script = await statementAt<ScriptTask>(`process p {
  script S { resultVariable = "total" } ${FENCE}js
x = 1
${FENCE}
}`);
    expect(script.$type).toBe('ScriptTask');
    expect(script.attrs[0]!.key).toBe('resultVariable');
    expect(script.body).toContain('x = 1');
  });

  // A lone block is the body, never the attributes.
  test.each([
    [
      '{ asyncBefore = true } { user U { assignee = "demo" } }',
      ['asyncBefore'],
      ['UserTask'],
    ],
    ['{ } { user U }', [], ['UserTask']],
    ['{ user U }', [], ['UserTask']],
    ['{ }', [], []],
  ])(
    '`subprocess S %s` splits its attribute block from its body',
    async (tail, keys, bodyTypes) => {
      const sub = await statementAt<SubProcess>(
        `process p { subprocess S ${tail} }`,
      );
      expect(sub.attrs.map((a) => a.key)).toEqual(keys);
      expect(sub.body.statements.map((s) => s.$type)).toEqual(bodyTypes);
    },
  );

  test('a handler carries an attribute block before its body', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { on error "E" { asyncBefore = true } { user U } }`,
    );
    expect(handler.trigger).toBe('error');
    expect(handler.attrs[0]!.key).toBe('asyncBefore');
    expect(handler.body.statements[0]!.$type).toBe('UserTask');
  });

  test('a hosted alongside handler carries an attribute block before its body', async () => {
    const handler = await statementAt<OnHandler>(
      `process p { user R on R: timer after "PT1H" alongside { asyncBefore = true } { user U } }`,
      1,
    );
    expect(handler.alongside).toBe(true);
    expect(handler.particle).toBe('after');
    expect(handler.attrs[0]!.key).toBe('asyncBefore');
    expect(handler.body.statements).toHaveLength(1);
  });

  test('throw, emit, and await carry a trailing attribute block', async () => {
    const document = await parseModel(`process p {
  throw error "X" { asyncBefore = true }
  emit signal Sig { asyncAfter = true }
  await message "M" { exclusive = false }
}`);
    const [thrown, emitted, awaited] = document.processes[0]!.body as [
      ThrowStatement,
      EmitStatement,
      IntermediateCatchEvent,
    ];
    expect(thrown.attrs[0]!.key).toBe('asyncBefore');
    expect(emitted.attrs[0]!.key).toBe('asyncAfter');
    expect(awaited.attrs[0]!.key).toBe('exclusive');
  });

  test('a statement following a trailing attribute block still parses', async () => {
    const emitThenSub = await parseModel(
      `process p { emit signal Sig subprocess S { user A } }`,
    );
    expect(emitThenSub.processes[0]!.body.map((s) => s.$type)).toEqual([
      'EmitStatement',
      'SubProcess',
    ]);

    const awaitThenSub = await parseModel(
      `process p { await message subprocess S { user A } }`,
    );
    expect(awaitThenSub.processes[0]!.body.map((s) => s.$type)).toEqual([
      'IntermediateCatchEvent',
      'SubProcess',
    ]);

    const parallelEnds = await statementAt<ParallelStatement>(
      `process p { parallel { { end A } { end B } } }`,
    );
    expect(parallelEnds.branches).toHaveLength(2);
    expect(parallelEnds.branches[0]!.statements[0]!.$type).toBe('EndEvent');
    expect(parallelEnds.branches[1]!.statements[0]!.$type).toBe('EndEvent');
  });
});

// ── Input/output parameters ──────────────────────────────────────────────

describe('Parsing — input/output parameters', () => {
  test('a task carries directed, named parameter entries', async () => {
    const ut = await statementAt<UserTask>(
      `process p { user T { input a = 1 output b = "x" } }`,
    );
    expect(ut.params.map((p) => [p.direction, p.name])).toEqual([
      ['input', 'a'],
      ['output', 'b'],
    ]);
    expect(ut.params[0]!.value.$type).toBe('LiteralInt');
    expect(ut.params[1]!.value.$type).toBe('LiteralString');
  });

  test('a list value keeps its items in order', async () => {
    const st = await statementAt<ServiceTask>(
      `process p { service S { input a = [1, 2] } }`,
    );
    const list = st.params[0]!.value as { $type: string; items: AstLike[] };
    expect(list.$type).toBe('ListLiteral');
    expect(list.items.map((i) => i.$type)).toEqual([
      'LiteralInt',
      'LiteralInt',
    ]);
  });

  test('a map value keeps its keyed entries', async () => {
    const st = await statementAt<ServiceTask>(
      `process p { service S { input a = { k: 1 } } }`,
    );
    const map = st.params[0]!.value as {
      $type: string;
      entries: { key: string; value: AstLike }[];
    };
    expect(map.$type).toBe('MapLiteral');
    expect(map.entries[0]!.key).toBe('k');
    expect(map.entries[0]!.value.$type).toBe('LiteralInt');
  });

  test('lists and maps nest inside one another', async () => {
    const st = await statementAt<ServiceTask>(
      `process p { service S { input a = [{ k: 1 }, { k: [2, 3] }] } }`,
    );
    const list = st.params[0]!.value as { items: AstLike[] };
    expect(list.items.map((i) => i.$type)).toEqual([
      'MapLiteral',
      'MapLiteral',
    ]);
    const second = list.items[1] as { entries: { value: AstLike }[] };
    expect(second.entries[0]!.value.$type).toBe('ListLiteral');
  });

  test('an empty list and an empty map parse', async () => {
    const st = await statementAt<ServiceTask>(
      `process p { service S { input a = [] output b = { } } }`,
    );
    expect((st.params[0]!.value as { items: AstLike[] }).items).toHaveLength(0);
    expect(
      (st.params[1]!.value as { entries: AstLike[] }).entries,
    ).toHaveLength(0);
  });

  test('a quoted map key carries its bare text', async () => {
    const st = await statementAt<ServiceTask>(
      `process p { service S { input a = { "k-1": 1 } } }`,
    );
    const map = st.params[0]!.value as { entries: { key: string }[] };
    expect(map.entries[0]!.key).toBe('k-1');
  });

  test('a fenced script is a parameter value', async () => {
    const st = await statementAt<ServiceTask>(`process p {
  service S { input a = ${FENCE}groovy
1 + 1
${FENCE} }
}`);
    const script = st.params[0]!.value as { $type: string; body: string };
    expect(script.$type).toBe('ScriptLiteral');
    expect(script.body).toContain('1 + 1');
  });

  test('a trailing comma in a list or a map is rejected', async () => {
    const list = await parse(`process p { service S { input a = [1, ] } }`);
    expect(list.parseResult.parserErrors.length).toBeGreaterThan(0);
    const map = await parse(`process p { service S { input a = { k: 1, } } }`);
    expect(map.parseResult.parserErrors.length).toBeGreaterThan(0);
  });

  test('a call activity carries variable mappings and parameters together', async () => {
    const call = await statementAt<CallActivity>(
      `process p { call C { process = "p" in a input b = 1 } }`,
    );
    expect(call.attrs[0]!.key).toBe('process');
    expect(call.mappings[0]!.direction).toBe('in');
    expect(call.mappings[0]!.target).toBe('a');
    expect(call.params[0]!.direction).toBe('input');
    expect(call.params[0]!.name).toBe('b');
  });
});

// ── Listeners ────────────────────────────────────────────────────────────

describe('Parsing — listeners', () => {
  test('a task listener binds by class', async () => {
    const ut = await statementAt<UserTask>(
      `process p { user T { on create { class = "com.acme.L" } } }`,
    );
    expect(ut.listeners).toHaveLength(1);
    expect(ut.listeners[0]!.event).toBe('create');
    expect(ut.listeners[0]!.attrs[0]!.key).toBe('class');
  });

  test('the start and end statement keywords are usable as listener events', async () => {
    const st = await statementAt<ServiceTask>(
      `process p { service S { on start { class = "A" } on end { expression = "\${b.m()}" } } }`,
    );
    expect(st.listeners.map((l) => l.event)).toEqual(['start', 'end']);
    expect(st.listeners[1]!.attrs[0]!.value.$type).toBe('RawExpr');
  });

  test('a timeout listener carries a timer particle and its time', async () => {
    const ut = await statementAt<UserTask>(
      `process p { user T { on timeout after "PT1H" { class = "X" } } }`,
    );
    expect(ut.listeners[0]!.event).toBe('timeout');
    expect(ut.listeners[0]!.particle).toBe('after');
    expect(ut.listeners[0]!.time).toBe('PT1H');
  });

  test('a listener binds by an inline fenced script', async () => {
    const ut = await statementAt<UserTask>(`process p {
  user T { on end ${FENCE}groovy
execution.setVariable("x", 1)
${FENCE} }
}`);
    expect(ut.listeners[0]!.event).toBe('end');
    expect(ut.listeners[0]!.script).toContain('setVariable');
    expect(ut.listeners[0]!.attrs).toHaveLength(0);
  });

  test('a listener sits in the attribute block before a subprocess body', async () => {
    const sub = await statementAt<SubProcess>(
      `process p { subprocess S { on start { class = "X" } } { user U } }`,
    );
    expect(sub.listeners[0]!.event).toBe('start');
    expect(sub.body.statements[0]!.$type).toBe('UserTask');
  });

  test('a listener rides an end event and a call activity', async () => {
    const document = await parseModel(`process p {
  call C { process = "q" on start { class = "X" } }
  end E { on end { delegate = "\${bean}" } }
}`);
    const call = document.processes[0]!.body[0] as CallActivity;
    expect(call.listeners[0]!.event).toBe('start');
    const end = document.processes[0]!.body[1] as EndEvent;
    expect(end.listeners[0]!.attrs[0]!.key).toBe('delegate');
  });

  test('scalars, a form block, parameters, and listeners mix in one block', async () => {
    const ut = await statementAt<UserTask>(`process p {
  user T {
    assignee = "demo"
    form { ok: boolean "OK?" }
    input a = 1
    on create { class = "com.acme.L" }
    exclusive = false
  }
}`);
    expect(ut.attrs.map((a) => a.key)).toEqual(['assignee', 'exclusive']);
    expect(ut.forms).toHaveLength(1);
    expect(ut.params).toHaveLength(1);
    expect(ut.listeners).toHaveLength(1);
  });

  test('an on handler still nests inside a subprocess body and another handler body', async () => {
    const sub = await statementAt<SubProcess>(
      `process p { subprocess S { on error "X" { } } }`,
    );
    expect(sub.attrs).toHaveLength(0);
    expect(sub.listeners).toHaveLength(0);
    expect(sub.body.statements[0]!.$type).toBe('OnHandler');

    const outer = await statementAt<OnHandler>(
      `process p { on error "X" { on escalation "Y" { } } }`,
    );
    expect(outer.body.statements[0]!.$type).toBe('OnHandler');
  });
});

// ── Process-header attributes ────────────────────────────────────────────

describe('Parsing — process header attributes', () => {
  test('a header attribute parses before and after a var declaration', async () => {
    const before = await parseModel(`process p "Lbl" {
  versionTag = "1.4"
  var amount: number
  label = "Other"
  error "PF" message "Payment failed"
  start S
}`);
    const decls = before.processes[0]!.decls;
    expect(decls.map((d) => d.$type)).toEqual([
      'ProcessAttribute',
      'VarDecl',
      'ProcessLabel',
      'ErrorDecl',
    ]);
    const attribute = decls[0] as ProcessAttribute;
    expect(attribute.key).toBe('versionTag');
    expect((attribute.value as { value: string }).value).toBe('1.4');

    const after = await parseModel(`process p {
  var amount: number
  versionTag = "2"
  start S
}`);
    expect(after.processes[0]!.decls.map((d) => d.$type)).toEqual([
      'VarDecl',
      'ProcessAttribute',
    ]);
  });
});

// ── var-declaration placement ─────────────────────────────────────────────

describe('Parsing — var placement', () => {
  test("a 'var' after the first statement gives placement guidance", async () => {
    const document = await parse(`process p {
  start Begin
  var amount: number
}`);
    const messages = document.parseResult.parserErrors.map((e) => e.message);
    expect(
      messages.some((m) => m.includes('must come before the first step')),
    ).toBe(true);
    // The confusing raw "Expecting token of type '}'" is not surfaced.
    expect(messages.some((m) => /Expecting token of type/.test(m))).toBe(false);
  });
});

// ── renderExpression round-trip ──────────────────────────────────────────

describe('renderExpression', () => {
  // The RawExpr row is the one that strips the author's surrounding quotes.
  test.each([
    ['amount > 1000', '${amount > 1000}'],
    ['"${bean.method()}"', '${bean.method()}'],
    [
      'order.total > 1000 && items[0] == status',
      '${order.total > 1000 && items[0] == status}',
    ],
    ['flag ? a : b', '${flag ? a : b}'],
  ])('renders `%s` as `%s`', async (source, rendered) => {
    expect(renderExpression(await parseCondition(source))).toBe(rendered);
  });
});

// ── Service bindings, fenced script tasks ────────────────────────────────

describe('Parsing — service bindings, script', () => {
  test.each([
    ['expression', '${bean.method(execution)}'],
    ['delegate', '${beanName}'],
  ])('a %s binding parses; the value is a raw template', async (key, value) => {
    const st = await statementAt<ServiceTask>(
      `process p { service S { ${key} = "${value}" } }`,
    );
    expect(st.$type).toBe('ServiceTask');
    expect(st.attrs[0]!.key).toBe(key);
    expect(st.attrs[0]!.value.$type).toBe('RawExpr');
  });

  test('service task with a topic parses as its fourth binding', async () => {
    const source = `process p { service ship "Ship it" { topic = "shipping" } }`;
    const st = await statementAt<ServiceTask>(source);
    expect(st.$type).toBe('ServiceTask');
    expect(st.name).toBe('ship');
    expect(st.label).toBe('Ship it');
    expect(st.attrs[0]!.key).toBe('topic');
    expect(st.attrs[0]!.value.$type).toBe('LiteralString');
    expect((st.attrs[0]!.value as { value: string }).value).toBe('shipping');
  });

  test('a service task with a topic binding parses without a label', async () => {
    const source = `process p { service ship { topic = "shipping" } }`;
    const st = await statementAt<ServiceTask>(source);
    expect(st.$type).toBe('ServiceTask');
    expect(st.label).toBeUndefined();
  });

  test('`external` parses as an ordinary identifier, not a keyword', async () => {
    const source = `process p {
  var external: string
  user external { assignee = "\${external}" }
}`;
    const document = await parseModel(source);
    const varDecl = document.processes[0]!.decls[0] as {
      $type: string;
      name: string;
    };
    expect(varDecl.$type).toBe('VarDecl');
    expect(varDecl.name).toBe('external');
    const ut = document.processes[0]!.body[0] as UserTask;
    expect(ut.$type).toBe('UserTask');
    expect(ut.name).toBe('external');
  });

  test('script task with a fenced js body parses; body captures the whole fence', async () => {
    const source = `process p {
  script total ${FENCE}js
x = 1
${FENCE}
}`;
    const document = await parseModel(source);
    const body = document.processes[0]!.body;
    expect(body).toHaveLength(1);
    const st = body[0] as ScriptTask;
    expect(st.$type).toBe('ScriptTask');
    expect(st.name).toBe('total');
    // The language tag and script text are extracted downstream; the grammar
    // keeps the block opaque.
    expect(st.body.startsWith(`${FENCE}js`)).toBe(true);
    expect(st.body.endsWith(FENCE)).toBe(true);
    expect(st.body).toContain('x = 1');
  });

  // The backtick fence is a fresh delimiter with no overlap against the
  // quote-delimited STRING / RAW_TEMPLATE terminals.
  test('a fenced script coexists with a class bareword and a raw template — no lex ambiguity', async () => {
    const source = `process p {
  service Auto { class = com.acme.X }
  user Review { assignee = "\${bean.pick()}" }
  script total ${FENCE}js
y = 2
${FENCE}
}`;
    const document = await parseModel(source);
    const body = document.processes[0]!.body;
    expect(body.map((s) => s.$type)).toEqual([
      'ServiceTask',
      'UserTask',
      'ScriptTask',
    ]);
    // The class value is a bareword path (VarRef), the assignee a "${...}" raw
    // template (RawExpr); neither is disturbed by the neighbouring fence.
    expect((body[0] as ServiceTask).attrs[0]!.value.$type).toBe('VarRef');
    expect((body[1] as UserTask).attrs[0]!.value.$type).toBe('RawExpr');
  });

  test('DSL-looking text inside a fence is captured, not parsed as DSL', async () => {
    const source = `process p {
  script guard ${FENCE}js
if (a) { }
${FENCE}
}`;
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const body = document.parseResult.value.processes[0]!.body;
    expect(body).toHaveLength(1);
    expect(body[0]!.$type).toBe('ScriptTask');
    expect((body[0] as ScriptTask).body).toContain('if (a) { }');
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
 * Parse `source`, assert it parsed cleanly, and return the root `Model`.
 */
async function parseModel(source: string): Promise<Model> {
  const document = await parse(source);
  expect(formatParseFailure(document)).toBeUndefined();
  return document.parseResult.value;
}

/**
 * Parse `source` and return the statement at `index` in the first process
 * body, narrowed to the expected node type.
 */
async function statementAt<T>(source: string, index = 0): Promise<T> {
  return (await parseModel(source)).processes[0]!.body[index] as T;
}
