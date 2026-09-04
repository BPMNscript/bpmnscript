/**
 * Refusals raised by `xmlToIr`.
 *
 * Content the IR cannot express is refused before any IR is produced. Content
 * the IR does not carry but that costs no semantics is dropped with a warning
 * instead, on the `warnings` channel `xmlToIr` returns.
 * `packages/transform/README.md` tabulates which construct lands where.
 */

/**
 * Base for every refusal, so a consumer can classify the whole family with one
 * `instanceof`. Subclasses declare their fields with `declare` so nothing
 * overwrites what `Object.assign` wrote after `super()`.
 */
export abstract class UnsupportedConstructError extends Error {
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, detail);
  }
}

/** A service task with no execution form, or an external type missing its topic. */
export class UnsupportedServiceTaskFormError extends UnsupportedConstructError {
  declare readonly serviceTaskId: string;
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
 * An `operaton:formField` type outside the four the DSL maps (`string`, `long`,
 * `boolean`, `date`), which would otherwise narrow the field's input semantics.
 */
export class UnsupportedFormFieldTypeError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly fieldId: string;
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
 * A flow element kind outside the supported subset, such as `bpmn:transaction`
 * or `bpmn:adHocSubProcess`. A supported kind carrying an unrepresentable shape
 * refuses via {@link UnsupportedEventFeatureError} or
 * {@link UnsupportedEventDefinitionError} instead.
 */
export class UnsupportedElementError extends UnsupportedConstructError {
  /** Fully-qualified BPMN type name, e.g. `bpmn:ParallelGateway`. */
  declare readonly qname: string;
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

/** A call activity the engine could not resolve: `detail` names the shape. */
export class UnsupportedCallActivityError extends UnsupportedConstructError {
  declare readonly elementId: string;
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
 * An event definition kind this tool does not import at that position. The
 * right kind in the wrong shape (an error throw with no code, a timer with no
 * time child) refuses via {@link UnsupportedEventFeatureError} instead.
 */
export class UnsupportedEventDefinitionError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly eventKind:
    'start' | 'end' | 'intermediate throw' | 'intermediate catch' | 'boundary';
  /** Moddle `$type`, e.g. `bpmn:TerminateEventDefinition`. */
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
 * A supported event definition kind shaped in a way the DSL surface cannot
 * express. `detail` names the shape.
 */
export class UnsupportedEventFeatureError extends UnsupportedConstructError {
  declare readonly elementId: string;
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

/** Loop characteristics: the IR models elements that run exactly once. */
export class UnsupportedLoopCharacteristicsError extends UnsupportedConstructError {
  declare readonly elementId: string;
  /** Moddle `$type`, e.g. `bpmn:MultiInstanceLoopCharacteristics`. */
  declare readonly loopType: string;

  constructor(elementId: string, loopType: string) {
    super(
      `The element '${elementId}' repeats (${friendlyLoopType(loopType)}: ${loopType}), ` +
        'which this tool cannot import. Only elements that run once are supported.',
      { elementId, loopType },
    );
  }
}

/** Pools or message flows: the IR models a single standalone process. */
export class UnsupportedCollaborationError extends UnsupportedConstructError {
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
 * Operaton extension content the IR's discriminated unions cannot represent.
 * `detail` names the shape; the message states the rule it broke.
 */
export class UnsupportedExtensionFormError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The Operaton extension content on '${elementId}' cannot be imported: ${detail}. ` +
        'An input/output parameter or map entry carries body text or exactly ' +
        'one nested value, never both or two, and is always named; a script ' +
        'value declares a scriptFormat and carries inline code, never an ' +
        'external resource; a listener names exactly one binding and an event ' +
        'its position accepts; and a timeout task listener carries exactly one ' +
        'timer, which no other task listener event carries.',
      { elementId, detail },
    );
  }
}

/** `bpmn:TimerEventDefinition` -> `timer`. */
function friendlyEventDefinition(definitionType: string): string {
  const local = definitionType.replace(/^.*:/, '');
  return local.replace(/EventDefinition$/, '').toLowerCase() || 'special';
}

/**
 * Compensation is absent from the boundary sentence because a boundary
 * compensation trigger refuses earlier, via {@link UnsupportedEventFeatureError}.
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

function friendlyLoopType(loopType: string): string {
  if (loopType.includes('MultiInstance')) return 'multi-instance';
  if (loopType.includes('StandardLoop')) return 'standard loop';
  return 'loop';
}
