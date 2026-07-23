/**
 * CFG analysis utility — dominators, post-dominators, and back-edges.
 *
 * This is pure graph machinery with **no DSL knowledge**. It builds a
 * control-flow graph (CFG) from a {@link FlowContainer} (nodes = flow
 * elements, edges = sequence flows), then answers the dominance and
 * back-edge queries the restructuring `irToDsl` pattern catalogue
 * needs to recognize structured regions. It reads only a container's
 * `flowElements`/`sequenceFlows`, so it runs identically on a whole process
 * or on a single sub-process body.
 *
 * ## What the catalogue gets
 * - `immediateDominator(n)` / `immediatePostDominator(n)`
 * - `dominates(a, b)` / `postDominates(a, b)` (reflexive — a node
 *   dominates itself)
 * - `backEdges()` — every edge `u → v` where `v` dominates `u`
 * - `outgoing(n)` / `incoming(n)` — raw adjacency
 *
 * ## Gateway agnosticism
 * The CFG layer does **not** care whether a node is an exclusive or a
 * parallel gateway — a diamond of `parallelGateway`s yields exactly the
 * same dominator / post-dominator relations as the same shape built from
 * `exclusiveGateway`s. The `irToDsl` pattern catalogue is the only layer that
 * distinguishes the two.
 *
 * ## Virtual entry / exit (single-source, single-sink)
 * Dominator analysis needs a single root; post-dominator analysis needs a
 * single sink. We synthesize:
 * - {@link VIRTUAL_ENTRY}: edges to every start event, to every boundary
 *   event, and — defensively — to every other real node that has no real
 *   predecessor (so a hand-built IR with no `startEvent` still has a root).
 *   A boundary event is wired unconditionally, exactly like a start event:
 *   it has no incoming sequence flow by construction (its token appears the
 *   moment its host activity is running and the trigger fires, never by
 *   traversing a flow edge), so without this it would be unreachable and
 *   its whole escape chain would have no immediate dominator — nothing in
 *   it could ever be recognized as an `if`/`while`. The accepted trade-off:
 *   a node reachable from *both* the main flow and an escape chain no
 *   longer has a tight immediate dominator (only the virtual entry, their
 *   nearest common ancestor, does), so a structured region whose join a
 *   boundary chain jumps into degrades to `goto`s on decompile. That is
 *   correct, not a regression — such a region genuinely is not dominated by
 *   its split. Unreachable nodes are deliberately **not** wired to the
 *   entry; see "Unreachable nodes".
 * - {@link VIRTUAL_EXIT}: an edge from every end event, and from every real
 *   node with no real successor, so multi-exit processes have one sink and
 *   the sink post-dominates every real end.
 *
 * ## Algorithm
 * Iterative dominators (Cooper/Harvey/Kennedy 2001); handles the irreducible
 * graphs `goto` can produce. We run it once on the forward graph for
 * dominators and once on the reversed graph (rooted at the virtual exit)
 * for post-dominators.
 *
 * ## Unreachable nodes (degenerate but possible in hand-built IR)
 * A node with no path from the virtual entry has **no** immediate dominator
 * — `immediateDominator(n)` returns `undefined`, and it neither dominates
 * nor is dominated by anything. All queries stay **total**: every helper
 * returns a defined value (never throws) for unknown ids, unreachable
 * nodes, and the virtual sentinels alike. Symmetrically, a node that cannot
 * reach the virtual exit has no immediate post-dominator. A `boundaryEvent`
 * is never itself unreachable: it is always wired to the virtual entry (see
 * above), so only the nodes *inside* a malformed escape chain — never the
 * boundary event that starts it — could be unreachable.
 */

import type { FlowContainer, SequenceFlow } from './ir/types.js';

/** The synthetic single source over all start events. */
export const VIRTUAL_ENTRY = '__cfg_entry__';

/** The synthetic single sink over all end events. */
export const VIRTUAL_EXIT = '__cfg_exit__';

/**
 * The public query surface produced by {@link analyzeCfg}. Every method is
 * total: it returns a defined value for any string id, including unknown
 * ids, unreachable nodes, and the {@link VIRTUAL_ENTRY}/{@link VIRTUAL_EXIT}
 * sentinels.
 */
export interface CfgAnalysis {
  /**
   * The immediate dominator of `node`, or `undefined` if `node` is the
   * virtual entry, is unreachable, or is unknown.
   */
  immediateDominator(node: string): string | undefined;

  /**
   * The immediate post-dominator of `node`, or `undefined` if `node` is the
   * virtual exit, cannot reach the exit, or is unknown.
   */
  immediatePostDominator(node: string): string | undefined;

  /**
   * `true` iff `a` dominates `b` (reflexive: `dominates(x, x)` is `true`
   * for any reachable `x`). `false` for unreachable / unknown nodes.
   */
  dominates(a: string, b: string): boolean;

  /**
   * `true` iff `a` post-dominates `b` (reflexive). `false` for nodes that
   * cannot reach the exit / unknown nodes.
   */
  postDominates(a: string, b: string): boolean;

  /**
   * Every edge `u → v` where `v` dominates `u`. Each entry is the original
   * {@link SequenceFlow}. Edges touching the virtual sentinels are never
   * back-edges (they carry no real flow id). Returned in stable input
   * order.
   */
  backEdges(): SequenceFlow[];

  /** Ids of the direct successors of `node` (CFG order). Total. */
  outgoing(node: string): string[];

  /** Ids of the direct predecessors of `node` (CFG order). Total. */
  incoming(node: string): string[];
}

/**
 * Build the CFG and dominator / post-dominator trees for `container` and
 * return the query surface. Pure — no I/O, no mutation of the input.
 */
export function analyzeCfg(container: FlowContainer): CfgAnalysis {
  const graph = buildGraph(container);

  // Forward dominators: rooted at the virtual entry.
  const idom = computeIdom(graph.succ, graph.pred, VIRTUAL_ENTRY);

  // Post-dominators: dominators of the reversed graph, rooted at the exit.
  const ipdom = computeIdom(graph.pred, graph.succ, VIRTUAL_EXIT);

  const dominates = makeDominanceQuery(idom, VIRTUAL_ENTRY);
  const postDominates = makeDominanceQuery(ipdom, VIRTUAL_EXIT);

  return {
    immediateDominator(node) {
      return idom.get(node);
    },
    immediatePostDominator(node) {
      return ipdom.get(node);
    },
    dominates,
    postDominates,
    backEdges() {
      // A back-edge is u → v where v dominates u. Only real flows qualify:
      // the sentinel edges have no SequenceFlow and never loop.
      return container.sequenceFlows.filter((f) =>
        dominates(f.targetRef, f.sourceRef),
      );
    },
    outgoing(node) {
      return [...(graph.succ.get(node) ?? [])];
    },
    incoming(node) {
      return [...(graph.pred.get(node) ?? [])];
    },
  };
}

// ---------------------------------------------------------------------------
// Graph construction.
// ---------------------------------------------------------------------------

interface Graph {
  /** All node ids, including the two virtual sentinels. */
  nodes: string[];
  /** id → successor ids (insertion-ordered, de-duplicated). */
  succ: Map<string, string[]>;
  /** id → predecessor ids (insertion-ordered, de-duplicated). */
  pred: Map<string, string[]>;
}

/**
 * Derive the adjacency graph from the IR, wiring in the virtual entry and
 * exit. Multi-edges between the same pair are preserved in `pred`/`succ`
 * only once (dominance is set-based, so duplicates add nothing) but the raw
 * {@link SequenceFlow} list — used for back-edge detection — keeps every
 * original edge.
 */
function buildGraph(container: FlowContainer): Graph {
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();

  const nodeIds = container.flowElements.map((e) => e.id);
  const realNodes = new Set(nodeIds);

  const ensure = (id: string) => {
    if (!succ.has(id)) succ.set(id, []);
    if (!pred.has(id)) pred.set(id, []);
  };

  ensure(VIRTUAL_ENTRY);
  ensure(VIRTUAL_EXIT);
  for (const id of nodeIds) ensure(id);

  const addEdge = (from: string, to: string) => {
    const outs = succ.get(from)!;
    if (!outs.includes(to)) outs.push(to);
    const ins = pred.get(to)!;
    if (!ins.includes(from)) ins.push(from);
  };

  // Real edges. Skip flows referencing unknown ids so a malformed IR
  // cannot throw here.
  for (const f of container.sequenceFlows) {
    if (!realNodes.has(f.sourceRef) || !realNodes.has(f.targetRef)) continue;
    addEdge(f.sourceRef, f.targetRef);
  }

  // Wire the ENTRY to every start event, and to every boundary event. A
  // `startEvent` is the canonical process source. A `boundaryEvent` is a
  // second, independent entry: at runtime a token appears there the moment
  // its host activity is running and the trigger fires — never by
  // traversing a sequence flow into it (a boundary event has no incoming
  // flow at all) — so it is wired unconditionally, the same as a start
  // event, not folded into the no-start fallback below. If the IR has NO
  // start event at all (degenerate, but possible in a hand-built fixture) we
  // fall back to wiring every remaining node that has no real predecessor,
  // so the forward analysis still has a root; this fallback stays keyed on
  // the absence of a *start* event, since a boundary event's presence says
  // nothing about whether the main flow has its own entry.
  //
  // Deliberately we do NOT wire an arbitrary no-predecessor node that is
  // neither a start nor a boundary event to the entry when a start event
  // exists: such a node is genuinely **unreachable** from the process entry,
  // and the dominance queries must reflect that (it has no immediate
  // dominator). See the module docs.
  const hasAnyStart = container.flowElements.some((e) => e.kind === 'startEvent');
  for (const el of container.flowElements) {
    const hasRealPred = pred.get(el.id)!.length > 0;
    if (el.kind === 'startEvent' || el.kind === 'boundaryEvent') {
      addEdge(VIRTUAL_ENTRY, el.id);
    } else if (!hasAnyStart && !hasRealPred) {
      addEdge(VIRTUAL_ENTRY, el.id);
    }
  }

  // Wire every end event — and, defensively, every node with no real
  // successor — to the EXIT. A no-successor node would otherwise be a sink
  // the post-dominator analysis could not see, so even orphaned/unreachable
  // nodes drain to the exit; this keeps the post-dominator tree well-formed
  // and the virtual sink the post-dominator of every real end.
  for (const el of container.flowElements) {
    const hasRealSucc = succ.get(el.id)!.length > 0;
    if (el.kind === 'endEvent' || !hasRealSucc) addEdge(el.id, VIRTUAL_EXIT);
  }

  return { nodes: [VIRTUAL_ENTRY, VIRTUAL_EXIT, ...nodeIds], succ, pred };
}

// ---------------------------------------------------------------------------
// Cooper-Harvey-Kennedy iterative dominators.
// ---------------------------------------------------------------------------

/**
 * Compute the immediate-dominator map for a graph rooted at `root`, using
 * the given forward (`succ`) and reverse (`pred`) adjacency. To compute
 * post-dominators, call with `succ`/`pred` swapped and `root = VIRTUAL_EXIT`.
 *
 * The returned map contains an entry for every node **reachable** from
 * `root`. The root maps to `undefined` (it has no dominator); unreachable
 * nodes are absent — callers treat "absent" as "no immediate dominator".
 *
 * @param succ  id → successors (the direction the analysis flows)
 * @param pred  id → predecessors (used to combine dominator sets)
 * @param root  the single source the tree is rooted at
 */
function computeIdom(
  succ: Map<string, string[]>,
  pred: Map<string, string[]>,
  root: string,
): Map<string, string | undefined> {
  // Reverse postorder over the nodes reachable from `root`, following `succ`.
  const rpo = reversePostorder(root, succ);
  const order = new Map<string, number>();
  rpo.forEach((id, i) => order.set(id, i));

  // idom is keyed by node; undefined means "not yet computed". Per CHK we
  // seed only the root and iterate until a fixpoint.
  const idom = new Map<string, string | undefined>();
  idom.set(root, root); // root is its own dominator during the iteration

  let changed = true;
  while (changed) {
    changed = false;
    // Process nodes in reverse postorder, skipping the root.
    for (const node of rpo) {
      if (node === root) continue;

      // New idom = intersection of all already-processed predecessors.
      let newIdom: string | undefined;
      for (const p of pred.get(node) ?? []) {
        if (!order.has(p)) continue; // predecessor not reachable from root
        if (idom.get(p) === undefined) continue; // not processed yet
        newIdom =
          newIdom === undefined ? p : intersect(newIdom, p, idom, order);
      }

      if (newIdom !== undefined && idom.get(node) !== newIdom) {
        idom.set(node, newIdom);
        changed = true;
      }
    }
  }

  // The root has no immediate dominator; expose that as `undefined`.
  idom.set(root, undefined);

  return idom;
}

/**
 * Intersect two nodes in the dominator tree (CHK's two-finger walk up the
 * tree using reverse-postorder numbers as a proxy for tree depth).
 */
function intersect(
  a: string,
  b: string,
  idom: Map<string, string | undefined>,
  order: Map<string, number>,
): string {
  let finger1 = a;
  let finger2 = b;
  while (finger1 !== finger2) {
    while ((order.get(finger1) ?? 0) > (order.get(finger2) ?? 0)) {
      const next = idom.get(finger1);
      if (next === undefined) return finger2; // reached the root side
      finger1 = next;
    }
    while ((order.get(finger2) ?? 0) > (order.get(finger1) ?? 0)) {
      const next = idom.get(finger2);
      if (next === undefined) return finger1;
      finger2 = next;
    }
  }
  return finger1;
}

/**
 * Reverse postorder of the nodes reachable from `root`, following `succ`.
 * Iterative DFS to avoid stack overflow on large graphs.
 */
function reversePostorder(root: string, succ: Map<string, string[]>): string[] {
  const postorder: string[] = [];
  const visited = new Set<string>();

  // Each frame tracks the node and the index of the next child to visit.
  const stack: Array<{ node: string; childIdx: number }> = [
    { node: root, childIdx: 0 },
  ];
  visited.add(root);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const children = succ.get(frame.node) ?? [];
    if (frame.childIdx < children.length) {
      const child = children[frame.childIdx++];
      if (!visited.has(child)) {
        visited.add(child);
        stack.push({ node: child, childIdx: 0 });
      }
    } else {
      postorder.push(frame.node);
      stack.pop();
    }
  }

  return postorder.reverse();
}

// ---------------------------------------------------------------------------
// Dominance queries derived from an idom map.
// ---------------------------------------------------------------------------

/**
 * Build a reflexive dominance predicate from an immediate-dominator map.
 * `dominates(a, b)` walks `b` up its idom chain to the root; if `a` is on
 * that chain, `a` dominates `b`. Reflexive (`dominates(x, x) === true` for
 * reachable `x`) and total (unknown / unreachable nodes → `false`).
 */
function makeDominanceQuery(
  idom: Map<string, string | undefined>,
  root: string,
): (a: string, b: string) => boolean {
  return (a, b) => {
    // Both must participate in the tree (be reachable from the root).
    if (!idom.has(b)) return false;
    if (a !== root && !idom.has(a)) return false;

    let cur: string | undefined = b;
    // Bounded walk: the idom chain is acyclic and at most |nodes| long.
    const guard = idom.size + 1;
    let steps = 0;
    while (cur !== undefined && steps++ <= guard) {
      if (cur === a) return true;
      if (cur === root) break;
      cur = idom.get(cur);
    }
    return false;
  };
}
