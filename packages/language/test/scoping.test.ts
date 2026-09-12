/**
 * Scoping and reserved-word guidance, driven through the real parser and linker
 * (`parseHelper`, with `{ validation: true }` where linking must run).
 *
 * A `goto` resolves only within its nearest enclosing container, the `process`,
 * `subprocess`, or `on` handler body it directly sits in, and a `subprocess`
 * statement is itself a target by name. A cross-boundary `goto` fails to
 * resolve, and the custom linker replaces the stock "Could not resolve
 * reference" message with a boundary explanation rather than adding to it. A
 * handler has no name of its own, so it is named in that message by its header.
 *
 * A hosted handler lowers inline into its host's container rather than into one
 * of its own, which makes its body transparent to the container walk: a `goto`
 * crosses between the handler body and the main flow in both directions, while
 * a host-less handler nested inside it stays a boundary of its own.
 *
 * Each row of the resolution tables carries one program and the whole oracle
 * {@link resolutionsOf} reads off it: every `goto` target and every handler
 * host in document order, then every error-severity diagnostic. Asserting the
 * complete list pins what each reference reaches, the exact boundary wording,
 * and that nothing stacks a second diagnostic on a replaced one. Diagnostic
 * severity follows the LSP convention: `1 = Error`, `2 = Warning`.
 *
 * A code reference is the third kind and asks the same question the other way
 * round: every identifier in every expression is one, so what separates a code
 * from a variable is the scope it is resolved in. {@link codeResolutionsOf}
 * therefore reads every identifier and every diagnostic of either severity, so
 * a scope reaching further than a code position shows up as a resolved
 * identifier where a warning belongs.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import {
  AstUtils,
  EmptyFileSystem,
  type AstNode,
  type Reference,
} from 'langium';
import { parseHelper } from 'langium/test';
import type { Model, OnHandler } from '@bpmn-script/language';
import {
  createBpmnScriptServices,
  isGotoStatement,
  isOnHandler,
  isProcess,
  isSubProcess,
  isVarRef,
  payloadTextOf,
} from '@bpmn-script/language';
import {
  UNREACHABLE,
  undeclaredVariable,
  withTextMessages,
} from './helpers/diagnostics.js';

const SEVERITY_ERROR = 1;

let services: ReturnType<typeof createBpmnScriptServices>;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/** A row of the resolution tables: a title, a program, and its whole oracle. */
type Row = readonly [
  title: string,
  source: string,
  expected: readonly string[],
];

/**
 * The handler as its source header reads, since a handler has no name to be
 * identified by: `on <host>: <trigger>(<payload>)`, each part where written.
 */
function headerOf(handler: OnHandler): string {
  const head = handler.host
    ? `on ${handler.host.$refText}: ${handler.trigger}`
    : `on ${handler.trigger}`;
  const code = payloadTextOf(handler.items);
  return code ? `${head}(${code})` : head;
}

/**
 * A resolved node as `container/.../name:Type`, naming every flow container it
 * sits in. The path is what distinguishes two same-named steps in different
 * processes or containers, which is the whole question these tables ask.
 */
function pathOf(node: AstNode): string {
  const segments: string[] = [];
  for (let n: AstNode | undefined = node.$container; n; n = n.$container) {
    if (isProcess(n) || isSubProcess(n)) {
      segments.unshift(n.name ?? '<unnamed>');
    } else if (isOnHandler(n)) {
      segments.unshift(headerOf(n));
    }
  }
  const name = (node as { name?: string }).name ?? '<unnamed>';
  return [...segments, `${name}:${node.$type}`].join('/');
}

function targetOf(reference: Reference<AstNode>): string {
  return reference.ref ? pathOf(reference.ref) : 'unresolved';
}

/**
 * Every `goto` target and handler host of `source` in document order, then
 * every error-severity diagnostic. Warnings are left out: nothing here raises
 * one, and an unrelated validator's warning would say nothing about scoping.
 */
async function resolutionsOf(source: string): Promise<string[]> {
  const document = await parse(source, { validation: true });
  expect(document.parseResult.parserErrors.map((e) => e.message)).toEqual([]);

  const lines: string[] = [];
  for (const node of AstUtils.streamAst(document.parseResult.value)) {
    if (isGotoStatement(node)) {
      lines.push(`goto ${node.target.$refText} -> ${targetOf(node.target)}`);
    } else if (isOnHandler(node) && node.host) {
      lines.push(`host ${node.host.$refText} -> ${targetOf(node.host)}`);
    }
  }
  for (const diagnostic of withTextMessages(document.diagnostics ?? [])) {
    if (diagnostic.severity === SEVERITY_ERROR) {
      lines.push(`error: ${diagnostic.message}`);
    }
  }
  return lines;
}

/** The body every resolution table runs. */
async function checkRow(
  _title: string,
  source: string,
  expected: readonly string[],
): Promise<void> {
  expect(await resolutionsOf(source)).toEqual(expected);
}

/**
 * Every identifier of `source` in document order with what it resolves to,
 * then every diagnostic of either severity. Warnings are in because the
 * undeclared-variable one is what an identifier outside a code position has to
 * keep producing.
 */
async function codeResolutionsOf(source: string): Promise<string[]> {
  const document = await parse(source, { validation: true });
  expect(document.parseResult.parserErrors.map((e) => e.message)).toEqual([]);

  const lines: string[] = [];
  for (const node of AstUtils.streamAst(document.parseResult.value)) {
    if (isVarRef(node)) {
      lines.push(`${node.ref.$refText} -> ${targetOf(node.ref)}`);
    }
  }
  for (const diagnostic of withTextMessages(document.diagnostics ?? [])) {
    const severity =
      diagnostic.severity === SEVERITY_ERROR ? 'error' : 'warning';
    lines.push(`${severity}: ${diagnostic.message}`);
  }
  return lines;
}

/** The body the code-resolution table runs. */
async function checkCodeRow(
  _title: string,
  source: string,
  expected: readonly string[],
): Promise<void> {
  expect(await codeResolutionsOf(source)).toEqual(expected);
}

/** The trailing sentence of a boundary explanation, by the boundary crossed. */
const BOUNDARY_RULE = {
  subprocess: 'a goto cannot cross a subprocess boundary.',
  handler:
    "a goto cannot cross an event handler boundary: an event handler's steps run only when its event fires.",
  host: 'a boundary event attaches to an activity in its own scope.',
} as const;

/** The linker's replacement for the stock unresolved-reference message. */
function boundary(
  name: string,
  where: string,
  rule: keyof typeof BOUNDARY_RULE,
): string {
  return `error: '${name}' is ${where}; ${BOUNDARY_RULE[rule]}`;
}

/** The stock message, kept wherever the name exists nowhere in the process. */
function stockError(name: string): string {
  return `error: Could not resolve reference to Statement named '${name}'.`;
}

/** Raised on every two-process fixture below, which needs both to ask its question. */
const MULTI_PROCESS =
  'error: Only one process is supported per file. Move additional processes into separate files.';

describe('Scoping - process-scoped goto', () => {
  test.each<Row>([
    [
      'a goto reaches a step of its own process',
      `process p { user Foo goto Foo }`,
      ['goto Foo -> p/Foo:UserTask'],
    ],
    [
      'a goto reaches a step nested in a parallel branch, which the block-lexical scope would hide',
      `process p { parallel { { user A } { user B } } goto A }`,
      [
        'goto A -> p/A:UserTask',
        "error: 'goto A' jumps into a branch of a 'parallel' statement from outside that branch; a branch's steps run only when the whole 'parallel' statement is reached, not via an external 'goto'.",
      ],
    ],
    [
      'a goto stays in its own process where the name exists in another too',
      `process a { user Dup goto Dup } process b { user Dup }`,
      ['goto Dup -> a/Dup:UserTask', MULTI_PROCESS],
    ],
    [
      'a goto does not reach a step only another process has',
      `process a { user Foo goto Only } process b { user Only }`,
      ['goto Only -> unresolved', stockError('Only'), MULTI_PROCESS],
    ],
    [
      'a goto to a name no process has does not resolve',
      `process p { user Foo goto Missing }`,
      ['goto Missing -> unresolved', stockError('Missing')],
    ],
    [
      'a goto reaches a named await',
      `process p { await message Wait("M") goto Wait }`,
      ['goto Wait -> p/Wait:IntermediateCatchEvent'],
    ],
  ])('%s', checkRow);
});

describe('Scoping - container-scoped goto (subprocess boundary)', () => {
  test.each<Row>([
    [
      'a goto outside a subprocess does not reach a step inside it',
      `process p { subprocess Sub { user Inner } goto Inner }`,
      [
        'goto Inner -> unresolved',
        boundary('Inner', `inside subprocess 'Sub'`, 'subprocess'),
      ],
    ],
    [
      'a goto inside a subprocess reaches a step of that subprocess',
      `process p { subprocess Sub { user Inner goto Inner } }`,
      ['goto Inner -> p/Sub/Inner:UserTask'],
    ],
    [
      'a goto inside a subprocess reaches a sibling step nested in an if block',
      `process p { subprocess Sub { if (true) { user Deep } goto Deep } }`,
      ['goto Deep -> p/Sub/Deep:UserTask'],
    ],
    [
      'a goto inside a subprocess does not reach a parent-body step',
      `process p { user Outer subprocess Sub { goto Outer } }`,
      [
        'goto Outer -> unresolved',
        boundary('Outer', `outside subprocess 'Sub'`, 'subprocess'),
      ],
    ],
    [
      'a goto reaches the subprocess statement itself by its own name',
      `process p { subprocess Sub { user Inner } goto Sub }`,
      ['goto Sub -> p/Sub:SubProcess'],
    ],
    [
      'a goto in an outer subprocess does not reach a step of a nested one',
      `process p { subprocess Outer { subprocess Inner { user Deep } goto Deep } }`,
      [
        'goto Deep -> unresolved',
        boundary('Deep', `inside subprocess 'Inner'`, 'subprocess'),
      ],
    ],
    [
      'a goto to a name nowhere in the process keeps the stock message',
      `process p { subprocess Sub { user Inner } goto Missing }`,
      ['goto Missing -> unresolved', stockError('Missing')],
    ],
  ])('%s', checkRow);
});

describe('Scoping - container-scoped goto (event-handler boundary)', () => {
  test.each<Row>([
    [
      'a goto outside a handler does not reach a step inside it',
      `process p { error PAYMENT_FAILED goto Inner on error(PAYMENT_FAILED) { user Inner } }`,
      [
        'goto Inner -> unresolved',
        boundary(
          'Inner',
          `inside the 'on error(PAYMENT_FAILED)' handler`,
          'handler',
        ),
      ],
    ],
    [
      'a goto inside a handler reaches a step of that handler body',
      `process p { error PAYMENT_FAILED user Main on error(PAYMENT_FAILED) { user Inner goto Inner } }`,
      ['goto Inner -> p/on error(PAYMENT_FAILED)/Inner:UserTask'],
    ],
    [
      'a goto inside a handler reaches a sibling step nested in an if block',
      `process p { error PAYMENT_FAILED user Main on error(PAYMENT_FAILED) { if (true) { user Deep } goto Deep } }`,
      ['goto Deep -> p/on error(PAYMENT_FAILED)/Deep:UserTask'],
    ],
    [
      'a goto inside a handler does not reach a step of the enclosing body',
      `process p { error PAYMENT_FAILED user Outer on error(PAYMENT_FAILED) { goto Outer } }`,
      [
        'goto Outer -> unresolved',
        boundary(
          'Outer',
          `outside the 'on error(PAYMENT_FAILED)' handler`,
          'handler',
        ),
      ],
    ],
    [
      'a goto in an outer handler does not reach a step of a nested one',
      `process p { error Outer escalation Inner user Main on error(Outer) { goto Deep on escalation(Inner) { user Deep } } }`,
      [
        'goto Deep -> unresolved',
        boundary(
          'Deep',
          `inside the 'on escalation(Inner)' handler`,
          'handler',
        ),
      ],
    ],
    [
      'a catch-all handler is named without quoting a code',
      `process p { goto Inner on error { user Inner } }`,
      [
        'goto Inner -> unresolved',
        boundary('Inner', `inside an 'on error' handler`, 'handler'),
      ],
    ],
    [
      'the handler the goto sits in is named where the target is outside it',
      `process p { escalation LOW_STOCK user Outer on escalation(LOW_STOCK) { goto Outer } }`,
      [
        'goto Outer -> unresolved',
        boundary(
          'Outer',
          `outside the 'on escalation(LOW_STOCK)' handler`,
          'handler',
        ),
      ],
    ],
    [
      'a goto to a name nowhere in the process keeps the stock message',
      `process p { error PAYMENT_FAILED goto Missing on error(PAYMENT_FAILED) { user Inner } }`,
      ['goto Missing -> unresolved', stockError('Missing')],
    ],
    [
      'an `on timer` handler is named by its code-less header',
      `process p { goto Inner on timer(at: "2026-08-01T09:00:00") { user Inner } }`,
      [
        'goto Inner -> unresolved',
        boundary('Inner', `inside an 'on timer' handler`, 'handler'),
      ],
    ],
    [
      'a goto inside an `on message` handler reaches a step of that handler body',
      `process p { user Main on message("Invoice Received") { user Inner goto Inner } }`,
      ['goto Inner -> p/on message(Invoice Received)/Inner:UserTask'],
    ],
    [
      'a goto reaches a named throw and a named emit of its own container',
      `process p { error PAYMENT_FAILED escalation LOW_STOCK goto Failed goto Ping throw error Failed(PAYMENT_FAILED) emit escalation Ping(LOW_STOCK) }`,
      [
        'goto Failed -> p/Failed:ThrowStatement',
        'goto Ping -> p/Ping:EmitStatement',
        `error: ${UNREACHABLE}`,
      ],
    ],
    [
      'a goto to a named throw inside a handler is a boundary crossing, not a missing name',
      `process p { error PAYMENT_FAILED goto Failed on error(PAYMENT_FAILED) { throw error Failed(PAYMENT_FAILED) } }`,
      [
        'goto Failed -> unresolved',
        boundary(
          'Failed',
          `inside the 'on error(PAYMENT_FAILED)' handler`,
          'handler',
        ),
      ],
    ],
  ])('%s', checkRow);
});

describe('Scoping - hosted handler host reference', () => {
  test.each<Row>([
    [
      "a host reaches an activity of the handler's own container",
      `process p { user Review on Review: timer("PT2H") { } }`,
      ['host Review -> p/Review:UserTask'],
    ],
    [
      'a host reaches an activity nested in an if block of that container',
      `process p { if (true) { user Deep } on Deep: message("Cancelled") { } }`,
      ['host Deep -> p/Deep:UserTask'],
    ],
    [
      'a host does not reach into a sibling subprocess',
      `process p { error X subprocess Sub { user Inner } on Inner: error(X) { } }`,
      [
        'host Inner -> unresolved',
        boundary('Inner', `inside subprocess 'Sub'`, 'host'),
      ],
    ],
    [
      'a host does not reach into a host-less handler body',
      `process p { error X user Review on error(X) { user Inner } on Inner: message("Cancelled") { } }`,
      [
        'host Inner -> unresolved',
        boundary('Inner', `inside the 'on error(X)' handler`, 'host'),
      ],
    ],
    [
      'a host does not reach an activity of another process',
      `process a { user Review on Only: signal("Cancelled") { } } process b { user Only }`,
      ['host Only -> unresolved', stockError('Only'), MULTI_PROCESS],
    ],
    [
      "a host reads the handler's container, not the handler's own body",
      `process p { error X user Review on Review: error(X) { user Review2 } }`,
      ['host Review -> p/Review:UserTask'],
    ],
    [
      "a host inside a subprocess reaches that subprocess's own step",
      `process p { error X user Outer subprocess Sub { user Review on Review: error(X) { } } }`,
      ['host Review -> p/Sub/Review:UserTask'],
    ],
    [
      'a host inside a subprocess does not reach a step of the enclosing process',
      `process p { error X user Outer subprocess Sub { user Review on Outer: error(X) { } } }`,
      [
        'host Outer -> unresolved',
        boundary('Outer', `outside subprocess 'Sub'`, 'host'),
      ],
    ],
    [
      'a host naming nothing anywhere keeps the stock message',
      `process p { error X user Review on Missing: error(X) { } }`,
      ['host Missing -> unresolved', stockError('Missing')],
    ],
  ])('%s', checkRow);
});

describe('Scoping - goto through a hosted handler body', () => {
  test.each<Row>([
    [
      'a goto inside a hosted handler body reaches a main-flow step',
      `process p { error X user Review user Next on Review: error(X) { goto Next } }`,
      ['host Review -> p/Review:UserTask', 'goto Next -> p/Next:UserTask'],
    ],
    [
      'a main-flow goto reaches a step inside a hosted handler body',
      `process p { error X user Review goto Fix on Review: error(X) { user Fix } }`,
      [
        'goto Fix -> p/on Review: error(X)/Fix:UserTask',
        'host Review -> p/Review:UserTask',
      ],
    ],
    [
      'a hosted handler body inside a subprocess stays isolated from the process body',
      `process p { error X user Outer subprocess Sub { user Review on Review: error(X) { goto Outer } } }`,
      [
        'host Review -> p/Sub/Review:UserTask',
        'goto Outer -> unresolved',
        boundary('Outer', `outside subprocess 'Sub'`, 'subprocess'),
      ],
    ],
    [
      'a host-less handler nested in a hosted handler body is still its own container',
      `process p { error X escalation Y user Review on Review: error(X) { goto Inner on escalation(Y) { user Inner } } }`,
      [
        'host Review -> p/Review:UserTask',
        'goto Inner -> unresolved',
        boundary('Inner', `inside the 'on escalation(Y)' handler`, 'handler'),
      ],
    ],
  ])('%s', checkRow);
});

describe('Scoping - container-scoped goto (compensation handler boundary)', () => {
  test.each<Row>([
    [
      'a subprocess-body goto does not reach a step inside its `on compensation` handler',
      `process p { subprocess Sub { goto Inner on compensation { user Inner } } }`,
      [
        'goto Inner -> unresolved',
        boundary('Inner', `inside an 'on compensation' handler`, 'handler'),
      ],
    ],
    [
      'a goto inside an `on compensation` handler reaches a step of that handler body',
      `process p { subprocess Sub { user Main on compensation { user Inner goto Inner } } }`,
      ['goto Inner -> p/Sub/on compensation/Inner:UserTask'],
    ],
    [
      'a goto reaches a named `throw compensation`, whose code is optional',
      `process p { subprocess Sub { goto Undo throw compensation Undo } }`,
      ['goto Undo -> p/Sub/Undo:ThrowStatement'],
    ],
  ])('%s', checkRow);
});

describe('Scoping - code declarations reached from a code position', () => {
  test.each<Row>([
    [
      'a thrown code resolves to the declaration of that name',
      `process p { error OUT_OF_STOCK(message: "Out of stock") user Pack throw error(OUT_OF_STOCK) }`,
      ['OUT_OF_STOCK -> p/OUT_OF_STOCK:CodeDecl'],
    ],
    [
      'an emitted escalation code resolves the same way',
      `process p { escalation MANUAL_REVIEW user Pack emit escalation(MANUAL_REVIEW) }`,
      ['MANUAL_REVIEW -> p/MANUAL_REVIEW:CodeDecl'],
    ],
    [
      'a caught code resolves from a boundary handler',
      `process p { error OUT_OF_STOCK(message: "Out of stock") user Pack on Pack: error(OUT_OF_STOCK) { user F } }`,
      ['OUT_OF_STOCK -> p/OUT_OF_STOCK:CodeDecl'],
    ],
    [
      'a code position naming nothing declared says how to declare it',
      `process p { user Pack throw error(NOPE) }`,
      [
        'NOPE -> unresolved',
        `error: 'NOPE' is not declared. Add 'error NOPE' to the process.`,
      ],
    ],
    [
      'the missing declaration is named with the trigger word it was written under',
      `process p { user Pack emit escalation(NOPE) }`,
      [
        'NOPE -> unresolved',
        `error: 'NOPE' is not declared. Add 'escalation NOPE' to the process.`,
      ],
    ],
    [
      'a code position does not reach a declaration of another kind',
      `process p { error CODE(message: "m") user A emit escalation(CODE) user B }`,
      [
        'CODE -> unresolved',
        `error: 'CODE' is declared as an error, not an escalation.`,
      ],
    ],
    [
      'a code position does not reach a declaration of another process',
      `process a { error X(message: "x") user U } process b { user V throw error(X) }`,
      [
        'X -> unresolved',
        `error: 'X' is not declared. Add 'error X' to the process.`,
        MULTI_PROCESS,
      ],
    ],
    [
      'an expression position does not reach a declared code, and still warns as an undeclared variable',
      `process p { error PAYMENT_DECLINED(message: "x") user A if (PAYMENT_DECLINED) { user B } }`,
      [
        'PAYMENT_DECLINED -> unresolved',
        `warning: ${undeclaredVariable('PAYMENT_DECLINED')}`,
      ],
    ],
    [
      'a declared variable in an expression position resolves to no declaration and raises nothing',
      `process p { var amount: number user A if (amount > 100) { user B } }`,
      ['amount -> unresolved'],
    ],
    [
      'a condition payload is an expression, not a code, whichever way it is written',
      `process p { var ready: boolean user Check on Check: condition(ready) { user B } }`,
      ['ready -> unresolved'],
    ],
  ])('%s', checkCodeRow);
});

describe('Scoping - reserved-word guidance', () => {
  /**
   * A reserved word reaches the guidance down two Chevrotain paths: a
   * no-viable-alternative error in expression position, and a mismatched-token
   * error where the grammar expects exactly `ID`.
   */
  const RESERVED_DATE =
    "'date' is a reserved word and cannot be used as a plain name here. To refer to a variable named 'date', write it as a quoted raw expression: \"${date}\".";

  test.each<Row>([
    [
      'a reserved word in expression position points to the raw-string fallback',
      `process p { if (date > deadline) { user A } }`,
      [RESERVED_DATE],
    ],
    [
      'a reserved word in a name position points to the raw-string fallback',
      `process p { user date }`,
      [RESERVED_DATE],
    ],
    [
      'a plain identifier in the same expression position parses cleanly',
      `process p { if (status > deadline) { user A } }`,
      [],
    ],
  ])('%s', async (_title, source, expected) => {
    const document = await parse(source);
    expect(document.parseResult.parserErrors.map((e) => e.message)).toEqual(
      expected,
    );
  });
});
