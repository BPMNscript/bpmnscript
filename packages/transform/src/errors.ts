/**
 * Refusals raised by `xmlToIr` (content the IR cannot express; lossless drops
 * warn instead), plus {@link LayoutError} from `irToXml`.
 */

import {
  BOUNDARY_TRIGGERS,
  diagnosticText,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  FORM_CONSTRAINT_NAMES,
  formatPlainWordList,
  HANDLER_START_TRIGGERS,
  START_TRIGGERS,
  THROW_TRIGGERS,
} from '@bpmn-script/language';

/**
 * A message is a headline naming what is wrong and where, then one
 * `note: ...` or `help: ...` line per further fact. `detail` fields hold only
 * the short cause the headline quotes, so they stay stable keys to group by.
 *
 * Subclasses `declare` their fields so class field initializers cannot
 * overwrite what `Object.assign` wrote after `super()`.
 */
export abstract class UnsupportedConstructError extends Error {
  constructor(
    headline: string,
    lines: readonly string[],
    detail: Record<string, unknown>,
  ) {
    super(diagnosticText(headline, ...lines));
    this.name = new.target.name;
    Object.assign(this, detail);
  }
}

/**
 * Input that cannot be read as a BPMN document at all, such as XML that does
 * not parse or a flow whose end names nothing: a host reports it as bad input,
 * while any other exception from `xmlToIr` is a bug.
 */
export class MalformedDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedDocumentError';
  }
}

/**
 * Keeps a quoted value on its headline or note line, and its whitespace
 * visible: it is often why the value is reported.
 */
export function oneLine(text: string): string {
  return text.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function quotedList(words: readonly string[], conjunction: 'and' | 'or') {
  return formatPlainWordList(
    words.map((word) => `'${word}'`),
    conjunction,
  );
}

const SERVICE_TASK_FORMS = [
  [
    'a Java class',
    "'operaton:class' (or the deprecated 'camunda:class' alias)",
  ],
  ['an expression', "'operaton:expression'"],
  ['a delegate expression', "'operaton:delegateExpression'"],
  [
    'an external task topic',
    `'operaton:type="external"' with 'operaton:topic'`,
  ],
  [
    'a built-in mail or shell task with its fields',
    `'operaton:type="mail"' or 'operaton:type="shell"' with their 'operaton:field' children`,
  ],
  ['a decision reference on a business rule task', "'operaton:decisionRef'"],
] as const;

export const SERVICE_TASK_FORM_ATTRIBUTES = formatPlainWordList(
  SERVICE_TASK_FORMS.map(([, attributes]) => attributes),
  'and',
);

function formLines(
  forms: readonly (readonly [prose: string, attributes: string])[],
): readonly string[] {
  return [
    `note: the supported forms are ${formatPlainWordList(forms.map(([prose]) => prose))}`,
    `note: their attributes are ${formatPlainWordList(
      forms.map(([, attributes]) => attributes),
      'and',
    )}`,
  ];
}

/** Closes a refusal of the execution form itself, not of a setting beside it. */
export const SERVICE_TASK_FORM_LINES = formLines(SERVICE_TASK_FORMS);

/** A thrown message takes the code and external forms, the first four rows. */
export const THROWN_MESSAGE_FORM_LINES = formLines(
  SERVICE_TASK_FORMS.slice(0, 4),
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
    ...notes: string[]
  ) {
    super(
      `${subject.toLowerCase()} '${serviceTaskId}' uses an unsupported execution form: ${construct}`,
      notes,
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
      `form field '${fieldId}' on '${elementId}' has the unsupported type '${fieldType}'`,
      [
        `note: the supported form field types are ${quotedList(['string', 'long', 'boolean', 'date', 'enum'], 'and')}`,
      ],
      { elementId, fieldId, fieldType },
    );
  }
}

const REGISTERED_VALIDATOR_NAMES = quotedList(
  FORM_CONSTRAINT_NAMES.filter((name) => name !== 'validator'),
  'and',
);

/** Closes a refusal of the constraint's name, not of its config or count. */
export const FORM_CONSTRAINT_NAME_LINES: readonly string[] = [
  `note: Operaton registers ${REGISTERED_VALIDATOR_NAMES}, and reads a custom validator class or expression off 'validator'`,
  "note: 'FormValidators.createValidator' fails the deployment on any other name",
];

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
    ...notes: string[]
  ) {
    super(
      `constraint '${constraintName}' on form field '${fieldId}' of '${elementId}' cannot be imported: ${detail}`,
      notes,
      { elementId, fieldId, constraintName, detail },
    );
  }
}

export const SUPPORTED_KINDS_MESSAGE =
  'note: BPMNscript imports start and end events, throws, emits, boundary ' +
  'events, event handlers, plain tasks, user tasks, service tasks, send ' +
  'tasks, receive tasks, business rule tasks, script tasks, exclusive ' +
  'gateways, parallel gateways, inclusive gateways, event-based gateways, ' +
  'embedded subprocesses, attempt blocks, call activities and sequence flows';

export class UnsupportedElementError extends UnsupportedConstructError {
  declare readonly qname: string;
  declare readonly elementId?: string;

  constructor(qname: string, elementId?: string) {
    super(
      (elementId ? `element '${elementId}' ` : 'an element ') +
        `of the kind '${qname}' cannot be imported`,
      [SUPPORTED_KINDS_MESSAGE],
      { qname, elementId },
    );
  }
}

export const PLAIN_NAME_NOTE =
  "note: a plain name is letters, digits and '_', with '-' between them, and no keyword";

/**
 * The engine reads and writes a variable under its exact name, and the script
 * writes one only as a plain name, with no backtick form.
 */
export class UnsupportedVariableNameError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly attribute: string;
  declare readonly variableName: string;
  declare readonly detail: string;

  constructor(elementId: string, attribute: string, variableName: string) {
    const detail = `${attribute} names the variable '${oneLine(variableName)}', which BPMNscript cannot write back unchanged`;
    super(
      `element '${elementId}' cannot be imported: ${detail}`,
      [
        'note: BPMNscript writes a variable as a plain name, and this name is not one',
        PLAIN_NAME_NOTE,
      ],
      { elementId, attribute, variableName, detail },
    );
  }
}

export class UnsupportedCallActivityError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string, ...notes: string[]) {
    super(
      `call activity '${elementId}' cannot be imported: ${detail}`,
      [
        ...notes,
        "note: a supported call activity names a 'calledElement', an optional " +
          "'latest', 'deployment' or 'version' binding, a 'businessKey', a " +
          "'variableMappingClass' or 'variableMappingDelegateExpression', and " +
          "in and out mappings using 'source' with 'target', " +
          `'sourceExpression' with 'target', or 'variables="all"'`,
      ],
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
      `${eventKind} event '${elementId}' carries an unsupported ` +
        `${friendlyEventDefinition(definitionType)} definition '${definitionType}'`,
      supportedKindsLines(eventKind),
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

export const HANDLER_TRIGGER_NOTE = `note: an event handler catches one ${quotedList(HANDLER_START_TRIGGERS, 'or')} trigger on its single start event`;

export const THROW_CODE_NOTE =
  'note: throws and emits carry the code or name their kind requires, and compensation carries neither';

export class UnsupportedEventFeatureError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string, ...lines: string[]) {
    super(`element '${elementId}' cannot be imported: ${detail}`, lines, {
      elementId,
      detail,
    });
  }
}

export class UnsupportedLoopCharacteristicsError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly loopType: string;
  declare readonly detail: string;

  constructor(
    elementId: string,
    loopType: string,
    detail: string,
    ...notes: string[]
  ) {
    super(`repetition on '${elementId}' cannot be imported: ${detail}`, notes, {
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
      `the file contains ${detail}`,
      [
        'note: BPMNscript imports one process',
        "note: 'BpmnParse.parseProcessDefinitions' deploys each of them",
      ],
      { detail },
    );
  }
}

export class UnsupportedDocumentError extends UnsupportedConstructError {
  declare readonly detail: string;

  constructor(detail: string, ...notes: string[]) {
    super(`the document cannot be imported: ${detail}`, notes, { detail });
  }
}

export class UnsupportedExtensionFormError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string, ...notes: string[]) {
    super(
      `the Operaton extension content on '${elementId}' cannot be imported: ${detail}`,
      notes,
      { elementId, detail },
    );
  }
}

export class UnsupportedFormReferenceError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string, ...notes: string[]) {
    super(
      `form reference on '${elementId}' cannot be imported: ${detail}`,
      notes,
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

  constructor(elementId: string, detail: string, ...notes: string[]) {
    super(
      `condition on '${elementId}' cannot be imported: ${detail}`,
      [
        ...notes,
        "note: BPMNscript writes a condition as a 'tFormalExpression', which " +
          'Operaton evaluates as UEL',
        'note: a condition of another type, or one Operaton hands to a script ' +
          'engine, has no spelling in BPMNscript',
      ],
      { elementId, detail },
    );
  }
}

/** `detail` is the engine's own wording, so the refusal reads as the deployment error would. */
export class UnsupportedGatewayShapeError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string) {
    super(
      `exclusive gateway '${elementId}' cannot be imported`,
      [
        "note: Operaton's 'BpmnParse.validateExclusiveGateway' fails the " +
          `deployment with "${detail}"`,
        'note: no running process exists to write back',
        'help: give every route but the fallback a condition, and name the ' +
          "fallback in the gateway's 'default'",
      ],
      { elementId, detail },
    );
  }
}

export class UnsupportedErrorMappingError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string, ...notes: string[]) {
    super(
      `error mapping on '${elementId}' cannot be imported: ${detail}`,
      notes,
      { elementId, detail },
    );
  }
}

export class UnsupportedAssignmentError extends UnsupportedConstructError {
  declare readonly elementId: string;
  declare readonly detail: string;

  constructor(elementId: string, detail: string, ...notes: string[]) {
    super(`assignment on '${elementId}' cannot be imported: ${detail}`, notes, {
      elementId,
      detail,
    });
  }
}

function friendlyEventDefinition(definitionType: string): string {
  const local = definitionType.replace(/^.*:/, '');
  return local.replace(/EventDefinition$/, '').toLowerCase() || 'special';
}

function supportedKindsLines(eventKind: EventPosition): string[] {
  switch (eventKind) {
    case 'start':
      return [
        'note: a plain start event carries no definition',
        `note: a process's start supports ${quotedList(START_TRIGGERS, 'or')}`,
        `note: an event handler's start supports ${quotedList(HANDLER_START_TRIGGERS, 'or')}`,
      ];
    case 'end':
      return [
        `note: a typed end event supports ${quotedList(END_EVENT_TRIGGERS, 'or')}, ` +
          "plus 'cancel' inside a block that can be given up",
      ];
    case 'intermediate throw':
      return [`note: an emit supports ${quotedList(EMIT_TRIGGERS, 'or')}`];
    case 'boundary':
      return [
        `note: a boundary event supports ${quotedList(BOUNDARY_TRIGGERS_BUT_CANCEL, 'or')}, ` +
          "plus 'cancel' on a block that can be given up",
      ];
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
    super(`'bpmn-auto-layout' failed to lay out the process: ${causeMessage}`);
    this.name = 'LayoutError';
    this.xml = xml;
  }
}
