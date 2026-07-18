/**
 * Full test suite for the restructuring IR → DSL emitter (`irToDsl`).
 *
 * `irToDsl` is the inverse of the desugaring `astToIr`: it turns a flat,
 * BPMN-shaped IR back into structured DSL source (`if`/`else if`/`else`,
 * `while`, `do … while`, `parallel { { } { } }`, `goto`). These tests assert
 * that:
 *
 *   1. Each desugared construct (the exact IR shape `astToIr` produces)
 *      restructures back to its surface form — no `gateway` keyword appears.
 *   2. Local idempotence: re-parsing the emitted source through Langium and
 *      re-desugaring via `astToIr` yields an IR equal to the input up to
 *      synthesized-id normalization.
 *   3. Goto degradation: an unstructured hand-built IR emits valid
 *      DSL source containing ≥1 `goto`, parses cleanly, and loses no edge
 *      (every real-node connectivity is preserved).
 *   4. Multiple / named end events survive as explicit `end` statements.
 *
 * All IR fixtures are inline literals (no fixture-file reads). The structured
 * fixtures match the byte-for-byte shape produced by `astToIr` on the
 * corresponding source, so the idempotence
 * assertions are exact (not merely reachability-based).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { irToDsl } from '../src/ir-to-dsl.js';
import { astToIr } from '../src/ast-to-ir.js';
import type {
  BpmnProcess,
  EventDefinition,
  FlowElement,
  SequenceFlow,
} from '../src/ir/types.js';

let parse: (input: string) => Promise<LangiumDocument<Model>>;

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

/**
 * Assert local idempotence up to id normalization: `irToDsl(ir)` re-parses and
 * re-desugars to an IR with the same normalized element + edge multisets as
 * `ir`.
 */
async function expectIdempotent(ir: BpmnProcess): Promise<string> {
  const dsl = irToDsl(ir);
  const ir2 = await reDesugar(dsl);
  expect(elementMultiset(ir2)).toEqual(elementMultiset(ir));
  expect(edgeMultiset(ir2)).toEqual(edgeMultiset(ir));
  return dsl;
}

/**
 * Real-node reachability set (gateway-transparent): for every non-gateway node,
 * the set of non-gateway nodes reachable through any number of gateway hops.
 * Used to prove "no edge lost" for unstructured / degraded graphs, where the
 * literal edge set legitimately changes (synthesized gateways) but connectivity
 * between real nodes must be preserved exactly.
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
// Inline IR fixtures — the exact shapes `astToIr` emits for each construct.
// ---------------------------------------------------------------------------

/** Desugared `if (amount > 1000) { user B } else { service C }` at body index 2. */
const IF_ELSE_IR: BpmnProcess = {
  id: 'p',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'S' },
    { kind: 'userTask', id: 'A', name: 'A task' },
    {
      kind: 'exclusiveGateway',
      id: 'Gateway_p_2_split',
      defaultFlowId: 'Flow_Gateway_p_2_split_default',
    },
    { kind: 'exclusiveGateway', id: 'Gateway_p_2_join' },
    { kind: 'userTask', id: 'B', name: 'B task' },
    {
      kind: 'serviceTask',
      id: 'C',
      binding: { kind: 'class', className: 'com.example.C' },
    },
    { kind: 'endEvent', id: 'E' },
  ],
  sequenceFlows: [
    { id: 'Flow_S_A', sourceRef: 'S', targetRef: 'A' },
    {
      id: 'Flow_Gateway_p_2_split_B',
      conditionExpression: '${amount > 1000}',
      sourceRef: 'Gateway_p_2_split',
      targetRef: 'B',
    },
    {
      id: 'Flow_B_Gateway_p_2_join',
      sourceRef: 'B',
      targetRef: 'Gateway_p_2_join',
    },
    {
      id: 'Flow_Gateway_p_2_split_default',
      sourceRef: 'Gateway_p_2_split',
      targetRef: 'C',
    },
    {
      id: 'Flow_C_Gateway_p_2_join',
      sourceRef: 'C',
      targetRef: 'Gateway_p_2_join',
    },
    {
      id: 'Flow_A_Gateway_p_2_split',
      sourceRef: 'A',
      targetRef: 'Gateway_p_2_split',
    },
    {
      id: 'Flow_Gateway_p_2_join_E',
      sourceRef: 'Gateway_p_2_join',
      targetRef: 'E',
    },
  ],
};

/** Desugared `while (count < 10) { user W }`. */
const WHILE_IR: BpmnProcess = {
  id: 'p',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'S' },
    {
      kind: 'exclusiveGateway',
      id: 'Gateway_p_1_loop',
      defaultFlowId: 'Flow_Gateway_p_1_loop_default',
    },
    { kind: 'userTask', id: 'W', name: 'Work' },
    { kind: 'endEvent', id: 'E' },
  ],
  sequenceFlows: [
    {
      id: 'Flow_Gateway_p_1_loop_W',
      conditionExpression: '${count < 10}',
      sourceRef: 'Gateway_p_1_loop',
      targetRef: 'W',
    },
    {
      id: 'Flow_W_Gateway_p_1_loop',
      sourceRef: 'W',
      targetRef: 'Gateway_p_1_loop',
    },
    {
      id: 'Flow_S_Gateway_p_1_loop',
      sourceRef: 'S',
      targetRef: 'Gateway_p_1_loop',
    },
    {
      id: 'Flow_Gateway_p_1_loop_default',
      sourceRef: 'Gateway_p_1_loop',
      targetRef: 'E',
    },
  ],
};

/** Desugared `do { user W } while (count < 10)`. */
const DO_WHILE_IR: BpmnProcess = {
  id: 'p',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'S' },
    { kind: 'userTask', id: 'W', name: 'Work' },
    {
      kind: 'exclusiveGateway',
      id: 'Gateway_p_1_loop',
      defaultFlowId: 'Flow_Gateway_p_1_loop_default',
    },
    { kind: 'endEvent', id: 'E' },
  ],
  sequenceFlows: [
    {
      id: 'Flow_W_Gateway_p_1_loop',
      sourceRef: 'W',
      targetRef: 'Gateway_p_1_loop',
    },
    {
      id: 'Flow_Gateway_p_1_loop_W',
      conditionExpression: '${count < 10}',
      sourceRef: 'Gateway_p_1_loop',
      targetRef: 'W',
    },
    { id: 'Flow_S_W', sourceRef: 'S', targetRef: 'W' },
    {
      id: 'Flow_Gateway_p_1_loop_default',
      sourceRef: 'Gateway_p_1_loop',
      targetRef: 'E',
    },
  ],
};

/** Desugared `parallel { { user X } { service Y } }`. */
const PARALLEL_IR: BpmnProcess = {
  id: 'p',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'S' },
    { kind: 'parallelGateway', id: 'Gateway_p_1_fork' },
    { kind: 'parallelGateway', id: 'Gateway_p_1_join' },
    { kind: 'userTask', id: 'X', name: 'X' },
    {
      kind: 'serviceTask',
      id: 'Y',
      binding: { kind: 'class', className: 'com.example.Y' },
    },
    { kind: 'endEvent', id: 'E' },
  ],
  sequenceFlows: [
    {
      id: 'Flow_Gateway_p_1_fork_X',
      sourceRef: 'Gateway_p_1_fork',
      targetRef: 'X',
    },
    {
      id: 'Flow_X_Gateway_p_1_join',
      sourceRef: 'X',
      targetRef: 'Gateway_p_1_join',
    },
    {
      id: 'Flow_Gateway_p_1_fork_Y',
      sourceRef: 'Gateway_p_1_fork',
      targetRef: 'Y',
    },
    {
      id: 'Flow_Y_Gateway_p_1_join',
      sourceRef: 'Y',
      targetRef: 'Gateway_p_1_join',
    },
    {
      id: 'Flow_S_Gateway_p_1_fork',
      sourceRef: 'S',
      targetRef: 'Gateway_p_1_fork',
    },
    {
      id: 'Flow_Gateway_p_1_join_E',
      sourceRef: 'Gateway_p_1_join',
      targetRef: 'E',
    },
  ],
};

/**
 * Canonical invoice IR — the `xmlToIr` import shape of the handwritten golden
 * (an XOR split with named branch flows, no explicit join). Drives the
 * "structured restructuring of a real import" assertions.
 */
const INVOICE_IR: BpmnProcess = {
  id: 'invoice-approval',
  name: 'Invoice Approval',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'ReviewStart' },
    {
      kind: 'userTask',
      id: 'ReviewInvoice',
      name: 'Review invoice',
      assignee: 'demo',
    },
    {
      kind: 'exclusiveGateway',
      id: 'AmountCheck',
      name: 'Amount > 1000?',
      defaultFlowId: 'AutoApprovePath',
    },
    {
      kind: 'userTask',
      id: 'SeniorApproval',
      name: 'Senior approval',
      assignee: 'manager',
    },
    {
      kind: 'serviceTask',
      id: 'AutoApprove',
      name: 'Auto-approve',
      binding: {
        kind: 'class',
        className: 'com.example.invoice.AutoApproveDelegate',
      },
    },
    { kind: 'endEvent', id: 'Done' },
  ],
  sequenceFlows: [
    {
      id: 'Flow_ReviewStart_ReviewInvoice',
      sourceRef: 'ReviewStart',
      targetRef: 'ReviewInvoice',
    },
    {
      id: 'Flow_ReviewInvoice_AmountCheck',
      sourceRef: 'ReviewInvoice',
      targetRef: 'AmountCheck',
    },
    {
      id: 'Flow_SeniorBranch',
      conditionExpression: '${amount > 1000}',
      sourceRef: 'AmountCheck',
      targetRef: 'SeniorApproval',
    },
    {
      id: 'AutoApprovePath',
      sourceRef: 'AmountCheck',
      targetRef: 'AutoApprove',
    },
    {
      id: 'Flow_SeniorApproval_Done',
      sourceRef: 'SeniorApproval',
      targetRef: 'Done',
    },
    {
      id: 'Flow_AutoApprove_Done',
      sourceRef: 'AutoApprove',
      targetRef: 'Done',
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. Structured restructuring — each construct emits its surface form.
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
    // The fork/join elide to a single `parallel { … }` wrapping two nested
    // blocks — exactly two lines are a lone branch-opening `{`.
    const branchOpens = dsl.split('\n').filter((l) => l.trim() === '{').length;
    expect(branchOpens).toBe(2);
  });

  it('emits typed attribute blocks for user / service tasks', () => {
    const dsl = irToDsl(IF_ELSE_IR);
    expect(dsl).toContain('user A "A task"');
    expect(dsl).toContain('service C { class = "com.example.C" }');
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
// 2. Local idempotence — re-parse + re-desugar equals input up to id norm.
// ---------------------------------------------------------------------------

describe('irToDsl — local idempotence (re-desugar equivalence)', () => {
  it('if/else round-trips to an equivalent IR', async () => {
    await expectIdempotent(IF_ELSE_IR);
  });

  it('while round-trips to an equivalent IR (back-edge consumed)', async () => {
    await expectIdempotent(WHILE_IR);
  });

  it('do-while round-trips to an equivalent IR', async () => {
    await expectIdempotent(DO_WHILE_IR);
  });

  it('parallel round-trips to an equivalent IR', async () => {
    await expectIdempotent(PARALLEL_IR);
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
// 3. Goto degradation — total over unstructured / irreducible graphs.
// ---------------------------------------------------------------------------

describe('irToDsl — goto degradation (totality, no edge lost)', () => {
  /**
   * Hand-built unstructured IR: two XOR gateways whose branches cross so no
   * single post-dominating join exists (`G2` re-enters `A`, which `G1` also
   * targets). The contract: ≥1 `goto`, valid source, and every real-node
   * connection preserved on re-desugar.
   */
  const IRREDUCIBLE_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'S' },
      { kind: 'exclusiveGateway', id: 'G1', defaultFlowId: 'd1' },
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'exclusiveGateway', id: 'G2', defaultFlowId: 'd2' },
      { kind: 'endEvent', id: 'E' },
    ],
    sequenceFlows: [
      { id: 'f0', sourceRef: 'S', targetRef: 'G1' },
      {
        id: 'f1',
        conditionExpression: '${p}',
        sourceRef: 'G1',
        targetRef: 'A',
      },
      { id: 'd1', sourceRef: 'G1', targetRef: 'B' },
      { id: 'f2', sourceRef: 'A', targetRef: 'E' },
      { id: 'f3', sourceRef: 'B', targetRef: 'G2' },
      {
        id: 'f4',
        conditionExpression: '${q}',
        sourceRef: 'G2',
        targetRef: 'A',
      },
      { id: 'd2', sourceRef: 'G2', targetRef: 'E' },
    ],
  };

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
  const ALL_UNCONDITIONED_3WAY: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'S' },
      { kind: 'exclusiveGateway', id: 'G' },
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'userTask', id: 'C' },
      { kind: 'endEvent', id: 'E' },
    ],
    sequenceFlows: [
      { id: 'f0', sourceRef: 'S', targetRef: 'G' },
      // Three UNCONDITIONED out-edges from the same XOR split.
      { id: 'f1', sourceRef: 'G', targetRef: 'A' },
      { id: 'f2', sourceRef: 'G', targetRef: 'B' },
      { id: 'f3', sourceRef: 'G', targetRef: 'C' },
      { id: 'f4', sourceRef: 'A', targetRef: 'E' },
      { id: 'f5', sourceRef: 'B', targetRef: 'E' },
      { id: 'f6', sourceRef: 'C', targetRef: 'E' },
    ],
  };

  it('degrades an all-unconditioned 3-way XOR to valid source (no chained else, ≥1 goto)', async () => {
    const dsl = irToDsl(ALL_UNCONDITIONED_3WAY);
    // Totality: the source must re-parse cleanly despite the invalid input shape.
    const ir2 = await reDesugar(dsl);
    // The 3rd branch has no structured surface, so a goto carries its edge.
    expect(hasGoto(dsl)).toBe(true);
    // A naive `if (true) { } else { } else { }` would have two `else` keywords;
    // the degraded form has at most one.
    expect((dsl.match(/}\s*else\s*{/g) ?? []).length).toBeLessThanOrEqual(1);
    // No branch target is dropped — every one of A, B, C survives as an element.
    const ids = new Set(ir2.flowElements.map((e) => e.id));
    expect(ids.has('A')).toBe(true);
    expect(ids.has('B')).toBe(true);
    expect(ids.has('C')).toBe(true);
  });

  /**
   * Hand-built IR with a MIXED XOR split: one conditioned flow plus two
   * unconditioned ones. The chain can express one `if` branch and one `else`;
   * the second unconditioned edge has no structured surface form and must
   * survive as a `goto` (re-anchored at the join) — not vanish while its
   * target dangles as unreachable trailing code.
   */
  const MIXED_SURPLUS_XOR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'S' },
      { kind: 'exclusiveGateway', id: 'G' },
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'userTask', id: 'C' },
      { kind: 'endEvent', id: 'E' },
    ],
    sequenceFlows: [
      { id: 'f0', sourceRef: 'S', targetRef: 'G' },
      {
        id: 'f1',
        conditionExpression: '${x > 1}',
        sourceRef: 'G',
        targetRef: 'A',
      },
      { id: 'f2', sourceRef: 'G', targetRef: 'B' },
      { id: 'f3', sourceRef: 'G', targetRef: 'C' },
      { id: 'f4', sourceRef: 'A', targetRef: 'E' },
      { id: 'f5', sourceRef: 'B', targetRef: 'E' },
      { id: 'f6', sourceRef: 'C', targetRef: 'E' },
    ],
  };

  it('keeps the surplus unconditioned edge of a mixed XOR reachable (regression)', async () => {
    const dsl = irToDsl(MIXED_SURPLUS_XOR);
    expect(dsl).toContain('goto C');
    const ir2 = await reDesugar(dsl);
    // Every real node must stay transitively reachable from the start —
    // before the fix, C dangled as dead code with no incoming edge.
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
      {
        id: 'p',
        isExecutable: true,
        flowElements: [
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        sequenceFlows: [{ id: 'f', sourceRef: 'A', targetRef: 'E' }],
      },
      // Empty process.
      { id: 'p', isExecutable: true, flowElements: [], sequenceFlows: [] },
      // Orphan (unreachable) node.
      {
        id: 'p',
        isExecutable: true,
        flowElements: [
          { kind: 'startEvent', id: 'S' },
          { kind: 'endEvent', id: 'E' },
          { kind: 'userTask', id: 'Orphan' },
        ],
        sequenceFlows: [{ id: 'f', sourceRef: 'S', targetRef: 'E' }],
      },
      // Self-loop on a task.
      {
        id: 'p',
        isExecutable: true,
        flowElements: [
          { kind: 'startEvent', id: 'S' },
          { kind: 'userTask', id: 'A' },
          { kind: 'endEvent', id: 'E' },
        ],
        sequenceFlows: [
          { id: 'f0', sourceRef: 'S', targetRef: 'A' },
          { id: 'f1', sourceRef: 'A', targetRef: 'A' },
          { id: 'f2', sourceRef: 'A', targetRef: 'E' },
        ],
      },
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
  const TWO_ENDS_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'S' },
      {
        kind: 'exclusiveGateway',
        id: 'Gateway_p_1_split',
        defaultFlowId: 'Flow_Gateway_p_1_split_default',
      },
      { kind: 'endEvent', id: 'Approved', name: 'Approved' },
      { kind: 'endEvent', id: 'Rejected', name: 'Rejected' },
    ],
    sequenceFlows: [
      {
        id: 'Flow_S_Gateway_p_1_split',
        sourceRef: 'S',
        targetRef: 'Gateway_p_1_split',
      },
      {
        id: 'Flow_Gateway_p_1_split_Approved',
        conditionExpression: '${ok}',
        sourceRef: 'Gateway_p_1_split',
        targetRef: 'Approved',
      },
      {
        id: 'Flow_Gateway_p_1_split_default',
        sourceRef: 'Gateway_p_1_split',
        targetRef: 'Rejected',
      },
    ],
  };

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
  it('produces a non-empty string ending with a single trailing newline', () => {
    const dsl = irToDsl(IF_ELSE_IR);
    expect(typeof dsl).toBe('string');
    expect(dsl.length).toBeGreaterThan(0);
    expect(dsl.endsWith('\n')).toBe(true);
    expect(dsl.endsWith('\n\n')).toBe(false);
  });

  it('uses 2-space indentation for nested blocks', () => {
    const dsl = irToDsl(IF_ELSE_IR);
    // The conditioned branch body (a user task) is indented two levels.
    expect(dsl).toContain('\n    user B "B task"');
  });
});

// ---------------------------------------------------------------------------
// 6. Service-task bindings and fenced script tasks.
// ---------------------------------------------------------------------------

/**
 * Wrap a single flow element in a minimal `start → node → end` process so one
 * statement's rendering can be asserted in isolation and re-parsed.
 */
function singleNodeProcess(node: FlowElement): BpmnProcess {
  return {
    id: 'p',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'S' },
      node,
      { kind: 'endEvent', id: 'E' },
    ],
    sequenceFlows: [
      { id: 'f0', sourceRef: 'S', targetRef: node.id },
      { id: 'f1', sourceRef: node.id, targetRef: 'E' },
    ],
  };
}

describe('irToDsl — service-task bindings', () => {
  it('renders a class binding as `service X { class = "…" }` (byte-unchanged)', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'serviceTask',
        id: 'Charge',
        binding: { kind: 'class', className: 'com.example.Charge' },
      }),
    );
    expect(dsl).toContain('service Charge { class = "com.example.Charge" }');
  });

  it('keeps a labelled class binding identical to the historical output (regression)', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'serviceTask',
        id: 'AutoApprove',
        name: 'Auto-approve',
        binding: {
          kind: 'class',
          className: 'com.example.invoice.AutoApproveDelegate',
        },
      }),
    );
    expect(dsl).toContain(
      'service AutoApprove "Auto-approve" { class = "com.example.invoice.AutoApproveDelegate" }',
    );
  });

  it('renders an expression binding as `service X { expression = "${…}" }`', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'serviceTask',
        id: 'Calc',
        binding: {
          kind: 'expression',
          expression: '${greeter.hello(execution)}',
        },
      }),
    );
    expect(dsl).toContain(
      'service Calc { expression = "${greeter.hello(execution)}" }',
    );
  });

  it('renders a delegateExpression binding with the `delegate` alias', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'serviceTask',
        id: 'Ship',
        binding: { kind: 'delegateExpression', expression: '${shipDelegate}' },
      }),
    );
    expect(dsl).toContain('service Ship { delegate = "${shipDelegate}" }');
    // The XML-level `delegateExpression` name never surfaces in the source.
    expect(dsl).not.toContain('delegateExpression');
  });

  it('renders an external binding as `external X { topic = "…" }`', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'serviceTask',
        id: 'Notify',
        binding: { kind: 'external', topic: 'notifications' },
      }),
    );
    expect(dsl).toContain('external Notify { topic = "notifications" }');
    // An external binding uses the `external` keyword, not `service`.
    expect(dsl).not.toContain('service Notify');
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
      const ir = await reDesugar(irToDsl(singleNodeProcess(node)));
      const svc = ir.flowElements.find((e) => e.id === node.id);
      expect(svc?.kind === 'serviceTask' && svc.binding.kind).toBe(kind);
    }
  });
});

describe('irToDsl — fenced script task', () => {
  it('emits a fenced `script X ```<format> … ``` ` block (open tag, body, close)', () => {
    const code = 'var x = 1;\nexecution.setVariable("x", x);';
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'scriptTask',
        id: 'Compute',
        format: 'javascript',
        code,
      }),
    );
    // The whole block: opening fence + language tag, verbatim body, closing fence.
    expect(dsl).toContain(`script Compute \`\`\`javascript\n${code}\`\`\``);
  });

  it('reproduces the body byte-for-byte without re-indenting it', () => {
    // A body carrying its own indentation must survive verbatim — the emitter
    // must not prepend block indentation to the opaque script content.
    const code = 'if (ok) {\n  doThing();\n}';
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'scriptTask',
        id: 'Guard',
        format: 'groovy',
        code,
      }),
    );
    expect(dsl).toContain(`\`\`\`groovy\n${code}\`\`\``);
  });

  it('carries the label before the fence when present', () => {
    const dsl = irToDsl(
      singleNodeProcess({
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
      irToDsl(
        singleNodeProcess({
          kind: 'scriptTask',
          id: 'Compute',
          format: 'javascript',
          code: 'x = 1',
        }),
      ),
    );
    const script = ir.flowElements.find((e) => e.kind === 'scriptTask');
    expect(script?.kind === 'scriptTask' && script.format).toBe('javascript');
    expect(script?.kind === 'scriptTask' && script.code).toBe('x = 1');
  });
});

// ---------------------------------------------------------------------------
// 7. Sub-process emission (multi-line `subprocess { … }` groups).
//
// The `subprocess` surface is defined in the language package; these
// IR-literal-driven tests do not re-parse. They assert the emitted text: the
// opening line, the child body restructured by a fresh Emitter and indented one
// level deeper, and the closing brace.
// ---------------------------------------------------------------------------

describe('irToDsl — sub-process emission', () => {
  /** `PStart → Before → sub(SubStart → Work → SubEnd) → After → PEnd`. */
  const NESTED_IR: BpmnProcess = {
    id: 'proc',
    isExecutable: true,
    flowElements: [
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
    sequenceFlows: [
      { id: 'f0', sourceRef: 'PStart', targetRef: 'Before' },
      { id: 'f1', sourceRef: 'Before', targetRef: 'sub' },
      { id: 'f2', sourceRef: 'sub', targetRef: 'After' },
      { id: 'f3', sourceRef: 'After', targetRef: 'PEnd' },
    ],
  };

  it('prints `subprocess sub { … }` with the body indented one level', () => {
    const dsl = irToDsl(NESTED_IR);
    // The subprocess opening line sits at one indent level (2 spaces).
    expect(dsl).toContain('\n  subprocess sub {\n');
    // Its body statements sit one level deeper (4 spaces).
    expect(dsl).toContain('\n    start SubStart');
    expect(dsl).toContain('\n    user Work { assignee = "demo" }');
    expect(dsl).toContain('\n    end SubEnd');
    // The closing brace returns to the subprocess's own indent level.
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
    // Parent statements sit at the top level (2-space indent), not inside the
    // sub-process body, and keep their document order around it.
    expect(dsl).toContain('\n  user Before');
    expect(dsl).toContain('\n  user After');
    expect(beforeIdx).toBeLessThan(subIdx);
    expect(subIdx).toBeLessThan(afterIdx);
    // No goto is needed for the straight-line parent chain.
    expect(hasGoto(dsl)).toBe(false);
  });

  it('restructures an if/else inside a sub-process body (two indent levels)', () => {
    const SUB_WITH_IF: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'sub',
          flowElements: [
            { kind: 'startEvent', id: 'SubStart' },
            {
              kind: 'exclusiveGateway',
              id: 'Gateway_sub_0_split',
              defaultFlowId: 'df',
            },
            { kind: 'exclusiveGateway', id: 'Gateway_sub_0_join' },
            { kind: 'userTask', id: 'Yes' },
            { kind: 'userTask', id: 'No' },
            { kind: 'endEvent', id: 'SubEnd' },
          ],
          sequenceFlows: [
            {
              id: 's0',
              sourceRef: 'SubStart',
              targetRef: 'Gateway_sub_0_split',
            },
            {
              id: 's1',
              conditionExpression: '${ok}',
              sourceRef: 'Gateway_sub_0_split',
              targetRef: 'Yes',
            },
            { id: 'df', sourceRef: 'Gateway_sub_0_split', targetRef: 'No' },
            { id: 's2', sourceRef: 'Yes', targetRef: 'Gateway_sub_0_join' },
            { id: 's3', sourceRef: 'No', targetRef: 'Gateway_sub_0_join' },
            {
              id: 's4',
              sourceRef: 'Gateway_sub_0_join',
              targetRef: 'SubEnd',
            },
          ],
        },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      sequenceFlows: [
        { id: 'f0', sourceRef: 'PStart', targetRef: 'sub' },
        { id: 'f1', sourceRef: 'sub', targetRef: 'PEnd' },
      ],
    };

    const dsl = irToDsl(SUB_WITH_IF);
    // The `if` sits inside the sub-process body: two indent levels (4 spaces).
    expect(dsl).toContain('\n    if (ok) {');
    expect(dsl).toContain('\n    } else {');
    // Branch bodies sit a further level in (6 spaces).
    expect(dsl).toContain('\n      user Yes');
    expect(dsl).toContain('\n      user No');
    // The gateways are elided — no `gateway` keyword surfaces.
    expect(hasGatewayKeyword(dsl)).toBe(false);
  });

  it('prints the quoted label for a named sub-process', () => {
    const NAMED: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'St' },
        {
          kind: 'subProcess',
          id: 'S',
          name: 'Handle order',
          flowElements: [{ kind: 'userTask', id: 'Do' }],
          sequenceFlows: [],
        },
        { kind: 'endEvent', id: 'En' },
      ],
      sequenceFlows: [
        { id: 'f0', sourceRef: 'St', targetRef: 'S' },
        { id: 'f1', sourceRef: 'S', targetRef: 'En' },
      ],
    };
    const dsl = irToDsl(NAMED);
    expect(dsl).toContain('subprocess S "Handle order" {');
  });

  it('prints an empty sub-process body as `subprocess S {` immediately followed by `}`', () => {
    const EMPTY: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'St' },
        {
          kind: 'subProcess',
          id: 'S',
          name: 'Handle order',
          flowElements: [],
          sequenceFlows: [],
        },
        { kind: 'endEvent', id: 'En' },
      ],
      sequenceFlows: [
        { id: 'f0', sourceRef: 'St', targetRef: 'S' },
        { id: 'f1', sourceRef: 'S', targetRef: 'En' },
      ],
    };
    const dsl = irToDsl(EMPTY);
    // Empty body: the opening line is directly followed by the closing brace,
    // both at the sub-process's own indent level.
    expect(dsl).toContain('  subprocess S "Handle order" {\n  }\n');
  });

  it('prints an unnamed empty sub-process body without a label', () => {
    const UNNAMED_EMPTY: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'St' },
        {
          kind: 'subProcess',
          id: 'S',
          flowElements: [],
          sequenceFlows: [],
        },
        { kind: 'endEvent', id: 'En' },
      ],
      sequenceFlows: [
        { id: 'f0', sourceRef: 'St', targetRef: 'S' },
        { id: 'f1', sourceRef: 'S', targetRef: 'En' },
      ],
    };
    const dsl = irToDsl(UNNAMED_EMPTY);
    // No `name` means `labelSuffix(undefined)` is `''`: no quoted label.
    expect(dsl).toContain('  subprocess S {\n  }\n');
  });
});

// ---------------------------------------------------------------------------
// 8. Call-activity emission (single-line `call <id> { … }` statements).
//
// IR-literal-driven and parser-free: these assert the emitted text
// (canonical member order, mapping shorthand, version print contract), not a
// re-parse — the parser lives in the language package.
// ---------------------------------------------------------------------------

describe('irToDsl — call activity', () => {
  it('prints the full single-line form in canonical member order with shorthand', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'callActivity',
        id: 'CallSub',
        name: 'Call sub',
        calledElement: 'sub-process',
        binding: { kind: 'deployment' },
        businessKey: '${execution.processBusinessKey}',
        inMappings: [
          { kind: 'all' },
          // source === target → bare shorthand.
          { kind: 'variable', source: 'amount', target: 'amount' },
          // source !== target → `target = source`.
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
          { kind: 'expression', sourceExpression: '${status}', target: 'final' },
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

  it('prints a minimal call as `call X { process = "p" }`', () => {
    const dsl = irToDsl(
      singleNodeProcess({ kind: 'callActivity', id: 'X', calledElement: 'p' }),
    );
    expect(dsl).toContain('call X { process = "p" }');
  });

  it('prints `binding = latest` for a latest binding', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'callActivity',
        id: 'X',
        calledElement: 'p',
        binding: { kind: 'latest' },
      }),
    );
    expect(dsl).toContain('call X { process = "p" binding = latest }');
  });

  it('prints only `version = 3` for a numeric version binding (no `binding` key)', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'callActivity',
        id: 'X',
        calledElement: 'p',
        binding: { kind: 'version', version: '3' },
      }),
    );
    expect(dsl).toContain('call X { process = "p" version = 3 }');
    expect(dsl).not.toContain('binding =');
  });

  it('prints a non-numeric version quoted verbatim', () => {
    const dsl = irToDsl(
      singleNodeProcess({
        kind: 'callActivity',
        id: 'X',
        calledElement: 'p',
        binding: { kind: 'version', version: '${v}' },
      }),
    );
    expect(dsl).toContain('call X { process = "p" version = "${v}" }');
  });

  it('prints a call in mid-chain as a plain fall-through node (order preserved)', () => {
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Before' },
        { kind: 'callActivity', id: 'Mid', calledElement: 'sub' },
        { kind: 'userTask', id: 'After' },
        { kind: 'endEvent', id: 'E' },
      ],
      sequenceFlows: [
        { id: 'f0', sourceRef: 'S', targetRef: 'Before' },
        { id: 'f1', sourceRef: 'Before', targetRef: 'Mid' },
        { id: 'f2', sourceRef: 'Mid', targetRef: 'After' },
        { id: 'f3', sourceRef: 'After', targetRef: 'E' },
      ],
    };
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
// These fixtures are printed and asserted directly (no re-parse): the parser
// lives in the language package, so the full round-trip is exercised by the
// workspace-level tests instead.
// ---------------------------------------------------------------------------

describe('irToDsl — event layer', () => {
  it('prints declarations, throws, emits, and trailing handlers in order', () => {
    const ir: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      errorMessages: [{ code: 'PF', message: 'boom' }],
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'userTask', id: 'Work' },
        {
          kind: 'intermediateThrowEvent',
          id: 'Ping',
          eventDefinition: { kind: 'escalation', escalationCode: 'LS' },
        },
        {
          kind: 'endEvent',
          id: 'Boom',
          eventDefinition: { kind: 'error', errorCode: 'PF' },
        },
        {
          kind: 'subProcess',
          id: 'OnPF',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'PFStart',
              eventDefinition: {
                kind: 'error',
                errorCode: 'PF',
                codeVariable: 'c',
                messageVariable: 'm',
              },
            },
            { kind: 'userTask', id: 'Recover' },
            { kind: 'endEvent', id: 'PFEnd' },
          ],
          sequenceFlows: [
            { id: 'SF_PFStart_Recover', sourceRef: 'PFStart', targetRef: 'Recover' },
            { id: 'SF_Recover_PFEnd', sourceRef: 'Recover', targetRef: 'PFEnd' },
          ],
        },
        {
          kind: 'subProcess',
          id: 'OnLS',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'LSStart',
              isInterrupting: false,
              eventDefinition: {
                kind: 'escalation',
                escalationCode: 'LS',
                codeVariable: 'v',
              },
            },
            { kind: 'userTask', id: 'Note' },
            { kind: 'endEvent', id: 'LSEnd' },
          ],
          sequenceFlows: [
            { id: 'SF_LSStart_Note', sourceRef: 'LSStart', targetRef: 'Note' },
            { id: 'SF_Note_LSEnd', sourceRef: 'Note', targetRef: 'LSEnd' },
          ],
        },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_Work', sourceRef: 'PStart', targetRef: 'Work' },
        { id: 'SF_Work_Ping', sourceRef: 'Work', targetRef: 'Ping' },
        { id: 'SF_Ping_Boom', sourceRef: 'Ping', targetRef: 'Boom' },
      ],
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
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'endEvent',
          id: 'Esc',
          eventDefinition: { kind: 'escalation', escalationCode: 'X' },
        },
      ],
      sequenceFlows: [{ id: 'F', sourceRef: 'S', targetRef: 'Esc' }],
    };
    const dsl = irToDsl(ir);
    expect(dsl).toContain('throw escalation Esc "X"');
    expect(dsl).not.toContain('end Esc');
  });

  it('prints a plain end event as end', () => {
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'Done' },
      ],
      sequenceFlows: [{ id: 'F', sourceRef: 'S', targetRef: 'Done' }],
    };
    expect(irToDsl(ir)).toContain('end Done');
  });

  it('nests a construct inside a handler body two levels deep', () => {
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        {
          kind: 'subProcess',
          id: 'H',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'HS',
              eventDefinition: { kind: 'error', errorCode: 'C' },
            },
            {
              kind: 'exclusiveGateway',
              id: 'Gateway_HS_split',
              defaultFlowId: 'DF',
            },
            { kind: 'userTask', id: 'A' },
            { kind: 'exclusiveGateway', id: 'Gateway_HS_join' },
            { kind: 'endEvent', id: 'HE' },
          ],
          sequenceFlows: [
            { id: 'F1', sourceRef: 'HS', targetRef: 'Gateway_HS_split' },
            {
              id: 'F2',
              sourceRef: 'Gateway_HS_split',
              targetRef: 'A',
              conditionExpression: '${amount > 1000}',
            },
            { id: 'DF', sourceRef: 'Gateway_HS_split', targetRef: 'Gateway_HS_join' },
            { id: 'F3', sourceRef: 'A', targetRef: 'Gateway_HS_join' },
            { id: 'F4', sourceRef: 'Gateway_HS_join', targetRef: 'HE' },
          ],
        },
      ],
      sequenceFlows: [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    };
    const dsl = irToDsl(ir);
    // The handler header sits at one indent level, its `if` at two, its body at
    // three — the gateway pair is elided into the `if`.
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
  /** An `on …` handler wrapping a single `start → user → end` body. */
  function handler(
    id: string,
    startId: string,
    def: EventDefinition,
    isInterrupting?: false,
  ): FlowElement {
    const start: FlowElement =
      isInterrupting === false
        ? { kind: 'startEvent', id: startId, isInterrupting, eventDefinition: def }
        : { kind: 'startEvent', id: startId, eventDefinition: def };
    return {
      kind: 'subProcess',
      id,
      triggeredByEvent: true,
      flowElements: [
        start,
        { kind: 'userTask', id: `${id}_Work` },
        { kind: 'endEvent', id: `${id}_End` },
      ],
      sequenceFlows: [
        { id: `SF_${id}_a`, sourceRef: startId, targetRef: `${id}_Work` },
        { id: `SF_${id}_b`, sourceRef: `${id}_Work`, targetRef: `${id}_End` },
      ],
    };
  }

  it('prints message/signal headers, the signal emit/throw, and trailing handlers', () => {
    const ir: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'intermediateThrowEvent',
          id: 'EmitSig',
          eventDefinition: { kind: 'signal', signalName: 'Cancelled' },
        },
        {
          kind: 'endEvent',
          id: 'ThrowSig',
          eventDefinition: { kind: 'signal', signalName: 'Cancelled' },
        },
        handler('OnMsg', 'MsgStart', {
          kind: 'message',
          messageName: 'PaymentReceived',
        }),
        handler(
          'OnSig',
          'SigStart',
          { kind: 'signal', signalName: 'Cancelled' },
          false,
        ),
      ],
      sequenceFlows: [
        { id: 'SF_PStart_EmitSig', sourceRef: 'PStart', targetRef: 'EmitSig' },
        { id: 'SF_EmitSig_ThrowSig', sourceRef: 'EmitSig', targetRef: 'ThrowSig' },
      ],
    };
    const dsl = irToDsl(ir);
    expect(dsl).toContain('  emit signal EmitSig "Cancelled"\n');
    expect(dsl).toContain('  throw signal ThrowSig "Cancelled"\n');
    expect(dsl).toContain('  on message "PaymentReceived" {\n');
    expect(dsl).toContain('  on signal "Cancelled" alongside {\n');
    // Handlers print last: both headers follow the throw.
    expect(dsl.indexOf('on message')).toBeGreaterThan(dsl.indexOf('throw signal'));
    expect(dsl.indexOf('on signal')).toBeGreaterThan(dsl.indexOf('on message'));
  });

  it('prints the three timer particles, with alongside on the repeating one', () => {
    const ir: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        handler('OnAfter', 'AfterStart', {
          kind: 'timer',
          timerKind: 'duration',
          expression: 'PT1H',
        }),
        handler('OnAt', 'AtStart', {
          kind: 'timer',
          timerKind: 'date',
          expression: '2026-08-01T09:00:00',
        }),
        handler(
          'OnEvery',
          'EveryStart',
          { kind: 'timer', timerKind: 'cycle', expression: 'R/PT10M' },
          false,
        ),
      ],
      sequenceFlows: [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    };
    const dsl = irToDsl(ir);
    expect(dsl).toContain('  on timer after "PT1H" {\n');
    expect(dsl).toContain('  on timer at "2026-08-01T09:00:00" {\n');
    expect(dsl).toContain('  on timer every "R/PT10M" alongside {\n');
  });

  it('prints a condition header as bare DSL when the body is in the subset', () => {
    const ir: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        handler('OnCond', 'CondStart', {
          kind: 'conditional',
          condition: '${amount > 100}',
        }),
      ],
      sequenceFlows: [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    };
    expect(irToDsl(ir)).toContain('  on condition (amount > 100) {\n');
  });

  it('prints a condition header as a quoted raw fallback when out of subset', () => {
    const ir: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        handler('OnCond', 'CondStart', {
          kind: 'conditional',
          condition: '${bean.check()}',
        }),
      ],
      sequenceFlows: [{ id: 'F', sourceRef: 'S', targetRef: 'E' }],
    };
    expect(irToDsl(ir)).toContain('  on condition ("${bean.check()}") {\n');
  });

  it('refuses a throw-side event carrying a non-throwable definition', () => {
    const badEnd: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'endEvent',
          id: 'Bad',
          eventDefinition: { kind: 'message', messageName: 'X' },
        },
      ],
      sequenceFlows: [{ id: 'F', sourceRef: 'S', targetRef: 'Bad' }],
    };
    expect(() => irToDsl(badEnd)).toThrow(/message/);

    const badEmit: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'intermediateThrowEvent',
          id: 'Bad',
          eventDefinition: { kind: 'timer', timerKind: 'duration', expression: 'PT1H' },
        },
        { kind: 'endEvent', id: 'E' },
      ],
      sequenceFlows: [
        { id: 'F1', sourceRef: 'S', targetRef: 'Bad' },
        { id: 'F2', sourceRef: 'Bad', targetRef: 'E' },
      ],
    };
    expect(() => irToDsl(badEmit)).toThrow(/timer/);
  });
});
