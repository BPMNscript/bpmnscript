/**
 * Dominators, post-dominators, and back-edges over a {@link FlowContainer}'s
 * `flowElements` and `sequenceFlows`. Pure graph machinery with no DSL
 * knowledge, so it runs the same on a whole process or one sub-process body;
 * `irToDsl`'s pattern catalogue consumes it to recognize structured regions.
 *
 * ADR 0009, Use Dominator/Post-Dominator Analysis for IR-to-DSL Restructuring,
 * names the query set.
 */

import type { FlowContainer, SequenceFlow } from './ir/types.js';

/** Synthetic single source: dominator analysis needs one root. */
export const VIRTUAL_ENTRY = '__cfg_entry__';

/** Synthetic single sink: post-dominator analysis needs one. */
export const VIRTUAL_EXIT = '__cfg_exit__';

/**
 * Every method is total: a defined answer for any string, including unknown
 * ids, unreachable nodes, and the two sentinels. `dominates` and
 * `postDominates` are reflexive.
 */
export interface CfgAnalysis {
  /** `undefined` at the virtual entry, and for an unreachable or unknown node. */
  immediateDominator(node: string): string | undefined;

  /** `undefined` at the virtual exit, and for a node that cannot reach it. */
  immediatePostDominator(node: string): string | undefined;

  dominates(a: string, b: string): boolean;

  postDominates(a: string, b: string): boolean;

  /** Original {@link SequenceFlow} objects, in input order. */
  backEdges(): SequenceFlow[];

  outgoing(node: string): string[];

  incoming(node: string): string[];
}

export function analyzeCfg(container: FlowContainer): CfgAnalysis {
  const graph = buildGraph(container);

  const idom = computeIdom(graph.succ, graph.pred, VIRTUAL_ENTRY);

  // Post-dominators are the dominators of the reversed graph.
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
      // A back-edge is u -> v where v dominates u. Filtering the raw flow
      // list keeps every parallel edge and excludes the sentinel edges.
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

interface Graph {
  /** Insertion-ordered and de-duplicated; dominance is set-based. */
  succ: Map<string, string[]>;
  pred: Map<string, string[]>;
}

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

  // Skip flows referencing unknown ids so a malformed IR cannot throw here.
  for (const f of container.sequenceFlows) {
    if (!realNodes.has(f.sourceRef) || !realNodes.has(f.targetRef)) continue;
    addEdge(f.sourceRef, f.targetRef);
  }

  // A boundary event is a second, independent entry: its token appears when
  // the host is running and the trigger fires, never along a sequence flow.
  // So it is wired unconditionally, not folded into the no-start fallback,
  // which stays keyed on the absence of a start event. A no-predecessor node
  // that is neither is left unwired when a start exists: it really is
  // unreachable, and the dominance queries must say so.
  const hasAnyStart = container.flowElements.some(
    (e) => e.kind === 'startEvent',
  );
  for (const el of container.flowElements) {
    const hasRealPred = pred.get(el.id)!.length > 0;
    if (el.kind === 'startEvent' || el.kind === 'boundaryEvent') {
      addEdge(VIRTUAL_ENTRY, el.id);
    } else if (!hasAnyStart && !hasRealPred) {
      addEdge(VIRTUAL_ENTRY, el.id);
    }
  }

  // Every node with no real successor drains to the exit too, otherwise it
  // is a second sink the post-dominator analysis cannot see.
  for (const el of container.flowElements) {
    const hasRealSucc = succ.get(el.id)!.length > 0;
    if (el.kind === 'endEvent' || !hasRealSucc) addEdge(el.id, VIRTUAL_EXIT);
  }

  return { succ, pred };
}

/**
 * Cooper/Harvey/Kennedy iterative dominators, which tolerate the irreducible
 * graphs `goto` produces. Swap `succ`/`pred` and root at the exit for
 * post-dominators. Unreachable nodes are absent from the result, which
 * callers read as "no immediate dominator".
 */
function computeIdom(
  succ: Map<string, string[]>,
  pred: Map<string, string[]>,
  root: string,
): Map<string, string | undefined> {
  const rpo = reversePostorder(root, succ);
  const order = new Map<string, number>();
  rpo.forEach((id, i) => order.set(id, i));

  // `undefined` means "not yet computed". Only the root is seeded, as its own
  // dominator for the duration; the final value is set below.
  const idom = new Map<string, string | undefined>();
  idom.set(root, root);

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of rpo) {
      if (node === root) continue;

      // Intersect all already-processed predecessors.
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

  idom.set(root, undefined);

  return idom;
}

/** Two-finger walk up the dominator tree, reverse-postorder number as depth. */
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

/** Iterative DFS, so a deep graph cannot overflow the stack. */
function reversePostorder(root: string, succ: Map<string, string[]>): string[] {
  const postorder: string[] = [];
  const visited = new Set<string>();

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

/** `a` dominates `b` when `a` sits on `b`'s idom chain. Reflexive and total. */
function makeDominanceQuery(
  idom: Map<string, string | undefined>,
  root: string,
): (a: string, b: string) => boolean {
  return (a, b) => {
    if (!idom.has(b)) return false;
    if (a !== root && !idom.has(a)) return false;

    let cur: string | undefined = b;
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
