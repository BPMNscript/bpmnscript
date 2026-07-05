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
import type { BpmnProcess, SequenceFlow } from '../src/ir/types.js';

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
    { kind: 'serviceTask', id: 'C', javaClass: 'com.example.C' },
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
    { kind: 'serviceTask', id: 'Y', javaClass: 'com.example.Y' },
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
      javaClass: 'com.example.invoice.AutoApproveDelegate',
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

  it('invoice import preserves assignee, javaClass and condition through re-desugar', async () => {
    const dsl = irToDsl(INVOICE_IR);
    const ir = await reDesugar(dsl);

    const review = ir.flowElements.find(
      (e) => e.kind === 'userTask' && e.id === 'ReviewInvoice',
    );
    expect(review?.kind === 'userTask' && review.assignee).toBe('demo');

    const auto = ir.flowElements.find(
      (e) => e.kind === 'serviceTask' && e.id === 'AutoApprove',
    );
    expect(auto?.kind === 'serviceTask' && auto.javaClass).toBe(
      'com.example.invoice.AutoApproveDelegate',
    );

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
