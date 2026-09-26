/**
 * Restructuring IR -> DSL, the inverse of `astToIr`: a flat {@link BpmnProcess}
 * back into source that re-parses and re-desugars to an equivalent IR.
 *
 * Structure comes from the dominator analysis in `cfg-analysis.ts` matched
 * against the pattern catalog of ADR 0009; whatever it cannot fold degrades to
 * `goto`, and an edge with no `goto` form leaves an {@link UNSTRUCTURED_MARKER}.
 * Every gateway a pattern matches is elided: the desugarer derives gateway ids
 * from structural coordinates, so one that never prints is re-synthesized under
 * the same id, which is what makes DSL -> IR -> DSL idempotent.
 */

import {
  CALL_MAPPER_KEY_BY_KIND,
  DATE_PATTERN_KEY,
  END_TRIGGERS,
  ENGINE_KEYS,
  type EngineKey,
  EXPRESSION_OPEN,
  EXTERNAL_TASK_EL_NAME,
  isReservedName,
  joinSettingKey,
  LOOP_VARIABLES,
  runSettingKey,
  TIMER_PARTICLE_BY_KIND,
  TYPE_BINDING_KEY,
  USER_TASK_VERBATIM_KEYS,
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
 * One entry per line, except a fenced script body, which keeps its newlines
 * inside one entry: an enclosing block indents whole entries, and indenting
 * inside the fence would rewrite the code.
 */
type Lines = string[];

interface PrintNames {
  /** The name each raised code is written under, from {@link codeDeclarations}. */
  error: Map<string, string>;
  escalation: Map<string, string>;
  /** Only the ids that print under another name ({@link printedNames}); every other id prints as itself. */
  printed: ReadonlyMap<string, string>;
}

/** Every site that writes an element or process id goes through here. */
function nameOf(names: PrintNames, id: string): string {
  return names.printed.get(id) ?? id;
}

/** The id seeds the minted terminal ids; the elements find the boundaries and the first plain start. */
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
 * Gateways alone: every other elided label is reported by `xmlToIr`, and a
 * wider rule would report the same drop twice to a caller printing both
 * channels.
 */
function warnGatewayText(
  container: FlowContainer,
  warnings: PrintWarning[],
): void {
  for (const el of container.flowElements) {
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
 * A reserved name is the model's to repair, so it is reported ahead of the
 * print. A plain synthesized end that prints for its position is reported by
 * the emitter, which alone knows the position.
 */
function warnRefusedStatements(
  container: FlowContainer,
  names: PrintNames,
  warnings: PrintWarning[],
  startTriggerSuppressed = false,
): void {
  for (const el of container.flowElements) {
    if (
      !isElidedOnPrint(el, container, startTriggerSuppressed) &&
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
 * Every id the script writes, as the process header, a statement name or a
 * `goto` target, and cannot spell; a gateway, a boundary and an event
 * sub-process never write theirs. A minted name is resolved against every id
 * in the document and every name minted before it, since a name written twice
 * leaves every jump to it ambiguous. The rebuilt document carries the new id,
 * which the engine keys history (`HistoricActivityInstance.getActivityId`),
 * migration plans (`MigrationPlanBuilder.mapActivities`) and a modification
 * (`InstantiationBuilder.startBeforeActivity`) on, hence "not the same".
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
 * One per container: a sub-process's body lives in the child container's
 * arrays, so the parent's CFG treats the sub-process as one opaque node and no
 * region spans two containers.
 */
class Emitter {
  private readonly cfg: CfgAnalysis;
  private readonly byId = new Map<string, FlowElement>();
  /** In IR order, which is what keeps emission deterministic. */
  private readonly outgoingBySource = new Map<string, SequenceFlow[]>();
  private readonly emittedNodes = new Set<string>();
  private readonly consumedFlows = new Set<string>();
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
  /**
   * The plain end minted for this container when the printer leaves it out,
   * which is the block's tail unless a chain hoisted behind it forces it to
   * print. A boundary body's minted end is not it: that body prints in an
   * array of its own, where nothing follows its end.
   */
  private readonly elidedTail: string | undefined;

  constructor(
    private readonly container: FlowContainer,
    /** Shared with every nested container, so one process yields one report. */
    private readonly warnings: PrintWarning[],
    private readonly names: PrintNames,
    /**
     * An event sub-process's start prints its trigger in the `on` header, so
     * the start statement inside the body prints without one.
     */
    private readonly startTriggerSuppressed = false,
  ) {
    this.cfg = analyzeCfg(container);
    this.elidedTail = container.flowElements.find(
      (el) =>
        el.kind === 'endEvent' &&
        el.eventDefinition === undefined &&
        isMintedEndId(el.id, container.id, []) &&
        isElidedOnPrint(el, container),
    )?.id;
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
   * The pass order is the ownership rule: the pass that walks a node first
   * owns it in the print. Every chain a container entry reaches (a start, or a
   * node no flow enters, a link catch above all) is walked before the boundary
   * handlers, so a handler whose body jumps to one degrades to a `goto` there;
   * a boundary escape chain is reached from no entry, so it is walked before
   * the orphan sweep would print it as detached top-level statements.
   */
  emit(): string[] {
    const lines: string[] = [];

    // 1. The elided start first and alone: the compiler re-derives it only at
    //    the head of a body that opens with no `start`, and anywhere else its
    //    chain lands after another chain's `end` as a dangling `goto`.
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

    // 2. Every chain an entry reaches that pass 1 left for a jump, in model
    //    order like the orphan sweep, which is what places a link catch's
    //    chain among them.
    const owned = this.reachableFromEntries();
    for (const el of this.container.flowElements) {
      if (owned.has(el.id) && !this.emittedNodes.has(el.id)) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }

    // 3. Boundary handlers, held back because the surface requires a handler
    //    block to follow the body it guards. Each block is kept under its
    //    element's index so pass 6 can place it among the event sub-processes
    //    the way the model orders them.
    const boundaryBlocks = new Map<number, string[]>();
    this.container.flowElements.forEach((el, index) => {
      if (isBoundary(el) && !this.emittedNodes.has(el.id)) {
        const block: string[] = [];
        this.emitBoundaryHandler(el, block, 0);
        boundaryBlocks.set(index, block);
      }
    });

    // 4. Orphaned fragments: a cycle no entry reaches, and what a handler's
    //    walk left for a jump.
    for (const el of this.container.flowElements) {
      if (isHandler(el) || isBoundary(el)) continue;
      if (!this.emittedNodes.has(el.id)) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }

    // 5. Every route left: a jump carries no condition, so `consume` reports
    //    one the way it does for a fall-through.
    for (const f of this.container.sequenceFlows) {
      if (!this.consumedFlows.has(f.id)) {
        this.consume(f);
        this.pushGoto(f.targetRef, lines);
      }
    }

    // A plain synthesized end stays out only at its block's tail, the one
    // position the compiler re-derives it at, and whether a flow statement
    // followed it is known only here. The boundary blocks and handlers appended
    // below are lowered out of chain, so they do not count as one. Reverse
    // order keeps every lower index valid while splicing.
    const printedEnds: string[] = [];
    for (const d of this.deferredEnds.toReversed()) {
      if (d.index >= d.lines.length) continue;
      d.lines.splice(d.index, 0, ...d.stmt);
      printedEnds.unshift(d.id);
    }
    for (const id of printedEnds) this.warnings.push(reservedNameWarning(id));

    // 6. Trailing handler group, in model order: the compiler lays handlers
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
   * Every unprinted start leaving for the same step as `start` prints with it,
   * back to back, and the step's chain is walked once under them, since starts
   * written back to back all enter the statement after them. Walked one at a
   * time, the second start would find the step printed and jump onto it, which
   * a jump cannot do for an elided end, and a `start` after the first chain
   * would leave that chain's elided end off its block's tail. A start leaving
   * on several routes is a split of its own and prints as one.
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

  /**
   * Every node a flow can carry a token to from one of the container's own
   * entries: a start, or a node no flow enters, which is a link catch or a
   * stranded fragment. A boundary event is an entry too, but its chain is the
   * handler's own until an entry's chain reaches into it.
   */
  private reachableFromEntries(): Set<string> {
    const entered = new Set(
      this.container.sequenceFlows.map((f) => f.targetRef),
    );
    const reached = new Set<string>();
    const pending = this.container.flowElements
      .filter(
        (el) =>
          !isBoundary(el) &&
          !isHandler(el) &&
          (el.kind === 'startEvent' || !entered.has(el.id)),
      )
      .map((el) => el.id);
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const f of this.outgoingBySource.get(id) ?? []) {
        pending.push(f.targetRef);
      }
    }
    return reached;
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
   * Only an unprinted merge with one route out, the shape the compiler
   * synthesizes and lands the printed keys on again; a merge with a second
   * route is a statement of its own, and one already printed carries them
   * nowhere, which the sweep reports. Counted over the model's routes, not the
   * unprinted ones: an enclosing loop spends the back-edge a merge at its
   * body's tail leaves by before the body is walked, and that merge is still
   * the pass-through it elides.
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

    // A boundary has no inbound flow either; a malformed one prints the block
    // here rather than losing the element.
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
   * One route is the fall-through; more is a fork with the statement as its
   * split. `BpmnActivityBehavior.performOutgoingBehavior` leaves by every route
   * whose condition holds or that carries none, and by the `default` alone when
   * none was taken: the inclusive fork's rule, or with nothing weighed and no
   * fallback the parallel fork's; one weighed route beside the fallback routes
   * like a choice and keeps its `if`/`else`. Read off the model rather than off
   * the routes left to print: a route an enclosing loop has already printed as
   * its closing brace is one the step takes beside the others all the same.
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
   * Keyed on the id rather than on a gateway: a step whose own routes split
   * reaches the same chain with no node of its own there.
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
   * The routes are given as a list rather than read off the split, so the loop
   * emitters can hand the routes their pattern did not spend to the same chain
   * at the position after the closing line.
   */
  private emitRoutes(
    splitId: string,
    outs: SequenceFlow[],
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    // Ahead of the two early returns: the report reads the model's routes,
    // whatever prints.
    this.warnFallbackCondition(splitId);

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
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

    return join !== undefined ? this.continueAt(join, stop, lines) : STOP;
  }

  /**
   * Every route gets a form: a conditioned one heads a branch with its
   * condition, and an unconditioned one heads a branch as `true`, takes the one
   * `else`, or, running straight into the join, prints as nothing. The `else`
   * goes to the model's fallback first, which keeps the chain total where the
   * model was; then to the route into the join, since a `true` head over that
   * empty branch would leave the rest unreachable; then to the last
   * unconditioned route, a second one being a shape the desugarer never writes.
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
   * The fallback counts as unconditioned whatever it carries: heading its
   * branch with the condition would put it on a run of its own and leave the
   * split with nowhere to go when nothing holds.
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
   * Every route leaves as a jump under its condition, each in a branch of its
   * own since a jump ends its block. The split's kind is lost, which the marker
   * names and {@link degradedSplitWarning} reports, and its settings with it,
   * which the sweep reports.
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
   * `undefined` when the split is unstructured. A join past `stop` is refused:
   * inside a loop body the body dominates everything after the loop, so a
   * split whose routes leave the loop and reconverge behind it would pass the
   * dominance checks, walk the staying route past the printed loop head and
   * drop the back edge.
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
    if (!this.cfg.dominates(splitId, join)) return undefined;
    for (const f of outs) {
      if (f.targetRef === join) continue;
      if (!this.cfg.dominates(splitId, f.targetRef)) return undefined;
    }
    return join;
  }

  /**
   * Where the routes come back together when the post-dominator queries
   * cannot say: a branch that can end puts the split's post-dominator at the
   * exit, and a step that loops on itself leaves the container with no
   * post-dominators at all, so {@link cleanJoin} and {@link recoveredForkJoin}
   * both miss a merge the routes plainly share.
   *
   * Read off the model's routes, bounded by `stop`. A route straight into a
   * sink never counts. The live routes are those reaching the block's exit
   * (`stop`, or the elided end at the top of the container); where none does,
   * those reaching a node another route reaches; where none does that either,
   * all of them. The answer is the first node in the first live route's
   * breadth order that every live route reaches: a merge (a gateway with one
   * route out) ahead of a step on the way to it, since the compiler lowers
   * every block with a merge; then the exit; then the nearest step no live
   * route can end or leave before. `joinKind` narrows a fork's or a race's
   * answer to a merge of that kind the split dominates, the only node it
   * synchronizes at: a merge entered from outside the block as well would
   * synchronize that entry too.
   */
  private convergence(
    splitId: string,
    outs: readonly SequenceFlow[],
    stop: string | undefined,
    joinKind?: Gateway['kind'],
  ): string | undefined {
    const exit = stop ?? this.elidedTail;
    const routes = outs
      .filter((f) => (this.outgoingBySource.get(f.targetRef) ?? []).length > 0)
      .map((f) => ({ f, reach: this.reachable(f.targetRef, splitId, stop) }));
    const shares = ({ reach }: (typeof routes)[number]): boolean =>
      [...reach].some((n) =>
        routes.some((r) => r.reach !== reach && r.reach.has(n)),
      );
    const running = routes.filter(
      ({ reach }) => exit !== undefined && reach.has(exit),
    );
    const live =
      running.length > 0
        ? running
        : routes.some(shares)
          ? routes.filter(shares)
          : routes;
    if (live.length === 0) return undefined;
    // A node every path into the split passes lies upstream of it, so
    // continuing there is a jump back over the block, not its merge. `stop`
    // is kept: a loop head dominates its body and is where the body ends.
    const shared = [...live[0]!.reach].filter(
      (n) =>
        live.every((r) => r.reach.has(n)) &&
        (n === stop || !this.cfg.dominates(n, splitId)),
    );
    const isMerge = (n: string, kind?: FlowElement['kind']): boolean => {
      const el = this.byId.get(n);
      return (
        el !== undefined &&
        isGateway(el) &&
        (this.outgoingBySource.get(n) ?? []).length === 1 &&
        (kind === undefined ||
          (el.kind === kind && this.cfg.dominates(splitId, n)))
      );
    };
    // A lone live route reaches every merge on its way, nested and later
    // blocks' beside this block's own, and the graph cannot tell them apart
    // in general (the compiler keeps a join one route enters). It can tell
    // this much: this block's join is entered by the lone route alone where a
    // nested if/else's is entered by each of its routes, and a choice's join
    // is a merge of its own kind where a nested fork's is not; a nested guard
    // clause's one-in join can still be taken first, and the block's tail
    // then prints after the block.
    const ownKind = joinKind ?? this.byId.get(splitId)?.kind;
    const merge =
      live.length === 1
        ? (shared.find(
            (n) => isMerge(n, ownKind) && this.cfg.incoming(n).length === 1,
          ) ??
          shared.find((n) => isMerge(n, ownKind)) ??
          (joinKind === undefined ? shared.find((n) => isMerge(n)) : undefined))
        : shared.find((n) => isMerge(n, joinKind));
    if (joinKind !== undefined) return merge;
    if (merge !== undefined) return merge;
    if (exit !== undefined && shared.includes(exit)) {
      // A branch's chain leaves the block through its join, so a lone route
      // that runs into the elided end past no merge was written behind an
      // authored end and jumped to; the guard clause keeps it that way.
      return live.length === 1 && stop === undefined ? undefined : exit;
    }
    // A lone weighed route's whole chain is its branch, so it continues at the
    // farthest step that holds rather than the nearest.
    const [only] = live;
    const weighed =
      live.length === 1 &&
      only!.f.conditionExpression !== undefined &&
      only!.f.id !== this.splitFallbackFlowId(splitId);
    // A step every live route reaches is the merge only when none can end
    // or leave for `stop` before it: two jumps into one step from a branch
    // and from the chain after the block reach it as well, and the chain
    // walked with the step as its stop prints nested inside the branch,
    // which the next pass prints hoisted.
    const leavesBefore = (entry: string, n: string): boolean =>
      [...this.reachable(entry, splitId, n)].some(
        (m) =>
          m !== n &&
          (m === stop || (this.outgoingBySource.get(m) ?? []).length === 0),
      );
    const holds = (n: string): boolean =>
      live.every((r) => !leavesBefore(r.f.targetRef, n));
    return weighed ? shared.findLast(holds) : shared.find(holds);
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
   * A guard clause has no clean join: one branch terminates while the
   * unconditioned route carries the main flow, which prints after the `if`
   * rather than as a bare `goto`. Reads the routes the chain leaves unweighed,
   * so the fallback is the continuation whether it carries a condition or not.
   */
  private guardClauseContinuation(
    unconditioned: SequenceFlow[],
  ): string | undefined {
    return unconditioned.length === 1 ? unconditioned[0]!.targetRef : undefined;
  }

  /**
   * A split inside a loop body or a branch whose every route is conditioned:
   * a leaving route puts the split's post-dominator outside the region, so
   * there is no clean join and no guard clause, yet the routes that stay run
   * into `stop`, which is the continuation. Only the leaving routes print as
   * jumps; as jumps throughout, the staying route's steps would be hoisted out
   * of the loop and their edge into its folded head dropped. A route straight
   * into `stop` stays, `postDominates` being reflexive, and prints as an empty
   * branch.
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
      this.pushGoto(entry, body);
    }
    for (const l of body) lines.push(INDENT + l);
  }

  /**
   * Four shapes walk inline: a body the join post-dominates; a synthesized
   * terminal the split owns, which prints the same statement in either scope;
   * a bare authored end the split's route alone enters; and a gateway the
   * split owns, which a jump could not name anyway.
   *
   * An authored entry with a chain of its own is decided by the block's tail.
   * A jump hoists the chain behind everything walked from the starts; where
   * that ends on the plain end the printer leaves out, the chain would push
   * that end off the one position the compiler re-derives it at, so the chain
   * prints inside the branch. Where the block ends on authored terminals the
   * chain stays a `goto` at its authored scope, so the coordinate-derived ids
   * of its unnamed events survive the round trip; and a chain that reaches the
   * elided end is that tail itself and stays a `goto` as well, since inside
   * the branch the end would print under its reserved id.
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
    if (el.kind === 'endEvent' && this.cfg.incoming(entry).length === 1) {
      return true;
    }
    return (
      this.elidedTail !== undefined &&
      !this.reachable(entry, splitId, join).has(this.elidedTail)
    );
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
    loop: Extract<FlowElement, { kind: 'exclusiveGateway' }>,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP | undefined {
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
   * An exclusive gateway with a conditioned back-edge into `node`, which
   * dominates it. The condition is what tells a post-test loop from a pre-test
   * `while`, which would otherwise match here through its join-to-head edge.
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

    this.emittedNodes.add(loopId);
    this.consumedFlows.add(backEdge.id);
    const rest = this.takeRest(outs);
    const settings = this.takeHeadSettings(loopId);

    lines.push('do {');
    this.emitBranch(node, loopId, lines, depth);
    lines.push(
      `} while (${renderCondition(backEdge)})${headSettings(settings)}`,
    );

    return this.emitRoutes(loopId, rest, stop, lines, depth);
  }

  /**
   * The routes the loop pattern did not spend, marked printed before the body
   * is walked so a jump landing on the head reads the same routing it did
   * before; {@link emitRoutes} takes them where the loop leaves off.
   */
  private takeRest(outs: SequenceFlow[]): SequenceFlow[] {
    const rest = this.unconsumed(outs);
    for (const f of rest) this.consumedFlows.add(f.id);
    return rest;
  }

  /**
   * Both fork kinds print one `parallel` block: a head on any branch reads
   * back as the fork that weighs its branches, none anywhere as the one that
   * opens them all. Keyed on the split's id and kind rather than on a gateway:
   * a step whose own routes split reaches the same block with the kind its
   * routes give it, and its head settings are none.
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
   * The fallback heads its branch as `else` whatever it carries: the fork
   * weighs no condition on it, and printing one would put the branch on a run
   * of its own.
   */
  private branchHead(fork: Fork, flow: SequenceFlow): string {
    if (fork.kind !== 'inclusiveGateway') return '';
    if (flow.id === fork.fallbackId) return 'else ';
    return flow.conditionExpression === undefined
      ? ''
      : `if (${renderCondition(flow)}) `;
  }

  /**
   * A condition on it changes nothing, the fork weighing none on its fallback,
   * so it stays implicit; {@link warnFallbackCondition} reports the condition.
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
   * `undefined` for a split naming a route it does not have: the engine looks
   * the name up among the split's routes and raises where it finds none.
   */
  private splitFallbackFlow(splitId: string): SequenceFlow | undefined {
    const fallbackId = this.splitFallbackFlowId(splitId);
    return (this.outgoingBySource.get(splitId) ?? []).find(
      (f) => f.id === fallbackId,
    );
  }

  /**
   * The mirror of {@link warnInventedFallback}: a fallback nothing can reach,
   * written out as an `else` the validator refuses, since the model is where
   * the refusal comes from. Reads the branches that print: a fallback going
   * nowhere but the merge leaves no `else` behind and nothing to report.
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
   * Reported once per split off the model's routes, however the fallback
   * prints. A choice weighs its fallback among the others and the engine
   * refuses to deploy one carrying a condition; a fork and a step skip it while
   * weighing, so there the condition is weighed nowhere.
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
   * Dropped by {@link branchHead}: a condition on a branch is what tells the
   * weighing fork from the opening one, so printing it would read back as the
   * other.
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
   * With a branch ending at a `throw` or `end` the fork has no clean
   * post-dominator, but the survivors still reconverge at a merge of
   * `joinKind`. Each branch contributes, nearest first, the fork-dominated
   * merges of that kind on its post-dominator chain; branches of one fork share
   * no node before reconverging, so the first candidate common to every chain
   * is the join, and nearest keeps the continuation at this fork rather than in
   * a sibling's nested block. `cur !== forkId` rejects a back-edge fork that
   * post-dominates itself.
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
   * Every branch opens on a wait, and the pattern is keyed on the waits alone,
   * so it holds with no merge to return to, the shape of a race whose every
   * branch ends. A branch opening on anything else degrades, every edge keeping
   * a jump or a marker.
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
        // Nothing is written between the wait and its body, so `consume`
        // reports a condition on the edge as on a fall-through.
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
   * `undefined` where the branch is not a wait the block can hold: an
   * already-printed one would print twice, and one that splits has no single
   * body. Reads only, so a sibling missing costs nothing.
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
   * A route printed as plain flow, with no place between the two statements
   * for its condition, which is reported. Every such route goes through here,
   * so the report cannot be forgotten at one of them.
   */
  private consume(flow: SequenceFlow): void {
    this.consumedFlows.add(flow.id);
    if (flow.conditionExpression === undefined) return;
    const warning = this.droppedConditionWarning(flow);
    if (warning !== undefined) this.warnings.push(warning);
  }

  private takeFallThrough(
    flow: SequenceFlow,
    stop: string | undefined,
    lines: string[],
  ): string | typeof STOP {
    this.consume(flow);
    return this.continueAt(flow.targetRef, stop, lines);
  }

  /**
   * Which report a dropped condition takes turns on what reads it: a fork that
   * opens every route and a wait weigh it nowhere, everywhere else the engine
   * reads it. The fallback itself is covered by {@link warnFallbackCondition}.
   * A route beside an unconditioned fallback diverts the run rather than
   * failing it, since the model has the fallback left to leave by; a fallback
   * the split weighs is reported on the split and does not count.
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
        const fallback = this.splitFallbackFlow(sourceId);
        return fallback !== undefined &&
          fallback.conditionExpression === undefined
          ? divertedRunWarning(sourceId)
          : droppedFlowConditionWarning(sourceId);
      }
    }
  }

  /**
   * Returning a merge does not elide it: a synthesized join has one out-edge
   * left once the branch edges are consumed, so `emitNode` passes through it
   * and prints nothing, while a real node at the merge prints its statement.
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
   * The first node with a statement form, the only kind a `goto` can name: a
   * jump into a gateway re-runs its routing, so it means the same as a jump at
   * the successor whenever that routing has one outcome. The walk crosses the
   * single unrealized out-edge, or once all are realized the sole out-edge of a
   * gateway that never had a choice, since consumption records that an edge
   * printed as structured flow, not that it stopped existing. `undefined` for
   * a routing with more than one outcome, a revisited gateway, or a node the
   * emitter drops on print; an unknown id is named verbatim, being a dangling
   * IR reference.
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
        const trigger = renderTrigger(el.eventDefinition, this.names);
        return bracketed(
          `emit ${trigger.head}${this.terminalNameSuffix(el)}`,
          [
            ...trigger.items,
            ...throwBindingSettings(el),
            ...jobSettingItems(el),
          ],
          structuredMembers(el),
        );
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
      case 'scriptTask':
        return renderScriptTask(el, this.names);
      // Printed by `emitNode` (a gateway as a construct, a sub-process and a
      // boundary as a block); listed so the type checker still catches a new
      // kind.
      case 'subProcess':
      case 'boundaryEvent':
      case 'exclusiveGateway':
      case 'parallelGateway':
      case 'inclusiveGateway':
      case 'eventBasedGateway':
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
 * instead of fabricating a target; the warning is the report, the marker the
 * reader's pointer at the place needing repair.
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
 * An edge with no name to jump to takes {@link droppedEdgeWarning}'s marker
 * instead, which is why this one counts no branches.
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

function emptySplitWarning(kind: Gateway['kind'], id: string): PrintWarning {
  const model = {
    // `ParallelGatewayActivityBehavior.execute` leaves by no route and
    // `PvmExecutionImpl.leaveActivityViaTransitions` ends the execution: the
    // whole run at top level, one branch inside a fork.
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

/** Written and reported rather than dropped: the model is where the route comes from. */
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

/** A pathological IR degrades to a `goto` rather than overflowing the stack. */
const MAX_NESTING_DEPTH = 1000;

/**
 * In print order after {@link namedSettings}; the IR field name is the DSL key.
 * Exported so a test can hold it against `PROCESS_HEADER_KEYS`, since a key the
 * vocabulary gains and this table lacks would round-trip with no report.
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

/** The definitions an `end` spells in its own head rather than raising; the word printed is the kind. */
const END_CARRIED_KINDS = new Set<EventDefinition['kind']>(END_TRIGGERS);

/** Read by the print and by the elision, so the two cannot drift. */
function isEndCarried(
  def: EventDefinition,
): def is Extract<EventDefinition, { kind: (typeof END_TRIGGERS)[number] }> {
  return END_CARRIED_KINDS.has(def.kind);
}

/**
 * Whether the id is absent from the printed form, leaving a `goto` nothing to
 * resolve against; `xmlToIr` asks the same question to report the label an
 * elided start or end takes with it, so the two answers cannot drift apart.
 * For a plain end the answer is only that the printer may drop it, `emitNode`
 * and `Emitter.emit` deciding by position whether it does, and
 * `forwardToRealTarget` reads this half alone, so a jump into such an end is
 * dropped and marked whether or not the end ends up printed. The compiler
 * re-derives a dropped start at the body's head and nowhere else, so only the
 * first plain start under `container`'s minted id can go.
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
    case 'intermediateCatchEvent':
      // Spelled through `terminalNameSuffix`, which drops a synthesized id.
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
      // A gateway never writes its id.
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
 * Every reader goes through {@link isElidedOnPrint}: a reason to print
 * reaching one reader but not another would leave a jump naming a statement
 * never emitted. A label is not such a reason: printing the id to carry one
 * writes a name the validator rejects, so the label is reported on import
 * instead.
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

/** In the vocabulary's order, so the parens stay stable across runs; `keyOf` respells each key for a second carrier sharing the parens. */
function jobSettingItems(
  el: JobSettings,
  keyOf: (key: string) => string = (key) => key,
): string[] {
  const text: Record<EngineKey, string | undefined> = {
    asyncBefore: el.asyncBefore === true ? 'true' : undefined,
    asyncAfter: el.asyncAfter === true ? 'true' : undefined,
    exclusive: el.exclusive === false ? 'false' : undefined,
    jobPriority:
      el.jobPriority === undefined
        ? undefined
        : renderNumericValue(el.jobPriority),
    retryCycle: el.retryCycle === undefined ? undefined : quote(el.retryCycle),
  };
  return ENGINE_KEYS.flatMap((key) =>
    text[key] === undefined ? [] : [setting(keyOf(key), text[key])],
  );
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

function renderListener(
  event: string,
  binding: ListenerBinding,
  timer?: Extract<EventDefinition, { kind: 'timer' }>,
): Lines {
  const clause =
    timer !== undefined
      ? ` ${TIMER_PARTICLE_BY_KIND[timer.timerKind]} ${quote(timer.expression)}`
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
 * newline added here would be re-absorbed into the body on re-parse.
 */
function renderFence(format: string, code: string): string {
  return `\`\`\`${format}\n${code}\`\`\``;
}

/**
 * An id carrying the form its own kind is minted with, which the validator
 * refuses in authored source: the exact start and end minted for `container`
 * (and for a boundary escape in it), and the positional `Throw_`/`Catch_`
 * prefixes no modeler writes. An id carrying another kind's template is an
 * authored name and keeps printing; an end answers to the throw prefix too,
 * since `throw` lowers to an end event, and a catch to its own prefix only.
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
 * start when that start prints no statement: the compiler puts them on the
 * start a timer head synthesizes ({@link splitTimerJobSettings}), and a start
 * that prints keeps them on its own line.
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
    ? jobSettingItems(splitTimerJobSettings(start).timer)
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

/**
 * The payload leads the items, so a name, a code and a duration are written
 * the same way wherever a trigger is; a catch binding follows, and the
 * element's own settings after that. A condition prints unquoted, being an
 * expression rather than text.
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
 * lets `error OrderFailed(code: "order.failed")` be raised by a word.
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
  const particle = TIMER_PARTICLE_BY_KIND[def.timerKind];
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

/** A flag is bare and closes the parens, after the payload and the settings. */
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
  for (const key of USER_TASK_VERBATIM_KEYS) {
    const value = el[key];
    if (value === undefined) continue;
    settings.push(
      setting(
        key,
        key === 'priority' ? renderNumericValue(value) : quote(value),
      ),
    );
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

/** The braces are written even with no fields, `form` alone being no rule. */
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

/** `quote`, not `quoteLiteral`: a `${...}` value has to re-lex as a raw expression. */
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

  // Between `businessKey` and the engine settings, the order `CallActivity.own`
  // offers the keys in. Both print through `quote()`: the delegate body has to
  // re-lex as an expression, which `quoteLiteral` would escape.
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

/** The two travel together, so a surface cannot gain one and forget the other. */
function namedSettings(el: Named): string[] {
  return [
    ...(el.name === undefined ? [] : [setting('label', quoteLiteral(el.name))]),
    ...(el.documentation === undefined
      ? []
      : [setting('documentation', quoteLiteral(el.documentation))]),
  ];
}

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

/** The grammar's `ID` terminal: an element variable and a bare collection print by it, and the import refuses by it. */
export const BARE_ELEMENT_VARIABLE = ID_SHAPED;

/**
 * One map per kind, since the two are declared apart, and names claimed across
 * both, since a use site resolves in one scope holding all of them. A code
 * nothing declares still gets a declaration, as `irToXml` still gives it a
 * root: a use site is a bare name, and a hand-built IR would otherwise print
 * source that does not compile.
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
 * types, in first-appearance order. BPMN has no slot for a declaration, so the
 * print declares what it writes in a variable position (a condition, a count,
 * an `until`, an error mapping's `when`, a conditional trigger, an `in` source,
 * a bare collection) minus what the validator's symbol table already holds
 * (`DefaultVariableSymbolProvider.collect`: a form field, a catch binding, an
 * io parameter name, an element variable, and the loop counters once anything
 * repeats); `externalTask` in a mapping and an `out` source are exempt there
 * too. The type is `any` because a read says nothing more, and every
 * declaration of one name has to agree on the type.
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
 * A collection spelled as a plain name prints bare and anything else quotes,
 * because Operaton reads a bare `operaton:collection` as the name of a
 * variable and only a `${...}` body as an expression.
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
 * For a value the engine evaluates, which a body opening with `${` or `#{`
 * has to keep re-lexing as. The grammar reads a raw template with the same
 * escapes as a literal, so one escaper serves both; prose and a declared name
 * take {@link quoteLiteral}.
 */
function quote(value: string): string {
  return `"${escapeQuoted(value)}"`;
}

/**
 * For a value that has to come back byte for byte as text: a label, a form
 * field label, a map key, a declared code. A body opening with `${` or `#{`
 * gets a backslash before the opener so it lexes as a `STRING` rather than a
 * raw template; `\$` and `\#` are not recognized escapes and the reader hands
 * the character back unchanged, which keeps the two exact inverses.
 */
function quoteLiteral(value: string): string {
  const escaped = escapeQuoted(value);
  return `"${/^[$#]\{/.test(escaped) ? '\\' + escaped : escaped}"`;
}
