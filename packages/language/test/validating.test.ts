/**
 * Validation of the BPMNscript AST.
 *
 * A case is one source program and the complete list of diagnostics it raises,
 * in document order, so it fails both when a check stops firing and when one
 * fires that should not. A warning carries a `warning:` prefix; everything else
 * is an error, whether it comes from a check, the linker, or the parser.
 *
 * Message prose is spelled once in the catalogue below and referenced from the
 * cases, so a reworded diagnostic is one edit.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { validationHelper, type ValidationResult } from 'langium/test';
import type { Model } from '@bpmn-script/language';
import {
  createBpmnScriptServices,
  ENGINE_KEYS,
  joinSettingKey,
  JUEL_RESERVED_WORDS,
} from '@bpmn-script/language';
import {
  BLOCK_HOSTS,
  ENGINE_SETTINGS,
  engineItems,
  EXTERNAL_HOSTS,
  FENCE,
  FORM_HOSTS,
  LABEL_HOSTS,
  PARAMETER_HOSTS,
} from './helpers/block-hosts.js';
import {
  UNREACHABLE,
  undeclaredVariable as undeclared,
  withTextMessages,
} from './helpers/diagnostics.js';

const SEVERITY_WARNING = 2;

let validate: (input: string) => Promise<ValidationResult<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  validate = validationHelper<Model>(services.BpmnScript);
});

/** Every diagnostic `source` raises, as `message` or `warning: message`. */
async function diagnosticsOf(source: string): Promise<string[]> {
  const { diagnostics } = await validate(source);
  return withTextMessages(diagnostics).map((d) =>
    d.severity === SEVERITY_WARNING ? `warning: ${d.message}` : d.message,
  );
}

/** A warning's entry in an expected list; a bare message is an error. */
const warn = (message: string) => `warning: ${message}`;

type Case = [title: string, source: string, expected: string[]];

/** A concern's cases, each asserting the whole diagnostic list of its source. */
function checks(concern: string, cases: Case[]): void {
  describe(concern, () => {
    test.each(cases)('%s', async (_title, source, expected) => {
      expect(await diagnosticsOf(source)).toEqual(expected);
    });
  });
}

const capitalized = (text: string) => text[0]!.toUpperCase() + text.slice(1);

/**
 * One row per `(setting, field type)` pair, each a field `f` of that type
 * carrying the setting alone. An enum gets a value so its own empty-values
 * warning stays out of the list.
 */
function formFieldRows(
  concern: string,
  pairs: Array<[setting: string, type: string, expected: string[]]>,
): Case[] {
  return pairs.map(([setting, type, expected]) => [
    `${concern}: ${setting} on ${type}`,
    `process p { start S { form { f: ${type} (${setting})${type === 'enum' ? ' { a }' : ''} } } }`,
    expected,
  ]);
}

// ── The messages, each spelled once ─────────────────────────────────────────

const typeMismatch = (
  name: string,
  type: string,
  context: string,
  op: string,
) =>
  `Variable '${name}' of type '${type}' cannot be used in ${context} (operator '${op}').`;
const juelKeyword = (word: string, key: string) =>
  `'${word}' is a JUEL keyword (Scanner.addKeyToken), so the engine refuses any expression naming it. Reach the variable through a string key instead: "\${${key}}".`;
const hyphenName = (name: string, key: string) =>
  `'${name}' carries a hyphen, which JUEL scans as a minus (Scanner.nextIdentifier), so the engine reads a subtraction. Reach the variable through a string key instead: "\${${key}}".`;
const nonBooleanCondition = (shape: string) =>
  `A condition must be boolean, but this one is ${shape}: the engine throws 'condition expression returns non-Boolean' when it evaluates it (UelExpressionCondition.evaluate).`;
const nonBooleanUntil = (shape: string) =>
  `An 'until' condition must be boolean, but this one is ${shape}: the engine throws when a completion condition evaluates to anything else (MultiInstanceActivityBehavior.completionConditionSatisfied).`;
const COMPOSITE_OPERAND =
  "A composite template cannot be spliced into the surrounding expression: JUEL has no '${' token once inside an expression (Scanner.nextEval), so only a raw that is exactly one '${...}' with no '}' outside a string literal in its body can be an operand. Write the whole expression as one raw template instead.";
const DEAD_LOOP =
  "This loop can never repeat: every path through the 'do' body ends or redirects the flow, so the condition is never evaluated and the loop gateway would lower to a disconnected node with no incoming flow, which is invalid BPMN. End after the loop, or keep one path through the body.";
const ONE_PROCESS_ONLY =
  'Only one process is supported per file. ' +
  'Move additional processes into separate files.';
const noFlowSteps = (name: string) =>
  `Process '${name}' has no flow steps: a process needs at least one step on its main flow (handlers alone do not start a process).`;
const blockNoFlowSteps = (kind: string, name: string) =>
  `${capitalized(kind)} named '${name}' has no flow steps: ${kind} needs at least one step on its main flow (handlers alone do not start it).`;
/** The shapes are derived from the patterns, so this pins the pair. */
const RESERVED_SHAPES =
  `'Gateway_..._(split|join|fork|loop|race)', 'Flow_..._...', 'Throw_', ` +
  `'EventSubProcess_', 'Boundary_', 'Catch_', 'EndEvent_Boundary_', ` +
  `'StartEvent_EventSubProcess_', 'EndEvent_EventSubProcess_', '_di', ` +
  `'BPMNDiagram_', and 'BPMNPlane_'`;
const reservedName = (name: string) =>
  `Statement name '${name}' matches a reserved synthesized-id pattern. ` +
  `Prefixes ${RESERVED_SHAPES} are reserved for ids the desugarer or the ` +
  'layouter generates.';
const mintedTerminal = (name: string, role: string, container: string) =>
  `Statement name '${name}' is the id the compiler generates for the ` +
  `implicit ${role} event of '${container}'; choose another name.`;
const duplicateVariable = (name: string, process: string) =>
  `Variable '${name}' is already declared in process '${process}'.`;
const duplicateStepName = (name: string, process: string) =>
  `Step name '${name}' is already used by another step in process '${process}'; 'goto ${name}' would be ambiguous.`;
const stepNameEqualsProcess = (name: string) =>
  `Step name '${name}' equals the process id; the compiled document can hold only one element with that id.`;
const catchBindingTypeClash = (name: string, prior: string) =>
  `Catch-binding variable '${name}' is typed 'string', but '${name}' is already declared as '${prior}'; the types must agree.`;
const formFieldTypeClash = (id: string, type: string, prior: string) =>
  `Form field '${id}' is typed '${type}', but '${id}' is already declared as '${prior}'; the types must agree.`;

// Element settings.

const duplicateSetting = (key: string) => `Duplicate setting '${key}'.`;
const notValidOn = (key: string, description: string) =>
  `Setting '${key}' is not valid on ${description}.`;
const flagNotValidOn = (flag: string, description: string) =>
  `Flag '${flag}' is not valid on ${description}.`;
const loopJoinKey = (key: string, description: string, base: string) =>
  `Setting '${key}' is not valid on ${description}: a loop has one gateway, so write '${base}'.`;
const settingsOnly = (description: string) =>
  `The parens of ${description} take only settings, written 'key: value'.`;
const AWAIT_ASYNC_AFTER =
  "Setting 'asyncAfter' is not valid on an await block: Operaton refuses it " +
  'on an event-based gateway (BpmnParse.parseEventBasedGateway). Write it on ' +
  'the branch triggers instead.';
const prunedJoin = (statement: string, key: string) =>
  `Every branch of this ${statement} ends its path, so there is no join for '${key}' to set; the setting has no effect.`;
const bindingNotAName = (field: string) =>
  `A catch binding names the variable the caught ${field} lands in, not a ` +
  `value: write '${field}: <name>'.`;
const barewordName = (trigger: string, text: string) =>
  `A ${trigger} name is the text the engine matches by name, not a declared ` +
  `name. Write '${trigger}("${text}")'.`;
const quotedBoolean = (key: string) =>
  `Setting '${key}' takes an unquoted boolean; ` +
  `write '${key}: true' or '${key}: false'.`;
const unquotedText = (key: string) =>
  `Setting '${key}' takes a quoted string or a "\${...}" expression; ` +
  'put the value in quotes.';
const SERVICE_BINDINGS = `'class', 'expression', 'delegate', 'topic', or 'type'`;
const DECISION_BINDINGS = `'class', 'expression', 'delegate', 'topic', 'type', or 'decision'`;
/** A thrown message has no member block for the fields a built-in behaviour needs. */
const THROW_BINDINGS = `'class', 'expression', 'delegate', or 'topic'`;
const LISTENER_BINDINGS = `'class', 'expression', or 'delegate'`;
const TYPE_VALUE = `Setting 'type' must be 'mail' or 'shell'.`;
const missingBuiltinField = (
  subject: string,
  type: string,
  names: string,
  error: string,
  method: string,
) =>
  `${subject} binds type: "${type}" without a ${names} field; Operaton refuses to deploy it: "${error}" (BpmnParse.${method}).`;
const MAIL_FIELDS = 'to, from, cc, bcc, subject, text, html, and charset';
const SHELL_FIELDS =
  'command, wait, arg1, arg2, arg3, arg4, arg5, outputVariable, errorCodeVariable, redirectError, cleanEnv, and directory';
const unknownBuiltinField = (
  name: string,
  type: string,
  behaviour: string,
  declared: string,
) =>
  `Field '${name}' is not one a ${type} task takes; the engine sets it on ${behaviour}, which declares ${declared} (ClassDelegateUtil.applyFieldDeclaration).`;
const shellFieldExpression = (name: string) =>
  `Field '${name}' on a shell task takes a quoted literal: Operaton reads every shell field as a fixed value (BpmnParse.validateFieldDeclarationsForShell) and fails the deployment on an expression.`;
const shellFlagValue = (name: string) =>
  `Field '${name}' on a shell task takes "true" or "false"; the engine reads any other spelling as false (ShellActivityBehavior.readFields).`;
const runWithoutClause = (key: string, description: string, base: string) =>
  `Setting '${key}' is not valid on ${description} that does not repeat: it makes one job per run, so write a 'for' clause, or '${base}' for one job around the step.`;
const RUN_JOB_PRIORITY =
  "Setting 'runJobPriority' does not exist: Operaton reads a job priority off " +
  "the step alone (BpmnParse.createActivityOnScope), so 'jobPriority' applies " +
  "to every run's job.";
const noJob = (key: string, pairing: string, description: string) =>
  `Setting '${key}' on ${description} configures no job: Operaton creates ` +
  `one only when ${pairing} is also set ` +
  '(BpmnParse.parseAsynchronousContinuation, DefaultFailedJobParseListener.parseActivity).';
const noPerRunJob = (key: string, pairing: string, description: string) =>
  `Setting '${key}' on ${description} prices the per-run job Operaton ` +
  'creates in the multi-instance body (BpmnParse.parseActivity), which ' +
  `exists only when ${pairing} is also set.`;
const REPEAT_COUNT =
  'A repeat count must be a non-negative whole number, a variable, or a ' +
  '"${...}" expression yielding one; the engine reads a constant as text ' +
  'with Integer.parseInt and truncates any other number with intValue() ' +
  '(MultiInstanceActivityBehavior.resolveLoopCardinality).';
const emptyBinding = (key: string, noun: string) =>
  `Setting '${key}' cannot be empty; name the ${noun}.`;
const literalElBinding = (key: string, effect: string) =>
  `Setting '${key}' takes a "\${...}" template or a bare name, never quoted text: ${effect}. Write '${key}: "\${...}"' or '${key}: <name>'.`;
const NO_DELEGATE = 'a string resolves to no delegate to run';
const EVALUATES_ITSELF = 'the string evaluates to itself and runs nothing';
const templateAsClass = (key: string, alternative: string) =>
  `Setting '${key}' takes a class name, loaded as written (ClassDelegateUtil.instantiateDelegate); a "\${...}" template there is not evaluated. Write '${key}: com.example.X', or '${alternative}: "\${bean}"' to resolve one at runtime.`;
const bindingRequired = (subject: string, keys: string, alternative = '') =>
  `${subject} must declare a ${keys} setting${alternative}.`;
const bindingConflict = (subject: string, written: string, keys: string) =>
  `${subject} declares more than one binding (${written}); exactly one of ${keys} is allowed.`;
const resultVariableBinding = (
  subject: string,
  binding: string,
  element: string,
  attribute: string,
) =>
  `${subject} cannot carry 'resultVariable' beside '${binding}': the engine refuses to deploy it ('resultVariableName' not supported for ${element} elements using '${attribute}'); bind with 'expression' to store the return value, or drop it.`;
const MAP_DECISION_RESULT =
  `Setting 'mapDecisionResult' must be 'singleEntry', 'singleResult', ` +
  `'collectEntries', or 'resultList'.`;
const resultVariableUnread = (binding: string) =>
  `Setting 'resultVariable' has no effect beside '${binding}': the engine hands it to an 'expression' binding alone (BpmnParse.parseServiceTaskLike), so nothing writes the variable.`;
const MAP_DECISION_RESULT_UNREAD =
  "Setting 'mapDecisionResult' has no effect without 'resultVariable': the engine applies the mapping only when storing the result into that variable (DecisionEvaluationUtil.evaluateDecision).";
const decisionModifierWithoutDecision = (key: string) =>
  `Setting '${key}' stands only beside 'decision': the engine reads 'binding', 'version' and 'mapDecisionResult' on a step answering a decision table alone (BpmnParse.parseBusinessRuleTask).`;
const VERSION_SHAPE =
  `Setting 'version' takes a positive whole number, quoted or not, or a "\${...}" expression yielding one; ` +
  'the engine parses the value as an integer when the step runs (BaseCallableElement.getVersion, TaskEntity.initializeFormRefFromTaskDefinition) and fails the instance on anything else.';
const dueDateShape = (key: string) =>
  `Setting '${key}' takes a period starting with 'P' or an ISO date-time such as "2026-01-01T09:00:00", or a "\${...}" expression; ` +
  'the engine parses a constant with DueDateBusinessCalendar.resolveDuedate when the task is created and fails the instance on anything else.';
const RETRY_CYCLE_SHAPE =
  "Setting 'retryCycle' takes an ISO 8601 duration, an 'R<n>/<duration>' repeat, or a comma " +
  'list of durations; a single interval the engine cannot read is logged and dropped, so the ' +
  'job keeps its default retries (ParseUtil.parseRetryIntervals), and a bad member of a list ' +
  'is stored unchecked and, when its turn comes, drops that retry to the default strategy ' +
  'with no wait (DefaultJobRetryCmd.execute).';
const USER_PRIORITY_SHAPE =
  `Setting 'priority' takes an integer or a "\${...}" expression; ` +
  'the engine parses a constant with Integer.parseInt when the task is created (TaskDecorator.initializeTaskPriority) and fails the instance on anything else.';

// The process header.

const HISTORY_TIME_TO_LIVE_SHAPE =
  "Setting 'historyTimeToLive' takes a quoted number of days, 'P<n>D' or '<n>'; " +
  'the engine reads the attribute as text, never as an expression, and refuses to deploy anything else (ParseUtil.parseHistoryTimeToLive).';
const VERSION_TAG_LITERAL =
  "Setting 'versionTag' takes a quoted string; the engine stores the tag as written, never evaluated (BpmnParse.parseProcess).";
const VERSION_TAG_LENGTH =
  "Setting 'versionTag' is longer than 64 characters, the width of the column it is stored in (ACT_RE_PROCDEF.VERSION_TAG_), so the deployment fails.";
const candidateStarterTemplate = (key: string) =>
  `Setting '${key}' takes ids as written: the engine stores each entry as a candidate identity link without evaluating it (BpmnDeployer.addAuthorizations), so a "\${...}" template names the id spelled by its text.`;
const headerLiteral = (key: string) =>
  `Setting '${key}' takes a quoted string on a process header; the engine stores it as written, never evaluated (BpmnParse.parseProcess).`;

// Forms.

const noFormBlock = (description: string) =>
  `${capitalized(description)} cannot declare a 'form' block; forms belong on start events and user tasks.`;
const oneFormBlock = (description: string) =>
  `${description} may declare at most one 'form' block.`;
const duplicateFormField = (id: string) => `Duplicate form field '${id}'.`;
const formFieldType = (id: string, type: string) =>
  `Form field '${id}' has type '${type}', which a form cannot use. Use string, number, boolean, date, or enum.`;
const FORM_FIELD_SETTINGS = `'required', 'readonly', 'min', 'max', 'minlength', 'maxlength', 'validator', or 'pattern'`;
const formFieldSettingsOnly = (id: string, text: string) =>
  `Form field '${id}' takes 'key: value' settings in its parens; '${text}' is not one.`;
const unknownFormFieldSetting = (id: string, key: string) =>
  `Unknown form field setting '${key}' on '${id}'; write ${FORM_FIELD_SETTINGS}.`;
const constraintMisfit = (
  name: string,
  id: string,
  type: string,
  fits: string,
) =>
  `Constraint '${name}' fits a ${fits} field, not the ${type} field '${id}': the engine checks a submitted ${fits} alone and fails every other submission.`;
const patternMisfit = (id: string, type: string) =>
  `Setting 'pattern' is the date pattern a 'date' field is parsed with; '${id}' is a ${type} field, which the engine reads no pattern off.`;
const flagFalse = (key: string) =>
  `A field is ${key} only while the setting is written, so '${key}: false' says nothing; leave the setting out.`;
const flagNotTrue = (key: string) =>
  `Setting '${key}' takes the literal true; write '${key}: true'.`;
const integerBound = (key: string) =>
  `Setting '${key}' takes an integer literal or a quoted integer such as "-5".`;
const PATTERN_VALUE = `Setting 'pattern' takes a non-empty quoted date pattern such as "dd/MM/yyyy".`;
const PATTERN_LETTERS =
  "Setting 'pattern' may hold only SimpleDateFormat letters " +
  '(G, y, Y, M, L, w, W, D, d, F, E, u, a, H, k, K, h, m, s, S, z, Z, X), ' +
  'quoted literal runs, and non-letters; the engine builds a java.text.SimpleDateFormat ' +
  'from it and throws on any other letter (DateFormType).';
const VALIDATOR_EMPTY =
  "Setting 'validator' cannot be empty; name the class or the expression it " +
  'resolves (FormValidators.createValidator).';
const valuesOnNonEnum = (id: string, type: string) =>
  `Value lines belong on an 'enum' field; '${id}' is a ${type} field.`;
const emptyEnum = (id: string) =>
  `Enum field '${id}' offers no values, so the engine rejects every submitted value; add a value line such as 'basic "Basic"'.`;
const duplicateValue = (id: string) => `Duplicate value '${id}'.`;
const enumDefault = (id: string, value: string, ids: string) =>
  `The default "${value}" of enum field '${id}' names none of its values; write ${ids}.`;
const numberDefault = (id: string, text: string) =>
  `The default ${text} of number field '${id}' is not an integer; the engine ` +
  'converts it with Long.valueOf every time the form renders (LongFormType.convertValue) ' +
  'and throws on anything else.';
const booleanDefault = (id: string, text: string) =>
  `The default ${text} of boolean field '${id}' is not "true" or "false"; the engine ` +
  'reads any other spelling as false (BooleanFormType.convertValue).';
const isoDateDefault = (id: string, value: string) =>
  `The default "${value}" of date field '${id}' is an ISO date, but the engine's default ` +
  'pattern is "dd/MM/yyyy" (ProcessEngineConfigurationImpl.initFormTypes); add a \'pattern\' ' +
  'setting, or write the date to fit it.';
const formFieldDirection = (id: string, direction: string, isEnum = false) =>
  `Unknown member direction '${direction}' in form field '${id}': its block takes 'property <key> = "<value>"' lines${isEnum ? ' and value lines' : ''}.`;
const propertyValue = (name: string) =>
  `Property '${name}' takes a quoted string or a "\${...}" expression; ` +
  'put the value in quotes.';

// Parameters and listeners.

const PARAMETER_HOSTS_SENTENCE =
  'parameters belong on a user task, a service task, a script task, a step, ' +
  'a send task, a receive task, a decision step, a subprocess, a call, and ' +
  'an attempt block.';
const noParameters = (description: string) =>
  `${capitalized(description)} cannot declare an 'input' or 'output' parameter; ${PARAMETER_HOSTS_SENTENCE}`;
const unknownDirection = (word: string, legal = `'input' or 'output'`) =>
  `Unknown parameter direction '${word}'; write ${legal}.`;
const duplicateParameter = (direction: string, name: string) =>
  `Duplicate '${direction}' parameter '${name}'.`;
const FIELD_HOSTS_SENTENCE =
  'an injected field belongs on a service task, a send task, a decision ' +
  'step, and on a listener.';
const noFields = (description: string) =>
  `${capitalized(description)} cannot declare a 'field' parameter; ${FIELD_HOSTS_SENTENCE}`;
const fieldBinding = (subject: string, written?: string) =>
  `${subject} carries an injected field only under a 'class', 'delegate', or 'type' ` +
  'binding: the engine injects into the class, the delegate, or the built-in ' +
  'behaviour that binding names' +
  (written === undefined
    ? '.'
    : `, and the binding written with '${written}' receives none.`);
/** A listener binds no `type`, so its refusal names the two it can write. */
const listenerFieldBinding = (subject: string, written: string) =>
  `${subject} carries an injected field only under a 'class' or 'delegate' ` +
  'binding: the engine injects into the class or the delegate that binding ' +
  `names, and the binding written with '${written}' receives none.`;
const scriptListenerField = (subject: string) =>
  `${subject} runs a fenced script, which the engine hands no field list; ` +
  "remove the script and bind the listener with 'class' or 'delegate' " +
  'to inject one.';
const fieldValue = (name: string) =>
  `Field '${name}' takes a quoted string or a "\${...}" expression; ` +
  'put the value in quotes.';
const escapedFieldLiteral = (name: string) =>
  `Field '${name}' cannot carry quoted text opening with '\${' or '#{': the expression slot is picked by that opening, so the text would be evaluated rather than injected as written. Drop the backslash to write an expression.`;
const emptyField = (name: string) =>
  `Field '${name}' cannot be empty: the engine reads an empty value as absent, so the ` +
  'field declares neither a fixed value nor an expression and the deployment fails ' +
  `(BpmnParse.parseFieldDeclaration). Write '\${""}' for an actual empty string.`;
const REPEATED_OUTPUT =
  "A repeated step cannot map an 'output' parameter: the engine refuses to " +
  'deploy it (BpmnParse.checkActivityOutputParameterSupported). Move the ' +
  'mapping to a step after the repetition.';
const EMPTY_MAP_KEY =
  "A map entry's key cannot be empty; name the key its value is looked up by.";
const EMPTY_STRING_VALUE =
  'An empty or blank string writes no value at all: the engine trims it and ' +
  'reads it as absent rather than as an empty string (BpmnParseUtil.getElValueProvider). ' +
  'Write \'${""}\' for an actual empty string.';
const taskListenerOnly = (event: string, description: string) =>
  `'on ${event}' is a task listener, which only a user task has; ` +
  `${description} takes 'start' or 'end'.`;
const unknownListenerEvent = (event: string, events: string) =>
  `Unknown listener event '${event}'; write ${events}.`;
const USER_LISTENER_EVENTS = `'start', 'end', 'create', 'assignment', 'complete', 'update', 'delete', or 'timeout'`;
const LISTENER_PARTICLE_ONLY = "Only 'on timeout' takes a particle.";

// The extras of a step handed to an external worker.

const EXTERNAL_HOSTS_SENTENCE =
  "a service task, a send task, or a decision step bound with 'topic'";
const topicBinding = (subject: string, item: string, written?: string) =>
  `${subject} carries ${item} only under a 'topic' binding: the engine reads it for a step handed to an external worker` +
  (written === undefined
    ? '.'
    : `, and the binding written with '${written}' hands the step to none.`);
const noPropertyHost = (description: string) =>
  `${capitalized(description)} cannot declare a 'property' line; a property line belongs on ${EXTERNAL_HOSTS_SENTENCE}, and in a form field's block.`;
const noMappingHost = (description: string) =>
  `${capitalized(description)} cannot map a reported failure; an 'error <Code> when <condition>' line belongs on ${EXTERNAL_HOSTS_SENTENCE}, whose external worker is what reports one.`;
const MAPPING_HEAD =
  'An external task maps a reported failure onto an error and nothing else; ' +
  "write 'error <Code> when <condition>'.";
const MAPPING_WHEN =
  "Write 'when' between the code and the condition: 'error <Code> when <condition>'.";
const priorityShape = (key: string) =>
  `Setting '${key}' takes an integer or a "\${...}" expression; the engine refuses to deploy a constant that is not an integer.`;
const codeNotDeclared = (trigger: string, name: string) =>
  `'${name}' is not declared. Add '${trigger} ${name}' to the process.`;

// Fenced scripts.

const unsupportedScriptTag = (subject: string, tag: string) =>
  `${subject} has an unsupported language tag '${tag}'. ` +
  "Use 'juel', 'js', 'javascript', 'ecmascript', 'groovy', 'py', 'python', " +
  "'rb', 'ruby', or 'feel'.";
const emptyScript = (subject: string) => `${subject} has an empty script body.`;
const unterminatedScript = (name: string) =>
  `Script task '${name}' has a malformed or unterminated fenced script body; ` +
  'a script must be a closed ```<lang> ... ``` block.';

/**
 * `juel` (the engine's own default), a mixed-case alias, and `ecmascript`
 * resolve the same as their canonical spelling; every other tag is refused,
 * `ScriptingEngines.getScriptEngineForLanguage` lowercasing the language
 * before it looks an engine up.
 */
const SCRIPT_TAG_MATRIX: ReadonlyArray<
  readonly [tag: string, refused: boolean]
> = [
  ['juel', false],
  ['JavaScript', false],
  ['ecmascript', false],
  ['cobol', true],
];

function scriptTagCases(
  buildSource: (tag: string) => string,
  subject: string,
): Case[] {
  return SCRIPT_TAG_MATRIX.map(([tag, refused]) => [
    `${subject} ${refused ? 'refuses' : 'accepts'} the '${tag}' tag`,
    buildSource(tag),
    refused ? [unsupportedScriptTag(subject, tag)] : [],
  ]);
}

// Control flow.

const emptyBranch = (what: string) => `The ${what} has no steps.`;
const emptyNumberedBranch = (index: number, keyword: string) =>
  `Branch ${index} of the '${keyword}' statement has no steps.`;
const emptyLoopBody = (keyword: string) =>
  `The '${keyword}' body has no steps, so the loop and its condition would be dropped: with nothing to loop over, the gateway keeps only its exit and the condition is never written. Put a step in the body, or remove the loop.`;
const blockMember = (what: string, verb: string) =>
  `${what} written inside a body belongs to nothing and is dropped: put it in the attribute block of the element it ${verb}, the braces before that element's body.`;
const blockParameter = (direction: string) =>
  blockMember(`An '${direction}' parameter`, 'configures');
const BLOCK_LISTENER = blockMember('A listener', 'observes');
const PARALLEL_SECOND_ELSE =
  "A 'parallel' statement takes one 'else' branch at most; the first one " +
  'already runs when no condition held. Fold this branch into it or give it a ' +
  'condition.';
const PARALLEL_ELSE_WITHOUT_CONDITION =
  "An 'else' branch needs a sibling branch with a condition: with no condition " +
  'anywhere every branch runs, so there is nothing to fall back from. Give a ' +
  "sibling a condition, or drop the 'else'.";
const PARALLEL_ELSE_BESIDE_UNCONDITIONED =
  "An 'else' branch runs only when no sibling branch was taken, and a branch " +
  'with no condition is always taken, so this one could never run. Give every ' +
  "sibling a condition, or drop the 'else'.";
const intoBranch = (
  subject: string,
  jump: string,
  keyword: 'parallel' | 'await',
) =>
  `'${subject}' jumps into a branch of ${keyword === 'await' ? 'an' : 'a'} '${keyword}' statement from outside that branch; a branch's steps run only when the whole '${keyword}' statement is reached, not via an external '${jump}'.`;
const gotoIntoBranch = (target: string, keyword: 'parallel' | 'await') =>
  intoBranch(`goto ${target}`, 'goto', keyword);
const unresolvedStatement = (name: string) =>
  `Could not resolve reference to Statement named '${name}'.`;
const reservedWord = (word: string) =>
  `'${word}' is a reserved word and cannot be used as a plain name here. ` +
  `To refer to a variable named '${word}', write it as a quoted raw expression: "\${${word}}".`;

// Calls.

const CALL_PROCESS_REQUIRED =
  'A call must name the process it starts: add process: "<id>".';
const BINDING_VALUE = `Setting 'binding' must be 'latest' or 'deployment'.`;
const BINDING_IS_VERSION = `Write 'version: <number>' instead of 'binding: version'.`;
const bindingVersionClash = (subject: string) =>
  `${subject} cannot combine 'binding' and 'version'; use 'version: <number>' to pin a specific version, or 'binding: latest'/'binding: deployment' for the other modes.`;
const FORM_KEY_AND_REF =
  "A user task names its form with 'formKey' or with 'formRef', never both; " +
  'the engine refuses to deploy a task carrying the two.';
const FORM_REF_NEEDS_BINDING =
  "A 'formRef' needs the binding resolving it: add 'binding: latest', " +
  "'binding: deployment', or 'version: <number>'. The engine refuses to " +
  'deploy a form reference with none.';
const FORM_REF_MISSING =
  "'binding' and 'version' pin which deployed version of a form the engine " +
  "resolves, so neither stands without a 'formRef'.";
const duplicateMapping = (direction: string, target: string) =>
  `Duplicate '${direction}' mapping target '${target}'.`;
const duplicateAllMapping = (direction: string) =>
  `Duplicate '${direction} *' mapping; a direction can copy every variable only once.`;

// Start events.

const startNotFirst = (name: string) =>
  `'start ${name}' must be a top-level statement of its process, or the ` +
  'first statement of its subprocess, attempt block, or event-handler body. ' +
  'A start event cannot have incoming flows.';
const startAfterLiveChain = (name: string) =>
  `'start ${name}' opens an entry of its own and takes no incoming flow, ` +
  'but the statement before it still flows on to it. Close that flow first ' +
  "(with 'end', 'throw', or 'goto') or move the start ahead of that step.";
const noDefaultStart = (name: string) =>
  `Process '${name}' has no default start: with only message, signal, or ` +
  'condition starts, the engine can create an instance only by triggering ' +
  'one of them, and starting it by key fails at runtime.';
const FORM_NEVER_OFFERED =
  "The engine offers a start form only on the process's default start, its " +
  'plain or timer start; this form is on a different start and is never ' +
  'shown.';
const INITIATOR_SHADOWED =
  'The engine keeps one initiator per process: whichever start is parsed ' +
  'last wins, so this setting is never written. Move it to the last ' +
  'start, or drop it.';
const SECOND_DEFAULT_START =
  'A process takes one plain or timer start: Operaton refuses a second one ' +
  '(BpmnParse.selectInitial), so the deployment fails. Keep one, or give ' +
  'this start a message, signal, or condition trigger.';
const START_AFTER_IMPLICIT_START =
  'A body that does not open with a start gets a plain start of its own, ' +
  "so this is the process's second plain or timer start, which Operaton " +
  'refuses (BpmnParse.selectInitial), so the deployment fails. Open the ' +
  'body with this start, or give it a message, signal, or condition trigger.';
const duplicateNamedStart = (trigger: string, name: string) =>
  `Another start already subscribes to ${trigger} '${name}': Operaton keeps one ${trigger} start subscription per name and process (BpmnParse.addEventSubscriptionDeclaration), so the deployment fails.`;
const duplicateConditionStart = (text: string) =>
  `Another start already carries the condition '${text}': Operaton keeps one conditional start per condition text and process (BpmnParse.addEventSubscriptionDeclaration), so the deployment fails.`;
const NESTED_START_FORM =
  'A start inside a subprocess, attempt block, or handler body takes no ' +
  "form: the engine reads a start form off the process's own start alone " +
  '(BpmnParse.parseStartFormHandlers) and BpmnParse.parseScopeStartEvent ' +
  'reads none, so this form is never shown.';
const NESTED_START_INITIATOR =
  'A start inside a subprocess, attempt block, or handler body takes no ' +
  "'initiator': the engine reads it off the process's own start alone " +
  '(BpmnParse.parseProcessDefinitionStartEvent) and ' +
  'BpmnParse.parseScopeStartEvent reads none, so nothing is written.';
/** The three scopes a nested start opens, each wrapping one body. */
const NESTED_START_CONTAINERS: ReadonlyArray<
  [kind: string, wrap: (body: string) => string]
> = [
  ['a subprocess', (body) => `process p { subprocess S { ${body} } }`],
  ['an attempt block', (body) => `process p { attempt S { ${body} } }`],
  [
    'a handler body',
    (body) => `process p { error X user T on error(X) { ${body} } }`,
  ],
];
const timerJobKeyTwice = (key: string) =>
  `Setting '${key}' is already written on the 'on timer' head, and both land on this start event, the element the engine reads the timer job's settings from (BpmnParse.parseTimer, DefaultFailedJobParseListener.parseStartEvent); keep one.`;
const hostedHandlerStart = (name: string) =>
  `'start ${name}' cannot open a handler that names a host: the body runs ` +
  "inside the host's own container and is entered from the boundary event, " +
  'so it is not a scope with a start of its own. Remove the start; the first ' +
  'step of the body is where the escape path begins.';
const startTriggerInBlock = (kind: string) =>
  `Only the process's own start carries a trigger: ${kind} is entered from ` +
  'the step before it, so its start has none. Put the trigger on an ' +
  "'on' handler inside the block if it should react to an event.";
const START_TRIGGER_IN_HANDLER =
  "The start of an event-handler body carries no trigger; the handler's own " +
  "'on <kind>' is what it catches.";
const startRaisedKind = (word: string) =>
  `A process cannot start on an ${word}: the engine ignores the trigger and ` +
  'starts the process as if none were written. Catch it with ' +
  `'on ${word}' inside the scope that raises it.`;
const START_COMPENSATION =
  "A process cannot start on compensation: it undoes a subprocess's " +
  "completed work, so it belongs in an 'on compensation' block inside that " +
  'subprocess.';
const START_CONDITION_REQUIRED =
  "A condition start needs its condition: 'start S condition(amount > 100)'.";
const START_CONDITION_NO_CODE =
  "A condition start takes no code string; write the condition itself: 'start S condition(amount > 100)'.";
const START_CONDITION_ONLY =
  'Only a condition start takes a condition expression.';
const unknownStartKind = (word: string) =>
  `Unknown event kind '${word}'; a start event supports 'message', 'signal', 'timer', or 'condition'.`;
const startNameRequired = (trigger: string) =>
  `A ${trigger} start needs the ${trigger}'s name: the engine matches ${trigger}s by name.`;
const startMessageExpression = (name: string) =>
  `A message start name cannot contain an expression ("${name}"): the engine ` +
  'rejects one there, because a process that has not started yet has no ' +
  'variables to evaluate it against. Give the start a fixed name; an ' +
  "expression belongs on an 'on message' handler or an 'await message', " +
  'which run once the process has variables.';
const START_PARTICLE_ONLY = 'Only a timer start takes a particle.';

// Timers.

const TIMER_PAYLOAD =
  `A timer needs to know how to read the time: write 'timer("PT1H")', ` +
  `'timer(at: "2026-08-01T09:00:00")', or 'timer(every: "R/PT10M")'.`;
const LISTENER_TIMER_PAYLOAD =
  `A timer needs to know how to read the time: write 'after "PT1H"', ` +
  `'at "2026-08-01T09:00:00"', or 'every "R/PT10M"'.`;
const unknownParticle = (word: string) =>
  `Unknown timer particle '${word}'; write 'after', 'at', or 'every'.`;
const timerShape = (particle: string, expected: string, calendar: string) =>
  `'${particle}' takes ${expected}; the engine reads it as text and fails when it does not fit (${calendar}).`;
const AFTER_SHAPE = timerShape(
  'after',
  'an ISO 8601 duration such as "PT1H", on its own or beside a start or end date-time ("2026-01-01T00:00:00/PT1H", "PT1H/2026-12-31T00:00:00")',
  'DurationBusinessCalendar.resolveDuedate',
);
const AT_SHAPE = timerShape(
  'at',
  'an ISO date-time such as "2026-08-01T09:00:00", or a duration counted from now',
  'DueDateBusinessCalendar.resolveDuedate',
);
const EVERY_SHAPE = timerShape(
  'every',
  'an ISO 8601 repeat such as "R/PT10M", or a six-field cron expression or one of its nicknames such as "@daily"',
  'CycleBusinessCalendar.resolveDuedate',
);
const REPEATING_INTERRUPTS =
  'A repeating timer that interrupts its scope fires at most once: ' +
  "add 'alongside' to let it repeat, or give it a duration instead.";

// End events.

const END_TRIGGERS_SENTENCE =
  "An end event carries 'terminate', which stops every running path in this " +
  `scope, or 'cancel', which gives up the 'attempt' block it sits in.`;
const endRaisedKind = (word: string, article: 'A' | 'An') =>
  `${article} ${word} is raised with 'throw', not on an end: write ` +
  `'throw ${word}' in place of this end. ${END_TRIGGERS_SENTENCE}`;
const END_TIMER =
  'A timer cannot end a process; a timer is something a process waits on. ' +
  `Write 'await timer("PT1H")' to pause the flow here, ` +
  `'on timer("PT1H")' to react while the surrounding steps run, or ` +
  `'on <step>: timer("PT1H")' to watch only while that step runs. ` +
  END_TRIGGERS_SENTENCE;
const END_CONDITION =
  'A condition cannot end a process; a condition is something a process ' +
  `waits on. Write 'await condition(amount > 100)' to pause the flow here, ` +
  `'on condition(amount > 100)' to react while the surrounding steps run, ` +
  `or 'on <step>: condition(amount > 100)' to watch only while that step ` +
  `runs. ${END_TRIGGERS_SENTENCE}`;
const unknownEndKind = (word: string) =>
  `Unknown event kind '${word}'. ${END_TRIGGERS_SENTENCE} Every other kind ` +
  "is raised with 'throw'.";
const TERMINATE_NAMES_NOTHING =
  'Terminate names nothing: it stops every running path in this scope; ' +
  'leave the payload out.';
const CANCEL_NAMES_NOTHING =
  'Cancel names nothing: it gives up the block this end sits in; leave the ' +
  'payload out.';

// Event handlers.

const unknownOnKind = (word: string) =>
  `Unknown event kind '${word}'; write 'error', 'escalation', 'message', ` +
  `'signal', 'timer', 'condition', 'compensation', or 'cancel'.`;
const CONDITIONAL_TYPO = `Unknown event kind 'conditional'; did you mean 'condition'?`;
const COMPENSATE_TYPO = `Unknown event kind 'compensate'; write 'compensation'.`;
const HANDLER_PLACEMENT =
  'An event handler belongs directly in the body of a process, a subprocess, ' +
  'an attempt block, or another event handler: it handles events for that ' +
  'whole scope, not for a single branch.';
const HANDLER_TRAILING =
  'Event handlers read like catch blocks: move it after the last step of ' +
  'this body.';
const ERROR_ALWAYS_INTERRUPTS =
  'An error always interrupts: the handler takes over from the failed scope; ' +
  "'alongside' is only available for escalations.";
const EMPTY_CODE_NOT_CATCH_ALL =
  'An empty code ("") is not a catch-all; to catch every error, leave the ' +
  'payload out entirely.';
const MESSAGELESS_NAME =
  "A message handler needs the message's name: the engine matches messages by name.";
const CONDITION_REQUIRED =
  "A condition handler needs its condition: 'on condition(amount > 100)'.";
const CONDITION_NO_CODE =
  "A condition handler takes no code string; write the condition itself: 'on condition(amount > 100)'.";
const CONDITION_ONLY = "Only 'on condition' takes a condition expression.";
const SECOND_PAREN_VALUE =
  'The parens carry one unkeyed value, the payload; a second one names ' +
  "nothing and never reaches the engine. Write it as a 'key: value' setting, " +
  'or remove it.';
const PARTICLE_ONLY = "Only 'on timer' takes a particle.";
const noBindings = (trigger: string) =>
  `'(code: c)' bindings belong to error and escalation handlers; a ${trigger} carries no code.`;
const ESCALATION_HAS_NO_MESSAGE =
  'An escalation carries a code but no message.';
/** Why a second catch of one thing on one scope is refused, per trigger. */
const HANDLER_DUPLICATE_RULE: Readonly<Record<string, string>> = {
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
const handlerDuplicate = (trigger: string, caught: string, scope: string) =>
  `Another 'on ${trigger}' handler already catches ${caught} on scope '${scope}': ${HANDLER_DUPLICATE_RULE[trigger]}.`;
/** What a duplicate handler is said to catch: a code, a name, or every event. */
const everyEvent = 'every event of this kind';
const code = (value: string) => `code '${value}'`;
const eventName = (value: string) => `name '${value}'`;
const escalationCatchAllBesideCoded = (scope: string) =>
  `An 'on escalation' handler with no code cannot sit beside one with a code on scope '${scope}': the code-less one would catch every escalation, and Operaton refuses the pair (BpmnParse.addEscalationEventDefinition). Give both a code, or keep one.`;
const raceDuplicate = (trigger: string, value: string) =>
  `Another branch of this 'await' already catches ${trigger} '${value}': every branch subscribes on the gateway's own scope (BpmnParse.parseIntermediateCatchEvent), which keeps one ${trigger} subscription per name (BpmnParse.addEventSubscriptionDeclaration), so the deployment fails.`;

// Boundary hosts.

const illegalHost = (name: string, kind: string) =>
  'A boundary event can only attach to an activity: a user, service, script, ' +
  'send, or receive task, a step, a decision step, a subprocess, an attempt ' +
  `block, or a call; '${name}' is ${kind}.`;
const escalationHost = (name: string, kind: string) =>
  'An escalation boundary can only attach to a subprocess, an attempt block, ' +
  `a call, or a user task; '${name}' is ${kind}.`;
const selfAttachedHost = (name: string) =>
  'A boundary event cannot attach to a step inside its own escape path: ' +
  `'${name}' only runs after this handler has already fired, so it can never ` +
  'host the event that starts that path.';

// Compensation.

const COMPENSATION_NO_CODE =
  "Compensation has no code or name: 'on compensation { }' is the undo block " +
  'of the subprocess or attempt block it sits in; leave the payload out.';
const COMPENSATION_BINDINGS =
  "'(code: c)' bindings belong to error and escalation handlers; compensation carries no values.";
const COMPENSATION_ALONGSIDE =
  'The work an undo block reverses has already finished, so there is no ' +
  "running flow to run alongside; remove 'alongside'.";
const COMPENSATION_PLACEMENT =
  "An undo block belongs directly inside the 'subprocess' or 'attempt' whose " +
  'work it undoes: a process cannot undo itself.';
const COMPENSATION_DUPLICATE =
  'A subprocess or an attempt block has one undo block; merge the steps.';
const COMPENSATION_HOST =
  "Compensation cannot attach to a host: it undoes a subprocess's " +
  'already-completed work through its own undo block, not through a ' +
  "boundary event; remove the host and write 'on compensation { ... }' " +
  'directly inside the subprocess or attempt block it reverses.';
const throwCompensationNames = (keyword: 'throw' | 'emit') =>
  'Compensation undoes completed work: there is nothing to name; ' +
  `write '${keyword} compensation'.`;

// Cancel.

const CANCEL_END_PLACEMENT =
  "A cancel end belongs directly inside an 'attempt' block: it gives that " +
  'block up, and the engine refuses one anywhere else. Wrap the steps to ' +
  `give up in 'attempt <name> { ... }', or end this path with a plain 'end'.`;
const CANCEL_HOSTLESS =
  "A cancel is caught on the block it gives up; write 'on <block>: cancel'. " +
  'A handler with no host opens on its own trigger, and nothing opens on a ' +
  'cancel.';
const CANCEL_ALONGSIDE =
  'Giving a block up ends every step still running inside it, so there is ' +
  "nothing left to run alongside; remove 'alongside'.";
const CANCEL_NO_CODE =
  'A cancel handler catches nothing by name: it runs when its block is ' +
  'given up; leave the payload out.';
const CANCEL_NOT_RAISED =
  'A cancel is not raised: it is how a block gives itself up; write ' +
  `'end <name> cancel' inside the 'attempt' block.`;
const CANCEL_NOT_AWAITED =
  'A cancel is not awaited: it is how a block gives itself up; write ' +
  `'end <name> cancel' inside the 'attempt' block, and ` +
  `'on <block>: cancel' beside the block to say what happens then.`;
const cancelHost = (name: string, kind: string) =>
  `A cancel handler can only attach to an 'attempt' block: it catches that ` +
  `block being given up; '${name}' is ${kind}.`;
const cancelEndWithoutHandler = (name: string) =>
  `'${name}' gives itself up but nothing catches it: the engine stops with ` +
  `an error the first time that end is reached. Write 'on ${name}: cancel ` +
  `{ ... }' beside the block to say what happens then.`;
const cancelHandlerWithoutEnd = (name: string) =>
  `Nothing inside '${name}' gives it up, so this handler never runs: write ` +
  `'end <name> cancel' on the path that should give the block up, or remove ` +
  'the handler.';

// Throw, emit, and await.

const unknownThrowKind = (word: string) =>
  `Unknown event kind '${word}'; write 'error', 'escalation', 'message', 'signal', or 'compensation'.`;
const unknownEmitKind = (word: string) =>
  `Unknown event kind '${word}'; write 'escalation', 'message', 'signal', 'compensation', or 'link'.`;
const EMIT_ERROR = "An error always aborts its path; write 'throw error'.";
const codeRequired = (
  subject: 'A thrown' | 'An emitted',
  trigger: string,
  keyword: 'throw' | 'emit',
) => `${subject} ${trigger} names its code: '${keyword} ${trigger}(<CODE>)'.`;
const noImplementation = (key: string, subject: string) =>
  `Setting '${key}' is not valid on ${subject}; an implementation is what ` +
  'makes the engine really send a message, so only a message carries one.';
const unknownAwaitKind = (word: string) =>
  `Unknown event kind '${word}'; intermediate catch supports 'message', ` +
  `'timer', 'signal', 'condition', or 'link'. An error or an escalation is ` +
  `raised with 'throw'/'emit', compensation is a subprocess's undo block, ` +
  `and a cancel is written on the end that gives up an 'attempt' block.`;
const awaitNameRequired = (kind: string) =>
  `An awaited ${kind} needs the ${kind}'s name: the engine matches ${kind}s by name.`;
const AWAIT_CONDITION_REQUIRED =
  "An awaited condition needs its condition: 'await condition(amount > 100)'.";
const AWAIT_CONDITION_NO_CODE =
  "An awaited condition takes no code string; write the condition itself: 'await condition(amount > 100)'.";
const AWAIT_CONDITION_ONLY =
  "Only 'await condition' takes a condition expression.";
const AWAIT_PARTICLE_ONLY = "Only 'await timer' takes a particle.";

// Link events.

const LINK_CATCH_FLOW =
  "Nothing may flow into an 'await link': end the path before it with 'end', " +
  "'throw', 'goto', or 'emit link', because a link catch is entered only by " +
  "'emit link' of the same name.";
const LINK_IN_RACE =
  "'link' cannot head a branch of an 'await' block: the engine refuses a link " +
  `catch after an event-based gateway; write 'await link("<name>")' as its ` +
  'own statement.';
const linkThrowNeverRuns = (item: string) =>
  `${item} has no effect on an emitted link: the engine creates no activity ` +
  "for a link throw, so nothing written on it runs. Put it on the 'await " +
  "link' of the same name instead.";
const linkNoCatch = (name: string) =>
  `No 'await link("${name}")' catches this link, and the engine refuses to ` +
  'deploy an emitted link with no catch of its name. Write one where the ' +
  'flow should continue.';
const linkOtherContainer = (name: string) =>
  `'emit link("${name}")' must sit in the same process, subprocess, or ` +
  "handler body as its 'await link': a link cannot cross a subprocess or " +
  "handler boundary, the same way a 'goto' cannot.";
const linkIntoBranch = (name: string, keyword: 'parallel' | 'await') =>
  intoBranch(`emit link("${name}")`, 'emit link', keyword);
const linkNameTaken = (name: string) =>
  `Another 'await link("${name}")' already catches this link: the engine ` +
  'keeps one catch per link name in the whole file, even across subprocesses.';
const linkUnused = (name: string) =>
  `No 'emit link("${name}")' names this catch, so it and the steps after it ` +
  'never run.';
const gotoToLink = (target: string) =>
  `'goto ${target}' cannot target an awaited link: a link catch is entered ` +
  "by 'emit link' of the same name, not by a sequence flow.";
const THROW_LINK =
  "A link continues at its catch rather than ending the path; write 'emit link'.";

// Code declarations.

const unknownCodeDeclarationKind = (word: string) =>
  `Unknown declaration kind '${word}'; write 'error' or 'escalation', or a ` +
  'step keyword if a step was meant.';
const DECLARATION_SETTINGS_ONLY =
  `A declaration's parens take only 'code' or 'message' settings, ` +
  "written 'key: value'.";
const declarationNotAString = (kind: string, key: string) =>
  `An ${kind} declaration's ${key} must be a quoted string.`;
const declarationEmpty = (kind: string, key: string) =>
  `An ${kind} declaration's ${key} cannot be empty.`;
const alreadyDeclared = (kind: string, name: string) =>
  `'${name}' is already declared in this process; '${kind}(${name})' would be ambiguous.`;
const duplicateDeclaredCode = (kind: string, code: string, owner: string) =>
  `${capitalized(kind)} code '${code}' is already declared by '${owner}'; two declarations cannot share a code.`;
const quotedCode = (kind: string, declaration: string, use: string) =>
  `An ${kind} code is a declared name, not quoted text. ` +
  `Declare '${declaration}' in the process header and write '${kind}(${use})'.`;

// ── Cases ───────────────────────────────────────────────────────────────────

checks('Validation - variables in expressions', [
  [
    'an undeclared variable in a condition warns and names it',
    `process p { if (amount > 1000) { user A } }`,
    [warn(undeclared('amount'))],
  ],
  [
    'a declared variable used compatibly is clean',
    `process p { var amount: number if (amount > 1000) { user A } }`,
    [],
  ],
  [
    'a header var is in scope for a reference further down the body',
    `process p { var amount: number if (amount > 1000) { user A } end Done }`,
    [],
  ],
  [
    'the same reference without the declaration warns',
    `process p { if (amount > 1000) { user A } end Done }`,
    [warn(undeclared('amount'))],
  ],
  [
    'a dotted formKey names a form, not a variable',
    `process p { user T(formKey: forms.review) }`,
    [],
  ],
  [
    'a bareword expression is an EL binding, not a variable',
    `process p { service S(expression: someBareword) }`,
    [],
  ],
  [
    'a dotted class names a Java class, not a variable',
    `process p { service S(class: com.example.X) }`,
    [],
  ],
  [
    'a string-typed variable compared with a number is a type error',
    `process p { var name: string if (name > 1000) { user A } }`,
    [typeMismatch('name', 'string', 'an ordered comparison', '>')],
  ],
  [
    'a number-typed variable in an ordered comparison is clean',
    `process p { var amount: number if (amount >= 1000) { user A } }`,
    [],
  ],
  [
    'a boolean-typed variable in arithmetic is a type error',
    `process p { var flag: boolean if (flag + 1 > 0) { user A } }`,
    [typeMismatch('flag', 'boolean', 'an arithmetic expression', '+')],
  ],
  [
    'a number-typed variable in a logical expression is a type error',
    `process p { var amount: number if (amount && true) { user A } }`,
    [typeMismatch('amount', 'number', 'a logical expression', '&&')],
  ],
  [
    'an any-typed variable never mismatches',
    `process p { var x: any if (x > 1000) { user A } }`,
    [],
  ],
  [
    "an undeclared variable in an 'on condition' expression warns the same way",
    `process p { on condition(amount > 100) { user A } }`,
    [noFlowSteps('p'), warn(undeclared('amount'))],
  ],
  [
    "a declared variable in an 'on condition' expression is clean",
    `process p { var amount: number on condition(amount > 100) { user A } }`,
    [noFlowSteps('p')],
  ],
  [
    "a string-typed variable in an 'on condition' comparison is a type error",
    `process p { var amount: string on condition(amount > 100) { user A } }`,
    [
      noFlowSteps('p'),
      typeMismatch('amount', 'string', 'an ordered comparison', '>'),
    ],
  ],
]);

/**
 * Revert check for the `assignee` rows: dropping the key from
 * `NON_VARIABLE_ATTR_KEYS` brings the undeclared warning back on `demo` and
 * the hyphen error beside it on `john-doe`.
 */
checks('Validation - barewords in engine-side attribute values', [
  [
    'a bareword candidateGroups reaches the engine as written',
    `process p { user U(candidateGroups: approvers) }`,
    [],
  ],
  [
    'a bareword candidateUsers reaches the engine as written',
    `process p { user U(candidateUsers: approvers) }`,
    [],
  ],
  [
    'a bareword assignee is the user id, as the compiler and the engine read it',
    `process p { user U(assignee: demo, candidateUsers: demo) }`,
    [],
  ],
  [
    'a hyphenated assignee is a user id too, never scanned as a subtraction',
    `process p { user U(assignee: john-doe) }`,
    [],
  ],
  [
    'a bareword resultVariable names the variable to fill, not one to read',
    `process p { service V(expression: "\${bean.run()}", resultVariable: approvers) }`,
    [],
  ],
  [
    'a bareword dueDate is a date the engine cannot parse, so it asks for quotes',
    `process p { user U(dueDate: approvers) }`,
    [unquotedText('dueDate')],
  ],
  [
    'a bareword followUpDate asks for quotes the same way',
    `process p { user U(followUpDate: approvers) }`,
    [unquotedText('followUpDate')],
  ],
  [
    'a bareword retryCycle asks for quotes the same way',
    `process p { user U(asyncBefore: true, retryCycle: approvers) }`,
    [unquotedText('retryCycle')],
  ],
  [
    'a bareword priority lowers to an expression, so it warns when undeclared',
    `process p { user U(priority: deadline) }`,
    [warn(undeclared('deadline'))],
  ],
  [
    'a bareword jobPriority warns the same way',
    `process p { user U(asyncBefore: true, jobPriority: deadline) }`,
    [warn(undeclared('deadline'))],
  ],
  [
    'a bareword businessKey warns the same way',
    `process p { call C(process: "q", businessKey: deadline) }`,
    [warn(undeclared('deadline'))],
  ],
]);

/**
 * Revert checks: dropping the word set from the spelling check turns the
 * keyword rows red, dropping the hyphen test the `my-flag` row.
 */
checks('Validation - a JUEL keyword or a hyphen in a rendered name', [
  ...JUEL_RESERVED_WORDS.flatMap((word): Case[] => [
    [
      `'${word}' as a variable is an operator to the engine, at the declaration and at the use`,
      `process p { var ${word}: boolean if (${word}) { user A } }`,
      [
        juelKeyword(word, `execution.getVariable('${word}')`),
        juelKeyword(word, `execution.getVariable('${word}')`),
      ],
    ],
    [
      `'${word}' as a property is an operator to the engine`,
      `process p { var order: json if (order.${word}) { user A } }`,
      [juelKeyword(word, `order['${word}']`)],
    ],
    [
      `'${word}' as a property inside a raw template is the same operator`,
      `process p { if ("\${order.${word}}") { user A } }`,
      [juelKeyword(word, `order['${word}']`)],
    ],
  ]),
  [
    'a keyword read off a bracketed object in a raw template is keyed on that object',
    `process p { if ("\${items[0].and}") { user A } }`,
    [juelKeyword('and', "items[0]['and']")],
  ],
  [
    'a keyword inside a JUEL string literal or between two templates is text, not a read',
    `process p { user A(assignee: "\${map['x.and'] == 'a.or'} or.and \${b}") }`,
    [],
  ],
  [
    'a keyword read in a listener timeout template is the same operator',
    `process p { user A { on timeout after "\${order.and}"(class: "c.X") } }`,
    [juelKeyword('and', "order['and']")],
  ],
  [
    'a hyphenated variable scans as a subtraction',
    `process p { var my-flag: boolean if (my-flag) { user A } }`,
    [hyphenName('my-flag', "execution.getVariable('my-flag')")],
  ],
  [
    'a hyphenated property scans the same way, keyed on its object',
    `process p { var order: json if (order.line.is-paid) { user A } }`,
    [hyphenName('is-paid', "order.line['is-paid']")],
  ],
  [
    'an undeclared hyphenated variable keeps its warning beside the error',
    `process p { if (my-flag) { user A } }`,
    [
      hyphenName('my-flag', "execution.getVariable('my-flag')"),
      warn(undeclared('my-flag')),
    ],
  ],
  [
    'a bare collection name is looked up as a variable, not evaluated',
    `process p { var check-close: json user U for each x in check-close }`,
    [],
  ],
  [
    'a bare in-mapping source is copied by name, not evaluated',
    `process p { var check-close: json call C(process: "q") { in y = check-close } }`,
    [],
  ],
  [
    'a collection under an accessor is evaluated, so its spelling counts',
    `process p { var order: json user U for each x in order.line-items }`,
    [hyphenName('line-items', "order['line-items']")],
  ],
  [
    'a class name and a topic reach the engine as written',
    `process p { service S(class: com.example.mod) service T(topic: order-events) }`,
    [],
  ],
]);

/** Each position wrapping the same number variable, so the rule is pinned per position. */
const CONDITION_POSITIONS: Array<[title: string, at: (c: string) => string]> = [
  ['if', (c) => `process p { var n: number if (${c}) { user A } }`],
  [
    'else if',
    (c) =>
      `process p { var n: number var f: boolean if (f) { user A } else if (${c}) { user B } }`,
  ],
  ['while', (c) => `process p { var n: number while (${c}) { user A } }`],
  [
    'do ... while',
    (c) => `process p { var n: number do { user A } while (${c}) }`,
  ],
  [
    'a parallel branch head',
    (c) =>
      `process p { var n: number parallel { if (${c}) { user A } { user B } } }`,
  ],
  [
    'a condition handler',
    (c) => `process p { var n: number user A on condition(${c}) { user B } }`,
  ],
  [
    'a condition start',
    (c) => `process p { var n: number start S condition(${c}) user A }`,
  ],
  [
    'an awaited condition',
    (c) => `process p { var n: number await condition(${c}) user A }`,
  ],
  [
    'a race branch',
    (c) =>
      `process p { var n: number await { condition(${c}) { user A } timer("PT1H") { user B } } }`,
  ],
];

/**
 * Revert checks: dropping the `Additive` arm turns the `n + 1` row red,
 * dropping the position list the per-position rows.
 */
checks('Validation - a condition must be boolean', [
  ...CONDITION_POSITIONS.map(([title, at]): Case => [
    `${title} refuses a number variable`,
    at('n'),
    [nonBooleanCondition("a variable of type 'number'")],
  ]),
  [
    "an 'until' clause cites the multi-instance behaviour",
    `process p { user U for 3 until (nrOfCompletedInstances) }`,
    [nonBooleanUntil("a variable of type 'number'")],
  ],
  [
    'a string literal',
    `process p { if ("yes") { user A } }`,
    [nonBooleanCondition('a string')],
  ],
  [
    'a json variable is a Spin node, never a Boolean',
    `process p { var order: json if (order) { user A } }`,
    [nonBooleanCondition("a variable of type 'json'")],
  ],
  [
    'a null literal cites the null check',
    `process p { if (null) { user A } }`,
    [
      "A condition must be boolean, but this one is null: the engine throws 'condition expression returns null' when it evaluates it (UelExpressionCondition.evaluate).",
    ],
  ],
  [
    'a number literal',
    `process p { if (1) { user A } }`,
    [nonBooleanCondition('a number')],
  ],
  [
    'an arithmetic expression',
    `process p { var n: number if (n + 1) { user A } }`,
    [nonBooleanCondition('an arithmetic expression')],
  ],
  [
    'a negation',
    `process p { var n: number if (-n) { user A } }`,
    [nonBooleanCondition('an arithmetic expression')],
  ],
  [
    'a ternary with no boolean arm',
    `process p { var n: number if (n > 1 ? "a" : 2) { user A } }`,
    [nonBooleanCondition('a ternary with no boolean arm')],
  ],
  [
    'text around a template evaluates to a string',
    `process p { if ("\${a} and \${b}") { user A } }`,
    [
      nonBooleanCondition(
        'text around a template, which evaluates to a string',
      ),
    ],
  ],
  [
    'parentheses do not change the shape',
    `process p { if (("yes")) { user A } }`,
    [nonBooleanCondition('a string')],
  ],
  [
    'a boolean variable, a comparison and a template body are clean',
    `process p { var flag: boolean if (flag) { user A } if (flag && "\${a.b}") { user B } user U for 3 until (nrOfCompletedInstances > 1) }`,
    [],
  ],
  [
    'an undeclared variable keeps its warning and nothing more',
    `process p { if (x) { user A } }`,
    [warn(undeclared('x'))],
  ],
  [
    'a property and a ternary with one boolean arm have no known type',
    `process p { var order: json var f: boolean if (order.paid) { user A } if (f ? f : 1) { user B } }`,
    [],
  ],
]);

/** Revert check: dropping `singleTemplateBody` from the nested check turns the negated row red. */
checks('Validation - a composite raw template cannot be an operand', [
  [
    'negated',
    `process p { if (!"\${a} and \${b}") { user A } }`,
    [COMPOSITE_OPERAND],
  ],
  [
    'compared',
    `process p { if ("\${a} b" == "x") { user A } }`,
    [COMPOSITE_OPERAND],
  ],
  [
    'as an index',
    `process p { var m: json if (m["\${a} \${b}"]) { user A } }`,
    [COMPOSITE_OPERAND],
  ],
  [
    'in a ternary arm',
    `process p { var f: boolean if (f ? "\${a} \${b}" : true) { user A } }`,
    [COMPOSITE_OPERAND],
  ],
  [
    'one template under an operator splices in',
    `process p { if (!"\${a.b}") { user A } }`,
    [],
  ],
  [
    'a brace or opener inside a JUEL string literal is string text (Scanner.nextString), so "${map[\'}\']}" and "${fn(\'${\')}" are one template',
    `process p { if (!"\${map['}']}" && !"\${fn('\${')}") { user A } }`,
    [],
  ],
  [
    'a composite at the top of its position is carried as written',
    `process p { service S(class: "com.acme.D") { field subject = "\${a} and \${b}" } }`,
    [],
  ],
]);

/**
 * Revert checks: dropping the `LiteralString` arm turns the quoted-delegate
 * row red, dropping the blank test the empty rows.
 */
checks('Validation - binding values', [
  [
    'a quoted delegate on a service task never resolves',
    `process p { service S(delegate: "bean") }`,
    [literalElBinding('delegate', NO_DELEGATE)],
  ],
  [
    'a quoted expression on a listener evaluates to its own text',
    `process p { user U { on start(expression: "bean.run()") } }`,
    [literalElBinding('expression', EVALUATES_ITSELF)],
  ],
  [
    'a quoted mapperDelegate on a call never resolves',
    `process p { call C(process: "q", mapperDelegate: "bean") }`,
    [literalElBinding('mapperDelegate', NO_DELEGATE)],
  ],
  [
    'a quoted expression on a thrown message evaluates to its own text',
    `process p { start S throw message("Ack", expression: "b") }`,
    [literalElBinding('expression', EVALUATES_ITSELF)],
  ],
  [
    'a template as a class is loaded as a class name',
    `process p { service S(class: "\${cls}") }`,
    [templateAsClass('class', 'delegate')],
  ],
  [
    'a template as a listener class is loaded the same way',
    `process p { user U { on start(class: "\${cls}") } }`,
    [templateAsClass('class', 'delegate')],
  ],
  [
    'a template as a mapper is loaded the same way',
    `process p { call C(process: "q", mapper: "\${cls}") }`,
    [templateAsClass('mapper', 'mapperDelegate')],
  ],
  ...(
    [
      ['class', 'class to load'],
      ['expression', 'expression to evaluate'],
      ['delegate', 'delegate to resolve'],
      ['topic', 'topic a worker subscribes to'],
    ] as const
  ).map(([key, noun]): Case => [
    `an empty ${key} on a service task`,
    `process p { service S(${key}: "") }`,
    [emptyBinding(key, noun)],
  ]),
  ...(
    [
      ['class', 'class to load'],
      ['expression', 'expression to evaluate'],
      ['delegate', 'delegate to resolve'],
    ] as const
  ).map(([key, noun]): Case => [
    `a blank ${key} on a listener`,
    `process p { user U { on start(${key}: " ") } }`,
    [emptyBinding(key, noun)],
  ]),
  [
    'an empty decision on a decide step',
    `process p { decide D(decision: "") }`,
    [emptyBinding('decision', 'decision table to evaluate')],
  ],
  [
    'an empty mapper and mapperDelegate on a call',
    `process p { call C(process: "q", mapper: "") call D(process: "q", mapperDelegate: "") }`,
    [
      emptyBinding('mapper', 'mapping class to load'),
      emptyBinding('mapperDelegate', 'mapping delegate to resolve'),
    ],
  ],
  [
    'a bare or dotted name and a template are the shapes the keys take',
    `process p { service S(delegate: bean) service T(expression: bean.method) service U(class: "com.acme.D") call C(process: "q", mapper: com.acme.M) }`,
    [],
  ],
]);

/** Revert check: dropping the `EXPRESSION_OPEN` test turns the escaped row red. */
checks('Validation - an escaped literal as a field value', [
  [
    'quoted text opening with an escaped template has no field slot',
    `process p { service S(class: "com.acme.D") { field x = "\\\${y" } }`,
    [escapedFieldLiteral('x')],
  ],
  [
    'the hash opener and leading whitespace are the same slot',
    `process p { service S(class: "com.acme.D") { field x = "\\#{y}" field z = " \\\${y}" } }`,
    [escapedFieldLiteral('x'), escapedFieldLiteral('z')],
  ],
  [
    'on a listener as well',
    `process p { user U { on start(class: "com.acme.L") { field x = "\\\${y" } } }`,
    [escapedFieldLiteral('x')],
  ],
  [
    'an opener further in is plain text',
    `process p { service S(class: "com.acme.D") { field x = "cost: \\\${y}" } }`,
    [],
  ],
  [
    'an empty literal has neither a fixed value nor an expression',
    `process p { service S(class: "com.acme.D") { field x = "" } }`,
    [emptyField('x')],
  ],
  [
    'an empty literal on a listener as well',
    `process p { user U { on start(class: "com.acme.L") { field x = "" } } }`,
    [emptyField('x')],
  ],
]);

checks('Validation - attribute keys and value shapes', [
  [
    'a repeated key in one block is one error naming it',
    `process p { user T(assignee: "a", assignee: "b") }`,
    [duplicateSetting('assignee')],
  ],
  [
    'a second unkeyed value is dropped, so it is refused',
    `process p { var x: number start S await message("M", x > 1) }`,
    [SECOND_PAREN_VALUE],
  ],
  [
    'the refusal counts one per extra value, whatever the element',
    `process p { start S user T("a", "b", "c") }`,
    [settingsOnly('a user task'), SECOND_PAREN_VALUE, SECOND_PAREN_VALUE],
  ],
  ...(
    [
      [
        'a start with no trigger',
        'start S("PT30M") user T',
        'a start event with no trigger',
      ],
      [
        'an end with no trigger',
        'user T end E(false)',
        'an end event with no trigger',
      ],
      ['a user task', 'user T("a")', 'a user task'],
      ['a subprocess', 'subprocess S("a") { user T }', 'a subprocess'],
      ['a listener', 'user T { on start("a", class: "c.X") }', 'a listener'],
    ] as const
  ).map(([title, body, description]): Case => [
    `an unkeyed value on ${title} is nothing the lowering reads, so it is refused`,
    `process p { ${body} }`,
    [settingsOnly(description)],
  ]),
  [
    'an unkeyed value on the process header is refused the same way',
    `process p("a") { user T }`,
    [settingsOnly('a process header')],
  ],
  [
    'two different keys are clean',
    `process p { user T(assignee: "a", formKey: "f") }`,
    [],
  ],
  [
    'assignee on a service task is not valid there',
    `process p { service S(assignee: "x") }`,
    [
      notValidOn('assignee', 'a service task'),
      bindingRequired(`Service task 'S'`, SERVICE_BINDINGS),
    ],
  ],
  [
    'class on a user task is not valid there',
    `process p { user T(class: com.example.X) }`,
    [notValidOn('class', 'a user task')],
  ],
  [
    'formKey on a service task is not valid there',
    `process p { service S(class: com.example.X, formKey: "f") }`,
    [notValidOn('formKey', 'a service task')],
  ],
  [
    'each kind writing only its own keys is clean',
    `process p { user T(assignee: "a", formKey: "f") service S(class: com.example.X) }`,
    [],
  ],
  [
    'assignee on a call is not valid there',
    `process p { call X(process: "p", assignee: "x") }`,
    [notValidOn('assignee', 'a call')],
  ],
  [
    'process on a user task is not valid there',
    `process p { user T(process: "p") }`,
    [notValidOn('process', 'a user task')],
  ],
  [
    'resultVariable on a user task is not valid there',
    `process p { user U(resultVariable: "r") }`,
    [notValidOn('resultVariable', 'a user task')],
  ],
  [
    'businessKey on a user task is not valid there',
    `process p { user U(businessKey: "k") }`,
    [notValidOn('businessKey', 'a user task')],
  ],
  [
    'assignee on a subprocess is not valid there',
    `process p { subprocess S(assignee: "a") { user U } }`,
    [notValidOn('assignee', 'a subprocess')],
  ],
  [
    'topic on an end event is not valid there',
    `process p { start S end E(topic: "t") }`,
    [notValidOn('topic', 'an end event')],
  ],
  [
    'a user task accepts every key it owns',
    `process p { user U(assignee: "demo", formKey: "f", candidateGroups: "approvers", candidateUsers: "ada", dueDate: "2026-09-01T09:00:00", followUpDate: "2026-08-30T09:00:00", priority: 10) }`,
    [],
  ],
  [
    'a script task accepts resultVariable',
    `process p { script T(resultVariable: "total") ${FENCE}js\n1 + 1\n${FENCE} }`,
    [],
  ],
  [
    'a version-pinned call accepts version and businessKey',
    `process p { call C(process: "q", version: 1, businessKey: "k") }`,
    [],
  ],
  [
    'a binding-pinned call accepts binding',
    `process p { call C(process: "q", binding: latest) }`,
    [],
  ],
  [
    'every boolean attribute takes an unquoted true or false',
    `process p { user U(asyncBefore: true, asyncAfter: false, exclusive: true) }`,
    [],
  ],
  [
    'a quoted boolean is one error naming the unquoted form',
    `process p { user U(asyncBefore: true, exclusive: "true") }`,
    [quotedBoolean('exclusive')],
  ],
  [
    'a number in a boolean attribute is one error',
    `process p { user U(asyncBefore: 1) }`,
    [quotedBoolean('asyncBefore')],
  ],
  [
    'a bareword in a boolean attribute is one error, and still reads as a variable',
    `process p { user U(asyncBefore: flag) }`,
    [warn(undeclared('flag')), quotedBoolean('asyncBefore')],
  ],
  [
    'an expression in a boolean attribute is one error, since the lowering drops it',
    `process p { user U(asyncBefore: "\${flag}") }`,
    [quotedBoolean('asyncBefore')],
  ],
  [
    'every engine-side text attribute takes a quoted string or an expression',
    `process p { user U(asyncBefore: true, retryCycle: "R3/PT10M", dueDate: "\${due}", followUpDate: "\${due}") }`,
    [],
  ],
  [
    'a number in retryCycle asks for quotes',
    `process p { user U(asyncBefore: true, retryCycle: 3) }`,
    [unquotedText('retryCycle')],
  ],
  [
    'a bareword starter list names a principal, not a variable',
    `process p(candidateStarterUsers: demo, candidateStarterGroups: adjusters) { start S }`,
    [],
  ],
  [
    'a bareword initiator names the variable the engine writes, not one in scope',
    `process p { start S(initiator: claimant) }`,
    [],
  ],
  [
    'an expression in a numeric attribute carries no value-shape rule',
    `process p { user U(asyncBefore: true, jobPriority: "\${weight}") }`,
    [],
  ],
  [
    'a key the element does not own is reported once, not once per rule',
    `process p { start S(dueDate: 3) }`,
    [notValidOn('dueDate', 'a start event')],
  ],
]);

checks('Validation - service, send, and decision bindings', [
  [
    'a service task with no binding names the five attributes',
    `process p { service S { } }`,
    [bindingRequired(`Service task 'S'`, SERVICE_BINDINGS)],
  ],
  [
    'a service task with two bindings names both',
    `process p { service S(class: com.example.X, expression: "\${bean.method(execution)}") }`,
    [
      bindingConflict(
        `Service task 'S'`,
        'class, expression',
        SERVICE_BINDINGS,
      ),
    ],
  ],
  [
    'an expression binding alone is enough',
    `process p { service S(expression: "\${bean.method(execution)}") }`,
    [],
  ],
  [
    'a delegate binding alone is enough',
    `process p { service S(delegate: "\${beanName}") }`,
    [],
  ],
  [
    'a topic binding alone is enough',
    `process p { service S(topic: "shipping") }`,
    [],
  ],
  [
    'keys that bind nothing leave a service task without a binding',
    `process p { service V(resultVariable: "r", asyncBefore: true) }`,
    [bindingRequired(`Service task 'V'`, SERVICE_BINDINGS)],
  ],
  [
    'a service task cannot carry resultVariable beside class: the engine refuses to deploy it',
    `process p { service V(class: com.example.X, resultVariable: "outcome") }`,
    [resultVariableBinding('A service task', 'class', 'serviceTask', 'class')],
  ],
  [
    'a service task cannot carry resultVariable beside delegate either',
    `process p { service V(delegate: "\${bean}", resultVariable: "outcome") }`,
    [
      resultVariableBinding(
        'A service task',
        'delegate',
        'serviceTask',
        'delegateExpression',
      ),
    ],
  ],
  [
    'a send task bound with class refuses resultVariable under its own element name',
    `process p { send N(class: com.example.X, resultVariable: "outcome") }`,
    [resultVariableBinding('A send task', 'class', 'sendTask', 'class')],
  ],
  [
    'a decision step bound with delegate refuses resultVariable under its own element name',
    `process p { decide D(delegate: "\${bean}", resultVariable: "outcome") }`,
    [
      resultVariableBinding(
        'A decision step',
        'delegate',
        'businessRuleTask',
        'delegateExpression',
      ),
    ],
  ],
  [
    'resultVariable beside an expression binding is where the engine stores the return value',
    `process p { service V(expression: "\${bean.method(execution)}", resultVariable: "outcome") }`,
    [],
  ],
  [
    'a send task with no binding names the five attributes',
    `process p { send N { } }`,
    [bindingRequired(`Send task 'N'`, SERVICE_BINDINGS)],
  ],
  [
    'a send task with two bindings names both',
    `process p { send N(class: "com.example.Send", topic: "t") }`,
    [bindingConflict(`Send task 'N'`, 'class, topic', SERVICE_BINDINGS)],
  ],
  [
    'a decision step with no binding names the six attributes',
    `process p { decide D { } }`,
    [bindingRequired(`Decision step 'D'`, DECISION_BINDINGS)],
  ],
  [
    'a decision step bound to both a decision and code names both',
    `process p { decide D(decision: "riskRating", class: "com.example.Rate") }`,
    [
      bindingConflict(
        `Decision step 'D'`,
        'decision, class',
        DECISION_BINDINGS,
      ),
    ],
  ],
  [
    'a decision step combining binding and version is one error',
    `process p { decide D(decision: "riskRating", binding: latest, version: 3) }`,
    [bindingVersionClash('A decision step')],
  ],
  [
    "'binding: version' on a decision step points at the version setting",
    `process p { decide D(decision: "riskRating", binding: version) }`,
    [BINDING_IS_VERSION],
  ],
  [
    'an unrecognized mapDecisionResult names the four mappings',
    `process p { decide D(decision: "riskRating", mapDecisionResult: nonsense) }`,
    [MAP_DECISION_RESULT],
  ],
  ['a receive task needs no binding at all', `process p { receive R }`, []],
  [
    'a receive task takes a message name',
    `process p { receive R(message: "OrderPaid") }`,
    [],
  ],
]);

/**
 * Settings the engine deploys and then reads at the step, or never. Revert
 * checks: the `topic`/`type` arm of the result-variable check removed turns
 * the two warned rows clean, the mapping warning removed the `singleEntry`
 * row, the decision-modifier check removed the three refused rows.
 */
checks('Validation - settings the engine reads under one binding alone', [
  [
    'resultVariable beside a topic warns that nothing writes it',
    `process p { service V(topic: "t", resultVariable: "r") }`,
    [warn(resultVariableUnread('topic'))],
  ],
  [
    'resultVariable beside a topic on a decision step warns the same way',
    `process p { decide D(topic: "t", resultVariable: "r") }`,
    [warn(resultVariableUnread('topic'))],
  ],
  [
    'mapDecisionResult with no resultVariable is built and never applied',
    `process p { decide D(decision: "riskRating", mapDecisionResult: singleEntry) }`,
    [warn(MAP_DECISION_RESULT_UNREAD)],
  ],
  [
    'mapDecisionResult with resultVariable is applied when the result is stored',
    `process p { decide D(decision: "riskRating", mapDecisionResult: singleEntry, resultVariable: "r") }`,
    [],
  ],
  ...[
    ['binding', 'binding: latest'],
    ['version', 'version: 2'],
    ['mapDecisionResult', 'mapDecisionResult: singleEntry'],
  ].map(([key, setting]): Case => [
    `${key} on a decision step bound by code is read by nothing, so it is refused`,
    `process p { decide D(class: "com.example.Rate", ${setting}) }`,
    [decisionModifierWithoutDecision(key!)],
  ]),
  [
    'two modifiers beside a topic are each refused once',
    `process p { decide D(topic: "t", binding: latest, mapDecisionResult: singleEntry) }`,
    [
      decisionModifierWithoutDecision('binding'),
      decisionModifierWithoutDecision('mapDecisionResult'),
    ],
  ],
]);

/** One user task carrying the setting alone, so each row is one shape and its whole list. */
const userWith = (setting: string) => `process p { user U(${setting}) }`;

/** The three elements pinning a deployed version, each wrapping one `version` value. */
const VERSION_CARRIERS: Array<[carrier: string, at: (v: string) => string]> = [
  ['a call', (v) => `process p { call C(process: "q", version: ${v}) }`],
  [
    'a decision step',
    (v) => `process p { decide D(decision: "riskRating", version: ${v}) }`,
  ],
  [
    'a form reference',
    (v) => userWith(`formRef: "review-form", version: ${v}`),
  ],
];

/**
 * Values the engine deploys as written and parses when the token reaches the
 * step. Revert checks: `priority` dropped from `PRIORITY_ATTR_KEYS` turns its
 * refused rows clean, the `version` rule removed its refused rows on all
 * three carriers, the due-date text check removed the `"tomorrow"` row.
 */
checks('Validation - values the engine parses when the step runs', [
  ...['7', '"7"', '"${p}"', 'weight'].map((value): Case => [
    `priority ${value} parses or evaluates to an integer`,
    `process p { var weight: number user U(priority: ${value}) }`,
    [],
  ]),
  ...['1.5', '"high"'].map((value): Case => [
    `priority ${value} fails the task creation, so it is refused`,
    userWith(`priority: ${value}`),
    [USER_PRIORITY_SHAPE],
  ]),
  ...VERSION_CARRIERS.flatMap(([carrier, at]): Case[] => [
    ...['2', '"2"', '"${v}"'].map((value): Case => [
      `version ${value} on ${carrier} converts to an integer`,
      at(value),
      [],
    ]),
    ...['1.5', '"abc"', '-1', '0', 'v'].map((value): Case => [
      `version ${value} on ${carrier} fails at the step, so it is refused`,
      at(value),
      [VERSION_SHAPE],
    ]),
  ]),
  ...['"P2D"', '"2026-01-01T00:00:00"', '"${d}"'].map((value): Case => [
    `dueDate ${value} is a shape the business calendar resolves`,
    userWith(`dueDate: ${value}`),
    [],
  ]),
  [
    'a due date the calendar cannot resolve is refused on both keys',
    userWith('dueDate: "tomorrow", followUpDate: "next week"'),
    [dueDateShape('dueDate'), dueDateShape('followUpDate')],
  ],
  ...['"PT10M"', '"R3/PT10M"', '"PT5M,PT10M"', '"${r}"'].map((value): Case => [
    `retryCycle ${value} is a shape the retry parser resolves`,
    userWith(`asyncBefore: true, retryCycle: ${value}`),
    [],
  ]),
  [
    'a retryCycle the parser cannot resolve is dropped, so it only warns',
    userWith('asyncBefore: true, retryCycle: "bogus"'),
    [warn(RETRY_CYCLE_SHAPE)],
  ],
]);

/**
 * The three checks `BpmnParse.parseServiceTaskLike` runs before it builds a
 * mail or shell behaviour, each mirrored so a clean script deploys. Revert
 * checks: dropping `['text', 'html']` from the required table turns the
 * body rows red, removing the flag check the `"True"` row, and removing the
 * declared-name check the `recipient` row.
 */
checks('Validation - the mail and shell bindings', [
  [
    'a mail task with a recipient and a text body is clean',
    `process p { service N(type: "mail") { field to = "a@b" field text = "t" } }`,
    [],
  ],
  [
    'a shell send task with a command, an argument, an output variable, and a flag is clean',
    `process p { send S(type: "shell") { field command = "echo" field arg1 = "x" field outputVariable = "o" field wait = "true" } }`,
    [],
  ],
  [
    'a shell decision step with a command alone is clean',
    `process p { decide D(type: "shell") { field command = "true" } }`,
    [],
  ],
  [
    'the type is read bare as it is read quoted',
    `process p { service N(type: mail) { field to = "a@b" field text = "t" } }`,
    [],
  ],
  [
    'an upper-case type is refused: one printed form keeps the round trip stable',
    `process p { service N(type: "MAIL") }`,
    [TYPE_VALUE],
  ],
  [
    'a type the engine has no behaviour for names the two it has',
    `process p { service N(type: "ftp") }`,
    [TYPE_VALUE],
  ],
  [
    'a cc does not stand in for the recipient',
    `process p { service N(type: "mail") { field cc = "c@d" field text = "t" } }`,
    [
      missingBuiltinField(
        `Service task 'N'`,
        'mail',
        "'to'",
        'No recipient is defined on the mail activity',
        'validateFieldDeclarationsForEmail',
      ),
    ],
  ],
  [
    'a subject does not stand in for the body',
    `process p { send N(type: "mail") { field to = "a@b" field subject = "s" } }`,
    [
      missingBuiltinField(
        `Send task 'N'`,
        'mail',
        "'text' or 'html'",
        'Text or html field should be provided',
        'validateFieldDeclarationsForEmail',
      ),
    ],
  ],
  [
    'a mail task with both bodies is clean',
    `process p { service N(type: "mail") { field to = "a@b" field text = "t" field html = "<p>t</p>" } }`,
    [],
  ],
  [
    'a mail task with no field at all draws one refusal per requirement',
    `process p { service N(type: "mail") }`,
    [
      missingBuiltinField(
        `Service task 'N'`,
        'mail',
        "'to'",
        'No recipient is defined on the mail activity',
        'validateFieldDeclarationsForEmail',
      ),
      missingBuiltinField(
        `Service task 'N'`,
        'mail',
        "'text' or 'html'",
        'Text or html field should be provided',
        'validateFieldDeclarationsForEmail',
      ),
    ],
  ],
  [
    'a shell task without a command names the engine check',
    `process p { send S(type: "shell") { field wait = "true" } }`,
    [
      missingBuiltinField(
        `Send task 'S'`,
        'shell',
        "'command'",
        'No shell command is defined on the shell activity',
        'validateFieldDeclarationsForShell',
      ),
    ],
  ],
  [
    'a shell field written as an expression fails the deployment, so it is refused',
    `process p { service R(type: "shell") { field command = "\${cmd}" } }`,
    [shellFieldExpression('command')],
  ],
  [
    'a shell flag the engine would read as false is refused',
    `process p { service R(type: "shell") { field command = "ls" field wait = "True" } }`,
    [shellFlagValue('wait')],
  ],
  [
    'a field the mail behaviour does not declare names the ones it does',
    `process p { service N(type: "mail") { field to = "a@b" field text = "t" field recipient = "x" } }`,
    [
      unknownBuiltinField(
        'recipient',
        'mail',
        'MailActivityBehavior',
        MAIL_FIELDS,
      ),
    ],
  ],
  [
    'a field the shell behaviour does not declare names the ones it does',
    `process p { service R(type: "shell") { field command = "ls" field args = "x" } }`,
    [
      unknownBuiltinField(
        'args',
        'shell',
        'ShellActivityBehavior',
        SHELL_FIELDS,
      ),
    ],
  ],
  [
    "a field's own shape is refused first, and the shell rules stand down",
    `process p { service R(type: "shell") { field command = ["ls"] } }`,
    [fieldValue('command')],
  ],
  [
    'a type beside a code binding is the one-binding conflict and nothing more',
    `process p { service N(class: "com.example.X", type: "mail") }`,
    [bindingConflict(`Service task 'N'`, 'class, type', SERVICE_BINDINGS)],
  ],
  [
    'a thrown message has no block for the fields, so it takes no type',
    `process p { start S throw message("Ack", type: "mail") }`,
    [notValidOn('type', 'a throw statement')],
  ],
  [
    'an emitted message takes none either',
    `process p { start S emit message("Ack", type: "shell") }`,
    [notValidOn('type', 'an emit statement')],
  ],
  [
    'a user task takes no type',
    `process p { user U(type: "mail") }`,
    [notValidOn('type', 'a user task')],
  ],
  [
    'a result variable beside a type warns that nothing writes it, as beside a topic',
    `process p { service R(type: "shell", resultVariable: "r") { field command = "ls" } }`,
    [warn(resultVariableUnread('type'))],
  ],
]);

describe('Validation - decision result mappings', () => {
  test.each(['singleEntry', 'singleResult', 'collectEntries', 'resultList'])(
    '`mapDecisionResult = %s` is clean, and names no variable',
    async (mapping) => {
      expect(
        await diagnosticsOf(
          `process p { decide D(decision: "riskRating", mapDecisionResult: ${mapping}, resultVariable: "rating") }`,
        ),
      ).toEqual([]);
    },
  );
});

checks('Validation - script tasks and fenced scripts', [
  [
    'an unsupported language tag names the tag and the supported ones',
    `process p { script total ${FENCE}php\nx = 1\n${FENCE} }`,
    [unsupportedScriptTag(`Script task 'total'`, 'php')],
  ],
  [
    'an empty script body is one error naming the task',
    `process p { script total ${FENCE}js\n${FENCE} }`,
    [emptyScript(`Script task 'total'`)],
  ],
  [
    'a supported tag with a body is clean',
    `process p { script total ${FENCE}js\nx = 1\n${FENCE} }`,
    [],
  ],
  ...scriptTagCases(
    (tag) => `process p { script total ${FENCE}${tag}\nx = 1\n${FENCE} }`,
    `Script task 'total'`,
  ),
]);

checks('Validation - goto', [
  [
    'an unresolved goto is the linker error alone',
    `process p { user Foo goto Missing }`,
    [unresolvedStatement('Missing')],
  ],
  [
    'a goto resolving to a user task is clean',
    `process p { user Foo goto Foo }`,
    [],
  ],
  [
    'a goto resolving to a topic-bound service task is clean',
    `process p { service Ship(topic: "shipping") goto Ship }`,
    [],
  ],
  [
    'a goto resolving to a script task is clean',
    `process p { script Compute ${FENCE}js\nx = 1\n${FENCE} goto Compute }`,
    [],
  ],
  [
    'a goto resolving to a call activity is clean',
    `process p { call F(process: "p") goto F }`,
    [],
  ],
  [
    'a goto from outside into a parallel branch is one error',
    `process p { parallel { { user A } { user B } } goto A }`,
    [gotoIntoBranch('A', 'parallel')],
  ],
  [
    'a goto from one parallel branch into its sibling is one error',
    `process p { parallel { { user A goto B } { user B } } }`,
    [gotoIntoBranch('B', 'parallel')],
  ],
  [
    'a goto within one parallel branch is clean',
    `process p { parallel { { user A goto A } { user B } } }`,
    [],
  ],
  ['a goto outside every branch is clean', `process p { user A goto A }`, []],
  [
    'a goto from outside into a race branch names the await statement',
    `process p { await { message("M") { user A } signal("S") { user B } } goto A }`,
    [gotoIntoBranch('A', 'await')],
  ],
  [
    'a goto within one race branch is clean',
    `process p { await { message("M") { user A goto A } signal("S") { user B } } }`,
    [],
  ],
]);

checks('Validation - a body with no flow steps', [
  [
    'an empty process body is one error',
    `process empty { }`,
    [noFlowSteps('empty')],
  ],
  [
    'a handler-only process body is one error',
    `process p { error Boom on error(Boom) { end H } }`,
    [noFlowSteps('p')],
  ],
  ['a start alone is a flow step', `process p { start S }`, []],
  ['a start and an end are flow steps', `process p { start S end E }`, []],
  [
    'an empty subprocess body names the subprocess head',
    `process p { subprocess S { } }`,
    [blockNoFlowSteps('a subprocess', 'S')],
  ],
  [
    'a handler-only subprocess body is one error',
    `process p { error Boom subprocess S { on error(Boom) { end H } } }`,
    [blockNoFlowSteps('a subprocess', 'S')],
  ],
  [
    'an empty attempt body names the attempt head instead',
    `process p { attempt A { } }`,
    [blockNoFlowSteps('an attempt block', 'A')],
  ],
  [
    'a subprocess with one step is clean',
    `process p { subprocess S { user A } }`,
    [],
  ],
]);

checks('Validation - empty branches and bodies', [
  [
    "an empty 'if' branch is one warning",
    `process p { var flag: boolean if (flag == true) { } }`,
    [warn(emptyBranch(`'if' branch`))],
  ],
  [
    "an empty 'else if' branch is one warning",
    `process p { var flag: boolean if (flag == true) { user A } else if (flag == false) { } }`,
    [warn(emptyBranch(`'else if' branch`))],
  ],
  [
    "an empty 'else' branch is one warning",
    `process p { var flag: boolean if (flag == true) { user A } else { } }`,
    [warn(emptyBranch(`'else' branch`))],
  ],
  [
    "an empty 'while' body would lose the loop's condition",
    `process p { var flag: boolean while (flag == true) { } }`,
    [emptyLoopBody('while')],
  ],
  [
    "an empty 'do ... while' body would lose the loop's condition",
    `process p { var flag: boolean do { } while (flag == true) }`,
    [emptyLoopBody('do')],
  ],
  [
    'a parameter written in a handler body configures nothing',
    `process p { user T on message("Late") { input who = "x" end LateEnd } }`,
    [blockParameter('input')],
  ],
  [
    'a listener written first in a subprocess body observes nothing',
    `process p { subprocess S { on start(class: "x.L") user A } }`,
    [BLOCK_LISTENER],
  ],
  [
    'a parameter written in a loop body configures nothing',
    `process p { var c: boolean while (c) { user A output y = 1 } }`,
    [blockParameter('output')],
  ],
  [
    'an empty parallel branch is one warning naming its position',
    `process p { parallel { { user A } { } } }`,
    [warn(emptyNumberedBranch(2, 'parallel'))],
  ],
  [
    'an empty race branch is one warning naming its position',
    `process p { await { message("M") { } signal("S") { user B } } }`,
    [warn(emptyNumberedBranch(1, 'await'))],
  ],
  [
    'an empty handler body is one warning',
    `process p { error X on error(X) { } }`,
    [noFlowSteps('p'), warn(emptyBranch('event handler'))],
  ],
  [
    'populated branches are clean',
    `process p {
  var flag: boolean
  if (flag == true) { user A } else if (flag == false) { user B } else { user C }
  while (flag == true) { user D }
  do { user E } while (flag == true)
  parallel { { user F } { user G } }
}`,
    [],
  ],
]);

checks('Validation - reserved synthesized-id names', [
  [
    'every Gateway_ suffix the desugarer synthesizes is reserved',
    `process p {
  start Gateway_foo_split
  user Gateway_invoice-approval_2_join
  service Gateway_p_0_fork(class: com.example.X)
  user Gateway_p_1_loop
  user Gateway_p_1_race
}`,
    [
      reservedName('Gateway_foo_split'),
      reservedName('Gateway_invoice-approval_2_join'),
      reservedName('Gateway_p_0_fork'),
      reservedName('Gateway_p_1_loop'),
      reservedName('Gateway_p_1_race'),
    ],
  ],
  [
    'a Gateway_ name from an underscore-prefixed process id is caught too',
    `process _p { user Gateway__p_split }`,
    [reservedName('Gateway__p_split')],
  ],
  [
    'every reserved prefix, and the two-segment Flow_ shape, is rejected',
    `process p {
  start Flow_A_B
  user Boundary_X_error
  user Throw_p_1
  user EventSubProcess_x
  user Catch_p_1
}`,
    [
      reservedName('Flow_A_B'),
      reservedName('Boundary_X_error'),
      reservedName('Throw_p_1'),
      reservedName('EventSubProcess_x'),
      reservedName('Catch_p_1'),
    ],
  ],
  [
    // The desugarer mints these off a handler's own coordinate, never the
    // enclosing process or subprocess name, so only a prefix catches them.
    'a boundary escape end and a handler body start/end are rejected under any container',
    `process p {
  user EndEvent_Boundary_T_error
  user StartEvent_EventSubProcess_p_1
  user EndEvent_EventSubProcess_p_1
}`,
    [
      reservedName('EndEvent_Boundary_T_error'),
      reservedName('StartEvent_EventSubProcess_p_1'),
      reservedName('EndEvent_EventSubProcess_p_1'),
    ],
  ],
  [
    'a subprocess and a call carry the same rule',
    `process p {
  subprocess Gateway_x_split { user A }
  subprocess Throw_foo { user B }
  call Catch_x(process: "p")
}`,
    [
      reservedName('Gateway_x_split'),
      reservedName('Throw_foo'),
      reservedName('Catch_x'),
    ],
  ],
  // The implicit start and end are reserved as the exact ids the compiler
  // mints for the body the statement sits in, not as prefixes: a modelling
  // tool's default `StartEvent_1` is an ordinary name.
  [
    'the exact implicit start and end of the process body are reserved',
    `process p { user StartEvent_p  user EndEvent_p }`,
    [
      mintedTerminal('StartEvent_p', 'start', 'p'),
      mintedTerminal('EndEvent_p', 'end', 'p'),
    ],
  ],
  [
    "a modelling tool's default start id is an ordinary name",
    `process p { start StartEvent_1  user EndEvent_1 }`,
    [],
  ],
  [
    'a subprocess body reserves its own implicit end, under either head word',
    `process p { subprocess S { user EndEvent_S }  attempt T { user StartEvent_T } }`,
    [
      mintedTerminal('EndEvent_S', 'end', 'S'),
      mintedTerminal('StartEvent_T', 'start', 'T'),
    ],
  ],
  [
    "another container's implicit end is free outside that container",
    `process p { user EndEvent_S  subprocess S { user A } }`,
    [],
  ],
  [
    'the subprocess statement itself sits in the enclosing body',
    `process p { subprocess StartEvent_p { user A } }`,
    [mintedTerminal('StartEvent_p', 'start', 'p')],
  ],
  [
    "the layouter's own diagram, plane, and per-shape ids are reserved too",
    `process p {
  user S_di
  user BPMNDiagram_p
  user BPMNPlane_p
}`,
    [
      reservedName('S_di'),
      reservedName('BPMNDiagram_p'),
      reservedName('BPMNPlane_p'),
    ],
  ],
  // A single-segment `Flow_` name cannot match `Flow_<src>_<tgt>`; the rest
  // miss the prefix or the suffix.
  [
    'a name merely resembling one of the shapes is free',
    `process p {
  user GatewayCheck
  user MyFlow_Thing
  user Flow_Control
  user Flow_State
  user StartEventHandler
  user EndEventHandler
  user Gateway_split
}`,
    [],
  ],
]);

checks('Validation - one process per file', [
  [
    'a second process block is one error on the extra block',
    `process Invoice { start S end E }\nprocess Shipping { start S end E }`,
    [ONE_PROCESS_ONLY],
  ],
  [
    'a second process repeating the name is flagged the same way',
    `process Invoice { start S end E }\nprocess Invoice { start S end E }`,
    [ONE_PROCESS_ONLY],
  ],
  ['a single process is clean', `process Invoice { start S end E }`, []],
]);

checks('Validation - where a start may sit', [
  [
    'a start after a chain that still flows on interrupts it, and is a second plain start beside the minted one',
    `process p { user A start S end E }`,
    [startAfterLiveChain('S'), START_AFTER_IMPLICIT_START],
  ],
  [
    'starts written back to back open one chain',
    `process p { start A start B message("M") user T end E }`,
    [],
  ],
  [
    'a start may follow any statement that always ends or redirects the flow',
    `process p { var c: boolean start A if (c) { end E1 } else { end E2 } start B message("M") user T goto U start C signal("S") user U end E3 }`,
    [],
  ],
  [
    'a start after an end is a fresh root, and so is the chain it opens',
    `process p { start A user T end E start B message("M") goto T }`,
    [],
  ],
  [
    'a start nested in a branch is not first in its container',
    `process p { start S if (true) { start Nested } end E }`,
    [startNotFirst('Nested')],
  ],
  [
    'a start as the first statement is clean',
    `process p { start S user A end E }`,
    [],
  ],
  [
    'a process with no explicit start is clean',
    `process p { user A end E }`,
    [],
  ],
  [
    'a start opening a host-less handler body is legal',
    `process p { error PF service A(class: "x.A") on error(PF) { start S service R(class: "x.R") } }`,
    [],
  ],
  [
    'a start opening a hosted handler body has no scope of its own',
    `process p { error PF service A(class: "x.A") on A: error(PF) { start S service R(class: "x.R") } }`,
    [hostedHandlerStart('S')],
  ],
  [
    'a start first in a subprocess body is clean',
    `process p { subprocess S { start In user A end Out } }`,
    [],
  ],
  [
    'a start second in a subprocess body is one error',
    `process p { subprocess S { user A start In } }`,
    [startNotFirst('In')],
  ],
  [
    'a start inside an if nested in a subprocess is one error',
    `process p { subprocess S { if (true) { start In } } }`,
    [startNotFirst('In')],
  ],
]);

checks('Validation - the default start among several', [
  [
    'message and signal starts alone leave no default start',
    `process p { start A message("M") start B signal("S") user T end E }`,
    [warn(noDefaultStart('p'))],
  ],
  [
    'a timer start beside a message start is the default',
    `process p { start A timer(every: "R/PT1H") start B message("M") user T end E }`,
    [],
  ],
  [
    'a single message start is its own default',
    `process p { start A message("M") user T end E }`,
    [],
  ],
  [
    'a form on a start that is not the default is never offered',
    `process p { start A start B message("M") { form { x: number "X" } } user T end E }`,
    [warn(FORM_NEVER_OFFERED)],
  ],
  [
    'a form on the default start beside a message start is offered',
    `process p { start A { form { x: number "X" } } start B message("M") user T end E }`,
    [],
  ],
  [
    'with no default start every form is dead',
    `process p { start A message("M") { form { x: number "X" } } start B signal("S") user T end E }`,
    [warn(noDefaultStart('p')), warn(FORM_NEVER_OFFERED)],
  ],
  [
    'initiator on more than one start warns on every start but the last',
    `process p { start A(initiator: "a") start B message("M", initiator: "b") start C signal("S", initiator: "c") user T end E }`,
    [warn(INITIATOR_SHADOWED), warn(INITIATOR_SHADOWED)],
  ],
  [
    'initiator on one start beside a start with none shadows nothing',
    `process p { start A(initiator: "a") start B message("M") user T end E }`,
    [],
  ],
  ...(
    [
      ['two plain starts', 'start A start B'],
      ['a plain start beside a timer start', 'start A start B timer("PT1H")'],
      [
        'two timer starts',
        'start A timer(every: "R/PT1H") start B timer("PT1H")',
      ],
    ] as const
  ).map(([title, starts]): Case => [
    `${title} is a second default start the engine refuses`,
    `process p { ${starts} user T end E }`,
    [SECOND_DEFAULT_START],
  ]),
  ...(
    [
      ['a plain start', 'start S'],
      ['a timer start', 'start S timer(every: "R/PT1H")'],
    ] as const
  ).map(([title, start]): Case => [
    `${title} after a body that does not open with a start is the second default start`,
    `process invoice_batch { end Done ${start} }`,
    [START_AFTER_IMPLICIT_START],
  ]),
  [
    'a message start after such a body leaves the compiler-minted start the default, so its form is never offered',
    `process p { user T end Done start S message("M") { form { x: number "X" } } }`,
    [warn(FORM_NEVER_OFFERED)],
  ],
  [
    'two message starts of one name are one subscription too many',
    `process p { start A message("M") start B message("M") user T end E }`,
    [warn(noDefaultStart('p')), duplicateNamedStart('message', 'M')],
  ],
  [
    'two signal starts of one name are one subscription too many',
    `process p { start A signal("S") start B signal("S") user T end E }`,
    [warn(noDefaultStart('p')), duplicateNamedStart('signal', 'S')],
  ],
  [
    'two condition starts on one condition are one subscription too many',
    `process p { var x: number start A condition(x > 1) start B condition(x > 1) user T end E }`,
    [warn(noDefaultStart('p')), duplicateConditionStart('${x > 1}')],
  ],
  [
    'starts of one kind with different payloads coexist',
    `process p { var x: number start A message("M") start B message("N") start C signal("M") start D condition(x > 1) start E condition(x > 2) user T end F }`,
    [warn(noDefaultStart('p'))],
  ],
]);

checks('Validation - duplicate declarations', [
  [
    'two vars with one name is one error naming the process',
    `process p { var total: number var total: string start S end E }`,
    [duplicateVariable('total', 'p')],
  ],
  [
    'two vars with different names are clean',
    `process p { var total: number var quantity: number start S end E }`,
    [],
  ],
  [
    'two labels on one process is one error',
    `process p(label: "First", label: "Second") { start S end E }`,
    [duplicateSetting('label')],
  ],
  ['a single label is clean', `process p(label: "Only") { start S end E }`, []],
  [
    'two steps with one name make a goto ambiguous',
    `process p { user Review user Review }`,
    [duplicateStepName('Review', 'p')],
  ],
  [
    'a step named like the process id collides with it in the compiled document',
    `process p { user p }`,
    [stepNameEqualsProcess('p')],
  ],
  [
    'two steps with different names are clean',
    `process p { user Review user Approve }`,
    [],
  ],
  [
    'the ambiguity crosses element kinds',
    `process p { service A(topic: "shipping") script A ${FENCE}js\nx = 1\n${FENCE} }`,
    [duplicateStepName('A', 'p')],
  ],
  [
    'two subprocesses with one name is one error',
    `process p { subprocess S { user A } subprocess S { user B } }`,
    [duplicateStepName('S', 'p')],
  ],
  [
    'a step inside a subprocess reusing a parent step name is one error',
    `process p { user A subprocess S { user A } }`,
    [duplicateStepName('A', 'p')],
  ],
  [
    'a call sharing a name with a task is one error',
    `process p { user A call A(process: "p") }`,
    [duplicateStepName('A', 'p')],
  ],
  [
    'two named throws sharing a name is one error, and the second is dead',
    `process p { error X escalation Y throw error Same(X) throw escalation Same(Y) }`,
    [duplicateStepName('Same', 'p'), UNREACHABLE],
  ],
  [
    'a named await shares the step namespace',
    `process p { user Wait await message Wait("M") }`,
    [duplicateStepName('Wait', 'p')],
  ],
]);

checks('Validation - parallel branch heads', [
  [
    "an 'else' branch beside conditioned siblings is clean",
    `process p {
  var amount: number
  parallel {
    if (amount > 10000) { user Audit }
    if (amount > 0) { service RecordReceipt(topic: "receipts") }
    else { user ManualTriage }
  }
}`,
    [],
  ],
  [
    "an 'else' branch beside an unconditioned one could never run",
    `process p {
  var amount: number
  parallel {
    if (amount > 10000) { user Audit }
    { service RecordReceipt(topic: "receipts") }
    else { user ManualTriage }
  }
}`,
    [PARALLEL_ELSE_BESIDE_UNCONDITIONED],
  ],
  [
    "a second 'else' branch is one error",
    `process p {
  var amount: number
  parallel {
    if (amount > 10000) { user Audit }
    else { user A }
    else { user B }
  }
}`,
    [PARALLEL_SECOND_ELSE],
  ],
  [
    "an 'else' branch with no conditioned sibling has nothing to fall back from",
    `process p { parallel { { user A } else { user B } } }`,
    [PARALLEL_ELSE_WITHOUT_CONDITION],
  ],
]);

describe('Validation - parallel branch heads, reported in place', () => {
  test("the second 'else' carries the error, so the first is left alone", async () => {
    const { diagnostics } = await validate(`
process p {
  var amount: number
  parallel {
    if (amount > 10000) { user Audit }
    else { user A }
    else { user B }
  }
}
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.range.start.line).toBe(6);
  });
});

/**
 * The five statements whose head parens carry a gateway's settings, each an
 * otherwise-clean program with the parens left open. The `if` carries an
 * `else if`, so a row on it also pins that the chain's one head takes the
 * settings for the whole chain.
 */
const GATEWAY_HOSTS: ReadonlyArray<
  [kind: string, description: string, head: (items: string) => string]
> = [
  [
    'if',
    'an if statement',
    (i) =>
      `process p { var a: boolean if (a) (${i}) { user A } else if (a) { user B } else { user C } }`,
  ],
  [
    'while',
    'a while loop',
    (i) => `process p { var a: boolean while (a) (${i}) { user A } }`,
  ],
  [
    'do-while',
    'a do-while loop',
    (i) => `process p { var a: boolean do { user A } while (a) (${i}) }`,
  ],
  [
    'parallel',
    'a parallel statement',
    (i) => `process p { parallel (${i}) { { user A } { user B } } }`,
  ],
  [
    'await',
    'an await block',
    (i) =>
      `process p { await (${i}) { message("M") { user A } signal("S") { user B } } }`,
  ],
];
const LOOP_HOSTS = GATEWAY_HOSTS.filter(([kind]) => kind.includes('while'));
const JOIN_HOSTS = GATEWAY_HOSTS.filter(([kind]) => !kind.includes('while'));
const hostOf = (kind: string) => GATEWAY_HOSTS.find(([k]) => k === kind)![2];
const ifHead = hostOf('if');
const awaitHead = hostOf('await');

checks('Validation - gateway settings', [
  // The await head leaves `asyncAfter` out: its own row below refuses it.
  ...GATEWAY_HOSTS.map(([kind, , head]): Case => [
    `${kind} takes every head key`,
    head(
      engineItems(
        kind === 'await'
          ? ENGINE_KEYS.filter((key) => key !== 'asyncAfter')
          : ENGINE_KEYS,
      ),
    ),
    [],
  ]),
  ...JOIN_HOSTS.map(([kind, , head]): Case => [
    `${kind} takes every join key`,
    head(engineItems(ENGINE_KEYS, joinSettingKey)),
    [],
  ]),
  ...LOOP_HOSTS.map(([kind, description, head]): Case => [
    `a join key on ${kind} names the unprefixed key, a loop having one gateway`,
    head('joinAsyncBefore: true'),
    [loopJoinKey('joinAsyncBefore', description, 'asyncBefore')],
  ]),
  [
    'a key no gateway takes is not valid on an if statement',
    ifHead('wibble: 1'),
    [notValidOn('wibble', 'an if statement')],
  ],
  [
    'a flag is not valid on an if statement',
    ifHead('alongside'),
    [flagNotValidOn('alongside', 'an if statement')],
  ],
  [
    'a bare word is refused, the parens taking settings alone, and names no variable',
    ifHead('wibble'),
    [settingsOnly('an if statement')],
  ],
  [
    'a repeated key is one duplicate',
    hostOf('parallel')('asyncBefore: true, asyncBefore: true'),
    [duplicateSetting('asyncBefore')],
  ],
  [
    'asyncAfter on an await block is what the engine refuses on an event-based gateway',
    awaitHead('asyncAfter: true'),
    [AWAIT_ASYNC_AFTER],
  ],
  [
    'a quoted boolean in a join key names the unquoted form',
    ifHead('joinAsyncBefore: true, joinExclusive: "false"'),
    [quotedBoolean('joinExclusive')],
  ],
  [
    'a decimal in joinJobPriority is refused as on an element',
    ifHead('joinAsyncBefore: true, joinJobPriority: 1.5'),
    [priorityShape('joinJobPriority')],
  ],
  [
    'a number in joinRetryCycle asks for quotes',
    ifHead('joinAsyncBefore: true, joinRetryCycle: 3'),
    [unquotedText('joinRetryCycle')],
  ],
  [
    'a bareword in joinRetryCycle asks for quotes and names no variable',
    ifHead('joinAsyncBefore: true, joinRetryCycle: R3'),
    [unquotedText('joinRetryCycle')],
  ],
  [
    'a bareword jobPriority on a head lowers to an expression, so it warns when undeclared',
    ifHead('asyncBefore: true, jobPriority: prio'),
    [warn(undeclared('prio'))],
  ],
  [
    'a join key on an if whose every branch ends has no join to set',
    `process p { var a: boolean if (a) (joinAsyncBefore: true) { end A } else { end B } }`,
    [warn(prunedJoin('if statement', 'joinAsyncBefore'))],
  ],
  [
    'a join key on a parallel whose every branch ends has no join to set, and draws no pairing warning on top',
    `process p { parallel (asyncBefore: true, joinJobPriority: 5) { { end A } { end B } } }`,
    [warn(prunedJoin('parallel statement', 'joinJobPriority'))],
  ],
  [
    'the same if without an else keeps its join, so the join key is clean',
    `process p { var a: boolean if (a) (joinAsyncBefore: true) { end A } }`,
    [],
  ],
]);

/**
 * `DefaultFailedJobParseListener.parseActivity` stores a retry cycle only
 * once the carrier is async, and `BpmnParse.parseAsynchronousContinuation`
 * folds `exclusive` into the async flag rather than declaring a job of its
 * own, so `retryCycle`/`exclusive`/`jobPriority` (and their `join`/`run`
 * spellings) configure nothing without the matching async flag beside them.
 * Revert: dropping the rule clears every bare row below to `[]`.
 */
checks('Validation - job-setting pairing', [
  [
    "a task's and a handler's retryCycle, exclusive and jobPriority need their own async flag",
    `process p {
  service A(class: "x", retryCycle: "PT1M", exclusive: false, jobPriority: 5)
  on message("M", retryCycle: "PT1M") { user B }
}`,
    [
      warn(
        noJob('retryCycle', "'asyncBefore' or 'asyncAfter'", 'a service task'),
      ),
      warn(
        noJob('exclusive', "'asyncBefore' or 'asyncAfter'", 'a service task'),
      ),
      warn(
        noJob('jobPriority', "'asyncBefore' or 'asyncAfter'", 'a service task'),
      ),
      warn(
        noJob(
          'retryCycle',
          "'asyncBefore' or 'asyncAfter'",
          'an event handler',
        ),
      ),
    ],
  ],
  [
    'the same settings beside their async flag configure a job cleanly',
    `process p {
  service A(class: "x", asyncBefore: true, retryCycle: "PT1M", exclusive: false, jobPriority: 5)
  on message("M", asyncAfter: true, retryCycle: "PT1M") { user B }
}`,
    [],
  ],
  [
    "each of the five gateway statements' bare and join families need their own async flag",
    `process p {
  var flag: boolean
  if (flag) (retryCycle: "PT1M", joinJobPriority: 5) { user A } else { user B }
  while (flag) (exclusive: false) { user C }
  do { user D } while (flag) (jobPriority: 5)
  parallel (retryCycle: "PT1M", joinExclusive: false) { { user E } { user F } }
  await (jobPriority: 5, joinRetryCycle: "PT1M") { message("M") { user G } signal("S") { user H } }
}`,
    [
      warn(
        noJob('retryCycle', "'asyncBefore' or 'asyncAfter'", 'an if statement'),
      ),
      warn(
        noJob(
          'joinJobPriority',
          "'joinAsyncBefore' or 'joinAsyncAfter'",
          'an if statement',
        ),
      ),
      warn(noJob('exclusive', "'asyncBefore' or 'asyncAfter'", 'a while loop')),
      warn(
        noJob(
          'jobPriority',
          "'asyncBefore' or 'asyncAfter'",
          'a do-while loop',
        ),
      ),
      warn(
        noJob(
          'retryCycle',
          "'asyncBefore' or 'asyncAfter'",
          'a parallel statement',
        ),
      ),
      warn(
        noJob(
          'joinExclusive',
          "'joinAsyncBefore' or 'joinAsyncAfter'",
          'a parallel statement',
        ),
      ),
      warn(
        noJob('jobPriority', "'asyncBefore' or 'asyncAfter'", 'an await block'),
      ),
      warn(
        noJob(
          'joinRetryCycle',
          "'joinAsyncBefore' or 'joinAsyncAfter'",
          'an await block',
        ),
      ),
    ],
  ],
  [
    'paired with their async flags, every gateway statement configures its jobs cleanly',
    `process p {
  var flag: boolean
  if (flag) (asyncBefore: true, retryCycle: "PT1M", joinAsyncBefore: true, joinJobPriority: 5) { user A } else { user B }
  while (flag) (asyncBefore: true, exclusive: false) { user C }
  do { user D } while (flag) (asyncAfter: true, jobPriority: 5)
  parallel (asyncBefore: true, retryCycle: "PT1M", joinAsyncAfter: true, joinExclusive: false) { { user E } { user F } }
  await (asyncBefore: true, jobPriority: 5, joinAsyncBefore: true, joinRetryCycle: "PT1M") { message("M") { user G } signal("S") { user H } }
}`,
    [],
  ],
  [
    "a repeated step's plain retryCycle/exclusive price the whole loop and jobPriority/run keys price each run, both needing their own async flag",
    `process p { step T for 3(retryCycle: "PT1M", exclusive: false, jobPriority: 5, runRetryCycle: "PT2M", runExclusive: false) }`,
    [
      warn(noJob('retryCycle', "'asyncBefore' or 'asyncAfter'", 'a step')),
      warn(noJob('exclusive', "'asyncBefore' or 'asyncAfter'", 'a step')),
      warn(
        noPerRunJob(
          'jobPriority',
          "'runAsyncBefore' or 'runAsyncAfter'",
          'a repeated step',
        ),
      ),
      warn(
        noPerRunJob(
          'runRetryCycle',
          "'runAsyncBefore' or 'runAsyncAfter'",
          'a repeated step',
        ),
      ),
      warn(
        noPerRunJob(
          'runExclusive',
          "'runAsyncBefore' or 'runAsyncAfter'",
          'a repeated step',
        ),
      ),
    ],
  ],
  [
    'paired with their own async flags, both the whole-loop and the per-run settings configure a job',
    `process p { step T for 3(asyncBefore: true, retryCycle: "PT1M", exclusive: false, jobPriority: 5, runAsyncBefore: true, runRetryCycle: "PT2M", runExclusive: false) }`,
    [],
  ],
  [
    'a timer start, an awaited timer, a timer race branch, and a host-less timer handler need no async flag for any of the three',
    `process p {
  start Applied timer(every: "R/PT1H", jobPriority: 5, exclusive: false, retryCycle: "R1/PT1M")
  await timer("PT1H", jobPriority: 5)
  await { timer("PT1H", jobPriority: 5) { user A } message("M") { user B } }
  on timer("PT2H", jobPriority: 7) { start ES(exclusive: false, retryCycle: "PT1M") user C }
}`,
    [],
  ],
  [
    'a signal start, an awaited signal and a signal race branch price their subscription job with jobPriority alone; exclusive and retryCycle still need the flag, and a signal handler declares no such job',
    `process p {
  start Begin signal("S1", jobPriority: 5, exclusive: false, retryCycle: "PT1M")
  await signal("S2", jobPriority: 5)
  await { signal("S3", jobPriority: 5) { user A } message("M") { user B } }
  on signal("S4", jobPriority: 5) { user C }
}`,
    [
      warn(
        noJob('exclusive', "'asyncBefore' or 'asyncAfter'", 'a start event'),
      ),
      warn(
        noJob('retryCycle', "'asyncBefore' or 'asyncAfter'", 'a start event'),
      ),
      warn(
        noJob(
          'jobPriority',
          "'asyncBefore' or 'asyncAfter'",
          'an event handler',
        ),
      ),
    ],
  ],
]);

checks('Validation - form fields', [
  [
    'a form on a start event and on a user task is clean',
    `process p {
  start Begin { form { amount: number "Amount" } }
  user Approve(assignee: "demo") { form { approved: boolean "OK?" = false } }
}`,
    [],
  ],
  [
    'a form field declares the variable it binds',
    `process p { start Begin { form { amount: number "Amount" } } if (amount > 1000) { user A } }`,
    [],
  ],
  [
    'a field type outside string/number/boolean/date is rejected',
    `process p { start Begin { form { blob: json "Blob" } } }`,
    [formFieldType('blob', 'json')],
  ],
  [
    'an unrecognized field type beside a constraint draws only the type error, the fit check never runs',
    `process p { start Begin { form { blob: json "Blob" (minlength: 2) } } }`,
    [formFieldType('blob', 'json')],
  ],
  [
    'a form block on a service task belongs elsewhere',
    `process p { service S(class: "com.x.Y") { form { a: number } } }`,
    [noFormBlock('a service task')],
  ],
  [
    'a bare attribute on a start event is not valid there',
    `process p { start Begin(assignee: "demo") }`,
    [notValidOn('assignee', 'a start event')],
  ],
  [
    'two fields with one id is one error',
    `process p { start Begin { form { a: number a: string } } }`,
    [formFieldTypeClash('a', 'string', 'number'), duplicateFormField('a')],
  ],
  [
    'a second form block on one element is one error',
    `process p { start Begin { form { a: number } form { b: string } } }`,
    [oneFormBlock('a start event')],
  ],
  [
    'a field must agree with a var of the same name',
    `process p { var amount: string start Begin { form { amount: number "Amount" } } }`,
    [formFieldTypeClash('amount', 'number', 'string')],
  ],
  [
    'a field agreeing with the var is clean',
    `process p { var amount: number start Begin { form { amount: number "Amount" } } }`,
    [],
  ],
  [
    'an enum field agrees with a string var, since it binds the chosen id as a string',
    `process p { var plan: string start Begin { form { plan: enum { a } } } }`,
    [],
  ],
  ...NESTED_START_CONTAINERS.flatMap(([kind, wrap]): Case[] => [
    [
      `a form on the start of ${kind} is never shown`,
      wrap('start In { form { a: string } } user A'),
      [NESTED_START_FORM],
    ],
    [
      `an initiator on the start of ${kind} is never written`,
      wrap('start In(initiator: "who") user A'),
      [NESTED_START_INITIATOR],
    ],
  ]),
  [
    'a constraint name outside the six and validator names the eight settings',
    `process p { start S { form { amount: number (minimum: 0) } } }`,
    [unknownFormFieldSetting('amount', 'minimum')],
  ],
  ...formFieldRows('a constraint fits the type its validator checks', [
    ['min: 0', 'string', [constraintMisfit('min', 'f', 'string', 'number')]],
    [
      'maxlength: 2',
      'number',
      [constraintMisfit('maxlength', 'f', 'number', 'string')],
    ],
    [
      'minlength: 2',
      'date',
      [constraintMisfit('minlength', 'f', 'date', 'string')],
    ],
    ['pattern: "dd/MM/yyyy"', 'string', [patternMisfit('f', 'string')]],
    ['pattern: "dd/MM/yyyy"', 'enum', [patternMisfit('f', 'enum')]],
    ['min: 0', 'number', []],
    ['minlength: 2', 'string', []],
    ['required: true', 'boolean', []],
    ['pattern: "dd/MM/yyyy"', 'date', []],
  ]),
  ...formFieldRows('a constraint takes one value shape', [
    ['required: false', 'string', [flagFalse('required')]],
    ['required: "true"', 'string', [flagNotTrue('required')]],
    ['min: "abc"', 'number', [integerBound('min')]],
    ['max: 1.5', 'number', [integerBound('max')]],
    ['minlength: 2.5', 'string', [integerBound('minlength')]],
    ['pattern: ""', 'date', [PATTERN_VALUE]],
    ['min: -5', 'number', []],
    ['min: "-5"', 'number', []],
    ['maxlength: "80"', 'string', []],
    ['validator: com.example.Check', 'string', []],
    ['validator: ""', 'string', [VALIDATOR_EMPTY]],
    ['pattern: "dd-xx-yyyy"', 'date', [PATTERN_LETTERS]],
    [`pattern: "'T'HH:mm"`, 'date', []],
  ]),
  [
    "a bare word in a field's parens is not a setting",
    `process p { start S { form { amount: number (required) } } }`,
    [warn(undeclared('required')), formFieldSettingsOnly('amount', 'required')],
  ],
  [
    'an enum with no values is a warning',
    `process p { start S { form { plan: enum } } }`,
    [warn(emptyEnum('plan'))],
  ],
  [
    'a repeated value id is one error on the repeat',
    `process p { start S { form { plan: enum { a "A" a "B" } } } }`,
    [duplicateValue('a')],
  ],
  [
    'a literal default outside the values names the ids it can take',
    `process p { start S { form { plan: enum = "zzz" { a "A" b } } } }`,
    [enumDefault('plan', 'zzz', `'a' or 'b'`)],
  ],
  [
    'an expression default is left to the engine',
    `process p { start S { form { plan: enum = "\${plan}" { a } } } }`,
    [],
  ],
  [
    'value lines belong on an enum',
    `process p { start S { form { plan: string { a "A" } } } }`,
    [valuesOnNonEnum('plan', 'string')],
  ],
  [
    'a property is text',
    `process p { start S { form { p: string { property hint = ["a"] } } } }`,
    [propertyValue('hint')],
  ],
  [
    'a repeated property key is a duplicate',
    `process p { start S { form { p: string { property hint = "1" property hint = "2" } } } }`,
    [duplicateParameter('property', 'hint')],
  ],
  [
    "an io direction in a field's block is not a member",
    `process p { start S { form { p: enum { a input x = "1" } } } }`,
    [formFieldDirection('p', 'input', true)],
  ],
  [
    "an io direction in a non-enum field's block names no value lines",
    `process p { start S { form { p: string { input x = "1" } } } }`,
    [formFieldDirection('p', 'input')],
  ],
]);

checks('Validation - form field defaults', [
  [
    'a decimal default on a number field is not an integer',
    `process p { start S { form { n: number = 1.5 } } }`,
    [numberDefault('n', '1.5')],
  ],
  [
    'a quoted non-digit default on a number field is not an integer',
    `process p { start S { form { n: number = "high" } } }`,
    [numberDefault('n', '"high"')],
  ],
  [
    'an integer default on a number field is clean',
    `process p { start S { form { n: number = 5 } } }`,
    [],
  ],
  [
    'a quoted word default on a boolean field is neither true nor false',
    `process p { start S { form { b: boolean = "yes" } } }`,
    [booleanDefault('b', '"yes"')],
  ],
  [
    'the literal true default on a boolean field is clean',
    `process p { start S { form { b: boolean = true } } }`,
    [],
  ],
  [
    'a quoted "false" default on a boolean field is clean',
    `process p { start S { form { b: boolean = "false" } } }`,
    [],
  ],
  [
    'an ISO default on a date field with no pattern reads against the engine default instead',
    `process p { start S { form { d: date = "2026-01-01" } } }`,
    [isoDateDefault('d', '2026-01-01')],
  ],
  [
    'an ISO default fit to an explicit matching pattern is clean',
    `process p { start S { form { d: date = "2026-01-01" (pattern: "yyyy-MM-dd") } } }`,
    [],
  ],
  [
    'a default already fit to the engine default pattern is clean',
    `process p { start S { form { d: date = "01/01/2026" } } }`,
    [],
  ],
  [
    'a raw expression default passes on every type, since it is evaluated at render',
    `process p { var x: any start S { form { n: number = "\${x}" } } }`,
    [],
  ],
  [
    'a variable default passes on every type, for the same reason',
    `process p { var x: number start S { form { n: number = x } } }`,
    [],
  ],
]);

checks('Validation - unreachable statements', [
  [
    'a step after an end in the same block can never run',
    `process p { start S end Done user Dead }`,
    [UNREACHABLE],
  ],
  [
    'every dead step after an end is reported',
    `process p { start S end Done user A user B }`,
    [UNREACHABLE, UNREACHABLE],
  ],
  [
    'a step after a goto can never run',
    `process p { user A goto A user Dead }`,
    [UNREACHABLE],
  ],
  [
    'a goto target after an end stays reachable',
    `process p { start S if (cond) { goto Retry } end Done user Retry }`,
    [warn(undeclared('cond'))],
  ],
  [
    'an unreachable compound is reported once, not once per nested step',
    `process p { start S end Done if (cond) { user A user B } }`,
    [warn(undeclared('cond')), UNREACHABLE],
  ],
  [
    'ordinary sequential flow is clean',
    `process p { start S user A end Done }`,
    [],
  ],
  [
    'a step after an all-terminating if/else can never run',
    `process p { if (cond) { end A } else { end B } user Dead }`,
    [warn(undeclared('cond')), UNREACHABLE],
  ],
  [
    'a step after an all-terminating parallel can never run',
    `process p { var c: boolean parallel { { end A } { end B } } user Dead }`,
    [UNREACHABLE],
  ],
  [
    'a parallel with every branch conditioned keeps a fallback to its join',
    `process p { var c: boolean parallel { if (c) { end A } if (!c) { end B } } user Alive }`,
    [],
  ],
  [
    'a parallel mixing a conditioned and a plain branch has no fallback, so every branch ending kills the step after it',
    `process p { var c: boolean parallel { if (c) { end A } { end B } } user Dead }`,
    [UNREACHABLE],
  ],
  [
    'a conditioned parallel with an else terminates once every branch does',
    `process p { var c: boolean parallel { if (c) { end A } else { end B } } user Dead }`,
    [UNREACHABLE],
  ],
  [
    'a race reports the dead step inside a branch and the one after it',
    `process p { await { message("M") { end A user DeadInside } signal("S") { end B } } user DeadAfter }`,
    [UNREACHABLE, UNREACHABLE],
  ],
  [
    'a step after an if without else stays reachable',
    `process p { if (cond) { end A } user Alive }`,
    [warn(undeclared('cond'))],
  ],
  [
    'a step after a while whose body ends stays reachable',
    `process p { while (cond) { end A } user Alive }`,
    [warn(undeclared('cond'))],
  ],
  [
    'a step after a do-while whose body always ends can never run, and neither can the loop',
    `process p { var c: boolean do { end X } while (c) user Dead }`,
    [UNREACHABLE, DEAD_LOOP],
  ],
  [
    'a last do-while whose body always ends leaves its gateway with no incoming flow',
    `process p { var c: boolean start S do { end X } while (c) }`,
    [DEAD_LOOP],
  ],
  [
    'a do-while whose body ends on one branch only keeps its loop',
    `process p { var c: boolean start S do { if (c) { end X } else { user A } } while (c) }`,
    [],
  ],
  [
    'a step after an end inside a subprocess can never run',
    `process p { subprocess S { start In end Out user Dead } }`,
    [UNREACHABLE],
  ],
  [
    'an unreachable subprocess is reported once, not once per nested step',
    `process p { start S end Done subprocess Sub { user A user B } }`,
    [UNREACHABLE],
  ],
  [
    'a call after an end can never run',
    `process p { start S end Done call Dead(process: "p") }`,
    [UNREACHABLE],
  ],
  [
    'a goto targeting the call makes it reachable',
    `process p { start S if (cond) { goto Retry } end Done call Retry(process: "p") }`,
    [warn(undeclared('cond'))],
  ],
  [
    'a handler after an end is not part of the sequence',
    `process p { error X start S end Done on error(X) { user A } }`,
    [],
  ],
  [
    'a step after a throw can never run',
    `process p { error X throw error(X) user Dead }`,
    [UNREACHABLE],
  ],
  [
    'a goto-targeted step after a throw stays reachable',
    `process p { error X var cond: boolean if (cond) { goto Retry } throw error(X) user Retry }`,
    [],
  ],
  [
    'a step after an emit runs, since an emit continues',
    `process p { escalation X emit escalation(X) user Alive }`,
    [],
  ],
  [
    'a step after a thrown compensation can never run',
    `process p { throw compensation user Dead }`,
    [UNREACHABLE],
  ],
  [
    'a step after an emitted compensation runs',
    `process p { emit compensation user Alive }`,
    [],
  ],
  [
    'a named await after an end is reachable again as a goto target',
    `process p { start S if (c) { goto Wait } end Done await message Wait("M") }`,
    [warn(undeclared('c'))],
  ],
]);

checks('Validation - call activities', [
  [
    'a call naming only the process is clean',
    `process p { call X(process: "p") }`,
    [],
  ],
  [
    'every attribute and mapping shape together is clean',
    `process p {
  var amount: number
  var tax: number
  var vipFlag: boolean

  call Fulfilment(
    label: "Fulfil order",
    process: "fulfilment-process",
    binding: deployment,
    businessKey: "\${execution.processBusinessKey}"
  ) {
    in *
    in orderId
    in total = amount + tax
    in local vip = vipFlag
    out shipmentId
    out shipped = confirmed
  }
}`,
    [],
  ],
  [
    'an explicit binding: latest is clean',
    `process p { call X(process: "p", binding: latest) }`,
    [],
  ],
  [
    'a call with no process attribute names the requirement',
    `process p { call X { } }`,
    [CALL_PROCESS_REQUIRED],
  ],
  [
    'a call with an empty process attribute is one error',
    `process p { call X(process: "") }`,
    [emptyBinding('process', 'process to start')],
  ],
  [
    "'binding: version' points at the version setting",
    `process p { call X(process: "p", binding: version) }`,
    [BINDING_IS_VERSION],
  ],
  [
    'an unrecognized binding value names both legal ones',
    `process p { call X(process: "p", binding: weekly) }`,
    [BINDING_VALUE],
  ],
  [
    'binding and version together is one mutual-exclusion error',
    `process p { call X(process: "p", binding: deployment, version: 2) }`,
    [bindingVersionClash('A call')],
  ],
  [
    'version alone is clean',
    `process p { call X(process: "p", version: 2) }`,
    [],
  ],
  [
    'two in mappings naming one target is one error',
    `process p { var a: number var b: number call X(process: "p") { in x = a in x = b } }`,
    [duplicateMapping('in', 'x')],
  ],
  [
    'in and out are independent namespaces',
    `process p { call X(process: "p") { in x out x } }`,
    [],
  ],
  [
    'two copy-everything mappings in one direction is one error',
    `process p { call X(process: "p") { in * in * } }`,
    [duplicateAllMapping('in')],
  ],
  [
    'a copy-everything mapping beside a named one is clean',
    `process p { call X(process: "p") { in * in x } }`,
    [],
  ],
  [
    'an out mapping source is evaluated in the callee, so it is exempt',
    `process p { call X(process: "p") { out y = calleeVar } }`,
    [],
  ],
  [
    'the exemption reaches a source nested inside operators',
    `process p { var calleeVar: string call X(process: "p") { out y = calleeVar > 5 && true } }`,
    [],
  ],
  [
    'an in mapping source is caller-scope, so it still warns',
    `process p { call X(process: "p") { in y = callerVar } }`,
    [warn(undeclared('callerVar'))],
  ],
  [
    'a bareword process value names a deployed process, not a variable',
    `process p { call X(process: some-id) }`,
    [],
  ],
  [
    'a mapper class is clean',
    `process p { call X(process: "p", mapper: "com.acme.Mapper") }`,
    [],
  ],
  [
    'a mapper delegate is clean',
    `process p { call X(process: "p", mapperDelegate: "\${mapperBean}") }`,
    [],
  ],
  [
    'a bareword mapper class is not read as a variable',
    `process p { call X(process: "p", mapper: com.acme.Mapper) }`,
    [],
  ],
  [
    'a mapper runs beside the declared mappings, not instead of them',
    `process p { call X(process: "p", mapper: "com.acme.Mapper") { in * out result } }`,
    [],
  ],
  [
    'both mapper spellings on one call is one exclusion error',
    `process p { call X(process: "p", mapper: "com.acme.Mapper", mapperDelegate: "\${mapperBean}") }`,
    [
      bindingConflict(
        'A call',
        'mapper, mapperDelegate',
        `'mapper' or 'mapperDelegate'`,
      ),
    ],
  ],
]);

checks('Validation - event handlers', [
  [
    'coded and bound handlers with an alongside escalation are clean',
    `process p {
  error PAYMENT_FAILED escalation LOW_STOCK
  var c: string
  var m: string
  var v: string

  start S
  user A
  end E

  on error(PAYMENT_FAILED, code: c, message: m) { user R }
  on escalation(LOW_STOCK, code: v, alongside) { user Q }
}`,
    [],
  ],
  [
    'a handler inside a subprocess is clean',
    `process p { error X subprocess S { user A on error(X) { user B } } }`,
    [],
  ],
  [
    'a handler nested inside another handler is clean',
    `process p { error X escalation Y start S on error(X) { on escalation(Y) { user A } } }`,
    [],
  ],
  [
    'a coded handler and a catch-all of one trigger coexist',
    `process p { error X start S on error(X) { user A } on error { user B } }`,
    [],
  ],
  [
    'an explicit start opening a handler body is clean',
    `process p { error X start S on error(X) { start In user A end Out } }`,
    [],
  ],
  [
    'a handler nested in an if scopes to a branch, not a container',
    `process p { error X if (true) { on error(X) { user A } } }`,
    [HANDLER_PLACEMENT],
  ],
  [
    'a handler directly in a process body is placed right',
    `process p { error X on error(X) { user A } }`,
    [noFlowSteps('p')],
  ],
  [
    'a step after a handler reads out of order',
    `process p { error X on error(X) { user A } service S(class: "x.Y") }`,
    [HANDLER_TRAILING],
  ],
  [
    'a handler after a handler is in order',
    `process p { error X escalation Y on error(X) { user A } on escalation(Y) { user B } }`,
    [noFlowSteps('p')],
  ],
  [
    'an error handler cannot run alongside the scope it takes over',
    `process p { error X on error(X, alongside) { user A } }`,
    [noFlowSteps('p'), ERROR_ALWAYS_INTERRUPTS],
  ],
  [
    'an escalation handler may run alongside',
    `process p { escalation X on escalation(X, alongside) { user A } }`,
    [noFlowSteps('p')],
  ],
  [
    'an empty code string is not a catch-all',
    `process p { on error("") { user A } }`,
    [noFlowSteps('p'), EMPTY_CODE_NOT_CATCH_ALL],
  ],
  [
    'two handlers with one trigger and code are ambiguous',
    `process p { error X on error(X) { user A } on error(X) { user B } }`,
    [noFlowSteps('p'), handlerDuplicate('error', code('X'), 'p')],
  ],
  [
    'two catch-all handlers of one trigger are ambiguous',
    `process p { on error { user A } on error { user B } }`,
    [noFlowSteps('p'), handlerDuplicate('error', everyEvent, 'p')],
  ],
  [
    'alongside does not separate two handlers catching one code',
    `process p { escalation X on escalation(X) { user A } on escalation(X, alongside) { user B } }`,
    [noFlowSteps('p'), handlerDuplicate('escalation', code('X'), 'p')],
  ],
  [
    'two bindings with one field is one error',
    `process p { error X on error(X, code: c, code: d) { user A } }`,
    [noFlowSteps('p'), duplicateSetting('code')],
  ],
  [
    'an escalation carries a code but no message',
    `process p { escalation X on escalation(X, message: m) { user A } }`,
    [noFlowSteps('p'), ESCALATION_HAS_NO_MESSAGE],
  ],
  [
    'a binding key filled with a value binds nothing, so both are refused',
    `process p { error X on error(X, code: "C", message: 1) { user A } }`,
    [noFlowSteps('p'), bindingNotAName('code'), bindingNotAName('message')],
  ],
  [
    'a binding key filled with a name is the keyed spelling of a binding',
    `process p { error X var c: string on error(X, code: c) { user A } }`,
    [noFlowSteps('p')],
  ],
  [
    'a binding fills a string, so a number-typed var of that name disagrees',
    `process p { error X var c: number on error(X, code: c) { user A } }`,
    [noFlowSteps('p'), catchBindingTypeClash('c', 'number')],
  ],
  [
    'a handler body reading a binding variable is clean',
    `process p { error X on error(X, code: c, message: m) { if (c == "y") { user A } } }`,
    [noFlowSteps('p')],
  ],
  [
    'a misspelled binding field is an unknown setting on the handler',
    `process p { error X start S on error(X, coed: c) { user A } }`,
    [warn(undeclared('c')), notValidOn('coed', 'an event handler')],
  ],
  [
    'an unknown trigger word names every kind an on handler takes',
    `process p { start S on erorr("X") { } }`,
    [unknownOnKind('erorr')],
  ],
  [
    "'on conditional' is a did-you-mean",
    `process p { start S on conditional { user A } }`,
    [CONDITIONAL_TYPO],
  ],
  [
    "'on compensate' is a did-you-mean",
    `process p { start S on compensate { user A } }`,
    [COMPENSATE_TYPO],
  ],
  [
    'a variable named message coexists with the binding field of that word',
    `process p { error X var message: string if (message == "x") { user A } on error(X, message: m) { user B } }`,
    [],
  ],
  [
    'two message handlers sharing one name are ambiguous',
    `process p { on message("X") { user A } on message("X") { user B } }`,
    [noFlowSteps('p'), handlerDuplicate('message', eventName('X'), 'p')],
  ],
  [
    'two message handlers with different names coexist',
    `process p { on message("X") { user A } on message("Y") { user B } }`,
    [noFlowSteps('p')],
  ],
  ...(['message', 'signal'] as const).map((trigger): Case => [
    `a ${trigger} start beside a process-level ${trigger} handler of one name is keyed apart by the start flag`,
    `process p { start S ${trigger}("M") user A on ${trigger}("M") { user B } }`,
    [],
  ]),
  [
    'an escalation catch-all beside a coded catch at process level is refused',
    `process p { escalation X on escalation(X) { user A } on escalation { user B } }`,
    [noFlowSteps('p'), escalationCatchAllBesideCoded('p')],
  ],
  [
    "a timer job key on a timer handler's start repeats the head's",
    `process p { user T on timer("PT1H", jobPriority: 5) { start ES(jobPriority: 7, exclusive: false) user A } }`,
    [timerJobKeyTwice('jobPriority')],
  ],
  [
    'a timer job key on the head alone, or on the start alone, is written once',
    `process p { user T on timer("PT1H", jobPriority: 5) { start ES(exclusive: false) user A } on timer("PT2H") { start ES2(retryCycle: "R3/PT1M") user B } }`,
    [],
  ],
  [
    'one signal name in two containers is no duplicate',
    `process p { subprocess S { user T on signal("X") { user B } } on signal("X") { user A } }`,
    [],
  ],
  [
    'two timers in one container are legal: neither keys a subscription',
    `process p { on timer("PT1H") { user A } on timer("PT1H") { user B } }`,
    [noFlowSteps('p')],
  ],
  [
    'a name-only message handler is clean',
    `process p { start S on message("PaymentReceived") { user A } }`,
    [],
  ],
  [
    'a signal handler may run alongside',
    `process p { start S on signal("Cancelled", alongside) { user A } }`,
    [],
  ],
  [
    "an 'after' timer handler is clean",
    `process p { start S on timer("PT1H") { user A } }`,
    [],
  ],
  [
    "an 'at' timer handler is clean",
    `process p { start S on timer(at: "2026-08-01T09:00:00") { user A } }`,
    [],
  ],
  [
    "an 'every' timer handler running alongside is clean",
    `process p { start S on timer(every: "R/PT10M", alongside) { user A } }`,
    [],
  ],
  [
    'a condition handler over a declared variable is clean',
    `process p { var amount: number start S on condition(amount > 100) { user A } }`,
    [],
  ],
  [
    'a name-less message handler asks for the name',
    `process p { on message { user A } }`,
    [noFlowSteps('p'), MESSAGELESS_NAME],
  ],
  [
    'a name-less signal handler asks for the name',
    `process p { on signal { user A } }`,
    [noFlowSteps('p'), MESSAGELESS_NAME],
  ],
  [
    'a payload-less timer handler asks how to read the time',
    `process p { on timer { user A } }`,
    [noFlowSteps('p'), TIMER_PAYLOAD],
  ],
  [
    'a condition-less condition handler asks for the condition',
    `process p { on condition { user A } }`,
    [noFlowSteps('p'), CONDITION_REQUIRED],
  ],
  [
    'bindings on a message handler carry no code to bind',
    `process p { on message("X", code: c) { user A } }`,
    [noFlowSteps('p'), noBindings('message')],
  ],
  [
    'a condition on an error handler belongs to a condition handler',
    `process p { var amount: number start S on error(amount > 100) { user A } }`,
    [CONDITION_ONLY],
  ],
  [
    'a timer key on a signal handler belongs to a timer',
    `process p { on signal(at: "PT1H") { user A } }`,
    [noFlowSteps('p'), MESSAGELESS_NAME, PARTICLE_ONLY],
  ],
  [
    'a code string on a condition handler is not the condition',
    `process p { on condition("X") { user A } }`,
    [noFlowSteps('p'), CONDITION_NO_CODE],
  ],
  [
    'a condition handler carrying both mistakes reports them left to right',
    `process p { on condition("X", at: "2026-01-01") { user A } }`,
    [noFlowSteps('p'), CONDITION_NO_CODE, PARTICLE_ONLY],
  ],
  [
    "'after' with an expression passes through",
    `process p { start S on timer("\${dueDate}") { user A } }`,
    [],
  ],
  [
    "an interrupting 'every' timer fires at most once",
    `process p { on timer(every: "R/PT10M") { user A } }`,
    [noFlowSteps('p'), warn(REPEATING_INTERRUPTS)],
  ],
]);

/**
 * Every carrier that reads a timer clause, held to the shape its particle's
 * calendar parses. A timer start deploys the expression up front
 * (`BpmnDeployer.adjustStartEventSubscriptions`), so its bad shape is an
 * error; every other carrier reads it only when its scope is entered, so its
 * bad shape is a warning. Revert check: the parse reverted to `startsWith('P')`
 * leaves the 'after' bad value ("Pbogus") clean on every carrier.
 */
const TIMER_CARRIERS: ReadonlyArray<{
  name: string;
  severity: 'error' | 'warning';
  source: (particle: string, value: string) => string;
}> = [
  {
    name: 'a timer start',
    severity: 'error',
    source: (particle, value) =>
      `process p { start S timer(${timerClause(particle, value)}) user A }`,
  },
  {
    name: 'an awaited timer',
    severity: 'warning',
    source: (particle, value) =>
      `process p { await timer(${timerClause(particle, value)}) }`,
  },
  {
    name: 'a race branch timer',
    severity: 'warning',
    source: (particle, value) =>
      `process p { await { message("M") { user A } timer(${timerClause(particle, value)}) { user B } } }`,
  },
  {
    // Only an `on` handler is told to run alongside, so its 'every' rows carry
    // the flag: without it every 'every' row would also draw the unrelated
    // "fires at most once" warning that "Validation - event handlers" already pins.
    name: 'an on-handler timer',
    severity: 'warning',
    source: (particle, value) =>
      `process p { start S on timer(${timerClause(particle, value)}${particle === 'every' ? ', alongside' : ''}) { user A } }`,
  },
  {
    name: 'a timeout listener',
    severity: 'warning',
    source: (particle, value) =>
      `process p { user U { on timeout ${particle} "${value}"(class: "com.example.T") } }`,
  },
];

/** `after` is always bare; `at` and `every` are always written under their key. */
function timerClause(particle: string, value: string): string {
  return particle === 'after' ? `"${value}"` : `${particle}: "${value}"`;
}

/**
 * Revert checks: `ISO_DURATION_BODY` with `W` beside the other fields turns
 * 'after' `P1W2D` clean, and `JODA_PERIOD_BODY` without it turns 'at' `P1W2D`
 * red; `ISO_DATE_TIME_BODY` without its zone, month-only, hour-only, ordinal,
 * week or bare-`T` arm turns the matching 'at' values red; `INTERVAL_BODY`
 * without its end-date arms turns the dated 'after' and 'every' values red;
 * `AFTER_TIME_TEXT` without `REPEAT_BODY` turns `R3/PT1H` red; `CRON_BODY`
 * back to `{5,6}` fields turns the seven-field cron clean and without its
 * nickname alternative turns `@daily` red.
 */
const TIMER_PARTICLE_SHAPES: ReadonlyArray<{
  particle: string;
  bad: readonly string[];
  good: readonly string[];
  message: string;
}> = [
  {
    particle: 'after',
    bad: ['Pbogus', 'P1W2D'],
    good: [
      'PT1H',
      'P1W',
      'PT1H/2026-12-31T00:00:00',
      '2026-01-01T00:00:00/PT1H',
      'R3/PT1H',
    ],
    message: AFTER_SHAPE,
  },
  {
    particle: 'at',
    bad: ['tomorrow', '2026-12-01Z'],
    good: [
      '2026-08-01T09:00:00',
      '2026-08-01T09:00:00Z',
      '2026-08-01T09:00+02:00',
      '2026-12',
      '2027-12-01T10:00+01',
      '2026-100',
      '2026-W10-1T10:00Z',
      '2026-12-01T',
      'P1W2D',
    ],
    message: AT_SHAPE,
  },
  {
    particle: 'every',
    bad: ['bogus', '0 0 12 * * ? 2026', '@reboot'],
    good: [
      'R/PT10M',
      '0 0 12 * * ?',
      '@daily',
      'R3/2026-01-01T00:00:00/PT1H',
      'R/PT1H/2026-12-31T00:00:00',
      'R2/2026-01-01T00:00:00/2026-01-02T00:00:00',
    ],
    message: EVERY_SHAPE,
  },
];

checks(
  "Validation - the timer clause's shape, per carrier and per particle",
  TIMER_CARRIERS.flatMap(({ name, severity, source }) =>
    TIMER_PARTICLE_SHAPES.flatMap(
      ({ particle, bad, good, message }): Case[] => [
        ...bad.map((value): Case => [
          `${name} rejects '${particle}: "${value}"'`,
          source(particle, value),
          [severity === 'error' ? message : warn(message)],
        ]),
        ...good.map((value): Case => [
          `${name} accepts '${particle}: "${value}"'`,
          source(particle, value),
          [],
        ]),
      ],
    ),
  ),
);

checks('Validation - boundary hosts', [
  [
    'compensation has no attached form, so it refuses a host',
    `process p { subprocess S { user A on A: compensation { user Undo } } }`,
    [COMPENSATION_HOST],
  ],
  [
    'a host-less undo block is unaffected by that rule',
    `process p { subprocess S { user A on compensation { user Undo } } }`,
    [],
  ],
  [
    'a start event is no activity to attach to',
    `process p { error X start S on S: error(X) { user A } }`,
    [illegalHost('S', 'a start event')],
  ],
  [
    'an emit statement is no activity to attach to',
    `process p { error X user A emit signal Sig("S") on Sig: error(X) { user B } }`,
    [illegalHost('Sig', 'an emit statement')],
  ],
  [
    'an end event is no activity to attach to',
    `process p { error X start S end E on E: error(X) { user A } }`,
    [illegalHost('E', 'an end event')],
  ],
  [
    'a throw statement is no activity to attach to',
    `process p { error PAYMENT_FAILED throw error Foo(PAYMENT_FAILED) on Foo: escalation { user A } }`,
    [illegalHost('Foo', 'a throw statement')],
  ],
  [
    'an awaited event is no activity to attach to',
    `process p { error X await message Wait("M") on Wait: error(X) { user A } }`,
    [illegalHost('Wait', 'an awaited event')],
  ],
  [
    'every activity kind hosts a boundary event',
    `process p {
  error X
  user U
  service Svc(class: "x.Y")
  service Ext(topic: "t")
  script Scr ${FENCE}js
x = 1
${FENCE}
  subprocess Sub { user X }
  attempt Try { user Y }
  call C(process: "p")
  on U: error(X) { user R1 }
  on Svc: error(X) { user R2 }
  on Ext: error(X) { user R3 }
  on Scr: error(X) { user R4 }
  on Sub: error(X) { user R5 }
  on Try: error(X) { user R6 }
  on C: error(X) { user R7 }
}`,
    [],
  ],
  [
    'an escalation boundary refuses a service task',
    `process p { service Pack(class: "x.Y") on Pack: escalation { user A } }`,
    [escalationHost('Pack', 'a service task')],
  ],
  [
    'an escalation boundary refuses a script task',
    `process p { script Pack ${FENCE}js\nx = 1\n${FENCE} on Pack: escalation { user A } }`,
    [escalationHost('Pack', 'a script task')],
  ],
  // Operaton gates the escalation boundary on a subprocess scope, and it makes
  // an `attempt` block one, so the block is a legal host beside `subprocess`.
  [
    'an escalation boundary takes a subprocess, an attempt block, a call, and a user task',
    `process p {
  subprocess Sub { user X }
  attempt Try { user Y }
  call C(process: "p")
  user U
  on Sub: escalation { user A }
  on Try: escalation { user B }
  on C: escalation { user D }
  on U: escalation { user E }
}`,
    [],
  ],
  [
    'a host inside the handler own body could never run first',
    `process p { error X user A on Self: error(X) { user Self } }`,
    [selfAttachedHost('Self')],
  ],
  [
    "a host on a different handler's escape path is legal",
    `process p { error X escalation Y user A on A: error(X) { user Relay } on Relay: escalation(Y) { user B } }`,
    [],
  ],
  [
    'two handlers on one host with one code name the host',
    `process p { error X user Pack on Pack: error(X) { user A } on Pack: error(X) { user B } }`,
    [handlerDuplicate('error', code('X'), 'Pack')],
  ],
  [
    'one trigger and code on two hosts is no duplicate',
    `process p { error X user Pack1 user Pack2 on Pack1: error(X) { user A } on Pack2: error(X) { user B } }`,
    [],
  ],
  [
    'a hosted and a host-less handler of one code is no duplicate',
    `process p { error X user Pack on error(X) { user A } on Pack: error(X) { user B } }`,
    [],
  ],
  ...(['message', 'signal'] as const).map((trigger): Case => [
    `a ${trigger} handler inside a block and one attached to that block subscribe on one scope`,
    `process p { subprocess Sub { user A on ${trigger}("M") { user B } } on Sub: ${trigger}("M") { user C } }`,
    [handlerDuplicate(trigger, eventName('M'), 'Sub')],
  ]),
  [
    'a message handler inside a repeated block subscribes one scope below the boundary on it',
    `process p { var xs: json subprocess Sub for each x in xs { user A on message("M") { user B } } on Sub: message("M") { user C } }`,
    [],
  ],
  [
    'an error handler inside a block and one attached to that block catch on their own kinds',
    `process p { error X subprocess Sub { user A on error(X) { user B } } on Sub: error(X) { user C } }`,
    [],
  ],
  [
    'an escalation catch-all beside a coded catch, both attached to one host, is refused',
    `process p { escalation X subprocess Sub { user A } on Sub: escalation(X) { user B } on Sub: escalation { user C } }`,
    [escalationCatchAllBesideCoded('Sub')],
  ],
  [
    'an escalation catch-all beside a coded catch, both inside one block, is refused',
    `process p { escalation X subprocess Sub { user A on escalation { user B } on escalation(X) { user C } } }`,
    [escalationCatchAllBesideCoded('Sub')],
  ],
  [
    'an escalation catch-all inside a block beside a coded catch attached to it is the legal mix',
    `process p { escalation X subprocess Sub { user A on escalation { user B } } on Sub: escalation(X) { user C } }`,
    [],
  ],
  [
    'two escalation catch-alls attached to one host are refused',
    `process p { subprocess Sub { user A } on Sub: escalation { user B } on Sub: escalation { user C } }`,
    [handlerDuplicate('escalation', everyEvent, 'Sub')],
  ],
  [
    'two hosted timers on one host are legal',
    `process p { user Pack on Pack: timer("PT1H") { user A } on Pack: timer("PT2H") { user B } }`,
    [],
  ],
  [
    'a handler nested in a hosted body still lands in the host container',
    `process p { user A on A: message("M") { user B on A: message("M") { user C } } }`,
    [handlerDuplicate('message', eventName('M'), 'A')],
  ],
  [
    'an unresolved host reports only the resolution error',
    `process p { start S on message("M") { user A } on Missing: message("M") { user B } }`,
    [unresolvedStatement('Missing')],
  ],
  [
    'two host-less handlers of an unknown trigger word draw the unknown-kind error alone',
    `process p { user T on foo { user A } on foo { user B } }`,
    [unknownOnKind('foo'), unknownOnKind('foo')],
  ],
  [
    'a hosted error handler still cannot run alongside',
    `process p { error X user Pack on Pack: error(X, alongside) { user A } }`,
    [ERROR_ALWAYS_INTERRUPTS],
  ],
  [
    'a fully host-less program fires no boundary machinery',
    `process p {
  error X escalation Y
  var c: string
  start S
  user A
  end E
  on error(X, code: c) { user R }
  on escalation(Y, alongside) { user Q }
}`,
    [],
  ],
]);

checks('Validation - compensation', [
  [
    'a subprocess with an undo block is clean',
    `process p { subprocess S { user A on compensation { user Undo } } }`,
    [],
  ],
  [
    'an emitted and a named thrown compensation in a handler body are clean',
    `process p { error X user A on error(X) { emit compensation throw compensation Undo } }`,
    [],
  ],
  [
    'a variable named compensation coexists with the trigger word',
    `process p { var compensation: number if (compensation > 1) { user A } }`,
    [],
  ],
  [
    'an undo block names nothing, so a code string is dropped',
    `process p { subprocess S { on compensation("X") { user A } } }`,
    [blockNoFlowSteps('a subprocess', 'S'), COMPENSATION_NO_CODE],
  ],
  [
    'an undo block carries no values, so bindings are dropped',
    `process p { subprocess S { on compensation(code: c) { user A } } }`,
    [blockNoFlowSteps('a subprocess', 'S'), COMPENSATION_BINDINGS],
  ],
  [
    'the work an undo block reverses has finished, so alongside is dropped',
    `process p { subprocess S { on compensation(alongside) { user A } } }`,
    [blockNoFlowSteps('a subprocess', 'S'), COMPENSATION_ALONGSIDE],
  ],
  [
    'a timer key on an undo block is the inherited timer-only rule',
    `process p { subprocess S { start In on compensation(at: "PT1H") { user A } } }`,
    [PARTICLE_ONLY],
  ],
  [
    'a condition on an undo block is the inherited condition-only rule',
    `process p { var amount: number subprocess S { start In on compensation(amount > 100) { user A } } }`,
    [CONDITION_ONLY],
  ],
  [
    'a process cannot undo itself',
    `process p { on compensation { user A } }`,
    [noFlowSteps('p'), COMPENSATION_PLACEMENT],
  ],
  [
    'a handler body is no subprocess to undo either',
    `process p { error X on error(X) { on compensation { user A } } }`,
    [noFlowSteps('p'), COMPENSATION_PLACEMENT],
  ],
  [
    'an undo block in a branch is the generic placement error, once',
    `process p { subprocess S { if (true) { on compensation { user A } } } }`,
    [HANDLER_PLACEMENT],
  ],
  [
    'two undo blocks in one subprocess merge into one',
    `process p { subprocess S { on compensation { user A } on compensation { user B } } }`,
    [COMPENSATION_DUPLICATE, blockNoFlowSteps('a subprocess', 'S')],
  ],
  [
    'two undo blocks in one attempt block merge the same way',
    `process p { attempt A { on compensation { user U1 } on compensation { user U2 } } }`,
    [COMPENSATION_DUPLICATE, blockNoFlowSteps('an attempt block', 'A')],
  ],
  [
    'one undo block in each of two subprocesses is clean',
    `process p {
  subprocess S1 { user A on compensation { user U1 } }
  subprocess S2 { user B on compensation { user U2 } }
}`,
    [],
  ],
  [
    "'throw compensate' is a did-you-mean",
    `process p { throw compensate }`,
    [COMPENSATE_TYPO],
  ],
  [
    "'emit compensate' is a did-you-mean",
    `process p { emit compensate }`,
    [COMPENSATE_TYPO],
  ],
  [
    "'await compensate' is a did-you-mean",
    `process p { await compensate }`,
    [COMPENSATE_TYPO],
  ],
]);

checks('Validation - the cancel end and its handler', [
  [
    'a cancel end in an attempt block with its handler beside it is clean',
    `process p {
  var declined: boolean
  start S
  attempt A {
    service Charge(topic: "charge")
    if (declined) { end GaveUp cancel(label: "Give up the booking") }
    service Issue(topic: "issue")
  }
  end Done
  on A: cancel { user Apologize end Cancelled }
}`,
    [],
  ],
  [
    'a cancel end in a handler hosted on a step of the block gives up that block',
    `process p {
  error X
  start S
  attempt A { user U on U: error(X) { user V end GaveUp cancel } }
  end Done
  on A: cancel { user W end Cancelled }
}`,
    [],
  ],
  [
    'a cancel end in a process body has no block to give up',
    `process p { start S end E cancel }`,
    [CANCEL_END_PLACEMENT],
  ],
  [
    'a cancel end in a plain subprocess body has none either',
    `process p { start S subprocess Sub { user A end E cancel } end Done }`,
    [CANCEL_END_PLACEMENT],
  ],
  [
    'a cancel end in a subprocess nested in an attempt gives up the subprocess',
    `process p { start S attempt A { subprocess Sub { user T end E cancel } } end Done }`,
    [CANCEL_END_PLACEMENT],
  ],
  [
    'a cancel end in a handler body inside an attempt is not directly in the block',
    `process p { error X start S attempt A { user B on error(X) { user C end E cancel } } end Done }`,
    [CANCEL_END_PLACEMENT],
  ],
  [
    'a code string after cancel names cancel, not terminate',
    `process p { start S attempt A { user B end E cancel("X") } end Done on A: cancel { user C end F } }`,
    [CANCEL_NAMES_NOTHING],
  ],
  [
    'a cancel handler on a plain subprocess names what the host is',
    `process p { start S subprocess Sub { user A } end Done on Sub: cancel { user B end E } }`,
    [cancelHost('Sub', 'a subprocess')],
  ],
  [
    'a host-less cancel handler points at the hosted spelling',
    `process p { start S user A on cancel { user B end E } }`,
    [CANCEL_HOSTLESS],
  ],
  [
    'a cancel handler cannot run alongside the block it drains',
    `process p { start S attempt A { user B end G cancel } end Done on A: cancel(alongside) { user C end E } }`,
    [CANCEL_ALONGSIDE],
  ],
  [
    'a cancel handler catches nothing by name',
    `process p { start S attempt A { user B end G cancel } end Done on A: cancel("X") { user C end E } }`,
    [CANCEL_NO_CODE],
  ],
  [
    'two cancel handlers on one block are the generic duplicate',
    `process p {
  start S
  attempt A { user B end G cancel }
  end Done
  on A: cancel { user C end E1 }
  on A: cancel { user D end E2 }
}`,
    [handlerDuplicate('cancel', everyEvent, 'A')],
  ],
  [
    'an undo block directly inside an attempt block is clean',
    `process p { start S attempt A { user B on compensation { user Undo } } end Done }`,
    [],
  ],
  [
    'an attempt block carries the settings a subprocess carries',
    `process p { start S attempt A(asyncBefore: true) { user B } end Done }`,
    [],
  ],
  [
    'a cancel end with no handler stops the run',
    `process p { start S attempt A { user B end G cancel } end Done }`,
    [warn(cancelEndWithoutHandler('A'))],
  ],
  [
    'a cancel handler on a block that never gives itself up never runs',
    `process p { start S attempt A { user B } end Done on A: cancel { user C end E } }`,
    [warn(cancelHandlerWithoutEnd('A'))],
  ],
  [
    "a nested block's cancel end does not pair with the outer handler",
    `process p {
  start S
  attempt A {
    attempt B { user C end G cancel }
    on B: cancel { user D end E }
  }
  end Done
  on A: cancel { user F end H }
}`,
    [warn(cancelHandlerWithoutEnd('A'))],
  ],
  [
    "'throw cancel' points at the end that gives the block up",
    `process p { start S throw cancel }`,
    [CANCEL_NOT_RAISED],
  ],
  [
    "'emit cancel' points there too",
    `process p { start S emit cancel }`,
    [CANCEL_NOT_RAISED],
  ],
  [
    "'await cancel' points at the end and at the handler that catches it",
    `process p { start S await cancel }`,
    [CANCEL_NOT_AWAITED],
  ],
]);

checks('Validation - throw and emit', [
  [
    "'emit error' points at 'throw error'",
    `process p { error X emit error(X) }`,
    [EMIT_ERROR],
  ],
  [
    'an unknown throw kind names the kinds with a terminal form',
    `process p { throw banana("X") }`,
    [unknownThrowKind('banana')],
  ],
  [
    'an unknown emit kind leaves error off the list',
    `process p { emit banana("X") }`,
    [unknownEmitKind('banana')],
  ],
  [
    'a thrown error with no code names the shape',
    `process p { throw error }`,
    [codeRequired('A thrown', 'error', 'throw')],
  ],
  [
    'an emitted signal with no code names the shape',
    `process p { emit signal }`,
    [codeRequired('An emitted', 'signal', 'emit')],
  ],
  [
    'an empty code is the same mistake as an omitted one',
    `process p { throw escalation("") }`,
    [codeRequired('A thrown', 'escalation', 'throw')],
  ],
  [
    'a thrown compensation names nothing',
    `process p { throw compensation("X") }`,
    [throwCompensationNames('throw')],
  ],
  [
    'a bare thrown compensation is clean',
    `process p { throw compensation }`,
    [],
  ],
  [
    'a thrown message is clean',
    `process p { start S throw message("Ack") }`,
    [],
  ],
  [
    'an emitted message is clean',
    `process p { start S emit message("Ack") }`,
    [],
  ],
  [
    'a thrown message with no code names the shape',
    `process p { start S throw message }`,
    [codeRequired('A thrown', 'message', 'throw')],
  ],
  [
    'a thrown signal is clean',
    `process p { start S throw signal("Alert") }`,
    [],
  ],
  [
    'an emitted signal is clean',
    `process p { start S emit signal("Ping") user A }`,
    [],
  ],
  [
    'a thrown message carries a class implementation',
    `process p { start S throw message("Ack", class: "com.example.Send") }`,
    [],
  ],
  [
    'a thrown message carries an expression implementation',
    `process p { start S throw message("Ack", expression: "\${sender.send(order)}") }`,
    [],
  ],
  [
    'a thrown message carries a delegate implementation',
    `process p { start S throw message("Ack", delegate: "\${senderBean}") }`,
    [],
  ],
  [
    'a thrown message carries a topic implementation',
    `process p { start S throw message("Ack", topic: "send-ack") }`,
    [],
  ],
  [
    'an emitted message carries a class implementation',
    `process p { start S emit message("Ack", class: "com.example.Send") }`,
    [],
  ],
  [
    'an emitted message carries a topic implementation',
    `process p { start S emit message("Ack", topic: "send-ack") }`,
    [],
  ],
  [
    'only a message really sends, so a thrown error carries no implementation',
    `process p { error X start S throw error(X, class: "c") }`,
    [noImplementation('class', 'a thrown error')],
  ],
  [
    'a binding key beside an engine setting on a thrown error still draws only the binding error',
    `process p { error X start S throw error(X, class: "c", asyncBefore: true) }`,
    [noImplementation('class', 'a thrown error')],
  ],
  [
    'an emitted signal carries none either',
    `process p { start S emit signal("Ready", class: "c") }`,
    [noImplementation('class', 'an emitted signal')],
  ],
  [
    'a thrown message with two implementations names both',
    `process p { start S throw message("Ack", class: "a", expression: "\${b}") }`,
    [bindingConflict('A thrown message', 'class, expression', THROW_BINDINGS)],
  ],
  [
    'a goto targeting a named throw resolves',
    `process p { error X var cond: boolean start S if (cond) { goto Failed } throw error Failed(X) }`,
    [],
  ],
]);

checks('Validation - awaited events', [
  ['an awaited message is clean', `process p { await message("M") }`, []],
  ['an awaited timer is clean', `process p { await timer("PT1H") }`, []],
  ['an awaited signal is clean', `process p { await signal("S") }`, []],
  [
    'an awaited condition is clean',
    `process p { var x: number await condition(x > 1) }`,
    [],
  ],
  [
    'an error is raised outward, so it cannot be awaited',
    `process p { error E await error(E) }`,
    [unknownAwaitKind('error')],
  ],
  [
    'an escalation cannot be awaited either',
    `process p { escalation E await escalation(E) }`,
    [unknownAwaitKind('escalation')],
  ],
  [
    'compensation runs through an undo block, not an await',
    `process p { await compensation }`,
    [unknownAwaitKind('compensation')],
  ],
  [
    'an unknown word names the kinds an await takes and where the rest are written',
    `process p { start S await nonsense }`,
    [unknownAwaitKind('nonsense')],
  ],
  [
    'an awaited message with no name asks for it',
    `process p { await message }`,
    [awaitNameRequired('message')],
  ],
  [
    'an awaited signal with no name asks for it',
    `process p { await signal }`,
    [awaitNameRequired('signal')],
  ],
  [
    'an awaited timer with no payload asks how to read the time',
    `process p { await timer }`,
    [TIMER_PAYLOAD],
  ],
  [
    'an awaited condition with no parens asks for the condition',
    `process p { await condition }`,
    [AWAIT_CONDITION_REQUIRED],
  ],
  [
    'a timer key on an awaited message belongs to a timer',
    `process p { await message(at: "PT1H") }`,
    [awaitNameRequired('message'), AWAIT_PARTICLE_ONLY],
  ],
  [
    'a condition on an awaited message belongs to an awaited condition',
    `process p { var x: number await message(x > 1) }`,
    [awaitNameRequired('message'), AWAIT_CONDITION_ONLY],
  ],
  [
    'a code string on an awaited condition is not the condition',
    `process p { await condition("X") }`,
    [AWAIT_CONDITION_NO_CODE],
  ],
  [
    'an awaited condition carrying both mistakes reports them left to right',
    `process p { await condition("X", at: "2026-01-01") }`,
    [AWAIT_CONDITION_NO_CODE, AWAIT_PARTICLE_ONLY],
  ],
  [
    'a race branch takes the settings keys an awaited event takes',
    `process p { await { message("M", assignee: "u") { user A } signal("S") { user B } } }`,
    [notValidOn('assignee', 'a branch of an await block')],
  ],
  ...(['message', 'signal'] as const).map((trigger): Case => [
    `two ${trigger} branches of one race on one name subscribe twice on the gateway`,
    `process p { await { ${trigger}("Dup") { user A } timer("PT1H") { user T } ${trigger}("Dup") { user B } } }`,
    [raceDuplicate(trigger, 'Dup')],
  ]),
  [
    'a message branch and a signal branch of one name are two subscriptions',
    `process p { await { message("Dup") { user A } signal("Dup") { user B } } }`,
    [],
  ],
]);

describe('Validation - a race branch runs the plain await rules', () => {
  test.each([
    'message("M")',
    'timer("PT1H")',
    'signal("S")',
    'condition(amount > 100)',
  ])('a branch headed `%s` validates clean', async (head) => {
    expect(
      await diagnosticsOf(`
process p {
  var amount: number
  await {
    ${head} { user A }
    signal("Other") { user B }
  }
}
`),
    ).toEqual([]);
  });

  test.each(['error(E)', 'message', 'timer', 'condition("X")', 'condition'])(
    'a branch headed `%s` gets the diagnostics a plain await gives',
    async (head) => {
      const inRace = await diagnosticsOf(`
process p {
  error E
  var amount: number
  await {
    ${head} { user A }
    signal("S") { user B }
  }
}
`);
      const alone = await diagnosticsOf(`
process p {
  error E
  var amount: number
  await ${head}
}
`);
      expect(alone).not.toHaveLength(0);
      expect(inRace).toEqual(alone);
    },
  );
});

checks('Validation - link events', [
  [
    'a link pair in one container is clean, and the catch opens a new chain after the throw',
    `process p { start S step Try emit link ToRetry("Retry") await link AtRetry("Retry") step Fix goto Try }`,
    [],
  ],
  [
    'a step after an emit link can never run',
    `process p { step A emit link T("L") step Dead await link C("L") }`,
    [UNREACHABLE],
  ],
  [
    'a link catch after a live step refuses the flow that would enter it',
    `process p { step A await link C("L") step B emit link T("L") }`,
    [LINK_CATCH_FLOW],
  ],
  [
    'a link cannot head a race branch',
    `process p { await { link("L") { user A } message("M") { user B } } }`,
    [LINK_IN_RACE],
  ],
  [
    'an awaited link with no name asks for it',
    `process p { step A end E await link C }`,
    [awaitNameRequired('link')],
  ],
  [
    'an emitted link with no name asks for it',
    `process p { step A emit link }`,
    [codeRequired('An emitted', 'link', 'emit')],
  ],
  [
    'a bareword link name is a missing pair of quotes',
    `process p { step A emit link T(Retry) await link C(Retry) }`,
    [barewordName('link', 'Retry'), barewordName('link', 'Retry')],
  ],
  [
    'engine settings and listeners on an emitted link are refused, one each',
    `process p { step A emit link T("L", asyncBefore: true, jobPriority: 5) { on end(class: "x.L") } await link C("L") }`,
    [
      linkThrowNeverRuns("Setting 'asyncBefore'"),
      linkThrowNeverRuns("Setting 'jobPriority'"),
      linkThrowNeverRuns("The 'on end' listener"),
    ],
  ],
  [
    'an emit link with no catch is refused',
    `process p { step A emit link T("L") }`,
    [linkNoCatch('L')],
  ],
  [
    'a binding key on an emit link draws its own not-valid error alone, not the never-runs message too',
    `process p { step A emit link T("L", topic: "shipping") await link C("L") }`,
    [noImplementation('topic', 'an emitted link')],
  ],
  [
    'a link catch in another container is out of reach',
    `process p { subprocess S { step A emit link T("L") } end E await link C("L") step B }`,
    [linkOtherContainer('L')],
  ],
  [
    'an emit link cannot enter a parallel branch from outside it',
    `process p { parallel { { user P if (c) { emit link T("L") } } { end X await link C("L") user B } } }`,
    [warn(undeclared('c')), linkIntoBranch('L', 'parallel')],
  ],
  [
    'two catches of one link name are refused even across subprocesses',
    `process p { step A emit link T("L") await link C1("L") subprocess S { step B emit link T2("L") await link C2("L") step D } }`,
    [linkNameTaken('L')],
  ],
  [
    'a link catch nothing emits is a warning, not an error',
    `process p { step A end E await link C("L") step B }`,
    [warn(linkUnused('L'))],
  ],
  [
    'a goto cannot target a link catch',
    `process p { step A if (c) { goto C } emit link T("L") await link C("L") step B }`,
    [warn(undeclared('c')), gotoToLink('C')],
  ],
  [
    'throw link points at emit link',
    `process p { step A throw link("L") }`,
    [THROW_LINK],
  ],
]);

checks('Validation - start triggers', [
  [
    'a message start naming the message is clean',
    `process p { start S message("OrderReceived") user A }`,
    [],
  ],
  [
    'a signal start naming the signal is clean',
    `process p { start S signal("Ready") user A }`,
    [],
  ],
  [
    "a timer start with 'after' is clean",
    `process p { start S timer("PT1H") user A }`,
    [],
  ],
  [
    "a timer start with 'at' is clean",
    `process p { start S timer(at: "2026-08-01T09:00:00") user A }`,
    [],
  ],
  [
    'a repeating timer start is a schedule, not a mistake',
    `process p { start S timer(every: "R/PT10M") user A }`,
    [],
  ],
  [
    'a label between the name and the trigger is clean',
    `process p { start S timer("PT1H", label: "Scheduled") user A }`,
    [],
  ],
  [
    'a message start with no name names what the engine matches on',
    `process p { start S message }`,
    [startNameRequired('message')],
  ],
  [
    'a signal start with no name names what the engine matches on',
    `process p { start S signal }`,
    [startNameRequired('signal')],
  ],
  [
    'a timer start with no payload asks how to read the time',
    `process p { start S timer }`,
    [TIMER_PAYLOAD],
  ],
  [
    'a timer key on a non-timer start belongs to a timer',
    `process p { start S message(at: "PT1H") }`,
    [startNameRequired('message'), START_PARTICLE_ONLY],
  ],
  [
    'the engine ignores an error start',
    `process p { error X start S error(X) }`,
    [startRaisedKind('error')],
  ],
  [
    'the engine ignores an escalation start',
    `process p { escalation X start S escalation(X) }`,
    [startRaisedKind('escalation')],
  ],
  [
    'a compensation start points at the undo block',
    `process p { start S compensation }`,
    [START_COMPENSATION],
  ],
  [
    'a condition start carrying its condition is clean',
    `process p { var amount: number start S condition(amount > 100) user A }`,
    [],
  ],
  [
    'a condition start with no condition asks for it',
    `process p { start S condition }`,
    [START_CONDITION_REQUIRED],
  ],
  [
    'a code string on a condition start is not the condition',
    `process p { start S condition("X") }`,
    [START_CONDITION_NO_CODE],
  ],
  [
    'a condition start carrying both mistakes reports them left to right',
    `process p { start S condition("X", at: "2026-01-01") }`,
    [START_CONDITION_NO_CODE, START_PARTICLE_ONLY],
  ],
  [
    'a condition on a message start belongs to a condition start',
    `process p { var amount: number start S message(amount > 100) }`,
    [startNameRequired('message'), START_CONDITION_ONLY],
  ],
  [
    'the near-miss spelling is answered as a typo',
    `process p { start S conditional }`,
    [CONDITIONAL_TYPO],
  ],
  [
    'an unknown start kind names the legal ones',
    `process p { start S nonsense("X") }`,
    [unknownStartKind('nonsense')],
  ],
  [
    'a message start name cannot hold a trailing expression',
    `process p { start S message("Order\${x}") }`,
    [startMessageExpression('Order${x}')],
  ],
  [
    'a message start name cannot hold a whole expression',
    `process p { start S message("#{orderType}") }`,
    [startMessageExpression('#{orderType}')],
  ],
  [
    'the other expression spelling is rejected too',
    `process p { start S message("Order#{x}") }`,
    [startMessageExpression('Order#{x}')],
  ],
  [
    'a signal start name may hold an expression',
    `process p { start S signal("Order\${x}") user A }`,
    [],
  ],
  [
    'a signal start name may hold the other spelling',
    `process p { start S signal("#{orderType}") user A }`,
    [],
  ],
  [
    'an awaited message name may hold an expression: the process is running',
    `process p { start S await message("Order\${x}") user A }`,
    [],
  ],
  [
    'an awaited message name may hold the other spelling',
    `process p { start S await message("#{orderType}") user A }`,
    [],
  ],
  [
    'a handler message name may hold an expression',
    `process p { start S user A on message("Order\${x}") { user B } }`,
    [],
  ],
  [
    'only the process own start carries a trigger, not a subprocess start',
    `process p { start S subprocess Sub { start In message("M") user A } end E }`,
    [startTriggerInBlock('a subprocess')],
  ],
  [
    'an attempt block start is named for its head',
    `process p { start S attempt A { start In message("M") user B } end E }`,
    [startTriggerInBlock('an attempt block')],
  ],
  [
    "a handler body's start catches what the handler catches",
    `process p { error X start S on error(X) { start In message("M") user A end Out } }`,
    [START_TRIGGER_IN_HANDLER],
  ],
  [
    'a triggered start nested in a plain branch draws no block-specific message, just the ordinary positional one',
    `process p { start S if (true) { start In message("M") } end E }`,
    [startNotFirst('In')],
  ],
]);

checks('Validation - end triggers', [
  [
    'a terminate end in a process body is clean',
    `process p { start S user A end E terminate }`,
    [],
  ],
  [
    'a terminate end in a subprocess body is clean',
    `process p { start S subprocess Sub { user A end E terminate } end Done }`,
    [],
  ],
  [
    'a terminate end in a handler body is clean',
    `process p { error X start S user A on error(X) { user B end E terminate } }`,
    [],
  ],
  [
    'a label before terminate is clean',
    `process p { start S user A end E terminate(label: "All stop") }`,
    [],
  ],
  [
    'terminate names nothing',
    `process p { start S end E terminate("X") }`,
    [TERMINATE_NAMES_NOTHING],
  ],
  [
    'an error is raised with throw, not on an end',
    `process p { error Ack start S end E error(Ack) }`,
    [endRaisedKind('error', 'An')],
  ],
  [
    'an escalation is raised with throw',
    `process p { escalation Ack start S end E escalation(Ack) }`,
    [endRaisedKind('escalation', 'An')],
  ],
  [
    'a message is raised with throw',
    `process p { start S end E message("Ack") }`,
    [endRaisedKind('message', 'A')],
  ],
  [
    'a signal is raised with throw',
    `process p { start S end E signal("Ack") }`,
    [endRaisedKind('signal', 'A')],
  ],
  [
    'a compensation is raised with throw',
    `process p { start S end E compensation("Ack") }`,
    [endRaisedKind('compensation', 'A')],
  ],
  [
    'a timer end names the places a timer belongs',
    `process p { start S end E timer("PT1H") }`,
    [END_TIMER],
  ],
  [
    'a condition end names the places a condition belongs',
    `process p { start S end E condition }`,
    [END_CONDITION],
  ],
  [
    'the near-miss spelling gets the same answer',
    `process p { start S end E conditional }`,
    [END_CONDITION],
  ],
  [
    'an unknown end kind names both end words and the throw alternative',
    `process p { start S end E nonsense }`,
    [unknownEndKind('nonsense')],
  ],
  // The advice is only useful if the placements it quotes validate.
  [
    'the three timer placements the advice names validate',
    `process p {
  start S
  await timer("PT1H")
  user R
  on timer("PT1H") { user B end H }
  on R: timer("PT1H") { user C end I }
}`,
    [],
  ],
  [
    'the three condition placements the advice names validate',
    `process p {
  var amount: number
  start S
  await condition(amount > 100)
  user R
  on condition(amount > 100) { user B end H }
  on R: condition(amount > 100) { user C end I }
}`,
    [],
  ],
  [
    'a variable named terminate coexists with a terminating end',
    `process p { var terminate: string start S if (terminate == "x") { user A } end Done terminate }`,
    [],
  ],
]);

checks('Validation - a message or signal name is text, not a reference', [
  [
    'a message start names its subscription',
    `process p { start S message(OrderReceived) user U }`,
    [barewordName('message', 'OrderReceived')],
  ],
  [
    'a signal start names its subscription',
    `process p { start S signal(Ready) user U }`,
    [barewordName('signal', 'Ready')],
  ],
  [
    'an awaited message names its subscription',
    `process p { await message(OrderReceived) }`,
    [barewordName('message', 'OrderReceived')],
  ],
  [
    'a message handler names its subscription',
    `process p { start S on message(OrderReceived) { user A } }`,
    [barewordName('message', 'OrderReceived')],
  ],
  [
    'a thrown message names its subscription',
    `process p { start S throw message(OrderReceived) }`,
    [barewordName('message', 'OrderReceived')],
  ],
  [
    'an emitted signal names its subscription',
    `process p { start S emit signal(Ready) user U }`,
    [barewordName('signal', 'Ready')],
  ],
  [
    'a race branch head names its subscription',
    `process p { await { message(OrderReceived) { user A } timer("PT1H") { user B } } }`,
    [barewordName('message', 'OrderReceived')],
  ],
  [
    'an error code is a declared name and stays one',
    `process p { error E start S throw error(E) }`,
    [],
  ],
]);

/**
 * A paren item is one of several, so a diagnostic reported on the whole list
 * would underline whichever came first. Every source below writes the offending
 * item second.
 */
describe('Validation - paren items, reported in place', () => {
  test.each([
    [
      "a flag carries the error about the flag, not the handler's code",
      `process p { error E start S on error(E, alongside) { end F } }`,
      'alongside',
    ],
    [
      'a terminate end carries it on the payload it must not name',
      `process p { start S end T terminate(asyncBefore: true, "X") }`,
      '"X"',
    ],
    [
      'a message start carries it on the name holding the expression',
      `process p { start S message(asyncBefore: true, "\${x}") }`,
      '"${x}"',
    ],
    [
      'an awaited condition carries it on the code string',
      `process p { await condition(asyncBefore: true, "X") }`,
      '"X"',
    ],
    [
      'a condition handler carries it on the code string',
      `process p { start S on condition(asyncBefore: true, "X") { end F } }`,
      '"X"',
    ],
    [
      'a compensation handler carries it on the payload it must not name',
      `process p { subprocess S { user U on compensation(asyncBefore: true, "X") { user C } } }`,
      '"X"',
    ],
    [
      'a cancel handler carries it on the payload it must not name',
      `process p { attempt A { user U end G cancel } on A: cancel(asyncBefore: true, "X") { end F } }`,
      '"X"',
    ],
    [
      'an error handler carries it on the empty code',
      `process p { start S on error(asyncBefore: true, "") { end F } }`,
      '""',
    ],
    [
      'a thrown error carries it on the empty code',
      `process p { start S throw error(asyncBefore: true, "") }`,
      '""',
    ],
    [
      'a thrown compensation carries it on the payload it must not name',
      `process p { start S throw compensation(asyncBefore: true, "X") }`,
      '"X"',
    ],
  ])('%s', async (_title, source, item) => {
    const { diagnostics } = await validate(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.range).toEqual({
      start: { line: 0, character: source.indexOf(item) },
      end: { line: 0, character: source.indexOf(item) + item.length },
    });
  });
});

checks('Validation - code declarations', [
  [
    'an error carrying a code and a message and a bare escalation both declare cleanly',
    `process p { error OUT_OF_STOCK(code: "order.failed", message: "Out of stock") escalation MANUAL_REVIEW user A }`,
    [],
  ],
  [
    'an unknown declaration kind names the kinds a declaration takes',
    `process p { usr Review user A }`,
    [unknownCodeDeclarationKind('usr')],
  ],
  [
    'a mistyped step keyword is named rather than blamed on the brace after it',
    `process p { usr Review { } }`,
    [
      "Expecting token of type '}' but found `{`.",
      'Expecting end of file but found `}`.',
      noFlowSteps('p'),
      unknownCodeDeclarationKind('usr'),
    ],
  ],
  [
    'a second declaration of one name is refused',
    `process p { error A escalation A user U }`,
    [alreadyDeclared('escalation', 'A')],
  ],
  [
    'a second declaration of one code is refused',
    `process p { error A error B(code: "A") user U }`,
    [duplicateDeclaredCode('error', 'A', 'A')],
  ],
  [
    'one code declared once per kind is no collision',
    `process p { error X escalation Y(code: "X") user U }`,
    [],
  ],
  [
    'a repeated name reports the name alone, since it repeats the code it stands for',
    `process p { error A error A user U }`,
    [alreadyDeclared('error', 'A')],
  ],
  [
    'a repeated name still reports a code it shares with a third declaration',
    `process p { error A(code: "PA") error A(code: "PB") error C(code: "PB") user U }`,
    [alreadyDeclared('error', 'A'), duplicateDeclaredCode('error', 'PB', 'A')],
  ],
  [
    'two empty codes name nothing, so neither collides with the other',
    `process p { error A(code: "") error B(code: "") user U }`,
    [declarationEmpty('error', 'code'), declarationEmpty('error', 'code')],
  ],
  [
    'a setting a declaration does not take, and a message on an escalation, are both refused',
    `process p { escalation E(message: "m", wibble: "x") user A }`,
    [
      notValidOn('wibble', 'an escalation declaration'),
      ESCALATION_HAS_NO_MESSAGE,
    ],
  ],
  [
    'a second setting of one key is refused',
    `process p { error E(code: "a", code: "b") user U }`,
    [duplicateSetting('code')],
  ],
  [
    'an unquoted code is a missing pair of quotes, not an undeclared variable',
    `process p { error E(code: FOO) user A }`,
    [declarationNotAString('error', 'code')],
  ],
  [
    'an empty code and an empty message name nothing',
    `process p { error E(code: "", message: "") user U }`,
    [declarationEmpty('error', 'code'), declarationEmpty('error', 'message')],
  ],
  [
    'a declaration writes its message by key rather than as a bare value',
    `process p { error E("Out of stock") user A }`,
    [DECLARATION_SETTINGS_ONLY],
  ],
  [
    'a bare word in a declaration is refused, and is no undeclared variable',
    `process p { error E(SOMETHING) user A }`,
    [DECLARATION_SETTINGS_ONLY],
  ],
  [
    'a declaration may carry the name of a step',
    `process p { error Pack user Pack }`,
    [],
  ],
  // The grammar admits the string here and always will, since a message name
  // is written the same way; only this rule separates the two.
  [
    'a thrown code is a declared name, not quoted text',
    `process p { start S throw error("PAYMENT_DECLINED") }`,
    [quotedCode('error', 'error PAYMENT_DECLINED', 'PAYMENT_DECLINED')],
  ],
  [
    'text no name could spell is declared under a name the author picks',
    `process p { start S emit escalation("review.manual") }`,
    [
      quotedCode(
        'escalation',
        'escalation <NAME>(code: "review.manual")',
        '<NAME>',
      ),
    ],
  ],
  [
    'a caught code is a declared name too',
    `process p { start S user T on error("X") { user U } }`,
    [quotedCode('error', 'error X', 'X')],
  ],
  [
    'a message name stays quoted text, since it declares nothing',
    `process p { start S await message("OrderReceived") end E }`,
    [],
  ],
]);

/**
 * Each of the four minimal task kinds, all named `X` so a `goto` and a boundary
 * host read the same for every row.
 */
const TASK_KINDS: Array<
  [kind: string, description: string, statement: string]
> = [
  ['step', 'a step', 'step X'],
  ['send', 'a send task', 'send X(class: "com.example.Send")'],
  ['receive', 'a receive task', 'receive X'],
  ['decide', 'a decision step', 'decide X(decision: "riskRating")'],
];

describe('Validation - the task kinds', () => {
  test.each(TASK_KINDS)(
    'a %s is clean in a process body, a subprocess body, and a handler body',
    async (_kind, _description, statement) => {
      for (const program of [
        `process p { ${statement} }`,
        `process p { subprocess S { ${statement} } }`,
        `process p { start S on error { ${statement} } }`,
      ]) {
        expect(await diagnosticsOf(program), program).toEqual([]);
      }
    },
  );

  test.each(TASK_KINDS)(
    'a timer boundary event attaches to a %s',
    async (_kind, _description, statement) => {
      expect(
        await diagnosticsOf(
          `process p { ${statement} on X: timer("PT1H") { user A } }`,
        ),
      ).toEqual([]);
    },
  );

  test.each(TASK_KINDS)(
    'an escalation boundary event does not attach to a %s',
    async (_kind, description, statement) => {
      expect(
        await diagnosticsOf(
          `process p { ${statement} on X: escalation { user A } }`,
        ),
      ).toEqual([escalationHost('X', description)]);
    },
  );

  test.each(TASK_KINDS)(
    'a goto resolves into a %s',
    async (_kind, _description, statement) => {
      expect(
        await diagnosticsOf(`process p { user A goto X ${statement} }`),
      ).toEqual([]);
    },
  );

  test.each(TASK_KINDS)(
    'a %s repeating an earlier step name is ambiguous',
    async (_kind, _description, statement) => {
      expect(await diagnosticsOf(`process p { user X ${statement} }`)).toEqual([
        duplicateStepName('X', 'p'),
      ]);
    },
  );

  test.each([
    ['class', 'a step', `process p { step T(class: "com.example.X") }`],
    ['decision', 'a receive task', `process p { receive R(decision: "d") }`],
    [
      'message',
      'a send task',
      `process p { send N(class: "com.example.Send", message: "M") }`,
    ],
  ])(
    "'%s' on an element that does not own it names the element",
    async (key, description, program) => {
      expect(await diagnosticsOf(program)).toEqual([
        notValidOn(key, description),
      ]);
    },
  );
});

const TASK_KIND_BLOCKS = BLOCK_HOSTS.filter(([kind]) =>
  TASK_KINDS.some(([taskKind]) => taskKind === kind),
);

/**
 * `label` and `documentation` share their whole derivation: both are owned by
 * exactly the kinds lowering to a BPMN node with a name slot. Each key runs
 * against every host so neither stands in for the other.
 */
const NAME_SLOT_HOSTS = ['label', 'documentation'].flatMap((key) =>
  BLOCK_HOSTS.map(
    ([kind, description, , settings]) =>
      [key, kind, description, settings] as const,
  ),
);

describe('Validation - every element with settings and a member block', () => {
  test.each(BLOCK_HOSTS)(
    'the engine settings are accepted on %s',
    async (_kind, _description, _members, settings) => {
      expect(await diagnosticsOf(settings(ENGINE_SETTINGS))).toEqual([]);
    },
  );

  test.each(BLOCK_HOSTS)(
    'an unknown key on %s names the element kind',
    async (_kind, description, _members, settings) => {
      expect(await diagnosticsOf(settings('wibble: 1'))).toEqual([
        notValidOn('wibble', description),
      ]);
    },
  );

  // Every flag word lexes as a flag inside any parens, being a keyword
  // elsewhere in the grammar, so one written out of place reaches the validator
  // rather than the parser.
  test.each(BLOCK_HOSTS)(
    'a stray flag on %s names the element kind',
    async (_kind, description, _members, settings) => {
      expect(await diagnosticsOf(settings('sequentially'))).toEqual([
        flagNotValidOn('sequentially', description),
      ]);
    },
  );

  test.each(NAME_SLOT_HOSTS.filter(([, kind]) => LABEL_HOSTS.has(kind)))(
    '%s is accepted on %s',
    async (key, _kind, _description, settings) => {
      expect(await diagnosticsOf(settings(`${key}: "L"`))).toEqual([]);
    },
  );

  test.each(NAME_SLOT_HOSTS.filter(([, kind]) => !LABEL_HOSTS.has(kind)))(
    '%s on %s names the element kind, having no name slot to land in',
    async (key, _kind, description, settings) => {
      expect(await diagnosticsOf(settings(`${key}: "L"`))).toEqual([
        notValidOn(key, description),
      ]);
    },
  );

  test.each(BLOCK_HOSTS)(
    'an execution listener is accepted on %s',
    async (_kind, _description, program) => {
      expect(
        await diagnosticsOf(program('on start(class: "com.example.L")')),
      ).toEqual([]);
    },
  );

  test.each(TASK_KIND_BLOCKS)(
    'a task listener is not accepted on %s',
    async (_kind, description, program) => {
      expect(
        await diagnosticsOf(program('on create(class: "com.example.L")')),
      ).toEqual([taskListenerOnly('create', description)]);
    },
  );

  // `call` is absent from both lists: its body has no `form` member at all, so
  // a form written there is a parse error rather than this diagnostic.
  test.each(
    BLOCK_HOSTS.filter(([kind]) => !FORM_HOSTS.has(kind) && kind !== 'call'),
  )(
    'a form block on %s names the element kind',
    async (_kind, description, program) => {
      expect(await diagnosticsOf(program('form { a: number }'))).toEqual([
        noFormBlock(description),
      ]);
    },
  );

  test.each(BLOCK_HOSTS.filter(([kind]) => FORM_HOSTS.has(kind)))(
    'a form block is accepted on %s',
    async (_kind, _description, program) => {
      expect(await diagnosticsOf(program('form { a: number }'))).toEqual([]);
    },
  );

  test.each(BLOCK_HOSTS.filter(([kind]) => PARAMETER_HOSTS.has(kind)))(
    'input and output parameters are accepted on %s',
    async (_kind, _description, program) => {
      expect(
        await diagnosticsOf(program('input a = 1 output b = "two"')),
      ).toEqual([]);
    },
  );

  test.each(BLOCK_HOSTS.filter(([kind]) => !PARAMETER_HOSTS.has(kind)))(
    'a parameter on %s names the element kind and the hosts that take one',
    async (_kind, description, program) => {
      expect(await diagnosticsOf(program('input a = 1'))).toEqual([
        noParameters(description),
      ]);
    },
  );

  test.each(BLOCK_HOSTS.filter(([kind]) => !EXTERNAL_HOSTS.has(kind)))(
    'a property line on %s names the element kind and the hosts that take one',
    async (_kind, description, program) => {
      expect(await diagnosticsOf(program('property k = "v"'))).toEqual([
        noPropertyHost(description),
      ]);
    },
  );

  // `call` is absent: its own block has no mapping member, so one written
  // there is a parse error rather than this diagnostic. The code is declared
  // in the header so the linker stays out of the list.
  test.each(
    BLOCK_HOSTS.filter(
      ([kind]) => !EXTERNAL_HOSTS.has(kind) && kind !== 'call',
    ).map(
      ([kind, description, members]) =>
        [
          kind,
          description,
          (c: string) =>
            members(c).replace('process p {', 'process p { error E '),
        ] as const,
    ),
  )(
    'an error mapping on %s names the element kind and the hosts that take one',
    async (_kind, description, program) => {
      expect(await diagnosticsOf(program('error E when "${x}"'))).toEqual([
        noMappingHost(description),
      ]);
    },
  );

  test.each([
    ['service', 'service V(topic: "t")'],
    ['send', 'send N(topic: "t")'],
    ['decide', 'decide D(topic: "t")'],
  ])(
    'a topic-bound %s takes a property line and an error mapping',
    async (_kind, statement) => {
      expect(
        await diagnosticsOf(
          `process p { error E ${statement} { property k = "v" error E when "\${x}" } }`,
        ),
      ).toEqual([]);
    },
  );
});

checks('Validation - input and output parameters', [
  [
    'an unrecognized direction names the two legal ones',
    `process p { user U { inp a = 1 } }`,
    [unknownDirection('inp')],
  ],
  [
    'a repeated name within one direction is one error',
    `process p { user U { input a = 1 input a = 2 } }`,
    [duplicateParameter('input', 'a')],
  ],
  [
    'the two directions are independent namespaces',
    `process p { user U { input a = 1 output a = 2 } }`,
    [],
  ],
  [
    'a list, a map, and an inline script are parameter values',
    `process p { service V(topic: "t") { input items = [1, 2] input rows = { k: "v" } input computed = ${FENCE}groovy\n1 + 1\n${FENCE} } }`,
    [],
  ],
  ...scriptTagCases(
    (tag) => `process p { user U { input x = ${FENCE}${tag}\n1\n${FENCE} } }`,
    `Input 'x'`,
  ),
  [
    'a script nested in a list is checked the same as a top-level one',
    `process p { user U { input xs = [${FENCE}cobol\n1\n${FENCE}] } }`,
    [unsupportedScriptTag(`Input 'xs'`, 'cobol')],
  ],
  [
    'an empty map key says what to write',
    `process p { user U { input m = { "": "empty" } } }`,
    [EMPTY_MAP_KEY],
  ],
  [
    'an empty map key is reached through a nested list and map',
    `process p { user U { input m = { rows: [{ cells: { "": 1 } }] } } }`,
    [EMPTY_MAP_KEY],
  ],
  [
    'an empty string value writes no value at all',
    `process p { user U { input a = "" } }`,
    [warn(EMPTY_STRING_VALUE)],
  ],
  [
    'an empty string reached through a list item warns the same way',
    `process p { user U { input a = ["x", ""] } }`,
    [warn(EMPTY_STRING_VALUE)],
  ],
  [
    "an empty string reached through a map entry's value warns the same way",
    `process p { user U { input a = { k: "" } } }`,
    [warn(EMPTY_STRING_VALUE)],
  ],
  [
    'a string of only whitespace is trimmed to the same nothing',
    `process p { user U { input a = "  " } }`,
    [warn(EMPTY_STRING_VALUE)],
  ],
  [
    'a parameter name is in scope for the collection it feeds',
    `process p { start S subprocess B { input lines = ["a", "b"] } { user U for each line in lines } end E }`,
    [],
  ],
  [
    'an output parameter name is in scope for a later step',
    `process p { start S user U { output total = 1 } step T { input seen = total } end E }`,
    [],
  ],
  [
    "an author's own declaration wins over the seeded parameter name",
    `process p { var count: string user U { input count = 1 } step T for 3 until (count >= 2) }`,
    [typeMismatch('count', 'string', 'an ordered comparison', '>=')],
  ],
  [
    'a key holding a quote, a brace, a newline, or non-ASCII text is accepted',
    `process p { user U { input m = { "say \\"hi\\"": 1, "{ braces }": 2, "two
lines": 3, "Grüße 日本": 4 } } }`,
    [],
  ],
]);

// The placement rule under test is Operaton's: a field list is built for the
// behaviours a `class` and a `delegate` expression select, so every other
// binding, and the fenced script a listener can bind with, takes none.
checks('Validation - injected fields', [
  [
    'a class-bound service task carries a field',
    `process p { service V(class: "com.acme.D") { field greeting = "hello" } }`,
    [],
  ],
  [
    'a delegate-bound send task carries a field written as an expression',
    `process p { send N(delegate: "\${sender}") { field subject = "\${topic}" } }`,
    [],
  ],
  [
    'a class-bound decision step carries a field beside its io parameters',
    `process p { decide D(class: "com.acme.R") { input amount = 1 field greeting = "hello" output risk = 2 } }`,
    [],
  ],
  [
    'an expression-bound service task takes no field',
    `process p { service V(expression: "\${bean.run(execution)}") { field greeting = "hello" } }`,
    [fieldBinding('A service task', 'expression')],
  ],
  [
    'a topic-bound service task hands work to a worker, so it takes no field',
    `process p { service V(topic: "t") { field greeting = "hello" } }`,
    [fieldBinding('A service task', 'topic')],
  ],
  [
    'a decision-bound decide step runs no implementation, so it takes no field',
    `process p { decide D(decision: "riskRating") { field greeting = "hello" } }`,
    [fieldBinding('A decision step', 'decision')],
  ],
  [
    'a service task binding nothing at all has no binding to name in the refusal',
    `process p { service V { field greeting = "hello" } }`,
    [
      fieldBinding('A service task'),
      bindingRequired(`Service task 'V'`, SERVICE_BINDINGS),
    ],
  ],
  [
    'a field and a member of an unknown direction report in the order they are written',
    `process p { service V(class: "com.acme.D") { field greeting = 3 fld x = 1 } }`,
    [
      fieldValue('greeting'),
      unknownDirection('fld', `'input', 'output', 'field', or 'property'`),
    ],
  ],
  [
    'a user task names the kinds that take a field',
    `process p { user U { field greeting = "hello" } }`,
    [noFields('a user task')],
  ],
  [
    'a start event names the kinds that take a field',
    `process p { start S { field greeting = "hello" } }`,
    [noFields('a start event')],
  ],
  [
    'a class-bound listener carries a field',
    `process p { user U { on start(class: "com.acme.L") { field greeting = "hello" } } }`,
    [],
  ],
  [
    'a delegate-bound task listener carries a field',
    `process p { user U { on complete(delegate: "\${listenerBean}") { field greeting = "hello" } } }`,
    [],
  ],
  [
    'an expression-bound listener takes no field',
    `process p { user U { on start(expression: "\${bean.run(task)}") { field greeting = "hello" } } }`,
    [listenerFieldBinding(`The 'on start' listener`, 'expression')],
  ],
  [
    'a fenced-script listener takes no field',
    `process p { user U { on start ${FENCE}groovy\nlog(task)\n${FENCE} { field greeting = "hello" } } }`,
    [scriptListenerField(`The 'on start' listener`)],
  ],
  [
    'a fenced script beside a class binding is still what refuses the field',
    `process p { user U { on start(class: "com.acme.L") ${FENCE}groovy\nlog(task)\n${FENCE} { field greeting = "hello" } } }`,
    [scriptListenerField(`The 'on start' listener`)],
  ],
  [
    'a number is not a field value',
    `process p { service V(class: "com.acme.D") { field retries = 3 } }`,
    [fieldValue('retries')],
  ],
  [
    'a bareword is not a field value',
    `process p { var salutation: string service V(class: "com.acme.D") { field greeting = salutation } }`,
    [fieldValue('greeting')],
  ],
  [
    'a list is not a field value',
    `process p { service V(class: "com.acme.D") { field greetings = ["a", "b"] } }`,
    [fieldValue('greetings')],
  ],
  [
    'a map is not a field value',
    `process p { service V(class: "com.acme.D") { field greeting = { text: "hi" } } }`,
    [fieldValue('greeting')],
  ],
  [
    'an inline script is not a field value',
    `process p { service V(class: "com.acme.D") { field greeting = ${FENCE}groovy\n"hi"\n${FENCE} } }`,
    [fieldValue('greeting')],
  ],
  [
    'a repeated field name is one error',
    `process p { service V(class: "com.acme.D") { field greeting = "hi" field greeting = "ho" } }`,
    [duplicateParameter('field', 'greeting')],
  ],
  [
    'a field and an input of the same name are independent namespaces',
    `process p { service V(class: "com.acme.D") { input greeting = 1 field greeting = "hi" } }`,
    [],
  ],
  [
    'an unrecognized direction on a service task names field as legal too',
    `process p { service V(class: "com.acme.D") { fld greeting = "hi" } }`,
    [unknownDirection('fld', `'input', 'output', 'field', or 'property'`)],
  ],
  [
    "a listener's block takes a field alone, so an input there is unrecognized",
    `process p { user U { on start(class: "com.acme.L") { input x = 1 } } }`,
    [unknownDirection('input', `'field'`)],
  ],
]);

/**
 * The extras `BpmnParse.parseExternalServiceTask` reads and nothing else does,
 * so each is legal beside `topic` on the three kinds that bind one and nowhere
 * else. Raw conditions where the condition is not the point, so no variable
 * warning rides along.
 */
checks('Validation - external task extras', [
  // `taskPriority` needs `topic`.
  [
    'a priority under a class binding names the binding written',
    `process p { service V(class: "c.D", taskPriority: 5) }`,
    [topicBinding('A service task', "'taskPriority'", 'class')],
  ],
  [
    'a priority under a decision binding names the binding written',
    `process p { decide D(decision: "k", taskPriority: 5) }`,
    [topicBinding('A decision step', "'taskPriority'", 'decision')],
  ],
  [
    'a priority on a thrown message is an unknown key, topic or not',
    `process p { start S emit message M("X", topic: "t", taskPriority: 5) }`,
    [notValidOn('taskPriority', 'an emit statement')],
  ],
  // Property lines.
  [
    'a property line under a class binding names the binding written',
    `process p { service V(class: "c.D") { property k = "v" } }`,
    [topicBinding('A service task', 'a property line', 'class')],
  ],
  [
    'a property value is text',
    `process p { service V(topic: "t") { property k = ["a"] } }`,
    [propertyValue('k')],
  ],
  [
    'a repeated property key is one duplicate',
    `process p { service V(topic: "t") { property k = "1" property k = "2" } }`,
    [duplicateParameter('property', 'k')],
  ],
  [
    'a property declares no process variable',
    `process p { service V(topic: "t") { property k = "v" } if (k) { step A } }`,
    [warn(undeclared('k'))],
  ],
  // Error mappings.
  [
    'a mapping under a class binding names the binding written',
    `process p { error E service V(class: "c.D") { error E when "\${x}" } }`,
    [topicBinding('A service task', 'an error mapping', 'class')],
  ],
  [
    'a mapping raises an error and nothing else',
    `process p { escalation S service V(topic: "t") { escalation S when "\${x}" } }`,
    [MAPPING_HEAD],
  ],
  [
    'a mapping is written with when',
    `process p { error E service V(topic: "t") { error E wenn "\${x}" } }`,
    [MAPPING_WHEN],
  ],
  [
    'a mapping naming an undeclared code draws the linker message alone',
    `process p { service V(topic: "t") { error NOPE when "\${x}" } }`,
    [codeNotDeclared('error', 'NOPE')],
  ],
  // `externalTask` is resolved on an external task's execution alone.
  [
    "a mapping's condition reads the external task",
    `process p { error E service V(topic: "t") { error E when externalTask.errorMessage == "x" } }`,
    [],
  ],
  [
    'an if reading the external task warns like any undeclared variable',
    `process p { if (externalTask.retries == 0) { step A } }`,
    [warn(undeclared('externalTask'))],
  ],
]);

/**
 * One row per key and value shape. `parsePriority` deploys an integer or an
 * expression and refuses every other constant, for `jobPriority` as for
 * `taskPriority`.
 */
checks(
  'Validation - a priority is an integer or an expression',
  (
    [
      ['taskPriority', '1.5', [priorityShape('taskPriority')]],
      ['taskPriority', '"high"', [priorityShape('taskPriority')]],
      ['jobPriority', '2.5', [priorityShape('jobPriority')]],
      ['jobPriority', 'true', [priorityShape('jobPriority')]],
      ['taskPriority', '42', []],
      ['taskPriority', '-5', []],
      ['taskPriority', '"42"', []],
      ['taskPriority', '"${p}"', []],
      ['jobPriority', '"7"', []],
      ['taskPriority', 'prio', [warn(undeclared('prio'))]],
    ] as Array<[key: string, value: string, expected: string[]]>
  ).map(([key, value, expected]) => [
    `${key}: ${value}`,
    key === 'jobPriority'
      ? `process p { user U(asyncBefore: true, ${key}: ${value}) }`
      : `process p { service V(topic: "t", ${key}: ${value}) }`,
    expected,
  ]),
);

checks('Validation - form references on a user task', [
  [
    'a form reference resolved by binding is accepted',
    `process p { user T(formRef: "review-form", binding: latest) }`,
    [],
  ],
  [
    'a form reference pinned to a version is accepted',
    `process p { user T(formRef: "review-form", version: 2) }`,
    [],
  ],
  [
    'a form key alone is still accepted',
    `process p { user T(formKey: "review-form") }`,
    [],
  ],
  [
    'a form key beside a form reference is one error',
    `process p { user T(formKey: "k", formRef: "review-form", binding: latest) }`,
    [FORM_KEY_AND_REF],
  ],
  [
    'a form reference with no binding is one error',
    `process p { user T(formRef: "review-form") }`,
    [FORM_REF_NEEDS_BINDING],
  ],
  [
    'a binding with no form reference has nothing to pin',
    `process p { user T(binding: latest) }`,
    [FORM_REF_MISSING],
  ],
  [
    'a version with no form reference has nothing to pin',
    `process p { user T(version: 2) }`,
    [FORM_REF_MISSING],
  ],
  [
    'a binding and a version together is reported once',
    `process p { user T(formRef: "review-form", binding: latest, version: 2) }`,
    [bindingVersionClash('A user task')],
  ],
  [
    "'binding: version' redirects to the numeric form",
    `process p { user T(formRef: "review-form", binding: version) }`,
    [BINDING_IS_VERSION],
  ],
  [
    'an unrecognized binding names the two it accepts',
    `process p { user T(formRef: "review-form", binding: newest) }`,
    [BINDING_VALUE],
  ],
  [
    'a form id names a form, not a variable',
    `process p { user T(formRef: reviewForm, binding: latest) }`,
    [],
  ],
]);

checks('Validation - listeners', [
  [
    'every task-listener event is accepted on a user task',
    `process p {
  user U {
    on create(class: "com.example.A")
    on assignment(expression: "\${bean.assign(task)}")
    on complete(delegate: "\${listenerBean}")
    on update ${FENCE}groovy
    log(task)
    ${FENCE}
    on delete(class: "com.example.D")
    on timeout after "PT8H"(class: "com.example.T")
  }
}`,
    [],
  ],
  [
    'a task-listener event elsewhere says only a user task has one',
    `process p { service V(topic: "t") { on create(class: "com.example.C") } }`,
    [taskListenerOnly('create', 'a service task')],
  ],
  [
    'a listener binds and nothing else, so a bare flag is refused there too',
    `process p { user U { on start(class: "com.example.L", alongside) } }`,
    [flagNotValidOn('alongside', 'a listener')],
  ],
  [
    "'on assign' is refused with the list, whose word is 'assignment' (BpmnParse.parseTaskListeners)",
    `process p { user U { on assign(class: "com.example.C") } }`,
    [unknownListenerEvent('assign', USER_LISTENER_EVENTS)],
  ],
  [
    'an unknown event word lists only the execution events elsewhere',
    `process p { subprocess S { on wibble(class: "com.example.C") } { user U } }`,
    [unknownListenerEvent('wibble', `'start' or 'end'`)],
  ],
  [
    'a listener with no binding names the three attributes and the script body',
    `process p { user U { on start } }`,
    [
      bindingRequired(
        `The 'on start' listener`,
        LISTENER_BINDINGS,
        ', or a fenced script body',
      ),
    ],
  ],
  [
    'a listener with two bindings names both',
    `process p { user U { on start(class: "com.example.C", delegate: "\${bean}") } }`,
    [
      bindingConflict(
        `The 'on start' listener`,
        'class, delegate',
        LISTENER_BINDINGS,
      ),
    ],
  ],
  [
    'a key that binds nothing is rejected inside a listener block',
    `process p { user U { on start(topic: "t") } }`,
    [
      notValidOn('topic', 'a listener'),
      bindingRequired(
        `The 'on start' listener`,
        LISTENER_BINDINGS,
        ', or a fenced script body',
      ),
    ],
  ],
  [
    'a timeout listener without a timer asks for the particle clause',
    `process p { user U { on timeout(class: "com.example.T") } }`,
    [LISTENER_TIMER_PAYLOAD],
  ],
  [
    'a timer on any other listener event is one error',
    `process p { user U { on create after "PT1H" (class: "com.example.C") } }`,
    [LISTENER_PARTICLE_ONLY],
  ],
  [
    'an unknown particle on a timeout listener names the legal ones',
    `process p { user U { on timeout whenever "PT1H" (class: "com.example.T") } }`,
    [unknownParticle('whenever')],
  ],
  [
    'listeners repeat freely and fire in written order (CoreModelElement.addListenerToMap appends)',
    `process p { user U { on start(class: "a.B") on start(class: "c.D") on timeout after "PT1H"(class: "x.Y") on timeout after "P1D"(class: "x.Z") } }`,
    [],
  ],
  [
    "a script binding follows the script task's fence rules",
    `process p { user U { on start ${FENCE}php\necho 1;\n${FENCE} } }`,
    [unsupportedScriptTag(`The 'on start' listener`, 'php')],
  ],
  [
    'an empty script binding is one error',
    `process p { user U { on start ${FENCE}groovy\n${FENCE} } }`,
    [emptyScript(`The 'on start' listener`)],
  ],
  ...scriptTagCases(
    (tag) =>
      `process p { user U { on start ${FENCE}${tag}\nx = 1\n${FENCE} } }`,
    `The 'on start' listener`,
  ),
]);

describe('Validation - the timer clause, reported in place', () => {
  // A listener names its kind in `event` and everything else in `trigger`, so
  // the squiggle covers the word the author wrote rather than the whole
  // construct around it.
  test.each([
    [
      'a listener is marked on its event word',
      `process p { user U { on timeout(class: "com.example.T") } }`,
      'timeout',
    ],
    [
      'a catch is marked on its trigger word',
      `process p { await timer }`,
      'timer',
    ],
  ])('%s', async (_title, source, word) => {
    const { diagnostics } = await validate(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.range).toEqual({
      start: { line: 0, character: source.indexOf(word) },
      end: { line: 0, character: source.indexOf(word) + word.length },
    });
  });
});

checks('Validation - process header attributes', [
  [
    'any other key in the header is one error',
    `process p(wibble: "x") { start S }`,
    [notValidOn('wibble', 'a process header')],
  ],
  [
    'an engine setting has no process-wide form',
    `process p(asyncBefore: true) { start S }`,
    [notValidOn('asyncBefore', 'a process header')],
  ],
  [
    'a repeated header key is one error',
    `process p(versionTag: "1.0.0", versionTag: "2.0.0") { start S }`,
    [duplicateSetting('versionTag')],
  ],
  [
    'a header takes the label every element takes, and no bare flag',
    `process p(label: "P", alongside) { start S }`,
    [flagNotValidOn('alongside', 'a process header')],
  ],
  [
    'the header and the start take every key their own element carries',
    `process p(label: "P", documentation: "D", versionTag: "1.0.0", historyTimeToLive: "P90D", candidateStarterUsers: "demo,manager", candidateStarterGroups: "adjusters") {
  start S(initiator: "claimant")
}`,
    [],
  ],
]);

/** A header setting's value, alone, so each row is one shape and its whole list. */
const header = (setting: string) => `process p(${setting}) { start S }`;

/**
 * The engine reads no header value as an expression. Revert checks: each
 * rule's arm removed from `PROCESS_HEADER_VALUE_RULES` turns its refused rows
 * clean; the length check dropped turns the 65-character row clean alone.
 */
checks('Validation - process header value shapes', [
  ...['"30"', '"P0D"', '"P30D"'].map((value): Case => [
    `historyTimeToLive ${value} is a day count the engine parses`,
    header(`historyTimeToLive: ${value}`),
    [],
  ]),
  ...['"PT8H"', '"P1M"', '"-5"', '""', '"P30d"', '" P30D"', '"${ttl}"'].map(
    (value): Case => [
      `historyTimeToLive ${value} fails the deployment, so it is refused`,
      header(`historyTimeToLive: ${value}`),
      [HISTORY_TIME_TO_LIVE_SHAPE],
    ],
  ),
  [
    'a bareword historyTimeToLive is refused the same way and names no variable',
    header('historyTimeToLive: P90D'),
    [HISTORY_TIME_TO_LIVE_SHAPE],
  ],
  [
    'a versionTag template is stored as its own text, so it is refused',
    header('versionTag: "${v}"'),
    [VERSION_TAG_LITERAL],
  ],
  [
    'a number in versionTag asks for quotes',
    header('versionTag: 3'),
    [VERSION_TAG_LITERAL],
  ],
  [
    'a bareword in versionTag asks for quotes and names no variable',
    header('versionTag: deadline'),
    [VERSION_TAG_LITERAL],
  ],
  [
    'a 64-character versionTag fits its column',
    header(`versionTag: "${'v'.repeat(64)}"`),
    [],
  ],
  [
    'a 65-character versionTag overflows its column',
    header(`versionTag: "${'v'.repeat(65)}"`),
    [VERSION_TAG_LENGTH],
  ],
  [
    'a template anywhere in a starter list is stored as a literal id, so it is refused',
    header(
      'candidateStarterUsers: "demo, ${starter}", candidateStarterGroups: "#{g}"',
    ),
    [
      candidateStarterTemplate('candidateStarterUsers'),
      candidateStarterTemplate('candidateStarterGroups'),
    ],
  ],
  [
    'a header label or documentation is a quoted string, never a number or a template',
    header('label: 3, documentation: "${d}"'),
    [headerLiteral('label'), headerLiteral('documentation')],
  ],
  [
    'a bareword header label names no variable',
    header('label: foo'),
    [headerLiteral('label')],
  ],
  [
    'a label on a step still takes the expression a task name evaluates',
    `process p { user U(label: "\${who}") }`,
    [],
  ],
]);

/** The form carrying every optional part, the one a nested placement must still take. */
const DECORATED_CLAUSE =
  'for each line in lines sequentially until (nrOfCompletedInstances >= 2)';

/**
 * One statement per kind that takes the clause, with the clause, the parens
 * items, and the block members left open. Each writes whatever else its own
 * validation demands, so the only diagnostics a case can produce are the
 * slots'.
 */
const REPEAT_HOSTS: Array<
  [
    kind: string,
    description: string,
    statement: (clause: string, items: string, members: string) => string,
  ]
> = [
  ['user', 'a user task', repeatHost('user U')],
  ['service', 'a service task', repeatHost('service V', 'topic: "t"')],
  ['step', 'a step', repeatHost('step T')],
  ['send', 'a send task', repeatHost('send N', 'class: "com.example.Send"')],
  ['receive', 'a receive task', repeatHost('receive R')],
  [
    'decide',
    'a decision step',
    repeatHost('decide D', 'decision: "riskRating"'),
  ],
  [
    'script',
    'a script task',
    repeatHost('script K', '', `${FENCE}js\nwork()\n${FENCE}`),
  ],
  ['subprocess', 'a subprocess', repeatHost('subprocess B', '', '{ user W }')],
  ['call', 'a call', repeatHost('call C', 'process: "q"')],
];

/** An empty parens or block is omitted, so the unrepeated form is what an author writes. */
function repeatHost(head: string, own = '', tail = '') {
  return (clause: string, items: string, members: string) => {
    const all = [own, items].filter(Boolean).join(', ');
    const parens = all ? `(${all})` : '';
    const block = members ? ` { ${members} }` : '';
    return `${head} ${clause}${parens}${block} ${tail}`;
  };
}

describe('Validation - the repeat clause', () => {
  // Nothing in the clause's validation branches on the statement kind or on how
  // deeply it nests, so one host carries the forms; per-host reachability is the
  // parameter matrices below and the parse sweep in `parsing.test.ts`.
  test.each([
    'for 3',
    'for each line in lines',
    'for each in lines',
    'for 2 each line in lines',
    DECORATED_CLAUSE,
  ])('`%s` validates clean', async (clause) => {
    expect(
      await diagnosticsOf(`process p { var lines: json user U ${clause} }`),
    ).toEqual([]);
  });

  test.each(['for 1.5', 'for -3', 'for "high"'])(
    '`%s` is not a repeat count',
    async (clause) => {
      expect(await diagnosticsOf(`process p { user U ${clause} }`)).toEqual([
        REPEAT_COUNT,
      ]);
    },
  );

  test.each(['for "3"', 'for count', `for "\${count}"`])(
    '`%s` is a clean repeat count',
    async (clause) => {
      expect(
        await diagnosticsOf(`process p { var count: number user U ${clause} }`),
      ).toEqual([]);
    },
  );

  test.each([
    ['a subprocess', `subprocess Outer { user U ${DECORATED_CLAUSE} }`],
    ['an on handler body', `start S on error { user U ${DECORATED_CLAUSE} }`],
  ])('the decorated form validates clean inside %s', async (_where, body) => {
    expect(
      await diagnosticsOf(`process p { var lines: json ${body} }`),
    ).toEqual([]);
  });

  test.each([
    'nrOfInstances',
    'nrOfActiveInstances',
    'nrOfCompletedInstances',
    'loopCounter',
  ])('`%s` is in scope in a process carrying a clause', async (variable) => {
    expect(
      await diagnosticsOf(
        `process p { user U for 3 until (${variable} >= 2) }`,
      ),
    ).toEqual([]);
  });

  test.each(REPEAT_HOSTS)(
    "an 'output' parameter on a repeated %s is one error saying to move it",
    async (_kind, _description, statement) => {
      expect(
        await diagnosticsOf(
          `process p { ${statement('for 3', '', 'output b = 1')} }`,
        ),
      ).toEqual([REPEATED_OUTPUT]);
    },
  );

  test.each(REPEAT_HOSTS)(
    "an 'input' parameter on a repeated %s is accepted",
    async (_kind, _description, statement) => {
      expect(
        await diagnosticsOf(
          `process p { ${statement('for 3', '', 'input a = 1')} }`,
        ),
      ).toEqual([]);
    },
  );

  test.each(REPEAT_HOSTS)(
    "an 'output' parameter on an unrepeated %s stays clean",
    async (_kind, _description, statement) => {
      expect(
        await diagnosticsOf(
          `process p { ${statement('', '', 'output b = 1')} }`,
        ),
      ).toEqual([]);
    },
  );
});

checks('Validation - the repeat clause in scope', [
  [
    'the element variable a clause binds is in scope inside the statement',
    `process p { var lines: json user U for each line in lines { input x = line } }`,
    [],
  ],
  [
    'a process with no clause still warns about a loop variable',
    `process p { user U { input x = loopCounter } }`,
    [warn(undeclared('loopCounter'))],
  ],
  [
    "an author's own declaration wins over the seeded loop variable",
    `process p { var loopCounter: string user U for 3 until (loopCounter >= 2) }`,
    [typeMismatch('loopCounter', 'string', 'an ordered comparison', '>=')],
  ],
  [
    'a clause nests inside a repeated subprocess',
    `process p { var lines: json subprocess B for each line in lines { user U for 2 } }`,
    [],
  ],
]);

/** The four per-run keys with a value each takes, spelled out so a drift in the derivation shows. */
const RUN_SETTINGS =
  'runAsyncBefore: true, runAsyncAfter: true, runExclusive: false, runRetryCycle: "R3/PT10M"';

/**
 * Revert checks: dropping `repeats` from the `GenericTask` row turns the step
 * rows red, dropping the `run` prefix from the boolean set the `runExclusive`
 * row, and removing the no-clause guard the no-clause rows.
 */
checks('Validation - per-run job settings', [
  ...REPEAT_HOSTS.map(([kind, , statement]): Case => [
    `${kind} with a clause takes every run key`,
    `process p { ${statement('for 3', RUN_SETTINGS, '')} }`,
    [],
  ]),
  ...REPEAT_HOSTS.map(([kind, description, statement]): Case => [
    `${kind} without a clause refuses every run key, one refusal per key`,
    `process p { ${statement('', RUN_SETTINGS, '')} }`,
    [
      runWithoutClause('runAsyncBefore', description, 'asyncBefore'),
      runWithoutClause('runAsyncAfter', description, 'asyncAfter'),
      runWithoutClause('runExclusive', description, 'exclusive'),
      runWithoutClause('runRetryCycle', description, 'retryCycle'),
    ],
  ]),
  [
    'a run key on a kind that never repeats is an unknown key there',
    `process p { start S(runAsyncBefore: true) }`,
    [notValidOn('runAsyncBefore', 'a start event')],
  ],
  [
    'a run key on a gateway head is an unknown key there',
    `process p { var a: boolean if (a) (runAsyncBefore: true) { user A } }`,
    [notValidOn('runAsyncBefore', 'an if statement')],
  ],
  [
    'runJobPriority on a repeated step names the key the engine reads',
    `process p { step X for 2(runJobPriority: 5) }`,
    [RUN_JOB_PRIORITY],
  ],
  [
    'runJobPriority on a kind that never repeats is an unknown key there',
    `process p { start S(runJobPriority: 5) }`,
    [notValidOn('runJobPriority', 'a start event')],
  ],
  [
    'a quoted boolean in a run key names the unquoted form',
    `process p { service V for 3(topic: "t", runAsyncBefore: true, runExclusive: "false") }`,
    [quotedBoolean('runExclusive')],
  ],
  [
    'a number in runRetryCycle asks for quotes',
    `process p { service V for 3(topic: "t", runAsyncBefore: true, runRetryCycle: 3) }`,
    [unquotedText('runRetryCycle')],
  ],
  [
    'a bareword in runRetryCycle asks for quotes and names no variable',
    `process p { service V for 3(topic: "t", runAsyncBefore: true, runRetryCycle: R2) }`,
    [unquotedText('runRetryCycle')],
  ],
  [
    'a run key beside the step key of the same setting is clean: one job around, one per run',
    `process p { step X for 2(asyncBefore: true, runAsyncBefore: true) }`,
    [],
  ],
]);

/**
 * One program per slot a check reads and names back, with the reserved word the
 * parser reports for it. A hard keyword in the slot makes the parser recover
 * with it left empty, and where that keyword also opens a statement of its own
 * the statement's body is empty too. Three slots carry no word: a form field
 * type is a keyword alternation with no `ID` alternative, and an empty trailing
 * `STRING` is a shape no keyword produces.
 */
const UNPARSED_SLOT: Array<[where: string, program: string, word?: string]> = [
  ['a `var` name', `process p { var while: number start S end E }`, 'while'],
  ['a `goto` target', `process p { start S goto while }`, 'while'],
  ['a step name', `process p { start S user while end E }`, 'while'],
  ['a start name', `process p { start while end E }`, 'while'],
  [
    'a subprocess name',
    `process p { start S subprocess while { user U } end E }`,
    'while',
  ],
  // A name is only read back when something crosses the boundary it labels, and
  // the reserved-word spelling above cannot get far enough to be crossed.
  [
    'a subprocess name a goto reaches into',
    `process p { start S subprocess { user U } goto U end E }`,
  ],
  [
    'a subprocess name a goto reaches out of',
    `process p { start S subprocess { goto Fin } user U end Fin }`,
  ],
  ['a process name', `process while { start S end E }`, 'while'],
  // Each duplicate walk names the process it scopes, so the reader is a second
  // declaration colliding with the first rather than the empty name alone.
  [
    'a process name a duplicate step name reports',
    `process { start S user U user U end E }`,
  ],
  [
    'a process name a duplicate var reports',
    `process { var a: number var a: number start S end E }`,
  ],
  [
    'a call name',
    `process p { start S call while(process: "q") end E }`,
    'while',
  ],
  [
    'a handler binding',
    `process p { start S on error(while) { start A end B } end E }`,
    'while',
  ],
  [
    'a service task name',
    `process p { start S service while(class: "C") end E }`,
    'while',
  ],
  [
    'a send task name',
    `process p { start S send while(class: "C") end E }`,
    'while',
  ],
  [
    'a decision step name',
    `process p { start S decide while(decision: "d") end E }`,
    'while',
  ],
  [
    'a script task name',
    `process p { start S script while ${FENCE}js\nx()\n${FENCE} end E }`,
    'while',
  ],
  [
    'a handler trigger',
    `process p { start S on while { step T } end E }`,
    'while',
  ],
  [
    'a handler trigger a goto reaches into',
    `process p { start S on { step T } goto T end E }`,
  ],
  [
    'a handler trigger a goto reaches out of',
    `process p { start S on { goto T } step T end E }`,
  ],
  ['a throw trigger', `process p { start S throw while }`, 'while'],
  ['an emit trigger', `process p { start S emit while end E }`, 'while'],
  ['an await trigger', `process p { start S await while end E }`, 'while'],
  [
    'a listener event',
    `process p { start S user U { on while(class: "C") } end E }`,
    'while',
  ],
  [
    // The colliding `var` is the reader: without it the agreement check that
    // names the type never runs.
    'a form field type',
    `process p { var a: number start S user U { form { a: while } } end E }`,
  ],
  [
    'a code declaration name',
    `process p { error while start S end E }`,
    'while',
  ],
  [
    'a code declaration setting value',
    `process p { error C(message:) start S end E }`,
  ],
  ['an io parameter value', `process p { start S user U { input a } end E }`],
  // The two keys a duplicate walk builds from more than one slot: a template
  // literal would stringify the missing half and collide with itself.
  [
    'a call mapping target',
    `process p { start S call C(process: "q") { in in } end E }`,
    'in',
  ],
  [
    'a handler trigger compared for duplicates',
    `process p { start S on on { step T } end E }`,
    'on',
  ],
  [
    'a script task body left unterminated',
    `process p { start S script total ${FENCE}js\nx = 1\n }`,
  ],
];

describe('Validation - an unparsed slot', () => {
  const containing = (messages: string[], needle: string) =>
    messages.filter((message) => message.includes(needle));

  test.each(UNPARSED_SLOT)(
    '%s produces no crash and no diagnostic naming an element it cannot name',
    async (_where, program, word) => {
      const messages = await diagnosticsOf(program);
      if (word !== undefined) {
        expect(messages).toContain(reservedWord(word));
      }
      expect(
        containing(messages, 'An error occurred during validation'),
      ).toEqual([]);
      expect(containing(messages, 'undefined')).toEqual([]);
    },
  );

  // The boundary explanation names the container that was crossed, so an
  // unparsed name or trigger leaves it nothing to name and it stands down.
  test.each([
    [
      'a handler a goto reaches into',
      `process p { start S on { step T } goto T end E }`,
      'T',
    ],
    [
      'a handler a goto reaches out of',
      `process p { start S on { goto T } step T end E }`,
      'T',
    ],
    [
      'a subprocess a goto reaches into',
      `process p { start S subprocess { user U } goto U end E }`,
      'U',
    ],
    [
      'a subprocess a goto reaches out of',
      `process p { start S subprocess { goto Fin } user U end Fin }`,
      'Fin',
    ],
  ])(
    '%s keeps the stock unresolved-reference message',
    async (_where, program, name) => {
      expect(await diagnosticsOf(program)).toContain(unresolvedStatement(name));
    },
  );

  test('an unterminated fence resolves to the malformed-body error', async () => {
    const messages = await diagnosticsOf(
      `process p { script total ${FENCE}js\nx = 1\n }`,
    );
    // Reported exactly once, while tolerating surrounding parser noise.
    expect(messages.filter((m) => m === unterminatedScript('total'))).toEqual([
      unterminatedScript('total'),
    ]);
  });

  test('a nameless decision step still gets the checks that do not name it', async () => {
    expect(
      await diagnosticsOf(
        `process p { start S decide(binding: "latest", version: 2, decision: "d") end E }`,
      ),
    ).toContain(bindingVersionClash('A decision step'));
  });

  test('two reserved words as `var` names report both and nothing else', async () => {
    expect(
      await diagnosticsOf(
        `process p { var until: number var each: number start S end E }`,
      ),
    ).toEqual([reservedWord('until'), reservedWord('each')]);
  });
});
