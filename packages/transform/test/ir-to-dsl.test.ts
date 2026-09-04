/**
 * `irToDsl` is the inverse of the desugaring `astToIr`: it turns a flat,
 * BPMN-shaped IR back into structured DSL source. The IR fixtures are inline
 * literals matching byte-for-byte what `astToIr` emits for the corresponding
 * source, so the idempotence assertions are exact rather than
 * reachability-based.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { irToDsl, UNSTRUCTURED_MARKER } from '../src/ir-to-dsl.js';
import { astToIr } from '../src/ast-to-ir.js';
import {
  around,
  boundaryEvent,
  callActivity,
  chained,
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
import type {
  BpmnProcess,
  EventDefinition,
  FlowElement,
  IntermediateCatchEvent,
  SequenceFlow,
} from '../src/ir/types.js';

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ---------------------------------------------------------------------------
// Normalization helpers (mirror the round-trip contract: IR equivalence up to
// synthesized-id renaming, never byte-for-byte text or literal-id equality).
// ---------------------------------------------------------------------------

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

/** Print `ir`, assert the emitted source re-parses cleanly, and return it. */
async function printed(ir: BpmnProcess): Promise<string> {
  const dsl = irToDsl(ir);
  await reDesugar(dsl);
  return dsl;
}

/**
 * Assert local idempotence up to id normalization: `irToDsl(ir)` re-parses and
 * re-desugars to an IR with the same normalized element + edge multisets as
 * `ir`.
 */
async function expectIdempotent(ir: BpmnProcess): Promise<string> {
  const dsl = await printed(ir);
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
    ir.flowElements
      .filter(
        (e) => e.kind !== 'exclusiveGateway' && e.kind !== 'parallelGateway',
      )
      .map((e) => e.id),
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

/** `true` iff the output contains a top-level `goto` statement. */
function hasGoto(dsl: string): boolean {
  return /\bgoto\s+\w/.test(dsl);
}

/** `true` iff the output contains the `gateway` keyword. */
function hasGatewayKeyword(dsl: string): boolean {
  // A `gateway` statement would read `gateway <id>` at the start of a line.
  return /(^|\n)\s*gateway\s/.test(dsl);
}

// ---------------------------------------------------------------------------
// Inline IR fixtures: the exact shapes `astToIr` emits for each construct.
// ---------------------------------------------------------------------------

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
 * Canonical invoice IR: the `xmlToIr` import shape of the handwritten golden
 * (an XOR split with named branch flows, no explicit join). Drives the
 * "structured restructuring of a real import" assertions.
 */
const INVOICE_IR: BpmnProcess = {
  ...HANDWRITTEN_IMPORT_IR,
  name: 'Invoice Approval',
};

// ---------------------------------------------------------------------------
// 1. Structured restructuring: each construct emits its surface form.
// ---------------------------------------------------------------------------

describe('irToDsl — structured restructuring', () => {
  it('restructures a desugared if/else IR to `if (…) { } else { }` (no `gateway`)', async () => {
    const dsl = irToDsl(IF_ELSE_IR);
    expect(dsl).toContain('if (amount > 1000) {');
    expect(dsl).toContain('} else {');
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  it('restructures a desugared while IR to `while (…) { }` with no `goto`', () => {
    const dsl = irToDsl(WHILE_IR);
    expect(dsl).toContain('while (count < 10) {');
    expect(hasGoto(dsl)).toBe(false);
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  it('restructures a desugared do-while IR to `do { } while (…)`', () => {
    const dsl = irToDsl(DO_WHILE_IR);
    expect(dsl).toContain('do {');
    expect(dsl).toContain('} while (count < 10)');
    expect(hasGoto(dsl)).toBe(false);
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  it('restructures a desugared parallel IR to nested `parallel { { } { } }`', () => {
    const dsl = irToDsl(PARALLEL_IR);
    expect(dsl).toContain('parallel {');
    // Branches are nested brace blocks, not `and`-separated.
    expect(dsl).not.toMatch(/\band\b/);
    expect(dsl).toContain('user X "X"');
    expect(dsl).toContain('service Y { class = "com.example.Y" }');
    expect(hasGatewayKeyword(dsl)).toBe(false);
    // The fork/join elide to a single `parallel { ... }` wrapping two nested
    // blocks, so exactly two lines are a lone branch-opening `{`.
    const branchOpens = dsl.split('\n').filter((l) => l.trim() === '{').length;
    expect(branchOpens).toBe(2);
  });

  it('emits explicit start/end statements and a process header with label', () => {
    const dsl = irToDsl(INVOICE_IR);
    expect(dsl).toContain('process invoice-approval "Invoice Approval" {');
    expect(dsl).toContain('start ReviewStart');
    expect(dsl).toContain('end Done');
    expect(dsl.endsWith('\n')).toBe(true);
  });

  it('restructures the canonical invoice IR to structured if/else with no `gateway`', () => {
    const dsl = irToDsl(INVOICE_IR);
    expect(dsl).toContain('if (amount > 1000) {');
    expect(dsl).toContain(
      'user SeniorApproval "Senior approval" { assignee = "manager" }',
    );
    expect(dsl).toContain(
      'service AutoApprove "Auto-approve" { class = "com.example.invoice.AutoApproveDelegate" }',
    );
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  it('omits the process label when the IR has no name', () => {
    const dsl = irToDsl(WHILE_IR);
    expect(dsl.startsWith('process p {')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Local idempotence: re-parse + re-desugar equals input up to id norm.
// ---------------------------------------------------------------------------

describe('irToDsl — local idempotence (re-desugar equivalence)', () => {
  it.each([
    ['if/else round-trips to an equivalent IR', IF_ELSE_IR],
    ['while round-trips to an equivalent IR (back-edge consumed)', WHILE_IR],
    ['do-while round-trips to an equivalent IR', DO_WHILE_IR],
    ['parallel round-trips to an equivalent IR', PARALLEL_IR],
  ])('%s', async (_title, ir) => {
    await expectIdempotent(ir);
  });

  it('invoice import preserves assignee, class binding and condition through re-desugar', async () => {
    const dsl = irToDsl(INVOICE_IR);
    const ir = await reDesugar(dsl);

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
    const ir = await reDesugar(irToDsl(INVOICE_IR));
    expect(ir.id).toBe('invoice-approval');
    expect(ir.name).toBe('Invoice Approval');
    expect(ir.isExecutable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Goto degradation: unstructured / irreducible graphs stay parseable.
// ---------------------------------------------------------------------------

describe('irToDsl — goto degradation (every edge with a form keeps it)', () => {
  /**
   * Hand-built unstructured IR: two XOR gateways whose branches cross so no
   * single post-dominating join exists (`G2` re-enters `A`, which `G1` also
   * targets). The contract: ≥1 `goto`, valid source, and every real-node
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

  it('emits valid source containing at least one goto', async () => {
    const dsl = irToDsl(IRREDUCIBLE_IR);
    expect(hasGoto(dsl)).toBe(true);
    // The source must re-parse cleanly (the totality contract).
    await reDesugar(dsl);
  });

  it('loses no edge — real-node connectivity is preserved on re-desugar', async () => {
    const dsl = irToDsl(IRREDUCIBLE_IR);
    const ir2 = await reDesugar(dsl);
    expect(realReachability(ir2)).toEqual(realReachability(IRREDUCIBLE_IR));
  });

  /**
   * Hand-built IR with an all-unconditioned XOR split carrying 3 out-flows. This
   * is unreachable via the desugaring pipeline (a desugared XOR always has ≥1
   * conditioned flow), but the emitter must still be total. A naive emit would
   * produce an invalid chained `if (true) { } else { } else { }`; the degraded
   * form caps the structure at one `if (true)` / `else` pair and routes every
   * extra (3rd+) out-edge to a `goto`, so the source stays valid and no branch
   * target is dropped.
   */
  const ALL_UNCONDITIONED_3WAY: BpmnProcess = minimalProcess(
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
      // Three UNCONDITIONED out-edges from the same XOR split.
      { id: 'f1', sourceRef: 'G', targetRef: 'A' },
      { id: 'f2', sourceRef: 'G', targetRef: 'B' },
      { id: 'f3', sourceRef: 'G', targetRef: 'C' },
      { id: 'f4', sourceRef: 'A', targetRef: 'E' },
      { id: 'f5', sourceRef: 'B', targetRef: 'E' },
      { id: 'f6', sourceRef: 'C', targetRef: 'E' },
    ],
  );

  it('degrades an all-unconditioned 3-way XOR to valid source (no chained else, ≥1 goto)', async () => {
    const dsl = irToDsl(ALL_UNCONDITIONED_3WAY);
    // Totality: the source must re-parse cleanly despite the invalid input shape.
    const ir2 = await reDesugar(dsl);
    // The 3rd branch has no structured surface, so a goto carries its edge.
    expect(hasGoto(dsl)).toBe(true);
    // A naive `if (true) { } else { } else { }` would have two `else` keywords;
    // the degraded form has at most one.
    expect((dsl.match(/}\s*else\s*{/g) ?? []).length).toBeLessThanOrEqual(1);
    // No branch target is dropped: A, B and C all survive as elements.
    const ids = new Set(ir2.flowElements.map((e) => e.id));
    expect(ids.has('A')).toBe(true);
    expect(ids.has('B')).toBe(true);
    expect(ids.has('C')).toBe(true);
  });

  /**
   * Hand-built IR with a MIXED XOR split: one conditioned flow plus two
   * unconditioned ones. The chain can express one `if` branch and one `else`;
   * the second unconditioned edge has no structured surface form and must
   * survive as a `goto` re-anchored at the join, rather than vanish while its
   * target dangles as unreachable trailing code.
   */
  const MIXED_SURPLUS_XOR: BpmnProcess = minimalProcess(
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
      edge('G', 'A', { id: 'f1', condition: '${x > 1}' }),
      { id: 'f2', sourceRef: 'G', targetRef: 'B' },
      { id: 'f3', sourceRef: 'G', targetRef: 'C' },
      { id: 'f4', sourceRef: 'A', targetRef: 'E' },
      { id: 'f5', sourceRef: 'B', targetRef: 'E' },
      { id: 'f6', sourceRef: 'C', targetRef: 'E' },
    ],
  );

  it('keeps the surplus unconditioned edge of a mixed XOR reachable (regression)', async () => {
    const dsl = irToDsl(MIXED_SURPLUS_XOR);
    expect(dsl).toContain('goto C');
    const ir2 = await reDesugar(dsl);
    // Every real node must stay transitively reachable from the start: C must
    // not dangle with no incoming edge.
    const adj = new Map<string, string[]>();
    for (const f of ir2.sequenceFlows) {
      (adj.get(f.sourceRef) ?? adj.set(f.sourceRef, []).get(f.sourceRef)!).push(
        f.targetRef,
      );
    }
    const start = ir2.flowElements.find((e) => e.kind === 'startEvent')!;
    const reachable = new Set<string>();
    const stack = [start.id];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (reachable.has(n)) continue;
      reachable.add(n);
      stack.push(...(adj.get(n) ?? []));
    }
    for (const id of ['A', 'B', 'C', 'E']) {
      expect(reachable, `node ${id} unreachable from start`).toContain(id);
    }
  });

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

// ---------------------------------------------------------------------------
// 4. Multiple / named end events survive as explicit `end` statements.
// ---------------------------------------------------------------------------

describe('irToDsl — multiple and named ends', () => {
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

  it('emits both named ends as explicit `end` statements that re-parse', async () => {
    const dsl = irToDsl(TWO_ENDS_IR);
    expect(dsl).toContain('end Approved "Approved"');
    expect(dsl).toContain('end Rejected "Rejected"');

    const ir = await reDesugar(dsl);
    const ends = ir.flowElements
      .filter((e) => e.kind === 'endEvent')
      .map((e) => e.id)
      .sort();
    expect(ends).toEqual(['Approved', 'Rejected']);
  });

  it('preserves both end-event connectivity (no edge lost)', async () => {
    const ir = await reDesugar(irToDsl(TWO_ENDS_IR));
    expect(realReachability(ir)).toEqual(realReachability(TWO_ENDS_IR));
  });
});

// ---------------------------------------------------------------------------
// 5. Output formatting conventions.
// ---------------------------------------------------------------------------

describe('irToDsl — output conventions', () => {
  it('uses 2-space indentation for nested blocks', () => {
    const dsl = irToDsl(IF_ELSE_IR);
    // The conditioned branch body (a user task) is indented two levels.
    expect(dsl).toContain('\n    user B "B task"');
  });
});

// ---------------------------------------------------------------------------
// 6. Service-task bindings and fenced script tasks.
// ---------------------------------------------------------------------------

describe('irToDsl — service-task bindings', () => {
  it.each([
    [
      'renders a class binding as `service X { class = "…" }` (byte-unchanged)',
      serviceTask('Charge', classBinding('com.example.Charge')),
      'service Charge { class = "com.example.Charge" }',
      undefined,
    ],
    [
      'keeps a labelled class binding identical to the historical output (regression)',
      {
        kind: 'serviceTask',
        id: 'AutoApprove',
        name: 'Auto-approve',
        binding: classBinding('com.example.invoice.AutoApproveDelegate'),
      },
      'service AutoApprove "Auto-approve" { class = "com.example.invoice.AutoApproveDelegate" }',
      undefined,
    ],
    [
      'renders an expression binding as `service X { expression = "${…}" }`',
      serviceTask('Calc', exprBinding('${greeter.hello(execution)}')),
      'service Calc { expression = "${greeter.hello(execution)}" }',
      undefined,
    ],
    [
      'renders a delegateExpression binding with the `delegate` alias',
      serviceTask('Ship', delegateBinding('${shipDelegate}')),
      'service Ship { delegate = "${shipDelegate}" }',
      // The XML-level `delegateExpression` name never surfaces in the source.
      'delegateExpression',
    ],
    [
      'renders an external binding as `service X { topic = "…" }`',
      serviceTask('Notify', externalBinding('notifications')),
      'service Notify { topic = "notifications" }',
      // An external binding keeps the `service` keyword, never `external`.
      'external Notify',
    ],
  ] as const)('%s', (_title, node, printed, absent) => {
    const dsl = irToDsl(around(node));
    expect(dsl).toContain(printed);
    if (absent !== undefined) expect(dsl).not.toContain(absent);
  });

  it('re-parses each binding form back to the same binding kind', async () => {
    const cases = [
      {
        node: {
          kind: 'serviceTask' as const,
          id: 'Calc',
          binding: {
            kind: 'expression' as const,
            expression: '${bean.run(execution)}',
          },
        },
        kind: 'expression',
      },
      {
        node: {
          kind: 'serviceTask' as const,
          id: 'Ship',
          binding: {
            kind: 'delegateExpression' as const,
            expression: '${shipDelegate}',
          },
        },
        kind: 'delegateExpression',
      },
      {
        node: {
          kind: 'serviceTask' as const,
          id: 'Notify',
          binding: { kind: 'external' as const, topic: 'notifications' },
        },
        kind: 'external',
      },
    ];

    for (const { node, kind } of cases) {
      const ir = await reDesugar(irToDsl(around(node)));
      const svc = ir.flowElements.find((e) => e.id === node.id);
      expect(svc?.kind === 'serviceTask' && svc.binding.kind).toBe(kind);
    }
  });
});

describe('irToDsl — fenced script task', () => {
  it('emits a fenced `script X ```<format> … ``` ` block (open tag, body, close)', () => {
    const code = 'var x = 1;\nexecution.setVariable("x", x);';
    const dsl = irToDsl(
      around({ kind: 'scriptTask', id: 'Compute', format: 'javascript', code }),
    );
    // The whole block: opening fence + language tag, verbatim body, closing fence.
    expect(dsl).toContain(`script Compute \`\`\`javascript\n${code}\`\`\``);
  });

  it('reproduces the body byte-for-byte without re-indenting it', () => {
    // A body carrying its own indentation must survive verbatim: the emitter
    // must not prepend block indentation to the opaque script content.
    const code = 'if (ok) {\n  doThing();\n}';
    const dsl = irToDsl(
      around({ kind: 'scriptTask', id: 'Guard', format: 'groovy', code }),
    );
    expect(dsl).toContain(`\`\`\`groovy\n${code}\`\`\``);
  });

  it('carries the label before the fence when present', () => {
    const dsl = irToDsl(
      around({
        kind: 'scriptTask',
        id: 'Compute',
        name: 'Compute totals',
        format: 'javascript',
        code: 'x = 1',
      }),
    );
    expect(dsl).toContain('script Compute "Compute totals" ```javascript');
  });

  it('emits a fenced script that re-parses to an equivalent scriptTask', async () => {
    const ir = await reDesugar(
      irToDsl(around(scriptTask('Compute', 'javascript', 'x = 1'))),
    );
    const script = ir.flowElements.find((e) => e.kind === 'scriptTask');
    expect(script?.kind === 'scriptTask' && script.format).toBe('javascript');
    expect(script?.kind === 'scriptTask' && script.code).toBe('x = 1');
  });
});

// ---------------------------------------------------------------------------
// 7. Sub-process emission (multi-line `subprocess { ... }` groups).
//
// The `subprocess` surface is defined in the language package, so these
// IR-literal-driven tests assert the emitted text instead of re-parsing.
// ---------------------------------------------------------------------------

describe('irToDsl — sub-process emission', () => {
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

  it('prints `subprocess sub { … }` with the body indented one level', () => {
    const dsl = irToDsl(NESTED_IR);
    expect(dsl).toContain('\n  subprocess sub {\n');
    expect(dsl).toContain('\n    start SubStart');
    expect(dsl).toContain('\n    user Work { assignee = "demo" }');
    expect(dsl).toContain('\n    end SubEnd');
    expect(dsl).toContain('\n  }\n');
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  it('keeps the parent chain intact before and after the sub-process', () => {
    const dsl = irToDsl(NESTED_IR);
    const beforeIdx = dsl.indexOf('user Before');
    const subIdx = dsl.indexOf('subprocess sub {');
    const afterIdx = dsl.indexOf('user After');
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(afterIdx).toBeGreaterThanOrEqual(0);
    expect(dsl).toContain('\n  user Before');
    expect(dsl).toContain('\n  user After');
    expect(beforeIdx).toBeLessThan(subIdx);
    expect(subIdx).toBeLessThan(afterIdx);
    expect(hasGoto(dsl)).toBe(false);
  });

  it('restructures an if/else inside a sub-process body (two indent levels)', () => {
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

    const dsl = irToDsl(SUB_WITH_IF);
    expect(dsl).toContain('\n    if (ok) {');
    expect(dsl).toContain('\n    } else {');
    expect(dsl).toContain('\n      user Yes');
    expect(dsl).toContain('\n      user No');
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  /** `St -> S -> En`, where `S` is the sub-process under test. */
  const withSub = (sub: FlowElement): BpmnProcess =>
    minimalProcess(
      [{ kind: 'startEvent', id: 'St' }, sub, { kind: 'endEvent', id: 'En' }],
      [
        { id: 'f0', sourceRef: 'St', targetRef: sub.id },
        { id: 'f1', sourceRef: sub.id, targetRef: 'En' },
      ],
    );

  const sub = (name: string | undefined, body: FlowElement[]): FlowElement => ({
    kind: 'subProcess',
    id: 'S',
    ...(name === undefined ? {} : { name }),
    flowElements: body,
    sequenceFlows: [],
  });

  it.each([
    [
      'prints the quoted label for a named sub-process',
      sub('Handle order', [{ kind: 'userTask', id: 'Do' }]),
      'subprocess S "Handle order" {',
    ],
    [
      'prints an empty sub-process body as `subprocess S {` immediately followed by `}`',
      sub('Handle order', []),
      '  subprocess S "Handle order" {\n  }\n',
    ],
    [
      // No `name` means `labelSuffix(undefined)` is `''`: no quoted label.
      'prints an unnamed empty sub-process body without a label',
      sub(undefined, []),
      '  subprocess S {\n  }\n',
    ],
  ])('%s', (_title, node, printed) => {
    expect(irToDsl(withSub(node))).toContain(printed);
  });
});

// ---------------------------------------------------------------------------
// 8. Call-activity emission (single-line `call <id> { ... }` statements).
//
// IR-literal-driven and parser-free: these assert the emitted text (canonical
// member order, mapping shorthand, version print contract), not a re-parse.
// ---------------------------------------------------------------------------

describe('irToDsl — call activity', () => {
  it('prints the full single-line form in canonical member order with shorthand', () => {
    const dsl = irToDsl(
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

  it('prints a call in mid-chain as a plain fall-through node (order preserved)', () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Before' },
        callActivity('Mid', 'sub'),
        { kind: 'userTask', id: 'After' },
        { kind: 'endEvent', id: 'E' },
      ],
      [
        { id: 'f0', sourceRef: 'S', targetRef: 'Before' },
        { id: 'f1', sourceRef: 'Before', targetRef: 'Mid' },
        { id: 'f2', sourceRef: 'Mid', targetRef: 'After' },
        { id: 'f3', sourceRef: 'After', targetRef: 'E' },
      ],
    );
    const dsl = irToDsl(ir);
    const beforeIdx = dsl.indexOf('user Before');
    const callIdx = dsl.indexOf('call Mid { process = "sub" }');
    const afterIdx = dsl.indexOf('user After');
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(beforeIdx);
    expect(afterIdx).toBeGreaterThan(callIdx);
    expect(hasGoto(dsl)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event layer: declarations, throws, emits, handlers.
//
// These fixtures are printed and asserted directly. The parser lives in the
// language package, so the workspace-level tests exercise the full round-trip.
// ---------------------------------------------------------------------------

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

describe('irToDsl — event layer', () => {
  it('prints declarations, throws, emits, and trailing handlers in order', () => {
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

    expect(irToDsl(ir)).toBe(
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

  it('prints an escalation end event as a throw, and a plain end as end', () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('endEvent', 'Esc', escalationDef('X')),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'Esc' }],
    );
    const dsl = irToDsl(ir);
    expect(dsl).toContain('throw escalation Esc "X"');
    expect(dsl).not.toContain('end Esc');
  });

  it('nests a construct inside a handler body two levels deep', () => {
    const dsl = irToDsl(handlerWithIf(errorDef('C')));
    expect(dsl).toContain('\n  on error "C" {\n');
    expect(dsl).toContain('\n    if (amount > 1000) {\n');
    expect(dsl).toContain('\n      user A\n');
    expect(dsl).not.toContain('gateway');
  });
});

// ---------------------------------------------------------------------------
// Event layer: message / signal / timer / conditional triggers and signal throws.
// ---------------------------------------------------------------------------

describe('irToDsl — event layer (message / signal / timer / conditional)', () => {
  it('prints message/signal headers, the signal emit/throw, and trailing handlers', () => {
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
    const dsl = irToDsl(ir);
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

  it('prints the three timer particles, with alongside on the repeating one', () => {
    const ir: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        eventHandler('OnAfter', 'AfterStart', timerDef('duration', 'PT1H')),
        eventHandler(
          'OnAt',
          'AtStart',
          timerDef('date', '2026-08-01T09:00:00'),
        ),
        eventHandler(
          'OnEvery',
          'EveryStart',
          timerDef('cycle', 'R/PT10M'),
          false,
        ),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );
    const dsl = irToDsl(ir);
    expect(dsl).toContain('  on timer after "PT1H" {\n');
    expect(dsl).toContain('  on timer at "2026-08-01T09:00:00" {\n');
    expect(dsl).toContain('  on timer every "R/PT10M" alongside {\n');
  });

  it.each([
    [
      'prints a condition header as bare DSL when the body is in the subset',
      '${amount > 100}',
      '  on condition (amount > 100) {\n',
    ],
    [
      'prints a condition header as a quoted raw fallback when out of subset',
      '${bean.check()}',
      '  on condition ("${bean.check()}") {\n',
    ],
  ])('%s', (_title, condition, header) => {
    const ir: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        eventHandler('OnCond', 'CondStart', conditionDef(condition)),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );
    expect(irToDsl(ir)).toContain(header);
  });

  it('refuses a throw-side event carrying a non-throwable definition', () => {
    const badEnd: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('endEvent', 'Bad', messageDef('X')),
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'Bad' }],
    );
    expect(() => irToDsl(badEnd)).toThrow(/message/);

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

// ---------------------------------------------------------------------------
// Event layer: intermediate catch (`await`), a blocking one-in/one-out node
// inline on the main flow, printed with no id token (it has no name slot).
// ---------------------------------------------------------------------------

describe('irToDsl — event layer (intermediate catch / await)', () => {
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

  it('prints "await message …" inline between the surrounding steps, with no id token', () => {
    const dsl = irToDsl(catchBody(messageDef('M')));
    expect(dsl).toBe(
      [
        'process proc {',
        '  start S',
        '  user Before',
        '  await message "M"',
        '  user After',
        '  end E',
        '}',
        '',
      ].join('\n'),
    );
    expect(dsl).not.toContain('Catch_');
  });

  it.each([
    [
      'prints "await timer after …" for a duration timer catch',
      timerDef('duration', 'PT1H'),
      '  await timer after "PT1H"\n',
    ],
    [
      'prints "await signal …" for a signal catch',
      signalDef('S'),
      '  await signal "S"\n',
    ],
    [
      'prints "await condition (…)" for a conditional catch, bare DSL in the JUEL subset',
      conditionDef('${amount > 100}'),
      '  await condition (amount > 100)\n',
    ],
  ] as const)('%s', (_title, def, printed) => {
    const dsl = irToDsl(catchBody(def));
    expect(dsl).toContain(printed);
    expect(dsl).not.toContain('Catch_');
  });
});

// ---------------------------------------------------------------------------
// Event layer: compensation (payload-less catch + throw + emit).
// ---------------------------------------------------------------------------

describe('irToDsl — event layer (compensation)', () => {
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

  it('prints a bare on-compensation handler after all flow, with emit/throw compensation carrying no trailing string', () => {
    expect(irToDsl(compensationIr)).toBe(
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

  it('nests an if one further level inside a compensation handler body', () => {
    const dsl = irToDsl(handlerWithIf({ kind: 'compensation' }));
    expect(dsl).toContain('\n  on compensation {\n');
    expect(dsl).toContain('\n    if (amount > 1000) {\n');
    expect(dsl).toContain('\n      user A\n');
    expect(dsl).not.toContain('gateway');
  });

  it("prints alongside for a malformed-IR compensation start with isInterrupting: false (the printer mirrors the IR; prohibiting it is the validator's job)", () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        {
          kind: 'subProcess',
          id: 'H',
          triggeredByEvent: true,
          flowElements: [
            typedEvent('startEvent', 'HS', { kind: 'compensation' }, false),
            { kind: 'endEvent', id: 'HE' },
          ],
          sequenceFlows: [{ id: 'F1', sourceRef: 'HS', targetRef: 'HE' }],
        },
      ],
      [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    );
    expect(irToDsl(ir)).toContain('  on compensation alongside {\n');
  });
});

// ---------------------------------------------------------------------------
// Boundary events: the escape-chain emission pass.
//
// A boundary event is the only IR node with outgoing but no incoming flow, so
// its chain is unreachable from the start event and must be printed by its own
// pass, before the orphan sweep would otherwise flush it as a detached
// top-level chain. The chain lives in the same container as the main flow, so
// the shared emitted-node / consumed-flow bookkeeping is what makes a rejoin
// degrade to a `goto`.
// ---------------------------------------------------------------------------

describe('irToDsl — boundary events', () => {
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

  it('prints an interrupting boundary as a hosted handler with its chain indented', () => {
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
    expect(irToDsl(ir)).toBe(
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

  it('prints alongside for a non-interrupting boundary', () => {
    const ir = boundaryIr(
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
        { id: 'F3', sourceRef: 'Boundary_Pack_message', targetRef: 'Notify' },
        { id: 'F4', sourceRef: 'Notify', targetRef: 'Nudged' },
      ],
    );
    const dsl = irToDsl(ir);
    expect(dsl).toContain('  on Pack: message "Nudge" alongside {\n');
    expect(dsl).toContain('    end Nudged\n');
  });

  it('degrades a rejoin into the main flow to a goto and prints the main-flow node once', () => {
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
    const dsl = irToDsl(ir);
    expect(dsl).toContain('  on Fetch: error "GONE" {\n');
    expect(dsl).toContain('    user Retry\n');
    expect(dsl).toContain('    goto Ship\n');
    expect(dsl.match(/^ *user Ship$/gm)).toHaveLength(1);
  });

  it('restructures an if/else inside an escape chain (the boundary is a second CFG entry)', () => {
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
    const dsl = irToDsl(ir);
    expect(dsl).toContain('  on Review: signal "Abort" {\n');
    expect(dsl).toContain('    if (paid) {\n');
    expect(dsl).toContain('    } else {\n');
    expect(hasGoto(dsl)).toBe(false);
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  it('prints two boundaries on one host as two blocks in IR order', () => {
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
    const dsl = irToDsl(ir);
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

  it('keeps the handler block trailing when the container holds an orphan fragment', () => {
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
    const dsl = irToDsl(ir);
    expect(dsl.indexOf('on Review: error "X" {')).toBeGreaterThan(
      dsl.indexOf('user Stranded'),
    );
  });

  it('prints the handler block for a boundary event a malformed flow edge points at', () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        boundaryEvent('Boundary_A_error', 'A', errorDef('X')),
        { kind: 'userTask', id: 'Fix' },
      ],
      flowChain('S', 'A', 'Boundary_A_error', 'Fix'),
    );
    const dsl = irToDsl(ir);
    expect(dsl).toContain('on A: error "X" {');
    expect(dsl).toContain('user Fix');
    // Printed at its arrival point and nowhere else: the boundary pass must
    // find it already emitted.
    expect(dsl.match(/^ *on A: /gm)).toHaveLength(1);
  });

  it('prints a boundary event before a host-less handler in the same container', () => {
    const ir = boundaryIr(
      'Review',
      [
        {
          kind: 'subProcess',
          id: 'OnPF',
          triggeredByEvent: true,
          flowElements: [
            typedEvent('startEvent', 'PFStart', errorDef('PF')),
            { kind: 'endEvent', id: 'PFEnd' },
          ],
          sequenceFlows: [
            { id: 'H1', sourceRef: 'PFStart', targetRef: 'PFEnd' },
          ],
        },
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('duration', 'PT2H'),
        ),
        { kind: 'endEvent', id: 'Late' },
      ],
      [{ id: 'F3', sourceRef: 'Boundary_Review_timer', targetRef: 'Late' }],
    );
    const dsl = irToDsl(ir);
    expect(dsl.indexOf('on Review: timer')).toBeGreaterThan(-1);
    expect(dsl.indexOf('on error "PF" {')).toBeGreaterThan(
      dsl.indexOf('on Review: timer'),
    );
  });

  it('prints a boundary event inside the sub-process container that holds its host', () => {
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
    expect(irToDsl(ir)).toContain('    on Check: condition (stale) {\n');
  });

  it('prints an empty body for a boundary event with no outgoing flow', () => {
    const ir = boundaryIr(
      'Review',
      [
        boundaryEvent(
          'Boundary_Review_timer',
          'Review',
          timerDef('cycle', 'R/PT1H'),
        ),
      ],
      [],
    );
    expect(irToDsl(ir)).toContain('  on Review: timer every "R/PT1H" {\n  }\n');
  });

  it('still prints the header when the host lives outside this container', () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        boundaryEvent(
          'Boundary_Elsewhere_message',
          'Elsewhere',
          messageDef('M'),
        ),
      ],
      [{ id: 'F1', sourceRef: 'S', targetRef: 'E' }],
    );
    expect(irToDsl(ir)).toContain('  on Elsewhere: message "M" {\n  }\n');
  });

  it('leaves a container without boundary events printing exactly as before', () => {
    expect(irToDsl(IF_ELSE_IR)).toBe(
      [
        'process p {',
        '  start S',
        '  user A "A task"',
        '  if (amount > 1000) {',
        '    user B "B task"',
        '  } else {',
        '    service C { class = "com.example.C" }',
        '  }',
        '  end E',
        '}',
        '',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Synthesized-terminal omission: a reserved `StartEvent_`/`EndEvent_`/`Throw_`
// id is the desugarer's own doing, not something an author could type (the
// validator rejects the prefixes), so printing it back out as a name produces
// source the validator then rejects. These ids must be omitted (start/end) or
// dropped from the name slot (throw/emit) instead.
// ---------------------------------------------------------------------------

describe('irToDsl — synthesized terminal omission', () => {
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

  it('drops a synthesized Throw_ id from throw/emit but keeps an authored name', () => {
    /** `S -> end`: a typed end terminates the chain, so nothing follows it. */
    const terminating = (end: FlowElement): BpmnProcess =>
      minimalProcess(
        [{ kind: 'startEvent', id: 'S' }, end],
        [{ id: 'F', sourceRef: 'S', targetRef: end.id }],
      );

    const unnamedThrow = irToDsl(
      terminating(typedEvent('endEvent', 'Throw_p_1', escalationDef('ESC'))),
    );
    expect(unnamedThrow).toContain('throw escalation "ESC"');
    expect(unnamedThrow).not.toContain('Throw_');

    const unnamedEmit = irToDsl(
      around(
        typedEvent('intermediateThrowEvent', 'Throw_p_2', signalDef('Ping')),
      ),
    );
    expect(unnamedEmit).toContain('emit signal "Ping"');
    expect(unnamedEmit).not.toContain('Throw_');

    const namedThrow = irToDsl(
      terminating(typedEvent('endEvent', 'PaymentFailed', errorDef('PF'))),
    );
    expect(namedThrow).toContain('throw error PaymentFailed "PF"');
  });
});

// ---------------------------------------------------------------------------
// Guard-clause continuation + the never-goto-a-gateway invariant.
// ---------------------------------------------------------------------------

describe('irToDsl — guard-clause continuation', () => {
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

describe('irToDsl — never emit a goto to a gateway', () => {
  /**
   * A multi-out real node whose second out-edge lands on a one-out pass-through
   * gateway `Gateway_p_9_join -> R`. The second arrival is realized as a goto;
   * the invariant forwards it through the elided gateway to the real successor.
   */
  const PASS_THROUGH_IR: BpmnProcess = minimalProcess(
    [
      { kind: 'startEvent', id: 'S' },
      { kind: 'userTask', id: 'A' },
      gateway('Gateway_p_9_join'),
      { kind: 'userTask', id: 'R' },
      { kind: 'endEvent', id: 'E' },
    ],
    [
      { id: 'f0', sourceRef: 'S', targetRef: 'A' },
      { id: 'f1', sourceRef: 'A', targetRef: 'E' },
      { id: 'f2', sourceRef: 'A', targetRef: 'Gateway_p_9_join' },
      { id: 'f3', sourceRef: 'Gateway_p_9_join', targetRef: 'R' },
      { id: 'f4', sourceRef: 'R', targetRef: 'E' },
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

describe('irToDsl — parallel-fork recovery (terminating branch)', () => {
  it('recovers an asymmetric fork as `parallel { … }` with the throw inline and the continuation after', async () => {
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
    const dsl = irToDsl(ir);

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

  it('leaves a fully symmetric parallel decompile byte-for-byte unchanged (both branches survive)', () => {
    // Both branches reach the join, so the clean-join path handles it and the
    // recovery is never entered.
    expect(irToDsl(PARALLEL_IR)).toBe(
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
        '}\n',
    );
  });

  it('round-trips the asymmetric fork to a topologically equal IR (idempotence)', async () => {
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
    await expectIdempotent(ir);
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

// ---------------------------------------------------------------------------
// Engine attributes: the block each statement kind prints, and the single
// printability rule the elision sites share.
// ---------------------------------------------------------------------------

describe('irToDsl — engine attributes', () => {
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
    const dsl = irToDsl(ENGINE_IR);
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

  /**
   * A start event whose second out-edge is surplus: it has no position of its
   * own, so it is written as a jump when the target has a printed statement to
   * name and dropped with a marker when it has not. Whether the synthesized end
   * prints is exactly the question the shared printability predicate answers, so
   * a jump can never name a statement the emitter skipped.
   */
  const surplusEdgeIr = (attrs: { asyncBefore?: true }): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'A' },
        { kind: 'endEvent', id: 'EndEvent_p', ...attrs },
      ],
      [
        { id: 'F1', sourceRef: 'S', targetRef: 'A' },
        { id: 'F2', sourceRef: 'S', targetRef: 'EndEvent_p' },
        { id: 'F3', sourceRef: 'A', targetRef: 'EndEvent_p' },
      ],
    );

  it('prints a synthesized end carrying an engine attribute so a jump resolves, and elides one carrying nothing', async () => {
    const dsl = await printed(surplusEdgeIr({ asyncBefore: true }));
    expect(dsl).toContain('end EndEvent_p { asyncBefore = true }');
    expect(dsl).toContain('goto EndEvent_p');
    expect(dsl).not.toContain(UNSTRUCTURED_MARKER);

    const elided = irToDsl(surplusEdgeIr({}));
    await reDesugar(elided);

    expect(elided).not.toContain('end EndEvent_p');
    expect(elided).not.toContain('goto EndEvent_p');
    expect(elided).toContain(UNSTRUCTURED_MARKER);
  });

  /**
   * A back edge to the start event: the loop cannot be recognized as a `while`,
   * so the edge is written as a jump when the start has a printed statement to
   * name and dropped with a marker when it has not. Whether the synthesized
   * start prints is the same shared question, asked on the other side of the
   * predicate.
   */
  const backEdgeIr = (attrs: { asyncBefore?: true }): BpmnProcess =>
    minimalProcess(
      [
        { kind: 'startEvent', id: 'StartEvent_p', ...attrs },
        { kind: 'userTask', id: 'A' },
      ],
      flowChain('StartEvent_p', 'A', 'StartEvent_p'),
    );

  it('prints a synthesized start carrying an engine attribute so a jump resolves, and elides one carrying nothing', async () => {
    const dsl = await printed(backEdgeIr({ asyncBefore: true }));
    expect(dsl).toContain('start StartEvent_p { asyncBefore = true }');
    expect(dsl).toContain('goto StartEvent_p');
    expect(dsl).not.toContain(UNSTRUCTURED_MARKER);

    const elided = irToDsl(backEdgeIr({}));
    await reDesugar(elided);

    expect(elided).not.toContain('start StartEvent_p');
    expect(elided).not.toContain('goto StartEvent_p');
    expect(elided).toContain(UNSTRUCTURED_MARKER);
  });
});

describe('irToDsl — input/output parameters', () => {
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

describe('irToDsl — listeners', () => {
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

  /**
   * A listener is a further reason a synthesized end has something to print, so
   * it has to reach the same printability answer the engine attributes reach; a
   * jump may only name a statement the emitter actually wrote.
   */
  const surplusEdgeIr = (end: FlowElement): BpmnProcess =>
    minimalProcess(
      [{ kind: 'startEvent', id: 'S' }, { kind: 'userTask', id: 'A' }, end],
      [
        { id: 'F1', sourceRef: 'S', targetRef: 'A' },
        { id: 'F2', sourceRef: 'S', targetRef: 'EndEvent_p' },
        { id: 'F3', sourceRef: 'A', targetRef: 'EndEvent_p' },
      ],
    );

  it('prints a synthesized end carrying only a listener, so a jump to it resolves', async () => {
    const dsl = await printed(
      surplusEdgeIr({
        kind: 'endEvent',
        id: 'EndEvent_p',
        executionListeners: [
          { event: 'end', binding: classBinding('com.example.Done') },
        ],
      }),
    );
    expect(dsl).toContain(
      'end EndEvent_p { on end { class = "com.example.Done" } }',
    );
    expect(dsl).toContain('goto EndEvent_p');
    expect(dsl).not.toContain(UNSTRUCTURED_MARKER);
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
