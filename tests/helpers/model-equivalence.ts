// Whether a recompiled print keeps its source's model, cheapest check first:
// `normalizeIr` equality; that after canonicalizing JUEL and minted ids; and a
// path signature where every step keeps its content and reaches the same next
// steps through the same conditions, defaults and non-trivial gateways.
//
// Loaded outside vitest through Node's type stripping: import only the
// workspace packages and `normalize-ir.ts`, with `.ts` extensions.

import {
  HISTORY_TIME_TO_LIVE,
  isGateway,
  isSynthesizedTerminalId,
  parseJuel,
} from '@bpmn-script/transform';
import type {
  BpmnProcess,
  FlowContainer,
  FlowElement,
  SequenceFlow,
} from '@bpmn-script/transform';
import {
  NORMALIZATIONS,
  hasOnly,
  isPlainFlow,
  normalizeIr,
  type NormalizationName,
} from './normalize-ir.ts';

export { NORMALIZATIONS, normalizeIr, type NormalizationName };

export type ModelComparison = 'same' | 'canonical' | 'restructured' | 'changed';

export interface AppliedNormalization {
  /** One name, or a minimal group needed only together, in `NORMALIZATIONS` order. */
  names: NormalizationName[];
  /** Keys of the differences that appear only with these switched off, sorted. */
  elements: string[];
}

export interface ElementDifference {
  /** Container path from the process, ids joined by '/'. */
  container: string;
  /** Element or flow key, or the process's own id for its own fields. */
  element: string;
  only?: 'a' | 'b';
  /** Differing fields as dotted paths; empty when `only` is set. */
  fields: { path: string; a?: unknown; b?: unknown }[];
}

export interface ModelReport {
  level: ModelComparison;
  normalizations: AppliedNormalization[];
  /** Measured on the fully reduced models: empty iff `level` is `same` or `canonical`. */
  differences: ElementDifference[];
}

export function compareModels(a: BpmnProcess, b: BpmnProcess): ModelReport {
  const bridged = withDefaultTimeToLive(a, b);
  const differences = diffModels(reduce(bridged), reduce(b));
  const level: ModelComparison =
    stable(normalizeIr(bridged)) === stable(normalizeIr(b))
      ? 'same'
      : stable(reduce(bridged)) === stable(reduce(b))
        ? 'canonical'
        : stable(modelSignature(bridged)) === stable(modelSignature(b))
          ? 'restructured'
          : 'changed';
  return {
    level,
    normalizations: differences.length === 0 ? needed(a, bridged, b) : [],
    differences,
  };
}

// One way only: the exporter writes `HISTORY_TIME_TO_LIVE` for an original
// (`a`) that sets none, so a rebuild (`b`) carrying it is expected. A rebuild
// that loses a value the original set is a real change.
function withDefaultTimeToLive(a: BpmnProcess, b: BpmnProcess): BpmnProcess {
  return a.historyTimeToLive === undefined &&
    b.historyTimeToLive === HISTORY_TIME_TO_LIVE
    ? { ...a, historyTimeToLive: HISTORY_TIME_TO_LIVE }
    : a;
}

// Expressions are canonicalized before ids: a minted coordinate name embeds
// its event definition.
function reduce(
  ir: BpmnProcess,
  off: ReadonlySet<NormalizationName> = new Set(),
): BpmnProcess {
  const expressions = off.has('expression-parse-trees')
    ? ir
    : canonicalExpressions(ir);
  const normalized = normalizeIr(
    off.has('synthesized-ids')
      ? expressions
      : canonicalizeCoordinateIds(expressions),
    off,
  );
  return off.has('implicit-end') ? normalized : withoutImplicitEnds(normalized);
}

// A minted none end event, as `canonicalizeCoordinateIds` renames it.
const MINTED_END = /^endEvent:(#\d+)?$/;

// Drops each minted, settings-free none end event whose every incoming flow is
// plain and its source's only outgoing one, the source being no gateway: a
// gateway left with no flow runs its own code, not the one below. Operaton ends a token that finds
// no outgoing flow with the `execution.end(true)` a none end event runs
// (`BpmnActivityBehavior.handleNoTransitions`), and with `asyncAfter` the
// activity end is then the async step, so the job count matches too. Only a
// minted id marks an end as one the compiler wrote for a branch without
// `end`, so this needs `synthesized-ids`. It runs after `normalizeIr`, so
// pass-through gateways are already gone.
function withoutImplicitEnds<T extends FlowContainer>(container: T): T {
  const byId = new Map(container.flowElements.map((el) => [el.id, el]));
  const fanOut = (id: string): number =>
    container.sequenceFlows.filter((f) => f.sourceRef === id).length;
  const ends = new Set(
    container.flowElements
      .filter((el) => el.kind === 'endEvent' && MINTED_END.test(el.id))
      .filter((el) => hasOnly(el, ['kind', 'id']))
      .map((el) => el.id)
      .filter((id) => {
        const incoming = container.sequenceFlows.filter(
          (f) => f.targetRef === id,
        );
        return incoming.every(
          (f) =>
            isPlainFlow(f) &&
            fanOut(f.sourceRef) === 1 &&
            !isGateway(byId.get(f.sourceRef)!),
        );
      }),
  );
  return {
    ...container,
    flowElements: container.flowElements
      .filter((el) => !ends.has(el.id))
      .map((el) => (el.kind === 'subProcess' ? withoutImplicitEnds(el) : el)),
    sequenceFlows: container.sequenceFlows.filter(
      (f) => !ends.has(f.targetRef),
    ),
  };
}

// Only for pairs whose reduced models are equal: on a differing pair, switching
// `synthesized-ids` off re-labels an existing difference's key, which would
// read as a new one. A normalization is needed when switching it off alone
// yields a difference. Two that overlap (each suffices alone) are needed by
// neither, so the smallest jointly needed groups stand in for them.
function needed(
  original: BpmnProcess,
  bridged: BpmnProcess,
  b: BpmnProcess,
): AppliedNormalization[] {
  const a = (off: ReadonlySet<NormalizationName>) =>
    off.has('default-history-time-to-live') ? original : bridged;
  const switchedOff = (names: NormalizationName[]) => {
    const off = new Set(names);
    const added = diffModels(reduce(a(off), off), reduce(b, off));
    const elements = [...new Set(added.map(keyOf))].sort();
    return { added: added.length, entry: { names, elements } };
  };

  const singles = NORMALIZATIONS.map((n) => switchedOff([n]))
    .filter(({ added }) => added > 0)
    .map(({ entry }) => entry);
  if (singles.length > 0) return singles;

  const allOff = new Set(NORMALIZATIONS);
  const identicalWithEverythingOff =
    stable(reduce(original, allOff)) === stable(reduce(b, allOff));
  if (identicalWithEverythingOff) return [];

  for (let size = 2; size <= NORMALIZATIONS.length; size++) {
    const groups = subsets(NORMALIZATIONS, size)
      .map(switchedOff)
      .filter(({ added }) => added > 0)
      .map(({ entry }) => entry);
    if (groups.length > 0) return groups;
  }
  return [];
}

function subsets<T>(xs: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  return xs.flatMap((x, i) =>
    subsets(xs.slice(i + 1), size - 1).map((rest) => [x, ...rest]),
  );
}

function keyOf(d: ElementDifference): string {
  return d.container === d.element
    ? d.container
    : `${d.container}/${d.element}`;
}

function diffModels(a: BpmnProcess, b: BpmnProcess): ElementDifference[] {
  const out: ElementDifference[] = [];
  diffContainer(a, b, a.id, a.id, out);
  return out;
}

// A sub-process's own fields and body order are an entry of its parent; its
// body's elements are entries of its own path.
function diffContainer(
  a: FlowContainer,
  b: FlowContainer,
  parent: string,
  element: string,
  out: ElementDifference[],
): void {
  const path = parent === element ? parent : `${parent}/${element}`;
  const { flowElements: _ae, sequenceFlows: _af, ...ownA } = a;
  const { flowElements: _be, sequenceFlows: _bf, ...ownB } = b;
  const elementsA = keyed(a.flowElements, a.sequenceFlows);
  const elementsB = keyed(b.flowElements, b.sequenceFlows);

  // With `element-order` on both sides are sorted, so only an order that
  // normalization left alone can show up here.
  const orderOf = (
    own: Map<string, FlowElement | SequenceFlow>,
    other: Map<string, FlowElement | SequenceFlow>,
    flows: boolean,
  ): string[] =>
    [...own]
      .filter(([k, x]) => other.has(k) && 'sourceRef' in x === flows)
      .map(([k]) => k);
  const fields = fieldDiffs(ownA, ownB);
  for (const [field, flows] of [
    ['flowElements', false],
    ['sequenceFlows', true],
  ] as const) {
    const orderA = orderOf(elementsA, elementsB, flows);
    const orderB = orderOf(elementsB, elementsA, flows);
    if (stable(orderA) !== stable(orderB)) {
      fields.push({ path: field, a: orderA, b: orderB });
    }
  }
  if (fields.length > 0) out.push({ container: parent, element, fields });

  for (const [key, x] of elementsA) {
    const y = elementsB.get(key);
    if (y === undefined) {
      out.push({ container: path, element: key, only: 'a', fields: [] });
    } else if ('flowElements' in x && 'flowElements' in y) {
      diffContainer(x, y, path, key, out);
    } else {
      const fields = fieldDiffs(x, y);
      if (fields.length > 0)
        out.push({ container: path, element: key, fields });
    }
  }
  for (const key of elementsB.keys()) {
    if (!elementsA.has(key)) {
      out.push({ container: path, element: key, only: 'b', fields: [] });
    }
  }
}

// Ids, with an occurrence suffix: re-keyed flows between one pair of nodes
// (a conditioned route and its fallback) share an id.
function keyed(
  elements: FlowElement[],
  flows: SequenceFlow[],
): Map<string, FlowElement | SequenceFlow> {
  const seen = new Map<string, number>();
  return new Map(
    [...elements, ...flows].map((x) => {
      const n = (seen.get(x.id) ?? 0) + 1;
      seen.set(x.id, n);
      return [n === 1 ? x.id : `${x.id} #${n}`, x];
    }),
  );
}

function fieldDiffs(
  a: unknown,
  b: unknown,
  path = '',
  out: ElementDifference['fields'] = [],
): ElementDifference['fields'] {
  if (stable(a) === stable(b)) return out;
  const isRecord = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x);
  if (isRecord(a) && isRecord(b)) {
    for (const k of [
      ...new Set([...Object.keys(a), ...Object.keys(b)]),
    ].sort()) {
      fieldDiffs(a[k], b[k], path === '' ? k : `${path}.${k}`, out);
    }
  } else {
    out.push({
      path,
      ...(a === undefined ? {} : { a }),
      ...(b === undefined ? {} : { b }),
    });
  }
  return out;
}

// `toEqual` semantics on a string: sorted keys, `undefined` dropped.
export function stable(x: unknown): string {
  return JSON.stringify(x, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .filter((k) => o[k] !== undefined)
          .map((k) => [k, o[k]]),
      );
    }
    return v;
  });
}

const EXPRESSION_KEYS =
  /^(conditionExpression|condition|expression|value|source|collection|cardinality|completionCondition|delegateExpression|code|stringValue)$/;
const EXPRESSION_BODY = /^[$#]\{[\s\S]*\}$/;

// A body in the JUEL subset compares by parse tree; a raw body stays verbatim.
function canonicalExpressions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonicalExpressions) as T;
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o).map((k) => {
      const v = o[k];
      if (typeof v !== 'string' || !EXPRESSION_KEYS.test(k)) {
        return [k, canonicalExpressions(v)];
      }
      const body = v.trim();
      if (!EXPRESSION_BODY.test(body)) return [k, v];
      const parsed = parseJuel(body);
      return [
        k,
        parsed.kind === 'structured' ? body[0] + stable(parsed.expr) : v,
      ];
    }),
  ) as T;
}

// Minted ids (`Catch_p_0_b1`, `Throw_p_2`, `EventSubProcess_p_3`) move whenever
// the printer reorders or hoists a statement, so each is renamed to its content
// (`#n` on a tie). A race branch's catch has no id slot in the script, so it is
// recognised by position whatever its id. Gateways need no rename here:
// `normalizeIr` re-keys every one, and the signature never prints their ids.
function canonicalizeCoordinateIds(container: BpmnProcess): BpmnProcess {
  const rename = new Map<string, string>();
  const used = new Map<string, number>();
  const mint = (id: string, base: string): void => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    rename.set(id, n === 1 ? base : `${base}#${n}`);
  };

  // A handler's body is renamed first, so its content key holds no coordinate.
  const elements = container.flowElements.map((el) =>
    el.kind === 'subProcess'
      ? (canonicalizeCoordinateIds(
          el as unknown as BpmnProcess,
        ) as unknown as FlowElement)
      : el,
  );
  const kindOf = new Map(container.flowElements.map((e) => [e.id, e.kind]));
  const raceBranches = new Set(
    container.sequenceFlows
      .filter((f) => kindOf.get(f.sourceRef) === 'eventBasedGateway')
      .map((f) => f.targetRef),
  );
  for (const el of elements) {
    if (el.kind === 'subProcess' && el.triggeredByEvent === true) {
      mint(el.id, `EventSubProcess:${handlerContent(el)}`);
    } else if (
      isSynthesizedTerminalId(el.id, el.kind, container) ||
      (el.kind === 'intermediateCatchEvent' && raceBranches.has(el.id))
    ) {
      const def = 'eventDefinition' in el ? stable(el.eventDefinition) : '';
      mint(el.id, `${el.kind}:${def}`);
    }
  }

  const to = (id: string): string => rename.get(id) ?? id;
  const flowElements = elements.map((el): FlowElement => {
    const renamed = { ...el, id: to(el.id) };
    if ('attachedToRef' in renamed)
      renamed.attachedToRef = to(renamed.attachedToRef);
    return renamed;
  });
  const sequenceFlows = container.sequenceFlows.map((sf) => ({
    ...sf,
    sourceRef: to(sf.sourceRef),
    targetRef: to(sf.targetRef),
  }));
  return { ...container, flowElements, sequenceFlows };
}

// Cannot tie: two handlers with one trigger are a validator error.
function handlerContent(handler: FlowElement & { kind: 'subProcess' }): string {
  const start = handler.flowElements.find((e) => e.kind === 'startEvent');
  return stable({
    ...ownContent(handler),
    start: start === undefined ? undefined : ownContent(start),
  });
}

function ownContent(el: object): Record<string, unknown> {
  const {
    id: _id,
    flowElements: _elements,
    sequenceFlows: _flows,
    defaultFlowId: _default,
    ...rest
  } = el as Record<string, unknown>;
  return rest;
}

// Per container: its content, each non-gateway node, and each gateway-only
// route between two nodes labelled with what it crosses.
export function modelSignature(ir: BpmnProcess): string[] {
  return [
    ...new Set(
      containerSignature(canonicalizeCoordinateIds(canonicalExpressions(ir))),
    ),
  ].sort();
}

function containerSignature(container: BpmnProcess): string[] {
  const byId = new Map(container.flowElements.map((e) => [e.id, e]));
  const outgoing = new Map<string, BpmnProcess['sequenceFlows']>();
  for (const f of container.sequenceFlows) {
    outgoing.set(f.sourceRef, [...(outgoing.get(f.sourceRef) ?? []), f]);
  }

  // A settings-free exclusive gateway is pure routing that a hoist or a loop
  // printed as a `goto` adds or removes; its flow conditions still label the
  // route. Any other gateway changes how the route runs.
  // A join synchronizes its incoming flows, so their number is part of it.
  const gatewayMark = (el: FlowElement): string | undefined => {
    const { name: _name, ...settings } = ownContent(el);
    if (el.kind === 'exclusiveGateway' && Object.keys(settings).length === 1) {
      return undefined;
    }
    const joins = container.sequenceFlows.filter((f) => f.targetRef === el.id);
    return stable({ ...settings, joins: joins.length });
  };

  const nodes = container.flowElements.filter((el) => !isGateway(el));
  const routes: { from: string; route: string; to: string }[] = [];
  for (const el of nodes) {
    // Simple paths only, so gateway-only cycles terminate.
    // ponytail: exponential in the length of a gateway-only chain; fine for
    // the chains the compiler emits, memoize per gateway if that changes.
    const walk = (at: string, labels: string[], onPath: Set<string>): void => {
      const source = byId.get(at);
      // An exclusive gateway tries its non-default flows in document order.
      const ranked =
        source?.kind === 'exclusiveGateway'
          ? (outgoing.get(at) ?? []).filter(
              (f) => f.id !== source.defaultFlowId,
            )
          : [];
      for (const f of outgoing.get(at) ?? []) {
        const route = [...labels];
        const rank = ranked.includes(f) ? `#${ranked.indexOf(f)} ` : '';
        if (f.conditionExpression !== undefined) {
          route.push(`if ${rank}${f.conditionExpression}`);
        } else if (
          source !== undefined &&
          'defaultFlowId' in source &&
          source.defaultFlowId === f.id
        ) {
          route.push('else');
        }
        const target = byId.get(f.targetRef);
        if (target !== undefined && isGateway(target)) {
          if (onPath.has(target.id)) continue;
          const mark = gatewayMark(target);
          if (mark !== undefined) route.push(mark);
          walk(target.id, route, new Set([...onPath, target.id]));
        } else {
          routes.push({
            from: el.id,
            route: route.join('; '),
            to: f.targetRef,
          });
        }
      }
    };
    walk(el.id, [], new Set());
  }

  const key = nodeKeys(byId, nodes, routes);
  const lines = [`container ${stable(ownContent(container))}`];
  for (const el of nodes) {
    lines.push(`node ${key(el.id)}`);
    if (el.kind === 'subProcess') {
      for (const line of containerSignature(el as unknown as BpmnProcess)) {
        lines.push(`${key(el.id)} / ${line}`);
      }
    }
  }
  for (const r of routes) {
    lines.push(`${key(r.from)} -> [${r.route}] -> ${key(r.to)}`);
  }
  return lines;
}

// A node is named by id and content with the positional `#n` dropped; nodes
// that then tie (identical unnamed events) are told apart by colour refinement
// over their routes, or swapped gotos between them would go unnoticed.
function nodeKeys(
  byId: Map<string, FlowElement>,
  nodes: FlowElement[],
  routes: { from: string; route: string; to: string }[],
): (id: string) => string {
  const base = (id: string): string => {
    const el = byId.get(id);
    return `${id.replace(/#\d+$/, '')} ${el === undefined ? '?' : stable(ownContent(el))}`;
  };
  const colour = (id: string): string => shape.get(id) ?? base(id);
  let shape = new Map(nodes.map((el) => [el.id, base(el.id)]));
  for (let classes = 0; ;) {
    const next = new Map(
      nodes.map((el) => [
        el.id,
        stable([
          colour(el.id),
          routes
            .filter((r) => r.from === el.id)
            .map((r) => `-> [${r.route}] ${colour(r.to)}`)
            .sort(),
          routes
            .filter((r) => r.to === el.id)
            .map((r) => `<- [${r.route}] ${colour(r.from)}`)
            .sort(),
        ]),
      ]),
    );
    // Ranks keep shapes short and independent of element order.
    const ranked = [...new Set(next.values())].sort();
    shape = new Map(
      [...next].map(([id, s]) => [id, String(ranked.indexOf(s))]),
    );
    if (ranked.length === classes) break;
    classes = ranked.length;
  }

  const byBase = new Map<string, string[]>();
  for (const el of nodes) {
    const b = base(el.id);
    byBase.set(b, [...(byBase.get(b) ?? []), shape.get(el.id)!]);
  }
  return (id: string): string => {
    const b = base(id);
    const shapes = [...new Set(byBase.get(b) ?? [])].sort(
      (x, y) => Number(x) - Number(y),
    );
    return shapes.length > 1
      ? `${b} #${shapes.indexOf(shape.get(id)!) + 1}`
      : b;
  };
}
