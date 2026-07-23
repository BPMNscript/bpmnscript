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
 * its value is read into the IR. The alias covers extension *attributes*
 * only (`calledElementBinding`/`calledElementVersion` included) — a
 * `camunda:in`/`camunda:out` extension *element* on a call activity is not
 * recognized and stays a dropped-with-warning extension element, exactly
 * like any other foreign-namespace element.
 *
 * ## Import contract
 *
 * The transform never silently discards content it cannot represent. Its
 * return value is `{ ir, warnings }`, and content splits into two buckets:
 *
 * **Refused** (throws before any IR is produced, so there is no partial IR):
 * - an event definition of the wrong kind for its position: any definition
 *   on a plain start event (outside an event handler); anything other than
 *   error/escalation/message/signal/timer/conditional/compensation on an
 *   event handler's start; anything other than error/escalation/signal/
 *   compensation on an end event; anything other than escalation/signal/
 *   compensation on an intermediate throw (terminate, …); anything other
 *   than error/escalation/message/signal/timer/conditional on a boundary
 *   event (a cancel or terminate definition, …) →
 *   {@link UnsupportedEventDefinitionError};
 * - an event-layer construct shaped in a way this tool's surface cannot
 *   express: an event handler whose start-event or definition count is not
 *   exactly one, or which carries incoming/outgoing sequence flows; a
 *   non-interrupting error or compensation handler; a throw/emit whose
 *   definition resolves to no code; an error definition on an emit; a "none"
 *   emit; two `bpmn:Error` roots sharing a code but disagreeing about the
 *   declared message; a declared message on a code-less root; a message/
 *   signal definition with no ref, or whose resolved root has no non-empty
 *   name; a timer definition with zero or more than one time child, or an
 *   empty time body; a conditional definition with no condition child, an
 *   empty condition body, or an evaluation-narrowing `operaton:`/`camunda:`
 *   `variableName`/`variableEvents` attribute (the engine-side narrowing is
 *   semantics-bearing and this surface has no way to express it); a
 *   compensate definition (at any position) carrying an `activityRef` or
 *   `waitForCompletion="false"`; a compensation event sub-process hosted by
 *   the process or by another event sub-process rather than the plain
 *   sub-process it compensates; `isForCompensation="true"` on any mapped
 *   activity (task, sub-process, call activity); a boundary event with no
 *   `attachedToRef`, with an incoming sequence flow, with
 *   `cancelActivity="false"` on an error trigger, with a compensation
 *   trigger (pointing at the sub-process undo block instead), with an
 *   `operaton:inputOutput` mapping (Operaton forbids one on a boundary
 *   event), with an escalation trigger attached to anything other than a
 *   sub-process/call activity/user task, or whose `attachedToRef` does not
 *   name a mapped activity in the same container →
 *   {@link UnsupportedEventFeatureError};
 * - loop characteristics on a task, sub-process, or call activity
 *   (multi-instance / standard loop) → {@link UnsupportedLoopCharacteristicsError};
 * - collaborations, i.e. pools and message flows →
 *   {@link UnsupportedCollaborationError};
 * - unsupported flow-element kinds (`bpmn:intermediateCatchEvent`, a
 *   transaction, an ad-hoc sub-process, …) → {@link UnsupportedElementError};
 * - service tasks whose execution form the IR cannot represent (a bare task
 *   with no discriminator, or an external type with no topic) →
 *   {@link UnsupportedServiceTaskFormError};
 * - form fields whose type is not `string`/`long`/`boolean`/`date` →
 *   {@link UnsupportedFormFieldTypeError};
 * - call activities the engine could not execute as written: no
 *   `calledElement`, a `calledElementBinding="version"` with no
 *   `calledElementVersion`, an unrecognized `calledElementBinding` value
 *   (e.g. `versionTag`), or an `operaton:in`/`operaton:out` mapping using a
 *   shape the IR cannot represent (both `source` and `sourceExpression`, a
 *   `source`/`sourceExpression` with no `target`, `variables` set to
 *   anything but `"all"`, a `businessKey` combined with another attribute,
 *   more than one `businessKey`, or none of the recognized shapes) →
 *   {@link UnsupportedCallActivityError}.
 *
 * **Dropped with a warning** (no semantic loss; reported via `warnings`):
 * - Operaton/camunda extension attributes beyond the supported
 *   `assignee`/`formKey`/`class`/`expression`/`delegateExpression`/`type`/
 *   `topic`/`calledElementBinding`/`calledElementVersion`/
 *   `errorCodeVariable`/`errorMessageVariable`/`escalationCodeVariable` (e.g.
 *   `operaton:asyncBefore`) — one warning per attribute, attributed to the
 *   owning element by id;
 * - a binding attribute (`errorCodeVariable`/`errorMessageVariable`/
 *   `escalationCodeVariable`) set on a throw-side definition, where the
 *   engine ignores it;
 * - a genuine label (`name`) on an event handler, a typed end event, an
 *   intermediate throw, or a boundary event — none of these surfaces has a
 *   label slot;
 * - a `calledElementVersion` left dangling on a call activity — set while
 *   `calledElementBinding` is absent or not `"version"` — since Operaton
 *   ignores it in that case; one warning naming the attribute;
 * - engine-specific extension *elements* — one warning per element,
 *   attributed to the owning element by id and naming the concrete construct.
 *   Which elements can be pinned to an exact owner depends on how the parser
 *   sees them:
 *     - `operaton:inputOutput`, `operaton:executionListener`,
 *       `operaton:taskListener` are declared in the moddle extension, so they
 *       materialise as typed values and name their `$type` precisely;
 *     - `operaton:in`/`operaton:out` on a call activity are consumed into
 *       the IR's mappings (see above) rather than reported as a drop; on any
 *       other element they are just another declared extension element and
 *       are reported like the ones above;
 *     - extension elements in a foreign namespace (e.g. the deprecated
 *       `camunda:` alias) are kept by moddle as generic values and are also
 *       named against their owning element;
 *     - any *other* `operaton:` element the extension does not declare (e.g.
 *       `operaton:properties`) cannot be tied by moddle to a specific step, so
 *       it is reported once against the process id, naming the construct and
 *       its source line — the drop is still reported, only its owner
 *       attribution is coarser;
 * - lanes — one warning per lane;
 * - an unreferenced `bpmn:Error`/`bpmn:Escalation` root that nothing catches
 *   or throws and that carries no declared message (a declared,
 *   message-carrying error root imports into `errorMessages` instead — no
 *   warning, since the declaration is explicit authorial intent);
 * - an unreferenced `bpmn:Message`/`bpmn:Signal` root that no handler,
 *   throw, or emit uses — one warning per root (unlike the error/escalation
 *   case, a message/signal root carries no declared data of its own, so
 *   there is no "declared but unused" exception);
 * - `itemRef` on a referenced `bpmn:Message` root, or `structureRef` on a
 *   referenced `bpmn:Signal` root — data-structure metadata Operaton does
 *   not execute, warned once and named against the root.
 *
 * **Round-trips cleanly** (no warning, no refusal): the supported flow
 * elements and their `name`, `assignee`, `formKey`, service-task binding
 * (`class`, `expression`, `delegateExpression`, or `external` + `topic`),
 * script-task body, condition expressions, and default-flow references. An
 * embedded `bpmn:subProcess` round-trips too — its nested body is mapped
 * recursively, at any nesting depth. A `bpmn:callActivity` round-trips its
 * `calledElement`, `latest`/`deployment`/`version` binding, business key, and
 * in/out variable mappings, in document order. An event handler
 * (`triggeredByEvent="true"` sub-process) round-trips its caught error/
 * escalation/message/signal/timer/conditional/compensation trigger, code or
 * name, and catch bindings — the compensation trigger only when the handler
 * is hosted directly by the plain sub-process it compensates; a typed end
 * event (error/escalation/signal/compensation) or an intermediate throw
 * (escalation/signal/compensation) round-trips its thrown code or name (or,
 * for compensation, nothing — it is payload-less); declared error messages
 * round-trip through `errorMessages`. A `bpmn:boundaryEvent` round-trips its
 * `attachedToRef` (the host activity's id, in the same container), its
 * `cancelActivity` interrupting flag, and its caught error/escalation/
 * message/signal/timer/conditional trigger — never compensation, which stays
 * refused so a sub-process undo block remains the only way to express it.
 * Every use of one message/signal name — a handler, an `emit`, a `throw` — shares
 * one `bpmn:Message`/`bpmn:Signal` root; two roots that happen to share a
 * name collapse to that one name on import with no warning, since the name
 * is the engine-side identity and the roots carry no other data this tool
 * consumes (unlike a `bpmn:Error` root's declared message, which is
 * per-root data and refuses on disagreement instead).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BpmnModdle } from 'bpmn-moddle';

import type {
  BoundaryEvent,
  BpmnProcess,
  CalledElementBinding,
  CallActivity,
  CallVariableMapping,
  EndEvent,
  EventDefinition,
  ExclusiveGateway,
  FlowElement,
  FormField,
  FormFieldType,
  IntermediateThrowEvent,
  ParallelGateway,
  ScriptTask,
  SequenceFlow,
  ServiceTask,
  ServiceTaskBinding,
  StartEvent,
  SubProcess,
  UserTask,
} from './ir/types.js';

import {
  UnsupportedCallActivityError,
  UnsupportedCollaborationError,
  UnsupportedElementError,
  UnsupportedEventDefinitionError,
  UnsupportedEventFeatureError,
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
 *   an `operaton:inputOutput` block); also a binding attribute
 *   (`errorCodeVariable`/`errorMessageVariable`/`escalationCodeVariable`)
 *   set on the throw side, where it has no effect; also `itemRef`/
 *   `structureRef` on a referenced `bpmn:Message`/`bpmn:Signal` root —
 *   data-structure metadata Operaton does not execute.
 * - `lane` — a `bpmn:Lane`; the IR has no notion of lanes, so every step is
 *   imported into a single flat process.
 * - `label` — a genuine `name` on an event handler, a boundary event, a typed
 *   end event, or an intermediate throw — none of these surfaces
 *   (`on`/`throw`/`emit`) has a label slot, so the name is dropped rather than
 *   silently kept.
 * - `unreferencedRoot` — a `bpmn:Error`/`bpmn:Escalation`/`bpmn:Message`/
 *   `bpmn:Signal` root element that nothing in the process catches, throws,
 *   or emits, and — for a `bpmn:Error` root specifically — that carries no
 *   declared message (a declared, message-carrying error root imports into
 *   `errorMessages` instead and is never reported here; a message/signal
 *   root has no declared-data exception, since it carries no data of its
 *   own beyond the name).
 */
export type ImportWarningCategory =
  | 'extensionAttribute'
  | 'lane'
  | 'label'
  | 'unreferencedRoot';

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
 *
 * `errorCodeVariable`/`errorMessageVariable`/`escalationCodeVariable` are
 * consumed on the CATCH side only (an event handler's start event); on a
 * throw-side definition (a typed end event or an intermediate throw) the
 * engine ignores them, so {@link warnThrowSideBindingAttrs} reports that drop
 * explicitly — the generic sweep here cannot tell which side a definition
 * sits on and would otherwise stay silent for both. `errorMessage` lives on
 * a `bpmn:Error` root, read directly by {@link resolveErrorMessages}.
 */
const SUPPORTED_EXTENSION_ATTRS: ReadonlySet<string> = new Set([
  'assignee',
  'formKey',
  'class',
  'expression',
  'delegateExpression',
  'type',
  'topic',
  'calledElementBinding',
  'calledElementVersion',
  'errorCodeVariable',
  'errorMessageVariable',
  'escalationCodeVariable',
  'errorMessage',
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
  '(this tool keeps only the assignee, form, script, and service-task ' +
  'binding settings — Java class, expression, delegate expression, or ' +
  'external topic).';

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
 *   kind is encountered (e.g. a `bpmn:intermediateCatchEvent`,
 *   `bpmn:transaction`, or `bpmn:adHocSubProcess`).
 * @throws {UnsupportedServiceTaskFormError} when a `bpmn:ServiceTask`
 *   carries no execution form the IR can represent (a bare task with no
 *   discriminator, or an external type without a topic).
 * @throws {UnsupportedEventDefinitionError} when a plain start event carries
 *   any event definition; an event handler's start carries a definition
 *   that is not error/escalation/message/signal/timer/conditional/
 *   compensation; an end event carries a definition that is not error/
 *   escalation/signal/compensation; an intermediate throw carries a
 *   definition that is not escalation/signal/compensation; or a boundary
 *   event carries a definition that is not error/escalation/message/signal/
 *   timer/conditional — at any nesting depth.
 * @throws {UnsupportedEventFeatureError} when an event-layer construct is
 *   shaped in a way this tool's surface cannot express (see the module
 *   docstring's "Refused" list for the complete taxonomy).
 * @throws {UnsupportedLoopCharacteristicsError} when a task, sub-process, or
 *   call activity carries loop characteristics (multi-instance or standard loop).
 * @throws {UnsupportedCallActivityError} when a `bpmn:CallActivity` carries a
 *   shape the engine could not resolve (no `calledElement`, an unresolvable
 *   `calledElementBinding`, or a malformed `operaton:in`/`operaton:out`
 *   mapping).
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
  const mappedProcess = mapProcess(processes[0], warnings);

  // Root-element honesty pass: resolve the declared error messages off
  // every `bpmn:Error` root, refusing a disagreeing or unkeyable
  // declaration, then fold them into the process before checking for
  // unreferenced roots (a declared, message-carrying root is never
  // "unreferenced" — the declaration itself is authorial intent).
  // `bpmn:Message`/`bpmn:Signal` roots carry no declared data of their own
  // (see the module docstring) — every use of one name already read its
  // name straight off its resolved ref while mapping, so two roots sharing
  // a name simply collapse to that one name with nothing further to do
  // here; only the unreferenced-root sweep below needs the root list.
  const errorRoots = rootElements.filter((e) => e.$type === 'bpmn:Error');
  const escalationRoots = rootElements.filter(
    (e) => e.$type === 'bpmn:Escalation',
  );
  const messageRoots = rootElements.filter((e) => e.$type === 'bpmn:Message');
  const signalRoots = rootElements.filter((e) => e.$type === 'bpmn:Signal');
  const errorMessages = resolveErrorMessages(errorRoots);
  const ir: BpmnProcess = {
    ...mappedProcess,
    ...(errorMessages.length > 0 ? { errorMessages } : {}),
  };
  warnUnreferencedRoots(
    errorRoots,
    escalationRoots,
    messageRoots,
    signalRoots,
    ir,
    warnings,
  );

  // Extension elements moddle could not tie to a specific step (undeclared
  // `operaton:` types) surface only as document-level "unparsable content"
  // warnings. Emit one ImportWarning per such moddle warning, attributed to
  // the process — one drop reported per real drop, never fanned out.
  collectUnparsableResidualDrops(moddleWarnings, ir.id, warnings);
  return { ir, warnings };
}

/**
 * Read the code → message map off every `bpmn:Error` root element
 * (`operaton:errorMessage`/`camunda:errorMessage`), refusing loudly rather
 * than collapsing silently when two roots disagree: a code-less root
 * carrying a message has nothing to key it by, and two roots sharing a code
 * but declaring different messages cannot both be honored by the single
 * `errorMessages` entry the IR carries per code.
 *
 * @returns the declared `{ code, message }` entries, in root-element order,
 *   deduped by code (a repeated *agreeing* declaration contributes once).
 * @throws {UnsupportedEventFeatureError} for a message on a code-less root,
 *   or two roots sharing a code with disagreeing messages.
 */
function resolveErrorMessages(
  errorRoots: ModdleElement[],
): { code: string; message: string }[] {
  const seen = new Map<string, { message: string; rootId: string }>();
  const entries: { code: string; message: string }[] = [];

  for (const root of errorRoots) {
    const rootId = requireId(root);
    const message = readNamespacedAttr(root, 'errorMessage');
    if (message === undefined) continue;

    const code = readString(root, 'errorCode');
    if (code === undefined) {
      throw new UnsupportedEventFeatureError(
        rootId,
        'a declared error message needs a code to be keyed by, but this ' +
          'error root has no errorCode',
      );
    }

    const prior = seen.get(code);
    if (prior !== undefined && prior.message !== message) {
      throw new UnsupportedEventFeatureError(
        rootId,
        `error roots '${prior.rootId}' and '${rootId}' both declare code ` +
          `"${code}" but disagree about the thrown message`,
      );
    }
    if (prior === undefined) {
      seen.set(code, { message, rootId });
      entries.push({ code, message });
    }
  }

  return entries;
}

/**
 * Depth-first collect every distinct error/escalation code and message/
 * signal name caught, thrown, or emitted anywhere in the mapped IR (any
 * container, any nesting depth) — used only to detect a root element that
 * ended up unreferenced. A boundary event's trigger counts as a use exactly
 * like an event handler's start: it caught its trigger by attaching to a
 * host, not by traversing flow, but the root it names is no less referenced.
 * Deliberately kept separate from `ir-to-xml.ts`'s equivalent collector: the
 * two modules do not share private helpers, and the shapes they walk differ
 * slightly (this one starts from an already-mapped {@link BpmnProcess}).
 */
function collectReferencedCodes(process: BpmnProcess): {
  errorCodes: Set<string>;
  escalationCodes: Set<string>;
  messageNames: Set<string>;
  signalNames: Set<string>;
} {
  const errorCodes = new Set<string>();
  const escalationCodes = new Set<string>();
  const messageNames = new Set<string>();
  const signalNames = new Set<string>();

  const visit = (elements: FlowElement[]): void => {
    for (const el of elements) {
      const def: EventDefinition | undefined =
        el.kind === 'startEvent' ||
        el.kind === 'endEvent' ||
        el.kind === 'intermediateThrowEvent' ||
        el.kind === 'boundaryEvent'
          ? el.eventDefinition
          : undefined;
      if (def?.kind === 'error' && def.errorCode !== undefined) {
        errorCodes.add(def.errorCode);
      } else if (def?.kind === 'escalation' && def.escalationCode !== undefined) {
        escalationCodes.add(def.escalationCode);
      } else if (def?.kind === 'message') {
        messageNames.add(def.messageName);
      } else if (def?.kind === 'signal') {
        signalNames.add(def.signalName);
      }
      if (el.kind === 'subProcess') visit(el.flowElements);
    }
  };
  visit(process.flowElements);

  return { errorCodes, escalationCodes, messageNames, signalNames };
}

/**
 * Warn once per `bpmn:Error`/`bpmn:Escalation`/`bpmn:Message`/`bpmn:Signal`
 * root that nothing in the mapped IR catches, throws, or emits: the drop is
 * otherwise silent, since a root with no user never surfaces anywhere else.
 * A message-less error root is genuinely dead; a message-carrying one is
 * never unreferenced in effect, since {@link resolveErrorMessages} already
 * folded it into `ir.errorMessages` regardless of usage (the declaration is
 * explicit authorial intent) — so only the message-less case is checked
 * here for errors. Escalations have no message concept, so every
 * uncaught/unthrown escalation code warns. Message/signal roots have no
 * declared-data concept either (see the module docstring), so every root
 * whose name matches no usage in the IR warns, via {@link
 * warnUnreferencedNamedRoot}.
 */
function warnUnreferencedRoots(
  errorRoots: ModdleElement[],
  escalationRoots: ModdleElement[],
  messageRoots: ModdleElement[],
  signalRoots: ModdleElement[],
  ir: BpmnProcess,
  warnings: ImportWarning[],
): void {
  const { errorCodes, escalationCodes, messageNames, signalNames } =
    collectReferencedCodes(ir);
  const declaredCodes = new Set((ir.errorMessages ?? []).map((m) => m.code));

  for (const root of errorRoots) {
    const rootId = requireId(root);
    const code = readString(root, 'errorCode');
    if (code !== undefined && (errorCodes.has(code) || declaredCodes.has(code))) {
      continue;
    }
    warnings.push({
      elementId: rootId,
      category: 'unreferencedRoot',
      message:
        code !== undefined
          ? `The error "${code}" declared by root '${rootId}' is never ` +
            'caught or thrown and carries no message; it was not imported.'
          : `The error root '${rootId}' has no code, so it cannot be keyed ` +
            'or represented in the model; it was not imported.',
    });
  }

  for (const root of escalationRoots) {
    const rootId = requireId(root);
    const code = readString(root, 'escalationCode');
    if (code !== undefined && escalationCodes.has(code)) continue;
    warnings.push({
      elementId: rootId,
      category: 'unreferencedRoot',
      message:
        code !== undefined
          ? `The escalation "${code}" declared by root '${rootId}' is never ` +
            'caught or thrown; it was not imported.'
          : `The escalation root '${rootId}' has no code, so it cannot be ` +
            'keyed or represented in the model; it was not imported.',
    });
  }

  for (const root of messageRoots) {
    warnUnreferencedNamedRoot(root, messageNames, 'message', 'itemRef', warnings);
  }
  for (const root of signalRoots) {
    warnUnreferencedNamedRoot(root, signalNames, 'signal', 'structureRef', warnings);
  }
}

/**
 * Handle one `bpmn:Message`/`bpmn:Signal` root against the names actually
 * used in the mapped IR: a root whose `name` matches no handler/throw/emit
 * is warned as unreferenced (`category: 'unreferencedRoot'`); a referenced
 * root's `itemRef`/`structureRef` — the one other piece of data these root
 * kinds can carry — is data-structure metadata Operaton does not execute at
 * runtime, so it is warn-dropped instead (`category: 'extensionAttribute'`)
 * rather than silently discarded. `dataRefProperty` is `itemRef` for a
 * `bpmn:Message` root and `structureRef` for a `bpmn:Signal` root — moddle
 * resolves both as element references, so presence is checked via `.get()`.
 */
function warnUnreferencedNamedRoot(
  root: ModdleElement,
  referencedNames: ReadonlySet<string>,
  label: 'message' | 'signal',
  dataRefProperty: 'itemRef' | 'structureRef',
  warnings: ImportWarning[],
): void {
  const rootId = requireId(root);
  const name = readString(root, 'name');

  if (name !== undefined && referencedNames.has(name)) {
    const dataRef = root.get(dataRefProperty);
    if (dataRef !== undefined && dataRef !== null) {
      warnings.push({
        elementId: rootId,
        category: 'extensionAttribute',
        message:
          `The '${dataRefProperty}' setting on ${label} root '${rootId}' names a ` +
          "data structure Operaton does not execute; it was not imported.",
      });
    }
    return;
  }

  warnings.push({
    elementId: rootId,
    category: 'unreferencedRoot',
    message:
      name !== undefined
        ? `The ${label} "${name}" declared by root '${rootId}' is never used ` +
          'by an on/throw/emit; it was not imported.'
        : `The ${label} root '${rootId}' has no name, so it cannot be keyed ` +
          'or represented in the model; it was not imported.',
  });
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
 * The process-only concerns (id, name, lanes, process-level extension drops)
 * are handled here; the per-child mapping itself is delegated to
 * {@link mapContainer}, which recurses for an embedded sub-process.
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

  const { flowElements, sequenceFlows } = mapContainer(
    processEl,
    warnings,
    'process',
  );

  return {
    id,
    ...(name === undefined ? {} : { name }),
    isExecutable: true,
    flowElements,
    sequenceFlows,
  };
}

/**
 * Which kind of container currently hosts the element being mapped —
 * threaded through {@link mapContainer}/{@link mapContainerChildren} so
 * {@link mapEventSubProcessStart} can check a compensation handler's own
 * host without relying on moddle's `$parent` back-reference. BPMN requires a
 * compensation handler to sit directly inside the plain sub-process it
 * compensates, so `'process'` and `'eventSubProcess'` are both refused as a
 * compensation handler's host — only `'subProcess'` is accepted. Every other
 * event-handler kind (error, escalation, message, signal, timer,
 * conditional) ignores this parameter; it exists solely for that one
 * structural check.
 */
type ContainerHostKind = 'process' | 'subProcess' | 'eventSubProcess';

/**
 * Map the `flowElements` collection of a `bpmn:Process` or `bpmn:SubProcess`
 * moddle element into IR flow elements and sequence flows.
 *
 * Shared by {@link mapProcess} (the top-level container) and
 * {@link mapSubProcess} (a nested container) so the per-child switch — and
 * every refusal it can raise — applies uniformly at any nesting depth: an
 * event definition on a start event inside a sub-process is refused exactly
 * as one at the top level would be.
 *
 * @param warnings Accumulator for non-semantic drops. Mutated in place.
 * @param hostKind What kind of container `el` itself is — passed straight
 *   through to a nested `bpmn:SubProcess` child so it can identify its own
 *   host; see {@link ContainerHostKind}.
 */
function mapContainer(
  el: ModdleElement,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): { flowElements: FlowElement[]; sequenceFlows: SequenceFlow[] } {
  return mapContainerChildren(el, warnings, mapStartEvent, hostKind);
}

/**
 * The BPMN `Activity` subtypes this tool maps — the only kinds that carry
 * `isForCompensation` (declared on the abstract `bpmn:Activity`, not on
 * `bpmn:Event`/`bpmn:Gateway`/`bpmn:SequenceFlow`).
 */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ScriptTask',
  'bpmn:SubProcess',
  'bpmn:CallActivity',
]);

/**
 * Refuse `isForCompensation="true"` on any mapped activity (task,
 * sub-process, or call activity) — the boundary-event compensation-handler
 * pattern, where such an activity is excluded from normal flow and only
 * starts when a `bpmn:BoundaryEvent` compensation trigger on some other
 * activity fires it. `mapBoundaryEvent` does import a real
 * `bpmn:BoundaryEvent` for every other trigger, but a compensation trigger is
 * refused there too — BPMN attaches compensation through
 * `isForCompensation` and a `bpmn:association`, a different mechanism this
 * tool surfaces as a sub-process undo block instead — so an activity marked
 * this way still can never actually run; importing it as an ordinary step
 * would silently change its reachability. One shared guard, checked for
 * every child reaching {@link mapContainerChildren}'s switch, covers every
 * activity kind uniformly at any nesting depth.
 *
 * @throws {UnsupportedEventFeatureError} when `isForCompensation` is `true`.
 */
function refuseIfForCompensation(child: ModdleElement): void {
  if (!ACTIVITY_TYPES.has(child.$type)) return;
  if (child.get('isForCompensation') !== true) return;
  throw new UnsupportedEventFeatureError(
    child.id ?? '(unknown)',
    'isForCompensation="true" marks this activity as excluded from normal ' +
      'flow — the boundary-event compensation-handler pattern, which this ' +
      'tool cannot import; wrap the steps in their own sub-process and ' +
      'target it with "on compensation" instead',
  );
}

/**
 * Shared per-child dispatch for a container's `flowElements` collection.
 * `mapStart` lets {@link mapEventSubProcess} substitute the trigger-carrying
 * mapping for the single start event its body must carry ({@link
 * mapEventSubProcessStart}); every other child kind maps exactly as it would
 * in an ordinary container, so the refusals below apply uniformly at any
 * nesting depth and inside an event handler's body alike.
 *
 * A `bpmn:BoundaryEvent` child is mapped by {@link mapBoundaryEvent}, but its
 * `attachedToRef` is only checked for container membership and (for an
 * escalation trigger) host-kind eligibility in {@link
 * checkBoundaryEventHosts}, run once after this loop finishes — moddle may
 * present a boundary event before or after its host in `flowElements`, so
 * the full set of this container's mapped activity ids is only known once
 * every child has been visited.
 *
 * @param hostKind What kind of container `el` is; threaded to a nested
 *   `bpmn:SubProcess` child (see {@link ContainerHostKind}) so a
 *   compensation handler can check its own host.
 */
function mapContainerChildren(
  el: ModdleElement,
  warnings: ImportWarning[],
  mapStart: (startEl: ModdleElement) => StartEvent,
  hostKind: ContainerHostKind,
): { flowElements: FlowElement[]; sequenceFlows: SequenceFlow[] } {
  const flowElements: FlowElement[] = [];
  const sequenceFlows: SequenceFlow[] = [];

  const children = (el.get('flowElements') as ModdleElement[]) ?? [];
  for (const child of children) {
    refuseIfForCompensation(child);
    switch (child.$type) {
      case 'bpmn:StartEvent':
        flowElements.push(mapStart(child));
        break;
      case 'bpmn:EndEvent':
        flowElements.push(mapEndEvent(child, warnings));
        break;
      case 'bpmn:IntermediateThrowEvent':
        flowElements.push(mapIntermediateThrowEvent(child, warnings));
        break;
      case 'bpmn:BoundaryEvent':
        flowElements.push(mapBoundaryEvent(child, warnings));
        break;
      case 'bpmn:UserTask':
        flowElements.push(mapUserTask(child));
        break;
      case 'bpmn:ServiceTask':
        flowElements.push(mapServiceTask(child));
        break;
      case 'bpmn:ScriptTask':
        flowElements.push(mapScriptTask(child));
        break;
      case 'bpmn:ExclusiveGateway':
        flowElements.push(mapExclusiveGateway(child));
        break;
      case 'bpmn:ParallelGateway':
        flowElements.push(mapParallelGateway(child));
        break;
      case 'bpmn:SubProcess':
        flowElements.push(
          child.get('triggeredByEvent') === true
            ? mapEventSubProcess(child, warnings, hostKind)
            : mapSubProcess(child, warnings),
        );
        break;
      case 'bpmn:CallActivity':
        flowElements.push(mapCallActivity(child, warnings));
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

  checkBoundaryEventHosts(flowElements, sequenceFlows);
  return { flowElements, sequenceFlows };
}

/**
 * The `FlowElement` kinds a `bpmn:BoundaryEvent` may legally attach to — the
 * activity subtypes {@link mapContainerChildren} maps into `flowElements`
 * (mirrors {@link ACTIVITY_TYPES}, at the IR level rather than the moddle
 * `$type` level).
 */
const BOUNDARY_HOST_KINDS: ReadonlySet<FlowElement['kind']> = new Set([
  'userTask',
  'serviceTask',
  'scriptTask',
  'subProcess',
  'callActivity',
]);

/**
 * Of {@link BOUNDARY_HOST_KINDS}, the subset an escalation boundary may
 * attach to, per Operaton's own `BpmnParse.parseBoundaryEvents`: a service or
 * script task is excluded.
 */
const ESCALATION_BOUNDARY_HOST_KINDS: ReadonlySet<FlowElement['kind']> =
  new Set(['subProcess', 'callActivity', 'userTask']);

/**
 * Validate every `boundaryEvent` in `flowElements` against the other
 * elements mapped in this same container, once the whole child loop in
 * {@link mapContainerChildren} has finished. This has to be a separate pass
 * rather than an inline check in {@link mapBoundaryEvent}: moddle presents a
 * container's children in document order, and a boundary event's host may be
 * written before or after it in the XML, so the full set of this
 * container's mapped activity ids is only known once every child has been
 * visited. A nested sub-process runs its own instance of this check over its
 * own `flowElements`, so a host in a different (nesting) container is never
 * mistaken for one in this container.
 *
 * The same pass also catches an inbound sequence flow written only as
 * `sequenceFlow/@targetRef`. {@link mapBoundaryEvent} sees a boundary event's
 * `incoming` list, which moddle fills from `<bpmn:incoming>` children alone —
 * those are optional in BPMN, and Operaton reads the flow's `targetRef`
 * regardless — so a file that omits them would otherwise map an inbound edge
 * onto a node that can never carry one.
 *
 * @throws {UnsupportedEventFeatureError} when a boundary event's
 *   `attachedToRef` does not name a mapped activity in this same container,
 *   an escalation boundary attaches to an activity kind Operaton does not
 *   allow (a service or script task), or a sequence flow in this container
 *   targets a boundary event.
 */
function checkBoundaryEventHosts(
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
): void {
  const activityById = new Map<string, FlowElement>();
  for (const el of flowElements) {
    // An event sub-process is written as a bare `on <trigger> { … }` and has
    // no authored id or name, so a boundary event attached to one could only
    // be printed against a synthesized id that names nothing in the source —
    // a mangle. Left out of the host map, it falls into the refusal below.
    if (
      BOUNDARY_HOST_KINDS.has(el.kind) &&
      !(el.kind === 'subProcess' && el.triggeredByEvent === true)
    ) {
      activityById.set(el.id, el);
    }
  }

  const boundaryIds = new Set(
    flowElements.filter((el) => el.kind === 'boundaryEvent').map((el) => el.id),
  );
  for (const sf of sequenceFlows) {
    if (!boundaryIds.has(sf.targetRef)) continue;
    throw new UnsupportedEventFeatureError(
      sf.targetRef,
      'a boundary event carries an incoming sequence flow — it is ' +
        'triggered by its own event, not by an incoming flow',
    );
  }

  for (const el of flowElements) {
    if (el.kind !== 'boundaryEvent') continue;

    const host = activityById.get(el.attachedToRef);
    if (host === undefined) {
      throw new UnsupportedEventFeatureError(
        el.id,
        `attachedToRef "${el.attachedToRef}" does not name a user task, ` +
          'service task, script task, sub-process, or call activity that is ' +
          'itself a flow element of this same container — a boundary event ' +
          'can only attach to an activity alongside it',
      );
    }
    if (
      el.eventDefinition.kind === 'escalation' &&
      !ESCALATION_BOUNDARY_HOST_KINDS.has(host.kind)
    ) {
      throw new UnsupportedEventFeatureError(
        el.id,
        `an escalation boundary event attaches to "${el.attachedToRef}", a ` +
          `${host.kind} — Operaton only allows an escalation boundary on a ` +
          'sub-process, a call activity, or a user task',
      );
    }
  }
}

/**
 * Map a `bpmn:SubProcess` moddle element into a recursive IR {@link
 * SubProcess}.
 *
 * Only the embedded (plain) sub-process reaches this function — a
 * `triggeredByEvent="true"` sub-process (an event handler) is dispatched to
 * {@link mapEventSubProcess} instead, by {@link mapContainerChildren}, before
 * this function is ever called. `bpmn:Transaction` and
 * `bpmn:AdHocSubProcess` carry their own moddle `$type`s and never reach
 * this function either; they hit the default refusal arm in {@link
 * mapContainerChildren}.
 *
 * The nested body is mapped by recursing into {@link mapContainer}, so a
 * sub-process nested inside a sub-process imports just as well as one
 * nested directly in the process.
 */
function mapSubProcess(
  el: ModdleElement,
  warnings: ImportWarning[],
): SubProcess {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  // A sub-process may own its own lane set, just like a process.
  collectLaneDrops(el, id, warnings);
  const name = readDerivableName(el, id);
  const { flowElements, sequenceFlows } = mapContainer(el, warnings, 'subProcess');

  return {
    kind: 'subProcess',
    id,
    ...(name === undefined ? {} : { name }),
    flowElements,
    sequenceFlows,
  };
}

/**
 * Map a `bpmn:SubProcess` with `triggeredByEvent="true"` into an IR event
 * handler — the import counterpart of an `on` handler. Its single start
 * event carries the caught trigger; anything else about its shape is
 * refused rather than narrowed: a start-event count other than one, a start
 * with zero or multiple definitions, or the sub-process itself carrying
 * incoming/outgoing sequence flows (it is triggered by its caught event,
 * never wired into the parent flow — that would be invalid BPMN this tool
 * cannot round-trip) all raise {@link UnsupportedEventFeatureError}.
 *
 * The body — including the trigger start's own definition-kind and
 * definition-count checks — is mapped by {@link mapContainerChildren} with
 * {@link mapEventSubProcessStart} substituted for the ordinary
 * {@link mapStartEvent}, so nesting (an event handler inside a plain
 * sub-process, or inside another handler) composes for free. `hostKind`
 * (the container that hosts `el`, threaded in from the caller) is passed
 * down to {@link mapEventSubProcessStart}: a compensation trigger is the one
 * kind whose validity depends on where the handler itself sits, so the
 * check lives there rather than here.
 */
function mapEventSubProcess(
  el: ModdleElement,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): SubProcess {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);

  const incoming = (el.get('incoming') as ModdleElement[] | undefined) ?? [];
  const outgoing = (el.get('outgoing') as ModdleElement[] | undefined) ?? [];
  if (incoming.length > 0 || outgoing.length > 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'an event handler carries incoming or outgoing sequence flows — it ' +
        'is triggered by its caught event, not wired into the surrounding flow',
    );
  }

  collectLaneDrops(el, id, warnings);
  warnGenuineLabel(el, id, 'an event handler', warnings);

  const children = (el.get('flowElements') as ModdleElement[]) ?? [];
  const startEvents = children.filter((c) => c.$type === 'bpmn:StartEvent');
  if (startEvents.length !== 1) {
    throw new UnsupportedEventFeatureError(
      id,
      'an event handler must have exactly one start event carrying its ' +
        `trigger (found ${startEvents.length})`,
    );
  }

  const { flowElements, sequenceFlows } = mapContainerChildren(
    el,
    warnings,
    (startEl) => mapEventSubProcessStart(startEl, id, warnings, hostKind),
    'eventSubProcess',
  );

  return {
    kind: 'subProcess',
    id,
    triggeredByEvent: true,
    flowElements,
    sequenceFlows,
  };
}

/**
 * Map the single trigger-carrying start event of an event handler. Unlike
 * {@link mapStartEvent} (which refuses every definition), this start is
 * expected to carry exactly one error, escalation, message, signal, timer,
 * conditional, or compensation definition; anything else refuses (see
 * {@link readCatchEventDefinition}). `isInterrupting="false"` is valid for
 * every kind except error and compensation — BPMN requires both an error and
 * a compensation trigger to interrupt their scope, so either combination
 * refuses too.
 *
 * A compensation trigger carries one further, host-specific constraint: BPMN
 * requires a compensation handler to sit directly inside the plain
 * sub-process it compensates, never in the process itself or in another
 * event sub-process — so `hostKind` (threaded down from {@link
 * mapEventSubProcess}) is checked only for that one definition kind.
 */
function mapEventSubProcessStart(
  startEl: ModdleElement,
  handlerId: string,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): StartEvent {
  const id = requireId(startEl);
  const defs =
    (startEl.get('eventDefinitions') as ModdleElement[] | undefined) ?? [];
  if (defs.length !== 1) {
    throw new UnsupportedEventFeatureError(
      handlerId,
      'its start event must carry exactly one trigger definition ' +
        `(found ${defs.length})`,
    );
  }

  const eventDefinition = readCatchEventDefinition(
    defs[0],
    id,
    warnings,
    'start',
  );

  if (eventDefinition.kind === 'compensation' && hostKind !== 'subProcess') {
    throw new UnsupportedEventFeatureError(
      handlerId,
      'a compensation handler must be hosted directly by the plain ' +
        `sub-process it compensates, not by ${
          hostKind === 'process' ? 'the process' : 'another event sub-process'
        } — move it into the sub-process it compensates`,
    );
  }

  const isInterrupting =
    startEl.get('isInterrupting') === false ? false : undefined;
  if (
    isInterrupting === false &&
    (eventDefinition.kind === 'error' || eventDefinition.kind === 'compensation')
  ) {
    throw new UnsupportedEventFeatureError(
      handlerId,
      eventDefinition.kind === 'error'
        ? 'an error handler cannot be non-interrupting (isInterrupting="false") ' +
          '— BPMN requires an error trigger to interrupt its scope'
        : 'a compensation handler cannot be non-interrupting ' +
          '(isInterrupting="false") — BPMN requires a compensation trigger ' +
          'to interrupt its scope',
    );
  }

  return {
    kind: 'startEvent',
    id,
    eventDefinition,
    ...(isInterrupting === false ? { isInterrupting: false } : {}),
  };
}

/**
 * Map a `bpmn:BoundaryEvent` moddle element into the IR — a catch that
 * attaches to an activity in the same container rather than sitting in the
 * main sequence-flow chain. Six of the seven catch triggers this tool
 * imports are valid here (error, escalation, message, signal, timer,
 * conditional); the import contract is refuse-or-map, never mangle, so every
 * shape the engine would reject or that this tool's surface cannot express
 * is refused before any IR is produced, rather than narrowed:
 *
 * - a missing `attachedToRef` (BPMN requires every boundary event to attach
 *   to a host);
 * - an incoming sequence flow (a boundary event is triggered by its own
 *   event, never wired into the flow the way a plain node is);
 * - an `operaton:inputOutput` mapping (Operaton's own parser forbids
 *   input/output variable mappings on a boundary event);
 * - a `bpmn:CompensateEventDefinition` (BPMN attaches compensation through
 *   `isForCompensation` and a `bpmn:association` on the activity being
 *   compensated instead — a different mechanism this tool surfaces as a
 *   sub-process undo block, never as a boundary event; see {@link
 *   refuseIfForCompensation});
 * - any other definition kind this tool's catch surface does not support
 *   (a cancel or terminate definition, …), via {@link
 *   readCatchEventDefinition}'s own final refusal;
 * - `cancelActivity="false"` together with an error trigger (BPMN gives an
 *   error boundary no non-interrupting form).
 *
 * `attachedToRef` itself resolves to the actual moddle host element (BPMN
 * declares it `isReference: true`, so `bpmn-moddle` resolves it regardless
 * of where the host is written relative to this boundary event in the XML);
 * only its `id` is kept, to hold the IR to plain strings. Whether that host
 * is actually a mapped activity *in this same container* — and, for an
 * escalation trigger, an eligible host kind — is checked once for every
 * boundary event in the container, by {@link checkBoundaryEventHosts}, after
 * {@link mapContainerChildren}'s child loop has finished.
 *
 * @throws {UnsupportedEventFeatureError} for a missing `attachedToRef`, an
 *   incoming sequence flow, an `operaton:inputOutput` mapping, a
 *   compensation trigger, a trigger-definition count other than one, or
 *   `cancelActivity="false"` combined with an error trigger.
 * @throws {UnsupportedEventDefinitionError} when the trigger definition is
 *   none of error, escalation, message, signal, timer, or conditional.
 */
function mapBoundaryEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
): BoundaryEvent {
  const id = requireId(el);

  const hostEl = el.get('attachedToRef') as ModdleElement | undefined | null;
  if (hostEl === undefined || hostEl === null) {
    throw new UnsupportedEventFeatureError(
      id,
      'a boundary event has no attachedToRef — BPMN requires every ' +
        'boundary event to attach to an activity in its own container',
    );
  }

  const incoming = (el.get('incoming') as ModdleElement[] | undefined) ?? [];
  if (incoming.length > 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'a boundary event carries an incoming sequence flow — it is ' +
        'triggered by its own event, not by an incoming flow',
    );
  }

  refuseBoundaryInputOutput(el, id);

  const defs =
    (el.get('eventDefinitions') as ModdleElement[] | undefined) ?? [];
  if (defs.length !== 1) {
    throw new UnsupportedEventFeatureError(
      id,
      `a boundary event must carry exactly one trigger definition (found ${defs.length})`,
    );
  }
  const [defEl] = defs;

  if (defEl.$type === 'bpmn:CompensateEventDefinition') {
    throw new UnsupportedEventFeatureError(
      id,
      'a compensation boundary event is not imported — BPMN attaches ' +
        'compensation through isForCompensation and a bpmn:association on ' +
        'the activity being compensated, not a boundary event; wrap the ' +
        'steps in their own sub-process and target it with "on compensation" instead',
    );
  }

  const eventDefinition = readCatchEventDefinition(
    defEl,
    id,
    warnings,
    'boundary',
  );
  warnGenuineLabel(el, id, 'a boundary event', warnings);

  const cancelActivity = el.get('cancelActivity') === false ? false : undefined;
  if (cancelActivity === false && eventDefinition.kind === 'error') {
    throw new UnsupportedEventFeatureError(
      id,
      'an error boundary event cannot be non-interrupting ' +
        '(cancelActivity="false") — BPMN gives an error boundary no ' +
        'non-interrupting form',
    );
  }

  return {
    kind: 'boundaryEvent',
    id,
    attachedToRef: requireId(hostEl),
    eventDefinition,
    ...(cancelActivity === false ? { cancelActivity: false } : {}),
  };
}

/**
 * Refuse an `operaton:inputOutput` extension element on a boundary event.
 * Operaton's own parser accepts `operaton:inputOutput` on many activities
 * but rejects it on a `bpmn:BoundaryEvent` — a boundary event has no
 * execution scope of its own to bind variables into — so importing it as an
 * ordinary dropped extension (a warning, {@link collectExtensionDrops}'s
 * generic treatment for every other element) would understate an engine
 * rejection this tool can already see at parse time.
 *
 * @throws {UnsupportedEventFeatureError} when an `operaton:inputOutput`
 *   extension element is present.
 */
function refuseBoundaryInputOutput(el: ModdleElement, id: string): void {
  const extensionElements = el.get('extensionElements') as
    ModdleElement | undefined;
  if (extensionElements === undefined) return;
  const values =
    (extensionElements.get('values') as ModdleElement[] | undefined) ?? [];
  if (values.some((value) => value.$type === 'operaton:InputOutput')) {
    throw new UnsupportedEventFeatureError(
      id,
      'a boundary event carries an operaton:inputOutput mapping — Operaton ' +
        'forbids input/output variable mappings on a boundary event',
    );
  }
}

/**
 * Resolve one event definition's shape on the CATCH side — an event
 * handler's trigger, or a boundary event's (see {@link mapBoundaryEvent},
 * which reuses this verbatim: a boundary event catches exactly what an event
 * handler's start catches). An error/escalation definition without a ref, or
 * whose resolved root carries no code, means catch-all — the missing code
 * is exactly what makes the handler match any error/escalation. A message/
 * signal/timer/conditional trigger has no catch-all form (the surface
 * always requires the identity that makes it a real subscription), so each
 * refuses its own way when that identity cannot be resolved — see {@link
 * resolveNamedRootRef}, {@link readTimerDefinition}, and {@link
 * readConditionalDefinition}. Reads the binding attributes
 * (`errorCodeVariable`/`errorMessageVariable`/`escalationCodeVariable`, dual
 * `operaton:`/`camunda:` namespace via {@link readNamespacedAttr}) and runs
 * {@link collectExtensionDrops} on the definition itself so an unrelated
 * `operaton:` attribute there is never silently lost.
 *
 * @param position Which surface `defEl` sits on — `'start'` for an event
 *   handler's start event, `'boundary'` for a boundary event — threaded only
 *   into the final refusal below, so its message names the surface that
 *   actually carried the unsupported definition instead of always claiming
 *   a start event.
 * @throws {UnsupportedEventDefinitionError} when the definition is none of
 *   error, escalation, message, signal, timer, conditional, or compensation
 *   (e.g. a terminate definition).
 * @throws {UnsupportedEventFeatureError} when a message/signal definition
 *   has no ref or resolves to a nameless root, a timer definition has zero
 *   or more than one time child or an empty body, a conditional definition
 *   has no condition, an empty condition body, or an evaluation-narrowing
 *   `variableName`/`variableEvents` attribute, or a compensation definition
 *   carries an `activityRef` or `waitForCompletion="false"`.
 */
function readCatchEventDefinition(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
  position: 'start' | 'boundary',
): EventDefinition {
  collectExtensionDrops(defEl, ownerId, warnings);

  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    const ref = defEl.get('errorRef') as ModdleElement | undefined;
    const errorCode =
      ref !== undefined && ref !== null ? readString(ref, 'errorCode') : undefined;
    const codeVariable = readNamespacedAttr(defEl, 'errorCodeVariable');
    const messageVariable = readNamespacedAttr(defEl, 'errorMessageVariable');
    return {
      kind: 'error',
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(codeVariable === undefined ? {} : { codeVariable }),
      ...(messageVariable === undefined ? {} : { messageVariable }),
    };
  }

  if (defEl.$type === 'bpmn:EscalationEventDefinition') {
    const ref = defEl.get('escalationRef') as ModdleElement | undefined;
    const escalationCode =
      ref !== undefined && ref !== null
        ? readString(ref, 'escalationCode')
        : undefined;
    const codeVariable = readNamespacedAttr(defEl, 'escalationCodeVariable');
    return {
      kind: 'escalation',
      ...(escalationCode === undefined ? {} : { escalationCode }),
      ...(codeVariable === undefined ? {} : { codeVariable }),
    };
  }

  if (defEl.$type === 'bpmn:MessageEventDefinition') {
    return {
      kind: 'message',
      messageName: resolveNamedRootRef(defEl, 'messageRef', ownerId, 'message'),
    };
  }

  if (defEl.$type === 'bpmn:SignalEventDefinition') {
    return {
      kind: 'signal',
      signalName: resolveNamedRootRef(defEl, 'signalRef', ownerId, 'signal'),
    };
  }

  if (defEl.$type === 'bpmn:TimerEventDefinition') {
    return { kind: 'timer', ...readTimerDefinition(defEl, ownerId) };
  }

  if (defEl.$type === 'bpmn:ConditionalEventDefinition') {
    return { kind: 'conditional', condition: readConditionalDefinition(defEl, ownerId) };
  }

  if (defEl.$type === 'bpmn:CompensateEventDefinition') {
    refuseCompensateActivityRef(defEl, ownerId);
    refuseCompensateWaitForCompletionFalse(defEl, ownerId);
    return { kind: 'compensation' };
  }

  throw new UnsupportedEventDefinitionError(ownerId, position, defEl.$type);
}

/**
 * Refuse an `activityRef` on a `bpmn:CompensateEventDefinition`, at any
 * position (a handler's catch, a typed end throw, or an emit). BPMN lets a
 * compensate definition target one specific activity by reference; this
 * tool's `on`/`throw`/`emit compensation` surface always addresses the
 * enclosing scope instead (see the `compensation` variant of {@link
 * EventDefinition}), so a targeted reference cannot be represented.
 *
 * @throws {UnsupportedEventFeatureError} when `activityRef` is set.
 */
function refuseCompensateActivityRef(defEl: ModdleElement, ownerId: string): void {
  const activityRef = defEl.get('activityRef') as ModdleElement | undefined;
  if (activityRef === undefined || activityRef === null) return;
  throw new UnsupportedEventFeatureError(
    ownerId,
    'a compensation definition targets one activity by reference ' +
      `(activityRef="${activityRef.id ?? '(unknown)'}") — this tool always ` +
      'addresses the enclosing scope and cannot target a single activity',
  );
}

/**
 * Refuse `waitForCompletion="false"` on a `bpmn:CompensateEventDefinition`,
 * at any position. The moddle schema defaults the attribute to `true` (the
 * only value Operaton executes) and reads an absent attribute back as
 * `true`, so a bare `<bpmn:compensateEventDefinition/>` and an explicit
 * `waitForCompletion="true"` both import identically (see the
 * `compensation` variant of {@link EventDefinition}); only an explicit
 * `false` differs from what this tool imports, so it is refused rather than
 * silently narrowed to the default.
 *
 * @throws {UnsupportedEventFeatureError} when `waitForCompletion` is `false`.
 */
function refuseCompensateWaitForCompletionFalse(
  defEl: ModdleElement,
  ownerId: string,
): void {
  if (defEl.get('waitForCompletion') !== false) return;
  throw new UnsupportedEventFeatureError(
    ownerId,
    'a compensation definition sets waitForCompletion="false" — this tool ' +
      'only imports the default (wait for the compensation to complete) behavior',
  );
}

/**
 * Resolve a message/signal event definition's name off its resolved root
 * (`messageRef`/`signalRef`) — the value the DSL surface correlates
 * (message) or broadcasts (signal) on. A definition with no ref, or whose
 * resolved root carries no (or an empty) `name`, is refused: neither side of
 * this surface has anything to catch, throw, or emit by.
 *
 * @throws {UnsupportedEventFeatureError} when no ref resolves to a root with
 *   a non-empty name.
 */
function resolveNamedRootRef(
  defEl: ModdleElement,
  refProperty: 'messageRef' | 'signalRef',
  ownerId: string,
  label: 'message' | 'signal',
): string {
  const ref = defEl.get(refProperty) as ModdleElement | undefined;
  const name = ref !== undefined && ref !== null ? readString(ref, 'name') : undefined;
  if (name === undefined) {
    const rootKind = label === 'message' ? 'bpmn:Message' : 'bpmn:Signal';
    throw new UnsupportedEventFeatureError(
      ownerId,
      `a ${label} definition must reference a ${rootKind} root with a non-empty name`,
    );
  }
  return name;
}

/**
 * The `bpmn:TimerEventDefinition` child mapped to each IR `timerKind` — the
 * inverse of `ir-to-xml.ts`'s `TIMER_KIND_TO_CHILD`.
 */
const TIMER_CHILD_TO_KIND: Readonly<
  Record<'timeDuration' | 'timeDate' | 'timeCycle', 'duration' | 'date' | 'cycle'>
> = {
  timeDuration: 'duration',
  timeDate: 'date',
  timeCycle: 'cycle',
};

/**
 * Resolve a `bpmn:TimerEventDefinition`'s single time child into the IR's
 * `timerKind`/`expression`. Exactly one of `timeDuration`/`timeDate`/
 * `timeCycle` must be present, each a `bpmn:FormalExpression` whose `body`
 * (the `conditionExpression` read precedent) carries the verbatim time
 * text — zero or more than one child, or an empty body, refuses: there is
 * no sensible single deadline to import.
 *
 * @throws {UnsupportedEventFeatureError} when the definition carries zero
 *   or more than one time child, or the one present child has an empty body.
 */
function readTimerDefinition(
  defEl: ModdleElement,
  ownerId: string,
): { timerKind: 'duration' | 'date' | 'cycle'; expression: string } {
  const childNames = Object.keys(TIMER_CHILD_TO_KIND) as (keyof typeof TIMER_CHILD_TO_KIND)[];
  const present = childNames.filter((childName) => {
    const child = defEl.get(childName) as ModdleElement | undefined;
    return child !== undefined && child !== null;
  });

  if (present.length !== 1) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a timer definition must carry exactly one of timeDuration/timeDate/' +
        `timeCycle (found ${present.length})`,
    );
  }

  const [childName] = present;
  const expressionEl = defEl.get(childName) as ModdleElement;
  const expression = readString(expressionEl, 'body');
  if (expression === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      `a timer definition's ${childName} has an empty body`,
    );
  }
  return { timerKind: TIMER_CHILD_TO_KIND[childName], expression };
}

/**
 * The deferred conditional-narrowing attribute local names — `operaton:`/
 * `camunda:` `variableName`/`variableEvents`. Neither is declared by the
 * moddle extension, so both surface only in `$attrs`, dual-namespace, on
 * the `bpmn:ConditionalEventDefinition` element itself.
 */
const CONDITIONAL_NARROWING_ATTRS: readonly string[] = [
  'variableName',
  'variableEvents',
];

/**
 * Resolve a `bpmn:ConditionalEventDefinition`'s `condition` child into the
 * IR's raw `${…}` body (the `conditionExpression` read precedent), refusing
 * a missing condition or an empty body. Also refuses an evaluation-narrowing
 * `variableName`/`variableEvents` attribute (either `operaton:` or the
 * deprecated `camunda:` prefix): narrowing changes *when* the condition is
 * checked, which this surface has no way to express, so dropping it would
 * silently alter runtime behavior — it is refused rather than warn-dropped.
 *
 * @throws {UnsupportedEventFeatureError} when a narrowing attribute is
 *   present, the condition child is absent, or its body is empty.
 */
function readConditionalDefinition(defEl: ModdleElement, ownerId: string): string {
  const attrs = defEl.$attrs ?? {};
  for (const localName of CONDITIONAL_NARROWING_ATTRS) {
    for (const prefix of ['operaton', 'camunda']) {
      if (attrs[`${prefix}:${localName}`] !== undefined) {
        throw new UnsupportedEventFeatureError(
          ownerId,
          `a conditional definition's ${prefix}:${localName} narrows when the ` +
            'condition is (re-)evaluated, which this tool cannot represent',
        );
      }
    }
  }

  const conditionEl = defEl.get('condition') as ModdleElement | undefined;
  const condition =
    conditionEl !== undefined && conditionEl !== null
      ? readString(conditionEl, 'body')
      : undefined;
  if (condition === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a conditional definition must carry a condition with a non-empty body',
    );
  }
  return condition;
}

/**
 * Resolve one event definition's shape on the THROW side (a typed end event,
 * or an escalation/signal/compensation intermediate throw): an error/
 * escalation code, or a signal name, must resolve to a non-empty string — a
 * throw with no identity is not something the `throw`/`emit` surface can
 * express. Compensation carries no identity at all (it is payload-less by
 * construction), so it has no such check — only its shared `activityRef`/
 * `waitForCompletion` refusals apply, exactly as on the catch side (see
 * {@link refuseCompensateActivityRef}, {@link
 * refuseCompensateWaitForCompletionFalse}). Binding attributes have no
 * effect on a throw (the engine ignores them there), so their presence is
 * warned explicitly via {@link warnThrowSideBindingAttrs} rather than
 * silently kept, since {@link SUPPORTED_EXTENSION_ATTRS} declares them
 * supported for the catch side and would otherwise silence this drop. Also
 * runs {@link collectExtensionDrops} on the definition itself, exactly as
 * the catch side does.
 *
 * @throws {UnsupportedEventFeatureError} when the resolved code/name is
 *   empty, or a compensation definition carries an `activityRef` or
 *   `waitForCompletion="false"`.
 */
function readThrowEventDefinition(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): EventDefinition {
  collectExtensionDrops(defEl, ownerId, warnings);
  warnThrowSideBindingAttrs(defEl, ownerId, warnings);

  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    const ref = defEl.get('errorRef') as ModdleElement | undefined;
    const errorCode =
      ref !== undefined && ref !== null ? readString(ref, 'errorCode') : undefined;
    if (errorCode === undefined) {
      throw new UnsupportedEventFeatureError(
        ownerId,
        'a throw must resolve to a non-empty code',
      );
    }
    return { kind: 'error', errorCode };
  }

  if (defEl.$type === 'bpmn:SignalEventDefinition') {
    return {
      kind: 'signal',
      signalName: resolveNamedRootRef(defEl, 'signalRef', ownerId, 'signal'),
    };
  }

  if (defEl.$type === 'bpmn:CompensateEventDefinition') {
    refuseCompensateActivityRef(defEl, ownerId);
    refuseCompensateWaitForCompletionFalse(defEl, ownerId);
    return { kind: 'compensation' };
  }

  const ref = defEl.get('escalationRef') as ModdleElement | undefined;
  const escalationCode =
    ref !== undefined && ref !== null
      ? readString(ref, 'escalationCode')
      : undefined;
  if (escalationCode === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a throw must resolve to a non-empty code',
    );
  }
  return { kind: 'escalation', escalationCode };
}

/**
 * Warn (`category: 'extensionAttribute'`) when a binding attribute
 * (`errorCodeVariable`/`errorMessageVariable` on an error definition,
 * `escalationCodeVariable` on an escalation definition) is set on a
 * THROW-side definition, where the engine ignores it. Declaring these names
 * in {@link SUPPORTED_EXTENSION_ATTRS} (so the catch side reads them
 * silently) would otherwise make the generic sweep in
 * {@link collectExtensionDrops} silent here too — it cannot tell which side
 * a definition sits on — so this explicit check is the honesty fix. A signal
 * throw carries no binding attribute at all, so it checks none.
 */
function warnThrowSideBindingAttrs(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  const names =
    defEl.$type === 'bpmn:ErrorEventDefinition'
      ? ['errorCodeVariable', 'errorMessageVariable']
      : defEl.$type === 'bpmn:EscalationEventDefinition'
        ? ['escalationCodeVariable']
        : [];
  for (const name of names) {
    if (readNamespacedAttr(defEl, name) === undefined) continue;
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `The '${name}' setting on '${ownerId}' only takes effect on a ` +
        "catch (an 'on' handler); it has no effect on a throw and was not imported.",
    });
  }
}

/**
 * Warn-drop a genuine label: the `on`/`throw`/`emit` surfaces have no label
 * slot, so a `name` that survives {@link readDerivableName} on an
 * event handler, a boundary event, a typed end event, or an intermediate
 * throw is dropped with a warning rather than silently discarded.
 */
function warnGenuineLabel(
  el: ModdleElement,
  id: string,
  surface: string,
  warnings: ImportWarning[],
): void {
  const name = readDerivableName(el, id);
  if (name === undefined) return;
  warnings.push({
    elementId: id,
    category: 'label',
    message:
      `The label '${name}' on '${id}' was not imported: ${surface} has no ` +
      "label in this tool's surface.",
  });
}

/**
 * Map a `bpmn:CallActivity` moddle element into the IR. A call activity is a
 * leaf (unlike {@link mapSubProcess}): it invokes another process by id
 * rather than nesting a body.
 *
 * The import contract is refuse-or-map, never mangle: a shape the IR can
 * represent unambiguously is mapped; anything else — a missing
 * `calledElement`, an unresolvable `calledElementBinding`, or a malformed
 * `operaton:in`/`operaton:out` mapping — throws {@link
 * UnsupportedCallActivityError} rather than being narrowed or silently
 * dropped.
 */
function mapCallActivity(
  el: ModdleElement,
  warnings: ImportWarning[],
): CallActivity {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);

  const calledElement = readString(el, 'calledElement');
  if (calledElement === undefined) {
    throw new UnsupportedCallActivityError(
      id,
      'it has no calledElement — there is nothing for the engine to invoke',
    );
  }

  const binding = readCalledElementBinding(el, id, warnings);
  const { businessKey, inMappings, outMappings } = readCallMappings(el, id);

  return {
    kind: 'callActivity',
    id,
    ...(name === undefined ? {} : { name }),
    calledElement,
    ...(binding === undefined ? {} : { binding }),
    ...(businessKey === undefined ? {} : { businessKey }),
    ...(inMappings === undefined ? {} : { inMappings }),
    ...(outMappings === undefined ? {} : { outMappings }),
  };
}

/**
 * Resolve a call activity's version-resolution binding from its
 * `calledElementBinding`/`calledElementVersion` attributes (both attributes
 * accept the `camunda:` alias via {@link readNamespacedAttr}, exactly like
 * `assignee`).
 *
 * `calledElementVersion` is declared in {@link SUPPORTED_EXTENSION_ATTRS}, so
 * the generic sweep in {@link collectExtensionDrops} stays silent on it even
 * when it is left dangling (set while the binding is absent or not
 * `"version"`, where Operaton ignores it) — this function is the one place
 * that reports that specific drop, since the generic sweep cannot tell a
 * meaningful `calledElementVersion` from a dangling one.
 *
 * @throws {UnsupportedCallActivityError} for `calledElementBinding="version"`
 *   with no usable `calledElementVersion`, or any `calledElementBinding`
 *   value other than `latest`/`deployment`/`version`.
 */
function readCalledElementBinding(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): CalledElementBinding | undefined {
  const bindingValue = readNamespacedAttr(el, 'calledElementBinding');
  const version = readNamespacedAttr(el, 'calledElementVersion');

  let binding: CalledElementBinding | undefined;
  switch (bindingValue) {
    case undefined:
      binding = undefined;
      break;
    case 'latest':
      binding = { kind: 'latest' };
      break;
    case 'deployment':
      binding = { kind: 'deployment' };
      break;
    case 'version':
      if (version === undefined) {
        throw new UnsupportedCallActivityError(
          id,
          'calledElementBinding="version" is set without a ' +
            'calledElementVersion, so the engine cannot resolve which ' +
            'version to call',
        );
      }
      binding = { kind: 'version', version };
      break;
    default:
      throw new UnsupportedCallActivityError(
        id,
        `calledElementBinding="${bindingValue}" is not a binding this tool can represent`,
      );
  }

  if (version !== undefined && binding?.kind !== 'version') {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The 'calledElementVersion' setting on '${id}' has no effect ` +
        'without calledElementBinding="version" and was not imported.',
    });
  }

  return binding;
}

/** The `businessKey`, `inMappings`, and `outMappings` read off a call activity. */
interface CallMappings {
  businessKey?: string;
  inMappings?: CallVariableMapping[];
  outMappings?: CallVariableMapping[];
}

/**
 * Read a call activity's `operaton:in`/`operaton:out` extension-element
 * children into the IR's `businessKey`/`inMappings`/`outMappings`, preserving
 * document order within each of the two mapping arrays.
 *
 * @throws {UnsupportedCallActivityError} for more than one `businessKey` In,
 *   or a `businessKey` In combined with `source`/`sourceExpression`/`target`/
 *   `variables`/`local` — see {@link readCallVariableMapping} for the
 *   per-mapping shapes.
 */
function readCallMappings(el: ModdleElement, id: string): CallMappings {
  const extensionElements = el.get('extensionElements') as
    ModdleElement | undefined;
  const values =
    extensionElements === undefined
      ? []
      : ((extensionElements.get('values') as ModdleElement[] | undefined) ??
        []);

  let businessKey: string | undefined;
  let businessKeyCount = 0;
  const inMappings: CallVariableMapping[] = [];
  const outMappings: CallVariableMapping[] = [];

  for (const value of values) {
    if (value.$type === 'operaton:In') {
      const candidateBusinessKey = readString(value, 'businessKey');
      if (candidateBusinessKey !== undefined) {
        businessKeyCount += 1;
        if (businessKeyCount > 1) {
          throw new UnsupportedCallActivityError(
            id,
            'more than one operaton:in businessKey is set',
          );
        }
        if (
          readString(value, 'source') !== undefined ||
          readString(value, 'sourceExpression') !== undefined ||
          readString(value, 'target') !== undefined ||
          readString(value, 'variables') !== undefined ||
          value.get('local') === true
        ) {
          throw new UnsupportedCallActivityError(
            id,
            'an operaton:in businessKey is combined with ' +
              'source/sourceExpression/target/variables/local',
          );
        }
        businessKey = candidateBusinessKey;
        continue;
      }
      inMappings.push(readCallVariableMapping(value, id, 'operaton:in'));
    } else if (value.$type === 'operaton:Out') {
      outMappings.push(readCallVariableMapping(value, id, 'operaton:out'));
    }
  }

  return {
    ...(businessKey === undefined ? {} : { businessKey }),
    ...(inMappings.length > 0 ? { inMappings } : {}),
    ...(outMappings.length > 0 ? { outMappings } : {}),
  };
}

/**
 * Map one `operaton:in`/`operaton:out` moddle element (excluding a
 * `businessKey` In, handled separately by {@link readCallMappings}) into a
 * {@link CallVariableMapping}. Recognizes exactly three shapes —
 * `variables="all"`, `source`+`target`, `sourceExpression`+`target` — each
 * optionally carrying `local="true"`; anything else is refused rather than
 * mangled into a best-effort guess.
 *
 * @throws {UnsupportedCallActivityError} for both `source` and
 *   `sourceExpression` set, a `source`/`sourceExpression` with no `target`,
 *   a `variables` value other than `"all"`, `variables="all"` combined with
 *   `source`/`sourceExpression`/`target`, or none of the recognized shapes.
 */
function readCallVariableMapping(
  value: ModdleElement,
  ownerId: string,
  tag: 'operaton:in' | 'operaton:out',
): CallVariableMapping {
  const source = readString(value, 'source');
  const sourceExpression = readString(value, 'sourceExpression');
  const variables = readString(value, 'variables');
  const target = readString(value, 'target');
  const local = value.get('local') === true ? true : undefined;

  if (source !== undefined && sourceExpression !== undefined) {
    throw new UnsupportedCallActivityError(
      ownerId,
      `a ${tag} carries both source and sourceExpression`,
    );
  }

  if (variables !== undefined) {
    if (variables !== 'all') {
      throw new UnsupportedCallActivityError(
        ownerId,
        `a ${tag} carries variables="${variables}", which this tool cannot ` +
          'import (only variables="all" is supported)',
      );
    }
    if (
      source !== undefined ||
      sourceExpression !== undefined ||
      target !== undefined
    ) {
      throw new UnsupportedCallActivityError(
        ownerId,
        `a ${tag} carries variables="all" combined with ` +
          'source/sourceExpression/target',
      );
    }
    return { kind: 'all', ...(local === true ? { local } : {}) };
  }

  if (source !== undefined) {
    if (target === undefined) {
      throw new UnsupportedCallActivityError(
        ownerId,
        `a ${tag} carries source without a target`,
      );
    }
    return {
      kind: 'variable',
      source,
      target,
      ...(local === true ? { local } : {}),
    };
  }

  if (sourceExpression !== undefined) {
    if (target === undefined) {
      throw new UnsupportedCallActivityError(
        ownerId,
        `a ${tag} carries sourceExpression without a target`,
      );
    }
    return {
      kind: 'expression',
      sourceExpression,
      target,
      ...(local === true ? { local } : {}),
    };
  }

  throw new UnsupportedCallActivityError(
    ownerId,
    `a ${tag} carries none of the recognized shapes (source+target, ` +
      'sourceExpression+target, variables="all", or businessKey)',
  );
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
 *    in `el.$attrs` whose local name is not one of the names in
 *    {@link SUPPORTED_EXTENSION_ATTRS} (`assignee`/`formKey`/`class`/
 *    `expression`/`delegateExpression`/`type`/`topic`/`calledElementBinding`/
 *    `calledElementVersion`). Those names are read into the IR and are
 *    therefore never reported, regardless of prefix.
 * 2. **Extension elements** — the materialised children of a
 *    `<bpmn:extensionElements>` block (`extensionElements.values`). The IR
 *    consumes no extension elements except a call activity's `operaton:in`/
 *    `operaton:out` mappings (read by {@link mapCallActivity}), so every
 *    other materialised child is a drop: we emit one warning per child,
 *    attributed to this element and naming the child's `$type`. This branch
 *    fires only for children moddle actually materialised — declared
 *    `operaton:` types (`operaton:inputOutput`, `operaton:executionListener`,
 *    `operaton:taskListener`) and any foreign-namespace element (e.g. the
 *    deprecated `camunda:` alias), which moddle keeps as a generic value. An
 *    empty `<extensionElements/>` has no `values`, so it is never flagged.
 *
 *    `operaton:in`/`operaton:out` are only exempt from this drop when the
 *    owning element is itself a `bpmn:CallActivity` — on any other element
 *    (e.g. a plain user task) they are just another declared extension
 *    element and are reported like the ones above.
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
      // operaton:in/operaton:out are consumed by mapCallActivity, but only
      // when the owner really is a call activity — on every other element
      // they still name an unrepresented drop (the honesty guard: this
      // sweep does not go silent just because the child element type is
      // also used, elsewhere, for a supported construct).
      if (
        el.$type === 'bpmn:CallActivity' &&
        (value.$type === 'operaton:In' || value.$type === 'operaton:Out')
      ) {
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
 * A plain end (no event definitions) maps exactly as before. Exactly one
 * error, escalation, signal, or compensation definition maps to a typed
 * throw — `throw error`/`throw escalation`/`throw signal`/`throw
 * compensation` — whose resolved code or name must be non-empty (except
 * compensation, which is payload-less and carries none); any other shape
 * (zero-or-multiple definitions, or a definition kind outside this set)
 * refuses. A genuine label has no slot on a typed throw and is warn-dropped.
 */
function mapEndEvent(el: ModdleElement, warnings: ImportWarning[]): EndEvent {
  const id = requireId(el);
  const defs =
    (el.get('eventDefinitions') as ModdleElement[] | undefined) ?? [];

  if (defs.length === 0) {
    const name = readDerivableName(el, id);
    return { kind: 'endEvent', id, ...(name === undefined ? {} : { name }) };
  }
  if (defs.length > 1) {
    throw new UnsupportedEventFeatureError(
      id,
      `a throw carries ${defs.length} event definitions — only a single ` +
        'error, escalation, signal, or compensation is supported',
    );
  }

  const [defEl] = defs;
  if (
    defEl.$type !== 'bpmn:ErrorEventDefinition' &&
    defEl.$type !== 'bpmn:EscalationEventDefinition' &&
    defEl.$type !== 'bpmn:SignalEventDefinition' &&
    defEl.$type !== 'bpmn:CompensateEventDefinition'
  ) {
    throw new UnsupportedEventDefinitionError(id, 'end', defEl.$type);
  }

  const eventDefinition = readThrowEventDefinition(defEl, id, warnings);
  warnGenuineLabel(el, id, 'a throw', warnings);

  return { kind: 'endEvent', id, eventDefinition };
}

/**
 * Map a `bpmn:IntermediateThrowEvent` moddle element into the IR — the
 * `emit` surface. A single escalation, signal, or compensation definition
 * with a resolvable code/name (or, for compensation, no identity at all — it
 * is payload-less) is representable: a "none" intermediate throw (zero
 * definitions), an error definition (BPMN has no intermediate error throw —
 * `throw error` is the surface for that), more than one definition, or any
 * other definition kind all refuse. A genuine label has no slot here either
 * and is warn-dropped.
 */
function mapIntermediateThrowEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
): IntermediateThrowEvent {
  const id = requireId(el);
  const defs =
    (el.get('eventDefinitions') as ModdleElement[] | undefined) ?? [];

  if (defs.length === 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'an emit with no event definition (a "none" intermediate throw) ' +
        'fires nothing this tool can represent',
    );
  }
  if (defs.length > 1) {
    throw new UnsupportedEventFeatureError(
      id,
      `an emit carries ${defs.length} event definitions — only a single ` +
        'escalation, signal, or compensation is supported',
    );
  }

  const [defEl] = defs;
  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    throw new UnsupportedEventFeatureError(
      id,
      'an emit cannot carry an error — BPMN has no intermediate error ' +
        'throw; write "throw error" to end the path instead',
    );
  }
  if (
    defEl.$type !== 'bpmn:EscalationEventDefinition' &&
    defEl.$type !== 'bpmn:SignalEventDefinition' &&
    defEl.$type !== 'bpmn:CompensateEventDefinition'
  ) {
    throw new UnsupportedEventDefinitionError(
      id,
      'intermediate throw',
      defEl.$type,
    );
  }

  const eventDefinition = readThrowEventDefinition(defEl, id, warnings);
  warnGenuineLabel(el, id, 'an emit', warnings);

  return { kind: 'intermediateThrowEvent', id, eventDefinition };
}

/**
 * Throw {@link UnsupportedEventDefinitionError} when a start event carries
 * one or more event definitions. An empty (or absent) `eventDefinitions`
 * array is a plain event and is allowed. Used only by {@link mapStartEvent}
 * (a *normal* container's start event, which never carries a trigger) — an
 * event handler's start goes through {@link mapEventSubProcessStart}
 * instead, which permits exactly one error/escalation/message/signal/timer/
 * conditional/compensation definition.
 */
function refuseEventDefinitions(
  el: ModdleElement,
  id: string,
  eventKind: 'start',
): void {
  const defs =
    (el.get('eventDefinitions') as ModdleElement[] | undefined) ?? [];
  if (defs.length > 0) {
    throw new UnsupportedEventDefinitionError(id, eventKind, defs[0].$type);
  }
}

/**
 * Throw {@link UnsupportedLoopCharacteristicsError} when a task or
 * sub-process carries loop characteristics — either a
 * `bpmn:MultiInstanceLoopCharacteristics` or a
 * `bpmn:StandardLoopCharacteristics` child. The IR models elements that run
 * exactly once.
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
 * The execution form is read from whichever discriminator the task carries,
 * in this precedence order: `operaton:class` (Java delegate),
 * `operaton:expression`, `operaton:delegateExpression`, or
 * `operaton:type="external"` paired with an `operaton:topic`. A task with
 * none of these — or an external type with no topic — raises
 * {@link UnsupportedServiceTaskFormError} so the caller cannot silently lose
 * runtime semantics.
 */
function mapServiceTask(el: ModdleElement): ServiceTask {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);
  return {
    kind: 'serviceTask',
    id,
    ...(name === undefined ? {} : { name }),
    binding: readServiceTaskBinding(el, id),
  };
}

/**
 * Resolve the single execution binding of a service task from its
 * discriminator attributes. The raw `${…}` text of an expression / delegate
 * expression is carried verbatim — it is exactly the attribute value Operaton
 * evaluates. `external` requires both `operaton:type="external"` and a
 * non-empty `operaton:topic`; the `delegate` DSL alias is applied by the
 * printer, so here the delegate form maps to the `delegateExpression` kind.
 *
 * @throws {UnsupportedServiceTaskFormError} when no representable form is present.
 */
function readServiceTaskBinding(
  el: ModdleElement,
  id: string,
): ServiceTaskBinding {
  const className = readNamespacedAttr(el, 'class');
  if (className !== undefined) return { kind: 'class', className };

  const expression = readNamespacedAttr(el, 'expression');
  if (expression !== undefined) return { kind: 'expression', expression };

  const delegate = readNamespacedAttr(el, 'delegateExpression');
  if (delegate !== undefined) {
    return { kind: 'delegateExpression', expression: delegate };
  }

  const topic = readNamespacedAttr(el, 'topic');
  if (readNamespacedAttr(el, 'type') === 'external' && topic !== undefined) {
    return { kind: 'external', topic };
  }

  throw new UnsupportedServiceTaskFormError(
    id,
    detectUnsupportedServiceTaskForm(el),
  );
}

/**
 * Describe the unrepresentable form a service task used, for the refusal
 * message. Reached only after the class / expression / delegateExpression /
 * external forms have been ruled out, so the remaining cases are an
 * `operaton:type` value the IR cannot represent (including `external`
 * without a usable topic) or no discriminator at all.
 */
function detectUnsupportedServiceTaskForm(el: ModdleElement): string {
  const type = readNamespacedAttr(el, 'type');
  if (type === 'external') {
    return 'operaton:type="external" without an operaton:topic';
  }
  if (type !== undefined) return `operaton:type="${type}"`;
  return 'no execution discriminator';
}

/**
 * Map a `bpmn:ScriptTask` moddle element into the IR.
 *
 * `scriptFormat` becomes the IR `format`; the `<bpmn:script>` body — stored
 * by moddle as the plain-string `script` property — becomes `code`, verbatim.
 */
function mapScriptTask(el: ModdleElement): ScriptTask {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  const name = readDerivableName(el, id);
  const format = readString(el, 'scriptFormat') ?? '';
  const body = el.get('script');
  const code = typeof body === 'string' ? body : '';
  return {
    kind: 'scriptTask',
    id,
    ...(name === undefined ? {} : { name }),
    format,
    code,
  };
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
