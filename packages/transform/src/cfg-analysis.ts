/**
 * Dominators, post-dominators and back-edges over one {@link FlowContainer},
 * with no DSL knowledge (ADR 0009).
 */
import { isGateway } from './ir/types.js';
import type { FlowContainer, SequenceFlow } from './ir/types.js';

export const VIRTUAL_ENTRY = '__cfg_entry__';

export const VIRTUAL_EXIT = '__cfg_exit__';

/** Total over any string, including unknown ids and the sentinels. */
export interface CfgAnalysis {
  immediateDominator(node: string): string | undefined;

  /**
   * `undefined` also for a fragment `VIRTUAL_ENTRY` never reaches: no latch is
   * recorded there, so no head is wired to the exit.
   */
  immediatePostDominator(node: string): string | undefined;

  dominates(a: string, b: string): boolean;

  postDominates(a: string, b: string): boolean;

  /**
   * Dominance from the starts alone (see `withoutReentries`): a handler or link
   * catch re-entering a loop body must not unnest the loop.
   */
  loopDominates(a: string, b: string): boolean;

  loopImmediateDominator(node: string): string | undefined;

  backEdges(): SequenceFlow[];

  /**
   * Heads of the loops `to` sits past, when `from` is outside them (reaching
   * `to` needs a `goto`). Outermost first.
   */
  headsEnteredPast(from: string, to: string): string[];

  /**
   * Whether the back edges into `node` only close a cycle of jumps, so they
   * must print as `goto`, not a loop test.
   */
  isJumpCycleHead(node: string): boolean;

  /**
   * The gateway whose test closes the loop at `node`: `node` for a `while`, the
   * returning gateway for a `do`. Never a second back edge (a `goto`) into it.
   */
  ownLoopTest(node: string): string | undefined;

  outgoing(node: string): string[];

  incoming(node: string): string[];
}

export function analyzeCfg(container: FlowContainer): CfgAnalysis {
  const graph = buildGraph(container);

  const idom = computeIdom(graph.succ, graph.pred, VIRTUAL_ENTRY);

  // Back edges come from the starts-only graph (see `withoutReentries`).
  // Filtering the raw flow list keeps parallel edges and drops sentinel edges.
  const forward = withoutReentries(graph);
  const loopIdom = computeIdom(forward.succ, forward.pred, VIRTUAL_ENTRY);
  const loopDominates = makeDominanceQuery(loopIdom, VIRTUAL_ENTRY);
  const { latches, entered, jumpCycleHeads, testGateways } = loopEntries(
    forward,
    container,
  );
  const backEdgeList = container.sequenceFlows.filter((f) =>
    latches.get(f.targetRef)?.has(f.sourceRef),
  );

  // Every latch head is wired to the exit, even one whose test `loopTestRank`
  // left unranked (a jump routed through another test on the cycle does that).
  const exitGraph = withLoopExits(graph, [...latches.keys()]);
  const ipdom = computeIdom(exitGraph.pred, exitGraph.succ, VIRTUAL_EXIT);

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
    loopDominates,
    loopImmediateDominator(node) {
      return loopIdom.get(node);
    },
    backEdges() {
      return backEdgeList;
    },
    headsEnteredPast(from, to) {
      return entered
        .filter((l) => l.past.has(to) && !l.cycle.has(from))
        .map((l) => l.head);
    },
    isJumpCycleHead(node) {
      return jumpCycleHeads.has(node);
    },
    ownLoopTest(node) {
      return testGateways.get(node);
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
  succ: Map<string, string[]>;
  pred: Map<string, string[]>;
  reentries: Set<string>;
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

  // A malformed IR must not throw here.
  for (const f of container.sequenceFlows) {
    if (!realNodes.has(f.sourceRef) || !realNodes.has(f.targetRef)) continue;
    addEdge(f.sourceRef, f.targetRef);
  }

  // Boundary events and unfed link catches are entries beside the start: their
  // token comes from a trigger or a link throw, never a drawn flow. Other nodes
  // without a predecessor stay unwired, being unreachable.
  const hasAnyStart = container.flowElements.some(
    (e) => e.kind === 'startEvent',
  );
  const reentries = new Set<string>();
  for (const el of container.flowElements) {
    const hasRealPred = pred.get(el.id)!.length > 0;
    const isLinkCatch =
      el.kind === 'intermediateCatchEvent' &&
      el.eventDefinition.kind === 'link' &&
      !hasRealPred;
    if (el.kind === 'boundaryEvent' || isLinkCatch) reentries.add(el.id);
    if (
      el.kind === 'startEvent' ||
      el.kind === 'boundaryEvent' ||
      isLinkCatch
    ) {
      addEdge(VIRTUAL_ENTRY, el.id);
    } else if (!hasAnyStart && !hasRealPred) {
      addEdge(VIRTUAL_ENTRY, el.id);
    }
  }

  // Every sink drains to the one exit post-dominance needs.
  for (const el of container.flowElements) {
    const hasRealSucc = succ.get(el.id)!.length > 0;
    if (el.kind === 'endEvent' || !hasRealSucc) addEdge(el.id, VIRTUAL_EXIT);
  }

  return { succ, pred, reentries };
}

/**
 * `graph` without the edges joining a re-entry's chain to what the starts
 * reach, for loop finding only: other queries need them, since a split whose
 * merge a handler also enters has no printable block.
 */
function withoutReentries(graph: Graph): Graph {
  const reached = closure([VIRTUAL_ENTRY], (n) =>
    n === VIRTUAL_ENTRY
      ? graph.succ.get(n)!.filter((m) => !graph.reentries.has(m))
      : graph.succ.get(n)!,
  );
  const joinsStartFlow = (from: string, to: string) =>
    !reached.has(from) && reached.has(to) && to !== VIRTUAL_EXIT;
  const prune = (edges: Map<string, string[]>, forward: boolean) =>
    new Map(
      [...edges].map(([n, ns]) => [
        n,
        ns.filter(
          (m) => !(forward ? joinsStartFlow(n, m) : joinsStartFlow(m, n)),
        ),
      ]),
    );
  return {
    succ: prune(graph.succ, true),
    pred: prune(graph.pred, false),
    reentries: graph.reentries,
  };
}

/**
 * Wires each cycle head with no route to the exit to it, standing in for the
 * loop's exit route. `heads` is outermost first, so a head reached through an
 * enclosing head's new edge needs none of its own.
 */
function withLoopExits(graph: Graph, heads: readonly string[]): Graph {
  const succ = new Map([...graph.succ].map(([n, ns]) => [n, [...ns]]));
  const pred = new Map([...graph.pred].map(([n, ns]) => [n, [...ns]]));
  for (const head of heads) {
    if (reachesExit(pred).has(head)) continue;
    succ.get(head)!.push(VIRTUAL_EXIT);
    pred.get(VIRTUAL_EXIT)!.push(head);
  }
  return { succ, pred, reentries: graph.reentries };
}

function reachesExit(pred: Map<string, string[]>): Set<string> {
  return closure([VIRTUAL_EXIT], (n) => pred.get(n) ?? []);
}

/**
 * Breadth-first reach from `seeds`. Reaching `stop` ends the walk early, so
 * the result is complete only without it.
 */
export function closure(
  seeds: readonly string[],
  next: (n: string) => readonly string[],
  stop?: string,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n === stop) break;
    queue.push(...next(n));
  }
  return seen;
}

/**
 * Cooper/Harvey/Kennedy iterative dominators, which tolerate the irreducible
 * graphs `goto` produces. Unreachable nodes are absent from the result.
 */
function computeIdom(
  succ: Map<string, string[]>,
  pred: Map<string, string[]>,
  root: string,
): Map<string, string | undefined> {
  const rpo = reversePostorder(root, succ);
  const order = new Map<string, number>();
  rpo.forEach((id, i) => order.set(id, i));

  // The root is its own dominator only while iterating.
  const idom = new Map<string, string | undefined>();
  idom.set(root, root);

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of rpo) {
      if (node === root) continue;

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

interface EnteredLoop {
  head: string;
  cycle: Set<string>;
  /** Cycle nodes other than the head and the gateways it is entered at. */
  past: Set<string>;
}

/**
 * Finds cycles outermost first: each strongly connected set's head is removed
 * and the rest searched again for nested cycles.
 * A `goto` into a loop body makes a second entry, so the head is the entry the
 * cycle's own test touches (see {@link loopTestRank}), model order only breaking
 * ties. A cycle whose own test touches no entry is made of jumps alone.
 */
function loopEntries(
  graph: Graph,
  container: FlowContainer,
): {
  latches: Map<string, Set<string>>;
  entered: EnteredLoop[];
  jumpCycleHeads: Set<string>;
  testGateways: Map<string, string>;
} {
  const listed = new Map(container.flowElements.map((e, i) => [e.id, i]));
  const gateways = new Set(
    container.flowElements.filter(isGateway).map((e) => e.id),
  );
  const conditioned = container.sequenceFlows.filter(
    (f) => f.conditionExpression !== undefined,
  );
  const latches = new Map<string, Set<string>>();
  const entered: EnteredLoop[] = [];
  const jumpCycleHeads = new Set<string>();
  const testGateways = new Map<string, string>();
  const pending = [new Set(reversePostorder(VIRTUAL_ENTRY, graph.succ))];
  while (pending.length > 0) {
    const nodes = pending.pop()!;
    for (const scc of cycles(nodes, graph.succ)) {
      const inside = new Set(scc);
      const outside = (n: string) =>
        graph.pred.get(n)!.filter((p) => !inside.has(p));
      // An unconditioned flow in from outside: a hint of the cycle's way in, not
      // proof (`user Z; goto B` enters B unconditioned too).
      const hasNaturalEntry = (n: string) =>
        outside(n).some((p) =>
          container.sequenceFlows.some(
            (f) =>
              f.sourceRef === p &&
              f.targetRef === n &&
              f.conditionExpression === undefined,
          ),
        );
      // A node latched to an enclosing head stays in `inside`, so its exit route
      // can form a pseudo-cycle of jumps. Such a waypoint has no test of its own
      // here; a while nested in a while reuses its node but does have one.
      const testSources = new Set(
        conditioned
          .filter((f) => inside.has(f.sourceRef) && inside.has(f.targetRef))
          .map((f) => f.sourceRef),
      );
      const justWaypoints = scc.filter(
        (n) =>
          !testSources.has(n) && [...latches.values()].some((s) => s.has(n)),
      );
      const jumpsOnly =
        justWaypoints.length > 0 &&
        cycles(
          new Set(scc.filter((n) => !justWaypoints.includes(n))),
          graph.succ,
        ).length === 0;
      const rank = jumpsOnly
        ? (n: string) => (gateways.has(n) ? 1 : 0)
        : loopTestRank(
            inside,
            conditioned,
            graph.succ,
            hasNaturalEntry,
            (n) => outside(n).length > 0,
          );
      const entries = scc
        .filter((n) => outside(n).length > 0)
        .sort((a, b) => rank(a) - rank(b) || listed.get(a)! - listed.get(b)!);
      const head = entries[0]!;
      const backSources = new Set(
        graph.pred.get(head)!.filter((p) => inside.has(p)),
      );
      latches.set(head, backSources);
      if (jumpsOnly) {
        jumpCycleHeads.add(head);
      } else {
        // A `do` test is a conditioned back edge from a gateway with exactly one
        // conditioned flow in the whole container (more is a multi-way branch
        // sharing the head). `rank` is not read: an outer guard can outrank it.
        const ownTests = [...backSources].filter(
          (s) =>
            conditioned.some(
              (f) => f.sourceRef === s && f.targetRef === head,
            ) && conditioned.filter((f) => f.sourceRef === s).length === 1,
        );
        // A `while` head has an unconditioned back edge and one conditioned exit;
        // otherwise it may still be a jump cycle recognized later.
        const isWhileHead =
          gateways.has(head) &&
          conditioned.filter((f) => f.sourceRef === head).length === 1 &&
          [...backSources].some((s) =>
            container.sequenceFlows.some(
              (f) =>
                f.sourceRef === s &&
                f.targetRef === head &&
                f.conditionExpression === undefined,
            ),
          );
        const owner = isWhileHead
          ? head
          : ownTests.length === 1
            ? ownTests[0]
            : undefined;
        // Gated on `rank`, not `owner`: several `do` candidates still close a real
        // loop, which `headsEnteredPast` must keep.
        if (rank(head) < UNTESTED) {
          const past = new Set(scc);
          past.delete(head);
          for (const e of entries) if (gateways.has(e)) past.delete(e);
          entered.push({ head, cycle: new Set(scc), past });
        }
        if (owner !== undefined) {
          testGateways.set(head, owner);
        }
      }
      inside.delete(head);
      pending.push(inside);
    }
  }
  return { latches, entered, jumpCycleHeads, testGateways };
}

const UNTESTED = 2;

/**
 * Ranks a node by the cycle's own tests: 0 for a test's gateway (`while`
 * head), 1 for its target (`do` head), `UNTESTED` otherwise.
 * A test is a conditioned flow `g -> t` inside the cycle; its body is what `t`
 * reaches without passing `g`, less what `g`'s other routes reach.
 * A test is natural when `g` or `t` has an unconditioned entry from outside.
 * A test is not the cycle's own when:
 * - its gateway sits in another test's body that it does not hold in turn
 *   (a nested loop's test), unless only it is natural and the other returns
 *   into its loop, where the other loses instead: that one is a conditioned
 *   `goto` spanning the cycle, since a real outer test returns ahead of the
 *   inner loop;
 * - it is not natural, and its loop closes avoiding the other test's gateway
 *   while the other's does not (a jump from after an outer loop into the
 *   inner body);
 * - it jumps into a node entered from outside only by a jump, and its
 *   gateway's other routes return to it through a natural entry (an `if`
 *   jumping into a plain-flow loop). Its target ranks below every entry.
 */
function loopTestRank(
  inside: Set<string>,
  conditioned: SequenceFlow[],
  succ: Map<string, string[]>,
  hasNaturalEntry: (n: string) => boolean,
  entered: (n: string) => boolean,
): (n: string) => number {
  const within = (n: string, avoid: string) => n !== avoid && inside.has(n);
  const reach = (from: string, avoid: string) =>
    closure(within(from, avoid) ? [from] : [], (n) =>
      succ.get(n)!.filter((m) => within(m, avoid)),
    );
  const tests = conditioned.filter(
    (f) => inside.has(f.sourceRef) && inside.has(f.targetRef),
  );
  const body = new Map(
    tests.map((f) => {
      const g = f.sourceRef;
      const own = reach(f.targetRef, g);
      for (const other of succ.get(g)!) {
        if (other === f.targetRef) continue;
        for (const n of reach(other, g)) own.delete(n);
      }
      return [f, own];
    }),
  );
  // Removing d disconnects exactly the nodes d dominates, so one dominator tree
  // per test, rooted at its target, answers each "reachable avoiding d" in O(1).
  const insideSucc = new Map(
    [...inside].map((n) => [n, succ.get(n)!.filter((m) => inside.has(m))]),
  );
  const insidePred = new Map<string, string[]>([...inside].map((n) => [n, []]));
  for (const [n, outs] of insideSucc) {
    for (const m of outs) insidePred.get(m)!.push(n);
  }
  const domFrom = new Map(
    tests.map((f) => [
      f,
      makeDominanceQuery(
        computeIdom(insideSucc, insidePred, f.targetRef),
        f.targetRef,
      ),
    ]),
  );
  const closesAvoiding = (f: SequenceFlow, avoid: string): boolean =>
    !domFrom.get(f)!(avoid, f.sourceRef);
  const jumpsIntoCycle = (f: SequenceFlow): boolean => {
    if (!entered(f.targetRef) || hasNaturalEntry(f.targetRef)) return false;
    const around = new Set(
      succ
        .get(f.sourceRef)!
        .filter((o) => o !== f.targetRef)
        .flatMap((o) => [...reach(o, f.targetRef)]),
    );
    return around.has(f.sourceRef) && [...around].some(hasNaturalEntry);
  };
  const enclosed = (f: SequenceFlow, o: SequenceFlow): boolean =>
    body.get(o)!.has(f.sourceRef) && !body.get(f)!.has(o.sourceRef);
  const natural = (f: SequenceFlow): boolean =>
    hasNaturalEntry(f.sourceRef) || hasNaturalEntry(f.targetRef);
  const turnsRound = (outer: SequenceFlow, inner: SequenceFlow): boolean =>
    enclosed(inner, outer) &&
    natural(inner) &&
    !natural(outer) &&
    !domFrom.get(inner)!(inner.sourceRef, outer.targetRef);
  const jumps = tests.filter(jumpsIntoCycle);
  const own = tests.filter(
    (f) =>
      !jumps.includes(f) &&
      !tests.some(
        (o) =>
          o.sourceRef !== f.sourceRef &&
          ((enclosed(f, o) && !turnsRound(o, f)) ||
            turnsRound(f, o) ||
            (!natural(f) &&
              closesAvoiding(f, o.sourceRef) &&
              !closesAvoiding(o, f.sourceRef))),
      ),
  );
  return (n) =>
    own.some((f) => f.sourceRef === n)
      ? 0
      : own.some((f) => f.targetRef === n)
        ? 1
        : jumps.some((f) => f.targetRef === n)
          ? UNTESTED + 1
          : UNTESTED;
}

/** Strongly connected components holding a cycle (iterative Tarjan). */
function cycles(nodes: Set<string>, succ: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const enter = (node: string) => {
    index.set(node, index.size);
    low.set(node, index.get(node)!);
    stack.push(node);
    onStack.add(node);
  };

  for (const root of nodes) {
    if (index.has(root)) continue;
    enter(root);
    const frames: Array<{ node: string; childIdx: number }> = [
      { node: root, childIdx: 0 },
    ];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const children = succ.get(frame.node) ?? [];
      if (frame.childIdx < children.length) {
        const child = children[frame.childIdx++];
        if (!nodes.has(child)) continue;
        if (!index.has(child)) {
          enter(child);
          frames.push({ node: child, childIdx: 0 });
        } else if (onStack.has(child)) {
          low.set(
            frame.node,
            Math.min(low.get(frame.node)!, index.get(child)!),
          );
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        low.set(
          parent.node,
          Math.min(low.get(parent.node)!, low.get(frame.node)!),
        );
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let n: string;
        do {
          n = stack.pop()!;
          onStack.delete(n);
          component.push(n);
        } while (n !== frame.node);
        if (component.length > 1 || children.includes(frame.node)) {
          components.push(component);
        }
      }
    }
  }
  return components;
}

/**
 * Dominance as interval containment of pre-order entry/exit numbers on the
 * idom tree. Nodes absent from `idom` answer false.
 */
function makeDominanceQuery(
  idom: Map<string, string | undefined>,
  root: string,
): (a: string, b: string) => boolean {
  const { entry, exit } = numberDominatorTree(idom, root);

  return (a, b) => {
    const ea = entry.get(a);
    const eb = entry.get(b);
    if (ea === undefined || eb === undefined) return false;
    return ea <= eb && eb <= exit.get(a)!;
  };
}

function numberDominatorTree(
  idom: Map<string, string | undefined>,
  root: string,
): { entry: Map<string, number>; exit: Map<string, number> } {
  const children = new Map<string, string[]>();
  for (const [node, parent] of idom) {
    if (node === root || parent === undefined) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(node);
  }

  const entry = new Map<string, number>();
  const exit = new Map<string, number>();
  let counter = 0;

  const stack: Array<{ node: string; childIdx: number }> = [
    { node: root, childIdx: 0 },
  ];
  entry.set(root, counter++);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const kids = children.get(frame.node) ?? [];
    if (frame.childIdx < kids.length) {
      const child = kids[frame.childIdx++];
      entry.set(child, counter++);
      stack.push({ node: child, childIdx: 0 });
    } else {
      exit.set(frame.node, counter - 1);
      stack.pop();
    }
  }

  return { entry, exit };
}
