/**
 * `irToDsl` is the inverse of the desugaring `astToIr`: it turns a flat,
 * BPMN-shaped IR back into structured DSL source. The IR fixtures are inline
 * literals matching byte-for-byte what `astToIr` emits for the corresponding
 * source, so the idempotence assertions are exact rather than
 * reachability-based.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { irToDsl as printDsl, UNSTRUCTURED_MARKER } from '../src/ir-to-dsl.js';
import { astToIr } from '../src/ast-to-ir.js';
import { xmlToIr } from '../src/xml-to-ir.js';
import { isGateway } from '../src/ir/types.js';
import { bpmnDoc } from './helpers/bpmn-doc.js';
import {
  around,
  boundaryEvent,
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
  FlowElement,
  IntermediateCatchEvent,
  LoopCharacteristics,
  SequenceFlow,
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
  cancelOutsideAttempt:
    "A cancel end belongs directly inside an 'attempt' block",
  undoOutsideBlock: 'An undo block belongs directly inside the',
  undoAlongside: 'there is no running flow to run alongside',
  hostOutsideContainer:
    "Could not resolve reference to Statement named 'Elsewhere'",
  orphanStep: 'This step can never run',
  duplicateTimeout: "Duplicate 'on timeout' listener",
  deadElse: 'could never run',
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
  '      user X "X"\n' +
  '    }\n' +
  '    {\n' +
  '      service Y { class = "com.example.Y" }\n' +
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
  '  start S\n' +
  '  user A "A task"\n' +
  '  if (amount > 1000) {\n' +
  '    user B "B task"\n' +
  '  } else {\n' +
  '    service C { class = "com.example.C" }\n' +
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
        '  start S\n' +
        '  while (count < 10) {\n' +
        '    user W "Work"\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    ],
    [
      'restructures a desugared do-while to `do { } while (...)`',
      DO_WHILE_IR,
      'process p {\n' +
        '  start S\n' +
        '  do {\n' +
        '    user W "Work"\n' +
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
      'process invoice-approval "Invoice Approval" {\n' +
        '  start ReviewStart\n' +
        '  user ReviewInvoice "Review invoice" { assignee = "demo" }\n' +
        '  if (amount > 1000) {\n' +
        '    user SeniorApproval "Senior approval" { assignee = "manager" }\n' +
        '  } else {\n' +
        '    service AutoApprove "Auto-approve" { class = "com.example.invoice.AutoApproveDelegate" }\n' +
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
    expect(dsl).toContain('end Approved "Approved"');
    expect(dsl).toContain('end Rejected "Rejected"');

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
      'renders a class binding as `service X { class = "..." }` (byte-unchanged)',
      serviceTask('Charge', classBinding('com.example.Charge')),
      'service Charge { class = "com.example.Charge" }',
      undefined,
      'class',
    ],
    [
      'keeps a labeled class binding identical to the historical output (regression)',
      {
        kind: 'serviceTask',
        id: 'AutoApprove',
        name: 'Auto-approve',
        binding: classBinding('com.example.invoice.AutoApproveDelegate'),
      },
      'service AutoApprove "Auto-approve" { class = "com.example.invoice.AutoApproveDelegate" }',
      undefined,
      'class',
    ],
    [
      'renders an expression binding as `service X { expression = "${...}" }`',
      serviceTask('Calc', exprBinding('${greeter.hello(execution)}')),
      'service Calc { expression = "${greeter.hello(execution)}" }',
      undefined,
      'expression',
    ],
    [
      'renders a delegateExpression binding with the `delegate` alias',
      serviceTask('Ship', delegateBinding('${shipDelegate}')),
      'service Ship { delegate = "${shipDelegate}" }',
      // The XML-level `delegateExpression` name never surfaces in the source.
      'delegateExpression',
      'delegateExpression',
    ],
    [
      'renders an external binding as `service X { topic = "..." }`',
      serviceTask('Notify', externalBinding('notifications')),
      'service Notify { topic = "notifications" }',
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

describe('irToDsl: task kinds', () => {
  /** Statement lines, indentation stripped, so a match is the whole statement. */
  const statements = async (ir: BpmnProcess): Promise<string[]> =>
    (await printed(ir)).split('\n').map((line) => line.trim());

  it.each([
    [
      'a plain task prints as a step statement',
      { kind: 'task', id: 'Draft' },
      'step Draft',
      'step Draft "Draft it"',
    ],
    [
      'a receive task names its message in the block',
      { kind: 'receiveTask', id: 'Wait', messageName: 'OrderPaid' },
      'receive Wait { message = "OrderPaid" }',
      'receive Wait "Draft it" { message = "OrderPaid" }',
    ],
    [
      'a send element prints under the send keyword',
      {
        kind: 'serviceTask',
        id: 'Notify',
        element: 'send',
        binding: classBinding('com.example.Notify'),
      },
      'send Notify { class = "com.example.Notify" }',
      'send Notify "Draft it" { class = "com.example.Notify" }',
    ],
    [
      'a businessRule element prints under the decide keyword',
      {
        kind: 'serviceTask',
        id: 'Rate',
        element: 'businessRule',
        binding: { kind: 'decision', decisionRef: 'riskRating' },
      },
      'decide Rate { decision = "riskRating" }',
      'decide Rate "Draft it" { decision = "riskRating" }',
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
    expect(await statements(rate)).toContain(
      'decide Rate { decision = "riskRating" binding = latest ' +
        'mapDecisionResult = singleEntry resultVariable = "risk" }',
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
      'script Compute "Compute totals" ```javascript',
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
        '    user Work { assignee = "demo" }\n' +
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
      'subprocess Sub "Handle order" {',
    ],
    [
      'prints an empty named sub-process body as an opening brace immediately followed by a closing one',
      { ...chainedSub('Sub', []), name: 'Handle order' },
      '  subprocess Sub "Handle order" {\n  }\n',
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
  it('prints the full single-line form in canonical member order with shorthand', async () => {
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
      'call CallSub "Call sub" { process = "sub-process" binding = deployment ' +
        'businessKey = "${execution.processBusinessKey}" ' +
        'in * in amount in y = x in local doubled = "${total * 2}" ' +
        'out outcome = result out final = "${status}" out local * }',
    );
  });

  it.each([
    [
      'prints a minimal call as `call X { process = "p" }`',
      undefined,
      'call X { process = "p" }',
      undefined,
    ],
    [
      'prints `binding = latest` for a latest binding',
      { kind: 'latest' },
      'call X { process = "p" binding = latest }',
      undefined,
    ],
    [
      'prints only `version = 3` for a numeric version binding (no `binding` key)',
      { kind: 'version', version: '3' },
      'call X { process = "p" version = 3 }',
      'binding =',
    ],
    [
      'prints a non-numeric version quoted verbatim',
      { kind: 'version', version: '${v}' },
      'call X { process = "p" version = "${v}" }',
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
        '  call Mid { process = "sub" }\n' +
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
      errorMessages: [{ code: 'PF', message: 'boom' }],
    };

    expect(await printed(ir)).toBe(
      [
        'process proc {',
        '  error "PF" message "boom"',
        '  start PStart',
        '  user Work',
        '  emit escalation Ping "LS"',
        '  throw error Boom "PF"',
        '  on error "PF" (code c, message m) {',
        '    start PFStart',
        '    user Recover',
        '    end PFEnd',
        '  }',
        '  on escalation "LS" (code v) alongside {',
        '    start LSStart',
        '    user Note',
        '    end LSEnd',
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
    expect(dsl).toContain('throw escalation Esc "X"');
    expect(dsl).not.toContain('end Esc');
  });

  // An undo block only belongs inside the block whose work it undoes, so the
  // process-level fixture draws that refusal from the model it was built from.
  it.each([
    ['error', errorDef('C'), '\n  on error "C" {\n', undefined],
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
    expect(dsl).toContain('  emit signal EmitSig "Cancelled"\n');
    expect(dsl).toContain('  throw signal ThrowSig "Cancelled"\n');
    expect(dsl).toContain('  on message "PaymentReceived" {\n');
    expect(dsl).toContain('  on signal "Cancelled" alongside {\n');
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
      '  on timer after "PT1H" {\n',
      undefined,
    ],
    [
      'a date timer as `at`',
      timerDef('date', '2026-08-01T09:00:00'),
      '  on timer at "2026-08-01T09:00:00" {\n',
      undefined,
    ],
    [
      'a repeating timer as `every`, alongside for a non-interrupting handler',
      timerDef('cycle', 'R/PT10M'),
      '  on timer every "R/PT10M" alongside {\n',
      false,
    ],
    [
      'a condition in the expression subset as bare DSL',
      conditionDef('${amount > 100}'),
      '  on condition (amount > 100) {\n',
      undefined,
    ],
    [
      'a condition out of the subset as a quoted raw fallback',
      conditionDef('${bean.check()}'),
      '  on condition ("${bean.check()}") {\n',
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
      'throw message Sent "Ack" { class = "com.example.Send" }',
    );

    const emitted = around({
      ...typedEvent('intermediateThrowEvent', 'Ping', messageDef('Ack')),
      binding: externalBinding('send-ack'),
    });
    expect(await printed(emitted)).toContain(
      'emit message Ping "Ack" { topic = "send-ack" }',
    );
  });

  it('refuses a throw-side event carrying a non-throwable definition', () => {
    const badEnd: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('endEvent', 'Bad', conditionDef('${true}')),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'Bad' }],
    );
    expect(() => irToDsl(badEnd)).toThrow(/conditional/);

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
    ['message', messageDef('OrderReceived'), 'start S message "OrderReceived"'],
    ['signal', signalDef('Cancelled'), 'start S signal "Cancelled"'],
    ['timer after', timerDef('duration', 'PT1H'), 'start S timer after "PT1H"'],
    [
      'timer at',
      timerDef('date', '2026-08-01T09:00:00'),
      'start S timer at "2026-08-01T09:00:00"',
    ],
    [
      'timer every',
      timerDef('cycle', 'R/PT10M'),
      'start S timer every "R/PT10M"',
    ],
  ])(
    'prints a top-level start carrying a %s trigger',
    async (_title, def, expected) => {
      expect(await printed(startWith(def))).toContain(expected);
    },
  );

  it('prints the label before the trigger', async () => {
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
      'start S "Order in" message "OrderReceived"',
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
    expect(await printed(ir, 'reservedId')).toContain(
      'start StartEvent_p message "OrderReceived"',
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
      '  on message "PaymentReceived" {\n    start MsgStart\n',
    );
    expect(dsl).not.toContain('start MsgStart message');
    expect(dsl).not.toContain('StartEvent_OnSig');
    expect(dsl).toContain('  on signal "Cancelled" {\n    end SigEnd\n  }\n');
    // The trigger appears exactly once: in the `on` header, never on the start.
    expect(dsl.split('message "PaymentReceived"')).toHaveLength(2);
    expect(dsl.split('signal "Cancelled"')).toHaveLength(2);
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
      'end Stop "All stop" terminate',
    ],
    [
      'a synthesized terminate end, rather than dropping it',
      typedEvent('endEvent', 'EndEvent_p', { kind: 'terminate' }),
      ['reservedId'],
      'end EndEvent_p terminate',
    ],
    [
      'a cancel end with its label',
      {
        ...typedEvent('endEvent', 'GiveUp', { kind: 'cancel' }),
        name: 'Give up the booking',
      },
      ['cancelOutsideAttempt'],
      'end GiveUp "Give up the booking" cancel',
    ],
    [
      'a synthesized cancel end, rather than dropping it',
      typedEvent('endEvent', 'EndEvent_p', { kind: 'cancel' }),
      ['reservedId', 'cancelOutsideAttempt'],
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
    const dsl = await printed(ir, 'reservedId');
    expect(dsl).toContain('end EndEvent_1 "Abandon all" terminate');

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
      'attempt Book "Book and pay" for each line in lines { asyncBefore = true } {\n',
    );
    expect(await printed(around(book()))).toContain(
      'subprocess Book "Book and pay" for each line in lines { asyncBefore = true } {\n',
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
    ['a message catch', messageDef('M'), '  await message "M"\n'],
    [
      'a duration timer catch',
      timerDef('duration', 'PT1H'),
      '  await timer after "PT1H"\n',
    ],
    ['a signal catch', signalDef('S'), '  await signal "S"\n'],
    [
      'a conditional catch, bare DSL in the expression subset',
      conditionDef('${amount > 100}'),
      '  await condition (amount > 100)\n',
    ],
  ] as const)(
    'prints %s inline between the surrounding steps',
    async (_title, def, statement) => {
      expect(await printed(catchBody(def))).toBe(
        'process proc {\n  start S\n  user Before\n' +
          statement +
          '  user After\n  end E\n}\n',
      );
    },
  );
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
      '  on compensation alongside {\n',
    );
  });
});

// A boundary event is the only IR node with outgoing but no incoming flow, so
// its chain is unreachable from the start event and a pass of its own prints
// it, before the orphan sweep would flush it as a detached top-level chain.
// The chain lives in the same container as the main flow, so the shared
// emitted-node bookkeeping is what makes a rejoin degrade to a `goto`.

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
        '  on Review: timer after "PT2H" {',
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
      ['  on Pack: message "Nudge" alongside {\n', '    end Nudged\n'],
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
      ['  on Review: timer every "R/PT1H" {\n  }\n'],
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
      ['  on Elsewhere: message "M" {\n  }\n'],
      // The host the model names is nowhere for the compiler to resolve.
      ['hostOutsideContainer'],
    ],
  ] as const)('prints %s', async (_title, host, rest, flows, has, refused) => {
    const dsl = await printed(boundaryIr(host, rest, flows), ...refused);
    for (const text of has) expect(dsl).toContain(text);
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
    expect(dsl).toContain('  on Fetch: error "GONE" {\n');
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
    expect(dsl).toContain('  on Review: signal "Abort" {\n');
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
    const timer = dsl.indexOf('on Review: timer after "PT2H" {');
    const escalation = dsl.indexOf('on Review: escalation "LOUD" (code c) {');
    expect(timer).toBeGreaterThan(-1);
    expect(escalation).toBeGreaterThan(timer);
    // Each boundary prints exactly one header: neither the escape-chain walk
    // nor the orphan sweep may print a boundary a second time.
    expect(dsl.match(/^ *on Review: /gm)).toHaveLength(2);
  });

  it('keeps the handler block trailing when the body also flushes sweep gotos', async () => {
    const source = [
      'process p {',
      '  var r: string',
      '  user Intake',
      '  if (r == "A") { goto Alpha } else { goto Beta }',
      '  user Alpha',
      '  user Beta',
      '  end E',
      '  on Intake: error "X" { user Fix }',
      '}',
      '',
    ].join('\n');
    const doc = await parse(source);
    expect(doc.parseResult.parserErrors).toHaveLength(0);

    const dsl = irToDsl(astToIr(doc.parseResult.value));
    // A handler reads like a catch block: no ordinary statement, and in
    // particular no swept `goto`, may follow it.
    expect(dsl.indexOf('on Intake: error "X" {')).toBeGreaterThan(
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
    expect(dsl.indexOf('on Review: error "X" {')).toBeGreaterThan(
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
    expect(dsl).toContain('on A: error "X" {');
    expect(dsl).toContain('user Fix');
    // Printed at its arrival point and nowhere else: the boundary pass must
    // find it already emitted.
    expect(dsl.match(/^ *on A: /gm)).toHaveLength(1);
  });

  it('prints a boundary event before a host-less handler in the same container', async () => {
    const ir = boundaryIr(
      'Review',
      [
        triggeredSub('OnPF', [
          typedEvent('startEvent', 'PFStart', errorDef('PF')),
          { kind: 'endEvent', id: 'PFEnd' },
        ]),
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('duration', 'PT2H'),
        ),
        { kind: 'endEvent', id: 'Late' },
      ],
      [{ id: 'F3', sourceRef: 'Boundary_Review_timer', targetRef: 'Late' }],
    );
    const dsl = await printed(ir);
    expect(dsl.indexOf('on Review: timer')).toBeGreaterThan(-1);
    expect(dsl.indexOf('on error "PF" {')).toBeGreaterThan(
      dsl.indexOf('on Review: timer'),
    );
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
    expect(await printed(ir)).toContain('    on Check: condition (stale) {\n');
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
      'throw message Ack "Ack"',
    ],
    [
      'a synthesized message end',
      'endEvent',
      'Throw_p_1',
      messageDef('Ack'),
      'throw message "Ack"',
    ],
    [
      'an authored error end',
      'endEvent',
      'PaymentFailed',
      errorDef('PF'),
      'throw error PaymentFailed "PF"',
    ],
    [
      'a synthesized escalation end',
      'endEvent',
      'Throw_p_1',
      escalationDef('ESC'),
      'throw escalation "ESC"',
    ],
    [
      'an authored message emit',
      'intermediateThrowEvent',
      'Notify',
      messageDef('Ack'),
      'emit message Notify "Ack"',
    ],
    [
      'a synthesized message emit',
      'intermediateThrowEvent',
      'Throw_p_2',
      messageDef('Ack'),
      'emit message "Ack"',
    ],
    [
      'a synthesized signal emit',
      'intermediateThrowEvent',
      'Throw_p_2',
      signalDef('Ping'),
      'emit signal "Ping"',
    ],
  ] as const)('prints %s', async (_title, kind, id, def, expected) => {
    const node = typedEvent(kind, id, def);
    const dsl = await printed(
      kind === 'endEvent' ? terminating(node) : around(node),
    );
    expect(dsl).toContain(expected);
    expect(dsl).not.toContain('Throw_');
  });

  // `StartEvent_1` is the id a modeler mints, so a labeled start drawn in one
  // arrives under a synthesized-shaped id rather than an authored one. Printing
  // it would write a name the validator rejects, so the statement is left out
  // and the label it carried is reported at import instead.
  it('reports the label a synthesized start and end take with them, and prints neither', async () => {
    const { ir, warnings } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="StartEvent_1" name="Order Received" />
    <bpmn:userTask id="Approve" />
    <bpmn:endEvent id="EndEvent_1" name="Order Filed" />
    <bpmn:sequenceFlow id="F1" sourceRef="StartEvent_1" targetRef="Approve" />
    <bpmn:sequenceFlow id="F2" sourceRef="Approve" targetRef="EndEvent_1" />`);
    expect(warnings.map((w) => [w.category, w.elementId])).toEqual([
      ['label', 'StartEvent_1'],
      ['label', 'EndEvent_1'],
    ]);
    expect(warnings[0]?.message).toContain('Order Received');
    expect(warnings[1]?.message).toContain('Order Filed');

    const dsl = irToDsl(ir);
    expect(dsl).not.toContain('StartEvent_1');
    expect(dsl).not.toContain('EndEvent_1');
    expect(dsl).not.toContain('Order Received');
    expect(dsl).not.toContain('Order Filed');
  });

  // The trigger moves into the `on` header, so nothing else holds the start
  // inside a handler body either.
  it("reports the label an event handler's synthesized trigger start takes with it", async () => {
    const { ir, warnings } = await xmlToIr(bpmnDoc`
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="StartEvent_9" name="Restock Heard">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />`);
    expect(warnings.map((w) => [w.category, w.elementId])).toEqual([
      ['label', 'StartEvent_9'],
    ]);
    expect(warnings[0]?.message).toContain('Restock Heard');

    const dsl = irToDsl(ir);
    expect(dsl).toContain('on error {');
    expect(dsl).not.toContain('StartEvent_9');
    expect(dsl).not.toContain('Restock Heard');
  });
});

describe('irToDsl: guard-clause continuation', () => {
  it('recovers a throw-guard `if` with the continuation at the body level and no gateway token', async () => {
    // `if (c) { throw }` with no else: the then-branch terminates, the default
    // continues the main flow. There is no clean post-dominating join, so the
    // fallback consumes the sole default edge as the continuation.
    const ir = await reDesugar(`process p {
  start S
  service Pre { class = "x.Pre" }
  if (amount > 1000) {
    throw error "BOOM"
  }
  service Post { class = "x.Post" }
  end Done
}
`);
    const dsl = await expectIdempotent(ir);

    // Both the split and the join are elided, so no synthesized gateway id
    // appears and nothing jumps to one.
    expect(dsl).not.toContain('goto Gateway_');
    expect(dsl).not.toContain('Gateway_');

    // The guard's terminal prints inline, not as a jump to the throw node.
    expect(dsl).toContain('throw error "BOOM"');
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
  start S
  while (retries < 3) {
    service A { class = "x.A" }
    if (retries < 1) {
      throw error "X"
    }
    service B { class = "x.B" }
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
        '  start S\n' +
        '  while (more) {\n' +
        '    user Work\n' +
        '  }\n' +
        '  if (escalate) {\n' +
        '    goto Escalate\n' +
        '  }\n' +
        '  end E\n' +
        '  user Escalate\n' +
        '  end E2\n' +
        '}\n',
    ],
    [
      'post-test',
      POST_TEST_IR,
      'process p {\n' +
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
});

describe('irToDsl: never emit a goto to a gateway', () => {
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

  it('forwards a goto through a one-out pass-through gateway to the real successor', async () => {
    const dsl = irToDsl(PASS_THROUGH_IR);
    // The jump names the real successor, never the elided gateway.
    expect(dsl).toContain('goto R');
    expect(dsl).not.toContain('goto Gateway_');
    expect(dsl).not.toContain('Gateway_p_9_join');
    await reDesugar(dsl);
  });

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
  error "BOOM" message "it broke"
  start Begin
  parallel {
    { service A "a" { class = "x.A" } }
    { throw error "BOOM" }
  }
  end Finish
}
`);
    const dsl = await expectIdempotent(ir);

    expect(dsl).toContain('parallel {');
    // Both branch bodies print inline; the terminating branch prints its throw
    // in place, never as a jump to the (un-nameable) synthesized throw node.
    expect(dsl).toContain('service A "a" { class = "x.A" }');
    expect(dsl).toContain('throw error "BOOM"');

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
  error "BOOM" message "it broke"
  start Begin
  parallel {
    {
      parallel {
        { service A "a" { class = "x.A" } }
        { service B "b" { class = "x.B" } }
      }
    }
    {
      parallel {
        { service C "c" { class = "x.C" } }
        { service D "d" { class = "x.D" } }
      }
    }
    { throw error "BOOM" }
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

describe('irToDsl: engine attributes', () => {
  /**
   * One of every statement kind that has an attribute block, each carrying at
   * least one engine attribute, plus a boundary handler whose escape chain is a
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
        binding: classBinding('com.example.C'),
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

  it('renders a block on every statement kind that has one, in a fixed member order', async () => {
    const dsl = await printed(ENGINE_IR, 'reservedId');
    expect(dsl).toContain('start S { asyncAfter = true }');
    expect(dsl).toContain(
      'user U "Review" { assignee = "ana" formKey = "embedded:app:forms/r.html" ' +
        'candidateGroups = "ops" candidateUsers = "ana,bo" dueDate = "${due}" ' +
        'followUpDate = "P1D" priority = 20 asyncBefore = true exclusive = false ' +
        'jobPriority = 50 retryCycle = "R3/PT10M" form { amount: number } }',
    );
    expect(dsl).toContain(
      'service V { class = "com.example.C" resultVariable = "res" asyncBefore = true }',
    );
    expect(dsl).toContain(
      'script Sc { resultVariable = "out" asyncAfter = true } ```javascript',
    );
    expect(dsl).toContain(
      'call C { process = "other" businessKey = "bk" asyncBefore = true in * }',
    );
    expect(dsl).toContain('subprocess Sub { asyncBefore = true } {');
    expect(dsl).toContain('await timer after "PT1H" { asyncBefore = true }');
    expect(dsl).toContain('emit escalation "ESC" { exclusive = false }');
    expect(dsl).toContain('end E { asyncBefore = true }');
    expect(dsl).toContain('throw error Failed "PF" { asyncAfter = true }');

    // Both handler headers put the block before the body brace.
    expect(dsl).toContain('on U: error "BOOM" { asyncBefore = true } {');
    expect(dsl).toContain('on escalation "ESC" { asyncBefore = true } {');

    // versionTag is a process-header declaration rather than a member.
    expect(dsl).toContain('\n  versionTag = "3.1"\n');
  });

  it('prints no block at all for a node carrying no engine attributes', async () => {
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
    expect(dsl).toContain('\n  start S\n');
    expect(dsl).toContain('\n  user U\n');
    expect(dsl).toContain('\n  await signal "Ping"\n');
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
    expect(dsl).toContain('user A { asyncBefore = true asyncAfter = true }');
    expect(dsl).toContain('user B { exclusive = false }');
    expect(dsl).not.toContain('"true"');
    expect(dsl).not.toContain('"false"');
  });

  it('prints an all-digit priority bare and any other value quoted', async () => {
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
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'A', 'B', 'E'),
      ),
    );
    expect(dsl).toContain('user A { priority = 7 jobPriority = 50 }');
    expect(dsl).toContain(
      'user B { priority = "${p}" jobPriority = "${order.rush}" }',
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
      'end EndEvent_p { asyncBefore = true }',
      ['reservedId'],
    ],
    [
      'a terminate on an end, which cannot be re-derived',
      'end',
      { eventDefinition: { kind: 'terminate' } },
      'end EndEvent_p terminate',
      ['reservedId'],
    ],
    [
      'a listener on an end',
      'end',
      { executionListeners: DONE_LISTENERS },
      'end EndEvent_p { on end { class = "com.example.Done" } }',
      ['reservedId'],
    ],
    [
      "an id carrying another kind's synthesized prefix on an end, authored here",
      'end',
      { id: 'StartEvent_p' },
      'end StartEvent_p',
      ['reservedId'],
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
      'start StartEvent_p { asyncBefore = true }',
      ['reservedId'],
    ],
    [
      "an id carrying another kind's synthesized prefix on a start, authored here",
      'start',
      { id: 'EndEvent_p' },
      'start EndEvent_p',
      ['reservedId'],
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
        expect(dsl).toContain(UNSTRUCTURED_MARKER);
      } else {
        expect(dsl).toContain(expected);
        expect(dsl).toContain(`goto ${id}`);
        expect(dsl).not.toContain(UNSTRUCTURED_MARKER);
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
      'service V { topic = "charge" input plain = "ready" ' +
        'input expr = "${order.id}" input items = [] ' +
        'output code = "200" output blank = {} }',
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
      'user U { input rows = ["a", { "k": "v", "end": "z" }] ' +
        'input lookup = { "ids": ["x"], "with space": "w" } }',
    );
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
    expect(dsl).toContain('user U { input total = ```groovy\nsum(a, b)\n``` }');
  });

  it('keeps a script task readable with a fenced value in its block', async () => {
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
      'script Sc { input seed = ```groovy\nseed()\n``` } ```javascript\nx = 1;\n```',
    );
  });

  it('prints the block before the body on a sub-process and before the mappings on a call', async () => {
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
    // An empty map ending the block puts `{}` `}` `{` in a row, the sequence the
    // body brace has to be told apart from.
    expect(dsl).toContain(
      'subprocess Sub { input seed = "1" input extra = {} } {',
    );
    expect(dsl).toContain(
      'call C { process = "other" output total = "${sum}" in * }',
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
      'user U { on start { class = "com.example.Enter" } ' +
        'on end { expression = "${audit.log()}" } ' +
        'on create { delegate = "${assignHook}" } }',
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
      'service V { class = "com.example.C" on end ```groovy\n' +
        "println 'bye'\n" +
        '``` }',
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
      // The model carries two of one listener; the surface holds one, so it
      // is the model the compiler refuses, not the print.
      'duplicateTimeout',
    );
    expect(dsl).toContain(
      'user U { on timeout after "PT1H" { class = "com.example.T" } ' +
        'on timeout at "${deadline}" { class = "com.example.D" } }',
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
      'await signal "Ping" { on start { class = "com.example.W" } }',
    );
    expect(dsl).toContain(
      'on escalation "ESC" { on end { class = "com.example.H" } } {',
    );
  });

  it('prints scalars, parameters, listeners, and the form block in one fixed order', async () => {
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
      'user U "Review" { assignee = "ana" asyncBefore = true ' +
        'input seed = "1" output note = "${n}" ' +
        'on start { class = "com.example.Enter" } ' +
        'on complete { class = "com.example.Done" } ' +
        'form { amount: number } }',
    );
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

  /** Print one repeated element, wired `S -> el -> E`, with its settings block. */
  const printRepeated = (
    el: RepeatableElement,
    loop: LoopCharacteristics,
  ): string => irToDsl(around({ ...el, asyncBefore: true, loop }));

  /** Every kind that can repeat, with the head and the tail its clause sits between. */
  const KINDS = [
    [
      { kind: 'task', id: 'Record', name: 'Record it' },
      'step Record "Record it"',
      ' { asyncBefore = true }',
    ],
    [
      { kind: 'userTask', id: 'Approve', name: 'Approve it' },
      'user Approve "Approve it"',
      ' { asyncBefore = true }',
    ],
    [
      {
        kind: 'serviceTask',
        id: 'Notify',
        name: 'Notify them',
        element: 'send',
        binding: classBinding('com.example.Notify'),
      },
      'send Notify "Notify them"',
      ' { class = "com.example.Notify" asyncBefore = true }',
    ],
    [
      {
        kind: 'scriptTask',
        id: 'Compute',
        name: 'Compute it',
        format: 'javascript',
        code: 'x = 1',
      },
      'script Compute "Compute it"',
      ' { asyncBefore = true } ```javascript',
    ],
    [
      {
        kind: 'receiveTask',
        id: 'Wait',
        name: 'Wait for it',
        messageName: 'OrderPaid',
      },
      'receive Wait "Wait for it"',
      ' { message = "OrderPaid" asyncBefore = true }',
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
      'subprocess Fulfil "Fulfil it"',
      ' { asyncBefore = true } {',
    ],
    [
      {
        kind: 'callActivity',
        id: 'Regional',
        name: 'Run it',
        calledElement: 'regional-report',
      },
      'call Regional "Run it"',
      ' { process = "regional-report" asyncBefore = true }',
    ],
  ] as const satisfies ReadonlyArray<
    readonly [RepeatableElement, string, string]
  >;

  it.each(KINDS)(
    'prints the clause between the label and the block of %#',
    (el, head, tail) => {
      expect(printRepeated(el, OVER_LINES)).toContain(
        `${head} for each line in lines${tail}`,
      );
    },
  );

  it.each(KINDS)(
    'leaves %# untouched when it carries no loop',
    (el, head, tail) => {
      expect(irToDsl(around({ ...el, asyncBefore: true }))).toContain(
        `${head}${tail}`,
      );
    },
  );

  it.each([
    [
      { collection: 'lines', elementVariable: 'line' },
      'for each line in lines',
    ],
    [{ collection: 'lines' }, 'for each in lines'],
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
        `step Record ${clause} { asyncBefore = true }`,
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
      ['form { lines: string }'],
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
      ['on error "BOOM" (code c, message m)', 'on escalation "OVER" (code x)'],
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

// `printDsl` is the real entry point; the alias above unwraps `.source` for
// every suite that only asserts printed text.

/**
 * What each report says, keyed by the degradation it reports. `says` is every
 * phrase its message must carry; `never` is the phrase of a neighbouring report
 * it must not, which is what keeps two of them from collapsing into one.
 */
const REPORT = {
  label: { category: 'label', says: ['block structure'] },
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
      'at most one branch is left running',
    ],
  },
  implicitSplit: {
    category: 'degradedSplit',
    says: ['takes every route it can at once', 'which takes one of them'],
  },
  inventedFallback: {
    category: 'defaultFlow',
    says: ['names no fallback', 'what runs changes'],
  },
  inventedStepFallback: {
    category: 'defaultFlow',
    says: [
      'this tool carries a fallback on a split alone',
      'carrying on is what was meant',
    ],
    // The import reports the fallback the model named, so claiming the model
    // named none would contradict it.
    never: ['names no fallback'],
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

describe('warnings: labels the script has nowhere to write', () => {
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
    expect(ring.source).not.toContain('goto');
    // `S` leaves on two routes, which is its own report, and the ring is
    // reached twice: once from the branch that opens on it, and once from the
    // sweep that picks up what the walk left unprinted.
    expectReports(
      ring.warnings,
      ['implicitSplit', 'S'],
      ['droppedEdge', 'Ring1'],
      ['droppedEdge', 'Ring1'],
    );
  });

  it('returns no warnings at all for a process that prints in full', () => {
    expect(printDsl(around({ kind: 'userTask', id: 'A' })).warnings).toEqual(
      [],
    );
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
    expect(source).not.toContain(UNSTRUCTURED_MARKER);
    expectReports(warnings, ['degradedSplit', 'Gateway_p_1_fork']);
  });
});

describe('a step whose own routes split', () => {
  /**
   * A step with two routes on, one of them weighed. Legal BPMN, and a shape a
   * jump cannot carry: a jump ends its block, so a second route written as one
   * severs the first route's chain behind it.
   */
  const implicitSplitIr = (condition?: string): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'userTask', id: 'C' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        edge('S', 'A'),
        edge('A', 'B', condition === undefined ? {} : { condition }),
        edge('A', 'C'),
        edge('B', 'E'),
        edge('C', 'E'),
      ],
    );

  it('keeps both routes, their condition, and source that compiles', async () => {
    const ir = implicitSplitIr('${ok}');
    const dsl = await printed(ir);

    expect(dsl).toContain('if (ok) {');
    // The route that would have been severed behind a jump.
    expect(realReachability(await reDesugar(dsl))).toEqual(
      realReachability(ir),
    );
  });

  it('reports the choice it wrote, naming the step the routes leave', () => {
    const { warnings } = printDsl(implicitSplitIr('${ok}'));

    expectReports(warnings, ['implicitSplit', 'A']);
  });

  it('says it whether or not a route is weighed, the model taking both either way', () => {
    expectReports(printDsl(implicitSplitIr()).warnings, ['implicitSplit', 'A']);
  });

  it('says it for a step the loop around it left one route to print', () => {
    // `Review` runs the escape and the route back at once. The loop prints the
    // route back as its closing brace, leaving one route at the step's own
    // position, and the script runs the escape in place of looping rather than
    // beside it. What splits is what the model gives the step, so the question
    // is asked of that.
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

    expectReports(
      warnings,
      ['implicitSplit', 'Review'],
      ['droppedFlowCondition', 'Review'],
    );
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

      expect(source).not.toContain('approved');
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
      expect(source).not.toContain('settled');
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
      ['droppedEdge', 'Split'],
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
    expect(source).not.toContain('approved');
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
  const TWO_BRANCH_SOURCE =
    'process p {\n' +
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
    // branches that print, not off the model's edges.
    const ir = inclusiveIr('join');
    const { source, warnings } = printDsl(ir);

    expect(source).toBe(TWO_BRANCH_SOURCE);
    expect(warnings).toEqual([]);
    await expectIdempotent(ir);
  });

  it('says nothing about a fallback while one branch is unconditioned, that branch being taken whatever the conditions do', () => {
    const { source, warnings } = printDsl(inclusiveIr('none'));

    // The same two branches as the case above, reached without a default flow.
    expect(source).toBe(TWO_BRANCH_SOURCE);
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
    expect(source).not.toContain('urgent');
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

    expect(source).toBe(TWO_BRANCH_SOURCE);
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
    expect(source).not.toContain('settled');
    expectReports(warnings, ['forkFallbackCondition', 'Fork']);
  });

  it('reports a weighed fallback that nothing can reach as one that can never fire, beside the condition it leaves out', () => {
    // `Record` runs whatever the conditions do, so the fallback behind `Triage`
    // is left nothing to pick up whether it is weighed or not.
    const { source, warnings } = printDsl(inclusiveIr('branch', '${late}'));

    expect(source).toContain('    else {\n      user Triage\n');
    expect(source).not.toContain('late');
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

  it('reports the invented fallback at a step whose own routes are all weighed, beside the choice it degrades them to', () => {
    // Two reports, each about a different change: the model takes every route
    // whose condition holds and the script takes one, and the model stops where
    // none holds and the script carries on.
    const { warnings } = printDsl(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'Triage' },
          { kind: 'userTask', id: 'Audit' },
          { kind: 'userTask', id: 'Record' },
          gateway('Merge'),
          { kind: 'endEvent', id: 'E' },
        ],
        [
          edge('S', 'Triage'),
          edge('Triage', 'Audit', { condition: '${amount > 10000}' }),
          edge('Triage', 'Record', { condition: '${urgent}' }),
          edge('Audit', 'Merge'),
          edge('Record', 'Merge'),
          edge('Merge', 'E'),
        ],
      ),
    );

    // A step's fallback is not carried into the IR, so the report says what
    // the script does and leaves the model out of it.
    expectReports(
      warnings,
      ['implicitSplit', 'Triage'],
      ['inventedStepFallback', 'Triage'],
    );
  });

  it('leaves the drop reported on import and the fallback reported on print saying the same thing', async () => {
    // The two hops speak about the same step in the same run of the CLI, so a
    // print report claiming the model named no fallback would contradict the
    // import report naming the one it dropped.
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

    expect(imported.map((w) => [w.category, w.elementId])).toEqual([
      ['unmappedConstruct', 'Triage'],
    ]);
    expect(imported[0]?.message).toContain(
      "The 'default' attribute on 'Triage' was not imported",
    );

    expectReports(
      printDsl(ir).warnings,
      ['implicitSplit', 'Triage'],
      ['inventedStepFallback', 'Triage'],
    );
  });

  it('says nothing about a step whose route back into the loop the loop already printed', () => {
    // The route back carries no condition, so `Review` always has it and can
    // never be left with nowhere to go. The loop prints it as the closing
    // brace, which leaves only the weighed escapes at the step's position: the
    // question is asked of the routes the model gives the step, not of the ones
    // still to print.
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
    expectReports(warnings, ['implicitSplit', 'Review']);
  });

  it('keeps the guard-clause continuation when the route the split names carries a condition', async () => {
    // No clean join here: one branch throws while the route the split takes
    // when nothing holds carries the main flow. That route is the continuation
    // whether it carries a condition or not, so the guard clause still prints
    // as one instead of degrading to a pair of jumps.
    const ir = await reDesugar(`process p {
  start S
  if (amount > 1000) {
    throw error "BOOM"
  }
  service Post { class = "x.Post" }
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
        '  start S\n' +
        '  if (amount > 10000) {\n' +
        '    user Audit\n' +
        '  } else {\n' +
        '    user Record\n' +
        '  }\n' +
        '  end E\n' +
        '}\n',
    );
    expect(source).not.toContain('urgent');
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
    expect(dsl).not.toContain('urgent');
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

/** Desugared `await { message "Paid" { user Ship } timer after "P3D" { user Chase } }`. */
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
        '    message "Paid" {\n' +
        '      user Ship\n' +
        '    }\n' +
        '    timer after "P3D" {\n' +
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

    expect(source).toBe(irToDsl(RACE_IR));
    expect(source).not.toContain('overdue');
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

    expect(source).toBe(irToDsl(RACE_IR));
    expect(source).not.toContain('ok');
    expectReports(warnings, ['droppedFlowCondition', 'Catch_p_1_b0']);
  });

  it('writes a branch settings block between the header and the body, and an empty body for a branch that only waits', async () => {
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
        '    message "Paid" { asyncBefore = true } {\n' +
        '    }\n' +
        '    timer after "P3D" {\n' +
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
        '    message "Paid" {\n' +
        '      end Done\n' +
        '    }\n' +
        '    timer after "P3D" {\n' +
        '      end Expired\n' +
        '    }\n' +
        '  }\n' +
        '}\n',
    );
    await expectIdempotent(ir);
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
    expect(source).toContain('await message "Paid"');
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
      expect(source).not.toContain(UNSTRUCTURED_MARKER);
      expectReports(warnings, ['implicitSplit', 'A']);
    },
  );
});
