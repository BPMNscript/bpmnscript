/**
 * Restructuring IR -> DSL, the inverse of `astToIr`: a flat, BPMN-shaped
 * {@link BpmnProcess} back into source that re-parses and re-desugars to an
 * equivalent IR.
 *
 * Structure comes from the dominator analysis in `cfg-analysis.ts` matched
 * against a fixed pattern catalog; whatever it cannot fold degrades to
 * `goto`. See ADR 0009, Use Dominator/Post-Dominator Analysis for IR-to-DSL
 * Restructuring, for the catalog, the totality guarantee, and the edges that
 * have no `goto` form and leave an {@link UNSTRUCTURED_MARKER}.
 *
 * Every gateway a pattern matches is elided, which is what makes DSL -> IR ->
 * DSL idempotent: the desugarer derives gateway ids from structural
 * coordinates, so one that never prints is re-synthesized under the same id.
 */

import { END_TRIGGERS } from '@bpmn-script/language';
import type {
  BpmnProcess,
  CallVariableMapping,
  CodeBinding,
  EngineAttributes,
  EventDefinition,
  FlowContainer,
  FlowElement,
  FormField,
  FormFieldType,
  IoMapped,
  IoValue,
  ListenerBinding,
  Repeatable,
  SequenceFlow,
  ServiceTaskBinding,
  SettingsCarrier,
  VersionBinding,
} from './ir/types.js';
import { repeats } from './ir/types.js';
import { analyzeCfg, type CfgAnalysis } from './cfg-analysis.js';
import { parseJuel, renderRawFallback } from './juel.js';

const INDENT = '  ';

export function irToDsl(process: BpmnProcess): string {
  const emitter = new Emitter(process);
  const body = emitter.emit();

  const declarations: string[] = [];
  if (process.versionTag !== undefined) {
    declarations.push(`${INDENT}versionTag = ${quote(process.versionTag)}`);
  }
  for (const m of process.errorMessages ?? []) {
    declarations.push(
      `${INDENT}error ${quote(m.code)} message ${quote(m.message)}`,
    );
  }
  declarations.push(...collectionDecls(process));

  const header = buildProcessHeader(process);
  const lines = [header, ...declarations, ...body.map((l) => INDENT + l), '}'];
  return lines.join('\n') + '\n';
}

/**
 * One per container. A sub-process's body lives in the child container's
 * arrays, so the parent's CFG never sees inside it and treats the sub-process
 * as one opaque node. Cross-container edges cannot exist, so no region spans
 * two containers.
 */
class Emitter {
  private readonly cfg: CfgAnalysis;
  private readonly byId = new Map<string, FlowElement>();
  /** In IR order, which is what keeps emission deterministic. */
  private readonly outgoingBySource = new Map<string, SequenceFlow[]>();
  private readonly emittedNodes = new Set<string>();
  private readonly consumedFlows = new Set<string>();

  constructor(
    private readonly container: FlowContainer,
    /**
     * An event sub-process's start prints its trigger in the `on` header, so
     * the start statement inside the body prints without one.
     */
    private readonly startTriggerSuppressed = false,
  ) {
    this.cfg = analyzeCfg(container);
    for (const el of container.flowElements) {
      // A duplicate would corrupt the walk. The desugarer resolves collisions,
      // so one here means malformed IR.
      if (this.byId.has(el.id)) {
        throw new Error(
          `irToDsl: duplicate flow element id '${el.id}' in container '${container.id}'.`,
        );
      }
      this.byId.set(el.id, el);
    }
    for (const f of container.sequenceFlows) {
      const list = this.outgoingBySource.get(f.sourceRef) ?? [];
      list.push(f);
      this.outgoingBySource.set(f.sourceRef, list);
    }
  }

  /**
   * The order of the first three passes is a constraint. A boundary escape
   * chain is never reached from a start event, so walking it before the orphan
   * sweep stops that sweep printing the chain as detached top-level statements,
   * and walking it after the structured pass makes a chain rejoining the main
   * flow degrade to a `goto`, its targets being emitted already.
   */
  emit(): string[] {
    const lines: string[] = [];

    // 1. Structured emission from each start event.
    for (const el of this.container.flowElements) {
      if (el.kind === 'startEvent' && !this.emittedNodes.has(el.id)) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }

    // 2. Boundary handlers, held back because the surface requires a handler
    //    block to follow the body it guards.
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

    // 5. Trailing handler group: boundary blocks, then event sub-processes.
    for (const l of boundaryLines) lines.push(l);
    for (const el of this.container.flowElements) {
      if (isHandler(el) && !this.emittedNodes.has(el.id)) {
        this.emitHandler(el, lines);
      }
    }

    return lines;
  }

  /** A handler carries no flow edges, so there is no fall-through continuation. */
  private emitHandler(
    handler: Extract<FlowElement, { kind: 'subProcess' }>,
    lines: string[],
  ): void {
    this.emittedNodes.add(handler.id);
    lines.push(buildOnHeader(handler));
    for (const l of new Emitter(handler, true).emit()) lines.push(INDENT + l);
    lines.push('}');
  }

  /**
   * A boundary body is not a separate container: its nodes live in this
   * container's arrays and share `emittedNodes`/`consumedFlows` with the main
   * flow, so a rejoining chain degrades to a `goto` through the ordinary
   * machinery. `depth` is the caller's, so a chain reached through a flow edge
   * keeps spending the same {@link MAX_NESTING_DEPTH} budget.
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
   * Follows fall-through flow until `stop` (exclusive), a terminal, or a node
   * unreachable structurally, which degrades to a `goto`.
   */
  private emitFrom(
    node: string | undefined,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): void {
    if (depth > MAX_NESTING_DEPTH) {
      // Flush the arrival as a goto rather than overflowing the stack.
      if (node !== undefined) this.pushGoto(node, lines);
      return;
    }
    let current = node;
    // Bounded by the node count, against a malformed IR cycle.
    let guard = this.byId.size + 1;
    while (current !== undefined && current !== stop && guard-- > 0) {
      if (this.emittedNodes.has(current)) {
        this.pushGoto(current, lines);
        return;
      }
      const next = this.emitNode(current, stop, lines, depth);
      if (next === STOP) return;
      current = next;
    }
  }

  /** Returns the next id in the fall-through chain, or {@link STOP}. */
  private emitNode(
    id: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    const el = this.byId.get(id);
    if (el === undefined) return STOP;

    // A do-while body entry is reached before its loop gateway, so it has to be
    // recognized here or the body prints ahead of the loop and degrades.
    const doWhile = this.tryDoWhileEntry(id, stop, lines, depth);
    if (doWhile !== undefined) return doWhile;

    // A gateway has no statement form to jump from, so it cannot rely on the
    // final sweep: every out-edge is captured here, by a construct or a goto.
    if (el.kind === 'exclusiveGateway') {
      // Recognized before the if-chain so it is not mistaken for an XOR split.
      const loop = this.tryWhile(el, stop, lines, depth);
      if (loop !== undefined) return loop;
      return this.emitExclusiveGateway(el, stop, lines, depth);
    }
    if (el.kind === 'parallelGateway') {
      return this.emitParallelGateway(el, stop, lines, depth);
    }

    // A fenced body is opaque multi-line text, so it prints as a line group.
    if (el.kind === 'scriptTask') {
      this.emittedNodes.add(id);
      lines.push(renderScriptTask(el));
      return this.followLinear(id, stop, lines, depth);
    }

    if (el.kind === 'subProcess') {
      // An event sub-process prints in the trailing handler pass. Reaching one
      // through a flow edge means malformed IR, so print it here and stop.
      if (el.triggeredByEvent === true) {
        this.emitHandler(el, lines);
        return STOP;
      }
      this.emittedNodes.add(id);
      const head = el.element === 'transaction' ? 'attempt' : 'subprocess';
      lines.push(
        `${head} ${id}${labelSuffix(el.name)}${repeatClause(el)}${attrBlock(settingsMembers(el))} {`,
      );
      for (const l of new Emitter(el).emit()) lines.push(INDENT + l);
      lines.push('}');
      return this.followLinear(id, stop, lines, depth);
    }

    // Not reached by flow either. The plain-node case below would emit nothing
    // and lose the element, so a malformed inbound edge prints its block here.
    if (isBoundary(el)) {
      this.emitBoundaryHandler(el, lines, depth);
      return STOP;
    }

    this.emittedNodes.add(id);
    const stmt = this.renderStatement(el);
    if (stmt !== undefined) lines.push(stmt);
    return this.followLinear(id, stop, lines, depth);
  }

  /** A `goto` for every out-edge that cannot be structured fall-through. */
  private followLinear(
    id: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    const outs = (this.outgoingBySource.get(id) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );
    if (outs.length === 0) return STOP;

    if (outs.length === 1) {
      const f = outs[0]!;
      this.consumedFlows.add(f.id);
      return this.continueAt(f.targetRef, stop, lines);
    }

    // A statement has room for exactly one fall-through, so the first
    // un-emitted target continues the chain and the rest are surplus.
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

  /**
   * Given a clean post-dominating join, the branch bodies are the full
   * sub-regions up to it; without one, each body is a single `goto target`, so
   * every edge still survives.
   */
  private emitExclusiveGateway(
    split: Extract<FlowElement, { kind: 'exclusiveGateway' }>,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(split.id);
    const outs = (this.outgoingBySource.get(split.id) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      // Degenerate single-out gateway: transparent.
      const f = outs[0]!;
      this.consumedFlows.add(f.id);
      return this.continueAt(f.targetRef, stop, lines);
    }

    // Desugared IR has at most one unconditioned flow. Imported IR may carry more.
    const conditioned = outs.filter((f) => f.conditionExpression !== undefined);
    const unconditioned = outs.filter(
      (f) => f.conditionExpression === undefined,
    );

    const join =
      this.cleanJoin(split.id, outs) ?? this.guardClauseContinuation(outs);

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

    // Stop when the gateway was unstructured and every branch jumped away.
    return join !== undefined ? this.continueAt(join, stop, lines) : STOP;
  }

  /**
   * A chained `if (true) {} else {} else {}` is not valid DSL, so the third and
   * later out-edges become bare `goto`s. Only hand-built IR reaches here.
   */
  private emitUnconditionedXorDegradation(
    unconditioned: SequenceFlow[],
    join: string | undefined,
    splitId: string,
    lines: string[],
    depth: number,
  ): void {
    // `first` exists: outs.length >= 2 with no conditioned flow.
    const [first, second, ...rest] = unconditioned;
    lines.push('if (true) {');
    this.emitIfBranch(first!.targetRef, join, splitId, lines, depth);
    if (second !== undefined) {
      lines.push('} else {');
      this.emitIfBranch(second!.targetRef, join, splitId, lines, depth);
    }
    lines.push('}');
    // No structured form and no position: the chain continues from the join,
    // which a jump written here would cut off.
    for (const f of rest) {
      this.pushSurplusEdge(f.targetRef, lines);
    }
  }

  /**
   * An `if` has at most one `else`, so a second unconditioned flow, which only
   * hand-built IR carries, is preserved as a bare `goto`.
   */
  private emitConditionedIfChain(
    conditioned: SequenceFlow[],
    unconditioned: SequenceFlow[],
    join: string | undefined,
    splitId: string,
    lines: string[],
    depth: number,
  ): void {
    conditioned.forEach((f, i) => {
      const keyword = i === 0 ? 'if' : '} else if';
      lines.push(`${keyword} (${renderCondition(f)}) {`);
      this.emitIfBranch(f.targetRef, join, splitId, lines, depth);
    });

    const [elseFlow, ...surplus] = unconditioned;
    if (elseFlow === undefined || elseFlow.targetRef === join) {
      lines.push('}');
    } else {
      lines.push('} else {');
      this.emitIfBranch(elseFlow.targetRef, join, splitId, lines, depth);
      lines.push('}');
    }

    for (const f of surplus) {
      if (f.targetRef === join) continue; // duplicate of the implicit fall-through
      this.pushSurplusEdge(f.targetRef, lines);
    }
  }

  /**
   * The checks below establish that the branch region belongs to this gateway
   * and re-enters at the join. `undefined` means the gateway is unstructured.
   */
  private cleanJoin(splitId: string, outs: SequenceFlow[]): string | undefined {
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
   * A guard clause has no clean join: one branch terminates while the else-less
   * default carries the main flow. Treating that default as the continuation
   * prints it after the `if` instead of as a bare `goto` at the split.
   */
  private guardClauseContinuation(outs: SequenceFlow[]): string | undefined {
    const unconditioned = outs.filter(
      (f) => f.conditionExpression === undefined,
    );
    return unconditioned.length === 1 ? unconditioned[0]!.targetRef : undefined;
  }

  /**
   * Walk or `goto` is decided per branch, since branches mix: one can flow back
   * to the join while another jumps away.
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
      // Empty branch (default -> join): no body.
    } else if (
      !this.emittedNodes.has(entry) &&
      this.branchStaysInRegion(entry, join, splitId)
    ) {
      this.emitFrom(entry, join, body, depth + 1);
    } else {
      // The target escapes the [split, join) region: preserve the edge as a goto.
      this.pushGoto(entry, body);
    }
    for (const l of body) lines.push(INDENT + l);
  }

  /**
   * Whether the entry sits inside `[split, join)` and can be walked inline.
   *
   * Two shapes qualify. An ordinary body that re-merges, so `join`
   * post-dominates `entry`. And a guard clause whose entry is a synthesized
   * terminal the split owns and that terminates before the join: an end has no
   * continuation to relocate, prints the same statement in either scope, and is
   * reached only through this split. An authored entry stays a `goto`, keeping
   * its chain at its authored scope so its coordinate-derived id survives the
   * round trip.
   */
  private branchStaysInRegion(
    entry: string,
    join: string,
    splitId: string,
  ): boolean {
    if (this.cfg.postDominates(join, entry)) return true;
    const el = this.byId.get(entry);
    return (
      el !== undefined &&
      isSynthesizedTerminalId(entry, el.kind) &&
      this.cfg.dominates(splitId, entry) &&
      !this.cfg.dominates(join, entry)
    );
  }

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

  /** The post-loop continuation, or `undefined` when the pattern misses. */
  private tryWhile(
    loop: FlowElement,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP | undefined {
    if (loop.kind !== 'exclusiveGateway') return undefined;

    // Unconditioned mirrors `tryDoWhileEntry`'s conditioned requirement, so the
    // two patterns never both fire.
    const backEdge = this.cfg
      .backEdges()
      .filter((f) => !this.consumedFlows.has(f.id))
      .find(
        (f) => f.targetRef === loop.id && f.conditionExpression === undefined,
      );
    if (backEdge === undefined) return undefined;

    const outs = (this.outgoingBySource.get(loop.id) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );
    const cond = outs.find((f) => f.conditionExpression !== undefined);
    const exit = outs.find((f) => f.conditionExpression === undefined);
    if (cond === undefined) return undefined;

    this.emittedNodes.add(loop.id);
    this.consumedFlows.add(cond.id);
    this.consumedFlows.add(backEdge.id);
    if (exit !== undefined) this.consumedFlows.add(exit.id);

    lines.push(`while (${renderCondition(cond)}) {`);
    // The back-edge is consumed, so the body walk stops at the head.
    this.emitBranch(cond.targetRef, loop.id, lines, depth);
    lines.push('}');

    return exit === undefined
      ? STOP
      : this.continueAt(exit.targetRef, stop, lines);
  }

  /**
   * Post-test `do { body } while (c)`, recognized at the body entry because the
   * body runs before the test and would otherwise print as a plain statement.
   * The pattern: an exclusive gateway `L` with a conditioned back-edge
   * `L -> node` and an unconditioned exit, where `node` dominates `L`. The
   * conditioned back-edge is what tells this from a pre-test `while`, which
   * would otherwise match here through its inner join-to-head edge.
   */
  private tryDoWhileEntry(
    node: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP | undefined {
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
    const outs = (this.outgoingBySource.get(loopId) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );
    // The back-edge carries the loop condition, the other out-edge the exit.
    const cond = backEdge;
    const exit = outs.find(
      (f) => f.id !== backEdge.id && f.conditionExpression === undefined,
    );

    this.emittedNodes.add(loopId);
    this.consumedFlows.add(cond.id);
    if (exit !== undefined) this.consumedFlows.add(exit.id);

    lines.push('do {');
    this.emitBranch(node, loopId, lines, depth);
    lines.push(`} while (${renderCondition(cond)})`);

    return exit === undefined
      ? STOP
      : this.continueAt(exit.targetRef, stop, lines);
  }

  /**
   * A clean fork prints `parallel { { } { } }` with both gateways elided. A
   * branch terminating before the join still prints that way, resuming after
   * the join the survivors share ({@link recoveredParallelJoin}).
   */
  private emitParallelGateway(
    fork: Extract<FlowElement, { kind: 'parallelGateway' }>,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(fork.id);
    const outs = (this.outgoingBySource.get(fork.id) ?? []).filter(
      (f) => !this.consumedFlows.has(f.id),
    );

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      const f = outs[0]!;
      this.consumedFlows.add(f.id);
      return this.continueAt(f.targetRef, stop, lines);
    }

    const join =
      this.cleanParallelJoin(fork.id, outs) ??
      this.recoveredParallelJoin(fork.id, outs);

    for (const f of outs) this.consumedFlows.add(f.id);

    if (join === undefined) {
      for (const f of outs) this.pushGoto(f.targetRef, lines);
      return STOP;
    }

    // The join is continued from, never pre-elided: a one-out parallel join is
    // a transparent pass-through in `emitNode`.
    lines.push('parallel {');
    outs.forEach((f) => {
      // `emitBranch` prefixes one INDENT; wrap and re-indent for `parallel {`.
      const branchLines: string[] = [];
      this.emitBranch(f.targetRef, join, branchLines, depth);
      lines.push(INDENT + '{');
      for (const l of branchLines) lines.push(INDENT + l);
      lines.push(INDENT + '}');
    });
    lines.push('}');

    return this.continueAt(join, stop, lines);
  }

  /** Narrowed to a real `parallelGateway`, which tells an AND merge from an XOR one. */
  private cleanParallelJoin(
    forkId: string,
    outs: SequenceFlow[],
  ): string | undefined {
    const join = this.cleanJoin(forkId, outs);
    if (join === undefined) return undefined;
    return this.byId.get(join)?.kind === 'parallelGateway' ? join : undefined;
  }

  /**
   * When a branch terminates at a `throw` or `end` the fork has no clean
   * post-dominator, but the survivors still reconverge at a real
   * `parallelGateway`. Each branch contributes, nearest first, the
   * fork-dominated parallel gateways on its post-dominator chain. Parallel
   * branches share no node before reconverging, so the first candidate common
   * to every chain is the join, and the nearest keeps the continuation at this
   * fork rather than a sibling's nested `parallel`. The `cur !== forkId` guard
   * rejects a back-edge fork that post-dominates itself.
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

  /**
   * The arrival rule every fall-through follows. Returning a merge node does
   * not elide it: a synthesized join gateway has one remaining out-edge once
   * the branch edges are consumed, so `emitNode` passes through it and prints
   * nothing, reproducing the desugarer's elision, while a real node that
   * happens to be the merge point prints its normal statement.
   */
  private continueAt(
    target: string,
    stop: string | undefined,
    lines: string[],
  ): string | typeof STOP {
    if (target === stop) return STOP;
    if (this.emittedNodes.has(target)) {
      this.pushGoto(target, lines);
      return STOP;
    }
    return target;
  }

  /**
   * The single jump site every other routes through, so "a `goto` never names a
   * gateway" holds in one place. A jump into a gateway that still has a choice
   * cannot be named at all, so that edge is dropped and marked.
   */
  private pushGoto(target: string, lines: string[]): void {
    const real = this.forwardToRealTarget(target, new Set());
    lines.push(real !== undefined ? `goto ${real}` : droppedEdgeMarker(target));
  }

  /**
   * A second or later edge leaving a position that already has a fall-through.
   * The jump ends the enclosing chain when re-desugared, costing that
   * fall-through, so it is written only when it is the only thing keeping its
   * target attached. Hence the resolution below runs without the consumed-edge
   * fallback {@link forwardToRealTarget} allows elsewhere: an already-reachable
   * target buys nothing, so the edge is dropped and marked.
   */
  private pushSurplusEdge(target: string, lines: string[]): void {
    const real = this.forwardToRealTarget(target, new Set(), false);
    lines.push(real !== undefined ? `goto ${real}` : droppedEdgeMarker(target));
  }

  /**
   * The first node with a statement form, the only kind a `goto` can name. A
   * jump into a gateway re-runs its routing, so it means the same as a jump at
   * the successor whenever that routing has one outcome. The walk crosses the
   * single unrealized out-edge, and once all are realized, the sole out-edge of
   * a gateway that never had a choice: consumption records that an edge printed
   * as structured flow, not that it stopped existing.
   *
   * `undefined` for a routing with more than one outcome, a revisited gateway,
   * or a node the emitter drops on print, whose `goto` would parse but never
   * resolve. An unknown id is named verbatim, being a dangling IR reference.
   */
  private forwardToRealTarget(
    target: string,
    seen: Set<string>,
    acrossConsumed = true,
  ): string | undefined {
    const el = this.byId.get(target);
    if (el === undefined) return target;
    if (el.kind !== 'exclusiveGateway' && el.kind !== 'parallelGateway') {
      return isElidedOnPrint(el) ? undefined : target;
    }
    if (seen.has(target)) return undefined;
    seen.add(target);
    const outs = this.outgoingBySource.get(target) ?? [];
    const unconsumed = outs.filter((f) => !this.consumedFlows.has(f.id));
    let forward: SequenceFlow | undefined;
    if (unconsumed.length === 1) forward = unconsumed[0];
    else if (acrossConsumed && outs.length === 1) forward = outs[0];
    if (forward === undefined) return undefined;
    return this.forwardToRealTarget(forward.targetRef, seen, acrossConsumed);
  }

  /** `undefined` when the element has no statement form. */
  private renderStatement(el: FlowElement): string | undefined {
    switch (el.kind) {
      case 'startEvent':
        return renderStartEvent(el, this.startTriggerSuppressed);
      case 'endEvent': {
        const members = startOrEndMembers(el);
        const definition = el.eventDefinition;
        if (definition === undefined || isEndCarried(definition)) {
          if (isElidedOnPrint(el)) return undefined;
          const head = definition === undefined ? '' : ` ${definition.kind}`;
          return `end ${el.id}${labelSuffix(el.name)}${head}${attrBlock(members)}`;
        }
        return renderThrow(
          el,
          definition,
          attrBlock([...throwBindingMembers(el), ...members]),
        );
      }
      case 'intermediateThrowEvent': {
        // Only escalation, signal, message, and compensation are emittable: an
        // error aborts its path (`throw error`) and the rest have no throw surface.
        const def = el.eventDefinition;
        const block = attrBlock([
          ...throwBindingMembers(el),
          ...settingsMembers(el),
        ]);
        switch (def.kind) {
          case 'escalation':
            return `emit escalation${throwNameSuffix(el)}${quotedCode(def.escalationCode)}${block}`;
          case 'signal':
            return `emit signal${throwNameSuffix(el)} ${quote(def.signalName)}${block}`;
          case 'message':
            return `emit message${throwNameSuffix(el)} ${quote(def.messageName)}${block}`;
          case 'compensation':
            return `emit compensation${throwNameSuffix(el)}${block}`;
          default:
            throw new Error(
              `irToDsl: intermediate throw '${el.id}' carries a ${def.kind} definition; only escalation, signal, message, or compensation can be emitted.`,
            );
        }
      }
      case 'intermediateCatchEvent':
        // `await` has no name slot, so the line is trigger, payload, block.
        return `await ${renderTriggerHead(el.eventDefinition)}${attrBlock(settingsMembers(el))}`;
      case 'userTask':
        return renderUserTask(el);
      case 'serviceTask':
        return renderServiceTask(el);
      case 'task':
        return `step ${el.id}${labelSuffix(el.name)}${repeatClause(el)}${attrBlock(settingsMembers(el))}`;
      case 'receiveTask':
        return renderReceiveTask(el);
      case 'callActivity':
        return renderCallActivity(el);
      // These print as a line group in `emitNode`/`emitBoundaryHandler`, and are
      // listed so the type checker still catches a new kind.
      case 'scriptTask':
        return undefined;
      case 'subProcess':
        return undefined;
      case 'boundaryEvent':
        return undefined;
      case 'exclusiveGateway':
      case 'parallelGateway':
        // An unrecognized gateway emits nothing; its edges become gotos.
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

const STOP = Symbol('stop');

/**
 * Printed where an edge the emitter can neither name nor place would have gone,
 * instead of fabricating a target. The CLI turns it into a warning.
 */
export const UNSTRUCTURED_MARKER =
  '// unstructured region: hand-repair required';

function droppedEdgeMarker(target: string): string {
  return `${UNSTRUCTURED_MARKER} (dropped edge into ${target})`;
}

/** A pathological IR degrades to a `goto` rather than overflowing the stack. */
const MAX_NESTING_DEPTH = 1000;

function buildProcessHeader(process: BpmnProcess): string {
  if (process.name !== undefined) {
    return `process ${process.id} ${quote(process.name)} {`;
  }
  return `process ${process.id} {`;
}

/** Handlers carry no flow edges and print at the end of their container's body. */
function isHandler(
  el: FlowElement,
): el is Extract<FlowElement, { kind: 'subProcess' }> {
  return el.kind === 'subProcess' && el.triggeredByEvent === true;
}

/** A boundary event has outgoing but no incoming flow, so a dedicated pass prints it. */
function isBoundary(
  el: FlowElement,
): el is Extract<FlowElement, { kind: 'boundaryEvent' }> {
  return el.kind === 'boundaryEvent';
}

/**
 * The definitions an `end` statement spells in its own head rather than
 * raising, one per word the surface takes there. Both keep the label a `throw`
 * would drop, and the word each prints is its kind.
 */
const END_CARRIED_KINDS = new Set<EventDefinition['kind']>(END_TRIGGERS);

/** Read by the print and by the elision, so the two cannot drift. */
function isEndCarried(def: EventDefinition): boolean {
  return END_CARRIED_KINDS.has(def.kind);
}

/**
 * Whether the id is absent from the printed form, leaving a `goto` nothing to
 * resolve against. `xmlToIr` asks the same question to report the label an
 * elided start or end takes with it, so the two answers cannot drift apart.
 */
export function isElidedOnPrint(
  el: FlowElement,
  startTriggerSuppressed = false,
): boolean {
  switch (el.kind) {
    case 'startEvent':
      // A trigger has nowhere else to print, so a start carrying one always
      // prints. Inside an event sub-process the trigger prints in the `on`
      // header instead, and the emitter suppresses it here.
      if (el.eventDefinition !== undefined && !startTriggerSuppressed) {
        return false;
      }
      return (
        isSynthesizedTerminalId(el.id, el.kind) && !carriesPrintableContent(el)
      );
    case 'endEvent':
      if (!isSynthesizedTerminalId(el.id, el.kind)) return false;
      // Dropping a plain end is lossless because the forward compiler
      // re-derives an equivalent one at the same position; a definition the
      // `end` statement carries it cannot re-derive, so that always prints,
      // and `end`'s mandatory `name=ID` means the synthesized id prints too.
      if (el.eventDefinition === undefined) return !carriesPrintableContent(el);
      // Every other definition prints as a `throw`, which drops a synthesized name.
      return !isEndCarried(el.eventDefinition);
    case 'intermediateThrowEvent':
      // Spells the id through `throwNameSuffix`, which drops a synthesized one.
      return isSynthesizedTerminalId(el.id, el.kind);
    case 'intermediateCatchEvent':
      // `await <trigger>` has no name slot in the grammar.
      return true;
    case 'boundaryEvent':
      // Prints as `on <attachedToRef>: <trigger>`, keyed on the host.
      return true;
    case 'subProcess':
      // An event sub-process prints as an `on` header, an ordinary one its id.
      return el.triggeredByEvent === true;
    case 'userTask':
    case 'serviceTask':
    case 'callActivity':
    case 'scriptTask':
    case 'task':
    case 'receiveTask':
      return false;
    case 'exclusiveGateway':
    case 'parallelGateway':
      // Callers forward past a gateway rather than ask, so this arm is unreachable.
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
 * A synthesized start or end has no authored name and the grammar's `name=ID`
 * is mandatory, so it is dropped whole unless its block carries content. Both
 * {@link isElidedOnPrint} and the renderers read this one answer: a new reason
 * to print reaching one but not the other would leave a jump naming a statement
 * that never gets emitted.
 *
 * A label is not such a reason: printing the id to carry one writes a name the
 * validator rejects, so the label is reported as an import warning instead.
 */
function carriesPrintableContent(
  el: Extract<FlowElement, { kind: 'startEvent' | 'endEvent' }>,
): boolean {
  return startOrEndMembers(el).length > 0;
}

/** Settings members first, then the form block: the order every statement follows. */
function startOrEndMembers(
  el: Extract<FlowElement, { kind: 'startEvent' | 'endEvent' }>,
): string[] {
  const members = settingsMembers(el);
  if (el.kind === 'startEvent' && el.formFields !== undefined) {
    members.push(renderFormBlock(el.formFields));
  }
  return members;
}

/** In print order. A kind-specific member is placed around this list. */
function settingsMembers(el: SettingsCarrier): string[] {
  return [...engineAttrs(el), ...ioParameters(el), ...listenerMembers(el)];
}

/** Fixed order, so the block stays stable across runs. */
function engineAttrs(el: EngineAttributes): string[] {
  const attrs: string[] = [];
  if (el.asyncBefore === true) attrs.push('asyncBefore = true');
  if (el.asyncAfter === true) attrs.push('asyncAfter = true');
  if (el.exclusive === false) attrs.push('exclusive = false');
  if (el.jobPriority !== undefined) {
    attrs.push(`jobPriority = ${renderNumericValue(el.jobPriority)}`);
  }
  if (el.retryCycle !== undefined) {
    attrs.push(`retryCycle = ${quote(el.retryCycle)}`);
  }
  return attrs;
}

/** Inputs before outputs, each in IR order, which the engine evaluates in. */
function ioParameters(el: IoMapped): string[] {
  const members: string[] = [];
  for (const param of el.inputParameters ?? []) {
    members.push(`input ${param.name} = ${renderIoValue(param.value)}`);
  }
  for (const param of el.outputParameters ?? []) {
    members.push(`output ${param.name} = ${renderIoValue(param.value)}`);
  }
  return members;
}

/**
 * Text takes the quoting every string-valued attribute uses, so a `${...}` body
 * re-parses as a raw expression. A map key always quotes, since the bare
 * spelling is an identifier token and a key reading as a keyword would not lex.
 */
function renderIoValue(value: IoValue): string {
  switch (value.kind) {
    case 'text':
      return quote(value.text);
    case 'list':
      return `[${value.items.map((item) => renderIoValue(item)).join(', ')}]`;
    case 'map': {
      const entries = value.entries.map(
        (entry) => `${quote(entry.key)}: ${renderIoValue(entry.value)}`,
      );
      return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
    }
    case 'script':
      return renderFence(value.format, value.code);
    default: {
      const exhaustive: never = value;
      throw new Error(
        `irToDsl: unhandled io value kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Execution listeners before lifecycle listeners. The two event vocabularies
 * are disjoint, so the event word alone tells them apart on the way back in.
 */
function listenerMembers(el: SettingsCarrier): string[] {
  const members = (el.executionListeners ?? []).map((listener) =>
    renderListener(listener.event, listener.binding),
  );
  for (const listener of el.taskListeners ?? []) {
    members.push(
      renderListener(listener.event, listener.binding, listener.timer),
    );
  }
  return members;
}

function renderListener(
  event: string,
  binding: ListenerBinding,
  timer?: Extract<EventDefinition, { kind: 'timer' }>,
): string {
  const clause =
    timer !== undefined
      ? ` ${TIMER_PARTICLE[timer.timerKind]} ${quote(timer.expression)}`
      : '';
  const body =
    binding.kind === 'script'
      ? renderFence(binding.format, binding.code)
      : `{ ${renderCodeBinding(binding)} }`;
  return `on ${event}${clause} ${body}`;
}

/**
 * `delegate` is the DSL alias for `operaton:delegateExpression`. An expression
 * quotes verbatim, its `${...}` wrapper being part of the value.
 */
function renderCodeBinding(binding: CodeBinding): string {
  switch (binding.kind) {
    case 'class':
      return `class = ${quote(binding.className)}`;
    case 'expression':
      return `expression = ${quote(binding.expression)}`;
    case 'delegateExpression':
      return `delegate = ${quote(binding.expression)}`;
    default: {
      const exhaustive: never = binding;
      throw new Error(
        `irToDsl: unhandled code binding kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * The closing fence sits directly after `code` with no injected newline: the
 * split on the way in strips only the newline after the language tag, so a
 * newline added here would be re-absorbed into the body on re-parse. The result
 * carries its own newlines, so a statement holding one is a line group.
 */
function renderFence(format: string, code: string): string {
  return `\`\`\`${format}\n${code}\`\`\``;
}

/**
 * The validator rejects these prefixes in authored source, so an id carrying
 * the one its own kind is minted with is synthesized. An id carrying another
 * kind's template is an authored name and has to keep printing. An end answers
 * to `Throw_` as well, because `throw` lowers to an end event.
 */
function isSynthesizedTerminalId(
  id: string,
  kind: FlowElement['kind'],
): boolean {
  switch (kind) {
    case 'startEvent':
      return id.startsWith('StartEvent_');
    case 'endEvent':
      return id.startsWith('EndEvent_') || id.startsWith('Throw_');
    case 'intermediateThrowEvent':
      return id.startsWith('Throw_');
    default:
      return false;
  }
}

/**
 * Omitted for a synthesized id: the forward compiler re-derives the same
 * `Throw_...` from the statement's coordinate, so dropping it is lossless.
 */
function throwNameSuffix(
  el: Extract<FlowElement, { kind: 'endEvent' | 'intermediateThrowEvent' }>,
): string {
  return isSynthesizedTerminalId(el.id, el.kind) ? '' : ` ${el.id}`;
}

/** An authored id prints so it survives as a goto target. */
function renderThrow(
  el: Extract<FlowElement, { kind: 'endEvent' }>,
  def: EventDefinition,
  block: string,
): string {
  const name = throwNameSuffix(el);
  switch (def.kind) {
    case 'error':
      return `throw error${name}${quotedCode(def.errorCode)}${block}`;
    case 'escalation':
      return `throw escalation${name}${quotedCode(def.escalationCode)}${block}`;
    case 'signal':
      return `throw signal${name} ${quote(def.signalName)}${block}`;
    case 'message':
      return `throw message${name} ${quote(def.messageName)}${block}`;
    case 'compensation':
      return `throw compensation${name}${block}`;
    default:
      throw new Error(
        `irToDsl: end event '${el.id}' carries a ${def.kind} definition; only error, escalation, signal, message, or compensation can be thrown.`,
      );
  }
}

/** Engine attributes come off the sub-process: the start is elided on print. */
function buildOnHeader(
  handler: Extract<FlowElement, { kind: 'subProcess' }>,
): string {
  const start = handler.flowElements.find(
    (e): e is Extract<FlowElement, { kind: 'startEvent' }> =>
      e.kind === 'startEvent',
  );
  if (start === undefined || start.eventDefinition === undefined) {
    throw new Error(
      `irToDsl: event subprocess '${handler.id}' has no trigger start event.`,
    );
  }
  const alongside = start.isInterrupting === false ? ' alongside' : '';
  const block = attrBlock(settingsMembers(handler));
  return `on ${renderTriggerHead(start.eventDefinition)}${alongside}${block} {`;
}

/** `attachedToRef` prints verbatim; refusing a bad host belongs to validation. */
function buildBoundaryHeader(
  boundary: Extract<FlowElement, { kind: 'boundaryEvent' }>,
): string {
  const alongside = boundary.cancelActivity === false ? ' alongside' : '';
  const block = attrBlock(settingsMembers(boundary));
  return `on ${boundary.attachedToRef}: ${renderTriggerHead(boundary.eventDefinition)}${alongside}${block} {`;
}

const TIMER_PARTICLE: Record<
  Extract<EventDefinition, { kind: 'timer' }>['timerKind'],
  string
> = { duration: 'after', date: 'at', cycle: 'every' };

/** Everything between `on ` and the ` alongside`/`{` suffix; compensation has no payload. */
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
    case 'cancel':
      return 'cancel';
    case 'terminate':
      throw new Error(
        'irToDsl: a terminate definition has no trigger head; it prints on the end statement.',
      );
    default: {
      const exhaustive: never = def;
      throw new Error(
        `irToDsl: unhandled EventDefinition kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** ` (code x, message y)`. Only an error carries a message binding. */
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

/** `name=ID` is mandatory, so an elided start is dropped whole and re-derived. */
function renderStartEvent(
  el: Extract<FlowElement, { kind: 'startEvent' }>,
  startTriggerSuppressed: boolean,
): string | undefined {
  if (isElidedOnPrint(el, startTriggerSuppressed)) return undefined;
  const trigger =
    el.eventDefinition === undefined || startTriggerSuppressed
      ? ''
      : ` ${renderTriggerHead(el.eventDefinition)}`;
  return `start ${el.id}${labelSuffix(el.name)}${trigger}${attrBlock(startOrEndMembers(el))}`;
}

/** Assignment attributes, then the settings members, then the form block. */
function renderUserTask(
  el: Extract<FlowElement, { kind: 'userTask' }>,
): string {
  const attrs: string[] = [];
  for (const [key, render] of USER_TASK_MEMBERS) {
    const value = el[key];
    if (value !== undefined) attrs.push(`${key} = ${render(value)}`);
  }
  attrs.push(...settingsMembers(el));
  if (el.formFields !== undefined) attrs.push(renderFormBlock(el.formFields));
  return `user ${el.id}${labelSuffix(el.name)}${repeatClause(el)}${attrBlock(attrs)}`;
}

/** In print order. The IR field name is also the DSL keyword. */
const USER_TASK_MEMBERS = [
  ['assignee', quote],
  ['formKey', quote],
  ['candidateGroups', quote],
  ['candidateUsers', quote],
  ['dueDate', quote],
  ['followUpDate', quote],
  ['priority', renderNumericValue],
] as const;

/** One line, which `fields+=FormField*` accepts: a statement holds no newlines. */
function renderFormBlock(formFields: FormField[]): string {
  return `form { ${formFields.map(renderFormField).join(' ')} }`;
}

/** `<id>: <type> "<label>"? (= <default>)?`. */
function renderFormField(field: FormField): string {
  const label = field.label !== undefined ? ` ${quote(field.label)}` : '';
  const def =
    field.defaultValue !== undefined
      ? ` = ${renderFormDefault(field.defaultValue, field.type)}`
      : '';
  return `${field.id}: ${field.type}${label}${def}`;
}

/** `string` and `date` quote, `number` and `boolean` print bare, EL always quotes. */
function renderFormDefault(value: string, type: FormFieldType): string {
  if (value.startsWith('${')) {
    return quote(value);
  }
  return type === 'number' || type === 'boolean' ? value : quote(value);
}

/** The message leads the block, so the wait reads before its settings. */
function renderReceiveTask(
  el: Extract<FlowElement, { kind: 'receiveTask' }>,
): string {
  const members = [
    ...(el.messageName === undefined
      ? []
      : [`message = ${quote(el.messageName)}`]),
    ...settingsMembers(el),
  ];
  return `receive ${el.id}${labelSuffix(el.name)}${repeatClause(el)}${attrBlock(members)}`;
}

const SERVICE_TASK_LIKE_KEYWORD = {
  service: 'service',
  send: 'send',
  businessRule: 'decide',
} as const;

function renderServiceTask(
  el: Extract<FlowElement, { kind: 'serviceTask' }>,
): string {
  const keyword = SERVICE_TASK_LIKE_KEYWORD[el.element ?? 'service'];
  const members = [
    ...bindingMembers(el.binding),
    ...resultVariableAttr(el),
    ...settingsMembers(el),
  ];
  return `${keyword} ${el.id}${labelSuffix(el.name)}${repeatClause(el)}${attrBlock(members)}`;
}

/** The block members spelling out an execution binding, whatever carries it. */
function bindingMembers(binding: ServiceTaskBinding): string[] {
  switch (binding.kind) {
    case 'class':
    case 'expression':
    case 'delegateExpression':
      return [renderCodeBinding(binding)];
    case 'external':
      return [`topic = ${quote(binding.topic)}`];
    case 'decision':
      return [
        `decision = ${quote(binding.decisionRef)}`,
        ...(binding.binding === undefined
          ? []
          : [versionBindingMember(binding.binding)]),
        ...(binding.mapDecisionResult === undefined
          ? []
          : [`mapDecisionResult = ${binding.mapDecisionResult}`]),
      ];
    default: {
      const exhaustive: never = binding;
      throw new Error(
        `irToDsl: unhandled service binding kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** The implementation of a thrown message; every other throw carries none. */
function throwBindingMembers(el: { binding?: ServiceTaskBinding }): string[] {
  return el.binding === undefined ? [] : bindingMembers(el.binding);
}

/** A pinned version prints `version = <v>` and no `binding`. */
function versionBindingMember(binding: VersionBinding): string {
  switch (binding.kind) {
    case 'latest':
    case 'deployment':
      return `binding = ${binding.kind}`;
    case 'version':
      return `version = ${renderNumericValue(binding.version)}`;
    default: {
      const exhaustive: never = binding;
      throw new Error(
        `irToDsl: unhandled version binding kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Fixed member order. */
function renderCallActivity(
  el: Extract<FlowElement, { kind: 'callActivity' }>,
): string {
  const members: string[] = [`process = ${quote(el.calledElement)}`];

  if (el.binding !== undefined) {
    members.push(versionBindingMember(el.binding));
  }

  if (el.businessKey !== undefined) {
    members.push(`businessKey = ${quote(el.businessKey)}`);
  }

  members.push(...settingsMembers(el));

  for (const mapping of el.inMappings ?? []) {
    members.push(renderCallMapping('in', mapping));
  }
  for (const mapping of el.outMappings ?? []) {
    members.push(renderCallMapping('out', mapping));
  }

  return `call ${el.id}${labelSuffix(el.name)}${repeatClause(el)}${attrBlock(members)}`;
}

/** All-digit prints bare; anything else quotes, so it re-parses as an expression. */
function renderNumericValue(value: string): string {
  return /^[0-9]+$/.test(value) ? value : quote(value);
}

function resultVariableAttr(el: { resultVariable?: string }): string[] {
  return el.resultVariable !== undefined
    ? [`resultVariable = ${quote(el.resultVariable)}`]
    : [];
}

/** An `expression` always quotes, so a `${...}` never re-desugars to a `variable`. */
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

/** Carries its own newlines: only the opening line is the caller's to indent. */
function renderScriptTask(
  el: Extract<FlowElement, { kind: 'scriptTask' }>,
): string {
  const block = attrBlock([...resultVariableAttr(el), ...settingsMembers(el)]);
  return `script ${el.id}${labelSuffix(el.name)}${repeatClause(el)}${block} ${renderFence(el.format, el.code)}`;
}

function labelSuffix(name: string | undefined): string {
  return name !== undefined ? ` ${quote(name)}` : '';
}

/**
 * ` { a = "x" b = "y" }` on one line, which the grammar's `(a | b)*` accepts.
 * A fenced member is the exception: its newlines are part of its token.
 */
function attrBlock(attrs: string[]): string {
  if (attrs.length === 0) return '';
  return ` { ${attrs.join(' ')} }`;
}

/** A literal count prints bare; anything else is an expression. */
export const BARE_CARDINALITY = /^\d+$/;

/** A plain name is the collection variable itself; anything else is an expression. */
const BARE_COLLECTION = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The grammar's `ID` terminal. The clause writes the name each run sees bare
 * and has no other form for it, so this is also the test the import direction
 * refuses by.
 */
export const BARE_ELEMENT_VARIABLE = /^[_a-zA-Z]\w*(-\w+)*$/;

/** Every flow element of `container`, and of the sub-processes nested in it. */
function* eachElement(container: FlowContainer): Generator<FlowElement> {
  for (const el of container.flowElements) {
    yield el;
    if (el.kind === 'subProcess') yield* eachElement(el);
  }
}

/**
 * A `var` line per collection a printed clause names bare, in first-appearance
 * order. Operaton reads a bare `operaton:collection` as the name of a process
 * variable, so a program that iterates one without declaring it reads a
 * variable it never declares; a quoted name and a `${...}` body print as
 * strings and name nothing. The type is `any` because a repetition says a
 * variable is iterated and nothing more, which is also why the element it binds
 * needs no line of its own. A form field or a catch binding of the same name
 * types it already, and every declaration of one name has to agree on the type,
 * so a second line would be an error rather than a duplicate.
 */
function collectionDecls(process: BpmnProcess): string[] {
  const collections = new Set<string>();
  const typed = new Set<string>();
  for (const el of eachElement(process)) {
    if ('formFields' in el) {
      for (const field of el.formFields ?? []) typed.add(field.id);
    }
    const def = 'eventDefinition' in el ? el.eventDefinition : undefined;
    if (def?.kind === 'error' || def?.kind === 'escalation') {
      if (def.codeVariable !== undefined) typed.add(def.codeVariable);
      if ('messageVariable' in def && def.messageVariable !== undefined) {
        typed.add(def.messageVariable);
      }
    }
    const collection = 'loop' in el ? el.loop?.collection : undefined;
    if (collection !== undefined && BARE_COLLECTION.test(collection)) {
      collections.add(collection);
    }
  }
  return [...collections]
    .filter((name) => !typed.has(name))
    .map((name) => `${INDENT}var ${name}: any`);
}

/**
 * The repeat clause of an activity, with a leading space, or the empty string
 * when it runs once. A collection spelled as a plain name prints bare and
 * anything else quotes, because Operaton reads a bare `operaton:collection` as
 * the name of a variable and only a `${...}` body as an expression.
 */
function repeatClause(el: Repeatable): string {
  const loop = el.loop;
  if (!repeats(loop)) return '';

  const parts: string[] = [];
  if (loop.cardinality !== undefined) {
    parts.push(
      BARE_CARDINALITY.test(loop.cardinality)
        ? loop.cardinality
        : renderRawCondition(loop.cardinality),
    );
  }
  if (loop.collection !== undefined) {
    const element =
      loop.elementVariable === undefined ? '' : `${loop.elementVariable} `;
    const collection = BARE_COLLECTION.test(loop.collection)
      ? loop.collection
      : quote(loop.collection);
    parts.push(`each ${element}in ${collection}`);
  }
  if (loop.sequential === true) parts.push('sequentially');
  if (loop.completionCondition !== undefined) {
    parts.push(`until (${renderRawCondition(loop.completionCondition)})`);
  }
  return ` for ${parts.join(' ')}`;
}

function renderCondition(flow: SequenceFlow): string {
  return renderRawCondition(flow.conditionExpression ?? '');
}

/** {@link parseJuel} decides between bare DSL and the quoted raw form. */
function renderRawCondition(body: string): string {
  return renderRawFallback(parseJuel(body));
}

/** Escapes inner quotes and backslashes to match the STRING terminal. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
