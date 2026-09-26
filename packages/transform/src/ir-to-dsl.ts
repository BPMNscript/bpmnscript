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
  CALL_MAPPER_KEY_BY_KIND,
  DATE_PATTERN_KEY,
  END_TRIGGERS,
  EXPRESSION_OPEN,
  EXTERNAL_TASK_EL_NAME,
  isReservedName,
  joinSettingKey,
  LOOP_VARIABLES,
  runSettingKey,
  TIMER_PARTICLE_BY_KIND,
  TYPE_BINDING_KEY,
} from '@bpmn-script/language';
import type {
  BpmnProcess,
  CallVariableMapping,
  CodeBinding,
  EndEventDefinition,
  EngineAttributes,
  ErrorMapping,
  EventDefinition,
  ExtensionProperty,
  FlowContainer,
  FlowElement,
  FormField,
  FormFieldConstraint,
  FormFieldType,
  FormFieldValue,
  Gateway,
  IoMapped,
  IoValue,
  JobSettings,
  ListenerBinding,
  Named,
  Repeatable,
  SequenceFlow,
  ServiceTaskBinding,
  SettingsCarrier,
  VersionBinding,
} from './ir/types.js';
import {
  carriesFields,
  eventIdentities,
  gatewayDefaultFlowId,
  isGateway,
  repeats,
  splitTimerJobSettings,
} from './ir/types.js';
import {
  CATCH_EVENT_PREFIX,
  claimDeclarationName,
  ID_SHAPED,
  isMintedEndId,
  isMintedStartId,
  isWritableName,
  mintPrintableName,
  resolveCollision,
  THROW_EVENT_PREFIX,
} from './synthesize-ids.js';
import { analyzeCfg, type CfgAnalysis } from './cfg-analysis.js';
import {
  escapeQuoted,
  type JuelNode,
  parseJuel,
  renderRawFallback,
} from './juel.js';

/** Reused by `xml-to-ir.ts` to dedent a preview built by wrapping a fragment in a throwaway process. */
export const INDENT = '  ';

/**
 * The lines one construct prints on. A fenced body keeps its newlines inside a
 * single entry: the text between the fences is the script itself, and an
 * enclosing block indents whole entries, so splitting one would rewrite the
 * code it holds.
 */
type Lines = string[];

/**
 * The names one print writes: the name a raised code is written under, per
 * kind ({@link codeDeclarations}), and the name an id the script cannot spell
 * prints as ({@link printedNames}).
 */
interface PrintNames {
  error: Map<string, string>;
  escalation: Map<string, string>;
  /** Only the ids that print under another name; every other id prints as itself. */
  printed: ReadonlyMap<string, string>;
}

/** The name `id` prints under, at every site that writes an element or process id. */
function nameOf(names: PrintNames, id: string): string {
  return names.printed.get(id) ?? id;
}

/**
 * What the start and end predicates read of a container: its id, which seeds
 * the minted terminals, and its elements, for the boundaries whose escape
 * chains end in a minted end and for the first plain start.
 */
export type PrintContainer = Pick<FlowContainer, 'id' | 'flowElements'>;

export type PrintWarningCategory =
  | 'label'
  | 'documentation'
  | 'droppedEdge'
  | 'defaultFlow'
  | 'degradedSplit'
  | 'droppedCondition'
  | 'refusedStatement'
  | 'renamedId'
  | 'droppedSetting';

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
  const codes = codeDeclarations(process);
  const names: PrintNames = {
    ...codes.names,
    printed: printedNames(process, warnings),
  };
  warnGatewayText(process, warnings);
  warnRefusedStatements(process, names, warnings);

  const emitter = new Emitter(process, warnings, names);
  const body = emitter.emit();

  const declarations = [
    ...codes.lines.map((line) => INDENT + line),
    ...variableDecls(process),
  ];

  const header = buildProcessHeader(process, names);
  const lines = [header, ...declarations, ...body.map((l) => INDENT + l), '}'];
  return { source: lines.join('\n') + '\n', warnings };
}

/**
 * A split or a merge is derived from the block structure and has no statement
 * of its own, so the text on one is lost on the way out. Every other elided
 * label is reported by `xmlToIr`, which is why this covers gateways alone: a
 * wider rule would report the same drop twice to a caller printing both
 * channels. A label and documentation are reported apart, one warning per
 * fact, so a caller sorting by category sees each of them once.
 */
function warnGatewayText(
  container: FlowContainer,
  warnings: PrintWarning[],
): void {
  for (const el of container.flowElements) {
    // Keyed on the container shape, so a nested split is reached whatever
    // container it sits in.
    if ('flowElements' in el) {
      warnGatewayText(el, warnings);
      continue;
    }
    if (!isGateway(el)) continue;
    if (el.name !== undefined) {
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
    if (el.documentation !== undefined) {
      warnings.push({
        elementId: el.id,
        category: 'documentation',
        message:
          'The documentation written here was not written to the script: ' +
          'the script derives every split and every merge from its block ' +
          'structure, so there is no statement here to carry it. The ' +
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
 * The emitter reports a plain synthesized end printed for its position itself,
 * since only it knows that position.
 *
 * `suppressed` describes the container being walked, false at the top: a start
 * in the process body prints its own trigger.
 */
function warnRefusedStatements(
  container: FlowContainer,
  names: PrintNames,
  warnings: PrintWarning[],
  suppressed = false,
): void {
  for (const el of container.flowElements) {
    if (
      !isElidedOnPrint(el, container, suppressed) &&
      isReservedName(nameOf(names, el.id), container.id)
    ) {
      warnings.push(reservedNameWarning(el.id));
    }
    if (el.kind === 'subProcess') {
      warnRefusedStatements(el, names, warnings, el.triggeredByEvent === true);
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
 * The name each id prints under where the script cannot spell the id itself:
 * the process id and every element that writes its id as a statement name or
 * a `goto` target. A gateway, a boundary and an event sub-process never write
 * theirs, so they keep it and draw no report. A minted name is resolved
 * against every id in the document and every name minted before it, since a
 * name written twice leaves every jump to it ambiguous.
 *
 * The rebuilt document carries the new id, and the engine keys history
 * (`HistoricActivityInstance.getActivityId`), migration plans
 * (`MigrationPlanBuilder.mapActivities`) and a modification
 * (`InstantiationBuilder.startBeforeActivity`) on the activity id, so the
 * report says the run is not the same.
 */
function printedNames(
  process: BpmnProcess,
  warnings: PrintWarning[],
): ReadonlyMap<string, string> {
  const ids = [process.id];
  const taken = new Set(ids);
  const collect = (container: FlowContainer): void => {
    for (const el of container.flowElements) {
      taken.add(el.id);
      if (!isGateway(el) && !isBoundary(el) && !isHandler(el)) ids.push(el.id);
      if (el.kind === 'subProcess') collect(el);
    }
  };
  collect(process);

  const printed = new Map<string, string>();
  for (const id of ids) {
    if (isWritableName(id)) continue;
    const name = resolveCollision(mintPrintableName(id), taken);
    taken.add(name);
    printed.set(id, name);
    warnings.push({
      elementId: id,
      category: 'renamedId',
      message:
        'The id this element carries in the model is not a name the script ' +
        "can spell (letters, digits and '_', a '-' between them, and no " +
        `keyword), so it is written as '${name}'. The document built from ` +
        'the script carries that id in its place, and the engine matches ' +
        'history, migration plans and a start-before-activity on the ' +
        'activity id, so what runs is not the same. Rename it in the ' +
        'model to keep the id.',
    });
  }
  return printed;
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
  /** The gateways whose job settings a statement head has printed. */
  private readonly settingsTaken = new Set<string>();
  /**
   * The `await`/`parallel` branch each statement was printed in, as the path
   * of branch ids from the outermost block down, and `''` outside any. A jump
   * remembers the path it was printed under, and the two are compared once
   * the walk is done, since a jump can name a statement printed after it.
   */
  private readonly branchOf = new Map<string, string>();
  private branchPath = '';
  private readonly jumps: { target: string; branchPath: string }[] = [];
  private readonly deferredEnds: {
    lines: string[];
    index: number;
    stmt: Lines;
    id: string;
  }[] = [];

  constructor(
    private readonly container: FlowContainer,
    /** Shared with every nested container, so one process yields one report. */
    private readonly warnings: PrintWarning[],
    /** The header's declarations and the printed names, which every use site in the body writes. */
    private readonly names: PrintNames,
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

    // 1. Structured emission from each start event. An elided start is
    // re-derived by the compiler only at the head of a body that opens with
    // no `start`, so its chain is walked first and alone; anywhere else it
    // lands after another chain's `end` as a dangling `goto` and the compiler
    // re-derives no start for it.
    for (const el of this.container.flowElements) {
      if (
        el.kind === 'startEvent' &&
        isElidedOnPrint(el, this.container, this.startTriggerSuppressed) &&
        !this.emittedNodes.has(el.id)
      ) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }
    for (const el of this.container.flowElements) {
      if (el.kind === 'startEvent' && !this.emittedNodes.has(el.id)) {
        this.emitStartGroup(el, lines);
      }
    }

    // 2. Boundary handlers, held back because the surface requires a handler
    //    block to follow the body it guards. Each block is kept under its
    //    element's index so pass 5 can place it among the event sub-processes
    //    the way the model orders them.
    const boundaryBlocks = new Map<number, string[]>();
    this.container.flowElements.forEach((el, index) => {
      if (isBoundary(el) && !this.emittedNodes.has(el.id)) {
        const block: string[] = [];
        this.emitBoundaryHandler(el, block, 0);
        boundaryBlocks.set(index, block);
      }
    });

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

    // A plain synthesized end stays out only at its block's tail, the one
    // position the compiler re-derives it at, and whether a flow statement
    // followed it is known only now. The boundary blocks and handlers appended
    // below are lowered out of chain, so they do not count as one. Reverse
    // order keeps every lower index valid while splicing. A boundary body is
    // one chain in its own array, so its end is always that array's tail.
    const printedEnds: string[] = [];
    for (const d of this.deferredEnds.toReversed()) {
      if (d.index >= d.lines.length) continue;
      d.lines.splice(d.index, 0, ...d.stmt);
      printedEnds.unshift(d.id);
    }
    for (const id of printedEnds) this.warnings.push(reservedNameWarning(id));

    // 5. Trailing handler group, in model order: the compiler lays handlers
    //    down in statement order and numbers an event sub-process by its
    //    statement index, so any other order renumbers it on the next compile.
    this.container.flowElements.forEach((el, index) => {
      const block = boundaryBlocks.get(index);
      if (block !== undefined) lines.push(...block);
      if (isHandler(el) && !this.emittedNodes.has(el.id)) {
        this.emitHandler(el, lines);
      }
    });

    // Swept once the walk is done rather than reported where a construct gives
    // up: an elided pass-through and a jump forwarded through a gateway leave
    // no degradation site, and a merge left behind by one statement can still
    // open the next.
    for (const el of this.container.flowElements) {
      if (
        isGateway(el) &&
        !this.settingsTaken.has(el.id) &&
        jobSettingItems(el).length > 0
      ) {
        this.warnings.push(droppedSettingWarning(el.id));
      }
    }

    // The validator refuses a `goto` into a branch of an `await` or `parallel`
    // block unless the jump sits inside that branch, however deep, which is
    // what the path prefix asks.
    for (const { target, branchPath } of this.jumps) {
      const inside = this.branchOf.get(target);
      if (
        inside !== undefined &&
        inside !== '' &&
        !`${branchPath}/`.startsWith(`${inside}/`)
      ) {
        this.warnings.push(crossBranchJumpWarning(target));
      }
    }

    return lines;
  }

  /**
   * Every unprinted start leaving for the same step as `start` prints with
   * it, back to back, and that step's chain is walked once under them: starts
   * written back to back all enter the statement after them. Walked one at a
   * time, the second start would find the step printed and jump onto it,
   * which a jump cannot do for an elided end, and a `start` after the first
   * chain would leave that chain's elided end off its block's tail. A start
   * leaving on several routes is a split of its own and prints as one.
   */
  private emitStartGroup(
    start: Extract<FlowElement, { kind: 'startEvent' }>,
    lines: string[],
  ): void {
    const route = this.soleRoute(start.id);
    if (route === undefined) {
      this.emitFrom(start.id, undefined, lines, 0);
      return;
    }
    for (const el of this.container.flowElements) {
      if (el.kind !== 'startEvent' || this.emittedNodes.has(el.id)) continue;
      const own = this.soleRoute(el.id);
      if (own === undefined || own.targetRef !== route.targetRef) continue;
      this.emittedNodes.add(el.id);
      this.branchOf.set(el.id, this.branchPath);
      lines.push(
        ...renderStartEvent(el, this.startTriggerSuppressed, this.names),
      );
      this.consume(own);
    }
    this.emitFrom(route.targetRef, undefined, lines, 0);
  }

  /** The one route the model gives a node, or `undefined` where it splits or ends. */
  private soleRoute(id: string): SequenceFlow | undefined {
    const outs = this.outgoingBySource.get(id) ?? [];
    return outs.length === 1 ? outs[0] : undefined;
  }

  /**
   * Nothing for a step, or for a gateway a head has already taken: a loop
   * hands its leftover routes to the choice chain under its own id.
   */
  private takeHeadSettings(id: string): string[] {
    const el = this.byId.get(id);
    if (el === undefined || !isGateway(el) || this.settingsTaken.has(id)) {
      return [];
    }
    this.settingsTaken.add(id);
    return jobSettingItems(el);
  }

  /**
   * Taken only while the merge is an unprinted gateway with one route out,
   * the shape the compiler synthesizes and the printed keys land on again. A
   * merge with a second route is a statement of its own and keeps its
   * settings for that head; one already printed carries them nowhere, and
   * the sweep reports it. Counted over the model's routes, not the unprinted
   * ones: an enclosing loop spends the back-edge a merge at its body's tail
   * leaves by before the body is walked, and that merge is still the
   * pass-through it elides.
   */
  private takeJoinSettings(join: string | undefined): string[] {
    if (join === undefined) return [];
    const el = this.byId.get(join);
    if (
      el === undefined ||
      !isGateway(el) ||
      this.emittedNodes.has(join) ||
      this.settingsTaken.has(join) ||
      (this.outgoingBySource.get(join) ?? []).length !== 1
    ) {
      return [];
    }
    this.settingsTaken.add(join);
    return jobSettingItems(el, joinSettingKey);
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
    lines.push(...buildOnHeader(handler, this.names));
    for (const l of new Emitter(
      handler,
      this.warnings,
      this.names,
      true,
    ).emit())
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
    lines.push(...buildBoundaryHeader(boundary, this.names));
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
    this.branchOf.set(id, this.branchPath);

    // A do-while body entry is reached before its loop gateway, so it has to be
    // recognized here or the body prints ahead of the loop and degrades.
    const doWhile = this.tryDoWhileEntry(id, stop, lines, depth);
    if (doWhile !== undefined) return doWhile;

    // Read off the model's routes: a construct hands its leftover routes down
    // as an empty list without the gateway being empty.
    if (isGateway(el) && (this.outgoingBySource.get(id) ?? []).length === 0) {
      this.emittedNodes.add(id);
      this.warnings.push(emptySplitWarning(el.kind, id));
      return STOP;
    }

    // A gateway has no statement form to jump from, so it cannot rely on the
    // final sweep: every out-edge is captured here, by a construct or a goto.
    if (el.kind === 'exclusiveGateway') {
      // Recognized before the if-chain so it is not mistaken for an XOR split.
      const loop = this.tryWhile(el, stop, lines, depth);
      if (loop !== undefined) return loop;
      return this.emitChoice(el.id, stop, lines, depth);
    }
    if (el.kind === 'parallelGateway' || el.kind === 'inclusiveGateway') {
      return this.emitFork(el.id, el.kind, stop, lines, depth);
    }
    if (el.kind === 'eventBasedGateway') {
      return this.emitRaceGateway(el, stop, lines, depth);
    }

    // A fenced body is opaque multi-line text, so it prints as a line group.
    if (el.kind === 'scriptTask') {
      this.emittedNodes.add(id);
      lines.push(...renderScriptTask(el, this.names));
      return this.followLinear(id, stop, lines, depth);
    }

    if (el.kind === 'subProcess') {
      // An event sub-process prints in the trailing handler pass and is
      // entered by its trigger alone; the import refuses a flow into one, so
      // reaching it here is malformed IR, as a duplicate id is.
      if (el.triggeredByEvent === true) {
        throw new Error(
          `irToDsl: event sub-process '${id}' in container '${this.container.id}' is reached through a flow edge; a handler is entered by its trigger alone.`,
        );
      }
      this.emittedNodes.add(id);
      const head = el.element === 'transaction' ? 'attempt' : 'subprocess';
      lines.push(
        ...bodyHeader(
          `${head} ${nameOf(this.names, id)}${repeatClause(el)}`,
          [...namedSettings(el), ...engineSettings(el)],
          structuredMembers(el),
        ),
      );
      for (const l of new Emitter(el, this.warnings, this.names).emit())
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
    if (
      stmt !== undefined &&
      el.kind === 'endEvent' &&
      el.eventDefinition === undefined &&
      isElidedOnPrint(el, this.container)
    ) {
      // The compiler never mints a synthesized end inside a branch or loop
      // body, whose exit it wires to the join or loop head, so one there
      // always prints; a top-level one is settled in `emit`.
      if (depth > 0) {
        lines.push(...stmt);
        this.warnings.push(reservedNameWarning(id));
      } else {
        this.deferredEnds.push({ lines, index: lines.length, stmt, id });
      }
    } else if (stmt !== undefined) {
      lines.push(...stmt);
    }
    return this.followLinear(id, stop, lines, depth);
  }

  /**
   * The routes leaving a statement. One is the fall-through the next statement
   * takes. More than one is a fork with the statement as its split:
   * `BpmnActivityBehavior.performOutgoingBehavior` leaves by every route whose
   * condition holds or that carries none and by the `default` alone when none
   * was taken, which is the inclusive fork's rule, and with nothing weighed
   * and no fallback it is the parallel fork's. One weighed route beside the
   * fallback is the shape a choice routes the same way, and keeps the
   * `if`/`else` the choice prints.
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
    if (outs.length <= 1) return this.emitChoice(id, stop, lines, depth);
    const fallbackId = this.splitFallbackFlowId(id);
    const weighed = outs.filter(
      (f) => f.id !== fallbackId && f.conditionExpression !== undefined,
    );
    if (outs.length === 2 && fallbackId !== undefined && weighed.length === 1) {
      return this.emitChoice(id, stop, lines, depth);
    }
    const kind =
      weighed.length > 0 || fallbackId !== undefined
        ? 'inclusiveGateway'
        : 'parallelGateway';
    return this.emitFork(id, kind, stop, lines, depth);
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
    // holds, and the engine refuses the model at deployment for carrying one;
    // a step skips its fallback while weighing and takes it when nothing held,
    // so there the condition is weighed nowhere. Asked of the routes the model
    // gives the split, ahead of the two shapes below that print without a
    // chain.
    this.warnFallbackCondition(splitId);

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      // One route on: the fall-through, or a degenerate single-out gateway.
      return this.takeFallThrough(outs[0]!, stop, lines);
    }

    const { fallback, conditioned, unconditioned } = this.weighRoutes(
      splitId,
      outs,
    );
    this.warnInventedFallback(splitId);

    const join =
      this.cleanJoin(splitId, outs, stop) ??
      this.convergence(splitId, outs, stop) ??
      this.guardClauseContinuation(unconditioned) ??
      this.enclosingContinuation(splitId, outs, stop);

    for (const f of outs) this.consumedFlows.add(f.id);
    this.emitIfChain(
      conditioned,
      unconditioned,
      fallback,
      join,
      splitId,
      [...this.takeHeadSettings(splitId), ...this.takeJoinSettings(join)],
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
    settings: string[],
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
      lines.push(
        i === 0
          ? `if (${condition})${headSettings(settings)} {`
          : `} else if (${condition}) {`,
      );
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
   * The routes of a split sorted the way the chain and the fork block read
   * them. The fallback is the `else` whatever else it carries: heading its
   * branch with the condition would put the branch on a run of its own and
   * leave the split with nowhere to go when nothing holds. Desugared IR has at
   * most one unconditioned flow; imported IR may carry more.
   */
  private weighRoutes(
    splitId: string,
    outs: SequenceFlow[],
  ): {
    fallback: SequenceFlow | undefined;
    conditioned: SequenceFlow[];
    unconditioned: SequenceFlow[];
  } {
    const fallbackId = this.splitFallbackFlowId(splitId);
    const fallback = outs.find((f) => f.id === fallbackId);
    return {
      fallback,
      conditioned: outs.filter(
        (f) => f !== fallback && f.conditionExpression !== undefined,
      ),
      unconditioned: outs.filter(
        (f) => f === fallback || f.conditionExpression === undefined,
      ),
    };
  }

  /**
   * A fork or a race the catalog cannot fold, every route leaving as a jump
   * under the condition it carried. Each jump takes a branch of its own because
   * a jump ends its block, so a second one written beside the first could never
   * run. The chain keeps the conditions and loses the split's kind, which the
   * marker names and {@link degradedSplitWarning} reports; the settings go
   * with it, which the sweep reports.
   */
  private emitJumps(
    splitId: string,
    kind: Gateway['kind'],
    outs: SequenceFlow[],
    lines: string[],
    depth: number,
  ): void {
    lines.push(degradedSplitMarker(splitId, kind));
    const { fallback, conditioned, unconditioned } = this.weighRoutes(
      splitId,
      outs,
    );
    this.emitIfChain(
      conditioned,
      unconditioned,
      fallback,
      undefined,
      splitId,
      [],
      lines,
      depth,
    );
  }

  /**
   * The checks below establish that the branch region belongs to this gateway
   * and re-enters at the join. `undefined` means the gateway is unstructured.
   *
   * A join past `stop` is refused: inside a loop body the body dominates
   * everything after the loop, so a split whose routes leave the loop and
   * reconverge behind it would pass the dominance checks, walk the staying
   * route past the printed loop head and drop the back edge.
   */
  private cleanJoin(
    splitId: string,
    outs: SequenceFlow[],
    stop: string | undefined,
  ): string | undefined {
    const join = this.cfg.immediatePostDominator(splitId);
    if (join === undefined || !this.byId.has(join)) return undefined;
    if (stop !== undefined && !this.cfg.postDominates(stop, join)) {
      return undefined;
    }
    if (!this.cfg.postDominates(join, splitId)) return undefined;
    if (!this.cfg.dominates(splitId, join)) return undefined;
    for (const f of outs) {
      if (f.targetRef === join) continue;
      if (!this.cfg.dominates(splitId, f.targetRef)) return undefined;
    }
    return join;
  }

  /**
   * Where the routes come back together when the post-dominator queries
   * cannot say: the nearest node every live route reaches, read off the
   * model's routes and bounded by `stop`. A branch that can end puts the
   * split's post-dominator at the exit, and a step that loops on itself
   * leaves the container with no post-dominators at all, so the clean join
   * and the survivors' chains both miss a merge the routes plainly share, and
   * a branch walked past it prints the continuation inside the block.
   *
   * A route straight into a sink is a branch that ends and never counts. Of
   * the rest, a route is live when it reaches `stop` or a node another route
   * reaches; where none does, every one is. Among the nodes the live routes
   * share, in the first one's breadth order: a merge, a gateway with one
   * route out, ahead of a step on the way to it, since the compiler lowers
   * every block with a merge and a step ahead of it belongs to the branch;
   * then `stop`; then the nearest, except for a lone live route heading a
   * branch with its condition, whose whole chain is that branch and which
   * continues where the chain ends. `joinKind` narrows the answer to a merge
   * of that kind the split dominates, the only node a fork or a race
   * synchronizes at: a merge entered from outside the block as well would
   * synchronize that entry too once the block's own join stands for it.
   */
  private convergence(
    splitId: string,
    outs: readonly SequenceFlow[],
    stop: string | undefined,
    joinKind?: Gateway['kind'],
  ): string | undefined {
    const routes = outs
      .filter((f) => (this.outgoingBySource.get(f.targetRef) ?? []).length > 0)
      .map((f) => ({ f, reach: this.reachable(f.targetRef, splitId, stop) }));
    const shares = ({ reach }: (typeof routes)[number]): boolean =>
      [...reach].some(
        (n) =>
          n === stop || routes.some((r) => r.reach !== reach && r.reach.has(n)),
      );
    const live = routes.some(shares) ? routes.filter(shares) : routes;
    if (live.length === 0) return undefined;
    const shared = [...live[0]!.reach].filter((n) =>
      live.every((r) => r.reach.has(n)),
    );
    const isMerge = (n: string): boolean => {
      const el = this.byId.get(n);
      return (
        el !== undefined &&
        isGateway(el) &&
        (this.outgoingBySource.get(n) ?? []).length === 1 &&
        (joinKind === undefined ||
          (el.kind === joinKind && this.cfg.dominates(splitId, n)))
      );
    };
    const merge = shared.find(isMerge);
    if (joinKind !== undefined) return merge;
    if (merge !== undefined) return merge;
    if (stop !== undefined && shared.includes(stop)) return stop;
    const [only] = live;
    const weighed =
      live.length === 1 &&
      only!.f.conditionExpression !== undefined &&
      only!.f.id !== this.splitFallbackFlowId(splitId);
    return weighed ? shared.at(-1) : shared[0];
  }

  /**
   * The nodes a walk from `from` can reach, in breadth order. `stop` is kept
   * and not crossed, and the split is left out: a path back through it runs
   * the routing again, which the block already stands for.
   */
  private reachable(
    from: string,
    splitId: string,
    stop: string | undefined,
  ): Set<string> {
    const seen = new Set<string>();
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i]!;
      if (n === splitId || seen.has(n)) continue;
      seen.add(n);
      if (n === stop) continue;
      for (const f of this.outgoingBySource.get(n) ?? [])
        queue.push(f.targetRef);
    }
    return seen;
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
   * A split inside a loop body or a branch whose every route is conditioned:
   * a leaving route puts the split's immediate post-dominator outside the
   * region (the exit, or a node behind the loop when the leaving route and the
   * loop exit share an end), so there is no clean join, and with no
   * unconditioned route no guard clause, yet the routes that stay inside run
   * into `stop`, which is the continuation. Only the leaving routes print as
   * jumps; as jumps throughout, the staying route's steps would be hoisted
   * out of the loop and their edge into its folded head dropped.
   *
   * A route straight into `stop` counts as staying (`postDominates` is
   * reflexive) and prints as an empty branch.
   */
  private enclosingContinuation(
    splitId: string,
    outs: SequenceFlow[],
    stop: string | undefined,
  ): string | undefined {
    if (stop === undefined) return undefined;
    if (outs.some((f) => f.conditionExpression === undefined)) return undefined;
    const stays = outs.some(
      (f) =>
        this.cfg.dominates(splitId, f.targetRef) &&
        this.cfg.postDominates(stop, f.targetRef),
    );
    return stays ? stop : undefined;
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
   * Four shapes qualify: an ordinary body that re-merges, so `join`
   * post-dominates `entry`; a guard clause whose entry is a synthesized
   * terminal the split owns and that terminates before the join, which has no
   * continuation to relocate and prints the same statement in either scope;
   * a guard clause whose entry is a bare authored end that the split's route
   * reaches as its only incoming flow; and a guard clause whose entry is a
   * gateway the split owns, which a jump could not name anyway, and whose
   * routes the walk sorts with `join` as their stop node. An authored entry
   * with a chain of its own stays a `goto`, keeping that chain at its authored
   * scope so its coordinate-derived ids survive the round trip.
   */
  private branchStaysInRegion(
    entry: string,
    join: string,
    splitId: string,
  ): boolean {
    if (this.cfg.postDominates(join, entry)) return true;
    const el = this.byId.get(entry);
    if (
      el === undefined ||
      !this.cfg.dominates(splitId, entry) ||
      this.cfg.dominates(join, entry)
    ) {
      return false;
    }
    if (isGateway(el)) return true;
    if (isSynthesizedTerminalId(entry, el.kind, this.container)) return true;
    return el.kind === 'endEvent' && this.cfg.incoming(entry).length === 1;
  }

  /**
   * With no `join` the body runs to its own end, which is how a race with no
   * merge prints. `branch` is the id of the fork or race route this body
   * prints under; a loop body passes none and stays in its enclosing branch.
   */
  private emitBranch(
    entry: string,
    join: string | undefined,
    lines: string[],
    depth: number,
    branch?: string,
  ): void {
    const outer = this.branchPath;
    if (branch !== undefined) this.branchPath = `${outer}/${branch}`;
    const body: string[] = [];
    if (entry !== join) {
      this.emitFrom(entry, join, body, depth + 1);
    }
    for (const l of body) lines.push(INDENT + l);
    this.branchPath = outer;
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
    // two patterns never both fire. A route from the head back into itself is
    // no body: matched here it would print the exit route as the body.
    const backEdge = this.unconsumed(this.cfg.backEdges()).find(
      (f) =>
        f.targetRef === loop.id &&
        f.sourceRef !== loop.id &&
        f.conditionExpression === undefined,
    );
    if (backEdge === undefined) return undefined;

    const outs = this.unconsumedOut(loop.id);
    const cond = outs.find((f) => f.conditionExpression !== undefined);
    if (cond === undefined) return undefined;

    this.emittedNodes.add(loop.id);
    this.consumedFlows.add(cond.id);
    this.consumedFlows.add(backEdge.id);
    const rest = this.takeRest(outs);
    const settings = this.takeHeadSettings(loop.id);

    lines.push(`while (${renderCondition(cond)})${headSettings(settings)} {`);
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
      // A route back into the head itself has no body to run before the test.
      if (f.targetRef !== node || f.sourceRef === node) return false;
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
    const settings = this.takeHeadSettings(loopId);

    lines.push('do {');
    this.emitBranch(node, loopId, lines, depth);
    lines.push(`} while (${renderCondition(cond)})${headSettings(settings)}`);

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
   *
   * Keyed on the split's id and kind rather than on a gateway: a step whose
   * own routes split reaches the same block with the kind its routes give it,
   * and its head settings are none.
   */
  private emitFork(
    splitId: string,
    kind: ForkKind,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(splitId);
    const fork: Fork = {
      id: splitId,
      kind,
      fallbackId: this.splitFallbackFlowId(splitId),
    };
    this.warnFallbackCondition(splitId);
    const outs = this.unconsumedOut(splitId);

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      return this.takeFallThrough(outs[0]!, stop, lines);
    }

    const join =
      this.cleanForkJoin(splitId, outs, kind) ??
      this.convergence(splitId, outs, stop, kind) ??
      this.recoveredForkJoin(splitId, outs, kind);

    for (const f of outs) this.consumedFlows.add(f.id);

    if (join === undefined) {
      this.warnings.push(degradedSplitWarning(splitId));
      this.emitJumps(splitId, kind, outs, lines, depth);
      return STOP;
    }

    this.warnInventedFallback(splitId);
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
    const settings = [
      ...this.takeHeadSettings(splitId),
      ...this.takeJoinSettings(join),
    ];
    lines.push(`parallel${headSettings(settings)} {`);
    branches.forEach((f) => {
      // `emitBranch` prefixes one INDENT; wrap and re-indent for `parallel {`.
      const branchLines: string[] = [];
      this.emitBranch(f.targetRef, join, branchLines, depth, f.id);
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
  private branchHead(fork: Fork, flow: SequenceFlow): string {
    if (fork.kind !== 'inclusiveGateway') return '';
    if (flow.id === fork.fallbackId) return 'else ';
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
    fork: Fork,
    flow: SequenceFlow,
    join: string,
  ): boolean {
    return (
      fork.kind === 'inclusiveGateway' &&
      flow.id === fork.fallbackId &&
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
   */
  private warnInventedFallback(splitId: string): void {
    // A split that takes every route whatever the conditions say never runs out
    // of routes, so there is no failure here for a fall-through to paper over.
    if (this.byId.get(splitId)?.kind === 'parallelGateway') return;
    if (this.splitFallbackFlowId(splitId) !== undefined) return;
    const outs = this.outgoingBySource.get(splitId) ?? [];
    if (outs.some((f) => f.conditionExpression === undefined)) return;
    this.warnings.push(inventedFallbackWarning(splitId));
  }

  /**
   * The route a split takes when no condition holds, for one that names it:
   * the two split kinds that read a condition, and every step, whose `default`
   * `BpmnActivityBehavior.handleNoTransitions` takes.
   */
  private splitFallbackFlowId(splitId: string): string | undefined {
    const el = this.byId.get(splitId);
    if (el === undefined) return undefined;
    if (isGateway(el)) return gatewayDefaultFlowId(el);
    return 'defaultFlowId' in el ? el.defaultFlowId : undefined;
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
  private warnDeadFallback(fork: Fork, branches: SequenceFlow[]): void {
    if (fork.kind !== 'inclusiveGateway') return;
    const fallback = branches.find((f) => f.id === fork.fallbackId);
    if (fallback === undefined) return;
    const alwaysRuns = branches.some(
      (f) => f !== fallback && f.conditionExpression === undefined,
    );
    if (!alwaysRuns) return;
    this.warnings.push(deadFallbackWarning(fork.id));
  }

  /**
   * A condition on the fallback itself, reported once per split off the
   * model's routes, whatever the fallback ends up printed as: the `else` of a
   * chain or a block, the plain route on, or nothing. A choice weighs its
   * fallback among the others and the engine refuses to deploy one carrying a
   * condition there; a fork and a step skip it while weighing and take it when
   * nothing held, so the condition is weighed nowhere and the run is the same.
   */
  private warnFallbackCondition(splitId: string): void {
    if (this.splitFallbackFlow(splitId)?.conditionExpression === undefined) {
      return;
    }
    this.warnings.push(
      this.byId.get(splitId)?.kind === 'exclusiveGateway'
        ? choiceFallbackConditionWarning(splitId)
        : forkFallbackConditionWarning(splitId),
    );
  }

  /**
   * A condition on a branch of a fork that opens every branch. The engine
   * reads no condition here, and {@link branchHead} writes none, because a
   * condition written on a branch is what tells a fork that weighs its
   * branches from one that does not: printing it would read back as the other
   * fork. The condition is dropped there, and reported here.
   */
  private warnUnweighedBranchCondition(fork: Fork, outs: SequenceFlow[]): void {
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
    const join = this.cleanJoin(forkId, outs, undefined);
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
      this.emitJumps(race.id, race.kind, outs, lines, depth);
      return STOP;
    }

    // Below the degradation above, whose own report already covers the
    // conditions the jumps carry for the split it could not print.
    if (outs.some((f) => f.conditionExpression !== undefined)) {
      this.warnings.push(raceConditionWarning(race.id));
    }

    // An XOR merge: exactly one branch of a race ever runs.
    const join =
      this.cleanForkJoin(race.id, outs, 'exclusiveGateway') ??
      this.convergence(race.id, outs, stop, 'exclusiveGateway') ??
      this.recoveredForkJoin(race.id, outs, 'exclusiveGateway');

    const settings = [
      ...this.takeHeadSettings(race.id),
      ...this.takeJoinSettings(join),
    ];
    lines.push(`await${headSettings(settings)} {`);
    waits.forEach((wait, i) => {
      const { el, body } = wait!;
      this.emittedNodes.add(el.id);
      const branchLines: string[] = [];
      if (body !== undefined) {
        // The wait leads straight into its body with nothing written between
        // them, so the edge goes the way a fall-through does.
        this.consume(body);
        this.emitBranch(body.targetRef, join, branchLines, depth, outs[i]!.id);
      }
      const trigger = renderTrigger(el.eventDefinition, this.names);
      const head = bodyHeader(
        trigger.head,
        [...trigger.items, ...jobSettingItems(el)],
        structuredMembers(el),
      );
      for (const l of head) lines.push(INDENT + l);
      for (const l of branchLines) lines.push(INDENT + l);
      lines.push(INDENT + '}');
    });
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
   * The route a split names as its fallback is neither: the split's own report
   * ({@link warnFallbackCondition}) covers it however it prints.
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
    if (flow.id === this.splitFallbackFlowId(sourceId)) return undefined;
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
      lines.push(`goto ${nameOf(this.names, real)}`);
      this.jumps.push({ target: real, branchPath: this.branchPath });
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
      return isElidedOnPrint(el, this.container) ? undefined : target;
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

  /**
   * Omitted for a synthesized id: the forward compiler re-derives the same
   * `Throw_...`/`Catch_...` from the statement's coordinate, so dropping it is
   * lossless.
   */
  private terminalNameSuffix(
    el: Extract<
      FlowElement,
      { kind: 'endEvent' | 'intermediateThrowEvent' | 'intermediateCatchEvent' }
    >,
  ): string {
    return isSynthesizedTerminalId(el.id, el.kind, this.container)
      ? ''
      : ` ${nameOf(this.names, el.id)}`;
  }

  /** `undefined` when the element has no statement form. */
  private renderStatement(el: FlowElement): Lines | undefined {
    switch (el.kind) {
      case 'startEvent':
        if (isElidedOnPrint(el, this.container, this.startTriggerSuppressed)) {
          return undefined;
        }
        return renderStartEvent(el, this.startTriggerSuppressed, this.names);
      case 'endEvent': {
        const members = startOrEndMembers(el);
        const definition = el.eventDefinition;
        if (definition === undefined || isEndCarried(definition)) {
          const head = definition === undefined ? '' : ` ${definition.kind}`;
          return bracketed(
            `end ${nameOf(this.names, el.id)}${head}`,
            [...namedSettings(el), ...jobSettingItems(el)],
            members,
          );
        }
        return renderThrow(
          definition,
          this.terminalNameSuffix(el),
          [...throwBindingSettings(el), ...jobSettingItems(el)],
          members,
          this.names,
        );
      }
      case 'intermediateThrowEvent': {
        // Only escalation, signal, message, compensation, and link are
        // emittable: an error aborts its path (`throw error`) and the rest
        // have no throw surface.
        const def = el.eventDefinition;
        const settings = [...throwBindingSettings(el), ...jobSettingItems(el)];
        switch (def.kind) {
          case 'escalation':
          case 'signal':
          case 'message':
          case 'compensation':
          case 'link': {
            const trigger = renderTrigger(def, this.names);
            return bracketed(
              `emit ${trigger.head}${this.terminalNameSuffix(el)}`,
              [...trigger.items, ...settings],
              structuredMembers(el),
            );
          }
          default:
            throw new Error(
              `irToDsl: intermediate throw '${el.id}' carries a ${def.kind} definition; only escalation, signal, message, compensation, or link can be emitted.`,
            );
        }
      }
      case 'intermediateCatchEvent': {
        const trigger = renderTrigger(el.eventDefinition, this.names);
        return bracketed(
          `await ${trigger.head}${this.terminalNameSuffix(el)}`,
          [...trigger.items, ...jobSettingItems(el)],
          structuredMembers(el),
        );
      }
      case 'userTask':
        return renderUserTask(el, this.names);
      case 'serviceTask':
        return renderServiceTask(el, this.names);
      case 'task':
        return bracketed(
          `step ${nameOf(this.names, el.id)}${repeatClause(el)}`,
          [...namedSettings(el), ...engineSettings(el)],
          structuredMembers(el),
        );
      case 'receiveTask':
        return renderReceiveTask(el, this.names);
      case 'callActivity':
        return renderCallActivity(el, this.names);
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
type ForkKind = 'parallelGateway' | 'inclusiveGateway';

/** A split the fork block prints: a gateway of either kind, or a step whose routes give it one. */
interface Fork {
  id: string;
  kind: ForkKind;
  fallbackId: string | undefined;
}

/** The word the marker names a lost split by. */
const SPLIT_KIND_WORD: Record<Gateway['kind'], string> = {
  exclusiveGateway: 'exclusive',
  parallelGateway: 'parallel',
  inclusiveGateway: 'inclusive',
  eventBasedGateway: 'event-based',
};

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

function degradedSplitMarker(splitId: string, kind: Gateway['kind']): string {
  return `${UNSTRUCTURED_MARKER} (split ${splitId} degraded to jumps; was ${SPLIT_KIND_WORD[kind]})`;
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
 * each under the condition it carried, and loses the split itself: the marker
 * line above the jumps names it. An edge with no name to jump to takes the
 * marker {@link droppedEdgeWarning} reports instead, which is why this one
 * counts no branches.
 */
function degradedSplitWarning(splitId: string): PrintWarning {
  return {
    elementId: splitId,
    category: 'degradedSplit',
    message:
      'The branches leaving this split have no form in the script, so a ' +
      'branch leaves as a jump, or as a marker where it opens on something ' +
      'the script cannot name. A condition weighing a branch is written on ' +
      'its jump, but the split is lost: whether it opened one branch, every ' +
      'branch whose condition held, or the first to resolve is written ' +
      'nowhere, and a jump ends the path it sits on, so at most one branch ' +
      'is left running. The marker line above the jumps is where hand-repair ' +
      'starts.',
  };
}

/**
 * Where {@link degradedSplitWarning} names a split whose branches the script
 * cannot fold, this names one with nothing to fold: the split prints as
 * nothing and the run ends where the script's block does. What the model does
 * there depends on the kind, and the sentence says which.
 */
function emptySplitWarning(kind: Gateway['kind'], id: string): PrintWarning {
  const model = {
    // `ParallelGatewayActivityBehavior.execute` leaves by no route, and
    // `PvmExecutionImpl.leaveActivityViaTransitions` ends the execution. At
    // top level that is the whole run; inside a fork's branch it is that
    // branch alone, and the join it never reaches keeps the fork waiting.
    parallelGateway:
      "The engine ends the run here too, so outside a fork's branch the " +
      'process runs the same without it; inside one, only that branch ends ' +
      'and the fork never completes.',
    // `InclusiveGatewayActivityBehavior.execute` throws `stuckExecutionException`.
    inclusiveGateway:
      'The engine stops the run with an error here, where the script ends ' +
      'it, so what runs is not the same.',
    // `EventBasedGatewayActivityBehavior.execute` is a wait state, and with
    // nothing to wait for the instance never leaves it.
    eventBasedGateway:
      'The engine waits here forever, where the script ends the run, so what ' +
      'runs is not the same.',
    // `BpmnParse.validateExclusiveGateway`: "has no outgoing sequence flows".
    exclusiveGateway:
      'The engine refuses to deploy the model as drawn, while the script ' +
      'deploys and ends the run here.',
  }[kind];
  return {
    elementId: id,
    category: 'degradedSplit',
    message:
      `This ${kind === 'eventBasedGateway' ? 'wait' : 'split'} has no route ` +
      `out, so it was left out of the script. ${model}`,
  };
}

/**
 * A jump printed outside the `await`/`parallel` branch its target was printed
 * in. The validator refuses it, since a branch's steps run only when the whole
 * block is reached, and the model is where the route comes from, so the jump
 * is written and reported rather than dropped.
 */
function crossBranchJumpWarning(target: string): PrintWarning {
  return {
    elementId: target,
    category: 'refusedStatement',
    message:
      'A route the model takes into this step crosses the border of a branch ' +
      "of an 'await' or 'parallel' block, and the jump written for it draws " +
      'an error when the source is read back: the steps of a branch run only ' +
      'when the whole block is reached. Redraw the route in the model, or ' +
      'move the step out of the branch.',
  };
}

function inventedFallbackWarning(splitId: string): PrintWarning {
  return {
    elementId: splitId,
    category: 'defaultFlow',
    message:
      'Every route leaving here runs under a condition and the model names ' +
      'no fallback, so the run it describes fails here when none of them ' +
      'holds. The script has no form for that failure and carries on past ' +
      'the routes instead, so what runs changes. Check that carrying on is ' +
      'what was meant.',
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

function droppedSettingWarning(gatewayId: string): PrintWarning {
  return {
    elementId: gatewayId,
    category: 'droppedSetting',
    message:
      'The engine settings on this split or merge were not written to the ' +
      'script: the script derives every split and every merge from its ' +
      'block structure, and this one has no statement here to carry them, ' +
      'so the process runs without them.',
  };
}

/**
 * A pathological IR degrades to a `goto` rather than overflowing the stack.
 * Unpinned: reaching it takes an IR nested a thousand blocks deep, which no
 * fixture builds.
 */
const MAX_NESTING_DEPTH = 1000;

/**
 * In print order, after the label and documentation {@link namedSettings}
 * writes. The IR field name is also the DSL key. Exported so a test can hold
 * the pair against `PROCESS_HEADER_KEYS`: a key the vocabulary gains and this
 * table does not would print nothing and round-trip as a silent drop.
 */
export const PROCESS_HEADER_SETTINGS = [
  ['versionTag', quoteLiteral],
  ['historyTimeToLive', quote],
  ['candidateStarterUsers', quote],
  ['candidateStarterGroups', quote],
] as const;

function buildProcessHeader(process: BpmnProcess, names: PrintNames): string {
  const settings: string[] = namedSettings(process);
  for (const [key, render] of PROCESS_HEADER_SETTINGS) {
    const value = process[key];
    if (value !== undefined) settings.push(setting(key, render(value)));
  }
  return `process ${nameOf(names, process.id)}${parens(settings)} {`;
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
function isEndCarried(
  def: EventDefinition,
): def is Extract<EventDefinition, { kind: (typeof END_TRIGGERS)[number] }> {
  return END_CARRIED_KINDS.has(def.kind);
}

/**
 * Whether the id is absent from the printed form, leaving a `goto` nothing to
 * resolve against. `xmlToIr` asks the same question to report the label an
 * elided start or end takes with it, so the two answers cannot drift apart.
 *
 * For a plain end the answer is only that the printer may drop it; `emitNode`
 * and `Emitter.emit` decide by position whether it does. `forwardToRealTarget`
 * reads this half alone, so a jump into such an end is dropped and marked
 * whether or not the end ends up printed.
 *
 * `container` is the one the element sits in, whose id the minted start and
 * end carry. The compiler re-derives a dropped start at the body's head and
 * nowhere else, so only the first plain start under the minted id can go: a
 * second one prints under its own id.
 */
export function isElidedOnPrint(
  el: FlowElement,
  container: PrintContainer,
  startTriggerSuppressed = false,
): boolean {
  switch (el.kind) {
    case 'startEvent':
      return (
        container.flowElements.find(
          (s) =>
            s.kind === 'startEvent' &&
            isPlainUnnamed(s, container, startTriggerSuppressed),
        )?.id === el.id
      );
    case 'endEvent':
      if (!isSynthesizedTerminalId(el.id, el.kind, container)) return false;
      // The compiler cannot re-derive a definition the `end` statement
      // carries, so that always prints, and `end`'s mandatory `name=ID` means
      // the synthesized id prints too.
      if (el.eventDefinition === undefined) return !carriesPrintableContent(el);
      // Every other definition prints as a `throw`, which drops a synthesized name.
      return !isEndCarried(el.eventDefinition);
    case 'intermediateThrowEvent':
      // Spells the id through `terminalNameSuffix`, which drops a synthesized one.
      return isSynthesizedTerminalId(el.id, el.kind, container);
    case 'intermediateCatchEvent':
      // Spells the id through `terminalNameSuffix`, which drops a synthesized one.
      return isSynthesizedTerminalId(el.id, el.kind, container);
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

/** A start with nothing of its own to print, so nothing is lost by dropping it. */
function isPlainUnnamed(
  el: Extract<FlowElement, { kind: 'startEvent' }>,
  container: PrintContainer,
  startTriggerSuppressed: boolean,
): boolean {
  // A trigger has nowhere else to print, so a start carrying one always
  // prints. Inside an event sub-process the trigger prints in the `on`
  // header instead, and the emitter suppresses it here; a timer head also
  // carries the start's timer-job settings, so those alone do not make the
  // start print either.
  if (el.eventDefinition !== undefined && !startTriggerSuppressed) return false;
  const own =
    startTriggerSuppressed && el.eventDefinition?.kind === 'timer'
      ? splitTimerJobSettings(el).continuation
      : el;
  return (
    isSynthesizedTerminalId(el.id, el.kind, container) &&
    !carriesPrintableContent(own)
  );
}

/**
 * A synthesized start or end has no authored name and the grammar's `name=ID`
 * is mandatory, so it is dropped unless its block carries content. Every
 * reader goes through {@link isElidedOnPrint}: a reason to print reaching one
 * but not another would leave a jump naming a statement that never gets
 * emitted.
 *
 * A label is not such a reason: printing the id to carry one writes a name the
 * validator rejects, so the label is reported as an import warning instead.
 */
function carriesPrintableContent(
  el: Extract<FlowElement, { kind: 'startEvent' | 'endEvent' }>,
): boolean {
  return jobSettingItems(el).length > 0 || startOrEndMembers(el).length > 0;
}

/** The form block leads the members every element shares. */
function startOrEndMembers(
  el: Extract<FlowElement, { kind: 'startEvent' | 'endEvent' }>,
): Lines[] {
  const form =
    el.kind === 'startEvent' && el.formFields !== undefined
      ? [renderFormBlock(el.formFields)]
      : [];
  return [...form, ...structuredMembers(el)];
}

/** In print order. A kind-specific member is placed around this list. */
function structuredMembers(el: SettingsCarrier): Lines[] {
  return [...ioParameters(el), ...listenerMembers(el)];
}

/** Fixed order, so the parens stay stable across runs; `keyOf` respells each key for a second carrier sharing the parens. */
function jobSettingItems(
  el: JobSettings,
  keyOf: (key: string) => string = (key) => key,
): string[] {
  const settings: string[] = [];
  if (el.asyncBefore === true) {
    settings.push(setting(keyOf('asyncBefore'), 'true'));
  }
  if (el.asyncAfter === true) {
    settings.push(setting(keyOf('asyncAfter'), 'true'));
  }
  if (el.exclusive === false) {
    settings.push(setting(keyOf('exclusive'), 'false'));
  }
  if (el.jobPriority !== undefined) {
    settings.push(
      setting(keyOf('jobPriority'), renderNumericValue(el.jobPriority)),
    );
  }
  if (el.retryCycle !== undefined) {
    settings.push(setting(keyOf('retryCycle'), quote(el.retryCycle)));
  }
  return settings;
}

/**
 * Own settings, then the loop's under the `run` spellings (see
 * `LoopCharacteristics` in `ir/types.ts`); guarded by {@link repeats} like
 * `repeatClause`, so a loop with nothing to repeat over prints nothing.
 */
function engineSettings(el: EngineAttributes & Repeatable): string[] {
  return [
    ...jobSettingItems(el),
    ...(repeats(el.loop) ? jobSettingItems(el.loop, runSettingKey) : []),
  ];
}

/**
 * Ahead of the io parameters wherever both print, since a field configures the
 * implementation the head names. `structuredMembers` cannot place them: it
 * reads an element's own lists and a field hangs off the binding.
 */
function fieldMembers(binding: ServiceTaskBinding | ListenerBinding): Lines[] {
  const fields = carriesFields(binding) ? (binding.fields ?? []) : [];
  return fields.map((field) => [`field ${field.name} = ${quote(field.value)}`]);
}

/** Inputs before outputs, each in IR order, which the engine evaluates in. */
function ioParameters(el: IoMapped): Lines[] {
  const members: Lines[] = [];
  for (const param of el.inputParameters ?? []) {
    members.push([`input ${param.name} = ${renderIoValue(param.value)}`]);
  }
  for (const param of el.outputParameters ?? []) {
    members.push([`output ${param.name} = ${renderIoValue(param.value)}`]);
  }
  return members;
}

/**
 * Text takes the quoting every string-valued attribute uses, so a `${...}` body
 * re-parses as a raw expression. A map key always quotes, since the bare
 * spelling is an identifier token and a key reading as a keyword would not lex;
 * it is the `STRING` the grammar's `MapKey` takes, never an expression, so it
 * quotes as prose.
 */
function renderIoValue(value: IoValue): string {
  switch (value.kind) {
    case 'text':
      return quote(value.text);
    case 'list':
      return `[${value.items.map((item) => renderIoValue(item)).join(', ')}]`;
    case 'map': {
      const entries = value.entries.map(
        (entry) => `${quoteLiteral(entry.key)}: ${renderIoValue(entry.value)}`,
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
function listenerMembers(el: SettingsCarrier): Lines[] {
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

/** A script binding is the one that keeps a body, its fence being where the code goes. */
function renderListener(
  event: string,
  binding: ListenerBinding,
  timer?: Extract<EventDefinition, { kind: 'timer' }>,
): Lines {
  const clause =
    timer !== undefined
      ? ` ${TIMER_PARTICLE[timer.timerKind]} ${quote(timer.expression)}`
      : '';
  const head = `on ${event}${clause}`;
  return binding.kind === 'script'
    ? [`${head} ${renderFence(binding.format, binding.code)}`]
    : withMembers(
        head + parens([renderCodeBinding(binding)]),
        fieldMembers(binding),
      );
}

/**
 * `delegate` is the DSL alias for `operaton:delegateExpression`. An expression
 * quotes verbatim, its `${...}` wrapper being part of the value.
 */
function renderCodeBinding(binding: CodeBinding): string {
  switch (binding.kind) {
    case 'class':
      return setting('class', quote(binding.className));
    case 'expression':
      return setting('expression', quote(binding.expression));
    case 'delegateExpression':
      return setting('delegate', quote(binding.expression));
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
 * The validator refuses these in authored source, so an id carrying the form
 * its own kind is minted with is synthesized: the exact start and end minted
 * for `container` (and for a boundary escape in it), and the `Throw_` and
 * `Catch_` prefixes, which are positional and no modeler writes. An id
 * carrying another kind's template is an authored name and has to keep
 * printing. An end answers to the throw prefix as well, because `throw`
 * lowers to an end event; a catch answers to its own prefix only, since
 * nothing else lowers to one.
 */
function isSynthesizedTerminalId(
  id: string,
  kind: FlowElement['kind'],
  container: PrintContainer,
): boolean {
  switch (kind) {
    case 'startEvent':
      return isMintedStartId(id, container.id);
    case 'endEvent':
      return (
        isMintedEndId(
          id,
          container.id,
          container.flowElements.filter(isBoundary).map((b) => b.id),
        ) || id.startsWith(THROW_EVENT_PREFIX)
      );
    case 'intermediateThrowEvent':
      return id.startsWith(THROW_EVENT_PREFIX);
    case 'intermediateCatchEvent':
      return id.startsWith(CATCH_EVENT_PREFIX);
    default:
      return false;
  }
}

/** An authored id prints so it survives as a goto target; `nameSuffix` is {@link Emitter.terminalNameSuffix}'s. */
function renderThrow(
  def: Exclude<EndEventDefinition, { kind: (typeof END_TRIGGERS)[number] }>,
  nameSuffix: string,
  settings: string[],
  members: Lines[],
  names: PrintNames,
): Lines {
  switch (def.kind) {
    case 'error':
    case 'escalation':
    case 'signal':
    case 'message':
    case 'compensation': {
      const trigger = renderTrigger(def, names);
      return bracketed(
        `throw ${trigger.head}${nameSuffix}`,
        [...trigger.items, ...settings],
        members,
      );
    }
    default: {
      const exhaustive: never = def;
      throw new Error(
        `irToDsl: unhandled thrown definition: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Engine attributes come off the sub-process, plus the timer job's off the
 * start when that start prints no statement: the compiler puts the three on
 * the start a timer head synthesizes ({@link timerJob}), and a start that
 * prints keeps them on its own line.
 */
function buildOnHeader(
  handler: Extract<FlowElement, { kind: 'subProcess' }>,
  names: PrintNames,
): Lines {
  const start = handler.flowElements.find(
    (e): e is Extract<FlowElement, { kind: 'startEvent' }> =>
      e.kind === 'startEvent',
  );
  if (start === undefined || start.eventDefinition === undefined) {
    throw new Error(
      `irToDsl: event subprocess '${handler.id}' has no trigger start event.`,
    );
  }
  const trigger = renderTrigger(start.eventDefinition, names);
  const lifted = isElidedOnPrint(start, handler, true)
    ? jobSettingItems(timerJob(start))
    : [];
  return bodyHeader(
    `on ${trigger.head}`,
    [
      ...trigger.items,
      ...engineSettings(handler),
      ...lifted,
      ...alongsideFlag(start.isInterrupting === false),
    ],
    structuredMembers(handler),
  );
}

/**
 * The settings of the job a timer start declares, which an `on timer` head
 * authors for the start it synthesizes ({@link splitTimerJobSettings}); the
 * async flags are the sub-process's own.
 */
function timerJob(
  start: Extract<FlowElement, { kind: 'startEvent' }>,
): JobSettings {
  return splitTimerJobSettings(start).timer;
}

/** `attachedToRef` prints under the host's name; refusing a bad host belongs to validation. */
function buildBoundaryHeader(
  boundary: Extract<FlowElement, { kind: 'boundaryEvent' }>,
  names: PrintNames,
): Lines {
  const trigger = renderTrigger(boundary.eventDefinition, names);
  return bodyHeader(
    `on ${nameOf(names, boundary.attachedToRef)}: ${trigger.head}`,
    [
      ...trigger.items,
      ...jobSettingItems(boundary),
      ...alongsideFlag(boundary.cancelActivity === false),
    ],
    structuredMembers(boundary),
  );
}

/** The vocabulary's table, narrowed so a new IR timer kind without a word fails to compile. */
const TIMER_PARTICLE: Record<
  Extract<EventDefinition, { kind: 'timer' }>['timerKind'],
  string
> = TIMER_PARTICLE_BY_KIND;

/**
 * The trigger clause: the word it opens on, and the items its parens lead with.
 * The payload leads them, so a name, a code and a duration are written the same
 * way wherever a trigger is; a catch binding follows as a setting naming the
 * variable the event data lands in, and the element's own settings after that.
 * A condition prints unquoted, being an expression rather than text.
 */
function renderTrigger(
  def: EventDefinition,
  names: PrintNames,
): {
  head: string;
  items: string[];
} {
  switch (def.kind) {
    case 'error':
      return {
        head: 'error',
        items: [
          ...codeItem(names.error, def.errorCode),
          ...eventBindingSettings(def),
        ],
      };
    case 'escalation':
      return {
        head: 'escalation',
        items: [
          ...codeItem(names.escalation, def.escalationCode),
          ...eventBindingSettings(def),
        ],
      };
    case 'compensation':
      return { head: 'compensation', items: [] };
    case 'message':
      return { head: 'message', items: payloadItem(def.messageName) };
    case 'signal':
      return { head: 'signal', items: payloadItem(def.signalName) };
    case 'timer':
      return renderTimerTrigger(def);
    case 'conditional':
      return {
        head: 'condition',
        items: [renderRawCondition(def.condition)],
      };
    case 'link':
      return { head: 'link', items: payloadItem(def.linkName) };
    case 'cancel':
      return { head: 'cancel', items: [] };
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

/** Absent for a catch-all, which names no code and so carries no payload. */
function payloadItem(code: string | undefined): string[] {
  return code === undefined ? [] : [quote(code)];
}

/**
 * A code is written as the name of the declaration carrying it, which is what
 * lets `error OrderFailed(code: "order.failed")` be raised by a word. Absent
 * for a catch-all, as {@link payloadItem} is.
 */
function codeItem(
  names: ReadonlyMap<string, string>,
  code: string | undefined,
): string[] {
  return code === undefined ? [] : [names.get(code) ?? code];
}

/**
 * A duration is the payload a timer writes bare; a date and a cycle take the
 * particle naming them as their key.
 */
function renderTimerTrigger(def: Extract<EventDefinition, { kind: 'timer' }>): {
  head: string;
  items: string[];
} {
  const particle = TIMER_PARTICLE[def.timerKind];
  const time = quote(def.expression);
  return {
    head: 'timer',
    items: [def.timerKind === 'duration' ? time : setting(particle, time)],
  };
}

/** `code: x, message: y`. Only an error carries a message binding. */
function eventBindingSettings(
  def: Extract<EventDefinition, { kind: 'error' | 'escalation' }>,
): string[] {
  const parts: string[] = [];
  if (def.codeVariable !== undefined) {
    parts.push(setting('code', def.codeVariable));
  }
  if (def.kind === 'error' && def.messageVariable !== undefined) {
    parts.push(setting('message', def.messageVariable));
  }
  return parts;
}

/**
 * The flag saying a handler leaves its scope running. A flag is bare and closes
 * the parens, after the payload and the settings.
 */
function alongsideFlag(nonInterrupting: boolean): string[] {
  return nonInterrupting ? ['alongside'] : [];
}

function renderStartEvent(
  el: Extract<FlowElement, { kind: 'startEvent' }>,
  startTriggerSuppressed: boolean,
  names: PrintNames,
): Lines {
  const trigger =
    el.eventDefinition === undefined || startTriggerSuppressed
      ? { head: '', items: [] }
      : renderTrigger(el.eventDefinition, names);
  const head = trigger.head === '' ? '' : ` ${trigger.head}`;
  return bracketed(
    `start ${nameOf(names, el.id)}${head}`,
    [
      ...trigger.items,
      ...namedSettings(el),
      ...(el.initiator === undefined
        ? []
        : [setting('initiator', quote(el.initiator))]),
      ...jobSettingItems(el),
    ],
    startOrEndMembers(el),
  );
}

/** The label leads the assignment settings, and the form block leads the members. */
function renderUserTask(
  el: Extract<FlowElement, { kind: 'userTask' }>,
  names: PrintNames,
): Lines {
  const settings = namedSettings(el);
  for (const [key, render] of USER_TASK_SETTINGS) {
    const value = el[key];
    if (value !== undefined) settings.push(setting(key, render(value)));
  }
  if (el.formRef !== undefined) {
    settings.push(
      setting('formRef', quote(el.formRef.key)),
      versionBindingSetting(el.formRef.binding),
    );
  }
  settings.push(...engineSettings(el));
  const form =
    el.formFields === undefined ? [] : [renderFormBlock(el.formFields)];
  return bracketed(
    `user ${nameOf(names, el.id)}${repeatClause(el)}`,
    settings,
    [...form, ...structuredMembers(el)],
  );
}

/** In print order. The IR field name is also the DSL keyword. */
const USER_TASK_SETTINGS = [
  ['assignee', quote],
  ['formKey', quote],
  ['candidateGroups', quote],
  ['candidateUsers', quote],
  ['dueDate', quote],
  ['followUpDate', quote],
  ['priority', renderNumericValue],
] as const;

/**
 * One field per line, or a block of its own where a field carries extras: a
 * form is a member list, so it prints that way itself. The braces are written
 * even with no fields, `form` alone being no rule.
 */
function renderFormBlock(formFields: FormField[]): Lines {
  return [
    'form {',
    ...formFields
      .map((field) => renderFormField(field))
      .flat()
      .map((line) => INDENT + line),
    '}',
  ];
}

/** `<id>: <type> "<label>"? (= <default>)? (settings)? { block }?`. */
function renderFormField(field: FormField): Lines {
  const label =
    field.label !== undefined ? ` ${quoteLiteral(field.label)}` : '';
  const def =
    field.defaultValue !== undefined
      ? ` = ${renderFormDefault(field.defaultValue, field.type)}`
      : '';
  const head = `${field.id}: ${field.type}${label}${def}`;
  const settings = fieldSettings(field);
  // A space ahead of the parens, unlike every other statement head: a field
  // is a member line rather than its own statement, and the space is what
  // keeps it reading as one.
  const headWithSettings =
    settings.length === 0 ? head : `${head} ${parens(settings)}`;
  return withMembers(headWithSettings, fieldBlockMembers(field));
}

/**
 * `string`, `date` and `enum` quote; `number` and `boolean` print bare the
 * text that re-lexes as one literal and lowers back to the same text, and
 * quote the rest. `FormFieldHandler.createFormField` evaluates a default as
 * an expression, so the text a modeler wrote is the constant the engine
 * sees: bare, `maybe` would read a variable, `1 + 1` would compute, and `-3`
 * is a unary expression the compiler lowers to `${-3}`.
 */
function renderFormDefault(value: string, type: FormFieldType): string {
  const bare =
    (type === 'number' || type === 'boolean') &&
    FORM_DEFAULT_LITERAL.test(value) &&
    (type !== 'number' || String(Number(value)) === value);
  return bare ? value : quote(value);
}

// Canonical spellings only: `1.50`, `1.0` and `007` re-lex as numbers but
// lower to `1.5`, `1` and `7`, so they stay quoted to keep their text.
// `String(Number(value)) === value` catches what the shape alone can't: past
// 2^53 or 15 significant digits, `Number` itself rounds the value, so a
// canonically spelled literal can still print a different number than it read.
const FORM_DEFAULT_LITERAL = /^(0|[1-9]\d*)(\.\d*[1-9])?$|^(true|false)$/;

/** `pattern` first, being a type parameter rather than a constraint, then each constraint in IR order. */
function fieldSettings(field: FormField): string[] {
  const settings: string[] =
    field.datePattern === undefined
      ? []
      : [setting(DATE_PATTERN_KEY, quote(field.datePattern))];
  for (const constraint of field.constraints ?? []) {
    settings.push(renderFormConstraint(constraint));
  }
  return settings;
}

/**
 * A flag writes the literal `true`; a bound prints as `renderNumericValue`
 * prints a priority; `validator` is always quoted, like `class:`.
 */
function renderFormConstraint(constraint: FormFieldConstraint): string {
  switch (constraint.name) {
    case 'required':
    case 'readonly':
      return setting(constraint.name, 'true');
    case 'min':
    case 'max':
    case 'minlength':
    case 'maxlength':
      return setting(
        constraint.name,
        renderNumericValue(constraint.config ?? ''),
      );
    case 'validator':
      return setting('validator', quote(constraint.config ?? ''));
    default: {
      const exhaustive: never = constraint.name;
      throw new Error(
        `irToDsl: unhandled form constraint name: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Values in the engine's document order, then the field's `property` lines. */
function fieldBlockMembers(field: FormField): Lines[] {
  const values = (field.values ?? []).map((value) => [renderFormValue(value)]);
  return [...values, ...propertyMembers(field.properties)];
}

/** `<id> "<label>"?`, one line per value an `enum` field offers. */
function renderFormValue(value: FormFieldValue): string {
  return value.label === undefined
    ? value.id
    : `${value.id} ${quoteLiteral(value.label)}`;
}

/**
 * `property <key> = <value>` lines, of a form field's block or an external
 * task's. `quote`, not `quoteLiteral`: a `${...}` value has to re-lex as a
 * raw expression so it lowers back to the same text.
 */
function propertyMembers(properties: ExtensionProperty[] | undefined): Lines[] {
  return (properties ?? []).map((p) => [
    `property ${p.key} = ${quote(p.value)}`,
  ]);
}

/**
 * `error <name> when <condition>` lines. `eventIdentities` counts every
 * mapping as a use of its code, so `codeDeclarations` always has a name for
 * it, declared or synthesized.
 */
function errorMappingMembers(
  mappings: ErrorMapping[] | undefined,
  names: PrintNames,
): Lines[] {
  return (mappings ?? []).map((m) => [
    `error ${names.error.get(m.errorCode) ?? m.errorCode} when ${renderRawCondition(m.condition)}`,
  ]);
}

/** The message leads the engine settings, so the wait reads before them. */
function renderReceiveTask(
  el: Extract<FlowElement, { kind: 'receiveTask' }>,
  names: PrintNames,
): Lines {
  const settings = [
    ...namedSettings(el),
    ...(el.messageName === undefined
      ? []
      : [setting('message', quote(el.messageName))]),
    ...engineSettings(el),
  ];
  return bracketed(
    `receive ${nameOf(names, el.id)}${repeatClause(el)}`,
    settings,
    structuredMembers(el),
  );
}

const SERVICE_TASK_LIKE_KEYWORD = {
  service: 'service',
  send: 'send',
  businessRule: 'decide',
} as const;

function renderServiceTask(
  el: Extract<FlowElement, { kind: 'serviceTask' }>,
  names: PrintNames,
): Lines {
  const keyword = SERVICE_TASK_LIKE_KEYWORD[el.element ?? 'service'];
  const binding = el.binding;
  const settings = [
    ...namedSettings(el),
    ...bindingSettings(binding),
    ...resultVariableSetting(el),
    ...engineSettings(el),
  ];
  return bracketed(
    `${keyword} ${nameOf(names, el.id)}${repeatClause(el)}`,
    settings,
    [
      ...fieldMembers(binding),
      ...propertyMembers(
        binding.kind === 'external' ? binding.properties : undefined,
      ),
      ...errorMappingMembers(
        binding.kind === 'external' ? binding.errorMappings : undefined,
        names,
      ),
      ...structuredMembers(el),
    ],
  );
}

/** The settings spelling out an execution binding, whatever carries it. */
function bindingSettings(binding: ServiceTaskBinding): string[] {
  switch (binding.kind) {
    case 'class':
    case 'expression':
    case 'delegateExpression':
      return [renderCodeBinding(binding)];
    case 'external':
      return [
        setting('topic', quote(binding.topic)),
        ...(binding.taskPriority === undefined
          ? []
          : [
              setting('taskPriority', renderNumericValue(binding.taskPriority)),
            ]),
      ];
    case 'decision':
      return [
        setting('decision', quote(binding.decisionRef)),
        ...(binding.binding === undefined
          ? []
          : [versionBindingSetting(binding.binding)]),
        ...(binding.mapDecisionResult === undefined
          ? []
          : [setting('mapDecisionResult', binding.mapDecisionResult)]),
      ];
    case 'builtin':
      return [setting(TYPE_BINDING_KEY, quote(binding.type))];
    default: {
      const exhaustive: never = binding;
      throw new Error(
        `irToDsl: unhandled service binding kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** The implementation of a thrown message; every other throw carries none. */
function throwBindingSettings(el: { binding?: ServiceTaskBinding }): string[] {
  return el.binding === undefined ? [] : bindingSettings(el.binding);
}

/** A pinned version prints `version: <v>` and no `binding`. */
function versionBindingSetting(binding: VersionBinding): string {
  switch (binding.kind) {
    case 'latest':
    case 'deployment':
      return setting('binding', binding.kind);
    case 'version':
      return setting('version', renderNumericValue(binding.version));
    default: {
      const exhaustive: never = binding;
      throw new Error(
        `irToDsl: unhandled version binding kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Fixed order: the settings, then the members, the mappings last. */
function renderCallActivity(
  el: Extract<FlowElement, { kind: 'callActivity' }>,
  names: PrintNames,
): Lines {
  const settings: string[] = [
    ...namedSettings(el),
    setting('process', quote(el.calledElement)),
  ];

  if (el.binding !== undefined) {
    settings.push(versionBindingSetting(el.binding));
  }

  if (el.businessKey !== undefined) {
    settings.push(setting('businessKey', quote(el.businessKey)));
  }

  // After `businessKey` and before the engine settings, which is the order
  // `CallActivity.own` offers the keys in. Both values print through
  // `quote()`: the delegate body has to re-lex as an expression, and
  // `quoteLiteral` escapes a leading `${` to stop exactly that; the class
  // prints through `quote()` like every other class binding.
  if (el.mapper !== undefined) {
    settings.push(
      setting(
        CALL_MAPPER_KEY_BY_KIND[el.mapper.kind],
        quote(
          el.mapper.kind === 'class'
            ? el.mapper.className
            : el.mapper.expression,
        ),
      ),
    );
  }

  settings.push(...engineSettings(el));

  const members: Lines[] = [...structuredMembers(el)];
  for (const mapping of el.inMappings ?? []) {
    members.push([renderCallMapping('in', mapping)]);
  }
  for (const mapping of el.outMappings ?? []) {
    members.push([renderCallMapping('out', mapping)]);
  }

  return bracketed(
    `call ${nameOf(names, el.id)}${repeatClause(el)}`,
    settings,
    members,
  );
}

/**
 * All-digit prints bare; anything else quotes, so it re-parses as an
 * expression. An expression is trimmed, since a raw template opens directly
 * after its quote and Operaton reads the opening after a trim of its own
 * (`StringUtil.isExpression`).
 */
function renderNumericValue(value: string): string {
  if (/^[0-9]+$/.test(value)) return value;
  return quote(EXPRESSION_OPEN.test(value) ? value.trim() : value);
}

function resultVariableSetting(el: { resultVariable?: string }): string[] {
  return el.resultVariable !== undefined
    ? [setting('resultVariable', quote(el.resultVariable))]
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

/** The fence closes the statement, so it goes on the last line the members leave. */
function renderScriptTask(
  el: Extract<FlowElement, { kind: 'scriptTask' }>,
  names: PrintNames,
): Lines {
  const settings = [
    ...namedSettings(el),
    ...resultVariableSetting(el),
    ...engineSettings(el),
  ];
  const lines = bracketed(
    `script ${nameOf(names, el.id)}${repeatClause(el)}`,
    settings,
    structuredMembers(el),
  );
  lines[lines.length - 1] += ` ${renderFence(el.format, el.code)}`;
  return lines;
}

/**
 * The human-facing text an element carries, leading the keyed settings
 * wherever it carries any. The two travel together so a surface cannot gain
 * one and forget the other.
 */
function namedSettings(el: Named): string[] {
  return [
    ...(el.name === undefined ? [] : [setting('label', quoteLiteral(el.name))]),
    ...(el.documentation === undefined
      ? []
      : [setting('documentation', quoteLiteral(el.documentation))]),
  ];
}

/** The one spelling a setting takes; a payload and a flag are written without a key. */
function setting(key: string, value: string): string {
  return `${key}: ${value}`;
}

/**
 * `verb Id(a: "x") { members }`: the parens hold the scalar settings describing
 * the element, the braces hold the members with structure of their own, and a
 * bracket with nothing to hold is not written.
 */
function bracketed(head: string, settings: string[], members: Lines[]): Lines {
  return withMembers(head + parens(settings), members);
}

/**
 * The same head for a construct whose flow follows, so its last line is the one
 * the body opens on.
 */
function bodyHeader(head: string, settings: string[], members: Lines[]): Lines {
  const lines = withMembers(head + parens(settings), members);
  lines[lines.length - 1] += ' {';
  return lines;
}

/** One member per line inside the braces, or no braces at all. */
function withMembers(head: string, members: Lines[]): Lines {
  if (members.length === 0) return [head];
  return [`${head} {`, ...members.flat().map((line) => INDENT + line), '}'];
}

function parens(settings: string[]): string {
  return settings.length === 0 ? '' : `(${settings.join(', ')})`;
}

/** A statement head's parens follow a space, where an element's hug its name. */
function headSettings(settings: string[]): string {
  return settings.length === 0 ? '' : ` ${parens(settings)}`;
}

/** A literal count prints bare; anything else is an expression. */
export const BARE_CARDINALITY = /^\d+$/;

/**
 * The grammar's `ID` terminal. The clause writes the name each run sees bare
 * and has no other form for it, so this is also the test the import direction
 * refuses by. A collection spelled as a name prints bare by the same test;
 * anything else is an expression.
 */
export const BARE_ELEMENT_VARIABLE = ID_SHAPED;

/**
 * The name every code is raised by, one map per kind because the two are
 * declared separately, and the header lines that give each code that name.
 *
 * A code nothing declares still gets a declaration, exactly as `irToXml` still
 * gives it a root: a use site is a bare name and a name with nothing to resolve
 * to is an error, so a hand-built IR would otherwise print source that does not
 * compile. Names are claimed across both kinds at once, since a use site
 * resolves in one scope holding all of them.
 */
function codeDeclarations(process: BpmnProcess): {
  lines: string[];
  names: Pick<PrintNames, 'error' | 'escalation'>;
} {
  const names = {
    error: new Map<string, string>(),
    escalation: new Map<string, string>(),
  };
  const lines: string[] = [];
  const taken = new Set<string>();

  const declare = (
    kind: 'error' | 'escalation',
    decl: { name?: string; code: string; message?: string },
  ): void => {
    const name = claimDeclarationName(decl.code, taken, decl.name);
    names[kind].set(decl.code, name);
    lines.push(
      `${kind} ${name}` +
        parens([
          ...(decl.code === name
            ? []
            : [setting('code', quoteLiteral(decl.code))]),
          ...(decl.message === undefined
            ? []
            : [setting('message', quoteLiteral(decl.message))]),
        ]),
    );
  };

  for (const decl of process.errorDecls ?? []) declare('error', decl);
  for (const decl of process.escalationDecls ?? []) declare('escalation', decl);

  const { errorCodes, escalationCodes } = eventIdentities(process);
  for (const code of errorCodes) {
    if (!names.error.has(code)) declare('error', { code });
  }
  for (const code of escalationCodes) {
    if (!names.escalation.has(code)) declare('escalation', { code });
  }
  return { lines, names };
}

/**
 * A `var <name>: any` line per variable the body reads bare and nothing
 * types, in first-appearance order over one fixed walk. BPMN has no slot for
 * a declaration, so the print declares what it writes in a variable position:
 * the roots of a condition, a count, an `until`, an error mapping's `when`, a
 * conditional trigger, an `in` source and a bare collection, which are the
 * positions the validator reads a variable at, minus what its symbol table
 * already holds (`DefaultVariableSymbolProvider.collect`): a form field, a
 * catch binding, an io parameter name, an element variable, and the engine's
 * loop counters once anything repeats. `externalTask` inside a mapping and an
 * `out` source are exempt there too, the one evaluated on the external task
 * and the other in the called process. The type is `any` because a read says
 * nothing more, and every declaration of one name has to agree on the type,
 * so a second line for a typed name would be an error rather than a duplicate.
 */
function variableDecls(process: BpmnProcess): string[] {
  const reads = new Set<string>();
  const typed = new Set<string>();
  let anyRepeats = false;

  const read = (body: string | undefined, exempt?: string): void => {
    if (body === undefined) return;
    const result = parseJuel(body);
    if (result.kind !== 'structured') return;
    for (const name of varRoots(result.expr)) {
      if (name !== exempt) reads.add(name);
    }
  };

  const walk = (container: FlowContainer): void => {
    for (const el of container.flowElements) {
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
      if ('inputParameters' in el || 'outputParameters' in el) {
        for (const param of el.inputParameters ?? []) typed.add(param.name);
        for (const param of el.outputParameters ?? []) typed.add(param.name);
      }
      const loop = 'loop' in el ? el.loop : undefined;
      if (repeats(loop)) {
        anyRepeats = true;
        if (loop.elementVariable !== undefined) typed.add(loop.elementVariable);
        read(loop.cardinality);
        if (
          loop.collection !== undefined &&
          BARE_ELEMENT_VARIABLE.test(loop.collection)
        ) {
          reads.add(loop.collection);
        }
        read(loop.completionCondition);
      }
      if (def?.kind === 'conditional') read(def.condition);
      if (el.kind === 'serviceTask' && el.binding.kind === 'external') {
        for (const mapping of el.binding.errorMappings ?? []) {
          read(mapping.condition, EXTERNAL_TASK_EL_NAME);
        }
      }
      if (el.kind === 'callActivity') {
        for (const mapping of el.inMappings ?? []) {
          if (
            mapping.kind === 'variable' &&
            mapping.source !== mapping.target &&
            BARE_ELEMENT_VARIABLE.test(mapping.source)
          ) {
            reads.add(mapping.source);
          }
        }
      }
      if (el.kind === 'subProcess') walk(el);
    }
    for (const flow of container.sequenceFlows) read(flow.conditionExpression);
  };
  walk(process);

  if (anyRepeats) for (const name of LOOP_VARIABLES) typed.add(name);
  return [...reads]
    .filter((name) => !typed.has(name))
    .map((name) => `${INDENT}var ${name}: any`);
}

/** The variable roots of a structured body, an index expression's included. */
function* varRoots(node: JuelNode): Generator<string> {
  switch (node.kind) {
    case 'varRef':
      yield node.name;
      for (const accessor of node.accessors) {
        if ('index' in accessor) yield* varRoots(accessor.index);
      }
      break;
    case 'unary':
      yield* varRoots(node.operand);
      break;
    case 'binary':
      yield* varRoots(node.left);
      yield* varRoots(node.right);
      break;
    case 'ternary':
      yield* varRoots(node.condition);
      yield* varRoots(node.whenTrue);
      yield* varRoots(node.whenFalse);
      break;
    case 'paren':
      yield* varRoots(node.inner);
      break;
    default:
      break;
  }
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
    const collection = BARE_ELEMENT_VARIABLE.test(loop.collection)
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

/**
 * The quoting for a value the engine evaluates, which a body opening with
 * `${` or `#{` has to keep re-lexing as: an expression, a delegate, a timer
 * body, an io value, a collection. The grammar reads a raw template with the
 * same escapes as a literal, so one escaper serves both and this is its exact
 * inverse. Prose and a declared name take {@link quoteLiteral}.
 */
function quote(value: string): string {
  return `"${escapeQuoted(value)}"`;
}

/**
 * The quoting for a value that has to come back byte for byte as text: a
 * label, documentation, a version tag, a form field label, a map key, a
 * declared code, an error message.
 *
 * A body opening with `${` or `#{` gets a backslash before the opener, so it
 * lexes as a `STRING` rather than as a raw template. `\$` and `\#` are not
 * recognized escapes and the reader hands the character back unchanged, which
 * keeps the two exact inverses. Only that opening earns the backslash: an
 * escape no terminal asks for is noise in source somebody reads.
 */
function quoteLiteral(value: string): string {
  const escaped = escapeQuoted(value);
  return `"${/^[$#]\{/.test(escaped) ? '\\' + escaped : escaped}"`;
}
