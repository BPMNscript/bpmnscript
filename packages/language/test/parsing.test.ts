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
  UserTask,
  SubProcess,
  LiteralInt,
  VarRef,
  ServiceTask,
  ScriptTask,
  GenericTask,
  SendTask,
  ReceiveTask,
  BusinessRuleTask,
  CallActivity,
} from '@bpmn-script/language';
import {
  createBpmnScriptServices,
  isModel,
  renderExpression,
} from '@bpmn-script/language';

/** Every statement the repeat clause attaches to. */
type Repeatable =
  | UserTask
  | ServiceTask
  | ScriptTask
  | GenericTask
  | SendTask
  | ReceiveTask
  | BusinessRuleTask
  | SubProcess
  | CallActivity;

let services: ReturnType<typeof createBpmnScriptServices>;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/**
 * A parsed subtree written as `Type(prop=value, ...)`, with a cross-reference
 * as `->target`. Only the properties the source actually set appear: a slot
 * left empty, a flag left off, and an empty list are all dropped. One string
 * therefore pins the filled slots, the empty ones, and any node the parser
 * invented along the way.
 */
function shape(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(shape).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (typeof node.$refText === 'string') {
      return `->${node.$refText}`;
    }
    const props = Object.entries(node)
      .filter(
        ([key, member]) =>
          !key.startsWith('$') &&
          member !== undefined &&
          member !== false &&
          !(Array.isArray(member) && member.length === 0),
      )
      .map(([key, member]) => `${key}=${shape(member)}`);
    return props.length
      ? `${node.$type}(${props.join(', ')})`
      : String(node.$type);
  }
  return JSON.stringify(value);
}

/** Parse `source`, assert it parsed cleanly, and return the root `Model`. */
async function parseModel(source: string): Promise<Model> {
  const document = await parse(source);
  expect(formatParseFailure(document)).toBeUndefined();
  return document.parseResult.value;
}

/** Every lexer and parser error `source` produces, in the order raised. */
async function parseErrors(source: string): Promise<string[]> {
  const { lexerErrors, parserErrors } = (await parse(source)).parseResult;
  return [...lexerErrors, ...parserErrors].map((e) => e.message);
}

/** `source` parses to one process named `p` whose body is exactly `body`. */
async function expectBody(source: string, body: string) {
  const model = await parseModel(source);
  expect(model.processes).toHaveLength(1);
  expect(shape(model.processes[0]!)).toBe(`Process(name="p", body=${body})`);
}

/** `source` parses to one process shaped exactly like `process`. */
async function expectProcess(source: string, process: string) {
  const model = await parseModel(source);
  expect(model.processes).toHaveLength(1);
  expect(shape(model.processes[0]!)).toBe(process);
}

/**
 * Parse a bare expression by wrapping it as the condition of an `if`, then
 * return the parsed condition AST node.
 */
async function parseCondition(expr: string) {
  const model = await parseModel(`process p { if (${expr}) { user A } }`);
  return (model.processes[0]!.body[0] as IfStatement).condition;
}

/** Parse `source` and return the statement at `index` in the first process. */
async function statementAt<T>(source: string, index = 0): Promise<T> {
  return (await parseModel(source)).processes[0]!.body[index] as T;
}

/** A row of the shape tables: a title, a program, and the AST it parses to. */
type Row = readonly [title: string, source: string, expected: string];

describe('Parsing - process header', () => {
  test('a realistic multi-construct process parses with zero lexer/parser errors', async () => {
    const document = await parseModel(
      `
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
`.trim(),
    );
    expect(isModel(document)).toBe(true);
    expect(document.processes).toHaveLength(1);
  });

  test.each<Row>([
    [
      'the process id and the quoted label land in their own slots',
      `process p "My Process" { start S end E }`,
      'Process(name="p", label="My Process", body=[StartEvent(name="S"), EndEvent(name="E")])',
    ],
    [
      'declarations are gathered into decls and executable statements into body',
      `process p "Lbl" {
  label = "Other Label"
  var amount: number
  var flag: boolean
  start S
  end E
}`,
      'Process(name="p", label="Lbl", decls=[ProcessLabel(value="Other Label"), VarDecl(name="amount", type="number"), VarDecl(name="flag", type="boolean")], body=[StartEvent(name="S"), EndEvent(name="E")])',
    ],
    [
      'every VarType keyword parses',
      `process p {
  var a: string
  var b: number
  var c: boolean
  var d: date
  var e: json
  var f: any
  start S
}`,
      'Process(name="p", decls=[VarDecl(name="a", type="string"), VarDecl(name="b", type="number"), VarDecl(name="c", type="boolean"), VarDecl(name="d", type="date"), VarDecl(name="e", type="json"), VarDecl(name="f", type="any")], body=[StartEvent(name="S")])',
    ],
    [
      'a header attribute and an error declaration parse before a var declaration',
      `process p "Lbl" {
  versionTag = "1.4"
  var amount: number
  label = "Other"
  error "PF" message "Payment failed"
  start S
}`,
      'Process(name="p", label="Lbl", decls=[ProcessAttribute(key="versionTag", value=LiteralString(value="1.4")), VarDecl(name="amount", type="number"), ProcessLabel(value="Other"), ErrorDecl(kind="error", code="PF", field="message", message="Payment failed")], body=[StartEvent(name="S")])',
    ],
    [
      'a header attribute parses after a var declaration too',
      `process p {
  var amount: number
  versionTag = "2"
  start S
}`,
      'Process(name="p", decls=[VarDecl(name="amount", type="number"), ProcessAttribute(key="versionTag", value=LiteralString(value="2"))], body=[StartEvent(name="S")])',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectProcess(source, expected);
  });
});

describe('Parsing - control flow and containers', () => {
  test.each<Row>([
    [
      'three bare statements parse into three statements in source order',
      `process p { user A user B user C }`,
      '[UserTask(name="A"), UserTask(name="B"), UserTask(name="C")]',
    ],
    [
      'an if with two else-ifs and an else populates elseIfs and elseBlock',
      `process p {
  if (a) { user A }
  else if (b) { user B }
  else if (c) { user C }
  else { user D }
}`,
      '[IfStatement(condition=VarRef(name="a"), then=Block(statements=[UserTask(name="A")]), elseIfs=[ElseIf(condition=VarRef(name="b"), body=Block(statements=[UserTask(name="B")])), ElseIf(condition=VarRef(name="c"), body=Block(statements=[UserTask(name="C")]))], elseBlock=Block(statements=[UserTask(name="D")]))]',
    ],
    [
      'a plain if leaves elseIfs empty and elseBlock unset',
      `process p { if (a) { user A } }`,
      '[IfStatement(condition=VarRef(name="a"), then=Block(statements=[UserTask(name="A")]))]',
    ],
    [
      'a while loop carries its condition and a one-statement body',
      `process p { while (rejected) { user R } }`,
      '[WhileStatement(condition=VarRef(name="rejected"), body=Block(statements=[UserTask(name="R")]))]',
    ],
    [
      'a do-while loop carries its body before its condition',
      `process p { do { user R } while (again) }`,
      '[DoWhileStatement(body=Block(statements=[UserTask(name="R")]), condition=VarRef(name="again"))]',
    ],
    [
      'a parallel branch head is a condition, nothing, or else',
      `process p { parallel { if (amount > 10000) { user A } { service B } else { user C } } }`,
      '[ParallelStatement(branches=[ParallelBranch(condition=Relational(left=VarRef(name="amount"), op=">", right=LiteralInt(value=10000)), body=Block(statements=[UserTask(name="A")])), ParallelBranch(body=Block(statements=[ServiceTask(name="B")])), ParallelBranch(otherwise=true, body=Block(statements=[UserTask(name="C")]))])]',
    ],
    [
      'parallel supports more than two branches, each unconditioned',
      `process p { parallel { { user A } { user B } { user C } } }`,
      '[ParallelStatement(branches=[ParallelBranch(body=Block(statements=[UserTask(name="A")])), ParallelBranch(body=Block(statements=[UserTask(name="B")])), ParallelBranch(body=Block(statements=[UserTask(name="C")]))])]',
    ],
    [
      'a branch head and a branch body opening with if are told apart',
      `process p { parallel { { if (a) { user A } else { user B } } { user C } } }`,
      '[ParallelStatement(branches=[ParallelBranch(body=Block(statements=[IfStatement(condition=VarRef(name="a"), then=Block(statements=[UserTask(name="A")]), elseBlock=Block(statements=[UserTask(name="B")]))])), ParallelBranch(body=Block(statements=[UserTask(name="C")]))])]',
    ],
    [
      'a branch body holding only an end event parses',
      `process p { parallel { { end A } { end B } } }`,
      '[ParallelStatement(branches=[ParallelBranch(body=Block(statements=[EndEvent(name="A")])), ParallelBranch(body=Block(statements=[EndEvent(name="B")]))])]',
    ],
    [
      'a labeled subprocess carries its body statements',
      `process p { subprocess Handle "Handle order" { user Review { assignee = "demo" } } }`,
      '[SubProcess(name="Handle", label="Handle order", body=Block(statements=[UserTask(name="Review", attrs=[Attribute(key="assignee", value=LiteralString(value="demo"))])]))]',
    ],
    [
      'explicit start/end inside a subprocess body parse as ordinary events',
      `process p { subprocess S { start In user A end Out } }`,
      '[SubProcess(name="S", body=Block(statements=[StartEvent(name="In"), UserTask(name="A"), EndEvent(name="Out")]))]',
    ],
    [
      'a subprocess nests inside a subprocess',
      `process p { subprocess Outer { subprocess Inner { user A } } }`,
      '[SubProcess(name="Outer", body=Block(statements=[SubProcess(name="Inner", body=Block(statements=[UserTask(name="A")]))]))]',
    ],
    [
      'a subprocess nests inside an if block',
      `process p { if (a) { subprocess S { user A } } }`,
      '[IfStatement(condition=VarRef(name="a"), then=Block(statements=[SubProcess(name="S", body=Block(statements=[UserTask(name="A")]))]))]',
    ],
    [
      'an empty subprocess body parses with no statements and no label',
      `process p { subprocess S { } }`,
      '[SubProcess(name="S", body=Block)]',
    ],
    [
      'attempt shares the subprocess node type and differs only by the flag',
      `process p { attempt A { } }`,
      '[SubProcess(transactional=true, name="A", body=Block)]',
    ],
    [
      'an attempt head takes a label, a repeat clause, a settings block and a body',
      `process p { attempt A "Book and pay" for each line in lines { asyncBefore = true } { user U } }`,
      '[SubProcess(transactional=true, name="A", label="Book and pay", element="line", collection=VarRef(name="lines"), attrs=[Attribute(key="asyncBefore", value=LiteralBool(value="true"))], body=Block(statements=[UserTask(name="U")]))]',
    ],
    [
      'an attempt nests in a subprocess body and in another attempt',
      `process p { subprocess S { attempt A { attempt B { user U } } } }`,
      '[SubProcess(name="S", body=Block(statements=[SubProcess(transactional=true, name="A", body=Block(statements=[SubProcess(transactional=true, name="B", body=Block(statements=[UserTask(name="U")]))]))]))]',
    ],
    [
      'an attempt nests in a handler body',
      `process p { on error "E" { attempt A { user U } } }`,
      '[OnHandler(trigger="error", code="E", body=Block(statements=[SubProcess(transactional=true, name="A", body=Block(statements=[UserTask(name="U")]))]))]',
    ],
    [
      'the body after an attempt head parses as its own statements, in order',
      `process p { attempt A { user U end E } }`,
      '[SubProcess(transactional=true, name="A", body=Block(statements=[UserTask(name="U"), EndEvent(name="E")]))]',
    ],
    [
      'a full call activity carries its attributes and every mapping shape',
      `process p { call Fulfilment "Fulfil order" {
  process = "fulfilment-process"
  binding = deployment
  businessKey = "\${execution.processBusinessKey}"
  in *
  in orderId
  in total = amount + tax
  in local vip = vipFlag
  out shipmentId
  out shipped = confirmed
} }`,
      '[CallActivity(name="Fulfilment", label="Fulfil order", attrs=[Attribute(key="process", value=LiteralString(value="fulfilment-process")), Attribute(key="binding", value=VarRef(name="deployment")), Attribute(key="businessKey", value=RawExpr(raw="\\"${execution.processBusinessKey}\\""))], mappings=[VariableMapping(direction="in", all=true), VariableMapping(direction="in", target="orderId"), VariableMapping(direction="in", target="total", source=Additive(left=VarRef(name="amount"), op="+", right=VarRef(name="tax"))), VariableMapping(direction="in", local=true, target="vip", source=VarRef(name="vipFlag")), VariableMapping(direction="out", target="shipmentId"), VariableMapping(direction="out", target="shipped", source=VarRef(name="confirmed"))])]',
    ],
    [
      'an integer attribute value is a LiteralInt',
      `process p { call C { version = 3 } }`,
      '[CallActivity(name="C", attrs=[Attribute(key="version", value=LiteralInt(value=3))])]',
    ],
    [
      'a raw-template attribute value is a RawExpr',
      `process p { call C { version = "\${v}" } }`,
      '[CallActivity(name="C", attrs=[Attribute(key="version", value=RawExpr(raw="\\"${v}\\""))])]',
    ],
    [
      'a minimal call with only `process` parses and carries no mappings',
      `process p { call X { process = "p" } }`,
      '[CallActivity(name="X", attrs=[Attribute(key="process", value=LiteralString(value="p"))])]',
    ],
    [
      "an empty call body parses; a missing `process` is the validator's concern",
      `process p { call X { } }`,
      '[CallActivity(name="X")]',
    ],
    [
      'a call nests inside an if block',
      `process p { if (a) { call X { process = "p" } } }`,
      '[IfStatement(condition=VarRef(name="a"), then=Block(statements=[CallActivity(name="X", attrs=[Attribute(key="process", value=LiteralString(value="p"))])]))]',
    ],
    [
      'a call nests inside a subprocess body',
      `process p { subprocess S { call X { process = "p" } } }`,
      '[SubProcess(name="S", body=Block(statements=[CallActivity(name="X", attrs=[Attribute(key="process", value=LiteralString(value="p"))])]))]',
    ],
    [
      'a call carries variable mappings and parameters together',
      `process p { call C { process = "p" in a input b = 1 } }`,
      '[CallActivity(name="C", attrs=[Attribute(key="process", value=LiteralString(value="p"))], mappings=[VariableMapping(direction="in", target="a")], params=[IoParameter(direction="input", name="b", value=LiteralInt(value=1))])]',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });
});

describe('Parsing - the event layer', () => {
  test.each<Row>([
    [
      'a full interrupting handler carries a trigger, a code, two bindings, and a body',
      `process p {
  on error "PAYMENT_FAILED" (code c, message m) { service R { class = "x.Y" } }
}`,
      '[OnHandler(trigger="error", code="PAYMENT_FAILED", bindings=[EventBinding(field="code", variable="c"), EventBinding(field="message", variable="m")], body=Block(statements=[ServiceTask(name="R", attrs=[Attribute(key="class", value=LiteralString(value="x.Y"))])]))]',
    ],
    [
      'a message handler takes a name and no particle, condition, or bindings',
      `process p { on message "PaymentReceived" { user Review { assignee = "demo" } } }`,
      '[OnHandler(trigger="message", code="PaymentReceived", body=Block(statements=[UserTask(name="Review", attrs=[Attribute(key="assignee", value=LiteralString(value="demo"))])]))]',
    ],
    [
      'alongside marks a signal handler as non-interrupting',
      `process p { on signal "Cancelled" alongside { } }`,
      '[OnHandler(trigger="signal", code="Cancelled", alongside=true, body=Block)]',
    ],
    [
      'alongside follows a binding list on an escalation handler',
      `process p { on escalation "X" (code v) alongside { } }`,
      '[OnHandler(trigger="escalation", code="X", bindings=[EventBinding(field="code", variable="v")], alongside=true, body=Block)]',
    ],
    [
      'a catch-all error handler omits the code',
      `process p { on error { } }`,
      '[OnHandler(trigger="error", body=Block)]',
    ],
    [
      'a catch-all escalation handler omits the code',
      `process p { on escalation { } }`,
      '[OnHandler(trigger="escalation", body=Block)]',
    ],
    [
      '`on timer after` keeps its particle and time',
      `process p { on timer after "PT1H" { } }`,
      '[OnHandler(trigger="timer", particle="after", time="PT1H", body=Block)]',
    ],
    [
      '`on timer at` keeps its particle and time',
      `process p { on timer at "2026-08-01T09:00:00" alongside { } }`,
      '[OnHandler(trigger="timer", particle="at", time="2026-08-01T09:00:00", alongside=true, body=Block)]',
    ],
    [
      '`on timer every` keeps its particle and time',
      `process p { on timer every "R/PT10M" alongside { } }`,
      '[OnHandler(trigger="timer", particle="every", time="R/PT10M", alongside=true, body=Block)]',
    ],
    [
      'an EL time template reaches the time slot without the surrounding quotes',
      `process p { on timer after "\${dueDate}" { } }`,
      '[OnHandler(trigger="timer", particle="after", time="${dueDate}", body=Block)]',
    ],
    [
      'a relational condition handler parses its parens to an expression, not bindings',
      `process p { on condition (amount > 100) { } }`,
      '[OnHandler(trigger="condition", condition=Relational(left=VarRef(name="amount"), op=">", right=LiteralInt(value=100)), body=Block)]',
    ],
    [
      'a lone identifier in the parens is a condition, not a binding attempt',
      `process p { on condition (approved) { } }`,
      '[OnHandler(trigger="condition", condition=VarRef(name="approved"), body=Block)]',
    ],
    [
      'a quoted raw template in the parens is a RawExpr condition',
      `process p { on condition ("\${bean.check()}") { } }`,
      '[OnHandler(trigger="condition", condition=RawExpr(raw="\\"${bean.check()}\\""), body=Block)]',
    ],
    [
      'alongside is legal on a condition handler',
      `process p { on condition (amount > limit) alongside { } }`,
      '[OnHandler(trigger="condition", condition=Relational(left=VarRef(name="amount"), op=">", right=VarRef(name="limit")), alongside=true, body=Block)]',
    ],
    [
      'a host-less handler leaves the host slot empty',
      `process p { on error "X" { } }`,
      '[OnHandler(trigger="error", code="X", body=Block)]',
    ],
    [
      'a hosted timer keeps its particle and time, with the host separate from both',
      `process p { user Review on Review: timer after "PT2H" { } }`,
      '[UserTask(name="Review"), OnHandler(host=->Review, trigger="timer", particle="after", time="PT2H", body=Block)]',
    ],
    [
      'a hosted handler carries a code, bindings and a body as a host-less one does',
      `process p {
  user Pack
  on Pack: error "OUT_OF_STOCK" (code c, message m) { service R { class = "x.Y" } }
}`,
      '[UserTask(name="Pack"), OnHandler(host=->Pack, trigger="error", code="OUT_OF_STOCK", bindings=[EventBinding(field="code", variable="c"), EventBinding(field="message", variable="m")], body=Block(statements=[ServiceTask(name="R", attrs=[Attribute(key="class", value=LiteralString(value="x.Y"))])]))]',
    ],
    [
      'a hosted handler takes a parenthesized condition, and alongside after it',
      `process p { user Review on Review: condition (amount > 100) alongside { } }`,
      '[UserTask(name="Review"), OnHandler(host=->Review, trigger="condition", condition=Relational(left=VarRef(name="amount"), op=">", right=LiteralInt(value=100)), alongside=true, body=Block)]',
    ],
    [
      'alongside is legal on a hosted handler with a code',
      `process p { user Review on Review: message "Cancelled" alongside { } }`,
      '[UserTask(name="Review"), OnHandler(host=->Review, trigger="message", code="Cancelled", alongside=true, body=Block)]',
    ],
    // The host and the trigger are both bare IDs, so every trigger word is
    // pinned on its own: the word before the colon is the host, the one after
    // it the trigger.
    ...(
      [
        'error',
        'escalation',
        'message',
        'signal',
        'timer',
        'condition',
        'compensation',
      ] as const
    ).map((trigger): Row => [
      `\`on Review: ${trigger}\` reads the host before the colon and the trigger after it`,
      `process p { on Review: ${trigger} { } }`,
      `[OnHandler(host=->Review, trigger="${trigger}", body=Block)]`,
    ]),
    [
      'throw error is a terminal statement carrying a code',
      `process p { throw error "C" }`,
      '[ThrowStatement(trigger="error", code="C")]',
    ],
    [
      'throw escalation is a terminal statement carrying a code',
      `process p { throw escalation "C" }`,
      '[ThrowStatement(trigger="escalation", code="C")]',
    ],
    [
      'an explicit id before the code is optional on throw',
      `process p { throw error Failed "C" }`,
      '[ThrowStatement(trigger="error", name="Failed", code="C")]',
    ],
    [
      'throw signal parses bare',
      `process p { throw signal "S" }`,
      '[ThrowStatement(trigger="signal", code="S")]',
    ],
    [
      'throw signal parses with an explicit id',
      `process p { throw signal Sent "S" }`,
      '[ThrowStatement(trigger="signal", name="Sent", code="S")]',
    ],
    [
      'emit signal parses bare',
      `process p { emit signal "S" }`,
      '[EmitStatement(trigger="signal", code="S")]',
    ],
    [
      'emit signal parses with an explicit id',
      `process p { emit signal Ping "S" }`,
      '[EmitStatement(trigger="signal", name="Ping", code="S")]',
    ],
    [
      'emit escalation parses bare; one-token lookahead places the code',
      `process p { emit escalation "C" }`,
      '[EmitStatement(trigger="escalation", code="C")]',
    ],
    [
      'emit escalation parses with an explicit id',
      `process p { emit escalation Ping "C" }`,
      '[EmitStatement(trigger="escalation", name="Ping", code="C")]',
    ],
    [
      "emit error parses; the impossible verb/kind pair is the validator's job",
      `process p { emit error "C" }`,
      '[EmitStatement(trigger="error", code="C")]',
    ],
    [
      'a bare `throw compensation` carries no name and no code',
      `process p { throw compensation }`,
      '[ThrowStatement(trigger="compensation")]',
    ],
    [
      'a bare `emit compensation` carries no name and no code',
      `process p { emit compensation }`,
      '[EmitStatement(trigger="compensation")]',
    ],
    [
      'a named `throw compensation` carries a name but no code',
      `process p { throw compensation Undo }`,
      '[ThrowStatement(trigger="compensation", name="Undo")]',
    ],
    [
      'a named `emit compensation` carries a name but no code',
      `process p { emit compensation Ping }`,
      '[EmitStatement(trigger="compensation", name="Ping")]',
    ],
    [
      'a code-less throw parses for a trigger that normally takes one',
      `process p { throw error }`,
      '[ThrowStatement(trigger="error")]',
    ],
    [
      'a code-less emit parses for a trigger that normally takes one',
      `process p { emit signal }`,
      '[EmitStatement(trigger="signal")]',
    ],
    [
      "an unknown trigger word parses; word legality is the validator's job",
      `process p { throw banana }`,
      '[ThrowStatement(trigger="banana")]',
    ],
    [
      'a statement following a code-less throw is not swallowed as its name',
      `process p { throw compensation service R { class = "x.Y" } }`,
      '[ThrowStatement(trigger="compensation"), ServiceTask(name="R", attrs=[Attribute(key="class", value=LiteralString(value="x.Y"))])]',
    ],
    [
      '`on compensation` parses with no code, particle, bindings or condition',
      `process p { on compensation { } }`,
      '[OnHandler(trigger="compensation", body=Block)]',
    ],
    [
      '`on compensation "X"` parses; the validator rejects it later',
      `process p { on compensation "X" { } }`,
      '[OnHandler(trigger="compensation", code="X", body=Block)]',
    ],
    [
      '`on compensation alongside` parses; the validator rejects it later',
      `process p { on compensation alongside { } }`,
      '[OnHandler(trigger="compensation", alongside=true, body=Block)]',
    ],
    [
      '`await message` takes a required name string',
      `process p { await message "Invoice Received" }`,
      '[IntermediateCatchEvent(trigger="message", code="Invoice Received")]',
    ],
    [
      '`await signal` takes a required name string',
      `process p { await signal "Ready" }`,
      '[IntermediateCatchEvent(trigger="signal", code="Ready")]',
    ],
    [
      '`await timer after` keeps its particle; the particle is never read as a name',
      `process p { await timer after "PT1H" }`,
      '[IntermediateCatchEvent(trigger="timer", particle="after", time="PT1H")]',
    ],
    [
      '`await timer at` keeps its particle and time',
      `process p { await timer at "2026-08-01T09:00:00" }`,
      '[IntermediateCatchEvent(trigger="timer", particle="at", time="2026-08-01T09:00:00")]',
    ],
    [
      '`await timer every` keeps its particle and time',
      `process p { await timer every "R/PT10M" }`,
      '[IntermediateCatchEvent(trigger="timer", particle="every", time="R/PT10M")]',
    ],
    [
      '`await condition` parses the same expression AST an if condition does',
      `process p { await condition (amount > 100) }`,
      '[IntermediateCatchEvent(trigger="condition", condition=Relational(left=VarRef(name="amount"), op=">", right=LiteralInt(value=100)))]',
    ],
    [
      'a race carries one trigger header per branch and does not swallow what follows',
      `process p { await { message "M" { service S } timer after "P3D" { user U } } user W }`,
      '[RaceStatement(branches=[RaceBranch(trigger="message", code="M", body=Block(statements=[ServiceTask(name="S")])), RaceBranch(trigger="timer", particle="after", time="P3D", body=Block(statements=[UserTask(name="U")]))]), UserTask(name="W")]',
    ],
    [
      'the first brace after a branch header is a settings block only when it holds settings',
      `process p { await { signal "S" { asyncBefore = true } { service P } message "M" { } condition (x) { end E } } }`,
      '[RaceStatement(branches=[RaceBranch(trigger="signal", code="S", attrs=[Attribute(key="asyncBefore", value=LiteralBool(value="true"))], body=Block(statements=[ServiceTask(name="P")])), RaceBranch(trigger="message", code="M", body=Block), RaceBranch(trigger="condition", condition=VarRef(name="x"), body=Block(statements=[EndEvent(name="E")]))])]',
    ],
    [
      '`start S timer after` keeps its particle and time in their own slots',
      `process p { start S timer after "PT1H" }`,
      '[StartEvent(name="S", trigger="timer", particle="after", time="PT1H")]',
    ],
    [
      '`start S timer at` keeps its particle and time in their own slots',
      `process p { start S timer at "2026-08-01T09:00:00" }`,
      '[StartEvent(name="S", trigger="timer", particle="at", time="2026-08-01T09:00:00")]',
    ],
    [
      '`start S timer every` keeps its particle and time in their own slots',
      `process p { start S timer every "R/PT10M" }`,
      '[StartEvent(name="S", trigger="timer", particle="every", time="R/PT10M")]',
    ],
    [
      'a label before the trigger fills the label slot, not the trigger one',
      `process p { start S "Scheduled" message "M" }`,
      '[StartEvent(name="S", label="Scheduled", trigger="message", code="M")]',
    ],
    [
      'a template time on a start reaches the time slot unquoted',
      'process p { start S timer after "${deadline}" }',
      '[StartEvent(name="S", trigger="timer", particle="after", time="${deadline}")]',
    ],
    [
      'an end event takes a label and a terminate word, and no code',
      `process p { end E "All stop" terminate }`,
      '[EndEvent(name="E", label="All stop", trigger="terminate")]',
    ],
    [
      'a triggered start does not swallow the statement following it',
      `process p {
  start S timer after "PT1H"
  user U
  end E terminate
}`,
      '[StartEvent(name="S", trigger="timer", particle="after", time="PT1H"), UserTask(name="U"), EndEvent(name="E", trigger="terminate")]',
    ],
    [
      'an on handler nests inside a subprocess body',
      `process p { subprocess S { on error "X" { } } }`,
      '[SubProcess(name="S", body=Block(statements=[OnHandler(trigger="error", code="X", body=Block)]))]',
    ],
    [
      'an on handler nests inside another on handler body',
      `process p { on error "X" { on escalation "Y" { } } }`,
      '[OnHandler(trigger="error", code="X", body=Block(statements=[OnHandler(trigger="escalation", code="Y", body=Block)]))]',
    ],
    [
      'throw and emit nest inside an if block',
      `process p { if (a) { throw error "X" } else { emit escalation "Y" } }`,
      '[IfStatement(condition=VarRef(name="a"), then=Block(statements=[ThrowStatement(trigger="error", code="X")]), elseBlock=Block(statements=[EmitStatement(trigger="escalation", code="Y")]))]',
    ],
    [
      'an explicit start as the first statement of an on body parses',
      `process p { on error "X" { start In } }`,
      '[OnHandler(trigger="error", code="X", body=Block(statements=[StartEvent(name="In")]))]',
    ],
    [
      "an unknown trigger word on a handler parses; legality is the validator's job",
      `process p { on banana "X" { } }`,
      '[OnHandler(trigger="banana", code="X", body=Block)]',
    ],
    [
      "an unknown binding field parses; legality is the validator's job",
      `process p { on error "X" (coed c) { } }`,
      '[OnHandler(trigger="error", code="X", bindings=[EventBinding(field="coed", variable="c")], body=Block)]',
    ],
    [
      'a particle after a non-timer trigger parses into the particle slot',
      `process p { on error after "x" { } }`,
      '[OnHandler(trigger="error", particle="after", time="x", body=Block)]',
    ],
    [
      'a bare code after a timer trigger parses into the code slot',
      `process p { on timer "PT1H" { } }`,
      '[OnHandler(trigger="timer", code="PT1H", body=Block)]',
    ],
    [
      'a binding list after a message trigger parses as bindings, not a condition',
      `process p { on message (code c) { } }`,
      '[OnHandler(trigger="message", bindings=[EventBinding(field="code", variable="c")], body=Block)]',
    ],
    [
      'an unknown trigger word takes a particle and a time like any other',
      `process p { on banana every "x" { } }`,
      '[OnHandler(trigger="banana", particle="every", time="x", body=Block)]',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });
});

describe('Parsing - soft words stay plain identifiers', () => {
  // Trigger words, timer particles, attribute keys and parameter directions
  // all lex as plain `ID`, so each stays available as a variable name, a step
  // name, and a bare identifier in expression position.
  test.each<Row>([
    ...(
      [
        'message',
        'code',
        'compensation',
        'at',
        'timer',
        'condition',
        'external',
      ] as const
    ).map((word): Row => [
      `\`${word}\` names a variable`,
      `process p { var ${word}: string start S }`,
      `Process(name="p", decls=[VarDecl(name="${word}", type="string")], body=[StartEvent(name="S")])`,
    ]),
    ...(['error', 'every', 'compensation', 'external'] as const).map(
      (word): Row => [
        `\`${word}\` names a step`,
        `process p { user ${word} }`,
        `Process(name="p", body=[UserTask(name="${word}")])`,
      ],
    ),
    [
      'a step, a variable, and a goto target may be spelled like an attribute key',
      `process p {
  var class: string
  user priority
  service input { class = "com.acme.X" }
  user output
  goto priority
}`,
      'Process(name="p", decls=[VarDecl(name="class", type="string")], body=[UserTask(name="priority"), ServiceTask(name="input", attrs=[Attribute(key="class", value=LiteralString(value="com.acme.X"))]), UserTask(name="output"), GotoStatement(target=->priority)])',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectProcess(source, expected);
  });
});

describe('Parsing - expressions', () => {
  test.each<Row>([
    [
      '`amount > 1000` parses to a Relational node whose operands are nodes, not strings',
      'amount > 1000',
      'Relational(left=VarRef(name="amount"), op=">", right=LiteralInt(value=1000))',
    ],
    [
      '`order.total` parses to a VarRef with one dot-accessor',
      'order.total',
      'VarRef(name="order", accessors=[Accessor(prop="total")])',
    ],
    [
      '`items[0]` parses to a VarRef with an index-accessor',
      'items[0]',
      'VarRef(name="items", accessors=[Accessor(index=LiteralInt(value=0))])',
    ],
    [
      'a method call falls back to the quoted raw template, quotes and all',
      '"${bean.method()}"',
      'RawExpr(raw="\\"${bean.method()}\\"")',
    ],
    [
      'a ternary parses to a Ternary node over three expressions',
      'flag ? a : b',
      'Ternary(condition=VarRef(name="flag"), whenTrue=VarRef(name="a"), whenFalse=VarRef(name="b"))',
    ],
    [
      'identifiers outside the reserved set lex as VarRef even where they name keys elsewhere',
      'status == active',
      'Equality(left=VarRef(name="status"), op="==", right=VarRef(name="active"))',
    ],
    [
      'a reserved-looking property name is an ordinary dot-accessor',
      'order.type',
      'VarRef(name="order", accessors=[Accessor(prop="type")])',
    ],
    ...(
      [
        'priority',
        'binding',
        'version',
        'businessKey',
        'after',
        'compensation',
      ] as const
    ).map((word): Row => [
      `\`${word}\` is an ordinary identifier in expression position`,
      `${word} > 2`,
      `Relational(left=VarRef(name="${word}"), op=">", right=LiteralInt(value=2))`,
    ]),
    [
      'the raw-template fallback carries a reserved word as an identifier',
      '"${version > 2}"',
      'RawExpr(raw="\\"${version > 2}\\"")',
    ],
    [
      'the raw-template fallback carries a reserved event keyword as an identifier',
      '"${emit}"',
      'RawExpr(raw="\\"${emit}\\"")',
    ],
    [
      'an equality over a soft event word parses',
      'error == "x"',
      'Equality(left=VarRef(name="error"), op="==", right=LiteralString(value="x"))',
    ],
  ])('%s', async (_title, expr, expected) => {
    expect(shape(await parseCondition(expr))).toBe(expected);
  });

  // The RawExpr row is the one that strips the author's surrounding quotes.
  test.each([
    ['amount > 1000', '${amount > 1000}'],
    ['"${bean.method()}"', '${bean.method()}'],
    [
      'order.total > 1000 && items[0] == status',
      '${order.total > 1000 && items[0] == status}',
    ],
    ['flag ? a : b', '${flag ? a : b}'],
    [
      'com.example.invoice.AutoApproveDelegate',
      '${com.example.invoice.AutoApproveDelegate}',
    ],
  ])('renderExpression renders `%s` as `%s`', async (source, rendered) => {
    expect(renderExpression(await parseCondition(source))).toBe(rendered);
  });
});

describe('Parsing - settings blocks and their members', () => {
  test.each<Row>([
    [
      'a user task attribute value is a LiteralString, not a RawExpr',
      `process p { user T "Review" { assignee = "demo" } }`,
      '[UserTask(name="T", label="Review", attrs=[Attribute(key="assignee", value=LiteralString(value="demo"))])]',
    ],
    [
      'a service class written as a dotted bareword is a VarRef, not a string',
      `process p { service A { class = com.example.invoice.AutoApproveDelegate } }`,
      '[ServiceTask(name="A", attrs=[Attribute(key="class", value=VarRef(name="com", accessors=[Accessor(prop="example"), Accessor(prop="invoice"), Accessor(prop="AutoApproveDelegate")]))])]',
    ],
    [
      'duplicate attribute keys stay visible as two AST attribute nodes',
      `process p { user T { assignee = "a" assignee = "b" } }`,
      '[UserTask(name="T", attrs=[Attribute(key="assignee", value=LiteralString(value="a")), Attribute(key="assignee", value=LiteralString(value="b"))])]',
    ],
    [
      'a task with no settings block carries no attributes',
      `process p { user T "No attrs" }`,
      '[UserTask(name="T", label="No attrs")]',
    ],
    [
      'a start event and a user task each accept a form block',
      `process p {
  start Begin { form { amount: number "Amount" = 0 } }
  user Approve { assignee = "demo" form { ok: boolean "OK?" } }
}`,
      '[StartEvent(name="Begin", forms=[FormBlock(fields=[FormField(id="amount", type="number", label="Amount", defaultValue=LiteralInt(value=0))])]), UserTask(name="Approve", attrs=[Attribute(key="assignee", value=LiteralString(value="demo"))], forms=[FormBlock(fields=[FormField(id="ok", type="boolean", label="OK?")])])]',
    ],
    [
      '`process` is still accepted as the call attribute key',
      `process p { call C { process = "x" } }`,
      '[CallActivity(name="C", attrs=[Attribute(key="process", value=LiteralString(value="x"))])]',
    ],
    [
      "an unknown attribute key parses; key legality is the validator's job",
      `process p { user T { wibble = 1 } }`,
      '[UserTask(name="T", attrs=[Attribute(key="wibble", value=LiteralInt(value=1))])]',
    ],
    [
      'a bare `binding = version` parses as a value reference',
      `process p { call C { process = "x" binding = version } }`,
      '[CallActivity(name="C", attrs=[Attribute(key="process", value=LiteralString(value="x")), Attribute(key="binding", value=VarRef(name="version"))])]',
    ],
    [
      'an end event carries a settings block',
      `process p { end E { asyncBefore = true } }`,
      '[EndEvent(name="E", attrs=[Attribute(key="asyncBefore", value=LiteralBool(value="true"))])]',
    ],
    [
      'a handler carries a settings block before its body',
      `process p { on error "E" { asyncBefore = true } { user U } }`,
      '[OnHandler(trigger="error", code="E", attrs=[Attribute(key="asyncBefore", value=LiteralBool(value="true"))], body=Block(statements=[UserTask(name="U")]))]',
    ],
    [
      'a hosted alongside handler carries a settings block before its body',
      `process p { user R on R: timer after "PT1H" alongside { asyncBefore = true } { user U } }`,
      '[UserTask(name="R"), OnHandler(host=->R, trigger="timer", particle="after", time="PT1H", alongside=true, attrs=[Attribute(key="asyncBefore", value=LiteralBool(value="true"))], body=Block(statements=[UserTask(name="U")]))]',
    ],
    [
      'throw, emit and await each carry a trailing settings block',
      `process p {
  throw error "X" { asyncBefore = true }
  emit signal Sig { asyncAfter = true }
  await message "M" { exclusive = false }
}`,
      '[ThrowStatement(trigger="error", code="X", attrs=[Attribute(key="asyncBefore", value=LiteralBool(value="true"))]), EmitStatement(trigger="signal", name="Sig", attrs=[Attribute(key="asyncAfter", value=LiteralBool(value="true"))]), IntermediateCatchEvent(trigger="message", code="M", attrs=[Attribute(key="exclusive", value=LiteralBool(value="false"))])]',
    ],
    [
      'a statement following an emit with a trailing block still parses',
      `process p { emit signal Sig subprocess S { user A } }`,
      '[EmitStatement(trigger="signal", name="Sig"), SubProcess(name="S", body=Block(statements=[UserTask(name="A")]))]',
    ],
    [
      'a statement following a bare await still parses',
      `process p { await message subprocess S { user A } }`,
      '[IntermediateCatchEvent(trigger="message"), SubProcess(name="S", body=Block(statements=[UserTask(name="A")]))]',
    ],
    [
      'a task carries directed, named parameter entries',
      `process p { user T { input a = 1 output b = "x" } }`,
      '[UserTask(name="T", params=[IoParameter(direction="input", name="a", value=LiteralInt(value=1)), IoParameter(direction="output", name="b", value=LiteralString(value="x"))])]',
    ],
    [
      'a list value keeps its items in order',
      `process p { service S { input a = [1, 2] } }`,
      '[ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=ListLiteral(items=[LiteralInt(value=1), LiteralInt(value=2)]))])]',
    ],
    [
      'a map value keeps its keyed entries',
      `process p { service S { input a = { k: 1 } } }`,
      '[ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=MapLiteral(entries=[MapEntry(key="k", value=LiteralInt(value=1))]))])]',
    ],
    [
      'lists and maps nest inside one another',
      `process p { service S { input a = [{ k: 1 }, { k: [2, 3] }] } }`,
      '[ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=ListLiteral(items=[MapLiteral(entries=[MapEntry(key="k", value=LiteralInt(value=1))]), MapLiteral(entries=[MapEntry(key="k", value=ListLiteral(items=[LiteralInt(value=2), LiteralInt(value=3)]))])]))])]',
    ],
    [
      'an empty list and an empty map parse',
      `process p { service S { input a = [] output b = { } } }`,
      '[ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=ListLiteral), IoParameter(direction="output", name="b", value=MapLiteral)])]',
    ],
    [
      'a quoted map key carries its bare text',
      `process p { service S { input a = { "k-1": 1 } } }`,
      '[ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=MapLiteral(entries=[MapEntry(key="k-1", value=LiteralInt(value=1))]))])]',
    ],
    [
      'a fenced script is a parameter value',
      `process p {
  service S { input a = ${FENCE}groovy
1 + 1
${FENCE} }
}`,
      '[ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=ScriptLiteral(body="```groovy\\n1 + 1\\n```"))])]',
    ],
    [
      'a task listener binds by class',
      `process p { user T { on create { class = "com.acme.L" } } }`,
      '[UserTask(name="T", listeners=[Listener(event="create", attrs=[Attribute(key="class", value=LiteralString(value="com.acme.L"))])])]',
    ],
    [
      'the start and end statement keywords are usable as listener events',
      `process p { service S { on start { class = "A" } on end { expression = "\${b.m()}" } } }`,
      '[ServiceTask(name="S", listeners=[Listener(event="start", attrs=[Attribute(key="class", value=LiteralString(value="A"))]), Listener(event="end", attrs=[Attribute(key="expression", value=RawExpr(raw="\\"${b.m()}\\""))])])]',
    ],
    [
      'a timeout listener carries a timer particle and its time',
      `process p { user T { on timeout after "PT1H" { class = "X" } } }`,
      '[UserTask(name="T", listeners=[Listener(event="timeout", particle="after", time="PT1H", attrs=[Attribute(key="class", value=LiteralString(value="X"))])])]',
    ],
    [
      'a listener binds by an inline fenced script instead of a block',
      `process p {
  user T { on end ${FENCE}groovy
execution.setVariable("x", 1)
${FENCE} }
}`,
      '[UserTask(name="T", listeners=[Listener(event="end", script="```groovy\\nexecution.setVariable(\\"x\\", 1)\\n```")])]',
    ],
    [
      'a listener sits in the settings block before a subprocess body',
      `process p { subprocess S { on start { class = "X" } } { user U } }`,
      '[SubProcess(name="S", listeners=[Listener(event="start", attrs=[Attribute(key="class", value=LiteralString(value="X"))])], body=Block(statements=[UserTask(name="U")]))]',
    ],
    [
      'a listener rides a call activity and an end event',
      `process p {
  call C { process = "q" on start { class = "X" } }
  end E { on end { delegate = "\${bean}" } }
}`,
      '[CallActivity(name="C", attrs=[Attribute(key="process", value=LiteralString(value="q"))], listeners=[Listener(event="start", attrs=[Attribute(key="class", value=LiteralString(value="X"))])]), EndEvent(name="E", listeners=[Listener(event="end", attrs=[Attribute(key="delegate", value=RawExpr(raw="\\"${bean}\\""))])])]',
    ],
    [
      'scalars, a form block, parameters and listeners mix in one block',
      `process p {
  user T {
    assignee = "demo"
    form { ok: boolean "OK?" }
    input a = 1
    on create { class = "com.acme.L" }
    exclusive = false
  }
}`,
      '[UserTask(name="T", attrs=[Attribute(key="assignee", value=LiteralString(value="demo")), Attribute(key="exclusive", value=LiteralBool(value="false"))], forms=[FormBlock(fields=[FormField(id="ok", type="boolean", label="OK?")])], params=[IoParameter(direction="input", name="a", value=LiteralInt(value=1))], listeners=[Listener(event="create", attrs=[Attribute(key="class", value=LiteralString(value="com.acme.L"))])])]',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
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
    '`subprocess S %s` splits its settings block from its body',
    async (tail, keys, bodyTypes) => {
      const sub = await statementAt<SubProcess>(
        `process p { subprocess S ${tail} }`,
      );
      expect(sub.attrs.map((a) => a.key)).toEqual(keys);
      expect(sub.body.statements.map((s) => s.$type)).toEqual(bodyTypes);
    },
  );
});

describe('Parsing - task kinds, service bindings and fenced scripts', () => {
  const KINDS = [
    ['step', 'GenericTask'],
    ['send', 'SendTask'],
    ['receive', 'ReceiveTask'],
    ['decide', 'BusinessRuleTask'],
  ] as const;

  test.each<Row>([
    ...KINDS.map(([keyword, type]): Row => [
      `\`${keyword} X\` parses with a name and no label`,
      `process p { ${keyword} X }`,
      `[${type}(name="X")]`,
    ]),
    ...KINDS.map(([keyword, type]): Row => [
      `\`${keyword} X "Label"\` fills the label slot`,
      `process p { ${keyword} X "Label" }`,
      `[${type}(name="X", label="Label")]`,
    ]),
    ...KINDS.map(([keyword, type]): Row => [
      `\`${keyword}\` after \`start S\` opens its own statement rather than filling the start's trigger slot`,
      `process p { start S ${keyword} X user U end E }`,
      `[StartEvent(name="S"), ${type}(name="X"), UserTask(name="U"), EndEvent(name="E")]`,
    ]),
    [
      'a decide task carries both of its attribute keys in order',
      `process p { decide D "Rate" { decision = "riskRating" binding = latest } }`,
      '[BusinessRuleTask(name="D", label="Rate", attrs=[Attribute(key="decision", value=LiteralString(value="riskRating")), Attribute(key="binding", value=VarRef(name="latest"))])]',
    ],
    [
      'an expression binding parses; the value is a raw template',
      `process p { service S { expression = "\${bean.method(execution)}" } }`,
      '[ServiceTask(name="S", attrs=[Attribute(key="expression", value=RawExpr(raw="\\"${bean.method(execution)}\\""))])]',
    ],
    [
      'a delegate binding parses; the value is a raw template',
      `process p { service S { delegate = "\${beanName}" } }`,
      '[ServiceTask(name="S", attrs=[Attribute(key="delegate", value=RawExpr(raw="\\"${beanName}\\""))])]',
    ],
    [
      'a topic binding parses with a label',
      `process p { service ship "Ship it" { topic = "shipping" } }`,
      '[ServiceTask(name="ship", label="Ship it", attrs=[Attribute(key="topic", value=LiteralString(value="shipping"))])]',
    ],
    [
      'a topic binding parses without a label',
      `process p { service ship { topic = "shipping" } }`,
      '[ServiceTask(name="ship", attrs=[Attribute(key="topic", value=LiteralString(value="shipping"))])]',
    ],
    [
      'a fenced script task captures the whole fence, tag and all',
      `process p {
  script total ${FENCE}js
x = 1
${FENCE}
}`,
      '[ScriptTask(name="total", body="```js\\nx = 1\\n```")]',
    ],
    [
      'a script task carries a settings block before its fence',
      `process p {
  script S { resultVariable = "total" } ${FENCE}js
x = 1
${FENCE}
}`,
      '[ScriptTask(name="S", attrs=[Attribute(key="resultVariable", value=LiteralString(value="total"))], body="```js\\nx = 1\\n```")]',
    ],
    // The backtick fence is a fresh delimiter with no overlap against the
    // quote-delimited STRING / RAW_TEMPLATE terminals.
    [
      'a fence coexists with a class bareword and a raw template without lex ambiguity',
      `process p {
  service Auto { class = com.acme.X }
  user Review { assignee = "\${bean.pick()}" }
  script total ${FENCE}js
y = 2
${FENCE}
}`,
      '[ServiceTask(name="Auto", attrs=[Attribute(key="class", value=VarRef(name="com", accessors=[Accessor(prop="acme"), Accessor(prop="X")]))]), UserTask(name="Review", attrs=[Attribute(key="assignee", value=RawExpr(raw="\\"${bean.pick()}\\""))]), ScriptTask(name="total", body="```js\\ny = 2\\n```")]',
    ],
    [
      'DSL-looking text inside a fence is captured, not parsed as DSL',
      `process p {
  script guard ${FENCE}js
if (a) { }
${FENCE}
}`,
      '[ScriptTask(name="guard", body="```js\\nif (a) { }\\n```")]',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });
});

describe('Parsing - repeat clause', () => {
  test.each<Row>([
    [
      '`for each line in lines` binds the element and the collection and leaves the rest unset',
      `process p { user U for each line in lines }`,
      '[UserTask(name="U", element="line", collection=VarRef(name="lines"))]',
    ],
    [
      '`for each in lines` takes the collection with no element name',
      `process p { user U for each in lines }`,
      '[UserTask(name="U", collection=VarRef(name="lines"))]',
    ],
    [
      'a count runs alone',
      `process p { user U for 3 }`,
      '[UserTask(name="U", cardinality=LiteralInt(value=3))]',
    ],
    [
      'a count runs alongside a collection',
      `process p { user U for 2 each line in lines }`,
      '[UserTask(name="U", cardinality=LiteralInt(value=2), element="line", collection=VarRef(name="lines"))]',
    ],
    [
      '`sequentially` is set only when written',
      `process p { user U for each line in lines sequentially }`,
      '[UserTask(name="U", element="line", collection=VarRef(name="lines"), sequential=true)]',
    ],
    [
      '`until (...)` parses the same expression AST an if condition parses to',
      `process p { user U for each line in lines until (nrOfCompletedInstances >= 2) }`,
      '[UserTask(name="U", element="line", collection=VarRef(name="lines"), completion=Relational(left=VarRef(name="nrOfCompletedInstances"), op=">=", right=LiteralInt(value=2)))]',
    ],
    [
      'a label, the clause and a settings block parse together in that order',
      `process p { user U "Label" for each line in "\${order.lines}" sequentially until (done) { assignee = "demo" } }`,
      '[UserTask(name="U", label="Label", element="line", collection=RawExpr(raw="\\"${order.lines}\\""), sequential=true, completion=VarRef(name="done"), attrs=[Attribute(key="assignee", value=LiteralString(value="demo"))])]',
    ],
    [
      'the clause on the statement after a start event is not swallowed',
      `process p { start S user U for each line in lines end E }`,
      '[StartEvent(name="S"), UserTask(name="U", element="line", collection=VarRef(name="lines")), EndEvent(name="E")]',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });

  // Every row carries a settings block, so both tests below see the clause
  // survive one. `script` and `subprocess` are the two rules where it sits
  // between the clause and a further brace-opened body: the only shape a
  // lookahead ambiguity could surface in.
  const SET = '{ asyncBefore = true }';

  /** Every statement the clause attaches to, with whatever body follows it. */
  const REPEATABLE: Array<
    [keyword: string, type: string, program: (clause: string) => string]
  > = [
    ['user', 'UserTask', (c) => `process p { user U ${c} ${SET} }`],
    ['service', 'ServiceTask', (c) => `process p { service V ${c} ${SET} }`],
    [
      'script',
      'ScriptTask',
      (c) => `process p { script T ${c} ${SET} ${FENCE}js\nwork()\n${FENCE} }`,
    ],
    ['step', 'GenericTask', (c) => `process p { step T ${c} ${SET} }`],
    ['send', 'SendTask', (c) => `process p { send N ${c} ${SET} }`],
    ['receive', 'ReceiveTask', (c) => `process p { receive R ${c} ${SET} }`],
    ['decide', 'BusinessRuleTask', (c) => `process p { decide D ${c} ${SET} }`],
    [
      'subprocess',
      'SubProcess',
      (c) => `process p { subprocess S ${c} ${SET} { user U } }`,
    ],
    [
      'call',
      'CallActivity',
      (c) => `process p { call C ${c} { process = "q" asyncBefore = true } }`,
    ],
  ];

  test.each(REPEATABLE)(
    '`%s` carries every part of the clause',
    async (_keyword, type, program) => {
      const task = await statementAt<Repeatable>(
        program('for 2 each line in lines sequentially until (done)'),
      );
      expect(task.$type).toBe(type);
      expect((task.cardinality as LiteralInt).value).toBe(2);
      expect(task.element).toBe('line');
      expect((task.collection as VarRef).name).toBe('lines');
      expect(task.sequential).toBe(true);
      expect((task.completion as VarRef).name).toBe('done');
      expect(task.attrs.map((a) => a.key)).toContain('asyncBefore');
    },
  );

  test.each(REPEATABLE)(
    '`%s` without the clause leaves every slot unset',
    async (_keyword, type, program) => {
      const task = await statementAt<Repeatable>(program(''));
      expect(task.$type).toBe(type);
      expect(task.cardinality).toBeUndefined();
      expect(task.element).toBeUndefined();
      expect(task.collection).toBeUndefined();
      expect(task.sequential).toBe(false);
      expect(task.completion).toBeUndefined();
      expect(task.attrs.map((a) => a.key)).toContain('asyncBefore');
    },
  );
});

/** Chevrotain's own list-of-alternatives wording, which carries no guidance. */
const STOCK_ALTERNATIVES = '<stock list of token alternatives>';

const reservedWord = (word: string) =>
  `'${word}' is a reserved word and cannot be used as a plain name here. ` +
  `To refer to a variable named '${word}', write it as a quoted raw expression: "\${${word}}".`;

const notAStepKeyword = (word: string) =>
  `'${word}' is neither a known declaration nor a step keyword. ` +
  "A declaration starting with a plain word is either a setting ('<key> = <value>') " +
  `or 'error "CODE" message "..."'; every step starts with a keyword such as ` +
  "'start', 'user', 'service', 'if', 'on', 'throw', 'emit', ...";

const notATypeWord = (word: string) =>
  `'${word}' is not a word this position takes; write 'string', 'number', ` +
  `'boolean', 'date', 'json', or 'any'.`;

const REPEAT_CLAUSE_GUIDANCE =
  "A repeat clause ('for ...') attaches to the step that repeats. " +
  'The statement before it does not take one; move the clause onto ' +
  'the step that should.';

const VAR_PLACEMENT_GUIDANCE =
  "A variable declaration ('var ...') must come before the first step in " +
  'the process, with the other declarations. Move it above the first ' +
  'statement.';

// Each row pins the whole error list, so it also proves that no further
// complaint follows and that the guidance replaced the raw wording rather than
// joining it.
describe('Parsing - sources the parser rejects', () => {
  test.each<readonly [string, string, readonly string[]]>([
    [
      'parallel requires at least two branches',
      `process p { parallel { { user A } } }`,
      [STOCK_ALTERNATIVES, 'Expecting end of file but found `}`.'],
    ],
    [
      'a race requires at least two branches',
      `process p { await { message "M" { user U } } }`,
      [STOCK_ALTERNATIVES, 'Expecting end of file but found `}`.'],
    ],
    [
      '`attempt` is reserved: it does not name a step',
      `process p { user attempt }`,
      [reservedWord('attempt'), "Expecting token of type 'ID' but found `}`."],
    ],
    [
      '`attempt` is reserved: it does not name a variable',
      `process p { var attempt: string }`,
      [reservedWord('attempt'), "Expecting token of type 'ID' but found `:`."],
    ],
    [
      '`await` is reserved: it does not name a variable',
      `process p { var await: string }`,
      [reservedWord('await'), STOCK_ALTERNATIVES],
    ],
    [
      'a colon with no trigger after it is rejected',
      `process p { user Pack on Pack: { } }`,
      ["Expecting token of type 'ID' but found `{`."],
    ],
    ...(['in', 'out', 'local', 'alongside'] as const).map(
      (word) =>
        [
          `\`${word}\` is rejected as a bare identifier in expression position`,
          `process p { if (${word} > 2) { user A } }`,
          [reservedWord(word)],
        ] as const,
    ),
    ...(['call', 'on', 'throw', 'emit'] as const).map(
      (word) =>
        [
          `\`${word}\` is rejected as a bare identifier in expression position`,
          `process p { if (${word} > 2) { user A } }`,
          [
            reservedWord(word),
            "Expecting token of type 'ID' but found `>`.",
            'Expecting end of file but found `}`.',
          ],
        ] as const,
    ),
    [
      'a trailing comma in a list is rejected',
      `process p { service S { input a = [1, ] } }`,
      [STOCK_ALTERNATIVES],
    ],
    [
      'a trailing comma in a map is rejected',
      `process p { service S { input a = { k: 1, } } }`,
      [STOCK_ALTERNATIVES],
    ],
    [
      'a mistyped statement keyword gets the declaration-or-step guidance',
      `process p { usr Review { } }`,
      [
        notAStepKeyword('usr'),
        "Expecting token of type '}' but found `usr`.",
        'Expecting end of file but found `}`.',
      ],
    ],
    // `ErrorDecl` has two STRING positions, and when the second is malformed
    // the token just consumed is the field word `message`. The guidance must
    // name the text the author got wrong, never that field word.
    [
      'an error declaration with an unquoted message blames the message text',
      `process p { error "PF" message oops }`,
      [
        "Expecting token of type 'STRING' but found `oops`.",
        notAStepKeyword('oops'),
        "Expecting token of type '}' but found `oops`.",
      ],
    ],
    [
      'an error declaration with a missing message blames the brace it found',
      `process p { error "PF" message }`,
      ["Expecting token of type 'STRING' but found `}`."],
    ],
    [
      'a var declaration after the first step gets placement guidance',
      `process p {
  start Begin
  var amount: number
}`,
      [VAR_PLACEMENT_GUIDANCE],
    ],
    ...(
      [
        ['a start', `start S for each line in lines`],
        ['an end', `end E for 3`],
        ['a goto', `start S goto S for 3`],
        ['a throw', `throw error "E" for 3`],
      ] as const
    ).map(
      ([where, statement]) =>
        [
          `a repeat clause on ${where} says where the clause belongs instead of naming a brace`,
          `process p {\n  var lines: json\n  ${statement}\n}`,
          [REPEAT_CLAUSE_GUIDANCE],
        ] as const,
    ),
    [
      'a start event takes no repeat clause',
      `process p { start S for each line in lines user U end E }`,
      [REPEAT_CLAUSE_GUIDANCE],
    ],
    [
      'a reserved word in the type slot of a var declaration names the types it takes',
      'process p {\n  var amount: while\n  start S\n}',
      [notATypeWord('while'), "Expecting token of type '(' but found `start`."],
    ],
    [
      'a reserved word in the type slot of a form field names the types it takes',
      'process p {\n  start S\n  user U { form { amount: while } }\n}',
      [
        notATypeWord('while'),
        "Expecting token of type '(' but found `}`.",
        "Expecting token of type 'EOF' but found `}`.",
      ],
    ],
    [
      'an ordinary word in the type slot gets the same guidance',
      'process p {\n  var amount: text\n  start S\n}',
      [
        notATypeWord('text'),
        notAStepKeyword('text'),
        "Expecting token of type '}' but found `text`.",
      ],
    ],
    // Nothing about a non-word token is a "word this position takes", so the
    // guidance stands aside and Chevrotain's own message survives.
    [
      'a quoted string in the type slot keeps the stock message',
      'process p {\n  var amount: "text"\n  start S\n}',
      [STOCK_ALTERNATIVES],
    ],
  ])('%s', async (_title, source, expected) => {
    const messages = (await parseErrors(source)).map((message) =>
      /possible Token sequences/.test(message)
        ? STOCK_ALTERNATIVES
        : message.replace(/\n\s*/g, ' '),
    );
    expect(messages).toEqual(expected);
  });
});
