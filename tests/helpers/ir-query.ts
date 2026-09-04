import type {
  EventDefinition,
  FlowContainer,
  FlowElement,
} from '@bpmn-script/transform';

export function kindOf(
  container: FlowContainer,
  id: string,
): string | undefined {
  return container.flowElements.find((fe) => fe.id === id)?.kind;
}

export function idsOf(container: FlowContainer): Set<string> {
  return new Set(container.flowElements.map((fe) => fe.id));
}

export function subProcess(
  container: FlowContainer,
  id: string,
): Extract<FlowElement, { kind: 'subProcess' }> {
  const el = container.flowElements.find(
    (fe) => fe.kind === 'subProcess' && fe.id === id,
  );
  if (el === undefined || el.kind !== 'subProcess') {
    throw new Error(
      `expected a sub-process '${id}' in container '${container.id}'`,
    );
  }
  return el;
}

// Recurses into sub-processes.
export function allElements(container: FlowContainer): FlowElement[] {
  return container.flowElements.flatMap((fe) =>
    fe.kind === 'subProcess' ? [fe, ...allElements(fe)] : [fe],
  );
}

export function elementById(container: FlowContainer, id: string): FlowElement {
  const found = allElements(container).find((fe) => fe.id === id);
  if (found === undefined) {
    throw new Error(`no flow element '${id}' in '${container.id}'`);
  }
  return found;
}

export function endEvent(
  container: FlowContainer,
  id: string,
): Extract<FlowElement, { kind: 'endEvent' }> {
  const found = elementById(container, id);
  if (found.kind !== 'endEvent') {
    throw new Error(`expected '${id}' to be an end event, found ${found.kind}`);
  }
  return found;
}

// Searched at any depth, so a throw or emit inside an `on` handler body counts.
export function definitionOf(
  container: FlowContainer,
  id: string,
): EventDefinition | undefined {
  const fe = allElements(container).find((e) => e.id === id);
  if (fe?.kind === 'endEvent' || fe?.kind === 'intermediateThrowEvent') {
    return fe.eventDefinition;
  }
  return undefined;
}

// A handler's trigger sits on the start event of the event sub-process it
// lowers to, so match on what it catches, never on the synthesized id. Every
// event sub-process at any depth contributes, an unset trigger included.
export function handlerTriggerDefs(
  container: FlowContainer,
): (EventDefinition | undefined)[] {
  return container.flowElements.flatMap((fe) => {
    if (fe.kind !== 'subProcess') return [];
    const nested = handlerTriggerDefs(fe);
    if (fe.triggeredByEvent !== true) return nested;
    const start = fe.flowElements.find((e) => e.kind === 'startEvent');
    return [
      start?.kind === 'startEvent' ? start.eventDefinition : undefined,
      ...nested,
    ];
  });
}

export function handlerTriggerDef(
  container: FlowContainer,
  match: (def: EventDefinition | undefined) => boolean,
): EventDefinition | undefined {
  return handlerTriggerDefs(container).find(match);
}

// Locating a node by what it is, not by id, is what lets a suite pin a carrier
// whose id the lowering synthesizes. Throws unless exactly one matches.
export function theOnly<K extends FlowElement['kind']>(
  container: FlowContainer,
  kind: K,
  predicate: (el: Extract<FlowElement, { kind: K }>) => boolean = () => true,
): Extract<FlowElement, { kind: K }> {
  const matches = allElements(container).filter(
    (fe): fe is Extract<FlowElement, { kind: K }> =>
      fe.kind === kind && predicate(fe as Extract<FlowElement, { kind: K }>),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${kind} in '${container.id}', found ${matches.length}`,
    );
  }
  return matches[0]!;
}
