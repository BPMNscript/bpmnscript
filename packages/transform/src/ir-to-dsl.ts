/**
 * Restructuring IR → DSL emitter.
 *
 * The inverse of the desugaring `astToIr`: it turns the **flat,
 * BPMN-shaped** {@link BpmnProcess} IR back into **structured** source —
 * `if`/`else if`/`else`, `while`, `do … while`, `parallel { { } { } }`,
 * explicit `start`/`end`, and `goto` — that re-parses through the grammar
 * and re-desugars to an equivalent IR.
 *
 * ## How it works
 * Structure is recovered from a **dominator / post-dominator** analysis
 * (`cfg-analysis.ts`) against a **fixed pattern catalogue**:
 *
 *   - **If / else-if / else** — an `exclusiveGateway` split `G` with ≥2
 *     outgoing flows and a join `J` such that `J` post-dominates `G` and `G`
 *     dominates `J`. Conditioned out-flows become `if` / `else if` branches
 *     (condition recovered via {@link parseJuel}); the default (unconditioned)
 *     out-flow becomes the trailing `else`. Branch bodies are the sub-regions
 *     between each branch target and `J`. The split/join gateways are
 *     **elided** — there is no `gateway` keyword.
 *   - **While / do-while** — a **back-edge** touching an `exclusiveGateway`
 *     loop head `L`. If the back-edge points *to* `L` (test-before-body, with a
 *     conditioned forward flow into the body and an unconditioned default exit)
 *     → `while`. If the back-edge *leaves* `L` into the body (test-after-body)
 *     → `do { } while`. The loop gateway is elided.
 *   - **Parallel (AND)** — a `parallelGateway` fork `F` and join `J` where `J`
 *     post-dominates `F`, `F` dominates `J`, and the branches are
 *     single-entry/single-exit. → `parallel { { } { } }`. Both gateways elided.
 *   - **Sequence** — a linear single-in / single-out chain → consecutive
 *     statements with implicit top-to-bottom flow.
 *
 * ## Failure contract
 * Every well-formed IR input produces valid source; unstructurable regions
 * degrade to `goto`. Each flow node is emitted exactly once (at its natural
 * position, labelled by its id, which is always a valid jump target per the
 * grammar). Edges are tracked in a consumed-set; whatever is left after
 * structured emission is flushed as `goto`s, so no edge is dropped.
 *
 * ## Synthesized-id elision (what makes DSL → IR → DSL idempotent)
 * The desugarer creates deterministic gateway ids
 * (`Gateway_<X>_split|join|fork|loop`). When a gateway fits its
 * pattern it is collapsed into the structured construct and never printed as a
 * statement — exactly mirroring desugaring, so re-desugaring the emitted source
 * reproduces the same gateway ids.
 *
 * Output conventions: 2-space indent, LF line endings, trailing newline. String
 * values (labels, `assignee`, `formKey`, `class`) are double-quoted. Conditions
 * are rendered via {@link renderRawFallback} (bare DSL when in the JUEL subset,
 * quoted `"${…}"` when raw).
 */

import type { BpmnProcess, FlowElement, SequenceFlow } from './ir/types.js';
import { analyzeCfg, type CfgAnalysis } from './cfg-analysis.js';
import { parseJuel, renderRawFallback } from './juel.js';

const INDENT = '  ';

/**
 * Render an IR process as a structured `.bpmnscript` source string.
 *
 * @param process The IR process to restructure and pretty-print.
 * @returns A UTF-8 `.bpmnscript` source string with a trailing newline.
 */
export function irToDsl(process: BpmnProcess): string {
  const emitter = new Emitter(process);
  const body = emitter.emit();

  const header = buildProcessHeader(process);
  const lines = [header, ...body.map((l) => INDENT + l), '}'];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * Stateful restructuring pass over one process. Holds the CFG analysis, the
 * element/flow lookup tables, and the "consumed" bookkeeping (which nodes have
 * been emitted, which edges have been realized as structured flow) that the
 * `goto` fallback relies on.
 */
class Emitter {
  private readonly cfg: CfgAnalysis;
  private readonly byId = new Map<string, FlowElement>();
  /** Outgoing flows per source id, in IR order. */
  private readonly out = new Map<string, SequenceFlow[]>();
  /** Nodes already emitted (a node is printed exactly once). */
  private readonly emittedNodes = new Set<string>();
  /** Flow ids already realized as structured flow (not needing a goto). */
  private readonly consumedFlows = new Set<string>();

  constructor(private readonly process: BpmnProcess) {
    this.cfg = analyzeCfg(process);
    for (const el of process.flowElements) {
      // Duplicate element ids would silently overwrite the lookup table and
      // corrupt the structured walk. The desugarer guarantees unique
      // ids via collision resolution, so a duplicate here means malformed IR —
      // fail loudly rather than emit a wrong process.
      if (this.byId.has(el.id)) {
        throw new Error(
          `irToDsl: duplicate flow element id '${el.id}' in process '${process.id}'.`,
        );
      }
      this.byId.set(el.id, el);
    }
    for (const f of process.sequenceFlows) {
      const list = this.out.get(f.sourceRef) ?? [];
      list.push(f);
      this.out.set(f.sourceRef, list);
    }
  }

  /**
   * Emit the whole process body as a list of (un-indented) statement lines.
   * The order is: structured emission from each start event, then any node
   * still unemitted (unreachable / orphaned graph fragments), then a final
   * sweep that flushes every flow edge not realized structurally as a `goto`.
   */
  emit(): string[] {
    const lines: string[] = [];

    // 1. Emit from each start event in IR order. A start event roots a
    //    reachable region; the recursive walk emits the structured form.
    for (const el of this.process.flowElements) {
      if (el.kind === 'startEvent' && !this.emittedNodes.has(el.id)) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }

    // 2. Emit any node not yet reached (orphaned fragments in a hand-built /
    //    irreducible IR). Each becomes its own little chain so no node is lost.
    for (const el of this.process.flowElements) {
      if (!this.emittedNodes.has(el.id)) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }

    // 3. Final sweep: any flow edge not consumed by a structured region is
    //    emitted as an explicit `goto` from the (already-emitted) source.
    //    Placed at the end of the body — a `goto` statement may appear
    //    anywhere and references the target by id.
    for (const f of this.process.sequenceFlows) {
      if (!this.consumedFlows.has(f.id)) {
        this.consumedFlows.add(f.id);
        lines.push(`goto ${f.targetRef}`);
      }
    }

    return lines;
  }

  /**
   * Emit a linear chain of statements starting at `node`, following implicit
   * fall-through flow, until reaching `stop` (exclusive), a terminal, or a node
   * that cannot be reached structurally (which degrades to a `goto`).
   *
   * @param node   The node to emit next (its id).
   * @param stop   The region boundary: stop *before* emitting this node, and
   *               consume the edge into it. `undefined` means "until terminal".
   * @param lines  Output accumulator (un-indented; the caller indents blocks).
   * @param depth  Block-nesting depth; a hard cap guards against unbounded
   *               recursion on a pathological IR (every well-formed graph
   *               terminates well below it, since `emittedNodes` prevents
   *               re-entry).
   */
  private emitFrom(
    node: string | undefined,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): void {
    if (depth > MAX_NESTING_DEPTH) {
      // Refuse to recurse further; flush the arrival as a goto rather than
      // overflowing the stack on a pathological graph.
      if (node !== undefined) lines.push(`goto ${node}`);
      return;
    }
    let current = node;
    // The chain length is bounded by the node count; the guard is belt-and-
    // braces against a malformed IR producing an unexpected cycle.
    let guard = this.byId.size + 1;
    while (current !== undefined && current !== stop && guard-- > 0) {
      if (this.emittedNodes.has(current)) {
        // Already emitted elsewhere — realize the arrival as a goto and stop.
        lines.push(`goto ${current}`);
        return;
      }
      const next = this.emitNode(current, stop, lines, depth);
      if (next === STOP) return;
      current = next;
    }
  }

  /**
   * Emit a single node and return the id of the next node in the fall-through
   * chain, or {@link STOP} when the chain ends here (terminal, region boundary,
   * or a structured construct that already emitted its own continuation).
   */
  private emitNode(
    id: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    const el = this.byId.get(id);
    if (el === undefined) return STOP;

    // A do-while body entry is reached on fall-through *before* its loop
    // gateway, so it must be recognized here (at the body entry) and wrapped in
    // a `do { }` block — otherwise the body node would be emitted ahead of the
    // loop and the block would degrade to a `goto`.
    const doWhile = this.tryDoWhileEntry(id, stop, lines, depth);
    if (doWhile !== undefined) return doWhile;

    // Gateways have no statement form; they exist only as desugared
    // structure and are handled exhaustively (so every out-edge is captured by
    // a construct or a goto — gateways cannot rely on the final goto sweep
    // because they have no source statement to jump *from*).
    if (el.kind === 'exclusiveGateway') {
      // A loop head (while) is recognized before the if-chain so it is not
      // mistaken for an XOR split.
      const loop = this.tryWhile(el, stop, lines, depth);
      if (loop !== undefined) return loop;
      return this.emitExclusiveGateway(el, stop, lines, depth);
    }
    if (el.kind === 'parallelGateway') {
      return this.emitParallelGateway(el, stop, lines, depth);
    }

    // Plain task / event: emit the statement, then follow its sole fall-through
    // edge. A plain node has at most one outgoing flow in well-formed BPMN; any
    // extra out-edge (a malformed multi-out task) degrades to a `goto`.
    this.emittedNodes.add(id);
    const stmt = this.renderStatement(el);
    if (stmt !== undefined) lines.push(stmt);
    return this.followLinear(id, stop, lines, depth);
  }

  /**
   * Follow the single fall-through edge out of a plain node. Emits a `goto` for
   * every out-edge that cannot be realized as structured fall-through and
   * returns {@link STOP}; on a clean single fall-through returns the next id.
   */
  private followLinear(
    id: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    const outs = (this.out.get(id) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );
    if (outs.length === 0) return STOP; // terminal (end event / sink)

    if (outs.length === 1) {
      const f = outs[0]!;
      this.consumedFlows.add(f.id);
      if (f.targetRef === stop) return STOP; // reached the region boundary
      if (this.emittedNodes.has(f.targetRef)) {
        // Target already lives elsewhere — jump to it.
        lines.push(`goto ${f.targetRef}`);
        return STOP;
      }
      return f.targetRef; // clean fall-through
    }

    // More than one unconsumed out-edge on a plain node (an unrecognized
    // gateway, or a node with extra cross-edges): the first un-emitted target
    // continues the chain; the rest become gotos.
    let cont: string | typeof STOP = STOP;
    for (const f of outs) {
      this.consumedFlows.add(f.id);
      if (
        cont === STOP &&
        !this.emittedNodes.has(f.targetRef) &&
        f.targetRef !== stop
      ) {
        cont = f.targetRef;
      } else {
        lines.push(`goto ${f.targetRef}`);
      }
    }
    return cont;
  }

  // ── If / else-if / else (and XOR degradation) ───────────────────────────────

  /**
   * Emit an exclusive gateway exhaustively, capturing every one of the
   * gateway's out-edges: an exclusive gateway has no
   * statement form, so its edges must all be realized through an `if` construct
   * (re-synthesizing the gateway on the way back) — they cannot survive the
   * final goto sweep, which relies on a source statement to jump from.
   *
   * - **2+ out-edges:** an `if` / `else if` / `else` chain. Conditioned flows
   *   become `if` / `else if` branches; the single unconditioned flow becomes
   *   the trailing `else`. When the gateway has a clean post-dominating join
   *   (`J` post-dominates `split`, `split` dominates `J`, and every branch
   *   target is the join or split-dominated) the branch bodies are the full
   *   sub-regions up to `J` and the chain continues after `J`. Otherwise the
   *   gateway is **unstructured**: each branch body is a single `goto target`,
   *   preserving every conditioned/default edge without losing any.
   * - **1 out-edge:** a degenerate pass-through gateway — emit nothing and fall
   *   through to its single successor.
   * - **0 out-edges:** a sink — stop.
   */
  private emitExclusiveGateway(
    split: Extract<FlowElement, { kind: 'exclusiveGateway' }>,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(split.id);
    const outs = (this.out.get(split.id) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      // Degenerate single-out gateway: transparent. Follow its one edge.
      const f = outs[0]!;
      this.consumedFlows.add(f.id);
      if (f.targetRef === stop) return STOP;
      if (this.emittedNodes.has(f.targetRef)) {
        lines.push(`goto ${f.targetRef}`);
        return STOP;
      }
      return f.targetRef;
    }

    // Partition: conditioned out-flows are if/else-if branches; the first
    // unconditioned flow is the default → trailing else. Desugared IR has at
    // most one unconditioned flow; hand-built or imported IR may carry more.
    const conditioned = outs.filter((f) => f.conditionExpression !== undefined);
    const unconditioned = outs.filter(
      (f) => f.conditionExpression === undefined,
    );

    // Determine whether this is a clean structured if (a real post-dominating
    // join that the split dominates, with every branch staying in-region).
    const join = this.cleanIfJoin(split.id, outs);

    // Consume every out-edge now — the gateway is fully accounted for.
    for (const f of outs) this.consumedFlows.add(f.id);

    if (conditioned.length === 0) {
      this.emitUnconditionedXorDegradation(unconditioned, join, lines, depth);
    } else {
      this.emitConditionedIfChain(
        conditioned,
        unconditioned,
        join,
        lines,
        depth,
      );
    }

    // Continue the outer chain after the (elided) join, or stop when the
    // gateway was unstructured (every branch jumped away via goto).
    return join !== undefined
      ? this.continueAfterJoin(join, stop, lines)
      : STOP;
  }

  /**
   * Degenerate XOR with **no conditioned flow** (every out-edge unconditioned).
   * A chained `if (true) { } else { } else { }` is NOT valid DSL — an `if` has
   * at most one `else`. In practice a desugared XOR split always carries ≥1
   * conditioned flow, so this path only guards hand-built IR. We degrade it to a
   * valid form: the first out-edge becomes `if (true) { … }`, the second
   * (if any) its single `else { … }`, and every remaining out-edge is preserved
   * as a bare `goto target` after the structure so no edge is lost.
   */
  private emitUnconditionedXorDegradation(
    unconditioned: SequenceFlow[],
    join: string | undefined,
    lines: string[],
    depth: number,
  ): void {
    const [first, second, ...rest] = unconditioned;
    // `first` always exists here (outs.length >= 2 ⇒ unconditioned.length >= 2).
    lines.push('if (true) {');
    this.emitIfBranch(first!.targetRef, join, lines, depth);
    if (second !== undefined) {
      lines.push('} else {');
      this.emitIfBranch(second!.targetRef, join, lines, depth);
    }
    lines.push('}');
    // Extra (3rd+) unconditioned edges have no structured surface form; emit
    // each as a goto so the edge survives the round-trip.
    for (const f of rest) {
      lines.push(`goto ${f.targetRef}`);
    }
  }

  /**
   * Emit the normal conditioned `if` / `else if` chain with an optional trailing
   * `else` from the first unconditioned flow. Conditioned flows become the
   * `if` / `else if` branches; the first unconditioned flow (if any, and not
   * routing straight to the join) becomes the `else` body. Any further
   * unconditioned flow (hand-built/imported IR only — an `if` has at most one
   * `else`) is preserved as a bare `goto` after the structure, the same
   * degradation the all-unconditioned path uses: the edge is re-anchored at
   * the join, the closest form the DSL can express.
   */
  private emitConditionedIfChain(
    conditioned: SequenceFlow[],
    unconditioned: SequenceFlow[],
    join: string | undefined,
    lines: string[],
    depth: number,
  ): void {
    // Emit the conditioned branches as `if` / `else if`.
    conditioned.forEach((f, i) => {
      const keyword = i === 0 ? 'if' : '} else if';
      lines.push(`${keyword} (${renderCondition(f)}) {`);
      this.emitIfBranch(f.targetRef, join, lines, depth);
    });

    // Trailing `else` from the first unconditioned flow (if any).
    const [elseFlow, ...surplus] = unconditioned;
    if (elseFlow === undefined || elseFlow.targetRef === join) {
      // No default, or the default goes straight to the join: no else body.
      lines.push('}');
    } else {
      lines.push('} else {');
      this.emitIfBranch(elseFlow.targetRef, join, lines, depth);
      lines.push('}');
    }

    // Surplus unconditioned edges have no structured surface form; emit each
    // as a goto so the edge survives (mirrors emitUnconditionedXorDegradation).
    for (const f of surplus) {
      if (f.targetRef === join) continue; // duplicate of the implicit fall-through
      lines.push(`goto ${f.targetRef}`);
    }
  }

  /**
   * Compute the clean if-pattern join for `split`, or `undefined` when the
   * gateway is unstructured.
   *
   * The join is the immediate post-dominator `J`; it qualifies iff it is a real
   * node, `J` post-dominates `split`, `split` dominates `J`, and **every**
   * branch target is either `J` itself or strictly dominated by `split` (so the
   * branch region belongs to this gateway and re-enters at `J`). Otherwise the
   * branches cross out of the region and there is no clean join.
   */
  private cleanIfJoin(
    splitId: string,
    outs: SequenceFlow[],
  ): string | undefined {
    const join = this.cfg.immediatePostDominator(splitId);
    if (join === undefined || !this.byId.has(join)) return undefined;
    if (!this.cfg.postDominates(join, splitId)) return undefined;
    if (!this.cfg.dominates(splitId, join)) return undefined;
    for (const f of outs) {
      if (f.targetRef === join) continue;
      if (!this.cfg.dominates(splitId, f.targetRef)) return undefined;
    }
    return join;
  }

  /**
   * Emit one branch body of an `if` construct, indented one level.
   *
   * The per-branch decision (walk vs `goto`) is independent of whether the
   * whole `if` has a clean join, because branches can mix: one may flow back to
   * the join while another `goto`s away (e.g. an `if (a) { goto Done } else
   * { … }` where the then-branch escapes to the process end).
   *
   * - **`join` undefined** (unstructured gateway): the branch is a single
   *   `goto entry`, preserving the gateway's conditioned/default edge.
   * - **`entry === join`**: empty body (the default flows straight to the join).
   * - **`entry` flows back to `join`** (`join` post-dominates `entry` and the
   *   entry is not already emitted): walk the sub-region from `entry` to `join`.
   * - **otherwise** (the branch target escapes the region — it is already
   *   emitted, or does not reach the join): a single `goto entry`, so the edge
   *   to that target is preserved without stealing post-join nodes.
   */
  private emitIfBranch(
    entry: string,
    join: string | undefined,
    lines: string[],
    depth: number,
  ): void {
    const body: string[] = [];
    if (join === undefined) {
      body.push(`goto ${entry}`);
    } else if (entry === join) {
      // Empty branch (default → join): no body.
    } else if (
      !this.emittedNodes.has(entry) &&
      this.cfg.postDominates(join, entry)
    ) {
      this.emitFrom(entry, join, body, depth + 1);
    } else {
      // The branch target escapes the [split, join) region: preserve the edge
      // as a goto rather than walking nodes that belong after the join.
      body.push(`goto ${entry}`);
    }
    for (const l of body) lines.push(INDENT + l);
  }

  /**
   * Emit a branch body bounded by `join`, indented one level (loops/parallel
   * always have a clean in-region body). Walks the sub-region from `entry` up
   * to `join`.
   */
  private emitBranch(
    entry: string,
    join: string,
    lines: string[],
    depth: number,
  ): void {
    const body: string[] = [];
    if (entry !== join) {
      this.emitFrom(entry, join, body, depth + 1);
    }
    for (const l of body) lines.push(INDENT + l);
  }

  // ── While ───────────────────────────────────────────────────────────────────

  /**
   * Recognize and emit a pre-test `while (c) { body }` whose head is the
   * exclusive gateway `loop`. The loop head is reached on fall-through, has a
   * conditioned forward flow into the body, an unconditioned default flow to the
   * exit, and a **back-edge pointing to it** (the body returns to the head).
   * Returns the post-loop continuation id, or `undefined` when no `while`
   * pattern matches (e.g. the gateway is an `if` split, not a loop).
   */
  private tryWhile(
    loop: FlowElement,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP | undefined {
    if (loop.kind !== 'exclusiveGateway') return undefined;

    // The `while` back-edge is the body's *unconditioned* fall-through return
    // into the head; requiring it unconditioned mirrors `tryDoWhileEntry`'s
    // conditioned-back-edge requirement, so the two never both fire.
    const backEdge = this.cfg
      .backEdges()
      .filter((f) => !this.consumedFlows.has(f.id))
      .find(
        (f) => f.targetRef === loop.id && f.conditionExpression === undefined,
      );
    if (backEdge === undefined) return undefined;

    const outs = (this.out.get(loop.id) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );
    const cond = outs.find((f) => f.conditionExpression !== undefined);
    const exit = outs.find((f) => f.conditionExpression === undefined);
    if (cond === undefined) return undefined; // no conditioned body edge

    // Commit: elide the loop gateway, consume its edges + the back-edge.
    this.emittedNodes.add(loop.id);
    this.consumedFlows.add(cond.id);
    this.consumedFlows.add(backEdge.id);
    if (exit !== undefined) this.consumedFlows.add(exit.id);

    lines.push(`while (${renderCondition(cond)}) {`);
    // Body runs from the conditioned target back to the loop head; the back-edge
    // into `loop` is already consumed, so the body walk stops at the head.
    this.emitBranch(cond.targetRef, loop.id, lines, depth);
    lines.push('}');

    return this.continueAfterLoopExit(exit, stop, lines);
  }

  // ── Do-while ─────────────────────────────────────────────────────────────────

  /**
   * Recognize a post-test `do { body } while (c)` *at the body entry node*.
   *
   * In a do-while the body runs before the loop test, so the body entry is the
   * first node reached on fall-through and must be wrapped in a `do { }` block
   * here (before it would otherwise be emitted as a plain statement). The
   * pattern: the loop gateway `L` (an exclusive gateway) has an **outgoing,
   * conditioned back-edge** `L → node` (the conditioned re-entry into the body)
   * and an unconditioned exit edge; `node` dominates `L` (every path to `L`
   * enters through the body).
   *
   * The back-edge being **conditioned** is the distinguisher from a pre-test
   * `while`: a `while` head also sits inside a back-edge (`bodyExit → head`),
   * but that return edge is *unconditioned* and the head is its *target*, not
   * its source. Requiring the back-edge to leave `L` carrying the condition
   * keeps `tryDoWhileEntry` from firing on a `while` head that contains nested
   * structure (whose inner join → head back-edge is unconditioned).
   *
   * @param node The candidate body-entry node id (reached on fall-through).
   * @returns The post-loop continuation id when a do-while is emitted, else
   *          `undefined` (the caller emits `node` as a plain statement).
   */
  private tryDoWhileEntry(
    node: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP | undefined {
    // Find a *conditioned* back-edge whose target is `node` and whose source is
    // an exclusive gateway loop head dominated by `node` (the post-test gateway).
    const backEdge = this.cfg
      .backEdges()
      .filter((f) => !this.consumedFlows.has(f.id))
      .find((f) => {
        if (f.targetRef !== node) return false;
        if (f.conditionExpression === undefined) return false;
        const head = this.byId.get(f.sourceRef);
        return (
          head?.kind === 'exclusiveGateway' &&
          this.cfg.dominates(node, f.sourceRef)
        );
      });
    if (backEdge === undefined) return undefined;

    const loopId = backEdge.sourceRef;
    const outs = (this.out.get(loopId) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );
    // The back-edge carries the loop condition; the other out-edge is the exit.
    const cond = backEdge;
    const exit = outs.find(
      (f) => f.id !== backEdge.id && f.conditionExpression === undefined,
    );

    // Commit: elide the loop gateway, consume its edges.
    this.emittedNodes.add(loopId);
    this.consumedFlows.add(cond.id);
    if (exit !== undefined) this.consumedFlows.add(exit.id);

    lines.push('do {');
    // Body runs from the entry node up to the loop gateway (its only real
    // successor inside the loop). The walk stops at `loopId`, which is elided.
    this.emitBranch(node, loopId, lines, depth);
    lines.push(`} while (${renderCondition(cond)})`);

    return this.continueAfterLoopExit(exit, stop, lines);
  }

  /**
   * Continue the chain after a loop's unconditioned exit edge. Mirrors
   * `followLinear`: stop at the region boundary, jump to an already-emitted
   * target, or fall through to a fresh node.
   */
  private continueAfterLoopExit(
    exit: SequenceFlow | undefined,
    stop: string | undefined,
    lines: string[],
  ): string | typeof STOP {
    if (exit === undefined) return STOP;
    if (exit.targetRef === stop) return STOP;
    if (this.emittedNodes.has(exit.targetRef)) {
      lines.push(`goto ${exit.targetRef}`);
      return STOP;
    }
    return exit.targetRef;
  }

  // ── Parallel (and AND degradation) ──────────────────────────────────────────

  /**
   * Emit a parallel gateway exhaustively (as for exclusive gateways:
   * a parallel gateway has no statement form, so every out-edge must be
   * captured by a construct or a goto, never the final sweep).
   *
   * - **Clean fork** (2+ out-edges, parallel-gateway post-dominating join that
   *   the fork dominates): `parallel { { } { } }`; both gateways elided.
   * - **Unstructured fork** (no clean parallel join): degrade to one `goto` per
   *   out-edge, preserving every fork edge.
   * - **1 out-edge** (a join arriving here, or a degenerate fork): transparent
   *   pass-through.
   * - **0 out-edges:** sink — stop.
   */
  private emitParallelGateway(
    fork: Extract<FlowElement, { kind: 'parallelGateway' }>,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(fork.id);
    const outs = (this.out.get(fork.id) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      // A join gateway reached on fall-through, or a degenerate fork: transparent.
      const f = outs[0]!;
      this.consumedFlows.add(f.id);
      if (f.targetRef === stop) return STOP;
      if (this.emittedNodes.has(f.targetRef)) {
        lines.push(`goto ${f.targetRef}`);
        return STOP;
      }
      return f.targetRef;
    }

    const join = this.cleanParallelJoin(fork.id, outs);

    // Consume every fork out-edge now — the fork is fully accounted for.
    for (const f of outs) this.consumedFlows.add(f.id);

    if (join === undefined) {
      // Unstructured AND split: preserve every edge as a goto.
      for (const f of outs) lines.push(`goto ${f.targetRef}`);
      return STOP;
    }

    // Clean fork/join. Emit each branch up to the join. The branch→join edges
    // are consumed by the bounded branch walks (they stop *at* the join); the
    // join itself is then continued *from* (a 1-out parallel join is a
    // transparent pass-through in `emitNode`, reproducing the desugarer's
    // elision), so it is neither pre-elided nor double-consumed here.
    lines.push('parallel {');
    outs.forEach((f) => {
      // Each branch is its own brace block nested inside `parallel { … }`.
      // `emitBranch` already prefixes one INDENT to the branch body; wrap it in
      // `{ … }` (at one INDENT) and re-indent the body by a further INDENT so it
      // sits two levels below `parallel {`.
      const branchLines: string[] = [];
      this.emitBranch(f.targetRef, join, branchLines, depth);
      lines.push(INDENT + '{');
      for (const l of branchLines) lines.push(INDENT + l);
      lines.push(INDENT + '}');
    });
    lines.push('}');

    return this.continueAfterJoin(join, stop, lines);
  }

  /**
   * Compute the clean AND fork/join for `fork`, or `undefined` when the fork is
   * unstructured. The join is the immediate post-dominator and must be a real
   * **parallel** gateway that post-dominates the fork, that the fork dominates,
   * and every branch target must be the join or fork-dominated.
   */
  private cleanParallelJoin(
    forkId: string,
    outs: SequenceFlow[],
  ): string | undefined {
    const join = this.cfg.immediatePostDominator(forkId);
    if (join === undefined || !this.byId.has(join)) return undefined;
    if (this.byId.get(join)?.kind !== 'parallelGateway') return undefined;
    if (!this.cfg.postDominates(join, forkId)) return undefined;
    if (!this.cfg.dominates(forkId, join)) return undefined;
    for (const f of outs) {
      if (f.targetRef === join) continue;
      if (!this.cfg.dominates(forkId, f.targetRef)) return undefined;
    }
    return join;
  }

  // ── Shared continuation / fallback helpers ──────────────────────────────────

  /**
   * Continue the outer chain *from* the merge node `join` after an `if` /
   * `parallel` construct's branches have been emitted.
   *
   * The merge node is **not** elided here. Returning it as the next node lets
   * the main walk emit it on the next step:
   *   - A synthesized join gateway (`Gateway_<X>_join`) has exactly one
   *     remaining out-edge once the branch→join edges are consumed, so
   *     `emitNode` treats it as a transparent pass-through and prints nothing —
   *     reproducing the desugarer's elision exactly.
   *   - A **real** node that happens to be the post-dominating merge point (a
   *     task two branches both flow into) is emitted as its normal statement, so
   *     no node is dropped.
   *
   * Returns {@link STOP} only when the merge coincides with the region boundary
   * `stop` or has already been emitted (a back-merge), in which case a `goto`
   * realizes the arrival.
   */
  private continueAfterJoin(
    join: string,
    stop: string | undefined,
    lines: string[],
  ): string | typeof STOP {
    if (join === stop) return STOP;
    if (this.emittedNodes.has(join)) {
      lines.push(`goto ${join}`);
      return STOP;
    }
    return join;
  }

  // ── Statement rendering ─────────────────────────────────────────────────────

  /**
   * Render a flow element as its statement line, or `undefined` when the
   * element has no statement form (the gateways, which only exist as
   * desugared structure and are elided when recognized — an unrecognized
   * gateway prints nothing and its edges become gotos).
   */
  private renderStatement(el: FlowElement): string | undefined {
    switch (el.kind) {
      case 'startEvent':
        return `start ${el.id}${labelSuffix(el.name)}`;
      case 'endEvent':
        return `end ${el.id}${labelSuffix(el.name)}`;
      case 'userTask':
        return renderUserTask(el);
      case 'serviceTask':
        return renderServiceTask(el);
      case 'exclusiveGateway':
      case 'parallelGateway':
        // No statement form. An unrecognized gateway emits nothing; its
        // edges are flushed as gotos by `followLinear` / the final sweep.
        return undefined;
      default: {
        const exhaustive: never = el;
        throw new Error(
          `irToDsl: unhandled FlowElement kind: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }
}

/** Sentinel returned by node emission to mean "the chain ends here". */
const STOP = Symbol('stop');

/**
 * Hard cap on block-nesting depth. Well-formed graphs nest far below this
 * (each construct consumes nodes, and `emittedNodes` prevents re-entry); a
 * pathological IR is degraded to a `goto` rather than overflowing the stack.
 */
const MAX_NESTING_DEPTH = 1000;

// ---------------------------------------------------------------------------
// Pure rendering helpers
// ---------------------------------------------------------------------------

/** Build the `process <id> "<label>"? {` opening line. */
function buildProcessHeader(process: BpmnProcess): string {
  if (process.name !== undefined) {
    return `process ${process.id} ${quote(process.name)} {`;
  }
  return `process ${process.id} {`;
}

/** Render a `user <id> "<label>"? { … }` statement with its attribute block. */
function renderUserTask(
  el: Extract<FlowElement, { kind: 'userTask' }>,
): string {
  const attrs: string[] = [];
  if (el.assignee !== undefined) attrs.push(`assignee = ${quote(el.assignee)}`);
  if (el.formKey !== undefined) attrs.push(`formKey = ${quote(el.formKey)}`);
  return `user ${el.id}${labelSuffix(el.name)}${attrBlock(attrs)}`;
}

/** Render a `service <id> "<label>"? { class = "…" }` statement. */
function renderServiceTask(
  el: Extract<FlowElement, { kind: 'serviceTask' }>,
): string {
  const attrs = [`class = ${quote(el.javaClass)}`];
  return `service ${el.id}${labelSuffix(el.name)}${attrBlock(attrs)}`;
}

/** ` "<label>"` suffix, or empty when no label. */
function labelSuffix(name: string | undefined): string {
  return name !== undefined ? ` ${quote(name)}` : '';
}

/**
 * Render an inline attribute block ` { a = "x" b = "y" }`, or empty when there
 * are no attributes. The block stays on one line — the grammar's `(a | b)*`
 * accepts whitespace-separated attributes.
 */
function attrBlock(attrs: string[]): string {
  if (attrs.length === 0) return '';
  return ` { ${attrs.join(' ')} }`;
}

/**
 * Recover a flow's condition as DSL surface text. The IR carries the raw `${…}`
 * body; {@link parseJuel} decides whether it fits the JUEL subset (→ bare
 * unquoted DSL) or must fall back to the quoted `"${…}"` raw form
 * ({@link renderRawFallback}).
 */
function renderCondition(flow: SequenceFlow): string {
  const body = flow.conditionExpression ?? '';
  return renderRawFallback(parseJuel(body));
}

/**
 * Wrap a string value in double-quotes, backslash-escaping inner double-quotes
 * and backslashes to match the grammar's STRING terminal.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
