/**
 * Error classes raised by the transform package.
 *
 * Co-located in a dedicated module so that consumers (CLI, tests, other
 * transforms) can `import { UnsupportedElementError } from
 * '@bpmn-script/transform'` without pulling in the parser.
 *
 * ## The import contract, precisely
 *
 * `xmlToIr` never silently discards content it cannot represent. Content the
 * IR cannot express is **refused**: a subclass of {@link
 * UnsupportedConstructError} is thrown before any IR is produced, so the
 * caller can surface a loud, actionable diagnostic. Refused content:
 *
 * - event definitions on start/end events (timer, message, signal, error,
 *   terminate, …) → {@link UnsupportedEventDefinitionError};
 * - loop characteristics on a task (multi-instance or standard loop) →
 *   {@link UnsupportedLoopCharacteristicsError};
 * - collaborations, i.e. pools and message flows →
 *   {@link UnsupportedCollaborationError};
 * - unsupported flow-element kinds (script task, sub-process, call activity,
 *   intermediate events, …) → {@link UnsupportedElementError};
 * - service tasks whose execution form is not `operaton:class` →
 *   {@link UnsupportedServiceTaskFormError}.
 *
 * Content the IR does not carry but that causes **no semantic loss** is
 * **dropped with a warning** rather than refused — see the `warnings`
 * channel returned by `xmlToIr` (extra Operaton/camunda extension attributes
 * and extension elements beyond `assignee`/`formKey`/`class`, and lanes).
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
 * Thrown by {@link xmlToIr} when a BPMN service task uses an execution
 * discriminator that the IR cannot represent.
 *
 * Only the Java-class pattern (`operaton:class` or the deprecated
 * `camunda:class` alias) is supported. Tasks using `operaton:expression`,
 * `operaton:delegateExpression`, `operaton:type`, or no discriminator at
 * all are refused on import so semantic loss is impossible.
 *
 * The error message names the offending construct so callers can surface
 * a useful diagnostic to the user.
 */
export class UnsupportedServiceTaskFormError extends UnsupportedConstructError {
  /** The BPMN id of the service task that triggered the error. */
  readonly serviceTaskId: string;
  /**
   * The detected execution discriminator (e.g. `operaton:expression`), or
   * the string `"no execution discriminator"` when the task carries none
   * of the recognised forms.
   */
  readonly construct: string;

  constructor(serviceTaskId: string, construct: string) {
    super(
      `Service task '${serviceTaskId}' uses unsupported execution form: ${construct}. ` +
        'Only operaton:class (or the deprecated camunda:class alias) is supported.',
    );
    this.name = 'UnsupportedServiceTaskFormError';
    this.serviceTaskId = serviceTaskId;
    this.construct = construct;
  }
}

/**
 * Thrown by {@link xmlToIr} when the input BPMN contains a flow element
 * kind that lies outside the supported subset.
 *
 * The supported subset is `bpmn:startEvent`, `bpmn:endEvent`,
 * `bpmn:userTask`, `bpmn:serviceTask`, `bpmn:exclusiveGateway`,
 * `bpmn:parallelGateway`, and `bpmn:sequenceFlow`. Anything else
 * (`bpmn:scriptTask`, `bpmn:intermediateCatchEvent`, `bpmn:subProcess`,
 * `bpmn:callActivity`, etc.) raises this error so unsupported workflows
 * fail loudly at import.
 */
export class UnsupportedElementError extends UnsupportedConstructError {
  /** The fully-qualified BPMN type name, e.g. `bpmn:ParallelGateway`. */
  readonly qname: string;
  /** The BPMN `id` of the offending element, when available. */
  readonly elementId?: string;

  constructor(qname: string, elementId?: string) {
    super(
      `Unsupported BPMN element ${qname}` +
        (elementId ? ` (id='${elementId}')` : '') +
        '. Supported elements are start/end events, user tasks, service tasks ' +
        '(with operaton:class), exclusive gateways, parallel gateways, and sequence flows.',
    );
    this.name = 'UnsupportedElementError';
    this.qname = qname;
    this.elementId = elementId;
  }
}

/**
 * Thrown by {@link xmlToIr} when a start or end event carries an event
 * definition (timer, message, signal, error, terminate, …). The IR models
 * only plain start and end events, so the trigger/result semantics of a
 * defined event cannot be represented and must not be silently dropped.
 */
export class UnsupportedEventDefinitionError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending start/end event. */
  readonly elementId: string;
  /** Whether the offending event is a start event or an end event. */
  readonly eventKind: 'start' | 'end';
  /**
   * The moddle `$type` of the first event definition found, e.g.
   * `bpmn:TimerEventDefinition` or `bpmn:MessageEventDefinition`.
   */
  readonly definitionType: string;

  constructor(
    elementId: string,
    eventKind: 'start' | 'end',
    definitionType: string,
  ) {
    super(
      `The ${eventKind} event '${elementId}' carries a ${friendlyEventDefinition(definitionType)} ` +
        `definition (${definitionType}) that this tool cannot import. ` +
        'Only plain start and end events are supported.',
    );
    this.name = 'UnsupportedEventDefinitionError';
    this.elementId = elementId;
    this.eventKind = eventKind;
    this.definitionType = definitionType;
  }
}

/**
 * Thrown by {@link xmlToIr} when a task carries loop characteristics —
 * either a multi-instance marker or a standard loop. The IR models tasks
 * that run exactly once, so repetition semantics cannot be represented.
 */
export class UnsupportedLoopCharacteristicsError extends UnsupportedConstructError {
  /** The BPMN `id` of the offending task. */
  readonly elementId: string;
  /**
   * The moddle `$type` of the loop characteristics, e.g.
   * `bpmn:MultiInstanceLoopCharacteristics` or
   * `bpmn:StandardLoopCharacteristics`.
   */
  readonly loopType: string;

  constructor(elementId: string, loopType: string) {
    super(
      `The task '${elementId}' repeats (${friendlyLoopType(loopType)}: ${loopType}), ` +
        'which this tool cannot import. Only tasks that run once are supported.',
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
 * Turn a moddle loop-characteristics `$type` into a plain description.
 */
function friendlyLoopType(loopType: string): string {
  if (loopType.includes('MultiInstance')) return 'multi-instance';
  if (loopType.includes('StandardLoop')) return 'standard loop';
  return 'loop';
}
