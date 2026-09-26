/**
 * Refusals raised by `xmlToIr` (content the IR cannot express; lossless drops
 * warn instead), plus {@link LayoutError} from `irToXml`.
 */

import {
  BOUNDARY_TRIGGERS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  FORM_CONSTRAINT_NAMES,
  formatPlainWordList,
  HANDLER_START_TRIGGERS,
  START_TRIGGERS,
  THROW_TRIGGERS,
} from '@bpmn-script/language';

/**
 * Subclasses `declare` their fields so class field initializers cannot
 * overwrite what `Object.assign` wrote after `super()`.
 */
export abstract class UnsupportedConstructError extends Error {
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, detail);
  }
}

const SERVICE_TASK_FORMS = [
  ['a Java class', 'operaton:class (or the deprecated camunda:class alias)'],
  ['an expression', 'operaton:expression'],
  ['a delegate expression', 'operaton:delegateExpression'],
  ['an external task topic', 'operaton:type="external" with operaton:topic'],
  [
    'a built-in mail or shell task with its fields',
    'operaton:type="mail" or "shell" with their operaton:field children',
  ],
  ['a decision reference on a business rule task', 'operaton:decisionRef'],
] as const;

export const SERVICE_TASK_FORM_ATTRIBUTES = formatPlainWordList(
  SERVICE_TASK_FORMS.map(([, attributes]) => attributes),
  'and',
);

/**
 * Operaton applies the same mandatory-discriminator rule to every tag its
 * service-task factory runs, so `subject` names which one refused.
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
        `Supported forms are ${formatPlainWordList(SERVICE_TASK_FORMS.map(([prose]) => prose))}.`,
      { serviceTaskId, construct, subject },
    );
  }
}

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

const REGISTERED_VALIDATOR_NAMES = formatPlainWordList(
  FORM_CONSTRAINT_NAMES.filter((name) => name !== 'validator'),
  'and',
);

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

export const SUPPORTED_KINDS_MESSAGE =
  'Only start/end events, throws, emits, boundary events, event ' +
  'handlers, plain tasks, user tasks, service tasks, send tasks, ' +
  'receive tasks, business rule tasks, script tasks, exclusive ' +
  'gateways, parallel gateways, inclusive gateways, event-based ' +
  'gateways, embedded subprocesses, attempt blocks, call activities, ' +
  'and sequence flows are supported.';

export class UnsupportedElementError extends UnsupportedConstructError {
  declare readonly qname: string;
  declare readonly elementId?: string;

  constructor(qname: string, elementId?: string) {
    super(
      `The BPMN element ${qname}` +
        (elementId ? ` (id='${elementId}')` : '') +
        ` is a kind that this tool cannot import. ${SUPPORTED_KINDS_MESSAGE}`,
      { qname, elementId },
    );
  }
}

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

type EventPosition = 'start' | 'end' | 'intermediate throw' | 'boundary';

export class UnsupportedEventDefinitionError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly eventKind: EventPosition;
  declare readonly definitionType: string;

  constructor(
    elementId: string,
    eventKind: EventPosition,
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
 * Compensation refuses earlier. Cancel is named apart since the trigger table
 * does not record that it needs a cancellable host.
 */
const BOUNDARY_TRIGGERS_BUT_CANCEL = BOUNDARY_TRIGGERS.filter(
  (word) => word !== 'cancel',
);

const END_EVENT_TRIGGERS = [
  ...END_TRIGGERS.filter((word) => word !== 'cancel'),
  ...THROW_TRIGGERS,
];

const EVENT_SURFACE_NOTE =
  `Event handlers catch one ${formatPlainWordList(HANDLER_START_TRIGGERS)} ` +
  'trigger on their single start event; throws and emits carry the code or ' +
  'name their kind requires, and compensation carries neither.';

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

export class UnsupportedLoopCharacteristicsError extends UnsupportedConstructError {
  declare readonly elementId: string;
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

/**
 * Operaton deploys every executable process and the IR holds one. Pools and
 * message flows are diagram data to the engine and only warn.
 */
export class UnsupportedCollaborationError extends UnsupportedConstructError {
  declare readonly detail: string;

  constructor(detail: string) {
    super(
      `The file contains ${detail}; this tool imports one process, and ` +
        '`BpmnParse.parseProcessDefinitions` deploys each of them.',
      { detail },
    );
  }
}

export class UnsupportedDocumentError extends UnsupportedConstructError {
  declare readonly detail: string;

  constructor(detail: string) {
    super(`The document cannot be imported: ${detail}.`, { detail });
  }
}

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
 * `parseConditionExpression` runs a condition with a `language` attribute as a
 * script, not UEL, and refuses an `xsi:type` other than `tFormalExpression`.
 */
export class UnsupportedConditionExpressionError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The condition on '${elementId}' cannot be imported: ${detail}. This ` +
        'tool writes a condition as a tFormalExpression Operaton evaluates ' +
        'as UEL; a condition of another type, or one Operaton hands to a ' +
        'script engine, has no spelling here.',
      { elementId, detail },
    );
  }
}

/** `detail` is the engine's own sentence, so the refusal reads as the deployment error would. */
export class UnsupportedGatewayShapeError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `The exclusive gateway '${elementId}' cannot be imported: ${detail} ` +
        "Operaton's BpmnParse.validateExclusiveGateway fails the deployment " +
        'on this shape, so there is nothing that runs to write back; give ' +
        'every route but the fallback a condition, and name the fallback ' +
        "in the gateway's 'default'.",
      { elementId, detail },
    );
  }
}

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

function friendlyEventDefinition(definitionType: string): string {
  const local = definitionType.replace(/^.*:/, '');
  return local.replace(/EventDefinition$/, '').toLowerCase() || 'special';
}

function supportedKindsMessage(eventKind: EventPosition): string {
  switch (eventKind) {
    case 'start':
      return (
        "A plain start event carries no definition; a process's start " +
        `supports ${formatPlainWordList(START_TRIGGERS)}, and an event ` +
        `handler's start supports ${formatPlainWordList(HANDLER_START_TRIGGERS)}.`
      );
    case 'end':
      return (
        `A typed end event supports ${formatPlainWordList(END_EVENT_TRIGGERS)}, ` +
        'plus cancel inside a block that can be given up.'
      );
    case 'intermediate throw':
      return `An emit supports ${formatPlainWordList(EMIT_TRIGGERS)}.`;
    case 'boundary':
      return (
        `A boundary event supports ${formatPlainWordList(BOUNDARY_TRIGGERS_BUT_CANCEL)}, ` +
        'plus cancel on a block that can be given up.'
      );
  }
}

/**
 * `bpmn-auto-layout` throws on some valid flow shapes. `xml` is the document
 * without `bpmndi:`, which Operaton deploys the same, as a fallback.
 */
export class LayoutError extends Error {
  readonly xml: string;

  constructor(xml: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`bpmn-auto-layout failed to lay out the process: ${causeMessage}`);
    this.name = 'LayoutError';
    this.xml = xml;
  }
}
