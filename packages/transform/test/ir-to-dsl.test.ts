/**
 * `irToDsl` is the inverse of the desugaring `astToIr`: it turns a flat,
 * BPMN-shaped IR back into structured DSL source. The IR fixtures are inline
 * literals matching byte-for-byte what `astToIr` emits for the corresponding
 * source, so the idempotence assertions are exact rather than
 * reachability-based.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AstUtils, EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import {
  createBpmnScriptServices,
  ENGINE_KEYS,
  gatewayStatementRuleOf,
  PROCESS_HEADER_KEYS,
} from '@bpmn-script/language';
import type { Model, ParenItem } from '@bpmn-script/language';

import {
  irToDsl as printDsl,
  PROCESS_HEADER_SETTINGS,
  UNSTRUCTURED_MARKER,
} from '../src/ir-to-dsl.js';
import { astToIr } from '../src/ast-to-ir.js';
import { xmlToIr } from '../src/xml-to-ir.js';
import { isGateway } from '../src/ir/types.js';
import { bpmnDoc } from './helpers/bpmn-doc.js';
import { byId, only } from './helpers/ir-query.js';
import {
  around,
  boundaryEvent,
  builtinBinding,
  callActivity,
  chained,
  chainedSub,
  classBinding,
  conditionDef,
  delegateBinding,
  edge,
  errorDef,
  escalationDef,
  eventHandler,
  exprBinding,
  externalBinding,
  flowChain,
  gateway,
  HANDWRITTEN_IMPORT_IR,
  ioParam,
  linkDef,
  listValue,
  mapEntry,
  mapValue,
  messageDef,
  minimalProcess,
  processIr,
  scriptTask,
  scriptValue,
  serviceTask,
  signalDef,
  textValue,
  timerDef,
  triggeredSub,
  typedEvent,
} from './helpers/ir-fixtures.js';
import type { PrintWarning } from '../src/ir-to-dsl.js';
import type {
  BpmnProcess,
  EventDefinition,
  ExecutionListener,
  FieldInjection,
  FlowElement,
  FormField,
  IntermediateCatchEvent,
  JobSettings,
  LoopCharacteristics,
  Repeatable,
  SequenceFlow,
  ServiceTask,
  ServiceTaskBinding,
  VersionBinding,
} from '../src/ir/types.js';

// The suite asserts printed source; the warnings channel has its own block.
const irToDsl = (process: BpmnProcess): string => printDsl(process).source;

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
});

// Normalization helpers mirror the round-trip contract: IR equivalence up to
// synthesized-id renaming, never byte-for-byte text or literal-id equality.

/** Synthesized-id families that the desugarer mints. */
const SYNTH_GATEWAY = /^Gateway_.*_(split|join|fork|loop)$/;
const SYNTH_START = /^StartEvent_/;
const SYNTH_END = /^EndEvent_/;

/** Map a possibly-synthesized id to a stable role token for comparison. */
function normId(id: string): string {
  if (SYNTH_GATEWAY.test(id)) return '<GW>';
  if (SYNTH_START.test(id)) return '<START>';
  if (SYNTH_END.test(id)) return '<END>';
  return id;
}

/** Canonical key for an element (kind + normalized id). */
function elemKey(kind: string, id: string): string {
  return `${kind}:${normId(id)}`;
}

/** Canonical key for an edge (normalized endpoints + condition). */
function edgeKey(f: SequenceFlow): string {
  const cond = f.conditionExpression ? `[${f.conditionExpression}]` : '';
  return `${normId(f.sourceRef)}->${normId(f.targetRef)}${cond}`;
}

/** Sorted multiset of element keys (order-independent). */
function elementMultiset(ir: BpmnProcess): string[] {
  return ir.flowElements.map((e) => elemKey(e.kind, e.id)).sort();
}

/** Sorted multiset of edge keys (order-independent). */
function edgeMultiset(ir: BpmnProcess): string[] {
  return ir.sequenceFlows.map(edgeKey).sort();
}

/**
 * Parse `dsl` and assert no parser errors, returning the desugared IR.
 * Surfaces parser error messages on failure to make regressions debuggable.
 */
async function reDesugar(dsl: string): Promise<BpmnProcess> {
  const doc = await parse(dsl);
  const errors = doc.parseResult.parserErrors;
  expect(
    errors,
    `Parser errors in generated DSL:\n${dsl}\n--\n${errors
      .map((e) => e.message)
      .join('\n')}`,
  ).toHaveLength(0);
  return astToIr(doc.parseResult.value);
}

/**
 * Errors the compiler draws on what the model holds rather than on how it was
 * printed: an id the model chose, a listener the model carries twice, a step
 * the model puts where the engine refuses it. A fixture feeding one names it,
 * so the gate below stays a gate for everything else.
 */
const MODEL_REFUSAL = {
  reservedId: 'matches a reserved synthesized-id pattern',
  mintedId: 'is the id the compiler generates for the implicit',
  cancelOutsideAttempt:
    "A cancel end belongs directly inside an 'attempt' block",
  undoOutsideBlock: 'An undo block belongs directly inside the',
  hostOutsideContainer:
    "Could not resolve reference to Statement named 'Elsewhere'",
  orphanStep: 'This step can never run',
  secondDefaultStart: "this is the process's second plain or timer start",
  deadElse: 'could never run',
  undoAlongside: 'there is no running flow to run alongside',
  formDefaultShape: 'The default ',
} as const;

/**
 * Print `ir`, assert the emitted source re-parses and compiles, and return it.
 * Parsing alone passes a print the compiler refuses, which is how source that
 * draws "can never run" stayed green: the statement a printed jump cut off
 * parses fine and lowers to a step nothing reaches.
 */
async function printed(
  ir: BpmnProcess,
  ...refused: (keyof typeof MODEL_REFUSAL)[]
): Promise<string> {
  const dsl = irToDsl(ir);
  await reDesugar(dsl);
  const allowed = refused.map((key) => MODEL_REFUSAL[key]);
  const errors = (await validate(dsl)).diagnostics
    .filter((d) => d.severity === 1)
    .map((d) => (typeof d.message === 'string' ? d.message : d.message.value))
    .filter((message) => !allowed.some((text) => message.includes(text)));
  expect(errors, `Validation errors in generated DSL:\n${dsl}`).toEqual([]);
  return dsl;
}

/**
 * The source without its `var` lines. The header declares every variable the
 * model reads in a position the script writes bare, whether or not the print
 * kept that position, so a dropped condition leaves its name there and the
 * body is where its absence is asserted.
 */
const bodyOf = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !line.startsWith('  var '))
    .join('\n');

/**
 * Assert local idempotence up to id normalization: `irToDsl(ir)` re-parses and
 * re-desugars to an IR with the same normalized element + edge multisets as
 * `ir`.
 */
async function expectIdempotent(
  ir: BpmnProcess,
  ...refused: (keyof typeof MODEL_REFUSAL)[]
): Promise<string> {
  const dsl = await printed(ir, ...refused);
  const ir2 = await reDesugar(dsl);
  expect(elementMultiset(ir2)).toEqual(elementMultiset(ir));
  expect(edgeMultiset(ir2)).toEqual(edgeMultiset(ir));
  return dsl;
}

/**
 * Real-node reachability set (gateway-transparent): for every non-gateway node,
 * the set of non-gateway nodes reachable through any number of gateway hops.
 * In degraded graphs the literal edge set legitimately changes as gateways are
 * synthesized, but connectivity between real nodes must be preserved exactly.
 */
function realReachability(ir: BpmnProcess): Set<string> {
  const real = new Set(
    ir.flowElements.filter((e) => !isGateway(e)).map((e) => e.id),
  );
  const adj = new Map<string, string[]>();
  for (const f of ir.sequenceFlows) {
    (adj.get(f.sourceRef) ?? adj.set(f.sourceRef, []).get(f.sourceRef)!).push(
      f.targetRef,
    );
  }
  const pairs = new Set<string>();
  for (const s of real) {
    const stack = [...(adj.get(s) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      if (real.has(n)) pairs.add(`${s}->${n}`);
      else for (const m of adj.get(n) ?? []) stack.push(m);
    }
  }
  return pairs;
}

/** `S -> end`: a typed end terminates the chain, so nothing follows it. */
const terminating = (end: FlowElement): BpmnProcess =>
  minimalProcess(
    [{ kind: 'startEvent', id: 'S' }, end],
    [{ id: 'F', sourceRef: 'S', targetRef: end.id }],
  );

/** `true` iff the output contains a top-level `goto` statement. */
function hasGoto(dsl: string): boolean {
  return /\bgoto\s+\w/.test(dsl);
}

/** `true` iff the output contains the `gateway` keyword. */
function hasGatewayKeyword(dsl: string): boolean {
  // A `gateway` statement would read `gateway <id>` at the start of a line.
  return /(^|\n)\s*gateway\s/.test(dsl);
}

// Inline IR fixtures: the exact shapes `astToIr` emits for each construct.

/** Desugared `if (amount > 1000) { user B } else { service C }` at body index 2. */
const IF_ELSE_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'userTask', id: 'A', name: 'A task' },
    gateway('Gateway_p_2_split', 'Flow_Gateway_p_2_split_default'),
    gateway('Gateway_p_2_join'),
    { kind: 'userTask', id: 'B', name: 'B task' },
    serviceTask('C', classBinding('com.example.C')),
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('S', 'A'),
    edge('Gateway_p_2_split', 'B', { condition: '${amount > 1000}' }),
    edge('B', 'Gateway_p_2_join'),
    edge('Gateway_p_2_split', 'C', { id: 'Flow_Gateway_p_2_split_default' }),
    edge('C', 'Gateway_p_2_join'),
    edge('A', 'Gateway_p_2_split'),
    edge('Gateway_p_2_join', 'E'),
  ],
);

/** Desugared `while (count < 10) { user W }`. */
const WHILE_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    gateway('Gateway_p_1_loop', 'Flow_Gateway_p_1_loop_default'),
    { kind: 'userTask', id: 'W', name: 'Work' },
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('Gateway_p_1_loop', 'W', { condition: '${count < 10}' }),
    edge('W', 'Gateway_p_1_loop'),
    edge('S', 'Gateway_p_1_loop'),
    edge('Gateway_p_1_loop', 'E', { id: 'Flow_Gateway_p_1_loop_default' }),
  ],
);

/** Desugared `do { user W } while (count < 10)`. */
const DO_WHILE_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'userTask', id: 'W', name: 'Work' },
    gateway('Gateway_p_1_loop', 'Flow_Gateway_p_1_loop_default'),
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('W', 'Gateway_p_1_loop'),
    edge('Gateway_p_1_loop', 'W', { condition: '${count < 10}' }),
    edge('S', 'W'),
    edge('Gateway_p_1_loop', 'E', { id: 'Flow_Gateway_p_1_loop_default' }),
  ],
);

/** Desugared `parallel { { user X } { service Y } }`. */
const PARALLEL_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
    { kind: 'parallelGateway', id: 'Gateway_p_1_join' },
    { kind: 'userTask', id: 'X', name: 'X' },
    serviceTask('Y', classBinding('com.example.Y')),
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('Gateway_p_1_fork', 'X'),
    edge('X', 'Gateway_p_1_join'),
    edge('Gateway_p_1_fork', 'Y'),
    edge('Y', 'Gateway_p_1_join'),
    edge('S', 'Gateway_p_1_fork'),
    edge('Gateway_p_1_join', 'E'),
  ],
);

/**
 * The whole printed source for {@link PARALLEL_IR}. Both branches reach the
 * join, so the clean-join path handles it and the terminating-branch recovery
 * is never entered.
 */
const PARALLEL_SOURCE =
  'process p {\n' +
  '  start S\n' +
  '  parallel {\n' +
  '    {\n' +
  '      user X(label: "X")\n' +
  '    }\n' +
  '    {\n' +
  '      service Y(class: "com.example.Y")\n' +
  '    }\n' +
  '  }\n' +
  '  end E\n' +
  '}\n';

/**
 * Canonical invoice IR: the `xmlToIr` import shape of the handwritten golden
 * (an XOR split with named branch flows, no explicit join). Drives the
 * "structured restructuring of a real import" assertions.
 */
const INVOICE_IR: BpmnProcess = {
  ...HANDWRITTEN_IMPORT_IR,
  name: 'Invoice Approval',
};

/** The whole printed source for {@link IF_ELSE_IR}, asserted from two angles. */
const IF_ELSE_SOURCE =
  'process p {\n' +
  '  var amount: any\n' +
  '  start S\n' +
  '  user A(label: "A task")\n' +
  '  if (amount > 1000) {\n' +
  '    user B(label: "B task")\n' +
  '  } else {\n' +
  '    service C(class: "com.example.C")\n' +
  '  }\n' +
  '  end E\n' +
  '}\n';

describe('irToDsl: structured restructuring', () => {
  // Each row is the whole source, so anything the emitter adds fails it too:
  // no `gateway` statement, no `goto`, no `and` between parallel branches, and
  // 2-space indentation per nesting level.
  it.each([
    [
      'restructures a desugared if/else to `if (...) { } else { }`',
      IF_ELSE_IR,
      IF_ELSE_SOURCE,
    ],
    [
      'restructures a desugared while to `while (...) { }`, with no process label where the IR has no name',
      WHILE_IR,
      'process p {\n' +
        '  var count: any\n' +
        '  start S\n' +
        '  while (count < 10) {\n' +
        '    user W(label: "Work")\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'restructures a desugared do-while to `do { } while (...)`',
      DO_WHILE_IR,
      'process p {\n' +
        '  var count: any\n' +
        '  start S\n' +
        '  do {\n' +
        '    user W(label: "Work")\n' +
        '  } while (count < 10)\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'restructures a desugared parallel to nested `parallel { { } { } }` blocks',
      PARALLEL_IR,
      PARALLEL_SOURCE,
    ],
    [
      'restructures the canonical invoice import to if/else under a labeled process header',
      INVOICE_IR,
      'process invoice-approval(label: "Invoice Approval") {\n' +
        '  var amount: any\n' +
        '  start ReviewStart\n' +
        '  user ReviewInvoice(label: "Review invoice", assignee: "demo")\n' +
        '  if (amount > 1000) {\n' +
        '    user SeniorApproval(label: "Senior approval", assignee: "manager")\n' +
        '  } else {\n' +
        '    service AutoApprove(label: "Auto-approve", class: "com.example.invoice.AutoApproveDelegate")\n' +
        '  }\n' +
        '  end Done\n' +
        '}\n',
    ],
  ])('%s', async (_title, ir, expected) => {
    expect(await printed(ir)).toBe(expected);
  });
});

describe('irToDsl: local idempotence (re-desugar equivalence)', () => {
  it.each([
    ['if/else round-trips to an equivalent IR', IF_ELSE_IR],
    ['while round-trips to an equivalent IR (back-edge consumed)', WHILE_IR],
    ['do-while round-trips to an equivalent IR', DO_WHILE_IR],
    ['parallel round-trips to an equivalent IR', PARALLEL_IR],
  ])('%s', async (_title, ir) => {
    await expectIdempotent(ir);
  });

  it('invoice import preserves assignee, class binding and condition through re-desugar', async () => {
    const ir = await reDesugar(await printed(INVOICE_IR));

    const review = ir.flowElements.find(
      (e) => e.kind === 'userTask' && e.id === 'ReviewInvoice',
    );
    expect(review?.kind === 'userTask' && review.assignee).toBe('demo');

    const auto = ir.flowElements.find(
      (e) => e.kind === 'serviceTask' && e.id === 'AutoApprove',
    );
    expect(
      auto?.kind === 'serviceTask' &&
        auto.binding.kind === 'class' &&
        auto.binding.className,
    ).toBe('com.example.invoice.AutoApproveDelegate');

    const cond = ir.sequenceFlows.find(
      (f) => f.conditionExpression !== undefined,
    );
    expect(cond?.conditionExpression).toBe('${amount > 1000}');
  });

  it('process id, name and isExecutable survive the round-trip', async () => {
    const ir = await reDesugar(await printed(INVOICE_IR));
    expect(ir.id).toBe('invoice-approval');
    expect(ir.name).toBe('Invoice Approval');
    expect(ir.isExecutable).toBe(true);
  });
});

describe('irToDsl: goto degradation (every edge with a form keeps it)', () => {
  /**
   * Hand-built unstructured IR: two XOR gateways whose branches cross so no
   * single post-dominating join exists (`G2` re-enters `A`, which `G1` also
   * targets). The contract: >=1 `goto`, valid source, and every real-node
   * connection preserved on re-desugar.
   */
  const IRREDUCIBLE_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('G1', 'd1'),
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      gateway('G2', 'd2'),
      { kind: 'endEvent', id: 'E' },
    ],
    [
      { id: 'f0', sourceRef: 'S', targetRef: 'G1' },
      edge('G1', 'A', { id: 'f1', condition: '${p}' }),
      { id: 'd1', sourceRef: 'G1', targetRef: 'B' },
      { id: 'f2', sourceRef: 'A', targetRef: 'E' },
      { id: 'f3', sourceRef: 'B', targetRef: 'G2' },
      edge('G2', 'A', { id: 'f4', condition: '${q}' }),
      { id: 'd2', sourceRef: 'G2', targetRef: 'E' },
    ],
  );

  it('emits valid source with at least one goto, losing no real-node connection', async () => {
    const dsl = await printed(IRREDUCIBLE_IR);
    expect(hasGoto(dsl)).toBe(true);
    expect(realReachability(await reDesugar(dsl))).toEqual(
      realReachability(IRREDUCIBLE_IR),
    );
  });

  /**
   * An XOR split with three routes out, unreachable through the desugaring
   * pipeline (a desugared XOR always weighs at least one route) but a shape the
   * emitter must still be total on. `weighed` puts a condition on the first
   * route, leaving one surplus unconditioned route or two.
   */
  const threeWayXor = (weighed?: string): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('G'),
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'userTask', id: 'C' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        { id: 'f0', sourceRef: 'S', targetRef: 'G' },
        edge('G', 'A', {
          id: 'f1',
          ...(weighed === undefined ? {} : { condition: weighed }),
        }),
        { id: 'f2', sourceRef: 'G', targetRef: 'B' },
        { id: 'f3', sourceRef: 'G', targetRef: 'C' },
        { id: 'f4', sourceRef: 'A', targetRef: 'E' },
        { id: 'f5', sourceRef: 'B', targetRef: 'E' },
        { id: 'f6', sourceRef: 'C', targetRef: 'E' },
      ],
    );

  // A naive emit would chain `if (true) { } else { } else { }`, which is not
  // valid source; the chain heads every route but the last with a condition
  // that holds instead, so no route vanishes and none of its targets dangle.
  it.each([
    ['every route unconditioned', undefined],
    ['one route weighed and two surplus ones (regression)', '${x > 1}'],
  ] as const)(
    'degrades a 3-way XOR with %s to source that compiles, losing no route',
    async (_title, weighed) => {
      const ir = threeWayXor(weighed);
      const dsl = await printed(ir);
      expect(dsl).toContain('} else if (true) {');
      expect((dsl.match(/}\s*else\s*{/g) ?? []).length).toBeLessThanOrEqual(1);
      expect(realReachability(await reDesugar(dsl))).toEqual(
        realReachability(ir),
      );
    },
  );

  it('never throws and always re-parses on degenerate graphs', async () => {
    const degenerate: BpmnProcess[] = [
      // No start event.
      minimalProcess(
        [
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        [{ id: 'f', sourceRef: 'A', targetRef: 'E' }],
      ),
      // Empty process.
      processIr('p', [], []),
      // Orphan (unreachable) node.
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'endEvent', id: 'E' },
          { kind: 'userTask', id: 'Orphan' },
        ],
        [{ id: 'f', sourceRef: 'S', targetRef: 'E' }],
      ),
      // Self-loop on a task.
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          { id: 'f0', sourceRef: 'S', targetRef: 'A' },
          { id: 'f1', sourceRef: 'A', targetRef: 'A' },
          { id: 'f2', sourceRef: 'A', targetRef: 'E' },
        ],
      ),
    ];

    for (const ir of degenerate) {
      const dsl = irToDsl(ir);
      expect(typeof dsl).toBe('string');
      // Each must re-parse without parser errors (totality).
      await reDesugar(dsl);
    }
  });
});

describe('irToDsl: multiple and named ends', () => {
  /** Desugared XOR split routing to two distinct named ends (no join). */
  const TWO_ENDS_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Gateway_p_1_split', 'Flow_Gateway_p_1_split_default'),
      { kind: 'endEvent', id: 'Approved', name: 'Approved' },
      { kind: 'endEvent', id: 'Rejected', name: 'Rejected' },
    ],
    [
      edge('S', 'Gateway_p_1_split'),
      edge('Gateway_p_1_split', 'Approved', { condition: '${ok}' }),
      edge('Gateway_p_1_split', 'Rejected', {
        id: 'Flow_Gateway_p_1_split_default',
      }),
    ],
  );

  it('emits both named ends as explicit `end` statements, losing neither end connection', async () => {
    const dsl = await printed(TWO_ENDS_IR);
    expect(dsl).toContain('end Approved(label: "Approved")');
    expect(dsl).toContain('end Rejected(label: "Rejected")');

    const ir = await reDesugar(dsl);
    const ends = ir.flowElements
      .filter((e) => e.kind === 'endEvent')
      .map((e) => e.id)
      .sort();
    expect(ends).toEqual(['Approved', 'Rejected']);
    expect(realReachability(ir)).toEqual(realReachability(TWO_ENDS_IR));
  });
});

describe('irToDsl: service-task bindings', () => {
  it.each([
    [
      'renders a class binding as `service X(class: "...")`',
      serviceTask('Charge', classBinding('com.example.Charge')),
      'service Charge(class: "com.example.Charge")',
      undefined,
      'class',
    ],
    [
      'keeps a labeled class binding on one line, the label leading',
      {
        kind: 'serviceTask',
        id: 'AutoApprove',
        name: 'Auto-approve',
        binding: classBinding('com.example.invoice.AutoApproveDelegate'),
      },
      'service AutoApprove(label: "Auto-approve", class: "com.example.invoice.AutoApproveDelegate")',
      undefined,
      'class',
    ],
    [
      'renders an expression binding as `service X(expression: "${...}")`',
      serviceTask('Calc', exprBinding('${greeter.hello(execution)}')),
      'service Calc(expression: "${greeter.hello(execution)}")',
      undefined,
      'expression',
    ],
    [
      'renders a delegateExpression binding with the `delegate` alias',
      serviceTask('Ship', delegateBinding('${shipDelegate}')),
      'service Ship(delegate: "${shipDelegate}")',
      // The XML-level `delegateExpression` name never surfaces in the source.
      'delegateExpression',
      'delegateExpression',
    ],
    [
      'renders an external binding as `service X(topic: "...")`',
      serviceTask('Notify', externalBinding('notifications')),
      'service Notify(topic: "notifications")',
      // An external binding keeps the `service` keyword, never `external`.
      'external Notify',
      'external',
    ],
    // The last column is the binding kind the source lowers back to.
  ] as const)('%s', async (_title, node, statement, absent, bindingKind) => {
    const dsl = await printed(around(node));
    expect(dsl).toContain(statement);
    if (absent !== undefined) expect(dsl).not.toContain(absent);

    const svc = (await reDesugar(dsl)).flowElements.find(
      (e) => e.id === node.id,
    );
    expect(svc?.kind === 'serviceTask' && svc.binding.kind).toBe(bindingKind);
  });
});

/**
 * The behaviour Operaton builds itself for `operaton:type="mail"`/`"shell"`
 * carries fields exactly as a class binding does, and its own checks refuse a
 * mail task with no `to` or a shell task with no `command`, so a dropped field
 * fails the validation `printed` runs before the binding comparison does.
 */
describe('irToDsl: mail and shell task bindings', () => {
  const MAIL_FIELDS: FieldInjection[] = [
    { name: 'to', value: 'ops@example.com' },
    { name: 'text', value: '${incident.body}' },
  ];
  const SHELL_FIELDS: FieldInjection[] = [
    { name: 'command', value: 'echo' },
    { name: 'arg1', value: 'hello' },
  ];

  it.each([
    [
      'a mail binding on a service task',
      {
        kind: 'serviceTask',
        id: 'Notify',
        binding: builtinBinding('mail', MAIL_FIELDS),
      },
      'service Notify(type: "mail") {\n' +
        '    field to = "ops@example.com"\n' +
        '    field text = "${incident.body}"\n' +
        '  }',
    ],
    [
      'a shell binding on a decide task',
      {
        kind: 'serviceTask',
        id: 'Run',
        element: 'businessRule',
        binding: builtinBinding('shell', SHELL_FIELDS),
      },
      'decide Run(type: "shell") {\n' +
        '    field command = "echo"\n' +
        '    field arg1 = "hello"\n' +
        '  }',
    ],
  ] as const satisfies ReadonlyArray<readonly [string, ServiceTask, string]>)(
    '%s prints its type and fields and reads back as the same binding',
    async (_title, el, block) => {
      const dsl = await printed(around(el));
      expect(dsl).toContain(block);
      const back = (await reDesugar(dsl)).flowElements.find(
        (e) => e.id === el.id,
      )!;
      expect(back.kind === 'serviceTask' && back.binding).toEqual(el.binding);
    },
  );
});

describe('irToDsl: an external task prints its priority, properties and mappings only with something to print', () => {
  /** Two properties and two mappings, one code declared under a chosen name, one left for `codeDeclarations` to synthesize. */
  const MAPPED_PROCESS: BpmnProcess = {
    ...around(
      serviceTask('V', {
        kind: 'external',
        topic: 't',
        properties: [
          { key: 'amount', value: '100' },
          { key: 'currency', value: 'EUR' },
        ],
        errorMappings: [
          {
            errorCode: 'DECLINED',
            condition: '${externalTask.errorMessage == "declined"}',
          },
          { errorCode: 'TIMEOUT', condition: '${externalTask.retries == 0}' },
        ],
      }),
    ),
    errorDecls: [{ name: 'PaymentDeclined', code: 'DECLINED' }],
  };

  it.each([
    [
      'a topic alone prints no parens beyond it',
      around(serviceTask('V', { kind: 'external', topic: 't' })),
      'service V(topic: "t")',
    ],
    [
      'an integer taskPriority prints bare, as jobPriority does',
      around(
        serviceTask('V', { kind: 'external', topic: 't', taskPriority: '42' }),
      ),
      'service V(topic: "t", taskPriority: 42)',
    ],
    [
      'an expression taskPriority prints quoted so it re-lexes as raw EL',
      around(
        serviceTask('V', {
          kind: 'external',
          topic: 't',
          taskPriority: '${amount > 1000 ? 90 : 10}',
        }),
      ),
      'service V(topic: "t", taskPriority: "${amount > 1000 ? 90 : 10}")',
    ],
    [
      'a taskPriority opening with #{ prints as written',
      around(
        serviceTask('V', {
          kind: 'external',
          topic: 't',
          taskPriority: '#{x}',
        }),
      ),
      'service V(topic: "t", taskPriority: "#{x}")',
    ],
    [
      'properties then mappings print after the fields, a declared code by its name and an undeclared one under a synthesized header',
      MAPPED_PROCESS,
      'service V(topic: "t") {\n' +
        '    property amount = "100"\n' +
        '    property currency = "EUR"\n' +
        '    error PaymentDeclined when externalTask.errorMessage == "declined"\n' +
        '    error TIMEOUT when externalTask.retries == 0\n' +
        '  }',
    ],
  ] as const)('%s', async (_title, process, expected) => {
    const dsl = await printed(process);
    expect(dsl).toContain(expected);
  });

  it('an empty property value prints as "" and lowers back to the empty string, which both engine readers store', async () => {
    const binding: ServiceTaskBinding = {
      kind: 'external',
      topic: 't',
      properties: [{ key: 'k', value: '' }],
    };
    const dsl = await printed(around(serviceTask('V', binding)));
    expect(dsl).toContain('property k = ""');
    const svc = (await reDesugar(dsl)).flowElements.find((e) => e.id === 'V');
    expect(svc?.kind === 'serviceTask' && svc.binding).toEqual(binding);
  });
});

describe('irToDsl: task kinds', () => {
  /** Statement lines, indentation stripped, so a match is the whole statement. */
  const statements = async (ir: BpmnProcess): Promise<string[]> =>
    (await printed(ir)).split('\n').map((line) => line.trim());

  it.each([
    [
      'a plain task prints as a step statement',
      { kind: 'task', id: 'Draft' },
      'step Draft',
      'step Draft(label: "Draft it")',
    ],
    [
      'a receive task names its message in the parens',
      { kind: 'receiveTask', id: 'Wait', messageName: 'OrderPaid' },
      'receive Wait(message: "OrderPaid")',
      'receive Wait(label: "Draft it", message: "OrderPaid")',
    ],
    [
      'a send element prints under the send keyword',
      {
        kind: 'serviceTask',
        id: 'Notify',
        element: 'send',
        binding: classBinding('com.example.Notify'),
      },
      'send Notify(class: "com.example.Notify")',
      'send Notify(label: "Draft it", class: "com.example.Notify")',
    ],
    [
      'a businessRule element prints under the decide keyword',
      {
        kind: 'serviceTask',
        id: 'Rate',
        element: 'businessRule',
        binding: { kind: 'decision', decisionRef: 'riskRating' },
      },
      'decide Rate(decision: "riskRating")',
      'decide Rate(label: "Draft it", decision: "riskRating")',
    ],
  ] as const)('%s', async (_title, node, nameless, labeled) => {
    expect(await statements(around(node))).toContain(nameless);
    expect(await statements(around({ ...node, name: 'Draft it' }))).toContain(
      labeled,
    );
  });

  it('prints a receive task with no message name as a bare statement', async () => {
    expect(
      await statements(around({ kind: 'receiveTask', id: 'Wait' })),
    ).toContain('receive Wait');
  });

  it('prints a decision binding decision, version pin, mapping, result variable', async () => {
    const rate = around({
      kind: 'serviceTask',
      id: 'Rate',
      element: 'businessRule',
      binding: {
        kind: 'decision',
        decisionRef: 'riskRating',
        binding: { kind: 'latest' },
        mapDecisionResult: 'singleEntry',
      },
      resultVariable: 'risk',
    });
    expect(await printed(rate)).toContain(
      'decide Rate(decision: "riskRating", binding: latest, ' +
        'mapDecisionResult: singleEntry, resultVariable: "risk")',
    );
  });
});

describe('irToDsl: fenced script task', () => {
  it.each([
    [
      'emits the opening fence with its language tag, the body, and the closing fence',
      scriptTask(
        'Compute',
        'javascript',
        'var x = 1;\nexecution.setVariable("x", x);',
      ),
      'script Compute ```javascript\nvar x = 1;\nexecution.setVariable("x", x);```',
    ],
    [
      // The emitter must prepend no block indentation to the opaque body.
      'reproduces a body carrying its own indentation byte-for-byte',
      scriptTask('Guard', 'groovy', 'if (ok) {\n  doThing();\n}'),
      '```groovy\nif (ok) {\n  doThing();\n}```',
    ],
    [
      'carries the label before the fence when present',
      {
        ...scriptTask('Compute', 'javascript', 'x = 1'),
        name: 'Compute totals',
      },
      'script Compute(label: "Compute totals") ```javascript',
    ],
  ])('%s', async (_title, node, expected) => {
    expect(await printed(around(node))).toContain(expected);
  });

  it('emits a fenced script that re-parses to an equivalent scriptTask', async () => {
    const ir = await reDesugar(
      await printed(around(scriptTask('Compute', 'javascript', 'x = 1'))),
    );
    const script = ir.flowElements.find((e) => e.kind === 'scriptTask');
    expect(script?.kind === 'scriptTask' && script.format).toBe('javascript');
    expect(script?.kind === 'scriptTask' && script.code).toBe('x = 1');
  });
});

describe('irToDsl: sub-process emission', () => {
  /** `PStart -> Before -> sub(SubStart -> Work -> SubEnd) -> After -> PEnd`. */
  const NESTED_IR: BpmnProcess = processIr(
    'proc',
    [
      { kind: 'startEvent', id: 'PStart' },
      { kind: 'userTask', id: 'Before' },
      {
        kind: 'subProcess',
        id: 'sub',
        flowElements: [
          { kind: 'startEvent', id: 'SubStart' },
          { kind: 'userTask', id: 'Work', assignee: 'demo' },
          { kind: 'endEvent', id: 'SubEnd' },
        ],
        sequenceFlows: [
          { id: 'a', sourceRef: 'SubStart', targetRef: 'Work' },
          { id: 'b', sourceRef: 'Work', targetRef: 'SubEnd' },
        ],
      },
      { kind: 'userTask', id: 'After' },
      { kind: 'endEvent', id: 'PEnd' },
    ],
    [
      { id: 'f0', sourceRef: 'PStart', targetRef: 'Before' },
      { id: 'f1', sourceRef: 'Before', targetRef: 'sub' },
      { id: 'f2', sourceRef: 'sub', targetRef: 'After' },
      { id: 'f3', sourceRef: 'After', targetRef: 'PEnd' },
    ],
  );

  it('prints `subprocess sub { ... }` one indent level in, with the parent chain intact around it', async () => {
    expect(await printed(NESTED_IR)).toBe(
      'process proc {\n' +
        '  start PStart\n' +
        '  user Before\n' +
        '  subprocess sub {\n' +
        '    start SubStart\n' +
        '    user Work(assignee: "demo")\n' +
        '    end SubEnd\n' +
        '  }\n' +
        '  user After\n' +
        '  end PEnd\n' +
        '}\n',
    );
  });

  it('restructures an if/else inside a sub-process body (two indent levels)', async () => {
    const SUB_WITH_IF: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'sub',
          flowElements: [
            { kind: 'startEvent', id: 'SubStart' },
            gateway('Gateway_sub_0_split', 'df'),
            gateway('Gateway_sub_0_join'),
            { kind: 'userTask', id: 'Yes' },
            { kind: 'userTask', id: 'No' },
            { kind: 'endEvent', id: 'SubEnd' },
          ],
          sequenceFlows: [
            edge('SubStart', 'Gateway_sub_0_split', { id: 's0' }),
            edge('Gateway_sub_0_split', 'Yes', {
              id: 's1',
              condition: '${ok}',
            }),
            { id: 'df', sourceRef: 'Gateway_sub_0_split', targetRef: 'No' },
            { id: 's2', sourceRef: 'Yes', targetRef: 'Gateway_sub_0_join' },
            { id: 's3', sourceRef: 'No', targetRef: 'Gateway_sub_0_join' },
            edge('Gateway_sub_0_join', 'SubEnd', { id: 's4' }),
          ],
        },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      [
        { id: 'f0', sourceRef: 'PStart', targetRef: 'sub' },
        { id: 'f1', sourceRef: 'sub', targetRef: 'PEnd' },
      ],
    );

    expect(await printed(SUB_WITH_IF)).toBe(
      'process proc {\n' +
        '  var ok: any\n' +
        '  start PStart\n' +
        '  subprocess sub {\n' +
        '    start SubStart\n' +
        '    if (ok) {\n' +
        '      user Yes\n' +
        '    } else {\n' +
        '      user No\n' +
        '    }\n' +
        '    end SubEnd\n' +
        '  }\n' +
        '  end PEnd\n' +
        '}\n',
    );
  });

  it.each([
    [
      'prints the quoted label for a named sub-process',
      {
        ...chainedSub('Sub', [{ kind: 'userTask', id: 'Do' }]),
        name: 'Handle order',
      },
      'subprocess Sub(label: "Handle order") {',
    ],
    [
      'prints an empty named sub-process body as an opening brace immediately followed by a closing one',
      { ...chainedSub('Sub', []), name: 'Handle order' },
      '  subprocess Sub(label: "Handle order") {\n  }\n',
    ],
    [
      'prints an unnamed empty sub-process body without a label',
      chainedSub('Sub', []),
      '  subprocess Sub {\n  }\n',
    ],
  ])('%s', (_title, node, expected) => {
    expect(irToDsl(around(node))).toContain(expected);
  });
});

describe('irToDsl: call activity', () => {
  it('prints every setting and every member in canonical order, shorthand mappings included', async () => {
    const dsl = await printed(
      around({
        kind: 'callActivity',
        id: 'CallSub',
        name: 'Call sub',
        calledElement: 'sub-process',
        binding: { kind: 'deployment' },
        businessKey: '${execution.processBusinessKey}',
        inMappings: [
          { kind: 'all' },
          // source === target -> bare shorthand.
          { kind: 'variable', source: 'amount', target: 'amount' },
          // source !== target -> `target = source`.
          { kind: 'variable', source: 'x', target: 'y' },
          {
            kind: 'expression',
            sourceExpression: '${total * 2}',
            target: 'doubled',
            local: true,
          },
        ],
        outMappings: [
          { kind: 'variable', source: 'result', target: 'outcome' },
          {
            kind: 'expression',
            sourceExpression: '${status}',
            target: 'final',
          },
          { kind: 'all', local: true },
        ],
      }),
    );
    expect(dsl).toContain(
      '  call CallSub(label: "Call sub", process: "sub-process", ' +
        'binding: deployment, businessKey: "${execution.processBusinessKey}") {\n' +
        '    in *\n' +
        '    in amount\n' +
        '    in y = x\n' +
        '    in local doubled = "${total * 2}"\n' +
        '    out outcome = result\n' +
        '    out final = "${status}"\n' +
        '    out local *\n' +
        '  }',
    );
  });

  it.each([
    [
      'prints a minimal call as `call X(process: "p")`',
      undefined,
      'call X(process: "p")',
      undefined,
    ],
    [
      'prints `binding = latest` for a latest binding',
      { kind: 'latest' },
      'call X(process: "p", binding: latest)',
      undefined,
    ],
    [
      'prints only `version = 3` for a numeric version binding (no `binding` key)',
      { kind: 'version', version: '3' },
      'call X(process: "p", version: 3)',
      'binding =',
    ],
    [
      'prints a non-numeric version quoted verbatim',
      { kind: 'version', version: '${v}' },
      'call X(process: "p", version: "${v}")',
      undefined,
    ],
  ] as const)('%s', (_title, binding, printed, absent) => {
    const dsl = irToDsl(
      around({
        kind: 'callActivity',
        id: 'X',
        calledElement: 'p',
        ...(binding ? { binding } : {}),
      }),
    );
    expect(dsl).toContain(printed);
    if (absent !== undefined) expect(dsl).not.toContain(absent);
  });

  it('prints a call in mid-chain as a plain fall-through node (order preserved)', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Before' },
        callActivity('Mid', 'sub'),
        { kind: 'userTask', id: 'After' },
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Before', 'Mid', 'After', 'E'),
    );
    expect(await printed(ir)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  user Before\n' +
        '  call Mid(process: "sub")\n' +
        '  user After\n' +
        '  end E\n' +
        '}\n',
    );
  });
});

/**
 * `S -> E` alongside a handler `H` whose body is an `if` over `A`: the fixture
 * that pins how deep a construct nests inside a handler.
 */
const handlerWithIf = (eventDefinition: EventDefinition): BpmnProcess =>
  minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'endEvent', id: 'E' },
      {
        kind: 'subProcess',
        id: 'H',
        triggeredByEvent: true,
        flowElements: [
          { kind: 'startEvent', id: 'HS', eventDefinition },
          gateway('Gateway_HS_split', 'DF'),
          { kind: 'userTask', id: 'A' },
          gateway('Gateway_HS_join'),
          { kind: 'endEvent', id: 'HE' },
        ],
        sequenceFlows: [
          { id: 'F1', sourceRef: 'HS', targetRef: 'Gateway_HS_split' },
          edge('Gateway_HS_split', 'A', {
            id: 'F2',
            condition: '${amount > 1000}',
          }),
          edge('Gateway_HS_split', 'Gateway_HS_join', { id: 'DF' }),
          { id: 'F3', sourceRef: 'A', targetRef: 'Gateway_HS_join' },
          { id: 'F4', sourceRef: 'Gateway_HS_join', targetRef: 'HE' },
        ],
      },
    ],
    [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
  );

describe('irToDsl: event layer', () => {
  it('prints declarations, throws, emits, and trailing handlers in order', async () => {
    const ir: BpmnProcess = {
      ...chained(
        [
          { kind: 'startEvent', id: 'PStart' },
          { kind: 'userTask', id: 'Work' },
          typedEvent('intermediateThrowEvent', 'Ping', escalationDef('LS')),
          typedEvent('endEvent', 'Boom', errorDef('PF')),
        ],
        {
          unwired: [
            triggeredSub('OnPF', [
              typedEvent(
                'startEvent',
                'PFStart',
                errorDef('PF', { codeVariable: 'c', messageVariable: 'm' }),
              ),
              { kind: 'userTask', id: 'Recover' },
              { kind: 'endEvent', id: 'PFEnd' },
            ]),
            triggeredSub('OnLS', [
              typedEvent(
                'startEvent',
                'LSStart',
                escalationDef('LS', 'v'),
                false,
              ),
              { kind: 'userTask', id: 'Note' },
              { kind: 'endEvent', id: 'LSEnd' },
            ]),
          ],
        },
      ),
      errorDecls: [{ name: 'PF', code: 'PF', message: 'boom' }],
    };

    expect(await printed(ir)).toBe(
      [
        'process proc {',
        '  error PF(message: "boom")',
        '  escalation LS',
        '  start PStart',
        '  user Work',
        '  emit escalation Ping(LS)',
        '  throw error Boom(PF)',
        '  on error(PF, code: c, message: m) {',
        '    start PFStart',
        '    user Recover',
        '    end PFEnd',
        '  }',
        '  on escalation(LS, code: v, alongside) {',
        '    start LSStart',
        '    user Note',
        '    end LSEnd',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('declares every code in the header and raises each one by name', async () => {
    const ir = await reDesugar(
      [
        'process p {',
        '  error OUT_OF_STOCK(message: "Out of stock")',
        '  error OrderFailed(code: "order.failed")',
        '  escalation MANUAL_REVIEW',
        '  user Pack',
        '  throw error(OrderFailed)',
        '  on Pack: error(OUT_OF_STOCK, code: c) { user Restock }',
        '  on Pack: error { user Escalate }',
        '}',
      ].join('\n'),
    );

    // Whole source rather than the header alone: a declaration is only right if
    // the name it claims is the one every use site raises, and `printed`
    // compiles the result, so a name with nothing to resolve to fails here too.
    expect(await printed(ir)).toBe(
      [
        'process p {',
        '  error OrderFailed(code: "order.failed")',
        '  error OUT_OF_STOCK(message: "Out of stock")',
        '  escalation MANUAL_REVIEW',
        '  user Pack',
        '  throw error(OrderFailed)',
        '  on Pack: error(OUT_OF_STOCK, code: c) {',
        '    user Restock',
        '  }',
        '  on Pack: error {',
        '    user Escalate',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('prints an escalation end event as a throw, and a plain end as end', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('endEvent', 'Esc', escalationDef('X')),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'Esc' }],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('throw escalation Esc(X)');
    expect(dsl).not.toContain('end Esc');
  });

  // An undo block only belongs inside the block whose work it undoes, so the
  // process-level fixture draws that refusal from the model it was built from.
  it.each([
    ['error', errorDef('C'), '\n  on error(C) {\n', undefined],
    [
      'compensation',
      { kind: 'compensation' } as EventDefinition,
      '\n  on compensation {\n',
      'undoOutsideBlock',
    ],
  ] as const)(
    'nests a construct two levels deep inside a %s handler body',
    async (_kind, def, header, refused) => {
      const dsl = await printed(
        handlerWithIf(def),
        ...(refused ? [refused] : []),
      );
      expect(dsl).toContain(header);
      expect(dsl).toContain('\n    if (amount > 1000) {\n');
      expect(dsl).toContain('\n      user A\n');
      expect(dsl).not.toContain('gateway');
    },
  );
});

describe('irToDsl: event layer (message / signal / timer / conditional)', () => {
  it('prints message/signal headers, the signal emit/throw, and trailing handlers', async () => {
    const ir: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        typedEvent('intermediateThrowEvent', 'EmitSig', signalDef('Cancelled')),
        typedEvent('endEvent', 'ThrowSig', signalDef('Cancelled')),
        eventHandler('OnMsg', 'MsgStart', messageDef('PaymentReceived')),
        eventHandler('OnSig', 'SigStart', signalDef('Cancelled'), false),
      ],
      [
        { id: 'SF_PStart_EmitSig', sourceRef: 'PStart', targetRef: 'EmitSig' },
        edge('EmitSig', 'ThrowSig', { id: 'SF_EmitSig_ThrowSig' }),
      ],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('  emit signal EmitSig("Cancelled")\n');
    expect(dsl).toContain('  throw signal ThrowSig("Cancelled")\n');
    expect(dsl).toContain('  on message("PaymentReceived") {\n');
    expect(dsl).toContain('  on signal("Cancelled", alongside) {\n');
    // Handlers print last: both headers follow the throw.
    expect(dsl.indexOf('on message')).toBeGreaterThan(
      dsl.indexOf('throw signal'),
    );
    expect(dsl.indexOf('on signal')).toBeGreaterThan(dsl.indexOf('on message'));
  });

  /** `S -> E` beside the trailing handlers under test. */
  const withHandlers = (...handlers: FlowElement[]): BpmnProcess =>
    processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        ...handlers,
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );

  // The last column marks a non-interrupting handler.
  it.each([
    [
      'a duration timer as `after`',
      timerDef('duration', 'PT1H'),
      '  on timer("PT1H") {\n',
      undefined,
    ],
    [
      'a date timer as `at`',
      timerDef('date', '2026-08-01T09:00:00'),
      '  on timer(at: "2026-08-01T09:00:00") {\n',
      undefined,
    ],
    [
      'a repeating timer as `every`, alongside for a non-interrupting handler',
      timerDef('cycle', 'R/PT10M'),
      '  on timer(every: "R/PT10M", alongside) {\n',
      false,
    ],
    [
      'a condition in the expression subset as bare DSL',
      conditionDef('${amount > 100}'),
      '  on condition(amount > 100) {\n',
      undefined,
    ],
    [
      'a condition out of the subset as a quoted raw fallback',
      conditionDef('${bean.check()}'),
      '  on condition("${bean.check()}") {\n',
      undefined,
    ],
    [
      'a message name that is an expression as a raw template',
      messageDef('${orderType}'),
      '  on message("${orderType}") {\n',
      undefined,
    ],
  ] as const)(
    'prints %s in the handler header',
    async (_title, def, header, interrupting) => {
      const ir = withHandlers(eventHandler('H', 'HS', def, interrupting));
      expect(await printed(ir)).toContain(header);
    },
  );

  it('prints the implementation a thrown or emitted message carries', async () => {
    const thrown = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          ...typedEvent('endEvent', 'Sent', messageDef('Ack')),
          binding: classBinding('com.example.Send'),
        },
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'Sent' }],
    );
    expect(await printed(thrown)).toContain(
      'throw message Sent("Ack", class: "com.example.Send")',
    );

    const emitted = around({
      ...typedEvent('intermediateThrowEvent', 'Ping', messageDef('Ack')),
      binding: externalBinding('send-ack'),
    });
    expect(await printed(emitted)).toContain(
      'emit message Ping("Ack", topic: "send-ack")',
    );
  });

  it('refuses an emit carrying a non-emittable definition', () => {
    const badEmit: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent(
          'intermediateThrowEvent',
          'Bad',
          timerDef('duration', 'PT1H'),
        ),
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Bad', 'E'),
    );
    expect(() => irToDsl(badEmit)).toThrow(/timer/);
  });
});

// A top-level start's own trigger has nowhere else to print; an event
// sub-process's start puts its trigger in the `on` header instead.

describe('irToDsl: triggered start events', () => {
  const startWith = (def: EventDefinition): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S', eventDefinition: def },
        { kind: 'endEvent', id: 'E' },
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );

  it.each([
    [
      'message',
      messageDef('OrderReceived'),
      'start S message("OrderReceived")',
    ],
    ['signal', signalDef('Cancelled'), 'start S signal("Cancelled")'],
    ['timer after', timerDef('duration', 'PT1H'), 'start S timer("PT1H")'],
    [
      'timer at',
      timerDef('date', '2026-08-01T09:00:00'),
      'start S timer(at: "2026-08-01T09:00:00")',
    ],
    [
      'timer every',
      timerDef('cycle', 'R/PT10M'),
      'start S timer(every: "R/PT10M")',
    ],
  ])(
    'prints a top-level start carrying a %s trigger',
    async (_title, def, expected) => {
      expect(await printed(startWith(def))).toContain(expected);
    },
  );

  it('prints the label as a setting beside the trigger', async () => {
    const ir = minimalProcess(
      [
        {
          kind: 'startEvent',
          id: 'S',
          name: 'Order in',
          eventDefinition: messageDef('OrderReceived'),
        },
        { kind: 'endEvent', id: 'E' },
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );
    expect(await printed(ir)).toContain(
      'start S message("OrderReceived", label: "Order in")',
    );
  });

  it('prints a triggered start whole even under a synthesized StartEvent_ id', async () => {
    const ir = minimalProcess(
      [
        {
          kind: 'startEvent',
          id: 'StartEvent_p',
          eventDefinition: messageDef('OrderReceived'),
        },
        { kind: 'endEvent', id: 'E' },
      ],
      [{ id: 'F', sourceRef: 'StartEvent_p', targetRef: 'E' }],
    );
    expect(await printed(ir, 'mintedId')).toContain(
      'start StartEvent_p message("OrderReceived")',
    );
  });
});

describe('irToDsl: event sub-process start-trigger suppression', () => {
  it("prints the trigger once, in the on header, never on the handler's own start; a synthesized start prints nothing", async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        eventHandler('OnMsg', 'MsgStart', messageDef('PaymentReceived')),
        triggeredSub('OnSig', [
          typedEvent('startEvent', 'StartEvent_OnSig', signalDef('Cancelled')),
          { kind: 'endEvent', id: 'SigEnd' },
        ]),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain(
      '  on message("PaymentReceived") {\n    start MsgStart\n',
    );
    expect(dsl).not.toContain('start MsgStart message');
    expect(dsl).not.toContain('StartEvent_OnSig');
    expect(dsl).toContain('  on signal("Cancelled") {\n    end SigEnd\n  }\n');
    // The trigger appears exactly once: in the `on` header, never on the start.
    expect(dsl.split('message("PaymentReceived")')).toHaveLength(2);
    expect(dsl.split('signal("Cancelled")')).toHaveLength(2);
  });
});

describe('irToDsl: ends spelling their own word', () => {
  // The third column names the refusals the model itself draws: a reserved id
  // the model chose, a cancel end the model puts outside an `attempt`.
  it.each([
    [
      'a terminate end',
      typedEvent('endEvent', 'Stop', { kind: 'terminate' }),
      [],
      'end Stop terminate',
    ],
    [
      'a terminate end with its label',
      {
        ...typedEvent('endEvent', 'Stop', { kind: 'terminate' }),
        name: 'All stop',
      },
      [],
      'end Stop terminate(label: "All stop")',
    ],
    [
      'a synthesized terminate end, rather than dropping it',
      typedEvent('endEvent', 'EndEvent_p', { kind: 'terminate' }),
      ['mintedId'],
      'end EndEvent_p terminate',
    ],
    [
      'a cancel end with its label',
      {
        ...typedEvent('endEvent', 'GiveUp', { kind: 'cancel' }),
        name: 'Give up the booking',
      },
      ['cancelOutsideAttempt'],
      'end GiveUp cancel(label: "Give up the booking")',
    ],
    [
      'a synthesized cancel end, rather than dropping it',
      typedEvent('endEvent', 'EndEvent_p', { kind: 'cancel' }),
      ['mintedId', 'cancelOutsideAttempt'],
      'end EndEvent_p cancel',
    ],
  ] as const)('prints %s', async (_title, end, refused, expected) => {
    expect(await printed(terminating(end), ...refused)).toContain(expected);
  });

  it('keeps the terminate and its label across an imported end event round trip', async () => {
    const ir = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'endEvent',
          id: 'EndEvent_1',
          name: 'Abandon all',
          eventDefinition: { kind: 'terminate' },
        },
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'EndEvent_1' }],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('end EndEvent_1 terminate(label: "Abandon all")');

    const ends = (await reDesugar(dsl)).flowElements.filter(
      (el) => el.kind === 'endEvent',
    );
    expect(ends).toEqual([
      {
        kind: 'endEvent',
        id: 'EndEvent_1',
        name: 'Abandon all',
        eventDefinition: { kind: 'terminate' },
      },
    ]);
  });
});

describe('irToDsl: blocks that can be given up', () => {
  /** The block under test, wired `St -> Book -> En` by {@link around}. */
  const book = (element?: 'transaction'): FlowElement => ({
    ...chainedSub('Book', [{ kind: 'userTask', id: 'Charge' }]),
    name: 'Book and pay',
    asyncBefore: true,
    loop: { collection: 'lines', elementVariable: 'line' },
    ...(element === undefined ? {} : { element }),
  });

  it('prints the block that can be given up under its own head, and a plain one under `subprocess`', async () => {
    expect(await printed(around(book('transaction')))).toContain(
      'attempt Book for each line in lines(label: "Book and pay", asyncBefore: true) {\n',
    );
    expect(await printed(around(book()))).toContain(
      'subprocess Book for each line in lines(label: "Book and pay", asyncBefore: true) {\n',
    );
  });

  it('prints the handler that catches the block being given up', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'St' },
        book('transaction'),
        { kind: 'endEvent', id: 'En' },
        boundaryEvent('Boundary_Book_cancel', 'Book', { kind: 'cancel' }),
        { kind: 'endEvent', id: 'Escaped' },
      ],
      [
        edge('St', 'Book', { id: 'f0' }),
        edge('Book', 'En', { id: 'f1' }),
        edge('Boundary_Book_cancel', 'Escaped', { id: 'f2' }),
      ],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('  on Book: cancel {\n');
    expect(dsl).toContain('    end Escaped\n');
  });
});

describe('irToDsl: event layer (intermediate catch / await)', () => {
  /** A `start -> task -> catch -> task -> end` body: the catch is on the main flow. */
  function catchBody(
    def: IntermediateCatchEvent['eventDefinition'],
  ): BpmnProcess {
    return processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Before' },
        typedEvent('intermediateCatchEvent', 'Catch_1', def),
        { kind: 'userTask', id: 'After' },
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Before', 'Catch_1', 'After', 'E'),
    );
  }

  // The whole source per row, so the missing id token is asserted too: a catch
  // has no name slot, and `Catch_1` appears nowhere.
  it.each([
    ['a message catch', messageDef('M'), '', '  await message("M")\n'],
    [
      'a duration timer catch',
      timerDef('duration', 'PT1H'),
      '',
      '  await timer("PT1H")\n',
    ],
    ['a signal catch', signalDef('S'), '', '  await signal("S")\n'],
    [
      'a conditional catch, bare DSL in the expression subset',
      conditionDef('${amount > 100}'),
      '  var amount: any\n',
      '  await condition(amount > 100)\n',
    ],
  ] as const)(
    'prints %s inline between the surrounding steps',
    async (_title, def, header, statement) => {
      expect(await printed(catchBody(def))).toBe(
        'process proc {\n' +
          header +
          '  start S\n  user Before\n' +
          statement +
          '  user After\n  end E\n}\n',
      );
    },
  );
});

describe('irToDsl: link pairs and named catches', () => {
  it('prints a link pair as a chain-ending emit link and a named await link opening the next chain', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'task', id: 'A' },
        typedEvent('intermediateThrowEvent', 'ToRetry', linkDef('Retry')),
        {
          ...typedEvent('intermediateCatchEvent', 'AtRetry', linkDef('Retry')),
          asyncBefore: true,
        },
        { kind: 'task', id: 'B' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'A'),
        edge('A', 'ToRetry'),
        edge('AtRetry', 'B'),
        edge('B', 'E'),
      ],
    );
    expect(await expectIdempotent(ir)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  step A\n' +
        '  emit link ToRetry("Retry")\n' +
        '  await link AtRetry("Retry", asyncBefore: true)\n' +
        '  step B\n' +
        '  end E\n' +
        '}\n',
    );
  });

  // `Catch_p_2` is the id `ast-to-ir` mints for the second (unnamed) await
  // statement in process `p`'s body; the round trip must re-derive the same
  // one, so the exact coordinate is pinned rather than guessed.
  it('prints a named await of any trigger with its name and an unnamed one with none', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('intermediateCatchEvent', 'Wait', messageDef('M')),
        typedEvent('intermediateCatchEvent', 'Catch_p_2', messageDef('M')),
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Wait', 'Catch_p_2', 'E'),
    );
    const dsl = await expectIdempotent(ir);
    expect(dsl).toContain('await message Wait("M")\n  await message("M")');
  });

  it('prints a goto into a named await as a jump, not a dropped edge', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('intermediateCatchEvent', 'Wait', messageDef('M')),
        { kind: 'userTask', id: 'A' },
      ],
      [edge('S', 'Wait'), edge('Wait', 'A'), edge('A', 'Wait')],
    );
    const dsl = await expectIdempotent(ir);
    expect(dsl).not.toContain(UNSTRUCTURED_MARKER);
    expect(printDsl(ir).warnings).toEqual([]);
  });
});

describe('irToDsl: event layer (compensation)', () => {
  /**
   * A process exercising the whole compensation surface: `emit compensation`
   * mid-chain, a terminal `throw compensation`, and a trailing `on
   * compensation` handler. Compensation is payload-less, so none of the three
   * carry a code or a name.
   */
  const COMPENSATION: EventDefinition = { kind: 'compensation' };

  const compensationIr: BpmnProcess = chained(
    [
      { kind: 'startEvent', id: 'PStart' },
      { kind: 'userTask', id: 'Work' },
      typedEvent('intermediateThrowEvent', 'EmitComp', COMPENSATION),
      typedEvent('endEvent', 'ThrowComp', COMPENSATION),
    ],
    {
      unwired: [
        triggeredSub('CompHandler', [
          typedEvent('startEvent', 'CompStart', COMPENSATION),
          { kind: 'userTask', id: 'Undo' },
          { kind: 'endEvent', id: 'CompEnd' },
        ]),
      ],
    },
  );

  it('prints a bare on-compensation handler after all flow, with emit/throw compensation carrying no trailing string', async () => {
    expect(await printed(compensationIr, 'undoOutsideBlock')).toBe(
      [
        'process proc {',
        '  start PStart',
        '  user Work',
        '  emit compensation EmitComp',
        '  throw compensation ThrowComp',
        '  on compensation {',
        '    start CompStart',
        '    user Undo',
        '    end CompEnd',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it("prints alongside for a malformed-IR compensation start with isInterrupting: false (the printer mirrors the IR; prohibiting it is the validator's job)", async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        triggeredSub('H', [
          typedEvent('startEvent', 'HS', { kind: 'compensation' }, false),
          { kind: 'endEvent', id: 'HE' },
        ]),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );
    expect(await printed(ir, 'undoOutsideBlock', 'undoAlongside')).toContain(
      '  on compensation(alongside) {\n',
    );
  });
});

// A boundary event's chain is entered by no start or link catch, so the entry
// passes never reach it and a pass of its own prints it, before the orphan
// sweep would flush it as a detached top-level chain. The chain lives in the
// same container as the main flow, so the shared emitted-node bookkeeping is
// what makes a rejoin degrade to a `goto`.

describe('irToDsl: boundary events', () => {
  /**
   * `start S -> user <host> -> end E`, flows F1 and F2, with `rest` and
   * `flows` appended verbatim: the boundary event, its escape chain, and
   * their edges.
   */
  const boundaryIr = (
    host: string,
    rest: readonly FlowElement[],
    flows: readonly SequenceFlow[],
  ): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: host },
        { kind: 'endEvent', id: 'E' },
        ...rest,
      ],
      [
        { id: 'F1', sourceRef: 'S', targetRef: host },
        { id: 'F2', sourceRef: host, targetRef: 'E' },
        ...flows,
      ],
    );

  it('prints an interrupting boundary as a hosted handler with its chain indented', async () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('duration', 'PT2H'),
        ),
        { kind: 'userTask', id: 'Escalate' },
        { kind: 'endEvent', id: 'Timeout' },
      ],
      [
        edge('Boundary_Review_timer', 'Escalate', { id: 'F3' }),
        { id: 'F4', sourceRef: 'Escalate', targetRef: 'Timeout' },
      ],
    );
    expect(await printed(ir)).toBe(
      [
        'process p {',
        '  start S',
        '  user Review',
        '  end E',
        '  on Review: timer("PT2H") {',
        '    user Escalate',
        '    end Timeout',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  // The header is printed whether the escape chain carries statements, is
  // empty, or the host is not in this container at all.
  it.each([
    [
      'alongside for a non-interrupting boundary, its chain indented under it',
      'Pack',
      [
        boundaryEvent(
          'Boundary_Pack_message',
          'Pack',
          messageDef('Nudge'),
          false,
        ),
        serviceTask('Notify', exprBinding('${n.go()}')),
        { kind: 'endEvent', id: 'Nudged' },
      ],
      [
        edge('Boundary_Pack_message', 'Notify', { id: 'F3' }),
        edge('Notify', 'Nudged', { id: 'F4' }),
      ],
      ['  on Pack: message("Nudge", alongside) {\n', '    end Nudged\n'],
      [],
    ],
    [
      'an empty body for a boundary carrying no outgoing flow',
      'Review',
      [
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('cycle', 'R/PT1H'),
        ),
      ],
      [],
      ['  on Review: timer(every: "R/PT1H") {\n  }\n'],
      [],
    ],
    [
      'the header all the same when the host lives outside this container',
      'Review',
      [
        boundaryEvent(
          'Boundary_Elsewhere_message',
          'Elsewhere',
          messageDef('M'),
        ),
      ],
      [],
      ['  on Elsewhere: message("M") {\n  }\n'],
      // The host the model names is nowhere for the compiler to resolve.
      ['hostOutsideContainer'],
    ],
  ] as const)('prints %s', async (_title, host, rest, flows, has, refused) => {
    const dsl = await printed(boundaryIr(host, rest, flows), ...refused);
    for (const text of has) expect(dsl).toContain(text);
  });

  // The compiler lays handlers down in statement order and derives an event
  // sub-process's id from its statement index, so a print that reorders them
  // renumbers the ids on the next compile.
  it('prints boundary handlers and event sub-processes in the order the model holds them', async () => {
    const ir = boundaryIr(
      'T',
      [
        eventHandler('OnM', 'MStart', messageDef('m'), false),
        boundaryEvent('Boundary_T_message', 'T', messageDef('n')),
        { kind: 'userTask', id: 'J' },
        { kind: 'endEvent', id: 'Caught' },
      ],
      [
        edge('Boundary_T_message', 'J', { id: 'F3' }),
        edge('J', 'Caught', { id: 'F4' }),
      ],
    );
    expect((await printed(ir)).split('\n').slice(4, -2)).toEqual([
      '  on message("m", alongside) {',
      '    start MStart',
      '    user OnM_Work',
      '    end OnM_End',
      '  }',
      '  on T: message("n") {',
      '    user J',
      '    end Caught',
      '  }',
    ]);
  });

  it('degrades a rejoin into the main flow to a goto and prints the main-flow node once', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Fetch' },
        { kind: 'userTask', id: 'Ship' },
        { kind: 'endEvent', id: 'E' },
        boundaryEvent('Boundary_Fetch_error', 'Fetch', errorDef('GONE')),
        { kind: 'userTask', id: 'Retry' },
      ],
      [
        { id: 'F1', sourceRef: 'S', targetRef: 'Fetch' },
        { id: 'F2', sourceRef: 'Fetch', targetRef: 'Ship' },
        { id: 'F3', sourceRef: 'Ship', targetRef: 'E' },
        { id: 'F4', sourceRef: 'Boundary_Fetch_error', targetRef: 'Retry' },
        { id: 'F5', sourceRef: 'Retry', targetRef: 'Ship' },
      ],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('  on Fetch: error(GONE) {\n');
    expect(dsl).toContain('    user Retry\n');
    expect(dsl).toContain('    goto Ship\n');
    expect(dsl.match(/^ *user Ship$/gm)).toHaveLength(1);
  });

  it('restructures an if/else inside an escape chain (the boundary is a second CFG entry)', async () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent('Boundary_Review_signal', 'Review', signalDef('Abort')),
        gateway('Gateway_p_9_split', 'B4'),
        gateway('Gateway_p_9_join'),
        { kind: 'userTask', id: 'Refund' },
        { kind: 'userTask', id: 'Keep' },
        { kind: 'endEvent', id: 'Aborted' },
      ],
      [
        edge('Boundary_Review_signal', 'Gateway_p_9_split', { id: 'B1' }),
        edge('Gateway_p_9_split', 'Refund', { id: 'B2', condition: '${paid}' }),
        { id: 'B3', sourceRef: 'Refund', targetRef: 'Gateway_p_9_join' },
        { id: 'B4', sourceRef: 'Gateway_p_9_split', targetRef: 'Keep' },
        { id: 'B5', sourceRef: 'Keep', targetRef: 'Gateway_p_9_join' },
        { id: 'B6', sourceRef: 'Gateway_p_9_join', targetRef: 'Aborted' },
      ],
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('  on Review: signal("Abort") {\n');
    expect(dsl).toContain('    if (paid) {\n');
    expect(dsl).toContain('    } else {\n');
    expect(hasGoto(dsl)).toBe(false);
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  it('prints two boundaries on one host as two blocks in IR order', async () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('duration', 'PT2H'),
        ),
        { kind: 'endEvent', id: 'Late' },
        boundaryEvent(
          'Boundary_Review_escalation',
          'Review',
          escalationDef('LOUD', 'c'),
        ),
        { kind: 'endEvent', id: 'Loud' },
      ],
      [
        { id: 'F3', sourceRef: 'Boundary_Review_timer', targetRef: 'Late' },
        edge('Boundary_Review_escalation', 'Loud', { id: 'F4' }),
      ],
    );
    const dsl = await printed(ir);
    const timer = dsl.indexOf('on Review: timer("PT2H") {');
    const escalation = dsl.indexOf('on Review: escalation(LOUD, code: c) {');
    expect(timer).toBeGreaterThan(-1);
    expect(escalation).toBeGreaterThan(timer);
    // Each boundary prints exactly one header: neither the escape-chain walk
    // nor the orphan sweep may print a boundary a second time.
    expect(dsl.match(/^ *on Review: /gm)).toHaveLength(2);
  });

  it('keeps the handler block trailing when the body also flushes sweep gotos', async () => {
    const source = [
      'process p {',
      '  error X',
      '  var r: string',
      '  user Intake',
      '  if (r == "A") { goto Alpha } else { goto Beta }',
      '  user Alpha',
      '  user Beta',
      '  end E',
      '  on Intake: error(X) { user Fix }',
      '}',
      '',
    ].join('\n');
    const doc = await parse(source);
    expect(doc.parseResult.parserErrors).toHaveLength(0);

    const dsl = irToDsl(astToIr(doc.parseResult.value));
    // A handler reads like a catch block: no ordinary statement, and in
    // particular no swept `goto`, may follow it.
    expect(dsl.indexOf('on Intake: error(X) {')).toBeGreaterThan(
      dsl.lastIndexOf('goto '),
    );
    // Re-opening the emitted source must raise no handler-placement error.
    const reparsed = await parse(dsl, { validation: true });
    expect(
      (reparsed.diagnostics ?? [])
        .map((d) =>
          typeof d.message === 'string' ? d.message : d.message.value,
        )
        .filter((m) => m.includes('catch blocks')),
    ).toEqual([]);
  });

  it('keeps the handler block trailing when the container holds an orphan fragment', async () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent('Boundary_Review_error', 'Review', errorDef('X')),
        { kind: 'userTask', id: 'Fix' },
        // Unreachable from the start event and from the escape chain.
        { kind: 'userTask', id: 'Stranded' },
      ],
      [{ id: 'F3', sourceRef: 'Boundary_Review_error', targetRef: 'Fix' }],
    );
    const dsl = await printed(ir, 'orphanStep');
    expect(dsl.indexOf('on Review: error(X) {')).toBeGreaterThan(
      dsl.indexOf('user Stranded'),
    );
  });

  it('prints the handler block for a boundary event a malformed flow edge points at', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        boundaryEvent('Boundary_A_error', 'A', errorDef('X')),
        { kind: 'userTask', id: 'Fix' },
      ],
      flowChain('S', 'A', 'Boundary_A_error', 'Fix'),
    );
    const dsl = await printed(ir);
    expect(dsl).toContain('on A: error(X) {');
    expect(dsl).toContain('user Fix');
    // Printed at its arrival point and nowhere else: the boundary pass must
    // find it already emitted.
    expect(dsl.match(/^ *on A: /gm)).toHaveLength(1);
  });

  it('prints a boundary event inside the sub-process container that holds its host', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'subProcess',
          id: 'Inner',
          flowElements: [
            { kind: 'startEvent', id: 'IS' },
            { kind: 'userTask', id: 'Check' },
            { kind: 'endEvent', id: 'IE' },
            boundaryEvent(
              'Boundary_Check_condition',
              'Check',
              conditionDef('${stale}'),
            ),
            { kind: 'endEvent', id: 'Stale' },
          ],
          sequenceFlows: [
            { id: 'I1', sourceRef: 'IS', targetRef: 'Check' },
            { id: 'I2', sourceRef: 'Check', targetRef: 'IE' },
            edge('Boundary_Check_condition', 'Stale', { id: 'I3' }),
          ],
        },
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Inner', 'E'),
    );
    expect(await printed(ir)).toContain('    on Check: condition(stale) {\n');
  });

  it('leaves a container without boundary events printing exactly as before', () => {
    expect(irToDsl(IF_ELSE_IR)).toBe(IF_ELSE_SOURCE);
  });
});

// A reserved `StartEvent_`/`EndEvent_`/`Throw_` id is the desugarer's own
// doing, not something an author could type, so printing it back out as a name
// produces source the validator rejects. These ids are omitted (start/end) or
// dropped from the name slot (throw/emit) instead.

describe('irToDsl: synthesized terminal omission', () => {
  /** A synthesized implicit start/end pair wrapping a sibling container that
   * carries its own authored start/end. */
  const IMPLICIT_TERMINALS_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'StartEvent_p' },
      { kind: 'userTask', id: 'Work' },
      {
        kind: 'subProcess',
        id: 'Sub',
        flowElements: [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'Inner' },
          { kind: 'endEvent', id: 'Done' },
        ],
        sequenceFlows: [
          { id: 'SF1', sourceRef: 'S', targetRef: 'Inner' },
          { id: 'SF2', sourceRef: 'Inner', targetRef: 'Done' },
        ],
      },
      { kind: 'endEvent', id: 'EndEvent_p' },
    ],
    [
      { id: 'F1', sourceRef: 'StartEvent_p', targetRef: 'Work' },
      { id: 'F2', sourceRef: 'Work', targetRef: 'Sub' },
      { id: 'F3', sourceRef: 'Sub', targetRef: 'EndEvent_p' },
    ],
  );

  it('omits synthesized implicit start/end terminals but keeps authored ones in a nested container', async () => {
    const dsl = await expectIdempotent(IMPLICIT_TERMINALS_IR);
    expect(dsl).not.toContain('StartEvent_');
    expect(dsl).not.toContain('EndEvent_');
    expect(dsl).toContain('start S');
    expect(dsl).toContain('end Done');
  });

  // A synthesized `Throw_` id is dropped from the name slot; an authored one is
  // spelled. No row may leave `Throw_` anywhere in the source.
  it.each([
    [
      'an authored message end',
      'endEvent',
      'Ack',
      messageDef('Ack'),
      'throw message Ack("Ack")',
    ],
    [
      'a synthesized message end',
      'endEvent',
      'Throw_p_1',
      messageDef('Ack'),
      'throw message("Ack")',
    ],
    [
      'an authored error end',
      'endEvent',
      'PaymentFailed',
      errorDef('PF'),
      'throw error PaymentFailed(PF)',
    ],
    [
      'a synthesized escalation end',
      'endEvent',
      'Throw_p_1',
      escalationDef('ESC'),
      'throw escalation(ESC)',
    ],
    [
      'an authored message emit',
      'intermediateThrowEvent',
      'Notify',
      messageDef('Ack'),
      'emit message Notify("Ack")',
    ],
    [
      'a synthesized message emit',
      'intermediateThrowEvent',
      'Throw_p_2',
      messageDef('Ack'),
      'emit message("Ack")',
    ],
    [
      'a synthesized signal emit',
      'intermediateThrowEvent',
      'Throw_p_2',
      signalDef('Ping'),
      'emit signal("Ping")',
    ],
  ] as const)('prints %s', async (_title, kind, id, def, expected) => {
    const node = typedEvent(kind, id, def);
    const dsl = await printed(
      kind === 'endEvent' ? terminating(node) : around(node),
    );
    expect(dsl).toContain(expected);
    expect(dsl).not.toContain('Throw_');
  });

  // Only the exact ids the compiler mints for a container are synthesized;
  // `StartEvent_1` is the id a modelling tool mints, an authored name like
  // any other, and it keeps its statement, its label and its initiator.
  it("prints a modelling tool's default start and end under their own ids, label and initiator kept", async () => {
    const { ir, warnings } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="StartEvent_1" name="Order Received" operaton:initiator="who" />
    <bpmn:userTask id="Approve" />
    <bpmn:endEvent id="EndEvent_1" name="Order Filed" />
    <bpmn:sequenceFlow id="F1" sourceRef="StartEvent_1" targetRef="Approve" />
    <bpmn:sequenceFlow id="F2" sourceRef="Approve" targetRef="EndEvent_1" />`);
    expect(warnings).toEqual([]);

    const { source, warnings: printWarnings } = printDsl(ir);
    expect(printWarnings).toEqual([]);
    expect(source).toBe(
      [
        'process p {',
        '  start StartEvent_1(label: "Order Received", initiator: "who")',
        '  user Approve',
        '  end EndEvent_1(label: "Order Filed")',
        '}',
        '',
      ].join('\n'),
    );
    expect((await validate(source)).diagnostics).toEqual([]);
    expect((await reDesugar(source)).flowElements).toEqual(ir.flowElements);
  });

  // The trigger moves into the `on` header, so nothing else holds a start
  // under the handler's minted id inside the body either; a start under any
  // other id is authored and keeps its statement.
  it.each([
    [
      "the handler's minted start id, so the label is reported and the start left out",
      'StartEvent_Handler',
      [['label', 'StartEvent_Handler']],
      '  on error {\n  }\n',
    ],
    [
      "a modelling tool's start id, so the start prints with its label",
      'StartEvent_9',
      [],
      '  on error {\n    start StartEvent_9(label: "Restock Heard")\n  }\n',
    ],
  ] as const)(
    "an event handler's trigger start carries %s",
    async (_title, startId, expectedWarnings, handler) => {
      const { ir, warnings } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="${startId}" name="Restock Heard">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`);
      expect(warnings.map((w) => [w.category, w.elementId])).toEqual(
        expectedWarnings,
      );
      expect(await printed(ir)).toContain(handler);
    },
  );
});

// An id the model may carry and the script cannot spell (`Task.1`, a keyword,
// a trailing hyphen) prints under a name minted from it, with one report per
// rename, at every site an id is written: the process head, every statement
// head, a `goto`, a boundary's host, and a throw's or catch's name.
describe('irToDsl: ids the script cannot spell print under a minted name', () => {
  const ir = processIr(
    'WFP-6-',
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'userTask', id: 'Task.1' },
      { kind: 'userTask', id: 'user' },
      chainedSub('Sub.1', [
        { kind: 'startEvent', id: 'S2' },
        { kind: 'task', id: 'Step.2' },
        { kind: 'endEvent', id: 'E2' },
      ]),
      typedEvent('intermediateThrowEvent', 'Notify.1', messageDef('M')),
      { kind: 'userTask', id: 'Review-' },
      { kind: 'endEvent', id: 'E' },
      boundaryEvent('B', 'Task.1', timerDef('duration', 'PT1H')),
    ],
    [
      ...flowChain('S', 'Task.1', 'user', 'Sub.1', 'Notify.1', 'Review-', 'E'),
      edge('B', 'Review-'),
    ],
  );

  // Revert: print `el.id` at any one site and the source stops parsing.
  it('prints every site under the minted name, reports each rename once, and the source compiles clean', async () => {
    const { source, warnings } = printDsl(ir);
    expect(source).toBe(
      [
        'process WFP_6_ {',
        '  start S',
        '  user Task_1',
        '  user _user',
        '  subprocess Sub_1 {',
        '    start S2',
        '    step Step_2',
        '    end E2',
        '  }',
        '  emit message Notify_1("M")',
        '  user Review_',
        '  end E',
        '  on Task_1: timer("PT1H") {',
        '    goto Review_',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expectReports(
      warnings,
      ['renamedId', 'WFP-6-'],
      ['renamedId', 'Task.1'],
      ['renamedId', 'user'],
      ['renamedId', 'Sub.1'],
      ['renamedId', 'Step.2'],
      ['renamedId', 'Notify.1'],
      ['renamedId', 'Review-'],
    );
    expect((await validate(source)).diagnostics).toEqual([]);
    expect((await reDesugar(source)).id).toBe('WFP_6_');
  });

  // The mint from `Task.1` lands on `Task_1`, which the document already
  // spells for another element; resolving against every id, not just the
  // names minted so far, is what pushes it to the next free suffix.
  it('a minted name that another id already spells takes the next free suffix, and the source compiles clean', async () => {
    const { source, warnings } = printDsl(
      chained([
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Task.1' },
        { kind: 'userTask', id: 'Task_1' },
        { kind: 'endEvent', id: 'E' },
      ]),
    );
    expect(source).toBe(
      [
        'process proc {',
        '  start S',
        '  user Task_1_2',
        '  user Task_1',
        '  end E',
        '}',
        '',
      ].join('\n'),
    );
    expectReports(warnings, ['renamedId', 'Task.1']);
    expect((await validate(source)).diagnostics).toEqual([]);
  });
});

// Leaving a synthesized plain end out anywhere but its block's tail would wire
// its predecessor into whatever follows on the page, so it prints under its
// reserved id and is reported. The compiler never mints one in the positions
// rows 2 and 3 put it in, so those rows compile an authored end there and
// give it the minted id afterwards.
describe("irToDsl: a synthesized plain end that is not its block's tail", () => {
  const start = (id: string): FlowElement => ({ kind: 'startEvent', id });
  const step = (id: string): FlowElement => ({ kind: 'task', id });
  const end = (id: string): FlowElement => ({ kind: 'endEvent', id });
  const renamed = (ir: BpmnProcess, from: string, to: string): BpmnProcess => ({
    ...ir,
    flowElements: ir.flowElements.map((el) =>
      el.id === from ? { ...el, id: to } : el,
    ),
    sequenceFlows: ir.sequenceFlows.map((f) => ({
      ...f,
      sourceRef: f.sourceRef === from ? to : f.sourceRef,
      targetRef: f.targetRef === from ? to : f.targetRef,
    })),
  });

  it.each([
    [
      "a guard's throw with a single incoming flow inlines, so its tail end stays elided rather than deferred",
      'process p { error E  start S  step A  if (x) { throw error Named(E) }  step X }',
      [
        'process p {',
        '  error E',
        '  var x: any',
        '  start S',
        '  step A',
        '  if (x) {',
        '    throw error Named(E)',
        '  }',
        '  step X',
        '}',
      ],
      [],
    ],
    [
      // A link catch is an entry of its own, so its chain is never walked
      // inside the guard the way a chain the split owns is.
      "a plain end whose chain a link catch's chain follows prints before that catch, and its label rides along",
      'process p { start S  step A  if (x) { emit link L("x") }  step C  end Done(label: "Order filed")  await link M("x")  step B  end Fin }',
      [
        'process p {',
        '  var x: any',
        '  start S',
        '  step A',
        '  if (x) {',
        '    emit link L("x")',
        '  }',
        '  step C',
        '  end EndEvent_p(label: "Order filed")',
        '  await link M("x")',
        '  step B',
        '  end Fin',
        '}',
      ],
      [['refusedStatement', 'EndEvent_p']],
    ],
    [
      'a plain end inside a branch prints at once, so the branch does not fall through',
      'process p { start S  step A  if (x) { end Done }  step X  end Fin }',
      [
        'process p {',
        '  var x: any',
        '  start S',
        '  step A',
        '  if (x) {',
        '    end EndEvent_p',
        '  }',
        '  step X',
        '  end Fin',
        '}',
      ],
      [['refusedStatement', 'EndEvent_p']],
    ],
    [
      'of three chains, the synthesized end closing the first prints in place while the authored ends print as any end does',
      // The second and third starts carry a trigger: the validator refuses a
      // second plain start, as `BpmnParse.selectInitial` does.
      minimalProcess(
        [
          start('S1'),
          step('A'),
          end('EndEvent_p'),
          typedEvent('startEvent', 'S2', messageDef('M2')),
          step('B'),
          end('E2'),
          typedEvent('startEvent', 'S3', messageDef('M3')),
          step('C'),
          end('E3'),
        ],
        [
          edge('S1', 'A'),
          edge('A', 'EndEvent_p'),
          edge('S2', 'B'),
          edge('B', 'E2'),
          edge('S3', 'C'),
          edge('C', 'E3'),
        ],
      ),
      [
        'process p {',
        '  start S1',
        '  step A',
        '  end EndEvent_p',
        '  start S2 message("M2")',
        '  step B',
        '  end E2',
        '  start S3 message("M3")',
        '  step C',
        '  end E3',
        '}',
      ],
      [['refusedStatement', 'EndEvent_p']],
    ],
  ] as const)('%s', async (_title, fixture, source, reports) => {
    const ir =
      typeof fixture === 'string'
        ? renamed(await reDesugar(fixture), 'Done', 'EndEvent_p')
        : fixture;
    expect(await expectIdempotent(ir, 'mintedId')).toEqual(
      `${source.join('\n')}\n`,
    );
    expectReports(printDsl(ir).warnings, ...reports);
  });
});

describe('irToDsl: guard-clause continuation', () => {
  it('recovers a throw-guard `if` with the continuation at the body level and no gateway token', async () => {
    // `if (c) { throw }` with no else: the then-branch terminates, the default
    // continues the main flow. There is no clean post-dominating join, so the
    // fallback consumes the sole default edge as the continuation.
    const ir = await reDesugar(`process p {
  error BOOM
  start S
  service Pre(class: "x.Pre")
  if (amount > 1000) {
    throw error(BOOM)
  }
  service Post(class: "x.Post")
  end Done
}
`);
    const dsl = await expectIdempotent(ir);

    // Both the split and the join are elided, so no synthesized gateway id
    // appears and nothing jumps to one.
    expect(dsl).not.toContain('goto Gateway_');
    expect(dsl).not.toContain('Gateway_');

    // The guard's terminal prints inline, not as a jump to the throw node.
    expect(dsl).toContain('throw error(BOOM)');
    expect(dsl).not.toContain('goto Throw_');

    // The continuation prints AFTER the `if`, at the container body level, not
    // swept to the end past a terminating gateway.
    const ifIdx = dsl.indexOf('if (amount > 1000)');
    const postIdx = dsl.indexOf('service Post');
    const doneIdx = dsl.indexOf('end Done');
    expect(ifIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(ifIdx);
    expect(doneIdx).toBeGreaterThan(postIdx);
  });

  it('keeps a loop-body statement after a terminal-branch guard inside the while block', async () => {
    // `while (...) { A; if (d) { throw }; B }`: the guard's terminal branch must
    // not push `B` out of the loop.
    const ir = await reDesugar(`process p {
  error X
  start S
  while (retries < 3) {
    service A(class: "x.A")
    if (retries < 1) {
      throw error(X)
    }
    service B(class: "x.B")
  }
  end Done
}
`);
    const dsl = await expectIdempotent(ir);
    expect(dsl).not.toContain('goto Gateway_');

    const lines = dsl.split('\n');
    const indentOf = (s: string): number => s.length - s.trimStart().length;
    const whileIdx = lines.findIndex((l) => l.includes('while (retries < 3)'));
    const bIdx = lines.findIndex((l) => l.includes('service B'));
    const doneIdx = lines.findIndex((l) => l.includes('end Done'));

    // `B` appears after the `while` header, before `end Done`, and indented
    // deeper than it, so it is nested inside the loop rather than after it.
    expect(whileIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(whileIdx);
    expect(doneIdx).toBeGreaterThan(bIdx);
    expect(indentOf(lines[bIdx]!)).toBeGreaterThan(indentOf(lines[doneIdx]!));
  });
});

describe('irToDsl: authored terminal in a guard clause', () => {
  it('keeps a goto for an authored end reached from more than one predecessor', async () => {
    // `Done` has two predecessors, `split`'s guarded route and `split2`'s.
    // Without `split2`, `Done` would post-dominate `split` and the printer
    // would fold the shape into a re-merging `if`/`else` before
    // `branchStaysInRegion` is ever asked about the terminal.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        gateway('split'),
        { kind: 'userTask', id: 'B' },
        gateway('split2'),
        { kind: 'endEvent', id: 'Done' },
        { kind: 'endEvent', id: 'End2' },
      ],
      [
        edge('S', 'A'),
        edge('A', 'split'),
        edge('split', 'Done', { condition: '${x}' }),
        edge('split', 'B'),
        edge('split2', 'Done', { condition: '${z}' }),
        edge('B', 'split2'),
        edge('split2', 'End2'),
      ],
    );
    const dsl = await printed(ir);
    expect(dsl).toEqual(`process p {
  var x: any
  var z: any
  start S
  user A
  if (x) {
    goto Done
  }
  user B
  if (z) {
    goto Done
  }
  end End2
  end Done
}
`);
  });
});

// A branch whose chain ends before the join is walked inline only where the
// block's tail is the end the printer leaves out: hoisted behind that end, the
// chain would push it off the tail and print it under its reserved id. With
// an authored end closing the block the chain stays a jump at its authored
// scope, so the coordinate ids of its unnamed events survive the round trip,
// which the multiset comparison pins; a chain running into the elided end is
// that tail and stays a jump too.
describe('irToDsl: an authored chain a branch owns', () => {
  it.each([
    [
      'two branches whose chains end print them inline, and the implicit end stays unwritten',
      [
        'process p {',
        '  var a: any',
        '  var b: any',
        '  if (a) {',
        '    user A',
        '    throw message("Quote Received")',
        '  } else if (b) {',
        '    user B',
        '    await {',
        '      message("OrderReceived") {',
        '        end Done',
        '      }',
        '      message("Quote Received") {',
        '        user C',
        '      }',
        '    }',
        '  } else {',
        '    user D',
        '  }',
        '}',
      ],
    ],
    [
      'a guard clause whose branch runs a step into an end prints the step inside the branch',
      [
        'process p {',
        '  var a: any',
        '  if (a) {',
        '    user A',
        '    end Stop',
        '  }',
        '  user B',
        '}',
      ],
    ],
    [
      'a chain jumped to behind an authored end stays behind it, keeping the coordinate id of its unnamed throw',
      [
        'process p {',
        '  error E',
        '  var x: any',
        '  if (x) {',
        '    goto X',
        '  }',
        '  user C',
        '  end Done',
        '  user X',
        '  throw error(E)',
        '}',
      ],
    ],
    [
      'a chain that runs into the implicit end is the tail and stays a jump',
      [
        'process p {',
        '  var a: any',
        '  if (a) {',
        '    goto X',
        '  }',
        '  user B',
        '  end Done',
        '  user X',
        '}',
      ],
    ],
  ])('%s', async (_title, lines) => {
    const source = `${lines.join('\n')}\n`;
    const ir = await reDesugar(source);
    expect(await expectIdempotent(ir)).toBe(source);
    expect(printDsl(ir).warnings).toEqual([]);
  });
});

describe('irToDsl: routes leaving a loop beside the two it is built from', () => {
  /**
   * A review loop with an escalate exit: the loop head routes back, escalates,
   * or carries on. The loop is built from the back-edge and one route out, and
   * the third route is taken where the loop leaves off.
   */
  const PRE_TEST_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Loop'),
      { kind: 'userTask', id: 'Work' },
      { kind: 'userTask', id: 'Escalate' },
      { kind: 'endEvent', id: 'E' },
      { kind: 'endEvent', id: 'E2' },
    ],
    [
      edge('S', 'Loop'),
      edge('Loop', 'Work', { condition: '${more}' }),
      edge('Work', 'Loop'),
      edge('Loop', 'Escalate', { condition: '${escalate}' }),
      edge('Loop', 'E'),
      edge('Escalate', 'E2'),
    ],
  );

  const POST_TEST_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'userTask', id: 'Review' },
      gateway('Decide'),
      { kind: 'userTask', id: 'Escalate' },
      { kind: 'userTask', id: 'Done' },
      { kind: 'endEvent', id: 'E' },
      { kind: 'endEvent', id: 'E2' },
    ],
    [
      edge('S', 'Review'),
      edge('Review', 'Decide'),
      edge('Decide', 'Review', { condition: '${rework}' }),
      edge('Decide', 'Escalate', { condition: '${escalate}' }),
      edge('Decide', 'Done'),
      edge('Done', 'E'),
      edge('Escalate', 'E2'),
    ],
  );

  it.each([
    [
      'pre-test',
      PRE_TEST_IR,
      'process p {\n' +
        '  var more: any\n' +
        '  var escalate: any\n' +
        '  start S\n' +
        '  while (more) {\n' +
        '    user Work\n' +
        '  }\n' +
        '  if (escalate) {\n' +
        '    user Escalate\n' +
        '  } else {\n' +
        '    end E\n' +
        '  }\n' +
        '  end E2\n' +
        '}\n',
    ],
    [
      'post-test',
      POST_TEST_IR,
      'process p {\n' +
        '  var rework: any\n' +
        '  var escalate: any\n' +
        '  start S\n' +
        '  do {\n' +
        '    user Review\n' +
        '  } while (rework)\n' +
        '  if (escalate) {\n' +
        '    goto Escalate\n' +
        '  }\n' +
        '  user Done\n' +
        '  end E\n' +
        '  user Escalate\n' +
        '  end E2\n' +
        '}\n',
    ],
  ])(
    'takes the surplus route as a choice after a %s loop closes',
    async (_title, ir, expected) => {
      const { source, warnings } = printDsl(ir);
      expect(source).toBe(expected);
      expect(warnings).toEqual([]);

      const lowered = await reDesugar(await printed(ir));
      expect(edgeMultiset(lowered)).toContain('<GW>->Escalate[${escalate}]');
      expect(realReachability(lowered)).toEqual(realReachability(ir));
    },
  );

  // Revert symptom: read the loop's settings again for its leftover routes ->
  // the choice after the loop carries a second copy.
  it.each([
    [
      'pre-test',
      PRE_TEST_IR,
      'Loop',
      'while (more) {',
      'while (more) (asyncBefore: true) {',
    ],
    [
      'post-test',
      POST_TEST_IR,
      'Decide',
      '} while (rework)',
      '} while (rework) (asyncBefore: true)',
    ],
  ] as const)(
    'writes the loop settings on the %s loop once, and none on the choice its surplus route becomes',
    async (_title, plain, loopId, plainHead, head) => {
      const ir = withJobSettings(plain, { [loopId]: { asyncBefore: true } });
      const { source, warnings } = printDsl(ir);

      expect(source).toBe(irToDsl(plain).replace(plainHead, head));
      expect(warnings).toEqual([]);
      await printed(ir);
    },
  );
});

describe('irToDsl: a split inside a loop body whose every route is conditioned', () => {
  /**
   * The approve-review loop: `Approve` splits under a condition per route, one
   * route leaving the loop for `Pay` and the rest running through a step into
   * the loop gateway, which routes back under `${clarified}` and out under
   * `${!clarified}`. No route anywhere is unconditioned and no split names a
   * fallback, which is the shape a modeler draws.
   */
  const reviewLoopIr = (
    staying: readonly (readonly [step: string, condition: string])[],
    exit: 'E' | 'E2' = 'E2',
  ): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Approve' },
        gateway('G1'),
        ...staying.map(([id]): FlowElement => ({ kind: 'userTask', id })),
        gateway('G2'),
        { kind: 'userTask', id: 'Pay' },
        { kind: 'endEvent', id: 'E' },
        ...(exit === 'E2' ? [{ kind: 'endEvent', id: 'E2' } as const] : []),
      ],
      [
        edge('S', 'Approve'),
        edge('Approve', 'G1'),
        edge('G1', 'Pay', { condition: '${approved}' }),
        ...staying.map(([id, condition]) => edge('G1', id, { condition })),
        ...staying.map(([id]) => edge(id, 'G2')),
        edge('G2', 'Approve', { condition: '${clarified}' }),
        edge('G2', exit, { condition: '${!clarified}' }),
        edge('Pay', 'E'),
      ],
    );

  const loopHead = (declared: string): string =>
    `process p {\n${declared}  start S\n  do {\n    user Approve\n`;
  const loopTail = '    }\n' + '  } while (clarified)\n';
  const reviewBranch = '    } else if (!approved) {\n' + '      user Review\n';

  // Revert symptoms: `emitRoutes` without the enclosing-construct continuation
  // -> every branch is a jump, `Review` is hoisted after `end E2`, and its
  // route into the loop gateway is a dropped-edge marker; `cleanJoin` without
  // the containment check -> the shared-end row takes `E` as the join, `Review`
  // is walked past the printed loop head, and `G2` draws the dropped-edge
  // marker with `end E` inside the `do`.
  it.each([
    [
      'walks the one route that stays in the loop inline and jumps on the one that leaves',
      reviewLoopIr([['Review', '${!approved}']]),
      loopHead('  var approved: any\n  var clarified: any\n') +
        '    if (approved) {\n' +
        '      goto Pay\n' +
        reviewBranch +
        loopTail +
        '  end E2\n' +
        '  user Pay\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'walks both routes that stay in the loop inline',
      reviewLoopIr([
        ['Review', '${!approved && !escalated}'],
        ['Escalate', '${escalated}'],
      ]),
      loopHead(
        '  var approved: any\n  var escalated: any\n  var clarified: any\n',
      ) +
        '    if (approved) {\n' +
        '      goto Pay\n' +
        '    } else if (!approved && !escalated) {\n' +
        '      user Review\n' +
        '    } else if (escalated) {\n' +
        '      user Escalate\n' +
        loopTail +
        '  end E2\n' +
        '  user Pay\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'keeps the split inside the loop when its leaving route and the loop exit share one end',
      reviewLoopIr([['Review', '${!approved}']], 'E'),
      loopHead('  var approved: any\n  var clarified: any\n') +
        '    if (approved) {\n' +
        '      goto Pay\n' +
        reviewBranch +
        loopTail +
        '  end E\n' +
        '  user Pay\n' +
        '  goto E\n' +
        '}\n',
    ],
  ])('%s', async (_title, ir, expected) => {
    const { source, warnings } = printDsl(ir);
    expect(source).toBe(expected);
    // The chain closes with no `else`, so the printed split gains the fallback
    // the model never named; the loop's exit condition has no place after
    // `} while (clarified)`.
    expectReports(
      warnings,
      ['inventedFallback', 'G1'],
      ['droppedFlowCondition', 'G2'],
    );
    await printed(ir);
  });
});

/**
 * A multi-out real node whose routes end apart, so neither branch has a join
 * to walk to and each keeps its edge as a jump. The second lands on a one-out
 * pass-through gateway `Gateway_p_9_join -> R`: naming the gateway is
 * impossible, so the jump forwards through it to the real successor.
 */
const PASS_THROUGH_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'userTask', id: 'A' },
    gateway('Gateway_p_9_join'),
    { kind: 'userTask', id: 'R' },
    { kind: 'endEvent', id: 'E' },
    { kind: 'endEvent', id: 'E2' },
  ],
  [
    { id: 'f0', sourceRef: 'S', targetRef: 'A' },
    { id: 'f1', sourceRef: 'A', targetRef: 'E' },
    { id: 'f2', sourceRef: 'A', targetRef: 'Gateway_p_9_join' },
    { id: 'f3', sourceRef: 'Gateway_p_9_join', targetRef: 'R' },
    { id: 'f4', sourceRef: 'R', targetRef: 'E2' },
  ],
);

/**
 * A parallel fork with a back-edge into it (`B -> fork`). By the time the
 * back-arrival is realized, the fork's out-edges are all consumed, so there
 * is no single successor to forward to, so the edge becomes a hand-repair
 * marker rather than an unresolvable `goto` into the fork. This shape is only
 * reachable through hostile input; the forward compiler never emits it.
 */
const GOTO_INTO_FORK_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
    { kind: 'userTask', id: 'A' },
    { kind: 'userTask', id: 'B' },
    { kind: 'endEvent', id: 'E' },
  ],
  [
    { id: 'f0', sourceRef: 'S', targetRef: 'Gateway_p_1_fork' },
    { id: 'f1', sourceRef: 'Gateway_p_1_fork', targetRef: 'A' },
    { id: 'f2', sourceRef: 'Gateway_p_1_fork', targetRef: 'B' },
    { id: 'f3', sourceRef: 'A', targetRef: 'E' },
    { id: 'f4', sourceRef: 'B', targetRef: 'Gateway_p_1_fork' },
  ],
);

describe('irToDsl: never emit a goto to a gateway', () => {
  it('forwards a goto through a one-out pass-through gateway to the real successor', async () => {
    const dsl = irToDsl(PASS_THROUGH_IR);
    // The jump names the real successor, never the elided gateway.
    expect(dsl).toContain('goto R');
    expect(dsl).not.toContain('goto Gateway_');
    expect(dsl).not.toContain('Gateway_p_9_join');
    await reDesugar(dsl);
  });

  it('emits the hand-repair marker for a goto into a fork, never a gateway-targeting goto', async () => {
    const dsl = irToDsl(GOTO_INTO_FORK_IR);
    expect(dsl).toContain('// unstructured region: hand-repair required');
    expect(dsl).not.toContain('goto Gateway_');
    expect(dsl).not.toContain('goto Gateway_p_1_fork');
    // The marker is a hidden comment, so the output still parses.
    await reDesugar(dsl);
  });
});

describe('irToDsl: parallel-fork recovery (terminating branch)', () => {
  it('recovers an asymmetric fork as `parallel { ... }` with the throw inline, the continuation after, and an equal IR back', async () => {
    // A `parallel` where one branch terminates (`throw`) and the other flows on
    // to the join. The fork's immediate post-dominator is the virtual exit, so
    // there is no clean parallel join and the fork must be recovered
    // structurally rather than degrading to raw gotos.
    const ir = await reDesugar(`process p {
  error BOOM(message: "it broke")
  start Begin
  parallel {
    { service A(label: "a", class: "x.A") }
    { throw error(BOOM) }
  }
  end Finish
}
`);
    const dsl = await expectIdempotent(ir);

    expect(dsl).toContain('parallel {');
    // Both branch bodies print inline; the terminating branch prints its throw
    // in place, never as a jump to the (un-nameable) synthesized throw node.
    expect(dsl).toContain('service A(label: "a", class: "x.A")');
    expect(dsl).toContain('throw error(BOOM)');

    expect(hasGoto(dsl)).toBe(false);
    expect(dsl).not.toContain('goto Throw_');
    expect(dsl).not.toContain('goto Gateway_');
    expect(dsl).not.toContain('Gateway_');
    expect(dsl).not.toContain('Throw_');

    // The continuation prints AFTER the parallel, at the container body level
    // (one indent), not swept to the end and not nested inside the block.
    const parIdx = dsl.indexOf('parallel {');
    const finishIdx = dsl.indexOf('end Finish');
    expect(parIdx).toBeGreaterThan(-1);
    expect(finishIdx).toBeGreaterThan(parIdx);
    expect(dsl).toContain('\n  end Finish');
  });

  it('recovers the shared continuation of a nested fork with a terminating branch (idempotence)', async () => {
    // An outer `parallel` whose surviving branches each hold their own nested
    // `parallel`, plus one terminating `throw`. The continuation (`end Finish`)
    // must resume after the OUTER join both survivors reconverge at, not the
    // first survivor's inner join, which would drift it into a sibling branch
    // and make the round-trip non-idempotent.
    const ir = await reDesugar(`process p {
  error BOOM(message: "it broke")
  start Begin
  parallel {
    {
      parallel {
        { service A(label: "a", class: "x.A") }
        { service B(label: "b", class: "x.B") }
      }
    }
    {
      parallel {
        { service C(label: "c", class: "x.C") }
        { service D(label: "d", class: "x.D") }
      }
    }
    { throw error(BOOM) }
  }
  end Finish
}
`);
    const dsl = await expectIdempotent(ir);

    // The continuation lands after the outer parallel at container level, and
    // no edge is dropped through a bare gateway or throw-targeting goto.
    expect(dsl).toContain('\n  end Finish');
    expect(dsl).not.toContain('goto Gateway_');
    expect(dsl).not.toContain('goto Throw_');
  });
});

describe('irToDsl: the process header and the start it opens on', () => {
  /** Every key the header carries, an initiator, and a condition start. */
  const HEADER_IR: BpmnProcess = {
    id: 'stock-watch',
    isExecutable: true,
    versionTag: '3.1',
    historyTimeToLive: 'P90D',
    candidateStarterUsers: 'demo,manager',
    candidateStarterGroups: 'adjusters',
    flowElements: [
      {
        kind: 'startEvent',
        id: 'StockRanLow',
        formFields: [{ id: 'stockLevel', type: 'number' }],
        eventDefinition: conditionDef('${stockLevel < 5}'),
        initiator: 'claimant',
      },
      { kind: 'userTask', id: 'ReorderStock', assignee: 'demo' },
      { kind: 'endEvent', id: 'Restocked' },
    ],
    sequenceFlows: [
      edge('StockRanLow', 'ReorderStock'),
      edge('ReorderStock', 'Restocked'),
    ],
  };

  it('prints every key the header vocabulary declares, in the order it declares them', () => {
    expect([
      'label',
      'documentation',
      ...PROCESS_HEADER_SETTINGS.map(([key]) => key),
    ]).toEqual(PROCESS_HEADER_KEYS);
  });

  it('prints the header, the initiator and the condition, and re-desugars to the same IR', async () => {
    const dsl = await printed(HEADER_IR);
    expect(dsl).toBe(
      'process stock-watch(versionTag: "3.1", historyTimeToLive: "P90D", candidateStarterUsers: "demo,manager", candidateStarterGroups: "adjusters") {\n' +
        '  start StockRanLow condition(stockLevel < 5, initiator: "claimant") {\n' +
        '    form {\n' +
        '      stockLevel: number\n' +
        '    }\n' +
        '  }\n' +
        '  user ReorderStock(assignee: "demo")\n' +
        '  end Restocked\n' +
        '}\n',
    );
    expect(await reDesugar(dsl)).toEqual(HEADER_IR);
  });
});

/**
 * The lines strictly between `form {` and the matching `}`, trimmed, brace
 * depth tracked so a field's own block (parens and members nest inside a
 * field line) does not end the slice early.
 */
function formBlockLines(dsl: string): string[] {
  const lines = dsl.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'form {');
  const body: string[] = [];
  let depth = 1;
  for (let i = start + 1; depth > 0; i++) {
    const line = lines[i]!;
    depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
    if (depth > 0) body.push(line.trim());
  }
  return body;
}

describe('irToDsl: form fields print their parens and block only with something to print', () => {
  const PLAN_FIELD: FormField = {
    id: 'plan',
    type: 'enum',
    label: 'Plan',
    defaultValue: 'basic',
    values: [
      { id: 'basic', label: 'Basic' },
      { id: 'plus' },
      { id: 'weird', label: '${weird}' },
    ],
    properties: [{ key: 'hint', value: '${hint}' }],
  };

  const FIELD_ROWS: [string, FormField, string[]][] = [
    [
      'a plain field prints unchanged: no parens, no block',
      { id: 'ok', type: 'boolean' },
      ['ok: boolean'],
    ],
    [
      'a date field prints its pattern first, then the flag constraint',
      {
        id: 'birthDate',
        type: 'date',
        label: 'Date of birth',
        datePattern: 'dd/MM/yyyy',
        constraints: [{ name: 'required' }],
      },
      [
        'birthDate: date "Date of birth" (pattern: "dd/MM/yyyy", required: true)',
      ],
    ],
    [
      'a number default opening with #{ prints quoted so it re-lexes as a raw template',
      { id: 'seed', type: 'number', defaultValue: '#{seed}' },
      ['seed: number = "#{seed}"'],
    ],
    [
      'a number prints an all-digit bound bare and a negative bound quoted',
      {
        id: 'amount',
        type: 'number',
        constraints: [
          { name: 'min', config: '-5' },
          { name: 'max', config: '5000' },
        ],
      },
      ['amount: number (min: "-5", max: 5000)'],
    ],
    [
      'a string with a validator constraint opens a block for its property',
      {
        id: 'iban',
        type: 'string',
        constraints: [{ name: 'validator', config: 'com.example.Check' }],
        properties: [{ key: 'placeholder', value: 'Filled in later' }],
      },
      [
        'iban: string (validator: "com.example.Check") {',
        'property placeholder = "Filled in later"',
        '}',
      ],
    ],
    [
      'an enum prints its labelled, bare and escaped values before a raw property value',
      PLAN_FIELD,
      [
        'plan: enum "Plan" = "basic" {',
        'basic "Basic"',
        'plus',
        'weird "\\${weird}"',
        'property hint = "${hint}"',
        '}',
      ],
    ],
  ];

  it.each(FIELD_ROWS)('%s', async (_title, field, expected) => {
    const dsl = await printed(
      around({ kind: 'userTask', id: 'T', formFields: [field] }),
    );
    expect(formBlockLines(dsl)).toEqual(expected);
  });

  // The engine evaluates a default as an expression, so the text a modeler
  // wrote is the constant it sees; bare, `maybe` would read a variable and
  // `1 + 1` would compute, and a bare `-3` lowers to `${-3}`.
  it('prints a number or boolean default bare only when it re-lexes as the same literal', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'T',
        formFields: [
          { id: 'a', type: 'boolean', defaultValue: 'maybe' },
          { id: 'b', type: 'number', defaultValue: '1 + 1' },
          { id: 'c', type: 'number', defaultValue: '-3' },
          { id: 'd', type: 'number', defaultValue: '1.5' },
          { id: 'e', type: 'boolean', defaultValue: 'true' },
          { id: 'f', type: 'number', defaultValue: '${x}' },
          { id: 'g', type: 'number', defaultValue: '1.50' },
          { id: 'h', type: 'number', defaultValue: '1.0' },
          { id: 'i', type: 'number', defaultValue: '007' },
          { id: 'j', type: 'number', defaultValue: '0.5' },
          { id: 'k', type: 'number', defaultValue: '9007199254740993' },
        ],
      }),
      'formDefaultShape',
    );
    // A non-canonical number re-lexes but lowers to another text (`1.50` to
    // `1.5`), so it stays quoted. So does a value past `Number`'s safe
    // precision (`9007199254740993`, one above 2^53): the double rounds it
    // to `9007199254740992` before it ever reaches the printed literal.
    expect(formBlockLines(dsl)).toEqual([
      'a: boolean = "maybe"',
      'b: number = "1 + 1"',
      'c: number = "-3"',
      'd: number = 1.5',
      'e: boolean = true',
      'f: number = "${x}"',
      'g: number = "1.50"',
      'h: number = "1.0"',
      'i: number = "007"',
      'j: number = 0.5',
      'k: number = "9007199254740993"',
    ]);
  });
});

describe('irToDsl: engine attributes', () => {
  /**
   * One of every statement kind that carries engine settings, each carrying at
   * least one, plus a boundary handler whose escape chain is a
   * typed throw and a host-less handler.
   */
  const ENGINE_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    versionTag: '3.1',
    flowElements: [
      { kind: 'startEvent', id: 'S', asyncAfter: true },
      {
        kind: 'userTask',
        id: 'U',
        name: 'Review',
        assignee: 'ana',
        formKey: 'embedded:app:forms/r.html',
        candidateGroups: 'ops',
        candidateUsers: 'ana,bo',
        dueDate: '${due}',
        followUpDate: 'P1D',
        priority: '20',
        asyncBefore: true,
        exclusive: false,
        jobPriority: '50',
        retryCycle: 'R3/PT10M',
        formFields: [{ id: 'amount', type: 'number' }],
      },
      {
        kind: 'serviceTask',
        id: 'V',
        binding: exprBinding('${c.run(execution)}'),
        resultVariable: 'res',
        asyncBefore: true,
      },
      {
        kind: 'scriptTask',
        id: 'Sc',
        format: 'javascript',
        code: 'x = 1;\n',
        resultVariable: 'out',
        asyncAfter: true,
      },
      {
        kind: 'callActivity',
        id: 'C',
        calledElement: 'other',
        businessKey: 'bk',
        inMappings: [{ kind: 'all' }],
        asyncBefore: true,
      },
      {
        kind: 'subProcess',
        id: 'Sub',
        asyncBefore: true,
        flowElements: [{ kind: 'userTask', id: 'Inner' }],
        sequenceFlows: [],
      },
      {
        kind: 'intermediateCatchEvent',
        id: 'Catch_p_1',
        eventDefinition: timerDef('duration', 'PT1H'),
        asyncBefore: true,
      },
      {
        kind: 'intermediateThrowEvent',
        id: 'Throw_p_1',
        eventDefinition: escalationDef('ESC'),
        exclusive: false,
      },
      { kind: 'endEvent', id: 'E', asyncBefore: true },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_U_error',
        attachedToRef: 'U',
        eventDefinition: errorDef('BOOM'),
        asyncBefore: true,
      },
      {
        kind: 'endEvent',
        id: 'Failed',
        eventDefinition: errorDef('PF'),
        asyncAfter: true,
      },
      {
        kind: 'subProcess',
        id: 'H',
        triggeredByEvent: true,
        asyncBefore: true,
        flowElements: [
          typedEvent('startEvent', 'StartEvent_H', escalationDef('ESC')),
        ],
        sequenceFlows: [],
      },
    ],
    sequenceFlows: [
      { id: 'F1', sourceRef: 'S', targetRef: 'U' },
      { id: 'F2', sourceRef: 'U', targetRef: 'V' },
      { id: 'F3', sourceRef: 'V', targetRef: 'Sc' },
      { id: 'F4', sourceRef: 'Sc', targetRef: 'C' },
      { id: 'F5', sourceRef: 'C', targetRef: 'Sub' },
      { id: 'F6', sourceRef: 'Sub', targetRef: 'Catch_p_1' },
      { id: 'F7', sourceRef: 'Catch_p_1', targetRef: 'Throw_p_1' },
      { id: 'F8', sourceRef: 'Throw_p_1', targetRef: 'E' },
      { id: 'F9', sourceRef: 'Boundary_U_error', targetRef: 'Failed' },
    ],
  };

  it('renders the parens on every statement kind that takes them, in a fixed setting order', async () => {
    const dsl = await printed(ENGINE_IR);
    expect(dsl).toContain('start S(asyncAfter: true)');
    expect(dsl).toContain(
      'user U(label: "Review", assignee: "ana", ' +
        'formKey: "embedded:app:forms/r.html", candidateGroups: "ops", ' +
        'candidateUsers: "ana,bo", dueDate: "${due}", followUpDate: "P1D", ' +
        'priority: 20, asyncBefore: true, exclusive: false, jobPriority: 50, ' +
        'retryCycle: "R3/PT10M") {\n' +
        '    form {\n' +
        '      amount: number\n' +
        '    }\n' +
        '  }',
    );
    expect(dsl).toContain(
      'service V(expression: "${c.run(execution)}", resultVariable: "res", asyncBefore: true)',
    );
    expect(dsl).toContain(
      'script Sc(resultVariable: "out", asyncAfter: true) ```javascript',
    );
    expect(dsl).toContain(
      'call C(process: "other", businessKey: "bk", asyncBefore: true) {\n' +
        '    in *\n' +
        '  }',
    );
    expect(dsl).toContain('subprocess Sub(asyncBefore: true) {');
    expect(dsl).toContain('await timer("PT1H", asyncBefore: true)');
    expect(dsl).toContain('emit escalation(ESC, exclusive: false)');
    expect(dsl).toContain('end E(asyncBefore: true)');
    expect(dsl).toContain('throw error Failed(PF, asyncAfter: true)');

    // Both handler headers carry their settings before the body brace.
    expect(dsl).toContain('on U: error(BOOM, asyncBefore: true) {');
    expect(dsl).toContain('on escalation(ESC, asyncBefore: true) {');

    // The process carries its own settings the way every element does.
    expect(dsl).toContain('versionTag: "3.1"');
  });

  /** `S -> E` beside one timer handler whose start `startId` carries the timer job's three settings. */
  const timerHandler = (
    startId: string,
    subProcessSettings: JobSettings = {},
  ): BpmnProcess =>
    processIr(
      'p',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        {
          ...triggeredSub('EventSubProcess_p_1', [
            {
              kind: 'startEvent',
              id: startId,
              eventDefinition: timerDef('cycle', 'R/PT1H'),
              isInterrupting: false,
              exclusive: false,
              jobPriority: '5',
              retryCycle: 'R1/PT1M',
            },
            { kind: 'endEvent', id: 'EndEvent_EventSubProcess_p_1' },
          ]),
          ...subProcessSettings,
        },
      ],
      [edge('S', 'E')],
    );

  // Revert: leave the start's settings off the `on` head and the first two
  // rows print a `start StartEvent_...(...)` statement under a reserved id.
  it.each<[string, BpmnProcess, string[]]>([
    [
      "a synthesized start's timer-job settings print on the `on timer` head",
      timerHandler('StartEvent_EventSubProcess_p_1'),
      [
        '  on timer(every: "R/PT1H", exclusive: false, jobPriority: 5, retryCycle: "R1/PT1M", alongside) {',
        '  }',
      ],
    ],
    [
      "the sub-process's async flags print ahead of the start's timer-job settings",
      timerHandler('StartEvent_EventSubProcess_p_1', { asyncBefore: true }),
      [
        '  on timer(every: "R/PT1H", asyncBefore: true, exclusive: false, jobPriority: 5, retryCycle: "R1/PT1M", alongside) {',
        '  }',
      ],
    ],
    [
      'an authored start keeps them on its own statement',
      timerHandler('Tick'),
      [
        '  on timer(every: "R/PT1H", alongside) {',
        '    start Tick(exclusive: false, jobPriority: 5, retryCycle: "R1/PT1M")',
        '  }',
      ],
    ],
  ])('%s', async (_title, ir, handlerLines) => {
    const dsl = await printed(ir);
    // The handler closes the process: its lines sit above the final brace.
    expect(dsl.split('\n').slice(-2 - handlerLines.length, -2)).toEqual(
      handlerLines,
    );
    // The compiler puts the three back on the start either way.
    const back = (await reDesugar(dsl)).flowElements.find(
      (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
    );
    const start = back?.kind === 'subProcess' && only(back, 'startEvent');
    expect(
      start && {
        exclusive: start.exclusive,
        jobPriority: start.jobPriority,
        retryCycle: start.retryCycle,
      },
    ).toEqual({ exclusive: false, jobPriority: '5', retryCycle: 'R1/PT1M' });
  });

  it('prints neither parens nor braces for a node carrying no engine attributes', async () => {
    const dsl = await printed(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'U' },
          {
            kind: 'subProcess',
            id: 'Sub',
            flowElements: [{ kind: 'userTask', id: 'Inner' }],
            sequenceFlows: [],
          },
          typedEvent('intermediateCatchEvent', 'Catch_p_1', signalDef('Ping')),
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'U', 'Sub', 'Catch_p_1', 'E'),
      ),
    );
    expect(dsl).not.toContain('{ }');
    expect(dsl).not.toContain('()');
    expect(dsl).toContain('\n  start S\n');
    expect(dsl).toContain('\n  user U\n');
    expect(dsl).toContain('\n  await signal("Ping")\n');
    expect(dsl).toContain('\n  end E\n');
    expect(dsl).toContain('\n  subprocess Sub {\n');
  });

  it('prints booleans bare and only in their non-default direction', async () => {
    const dsl = await printed(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'A', asyncBefore: true, asyncAfter: true },
          { kind: 'userTask', id: 'B', exclusive: false },
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'A', 'B', 'E'),
      ),
    );
    expect(dsl).toContain('user A(asyncBefore: true, asyncAfter: true)');
    expect(dsl).toContain('user B(exclusive: false)');
    expect(dsl).not.toContain('"true"');
    expect(dsl).not.toContain('"false"');
  });

  it('prints an all-digit priority bare and any other value quoted, a #{ opening as written and padding trimmed so it re-lexes as a raw template', async () => {
    const dsl = await printed(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'A', jobPriority: '50', priority: '7' },
          {
            kind: 'userTask',
            id: 'B',
            jobPriority: '${order.rush}',
            priority: '${p}',
          },
          {
            kind: 'userTask',
            id: 'C',
            jobPriority: '#{order.rush}',
            priority: '  ${p}',
          },
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'A', 'B', 'C', 'E'),
      ),
    );
    expect(dsl).toContain('user A(priority: 7, jobPriority: 50)');
    expect(dsl).toContain(
      'user B(priority: "${p}", jobPriority: "${order.rush}")',
    );
    expect(dsl).toContain(
      'user C(priority: "${p}", jobPriority: "#{order.rush}")',
    );
  });
});

/**
 * A step whose two routes end apart, so neither branch has a join to walk to
 * and the one landing on the end keeps its edge as a jump.
 */
const jumpToEndIr = (
  end: Partial<Omit<Extract<FlowElement, { kind: 'endEvent' }>, 'kind'>>,
): BpmnProcess => {
  const { id = 'EndEvent_p', ...attrs } = end;
  return minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'endEvent', id, ...attrs },
      { kind: 'endEvent', id: 'E2' },
    ],
    [
      { id: 'F1', sourceRef: 'S', targetRef: 'A' },
      { id: 'F2', sourceRef: 'A', targetRef: id },
      { id: 'F3', sourceRef: 'A', targetRef: 'B' },
      { id: 'F4', sourceRef: 'B', targetRef: 'E2' },
    ],
  );
};

/**
 * A back edge to the start event: the loop cannot be recognized as a `while`,
 * so the edge is written as a jump, asking the same question on the other side
 * of the predicate.
 */
const backEdgeIr = (
  start: Partial<Omit<Extract<FlowElement, { kind: 'startEvent' }>, 'kind'>>,
): BpmnProcess => {
  const { id = 'StartEvent_p', ...attrs } = start;
  return minimalProcess(
    [
      { kind: 'startEvent', id, ...attrs },
      { kind: 'userTask', id: 'A' },
    ],
    flowChain(id, 'A', id),
  );
};

/** A listener is a further reason a synthesized terminal has something to print. */
const DONE_LISTENERS: ExecutionListener[] = [
  { event: 'end', binding: classBinding('com.example.Done') },
];

describe('irToDsl: whether a synthesized terminal prints', () => {
  // One row per arm of the shared printability predicate: content that cannot
  // be re-derived prints the statement and the jump resolves; anything else
  // elides the terminal and the edge takes the marker instead. `expected` is
  // the statement, or null for the elided arm.
  it.each([
    [
      'an engine attribute on an end',
      'end',
      { asyncBefore: true },
      'end EndEvent_p(asyncBefore: true)',
      ['mintedId'],
    ],
    [
      'a terminate on an end, which cannot be re-derived',
      'end',
      { eventDefinition: { kind: 'terminate' } },
      'end EndEvent_p terminate',
      ['mintedId'],
    ],
    [
      'a listener on an end',
      'end',
      { executionListeners: DONE_LISTENERS },
      'end EndEvent_p {\n    on end(class: "com.example.Done")\n  }',
      ['mintedId'],
    ],
    [
      "an id carrying another kind's synthesized prefix on an end, authored here",
      'end',
      { id: 'StartEvent_p' },
      'end StartEvent_p',
      ['mintedId'],
    ],
    ['nothing on an end', 'end', {}, null, []],
    [
      'a label alone on an end, a label not being printable content',
      'end',
      { name: 'Order Filed' },
      null,
      [],
    ],
    [
      'an engine attribute on a start',
      'start',
      { asyncBefore: true },
      'start StartEvent_p(asyncBefore: true)',
      ['mintedId'],
    ],
    [
      "an id carrying another kind's synthesized prefix on a start, authored here",
      'start',
      { id: 'EndEvent_p' },
      'start EndEvent_p',
      ['mintedId'],
    ],
    ['nothing on a start', 'start', {}, null, []],
    ['a label alone on a start', 'start', { name: 'Order Received' }, null, []],
  ] as const)(
    'carries %s',
    async (_title, side, payload, expected, refused) => {
      const id =
        'id' in payload
          ? payload.id
          : side === 'end'
            ? 'EndEvent_p'
            : 'StartEvent_p';
      const dsl = await printed(
        side === 'end' ? jumpToEndIr(payload) : backEdgeIr(payload),
        ...refused,
      );
      if (expected === null) {
        expect(dsl).not.toContain(`${side} ${id}`);
        expect(dsl).not.toContain(`goto ${id}`);
        if ('name' in payload) expect(dsl).not.toContain(payload.name);
        expect(dsl).toContain(`${UNSTRUCTURED_MARKER} (dropped edge into`);
      } else {
        expect(dsl).toContain(expected);
        expect(dsl).toContain(`goto ${id}`);
        expect(dsl).not.toContain('dropped edge');
      }
    },
  );
});

describe('irToDsl: input/output parameters', () => {
  it('prints every value form, inputs before outputs, in IR order', async () => {
    const dsl = await printed(
      around({
        kind: 'serviceTask',
        id: 'V',
        binding: externalBinding('charge'),
        inputParameters: [
          ioParam('plain', textValue('ready')),
          ioParam('expr', textValue('${order.id}')),
          ioParam('items', listValue([])),
        ],
        outputParameters: [
          ioParam('code', textValue('200')),
          ioParam('blank', mapValue([])),
        ],
      }),
    );
    expect(dsl).toContain(
      'service V(topic: "charge") {\n' +
        '    input plain = "ready"\n' +
        '    input expr = "${order.id}"\n' +
        '    input items = []\n' +
        '    output code = "200"\n' +
        '    output blank = {}\n' +
        '  }',
    );
  });

  it('nests a map inside a list and a list inside a map, keeping a keyword-shaped key quoted', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        inputParameters: [
          ioParam(
            'rows',
            listValue([
              textValue('a'),
              mapValue([
                mapEntry('k', textValue('v')),
                // `end` is a statement keyword, so it never lexes as an
                // identifier: only the quoted spelling survives re-parsing.
                mapEntry('end', textValue('z')),
              ]),
            ]),
          ),
          ioParam(
            'lookup',
            mapValue([
              mapEntry('ids', listValue([textValue('x')])),
              mapEntry('with space', textValue('w')),
            ]),
          ),
        ],
      }),
    );
    expect(dsl).toContain(
      'user U {\n' +
        '    input rows = ["a", { "k": "v", "end": "z" }]\n' +
        '    input lookup = { "ids": ["x"], "with space": "w" }\n' +
        '  }',
    );
  });

  it.each([
    [
      'an expression map key escapes its opener so it re-lexes as the literal it is',
      mapValue([
        mapEntry('${dyn}', textValue('v')),
        mapEntry('#{other}', textValue('w')),
      ]),
      '{ "\\${dyn}": "v", "\\#{other}": "w" }',
    ],
    [
      'a value with a line break prints on one line',
      textValue('l1\nl2'),
      '"l1\\nl2"',
    ],
    [
      'a raw template with a quote inside escapes it once',
      textValue('${fn("a")}'),
      '"${fn(\\"a\\")}"',
    ],
    ['a #{ template prints as written', textValue('#{x}'), '"#{x}"'],
  ] as const)('%s', async (_title, value, expected) => {
    const ir = around({
      kind: 'userTask',
      id: 'U',
      inputParameters: [ioParam('v', value)],
    });
    const dsl = await printed(ir);
    expect(dsl).toContain(`input v = ${expected}`);
    const task = byId(await reDesugar(dsl), 'U');
    expect(task.kind === 'userTask' && task.inputParameters).toEqual([
      ioParam('v', value),
    ]);
  });

  it('prints a script value as a fenced block carrying its format', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        inputParameters: [
          ioParam('total', scriptValue('groovy', 'sum(a, b)\n')),
        ],
      }),
    );
    expect(dsl).toContain(
      'user U {\n    input total = ```groovy\nsum(a, b)\n```\n  }',
    );
  });

  it('keeps a script task readable with a fenced value among its members', async () => {
    const dsl = await printed(
      around({
        kind: 'scriptTask',
        id: 'Sc',
        format: 'javascript',
        code: 'x = 1;\n',
        inputParameters: [ioParam('seed', scriptValue('groovy', 'seed()\n'))],
      }),
    );
    expect(dsl).toContain(
      'script Sc {\n' +
        '    input seed = ```groovy\nseed()\n```\n' +
        '  } ```javascript\nx = 1;\n```',
    );
  });

  it('prints the members before the body on a sub-process and before the mappings on a call', async () => {
    const dsl = await printed(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          {
            kind: 'subProcess',
            id: 'Sub',
            inputParameters: [
              ioParam('seed', textValue('1')),
              ioParam('extra', mapValue([])),
            ],
            flowElements: [{ kind: 'userTask', id: 'Inner' }],
            sequenceFlows: [],
          },
          {
            kind: 'callActivity',
            id: 'C',
            calledElement: 'other',
            outputParameters: [ioParam('total', textValue('${sum}'))],
            inMappings: [{ kind: 'all' }],
          },
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'Sub', 'C', 'E'),
      ),
    );
    // An empty map ending the members puts `{}` `}` `{` in a row, the sequence
    // the body brace has to be told apart from.
    expect(dsl).toContain(
      'subprocess Sub {\n' +
        '    input seed = "1"\n' +
        '    input extra = {}\n' +
        '  } {',
    );
    expect(dsl).toContain(
      'call C(process: "other") {\n' +
        '    output total = "${sum}"\n' +
        '    in *\n' +
        '  }',
    );
  });
});

describe('irToDsl: listeners', () => {
  it('prints each binding form, execution listeners before task listeners', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.Enter') },
          { event: 'end', binding: exprBinding('${audit.log()}') },
        ],
        taskListeners: [
          { event: 'create', binding: delegateBinding('${assignHook}') },
        ],
      }),
    );
    expect(dsl).toContain(
      'user U {\n' +
        '    on start(class: "com.example.Enter")\n' +
        '    on end(expression: "${audit.log()}")\n' +
        '    on create(delegate: "${assignHook}")\n' +
        '  }',
    );
  });

  it('prints a script-bound listener as a fenced block', async () => {
    const dsl = await printed(
      around({
        kind: 'serviceTask',
        id: 'V',
        binding: classBinding('com.example.C'),
        executionListeners: [
          { event: 'end', binding: scriptValue('groovy', "println 'bye'\n") },
        ],
      }),
    );
    expect(dsl).toContain(
      'service V(class: "com.example.C") {\n' +
        '    on end ```groovy\n' +
        "println 'bye'\n" +
        '```\n' +
        '  }',
    );
  });

  it('carries a timeout listener timer through the timer particle', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        taskListeners: [
          {
            event: 'timeout',
            binding: classBinding('com.example.T'),
            timer: timerDef('duration', 'PT1H'),
          },
          {
            event: 'timeout',
            binding: classBinding('com.example.D'),
            timer: timerDef('date', '${deadline}'),
          },
        ],
      }),
    );
    expect(dsl).toContain(
      'user U {\n' +
        '    on timeout after "PT1H"(class: "com.example.T")\n' +
        '    on timeout at "${deadline}"(class: "com.example.D")\n' +
        '  }',
    );
  });

  it('prints an execution listener on a handler header and an awaited event', async () => {
    const dsl = await printed(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          {
            kind: 'intermediateCatchEvent',
            id: 'Catch_p_1',
            eventDefinition: signalDef('Ping'),
            executionListeners: [
              { event: 'start', binding: classBinding('com.example.W') },
            ],
          },
          { kind: 'endEvent', id: 'E' },
          {
            kind: 'subProcess',
            id: 'H',
            triggeredByEvent: true,
            executionListeners: [
              { event: 'end', binding: classBinding('com.example.H') },
            ],
            flowElements: [
              typedEvent('startEvent', 'StartEvent_H', escalationDef('ESC')),
            ],
            sequenceFlows: [],
          },
        ],
        flowChain('S', 'Catch_p_1', 'E'),
      ),
    );
    expect(dsl).toContain(
      'await signal("Ping") {\n    on start(class: "com.example.W")\n  }',
    );
    expect(dsl).toContain(
      'on escalation(ESC) {\n    on end(class: "com.example.H")\n  } {',
    );
  });

  it('prints the settings in the parens and the form, the parameters and the listeners in the braces, in one fixed order', async () => {
    const dsl = await printed(
      around({
        kind: 'userTask',
        id: 'U',
        name: 'Review',
        assignee: 'ana',
        asyncBefore: true,
        inputParameters: [ioParam('seed', textValue('1'))],
        outputParameters: [ioParam('note', textValue('${n}'))],
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.Enter') },
        ],
        taskListeners: [
          { event: 'complete', binding: classBinding('com.example.Done') },
        ],
        formFields: [{ id: 'amount', type: 'number' }],
      }),
    );
    expect(dsl).toContain(
      'user U(label: "Review", assignee: "ana", asyncBefore: true) {\n' +
        '    form {\n' +
        '      amount: number\n' +
        '    }\n' +
        '    input seed = "1"\n' +
        '    output note = "${n}"\n' +
        '    on start(class: "com.example.Enter")\n' +
        '    on complete(class: "com.example.Done")\n' +
        '  }',
    );
  });
});

describe('irToDsl: field injection and form references', () => {
  /**
   * `printed` is the whole point of the assertion: a field or a form reference
   * printed where the compiler refuses it would still read fine as text.
   */
  it('prints a field before the io parameters on every carrier, and a form reference beside its binding', async () => {
    const dsl = await printed(
      chained([
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'serviceTask',
          id: 'Ship',
          binding: {
            kind: 'class',
            className: 'com.example.Ship',
            fields: [
              { name: 'greeting', value: 'hello' },
              { name: 'target', value: '${order.address}' },
            ],
          },
          inputParameters: [ioParam('amount', textValue('${total}'))],
          executionListeners: [
            {
              event: 'start',
              binding: {
                kind: 'delegateExpression',
                expression: '${auditHook}',
                fields: [{ name: 'level', value: 'INFO' }],
              },
            },
          ],
        },
        {
          kind: 'userTask',
          id: 'Review',
          formRef: {
            key: 'review-form',
            binding: { kind: 'version', version: '3' },
          },
          taskListeners: [
            {
              event: 'create',
              binding: {
                kind: 'class',
                className: 'com.example.Assign',
                fields: [{ name: 'role', value: 'clerk' }],
              },
            },
          ],
        },
        { kind: 'endEvent', id: 'E' },
      ]),
    );

    expect(dsl).toContain(
      '  service Ship(class: "com.example.Ship") {\n' +
        '    field greeting = "hello"\n' +
        '    field target = "${order.address}"\n' +
        '    input amount = "${total}"\n' +
        '    on start(delegate: "${auditHook}") {\n' +
        '      field level = "INFO"\n' +
        '    }\n' +
        '  }\n' +
        '  user Review(formRef: "review-form", version: 3) {\n' +
        '    on create(class: "com.example.Assign") {\n' +
        '      field role = "clerk"\n' +
        '    }\n' +
        '  }\n',
    );
  });

  it('prints binding: latest and binding: deployment for the two unpinned form bindings', async () => {
    const printedWith = async (binding: VersionBinding): Promise<string> =>
      printed(
        around({
          kind: 'userTask',
          id: 'Review',
          formRef: { key: 'review-form', binding },
        }),
      );

    expect([
      await printedWith({ kind: 'latest' }),
      await printedWith({ kind: 'deployment' }),
    ]).toEqual([
      expect.stringContaining(
        'user Review(formRef: "review-form", binding: latest)',
      ),
      expect.stringContaining(
        'user Review(formRef: "review-form", binding: deployment)',
      ),
    ]);
  });
});

describe('irToDsl: repeated activities', () => {
  const OVER_LINES: LoopCharacteristics = {
    collection: 'lines',
    elementVariable: 'line',
  };

  /** The kinds that carry a loop; anything else here is a compile error. */
  type RepeatableElement = Extract<
    FlowElement,
    {
      kind:
        | 'task'
        | 'userTask'
        | 'serviceTask'
        | 'scriptTask'
        | 'receiveTask'
        | 'subProcess'
        | 'callActivity';
    }
  >;

  /** Print one repeated element, wired `S -> el -> E`, with its settings. */
  const printRepeated = (
    el: RepeatableElement,
    loop: LoopCharacteristics,
  ): string => irToDsl(around({ ...el, asyncBefore: true, loop }));

  /** Every kind that can repeat: the head its clause follows, its settings, and what closes the statement. */
  const KINDS = [
    [
      { kind: 'task', id: 'Record', name: 'Record it' },
      'step Record',
      'label: "Record it", asyncBefore: true',
      '',
    ],
    [
      { kind: 'userTask', id: 'Approve', name: 'Approve it' },
      'user Approve',
      'label: "Approve it", asyncBefore: true',
      '',
    ],
    [
      {
        kind: 'serviceTask',
        id: 'Notify',
        name: 'Notify them',
        element: 'send',
        binding: classBinding('com.example.Notify'),
      },
      'send Notify',
      'label: "Notify them", class: "com.example.Notify", asyncBefore: true',
      '',
    ],
    [
      {
        kind: 'scriptTask',
        id: 'Compute',
        name: 'Compute it',
        format: 'javascript',
        code: 'x = 1',
      },
      'script Compute',
      'label: "Compute it", asyncBefore: true',
      ' ```javascript',
    ],
    [
      {
        kind: 'receiveTask',
        id: 'Wait',
        name: 'Wait for it',
        messageName: 'OrderPaid',
      },
      'receive Wait',
      'label: "Wait for it", message: "OrderPaid", asyncBefore: true',
      '',
    ],
    [
      {
        ...chainedSub('Fulfil', [
          {
            kind: 'serviceTask',
            id: 'Pick',
            binding: classBinding('com.example.Pick'),
          },
        ]),
        name: 'Fulfil it',
      },
      'subprocess Fulfil',
      'label: "Fulfil it", asyncBefore: true',
      ' {',
    ],
    [
      {
        kind: 'callActivity',
        id: 'Regional',
        name: 'Run it',
        calledElement: 'regional-report',
      },
      'call Regional',
      'label: "Run it", process: "regional-report", asyncBefore: true',
      '',
    ],
  ] as const satisfies ReadonlyArray<
    readonly [RepeatableElement, string, string, string]
  >;

  it.each(KINDS)(
    'prints the clause between the name and the settings of %#',
    (el, head, settings, tail) => {
      expect(printRepeated(el, OVER_LINES)).toContain(
        `${head} for each line in lines(${settings})${tail}`,
      );
    },
  );

  it.each(KINDS)(
    'leaves %# untouched when it carries no loop',
    (el, head, settings, tail) => {
      expect(irToDsl(around({ ...el, asyncBefore: true }))).toContain(
        `${head}(${settings})${tail}`,
      );
    },
  );

  it.each([
    [
      { collection: 'lines', elementVariable: 'line' },
      'for each line in lines',
    ],
    [{ collection: 'lines' }, 'for each in lines'],
    [{ collection: 'check-close' }, 'for each in check-close'],
    [
      { collection: '${order.lines}', elementVariable: 'line' },
      'for each line in "${order.lines}"',
    ],
    [{ cardinality: '3' }, 'for 3'],
    [{ cardinality: '${n}' }, 'for n'],
    [{ cardinality: '#{lineCount}' }, 'for lineCount'],
    [{ cardinality: '${a} #{b}' }, 'for "${a} #{b}"'],
    [
      { cardinality: '3', collection: 'lines', elementVariable: 'line' },
      'for 3 each line in lines',
    ],
    [
      { collection: 'lines', elementVariable: 'line', sequential: true },
      'for each line in lines sequentially',
    ],
    [
      {
        collection: 'lines',
        elementVariable: 'line',
        sequential: true,
        completionCondition: '${nrOfCompletedInstances >= 2}',
      },
      'for each line in lines sequentially until (nrOfCompletedInstances >= 2)',
    ],
  ] as const satisfies ReadonlyArray<readonly [LoopCharacteristics, string]>)(
    'prints %j as `%s`',
    (loop, clause) => {
      expect(printRepeated({ kind: 'task', id: 'Record' }, loop)).toContain(
        `step Record ${clause}(asyncBefore: true)`,
      );
    },
  );

  // A bare collection needs a declaration to lower back; anything the source
  // already types, or that is no name at all, must not get a second one.
  it.each([
    [
      'declares every bare collection once, at any depth',
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'task', id: 'Record', loop: OVER_LINES },
          { kind: 'task', id: 'Price', loop: OVER_LINES },
          chainedSub('Fulfil', [
            {
              kind: 'task',
              id: 'Pick',
              loop: { collection: 'parcels', elementVariable: 'parcel' },
            },
          ]),
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'Record', 'Price', 'Fulfil', 'E'),
      ),
      ['process p {\n  var lines: any\n  var parcels: any\n'],
      [],
      1,
    ],
    [
      'declares neither the element it binds nor a collection expression',
      around({
        kind: 'task',
        id: 'Record',
        loop: { collection: '${order.lines}', elementVariable: 'line' },
      }),
      [],
      ['var '],
      0,
    ],
    [
      'leaves a collection a form field already types undeclared',
      minimalProcess(
        [
          {
            kind: 'startEvent',
            id: 'S',
            formFields: [{ id: 'lines', type: 'string' }],
          },
          { kind: 'task', id: 'Record', loop: OVER_LINES },
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'Record', 'E'),
      ),
      ['form {\n      lines: string\n    }'],
      ['var lines'],
      0,
    ],
    [
      'leaves a collection a catch binding already types undeclared',
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'task', id: 'Record', loop: { collection: 'c' } },
          { kind: 'task', id: 'Note', loop: { collection: 'm' } },
          { kind: 'task', id: 'Escalate', loop: { collection: 'x' } },
          { kind: 'endEvent', id: 'E' },
          eventHandler(
            'H',
            'HS',
            errorDef('BOOM', { codeVariable: 'c', messageVariable: 'm' }),
          ),
          eventHandler('G', 'GS', escalationDef('OVER', 'x')),
        ],
        flowChain('S', 'Record', 'Note', 'Escalate', 'E'),
      ),
      ['on error(BOOM, code: c, message: m)', 'on escalation(OVER, code: x)'],
      ['var '],
      0,
    ],
  ] as const)('%s', async (_title, ir, has, hasNot, declarations) => {
    const dsl = await printed(ir);
    for (const text of has) expect(dsl).toContain(text);
    for (const text of hasNot) expect(dsl).not.toContain(text);
    expect(dsl.match(/var lines: any/g) ?? []).toHaveLength(declarations);
  });
});

// BPMN has no slot for `var`, so the print declares what the body reads bare:
// every root the validator would otherwise report as undeclared, and nothing
// a form field, a catch binding, an io parameter, an element variable or a
// repetition's engine counters already type.
describe('irToDsl: the header declares every variable the body reads bare', () => {
  it('declares each bare read once, typed any, in the order it appears', async () => {
    const ir = minimalProcess(
      [
        {
          kind: 'startEvent',
          id: 'S',
          formFields: [{ id: 'approved', type: 'boolean' }],
        },
        {
          kind: 'task',
          id: 'Batch',
          loop: {
            cardinality: '${count}',
            completionCondition: '${nrOfCompletedInstances > 1}',
          },
        },
        {
          ...callActivity('Sub', 'sub'),
          inMappings: [{ kind: 'variable', source: 'source', target: 'y' }],
          outMappings: [{ kind: 'variable', source: 'result', target: 'z' }],
        },
        {
          ...serviceTask('Fetch', {
            kind: 'external',
            topic: 't',
            errorMappings: [
              {
                errorCode: 'FAIL',
                condition: '${externalTask.retries > 2 && flag}',
              },
            ],
          }),
          outputParameters: [ioParam('x', textValue('1'))],
        },
        boundaryEvent(
          'Boundary_Fetch_error',
          'Fetch',
          errorDef('FAIL', { codeVariable: 'c' }),
        ),
        { kind: 'userTask', id: 'Repair' },
        { kind: 'endEvent', id: 'Failed' },
        typedEvent(
          'intermediateCatchEvent',
          'Wait',
          conditionDef('${x && c == "FAIL"}'),
        ),
        gateway('G', 'F_else'),
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        gateway('J'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        ...flowChain('S', 'Batch', 'Sub', 'Fetch', 'Wait', 'G'),
        edge('Boundary_Fetch_error', 'Repair'),
        edge('Repair', 'Failed'),
        edge('G', 'A', { condition: '${approved}' }),
        edge('G', 'B', { id: 'F_else' }),
        edge('A', 'J'),
        edge('B', 'J'),
        edge('J', 'E'),
      ],
    );

    const dsl = await printed(ir);
    expect(dsl.split('\n').filter((line) => line.startsWith('  var '))).toEqual(
      ['  var count: any', '  var source: any', '  var flag: any'],
    );
    const { diagnostics } = await validate(dsl);
    expect(diagnostics.map((d) => d.message)).toEqual([]);
  });
});

/**
 * The four settings a repetition writes on the loop element itself
 * (`runAsyncBefore`, `runAsyncAfter`, `runExclusive`, `runRetryCycle`) sit in
 * the same parens as the statement's own, after them, and read back onto the
 * loop rather than the step.
 */
describe('irToDsl: per-run settings on a repetition', () => {
  const RUN_LOOP: LoopCharacteristics = {
    cardinality: '3',
    asyncBefore: true,
    asyncAfter: true,
    exclusive: false,
    retryCycle: 'R2/PT1M',
  };

  it.each([
    [
      "a service's run keys follow its own settings",
      {
        ...serviceTask(
          'WarmPricing',
          classBinding('com.example.WarmPricingDelegate'),
        ),
        asyncBefore: true,
        retryCycle: 'R3/PT10M',
        loop: RUN_LOOP,
      },
      'service WarmPricing for 3(class: "com.example.WarmPricingDelegate", ' +
        'asyncBefore: true, retryCycle: "R3/PT10M", runAsyncBefore: true, ' +
        'runAsyncAfter: true, runExclusive: false, runRetryCycle: "R2/PT1M")',
    ],
    [
      "a subprocess's run keys follow its own settings",
      {
        ...chainedSub('Fulfil', [{ kind: 'userTask', id: 'Inner' }]),
        asyncBefore: true,
        retryCycle: 'R3/PT10M',
        loop: RUN_LOOP,
      },
      'subprocess Fulfil for 3(asyncBefore: true, retryCycle: "R3/PT10M", ' +
        'runAsyncBefore: true, runAsyncAfter: true, runExclusive: false, ' +
        'runRetryCycle: "R2/PT1M") {',
    ],
  ] as const)('%s and read back onto the loop', async (_title, el, head) => {
    const dsl = await printed(around(el));
    expect(dsl).toContain(head);
    const back = (await reDesugar(dsl)).flowElements.find(
      (e): e is Extract<FlowElement, Repeatable> => e.id === el.id,
    )!;
    expect(back.loop).toEqual(RUN_LOOP);
    expect([back.asyncBefore, back.retryCycle]).toEqual([true, 'R3/PT10M']);
  });
});

/**
 * A prose setting is read back as text rather than evaluated, so the printer's
 * escaping and the lexer's unescaping have to be exact inverses over every
 * input a modeler can type. The adversarial rows are the ones a quoted body
 * opening with `${` reaches: that body lexes as a raw expression, and the
 * reader unwrapping one strips the quotes without unescaping, so every escape
 * inside it would come back as two characters.
 *
 * Re-parsing through the compiler is the assertion, not the printed text: text
 * that looks right and lexes differently is the whole failure being guarded.
 */
describe('irToDsl: prose comes back byte for byte', () => {
  /** Each shape, the prose, and whether printing it needs a backslash at all. */
  const PROSE = [
    ['plain prose', 'Review the order', false],
    ['prose holding a quote', 'Review the "rush" order', true],
    ['prose holding a backslash', 'Review C:\\orders\\rush', true],
    ['prose opening with a template', '${orderId} is the reference', true],
    ['prose holding a template', 'Reference ${orderId} was confirmed', false],
    ['prose opening with a bare dollar', '$50 is the threshold', false],
    ['prose spanning two lines', 'Review the order.\nThen release it.', true],
    ['prose holding a carriage return', 'Review the order.\rNow.', true],
    [
      'prose spanning two lines the way a text editor ends them',
      'Review the order.\r\nThen release it.',
      true,
    ],
    [
      'prose opening with a template and holding a quote',
      '${orderId} is the "rush" reference',
      true,
    ],
    [
      'prose opening with a template and spanning two lines',
      '${orderId}\nis the reference',
      true,
    ],
  ] as const;

  /** Each prose setting and the IR field it is written from. */
  const SLOTS = [
    ['label', 'name'],
    ['documentation', 'documentation'],
  ] as const;

  it.each(
    PROSE.flatMap(([shape, text, escapes]) =>
      SLOTS.map(
        ([setting, field]) =>
          [`${setting}, ${shape}`, field, text, escapes] as const,
      ),
    ),
  )('%s', async (_title, field, text, escapes) => {
    const carrying = (
      value: string,
    ): { name?: string; documentation?: string } =>
      field === 'name' ? { name: value } : { documentation: value };
    const print = (value: string): Promise<string> =>
      printed(around({ kind: 'userTask', id: 'Review', ...carrying(value) }));

    const dsl = await print(text);
    // A statement prints on one line whatever its prose holds, which is what
    // keeps the indentation of an enclosing block meaningful. Splitting on a
    // lone carriage return too, since a raw one breaks a line for every reader
    // of the file without breaking it for this test.
    expect(dsl.split(/\r\n|\r|\n/)).toHaveLength(
      (await print('Review the order')).split(/\r\n|\r|\n/).length,
    );
    // An escape no terminal asks for is noise in source somebody reads.
    expect(dsl.includes('\\')).toBe(escapes);

    const back = await reDesugar(dsl);
    const [review] = back.flowElements.filter(
      (el): el is Extract<FlowElement, { kind: 'userTask' }> =>
        el.kind === 'userTask',
    );
    expect({
      name: review?.name,
      documentation: review?.documentation,
    }).toEqual({
      name: undefined,
      documentation: undefined,
      ...carrying(text),
    });
  });
});

// `printDsl` is the real entry point; the alias above unwraps `.source` for
// every suite that only asserts printed text.

/**
 * What each report says, keyed by the degradation it reports. `says` is every
 * phrase its message must carry; `never` is the phrase of a neighbouring report
 * it must not, which is what keeps two of them from collapsing into one.
 */
const REPORT = {
  label: { category: 'label', says: ['block structure'] },
  documentation: {
    category: 'documentation',
    says: ['block structure', 'carry it'],
    // The two facts are reported apart, so neither message may state the other.
    never: ['The label'],
  },
  refusedStatement: {
    category: 'refusedStatement',
    says: ['draws an error', 'Rename the step in the model'],
  },
  droppedEdge: {
    category: 'droppedEdge',
    says: ['unstructured region', 'hand-repair'],
  },
  degradedSplit: {
    category: 'degradedSplit',
    says: [
      'leaves as a jump',
      'or as a marker',
      'written on its jump',
      'at most one branch is left running',
    ],
  },
  emptySplit: {
    category: 'degradedSplit',
    says: ['no route out', 'left out of the script'],
  },
  crossBranchJump: {
    category: 'refusedStatement',
    says: ['crosses', 'draws an error'],
    // The reserved-name report's remedy, which renames nothing here.
    never: ['Rename the step'],
  },
  inventedFallback: {
    category: 'defaultFlow',
    says: ['names no fallback', 'what runs changes'],
  },
  raceCondition: {
    category: 'droppedCondition',
    says: [
      'weighs a branch of this wait',
      'takes the first to resolve',
      'the run is the same without it',
    ],
    never: ['stops the run with an error'],
  },
  droppedFlowCondition: {
    category: 'droppedCondition',
    says: ['stops the run with an error', 'carries straight on'],
  },
  divertedRun: {
    category: 'droppedCondition',
    says: ['leaves by another route'],
    never: ['stops the run with an error'],
  },
  unweighedBranch: {
    category: 'droppedCondition',
    says: ['takes every route', 'the run is the same without it'],
    never: ['stops the run'],
  },
  forkFallbackCondition: {
    category: 'defaultFlow',
    says: ['weighs the fallback', 'the run is the same without it'],
    never: ['stops the run'],
  },
  choiceFallbackCondition: {
    category: 'defaultFlow',
    says: ['weighs the fallback', 'refuses to deploy'],
    // What a fork that opens every branch reads instead: weighing the fallback
    // of a choice is what the engine refuses, so the run is not the same.
    never: ['the run is the same without it'],
  },
  deadFallback: {
    category: 'defaultFlow',
    says: ['nothing is ever left over', 'draws an error'],
  },
  droppedSetting: {
    category: 'droppedSetting',
    says: ['engine settings', 'block structure', 'runs without them'],
  },
  renamedId: {
    category: 'renamedId',
    says: ['written as', 'activity id'],
  },
} as const satisfies Record<
  string,
  {
    category: PrintWarning['category'];
    says: readonly string[];
    never?: readonly string[];
  }
>;

/** BPMN vocabulary no report may spend on a reader who never drew a diagram. */
const JARGON = ['flow node', 'gateway', 'token', 'sequence flow'];

/**
 * Assert the reports raised, in order: one `[report, elementId]` per warning,
 * each matched on category, element, every phrase its report says, every phrase
 * it must not, and the plain-words rule.
 */
function expectReports(
  warnings: readonly PrintWarning[],
  ...expected: readonly (readonly [keyof typeof REPORT, string])[]
): void {
  expect(warnings.map((w) => [w.category, w.elementId])).toEqual(
    expected.map(([name, id]) => [REPORT[name].category, id]),
  );
  expected.forEach(([name], i) => {
    const report: { says: readonly string[]; never?: readonly string[] } =
      REPORT[name];
    const { message } = warnings[i]!;
    for (const phrase of report.says) expect(message).toContain(phrase);
    for (const phrase of report.never ?? []) {
      expect(message, `${name} must not say "${phrase}"`).not.toContain(phrase);
    }
    for (const word of JARGON) {
      expect(
        message.toLowerCase(),
        `${name} must not use "${word}": ${message}`,
      ).not.toContain(word);
    }
  });
}

/** How a route is written where the test cares: its flow id, its condition. */
type Route = { id?: string; condition?: string };

/**
 * A review loop closed by a second split: the head takes the body under
 * `${again}`, the body runs into `split`, and the split routes back round the
 * loop or on to the end. `back` and `on` name and weigh those two routes.
 */
const loopIntoSplitIr = (
  split: FlowElement,
  back: Route,
  on: Route,
): BpmnProcess =>
  minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Loop'),
      { kind: 'userTask', id: 'Review' },
      split,
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Loop'),
      edge('Loop', 'Review', { condition: '${again}' }),
      edge('Review', split.id),
      edge(split.id, 'Loop', back),
      edge(split.id, 'E', on),
      edge('Loop', 'E'),
    ],
  );

/**
 * A loop and the weighed escapes beside the route round it. `shape` puts the
 * head before the body (a `while`) or after it (a `do`); `back` names and
 * weighs the route round the loop; each escape leaves the head for a step of
 * its own, which then ends the run.
 */
const loopWithEscapesIr = ({
  shape = 'pre',
  head,
  body,
  back,
  escapes,
}: {
  shape?: 'pre' | 'post';
  head: FlowElement;
  body: string;
  back: Route;
  escapes: readonly (readonly [string, string])[];
}): BpmnProcess => {
  const pre = shape === 'pre';
  return minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      ...(pre ? [head] : []),
      { kind: 'userTask', id: body },
      ...(pre ? [] : [head]),
      ...escapes.map(([id]): FlowElement => ({ kind: 'userTask', id })),
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', pre ? head.id : body),
      pre ? edge(head.id, body, back) : edge(body, head.id),
      pre ? edge(body, head.id) : edge(head.id, body, back),
      ...escapes.map(([id, condition]) => edge(head.id, id, { condition })),
      ...escapes.map(([id]) => edge(id, 'E')),
    ],
  );
};

describe('warnings: text the script has nowhere to write', () => {
  const splitIr = (name?: string): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'exclusiveGateway',
          id: 'Split_1',
          ...(name === undefined ? {} : { name }),
        },
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'exclusiveGateway', id: 'Join_1' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Split_1'),
        edge('Split_1', 'A', { condition: 'ok' }),
        edge('Split_1', 'B'),
        edge('A', 'Join_1'),
        edge('B', 'Join_1'),
        edge('Join_1', 'E'),
      ],
    );

  it('reports the label on a split, says nothing about a split without one, and leaves the printed source alone', () => {
    const named = printDsl(splitIr('Amount check'));
    const plain = printDsl(splitIr());

    expect(named.source).toBe(plain.source);
    expect(plain.warnings).toEqual([]);
    expectReports(named.warnings, ['label', 'Split_1']);
    expect(named.warnings[0]?.message).toContain("'Amount check'");
  });

  const forkIr = (named: 'fork' | 'join'): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'parallelGateway',
          id: 'Fork_1',
          ...(named === 'fork' ? { name: 'Split work' } : {}),
        },
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        {
          kind: 'parallelGateway',
          id: 'Join_1',
          ...(named === 'join' ? { name: 'Split work' } : {}),
        },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Fork_1'),
        edge('Fork_1', 'A'),
        edge('Fork_1', 'B'),
        edge('A', 'Join_1'),
        edge('B', 'Join_1'),
        edge('Join_1', 'E'),
      ],
    );

  it.each([
    ['fork', 'Fork_1'],
    ['join', 'Join_1'],
  ] as const)('reports the label on a parallel %s', (which, id) => {
    expectReports(printDsl(forkIr(which)).warnings, ['label', id]);
  });

  it('reaches a split nested in a sub-process and one in an event handler', () => {
    const { warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          chainedSub('Sub', [
            { kind: 'startEvent', id: 'NS' },
            { kind: 'exclusiveGateway', id: 'NSplit', name: 'nested pick' },
            { kind: 'endEvent', id: 'NE' },
          ]),
          { kind: 'endEvent', id: 'E' },
          triggeredSub('H', [
            { kind: 'startEvent', id: 'HS', eventDefinition: signalDef('go') },
            { kind: 'exclusiveGateway', id: 'HSplit', name: 'handler pick' },
            { kind: 'endEvent', id: 'HE' },
          ]),
        ],
        flowChain('S', 'Sub', 'E'),
      ),
    );

    expectReports(warnings, ['label', 'NSplit'], ['label', 'HSplit']);
  });

  /**
   * Every gateway here has one way in and one way out, so all of them are
   * walked straight through and the printed source is the same whether they
   * carry text or not.
   */
  const gatewayTextIr = (carried: boolean): BpmnProcess => {
    const text = (documentation: string) => (carried ? { documentation } : {});
    return minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'exclusiveGateway',
          id: 'Choice',
          ...(carried ? { name: 'Amount check' } : {}),
          ...text('Small orders skip the review.'),
        },
        { kind: 'parallelGateway', id: 'Fork', ...text('Both routes run.') },
        {
          kind: 'inclusiveGateway',
          id: 'Some',
          ...text('Whichever conditions hold.'),
        },
        { kind: 'eventBasedGateway', id: 'Race', ...text('First reply wins.') },
        chainedSub('Sub', [
          { kind: 'startEvent', id: 'NS' },
          {
            kind: 'exclusiveGateway',
            id: 'Nested',
            ...text('Nested, and reported all the same.'),
          },
          { kind: 'endEvent', id: 'NE' },
        ]),
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'Choice', 'Fork', 'Some', 'Race', 'Sub', 'E'),
    );
  };

  it('reports the documentation on every gateway kind, at any depth, and leaves the printed source alone', () => {
    const carried = printDsl(gatewayTextIr(true));
    const plain = printDsl(gatewayTextIr(false));

    expect(carried.source).toBe(plain.source);
    expect(plain.warnings).toEqual([]);
    expectReports(
      carried.warnings,
      ['label', 'Choice'],
      ['documentation', 'Choice'],
      ['documentation', 'Fork'],
      ['documentation', 'Some'],
      ['documentation', 'Race'],
      ['documentation', 'Nested'],
    );
  });
});

describe('warnings: edges with no form in the script', () => {
  /** A back-edge into a fork whose out-edges are all consumed by then. */
  const DROPPED_EDGE_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'parallelGateway', id: 'Gateway_d_1_fork' },
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_d_1_fork'),
      edge('Gateway_d_1_fork', 'A'),
      edge('Gateway_d_1_fork', 'B'),
      edge('A', 'E'),
      edge('B', 'Gateway_d_1_fork'),
    ],
  );

  it('reports the dropped edge and still prints the marker comment', () => {
    const { source, warnings } = printDsl(DROPPED_EDGE_IR);

    expect(source).toContain(UNSTRUCTURED_MARKER);
    expectReports(
      warnings,
      ['degradedSplit', 'Gateway_d_1_fork'],
      ['droppedEdge', 'Gateway_d_1_fork'],
    );
  });

  /**
   * An arrival with nowhere to land: `Ring1` and `Ring2` hand the forwarding
   * walk to each other, so it comes back to where it started and the edge
   * takes the marker instead of a jump.
   */
  it('drops an arrival at a ring of one-way gateways', () => {
    const ring = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'A' },
          gateway('Ring1'),
          gateway('Ring2'),
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'A'),
          edge('S', 'Ring1'),
          edge('A', 'E'),
          edge('Ring1', 'Ring2'),
          edge('Ring2', 'Ring1'),
        ],
      ),
    );

    expect(ring.source).toContain(
      `${UNSTRUCTURED_MARKER} (dropped edge into Ring1)`,
    );
    expect(ring.source).not.toContain('goto Ring');
    // `S` leaves on two routes with no merge to close them, which is its own
    // report, and the ring is reached twice: once from the jump that opens on
    // it, and once from the sweep that picks up what the walk left unprinted.
    expectReports(
      ring.warnings,
      ['degradedSplit', 'S'],
      ['droppedEdge', 'Ring1'],
      ['droppedEdge', 'Ring1'],
    );
  });

  it('returns no warnings at all for a process that prints in full', () => {
    expect(printDsl(around({ kind: 'userTask', id: 'A' })).warnings).toEqual(
      [],
    );
  });

  // Only the exact `StartEvent_p` is the compiler's; the suffixed id it
  // mints past a taken name is not, so a second plain start keeps its
  // statement rather than vanishing. The print reports nothing: the two
  // plain starts are the model's, which the import refuses ahead of the
  // printer and the validator refuses on the way back.
  it('a second plain start beside the synthesized one prints under its own id, and the validator reports the second default start', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'StartEvent_p' },
        { kind: 'startEvent', id: 'StartEvent_p_2' },
        { kind: 'userTask', id: 'V' },
        { kind: 'endEvent', id: 'E' },
      ],
      [edge('StartEvent_p', 'V'), edge('StartEvent_p_2', 'V'), edge('V', 'E')],
    );
    const { source, warnings } = printDsl(ir);

    expect(warnings).toEqual([]);
    expect(source.split('\n').filter((l) => l.startsWith('  start '))).toEqual([
      '  start StartEvent_p_2',
    ]);
    await printed(ir, 'secondDefaultStart');
  });
});

describe('irToDsl: several starts entering one step', () => {
  it.each([
    [
      'two starts that both end at once print back to back, and the implicit end stays unwritten',
      'process p { start S1  start S2 condition(x) }',
      [
        'process p {',
        '  var x: any',
        '  start S1',
        '  start S2 condition(x)',
        '}',
      ],
    ],
    [
      'starts entering a synthesized split print ahead of the branch, which prints once',
      'process p { start A  start B message("M")  if (x) { user T1 } else { user T2 }  end E }',
      [
        'process p {',
        '  var x: any',
        '  start A',
        '  start B message("M")',
        '  if (x) {',
        '    user T1',
        '  } else {',
        '    user T2',
        '  }',
        '  end E',
        '}',
      ],
    ],
    [
      // The compiler re-derives the elided start only at a body that opens
      // with no `start`, so its chain prints alone and the starts sharing its
      // step jump onto it as one group.
      'the unnamed plain start heads the body alone wherever the model lists it, and the starts sharing its step jump onto it together',
      minimalProcess(
        [
          typedEvent('startEvent', 'B', messageDef('M')),
          { kind: 'startEvent', id: 'StartEvent_p' },
          typedEvent('startEvent', 'C', signalDef('S')),
          { kind: 'userTask', id: 'V' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('B', 'V'),
          edge('StartEvent_p', 'V'),
          edge('C', 'V'),
          edge('V', 'E'),
        ],
      ),
      [
        'process p {',
        '  user V',
        '  end E',
        '  start B message("M")',
        '  start C signal("S")',
        '  goto V',
        '}',
      ],
    ],
  ] as const)('%s', async (_title, fixture, source) => {
    const ir = typeof fixture === 'string' ? await reDesugar(fixture) : fixture;
    expect(await expectIdempotent(ir)).toEqual(`${source.join('\n')}\n`);
    expect(printDsl(ir).warnings).toEqual([]);
  });
});

describe('warnings: a split the script has no form for', () => {
  /**
   * A fork with nothing to rejoin at: every branch ends where it stands. The
   * edges all keep a jump, so nothing is dropped and no marker is printed, and
   * this warning is the only report that the split itself is gone.
   */
  it('reports the fork it wrote as jumps, and drops no edge doing it', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
        { kind: 'endEvent', id: 'X' },
        { kind: 'endEvent', id: 'Y' },
      ],
      [
        edge('S', 'Gateway_p_1_fork'),
        edge('Gateway_p_1_fork', 'X'),
        edge('Gateway_p_1_fork', 'Y'),
      ],
    );
    const { warnings } = printDsl(ir);
    // Each jump in a branch of its own, so the source still compiles: a second
    // jump written beside the first could never run.
    const source = await printed(ir);

    expect(source).not.toContain('parallel {');
    expect(source).toContain('goto X');
    expect(source).toContain('goto Y');
    // The marker names the split the jumps stand for, and no edge is dropped.
    expect(source).toContain(
      `${UNSTRUCTURED_MARKER} (split Gateway_p_1_fork degraded to jumps; was parallel)`,
    );
    expect(source).not.toContain('dropped edge');
    expectReports(warnings, ['degradedSplit', 'Gateway_p_1_fork']);
  });
});

describe('irToDsl: a step whose own routes split', () => {
  /**
   * `A` leaves on `routes`, which meet again at `merge` before `E`. The
   * engine leaves a step by every route whose condition holds or that carries
   * none, and by the fallback alone when none was taken, so the routes print
   * as the fork block that reads back the same way.
   */
  const stepSplitIr = (
    routes: readonly (readonly [target: string, route: Route])[],
    merge: FlowElement,
    defaultFlowId?: string,
  ): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'userTask',
          id: 'A',
          ...(defaultFlowId === undefined ? {} : { defaultFlowId }),
        },
        ...routes.map(([id]): FlowElement => ({ kind: 'userTask', id })),
        merge,
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'A'),
        ...routes.map(([id, route]) => edge('A', id, route)),
        ...routes.map(([id]) => edge(id, merge.id)),
        edge(merge.id, 'E'),
      ],
    );

  const block = (...body: string[]): string =>
    body.map((line) => `  ${line}\n`).join('');

  // Revert symptoms: `followLinear` handing every multi-route step to the
  // choice chain -> the two-plain-routes row prints `if (true)`; the
  // if/else shape not kept -> the fallback row prints `parallel {`;
  // `emitJumps` unweighed -> the implicit-merge row loses its marker line.
  it.each<
    [
      title: string,
      ir: BpmnProcess,
      body: string,
      reports: (readonly [keyof typeof REPORT, string])[],
      refused: (keyof typeof MODEL_REFUSAL)[],
      gains?: string[],
    ]
  >([
    [
      'two plain routes print as a parallel block',
      stepSplitIr(
        [
          ['B', {}],
          ['C', {}],
        ],
        { kind: 'parallelGateway', id: 'J' },
      ),
      block(
        'parallel {',
        '  {',
        '    user B',
        '  }',
        '  {',
        '    user C',
        '  }',
        '}',
        'end E',
      ),
      [],
      [],
    ],
    [
      'two plain routes into an implicit merge degrade to jumps under the marker',
      stepSplitIr(
        [
          ['B', {}],
          ['C', {}],
        ],
        { kind: 'userTask', id: 'D' },
      ),
      block(
        `${UNSTRUCTURED_MARKER} (split A degraded to jumps; was parallel)`,
        'if (true) {',
        '  goto B',
        '} else {',
        '  goto C',
        '}',
        'user B',
        'user D',
        'end E',
        'user C',
        'goto D',
      ),
      [['degradedSplit', 'A']],
      [],
    ],
    [
      'a weighed route beside a plain one prints as an inclusive block',
      stepSplitIr(
        [
          ['B', { condition: '${ok}' }],
          ['C', {}],
        ],
        { kind: 'inclusiveGateway', id: 'J' },
      ),
      block(
        'parallel {',
        '  if (ok) {',
        '    user B',
        '  }',
        '  {',
        '    user C',
        '  }',
        '}',
        'end E',
      ),
      [],
      [],
    ],
    [
      'one weighed route beside the fallback keeps the if/else, which routes the same',
      stepSplitIr(
        [
          ['B', { condition: '${ok}' }],
          ['C', { id: 'F_c' }],
        ],
        gateway('M'),
        'F_c',
      ),
      block('if (ok) {', '  user B', '} else {', '  user C', '}', 'end E'),
      [],
      [],
    ],
    [
      'a weighed route, a plain one and the fallback print as an inclusive block whose fallback nothing reaches',
      stepSplitIr(
        [
          ['B', { condition: '${ok}' }],
          ['C', {}],
          ['D', { id: 'F_d' }],
        ],
        { kind: 'inclusiveGateway', id: 'J' },
        'F_d',
      ),
      block(
        'parallel {',
        '  if (ok) {',
        '    user B',
        '  }',
        '  {',
        '    user C',
        '  }',
        '  else {',
        '    user D',
        '  }',
        '}',
        'end E',
      ),
      [['deadFallback', 'A']],
      ['deadElse'],
    ],
    [
      'two weighed routes and no fallback print as an inclusive block that invents one',
      stepSplitIr(
        [
          ['B', { condition: '${a}' }],
          ['C', { condition: '${b}' }],
        ],
        { kind: 'inclusiveGateway', id: 'J' },
      ),
      block(
        'parallel {',
        '  if (a) {',
        '    user B',
        '  }',
        '  if (b) {',
        '    user C',
        '  }',
        '}',
        'end E',
      ),
      [['inventedFallback', 'A']],
      [],
      // The block closes with no `else`, so the recompiled split gains a
      // fallback into the merge that the model never had.
      ['A->E'],
    ],
  ])('%s', async (_title, ir, body, reports, refused, gains = []) => {
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      'process p {\n  start S\n  user A\n' + body + '}\n',
    );
    expectReports(warnings, ...reports);
    await printed(ir, ...refused);
    expect(realReachability(await reDesugar(source))).toEqual(
      new Set([...realReachability(ir), ...gains]),
    );
  });

  it('prints the one route a loop left a step as the fall-through, as it does for a fork', () => {
    // `Review` runs the escape and the route back at once. The loop prints
    // the route back as its closing brace, leaving one route at the step's
    // own position, and that route carries a condition the plain flow on has
    // nowhere to write.
    const { warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          gateway('Loop'),
          { kind: 'userTask', id: 'Review' },
          { kind: 'userTask', id: 'Escalate' },
          { kind: 'userTask', id: 'Settle' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'Loop'),
          edge('Loop', 'Review', { condition: '${again}' }),
          edge('Loop', 'Settle'),
          edge('Review', 'Loop'),
          edge('Review', 'Escalate', { condition: '${overdue}' }),
          edge('Escalate', 'E'),
          edge('Settle', 'E'),
        ],
      ),
    );

    expectReports(warnings, ['droppedFlowCondition', 'Review']);
  });

  it('says nothing where a step has one route on', () => {
    expect(
      printDsl(
        minimalProcess(
          [
            { kind: 'startEvent', id: 'S' },
            { kind: 'userTask', id: 'A' },
            { kind: 'endEvent', id: 'E' },
          ],
          flowChain('S', 'A', 'E'),
        ),
      ).warnings,
    ).toEqual([]);
  });
});

describe('irToDsl: a split degraded to jumps keeps its conditions on them', () => {
  it('writes each weighed route on its own jump under a marker naming the split and its kind', async () => {
    // The merge is entered by a boundary chain too, so it is not the fork's
    // own and the fork has no block. Its routes leave as jumps, each under the
    // condition it carried, and the marker says which split they stand for.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Order' },
        { kind: 'inclusiveGateway', id: 'Fork' },
        { kind: 'userTask', id: 'Charge' },
        { kind: 'userTask', id: 'Invoice' },
        { kind: 'inclusiveGateway', id: 'Join' },
        boundaryEvent('Late', 'Order', timerDef('duration', 'PT1M')),
        { kind: 'userTask', id: 'Remind' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Order'),
        edge('Order', 'Fork'),
        edge('Fork', 'Charge', { condition: '${online}' }),
        edge('Fork', 'Invoice', { condition: '${cash}' }),
        edge('Charge', 'Join'),
        edge('Invoice', 'Join'),
        edge('Late', 'Remind'),
        edge('Remind', 'Join'),
        edge('Join', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain(
      `  ${UNSTRUCTURED_MARKER} (split Fork degraded to jumps; was inclusive)\n` +
        '  if (online) {\n' +
        '    goto Charge\n' +
        '  } else if (cash) {\n' +
        '    goto Invoice\n' +
        '  }\n',
    );
    expectReports(warnings, ['degradedSplit', 'Fork']);
    await printed(ir);
  });

  it('keeps a race off the block form when a wait routes on twice, and forks the wait itself', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Race' },
        typedEvent(
          'intermediateCatchEvent',
          'C1',
          timerDef('duration', 'PT1M'),
        ),
        typedEvent('intermediateCatchEvent', 'C2', messageDef('m')),
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Race'),
        edge('Race', 'C1'),
        edge('Race', 'C2'),
        edge('C1', 'A'),
        edge('C1', 'B'),
        edge('C2', 'E'),
        edge('A', 'E'),
        edge('B', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain(
      `${UNSTRUCTURED_MARKER} (split Race degraded to jumps; was event-based)`,
    );
    expect(source).toContain(
      `${UNSTRUCTURED_MARKER} (split C1 degraded to jumps; was parallel)`,
    );
    expectReports(warnings, ['degradedSplit', 'Race'], ['degradedSplit', 'C1']);
    await printed(ir);
  });
});

describe('irToDsl: a split with no route out', () => {
  // Revert symptom: the check in `emitNode` removed -> every row's list is [].
  it.each([
    [
      'a parallel split ends the run there, as the script does',
      'parallelGateway',
      'ends the run here',
    ],
    [
      'an inclusive split stops the model with an error',
      'inclusiveGateway',
      'stops the run with an error',
    ],
    [
      'a wait with nothing to wait for holds the model forever',
      'eventBasedGateway',
      'waits here forever',
    ],
    [
      'an exclusive split keeps the model from deploying',
      'exclusiveGateway',
      'refuses to deploy',
    ],
  ] as const)('%s', async (_title, kind, says) => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind, id: 'G' },
      ],
      [edge('S', 'G')],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toBe('process p {\n  start S\n}\n');
    expectReports(warnings, ['emptySplit', 'G']);
    expect(warnings[0]!.message).toContain(says);
    await printed(ir);
  });
});

describe('irToDsl: a split that routes back into itself', () => {
  // Revert symptom: the same-node filter in `tryWhile` removed -> the plain
  // row prints `while (go) {`; in `tryDoWhileEntry` -> the weighed row prints
  // `do {`.
  it.each([
    [
      'a plain route back beside a weighed way on',
      gateway('G'),
      [edge('G', 'G'), edge('G', 'A', { condition: '${go}' })],
      '  if (go) {\n' +
        '  } else {\n' +
        `    ${UNSTRUCTURED_MARKER} (dropped edge into G)\n` +
        '  }\n',
    ],
    [
      'a weighed route back beside the fallback',
      gateway('G', 'F_on'),
      [
        edge('G', 'G', { condition: '${again}' }),
        edge('G', 'A', { id: 'F_on' }),
      ],
      '  if (again) {\n' +
        `    ${UNSTRUCTURED_MARKER} (dropped edge into G)\n` +
        '  }\n',
    ],
  ] as const)(
    '%s prints the marker rather than a loop',
    async (_title, split, routes, chain) => {
      const ir = minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          split,
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        [edge('S', 'G'), ...routes, edge('A', 'E')],
      );
      const { source, warnings } = printDsl(ir);

      expect(bodyOf(source)).toBe(
        'process p {\n  start S\n' + chain + '  user A\n  end E\n}\n',
      );
      expectReports(warnings, ['droppedEdge', 'G']);
      await printed(ir);
    },
  );
});

describe('irToDsl: a jump into a branch of a fork or a race', () => {
  it('reports the jump the script refuses, from the sibling branch it was printed in', async () => {
    // `B` is reached from the split inside the first branch and from the fork
    // itself. The first branch walks it inline, so the second branch reaches
    // it printed and jumps, across the border the validator guards.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'parallelGateway', id: 'Fork' },
        gateway('X'),
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'parallelGateway', id: 'Join' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Fork'),
        edge('Fork', 'X'),
        edge('X', 'A', { condition: '${a}' }),
        edge('X', 'B', { condition: '${b}' }),
        edge('A', 'Join'),
        edge('Fork', 'B'),
        edge('B', 'Join'),
        edge('Join', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    {\n' +
        '      if (a) {\n' +
        '        user A\n' +
        '      } else if (b) {\n' +
        '        user B\n' +
        '      }\n' +
        '    }\n' +
        '    {\n' +
        '      goto B\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expectReports(
      warnings,
      ['inventedFallback', 'X'],
      ['crossBranchJump', 'B'],
    );
    // The refusal the report names.
    const errors = (await validate(source)).diagnostics
      .filter((d) => d.severity === 1)
      .map((d) =>
        typeof d.message === 'string' ? d.message : d.message.value,
      );
    expect(errors).toEqual([
      expect.stringContaining("'goto B' jumps into a branch of a 'parallel'"),
    ]);
  });

  it('says nothing about a jump written inside the branch it lands in', async () => {
    // A loop headed by a merge, closed by a jump to the merge's successor,
    // all of it inside the first branch.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'parallelGateway', id: 'Fork' },
        gateway('Head'),
        { kind: 'userTask', id: 'A' },
        gateway('Again', 'F_out'),
        { kind: 'userTask', id: 'Retry' },
        { kind: 'userTask', id: 'B' },
        { kind: 'parallelGateway', id: 'Join' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Fork'),
        edge('Fork', 'Head'),
        edge('Head', 'A'),
        edge('A', 'Again'),
        edge('Again', 'Retry', { condition: '${retry}' }),
        edge('Retry', 'Head'),
        edge('Again', 'Join', { id: 'F_out' }),
        edge('Fork', 'B'),
        edge('B', 'Join'),
        edge('Join', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('        user Retry\n        goto A\n');
    expect(warnings).toEqual([]);
    await printed(ir);
  });
});

describe('irToDsl: a guard clause whose branch opens on a split', () => {
  it('walks the branch inline instead of dropping the edge into the split', async () => {
    // The outer split names a fallback that carries the main flow, and the
    // branch it guards opens on a second split whose every route is weighed:
    // one ends, one runs on into the continuation.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('Outer', 'F_on'),
        gateway('Inner'),
        { kind: 'endEvent', id: 'Rejected' },
        { kind: 'userTask', id: 'Fix' },
        { kind: 'userTask', id: 'Ship' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Outer'),
        edge('Outer', 'Inner', { condition: '${flagged}' }),
        edge('Outer', 'Ship', { id: 'F_on' }),
        edge('Inner', 'Rejected', { condition: '${severe}' }),
        edge('Inner', 'Fix', { condition: '${minor}' }),
        edge('Fix', 'Ship'),
        edge('Ship', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  if (flagged) {\n' +
        '    if (severe) {\n' +
        '      end Rejected\n' +
        '    } else if (minor) {\n' +
        '      user Fix\n' +
        '    }\n' +
        '  }\n' +
        '  user Ship\n' +
        '  end E\n' +
        '}\n',
    );
    expectReports(warnings, ['inventedFallback', 'Inner']);
    await printed(ir);
  });
});

describe('irToDsl: a branch walk stops where the block comes back together', () => {
  // The post-dominator queries miss every one of these: a branch that can
  // end takes the split's post-dominator to the exit, and a step that loops
  // on itself leaves the whole graph with none. Each row is the shape as the
  // compiler lowers it, so the print has to come back as written.
  it.each([
    [
      'a race with empty branches into a step that loops on itself prints the step after the block',
      [
        'process p {',
        '  await {',
        '    message("M") {',
        '    }',
        '    timer("PT1H") {',
        '    }',
        '  }',
        '  user A',
        '  goto A',
        '}',
      ],
    ],
    [
      'a race whose branch holds a throw guard stops at the merge, and the end prints after the block',
      [
        'process p {',
        '  await {',
        '    timer("PT1H") {',
        '      if (c) {',
        '        throw message("PaymentDone")',
        '      }',
        '    }',
        '    timer("PT2H") {',
        '    }',
        '  }',
        '  end Done',
        '}',
      ],
    ],
    [
      'an if chain with an ending branch, an empty branch and an else chain keeps the else, and the implicit end stays unwritten',
      [
        'process onboarding {',
        '  subprocess Sub4 {',
        '    if (true) {',
        '      end Done7',
        '    } else if (true) {',
        '    } else {',
        '      service Approve10(class: "org.acme.Audit")',
        '    }',
        '  }',
        '}',
      ],
    ],
    [
      'a fork branch holding an empty if with an ending else stops at the join, not at the else',
      [
        'process p {',
        '  parallel {',
        '    {',
        '      if (c) {',
        '      } else {',
        '        end X',
        '      }',
        '    }',
        '    {',
        '      user B',
        '    }',
        '  }',
        '  end Done',
        '}',
      ],
    ],
    [
      'a fork whose fallback runs straight into the join beside a nested fork and an ending branch takes that join',
      [
        'process p {',
        '  parallel {',
        '    if (a) {',
        '      parallel {',
        '        if (b) {',
        '          user P',
        '        }',
        '        if (c) {',
        '          user Q',
        '        }',
        '      }',
        '    }',
        '    if (d) {',
        '      end X',
        '    }',
        '  }',
        '  end Done',
        '}',
      ],
    ],
    [
      'an if whose one branch runs on to the implicit end beside two that end keeps the end unwritten',
      [
        'process p {',
        '  if (b) {',
        '    user A',
        '  } else if (c) {',
        '    user B',
        '    end D',
        '  } else {',
        '    user C',
        '    end E',
        '  }',
        '}',
      ],
    ],
    [
      'an if over a parallel beside two ending branches that share a step stops at its own join, not at that step',
      [
        'process p {',
        '  if (b) {',
        '    parallel {',
        '      {',
        '        user A1',
        '      }',
        '      {',
        '        user A2',
        '      }',
        '    }',
        '  } else if (c) {',
        '    user B',
        '    end D',
        '  } else {',
        '    user C',
        '    goto B',
        '  }',
        '}',
      ],
    ],
    [
      'an if over a parallel beside an ending else keeps the join settings on the parallel',
      [
        'process p {',
        '  if (b) {',
        '    parallel (joinAsyncBefore: true) {',
        '      {',
        '        user A1',
        '      }',
        '      {',
        '        user A2',
        '      }',
        '    }',
        '  } else {',
        '    end E',
        '  }',
        '}',
      ],
    ],
    [
      'an if with an ending else whose branch holds a nested if stops at its own join, not at the nested one',
      [
        'process p {',
        '  if (c) {',
        '    user A',
        '    if (b) {',
        '      user B1',
        '    }',
        '    user A2',
        '  } else {',
        '    end X',
        '  }',
        '}',
      ],
    ],
    [
      'a race whose one branch ends and whose other runs on to the implicit end keeps that branch whole',
      [
        'process p {',
        '  await {',
        '    message("M") {',
        '      if (x) {',
        '        emit message("PaymentDone")',
        '      } else {',
        '        user Charge',
        '      }',
        '      step Approve',
        '    }',
        '    timer("P3D") {',
        '      user Archive',
        '      end Done terminate',
        '    }',
        '  }',
        '}',
      ],
    ],
  ] as const)('%s', async (_title, lines) => {
    const source = `${lines.join('\n')}\n`;
    const ir = await reDesugar(source);
    expect(bodyOf(await expectIdempotent(ir))).toEqual(source);
    expect(printDsl(ir).warnings).toEqual([]);
  });

  // Every path into the split passes `P`, so `P` lies upstream of the block
  // and is no merge of it: taken as the join, the print would jump back to
  // it from a position nothing reaches, after a block whose every branch
  // jumps.
  it.each([
    [
      'an if whose branch and following chain both jump back to the step above the split',
      [
        'process p {',
        '  var a: any',
        '  user P',
        '  if (a) {',
        '    user A',
        '    goto P',
        '  }',
        '  user B',
        '  goto P',
        '}',
      ],
    ],
    [
      'an if whose two branches both jump back to the step above the split',
      [
        'process p {',
        '  var a: any',
        '  user P',
        '  if (a) {',
        '    user A',
        '    goto P',
        '  } else {',
        '    user B',
        '    goto P',
        '  }',
        '}',
      ],
    ],
  ] as const)(
    '%s prints as the guard clause, with the jump back outside the block',
    async (_title, lines) => {
      const ir = await reDesugar(`${lines.join('\n')}\n`);
      const source = await printed(ir);
      expect(bodyOf(source)).toEqual(
        [
          'process p {',
          '  user P',
          '  if (a) {',
          '    goto A',
          '  }',
          '  user B',
          '  goto P',
          '  user A',
          '  goto P',
          '}',
          '',
        ].join('\n'),
      );
      expect(printDsl(ir).warnings).toEqual([]);
      expect(realReachability(await reDesugar(source))).toEqual(
        realReachability(ir),
      );
    },
  );
});

describe('irToDsl: an event sub-process a flow edge leads into', () => {
  it('is refused as malformed, the import turning the flow down ahead of it', () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        eventHandler('H', 'H_Start', messageDef('m')),
      ],
      [edge('S', 'H')],
    );

    expect(() => printDsl(ir)).toThrow(/flow edge/);
  });
});

describe('warnings: a condition the script has nowhere to write', () => {
  /** `source` weighs its one route on, which the script writes as plain flow. */
  const oneWeighedRouteIr = (source: FlowElement, target = 'A'): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        source,
        { kind: 'userTask', id: 'A' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', source.id),
        edge(source.id, target, { condition: '${approved}' }),
        edge(target, 'E'),
      ],
    );

  // A split with one way out prints nothing of its own, so its one route is the
  // same plain step-to-step flow a route between two steps is, and the report
  // turns on whether the engine reads a condition there at all: a fork opening
  // every route and a wait taking the first to resolve read none, so the drop
  // costs nothing at run time and their reports say so instead. Reusing one
  // message for the other would tell the reader a run changed that did not.
  it.each([
    ['a step', { kind: 'userTask', id: 'T' }, 'droppedFlowCondition'],
    [
      'a one-way exclusive split',
      { kind: 'exclusiveGateway', id: 'G' },
      'droppedFlowCondition',
    ],
    [
      'a one-way inclusive split',
      { kind: 'inclusiveGateway', id: 'G' },
      'droppedFlowCondition',
    ],
    [
      // The fallback it names has no route, so the engine raises over the
      // missing route instead and the failure stands.
      'a split naming a fallback it has no route for',
      { kind: 'exclusiveGateway', id: 'G', defaultFlowId: 'Flow_absent' },
      'droppedFlowCondition',
    ],
    [
      'a fork that opens every route',
      { kind: 'parallelGateway', id: 'G' },
      'unweighedBranch',
    ],
    [
      'a wait that takes the first to resolve',
      { kind: 'eventBasedGateway', id: 'G' },
      'raceCondition',
    ],
  ] as const)(
    'reports the condition on the one route out of %s',
    async (_title, node, report) => {
      const ir = oneWeighedRouteIr(node);
      const { source, warnings } = printDsl(ir);

      expect(bodyOf(source)).not.toContain('approved');
      expectReports(warnings, [report, node.id]);
      await printed(ir);
    },
  );

  // A split that names a fallback is never left without a route, so the run
  // carries on by another one instead of failing. The loop spends the fallback
  // as its closing brace, which leaves the weighed route to print as the plain
  // route on.
  it.each(['exclusiveGateway', 'inclusiveGateway'] as const)(
    'reports a weighed route out of a %s that names a fallback as a run that goes on elsewhere',
    (kind) => {
      const { source, warnings } = printDsl(
        loopIntoSplitIr(
          { kind, id: 'Split', defaultFlowId: 'Flow_again' },
          { id: 'Flow_again' },
          { condition: '${settled}' },
        ),
      );

      expect(source).toContain('while (again) {');
      expect(bodyOf(source)).not.toContain('settled');
      expectReports(warnings, ['divertedRun', 'Split']);
    },
  );

  // A choice whose fallback is weighed is the one the engine refuses at
  // deployment, which the report beside this one says. A model that never runs
  // takes no route, so the route this one leaves out is not one to describe as
  // taken instead.
  it('keeps the run that goes on elsewhere off a split whose fallback is weighed', () => {
    const { warnings } = printDsl(
      loopIntoSplitIr(
        gateway('Split', 'Flow_again'),
        { id: 'Flow_again', condition: '${retry}' },
        { condition: '${settled}' },
      ),
    );

    expectReports(
      warnings,
      ['choiceFallbackCondition', 'Split'],
      ['droppedFlowCondition', 'Split'],
    );
  });

  it('reports it on a route the walk never reaches, which leaves as a bare jump', () => {
    // A route whose source is not in the container: nothing walks it, so it
    // prints in the closing sweep as a jump, and a jump carries the route and
    // nothing else.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'A'),
        edge('A', 'E'),
        edge('Detached', 'A', { condition: '${approved}' }),
      ],
    );
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('goto A');
    expect(bodyOf(source)).not.toContain('approved');
    expectReports(warnings, ['droppedFlowCondition', 'Detached']);
  });

  it('says nothing where the route carries no condition', () => {
    expect(
      printDsl(
        minimalProcess(
          [
            { kind: 'startEvent', id: 'S' },
            { kind: 'exclusiveGateway', id: 'G' },
            { kind: 'userTask', id: 'A' },
            { kind: 'endEvent', id: 'E' },
          ],
          flowChain('S', 'G', 'A', 'E'),
        ),
      ).warnings,
    ).toEqual([]);
  });
});

describe('warnings: source the compiler turns down, drawn from the model', () => {
  it('reports a name the script keeps for the names it derives itself', async () => {
    const ir = around({ kind: 'userTask', id: 'Catch_Order_Paid' });
    const { source, warnings } = printDsl(ir);

    expect(source).toContain('user Catch_Order_Paid');
    expectReports(warnings, ['refusedStatement', 'Catch_Order_Paid']);
    await printed(ir, 'reservedId');
  });

  it('says nothing where the reserved name never prints', () => {
    // A synthesized end with nothing to carry is dropped whole, so no name
    // reaches the source to be turned down.
    expect(
      printDsl(
        minimalProcess(
          [
            { kind: 'startEvent', id: 'S' },
            { kind: 'endEvent', id: 'EndEvent_p' },
          ],
          [edge('S', 'EndEvent_p')],
        ),
      ).warnings,
    ).toEqual([]);
  });
});

// Hand-built: these IR shapes are what the desugarer emits for
// `parallel { if (c) { } ... }` and for `await { ... }`.

const DEFAULT_FLOW_ID = 'Flow_Gateway_p_1_fork_default';

/**
 * A fork whose first branch is conditioned. `fallback` places the flow the
 * fork names as its default: a third branch, the merge itself, the second
 * branch, or nowhere. `all-conditioned` names none either and puts the second
 * branch under a condition too, so the fork has nothing left to take when
 * neither holds.
 *
 * `fallbackCondition` weighs the default flow itself. That is legal BPMN the
 * fork never reads: the fallback is taken when no other branch was, whatever
 * the condition on it says.
 */
function inclusiveIr(
  fallback: 'branch' | 'join' | 'none' | 'all-conditioned' | 'second-branch',
  fallbackCondition?: string,
): BpmnProcess {
  const third = fallback === 'branch';
  const named = fallback !== 'none' && fallback !== 'all-conditioned';
  const defaultEdge = {
    id: DEFAULT_FLOW_ID,
    ...(fallbackCondition === undefined
      ? {}
      : { condition: fallbackCondition }),
  };
  const recordEdge =
    fallback === 'second-branch'
      ? defaultEdge
      : fallback === 'all-conditioned'
        ? { condition: '${urgent}' }
        : {};
  return minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      {
        kind: 'inclusiveGateway',
        id: 'Gateway_p_1_fork',
        ...(named ? { defaultFlowId: DEFAULT_FLOW_ID } : {}),
      },
      { kind: 'inclusiveGateway', id: 'Gateway_p_1_join' },
      { kind: 'userTask', id: 'Audit' },
      { kind: 'userTask', id: 'Record' },
      ...(third ? [{ kind: 'userTask', id: 'Triage' } as FlowElement] : []),
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_fork'),
      edge('Gateway_p_1_fork', 'Audit', { condition: '${amount > 10000}' }),
      edge('Audit', 'Gateway_p_1_join'),
      edge('Gateway_p_1_fork', 'Record', recordEdge),
      edge('Record', 'Gateway_p_1_join'),
      ...(third
        ? [
            edge('Gateway_p_1_fork', 'Triage', defaultEdge),
            edge('Triage', 'Gateway_p_1_join'),
          ]
        : []),
      ...(fallback === 'join'
        ? [edge('Gateway_p_1_fork', 'Gateway_p_1_join', defaultEdge)]
        : []),
      edge('Gateway_p_1_join', 'E'),
    ],
  );
}

describe('irToDsl: conditioned parallel branches', () => {
  /** One conditioned branch and one plain one, the fork and the merge elided. */
  const twoBranchSource = (declared = '  var amount: any\n'): string =>
    'process p {\n' +
    declared +
    '  start S\n' +
    '  parallel {\n' +
    '    if (amount > 10000) {\n' +
    '      user Audit\n' +
    '    }\n' +
    '    {\n' +
    '      user Record\n' +
    '    }\n' +
    '  }\n' +
    '  end E\n' +
    '}\n';

  it('prints the conditioned branch, the plain one and the fallback, and reports the fallback as one that can never fire', async () => {
    // `Record` carries no condition, so it runs whatever the conditions do and
    // the fallback behind `Triage` is left nothing to pick up. The model says
    // so and the print keeps it: dropping the `else` would move `Triage` off
    // the run, and the report is what stops the author meeting the validator's
    // refusal with no explanation.
    const ir = inclusiveIr('branch');
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    if (amount > 10000) {\n' +
        '      user Audit\n' +
        '    }\n' +
        '    {\n' +
        '      user Record\n' +
        '    }\n' +
        '    else {\n' +
        '      user Triage\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expectReports(warnings, ['deadFallback', 'Gateway_p_1_fork']);
    // The refusal the report warns about: the model is where the dead fallback
    // comes from, so the print writes it out and the compiler turns it down.
    await expectIdempotent(ir, 'deadElse');
  });

  it('leaves out the fallback branch when it runs straight into the merge, and reports nothing', async () => {
    // The same dead fallback as the case above, beside the same unconditioned
    // branch, but it goes nowhere the merge does not, so it is left out and the
    // printed source holds no `else` to report. The report is read off the
    // branches that print, not off the model's edges. The compiler reserves no
    // fallback beside an unconditioned branch either, so the source comes back
    // as the model without that edge.
    const ir = inclusiveIr('join');
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(twoBranchSource());
    expect(warnings).toEqual([]);
    const ir2 = await reDesugar(source);
    expect(elementMultiset(ir2)).toEqual(elementMultiset(inclusiveIr('none')));
    expect(edgeMultiset(ir2)).toEqual(edgeMultiset(inclusiveIr('none')));
  });

  it('prints one weighed branch beside a bare fallback as the block with an else, and reports nothing', async () => {
    const ir = inclusiveIr('second-branch');
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    if (amount > 10000) {\n' +
        '      user Audit\n' +
        '    }\n' +
        '    else {\n' +
        '      user Record\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expect(warnings).toEqual([]);
    await expectIdempotent(ir);
  });

  it('says nothing about a fallback while one branch is unconditioned, that branch being taken whatever the conditions do', () => {
    const { source, warnings } = printDsl(inclusiveIr('none'));

    // The same two branches as the case above, reached without a default flow.
    expect(source).toBe(twoBranchSource());
    expect(warnings).toEqual([]);
  });

  it('reports the fallback it had to invent when the model names none', () => {
    const { source, warnings } = printDsl(inclusiveIr('all-conditioned'));

    expect(source).toContain('if (amount > 10000) {');
    expectReports(warnings, ['inventedFallback', 'Gateway_p_1_fork']);
  });

  it('writes a fallback the model weighs as the fallback, keeping it off a run of its own, and reports the condition it leaves out', async () => {
    // Legal BPMN whose condition a fork never weighs: it takes the fallback
    // when it took no other branch, whatever that condition says. Head the
    // branch with the condition instead and it joins the run whenever the
    // condition holds, beside its sibling rather than in place of it.
    const ir = inclusiveIr('second-branch', '${urgent}');
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  var urgent: any\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    if (amount > 10000) {\n' +
        '      user Audit\n' +
        '    }\n' +
        '    else {\n' +
        '      user Record\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expect(bodyOf(source)).not.toContain('urgent');
    expectReports(warnings, ['forkFallbackCondition', 'Gateway_p_1_fork']);

    // What the round trip has to hold on to: the branch is still the fork's
    // fallback and still carries no condition, so it runs where it ran before.
    const relowered = await reDesugar(source);
    const fork = relowered.flowElements.find(
      (e): e is Extract<FlowElement, { kind: 'inclusiveGateway' }> =>
        e.kind === 'inclusiveGateway' && e.defaultFlowId !== undefined,
    );
    const fallback = relowered.sequenceFlows.find(
      (f) => f.id === fork?.defaultFlowId,
    );
    expect(fallback?.targetRef).toBe('Record');
    expect(fallback?.conditionExpression).toBeUndefined();
  });

  it('leaves out a weighed fallback that runs straight into the merge, and reports the condition all the same', async () => {
    // The fallback goes nowhere the merge does not, so it stays implicit and
    // the condition on it is the only thing there is to report.
    const ir = inclusiveIr('join', '${late}');
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(
      twoBranchSource('  var amount: any\n  var late: any\n'),
    );
    expectReports(warnings, ['forkFallbackCondition', 'Gateway_p_1_fork']);
    await reDesugar(source);
  });

  it('reports the weighed fallback of a fork a loop has left one route to print', () => {
    // The loop prints the fork's route back into it as its closing brace, so
    // the fork reaches its position with its own weighed fallback left and
    // prints that as the plain route on. The fork weighs the fallback nowhere
    // whichever way it prints, so the drop reads as the fallback it is.
    const { source, warnings } = printDsl(
      loopIntoSplitIr(
        { kind: 'inclusiveGateway', id: 'Fork', defaultFlowId: 'Flow_settled' },
        {},
        { id: 'Flow_settled', condition: '${settled}' },
      ),
    );

    expect(source).toContain('while (again) {');
    expect(bodyOf(source)).not.toContain('settled');
    expectReports(warnings, ['forkFallbackCondition', 'Fork']);
  });

  it('reports a weighed fallback that nothing can reach as one that can never fire, beside the condition it leaves out', () => {
    // `Record` runs whatever the conditions do, so the fallback behind `Triage`
    // is left nothing to pick up whether it is weighed or not.
    const { source, warnings } = printDsl(inclusiveIr('branch', '${late}'));

    expect(source).toContain('    else {\n      user Triage\n');
    expect(bodyOf(source)).not.toContain('late');
    expectReports(
      warnings,
      ['forkFallbackCondition', 'Gateway_p_1_fork'],
      ['deadFallback', 'Gateway_p_1_fork'],
    );
  });

  it('keeps a conditioned branch that runs straight into the merge as an empty block', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'inclusiveGateway',
          id: 'Gateway_p_1_fork',
          defaultFlowId: DEFAULT_FLOW_ID,
        },
        { kind: 'inclusiveGateway', id: 'Gateway_p_1_join' },
        { kind: 'userTask', id: 'Record' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Gateway_p_1_fork'),
        edge('Gateway_p_1_fork', 'Gateway_p_1_join', {
          id: 'Flow_skip',
          condition: '${amount > 10000}',
        }),
        edge('Gateway_p_1_fork', 'Record'),
        edge('Record', 'Gateway_p_1_join'),
        edge('Gateway_p_1_fork', 'Gateway_p_1_join', { id: DEFAULT_FLOW_ID }),
        edge('Gateway_p_1_join', 'E'),
      ],
    );

    expect(await printed(ir)).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  start S\n' +
        '  parallel {\n' +
        '    if (amount > 10000) {\n' +
        '    }\n' +
        '    {\n' +
        '      user Record\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
  });

  it('degrades to jumps when no merge of its own kind closes the fork, inventing no fallback on the way', () => {
    // The merge is an XOR one, so the fork has no matching join and every
    // branch keeps its edge as a jump instead. No block is printed, so no
    // fallback is invented either, though both branches are conditioned.
    const { source, warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'inclusiveGateway', id: 'Gateway_p_1_fork' },
          { kind: 'userTask', id: 'Audit' },
          { kind: 'userTask', id: 'Record' },
          gateway('Gateway_p_1_join'),
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'Gateway_p_1_fork'),
          edge('Gateway_p_1_fork', 'Audit', { condition: '${ok}' }),
          edge('Gateway_p_1_fork', 'Record', { condition: '${urgent}' }),
          edge('Audit', 'Gateway_p_1_join'),
          edge('Record', 'Gateway_p_1_join'),
          edge('Gateway_p_1_join', 'E'),
        ],
      ),
    );

    expect(source).not.toContain('parallel {');
    expect(source).toContain('goto Audit');
    expect(source).toContain('goto Record');
    expectReports(warnings, ['degradedSplit', 'Gateway_p_1_fork']);
  });
});

describe('irToDsl: a split left with nowhere to go when no condition holds', () => {
  /**
   * The `if` chain's shapes, which the fork block's counterparts have their own
   * block above: a choice, a loop's exits and a step's own routes all print as
   * one chain, so the fall-through past it is the same in all three.
   */

  /** `Pick` weighs both its routes and names none to take when neither holds. */
  const allConditionedChoice = (defaultFlowId?: string): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('Pick', defaultFlowId),
        { kind: 'userTask', id: 'Audit' },
        { kind: 'userTask', id: 'Record' },
        gateway('Merge'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Pick'),
        edge('Pick', 'Audit', {
          id: 'F_audit',
          condition: '${amount > 10000}',
        }),
        edge('Pick', 'Record', { id: 'F_record', condition: '${urgent}' }),
        edge('Audit', 'Merge'),
        edge('Record', 'Merge'),
        edge('Merge', 'E'),
      ],
    );

  it('reports the fallback it had to invent at a choice whose every route is weighed', async () => {
    const { source, warnings } = printDsl(allConditionedChoice());

    // The chain closes with a bare `}`, so the position after it carries the
    // run on where the model had nothing left to take.
    expect(source).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  var urgent: any\n' +
        '  start S\n' +
        '  if (amount > 10000) {\n' +
        '    user Audit\n' +
        '  } else if (urgent) {\n' +
        '    user Record\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expectReports(warnings, ['inventedFallback', 'Pick']);

    // The invention itself: the printed source lowers to a route the model
    // never had, unconditioned and straight to the merge.
    const relowered = await reDesugar(source);
    const split = relowered.flowElements.find(
      (e): e is Extract<FlowElement, { kind: 'exclusiveGateway' }> =>
        e.kind === 'exclusiveGateway' && e.defaultFlowId !== undefined,
    );
    const invented = relowered.sequenceFlows.find(
      (f) => f.id === split?.defaultFlowId,
    );
    expect(invented?.conditionExpression).toBeUndefined();
  });

  it('reads the fallback an imported step carries, and reports only the condition on it that is weighed nowhere', async () => {
    // The two hops speak about the same step in the same run of the CLI: the
    // import carries the fallback the model named and says nothing, and the
    // print writes it as the `else`, which is the route the engine takes when
    // the weighed one fails, whatever the condition on the fallback says.
    const condition = (body: string): string =>
      `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${body}</bpmn:conditionExpression>`;
    const { ir, warnings: imported } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Triage" default="F2" />
    <bpmn:endEvent id="E1" />
    <bpmn:endEvent id="E2" />
    <bpmn:sequenceFlow id="F0" sourceRef="S" targetRef="Triage" />
    <bpmn:sequenceFlow id="F1" sourceRef="Triage" targetRef="E1">
      ${condition('${paid}')}
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F2" sourceRef="Triage" targetRef="E2">
      ${condition('${urgent}')}
    </bpmn:sequenceFlow>`);

    expect(imported).toEqual([]);
    expect(ir.flowElements.find((e) => e.id === 'Triage')).toEqual({
      kind: 'userTask',
      id: 'Triage',
      defaultFlowId: 'F2',
    });

    const { source, warnings } = printDsl(ir);
    expect(bodyOf(source)).toBe(
      'process p {\n' +
        '  start S\n' +
        '  user Triage\n' +
        '  if (paid) {\n' +
        '    end E1\n' +
        '  }\n' +
        '  end E2\n' +
        '}\n',
    );
    expectReports(warnings, ['forkFallbackCondition', 'Triage']);
  });

  it('says nothing about an invented fallback at a step whose route back into the loop the loop already printed', () => {
    // The route back carries no condition, so `Review` always has it and can
    // never be left with nowhere to go. The loop prints it as the closing
    // brace, which leaves the weighed escapes at the step's position with no
    // merge to close them, so they leave as jumps.
    const { source, warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          gateway('Loop'),
          { kind: 'userTask', id: 'Review' },
          { kind: 'userTask', id: 'Escalate' },
          { kind: 'userTask', id: 'Reject' },
          { kind: 'userTask', id: 'Settle' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'Loop'),
          edge('Loop', 'Review', { condition: '${again}' }),
          edge('Loop', 'Settle'),
          edge('Review', 'Loop'),
          edge('Review', 'Escalate', { condition: '${overdue}' }),
          edge('Review', 'Reject', { condition: '${abandoned}' }),
          edge('Escalate', 'E'),
          edge('Reject', 'E'),
          edge('Settle', 'E'),
        ],
      ),
    );

    expect(source).toContain('while (again) {');
    expectReports(warnings, ['degradedSplit', 'Review']);
  });

  it('keeps the guard-clause continuation when the route the split names carries a condition', async () => {
    // No clean join here: one branch throws while the route the split takes
    // when nothing holds carries the main flow. That route is the continuation
    // whether it carries a condition or not, so the guard clause still prints
    // as one instead of degrading to a pair of jumps.
    const ir = await reDesugar(`process p {
  error BOOM
  start S
  if (amount > 1000) {
    throw error(BOOM)
  }
  service Post(class: "x.Post")
  end Done
}
`);
    const split = ir.flowElements.find(
      (e): e is Extract<FlowElement, { kind: 'exclusiveGateway' }> =>
        e.kind === 'exclusiveGateway' && e.defaultFlowId !== undefined,
    )!;
    const fallback = ir.sequenceFlows.find(
      (f) => f.id === split.defaultFlowId,
    )!;
    fallback.conditionExpression = '${urgent}';

    const { source, warnings } = printDsl(ir);

    expect(source).toContain('if (amount > 1000) {');
    expect(source).toContain('service Post');
    expect(source).not.toContain('goto ');
    expectReports(warnings, ['choiceFallbackCondition', split.id]);
  });

  it('says nothing about an invented fallback at a fork that opens every branch', () => {
    // Every branch is weighed and the fork names no fallback, but it opens all
    // of them whatever the conditions say, so it is never left with nowhere to
    // go and the block after it invents nothing. The conditions it reads
    // nowhere are the only thing there is to report.
    const { warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
          { kind: 'userTask', id: 'Audit' },
          { kind: 'userTask', id: 'Record' },
          { kind: 'parallelGateway', id: 'Gateway_p_1_join' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'Gateway_p_1_fork'),
          edge('Gateway_p_1_fork', 'Audit', { condition: '${amount > 10000}' }),
          edge('Gateway_p_1_fork', 'Record', { condition: '${urgent}' }),
          edge('Audit', 'Gateway_p_1_join'),
          edge('Record', 'Gateway_p_1_join'),
          edge('Gateway_p_1_join', 'E'),
        ],
      ),
    );

    expectReports(warnings, ['unweighedBranch', 'Gateway_p_1_fork']);
  });

  it('writes a weighed fallback of a choice as the plain else, and reports the model the engine will not deploy', async () => {
    // A choice weighs its fallback like any other route, so the engine refuses
    // the model at deployment for carrying a condition there and there is no
    // run to carry it into. Heading the branch with it would put it on a run of
    // its own and leave the choice falling through where the model never did.
    // The fallback lands among the weighed routes on a plain reading, so the
    // model still has somewhere to go and nothing is invented for it.
    const ir = allConditionedChoice('F_record');
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  var urgent: any\n' +
        '  start S\n' +
        '  if (amount > 10000) {\n' +
        '    user Audit\n' +
        '  } else {\n' +
        '    user Record\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expect(bodyOf(source)).not.toContain('urgent');
    expectReports(warnings, ['choiceFallbackCondition', 'Pick']);

    // What the round trip has to hold on to: `Record` is still what the split
    // takes when the other condition fails, and still carries no condition.
    const relowered = await reDesugar(source);
    const split = relowered.flowElements.find(
      (e): e is Extract<FlowElement, { kind: 'exclusiveGateway' }> =>
        e.kind === 'exclusiveGateway' && e.defaultFlowId !== undefined,
    );
    const fallback = relowered.sequenceFlows.find(
      (f) => f.id === split?.defaultFlowId,
    );
    expect(fallback?.targetRef).toBe('Record');
    expect(fallback?.conditionExpression).toBeUndefined();
  });

  // The loop spends the route round it, printing it as the `while` condition,
  // the `do` closing condition, or the plain route on where one route is left,
  // so it is gone from the routes still to print at the head. The report is
  // asked of the routes the model gives the head, not of those.
  const ESCAPES = [
    ['Escalate', '${overdue}'],
    ['Settle', '${paid}'],
  ] as const;

  it.each([
    [
      'names no fallback, so the choice after the loop invents one',
      loopWithEscapesIr({
        head: gateway('Loop'),
        body: 'Retry',
        back: { condition: '${again}' },
        escapes: ESCAPES,
      }),
      [['inventedFallback', 'Loop']],
      'while (again) {',
    ],
    [
      'weighs the fallback a pre-test loop prints as its condition, which the engine refuses at deployment',
      loopWithEscapesIr({
        head: gateway('Loop', 'F_body'),
        body: 'Review',
        back: { id: 'F_body', condition: '${again}' },
        escapes: ESCAPES,
      }),
      [['choiceFallbackCondition', 'Loop']],
      'while (again) {',
    ],
    [
      'weighs the fallback a post-test loop prints as its closing condition',
      loopWithEscapesIr({
        shape: 'post',
        head: gateway('Pick', 'F_again'),
        body: 'Review',
        back: { id: 'F_again', condition: '${again}' },
        escapes: ESCAPES,
      }),
      [['choiceFallbackCondition', 'Pick']],
      '} while (again)',
    ],
    [
      // One route left is the fall-through, which the head prints without a
      // choice around it, so the condition it leaves out is reported beside
      // the deployment refusal.
      'weighs the fallback where the loop leaves it one route to print',
      loopWithEscapesIr({
        shape: 'post',
        head: gateway('Pick', 'F_again'),
        body: 'Review',
        back: { id: 'F_again', condition: '${again}' },
        escapes: [['Settle', '${paid}']],
      }),
      [
        ['choiceFallbackCondition', 'Pick'],
        ['droppedFlowCondition', 'Pick'],
      ],
      '} while (again)',
    ],
  ] as const)('reports a loop head that %s', (_title, ir, reports, has) => {
    const { source, warnings } = printDsl(ir);
    expect(source).toContain(has);
    expectReports(warnings, ...reports);
  });

  it('reports the refusal alone when the one route the loop leaves is the weighed fallback itself', () => {
    // The route left to print is the fallback, so the condition the plain
    // route on leaves out is the one the refusal is about. Saying the engine
    // reads it beside that would name a run the model never reaches.
    const { warnings } = printDsl(
      loopIntoSplitIr(
        gateway('Pick', 'Flow_settled'),
        {},
        {
          id: 'Flow_settled',
          condition: '${settled}',
        },
      ),
    );

    expectReports(warnings, ['choiceFallbackCondition', 'Pick']);
  });

  it('gives the else to the route the split names, over a plain route beside it', async () => {
    // `Triage` carries no condition and is not the named fallback, so the model
    // takes it whenever the weighed route fails and never reaches `Record`. The
    // `else` has to be `Record` for the chain to read that way: give it to
    // `Triage` instead and the plain route becomes the one nothing reaches.
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        gateway('Pick', 'F_record'),
        { kind: 'userTask', id: 'Audit' },
        { kind: 'userTask', id: 'Record' },
        { kind: 'userTask', id: 'Triage' },
        gateway('Merge'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Pick'),
        edge('Pick', 'Audit', {
          id: 'F_audit',
          condition: '${amount > 10000}',
        }),
        edge('Pick', 'Record', { id: 'F_record', condition: '${urgent}' }),
        edge('Pick', 'Triage', { id: 'F_triage' }),
        edge('Audit', 'Merge'),
        edge('Record', 'Merge'),
        edge('Triage', 'Merge'),
        edge('Merge', 'E'),
      ],
    );

    expect(await printed(ir)).toBe(
      'process p {\n' +
        '  var amount: any\n' +
        '  var urgent: any\n' +
        '  start S\n' +
        '  if (amount > 10000) {\n' +
        '    user Audit\n' +
        '  } else if (true) {\n' +
        '    user Triage\n' +
        '  } else {\n' +
        '    user Record\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
  });
});

describe('irToDsl: a condition on a branch of a fork that weighs none', () => {
  /**
   * A fork that opens every branch, with a condition on one of them. Legal
   * BPMN the engine never reads, and content the block form has no head to
   * carry: a head written here would read back as the fork that weighs its
   * branches, which is a different fork.
   */
  const CONDITIONED_AND_FORK: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
      { kind: 'userTask', id: 'Audit' },
      { kind: 'userTask', id: 'Record' },
      { kind: 'parallelGateway', id: 'Gateway_p_1_join' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_fork'),
      edge('Gateway_p_1_fork', 'Audit', { condition: '${urgent}' }),
      edge('Gateway_p_1_fork', 'Record'),
      edge('Audit', 'Gateway_p_1_join'),
      edge('Record', 'Gateway_p_1_join'),
      edge('Gateway_p_1_join', 'E'),
    ],
  );

  it('leaves the condition out, keeping the fork the fork it was', async () => {
    const dsl = await printed(CONDITIONED_AND_FORK);

    expect(dsl).toContain('parallel {');
    expect(bodyOf(dsl)).not.toContain('urgent');
    // Both forks print as `parallel`, so a head is all that tells them apart.
    expect(dsl).not.toContain('if (');
  });

  it('reports the condition it left out, naming the fork it belongs to', () => {
    const { warnings } = printDsl(CONDITIONED_AND_FORK);

    expectReports(warnings, ['unweighedBranch', 'Gateway_p_1_fork']);
  });

  it('says nothing when no branch of the fork is weighed', () => {
    const plain: BpmnProcess = {
      ...CONDITIONED_AND_FORK,
      sequenceFlows: CONDITIONED_AND_FORK.sequenceFlows.map(
        ({ conditionExpression: _drop, ...rest }) => rest,
      ),
    };
    expect(printDsl(plain).warnings).toEqual([]);
  });
});

/** Desugared `await { message("Paid") { user Ship } timer("P3D") { user Chase } }`. */
const RACE_IR: BpmnProcess = minimalProcess(
  [
    { kind: 'startEvent', id: 'S' },
    { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
    typedEvent('intermediateCatchEvent', 'Catch_p_1_b0', messageDef('Paid')),
    typedEvent(
      'intermediateCatchEvent',
      'Catch_p_1_b1',
      timerDef('duration', 'P3D'),
    ),
    { kind: 'userTask', id: 'Ship' },
    { kind: 'userTask', id: 'Chase' },
    gateway('Gateway_p_1_join'),
    { kind: 'endEvent', id: 'E' },
  ],
  [
    edge('S', 'Gateway_p_1_race'),
    edge('Gateway_p_1_race', 'Catch_p_1_b0'),
    edge('Catch_p_1_b0', 'Ship'),
    edge('Ship', 'Gateway_p_1_join'),
    edge('Gateway_p_1_race', 'Catch_p_1_b1'),
    edge('Catch_p_1_b1', 'Chase'),
    edge('Chase', 'Gateway_p_1_join'),
    edge('Gateway_p_1_join', 'E'),
  ],
);

describe('irToDsl: race', () => {
  it('prints one branch per wait, split, waits and merge all elided', async () => {
    const { source, warnings } = printDsl(RACE_IR);

    expect(source).toBe(
      'process p {\n' +
        '  start S\n' +
        '  await {\n' +
        '    message("Paid") {\n' +
        '      user Ship\n' +
        '    }\n' +
        '    timer("P3D") {\n' +
        '      user Chase\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expect(warnings).toEqual([]);
    await expectIdempotent(RACE_IR);
  });

  it('reports a condition weighing a race branch, which the block form has nowhere to put', () => {
    // Legal BPMN a race never weighs: it opens every branch at once and takes
    // the first to resolve, so the condition decides nothing either way. The
    // print is the same source as without it, and the report is the only trace.
    const ir: BpmnProcess = {
      ...RACE_IR,
      sequenceFlows: RACE_IR.sequenceFlows.map((f) =>
        f.sourceRef === 'Gateway_p_1_race' && f.targetRef === 'Catch_p_1_b1'
          ? { ...f, conditionExpression: '${overdue}' }
          : f,
      ),
    };
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(bodyOf(irToDsl(RACE_IR)));
    expect(bodyOf(source)).not.toContain('overdue');
    expectReports(warnings, ['raceCondition', 'Gateway_p_1_race']);
  });

  it('reports a condition on the route from a wait into its own body, which the engine reads', async () => {
    // Not the condition on the branch above, which the wait weighs nowhere:
    // this one sits between the wait and the step it opens on, where the
    // engine takes the route only when it holds and refuses the run when it
    // does not. The block form writes the body straight under the wait, so
    // the condition has no place to go.
    const ir: BpmnProcess = {
      ...RACE_IR,
      sequenceFlows: RACE_IR.sequenceFlows.map((f) =>
        f.sourceRef === 'Catch_p_1_b0' && f.targetRef === 'Ship'
          ? { ...f, conditionExpression: '${ok}' }
          : f,
      ),
    };
    const { source, warnings } = printDsl(ir);

    expect(bodyOf(source)).toBe(bodyOf(irToDsl(RACE_IR)));
    expect(bodyOf(source)).not.toContain('ok');
    expectReports(warnings, ['droppedFlowCondition', 'Catch_p_1_b0']);
  });

  it('writes the branch settings in the header parens, and an empty body for a branch that only waits', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
        {
          ...typedEvent(
            'intermediateCatchEvent',
            'Catch_p_1_b0',
            messageDef('Paid'),
          ),
          asyncBefore: true,
        },
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b1',
          timerDef('duration', 'P3D'),
        ),
        { kind: 'userTask', id: 'Chase' },
        gateway('Gateway_p_1_join'),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Gateway_p_1_race'),
        edge('Gateway_p_1_race', 'Catch_p_1_b0'),
        edge('Catch_p_1_b0', 'Gateway_p_1_join'),
        edge('Gateway_p_1_race', 'Catch_p_1_b1'),
        edge('Catch_p_1_b1', 'Chase'),
        edge('Chase', 'Gateway_p_1_join'),
        edge('Gateway_p_1_join', 'E'),
      ],
    );

    const dsl = irToDsl(ir);
    expect(dsl).toBe(
      'process p {\n' +
        '  start S\n' +
        '  await {\n' +
        '    message("Paid", asyncBefore: true) {\n' +
        '    }\n' +
        '    timer("P3D") {\n' +
        '      user Chase\n' +
        '    }\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    await expectIdempotent(ir);
  });

  it('still prints a race whose every branch ends, the merge having been pruned away', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b0',
          messageDef('Paid'),
        ),
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b1',
          timerDef('duration', 'P3D'),
        ),
        { kind: 'endEvent', id: 'Done' },
        { kind: 'endEvent', id: 'Expired' },
      ],
      [
        edge('S', 'Gateway_p_1_race'),
        edge('Gateway_p_1_race', 'Catch_p_1_b0'),
        edge('Catch_p_1_b0', 'Done'),
        edge('Gateway_p_1_race', 'Catch_p_1_b1'),
        edge('Catch_p_1_b1', 'Expired'),
      ],
    );
    const dsl = irToDsl(ir);

    expect(dsl).toBe(
      'process p {\n' +
        '  start S\n' +
        '  await {\n' +
        '    message("Paid") {\n' +
        '      end Done\n' +
        '    }\n' +
        '    timer("P3D") {\n' +
        '      end Expired\n' +
        '    }\n' +
        '  }\n' +
        '}\n',
    );
    await expectIdempotent(ir);
  });

  // Revert: `raceWait` returning `undefined` for a wait with no route out
  // degrades the race to jumps instead of the empty branch.
  it('prints a wait with no route out as an empty branch, which ends the run where the model does when nothing follows the race', async () => {
    const ir = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b0',
          messageDef('Paid'),
        ),
        typedEvent(
          'intermediateCatchEvent',
          'Catch_p_1_b1',
          timerDef('duration', 'P3D'),
        ),
        { kind: 'userTask', id: 'Chase' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'Gateway_p_1_race'),
        edge('Gateway_p_1_race', 'Catch_p_1_b0'),
        edge('Gateway_p_1_race', 'Catch_p_1_b1'),
        edge('Catch_p_1_b1', 'Chase'),
        edge('Chase', 'E'),
      ],
    );
    const { source, warnings } = printDsl(ir);
    expect(source).toBe(
      'process p {\n' +
        '  start S\n' +
        '  await {\n' +
        '    message("Paid") {\n' +
        '    }\n' +
        '    timer("P3D") {\n' +
        '      user Chase\n' +
        '      end E\n' +
        '    }\n' +
        '  }\n' +
        '}\n',
    );
    expect(warnings).toEqual([]);
    await printed(ir);
  });

  it('degrades when a branch does not open on a wait, and loses no edge doing it', () => {
    const { source, warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'eventBasedGateway', id: 'Gateway_p_1_race' },
          typedEvent(
            'intermediateCatchEvent',
            'Catch_p_1_b0',
            messageDef('Paid'),
          ),
          { kind: 'userTask', id: 'Chase' },
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'Gateway_p_1_race'),
          edge('Gateway_p_1_race', 'Catch_p_1_b0'),
          edge('Catch_p_1_b0', 'E'),
          edge('Gateway_p_1_race', 'Chase'),
          edge('Chase', 'E'),
        ],
      ),
    );

    expect(source).not.toContain('await {');
    // One edge takes a jump; the other lands on a wait, which has no name to
    // jump to, so it leaves the marker and its report instead.
    expect(source).toContain('goto Chase');
    expect(source).toContain(`${UNSTRUCTURED_MARKER} (dropped edge into Catch`);
    expectReports(
      warnings,
      ['degradedSplit', 'Gateway_p_1_race'],
      ['droppedEdge', 'Catch_p_1_b0'],
    );
    // The wait itself is still printed, so its own chain survives.
    expect(source).toContain('await message("Paid")');
  });
});

describe('irToDsl: a split with one way out is transparent', () => {
  const oneOutIr = (kind: 'inclusiveGateway' | 'eventBasedGateway') =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind, id: 'G' },
        { kind: 'userTask', id: 'A' },
        { kind: 'endEvent', id: 'E' },
      ],
      flowChain('S', 'G', 'A', 'E'),
    );

  it.each(['inclusiveGateway', 'eventBasedGateway'] as const)(
    'walks straight through a one-way %s',
    async (kind) => {
      expect(await printed(oneOutIr(kind))).toBe(
        'process p {\n  start S\n  user A\n  end E\n}\n',
      );
    },
  );

  /**
   * One route of a real node lands on a one-way split, and the routes end
   * apart, so the branch keeps its edge as a jump. The jump has to forward
   * through the split to the successor: naming the split is impossible, and
   * giving up on it would drop an edge the model has.
   */
  const passThroughIr = (kind: 'inclusiveGateway' | 'eventBasedGateway') =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        { kind, id: 'G' },
        { kind: 'userTask', id: 'R' },
        { kind: 'endEvent', id: 'E' },
        { kind: 'endEvent', id: 'E2' },
      ],
      [
        edge('S', 'A'),
        edge('A', 'E'),
        edge('A', 'G'),
        edge('G', 'R'),
        edge('R', 'E2'),
      ],
    );

  it.each(['inclusiveGateway', 'eventBasedGateway'] as const)(
    'forwards a jump through a one-way %s to the real successor',
    (kind) => {
      const { source, warnings } = printDsl(passThroughIr(kind));

      expect(source).toContain('goto R');
      expect(source).not.toContain('dropped edge');
      expectReports(warnings, ['degradedSplit', 'A']);
    },
  );
});

/** `ir` with each listed element carrying the job settings named for it. */
function withJobSettings(
  ir: BpmnProcess,
  settings: Record<string, JobSettings>,
): BpmnProcess {
  return {
    ...ir,
    flowElements: ir.flowElements.map((el) =>
      el.id in settings ? { ...el, ...settings[el.id] } : el,
    ),
  };
}

/**
 * The parens of every gateway statement in `dsl`, in source order, as
 * `[statement type, ['key: value', ...]]`: which head the printer put the keys
 * on. Which gateway each lands on is the compiler's business.
 */
async function headParens(dsl: string): Promise<[string, string[]][]> {
  const doc = await parse(dsl);
  return AstUtils.streamAllContents(doc.parseResult.value)
    .filter((node) => gatewayStatementRuleOf(node) !== undefined)
    .map((node): [string, string[]] => [
      node.$type,
      ((node as { items?: ParenItem[] }).items ?? []).map(
        (item) => item.$cstNode!.text,
      ),
    ])
    .toArray();
}

/**
 * Every gateway of `ir` carrying a setting, as `[kind, settings]` in an order
 * the ids take no part in: the compiler mints its own ids on re-parse, and a
 * merge that splits again comes back as a split beside a join the model never
 * had, so only the settings-bearing gateways can be compared.
 */
function gatewaySettings(ir: BpmnProcess): [string, JobSettings][] {
  return ir.flowElements
    .filter(isGateway)
    .map((el): [string, JobSettings] => [
      el.kind,
      Object.fromEntries(
        ENGINE_KEYS.filter((key) => key in el).map((key) => [
          key,
          (el as unknown as Record<string, unknown>)[key],
        ]),
      ),
    ])
    .filter(([, settings]) => Object.keys(settings).length > 0)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('irToDsl: gateway settings', () => {
  const CYCLE = 'R3/PT10M';

  /** `if (a) {A} else if (b) {B} else {C}` as the compiler lowers it: one split, one join. */
  const CHAIN_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Gateway_p_1_split', 'Flow_Gateway_p_1_split_default'),
      gateway('Gateway_p_1_join'),
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'userTask', id: 'C' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_split'),
      edge('Gateway_p_1_split', 'A', { condition: '${a}' }),
      edge('A', 'Gateway_p_1_join'),
      edge('Gateway_p_1_split', 'B', { condition: '${b}' }),
      edge('B', 'Gateway_p_1_join'),
      edge('Gateway_p_1_split', 'C', {
        id: 'Flow_Gateway_p_1_split_default',
      }),
      edge('C', 'Gateway_p_1_join'),
      edge('Gateway_p_1_join', 'E'),
    ],
  );

  /** A merge that is itself a two-route split, which prints as the `if` that follows the first. */
  const MERGE_THAT_SPLITS_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Gateway_p_1_split', 'Flow_Gateway_p_1_split_default'),
      gateway('Merge', 'Flow_Merge_default'),
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'userTask', id: 'X' },
      { kind: 'userTask', id: 'Y' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_split'),
      edge('Gateway_p_1_split', 'A', { condition: '${a}' }),
      edge('A', 'Merge'),
      edge('Gateway_p_1_split', 'B', {
        id: 'Flow_Gateway_p_1_split_default',
      }),
      edge('B', 'Merge'),
      edge('Merge', 'X', { condition: '${x}' }),
      edge('X', 'E'),
      edge('Merge', 'Y', { id: 'Flow_Merge_default' }),
      edge('Y', 'E'),
    ],
  );

  /**
   * `while (c) { if (a) {A} else {B} }` as the compiler lowers it: the inner
   * join's only route is the loop's back-edge, which the `while` spends before
   * the body is walked.
   */
  const IF_IN_WHILE_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('Gateway_p_1_loop', 'Flow_Gateway_p_1_loop_default'),
      gateway('Gateway_p_1_b_0_split', 'Flow_Gateway_p_1_b_0_split_default'),
      gateway('Gateway_p_1_b_0_join'),
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      edge('S', 'Gateway_p_1_loop'),
      edge('Gateway_p_1_loop', 'Gateway_p_1_b_0_split', { condition: '${c}' }),
      edge('Gateway_p_1_b_0_split', 'A', { condition: '${a}' }),
      edge('A', 'Gateway_p_1_b_0_join'),
      edge('Gateway_p_1_b_0_split', 'B', {
        id: 'Flow_Gateway_p_1_b_0_split_default',
      }),
      edge('B', 'Gateway_p_1_b_0_join'),
      edge('Gateway_p_1_b_0_join', 'Gateway_p_1_loop'),
      edge('Gateway_p_1_loop', 'E', { id: 'Flow_Gateway_p_1_loop_default' }),
    ],
  );

  // Revert symptoms: drop the join items from the head -> every `join*` row
  // red; take the join's settings whatever its shape -> the merge-that-splits
  // row prints them as `join*` on the first `if`; read the loop's settings
  // again for its leftover routes -> the loop rows print them twice; read a
  // join's keys onto the split in the compiler -> the printed text is
  // unchanged and the re-parse pin alone goes red.
  it.each([
    [
      'an if prints the split settings and, join-prefixed, the pass-through merge settings',
      withJobSettings(IF_ELSE_IR, {
        Gateway_p_2_split: { asyncBefore: true, jobPriority: '10' },
        Gateway_p_2_join: { asyncBefore: true, retryCycle: CYCLE },
      }),
      [
        'process p {',
        '  var amount: any',
        '  start S',
        '  user A(label: "A task")',
        '  if (amount > 1000) (asyncBefore: true, jobPriority: 10, joinAsyncBefore: true, joinRetryCycle: "R3/PT10M") {',
        '    user B(label: "B task")',
        '  } else {',
        '    service C(class: "com.example.C")',
        '  }',
        '  end E',
        '}',
      ],
      [
        [
          'IfStatement',
          [
            'asyncBefore: true',
            'jobPriority: 10',
            'joinAsyncBefore: true',
            'joinRetryCycle: "R3/PT10M"',
          ],
        ],
      ],
    ],
    [
      'an else-if chain is one split, so the head carries the parens and no else-if does',
      withJobSettings(CHAIN_IR, {
        Gateway_p_1_split: { exclusive: false },
        Gateway_p_1_join: { asyncAfter: true },
      }),
      [
        'process p {',
        '  var a: any',
        '  var b: any',
        '  start S',
        '  if (a) (exclusive: false, joinAsyncAfter: true) {',
        '    user A',
        '  } else if (b) {',
        '    user B',
        '  } else {',
        '    user C',
        '  }',
        '  end E',
        '}',
      ],
      [['IfStatement', ['exclusive: false', 'joinAsyncAfter: true']]],
    ],
    [
      'an if inside a while prints the merge settings although the loop already spent its back-edge',
      withJobSettings(IF_IN_WHILE_IR, {
        Gateway_p_1_b_0_join: { asyncBefore: true },
      }),
      [
        'process p {',
        '  var c: any',
        '  var a: any',
        '  start S',
        '  while (c) {',
        '    if (a) (joinAsyncBefore: true) {',
        '      user A',
        '    } else {',
        '      user B',
        '    }',
        '  }',
        '  end E',
        '}',
      ],
      [
        ['WhileStatement', []],
        ['IfStatement', ['joinAsyncBefore: true']],
      ],
    ],
    [
      'a merge that splits again keeps its settings for the if it opens, not as join settings on the first',
      withJobSettings(MERGE_THAT_SPLITS_IR, {
        Merge: { asyncBefore: true },
      }),
      [
        'process p {',
        '  var a: any',
        '  var x: any',
        '  start S',
        '  if (a) {',
        '    user A',
        '  } else {',
        '    user B',
        '  }',
        '  if (x) (asyncBefore: true) {',
        '    user X',
        '  } else {',
        '    user Y',
        '  }',
        '  end E',
        '}',
      ],
      [
        ['IfStatement', []],
        ['IfStatement', ['asyncBefore: true']],
      ],
    ],
    [
      'a while prints the loop settings on its head',
      withJobSettings(WHILE_IR, { Gateway_p_1_loop: { asyncAfter: true } }),
      [
        'process p {',
        '  var count: any',
        '  start S',
        '  while (count < 10) (asyncAfter: true) {',
        '    user W(label: "Work")',
        '  }',
        '  end E',
        '}',
      ],
      [['WhileStatement', ['asyncAfter: true']]],
    ],
    [
      'a do-while prints the loop settings after its condition',
      withJobSettings(DO_WHILE_IR, { Gateway_p_1_loop: { exclusive: false } }),
      [
        'process p {',
        '  var count: any',
        '  start S',
        '  do {',
        '    user W(label: "Work")',
        '  } while (count < 10) (exclusive: false)',
        '  end E',
        '}',
      ],
      [['DoWhileStatement', ['exclusive: false']]],
    ],
    [
      'a parallel prints the fork settings and, join-prefixed, the join settings',
      withJobSettings(PARALLEL_IR, {
        Gateway_p_1_fork: { jobPriority: '5' },
        Gateway_p_1_join: { asyncBefore: true },
      }),
      [
        'process p {',
        '  start S',
        '  parallel (jobPriority: 5, joinAsyncBefore: true) {',
        '    {',
        '      user X(label: "X")',
        '    }',
        '    {',
        '      service Y(class: "com.example.Y")',
        '    }',
        '  }',
        '  end E',
        '}',
      ],
      [['ParallelStatement', ['jobPriority: 5', 'joinAsyncBefore: true']]],
    ],
    [
      'a weighed parallel prints the same head ahead of its branch heads',
      withJobSettings(inclusiveIr('join'), {
        Gateway_p_1_fork: { retryCycle: CYCLE },
        Gateway_p_1_join: { exclusive: false },
      }),
      [
        'process p {',
        '  var amount: any',
        '  start S',
        '  parallel (retryCycle: "R3/PT10M", joinExclusive: false) {',
        '    if (amount > 10000) {',
        '      user Audit',
        '    }',
        '    {',
        '      user Record',
        '    }',
        '  }',
        '  end E',
        '}',
      ],
      [
        [
          'ParallelStatement',
          ['retryCycle: "R3/PT10M"', 'joinExclusive: false'],
        ],
      ],
    ],
    [
      'an await prints the race settings and, join-prefixed, the merge settings',
      withJobSettings(RACE_IR, {
        Gateway_p_1_race: { asyncBefore: true },
        Gateway_p_1_join: { asyncBefore: true },
      }),
      [
        'process p {',
        '  start S',
        '  await (asyncBefore: true, joinAsyncBefore: true) {',
        '    message("Paid") {',
        '      user Ship',
        '    }',
        '    timer("P3D") {',
        '      user Chase',
        '    }',
        '  }',
        '  end E',
        '}',
      ],
      [['RaceStatement', ['asyncBefore: true', 'joinAsyncBefore: true']]],
    ],
  ] as const)('%s', async (_title, ir, expected, parens) => {
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(`${expected.join('\n')}\n`);
    expect(warnings).toEqual([]);
    expect(await headParens(await printed(ir))).toEqual(parens);
    expect(gatewaySettings(await reDesugar(source))).toEqual(
      gatewaySettings(ir),
    );
  });

  /** `S -> G -> A -> E` with a one-way `G` no statement stands for. */
  const LONE_PASS_THROUGH_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      gateway('G'),
      { kind: 'userTask', id: 'A' },
      { kind: 'endEvent', id: 'E' },
    ],
    flowChain('S', 'G', 'A', 'E'),
  );

  // Revert symptom: delete the sweep at the end of `Emitter.emit` -> every row
  // red on the missing report.
  it.each([
    [
      'a one-way split the flow walks through',
      LONE_PASS_THROUGH_IR,
      'G',
      [['droppedSetting', 'G']],
    ],
    [
      'a merge a jump forwards through',
      PASS_THROUGH_IR,
      'Gateway_p_9_join',
      [
        ['degradedSplit', 'A'],
        ['droppedSetting', 'Gateway_p_9_join'],
      ],
    ],
    [
      'a fork degraded to jumps',
      GOTO_INTO_FORK_IR,
      'Gateway_p_1_fork',
      [
        ['degradedSplit', 'Gateway_p_1_fork'],
        ['droppedEdge', 'Gateway_p_1_fork'],
        ['droppedSetting', 'Gateway_p_1_fork'],
      ],
    ],
  ] as const)(
    'reports the settings of %s once and writes none of them',
    (_title, ir, id, reports) => {
      const { source, warnings } = printDsl(
        withJobSettings(ir, { [id]: { asyncBefore: true, jobPriority: '7' } }),
      );

      expect(source).toBe(irToDsl(ir));
      expectReports(warnings, ...reports);
    },
  );
});
