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

import {
  END_TRIGGERS,
  isReservedName,
  TIMER_PARTICLE_BY_KIND,
} from '@bpmn-script/language';
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
  Gateway,
  IoMapped,
  IoValue,
  ListenerBinding,
  Repeatable,
  SequenceFlow,
  ServiceTaskBinding,
  SettingsCarrier,
  VersionBinding,
} from './ir/types.js';
import {
  eachElement,
  gatewayDefaultFlowId,
  isGateway,
  repeats,
} from './ir/types.js';
import {
  END_EVENT_PREFIX,
  START_EVENT_PREFIX,
  THROW_EVENT_PREFIX,
} from './synthesize-ids.js';
import { analyzeCfg, type CfgAnalysis } from './cfg-analysis.js';
import { parseJuel, renderRawFallback } from './juel.js';

const INDENT = '  ';

export type PrintWarningCategory =
  | 'label'
  | 'droppedEdge'
  | 'defaultFlow'
  | 'degradedSplit'
  | 'droppedCondition'
  | 'refusedStatement';

/**
 * A non-fatal notice that `irToDsl` could not carry something into the script.
 *
 * Every warning keeps the id out of its message and in `elementId`: a
 * synthesized id routinely spells BPMN vocabulary the surface keeps away from
 * its readers.
 */
export interface PrintWarning {
  elementId: string;
  category: PrintWarningCategory;
  message: string;
}

export function irToDsl(process: BpmnProcess): {
  source: string;
  warnings: PrintWarning[];
} {
  const warnings: PrintWarning[] = [];
  warnGatewayLabels(process, warnings);
  warnRefusedStatements(process, warnings);

  const emitter = new Emitter(process, warnings);
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
  return { source: lines.join('\n') + '\n', warnings };
}

/**
 * A split or a merge is derived from the block structure and has no statement
 * of its own, so a name on one is lost on the way out. Every other elided label
 * is reported by `xmlToIr`, which is why this covers gateways alone: a wider
 * rule would report the same drop twice to a caller printing both channels.
 */
function warnGatewayLabels(
  container: FlowContainer,
  warnings: PrintWarning[],
): void {
  for (const el of container.flowElements) {
    // Keyed on the container shape, so a nested split is reached whatever
    // container it sits in.
    if ('flowElements' in el) {
      warnGatewayLabels(el, warnings);
    } else if (isGateway(el) && el.name !== undefined) {
      warnings.push({
        elementId: el.id,
        category: 'label',
        message:
          `The label '${el.name}' was not written to the script: the ` +
          'script derives every split and every merge from its block ' +
          'structure, so there is no statement here to carry a name. The ' +
          'process runs the same without it.',
      });
    }
  }
}

/**
 * The model, not the print, is where this one comes from: the script writes out
 * the name the model holds, and the compiler turns that writing down on the way
 * back in. The report is what tells the reader it is the model to repair.
 *
 * `suppressed` describes the container being walked, false at the top: a start
 * in the process body prints its own trigger.
 */
function warnRefusedStatements(
  container: FlowContainer,
  warnings: PrintWarning[],
  suppressed = false,
): void {
  for (const el of container.flowElements) {
    if (!isElidedOnPrint(el, suppressed) && isReservedName(el.id)) {
      warnings.push(reservedNameWarning(el.id));
    }
    if (el.kind === 'subProcess') {
      warnRefusedStatements(el, warnings, el.triggeredByEvent === true);
    }
  }
}

function reservedNameWarning(elementId: string): PrintWarning {
  return {
    elementId,
    category: 'refusedStatement',
    message:
      'The name this step carries in the model is one the script keeps for ' +
      'the names it derives itself, so it draws an error when the source is ' +
      'read back. Rename the step in the model and print it again.',
  };
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
    /** Shared with every nested container, so one process yields one report. */
    private readonly warnings: PrintWarning[],
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

    // 4. Final goto sweep. A jump carries the route and nothing else, so a
    //    condition on one of these goes the way a fall-through's does.
    for (const f of this.container.sequenceFlows) {
      if (!this.consumedFlows.has(f.id)) {
        this.consume(f);
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

  /** The routes of `flows` no construct has printed yet, in IR order. */
  private unconsumed(flows: readonly SequenceFlow[]): SequenceFlow[] {
    return flows.filter((f) => !this.consumedFlows.has(f.id));
  }

  private unconsumedOut(id: string): SequenceFlow[] {
    return this.unconsumed(this.outgoingBySource.get(id) ?? []);
  }

  /** A handler carries no flow edges, so there is no fall-through continuation. */
  private emitHandler(
    handler: Extract<FlowElement, { kind: 'subProcess' }>,
    lines: string[],
  ): void {
    this.emittedNodes.add(handler.id);
    lines.push(buildOnHeader(handler));
    for (const l of new Emitter(handler, this.warnings, true).emit())
      lines.push(INDENT + l);
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
      return this.emitChoice(el.id, stop, lines, depth);
    }
    if (el.kind === 'parallelGateway' || el.kind === 'inclusiveGateway') {
      return this.emitForkGateway(el, stop, lines, depth);
    }
    if (el.kind === 'eventBasedGateway') {
      return this.emitRaceGateway(el, stop, lines, depth);
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
      for (const l of new Emitter(el, this.warnings).emit())
        lines.push(INDENT + l);
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

  /**
   * The routes leaving a statement. One is the fall-through the next statement
   * takes; more than one prints as a choice, because a statement is a single
   * position with a single way on, so a jump written for the second route would
   * end the block and cut the first route's chain off after it.
   *
   * What splits is read off the model rather than off the routes left to print:
   * a route an enclosing loop has already printed as its closing brace is one
   * the step takes beside the others all the same.
   */
  private followLinear(
    id: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    const outs = this.outgoingBySource.get(id) ?? [];
    if (outs.length > 1) this.warnings.push(implicitSplitWarning(id));
    return this.emitChoice(id, stop, lines, depth);
  }

  /**
   * Given a clean post-dominating join, the branch bodies are the full
   * sub-regions up to it; without one, each body is a single `goto target`, so
   * every edge still survives. Keyed on the id rather than on a gateway,
   * because a step whose own routes split reaches the same chain with no node
   * of its own there.
   */
  private emitChoice(
    splitId: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(splitId);
    return this.emitRoutes(
      splitId,
      this.unconsumedOut(splitId),
      stop,
      lines,
      depth,
    );
  }

  /**
   * The routes taken at one position, given as a list rather than read off the
   * split, so a construct that has already spent some of a node's routes can
   * hand the rest to the same chain. The loop emitters do: the routes their
   * pattern does not spend are taken at the position after the closing line.
   */
  private emitRoutes(
    splitId: string,
    outs: SequenceFlow[],
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    // A choice does read a condition written on the route taken when no other
    // holds, and the engine refuses the model at deployment for carrying one.
    // Asked of the routes the model gives the split, ahead of the two shapes
    // below that print without a chain.
    const fallbackId = this.splitFallbackFlowId(splitId);
    const named = this.splitFallbackFlow(splitId);
    if (named?.conditionExpression !== undefined) {
      this.warnings.push(choiceFallbackConditionWarning(splitId));
    }

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      // One route on: the fall-through, or a degenerate single-out gateway.
      return this.takeFallThrough(outs[0]!, stop, lines);
    }

    // The fallback is the chain's `else` whatever else it carries: heading its
    // branch with the condition would put the branch on a run of its own and
    // leave the split with nowhere to go when nothing holds.
    const fallback = outs.find((f) => f.id === fallbackId);

    // Desugared IR has at most one unconditioned flow. Imported IR may carry more.
    const conditioned = outs.filter(
      (f) => f !== fallback && f.conditionExpression !== undefined,
    );
    const unconditioned = outs.filter(
      (f) => f === fallback || f.conditionExpression === undefined,
    );
    this.warnInventedFallback(splitId);

    const join =
      this.cleanJoin(splitId, outs) ??
      this.guardClauseContinuation(unconditioned);

    for (const f of outs) this.consumedFlows.add(f.id);
    this.emitIfChain(
      conditioned,
      unconditioned,
      fallback,
      join,
      splitId,
      lines,
      depth,
    );

    // Stop when the gateway was unstructured and every branch jumped away.
    return join !== undefined ? this.continueAt(join, stop, lines) : STOP;
  }

  /**
   * Every route gets a form: one carrying a condition heads its own branch with
   * it, and one carrying none heads a branch as `true`, takes the chain's
   * `else`, or runs straight into the join as the fall-through, which is
   * written as nothing at all.
   *
   * An `if` chain has one `else`, so an earlier route with no condition heads
   * its branch with `true`. A split reaches that only with a second
   * unconditioned route, which the desugarer never writes.
   *
   * `fallback` is the route the model takes when no condition holds, and it
   * gets the `else` ahead of any other candidate, which is what keeps the chain
   * total where the model was.
   */
  private emitIfChain(
    weighed: SequenceFlow[],
    unweighed: SequenceFlow[],
    fallback: SequenceFlow | undefined,
    join: string | undefined,
    splitId: string,
    lines: string[],
    depth: number,
  ): void {
    // A route straight to the join is the fall-through an `else`-less chain
    // already has, so it prints as nothing and takes the `else` when it can: a
    // `true` head over that empty branch would leave the rest unreachable.
    const elseFlow =
      fallback ??
      unweighed.find((f) => f.targetRef === join) ??
      unweighed.at(-1);
    const heads: [condition: string, flow: SequenceFlow][] = [
      ...weighed.map((f): [string, SequenceFlow] => [renderCondition(f), f]),
      ...unweighed
        .filter((f) => f !== elseFlow)
        .map((f): [string, SequenceFlow] => ['true', f]),
    ];

    // At least one head: this runs on two routes or more, and at most one of
    // them is the `else`.
    heads.forEach(([condition, f], i) => {
      lines.push(`${i === 0 ? 'if' : '} else if'} (${condition}) {`);
      this.emitIfBranch(f.targetRef, join, splitId, lines, depth);
    });

    if (elseFlow === undefined || elseFlow.targetRef === join) {
      lines.push('}');
    } else {
      lines.push('} else {');
      this.emitIfBranch(elseFlow.targetRef, join, splitId, lines, depth);
      lines.push('}');
    }
  }

  /**
   * A split the catalog cannot fold, every route leaving as a jump. Each jump
   * takes a branch of its own because a jump ends its block, so a second one
   * written beside the first could never run. Nothing weighs the branches: the
   * conditions go with the split, which {@link degradedSplitWarning} reports.
   */
  private emitJumps(
    splitId: string,
    outs: SequenceFlow[],
    lines: string[],
    depth: number,
  ): void {
    this.emitIfChain([], outs, undefined, undefined, splitId, lines, depth);
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
   *
   * Reads the routes the chain leaves unweighed rather than the split's own
   * edges, so the one route the model takes when no condition holds is the
   * continuation whether it carries a condition or not.
   */
  private guardClauseContinuation(
    unconditioned: SequenceFlow[],
  ): string | undefined {
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
   * Whether the entry sits inside `[split, join)` and can be walked inline. Two
   * shapes qualify: an ordinary body that re-merges, so `join` post-dominates
   * `entry`; and a guard clause whose entry is a synthesized terminal the split
   * owns and that terminates before the join, which has no continuation to
   * relocate and prints the same statement in either scope. An authored entry
   * stays a `goto`, keeping its chain at its authored scope so its
   * coordinate-derived id survives the round trip.
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

  /** With no `join` the body runs to its own end, which is how a race with no merge prints. */
  private emitBranch(
    entry: string,
    join: string | undefined,
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
    const backEdge = this.unconsumed(this.cfg.backEdges()).find(
      (f) => f.targetRef === loop.id && f.conditionExpression === undefined,
    );
    if (backEdge === undefined) return undefined;

    const outs = this.unconsumedOut(loop.id);
    const cond = outs.find((f) => f.conditionExpression !== undefined);
    if (cond === undefined) return undefined;

    this.emittedNodes.add(loop.id);
    this.consumedFlows.add(cond.id);
    this.consumedFlows.add(backEdge.id);
    const rest = this.takeRest(outs);

    lines.push(`while (${renderCondition(cond)}) {`);
    // The back-edge is consumed, so the body walk stops at the head.
    this.emitBranch(cond.targetRef, loop.id, lines, depth);
    lines.push('}');

    return this.emitRoutes(loop.id, rest, stop, lines, depth);
  }

  /**
   * Post-test `do { body } while (c)`, recognized at the body entry because the
   * body runs before the test and would otherwise print as a plain statement.
   * The pattern: an exclusive gateway `L` with a conditioned back-edge
   * `L -> node`, where `node` dominates `L`. The conditioned back-edge is what
   * tells this from a pre-test `while`, which would otherwise match here
   * through its inner join-to-head edge.
   */
  private tryDoWhileEntry(
    node: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP | undefined {
    const backEdge = this.unconsumed(this.cfg.backEdges()).find((f) => {
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
    const outs = this.unconsumedOut(loopId);
    // The back-edge carries the loop condition; the routes beside it are taken
    // where the loop leaves off.
    const cond = backEdge;

    this.emittedNodes.add(loopId);
    this.consumedFlows.add(cond.id);
    const rest = this.takeRest(outs);

    lines.push('do {');
    this.emitBranch(node, loopId, lines, depth);
    lines.push(`} while (${renderCondition(cond)})`);

    return this.emitRoutes(loopId, rest, stop, lines, depth);
  }

  /**
   * The routes of `outs` the caller has not spent on its own pattern, marked
   * printed here so a jump landing on the loop head while the body is walked
   * reads the same routing it did before. {@link emitRoutes} takes them from
   * the position the loop leaves off at, which is where the model takes them.
   */
  private takeRest(outs: SequenceFlow[]): SequenceFlow[] {
    const rest = this.unconsumed(outs);
    for (const f of rest) this.consumedFlows.add(f.id);
    return rest;
  }

  /**
   * A clean fork prints `parallel { { } { } }` with both gateways elided. A
   * branch terminating before the join still prints that way, resuming after
   * the join the survivors share ({@link recoveredForkJoin}).
   *
   * A fork whose branches carry conditions prints the same block with a head on
   * each branch. One rule reads it back: a condition on any branch means the
   * branches are weighed one by one, none anywhere means they all run.
   */
  private emitForkGateway(
    fork: ForkGateway,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(fork.id);
    const outs = this.unconsumedOut(fork.id);

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      return this.takeFallThrough(outs[0]!, stop, lines);
    }

    const join =
      this.cleanForkJoin(fork.id, outs, fork.kind) ??
      this.recoveredForkJoin(fork.id, outs, fork.kind);

    for (const f of outs) this.consumedFlows.add(f.id);

    if (join === undefined) {
      this.warnings.push(degradedSplitWarning(fork.id));
      this.emitJumps(fork.id, outs, lines, depth);
      return STOP;
    }

    this.warnInventedFallback(fork.id);
    this.warnFallbackCondition(fork, outs);
    this.warnUnweighedBranchCondition(fork, outs);

    // The fallback running straight into the merge is the one the reader gets
    // back for free by leaving it out, so writing it would put an `else { }`
    // in the script the model never had. Two branches is the fewest the block
    // form takes, so it is only left out while two remain.
    const kept = outs.filter((f) => !this.isImplicitFallback(fork, f, join));
    const branches = kept.length >= 2 ? kept : outs;
    this.warnDeadFallback(fork, branches);

    // The join is continued from, never pre-elided: a one-out parallel join is
    // a transparent pass-through in `emitNode`.
    lines.push('parallel {');
    branches.forEach((f) => {
      // `emitBranch` prefixes one INDENT; wrap and re-indent for `parallel {`.
      const branchLines: string[] = [];
      this.emitBranch(f.targetRef, join, branchLines, depth);
      lines.push(INDENT + this.branchHead(fork, f) + '{');
      for (const l of branchLines) lines.push(INDENT + l);
      lines.push(INDENT + '}');
    });
    lines.push('}');

    return this.continueAt(join, stop, lines);
  }

  /**
   * `else `, `if (c) ` or nothing. The fallback heads its branch as the
   * fallback whatever else it carries: a fork takes it when no other branch was
   * taken, and a condition written on it is weighed nowhere, so printing that
   * condition would put the branch back on a run of its own. A fork that weighs
   * nothing heads no branch at all.
   */
  private branchHead(fork: ForkGateway, flow: SequenceFlow): string {
    if (fork.kind !== 'inclusiveGateway') return '';
    if (flow.id === fork.defaultFlowId) return 'else ';
    return flow.conditionExpression === undefined
      ? ''
      : `if (${renderCondition(flow)}) `;
  }

  /**
   * The fallback edge that goes nowhere but the merge, which prints as nothing.
   * A condition on it is weighed nowhere, so it leaves the edge implicit all
   * the same; {@link warnFallbackCondition} reports the condition either way.
   */
  private isImplicitFallback(
    fork: ForkGateway,
    flow: SequenceFlow,
    join: string,
  ): boolean {
    return (
      fork.kind === 'inclusiveGateway' &&
      flow.id === fork.defaultFlowId &&
      flow.targetRef === join
    );
  }

  /**
   * An unconditioned route is taken whatever the conditions do, so only a split
   * whose every route is weighed and which names none to take when none holds
   * can be left with nowhere to go. The printed block falls through once its
   * branches are done, handing that split a fallback it did not have, which is
   * a change in what runs.
   *
   * Read off the model rather than from the caller's list: the engine weighs
   * every route the element has, so one an enclosing construct has already
   * printed keeps the element from running out of routes all the same.
   *
   * A split names the route it takes there and the IR carries that name, so the
   * report can say the model named none. A step names it in BPMN and the IR
   * does not carry it, so {@link inventedStepFallbackWarning} reports the same
   * fall-through without claiming what the model named.
   */
  private warnInventedFallback(splitId: string): void {
    // A split that takes every route whatever the conditions say never runs out
    // of routes, so there is no failure here for a fall-through to paper over.
    const el = this.byId.get(splitId);
    if (el?.kind === 'parallelGateway') return;
    if (this.splitFallbackFlowId(splitId) !== undefined) return;
    const outs = this.outgoingBySource.get(splitId) ?? [];
    if (outs.some((f) => f.conditionExpression === undefined)) return;
    this.warnings.push(
      el !== undefined && isGateway(el)
        ? inventedFallbackWarning(splitId)
        : inventedStepFallbackWarning(splitId),
    );
  }

  /**
   * The route a split takes when no condition holds, for one that names it.
   * The IR carries it on a split alone, so a step answers `undefined` whatever
   * its BPMN said, and so do the split kinds that read no condition.
   */
  private splitFallbackFlowId(splitId: string): string | undefined {
    const el = this.byId.get(splitId);
    return el !== undefined && isGateway(el)
      ? gatewayDefaultFlowId(el)
      : undefined;
  }

  /**
   * The same route as the flow it is, and `undefined` for a split that names
   * one it has no route for. The engine looks the name up among the routes the
   * split has and raises where it finds none, so a name alone is not a route
   * the model can take.
   */
  private splitFallbackFlow(splitId: string): SequenceFlow | undefined {
    const fallbackId = this.splitFallbackFlowId(splitId);
    return (this.outgoingBySource.get(splitId) ?? []).find(
      (f) => f.id === fallbackId,
    );
  }

  /**
   * The mirror of {@link warnInventedFallback}: a fork whose fallback nothing
   * can reach, because a branch beside it carries no condition and so runs
   * whatever the conditions do. {@link branchHead} writes that fallback as an
   * `else`, which the validator refuses for the same reason, and the model is
   * where the refusal comes from rather than the printing, so the fallback is
   * written out and reported instead of dropped.
   *
   * Reads the branches that print, after {@link isImplicitFallback} has taken
   * out the fallback going nowhere but the merge: that one leaves no `else`
   * behind and so nothing to report.
   */
  private warnDeadFallback(fork: ForkGateway, branches: SequenceFlow[]): void {
    if (fork.kind !== 'inclusiveGateway') return;
    const fallback = branches.find((f) => f.id === fork.defaultFlowId);
    if (fallback === undefined) return;
    const alwaysRuns = branches.some(
      (f) => f !== fallback && f.conditionExpression === undefined,
    );
    if (!alwaysRuns) return;
    this.warnings.push(deadFallbackWarning(fork.id));
  }

  /**
   * A condition on the fallback itself. A fork weighs its branches and takes
   * the fallback only when it took none of them, so the condition on the
   * fallback is weighed nowhere and {@link branchHead} prints the branch as the
   * fallback alone. The condition is dropped there, and reported here.
   *
   * Reads the fork's own edges rather than the branches that print, so the
   * fallback {@link isImplicitFallback} leaves out is covered too.
   */
  private warnFallbackCondition(fork: ForkGateway, outs: SequenceFlow[]): void {
    if (fork.kind !== 'inclusiveGateway') return;
    const fallback = outs.find((f) => f.id === fork.defaultFlowId);
    if (fallback?.conditionExpression === undefined) return;
    this.warnings.push(forkFallbackConditionWarning(fork.id));
  }

  /**
   * A condition on a branch of a fork that opens every branch. The engine
   * reads no condition here, and {@link branchHead} writes none, because a
   * condition written on a branch is what tells a fork that weighs its
   * branches from one that does not: printing it would read back as the other
   * fork. The condition is dropped there, and reported here.
   */
  private warnUnweighedBranchCondition(
    fork: ForkGateway,
    outs: SequenceFlow[],
  ): void {
    if (fork.kind !== 'parallelGateway') return;
    if (!outs.some((f) => f.conditionExpression !== undefined)) return;
    this.warnings.push(unweighedBranchWarning(fork.id));
  }

  /** Narrowed to a merge of the fork's own kind, which tells an AND merge from an XOR one. */
  private cleanForkJoin(
    forkId: string,
    outs: SequenceFlow[],
    joinKind: Gateway['kind'],
  ): string | undefined {
    const join = this.cleanJoin(forkId, outs);
    if (join === undefined) return undefined;
    return this.byId.get(join)?.kind === joinKind ? join : undefined;
  }

  /**
   * When a branch terminates at a `throw` or `end` the fork has no clean
   * post-dominator, but the survivors still reconverge at a real merge of kind
   * `joinKind`. Each branch contributes, nearest first, the fork-dominated
   * gateways of that kind on its post-dominator chain. Branches of one fork
   * share no node before reconverging, so the first candidate common to every
   * chain is the join, and the nearest keeps the continuation at this fork
   * rather than a sibling's nested block. The `cur !== forkId` guard rejects a
   * back-edge fork that post-dominates itself.
   */
  private recoveredForkJoin(
    forkId: string,
    outs: SequenceFlow[],
    joinKind: Gateway['kind'],
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
          this.byId.get(cur)?.kind === joinKind &&
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
   * `await { <wait> { } <wait> { } }`: every branch opens on a wait, and the
   * first to resolve cancels the rest. The pattern is keyed on the waits alone,
   * so it still holds with no merge to return to, which is the shape a race
   * whose every branch ends takes. A branch opening on anything else is not a
   * race at all and degrades, every edge keeping a jump or a marker.
   */
  private emitRaceGateway(
    race: Extract<FlowElement, { kind: 'eventBasedGateway' }>,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(race.id);
    const outs = this.unconsumedOut(race.id);

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      return this.takeFallThrough(outs[0]!, stop, lines);
    }

    const waits = outs.map((f) => this.raceWait(f.targetRef));
    for (const f of outs) this.consumedFlows.add(f.id);

    if (waits.some((w) => w === undefined)) {
      this.warnings.push(degradedSplitWarning(race.id));
      this.emitJumps(race.id, outs, lines, depth);
      return STOP;
    }

    // Below the degradation above, whose own report already covers the
    // conditions lost with the split it could not print.
    if (outs.some((f) => f.conditionExpression !== undefined)) {
      this.warnings.push(raceConditionWarning(race.id));
    }

    // An XOR merge: exactly one branch of a race ever runs.
    const join =
      this.cleanForkJoin(race.id, outs, 'exclusiveGateway') ??
      this.recoveredForkJoin(race.id, outs, 'exclusiveGateway');

    lines.push('await {');
    for (const wait of waits) {
      const { el, body } = wait!;
      this.emittedNodes.add(el.id);
      const branchLines: string[] = [];
      if (body !== undefined) {
        // The wait leads straight into its body with nothing written between
        // them, so the edge goes the way a fall-through does.
        this.consume(body);
        this.emitBranch(body.targetRef, join, branchLines, depth);
      }
      const head = `${renderTriggerHead(el.eventDefinition)}${attrBlock(settingsMembers(el))}`;
      lines.push(`${INDENT}${head} {`);
      for (const l of branchLines) lines.push(INDENT + l);
      lines.push(INDENT + '}');
    }
    lines.push('}');

    return join === undefined ? STOP : this.continueAt(join, stop, lines);
  }

  /**
   * The wait a race branch opens on and the edge into its body, or `undefined`
   * when the branch is not a wait the block form can hold: an already-printed
   * one would be printed twice, and one that routes on has no single body.
   * Reads only, so a sibling branch missing costs nothing.
   */
  private raceWait(target: string): RaceWait | undefined {
    const el = this.byId.get(target);
    if (el?.kind !== 'intermediateCatchEvent') return undefined;
    if (this.emittedNodes.has(el.id)) return undefined;
    const outs = this.unconsumedOut(el.id);
    if (outs.length > 1) return undefined;
    return outs[0] === undefined ? { el } : { el, body: outs[0] };
  }

  /**
   * Marks a route printed as plain flow, one statement leading to the next
   * with nothing written between them, and reports a condition on it: there is
   * no place between the two statements to write one. Every route the script
   * writes that way goes through here, so the report cannot be forgotten at one
   * of them.
   */
  private consume(flow: SequenceFlow): void {
    this.consumedFlows.add(flow.id);
    if (flow.conditionExpression === undefined) return;
    const warning = this.droppedConditionWarning(flow);
    if (warning !== undefined) this.warnings.push(warning);
  }

  /** The single route on from a position, taken as the fall-through. */
  private takeFallThrough(
    flow: SequenceFlow,
    stop: string | undefined,
    lines: string[],
  ): string | typeof STOP {
    this.consume(flow);
    return this.continueAt(flow.targetRef, stop, lines);
  }

  /**
   * The report a dropped condition takes, which turns on what reads it. A fork
   * that opens every route and a wait that takes the first to resolve both
   * weigh it nowhere, so the run is the same without it; everywhere else the
   * engine reads it and the run is not.
   *
   * The route a split names as its fallback is neither: a fork keeps it out of
   * the routes it weighs, and a choice carrying a condition there is refused at
   * deployment, so the drop reads as the fallback it is.
   *
   * A route beside a fallback the split weighs nothing on is neither again: the
   * model has that fallback left to leave by, so the drop reads as a divergence
   * rather than as the failure a route without one takes.
   */
  private droppedConditionWarning(
    flow: SequenceFlow,
  ): PrintWarning | undefined {
    const sourceId = flow.sourceRef;
    const kind = this.byId.get(sourceId)?.kind;
    if (flow.id === this.splitFallbackFlowId(sourceId)) {
      return kind === 'inclusiveGateway'
        ? forkFallbackConditionWarning(sourceId)
        : undefined;
    }
    switch (kind) {
      case 'parallelGateway':
        return unweighedBranchWarning(sourceId);
      case 'eventBasedGateway':
        return raceConditionWarning(sourceId);
      default: {
        // A fallback the split weighs is a different shape, reported on the
        // split in its own right, so only a plain one answers here.
        const fallback = this.splitFallbackFlow(sourceId);
        return fallback !== undefined &&
          fallback.conditionExpression === undefined
          ? divertedRunWarning(sourceId)
          : droppedFlowConditionWarning(sourceId);
      }
    }
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
    if (real !== undefined) {
      lines.push(`goto ${real}`);
      return;
    }
    lines.push(droppedEdgeMarker(target));
    this.warnings.push(droppedEdgeWarning(target));
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
   * or a node the emitter drops on print. An unknown id is named verbatim,
   * being a dangling IR reference.
   */
  private forwardToRealTarget(
    target: string,
    seen: Set<string>,
  ): string | undefined {
    const el = this.byId.get(target);
    if (el === undefined) return target;
    if (!isGateway(el)) {
      return isElidedOnPrint(el) ? undefined : target;
    }
    if (seen.has(target)) return undefined;
    seen.add(target);
    const outs = this.outgoingBySource.get(target) ?? [];
    const unconsumed = this.unconsumed(outs);
    let forward: SequenceFlow | undefined;
    if (unconsumed.length === 1) forward = unconsumed[0];
    else if (outs.length === 1) forward = outs[0];
    if (forward === undefined) return undefined;
    return this.forwardToRealTarget(forward.targetRef, seen);
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
      case 'inclusiveGateway':
      case 'eventBasedGateway':
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

/** The two kinds a `parallel` block prints: one weighs its branches, one takes them all. */
type ForkGateway = Extract<
  FlowElement,
  { kind: 'parallelGateway' | 'inclusiveGateway' }
>;

/** One branch of a race: the wait it opens on, and the edge into its body. */
interface RaceWait {
  el: Extract<FlowElement, { kind: 'intermediateCatchEvent' }>;
  body?: SequenceFlow;
}

/**
 * Printed where an edge the emitter can neither name nor place would have gone,
 * instead of fabricating a target. It stays in the source as the reader's
 * pointer at the place needing repair; the warning below is the report.
 */
export const UNSTRUCTURED_MARKER =
  '// unstructured region: hand-repair required';

function droppedEdgeMarker(target: string): string {
  return `${UNSTRUCTURED_MARKER} (dropped edge into ${target})`;
}

function droppedEdgeWarning(target: string): PrintWarning {
  return {
    elementId: target,
    category: 'droppedEdge',
    message:
      'The script has an unstructured region: a route the model takes has no ' +
      'form here and was left out. The marker comment where it belonged ' +
      'names the step it led to and is where hand-repair starts.',
  };
}

/**
 * A split whose branches the catalog cannot fold keeps its edges as jumps,
 * which carry the routes and lose everything the split said about them. A jump
 * leaves no marker behind, so this is the only report of it. An edge with no
 * name to jump to takes the marker {@link droppedEdgeWarning} reports instead,
 * which is why this one counts no branches.
 */
function degradedSplitWarning(splitId: string): PrintWarning {
  return {
    elementId: splitId,
    category: 'degradedSplit',
    message:
      'The branches leaving this split have no form in the script, so a ' +
      'branch leaves as a jump, or as a marker where it opens on something ' +
      'the script cannot name. The split is lost with them, along with any ' +
      'condition weighing a branch and any wait opening one, and a jump ends ' +
      'the path it sits on, so at most one branch is left running. What they ' +
      'leave behind is where hand-repair starts.',
  };
}

function inventedFallbackWarning(forkId: string): PrintWarning {
  return {
    elementId: forkId,
    category: 'defaultFlow',
    message:
      'Every branch of this split runs under a condition and the model names ' +
      'no fallback, so the run it describes fails here when none of them ' +
      'holds. The script has no form for that failure and carries on past ' +
      'the branches instead, so what runs changes. Check that carrying on is ' +
      'what was meant.',
  };
}

/**
 * The same fall-through at a step, whose own routes split. BPMN lets a step
 * name the route to take when none of its conditions holds and the IR carries
 * that name on a split alone, so this says what the script does and leaves out
 * what the model named. The import reports the name it dropped where there was
 * one.
 */
function inventedStepFallbackWarning(nodeId: string): PrintWarning {
  return {
    elementId: nodeId,
    category: 'defaultFlow',
    message:
      'Every route leaving this step runs under a condition, and the script ' +
      'carries on past them when none of them holds, which hands the step a ' +
      'way on that its conditions do not give it. A step in the model can ' +
      'name the route to take there, and this tool carries a fallback on a ' +
      'split alone, so what the model named is not visible here. Check that ' +
      'carrying on is what was meant.',
  };
}

function raceConditionWarning(raceId: string): PrintWarning {
  return {
    elementId: raceId,
    category: 'droppedCondition',
    message:
      'The model weighs a branch of this wait with a condition, which the ' +
      'script leaves out. A wait opens every branch at once and takes the ' +
      'first to resolve, so the condition is weighed nowhere and the run is ' +
      'the same without it. Check that the condition was not meant to weigh ' +
      'a branch of a split instead.',
  };
}

/**
 * A step whose own routes split. The script has one way on from a step, so the
 * routes print as an `if` chain, which is a choice; the model runs every route
 * it can.
 */
function implicitSplitWarning(nodeId: string): PrintWarning {
  return {
    elementId: nodeId,
    category: 'degradedSplit',
    message:
      'This step leaves on more than one route, and the model takes every ' +
      'route it can at once. A step in the script has one way on from it, so ' +
      'the routes print as a choice, which takes one of them. Check that ' +
      'taking one is what was meant, and draw the routes as a split of their ' +
      'own if it was not.',
  };
}

/**
 * A condition the engine weighs, on a route the script writes as the plain
 * step-to-step fall-through. Unlike the conditions a wait or an unweighing
 * fork carries, this one changes what runs when it is left out, which is why
 * it reads nothing like {@link raceConditionWarning}.
 */
function droppedFlowConditionWarning(sourceId: string): PrintWarning {
  return {
    elementId: sourceId,
    category: 'droppedCondition',
    message:
      'The model weighs the route on from here with a condition, which the ' +
      'script leaves out: one step leads straight to the next, and there is ' +
      'no place between them to write a condition. The engine reads that ' +
      'condition and takes the route only when it holds, so where the model ' +
      'has nothing left to take and stops the run with an error, the script ' +
      'carries straight on. Check that the condition was not meant to weigh ' +
      'a branch of a split.',
  };
}

/**
 * The same condition on a route out of a split that names the route to take
 * when none of its conditions holds. The engine takes no route it weighs
 * false, and here it has the fallback left, so the model routes on where
 * {@link droppedFlowConditionWarning} says it fails. It takes a route the
 * script does not, with nothing raised to mark the difference.
 */
function divertedRunWarning(splitId: string): PrintWarning {
  return {
    elementId: splitId,
    category: 'droppedCondition',
    message:
      'The model weighs the route on from this split with a condition, which ' +
      'the script leaves out: one step leads straight to the next, and there ' +
      'is no place between them to write a condition. The engine reads that ' +
      'condition and takes the route only when it holds. The split names the ' +
      'route to take when nothing holds, so the model leaves by another ' +
      'route rather than stopping, while the script carries straight on down ' +
      'this one. Nothing fails here: what differs is the route the run ' +
      'takes, not whether it runs. Check that taking this route whatever the ' +
      'condition says is what was meant.',
  };
}

function unweighedBranchWarning(forkId: string): PrintWarning {
  return {
    elementId: forkId,
    category: 'droppedCondition',
    message:
      'The model weighs a route leaving this split with a condition, which ' +
      'the script leaves out. A split of this kind takes every route ' +
      'whatever the conditions say, so the condition is weighed nowhere and ' +
      'the run is the same without it. Writing it would read back as the ' +
      'split that does weigh its branches, so it is left out. Check that ' +
      'the condition was not meant to weigh a branch of that split instead.',
  };
}

/**
 * A condition on the fallback of a fork that opens every branch whose condition
 * holds. It takes the fallback only when it took no branch, and reads no
 * condition on the fallback while choosing, so the condition changes nothing.
 */
function forkFallbackConditionWarning(forkId: string): PrintWarning {
  return {
    elementId: forkId,
    category: 'defaultFlow',
    message:
      'The model weighs the fallback of this split with a condition, which ' +
      'the script leaves out. A fallback runs when no other branch does, ' +
      'whatever its condition says, so the run is the same without it. Check ' +
      'that the condition was not meant to weigh a branch of its own.',
  };
}

/**
 * The same condition on the fallback of a choice, which takes one route and
 * weighs the fallback among the others rather than holding it back. A model
 * carrying one there is refused at deployment, so where
 * {@link forkFallbackConditionWarning} reports a condition that changes
 * nothing, this reports a model that never gets to run.
 */
function choiceFallbackConditionWarning(splitId: string): PrintWarning {
  return {
    elementId: splitId,
    category: 'defaultFlow',
    message:
      'The model weighs the fallback of this split with a condition, which ' +
      'the script leaves out. A split of this kind takes one route, and the ' +
      'engine refuses to deploy one whose fallback is weighed. The model as ' +
      'drawn does not run, while the script without the condition deploys ' +
      'and runs. Check that the condition was not meant to weigh a branch of ' +
      'its own.',
  };
}

function deadFallbackWarning(forkId: string): PrintWarning {
  return {
    elementId: forkId,
    category: 'defaultFlow',
    message:
      'This split names a fallback, and a branch beside it runs whatever the ' +
      'conditions do, so nothing is ever left over for the fallback to take. ' +
      "The script writes it out as an 'else' all the same, which draws an " +
      'error when the source is read back. Put a condition on the branches ' +
      'beside it, or drop the fallback.',
  };
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
    case 'inclusiveGateway':
    case 'eventBasedGateway':
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
 * {@link isElidedOnPrint} and the renderers read this one answer: a reason to
 * print reaching one but not the other would leave a jump naming a statement
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
 * to the throw prefix as well, because `throw` lowers to an end event.
 */
function isSynthesizedTerminalId(
  id: string,
  kind: FlowElement['kind'],
): boolean {
  switch (kind) {
    case 'startEvent':
      return id.startsWith(START_EVENT_PREFIX);
    case 'endEvent':
      return (
        id.startsWith(END_EVENT_PREFIX) || id.startsWith(THROW_EVENT_PREFIX)
      );
    case 'intermediateThrowEvent':
      return id.startsWith(THROW_EVENT_PREFIX);
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

/** The vocabulary's table, narrowed so a new IR timer kind without a word fails to compile. */
const TIMER_PARTICLE: Record<
  Extract<EventDefinition, { kind: 'timer' }>['timerKind'],
  string
> = TIMER_PARTICLE_BY_KIND;

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

/**
 * A `var` line per collection a printed clause names bare, in first-appearance
 * order. Operaton reads a bare `operaton:collection` as the name of a process
 * variable, so a program that iterates one without declaring it reads a
 * variable it never declares; a quoted name and a `${...}` body print as
 * strings and name nothing. The type is `any` because a repetition says a
 * variable is iterated and nothing more. A form field or a catch binding of the
 * same name types it already, and every declaration of one name has to agree on
 * the type, so a second line would be an error rather than a duplicate.
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
