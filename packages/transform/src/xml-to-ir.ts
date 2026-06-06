/**
 * BPMN 2.0 XML → IR transform.
 *
 * Inverse of {@link irToXml}. Accepts a BPMN XML string and produces an
 * engine-agnostic {@link BpmnProcess}. Diagram interchange (DI) data is
 * discarded per ADR 0003 — the IR holds semantics only.
 *
 * Dual-namespace handling: Operaton accepts the legacy `camunda:` prefix
 * as an alias for `operaton:` on import. This transform does the same:
 * when both `operaton:assignee` and `camunda:assignee`
 * are present, `operaton:` wins. When only `camunda:assignee` is given,
 * its value is read into the IR.
 *
 * Unsupported constructs (parallel gateways, script tasks, service tasks
 * via `operaton:expression`, etc.) raise a typed error rather than being
 * silently dropped, so importers see a loud diagnostic instead of a
 * mysterious runtime mismatch.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BpmnModdle } from 'bpmn-moddle';

import type {
  BpmnProcess,
  EndEvent,
  ExclusiveGateway,
  FlowElement,
  SequenceFlow,
  ServiceTaskJavaClass,
  StartEvent,
  UserTask,
} from './ir/types.js';

import {
  UnsupportedElementError,
  UnsupportedServiceTaskFormError,
} from './errors.js';

/**
 * Resolve the path to `operaton-moddle.json`. Tried locations, in order:
 *
 *   1. `./operaton-moddle.json`      — vitest reads source directly.
 *   2. `../src/operaton-moddle.json` — compiled `out/` consumer.
 */
function resolveOperatonModdlePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, 'operaton-moddle.json'),
    join(moduleDir, '..', 'src', 'operaton-moddle.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate operaton-moddle.json. Looked in: ${candidates.join(', ')}`,
  );
}

/**
 * Load the local Operaton moddle extension at module-init time. The
 * Operaton extension lets `bpmn-moddle` parse `operaton:` attributes as
 * typed properties; without it, those attributes would still be
 * accessible (they fall through to the moddle element's `$attrs`), but
 * loading the extension keeps the read path symmetric with irToXml and
 * preserves correct handling of typed nested elements.
 *
 * The `camunda:` namespace is intentionally **not** registered as a
 * moddle extension. The official `camunda-bpmn-moddle` package defines
 * many of the same property names (`class`, `assignee`, `formKey`,
 * `historyTimeToLive`) on the same BPMN types as our Operaton fork, and
 * `moddle` refuses to register colliding properties — registration fails
 * with `property <…> already defined; … not allowed without redefines`.
 * Since `camunda:*` attributes are reachable via the same
 * `element.get('camunda:…')` API (moddle falls through to `$attrs` for
 * unknown attributes), we do not need the extension at all to honour the
 * dual-namespace contract.
 *
 * Read via `fs.readFileSync` rather than `import ... with { type:
 * 'json' }` so the package compiles under TypeScript's `NodeNext`
 * resolution without enabling `resolveJsonModule`.
 */
const operatonModdleExtension: unknown = JSON.parse(
  readFileSync(resolveOperatonModdlePath(), 'utf-8'),
);

/**
 * Loose moddle-element type. The library is intentionally not strongly
 * typed; using `unknown` everywhere would force a cast on every property
 * read, which is more noise than safety. We restrict ourselves to a tiny
 * surface (`$type`, `id`, `get`, `$attrs`) shared by every moddle node.
 */
interface ModdleElement {
  readonly $type: string;
  readonly id?: string;
  readonly $attrs: Record<string, string | undefined>;
  get(name: string): unknown;
}

/**
 * Parse a BPMN 2.0 XML document into the engine-agnostic IR.
 *
 * @param xml The full BPMN XML document (as a string).
 * @returns The IR representation of the single `bpmn:Process` element
 *   contained in the document.
 * @throws {Error} when the XML is malformed, contains no `bpmn:Process`,
 *   or contains more than one `bpmn:Process` (multi-process definitions
 *   are out of scope).
 * @throws {UnsupportedElementError} when an unsupported flow-element
 *   kind is encountered (e.g. `bpmn:parallelGateway`).
 * @throws {UnsupportedServiceTaskFormError} when a `bpmn:ServiceTask`
 *   uses an execution discriminator the IR cannot represent (e.g.
 *   `operaton:expression`).
 */
export async function xmlToIr(xml: string): Promise<BpmnProcess> {
  const moddle = new BpmnModdle({
    operaton: operatonModdleExtension as Record<string, unknown>,
  });

  // `bpmn-moddle.fromXML` throws on structurally malformed input. The
  // `warnings` collection here flags soft issues such as unknown
  // extension attributes — these are expected when, for example, a
  // service task carries `operaton:expression`: moddle doesn't know that
  // attribute (we deliberately do not extend the extension to declare
  // attributes we refuse to support) but the attribute still lands in
  // the element's `$attrs`, which our domain logic inspects below to
  // raise a typed `UnsupportedServiceTaskFormError`. We therefore
  // tolerate warnings here and let the structural checks surface real
  // problems.
  const { rootElement } = await moddle.fromXML(xml);

  const root = rootElement as ModdleElement;
  if (root.$type !== 'bpmn:Definitions') {
    throw new Error(
      `Expected root element 'bpmn:Definitions', got '${root.$type}'.`,
    );
  }

  const rootElements = (root.get('rootElements') as ModdleElement[]) ?? [];
  const processes = rootElements.filter((e) => e.$type === 'bpmn:Process');
  if (processes.length === 0) {
    throw new Error(
      'BPMN document contains no <bpmn:process> root element — nothing to import.',
    );
  }
  if (processes.length > 1) {
    throw new Error(
      'Multi-process definitions are not supported ' +
        `(found ${processes.length} <bpmn:process> elements).`,
    );
  }

  return mapProcess(processes[0]);
}

/**
 * Map a `bpmn:Process` moddle element into the IR. All `bpmndi:`, `dc:`,
 * `di:` content lives outside the process subtree, so simply iterating
 * `flowElements` drops every DI artefact for free.
 */
function mapProcess(processEl: ModdleElement): BpmnProcess {
  const id = processEl.id;
  if (id === undefined) {
    throw new Error("<bpmn:process> is missing its required 'id' attribute.");
  }
  const name = readString(processEl, 'name');

  const flowElements: FlowElement[] = [];
  const sequenceFlows: SequenceFlow[] = [];

  const children = (processEl.get('flowElements') as ModdleElement[]) ?? [];
  for (const child of children) {
    switch (child.$type) {
      case 'bpmn:StartEvent':
        flowElements.push(mapStartEvent(child));
        break;
      case 'bpmn:EndEvent':
        flowElements.push(mapEndEvent(child));
        break;
      case 'bpmn:UserTask':
        flowElements.push(mapUserTask(child));
        break;
      case 'bpmn:ServiceTask':
        flowElements.push(mapServiceTask(child));
        break;
      case 'bpmn:ExclusiveGateway':
        flowElements.push(mapExclusiveGateway(child));
        break;
      case 'bpmn:SequenceFlow':
        sequenceFlows.push(mapSequenceFlow(child));
        break;
      default:
        throw new UnsupportedElementError(child.$type, child.id);
    }
  }

  return {
    id,
    ...(name === undefined ? {} : { name }),
    isExecutable: true,
    flowElements,
    sequenceFlows,
  };
}

/** Map a `bpmn:StartEvent` moddle element into the IR. */
function mapStartEvent(el: ModdleElement): StartEvent {
  const id = requireId(el);
  const name = readString(el, 'name');
  return {
    kind: 'startEvent',
    id,
    ...(name === undefined ? {} : { name }),
  };
}

/** Map a `bpmn:EndEvent` moddle element into the IR. */
function mapEndEvent(el: ModdleElement): EndEvent {
  const id = requireId(el);
  const name = readString(el, 'name');
  return {
    kind: 'endEvent',
    id,
    ...(name === undefined ? {} : { name }),
  };
}

/**
 * Map a `bpmn:UserTask` moddle element into the IR.
 *
 * `assignee` and `formKey` accept both `operaton:` and the deprecated
 * `camunda:` prefix; `operaton:` takes precedence when both are present.
 */
function mapUserTask(el: ModdleElement): UserTask {
  const id = requireId(el);
  const name = readString(el, 'name');
  const assignee = readNamespacedAttr(el, 'assignee');
  const formKey = readNamespacedAttr(el, 'formKey');

  return {
    kind: 'userTask',
    id,
    ...(name === undefined ? {} : { name }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(formKey === undefined ? {} : { formKey }),
  };
}

/**
 * Map a `bpmn:ServiceTask` moddle element into the IR.
 *
 * Only the Java-class pattern is supported. Any other execution
 * discriminator (`operaton:expression`, `operaton:delegateExpression`,
 * `operaton:type`) raises {@link UnsupportedServiceTaskFormError} so the
 * caller cannot silently lose runtime semantics.
 */
function mapServiceTask(el: ModdleElement): ServiceTaskJavaClass {
  const id = requireId(el);
  const name = readString(el, 'name');
  const javaClass = readNamespacedAttr(el, 'class');

  if (javaClass !== undefined) {
    return {
      kind: 'serviceTask',
      id,
      ...(name === undefined ? {} : { name }),
      javaClass,
    };
  }

  // No Java-class discriminator. Identify which unsupported form was
  // used (if any) so the error message is actionable.
  const detected = detectUnsupportedServiceTaskForm(el);
  throw new UnsupportedServiceTaskFormError(id, detected);
}

/**
 * Inspect a service task that lacks `operaton:class` / `camunda:class`
 * and return a human-readable description of the form it actually used.
 * Falls back to a placeholder when none of the recognised constructs is
 * present (e.g. a bare `<bpmn:serviceTask>` with no execution attribute).
 */
function detectUnsupportedServiceTaskForm(el: ModdleElement): string {
  const tryRead = (localName: string): string | undefined =>
    readNamespacedAttr(el, localName);

  if (tryRead('expression') !== undefined) return 'operaton:expression';
  if (tryRead('delegateExpression') !== undefined)
    return 'operaton:delegateExpression';
  if (tryRead('type') !== undefined) return 'operaton:type';
  return 'no execution discriminator';
}

/**
 * Map a `bpmn:ExclusiveGateway` moddle element into the IR.
 *
 * The `default` attribute is a moddle reference to a `bpmn:SequenceFlow`
 * after parsing — we extract just the `id` so the IR carries strings
 * everywhere, not live object references (keeps the IR serialisable).
 */
function mapExclusiveGateway(el: ModdleElement): ExclusiveGateway {
  const id = requireId(el);
  const name = readString(el, 'name');
  const defaultRef = el.get('default');
  const defaultFlowId =
    defaultRef !== undefined && defaultRef !== null
      ? (defaultRef as ModdleElement).id
      : undefined;

  return {
    kind: 'exclusiveGateway',
    id,
    ...(name === undefined ? {} : { name }),
    ...(defaultFlowId === undefined ? {} : { defaultFlowId }),
  };
}

/**
 * Map a `bpmn:SequenceFlow` moddle element into the IR.
 *
 * `sourceRef` / `targetRef` arrive as moddle element references; we
 * store only their ids. `conditionExpression` is a
 * `bpmn:FormalExpression` child whose `body` carries the raw expression
 * text (e.g. `${amount > 1000}`).
 */
function mapSequenceFlow(el: ModdleElement): SequenceFlow {
  const id = requireId(el);

  const source = el.get('sourceRef') as ModdleElement | undefined;
  const target = el.get('targetRef') as ModdleElement | undefined;
  if (source === undefined || source.id === undefined) {
    throw new Error(
      `<bpmn:sequenceFlow id="${id}"> has no resolvable sourceRef.`,
    );
  }
  if (target === undefined || target.id === undefined) {
    throw new Error(
      `<bpmn:sequenceFlow id="${id}"> has no resolvable targetRef.`,
    );
  }

  const expressionEl = el.get('conditionExpression') as
    | ModdleElement
    | undefined;
  const conditionExpression =
    expressionEl !== undefined
      ? ((expressionEl.get('body') as string | undefined) ?? undefined)
      : undefined;

  return {
    id,
    sourceRef: source.id,
    targetRef: target.id,
    ...(conditionExpression === undefined ? {} : { conditionExpression }),
  };
}

/**
 * Resolve the `id` attribute, throwing a clear error when it is absent.
 * Every flow element in a well-formed BPMN file has an `id` — a missing
 * one almost always means a hand-edited file with a typo.
 */
function requireId(el: ModdleElement): string {
  if (el.id === undefined || el.id === '') {
    throw new Error(`<${el.$type}> is missing its required 'id' attribute.`);
  }
  return el.id;
}

/**
 * Read a string-valued moddle property. Returns `undefined` when the
 * property is absent, empty, or non-string (so the caller can use the
 * spread-conditional pattern to omit `name` from the resulting IR
 * literal rather than emitting `name: undefined`).
 */
function readString(el: ModdleElement, name: string): string | undefined {
  const value = el.get(name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read an extension attribute that may be qualified by either the
 * `operaton:` or `camunda:` prefix. `operaton:` wins when both are
 * present (Operaton documents the `camunda:` prefix as deprecated).
 *
 * Both lookups go through `moddle`'s `get`, which transparently falls
 * back to the element's raw `$attrs` map when the property is not
 * declared by an extension — this lets us read `camunda:*` attributes
 * without registering the conflicting `camunda-bpmn-moddle` extension.
 */
function readNamespacedAttr(
  el: ModdleElement,
  localName: string,
): string | undefined {
  const operaton = el.get(`operaton:${localName}`);
  if (typeof operaton === 'string' && operaton.length > 0) {
    return operaton;
  }
  const camunda = el.get(`camunda:${localName}`);
  if (typeof camunda === 'string' && camunda.length > 0) {
    return camunda;
  }
  return undefined;
}
