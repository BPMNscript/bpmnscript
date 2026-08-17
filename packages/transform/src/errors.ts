/**
 * Error classes raised by the transform package.
 *
 * Co-located in a dedicated module so that consumers (CLI, tests, other
 * transforms) can `import { UnsupportedElementError } from
 * '@bpmn-script/transform'` without pulling in the parser.
 *
 * ## Import contract
 *
 * `xmlToIr` never discards content it cannot represent. Content the IR cannot
 * express is **refused**: a subclass of {@link UnsupportedConstructError} is
 * thrown before any IR is produced, so the caller can surface a loud,
 * actionable diagnostic. Refused content:
 *
 * - an event definition of the wrong kind for its position ->
 *   {@link UnsupportedEventDefinitionError};
 * - an event-layer construct of a supported kind but a shape the DSL cannot
 *   express -> {@link UnsupportedEventFeatureError};
 * - loop characteristics on a task or sub-process (multi-instance or
 *   standard loop) -> {@link UnsupportedLoopCharacteristicsError};
 * - collaborations, i.e. pools and message flows ->
 *   {@link UnsupportedCollaborationError};
 * - unsupported flow-element kinds (a transaction, an ad-hoc sub-process,
 *   intermediate catch events) -> {@link UnsupportedElementError};
 * - service tasks whose execution form the IR cannot represent (a bare task
 *   with no discriminator, or an external type without a topic) ->
 *   {@link UnsupportedServiceTaskFormError};
 * - form fields whose type is not `string`/`long`/`boolean`/`date` ->
 *   {@link UnsupportedFormFieldTypeError};
 * - call activities the engine could not execute as written (no
 *   `calledElement`, a binding the IR cannot represent, or an unrecognized
 *   `operaton:in`/`operaton:out` shape) ->
 *   {@link UnsupportedCallActivityError}.
 *
 * Content the IR does not carry but that causes **no semantic loss** is
 * **dropped with a warning** rather than refused: see the `warnings` channel
 * returned by `xmlToIr`.
 *
 * All refusal errors share the abstract base {@link UnsupportedConstructError}
 * so a consumer can classify the whole family with a single `instanceof`
 * check while still special-casing individual subclasses where a tailored
 * message is wanted.
 */

/**
 * Abstract base for every "this construct cannot be represented in the IR"
 * refusal. Its purpose is classification: a consumer can
 * `catch`/`instanceof UnsupportedConstructError` to treat any refusal as a
 * single "unsupported construct" outcome, rather than enumerating every
 * concrete subclass.
 *
 * The constructor carries the boilerplate every refusal shares: `name` is the
 * concrete subclass's own name, and `detail` supplies that subclass's declared
 * fields. Subclasses declare those fields with `declare` so they are typing
 * only and no field initializer runs after `super()` to overwrite them.
 */
export abstract class UnsupportedConstructError extends Error {
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, detail);
  }
}

/**
 * Thrown by {@link xmlToIr} when a BPMN service task carries no execution
 * form the IR can represent.
 *
 * The representable forms are a Java class (`operaton:class`, or the
 * deprecated `camunda:class` alias), an `operaton:expression`, an
 * `operaton:delegateExpression`, and an external task
 * (`operaton:type="external"` paired with an `operaton:topic`). A task with
 * none of these, or an external type missing its topic, is refused on import
 * so semantic loss is impossible.
 */
export class UnsupportedServiceTaskFormError extends UnsupportedConstructError {
  /** The BPMN id of the service task that triggered the error. */
  declare readonly serviceTaskId: string;
  /**
   * A description of the unrepresentable form (e.g.
   * `operaton:type="external" without an operaton:topic`), or the string
   * `"no execution discriminator"` when the task carries no execution form
   * at all.
   */
  declare readonly construct: string;

  constructor(serviceTaskId: string, construct: string) {
    super(
      `Service task '${serviceTaskId}' uses unsupported execution form: ${construct}. ` +
        'Supported forms are a Java class, an expression, a delegate expression, ' +
        'or an external task topic.',
      { serviceTaskId, construct },
    );
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
  declare readonly elementId: string;
  /** The `id` of the offending form field. */
  declare readonly fieldId: string;
  /** The unsupported `operaton:formField` `type` value. */
  declare readonly fieldType: string;

  constructor(elementId: string, fieldId: string, fieldType: string) {
    super(
      `The form field '${fieldId}' on '${elementId}' has type '${fieldType}', ` +
        'which this tool cannot import. Supported form field types are ' +
        'string, long, boolean, and date.',
      { elementId, fieldId, fieldType },
    );
  }
}

/**
 * Thrown by {@link xmlToIr} when the input BPMN contains a flow element
 * kind that lies outside the supported subset.
 *
 * The supported subset is `bpmn:startEvent`, `bpmn:endEvent`,
 * `bpmn:intermediateThrowEvent` (an `emit`), `bpmn:boundaryEvent` (attached
 * to an activity in the same container), `bpmn:userTask`,
 * `bpmn:serviceTask`, `bpmn:scriptTask`, `bpmn:exclusiveGateway`,
 * `bpmn:parallelGateway`, an embedded `bpmn:subProcess` (plain, or an event
 * handler when `triggeredByEvent="true"`), `bpmn:callActivity`, and
 * `bpmn:sequenceFlow`. Anything else (`bpmn:intermediateCatchEvent`,
 * `bpmn:transaction`, `bpmn:adHocSubProcess`, etc.) raises this error so
 * unsupported workflows fail loudly at import. A supported kind carrying a
 * shape the DSL cannot express refuses via {@link UnsupportedEventFeatureError}
 * or {@link UnsupportedEventDefinitionError} instead.
 */
export class UnsupportedElementError extends UnsupportedConstructError {
  /** The fully-qualified BPMN type name, e.g. `bpmn:ParallelGateway`. */
  declare readonly qname: string;
  /** The BPMN `id` of the offending element, when available. */
  declare readonly elementId?: string;

  constructor(qname: string, elementId?: string) {
    super(
      `The BPMN element ${qname}` +
        (elementId ? ` (id='${elementId}')` : '') +
        ' is a kind that this tool cannot import. ' +
        'Only start/end events, throws, emits, boundary events, event ' +
        'handlers, user tasks, service tasks, script tasks, exclusive ' +
        'gateways, parallel gateways, embedded sub-processes, call ' +
        'activities, and sequence flows are supported.',
      { qname, elementId },
    );
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
 * `detail` names the concrete offending shape.
 */
export class UnsupportedCallActivityError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending call activity. */
  declare readonly elementId: string;
  /** A description of the unrepresentable shape, e.g. the malformed mapping. */
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The call activity '${elementId}' cannot be imported: ${detail}. ` +
        'Supported call activities name a calledElement, an optional ' +
        'latest/deployment/version binding, a businessKey, and in/out ' +
        'mappings using source+target, sourceExpression+target, or ' +
        'variables="all".',
      { elementId, detail },
    );
  }
}

/**
 * Thrown by {@link xmlToIr} when a start event, end event, intermediate
 * throw, intermediate catch, or boundary event carries an event definition
 * kind this tool does not import at that position; `supportedKindsMessage`
 * below lists the kinds each position accepts. The DSL's event layer models
 * only those catch (`on`) and throw/emit (`throw`/`emit`) forms, so any other
 * trigger/result semantics cannot be represented and must not be dropped.
 *
 * A definition of the right kind but the wrong shape (e.g. an error throw
 * resolving to no code, a timer with no time child) refuses via
 * {@link UnsupportedEventFeatureError} instead.
 */
export class UnsupportedEventDefinitionError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending start/end/intermediate-throw/catch/boundary event. */
  declare readonly elementId: string;
  /** Which position the offending event occupies. */
  declare readonly eventKind:
    'start' | 'end' | 'intermediate throw' | 'intermediate catch' | 'boundary';
  /**
   * The moddle `$type` of the first event definition found, e.g.
   * `bpmn:TerminateEventDefinition` or `bpmn:LinkEventDefinition`.
   */
  declare readonly definitionType: string;

  constructor(
    elementId: string,
    eventKind:
      | 'start'
      | 'end'
      | 'intermediate throw'
      | 'intermediate catch'
      | 'boundary',
    definitionType: string,
  ) {
    super(
      `The ${eventKind} event '${elementId}' carries a ${friendlyEventDefinition(definitionType)} ` +
        `definition (${definitionType}) that this tool cannot import. ` +
        supportedKindsMessage(eventKind),
      { elementId, eventKind, definitionType },
    );
  }
}

/**
 * Thrown by {@link xmlToIr} when an event-layer construct carries a
 * supported kind of event definition but is shaped in a way this tool's
 * surface cannot express, as opposed to
 * {@link UnsupportedEventDefinitionError}, which refuses the wrong kind of
 * definition outright. `detail` names the concrete offending shape.
 */
export class UnsupportedEventFeatureError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending element (or root element). */
  declare readonly elementId: string;
  /** A description of the unrepresentable shape. */
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The event construct at '${elementId}' cannot be imported: ${detail}. ` +
        'Event handlers catch one error, escalation, message, signal, timer, ' +
        'conditional, or compensation trigger on their single start event; ' +
        'throws and emits carry the code or name their kind requires, and ' +
        'compensation carries neither.',
      { elementId, detail },
    );
  }
}

/**
 * Thrown by {@link xmlToIr} when a task or sub-process carries loop
 * characteristics, either a multi-instance marker or a standard loop. The
 * IR models elements that run exactly once, so repetition semantics cannot
 * be represented.
 */
export class UnsupportedLoopCharacteristicsError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending element. */
  declare readonly elementId: string;
  /**
   * The moddle `$type` of the loop characteristics, e.g.
   * `bpmn:MultiInstanceLoopCharacteristics` or
   * `bpmn:StandardLoopCharacteristics`.
   */
  declare readonly loopType: string;

  constructor(elementId: string, loopType: string) {
    super(
      `The element '${elementId}' repeats (${friendlyLoopType(loopType)}: ${loopType}), ` +
        'which this tool cannot import. Only elements that run once are supported.',
      { elementId, loopType },
    );
  }
}

/**
 * Thrown by {@link xmlToIr} when the document describes a collaboration:
 * multiple participants (pools) and/or message flows between them. The IR
 * models a single standalone process, so collaboration structure cannot be
 * represented.
 */
export class UnsupportedCollaborationError extends UnsupportedConstructError {
  /** A human-readable description of the collaboration content found. */
  declare readonly detail: string;

  constructor(detail: string) {
    super(
      `The file contains ${detail}, which this tool cannot import. ` +
        'Only a single standalone process (no pools or message flows) is supported.',
      { detail },
    );
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
 * the {@link UnsupportedEventDefinitionError} message. Compensation is absent
 * from the boundary sentence because a boundary compensation trigger refuses
 * earlier, with its own message (see {@link UnsupportedEventFeatureError}).
 */
function supportedKindsMessage(
  eventKind:
    'start' | 'end' | 'intermediate throw' | 'intermediate catch' | 'boundary',
): string {
  switch (eventKind) {
    case 'start':
      return (
        "A plain start event carries no definition; an event handler's " +
        'start supports error, escalation, message, signal, timer, ' +
        'conditional, or compensation.'
      );
    case 'end':
      return 'A typed end event supports error, escalation, signal, or compensation.';
    case 'intermediate throw':
      return 'An emit supports escalation, signal, or compensation.';
    case 'intermediate catch':
      return 'An await supports message, timer, signal, or conditional.';
    case 'boundary':
      return (
        'A boundary event supports error, escalation, message, signal, ' +
        'timer, or conditional.'
      );
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
