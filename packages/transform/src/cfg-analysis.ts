/**
 * Dominators, post-dominators, and back-edges over a {@link FlowContainer}'s
 * `flowElements` and `sequenceFlows`. Pure graph machinery with no DSL
 * knowledge, so it runs the same on a whole process or one sub-process body;
 * `irToDsl`'s pattern catalog consumes it to recognize structured regions.
 *
 * ADR 0009, Use Dominator/Post-Dominator Analysis for IR-to-DSL Restructuring,
 * names the query set.
 */

import { isGateway } from './ir/types.js';
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

  /**
   * `undefined` at the virtual exit, and for a node in a fragment the
   * virtual entry never reaches: `loopEntries` walks only what
   * `VIRTUAL_ENTRY` reaches, so no latch is recorded for such a fragment and
   * `withLoopExits` has no head there to wire to the exit.
   */
  immediatePostDominator(node: string): string | undefined;

  dominates(a: string, b: string): boolean;

  postDominates(a: string, b: string): boolean;

  /**
   * Dominance read from the process starts alone, the edges a handler or link
   * catch re-enters pruned first (see `withoutReentries`). A re-entry into a
   * loop body must not unmake the loop's own nesting, which plain `dominates`
   * would: it counts the virtual re-entry root as a second path in, so a
   * nested loop's test gateway stops dominating the outer one's.
   */
  loopDominates(a: string, b: string): boolean;

  /** The immediate dominator under {@link loopDominates}. */
  loopImmediateDominator(node: string): string | undefined;

  /** Original {@link SequenceFlow} objects, in input order. */
  backEdges(): SequenceFlow[];

  /**
   * The heads of the loops holding `to` past their head, for a `from` outside
   * them: getting from `from` to `to` takes a jump into the loop body, as a
   * `goto` does. Outermost first, and empty for any other pair.
   */
  headsEnteredPast(from: string, to: string): string[];

  /**
   * Whether a back edge into `node` (see {@link backEdges}) only closes a
   * cycle of jumps: an enclosing loop's own exit route, not a nested loop's
   * test. A caller reading such a back edge as a `while`'s or `do`'s own test
   * would print a loop where the source has a `goto`.
   */
  isJumpCycleHead(node: string): boolean;

  /**
   * The gateway whose own test closes the cycle at `node` (see
   * {@link backEdges}): `node` itself for a `while`, or the distinct gateway
   * a `do`'s test returns from. `undefined` where `node` heads no tested
   * cycle. A second back edge into the same head, a `goto` closing there
   * too, is never this gateway, however conditioned it prints, and however
   * many of `node`'s back edges a caller has already consumed.
   */
  ownLoopTest(node: string): string | undefined;

  outgoing(node: string): string[];

  incoming(node: string): string[];
}

export function analyzeCfg(container: FlowContainer): CfgAnalysis {
  const graph = buildGraph(container);

  const idom = computeIdom(graph.succ, graph.pred, VIRTUAL_ENTRY);

  // A back-edge closes a cycle at its head (see `loopEntries`), read from the
  // starts alone (see `withoutReentries`). Where the loop is reducible that is
  // exactly u -> v with v dominating u. Filtering the raw flow list keeps
  // every parallel edge and excludes the sentinel edges.
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

  // Post-dominators are the dominators of the reversed graph, rooted at a
  // virtual exit (see {@link withLoopExits}). Every latch head is wired
  // there, whether or not its own test survives `loopTestRank`'s
  // nested-test filtering: a jump routed back through another test on the
  // cycle can leave a real loop's test unranked.
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
  /** Insertion-ordered and de-duplicated; dominance is set-based. */
  succ: Map<string, string[]>;
  pred: Map<string, string[]>;
  /** The boundary events and link catches wired to the virtual entry. */
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

  // A boundary event and a link catch are each an entry beside the start: a
  // boundary's token appears when its trigger fires, a link catch's when the
  // engine reroutes a throw of its name, never along a drawn flow. A caller
  // that draws the throw -> catch hop as a flow has placed the catch, so it
  // is no entry then. Any other node without a predecessor stays unwired: it
  // really is unreachable. A link throw has no successor and drains to
  // VIRTUAL_EXIT below.
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

  // Every node with no real successor drains to the exit too, otherwise it
  // is a second sink the post-dominator analysis cannot see.
  for (const el of container.flowElements) {
    const hasRealSucc = succ.get(el.id)!.length > 0;
    if (el.kind === 'endEvent' || !hasRealSucc) addEdge(el.id, VIRTUAL_EXIT);
  }

  return { succ, pred, reentries };
}

/**
 * `graph` without the edges by which a re-entry's chain joins the flow the
 * starts reach, for finding loops: a handler or link catch jumping into a loop
 * body prints as a `goto` and must not unmake the loop. A node only a re-entry
 * reaches keeps its dominators from that re-entry. The other queries keep the
 * re-entries' edges, since a split whose merge a handler also enters has no
 * block to print.
 */
function withoutReentries(graph: Graph): Graph {
  const reached = new Set<string>([VIRTUAL_ENTRY]);
  const pending = graph.succ
    .get(VIRTUAL_ENTRY)!
    .filter((n) => !graph.reentries.has(n));
  while (pending.length > 0) {
    const n = pending.pop()!;
    if (reached.has(n)) continue;
    reached.add(n);
    pending.push(...graph.succ.get(n)!);
  }
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
 * `graph` with an edge to `VIRTUAL_EXIT` from every cycle's head that has no
 * route there already: the head is where the loop leaves, a `while`'s
 * gateway or a `do`'s first step (or, a cycle of jumps alone, the statement
 * a flow into it lands on), so wiring it stands in for the route the loop
 * would take out were one printable. That only equals the head's actual
 * exit route when it leaves straight from there; the actual exit route can
 * instead loop back through another node into the cycle first. `heads`
 * lists outer cycles before the ones nested in them (see
 * `loopEntries`), so a head already reached through an enclosing one's new
 * edge, the two sharing one cycle a jump joins, needs none of its own.
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

/** Every node with a route to `VIRTUAL_EXIT`, walked backward from it. */
function reachesExit(pred: Map<string, string[]>): Set<string> {
  const seen = new Set([VIRTUAL_EXIT]);
  const stack = [VIRTUAL_EXIT];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const p of pred.get(n) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return seen;
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

interface EnteredLoop {
  head: string;
  cycle: Set<string>;
  /**
   * The nodes of `cycle` other than its head and the gateways it is entered
   * at; reaching one from outside without passing the head takes a jump.
   */
  past: Set<string>;
}

/**
 * The cycles the starts reach: `latches`, keyed by head, are the flows closing
 * a cycle there, the back-edges, and `entered` holds each tested cycle with
 * the nodes past its head. A cycle is a strongly connected set of nodes; its
 * loops nested inside are the cycles left once its head is taken out, so an
 * outer cycle comes first.
 *
 * A reducible loop is entered only at its head. A `goto` into a loop body
 * adds a second entry, and neither entry dominates the other, so the head is
 * the entry the cycle's own test touches (see {@link loopTestRank}): its
 * gateway, a `while`, ahead of the node it returns to, a `do`. Model order,
 * arbitrary in a model another tool wrote, only breaks a tie. A cycle whose
 * own test touches none of its entries is made of jumps alone, so nothing in
 * it is past a head; nor is a gateway the cycle is entered at, since a jump
 * lands on a statement and a flow into a merge is the block around the cycle.
 * Once the compiler has read a print back, the printed loop keeps its head
 * ahead of its body, so every later print closes the same cycle.
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
  // Backs `ownLoopTest` (see the interface doc), filled as each head is found.
  const testGateways = new Map<string, string>();
  const pending = [new Set(reversePostorder(VIRTUAL_ENTRY, graph.succ))];
  while (pending.length > 0) {
    const nodes = pending.pop()!;
    for (const scc of cycles(nodes, graph.succ)) {
      const inside = new Set(scc);
      const outside = (n: string) =>
        graph.pred.get(n)!.filter((p) => !inside.has(p));
      // An unconditioned flow in from outside `inside`: the fall-in a loop
      // after a statement has. Only a hint of the cycle's real way in, not
      // proof: a loop opening an `if` branch is entered by that branch's
      // conditioned route, and `user Z; goto B` enters B unconditioned.
      const hasNaturalEntry = (n: string) =>
        outside(n).some((p) =>
          container.sequenceFlows.some(
            (f) =>
              f.sourceRef === p &&
              f.targetRef === n &&
              f.conditionExpression === undefined,
          ),
        );
      // A node already latched to an enclosing head stays in `inside` here
      // (only the head is removed below), so its own exit route can pull an
      // otherwise acyclic tail back into a pseudo-cycle, the way a `goto`
      // after the enclosing loop does. Only a reused node with no test of
      // its own inside this cycle counts as such a waypoint: a while nested
      // in a while reuses the same node as both the inner test's gateway and
      // the outer's back-edge source, which does have its own test.
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
        // Whether `head` is genuinely tested does not read `rank`: a guard
        // several passes out, its own body swept broad or thin by the same
        // subtraction `loopTestRank` already works around, can still outrank
        // the real test there the way it outranks one closer by. A `while`
        // head is tested by its own outgoing conditioned flow; a `do` head's
        // conditioned back edges are its own test candidates, minus a
        // multi-way branch (an `else if` chain, several conditioned routes
        // off the one gateway): a loop's own test always has exactly one, so
        // more marks a `goto` sharing the head, however conditioned it
        // prints. Several genuine candidates left (loops nested at one body
        // entry, as a `while` immediately inside another `while`'s own back
        // edge) stay untold apart here: `tryDoWhileEntry`'s own dominance
        // reads the outermost first and the body walk re-enters `node` for
        // the next one in, so leaving more than one candidate defers to it.
        // Whether a candidate is multi-way is asked of the whole container,
        // not `inside`: an earlier pass has already taken its other target
        // out of `inside` once that target's own head is found, which would
        // otherwise make a later pass mistake the same branch gateway for a
        // plain binary test.
        const ownTests = [...backSources].filter(
          (s) =>
            conditioned.some(
              (f) => f.sourceRef === s && f.targetRef === head,
            ) && conditioned.filter((f) => f.sourceRef === s).length === 1,
        );
        // An unconditioned back edge from the body's tail, paired with the
        // head's own conditioned exit, makes it a `while` head; only
        // conditioned back edges make it a `do` head instead, whatever else
        // the gateway also tests on its way out. Neither makes it no loop
        // head at all here, only a cycle of jumps a later pass may still
        // recognize by its statement.
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
        // Whether this cycle is tested at all still reads `rank`, not
        // `owner`: several genuine candidates (see `ownTests` above) still
        // close a real loop at `head`, just not one `ownLoopTest` can name
        // yet, and gating `entered` on `owner` too would drop the cycle from
        // `headsEnteredPast` the moment a second candidate appears.
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
 * Ranks a node by the cycle's own tests: 0 for a test's gateway (a `while`
 * head), 1 for the node a test returns to (a `do` head), `UNTESTED` otherwise.
 * A test is a conditioned flow `g -> t` inside the cycle, and its body is what
 * `t` reaches without passing `g`, less what `g`'s other routes reach too: an
 * `if` in a loop body closes at its merge, so its body is its branch alone.
 * A test is natural when its gateway or target has an unconditioned entry
 * from beyond the cycle (see `hasNaturalEntry`).
 * A test is the cycle's own unless its gateway sits in another test's body
 * that it does not hold in turn, which is where a nested loop's test sits, or
 * its loop closes without passing the other test's gateway while the other's
 * does not close without passing its: a jump from after the outer loop back
 * into the inner body puts that body on the outer test's exit route, so the
 * subtraction takes it out of the outer test's body, which the first rule
 * alone misses. The second never disqualifies a natural test, so a
 * conditional nested inside it must not outrank the loop's own test.
 * The first rule turns round, and the outer test loses, where only the
 * inner one is natural and the outer returns into the inner's loop: a
 * conditioned `goto` after the loop back into its body spans the whole
 * cycle, so read as a test it would enclose the loop's own. A real outer
 * loop's test returns ahead of the inner loop, which keeps an
 * unconditioned `goto` into a loop opening an `if` branch from turning it
 * round.
 * A test into a node entered from outside only by a jump is no test of this
 * cycle when its gateway's other routes come back to it past that node,
 * through an entry the flow before the cycle falls into: the cycle closes
 * there without the test, which is an `if` jumping into a loop of plain
 * flow, recognized again in the nested pass once the join is removed. Its
 * target ranks below every other entry, so model order cannot make it the
 * head.
 */
function loopTestRank(
  inside: Set<string>,
  conditioned: SequenceFlow[],
  succ: Map<string, string[]>,
  hasNaturalEntry: (n: string) => boolean,
  entered: (n: string) => boolean,
): (n: string) => number {
  const reach = (from: string, avoid: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n === avoid || !inside.has(n) || seen.has(n)) continue;
      seen.add(n);
      stack.push(...succ.get(n)!);
    }
    return seen;
  };
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
  // `closesAvoiding` and `turnsRound` below each ask "is x reachable from a
  // test's own target, avoiding some node", the same root over and over
  // across the O(T^2) own/turnsRound checks that follow. Removing a node d
  // from a graph disconnects exactly the nodes d dominates, so one
  // dominator tree per test (`computeIdom`, restricted to `inside`, rooted
  // at the test's target) answers every such query in O(1).
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

/**
 * The strongly connected components of `succ` restricted to `nodes` that hold
 * a cycle: more than one node, or one flowing into itself. Tarjan's
 * algorithm, iterative like {@link reversePostorder}.
 */
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
 * `a` dominates `b` when `a` sits on `b`'s idom chain. Reflexive and total.
 * `idom` is a tree rooted at `root`, so one DFS numbers each node with a
 * pre-order entry time and, as its exit time, the last entry time handed out
 * in its subtree; `a` is an ancestor of `b` (or `b` itself) exactly when
 * `b`'s entry falls inside `a`'s [entry, exit]. A node absent from `idom`
 * (unknown or unreachable) gets no interval and answers false on either side.
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

/** Iterative pre-order DFS over the parent map `idom`, rooted at `root`. */
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
