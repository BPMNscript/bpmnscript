/**
 * BPMN 2.0 XML to IR, the inverse of `irToXml`. Diagram interchange is dropped
 * (ADR 0003: the IR holds semantics only). Content the IR cannot express throws
 * an `UnsupportedConstructError` subclass before any IR exists; content it does
 * not carry comes back in `warnings`. See ADR 0014, Honest BPMN Import.
 */

import {
  BUILTIN_FIELD_NAMES,
  BUILTIN_FIELD_VALIDATOR,
  BUILTIN_REQUIRED_FIELDS,
  CATCH_TRIGGERS,
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  EXECUTION_LISTENER_EVENTS,
  EXPRESSION_ANYWHERE,
  EXPRESSION_OPEN,
  FORM_BOUND_TEXT,
  FORM_CONSTRAINT_TYPES,
  formatPlainWordList,
  formatWordList,
  scriptFormatOf,
  SHELL_FLAG_FIELDS,
  SHELL_FLAG_LITERALS,
  isFormConstraintName,
  ON_TRIGGERS,
  START_TRIGGERS,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
  TYPE_BINDING_VALUES,
  USER_TASK_VERBATIM_KEYS,
} from '@bpmn-script/language';
import type { BuiltinTaskType, TimerKind } from '@bpmn-script/language';
import { Parser } from 'saxen';
import type {
  BoundaryEvent,
  BpmnProcess,
  CallActivity,
  CallVariableMapper,
  CallVariableMapping,
  EmitEventDefinition,
  EndEvent,
  EndEventDefinition,
  EngineAttributes,
  ErrorMapping,
  EventBasedGateway,
  EventDefinition,
  ExclusiveGateway,
  ExecutionListener,
  ExtensionProperty,
  FieldInjection,
  FlowElement,
  FormField,
  FormFieldConstraint,
  FormFieldType,
  FormFieldValue,
  InclusiveGateway,
  IntermediateCatchEvent,
  IntermediateThrowEvent,
  IoMapped,
  IoParameter,
  IoValue,
  JobSettings,
  ListenerBinding,
  LoopCharacteristics,
  Named,
  ParallelGateway,
  ReceiveTask,
  ScriptTask,
  ScriptValue,
  SequenceFlow,
  ServiceTask,
  ServiceTaskBinding,
  StartEvent,
  SubProcess,
  Task,
  TaskListener,
  TimerJobKey,
  UserTask,
  VersionBinding,
} from './ir/types.js';
import {
  carriesFields,
  eventIdentities,
  ioMapped,
  jobSettings,
  splitTimerJobSettings,
} from './ir/types.js';

import {
  UnsupportedAssignmentError,
  UnsupportedCallActivityError,
  UnsupportedCollaborationError,
  UnsupportedConditionExpressionError,
  UnsupportedConstructError,
  UnsupportedDocumentError,
  UnsupportedElementError,
  UnsupportedErrorMappingError,
  UnsupportedEventDefinitionError,
  UnsupportedEventFeatureError,
  UnsupportedExtensionFormError,
  UnsupportedFormFieldConstraintError,
  UnsupportedFormFieldTypeError,
  UnsupportedFormReferenceError,
  UnsupportedGatewayShapeError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedServiceTaskFormError,
} from './errors.js';
import { humanize } from './humanize.js';
import {
  BARE_CARDINALITY,
  BARE_ELEMENT_VARIABLE,
  INDENT,
  irToDsl,
  isElidedOnPrint,
  type PrintContainer,
} from './ir-to-dsl.js';
import { parseJuel } from './juel.js';
import {
  conditionLabel,
  createModdle,
  EVENT_DEFINITION_TAG,
  FORM_FIELD_TYPE_TO_OPERATON,
  HISTORY_TIME_TO_LIVE,
  IMPLEMENTATION_ATTRS,
  SERVICE_TASK_LIKE_TAG,
  SUB_PROCESS_LIKE_TAG,
  TIMER_KIND_TO_CHILD,
  VARIABLE_MAPPING_ATTR_BY_KIND,
} from './ir-to-xml.js';
import {
  claimDeclarationName,
  isWritableName,
  makeEventSubProcessId,
  makeStartEventId,
} from './synthesize-ids.js';

export type ImportWarningCategory =
  | 'extensionAttribute'
  | 'lane'
  | 'label'
  | 'unreferencedRoot'
  | 'documentation'
  | 'unmappedConstruct';

/** A non-fatal notice that `xmlToIr` dropped content. Refusals throw instead. */
export interface ImportWarning {
  elementId: string;
  category: ImportWarningCategory;
  message: string;
}

const SERVICE_TASK_LIKE_OWNERS: readonly string[] = Object.values(
  SERVICE_TASK_LIKE_TAG,
);

/** The `bpmn:Activity` subtypes this tool maps; every sweep that asks about an activity reads this one list. */
const ACTIVITY_TAGS: readonly string[] = [
  'bpmn:Task',
  'bpmn:ManualTask',
  'bpmn:UserTask',
  ...SERVICE_TASK_LIKE_OWNERS,
  'bpmn:ReceiveTask',
  'bpmn:ScriptTask',
  ...Object.values(SUB_PROCESS_LIKE_TAG),
  'bpmn:CallActivity',
];

/** The `$type`s whose IR node carries execution listeners beside the job settings; a gateway takes the settings alone. */
const ENGINE_ATTRIBUTE_OWNERS: readonly string[] = [
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:IntermediateThrowEvent',
  'bpmn:IntermediateCatchEvent',
  'bpmn:BoundaryEvent',
  ...ACTIVITY_TAGS,
];

const GATEWAY_TAGS: readonly string[] = [
  'bpmn:ExclusiveGateway',
  'bpmn:InclusiveGateway',
  'bpmn:ParallelGateway',
  'bpmn:EventBasedGateway',
];

const MULTI_INSTANCE = 'bpmn:MultiInstanceLoopCharacteristics';

/**
 * The `$type`s whose IR node carries the job settings. The repetition element
 * carries all but the priority, which no engine method reads off it
 * ({@link sweepRepetition} reports it).
 */
const JOB_SETTING_OWNERS: readonly string[] = [
  ...ENGINE_ATTRIBUTE_OWNERS,
  ...GATEWAY_TAGS,
  MULTI_INSTANCE,
];

/**
 * `BpmnParse.parseIntermediateThrowEvent` and `parseEndEvents` hand
 * `parseServiceTaskLike` the message definition as the element to read, so a
 * thrown message carries every implementation attribute a service task does.
 * The catch side carries the same element type and honors none of it
 * ({@link warnCatchSideImplementationAttrs}).
 */
const IMPLEMENTATION_OWNERS = [
  ...SERVICE_TASK_LIKE_OWNERS,
  'bpmn:MessageEventDefinition',
] as const;

/** What `parseServiceTaskLike` reads off the element beside the implementation. */
const IMPLEMENTATION_EXTRA_ATTRS = [
  'taskPriority',
  'resultVariable',
  'resultVariableName',
] as const;

/** The extension children the same reader takes off the element. */
const IMPLEMENTATION_EXTRA_CHILDREN: readonly string[] = [
  'operaton:Field',
  'operaton:ErrorEventDefinition',
];

/**
 * `parseExternalServiceTask` reads `operaton:properties` off the event element
 * of a thrown message, so the block is marked read on both tags and reported
 * by hand on every other shape ({@link readThrowEventAttributes}).
 */
const THROW_EVENT_TAGS: readonly string[] = [
  'bpmn:IntermediateThrowEvent',
  'bpmn:EndEvent',
];

type ConsumptionRow = readonly [string, readonly string[]];

function consumptionTable(
  entries: readonly ConsumptionRow[],
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(entries.map(([name, owners]) => [name, new Set(owners)]));
}

function ownedRows(
  names: readonly string[],
  owners: readonly string[],
): ConsumptionRow[] {
  return names.map((name): ConsumptionRow => [name, owners]);
}

/**
 * Extension-attribute local names read into the IR, per owning `$type`:
 * `assignee` is data on a user task and unread decoration on a service task.
 * A row silences the sweep for every shape of its owner, so a name read on
 * one shape only (a throw, the process's own start, a link) is reported by
 * hand where it is read: {@link warnThrowSideBindingAttrs},
 * {@link sweepRepetition}, {@link warnLinkThrowEngineSettings},
 * {@link readThrownMessageBinding}, {@link warnCatchSideImplementationAttrs},
 * {@link readThrowEventAttributes}.
 */
const CONSUMED_EXTENSION_ATTRS = consumptionTable([
  ['asyncBefore', JOB_SETTING_OWNERS],
  ['async', JOB_SETTING_OWNERS],
  ['asyncAfter', JOB_SETTING_OWNERS],
  ['exclusive', [...JOB_SETTING_OWNERS, 'bpmn:TimerEventDefinition']],
  ['jobPriority', JOB_SETTING_OWNERS],
  ...ownedRows(
    [...USER_TASK_VERBATIM_KEYS, 'formRef', 'formRefBinding', 'formRefVersion'],
    ['bpmn:UserTask'],
  ),
  ...ownedRows(IMPLEMENTATION_ATTRS, IMPLEMENTATION_OWNERS),
  ['taskPriority', IMPLEMENTATION_OWNERS],
  ['resultVariable', [...IMPLEMENTATION_OWNERS, 'bpmn:ScriptTask']],
  ['resultVariableName', [...IMPLEMENTATION_OWNERS, 'bpmn:ScriptTask']],
  ['decisionRef', ['bpmn:BusinessRuleTask']],
  ['decisionRefBinding', ['bpmn:BusinessRuleTask']],
  ['decisionRefVersion', ['bpmn:BusinessRuleTask']],
  ['decisionRefTenantId', ['bpmn:BusinessRuleTask']],
  ['mapDecisionResult', ['bpmn:BusinessRuleTask']],
  ['calledElementBinding', ['bpmn:CallActivity']],
  ['calledElementVersion', ['bpmn:CallActivity']],
  ...ownedRows(Object.values(VARIABLE_MAPPING_ATTR_BY_KIND), [
    'bpmn:CallActivity',
  ]),
  ['collection', [MULTI_INSTANCE]],
  ['elementVariable', [MULTI_INSTANCE]],
  ['versionTag', ['bpmn:Process']],
  ['historyTimeToLive', ['bpmn:Process']],
  ['candidateStarterUsers', ['bpmn:Process']],
  ['candidateStarterGroups', ['bpmn:Process']],
  ['initiator', ['bpmn:StartEvent']],
  ['errorCodeVariable', ['bpmn:ErrorEventDefinition']],
  ['errorMessageVariable', ['bpmn:ErrorEventDefinition']],
  ['escalationCodeVariable', ['bpmn:EscalationEventDefinition']],
  ['errorMessage', ['bpmn:Error']],
]);

const CONSUMED_EXTENSION_ELEMENTS = consumptionTable([
  ['operaton:FormData', ['bpmn:StartEvent', 'bpmn:UserTask']],
  ['operaton:FailedJobRetryTimeCycle', JOB_SETTING_OWNERS],
  ['operaton:In', ['bpmn:CallActivity']],
  ['operaton:Out', ['bpmn:CallActivity']],
  // The none throw imports as a step and carries the mapping; the throws
  // with a definition report it by hand ({@link mapIntermediateThrowEvent}).
  ['operaton:InputOutput', [...ACTIVITY_TAGS, 'bpmn:IntermediateThrowEvent']],
  ['operaton:ExecutionListener', ENGINE_ATTRIBUTE_OWNERS],
  ['operaton:TaskListener', ['bpmn:UserTask']],
  ['operaton:Field', IMPLEMENTATION_OWNERS],
  ['operaton:Properties', [...SERVICE_TASK_LIKE_OWNERS, ...THROW_EVENT_TAGS]],
  ['operaton:ErrorEventDefinition', IMPLEMENTATION_OWNERS],
  ['operaton:PotentialStarter', ['bpmn:Process']],
]);

/**
 * Per extension element the IR reads, the attribute local names its reader
 * reads off it. A `$type` missing here is never swept by
 * {@link warnUnreadChildAttrs}: a child no reader reads is reported whole.
 *
 * A key is the path of resolved keys down from `bpmn:ExtensionElements`,
 * falling back to the bare `$type` at each step, and a qualified row wins over
 * the bare one; that is how a task's `operaton:property` is keyed by `name`
 * (`BpmnParseUtil.parseOperatonExtensionProperties`) where a form field's is
 * keyed by `id` (`DefaultFormHandler.parseProperties`).
 */
const CONSUMED_CHILD_ATTRS = consumptionTable([
  ['operaton:FormData', []],
  ['operaton:PotentialStarter', []],
  [
    'operaton:FormField',
    ['id', 'label', 'type', 'defaultValue', 'datePattern'],
  ],
  ['operaton:FormField/operaton:Value', ['id', 'name']],
  ['operaton:Properties', []],
  ['operaton:Property', ['id', 'value']],
  ['bpmn:ExtensionElements/operaton:Properties', []],
  [
    'bpmn:ExtensionElements/operaton:Properties/operaton:Property',
    ['name', 'value'],
  ],
  [
    'operaton:ErrorEventDefinition',
    [
      'id',
      'errorRef',
      'expression',
      'errorCodeVariable',
      'errorMessageVariable',
    ],
  ],
  ['operaton:Validation', []],
  ['operaton:Constraint', ['name', 'config']],
  ['operaton:FailedJobRetryTimeCycle', []],
  [
    'operaton:In',
    [
      'source',
      'sourceExpression',
      'variables',
      'target',
      'businessKey',
      'local',
    ],
  ],
  [
    'operaton:Out',
    ['source', 'sourceExpression', 'variables', 'target', 'local'],
  ],
  ['operaton:InputOutput', []],
  ['operaton:InputParameter', ['name']],
  ['operaton:OutputParameter', ['name']],
  ['operaton:List', []],
  ['operaton:Map', []],
  ['operaton:Entry', ['key']],
  ['operaton:Value', []],
  ['operaton:Script', ['scriptFormat', 'resource']],
  [
    'operaton:ExecutionListener',
    ['event', 'class', 'expression', 'delegateExpression'],
  ],
  // `id` keys a timeout listener's timer job (`BpmnParse.parseTimeoutTaskListener`)
  // and the export mints one, so the one read drops without a word.
  [
    'operaton:TaskListener',
    ['id', 'event', 'class', 'expression', 'delegateExpression'],
  ],
  ['operaton:Field', ['name', 'stringValue']],
]);

/** Tried in this order; the first one a child's reader reads names the child in a warning. */
const CHILD_IDENTITY_ATTRS = [
  'name',
  'key',
  'event',
  'id',
  'source',
  'sourceExpression',
] as const;

function isConsumedHere(
  table: ReadonlyMap<string, ReadonlySet<string>>,
  ownerType: string,
  name: string,
): boolean {
  return table.get(name)?.has(ownerType) === true;
}

/** The reverse of a map the export direction owns, so the pair is spelled once. */
function invert<K extends string, V extends string>(
  map: Readonly<Record<K, V>>,
): Readonly<Record<V, K>> {
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [value, key]),
  ) as Record<V, K>;
}

/** `operaton:formField` types the DSL can express. */
const OPERATON_TO_FORM_FIELD_TYPE: Readonly<Record<string, FormFieldType>> =
  invert(FORM_FIELD_TYPE_TO_OPERATON);

/**
 * What Operaton reads off an owner kind whose IR node has no slot for it,
 * keyed `<owner $type>/<attribute local name or child $type>`, each with the
 * clause naming the reader; a name absent here is one no engine method reads
 * on that owner. A `throw:` or `initial:` prefix matches only a drop swept
 * under that qualifier: `parseSignalEventDefinition` reads `async` and
 * `operaton:in` with `isThrowing=true` alone, and `parseStartFormHandlers`
 * runs for the process's own start alone, so the bare key would claim a read
 * the engine never makes on a catch or a nested start.
 */
const ENGINE_READS_ELSEWHERE: ReadonlyMap<string, string> = new Map<
  string,
  string
>([
  [
    'throw:bpmn:SignalEventDefinition/async',
    'reads it on a thrown signal as its async delivery ' +
      '(BpmnParse.parseSignalEventDefinition)',
  ],
  [
    'throw:bpmn:SignalEventDefinition/operaton:In',
    'reads it on a thrown signal as its payload ' +
      '(BpmnParse.parseSignalEventDefinition through parseInputParameter)',
  ],
  ...[
    'formKey',
    'formRef',
    'formRefBinding',
    'formRefVersion',
    'formHandlerClass',
  ].map((name): [string, string] => [
    `initial:bpmn:StartEvent/${name}`,
    "reads it on the process's own start (BpmnParse.parseStartFormHandlers)",
  ]),
  ...['jobPriority', 'taskPriority'].map((name): [string, string] => [
    `bpmn:Process/${name}`,
    'reads it (BpmnParse.parseProcess through parsePriority)',
  ]),
  [
    'bpmn:Process/isStartableInTasklist',
    'reads it (BpmnParse.parseProcess through isStartable)',
  ],
  [
    'bpmn:Process/operaton:ExecutionListener',
    'runs it on the process instance ' +
      '(BpmnParse.parseExecutionListenersOnScope)',
  ],
  [
    'bpmn:SequenceFlow/operaton:ExecutionListener',
    'runs it when the flow is taken, whatever its event says ' +
      '(BpmnParse.parseExecutionListenersOnTransition)',
  ],
  ...GATEWAY_TAGS.map((tag): [string, string] => [
    `${tag}/operaton:ExecutionListener`,
    'runs it (BpmnParse.parseExecutionListenersOnScope)',
  ]),
  [
    'bpmn:IntermediateThrowEvent/operaton:InputOutput',
    'reads it on every throw but a link (BpmnParse.parseActivityInputOutput)',
  ],
  [
    'bpmn:IntermediateCatchEvent/operaton:InputOutput',
    'reads it (BpmnParse.parseActivityInputOutput)',
  ],
  [
    'bpmn:EndEvent/operaton:InputOutput',
    'reads its input parameters (BpmnParse.parseActivityInputOutput)',
  ],
]);

const IMPORTED_FLOW_NOTE =
  '(this tool imports the executable flow and the engine settings on its ' +
  'steps, and nothing declared or drawn beside it).';

/** Loose moddle-element type: the tiny surface every moddle node shares. */
interface ModdleElement {
  readonly $type: string;
  readonly id?: string;
  readonly $attrs: Record<string, string | undefined>;
  readonly $descriptor?: {
    readonly properties?: readonly ModdlePropertyDescriptor[];
  };
  get(name: string): unknown;
}

/** A moddle descriptor property: `name` is the storage key, `ns.name` the form `get()` accepts. */
interface ModdlePropertyDescriptor {
  readonly name: string;
  readonly isAttr?: boolean;
  readonly isBody?: boolean;
  /** A back-reference moddle fills in from the other end, not content of its own. */
  readonly isReference?: boolean;
  readonly ns?: {
    readonly name: string;
    readonly prefix?: string;
    readonly localName: string;
  };
}

/**
 * The text of a reference moddle dropped for naming no element in the
 * document, per element and property, since Operaton reads some of them as a
 * variable name. Keyed by the parsed element, so two documents in flight
 * cannot see each other's.
 */
const UNRESOLVED_REFS = new WeakMap<ModdleElement, Map<string, string>>();

function recordUnresolvedRefs(moddleWarnings: unknown): void {
  for (const warning of (moddleWarnings as ModdleWarning[] | undefined) ?? []) {
    const { message, element, property, value } = warning;
    if (message?.startsWith('unresolved reference') !== true) continue;
    if (element === undefined || property === undefined) continue;
    if (value === undefined) continue;
    const byProperty =
      UNRESOLVED_REFS.get(element) ?? new Map<string, string>();
    byProperty.set(property, value);
    UNRESOLVED_REFS.set(element, byProperty);
  }
}

/** The text a dropped `bpmn:` reference was written with, which Operaton reads as a name. */
function unresolvedRef(el: ModdleElement, name: string): string | undefined {
  return UNRESOLVED_REFS.get(el)?.get(`bpmn:${name}`);
}

/** Only an `xmlns` declaration is rewritten: the same URI inside a documentation body or a script is text. */
const CAMUNDA_XMLNS =
  /(xmlns(?::[\w.-]+)?\s*=\s*)(["'])http:\/\/camunda\.org\/schema\/1\.0\/bpmn\2/g;
const OPERATON_NS = 'http://operaton.org/schema/1.0/bpmn';

export const CAMUNDA_ALIAS_MESSAGE =
  'The file declares the camunda namespace; it was read as the ' +
  'operaton namespace, since `BpmnParse.OPERATON_BPMN_EXTENSIONS_NS` ' +
  'falls back to the camunda URI wherever the operaton spelling is ' +
  'absent, and the document written back carries `operaton:` alone.';

/**
 * Parse a BPMN 2.0 XML document into the IR. Throws when the XML is malformed
 * or when the document as a whole is one Operaton refuses or this tool cannot
 * read as one process ({@link refuseDocumentShapes}, {@link selectProcess}).
 */
export async function xmlToIr(
  xml: string,
): Promise<{ ir: BpmnProcess; warnings: ImportWarning[] }> {
  const moddle = createModdle();
  refuseDocumentShapes(xml);

  // `BpmnParse.OPERATON_BPMN_EXTENSIONS_NS` falls back to the camunda URI
  // wherever the operaton spelling is absent, so the engine runs a `camunda:`
  // element exactly as its `operaton:` spelling. moddle-xml binds a prefix to
  // a package by URI, so rewriting the declared URI alone (never the prefix,
  // which can recur inside attribute values) makes every `camunda:` element
  // and attribute arrive typed as `operaton:`.
  const normalizedXml = xml.replace(CAMUNDA_XMLNS, `$1$2${OPERATON_NS}$2`);
  const camundaRead = normalizedXml !== xml;

  // moddle records "unparsable content" only for elements in the registered
  // `operaton:` namespace whose type the extension does not declare; declared
  // operaton and foreign-namespace elements materialize as values instead.
  const { rootElement, warnings: moddleWarnings } =
    await moddle.fromXML(normalizedXml);

  const root = rootElement as ModdleElement;
  if (root.$type !== 'bpmn:Definitions') {
    throw new Error(
      `Expected root element 'bpmn:Definitions', got '${root.$type}'.`,
    );
  }

  refuseDroppedIds(moddleWarnings);
  refuseImports(root);

  const rootElements = root.get('rootElements') as ModdleElement[];
  const warnings: ImportWarning[] = [];
  const processEl = selectProcess(rootElements, warnings);

  recordUnresolvedRefs(moddleWarnings);
  const recoveredPositions = recordDroppedConditions(root, normalizedXml);

  const mappedProcess = mapProcess(processEl, warnings);

  if (camundaRead) {
    warnings.push({
      elementId: mappedProcess.id,
      category: 'unmappedConstruct',
      message: CAMUNDA_ALIAS_MESSAGE,
    });
  }

  // One name space across both lists: an error and an escalation declaration
  // share the scope a use site resolves in, so a name taken by one is taken.
  const declaredNames = new Set<string>();
  const errorDecls = readCodeDecls(
    rootElements.filter((e) => e.$type === 'bpmn:Error'),
    'error',
    declaredNames,
    warnings,
  );
  const escalationDecls = readCodeDecls(
    rootElements.filter((e) => e.$type === 'bpmn:Escalation'),
    'escalation',
    declaredNames,
    warnings,
  );
  const ir: BpmnProcess = {
    ...mappedProcess,
    ...(errorDecls.length > 0 ? { errorDecls } : {}),
    ...(escalationDecls.length > 0 ? { escalationDecls } : {}),
  };
  warnCollaborationDrops(rootElements, processEl, warnings);
  const signalRoots = rootElements.filter((e) => e.$type === 'bpmn:Signal');
  refuseDuplicateSignalNames(signalRoots);
  warnUnreferencedRoots(
    rootElements.filter((e) => e.$type === 'bpmn:Message'),
    signalRoots,
    ir,
    warnings,
  );

  const documentId = root.id ?? ir.id;
  collectExtensionDrops(root, documentId, warnings);
  collectUnmappedBpmnDrops(root, documentId, warnings);
  warnDocumentationDrop(root, documentId, 'the definitions root', warnings);
  const reportedRootIds = collectRootDrops(rootElements, ir.id, warnings);

  collectUnparsableResidualDrops(
    moddleWarnings,
    normalizedXml,
    ir.id,
    warnings,
    reportedRootIds,
    recoveredPositions,
  );
  return { ir, warnings };
}

/** The entities XML predefines; every other `&name;` needs a DOCTYPE to declare it. */
const UNDEFINED_ENTITY = /&(?!(?:amp|lt|gt|quot|apos);)[A-Za-z][\w.-]*;/;

/**
 * Refuse, on the raw text, what the engine's parse refuses before `BpmnParse`
 * sees an element. Comments and CDATA sections are cut first: a script body
 * may hold `&name;` or `<!DOCTYPE`. `isSequential`/`triggeredByEvent` are
 * checked here because moddle coerces a `Boolean` attribute to
 * `value === 'true'` with the raw text gone, while `Parse.execute`'s
 * validating parse refuses a value outside the `xsd:boolean` lexical space.
 */
function refuseDocumentShapes(xml: string): void {
  const text = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/<!DOCTYPE/i.test(text)) {
    throw new UnsupportedDocumentError(
      'it carries a <!DOCTYPE> declaration, which Operaton refuses to deploy ' +
        '(`Parser.setXxeProcessing` sets disallow-doctype-decl unless XXE ' +
        'processing is enabled) and whose entities this tool does not expand',
    );
  }
  const entity = UNDEFINED_ENTITY.exec(text);
  if (entity !== null) {
    throw new UnsupportedDocumentError(
      `it references the entity '${entity[0]}', which XML does not predefine ` +
        "and no DOCTYPE declares, so Operaton's parse fails on it and this " +
        'tool would keep it as literal text',
    );
  }
  for (const [, name, , value] of text.matchAll(
    /<[^<>]*?\s(isSequential|triggeredByEvent)\s*=\s*(["'])(.*?)\2/g,
  )) {
    if (value === 'true' || value === 'false') continue;
    throw new UnsupportedDocumentError(
      `${name}="${value}" is outside true and false; this tool reads the ` +
        "schema's boolean, while Operaton's validating parse (`Parse." +
        `execute\` against \`BPMN20.xsd\`, which types \`${name}\` ` +
        '`xsd:boolean`) refuses the deployment before `BpmnParse` reads it',
    );
  }
}

/**
 * moddle-xml drops an element whose id repeats or falls outside its ASCII
 * pattern, leaving a warning and a dangling reference. The engine's validating
 * parse against `BPMN20.xsd` (`Parse.execute`) refuses a duplicate `xs:ID`,
 * while it deploys a non-ASCII NCName this tool cannot read.
 */
function refuseDroppedIds(moddleWarnings: unknown): void {
  for (const warning of (moddleWarnings as ModdleWarning[] | undefined) ?? []) {
    const match = /nested error: (duplicate|illegal) ID <([^>]+)>/.exec(
      String(warning.message ?? ''),
    );
    if (match === null) continue;
    const [, kind, id] = match;
    throw new UnsupportedDocumentError(
      kind === 'duplicate'
        ? `the id '${id}' is written on two elements; Operaton validates ` +
            'every file against BPMN20.xsd and refuses a duplicate xs:ID'
        : `the id '${id}' is outside what this tool reads: ASCII letters, ` +
            "digits, '_', '-' and '.', starting with a letter or '_', " +
            'where the schema admits any letter; rename it',
    );
  }
}

/**
 * `BpmnParse.parseImports` fails the deployment on every `importType` but
 * `http://schemas.xmlsoap.org/wsdl/`, and on that one without
 * `CxfWSDLImporter` on the classpath.
 */
function refuseImports(root: ModdleElement): void {
  const [theImport] = root.get('imports') as ModdleElement[];
  if (theImport === undefined) return;
  throw new UnsupportedDocumentError(
    `it declares a bpmn:import of type '${readString(theImport, 'importType') ?? ''}'; ` +
      '`BpmnParse.parseImports` fails the deployment on every import type ' +
      'but WSDL, and on WSDL without CxfWSDLImporter on the classpath',
  );
}

/**
 * The one process `BpmnParse.parseProcessDefinitions` deploys: the one marked
 * `isExecutable="true"` (an absent attribute defaults to `!deployment.isNew()`,
 * so a new deployment skips it). Two executable processes deploy side by side
 * and the IR holds one, so they refuse; a lone unmarked process imports with
 * {@link mapProcess}'s warning.
 */
function selectProcess(
  rootElements: ModdleElement[],
  warnings: ImportWarning[],
): ModdleElement {
  const processes = rootElements.filter((e) => e.$type === 'bpmn:Process');
  if (processes.length === 0) {
    throw new UnsupportedDocumentError(
      'it holds no bpmn:process, so there is nothing to import',
    );
  }
  const executable = processes.filter((p) => p.get('isExecutable') === true);
  if (executable.length > 1) {
    throw new UnsupportedCollaborationError(
      `${executable.length === 2 ? 'two' : executable.length} executable ` +
        `processes (${executable.map((p) => `'${p.id}'`).join(', ')})`,
    );
  }
  if (executable.length === 0) {
    if (processes.length > 1) {
      throw new UnsupportedDocumentError(
        `none of its ${processes.length} processes is marked ` +
          'isExecutable="true"; `BpmnParse.parseProcessDefinitions` deploys ' +
          'none of them in a new deployment',
      );
    }
    return processes[0];
  }
  const [selected] = executable;
  for (const skipped of processes) {
    if (skipped === selected) continue;
    warnings.push({
      elementId: skipped.id ?? selected.id ?? '',
      category: 'unmappedConstruct',
      message:
        `The process '${skipped.id}' is not marked executable and was not ` +
        'imported; `BpmnParse.parseProcessDefinitions` does not deploy it either.',
    });
  }
  return selected;
}

/**
 * `BpmnParse.parseCollaboration` records a participant's `processRef` for
 * `parseBPMNShape` alone, and no method in `BpmnParse` reads a message flow,
 * so a collaboration is diagram data: the imported process runs identically.
 */
function warnCollaborationDrops(
  rootElements: ModdleElement[],
  processEl: ModdleElement,
  warnings: ImportWarning[],
): void {
  for (const collab of rootElements) {
    if (collab.$type !== 'bpmn:Collaboration') continue;
    const collabId = collab.id ?? processEl.id ?? '';
    for (const p of collab.get('participants') as ModdleElement[]) {
      const id = p.id ?? collabId;
      const ref = getEl(p, 'processRef');
      const names =
        ref === processEl
          ? `the imported process '${processEl.id}'`
          : ref !== undefined
            ? `process '${ref.id}', which was not imported`
            : 'no process this document holds';
      warnings.push({
        elementId: id,
        category: 'unmappedConstruct',
        message:
          `The pool ${describePoolName(p)}(${id}) names ${names}; ` +
          '`BpmnParse.parseCollaboration` records it for the diagram alone, ' +
          'and the document written back has no pool.',
      });
    }
    for (const flow of collab.get('messageFlows') as ModdleElement[]) {
      const id = flow.id ?? collabId;
      const end = (name: string): string =>
        getEl(flow, name)?.id ?? unresolvedRef(flow, name) ?? '?';
      warnings.push({
        elementId: id,
        category: 'unmappedConstruct',
        message:
          `The message flow '${id}' from '${end('sourceRef')}' to ` +
          `'${end('targetRef')}' was not imported; \`BpmnParse\` reads no ` +
          'message flow, so the process runs identically without it.',
      });
    }
    collectUnmappedBpmnDrops(collab, collabId, warnings);
  }
}

function describePoolName(participant: ModdleElement): string {
  const name = readString(participant, 'name');
  return name === undefined ? '' : `'${name}' `;
}

/** `BpmnParse.parseSignals` fails the deployment on a duplicate signal name. */
function refuseDuplicateSignalNames(signalRoots: ModdleElement[]): void {
  const byName = new Map<string, string>();
  for (const root of signalRoots) {
    const name = readString(root, 'name');
    if (name === undefined) continue;
    const rootId = requireId(root);
    const prior = byName.get(name);
    if (prior !== undefined) {
      throw new UnsupportedEventFeatureError(
        rootId,
        `signal roots '${prior}' and '${rootId}' both declare the name ` +
          `"${name}"; \`BpmnParse.parseSignals\` fails the deployment on a ` +
          'duplicate signal name',
        'Leave one root per signal name.',
      );
    }
    byName.set(name, rootId);
  }
}

/**
 * The declarations `bpmn:Error` and `bpmn:Escalation` roots carry, in document
 * order, deduped by code; a root with no code is dropped with a warning. Two
 * roots agreeing on a code and disagreeing on `operaton:errorMessage` are
 * refused rather than merged, since that text is the one root datum usage
 * cannot recover.
 */
function readCodeDecls(
  roots: ModdleElement[],
  label: 'error' | 'escalation',
  takenNames: Set<string>,
  warnings: ImportWarning[],
): { name: string; code: string; message?: string }[] {
  const seen = new Map<
    string,
    { decl: { name: string; code: string; message?: string }; rootId: string }
  >();
  const decls: { name: string; code: string; message?: string }[] = [];

  for (const root of roots) {
    const rootId = requireId(root);
    const message =
      label === 'error' ? readNamespacedAttr(root, 'errorMessage') : undefined;
    const code = readString(root, `${label}Code`);

    if (code === undefined) {
      if (message !== undefined) {
        throw new UnsupportedEventFeatureError(
          rootId,
          'a declared error message needs a code to be keyed by, but this ' +
            'error root has no errorCode',
        );
      }
      warnings.push({
        elementId: rootId,
        category: 'unreferencedRoot',
        message:
          `The ${label} root '${rootId}' has no code, so it cannot be keyed ` +
          'or represented in the model; it was not imported.',
      });
      continue;
    }

    const prior = seen.get(code);
    if (prior !== undefined) {
      if (message === undefined) continue;
      if (prior.decl.message === undefined) {
        prior.decl.message = message;
      } else if (prior.decl.message !== message) {
        throw new UnsupportedEventFeatureError(
          rootId,
          `error roots '${prior.rootId}' and '${rootId}' both declare code ` +
            `"${code}" but disagree about the thrown message`,
        );
      }
      continue;
    }

    const decl = {
      name: claimDeclarationName(code, takenNames, readString(root, 'name')),
      code,
      ...(message !== undefined ? { message } : {}),
    };
    seen.set(code, { decl, rootId });
    decls.push(decl);
  }

  return decls;
}

/** Warn once per message or signal root nothing in the IR uses; an error or escalation root imports as a declaration regardless. */
function warnUnreferencedRoots(
  messageRoots: ModdleElement[],
  signalRoots: ModdleElement[],
  ir: BpmnProcess,
  warnings: ImportWarning[],
): void {
  const { messageNames, signalNames } = eventIdentities(ir);

  for (const root of messageRoots) {
    warnUnreferencedNamedRoot(
      root,
      messageNames,
      'message',
      'itemRef',
      warnings,
    );
  }
  for (const root of signalRoots) {
    warnUnreferencedNamedRoot(
      root,
      signalNames,
      'signal',
      'structureRef',
      warnings,
    );
  }
}

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
    if (getEl(root, dataRefProperty) !== undefined) {
      warnings.push({
        elementId: rootId,
        category: 'extensionAttribute',
        message:
          `The '${dataRefProperty}' setting on ${label} root '${rootId}' names a ` +
          'data structure Operaton does not execute; it was not imported.',
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

/** A `bpmn-moddle` parse warning. */
interface ModdleWarning {
  readonly message?: string;
  /** An `unresolved reference` warning carries the element, the property (`bpmn:loopDataInputRef`) and the text. */
  readonly element?: ModdleElement;
  readonly property?: string;
  readonly value?: string;
}

/** A source position as `line:column`: the only handle an "unparsable content" moddle warning gives on its element. */
function positionKey(line: number, column: number): string {
  return `${line}:${column}`;
}

/** The positions of every element written under a root whose id is in `rootIds`, read off the source text. */
function positionsUnderRoots(
  xml: string,
  rootIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const positions = new Set<string>();
  if (rootIds.size === 0) return positions;

  const parser = new Parser();
  let depth = 0;
  let insideRoot = false;
  parser.on(
    'openTag',
    (_elementName, getAttrs, _decodeEntities, selfClosing, getContext) => {
      if (insideRoot) {
        const { line, column } = getContext();
        positions.add(positionKey(line, column));
      } else if (depth === 1 && rootIds.has(getAttrs()['id'])) {
        insideRoot = !selfClosing;
      }
      if (!selfClosing) depth += 1;
    },
  );
  // saxen raises `closeTag` for `<a/>` as well as for `</a>`, so the
  // decrement is gated on the same flag as the increment; ungated, every
  // self-closing tag sinks `depth` one below true nesting for good.
  parser.on('closeTag', (_elementName, _decodeEntities, selfClosing) => {
    if (selfClosing) return;
    depth -= 1;
    if (depth === 1) insideRoot = false;
  });
  parser.parse(xml);
  return positions;
}

/** A `<bpmn:conditionExpression>` moddle dropped, read back off the source text by {@link recordDroppedConditions}. */
interface DroppedCondition {
  xsiType: string;
  body: string;
  /** Where moddle's warning places the element, so the residual sweep skips it. */
  position: string;
  language?: string;
  /** The `resource` attribute, whichever prefix carries it in source text. */
  resource?: string;
}

/** Keyed by the flow the element sat in; see {@link UNRESOLVED_REFS} for why a WeakMap. */
const DROPPED_CONDITIONS = new WeakMap<ModdleElement, DroppedCondition>();

/**
 * moddle resolves an unprefixed `xsi:type` against the document's default
 * namespace, where `BpmnParse.parseConditionExpression` resolves it against
 * `BPMN20_NS` whatever the document declares, so `<bpmn:conditionExpression
 * xsi:type="tFormalExpression">` in a prefixed document is dropped by moddle
 * as unparsable content while the engine evaluates it. Such an element is
 * read back off the source text and keyed by its flow for
 * {@link mapSequenceFlow}; the positions taken are returned for the residual
 * sweep to skip.
 */
function recordDroppedConditions(
  root: ModdleElement,
  xml: string,
): ReadonlySet<string> {
  const positions = new Set<string>();
  const byFlowId = scanUnprefixedConditions(xml);
  if (byFlowId.size === 0) return positions;
  for (const flow of flowElementsDeep(root)) {
    if (flow.$type !== 'bpmn:SequenceFlow') continue;
    if (getEl(flow, 'conditionExpression') !== undefined) continue;
    const dropped = flow.id === undefined ? undefined : byFlowId.get(flow.id);
    if (dropped === undefined) continue;
    DROPPED_CONDITIONS.set(flow, dropped);
    positions.add(dropped.position);
  }
  return positions;
}

/** Every flow element under `container`, containers' own children included. */
function* flowElementsDeep(container: ModdleElement): Generator<ModdleElement> {
  const children = [
    ...((container.get('rootElements') as ModdleElement[] | undefined) ?? []),
    ...((container.get('flowElements') as ModdleElement[] | undefined) ?? []),
  ];
  for (const child of children) {
    yield child;
    yield* flowElementsDeep(child);
  }
}

/** The `conditionExpression` elements typed without a prefix, by the id of the flow each sits in. */
function scanUnprefixedConditions(xml: string): Map<string, DroppedCondition> {
  const found = new Map<string, DroppedCondition>();
  const parser = new Parser();
  let flowId: string | undefined;
  let open: (DroppedCondition & { flowId: string }) | undefined;
  parser.on(
    'openTag',
    (elementName, getAttrs, _decodeEntities, selfClosing, getContext) => {
      const local = localNameOf(elementName);
      if (local === 'sequenceFlow') {
        flowId = selfClosing ? undefined : getAttrs()['id'];
        return;
      }
      if (local !== 'conditionExpression' || flowId === undefined) return;
      const attrs = getAttrs();
      const xsiType = attrs['xsi:type'];
      if (xsiType === undefined || xsiType.includes(':')) return;
      const { line, column } = getContext();
      open = {
        flowId,
        xsiType,
        body: '',
        position: positionKey(line, column),
        language: nonEmptyAttr(attrs, 'language'),
        resource: nonEmptyAttr(attrs, 'resource'),
      };
      if (selfClosing) {
        found.set(flowId, open);
        open = undefined;
      }
    },
  );
  parser.on('text', (value, decodeEntities) => {
    if (open !== undefined) open.body += decodeEntities(value);
  });
  parser.on('cdata', (value) => {
    if (open !== undefined) open.body += value;
  });
  parser.on('closeTag', (elementName) => {
    const local = localNameOf(elementName);
    if (local === 'conditionExpression' && open !== undefined) {
      found.set(open.flowId, open);
      open = undefined;
    } else if (local === 'sequenceFlow') {
      flowId = undefined;
    }
  });
  parser.parse(xml);
  return found;
}

function localNameOf(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.indexOf(':') + 1);
}

/**
 * An attribute of a raw-text tag, found by local name whatever prefix binds
 * it: the namespace swap in {@link xmlToIr} rewrites `xmlns:*` values alone,
 * so the document's own `camunda:` or `operaton:` prefix survives here.
 */
function nonEmptyAttr(
  attrs: Record<string, string>,
  localName: string,
): string | undefined {
  for (const [key, value] of Object.entries(attrs)) {
    if (localNameOf(key) === localName)
      return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * One {@link ImportWarning} per residual "unparsable content" moddle warning,
 * attributed to the process because moddle cannot tie the dropped element to
 * a step. A residual inside a root {@link collectRootDrops} reported whole,
 * or a condition {@link recordDroppedConditions} read back, is skipped.
 */
function collectUnparsableResidualDrops(
  moddleWarnings: unknown,
  xml: string,
  processId: string,
  warnings: ImportWarning[],
  reportedRootIds: ReadonlySet<string>,
  recoveredPositions: ReadonlySet<string>,
): void {
  const list = (moddleWarnings as ModdleWarning[] | undefined) ?? [];
  const underReportedRoot = new Set([
    ...positionsUnderRoots(xml, reportedRootIds),
    ...recoveredPositions,
  ]);
  for (const warning of list) {
    const message = String(warning.message ?? '');
    const match = /unparsable content <([^>]+)>/i.exec(message);
    if (match === null) continue;
    const construct = match[1];
    const lineMatch = /line:\s*(\d+)/i.exec(message);
    const columnMatch = /column:\s*(\d+)/i.exec(message);
    if (
      lineMatch !== null &&
      columnMatch !== null &&
      underReportedRoot.has(positionKey(+lineMatch[1], +columnMatch[1]))
    ) {
      continue;
    }
    const location = lineMatch ? ` at line ${lineMatch[1]}` : '';
    warnings.push({
      elementId: processId,
      category: 'extensionAttribute',
      message:
        `Extra engine-specific configuration (${construct}${location}) was not ` +
        'imported; it could not be attributed to a specific step.',
    });
  }
}

/** All `bpmndi:`/`dc:`/`di:` content sits outside the process subtree, so iterating `flowElements` drops DI for free. */
function mapProcess(
  processEl: ModdleElement,
  warnings: ImportWarning[],
): BpmnProcess {
  const id = processEl.id;
  if (id === undefined) {
    throw new Error("<bpmn:process> is missing its required 'id' attribute.");
  }
  const named = readNamed(processEl, id, warnings);

  // The one place import changes what the document says rather than leaving
  // something out. An absent attribute is the same change:
  // `BpmnParse.parseProcessDefinitions` defaults it to `!deployment.isNew()`.
  const isExecutable = processEl.get('isExecutable');
  if (isExecutable === false) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The process '${id}' is marked isExecutable="false", which this ` +
        'surface cannot express: it was imported as an executable process ' +
        'and is written back as one, so an engine will deploy and run what ' +
        'the source document held back.',
    });
  } else if (isExecutable !== true) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The process '${id}' is not marked isExecutable="true", which ` +
        '`BpmnParse.parseProcessDefinitions` skips in a new deployment; it ' +
        'was imported as an executable process and is written back as one.',
    });
  }

  collectLaneDrops(processEl, id, warnings);
  collectExtensionDrops(processEl, id, warnings);
  collectUnmappedBpmnDrops(processEl, id, warnings);
  const starters = readPotentialStarters(processEl, id, warnings);

  const { flowElements, sequenceFlows } = mapContainer(
    processEl,
    warnings,
    'process',
  );
  const versionTag = readNamespacedAttr(processEl, 'versionTag');
  // The exporter stamps HISTORY_TIME_TO_LIVE on every process that authored
  // none, so reading that exact value back would invent a setting and leave a
  // re-imported IR unequal to the one exported.
  const authoredTimeToLive = readNamespacedAttr(processEl, 'historyTimeToLive');
  const historyTimeToLive =
    authoredTimeToLive === HISTORY_TIME_TO_LIVE
      ? undefined
      : authoredTimeToLive;
  const candidateStarterUsers = mergeCandidates(
    starters.users,
    readNamespacedAttr(processEl, 'candidateStarterUsers'),
  );
  const candidateStarterGroups = mergeCandidates(
    starters.groups,
    readNamespacedAttr(processEl, 'candidateStarterGroups'),
  );

  return {
    id,
    ...named,
    isExecutable: true,
    ...(versionTag === undefined ? {} : { versionTag }),
    ...(historyTimeToLive === undefined ? {} : { historyTimeToLive }),
    ...(candidateStarterUsers === undefined ? {} : { candidateStarterUsers }),
    ...(candidateStarterGroups === undefined ? {} : { candidateStarterGroups }),
    flowElements,
    sequenceFlows,
  };
}

/**
 * `BpmnParse.parseStartAuthorization` reads every `operaton:potentialStarter`
 * into the candidate-starter lists before the two attributes append theirs,
 * splitting each formal expression as a `bpmn:potentialOwner`'s is split.
 */
function readPotentialStarters(
  processEl: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): { users: string[]; groups: string[] } {
  const users: string[] = [];
  const groups: string[] = [];
  const report = (message: string): void => {
    warnings.push({ elementId: id, category: 'unmappedConstruct', message });
  };
  for (const starter of extensionValues(processEl)) {
    if (starter.$type !== 'operaton:PotentialStarter') continue;
    const text = formalExpressionTextOf(starter);
    if (text === undefined) {
      report(
        `The operaton:potentialStarter on '${id}' was not imported: it ` +
          'carries no formal expression, and Operaton reads nothing else off ' +
          'it (BpmnParse.parsePotentialStarterResourceAssignment).',
      );
      continue;
    }
    const split = splitCandidates(text);
    users.push(...split.users);
    groups.push(...split.groups);
    const became: [key: string, value: string[]][] = [
      ['candidateStarterUsers', split.users],
      ['candidateStarterGroups', split.groups],
    ].filter((entry): entry is [string, string[]] => entry[1].length > 0);
    report(
      `The operaton:potentialStarter on '${id}' imports as ` +
        `${became.map(([key, value]) => `${key}: "${value.join(',')}"`).join(' and ')}: ` +
        'Operaton reads its formal expression that way ' +
        '(BpmnParse.parsePotentialStarterResourceAssignment), and this tool ' +
        `writes it back as ${became.map(([key]) => `operaton:${key}`).join(' and ')}, ` +
        'which the engine reads the same.',
    );
  }
  return { users, groups };
}

/**
 * Which container hosts the element being mapped: an undo handler sits
 * directly inside the block whose work it undoes, and a cancel end directly
 * inside a block that can be given up.
 */
type ContainerHostKind =
  'process' | 'subProcess' | 'transaction' | 'eventSubProcess';

function mapContainer(
  el: ModdleElement,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): { flowElements: FlowElement[]; sequenceFlows: SequenceFlow[] } {
  checkStartEventCount(el, hostKind, warnings);
  return mapContainerChildren(
    el,
    warnings,
    (startEl) => mapStartEvent(startEl, warnings, hostKind),
    hostKind,
  );
}

/**
 * A process takes one start per `start` statement, but `BpmnParse.selectInitial`
 * fails the deployment on a second plain or timer start; a subprocess or a
 * transaction takes exactly one (`BpmnParse.parseScopeStartEvent`). With none,
 * `BpmnParse.parseStartEvents` errors on a `process` or `subProcess` tag alone,
 * so a transaction with no start deploys and fails on entry
 * (`SubProcessActivityBehavior.execute`), where the script adds a start.
 */
function checkStartEventCount(
  el: ModdleElement,
  hostKind: ContainerHostKind,
  warnings: ImportWarning[],
): void {
  const id = requireId(el);
  const children = el.get('flowElements') as ModdleElement[];
  const starts = children.filter((c) => c.$type === 'bpmn:StartEvent');
  if (starts.length === 0 && hostKind !== 'transaction') {
    throw new UnsupportedEventFeatureError(
      id,
      'it has no start event, which BpmnParse.parseStartEvents fails the ' +
        `deployment on ("${hostKind} must define a startEvent element")`,
      'Add a start event and lead it to the first step.',
    );
  }
  if (hostKind === 'process') {
    const initialCandidates = starts.filter((start) =>
      eventDefinitionsOf(start).every(
        (def) => def.$type === 'bpmn:TimerEventDefinition',
      ),
    );
    if (initialCandidates.length > 1) {
      throw new UnsupportedEventFeatureError(
        requireId(initialCandidates[1]),
        `the process '${id}' has ${initialCandidates.length} plain or timer ` +
          'starts, which BpmnParse.selectInitial fails the deployment on ' +
          '("multiple none start events or timer start events not ' +
          'supported on process definition")',
        'Leave one plain or timer start; the others may carry a message, ' +
          'signal, or condition trigger.',
      );
    }
    return;
  }
  if (starts.length > 1) {
    throw new UnsupportedEventFeatureError(
      id,
      `it has ${starts.length} start events; this tool writes one entry ` +
        'point per subprocess or transaction, so a second start has nowhere to go',
      'Leave one start and connect the steps that followed the others onto it.',
    );
  }
  if (starts.length === 0) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The bpmn:transaction '${id}' has no start event: Operaton deploys ` +
        'it and SubProcessActivityBehavior.execute fails on entering it ' +
        '("No initial activity found"); the script adds a start, so the ' +
        'imported block runs.',
    });
  }
}

const ACTIVITY_TYPES: ReadonlySet<string> = new Set(ACTIVITY_TAGS);

/** The general wording for an unpaired half of the pattern: nothing to name a rewrite from. */
export const IS_FOR_COMPENSATION_DETAIL =
  'isForCompensation="true" marks this activity as excluded from normal ' +
  'flow: the boundary-event compensation-handler pattern, which this ' +
  'tool cannot import; wrap the steps in their own subprocess and ' +
  'target it with "on compensation" instead';

export const COMPENSATION_BOUNDARY_DETAIL =
  'a compensation boundary event is not imported: BPMN attaches ' +
  'compensation through isForCompensation and a bpmn:association on ' +
  'the activity being compensated, not a boundary event; wrap the ' +
  'steps in their own subprocess and target it with "on compensation" instead';

function refuseIfForCompensation(
  child: ModdleElement,
  containerEl: ModdleElement,
): void {
  if (!ACTIVITY_TYPES.has(child.$type)) return;
  if (child.get('isForCompensation') !== true) return;
  const id = child.id ?? '(unknown)';
  throw new UnsupportedEventFeatureError(
    id,
    describePairedHandler(containerEl, id, child) ?? IS_FOR_COMPENSATION_DETAIL,
  );
}

/** The paired wording for the handler side, or `undefined` when no association targets `handlerId` or the rewrite cannot be shown. */
function describePairedHandler(
  containerEl: ModdleElement,
  handlerId: string,
  handlerEl: ModdleElement,
): string | undefined {
  const boundaryEl = findAssociationEnd(containerEl, 'targetRef', handlerId);
  const boundary =
    boundaryEl === undefined ? undefined : compensationBoundaryOf(boundaryEl);
  if (boundary === undefined) return undefined;
  const rewrite = describeCompensationRewrite(
    boundary.hostEl,
    boundary.id,
    handlerEl,
  );
  if (rewrite === undefined) return undefined;
  return (
    `isForCompensation="true" marks '${handlerId}' as the handler a ` +
    `bpmn:association targets from the boundary event '${boundary.id}' on ` +
    `'${requireId(boundary.hostEl)}'; BPMN's boundary-plus-association ` +
    `pattern is not imported. Write it by hand instead:\n\n${rewrite}`
  );
}

/** The element a `bpmn:association` in `containerEl`'s `artifacts` names on the opposite end from `id`. */
function findAssociationEnd(
  containerEl: ModdleElement,
  knownEnd: 'sourceRef' | 'targetRef',
  id: string,
): ModdleElement | undefined {
  const artifacts = containerEl.get('artifacts') as ModdleElement[];
  const otherEnd = knownEnd === 'sourceRef' ? 'targetRef' : 'sourceRef';
  const association = artifacts.find(
    (a) => a.$type === 'bpmn:Association' && getEl(a, knownEnd)?.id === id,
  );
  return association === undefined ? undefined : getEl(association, otherEnd);
}

/** `boundaryEl` as a compensation boundary with its host, or `undefined` when it is not one. */
function compensationBoundaryOf(
  boundaryEl: ModdleElement,
): { id: string; hostEl: ModdleElement } | undefined {
  if (boundaryEl.$type !== 'bpmn:BoundaryEvent') return undefined;
  const defs = eventDefinitionsOf(boundaryEl);
  if (defs.length !== 1 || defs[0].$type !== 'bpmn:CompensateEventDefinition') {
    return undefined;
  }
  const hostEl = getEl(boundaryEl, 'attachedToRef');
  return hostEl === undefined
    ? undefined
    : { id: requireId(boundaryEl), hostEl };
}

const SERVICE_TASK_ELEMENT_BY_TAG: Readonly<
  Record<string, keyof typeof SERVICE_TASK_LIKE_TAG | undefined>
> = invert(SERVICE_TASK_LIKE_TAG);

/**
 * Per-tag dispatch for every activity kind but `bpmn:SubProcess`, which the
 * container dispatch maps by `triggeredByEvent` and the standalone mapping
 * always as a plain sub-process, so each keeps its own case for that tag.
 */
function mapActivityByTag(
  el: ModdleElement,
  warnings: ImportWarning[],
): FlowElement {
  const serviceLike = SERVICE_TASK_ELEMENT_BY_TAG[el.$type];
  if (serviceLike !== undefined) {
    return mapServiceTask(
      el,
      warnings,
      serviceLike === 'service' ? undefined : serviceLike,
    );
  }
  switch (el.$type) {
    case 'bpmn:Task':
      return mapTask(el, warnings);
    case 'bpmn:ManualTask':
      return mapManualTask(el, warnings);
    case 'bpmn:UserTask':
      return mapUserTask(el, warnings);
    case 'bpmn:ReceiveTask':
      return mapReceiveTask(el, warnings);
    case 'bpmn:ScriptTask':
      return mapScriptTask(el, warnings);
    case SUB_PROCESS_LIKE_TAG.transaction:
      return mapSubProcess(el, warnings, 'transaction');
    case 'bpmn:CallActivity':
      return mapCallActivity(el, warnings);
    default:
      throw new UnsupportedElementError(el.$type, el.id);
  }
}

/**
 * One activity mapped outside `mapContainerChildren`, for
 * {@link describeCompensationRewrite}: the repetition is attached here as
 * that loop attaches it, so a repeated activity previews with its loop.
 */
function mapActivityStandalone(
  el: ModdleElement,
  warnings: ImportWarning[],
): FlowElement {
  const out = [
    el.$type === 'bpmn:SubProcess'
      ? mapSubProcess(el, warnings)
      : mapActivityByTag(el, warnings),
  ];
  attachRepetition(out, 0, el, warnings);
  return out[0];
}

/** The paired wording for the boundary side, or `undefined` when no association leaves `boundaryId` or the rewrite cannot be shown. */
function describePairedBoundary(
  containerEl: ModdleElement,
  boundaryId: string,
  hostEl: ModdleElement,
): string | undefined {
  const handlerEl = findAssociationEnd(containerEl, 'sourceRef', boundaryId);
  if (handlerEl === undefined) return undefined;
  // An association to an element that never declared itself a compensation
  // handler is not this pattern; `parseAssociationOfCompensationBoundaryEvent`
  // rejects it too.
  if (handlerEl.get('isForCompensation') !== true) return undefined;
  const rewrite = describeCompensationRewrite(hostEl, boundaryId, handlerEl);
  if (rewrite === undefined) return undefined;
  return (
    `the boundary event '${boundaryId}' compensates '${requireId(hostEl)}' ` +
    `through the handler '${requireId(handlerEl)}' its bpmn:association ` +
    `targets; a compensation boundary event is not imported. Write it by ` +
    `hand instead:\n\n${rewrite}`
  );
}

/**
 * The `subprocess`/`on compensation` rewrite an author would write by hand
 * for one compensation triple, built by mapping both activities through their
 * real mappers, wrapping them in a throwaway process and printing it through
 * the real `irToDsl`, whose own CFG pass nests a sub-process host correctly.
 * `undefined` when either activity refuses on its own, since the preview is a
 * courtesy on top of the compensation refusal already in flight. The wrapper
 * id `Compensated_<id>` is the one printed id, and it clears every reserved
 * prefix; the synthesized start is elided (`isElidedOnPrint`).
 */
function describeCompensationRewrite(
  hostEl: ModdleElement,
  boundaryId: string,
  handlerEl: ModdleElement,
): string | undefined {
  const hostId = requireId(hostEl);
  let compensated: FlowElement;
  let handler: FlowElement;
  try {
    compensated = mapActivityStandalone(hostEl, []);
    handler = mapActivityStandalone(handlerEl, []);
  } catch (e) {
    if (e instanceof UnsupportedConstructError) return undefined;
    throw e;
  }

  const wrapperId = `Compensated_${hostId}`;
  const handlerId = makeEventSubProcessId(wrapperId);
  const compensationStart: FlowElement = {
    kind: 'startEvent',
    // Minted as the compiler mints it, so the printer elides it the same way.
    id: makeStartEventId(handlerId, new Set()),
    eventDefinition: { kind: 'compensation' },
  };
  const onCompensation: SubProcess = {
    kind: 'subProcess',
    id: handlerId,
    triggeredByEvent: true,
    flowElements: [compensationStart, handler],
    sequenceFlows: [],
  };
  const wrapper: SubProcess = {
    kind: 'subProcess',
    id: wrapperId,
    flowElements: [compensated, onCompensation],
    sequenceFlows: [],
  };
  const preview: BpmnProcess = {
    id: 'Preview',
    isExecutable: true,
    flowElements: [wrapper],
    sequenceFlows: [],
  };

  // Strip the `process Preview { ... }` shell (header, closing brace and the
  // trailing newline) and the one indent level its direct child carries.
  const lines = irToDsl(preview).source.split('\n').slice(1, -2);
  return lines.map((line) => line.slice(INDENT.length)).join('\n');
}

/**
 * `BpmnParse` reads neither quantity attribute. A BPMN-declared attribute is
 * invisible to both generic sweeps (it never reaches `$attrs`, and the
 * declared-attribute sweep looks at `operaton:` attributes only), so every
 * such drop is reported by hand.
 */
function warnIgnoredQuantityAttrs(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): void {
  if (!ACTIVITY_TYPES.has(el.$type)) return;
  for (const name of ['startQuantity', 'completionQuantity']) {
    // An absent attribute reads back as moddle's descriptor default, 1.
    const value: unknown = el.get(name);
    if (value === 1) continue;
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The '${name}' attribute on '${id}' was not imported: Operaton's ` +
        'BpmnParse never reads it, so the step runs as if it read 1, which ' +
        'is what the source document runs.',
    });
  }
}

/**
 * Per-child dispatch for a container's `flowElements`. Every rule about flows
 * or about a boundary's host runs after the loop, since a boundary event may
 * be written before its host.
 */
function mapContainerChildren(
  el: ModdleElement,
  warnings: ImportWarning[],
  mapStart: (startEl: ModdleElement) => StartEvent,
  hostKind: ContainerHostKind,
): { flowElements: FlowElement[]; sequenceFlows: SequenceFlow[] } {
  const flowElements: FlowElement[] = [];
  const sequenceFlows: SequenceFlow[] = [];
  // What the printer's elision reads, asked once the list is complete.
  const container = { id: requireId(el), flowElements };

  const children = el.get('flowElements') as ModdleElement[];
  for (const child of children) {
    refuseIfForCompensation(child, el);
    const mappedAt = flowElements.length;
    switch (child.$type) {
      case 'bpmn:StartEvent':
        flowElements.push(mapStart(child));
        break;
      case 'bpmn:EndEvent':
        flowElements.push(mapEndEvent(child, warnings, hostKind));
        break;
      case 'bpmn:IntermediateThrowEvent':
        flowElements.push(mapIntermediateThrowEvent(child, warnings));
        break;
      case 'bpmn:IntermediateCatchEvent':
        flowElements.push(mapIntermediateCatchEvent(child, warnings));
        break;
      case 'bpmn:BoundaryEvent':
        flowElements.push(mapBoundaryEvent(child, warnings, el));
        break;
      case 'bpmn:ExclusiveGateway':
        flowElements.push(
          mapDefaultingGateway(child, 'exclusiveGateway', warnings),
        );
        break;
      case 'bpmn:InclusiveGateway':
        flowElements.push(
          mapDefaultingGateway(child, 'inclusiveGateway', warnings),
        );
        break;
      case 'bpmn:ParallelGateway':
        flowElements.push(mapParallelGateway(child, warnings));
        break;
      case 'bpmn:EventBasedGateway':
        flowElements.push(mapEventBasedGateway(child, warnings));
        break;
      case 'bpmn:SubProcess':
        flowElements.push(
          child.get('triggeredByEvent') === true
            ? mapEventSubProcess(child, warnings, hostKind)
            : mapSubProcess(child, warnings),
        );
        break;
      // Operaton reads `triggeredByEvent` on a bpmn:Transaction not at all
      // (warnIgnoredTransactionAttrs reports it), so it maps like a task.
      case 'bpmn:Task':
      case 'bpmn:ManualTask':
      case 'bpmn:UserTask':
      case 'bpmn:ServiceTask':
      case 'bpmn:SendTask':
      case 'bpmn:BusinessRuleTask':
      case 'bpmn:ReceiveTask':
      case 'bpmn:ScriptTask':
      case 'bpmn:Transaction':
      case 'bpmn:CallActivity':
        flowElements.push(mapActivityByTag(child, warnings));
        break;
      case 'bpmn:SequenceFlow':
        sequenceFlows.push(mapSequenceFlow(child, warnings));
        break;
      // `continue` skips the per-child sweeps below, which would draw a second
      // warning for a `bpmn:dataObject`'s own `bpmn:dataState` child.
      case 'bpmn:DataObject':
      case 'bpmn:DataObjectReference':
      case 'bpmn:DataStoreReference':
        warnDataConstructDrop(child, el.id, warnings);
        continue;
      default:
        throw new UnsupportedElementError(child.$type, child.id);
    }
    attachRepetition(flowElements, mappedAt, child, warnings);
    if (child.id !== undefined) {
      warnIgnoredQuantityAttrs(child, child.id, warnings);
      // `parseStartFormHandlers` runs for the process's own start alone.
      collectExtensionDrops(
        child,
        child.id,
        warnings,
        hostKind === 'process' && child.$type === 'bpmn:StartEvent'
          ? 'initial'
          : undefined,
      );
      collectUnmappedBpmnDrops(child, child.id, warnings);
    }
  }

  // Whether a start or an end prints is a question about the whole container
  // (an end named for a boundary escape goes only if that boundary is in the
  // list, which the export writes after the end), so the list is complete first.
  for (const mapped of flowElements) {
    if (mapped.kind === 'startEvent') {
      warnElidedNamedDrop(
        mapped,
        container,
        hostKind === 'eventSubProcess',
        warnings,
      );
    } else if (mapped.kind === 'endEvent') {
      warnElidedNamedDrop(mapped, container, false, warnings);
    }
  }
  attachDefaultFlows(children, flowElements, sequenceFlows, warnings);
  checkExclusiveGateways(children);
  checkHandlerFlows(flowElements, sequenceFlows);
  checkBoundaryEventHosts(flowElements, sequenceFlows, warnings);
  checkLinkFlows(flowElements, sequenceFlows);
  checkWaitBranches(flowElements, sequenceFlows);
  return { flowElements, sequenceFlows };
}

/**
 * The `default` a step names: `BpmnActivityBehavior.handleNoTransitions`
 * takes it when no other route out of the step held, and throws
 * `missingDefaultFlowException` on one that does not leave the step, which
 * is reported; a `default` naming no element is read back from moddle's
 * dropped reference for the same report.
 */
function attachDefaultFlows(
  children: ModdleElement[],
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
  warnings: ImportWarning[],
): void {
  for (const child of children) {
    if (!ACTIVITY_TYPES.has(child.$type)) continue;
    const defaultFlowId =
      getEl(child, 'default')?.id ?? unresolvedRef(child, 'default');
    if (defaultFlowId === undefined) continue;
    const index = flowElements.findIndex((fe) => fe.id === child.id);
    const mapped = flowElements[index];
    if (mapped === undefined || !isActivity(mapped)) continue;
    if (
      sequenceFlows.some(
        (sf) => sf.id === defaultFlowId && sf.sourceRef === mapped.id,
      )
    ) {
      flowElements[index] = { ...mapped, defaultFlowId };
      continue;
    }
    warnings.push({
      elementId: mapped.id,
      category: 'unmappedConstruct',
      message:
        `The 'default' attribute on '${mapped.id}' was not imported: it ` +
        `names '${defaultFlowId}', which is not a route out of the step, so ` +
        'BpmnActivityBehavior.handleNoTransitions finds no flow to take and ' +
        'fails the step whenever no other route holds; the imported step ' +
        'names no fallback.',
    });
  }
}

/**
 * The shapes `BpmnParse.validateExclusiveGateway` fails the deployment on,
 * asked of the document rather than the IR: the engine counts a condition
 * element with an empty body as a condition and a `default` naming no
 * element as a default, and the IR carries neither. One conditioned route
 * beside one plain route with no default is left alone: the engine takes the
 * plain one as the default and warns.
 */
function checkExclusiveGateways(children: ModdleElement[]): void {
  const flows = children.filter((c) => c.$type === 'bpmn:SequenceFlow');
  for (const gateway of children) {
    if (gateway.$type !== 'bpmn:ExclusiveGateway') continue;
    const id = requireId(gateway);
    const refuse = (detail: string): never => {
      throw new UnsupportedGatewayShapeError(id, detail);
    };
    const outgoing = flows.filter((f) => getEl(f, 'sourceRef')?.id === id);
    const conditioned = (flow: ModdleElement): boolean =>
      getEl(flow, 'conditionExpression') !== undefined ||
      DROPPED_CONDITIONS.has(flow);
    if (outgoing.length === 0) {
      refuse(`Exclusive Gateway '${id}' has no outgoing sequence flows.`);
    }
    if (outgoing.length === 1) {
      if (conditioned(outgoing[0])) {
        refuse(
          `Exclusive Gateway '${id}' has only one outgoing sequence flow ` +
            `('${outgoing[0].id}'). This is not allowed to have a condition.`,
        );
      }
      continue;
    }
    // `validateExclusiveGateway` reads `default=""` as none.
    const defaultFlowId =
      getEl(gateway, 'default')?.id ??
      (unresolvedRef(gateway, 'default') || undefined);
    const plain = outgoing.filter(
      (flow) => !conditioned(flow) && flow.id !== defaultFlowId,
    );
    const conditionedDefault = outgoing.find(
      (flow) => conditioned(flow) && flow.id === defaultFlowId,
    );
    if (conditionedDefault !== undefined) {
      refuse(
        `Exclusive Gateway '${id}' has outgoing sequence flow ` +
          `'${conditionedDefault.id}' which is the default flow but has a ` +
          'condition too.',
      );
    }
    if (plain.length > 0 && (defaultFlowId !== undefined || plain.length > 1)) {
      refuse(
        `Exclusive Gateway '${id}' has outgoing sequence flow '${plain[0].id}' ` +
          'without condition which is not the default flow.',
      );
    }
  }
}

/**
 * `BpmnParse.parseSequenceFlow` fails the deployment on a flow into or out of
 * an event sub-process, off the flow's own endpoints, so the check reads the
 * flows rather than the `incoming`/`outgoing` children a hand-written file omits.
 */
function checkHandlerFlows(
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
): void {
  const handlers = new Set(
    flowElements
      .filter((fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true)
      .map((fe) => fe.id),
  );
  if (handlers.size === 0) return;
  for (const sf of sequenceFlows) {
    const entering = handlers.has(sf.targetRef);
    if (!entering && !handlers.has(sf.sourceRef)) continue;
    const handlerId = entering ? sf.targetRef : sf.sourceRef;
    throw new UnsupportedEventFeatureError(
      handlerId,
      entering
        ? `the flow '${sf.id}' enters the event handler '${handlerId}', ` +
            'which BpmnParse.parseSequenceFlow fails the deployment on ' +
            '("Invalid incoming sequence flow of event subprocess"); a ' +
            'handler is entered by its trigger'
        : `the flow '${sf.id}' leaves the event handler '${handlerId}', ` +
            'which BpmnParse.parseSequenceFlow fails the deployment on ' +
            '("Invalid outgoing sequence flow of event subprocess"); a ' +
            'handler ends where its body ends',
      `Take the flow '${sf.id}' off; the handler runs when its trigger fires.`,
    );
  }
}

/**
 * Runs before {@link checkWaitBranches} so a wait branch into a link catch
 * draws this message. The engine refuses a flow out of a link throw at deploy
 * (`BpmnParse.parseSequenceFlow`) but runs one into a link catch as a
 * pass-through; that side is this surface's own refusal, since `await link`
 * takes no incoming flow and dropping one would change what runs.
 */
function checkLinkFlows(
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
): void {
  const linkEnds = (
    kind: 'intermediateThrowEvent' | 'intermediateCatchEvent',
  ): Set<string> =>
    new Set(
      flowElements
        .filter((el) => el.kind === kind && el.eventDefinition.kind === 'link')
        .map((el) => el.id),
    );
  const throws = linkEnds('intermediateThrowEvent');
  const catches = linkEnds('intermediateCatchEvent');
  if (throws.size === 0 && catches.size === 0) return;

  const refuse = (id: string, detail: string, flowId: string): never => {
    throw new UnsupportedEventFeatureError(
      id,
      detail,
      `Take the flow '${flowId}' off, and lead it from or to a step instead.`,
    );
  };
  for (const sf of sequenceFlows) {
    if (throws.has(sf.sourceRef)) {
      refuse(
        sf.sourceRef,
        `the flow '${sf.id}' leaves the link throw '${sf.sourceRef}'; a ` +
          'link throw ends its path, and the token continues at the catch ' +
          'of the same name rather than along a flow',
        sf.id,
      );
    }
    if (catches.has(sf.targetRef)) {
      refuse(
        sf.targetRef,
        `the flow '${sf.id}' enters the link catch '${sf.targetRef}'; a ` +
          'link catch is entered by the throw of the same name rather than ' +
          'along a flow',
        sf.id,
      );
    }
  }
}

/** The IR kinds of a `bpmn:Activity`: the ones that repeat and carry a `default`, and nothing else. */
const ACTIVITY_KINDS = [
  'task',
  'userTask',
  'serviceTask',
  'receiveTask',
  'scriptTask',
  'subProcess',
  'callActivity',
] as const;

type ActivityElement = Extract<
  FlowElement,
  { kind: (typeof ACTIVITY_KINDS)[number] }
>;

function isActivity(node: FlowElement): node is ActivityElement {
  return (ACTIVITY_KINDS as readonly string[]).includes(node.kind);
}

/** Operaton reads the repetition before its own tag dispatch and wraps whatever that produces, so one reader serves every repeatable tag. */
function attachRepetition(
  flowElements: FlowElement[],
  index: number,
  child: ModdleElement,
  warnings: ImportWarning[],
): void {
  // A sequence flow pushed nothing at `index`.
  const mapped = flowElements[index];
  if (mapped === undefined || !isActivity(mapped)) return;
  const loop = readLoopCharacteristics(child, mapped.id, warnings);
  if (loop === undefined) return;
  flowElements[index] = { ...mapped, loop };
}

/** The kinds a boundary event may attach to, each with the noun the refusals spell it with. */
const BOUNDARY_HOST_NOUNS = {
  task: 'plain task',
  userTask: 'user task',
  serviceTask: 'service task',
  receiveTask: 'receive task',
  scriptTask: 'script task',
  subProcess: 'subprocess',
  callActivity: 'call activity',
} as const satisfies Record<(typeof ACTIVITY_KINDS)[number], string>;

type BoundaryHostKind = keyof typeof BOUNDARY_HOST_NOUNS;
type BoundaryHost = Extract<FlowElement, { kind: BoundaryHostKind }>;

const isBoundaryHost = (el: FlowElement): el is BoundaryHost =>
  Object.hasOwn(BOUNDARY_HOST_NOUNS, el.kind);

/** One IR kind covers three tags, so `element` decides which noun a host takes. */
const SERVICE_TASK_LIKE_NOUNS = {
  send: 'send task',
  businessRule: 'business rule task',
} as const;

/** The same for the container kind, whose second tag the surface writes `attempt`. */
const SUB_PROCESS_NOUNS = {
  transaction: 'attempt block',
} as const;

function boundaryHostNoun(host: BoundaryHost): string {
  if (host.kind === 'serviceTask' && host.element !== undefined) {
    return SERVICE_TASK_LIKE_NOUNS[host.element];
  }
  if (host.kind === 'subProcess' && host.element !== undefined) {
    return SUB_PROCESS_NOUNS[host.element];
  }
  return BOUNDARY_HOST_NOUNS[host.kind];
}

/** Every remaining kind, named as the surface writes it; the `satisfies` makes a new kind stop the build here. */
const OTHER_FLOW_ELEMENT_NOUNS = {
  startEvent: 'start',
  endEvent: 'end',
  intermediateThrowEvent: 'emit',
  intermediateCatchEvent: 'wait',
  boundaryEvent: 'handler on a step',
  exclusiveGateway: 'branch point',
  parallelGateway: 'split',
  inclusiveGateway: 'split',
  eventBasedGateway: 'wait with several branches',
} as const satisfies Record<
  Exclude<FlowElement['kind'], BoundaryHostKind>,
  string
>;

const flowElementNoun = (el: FlowElement): string =>
  isBoundaryHost(el) ? boundaryHostNoun(el) : OTHER_FLOW_ELEMENT_NOUNS[el.kind];

/** `a` or `an` by spelling, minus `u`, which the maps above open with only in `user task`. */
const withArticle = (noun: string): string =>
  `${/^[aeio]/i.test(noun) ? 'an' : 'a'} ${noun}`;

/** Every noun a host can be named by, for the refusal that enumerates them. */
const BOUNDARY_HOST_NOUN_LIST = Object.entries(BOUNDARY_HOST_NOUNS).flatMap(
  ([kind, noun]) => {
    if (kind === 'serviceTask') {
      return [noun, ...Object.values(SERVICE_TASK_LIKE_NOUNS)];
    }
    if (kind === 'subProcess') {
      return [noun, ...Object.values(SUB_PROCESS_NOUNS)];
    }
    return [noun];
  },
);

/** The hosts `BpmnParse.parseBoundaryEvents` allows an escalation boundary on. */
const ESCALATION_BOUNDARY_HOST_KINDS: ReadonlySet<BoundaryHostKind> =
  new Set<BoundaryHostKind>(['subProcess', 'callActivity', 'userTask']);

/** A block the surface writes with the `attempt` head: the only cancel host. */
const givesUpItsWork = (el: FlowElement): el is SubProcess =>
  el.kind === 'subProcess' && el.element === 'transaction';

/**
 * Validate every boundary event against its own container. The same pass
 * catches an inbound flow written only as `sequenceFlow/@targetRef`:
 * {@link mapBoundaryEvent} sees only the `incoming` list, which moddle fills
 * from optional `<bpmn:incoming>` children, while Operaton reads `targetRef`.
 */
function checkBoundaryEventHosts(
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
  warnings: ImportWarning[],
): void {
  const activityById = new Map<string, BoundaryHost>();
  for (const el of flowElements) {
    // An event subprocess prints as a bare `on <trigger> { ... }` with no id,
    // so a boundary event on one has nothing to print against.
    if (
      isBoundaryHost(el) &&
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
      'a boundary event carries an incoming sequence flow; it is ' +
        'triggered by its own event, not by an incoming flow',
    );
  }

  for (const el of flowElements) {
    if (el.kind !== 'boundaryEvent') continue;

    const host = activityById.get(el.attachedToRef);
    if (host === undefined) {
      throw new UnsupportedEventFeatureError(
        el.id,
        `attachedToRef "${el.attachedToRef}" does not name ` +
          `${withArticle(formatPlainWordList(BOUNDARY_HOST_NOUN_LIST))} that is ` +
          'itself a flow element of this same container; a boundary event can ' +
          'only attach to an activity alongside it',
      );
    }
    if (
      el.eventDefinition.kind === 'escalation' &&
      !ESCALATION_BOUNDARY_HOST_KINDS.has(host.kind)
    ) {
      throw new UnsupportedEventFeatureError(
        el.id,
        `an escalation boundary event attaches to "${el.attachedToRef}", ` +
          `${withArticle(boundaryHostNoun(host))}; Operaton only allows an ` +
          `escalation boundary on ${formatPlainWordList(
            [...ESCALATION_BOUNDARY_HOST_KINDS].map((kind) =>
              withArticle(BOUNDARY_HOST_NOUNS[kind]),
            ),
          )}`,
      );
    }
    if (el.eventDefinition.kind === 'cancel' && !givesUpItsWork(host)) {
      throw new UnsupportedEventFeatureError(
        el.id,
        `a cancel boundary event attaches to "${el.attachedToRef}", ` +
          `${withArticle(boundaryHostNoun(host))}; Operaton only allows a ` +
          'cancel boundary on a <bpmn:transaction>, and refuses to deploy the ' +
          'file otherwise',
        'Attach it to a <bpmn:transaction>, or take the cancel definition off it.',
      );
    }
  }

  checkCancelPairing(flowElements, warnings);
}

/**
 * The cancel end inside a block and the cancel handler on it are one
 * construct. Operaton takes one handler per block and refuses a file with
 * two; either half alone deploys and goes wrong at run time, so a lone half
 * warns rather than refusing.
 */
function checkCancelPairing(
  flowElements: FlowElement[],
  warnings: ImportWarning[],
): void {
  const boundaryByHost = new Map<string, string>();
  for (const el of flowElements) {
    if (el.kind !== 'boundaryEvent') continue;
    if (el.eventDefinition.kind !== 'cancel') continue;
    if (boundaryByHost.has(el.attachedToRef)) {
      throw new UnsupportedEventFeatureError(
        el.id,
        `a second cancel boundary event attaches to "${el.attachedToRef}"; ` +
          'Operaton allows one cancel boundary per block and refuses to ' +
          'deploy a file with two',
        'Leave one cancel boundary event on the block.',
      );
    }
    boundaryByHost.set(el.attachedToRef, el.id);
  }

  for (const el of flowElements) {
    if (!givesUpItsWork(el)) continue;
    const boundaryId = boundaryByHost.get(el.id);
    const givenUp = el.flowElements.some(
      (child) =>
        child.kind === 'endEvent' && child.eventDefinition?.kind === 'cancel',
    );
    if (givenUp && boundaryId === undefined) {
      warnings.push({
        elementId: el.id,
        category: 'unmappedConstruct',
        message:
          `The block '${el.id}' holds an end event that gives it up, with ` +
          'no cancel boundary event attached to it: Operaton deploys the ' +
          'file and then stops with an error the first time that end is ' +
          `reached. Write 'on ${el.id}: cancel { ... }' beside the block to ` +
          'catch it.',
      });
    }
    if (!givenUp && boundaryId !== undefined) {
      warnings.push({
        elementId: boundaryId,
        category: 'unmappedConstruct',
        message:
          `The cancel boundary event on '${el.id}' was imported, but ` +
          'nothing inside the block gives it up, so what follows the ' +
          'boundary can never run.',
      });
    }
  }
}

/**
 * `BpmnParse.parseEventBasedGateway` refuses a branch target that is not an
 * `intermediateCatchEvent`, and `BpmnParse.parseSequenceFlow` refuses any
 * other flow into a catch such a gateway opens; the engine misses the case
 * where every path in comes from an event-based gateway, so the second
 * refusal counts the paths instead. Neither shape is writable on the surface.
 */
function checkWaitBranches(
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
): void {
  const waitIds = new Set(
    flowElements
      .filter((el) => el.kind === 'eventBasedGateway')
      .map((el) => el.id),
  );
  if (waitIds.size === 0) return;

  const byId = new Map(flowElements.map((el) => [el.id, el]));
  const incoming = new Map<string, number>();
  for (const sf of sequenceFlows) {
    incoming.set(sf.targetRef, (incoming.get(sf.targetRef) ?? 0) + 1);
  }

  for (const sf of sequenceFlows) {
    if (!waitIds.has(sf.sourceRef)) continue;

    const target = byId.get(sf.targetRef);
    if (target?.kind !== 'intermediateCatchEvent') {
      const named =
        target === undefined
          ? 'which names nothing beside it'
          : withArticle(flowElementNoun(target));
      throw new UnsupportedEventFeatureError(
        sf.targetRef,
        `a branch of the wait '${sf.sourceRef}' leads to ` +
          `'${sf.targetRef}', ${named}; every branch of a wait with ` +
          'several branches has to begin with something to wait for, and ' +
          'only a message, a timer, a signal, or a condition counts as one ' +
          'here',
        'Begin each branch with a message, timer, signal, or condition to ' +
          'wait for, and put the steps that follow it inside that branch.',
      );
    }

    // No script can write this shape: the printer reaches a branch only
    // through the wait that opens it.
    if ((incoming.get(target.id) ?? 0) > 1) {
      throw new UnsupportedEventFeatureError(
        target.id,
        `'${target.id}' is reached by more than one path; a step inside a ` +
          'wait with several branches can only be reached through the wait ' +
          'that opens it',
        `Leave '${target.id}' with the one path into it that starts at ` +
          `'${sf.sourceRef}', and lead the rest elsewhere.`,
      );
    }
  }
}

/** A `bpmn:SubProcess` or a `bpmn:Transaction`, which differ only in the tag they serialize back to. */
function mapSubProcess(
  el: ModdleElement,
  warnings: ImportWarning[],
  element?: 'transaction',
): SubProcess {
  const id = requireId(el);
  collectLaneDrops(el, id, warnings);
  if (element === 'transaction') warnIgnoredTransactionAttrs(el, id, warnings);
  const named = readNamed(el, id, warnings);
  const { flowElements, sequenceFlows } = mapContainer(
    el,
    warnings,
    element ?? 'subProcess',
  );

  return {
    kind: 'subProcess',
    id,
    ...named,
    ...(element === undefined ? {} : { element }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
    flowElements,
    sequenceFlows,
  };
}

/**
 * The BPMN attributes of a `<bpmn:transaction>` that `parseTransaction` reads
 * nothing of, reported by hand for the reason {@link warnIgnoredQuantityAttrs}
 * gives.
 */
const IGNORED_TRANSACTION_ATTRS: ReadonlyMap<string, string> = new Map([
  ['method', 'Operaton reads it on a <bpmn:transaction> not at all'],
  ['protocol', 'Operaton reads it on a <bpmn:transaction> not at all'],
  [
    'triggeredByEvent',
    'Operaton ignores it on a <bpmn:transaction> and runs the block as an ' +
      'ordinary step of the surrounding flow',
  ],
]);

function warnIgnoredTransactionAttrs(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): void {
  for (const [name, reason] of IGNORED_TRANSACTION_ATTRS) {
    // An absent attribute reads back as undefined or as the moddle default false.
    const value: unknown = el.get(name);
    if (value === undefined || value === false) continue;
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The '${name}' attribute on '${id}' was not imported: ${reason}, so ` +
        'the imported block runs exactly as the source document does.',
    });
  }
}

function mapEventSubProcess(
  el: ModdleElement,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): SubProcess {
  const id = requireId(el);
  refuseLoopCharacteristics(el, id);
  refuseIoMapping(el, id, 'checkActivityInputOutputSupported');

  collectLaneDrops(el, id, warnings);
  warnNamedDrop(el, id, 'an event handler', warnings);

  const children = el.get('flowElements') as ModdleElement[];
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

  const settings = readEngineAttributes(el, id, warnings);
  const timerStarted = eventDefinitionsOf(startEvents[0]).some(
    (def) => def.$type === 'bpmn:TimerEventDefinition',
  );
  return {
    kind: 'subProcess',
    id,
    triggeredByEvent: true,
    ...(timerStarted
      ? dropContinuationCopyOfTimerJobSettings(settings, id, warnings)
      : settings),
    flowElements,
    sequenceFlows,
  };
}

/**
 * A timer-started event sub-process prints as a host-less `on timer(...)`
 * whose head spells the timer job keys once, for the start's timer job. The
 * sub-process's own copy reaches only its async continuation job
 * (`BpmnParse.createActivityOnScope`, `parseAsynchronousContinuation`,
 * `DefaultFailedJobParseListener.parseSubProcess`) and has no spelling on the
 * surface; kept on the node, it would print into the head beside the start's.
 */
function dropContinuationCopyOfTimerJobSettings(
  settings: EngineAttributes,
  id: string,
  warnings: ImportWarning[],
): Omit<EngineAttributes, TimerJobKey> {
  const { timer, continuation } = splitTimerJobSettings(settings);
  for (const key of Object.keys(timer)) {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The '${key}' setting on '${id}' was not imported: the 'on timer' ` +
        `head's ${key} configures the timer job its start event creates, ` +
        "and the event sub-process's own copy, which only its async " +
        'continuation job takes, has no spelling in the script.',
    });
  }
  return continuation;
}

function mapEventSubProcessStart(
  startEl: ModdleElement,
  handlerId: string,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): StartEvent {
  const id = requireId(startEl);
  refuseIoMapping(startEl, id, 'ensureNoIoMappingDefined');
  const defs = eventDefinitionsOf(startEl);
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

  // Operaton's compensation-handler lookup never asks what tag the block
  // carries, so a transaction hosts one as a subprocess does.
  if (
    eventDefinition.kind === 'compensation' &&
    hostKind !== 'subProcess' &&
    hostKind !== 'transaction'
  ) {
    throw new UnsupportedEventFeatureError(
      handlerId,
      'a compensation handler must be hosted directly by the block whose ' +
        `completed work it undoes, not by ${
          hostKind === 'process' ? 'the process' : 'another event subprocess'
        }; move it inside that block`,
    );
  }

  const isInterrupting =
    startEl.get('isInterrupting') === false ? false : undefined;
  if (
    isInterrupting === false &&
    (eventDefinition.kind === 'error' ||
      eventDefinition.kind === 'compensation')
  ) {
    throw new UnsupportedEventFeatureError(
      handlerId,
      eventDefinition.kind === 'error'
        ? 'an error handler cannot be non-interrupting (isInterrupting="false")' +
            '; BPMN requires an error trigger to interrupt its scope'
        : 'a compensation handler cannot be non-interrupting ' +
            '(isInterrupting="false"); BPMN requires a compensation trigger ' +
            'to interrupt its scope',
    );
  }

  // Unlike a boundary event, the start under an `on` header has a label slot;
  // warnElidedNamedDrop reports the pair if the statement does not print.
  const named = readNamed(startEl, id, warnings);
  return {
    kind: 'startEvent',
    id,
    ...named,
    eventDefinition,
    ...(isInterrupting === false ? { isInterrupting: false } : {}),
    ...readStartAttributes(startEl, id, 'eventSubProcess', warnings),
    ...readEngineAttributes(startEl, id, warnings),
  };
}

/** The trigger kinds a `cancelActivity="false"` boundary refuses on; every other kind writes as `alongside`. */
const NON_INTERRUPTING_REFUSALS: Partial<
  Record<EventDefinition['kind'], string>
> = {
  error:
    'an error boundary event cannot be non-interrupting ' +
    '(cancelActivity="false"); BPMN gives an error boundary no ' +
    'non-interrupting form',
  cancel:
    'a cancel boundary event cannot be non-interrupting ' +
    '(cancelActivity="false"); Operaton deploys it and lets what follows ' +
    'the boundary run beside the block instead of taking over from it, ' +
    'which this surface cannot write back',
};

/** `attachedToRef` resolves to the host element; only its `id` is kept, and {@link checkBoundaryEventHosts} validates it afterwards. */
function mapBoundaryEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
  containerEl: ModdleElement,
): BoundaryEvent {
  const id = requireId(el);

  const hostEl = getEl(el, 'attachedToRef');
  if (hostEl === undefined) {
    throw new UnsupportedEventFeatureError(
      id,
      'a boundary event has no attachedToRef; BPMN requires every ' +
        'boundary event to attach to an activity in its own container',
    );
  }

  const incoming = el.get('incoming') as ModdleElement[];
  if (incoming.length > 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'a boundary event carries an incoming sequence flow; it is ' +
        'triggered by its own event, not by an incoming flow',
    );
  }

  refuseIoMapping(el, id, 'ensureNoIoMappingDefined');

  const defs = eventDefinitionsOf(el);
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
      describePairedBoundary(containerEl, id, hostEl) ??
        COMPENSATION_BOUNDARY_DETAIL,
    );
  }

  const eventDefinition = readCatchEventDefinition(
    defEl,
    id,
    warnings,
    'boundary',
  );
  warnNamedDrop(el, id, 'a boundary event', warnings);

  const cancelActivity = el.get('cancelActivity') === false ? false : undefined;
  const nonInterrupting = NON_INTERRUPTING_REFUSALS[eventDefinition.kind];
  if (cancelActivity === false && nonInterrupting !== undefined) {
    throw new UnsupportedEventFeatureError(id, nonInterrupting);
  }

  return {
    kind: 'boundaryEvent',
    id,
    attachedToRef: requireId(hostEl),
    eventDefinition,
    ...(cancelActivity === false ? { cancelActivity: false } : {}),
    ...readEngineAttributes(el, id, warnings),
  };
}

/**
 * `BpmnParse.ensureNoIoMappingDefined` (a start or a boundary event) and
 * `BpmnParse.checkActivityInputOutputSupported` (a gateway or an event
 * sub-process) fail the deployment on an `operaton:inputOutput` here.
 */
function refuseIoMapping(
  el: ModdleElement,
  id: string,
  method: 'ensureNoIoMappingDefined' | 'checkActivityInputOutputSupported',
): void {
  if (!extensionValues(el).some((v) => v.$type === 'operaton:InputOutput')) {
    return;
  }
  const tag = xmlTagOf(el.$type);
  const triggered =
    el.get('triggeredByEvent') === true
      ? " with attribute 'triggeredByEvent = true'"
      : '';
  throw new UnsupportedExtensionFormError(
    id,
    `an operaton:inputOutput mapping on a <${tag}>, which BpmnParse.${method} ` +
      'fails the deployment on ("operaton:inputOutput mapping unsupported ' +
      `for element type '${localNameOf(tag)}'${triggered}")`,
  );
}

/**
 * One event definition on the catch side. An error or escalation definition
 * with no ref, or whose root carries no code, is catch-all; a reference
 * naming no root is not: the engine catches its text as the code
 * ({@link readDanglingErrorCode}) or refuses the file
 * (`createEscalationEventDefinitionForEscalationHandler`).
 */
function readCatchEventDefinition(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
  position: 'start' | 'boundary' | 'intermediate catch',
): EventDefinition {
  collectExtensionDrops(defEl, ownerId, warnings);
  collectUnmappedBpmnDrops(defEl, ownerId, warnings);
  warnDocumentationDrop(defEl, ownerId, 'an event definition', warnings);
  warnCatchSideImplementationAttrs(defEl, ownerId, warnings);

  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    const ref = getEl(defEl, 'errorRef');
    const errorCode = ref
      ? readString(ref, 'errorCode')
      : readDanglingErrorCode(defEl, ownerId, warnings);
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
    const ref = getEl(defEl, 'escalationRef');
    const written = unresolvedRef(defEl, 'escalationRef');
    if (ref === undefined && written !== undefined) {
      throw new UnsupportedEventFeatureError(
        ownerId,
        danglingEscalationDetail(
          written,
          'createEscalationEventDefinitionForEscalationHandler',
        ),
      );
    }
    const escalationCode = ref ? readString(ref, 'escalationCode') : undefined;
    const codeVariable = readNamespacedAttr(defEl, 'escalationCodeVariable');
    return {
      kind: 'escalation',
      ...(escalationCode === undefined ? {} : { escalationCode }),
      ...(codeVariable === undefined ? {} : { codeVariable }),
    };
  }

  const shared = readSharedEventDefinition(defEl, ownerId);
  if (shared !== undefined) return shared;

  if (defEl.$type === 'bpmn:TimerEventDefinition') {
    return { kind: 'timer', ...readTimerDefinition(defEl, ownerId) };
  }

  if (defEl.$type === 'bpmn:ConditionalEventDefinition') {
    return {
      kind: 'conditional',
      condition: readConditionalDefinition(defEl, ownerId, warnings),
    };
  }

  // BPMN has no cancel start, and Operaton refuses a cancel intermediate catch.
  if (defEl.$type === 'bpmn:CancelEventDefinition' && position === 'boundary') {
    return { kind: 'cancel' };
  }

  // On the catch side only `BpmnParse.parseIntermediateCatchEvent` reads a
  // link: a start ignores it, and `parseBoundaryEvents` refuses it.
  if (
    defEl.$type === 'bpmn:LinkEventDefinition' &&
    position === 'intermediate catch'
  ) {
    return readLinkDefinition(defEl, ownerId);
  }

  // The await site admits no tag the arms above leave unread, so only a start
  // or a boundary reaches this refusal.
  throw new UnsupportedEventDefinitionError(
    ownerId,
    position as 'start' | 'boundary',
    defEl.$type,
  );
}

/**
 * The text of an `errorRef` naming no root, which the engine's four error
 * readers each take as the code (`error == null ? errorRef :
 * error.getErrorCode()`); `undefined` when no reference was written at all.
 */
function readDanglingErrorCode(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): string | undefined {
  const written = unresolvedRef(defEl, 'errorRef');
  if (written === undefined || written === '') return undefined;
  warnings.push({
    elementId: ownerId,
    category: 'unmappedConstruct',
    message:
      `The errorRef '${written}' on '${ownerId}' names no bpmn:error root ` +
      `and imports as the code '${written}': Operaton takes a dangling ` +
      "reference's text as the code " +
      '(BpmnParse.parseBoundaryErrorEventDefinition, ' +
      'parseErrorStartEventDefinition, parseEndEvents, ' +
      'parseOperatonErrorEventDefinitions), and the document written back ' +
      'declares an error root carrying it.',
  });
  return written;
}

/** Unlike an error, an escalation reference the engine cannot resolve fails the deployment. */
function danglingEscalationDetail(written: string, method: string): string {
  return (
    `its escalationRef '${written}' names no bpmn:escalation root, which ` +
    'Operaton refuses to deploy ("could not find escalation with id ' +
    `'${written}'", BpmnParse.${method})`
  );
}

/**
 * `BpmnParse.parseIntermediateLinkEventCatchBehavior` throws on a nameless
 * catch, and `BpmnParse.parseSequenceFlow` fails every flow into a nameless throw.
 */
function readLinkDefinition(
  defEl: ModdleElement,
  ownerId: string,
): EventDefinition {
  const linkName = readString(defEl, 'name');
  if (linkName === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a link definition carries no name; the name is what a link throw and ' +
        'its catch match on, so one without it has nothing to match',
      'Give the link definition a name, and the same name to the throw and ' +
        'the catch it joins.',
    );
  }
  return { kind: 'link', linkName };
}

/** The three definitions read the same on the catch and the throw side; `undefined` leaves the kind to the caller. */
function readSharedEventDefinition(
  defEl: ModdleElement,
  ownerId: string,
): EventDefinition | undefined {
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
  if (defEl.$type === 'bpmn:CompensateEventDefinition') {
    refuseUnsupportedCompensateFeatures(defEl, ownerId);
    return { kind: 'compensation' };
  }
  return undefined;
}

/** moddle reads an absent `waitForCompletion` back as its default `true`, so only an explicit `false` is refused. */
function refuseUnsupportedCompensateFeatures(
  defEl: ModdleElement,
  ownerId: string,
): void {
  const activityRef = getEl(defEl, 'activityRef');
  if (activityRef !== undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a compensation definition targets one activity by reference ' +
        `(activityRef="${requireId(activityRef)}"); this tool always ` +
        'addresses the enclosing scope and cannot target a single activity',
    );
  }
  if (defEl.get('waitForCompletion') === false) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a compensation definition sets waitForCompletion="false"; this tool ' +
        'only imports the default (wait for the compensation to complete) behavior',
    );
  }
}

/**
 * The name is carried as written, an expression included:
 * `BpmnParse.parseMessages` and `BpmnParse.parseSignals` evaluate every name
 * through `createExpression`, and the script reads a quoted name opening with
 * `${` or `#{` back as the same text.
 */
function resolveNamedRootRef(
  defEl: ModdleElement,
  refProperty: 'messageRef' | 'signalRef',
  ownerId: string,
  label: 'message' | 'signal',
): string {
  const rootKind = label === 'message' ? 'bpmn:Message' : 'bpmn:Signal';
  const ref = getEl(defEl, refProperty);
  const written =
    ref === undefined ? unresolvedRef(defEl, refProperty) : undefined;
  if (written !== undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      `its ${refProperty} '${written}' names no ${rootKind} root: this tool ` +
        'matches the reference to a root id as written, where Operaton ' +
        'resolves a prefixed reference through the xmlns table ' +
        '(BpmnParse.resolveName) and refuses an unresolved one',
    );
  }
  const name = ref ? readString(ref, 'name') : undefined;
  if (name === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      `a ${label} definition must reference a ${rootKind} root with a non-empty name`,
    );
  }
  return name;
}

const TIMER_CHILD_TO_KIND = invert(TIMER_KIND_TO_CHILD);

function readTimerDefinition(
  defEl: ModdleElement,
  ownerId: string,
): { timerKind: TimerKind; expression: string } {
  const childNames = Object.keys(
    TIMER_CHILD_TO_KIND,
  ) as (keyof typeof TIMER_CHILD_TO_KIND)[];
  const present = childNames.filter(
    (childName) => getEl(defEl, childName) !== undefined,
  );

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

/** Neither is declared by the moddle extension, so both surface in `$attrs` alone. */
const CONDITIONAL_NARROWING_ATTRS: readonly string[] = [
  'variableName',
  'variableEvents',
];

function readConditionalDefinition(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): string {
  for (const localName of CONDITIONAL_NARROWING_ATTRS) {
    if (defEl.$attrs[`operaton:${localName}`] !== undefined) {
      throw new UnsupportedEventFeatureError(
        ownerId,
        `a conditional definition's operaton:${localName} narrows when the ` +
          'condition is (re-)evaluated, which this tool cannot represent',
      );
    }
  }

  const conditionEl = getEl(defEl, 'condition');
  if (conditionEl !== undefined) {
    checkConditionExpressionForm(conditionEl, ownerId, warnings);
  }
  const condition = conditionEl ? readString(conditionEl, 'body') : undefined;
  if (condition === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      'a conditional definition must carry a condition with a non-empty body',
    );
  }
  noteRewrappedExpression(condition, ownerId, 'bpmn:condition', warnings);
  return condition;
}

/**
 * One event definition on the throw side. Only an intermediate throw reaches
 * this with a link: {@link mapEndEvent} refuses one by tag first, since
 * Operaton runs a link end as a none end.
 */
function readThrowEventDefinition(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): EventDefinition {
  // Every position reaching here runs `parseSignalEventDefinition` with
  // `isThrowing=true`, which is what reads `async` and `operaton:in`.
  collectExtensionDrops(defEl, ownerId, warnings, 'throw');
  collectUnmappedBpmnDrops(defEl, ownerId, warnings);
  warnDocumentationDrop(defEl, ownerId, 'an event definition', warnings);
  warnThrowSideBindingAttrs(defEl, ownerId, warnings);

  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    const ref = getEl(defEl, 'errorRef');
    if (ref === undefined) {
      const errorCode = readDanglingErrorCode(defEl, ownerId, warnings);
      if (errorCode !== undefined) return { kind: 'error', errorCode };
      throw new UnsupportedEventFeatureError(
        ownerId,
        'its error definition carries no errorRef, which Operaton refuses ' +
          "to deploy (\"'errorRef' attribute is mandatory on error end " +
          'event", BpmnParse.parseEndEvents)',
      );
    }
    const errorCode = readString(ref, 'errorCode');
    if (errorCode === undefined) {
      throw new UnsupportedEventFeatureError(
        ownerId,
        `its errorRef names the bpmn:error root '${ref.id}', which carries ` +
          "no code; Operaton refuses to deploy the throw (\"'errorCode' is " +
          'mandatory on errors referenced by throwing error event ' +
          'definitions", BpmnParse.parseEndEvents)',
      );
    }
    return { kind: 'error', errorCode };
  }

  const shared = readSharedEventDefinition(defEl, ownerId);
  if (shared !== undefined) return shared;

  if (defEl.$type === 'bpmn:LinkEventDefinition') {
    return readLinkDefinition(defEl, ownerId);
  }

  const ref = getEl(defEl, 'escalationRef');
  if (ref === undefined) {
    const written = unresolvedRef(defEl, 'escalationRef');
    throw new UnsupportedEventFeatureError(
      ownerId,
      written === undefined
        ? 'its escalation definition carries no escalationRef, which ' +
            'Operaton refuses to deploy ("escalationEventDefinition does ' +
            "not have required attribute 'escalationRef'\", " +
            'BpmnParse.findEscalationForEscalationEventDefinition)'
        : danglingEscalationDetail(
            written,
            'findEscalationForEscalationEventDefinition',
          ),
    );
  }
  const escalationCode = readString(ref, 'escalationCode');
  if (escalationCode === undefined) {
    throw new UnsupportedEventFeatureError(
      ownerId,
      `its escalationRef names the bpmn:escalation root '${ref.id}', which ` +
        'carries no code; Operaton refuses to deploy a throw of one ' +
        '("throwing escalation event must have an \'escalationCode\'", ' +
        'BpmnParse.parseIntermediateThrowEvent; "escalation end event must ' +
        "have an 'escalationCode'\", parseEndEvents)",
    );
  }
  return { kind: 'escalation', escalationCode };
}

/** Throw and catch carry the same definition `$type`, and the catch side reads these names, so the sweep cannot report them. */
function warnThrowSideBindingAttrs(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  const names =
    defEl.$type === 'bpmn:ErrorEventDefinition' ||
    defEl.$type === 'operaton:ErrorEventDefinition'
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
 * `BpmnParse.parseIntermediateThrowEvent` returns before creating an activity
 * for a link throw, so the engine never reads these; the tables mark them
 * read on every intermediate throw for the other emit kinds' sake.
 */
function warnLinkThrowEngineSettings(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): void {
  const { executionListeners, ...settings } = readEngineAttributes(
    el,
    id,
    warnings,
  );
  const report = (what: string, does: string): void => {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The ${what} on '${id}' was not imported: Operaton creates no ` +
        `activity for a link throw, so it never ${does} one.`,
    });
  };
  for (const key of Object.keys(settings)) {
    report(`'${key}' setting`, 'reads a setting on');
  }
  for (const listener of executionListeners ?? []) {
    report(`'${listener.event}' execution listener`, 'runs a listener on');
  }
  for (const block of extensionValues(el)) {
    if (block.$type === 'operaton:Properties') {
      report('operaton:properties block', 'reads a property list on');
    }
    if (block.$type === 'operaton:InputOutput') {
      report('operaton:inputOutput block', 'reads a mapping on');
    }
  }
}

/** The mirror of {@link warnThrowSideBindingAttrs}: only a throw sends the message, so a catch reads no implementation. */
function warnCatchSideImplementationAttrs(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  if (defEl.$type !== 'bpmn:MessageEventDefinition') return;
  const report = (what: string): void => {
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `The ${what} on '${ownerId}' only takes effect on a throw ` +
        "('throw message' or 'emit message'); it has no effect on a catch and " +
        'was not imported.',
    });
  };
  for (const name of [...IMPLEMENTATION_ATTRS, ...IMPLEMENTATION_EXTRA_ATTRS]) {
    if (readNamespacedAttr(defEl, name) !== undefined) {
      report(`'${name}' setting`);
    }
  }
  for (const child of extensionValues(defEl)) {
    if (IMPLEMENTATION_EXTRA_CHILDREN.includes(child.$type)) {
      report(childSubject(child));
    }
  }
}

/** {@link describeChild} without its article, for a sentence that leads with the child. */
function childSubject(child: ModdleElement): string {
  return describeChild(child, child.$type).replace(/^an /, '');
}

/**
 * Report what a start or end the printer may leave unprinted takes with it.
 * {@link isElidedOnPrint} decides a start's fate alone; an end's is settled
 * by print position, unknown here, so an end's message covers both outcomes.
 */
function warnElidedNamedDrop(
  el: StartEvent | EndEvent,
  container: PrintContainer,
  startTriggerSuppressed: boolean,
  warnings: ImportWarning[],
): void {
  if (!isElidedOnPrint(el, container, startTriggerSuppressed)) return;
  const isStart = el.kind === 'startEvent';
  const report = (
    category: ImportWarningCategory,
    subject: string,
    noun: string = category,
  ): void => {
    const message = isStart
      ? `The ${subject} on '${el.id}' was not written to the script: ` +
        `'${el.id}' is the kind of name this tool generates for itself, ` +
        `which a script cannot repeat, so this start is left out ` +
        `entirely and its ${noun} with it. Rename it in the diagram to ` +
        `keep the ${noun}.`
      : `The ${subject} on '${el.id}' cannot be kept as written: ` +
        `'${el.id}' is the kind of name this tool generates for itself, ` +
        `which a script cannot repeat. Where the script can do without ` +
        `this end, it is left out and its ${noun} with it; anywhere else ` +
        `it prints under that name and is refused when read back. ` +
        `Rename it in the diagram to keep the ${noun}.`;
    warnings.push({ elementId: el.id, category, message });
  };
  if (el.name !== undefined) report('label', `label '${el.name}'`);
  if (el.documentation !== undefined) report('documentation', 'documentation');
  if (el.kind === 'startEvent' && el.initiator !== undefined) {
    report('extensionAttribute', "'operaton:initiator' setting", 'initiator');
  }
}

/** The label and the documentation of an element whose position has no IR node to hold either; `surface` names that position. */
function warnNamedDrop(
  el: ModdleElement,
  id: string,
  surface: string,
  warnings: ImportWarning[],
  derived?: string,
): void {
  const label = readDerivableName(el, id, derived);
  if (label !== undefined) {
    warnings.push({
      elementId: id,
      category: 'label',
      message:
        `The label '${label}' on '${id}' was not imported: ${surface} has no ` +
        "label in this tool's surface.",
    });
  }
  warnDocumentationDrop(el, id, surface, warnings);
}

/** A `bpmn:documentation` at a position with no IR node to hold it; a position that holds one reads it through {@link readNamed}. */
function warnDocumentationDrop(
  el: ModdleElement,
  id: string,
  surface: string,
  warnings: ImportWarning[],
): void {
  if (documentationChildren(el).length === 0) return;
  warnings.push({
    elementId: id,
    category: 'documentation',
    message:
      `The documentation on '${id}' was not imported: ${surface} has no ` +
      "documentation in this tool's surface.",
  });
}

function mapCallActivity(
  el: ModdleElement,
  warnings: ImportWarning[],
): CallActivity {
  const id = requireId(el);
  const named = readNamed(el, id, warnings);

  const calledElement = readString(el, 'calledElement');
  // `BpmnParse.parseCallActivity` refuses neither and both, and runs a
  // `caseRef` alone through `CaseCallActivityBehavior`.
  const caseRef = readNamespacedAttr(el, 'caseRef');
  if (calledElement === undefined) {
    throw new UnsupportedCallActivityError(
      id,
      caseRef === undefined
        ? 'it names neither a calledElement nor an operaton:caseRef, which ' +
            'BpmnParse.parseCallActivity refuses to deploy ("Missing ' +
            "attribute 'calledElement' or 'caseRef'\")"
        : `it names operaton:caseRef="${caseRef}" and no calledElement, so ` +
            'BpmnParse.parseCallActivity runs a case through ' +
            'CaseCallActivityBehavior, which this surface has no form for',
    );
  }
  if (caseRef !== undefined) {
    throw new UnsupportedCallActivityError(
      id,
      `it names a calledElement beside operaton:caseRef="${caseRef}", which ` +
        'BpmnParse.parseCallActivity refuses to deploy ("The attributes ' +
        "'calledElement' or 'caseRef' cannot be used together\")",
    );
  }
  const tenantId = readNamespacedAttr(el, 'calledElementTenantId');
  if (tenantId !== undefined) {
    throw new UnsupportedCallActivityError(
      id,
      tenantPinDetail('calledElementTenantId', tenantId, 'called process'),
    );
  }

  const binding = readVersionBinding(
    el,
    id,
    'calledElement',
    (detail) => new UnsupportedCallActivityError(id, detail),
    warnings,
  );
  const { businessKey, inMappings, outMappings } = readCallMappings(
    el,
    id,
    warnings,
  );
  const mapper = readCallVariableMapper(el, id, warnings);

  return {
    kind: 'callActivity',
    id,
    ...named,
    calledElement,
    ...(binding === undefined ? {} : { binding }),
    ...(businessKey === undefined ? {} : { businessKey }),
    ...(mapper === undefined ? {} : { mapper }),
    ...(inMappings === undefined ? {} : { inMappings }),
    ...(outMappings === undefined ? {} : { outMappings }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

/**
 * `BpmnParse.parseCallActivity` resolves the variable-mapping delegate class
 * first and drops the delegate expression beside it, which loses nothing the
 * engine runs, so the loser warns rather than refuses.
 */
function readCallVariableMapper(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): CallVariableMapper | undefined {
  const classAttr = VARIABLE_MAPPING_ATTR_BY_KIND.class;
  const delegateAttr = VARIABLE_MAPPING_ATTR_BY_KIND.delegateExpression;
  const className = readNamespacedAttr(el, classAttr);
  const expression = readNamespacedAttr(el, delegateAttr);

  if (className !== undefined && expression !== undefined) {
    warnings.push(
      buildShadowedImplementationWarning(
        id,
        delegateAttr,
        `operaton:${classAttr}`,
      ),
    );
  }

  if (className !== undefined) return { kind: 'class', className };
  if (expression !== undefined)
    return { kind: 'delegateExpression', expression };
  return undefined;
}

/** The one refusal `BpmnParse.parseTenantId` draws; `what` is the callable the tenant scopes. */
function tenantPinDetail(attr: string, value: string, what: string): string {
  return (
    `it names operaton:${attr}="${value}", which pins the tenant ` +
    `BpmnParse.parseTenantId resolves the ${what} against; dropping it ` +
    `would change which ${what} runs, and this surface has no tenant setting`
  );
}

/**
 * The `<prefix>Binding`/`<prefix>Version` pair, the inverse of `ir-to-xml.ts`'s
 * `versionBindingAttrs`. A word outside `BpmnParse.parseBinding`'s four leaves
 * the binding null, which `BaseCallableElement.isLatestBinding` reads as
 * latest, so it imports as such; `parseFormDefinition` refuses the same word
 * on a form reference.
 */
function readVersionBinding(
  el: ModdleElement,
  id: string,
  prefix: 'calledElement' | 'decisionRef' | 'formRef',
  refusal: (detail: string) => Error,
  warnings: ImportWarning[],
): VersionBinding | undefined {
  const bindingValue = readNamespacedAttr(el, `${prefix}Binding`);
  const version = readNamespacedAttr(el, `${prefix}Version`);

  let binding: VersionBinding | undefined;
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
        throw refusal(
          `${prefix}Binding="version" is set without a ${prefix}Version, so ` +
            'the engine cannot resolve which version to use',
        );
      }
      binding = { kind: 'version', version };
      break;
    case 'versionTag':
      throw refusal(
        prefix === 'formRef'
          ? formRefBindingRefusal(bindingValue)
          : `${prefix}Binding="versionTag" pins a version tag, which this ` +
              'surface has no setting for',
      );
    default:
      if (prefix === 'formRef')
        throw refusal(formRefBindingRefusal(bindingValue));
      binding = { kind: 'latest' };
      warnings.push({
        elementId: id,
        category: 'unmappedConstruct',
        message:
          `The ${prefix}Binding="${bindingValue}" on '${id}' imports as ` +
          'binding: latest: BpmnParse.parseBinding sets no binding for that ' +
          'word and BaseCallableElement.isLatestBinding reads none as ' +
          `latest, and this tool writes it back as ${prefix}Binding="latest", ` +
          'which the engine reads the same.',
      });
      break;
  }

  if (version !== undefined && binding?.kind !== 'version') {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The '${prefix}Version' setting on '${id}' has no effect without ` +
        `${prefix}Binding="version" and was not imported.`,
    });
  }

  return binding;
}

function formRefBindingRefusal(word: string): string {
  return (
    `formRefBinding="${word}" is outside the bindings ` +
    'BpmnParse.parseFormDefinition resolves (deployment, latest, version), ' +
    'so the engine refuses to deploy it'
  );
}

interface CallMappings {
  businessKey?: string;
  inMappings?: CallVariableMapping[];
  outMappings?: CallVariableMapping[];
}

function warnMappingAttrIgnored(
  warnings: ImportWarning[],
  ownerId: string,
  tag: string,
  attr: string,
  winner: string,
  why: string,
): void {
  warnings.push({
    elementId: ownerId,
    category: 'extensionAttribute',
    message:
      `The '${attr}' on an ${tag} of '${ownerId}' has no effect alongside ` +
      `${winner} and was not imported: ${why}.`,
  });
}

/**
 * `BpmnParse.parseInputParameter` takes a non-empty `businessKey` and reads
 * nothing else off that `operaton:in`, and a later one overwrites the earlier
 * through `setBusinessKeyValueProvider`.
 */
function readCallMappings(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): CallMappings {
  const values = extensionValues(el);

  let businessKey: string | undefined;
  const inMappings: CallVariableMapping[] = [];
  const outMappings: CallVariableMapping[] = [];

  for (const value of values) {
    if (value.$type === 'operaton:In') {
      const candidateBusinessKey = readString(value, 'businessKey');
      if (candidateBusinessKey !== undefined) {
        if (businessKey !== undefined) {
          warnings.push({
            elementId: id,
            category: 'extensionAttribute',
            message:
              `The operaton:in businessKey="${businessKey}" on '${id}' has ` +
              'no effect alongside a later one and was not imported: ' +
              'BpmnParse.parseInputParameter hands each to ' +
              'setBusinessKeyValueProvider, and the last stands.',
          });
        }
        const ignored = [
          ...['source', 'sourceExpression', 'target', 'variables'].filter(
            (attr) => readString(value, attr) !== undefined,
          ),
          ...(value.get('local') === true ? ['local'] : []),
        ];
        for (const attr of ignored) {
          warnMappingAttrIgnored(
            warnings,
            id,
            'operaton:in',
            attr,
            'businessKey',
            'BpmnParse.parseInputParameter reads the business key alone off ' +
              'that element',
          );
        }
        businessKey = candidateBusinessKey;
        continue;
      }
      inMappings.push(
        readCallVariableMapping(value, id, 'operaton:in', warnings),
      );
    } else if (value.$type === 'operaton:Out') {
      outMappings.push(
        readCallVariableMapping(value, id, 'operaton:out', warnings),
      );
    }
  }

  return {
    ...(businessKey === undefined ? {} : { businessKey }),
    ...(inMappings.length > 0 ? { inMappings } : {}),
    ...(outMappings.length > 0 ? { outMappings } : {}),
  };
}

/**
 * In `BpmnParse.parseCallableElementProvider`'s order: `variables="all"`
 * returns before any source is read, and a non-empty `source` is taken
 * before `sourceExpression` is looked at; an empty `source` is a deployment
 * error under the strict validation the engine runs by default.
 */
function readCallVariableMapping(
  value: ModdleElement,
  ownerId: string,
  tag: 'operaton:in' | 'operaton:out',
  warnings: ImportWarning[],
): CallVariableMapping {
  const source = readString(value, 'source');
  const sourceExpression = readString(value, 'sourceExpression');
  const variables = readString(value, 'variables');
  const target = readString(value, 'target');
  const local = value.get('local') === true ? { local: true as const } : {};
  const ignored = (attr: string, winner: string, why: string): void =>
    warnMappingAttrIgnored(warnings, ownerId, tag, attr, winner, why);

  if (variables !== undefined) {
    if (variables !== 'all') {
      throw new UnsupportedCallActivityError(
        ownerId,
        `an ${tag} carries variables="${variables}", which this tool cannot ` +
          'import (only variables="all" is supported)',
      );
    }
    for (const attr of ['source', 'sourceExpression', 'target']) {
      if (readString(value, attr) === undefined) continue;
      ignored(
        attr,
        'variables="all"',
        'BpmnParse.parseCallableElementProvider passes every variable and ' +
          'reads nothing else',
      );
    }
    return { kind: 'all', ...local };
  }

  if (value.get('source') === '') {
    throw new UnsupportedCallActivityError(
      ownerId,
      `an ${tag} carries source="", which ` +
        'BpmnParse.parseCallableElementProvider refuses to deploy ("Empty ' +
        "attribute 'source' when passing variables\")",
    );
  }

  if (source !== undefined) {
    if (sourceExpression !== undefined) {
      ignored(
        'sourceExpression',
        'source',
        'BpmnParse.parseCallableElementProvider reads source first',
      );
    }
    if (target === undefined) {
      throw new UnsupportedCallActivityError(
        ownerId,
        `an ${tag} carries source without a target`,
      );
    }
    return { kind: 'variable', source, target, ...local };
  }

  if (sourceExpression !== undefined) {
    if (target === undefined) {
      throw new UnsupportedCallActivityError(
        ownerId,
        `an ${tag} carries sourceExpression without a target`,
      );
    }
    return { kind: 'expression', sourceExpression, target, ...local };
  }

  throw new UnsupportedCallActivityError(
    ownerId,
    `an ${tag} carries none of the recognized shapes (source+target, ` +
      'sourceExpression+target, variables="all", or businessKey)',
  );
}

/** One warning per `bpmn:Lane`: the flat IR has no lane concept. */
function collectLaneDrops(
  processEl: ModdleElement,
  processId: string,
  warnings: ImportWarning[],
): void {
  for (const laneSet of processEl.get('laneSets') as ModdleElement[]) {
    warnLaneSetDrops(laneSet, processId, warnings);
  }
}

function warnLaneSetDrops(
  laneSet: ModdleElement,
  fallbackId: string,
  warnings: ImportWarning[],
): void {
  for (const lane of laneSet.get('lanes') as ModdleElement[]) {
    const laneId = lane.id ?? laneSet.id ?? fallbackId;
    const laneName = readString(lane, 'name');
    warnings.push({
      elementId: laneId,
      category: 'lane',
      message:
        `Lane ${laneName ? `'${laneName}' ` : ''}(${laneId}) was not imported; ` +
        'every step is placed in a single flat process.',
    });
    const childLaneSet = getEl(lane, 'childLaneSet');
    if (childLaneSet !== undefined) {
      warnLaneSetDrops(childLaneSet, fallbackId, warnings);
    }
  }
}

/**
 * The element-valued moddle properties some reader in this file reads (a
 * warning sweep counts as a reader); every other BPMN child is reported by
 * {@link collectUnmappedBpmnDrops}.
 */
const READ_BPMN_CHILDREN: ReadonlySet<string> = new Set([
  'completionCondition',
  'condition',
  'conditionExpression',
  'diagrams',
  'documentation',
  'eventDefinitions',
  'extensionElements',
  'flowElements',
  'inputDataItem',
  'laneSets',
  'loopCardinality',
  'loopCharacteristics',
  'loopDataInputRef',
  'messageFlows',
  'participants',
  'rootElements',
  'script',
  ...Object.values(TIMER_KIND_TO_CHILD),
]);

/**
 * One {@link ImportWarning} per piece of BPMN content on `el` that no reader
 * reads: a child outside {@link READ_BPMN_CHILDREN}, and an unnamespaced
 * attribute BPMN does not declare. An attribute in a foreign namespace is
 * left alone: that is where an editor parks its bookkeeping.
 */
function collectUnmappedBpmnDrops(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): void {
  for (const key of Object.keys(el.$attrs)) {
    if (key.includes(':') || key === 'xmlns') continue;
    warnings.push({
      elementId: ownerId,
      category: 'unmappedConstruct',
      message:
        `The '${key}' attribute on '${ownerId}' is not declared by BPMN and ` +
        `was not imported ${IMPORTED_FLOW_NOTE}`,
    });
  }

  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.isAttr === true || prop.isBody === true) continue;
    if (prop.isReference === true) continue;
    if (READ_BPMN_CHILDREN.has(prop.name)) continue;
    // `readAssignment` reads a user task's roles; no other activity's are read.
    if (prop.name === 'resources' && el.$type === 'bpmn:UserTask') continue;
    const value = el.get(prop.name);
    // A single element is spelled as its property (`<bpmn:ioSpecification>`),
    // a list item as its own type.
    const items = Array.isArray(value) ? value : [value];
    const tag = Array.isArray(value) ? undefined : prop.ns?.name;
    for (const item of items) {
      const child = item as ModdleElement | undefined;
      if (typeof child?.$type !== 'string') continue;
      warnings.push({
        elementId: ownerId,
        category: 'unmappedConstruct',
        message:
          `A ${describeUnmapped(child, tag)} on '${ownerId}' was not ` +
          `imported ${IMPORTED_FLOW_NOTE}`,
      });
    }
  }
}

/** The root kinds {@link xmlToIr} handles, the collaboration by {@link warnCollaborationDrops}. */
const HANDLED_ROOT_KINDS: ReadonlySet<string> = new Set([
  'bpmn:Process',
  'bpmn:Collaboration',
  'bpmn:Error',
  'bpmn:Escalation',
  'bpmn:Message',
  'bpmn:Signal',
]);

/**
 * Report the root elements the IR does not model, and the extension content
 * on the ones it does (the process is swept as it is mapped). Returns the ids
 * of the roots reported whole, for {@link collectUnparsableResidualDrops}.
 */
function collectRootDrops(
  rootElements: ModdleElement[],
  processId: string,
  warnings: ImportWarning[],
): ReadonlySet<string> {
  const reportedRootIds = new Set<string>();
  for (const root of rootElements) {
    if (HANDLED_ROOT_KINDS.has(root.$type)) {
      if (root.$type !== 'bpmn:Process') {
        const rootId = root.id ?? processId;
        collectExtensionDrops(root, rootId, warnings);
        warnDocumentationDrop(
          root,
          rootId,
          `a ${xmlTagOf(root.$type)} root`,
          warnings,
        );
      }
      continue;
    }
    warnings.push({
      elementId: root.id ?? processId,
      category: 'unmappedConstruct',
      message:
        `A ${describeUnmapped(root)} root element was not imported ` +
        IMPORTED_FLOW_NOTE,
    });
    if (root.id !== undefined) reportedRootIds.add(root.id);
  }
  return reportedRootIds;
}

/** The XML tag plus the id, or the `name` when there is no id; `tag` overrides the tag derived from the type. */
function describeUnmapped(el: ModdleElement, tag?: string): string {
  const identity = el.id ?? readString(el, 'name');
  const name = tag ?? xmlTagOf(el.$type);
  return identity === undefined ? name : `${name} '${identity}'`;
}

export function dataConstructDropMessage(subject: string): string {
  return (
    `A ${subject} was not imported: Operaton keeps process variables in ` +
    'its own store and never dispatches on it, so the imported process ' +
    'runs identically.'
  );
}

/** A data object or reference, reported whole: no flow ends at one, so no downstream check needs it mapped. */
function warnDataConstructDrop(
  child: ModdleElement,
  hostId: string | undefined,
  warnings: ImportWarning[],
): void {
  warnings.push({
    elementId: child.id ?? hostId ?? '(unknown)',
    category: 'unmappedConstruct',
    message: dataConstructDropMessage(describeUnmapped(child)),
  });
}

/** `qualifier` narrows the {@link ENGINE_READS_ELSEWHERE} lookup to the position its reader runs at (`'throw'`, `'initial'`). */
function collectExtensionDrops(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
  qualifier?: string,
): void {
  warnUnreadPrefixedAttrs(el, ownerId, warnings, qualifier);
  warnUnreadExtensionElements(el, ownerId, warnings, qualifier);
  warnUnreadDeclaredAttrs(el, ownerId, warnings, qualifier);
}

/**
 * Report `operaton:` attributes {@link CONSUMED_EXTENSION_ATTRS} does not list
 * for this owner kind. Any other namespace is left alone: that is where an
 * editor stamps its bookkeeping, and reporting it would bury the drops that
 * matter.
 */
function warnUnreadPrefixedAttrs(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
  qualifier?: string,
): void {
  for (const key of Object.keys(el.$attrs)) {
    const colon = key.indexOf(':');
    if (colon === -1) continue;
    const prefix = key.slice(0, colon);
    const localName = key.slice(colon + 1);
    if (prefix !== 'operaton') continue;
    if (isConsumedHere(CONSUMED_EXTENSION_ATTRS, el.$type, localName)) continue;
    if (localName === 'failedJobRetryTimeCycle') {
      warnings.push({
        elementId: ownerId,
        category: 'extensionAttribute',
        message:
          `The '${key}' setting on '${ownerId}' was not imported: Operaton ` +
          'reads a retry cycle as an <operaton:failedJobRetryTimeCycle> ' +
          'element and never as an attribute ' +
          '(DefaultFailedJobParseListener.setFailedJobRetryTimeCycleValue ' +
          'through BpmnParseUtil.findOperatonExtensionElement), so the ' +
          'document written back runs the same.',
      });
      continue;
    }
    warnUnimportedSetting(
      warnings,
      ownerId,
      `'${key}' setting`,
      el.$type,
      localName,
      qualifier,
    );
  }
}

/** The reason a field drops from a position that holds none. */
const FIELD_HAS_NO_HOME =
  'this tool carries an injected field on the step or the listener whose ' +
  'class or delegate binding receives it, on the step whose built-in mail ' +
  'or shell behaviour does, and on no other position';

/**
 * Report the `<bpmn:extensionElements>` children {@link CONSUMED_EXTENSION_ELEMENTS}
 * does not list for this owner kind. An undeclared `operaton:` element leaves
 * no value behind; {@link collectUnparsableResidualDrops} reports it instead.
 */
function warnUnreadExtensionElements(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
  qualifier?: string,
): void {
  for (const value of extensionValues(el)) {
    if (isConsumedHere(CONSUMED_EXTENSION_ELEMENTS, el.$type, value.$type)) {
      const key = consumedKeyOf(value.$type, 'bpmn:ExtensionElements');
      warnUnreadChildAttrs(
        value,
        ownerId,
        describeChild(value, key),
        warnings,
        key,
      );
      continue;
    }
    if (value.$type === 'operaton:Field') {
      warnFieldDrop(
        value,
        ownerId,
        `'${ownerId}'`,
        FIELD_HAS_NO_HOME,
        warnings,
      );
      continue;
    }
    warnUnimportedSetting(
      warnings,
      ownerId,
      childSubject(value),
      el.$type,
      value.$type,
      qualifier,
    );
  }
}

/**
 * Report the attributes the operaton moddle extension declares that the IR
 * does not read off this owner kind. A declared attribute parses into a typed
 * property, never into `$attrs`, so {@link warnUnreadPrefixedAttrs} cannot
 * see it.
 */
function warnUnreadDeclaredAttrs(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
  qualifier?: string,
): void {
  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.ns === undefined || prop.ns.prefix !== 'operaton') continue;
    if (prop.isAttr !== true) continue;
    if (isConsumedHere(CONSUMED_EXTENSION_ATTRS, el.$type, prop.ns.localName)) {
      continue;
    }
    if (!isAuthored(el, prop.name)) continue;
    warnUnimportedSetting(
      warnings,
      ownerId,
      `'${prop.ns.name}' setting`,
      el.$type,
      prop.ns.localName,
      qualifier,
    );
  }
}

export function unimportedSettingMessage(
  subject: string,
  ownerId: string,
  tag: string,
  reads?: string,
): string {
  return (
    `The ${subject} on '${ownerId}' was not imported: this tool reads no ` +
    `such setting on ${tag}, ` +
    (reads === undefined
      ? 'and the document written back carries none.'
      : `though Operaton ${reads}, so the document written back runs without it.`)
  );
}

/** One setting re-export will not write back; `ownerType` and `name` look up its engine reader in {@link ENGINE_READS_ELSEWHERE}. */
function warnUnimportedSetting(
  warnings: ImportWarning[],
  ownerId: string,
  subject: string,
  ownerType: string,
  name: string,
  qualifier?: string,
): void {
  const reads = ENGINE_READS_ELSEWHERE.get(
    `${qualifier === undefined ? '' : `${qualifier}:`}${ownerType}/${name}`,
  );
  warnings.push({
    elementId: ownerId,
    category: 'extensionAttribute',
    message: unimportedSettingMessage(
      subject,
      ownerId,
      describeTag(ownerType),
      reads,
    ),
  });
}

/** `bpmn:StartEvent` -> `a <bpmn:startEvent>`, `operaton:TaskListener` -> `an <operaton:taskListener>`. */
function describeTag(type: string): string {
  return `${type.startsWith('operaton:') ? 'an' : 'a'} <${xmlTagOf(type)}>`;
}

/**
 * Report every attribute on a consumed extension child that no reader reads,
 * descending through the children the readers do read. Declared attributes
 * (typed properties) and undeclared ones (`$attrs`) are swept apart, since
 * moddle stores them apart. `key` is the table key `el` resolved to under its
 * parent, so a qualified row chains: a child of `a/b` is looked up as `a/b/c`
 * before `c`.
 */
function warnUnreadChildAttrs(
  el: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
  key: string,
): void {
  const consumed = CONSUMED_CHILD_ATTRS.get(key);
  if (consumed === undefined) return;

  const report = (name: string): void =>
    warnUnimportedSetting(
      warnings,
      ownerId,
      `'${name}' on ${where}`,
      el.$type,
      name,
    );

  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.isAttr !== true) continue;
    const localName = prop.ns?.localName ?? prop.name;
    if (consumed.has(localName)) continue;
    if (!isAuthored(el, prop.name)) continue;
    report(localName);
  }
  for (const key of Object.keys(el.$attrs)) {
    if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
    report(key);
  }
  for (const child of childElements(el)) {
    const childKey = consumedKeyOf(child.$type, key);
    warnUnreadChildAttrs(
      child,
      ownerId,
      `${describeChild(child, childKey)} in ${where}`,
      warnings,
      childKey,
    );
  }
}

/** The {@link CONSUMED_CHILD_ATTRS} key for `type` under `parentKey`: the qualified row when one exists, else the bare `$type`. */
function consumedKeyOf(type: string, parentKey: string): string {
  const qualified = `${parentKey}/${type}`;
  return CONSUMED_CHILD_ATTRS.has(qualified) ? qualified : type;
}

/** The child's XML tag plus the identity its row at `key` reads. */
function describeChild(el: ModdleElement, key: string): string {
  const consumed = CONSUMED_CHILD_ATTRS.get(key);
  const identity = CHILD_IDENTITY_ATTRS.filter(
    (attr) => consumed?.has(attr) === true,
  )
    .map((attr) => readString(el, attr))
    .find((value) => value !== undefined);
  const tag = xmlTagOf(el.$type);
  return identity === undefined ? `an ${tag}` : `an ${tag} '${identity}'`;
}

/** The XML tag a moddle `$type` came from: `operaton:TaskListener` -> `operaton:taskListener`. */
function xmlTagOf(type: string): string {
  const local = type.indexOf(':') + 1;
  return (
    type.slice(0, local) +
    type.charAt(local).toLowerCase() +
    type.slice(local + 1)
  );
}

/** The elements moddle materialized under `el`; a string-typed element property (an `operaton:field`'s body) holds none. */
function childElements(el: ModdleElement): ModdleElement[] {
  const children: ModdleElement[] = [];
  for (const prop of el.$descriptor?.properties ?? []) {
    if (prop.isAttr === true || prop.isBody === true) continue;
    if (prop.isReference === true) continue;
    const value = el.get(prop.name);
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof (item as ModdleElement | undefined)?.$type === 'string') {
        children.push(item as ModdleElement);
      }
    }
  }
  return children;
}

/**
 * A `#{...}` body the printer spells as bare DSL comes back inside `${...}`;
 * one it keeps quoted (out of subset or composite) lowers as written.
 */
function noteRewrappedExpression(
  body: string | undefined,
  ownerId: string,
  slot: string,
  warnings: ImportWarning[],
): void {
  if (
    body === undefined ||
    !/^\s*#\{/.test(body) ||
    parseJuel(body).kind !== 'structured'
  ) {
    return;
  }
  warnings.push({
    elementId: ownerId,
    category: 'unmappedConstruct',
    message:
      `The ${slot} on '${ownerId}' is written with "#{...}"; the script ` +
      'prints its body as bare DSL and the rebuilt document writes it ' +
      'inside "${...}", which Operaton evaluates identically.',
  });
}

/** A container's own start; {@link readStartTrigger} bounds what it may carry. */
function mapStartEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): StartEvent {
  const id = requireId(el);
  refuseIoMapping(el, id, 'ensureNoIoMappingDefined');
  const eventDefinition = readStartTrigger(el, id, warnings, hostKind);
  const named = readNamed(el, id, warnings);
  return {
    kind: 'startEvent',
    id,
    ...named,
    ...(eventDefinition === undefined ? {} : { eventDefinition }),
    ...readStartAttributes(el, id, hostKind, warnings),
    ...readEngineAttributes(el, id, warnings),
  };
}

/**
 * The initiator and the start form, read off the process's own start alone:
 * `BpmnParse.parseStartEvents` sends every other start to
 * `parseScopeStartEvent`, which reads neither. Both are marked read on
 * `bpmn:StartEvent`, which silences the sweep for a nested start too, so the
 * drop is reported by hand.
 */
function readStartAttributes(
  el: ModdleElement,
  id: string,
  hostKind: ContainerHostKind,
  warnings: ImportWarning[],
): Pick<StartEvent, 'initiator' | 'formFields'> {
  const initiator = readNamespacedAttr(el, 'initiator');
  if (hostKind === 'process') {
    const formFields = readFormFields(el, id, warnings);
    return {
      ...(formFields === undefined ? {} : { formFields }),
      ...(initiator === undefined ? {} : { initiator }),
    };
  }
  if (initiator !== undefined) {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The 'operaton:initiator' setting on '${id}' was not imported: ` +
        'BpmnParse.parseScopeStartEvent reads no operaton: attribute off a ' +
        "start that is not the process's own " +
        '(parseProcessDefinitionStartEvent reads it there alone), so the ' +
        'document written back runs the same.',
    });
  }
  if (extensionValues(el).some((v) => v.$type === 'operaton:FormData')) {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The operaton:formData block on '${id}' was not imported: ` +
        "BpmnParse.parseStartFormHandlers runs for the process's own start " +
        'alone and parseScopeStartEvent reads no form, so the document ' +
        'written back runs the same.',
    });
  }
  return {};
}

/** The triggers Operaton parses off a process start but never acts on, each with the validator's remedy for the same position. */
const IGNORED_START_SUBJECTS: ReadonlyMap<
  string,
  { subject: string; remedy: string }
> = new Map([
  [
    'bpmn:ErrorEventDefinition',
    {
      subject: 'an error',
      remedy: "Catch it with 'on error' inside the scope that raises it.",
    },
  ],
  [
    'bpmn:EscalationEventDefinition',
    {
      subject: 'an escalation',
      remedy: "Catch it with 'on escalation' inside the scope that raises it.",
    },
  ],
  [
    'bpmn:CompensateEventDefinition',
    {
      subject: 'compensation',
      remedy:
        "Compensation undoes a subprocess's completed work, so it belongs " +
        "in an 'on compensation' block inside that subprocess.",
    },
  ],
]);

/** The tags the triggers of one position are written with; `condition` is the one word the IR spells differently. */
function definitionTagsOf(
  triggers: readonly ((typeof ON_TRIGGERS)[number] | 'link')[],
): readonly string[] {
  return triggers.map(
    (trigger) =>
      EVENT_DEFINITION_TAG[trigger === 'condition' ? 'conditional' : trigger],
  );
}

const START_CARRIED_TAGS = definitionTagsOf(START_TRIGGERS);
const THROW_CARRIED_TAGS = definitionTagsOf(THROW_TRIGGERS);
const EMIT_CARRIED_TAGS = definitionTagsOf(EMIT_TRIGGERS);
const AWAIT_CARRIED_TAGS = definitionTagsOf(CATCH_TRIGGERS);

/** The trigger on a container's own start; an event handler's start goes through {@link mapEventSubProcessStart}. */
function readStartTrigger(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): EventDefinition | undefined {
  const defs = eventDefinitionsOf(el);
  if (defs.length === 0) return undefined;
  if (hostKind !== 'process') {
    throw new UnsupportedEventFeatureError(
      id,
      'a subprocess cannot start on a trigger: Operaton rejects one there ' +
        'when it parses the file; a subprocess is entered from the ' +
        'surrounding process, not by an event of its own',
      "Put the trigger on an 'on' handler inside the subprocess if it should " +
        'react to an event.',
    );
  }
  refuseMultipleEventDefinitions(
    id,
    defs,
    'a start',
    `${formatPlainWordList(START_TRIGGERS)} trigger is supported`,
  );

  const [defEl] = defs;
  const ignored = IGNORED_START_SUBJECTS.get(defEl.$type);
  if (ignored !== undefined) {
    throw new UnsupportedEventFeatureError(
      id,
      `a process cannot start on ${ignored.subject}; Operaton ignores the ` +
        'trigger and starts the process as if none were written, so ' +
        'importing it would write back a document the engine runs ' +
        'differently from what it says',
      ignored.remedy,
    );
  }
  if (!START_CARRIED_TAGS.includes(defEl.$type)) {
    throw new UnsupportedEventDefinitionError(id, 'start', defEl.$type);
  }

  const definition = readCatchEventDefinition(defEl, id, warnings, 'start');
  if (
    definition.kind === 'message' &&
    EXPRESSION_ANYWHERE.test(definition.messageName)
  ) {
    throw new UnsupportedEventFeatureError(
      id,
      `a message start event's message name "${definition.messageName}" is ` +
        'an expression; Operaton rejects an expression there, because a ' +
        'process that has not started yet has no variables to evaluate it ' +
        'against',
      'Give the message a fixed name.',
    );
  }
  return definition;
}

/** The kind a definition tag imports as, or `undefined` for a raised one; a terminate and a cancel print on the end statement itself, which keeps its label. */
function endCarriedKind(
  tag: string,
): (typeof END_TRIGGERS)[number] | undefined {
  return END_TRIGGERS.find((kind) => EVENT_DEFINITION_TAG[kind] === tag);
}

function mapEndEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
  hostKind: ContainerHostKind,
): EndEvent {
  const id = requireId(el);
  refuseEndOutputParameters(el, id);
  const defs = eventDefinitionsOf(el);

  if (defs.length === 0) {
    const named = readNamed(el, id, warnings);
    return {
      kind: 'endEvent',
      id,
      ...named,
      ...readThrowEventAttributes(el, id, undefined, warnings),
    };
  }
  refuseMultipleEventDefinitions(
    id,
    defs,
    'a throw',
    'terminate, cancel, error, escalation, message, signal, or compensation ' +
      'is supported',
  );

  const [defEl] = defs;
  const carried = endCarriedKind(defEl.$type);
  if (carried !== undefined) {
    if (carried === 'cancel' && hostKind !== 'transaction') {
      throw new UnsupportedEventFeatureError(
        id,
        'an end event carries a cancel definition outside a block that can ' +
          'be given up; Operaton only accepts one directly inside a ' +
          '<bpmn:transaction>, and refuses to deploy the file otherwise',
        'Move the end inside a <bpmn:transaction>, or take the cancel ' +
          'definition off it.',
      );
    }
    collectExtensionDrops(defEl, id, warnings);
    collectUnmappedBpmnDrops(defEl, id, warnings);
    warnDocumentationDrop(defEl, id, 'an event definition', warnings);
    const named = readNamed(el, id, warnings);
    return {
      kind: 'endEvent',
      id,
      ...named,
      eventDefinition: { kind: carried },
      ...readThrowEventAttributes(el, id, undefined, warnings),
    };
  }
  if (!THROW_CARRIED_TAGS.includes(defEl.$type)) {
    throw new UnsupportedEventDefinitionError(id, 'end', defEl.$type);
  }

  // The tag check above admits only the five thrown kinds, so the reader's
  // link arm is unreachable here and the cast holds.
  const eventDefinition = readThrowEventDefinition(
    defEl,
    id,
    warnings,
  ) as EndEventDefinition;
  warnNamedDrop(el, id, 'a throw', warnings);

  const binding = readThrownMessageBinding(
    defEl,
    id,
    'messageEndEvent',
    warnings,
  );
  return {
    kind: 'endEvent',
    id,
    eventDefinition,
    ...(binding === undefined ? {} : { binding }),
    ...readThrowEventAttributes(el, id, binding, warnings),
  };
}

/**
 * `BpmnParse.parseEndEvents` runs the mapping through
 * `parseActivityInputOutput`, whose output check fails the deployment on this
 * tag alone; the input half is read there and reported as a drop by the sweep.
 */
function refuseEndOutputParameters(el: ModdleElement, id: string): void {
  const io = onlyIoMapping(el, id);
  const outputs =
    (io?.get('outputParameters') as ModdleElement[] | undefined) ?? [];
  if (outputs.length === 0) return;
  throw new UnsupportedExtensionFormError(
    id,
    'an operaton:outputParameter on a <bpmn:endEvent>, which ' +
      'BpmnParse.checkActivityOutputParameterSupported fails the deployment ' +
      'on ("operaton:outputParameter not allowed for element type ' +
      "'endEvent'\")",
  );
}

/**
 * A definition-less throw (the Modeler's milestone marker) is a step:
 * `BpmnParse.parseIntermediateThrowEvent` gives it
 * `IntermediateThrowNoneEventActivityBehavior`, whose `execute` is the bare
 * `leave` a `TaskActivityBehavior` performs, with the same async and listener
 * settings; only the activity type history reports changes.
 */
function mapIntermediateThrowEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
): IntermediateThrowEvent | Task {
  const id = requireId(el);
  const defs = eventDefinitionsOf(el);

  if (defs.length === 0) {
    const named = readNamed(el, id, warnings);
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The bpmn:intermediateThrowEvent '${id}' carries no event ` +
        'definition and imports as a plain step: ' +
        'BpmnParse.parseIntermediateThrowEvent gives it ' +
        'IntermediateThrowNoneEventActivityBehavior, which only leaves, as ' +
        "a task's behaviour does, so token flow, listeners, async and job " +
        'configuration are unchanged, but history and Cockpit will report ' +
        "its activity type as 'task' rather than 'intermediateThrowEvent'.",
    });
    return {
      kind: 'task',
      id,
      ...named,
      ...readThrowEventAttributes(el, id, undefined, warnings),
      ...readIoMapping(el, id, warnings),
    };
  }
  refuseMultipleEventDefinitions(
    id,
    defs,
    'an emit',
    `${formatPlainWordList(EMIT_TRIGGERS)} is supported`,
  );

  const [defEl] = defs;
  if (defEl.$type === 'bpmn:ErrorEventDefinition') {
    throw new UnsupportedEventFeatureError(
      id,
      'an emit cannot carry an error: BPMN has no intermediate error ' +
        'throw; write "throw error" to end the path instead',
    );
  }
  if (!EMIT_CARRIED_TAGS.includes(defEl.$type)) {
    throw new UnsupportedEventDefinitionError(
      id,
      'intermediate throw',
      defEl.$type,
    );
  }

  // The two checks above admit only the emittable kinds, so the reader's
  // error arm is unreachable here and the cast holds.
  const eventDefinition = readThrowEventDefinition(
    defEl,
    id,
    warnings,
  ) as EmitEventDefinition;
  if (eventDefinition.kind === 'link') {
    warnNamedDrop(el, id, 'an emit link', warnings, eventDefinition.linkName);
    warnLinkThrowEngineSettings(el, id, warnings);
    return { kind: 'intermediateThrowEvent', id, eventDefinition };
  }
  warnNamedDrop(el, id, 'an emit', warnings);
  // The block is marked read on the tag for the none throw's sake, which
  // carries it as a step; this node has no slot, so it reports it by hand.
  const io = onlyIoMapping(el, id);
  if (io !== undefined) {
    warnUnimportedSetting(warnings, id, childSubject(io), el.$type, io.$type);
  }

  const binding = readThrownMessageBinding(
    defEl,
    id,
    'intermediateMessageThrowEvent',
    warnings,
  );
  return {
    kind: 'intermediateThrowEvent',
    id,
    eventDefinition,
    ...(binding === undefined ? {} : { binding }),
    ...readThrowEventAttributes(el, id, binding, warnings),
  };
}

/**
 * The engine attributes of an end or an intermediate throw, after the
 * `operaton:properties` block {@link THROW_EVENT_TAGS} marks read: only an
 * external-bound thrown message reaches its reader, so every shape reports it.
 */
function readThrowEventAttributes(
  el: ModdleElement,
  id: string,
  binding: ServiceTaskBinding | undefined,
  warnings: ImportWarning[],
): EngineAttributes {
  for (const block of extensionValues(el)) {
    if (block.$type !== 'operaton:Properties') continue;
    warnThrownMessageExtraDrop(
      id,
      'operaton:properties block',
      binding?.kind === 'external' ? 'the event element' : undefined,
      warnings,
    );
  }
  return readEngineAttributes(el, id, warnings);
}

/**
 * One drop of what `BpmnParse.parseExternalServiceTask` reads: under an
 * external binding it reads `what` off `readOff` and the throw has no
 * position for it; under any other binding nothing reaches that reader.
 */
function warnThrownMessageExtraDrop(
  id: string,
  what: string,
  readOff: 'the message definition' | 'the event element' | undefined,
  warnings: ImportWarning[],
): void {
  warnings.push({
    elementId: id,
    category: 'extensionAttribute',
    message:
      readOff === undefined
        ? `The ${what} on '${id}' was not imported: Operaton reads it in ` +
          'parseExternalServiceTask alone, which only a thrown message ' +
          'bound with operaton:type="external" reaches, so the event runs ' +
          'as written without it.'
        : `The ${what} on '${id}' was not imported: ` +
          `BpmnParse.parseExternalServiceTask reads it off ${readOff} of a ` +
          'thrown message bound with operaton:type="external", and this ' +
          "surface's throw has no position for it, so the document written " +
          'back runs without it.',
  });
}

function hasConnector(el: ModdleElement): boolean {
  return extensionValues(el).some(
    (value) => value.$type === 'operaton:Connector',
  );
}

/**
 * What makes Operaton send a thrown message: a service task's
 * implementation, written on the definition. A message thrown without one
 * records and continues, so a definition naming none imports as it stands; a
 * connector is that implementation in element form, which this surface cannot
 * keep, so it refuses rather than turning the send into a no-op. The throw
 * statement has a slot for nothing else `parseServiceTaskLike` reads off the
 * definition, so the result variable is refused where the engine refuses or
 * stores it and the rest is dropped naming its reader.
 */
function readThrownMessageBinding(
  defEl: ModdleElement,
  id: string,
  elementName: 'intermediateMessageThrowEvent' | 'messageEndEvent',
  warnings: ImportWarning[],
): ServiceTaskBinding | undefined {
  if (defEl.$type !== 'bpmn:MessageEventDefinition') return undefined;

  if (hasConnector(defEl)) {
    throw new UnsupportedEventFeatureError(
      id,
      'a thrown message carries a connector; that is what makes the engine ' +
        'really send it, and this surface has no place to keep it',
    );
  }

  const binding = readCodeOrExternalBinding(
    defEl,
    id,
    warnings,
    'thrownMessage',
  );
  if (
    binding === undefined &&
    readNamespacedAttr(defEl, 'type') !== undefined
  ) {
    throw new UnsupportedServiceTaskFormError(
      id,
      detectUnsupportedServiceTaskForm(defEl, 'thrownMessage'),
      'Thrown message',
    );
  }
  if (
    binding === undefined &&
    readNamespacedAttr(defEl, 'topic') !== undefined
  ) {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The 'topic' setting on '${id}' only takes effect alongside ` +
        'operaton:type="external"; on its own it names no external worker ' +
        'and was not imported.',
    });
  }

  const refusal = (construct: string): Error =>
    new UnsupportedEventFeatureError(
      id,
      `its message definition binds ${construct}`,
    );
  if (binding !== undefined) {
    refuseResultVariableBeside(binding, defEl, elementName, refusal);
  }
  const resultVariableAttr = writtenResultVariableAttr(defEl);
  if (resultVariableAttr !== undefined) {
    if (binding?.kind === 'expression') {
      throw refusal(
        `operaton:expression with operaton:${resultVariableAttr}=` +
          `"${readNamespacedAttr(defEl, resultVariableAttr)}", under which ` +
          "BpmnParse.parseServiceTaskLike stores the expression's value " +
          '(ServiceTaskExpressionActivityBehavior); a thrown message in ' +
          'this script takes no result variable, so dropping it would ' +
          'change what runs',
      );
    }
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The '${resultVariableAttr}' setting on '${id}' was not imported: ` +
        'BpmnParse.parseServiceTaskLike hands it to an expression binding ' +
        `alone, so ${
          binding === undefined
            ? 'a definition naming no implementation'
            : 'an operaton:type="external" binding'
        } never writes it.`,
    });
  }

  const where = `the message definition of '${id}'`;
  for (const field of fieldChildren(defEl)) {
    warnFieldDrop(
      field,
      id,
      where,
      binding !== undefined && carriesFields(binding)
        ? `${FIELD_HAS_NO_HOME}; BpmnParse.parseServiceTaskLike reads it ` +
            `off the definition into the ${binding.kind} it names, so the ` +
            'document written back runs that without it'
        : `${FIELD_HAS_NO_HOME}, and Operaton injects a field into a class ` +
            'or a delegate binding and into no other',
      warnings,
    );
  }

  const external = binding?.kind === 'external';
  const readOff = external ? 'the message definition' : undefined;
  const taskPriority = readNamespacedAttr(defEl, 'taskPriority');
  if (taskPriority !== undefined) {
    if (external) requireIntegerOrExpression(taskPriority, id, 'taskPriority');
    warnThrownMessageExtraDrop(id, "'taskPriority' setting", readOff, warnings);
  }
  for (const mapping of extensionValues(defEl)) {
    if (mapping.$type !== 'operaton:ErrorEventDefinition') continue;
    warnThrownMessageExtraDrop(id, childSubject(mapping), readOff, warnings);
  }
  return binding;
}

/** The triggers an await may head, as the refusals below name them. */
const AWAITABLE_TRIGGERS = formatPlainWordList(CATCH_TRIGGERS);

function mapIntermediateCatchEvent(
  el: ModdleElement,
  warnings: ImportWarning[],
): IntermediateCatchEvent {
  const id = requireId(el);
  // The single-block drop is reported by the owner sweep, which checks no multiplicity.
  onlyIoMapping(el, id);

  if (el.get('parallelMultiple') === true) {
    throw new UnsupportedEventFeatureError(
      id,
      'an await with parallelMultiple="true" waits for several triggers ' +
        `together; only a single ${AWAITABLE_TRIGGERS} trigger can be awaited`,
    );
  }

  const defs = eventDefinitionsOf(el);

  if (defs.length === 0) {
    throw new UnsupportedEventFeatureError(
      id,
      'an await with no event definition (a "none" intermediate catch) ' +
        'waits for nothing this tool can represent',
    );
  }
  refuseMultipleEventDefinitions(
    id,
    defs,
    'an await',
    `${AWAITABLE_TRIGGERS} trigger can be awaited`,
  );

  const [defEl] = defs;
  if (!AWAIT_CARRIED_TAGS.includes(defEl.$type)) {
    throw new UnsupportedEventFeatureError(
      id,
      `an await cannot carry a ${defEl.$type}: only ${AWAITABLE_TRIGGERS} ` +
        'triggers can be awaited inline; error and ' +
        'escalation are caught by an event handler and raised with ' +
        'throw/emit, compensation is undone by a subprocess block, and a ' +
        'cancel is written on the end that gives up an attempt block',
    );
  }

  // The tag check above admits only kinds the reader maps, so the cast holds.
  const eventDefinition = readCatchEventDefinition(
    defEl,
    id,
    warnings,
    'intermediate catch',
  ) as IntermediateCatchEvent['eventDefinition'];
  if (eventDefinition.kind === 'link') {
    warnNamedDrop(el, id, 'an await link', warnings, eventDefinition.linkName);
  } else {
    warnNamedDrop(el, id, 'an await', warnings);
  }

  return {
    kind: 'intermediateCatchEvent',
    id,
    eventDefinition,
    ...readEngineAttributes(el, id, warnings),
  };
}

/** A standard loop is not refused here: {@link readLoopCharacteristics} drops it with a warning on every host alike. */
function refuseLoopCharacteristics(el: ModdleElement, id: string): void {
  const loop = getEl(el, 'loopCharacteristics');
  if (loop !== undefined && loop.$type === MULTI_INSTANCE) {
    throw new UnsupportedLoopCharacteristicsError(
      id,
      loop.$type,
      'an event handler is entered by its trigger, so it cannot be repeated',
    );
  }
}

export function loopDroppedMessage(tag: string, id: string): string {
  return (
    `The ${tag} on '${id}' was not imported: Operaton does not run one ` +
    'at all, it deploys the step and runs it once, so the imported step ' +
    'runs once too.'
  );
}

/**
 * How often a step runs, or `undefined` for one that runs once.
 * `parseMultiInstanceLoopCharacteristics` looks only for the multi-instance
 * child, so a `bpmn:standardLoopCharacteristics` runs once and drops with a
 * warning. A `completionCondition` reaches `createExpression` as text alone,
 * so a body with no `${`/`#{` opener is a literal there and its `language`
 * is read by nothing.
 */
function readLoopCharacteristics(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): LoopCharacteristics | undefined {
  const loopEl = getEl(el, 'loopCharacteristics');
  if (loopEl === undefined) return undefined;
  if (loopEl.$type !== MULTI_INSTANCE) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message: loopDroppedMessage(xmlTagOf(loopEl.$type), id),
    });
    return undefined;
  }
  refuseOutputParameters(el, id);

  const cardinality = readCardinality(loopEl, id, warnings);
  const collection = readCollection(loopEl, id, warnings);
  const elementVariable = readElementVariable(loopEl, id, warnings);
  if (cardinality === undefined && collection === undefined) {
    throw new UnsupportedLoopCharacteristicsError(
      id,
      MULTI_INSTANCE,
      'it sets neither a number of runs nor a collection to run over, and ' +
        'Operaton refuses to deploy that',
    );
  }
  if (elementVariable !== undefined && collection === undefined) {
    throw new UnsupportedLoopCharacteristicsError(
      id,
      MULTI_INSTANCE,
      `it names '${elementVariable}' for each run to see but no collection ` +
        'to take it from, and Operaton refuses to deploy that',
    );
  }
  sweepRepetition(loopEl, id, warnings);

  const conditionEl = getEl(loopEl, 'completionCondition');
  const completionCondition =
    conditionEl === undefined ? undefined : readString(conditionEl, 'body');
  if (
    completionCondition !== undefined &&
    !EXPRESSION_ANYWHERE.test(completionCondition)
  ) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The bpmn:completionCondition on '${id}' is the bare text ` +
        `${JSON.stringify(completionCondition)} with no "\${...}" or ` +
        '"#{...}" opener: parseMultiInstanceLoopCharacteristics hands it to ' +
        'createExpression as a literal and ' +
        'MultiInstanceActivityBehavior.completionConditionSatisfied throws ' +
        'expressionNotBooleanException when the first run completes; the ' +
        'script writes it inside "${...}", which evaluates it.',
    });
  }
  const conditionLanguage =
    conditionEl === undefined ? undefined : readString(conditionEl, 'language');
  if (conditionLanguage !== undefined) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The language=${JSON.stringify(conditionLanguage)} on the ` +
        `bpmn:completionCondition of '${id}' was not imported: ` +
        'parseMultiInstanceLoopCharacteristics hands the text alone to ' +
        'createExpression and reads no language, so the imported step runs ' +
        'the same.',
    });
  }
  noteRewrappedExpression(
    completionCondition,
    id,
    'bpmn:completionCondition',
    warnings,
  );
  return {
    ...(cardinality === undefined ? {} : { cardinality }),
    ...(collection === undefined ? {} : { collection }),
    ...(elementVariable === undefined ? {} : { elementVariable }),
    ...(completionCondition === undefined ? {} : { completionCondition }),
    ...(loopEl.get('isSequential') === true ? { sequential: true } : {}),
    ...jobSettings({
      ...readRunSettings(loopEl, id, warnings),
      jobPriority: undefined,
    }),
  };
}

function readCardinality(
  loopEl: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): string | undefined {
  const cardinalityEl = getEl(loopEl, 'loopCardinality');
  if (cardinalityEl === undefined) return undefined;
  const cardinality = readString(cardinalityEl, 'body');
  if (cardinality === undefined) {
    throw new UnsupportedLoopCharacteristicsError(
      id,
      MULTI_INSTANCE,
      'its bpmn:loopCardinality is empty, so Operaton has no number of runs to read',
    );
  }
  // A literal the printer has no bare form for would come back re-wrapped as
  // an expression, a different document; BARE_CARDINALITY is the printer's test.
  if (
    !BARE_CARDINALITY.test(cardinality) &&
    !EXPRESSION_ANYWHERE.test(cardinality)
  ) {
    throw new UnsupportedLoopCharacteristicsError(
      id,
      MULTI_INSTANCE,
      `its bpmn:loopCardinality is ${JSON.stringify(cardinality)}, which ` +
        'this tool cannot write back out unchanged; it writes a count as a ' +
        'plain whole number or as an expression, and this body is neither',
    );
  }
  noteRewrappedExpression(cardinality, id, 'bpmn:loopCardinality', warnings);
  return cardinality;
}

/**
 * Operaton reads the text of `bpmn:loopDataInputRef` as the collection
 * variable's name, while moddle resolves it as an id reference and drops one
 * naming no element, so the dropped text is read back from the parse warning.
 * `BpmnParse.parseMultiInstanceLoopCharacteristics` stores each spelling in
 * one of two fields by whether its text contains `{`, the reference second,
 * and `MultiInstanceActivityBehavior.resolveNrOfInstances` reads the
 * expression field first: of one shape the reference wins, of two shapes the
 * expression wins.
 */
function readCollection(
  loopEl: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): string | undefined {
  const setting = readNamespacedAttr(loopEl, 'collection');
  const referenced =
    getEl(loopEl, 'loopDataInputRef')?.id ??
    unresolvedRef(loopEl, 'loopDataInputRef');
  if (setting === undefined || referenced === undefined) {
    return referenced ?? setting;
  }
  const isExpression = (text: string): boolean => text.includes('{');
  const sameShape = isExpression(setting) === isExpression(referenced);
  const kept = sameShape || isExpression(referenced) ? referenced : setting;
  warnShadowedRepetitionField(warnings, id, {
    first: 'operaton:collection',
    second: 'bpmn:loopDataInputRef',
    names: 'the collection',
    rule: sameShape
      ? 'parseMultiInstanceLoopCharacteristics writes both into the same ' +
        'field and bpmn:loopDataInputRef second'
      : 'parseMultiInstanceLoopCharacteristics stores an expression (a ' +
        'value containing "{") and a variable name in two fields, and ' +
        'MultiInstanceActivityBehavior.resolveNrOfInstances reads the ' +
        'expression field first',
    kept,
    dropped: kept === referenced ? setting : referenced,
  });
  return kept;
}

function readElementVariable(
  loopEl: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): string | undefined {
  const setting = readNamespacedAttr(loopEl, 'elementVariable');
  const dataItem = getEl(loopEl, 'inputDataItem');
  const itemName =
    dataItem === undefined ? undefined : readString(dataItem, 'name');
  // One field in the engine (`setCollectionElementVariable`), written twice.
  if (setting !== undefined && itemName !== undefined) {
    warnShadowedRepetitionField(warnings, id, {
      first: 'bpmn:inputDataItem',
      second: 'operaton:elementVariable',
      names: 'what each run sees',
      rule:
        'parseMultiInstanceLoopCharacteristics writes both into the same ' +
        'field and bpmn:inputDataItem second',
      kept: itemName,
      dropped: setting,
    });
  }
  const elementVariable = itemName ?? setting;
  // A name outside the printer's one form (BARE_ELEMENT_VARIABLE) comes back
  // as something the language cannot parse.
  if (
    elementVariable !== undefined &&
    !BARE_ELEMENT_VARIABLE.test(elementVariable)
  ) {
    throw new UnsupportedLoopCharacteristicsError(
      id,
      MULTI_INSTANCE,
      `it names ${JSON.stringify(elementVariable)} for each run to see, ` +
        'which this tool cannot write back out unchanged; it writes that ' +
        'name as a plain identifier, and this name is not one',
    );
  }
  return elementVariable;
}

function warnShadowedRepetitionField(
  warnings: ImportWarning[],
  id: string,
  shadow: {
    first: string;
    second: string;
    names: string;
    rule: string;
    kept: string;
    dropped: string;
  },
): void {
  warnings.push({
    elementId: id,
    category: 'extensionAttribute',
    message:
      `Both ${shadow.first} and ${shadow.second} name ${shadow.names} on ` +
      `'${id}'; ${shadow.rule}, so '${shadow.kept}' was imported and ` +
      `'${shadow.dropped}' was dropped.`,
  });
}

/** `BpmnParse.checkActivityOutputParameterSupported` fails the deployment of an output mapping on a step that repeats. */
function refuseOutputParameters(el: ModdleElement, id: string): void {
  const io = extensionValues(el).find(
    (value) => value.$type === 'operaton:InputOutput',
  );
  const outputs =
    (io?.get('outputParameters') as ModdleElement[] | undefined) ?? [];
  if (outputs.length > 0) {
    throw new UnsupportedLoopCharacteristicsError(
      id,
      MULTI_INSTANCE,
      "it maps an 'operaton:outputParameter', which " +
        'BpmnParse.checkActivityOutputParameterSupported fails the ' +
        'deployment on ("operaton:outputParameter not allowed for ' +
        'multi-instance constructs")',
    );
  }
}

/** The repetition content Operaton parses and then never reads. */
const IGNORED_REPETITION_REFS = [
  'loopDataOutputRef',
  'oneBehaviorEventRef',
  'noneBehaviorEventRef',
] as const;

/**
 * Report what the repetition carries and nothing reads. The three references,
 * `behavior` and `operaton:jobPriority` are named by hand: the sweeps skip a
 * reference and a BPMN attribute, and the generic sentence would read as this
 * tool's limitation rather than a setting the engine never reads.
 */
function sweepRepetition(
  loopEl: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): void {
  collectUnmappedBpmnDrops(loopEl, id, warnings);
  collectExtensionDrops(loopEl, id, warnings);
  warnDocumentationDrop(loopEl, id, 'a repetition', warnings);
  for (const name of IGNORED_REPETITION_REFS) {
    if (
      getEl(loopEl, name) !== undefined ||
      unresolvedRef(loopEl, name) !== undefined
    ) {
      warnRepetitionContentIgnored(warnings, id, `bpmn:${name}`);
    }
  }
  const behavior = readString(loopEl, 'behavior');
  if (behavior !== undefined && behavior !== 'All') {
    warnRepetitionContentIgnored(warnings, id, `behavior="${behavior}"`);
  }
  // `createActivityOnScope` reads a job priority off the step alone.
  if (readNamespacedAttr(loopEl, 'jobPriority') !== undefined) {
    warnRepetitionContentIgnored(warnings, id, 'operaton:jobPriority');
  }
}

function warnRepetitionContentIgnored(
  warnings: ImportWarning[],
  id: string,
  construct: string,
): void {
  warnings.push({
    elementId: id,
    category: 'unmappedConstruct',
    message:
      `The ${construct} on the repetition of '${id}' was not imported: ` +
      'Operaton does not read it, so the imported process runs the same.',
  });
}

function mapUserTask(el: ModdleElement, warnings: ImportWarning[]): UserTask {
  const id = requireId(el);
  const named = readNamed(el, id, warnings);
  const assignment = readAssignment(el, id, warnings);
  const formKey = readNamespacedAttr(el, 'formKey');
  const formRef = readFormRef(el, id, warnings);
  const formFields = readFormFields(el, id, warnings);
  const taskListeners = readTaskListeners(el, id, warnings);
  const dueDate = readNamespacedAttr(el, 'dueDate');
  const followUpDate = readNamespacedAttr(el, 'followUpDate');
  const priority = readNamespacedAttr(el, 'priority');

  return {
    kind: 'userTask',
    id,
    ...named,
    ...assignment,
    ...(formKey === undefined ? {} : { formKey }),
    ...(formRef === undefined ? {} : { formRef }),
    ...(formFields === undefined ? {} : { formFields }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(followUpDate === undefined ? {} : { followUpDate }),
    ...(priority === undefined ? {} : { priority }),
    ...(taskListeners === undefined ? {} : { taskListeners }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

/** The resource roles `BpmnParse.parseTaskDefinition` reads, by tag, and the method reading each. */
const ROLE_READERS: ReadonlyMap<string, string> = new Map([
  ['bpmn:HumanPerformer', 'parseHumanPerformerResourceAssignment'],
  ['bpmn:PotentialOwner', 'parsePotentialOwnerResourceAssignment'],
]);

const USER_PREFIX = 'user(';
const GROUP_PREFIX = 'group(';

/** `BpmnParse.parseCommaSeparatedList`: only a comma outside a `${...}` splits, so `${groupOf(a, b)}` stays one entry. */
function splitAsEngine(text: string): string[] {
  const entries: string[] = [];
  let current = '';
  let insideExpression = false;
  for (const char of text) {
    if (char === '{' || char === '$') {
      insideExpression = true;
    } else if (char === '}') {
      insideExpression = false;
    } else if (char === ',' && !insideExpression) {
      entries.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length > 0) entries.push(current.trim());
  return entries;
}

/** `BpmnParse.getAssignmentId`. */
function assignmentId(entry: string, prefix: string): string {
  return entry.slice(prefix.length, -1).trim();
}

/** As `parsePotentialOwnerResourceAssignment` sorts them: `user(...)` to the users, `group(...)` and a bare entry to the groups. */
function splitCandidates(text: string): { users: string[]; groups: string[] } {
  const users: string[] = [];
  const groups: string[] = [];
  for (const entry of splitAsEngine(text)) {
    if (entry.startsWith(USER_PREFIX)) {
      users.push(assignmentId(entry, USER_PREFIX));
    } else if (entry.startsWith(GROUP_PREFIX)) {
      groups.push(assignmentId(entry, GROUP_PREFIX));
    } else {
      groups.push(entry);
    }
  }
  return { users, groups };
}

/** The role entries first and the attribute's text after, as the engine builds the list. */
function mergeCandidates(
  fromRoles: string[],
  fromAttr: string | undefined,
): string | undefined {
  const all = fromAttr === undefined ? fromRoles : [...fromRoles, fromAttr];
  return all.length === 0 ? undefined : all.join(',');
}

/**
 * The text of a role's `<bpmn:formalExpression>`, the one spelling the role
 * readers fetch by tag (`Element.elementsNS`); moddle gives the same `$type`
 * to `<bpmn:expression xsi:type="bpmn:tFormalExpression">`, so the raw
 * `xsi:type` tells the two apart.
 */
function formalExpressionTextOf(role: ModdleElement): string | undefined {
  const rae = getEl(role, 'resourceAssignmentExpression');
  const expression = rae === undefined ? undefined : getEl(rae, 'expression');
  return expression?.$type === 'bpmn:FormalExpression' &&
    expression.$attrs['xsi:type'] === undefined
    ? readString(expression, 'body')
    : undefined;
}

/**
 * `BpmnParse.parseTaskDefinition` reads the roles first and
 * `parseUserTaskCustomExtensions` appends the attributes' entries after.
 * Roles match on the exact `$type`: bpmn-moddle derives `PotentialOwner` from
 * `HumanPerformer`, and the engine reads by tag.
 */
function readAssignment(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): Pick<UserTask, 'assignee' | 'candidateUsers' | 'candidateGroups'> {
  const roles = el.get('resources') as ModdleElement[];
  const attrAssignee = readText(el, 'operaton:assignee');
  const performers = roles.filter((r) => r.$type === 'bpmn:HumanPerformer');
  if (performers.length > 1) {
    throw new UnsupportedAssignmentError(
      id,
      `it carries ${performers.length} bpmn:humanPerformer elements, and ` +
        'BpmnParse.parseHumanPerformer admits one',
    );
  }

  let assignee = attrAssignee;
  const users: string[] = [];
  const groups: string[] = [];
  for (const role of roles) {
    const tag = describeUnmapped(role);
    const reader = ROLE_READERS.get(role.$type);
    const drop = (reason: string): void => {
      warnings.push({
        elementId: id,
        category: 'unmappedConstruct',
        message: `The ${tag} on '${id}' was not imported: ${reason}.`,
      });
    };
    if (reader === undefined) {
      drop(
        'Operaton reads a bpmn:humanPerformer and a bpmn:potentialOwner by ' +
          'tag (BpmnParse.parseTaskDefinition) and no other resource role',
      );
      continue;
    }
    const text = formalExpressionTextOf(role);
    if (text === undefined) {
      drop(
        'it carries no formal expression, and Operaton reads nothing else ' +
          `off it (BpmnParse.${reader})`,
      );
      continue;
    }

    const became: [key: string, value: string][] = [];
    if (role.$type === 'bpmn:HumanPerformer') {
      if (attrAssignee !== undefined) {
        throw new UnsupportedAssignmentError(
          id,
          `its ${tag} names an assignee ("${text}") beside ` +
            `operaton:assignee="${attrAssignee}", which ` +
            'BpmnParse.parseUserTaskCustomExtensions refuses as a duplicate ' +
            'assignee declaration',
        );
      }
      assignee = text;
      became.push(['assignee', text]);
    } else {
      const { users: roleUsers, groups: roleGroups } = splitCandidates(text);
      users.push(...roleUsers);
      groups.push(...roleGroups);
      if (roleUsers.length > 0)
        became.push(['candidateUsers', roleUsers.join(',')]);
      if (roleGroups.length > 0)
        became.push(['candidateGroups', roleGroups.join(',')]);
    }
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The ${tag} on '${id}' imports as ` +
        `${became.map(([key, value]) => `${key}: "${value}"`).join(' and ')}: ` +
        `Operaton reads its formal expression that way (BpmnParse.${reader}), ` +
        'and this tool writes it back as ' +
        `${became.map(([key]) => `operaton:${key}`).join(' and ')}, which ` +
        'the engine reads the same.',
    });

    const unread = [
      ...(getEl(role, 'resourceRef') !== undefined ||
      unresolvedRef(role, 'resourceRef') !== undefined
        ? ['resourceRef']
        : []),
      ...((role.get('resourceParameterBindings') as ModdleElement[]).length > 0
        ? ['resourceParameterBindings']
        : []),
    ];
    if (unread.length > 0) {
      warnings.push({
        elementId: id,
        category: 'unmappedConstruct',
        message:
          `The ${unread.join(' and ')} on the ${tag} on '${id}' was not ` +
          `imported: Operaton reads the role's formal expression alone ` +
          `(BpmnParse.${reader}).`,
      });
    }
  }

  const candidateUsers = mergeCandidates(
    users,
    readNamespacedAttr(el, 'candidateUsers'),
  );
  const candidateGroups = mergeCandidates(
    groups,
    readNamespacedAttr(el, 'candidateGroups'),
  );
  return {
    ...(assignee === undefined ? {} : { assignee }),
    ...(candidateUsers === undefined ? {} : { candidateUsers }),
    ...(candidateGroups === undefined ? {} : { candidateGroups }),
  };
}

/**
 * `parseFormDefinition` refuses to deploy a form key beside a form reference,
 * and a form reference whose binding is absent or outside the three it
 * resolves, so both shapes refuse here.
 */
function readFormRef(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): UserTask['formRef'] {
  const key = readNamespacedAttr(el, 'formRef');
  if (key === undefined) {
    warnDanglingModifiers(
      el,
      id,
      FORM_REF_MODIFIER_ATTRS,
      'operaton:formRef',
      warnings,
    );
    return undefined;
  }

  const refusal = (detail: string): Error =>
    new UnsupportedFormReferenceError(id, detail);
  if (readNamespacedAttr(el, 'formKey') !== undefined) {
    throw refusal(
      'it names an operaton:formKey beside the operaton:formRef, and a task ' +
        'renders one form',
    );
  }

  const binding = readVersionBinding(el, id, 'formRef', refusal, warnings);
  if (binding === undefined) {
    throw refusal(
      'its operaton:formRef carries no operaton:formRefBinding, so the ' +
        'engine cannot resolve which deployed form to render',
    );
  }
  return { key, binding };
}

function mapTask(el: ModdleElement, warnings: ImportWarning[]): Task {
  const id = requireId(el);
  const named = readNamed(el, id, warnings);
  return {
    kind: 'task',
    id,
    ...named,
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

export function manualTaskMessage(id: string): string {
  return (
    `The bpmn:manualTask '${id}' imports as a plain step: token flow, ` +
    'waiting, listeners, async and job configuration are all unchanged, ' +
    "but history and Cockpit will report its activity type as 'task' " +
    "rather than 'manualTask'."
  );
}

/**
 * `ManualTaskActivityBehavior` is an empty subclass of `TaskActivityBehavior`
 * and `BpmnParse.parseManualTask` mirrors `parseTask`, so only the activity
 * type `createActivityOnScope` stores for history differs from a plain task.
 */
function mapManualTask(el: ModdleElement, warnings: ImportWarning[]): Task {
  const task = mapTask(el, warnings);
  warnings.push({
    elementId: task.id,
    category: 'unmappedConstruct',
    message: manualTaskMessage(task.id),
  });
  return task;
}

function mapReceiveTask(
  el: ModdleElement,
  warnings: ImportWarning[],
): ReceiveTask {
  const id = requireId(el);
  const named = readNamed(el, id, warnings);
  // A missing messageRef is a legitimate wait state.
  const messageName =
    getEl(el, 'messageRef') === undefined
      ? undefined
      : resolveNamedRootRef(el, 'messageRef', id, 'message');
  return {
    kind: 'receiveTask',
    id,
    ...named,
    ...(messageName === undefined ? {} : { messageName }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

/** `element` is the tag that was read and names the subject of a refusal. */
function mapServiceTask(
  el: ModdleElement,
  warnings: ImportWarning[],
  element?: ServiceTask['element'],
): ServiceTask {
  const id = requireId(el);
  const named = readNamed(el, id, warnings);
  const binding = readServiceTaskBinding(el, id, element, warnings);
  const resultVariable = readResultVariable(el, id, warnings);
  // `parseServiceTaskLike` hands the variable to the expression behaviour
  // alone, so under a `type` binding it deploys and does nothing.
  if (
    resultVariable !== undefined &&
    (binding.kind === 'external' || binding.kind === 'builtin')
  ) {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The resultVariable '${resultVariable}' on '${id}' was imported as ` +
        'written, and the printed script draws a warning at the step: ' +
        'BpmnParse.parseServiceTaskLike hands it to an expression binding ' +
        'alone, so an operaton:type binding never writes it.',
    });
  }
  return {
    kind: 'serviceTask',
    id,
    ...named,
    binding,
    ...(resultVariable === undefined ? {} : { resultVariable }),
    ...(element === undefined ? {} : { element }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

/** `BpmnParse.parseResultVariable` reads `resultVariable` and falls back to `resultVariableName`. */
function readResultVariable(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): string | undefined {
  const current = readNamespacedAttr(el, 'resultVariable');
  const older = readNamespacedAttr(el, 'resultVariableName');
  if (older === undefined) return current;
  if (current !== undefined) {
    warnings.push(
      buildShadowedImplementationWarning(
        id,
        'resultVariableName',
        'operaton:resultVariable',
      ),
    );
    return current;
  }
  warnings.push({
    elementId: id,
    category: 'unmappedConstruct',
    message:
      `The operaton:resultVariableName="${older}" on '${id}' imports as ` +
      `resultVariable: "${older}": BpmnParse.parseResultVariable reads the ` +
      'two spellings as one, and this tool writes it back as ' +
      'operaton:resultVariable, which the engine reads the same.',
  });
  return older;
}

/** The noun a refusal leads with, per tag. */
const SERVICE_TASK_LIKE_SUBJECT = {
  service: 'Service task',
  send: 'Send task',
  businessRule: 'Business rule task',
} as const;

/**
 * `ConnectorParseListener.parseConnectorElement` overwrites whatever behaviour
 * `parseServiceTaskLike` set, on a Connect-enabled engine alone, so the same
 * file has two possible executions and no warning can summarise it.
 */
export const CONNECTOR_CONSTRUCT =
  'an <operaton:connector> element, which the Connect plugin runs in place ' +
  'of whatever operaton:class, expression, delegateExpression, or type ' +
  'names beside it, and which an engine without the plugin runs instead ' +
  'of, so the same file has two possible executions';

function readServiceTaskBinding(
  el: ModdleElement,
  id: string,
  element: ServiceTask['element'],
  warnings: ImportWarning[],
): ServiceTaskBinding {
  const subject = SERVICE_TASK_LIKE_SUBJECT[element ?? 'service'];
  const refusal = (construct: string): Error =>
    new UnsupportedServiceTaskFormError(id, construct, subject);

  // Before both reads: a connector wins at runtime over any of them, and a
  // connector-only task would otherwise read as "no execution discriminator".
  if (hasConnector(el)) throw refusal(CONNECTOR_CONSTRUCT);

  // The decision reference is the engine's discriminator, read before the
  // code forms a business rule task may fall back to.
  const binding =
    (element === 'businessRule'
      ? readDecisionBinding(el, id, refusal, warnings)
      : undefined) ?? readCodeOrExternalBinding(el, id, warnings, 'task');
  if (binding === undefined) {
    throw refusal(detectUnsupportedServiceTaskForm(el, 'task'));
  }
  refuseResultVariableBeside(
    binding,
    el,
    `${element ?? 'service'}Task`,
    refusal,
  );

  const bound = withInjectedFields(binding, el, id, `'${id}'`, warnings);
  if (bound.kind === 'builtin') {
    refuseBuiltinShapes(bound, id, refusal, warnings);
  }
  return withExternalExtras(bound, el, id, warnings);
}

/**
 * `BpmnParse.parseServiceTaskLike` fails the deployment when a `class` or
 * `delegateExpression` binding carries a result variable in either spelling;
 * `elementName` is the tag as that refusal names it (`serviceTask`).
 */
function refuseResultVariableBeside(
  binding: ServiceTaskBinding,
  el: ModdleElement,
  elementName: string,
  refusal: (construct: string) => Error,
): void {
  if (binding.kind !== 'class' && binding.kind !== 'delegateExpression') return;
  const written = writtenResultVariableAttr(el);
  if (written === undefined) return;
  throw refusal(
    `operaton:${binding.kind} with operaton:${written}, which Operaton ` +
      `refuses to deploy: "'resultVariableName' not supported for ` +
      `${elementName} elements using '${binding.kind}'" ` +
      '(BpmnParse.parseServiceTaskLike)',
  );
}

/** The first result-variable spelling the element writes, in `parseResultVariable`'s order. */
function writtenResultVariableAttr(
  el: ModdleElement,
): 'resultVariable' | 'resultVariableName' | undefined {
  return (['resultVariable', 'resultVariableName'] as const).find(
    (attr) => readNamespacedAttr(el, attr) !== undefined,
  );
}

/**
 * Refuse the field lists the engine's parse refuses, in its order: shell
 * value shapes and flags, then missing fields, then an undeclared name. The
 * flag check is case-insensitive as the engine's is, so `"True"` imports as
 * written with a warning.
 */
function refuseBuiltinShapes(
  binding: Extract<ServiceTaskBinding, { kind: 'builtin' }>,
  id: string,
  refusal: (construct: string) => Error,
  warnings: ImportWarning[],
): void {
  const { type } = binding;
  const fields = binding.fields ?? [];
  const named = `operaton:type="${type}"`;
  const method = `BpmnParse.${BUILTIN_FIELD_VALIDATOR[type]}`;

  if (type === 'shell') {
    const evaluated = fields.find((field) => EXPRESSION_OPEN.test(field.value));
    if (evaluated !== undefined) {
      throw refusal(
        `${named} with the field '${evaluated.name}' written as an ` +
          'operaton:expression, which Operaton fails to deploy: ' +
          `${method} casts every shell field to a FixedValue, and an ` +
          'expression is not one',
      );
    }
    const flag = fields.find(
      (field) =>
        SHELL_FLAG_FIELDS.includes(field.name) &&
        !SHELL_FLAG_LITERALS.includes(field.value.toLowerCase()),
    );
    if (flag !== undefined) {
      throw refusal(
        `${named} with the field '${flag.name}' set to '${flag.value}', ` +
          'which Operaton refuses to deploy: "undefined value for shell ' +
          `${flag.name} parameter :${flag.value}" (${method})`,
      );
    }
    for (const field of fields) {
      if (
        !SHELL_FLAG_FIELDS.includes(field.name) ||
        SHELL_FLAG_LITERALS.includes(field.value)
      ) {
        continue;
      }
      warnings.push({
        elementId: id,
        category: 'extensionAttribute',
        message:
          `The shell field '${field.name}' spelled '${field.value}' on ` +
          `'${id}' was imported as written, and the printed script draws an ` +
          'error at the field: ShellActivityBehavior.readFields compares it ' +
          'with "true" case-sensitively, so the engine reads it as false.',
      });
    }
  }

  const names = fields.map((field) => field.name);
  for (const group of BUILTIN_REQUIRED_FIELDS[type]) {
    if (group.names.some((name) => names.includes(name))) continue;
    throw refusal(
      `${named} without a ${formatWordList(group.names)} field, which Operaton refuses to deploy: ` +
        `"${group.error}" (${method})`,
    );
  }

  const unknown = names.find(
    (name) => !BUILTIN_FIELD_NAMES[type].includes(name),
  );
  if (unknown !== undefined) {
    throw refusal(
      `${named} with a field '${unknown}', which the ${type} behaviour does ` +
        'not declare; Operaton refuses to deploy it: "Field definition uses ' +
        `unexisting field '${unknown}'" (ClassDelegateUtil.applyFieldDeclaration)`,
    );
  }
}

/**
 * What `BpmnParse.parseExternalServiceTask` reads beside the topic. No other
 * binding reaches that method, so under one the three are reported instead.
 */
function withExternalExtras(
  binding: ServiceTaskBinding,
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): ServiceTaskBinding {
  const taskPriority = readNamespacedAttr(el, 'taskPriority');
  const definitions = extensionValues(el).filter(
    (value) => value.$type === 'operaton:ErrorEventDefinition',
  );

  if (binding.kind !== 'external') {
    const present = [
      ...(taskPriority === undefined ? [] : ["'taskPriority' setting"]),
      ...extensionValues(el)
        .filter((value) => value.$type === 'operaton:Properties')
        .map(() => 'operaton:properties block'),
      ...definitions.map(
        (defEl) =>
          'operaton:errorEventDefinition' +
          (defEl.id === undefined ? '' : ` '${defEl.id}'`),
      ),
    ];
    for (const what of present) {
      warnings.push({
        elementId: id,
        category: 'extensionAttribute',
        message:
          `The ${what} on '${id}' was not imported: Operaton reads it in ` +
          'parseExternalServiceTask alone, which only ' +
          'operaton:type="external" reaches, so the step runs as written ' +
          'without it.',
      });
    }
    return binding;
  }

  const propertiesEl = onlyExtensionElement(
    el,
    'operaton:Properties',
    id,
    'BpmnParseUtil.parseOperatonExtensionProperties',
  );
  const properties =
    propertiesEl === undefined
      ? []
      : readPropertyEntries(propertiesEl, 'name', `'${id}'`, (message) => {
          warnings.push({
            elementId: id,
            category: 'extensionAttribute',
            message,
          });
        });
  const errorMappings = definitions.flatMap(
    (defEl) => readErrorMapping(defEl, id, warnings) ?? [],
  );
  requireIntegerOrExpression(taskPriority, id, 'taskPriority');
  return {
    ...binding,
    ...(taskPriority === undefined ? {} : { taskPriority }),
    ...(properties.length === 0 ? {} : { properties }),
    ...(errorMappings.length === 0 ? {} : { errorMappings }),
  };
}

/**
 * In the order `parseOperatonErrorEventDefinitions` branches: a definition
 * with no `errorRef` is skipped whole (`undefined`), one with a reference and
 * no `expression` fails the deployment, and a reference naming no root is
 * read as the code ({@link readDanglingErrorCode}).
 */
function readErrorMapping(
  defEl: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): ErrorMapping | undefined {
  warnThrowSideBindingAttrs(defEl, ownerId, warnings);
  warnDocumentationDrop(defEl, ownerId, 'an error mapping', warnings);
  const ref = getEl(defEl, 'errorRef');
  const errorCode = ref
    ? readString(ref, 'errorCode')
    : readDanglingErrorCode(defEl, ownerId, warnings);
  if (ref === undefined && errorCode === undefined) {
    warnings.push({
      elementId: ownerId,
      category: 'unmappedConstruct',
      message:
        `The operaton:errorEventDefinition on '${ownerId}' carries no ` +
        'errorRef and was not imported: ' +
        'BpmnParse.parseOperatonErrorEventDefinitions skips one without ' +
        'it, so the document written back runs the same.',
    });
    return undefined;
  }
  const condition = readString(defEl, 'expression');
  noteRewrappedExpression(
    condition,
    ownerId,
    'operaton:errorEventDefinition expression',
    warnings,
  );
  if (condition === undefined) {
    throw new UnsupportedErrorMappingError(
      ownerId,
      'the operaton:errorEventDefinition carries no expression',
    );
  }
  if (errorCode === undefined) {
    throw new UnsupportedErrorMappingError(
      ownerId,
      `its errorRef names the error root '${ref?.id}', which carries no code`,
    );
  }
  return { errorCode, condition };
}

/** A thrown message's definition carries every form but the built-in ones, whose fields have no place on a throw. */
type BindingHost = 'task' | 'thrownMessage';

/**
 * The implementation Operaton resolves, in `parseServiceTaskLike`'s order:
 * `operaton:type` outranks every code attribute, then `class`, then
 * `delegateExpression`, then `expression`. A `type` this position cannot
 * carry returns `undefined` rather than falling back to a code attribute the
 * engine would never reach.
 */
function readCodeOrExternalBinding(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
  host: BindingHost,
): ServiceTaskBinding | undefined {
  const resolve = (
    winner: string,
    consumed: readonly string[],
    binding: ServiceTaskBinding,
  ): ServiceTaskBinding => {
    warnShadowedImplementation(
      el,
      id,
      `operaton:${winner}`,
      consumed,
      warnings,
    );
    return binding;
  };

  const type = readNamespacedAttr(el, 'type');
  const topic = readNamespacedAttr(el, 'topic');
  if (type !== undefined) {
    const builtin = builtinTypeOf(type);
    if (builtin !== undefined && host === 'task') {
      return resolve(`type="${type}"`, ['type'], {
        kind: 'builtin',
        type: builtin,
      });
    }
    if (!isExternalType(type) || topic === undefined) return undefined;
    return resolve(`type="${type}"`, ['type', 'topic'], {
      kind: 'external',
      topic,
    });
  }

  const className = readNamespacedAttr(el, 'class');
  if (className !== undefined) {
    return resolve('class', ['class'], { kind: 'class', className });
  }

  const delegate = readNamespacedAttr(el, 'delegateExpression');
  if (delegate !== undefined) {
    return resolve('delegateExpression', ['delegateExpression'], {
      kind: 'delegateExpression',
      expression: delegate,
    });
  }

  const expression = readNamespacedAttr(el, 'expression');
  if (expression !== undefined) {
    return resolve('expression', ['expression'], {
      kind: 'expression',
      expression,
    });
  }

  return undefined;
}

/** `undefined` when no decision is named, so the task falls back to a code binding. */
function readDecisionBinding(
  el: ModdleElement,
  id: string,
  refusal: (detail: string) => Error,
  warnings: ImportWarning[],
): Extract<ServiceTaskBinding, { kind: 'decision' }> | undefined {
  const decisionRef = readNamespacedAttr(el, 'decisionRef');
  if (decisionRef === undefined) {
    warnDanglingModifiers(
      el,
      id,
      DECISION_MODIFIER_ATTRS,
      'operaton:decisionRef',
      warnings,
    );
    return undefined;
  }
  warnShadowedImplementation(el, id, 'an operaton:decisionRef', [], warnings);

  const tenantId = readNamespacedAttr(el, 'decisionRefTenantId');
  if (tenantId !== undefined) {
    throw refusal(tenantPinDetail('decisionRefTenantId', tenantId, 'decision'));
  }

  const mapping = readNamespacedAttr(el, 'mapDecisionResult');
  const mapDecisionResult = DECISION_RESULT_MAPPINGS.find((m) => m === mapping);
  if (mapping !== undefined && mapDecisionResult === undefined) {
    throw refusal(
      `operaton:mapDecisionResult="${mapping}", which is not a way of ` +
        'filling the result variable this tool can represent',
    );
  }

  const binding = readVersionBinding(el, id, 'decisionRef', refusal, warnings);
  return {
    kind: 'decision',
    decisionRef,
    ...(binding === undefined ? {} : { binding }),
    ...(mapDecisionResult === undefined ? {} : { mapDecisionResult }),
  };
}

/** The settings only a named decision gives meaning to; the consumption table marks them read on every business rule task. */
const DECISION_MODIFIER_ATTRS = [
  'decisionRefBinding',
  'decisionRefVersion',
  'decisionRefTenantId',
  'mapDecisionResult',
] as const;

/** The two settings only a named form gives meaning to. */
const FORM_REF_MODIFIER_ATTRS = ['formRefBinding', 'formRefVersion'] as const;

/** The settings that shape a reference the element never makes; `ref` names the missing reference. */
function warnDanglingModifiers(
  el: ModdleElement,
  id: string,
  attrs: readonly string[],
  ref: string,
  warnings: ImportWarning[],
): void {
  for (const attr of attrs) {
    if (readNamespacedAttr(el, attr) === undefined) continue;
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The '${attr}' setting on '${id}' has no effect without an ` +
        `${ref} and was not imported.`,
    });
  }
}

/** `attr` is a no-op because `winner` already resolved the implementation. */
function buildShadowedImplementationWarning(
  id: string,
  attr: string,
  winner: string,
  subject = `'${id}'`,
): ImportWarning {
  return {
    elementId: id,
    category: 'extensionAttribute',
    message:
      `The '${attr}' setting on ${subject} has no effect alongside ` +
      `${winner} and was not imported.`,
  };
}

/**
 * Every implementation attribute `winner` leaves unread, as the engine leaves
 * it: `parseServiceTaskLike` stops at the first it resolves, and a named
 * decision goes to `parseDmnBusinessRuleTask`, which runs no implementation.
 * `consumed` names what `winner` itself read.
 */
function warnShadowedImplementation(
  el: ModdleElement,
  id: string,
  winner: string,
  consumed: readonly string[],
  warnings: ImportWarning[],
): void {
  for (const attr of IMPLEMENTATION_ATTRS) {
    if (consumed.includes(attr)) continue;
    if (readNamespacedAttr(el, attr) === undefined) continue;
    warnings.push(buildShadowedImplementationWarning(id, attr, winner));
  }
}

/** `parseServiceTaskLike` compares the type with `equalsIgnoreCase`. */
function isExternalType(type: string): boolean {
  return type.toLowerCase() === 'external';
}

function builtinTypeOf(type: string): BuiltinTaskType | undefined {
  const lower = type.toLowerCase();
  return TYPE_BINDING_VALUES.find((value) => value === lower);
}

/** The implementation attributes that carry code, in the order {@link readCodeOrExternalBinding} resolves them. */
const CODE_ATTRS = [
  'class',
  'delegateExpression',
  'expression',
] as const satisfies readonly (typeof IMPLEMENTATION_ATTRS)[number][];

/**
 * What is wrong with the element, for the refusal. A code attribute beside an
 * `operaton:type` is named too, since a refusal that lists the supported
 * forms without it would read as if the document had none.
 */
function detectUnsupportedServiceTaskForm(
  el: ModdleElement,
  host: BindingHost,
): string {
  const type = readNamespacedAttr(el, 'type');
  if (type === undefined) return 'no execution discriminator';

  const named = isExternalType(type)
    ? `operaton:type="${type}" without an operaton:topic`
    : `operaton:type="${type}"`;
  const shadowed = CODE_ATTRS.filter(
    (attr) => readNamespacedAttr(el, attr) !== undefined,
  ).map((attr) => `operaton:${attr}`);
  const clauses = [
    ...(host === 'thrownMessage' && builtinTypeOf(type) !== undefined
      ? [
          'which this surface carries on a service, send or business rule task alone',
        ]
      : []),
    ...(shadowed.length === 0
      ? []
      : [
          `which Operaton resolves ahead of the ${formatPlainWordList(shadowed, 'and')} alongside it`,
        ]),
  ];
  return clauses.length === 0
    ? named
    : `${named}, ${formatPlainWordList(clauses, 'and')}`;
}

function mapScriptTask(
  el: ModdleElement,
  warnings: ImportWarning[],
): ScriptTask {
  const id = requireId(el);
  const resource = readNamespacedAttr(el, 'resource');
  if (resource !== undefined) {
    throw new UnsupportedExtensionFormError(
      id,
      externalResourceDetail(`the script on '${id}'`, resource),
    );
  }
  const named = readNamed(el, id, warnings);
  // moddle reads an absent attribute as `undefined` and an empty one as `''`;
  // `BpmnParse.parseScriptTaskElement` defaults only the former to
  // `ScriptingEngines.DEFAULT_SCRIPTING_LANGUAGE`, while `ScriptUtil.getScript`
  // refuses the latter.
  const rawFormat = el.get('scriptFormat') as string | undefined;
  if (rawFormat === '') {
    throw new UnsupportedExtensionFormError(
      id,
      `the script on '${id}' has an empty scriptFormat; ` +
        '`ScriptUtil.getScript` refuses to deploy it',
    );
  }
  const body = el.get('script');
  if (typeof body !== 'string') {
    throw new UnsupportedExtensionFormError(
      id,
      `the script on '${id}' has neither a script body nor a resource; ` +
        '`ScriptUtil.getScript` refuses to deploy it with neither',
    );
  }
  let format: string;
  if (rawFormat === undefined) {
    format = 'juel';
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The script on '${id}' has no scriptFormat; ` +
        '`BpmnParse.parseScriptTaskElement` substitutes ' +
        '`ScriptingEngines.DEFAULT_SCRIPTING_LANGUAGE` (juel), and it was ' +
        'imported as such.',
    });
  } else {
    const canonical = scriptFormatOf(rawFormat);
    if (canonical === undefined) {
      format = rawFormat;
      warnings.push({
        elementId: id,
        category: 'extensionAttribute',
        message:
          `The script on '${id}' names the language '${rawFormat}', which ` +
          'the DSL has no fence alias for; it was imported as written, and ' +
          'the printed script draws an error there.',
      });
    } else {
      format = canonical;
    }
  }
  checkScriptBody(body, id, `the script on '${id}'`, warnings);
  const resultVariable = readResultVariable(el, id, warnings);
  return {
    kind: 'scriptTask',
    id,
    ...named,
    format,
    code: body,
    ...(resultVariable === undefined ? {} : { resultVariable }),
    ...readEngineAttributes(el, id, warnings),
    ...readIoMapping(el, id, warnings),
  };
}

/** The two kinds that carry a flow taken when no condition matched. */
function mapDefaultingGateway(
  el: ModdleElement,
  kind: 'exclusiveGateway' | 'inclusiveGateway',
  warnings: ImportWarning[],
): ExclusiveGateway | InclusiveGateway {
  const id = requireId(el);
  refuseIoMapping(el, id, 'checkActivityInputOutputSupported');
  const named = readNamed(el, id, warnings, readString(el, 'name'));
  const defaultFlowId = getEl(el, 'default')?.id;

  return {
    kind,
    id,
    ...named,
    ...(defaultFlowId === undefined ? {} : { defaultFlowId }),
    ...readJobSettings(el, id, warnings),
  };
}

function mapParallelGateway(
  el: ModdleElement,
  warnings: ImportWarning[],
): ParallelGateway {
  const id = requireId(el);
  refuseIoMapping(el, id, 'checkActivityInputOutputSupported');
  const named = readNamed(el, id, warnings, readString(el, 'name'));
  return {
    kind: 'parallelGateway',
    id,
    ...named,
    ...readJobSettings(el, id, warnings),
  };
}

/** The branches this opens are validated by {@link checkWaitBranches}, which sees the whole container. */
function mapEventBasedGateway(
  el: ModdleElement,
  warnings: ImportWarning[],
): EventBasedGateway {
  const id = requireId(el);
  refuseIoMapping(el, id, 'checkActivityInputOutputSupported');
  if (readNamespacedFlag(el, 'asyncAfter') === true) {
    throw new UnsupportedEventFeatureError(
      id,
      `'${id}' is marked asyncAfter, which BpmnParse.parseEventBasedGateway ` +
        'refuses to deploy on a wait with several branches',
      `Drop the asyncAfter setting from '${id}'; its other job settings are ` +
        'read as written.',
    );
  }
  warnIgnoredWaitAttrs(el, id, warnings);
  const named = readNamed(el, id, warnings, readString(el, 'name'));
  return {
    kind: 'eventBasedGateway',
    id,
    ...named,
    ...readJobSettings(el, id, warnings),
  };
}

/**
 * `BpmnParse.parseEventBasedGateway` reads neither `instantiate` nor
 * `eventGatewayType`; both are reported by hand for the reason
 * {@link warnIgnoredQuantityAttrs} gives. `gatewayDirection` is left out on
 * purpose: it restates the flows and is stamped on most exported files, so
 * reporting it would bury the diagnostics that mean something.
 */
function warnIgnoredWaitAttrs(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): void {
  const report = (attr: string): void => {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The '${attr}' attribute on '${id}' was not imported: Operaton does ` +
        'not read it on a wait with several branches, so the imported ' +
        'process runs exactly as the source document does.',
    });
  };

  // Both read back as the moddle default when the document writes neither.
  if (el.get('instantiate') === true) report('instantiate');
  const gatewayType = readString(el, 'eventGatewayType');
  if (gatewayType !== undefined && gatewayType !== 'Exclusive') {
    report('eventGatewayType');
  }
}

/**
 * `JuelExpressionManager.createExpression` builds a literal from a condition
 * body with no `${`/`#{` opener, and `UelExpressionCondition.evaluate` throws
 * on the string it yields; the script can only spell that body inside
 * `${...}`, so the rewrap is reported as the change in what runs that it is.
 */
function mapSequenceFlow(
  el: ModdleElement,
  warnings: ImportWarning[],
): SequenceFlow {
  const id = requireId(el);
  warnDocumentationDrop(el, id, 'a sequence flow', warnings);

  const sourceRef = requireFlowEndpoint(el, 'sourceRef', id);
  const targetRef = requireFlowEndpoint(el, 'targetRef', id);

  const expressionEl = getEl(el, 'conditionExpression');
  const dropped =
    expressionEl === undefined ? DROPPED_CONDITIONS.get(el) : undefined;
  if (expressionEl !== undefined) {
    checkConditionExpressionForm(expressionEl, id, warnings);
  }
  if (dropped !== undefined) {
    if (dropped.xsiType !== 'tFormalExpression') {
      throw conditionTypeRefusal(dropped.xsiType, id);
    }
    // `BpmnParse.parseConditionExpression` reads `language` and `resource`
    // off the dropped element the same way.
    refuseOrWarnScriptedCondition(
      dropped.language,
      dropped.resource,
      id,
      warnings,
    );
  }
  const conditionExpression =
    expressionEl !== undefined
      ? readString(expressionEl, 'body')
      : dropped === undefined || dropped.body.trim().length === 0
        ? undefined
        : dropped.body;
  const written = expressionEl !== undefined || dropped !== undefined;
  if (written && conditionExpression === undefined) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The condition on '${id}' has an empty body: ` +
        'UelExpressionCondition.evaluate reads it as a string and fails the ' +
        'flow on every run ("condition expression returns non-Boolean"); ' +
        'the flow was imported with no condition.',
    });
  } else if (
    conditionExpression !== undefined &&
    !EXPRESSION_ANYWHERE.test(conditionExpression)
  ) {
    warnings.push({
      elementId: id,
      category: 'unmappedConstruct',
      message:
        `The condition on '${id}' is the bare text ` +
        `${JSON.stringify(conditionExpression)} with no "\${...}" or ` +
        '"#{...}" opener: UelExpressionCondition.evaluate reads it as a ' +
        'string and fails the flow on every run ("condition expression ' +
        'returns non-Boolean"); the script writes it inside "${...}", which ' +
        'evaluates it.',
    });
  }
  noteRewrappedExpression(
    conditionExpression,
    id,
    'bpmn:conditionExpression',
    warnings,
  );

  // The exporter names a conditioned flow by its condition text and an
  // unconditioned one not at all, so only a name that differs is lost.
  const name = readString(el, 'name');
  const derived =
    conditionExpression === undefined
      ? undefined
      : conditionLabel(conditionExpression);
  if (name !== undefined && name !== derived) {
    warnings.push({
      elementId: id,
      category: 'label',
      message:
        `The name ${JSON.stringify(name)} on the flow '${id}' was not ` +
        'imported: the script has no label for a flow, and the rebuilt ' +
        (derived === undefined
          ? 'document leaves this one unnamed.'
          : `document names this one by its condition (${JSON.stringify(derived)}).`),
    });
  }

  return {
    id,
    sourceRef,
    targetRef,
    ...(conditionExpression === undefined ? {} : { conditionExpression }),
  };
}

function conditionTypeRefusal(
  xsiType: string,
  id: string,
): UnsupportedConditionExpressionError {
  return new UnsupportedConditionExpressionError(
    id,
    `it is typed xsi:type="${xsiType}", which ` +
      'BpmnParse.parseConditionExpression fails the deployment on ' +
      '("Invalid type, only tFormalExpression is currently supported")',
  );
}

/**
 * `parseConditionExpression` fails the deployment on an `xsi:type` that does
 * not resolve to `tFormalExpression` and accepts an absent one; moddle
 * resolves a prefixed type the same way, so the element's `$type` is
 * `bpmn:FormalExpression` exactly when the engine accepts it, and the raw
 * `$attrs` entry says whether one was written at all. With a `language` the
 * engine builds a `ScriptCondition` rather than a UEL one, which this surface
 * cannot write; `resource` is read inside that branch alone.
 */
function checkConditionExpressionForm(
  expressionEl: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): void {
  const xsiType = expressionEl.$attrs['xsi:type'];
  if (xsiType !== undefined && expressionEl.$type !== 'bpmn:FormalExpression') {
    throw conditionTypeRefusal(xsiType, id);
  }
  refuseOrWarnScriptedCondition(
    readString(expressionEl, 'language'),
    readNamespacedAttr(expressionEl, 'resource'),
    id,
    warnings,
  );
}

/** Shared by the moddle-parsed condition and a {@link DroppedCondition}, which the engine reads alike. */
function refuseOrWarnScriptedCondition(
  language: string | undefined,
  resource: string | undefined,
  id: string,
  warnings: ImportWarning[],
): void {
  if (language !== undefined) {
    throw new UnsupportedConditionExpressionError(
      id,
      resource === undefined
        ? `it declares language="${language}", which Operaton runs in a ` +
            'script engine rather than evaluating as UEL'
        : `it declares language="${language}" with operaton:resource=` +
            `"${resource}", which Operaton runs as that deployed script ` +
            'rather than the body written here',
    );
  }
  if (resource !== undefined) {
    warnings.push({
      elementId: id,
      category: 'extensionAttribute',
      message:
        `The 'operaton:resource' setting on '${id}' only takes effect ` +
        'alongside a language attribute; on its own the condition runs as ' +
        'the expression written in the body, and the attribute was not ' +
        'imported.',
    });
  }
}

function requireFlowEndpoint(
  el: ModdleElement,
  property: 'sourceRef' | 'targetRef',
  id: string,
): string {
  const endpoint = el.get(property) as ModdleElement | undefined;
  if (endpoint === undefined || endpoint.id === undefined) {
    throw new Error(
      `<bpmn:sequenceFlow id="${id}"> has no resolvable ${property}.`,
    );
  }
  return endpoint.id;
}

function refuseMultipleEventDefinitions(
  id: string,
  defs: ModdleElement[],
  subject: string,
  allowed: string,
): void {
  if (defs.length > 1) {
    throw new UnsupportedEventFeatureError(
      id,
      `${subject} carries ${defs.length} event definitions: only a single ` +
        allowed,
    );
  }
}

/** Called on tasks and gateways too, which declare no `eventDefinitions`, so the fallback stays. */
function eventDefinitionsOf(el: ModdleElement): ModdleElement[] {
  return (el.get('eventDefinitions') as ModdleElement[] | undefined) ?? [];
}

function requireId(el: ModdleElement): string {
  if (el.id === undefined || el.id === '') {
    throw new Error(`<${el.$type}> is missing its required 'id' attribute.`);
  }
  return el.id;
}

/** An element-valued moddle property; moddle reports an absent one as `null`. */
function getEl(el: ModdleElement, name: string): ModdleElement | undefined {
  return (el.get(name) as ModdleElement | null | undefined) ?? undefined;
}

/** A string-valued moddle property, `undefined` when absent, empty, or non-string. */
function readString(el: ModdleElement, name: string): string | undefined {
  const value = el.get(name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A string-valued moddle property kept as written, `""` included, for the
 * texts the engine stores verbatim (a label, an assignee, a form field's
 * label and default, a listener's binding attribute); every other reader
 * folds an empty attribute into absent through {@link readString}.
 */
function readText(el: ModdleElement, name: string): string | undefined {
  const value = el.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * A `name`, dropped when it equals the label the export derives (`humanize(id)`
 * for every kind but a link event, whose label is its link name), which is
 * what makes DSL -> XML -> DSL idempotent.
 */
function readDerivableName(
  el: ModdleElement,
  id: string,
  derived: string = humanize(id),
): string | undefined {
  const name = readText(el, 'name');
  return name === undefined || name === derived ? undefined : name;
}

/**
 * The label and the documentation, read as one pair; a position with no node
 * to hold them reports both through {@link warnNamedDrop} instead. A gateway
 * passes `name` itself: its id is a structural coordinate the export derives
 * no label from, so a name equal to the derived one is still the author's.
 */
function readNamed(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
  name = readDerivableName(el, id),
): Named {
  const documentation = readDocumentation(el, id, warnings);
  return {
    ...(name === undefined ? {} : { name }),
    ...(documentation === undefined ? {} : { documentation }),
  };
}

/**
 * The text of a single plaintext `bpmn:documentation` child, verbatim; more
 * than one child, or a `textFormat` other than plain text, is reported
 * instead. moddle answers the `text/plain` default for an absent `textFormat`.
 */
function readDocumentation(
  el: ModdleElement,
  id: string,
  warnings: ImportWarning[],
): string | undefined {
  const children = documentationChildren(el);
  const [first] = children;
  if (first === undefined) return undefined;
  const report = (detail: string): undefined => {
    warnings.push({
      elementId: id,
      category: 'documentation',
      message: `The documentation on '${id}' was not imported: ${detail}.`,
    });
    return undefined;
  };
  if (children.length > 1) {
    return report(
      `this surface holds one <bpmn:documentation> and '${id}' carries ` +
        String(children.length),
    );
  }
  const textFormat = first.get('textFormat');
  if (textFormat !== 'text/plain') {
    return report(
      'this surface holds plain text and its textFormat is ' +
        `'${String(textFormat)}'`,
    );
  }
  const text = first.get('text');
  return typeof text === 'string' ? text : '';
}

function documentationChildren(el: ModdleElement): ModdleElement[] {
  return el.get('documentation') as ModdleElement[];
}

/** `get` falls back to the raw `$attrs` map for an undeclared property. */
function readNamespacedAttr(
  el: ModdleElement,
  localName: string,
): string | undefined {
  const value = el.get(`operaton:${localName}`);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extensionValues(el: ModdleElement): ModdleElement[] {
  const extensionElements = el.get('extensionElements') as
    ModdleElement | undefined;
  if (extensionElements === undefined) return [];
  return extensionElements.get('values') as ModdleElement[];
}

/** The one `operaton:inputOutput` block; `BpmnParseUtil.parseInputOutput` fails the deployment on a second. */
function onlyIoMapping(
  el: ModdleElement,
  ownerId: string,
): ModdleElement | undefined {
  return onlyExtensionElement(
    el,
    'operaton:InputOutput',
    ownerId,
    'BpmnParseUtil.parseInputOutput',
  );
}

/** The settings a repetition element carries as a step does ({@link LoopCharacteristics}), as {@link jobSettings} takes them. */
function readRunSettings(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): Omit<Parameters<typeof jobSettings>[0], 'jobPriority'> {
  // `DefaultFailedJobParseListener` reads the cycle on an async step, a
  // timer-driven event and a typed throw alone; the refusal names that rather
  // than deriving it per element kind.
  const retryCycleEl = onlyExtensionElement(
    el,
    'operaton:FailedJobRetryTimeCycle',
    ownerId,
    'DefaultFailedJobParseListener.setFailedJobRetryTimeCycleValue',
    ' on an async step, a timer-driven event or a typed throw',
  );
  return {
    asyncBefore: readAsyncBefore(el, ownerId, warnings),
    asyncAfter: readNamespacedFlag(el, 'asyncAfter'),
    exclusive: readNamespacedFlag(el, 'exclusive'),
    retryCycle:
      retryCycleEl === undefined ? undefined : readString(retryCycleEl, 'body'),
  };
}

export function asyncRespellingMessage(subject: string): string {
  return (
    `The operaton:async="true" on ${subject} imports as asyncBefore: true: ` +
    'BpmnParse.isAsyncBefore reads the two spellings as one, and this ' +
    'tool writes it back as operaton:asyncBefore, which the engine reads ' +
    'the same.'
  );
}

/**
 * `BpmnParse.isAsyncBefore` reads `operaton:async="true"` as `asyncBefore`
 * on every element it parses a continuation for, the repetition included; the
 * descriptor declares `asyncBefore` alone, so `async` is read raw.
 */
function readAsyncBefore(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): boolean | undefined {
  const declared = readNamespacedFlag(el, 'asyncBefore');
  if (readNamespacedAttr(el, 'async') !== 'true') return declared;
  const subject =
    el.$type === MULTI_INSTANCE
      ? `the repetition of '${ownerId}'`
      : `'${ownerId}'`;
  warnings.push({
    elementId: ownerId,
    category: 'unmappedConstruct',
    message: asyncRespellingMessage(subject),
  });
  return true;
}

export function priorityRefusal(attr: string, value: string): string {
  return (
    `operaton:${attr}="${value}", which BpmnParse.parsePriority refuses to ` +
    `deploy ("Value '${value}' for attribute '${attr}' is not a valid number")`
  );
}

/** `BpmnParse.parsePriority` parses a constant with `Integer.parseInt` and fails the deployment on any other. */
function requireIntegerOrExpression(
  value: string | undefined,
  ownerId: string,
  attr: string,
): string | undefined {
  if (
    value === undefined ||
    FORM_BOUND_TEXT.test(value) ||
    EXPRESSION_OPEN.test(value)
  ) {
    return value;
  }
  throw new UnsupportedExtensionFormError(
    ownerId,
    priorityRefusal(attr, value),
  );
}

function readJobSettings(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): JobSettings {
  const run = readRunSettings(el, ownerId, warnings);
  const timer = eventDefinitionsOf(el).find(
    (def) => def.$type === 'bpmn:TimerEventDefinition',
  );
  return jobSettings({
    ...run,
    ...(timer === undefined
      ? {}
      : {
          exclusive: timerJobExclusive(timer, run.exclusive, ownerId, warnings),
        }),
    jobPriority: requireIntegerOrExpression(
      readNamespacedAttr(el, 'jobPriority'),
      ownerId,
      'jobPriority',
    ),
  });
}

/**
 * `BpmnParse.parseTimer` locks the timer job by `operaton:exclusive` on the
 * definition; the same attribute on the event tag reaches only the async
 * continuation job. The surface spells one value for both, so the
 * definition's wins and the tag's stands in where the definition carries none.
 */
function timerJobExclusive(
  defEl: ModdleElement,
  tagValue: boolean | undefined,
  ownerId: string,
  warnings: ImportWarning[],
): boolean | undefined {
  const value = readNamespacedFlag(defEl, 'exclusive');
  if (value === undefined) return tagValue;
  if (tagValue !== undefined && tagValue !== value) {
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `'${ownerId}' writes operaton:exclusive="${tagValue}" on the event, ` +
        'which governs its async continuation job, and ' +
        `operaton:exclusive="${value}" on its timer definition, which ` +
        'governs the timer job; this tool keeps one value for both and ' +
        "took the timer definition's.",
    });
  }
  return value;
}

function readEngineAttributes(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): EngineAttributes {
  const settings = readJobSettings(el, ownerId, warnings);
  const executionListeners = readExecutionListeners(el, ownerId, warnings);
  return {
    ...settings,
    ...(executionListeners === undefined ? {} : { executionListeners }),
  };
}

/**
 * Whether the document wrote the declared property `name`: moddle answers a
 * schema default through `get` for one it never wrote, and stores a parsed
 * value as an own property alone.
 */
function isAuthored(el: ModdleElement, name: string): boolean {
  return Object.hasOwn(el, name);
}

function readNamespacedFlag(
  el: ModdleElement,
  localName: string,
): boolean | undefined {
  if (!isAuthored(el, localName)) return undefined;
  const value = el.get(`operaton:${localName}`);
  return typeof value === 'boolean' ? value : undefined;
}

function readFormFields(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): FormField[] | undefined {
  const formData = onlyExtensionElement(
    el,
    'operaton:FormData',
    ownerId,
    'DefaultFormHandler.parseFormData',
  );
  if (formData === undefined) {
    return undefined;
  }
  const fields = formData.get('fields') as ModdleElement[];
  if (fields.length === 0) {
    return undefined;
  }
  return fields.map((field) => readFormField(field, ownerId, warnings));
}

/** A warning sink bound to one owner. */
type Report = (message: string) => void;

interface FieldContext {
  fieldId: string;
  ownerId: string;
  type: FormFieldType;
  /** `form field 'x' of 'T'`. */
  subject: string;
  report: Report;
}

/** The one shape for content the engine deploys but the compiler refuses. */
function warnCarriedAsWritten(
  { subject, report }: FieldContext,
  what: string,
  reason: string,
): void {
  report(
    `The ${what} on ${subject} was imported as written, and the printed ` +
      `script draws an error at the field: ${reason}.`,
  );
}

/**
 * A form field id or an io parameter name is the variable the engine sets
 * (`FormFieldHandler.handleSubmit`, `InputParameter.execute`), and the script
 * writes it as a bare name, so a minted name would change the variable.
 */
function refuseUnspellableVariable(
  name: string,
  what: string,
  ownerId: string,
): void {
  if (isWritableName(name)) return;
  throw new UnsupportedExtensionFormError(
    ownerId,
    `${what} '${name}' names a variable the script cannot spell (a name is ` +
      "letters, digits and '_', with '-' between them, and no keyword), and " +
      'the engine sets the variable under that name, so writing another ' +
      'would change what runs',
  );
}

function readFormField(
  field: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): FormField {
  const fieldId = requireId(field);
  refuseUnspellableVariable(fieldId, 'operaton:formField', ownerId);
  const type = importFormFieldType(readString(field, 'type'), fieldId, ownerId);
  const ctx: FieldContext = {
    fieldId,
    ownerId,
    type,
    subject: `form field '${fieldId}' of '${ownerId}'`,
    report: (message) => {
      warnings.push({
        elementId: ownerId,
        category: 'extensionAttribute',
        message,
      });
    },
  };

  const label = readText(field, 'label');
  const defaultValue = readText(field, 'defaultValue');
  let datePattern = readString(field, 'datePattern');
  if (datePattern !== undefined && type !== 'date') {
    ctx.report(
      `The 'datePattern' on ${ctx.subject} was not imported; ` +
        'FormTypes.parseFormPropertyType reads it on a date field alone.',
    );
    datePattern = undefined;
  }
  const values = readEnumValues(field, ctx);
  const constraints = readConstraints(field, ctx);
  const propertiesEl = getEl(field, 'properties');
  const properties =
    propertiesEl === undefined
      ? []
      : readPropertyEntries(propertiesEl, 'id', ctx.subject, ctx.report);

  // `FormFieldHandler.createFormField` converts the default through the type
  // on every render; a literal is decided here, an expression at run time.
  if (defaultValue !== undefined && !EXPRESSION_ANYWHERE.test(defaultValue)) {
    const reason = literalDefaultReason(
      defaultValue,
      type,
      datePattern,
      values,
    );
    if (reason !== undefined) {
      warnCarriedAsWritten(ctx, `default '${defaultValue}'`, reason);
    }
  }

  return {
    id: fieldId,
    type,
    ...(label === undefined ? {} : { label }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(datePattern === undefined ? {} : { datePattern }),
    ...(values.length === 0 ? {} : { values }),
    ...(constraints.length === 0 ? {} : { constraints }),
    ...(properties.length === 0 ? {} : { properties }),
  };
}

const ISO_DATE_ONLY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** Why a literal default fails the conversion its type runs on every render, or `undefined` when it converts. */
function literalDefaultReason(
  value: string,
  type: FormFieldType,
  datePattern: string | undefined,
  values: FormFieldValue[],
): string | undefined {
  switch (type) {
    case 'number':
      return FORM_BOUND_TEXT.test(value)
        ? undefined
        : 'LongFormType.convertValue parses it with Long.valueOf on every ' +
            'render of the form, and it is not an integer';
    case 'boolean': {
      const lower = value.toLowerCase();
      return lower === 'true' || lower === 'false'
        ? undefined
        : 'BooleanFormType.convertValue reads it through Boolean.valueOf on ' +
            'every render of the form';
    }
    case 'date':
      return datePattern === undefined && ISO_DATE_ONLY_TEXT.test(value)
        ? 'DateFormType parses it on every render of the form under the ' +
            'engine\'s own "dd/MM/yyyy" (ProcessEngineConfigurationImpl.' +
            'initFormTypes), since the field names no pattern, and an ISO ' +
            'date does not fit it'
        : undefined;
    case 'enum':
      return values.some((entry) => entry.id === value)
        ? undefined
        : "it names none of the field's values, and EnumFormType.validateValue " +
            'refuses it on every render of the form';
    case 'string':
      return undefined;
    default: {
      const exhaustive: never = type;
      throw new Error(`unhandled form field type ${String(exhaustive)}`);
    }
  }
}

/**
 * `FormTypes.parseFormPropertyType` reads the `operaton:value` children on an
 * enum field alone, into a `LinkedHashMap`: a repeated id keeps its first
 * position and takes its last `name`.
 */
function readEnumValues(
  field: ModdleElement,
  { type, subject, report }: FieldContext,
): FormFieldValue[] {
  const valueEls = field.get('values') as ModdleElement[];
  if (valueEls.length === 0) return [];
  if (type !== 'enum') {
    const n = valueEls.length;
    report(
      `The ${n} operaton:value ${n === 1 ? 'child' : 'children'} of ` +
        `${subject} ${n === 1 ? 'was' : 'were'} not imported; ` +
        'FormTypes.parseFormPropertyType reads them on an enum field alone.',
    );
    return [];
  }
  const byId = new Map<string, FormFieldValue>();
  valueEls.forEach((valueEl, i) => {
    const id = readString(valueEl, 'id');
    if (id === undefined) {
      report(
        `The operaton:value #${i + 1} of ${subject} has no id and was not imported.`,
      );
      return;
    }
    if (byId.has(id)) {
      report(
        `The operaton:value '${id}' of ${subject} is written twice and was ` +
          'imported once, at its first position with its last name, as ' +
          'FormTypes.parseFormPropertyType keeps it (LinkedHashMap.put).',
      );
    }
    const label = readString(valueEl, 'name');
    byId.set(id, { id, ...(label === undefined ? {} : { label }) });
  });
  return [...byId.values()];
}

/** The four bounds, each by the validator that parses `config` as an integer on every submission. */
const BOUND_VALIDATORS: Readonly<Record<string, string>> = {
  min: 'MinValidator.validate',
  max: 'MaxValidator.validate',
  minlength: 'MinLengthValidator.validate',
  maxlength: 'MaxLengthValidator.validate',
};

/** The constraints whose `config` the engine never reads, by the method that ignores it. */
const FLAG_VALIDATORS: Readonly<Record<string, string>> = {
  required: 'RequiredValidator.validate',
  readonly: 'ReadOnlyValidator.validate',
};

/** Read `operaton:validation` in document order, which is the engine's validation order. */
function readConstraints(
  field: ModdleElement,
  ctx: FieldContext,
): FormFieldConstraint[] {
  const { fieldId, ownerId, type, subject, report } = ctx;
  const constraintEls =
    (getEl(field, 'validation')?.get('constraints') as
      ModdleElement[] | undefined) ?? [];
  const read: FormFieldConstraint[] = [];
  for (const constraintEl of constraintEls) {
    const name = readString(constraintEl, 'name');
    const config = readString(constraintEl, 'config');
    const refuse = (detail: string): UnsupportedFormFieldConstraintError =>
      new UnsupportedFormFieldConstraintError(
        ownerId,
        fieldId,
        name ?? '(none)',
        detail,
      );
    if (name === undefined) throw refuse('it has no name');
    if (!isFormConstraintName(name)) {
      throw refuse('no validator is registered under that name');
    }
    if (read.some((constraint) => constraint.name === name)) {
      throw refuse(
        'DefaultFormHandler.parseValidation deploys both, and this script ' +
          'holds each constraint once per field',
      );
    }
    const flag = FLAG_VALIDATORS[name];
    if (flag !== undefined) {
      if (config !== undefined) {
        report(
          `The config '${config}' on the '${name}' constraint of ${subject} ` +
            `was not imported; ${flag} never reads it.`,
        );
      }
      read.push({ name });
      continue;
    }
    const bound = BOUND_VALIDATORS[name];
    if (config === undefined) {
      throw refuse(
        bound === undefined
          ? 'FormValidators.createValidator needs a class name or an ' +
              'expression in its config'
          : `${bound} parses its config on every submission`,
      );
    }
    if (bound !== undefined) {
      const fits = FORM_CONSTRAINT_TYPES[name];
      if (!fits.includes(type)) {
        warnCarriedAsWritten(
          ctx,
          `'${name}' constraint`,
          `'${name}' fits a ${formatPlainWordList(fits)} field alone, and ` +
            `'${fieldId}' is a ${type} field, whose every submitted value ` +
            `${bound} refuses`,
        );
      }
      if (!FORM_BOUND_TEXT.test(config)) {
        warnCarriedAsWritten(
          ctx,
          `'${name}' constraint`,
          `${bound} parses its config as an integer on every submission, ` +
            `and '${config}' is not one`,
        );
      }
    }
    read.push({ name, config });
  }
  return read;
}

/**
 * What a repeated key comes to, by the attribute the engine reader keys on:
 * `DefaultFormHandler.parseProperties` reads a form field's by `id` into a
 * `LinkedHashMap`, `BpmnParseUtil.parseOperatonExtensionProperties` an
 * external task's by `name` into a `HashMap`, which keeps no position.
 */
const PROPERTY_REWRITE_BY_KEY = {
  id: ', at its first position with its last value, as DefaultFormHandler.parseProperties keeps it (LinkedHashMap.put)',
  name: ' with its last value, as BpmnParseUtil.parseOperatonExtensionProperties keeps it (HashMap.put), at its first position',
} as const;

function readPropertyEntries(
  properties: ModdleElement,
  keyAttr: keyof typeof PROPERTY_REWRITE_BY_KEY,
  subject: string,
  report: Report,
): ExtensionProperty[] {
  const entries = properties.get('values') as ModdleElement[];
  const byKey = new Map<string, ExtensionProperty>();
  entries.forEach((entry, i) => {
    const key = readString(entry, keyAttr);
    // Both readers `put` the attribute as written, so `value=""` is an entry.
    const raw = entry.get('value');
    const value = typeof raw === 'string' ? raw : undefined;
    if (key === undefined || value === undefined) {
      report(
        `The operaton:property ${key === undefined ? `#${i + 1}` : `'${key}'`} ` +
          `of ${subject} has no ${key === undefined ? keyAttr : 'value'} and ` +
          'was not imported.',
      );
      return;
    }
    if (byKey.has(key)) {
      report(
        `The operaton:property '${key}' of ${subject} is written twice and ` +
          `was imported once${PROPERTY_REWRITE_BY_KEY[keyAttr]}.`,
      );
    }
    byKey.set(key, { key, value });
  });
  return [...byKey.values()];
}

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

/**
 * The one `<extensionElements>` child of `type`. `Element.elementNS` throws
 * on a second child of one tag wherever `reader`, the engine method that asks
 * for it, runs; `when` names that shape where a caller cannot cheaply gate
 * the refusal on it.
 */
function onlyExtensionElement(
  el: ModdleElement,
  type: string,
  ownerId: string,
  reader: string,
  when = '',
): ModdleElement | undefined {
  const matches = extensionValues(el).filter((value) => value.$type === type);
  if (matches.length > 1) {
    const tag = xmlTagOf(type);
    throw new UnsupportedExtensionFormError(
      ownerId,
      `${matches.length} <${tag}> blocks, which Element.elementNS throws on ` +
        `when ${reader} reads them${when} ("Parsing exception: multiple ` +
        `elements with tag name '${localNameOf(tag)}' ` +
        'found"), and BpmnParse.execute lets that fail the deployment',
    );
  }
  return matches[0];
}

/** Declaration order is Operaton's evaluation order. */
function readIoMapping(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): IoMapped {
  const io = onlyIoMapping(el, ownerId);
  if (io === undefined) return {};

  return ioMapped(
    readIoParameters(io, 'input', ownerId, warnings),
    readIoParameters(io, 'output', ownerId, warnings),
  );
}

function readIoParameters(
  io: ModdleElement,
  direction: 'input' | 'output',
  ownerId: string,
  warnings: ImportWarning[],
): IoParameter[] {
  const tag = `operaton:${direction}Parameter`;
  const params = io.get(`${direction}Parameters`) as ModdleElement[];
  const read = params.map((param) => {
    const name = readString(param, 'name');
    if (name === undefined) {
      throw new UnsupportedExtensionFormError(
        ownerId,
        `an ${tag} has no name, so there is nothing to bind its value to`,
      );
    }
    refuseUnspellableVariable(name, tag, ownerId);
    return {
      name,
      value: readParameterValue(param, ownerId, `${tag} '${name}'`, warnings),
    };
  });
  const executeMethod =
    direction === 'input'
      ? 'executeInputParameters'
      : 'executeOutputParameters';
  refuseRepeatedExtensionKey(
    read.map((param) => param.name),
    ownerId,
    (name) =>
      `two ${tag} children share name="${name}"; Operaton runs both, the ` +
      `last write winning (IoMapping.${executeMethod}), and this ` +
      'script binds each parameter name once per direction',
  );
  return read;
}

/**
 * A parameter's or an entry's value: verbatim body text, or exactly one
 * nested value. The moddle descriptor declares the nested value as a
 * repeating property so that two of them stay visible here.
 * `BpmnParseUtil.parseNestedParamValueProvider` reads the one child element
 * and never the body text beside it, so that combination warns.
 */
function readParameterValue(
  holder: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): IoValue {
  const text = readString(holder, 'value');
  const nested = holder.get('definitions') as ModdleElement[];

  if (nested.length > 1) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `${where} carries ${nested.length} nested values ` +
        `(${nested.map((value) => value.$type).join(', ')}), and a value is one`,
    );
  }
  if (nested.length === 1) {
    if (text !== undefined) {
      warnings.push({
        elementId: ownerId,
        category: 'extensionAttribute',
        message:
          `${where} carries both body text and a nested ` +
          `<${nested[0].$type}> value: BpmnParseUtil` +
          '.parseNestedParamValueProvider reads the nested value and never ' +
          'the text, and the document written back carries the nested ' +
          'value alone.',
      });
    }
    return readNestedValue(nested[0], ownerId, where, 'value', warnings);
  }
  return { kind: 'text', text: text ?? '' };
}

/**
 * The moddle descriptor declares both positions as the shared abstract
 * supertype, so an `operaton:entry` parses under a parameter as readily as in
 * an `operaton:map`; `position` is what tells the two apart.
 */
function readNestedValue(
  def: ModdleElement,
  ownerId: string,
  where: string,
  position: 'value' | 'item',
  warnings: ImportWarning[],
): IoValue {
  switch (def.$type) {
    case 'operaton:List':
      return {
        kind: 'list',
        items: (def.get('items') as ModdleElement[]).map((item) =>
          readNestedValue(item, ownerId, where, 'item', warnings),
        ),
      };
    case 'operaton:Map':
      return {
        kind: 'map',
        entries: (def.get('entries') as ModdleElement[]).map((entry) =>
          readMapEntry(entry, ownerId, where, warnings),
        ),
      };
    case 'operaton:Script':
      return readScriptValue(
        def,
        ownerId,
        `the operaton:script in ${where}`,
        warnings,
      );
    case 'operaton:Value':
      if (position === 'item') {
        return { kind: 'text', text: readString(def, 'value') ?? '' };
      }
      break;
    default:
      break;
  }
  throw new UnsupportedExtensionFormError(
    ownerId,
    position === 'item'
      ? `an operaton:list in ${where} carries a <${def.$type}>; a list holds ` +
          'values, and an entry belongs in an operaton:map'
      : `${where} carries a <${def.$type}> where a value belongs; an entry ` +
          'belongs in an operaton:map',
  );
}

function readMapEntry(
  entry: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): { key: string; value: IoValue } {
  const key = readString(entry, 'key');
  if (key === undefined) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `an operaton:entry in ${where} has no key, so there is nothing to look ` +
        'its value up by',
    );
  }
  return {
    key,
    value: readParameterValue(
      entry,
      ownerId,
      `operaton:entry '${key}' in ${where}`,
      warnings,
    ),
  };
}

/**
 * `ScriptUtil.getScript` runs a resource in place of an inline body whenever
 * both are given, so importing the body would keep a script the engine never
 * runs; one rule for a script value's `resource` and a task's `operaton:resource`.
 */
function externalResourceDetail(where: string, resource: string): string {
  return (
    `${where} names an external resource ("${resource}"); ` +
    'ScriptUtil.getScript runs the resource in place of the body, and only ' +
    'an inline body can be written here'
  );
}

function readScriptValue(
  script: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): ScriptValue {
  const resource = readString(script, 'resource');
  if (resource !== undefined) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      externalResourceDetail(where, resource),
    );
  }
  const format = readString(script, 'scriptFormat');
  if (format === undefined) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `${where} has no scriptFormat, so there is no language to evaluate its ` +
        'body in',
    );
  }
  const code = readString(script, 'value') ?? '';
  checkScriptBody(code, ownerId, where, warnings);
  return { kind: 'script', format, code };
}

/**
 * The grammar's fence terminal ends at the first three backticks after its
 * tag, so a body holding three has no fence that can enclose it. An empty
 * body is carried: `ScriptUtil.getScript` checks the source for null and not
 * for emptiness, so the engine deploys it.
 */
function checkScriptBody(
  code: string,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): void {
  if (code.includes('```')) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `${where} contains three consecutive backticks, which no script fence ` +
        'this language has can enclose',
    );
  }
  if (code.trim() === '') {
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `The body of ${where} is empty: ScriptUtil.getScript deploys it, ` +
        'since it checks the source for null and not for emptiness, and ' +
        'the printed script draws an empty-body error there.',
    });
  }
}

interface ListenerSpec<E extends string> {
  type: string;
  tag: string;
  events: readonly E[];
  ownerId: string;
  warnings: ImportWarning[];
}

/**
 * Document order is run order: `CoreModelElement.addListenerToMap` and
 * `TaskDefinition.addTaskListener` append to a per-event list, so several
 * listeners on one event are an ordinary shape; a `timeout` listener is keyed
 * by its own id instead (`TaskDefinition.addTimeoutTaskListener`).
 */
function readListeners<E extends string, X extends object>(
  el: ModdleElement,
  spec: ListenerSpec<E>,
  extra: (listener: ModdleElement, event: E) => X,
): ({ event: E; binding: ListenerBinding } & X)[] | undefined {
  const found = extensionValues(el).filter(
    (value) => value.$type === spec.type,
  );
  if (found.length === 0) return undefined;

  return found.map((listener) => {
    const event = readListenerEvent(listener, spec);
    const rest = extra(listener, event);
    return { event, binding: readListenerBinding(listener, spec), ...rest };
  });
}

function readExecutionListeners(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): ExecutionListener[] | undefined {
  return readListeners(
    el,
    {
      type: 'operaton:ExecutionListener',
      tag: 'operaton:executionListener',
      events: EXECUTION_LISTENER_EVENTS,
      ownerId,
      warnings,
    },
    () => ({}),
  );
}

function readTaskListeners(
  el: ModdleElement,
  ownerId: string,
  warnings: ImportWarning[],
): TaskListener[] | undefined {
  return readListeners(
    el,
    {
      type: 'operaton:TaskListener',
      tag: 'operaton:taskListener',
      events: TASK_LISTENER_EVENTS,
      ownerId,
      warnings,
    },
    (listener, event) => {
      const timer = readListenerTimer(listener, ownerId, event, warnings);
      return timer === undefined ? {} : { timer };
    },
  );
}

function readListenerEvent<E extends string>(
  listener: ModdleElement,
  spec: ListenerSpec<E>,
): E {
  const event = readString(listener, 'event');
  if (event === undefined) {
    throw new UnsupportedExtensionFormError(
      spec.ownerId,
      `an ${spec.tag} has no event, so there is no point in the lifecycle ` +
        'for it to fire at',
    );
  }
  if (!(spec.events as readonly string[]).includes(event)) {
    throw new UnsupportedExtensionFormError(
      spec.ownerId,
      `an ${spec.tag} has event="${event}", which is not one of ` +
        spec.events.join(', '),
    );
  }
  return event as E;
}

function readListenerBinding(
  listener: ModdleElement,
  spec: ListenerSpec<string>,
): ListenerBinding {
  const { ownerId, tag, warnings } = spec;
  return withInjectedFields(
    resolveListenerBinding(listener, spec),
    listener,
    ownerId,
    `an ${tag} on '${ownerId}'`,
    warnings,
  );
}

/**
 * `BpmnParse.parseTaskListener` checks no binding attribute for emptiness, so
 * an empty `class` or `delegateExpression` deploys and fails when the event
 * fires; an empty `expression` evaluates to the empty text instead.
 */
function buildEmptyTaskListenerBindingWarning(
  ownerId: string,
  tag: string,
  attr: 'class' | 'delegateExpression',
): ImportWarning {
  return {
    elementId: ownerId,
    category: 'extensionAttribute',
    message:
      `An ${tag} on '${ownerId}' has ${attr}="": ` +
      'BpmnParse.parseTaskListener checks no listener attribute for ' +
      'emptiness, so the task deploys and the listener fails when its ' +
      'event fires, and the document written back carries the empty text.',
  };
}

/**
 * `BpmnParse.parseExecutionListener`/`parseTaskListener` read `class`, then
 * `expression`, then `delegateExpression`, then an `operaton:script` child,
 * and run the first; every loser warns rather than refuses, since the engine
 * drops it too. Each attribute is read through {@link readText}, so an empty
 * one is seen rather than folded into absent.
 */
function resolveListenerBinding(
  listener: ModdleElement,
  spec: ListenerSpec<string>,
): ListenerBinding {
  const { ownerId, tag, warnings } = spec;
  const isExecutionListener = spec.type === 'operaton:ExecutionListener';
  const className = readText(listener, 'class');
  const expression = readText(listener, 'expression');
  const delegate = readText(listener, 'delegateExpression');
  const script = getEl(listener, 'script');

  const present: ('class' | 'expression' | 'delegateExpression' | 'script')[] =
    [];
  if (className !== undefined) present.push('class');
  if (expression !== undefined) present.push('expression');
  if (delegate !== undefined) present.push('delegateExpression');
  if (script !== undefined) present.push('script');

  if (present.length === 0) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `an ${tag} carries no binding: one of class, expression, ` +
        'delegateExpression, or an operaton:script child is what it runs',
    );
  }
  const [winner, ...losers] = present;
  // Named against the listener: "on 'Svc'" would read as the step's own binding.
  for (const loser of losers) {
    warnings.push(
      buildShadowedImplementationWarning(
        ownerId,
        loser,
        winner,
        `an ${tag} on '${ownerId}'`,
      ),
    );
  }

  switch (winner) {
    case 'class':
      if (className === '') {
        if (isExecutionListener) {
          throw new UnsupportedExtensionFormError(
            ownerId,
            `an ${tag} has class="", which BpmnParse.parseExecutionListener ` +
              `refuses ("Attribute 'class' cannot be empty")`,
          );
        }
        warnings.push(
          buildEmptyTaskListenerBindingWarning(ownerId, tag, 'class'),
        );
      }
      return { kind: 'class', className: className! };
    case 'expression':
      // Both listener kinds call `expression.getValue`, and JUEL reads `""`
      // as the empty string, so neither fails on it.
      if (expression === '') {
        warnings.push({
          elementId: ownerId,
          category: 'extensionAttribute',
          message:
            `An ${tag} on '${ownerId}' has expression="": ` +
            `${isExecutionListener ? 'ExpressionExecutionListener' : 'ExpressionTaskListener'} ` +
            'evaluates the empty text rather than refusing it, and the ' +
            'document written back carries it.',
        });
      }
      return { kind: 'expression', expression: expression! };
    case 'delegateExpression':
      if (delegate === '') {
        if (isExecutionListener) {
          throw new UnsupportedExtensionFormError(
            ownerId,
            `an ${tag} has delegateExpression="", which ` +
              'BpmnParse.parseExecutionListener refuses ("Attribute ' +
              "'delegateExpression' cannot be empty\")",
          );
        }
        warnings.push(
          buildEmptyTaskListenerBindingWarning(
            ownerId,
            tag,
            'delegateExpression',
          ),
        );
      }
      return { kind: 'delegateExpression', expression: delegate! };
    case 'script':
      return readScriptValue(
        script!,
        ownerId,
        `the operaton:script in an ${tag}`,
        warnings,
      );
  }
}

function readListenerTimer(
  listener: ModdleElement,
  ownerId: string,
  event: (typeof TASK_LISTENER_EVENTS)[number],
  warnings: ImportWarning[],
): Extract<EventDefinition, { kind: 'timer' }> | undefined {
  const defs = eventDefinitionsOf(listener);

  if (event !== 'timeout') {
    if (defs.length > 0) {
      warnings.push({
        elementId: ownerId,
        category: 'extensionAttribute',
        message:
          `The ${defs[0].$type} on an operaton:taskListener with ` +
          `event="${event}" was not imported: BpmnParse.parseTaskListener ` +
          'reads no event definition off a listener that is not a timeout, ' +
          'and the document written back carries none.',
      });
    }
    return undefined;
  }
  if (defs.length === 0) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      'an operaton:taskListener with event="timeout" carries no ' +
        'bpmn:timerEventDefinition, so nothing would ever fire it',
    );
  }
  if (defs.length > 1) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `an operaton:taskListener with event="timeout" carries ${defs.length} ` +
        'bpmn:timerEventDefinition children, and a timeout has one due time',
    );
  }
  // A timeout listener has no job settings on the surface.
  const exclusive = readNamespacedFlag(defs[0], 'exclusive');
  if (exclusive !== undefined) {
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `The operaton:exclusive="${exclusive}" on the timer of an ` +
        `operaton:taskListener with event="timeout" on '${ownerId}' was not ` +
        'imported: this tool has no setting for it there, though Operaton ' +
        'locks the timeout job by it (BpmnParse.parseTimeoutTaskListener ' +
        'through parseTimer), so the document written back runs without it.',
    });
  }
  return { kind: 'timer', ...readTimerDefinition(defs[0], ownerId) };
}

/** The surface writes each piece of extension content under its key once, so a second has nowhere to go. */
function refuseRepeatedExtensionKey(
  keys: readonly string[],
  ownerId: string,
  detail: (key: string) => string,
): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new UnsupportedExtensionFormError(ownerId, detail(key));
    }
    seen.add(key);
  }
}

/** A listener declares `fields` as a property (moddle materializes it, empty or not); a step carries them loose in `extensionElements`. */
function fieldChildren(carrier: ModdleElement): ModdleElement[] {
  const declared = carrier.get('fields') as ModdleElement[] | undefined;
  return (
    declared ??
    extensionValues(carrier).filter((value) => value.$type === 'operaton:Field')
  );
}

/** How the drop names a binding that receives no field list. */
const FIELDLESS_BINDING: Readonly<
  Record<'expression' | 'external' | 'decision' | 'script', string>
> = {
  expression: 'operaton:expression',
  external: 'operaton:type="external"',
  decision: 'an operaton:decisionRef',
  script: 'an operaton:script child',
};

/**
 * Operaton hands the field list to the behaviours a class, a delegate
 * expression and a built-in type select and to no other, on a step and on
 * both listener kinds alike, so a field under any other binding is reported.
 */
function withInjectedFields<B extends ServiceTaskBinding | ListenerBinding>(
  binding: B,
  carrier: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): B {
  const children = fieldChildren(carrier);
  if (children.length === 0) return binding;

  if (!carriesFields(binding)) {
    const reason =
      'Operaton injects a field into a class, a delegate or a built-in mail ' +
      'or shell binding and into no other, and this one is bound by ' +
      FIELDLESS_BINDING[binding.kind];
    for (const field of children) {
      warnFieldDrop(field, ownerId, where, reason, warnings);
    }
    return binding;
  }

  const fields = children.flatMap(
    (field) => readField(field, ownerId, where, warnings) ?? [],
  );
  return fields.length === 0 ? binding : { ...binding, fields };
}

/** The grammar's `RAW_TEMPLATE` terminal opens directly after the quote. */
const RAW_TEMPLATE_OPEN = /^[$#]\{/;

/**
 * The three slots Operaton writes a field's value in, and whether it
 * evaluates that slot. The IR holds one text and picks the slot back off its
 * leading `${` or `#{`, so a slot whose text disagrees with it is reported.
 */
const FIELD_VALUE_SLOTS = [
  {
    property: 'stringValue',
    subject: 'a stringValue attribute',
    evaluated: false,
  },
  { property: 'string', subject: 'an operaton:string child', evaluated: false },
  {
    property: 'expression',
    subject: 'an operaton:expression child',
    evaluated: true,
  },
] as const;

/** A value quoted in a warning, its whitespace kept visible since that is often why it is reported. */
function oneLine(text: string): string {
  return text.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/** `undefined` when the field was reported as a drop instead of read. */
function readField(
  field: ModdleElement,
  ownerId: string,
  where: string,
  warnings: ImportWarning[],
): FieldInjection | undefined {
  const drop = (reason: string): undefined => {
    warnFieldDrop(field, ownerId, where, reason, warnings);
    return undefined;
  };

  const name = readString(field, 'name');
  if (name === undefined) {
    return drop(
      'a field is injected under the name it declares, and this one declares none',
    );
  }

  // Every slot is read verbatim: `parseExpressionFieldDeclaration` and
  // `getStringValueFromAttributeOrElement` trim nothing, so an indented
  // body's whitespace is part of what the engine evaluates.
  const written = FIELD_VALUE_SLOTS.map((slot) => ({
    slot,
    value: readString(field, slot.property),
  })).filter(
    (slot): slot is { slot: FieldValueSlot; value: string } =>
      slot.value !== undefined,
  );

  // `parseFieldDeclaration` reads the two literal slots first and never
  // reaches the expression child once one answers.
  const literals = written.filter((slot) => !slot.slot.evaluated);
  const evaluated = written.find((slot) => slot.slot.evaluated);
  const chosen = literals[0] ?? evaluated;
  // `parseFieldDeclaration` fails the deployment on a field naming no slot,
  // and `getStringValueFromAttributeOrElement` on one naming both literal slots.
  if (chosen === undefined || literals.length > 1) {
    throw new UnsupportedExtensionFormError(
      ownerId,
      `the injected field '${name}' on ${where} names ` +
        (chosen === undefined
          ? 'no value'
          : literals.map((w) => w.slot.subject).join(' and ')),
    );
  }

  // The compiler writes a value opening with `${` or `#{` into the expression
  // slot and any other into `stringValue`, and spells the first as a raw
  // template, whose opener follows its quote directly. A value the round trip
  // would move to the other slot, or cannot spell, is reported.
  const evaluatedBack = EXPRESSION_OPEN.test(chosen.value);
  let writtenBack: string | undefined;
  if (chosen.slot.evaluated && !evaluatedBack) {
    writtenBack =
      'a stringValue attribute, and the engine would inject that text ' +
      'rather than evaluate it';
  } else if (chosen.slot.evaluated && !RAW_TEMPLATE_OPEN.test(chosen.value)) {
    writtenBack =
      'a quoted literal the compiler refuses, since a raw template opens ' +
      'directly after its quote';
  } else if (!chosen.slot.evaluated && evaluatedBack) {
    writtenBack =
      'an operaton:expression child, and the engine would evaluate it ' +
      'rather than inject the text';
  }
  if (writtenBack !== undefined) {
    return drop(
      `${chosen.slot.subject} holding '${oneLine(chosen.value)}' would be ` +
        `written back as ${writtenBack}`,
    );
  }

  if (chosen.slot.property === 'string') {
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `The injected field '${name}' on ${where} writes its value in an ` +
        'operaton:string child, which this tool writes back as a stringValue ' +
        'attribute; the engine injects the same text either way.',
    });
  }

  if (chosen !== evaluated && evaluated !== undefined) {
    warnings.push({
      elementId: ownerId,
      category: 'extensionAttribute',
      message:
        `The 'operaton:expression' child of the injected field '${name}' on ` +
        `${where} has no effect alongside ${chosen.slot.subject} and was not ` +
        'imported.',
    });
  }

  return { name, value: chosen.value };
}

type FieldValueSlot = (typeof FIELD_VALUE_SLOTS)[number];

function warnFieldDrop(
  field: ModdleElement,
  ownerId: string,
  where: string,
  reason: string,
  warnings: ImportWarning[],
): void {
  const name = readString(field, 'name');
  warnings.push({
    elementId: ownerId,
    category: 'extensionAttribute',
    message:
      `The injected field ${name === undefined ? '(unnamed)' : `'${name}'`} ` +
      `on ${where} was not imported: ${reason}.`,
  });
}
