/**
 * Error classes raised by the transform package.
 *
 * Co-located in a dedicated module so that consumers (CLI, tests, other
 * transforms) can `import { UnsupportedElementError } from
 * '@bpmn-script/transform'` without pulling in the parser.
 *
 * ## Import contract
 *
 * `xmlToIr` never silently discards content it cannot represent. Content the
 * IR cannot express is **refused**: a subclass of {@link
 * UnsupportedConstructError} is thrown before any IR is produced, so the
 * caller can surface a loud, actionable diagnostic. Refused content:
 *
 * - an event definition of the wrong kind for its position: any definition
 *   on a plain start event; anything other than error/escalation/message/
 *   signal/timer/conditional on an event handler's start; anything other
 *   than error/escalation/signal on an end event or an intermediate throw
 *   (terminate, compensation, …) → {@link UnsupportedEventDefinitionError};
 * - loop characteristics on a task or sub-process (multi-instance or
 *   standard loop) → {@link UnsupportedLoopCharacteristicsError};
 * - collaborations, i.e. pools and message flows →
 *   {@link UnsupportedCollaborationError};
 * - unsupported flow-element kinds (an event sub-process, a transaction, an
 *   ad-hoc sub-process, intermediate events, …) →
 *   {@link UnsupportedElementError};
 * - service tasks whose execution form the IR cannot represent (a bare task
 *   with no discriminator, or an external type without a topic) →
 *   {@link UnsupportedServiceTaskFormError};
 * - form fields whose type is not `string`/`long`/`boolean`/`date` →
 *   {@link UnsupportedFormFieldTypeError};
 * - call activities the engine could not execute as written: no
 *   `calledElement`, a `calledElementBinding="version"` with no
 *   `calledElementVersion`, an unrecognized `calledElementBinding` value
 *   (e.g. `versionTag`), or an `operaton:in`/`operaton:out` mapping using a
 *   shape the IR cannot represent → {@link UnsupportedCallActivityError};
 * - an event-layer construct shaped in a way this tool's surface cannot
 *   express — an event handler with the wrong start-event or definition
 *   count, or with incoming/outgoing sequence flows; a non-interrupting
 *   error handler; a throw or emit whose definition resolves to no code; an
 *   error definition on an emit; a "none" emit; two declared-message roots
 *   that disagree; a message/signal definition with no ref or whose
 *   resolved root has no non-empty name; a timer definition with zero or
 *   more than one time child, or an empty time body; a conditional
 *   definition with no condition, an empty condition body, or an
 *   evaluation-narrowing `variableName`/`variableEvents` attribute — →
 *   {@link UnsupportedEventFeatureError}.
 *
 * Content the IR does not carry but that causes **no semantic loss** is
 * **dropped with a warning** rather than refused — see the `warnings`
 * channel returned by `xmlToIr` (extra Operaton/camunda extension attributes
 * and extension elements beyond `assignee`/`formKey`/`class`/`expression`/
 * `delegateExpression`/`type`/`topic`/`calledElementBinding`/
 * `calledElementVersion`/`errorCodeVariable`/`errorMessageVariable`/
 * `escalationCodeVariable`/`errorMessage`, lanes, a genuine label on an event
 * handler/throw/emit, `itemRef`/`structureRef` on a referenced
 * `bpmn:Message`/`bpmn:Signal` root, and an unreferenced error/escalation/
 * message/signal root).
 *
 * All refusal errors share the abstract base {@link UnsupportedConstructError}
 * so a consumer can classify the whole family with a single `instanceof`
 * check while still special-casing individual subclasses where a tailored
 * message is wanted.
 */

/**
 * Abstract base for every "this construct cannot be represented in the IR"
 * refusal. It carries no fields of its own — each subclass adds the metadata
 * relevant to its construct. Its purpose is classification: a consumer can
 * `catch`/`instanceof UnsupportedConstructError` to treat any refusal as a
 * single "unsupported construct" outcome, rather than enumerating every
 * concrete subclass.
 */
export abstract class UnsupportedConstructError extends Error {}

/**
 * Thrown by {@link xmlToIr} when a BPMN service task carries no execution
 * form the IR can represent.
 *
 * The representable forms are a Java class (`operaton:class`, or the
 * deprecated `camunda:class` alias), an `operaton:expression`, an
 * `operaton:delegateExpression`, and an external task —
 * `operaton:type="external"` paired with an `operaton:topic`. A task with
 * none of these, or an external type missing its topic, is refused on import
 * so semantic loss is impossible.
 *
 * The error message names the offending construct so callers can surface
 * a useful diagnostic to the user.
 */
export class UnsupportedServiceTaskFormError extends UnsupportedConstructError {
  /** The BPMN id of the service task that triggered the error. */
  readonly serviceTaskId: string;
  /**
   * A description of the unrepresentable form (e.g.
   * `operaton:type="external" without an operaton:topic`), or the string
   * `"no execution discriminator"` when the task carries no execution form
   * at all.
   */
  readonly construct: string;

  constructor(serviceTaskId: string, construct: string) {
    super(
      `Service task '${serviceTaskId}' uses unsupported execution form: ${construct}. ` +
        'Supported forms are a Java class, an expression, a delegate expression, ' +
        'or an external task topic.',
    );
    this.name = 'UnsupportedServiceTaskFormError';
    this.serviceTaskId = serviceTaskId;
    this.construct = construct;
  }
}

/**
 * Thrown by {@link xmlToIr} when an `operaton:formField` uses a `type` the DSL
 * cannot express. The DSL form types `string`, `number`, `boolean`, and `date`
 * map to the Operaton `string`, `long`, `boolean`, and `date` field types. Any
 * other field type (`double`, `enum`, a custom type, or none) is refused so the
 * field's input semantics are not silently narrowed.
 */
export class UnsupportedFormFieldTypeError extends UnsupportedConstructError {
  /** The BPMN id of the element carrying the form field. */
  readonly elementId: string;
  /** The `id` of the offending form field. */
  readonly fieldId: string;
  /** The unsupported `operaton:formField` `type` value. */
  readonly fieldType: string;

  constructor(elementId: string, fieldId: string, fieldType: string) {
    super(
      `The form field '${fieldId}' on '${elementId}' has type '${fieldType}', ` +
        'which this tool cannot import. Supported form field types are ' +
        'string, long, boolean, and date.',
    );
    this.name = 'UnsupportedFormFieldTypeError';
    this.elementId = elementId;
    this.fieldId = fieldId;
    this.fieldType = fieldType;
  }
}

/**
 * Thrown by {@link xmlToIr} when the input BPMN contains a flow element
 * kind that lies outside the supported subset.
 *
 * The supported subset is `bpmn:startEvent`, `bpmn:endEvent`,
 * `bpmn:intermediateThrowEvent` (an `emit`), `bpmn:userTask`,
 * `bpmn:serviceTask`, `bpmn:scriptTask`, `bpmn:exclusiveGateway`,
 * `bpmn:parallelGateway`, an embedded `bpmn:subProcess` (plain, or an event
 * handler when `triggeredByEvent="true"`), `bpmn:callActivity`, and
 * `bpmn:sequenceFlow`. Anything else (`bpmn:intermediateCatchEvent`,
 * `bpmn:transaction`, `bpmn:adHocSubProcess`, etc.) raises this error so
 * unsupported workflows fail loudly at import.
 *
 * A supported *kind* that is nonetheless shaped in a way this tool's surface
 * cannot express — an event handler with the wrong start-event/definition
 * count, or a throw/emit with no resolvable code — refuses via {@link
 * UnsupportedEventFeatureError} or {@link UnsupportedEventDefinitionError}
 * instead: the element kind itself is fine, only its specific shape is not.
 */
export class UnsupportedElementError extends UnsupportedConstructError {
  /** The fully-qualified BPMN type name, e.g. `bpmn:ParallelGateway`. */
  readonly qname: string;
  /** The BPMN `id` of the offending element, when available. */
  readonly elementId?: string;

  constructor(qname: string, elementId?: string) {
    super(
      `The BPMN element ${qname}` +
        (elementId ? ` (id='${elementId}')` : '') +
        ' is a kind that this tool cannot import. ' +
        'Only start/end events, throws, emits, event handlers, user tasks, ' +
        'service tasks, script tasks, exclusive gateways, parallel ' +
        'gateways, embedded sub-processes, call activities, and sequence ' +
        'flows are supported.',
    );
    this.name = 'UnsupportedElementError';
    this.qname = qname;
    this.elementId = elementId;
  }
}

/**
 * Thrown by {@link xmlToIr} when a `bpmn:callActivity` carries a shape the
 * engine could not resolve or execute: no `calledElement`, a
 * `calledElementBinding` the IR cannot represent (`version` with no
 * `calledElementVersion`, or any value other than `latest`/`deployment`/
 * `version`), or an `operaton:in`/`operaton:out` mapping whose attributes do
 * not match one of the recognized shapes (`source`+`target`,
 * `sourceExpression`+`target`, `variables="all"`, or a lone `businessKey`).
 *
 * The import contract for a call activity is refuse-or-map: rather than
 * narrowing an ambiguous or unresolvable shape into something that would
 * silently change behavior at runtime, the transform refuses it outright and
 * names the concrete offending shape via `detail`.
 */
export class UnsupportedCallActivityError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending call activity. */
  readonly elementId: string;
  /** A description of the unrepresentable shape, e.g. the malformed mapping. */
  readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The call activity '${elementId}' cannot be imported: ${detail}. ` +
        'Supported call activities name a calledElement, an optional ' +
        'latest/deployment/version binding, a businessKey, and in/out ' +
        'mappings using source+target, sourceExpression+target, or ' +
        'variables="all".',
    );
    this.name = 'UnsupportedCallActivityError';
    this.elementId = elementId;
    this.detail = detail;
  }
}

/**
 * Thrown by {@link xmlToIr} when a start event, end event, or intermediate
 * throw carries an event definition kind this tool does not import at that
 * position: any definition on a plain start event (outside an event
 * handler); any definition other than error/escalation/message/signal/timer/
 * conditional on an event handler's start; any definition other than error/
 * escalation/signal on an end event; any definition other than escalation/
 * signal on an intermediate throw (terminate, compensation, …). The DSL's
 * event layer models only these catch (`on`) and throw/emit (`throw`/`emit`)
 * forms, so any other trigger/result semantics cannot be represented and
 * must not be silently dropped.
 *
 * A definition of the *right* kind but the *wrong shape* (e.g. an error
 * throw resolving to no code, a timer with no time child, a conditional
 * carrying an evaluation-narrowing attribute) refuses via
 * {@link UnsupportedEventFeatureError} instead — this class is reserved for
 * the wrong kind of definition.
 */
export class UnsupportedEventDefinitionError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending start/end/intermediate-throw event. */
  readonly elementId: string;
  /** Which position the offending event occupies. */
  readonly eventKind: 'start' | 'end' | 'intermediate throw';
  /**
   * The moddle `$type` of the first event definition found, e.g.
   * `bpmn:TerminateEventDefinition` or `bpmn:CompensateEventDefinition`.
   */
  readonly definitionType: string;

  constructor(
    elementId: string,
    eventKind: 'start' | 'end' | 'intermediate throw',
    definitionType: string,
  ) {
    super(
      `The ${eventKind} event '${elementId}' carries a ${friendlyEventDefinition(definitionType)} ` +
        `definition (${definitionType}) that this tool cannot import. ` +
        supportedKindsMessage(eventKind),
    );
    this.name = 'UnsupportedEventDefinitionError';
    this.elementId = elementId;
    this.eventKind = eventKind;
    this.definitionType = definitionType;
  }
}

/**
 * Thrown by {@link xmlToIr} when an event-layer construct carries the right
 * *kind* of event definition but is shaped in a way this tool's surface
 * cannot express — as opposed to {@link UnsupportedEventDefinitionError},
 * which refuses the wrong kind of definition outright.
 *
 * Concretely: an event handler (`triggeredByEvent="true"` sub-process) whose
 * start-event count is not exactly one, whose start carries zero or
 * multiple definitions, or which itself carries incoming/outgoing sequence
 * flows; a non-interrupting error handler (`isInterrupting="false"` on an
 * error trigger — BPMN forbids it); a typed end event or escalation
 * intermediate throw whose definition resolves to no code; an error
 * definition on an intermediate throw (no such BPMN form); a "none"
 * intermediate throw; two `bpmn:Error` root elements sharing a code but
 * disagreeing about the declared message; and a declared message on a root
 * with no code to key it by.
 *
 * Mirrors {@link UnsupportedCallActivityError}: the shape is refused
 * outright — never narrowed or silently reinterpreted — and `detail` names
 * the concrete offending shape.
 */
export class UnsupportedEventFeatureError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending element (or root element). */
  readonly elementId: string;
  /** A description of the unrepresentable shape. */
  readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The event construct at '${elementId}' cannot be imported: ${detail}. ` +
        "Supported event handlers catch a single error or escalation on " +
        "their one start event; supported throws and emits resolve to a " +
        'single, non-empty error or escalation code.',
    );
    this.name = 'UnsupportedEventFeatureError';
    this.elementId = elementId;
    this.detail = detail;
  }
}

/**
 * Thrown by {@link xmlToIr} when a task or sub-process carries loop
 * characteristics — either a multi-instance marker or a standard loop. The
 * IR models elements that run exactly once, so repetition semantics cannot
 * be represented.
 */
export class UnsupportedLoopCharacteristicsError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending element. */
  readonly elementId: string;
  /**
   * The moddle `$type` of the loop characteristics, e.g.
   * `bpmn:MultiInstanceLoopCharacteristics` or
   * `bpmn:StandardLoopCharacteristics`.
   */
  readonly loopType: string;

  constructor(elementId: string, loopType: string) {
    super(
      `The element '${elementId}' repeats (${friendlyLoopType(loopType)}: ${loopType}), ` +
        'which this tool cannot import. Only elements that run once are supported.',
    );
    this.name = 'UnsupportedLoopCharacteristicsError';
    this.elementId = elementId;
    this.loopType = loopType;
  }
}

/**
 * Thrown by {@link xmlToIr} when the document describes a collaboration —
 * multiple participants (pools) and/or message flows between them. The IR
 * models a single standalone process, so collaboration structure cannot be
 * represented.
 */
export class UnsupportedCollaborationError extends UnsupportedConstructError {
  /** A human-readable description of the collaboration content found. */
  readonly detail: string;

  constructor(detail: string) {
    super(
      `The file contains ${detail}, which this tool cannot import. ` +
        'Only a single standalone process (no pools or message flows) is supported.',
    );
    this.name = 'UnsupportedCollaborationError';
    this.detail = detail;
  }
}

/**
 * Turn a moddle event-definition `$type` (e.g. `bpmn:TimerEventDefinition`)
 * into a plain lower-case word (`timer`) for the error message, so the
 * refusal reads naturally without leaning on the fully-qualified type.
 */
function friendlyEventDefinition(definitionType: string): string {
  const local = definitionType.replace(/^.*:/, '');
  return local.replace(/EventDefinition$/, '').toLowerCase() || 'special';
}

/**
 * Name the event definition kinds this tool imports at a given position, for
 * the {@link UnsupportedEventDefinitionError} message. A plain start event
 * accepts none at all — the sentence explains that the six trigger kinds are
 * only available on an event handler's start, which also reads correctly
 * when the offending element genuinely is a handler start carrying the wrong
 * kind (e.g. a compensation or terminate definition).
 */
function supportedKindsMessage(
  eventKind: 'start' | 'end' | 'intermediate throw',
): string {
  switch (eventKind) {
    case 'start':
      return (
        "A plain start event carries no definition; an event handler's " +
        'start supports error, escalation, message, signal, timer, or conditional.'
      );
    case 'end':
      return 'A typed end event supports error, escalation, or signal.';
    case 'intermediate throw':
      return 'An emit supports escalation or signal.';
  }
}

/**
 * Turn a moddle loop-characteristics `$type` into a plain description.
 */
function friendlyLoopType(loopType: string): string {
  if (loopType.includes('MultiInstance')) return 'multi-instance';
  if (loopType.includes('StandardLoop')) return 'standard loop';
  return 'loop';
}
