/**
 * Restructuring IR → DSL emitter.
 *
 * The inverse of the desugaring `astToIr`: it turns the **flat,
 * BPMN-shaped** {@link BpmnProcess} IR back into **structured** source —
 * `if`/`else if`/`else`, `while`, `do … while`, `parallel { { } { } }`,
 * `subprocess { … }`, explicit `start`/`end`, and `goto` — that re-parses
 * through the grammar and re-desugars to an equivalent IR.
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
 * Every well-formed IR input produces parseable source; unstructurable regions
 * degrade to `goto`. Each flow node is emitted exactly once (at its natural
 * position, labelled by its id, which is always a valid jump target per the
 * grammar). Edges are tracked in a consumed-set, and whatever is left after
 * structured emission is flushed as `goto`s.
 *
 * Parseable is not the same as clean. A surplus jump ends the chain it sits in
 * (see below), so the statements after it are left with no incoming flow and
 * the output can fail the validator's unreachable-statement check even though
 * it parses.
 *
 * Two edges resist that flush, and both are dropped with
 * {@link UNSTRUCTURED_MARKER} printed in their place naming where the edge
 * led. The CLI reports the marker as a warning.
 *
 * The first is an edge arriving at a gateway that still chooses between
 * branches. A `goto` names a statement and a gateway has no statement form, so
 * such an edge is expressible only through the gateway's successor, which
 * works while the routing has one outcome and stops working once it has two.
 * Valid BPMN reaches this: a loop whose condition sits on the back-edge rather
 * than on the forward edge into the body matches no loop pattern, so its head
 * gateway is emitted as an `if` and the back-edge has nothing left to name.
 * Approximations exist for that shape, but each moves the condition onto a
 * synthesized gateway and changes when it is evaluated, so the emitter reports
 * the loss instead of shipping a model that reads right and runs differently.
 *
 * The second is a surplus out-edge: a statement carries one fall-through, so a
 * node's second out-edge has no position to be written at
 * ({@link Emitter.pushSurplusEdge}).
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

import type {
  BpmnProcess,
  CallVariableMapping,
  EventDefinition,
  FlowContainer,
  FlowElement,
  FormField,
  FormFieldType,
  SequenceFlow,
} from './ir/types.js';
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

  // Declared thrown-message texts print as `error … message …` declarations
  // between the process header and the body, in declaration order — the
  // grammar's process-declaration position.
  const declarations = (process.errorMessages ?? []).map(
    (m) => `${INDENT}error ${quote(m.code)} message ${quote(m.message)}`,
  );

  const header = buildProcessHeader(process);
  const lines = [header, ...declarations, ...body.map((l) => INDENT + l), '}'];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * Stateful restructuring pass over one {@link FlowContainer}. Holds the CFG
 * analysis, the element/flow lookup tables, and the "consumed" bookkeeping
 * (which nodes have been emitted, which edges have been realized as structured
 * flow) that the `goto` fallback relies on.
 *
 * ## One Emitter per container
 * The Emitter operates on a single container's own `flowElements` /
 * `sequenceFlows`. A sub-process's body lives in the child container's arrays,
 * so the parent's CFG never sees inside it: the parent treats the sub-process
 * as one opaque activity node (incoming flow lands on it, fall-through leaves
 * it), and a fresh Emitter over the child container restructures the body
 * independently. This keeps the dominator-based restructuring correct across
 * the boundary — cross-container edges cannot exist, so no region ever spans
 * two containers.
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

  constructor(private readonly container: FlowContainer) {
    this.cfg = analyzeCfg(container);
    for (const el of container.flowElements) {
      // Duplicate element ids would silently overwrite the lookup table and
      // corrupt the structured walk. The desugarer guarantees unique
      // ids via collision resolution, so a duplicate here means malformed IR —
      // fail loudly rather than emit a wrong process.
      if (this.byId.has(el.id)) {
        throw new Error(
          `irToDsl: duplicate flow element id '${el.id}' in container '${container.id}'.`,
        );
      }
      this.byId.set(el.id, el);
    }
    for (const f of container.sequenceFlows) {
      const list = this.out.get(f.sourceRef) ?? [];
      list.push(f);
      this.out.set(f.sourceRef, list);
    }
  }

  /**
   * Emit the whole process body as a list of (un-indented) statement lines, in
   * five passes:
   *
   *   1. **Structured emission from each start event** — a start event roots the
   *      main reachable region, which the recursive walk prints in its
   *      structured form.
   *   2. **Boundary handlers** — each `boundaryEvent` with its escape chain, as
   *      an `on <host>: <trigger> { … }` block. A boundary event has outgoing
   *      but no incoming flow, so its chain is never reached from a start event;
   *      it needs a pass of its own. The *walk* has to run here, before the
   *      orphan sweep, or the orphan sweep would find every escape-chain node
   *      unemitted and print it as a detached top-level chain with no header and
   *      no host; running it after pass 1 (rather than before) is what makes a
   *      chain rejoining the main flow degrade to a `goto`, since the main-flow
   *      nodes are already in `emittedNodes` and the arrival is realized as a
   *      jump rather than printing the node a second time. Its *lines*, though,
   *      are held back and appended with the trailing handler group: a handler
   *      block reads as a catch block and must follow the last step of the body
   *      it guards, so nothing from passes 3 and 4 may print after it.
   *   3. **Orphaned fragments** — any node still unemitted (an unreachable
   *      fragment in a hand-built / irreducible IR) becomes its own little
   *      chain, so no node is lost. Handlers and boundary events are skipped:
   *      both have their own pass.
   *   4. **Goto sweep** — every flow edge not realized structurally is flushed
   *      as an explicit `goto` from its (already-emitted) source. Placed at the
   *      end of the flow body, since a `goto` may appear anywhere and names its
   *      target by id.
   *   5. **Handler group** — the boundary blocks walked in pass 2, then the
   *      host-less `on` handlers, which are not flow at all (no incoming and no
   *      outgoing edges). The surface requires handlers at the end of the body
   *      (the catch-block reading), so the whole group prints last.
   */
  emit(): string[] {
    const lines: string[] = [];

    // 1. Structured emission from each start event, in IR order.
    for (const el of this.container.flowElements) {
      if (el.kind === 'startEvent' && !this.emittedNodes.has(el.id)) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }

    // 2. Boundary handlers and their escape chains, walked here but held back
    //    for the trailing handler group. A boundary event is only ever already
    //    emitted here if a malformed IR wired a flow edge into it, in which case
    //    pass 1 printed it at its (wrong but harmless) arrival point.
    const boundaryLines: string[] = [];
    for (const el of this.container.flowElements) {
      if (isBoundary(el) && !this.emittedNodes.has(el.id)) {
        this.emitBoundaryHandler(el, boundaryLines, 0);
      }
    }

    // 3. Orphaned fragments.
    for (const el of this.container.flowElements) {
      if (isHandler(el) || isBoundary(el)) continue;
      if (!this.emittedNodes.has(el.id)) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }

    // 4. Final goto sweep.
    for (const f of this.container.sequenceFlows) {
      if (!this.consumedFlows.has(f.id)) {
        this.consumedFlows.add(f.id);
        this.pushGoto(f.targetRef, lines);
      }
    }

    // 5. Trailing handler group: the boundary blocks from pass 2, then the
    //    event sub-processes.
    for (const l of boundaryLines) lines.push(l);
    for (const el of this.container.flowElements) {
      if (isHandler(el) && !this.emittedNodes.has(el.id)) {
        this.emitHandler(el, lines);
      }
    }

    return lines;
  }

  /**
   * Emit one `on` handler: its header (recovered from the trigger start event)
   * then its body, restructured by a fresh {@link Emitter} and indented one
   * level, then the closing brace. A handler carries no flow edges, so there is
   * no fall-through continuation.
   */
  private emitHandler(
    handler: Extract<FlowElement, { kind: 'subProcess' }>,
    lines: string[],
  ): void {
    this.emittedNodes.add(handler.id);
    lines.push(buildOnHeader(handler));
    for (const l of new Emitter(handler).emit()) lines.push(INDENT + l);
    lines.push('}');
  }

  /**
   * Emit one boundary handler: the `on <host>: <trigger> … {` header, then its
   * escape chain restructured and indented one level, then the closing brace.
   *
   * Unlike an event sub-process, a boundary event's body is **not** a separate
   * container — the escape chain's nodes and edges live in this container's own
   * arrays. So the chain is walked by *this* Emitter, sharing its
   * `emittedNodes` / `consumedFlows` state with the main flow: a chain that
   * rejoins the main flow reaches an already-emitted node and degrades to a
   * `goto` through the ordinary machinery, and the rejoined node is still
   * printed exactly once, at its main-flow position.
   *
   * The chain starts with `followLinear` on the boundary event itself, which
   * applies the plain-node out-edge rule: no out-edge is an empty body (a
   * boundary event that catches and stops), one out-edge continues the chain,
   * and any further out-edge on a malformed IR becomes a `goto` inside the
   * body rather than being dropped.
   *
   * `depth` is the caller's block-nesting depth, so a chain reached through a
   * flow edge into the boundary event keeps spending the same
   * {@link MAX_NESTING_DEPTH} budget instead of restarting it.
   */
  private emitBoundaryHandler(
    boundary: Extract<FlowElement, { kind: 'boundaryEvent' }>,
    lines: string[],
    depth: number,
  ): void {
    this.emittedNodes.add(boundary.id);
    lines.push(buildBoundaryHeader(boundary));
    const body: string[] = [];
    const next = this.followLinear(boundary.id, undefined, body, depth);
    if (next !== STOP) this.emitFrom(next, undefined, body, depth);
    for (const l of body) lines.push(INDENT + l);
    lines.push('}');
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
      if (node !== undefined) this.pushGoto(node, lines);
      return;
    }
    let current = node;
    // The chain length is bounded by the node count; the guard is belt-and-
    // braces against a malformed IR producing an unexpected cycle.
    let guard = this.byId.size + 1;
    while (current !== undefined && current !== stop && guard-- > 0) {
      if (this.emittedNodes.has(current)) {
        // Already emitted elsewhere — realize the arrival as a goto and stop.
        this.pushGoto(current, lines);
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

    // A script task's fenced body is opaque, multi-line text reproduced
    // byte-for-byte. It cannot be a single indented statement line — its body
    // must not be re-indented as DSL — so it is emitted here as its own line
    // group: the opening fence (a normal DSL line the caller indents) followed
    // by the verbatim body and closing fence. Otherwise it walks like any plain
    // fall-through node.
    if (el.kind === 'scriptTask') {
      this.emittedNodes.add(id);
      lines.push(renderScriptTask(el));
      return this.followLinear(id, stop, lines, depth);
    }

    // A sub-process is an opaque activity in this container's graph: its body
    // lives in the child container's own arrays, invisible to this Emitter's
    // CFG. Emit it as a `subprocess <id> { … }` line group — the opening line
    // (a normal DSL line the caller indents), the child container's body
    // restructured by a fresh Emitter and indented one level, then the closing
    // brace — and continue the parent chain from its single fall-through edge.
    if (el.kind === 'subProcess') {
      // An event sub-process (`on` handler) is not flow: it prints in the
      // trailing handler pass, never on the fall-through walk. Should a
      // malformed IR wire a flow edge into one, print it as a handler here and
      // stop — it has no continuation.
      if (el.triggeredByEvent === true) {
        this.emitHandler(el, lines);
        return STOP;
      }
      this.emittedNodes.add(id);
      lines.push(`subprocess ${id}${labelSuffix(el.name)} {`);
      for (const l of new Emitter(el).emit()) lines.push(INDENT + l);
      lines.push('}');
      return this.followLinear(id, stop, lines, depth);
    }

    // A boundary event is not reached by flow either: it prints in the boundary
    // handler pass. Should a malformed IR wire a flow edge into one, print its
    // handler block here and stop — it has no single-line statement form, so
    // falling through to the plain-node case would emit nothing and the element
    // would vanish from the output.
    if (isBoundary(el)) {
      this.emitBoundaryHandler(el, lines, depth);
      return STOP;
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
        this.pushGoto(f.targetRef, lines);
        return STOP;
      }
      return f.targetRef; // clean fall-through
    }

    // More than one unconsumed out-edge on a plain node (an unrecognized
    // gateway, or a node with extra cross-edges). A statement has room for
    // exactly one fall-through, so the first un-emitted target continues the
    // chain and every other edge is surplus. A surplus jump that does get
    // written still cuts the fall-through off, which is why the choice between
    // writing it and dropping it is made per edge in `pushSurplusEdge`.
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
        this.pushSurplusEdge(f.targetRef, lines);
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
        this.pushGoto(f.targetRef, lines);
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
    // join that the split dominates, with every branch staying in-region), or —
    // when there is none — a guard clause whose sole default edge is the
    // continuation. Either way `join` is the node the main flow resumes from.
    const join =
      this.cleanIfJoin(split.id, outs) ?? this.guardClauseContinuation(outs);

    // Consume every out-edge now — the gateway is fully accounted for.
    for (const f of outs) this.consumedFlows.add(f.id);

    if (conditioned.length === 0) {
      this.emitUnconditionedXorDegradation(
        unconditioned,
        join,
        split.id,
        lines,
        depth,
      );
    } else {
      this.emitConditionedIfChain(
        conditioned,
        unconditioned,
        join,
        split.id,
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
    splitId: string,
    lines: string[],
    depth: number,
  ): void {
    const [first, second, ...rest] = unconditioned;
    // `first` always exists here (outs.length >= 2 ⇒ unconditioned.length >= 2).
    lines.push('if (true) {');
    this.emitIfBranch(first!.targetRef, join, splitId, lines, depth);
    if (second !== undefined) {
      lines.push('} else {');
      this.emitIfBranch(second!.targetRef, join, splitId, lines, depth);
    }
    lines.push('}');
    // Extra (3rd+) unconditioned edges have no structured surface form, and no
    // position either: the chain continues from the join after this construct,
    // so a jump written here would cut that continuation off.
    for (const f of rest) {
      this.pushSurplusEdge(f.targetRef, lines);
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
    splitId: string,
    lines: string[],
    depth: number,
  ): void {
    // Emit the conditioned branches as `if` / `else if`.
    conditioned.forEach((f, i) => {
      const keyword = i === 0 ? 'if' : '} else if';
      lines.push(`${keyword} (${renderCondition(f)}) {`);
      this.emitIfBranch(f.targetRef, join, splitId, lines, depth);
    });

    // Trailing `else` from the first unconditioned flow (if any).
    const [elseFlow, ...surplus] = unconditioned;
    if (elseFlow === undefined || elseFlow.targetRef === join) {
      // No default, or the default goes straight to the join: no else body.
      lines.push('}');
    } else {
      lines.push('} else {');
      this.emitIfBranch(elseFlow.targetRef, join, splitId, lines, depth);
      lines.push('}');
    }

    // Surplus unconditioned edges have no structured surface form and no
    // position (mirrors emitUnconditionedXorDegradation): the chain resumes
    // from the join below, which a jump written here would cut off.
    for (const f of surplus) {
      if (f.targetRef === join) continue; // duplicate of the implicit fall-through
      this.pushSurplusEdge(f.targetRef, lines);
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
   * Fallback "join" for a guard-clause split that has no clean post-dominating
   * join — one conditioned branch terminates (a `throw`/`end`/`goto`) while the
   * else-less default continues the main flow. When the split has exactly one
   * unconditioned (default) out-edge, its target is the continuation: routing
   * it through the structured path consumes the default as the flow that
   * resumes after the `if` (instead of degrading it to a bare `goto` at the
   * split), so the continuation prints at the correct scope. Returns
   * `undefined` when there is no single default edge (a genuinely unstructured
   * web), leaving the caller on the unstructured-degradation path.
   */
  private guardClauseContinuation(outs: SequenceFlow[]): string | undefined {
    const unconditioned = outs.filter(
      (f) => f.conditionExpression === undefined,
    );
    return unconditioned.length === 1 ? unconditioned[0]!.targetRef : undefined;
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
   * - **`entry` stays inside the branch region** (see
   *   {@link branchStaysInRegion}): walk the sub-region from `entry`, bounded by
   *   `join`. This covers a branch that flows back to the join *and* a
   *   guard-clause branch owned by the split that terminates before it
   *   (`throw`/`end`/`goto`), which is emitted inline rather than as a jump to
   *   its (often synthesized, unnameable) terminal node.
   * - **otherwise** (the branch target escapes the region — already emitted, or
   *   a post-join node): a single `goto entry`, so the edge is preserved without
   *   stealing post-join nodes.
   */
  private emitIfBranch(
    entry: string,
    join: string | undefined,
    splitId: string,
    lines: string[],
    depth: number,
  ): void {
    const body: string[] = [];
    if (join === undefined) {
      this.pushGoto(entry, body);
    } else if (entry === join) {
      // Empty branch (default → join): no body.
    } else if (
      !this.emittedNodes.has(entry) &&
      this.branchStaysInRegion(entry, join, splitId)
    ) {
      this.emitFrom(entry, join, body, depth + 1);
    } else {
      // The branch target escapes the [split, join) region: preserve the edge
      // as a goto rather than walking nodes that belong after the join.
      this.pushGoto(entry, body);
    }
    for (const l of body) lines.push(INDENT + l);
  }

  /**
   * Whether a branch entry belongs inside the `[split, join)` region and so may
   * be walked inline (bounded by `join`) rather than jumped to.
   *
   * Two shapes qualify:
   *   - the branch flows back into the join (`join` post-dominates `entry`) — an
   *     ordinary branch body that re-merges; and
   *   - the branch is a guard clause whose entry is a **synthesized terminal**
   *     owned by the split (`split` dominates `entry`, `join` does not) that
   *     terminates before the join. A synthesized terminal has no nameable
   *     surface (its id is dropped on print), so a `goto` to it would not
   *     resolve; the terminal is reached only through this split and never
   *     through the join, so the `join`-bounded walk emits it inline and stops
   *     without reaching any post-join statement. A branch whose entry *is*
   *     nameable (an authored throw/emit, a named node) stays a `goto` — that
   *     resolves, and keeps the target's own chain at its authored scope so its
   *     coordinate-derived id survives the round-trip.
   */
  private branchStaysInRegion(
    entry: string,
    join: string,
    splitId: string,
  ): boolean {
    if (this.cfg.postDominates(join, entry)) return true;
    return (
      isSynthesizedTerminalId(entry) &&
      this.cfg.dominates(splitId, entry) &&
      !this.cfg.dominates(join, entry)
    );
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
      this.pushGoto(exit.targetRef, lines);
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
   * - **Recovered fork** (no clean post-dominating join because ≥1 branch
   *   TERMINATES with a `throw`/`end` before reaching the join): still
   *   `parallel { { } { } }`, with each branch emitted inline — a terminating
   *   branch ends in place with its `throw`/`end`, a surviving branch flows to
   *   the join — and the continuation resumes after the join the survivors
   *   share ({@link recoveredParallelJoin}).
   * - **Unstructured fork** (no coherent join even after recovery): degrade to
   *   one guarded `goto` per out-edge, preserving every fork edge.
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
        this.pushGoto(f.targetRef, lines);
        return STOP;
      }
      return f.targetRef;
    }

    // The continuation join is the clean post-dominating parallel join when
    // every branch reaches it, or — when one or more branches terminate before
    // it — the join the surviving branches still share. Either way `join` is the
    // node the main flow resumes from after the fork.
    const join =
      this.cleanParallelJoin(fork.id, outs) ??
      this.recoveredParallelJoin(fork.id, outs);

    // Consume every fork out-edge now — the fork is fully accounted for.
    for (const f of outs) this.consumedFlows.add(f.id);

    if (join === undefined) {
      // Unstructured AND split (no coherent join even after recovery): preserve
      // every edge as a guarded goto.
      for (const f of outs) this.pushGoto(f.targetRef, lines);
      return STOP;
    }

    // Clean or recovered fork/join. Emit each branch bounded by the join: a
    // surviving branch stops *at* the join, a terminating branch ends inline
    // with its `throw`/`end`. The branch→join edges are consumed by the bounded
    // branch walks; the join itself is then continued *from* (a 1-out parallel
    // join is a transparent pass-through in `emitNode`, reproducing the
    // desugarer's elision), so it is neither pre-elided nor double-consumed here.
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

  /**
   * Recover the continuation join of a parallel fork whose immediate
   * post-dominator is not a clean join because one or more branches
   * **terminate** — a `throw`/`end` sink with no outgoing flow — and so never
   * reach the join. The surviving (non-terminating) branches still reconverge
   * at the fork's real `parallelGateway` join; this finds it as the nearest
   * `parallelGateway` that post-dominates **every** surviving branch — their
   * common continuation.
   *
   * For each branch it collects, nearest-first, the fork-dominated
   * `parallelGateway`s on that branch's post-dominator chain. A terminating
   * branch walks straight into the virtual exit and yields an empty chain, so it
   * contributes no candidate and is dropped. The answer is the first candidate
   * common to all surviving chains: parallel branches share no node before they
   * reconverge, so a gateway on every survivor's chain is their real shared
   * join, and taking the nearest keeps the continuation at the outer fork
   * instead of drifting it into a sibling's nested `parallel`. Returns
   * `undefined` when no branch survives, or when the survivors share no common
   * join (a genuinely irreducible fork the caller degrades to guarded gotos).
   *
   * This is the AND-fork analog of {@link guardClauseContinuation}: where the
   * guard clause recovers the sole surviving default edge of an XOR split, this
   * recovers the surviving branches' shared join of an AND split. The
   * `cur !== forkId` guard rejects a back-edge fork (`B → fork`) whose immediate
   * post-dominator is the fork itself — that has no real join to resume from and
   * must stay on the degrade path.
   */
  private recoveredParallelJoin(
    forkId: string,
    outs: SequenceFlow[],
  ): string | undefined {
    const survivorChains: string[][] = [];
    for (const f of outs) {
      const chain: string[] = [];
      let cur = this.cfg.immediatePostDominator(f.targetRef);
      const seen = new Set<string>();
      while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur);
        if (
          cur !== forkId &&
          this.byId.get(cur)?.kind === 'parallelGateway' &&
          this.cfg.dominates(forkId, cur)
        ) {
          chain.push(cur);
        }
        cur = this.cfg.immediatePostDominator(cur);
      }
      if (chain.length > 0) survivorChains.push(chain);
    }
    if (survivorChains.length === 0) return undefined;

    const [first, ...rest] = survivorChains;
    for (const cand of first!) {
      if (rest.every((chain) => chain.includes(cand))) return cand;
    }
    return undefined;
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
      this.pushGoto(join, lines);
      return STOP;
    }
    return join;
  }

  /**
   * Emit a `goto` to `target`, the single guarded jump-emission site every
   * other site routes through so the invariant "a `goto` never names a gateway"
   * holds in one place. A gateway has no statement form, so it can never be a
   * `goto` target; {@link forwardToRealTarget} follows the gateway chain to the
   * first node that does have one and names that instead.
   *
   * A jump into a gateway that still has a choice to make cannot be named at
   * all: nothing in the surface stands for the gateway, and there is no single
   * successor to name in its place. That edge is dropped, and the marker names
   * the element it led into so the reader can find the spot rather than hunt
   * for it.
   */
  private pushGoto(target: string, lines: string[]): void {
    const real = this.forwardToRealTarget(target, new Set());
    lines.push(real !== undefined ? `goto ${real}` : droppedEdgeMarker(target));
  }

  /**
   * Emit a surplus out-edge: a second or later edge leaving a position that
   * already carries a fall-through.
   *
   * A `goto` written here ends the enclosing chain when re-desugared, so it
   * costs the fall-through the position was going to express, and whatever
   * followed is then left unreachable. The jump is written anyway when it is
   * the only thing keeping its target attached, since an orphaned node is the
   * worse outcome; source that trips the unreachable-statement check is the
   * known price of that trade, and it is why the resolution below runs without
   * the consumed-edge fallback {@link forwardToRealTarget} applies elsewhere.
   * When the target is already reachable through routes the walk has printed,
   * the jump buys nothing and would cost the continuation for free, so the
   * edge is dropped and marked instead.
   *
   * Moving the jump after the chain is not an escape: it re-anchors on
   * whatever statement ends up last, which is a different edge, and lands
   * after a trailing `end` where it can never run either. Placing surplus
   * jumps properly needs a mechanism this emitter does not have.
   */
  private pushSurplusEdge(target: string, lines: string[]): void {
    const real = this.forwardToRealTarget(target, new Set(), false);
    lines.push(real !== undefined ? `goto ${real}` : droppedEdgeMarker(target));
  }

  /**
   * Follow pass-through gateways from `target` to the first node with a
   * statement form, which is the only kind of node a `goto` can name.
   *
   * A jump into a gateway re-runs that gateway's routing, so it means the same
   * thing as a jump at the successor whenever the routing has just one
   * outcome. Two cases qualify. The walk forwards across the single out-edge
   * the structured emission has not realized yet, and — once emission has
   * realized every out-edge — across the sole out-edge of a gateway that never
   * had a choice to make. The second case matters because consumption records
   * that an edge was already printed as structured flow, not that the edge
   * stopped existing: a back-edge arriving at a pass-through join still routes
   * to that join's one successor.
   *
   * Returns `undefined` when the routing has more than one outcome, when the
   * chain revisits a gateway (a cyclic gateway chain reaches no real node),
   * and when it lands on a node the emitter drops on print — a `goto` naming
   * one of those parses but never resolves, which is worse than the marker
   * because the damage only surfaces at link time. An unknown id is named
   * verbatim: it is a dangling reference in the IR rather than an elision.
   */
  private forwardToRealTarget(
    target: string,
    seen: Set<string>,
    acrossConsumed = true,
  ): string | undefined {
    const el = this.byId.get(target);
    // An unknown id is named verbatim: that is a dangling reference in the IR,
    // not a node the emitter chose to drop.
    if (el === undefined) return target;
    if (el.kind !== 'exclusiveGateway' && el.kind !== 'parallelGateway') {
      return isElidedOnPrint(el) ? undefined : target;
    }
    if (seen.has(target)) return undefined;
    seen.add(target);
    const outs = this.out.get(target) ?? [];
    const unconsumed = outs.filter((f) => !this.consumedFlows.has(f.id));
    let forward: SequenceFlow | undefined;
    if (unconsumed.length === 1) forward = unconsumed[0];
    else if (acrossConsumed && outs.length === 1) forward = outs[0];
    if (forward === undefined) return undefined;
    return this.forwardToRealTarget(forward.targetRef, seen, acrossConsumed);
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
        // A start event prints as a plain `start` statement. Any event
        // definition it carries surfaces only through its enclosing `on`
        // handler's header, never here — a definition-carrying start in a
        // normal container is malformed hand-built IR.
        return renderStartEvent(el);
      case 'endEvent':
        // A typed end event is a throw (`throw error`/`throw escalation`/
        // `throw compensation`); a plain end (no definition) is the ordinary
        // terminator, omitted entirely when it is a synthesized implicit end
        // (a reserved `EndEvent_` id, including a boundary escape chain's
        // `EndEvent_Boundary_…`) — the grammar's `name=ID` is mandatory, so
        // there is no anonymous surface, and the forward compiler
        // re-synthesizes the same id from the container id.
        if (el.eventDefinition === undefined) {
          return isSynthesizedTerminalId(el.id)
            ? undefined
            : `end ${el.id}${labelSuffix(el.name)}`;
        }
        return renderThrow(el.id, el.eventDefinition);
      case 'intermediateThrowEvent': {
        // `emit` fires an event and keeps going. Only an escalation, a signal,
        // or compensation is emittable this way; an error, message, timer, or
        // conditional definition here is malformed IR (an error aborts its path
        // — that is `throw error` — and the other three have no throw surface
        // at all). A synthesized `Throw_…` id drops its name token, keeping
        // just the trigger and payload.
        const def = el.eventDefinition;
        switch (def.kind) {
          case 'escalation':
            return `emit escalation${throwNameSuffix(el.id)}${quotedCode(def.escalationCode)}`;
          case 'signal':
            return `emit signal${throwNameSuffix(el.id)} ${quote(def.signalName)}`;
          case 'compensation':
            return `emit compensation${throwNameSuffix(el.id)}`;
          default:
            throw new Error(
              `irToDsl: intermediate throw '${el.id}' carries a ${def.kind} definition; only escalation, signal, or compensation can be emitted.`,
            );
        }
      }
      case 'intermediateCatchEvent':
        // `await` blocks on the main flow until the trigger fires; it has no
        // name slot (the id is always the synthesized `Catch_…`), so the
        // rendered line carries only the trigger and its payload.
        return `await ${renderTriggerHead(el.eventDefinition)}`;
      case 'userTask':
        return renderUserTask(el);
      case 'serviceTask':
        return renderServiceTask(el);
      case 'callActivity':
        return renderCallActivity(el);
      case 'scriptTask':
        // A script task has no single-line form: its opaque fenced body is
        // emitted as a multi-line group in `emitNode`, which never reaches this
        // switch for a scriptTask. Listed for exhaustiveness so a new kind is
        // caught by the type checker.
        return undefined;
      case 'subProcess':
        // A sub-process has no single-line form: it is emitted as a multi-line
        // `subprocess <id> { … }` group in `emitNode`, which never reaches this
        // switch for a subProcess. Listed for exhaustiveness so a new kind is
        // caught by the type checker.
        return undefined;
      case 'boundaryEvent':
        // A boundary event has no single-line form either: like a
        // sub-process, it prints as a multi-line group — an
        // `on <attachedToRef>: <trigger> … { … }` handler body — emitted by
        // `emitBoundaryHandler`, which this switch is never reached for.
        // Listed for exhaustiveness so the type checker still catches the
        // next new FlowElement kind added here.
        return undefined;
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
 * Stand-in printed for an edge the emitter can neither name nor place: a jump
 * into a gateway that still has a choice to make, or a surplus out-edge with
 * no position to occupy. Ordinary BPMN produces both. A loop whose condition
 * sits on the back-edge rather than on the forward edge into the body is the
 * common case for the first, since no loop pattern matches it and the head
 * gateway is emitted as an `if`.
 *
 * Rather than fabricate a target or approximate the semantics, the emitter
 * prints this comment where the edge would have gone and appends the element
 * the edge led into. The output stays parseable, and the CLI turns the marker
 * into a warning so the loss is reported rather than silent.
 */
export const UNSTRUCTURED_MARKER =
  '// unstructured region: hand-repair required';

/** The marker text for one dropped edge, naming where the edge led. */
function droppedEdgeMarker(target: string): string {
  return `${UNSTRUCTURED_MARKER} (dropped edge into ${target})`;
}

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

/**
 * Whether a flow element is an `on` handler — an event sub-process. Handlers
 * carry no flow edges and print at the end of their container's body, so they
 * are excluded from the fall-through walk and emitted by a dedicated pass.
 */
function isHandler(
  el: FlowElement,
): el is Extract<FlowElement, { kind: 'subProcess' }> {
  return el.kind === 'subProcess' && el.triggeredByEvent === true;
}

/**
 * Whether a flow element is a boundary event — an `on` handler attached to a
 * host activity. A boundary event has outgoing flow but no incoming, so it is
 * never reached by the fall-through walk and prints, together with its escape
 * chain, in a dedicated pass.
 */
function isBoundary(
  el: FlowElement,
): el is Extract<FlowElement, { kind: 'boundaryEvent' }> {
  return el.kind === 'boundaryEvent';
}

/**
 * Whether this element's id is absent from its printed form, leaving nothing
 * in the output for a `goto` to resolve against.
 *
 * The question is only ever "does the printed form spell the id", so every
 * kind is answered here rather than by a list of the ones that came to mind.
 * Three reasons an id goes missing: the surface has no name slot for that kind
 * at all (`await` takes only a trigger), the element prints as a block header
 * keyed on something else (a boundary event and an event sub-process both
 * print `on …`), or the id is synthesized and deliberately dropped so the
 * forward compiler can re-derive it. An ordinary sub-process, a script task
 * and a call activity all print their id and stay valid jump targets.
 */
function isElidedOnPrint(el: FlowElement): boolean {
  switch (el.kind) {
    case 'startEvent':
      // A synthesized start without a form block prints no statement at all.
      return el.formFields === undefined && isSynthesizedTerminalId(el.id);
    case 'endEvent':
    case 'intermediateThrowEvent':
      // Both spell the id through `throwNameSuffix`, which drops a synthesized
      // one; a plain synthesized end prints no statement at all.
      return isSynthesizedTerminalId(el.id);
    case 'intermediateCatchEvent':
      // `await <trigger>` has no name slot in the grammar.
      return true;
    case 'boundaryEvent':
      // Prints as `on <attachedToRef>: <trigger>`, keyed on the host.
      return true;
    case 'subProcess':
      // An event sub-process prints as an `on` handler header; an ordinary one
      // prints `subprocess <id> { … }`.
      return el.triggeredByEvent === true;
    case 'userTask':
    case 'serviceTask':
    case 'callActivity':
    case 'scriptTask':
      return false;
    case 'exclusiveGateway':
    case 'parallelGateway':
      // No statement form at all. Callers forward past a gateway rather than
      // ask about it, so this arm is unreachable from `forwardToRealTarget`.
      return true;
    default: {
      const exhaustive: never = el;
      throw new Error(
        `irToDsl: unhandled FlowElement kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * These are the desugarer's synthesized-terminal id prefixes — an author can
 * never type them (the validator rejects them), so any id carrying one here
 * is synthesized, not authored. `EndEvent_` also covers a boundary escape
 * chain's implicit end (`EndEvent_Boundary_…`), which is built from the same
 * prefix.
 */
function isSynthesizedTerminalId(id: string): boolean {
  return (
    id.startsWith('StartEvent_') ||
    id.startsWith('EndEvent_') ||
    id.startsWith('Throw_')
  );
}

/**
 * A `throw`/`emit` statement's optional `name=ID` token, rendered as
 * ` <id>`, or omitted (empty string) when `id` is a synthesized terminal id.
 * The forward compiler re-synthesizes the same `Throw_…` id from the
 * statement's coordinate, so dropping it here is lossless and keeps the
 * trigger keyword and payload printing on their own.
 */
function throwNameSuffix(id: string): string {
  return isSynthesizedTerminalId(id) ? '' : ` ${id}`;
}

/**
 * Render a typed end event as a `throw <trigger> <id>? …` statement. An
 * authored id prints (the explicit-event precedent) so it survives as a goto
 * target across round-trips; a synthesized `Throw_…` id is dropped, keeping
 * just the trigger and payload. Error and escalation carry an optional code;
 * a signal carries its required name; compensation carries neither — it is
 * payload-less, so `throw compensation <id>` never takes a trailing string. A
 * message/timer/conditional definition here is malformed hand-built IR —
 * nothing about those kinds can be thrown — so it is refused with a clear
 * message.
 */
function renderThrow(id: string, def: EventDefinition): string {
  switch (def.kind) {
    case 'error':
      return `throw error${throwNameSuffix(id)}${quotedCode(def.errorCode)}`;
    case 'escalation':
      return `throw escalation${throwNameSuffix(id)}${quotedCode(def.escalationCode)}`;
    case 'signal':
      return `throw signal${throwNameSuffix(id)} ${quote(def.signalName)}`;
    case 'compensation':
      return `throw compensation${throwNameSuffix(id)}`;
    default:
      throw new Error(
        `irToDsl: end event '${id}' carries a ${def.kind} definition; only error, escalation, signal, or compensation can be thrown.`,
      );
  }
}

/**
 * Build an `on` handler header from its trigger start event: the trigger word
 * and its payload (a code with catch bindings, a message/signal name, a timer
 * particle clause, a parenthesized condition, or nothing at all for
 * compensation, which is bare `on compensation`), plus ` alongside` for a
 * non-interrupting handler, followed by the opening brace.
 */
function buildOnHeader(
  handler: Extract<FlowElement, { kind: 'subProcess' }>,
): string {
  const start = handler.flowElements.find(
    (e): e is Extract<FlowElement, { kind: 'startEvent' }> =>
      e.kind === 'startEvent',
  );
  if (start === undefined || start.eventDefinition === undefined) {
    throw new Error(
      `irToDsl: event sub-process '${handler.id}' has no trigger start event.`,
    );
  }
  const alongside = start.isInterrupting === false ? ' alongside' : '';
  return `on ${renderTriggerHead(start.eventDefinition)}${alongside} {`;
}

/**
 * Build a boundary handler header: the host id, the colon that separates it
 * from the trigger, then the same trigger word and payload a host-less handler
 * prints, plus ` alongside` for a non-interrupting boundary.
 *
 * `attachedToRef` is printed verbatim. It is the whole surface the header
 * needs, so a host that does not resolve in this container still prints — the
 * emitter's job is to render the IR it is given, and refusing a cross-container
 * attachment belongs to validation, not to printing.
 */
function buildBoundaryHeader(
  boundary: Extract<FlowElement, { kind: 'boundaryEvent' }>,
): string {
  const alongside = boundary.cancelActivity === false ? ' alongside' : '';
  return `on ${boundary.attachedToRef}: ${renderTriggerHead(boundary.eventDefinition)}${alongside} {`;
}

/** The DSL timer particle for each timer kind. */
const TIMER_PARTICLE: Record<
  Extract<EventDefinition, { kind: 'timer' }>['timerKind'],
  string
> = { duration: 'after', date: 'at', cycle: 'every' };

/**
 * Render an `on` handler's trigger word and payload (everything between `on ` and
 * the ` alongside`/`{` suffix): `error`/`escalation` with their optional code and
 * catch bindings, `message`/`signal` with the quoted name, `timer` with its
 * particle and quoted time text, `condition` with the recovered expression in
 * parens (bare DSL when in the JUEL subset, else the quoted `"${…}"` fallback),
 * or `compensation` with no payload at all — it is a bare trigger word, never a
 * code and never parens.
 */
function renderTriggerHead(def: EventDefinition): string {
  switch (def.kind) {
    case 'error':
      return `error${quotedCode(def.errorCode)}${buildEventBindings(def)}`;
    case 'escalation':
      return `escalation${quotedCode(def.escalationCode)}${buildEventBindings(def)}`;
    case 'compensation':
      return 'compensation';
    case 'message':
      return `message ${quote(def.messageName)}`;
    case 'signal':
      return `signal ${quote(def.signalName)}`;
    case 'timer':
      return `timer ${TIMER_PARTICLE[def.timerKind]} ${quote(def.expression)}`;
    case 'conditional':
      return `condition (${renderRawCondition(def.condition)})`;
    default: {
      const exhaustive: never = def;
      throw new Error(
        `irToDsl: unhandled EventDefinition kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Render the catch bindings of an error/escalation definition as
 * ` (code x, message y)`, in canonical order (code before message), or empty
 * when no binding is set. Only an error carries a message binding; an escalation
 * has just a code.
 */
function buildEventBindings(
  def: Extract<EventDefinition, { kind: 'error' | 'escalation' }>,
): string {
  const parts: string[] = [];
  if (def.codeVariable !== undefined) parts.push(`code ${def.codeVariable}`);
  if (def.kind === 'error' && def.messageVariable !== undefined) {
    parts.push(`message ${def.messageVariable}`);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** ` "<code>"` suffix, or empty when the code is absent (catch-all). */
function quotedCode(code: string | undefined): string {
  return code !== undefined ? ` ${quote(code)}` : '';
}

/**
 * Render a `start <id> "<label>"? { form { … } }` statement, or `undefined`
 * to omit it entirely when the start is a synthesized implicit start (a
 * reserved `StartEvent_` id carrying no authored form). The grammar's
 * `name=ID` is mandatory, so a synthesized start has no anonymous surface —
 * it must be dropped whole rather than partially printed — and the forward
 * compiler re-synthesizes the same id from the container id, so the omission
 * is lossless. A synthesized start never carries form fields (an implicit
 * start is bare), so this never drops authored content.
 */
function renderStartEvent(
  el: Extract<FlowElement, { kind: 'startEvent' }>,
): string | undefined {
  if (el.formFields === undefined && isSynthesizedTerminalId(el.id)) {
    return undefined;
  }
  const members =
    el.formFields !== undefined ? [renderFormBlock(el.formFields)] : [];
  return `start ${el.id}${labelSuffix(el.name)}${attrBlock(members)}`;
}

/** Render a `user <id> "<label>"? { … }` statement with its attribute block. */
function renderUserTask(
  el: Extract<FlowElement, { kind: 'userTask' }>,
): string {
  const attrs: string[] = [];
  if (el.assignee !== undefined) attrs.push(`assignee = ${quote(el.assignee)}`);
  if (el.formKey !== undefined) attrs.push(`formKey = ${quote(el.formKey)}`);
  if (el.formFields !== undefined) attrs.push(renderFormBlock(el.formFields));
  return `user ${el.id}${labelSuffix(el.name)}${attrBlock(attrs)}`;
}

/**
 * Render a `form { <field>* }` block inline. Fields are whitespace-separated,
 * which the grammar's `fields+=FormField*` accepts, so the whole block stays on
 * one line (the emitter indents statements per-line, so a statement string must
 * not contain newlines).
 */
function renderFormBlock(formFields: FormField[]): string {
  return `form { ${formFields.map(renderFormField).join(' ')} }`;
}

/** Render one form field: `<id>: <type> "<label>"? (= <default>)?`. */
function renderFormField(field: FormField): string {
  const label = field.label !== undefined ? ` ${quote(field.label)}` : '';
  const def =
    field.defaultValue !== undefined
      ? ` = ${renderFormDefault(field.defaultValue, field.type)}`
      : '';
  return `${field.id}: ${field.type}${label}${def}`;
}

/**
 * Render a form field's default value as a DSL expression. `string`/`date`
 * defaults are quoted; `number`/`boolean` defaults are bare literals; an EL
 * expression (`${…}`) is quoted as the raw fallback form regardless of type.
 */
function renderFormDefault(value: string, type: FormFieldType): string {
  if (value.startsWith('${')) {
    return quote(value);
  }
  return type === 'number' || type === 'boolean' ? value : quote(value);
}

/**
 * Render a service task's statement line, choosing the attribute from its
 * binding — always under the one `service` keyword:
 *
 *   - `class`              → `service <id> "<label>"? { class = "…" }`
 *   - `expression`         → `service <id> "<label>"? { expression = "${…}" }`
 *   - `delegateExpression` → `service <id> "<label>"? { delegate = "${…}" }`
 *   - `external`           → `service <id> "<label>"? { topic = "…" }`
 *
 * The `delegate` keyword is the friendly DSL alias for
 * `operaton:delegateExpression`; the alias is applied here, so the XML-level
 * name never surfaces in the source. Expression/delegate values are quoted
 * verbatim (the `${…}` wrapper is part of the value), re-parsing as a raw
 * expression. An `external` binding keeps the `service` keyword and prints
 * its one attribute as `topic`.
 */
function renderServiceTask(
  el: Extract<FlowElement, { kind: 'serviceTask' }>,
): string {
  const binding = el.binding;
  const head = (attr: string): string =>
    `service ${el.id}${labelSuffix(el.name)}${attrBlock([attr])}`;
  switch (binding.kind) {
    case 'class':
      return head(`class = ${quote(binding.className)}`);
    case 'expression':
      return head(`expression = ${quote(binding.expression)}`);
    case 'delegateExpression':
      return head(`delegate = ${quote(binding.expression)}`);
    case 'external':
      return head(`topic = ${quote(binding.topic)}`);
    default: {
      const exhaustive: never = binding;
      throw new Error(
        `irToDsl: unhandled service binding kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Render a call activity's single-line statement:
 *
 *   `call <id> "<label>"? { process = "…" [binding|version] [businessKey] <mappings> }`
 *
 * Members print in a fixed order so the round-trip is stable: the called
 * `process`, then the version-resolution keyword, then the business key, then
 * every in-mapping, then every out-mapping. The emitter indents each returned
 * line, so the whole statement stays on one line.
 *
 * `binding = latest|deployment` prints for the strategy bindings; a pinned
 * version prints only `version = <v>` (no `binding` key). An absent binding
 * prints neither.
 */
function renderCallActivity(
  el: Extract<FlowElement, { kind: 'callActivity' }>,
): string {
  const members: string[] = [`process = ${quote(el.calledElement)}`];

  if (el.binding !== undefined) {
    switch (el.binding.kind) {
      case 'latest':
        members.push('binding = latest');
        break;
      case 'deployment':
        members.push('binding = deployment');
        break;
      case 'version':
        members.push(`version = ${renderCallVersion(el.binding.version)}`);
        break;
      default: {
        const exhaustive: never = el.binding;
        throw new Error(
          `irToDsl: unhandled call binding kind: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  if (el.businessKey !== undefined) {
    members.push(`businessKey = ${quote(el.businessKey)}`);
  }

  for (const mapping of el.inMappings ?? []) {
    members.push(renderCallMapping('in', mapping));
  }
  for (const mapping of el.outMappings ?? []) {
    members.push(renderCallMapping('out', mapping));
  }

  return `call ${el.id}${labelSuffix(el.name)}${attrBlock(members)}`;
}

/**
 * Render a pinned call-activity version as the exact inverse of the desugarer's
 * read: an all-digit version prints as a bare integer, and anything else
 * (including a `${…}` expression) prints double-quoted verbatim so it re-parses
 * as a raw expression or string literal rather than a bare integer.
 */
function renderCallVersion(version: string): string {
  return /^[0-9]+$/.test(version) ? version : quote(version);
}

/**
 * Render one call-activity variable mapping as `in|out [local ]<body>`:
 *   - `all`        → `*`
 *   - `variable`   → `<target>` when source and target coincide (shorthand),
 *                    else `<target> = <source>` (both bare identifiers).
 *   - `expression` → `<target> = "<sourceExpression>"`, always quoted verbatim
 *                    so a `${…}` value round-trips as an expression rather than
 *                    re-desugaring to a bare `variable` mapping.
 */
function renderCallMapping(
  keyword: 'in' | 'out',
  mapping: CallVariableMapping,
): string {
  const localPrefix = mapping.local === true ? 'local ' : '';
  let body: string;
  switch (mapping.kind) {
    case 'all':
      body = '*';
      break;
    case 'variable':
      body =
        mapping.source === mapping.target
          ? mapping.target
          : `${mapping.target} = ${mapping.source}`;
      break;
    case 'expression':
      body = `${mapping.target} = ${quote(mapping.sourceExpression)}`;
      break;
    default: {
      const exhaustive: never = mapping;
      throw new Error(
        `irToDsl: unhandled call mapping kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
  return `${keyword} ${localPrefix}${body}`;
}

/**
 * Render a `script <id> "<label>"? ```<format> … ``` ` fenced block.
 *
 * The opening `script … ```<format>` is an ordinary DSL line (the caller
 * indents it). The body and closing fence follow verbatim and are **opaque** —
 * the script content is reproduced byte-for-byte, never re-indented as if it
 * were DSL — so the returned value carries its own newlines rather than being a
 * single statement line.
 *
 * The closing fence is placed **directly after** `code` with no injected
 * newline: the desugarer's fence split strips only the single newline after the
 * language tag and keeps the rest of the block verbatim, so any newline emitted
 * before the closing fence would be re-absorbed into the body on re-parse. A
 * `code` that already ends in a newline therefore lands its closing fence on its
 * own line; one that does not keeps the fence on the final body line — either
 * way the body round-trips unchanged.
 */
function renderScriptTask(
  el: Extract<FlowElement, { kind: 'scriptTask' }>,
): string {
  return `script ${el.id}${labelSuffix(el.name)} \`\`\`${el.format}\n${el.code}\`\`\``;
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
  return renderRawCondition(flow.conditionExpression ?? '');
}

/**
 * Recover a raw `${…}` condition body as DSL surface text: {@link parseJuel}
 * decides whether it fits the JUEL subset (→ bare unquoted DSL) or must fall
 * back to the quoted `"${…}"` raw form ({@link renderRawFallback}). Shared by
 * conditioned flows and `on condition (…)` handler headers.
 */
function renderRawCondition(body: string): string {
  return renderRawFallback(parseJuel(body));
}

/**
 * Wrap a string value in double-quotes, backslash-escaping inner double-quotes
 * and backslashes to match the grammar's STRING terminal.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
