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
  renderExpression,
  settingsOf,
} from '@bpmn-script/language';

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

/** A subtree as `Type(prop=value, ...)`, a cross-reference as `->target`, empty slots dropped. */
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

async function parseModel(source: string): Promise<Model> {
  const document = await parse(source);
  expect(formatParseFailure(document)).toBeUndefined();
  return document.parseResult.value;
}

async function parseErrors(source: string): Promise<string[]> {
  const { lexerErrors, parserErrors } = (await parse(source)).parseResult;
  return [...lexerErrors, ...parserErrors].map((e) => e.message);
}

async function expectBody(source: string, body: string | string[]) {
  const model = await parseModel(source);
  expect(model.processes).toHaveLength(1);
  expect(shape(model.processes[0]!)).toBe(
    `Process(name="p", body=${typeof body === 'string' ? body : `[${body.join(', ')}]`})`,
  );
}

async function expectProcess(source: string, process: string) {
  const model = await parseModel(source);
  expect(model.processes).toHaveLength(1);
  expect(shape(model.processes[0]!)).toBe(process);
}

async function parseCondition(expr: string) {
  const model = await parseModel(`process p { if (${expr}) { user A } }`);
  return (model.processes[0]!.body[0] as IfStatement).condition;
}

async function statementAt<T>(source: string, index = 0): Promise<T> {
  return (await parseModel(source)).processes[0]!.body[index] as T;
}

type Row = readonly [title: string, source: string, expected: string];
type BodyRow = readonly [
  title: string,
  source: string,
  expected: string | string[],
];

describe('Parsing - process header', () => {
  test.each<Row>([
    [
      'the process id and its label land in their own slots',
      `process p(label: "My Process") { start S end E }`,
      'Process(name="p", items=[Setting(key="label", value=LiteralString(value="My Process"))], body=[StartEvent(name="S"), EndEvent(name="E")])',
    ],
    [
      'declarations are gathered into decls and executable statements into body',
      `process p(label: "Lbl") {
  var amount: number
  var flag: boolean
  start S
  end E
}`,
      'Process(name="p", items=[Setting(key="label", value=LiteralString(value="Lbl"))], decls=[VarDecl(name="amount", type="number"), VarDecl(name="flag", type="boolean")], body=[StartEvent(name="S"), EndEvent(name="E")])',
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
      'a code declaration parses beside a var declaration in either order',
      `process p(versionTag: "1.4", label: "Lbl") {
  error OUT_OF_STOCK(message: "Out of stock")
  var amount: number
  escalation MANUAL_REVIEW
  start S
}`,
      'Process(name="p", items=[Setting(key="versionTag", value=LiteralString(value="1.4")), Setting(key="label", value=LiteralString(value="Lbl"))], decls=[CodeDecl(kind="error", name="OUT_OF_STOCK", items=[Setting(key="message", value=LiteralString(value="Out of stock"))]), VarDecl(name="amount", type="number"), CodeDecl(kind="escalation", name="MANUAL_REVIEW")], body=[StartEvent(name="S")])',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectProcess(source, expected);
  });
});

describe('Parsing - control flow and containers', () => {
  test.each<BodyRow>([
    [
      'control-flow statements parse into their expected AST shapes',
      `process p {
  user A user B user C
    if (a) { user A }
  else if (b) { user B }
  else if (c) { user C }
  else { user D }
  if (a) { user A }
  while (rejected) { user R }
  do { user R } while (again)
  parallel { if (amount > 10000) { user A } { service B } else { user C } }
  parallel { { user A } { user B } { user C } }
  parallel { { if (a) { user A } else { user B } } { user C } }
}`,
      [
        'UserTask(name="A"), UserTask(name="B"), UserTask(name="C")',
        'IfStatement(condition=VarRef(ref=->a), then=Block(statements=[UserTask(name="A")]), elseIfs=[ElseIf(condition=VarRef(ref=->b), body=Block(statements=[UserTask(name="B")])), ElseIf(condition=VarRef(ref=->c), body=Block(statements=[UserTask(name="C")]))], elseBlock=Block(statements=[UserTask(name="D")]))',
        'IfStatement(condition=VarRef(ref=->a), then=Block(statements=[UserTask(name="A")]))',
        'WhileStatement(condition=VarRef(ref=->rejected), body=Block(statements=[UserTask(name="R")]))',
        'DoWhileStatement(body=Block(statements=[UserTask(name="R")]), condition=VarRef(ref=->again))',
        'ParallelStatement(branches=[ParallelBranch(condition=Relational(left=VarRef(ref=->amount), op=">", right=LiteralInt(value=10000)), body=Block(statements=[UserTask(name="A")])), ParallelBranch(body=Block(statements=[ServiceTask(name="B")])), ParallelBranch(otherwise=true, body=Block(statements=[UserTask(name="C")]))])',
        'ParallelStatement(branches=[ParallelBranch(body=Block(statements=[UserTask(name="A")])), ParallelBranch(body=Block(statements=[UserTask(name="B")])), ParallelBranch(body=Block(statements=[UserTask(name="C")]))])',
        'ParallelStatement(branches=[ParallelBranch(body=Block(statements=[IfStatement(condition=VarRef(ref=->a), then=Block(statements=[UserTask(name="A")]), elseBlock=Block(statements=[UserTask(name="B")]))])), ParallelBranch(body=Block(statements=[UserTask(name="C")]))])',
      ],
    ],
    [
      'subprocesses, attempts, and call activities parse their bodies and mappings',
      `process p {
  subprocess Handle(label: "Handle order") { user Review(assignee: "demo") }
  subprocess S { }
  attempt A { }
  attempt A for each line in lines (label: "Book and pay", asyncBefore: true) { user U }
    call Fulfilment(
    label: "Fulfil order",
    process: "fulfilment-process",
    binding: deployment,
    businessKey: "\${execution.processBusinessKey}"
  ) {
    in *
    in orderId
    in total = amount + tax
    in local vip = vipFlag
    out shipmentId
    out shipped = confirmed
  }
  call X(process: "p")
  call X { }
  call C(process: "p") { in a input b = 1 }
}`,
      [
        'SubProcess(name="Handle", items=[Setting(key="label", value=LiteralString(value="Handle order"))], body=Block(statements=[UserTask(name="Review", items=[Setting(key="assignee", value=LiteralString(value="demo"))])]))',
        'SubProcess(name="S", body=Block)',
        'SubProcess(transactional=true, name="A", body=Block)',
        'SubProcess(transactional=true, name="A", element="line", collection=VarRef(ref=->lines), items=[Setting(key="label", value=LiteralString(value="Book and pay")), Setting(key="asyncBefore", value=LiteralBool(value="true"))], body=Block(statements=[UserTask(name="U")]))',
        'CallActivity(name="Fulfilment", items=[Setting(key="label", value=LiteralString(value="Fulfil order")), Setting(key="process", value=LiteralString(value="fulfilment-process")), Setting(key="binding", value=VarRef(ref=->deployment)), Setting(key="businessKey", value=RawExpr(raw="${execution.processBusinessKey}"))], mappings=[VariableMapping(direction="in", all=true), VariableMapping(direction="in", target="orderId"), VariableMapping(direction="in", target="total", source=Additive(left=VarRef(ref=->amount), op="+", right=VarRef(ref=->tax))), VariableMapping(direction="in", local=true, target="vip", source=VarRef(ref=->vipFlag)), VariableMapping(direction="out", target="shipmentId"), VariableMapping(direction="out", target="shipped", source=VarRef(ref=->confirmed))])',
        'CallActivity(name="X", items=[Setting(key="process", value=LiteralString(value="p"))])',
        'CallActivity(name="X")',
        'CallActivity(name="C", items=[Setting(key="process", value=LiteralString(value="p"))], mappings=[VariableMapping(direction="in", target="a")], params=[IoParameter(direction="input", name="b", value=LiteralInt(value=1))])',
      ],
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });
});

describe('Parsing - gateway settings', () => {
  test.each<BodyRow>([
    [
      'each control-flow head parses its own split, join, fork, or race settings',
      `process p {
  if (a) (asyncBefore: true, joinJobPriority: 20) { user A } else if (b) { user B }
  while (a) (asyncAfter: true) { user A }
  do { user A } while (a) (exclusive: false)
  parallel (jobPriority: 5) { { user A } { user B } }
  await (retryCycle: "R3/PT10M") { message("M") { user A } timer("PT1H") { user B } }
}`,
      [
        'IfStatement(condition=VarRef(ref=->a), items=[Setting(key="asyncBefore", value=LiteralBool(value="true")), Setting(key="joinJobPriority", value=LiteralInt(value=20))], then=Block(statements=[UserTask(name="A")]), elseIfs=[ElseIf(condition=VarRef(ref=->b), body=Block(statements=[UserTask(name="B")]))])',
        'WhileStatement(condition=VarRef(ref=->a), items=[Setting(key="asyncAfter", value=LiteralBool(value="true"))], body=Block(statements=[UserTask(name="A")]))',
        'DoWhileStatement(body=Block(statements=[UserTask(name="A")]), condition=VarRef(ref=->a), items=[Setting(key="exclusive", value=LiteralBool(value="false"))])',
        'ParallelStatement(items=[Setting(key="jobPriority", value=LiteralInt(value=5))], branches=[ParallelBranch(body=Block(statements=[UserTask(name="A")])), ParallelBranch(body=Block(statements=[UserTask(name="B")]))])',
        'RaceStatement(items=[Setting(key="retryCycle", value=LiteralString(value="R3/PT10M"))], branches=[RaceBranch(trigger="message", items=[ParenValue(value=LiteralString(value="M"))], body=Block(statements=[UserTask(name="A")])), RaceBranch(trigger="timer", items=[ParenValue(value=LiteralString(value="PT1H"))], body=Block(statements=[UserTask(name="B")]))])',
      ],
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });
});

describe('Parsing - the event layer', () => {
  test.each<BodyRow>([
    [
      'event handlers parse their trigger, code, bindings, and condition correctly',
      `process p {
    on error(PAYMENT_FAILED, code: c, message: m) { service R(class: "x.Y") }
  on message("PaymentReceived") { user Review(assignee: "demo") }
  on signal("Cancelled", alongside) { }
  on escalation(X, code: v, alongside) { }
  on error { }
  on escalation { }
  on timer(every: "R/PT10M", alongside) { }
  on condition(amount > 100) { }
}`,
      [
        'OnHandler(trigger="error", items=[ParenValue(value=VarRef(ref=->PAYMENT_FAILED)), Setting(key="code", value=VarRef(ref=->c)), Setting(key="message", value=VarRef(ref=->m))], body=Block(statements=[ServiceTask(name="R", items=[Setting(key="class", value=LiteralString(value="x.Y"))])]))',
        'OnHandler(trigger="message", items=[ParenValue(value=LiteralString(value="PaymentReceived"))], body=Block(statements=[UserTask(name="Review", items=[Setting(key="assignee", value=LiteralString(value="demo"))])]))',
        'OnHandler(trigger="signal", items=[ParenValue(value=LiteralString(value="Cancelled")), Flag(flag="alongside")], body=Block)',
        'OnHandler(trigger="escalation", items=[ParenValue(value=VarRef(ref=->X)), Setting(key="code", value=VarRef(ref=->v)), Flag(flag="alongside")], body=Block)',
        'OnHandler(trigger="error", body=Block)',
        'OnHandler(trigger="escalation", body=Block)',
        'OnHandler(trigger="timer", items=[Setting(key="every", value=LiteralString(value="R/PT10M")), Flag(flag="alongside")], body=Block)',
        'OnHandler(trigger="condition", items=[ParenValue(value=Relational(left=VarRef(ref=->amount), op=">", right=LiteralInt(value=100)))], body=Block)',
      ],
    ],
    [
      'a condition handler parses its parenthesized expression apart from bindings',
      `process p {
  on condition(approved) { }
  on condition("\${bean.check()}") { }
  on condition(amount > limit, alongside) { }
  on error(X) { }
    user Pack
  on Pack: error(OUT_OF_STOCK, code: c, message: m) { service R(class: "x.Y") }
  user Review on Review: condition(amount > 100, alongside) { }
  user Review on Review: message("Cancelled", alongside) { }
}`,
      [
        'OnHandler(trigger="condition", items=[ParenValue(value=VarRef(ref=->approved))], body=Block)',
        'OnHandler(trigger="condition", items=[ParenValue(value=RawExpr(raw="${bean.check()}"))], body=Block)',
        'OnHandler(trigger="condition", items=[ParenValue(value=Relational(left=VarRef(ref=->amount), op=">", right=VarRef(ref=->limit))), Flag(flag="alongside")], body=Block)',
        'OnHandler(trigger="error", items=[ParenValue(value=VarRef(ref=->X))], body=Block)',
        'UserTask(name="Pack"), OnHandler(host=->Pack, trigger="error", items=[ParenValue(value=VarRef(ref=->OUT_OF_STOCK)), Setting(key="code", value=VarRef(ref=->c)), Setting(key="message", value=VarRef(ref=->m))], body=Block(statements=[ServiceTask(name="R", items=[Setting(key="class", value=LiteralString(value="x.Y"))])]))',
        'UserTask(name="Review"), OnHandler(host=->Review, trigger="condition", items=[ParenValue(value=Relational(left=VarRef(ref=->amount), op=">", right=LiteralInt(value=100))), Flag(flag="alongside")], body=Block)',
        'UserTask(name="Review"), OnHandler(host=->Review, trigger="message", items=[ParenValue(value=LiteralString(value="Cancelled")), Flag(flag="alongside")], body=Block)',
      ],
    ],
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
      'throw and emit statements parse their trigger, name, and code correctly',
      `process p {
  throw error("C")
  throw error Failed("C")
  emit error Ping("C")
  throw compensation
  emit compensation
  throw compensation Undo
  emit compensation Ping
  throw error
}`,
      [
        'ThrowStatement(trigger="error", items=[ParenValue(value=LiteralString(value="C"))])',
        'ThrowStatement(trigger="error", name="Failed", items=[ParenValue(value=LiteralString(value="C"))])',
        'EmitStatement(trigger="error", name="Ping", items=[ParenValue(value=LiteralString(value="C"))])',
        'ThrowStatement(trigger="compensation")',
        'EmitStatement(trigger="compensation")',
        'ThrowStatement(trigger="compensation", name="Undo")',
        'EmitStatement(trigger="compensation", name="Ping")',
        'ThrowStatement(trigger="error")',
      ],
    ],
    [
      'unknown trigger words and code-less triggers still parse, validation aside',
      `process p {
  emit signal
  throw banana
  throw compensation service R(class: "x.Y")
  on compensation { }
  on compensation("X") { }
  on compensation(alongside) { }
  await message("Invoice Received")
  await signal("Ready")
}`,
      [
        'EmitStatement(trigger="signal")',
        'ThrowStatement(trigger="banana")',
        'ThrowStatement(trigger="compensation"), ServiceTask(name="R", items=[Setting(key="class", value=LiteralString(value="x.Y"))])',
        'OnHandler(trigger="compensation", body=Block)',
        'OnHandler(trigger="compensation", items=[ParenValue(value=LiteralString(value="X"))], body=Block)',
        'OnHandler(trigger="compensation", items=[Flag(flag="alongside")], body=Block)',
        'IntermediateCatchEvent(trigger="message", items=[ParenValue(value=LiteralString(value="Invoice Received"))])',
        'IntermediateCatchEvent(trigger="signal", items=[ParenValue(value=LiteralString(value="Ready"))])',
      ],
    ],
    [
      'await, race, and end statements parse their headers without swallowing what follows',
      `process p {
  await timer(at: "2026-08-01T09:00:00")
  await condition(amount > 100)
  await message Named("M") user U
  await { message("M") { service S } timer("P3D") { user U } } user W
  await { signal("S") { form { } } { service P } message("M") { } condition (x) { end E } }
  end E terminate(label: "All stop")
    start S timer("PT1H")
  user U
  end E terminate
  on banana("X") { }
}`,
      [
        'IntermediateCatchEvent(trigger="timer", items=[Setting(key="at", value=LiteralString(value="2026-08-01T09:00:00"))])',
        'IntermediateCatchEvent(trigger="condition", items=[ParenValue(value=Relational(left=VarRef(ref=->amount), op=">", right=LiteralInt(value=100)))])',
        'IntermediateCatchEvent(trigger="message", name="Named", items=[ParenValue(value=LiteralString(value="M"))]), UserTask(name="U")',
        'RaceStatement(branches=[RaceBranch(trigger="message", items=[ParenValue(value=LiteralString(value="M"))], body=Block(statements=[ServiceTask(name="S")])), RaceBranch(trigger="timer", items=[ParenValue(value=LiteralString(value="P3D"))], body=Block(statements=[UserTask(name="U")]))]), UserTask(name="W")',
        'RaceStatement(branches=[RaceBranch(trigger="signal", items=[ParenValue(value=LiteralString(value="S"))], forms=[FormBlock], body=Block(statements=[ServiceTask(name="P")])), RaceBranch(trigger="message", items=[ParenValue(value=LiteralString(value="M"))], body=Block), RaceBranch(trigger="condition", items=[ParenValue(value=VarRef(ref=->x))], body=Block(statements=[EndEvent(name="E")]))])',
        'EndEvent(name="E", trigger="terminate", items=[Setting(key="label", value=LiteralString(value="All stop"))])',
        'StartEvent(name="S", trigger="timer", items=[ParenValue(value=LiteralString(value="PT1H"))]), UserTask(name="U"), EndEvent(name="E", trigger="terminate")',
        'OnHandler(trigger="banana", items=[ParenValue(value=LiteralString(value="X"))], body=Block)',
      ],
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });
});

describe('Parsing - soft words stay plain identifiers', () => {
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
  service input(class: "com.acme.X")
  user output
  goto priority
}`,
      'Process(name="p", decls=[VarDecl(name="class", type="string")], body=[UserTask(name="priority"), ServiceTask(name="input", items=[Setting(key="class", value=LiteralString(value="com.acme.X"))]), UserTask(name="output"), GotoStatement(target=->priority)])',
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
      'Relational(left=VarRef(ref=->amount), op=">", right=LiteralInt(value=1000))',
    ],
    [
      '`order.total` parses to a VarRef with one dot-accessor',
      'order.total',
      'VarRef(ref=->order, accessors=[Accessor(prop="total")])',
    ],
    [
      '`items[0]` parses to a VarRef with an index-accessor',
      'items[0]',
      'VarRef(ref=->items, accessors=[Accessor(index=LiteralInt(value=0))])',
    ],
    [
      'a method call falls back to the raw template, read without its quotes',
      '"${bean.method()}"',
      'RawExpr(raw="${bean.method()}")',
    ],
    [
      'the `#{` opener is a raw template too, not a string literal',
      '"#{bean.method()}"',
      'RawExpr(raw="#{bean.method()}")',
    ],
    [
      'a raw template resolves its string escapes the way a literal does',
      '"${fn(\\"a\\", \'b\')}"',
      'RawExpr(raw="${fn(\\"a\\", \'b\')}")',
    ],
    [
      'a ternary parses to a Ternary node over three expressions',
      'flag ? a : b',
      'Ternary(condition=VarRef(ref=->flag), whenTrue=VarRef(ref=->a), whenFalse=VarRef(ref=->b))',
    ],
    [
      'identifiers outside the reserved set lex as VarRef even where they name keys elsewhere',
      'status == active',
      'Equality(left=VarRef(ref=->status), op="==", right=VarRef(ref=->active))',
    ],
    [
      'a reserved-looking property name is an ordinary dot-accessor',
      'order.type',
      'VarRef(ref=->order, accessors=[Accessor(prop="type")])',
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
      `Relational(left=VarRef(ref=->${word}), op=">", right=LiteralInt(value=2))`,
    ]),
    [
      'the raw-template fallback carries a reserved word as an identifier',
      '"${version > 2}"',
      'RawExpr(raw="${version > 2}")',
    ],
    [
      'the raw-template fallback carries a reserved event keyword as an identifier',
      '"${emit}"',
      'RawExpr(raw="${emit}")',
    ],
    [
      'an equality over a soft event word parses',
      'error == "x"',
      'Equality(left=VarRef(ref=->error), op="==", right=LiteralString(value="x"))',
    ],
  ])('%s', async (_title, expr, expected) => {
    expect(shape(await parseCondition(expr))).toBe(expected);
  });

  // Under an operator a single template is spliced in parenthesised; a
  // composite is left as written for the validator.
  test.each([
    ['amount > 1000', '${amount > 1000}'],
    ['a == null', '${a == null}'],
    ['"${bean.method()}"', '${bean.method()}'],
    ['"#{bean.method()}"', '#{bean.method()}'],
    ["'${a}'", '${a}'],
    ['"${fn(\\"a\\")}"', '${fn("a")}'],
    ['"a\\\\b" == x', '${"a\\\\b" == x}'],
    ['"${a} and ${b}"', '${a} and ${b}'],
    ['!"${x}"', '${!(x)}'],
    ['"${a.b}" > 1', '${(a.b) > 1}'],
    ['"${x}" && x', '${(x) && x}'],
    ['!"#{x}"', '${!(x)}'],
    ['!"${a} and ${b}"', '${!${a} and ${b}}'],
    ['!"${a} b}"', '${!${a} b}}'],
    ['!"${map[\'}\']}"', "${!(map['}'])}"],
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

describe('Parsing - element settings and member blocks', () => {
  test.each<BodyRow>([
    [
      'element settings, form fields, and attribute keys parse leniently, validation aside',
      `process p {
  service A(class: com.example.invoice.AutoApproveDelegate)
  user T(assignee: "a", assignee: "b")
  user T
    start Begin { form { amount: number "Amount" = 0 } }
  user Approve(assignee: "demo") { form { ok: boolean "OK?" } }
  start S { form { plan: enum "Plan" = "basic" (required: true, minlength: 2) { basic "Basic" plus property description = "Sets the fee" } } }
  start S { form { plan: enum { family property x = "y" property "Property" } } }
  start S { form { blob: whatever "Blob" } }
  user T(wibble: 1)
}`,
      [
        'ServiceTask(name="A", items=[Setting(key="class", value=VarRef(ref=->com, accessors=[Accessor(prop="example"), Accessor(prop="invoice"), Accessor(prop="AutoApproveDelegate")]))])',
        'UserTask(name="T", items=[Setting(key="assignee", value=LiteralString(value="a")), Setting(key="assignee", value=LiteralString(value="b"))])',
        'UserTask(name="T")',
        'StartEvent(name="Begin", forms=[FormBlock(fields=[FormField(id="amount", type="number", label="Amount", defaultValue=LiteralInt(value=0))])]), UserTask(name="Approve", items=[Setting(key="assignee", value=LiteralString(value="demo"))], forms=[FormBlock(fields=[FormField(id="ok", type="boolean", label="OK?")])])',
        'StartEvent(name="S", forms=[FormBlock(fields=[FormField(id="plan", type="enum", label="Plan", defaultValue=LiteralString(value="basic"), items=[Setting(key="required", value=LiteralBool(value="true")), Setting(key="minlength", value=LiteralInt(value=2))], values=[EnumValue(id="basic", label="Basic"), EnumValue(id="plus")], params=[IoParameter(direction="property", name="description", value=LiteralString(value="Sets the fee"))])])])',
        'StartEvent(name="S", forms=[FormBlock(fields=[FormField(id="plan", type="enum", values=[EnumValue(id="family"), EnumValue(id="property", label="Property")], params=[IoParameter(direction="property", name="x", value=LiteralString(value="y"))])])])',
        'StartEvent(name="S", forms=[FormBlock(fields=[FormField(id="blob", type="whatever", label="Blob")])])',
        'UserTask(name="T", items=[Setting(key="wibble", value=LiteralInt(value=1))])',
      ],
    ],
    [
      'settings values, including lists and maps, parse and nest correctly',
      `process p {
  call C(process: "x", binding: version)
    throw error("X", asyncBefore: true)
  emit signal Sig(asyncAfter: true)
  await message("M", exclusive: false)
  emit signal Sig subprocess S { user A }
  await message subprocess S { user A }
  service S { input a = [1, 2] }
  service S { input a = { k: 1 } }
  service S { input a = [{ k: 1 }, { k: [2, 3] }] }
  service S { input a = [] output b = { } }
}`,
      [
        'CallActivity(name="C", items=[Setting(key="process", value=LiteralString(value="x")), Setting(key="binding", value=VarRef(ref=->version))])',
        'ThrowStatement(trigger="error", items=[ParenValue(value=LiteralString(value="X")), Setting(key="asyncBefore", value=LiteralBool(value="true"))]), EmitStatement(trigger="signal", name="Sig", items=[Setting(key="asyncAfter", value=LiteralBool(value="true"))]), IntermediateCatchEvent(trigger="message", items=[ParenValue(value=LiteralString(value="M")), Setting(key="exclusive", value=LiteralBool(value="false"))])',
        'EmitStatement(trigger="signal", name="Sig"), SubProcess(name="S", body=Block(statements=[UserTask(name="A")]))',
        'IntermediateCatchEvent(trigger="message"), SubProcess(name="S", body=Block(statements=[UserTask(name="A")]))',
        'ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=ListLiteral(items=[LiteralInt(value=1), LiteralInt(value=2)]))])',
        'ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=MapLiteral(entries=[MapEntry(key="k", value=LiteralInt(value=1))]))])',
        'ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=ListLiteral(items=[MapLiteral(entries=[MapEntry(key="k", value=LiteralInt(value=1))]), MapLiteral(entries=[MapEntry(key="k", value=ListLiteral(items=[LiteralInt(value=2), LiteralInt(value=3)]))])]))])',
        'ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=ListLiteral), IoParameter(direction="output", name="b", value=MapLiteral)])',
      ],
    ],
    [
      'listeners and their settings parse in every block and binding shape',
      `process p {
  service S { input a = { "k-1": 1 } }
    service S { input a = ${FENCE}groovy
1 + 1
${FENCE} }
  service S { on start(class: "A") on end(expression: "\${b.m()}") }
  user T { on timeout after "PT1H" (class: "X") }
    user T { on end ${FENCE}groovy
execution.setVariable("x", 1)
${FENCE} }
    service S {
    on start(class: "com.acme.L") { field greeting = "hello" }
    on end ${FENCE}groovy
execution.setVariable("x", 1)
${FENCE}
  }
  subprocess S { on start(class: "X") } { user U }
    call C(process: "q") { on start(class: "X") }
  end E { on end(delegate: "\${bean}") }
}`,
      [
        'ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=MapLiteral(entries=[MapEntry(key="k-1", value=LiteralInt(value=1))]))])',
        'ServiceTask(name="S", params=[IoParameter(direction="input", name="a", value=ScriptLiteral(body="```groovy\\n1 + 1\\n```"))])',
        'ServiceTask(name="S", listeners=[Listener(event="start", items=[Setting(key="class", value=LiteralString(value="A"))]), Listener(event="end", items=[Setting(key="expression", value=RawExpr(raw="${b.m()}"))])])',
        'UserTask(name="T", listeners=[Listener(event="timeout", particle="after", time="PT1H", items=[Setting(key="class", value=LiteralString(value="X"))])])',
        'UserTask(name="T", listeners=[Listener(event="end", script="```groovy\\nexecution.setVariable(\\"x\\", 1)\\n```")])',
        'ServiceTask(name="S", listeners=[Listener(event="start", items=[Setting(key="class", value=LiteralString(value="com.acme.L"))], params=[IoParameter(direction="field", name="greeting", value=LiteralString(value="hello"))]), Listener(event="end", script="```groovy\\nexecution.setVariable(\\"x\\", 1)\\n```")])',
        'SubProcess(name="S", listeners=[Listener(event="start", items=[Setting(key="class", value=LiteralString(value="X"))])], body=Block(statements=[UserTask(name="U")]))',
        'CallActivity(name="C", items=[Setting(key="process", value=LiteralString(value="q"))], listeners=[Listener(event="start", items=[Setting(key="class", value=LiteralString(value="X"))])]), EndEvent(name="E", listeners=[Listener(event="end", items=[Setting(key="delegate", value=RawExpr(raw="${bean}"))])])',
      ],
    ],
    [
      'settings, a form block, parameters and listeners mix on one element',
      `process p {
  user T(assignee: "demo", exclusive: false) {form { ok: boolean "OK?" }
    input a = 1
    on create(class: "com.acme.L")
    }
}`,
      '[UserTask(name="T", items=[Setting(key="assignee", value=LiteralString(value="demo")), Setting(key="exclusive", value=LiteralBool(value="false"))], forms=[FormBlock(fields=[FormField(id="ok", type="boolean", label="OK?")])], params=[IoParameter(direction="input", name="a", value=LiteralInt(value=1))], listeners=[Listener(event="create", items=[Setting(key="class", value=LiteralString(value="com.acme.L"))])])]',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });

  test.each<[tail: string, forms: number, bodyTypes: string[]]>([
    ['{ form { } } { user U(assignee: "demo") }', 1, ['UserTask']],
    ['{ } { user U }', 0, ['UserTask']],
    ['{ user U }', 0, ['UserTask']],
    ['{ }', 0, []],
  ])(
    '`subprocess S %s` splits its member block from its body',
    async (tail, forms, bodyTypes) => {
      const sub = await statementAt<SubProcess>(
        `process p { subprocess S ${tail} }`,
      );
      expect(sub.forms).toHaveLength(forms);
      expect(sub.body.statements.map((s) => s.$type)).toEqual(bodyTypes);
    },
  );
});

describe("Parsing - an external task's extras", () => {
  // Neither word of `error <Code> when <condition>` is reserved, so a
  // misspelt `when` parses for the validator to report.
  test.each<Row>([
    [
      'an external task takes a priority, property lines and error mappings among its members',
      `process p { error E service V(topic: "t", taskPriority: 42) { property k = "v" error E when externalTask.errorMessage == "declined" property j = "w" } }`,
      'Process(name="p", decls=[CodeDecl(kind="error", name="E")], body=[ServiceTask(name="V", items=[Setting(key="topic", value=LiteralString(value="t")), Setting(key="taskPriority", value=LiteralInt(value=42))], params=[IoParameter(direction="property", name="k", value=LiteralString(value="v")), IoParameter(direction="property", name="j", value=LiteralString(value="w"))], errorMappings=[ErrorMapping(trigger="error", code=->E, when="when", condition=Equality(left=VarRef(ref=->externalTask, accessors=[Accessor(prop="errorMessage")]), op="==", right=LiteralString(value="declined")))])])',
    ],
    [
      'a bare condition ends where the next member starts',
      `process p { service V(topic: "t") { error E when ready property k = "v" } }`,
      'Process(name="p", body=[ServiceTask(name="V", items=[Setting(key="topic", value=LiteralString(value="t"))], errorMappings=[ErrorMapping(trigger="error", code=->E, when="when", condition=VarRef(ref=->ready))], params=[IoParameter(direction="property", name="k", value=LiteralString(value="v"))])])',
    ],
    [
      'a mapping with a word other than `when` parses, so the validator can name the word',
      `process p { service V(topic: "t") { error E wenn "\${x}" } }`,
      'Process(name="p", body=[ServiceTask(name="V", items=[Setting(key="topic", value=LiteralString(value="t"))], errorMappings=[ErrorMapping(trigger="error", code=->E, when="wenn", condition=RawExpr(raw="${x}"))])])',
    ],
  ])('%s', async (_title, source, expected) => {
    await expectProcess(source, expected);
  });
});

describe('Parsing - task kinds, service bindings and fenced scripts', () => {
  const KINDS = [
    ['step', 'GenericTask'],
    ['send', 'SendTask'],
    ['receive', 'ReceiveTask'],
    ['decide', 'BusinessRuleTask'],
  ] as const;

  test.each<BodyRow>([
    ...KINDS.map(([keyword, type]): Row => [
      `\`${keyword}\` after \`start S\` opens its own statement rather than filling the start's trigger slot`,
      `process p { start S ${keyword} X user U end E }`,
      `[StartEvent(name="S"), ${type}(name="X"), UserTask(name="U"), EndEvent(name="E")]`,
    ]),
    [
      'fenced scripts are captured verbatim alongside other binding shapes',
      `process p {
  service ship(topic: "shipping")
    script total ${FENCE}js
x = 1
${FENCE}
    service Auto(class: com.acme.X)
  user Review(assignee: "\${bean.pick()}")
  script total ${FENCE}js
y = 2
${FENCE}
    script guard ${FENCE}js
if (a) { }
${FENCE}
}`,
      [
        'ServiceTask(name="ship", items=[Setting(key="topic", value=LiteralString(value="shipping"))])',
        'ScriptTask(name="total", body="```js\\nx = 1\\n```")',
        'ServiceTask(name="Auto", items=[Setting(key="class", value=VarRef(ref=->com, accessors=[Accessor(prop="acme"), Accessor(prop="X")]))]), UserTask(name="Review", items=[Setting(key="assignee", value=RawExpr(raw="${bean.pick()}"))]), ScriptTask(name="total", body="```js\\ny = 2\\n```")',
        'ScriptTask(name="guard", body="```js\\nif (a) { }\\n```")',
      ],
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });
});

describe('Parsing - repeat clause', () => {
  test.each<BodyRow>([
    [
      'a repeat clause parses its element, collection, count, and condition correctly',
      `process p {
  user U for each line in lines
  user U for each in lines
  user U for 3
  user U for 2 each line in lines
  user U for each line in lines sequentially
  user U for each line in lines until (nrOfCompletedInstances >= 2)
  user U for each line in "\${order.lines}" sequentially until (done) (label: "Label", assignee: "demo")
  start S user U for each line in lines end E
}`,
      [
        'UserTask(name="U", element="line", collection=VarRef(ref=->lines))',
        'UserTask(name="U", collection=VarRef(ref=->lines))',
        'UserTask(name="U", cardinality=LiteralInt(value=3))',
        'UserTask(name="U", cardinality=LiteralInt(value=2), element="line", collection=VarRef(ref=->lines))',
        'UserTask(name="U", element="line", collection=VarRef(ref=->lines), sequential=true)',
        'UserTask(name="U", element="line", collection=VarRef(ref=->lines), completion=Relational(left=VarRef(ref=->nrOfCompletedInstances), op=">=", right=LiteralInt(value=2)))',
        'UserTask(name="U", element="line", collection=RawExpr(raw="${order.lines}"), sequential=true, completion=VarRef(ref=->done), items=[Setting(key="label", value=LiteralString(value="Label")), Setting(key="assignee", value=LiteralString(value="demo"))])',
        'StartEvent(name="S"), UserTask(name="U", element="line", collection=VarRef(ref=->lines)), EndEvent(name="E")',
      ],
    ],
  ])('%s', async (_title, source, expected) => {
    await expectBody(source, expected);
  });

  // `script` and `subprocess` are followed by a brace-opened body, the only
  // shape a lookahead ambiguity could surface in.
  const SET = '(asyncBefore: true)';

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
    ['call', 'CallActivity', (c) => `process p { call C ${c} ${SET} }`],
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
      expect((task.collection as VarRef).ref.$refText).toBe('lines');
      expect(task.sequential).toBe(true);
      expect((task.completion as VarRef).ref.$refText).toBe('done');
      expect(settingsOf(task.items).map((a) => a.key)).toEqual(['asyncBefore']);
    },
  );
});

/** Chevrotain's list-of-alternatives wording, which carries no guidance. */
const STOCK_ALTERNATIVES = '<stock list of token alternatives>';

const reservedWord = (word: string) =>
  `'${word}' is a reserved word and cannot be used as a plain name here. ` +
  `To refer to a variable named '${word}', write it as a quoted raw expression: "\${${word}}".`;

const notAStepKeyword = (word: string) =>
  `'${word}' is neither a known declaration nor a step keyword. ` +
  "A declaration starting with a plain word is 'error' or 'escalation' " +
  'followed by the name it declares; every step starts ' +
  "with a keyword such as 'start', 'user', 'service', 'if', 'on', 'throw', 'emit', ...";

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

describe('Parsing - sources the parser rejects', () => {
  test.each<readonly [string, string, readonly string[]]>([
    [
      'parallel requires at least two branches',
      `process p { parallel { { user A } } }`,
      [STOCK_ALTERNATIVES, 'Expecting end of file but found `}`.'],
    ],
    // The `else if` row blames `if`: with the parens breaking the `else if`
    // shape, the lookahead settles on `else` opening a plain block.
    [
      'an else if head takes no settings: the if head governs the whole chain',
      `process p { if (a) { user A } else if (b) (asyncBefore: true) { user B } }`,
      [
        "Expecting token of type '{' but found `if`.",
        "Expected '}' before the end of the file: a block is still open.",
      ],
    ],
    [
      'a parallel branch head takes no settings: the parallel head governs the fork and the join',
      `process p { parallel { if (a) (asyncBefore: true) { user A } { user B } } }`,
      ["Expecting token of type '{' but found `(`."],
    ],
    [
      'a race requires at least two branches',
      `process p { await { message("M") { user U } } }`,
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
      `process p { usr }`,
      [notAStepKeyword('usr')],
    ],
    [
      'a declaration kind followed by text blames the name slot, not the kind word',
      `process p { error "PF" }`,
      ['Expecting token of type \'ID\' but found `"PF"`.'],
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
        ['a throw', `throw error(E) for 3`],
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
      'a reserved word in the type slot of a form field gets the reserved-word guidance',
      'process p {\n  start S\n  user U { form { amount: while } }\n}',
      [
        reservedWord('while'),
        "Expecting token of type '(' but found `}`.",
        "Expecting token of type 'EOF' but found `}`.",
      ],
    ],
    [
      'an ordinary word in the type slot gets the same guidance',
      'process p {\n  var amount: text\n  start S\n}',
      [notATypeWord('text'), reservedWord('start')],
    ],
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

type LabelCarrier = readonly [keyword: string, head: string, tail: string];

const LABEL_CARRIERS: readonly LabelCarrier[] = [
  ['process', 'process p', '{ start S }'],
  ['start', 'process p { start S', '}'],
  ['end', 'process p { end E', '}'],
  ['user', 'process p { user X', '}'],
  ['service', 'process p { service X', '}'],
  ['step', 'process p { step X', '}'],
  ['send', 'process p { send X', '}'],
  ['receive', 'process p { receive X', '}'],
  ['decide', 'process p { decide X', '}'],
  ['script', 'process p { script X', `${FENCE}js\nwork()\n${FENCE} }`],
  ['subprocess', 'process p { subprocess S', '{ user U } }'],
  ['call', 'process p { call C', '}'],
];

describe('Parsing - a slot has one spelling', () => {
  test.each<readonly [title: string, refused: string, taken: string]>([
    ...LABEL_CARRIERS.map(
      ([keyword, head, tail]) =>
        [
          `a \`${keyword}\` label is a setting, not a string after the name`,
          `${head} "L" ${tail}`,
          `${head}(label: "L") ${tail}`,
        ] as const,
    ),
    [
      'an element setting is written in the parens, not in the block',
      `process p { user U { assignee = "demo" } }`,
      `process p { user U(assignee: "demo") }`,
    ],
    [
      'a call setting is written in the parens, not in the block',
      `process p { call C { process = "q" } }`,
      `process p { call C(process: "q") }`,
    ],
    [
      'a listener binding is written in the parens, not in a block of its own',
      `process p { user U { on create { class = "com.acme.L" } } }`,
      `process p { user U { on create(class: "com.acme.L") } }`,
    ],
    [
      'a process label is a setting on the head, not a header declaration',
      `process p { label = "L" start S }`,
      `process p(label: "L") { start S }`,
    ],
    [
      'a process setting is written on the head, not as a header declaration',
      `process p { versionTag = "1.4" start S }`,
      `process p(versionTag: "1.4") { start S }`,
    ],
    [
      "an error's message rides its declaration, not a declaration of its own",
      `process p { error "PF" message "Payment failed" start S }`,
      `process p { error PF(message: "Payment failed") start S }`,
    ],
    [
      'a start names its message in the parens',
      `process p { start S message "M" }`,
      `process p { start S message("M") }`,
    ],
    [
      'a start times its timer in the parens',
      `process p { start S timer after "PT1H" }`,
      `process p { start S timer("PT1H") }`,
    ],
    [
      'an end carries whatever it names in the parens',
      `process p { end E terminate "X" }`,
      `process p { end E terminate("X") }`,
    ],
    [
      'a handler names its code in the parens',
      `process p { on error "X" { user A } }`,
      `process p { on error("X") { user A } }`,
    ],
    [
      'a handler times its timer in the parens',
      `process p { on timer after "PT1H" { user A } }`,
      `process p { on timer("PT1H") { user A } }`,
    ],
    [
      'a handler marks itself non-interrupting with a flag in the parens',
      `process p { on signal("S") alongside { user A } }`,
      `process p { on signal("S", alongside) { user A } }`,
    ],
    [
      'a throw names its code in the parens',
      `process p { throw error "C" }`,
      `process p { throw error("C") }`,
    ],
    [
      'an emit names its code in the parens',
      `process p { emit signal "S" }`,
      `process p { emit signal("S") }`,
    ],
    [
      'an awaited event names its message in the parens',
      `process p { await message "M" }`,
      `process p { await message("M") }`,
    ],
    [
      'an awaited event times its timer in the parens',
      `process p { await timer after "PT1H" }`,
      `process p { await timer("PT1H") }`,
    ],
    [
      'a race branch heads on the same parens a plain await does',
      `process p { await { message "M" { user A } timer after "PT1H" { user B } } }`,
      `process p { await { message("M") { user A } timer("PT1H") { user B } } }`,
    ],
  ])('%s', async (_title, refused, taken) => {
    expect(await parseErrors(refused)).not.toEqual([]);
    expect(await parseErrors(taken)).toEqual([]);
  });
});
