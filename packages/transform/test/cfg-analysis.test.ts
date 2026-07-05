/**
 * Unit tests for the CFG analysis utility.
 *
 * The module is pure graph machinery with no DSL knowledge: it builds a
 * control-flow graph from a {@link BpmnProcess}, computes dominators and
 * post-dominators (Cooper-Harvey-Kennedy iterative), and answers the
 * dominance / back-edge queries the restructuring pattern catalogue needs.
 *
 * These tests are the behavioral contract for that catalogue.
 * They deliberately exercise BOTH gateway kinds on the same shape to
 * prove the analysis is gateway-agnostic.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeCfg,
  VIRTUAL_ENTRY,
  VIRTUAL_EXIT,
} from '../src/cfg-analysis.js';
import type {
  BpmnProcess,
  FlowElement,
  SequenceFlow,
} from '../src/ir/types.js';

// ---------------------------------------------------------------------------
// Tiny fixture helpers — keep the graphs readable.
// ---------------------------------------------------------------------------

function start(id: string): FlowElement {
  return { kind: 'startEvent', id };
}
function end(id: string): FlowElement {
  return { kind: 'endEvent', id };
}
function task(id: string): FlowElement {
  return { kind: 'userTask', id };
}
function xor(id: string, defaultFlowId?: string): FlowElement {
  return { kind: 'exclusiveGateway', id, defaultFlowId };
}
function and(id: string): FlowElement {
  return { kind: 'parallelGateway', id };
}
function flow(sourceRef: string, targetRef: string): SequenceFlow {
  return { id: `Flow_${sourceRef}_${targetRef}`, sourceRef, targetRef };
}

function process(
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
): BpmnProcess {
  return {
    id: 'P',
    isExecutable: true,
    flowElements,
    sequenceFlows,
  };
}

// ---------------------------------------------------------------------------
// Diamond shape (shared between the XOR and parallel acceptance tests):
//
//        start
//          |
//        split
//        /    \
//       A      B
//        \    /
//         join
//          |
//         end
//
// 1. XOR diamond.
// ---------------------------------------------------------------------------

describe('diamond (exclusive gateways)', () => {
  const proc = process(
    [
      start('start'),
      xor('split'),
      task('A'),
      task('B'),
      xor('join'),
      end('end'),
    ],
    [
      flow('start', 'split'),
      flow('split', 'A'),
      flow('split', 'B'),
      flow('A', 'join'),
      flow('B', 'join'),
      flow('join', 'end'),
    ],
  );
  const cfg = analyzeCfg(proc);

  it('split dominates join', () => {
    expect(cfg.dominates('split', 'join')).toBe(true);
  });

  it('join post-dominates split', () => {
    expect(cfg.postDominates('join', 'split')).toBe(true);
  });

  it('split does NOT dominate A exclusively in the strict sense but dominates it', () => {
    expect(cfg.dominates('split', 'A')).toBe(true);
    expect(cfg.dominates('split', 'B')).toBe(true);
  });

  it('A does not dominate join (the other branch reaches it)', () => {
    expect(cfg.dominates('A', 'join')).toBe(false);
    expect(cfg.dominates('B', 'join')).toBe(false);
  });

  it('immediate dominator of join is split', () => {
    expect(cfg.immediateDominator('join')).toBe('split');
  });

  it('immediate post-dominator of split is join', () => {
    expect(cfg.immediatePostDominator('split')).toBe('join');
  });

  it('reports no back-edges on an acyclic diamond', () => {
    expect(cfg.backEdges()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Parallel diamond — IDENTICAL relations (gateway-agnostic proof).
// ---------------------------------------------------------------------------

describe('diamond (parallel gateways) — gateway agnostic', () => {
  const proc = process(
    [
      start('start'),
      and('split'),
      task('A'),
      task('B'),
      and('join'),
      end('end'),
    ],
    [
      flow('start', 'split'),
      flow('split', 'A'),
      flow('split', 'B'),
      flow('A', 'join'),
      flow('B', 'join'),
      flow('join', 'end'),
    ],
  );
  const cfg = analyzeCfg(proc);

  it('produces the same dominance relations as the XOR diamond', () => {
    expect(cfg.dominates('split', 'join')).toBe(true);
    expect(cfg.postDominates('join', 'split')).toBe(true);
    expect(cfg.immediateDominator('join')).toBe('split');
    expect(cfg.immediatePostDominator('split')).toBe('join');
    expect(cfg.dominates('A', 'join')).toBe(false);
    expect(cfg.backEdges()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Pre-test loop.
//
//   start → head
//   head → body   (conditioned entry)
//   head → exit   (default out)
//   body → head   (back-edge)
//   exit → end
// ---------------------------------------------------------------------------

describe('pre-test loop', () => {
  const proc = process(
    [start('start'), xor('head'), task('body'), task('exit'), end('end')],
    [
      flow('start', 'head'),
      flow('head', 'body'),
      flow('head', 'exit'),
      flow('body', 'head'),
      flow('exit', 'end'),
    ],
  );
  const cfg = analyzeCfg(proc);

  it('detects exactly the body→head back-edge', () => {
    const back = cfg.backEdges();
    expect(back).toHaveLength(1);
    expect(back[0].sourceRef).toBe('body');
    expect(back[0].targetRef).toBe('head');
  });

  it('head dominates the body', () => {
    expect(cfg.dominates('head', 'body')).toBe(true);
  });

  it('head dominates the exit', () => {
    expect(cfg.dominates('head', 'exit')).toBe(true);
  });

  it('the back-edge target dominates its source', () => {
    const [edge] = cfg.backEdges();
    expect(cfg.dominates(edge.targetRef, edge.sourceRef)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-exit process — virtual sink post-dominates all real ends.
// ---------------------------------------------------------------------------

describe('multi-exit process', () => {
  const proc = process(
    [start('start'), xor('split'), end('end1'), end('end2')],
    [flow('start', 'split'), flow('split', 'end1'), flow('split', 'end2')],
  );
  const cfg = analyzeCfg(proc);

  it('the virtual sink post-dominates every real end', () => {
    expect(cfg.postDominates(VIRTUAL_EXIT, 'end1')).toBe(true);
    expect(cfg.postDominates(VIRTUAL_EXIT, 'end2')).toBe(true);
  });

  it('the virtual sink post-dominates the split', () => {
    expect(cfg.postDominates(VIRTUAL_EXIT, 'split')).toBe(true);
  });

  it('no single real end post-dominates the split', () => {
    expect(cfg.postDominates('end1', 'split')).toBe(false);
    expect(cfg.postDominates('end2', 'split')).toBe(false);
  });

  it('the immediate post-dominator of each end is the virtual sink', () => {
    expect(cfg.immediatePostDominator('end1')).toBe(VIRTUAL_EXIT);
    expect(cfg.immediatePostDominator('end2')).toBe(VIRTUAL_EXIT);
  });
});

// ---------------------------------------------------------------------------
// 5. Irreducible / unstructured graph — no false back-edge, queries total.
//
// Two entries into a 2-node loop region create irreducibility:
//   start → A
//   start → B
//   A → B
//   B → A      (the genuine cycle)
//   A → end
//   B → end
//
// A→B and B→A form a cycle with two external entries (start→A, start→B):
// neither A nor B dominates the other, so the cycle is irreducible.
// A loop-back to a non-dominating header must NOT be reported as a back-edge.
// ---------------------------------------------------------------------------

describe('irreducible / unstructured graph', () => {
  const proc = process(
    [start('start'), task('A'), task('B'), end('end')],
    [
      flow('start', 'A'),
      flow('start', 'B'),
      flow('A', 'B'),
      flow('B', 'A'),
      flow('A', 'end'),
      flow('B', 'end'),
    ],
  );
  const cfg = analyzeCfg(proc);

  it('reports no false back-edges (neither A nor B dominates the other)', () => {
    expect(cfg.dominates('A', 'B')).toBe(false);
    expect(cfg.dominates('B', 'A')).toBe(false);
    expect(cfg.backEdges()).toEqual([]);
  });

  it('keeps all dominance queries total (never throws)', () => {
    expect(() => cfg.dominates('A', 'end')).not.toThrow();
    expect(() => cfg.postDominates('end', 'A')).not.toThrow();
    expect(() => cfg.immediateDominator('A')).not.toThrow();
    expect(() => cfg.immediatePostDominator('B')).not.toThrow();
  });

  it('the virtual entry dominates everything reachable', () => {
    expect(cfg.dominates(VIRTUAL_ENTRY, 'A')).toBe(true);
    expect(cfg.dominates(VIRTUAL_ENTRY, 'B')).toBe(true);
    expect(cfg.dominates(VIRTUAL_ENTRY, 'end')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Unreachable nodes — degenerate but possible in hand-built IR.
//
// `orphan` has no path from the start; queries must stay total.
// ---------------------------------------------------------------------------

describe('unreachable nodes (degenerate IR)', () => {
  const proc = process(
    [start('start'), task('reachable'), task('orphan'), end('end')],
    [
      flow('start', 'reachable'),
      flow('reachable', 'end'),
      flow('orphan', 'end'),
    ],
  );
  const cfg = analyzeCfg(proc);

  it('an unreachable node has no immediate dominator (undefined)', () => {
    expect(cfg.immediateDominator('orphan')).toBeUndefined();
  });

  it('an unreachable node dominates nothing and is dominated by nothing', () => {
    expect(cfg.dominates(VIRTUAL_ENTRY, 'orphan')).toBe(false);
    expect(cfg.dominates('orphan', 'end')).toBe(false);
  });

  it('queries involving unreachable nodes never throw', () => {
    expect(() => cfg.dominates('orphan', 'reachable')).not.toThrow();
    expect(() => cfg.postDominates('orphan', 'reachable')).not.toThrow();
    expect(() => cfg.backEdges()).not.toThrow();
    expect(() => cfg.outgoing('orphan')).not.toThrow();
    expect(() => cfg.incoming('orphan')).not.toThrow();
  });

  it('still resolves the reachable region correctly', () => {
    expect(cfg.dominates('start', 'reachable')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Adjacency / unknown-node helpers (totality of the surface API).
// ---------------------------------------------------------------------------

describe('adjacency queries and totality', () => {
  const proc = process(
    [start('s'), task('m'), end('e')],
    [flow('s', 'm'), flow('m', 'e')],
  );
  const cfg = analyzeCfg(proc);

  it('outgoing/incoming return adjacent node ids', () => {
    expect(cfg.outgoing('m')).toEqual(['e']);
    expect(cfg.incoming('m')).toEqual(['s']);
  });

  it('the virtual entry feeds the start node', () => {
    expect(cfg.outgoing(VIRTUAL_ENTRY)).toContain('s');
  });

  it('the real end feeds the virtual exit', () => {
    expect(cfg.outgoing('e')).toContain(VIRTUAL_EXIT);
  });

  it('queries on a completely unknown id are total', () => {
    expect(cfg.outgoing('nope')).toEqual([]);
    expect(cfg.incoming('nope')).toEqual([]);
    expect(cfg.dominates('nope', 'm')).toBe(false);
    expect(cfg.dominates('m', 'nope')).toBe(false);
    expect(cfg.immediateDominator('nope')).toBeUndefined();
    expect(cfg.immediatePostDominator('nope')).toBeUndefined();
  });

  it('every node reflexively dominates and post-dominates itself', () => {
    expect(cfg.dominates('m', 'm')).toBe(true);
    expect(cfg.postDominates('m', 'm')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Two-loop process — `backEdges()` preserves the `sequenceFlows` input order.
//
// Two sequential pre-test loops:
//   start → head1
//   head1 → body1 → head1   (loop 1 back-edge)
//   head1 → head2
//   head2 → body2 → head2   (loop 2 back-edge)
//   head2 → end
//
// The two back-edges are deliberately listed in `sequenceFlows` in the order
// [body2→head2, body1→head1] — i.e. NOT topological / discovery order. Because
// `backEdges()` is a stable filter over `sequenceFlows`, it must echo that exact
// input order. A reorder (e.g. driven by RPO traversal) would fail this.
// ---------------------------------------------------------------------------

describe('two-loop process — backEdges preserves input order', () => {
  const proc = process(
    [
      start('start'),
      xor('head1'),
      task('body1'),
      xor('head2'),
      task('body2'),
      end('end'),
    ],
    [
      flow('start', 'head1'),
      flow('head1', 'body1'),
      // Loop 2's back-edge appears in the array BEFORE loop 1's back-edge.
      flow('body2', 'head2'),
      flow('body1', 'head1'),
      flow('head1', 'head2'),
      flow('head2', 'body2'),
      flow('head2', 'end'),
    ],
  );
  const cfg = analyzeCfg(proc);

  it('detects both genuine back-edges', () => {
    const back = cfg.backEdges();
    expect(back).toHaveLength(2);
    expect(cfg.dominates('head2', 'body2')).toBe(true);
    expect(cfg.dominates('head1', 'body1')).toBe(true);
  });

  it('returns the back-edges in `sequenceFlows` input order, not topological order', () => {
    const back = cfg.backEdges();
    // The array lists body2→head2 first, so it must come out first.
    expect(back.map((f) => [f.sourceRef, f.targetRef])).toEqual([
      ['body2', 'head2'],
      ['body1', 'head1'],
    ]);
  });
});
