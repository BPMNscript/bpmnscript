import { describe, expect, it } from 'vitest';

import { astToIr } from '../src/ast-to-ir.js';
import {
  makeDefaultFlowId,
  makeEventSubProcessId,
  makeGatewayLoopId,
  makeThrowEventId,
} from '../src/synthesize-ids.js';
import type {
  BpmnProcess,
  CallActivity,
  FlowContainer,
  Repeatable,
} from '../src/ir/types.js';
import { byId, only, subProcess } from './helpers/ir-query.js';
import {
  builtinBinding,
  classBinding,
  conditionDef,
  edge,
  errorDef,
  escalationDef,
  exprBinding,
  externalBinding,
  gateway,
  messageDef,
  processIr,
  scriptTask,
  scriptValue,
  signalDef,
  timerDef,
} from './helpers/ir-fixtures.js';
import { ir, parse } from './helpers/parse.js';

// Round trips pin valid lowering; this file keeps synthesized ids, fallbacks on rejected source and silent normalizations.

// An error and an escalation share one declaration namespace, so the
// escalation with code `X` needs a name of its own.
const CODE_DECLS = 'error PF error X escalation LS escalation EscX(code: "X")';

/**
 * Lowers `source(written)` for each row and compares what `read` takes off each
 * result against the row's expectation, all rows in one keyed record.
 */
async function expectLowering(
  rows: ReadonlyArray<readonly [string, unknown]>,
  source: (written: string) => string,
  read: (process: BpmnProcess) => unknown,
): Promise<void> {
  const actual: Record<string, unknown> = {};
  for (const [written] of rows)
    actual[written] = read(await ir(source(written)));
  expect(actual).toEqual(Object.fromEntries(rows));
}

const inProcess = (statements: string): string => `process P { ${statements} }`;

const endIds = (container: FlowContainer): string[] =>
  container.flowElements
    .filter((fe) => fe.kind === 'endEvent')
    .map((fe) => fe.id);

describe('astToIr: synthesized ids', () => {
  // Gateway ids are positional and never consult `taken`; only the implicit
  // start and end ids do.
  it('every named statement, also inside a race branch or a sub-process, reserves its name against the synthesized end', async () => {
    await expectLowering(
      [
        'user EndEvent_P',
        'step EndEvent_P',
        'service EndEvent_P(topic: "t")',
        'send EndEvent_P(class: "c")',
        'receive EndEvent_P',
        'decide EndEvent_P(decision: "d")',
        'script EndEvent_P ```js\nx = 1;\n```',
        'call EndEvent_P(process: "p")',
        'await message EndEvent_P("M")',
        'await { message("M") { user EndEvent_P } signal("S") { user B } }',
      ].map((statement) => [statement, ['EndEvent_P_2']] as const),
      inProcess,
      endIds,
    );
    const nested = await ir(
      'process P { user EndEvent_S subprocess S { user A } }',
    );
    expect(endIds(subProcess(nested, 'S'))).toEqual(['EndEvent_S_2']);
  });

  // A statement named `default` reached from the same gateway would take the
  // gateway's `Flow_<gateway>_default` for its own incoming flow, so the claim
  // has to precede the branch.
  it('claims a gateway default-flow id before its branches, so no two sequence flows share one', async () => {
    await expectLowering(
      [
        'if (a) { user default } else { user B }',
        'parallel { if (a) { user default } else { user B } }',
        'while (a) { user default }',
        'do { user default } while (a)',
      ].map((statement) => [statement, []] as const),
      inProcess,
      ({ sequenceFlows }) => {
        const ids = sequenceFlows.map((f) => f.id);
        return ids.filter((id, i) => ids.indexOf(id) !== i);
      },
    );
  });

  it('holds no id back for a split that weighs nothing, so a `default` beside it keeps the plain one', async () => {
    // An AND split leaves no branch out, so it names no fallback; claiming the
    // id anyway would move the authored collider onto a suffix for nothing.
    const result = await ir(
      `process P { parallel { { user default } { user B } } }`,
    );
    expect(
      result.sequenceFlows
        .filter((f) => f.targetRef === 'default')
        .map((f) => f.id),
    ).toEqual(['Flow_Gateway_P_0_fork_default']);
  });

  it('runs a do-while body first, the start entering it rather than the gateway', async () => {
    const loopId = makeGatewayLoopId('P_0');
    const defaultFlowId = makeDefaultFlowId(loopId);
    expect(await ir(`process P { do { user R } while (rejected) }`)).toEqual(
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'StartEvent_P' },
          { kind: 'userTask', id: 'R' },
          gateway(loopId, defaultFlowId),
          { kind: 'endEvent', id: 'EndEvent_P' },
        ],
        [
          edge('R', loopId),
          edge(loopId, 'R', { condition: '${rejected}' }),
          edge('StartEvent_P', 'R'),
          edge(loopId, 'EndEvent_P', { id: defaultFlowId }),
        ],
      ),
    );
  });
});

describe('astToIr: source the validator rejects still lowers', () => {
  it('throws when the model contains no process definitions', async () => {
    const doc = await parse('');
    expect(() => astToIr(doc.parseResult.value)).toThrow(
      /no process definitions/i,
    );
  });

  it('keeps the first of a duplicated header key or error code, binds nothing for an unknown service type, and stores no call binding for an unknown strategy', async () => {
    const result = await ir(
      'process p(versionTag: "1.4", versionTag: "2.0") {' +
        ' error PF(message: "first") error Repeated(code: "PF", message: "second")' +
        ' service S(type: "ftp")' +
        ' call C(process: "p", binding: weekly)' +
        ' call Empty { } }',
    );
    expect([
      result.versionTag,
      result.errorDecls,
      only(result, 'serviceTask').binding,
      byId(result, 'C'),
      (byId(result, 'Empty') as CallActivity).calledElement,
    ]).toEqual([
      '1.4',
      [{ name: 'PF', code: 'PF', message: 'first' }],
      classBinding(''),
      { kind: 'callActivity', id: 'C', calledElement: 'p' },
      '',
    ]);
  });

  // A field with nowhere to go is dropped, a missing code catches all, and a
  // word the position does not admit falls back to the error kind its
  // validator message speaks of.
  it('lowers every handler head, whatever it carries', async () => {
    await expectLowering(
      [
        ['on error("")', errorDef('')],
        ['on error(X, coed: c)', errorDef('X')],
        ['on error(PF, code: "LITERAL")', errorDef('PF')],
        ['on escalation', { kind: 'escalation' }],
        ['on message', messageDef('')],
        ['on message("X", code: c)', messageDef('X')],
        ['on timer', timerDef('duration', '')],
        ['on condition', conditionDef('${true}')],
        ['on compensation("X", code: c)', { kind: 'compensation' }],
        ['on banana("X")', errorDef('X')],
        ['on banana(every: "x")', errorDef()],
      ],
      (head) => `process p { ${CODE_DECLS} ${head} { } }`,
      (result) =>
        only(subProcess(result, makeEventSubProcessId('p_0')), 'startEvent')
          .eventDefinition,
    );
  });

  // BPMN has no intermediate error throw, so an unadmitted word falls back to
  // `error` for a throw and to `escalation` for an emit.
  it('lowers every throw and emit trigger, whatever it names', async () => {
    const thrown = makeThrowEventId('p_1');
    const end = (eventDefinition: unknown) => ({
      kind: 'endEvent',
      id: thrown,
      eventDefinition,
    });
    const emitted = (eventDefinition: unknown) => ({
      kind: 'intermediateThrowEvent',
      id: thrown,
      eventDefinition,
    });
    await expectLowering(
      [
        ['throw compensation("X")', end({ kind: 'compensation' })],
        ['throw banana("X")', end(errorDef('X'))],
        ['throw timer("X")', end(errorDef('X'))],
        ['emit signal', emitted(signalDef(''))],
        ['emit error(X)', emitted(escalationDef('X'))],
        ['emit banana("X")', emitted(escalationDef('X'))],
      ],
      (statement) =>
        `process p { ${CODE_DECLS} service A(class: "x.A") ${statement} service B(class: "x.B") }`,
      (result) => byId(result, thrown),
    );
  });

  it('drops a listener, field, form binding or run key with nowhere to go, and an end trigger an end does not take', async () => {
    const result = await ir(
      'process p { escalation Late' +
        ' user T { on start on nonsense(class: "x") }' +
        ' service S(class: "x.S") { on create(class: "x.C") }' +
        ' service Ship(topic: "shipping") { field greeting = "hello" }' +
        ' service Run(expression: "${bean.run()}") { field greeting = "hello" }' +
        ' user Review(formRef: "review-form") { on assignment ```groovy\nx = 1\n``` { field role = "clerk" } }' +
        ' step X(runAsyncBefore: true, runRetryCycle: "R2/PT1M")' +
        ' end E escalation(Late) }',
    );
    expect(result.flowElements.slice(1)).toEqual([
      {
        kind: 'userTask',
        id: 'T',
        executionListeners: [{ event: 'start', binding: classBinding('') }],
      },
      { kind: 'serviceTask', id: 'S', binding: classBinding('x.S') },
      { kind: 'serviceTask', id: 'Ship', binding: externalBinding('shipping') },
      {
        kind: 'serviceTask',
        id: 'Run',
        binding: exprBinding('${bean.run()}'),
      },
      {
        kind: 'userTask',
        id: 'Review',
        taskListeners: [
          { event: 'assignment', binding: scriptValue('groovy', 'x = 1\n') },
        ],
      },
      { kind: 'task', id: 'X' },
      { kind: 'endEvent', id: 'E' },
    ]);
  });

  it('lowers a handler whose host does not resolve to a boundary event all the same', async () => {
    // The lowering keys on the host slot, not on resolution.
    const result = await ir(
      'process p { service A(class: "x.A") on Missing: timer("PT1H") { user R } }',
    );
    expect(only(result, 'boundaryEvent')).toEqual({
      kind: 'boundaryEvent',
      id: 'Boundary_Missing_timer',
      attachedToRef: 'Missing',
      eventDefinition: timerDef('duration', 'PT1H'),
    });
  });
});

describe('astToIr: normalizations that print back unchanged', () => {
  it('lowers a fenced script to its canonical format, and a builtin type to its lower-case discriminator', async () => {
    // Operaton lowercases the script language and compares the builtin type
    // case-insensitively.
    const result = await ir(
      'process P { script A ```JS\nx = 1;\n``` script B ```js\r\nx = 1;\n``` service M(type: "Mail") }',
    );
    expect(result.flowElements.slice(1, -1)).toEqual([
      scriptTask('A', 'javascript', 'x = 1;\n'),
      scriptTask('B', 'javascript', 'x = 1;\n'),
      { kind: 'serviceTask', id: 'M', binding: builtinBinding('mail') },
    ]);
  });

  // A bare or quoted collection names a variable to Operaton; every other
  // spelling becomes an expression or it names a variable nobody declared.
  // Only a whole-number count prints bare again, so only it lowers bare: a
  // decimal has no fixed point, and a quoted count is a JUEL string literal.
  it('lowers a collection or count to a variable name only where Operaton reads one', async () => {
    await expectLowering(
      [
        [
          'for each line in lines',
          { collection: 'lines', elementVariable: 'line' },
        ],
        [
          'for each line in "order.lines"',
          { collection: 'order.lines', elementVariable: 'line' },
        ],
        [
          'for each line in order.lines',
          { collection: '${order.lines}', elementVariable: 'line' },
        ],
        [
          'for each line in "${order.lines}"',
          { collection: '${order.lines}', elementVariable: 'line' },
        ],
        ['for 3', { cardinality: '3' }],
        ['for 3.5', { cardinality: '${3.5}' }],
        ['for "order.lines"', { cardinality: '${"order.lines"}' }],
        ['for "${n}"', { cardinality: '${n}' }],
        ['for (n)', { cardinality: '${(n)}' }],
      ],
      (clause) => `process P { user X ${clause} }`,
      (result) => (byId(result, 'X') as Repeatable).loop,
    );
  });

  it('declares each used code first, minting a writable name for a code no name could spell', async () => {
    await expectLowering(
      [
        [
          'error SECOND(message: "second") error FIRST(message: "first") throw error(FIRST)',
          {
            errorDecls: [
              { name: 'FIRST', code: 'FIRST', message: 'first' },
              { name: 'SECOND', code: 'SECOND', message: 'second' },
            ],
          },
        ],
        [
          'throw error("order.failed")',
          { errorDecls: [{ name: 'order_failed', code: 'order.failed' }] },
        ],
        [
          'emit escalation(MR)',
          { escalationDecls: [{ name: 'MR', code: 'MR' }] },
        ],
      ],
      (statements) => `process p { ${statements} service A(class: "x.A") }`,
      ({ errorDecls, escalationDecls }) => ({ errorDecls, escalationDecls }),
    );
  });

  it('lowers a full-featured call, wrapping expressions and a bareword mapper in ${...}', async () => {
    const result = await ir(`process p {
      var amount: number
      var tax: number
      var vipFlag: boolean
      var confirmed: boolean
      call Fulfilment(
        label: "Fulfil order",
        process: "fulfilment-process",
        binding: deployment,
        businessKey: "\${execution.processBusinessKey}",
        mapperDelegate: callMapperBean
      ) {
        in *
        in orderId
        in total = amount + tax
        in local vip = vipFlag
        out shipmentId
        out shipped = confirmed
      }
      call V(process: "v", version: 1.5)
    }`);
    expect(byId(result, 'Fulfilment')).toEqual({
      kind: 'callActivity',
      id: 'Fulfilment',
      name: 'Fulfil order',
      calledElement: 'fulfilment-process',
      binding: { kind: 'deployment' },
      businessKey: '${execution.processBusinessKey}',
      mapper: { kind: 'delegateExpression', expression: '${callMapperBean}' },
      inMappings: [
        { kind: 'all' },
        { kind: 'variable', source: 'orderId', target: 'orderId' },
        {
          kind: 'expression',
          sourceExpression: '${amount + tax}',
          target: 'total',
        },
        { kind: 'variable', source: 'vipFlag', target: 'vip', local: true },
      ],
      outMappings: [
        { kind: 'variable', source: 'shipmentId', target: 'shipmentId' },
        { kind: 'variable', source: 'confirmed', target: 'shipped' },
      ],
    });
    expect((byId(result, 'V') as CallActivity).binding).toEqual({
      kind: 'version',
      version: '1.5',
    });
  });
});

describe('astToIr: valid source no other test in this package lowers', () => {
  it('carries the history and starter header keys, joins two starts into one step or the end, and ends an empty alongside boundary on its own end', async () => {
    expect(
      await ir(
        'process P(historyTimeToLive: "P5D", candidateStarterUsers: "u", candidateStarterGroups: "g") { start A start B message("M") user T end E }',
      ),
    ).toEqual({
      ...processIr('P', [
        { kind: 'startEvent', id: 'A' },
        { kind: 'startEvent', id: 'B', eventDefinition: messageDef('M') },
        { kind: 'userTask', id: 'T' },
        { kind: 'endEvent', id: 'E' },
      ]),
      historyTimeToLive: 'P5D',
      candidateStarterUsers: 'u',
      candidateStarterGroups: 'g',
      sequenceFlows: [edge('A', 'T'), edge('B', 'T'), edge('T', 'E')],
    });

    expect(await ir('process P { start A start B message("M") }')).toEqual(
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'A' },
          { kind: 'startEvent', id: 'B', eventDefinition: messageDef('M') },
          { kind: 'endEvent', id: 'EndEvent_P' },
        ],
        [edge('A', 'EndEvent_P'), edge('B', 'EndEvent_P')],
      ),
    );

    expect(
      await ir('process P { user A on A: signal("S", alongside) { } }'),
    ).toEqual(
      processIr(
        'P',
        [
          { kind: 'startEvent', id: 'StartEvent_P' },
          { kind: 'userTask', id: 'A' },
          {
            kind: 'boundaryEvent',
            id: 'Boundary_A_signal',
            attachedToRef: 'A',
            eventDefinition: signalDef('S'),
            cancelActivity: false,
          },
          { kind: 'endEvent', id: 'EndEvent_Boundary_A_signal' },
          { kind: 'endEvent', id: 'EndEvent_P' },
        ],
        [
          edge('Boundary_A_signal', 'EndEvent_Boundary_A_signal'),
          edge('StartEvent_P', 'A'),
          edge('A', 'EndEvent_P'),
        ],
      ),
    );
  });

  it('lowers the raise forms no round trip here reaches', async () => {
    await expectLowering(
      [
        ['throw escalation Sent(EscX)', escalationDef('X')],
        ['throw signal Sent("S")', signalDef('S')],
        ['emit compensation Sent', { kind: 'compensation' }],
      ],
      (written) => `process P { escalation EscX(code: "X") user A ${written} }`,
      (process) => {
        const node = byId(process, 'Sent');
        return 'eventDefinition' in node ? node.eventDefinition : undefined;
      },
    );
  });
});
