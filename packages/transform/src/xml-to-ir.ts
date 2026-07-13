/**
 * BPMN 2.0 XML → IR transform.
 *
 * Inverse of {@link irToXml}. Accepts a BPMN XML string and produces a
 * {@link BpmnProcess}. Diagram interchange (DI) data is
 * discarded per ADR 0003 — the IR holds semantics only.
 *
 * Dual-namespace handling: Operaton accepts the legacy `camunda:` prefix
 * as an alias for `operaton:` on import. This transform does the same:
 * when both `operaton:assignee` and `camunda:assignee`
 * are present, `operaton:` wins. When only `camunda:assignee` is given,
 * its value is read into the IR.
 *
 * ## Import contract
 *
 * The transform never silently discards content it cannot represent. Its
 * return value is `{ ir, warnings }`, and content splits into two buckets:
 *
 * **Refused** (throws before any IR is produced, so there is no partial IR):
 * - event definitions on start/end events (timer, message, terminate, …) →
 *   {@link UnsupportedEventDefinitionError};
 * - loop characteristics on a task (multi-instance / standard loop) →
 *   {@link UnsupportedLoopCharacteristicsError};
 * - collaborations, i.e. pools and message flows →
 *   {@link UnsupportedCollaborationError};
 * - unsupported flow-element kinds (script task, sub-process, …) →
 *   {@link UnsupportedElementError};
 * - service tasks whose execution form is not `operaton:class` →
 *   {@link UnsupportedServiceTaskFormError}.
 *
 * **Dropped with a warning** (no semantic loss; reported via `warnings`):
 * - Operaton/camunda extension attributes beyond the supported
 *   `assignee`/`formKey`/`class` (e.g. `operaton:asyncBefore`) — one warning
 *   per attribute, attributed to the owning element by id;
 * - engine-specific extension *elements* — one warning per element,
 *   attributed to the owning element by id and naming the concrete construct.
 *   Which elements can be pinned to an exact owner depends on how the parser
 *   sees them:
 *     - `operaton:inputOutput`, `operaton:executionListener`,
 *       `operaton:taskListener` are declared in the moddle extension, so they
 *       materialise as typed values and name their `$type` precisely;
 *     - extension elements in a foreign namespace (e.g. the deprecated
 *       `camunda:` alias) are kept by moddle as generic values and are also
 *       named against their owning element;
 *     - any *other* `operaton:` element the extension does not declare (e.g.
 *       `operaton:properties`) cannot be tied by moddle to a specific step, so
 *       it is reported once against the process id, naming the construct and
 *       its source line — the drop is still reported, only its owner
 *       attribution is coarser;
 * - lanes — one warning per lane.
 *
 * **Round-trips cleanly** (no warning, no refusal): the supported flow
 * elements and their `name`, `assignee`, `formKey`, `class`, condition
 * expressions, and default-flow references.
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
  FormField,
  FormFieldType,
  ParallelGateway,
  SequenceFlow,
  ServiceTaskJavaClass,
  StartEvent,
  UserTask,
} from './ir/types.js';

import {
  UnsupportedCollaborationError,
  UnsupportedElementError,
  UnsupportedEventDefinitionError,
  UnsupportedFormFieldTypeError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedServiceTaskFormError,
} from './errors.js';
import { humanize } from './humanize.js';
import { HISTORY_TIME_TO_LIVE } from './ir-to-xml.js';

/**
 * The category of a non-semantic import drop reported via {@link ImportWarning}.
 *
 * - `extensionAttribute` — an Operaton/camunda extension attribute or
 *   extension element the IR does not carry (e.g. `operaton:asyncBefore`,
 *   an `operaton:inputOutput` block).
 * - `lane` — a `bpmn:Lane`; the IR has no notion of lanes, so every step is
 *   imported into a single flat process.
 */
export type ImportWarningCategory = 'extensionAttribute' | 'lane';

/**
 * A non-fatal notice that `xmlToIr` dropped content which the IR cannot
 * carry but which causes no semantic loss on execution. Refusals (which do
 * cause semantic loss) throw instead — see {@link UnsupportedConstructError}.
 *
 * Warnings live outside the IR (the IR stays serializable, strings only,
 * per ADR 0003); consumers surface them to the user (CLI stderr, VS Code
 * warning) so the drop is never silent.
 */
export interface ImportWarning {
  /** BPMN id of the element the dropped content was attached to. */
  elementId: string;
  category: ImportWarningCategory;
  /** Human-readable description naming the concrete dropped construct. */
  message: string;
}

/**
 * Extension-attribute local names that ARE read into the IR and therefore
 * must NOT be reported as dropped. Matched against the local part of a
 * namespaced attribute regardless of its `operaton:`/`camunda:` prefix.
 */
const SUPPORTED_EXTENSION_ATTRS: ReadonlySet<string> = new Set([
  'assignee',
  'formKey',
  'class',
]);

/**
 * Extension-element `$type`s that ARE read into the IR and therefore must NOT
 * be reported as dropped by {@link collectExtensionDrops}. `operaton:FormData`
 * is consumed by {@link readFormFields} on start events and user tasks.
 */
const CONSUMED_EXTENSION_ELEMENTS: ReadonlySet<string> = new Set([
  'operaton:FormData',
]);

/**
 * `operaton:formField` `type` values mapped to the DSL-level
 * {@link FormFieldType}. `long` maps to `number` (the export direction emits
 * `long` for `number`). `double`, `enum`, and any other type are absent, so
 * {@link readFormFields} refuses them rather than narrowing their semantics.
 */
const OPERATON_TO_FORM_FIELD_TYPE: Readonly<Record<string, FormFieldType>> = {
  string: 'string',
  long: 'number',
  boolean: 'boolean',
  date: 'date',
};

/** Suffix of every dropped-extension warning, naming what IS imported. */
const KEPT_SETTINGS_NOTE =
  '(this tool keeps only the assignee, form, and Java-class settings).';

/**
 * Declared extension attributes whose value the exporter re-stamps as a
 * fixed constant. When the imported value equals the constant, re-export
 * reproduces the document unchanged — nothing is lost, so no warning.
 * Keyed by the namespaced attribute name.
 */
const REEXPORTED_CONSTANT_ATTRS: ReadonlyMap<string, string> = new Map([
  ['operaton:historyTimeToLive', HISTORY_TIME_TO_LIVE],
]);

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
  readonly $descriptor?: {
    readonly properties?: readonly ModdlePropertyDescriptor[];
  };
  get(name: string): unknown;
}

/**
 * A property entry in a moddle type descriptor. `name` is the key the
 * parsed value is stored under on the element instance; `ns.name` is the
 * namespaced form (`operaton:historyTimeToLive`) accepted by `get()`.
 */
interface ModdlePropertyDescriptor {
  readonly name: string;
  readonly isAttr?: boolean;
  readonly ns?: {
    readonly name: string;
    readonly prefix?: string;
    readonly localName: string;
  };
}

/**
 * Parse a BPMN 2.0 XML document into the IR.
 *
 * @param xml The full BPMN XML document (as a string).
 * @returns `{ ir, warnings }` — the IR representation of the single
 *   `bpmn:Process` element in the document, and a list of non-semantic
 *   drops (extra extension attributes/elements, lanes). `warnings` is `[]`
 *   for input that round-trips cleanly.
 * @throws {Error} when the XML is malformed, contains no `bpmn:Process`,
 *   or contains more than one `bpmn:Process` (multi-process definitions
 *   are out of scope).
 * @throws {UnsupportedCollaborationError} when the document contains a
 *   `bpmn:Collaboration` (pools / message flows).
 * @throws {UnsupportedElementError} when an unsupported flow-element
 *   kind is encountered (e.g. `bpmn:scriptTask`, `bpmn:subProcess`).
 * @throws {UnsupportedServiceTaskFormError} when a `bpmn:ServiceTask`
 *   uses an execution discriminator the IR cannot represent (e.g.
 *   `operaton:expression`).
 * @throws {UnsupportedEventDefinitionError} when a start/end event carries
 *   an event definition (timer, message, terminate, …).
 * @throws {UnsupportedLoopCharacteristicsError} when a task carries loop
 *   characteristics (multi-instance or standard loop).
 */
export async function xmlToIr(
  xml: string,
): Promise<{ ir: BpmnProcess; warnings: ImportWarning[] }> {
  const moddle = new BpmnModdle({
    operaton: operatonModdleExtension as Record<string, unknown>,
  });

  // `bpmn-moddle.fromXML` throws on structurally malformed input. The
  // `moddleWarnings` collection flags soft issues. It records an "unparsable
  // content" warning only for elements in the *registered* `operaton:`
  // namespace whose type the extension does not declare (e.g.
  // `operaton:properties`); declared operaton elements materialise as typed
  // values and foreign-namespace elements (e.g. `camunda:`) are kept as
  // generic values — both are attributed per element in `collectExtensionDrops`.
  // The residual "unparsable content" warnings are the narrow case moddle
  // cannot pin to a step; we surface them at the process level below so the
  // drop is never silent.
  const { rootElement, warnings: moddleWarnings } = await moddle.fromXML(xml);

  const root = rootElement as ModdleElement;
  if (root.$type !== 'bpmn:Definitions') {
    throw new Error(
      `Expected root element 'bpmn:Definitions', got '${root.$type}'.`,
    );
  }

  const rootElements = (root.get('rootElements') as ModdleElement[]) ?? [];

  // Collaborations (pools / message flows) live in a `bpmn:Collaboration`
  // root element alongside the process(es). The IR models a single
  // standalone process and cannot represent participants or message flows,
  // so refuse before mapping anything.
  if (rootElements.some((e) => e.$type === 'bpmn:Collaboration')) {
    throw new UnsupportedCollaborationError(
      'multiple linked processes (pools and message flows)',
    );
  }

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

  const warnings: ImportWarning[] = [];
  const ir = mapProcess(processes[0], warnings);
  // Extension elements moddle could not tie to a specific step (undeclared
  // `operaton:` types) surface only as document-level "unparsable content"
  // warnings. Emit one ImportWarning per such moddle warning, attributed to
  // the process — one drop reported per real drop, never fanned out.
  collectUnparsableResidualDrops(moddleWarnings, ir.id, warnings);
  return { ir, warnings };
}

/**
 * A moddle parse warning. `bpmn-moddle` records these for soft issues such as
 * unparsable extension content; the only field we read is the human-readable
 * `message`, which for a dropped element reads like
 * `"unparsable content <operaton:properties> detected\n\tline: 7\n…"`.
 */
interface ModdleWarning {
  readonly message?: string;
}

/**
 * Turn each residual "unparsable content" moddle warning into exactly one
 * {@link ImportWarning}, attributed to the process (`processId`) because
 * moddle cannot tie the dropped element to a specific step.
 *
 * This is driven purely by moddle's own per-drop warnings, so the count is
 * exact — one reported drop per real drop, with no fan-out onto clean
 * elements. Declared operaton elements and foreign-namespace elements never
 * reach here: they materialise as `values` and are attributed per element in
 * {@link collectExtensionDrops}.
 */
function collectUnparsableResidualDrops(
  moddleWarnings: unknown,
  processId: string,
  warnings: ImportWarning[],
): void {
  const list = (moddleWarnings as ModdleWarning[] | undefined) ?? [];
  for (const warning of list) {
    const message = String(warning.message ?? '');
    const match = /unparsable content <([^>]+)>/i.exec(message);
    if (match === null) continue;
    const construct = match[1];
    const lineMatch = /line:\s*(\d+)/i.exec(message);
    const location = lineMatch ? ` at line ${lineMatch[1]}` : '';
    warnings.push({
      elementId: processId,
      category: 'extensionAttribute',
      message:
        `Extra engine-specific configuration (${construct}${location}) was not ` +
        `imported; it could not be attributed to a specific step ${KEPT_SETTINGS_NOTE}`,
    });
  }
}

/**
 * Map a `bpmn:Process` moddle element into the IR. All `bpmndi:`, `dc:`,
 * `di:` content lives outside the process subtree, so simply iterating
 * `flowElements` drops every DI artefact for free.
 *
 * @param warnings Accumulator for non-semantic drops (lanes, extra
 *   extension attributes/elements). Mutated in place.
 */
function mapProcess(
  processEl: ModdleElement,
  warnings: ImportWarning[],
): BpmnProcess {
  const id = processEl.id;
  if (id === undefined) {
    throw new Error("<bpmn:process> is missing its required 'id' attribute.");
  }
  const name = readDerivableName(processEl, id);

  // Lanes are a visual/organisational grouping the flat IR cannot carry —
  // report one warning per lane so the drop is never silent.
  collectLaneDrops(processEl, id, warnings);
  // Extension attributes/elements attached to the process itself.
  collectExtensionDrops(processEl, id, warnings);

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
      case 'bpmn:ParallelGateway':
        flowElements.push(mapParallelGateway(child));
        break;
      case 'bpmn:SequenceFlow':
        sequenceFlows.push(mapSequenceFlow(child));
        break;
      default:
        throw new UnsupportedElementError(child.$type, child.id);
    }
    // Refusals above throw before we reach here; a mapped element may still
    // carry non-semantic extension content the IR does not represent.
    if (child.id !== undefined) {
      collectExtensionDrops(child, child.id, warnings);
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

/**
 * Emit one {@link ImportWarning} (`category:'lane'`) per `bpmn:Lane` in the
 * process. The flat IR has no lane concept, so every step is imported into
 * a single process; the lane assignment is dropped.
 */
function collectLaneDrops(
  processEl: ModdleElement,
  processId: string,
  warnings: ImportWarning[],
): void {
  const laneSets = (processEl.get('laneSets') as ModdleElement[]) ?? [];
  for (const laneSet of laneSets) {
    const lanes = (laneSet.get('lanes') as ModdleElement[]) ?? [];
    for (const lane of lanes) {
      const laneId = lane.id ?? laneSet.id ?? processId;
      const laneName = readString(lane, 'name');
      warnings.push({
        elementId: laneId,
        category: 'lane',
        message:
          `Lane ${laneName ? `'${laneName}' ` : ''}(${laneId}) was not imported; ` +
          'every step is placed in a single flat process.',
      });
    }
  }
}

/**
 * Emit {@link ImportWarning}s (`category:'extensionAttribute'`) for
 * engine-specific content attached to `el` that the IR does not carry:
 *
 * 1. **Extension attributes** — `operaton:`/`camunda:`-prefixed attributes
 *    in `el.$attrs` whose local name is not one of the supported three
 *    (`assignee`/`formKey`/`class`). The supported names are read into the
 *    IR and are therefore never reported, regardless of prefix.
 * 2. **Extension elements** — the materialised children of a
 *    `<bpmn:extensionElements>` block (`extensionElements.values`). The IR
 *    consumes no extension elements, so every materialised child is a drop:
 *    we emit one warning per child, attributed to this element and naming the
 *    child's `$type`. This branch fires only for children moddle actually
 *    materialised — declared `operaton:` types (`operaton:inputOutput`,
 *    `operaton:executionListener`, `operaton:taskListener`) and any
 *    foreign-namespace element (e.g. the deprecated `camunda:` alias), which
 *    moddle keeps as a generic value. An empty `<extensionElements/>` has no
 *    `values`, so it is never flagged.
 *
 *    Undeclared `operaton:` elements (e.g. `operaton:properties`) do NOT
 *    materialise as values; moddle reports them only at the document level.
 *    Those are handled once, per-drop, in {@link collectUnparsableResidualDrops}.
 *
 * 3. **Declared extension attributes** — attributes the operaton moddle
 *    extension declares (e.g. `operaton:historyTimeToLive`) parse into
 *    typed properties on the element, never into `$attrs`, so branch 1
 *    cannot see them. The element's descriptor lists every declared
 *    property; any `operaton:` attribute set in the XML that the IR does
 *    not consume is a drop. Exception: a value the exporter re-stamps
 *    verbatim ({@link REEXPORTED_CONSTANT_ATTRS}) loses no information
 *    and stays silent. New properties added to `operaton-moddle.json`
 *    are picked up here automatically.
 */
function collectExtensionDrops(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  // 1. Extension attributes.
  const attrs = el.$attrs ?? {};
  for (const key of Object.keys(attrs)) {
    const colon = key.indexOf(':');
    if (colon === -1) continue;
    const prefix = key.slice(0, colon);
    const localName = key.slice(colon + 1);
    if (prefix !== 'operaton' && prefix !== 'camunda') continue;
    if (SUPPORTED_EXTENSION_ATTRS.has(localName)) continue;
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message: `The '${key}' setting on '${ownerId}' was not imported ${KEPT_SETTINGS_NOTE}`,
    });
  }

  // 2. Extension elements (materialised children only — see docstring).
  const extensionElements = el.get('extensionElements') as
    ModdleElement | undefined;
  if (extensionElements !== undefined) {
    const values =
      (extensionElements.get('values') as ModdleElement[] | undefined) ?? [];
    for (const value of values) {
      // Extension elements the IR consumes (e.g. operaton:formData) are read in
      // and must not be reported as dropped.
      if (CONSUMED_EXTENSION_ELEMENTS.has(value.$type)) {
        continue;
      }
      warnings.push({
        elementId: ownerId,
        category: 'extensionAttribute',
        message: `Extra configuration (${value.$type}) on '${ownerId}' was not imported.`,
      });
    }
  }

  // 3. Declared extension attributes (typed properties — see docstring).
  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.ns === undefined || prop.ns.prefix !== 'operaton') continue;
    if (prop.isAttr !== true) continue;
    if (SUPPORTED_EXTENSION_ATTRS.has(prop.ns.localName)) continue;
    // Only attributes actually present in the XML: moddle stores parsed
    // values as own properties; descriptor defaults are not own properties.
    if (!Object.prototype.hasOwnProperty.call(el, prop.name)) continue;
    if (el.get(prop.ns.name) === REEXPORTED_CONSTANT_ATTRS.get(prop.ns.name)) {
      continue;
    }
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message: `The '${prop.ns.name}' setting on '${ownerId}' was not imported ${KEPT_SETTINGS_NOTE}`,
    });
  }
}

/**
 * Map a `bpmn:StartEvent` moddle element into the IR.
 *
 * Refuses (throws) when the event carries any event definition (timer,
 * message, signal, error, …) — the IR models plain start events only.
 */
function mapStartEvent(el: ModdleElement): StartEvent {
  const id = requireId(el);
  refuseEventDefinitions(el, id, 'start');
  const name = readDerivableName(el, id);
  const formFields = readFormFields(el, id);
  return {
    kind: 'startEvent',
    id,
    ...(name === undefined ? {} : { name }),
    ...(formFields === undefined ? {} : { formFields }),
  };
}

/**
 * Map a `bpmn:EndEvent` moddle element into the IR.
 *
 * Refuses (throws) when the event carries any event definition (terminate,
 * error, message, …) — the IR models plain end events only.
 */
function mapEndEvent(el: ModdleElement): EndEvent {
  const id = requireId(el);
  refuseEventDefinitions(el, id, 'end');
  const name = readDerivableName(el, id);
  return {
    kind: 'endEvent',
    id,
    ...(name === undefined ? {} : { name }),
  };
}

/**
 * Throw {@link UnsupportedEventDefinitionError} when a start/end event
 * carries one or more event definitions. An empty (or absent)
 * `eventDefinitions` array is a plain event and is allowed.
 */
function refuseEventDefinitions(
  el: ModdleElement,
  id: string,
  eventKind: 'start' | 'end',
): void {
  const defs =
    (el.get('eventDefinitions') as ModdleElement[] | undefined) ?? [];
  if (defs.length > 0) {
    throw new UnsupportedEventDefinitionError(id, eventKind, defs[0].$type);
  }
}

/**
 * Throw {@link UnsupportedLoopCharacteristicsError} when a task carries
 * loop characteristics — either a `bpmn:MultiInstanceLoopCharacteristics`
 * or a `bpmn:StandardLoopCharacteristics` child. The IR models tasks that
 * run exactly once.
 */
function refuseLoopCharacteristics(el: ModdleElement, id: string): void {
  const loop = el.get('loopCharacteristics') as ModdleElement | undefined;
  if (loop !== undefined && loop !== null) {
    throw new UnsupportedLoopCharacteristicsError(id, loop.$type);
  }
}

/**
 * Map a `bpmn:UserTask` moddle element into the IR.
 *
 * `assignee` and `formKey` accept both `operaton:` and the deprecated
 * `camunda:` prefix; `operaton:` takes precedence when both are present.
 */
function mapUserTask(el: ModdleElement): UserTask {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);
  const assignee = readNamespacedAttr(el, 'assignee');
  const formKey = readNamespacedAttr(el, 'formKey');
  const formFields = readFormFields(el, id);

  return {
    kind: 'userTask',
    id,
    ...(name === undefined ? {} : { name }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(formKey === undefined ? {} : { formKey }),
    ...(formFields === undefined ? {} : { formFields }),
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
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);
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
 * Map a `bpmn:ParallelGateway` moddle element into the IR.
 *
 * Parallel gateways carry no `default` attribute — Operaton executes every
 * outgoing path unconditionally, so there is no concept of a default flow.
 * Fork and join roles are determined purely by degree (outgoing vs. incoming
 * count) and require no separate representation in the IR.
 */
function mapParallelGateway(el: ModdleElement): ParallelGateway {
  const id = requireId(el);
  const name = readString(el, 'name');
  return {
    kind: 'parallelGateway',
    id,
    ...(name === undefined ? {} : { name }),
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
    ModdleElement | undefined;
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
 * Read a `name` that may have been auto-derived from the id on export. When the
 * BPMN `name` exactly equals `humanize(id)`, it is treated as derivable and
 * dropped (returns `undefined`), so the IR — and any DSL emitted from it —
 * carries no redundant label. A `name` that differs from the derivation is a
 * genuine label and is kept. This is the inverse of the derivation applied in
 * {@link irToXml} and is what makes the DSL → XML → DSL round-trip idempotent
 * for unlabeled elements.
 */
function readDerivableName(el: ModdleElement, id: string): string | undefined {
  const name = readString(el, 'name');
  return name === undefined || name === humanize(id) ? undefined : name;
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

/**
 * Read an element's `operaton:formData` extension element into IR
 * {@link FormField}s, or `undefined` when the element carries none.
 *
 * The inverse of the form export in {@link irToXml}: each `operaton:formField`
 * becomes a {@link FormField}, mapping the Operaton `type` back to its DSL
 * spelling. A field whose type the DSL cannot express raises
 * {@link UnsupportedFormFieldTypeError} rather than being silently narrowed.
 */
function readFormFields(
  el: ModdleElement,
  ownerId: string,
): FormField[] | undefined {
  const extensionElements = el.get('extensionElements') as
    ModdleElement | undefined;
  if (extensionElements === undefined) {
    return undefined;
  }
  const values =
    (extensionElements.get('values') as ModdleElement[] | undefined) ?? [];
  const formData = values.find((v) => v.$type === 'operaton:FormData');
  if (formData === undefined) {
    return undefined;
  }
  const fields = (formData.get('fields') as ModdleElement[] | undefined) ?? [];
  if (fields.length === 0) {
    return undefined;
  }
  return fields.map((field) => {
    const fieldId = requireId(field);
    const type = importFormFieldType(
      readString(field, 'type'),
      fieldId,
      ownerId,
    );
    const label = readString(field, 'label');
    const defaultValue = readString(field, 'defaultValue');
    return {
      id: fieldId,
      type,
      ...(label === undefined ? {} : { label }),
      ...(defaultValue === undefined ? {} : { defaultValue }),
    };
  });
}

/**
 * Map an `operaton:formField` `type` to its DSL {@link FormFieldType}, refusing
 * any type the DSL cannot express (`double`, `enum`, a custom type, or none).
 */
function importFormFieldType(
  operatonType: string | undefined,
  fieldId: string,
  ownerId: string,
): FormFieldType {
  const mapped =
    operatonType === undefined
      ? undefined
      : OPERATON_TO_FORM_FIELD_TYPE[operatonType];
  if (mapped === undefined) {
    throw new UnsupportedFormFieldTypeError(
      ownerId,
      fieldId,
      operatonType ?? '(none)',
    );
  }
  return mapped;
}
