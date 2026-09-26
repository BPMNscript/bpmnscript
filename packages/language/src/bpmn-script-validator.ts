/**
 * Every diagnostic the language raises: messages and value shapes first, then
 * process-wide checks, per-element checks, attribute blocks, gateways and
 * blocks, handlers and events, declarations.
 */

import {
  AstUtils,
  type AstNode,
  type ValidationAcceptor,
  type ValidationChecks,
} from 'langium';
import type {
  Accessor,
  Additive,
  Block,
  BpmnScriptAstType,
  BusinessRuleTask,
  CallActivity,
  CodeDecl,
  DoWhileStatement,
  EmitStatement,
  EndEvent,
  Expr,
  FormBlock,
  FormField,
  GotoStatement,
  IfStatement,
  IntermediateCatchEvent,
  IoParameter,
  IoValue,
  Listener,
  Logical,
  Model,
  Multiplicative,
  OnHandler,
  ParallelStatement,
  ParenItem,
  ParenValue,
  Process,
  RaceBranch,
  RaceStatement,
  Relational,
  ScriptTask,
  SendTask,
  ServiceTask,
  Setting,
  StartEvent,
  Statement,
  SubProcess,
  ThrowStatement,
  UserTask,
  VarRef,
  VarType,
  WhileStatement,
} from './generated/ast.js';
import {
  caughtBindingsOf,
  codeTriggerOf,
  configuredSettingsOf,
  declaredCodeOf,
  flagOf,
  flagsOf,
  hasExpressionPayload,
  hasFlag,
  hasQuotedPayload,
  isCodePosition,
  nameTriggerOf,
  payloadItemOf,
  payloadTextOf,
  settingsOf,
  timerParticleOf,
  timerPayloadOf,
  type TimerPayload,
} from './paren-items.js';
import {
  isAccessor,
  isAdditive,
  isSetting,
  isBlock,
  isCallActivity,
  isCodeDecl,
  isDoWhileStatement,
  isElseIf,
  isEmitStatement,
  isEndEvent,
  isErrorMapping,
  isExpr,
  isFormField,
  isGotoStatement,
  isIfStatement,
  isIntermediateCatchEvent,
  isListener,
  isLiteralBool,
  isLiteralDecimal,
  isLiteralInt,
  isLiteralNull,
  isLiteralString,
  isLogical,
  isMapEntry,
  isMultiplicative,
  isOnHandler,
  isParallelBranch,
  isParallelStatement,
  isParen,
  isParenValue,
  isProcess,
  isRaceBranch,
  isRaceStatement,
  isRawExpr,
  isRelational,
  isScriptLiteral,
  isServiceTask,
  isStartEvent,
  isSubProcess,
  isTernary,
  isThrowStatement,
  isUnary,
  isUserTask,
  isVarDecl,
  isVariableMapping,
  isVarRef,
  isWhileStatement,
} from './generated/ast.js';
import {
  integerLiteralText,
  renderExpression,
  renderExpressionInner,
  singleTemplateBody,
} from './expression-render.js';
import type { BpmnScriptServices } from './bpmn-script-module.js';
import {
  ATTEMPT_BLOCK_RULE,
  ASYNC_FLAG_KEYS,
  ATTRIBUTE_BLOCK_RULES,
  attributeBlockRuleOf,
  BOOLEAN_SETTING_KEYS,
  BUILTIN_FIELD_NAMES,
  BUILTIN_FIELD_VALIDATOR,
  BUILTIN_REQUIRED_FIELDS,
  BUSINESS_RULE_BINDING_KEYS,
  CALL_BINDING_VALUES,
  CALL_MAPPER_KEY_BY_KIND,
  CATCH_TRIGGERS,
  DATE_PATTERN_KEY,
  DECLARED_CODE_TRIGGERS,
  DECISION_MODIFIER_KEYS,
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  ENGINE_KEYS,
  engineSpellings,
  ERROR_MAPPING_HEAD,
  ERROR_MAPPING_WHEN,
  EVENT_BINDING_FIELD_SET,
  EVENT_BINDING_FIELDS,
  EVENT_MESSAGE_FIELD,
  EXECUTION_LISTENER_EVENTS,
  EXPRESSION_ANYWHERE,
  EXPRESSION_OPEN,
  EXTERNAL_BINDING_KEY,
  EXTERNAL_TASK_EL_NAME,
  FIELD_BINDING_KEYS,
  FIELD_DIRECTION,
  FORM_BOUND_TEXT,
  FORM_CONSTRAINT_NAMES,
  FORM_CONSTRAINT_TYPES,
  FORM_FIELD_SETTING_KEYS,
  FORM_FIELD_TYPES,
  formFieldVariableType,
  formatPlainWordList,
  formatWordList,
  gatewayStatementRuleOf,
  ID_TEXT,
  IO_DIRECTIONS,
  JOIN_ENGINE_KEYS,
  JOIN_KEY_BY_ENGINE_KEY,
  joinSettingKey,
  JUEL_LITERAL_WORDS,
  JUEL_RESERVED_WORDS,
  LISTENER_BINDING_KEYS,
  listenerEventsFor,
  ON_TRIGGERS,
  OUTPUT_DIRECTION,
  parameterDirectionsFor,
  PROCESS_HEADER_KEYS,
  PROPERTY_DIRECTION,
  RUN_ENGINE_KEYS,
  runSettingKey,
  SCRIPT_FORMAT_ALIASES,
  scriptFormatOf,
  SERVICE_TASK_BINDING_KEYS,
  SHELL_FLAG_FIELDS,
  SHELL_FLAG_LITERALS,
  splitFencedScript,
  START_TRIGGERS,
  TASK_LISTENER_EVENTS,
  TASK_PRIORITY_KEY,
  THROW_BINDING_KEYS,
  THROW_BINDING_TRIGGER,
  THROW_TRIGGERS,
  TIMER_JOB_KEYS,
  TIMER_PARTICLES,
  type TimerParticle,
  TRIGGER_PAYLOAD,
  TYPE_BINDING_KEY,
  TYPE_BINDING_VALUES,
  USER_TASK_VERBATIM_KEYS,
  type AttributeBlockRule,
  type AttributeOwner,
  type BuiltinTaskType,
  type RequiredFieldGroup,
  type TriggerPayloadRule,
} from './vocabulary.js';
import {
  enclosingFlowContainer,
  isNamedStatement,
  type NamedStatement,
} from './bpmn-script-scope-provider.js';
import {
  isRepeated,
  type VariableSymbolProvider,
  type VariableTable,
} from './variable-symbol-provider.js';

export function registerValidationChecks(services: BpmnScriptServices) {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.BpmnScriptValidator;
  const checks: ValidationChecks<BpmnScriptAstType> = {
    Model: validator.checkModel,
    Process: validator.checkProcess,
    StartEvent: validator.checkStartEvent,
    EndEvent: validator.checkEndEvent,
    UserTask: validator.checkUserTask,
    ServiceTask: validator.checkServiceTaskAttributes,
    ScriptTask: validator.checkScriptTask,
    GenericTask: validator.checkAttributeOwner,
    SendTask: validator.checkServiceTaskAttributes,
    ReceiveTask: validator.checkAttributeOwner,
    BusinessRuleTask: validator.checkBusinessRuleTask,
    IfStatement: validator.checkIfStatement,
    WhileStatement: validator.checkWhileStatement,
    DoWhileStatement: validator.checkDoWhileStatement,
    ParallelStatement: validator.checkParallelStatement,
    RaceStatement: validator.checkRaceStatement,
    GotoStatement: validator.checkGotoStatement,
    SubProcess: validator.checkSubProcess,
    CallActivity: validator.checkCallActivity,
    OnHandler: validator.checkOnHandler,
    ThrowStatement: validator.checkThrowStatement,
    EmitStatement: validator.checkEmitStatement,
    IntermediateCatchEvent: validator.checkIntermediateCatchEvent,
    ParenValue: validator.checkParenValue,
    Block: validator.checkBlock,
  };
  registry.register(checks, validator);
}

type VersionPinnedElement = CallActivity | BusinessRuleTask | UserTask;

/** A race branch is the same header with a body, so both share the payload rules. */
type CatchHeader = IntermediateCatchEvent | RaceBranch;

type GatewayStatement =
  | IfStatement
  | WhileStatement
  | DoWhileStatement
  | ParallelStatement
  | RaceStatement;

const USER_PRIORITY_KEY = 'priority';

/**
 * A bareword under these names no variable: no undeclared warning, no JUEL
 * scan. `assignee` lowers to a plain user id; the date keys are in so a
 * declared `deadline` cannot hide the unparseable-date error. The priority
 * keys and `businessKey` stay out because a bareword there lowers to `${...}`.
 */
export const NON_VARIABLE_ATTR_KEYS: ReadonlySet<string> = new Set([
  ...PROCESS_HEADER_KEYS,
  'formRef',
  ...BUSINESS_RULE_BINDING_KEYS,
  ...DECISION_MODIFIER_KEYS,
  'process',
  ...USER_TASK_VERBATIM_KEYS.filter((key) => key !== USER_PRIORITY_KEY),
  ...engineSpellings('retryCycle'),
  'resultVariable',
  'initiator',
  'validator',
  ...Object.values(CALL_MAPPER_KEY_BY_KIND),
]);

const TIMER_JOB_KEYS_WITHOUT_PRIORITY: readonly string[] =
  TIMER_JOB_KEYS.filter((key) => key !== 'jobPriority');
const TIMER_JOB_KEY_SET: ReadonlySet<string> = new Set(TIMER_JOB_KEYS);

const DUE_DATE_KEYS: readonly string[] = ['dueDate', 'followUpDate'];
const DUE_DATE_KEY_SET: ReadonlySet<string> = new Set(DUE_DATE_KEYS);

/** Parsed with `Integer.parseInt`, at deployment or at task creation. */
const PRIORITY_ATTR_KEYS: ReadonlySet<string> = new Set([
  ...engineSpellings('jobPriority'),
  TASK_PRIORITY_KEY,
  USER_PRIORITY_KEY,
]);

const RETRY_CYCLE_ATTR_KEYS: ReadonlySet<string> = new Set(
  engineSpellings('retryCycle'),
);

/** Parsed by the engine, so a bareword or number there is unreadable to it. */
const TEXT_ATTR_KEYS: ReadonlySet<string> = new Set([
  ...RETRY_CYCLE_ATTR_KEYS,
  ...DUE_DATE_KEYS,
]);

/**
 * `DueDateBusinessCalendar` reads a `P...` period or an ISO date-time; anything
 * else fails task creation.
 */
const DUE_DATE_TEXT = /^(P|\d{4}-\d{2}-\d{2})/;

/** `version` names no variable, so a bare name is refused; a raw template computes one. */
const VERSION_TEXT = /^[1-9]\d*$/;

/** `ParseUtil.parseHistoryTimeToLive`: `P<n>D`, else `Integer.parseInt`. */
const HISTORY_TIME_TO_LIVE_TEXT = /^(P\d+D|\d+)$/;

/** `ACT_RE_PROCDEF.VERSION_TAG_` is 64 wide and nothing checks the length before the insert. */
const VERSION_TAG_MAX_LENGTH = 64;

/**
 * `DurationHelper.parsePeriod` (unanchored, for reuse): `P<n>W` alone, or an
 * XML Schema duration, which has no `W` and throws on a bare `P` or empty `T`.
 */
const ISO_DURATION_BODY = String.raw`(?:P\d+W|P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?)`;

/** Joda's `ISOPeriodFormat.standard`, read under `at`; it takes `W` beside the other fields. */
const JODA_PERIOD_BODY = String.raw`P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?`;

/**
 * Joda's `dateTimeParser`: the zone sits inside the `T` group, so
 * `2026-12-01T` parses and `2026-12-01Z` does not. Joda's looser spellings
 * stay refused.
 */
const ISO_DATE_TIME_BODY = String.raw`(?:\d{4}(-\d{2}(-\d{2})?)?|\d{4}-\d{3}|\d{4}-W\d{2}(-\d)?)(T(\d{2}(:\d{2}(:\d{2})?)?([.,]\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?`;

/**
 * `DurationHelper.parseDurationOrTime`: a duration with optional end, or a
 * start with a duration or end.
 */
const INTERVAL_BODY = String.raw`(?:${ISO_DURATION_BODY}(?:/${ISO_DATE_TIME_BODY})?|${ISO_DATE_TIME_BODY}/(?:${ISO_DURATION_BODY}|${ISO_DATE_TIME_BODY}))`;

const REPEAT_BODY = String.raw`R\d*/${INTERVAL_BODY}`;

/**
 * An interval. A repeat parses too, but only a cycle sets a repeat on its job,
 * so the timer fires once.
 */
const AFTER_TIME_TEXT = new RegExp(`^(${INTERVAL_BODY}|${REPEAT_BODY})$`);

/** A point in time, or a period from now. */
const AT_TIME_TEXT = new RegExp(
  `^(${JODA_PERIOD_BODY}|${ISO_DATE_TIME_BODY})$`,
);

/**
 * Spring's six-field cron plus these nicknames (not `@reboot`); a seventh field
 * fails at deployment.
 */
const CRON_BODY = String.raw`(?:\S+(\s+\S+){5}|@(?:yearly|annually|monthly|weekly|daily|midnight|hourly))`;

const EVERY_TIME_TEXT = new RegExp(`^(${REPEAT_BODY}|${CRON_BODY})$`);

/** `ParseUtil.parseRetryIntervals` reads the `R.../...` shape only as the sole interval. */
const RETRY_CYCLE_TEXT = new RegExp(
  `^(${REPEAT_BODY}|${ISO_DURATION_BODY}(,${ISO_DURATION_BODY})*)$`,
);

const NON_NEGATIVE_INT_TEXT = /^\d+$/;

/** The letters `SimpleDateFormat` reads, a quoted run, or a non-letter. */
const PATTERN_LETTERS_TEXT =
  /^(?:'[^']*'|[^A-Za-z]|[GyYMLwWDdFEuaHkKhmsSzZX])*$/;

/** Refused as a date default unless `pattern` overrides the engine's "dd/MM/yyyy". */
const ISO_DATE_ONLY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

const ON_TRIGGERS_SET: ReadonlySet<string> = new Set(ON_TRIGGERS);
const END_TRIGGERS_SET: ReadonlySet<string> = new Set(END_TRIGGERS);
const CATCH_TRIGGERS_SET: ReadonlySet<string> = new Set(CATCH_TRIGGERS);
const CALL_BINDING_VALUE_SET: ReadonlySet<string> = new Set(
  CALL_BINDING_VALUES,
);
const START_TRIGGERS_SET: ReadonlySet<string> = new Set(START_TRIGGERS);
const THROW_TRIGGERS_SET: ReadonlySet<string> = new Set(THROW_TRIGGERS);
const EMIT_TRIGGERS_SET: ReadonlySet<string> = new Set(EMIT_TRIGGERS);
const ENGINE_KEY_SET: ReadonlySet<string> = new Set(ENGINE_KEYS);
const JOIN_ENGINE_KEY_SET: ReadonlySet<string> = new Set(JOIN_ENGINE_KEYS);
const RUN_ENGINE_KEY_SET: ReadonlySet<string> = new Set(RUN_ENGINE_KEYS);
const ENGINE_KEY_BY_RUN_KEY: Readonly<Record<string, string>> =
  Object.fromEntries(ENGINE_KEYS.map((key) => [runSettingKey(key), key]));
/** No per-run spelling exists (see `RUN_ENGINE_KEYS`), so it draws its own refusal. */
const RUN_JOB_PRIORITY_KEY = runSettingKey('jobPriority');
const SPLIT_AND_JOIN_KEY_SET: ReadonlySet<string> = new Set([
  ...ENGINE_KEYS,
  ...JOIN_ENGINE_KEYS,
]);
const ENGINE_KEY_BY_JOIN_KEY: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(JOIN_KEY_BY_ENGINE_KEY).map(([key, join]) => [join, key]),
  );
const IO_DIRECTION_SET: ReadonlySet<string> = new Set(IO_DIRECTIONS);
const FIELD_BINDING_KEY_SET: ReadonlySet<string> = new Set(FIELD_BINDING_KEYS);
const FIELDLESS_BINDING_KEYS: readonly string[] =
  BUSINESS_RULE_BINDING_KEYS.filter((key) => !FIELD_BINDING_KEY_SET.has(key));
const LISTENER_BINDING_KEY_SET: ReadonlySet<string> = new Set(
  LISTENER_BINDING_KEYS,
);
const LISTENER_FIELD_BINDING_KEYS: readonly string[] =
  LISTENER_BINDING_KEYS.filter((key) => FIELD_BINDING_KEY_SET.has(key));
const SHELL_FLAG_FIELD_SET: ReadonlySet<string> = new Set(SHELL_FLAG_FIELDS);
const PROCESS_HEADER_KEY_SET: ReadonlySet<string> = new Set(
  PROCESS_HEADER_KEYS,
);
const DECISION_RESULT_MAPPING_SET: ReadonlySet<string> = new Set(
  DECISION_RESULT_MAPPINGS,
);
const FORM_FIELD_TYPE_SET: ReadonlySet<string> = new Set(FORM_FIELD_TYPES);
const FORM_FIELD_SETTING_KEY_SET: ReadonlySet<string> = new Set(
  FORM_FIELD_SETTING_KEYS,
);
const EXECUTION_LISTENER_EVENT_SET: ReadonlySet<string> = new Set(
  EXECUTION_LISTENER_EVENTS,
);
const TASK_LISTENER_EVENT_SET: ReadonlySet<string> = new Set(
  TASK_LISTENER_EVENTS,
);
/**
 * Read off the block rules so the message matches what is enforced; `attempt`
 * has no row of its own.
 */
export const PARAMETER_HOSTS_MESSAGE = `parameters belong on ${formatPlainWordList(
  [...Object.values(ATTRIBUTE_BLOCK_RULES), ATTEMPT_BLOCK_RULE]
    .filter((rule) => rule.parameters)
    .map((rule) => rule.description),
  'and',
)}.`;

export const REPEATED_OUTPUT_MESSAGE =
  "A repeated step cannot map an 'output' parameter: the engine refuses to " +
  'deploy it (BpmnParse.checkActivityOutputParameterSupported). Move the ' +
  'mapping to a step after the repetition.';

/** A listener has no row of its own, so it is added back. */
const FIELD_HOSTS_MESSAGE = `an injected field belongs on ${Object.values(
  ATTRIBUTE_BLOCK_RULES,
)
  .filter((rule) => rule.fields)
  .map((rule) => rule.description)
  .join(', ')}, and on a listener.`;

export const noFieldHostMessage = (description: string) =>
  `${capitalize(description)} cannot declare a 'field' parameter; ${FIELD_HOSTS_MESSAGE}`;

/**
 * Names only the fieldless bindings written, since a listener takes neither
 * `topic` nor `decision`.
 */
export const fieldBindingMessage = (
  subject: string,
  written: readonly string[],
  takes: { keys: readonly string[]; targets: string },
) =>
  `${subject} carries an injected field only under a ${formatWordList(takes.keys)} ` +
  `binding: the engine injects into ${takes.targets} that binding names` +
  (written.length === 0
    ? '.'
    : `, and the binding written with ${formatWordList(written)} receives none.`);

export const ELEMENT_FIELD_BINDINGS = {
  keys: FIELD_BINDING_KEYS,
  targets: 'the class, the delegate, or the built-in behaviour',
};

export const LISTENER_FIELD_BINDINGS = {
  keys: LISTENER_FIELD_BINDING_KEYS,
  targets: 'the class or the delegate',
};

const fieldlessBindingsOf = (attrs: readonly Setting[]): string[] =>
  bindingKeysOf(attrs, FIELDLESS_BINDING_KEYS);

/** `parseExternalServiceTask`, their one reader, runs for `operaton:type="external"` alone. */
const EXTERNAL_HOSTS_PHRASE = `${formatPlainWordList(
  Object.values(ATTRIBUTE_BLOCK_RULES)
    .filter((rule) => rule.externalExtras)
    .map((rule) => rule.description),
)} bound with 'topic'`;

export const noPropertyHostMessage = (description: string) =>
  `${capitalize(description)} cannot declare a 'property' line; a property line belongs on ${EXTERNAL_HOSTS_PHRASE}, and in a form field's block.`;

export const noMappingHostMessage = (description: string) =>
  `${capitalize(description)} cannot map a reported failure; an 'error <Code> when <condition>' line belongs on ${EXTERNAL_HOSTS_PHRASE}, whose external worker is what reports one.`;

export const topicBindingMessage = (
  subject: string,
  item: string,
  written: readonly string[],
) =>
  `${subject} carries ${item} only under a 'topic' binding: the engine reads it for a step handed to an external worker` +
  (written.length === 0
    ? '.'
    : `, and the binding written with ${formatWordList(written)} hands the step to none.`);

/** `ExternalTaskEntity.evaluateThrowBpmnError` raises a BPMN error and nothing else. */
export const MAPPING_HEAD_MESSAGE =
  'An external task maps a reported failure onto an error and nothing else; ' +
  `write '${ERROR_MAPPING_HEAD} <Code> ${ERROR_MAPPING_WHEN} <condition>'.`;

export const MAPPING_WHEN_MESSAGE = `Write '${ERROR_MAPPING_WHEN}' between the code and the condition: '${ERROR_MAPPING_HEAD} <Code> ${ERROR_MAPPING_WHEN} <condition>'.`;

export const priorityShapeMessage = (key: string) =>
  key === USER_PRIORITY_KEY
    ? `Setting '${key}' takes an integer or a "\${...}" expression; the engine parses a constant with Integer.parseInt when the task is created (TaskDecorator.initializeTaskPriority) and fails the instance on anything else.`
    : `Setting '${key}' takes an integer or a "\${...}" expression; the engine refuses to deploy a constant that is not an integer.`;

export const VERSION_SHAPE_MESSAGE =
  `Setting 'version' takes a positive whole number, quoted or not, or a "\${...}" expression yielding one; ` +
  'the engine parses the value as an integer when the step runs (BaseCallableElement.getVersion, TaskEntity.initializeFormRefFromTaskDefinition) and fails the instance on anything else.';

export const dueDateShapeMessage = (key: string) =>
  `Setting '${key}' takes a period starting with 'P' or an ISO date-time such as "2026-01-01T09:00:00", or a "\${...}" expression; ` +
  'the engine parses a constant with DueDateBusinessCalendar.resolveDuedate when the task is created and fails the instance on anything else.';

export const RETRY_CYCLE_SHAPE_MESSAGE =
  "Setting 'retryCycle' takes an ISO 8601 duration, an 'R<n>/<duration>' repeat, or a comma " +
  'list of durations; a single interval the engine cannot read is logged and dropped, so the ' +
  'job keeps its default retries (ParseUtil.parseRetryIntervals), and a bad member of a list ' +
  'is stored unchecked and, when its turn comes, drops that retry to the default strategy ' +
  'with no wait (DefaultJobRetryCmd.execute).';

export const resultVariableUnreadMessage = (binding: string) =>
  `Setting 'resultVariable' has no effect beside '${binding}': the engine hands it to an 'expression' binding alone (BpmnParse.parseServiceTaskLike), so nothing writes the variable.`;

export const MAP_DECISION_RESULT_UNREAD_MESSAGE =
  "Setting 'mapDecisionResult' has no effect without 'resultVariable': the engine applies the mapping only when storing the result into that variable (DecisionEvaluationUtil.evaluateDecision).";

export const decisionModifierMessage = (key: string) =>
  `Setting '${key}' stands only beside 'decision': the engine reads 'binding', 'version' and 'mapDecisionResult' on a step answering a decision table alone (BpmnParse.parseBusinessRuleTask).`;

export const HISTORY_TIME_TO_LIVE_MESSAGE =
  "Setting 'historyTimeToLive' takes a quoted number of days, 'P<n>D' or '<n>'; " +
  'the engine reads the attribute as text, never as an expression, and refuses to deploy anything else (ParseUtil.parseHistoryTimeToLive).';

export const VERSION_TAG_LITERAL_MESSAGE =
  "Setting 'versionTag' takes a quoted string; the engine stores the tag as written, never evaluated (BpmnParse.parseProcess).";

export const VERSION_TAG_LENGTH_MESSAGE = `Setting 'versionTag' is longer than ${VERSION_TAG_MAX_LENGTH} characters, the width of the column it is stored in (ACT_RE_PROCDEF.VERSION_TAG_), so the deployment fails.`;

export const candidateStarterMessage = (key: string) =>
  `Setting '${key}' takes ids as written: the engine stores each entry as a candidate identity link without evaluating it (BpmnDeployer.addAuthorizations), so a "\${...}" template names the id spelled by its text.`;

export const headerLiteralMessage = (key: string) =>
  `Setting '${key}' takes a quoted string on a process header; the engine stores it as written, never evaluated (BpmnParse.parseProcess).`;

export const runWithoutClauseMessage = (key: string, description: string) =>
  `Setting '${key}' is not valid on ${description} that does not repeat: it makes one job per run, so write a 'for' clause, or '${ENGINE_KEY_BY_RUN_KEY[key]}' for one job around the step.`;

export const RUN_JOB_PRIORITY_MESSAGE = `Setting '${RUN_JOB_PRIORITY_KEY}' does not exist: Operaton reads a job priority off the step alone (BpmnParse.createActivityOnScope), so 'jobPriority' applies to every run's job.`;

export const REPEAT_COUNT_MESSAGE =
  'A repeat count must be a non-negative whole number, a variable, or a ' +
  '"${...}" expression yielding one; the engine reads a constant as text ' +
  'with Integer.parseInt and truncates any other number with intValue() ' +
  '(MultiInstanceActivityBehavior.resolveLoopCardinality).';

export const TYPE_VALUE_MESSAGE = `Setting '${TYPE_BINDING_KEY}' must be ${formatWordList(TYPE_BINDING_VALUES)}.`;

const BUILTIN_BEHAVIOUR_CLASS: Readonly<Record<BuiltinTaskType, string>> = {
  mail: 'MailActivityBehavior',
  shell: 'ShellActivityBehavior',
};

/**
 * `parseServiceTaskLike` refuses a result variable beside these, keyed to the
 * attribute its refusal quotes; `decision` reads it on its own path.
 */
const RESULT_VARIABLE_REFUSING_BINDINGS: Readonly<Record<string, string>> = {
  class: 'class',
  delegate: 'delegateExpression',
};

const SERVICE_TASK_LIKE_ELEMENT: Readonly<
  Record<(ServiceTask | SendTask | BusinessRuleTask)['$type'], string>
> = {
  ServiceTask: 'serviceTask',
  SendTask: 'sendTask',
  BusinessRuleTask: 'businessRuleTask',
};

export const resultVariableBindingMessage = (
  description: string,
  binding: string,
  element: string,
) =>
  `${capitalize(description)} cannot carry 'resultVariable' beside '${binding}': the engine refuses to deploy it ('resultVariableName' not supported for ${element} elements using '${RESULT_VARIABLE_REFUSING_BINDINGS[binding]}'); bind with 'expression' to store the return value, or drop it.`;

export const missingBuiltinFieldMessage = (
  subject: string,
  type: BuiltinTaskType,
  group: RequiredFieldGroup,
) =>
  `${subject} binds ${TYPE_BINDING_KEY}: "${type}" without a ${formatWordList(group.names)} field; Operaton refuses to deploy it: "${group.error}" (BpmnParse.${BUILTIN_FIELD_VALIDATOR[type]}).`;

export const unknownBuiltinFieldMessage = (
  name: string,
  type: BuiltinTaskType,
) =>
  `Field '${name}' is not one a ${type} task takes; the engine sets it on ${BUILTIN_BEHAVIOUR_CLASS[type]}, which declares ${formatPlainWordList(BUILTIN_FIELD_NAMES[type], 'and')} (ClassDelegateUtil.applyFieldDeclaration).`;

export const shellFieldExpressionMessage = (name: string) =>
  `Field '${name}' on a shell task takes a quoted literal: Operaton reads every shell field as a fixed value (BpmnParse.validateFieldDeclarationsForShell) and fails the deployment on an expression.`;

export const shellFlagValueMessage = (name: string) =>
  `Field '${name}' on a shell task takes "true" or "false"; the engine reads any other spelling as false (ShellActivityBehavior.readFields).`;

const SHELL_FLAG_LITERAL_SET: ReadonlySet<string> = new Set(
  SHELL_FLAG_LITERALS,
);

export const scriptListenerFieldMessage = (subject: string) =>
  `${subject} runs a fenced script, which the engine hands no field list; ` +
  `remove the script and bind the listener with ${formatWordList(LISTENER_FIELD_BINDING_KEYS)} ` +
  'to inject one.';

export const fieldValueMessage = (name: string) =>
  `Field '${name}' takes a quoted string or a "\${...}" expression; ` +
  'put the value in quotes.';

/**
 * The opening decides the slot, so a literal opening with one can only reach
 * the expression slot.
 */
export const escapedFieldLiteralMessage = (name: string) =>
  `Field '${name}' cannot carry quoted text opening with '\${' or '#{': the expression slot is picked by that opening, so the text would be evaluated rather than injected as written. Drop the backslash to write an expression.`;

export const emptyFieldMessage = (name: string) =>
  `Field '${name}' cannot be empty: the engine reads an empty value as absent, so the ` +
  'field declares neither a fixed value nor an expression and the deployment fails ' +
  `(BpmnParse.parseFieldDeclaration). Write '\${""}' for an actual empty string.`;

export const EMPTY_STRING_VALUE_MESSAGE =
  'An empty or blank string writes no value at all: the engine trims it and ' +
  'reads it as absent rather than as an empty string (BpmnParseUtil.getElValueProvider). ' +
  'Write \'${""}\' for an actual empty string.';

const JUEL_RESERVED_WORD_SET: ReadonlySet<string> = new Set(
  JUEL_RESERVED_WORDS,
);

const JUEL_RAW_TEMPLATE_WORD_SET: ReadonlySet<string> = new Set([
  ...JUEL_RESERVED_WORDS,
  ...JUEL_LITERAL_WORDS,
]);

export const juelKeywordMessage = (word: string, key: string) =>
  `'${word}' is a JUEL keyword (Scanner.addKeyToken), so the engine refuses any expression naming it. Reach the variable through a string key instead: "\${${key}}".`;

/** `Character.isJavaIdentifierPart('-')` is false, so the identifier ends at the hyphen. */
export const hyphenNameMessage = (name: string, key: string) =>
  `'${name}' carries a hyphen, which JUEL scans as a minus (Scanner.nextIdentifier), so the engine reads a subtraction. Reach the variable through a string key instead: "\${${key}}".`;

type ConditionSlot = 'condition' | 'until';

export const nonBooleanConditionMessage = (
  shape: string,
  slot: ConditionSlot,
) =>
  slot === 'until'
    ? `An 'until' condition must be boolean, but this one is ${shape}: the engine throws when a completion condition evaluates to anything else (MultiInstanceActivityBehavior.completionConditionSatisfied).`
    : `A condition must be boolean, but this one is ${shape}: the engine throws 'condition expression returns ${shape === 'null' ? 'null' : 'non-Boolean'}' when it evaluates it (UelExpressionCondition.evaluate).`;

export const COMPOSITE_OPERAND_MESSAGE =
  "A composite template cannot be spliced into the surrounding expression: JUEL has no '${' token once inside an expression (Scanner.nextEval), so only a raw that is exactly one '${...}' with no '}' outside a string literal in its body can be an operand. Write the whole expression as one raw template instead.";

const EL_BINDING_KEYS: ReadonlySet<string> = new Set([
  'expression',
  'delegate',
  CALL_MAPPER_KEY_BY_KIND.delegateExpression,
]);

const CLASS_BINDING_ALTERNATIVE: Readonly<Record<string, string>> = {
  class: 'delegate',
  [CALL_MAPPER_KEY_BY_KIND.class]: CALL_MAPPER_KEY_BY_KIND.delegateExpression,
};

const EMPTY_BINDING_NOUN: Readonly<Record<string, string>> = {
  class: 'class to load',
  expression: 'expression to evaluate',
  delegate: 'delegate to resolve',
  [CALL_MAPPER_KEY_BY_KIND.class]: 'mapping class to load',
  [CALL_MAPPER_KEY_BY_KIND.delegateExpression]: 'mapping delegate to resolve',
  topic: 'topic a worker subscribes to',
  decision: 'decision table to evaluate',
  process: 'process to start',
};

export const literalElBindingMessage = (key: string) =>
  `Setting '${key}' takes a "\${...}" template or a bare name, never quoted text: ` +
  (key === 'expression'
    ? 'the string evaluates to itself and runs nothing'
    : 'a string resolves to no delegate to run') +
  `. Write '${key}: "\${...}"' or '${key}: <name>'.`;

export const templateAsClassMessage = (key: string, alternative: string) =>
  `Setting '${key}' takes a class name, loaded as written (ClassDelegateUtil.instantiateDelegate); a "\${...}" template there is not evaluated. Write '${key}: com.example.X', or '${alternative}: "\${bean}"' to resolve one at runtime.`;

/**
 * The engine refuses a blank `class`, `expression` or `delegateExpression` at
 * deployment; the other keys deploy blank and fail at the step.
 */
function bindingValueMessage(key: string, value: Expr): string | undefined {
  const noun = EMPTY_BINDING_NOUN[key];
  if (noun === undefined) return undefined;
  if (isLiteralString(value)) {
    if (value.value.trim().length === 0) {
      return `Setting '${key}' cannot be empty; name the ${noun}.`;
    }
    return EL_BINDING_KEYS.has(key) ? literalElBindingMessage(key) : undefined;
  }
  const alternative = CLASS_BINDING_ALTERNATIVE[key];
  return isRawExpr(value) && alternative !== undefined
    ? templateAsClassMessage(key, alternative)
    : undefined;
}

export const unknownDirectionMessage = (
  word: string,
  legal: readonly string[],
) => `Unknown parameter direction '${word}'; write ${formatWordList(legal)}.`;

export const FORM_KEY_AND_REF_MESSAGE =
  "A user task names its form with 'formKey' or with 'formRef', never both; " +
  'the engine refuses to deploy a task carrying the two.';

const BINDING_MODE_PHRASES: readonly string[] = CALL_BINDING_VALUES.map(
  (value) => `'binding: ${value}'`,
);

export const FORM_REF_BINDING_MESSAGE = `A 'formRef' needs the binding resolving it: add ${formatPlainWordList(
  [...BINDING_MODE_PHRASES, "'version: <number>'"],
)}. The engine refuses to deploy a form reference with none.`;

export const FORM_REF_MISSING_MESSAGE =
  "'binding' and 'version' pin which deployed version of a form the engine " +
  "resolves, so neither stands without a 'formRef'.";

export const formFieldSettingsOnlyMessage = (id: string, text: string) =>
  `Form field '${id}' takes 'key: value' settings in its parens; '${text}' is not one.`;

export const unknownFormFieldSettingMessage = (id: string, key: string) =>
  `Unknown form field setting '${key}' on '${id}'; write ${formatWordList(FORM_FIELD_SETTING_KEYS)}.`;

export const constraintMisfitMessage = (
  name: string,
  field: FormField,
  fits: readonly string[],
) =>
  `Constraint '${name}' fits a ${formatPlainWordList(fits)} field, not the ${field.type} field '${field.id}': the engine checks a submitted ${formatPlainWordList(fits)} alone and fails every other submission.`;

export const patternMisfitMessage = (field: FormField) =>
  `Setting 'pattern' is the date pattern a 'date' field is parsed with; '${field.id}' is a ${field.type} field, which the engine reads no pattern off.`;

export const flagFalseMessage = (key: string) =>
  `A field is ${key} only while the setting is written, so '${key}: false' says nothing; leave the setting out.`;

export const flagNotTrueMessage = (key: string) =>
  `Setting '${key}' takes the literal true; write '${key}: true'.`;

export const integerBoundMessage = (key: string) =>
  `Setting '${key}' takes an integer literal or a quoted integer such as "-5".`;

export const PATTERN_VALUE_MESSAGE = `Setting 'pattern' takes a non-empty quoted date pattern such as "dd/MM/yyyy".`;

export const PATTERN_LETTERS_MESSAGE =
  "Setting 'pattern' may hold only SimpleDateFormat letters " +
  '(G, y, Y, M, L, w, W, D, d, F, E, u, a, H, k, K, h, m, s, S, z, Z, X), ' +
  'quoted literal runs, and non-letters; the engine builds a java.text.SimpleDateFormat ' +
  'from it and throws on any other letter (DateFormType).';

export const VALIDATOR_EMPTY_MESSAGE =
  "Setting 'validator' cannot be empty; name the class or the expression it " +
  'resolves (FormValidators.createValidator).';

export const valuesOnNonEnumMessage = (field: FormField) =>
  `Value lines belong on an 'enum' field; '${field.id}' is a ${field.type} field.`;

export const emptyEnumMessage = (id: string) =>
  `Enum field '${id}' offers no values, so the engine rejects every submitted value; add a value line such as 'basic "Basic"'.`;

export const duplicateValueMessage = (id: string) => `Duplicate value '${id}'.`;

/** The default is converted on every render, so it deploys and the form never opens. */
export const enumDefaultMessage = (
  id: string,
  value: string,
  ids: readonly string[],
) =>
  `The default "${value}" of enum field '${id}' names none of its values; write ${formatWordList(ids)}.`;

export const numberDefaultMessage = (id: string, text: string) =>
  `The default ${text} of number field '${id}' is not an integer; the engine ` +
  'converts it with Long.valueOf every time the form renders (LongFormType.convertValue) ' +
  'and throws on anything else.';

export const booleanDefaultMessage = (id: string, text: string) =>
  `The default ${text} of boolean field '${id}' is not "true" or "false"; the engine ` +
  'reads any other spelling as false (BooleanFormType.convertValue).';

/** An ISO date reads as legal to a human and fails the engine's own pattern. */
export const isoDateDefaultMessage = (id: string, value: string) =>
  `The default "${value}" of date field '${id}' is an ISO date, but the engine's default ` +
  'pattern is "dd/MM/yyyy" (ProcessEngineConfigurationImpl.initFormTypes); add a \'pattern\' ' +
  'setting, or write the date to fit it.';

export const formFieldDirectionMessage = (
  id: string,
  direction: string,
  isEnum: boolean,
) =>
  `Unknown member direction '${direction}' in form field '${id}': its block takes 'property <key> = "<value>"' lines${isEnum ? ' and value lines' : ''}.`;

export const propertyValueMessage = (name: string) =>
  `Property '${name}' takes a quoted string or a "\${...}" expression; ` +
  'put the value in quotes.';

const isQuotedMatching = (value: Expr | undefined, shape: RegExp): boolean =>
  isLiteralString(value) && shape.test(value.value);

const isIntegerValue = (value: Expr | undefined): boolean =>
  value !== undefined && integerLiteralText(value) !== undefined;

type ValueShapeRule = (
  key: string,
  value: Expr | undefined,
) => string | undefined;

/** A flag is on while written; `false` has no representation. */
const literalTrue: ValueShapeRule = (key, value) =>
  isLiteralBool(value)
    ? value.value === 'true'
      ? undefined
      : flagFalseMessage(key)
    : flagNotTrueMessage(key);

const integer: ValueShapeRule = (key, value) =>
  isIntegerValue(value) || isQuotedMatching(value, FORM_BOUND_TEXT)
    ? undefined
    : integerBoundMessage(key);

/** A blank literal is the one shape `FormValidators.createValidator` refuses to deploy. */
const nonEmptyText: ValueShapeRule = (_key, value) =>
  isLiteralString(value) && value.value.length === 0
    ? VALIDATOR_EMPTY_MESSAGE
    : undefined;

/** Read off the XML attribute, never as an expression. */
const datePatternShape: ValueShapeRule = (_key, value) => {
  if (!isLiteralString(value) || value.value.length === 0) {
    return PATTERN_VALUE_MESSAGE;
  }
  return PATTERN_LETTERS_TEXT.test(value.value)
    ? undefined
    : PATTERN_LETTERS_MESSAGE;
};

const FORM_FIELD_VALUE_RULES: Readonly<Record<string, ValueShapeRule>> = {
  required: literalTrue,
  readonly: literalTrue,
  min: integer,
  max: integer,
  minlength: integer,
  maxlength: integer,
  validator: nonEmptyText,
  [DATE_PATTERN_KEY]: datePatternShape,
} satisfies Record<
  (typeof FORM_CONSTRAINT_NAMES)[number] | typeof DATE_PATTERN_KEY,
  ValueShapeRule
>;

const headerLiteral: ValueShapeRule = (key, value) =>
  isLiteralString(value) ? undefined : headerLiteralMessage(key);

const historyTimeToLive: ValueShapeRule = (_key, value) =>
  isQuotedMatching(value, HISTORY_TIME_TO_LIVE_TEXT)
    ? undefined
    : HISTORY_TIME_TO_LIVE_MESSAGE;

const versionTag: ValueShapeRule = (_key, value) =>
  !isLiteralString(value)
    ? VERSION_TAG_LITERAL_MESSAGE
    : value.value.length > VERSION_TAG_MAX_LENGTH
      ? VERSION_TAG_LENGTH_MESSAGE
      : undefined;

/** A bare name is an id; only a template is refused. */
const candidateStarters: ValueShapeRule = (key, value) =>
  isRawExpr(value) ||
  (isLiteralString(value) && EXPRESSION_ANYWHERE.test(value.value))
    ? candidateStarterMessage(key)
    : undefined;

/** `BpmnParse.parseProcess` reads each as text, unlike a task's `label`, which is evaluated. */
const PROCESS_HEADER_VALUE_RULES: Readonly<Record<string, ValueShapeRule>> = {
  label: headerLiteral,
  documentation: headerLiteral,
  versionTag,
  historyTimeToLive,
  candidateStarterUsers: candidateStarters,
  candidateStarterGroups: candidateStarters,
};

function particleOnlyMessage(subject: string): string {
  return `Only ${subject} takes a particle.`;
}

function nameRequiredMessage(subject: string, kind: string): string {
  return `${subject} needs the ${kind}'s name: the engine matches ${kind}s by name.`;
}

const TIMER_PAYLOAD_PREFIX =
  'A timer needs to know how to read the time: write ';

export const TIMER_PAYLOAD_MESSAGE =
  TIMER_PAYLOAD_PREFIX +
  `'timer("PT1H")', 'timer(at: "2026-08-01T09:00:00")', or ` +
  `'timer(every: "R/PT10M")'.`;

export const LISTENER_TIMER_PAYLOAD_MESSAGE =
  TIMER_PAYLOAD_PREFIX +
  `'after "PT1H"', 'at "2026-08-01T09:00:00"', or 'every "R/PT10M"'.`;

const timerShapeMessage = (
  particle: string,
  expected: string,
  calendar: string,
) =>
  `'${particle}' takes ${expected}; the engine reads it as text and fails when it does not fit (${calendar}).`;

export const AFTER_SHAPE_MESSAGE = timerShapeMessage(
  'after',
  'an ISO 8601 duration such as "PT1H", on its own or beside a start or end date-time ("2026-01-01T00:00:00/PT1H", "PT1H/2026-12-31T00:00:00")',
  'DurationBusinessCalendar.resolveDuedate',
);

export const AT_SHAPE_MESSAGE = timerShapeMessage(
  'at',
  'an ISO date-time such as "2026-08-01T09:00:00", or a duration counted from now',
  'DueDateBusinessCalendar.resolveDuedate',
);

export const EVERY_SHAPE_MESSAGE = timerShapeMessage(
  'every',
  'an ISO 8601 repeat such as "R/PT10M", or a six-field cron expression or one of its nicknames such as "@daily"',
  'CycleBusinessCalendar.resolveDuedate',
);

const TIMER_SHAPE_BY_PARTICLE: Readonly<
  Record<TimerParticle, { pattern: RegExp; message: string }>
> = {
  after: { pattern: AFTER_TIME_TEXT, message: AFTER_SHAPE_MESSAGE },
  at: { pattern: AT_TIME_TEXT, message: AT_SHAPE_MESSAGE },
  every: { pattern: EVERY_TIME_TEXT, message: EVERY_SHAPE_MESSAGE },
};

/** `only` omits the name slot, which an author who wrote none should not see as a placeholder. */
const CONDITION_PHRASING = {
  handler: {
    subject: 'A condition handler',
    clause: 'on condition',
    only: "'on condition'",
  },
  catch: {
    subject: 'An awaited condition',
    clause: 'await condition',
    only: "'await condition'",
  },
  start: {
    subject: 'A condition start',
    clause: 'start S condition',
    only: 'a condition start',
  },
} as const;

type ConditionPosition = keyof typeof CONDITION_PHRASING;

export const SECOND_PAREN_VALUE_MESSAGE =
  'The parens carry one unkeyed value, the payload; a second one names ' +
  "nothing and never reaches the engine. Write it as a 'key: value' setting, " +
  'or remove it.';

export const COMPENSATE_TYPO_MESSAGE =
  "Unknown event kind 'compensate'; write 'compensation'.";

export const CONDITIONAL_TYPO_MESSAGE = `Unknown event kind 'conditional'; did you mean 'condition'?`;

export const PARALLEL_SECOND_ELSE_MESSAGE =
  "A 'parallel' statement takes one 'else' branch at most; the first one " +
  'already runs when no condition held. Fold this branch into it or give it a ' +
  'condition.';

export const PARALLEL_ELSE_WITHOUT_CONDITION_MESSAGE =
  "An 'else' branch needs a sibling branch with a condition: with no condition " +
  'anywhere every branch runs, so there is nothing to fall back from. Give a ' +
  "sibling a condition, or drop the 'else'.";

export const PARALLEL_ELSE_BESIDE_UNCONDITIONED_MESSAGE =
  "An 'else' branch runs only when no sibling branch was taken, and a branch " +
  'with no condition is always taken, so this one could never run. Give every ' +
  "sibling a condition, or drop the 'else'.";

export const START_TRIGGER_IN_HANDLER_MESSAGE =
  "The start of an event-handler body carries no trigger; the handler's own " +
  "'on <kind>' is what it catches.";

export const NESTED_START_FORM_MESSAGE =
  'A start inside a subprocess, attempt block, or handler body takes no ' +
  "form: the engine reads a start form off the process's own start alone " +
  '(BpmnParse.parseStartFormHandlers) and BpmnParse.parseScopeStartEvent ' +
  'reads none, so this form is never shown.';

export const NESTED_START_INITIATOR_MESSAGE =
  'A start inside a subprocess, attempt block, or handler body takes no ' +
  "'initiator': the engine reads it off the process's own start alone " +
  '(BpmnParse.parseProcessDefinitionStartEvent) and ' +
  'BpmnParse.parseScopeStartEvent reads none, so nothing is written.';

export const SECOND_DEFAULT_START_MESSAGE =
  'A process takes one plain or timer start: Operaton refuses a second one ' +
  '(BpmnParse.selectInitial), so the deployment fails. Keep one, or give ' +
  'this start a message, signal, or condition trigger.';

export const START_AFTER_IMPLICIT_START_MESSAGE =
  'A body that does not open with a start gets a plain start of its own, ' +
  "so this is the process's second plain or timer start, which Operaton " +
  'refuses (BpmnParse.selectInitial), so the deployment fails. Open the ' +
  'body with this start, or give it a message, signal, or condition trigger.';

export function duplicateNamedStartMessage(
  trigger: string,
  name: string,
): string {
  return `Another start already subscribes to ${trigger} '${name}': Operaton keeps one ${trigger} start subscription per name and process (BpmnParse.addEventSubscriptionDeclaration), so the deployment fails.`;
}

export function duplicateConditionStartMessage(text: string): string {
  return `Another start already carries the condition '${text}': Operaton keeps one conditional start per condition text and process (BpmnParse.addEventSubscriptionDeclaration), so the deployment fails.`;
}

export function timerJobKeyTwiceMessage(key: string): string {
  return `Setting '${key}' is already written on the 'on timer' head, and both land on this start event, the element the engine reads the timer job's settings from (BpmnParse.parseTimer, DefaultFailedJobParseListener.parseStartEvent); keep one.`;
}

export function raceDuplicateMessage(trigger: string, name: string): string {
  return `Another branch of this 'await' already catches ${trigger} '${name}': every branch subscribes on the gateway's own scope (BpmnParse.parseIntermediateCatchEvent), which keeps one ${trigger} subscription per name (BpmnParse.addEventSubscriptionDeclaration), so the deployment fails.`;
}

export const DEAD_LOOP_MESSAGE =
  "This loop can never repeat: every path through the 'do' body ends or redirects the flow, so the condition is never evaluated and the loop gateway would lower to a disconnected node with no incoming flow, which is invalid BPMN. End after the loop, or keep one path through the body.";

export function emptyLoopBodyMessage(keyword: string): string {
  return `The '${keyword}' body has no steps, so the loop and its condition would be dropped: with nothing to loop over, the gateway keeps only its exit and the condition is never written. Put a step in the body, or remove the loop.`;
}

export function blockMemberMessage(what: string, verb: string): string {
  return `${what} written inside a body belongs to nothing and is dropped: put it in the attribute block of the element it ${verb}, the braces before that element's body.`;
}

const END_TRIGGERS_MESSAGE =
  "An end event carries 'terminate', which stops every running path in this " +
  `scope, or 'cancel', which gives up the 'attempt' block it sits in.`;

export const END_TIMER_MESSAGE =
  'A timer cannot end a process; a timer is something a process waits on. ' +
  `Write 'await timer("PT1H")' to pause the flow here, ` +
  `'on timer("PT1H")' to react while the surrounding steps run, or ` +
  `'on <step>: timer("PT1H")' to watch only while that step runs. ` +
  END_TRIGGERS_MESSAGE;

export const END_CONDITION_MESSAGE =
  'A condition cannot end a process; a condition is something a process ' +
  `waits on. Write 'await condition(amount > 100)' to pause the flow ` +
  `here, 'on condition(amount > 100)' to react while the surrounding ` +
  `steps run, or 'on <step>: condition(amount > 100)' to watch only ` +
  'while that step runs. ' +
  END_TRIGGERS_MESSAGE;

export const END_TRIGGER_NO_CODE_MESSAGES: Readonly<Record<string, string>> = {
  terminate:
    'Terminate names nothing: it stops every running path in this scope; ' +
    'leave the payload out.',
  cancel:
    'Cancel names nothing: it gives up the block this end sits in; leave the ' +
    'payload out.',
} satisfies Record<(typeof END_TRIGGERS)[number], string>;

export const CANCEL_END_PLACEMENT_MESSAGE =
  "A cancel end belongs directly inside an 'attempt' block: it gives that " +
  'block up, and the engine refuses one anywhere else. Wrap the steps to ' +
  `give up in 'attempt <name> { ... }', or end this path with a plain 'end'.`;

export const CANCEL_HOSTLESS_MESSAGE =
  "A cancel is caught on the block it gives up; write 'on <block>: cancel'. " +
  'A handler with no host opens on its own trigger, and nothing opens on a ' +
  'cancel.';

export const CANCEL_ALONGSIDE_MESSAGE =
  'Giving a block up ends every step still running inside it, so there is ' +
  "nothing left to run alongside; remove 'alongside'.";

export const EMPTY_CODE_MESSAGE =
  'An empty code ("") is not a catch-all; to catch every error, leave the ' +
  'payload out entirely.';

export const CANCEL_NO_CODE_MESSAGE =
  'A cancel handler catches nothing by name: it runs when its block is ' +
  'given up; leave the payload out.';

export const CANCEL_NOT_RAISED_MESSAGE =
  'A cancel is not raised: it is how a block gives itself up; write ' +
  `'end <name> cancel' inside the 'attempt' block.`;

export const CANCEL_NOT_AWAITED_MESSAGE =
  'A cancel is not awaited: it is how a block gives itself up; write ' +
  `'end <name> cancel' inside the 'attempt' block, and ` +
  `'on <block>: cancel' beside the block to say what happens then.`;

export const COMPENSATION_NO_CODE_MESSAGE =
  "Compensation has no code or name: 'on compensation { }' is the undo block " +
  'of the subprocess or attempt block it sits in; leave the payload out.';

export const COMPENSATION_BINDINGS_MESSAGE =
  "'(code: c)' bindings belong to error and escalation handlers; compensation carries no values.";

export const COMPENSATION_ALONGSIDE_MESSAGE =
  'The work an undo block reverses has already finished, so there is no ' +
  "running flow to run alongside; remove 'alongside'.";

export const COMPENSATION_PLACEMENT_MESSAGE =
  "An undo block belongs directly inside the 'subprocess' or 'attempt' whose " +
  'work it undoes: a process cannot undo itself.';

export const COMPENSATION_DUPLICATE_MESSAGE =
  'A subprocess or an attempt block has one undo block; merge the steps.';

export const COMPENSATION_HOST_MESSAGE =
  "Compensation cannot attach to a host: it undoes a subprocess's " +
  'already-completed work through its own undo block, not through a ' +
  "boundary event; remove the host and write 'on compensation { ... }' " +
  'directly inside the subprocess or attempt block it reverses.';

export const LINK_CATCH_FLOW_MESSAGE =
  "Nothing may flow into an 'await link': end the path before it with 'end', " +
  "'throw', 'goto', or 'emit link', because a link catch is entered only by " +
  "'emit link' of the same name.";

export const LINK_IN_RACE_MESSAGE =
  "'link' cannot head a branch of an 'await' block: the engine refuses a link " +
  `catch after an event-based gateway; write 'await link("<name>")' as its ` +
  'own statement.';

export const ESCALATION_NO_MESSAGE_MESSAGE =
  'An escalation carries a code but no message.';

export const DECLARATION_SETTINGS_ONLY_MESSAGE =
  `A declaration's parens take only ${formatWordList(EVENT_BINDING_FIELDS)} ` +
  "settings, written 'key: value'.";

export const settingsOnlyMessage = (description: string) =>
  `The parens of ${description} take only settings, written 'key: value'.`;

export const loopJoinKeyMessage = (key: string, description: string) =>
  `Setting '${key}' is not valid on ${description}: a loop has one gateway, so write '${ENGINE_KEY_BY_JOIN_KEY[key]}'.`;

export const refusedHeadKeyMessage = (
  key: string,
  description: string,
): string =>
  `Setting '${key}' is not valid on ${description}: Operaton refuses it ` +
  'on an event-based gateway (BpmnParse.parseEventBasedGateway). Write it on ' +
  'the branch triggers instead.';

export const prunedJoinMessage = (description: string, key: string) =>
  `Every branch of this ${description.replace(/^an? /, '')} ends its path, so there is no join for '${key}' to set; the setting has no effect.`;

export const noJobMessage = (
  key: string,
  pairing: readonly string[],
  description: string,
): string =>
  `Setting '${key}' on ${description} configures no job: Operaton creates ` +
  `one only when ${formatWordList(pairing)} is also set ` +
  '(BpmnParse.parseAsynchronousContinuation, DefaultFailedJobParseListener.parseActivity).';

export const noPerRunJobMessage = (
  key: string,
  pairing: readonly string[],
  description: string,
): string =>
  `Setting '${key}' on ${description} prices the per-run job Operaton ` +
  'creates in the multi-instance body (BpmnParse.parseActivity), which ' +
  `exists only when ${formatWordList(pairing)} is also set.`;

/**
 * A timer creates its own job regardless of the async flags: a node with its
 * own timer trigger, or a host-less `on timer` handler's start.
 */
function isTimerCarrier(owner: AttributeOwner): boolean {
  if ('trigger' in owner && owner.trigger === 'timer') return true;
  if (!isStartEvent(owner) || owner.trigger !== undefined) return false;
  const container = owner.$container;
  return (
    isBlock(container) &&
    isOnHandler(container.$container) &&
    container.$container.trigger === 'timer' &&
    container.$container.host === undefined
  );
}

/**
 * A process signal start and an intermediate signal catch get a subscription
 * job priced from `jobPriority`; the other two keys still need a flag. A
 * boundary or event sub-process signal declares no such job.
 */
function isSignalSubscriptionJobCarrier(owner: AttributeOwner): boolean {
  return (
    (isStartEvent(owner) ||
      isIntermediateCatchEvent(owner) ||
      isRaceBranch(owner)) &&
    owner.trigger === 'signal'
  );
}

/**
 * Ids the desugarer and layout synthesize. A container's own
 * `StartEvent_<id>`/`EndEvent_<id>` are matched exactly by
 * {@link mintedTerminalRole} so the Modeler's `StartEvent_1` stays legal.
 */
const RESERVED_ID_PATTERNS: ReadonlyArray<RegExp> = [
  /^Gateway_.+_(split|join|fork|loop|race)$/,
  /^Flow_.+_.+$/,
  /^Throw_/,
  /^EventSubProcess_/,
  /^Boundary_/,
  /^Catch_/,
  /^EndEvent_Boundary_/,
  /^StartEvent_EventSubProcess_/,
  /^EndEvent_EventSubProcess_/,
  /_di$/,
  /^BPMNDiagram_/,
  /^BPMNPlane_/,
];

function mintedTerminalRole(
  name: string,
  containerId: string,
): 'start' | 'end' | undefined {
  if (name === `StartEvent_${containerId}`) return 'start';
  if (name === `EndEvent_${containerId}`) return 'end';
  return undefined;
}

const RESERVED_ID_SHAPE_LIST = RESERVED_ID_PATTERNS.map(
  (pattern) =>
    `'${pattern.source.replace(/^\^/, '').replace(/\$$/, '').replaceAll('.+', '...')}'`,
)
  .map((shape, index, all) =>
    index === all.length - 1 ? `and ${shape}` : shape,
  )
  .join(', ');

/** `any`/`json`/`unknown` fit every operator: Operaton coerces them. */
type ExprType = VarType | 'unknown';

const NUMERIC_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'number',
  'any',
  'json',
  'unknown',
]);
const ORDERED_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'number',
  'date',
  'any',
  'json',
  'unknown',
]);
const BOOLEAN_OK: ReadonlySet<ExprType> = new Set<ExprType>([
  'boolean',
  'any',
  'json',
  'unknown',
]);

function collectNamedStatements(process: Process): NamedStatement[] {
  return AstUtils.streamAst(process).filter(isNamedStatement).toArray();
}

function collectGotoTargetNames(process: Process): Set<string> {
  return new Set(
    AstUtils.streamAst(process)
      .filter(isGotoStatement)
      .map((goto) => goto.target?.$refText ?? '')
      .filter((name) => name.length > 0),
  );
}

function statementName(stmt: Statement): string | undefined {
  return isNamedStatement(stmt) ? stmt.name : undefined;
}

/**
 * Keyed as the engine compares: a message or signal by name, a condition by its
 * rendered text; a plain or timer start registers none.
 */
function startSubscriptionKey(start: StartEvent): string | undefined {
  if (start.trigger === 'condition') {
    return duplicateKey(start.trigger, conditionTextOf(start));
  }
  if (start.trigger !== undefined && NAME_SCOPED_TRIGGERS.has(start.trigger)) {
    return duplicateKey(start.trigger, payloadTextOf(start.items));
  }
  return undefined;
}

function conditionTextOf(start: StartEvent): string | undefined {
  const value = payloadItemOf(start.items)?.value;
  if (value === undefined || !isExpr(value)) return undefined;
  // A partial parse leaves a slot empty and the render throws.
  try {
    return renderExpression(value);
  } catch {
    return undefined;
  }
}

/** Error recovery leaves mandatory slots `undefined` whatever the generated types say. */
function blockStatements(block: Block | undefined): Statement[] {
  return block?.statements ?? [];
}

function childBlocks(stmt: Statement): Array<Block | undefined> {
  if (isIfStatement(stmt)) {
    return [
      stmt.then,
      ...stmt.elseIfs.map((e) => e.body),
      ...(stmt.elseBlock ? [stmt.elseBlock] : []),
    ];
  }
  if (isWhileStatement(stmt) || isDoWhileStatement(stmt)) {
    return [stmt.body];
  }
  if (isParallelStatement(stmt) || isRaceStatement(stmt)) {
    return stmt.branches.map((branch) => branch.body);
  }
  if (isSubProcess(stmt) || isOnHandler(stmt)) {
    return [stmt.body];
  }
  return [];
}

/** A handler never joins the main sequence. */
function hasNoFlowStep(statements: Statement[]): boolean {
  return statements.every(isOnHandler);
}

function isLinkThrow(node: AstNode): node is EmitStatement {
  return isEmitStatement(node) && node.trigger === 'link';
}

function isLinkCatch(node: AstNode): node is IntermediateCatchEvent {
  return isIntermediateCatchEvent(node) && node.trigger === 'link';
}

/**
 * Whether `stmt` always ends or diverts the flow, which is exactly when the
 * transform prunes its join. An `if` without `else` and a `while` never do; an
 * `emit link` does, since Operaton refuses a flow out of a link throw.
 */
function statementTerminates(stmt: Statement): boolean {
  if (
    isEndEvent(stmt) ||
    isGotoStatement(stmt) ||
    isThrowStatement(stmt) ||
    isLinkThrow(stmt)
  ) {
    return true;
  }
  // With every parallel branch conditioned, the transform's fallback runs straight to the join.
  const counts = isIfStatement(stmt)
    ? stmt.elseBlock !== undefined
    : isDoWhileStatement(stmt) ||
      isRaceStatement(stmt) ||
      (isParallelStatement(stmt) &&
        stmt.branches.some((branch) => branch.condition === undefined));
  return (
    counts &&
    childBlocks(stmt).every((block) => blockTerminates(blockStatements(block)))
  );
}

function hasConditionedBranch(stmt: ParallelStatement): boolean {
  return stmt.branches.some((branch) => branch.condition !== undefined);
}

function hasUnconditionedBranch(stmt: ParallelStatement): boolean {
  return stmt.branches.some(
    (branch) => branch.condition === undefined && !branch.otherwise,
  );
}

function blockTerminates(statements: Statement[]): boolean {
  return statements.some(
    (stmt) => !isOnHandler(stmt) && statementTerminates(stmt),
  );
}

function previousFlowStatement(
  statements: Statement[],
  index: number,
): Statement | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const stmt = statements[i]!;
    if (!isOnHandler(stmt)) return stmt;
  }
  return undefined;
}

/** `undefined` where the unkeyed value is a payload or has its own message. */
function settingsOnlyOwnerDescription(
  owner: ParenValue['$container'],
): string | undefined {
  if (isProcess(owner)) return 'a process header';
  if (isListener(owner)) return 'a listener';
  if (
    isFormField(owner) ||
    isCodeDecl(owner) ||
    gatewayStatementRuleOf(owner) !== undefined ||
    isOnHandler(owner) ||
    isIntermediateCatchEvent(owner) ||
    isRaceBranch(owner) ||
    isThrowStatement(owner) ||
    isEmitStatement(owner)
  ) {
    return undefined;
  }
  const description = attributeBlockRuleOf(owner)!.description;
  if (!isStartEvent(owner) && !isEndEvent(owner)) return description;
  return owner.trigger === undefined
    ? `${description} with no trigger`
    : undefined;
}

/** `undefined` when a part is unparsed, which would stringify into a self-colliding key. */
function duplicateKey(
  ...parts: ReadonlyArray<string | undefined>
): string | undefined {
  return parts.includes(undefined) ? undefined : parts.join(':');
}

function forEachDuplicate<T>(
  items: Iterable<T>,
  key: (item: T) => string | undefined,
  onDuplicate: (item: T) => void,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) {
      continue;
    }
    if (seen.has(k)) {
      onDuplicate(item);
    } else {
      seen.add(k);
    }
  }
}

export class BpmnScriptValidator {
  private readonly variables: VariableSymbolProvider;

  constructor(services: BpmnScriptServices) {
    this.variables = services.references.VariableSymbolProvider;
  }

  /** The transform converts only the first process. */
  checkModel = (model: Model, accept: ValidationAcceptor): void => {
    forEachDuplicate(
      model.processes,
      () => 'process',
      (extra) =>
        accept(
          'error',
          'Only one process is supported per file. ' +
            'Move additional processes into separate files.',
          { node: extra, property: 'name' },
        ),
    );
  };

  /**
   * Operaton runs a flow into a start as a pass-through, so a start after a live
   * chain is refused. A subprocess, attempt or handler body allows one start,
   * first; a hosted handler's body lowers into its host's container.
   */
  private checkStartPosition(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    for (const node of AstUtils.streamAst(process)) {
      if (!isStartEvent(node) || node.name === undefined) continue;
      if (node.$container === process) {
        const prev = previousFlowStatement(
          process.body,
          process.body.indexOf(node),
        );
        if (
          prev === undefined ||
          isStartEvent(prev) ||
          statementTerminates(prev)
        ) {
          continue;
        }
        accept(
          'error',
          `'start ${node.name}' opens an entry of its own and takes no incoming flow, ` +
            'but the statement before it still flows on to it. Close that flow ' +
            "first (with 'end', 'throw', or 'goto') or move the start ahead of " +
            'that step.',
          { node, property: 'name' },
        );
        continue;
      }
      const container = node.$container;
      if (isBlock(container) && container.statements[0] === node) {
        if (isSubProcess(container.$container)) continue;
        if (isOnHandler(container.$container)) {
          if (container.$container.host === undefined) continue;
          accept('error', hostedHandlerStartMessage(node.name), {
            node,
            property: 'name',
          });
          continue;
        }
      }
      accept(
        'error',
        `'start ${node.name}' must be a top-level statement of its process, or the first statement of its subprocess, attempt block, or event-handler body. ` +
          'A start event cannot have incoming flows.',
        { node, property: 'name' },
      );
    }
  }

  /**
   * With no plain or timer start, starting by key throws; a start form binds to
   * the initial start only; `initiator` is set off every start, last wins. A
   * body not opening with `start` gets one minted, which counts as the first.
   */
  private checkDefaultStart(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const starts = process.body.filter(isStartEvent);
    const hasImplicitStart = !isStartEvent(process.body[0]);
    if (starts.length + (hasImplicitStart ? 1 : 0) < 2) return;

    const defaultCandidates = starts.filter(
      (start) => start.trigger === undefined || start.trigger === 'timer',
    );
    if (
      !hasImplicitStart &&
      defaultCandidates.length === 0 &&
      process.name !== undefined
    ) {
      accept('warning', noDefaultStartMessage(process.name), {
        node: process,
        property: 'name',
      });
    }
    for (const start of defaultCandidates.slice(hasImplicitStart ? 0 : 1)) {
      accept(
        'error',
        hasImplicitStart
          ? START_AFTER_IMPLICIT_START_MESSAGE
          : SECOND_DEFAULT_START_MESSAGE,
        { node: start, property: 'name' },
      );
    }
    forEachDuplicate(starts, startSubscriptionKey, (start) =>
      accept(
        'error',
        start.trigger === 'condition'
          ? duplicateConditionStartMessage(conditionTextOf(start)!)
          : duplicateNamedStartMessage(
              start.trigger!,
              payloadTextOf(start.items)!,
            ),
        { node: start, property: 'trigger' },
      ),
    );

    const defaultStart = hasImplicitStart ? undefined : defaultCandidates[0];
    for (const start of starts) {
      if (start === defaultStart) continue;
      for (const form of start.forms) {
        accept('warning', FORM_NEVER_OFFERED_MESSAGE, { node: form });
      }
    }

    const initiatorSettings = starts.flatMap((start) => {
      const setting = configuredSettingsOf(start).find(
        (item) => item.key === 'initiator',
      );
      return setting !== undefined ? [setting] : [];
    });
    for (const setting of initiatorSettings.slice(0, -1)) {
      accept('warning', INITIATOR_SHADOWED_MESSAGE, {
        node: setting,
        property: 'key',
      });
    }
  }

  checkProcess = (process: Process, accept: ValidationAcceptor): void => {
    if (process.name !== undefined && hasNoFlowStep(process.body)) {
      accept(
        'error',
        `Process '${process.name}' has no flow steps: a process needs at least one step on its main flow (handlers alone do not start a process).`,
        { node: process, property: 'name' },
      );
    }

    const symbols = this.variables.collect(process);

    this.checkKeywordVarDecls(process, accept);
    for (const expr of collectExpressions(process)) {
      this.checkExpression(expr, symbols, accept);
    }

    this.checkStartPosition(process, accept);
    this.checkDefaultStart(process, accept);

    const named = collectNamedStatements(process);
    this.checkReservedNames(named, accept);

    this.checkDuplicateVarDecls(process, accept);
    this.checkProcessAttributes(process, accept);
    this.checkDuplicateStatementNames(process, named, accept);
    this.checkFormVariableAgreement(process, accept);
    this.checkUnreachableStatements(process, accept);
    this.checkLinkEvents(process, accept);
    this.checkHandlerDuplicates(process, accept);
    this.checkCodeDecls(process, accept);
  };

  /**
   * Operaton accepts a flow into a link catch; it is refused because a modeller's
   * link target never has one. Checked before `goto` re-rooting so a named catch
   * draws only the `goto` error. Sound, not exhaustive: a dead step may go
   * unreported, a live one is never rejected.
   */
  private checkUnreachableStatements(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const gotoTargets = collectGotoTargetNames(process);

    const scan = (statements: Statement[]): void => {
      let reachable = true;
      for (const stmt of statements) {
        if (isOnHandler(stmt)) {
          for (const block of childBlocks(stmt)) {
            scan(blockStatements(block));
          }
          continue;
        }
        if (isLinkCatch(stmt) && reachable) {
          accept('error', LINK_CATCH_FLOW_MESSAGE, {
            node: stmt,
            property: 'trigger',
          });
        }
        const name = statementName(stmt);
        if (
          isStartEvent(stmt) ||
          isLinkCatch(stmt) ||
          (name !== undefined && gotoTargets.has(name))
        ) {
          reachable = true;
        }
        if (!reachable) {
          accept(
            'error',
            'This step can never run: an earlier `end`, `throw`, `goto`, ' +
              '`emit link`, or an all-terminating `if`/`parallel`/`await` in ' +
              'the same block always ends or redirects the flow before ' +
              'reaching it, so this step would lower to a disconnected node ' +
              'with no incoming flow, which is invalid BPMN.',
            { node: stmt },
          );
        } else {
          for (const block of childBlocks(stmt)) {
            scan(blockStatements(block));
          }
        }
        if (statementTerminates(stmt)) {
          reachable = false;
        }
      }
    };

    scan(process.body);
  }

  /**
   * A throw resolves to the catch in its own container, else the first in
   * document order. Both ends must share a flow container
   * (`ScopeImpl.findActivityAtLevelOfSubprocess`); a catch with no throw
   * deploys, so it only warns.
   */
  private checkLinkEvents(process: Process, accept: ValidationAcceptor): void {
    const throws: EmitStatement[] = [];
    const catches: IntermediateCatchEvent[] = [];
    for (const node of AstUtils.streamAst(process)) {
      if (isLinkThrow(node) && payloadTextOf(node.items)) throws.push(node);
      if (isLinkCatch(node) && payloadTextOf(node.items)) catches.push(node);
    }
    const nameOf = (end: EmitStatement | IntermediateCatchEvent): string =>
      payloadTextOf(end.items) ?? '';
    const at = (end: EmitStatement | IntermediateCatchEvent) => ({
      node: end,
      property: 'trigger' as const,
    });

    forEachDuplicate(catches, nameOf, (extra) =>
      accept(
        'error',
        `Another 'await link("${nameOf(extra)}")' already catches this link: ` +
          'the engine keeps one catch per link name in the whole file, even ' +
          'across subprocesses.',
        at(extra),
      ),
    );

    for (const throwEvent of throws) {
      const name = nameOf(throwEvent);
      const container = enclosingFlowContainer(throwEvent);
      const named = catches.filter((c) => nameOf(c) === name);
      const catchEvent =
        named.find((c) => enclosingFlowContainer(c) === container) ?? named[0];
      if (catchEvent === undefined) {
        accept(
          'error',
          `No 'await link("${name}")' catches this link, and the engine ` +
            'refuses to deploy an emitted link with no catch of its name. ' +
            'Write one where the flow should continue.',
          at(throwEvent),
        );
        continue;
      }
      if (enclosingFlowContainer(catchEvent) !== container) {
        accept(
          'error',
          `'emit link("${name}")' must sit in the same process, subprocess, ` +
            "or handler body as its 'await link': a link cannot cross a " +
            "subprocess or handler boundary, the same way a 'goto' cannot.",
          at(throwEvent),
        );
        continue;
      }
      const branch = findEnclosingBranch(catchEvent);
      if (
        branch &&
        !AstUtils.hasContainerOfType(throwEvent, (node) => node === branch.body)
      ) {
        accept(
          'error',
          intoBranchMessage(
            `emit link("${name}")`,
            'emit link',
            branch.keyword,
          ),
          at(throwEvent),
        );
      }
    }

    const thrown = new Set(throws.map(nameOf));
    for (const catchEvent of catches) {
      if (thrown.has(nameOf(catchEvent))) continue;
      accept(
        'warning',
        `No 'emit link("${nameOf(catchEvent)}")' names this catch, so it ` +
          'and the steps after it never run.',
        at(catchEvent),
      );
    }
  }

  /** Each binds the same process variable; a catch binding always fills a `string`. */
  private checkFormVariableAgreement(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const declaredType = new Map<string, VarType>();
    /** Records a first declaration as a side effect. */
    const clash = (name: string, type: VarType): VarType | undefined => {
      const prior = declaredType.get(name);
      if (prior === undefined) declaredType.set(name, type);
      return prior === type ? undefined : prior;
    };
    // An unparsed name or type would seed `undefined` and hide the next disagreement.
    for (const decl of process.decls) {
      if (
        isVarDecl(decl) &&
        decl.name !== undefined &&
        decl.type !== undefined
      ) {
        declaredType.set(decl.name, decl.type);
      }
    }
    for (const node of AstUtils.streamAst(process)) {
      if (isOnHandler(node)) {
        for (const binding of caughtBindingsOf(node.items)) {
          if (binding.variable === undefined) continue;
          const prior = clash(binding.variable, 'string');
          if (prior === undefined) continue;
          accept(
            'error',
            `Catch-binding variable '${binding.variable}' is typed 'string', but '${binding.variable}' is already declared as '${prior}'; the types must agree.`,
            { node: binding.node, property: 'value' },
          );
        }
        continue;
      }
      if (!isStartEvent(node) && !isUserTask(node)) continue;
      for (const form of node.forms) {
        for (const field of form.fields) {
          if (field.id === undefined || field.type === undefined) continue;
          const type = formFieldVariableType(field.type);
          if (type === undefined) continue;
          const prior = clash(field.id, type);
          if (prior === undefined) continue;
          accept(
            'error',
            `Form field '${field.id}' is typed '${field.type}', but '${field.id}' is already declared as '${prior}'; the types must agree.`,
            { node: field, property: 'type' },
          );
        }
      }
    }
  }

  private checkReservedNames(
    named: NamedStatement[],
    accept: ValidationAcceptor,
  ): void {
    for (const node of named) {
      const container = enclosingContainerName(node);
      const role =
        container === undefined
          ? undefined
          : mintedTerminalRole(node.name, container);
      if (role !== undefined) {
        accept(
          'error',
          `Statement name '${node.name}' is the id the compiler generates for ` +
            `the implicit ${role} event of '${container}'; choose another name.`,
          { node, property: 'name' },
        );
      } else if (isReservedName(node.name)) {
        accept(
          'error',
          `Statement name '${node.name}' matches a reserved synthesized-id pattern. ` +
            `Prefixes ${RESERVED_ID_SHAPE_LIST} are reserved for ids the ` +
            'desugarer or the layouter generates.',
          { node, property: 'name' },
        );
      }
    }
  }

  /** The symbol provider stays last-wins; this surfaces the conflict. */
  private checkDuplicateVarDecls(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    if (process.name === undefined) return;

    forEachDuplicate(
      process.decls.filter(isVarDecl),
      (decl) => decl.name,
      (decl) =>
        accept(
          'error',
          `Variable '${decl.name}' is already declared in process '${process.name}'.`,
          { node: decl, property: 'name' },
        ),
    );
  }

  private checkProcessAttributes(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    this.checkDuplicateKeys(settingsOf(process.items), accept);
    const settings = configuredSettingsOf(process);
    this.checkAttributeKeys(
      settings,
      PROCESS_HEADER_KEY_SET,
      'a process header',
      accept,
    );
    for (const attr of settings) {
      const message = PROCESS_HEADER_VALUE_RULES[attr.key]?.(
        attr.key,
        attr.value,
      );
      if (message !== undefined) {
        accept('error', message, { node: attr, property: 'value' });
      }
    }
    this.checkFlags(process.items, [], 'a process header', accept);
  }

  private checkDuplicateStatementNames(
    process: Process,
    named: NamedStatement[],
    accept: ValidationAcceptor,
  ): void {
    if (process.name === undefined) return;

    forEachDuplicate(
      named,
      (node) => node.name,
      (node) =>
        accept(
          'error',
          `Step name '${node.name}' is already used by another step in process ` +
            `'${process.name}'; 'goto ${node.name}' would be ambiguous.`,
          { node, property: 'name' },
        ),
    );

    // A step named like the process duplicates the `bpmn:process` id.
    for (const node of named) {
      if (node.name !== process.name) continue;
      accept(
        'error',
        `Step name '${node.name}' equals the process id; the compiled ` +
          'document can hold only one element with that id.',
        { node, property: 'name' },
      );
    }
  }

  private checkKeywordVarDecls(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    for (const decl of process.decls) {
      if (isVarDecl(decl) && JUEL_RESERVED_WORD_SET.has(decl.name)) {
        accept(
          'error',
          juelKeywordMessage(decl.name, variableKeySpelling(decl.name)),
          { node: decl, property: 'name' },
        );
      }
    }
  }

  private checkExpression(
    expr: Expr,
    symbols: VariableTable,
    accept: ValidationAcceptor,
  ): void {
    // An `out` source is evaluated in the called process's scope.
    const enclosingMapping = AstUtils.getContainerOfType(
      expr,
      isVariableMapping,
    );
    if (enclosingMapping?.direction === 'out') {
      return;
    }

    const container = expr.$container;
    if (isVarRef(expr)) {
      const nameTrigger = nameTriggerOf(expr);
      const variableUse = isVariableUse(expr);
      if (nameTrigger !== undefined) {
        accept(
          'error',
          barewordNameMessage(nameTrigger, renderExpressionInner(expr)),
          { node: expr, property: 'ref' },
        );
      } else if (variableUse || readsExternalTask(expr)) {
        // A bare collection name or `in`/`out` source is written as a plain
        // attribute the engine looks up or takes as a constant, never evaluated.
        const isBareLookupName =
          expr.accessors.length === 0 &&
          (expr.$containerProperty === 'collection' ||
            (expr.$containerProperty === 'source' &&
              isVariableMapping(container)));
        if (!isBareLookupName) {
          checkRenderedNames(expr, accept);
        }
        if (variableUse && !symbols.has(expr.ref.$refText)) {
          accept(
            'warning',
            `Variable '${expr.ref.$refText}' is not declared. Add 'var ${expr.ref.$refText}: <type>' to the process.`,
            { node: expr, property: 'ref' },
          );
        }
      }
    }

    if (isRawExpr(expr)) {
      checkRawTemplateNames(expr.raw, { node: expr, property: 'raw' }, accept);
      // A raw's body is spliced into the surrounding expression; the top is rendered as written.
      if (
        (isExpr(container) || isAccessor(container)) &&
        singleTemplateBody(expr.raw) === undefined
      ) {
        accept('error', COMPOSITE_OPERAND_MESSAGE, {
          node: expr,
          property: 'raw',
        });
      }
    }

    const slot = conditionSlotOf(expr);
    if (slot !== undefined) {
      const shape = nonBooleanShapeOf(expr, symbols);
      if (shape !== undefined) {
        accept('error', nonBooleanConditionMessage(shape, slot), {
          node: expr,
        });
      }
    }

    // The grammar cannot refuse this: `message("OrderReceived")` needs the string literal.
    if (isLiteralString(expr) && expr.value.length > 0) {
      const codeTrigger = codeTriggerOf(expr);
      if (codeTrigger !== undefined) {
        accept('error', quotedCodeMessage(codeTrigger, expr.value), {
          node: expr,
          property: 'value',
        });
      }
    }

    if (isRelational(expr)) {
      this.checkBinaryTypes(
        expr,
        ORDERED_OK,
        'an ordered comparison',
        symbols,
        accept,
      );
    } else if (isAdditive(expr) || isMultiplicative(expr)) {
      this.checkBinaryTypes(
        expr,
        NUMERIC_OK,
        'an arithmetic expression',
        symbols,
        accept,
      );
    } else if (isLogical(expr)) {
      this.checkBinaryTypes(
        expr,
        BOOLEAN_OK,
        'a logical expression',
        symbols,
        accept,
      );
    }
  }

  private checkBinaryTypes(
    node: Relational | Additive | Multiplicative | Logical,
    allowed: ReadonlySet<ExprType>,
    context: string,
    symbols: VariableTable,
    accept: ValidationAcceptor,
  ): void {
    for (const side of ['left', 'right'] as const) {
      const operand = node[side];
      if (!isVarRef(operand)) {
        continue;
      }
      const type = symbols.get(operand.ref.$refText)?.type;
      if (type === undefined) {
        continue;
      }
      if (!allowed.has(type)) {
        accept(
          'error',
          `Variable '${operand.ref.$refText}' of type '${type}' cannot be used in ${context} (operator '${node.op}').`,
          { node, property: side },
        );
      }
    }
  }

  checkStartEvent = (start: StartEvent, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(start, accept);

    const container = start.$container;
    if (isBlock(container)) {
      for (const form of start.forms) {
        accept('error', NESTED_START_FORM_MESSAGE, { node: form });
      }
      for (const setting of settingsOf(start.items)) {
        if (setting.key === 'initiator') {
          accept('error', NESTED_START_INITIATOR_MESSAGE, {
            node: setting,
            property: 'key',
          });
        }
      }
      this.checkTimerHeadKeys(start, container.$container, accept);
    }

    if (start.trigger === undefined) return;

    if (isBlock(container)) {
      const host = container.$container;
      if (isSubProcess(host) || isOnHandler(host)) {
        accept(
          'error',
          isSubProcess(host)
            ? startTriggerInBlockMessage(host)
            : START_TRIGGER_IN_HANDLER_MESSAGE,
          { node: start, property: 'trigger' },
        );
        return;
      }
    }

    if (!START_TRIGGERS_SET.has(start.trigger)) {
      accept('error', startTriggerMessage(start.trigger), {
        node: start,
        property: 'trigger',
      });
      return;
    }

    this.checkStartPayload(start, TRIGGER_PAYLOAD[start.trigger]!, accept);
  };

  /**
   * A host-less `on timer` writes its job keys onto its body's start, so a key
   * on both collides; the head's wins.
   */
  private checkTimerHeadKeys(
    start: StartEvent,
    owner: AstNode,
    accept: ValidationAcceptor,
  ): void {
    if (!isOnHandler(owner) || owner.trigger !== 'timer' || owner.host) return;
    const headKeys = new Set(settingsOf(owner.items).map((s) => s.key));
    for (const setting of settingsOf(start.items)) {
      if (TIMER_JOB_KEY_SET.has(setting.key) && headKeys.has(setting.key)) {
        accept('error', timerJobKeyTwiceMessage(setting.key), {
          node: setting,
          property: 'key',
        });
      }
    }
  }

  /** No repeat warning: a repeating start is a legitimate schedule. */
  private checkStartPayload(
    start: StartEvent,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    const name = payloadTextOf(start.items);
    if (rule.code === 'required' && !name) {
      accept(
        'error',
        nameRequiredMessage(`A ${start.trigger} start`, start.trigger!),
        { node: start, property: 'trigger' },
      );
    }

    // `RAW_TEMPLATE` is anchored at the quote, so an opener further in lexes as a plain string.
    if (
      start.trigger === 'message' &&
      name !== undefined &&
      EXPRESSION_ANYWHERE.test(name)
    ) {
      accept('error', startMessageExpressionMessage(name), {
        node: payloadItemOf(start.items)!,
        property: 'value',
      });
    }

    this.checkConditionPayload(start, rule, 'start', accept);

    this.checkTimerClause(
      start,
      rule.timer,
      particleOnlyMessage('a timer start'),
      accept,
    );
  }

  checkEndEvent = (end: EndEvent, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(end, accept);

    if (end.trigger === undefined) return;

    if (!END_TRIGGERS_SET.has(end.trigger)) {
      accept('error', endTriggerMessage(end.trigger), {
        node: end,
        property: 'trigger',
      });
      return;
    }

    // The engine reads the enclosing container, so a cancel end in an `if`
    // branch still ends the block.
    if (
      end.trigger === 'cancel' &&
      !isAttemptBlock(enclosingFlowContainer(end))
    ) {
      accept('error', CANCEL_END_PLACEMENT_MESSAGE, {
        node: end,
        property: 'trigger',
      });
      return;
    }

    if (payloadTextOf(end.items) !== undefined) {
      accept('error', END_TRIGGER_NO_CODE_MESSAGES[end.trigger], {
        node: payloadItemOf(end.items)!,
        property: 'value',
      });
    }
  };

  checkAttributeOwner = (
    owner: AttributeOwner,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(owner, accept);
  };

  checkUserTask = (task: UserTask, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(task, accept);
    this.checkFormReference(task, accept);
  };

  /** Operaton refuses a task naming a form both ways or with no binding. */
  private checkFormReference(task: UserTask, accept: ValidationAcceptor): void {
    const attrs = settingsOf(task.items);
    const writes = (key: string) => attrs.some((attr) => attr.key === key);
    const target = { node: task, property: 'name' } as const;

    if (!writes('formRef')) {
      if (writes('binding') || writes('version')) {
        accept('error', FORM_REF_MISSING_MESSAGE, target);
      }
      return;
    }
    if (writes('formKey')) {
      accept('error', FORM_KEY_AND_REF_MESSAGE, target);
    }
    if (!writes('binding') && !writes('version')) {
      accept('error', FORM_REF_BINDING_MESSAGE, target);
      return;
    }
    this.checkBindingAttribute(task, accept);
    this.checkBindingVersionExclusion(task, 'A user task', accept);
  }

  /** The engine runs a send task as a service task. */
  checkServiceTaskAttributes = (
    task: ServiceTask | SendTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(task, accept);
    if (task.name === undefined) return;
    this.checkImplementationBinding(
      task,
      `${isServiceTask(task) ? 'Service' : 'Send'} task '${task.name}'`,
      SERVICE_TASK_BINDING_KEYS,
      accept,
    );
  };

  checkBusinessRuleTask = (
    task: BusinessRuleTask,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(task, accept);

    if (task.name !== undefined) {
      this.checkImplementationBinding(
        task,
        `Decision step '${task.name}'`,
        BUSINESS_RULE_BINDING_KEYS,
        accept,
      );
    }
    this.checkDecisionModifiers(task, accept);
    this.checkBindingAttribute(task, accept);
    this.checkBindingVersionExclusion(task, 'A decision step', accept);
    this.checkDecisionResultMapping(task, accept);
  };

  /** The checks reading the binding's value run only once exactly one binding is written. */
  private checkImplementationBinding(
    task: ServiceTask | SendTask | BusinessRuleTask,
    subject: string,
    keys: readonly string[],
    accept: ValidationAcceptor,
  ): void {
    const settings = settingsOf(task.items);
    const target = { node: task, property: 'name' };
    if (this.checkExactlyOneBinding(settings, keys, subject, target, accept)) {
      this.checkBuiltinBinding(task, subject, accept);
      this.checkResultVariableBinding(task, accept);
    }
  }

  /**
   * `parseServiceTaskLike`'s mail and shell refusals; a field's own shape is
   * {@link checkField}'s and comes first.
   */
  private checkBuiltinBinding(
    task: ServiceTask | SendTask | BusinessRuleTask,
    subject: string,
    accept: ValidationAcceptor,
  ): void {
    const attr = settingsOf(task.items).find((a) => a.key === TYPE_BINDING_KEY);
    if (!attr) return;

    const type = bindingValueText(attr.value);
    const builtin = TYPE_BINDING_VALUES.find((value) => value === type);
    if (builtin === undefined) {
      accept('error', TYPE_VALUE_MESSAGE, { node: attr, property: 'value' });
      return;
    }
    const fields = task.params.filter(
      (param) => isFieldParameter(param) && param.name !== undefined,
    );
    for (const group of BUILTIN_REQUIRED_FIELDS[builtin]) {
      if (!fields.some((field) => group.names.includes(field.name))) {
        accept('error', missingBuiltinFieldMessage(subject, builtin, group), {
          node: task,
          property: 'name',
        });
      }
    }
    for (const field of fields) {
      if (!BUILTIN_FIELD_NAMES[builtin].includes(field.name)) {
        accept('error', unknownBuiltinFieldMessage(field.name, builtin), {
          node: field,
          property: 'name',
        });
      } else if (builtin === 'shell' && isRawExpr(field.value)) {
        accept('error', shellFieldExpressionMessage(field.name), {
          node: field,
          property: 'value',
        });
      } else if (
        builtin === 'shell' &&
        SHELL_FLAG_FIELD_SET.has(field.name) &&
        isLiteralString(field.value) &&
        !SHELL_FLAG_LITERAL_SET.has(field.value.value)
      ) {
        accept('error', shellFlagValueMessage(field.name), {
          node: field,
          property: 'value',
        });
      }
    }
  }

  /**
   * A `topic` or `type` binding deploys with the variable and never writes it,
   * so only a warning.
   */
  private checkResultVariableBinding(
    task: ServiceTask | SendTask | BusinessRuleTask,
    accept: ValidationAcceptor,
  ): void {
    const settings = settingsOf(task.items);
    const result = settings.find((a) => a.key === 'resultVariable');
    if (result === undefined) return;
    const target = { node: result, property: 'key' } as const;
    const refusing = settings.find(
      (a) => RESULT_VARIABLE_REFUSING_BINDINGS[a.key] !== undefined,
    );
    if (refusing !== undefined) {
      accept(
        'error',
        resultVariableBindingMessage(
          attributeBlockRuleOf(task)!.description,
          refusing.key,
          SERVICE_TASK_LIKE_ELEMENT[task.$type],
        ),
        target,
      );
      return;
    }
    const unread = settings.find(
      (a) => a.key === EXTERNAL_BINDING_KEY || a.key === TYPE_BINDING_KEY,
    );
    if (unread !== undefined) {
      accept('warning', resultVariableUnreadMessage(unread.key), target);
    }
  }

  private checkDecisionModifiers(
    task: BusinessRuleTask,
    accept: ValidationAcceptor,
  ): void {
    const settings = settingsOf(task.items);
    if (settings.some((a) => a.key === 'decision')) return;
    for (const attr of settings) {
      if (DECISION_MODIFIER_KEYS.includes(attr.key)) {
        accept('error', decisionModifierMessage(attr.key), {
          node: attr,
          property: 'key',
        });
      }
    }
  }

  private checkDecisionResultMapping(
    task: BusinessRuleTask,
    accept: ValidationAcceptor,
  ): void {
    const settings = settingsOf(task.items);
    const attr = settings.find((a) => a.key === 'mapDecisionResult');
    if (!attr) {
      return;
    }
    const value = bindingValueText(attr.value);
    if (value === undefined || !DECISION_RESULT_MAPPING_SET.has(value)) {
      accept(
        'error',
        `Setting 'mapDecisionResult' must be ${formatWordList(DECISION_RESULT_MAPPINGS)}.`,
        { node: attr, property: 'value' },
      );
      return;
    }
    if (
      settings.some((a) => a.key === 'decision') &&
      !settings.some((a) => a.key === 'resultVariable')
    ) {
      accept('warning', MAP_DECISION_RESULT_UNREAD_MESSAGE, {
        node: attr,
        property: 'key',
      });
    }
  }

  checkScriptTask = (task: ScriptTask, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(task, accept);
    if (task.name === undefined) return;

    if (task.body === undefined) {
      // An unterminated fence recovers into a bodyless ScriptTask with no CST node for the body.
      accept(
        'error',
        `Script task '${task.name}' has a malformed or unterminated fenced ` +
          'script body; a script must be a closed ```<lang> ... ``` block.',
        { node: task, property: 'name' },
      );
      return;
    }

    checkFencedScript(
      task.body,
      `Script task '${task.name}'`,
      { node: task, property: 'body' },
      accept,
    );
  };

  private checkFormBlocks(
    forms: FormBlock[],
    ownerDescription: string,
    accept: ValidationAcceptor,
  ): void {
    forms.slice(1).forEach((form) => {
      accept(
        'error',
        `${ownerDescription} may declare at most one 'form' block.`,
        { node: form },
      );
    });

    for (const form of forms) {
      forEachDuplicate(
        form.fields,
        (field) => field.id,
        (field) =>
          accept('error', `Duplicate form field '${field.id}'.`, {
            node: field,
            property: 'id',
          }),
      );
      for (const field of form.fields) {
        if (field.type !== undefined && !FORM_FIELD_TYPE_SET.has(field.type)) {
          accept(
            'error',
            `Form field '${field.id}' has type '${field.type}', which a form cannot use. Use ${formatPlainWordList(FORM_FIELD_TYPES)}.`,
            { node: field, property: 'type' },
          );
        }
        this.checkFormField(field, accept);
      }
    }
  }

  /** An unknown key fails the deployment; misfits and shapes deploy and fail every submission. */
  private checkFormField(field: FormField, accept: ValidationAcceptor): void {
    if (field.id === undefined || field.type === undefined) return;

    for (const item of field.items) {
      if (!isSetting(item)) {
        accept(
          'error',
          formFieldSettingsOnlyMessage(field.id, item.$cstNode?.text ?? ''),
          { node: item },
        );
      }
    }
    const settings = settingsOf(field.items);
    this.checkDuplicateKeys(settings, accept);
    for (const setting of settings) {
      if (!FORM_FIELD_SETTING_KEY_SET.has(setting.key)) {
        accept('error', unknownFormFieldSettingMessage(field.id, setting.key), {
          node: setting,
          property: 'key',
        });
        continue;
      }
      if (FORM_FIELD_TYPE_SET.has(field.type)) {
        const fits = FORM_CONSTRAINT_TYPES[setting.key];
        if (setting.key === DATE_PATTERN_KEY && field.type !== 'date') {
          accept('error', patternMisfitMessage(field), {
            node: setting,
            property: 'key',
          });
        } else if (fits && !fits.some((type) => type === field.type)) {
          accept('error', constraintMisfitMessage(setting.key, field, fits), {
            node: setting,
            property: 'key',
          });
        }
      }
      const shape = FORM_FIELD_VALUE_RULES[setting.key]?.(
        setting.key,
        setting.value,
      );
      if (shape !== undefined) {
        accept('error', shape, { node: setting, property: 'value' });
      }
    }

    const defaultShape = formDefaultShape(
      field,
      settings.some((setting) => setting.key === DATE_PATTERN_KEY),
    );
    if (defaultShape !== undefined) {
      accept('error', defaultShape, { node: field, property: 'defaultValue' });
    }

    const isEnum = field.type === 'enum';
    if (!isEnum) {
      for (const value of field.values) {
        accept('error', valuesOnNonEnumMessage(field), { node: value });
      }
    } else if (field.values.length === 0) {
      accept('warning', emptyEnumMessage(field.id), {
        node: field,
        property: 'id',
      });
    } else {
      forEachDuplicate(
        field.values,
        (value) => value.id,
        (value) =>
          accept('error', duplicateValueMessage(value.id), {
            node: value,
            property: 'id',
          }),
      );
      // A `${...}` default or a bare word is evaluated at render, so only literal text is checked.
      const ids = field.values
        .map((value) => value.id)
        .filter((id) => id !== undefined);
      if (
        isLiteralString(field.defaultValue) &&
        !ids.includes(field.defaultValue.value)
      ) {
        accept(
          'error',
          enumDefaultMessage(field.id, field.defaultValue.value, ids),
          { node: field, property: 'defaultValue' },
        );
      }
    }

    const properties: IoParameter[] = [];
    for (const param of field.params) {
      if (param.direction === PROPERTY_DIRECTION) {
        properties.push(param);
        this.checkPropertyValue(param, accept);
      } else {
        accept(
          'error',
          formFieldDirectionMessage(field.id, param.direction, isEnum),
          { node: param, property: 'direction' },
        );
      }
    }
    this.checkDuplicateParameters(properties, accept);
  }

  /** A property is a `value` attribute, so it takes the shapes a field's `stringValue` takes. */
  private checkPropertyValue(
    param: IoParameter,
    accept: ValidationAcceptor,
  ): void {
    if (!isFieldValue(param.value)) {
      accept('error', propertyValueMessage(param.name), {
        node: param,
        property: 'value',
      });
    }
  }

  private rejectFormBlock(
    forms: FormBlock[],
    description: string,
    accept: ValidationAcceptor,
  ): void {
    for (const form of forms) {
      accept(
        'error',
        `${description} cannot declare a 'form' block; forms belong on start events and user tasks.`,
        { node: form },
      );
    }
  }

  /** The caller checks duplicates over every setting in the parens. */
  private checkAttributeKeys(
    attrs: readonly Setting[],
    allowed: ReadonlySet<string>,
    description: string,
    accept: ValidationAcceptor,
  ): void {
    this.checkAllowedKeys(attrs, allowed, description, accept);
    this.checkAttributeValues(attrs, allowed, accept);
  }

  /** Counts distinct keys; returns whether exactly one binding is written. */
  private checkExactlyOneBinding(
    attrs: readonly Setting[],
    keys: readonly string[],
    subject: string,
    target: { node: AstNode; property: string },
    accept: ValidationAcceptor,
    alternative = '',
  ): boolean {
    const written = bindingKeysOf(attrs, keys);
    if (written.length === 0) {
      accept(
        'error',
        `${subject} must declare a ${formatWordList(keys)} setting${alternative}.`,
        target,
      );
      return false;
    }
    checkAtMostOneBinding(attrs, keys, subject, target, accept);
    return written.length === 1;
  }

  private checkDuplicateKeys(
    attrs: readonly Setting[],
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      attrs,
      (attr) => attr.key,
      (attr) =>
        accept('error', `Duplicate setting '${attr.key}'.`, {
          node: attr,
          property: 'key',
        }),
    );
  }

  /**
   * `sequentially` and `local` are keywords elsewhere, so they lex in any
   * parens and would lower to nothing.
   */
  private checkFlags(
    items: ParenItem[],
    legal: readonly string[],
    description: string,
    accept: ValidationAcceptor,
  ): void {
    for (const flag of flagsOf(items)) {
      if (legal.includes(flag.flag)) continue;
      accept('error', `Flag '${flag.flag}' is not valid on ${description}.`, {
        node: flag,
        property: 'flag',
      });
    }
  }

  private checkAllowedKeys(
    attrs: readonly Setting[],
    allowed: ReadonlySet<string>,
    description: string,
    accept: ValidationAcceptor,
  ): void {
    for (const attr of attrs) {
      if (!allowed.has(attr.key)) {
        accept(
          'error',
          `Setting '${attr.key}' is not valid on ${description}.`,
          {
            node: attr,
            property: 'key',
          },
        );
      }
    }
  }

  /**
   * A boolean flag or engine text field takes one shape and drops the rest
   * silently: `asyncBefore: "true"` emits no attribute at all.
   */
  private checkAttributeValues(
    attrs: readonly Setting[],
    allowed: ReadonlySet<string>,
    accept: ValidationAcceptor,
  ): void {
    for (const attr of attrs) {
      if (!allowed.has(attr.key)) {
        continue;
      }
      if (BOOLEAN_SETTING_KEYS.has(attr.key) && !isLiteralBool(attr.value)) {
        accept(
          'error',
          `Setting '${attr.key}' takes an unquoted boolean; ` +
            `write '${attr.key}: true' or '${attr.key}: false'.`,
          { node: attr, property: 'value' },
        );
      } else if (
        TEXT_ATTR_KEYS.has(attr.key) &&
        !isLiteralString(attr.value) &&
        !isRawExpr(attr.value)
      ) {
        accept(
          'error',
          `Setting '${attr.key}' takes a quoted string or a "\${...}" ` +
            'expression; put the value in quotes.',
          { node: attr, property: 'value' },
        );
      } else if (
        DUE_DATE_KEY_SET.has(attr.key) &&
        isLiteralString(attr.value) &&
        !DUE_DATE_TEXT.test(attr.value.value)
      ) {
        accept('error', dueDateShapeMessage(attr.key), {
          node: attr,
          property: 'value',
        });
      } else if (
        RETRY_CYCLE_ATTR_KEYS.has(attr.key) &&
        isLiteralString(attr.value) &&
        !RETRY_CYCLE_TEXT.test(attr.value.value)
      ) {
        accept('warning', RETRY_CYCLE_SHAPE_MESSAGE, {
          node: attr,
          property: 'value',
        });
      } else if (
        PRIORITY_ATTR_KEYS.has(attr.key) &&
        !isPriorityValue(attr.value)
      ) {
        accept('error', priorityShapeMessage(attr.key), {
          node: attr,
          property: 'value',
        });
      } else if (attr.key === 'version' && !isVersionValue(attr.value)) {
        accept('error', VERSION_SHAPE_MESSAGE, {
          node: attr,
          property: 'value',
        });
      } else {
        const binding = bindingValueMessage(attr.key, attr.value);
        if (binding !== undefined) {
          accept('error', binding, { node: attr, property: 'value' });
        }
      }
    }
  }

  private checkAttributeBlock(
    owner: AttributeOwner,
    accept: ValidationAcceptor,
  ): void {
    const rule = attributeBlockRuleOf(owner)!;
    this.checkDuplicateKeys(settingsOf(owner.items), accept);
    const settings = configuredSettingsOf(owner);
    this.checkAttributeKeys(
      rule.repeats
        ? settings.filter((setting) => setting.key !== RUN_JOB_PRIORITY_KEY)
        : settings,
      rule.keys,
      rule.description,
      accept,
    );
    this.checkRunSettings(owner, rule, settings, accept);
    this.checkJobSettingPairing(owner, rule, settings, accept);
    this.checkFlags(owner.items, rule.flags, rule.description, accept);
    if ('forms' in owner) {
      if (rule.forms) {
        this.checkFormBlocks(owner.forms, rule.description, accept);
      } else {
        this.rejectFormBlock(owner.forms, capitalize(rule.description), accept);
      }
    }
    this.checkIoParameters(owner, rule, accept);
    this.checkExternalExtras(owner, rule, accept);
    this.checkListeners(owner, rule, accept);
  }

  private checkRunSettings(
    owner: AttributeOwner,
    rule: AttributeBlockRule,
    settings: readonly Setting[],
    accept: ValidationAcceptor,
  ): void {
    if (!rule.repeats) return;
    const cardinality = (owner as { cardinality?: Expr }).cardinality;
    if (cardinality !== undefined && !isRepeatCountValue(cardinality)) {
      accept('error', REPEAT_COUNT_MESSAGE, {
        node: owner as AstNode,
        property: 'cardinality',
      });
    }
    const repeated = isRepeated(owner);
    for (const setting of settings) {
      if (setting.key === RUN_JOB_PRIORITY_KEY) {
        accept('error', RUN_JOB_PRIORITY_MESSAGE, {
          node: setting,
          property: 'key',
        });
      } else if (!repeated && RUN_ENGINE_KEY_SET.has(setting.key)) {
        accept(
          'error',
          runWithoutClauseMessage(setting.key, rule.description),
          {
            node: setting,
            property: 'key',
          },
        );
      }
    }
  }

  /**
   * On a repeated carrier the whole-loop job (plain flags) and the per-run job
   * (`run` flags, plus `jobPriority`) are separate; elsewhere there is one job,
   * except a signal catcher, whose subscription job `jobPriority` prices alone.
   */
  private checkJobSettingPairing(
    owner: AttributeOwner,
    rule: AttributeBlockRule,
    settings: readonly Setting[],
    accept: ValidationAcceptor,
  ): void {
    if (isTimerCarrier(owner)) return;
    if (rule.repeats && isRepeated(owner)) {
      this.warnUnpairedJobSettings(
        settings,
        TIMER_JOB_KEYS_WITHOUT_PRIORITY,
        ASYNC_FLAG_KEYS,
        rule.description,
        noJobMessage,
        accept,
      );
      this.warnUnpairedJobSettings(
        settings,
        [...TIMER_JOB_KEYS_WITHOUT_PRIORITY.map(runSettingKey), 'jobPriority'],
        ASYNC_FLAG_KEYS.map(runSettingKey),
        `a repeated ${rule.description.replace(/^an? /, '')}`,
        noPerRunJobMessage,
        accept,
      );
      return;
    }
    this.warnUnpairedJobSettings(
      settings,
      isSignalSubscriptionJobCarrier(owner)
        ? TIMER_JOB_KEYS_WITHOUT_PRIORITY
        : TIMER_JOB_KEYS,
      ASYNC_FLAG_KEYS,
      rule.description,
      noJobMessage,
      accept,
    );
  }

  private warnUnpairedJobSettings(
    settings: readonly Setting[],
    controlKeys: readonly string[],
    asyncKeys: readonly string[],
    description: string,
    message: (
      key: string,
      pairing: readonly string[],
      description: string,
    ) => string,
    accept: ValidationAcceptor,
  ): void {
    if (settings.some((setting) => asyncKeys.includes(setting.key))) return;
    for (const setting of settings) {
      if (!controlKeys.includes(setting.key)) continue;
      accept('warning', message(setting.key, asyncKeys, description), {
        node: setting,
        property: 'key',
      });
    }
  }

  private checkIoParameters(
    owner: AttributeOwner,
    rule: AttributeBlockRule,
    accept: ValidationAcceptor,
  ): void {
    const settings = settingsOf(owner.items);
    const refusal = namesFieldBinding(settings)
      ? undefined
      : fieldBindingMessage(
          capitalize(rule.description),
          fieldlessBindingsOf(settings),
          ELEMENT_FIELD_BINDINGS,
        );
    const recognized: IoParameter[] = [];
    for (const param of owner.params) {
      if (param.direction === FIELD_DIRECTION) {
        if (rule.fields) {
          recognized.push(param);
          this.checkField(param, refusal, accept);
        } else {
          accept('error', noFieldHostMessage(rule.description), {
            node: param,
            property: 'direction',
          });
        }
      } else if (param.direction === PROPERTY_DIRECTION) {
        if (rule.externalExtras) {
          recognized.push(param);
          const topicRefusal = topicRefusalOf(
            rule,
            settings,
            'a property line',
          );
          if (topicRefusal !== undefined) {
            accept('error', topicRefusal, {
              node: param,
              property: 'direction',
            });
          } else {
            this.checkPropertyValue(param, accept);
          }
        } else {
          accept('error', noPropertyHostMessage(rule.description), {
            node: param,
            property: 'direction',
          });
        }
      } else if (!rule.parameters) {
        accept(
          'error',
          `${capitalize(rule.description)} cannot declare an 'input' or 'output' parameter; ${PARAMETER_HOSTS_MESSAGE}`,
          { node: param, property: 'direction' },
        );
      } else if (IO_DIRECTION_SET.has(param.direction)) {
        recognized.push(param);
      } else {
        accept(
          'error',
          unknownDirectionMessage(
            param.direction,
            parameterDirectionsFor(rule),
          ),
          { node: param, property: 'direction' },
        );
      }
    }

    this.checkDuplicateParameters(recognized, accept);

    const directed = recognized.filter((param) =>
      IO_DIRECTION_SET.has(param.direction),
    );
    this.checkRepeatedOutput(owner, directed, accept);
    for (const param of directed) {
      this.checkIoValueShapes(param, accept);
    }
  }

  private checkExternalExtras(
    owner: AttributeOwner,
    rule: AttributeBlockRule,
    accept: ValidationAcceptor,
  ): void {
    const settings = settingsOf(owner.items);
    const priority = settings.find((attr) => attr.key === TASK_PRIORITY_KEY);
    if (priority !== undefined && rule.externalExtras) {
      const refusal = topicRefusalOf(rule, settings, `'${TASK_PRIORITY_KEY}'`);
      if (refusal !== undefined) {
        accept('error', refusal, { node: priority, property: 'key' });
      }
    }
    if (!('errorMappings' in owner)) return;
    for (const mapping of owner.errorMappings) {
      const refusal = rule.externalExtras
        ? topicRefusalOf(rule, settings, 'an error mapping')
        : noMappingHostMessage(rule.description);
      if (refusal !== undefined) {
        accept('error', refusal, { node: mapping, property: 'trigger' });
      } else if (
        mapping.trigger !== undefined &&
        mapping.trigger !== ERROR_MAPPING_HEAD
      ) {
        accept('error', MAPPING_HEAD_MESSAGE, {
          node: mapping,
          property: 'trigger',
        });
      } else if (
        mapping.when !== undefined &&
        mapping.when !== ERROR_MAPPING_WHEN
      ) {
        accept('error', MAPPING_WHEN_MESSAGE, {
          node: mapping,
          property: 'when',
        });
      }
    }
  }

  private checkDuplicateParameters(
    params: readonly IoParameter[],
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      params,
      (param) => duplicateKey(param.direction, param.name),
      (param) =>
        accept(
          'error',
          `Duplicate '${param.direction}' parameter '${param.name}'.`,
          { node: param, property: 'name' },
        ),
    );
  }

  /** One diagnostic per member, placement before shape; the caller words `refusal`. */
  private checkField(
    field: IoParameter,
    refusal: string | undefined,
    accept: ValidationAcceptor,
  ): void {
    if (refusal !== undefined) {
      accept('error', refusal, { node: field, property: 'direction' });
    } else if (!isFieldValue(field.value)) {
      accept('error', fieldValueMessage(field.name), {
        node: field,
        property: 'value',
      });
    } else if (isLiteralString(field.value) && field.value.value.length === 0) {
      accept('error', emptyFieldMessage(field.name), {
        node: field,
        property: 'value',
      });
    } else if (
      isLiteralString(field.value) &&
      EXPRESSION_OPEN.test(field.value.value)
    ) {
      accept('error', escapedFieldLiteralMessage(field.name), {
        node: field,
        property: 'value',
      });
    }
  }

  private checkRepeatedOutput(
    owner: AttributeOwner,
    directed: readonly IoParameter[],
    accept: ValidationAcceptor,
  ): void {
    if (!isRepeated(owner)) {
      return;
    }
    const mapping = directed.find(
      (param) => param.direction === OUTPUT_DIRECTION,
    );
    if (mapping) {
      accept('error', REPEATED_OUTPUT_MESSAGE, {
        node: mapping,
        property: 'direction',
      });
    }
  }

  /**
   * A keyless entry compiles to unimportable XML; a nested script follows the
   * script task's fence rules, resolved at first evaluation instead of deployment.
   */
  private checkIoValueShapes(
    param: IoParameter,
    accept: ValidationAcceptor,
  ): void {
    if (param.value === undefined) return;
    const subject = `${capitalize(param.direction)} '${param.name}'`;

    for (const node of AstUtils.streamAst(param.value)) {
      if (isMapEntry(node) && node.key !== undefined && node.key.length === 0) {
        accept(
          'error',
          `A map entry's key cannot be empty; name the key its value is looked up by.`,
          { node, property: 'key' },
        );
      } else if (isLiteralString(node) && node.value.trim().length === 0) {
        accept('warning', EMPTY_STRING_VALUE_MESSAGE, {
          node,
          property: 'value',
        });
      } else if (isScriptLiteral(node)) {
        checkFencedScript(
          node.body,
          subject,
          { node, property: 'body' },
          accept,
        );
      }
    }
  }

  private checkListeners(
    owner: AttributeOwner,
    rule: AttributeBlockRule,
    accept: ValidationAcceptor,
  ): void {
    // Operaton appends listeners per event and runs them in order, so a repeat is legal.
    for (const listener of owner.listeners) {
      if (!this.checkListenerEvent(listener, rule, accept)) {
        continue;
      }
      this.checkListenerTimer(listener, accept);
      this.checkListenerBinding(listener, accept);
      this.checkListenerFields(listener, accept);
    }
  }

  private checkListenerEvent(
    listener: Listener,
    rule: AttributeBlockRule,
    accept: ValidationAcceptor,
  ): boolean {
    if (listener.event === undefined) return false;

    if (EXECUTION_LISTENER_EVENT_SET.has(listener.event)) {
      return true;
    }
    if (TASK_LISTENER_EVENT_SET.has(listener.event)) {
      if (rule.taskListeners) {
        return true;
      }
      accept(
        'error',
        `'on ${listener.event}' is a task listener, which only a user task has; ` +
          `${rule.description} takes ${formatWordList(EXECUTION_LISTENER_EVENTS)}.`,
        { node: listener, property: 'event' },
      );
      return false;
    }
    accept(
      'error',
      `Unknown listener event '${listener.event}'; write ${formatWordList(listenerEventsFor(rule))}.`,
      { node: listener, property: 'event' },
    );
    return false;
  }

  /**
   * A listener's block configures its binding, not the element, so it holds
   * fields alone; a task listener on a user task may carry one.
   */
  private checkListenerFields(
    listener: Listener,
    accept: ValidationAcceptor,
  ): void {
    const subject = `The 'on ${listener.event}' listener`;
    const settings = settingsOf(listener.items);
    // A fenced body binds the listener in place of its settings.
    const refusal =
      listener.script !== undefined
        ? scriptListenerFieldMessage(subject)
        : namesFieldBinding(settings)
          ? undefined
          : fieldBindingMessage(
              subject,
              fieldlessBindingsOf(settings),
              LISTENER_FIELD_BINDINGS,
            );

    const fields: IoParameter[] = [];
    for (const param of listener.params) {
      if (isFieldParameter(param)) {
        fields.push(param);
        this.checkField(param, refusal, accept);
      } else {
        accept(
          'error',
          unknownDirectionMessage(param.direction, [FIELD_DIRECTION]),
          { node: param, property: 'direction' },
        );
      }
    }

    this.checkDuplicateParameters(fields, accept);
  }

  private checkListenerBinding(
    listener: Listener,
    accept: ValidationAcceptor,
  ): void {
    if (listener.script !== undefined) {
      checkFencedScript(
        listener.script,
        `The 'on ${listener.event}' listener`,
        { node: listener, property: 'script' },
        accept,
      );
      return;
    }

    this.checkAttributeKeys(
      settingsOf(listener.items),
      LISTENER_BINDING_KEY_SET,
      'a listener',
      accept,
    );
    this.checkFlags(listener.items, [], 'a listener', accept);
    this.checkExactlyOneBinding(
      settingsOf(listener.items),
      LISTENER_BINDING_KEYS,
      `The 'on ${listener.event}' listener`,
      { node: listener, property: 'event' },
      accept,
      ', or a fenced script body',
    );
  }

  /**
   * A join every branch closes is pruned by the transform, so a setting for it
   * warns and the pairing warning stays quiet.
   */
  private checkGatewaySettings(
    stmt: GatewayStatement,
    accept: ValidationAcceptor,
  ): void {
    const rule = gatewayStatementRuleOf(stmt)!;
    const settings = settingsOf(stmt.items);
    for (const item of stmt.items) {
      if (isParenValue(item)) {
        accept('error', settingsOnlyMessage(rule.description), {
          node: item,
        });
      }
    }
    this.checkDuplicateKeys(settings, accept);
    this.checkFlags(stmt.items, [], rule.description, accept);

    const joinSettings = settings.filter((setting) =>
      JOIN_ENGINE_KEY_SET.has(setting.key),
    );
    if (!rule.join) {
      for (const setting of joinSettings) {
        accept('error', loopJoinKeyMessage(setting.key, rule.description), {
          node: setting,
          property: 'key',
        });
      }
    }
    this.checkAttributeKeys(
      rule.join
        ? settings
        : settings.filter((setting) => !JOIN_ENGINE_KEY_SET.has(setting.key)),
      rule.join ? SPLIT_AND_JOIN_KEY_SET : ENGINE_KEY_SET,
      rule.description,
      accept,
    );

    for (const setting of settings) {
      if (!rule.refuses.includes(setting.key)) continue;
      accept('error', refusedHeadKeyMessage(setting.key, rule.description), {
        node: setting,
        property: 'key',
      });
    }
    this.warnUnpairedJobSettings(
      settings,
      TIMER_JOB_KEYS,
      ASYNC_FLAG_KEYS,
      rule.description,
      noJobMessage,
      accept,
    );
    if (!rule.join) return;
    if (statementTerminates(stmt)) {
      for (const setting of joinSettings) {
        accept('warning', prunedJoinMessage(rule.description, setting.key), {
          node: setting,
          property: 'key',
        });
      }
      return;
    }
    this.warnUnpairedJobSettings(
      settings,
      TIMER_JOB_KEYS.map(joinSettingKey),
      ASYNC_FLAG_KEYS.map(joinSettingKey),
      rule.description,
      noJobMessage,
      accept,
    );
  }

  checkIfStatement = (stmt: IfStatement, accept: ValidationAcceptor): void => {
    this.checkGatewaySettings(stmt, accept);
    this.checkEmptyBlock(
      stmt.then,
      'warning',
      "The 'if' branch has no steps.",
      accept,
    );
    for (const elseIf of stmt.elseIfs) {
      this.checkEmptyBlock(
        elseIf.body,
        'warning',
        "The 'else if' branch has no steps.",
        accept,
      );
    }
    if (stmt.elseBlock) {
      this.checkEmptyBlock(
        stmt.elseBlock,
        'warning',
        "The 'else' branch has no steps.",
        accept,
      );
    }
  };

  checkWhileStatement = (
    stmt: WhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkGatewaySettings(stmt, accept);
    this.checkEmptyBlock(
      stmt.body,
      'error',
      emptyLoopBodyMessage('while'),
      accept,
    );
  };

  checkDoWhileStatement = (
    stmt: DoWhileStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkGatewaySettings(stmt, accept);
    this.checkEmptyBlock(
      stmt.body,
      'error',
      emptyLoopBodyMessage('do'),
      accept,
    );
    // The body runs first, so a terminating body leaves the gateway unreached.
    if (blockTerminates(blockStatements(stmt.body))) {
      accept('error', DEAD_LOOP_MESSAGE, { node: stmt, property: 'condition' });
    }
  };

  /**
   * The grammar admits parameters and listeners in any body, but only an
   * attribute block is lowered.
   */
  checkBlock = (block: Block, accept: ValidationAcceptor): void => {
    for (const param of block.params) {
      accept(
        'error',
        blockMemberMessage(`An '${param.direction}' parameter`, 'configures'),
        { node: param, property: 'direction' },
      );
    }
    for (const listener of block.listeners) {
      accept('error', blockMemberMessage('A listener', 'observes'), {
        node: listener,
        property: 'event',
      });
    }
  };

  checkSubProcess = (stmt: SubProcess, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(stmt, accept);

    if (stmt.name !== undefined && hasNoFlowStep(blockStatements(stmt.body))) {
      const kind = describeStatementKind(stmt);
      accept(
        'error',
        `${capitalize(kind)} named '${stmt.name}' has no flow steps: ${kind} needs at least one step on its main flow (handlers alone do not start it).`,
        { node: stmt, property: 'name' },
      );
    }

    this.checkCancelPair(stmt, accept);
  };

  private checkCancelPair(block: SubProcess, accept: ValidationAcceptor): void {
    if (!block.transactional || block.name === undefined) return;

    const handler = cancelHandlerFor(block);
    if (hasCancelEndInScope(block)) {
      if (handler === undefined) {
        accept('warning', cancelEndWithoutHandlerMessage(block.name), {
          node: block,
          property: 'name',
        });
      }
    } else if (handler !== undefined) {
      accept('warning', cancelHandlerWithoutEndMessage(block.name), {
        node: handler,
        property: 'trigger',
      });
    }
  }

  checkParallelStatement = (
    stmt: ParallelStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkGatewaySettings(stmt, accept);
    stmt.branches.forEach((branch, index) => {
      this.checkEmptyBlock(
        branch.body,
        'warning',
        `Branch ${index + 1} of the 'parallel' statement has no steps.`,
        accept,
      );
    });
    this.checkFallbackBranch(stmt, accept);
  };

  private checkFallbackBranch(
    stmt: ParallelStatement,
    accept: ValidationAcceptor,
  ): void {
    const fallbacks = stmt.branches.filter((branch) => branch.otherwise);
    for (const branch of fallbacks.slice(1)) {
      accept('error', PARALLEL_SECOND_ELSE_MESSAGE, {
        node: branch,
        property: 'otherwise',
      });
    }
    if (fallbacks.length === 0) return;
    const message = !hasConditionedBranch(stmt)
      ? PARALLEL_ELSE_WITHOUT_CONDITION_MESSAGE
      : hasUnconditionedBranch(stmt)
        ? PARALLEL_ELSE_BESIDE_UNCONDITIONED_MESSAGE
        : undefined;
    if (message !== undefined) {
      accept('error', message, {
        node: fallbacks[0]!,
        property: 'otherwise',
      });
    }
  }

  checkRaceStatement = (
    stmt: RaceStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkGatewaySettings(stmt, accept);
    stmt.branches.forEach((branch, index) => {
      this.checkAttributeBlock(branch, accept);
      this.checkEmptyBlock(
        branch.body,
        'warning',
        `Branch ${index + 1} of the 'await' statement has no steps.`,
        accept,
      );
      this.checkCatchTrigger(branch, accept);
    });
    forEachDuplicate(
      stmt.branches.filter((branch) =>
        NAME_SCOPED_TRIGGERS.has(branch.trigger),
      ),
      (branch) => duplicateKey(branch.trigger, payloadTextOf(branch.items)),
      (branch) =>
        accept(
          'error',
          raceDuplicateMessage(branch.trigger, payloadTextOf(branch.items)!),
          { node: branch, property: 'trigger' },
        ),
    );
  };

  private checkEmptyBlock(
    block: Block | undefined,
    severity: 'error' | 'warning',
    message: string,
    accept: ValidationAcceptor,
  ): void {
    if (block !== undefined && block.statements.length === 0) {
      accept(severity, message, { node: block, property: 'statements' });
    }
  }

  checkGotoStatement = (
    goto: GotoStatement,
    accept: ValidationAcceptor,
  ): void => {
    const target = goto.target?.ref;
    if (!target) {
      return;
    }
    const targetName = targetStatementName(target);
    if (isLinkCatch(target)) {
      accept(
        'error',
        `'goto ${targetName}' cannot target an awaited link: a link catch is ` +
          "entered by 'emit link' of the same name, not by a sequence flow.",
        { node: goto, property: 'target' },
      );
      return;
    }
    const branch = findEnclosingBranch(target);
    if (
      branch &&
      !AstUtils.hasContainerOfType(goto, (node) => node === branch.body)
    ) {
      accept(
        'error',
        intoBranchMessage(`goto ${targetName}`, 'goto', branch.keyword),
        { node: goto, property: 'target' },
      );
    }
  };

  checkCallActivity = (
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(call, accept);
    this.checkCallProcessAttribute(call, accept);
    this.checkBindingAttribute(call, accept);
    this.checkBindingVersionExclusion(call, 'A call', accept);
    this.checkCallMapperExclusion(call, accept);
    this.checkCallMappingDuplicates(call, accept);
  };

  private checkCallProcessAttribute(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    if (settingsOf(call.items).some((a) => a.key === 'process')) return;
    accept(
      'error',
      `A call must name the process it starts: add process: "<id>".`,
      { node: call, property: 'name' },
    );
  }

  /** Bare `version` parses as a variable reference, quoted as a string; both read the same text. */
  private checkBindingAttribute(
    owner: VersionPinnedElement,
    accept: ValidationAcceptor,
  ): void {
    const bindingAttr = settingsOf(owner.items).find(
      (a) => a.key === 'binding',
    );
    if (!bindingAttr) {
      return;
    }
    const value = bindingValueText(bindingAttr.value);
    if (value !== undefined && CALL_BINDING_VALUE_SET.has(value)) {
      return;
    }
    if (value === 'version') {
      accept(
        'error',
        `Write 'version: <number>' instead of 'binding: version'.`,
        { node: bindingAttr, property: 'value' },
      );
      return;
    }
    accept(
      'error',
      `Setting 'binding' must be ${formatWordList(CALL_BINDING_VALUES)}.`,
      { node: bindingAttr, property: 'value' },
    );
  }

  private checkBindingVersionExclusion(
    owner: VersionPinnedElement,
    subject: string,
    accept: ValidationAcceptor,
  ): void {
    const hasBinding = settingsOf(owner.items).some((a) => a.key === 'binding');
    const hasVersion = settingsOf(owner.items).some((a) => a.key === 'version');
    if (hasBinding && hasVersion) {
      accept(
        'error',
        `${subject} cannot combine 'binding' and 'version'; use 'version: <number>' to pin a specific version, or ${BINDING_MODE_PHRASES.join('/')} for the other modes.`,
        { node: owner, property: 'name' },
      );
    }
  }

  /** The engine's if/else-if would drop one of the two silently. */
  private checkCallMapperExclusion(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    checkAtMostOneBinding(
      settingsOf(call.items),
      Object.values(CALL_MAPPER_KEY_BY_KIND),
      'A call',
      { node: call, property: 'name' },
      accept,
    );
  }

  /** `in` and `out` are separate; a second `*` collides, `*` beside a named target does not. */
  private checkCallMappingDuplicates(
    call: CallActivity,
    accept: ValidationAcceptor,
  ): void {
    forEachDuplicate(
      call.mappings,
      (mapping) =>
        duplicateKey(mapping.direction, mapping.all ? '*' : mapping.target),
      (mapping) =>
        accept(
          'error',
          mapping.all
            ? `Duplicate '${mapping.direction} *' mapping; a direction can copy every variable only once.`
            : `Duplicate '${mapping.direction}' mapping target '${mapping.target}'.`,
          mapping.all
            ? { node: mapping }
            : { node: mapping, property: 'target' },
        ),
    );
  }

  checkOnHandler = (handler: OnHandler, accept: ValidationAcceptor): void => {
    this.checkAttributeBlock(handler, accept);

    if (handler.trigger === undefined) return;

    if (!ON_TRIGGERS_SET.has(handler.trigger)) {
      accept('error', onTriggerMessage(handler.trigger), {
        node: handler,
        property: 'trigger',
      });
      return;
    }

    this.checkHandlerPlacement(handler, accept);
    this.checkHandlerTrailing(handler, accept);

    const rule = TRIGGER_PAYLOAD[handler.trigger];

    this.checkHandlerHost(handler, rule, accept);

    const alongside = flagOf(handler.items, 'alongside');
    if (alongside !== undefined && !rule.alongside) {
      accept('error', alongsideMessage(handler.trigger), {
        node: alongside,
        property: 'flag',
      });
    }

    this.checkHandlerPayload(handler, rule, accept);

    if (rule.parens === 'bindings') {
      this.checkHandlerBindings(handler, accept);
    }

    this.checkEmptyBlock(
      handler.body,
      'warning',
      'The event handler has no steps.',
      accept,
    );
  };

  /** An empty string counts as omitted; there is no empty catch-all. */
  private checkHandlerPayload(
    handler: OnHandler,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    const code = payloadTextOf(handler.items);
    const payload = payloadItemOf(handler.items);
    if (rule.code === 'required') {
      if (!code) {
        accept('error', nameRequiredMessage('A message handler', 'message'), {
          node: handler,
          property: 'trigger',
        });
      }
    } else if (rule.code === 'optional') {
      checkEmptyCode(code, handler.items, accept);
    } else if (handler.trigger === 'compensation' && code !== undefined) {
      // Timer's forbidden payload is the timer branch's, so `on
      // timer("banana")` reads as a bad time.
      accept('error', COMPENSATION_NO_CODE_MESSAGE, {
        node: payload!,
        property: 'value',
      });
    } else if (handler.trigger === 'cancel' && code !== undefined) {
      accept('error', CANCEL_NO_CODE_MESSAGE, {
        node: payload!,
        property: 'value',
      });
    }

    this.checkConditionPayload(handler, rule, 'handler', accept);

    this.checkTimerClause(
      handler,
      rule.timer,
      particleOnlyMessage("'on timer'"),
      accept,
    );

    const handlerBindings = caughtBindingsOf(handler.items);
    if (rule.parens === 'forbidden' && handlerBindings.length > 0) {
      for (const binding of handlerBindings) {
        accept(
          'error',
          handler.trigger === 'compensation'
            ? COMPENSATION_BINDINGS_MESSAGE
            : `'(code: c)' bindings belong to error and escalation handlers; a ${handler.trigger} carries no code.`,
          { node: binding.node, property: 'key' },
        );
      }
    }
  }

  private checkConditionPayload(
    node: CatchHeader | OnHandler | StartEvent,
    rule: TriggerPayloadRule,
    position: ConditionPosition,
    accept: ValidationAcceptor,
  ): void {
    const { subject, clause, only } = CONDITION_PHRASING[position];
    const form = `${clause}(amount > 100)`;
    const payload = payloadItemOf(node.items);

    if (rule.parens === 'condition' && payload === undefined) {
      accept('error', `${subject} needs its condition: '${form}'.`, {
        node,
        property: 'trigger',
      });
    }

    if (node.trigger === 'condition' && hasQuotedPayload(node.items)) {
      accept(
        'error',
        `${subject} takes no code string; write the condition itself: '${form}'.`,
        { node: payload!, property: 'value' },
      );
    }

    if (node.trigger !== 'condition' && hasExpressionPayload(node.items)) {
      accept('error', `Only ${only} takes a condition expression.`, {
        node: payload!,
        property: 'value',
      });
    }
  }

  /**
   * A timer start's expression is parsed at deployment, so a bad shape is an
   * error; elsewhere it is read on scope entry, so a warning.
   */
  private checkTimerClause(
    node: CatchHeader | OnHandler | StartEvent,
    required: boolean,
    particleOnly: string,
    accept: ValidationAcceptor,
  ): void {
    if (!required) {
      const keyed = timerParticleOf(node.items);
      if (keyed !== undefined) {
        accept('error', particleOnly, { node: keyed.node, property: 'key' });
      }
      return;
    }
    const timer = timerPayloadOf(node.items);
    if (timer === undefined) {
      accept('error', TIMER_PAYLOAD_MESSAGE, { node, property: 'trigger' });
      return;
    }
    this.checkTimerShape(
      timer.time,
      timer.particle,
      { node: timer.node, property: 'value' },
      isStartEvent(node) ? 'error' : 'warning',
      accept,
    );
    if (isOnHandler(node)) {
      this.checkTimerRepeatsOnce(node, timer, accept);
    }
  }

  /**
   * `timeout` has no lifecycle transition, so its timer follows the event word;
   * it fires at task creation.
   */
  private checkListenerTimer(
    listener: Listener,
    accept: ValidationAcceptor,
  ): void {
    const particle = listener.particle;
    if (listener.event !== 'timeout') {
      if (particle !== undefined) {
        accept('error', particleOnlyMessage("'on timeout'"), {
          node: listener,
          property: 'particle',
        });
      }
      return;
    }
    const known = TIMER_PARTICLES.find((word) => word === particle);
    if (particle === undefined) {
      accept('error', LISTENER_TIMER_PAYLOAD_MESSAGE, {
        node: listener,
        property: 'event',
      });
    } else if (known === undefined) {
      accept(
        'error',
        `Unknown timer particle '${particle}'; write ${formatWordList(TIMER_PARTICLES)}.`,
        { node: listener, property: 'particle' },
      );
    } else if (listener.time !== undefined) {
      // The one template slot outside `Expr`, so the expression walk misses it.
      checkRawTemplateNames(
        listener.time,
        { node: listener, property: 'time' },
        accept,
      );
      this.checkTimerShape(
        listener.time,
        known,
        { node: listener, property: 'time' },
        'warning',
        accept,
      );
    }
  }

  private checkTimerShape(
    time: string,
    particle: TimerParticle,
    target: { node: AstNode; property: string },
    severity: 'error' | 'warning',
    accept: ValidationAcceptor,
  ): void {
    if (EXPRESSION_OPEN.test(time)) return;
    const shape = TIMER_SHAPE_BY_PARTICLE[particle];
    if (!shape.pattern.test(time)) {
      accept(severity, shape.message, target);
    }
  }

  private checkTimerRepeatsOnce(
    handler: OnHandler,
    timer: TimerPayload,
    accept: ValidationAcceptor,
  ): void {
    if (timer.particle === 'every' && !hasFlag(handler.items, 'alongside')) {
      accept(
        'warning',
        'A repeating timer that interrupts its scope fires at most once: ' +
          "add 'alongside' to let it repeat, or give it a duration instead.",
        { node: timer.node },
      );
    }
  }

  private checkHandlerPlacement(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    const container = handler.$container;
    if (isProcess(container)) {
      if (handler.trigger === 'compensation') {
        accept('error', COMPENSATION_PLACEMENT_MESSAGE, { node: handler });
      }
      return;
    }
    const owner = container.$container;
    if (isSubProcess(owner) || isOnHandler(owner)) {
      if (handler.trigger === 'compensation' && !isSubProcess(owner)) {
        accept('error', COMPENSATION_PLACEMENT_MESSAGE, { node: handler });
      }
      return;
    }
    accept(
      'error',
      'An event handler belongs directly in the body of a process, a subprocess, an attempt block, or another event handler: it handles events for that whole scope, not for a single branch.',
      { node: handler },
    );
  }

  private checkHandlerTrailing(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    const list = statementListOf(handler);
    const index = list.indexOf(handler);
    const hasNonHandlerAfter = list
      .slice(index + 1)
      .some((stmt) => !isOnHandler(stmt));
    if (hasNonHandlerAfter) {
      accept(
        'error',
        'Event handlers read like catch blocks: move it after the last step of this body.',
        { node: handler },
      );
    }
  }

  private checkHandlerBindings(
    handler: OnHandler,
    accept: ValidationAcceptor,
  ): void {
    for (const binding of caughtBindingsOf(handler.items)) {
      if (
        binding.field === EVENT_MESSAGE_FIELD &&
        !TRIGGER_PAYLOAD[handler.trigger]!.message
      ) {
        accept('error', ESCALATION_NO_MESSAGE_MESSAGE, {
          node: binding.node,
          property: 'key',
        });
      } else if (binding.variable === undefined) {
        // `code: "X"` is a setting, not a binding, so nothing gets bound.
        accept(
          'error',
          `A catch binding names the variable the caught ${binding.field} lands in, not a value: write '${binding.field}: <name>'.`,
          { node: binding.node, property: 'value' },
        );
      }
    }
  }

  /**
   * The scope provider offers a step in the handler's own body, so the circular
   * case is refused here; the `escalation` and `cancel` host sets are Operaton's.
   */
  private checkHandlerHost(
    handler: OnHandler,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (handler.host === undefined) {
      if (!rule.hostless) {
        accept('error', CANCEL_HOSTLESS_MESSAGE, {
          node: handler,
          property: 'trigger',
        });
      }
      return;
    }
    if (!rule.boundary) {
      accept('error', COMPENSATION_HOST_MESSAGE, {
        node: handler,
        property: 'host',
      });
      return;
    }

    const host = handler.host.ref;
    if (host === undefined) {
      return;
    }

    if (AstUtils.hasContainerOfType(host, (n) => n === handler)) {
      accept('error', selfAttachedHostMessage(targetStatementName(host)), {
        node: handler,
        property: 'host',
      });
      return;
    }

    if (!isActivityStatement(host)) {
      accept('error', illegalHostMessage(host), {
        node: handler,
        property: 'host',
      });
      return;
    }

    if (handler.trigger === 'escalation' && !isEscalationLegalHost(host)) {
      accept('error', escalationHostMessage(host), {
        node: handler,
        property: 'host',
      });
      return;
    }

    if (handler.trigger === 'cancel' && !isAttemptBlock(host)) {
      accept('error', cancelHostMessage(host), {
        node: handler,
        property: 'host',
      });
    }
  }

  /**
   * Two handlers on one engine scope ({@link subscriptionScopeOf}) with the same
   * catch are refused whatever their `alongside`, as is an escalation catch-all
   * beside a coded one.
   */
  private checkHandlerDuplicates(
    process: Process,
    accept: ValidationAcceptor,
  ): void {
    const candidates: OnHandler[] = [];
    for (const node of AstUtils.streamAst(process)) {
      if (!isOnHandler(node)) continue;
      if (!ON_TRIGGERS_SET.has(node.trigger)) continue;
      // Timer and condition key no subscription name, and two deadlines in one
      // scope is a real pattern.
      if (node.trigger === 'timer' || node.trigger === 'condition') continue;
      // An unresolved host would collide with every host-less handler.
      if (node.host !== undefined && node.host.ref === undefined) continue;
      candidates.push(node);
    }
    for (const [scope, siblings] of Map.groupBy(
      candidates,
      subscriptionScopeOf,
    )) {
      if (scope === undefined) continue;
      forEachDuplicate(
        siblings,
        (handler) =>
          duplicateKey(
            catchKindOf(handler),
            handler.trigger,
            payloadTextOf(handler.items) ?? '',
          ),
        (handler) =>
          accept(
            'error',
            handler.trigger === 'compensation'
              ? COMPENSATION_DUPLICATE_MESSAGE
              : handlerDuplicateMessage(handler, scope),
            { node: handler, property: 'trigger' },
          ),
      );
      // The engine refuses the later of the pair, whichever carries the code.
      const codedByKind = new Set<string>();
      const catchAllByKind = new Set<string>();
      for (const handler of siblings) {
        if (handler.trigger !== 'escalation') continue;
        const kind = catchKindOf(handler);
        const coded = payloadTextOf(handler.items) !== undefined;
        if (coded ? catchAllByKind.has(kind) : codedByKind.has(kind)) {
          accept('error', escalationCatchAllMessage(scope), {
            node: handler,
            property: 'trigger',
          });
        }
        (coded ? codedByKind : catchAllByKind).add(kind);
      }
    }
  }

  checkThrowStatement = (
    stmt: ThrowStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(stmt, accept);

    if (stmt.trigger === undefined) return;

    if (!THROW_TRIGGERS_SET.has(stmt.trigger)) {
      accept('error', throwTriggerMessage(stmt.trigger), {
        node: stmt,
        property: 'trigger',
      });
      return;
    }
    checkThrowEmitCode(stmt, 'A thrown', 'throw', accept);
    checkThrowEmitBinding(stmt, 'a thrown', accept);
  };

  checkEmitStatement = (
    stmt: EmitStatement,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(stmt, accept);

    if (stmt.trigger === undefined) return;

    if (!EMIT_TRIGGERS_SET.has(stmt.trigger)) {
      accept('error', emitTriggerMessage(stmt.trigger), {
        node: stmt,
        property: 'trigger',
      });
      return;
    }
    checkThrowEmitCode(stmt, 'An emitted', 'emit', accept);
    checkThrowEmitBinding(stmt, 'an emitted', accept);
    if (stmt.trigger === 'link') {
      this.checkLinkThrowItems(stmt, accept);
    }
  };

  /** A link throw gets no activity, so its settings and listeners parse into nothing. */
  private checkLinkThrowItems(
    stmt: EmitStatement,
    accept: ValidationAcceptor,
  ): void {
    for (const setting of configuredSettingsOf(stmt)) {
      if (!ENGINE_KEY_SET.has(setting.key)) continue;
      accept('error', linkThrowNeverRunsMessage(`Setting '${setting.key}'`), {
        node: setting,
        property: 'key',
      });
    }
    for (const listener of stmt.listeners) {
      accept(
        'error',
        linkThrowNeverRunsMessage(`The 'on ${listener.event}' listener`),
        { node: listener },
      );
    }
  }

  checkIntermediateCatchEvent = (
    catchEvent: IntermediateCatchEvent,
    accept: ValidationAcceptor,
  ): void => {
    this.checkAttributeBlock(catchEvent, accept);
    this.checkCatchTrigger(catchEvent, accept);
  };

  /**
   * Readers take the first unkeyed value, so a second is dropped silently, as is
   * the first where nothing reads it. `start S("PT30M")` is a payload missing its
   * trigger word.
   */
  checkParenValue = (value: ParenValue, accept: ValidationAcceptor): void => {
    const owner = value.$container;
    if (payloadItemOf(owner.items) !== value) {
      accept('error', SECOND_PAREN_VALUE_MESSAGE, { node: value });
      return;
    }
    const description = settingsOnlyOwnerDescription(owner);
    if (description !== undefined) {
      accept('error', settingsOnlyMessage(description), { node: value });
    }
  };

  private checkCatchTrigger(
    catchEvent: CatchHeader,
    accept: ValidationAcceptor,
  ): void {
    if (catchEvent.trigger === undefined) return;

    if (!CATCH_TRIGGERS_SET.has(catchEvent.trigger)) {
      accept('error', catchTriggerMessage(catchEvent.trigger), {
        node: catchEvent,
        property: 'trigger',
      });
      return;
    }
    if (isRaceBranch(catchEvent) && catchEvent.trigger === 'link') {
      accept('error', LINK_IN_RACE_MESSAGE, {
        node: catchEvent,
        property: 'trigger',
      });
      return;
    }

    this.checkCatchPayload(
      catchEvent,
      TRIGGER_PAYLOAD[catchEvent.trigger]!,
      accept,
    );
  }

  private checkCatchPayload(
    catchEvent: CatchHeader,
    rule: TriggerPayloadRule,
    accept: ValidationAcceptor,
  ): void {
    if (rule.code === 'required' && !payloadTextOf(catchEvent.items)) {
      accept(
        'error',
        nameRequiredMessage(
          `An awaited ${catchEvent.trigger}`,
          catchEvent.trigger,
        ),
        { node: catchEvent, property: 'trigger' },
      );
    }

    this.checkConditionPayload(catchEvent, rule, 'catch', accept);

    this.checkTimerClause(
      catchEvent,
      rule.timer,
      particleOnlyMessage("'await timer'"),
      accept,
    );
  }

  /**
   * Codes are keyed per kind; a name a step also uses stays legal, since
   * references resolve by type.
   */
  private checkCodeDecls(process: Process, accept: ValidationAcceptor): void {
    const declaredNames = new Set<string>();
    const codeOwners = new Map<string, CodeDecl>();

    for (const decl of process.decls.filter(isCodeDecl)) {
      if (decl.kind === undefined || decl.name === undefined) continue;

      if (!DECLARED_CODE_TRIGGERS.has(decl.kind)) {
        accept('error', unknownDeclarationKindMessage(decl.kind), {
          node: decl,
          property: 'kind',
        });
        continue;
      }

      this.checkCodeDeclSettings(decl, accept);

      // A repeated name is reported once; its code is still checked against a third declaration.
      if (declaredNames.has(decl.name)) {
        accept(
          'error',
          `'${decl.name}' is already declared in this process; '${decl.kind}(${decl.name})' would be ambiguous.`,
          { node: decl, property: 'name' },
        );
      } else {
        declaredNames.add(decl.name);
      }

      const code = declaredCodeOf(decl);
      if (code === undefined) continue;
      const owner = codeOwners.get(`${decl.kind}:${code}`);
      if (owner === undefined) {
        codeOwners.set(`${decl.kind}:${code}`, decl);
        continue;
      }
      if (owner.name === decl.name) continue;
      accept(
        'error',
        `${capitalize(decl.kind)} code '${code}' is already declared by '${owner.name}'; two declarations cannot share a code.`,
        { node: decl, property: 'name' },
      );
    }
  }

  private checkCodeDeclSettings(
    decl: CodeDecl,
    accept: ValidationAcceptor,
  ): void {
    const settings = settingsOf(decl.items);
    this.checkDuplicateKeys(settings, accept);
    this.checkAttributeKeys(
      settings,
      EVENT_BINDING_FIELD_SET,
      `an ${decl.kind} declaration`,
      accept,
    );

    for (const item of decl.items) {
      if (!isSetting(item)) {
        accept('error', DECLARATION_SETTINGS_ONLY_MESSAGE, { node: item });
      }
    }

    for (const setting of settings) {
      if (!EVENT_BINDING_FIELD_SET.has(setting.key)) continue;
      if (
        setting.key === EVENT_MESSAGE_FIELD &&
        !TRIGGER_PAYLOAD[decl.kind]!.message
      ) {
        accept('error', ESCALATION_NO_MESSAGE_MESSAGE, {
          node: setting,
          property: 'key',
        });
      } else if (!isLiteralString(setting.value)) {
        accept(
          'error',
          `An ${decl.kind} declaration's ${setting.key} must be a quoted string.`,
          { node: setting, property: 'value' },
        );
      } else if (setting.value.value.length === 0) {
        accept(
          'error',
          `An ${decl.kind} declaration's ${setting.key} cannot be empty.`,
          { node: setting, property: 'value' },
        );
      }
    }
  }
}

function collectExpressions(process: Process): Expr[] {
  return AstUtils.streamAst(process).filter(isExpr).toArray();
}

/** Exported so the printer can warn about an imported id. */
export function isReservedName(name: string, containerId?: string): boolean {
  return (
    RESERVED_ID_PATTERNS.some((re) => re.test(name)) ||
    (containerId !== undefined &&
      mintedTerminalRole(name, containerId) !== undefined)
  );
}

/** Its name seeds the minted start and end; a handler body's are seeded otherwise. */
function enclosingContainerName(node: NamedStatement): string | undefined {
  const container = AstUtils.getContainerOfType(
    node.$container,
    (n): n is Process | SubProcess => isProcess(n) || isSubProcess(n),
  );
  return container?.name;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function checkFencedScript(
  raw: string,
  subject: string,
  target: { node: AstNode; property: string },
  accept: ValidationAcceptor,
): void {
  const { tag, code } = splitFencedScript(raw);

  if (scriptFormatOf(tag) === undefined) {
    accept(
      'error',
      `${subject} has an unsupported language tag '${tag}'. Use ${formatWordList(Object.keys(SCRIPT_FORMAT_ALIASES))}.`,
      target,
    );
  }

  if (code.trim().length === 0) {
    accept('error', `${subject} has an empty script body.`, target);
  }
}

export function quotedCodeMessage(trigger: string, text: string): string {
  const spellable = ID_TEXT.test(text);
  const declaration = spellable
    ? `${trigger} ${text}`
    : `${trigger} <NAME>(code: ${JSON.stringify(text)})`;
  const use = spellable ? text : '<NAME>';
  return (
    `An ${trigger} code is a declared name, not quoted text. ` +
    `Declare '${declaration}' in the process header and write '${trigger}(${use})'.`
  );
}

function barewordNameMessage(trigger: string, text: string): string {
  return (
    `A ${trigger} name is the text the engine matches by name, not a declared ` +
    `name. Write '${trigger}("${text}")'.`
  );
}

function unknownTriggerMessage(word: string, legal: readonly string[]): string {
  return `Unknown event kind '${word}'; write ${formatWordList(legal)}.`;
}

/**
 * A mistyped step keyword followed by a name parses as a declaration, so the
 * message names both readings.
 */
export function unknownDeclarationKindMessage(word: string): string {
  return (
    `Unknown declaration kind '${word}'; write ` +
    `${formatWordList([...DECLARED_CODE_TRIGGERS])}, or a step keyword if a ` +
    'step was meant.'
  );
}

export function onTriggerMessage(word: string): string {
  if (word === 'conditional') {
    return CONDITIONAL_TYPO_MESSAGE;
  }
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  return unknownTriggerMessage(word, ON_TRIGGERS);
}

export function startTriggerMessage(word: string): string {
  if (word === 'error' || word === 'escalation') {
    return (
      `A process cannot start on an ${word}: the engine ignores the trigger ` +
      'and starts the process as if none were written. Catch it with ' +
      `'on ${word}' inside the scope that raises it.`
    );
  }
  if (word === 'compensation') {
    return (
      "A process cannot start on compensation: it undoes a subprocess's " +
      "completed work, so it belongs in an 'on compensation' block inside " +
      'that subprocess.'
    );
  }
  if (word === 'conditional') {
    return CONDITIONAL_TYPO_MESSAGE;
  }
  return `Unknown event kind '${word}'; a start event supports ${formatWordList(START_TRIGGERS)}.`;
}

export function alongsideMessage(trigger: string): string {
  if (trigger === 'compensation') return COMPENSATION_ALONGSIDE_MESSAGE;
  if (trigger === 'cancel') return CANCEL_ALONGSIDE_MESSAGE;
  return (
    'An error always interrupts: the handler takes over from the failed ' +
    "scope; 'alongside' is only available for escalations."
  );
}

export function endTriggerMessage(word: string): string {
  if (THROW_TRIGGERS_SET.has(word)) {
    const article = /^[aeiou]/.test(word) ? 'An' : 'A';
    return (
      `${article} ${word} is raised with 'throw', not on an end: write ` +
      `'throw ${word}' in place of this end. ` +
      END_TRIGGERS_MESSAGE
    );
  }
  if (word === 'timer') {
    return END_TIMER_MESSAGE;
  }
  if (word === 'condition' || word === 'conditional') {
    return END_CONDITION_MESSAGE;
  }
  return (
    `Unknown event kind '${word}'. ${END_TRIGGERS_MESSAGE} Every other kind ` +
    "is raised with 'throw'."
  );
}

export function startMessageExpressionMessage(name: string): string {
  return (
    `A message start name cannot contain an expression ("${name}"): the ` +
    'engine rejects one there, because a process that has not started yet ' +
    'has no variables to evaluate it against. Give the start a fixed name; ' +
    "an expression belongs on an 'on message' handler or an 'await message', " +
    'which run once the process has variables.'
  );
}

export function throwTriggerMessage(word: string): string {
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  if (word === 'cancel') {
    return CANCEL_NOT_RAISED_MESSAGE;
  }
  if (word === 'link') {
    return "A link continues at its catch rather than ending the path; write 'emit link'.";
  }
  return unknownTriggerMessage(word, THROW_TRIGGERS);
}

export function emitTriggerMessage(word: string): string {
  if (word === 'error') {
    return "An error always aborts its path; write 'throw error'.";
  }
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  if (word === 'cancel') {
    return CANCEL_NOT_RAISED_MESSAGE;
  }
  return unknownTriggerMessage(word, EMIT_TRIGGERS);
}

export function catchTriggerMessage(word: string): string {
  if (word === 'compensate') {
    return COMPENSATE_TYPO_MESSAGE;
  }
  if (word === 'cancel') {
    return CANCEL_NOT_AWAITED_MESSAGE;
  }
  return (
    `Unknown event kind '${word}'; intermediate catch supports ${formatWordList(CATCH_TRIGGERS)}. ` +
    "An error or an escalation is raised with 'throw'/'emit', compensation " +
    "is a subprocess's undo block, and a cancel is written on the end that " +
    `gives up an 'attempt' block.`
  );
}

/**
 * What a boundary event may attach to: the named statements minus the events,
 * an intermediate catch included.
 */
export function isActivityStatement(stmt: Statement): boolean {
  return (
    isNamedStatement(stmt) &&
    !isStartEvent(stmt) &&
    !isEndEvent(stmt) &&
    !isThrowStatement(stmt) &&
    !isEmitStatement(stmt) &&
    !isIntermediateCatchEvent(stmt)
  );
}

/**
 * Operaton allows an `escalation` boundary on a subprocess scope, a call
 * activity or a user task.
 */
export function isEscalationLegalHost(stmt: Statement): boolean {
  return isSubProcess(stmt) || isCallActivity(stmt) || isUserTask(stmt);
}

export function isAttemptBlock(node: AstNode | undefined): node is SubProcess {
  return node !== undefined && isSubProcess(node) && node.transactional;
}

function hasCancelEndInScope(block: SubProcess): boolean {
  for (const node of AstUtils.streamAst(block)) {
    if (
      isEndEvent(node) &&
      node.trigger === 'cancel' &&
      enclosingFlowContainer(node) === block
    ) {
      return true;
    }
  }
  return false;
}

function cancelHandlerFor(block: SubProcess): OnHandler | undefined {
  const container = enclosingFlowContainer(block);
  if (container === undefined) return undefined;
  for (const node of AstUtils.streamAst(container)) {
    if (
      isOnHandler(node) &&
      node.trigger === 'cancel' &&
      node.host?.ref === block
    ) {
      return node;
    }
  }
  return undefined;
}

function cancelHostMessage(host: Statement): string {
  return (
    `A cancel handler can only attach to an 'attempt' block: it catches ` +
    `that block being given up; '${targetStatementName(host)}' is ${describeStatementKind(host)}.`
  );
}

export function cancelEndWithoutHandlerMessage(name: string): string {
  return (
    `'${name}' gives itself up but nothing catches it: the engine stops with ` +
    `an error the first time that end is reached. Write 'on ${name}: cancel ` +
    `{ ... }' beside the block to say what happens then.`
  );
}

export function cancelHandlerWithoutEndMessage(name: string): string {
  return (
    `Nothing inside '${name}' gives it up, so this handler never runs: write ` +
    `'end <name> cancel' on the path that should give the block up, or ` +
    'remove the handler.'
  );
}

/** Callers pass only named kinds, each with a row; an `attempt` is named for its head. */
function describeStatementKind(stmt: Statement): string {
  return attributeBlockRuleOf(stmt)!.description;
}

function startTriggerInBlockMessage(block: SubProcess): string {
  const kind = describeStatementKind(block);
  return (
    `Only the process's own start carries a trigger: ${kind} is entered ` +
    'from the step before it, so its start has none. Put the trigger on an ' +
    "'on' handler inside the block if it should react to an event."
  );
}

function illegalHostMessage(host: Statement): string {
  return (
    'A boundary event can only attach to an activity: a user, service, ' +
    `script, send, or receive task, a step, a decision step, a subprocess, ` +
    `an attempt block, or a call; '${targetStatementName(host)}' is ${describeStatementKind(host)}.`
  );
}

function escalationHostMessage(host: Statement): string {
  return (
    'An escalation boundary can only attach to a subprocess, an attempt ' +
    `block, a call, or a user task; '${targetStatementName(host)}' is ` +
    `${describeStatementKind(host)}.`
  );
}

export function selfAttachedHostMessage(hostName: string): string {
  return (
    `A boundary event cannot attach to a step inside its own escape path: ` +
    `'${hostName}' only runs after this handler has already fired, so it ` +
    'can never host the event that starts that path.'
  );
}

export function hostedHandlerStartMessage(name: string): string {
  return (
    `'start ${name}' cannot open a handler that names a host: the body runs ` +
    "inside the host's own container and is entered from the boundary event, " +
    'so it is not a scope with a start of its own. Remove the start; the ' +
    'first step of the body is where the escape path begins.'
  );
}

export function noDefaultStartMessage(name: string): string {
  return (
    `Process '${name}' has no default start: with only message, signal, or ` +
    'condition starts, the engine can create an instance only by triggering ' +
    'one of them, and starting it by key fails at runtime.'
  );
}

export const FORM_NEVER_OFFERED_MESSAGE =
  "The engine offers a start form only on the process's default start, its " +
  'plain or timer start; this form is on a different start and is never ' +
  'shown.';

export const INITIATOR_SHADOWED_MESSAGE =
  'The engine keeps one initiator per process: whichever start is parsed ' +
  'last wins, so this setting is never written. Move it to the last ' +
  'start, or drop it.';

const NAME_SCOPED_TRIGGERS: ReadonlySet<string> = new Set([
  'message',
  'signal',
]);

export const HANDLER_DUPLICATE_RULE: Readonly<Record<string, string>> = {
  message:
    'Operaton keeps one message subscription per name and scope (BpmnParse.addEventSubscriptionDeclaration), so the deployment fails',
  signal:
    'Operaton keeps one signal subscription per name and scope (BpmnParse.addEventSubscriptionDeclaration), so the deployment fails',
  escalation:
    'Operaton keeps one escalation catch per code and scope (BpmnParse.addEscalationEventDefinition), so the deployment fails',
  cancel:
    'Operaton keeps one cancel handler per attempt block (BpmnParse.parseBoundaryCancelEventDefinition), so the deployment fails',
  error:
    'the engine refuses nothing here and takes the first match after sorting its handlers (BpmnParse.addErrorEventDefinition), so this surface keeps one handler per code',
};

/**
 * The host of a boundary event, or the container of an event sub-process, so a
 * handler inside `Sub` and one attached to `Sub` share a scope.
 */
function subscriptionScopeOf(handler: OnHandler): AstNode | undefined {
  return handler.host?.ref ?? enclosingFlowContainer(handler);
}

/**
 * A message or signal name is unique per scope among non-start catches, so a
 * boundary and an event sub-process collide; escalation, error and cancel
 * compare within their kind. A boundary on a repeated host subscribes on the
 * multi-instance body, one scope up.
 */
function catchKindOf(handler: OnHandler): string {
  if (handler.host?.ref === undefined) return 'body';
  if (
    NAME_SCOPED_TRIGGERS.has(handler.trigger) &&
    !isRepeated(handler.host.ref)
  ) {
    return 'body';
  }
  return 'boundary';
}

function scopeNameOf(scope: AstNode): string | undefined {
  return isProcess(scope) || isNamedStatement(scope) ? scope.name : undefined;
}

function scopePhrase(scope: AstNode): string {
  const name = scopeNameOf(scope);
  return name === undefined ? 'in this scope' : `on scope '${name}'`;
}

function handlerDuplicateMessage(handler: OnHandler, scope: AstNode): string {
  const code = payloadTextOf(handler.items);
  const caught =
    code === undefined
      ? 'every event of this kind'
      : NAME_SCOPED_TRIGGERS.has(handler.trigger)
        ? `name '${code}'`
        : `code '${code}'`;
  return `Another 'on ${handler.trigger}' handler already catches ${caught} ${scopePhrase(scope)}: ${HANDLER_DUPLICATE_RULE[handler.trigger]}.`;
}

function escalationCatchAllMessage(scope: AstNode): string {
  return `An 'on escalation' handler with no code cannot sit beside one with a code ${scopePhrase(scope)}: the code-less one would catch every escalation, and Operaton refuses the pair (BpmnParse.addEscalationEventDefinition). Give both a code, or keep one.`;
}

function checkEmptyCode(
  code: string | undefined,
  items: ParenItem[],
  accept: ValidationAcceptor,
): void {
  if (code !== undefined && code.length === 0) {
    accept('error', EMPTY_CODE_MESSAGE, {
      node: payloadItemOf(items)!,
      property: 'value',
    });
  }
}

const isFieldParameter = (param: IoParameter): boolean =>
  param.direction === FIELD_DIRECTION;

function readsExternalTask(ref: VarRef): boolean {
  return (
    ref.ref?.$refText === EXTERNAL_TASK_EL_NAME &&
    AstUtils.getContainerOfType(ref, isErrorMapping) !== undefined
  );
}

/**
 * Only the direct value of a {@link NON_VARIABLE_ATTR_KEYS} setting is text.
 * Read off the container chain alone, so it also holds for the completion's
 * untyped stand-in.
 */
export function isVariableUse(ref: VarRef): boolean {
  const container = ref.$container;
  return (
    AstUtils.getContainerOfType(ref, isVariableMapping)?.direction !== 'out' &&
    !(isSetting(container) && NON_VARIABLE_ATTR_KEYS.has(container.key)) &&
    !isCodeDecl(container?.$container) &&
    !(
      isParenValue(container) &&
      gatewayStatementRuleOf(container.$container) !== undefined
    ) &&
    !isCodePosition(ref) &&
    nameTriggerOf(ref) === undefined &&
    !readsExternalTask(ref)
  );
}

function isPriorityValue(value: Expr): boolean {
  return (
    isIntegerValue(value) ||
    isQuotedMatching(value, FORM_BOUND_TEXT) ||
    isVarRef(value) ||
    isRawExpr(value)
  );
}

function isRepeatCountValue(value: Expr): boolean {
  return (
    isLiteralInt(value) ||
    isQuotedMatching(value, NON_NEGATIVE_INT_TEXT) ||
    isVarRef(value) ||
    isRawExpr(value)
  );
}

function isVersionValue(value: Expr): boolean {
  const text = integerLiteralText(value);
  return (
    isRawExpr(value) ||
    (text === undefined
      ? isQuotedMatching(value, VERSION_TEXT)
      : VERSION_TEXT.test(text))
  );
}

/** Only a literal default is checked; anything else is evaluated at render. */
function formDefaultShape(
  field: FormField,
  hasPattern: boolean,
): string | undefined {
  const value = field.defaultValue;
  if (value === undefined || isRawExpr(value) || isVarRef(value)) {
    return undefined;
  }
  const text = value.$cstNode?.text ?? '';
  switch (field.type) {
    case 'number':
      return isIntegerValue(value) || isQuotedMatching(value, FORM_BOUND_TEXT)
        ? undefined
        : numberDefaultMessage(field.id, text);
    case 'boolean':
      return isLiteralBool(value) ||
        (isLiteralString(value) &&
          (value.value === 'true' || value.value === 'false'))
        ? undefined
        : booleanDefaultMessage(field.id, text);
    case 'date':
      return !hasPattern &&
        isLiteralString(value) &&
        ISO_DATE_ONLY_TEXT.test(value.value)
        ? isoDateDefaultMessage(field.id, value.value)
        : undefined;
    default:
      return undefined;
  }
}

function topicRefusalOf(
  rule: AttributeBlockRule,
  settings: readonly Setting[],
  item: string,
): string | undefined {
  return settings.some((attr) => attr.key === EXTERNAL_BINDING_KEY)
    ? undefined
    : topicBindingMessage(
        capitalize(rule.description),
        item,
        bindingKeysOf(settings, BUSINESS_RULE_BINDING_KEYS),
      );
}

function namesFieldBinding(attrs: readonly Setting[]): boolean {
  return attrs.some((attr) => FIELD_BINDING_KEY_SET.has(attr.key));
}

/** A literal goes to `stringValue`, an expression to a child; a list, map or script has no slot. */
function isFieldValue(value: IoValue | undefined): boolean {
  return value !== undefined && (isLiteralString(value) || isRawExpr(value));
}

function bindingKeysOf(
  attrs: readonly Setting[],
  keys: readonly string[],
): string[] {
  return [
    ...new Set(
      attrs.map((attr) => attr.key).filter((key) => keys.includes(key)),
    ),
  ];
}

function checkAtMostOneBinding(
  attrs: readonly Setting[],
  keys: readonly string[],
  subject: string,
  target: { node: AstNode; property: string },
  accept: ValidationAcceptor,
): void {
  const written = bindingKeysOf(attrs, keys);
  if (written.length > 1) {
    accept(
      'error',
      `${subject} declares more than one binding (${written.join(', ')}); exactly one of ${formatWordList(keys)} is allowed.`,
      target,
    );
  }
}

function checkThrowEmitBinding(
  stmt: ThrowStatement | EmitStatement,
  subject: 'a thrown' | 'an emitted',
  accept: ValidationAcceptor,
): void {
  const written = bindingKeysOf(settingsOf(stmt.items), THROW_BINDING_KEYS);
  if (written.length === 0) return;

  if (stmt.trigger !== THROW_BINDING_TRIGGER) {
    for (const attr of settingsOf(stmt.items)) {
      if (!written.includes(attr.key)) continue;
      accept(
        'error',
        `Setting '${attr.key}' is not valid on ${subject} ${stmt.trigger}; ` +
          'an implementation is what makes the engine really send a message, ' +
          'so only a message carries one.',
        { node: attr, property: 'key' },
      );
    }
    return;
  }

  checkAtMostOneBinding(
    settingsOf(stmt.items),
    THROW_BINDING_KEYS,
    capitalize(`${subject} ${stmt.trigger}`),
    { node: stmt, property: 'trigger' },
    accept,
  );
}

/** No throw-side catch-all, so an omitted and an empty code are the same mistake. */
function checkThrowEmitCode(
  stmt: ThrowStatement | EmitStatement,
  subject: 'A thrown' | 'An emitted',
  keyword: 'throw' | 'emit',
  accept: ValidationAcceptor,
): void {
  const code = payloadTextOf(stmt.items);
  if (stmt.trigger === 'compensation') {
    if (code !== undefined) {
      accept(
        'error',
        'Compensation undoes completed work: there is nothing to name; ' +
          `write '${keyword} compensation'.`,
        { node: payloadItemOf(stmt.items)!, property: 'value' },
      );
    }
    return;
  }
  const message = `${subject} ${stmt.trigger} names its code: '${keyword} ${stmt.trigger}(<CODE>)'.`;
  if (code === undefined) {
    accept('error', message, { node: stmt, property: 'trigger' });
  } else if (code.length === 0) {
    accept('error', message, {
      node: payloadItemOf(stmt.items)!,
      property: 'value',
    });
  }
}

function statementListOf(handler: OnHandler): Statement[] {
  const container = handler.$container;
  return isProcess(container) ? container.body : container.statements;
}

function bindingValueText(expr: Expr): string | undefined {
  if (isVarRef(expr)) {
    return expr.ref.$refText;
  }
  if (isLiteralString(expr)) {
    return expr.value;
  }
  return undefined;
}

const variableKeySpelling = (name: string) =>
  `execution.getVariable('${name}')`;

/** `order.line.is-paid` reads back `order.line['is-paid']`. */
function propertyKeySpelling(ref: VarRef, accessor: Accessor): string {
  const object =
    ref.$cstNode !== undefined && accessor.$cstNode !== undefined
      ? ref.$cstNode.text
          .slice(0, accessor.$cstNode.offset - ref.$cstNode.offset)
          .trim()
      : ref.ref.$refText;
  return `${object}['${accessor.prop}']`;
}

function checkRenderedNames(ref: VarRef, accept: ValidationAcceptor): void {
  checkRenderedName(
    ref.ref.$refText,
    variableKeySpelling(ref.ref.$refText),
    { node: ref, property: 'ref' },
    accept,
  );
  for (const accessor of ref.accessors) {
    if (accessor.prop === undefined) continue;
    checkRenderedName(
      accessor.prop,
      propertyKeySpelling(ref, accessor),
      { node: accessor, property: 'prop' },
      accept,
    );
  }
}

function checkRenderedName(
  name: string,
  key: string,
  target: { node: AstNode; property: string },
  accept: ValidationAcceptor,
): void {
  if (JUEL_RESERVED_WORD_SET.has(name)) {
    accept('error', juelKeywordMessage(name, key), target);
  } else if (name.includes('-')) {
    accept('error', hyphenNameMessage(name, key), target);
  }
}

/** A `}` inside a JUEL string literal is string text. */
const TEMPLATE_BODIES =
  /[$#]\{((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^'"}])*)\}/g;

const STRING_OR_PROPERTY_READ =
  /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\.\s*([A-Za-z_$][\w$]*)/g;

/**
 * A raw template can spell `true`/`false`/`null` as a `.prop`, which JUEL still
 * scans as literals. Text between templates is not an expression.
 */
function checkRawTemplateNames(
  raw: string,
  target: { node: AstNode; property: string },
  accept: ValidationAcceptor,
): void {
  for (const [, body] of raw.matchAll(TEMPLATE_BODIES)) {
    for (const match of body!.matchAll(STRING_OR_PROPERTY_READ)) {
      const word = match[1];
      if (word === undefined || !JUEL_RAW_TEMPLATE_WORD_SET.has(word)) continue;
      const object = /[\w$.[\]'"]*$/.exec(
        body!.slice(0, match.index).trimEnd(),
      )![0];
      accept('error', juelKeywordMessage(word, `${object}['${word}']`), target);
    }
  }
}

function conditionSlotOf(expr: Expr): ConditionSlot | undefined {
  const container = expr.$container;
  if (expr.$containerProperty === 'completion') return 'until';
  if (
    expr.$containerProperty === 'condition' &&
    (isIfStatement(container) ||
      isElseIf(container) ||
      isWhileStatement(container) ||
      isDoWhileStatement(container) ||
      isParallelBranch(container))
  ) {
    return 'condition';
  }
  // A quoted payload is already `checkConditionPayload`'s.
  if (isParenValue(container) && !isLiteralString(expr)) {
    const owner = container.$container;
    if (
      (isStartEvent(owner) ||
        isOnHandler(owner) ||
        isIntermediateCatchEvent(owner) ||
        isRaceBranch(owner)) &&
      owner.trigger === 'condition'
    ) {
      return 'condition';
    }
  }
  return undefined;
}

/** `undefined` where Boolean or unknown: accessors, undeclared names and templates. */
function nonBooleanShapeOf(
  expr: Expr,
  symbols: VariableTable,
): string | undefined {
  if (isParen(expr)) return nonBooleanShapeOf(expr.inner, symbols);
  if (isLiteralString(expr)) return 'a string';
  if (isLiteralNull(expr)) return 'null';
  if (isLiteralInt(expr) || isLiteralDecimal(expr)) return 'a number';
  if (
    isAdditive(expr) ||
    isMultiplicative(expr) ||
    (isUnary(expr) && expr.op === '-')
  ) {
    return 'an arithmetic expression';
  }
  if (isVarRef(expr) && expr.accessors.length === 0) {
    // `json` is a Spin node, which `UelExpressionCondition.evaluate` refuses as non-Boolean.
    const type = symbols.get(expr.ref.$refText)?.type;
    return type !== undefined && type !== 'boolean' && type !== 'any'
      ? `a variable of type '${type}'`
      : undefined;
  }
  if (isTernary(expr)) {
    return nonBooleanShapeOf(expr.whenTrue, symbols) !== undefined &&
      nonBooleanShapeOf(expr.whenFalse, symbols) !== undefined
      ? 'a ternary with no boolean arm'
      : undefined;
  }
  if (isRawExpr(expr) && singleTemplateBody(expr.raw) === undefined) {
    return 'text around a template, which evaluates to a string';
  }
  return undefined;
}

function findEnclosingBranch(
  node: AstNode,
): { body: Block; keyword: 'parallel' | 'await' } | undefined {
  let child: AstNode = node;
  let parent: AstNode | undefined = node.$container;
  while (parent) {
    if (isBlock(child)) {
      if (isParallelBranch(parent)) {
        return { body: child, keyword: 'parallel' };
      }
      if (isRaceBranch(parent)) {
        return { body: child, keyword: 'await' };
      }
    }
    child = parent;
    parent = parent.$container;
  }
  return undefined;
}

export function intoBranchMessage(
  subject: string,
  jump: string,
  keyword: 'parallel' | 'await',
): string {
  const article = keyword === 'await' ? 'an' : 'a';
  return `'${subject}' jumps into a branch of ${article} '${keyword}' statement from outside that branch; a branch's steps run only when the whole '${keyword}' statement is reached, not via an external '${jump}'.`;
}

export function linkThrowNeverRunsMessage(item: string): string {
  return (
    `${item} has no effect on an emitted link: the engine creates no activity ` +
    "for a link throw, so nothing written on it runs. Put it on the 'await " +
    "link' of the same name instead."
  );
}

function targetStatementName(target: Statement): string {
  return statementName(target) ?? '?';
}
