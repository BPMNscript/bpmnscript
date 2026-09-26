/**
 * Validation of the BPMNscript AST.
 *
 * A case is one source program and the complete list of diagnostics it raises,
 * in the order they are reported, so it fails both when a check stops firing
 * and when one fires that should not. A warning carries a `warning:` prefix;
 * everything else is an error, whether from a check, the linker, or the parser.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { validationHelper, type ValidationResult } from 'langium/test';
import type { FormField, Model } from '@bpmn-script/language';
import {
  AFTER_SHAPE_MESSAGE,
  alongsideMessage,
  AT_SHAPE_MESSAGE,
  blockMemberMessage,
  booleanDefaultMessage,
  BUILTIN_REQUIRED_FIELDS,
  CANCEL_ALONGSIDE_MESSAGE,
  CANCEL_END_PLACEMENT_MESSAGE,
  CANCEL_HOSTLESS_MESSAGE,
  CANCEL_NO_CODE_MESSAGE,
  CANCEL_NOT_AWAITED_MESSAGE,
  CANCEL_NOT_RAISED_MESSAGE,
  cancelEndWithoutHandlerMessage,
  cancelHandlerWithoutEndMessage,
  candidateStarterMessage,
  catchTriggerMessage,
  COMPENSATE_TYPO_MESSAGE,
  COMPENSATION_ALONGSIDE_MESSAGE,
  COMPENSATION_BINDINGS_MESSAGE,
  COMPENSATION_DUPLICATE_MESSAGE,
  COMPENSATION_HOST_MESSAGE,
  COMPENSATION_NO_CODE_MESSAGE,
  COMPENSATION_PLACEMENT_MESSAGE,
  COMPOSITE_OPERAND_MESSAGE,
  CONDITIONAL_TYPO_MESSAGE,
  constraintMisfitMessage,
  createBpmnScriptServices,
  DEAD_LOOP_MESSAGE,
  decisionModifierMessage,
  DECLARATION_SETTINGS_ONLY_MESSAGE,
  dueDateShapeMessage,
  duplicateConditionStartMessage,
  duplicateNamedStartMessage,
  duplicateValueMessage,
  ELEMENT_FIELD_BINDINGS,
  emitTriggerMessage,
  EMPTY_CODE_MESSAGE,
  EMPTY_STRING_VALUE_MESSAGE,
  emptyEnumMessage,
  emptyFieldMessage,
  emptyLoopBodyMessage,
  END_CONDITION_MESSAGE,
  END_TIMER_MESSAGE,
  END_TRIGGER_NO_CODE_MESSAGES,
  endTriggerMessage,
  ENGINE_KEYS,
  enumDefaultMessage,
  ESCALATION_NO_MESSAGE_MESSAGE,
  escapedFieldLiteralMessage,
  EVERY_SHAPE_MESSAGE,
  fieldBindingMessage,
  fieldValueMessage,
  flagFalseMessage,
  flagNotTrueMessage,
  FORM_KEY_AND_REF_MESSAGE,
  FORM_NEVER_OFFERED_MESSAGE,
  FORM_REF_BINDING_MESSAGE,
  FORM_REF_MISSING_MESSAGE,
  formFieldDirectionMessage,
  formFieldSettingsOnlyMessage,
  HANDLER_DUPLICATE_RULE,
  headerLiteralMessage,
  HISTORY_TIME_TO_LIVE_MESSAGE,
  hostedHandlerStartMessage,
  hyphenNameMessage,
  INITIATOR_SHADOWED_MESSAGE,
  integerBoundMessage,
  intoBranchMessage,
  isoDateDefaultMessage,
  joinSettingKey,
  JUEL_RESERVED_WORDS,
  juelKeywordMessage,
  LINK_CATCH_FLOW_MESSAGE,
  LINK_IN_RACE_MESSAGE,
  linkThrowNeverRunsMessage,
  LISTENER_FIELD_BINDINGS,
  LISTENER_TIMER_PAYLOAD_MESSAGE,
  literalElBindingMessage,
  loopJoinKeyMessage,
  MAP_DECISION_RESULT_UNREAD_MESSAGE,
  MAPPING_HEAD_MESSAGE,
  MAPPING_WHEN_MESSAGE,
  missingBuiltinFieldMessage,
  NESTED_START_FORM_MESSAGE,
  NESTED_START_INITIATOR_MESSAGE,
  noDefaultStartMessage,
  noFieldHostMessage,
  noJobMessage,
  noMappingHostMessage,
  nonBooleanConditionMessage,
  noPerRunJobMessage,
  noPropertyHostMessage,
  numberDefaultMessage,
  onTriggerMessage,
  PARALLEL_ELSE_BESIDE_UNCONDITIONED_MESSAGE,
  PARALLEL_ELSE_WITHOUT_CONDITION_MESSAGE,
  PARALLEL_SECOND_ELSE_MESSAGE,
  PARAMETER_HOSTS_MESSAGE,
  PATTERN_LETTERS_MESSAGE,
  PATTERN_VALUE_MESSAGE,
  patternMisfitMessage,
  priorityShapeMessage,
  propertyValueMessage,
  prunedJoinMessage,
  quotedCodeMessage,
  raceDuplicateMessage,
  refusedHeadKeyMessage,
  REPEAT_COUNT_MESSAGE,
  REPEATED_OUTPUT_MESSAGE,
  resultVariableBindingMessage,
  resultVariableUnreadMessage,
  RETRY_CYCLE_SHAPE_MESSAGE,
  RUN_JOB_PRIORITY_MESSAGE,
  runWithoutClauseMessage,
  scriptListenerFieldMessage,
  SECOND_DEFAULT_START_MESSAGE,
  SECOND_PAREN_VALUE_MESSAGE,
  selfAttachedHostMessage,
  settingsOnlyMessage,
  shellFieldExpressionMessage,
  shellFlagValueMessage,
  START_AFTER_IMPLICIT_START_MESSAGE,
  START_TRIGGER_IN_HANDLER_MESSAGE,
  startMessageExpressionMessage,
  startTriggerMessage,
  templateAsClassMessage,
  throwTriggerMessage,
  TIMER_PAYLOAD_MESSAGE,
  timerJobKeyTwiceMessage,
  topicBindingMessage,
  TYPE_VALUE_MESSAGE,
  unknownBuiltinFieldMessage,
  unknownDeclarationKindMessage,
  unknownDirectionMessage,
  unknownFormFieldSettingMessage,
  VALIDATOR_EMPTY_MESSAGE,
  valuesOnNonEnumMessage,
  VERSION_SHAPE_MESSAGE,
  VERSION_TAG_LENGTH_MESSAGE,
  VERSION_TAG_LITERAL_MESSAGE,
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

async function diagnosticsOf(source: string): Promise<string[]> {
  const { diagnostics } = await validate(source);
  return withTextMessages(diagnostics).map((d) =>
    d.severity === SEVERITY_WARNING ? `warning: ${d.message}` : d.message,
  );
}

const warn = (message: string) => `warning: ${message}`;

type Case = [title: string, source: string, expected: string[]];

function checks(concern: string, cases: Case[]): void {
  describe(concern, () => {
    test.each(cases)('%s', async (_title, source, expected) => {
      expect(await diagnosticsOf(source)).toEqual(expected);
    });
  });
}

const capitalized = (text: string) => text[0]!.toUpperCase() + text.slice(1);

/** An enum gets a value so its own empty-values warning stays out of the list. */
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

// The messages, each spelled once
//
// A message the validator exports is imported; a helper below adapts the few
// that take an AST node or a slot to the strings a case spells.

const nonBooleanCondition = (shape: string) =>
  nonBooleanConditionMessage(shape, 'condition');
const fieldBinding = (subject: string, written?: string) =>
  fieldBindingMessage(
    subject,
    written === undefined ? [] : [written],
    ELEMENT_FIELD_BINDINGS,
  );
const formField = (id: string, type: string) => ({ id, type }) as FormField;
const constraintMisfit = (
  name: string,
  id: string,
  type: string,
  fits: string,
) => constraintMisfitMessage(name, formField(id, type), [fits]);
const patternMisfit = (id: string, type: string) =>
  patternMisfitMessage(formField(id, type));
const valuesOnNonEnum = (id: string, type: string) =>
  valuesOnNonEnumMessage(formField(id, type));

const typeMismatch = (
  name: string,
  type: string,
  context: string,
  op: string,
) =>
  `Variable '${name}' of type '${type}' cannot be used in ${context} (operator '${op}').`;
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
const emptyBinding = (key: string, noun: string) =>
  `Setting '${key}' cannot be empty; name the ${noun}.`;
const bindingRequired = (subject: string, keys: string, alternative = '') =>
  `${subject} must declare a ${keys} setting${alternative}.`;
const bindingConflict = (subject: string, written: string, keys: string) =>
  `${subject} declares more than one binding (${written}); exactly one of ${keys} is allowed.`;
const MAP_DECISION_RESULT =
  `Setting 'mapDecisionResult' must be 'singleEntry', 'singleResult', ` +
  `'collectEntries', or 'resultList'.`;

// The process header.

// Forms.

const noFormBlock = (description: string) =>
  `${capitalized(description)} cannot declare a 'form' block; forms belong on start events and user tasks.`;
const oneFormBlock = (description: string) =>
  `${description} may declare at most one 'form' block.`;
const duplicateFormField = (id: string) => `Duplicate form field '${id}'.`;
const formFieldType = (id: string, type: string) =>
  `Form field '${id}' has type '${type}', which a form cannot use. Use string, number, boolean, date, or enum.`;

// Parameters and listeners.

const noParameters = (description: string) =>
  `${capitalized(description)} cannot declare an 'input' or 'output' parameter; ${PARAMETER_HOSTS_MESSAGE}`;
const duplicateParameter = (direction: string, name: string) =>
  `Duplicate '${direction}' parameter '${name}'.`;
const EMPTY_MAP_KEY =
  "A map entry's key cannot be empty; name the key its value is looked up by.";
const taskListenerOnly = (event: string, description: string) =>
  `'on ${event}' is a task listener, which only a user task has; ` +
  `${description} takes 'start' or 'end'.`;
const unknownListenerEvent = (event: string, events: string) =>
  `Unknown listener event '${event}'; write ${events}.`;
const USER_LISTENER_EVENTS = `'start', 'end', 'create', 'assignment', 'complete', 'update', 'delete', or 'timeout'`;
const LISTENER_PARTICLE_ONLY = "Only 'on timeout' takes a particle.";

// The extras of a step handed to an external worker.

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
const blockParameter = (direction: string) =>
  blockMemberMessage(`An '${direction}' parameter`, 'configures');
const BLOCK_LISTENER = blockMemberMessage('A listener', 'observes');
const gotoIntoBranch = (target: string, keyword: 'parallel' | 'await') =>
  intoBranchMessage(`goto ${target}`, 'goto', keyword);
const unresolvedStatement = (name: string) =>
  `Could not resolve reference to Statement named '${name}'.`;
const missingStep = (name: string) =>
  `No step named '${name}' in this process.`;
const missingHost = (name: string) =>
  `No step named '${name}' in this process to attach to.`;
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
const startTriggerInBlock = (kind: string) =>
  `Only the process's own start carries a trigger: ${kind} is entered from ` +
  'the step before it, so its start has none. Put the trigger on an ' +
  "'on' handler inside the block if it should react to an event.";
const START_CONDITION_REQUIRED =
  "A condition start needs its condition: 'start S condition(amount > 100)'.";
const START_CONDITION_NO_CODE =
  "A condition start takes no code string; write the condition itself: 'start S condition(amount > 100)'.";
const START_CONDITION_ONLY =
  'Only a condition start takes a condition expression.';
const startNameRequired = (trigger: string) =>
  `A ${trigger} start needs the ${trigger}'s name: the engine matches ${trigger}s by name.`;
const START_PARTICLE_ONLY = 'Only a timer start takes a particle.';

// Timers.

const unknownParticle = (word: string) =>
  `Unknown timer particle '${word}'; write 'after', 'at', or 'every'.`;
const REPEATING_INTERRUPTS =
  'A repeating timer that interrupts its scope fires at most once: ' +
  "add 'alongside' to let it repeat, or give it a duration instead.";

// End events.

// Event handlers.

const HANDLER_PLACEMENT =
  'An event handler belongs directly in the body of a process, a subprocess, ' +
  'an attempt block, or another event handler: it handles events for that ' +
  'whole scope, not for a single branch.';
const HANDLER_TRAILING =
  'Event handlers read like catch blocks: move it after the last step of ' +
  'this body.';
const MESSAGELESS_NAME =
  "A message handler needs the message's name: the engine matches messages by name.";
const CONDITION_REQUIRED =
  "A condition handler needs its condition: 'on condition(amount > 100)'.";
const CONDITION_NO_CODE =
  "A condition handler takes no code string; write the condition itself: 'on condition(amount > 100)'.";
const CONDITION_ONLY = "Only 'on condition' takes a condition expression.";
const PARTICLE_ONLY = "Only 'on timer' takes a particle.";
const noBindings = (trigger: string) =>
  `'(code: c)' bindings belong to error and escalation handlers; a ${trigger} carries no code.`;
const handlerDuplicate = (trigger: string, caught: string, scope: string) =>
  `Another 'on ${trigger}' handler already catches ${caught} on scope '${scope}': ${HANDLER_DUPLICATE_RULE[trigger]}.`;
const everyEvent = 'every event of this kind';
const code = (value: string) => `code '${value}'`;
const eventName = (value: string) => `name '${value}'`;
const escalationCatchAllBesideCoded = (scope: string) =>
  `An 'on escalation' handler with no code cannot sit beside one with a code on scope '${scope}': the code-less one would catch every escalation, and Operaton refuses the pair (BpmnParse.addEscalationEventDefinition). Give both a code, or keep one.`;

// Boundary hosts.

const illegalHost = (name: string, kind: string) =>
  'A boundary event can only attach to an activity: a user, service, script, ' +
  'send, or receive task, a step, a decision step, a subprocess, an attempt ' +
  `block, or a call; '${name}' is ${kind}.`;
const escalationHost = (name: string, kind: string) =>
  'An escalation boundary can only attach to a subprocess, an attempt block, ' +
  `a call, or a user task; '${name}' is ${kind}.`;

// Compensation.

const throwCompensationNames = (keyword: 'throw' | 'emit') =>
  'Compensation undoes completed work: there is nothing to name; ' +
  `write '${keyword} compensation'.`;

// Cancel.

const cancelHost = (name: string, kind: string) =>
  `A cancel handler can only attach to an 'attempt' block: it catches that ` +
  `block being given up; '${name}' is ${kind}.`;

// Throw, emit, and await.

const codeRequired = (
  subject: 'A thrown' | 'An emitted',
  trigger: string,
  keyword: 'throw' | 'emit',
) => `${subject} ${trigger} names its code: '${keyword} ${trigger}(<CODE>)'.`;
const noImplementation = (key: string, subject: string) =>
  `Setting '${key}' is not valid on ${subject}; an implementation is what ` +
  'makes the engine really send a message, so only a message carries one.';
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

const linkNoCatch = (name: string) =>
  `No 'await link("${name}")' catches this link, and the engine refuses to ` +
  'deploy an emitted link with no catch of its name. Write one where the ' +
  'flow should continue.';
const linkOtherContainer = (name: string) =>
  `'emit link("${name}")' must sit in the same process, subprocess, or ` +
  "handler body as its 'await link': a link cannot cross a subprocess or " +
  "handler boundary, the same way a 'goto' cannot.";
const linkIntoBranch = (name: string, keyword: 'parallel' | 'await') =>
  intoBranchMessage(`emit link("${name}")`, 'emit link', keyword);
const linkNameTaken = (name: string) =>
  `Another 'await link("${name}")' already catches this link: the engine ` +
  'keeps one catch per link name in the whole file, even across subprocesses.';
const linkUnused = (name: string) =>
  `No 'emit link("${name}")' names this catch, so it and the steps after it ` +
  'never run.';
const gotoToLink = (target: string) =>
  `'goto ${target}' cannot target an awaited link: a link catch is entered ` +
  "by 'emit link' of the same name, not by a sequence flow.";

// Code declarations.

const declarationNotAString = (kind: string, key: string) =>
  `An ${kind} declaration's ${key} must be a quoted string.`;
const declarationEmpty = (kind: string, key: string) =>
  `An ${kind} declaration's ${key} cannot be empty.`;
const alreadyDeclared = (kind: string, name: string) =>
  `'${name}' is already declared in this process; '${kind}(${name})' would be ambiguous.`;
const duplicateDeclaredCode = (kind: string, code: string, owner: string) =>
  `${capitalized(kind)} code '${code}' is already declared by '${owner}'; two declarations cannot share a code.`;

// Cases

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

checks('Validation - a JUEL keyword or a hyphen in a rendered name', [
  ...JUEL_RESERVED_WORDS.flatMap((word): Case[] => [
    [
      `'${word}' as a variable is an operator to the engine, at the declaration and at the use`,
      `process p { var ${word}: boolean if (${word}) { user A } }`,
      [
        juelKeywordMessage(word, `execution.getVariable('${word}')`),
        juelKeywordMessage(word, `execution.getVariable('${word}')`),
      ],
    ],
    [
      `'${word}' as a property is an operator to the engine`,
      `process p { var order: json if (order.${word}) { user A } }`,
      [juelKeywordMessage(word, `order['${word}']`)],
    ],
    [
      `'${word}' as a property inside a raw template is the same operator`,
      `process p { if ("\${order.${word}}") { user A } }`,
      [juelKeywordMessage(word, `order['${word}']`)],
    ],
  ]),
  [
    "'true' as a property inside a raw template is the same operator",
    `process p { if ("\${order.true}") { user A } }`,
    [juelKeywordMessage('true', "order['true']")],
  ],
  [
    'a keyword read off a bracketed object in a raw template is keyed on that object',
    `process p { if ("\${items[0].and}") { user A } }`,
    [juelKeywordMessage('and', "items[0]['and']")],
  ],
  [
    'a keyword inside a JUEL string literal or between two templates is text, not a read',
    `process p { user A(assignee: "\${map['x.and'] == 'a.or'} or.and \${b}") }`,
    [],
  ],
  [
    'a keyword read in a listener timeout template is the same operator',
    `process p { user A { on timeout after "\${order.and}"(class: "c.X") } }`,
    [juelKeywordMessage('and', "order['and']")],
  ],
  [
    'a hyphenated variable scans as a subtraction',
    `process p { var my-flag: boolean if (my-flag) { user A } }`,
    [hyphenNameMessage('my-flag', "execution.getVariable('my-flag')")],
  ],
  [
    'a hyphenated property scans the same way, keyed on its object',
    `process p { var order: json if (order.line.is-paid) { user A } }`,
    [hyphenNameMessage('is-paid', "order.line['is-paid']")],
  ],
  [
    'an undeclared hyphenated variable keeps its warning beside the error',
    `process p { if (my-flag) { user A } }`,
    [
      hyphenNameMessage('my-flag', "execution.getVariable('my-flag')"),
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
    [hyphenNameMessage('line-items', "order['line-items']")],
  ],
  [
    'a class name and a topic reach the engine as written',
    `process p { service S(class: com.example.mod) service T(topic: order-events) }`,
    [],
  ],
]);

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

checks('Validation - a condition must be boolean', [
  ...CONDITION_POSITIONS.map(([title, at]): Case => [
    `${title} refuses a number variable`,
    at('n'),
    [nonBooleanCondition("a variable of type 'number'")],
  ]),
  [
    "an 'until' clause cites the multi-instance behaviour",
    `process p { user U for 3 until (nrOfCompletedInstances) }`,
    [nonBooleanConditionMessage("a variable of type 'number'", 'until')],
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

checks('Validation - a composite raw template cannot be an operand', [
  [
    'negated',
    `process p { if (!"\${a} and \${b}") { user A } }`,
    [COMPOSITE_OPERAND_MESSAGE],
  ],
  [
    'compared',
    `process p { if ("\${a} b" == "x") { user A } }`,
    [COMPOSITE_OPERAND_MESSAGE],
  ],
  [
    'as an index',
    `process p { var m: json if (m["\${a} \${b}"]) { user A } }`,
    [COMPOSITE_OPERAND_MESSAGE],
  ],
  [
    'in a ternary arm',
    `process p { var f: boolean if (f ? "\${a} \${b}" : true) { user A } }`,
    [COMPOSITE_OPERAND_MESSAGE],
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

checks('Validation - binding values', [
  [
    'a quoted delegate on a service task never resolves',
    `process p { service S(delegate: "bean") }`,
    [literalElBindingMessage('delegate')],
  ],
  [
    'a quoted expression on a listener evaluates to its own text',
    `process p { user U { on start(expression: "bean.run()") } }`,
    [literalElBindingMessage('expression')],
  ],
  [
    'a quoted mapperDelegate on a call never resolves',
    `process p { call C(process: "q", mapperDelegate: "bean") }`,
    [literalElBindingMessage('mapperDelegate')],
  ],
  [
    'a quoted expression on a thrown message evaluates to its own text',
    `process p { start S throw message("Ack", expression: "b") }`,
    [literalElBindingMessage('expression')],
  ],
  [
    'a template as a class is loaded as a class name',
    `process p { service S(class: "\${cls}") }`,
    [templateAsClassMessage('class', 'delegate')],
  ],
  [
    'a template as a listener class is loaded the same way',
    `process p { user U { on start(class: "\${cls}") } }`,
    [templateAsClassMessage('class', 'delegate')],
  ],
  [
    'a template as a mapper is loaded the same way',
    `process p { call C(process: "q", mapper: "\${cls}") }`,
    [templateAsClassMessage('mapper', 'mapperDelegate')],
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

checks('Validation - an escaped literal as a field value', [
  [
    'quoted text opening with an escaped template has no field slot',
    `process p { service S(class: "com.acme.D") { field x = "\\\${y" } }`,
    [escapedFieldLiteralMessage('x')],
  ],
  [
    'the hash opener and leading whitespace are the same slot',
    `process p { service S(class: "com.acme.D") { field x = "\\#{y}" field z = " \\\${y}" } }`,
    [escapedFieldLiteralMessage('x'), escapedFieldLiteralMessage('z')],
  ],
  [
    'on a listener as well',
    `process p { user U { on start(class: "com.acme.L") { field x = "\\\${y" } } }`,
    [escapedFieldLiteralMessage('x')],
  ],
  [
    'an opener further in is plain text',
    `process p { service S(class: "com.acme.D") { field x = "cost: \\\${y}" } }`,
    [],
  ],
  [
    'an empty literal has neither a fixed value nor an expression',
    `process p { service S(class: "com.acme.D") { field x = "" } }`,
    [emptyFieldMessage('x')],
  ],
  [
    'an empty literal on a listener as well',
    `process p { user U { on start(class: "com.acme.L") { field x = "" } } }`,
    [emptyFieldMessage('x')],
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
    [SECOND_PAREN_VALUE_MESSAGE],
  ],
  [
    'the refusal counts one per extra value, whatever the element',
    `process p { start S user T("a", "b", "c") }`,
    [
      settingsOnlyMessage('a user task'),
      SECOND_PAREN_VALUE_MESSAGE,
      SECOND_PAREN_VALUE_MESSAGE,
    ],
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
    [settingsOnlyMessage(description)],
  ]),
  [
    'an unkeyed value on the process header is refused the same way',
    `process p("a") { user T }`,
    [settingsOnlyMessage('a process header')],
  ],
  [
    'assignee on a service task is not valid there',
    `process p { service S(assignee: "x") }`,
    [
      notValidOn('assignee', 'a service task'),
      bindingRequired(`Service task 'S'`, SERVICE_BINDINGS),
    ],
  ],
  ...(
    [
      ['class', 'user T(class: com.example.X)', 'a user task'],
      [
        'formKey',
        'service S(class: com.example.X, formKey: "f")',
        'a service task',
      ],
      ['assignee', 'call X(process: "p", assignee: "x")', 'a call'],
      ['process', 'user T(process: "p")', 'a user task'],
      ['resultVariable', 'user U(resultVariable: "r")', 'a user task'],
      ['businessKey', 'user U(businessKey: "k")', 'a user task'],
      ['assignee', 'subprocess S(assignee: "a") { user U }', 'a subprocess'],
      ['topic', 'start S end E(topic: "t")', 'an end event'],
    ] as const
  ).map(([key, body, description]): Case => [
    `${key} on ${description} is not valid there`,
    `process p { ${body} }`,
    [notValidOn(key, description)],
  ]),
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
    'an expression, a delegate, or a topic binding alone is enough',
    `process p { service S(expression: "\${bean.method(execution)}") service T(delegate: "\${beanName}") service U(topic: "shipping") }`,
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
    [resultVariableBindingMessage('A service task', 'class', 'serviceTask')],
  ],
  [
    'a service task cannot carry resultVariable beside delegate either',
    `process p { service V(delegate: "\${bean}", resultVariable: "outcome") }`,
    [resultVariableBindingMessage('A service task', 'delegate', 'serviceTask')],
  ],
  [
    'a send task bound with class refuses resultVariable under its own element name',
    `process p { send N(class: com.example.X, resultVariable: "outcome") }`,
    [resultVariableBindingMessage('A send task', 'class', 'sendTask')],
  ],
  [
    'a decision step bound with delegate refuses resultVariable under its own element name',
    `process p { decide D(delegate: "\${bean}", resultVariable: "outcome") }`,
    [
      resultVariableBindingMessage(
        'A decision step',
        'delegate',
        'businessRuleTask',
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
    'a bareword decision names a decision table, not a variable',
    `process p { decide D(decision: riskRating) }`,
    [],
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
  [
    'a receive task takes a message name',
    `process p { receive R(message: "OrderPaid") }`,
    [],
  ],
]);

checks('Validation - settings the engine reads under one binding alone', [
  [
    'resultVariable beside a topic warns that nothing writes it',
    `process p { service V(topic: "t", resultVariable: "r") }`,
    [warn(resultVariableUnreadMessage('topic'))],
  ],
  [
    'resultVariable beside a topic on a decision step warns the same way',
    `process p { decide D(topic: "t", resultVariable: "r") }`,
    [warn(resultVariableUnreadMessage('topic'))],
  ],
  [
    'mapDecisionResult with no resultVariable is built and never applied',
    `process p { decide D(decision: "riskRating", mapDecisionResult: singleEntry) }`,
    [warn(MAP_DECISION_RESULT_UNREAD_MESSAGE)],
  ],
  ...['singleEntry', 'singleResult', 'collectEntries', 'resultList'].map(
    (mapping): Case => [
      `mapDecisionResult ${mapping} with resultVariable is applied when the result is stored, and names no variable`,
      `process p { decide D(decision: "riskRating", mapDecisionResult: ${mapping}, resultVariable: "r") }`,
      [],
    ],
  ),
  ...[
    ['binding', 'binding: latest'],
    ['version', 'version: 2'],
    ['mapDecisionResult', 'mapDecisionResult: singleEntry'],
  ].map(([key, setting]): Case => [
    `${key} on a decision step bound by code is read by nothing, so it is refused`,
    `process p { decide D(class: "com.example.Rate", ${setting}) }`,
    [decisionModifierMessage(key!)],
  ]),
  [
    'two modifiers beside a topic are each refused once',
    `process p { decide D(topic: "t", binding: latest, mapDecisionResult: singleEntry) }`,
    [
      decisionModifierMessage('binding'),
      decisionModifierMessage('mapDecisionResult'),
    ],
  ],
]);

const userWith = (setting: string) => `process p { user U(${setting}) }`;

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

checks('Validation - values the engine parses when the step runs', [
  ...['7', '"7"', '"${p}"', 'weight'].map((value): Case => [
    `priority ${value} parses or evaluates to an integer`,
    `process p { var weight: number user U(priority: ${value}) }`,
    [],
  ]),
  ...['1.5', '"high"'].map((value): Case => [
    `priority ${value} fails the task creation, so it is refused`,
    userWith(`priority: ${value}`),
    [priorityShapeMessage('priority')],
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
      [VERSION_SHAPE_MESSAGE],
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
    [dueDateShapeMessage('dueDate'), dueDateShapeMessage('followUpDate')],
  ],
  ...['"PT10M"', '"R3/PT10M"', '"PT5M,PT10M"', '"${r}"'].map((value): Case => [
    `retryCycle ${value} is a shape the retry parser resolves`,
    userWith(`asyncBefore: true, retryCycle: ${value}`),
    [],
  ]),
  [
    'a retryCycle the parser cannot resolve is dropped, so it only warns',
    userWith('asyncBefore: true, retryCycle: "bogus"'),
    [warn(RETRY_CYCLE_SHAPE_MESSAGE)],
  ],
]);

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
    [TYPE_VALUE_MESSAGE],
  ],
  [
    'a type the engine has no behaviour for names the two it has',
    `process p { service N(type: "ftp") }`,
    [TYPE_VALUE_MESSAGE],
  ],
  [
    'a cc does not stand in for the recipient',
    `process p { service N(type: "mail") { field cc = "c@d" field text = "t" } }`,
    [
      missingBuiltinFieldMessage(
        `Service task 'N'`,
        'mail',
        BUILTIN_REQUIRED_FIELDS.mail[0]!,
      ),
    ],
  ],
  [
    'a subject does not stand in for the body',
    `process p { send N(type: "mail") { field to = "a@b" field subject = "s" } }`,
    [
      missingBuiltinFieldMessage(
        `Send task 'N'`,
        'mail',
        BUILTIN_REQUIRED_FIELDS.mail[1]!,
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
      missingBuiltinFieldMessage(
        `Service task 'N'`,
        'mail',
        BUILTIN_REQUIRED_FIELDS.mail[0]!,
      ),
      missingBuiltinFieldMessage(
        `Service task 'N'`,
        'mail',
        BUILTIN_REQUIRED_FIELDS.mail[1]!,
      ),
    ],
  ],
  [
    'a shell task without a command names the engine check',
    `process p { send S(type: "shell") { field wait = "true" } }`,
    [
      missingBuiltinFieldMessage(
        `Send task 'S'`,
        'shell',
        BUILTIN_REQUIRED_FIELDS.shell[0]!,
      ),
    ],
  ],
  [
    'a shell field written as an expression fails the deployment, so it is refused',
    `process p { service R(type: "shell") { field command = "\${cmd}" } }`,
    [shellFieldExpressionMessage('command')],
  ],
  [
    'a shell flag the engine would read as false is refused',
    `process p { service R(type: "shell") { field command = "ls" field wait = "True" } }`,
    [shellFlagValueMessage('wait')],
  ],
  [
    'a field the mail behaviour does not declare names the ones it does',
    `process p { service N(type: "mail") { field to = "a@b" field text = "t" field recipient = "x" } }`,
    [unknownBuiltinFieldMessage('recipient', 'mail')],
  ],
  [
    'a field the shell behaviour does not declare names the ones it does',
    `process p { service R(type: "shell") { field command = "ls" field args = "x" } }`,
    [unknownBuiltinFieldMessage('args', 'shell')],
  ],
  [
    "a field's own shape is refused first, and the shell rules stand down",
    `process p { service R(type: "shell") { field command = ["ls"] } }`,
    [fieldValueMessage('command')],
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
    [warn(resultVariableUnreadMessage('type'))],
  ],
]);

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
    [missingStep('Missing')],
  ],
  [
    'a goto resolves to a user task, a service task, a script task, and a call',
    `process p { var c: boolean user Foo service Ship(topic: "shipping") script Compute ${FENCE}js\nx = 1\n${FENCE} call F(process: "p") if (c) { goto Foo } if (c) { goto Ship } if (c) { goto Compute } goto F }`,
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
    [emptyLoopBodyMessage('while')],
  ],
  [
    "an empty 'do ... while' body would lose the loop's condition",
    `process p { var flag: boolean do { } while (flag == true) }`,
    [emptyLoopBodyMessage('do')],
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
]);

checks('Validation - where a start may sit', [
  [
    'a start after a chain that still flows on interrupts it, and is a second plain start beside the minted one',
    `process p { user A start S end E }`,
    [startAfterLiveChain('S'), START_AFTER_IMPLICIT_START_MESSAGE],
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
    'a start opening a host-less handler body is legal',
    `process p { error PF service A(class: "x.A") on error(PF) { start S service R(class: "x.R") } }`,
    [],
  ],
  [
    'a start opening a hosted handler body has no scope of its own',
    `process p { error PF service A(class: "x.A") on A: error(PF) { start S service R(class: "x.R") } }`,
    [hostedHandlerStartMessage('S')],
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
]);

checks('Validation - the default start among several', [
  [
    'message and signal starts alone leave no default start',
    `process p { start A message("M") start B signal("S") user T end E }`,
    [warn(noDefaultStartMessage('p'))],
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
    [warn(FORM_NEVER_OFFERED_MESSAGE)],
  ],
  [
    'a form on the default start beside a message start is offered',
    `process p { start A { form { x: number "X" } } start B message("M") user T end E }`,
    [],
  ],
  [
    'with no default start every form is dead',
    `process p { start A message("M") { form { x: number "X" } } start B signal("S") user T end E }`,
    [warn(noDefaultStartMessage('p')), warn(FORM_NEVER_OFFERED_MESSAGE)],
  ],
  [
    'initiator on more than one start warns on every start but the last',
    `process p { start A(initiator: "a") start B message("M", initiator: "b") start C signal("S", initiator: "c") user T end E }`,
    [warn(INITIATOR_SHADOWED_MESSAGE), warn(INITIATOR_SHADOWED_MESSAGE)],
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
    [SECOND_DEFAULT_START_MESSAGE],
  ]),
  ...(
    [
      ['a plain start', 'start S'],
      ['a timer start', 'start S timer(every: "R/PT1H")'],
    ] as const
  ).map(([title, start]): Case => [
    `${title} after a body that does not open with a start is the second default start`,
    `process invoice_batch { end Done ${start} }`,
    [START_AFTER_IMPLICIT_START_MESSAGE],
  ]),
  [
    'a message start after such a body leaves the compiler-minted start the default, so its form is never offered',
    `process p { user T end Done start S message("M") { form { x: number "X" } } }`,
    [warn(FORM_NEVER_OFFERED_MESSAGE)],
  ],
  [
    'two message starts of one name are one subscription too many',
    `process p { start A message("M") start B message("M") user T end E }`,
    [
      warn(noDefaultStartMessage('p')),
      duplicateNamedStartMessage('message', 'M'),
    ],
  ],
  [
    'two signal starts of one name are one subscription too many',
    `process p { start A signal("S") start B signal("S") user T end E }`,
    [
      warn(noDefaultStartMessage('p')),
      duplicateNamedStartMessage('signal', 'S'),
    ],
  ],
  [
    'two condition starts on one condition are one subscription too many',
    `process p { var x: number start A condition(x > 1) start B condition(x > 1) user T end E }`,
    [
      warn(noDefaultStartMessage('p')),
      duplicateConditionStartMessage('${x > 1}'),
    ],
  ],
  [
    'starts of one kind with different payloads coexist',
    `process p { var x: number start A message("M") start B message("N") start C signal("M") start D condition(x > 1) start E condition(x > 2) user T end F }`,
    [warn(noDefaultStartMessage('p'))],
  ],
]);

checks('Validation - duplicate declarations', [
  [
    'two vars with one name is one error naming the process',
    `process p { var total: number var total: string start S end E }`,
    [duplicateVariable('total', 'p')],
  ],
  [
    'two labels on one process is one error',
    `process p(label: "First", label: "Second") { start S end E }`,
    [duplicateSetting('label')],
  ],
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
    [PARALLEL_ELSE_BESIDE_UNCONDITIONED_MESSAGE],
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
    [PARALLEL_SECOND_ELSE_MESSAGE],
  ],
  [
    "an 'else' branch with no conditioned sibling has nothing to fall back from",
    `process p { parallel { { user A } else { user B } } }`,
    [PARALLEL_ELSE_WITHOUT_CONDITION_MESSAGE],
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
 * The `if` carries an `else if`, so a row on it also pins that the chain's one
 * head takes the settings for the whole chain.
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
    [loopJoinKeyMessage('joinAsyncBefore', description)],
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
    [settingsOnlyMessage('an if statement')],
  ],
  [
    'a repeated key is one duplicate',
    hostOf('parallel')('asyncBefore: true, asyncBefore: true'),
    [duplicateSetting('asyncBefore')],
  ],
  [
    'asyncAfter on an await block is what the engine refuses on an event-based gateway',
    awaitHead('asyncAfter: true'),
    [refusedHeadKeyMessage('asyncAfter', 'an await block')],
  ],
  [
    'a quoted boolean in a join key names the unquoted form',
    ifHead('joinAsyncBefore: true, joinExclusive: "false"'),
    [quotedBoolean('joinExclusive')],
  ],
  [
    'a decimal in joinJobPriority is refused as on an element',
    ifHead('joinAsyncBefore: true, joinJobPriority: 1.5'),
    [priorityShapeMessage('joinJobPriority')],
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
    [warn(prunedJoinMessage('if statement', 'joinAsyncBefore'))],
  ],
  [
    'a join key on a parallel whose every branch ends has no join to set, and draws no pairing warning on top',
    `process p { parallel (asyncBefore: true, joinJobPriority: 5) { { end A } { end B } } }`,
    [warn(prunedJoinMessage('parallel statement', 'joinJobPriority'))],
  ],
  [
    'the same if without an else keeps its join, so the join key is clean',
    `process p { var a: boolean if (a) (joinAsyncBefore: true) { end A } }`,
    [],
  ],
]);

checks('Validation - job-setting pairing', [
  [
    "a task's and a handler's retryCycle, exclusive and jobPriority need their own async flag",
    `process p {
  service A(class: "x", retryCycle: "PT1M", exclusive: false, jobPriority: 5)
  on message("M", retryCycle: "PT1M") { user B }
}`,
    [
      warn(
        noJobMessage(
          'retryCycle',
          ['asyncBefore', 'asyncAfter'],
          'a service task',
        ),
      ),
      warn(
        noJobMessage(
          'exclusive',
          ['asyncBefore', 'asyncAfter'],
          'a service task',
        ),
      ),
      warn(
        noJobMessage(
          'jobPriority',
          ['asyncBefore', 'asyncAfter'],
          'a service task',
        ),
      ),
      warn(
        noJobMessage(
          'retryCycle',
          ['asyncBefore', 'asyncAfter'],
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
        noJobMessage(
          'retryCycle',
          ['asyncBefore', 'asyncAfter'],
          'an if statement',
        ),
      ),
      warn(
        noJobMessage(
          'joinJobPriority',
          ['joinAsyncBefore', 'joinAsyncAfter'],
          'an if statement',
        ),
      ),
      warn(
        noJobMessage(
          'exclusive',
          ['asyncBefore', 'asyncAfter'],
          'a while loop',
        ),
      ),
      warn(
        noJobMessage(
          'jobPriority',
          ['asyncBefore', 'asyncAfter'],
          'a do-while loop',
        ),
      ),
      warn(
        noJobMessage(
          'retryCycle',
          ['asyncBefore', 'asyncAfter'],
          'a parallel statement',
        ),
      ),
      warn(
        noJobMessage(
          'joinExclusive',
          ['joinAsyncBefore', 'joinAsyncAfter'],
          'a parallel statement',
        ),
      ),
      warn(
        noJobMessage(
          'jobPriority',
          ['asyncBefore', 'asyncAfter'],
          'an await block',
        ),
      ),
      warn(
        noJobMessage(
          'joinRetryCycle',
          ['joinAsyncBefore', 'joinAsyncAfter'],
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
      warn(noJobMessage('retryCycle', ['asyncBefore', 'asyncAfter'], 'a step')),
      warn(noJobMessage('exclusive', ['asyncBefore', 'asyncAfter'], 'a step')),
      warn(
        noPerRunJobMessage(
          'jobPriority',
          ['runAsyncBefore', 'runAsyncAfter'],
          'a repeated step',
        ),
      ),
      warn(
        noPerRunJobMessage(
          'runRetryCycle',
          ['runAsyncBefore', 'runAsyncAfter'],
          'a repeated step',
        ),
      ),
      warn(
        noPerRunJobMessage(
          'runExclusive',
          ['runAsyncBefore', 'runAsyncAfter'],
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
        noJobMessage(
          'exclusive',
          ['asyncBefore', 'asyncAfter'],
          'a start event',
        ),
      ),
      warn(
        noJobMessage(
          'retryCycle',
          ['asyncBefore', 'asyncAfter'],
          'a start event',
        ),
      ),
      warn(
        noJobMessage(
          'jobPriority',
          ['asyncBefore', 'asyncAfter'],
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
      [NESTED_START_FORM_MESSAGE],
    ],
    [
      `an initiator on the start of ${kind} is never written`,
      wrap('start In(initiator: "who") user A'),
      [NESTED_START_INITIATOR_MESSAGE],
    ],
  ]),
  [
    'a constraint name outside the six and validator names the eight settings',
    `process p { start S { form { amount: number (minimum: 0) } } }`,
    [unknownFormFieldSettingMessage('amount', 'minimum')],
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
    ['required: false', 'string', [flagFalseMessage('required')]],
    ['required: "true"', 'string', [flagNotTrueMessage('required')]],
    ['min: "abc"', 'number', [integerBoundMessage('min')]],
    ['max: 1.5', 'number', [integerBoundMessage('max')]],
    ['minlength: 2.5', 'string', [integerBoundMessage('minlength')]],
    ['pattern: ""', 'date', [PATTERN_VALUE_MESSAGE]],
    ['min: -5', 'number', []],
    ['min: "-5"', 'number', []],
    ['maxlength: "80"', 'string', []],
    ['validator: com.example.Check', 'string', []],
    ['validator: ""', 'string', [VALIDATOR_EMPTY_MESSAGE]],
    ['pattern: "dd-xx-yyyy"', 'date', [PATTERN_LETTERS_MESSAGE]],
    [`pattern: "'T'HH:mm"`, 'date', []],
  ]),
  [
    "a bare word in a field's parens is not a setting",
    `process p { start S { form { amount: number (required) } } }`,
    [
      warn(undeclared('required')),
      formFieldSettingsOnlyMessage('amount', 'required'),
    ],
  ],
  [
    'an enum with no values is a warning',
    `process p { start S { form { plan: enum } } }`,
    [warn(emptyEnumMessage('plan'))],
  ],
  [
    'a repeated value id is one error on the repeat',
    `process p { start S { form { plan: enum { a "A" a "B" } } } }`,
    [duplicateValueMessage('a')],
  ],
  [
    'a literal default outside the values names the ids it can take',
    `process p { start S { form { plan: enum = "zzz" { a "A" b } } } }`,
    [enumDefaultMessage('plan', 'zzz', ['a', 'b'])],
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
    [propertyValueMessage('hint')],
  ],
  [
    'a repeated property key is a duplicate',
    `process p { start S { form { p: string { property hint = "1" property hint = "2" } } } }`,
    [duplicateParameter('property', 'hint')],
  ],
  [
    "an io direction in a field's block is not a member",
    `process p { start S { form { p: enum { a input x = "1" } } } }`,
    [formFieldDirectionMessage('p', 'input', true)],
  ],
  [
    "an io direction in a non-enum field's block names no value lines",
    `process p { start S { form { p: string { input x = "1" } } } }`,
    [formFieldDirectionMessage('p', 'input', false)],
  ],
]);

checks('Validation - form field defaults', [
  [
    'a decimal default on a number field is not an integer',
    `process p { start S { form { n: number = 1.5 } } }`,
    [numberDefaultMessage('n', '1.5')],
  ],
  [
    'a quoted non-digit default on a number field is not an integer',
    `process p { start S { form { n: number = "high" } } }`,
    [numberDefaultMessage('n', '"high"')],
  ],
  [
    'a quoted word default on a boolean field is neither true nor false',
    `process p { start S { form { b: boolean = "yes" } } }`,
    [booleanDefaultMessage('b', '"yes"')],
  ],
  [
    'an ISO default on a date field with no pattern reads against the engine default instead',
    `process p { start S { form { d: date = "2026-01-01" } } }`,
    [isoDateDefaultMessage('d', '2026-01-01')],
  ],
  [
    'an integer, a literal or quoted boolean, and a date fit to its pattern are clean',
    `process p { start S { form { n: number = 5 b: boolean = true c: boolean = "false" d: date = "2026-01-01" (pattern: "yyyy-MM-dd") e: date = "01/01/2026" } } }`,
    [],
  ],
  [
    'a raw expression or a variable default passes on every type, since it is evaluated at render',
    `process p { var x: any var y: number start S { form { n: number = "\${x}" m: number = y } } }`,
    [],
  ],
]);

checks('Validation - unreachable statements', [
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
    [UNREACHABLE, DEAD_LOOP_MESSAGE],
  ],
  [
    'a last do-while whose body always ends leaves its gateway with no incoming flow',
    `process p { var c: boolean start S do { end X } while (c) }`,
    [DEAD_LOOP_MESSAGE],
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
    'a named await after an end is reachable again as a goto target',
    `process p { start S if (c) { goto Wait } end Done await message Wait("M") }`,
    [warn(undeclared('c'))],
  ],
]);

checks('Validation - call activities', [
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
    'a mapper class or a mapper delegate is clean, and runs beside the declared mappings',
    `process p { call X(process: "p", mapper: "com.acme.Mapper") { in * out result } call Y(process: "p", mapperDelegate: "\${mapperBean}") }`,
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
    'a step after a handler reads out of order',
    `process p { error X on error(X) { user A } service S(class: "x.Y") }`,
    [HANDLER_TRAILING],
  ],
  [
    'an error handler cannot run alongside the scope it takes over',
    `process p { error X on error(X, alongside) { user A } }`,
    [noFlowSteps('p'), alongsideMessage('error')],
  ],
  [
    'an empty code string is not a catch-all',
    `process p { on error("") { user A } }`,
    [noFlowSteps('p'), EMPTY_CODE_MESSAGE],
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
    [noFlowSteps('p'), ESCALATION_NO_MESSAGE_MESSAGE],
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
    [onTriggerMessage('erorr')],
  ],
  [
    "'on conditional' is a did-you-mean",
    `process p { start S on conditional { user A } }`,
    [CONDITIONAL_TYPO_MESSAGE],
  ],
  [
    "'on compensate' is a did-you-mean",
    `process p { start S on compensate { user A } }`,
    [COMPENSATE_TYPO_MESSAGE],
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
    [timerJobKeyTwiceMessage('jobPriority')],
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
    "a message, an alongside signal, an 'after', 'at', and alongside 'every' timer, and a condition handler are clean",
    `process p { var amount: number start S on message("PaymentReceived") { user A } on signal("Cancelled", alongside) { user B } on timer("PT1H") { user C } on timer(at: "2026-08-01T09:00:00") { user D } on timer(every: "R/PT10M", alongside) { user E } on condition(amount > 100) { user F } }`,
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
    [noFlowSteps('p'), TIMER_PAYLOAD_MESSAGE],
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
 * A timer start deploys the expression up front
 * (`BpmnDeployer.adjustStartEventSubscriptions`), so its bad shape is an
 * error; every other carrier reads it only when its scope is entered, so its
 * bad shape is a warning.
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
    // An interrupting 'every' handler also draws the fires-at-most-once
    // warning, pinned under "Validation - event handlers".
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

function timerClause(particle: string, value: string): string {
  return particle === 'after' ? `"${value}"` : `${particle}: "${value}"`;
}

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
    message: AFTER_SHAPE_MESSAGE,
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
    message: AT_SHAPE_MESSAGE,
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
    message: EVERY_SHAPE_MESSAGE,
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
    [COMPENSATION_HOST_MESSAGE],
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
    [selfAttachedHostMessage('Self')],
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
    [missingHost('Missing')],
  ],
  [
    'two host-less handlers of an unknown trigger word draw the unknown-kind error alone',
    `process p { user T on foo { user A } on foo { user B } }`,
    [onTriggerMessage('foo'), onTriggerMessage('foo')],
  ],
  [
    'a hosted error handler still cannot run alongside',
    `process p { error X user Pack on Pack: error(X, alongside) { user A } }`,
    [alongsideMessage('error')],
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
    [blockNoFlowSteps('a subprocess', 'S'), COMPENSATION_NO_CODE_MESSAGE],
  ],
  [
    'an undo block carries no values, so bindings are dropped',
    `process p { subprocess S { on compensation(code: c) { user A } } }`,
    [blockNoFlowSteps('a subprocess', 'S'), COMPENSATION_BINDINGS_MESSAGE],
  ],
  [
    'the work an undo block reverses has finished, so alongside is dropped',
    `process p { subprocess S { on compensation(alongside) { user A } } }`,
    [blockNoFlowSteps('a subprocess', 'S'), COMPENSATION_ALONGSIDE_MESSAGE],
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
    [noFlowSteps('p'), COMPENSATION_PLACEMENT_MESSAGE],
  ],
  [
    'a handler body is no subprocess to undo either',
    `process p { error X on error(X) { on compensation { user A } } }`,
    [noFlowSteps('p'), COMPENSATION_PLACEMENT_MESSAGE],
  ],
  [
    'an undo block in a branch is the generic placement error, once',
    `process p { subprocess S { if (true) { on compensation { user A } } } }`,
    [HANDLER_PLACEMENT],
  ],
  [
    'two undo blocks in one subprocess merge into one',
    `process p { subprocess S { on compensation { user A } on compensation { user B } } }`,
    [COMPENSATION_DUPLICATE_MESSAGE, blockNoFlowSteps('a subprocess', 'S')],
  ],
  [
    'two undo blocks in one attempt block merge the same way',
    `process p { attempt A { on compensation { user U1 } on compensation { user U2 } } }`,
    [COMPENSATION_DUPLICATE_MESSAGE, blockNoFlowSteps('an attempt block', 'A')],
  ],
  [
    'one undo block in each of two subprocesses is clean',
    `process p {
  subprocess S1 { user A on compensation { user U1 } }
  subprocess S2 { user B on compensation { user U2 } }
}`,
    [],
  ],
  ...(['throw', 'emit', 'await'] as const).map((keyword): Case => [
    `'${keyword} compensate' is a did-you-mean`,
    `process p { ${keyword} compensate }`,
    [COMPENSATE_TYPO_MESSAGE],
  ]),
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
    [CANCEL_END_PLACEMENT_MESSAGE],
  ],
  [
    'a cancel end in a plain subprocess body has none either',
    `process p { start S subprocess Sub { user A end E cancel } end Done }`,
    [CANCEL_END_PLACEMENT_MESSAGE],
  ],
  [
    'a cancel end in a subprocess nested in an attempt gives up the subprocess',
    `process p { start S attempt A { subprocess Sub { user T end E cancel } } end Done }`,
    [CANCEL_END_PLACEMENT_MESSAGE],
  ],
  [
    'a cancel end in a handler body inside an attempt is not directly in the block',
    `process p { error X start S attempt A { user B on error(X) { user C end E cancel } } end Done }`,
    [CANCEL_END_PLACEMENT_MESSAGE],
  ],
  [
    'a code string after cancel names cancel, not terminate',
    `process p { start S attempt A { user B end E cancel("X") } end Done on A: cancel { user C end F } }`,
    [END_TRIGGER_NO_CODE_MESSAGES.cancel],
  ],
  [
    'a cancel handler on a plain subprocess names what the host is',
    `process p { start S subprocess Sub { user A } end Done on Sub: cancel { user B end E } }`,
    [cancelHost('Sub', 'a subprocess')],
  ],
  [
    'a host-less cancel handler points at the hosted spelling',
    `process p { start S user A on cancel { user B end E } }`,
    [CANCEL_HOSTLESS_MESSAGE],
  ],
  [
    'a cancel handler cannot run alongside the block it drains',
    `process p { start S attempt A { user B end G cancel } end Done on A: cancel(alongside) { user C end E } }`,
    [CANCEL_ALONGSIDE_MESSAGE],
  ],
  [
    'a cancel handler catches nothing by name',
    `process p { start S attempt A { user B end G cancel } end Done on A: cancel("X") { user C end E } }`,
    [CANCEL_NO_CODE_MESSAGE],
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
    'a cancel end with no handler stops the run',
    `process p { start S attempt A { user B end G cancel } end Done }`,
    [warn(cancelEndWithoutHandlerMessage('A'))],
  ],
  [
    'a cancel handler on a block that never gives itself up never runs',
    `process p { start S attempt A { user B } end Done on A: cancel { user C end E } }`,
    [warn(cancelHandlerWithoutEndMessage('A'))],
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
    [warn(cancelHandlerWithoutEndMessage('A'))],
  ],
  [
    "'throw cancel' points at the end that gives the block up",
    `process p { start S throw cancel }`,
    [CANCEL_NOT_RAISED_MESSAGE],
  ],
  [
    "'emit cancel' points there too",
    `process p { start S emit cancel }`,
    [CANCEL_NOT_RAISED_MESSAGE],
  ],
  [
    "'await cancel' points at the end and at the handler that catches it",
    `process p { start S await cancel }`,
    [CANCEL_NOT_AWAITED_MESSAGE],
  ],
]);

checks('Validation - throw and emit', [
  [
    "'emit error' points at 'throw error'",
    `process p { error X emit error(X) }`,
    [emitTriggerMessage('error')],
  ],
  [
    'an unknown throw kind names the kinds with a terminal form',
    `process p { throw banana("X") }`,
    [throwTriggerMessage('banana')],
  ],
  [
    'an unknown emit kind leaves error off the list',
    `process p { emit banana("X") }`,
    [emitTriggerMessage('banana')],
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
    'a thrown message with no code names the shape',
    `process p { start S throw message }`,
    [codeRequired('A thrown', 'message', 'throw')],
  ],
  [
    'a thrown signal is clean',
    `process p { start S throw signal("Alert") }`,
    [],
  ],
  ...(
    [
      ['throw', 'class: "com.example.Send"'],
      ['throw', 'expression: "${sender.send(order)}"'],
      ['throw', 'delegate: "${senderBean}"'],
      ['throw', 'topic: "send-ack"'],
      ['emit', 'class: "com.example.Send"'],
      ['emit', 'topic: "send-ack"'],
    ] as const
  ).map(([keyword, binding]): Case => [
    `a message ${keyword} carries a ${binding.split(':')[0]} implementation`,
    `process p { start S ${keyword} message("Ack", ${binding}) }`,
    [],
  ]),
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
  [
    'an awaited message, timer, signal, and condition are clean',
    `process p { var x: number await message("M") await timer("PT1H") await signal("S") await condition(x > 1) }`,
    [],
  ],
  [
    'an error is raised outward, so it cannot be awaited',
    `process p { error E await error(E) }`,
    [catchTriggerMessage('error')],
  ],
  [
    'an escalation cannot be awaited either',
    `process p { escalation E await escalation(E) }`,
    [catchTriggerMessage('escalation')],
  ],
  [
    'compensation runs through an undo block, not an await',
    `process p { await compensation }`,
    [catchTriggerMessage('compensation')],
  ],
  [
    'an unknown word names the kinds an await takes and where the rest are written',
    `process p { start S await nonsense }`,
    [catchTriggerMessage('nonsense')],
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
    [TIMER_PAYLOAD_MESSAGE],
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
    [raceDuplicateMessage(trigger, 'Dup')],
  ]),
  [
    'a message branch and a signal branch of one name are two subscriptions',
    `process p { await { message("Dup") { user A } signal("Dup") { user B } } }`,
    [],
  ],
  [
    'a race branch a parse error leaves without a trigger draws no phantom trigger error',
    `process p { start S  await { (label: "x") message M } }`,
    [
      "Expecting token of type 'ID' but found `(`.",
      "Expecting token of type '{' but found `message`.",
      "Expecting token of type '=' but found `}`.",
      "Expecting: expecting at least one iteration which starts with one of these possible Token sequences::\n  <[ID]>\nbut found: '}'",
      notValidOn('label', 'a branch of an await block'),
      warn(emptyNumberedBranch(1, 'await')),
      blockParameter('message'),
    ],
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
    [LINK_CATCH_FLOW_MESSAGE],
  ],
  [
    'a link cannot head a race branch',
    `process p { await { link("L") { user A } message("M") { user B } } }`,
    [LINK_IN_RACE_MESSAGE],
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
      linkThrowNeverRunsMessage("Setting 'asyncBefore'"),
      linkThrowNeverRunsMessage("Setting 'jobPriority'"),
      linkThrowNeverRunsMessage("The 'on end' listener"),
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
    [throwTriggerMessage('link')],
  ],
]);

checks('Validation - start triggers', [
  [
    'a message start, a signal start, and a labelled repeating timer start are clean',
    `process p { start A message("OrderReceived") start B signal("Ready") start C timer(every: "R/PT10M", label: "Scheduled") user T end E }`,
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
    [TIMER_PAYLOAD_MESSAGE],
  ],
  [
    'a timer key on a non-timer start belongs to a timer',
    `process p { start S message(at: "PT1H") }`,
    [startNameRequired('message'), START_PARTICLE_ONLY],
  ],
  [
    'the engine ignores an error start',
    `process p { error X start S error(X) }`,
    [startTriggerMessage('error')],
  ],
  [
    'the engine ignores an escalation start',
    `process p { escalation X start S escalation(X) }`,
    [startTriggerMessage('escalation')],
  ],
  [
    'a compensation start points at the undo block',
    `process p { start S compensation }`,
    [startTriggerMessage('compensation')],
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
    [CONDITIONAL_TYPO_MESSAGE],
  ],
  [
    'an unknown start kind names the legal ones',
    `process p { start S nonsense("X") }`,
    [startTriggerMessage('nonsense')],
  ],
  [
    'a message start name cannot hold a trailing expression',
    `process p { start S message("Order\${x}") }`,
    [startMessageExpressionMessage('Order${x}')],
  ],
  [
    'a message start name cannot hold a whole expression',
    `process p { start S message("#{orderType}") }`,
    [startMessageExpressionMessage('#{orderType}')],
  ],
  [
    'the other expression spelling is rejected too',
    `process p { start S message("Order#{x}") }`,
    [startMessageExpressionMessage('Order#{x}')],
  ],
  [
    'a signal start, an awaited message, and a handler message name may hold either expression spelling: the process is running',
    `process p { start P start S signal("Order\${x}") start T signal("#{orderType}") await message("Order\${x}") await message("#{orderType}") user A on message("Order\${x}") { user B } }`,
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
    [START_TRIGGER_IN_HANDLER_MESSAGE],
  ],
  [
    'a triggered start nested in a plain branch draws no block-specific message, just the ordinary positional one',
    `process p { start S if (true) { start In message("M") } end E }`,
    [startNotFirst('In')],
  ],
]);

checks('Validation - end triggers', [
  [
    'a terminate end is clean in a process body, a subprocess body, and a handler body, with or without a label',
    `process p { error X start S subprocess Sub { user A end E terminate } user B end G terminate(label: "All stop") on error(X) { user C end F terminate } }`,
    [],
  ],
  [
    'terminate names nothing',
    `process p { start S end E terminate("X") }`,
    [END_TRIGGER_NO_CODE_MESSAGES.terminate],
  ],
  [
    'an error is raised with throw, not on an end',
    `process p { error Ack start S end E error(Ack) }`,
    [endTriggerMessage('error')],
  ],
  [
    'an escalation is raised with throw',
    `process p { escalation Ack start S end E escalation(Ack) }`,
    [endTriggerMessage('escalation')],
  ],
  [
    'a message is raised with throw',
    `process p { start S end E message("Ack") }`,
    [endTriggerMessage('message')],
  ],
  [
    'a signal is raised with throw',
    `process p { start S end E signal("Ack") }`,
    [endTriggerMessage('signal')],
  ],
  [
    'a compensation is raised with throw',
    `process p { start S end E compensation("Ack") }`,
    [endTriggerMessage('compensation')],
  ],
  [
    'a timer end names the places a timer belongs',
    `process p { start S end E timer("PT1H") }`,
    [END_TIMER_MESSAGE],
  ],
  [
    'a condition end names the places a condition belongs',
    `process p { start S end E condition }`,
    [END_CONDITION_MESSAGE],
  ],
  [
    'the near-miss spelling gets the same answer',
    `process p { start S end E conditional }`,
    [END_CONDITION_MESSAGE],
  ],
  [
    'an unknown end kind names both end words and the throw alternative',
    `process p { start S end E nonsense }`,
    [endTriggerMessage('nonsense')],
  ],
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
    [unknownDeclarationKindMessage('usr')],
  ],
  [
    'a mistyped step keyword is named rather than blamed on the brace after it',
    `process p { usr Review { } }`,
    [
      "Expecting token of type '}' but found `{`.",
      'Expecting end of file but found `}`.',
      noFlowSteps('p'),
      unknownDeclarationKindMessage('usr'),
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
      ESCALATION_NO_MESSAGE_MESSAGE,
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
    [DECLARATION_SETTINGS_ONLY_MESSAGE],
  ],
  [
    'a bare word in a declaration is refused, and is no undeclared variable',
    `process p { error E(SOMETHING) user A }`,
    [DECLARATION_SETTINGS_ONLY_MESSAGE],
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
    [quotedCodeMessage('error', 'PAYMENT_DECLINED')],
  ],
  [
    'text no name could spell is declared under a name the author picks',
    `process p { start S emit escalation("review.manual") }`,
    [quotedCodeMessage('escalation', 'review.manual')],
  ],
  [
    'a caught code is a declared name too',
    `process p { start S user T on error("X") { user U } }`,
    [quotedCodeMessage('error', 'X')],
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
        noPropertyHostMessage(description),
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
        noMappingHostMessage(description),
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
    [unknownDirectionMessage('inp', ['input', 'output'])],
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
    'an empty or a whitespace-only string value writes no value at all',
    `process p { user U { input a = "" input b = "  " } }`,
    [warn(EMPTY_STRING_VALUE_MESSAGE), warn(EMPTY_STRING_VALUE_MESSAGE)],
  ],
  [
    "an empty string reached through a list item or a map entry's value warns the same way",
    `process p { user U { input a = ["x", ""] input b = { k: "" } } }`,
    [warn(EMPTY_STRING_VALUE_MESSAGE), warn(EMPTY_STRING_VALUE_MESSAGE)],
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

checks('Validation - injected fields', [
  [
    'a class-bound service task, a delegate-bound send task, and a class-bound decision step carry a field, quoted or as an expression, beside io parameters',
    `process p { service V(class: "com.acme.D") { field greeting = "hello" } send N(delegate: "\${sender}") { field subject = "\${topic}" } decide D(class: "com.acme.R") { input amount = 1 field greeting = "hello" output risk = 2 } }`,
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
      fieldValueMessage('greeting'),
      unknownDirectionMessage('fld', ['input', 'output', 'field', 'property']),
    ],
  ],
  [
    'a user task names the kinds that take a field',
    `process p { user U { field greeting = "hello" } }`,
    [noFieldHostMessage('a user task')],
  ],
  [
    'a start event names the kinds that take a field',
    `process p { start S { field greeting = "hello" } }`,
    [noFieldHostMessage('a start event')],
  ],
  [
    'a class-bound listener and a delegate-bound task listener carry a field',
    `process p { user U { on start(class: "com.acme.L") { field greeting = "hello" } on complete(delegate: "\${listenerBean}") { field greeting = "hello" } } }`,
    [],
  ],
  [
    'an expression-bound listener takes no field',
    `process p { user U { on start(expression: "\${bean.run(task)}") { field greeting = "hello" } } }`,
    [
      fieldBindingMessage(
        `The 'on start' listener`,
        ['expression'],
        LISTENER_FIELD_BINDINGS,
      ),
    ],
  ],
  [
    'a fenced-script listener takes no field',
    `process p { user U { on start ${FENCE}groovy\nlog(task)\n${FENCE} { field greeting = "hello" } } }`,
    [scriptListenerFieldMessage(`The 'on start' listener`)],
  ],
  [
    'a fenced script beside a class binding is still what refuses the field',
    `process p { user U { on start(class: "com.acme.L") ${FENCE}groovy\nlog(task)\n${FENCE} { field greeting = "hello" } } }`,
    [scriptListenerFieldMessage(`The 'on start' listener`)],
  ],
  [
    'a number, a bareword, a list, a map, and an inline script are not field values, one refusal each',
    `process p { var salutation: string service V(class: "com.acme.D") { field retries = 3 field greeting = salutation field greetings = ["a", "b"] field text = { text: "hi" } field body = ${FENCE}groovy\n"hi"\n${FENCE} } }`,
    [
      fieldValueMessage('retries'),
      fieldValueMessage('greeting'),
      fieldValueMessage('greetings'),
      fieldValueMessage('text'),
      fieldValueMessage('body'),
    ],
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
    [unknownDirectionMessage('fld', ['input', 'output', 'field', 'property'])],
  ],
  [
    "a listener's block takes a field alone, so an input there is unrecognized",
    `process p { user U { on start(class: "com.acme.L") { input x = 1 } } }`,
    [unknownDirectionMessage('input', ['field'])],
  ],
]);

/** `BpmnParse.parseExternalServiceTask` reads these extras and nothing else does. */
checks('Validation - external task extras', [
  [
    'a priority under a class binding names the binding written',
    `process p { service V(class: "c.D", taskPriority: 5) }`,
    [topicBindingMessage('A service task', "'taskPriority'", ['class'])],
  ],
  [
    'a priority under a decision binding names the binding written',
    `process p { decide D(decision: "k", taskPriority: 5) }`,
    [topicBindingMessage('A decision step', "'taskPriority'", ['decision'])],
  ],
  [
    'a priority on a thrown message is an unknown key, topic or not',
    `process p { start S emit message M("X", topic: "t", taskPriority: 5) }`,
    [notValidOn('taskPriority', 'an emit statement')],
  ],
  [
    'a property line under a class binding names the binding written',
    `process p { service V(class: "c.D") { property k = "v" } }`,
    [topicBindingMessage('A service task', 'a property line', ['class'])],
  ],
  [
    'a property value is text',
    `process p { service V(topic: "t") { property k = ["a"] } }`,
    [propertyValueMessage('k')],
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
  [
    'a mapping under a class binding names the binding written',
    `process p { error E service V(class: "c.D") { error E when "\${x}" } }`,
    [topicBindingMessage('A service task', 'an error mapping', ['class'])],
  ],
  [
    'a mapping raises an error and nothing else',
    `process p { escalation S service V(topic: "t") { escalation S when "\${x}" } }`,
    [MAPPING_HEAD_MESSAGE],
  ],
  [
    'a mapping is written with when',
    `process p { error E service V(topic: "t") { error E wenn "\${x}" } }`,
    [MAPPING_WHEN_MESSAGE],
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

checks(
  'Validation - a priority is an integer or an expression',
  (
    [
      ['taskPriority', '1.5', [priorityShapeMessage('taskPriority')]],
      ['taskPriority', '"high"', [priorityShapeMessage('taskPriority')]],
      ['jobPriority', '2.5', [priorityShapeMessage('jobPriority')]],
      ['jobPriority', 'true', [priorityShapeMessage('jobPriority')]],
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
    'a form reference resolved by binding or pinned to a version, a bareword form id, and a form key alone are accepted',
    `process p { user T(formRef: "review-form", binding: latest) user U(formRef: "review-form", version: 2) user V(formRef: reviewForm, binding: latest) user W(formKey: "review-form") }`,
    [],
  ],
  [
    'a form key beside a form reference is one error',
    `process p { user T(formKey: "k", formRef: "review-form", binding: latest) }`,
    [FORM_KEY_AND_REF_MESSAGE],
  ],
  [
    'a form reference with no binding is one error',
    `process p { user T(formRef: "review-form") }`,
    [FORM_REF_BINDING_MESSAGE],
  ],
  [
    'a binding with no form reference has nothing to pin',
    `process p { user T(binding: latest) }`,
    [FORM_REF_MISSING_MESSAGE],
  ],
  [
    'a version with no form reference has nothing to pin',
    `process p { user T(version: 2) }`,
    [FORM_REF_MISSING_MESSAGE],
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
    [LISTENER_TIMER_PAYLOAD_MESSAGE],
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

const header = (setting: string) => `process p(${setting}) { start S }`;

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
      [HISTORY_TIME_TO_LIVE_MESSAGE],
    ],
  ),
  [
    'a bareword historyTimeToLive is refused the same way and names no variable',
    header('historyTimeToLive: P90D'),
    [HISTORY_TIME_TO_LIVE_MESSAGE],
  ],
  [
    'a versionTag template is stored as its own text, so it is refused',
    header('versionTag: "${v}"'),
    [VERSION_TAG_LITERAL_MESSAGE],
  ],
  [
    'a number in versionTag asks for quotes',
    header('versionTag: 3'),
    [VERSION_TAG_LITERAL_MESSAGE],
  ],
  [
    'a bareword in versionTag asks for quotes and names no variable',
    header('versionTag: deadline'),
    [VERSION_TAG_LITERAL_MESSAGE],
  ],
  [
    'a 64-character versionTag fits its column',
    header(`versionTag: "${'v'.repeat(64)}"`),
    [],
  ],
  [
    'a 65-character versionTag overflows its column',
    header(`versionTag: "${'v'.repeat(65)}"`),
    [VERSION_TAG_LENGTH_MESSAGE],
  ],
  [
    'a template anywhere in a starter list is stored as a literal id, so it is refused',
    header(
      'candidateStarterUsers: "demo, ${starter}", candidateStarterGroups: "#{g}"',
    ),
    [
      candidateStarterMessage('candidateStarterUsers'),
      candidateStarterMessage('candidateStarterGroups'),
    ],
  ],
  [
    'a header label or documentation is a quoted string, never a number or a template',
    header('label: 3, documentation: "${d}"'),
    [headerLiteralMessage('label'), headerLiteralMessage('documentation')],
  ],
  [
    'a bareword header label names no variable',
    header('label: foo'),
    [headerLiteralMessage('label')],
  ],
  [
    'a label on a step still takes the expression a task name evaluates',
    `process p { user U(label: "\${who}") }`,
    [],
  ],
]);

const DECORATED_CLAUSE =
  'for each line in lines sequentially until (nrOfCompletedInstances >= 2)';

/**
 * Each host writes whatever else its own validation demands, so the only
 * diagnostics a case can produce are the slots'.
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
        REPEAT_COUNT_MESSAGE,
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
      ).toEqual([REPEATED_OUTPUT_MESSAGE]);
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
      runWithoutClauseMessage('runAsyncBefore', description),
      runWithoutClauseMessage('runAsyncAfter', description),
      runWithoutClauseMessage('runExclusive', description),
      runWithoutClauseMessage('runRetryCycle', description),
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
    [RUN_JOB_PRIORITY_MESSAGE],
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
 * A hard keyword in a slot makes the parser recover with the slot left empty,
 * so each program reaches one check that reads an empty name or trigger back.
 * A row without a word empties its slot another way: a form field type is a
 * keyword alternation with no `ID` alternative, and a trailing `STRING` or
 * value can be left out.
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
