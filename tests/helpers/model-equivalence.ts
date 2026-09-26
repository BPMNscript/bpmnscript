// Whether a recompiled print keeps its source's model, cheapest check first:
// `normalizeIr` equality; that after canonicalizing JUEL and minted ids; and a
// path signature where every step keeps its content and reaches the same next
// steps through the same conditions, defaults and non-trivial gateways.

import { isGateway, parseJuel } from '@bpmn-script/transform';
import type { BpmnProcess, FlowElement } from '@bpmn-script/transform';
import { normalizeIr } from './normalize-ir.js';

export type ModelComparison = 'same' | 'canonical' | 'restructured' | 'changed';

export function compareModels(a: BpmnProcess, b: BpmnProcess): ModelComparison {
  if (stable(normalizeIr(a)) === stable(normalizeIr(b))) return 'same';
  if (canonicalForm(a) === canonicalForm(b)) return 'canonical';
  if (stable(modelSignature(a)) === stable(modelSignature(b))) {
    return 'restructured';
  }
  return 'changed';
}

// Expressions go first: a minted coordinate name embeds its event definition.
function canonicalForm(ir: BpmnProcess): string {
  return stable(
    normalizeIr(canonicalizeCoordinateIds(canonicalExpressions(ir))),
  );
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

// Minted coordinate ids (`Catch_p_0_b1`, `Throw_p_2`, `EventSubProcess_p_3`)
// move whenever the printer reorders or hoists a statement, so each is renamed
// to its content (`#n` on a tie).
const COORDINATE_ID =
  /^(Catch_|Throw_|StartEvent_EventSubProcess_|EndEvent_EventSubProcess_|EndEvent_Boundary_)/;
const EVENT_SUB_PROCESS_ID = /^EventSubProcess_/;
const COORDINATE_GATEWAY_ID = /^Gateway_.+_(split|join|fork|loop|race)$/;

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
  for (const el of elements) {
    if (COORDINATE_ID.test(el.id)) {
      const def = 'eventDefinition' in el ? stable(el.eventDefinition) : '';
      mint(el.id, `${el.kind}:${def}`);
    } else if (EVENT_SUB_PROCESS_ID.test(el.id) && el.kind === 'subProcess') {
      mint(el.id, `EventSubProcess:${handlerContent(el)}`);
    }
  }

  // Gateways are renamed after the events, by kind and renamed neighbours; the
  // second round gives gateway neighbours their first-round names. The role
  // suffix survives so `normalizeIr` still inlines a pass-through join.
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (let round = 0; round < 2; round++) {
    const previous = new Map(rename);
    const neighbourName = (id: string): string => {
      const el = byId.get(id);
      if (el !== undefined && COORDINATE_GATEWAY_ID.test(id)) {
        return round === 0 ? `gateway:${el.kind}` : (previous.get(id) ?? id);
      }
      return previous.get(id) ?? id;
    };
    for (const k of [...used.keys()]) {
      if (k.startsWith('Gateway_')) used.delete(k);
    }
    for (const el of elements) {
      const role = COORDINATE_GATEWAY_ID.exec(el.id)?.[1];
      if (role === undefined) continue;
      const ins = container.sequenceFlows
        .filter((f) => f.targetRef === el.id)
        .map((f) => neighbourName(f.sourceRef))
        .sort();
      const outs = container.sequenceFlows
        .filter((f) => f.sourceRef === el.id)
        .map((f) => neighbourName(f.targetRef))
        .sort();
      mint(
        el.id,
        `Gateway_${el.kind}:[${ins.join(',')}]:[${outs.join(',')}]_${role}`,
      );
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
  const gatewayMark = (el: FlowElement): string | undefined => {
    const { name: _name, ...settings } = ownContent(el);
    return el.kind === 'exclusiveGateway' && Object.keys(settings).length === 1
      ? undefined
      : stable(settings);
  };

  const nodes = container.flowElements.filter((el) => !isGateway(el));
  const routes: { from: string; route: string; to: string }[] = [];
  for (const el of nodes) {
    // Simple paths only, so gateway-only cycles terminate.
    // ponytail: exponential in the length of a gateway-only chain; fine for
    // the chains the compiler emits, memoize per gateway if that changes.
    const walk = (at: string, labels: string[], onPath: Set<string>): void => {
      const source = byId.get(at);
      for (const f of outgoing.get(at) ?? []) {
        const route = [...labels];
        if (f.conditionExpression !== undefined) {
          route.push(`if ${f.conditionExpression}`);
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
