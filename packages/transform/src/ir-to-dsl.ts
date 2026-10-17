/**
 * IR -> DSL, the inverse of `astToIr`. Dominator patterns (ADR 0014) fold what
 * they can; the rest degrades to `goto`, else an {@link UNSTRUCTURED_MARKER}.
 * Matched gateways are elided: the desugarer derives gateway ids from
 * structural coordinates, so re-parsing re-synthesizes the same ids.
 */

import {
  CALL_MAPPER_KEY_BY_KIND,
  DATE_PATTERN_KEY,
  DOCUMENTATION_KEY,
  ELSE_FAIL_WORD,
  END_TRIGGERS,
  ENGINE_KEYS,
  type EngineKey,
  ERROR_MAPPING_HEAD,
  ERROR_MAPPING_WHEN,
  EXPRESSION_OPEN,
  EXTERNAL_BINDING_KEY,
  EXTERNAL_TASK_EL_NAME,
  FIELD_DIRECTION,
  formatPlainWordList,
  ID_TEXT,
  isPlainName,
  INPUT_DIRECTION,
  isReservedName,
  printName,
  joinSettingKey,
  LOOP_VARIABLES,
  OUTPUT_DIRECTION,
  PROCESS_ENGINE_HEADER_KEYS,
  STARTABLE_KEY,
  PROPERTY_DIRECTION,
  runSettingKey,
  singleTemplateBody,
  TASK_PRIORITY_KEY,
  TIMER_PARTICLE_BY_KIND,
  TYPE_BINDING_KEY,
  USER_TASK_VERBATIM_KEYS,
  VALUE_DOCUMENTATION_KEYS,
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
  boundaryEventIdBase,
  CATCH_EVENT_PREFIX,
  claimDeclarationName,
  claimId,
  isMintedEndId,
  isMintedStartId,
  makeSequenceFlowId,
  THROW_EVENT_PREFIX,
} from './synthesize-ids.js';
import { oneLine } from './errors.js';
import { HISTORY_TIME_TO_LIVE } from './ir-to-xml.js';
import { analyzeCfg, type CfgAnalysis, closure } from './cfg-analysis.js';
import {
  escapeQuoted,
  type JuelNode,
  parseJuel,
  renderRawFallback,
} from './juel.js';

export const INDENT = '  ';

/**
 * One entry per line, except a fenced script body: indenting inside the fence
 * would rewrite the code.
 */
type Lines = string[];

/** Each code's name as printed, keyed by code. */
interface PrintNames {
  error: Map<string, string>;
  escalation: Map<string, string>;
}

export type PrintContainer = Pick<FlowContainer, 'id' | 'flowElements'>;

export type PrintWarningCategory =
  | 'label'
  | 'documentation'
  | 'droppedEdge'
  | 'defaultFlow'
  | 'degradedSplit'
  | 'droppedCondition'
  | 'refusedStatement'
  | 'droppedSetting'
  | 'skippedJoin'
  | 'addedJoin'
  | 'changedJoin'
  | 'nestedFork'
  | 'unreachable';

/** `message` follows the same headline-and-notes shape as an import warning. */
export interface PrintWarning {
  elementId: string;
  category: PrintWarningCategory;
  message: string;
}

export function irToDsl(model: BpmnProcess): {
  source: string;
  warnings: PrintWarning[];
} {
  const warnings: PrintWarning[] = [];
  const process = withNestedForks(
    withoutUnreachable(model, warnings),
    warnings,
  );
  const codes = codeDeclarations(process);
  const names = codes.names;
  warnGatewayText(process, warnings);
  warnRefusedStatements(process, warnings);

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
 * Operaton deploys an element nothing leads to and never runs it, but every
 * statement of a script has a way in, so it would draw "this step can never
 * run". Where a container has no start event, every element without a route in
 * is an entry, as the printer treats it.
 */
function withoutUnreachable<T extends FlowContainer>(
  container: T,
  warnings: PrintWarning[],
): T {
  const { next, lead } = flowGraph(
    container.flowElements,
    container.sequenceFlows,
  );
  const linkName = (el: FlowElement): string | undefined =>
    'eventDefinition' in el && el.eventDefinition?.kind === 'link'
      ? el.eventDefinition.linkName
      : undefined;
  for (const el of container.flowElements) {
    if (el.kind !== 'intermediateThrowEvent' || linkName(el) === undefined) {
      continue;
    }
    for (const other of container.flowElements) {
      if (
        other.kind === 'intermediateCatchEvent' &&
        linkName(other) === linkName(el)
      ) {
        lead(el.id, other.id);
      }
    }
  }
  const hasStart = container.flowElements.some(
    (el) => el.kind === 'startEvent',
  );
  const entries = container.flowElements
    .filter(
      (el) =>
        el.kind === 'startEvent' ||
        isHandler(el) ||
        (!hasStart &&
          !isBoundary(el) &&
          !container.sequenceFlows.some((f) => f.targetRef === el.id)),
    )
    .map((el) => el.id);
  const live = closure(entries, (n) => next.get(n) ?? []);
  const dead = new Set(
    container.flowElements.map((el) => el.id).filter((id) => !live.has(id)),
  );
  for (const id of dead) warnings.push(unreachableWarning(id));
  return {
    ...container,
    flowElements: container.flowElements
      .filter((el) => !dead.has(el.id))
      .map((el) =>
        el.kind === 'subProcess' ? withoutUnreachable(el, warnings) : el,
      ),
    sequenceFlows: container.sequenceFlows.filter(
      (f) => !dead.has(f.sourceRef) && !dead.has(f.targetRef),
    ),
  };
}

function unreachableWarning(elementId: string): PrintWarning {
  return {
    elementId,
    category: 'unreachable',
    message:
      `'${elementId}' was left out of the script, since no route reaches it\n` +
      'note: no start event, boundary event or event handler leads to it, so the engine never runs it\n' +
      'note: the script has no form for a step nothing leads to\n' +
      'note: a start-before-activity on its id finds nothing in the rebuilt process',
  };
}

/**
 * A parallel fork starts every route at once, so routes meeting at a join of
 * their own before the fork's own join can leave from a fork of their own
 * without changing what runs. That gives each join a block of its own to close:
 * the script has no form for a join that takes only some of a block's
 * branches.
 */
function withNestedForks<T extends FlowContainer>(
  container: T,
  warnings: PrintWarning[],
): T {
  const elements = [...container.flowElements];
  const origin = new Map<string, string>();
  let flows = container.sequenceFlows;
  const taken = new Set([...elements, ...flows].map((x) => x.id));
  for (let nested = true; nested;) {
    nested = false;
    for (const fork of elements) {
      if (fork.kind !== 'parallelGateway') continue;
      const outs = flows.filter((f) => f.sourceRef === fork.id);
      const group = ownJoinGroup(fork.id, outs, elements, flows);
      if (group === undefined) continue;
      const inner = claimId(`${fork.id}_fork`, taken);
      const entry = makeSequenceFlowId(fork.id, inner, taken);
      const original = origin.get(fork.id) ?? fork.id;
      if (!origin.has(fork.id) && ![...origin.values()].includes(original)) {
        warnings.push(nestedForkWarning(original));
      }
      origin.set(inner, original);
      elements.splice(elements.indexOf(fork) + 1, 0, {
        kind: 'parallelGateway',
        id: inner,
      });
      flows = flows.flatMap((f) => {
        if (!group.includes(f)) return [f];
        const moved = { ...f, sourceRef: inner };
        return f === group[0]
          ? [{ id: entry, sourceRef: fork.id, targetRef: inner }, moved]
          : [moved];
      });
      nested = true;
      break;
    }
  }
  return {
    ...container,
    flowElements: elements.map((el) =>
      el.kind === 'subProcess' ? withNestedForks(el, warnings) : el,
    ),
    sequenceFlows: flows,
  };
}

function nestedForkWarning(forkId: string): PrintWarning {
  return {
    elementId: forkId,
    category: 'nestedFork',
    message:
      `gateway '${forkId}' was printed as nested 'parallel' blocks\n` +
      "note: the script has no form for a join that takes only some of a block's branches\n" +
      'note: the rebuilt process adds a fork ahead of the routes each such join takes\n' +
      'note: every route still starts at once and each join waits for the same routes, so the process runs the same',
  };
}

/**
 * The routes out of `forkId` that all run into one parallel join and nowhere
 * else, when some other route runs into a different join. A join whose every
 * route in starts inside one route's region belongs to that route.
 */
function ownJoinGroup(
  forkId: string,
  outs: readonly SequenceFlow[],
  elements: readonly FlowElement[],
  flows: readonly SequenceFlow[],
): SequenceFlow[] | undefined {
  if (outs.length < 3) return undefined;
  const { next, prev } = flowGraph(elements, flows);
  const joins = new Set(
    elements
      .filter(
        (el) =>
          el.kind === 'parallelGateway' && (prev.get(el.id)?.length ?? 0) > 1,
      )
      .map((el) => el.id),
  );
  const routes = outs.map((f) => {
    const region = new Set([f.targetRef]);
    const exits = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      exits.clear();
      for (const n of region) {
        for (const m of next.get(n) ?? []) {
          if (region.has(m) || m === forkId) continue;
          if (joins.has(m) && !prev.get(m)!.every((p) => region.has(p))) {
            exits.add(m);
          } else {
            region.add(m);
            grew = true;
          }
        }
      }
    }
    return { f, region, exits: [...exits] };
  });
  const joinedAlone = (join: string) =>
    routes.filter((r) => r.exits.length === 1 && r.exits[0] === join);
  for (const join of new Set(routes.flatMap((r) => r.exits))) {
    const group = joinedAlone(join);
    if (
      group.length >= 2 &&
      group.length < routes.length &&
      prev.get(join)!.every((p) => group.some((r) => r.region.has(p))) &&
      routes.some((r) => r.exits.some((e) => e !== join))
    ) {
      return group.map((r) => r.f);
    }
  }
  return undefined;
}

/** Flows plus the hop from each boundary event's host into it. */
function flowGraph(
  elements: readonly FlowElement[],
  flows: readonly SequenceFlow[],
) {
  const next = new Map<string, string[]>();
  const prev = new Map<string, string[]>();
  const lead = (from: string, to: string): void => {
    next.set(from, [...(next.get(from) ?? []), to]);
    prev.set(to, [...(prev.get(to) ?? []), from]);
  };
  for (const f of flows) lead(f.sourceRef, f.targetRef);
  for (const el of elements) if (isBoundary(el)) lead(el.attachedToRef, el.id);
  return { next, prev, lead };
}

const GATEWAY_HAS_NO_STATEMENT = [
  'note: the script derives every split and every merge from its block ' +
    'structure, so no statement here carries it',
  'note: the process runs the same without it',
];

/**
 * Gateways only: `xmlToIr` reports every other elided label, so a wider rule
 * would report it twice.
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
        message: [
          `label '${oneLine(el.name)}' on gateway '${el.id}' was not written to the script`,
          ...GATEWAY_HAS_NO_STATEMENT,
        ].join('\n'),
      });
    }
    if (el.documentation !== undefined) {
      warnings.push({
        elementId: el.id,
        category: 'documentation',
        message: [
          `documentation on gateway '${el.id}' was not written to the script`,
          ...GATEWAY_HAS_NO_STATEMENT,
        ].join('\n'),
      });
    }
  }
}

/**
 * A synthesized end printed for its position is reported by the emitter, which
 * alone knows the position.
 */
function warnRefusedStatements(
  container: FlowContainer,
  warnings: PrintWarning[],
  startTriggerSuppressed = false,
): void {
  for (const el of container.flowElements) {
    if (
      !isElidedOnPrint(el, container, startTriggerSuppressed) &&
      isReservedName(el.id, container.id)
    ) {
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
      `step '${elementId}' has a name the script keeps for the names it derives itself\n` +
      'note: the printed script draws an error there when it is read back\n' +
      'help: rename the step in the model and print it again',
  };
}

interface Branch {
  route: SequenceFlow;
  join: string | undefined;
  ownEntry?: string;
  outer?: Branch;
}

/**
 * One per container: the parent's CFG treats a sub-process as one opaque node.
 */
class Emitter {
  private readonly cfg: CfgAnalysis;
  private readonly byId = new Map<string, FlowElement>();
  /** IR order keeps emission deterministic. */
  private readonly outgoingBySource = new Map<string, SequenceFlow[]>();
  private readonly emittedNodes = new Set<string>();
  private readonly consumedFlows = new Set<string>();
  private readonly settingsTaken = new Set<string>();
  /**
   * Each statement's `await`/`parallel` branch path, `''` outside any. Jumps
   * are checked after the walk, since a jump can precede its target.
   */
  private readonly branchOf = new Map<string, string>();
  private branchPath = '';
  /**
   * Innermost branch being walked. `ownEntry` is set only for an if-chain
   * branch, whose first statement a sibling's `goto` may target; an
   * `await`/`parallel` branch entry is reachable only from its own split.
   */
  private branch: Branch | undefined;
  private readonly jumps: { target: string; branchPath: string }[] = [];
  private readonly deferredEnds: {
    lines: string[];
    index: number;
    stmt: Lines;
    id: string;
  }[] = [];
  /**
   * The minted plain end the print leaves out, unless a chain hoisted behind it
   * forces it to print.
   */
  private readonly elidedTail: string | undefined;
  private readonly linkedCatch: ReadonlyMap<string, string>;
  private readonly adjoinedHops = new Set<string>();
  private readonly skippedJoins = new Set<string>();
  private readonly ownMerges: ReadonlyMap<string, string>;
  /** The back edges that close a do-while on their gateway's test. */
  private readonly doWhileTests: ReadonlySet<SequenceFlow>;

  constructor(
    private readonly container: FlowContainer,
    private readonly warnings: PrintWarning[],
    private readonly names: PrintNames,
    /** An event sub-process prints its start trigger in the `on` header. */
    private readonly startTriggerSuppressed = false,
  ) {
    this.elidedTail = container.flowElements.find(
      (el) =>
        el.kind === 'endEvent' &&
        el.eventDefinition === undefined &&
        isMintedEndId(el.id, container.id, []) &&
        isElidedOnPrint(el, container),
    )?.id;
    for (const el of container.flowElements) {
      // The desugarer resolves collisions, so a duplicate means malformed IR.
      if (this.byId.has(el.id)) {
        throw new Error(
          `irToDsl: duplicate flow element id '${el.id}' in container '${container.id}'.`,
        );
      }
      this.byId.set(el.id, el);
    }
    for (const f of container.sequenceFlows) {
      const list = this.routesOut(f.sourceRef);
      list.push(f);
      this.outgoingBySource.set(f.sourceRef, list);
    }
    this.linkedCatch = linkedCatches(container, this.elidedTail);
    // The throw -> catch hop counts as a route in every shape predicate, so a
    // branch ending in the throw reads as continuing where its catch goes.
    this.cfg = analyzeCfg(withLinkHops(container, this.linkedCatch));
    this.doWhileTests = new Set(
      this.cfg.backEdges().filter((f) => this.isDoWhileTest(f)),
    );
    this.ownMerges = this.pairMerges();
  }

  /**
   * Walking up the dominator tree from a merge, each split passed is closed by
   * a merge passed earlier; the first split left open owns it. Loop heads and
   * do-while tests open and close nothing. Of several merges a split collects,
   * the one nearest it wins. A merge entered from outside its split has no
   * owner.
   */
  private pairMerges(): Map<string, string> {
    const loopEnds = new Set(
      this.cfg.backEdges().flatMap((f) => {
        if (this.doWhileTests.has(f)) return [f.sourceRef];
        const isWhileHead =
          f.conditionExpression === undefined &&
          this.successors(f.targetRef).length > 1;
        return isWhileHead ? [f.targetRef] : [];
      }),
    );
    const routes = (n: string): number =>
      loopEnds.has(n) ? 0 : this.successors(n).length;
    const isMerge = (n: string): boolean => !loopEnds.has(n) && this.isMerge(n);
    const idom = (n: string) => this.cfg.loopImmediateDominator(n);
    const nests = (outer: string, split: string): boolean =>
      outer !== split && this.cfg.loopDominates(outer, split);

    const owner = new Map<string, string>();
    for (const el of this.container.flowElements) {
      if (!isMerge(el.id)) continue;
      let open = 0;
      let n = idom(el.id);
      for (; n !== undefined; n = idom(n)) {
        if (isMerge(n)) open++;
        else if (routes(n) > 1 && open-- === 0) break;
      }
      if (
        n !== undefined &&
        this.cfg.incoming(el.id).every((p) => this.cfg.loopDominates(n, p))
      ) {
        owner.set(el.id, n);
      }
    }
    const mergeOf = (split: string): string | undefined =>
      [...owner].find(([, s]) => s === split)?.[0];

    // A goto into a nested branch makes the outer split dominate the nested
    // merge, so the count above misassigns it. The nested split keeps the merge
    // its routes fall into and the outer split takes the next; innermost first.
    const fallsInto = (from: string, split: string): string | undefined => {
      const seen = new Set<string>();
      for (let n: string | undefined = from; n !== undefined;) {
        if (n === split || seen.has(n)) return undefined;
        seen.add(n);
        const closes = owner.get(n);
        if (isMerge(n) && (closes === undefined || !nests(split, closes))) {
          return n;
        }
        const past: string | undefined =
          routes(n) === 1 ? n : routes(n) > 1 ? mergeOf(n) : undefined;
        n = past === undefined ? undefined : this.successors(past)[0];
      }
      return undefined;
    };
    const depth = (n: string): number => {
      let d = 0;
      for (let m = idom(n); m !== undefined; m = idom(m)) d++;
      return d;
    };
    const unpaired = this.container.flowElements
      .map((el) => el.id)
      .filter((n) => routes(n) > 1 && mergeOf(n) === undefined)
      .sort((a, b) => depth(b) - depth(a));
    for (const split of unpaired) {
      const reached = new Set(
        this.successors(split).map((t) => fallsInto(t, split)),
      );
      reached.delete(undefined);
      const [merge] = reached;
      const outer = merge === undefined ? undefined : owner.get(merge);
      if (reached.size !== 1 || outer === undefined || !nests(outer, split)) {
        continue;
      }
      owner.set(merge!, split);
      const next = fallsInto(this.successors(merge!)[0]!, outer);
      if (next !== undefined && (owner.get(next) ?? outer) === outer) {
        owner.set(next, outer);
      }
    }

    const merges = new Map<string, string>();
    for (const [merge, split] of owner) {
      const held = merges.get(split);
      if (held === undefined || depth(merge) < depth(held)) {
        merges.set(split, merge);
      }
    }
    return merges;
  }

  /**
   * The split's own merge if unprinted, of the given kind, and reached before
   * `stop`.
   */
  private ownJoin(
    splitId: string,
    outs: readonly SequenceFlow[],
    stop: string | undefined,
    kind?: Gateway['kind'],
  ): string | undefined {
    const merge = this.ownMerges.get(splitId);
    if (
      merge === undefined ||
      this.emittedNodes.has(merge) ||
      (kind !== undefined && this.byId.get(merge)?.kind !== kind) ||
      this.entersUnprintedLoop(splitId, merge) ||
      // One route reaching it suffices; the rest print inside their branches.
      !outs.some((f) => this.reachable(f.targetRef, splitId, stop).has(merge))
    ) {
      return undefined;
    }
    const runsPast = outs.some((f) =>
      [...this.reachableInRegion(f.targetRef, splitId, merge)].some(
        (n) =>
          n !== merge &&
          this.isGatewayId(n) &&
          !this.cfg.loopDominates(splitId, n),
      ),
    );
    return runsPast ? undefined : merge;
  }

  /**
   * The pass that walks a node first owns it in the print. Entry chains print
   * before boundary handlers, so a handler jumping into one takes a `goto`;
   * handlers print before the orphan sweep, which would detach their chains.
   */
  emit(): string[] {
    const lines: string[] = [];

    // 1. The elided start first: the compiler re-derives it only at the head
    //    of a body that opens with no `start`.
    for (const el of this.container.flowElements) {
      if (
        el.kind === 'startEvent' &&
        isElidedOnPrint(el, this.container, this.startTriggerSuppressed) &&
        !this.emittedNodes.has(el.id)
      ) {
        this.emitFrom(el.id, undefined, lines, 0);
      }
    }
    // A chain printed after the one reaching the elided end pushes that end
    // off the tail, where it prints under its reserved id, so starts reaching
    // the tail go last.
    const tail = this.elidedTail;
    const reachesTail = (
      el: Extract<FlowElement, { kind: 'startEvent' }>,
    ): boolean =>
      tail !== undefined &&
      !isElidedOnPrint(el, this.container, this.startTriggerSuppressed) &&
      this.reachable(el.id, undefined, undefined).has(tail);
    const starts = this.container.flowElements
      .filter((el) => el.kind === 'startEvent')
      .toSorted((a, b) => Number(reachesTail(a)) - Number(reachesTail(b)));
    for (const el of starts) {
      if (!this.emittedNodes.has(el.id)) this.emitStartGroup(el, lines);
    }

    // 2. Every entry-reached chain pass 1 left for a jump.
    const owned = this.reachableFromEntries();
    this.sweepChains(owned, lines);

    // 3. Boundary handlers must follow the body they guard. Keyed by element
    //    index so pass 6 interleaves them with event sub-processes in model
    //    order.
    const boundaries = this.container.flowElements.flatMap((el, index) => {
      if (!isBoundary(el) || this.emittedNodes.has(el.id)) return [];
      const block: string[] = [];
      this.emitBoundaryHandler(el, block, 0);
      const base = boundaryEventIdBase(
        el.attachedToRef,
        renderTrigger(el.eventDefinition, this.names).head,
      );
      return [{ index, base, rank: boundaryIdRank(el.id, base), block }];
    });
    const boundaryBlocks = new Map(boundaries.map((b) => [b.index, b.block]));
    // Boundaries sharing a host and trigger mint ids by statement order (base,
    // `_2`, `_3`, ...), so each group's blocks are reordered across its own
    // slots by rank; model order would swap the ids on the next compile.
    for (const group of Map.groupBy(boundaries, (b) => b.base).values()) {
      const slots = group.map((m) => m.index).toSorted((a, b) => a - b);
      // Two authored ids (both rank Infinity) tie and keep model order.
      const byRank = [...group].sort((a, b) =>
        a.rank === b.rank ? 0 : a.rank - b.rank,
      );
      slots.forEach((slot, i) => boundaryBlocks.set(slot, byRank[i]!.block));
    }

    // 4. Orphans: a cycle no entry reaches, and what a handler left for a jump.
    this.sweepChains(
      new Set(
        this.container.flowElements
          .filter((el) => !isHandler(el) && !isBoundary(el))
          .map((el) => el.id),
      ),
      lines,
    );

    // 5. Every route left becomes a jump; `consume` reports a dropped
    //    condition.
    for (const f of this.container.sequenceFlows) {
      if (!this.consumedFlows.has(f.id)) {
        this.consume(f);
        this.pushGoto(f.targetRef, lines);
      }
    }

    // A synthesized end stays elided only at its block's tail, the one place
    // the compiler re-derives it, which is known only now. Handlers appended
    // below do not count as following it. Reverse order keeps indices valid.
    const printedEnds: string[] = [];
    for (const d of this.deferredEnds.toReversed()) {
      if (d.index >= d.lines.length) continue;
      d.lines.splice(d.index, 0, ...d.stmt);
      printedEnds.unshift(d.id);
    }
    for (const id of printedEnds) this.warnings.push(reservedNameWarning(id));

    // 6. Handlers in model order: the compiler numbers an event sub-process by
    //    statement index, so any other order renumbers it.
    this.container.flowElements.forEach((el, index) => {
      const block = boundaryBlocks.get(index);
      if (block !== undefined) lines.push(...block);
      if (isHandler(el) && !this.emittedNodes.has(el.id)) {
        this.emitHandler(el, lines);
      }
    });

    // Swept after the walk: an elided pass-through or a jump forwarded through
    // a gateway has no site to report at, and a leftover merge can still open
    // the next statement.
    for (const el of this.container.flowElements) {
      if (
        isGateway(el) &&
        !this.settingsTaken.has(el.id) &&
        jobSettingItems(el).length > 0
      ) {
        this.warnings.push(droppedSettingWarning(el.id));
      }
    }

    // The validator refuses a `goto` into an `await`/`parallel` branch from
    // outside that branch.
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
   * Prints every unprinted node of `pool`. Each walk starts at a chain head
   * (every predecessor in `pool` printed), else in a cycle at a node a printed
   * one flows into; model order breaks ties. Started mid-chain, a walk would
   * print the tail first and need a `goto` into it, which a synthesized throw
   * or catch cannot take.
   */
  private sweepChains(pool: ReadonlySet<string>, lines: string[]): void {
    const leftover = () =>
      this.container.flowElements.filter(
        (el) => pool.has(el.id) && !this.emittedNodes.has(el.id),
      );
    const preds = (el: FlowElement) => this.cfg.incoming(el.id);
    for (let rest = leftover(); rest.length > 0; rest = leftover()) {
      const head =
        rest.find((el) =>
          preds(el).every((p) => !pool.has(p) || this.emittedNodes.has(p)),
        ) ??
        rest.find((el) => preds(el).some((p) => this.emittedNodes.has(p))) ??
        rest[0]!;
      if (this.settlesAsJump(head.id)) continue;
      const before = this.emittedNodes.size;
      this.emitFrom(head.id, undefined, lines, 0);
      // No progress means malformed IR; without this the loop never ends.
      if (this.emittedNodes.size === before) {
        throw new Error(
          `irToDsl: walking '${head.id}' in container '${this.container.id}' printed nothing.`,
        );
      }
    }
  }

  /**
   * A `goto` never names a gateway, so every route into a chain head that is
   * one prints as a jump forwarded through it. When that forward lands on a
   * printed node, walking the head would only add a jump nothing reaches.
   */
  private settlesAsJump(id: string): boolean {
    if (!this.isGatewayId(id)) return false;
    const real = this.forwardToRealTarget(id, new Set());
    if (real === undefined || !this.emittedNodes.has(real)) return false;
    this.emittedNodes.add(id);
    for (const f of this.routesOut(id)) this.consumedFlows.add(f.id);
    return true;
  }

  private emitStartGroup(
    start: Extract<FlowElement, { kind: 'startEvent' }>,
    lines: string[],
  ): void {
    const route = this.soleRoute(start.id);
    if (route === undefined) {
      this.emitFrom(start.id, undefined, lines, 0);
      return;
    }
    this.emitStartsInto(route.targetRef, lines);
    this.emitFrom(route.targetRef, undefined, lines, 0);
  }

  /**
   * Starts written back to back all enter the next statement. Walked one at a
   * time, the second would `goto` the step, which fails for an elided end.
   */
  private emitStartsInto(step: string, lines: string[]): void {
    for (const el of this.startsInto(step)) {
      this.emittedNodes.add(el.id);
      this.branchOf.set(el.id, this.branchPath);
      lines.push(
        ...renderStartEvent(el, this.startTriggerSuppressed, this.names),
      );
      this.consume(this.soleRoute(el.id)!);
    }
  }

  private startsInto(
    step: string,
  ): Extract<FlowElement, { kind: 'startEvent' }>[] {
    return this.container.flowElements.filter(
      (el): el is Extract<FlowElement, { kind: 'startEvent' }> =>
        el.kind === 'startEvent' &&
        !this.emittedNodes.has(el.id) &&
        this.soleRoute(el.id)?.targetRef === step,
    );
  }

  /**
   * A link hop counts only for throws in `adjoinedHops`, whose catch already
   * printed right behind them; unlike {@link reachable}, other hops are not
   * crossed.
   */
  private flowsOnTo(from: string, to: string): boolean {
    return closure(
      [from],
      (n) =>
        this.adjoinedHops.has(n) ? this.successors(n) : this.modelSuccessors(n),
      to,
    ).has(to);
  }

  /**
   * Nodes reachable from a start or an unentered node. Boundaries are excluded
   * (the handler owns its chain), and so is a catch printed behind its throw.
   */
  private reachableFromEntries(): Set<string> {
    const entered = new Set([
      ...this.container.sequenceFlows.map((f) => f.targetRef),
      ...this.linkedCatch.values(),
    ]);
    const entries = this.container.flowElements
      .filter(
        (el) =>
          !isBoundary(el) &&
          !isHandler(el) &&
          (el.kind === 'startEvent' || !entered.has(el.id)),
      )
      .map((el) => el.id);
    return closure(entries, (n) => this.successors(n));
  }

  /** Includes the hop from a link throw into the catch printed behind it. */
  private successors(id: string): string[] {
    const next = this.modelSuccessors(id);
    const linked = this.linkedCatch.get(id);
    return linked === undefined ? next : [...next, linked];
  }

  private modelSuccessors(id: string): string[] {
    return this.routesOut(id).map((f) => f.targetRef);
  }

  private routesOut(id: string): SequenceFlow[] {
    return this.outgoingBySource.get(id) ?? [];
  }

  private isGatewayId(id: string): boolean {
    const el = this.byId.get(id);
    return el !== undefined && isGateway(el);
  }

  /** A join that waits for more than one route before it lets the run on. */
  private isSynchronizing(id: string): boolean {
    const kind = this.byId.get(id)?.kind;
    return (
      (kind === 'parallelGateway' || kind === 'inclusiveGateway') &&
      this.cfg.incoming(id).length > 1
    );
  }

  /** A gateway with one route out: where the compiler closes a block. */
  private isMerge(id: string): boolean {
    return this.isGatewayId(id) && this.successors(id).length === 1;
  }

  private soleRoute(id: string): SequenceFlow | undefined {
    const outs = this.routesOut(id);
    return outs.length === 1 ? outs[0] : undefined;
  }

  /**
   * A loop hands its leftover routes to a choice chain under its own id, so
   * take once.
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
   * Only an unprinted one-route merge, the shape the compiler re-synthesizes.
   * Counts model routes, not unconsumed ones: an enclosing loop consumes a
   * tail merge's back edge before the body is walked.
   */
  private takeJoinSettings(join: string | undefined): string[] {
    if (join === undefined) return [];
    const el = this.byId.get(join);
    if (
      el === undefined ||
      !isGateway(el) ||
      this.emittedNodes.has(join) ||
      this.settingsTaken.has(join) ||
      this.routesOut(join).length !== 1
    ) {
      return [];
    }
    this.settingsTaken.add(join);
    return jobSettingItems(el, joinSettingKey);
  }

  private blockSettings(splitId: string, join: string | undefined): string[] {
    return [...this.takeHeadSettings(splitId), ...this.takeJoinSettings(join)];
  }

  private unconsumed(flows: readonly SequenceFlow[]): SequenceFlow[] {
    return flows.filter((f) => !this.consumedFlows.has(f.id));
  }

  private unconsumedOut(id: string): SequenceFlow[] {
    return this.unconsumed(this.routesOut(id));
  }

  private emitHandler(
    handler: Extract<FlowElement, { kind: 'subProcess' }>,
    lines: string[],
  ): void {
    this.emittedNodes.add(handler.id);
    pushBlock(
      lines,
      buildOnHeader(handler, this.names),
      new Emitter(handler, this.warnings, this.names, true).emit(),
    );
  }

  /**
   * A boundary body shares this container's state, so a rejoining chain
   * degrades to a `goto` like any other.
   */
  private emitBoundaryHandler(
    boundary: Extract<FlowElement, { kind: 'boundaryEvent' }>,
    lines: string[],
    depth: number,
  ): void {
    this.emittedNodes.add(boundary.id);
    const body: string[] = [];
    const next = this.followLinear(boundary.id, undefined, body, depth);
    if (next !== STOP) this.emitFrom(next, undefined, body, depth);
    pushBlock(lines, buildBoundaryHeader(boundary, this.names), body);
  }

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
    let guard = this.byId.size + 1;
    while (current !== undefined && current !== stop && guard-- > 0) {
      // A start whose step reaches the elided end prints right before that
      // step. Nothing may flow into a start, so a live chain reaching the step
      // closes with a `goto` first, except into the elided end, which takes
      // none.
      if (
        depth === 0 &&
        this.elidedTail !== undefined &&
        this.startsInto(current).length > 0 &&
        this.reachable(current, undefined, undefined).has(this.elidedTail)
      ) {
        const flowsOn =
          node !== undefined &&
          current !== node &&
          this.flowsOnTo(node, current);
        if (!flowsOn) this.emitStartsInto(current, lines);
        else if (current !== this.elidedTail) {
          this.pushGoto(current, lines);
          this.emitStartsInto(current, lines);
        }
      }
      if (
        this.emittedNodes.has(current) ||
        (this.branch !== undefined && this.leavesInnermostBranch(current))
      ) {
        this.pushGoto(current, lines);
        return;
      }
      const next = this.emitNode(current, stop, lines, depth);
      if (next === STOP) return;
      if (this.linkedCatch.get(current) === next)
        this.adjoinedHops.add(current);
      current = next;
    }
  }

  /**
   * An if-chain branch only forbids carrying an enclosing block's tail into it.
   * The nearest `await`/`parallel` ancestor, shadowed by if-chain branches in
   * `this.branch`, is found through `outer`: no `goto` may enter it from
   * outside.
   */
  private leavesInnermostBranch(current: string): boolean {
    const branch = this.branch!;
    if (
      this.liesOutsideBranch(
        current,
        branch.route,
        branch.join,
        branch.ownEntry === undefined,
      ) &&
      (branch.ownEntry === undefined ||
        this.reachesEnclosingJoin(current, branch))
    ) {
      return true;
    }
    if (branch.ownEntry === undefined) return false;
    let ancestor = branch.outer;
    while (ancestor !== undefined && ancestor.ownEntry !== undefined) {
      ancestor = ancestor.outer;
    }
    return (
      ancestor !== undefined &&
      this.liesOutsideBranch(current, ancestor.route, ancestor.join, true)
    );
  }

  /**
   * Whether `node` is also entered from outside the branch without leading back
   * in. The validator refuses a `goto` into a branch from outside, so the
   * branch jumps out and the outside walk prints the node. A node leading into
   * `join` stays in the branch, since no outside placement is valid, unless
   * the branch is an `await`/`parallel` one entered from a node the fork never
   * reaches, with no way back to the fork: printed behind that node, it takes
   * the branch's `goto`, which leads out of the branch rather than in.
   */
  private liesOutsideBranch(
    node: string,
    route: SequenceFlow,
    join: string | undefined,
    forkBranch: boolean,
  ): boolean {
    const fork = route.sourceRef;
    const first = route.targetRef;
    const outside = this.cfg
      .incoming(node)
      .filter(
        (p) =>
          !this.cfg.loopDominates(first, p) && !(p === fork && node === first),
      );
    if (outside.length === 0) return false;
    if (
      join === undefined ||
      !this.reachable(node, fork, undefined).has(join)
    ) {
      return true;
    }
    if (!forkBranch || this.reachable(node, undefined, fork).has(fork)) {
      return false;
    }
    const fromFork = this.reachable(fork, undefined, undefined);
    return outside.some((p) => !fromFork.has(p));
  }

  /**
   * Whether `p` lies in a fork/race branch that must jump to `entry`. The fork
   * is not printed yet, so its own merge stands in for its join.
   */
  private jumpsOutOfBranch(p: string, entry: string): boolean {
    let route = this.forkRoute(p, entry);
    for (let d = p; route === undefined && !this.cfg.loopDominates(d, entry);) {
      const split = this.cfg.loopImmediateDominator(d);
      if (split === undefined) return false;
      route = this.forkRoute(split, d);
      d = split;
    }
    return (
      route !== undefined &&
      this.liesOutsideBranch(
        entry,
        route,
        this.ownMerges.get(route.sourceRef),
        true,
      )
    );
  }

  /**
   * Whether `node`, reached in an if-chain branch, runs into or lies past an
   * enclosing block's join, so printing it here would carry that block's tail
   * into the branch. Steps on a cycle through the branch entry are the
   * branch's own loop and do not count. Walks exclude the enclosing split, or a
   * loop around the block would pull every node past the join. Only a merge
   * gateway counts as reaching a join.
   */
  private reachesEnclosingJoin(node: string, branch: Branch): boolean {
    if (branch.join !== undefined) {
      const split = branch.route.sourceRef;
      const entry = branch.route.targetRef;
      const loops = this.cyclesThroughEntry(entry, split);
      const after = this.reachable(
        branch.join,
        split,
        undefined,
        (n) => !loops(n),
      );
      if (
        after.has(node) &&
        !loops(node) &&
        this.cfg.postDominates(node, branch.join)
      ) {
        return true;
      }
    }
    for (let b = branch.outer; b !== undefined; b = b.outer) {
      if (b.join === undefined) continue;
      const split = b.route.sourceRef;
      const seen = this.reachable(
        node,
        branch.route.sourceRef,
        undefined,
        (n) => n !== split,
      );
      if (this.isGatewayId(b.join) && seen.has(b.join)) return true;
      const entry = branch.route.targetRef;
      const walled = !this.wallStaysOff(entry, b.join, split);
      const past = this.reachable(
        b.join,
        split,
        undefined,
        (n) => !walled || n !== entry,
      );
      if (past.has(node) && !(walled && node === entry)) return true;
    }
    return false;
  }

  /** Whether `n` lies on a cycle through `entry` inside `split`'s region. */
  private cyclesThroughEntry(
    entry: string,
    split: string,
  ): (n: string) => boolean {
    const fromEntry = this.reachable(entry, split, undefined);
    return (n) =>
      fromEntry.has(n) && this.reachable(n, split, undefined).has(entry);
  }

  /**
   * A wall at `entry` hides nothing when `entry` post-dominates `join`, or
   * when flow past `join` loops back into `entry` anyway.
   */
  private wallStaysOff(entry: string, join: string, split: string): boolean {
    if (this.cfg.postDominates(entry, join)) return true;
    const beforeEntry = this.reachable(
      join,
      split,
      undefined,
      (n) => n !== entry,
    );
    const loops = this.cyclesThroughEntry(entry, split);
    return this.cfg
      .incoming(entry)
      .some((p) => p !== entry && beforeEntry.has(p) && loops(p));
  }

  private forkRoute(split: string, target: string): SequenceFlow | undefined {
    const kind = this.byId.get(split)?.kind;
    if (
      (kind !== 'parallelGateway' &&
        kind !== 'inclusiveGateway' &&
        kind !== 'eventBasedGateway') ||
      this.successors(split).length < 2 ||
      this.ownMerges.get(split) === target
    ) {
      return undefined;
    }
    return this.routesOut(split).find((f) => f.targetRef === target);
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

    // A do-while body entry is reached before its loop gateway, so recognize it
    // here or the body prints ahead of the loop and degrades.
    const doWhile = this.tryDoWhileEntry(id, stop, lines, depth);
    if (doWhile !== undefined) return doWhile;

    // Model routes: a construct may hand down an empty leftover list.
    if (isGateway(el) && this.routesOut(id).length === 0) {
      this.emittedNodes.add(id);
      this.warnings.push(emptySplitWarning(el.kind, id));
      return STOP;
    }

    // A gateway has no statement to jump from, so the final sweep cannot cover
    // it: every out-edge is captured here.
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
      // The import refuses a flow into an event sub-process: malformed IR.
      if (el.triggeredByEvent === true) {
        throw new Error(
          `irToDsl: event sub-process '${id}' in container '${this.container.id}' is reached through a flow edge; a handler is entered by its trigger alone.`,
        );
      }
      this.emittedNodes.add(id);
      const head = el.element === 'transaction' ? 'attempt' : 'subprocess';
      pushBlock(
        lines,
        bodyHeader(
          `${head} ${printName(id)}${repeatClause(el)}`,
          [...namedSettings(el), ...engineSettings(el)],
          structuredMembers(el),
        ),
        new Emitter(el, this.warnings, this.names).emit(),
      );
      return this.followLinear(id, stop, lines, depth);
    }

    // A malformed boundary with inbound flow prints here rather than being
    // lost.
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
      // The compiler never mints an end inside a branch or loop body, so one
      // there prints; a top-level one is settled in `emit`.
      if (depth > 0) {
        lines.push(...stmt);
        this.warnings.push(reservedNameWarning(id));
      } else {
        this.deferredEnds.push({ lines, index: lines.length, stmt, id });
      }
    } else if (stmt !== undefined) {
      lines.push(...stmt);
    }
    const linked = this.linkedCatch.get(id);
    if (linked !== undefined) return linked;
    return this.followLinear(id, stop, lines, depth);
  }

  /**
   * Several routes out of a step fork: Operaton's `performOutgoingBehavior`
   * takes every route whose condition holds or that has none, and the default
   * only when none was taken, i.e. inclusive semantics (parallel with no
   * conditions or default). One condition beside the default acts as a choice.
   * Reads model routes: one an enclosing loop already consumed still fires.
   */
  private followLinear(
    id: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    const outs = this.routesOut(id);
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

  /** Keyed on the id: a step whose own routes split has no gateway node. */
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
   * Routes are passed in so loop emitters can hand over the ones they did not
   * spend.
   */
  private emitRoutes(
    splitId: string,
    outs: SequenceFlow[],
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.warnFallbackCondition(splitId);

    if (outs.length === 0) return STOP;
    if (outs.length === 1) {
      const only = outs[0]!;
      if (!this.leavesBesideStop(splitId, only, stop)) {
        return this.takeFallThrough(only, stop, lines);
      }
      this.consumedFlows.add(only.id);
      this.emitIfChain(
        [only],
        [],
        undefined,
        stop,
        splitId,
        this.takeHeadSettings(splitId),
        lines,
        depth,
      );
      return STOP;
    }

    const { fallback, conditioned, unconditioned } = this.weighRoutes(
      splitId,
      outs,
    );
    const fails = this.failsWithoutMatch(splitId);

    const found =
      this.ownJoin(splitId, outs, stop) ??
      this.cleanJoin(splitId, outs, stop) ??
      this.convergence(splitId, outs, stop) ??
      this.guardClauseContinuation(unconditioned) ??
      this.enclosingContinuation(splitId, outs, stop);
    const noMatch =
      found === undefined
        ? this.noMatchContinuation(splitId, outs, stop)
        : undefined;
    // Operaton tries the routes in document order, so only the last one can
    // lose its condition without changing which route a holding condition
    // takes, and under `else fail` none can: it prints as an empty branch.
    const fallThrough = !fails && noMatch === outs.at(-1) ? noMatch : undefined;
    const join = found ?? noMatch?.targetRef;

    for (const f of outs) this.consumedFlows.add(f.id);
    this.emitIfChain(
      conditioned.filter((f) => f !== fallThrough),
      unconditioned,
      fallback,
      join,
      splitId,
      this.blockSettings(splitId, join),
      lines,
      depth,
      fails,
    );

    return join !== undefined ? this.continueAt(join, stop, lines) : STOP;
  }

  /**
   * Whether the split's default runs straight into `stop` beside `route`, so
   * the block end stands for it and `route` keeps its `if`. Only the default
   * qualifies: another unconditioned route could fire alongside `route`.
   */
  private leavesBesideStop(
    splitId: string,
    route: SequenceFlow,
    stop: string | undefined,
  ): boolean {
    return (
      route.conditionExpression !== undefined &&
      this.routesOut(splitId).some(
        (o) =>
          o !== route &&
          o.targetRef === stop &&
          o.conditionExpression === undefined &&
          o.id === this.splitFallbackFlowId(splitId),
      )
    );
  }

  /**
   * The `else` goes to the fallback, else the route into the join (a `true`
   * head over that empty branch would make the rest unreachable), else the
   * last unconditioned route; other unconditioned routes head as `true`.
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
    fails = false,
  ): void {
    // Operaton takes the first route in document order that has no condition
    // or one that holds, so the heads keep that order and only a route listed
    // after every condition can be the `else`.
    const order = this.routesOut(splitId);
    const lastWeighed = Math.max(-1, ...weighed.map((f) => order.indexOf(f)));
    const trailing = unweighed.filter((f) => order.indexOf(f) > lastWeighed);
    const elseFlow =
      fallback ?? trailing.find((f) => f.targetRef === join) ?? trailing.at(-1);
    const heads = [...weighed, ...unweighed]
      .filter((f) => f !== elseFlow)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((f): [condition: string, flow: SequenceFlow] => [
        weighed.includes(f) ? renderCondition(f) : 'true',
        f,
      ]);

    heads.forEach(([condition, f], i) => {
      lines.push(
        i === 0
          ? `if (${condition})${headSettings(settings)} {`
          : `} else if (${condition}) {`,
      );
      lines.push(...this.emitIfBranch(f, join, splitId, depth));
    });

    // The compiler lowers an empty `else` as none, so it is never printed.
    const elseBody =
      elseFlow === undefined
        ? []
        : this.emitIfBranch(elseFlow, join, splitId, depth);
    if (elseBody.length > 0) lines.push('} else {', ...elseBody);
    lines.push(fails ? `} else ${ELSE_FAIL_WORD}` : '}');
  }

  /**
   * The fallback counts as unconditioned even with a condition, or nothing
   * would catch the no-match case.
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
   * Each route becomes a jump in its own branch; the marker records the lost
   * split kind.
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
   * A loop prints ahead of its body, so entering the body before its head
   * prints needs a `goto`.
   */
  private entersUnprintedLoop(from: string, to: string): boolean {
    return this.cfg
      .headsEnteredPast(from, to)
      .some((head) => !this.emittedNodes.has(head));
  }

  /**
   * A join past `stop` is refused: in a loop body, routes reconverging behind
   * the loop pass the dominance checks but would drop the back edge. Every
   * route must reach the join, since a route that never ends has no
   * post-dominators.
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
    if (this.entersUnprintedLoop(splitId, join)) return undefined;
    for (const f of outs) {
      if (f.targetRef === join) continue;
      if (
        !this.cfg.dominates(splitId, f.targetRef) ||
        !this.cfg.postDominates(join, f.targetRef)
      ) {
        return undefined;
      }
    }
    return join;
  }

  /**
   * Reconvergence where post-dominators cannot say (a branch that ends, or a
   * self-loop leaving no post-dominators). Live routes: those reaching the
   * exit, else those sharing a node with another route, else all. Picks the
   * first node every live route reaches, preferring a merge, then the exit,
   * then the nearest step no live route can end or leave before.
   */
  private convergence(
    splitId: string,
    outs: readonly SequenceFlow[],
    stop: string | undefined,
  ): string | undefined {
    const exit = stop ?? this.elidedTail;
    const routes = outs
      .filter((f) => this.successors(f.targetRef).length > 0)
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
    // A node dominating the split lies upstream, so it is no merge; `stop` is
    // kept, since a loop head dominates its body and ends it.
    const shared = [...live[0]!.reach].filter(
      (n) =>
        live.every((r) => r.reach.has(n)) &&
        (n === stop ||
          (!this.cfg.dominates(n, splitId) && !this.emittedNodes.has(n))) &&
        !this.entersUnprintedLoop(splitId, n),
    );
    const merge = shared.find((n) => this.isMerge(n));
    if (merge !== undefined) return merge;
    if (exit !== undefined && shared.includes(exit)) {
      // A lone route into the elided end past no merge was written as a jump
      // behind an authored end; the guard clause keeps it that way.
      return live.length === 1 && stop === undefined ? undefined : exit;
    }
    // A lone weighed route's whole chain is its branch: take the farthest step.
    const [only] = live;
    const weighed =
      live.length === 1 &&
      only!.f.conditionExpression !== undefined &&
      only!.f.id !== this.splitFallbackFlowId(splitId);
    // A step is the merge only if no live route can end or reach `stop`
    // before it; otherwise the next pass would print it hoisted, not nested.
    const leavesBefore = (entry: string, n: string): boolean =>
      [...this.reachable(entry, splitId, n)].some(
        (m) => m !== n && (m === stop || this.successors(m).length === 0),
      );
    const holds = (n: string): boolean =>
      live.every((r) => !leavesBefore(r.f.targetRef, n));
    return weighed ? shared.findLast(holds) : shared.find(holds);
  }

  /**
   * Breadth order. `stop` is included but not crossed; the split is excluded.
   */
  private reachable(
    from: string,
    splitId: string | undefined,
    stop: string | undefined,
    inRegion: (n: string) => boolean = () => true,
  ): Set<string> {
    return closure(from === splitId ? [] : [from], (n) =>
      n === stop || !inRegion(n)
        ? []
        : this.successors(n).filter((m) => m !== splitId),
    );
  }

  /**
   * Over unconsumed routes only: a consumed edge already has its place in the
   * print.
   */
  private reachesUnconsumed(
    from: string,
    wall: string,
    target: string,
  ): boolean {
    return closure(
      from === wall ? [] : [from],
      (n) =>
        this.unconsumedOut(n)
          .map((f) => f.targetRef)
          .filter((m) => m !== wall),
      target,
    ).has(target);
  }

  /**
   * Stops past the first node outside the split's region (a jump target). A
   * gateway outside it is an enclosing merge, not a jump, so the walk
   * continues.
   */
  private reachableInRegion(
    from: string,
    splitId: string,
    stop: string | undefined,
  ): Set<string> {
    return this.reachable(from, splitId, stop, (n) =>
      this.inRegion(splitId, n),
    );
  }

  private inRegion(splitId: string, n: string): boolean {
    return this.cfg.loopDominates(splitId, n) || this.isGatewayId(n);
  }

  /**
   * A guard clause: one branch terminates and the sole unconditioned route
   * continues after the `if`.
   */
  private guardClauseContinuation(
    unconditioned: SequenceFlow[],
  ): string | undefined {
    return unconditioned.length === 1 ? unconditioned[0]!.targetRef : undefined;
  }

  /**
   * An all-conditioned split in a loop body or branch where some routes leave:
   * the staying routes continue at `stop` and only the leaving ones jump.
   * Jumping throughout would hoist the staying steps out of the loop.
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
   * With no join, the jump passes would print whichever chain comes next after
   * the `if`, and the next print would pick a different structure. Continuing
   * at a route's own entry keeps the two prints the same. The last route is
   * preferred, since only it can print as the fall-through rather than as an
   * empty branch.
   */
  private noMatchContinuation(
    splitId: string,
    outs: SequenceFlow[],
    stop: string | undefined,
  ): SequenceFlow | undefined {
    if (
      stop !== undefined ||
      this.splitFallbackFlowId(splitId) !== undefined ||
      // Reached with two unconditioned routes: an empty condition body passes
      // the import's one-unconditioned-route check and imports as none.
      outs.some((f) => f.conditionExpression === undefined)
    ) {
      return undefined;
    }
    // A printed entry resumes as a `goto`, which no other route can share.
    const resumable = (f: SequenceFlow): boolean =>
      this.cfg.incoming(f.targetRef).length === 1 ||
      this.emittedNodes.has(f.targetRef);
    const last = outs.at(-1)!;
    return resumable(last) ? last : outs.find(resumable);
  }

  /**
   * Walk or `goto` is decided per branch. `this.branch` is installed because a
   * route can dip past its join into a sibling's step, which only
   * {@link leavesInnermostBranch} stops.
   */
  private emitIfBranch(
    route: SequenceFlow,
    join: string | undefined,
    splitId: string,
    depth: number,
  ): string[] {
    const entry = route.targetRef;
    const body: string[] = [];
    if (join === undefined) {
      this.pushGoto(entry, body);
    } else if (entry === join) {
      // An empty branch.
    } else if (
      !this.emittedNodes.has(entry) &&
      this.branchStaysInRegion(entry, join, splitId)
    ) {
      const outerBranch = this.branch;
      this.branch = { route, join, ownEntry: entry, outer: outerBranch };
      this.emitFrom(entry, join, body, depth + 1);
      this.branch = outerBranch;
    } else if (!this.runsInto(entry, join)) {
      this.pushGoto(entry, body);
    }
    return body.map((l) => INDENT + l);
  }

  /**
   * A jump to where the block continues prints as an empty branch; a `goto`
   * would make the next pass pick another continuation. Only plain exclusive
   * merges may lie between: a parallel/inclusive join would count the token.
   */
  private runsInto(entry: string, join: string): boolean {
    const fromEntry = this.plainChain(entry);
    const fromJoin = this.plainChain(join);
    const meet = fromJoin.findIndex((n) => fromEntry.includes(n));
    if (meet < 0) return false;
    const onlyMerges = (chain: string[], end: number) =>
      chain
        .slice(0, end)
        .every((n) => this.byId.get(n)?.kind === 'exclusiveGateway');
    return (
      onlyMerges(fromJoin, meet) &&
      onlyMerges(fromEntry, fromEntry.indexOf(fromJoin[meet]!))
    );
  }

  private plainChain(id: string): string[] {
    const chain: string[] = [];
    for (let n = id; !chain.includes(n);) {
      chain.push(n);
      const el = this.byId.get(n);
      const outs = this.routesOut(n);
      if (
        el === undefined ||
        !isGateway(el) ||
        outs.length !== 1 ||
        jobSettingItems(el).length > 0
      ) {
        break;
      }
      n = outs[0]!.targetRef;
    }
    return chain;
  }

  /**
   * Whether the branch walks `entry` inline rather than jumping. Jump when
   * entering an unprinted loop or when a predecessor outside the branch also
   * enters. Gateways, routes into a gateway join, synthesized ids and
   * single-route ends walk inline. With an elided tail, walk inline unless the
   * chain reaches that end (hoisting would push the end off the tail). With
   * none, a chain opening a do-while walks inline (hoisted, its `do` would
   * follow a terminator); a chain the block's tail re-enters jumps; others
   * walk inline only outside every loop and where ids stay stable.
   */
  private branchStaysInRegion(
    entry: string,
    join: string,
    splitId: string,
  ): boolean {
    if (this.entersUnprintedLoop(splitId, entry)) return false;
    if (this.cfg.postDominates(join, entry)) return true;
    const el = this.byId.get(entry);
    // Predecessors that leave the branch its entry: dominated by this or an
    // enclosing if-chain split, a back edge of a loop `entry` heads, an
    // `await`/`parallel` branch jumping here, or a boundary handler body.
    const splits = [splitId];
    for (let b = this.branch; b?.ownEntry !== undefined; b = b.outer) {
      splits.push(b.route.sourceRef);
    }
    const doWhileEdges = this.doWhileBackEdges(entry);
    const latches = new Set(
      [
        ...doWhileEdges,
        ...(this.cfg.ownLoopTest(entry) === entry
          ? this.cfg.backEdges().filter((f) => f.targetRef === entry)
          : []),
      ].map((f) => f.sourceRef),
    );
    const owned = this.cfg
      .incoming(entry)
      .every(
        (p) =>
          splits.some((s) => this.cfg.dominates(s, p)) ||
          this.cfg.loopDominates(entry, p) ||
          latches.has(p) ||
          this.jumpsOutOfBranch(p, entry) ||
          this.reachedOnlyThroughBoundary(p),
      );
    // A printed join is behind the split, so dominating `entry` does not put
    // `entry` after it.
    if (
      el === undefined ||
      !owned ||
      (this.cfg.dominates(join, entry) && !this.emittedNodes.has(join))
    ) {
      return false;
    }
    if (isGateway(el)) return true;
    const joinEl = this.byId.get(join);
    if (
      joinEl !== undefined &&
      isGateway(joinEl) &&
      this.reachable(entry, splitId, join).has(join)
    ) {
      return true;
    }
    if (isSynthesizedTerminalId(entry, el.kind, this.container)) return true;
    if (el.kind === 'endEvent' && this.cfg.incoming(entry).length === 1) {
      return true;
    }
    const after = this.reachable(join, splitId, undefined);
    if (this.elidedTail === undefined) {
      if (doWhileEdges.length > 0) return true;
      if (this.cfg.incoming(entry).some((p) => p !== splitId && after.has(p))) {
        return false;
      }
      return (
        this.noRealLoop(splitId) &&
        this.namedChainKeepsIdsInline(entry, splitId, join)
      );
    }
    const walled =
      after.has(entry) && this.wallStaysOff(entry, join, splitId)
        ? new Set<string>()
        : after;
    return !this.reachable(
      entry,
      splitId,
      join,
      (n) => !walled.has(n) && this.inRegion(splitId, n),
    ).has(this.elidedTail);
  }

  /**
   * Whether `splitId` is outside every recognized do-while (a do-while keeps a
   * leaving branch hoisted). A do-while test that also branches counts as
   * inside.
   */
  private noRealLoop(splitId: string): boolean {
    return !this.cfg
      .backEdges()
      .some(
        (f) =>
          this.doWhileTests.has(f) &&
          this.cfg.loopDominates(f.targetRef, splitId),
      );
  }

  /**
   * A node in a handler body is dominated by its boundary event as others are
   * by the start.
   */
  private reachedOnlyThroughBoundary(p: string): boolean {
    for (
      let cur: string | undefined = p;
      cur !== undefined;
      cur = this.cfg.loopImmediateDominator(cur)
    ) {
      const el = this.byId.get(cur);
      if (el !== undefined && isBoundary(el)) return true;
    }
    return false;
  }

  /**
   * Inline keeps ids stable only if the chain holds no synthesized throw,
   * catch or end, whose id comes from its position. The walk stops at nodes
   * `entry` does not loop-dominate and at back edges. A bare entry is no
   * chain: several routes may share one authored terminal.
   */
  private namedChainKeepsIdsInline(
    entry: string,
    splitId: string,
    join: string,
  ): boolean {
    const backEdgeIds = new Set(this.cfg.backEdges().map((f) => f.id));
    const chain = closure(entry === splitId ? [] : [entry], (n) =>
      n === join || !this.cfg.loopDominates(entry, n)
        ? []
        : this.routesOut(n)
            .filter((f) => !backEdgeIds.has(f.id) && f.targetRef !== splitId)
            .map((f) => f.targetRef),
    );
    if ([...chain].every((n) => n === entry || n === join)) return false;
    return [...chain].every(
      (n) =>
        n === join ||
        !isSynthesizedTerminalId(n, this.byId.get(n)!.kind, this.container),
    );
  }

  /**
   * `branch` is the fork/race route; a loop body passes none and stays in its
   * enclosing branch.
   */
  private emitBranch(
    entry: string,
    join: string | undefined,
    lines: string[],
    depth: number,
    branch?: SequenceFlow,
  ): void {
    const outer = this.branchPath;
    const outerBranch = this.branch;
    if (branch !== undefined) {
      this.branchPath = `${outer}/${branch.id}`;
      this.branch = { route: branch, join, outer: outerBranch };
    }
    const body: string[] = [];
    if (entry !== join) this.emitFrom(entry, join, body, depth + 1);
    for (const l of body) lines.push(INDENT + l);
    this.branchPath = outer;
    this.branch = outerBranch;
  }

  private tryWhile(
    loop: Extract<FlowElement, { kind: 'exclusiveGateway' }>,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP | undefined {
    // Unconditioned, unlike a do-while back edge, so the two never both fire.
    // A self-loop is no body.
    const backEdge = this.unconsumed(this.cfg.backEdges()).find(
      (f) =>
        f.targetRef === loop.id &&
        f.sourceRef !== loop.id &&
        f.conditionExpression === undefined &&
        !this.testedAfter(f),
    );
    if (backEdge === undefined) return undefined;

    // Operaton tests the routes in document order and `while (c)` reads back
    // with the body route first, so only a body route listed first folds.
    const fallbackId = this.splitFallbackFlowId(loop.id);
    const cond = this.routesOut(loop.id).find((f) => f.id !== fallbackId);
    if (
      cond?.conditionExpression === undefined ||
      !this.reachesUnconsumed(cond.targetRef, loop.id, backEdge.sourceRef)
    ) {
      return undefined;
    }

    return this.emitLoop(
      loop.id,
      [cond, backEdge],
      cond.targetRef,
      (settings) => [`while (${renderCondition(cond)})${settings} {`, '}'],
      stop,
      lines,
      depth,
    );
  }

  /**
   * The routes left after `spent` are consumed before the body walk, so a jump
   * onto the head sees the same routing.
   */
  private emitLoop(
    loopId: string,
    spent: readonly SequenceFlow[],
    entry: string,
    frame: (settings: string) => [open: string, close: string],
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP {
    this.emittedNodes.add(loopId);
    for (const f of spent) this.consumedFlows.add(f.id);
    const rest = this.unconsumedOut(loopId);
    for (const f of rest) this.consumedFlows.add(f.id);
    const [open, close] = frame(headSettings(this.takeHeadSettings(loopId)));
    lines.push(open);
    this.emitBranch(entry, loopId, lines, depth);
    lines.push(close);
    return this.emitRoutes(loopId, rest, stop, lines, depth);
  }

  /**
   * The body's end is where the rest of a split's routes fall through, so a
   * route of an exclusive split listed after this unconditioned one would be
   * tested first, while Operaton never reaches it.
   */
  private testedAfter(f: SequenceFlow): boolean {
    if (this.byId.get(f.sourceRef)?.kind !== 'exclusiveGateway') return false;
    const fallbackId = this.splitFallbackFlowId(f.sourceRef);
    if (f.id === fallbackId) return false;
    const routes = this.routesOut(f.sourceRef);
    return routes.slice(routes.indexOf(f) + 1).some((o) => o.id !== fallbackId);
  }

  /**
   * Nested loops at one body entry all return to `node`. The outermost test is
   * the candidate whose other routes never reach another candidate over
   * unconsumed flows; a `continue` runs on to the real test.
   */
  private tryDoWhileEntry(
    node: string,
    stop: string | undefined,
    lines: string[],
    depth: number,
  ): string | typeof STOP | undefined {
    const candidates = this.doWhileBackEdges(node);
    const outermost = candidates.filter((f) =>
      this.routesOut(f.sourceRef)
        .filter((o) => o.id !== f.id)
        .every((o) =>
          candidates.every(
            (c) =>
              c.sourceRef === f.sourceRef ||
              !this.reachesUnconsumed(o.targetRef, f.sourceRef, c.sourceRef),
          ),
        ),
    );
    if (outermost.length !== 1) return undefined;
    const backEdge = outermost[0]!;
    return this.emitLoop(
      backEdge.sourceRef,
      [backEdge],
      node,
      (settings) => [
        'do {',
        `} while (${renderCondition(backEdge)})${settings}`,
      ],
      stop,
      lines,
      depth,
    );
  }

  private doWhileBackEdges(node: string): SequenceFlow[] {
    const candidates = this.unconsumed(this.cfg.backEdges()).filter(
      (f) => f.targetRef === node && this.doWhileTests.has(f),
    );
    // Once `ownLoopTest` names another gateway, only its back edge qualifies.
    const owner = this.cfg.ownLoopTest(node);
    return owner === undefined || owner === node
      ? candidates
      : candidates.filter((f) => f.sourceRef === owner);
  }

  /**
   * The condition tells a do-while from a `while`'s join-to-head edge. Operaton
   * tests every route but the default in document order, unconditioned ones
   * included, and `while (c)` reads back as the first, so only the route listed
   * first qualifies.
   */
  private isDoWhileTest(f: SequenceFlow): boolean {
    if (f.sourceRef === f.targetRef) return false;
    if (f.conditionExpression === undefined) return false;
    // A jump-cycle head closes on a `goto`, not on this gateway's test.
    if (this.cfg.isJumpCycleHead(f.targetRef)) return false;
    const head = this.byId.get(f.sourceRef);
    const fallbackId = this.splitFallbackFlowId(f.sourceRef);
    const firstTest = this.routesOut(f.sourceRef).find(
      (o) => o.id !== fallbackId,
    );
    return (
      head?.kind === 'exclusiveGateway' &&
      firstTest === f &&
      this.enclosesBody(f.targetRef, head.id) &&
      this.reachable(f.targetRef, undefined, head.id).has(head.id)
    );
  }

  /**
   * Whether the `do` body nests cleanly: no gateway before the test is entered
   * from outside the body (the test would print past that block's end), and
   * no gateway the body bypasses the test to reach is also reached from the
   * test's exit (the test sits inside that block).
   */
  private enclosesBody(node: string, test: string): boolean {
    const body = this.reachable(node, test, test);
    const reachesTest = (n: string): boolean =>
      this.reachable(n, node, test).has(test);
    const afterTest = this.reachable(
      test,
      node,
      undefined,
      (n) => n === test || !reachesTest(n),
    );
    return [...body].every((n) => {
      if (n === node || !isGateway(this.byId.get(n)!)) return true;
      if (reachesTest(n)) return this.cfg.incoming(n).every((p) => body.has(p));
      return !afterTest.has(n);
    });
  }

  /**
   * Both fork kinds print as `parallel`: a condition on any branch reads back
   * as inclusive, none as parallel. Keyed on id, since a step can split too.
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

    const join = this.forkJoin(splitId, outs, stop, kind);

    const meet =
      join === undefined ? this.unsyncedMeet(splitId, stop) : undefined;

    for (const f of outs) this.consumedFlows.add(f.id);

    if (join === undefined && !this.routesEndApart(splitId, outs, stop, meet)) {
      this.warnings.push(
        degradedSplitWarning(
          splitId,
          isGateway(this.byId.get(splitId)!) ? 'gateway' : 'element',
        ),
      );
      this.emitJumps(splitId, kind, outs, lines, depth);
      return STOP;
    }

    if (join === undefined && meet === undefined) {
      this.warnAddedJoin(splitId, outs);
    }
    this.warnUnweighedBranchCondition(fork, outs);

    // A fallback straight into the merge is implicit; omit it while two
    // branches remain, the block's minimum.
    const kept = outs.filter((f) => !this.isImplicitFallback(fork, f, join));
    const branches = kept.length >= 2 ? kept : outs;
    this.warnDeadFallback(fork, branches);
    this.warnChangedJoin(fork, join, branches);

    lines.push(`parallel${headSettings(this.blockSettings(splitId, join))} {`);
    branches.forEach((f) => {
      const branchLines: string[] = [];
      this.emitBranch(f.targetRef, join, branchLines, depth, f);
      lines.push(INDENT + this.branchHead(fork, f) + '{');
      for (const l of branchLines) lines.push(INDENT + l);
      lines.push(INDENT + '}');
    });
    if (this.failsWithoutMatch(splitId)) {
      lines.push(INDENT + `else ${ELSE_FAIL_WORD}`);
    }
    lines.push('}');

    const after = join ?? meet;
    return after === undefined ? STOP : this.continueAt(after, stop, lines);
  }

  /**
   * Where the routes out of a fork meet at a step with no join, as in a fork
   * whose routes all run into one end event. Each branch jumps to it and it
   * prints after the block, whose join then has no route in, so the compiler
   * leaves it out and the step is entered once per route, as in the model.
   */
  private unsyncedMeet(
    splitId: string,
    stop: string | undefined,
  ): string | undefined {
    const meet = this.cfg.immediatePostDominator(splitId);
    const el = meet === undefined ? undefined : this.byId.get(meet);
    if (
      el === undefined ||
      isGateway(el) ||
      el.id === stop ||
      this.emittedNodes.has(el.id) ||
      this.cfg.incoming(el.id).length < 2 ||
      isElidedOnPrint(el, this.container) ||
      !this.cfg.dominates(splitId, el.id)
    ) {
      return undefined;
    }
    return el.id;
  }

  /**
   * The compiler joins every branch of a block that does not end, so two
   * routes stopping at a step with no way on meet at a join the model lacks.
   */
  private warnAddedJoin(splitId: string, outs: readonly SequenceFlow[]): void {
    const openEnds = outs.map((f) => {
      const seen = new Set([f.targetRef]);
      const stops: string[] = [];
      for (const n of seen) {
        if (this.emittedNodes.has(n)) continue;
        const next = this.successors(n);
        if (next.length === 0 && this.byId.get(n)?.kind !== 'endEvent') {
          stops.push(n);
        }
        for (const m of next) seen.add(m);
      }
      return stops;
    });
    if (openEnds.filter((stops) => stops.length > 0).length < 2) return;
    this.warnings.push(addedJoinWarning(splitId, openEnds.flat()));
  }

  /**
   * A joinless fork prints only if each route is its own region, entered
   * through its head alone, ending or jumping to a nameable printed node or
   * to `meet`, and not reaching the block exit. Only the routes enter `meet`.
   */
  private routesEndApart(
    splitId: string,
    outs: readonly SequenceFlow[],
    stop: string | undefined,
    meet?: string,
  ): boolean {
    const exit = stop ?? this.elidedTail;
    const route = new Map<string, SequenceFlow>();
    for (const f of outs) {
      let ends = false;
      const queue = [f.targetRef];
      for (let i = 0; i < queue.length; i++) {
        const n = queue[i]!;
        if (n === exit) return false;
        if (n === meet) {
          ends = true;
          continue;
        }
        if (this.emittedNodes.has(n)) {
          if (this.forwardToRealTarget(n, new Set()) === undefined) {
            return false;
          }
          ends = true;
          continue;
        }
        const owner = route.get(n);
        if (owner === f) continue;
        if (owner !== undefined) return false;
        route.set(n, f);
        const next = this.successors(n);
        if (next.length === 0) ends = true;
        queue.push(...next);
      }
      if (!ends) return false;
    }
    return (
      [...route].every(([n, f]) =>
        this.cfg
          .incoming(n)
          .every(
            (p) => route.get(p) === f || (p === splitId && n === f.targetRef),
          ),
      ) &&
      (meet === undefined ||
        this.cfg.incoming(meet).every((p) => route.has(p) || p === splitId))
    );
  }

  /**
   * The compiler makes a block inclusive only for a weighed branch, so an
   * inclusive fork that weighs none reads back as parallel. The fork runs the
   * same either way, its join does not.
   */
  private warnChangedJoin(
    fork: Fork,
    join: string | undefined,
    branches: readonly SequenceFlow[],
  ): void {
    if (join === undefined || this.byId.get(join)?.kind !== 'inclusiveGateway')
      return;
    const weighed = branches.some(
      (f) => f.id !== fork.fallbackId && f.conditionExpression !== undefined,
    );
    if (!weighed) this.warnings.push(changedJoinWarning(join));
  }

  /**
   * The fork weighs no condition on its fallback, so it heads as `else`
   * regardless.
   */
  private branchHead(fork: Fork, flow: SequenceFlow): string {
    if (fork.kind !== 'inclusiveGateway') return '';
    if (flow.id === fork.fallbackId) return 'else ';
    return flow.conditionExpression === undefined
      ? ''
      : `if (${renderCondition(flow)}) `;
  }

  private isImplicitFallback(
    fork: Fork,
    flow: SequenceFlow,
    join: string | undefined,
  ): boolean {
    return (
      fork.kind === 'inclusiveGateway' &&
      flow.id === fork.fallbackId &&
      flow.targetRef === join
    );
  }

  /**
   * Whether the engine stops the run when no condition holds, which prints as
   * `else fail`. Reads model routes: the engine weighs every route, printed or
   * not. A step split throws as its gateway form does
   * (`BpmnActivityBehavior.handleNoTransitions`).
   */
  private failsWithoutMatch(splitId: string): boolean {
    return (
      this.byId.get(splitId)?.kind !== 'parallelGateway' &&
      this.splitFallbackFlowId(splitId) === undefined &&
      this.routesOut(splitId).every((f) => f.conditionExpression !== undefined)
    );
  }

  /**
   * A step's `default` is honoured too, by Operaton's `handleNoTransitions`.
   */
  private splitFallbackFlowId(splitId: string): string | undefined {
    const el = this.byId.get(splitId);
    if (el === undefined) return undefined;
    if (isGateway(el)) return gatewayDefaultFlowId(el);
    return 'defaultFlowId' in el ? el.defaultFlowId : undefined;
  }

  private splitFallbackFlow(splitId: string): SequenceFlow | undefined {
    const fallbackId = this.splitFallbackFlowId(splitId);
    return this.routesOut(splitId).find((f) => f.id === fallbackId);
  }

  /**
   * A fallback beside an unconditioned branch is unreachable, and the validator
   * refuses its `else`.
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
   * The engine refuses to deploy a choice whose fallback has a condition; a
   * fork or step ignores it.
   */
  private warnFallbackCondition(splitId: string): void {
    const condition = this.splitFallbackFlow(splitId)?.conditionExpression;
    if (condition === undefined) return;
    this.warnings.push(
      this.byId.get(splitId)?.kind === 'exclusiveGateway'
        ? choiceFallbackConditionWarning(splitId, condition)
        : forkFallbackConditionWarning(splitId, condition),
    );
  }

  /** A printed branch condition would read back as an inclusive fork. */
  private warnUnweighedBranchCondition(fork: Fork, outs: SequenceFlow[]): void {
    if (fork.kind !== 'parallelGateway') return;
    if (!outs.some((f) => f.conditionExpression !== undefined)) return;
    this.warnings.push(unweighedBranchWarning(fork.id, outs));
  }

  /**
   * The fork's own merge, else, when a branch ends and leaves the fork no
   * post-dominator, where the survivors reconverge. Each branch lists the
   * fork-dominated `joinKind` merges on its post-dominator chain; the first
   * common to all is the join. A merge right behind a nested split is that
   * split's own and is skipped. Only real merges count, not loop heads or
   * tests.
   */
  private forkJoin(
    forkId: string,
    outs: SequenceFlow[],
    stop: string | undefined,
    joinKind: Gateway['kind'],
  ): string | undefined {
    const own = this.ownJoin(forkId, outs, stop, joinKind);
    if (own !== undefined) return own;
    const survivorChains: string[][] = [];
    for (const f of outs) {
      const chain: string[] = [];
      let prev = f.targetRef;
      let cur = this.cfg.immediatePostDominator(prev);
      const seen = new Set<string>();
      while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur);
        const nested = this.routesOut(prev).length > 1;
        if (
          cur !== forkId &&
          !nested &&
          this.byId.get(cur)?.kind === joinKind &&
          (this.isMerge(cur) || this.mergesForward(cur)) &&
          this.cfg.dominates(forkId, cur)
        ) {
          chain.push(cur);
        }
        prev = cur;
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

  private mergesForward(id: string): boolean {
    const ins = this.cfg.incoming(id);
    return ins.length > 1 && !ins.some((p) => this.cfg.dominates(id, p));
  }

  /**
   * Keyed on the waits alone, so it holds without a merge; any non-wait branch
   * degrades.
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

    if (outs.some((f) => f.conditionExpression !== undefined)) {
      this.warnings.push(raceConditionWarning(race.id, outs));
    }

    // An XOR merge: exactly one branch of a race ever runs.
    const join = this.forkJoin(race.id, outs, stop, 'exclusiveGateway');

    lines.push(`await${headSettings(this.blockSettings(race.id, join))} {`);
    waits.forEach((wait, i) => {
      const { el, body } = wait!;
      this.emittedNodes.add(el.id);
      const branchLines: string[] = [];
      if (body !== undefined) {
        this.consume(body);
        this.emitBranch(body.targetRef, join, branchLines, depth, outs[i]);
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

  private raceWait(target: string): RaceWait | undefined {
    const el = this.byId.get(target);
    if (el?.kind !== 'intermediateCatchEvent') return undefined;
    if (this.emittedNodes.has(el.id)) return undefined;
    const outs = this.unconsumedOut(el.id);
    if (outs.length > 1) return undefined;
    return outs[0] === undefined ? { el } : { el, body: outs[0] };
  }

  /**
   * Every route printed as plain flow goes through here, so its dropped
   * condition is always reported.
   */
  private consume(flow: SequenceFlow): void {
    this.consumedFlows.add(flow.id);
    if (flow.conditionExpression === undefined) return;
    const warning = this.droppedConditionWarning(
      flow,
      flow.conditionExpression,
    );
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
   * Beside an unconditioned fallback a dropped condition diverts the run rather
   * than failing it.
   */
  private droppedConditionWarning(
    flow: SequenceFlow,
    condition: string,
  ): PrintWarning | undefined {
    const sourceId = flow.sourceRef;
    const source = this.byId.get(sourceId);
    if (flow.id === this.splitFallbackFlowId(sourceId)) return undefined;
    switch (source?.kind) {
      case 'parallelGateway':
        return unweighedBranchWarning(sourceId, [flow]);
      case 'eventBasedGateway':
        return raceConditionWarning(sourceId, [flow]);
      default: {
        const place =
          source !== undefined && isGateway(source)
            ? `gateway '${sourceId}'`
            : `the route out of '${sourceId}'`;
        const fallback = this.splitFallbackFlow(sourceId);
        return fallback !== undefined &&
          fallback.conditionExpression === undefined
          ? divertedRunWarning(sourceId, place, condition)
          : droppedFlowConditionWarning(
              sourceId,
              place,
              condition,
              this.routesOut(sourceId).length === 1,
            );
      }
    }
  }

  /**
   * A printed pass-through running into `stop` is fallen through, not jumped:
   * it is still in its block.
   */
  private continueAt(
    target: string,
    stop: string | undefined,
    lines: string[],
  ): string | typeof STOP {
    if (target === stop) return STOP;
    if (this.emittedNodes.has(target)) {
      if (stop !== undefined && this.runsInto(target, stop)) return STOP;
      this.pushGoto(target, lines);
      return STOP;
    }
    return target;
  }

  /**
   * The single jump site: a `goto` never names a gateway; one still holding a
   * choice drops the edge.
   */
  private pushGoto(target: string, lines: string[]): void {
    const crossed = new Set<string>();
    const real = this.forwardToRealTarget(target, crossed);
    if (real !== undefined) {
      for (const id of crossed) {
        if (this.isSynchronizing(id) && !this.skippedJoins.has(id)) {
          this.skippedJoins.add(id);
          this.warnings.push(skippedJoinWarning(id, real));
        }
      }
      lines.push(`goto ${printName(real)}`);
      this.jumps.push({ target: real, branchPath: this.branchPath });
      return;
    }
    lines.push(droppedEdgeMarker(target));
    this.warnings.push(droppedEdgeWarning(target));
  }

  /**
   * A jump into a gateway with one outcome equals a jump to its successor.
   * Crosses the single unconsumed out-edge, else the sole edge of a gateway
   * that never had a choice (consumed means printed, not gone).
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
    const outs = this.routesOut(target);
    const unconsumed = this.unconsumed(outs);
    let forward: SequenceFlow | undefined;
    if (unconsumed.length === 1) forward = unconsumed[0];
    else if (outs.length === 1) forward = outs[0];
    if (forward === undefined) return undefined;
    return this.forwardToRealTarget(forward.targetRef, seen);
  }

  /**
   * A synthesized id is omitted: the compiler re-derives it from the
   * statement's position.
   */
  private terminalNameSuffix(
    el: Extract<
      FlowElement,
      { kind: 'endEvent' | 'intermediateThrowEvent' | 'intermediateCatchEvent' }
    >,
  ): string {
    return isSynthesizedTerminalId(el.id, el.kind, this.container)
      ? ''
      : ` ${printName(el.id)}`;
  }

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
            `end ${printName(el.id)}${head}`,
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
          `step ${printName(el.id)}${repeatClause(el)}`,
          [...namedSettings(el), ...engineSettings(el)],
          structuredMembers(el),
        );
      case 'receiveTask':
        return renderReceiveTask(el, this.names);
      case 'callActivity':
        return renderCallActivity(el, this.names);
      case 'scriptTask':
        return renderScriptTask(el, this.names);
      // Printed by `emitNode`; listed for exhaustiveness.
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

type ForkKind = 'parallelGateway' | 'inclusiveGateway';

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

interface RaceWait {
  el: Extract<FlowElement, { kind: 'intermediateCatchEvent' }>;
  body?: SequenceFlow;
}

/**
 * Printed where an edge that cannot be named or placed would have gone, instead
 * of inventing a target.
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
      `a route into '${target}' was left out of the script\n` +
      'note: the route has no form in the script, so this part of the script is unstructured\n' +
      `note: the marker comment where it belonged names '${target}' and is where hand-repair starts`,
  };
}

function degradedSplitWarning(
  splitId: string,
  noun: 'gateway' | 'element' = 'gateway',
): PrintWarning {
  return {
    elementId: splitId,
    category: 'degradedSplit',
    message:
      `${noun} '${splitId}' was printed as jumps and its split was lost\n` +
      'note: the branches leaving it have no form in the script, so a ' +
      'branch leaves as a jump, or as a marker where it opens on something ' +
      'the script cannot name\n' +
      'note: a condition weighing a branch is written on its jump\n' +
      'note: whether the split opened one branch, every branch whose ' +
      'condition held, or the first to resolve is written nowhere\n' +
      'note: a jump ends the path it sits on, so at most one branch is left running\n' +
      'note: the marker line above the jumps is where hand-repair starts',
  };
}

function addedJoinWarning(splitId: string, stops: string[]): PrintWarning {
  return {
    elementId: splitId,
    category: 'addedJoin',
    message:
      `the routes out of '${splitId}' stop at ${formatPlainWordList(
        stops.map((id) => `'${id}'`),
        'and',
      )} without an end event, and the rebuilt process joins them\n` +
      "note: the script has no form for a route that stops without an end event, so the branches of a 'parallel' block meet at a join after it\n" +
      'note: the engine ends each of these routes where it stops\n' +
      'note: the rebuilt process holds each one at the new join until the others arrive\n' +
      'note: past the join it runs on as one route, which ends at an added end event when nothing follows the block',
  };
}

function changedJoinWarning(joinId: string): PrintWarning {
  return {
    elementId: joinId,
    category: 'changedJoin',
    message:
      `inclusive gateway '${joinId}' was printed as the join of a 'parallel' block\n` +
      'note: no branch of the block carries a condition, so the script reads the block back as parallel gateways\n' +
      `note: a parallel join waits for a route from every branch, where '${joinId}' goes on once no other route can still reach it\n` +
      'note: so a route led away from its branch before the join, by an interrupting boundary event for one, leaves the rebuilt process waiting at the join forever',
  };
}

function skippedJoinWarning(joinId: string, target: string): PrintWarning {
  return {
    elementId: joinId,
    category: 'skippedJoin',
    message:
      `a jump was printed past gateway '${joinId}' and its join was lost\n` +
      `note: the route into it has no form in the script, so it leaves as a jump to '${target}'\n` +
      `note: a route taking the jump goes on to '${target}' at once instead of waiting at '${joinId}' for the others\n` +
      `note: so '${target}' and what follows run once for each such route instead of once after the join`,
  };
}

function emptySplitWarning(kind: Gateway['kind'], id: string): PrintWarning {
  const model = {
    // Operaton ends the execution: the whole run at top level, one branch in a
    // fork.
    parallelGateway: [
      "note: the engine ends the run here too, so outside a fork's branch the process runs the same without it",
      'note: inside a branch, only that branch ends and the fork never completes',
    ],
    // Operaton throws `stuckExecutionException`.
    inclusiveGateway: [
      'note: the engine stops the run with an error here, where the script ' +
        'ends it, so what runs is not the same',
    ],
    // A wait state with nothing to wait for never completes.
    eventBasedGateway: [
      'note: the engine waits here forever, where the script ends the run, ' +
        'so what runs is not the same',
    ],
    // Operaton's `BpmnParse` rejects it: "has no outgoing sequence flows".
    exclusiveGateway: [
      'note: the engine refuses to deploy the model as drawn, while the ' +
        'script deploys and ends the run here',
    ],
  }[kind];
  return {
    elementId: id,
    category: 'degradedSplit',
    message: [
      `gateway '${id}' has no route out and was left out of the script`,
      ...model,
    ].join('\n'),
  };
}

function crossBranchJumpWarning(target: string): PrintWarning {
  return {
    elementId: target,
    category: 'refusedStatement',
    message:
      `the jump into '${target}' crosses the border of a branch of an 'await' or 'parallel' block\n` +
      'note: the printed script draws an error there when it is read back\n' +
      'note: the steps of a branch run only when the whole block is reached\n' +
      'help: redraw the route in the model, or move the step out of the branch',
  };
}

/** Quotes the condition when exactly one of `flows` carries one. */
function quotedCondition(flows: readonly SequenceFlow[]): string {
  const conditions = flows.flatMap((f) => f.conditionExpression ?? []);
  return conditions.length === 1 ? ` '${oneLine(conditions[0]!)}'` : '';
}

function raceConditionWarning(
  raceId: string,
  flows: readonly SequenceFlow[],
): PrintWarning {
  return {
    elementId: raceId,
    category: 'droppedCondition',
    message:
      `condition${quotedCondition(flows)} on a branch of gateway '${raceId}' was dropped\n` +
      'note: a wait opens every branch at once and takes the first to ' +
      'resolve, so the condition is weighed nowhere\n' +
      'note: the run is the same without it',
  };
}

/** `place` is where the route starts, `only` whether it is the sole route out. */
function droppedFlowConditionWarning(
  sourceId: string,
  place: string,
  condition: string,
  only: boolean,
): PrintWarning {
  return {
    elementId: sourceId,
    category: 'droppedCondition',
    message:
      `condition '${oneLine(condition)}' on ${place} was dropped\n` +
      (only
        ? `note: it is the only route out of '${sourceId}'`
        : `note: it is printed as the plain route on from '${sourceId}'`) +
      ', and BPMNscript writes conditions only on the branches of a split\n' +
      'note: when the condition is false, Operaton stops the original process with an error\n' +
      'note: the rebuilt process always continues',
  };
}

function divertedRunWarning(
  splitId: string,
  place: string,
  condition: string,
): PrintWarning {
  return {
    elementId: splitId,
    category: 'droppedCondition',
    message:
      `condition '${oneLine(condition)}' on ${place} was dropped\n` +
      `note: the route is printed as the plain way on from '${splitId}', ` +
      'and BPMNscript writes conditions only on the branches of a split\n' +
      `note: when the condition is false, Operaton takes the fallback of '${splitId}' instead\n` +
      'note: the rebuilt process always takes this route\n' +
      'note: nothing fails here, only the route the run takes differs',
  };
}

function unweighedBranchWarning(
  forkId: string,
  flows: readonly SequenceFlow[],
): PrintWarning {
  return {
    elementId: forkId,
    category: 'droppedCondition',
    message:
      `condition${quotedCondition(flows)} on a branch of parallel gateway '${forkId}' was dropped\n` +
      'note: a parallel gateway takes every route whatever the conditions ' +
      'say, so the condition is weighed nowhere and the run is the same without it\n' +
      'note: written out, it would read back as the split that does weigh its branches',
  };
}

function forkFallbackConditionWarning(
  forkId: string,
  condition: string,
): PrintWarning {
  return {
    elementId: forkId,
    category: 'defaultFlow',
    message:
      `condition '${oneLine(condition)}' on the fallback of gateway '${forkId}' was dropped\n` +
      'note: a fallback runs when no other branch does, whatever its ' +
      'condition says, so the run is the same without it',
  };
}

function choiceFallbackConditionWarning(
  splitId: string,
  condition: string,
): PrintWarning {
  return {
    elementId: splitId,
    category: 'defaultFlow',
    message:
      `condition '${oneLine(condition)}' on the fallback of exclusive gateway '${splitId}' was dropped\n` +
      'note: an exclusive gateway takes one route, and the engine refuses ' +
      'to deploy one whose fallback is weighed\n' +
      'note: the original process does not deploy, while the rebuilt one deploys and runs',
  };
}

function deadFallbackWarning(forkId: string): PrintWarning {
  return {
    elementId: forkId,
    category: 'defaultFlow',
    message:
      `fallback of gateway '${forkId}' can never run\n` +
      'note: a branch beside it runs whatever the conditions do, so ' +
      'nothing is ever left over for the fallback to take\n' +
      "note: the script writes it out as an 'else' all the same, which " +
      'draws an error when the source is read back\n' +
      'help: put a condition on the branches beside it, or drop the fallback',
  };
}

function droppedSettingWarning(gatewayId: string): PrintWarning {
  return {
    elementId: gatewayId,
    category: 'droppedSetting',
    message:
      `engine settings on gateway '${gatewayId}' were not written to the script\n` +
      'note: the script derives every split and every merge from its block ' +
      'structure, and this gateway has no statement to carry them\n' +
      'note: the process runs without them',
  };
}

/** Deeper nesting degrades to a `goto` rather than overflowing the stack. */
const MAX_NESTING_DEPTH = 1000;

/** Keyed by the vocabulary, so a new header key fails to compile here. */
const PROCESS_HEADER_RENDER: Record<
  (typeof PROCESS_ENGINE_HEADER_KEYS)[number],
  (value: string) => string
> = {
  versionTag: quoteLiteral,
  historyTimeToLive: quote,
  candidateStarterUsers: quote,
  candidateStarterGroups: quote,
};

function buildProcessHeader(process: BpmnProcess, names: PrintNames): string {
  const settings: string[] = namedSettings(process);
  for (const key of PROCESS_ENGINE_HEADER_KEYS) {
    const value = process[key];
    // The compiler writes this value for a script that sets none, so printing
    // it would add a line nobody wrote.
    const isDefault =
      key === 'historyTimeToLive' && value === HISTORY_TIME_TO_LIVE;
    if (value !== undefined && !isDefault) {
      settings.push(setting(key, PROCESS_HEADER_RENDER[key](value)));
    }
  }
  if (process.isStartableInTasklist !== undefined) {
    settings.push(
      setting(STARTABLE_KEY, String(process.isStartableInTasklist)),
    );
  }
  return `process ${printName(process.id)}${parens(settings)} {`;
}

function isHandler(
  el: FlowElement,
): el is Extract<FlowElement, { kind: 'subProcess' }> {
  return el.kind === 'subProcess' && el.triggeredByEvent === true;
}

/**
 * Link throws whose catch prints right behind them. The compiler lowers
 * `emit link("X")  await link("X")` in a branch as a dead-end throw and an
 * unentered catch whose chain continues inside the block.
 *
 * A throw owns its catch when the catch's chain meets a node no `goto` can
 * name: a gateway of the throw's block, a merge reached on the catch's one-in
 * run without opening its split, or a boundary body's minted end. A chain
 * meeting a step jumps back by name and stays an entry, unless the tail rule
 * links it. Dominators are computed without the catches, since the analysis
 * enters at each one. A catch owned by two throws stays an entry.
 */
function linkedCatches(
  container: FlowContainer,
  elidedTail: string | undefined,
): Map<string, string> {
  const entered = new Set(container.sequenceFlows.map((f) => f.targetRef));
  const byId = new Map(container.flowElements.map((el) => [el.id, el]));
  const catches = new Map<string, string>();
  for (const el of container.flowElements) {
    if (
      el.kind === 'intermediateCatchEvent' &&
      el.eventDefinition.kind === 'link' &&
      !entered.has(el.id) &&
      !catches.has(el.eventDefinition.linkName)
    ) {
      catches.set(el.eventDefinition.linkName, el.id);
    }
  }
  const catchIds = new Set(catches.values());
  if (catchIds.size === 0) return new Map();
  const cfg = analyzeCfg({
    ...container,
    flowElements: container.flowElements.filter((el) => !catchIds.has(el.id)),
  });
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const f of container.sequenceFlows) {
    outgoing.set(f.sourceRef, [
      ...(outgoing.get(f.sourceRef) ?? []),
      f.targetRef,
    ]);
    incoming.set(f.targetRef, (incoming.get(f.targetRef) ?? 0) + 1);
  }
  const next = (id: string): string[] => outgoing.get(id) ?? [];
  // A loop's gateways open and close the loop, never a block around it.
  const backEdges = analyzeCfg(container).backEdges();
  const loopGateways = new Set(
    backEdges.flatMap((f) => [f.sourceRef, f.targetRef]),
  );
  // A do-loop's back edge lands on its first body step, so count forward edges
  // only.
  const forwardIn = (id: string): number =>
    (incoming.get(id) ?? 0) -
    backEdges.filter((f) => f.targetRef === id).length;
  const onward = (id: string): string[] => {
    const el = byId.get(id);
    const hop =
      el?.kind === 'intermediateThrowEvent' &&
      el.eventDefinition.kind === 'link'
        ? catches.get(el.eventDefinition.linkName)
        : undefined;
    return hop === undefined ? next(id) : [hop];
  };
  // Starts print before catch entries, so a start reaching the tail claims it.
  const tailFromStarts =
    elidedTail !== undefined &&
    closure(
      container.flowElements
        .filter((el) => el.kind === 'startEvent')
        .map((el) => el.id),
      next,
    ).has(elidedTail);

  const owns = (throwId: string, catchId: string): boolean => {
    const dominators = new Set<string>();
    for (
      let d = cfg.immediateDominator(throwId);
      d !== undefined && byId.has(d);
      d = cfg.immediateDominator(d)
    ) {
      dominators.add(d);
    }
    const outOfDominators = (n: string) =>
      next(n).filter((m) => !dominators.has(m));
    const block = closure(
      [...dominators].flatMap(outOfDominators),
      outOfDominators,
    );

    const walk = (step: (id: string) => string[]) => {
      const chain = new Set<string>();
      // Open-split count, or undefined once off the catch's one-in run.
      const first = next(catchId);
      const queue: [string, number | undefined][] = first.map((n) => [
        n,
        first.length === 1 ? 0 : undefined,
      ]);
      let unnameable = false;
      while (queue.length > 0) {
        const [n, open] = queue.pop()!;
        if (chain.has(n)) continue;
        chain.add(n);
        const node = byId.get(n);
        if (node === undefined) continue;
        const gateway = isGateway(node);
        if (block.has(n) || dominators.has(n)) {
          unnameable ||= gateway;
          continue;
        }
        const merge = gateway && next(n).length === 1;
        unnameable ||=
          (open === 0 && merge) ||
          [...dominators].some(
            (d) =>
              byId.get(d)?.kind === 'boundaryEvent' && isMintedEndId(n, d, []),
          );
        const onRun =
          open !== undefined &&
          (gateway || (forwardIn(n) === 1 && next(n).length === 1));
        const opens = !gateway || loopGateways.has(n) ? 0 : merge ? -1 : 1;
        const depth = onRun ? open + opens : undefined;
        queue.push(
          ...step(n).map((m): [string, number | undefined] => [m, depth]),
        );
      }
      return { chain, unnameable };
    };
    const own = walk(next);
    // Tail rule: with an elided end, a catch chain printed as an entry would
    // push the end off the tail, unless the chain itself is what reaches the
    // end and no start does first.
    const displacesTail =
      elidedTail !== undefined &&
      (!own.chain.has(elidedTail) || tailFromStarts);
    // A chain ending in another throw continues through that throw's catch.
    return own.unnameable || displacesTail || walk(onward).unnameable;
  };

  const owned = container.flowElements.flatMap((el) => {
    if (
      el.kind !== 'intermediateThrowEvent' ||
      el.eventDefinition.kind !== 'link'
    ) {
      return [];
    }
    const catchId = catches.get(el.eventDefinition.linkName);
    return catchId !== undefined && owns(el.id, catchId)
      ? [[el.id, catchId] as const]
      : [];
  });
  return new Map(
    owned.filter(([, c]) => owned.filter(([, o]) => o === c).length === 1),
  );
}

/**
 * Each throw -> catch hop drawn as a flow, which also stops the analysis
 * entering at the catch.
 */
function withLinkHops(
  container: FlowContainer,
  linked: ReadonlyMap<string, string>,
): FlowContainer {
  return {
    ...container,
    sequenceFlows: [
      ...container.sequenceFlows,
      ...[...linked].map(([sourceRef, targetRef]) => ({
        id: `${sourceRef}->${targetRef}`,
        sourceRef,
        targetRef,
      })),
    ],
  };
}

function isBoundary(
  el: FlowElement,
): el is Extract<FlowElement, { kind: 'boundaryEvent' }> {
  return el.kind === 'boundaryEvent';
}

/**
 * 1 for `base`, n for `base_n`. An authored id ranks last: the print drops it,
 * so printed first it would take a minted sibling's id on the next compile.
 */
function boundaryIdRank(id: string, base: string): number {
  if (id === base) return 1;
  const suffix = id.startsWith(`${base}_`) ? id.slice(base.length + 1) : '';
  return /^[2-9]\d*$/.test(suffix) ? Number(suffix) : Infinity;
}

const END_CARRIED_KINDS = new Set<EventDefinition['kind']>(END_TRIGGERS);

function isEndCarried(
  def: EventDefinition,
): def is Extract<EventDefinition, { kind: (typeof END_TRIGGERS)[number] }> {
  return END_CARRIED_KINDS.has(def.kind);
}

/**
 * Whether the id is absent from the print, so no `goto` can name it; shared
 * with `xmlToIr`. For a plain end it means only that the printer may drop it,
 * which position decides. Only the first plain start can go: the compiler
 * re-derives a start only at the body's head.
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
      // A carried definition or a `name` has no other home, so it forces the
      // print.
      if (el.eventDefinition === undefined)
        return el.name === undefined && !carriesPrintableContent(el);
      return !isEndCarried(el.eventDefinition);
    case 'intermediateThrowEvent':
    case 'intermediateCatchEvent':
      return isSynthesizedTerminalId(el.id, el.kind, container);
    case 'boundaryEvent':
      return true;
    case 'subProcess':
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
 * A start with nothing of its own to print, so nothing is lost by dropping it.
 */
function isPlainUnnamed(
  el: Extract<FlowElement, { kind: 'startEvent' }>,
  container: PrintContainer,
  startTriggerSuppressed: boolean,
): boolean {
  // A trigger forces the print unless the `on` header carries it, along with
  // a timer start's job settings.
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
 * Read only through {@link isElidedOnPrint}, or a jump could name a statement
 * never emitted. Labels are handled by the callers.
 */
function carriesPrintableContent(
  el: Extract<FlowElement, { kind: 'startEvent' | 'endEvent' }>,
): boolean {
  return jobSettingItems(el).length > 0 || startOrEndMembers(el).length > 0;
}

function startOrEndMembers(
  el: Extract<FlowElement, { kind: 'startEvent' | 'endEvent' }>,
): Lines[] {
  const form =
    el.kind === 'startEvent' && el.formFields !== undefined
      ? [renderFormBlock(el.formFields)]
      : [];
  return [...form, ...structuredMembers(el)];
}

function structuredMembers(el: SettingsCarrier): Lines[] {
  return [...ioParameters(el), ...listenerMembers(el)];
}

/** `keyOf` respells each key for a second carrier sharing the parens. */
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

/** Own settings, then the loop's under the `run` spellings and its documentation. */
function engineSettings(el: EngineAttributes & Repeatable): string[] {
  return [
    ...jobSettingItems(el),
    ...(repeats(el.loop)
      ? [
          ...jobSettingItems(el.loop, runSettingKey),
          ...documentationSetting(
            VALUE_DOCUMENTATION_KEYS.count,
            el.loop.cardinalityDocumentation,
          ),
          ...documentationSetting(
            VALUE_DOCUMENTATION_KEYS.each,
            el.loop.elementVariableDocumentation,
          ),
        ]
      : []),
  ];
}

function documentationSetting(key: string, text: string | undefined): string[] {
  return text === undefined ? [] : [setting(key, quoteLiteral(text))];
}

/** Fields hang off the binding, so `structuredMembers` cannot place them. */
function fieldMembers(binding: ServiceTaskBinding | ListenerBinding): Lines[] {
  const fields = carriesFields(binding) ? (binding.fields ?? []) : [];
  return fields.map((field) => [
    `${FIELD_DIRECTION} ${printName(field.name)} = ${quote(field.value)}`,
  ]);
}

/** IR order is the engine's evaluation order. */
function ioParameters(el: IoMapped): Lines[] {
  const members: Lines[] = [];
  for (const param of el.inputParameters ?? []) {
    members.push([
      `${INPUT_DIRECTION} ${printName(param.name)} = ${renderIoValue(param.value)}`,
    ]);
  }
  for (const param of el.outputParameters ?? []) {
    members.push([
      `${OUTPUT_DIRECTION} ${printName(param.name)} = ${renderIoValue(param.value)}`,
    ]);
  }
  return members;
}

/**
 * A map key is a plain `STRING` in the grammar, never an expression, so it
 * quotes as a literal.
 */
function renderIoValue(value: IoValue): string {
  switch (value.kind) {
    case 'text':
      return quote(value.text);
    case 'list':
      return `[${value.items.map(renderIoValue).join(', ')}]`;
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
 * The two listener event vocabularies are disjoint, so the event word tells
 * them apart on re-parse.
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
  const timerDocumentation = documentationSetting(
    VALUE_DOCUMENTATION_KEYS.timer,
    timer?.expressionDocumentation,
  );
  return binding.kind === 'script'
    ? [
        `${head}${timerDocumentation.length > 0 ? parens(timerDocumentation) : ''} ${renderFence(binding.format, binding.code)}`,
      ]
    : withMembers(
        head + parens([renderCodeBinding(binding), ...timerDocumentation]),
        fieldMembers(binding),
      );
}

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
 * No newline before the closing fence: the parser would absorb it into the
 * body.
 */
function renderFence(format: string, code: string): string {
  return `\`\`\`${format}\n${code}\`\`\``;
}

/**
 * An id in its own kind's minted form, which the validator refuses in source.
 * An end also matches the throw prefix, since `throw` lowers to an end event.
 */
export function isSynthesizedTerminalId(
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
 * An elided start's timer-job settings lift into the header, where the compiler
 * puts them back.
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

function buildBoundaryHeader(
  boundary: Extract<FlowElement, { kind: 'boundaryEvent' }>,
  names: PrintNames,
): Lines {
  const trigger = renderTrigger(boundary.eventDefinition, names);
  return bodyHeader(
    `on ${printName(boundary.attachedToRef)}: ${trigger.head}`,
    [
      ...trigger.items,
      ...jobSettingItems(boundary),
      ...alongsideFlag(boundary.cancelActivity === false),
    ],
    structuredMembers(boundary),
  );
}

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
        items: [
          renderRawCondition(def.condition),
          ...documentationSetting(
            VALUE_DOCUMENTATION_KEYS.condition,
            def.conditionDocumentation,
          ),
        ],
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

function payloadItem(code: string | undefined): string[] {
  return code === undefined ? [] : [quote(code)];
}

function codeItem(
  names: ReadonlyMap<string, string>,
  code: string | undefined,
): string[] {
  return code === undefined ? [] : [names.get(code) ?? printName(code)];
}

function renderTimerTrigger(def: Extract<EventDefinition, { kind: 'timer' }>): {
  head: string;
  items: string[];
} {
  const particle = TIMER_PARTICLE_BY_KIND[def.timerKind];
  const time = quote(def.expression);
  return {
    head: 'timer',
    items: [
      def.timerKind === 'duration' ? time : setting(particle, time),
      ...documentationSetting(
        VALUE_DOCUMENTATION_KEYS.timer,
        def.expressionDocumentation,
      ),
    ],
  };
}

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
    `start ${printName(el.id)}${head}`,
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
  return bracketed(`user ${printName(el.id)}${repeatClause(el)}`, settings, [
    ...form,
    ...structuredMembers(el),
  ]);
}

/** Braces even with no fields: `form` alone does not parse. */
function renderFormBlock(formFields: FormField[]): Lines {
  return [
    'form {',
    ...formFields.flatMap(renderFormField).map((line) => INDENT + line),
    '}',
  ];
}

function renderFormField(field: FormField): Lines {
  const label =
    field.label !== undefined ? ` ${quoteLiteral(field.label)}` : '';
  const def =
    field.defaultValue !== undefined
      ? ` = ${renderFormDefault(field.defaultValue, field.type)}`
      : '';
  const head = `${field.id}: ${field.type}${label}${def}`;
  const settings = fieldSettings(field);
  // Unlike statement heads, a field puts a space before its parens.
  const headWithSettings =
    settings.length === 0 ? head : `${head} ${parens(settings)}`;
  return withMembers(headWithSettings, fieldBlockMembers(field));
}

/**
 * Bare only for a number or boolean literal that lowers back to the same text.
 * Operaton evaluates a default as an expression, so anything else bare
 * (`maybe`, `1 + 1`, `-3`) would change meaning.
 */
function renderFormDefault(value: string, type: FormFieldType): string {
  const bare =
    (type === 'number' || type === 'boolean') &&
    FORM_DEFAULT_LITERAL.test(value) &&
    (type !== 'number' || String(Number(value)) === value);
  return bare ? value : quote(value);
}

// Canonical spellings only (`1.50` would lower to `1.5`). The round-trip check
// in `renderFormDefault` catches values `Number` rounds (past 2^53).
const FORM_DEFAULT_LITERAL = /^(0|[1-9]\d*)(\.\d*[1-9])?$|^(true|false)$/;

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

function fieldBlockMembers(field: FormField): Lines[] {
  const values = (field.values ?? []).map((value) => [renderFormValue(value)]);
  return [...values, ...propertyMembers(field.properties)];
}

function renderFormValue(value: FormFieldValue): string {
  return value.label === undefined
    ? value.id
    : `${value.id} ${quoteLiteral(value.label)}`;
}

/**
 * `quote`, not `quoteLiteral`: a `${...}` value must re-lex as an expression.
 */
function propertyMembers(properties: ExtensionProperty[] | undefined): Lines[] {
  return (properties ?? []).map((p) => [
    `${PROPERTY_DIRECTION} ${printName(p.key)} = ${quote(p.value)}`,
  ]);
}

/** `codeDeclarations` names every mapped code. */
function errorMappingMembers(
  mappings: ErrorMapping[] | undefined,
  names: PrintNames,
): Lines[] {
  return (mappings ?? []).map((m) => [
    `${ERROR_MAPPING_HEAD} ${names.error.get(m.errorCode) ?? printName(m.errorCode)} ${ERROR_MAPPING_WHEN} ${renderRawCondition(m.condition)}`,
  ]);
}

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
    `receive ${printName(el.id)}${repeatClause(el)}`,
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
    `${keyword} ${printName(el.id)}${repeatClause(el)}`,
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
        setting(EXTERNAL_BINDING_KEY, quote(binding.topic)),
        ...(binding.taskPriority === undefined
          ? []
          : [
              setting(
                TASK_PRIORITY_KEY,
                renderNumericValue(binding.taskPriority),
              ),
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

function throwBindingSettings(el: { binding?: ServiceTaskBinding }): string[] {
  return el.binding === undefined ? [] : bindingSettings(el.binding);
}

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

  // `quote`, not `quoteLiteral`: the body must re-lex as an expression.
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
    `call ${printName(el.id)}${repeatClause(el)}`,
    settings,
    members,
  );
}

/**
 * Operaton trims before detecting an expression, so trimming keeps the `${`
 * right after the quote.
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
    `script ${printName(el.id)}${repeatClause(el)}`,
    settings,
    structuredMembers(el),
  );
  lines[lines.length - 1] += ` ${renderFence(el.format, el.code)}`;
  return lines;
}

function namedSettings(el: Named): string[] {
  return [
    ...(el.name === undefined ? [] : [setting('label', quoteLiteral(el.name))]),
    ...documentationSetting(DOCUMENTATION_KEY, el.documentation),
  ];
}

function setting(key: string, value: string): string {
  return `${key}: ${value}`;
}

function bracketed(head: string, settings: string[], members: Lines[]): Lines {
  return withMembers(head + parens(settings), members);
}

function bodyHeader(head: string, settings: string[], members: Lines[]): Lines {
  const lines = withMembers(head + parens(settings), members);
  lines[lines.length - 1] += ' {';
  return lines;
}

function pushBlock(
  lines: string[],
  header: Lines,
  body: readonly string[],
): void {
  lines.push(...header);
  for (const l of body) lines.push(INDENT + l);
  lines.push('}');
}

function withMembers(head: string, members: Lines[]): Lines {
  if (members.length === 0) return [head];
  return [`${head} {`, ...members.flat().map((line) => INDENT + line), '}'];
}

function parens(settings: string[]): string {
  return settings.length === 0 ? '' : `(${settings.join(', ')})`;
}

function headSettings(settings: string[]): string {
  return settings.length === 0 ? '' : ` ${parens(settings)}`;
}

export const BARE_CARDINALITY = /^\d+$/;

/**
 * Names are claimed across both kinds, which share one scope. An undeclared
 * code still gets a declaration, since a use site is a bare name.
 */
function codeDeclarations(process: BpmnProcess): {
  lines: string[];
  names: PrintNames;
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
    names[kind].set(decl.code, printName(name));
    lines.push(
      `${kind} ${printName(name)}` +
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
 * BPMN has no declarations, so every bare variable read gets `var <name>: any`,
 * minus what the validator's `DefaultVariableSymbolProvider` already types.
 * Sorted by name, since restructuring reorders statements.
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
        if (loop.collection !== undefined && isPlainName(loop.collection)) {
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
            ID_TEXT.test(mapping.source)
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
    .sort()
    .map((name) => `${INDENT}var ${name}: any`);
}

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
 * Operaton reads a bare `operaton:collection` as a variable name, only `${...}`
 * as an expression.
 */
function repeatClause(el: Repeatable): string {
  const loop = el.loop;
  if (!repeats(loop)) return '';

  const parts: string[] = [];
  if (loop.cardinality !== undefined) {
    parts.push(
      BARE_CARDINALITY.test(loop.cardinality)
        ? loop.cardinality
        : cardinalityValue(loop.cardinality),
    );
  }
  if (loop.collection !== undefined) {
    const element =
      loop.elementVariable === undefined ? '' : `${loop.elementVariable} `;
    const collection = isPlainName(loop.collection)
      ? loop.collection
      : quote(loop.collection);
    parts.push(`each ${element}in ${collection}`);
  }
  if (loop.sequential === true) parts.push('sequentially');
  if (loop.completionCondition !== undefined) {
    parts.push(
      `until (${documentedCondition(loop.completionCondition, loop.completionConditionDocumentation)})`,
    );
  }
  return ` for ${parts.join(' ')}`;
}

/**
 * Text around a template is one composite expression, evaluated to text the
 * engine reads as an integer. Quoting keeps it verbatim, where wrapping it as a
 * raw body would nest one '${' inside another.
 */
function cardinalityValue(body: string): string {
  return singleTemplateBody(body.trim()) === undefined
    ? quote(body)
    : renderRawCondition(body);
}

/** The text inside a condition head's parentheses. */
function renderCondition(flow: SequenceFlow): string {
  return documentedCondition(
    flow.conditionExpression ?? '',
    flow.conditionDocumentation,
  );
}

function documentedCondition(
  body: string,
  documentation: string | undefined,
): string {
  return [
    renderRawCondition(body),
    ...documentationSetting(VALUE_DOCUMENTATION_KEYS.condition, documentation),
  ].join(', ');
}

function renderRawCondition(body: string): string {
  return renderRawFallback(parseJuel(body));
}

/**
 * For a value the engine evaluates: `${`/`#{` must keep re-lexing as a raw
 * template.
 */
function quote(value: string): string {
  return `"${escapeQuoted(value)}"`;
}

/**
 * For text that must round-trip byte for byte. A leading `${`/`#{` gets a
 * backslash so it lexes as a `STRING`; the reader returns `\$`/`\#` unchanged.
 */
function quoteLiteral(value: string): string {
  const escaped = escapeQuoted(value);
  return `"${/^[$#]\{/.test(escaped) ? '\\' + escaped : escaped}"`;
}
