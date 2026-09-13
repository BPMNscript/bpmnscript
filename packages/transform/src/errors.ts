/**
 * Refusals raised by `xmlToIr`.
 *
 * Content the IR cannot express is refused before any IR is produced. Content
 * the IR does not carry but that costs no semantics is dropped with a warning
 * instead, on the `warnings` channel `xmlToIr` returns.
 * `packages/transform/README.md` tabulates which construct lands where.
 */

import {
  CATCH_TRIGGERS,
  EMIT_TRIGGERS,
  FORM_CONSTRAINT_NAMES,
  formatPlainWordList,
  ON_TRIGGERS,
  START_TRIGGERS,
  TRIGGER_PAYLOAD,
} from '@bpmn-script/language';

/**
 * Base for every refusal, so a consumer can classify the whole family with one
 * `instanceof`. Subclasses declare their fields with `declare` so the class
 * field initializers cannot overwrite what `Object.assign` wrote after
 * `super()`.
 */
export abstract class UnsupportedConstructError extends Error {
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, detail);
  }
}

/**
 * A task with no execution form, or an external type missing its topic.
 * Operaton applies the same mandatory-discriminator rule to every tag it runs
 * through its service-task factory, so `subject` names which one refused.
 */
export class UnsupportedServiceTaskFormError extends UnsupportedConstructError {
  declare readonly serviceTaskId: string;
  declare readonly construct: string;
  declare readonly subject: string;

  constructor(
    serviceTaskId: string,
    construct: string,
    subject = 'Service task',
  ) {
    super(
      `${subject} '${serviceTaskId}' uses unsupported execution form: ${construct}. ` +
        'Supported forms are a Java class, an expression, a delegate expression, ' +
        'an external task topic, a built-in mail or shell task with its fields, ' +
        'or, on a business rule task, a decision reference.',
      { serviceTaskId, construct, subject },
    );
  }
}

/**
 * An `operaton:formField` type outside the five the DSL maps: `string`,
 * `long`, `boolean`, `date`, and `enum`, `long` being the Operaton spelling of
 * the DSL's `number`.
 */
export class UnsupportedFormFieldTypeError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly fieldId: string;
  declare readonly fieldType: string;

  constructor(elementId: string, fieldId: string, fieldType: string) {
    super(
      `The form field '${fieldId}' on '${elementId}' has type '${fieldType}', ` +
        'which this tool cannot import. Supported form field types are ' +
        'string, long, boolean, date, and enum.',
      { elementId, fieldId, fieldType },
    );
  }
}

/** {@link FORM_CONSTRAINT_NAMES} minus `validator`, joined as a plain enumeration. */
const REGISTERED_VALIDATOR_NAMES = (() => {
  const names = FORM_CONSTRAINT_NAMES.filter((name) => name !== 'validator');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
})();

/** A form field constraint the engine fails the deployment on or the script cannot hold; `detail` states which. */
export class UnsupportedFormFieldConstraintError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly fieldId: string;
  declare readonly constraintName: string;
  declare readonly detail: string;

  constructor(
    elementId: string,
    fieldId: string,
    constraintName: string,
    detail: string,
  ) {
    super(
      `The constraint '${constraintName}' on form field '${fieldId}' of '${elementId}' ` +
        `cannot be imported: ${detail}. Operaton registers ` +
        `${REGISTERED_VALIDATOR_NAMES}, and reads a custom validator class ` +
        "or expression off 'validator'; FormValidators.createValidator " +
        'fails the deployment on any other name.',
      { elementId, fieldId, constraintName, detail },
    );
  }
}

/**
 * A flow element kind outside the supported subset, such as
 * `bpmn:adHocSubProcess` or `bpmn:complexGateway`. A supported kind carrying an
 * unrepresentable shape refuses via {@link UnsupportedEventFeatureError} or
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
        'handlers, plain tasks, user tasks, service tasks, send tasks, ' +
        'receive tasks, business rule tasks, script tasks, exclusive ' +
        'gateways, parallel gateways, inclusive gateways, event-based ' +
        'gateways, embedded subprocesses, attempt blocks, call activities, ' +
        'and sequence flows are supported.',
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
        'latest/deployment/version binding, a businessKey, a ' +
        'variableMappingClass or variableMappingDelegateExpression, and ' +
        'in/out mappings using source+target, sourceExpression+target, or ' +
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

/** The triggers that open a handler of their own, which is what a handler start is. */
const HANDLER_START_TRIGGERS = ON_TRIGGERS.filter(
  (word) => TRIGGER_PAYLOAD[word]?.hostless === true,
);

/**
 * Compensation falls out because a boundary compensation trigger refuses
 * earlier, via {@link UnsupportedEventFeatureError}. Cancel is named apart from
 * the list because nothing in the table records that it needs a host that can
 * be given up.
 */
const BOUNDARY_TRIGGERS = ON_TRIGGERS.filter(
  (word) => TRIGGER_PAYLOAD[word]?.boundary === true && word !== 'cancel',
);

/** The default closing sentence: what a handler, a throw, and an emit accept. */
const EVENT_SURFACE_NOTE =
  `Event handlers catch one ${formatPlainWordList(HANDLER_START_TRIGGERS)} ` +
  'trigger on their single start event; throws and emits carry the code or ' +
  'name their kind requires, and compensation carries neither.';

/**
 * A supported event definition kind shaped in a way the DSL surface cannot
 * express. `detail` names the shape; the sentence after it says what to write
 * instead. A refusal outside the handler/throw/emit surface passes its own
 * `remedy`, so the reader is told the move that fixes the document rather than
 * a rule that does not describe it.
 */
export class UnsupportedEventFeatureError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(
    elementId: string,
    detail: string,
    remedy: string = EVENT_SURFACE_NOTE,
  ) {
    super(
      `The event construct at '${elementId}' cannot be imported: ${detail}. ${remedy}`,
      { elementId, detail },
    );
  }
}

/**
 * A repetition the surface cannot express, or one the engine itself refuses to
 * deploy. `detail` names which of the two, and why.
 */
export class UnsupportedLoopCharacteristicsError extends UnsupportedConstructError {
  declare readonly elementId: string;
  /** Moddle `$type`, e.g. `bpmn:MultiInstanceLoopCharacteristics`. */
  declare readonly loopType: string;
  declare readonly detail: string;

  constructor(elementId: string, loopType: string, detail: string) {
    super(`The repetition on '${elementId}' cannot be imported: ${detail}.`, {
      elementId,
      loopType,
      detail,
    });
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
        'its position accepts; a timeout task listener carries exactly one ' +
        'timer, which no other task listener event carries; and an injected ' +
        'field names exactly one value slot, Operaton refusing to deploy one ' +
        'that names none or both of its literal slots.',
      { elementId, detail },
    );
  }
}

/**
 * A user task naming a deployed form in a shape Operaton's
 * `parseFormDefinition` rejects. `detail` names the shape; the message states
 * the rule it broke.
 */
export class UnsupportedFormReferenceError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The form reference on '${elementId}' cannot be imported: ${detail}. ` +
        'Operaton refuses to deploy a user task that names both a form key ' +
        'and a form reference, and one whose form reference has no binding ' +
        'or a binding outside latest, deployment, and version.',
      { elementId, detail },
    );
  }
}

/**
 * A condition Operaton evaluates outside UEL: a sequence flow's
 * `bpmn:conditionExpression`, or a conditional event definition's
 * `bpmn:condition`. Both reach Operaton's `parseConditionExpression`, so
 * `detail` names the same shape either way, a `language` attribute: Operaton
 * builds a `ScriptCondition` from it and runs the body in that language,
 * never as the UEL expression this tool writes.
 */
export class UnsupportedConditionExpressionError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The condition on '${elementId}' cannot be imported: ${detail}. This ` +
        'tool writes a condition as an expression Operaton evaluates as ' +
        'UEL, and a condition Operaton hands to a script engine has no ' +
        'spelling here.',
      { elementId, detail },
    );
  }
}

/** An external task's error mapping the engine fails the deployment on or that names no coded error root; `detail` states which. */
export class UnsupportedErrorMappingError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The error mapping on '${elementId}' cannot be imported: ${detail}. ` +
        "Operaton's parseOperatonErrorEventDefinitions fails the deployment " +
        'on an operaton:errorEventDefinition carrying no expression, and ' +
        'this tool needs its errorRef to name an error root carrying a code.',
      { elementId, detail },
    );
  }
}

/** A user task's BPMN resource assignment in a shape Operaton refuses to deploy; `detail` states which. */
export class UnsupportedAssignmentError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The assignment on '${elementId}' cannot be imported: ${detail}. ` +
        'Operaton refuses to deploy a user task carrying a ' +
        'bpmn:humanPerformer beside operaton:assignee ' +
        '(BpmnParse.parseUserTaskCustomExtensions) or more than one ' +
        'bpmn:humanPerformer (parseHumanPerformer).',
      { elementId, detail },
    );
  }
}

/** `bpmn:TimerEventDefinition` -> `timer`. */
function friendlyEventDefinition(definitionType: string): string {
  const local = definitionType.replace(/^.*:/, '');
  return local.replace(/EventDefinition$/, '').toLowerCase() || 'special';
}

function supportedKindsMessage(
  eventKind:
    'start' | 'end' | 'intermediate throw' | 'intermediate catch' | 'boundary',
): string {
  switch (eventKind) {
    case 'start':
      return (
        "A plain start event carries no definition; a process's start " +
        `supports ${formatPlainWordList(START_TRIGGERS)}, and an event ` +
        `handler's start supports ${formatPlainWordList(HANDLER_START_TRIGGERS)}.`
      );
    case 'end':
      return (
        'A typed end event supports terminate, error, escalation, message, ' +
        'signal, or compensation, plus cancel inside a block that can be ' +
        'given up.'
      );
    case 'intermediate throw':
      return `An emit supports ${formatPlainWordList(EMIT_TRIGGERS)}.`;
    case 'intermediate catch':
      return `An await supports ${formatPlainWordList(CATCH_TRIGGERS)}.`;
    case 'boundary':
      return (
        `A boundary event supports ${formatPlainWordList(BOUNDARY_TRIGGERS)}, ` +
        'plus cancel on a block that can be given up.'
      );
  }
}
