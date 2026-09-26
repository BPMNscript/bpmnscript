// A case pins a program's whole diagnostic list in report order; a warning
// carries a `warning:` prefix.

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
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
  booleanShapeMessage,
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

let validate: (input: string) => Promise<ValidationResult<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  validate = validationHelper<Model>(services.BpmnScript);
});

async function diagnosticsOf(source: string): Promise<string[]> {
  const { diagnostics } = await validate(source);
  return withTextMessages(diagnostics).map((d) =>
    d.severity === DiagnosticSeverity.Warning
      ? `warning: ${d.message}`
      : d.message,
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

/** One form, a field `f<i>` per row; an enum gets a value to keep its empty-values warning out. */
function formFieldRows(
  concern: string,
  rows: Array<
    [setting: string, type: string, expected: (id: string) => string[]]
  >,
): Case {
  const fields = rows.map(
    ([setting, type], i) =>
      `f${i}: ${type} (${setting})${type === 'enum' ? ' { a }' : ''}`,
  );
  return [
    concern,
    `process p { start S { form { ${fields.join(' ')} } } }`,
    rows.flatMap(([, , expected], i) => expected(`f${i}`)),
  ];
}

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
/** No `type`: a thrown message has no member block for a built-in behaviour's fields. */
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

const noFormBlock = (description: string) =>
  `${capitalized(description)} cannot declare a 'form' block; forms belong on start events and user tasks.`;
const oneFormBlock = (description: string) =>
  `${description} may declare at most one 'form' block.`;
const duplicateFormField = (id: string) => `Duplicate form field '${id}'.`;
const formFieldType = (id: string, type: string) =>
  `Form field '${id}' has type '${type}', which a form cannot use. Use string, number, boolean, date, or enum.`;

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

const codeNotDeclared = (trigger: string, name: string) =>
  `'${name}' is not declared. Add '${trigger} ${name}' to the process.`;

const unsupportedScriptTag = (subject: string, tag: string) =>
  `${subject} has an unsupported language tag '${tag}'. ` +
  "Use 'juel', 'js', 'javascript', 'ecmascript', 'groovy', 'py', 'python', " +
  "'rb', 'ruby', or 'feel'.";
const emptyScript = (subject: string) => `${subject} has an empty script body.`;
const unterminatedScript = (name: string) =>
  `Script task '${name}' has a malformed or unterminated fenced script body; ` +
  'a script must be a closed ```<lang> ... ``` block.';

/** `ScriptingEngines.getScriptEngineForLanguage` lowercases the tag, so a mixed-case alias resolves. */
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

const unknownParticle = (word: string) =>
  `Unknown timer particle '${word}'; write 'after', 'at', or 'every'.`;
const REPEATING_INTERRUPTS =
  'A repeating timer that interrupts its scope fires at most once: ' +
  "add 'alongside' to let it repeat, or give it a duration instead.";

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

const illegalHost = (name: string, kind: string) =>
  'A boundary event can only attach to an activity: a user, service, script, ' +
  'send, or receive task, a step, a decision step, a subprocess, an attempt ' +
  `block, or a call; '${name}' is ${kind}.`;
const escalationHost = (name: string, kind: string) =>
  'An escalation boundary can only attach to a subprocess, an attempt block, ' +
  `a call, or a user task; '${name}' is ${kind}.`;

const throwCompensationNames = (keyword: 'throw' | 'emit') =>
  'Compensation undoes completed work: there is nothing to name; ' +
  `write '${keyword} compensation'.`;

const cancelHost = (name: string, kind: string) =>
  `A cancel handler can only attach to an 'attempt' block: it catches that ` +
  `block being given up; '${name}' is ${kind}.`;

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

const declarationNotAString = (kind: string, key: string) =>
  `An ${kind} declaration's ${key} must be a quoted string.`;
const declarationEmpty = (kind: string, key: string) =>
  `An ${kind} declaration's ${key} cannot be empty.`;
const alreadyDeclared = (kind: string, name: string) =>
  `'${name}' is already declared in this process; '${kind}(${name})' would be ambiguous.`;
const duplicateDeclaredCode = (kind: string, code: string, owner: string) =>
  `${capitalized(kind)} code '${code}' is already declared by '${owner}'; two declarations cannot share a code.`;

checks('Validation - variables in expressions', [
  [
    'expressions type-check variables against their declared types',
    `process p {
  var name: string
  var flag: boolean
  var x: any
  if (amount > 1000) { user A }
  user T(formKey: forms.review)
  service S(expression: someBareword)
  service S2(class: com.example.X)
  if (name > 1000) { user A2 }
  if (flag + 1 > 0) { user A3 }
  if (x > 1000) { user A4 }
}`,
    [
      warn(undeclared('amount')),
      typeMismatch('name', 'string', 'an ordered comparison', '>'),
      typeMismatch('flag', 'boolean', 'an arithmetic expression', '+'),
    ],
  ],
  [
    "a variable's declared type gates which operators accept it",
    `process p {
  var amount: number
  if (amount > 1000) { user A }
  if (amount >= 1000) { user A2 }
  if (amount && true) { user A3 }
}`,
    [typeMismatch('amount', 'number', 'a logical expression', '&&')],
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
    'each engine-side attribute treats a bareword as text, a variable, or a bad date consistently',
    `process p {
  user U(candidateGroups: approvers)
  user U2(candidateUsers: approvers)
  user U3(assignee: demo, candidateUsers: demo)
  user U4(assignee: john-doe)
  service V(expression: "\${bean.run()}", resultVariable: approvers)
  user U5(dueDate: approvers)
  user U6(followUpDate: approvers)
  user U7(asyncBefore: true, retryCycle: approvers)
  user U8(priority: deadline)
  user U9(asyncBefore: true, jobPriority: deadline)
  call C(process: "q", businessKey: deadline)
}`,
    [
      warn(undeclared('deadline')),
      warn(undeclared('deadline')),
      warn(undeclared('deadline')),
      unquotedText('dueDate'),
      unquotedText('followUpDate'),
      unquotedText('retryCycle'),
    ],
  ],
]);

checks('Validation - a JUEL keyword or a hyphen in a rendered name', [
  ...JUEL_RESERVED_WORDS.map((word): Case => [
    `'${word}' is an operator to the engine as a variable and as a property, in and outside a raw template`,
    `process p { var ${word}: boolean var order: json if (${word}) { user A } if (order.${word}) { user B } if ("\${order.${word}}") { user C } }`,
    [
      juelKeywordMessage(word, `execution.getVariable('${word}')`),
      juelKeywordMessage(word, `execution.getVariable('${word}')`),
      juelKeywordMessage(word, `order['${word}']`),
      juelKeywordMessage(word, `order['${word}']`),
    ],
  ]),
  [
    'a JUEL keyword or hyphen inside a template scans the same way everywhere',
    `process p {
  var order: json
  if ("\${order.true}") { user A }
  if ("\${items[0].and}") { user A2 }
  user A3(assignee: "\${map['x.and'] == 'a.or'} or.and \${b}")
  if (order.line.is-paid) { user A5 }
  if (my-flag) { user A6 }
  user U for each x in order.line-items
  service S(class: com.example.mod) service T(topic: order-events)
  user A4 { on timeout after "\${order.and}"(class: "c.X") }
}`,
    [
      juelKeywordMessage('true', "order['true']"),
      juelKeywordMessage('and', "items[0]['and']"),
      hyphenNameMessage('is-paid', "order.line['is-paid']"),
      hyphenNameMessage('my-flag', "execution.getVariable('my-flag')"),
      warn(undeclared('my-flag')),
      hyphenNameMessage('line-items', "order['line-items']"),
      juelKeywordMessage('and', "order['and']"),
    ],
  ],
  [
    'a hyphenated variable scans as a subtraction',
    `process p { var my-flag: boolean if (my-flag) { user A } }`,
    [hyphenNameMessage('my-flag', "execution.getVariable('my-flag')")],
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
    'a condition accepts only boolean-shaped expressions, whatever the syntax',
    `process p {
  var order: json
  var n: number
  var flag: boolean
  var f: boolean
  user U for 3 until (nrOfCompletedInstances)
  if ("yes") { user A }
  if (order) { user A2 }
  if (null) { user A3 }
  if (1) { user A4 }
  if (n + 1) { user A5 }
  if (-n) { user A6 }
  if (n > 1 ? "a" : 2) { user A7 }
  if ("\${a} and \${b}") { user A8 }
  if (("yes")) { user A9 }
  if (flag) { user A10 } if (flag && "\${a.b}") { user B } user U2 for 3 until (nrOfCompletedInstances > 1)
  if (x) { user A11 }
  if (order.paid) { user A12 } if (f ? f : 1) { user B2 }
}`,
    [
      nonBooleanConditionMessage("a variable of type 'number'", 'until'),
      nonBooleanCondition('a string'),
      nonBooleanCondition("a variable of type 'json'"),
      "A condition must be boolean, but this one is null: the engine throws 'condition expression returns null' when it evaluates it (UelExpressionCondition.evaluate).",
      nonBooleanCondition('a number'),
      nonBooleanCondition('an arithmetic expression'),
      nonBooleanCondition('an arithmetic expression'),
      nonBooleanCondition('a ternary with no boolean arm'),
      nonBooleanCondition(
        'text around a template, which evaluates to a string',
      ),
      nonBooleanCondition('a string'),
      warn(undeclared('x')),
    ],
  ],
]);

checks('Validation - a composite raw template cannot be an operand', [
  [
    'a composite raw template is refused as an operand in every position',
    `process p {
  var m: json
  var f: boolean
  if (!"\${a} and \${b}") { user A }
  if ("\${a} b" == "x") { user A2 }
  if (m["\${a} \${b}"]) { user A3 }
  if (f ? "\${a} \${b}" : true) { user A4 }
  if (!"\${a.b}") { user A5 }
  if (!"\${map['}']}" && !"\${fn('\${')}") { user A6 }
  service S(class: "com.acme.D") { field subject = "\${a} and \${b}" }
}`,
    [
      COMPOSITE_OPERAND_MESSAGE,
      COMPOSITE_OPERAND_MESSAGE,
      COMPOSITE_OPERAND_MESSAGE,
      COMPOSITE_OPERAND_MESSAGE,
    ],
  ],
]);

checks('Validation - binding values', [
  [
    "a binding value's shape decides whether it resolves as a class, name, or text",
    `process p {
  service S(delegate: "bean")
  call C(process: "q", mapperDelegate: "bean")
  service S2(class: "\${cls}")
  call C2(process: "q", mapper: "\${cls}")
  decide D(decision: "")
  call C3(process: "q", mapper: "") call D2(process: "q", mapperDelegate: "")
  service S3(delegate: bean) service T(expression: bean.method) service U3(class: "com.acme.D3") call C4(process: "q", mapper: com.acme.M)
  user U { on start(expression: "bean.run()") }
  user U2 { on start(class: "\${cls}") }
}`,
    [
      literalElBindingMessage('delegate'),
      literalElBindingMessage('mapperDelegate'),
      templateAsClassMessage('class', 'delegate'),
      templateAsClassMessage('mapper', 'mapperDelegate'),
      emptyBinding('decision', 'decision table to evaluate'),
      emptyBinding('mapper', 'mapping class to load'),
      emptyBinding('mapperDelegate', 'mapping delegate to resolve'),
      literalElBindingMessage('expression'),
      templateAsClassMessage('class', 'delegate'),
    ],
  ],
  [
    'a quoted expression on a thrown message evaluates to its own text',
    `process p { start S throw message("Ack", expression: "b") }`,
    [literalElBindingMessage('expression')],
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
]);

checks('Validation - an escaped literal as a field value', [
  [
    'an escaped template in a field value is text, not an expression, in every host',
    `process p {
  service S(class: "com.acme.D") { field x = "\\\${y" }
  service S2(class: "com.acme.D2") { field x = "\\#{y}" field z = " \\\${y}" }
  service S3(class: "com.acme.D3") { field x = "cost: \\\${y}" }
  service S4(class: "com.acme.D4") { field x = "" }
  user U { on start(class: "com.acme.L") { field x = "\\\${y" } }
  user U2 { on start(class: "com.acme.L2") { field x = "" } }
}`,
    [
      escapedFieldLiteralMessage('x'),
      escapedFieldLiteralMessage('x'),
      escapedFieldLiteralMessage('z'),
      emptyFieldMessage('x'),
      escapedFieldLiteralMessage('x'),
      emptyFieldMessage('x'),
    ],
  ],
]);

checks('Validation - attribute keys and value shapes', [
  [
    "an attribute's declared value shape is enforced regardless of element kind",
    `process p {
  var x: number
  start S await message("M", x > 1)
  user T(assignee: "a", assignee: "b")
  user U(assignee: "demo", formKey: "f", candidateGroups: "approvers", candidateUsers: "ada", dueDate: "2026-09-01T09:00:00", followUpDate: "2026-08-30T09:00:00", priority: 10)
  script T2(resultVariable: "total") ${FENCE}js\n1 + 1\n${FENCE}
  user U2(asyncBefore: true, exclusive: "true")
  user U3(asyncBefore: 1)
  user U4(asyncBefore: flag)
  user U5(asyncBefore: "\${flag}")
  user U6(asyncBefore: true, retryCycle: "R3/PT10M", dueDate: "\${due}", followUpDate: "\${due}")
  user U7(asyncBefore: true, retryCycle: 3)
  user U8(asyncBefore: true, jobPriority: "\${weight}")
}`,
    [
      warn(undeclared('flag')),
      SECOND_PAREN_VALUE_MESSAGE,
      duplicateSetting('assignee'),
      quotedBoolean('exclusive'),
      quotedBoolean('asyncBefore'),
      quotedBoolean('asyncBefore'),
      quotedBoolean('asyncBefore'),
      unquotedText('retryCycle'),
    ],
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
    'assignee and initiator are each valid only on their own element kind',
    `process p {
  start S2(initiator: claimant)
  service S(assignee: "x")
}`,
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
    'a bareword starter list names a principal, not a variable',
    `process p(candidateStarterUsers: demo, candidateStarterGroups: adjusters) { start S }`,
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
    "a service, send, or decision task's binding decides which keys it may carry",
    `process p {
  service S { }
  service S2(expression: "\${bean.method(execution)}") service T(delegate: "\${beanName}") service U(topic: "shipping")
  service V(resultVariable: "r", asyncBefore: true)
  service V2(class: com.example.X, resultVariable: "outcome")
  service V3(delegate: "\${bean}", resultVariable: "outcome")
  send N(class: com.example.X2, resultVariable: "outcome")
  decide D(delegate: "\${bean}", resultVariable: "outcome")
  service V4(expression: "\${bean.method(execution)}", resultVariable: "outcome")
  decide D2(decision: riskRating)
  decide D3(decision: "riskRating", binding: latest, version: 3)
  decide D4(decision: "riskRating", binding: version)
  decide D5(decision: "riskRating", mapDecisionResult: nonsense)
  receive R(message: "OrderPaid")
}`,
    [
      bindingRequired(`Service task 'S'`, SERVICE_BINDINGS),
      bindingRequired(`Service task 'V'`, SERVICE_BINDINGS),
      resultVariableBindingMessage('A service task', 'class', 'serviceTask'),
      resultVariableBindingMessage('A service task', 'delegate', 'serviceTask'),
      resultVariableBindingMessage('A send task', 'class', 'sendTask'),
      resultVariableBindingMessage(
        'A decision step',
        'delegate',
        'businessRuleTask',
      ),
      bindingVersionClash('A decision step'),
      BINDING_IS_VERSION,
      MAP_DECISION_RESULT,
    ],
  ],
  [
    'a doubled or missing binding on a service, send, or decision task is fully named',
    `process p {
  service S(class: com.example.X, expression: "\${bean.method(execution)}")
  send N { }
  decide D { }
}`,
    [
      bindingConflict(
        `Service task 'S'`,
        'class, expression',
        SERVICE_BINDINGS,
      ),
      bindingRequired(`Send task 'N'`, SERVICE_BINDINGS),
      bindingRequired(`Decision step 'D'`, DECISION_BINDINGS),
    ],
  ],
  [
    'a send task or a decision step names both bindings when it carries two',
    `process p {
  send N(class: "com.example.Send", topic: "t")
  decide D(decision: "riskRating", class: "com.example.Rate")
}`,
    [
      bindingConflict(`Send task 'N'`, 'class, topic', SERVICE_BINDINGS),
      bindingConflict(
        `Decision step 'D'`,
        'decision, class',
        DECISION_BINDINGS,
      ),
    ],
  ],
]);

checks('Validation - settings the engine reads under one binding alone', [
  [
    'resultVariable and mapDecisionResult beside a topic binding are each refused once',
    `process p {
  service V(topic: "t", resultVariable: "r")
  decide D(topic: "t", resultVariable: "r")
  decide D2(decision: "riskRating", mapDecisionResult: singleEntry)
  decide D3(topic: "t", binding: latest, mapDecisionResult: singleEntry)
}`,
    [
      warn(resultVariableUnreadMessage('topic')),
      warn(resultVariableUnreadMessage('topic')),
      warn(MAP_DECISION_RESULT_UNREAD_MESSAGE),
      decisionModifierMessage('binding'),
      decisionModifierMessage('mapDecisionResult'),
    ],
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
]);

const userWith = (setting: string) => `process p { user U(${setting}) }`;

type ValueShape = [
  key: string,
  program: (value: string) => string,
  parsed: string[],
  refused: string[],
  message: string,
];

const VALUE_SHAPES: ValueShape[] = [
  [
    'priority',
    (v) => `process p { var weight: number user U(priority: ${v}) }`,
    ['7', '"7"', '"${p}"', 'weight'],
    ['1.5', '"high"'],
    priorityShapeMessage('priority'),
  ],
  ...Object.entries({
    'a call': (v: string) =>
      `process p { call C(process: "q", version: ${v}) }`,
    'a decision step': (v: string) =>
      `process p { decide D(decision: "riskRating", version: ${v}) }`,
    'a form reference': (v: string) =>
      userWith(`formRef: "review-form", version: ${v}`),
  }).map(([carrier, at]): ValueShape => [
    `version on ${carrier}`,
    at,
    ['2', '"2"', '"${v}"'],
    ['1.5', '"abc"', '-1', '0', 'v'],
    VERSION_SHAPE_MESSAGE,
  ]),
  [
    'dueDate',
    (v) => userWith(`dueDate: ${v}`),
    ['"P2D"', '"2026-01-01T00:00:00"', '"${d}"'],
    ['"tomorrow"'],
    dueDateShapeMessage('dueDate'),
  ],
  [
    'followUpDate',
    (v) => userWith(`followUpDate: ${v}`),
    ['"P2D"'],
    ['"next week"'],
    dueDateShapeMessage('followUpDate'),
  ],
  [
    'retryCycle',
    (v) => userWith(`asyncBefore: true, retryCycle: ${v}`),
    ['"PT10M"', '"R3/PT10M"', '"PT5M,PT10M"', '"${r}"'],
    ['"bogus"'],
    warn(RETRY_CYCLE_SHAPE_MESSAGE),
  ],
];

describe('Validation - values the engine parses when the step runs', () => {
  test.each(VALUE_SHAPES)(
    '%s is refused exactly when the engine cannot parse it',
    async (_key, program, parsed, refused, message) => {
      const values = [...parsed, ...refused];
      expect(
        await Promise.all(values.map((v) => diagnosticsOf(program(v)))),
      ).toEqual(values.map((v) => (refused.includes(v) ? [message] : [])));
    },
  );
});

checks('Validation - the mail and shell bindings', [
  [
    "mail and shell task fields validate against each behaviour's own declared shape",
    `process p {
  start S2 emit message("Ack", type: "shell")
  service N(type: "mail") { field to = "a@b" field text = "t" }
  send S(type: "shell") { field command = "echo" field arg1 = "x" field outputVariable = "o" field wait = "true" }
  decide D(type: "shell") { field command = "true" }
  service N2(type: mail) { field to = "a@b" field text = "t" }
  service N3(type: "MAIL")
  service N4(type: "ftp")
  service N5(type: "mail") { field to = "a@b" field text = "t" field html = "<p>t</p>" }
  service R(type: "shell") { field command = "\${cmd}" }
  service R2(type: "shell") { field command = "ls" field wait = "True" }
  service N6(type: "mail") { field to = "a@b" field text = "t" field recipient = "x" }
  service R3(type: "shell") { field command = "ls" field args = "x" }
  service R4(type: "shell") { field command = ["ls"] }
  user U(type: "mail")
  service R5(type: "shell", resultVariable: "r") { field command = "ls" }
}`,
    [
      notValidOn('type', 'an emit statement'),
      TYPE_VALUE_MESSAGE,
      TYPE_VALUE_MESSAGE,
      shellFieldExpressionMessage('command'),
      shellFlagValueMessage('wait'),
      unknownBuiltinFieldMessage('recipient', 'mail'),
      unknownBuiltinFieldMessage('args', 'shell'),
      fieldValueMessage('command'),
      notValidOn('type', 'a user task'),
      warn(resultVariableUnreadMessage('type')),
    ],
  ],
  [
    'a mail cc is not a recipient, and a shell command is required',
    `process p {
  service N(type: "mail") { field cc = "c@d" field text = "t" }
  send S(type: "shell") { field wait = "true" }
}`,
    [
      missingBuiltinFieldMessage(
        `Service task 'N'`,
        'mail',
        BUILTIN_REQUIRED_FIELDS.mail[0]!,
      ),
      missingBuiltinFieldMessage(
        `Send task 'S'`,
        'shell',
        BUILTIN_REQUIRED_FIELDS.shell[0]!,
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
    'a type beside a code binding is the one-binding conflict and nothing more',
    `process p { service N(class: "com.example.X", type: "mail") }`,
    [bindingConflict(`Service task 'N'`, 'class, type', SERVICE_BINDINGS)],
  ],
  [
    'a thrown message has no block for the fields, so it takes no type',
    `process p { start S throw message("Ack", type: "mail") }`,
    [notValidOn('type', 'a throw statement')],
  ],
]);

checks('Validation - script tasks and fenced scripts', [
  [
    'an unsupported language tag names the tag and the supported ones',
    `process p { script total ${FENCE}php\nx = 1\n${FENCE} }`,
    [unsupportedScriptTag(`Script task 'total'`, 'php')],
  ],
  [
    'the tag runs to the first whitespace, so a tag glued to its code is one unsupported tag',
    `process p { script total ${FENCE}groovy1 + 1${FENCE} }`,
    [unsupportedScriptTag(`Script task 'total'`, 'groovy1')],
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
    'a goto resolves to any flow step kind, or is an unresolved linker error alone',
    `process p {
  var c: boolean
  user Foo goto Missing
  user Foo2 service Ship(topic: "shipping") script Compute ${FENCE}js\nx = 1\n${FENCE} call F(process: "p") if (c) { goto Foo2 } if (c) { goto Ship } if (c) { goto Compute } goto F
}`,
    [missingStep('Missing')],
  ],
  [
    'a goto from outside into a parallel branch is one error',
    `process p { parallel { { user A } { user B } } goto A }`,
    [gotoIntoBranch('A', 'parallel')],
  ],
  [
    'a goto stays clean within its own branch but not across parallel siblings',
    `process p {
  parallel { { user A goto B } { user B } }
  parallel { { user A2 goto A2 } { user B2 } }
  await { message("M") { user A3 goto A3 } signal("S") { user B3 } }
}`,
    [gotoIntoBranch('B', 'parallel')],
  ],
  [
    'a goto from outside into a race branch names the await statement',
    `process p { await { message("M") { user A } signal("S") { user B } } goto A }`,
    [gotoIntoBranch('A', 'await')],
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
  [
    'an empty body is refused by naming the step that would need one',
    `process p {
  start S
  attempt A { }
}`,
    [blockNoFlowSteps('an attempt block', 'A')],
  ],
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
]);

checks('Validation - empty branches and bodies', [
  [
    'an empty branch or body is warned about, naming what it would lose',
    `process p {
  var flag: boolean
  var c: boolean
  if (flag == true) { }
  if (flag == true) { user A } else if (flag == false) { }
  if (flag == true) { user A2 } else { }
  while (flag == true) { }
  do { } while (flag == true)
  while (c) { user A3 output y = 1 }
  parallel { { user A4 } { } }
  await { message("M") { } signal("S") { user B } }
  user T on message("Late") { input who = "x" end LateEnd }
}`,
    [
      warn(emptyBranch(`'if' branch`)),
      warn(emptyBranch(`'else if' branch`)),
      warn(emptyBranch(`'else' branch`)),
      emptyLoopBodyMessage('while'),
      emptyLoopBodyMessage('do'),
      blockParameter('output'),
      warn(emptyNumberedBranch(2, 'parallel')),
      warn(emptyNumberedBranch(1, 'await')),
      blockParameter('input'),
    ],
  ],
  [
    'a listener written first in a subprocess body observes nothing',
    `process p { subprocess S { on start(class: "x.L") user A } }`,
    [BLOCK_LISTENER],
  ],
  [
    'an empty handler body is one warning',
    `process p { error X on error(X) { } }`,
    [noFlowSteps('p'), warn(emptyBranch('event handler'))],
  ],
]);

checks('Validation - reserved synthesized-id names', [
  [
    'synthesized ids the desugarer or layouter would generate are reserved names',
    `process p {
  start Gateway_foo_split
  user Gateway_invoice-approval_2_join
  service Gateway_p_0_fork(class: com.example.X)
  user Gateway_p_1_loop
  user Gateway_p_1_race
  user EndEvent_Boundary_T_error
  user StartEvent_EventSubProcess_p_1
  user EndEvent_EventSubProcess_p_1
  subprocess Gateway_x_split { user A }
  subprocess Throw_foo { user B }
  call Catch_x(process: "p")
  user StartEvent_p  user EndEvent_p
  subprocess S { user EndEvent_S }  attempt T { user StartEvent_T }
  user EndEvent_S2  subprocess S2 { user A2 }
  user S_di
  user BPMNDiagram_p
  user BPMNPlane_p
  user GatewayCheck
  user MyFlow_Thing
  user Flow_Control
  user Flow_State
  user StartEventHandler
  user EndEventHandler
  user Gateway_split
}`,
    [
      reservedName('Gateway_foo_split'),
      reservedName('Gateway_invoice-approval_2_join'),
      reservedName('Gateway_p_0_fork'),
      reservedName('Gateway_p_1_loop'),
      reservedName('Gateway_p_1_race'),
      reservedName('EndEvent_Boundary_T_error'),
      reservedName('StartEvent_EventSubProcess_p_1'),
      reservedName('EndEvent_EventSubProcess_p_1'),
      reservedName('Gateway_x_split'),
      reservedName('Throw_foo'),
      reservedName('Catch_x'),
      mintedTerminal('StartEvent_p', 'start', 'p'),
      mintedTerminal('EndEvent_p', 'end', 'p'),
      mintedTerminal('EndEvent_S', 'end', 'S'),
      mintedTerminal('StartEvent_T', 'start', 'T'),
      reservedName('S_di'),
      reservedName('BPMNDiagram_p'),
      reservedName('BPMNPlane_p'),
    ],
  ],
  [
    'a Gateway_ name from an underscore-prefixed process id is caught too',
    `process _p { user Gateway__p_split }`,
    [reservedName('Gateway__p_split')],
  ],
  [
    'every reserved id prefix and shape is rejected, wherever it is written',
    `process p {
  start Flow_A_B
  user Boundary_X_error
  user Throw_p_1
  user EventSubProcess_x
  user Catch_p_1
  subprocess StartEvent_p { user A }
}`,
    [
      reservedName('Flow_A_B'),
      reservedName('Boundary_X_error'),
      reservedName('Throw_p_1'),
      reservedName('EventSubProcess_x'),
      reservedName('Catch_p_1'),
      mintedTerminal('StartEvent_p', 'start', 'p'),
    ],
  ],
  [
    "a modelling tool's default start id is an ordinary name",
    `process p { start StartEvent_1  user EndEvent_1 }`,
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
    'a start event is clean when it opens a handler or subprocess body',
    `process p {
  error PF
  subprocess S2 { start In user A2 end Out }
  service A(class: "x.A") on error(PF) { start S service R(class: "x.R") }
}`,
    [],
  ],
  [
    'a start out of place in a hosted handler or subprocess body is one error',
    `process p {
  error PF
  subprocess S2 { user A2 start In }
  service A(class: "x.A") on A: error(PF) { start S service R(class: "x.R") }
}`,
    [startNotFirst('In'), hostedHandlerStartMessage('S')],
  ],
]);

checks('Validation - the default start among several', [
  [
    'message and signal starts alone leave no default start',
    `process p { start A message("M") start B signal("S") user T end E }`,
    [warn(noDefaultStartMessage('p'))],
  ],
  [
    'the default start among several is picked by trigger kind, or by being alone',
    `process p {
  start A timer(every: "R/PT1H") start B message("M") user T end E
  start A2 message("M2") user T2 end E2
}`,
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
    'a duplicate name collides across element kinds, the process id, and goto targets',
    `process p {
  error X
  escalation Y
  user Review user Review
  user p
  service A(topic: "shipping") script A ${FENCE}js\nx = 1\n${FENCE}
  subprocess S { user A2 } subprocess S { user B }
  throw error Same(X) throw escalation Same(Y)
}`,
    [
      duplicateStepName('Review', 'p'),
      duplicateStepName('A', 'p'),
      duplicateStepName('S', 'p'),
      duplicateStepName('Same', 'p'),
      stepNameEqualsProcess('p'),
      UNREACHABLE,
    ],
  ],
  [
    'a subprocess step name collides with its parent, and an await shares that namespace',
    `process p {
  user A subprocess S { user A }
  user Wait await message Wait("M")
}`,
    [duplicateStepName('A', 'p'), duplicateStepName('Wait', 'p')],
  ],
  [
    'a call sharing a name with a task is one error',
    `process p { user A call A(process: "p") }`,
    [duplicateStepName('A', 'p')],
  ],
]);

checks('Validation - parallel branch heads', [
  [
    'an else branch needs a conditioned sibling to fall back from',
    `process p {
  var amount: number
  parallel {
    if (amount > 10000) { user Audit }
    if (amount > 0) { service RecordReceipt(topic: "receipts") }
    else { user ManualTriage }
  }
  parallel { { user A } else { user B } }
}`,
    [PARALLEL_ELSE_WITHOUT_CONDITION_MESSAGE],
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

/** The `if` carries an `else if`, pinning that the chain's one head takes the settings. */
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
    'jobPriority alone prices a signal subscription, other settings still need their flag',
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
    'a form field belongs only on a start event or a user task',
    `process p {
  start Begin { form { amount: number "Amount" } }
  user Approve(assignee: "demo") { form { approved: boolean "OK?" = false } }
  service S(class: "com.x.Y") { form { a: number } }
}`,
    [noFormBlock('a service task')],
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
  formFieldRows('a constraint fits the type its validator checks', [
    [
      'min: 0',
      'string',
      (f) => [constraintMisfit('min', f, 'string', 'number')],
    ],
    [
      'maxlength: 2',
      'number',
      (f) => [constraintMisfit('maxlength', f, 'number', 'string')],
    ],
    [
      'minlength: 2',
      'date',
      (f) => [constraintMisfit('minlength', f, 'date', 'string')],
    ],
    ['pattern: "dd/MM/yyyy"', 'string', (f) => [patternMisfit(f, 'string')]],
    ['pattern: "dd/MM/yyyy"', 'enum', (f) => [patternMisfit(f, 'enum')]],
    ['min: 0', 'number', () => []],
    ['minlength: 2', 'string', () => []],
    ['required: true', 'boolean', () => []],
    ['pattern: "dd/MM/yyyy"', 'date', () => []],
  ]),
  formFieldRows('a constraint takes one value shape', [
    ['required: false', 'string', () => [flagFalseMessage('required')]],
    ['required: "true"', 'string', () => [flagNotTrueMessage('required')]],
    ['min: "abc"', 'number', () => [integerBoundMessage('min')]],
    ['max: 1.5', 'number', () => [integerBoundMessage('max')]],
    ['minlength: 2.5', 'string', () => [integerBoundMessage('minlength')]],
    ['pattern: ""', 'date', () => [PATTERN_VALUE_MESSAGE]],
    ['min: -5', 'number', () => []],
    ['min: "-5"', 'number', () => []],
    ['maxlength: "80"', 'string', () => []],
    ['validator: com.example.Check', 'string', () => []],
    ['validator: ""', 'string', () => [VALIDATOR_EMPTY_MESSAGE]],
    ['pattern: "dd-xx-yyyy"', 'date', () => [PATTERN_LETTERS_MESSAGE]],
    [`pattern: "'T'HH:mm"`, 'date', () => []],
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
    'a step after an end or a goto is reported as unreachable everywhere',
    `process p {
  start S end Done user A user B
  user A2 goto A2 user Dead
  await { message("M") { end A3 user DeadInside } signal("S2") { end B2 } } user DeadAfter
  subprocess S3 { start In end Out user Dead2 }
}`,
    [
      UNREACHABLE,
      UNREACHABLE,
      UNREACHABLE,
      UNREACHABLE,
      UNREACHABLE,
      UNREACHABLE,
    ],
  ],
  [
    'a goto target survives past an end, but a step after total termination does not',
    `process p {
  start S if (cond) { goto Retry } end Done user Retry
  if (cond) { end A } else { end B } user Dead
}`,
    [warn(undeclared('cond')), warn(undeclared('cond')), UNREACHABLE],
  ],
  [
    'an unreachable compound is reported once, not once per nested step',
    `process p { start S end Done if (cond) { user A user B } }`,
    [warn(undeclared('cond')), UNREACHABLE],
  ],
  [
    'reachability after a parallel or a loop follows whether every branch ends',
    `process p {
  var c: boolean
  start S do { if (c) { end X } else { user A2 } } while (c)
  parallel { { end A } { end B } } user Dead
}`,
    [UNREACHABLE],
  ],
  [
    "a parallel's fallback to its join depends on whether every branch is conditioned",
    `process p {
  var c: boolean
  parallel { if (c) { end A } if (!c) { end B } } user Alive
  parallel { if (c) { end A2 } { end B2 } } user Dead
}`,
    [UNREACHABLE],
  ],
  [
    'a conditioned parallel with an else terminates once every branch does',
    `process p { var c: boolean parallel { if (c) { end A } else { end B } } user Dead }`,
    [UNREACHABLE],
  ],
  [
    'a step after a loop or a conditionless if stays reachable unless the loop always ends',
    `process p {
  var c: boolean
  if (cond) { end A } user Alive
  while (cond) { end A2 } user Alive2
  do { end X } while (c) user Dead
}`,
    [
      warn(undeclared('cond')),
      warn(undeclared('cond')),
      UNREACHABLE,
      DEAD_LOOP_MESSAGE,
    ],
  ],
  [
    'a last do-while whose body always ends leaves its gateway with no incoming flow',
    `process p { var c: boolean start S do { end X } while (c) }`,
    [DEAD_LOOP_MESSAGE],
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
    'a goto target reopens reachability that a throw or an end had closed',
    `process p {
  error X
  start S if (c) { goto Wait } end Done await message Wait("M")
  throw error(X) user Dead
}`,
    [warn(undeclared('c')), UNREACHABLE],
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
]);

checks('Validation - call activities', [
  [
    "a call activity's binding, mappings, and mapper together follow one exclusion rule set",
    `process p {
  var a: number
  var b: number
  var calleeVar: string
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
  call X(process: "p", binding: latest)
  call X2 { }
  call X3(process: "")
  call X4(process: "p", binding: version)
  call X5(process: "p", binding: weekly)
  call X6(process: "p", binding: deployment, version: 2)
  call X7(process: "p", version: 2)
  call X8(process: "p") { in x = a in x = b }
  call X9(process: "p") { in x out x }
  call X10(process: "p") { in * in * }
  call X11(process: "p") { in * in x }
  call X12(process: "p") { out y = calleeVar }
  call X13(process: "p") { out y = calleeVar > 5 && true }
  call X14(process: "p") { in y = callerVar }
  call X15(process: some-id)
  call X16(process: "p", mapper: "com.acme.Mapper") { in * out result } call Y(process: "p", mapperDelegate: "\${mapperBean}")
  call X17(process: "p", mapper: "com.acme.Mapper2", mapperDelegate: "\${mapperBean}")
}`,
    [
      warn(undeclared('callerVar')),
      CALL_PROCESS_REQUIRED,
      emptyBinding('process', 'process to start'),
      BINDING_IS_VERSION,
      BINDING_VALUE,
      bindingVersionClash('A call'),
      duplicateMapping('in', 'x'),
      duplicateAllMapping('in'),
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
    'an event handler scopes to its nearest container and names unknown triggers',
    `process p {
  error X
  start S2 on erorr("X2") { }
  subprocess S { user A on error(X) { user B } }
  if (true) { on error(X) { user A2 } }
  user T on timer("PT1H", jobPriority: 5) { start ES(jobPriority: 7, exclusive: false) user A3 }
}`,
    [
      onTriggerMessage('erorr'),
      HANDLER_PLACEMENT,
      timerJobKeyTwiceMessage('jobPriority'),
    ],
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
    'a misspelled trigger is a did-you-mean, and a timer job key is written once',
    `process p {
  error X
  start S2 on conditional { user A2 }
  on error(X) { user A } service S(class: "x.Y")
  user T on timer("PT1H", jobPriority: 5) { start ES(exclusive: false) user A3 } on timer("PT2H") { start ES2(retryCycle: "R3/PT1M") user B }
}`,
    [CONDITIONAL_TYPO_MESSAGE, HANDLER_TRAILING],
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
    "'compensate' is a did-you-mean, and a variable can share a binding field's name",
    `process p {
  error X
  var message: string
  start S on compensate { user A }
  if (message == "x") { user A2 } on error(X, message: m) { user B }
}`,
    [COMPENSATE_TYPO_MESSAGE],
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

// A timer start's expression is read at deployment
// (`BpmnDeployer.adjustStartEventSubscriptions`), so its bad shape is an error;
// every other carrier reads it on entering its scope, so it only warns.
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

describe("Validation - the timer clause's shape", () => {
  test.each(TIMER_PARTICLE_SHAPES)(
    "every '$particle' value is checked against its shape",
    async ({ particle, bad, good, message }) => {
      const awaits = [...bad, ...good]
        .map((value) => `await timer(${timerClause(particle, value)})`)
        .join(' ');
      expect(await diagnosticsOf(`process p { ${awaits} }`)).toEqual(
        bad.map(() => warn(message)),
      );
    },
  );

  test.each(
    TIMER_CARRIERS.flatMap(({ name, severity, source }) =>
      TIMER_PARTICLE_SHAPES.map(
        ({ particle, bad, good, message }) =>
          [
            name,
            particle,
            severity,
            source,
            bad[0]!,
            good[0]!,
            message,
          ] as const,
      ),
    ),
  )(
    "%s checks its '%s' value",
    async (_name, particle, severity, source, bad, good, message) => {
      expect(await diagnosticsOf(source(particle, bad))).toEqual([
        severity === 'error' ? message : warn(message),
      ]);
      expect(await diagnosticsOf(source(particle, good))).toEqual([]);
    },
  );
});

checks('Validation - boundary hosts', [
  [
    'a boundary host is required only where the trigger kind actually needs one',
    `process p {
  error X
  subprocess S { user A on A: compensation { user Undo } }
  subprocess S2 { user A2 on compensation { user Undo2 } }
  user A3 emit signal Sig("S3") on Sig: error(X) { user B }
}`,
    [COMPENSATION_HOST_MESSAGE, illegalHost('Sig', 'an emit statement')],
  ],
  [
    'a start event is no activity to attach to',
    `process p { error X start S on S: error(X) { user A } }`,
    [illegalHost('S', 'a start event')],
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
    'a catch-all and a coded catch conflict inside one container, but not across it',
    `process p {
  escalation X
  subprocess Sub { user A on escalation { user B } on escalation(X) { user C } }
  subprocess Sub2 { user A2 on escalation { user B2 } } on Sub2: escalation(X) { user C2 }
}`,
    [escalationCatchAllBesideCoded('Sub')],
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
    'two same-trigger handlers on one host conflict, whether hosted or not',
    `process p {
  error X
  user T on foo { user A } on foo { user B }
  user Pack on Pack: error(X, alongside) { user A2 }
}`,
    [
      onTriggerMessage('foo'),
      onTriggerMessage('foo'),
      alongsideMessage('error'),
    ],
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
    'compensation as a trigger word coexists with a variable of the same name',
    `process p {
  error X
  var compensation: number
  if (compensation > 1) { user A3 }
  subprocess S { user A on compensation { user Undo } }
  user A2 on error(X) { emit compensation throw compensation Undo2 }
}`,
    [],
  ],
  [
    'an undo block inherits the placement and setting rules of its container',
    `process p {
  var amount: number
  subprocess S { on compensation("X") { user A } }
  subprocess S2 { start In on compensation(at: "PT1H") { user A2 } }
  subprocess S3 { start In2 on compensation(amount > 100) { user A3 } }
  subprocess S4 { if (true) { on compensation { user A4 } } }
  subprocess S1 { user A5 on compensation { user U1 } }
  subprocess S22 { user B on compensation { user U2 } }
}`,
    [
      blockNoFlowSteps('a subprocess', 'S'),
      COMPENSATION_NO_CODE_MESSAGE,
      PARTICLE_ONLY,
      CONDITION_ONLY,
      HANDLER_PLACEMENT,
    ],
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
    'two undo blocks in one subprocess merge into one',
    `process p { subprocess S { on compensation { user A } on compensation { user B } } }`,
    [COMPENSATION_DUPLICATE_MESSAGE, blockNoFlowSteps('a subprocess', 'S')],
  ],
  [
    'two undo blocks in one attempt block merge the same way',
    `process p { attempt A { on compensation { user U1 } on compensation { user U2 } } }`,
    [COMPENSATION_DUPLICATE_MESSAGE, blockNoFlowSteps('an attempt block', 'A')],
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
    "'emit error' redirects to 'throw error', and an emitted signal carries no code",
    `process p {
  error X
  start S emit signal("Ready", class: "c")
  emit error(X)
  throw banana("X2")
}`,
    [
      noImplementation('class', 'an emitted signal'),
      emitTriggerMessage('error'),
      throwTriggerMessage('banana'),
    ],
  ],
  [
    'an unknown emit kind excludes error, and a codeless thrown error names its shape',
    `process p {
  emit banana("X")
  throw error
}`,
    [emitTriggerMessage('banana'), codeRequired('A thrown', 'error', 'throw')],
  ],
  [
    'an empty code is the same mistake as leaving it out entirely',
    `process p {
  emit signal
  throw escalation("")
}`,
    [
      codeRequired('An emitted', 'signal', 'emit'),
      codeRequired('A thrown', 'escalation', 'throw'),
    ],
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
    "an awaited event's payload and settings are validated per trigger kind",
    `process p {
  var x: number
  error E
  start S2 await nonsense
  await message("M") await timer("PT1H") await signal("S") await condition(x > 1)
  await error(E)
  await compensation
  await message
  await signal
  await timer
  await condition
  await message(at: "PT1H2")
  await message(x > 1)
  await condition("X")
  await condition("X2", at: "2026-01-01")
  await { message("M2", assignee: "u") { user A } signal("S3") { user B } }
  await { message("Dup") { user A2 } signal("Dup") { user B2 } }
}`,
    [
      catchTriggerMessage('nonsense'),
      catchTriggerMessage('error'),
      catchTriggerMessage('compensation'),
      awaitNameRequired('message'),
      awaitNameRequired('signal'),
      TIMER_PAYLOAD_MESSAGE,
      AWAIT_CONDITION_REQUIRED,
      awaitNameRequired('message'),
      AWAIT_PARTICLE_ONLY,
      awaitNameRequired('message'),
      AWAIT_CONDITION_ONLY,
      AWAIT_CONDITION_NO_CODE,
      AWAIT_CONDITION_NO_CODE,
      AWAIT_PARTICLE_ONLY,
      notValidOn('assignee', 'a branch of an await block'),
    ],
  ],
  [
    'an escalation cannot be awaited either',
    `process p { escalation E await escalation(E) }`,
    [catchTriggerMessage('escalation')],
  ],
  ...(['message', 'signal'] as const).map((trigger): Case => [
    `two ${trigger} branches of one race on one name subscribe twice on the gateway`,
    `process p { await { ${trigger}("Dup") { user A } timer("PT1H") { user T } ${trigger}("Dup") { user B } } }`,
    [raceDuplicateMessage(trigger, 'Dup')],
  ]),
  [
    'a race branch a parse error leaves without a trigger draws no phantom trigger error',
    `process p { start S  await { (label: "x") message M } }`,
    [
      "Expecting token of type 'ID' but found `(`.",
      "Expecting token of type '{' but found `message`.",
      "Expected '=' after 'M': inside a block, two plain words start a " +
        "parameter such as 'input name = value'; every step starts with a " +
        "keyword such as 'start', 'user', 'service', 'if', 'on', 'throw', 'emit', ...",
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
    'reachability across a link follows the emit and catch on either end',
    `process p {
  step A emit link T("L") step Dead await link C("L")
  step A2 await link C2("L2") step B emit link T2("L2")
}`,
    [UNREACHABLE, LINK_CATCH_FLOW_MESSAGE],
  ],
  [
    'a link needs a name and cannot head a race branch',
    `process p {
  await { link("L") { user A } message("M") { user B } }
  step A2 end E await link C
  step A3 emit link
}`,
    [
      LINK_IN_RACE_MESSAGE,
      awaitNameRequired('link'),
      codeRequired('An emitted', 'link', 'emit'),
    ],
  ],
  [
    'an emit link refuses engine settings and listeners without duplicating the never-runs error',
    `process p {
  step A emit link T(Retry) await link C(Retry)
  step A3 emit link T3("L2", topic: "shipping") await link C3("L2")
  step A2 emit link T2("L", asyncBefore: true, jobPriority: 5) { on end(class: "x.L") } await link C2("L")
}`,
    [
      barewordName('link', 'Retry'),
      barewordName('link', 'Retry'),
      noImplementation('topic', 'an emitted link'),
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
    "a link catch reaches only its own container, and 'throw link' redirects to 'emit link'",
    `process p {
  subprocess S { step A emit link T("L") } end E await link C("L") step B
  step A2 throw link("L2")
}`,
    [linkOtherContainer('L'), throwTriggerMessage('link')],
  ],
  [
    'an emit link cannot enter a parallel branch from outside it',
    `process p { parallel { { user P if (c) { emit link T("L") } } { end X await link C("L") user B } } }`,
    [warn(undeclared('c')), linkIntoBranch('L', 'parallel')],
  ],
  [
    "a link name's catches are unique across subprocesses, and goto cannot target one",
    `process p {
  step A emit link T("L") await link C1("L") subprocess S { step B emit link T2("L") await link C2("L") step D }
  step A2 if (c) { goto C } emit link T3("L2") await link C("L2") step B2
}`,
    [warn(undeclared('c')), linkNameTaken('L'), gotoToLink('C')],
  ],
  [
    'a link catch nothing emits is a warning, not an error',
    `process p { step A end E await link C("L") step B }`,
    [warn(linkUnused('L'))],
  ],
]);

checks('Validation - start triggers', [
  [
    "a start event's trigger decides which payload it requires or ignores",
    `process p {
  error X
  var amount: number
  start A message("OrderReceived") start B signal("Ready") start C timer(every: "R/PT10M", label: "Scheduled") user T end E
  start S message
  start S2 signal
  start S3 message(at: "PT1H")
  start S4 error(X)
  start S5 compensation
  start S6 condition(amount > 100) user A2
}`,
    [
      startNameRequired('message'),
      startNameRequired('signal'),
      startNameRequired('message'),
      START_PARTICLE_ONLY,
      startTriggerMessage('error'),
      startTriggerMessage('compensation'),
    ],
  ],
  [
    "a start event's missing payload, wrong setting, or bad spelling is named precisely",
    `process p {
  escalation X
  var amount: number
  start S timer
  start S2 escalation(X)
  start S3 condition
  start S4 condition("X2")
  start S5 condition("X3", at: "2026-01-01")
  start S6 message(amount > 100)
  start S7 conditional
  start S8 nonsense("X4")
  start S9 message("Order\${x}")
  start S10 message("#{orderType}")
}`,
    [
      TIMER_PAYLOAD_MESSAGE,
      startTriggerMessage('escalation'),
      START_CONDITION_REQUIRED,
      START_CONDITION_NO_CODE,
      START_CONDITION_NO_CODE,
      START_PARTICLE_ONLY,
      startNameRequired('message'),
      START_CONDITION_ONLY,
      CONDITIONAL_TYPO_MESSAGE,
      startTriggerMessage('nonsense'),
      startMessageExpressionMessage('Order${x}'),
      startMessageExpressionMessage('#{orderType}'),
    ],
  ],
  [
    'a message or signal name accepts either expression spelling, consistently',
    `process p {
  start S message("Order#{x}")
  start P start S2 signal("Order2\${x}") start T signal("#{orderType}") await message("Order2\${x}") await message("#{orderType}") user A on message("Order2\${x}") { user B }
}`,
    [startMessageExpressionMessage('Order#{x}')],
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
    'a signal start and an awaited message both refuse a bareword name',
    `process p {
  start S signal(Ready) user U
  await message(OrderReceived)
}`,
    [barewordName('signal', 'Ready'), barewordName('message', 'OrderReceived')],
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
    'an emitted signal and a race branch head both refuse a bareword name',
    `process p {
  start S emit signal(Ready) user U
  await { message(OrderReceived) { user A } timer("PT1H") { user B } }
}`,
    [barewordName('signal', 'Ready'), barewordName('message', 'OrderReceived')],
  ],
  [
    'an error code is a declared name and stays one',
    `process p { error E start S throw error(E) }`,
    [],
  ],
]);

/** Each source writes the offending paren item second, so a diagnostic on the whole list would miss it. */
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
    'a code declaration is unique per name and per code, across every declaring kind',
    `process p {
  error OUT_OF_STOCK(code: "order.failed", message: "Out of stock")
  escalation MANUAL_REVIEW
  error A
  escalation A
  error B(code: "A")
  error X
  escalation Y(code: "X")
  escalation E(message: "m", wibble: "x")
  error Pack
  start S emit escalation("review.manual")
  user A
  user U
  user U2
  user U3
  user A2
  user Pack
}`,
    [
      quotedCodeMessage('escalation', 'review.manual'),
      alreadyDeclared('escalation', 'A'),
      duplicateDeclaredCode('error', 'A', 'A'),
      notValidOn('wibble', 'an escalation declaration'),
      ESCALATION_NO_MESSAGE_MESSAGE,
    ],
  ],
  [
    'an unknown declaration kind, a shared code, and a repeated key are each named',
    `process p {
  error A(code: "PA")
  error A(code: "PB")
  error C(code: "PB")
  error E(code: "a", code: "b")
  usr Review user A
  user U
  user U2
}`,
    [
      alreadyDeclared('error', 'A'),
      duplicateDeclaredCode('error', 'PB', 'A'),
      duplicateSetting('code'),
      unknownDeclarationKindMessage('usr'),
    ],
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
    'a repeated name reports the name alone, since it repeats the code it stands for',
    `process p { error A error A user U }`,
    [alreadyDeclared('error', 'A')],
  ],
  [
    'two empty codes never collide, but an unquoted code is a missing pair of quotes',
    `process p {
  error A(code: "")
  error B(code: "")
  error E(code: FOO)
  user U
  user A2
}`,
    [
      declarationEmpty('error', 'code'),
      declarationEmpty('error', 'code'),
      declarationNotAString('error', 'code'),
    ],
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
    'a thrown code is a declared name, not quoted text',
    `process p { start S throw error("PAYMENT_DECLINED") }`,
    [quotedCodeMessage('error', 'PAYMENT_DECLINED')],
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
    'a %s is clean in every body, takes a goto and a timer boundary, but no escalation boundary and no repeated name',
    async (_kind, description, statement) => {
      const programs = [
        `process p { user A goto X ${statement} on X: timer("PT1H") { user B } on X: escalation { user C } }`,
        `process p { subprocess S { ${statement} } }`,
        `process p { start S on error { ${statement} } }`,
        `process p { user X ${statement} }`,
      ];
      expect(await Promise.all(programs.map(diagnosticsOf))).toEqual([
        [escalationHost('X', description)],
        [],
        [],
        [duplicateStepName('X', 'p')],
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

describe('Validation - every element with settings and a member block', () => {
  // A flag word lexes as a flag inside any parens, so a stray one reaches the
  // validator. A form or mapping in a `call` block is a parse error, and an
  // external host takes property and mapping lines only under `topic` (below).
  test.each(BLOCK_HOSTS)(
    'the settings and members of %s draw exactly the misfit diagnostics',
    async (kind, description, members, settings) => {
      const labelled = LABEL_HOSTS.has(kind);
      expect(
        await diagnosticsOf(
          settings(
            `${ENGINE_SETTINGS}, wibble: 1, sequentially, label: "L", documentation: "L"`,
          ),
        ),
      ).toEqual([
        notValidOn('wibble', description),
        ...(labelled
          ? []
          : [
              notValidOn('label', description),
              notValidOn('documentation', description),
            ]),
        flagNotValidOn('sequentially', description),
      ]);

      const task = TASK_KINDS.some(([taskKind]) => taskKind === kind);
      const external = EXTERNAL_HOSTS.has(kind);
      const block = [
        'on start(class: "com.example.L")',
        task ? 'on create(class: "com.example.L")' : '',
        kind === 'call' ? '' : 'form { a: number }',
        'input a = 1 output b = "two"',
        external ? '' : 'property k = "v"',
        external || kind === 'call' ? '' : 'error E when "${x}"',
      ].join(' ');
      expect(
        await diagnosticsOf(
          members(block).replace('process p {', 'process p { error E '),
        ),
      ).toEqual([
        ...(kind === 'call' || FORM_HOSTS.has(kind)
          ? []
          : [noFormBlock(description)]),
        ...(PARAMETER_HOSTS.has(kind)
          ? []
          : [noParameters(description), noParameters(description)]),
        ...(external ? [] : [noPropertyHostMessage(description)]),
        ...(external || kind === 'call'
          ? []
          : [noMappingHostMessage(description)]),
        ...(task ? [taskListenerOnly('create', description)] : []),
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
    'input and output parameters validate their direction, name, and value the same way',
    `process p {
  var count: string
  user U { inp a = 1 }
  user U2 { input a = 1 input a = 2 }
  user U3 { input a = 1 output a = 2 }
  service V(topic: "t") { input items = [1, 2] input rows = { k: "v" } input computed = ${FENCE}groovy\n1 + 1\n${FENCE} }
  user U4 { input xs = [${FENCE}cobol\n1\n${FENCE}] }
  user U5 { input m = { "": "empty" } }
  user U6 { input m = { rows: [{ cells: { "": 1 } }] } }
  user U7 { input a = "" input b = "  " }
  user U8 { input a = ["x", ""] input b = { k: "" } }
  user U9 { input count = 1 } step T for 3 until (count >= 2)
  user U10 { input m = { "say \\"hi\\"": 1, "{ braces }": 2, "two
lines": 3, "Grüße 日本": 4 } }
}`,
    [
      typeMismatch('count', 'string', 'an ordered comparison', '>='),
      unknownDirectionMessage('inp', ['input', 'output']),
      duplicateParameter('input', 'a'),
      unsupportedScriptTag(`Input 'xs'`, 'cobol'),
      EMPTY_MAP_KEY,
      EMPTY_MAP_KEY,
      warn(EMPTY_STRING_VALUE_MESSAGE),
      warn(EMPTY_STRING_VALUE_MESSAGE),
      warn(EMPTY_STRING_VALUE_MESSAGE),
      warn(EMPTY_STRING_VALUE_MESSAGE),
    ],
  ],
  ...scriptTagCases(
    (tag) => `process p { user U { input x = ${FENCE}${tag}\n1\n${FENCE} } }`,
    `Input 'x'`,
  ),
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
]);

checks('Validation - injected fields', [
  [
    "a field value's binding rules apply the same way across tasks and listeners",
    `process p {
  var salutation: string
  start S { field greeting = "hello" }
  service V(class: "com.acme.D") { field greeting = "hello" } send N(delegate: "\${sender}") { field subject = "\${topic}" } decide D(class: "com.acme.R") { input amount = 1 field greeting = "hello" output risk = 2 }
  service V2(expression: "\${bean.run(execution)}") { field greeting = "hello" }
  service V3(topic: "t") { field greeting = "hello" }
  decide D2(decision: "riskRating") { field greeting = "hello" }
  service V4(class: "com.acme.D3") { field greeting = 3 fld x = 1 }
  user U { field greeting = "hello" }
  service V5(class: "com.acme.D4") { field retries = 3 field greeting = salutation field greetings = ["a", "b"] field text = { text: "hi" } field body = ${FENCE}groovy\n"hi"\n${FENCE} }
  service V6(class: "com.acme.D5") { field greeting = "hi" field greeting = "ho" }
  service V7(class: "com.acme.D6") { input greeting = 1 field greeting = "hi" }
  service V8(class: "com.acme.D7") { fld greeting = "hi" }
  user U2 { on start(class: "com.acme.L") { field greeting = "hello" } on complete(delegate: "\${listenerBean}") { field greeting = "hello" } }
  user U3 { on start(expression: "\${bean.run(task)}") { field greeting = "hello" } }
  user U4 { on start ${FENCE}groovy\nlog(task)\n${FENCE} { field greeting = "hello" } }
  user U5 { on start(class: "com.acme.L2") ${FENCE}groovy\nlog(task)\n${FENCE} { field greeting = "hello" } }
  user U6 { on start(class: "com.acme.L3") { input x = 1 } }
}`,
    [
      noFieldHostMessage('a start event'),
      fieldBinding('A service task', 'expression'),
      fieldBinding('A service task', 'topic'),
      fieldBinding('A decision step', 'decision'),
      fieldValueMessage('greeting'),
      unknownDirectionMessage('fld', ['input', 'output', 'field', 'property']),
      noFieldHostMessage('a user task'),
      fieldValueMessage('retries'),
      fieldValueMessage('greeting'),
      fieldValueMessage('greetings'),
      fieldValueMessage('text'),
      fieldValueMessage('body'),
      duplicateParameter('field', 'greeting'),
      unknownDirectionMessage('fld', ['input', 'output', 'field', 'property']),
      fieldBindingMessage(
        `The 'on start' listener`,
        ['expression'],
        LISTENER_FIELD_BINDINGS,
      ),
      scriptListenerFieldMessage(`The 'on start' listener`),
      scriptListenerFieldMessage(`The 'on start' listener`),
      unknownDirectionMessage('input', ['field']),
    ],
  ],
  [
    'a service task binding nothing at all has no binding to name in the refusal',
    `process p { service V { field greeting = "hello" } }`,
    [
      fieldBinding('A service task'),
      bindingRequired(`Service task 'V'`, SERVICE_BINDINGS),
    ],
  ],
]);

/** `BpmnParse.parseExternalServiceTask` reads these extras and nothing else does. */
checks('Validation - external task extras', [
  [
    'external task priority, properties, and mappings each name the binding they belong to',
    `process p {
  error E
  escalation S
  start S emit message M("X", topic: "t", taskPriority: 5)
  service V(class: "c.D", taskPriority: 5)
  decide D2(decision: "k", taskPriority: 5)
  service V2(class: "c.D3") { property k = "v" }
  service V3(topic: "t") { property k = ["a"] }
  service V4(topic: "t") { property k = "1" property k = "2" }
  service V5(topic: "t") { property k = "v" } if (k) { step A }
  service V6(class: "c.D4") { error E when "\${x}" }
  service V7(topic: "t") { escalation S when "\${x}" }
  service V8(topic: "t") { error E wenn "\${x}" }
  service V9(topic: "t") { error NOPE when "\${x}" }
  service V10(topic: "t") { error E when externalTask.errorMessage == "x" }
  if (externalTask.retries == 0) { step A2 }
}`,
    [
      codeNotDeclared('error', 'NOPE'),
      warn(undeclared('k')),
      warn(undeclared('externalTask')),
      notValidOn('taskPriority', 'an emit statement'),
      topicBindingMessage('A service task', "'taskPriority'", ['class']),
      topicBindingMessage('A decision step', "'taskPriority'", ['decision']),
      topicBindingMessage('A service task', 'a property line', ['class']),
      propertyValueMessage('k'),
      duplicateParameter('property', 'k'),
      topicBindingMessage('A service task', 'an error mapping', ['class']),
      MAPPING_HEAD_MESSAGE,
      MAPPING_WHEN_MESSAGE,
    ],
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
    'a form reference and a form key each validate their own binding and version rules',
    `process p {
  user T(formRef: "review-form", binding: latest) user U(formRef: "review-form", version: 2) user V(formRef: reviewForm, binding: latest) user W(formKey: "review-form")
  user T2(formKey: "k", formRef: "review-form", binding: latest)
  user T3(formRef: "review-form")
  user T4(binding: latest)
  user T5(version: 2)
  user T6(formRef: "review-form", binding: latest, version: 2)
  user T7(formRef: "review-form", binding: version)
  user T8(formRef: "review-form", binding: newest)
}`,
    [
      FORM_KEY_AND_REF_MESSAGE,
      FORM_REF_BINDING_MESSAGE,
      FORM_REF_MISSING_MESSAGE,
      FORM_REF_MISSING_MESSAGE,
      bindingVersionClash('A user task'),
      BINDING_IS_VERSION,
      BINDING_VALUE,
    ],
  ],
]);

checks('Validation - listeners', [
  [
    'a task listener validates its event, binding, and timer the same way a task does',
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
  service V(topic: "t") { on create(class: "com.example.C") }
  user U2 { on start(class: "com.example.L", alongside) }
  user U3 { on assign(class: "com.example.C2") }
  subprocess S { on wibble(class: "com.example.C3") } { user U4 }
  user U5 { on start }
  user U6 { on start(class: "com.example.C4", delegate: "\${bean}") }
  user U7 { on start(topic: "t") }
  user U8 { on timeout(class: "com.example.T2") }
  user U9 { on create after "PT1H" (class: "com.example.C5") }
  user U10 { on timeout whenever "PT1H2" (class: "com.example.T3") }
  user U11 { on start ${FENCE}php\necho 1;\n${FENCE} }
  user U12 { on start ${FENCE}groovy\n${FENCE} }
}`,
    [
      taskListenerOnly('create', 'a service task'),
      flagNotValidOn('alongside', 'a listener'),
      unknownListenerEvent('assign', USER_LISTENER_EVENTS),
      unknownListenerEvent('wibble', `'start' or 'end'`),
      bindingRequired(
        `The 'on start' listener`,
        LISTENER_BINDINGS,
        ', or a fenced script body',
      ),
      bindingConflict(
        `The 'on start' listener`,
        'class, delegate',
        LISTENER_BINDINGS,
      ),
      notValidOn('topic', 'a listener'),
      bindingRequired(
        `The 'on start' listener`,
        LISTENER_BINDINGS,
        ', or a fenced script body',
      ),
      LISTENER_TIMER_PAYLOAD_MESSAGE,
      LISTENER_PARTICLE_ONLY,
      unknownParticle('whenever'),
      unsupportedScriptTag(`The 'on start' listener`, 'php'),
      emptyScript(`The 'on start' listener`),
    ],
  ],
  [
    'listeners repeat freely and fire in written order (CoreModelElement.addListenerToMap appends)',
    `process p { user U { on start(class: "a.B") on start(class: "c.D") on timeout after "PT1H"(class: "x.Y") on timeout after "P1D"(class: "x.Z") } }`,
    [],
  ],
  ...scriptTagCases(
    (tag) =>
      `process p { user U { on start ${FENCE}${tag}\nx = 1\n${FENCE} } }`,
    `The 'on start' listener`,
  ),
]);

describe('Validation - the timer clause, reported in place', () => {
  // The squiggle covers the word the author wrote, not the whole listener.
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
    `process p(label: "P", documentation: "D", versionTag: "1.0.0", historyTimeToLive: "P90D", candidateStarterUsers: "demo,manager", candidateStarterGroups: "adjusters", isStartableInTasklist: false) {
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
    'a quoted isStartableInTasklist is refused, since it would lower to nothing',
    header('isStartableInTasklist: "false"'),
    [booleanShapeMessage('isStartableInTasklist')],
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
  // deeply it nests, so one host carries the forms.
  test('every clause form validates, and only a count that is no integer or expression is refused', async () => {
    const clauses = [
      'for 3',
      'for each line in lines',
      'for each in lines',
      'for 2 each line in lines',
      DECORATED_CLAUSE,
      'for "3"',
      'for count',
      `for "\${count}"`,
      ...[
        'nrOfInstances',
        'nrOfActiveInstances',
        'nrOfCompletedInstances',
        'loopCounter',
      ].map((variable) => `for 3 until (${variable} >= 2)`),
      'for 1.5',
      'for -3',
      'for "high"',
    ];
    expect(
      await diagnosticsOf(
        `process p { var lines: json var count: number ${clauses.map((c, i) => `user U${i} ${c}`).join(' ')} subprocess Outer { user V ${DECORATED_CLAUSE} } on error { user W ${DECORATED_CLAUSE} } }`,
      ),
    ).toEqual([
      REPEAT_COUNT_MESSAGE,
      REPEAT_COUNT_MESSAGE,
      REPEAT_COUNT_MESSAGE,
    ]);
  });

  test.each(REPEAT_HOSTS)(
    "only an 'output' parameter on a repeated %s is refused",
    async (_kind, _description, statement) => {
      expect(
        await Promise.all(
          [
            statement('for 3', '', 'input a = 1 output b = 1'),
            statement('', '', 'output b = 1'),
          ].map((body) => diagnosticsOf(`process p { ${body} }`)),
        ),
      ).toEqual([[REPEATED_OUTPUT_MESSAGE], []]);
    },
  );
});

checks('Validation - the repeat clause in scope', [
  [
    "the repeat clause's element variable is in scope, and an author's own declaration wins",
    `process p {
  var lines: json
  var loopCounter: string
  user U for each line in lines { input x = line }
  user U2 for 3 until (loopCounter >= 2)
  subprocess B for each line in lines { user U3 for 2 }
}`,
    [typeMismatch('loopCounter', 'string', 'an ordered comparison', '>=')],
  ],
  [
    'a process with no clause still warns about a loop variable',
    `process p { user U { input x = loopCounter } }`,
    [warn(undeclared('loopCounter'))],
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
    'a per-run job key is legal only on a step that actually repeats',
    `process p {
  var a: boolean
  start S(runAsyncBefore: true)
  if (a) (runAsyncBefore: true) { user A }
  step X for 2(runJobPriority: 5)
  service V for 3(topic: "t", runAsyncBefore: true, runExclusive: "false")
  service V2 for 3(topic: "t", runAsyncBefore: true, runRetryCycle: 3)
  service V3 for 3(topic: "t", runAsyncBefore: true, runRetryCycle: R2)
  step X2 for 2(asyncBefore: true, runAsyncBefore: true)
}`,
    [
      notValidOn('runAsyncBefore', 'a start event'),
      notValidOn('runAsyncBefore', 'an if statement'),
      RUN_JOB_PRIORITY_MESSAGE,
      quotedBoolean('runExclusive'),
      unquotedText('runRetryCycle'),
      unquotedText('runRetryCycle'),
    ],
  ],
  [
    'runJobPriority on a kind that never repeats is an unknown key there',
    `process p { start S(runJobPriority: 5) }`,
    [notValidOn('runJobPriority', 'a start event')],
  ],
]);

/**
 * A hard keyword in a slot makes the parser recover with the slot empty; a row
 * without a word empties its slot another way, by omitting it.
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
  // A container name is only read back when a goto crosses it.
  [
    'a subprocess name a goto reaches into',
    `process p { start S subprocess { user U } goto U end E }`,
  ],
  [
    'a subprocess name a goto reaches out of',
    `process p { start S subprocess { goto Fin } user U end Fin }`,
  ],
  ['a process name', `process while { start S end E }`, 'while'],
  // A duplicate walk is what reads the process name back.
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
    // The colliding `var` makes the agreement check read the type.
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
  // Duplicate keys built from two slots, where a missing half would stringify.
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
  test('no unparsed slot crashes a check or draws a diagnostic naming what it cannot name', async () => {
    const problems: string[][] = [];
    for (const [where, program, word] of UNPARSED_SLOT) {
      const messages = await diagnosticsOf(program);
      const wrong = messages.filter(
        (m) =>
          m.includes('An error occurred during validation') ||
          m.includes('undefined'),
      );
      if (word !== undefined && !messages.includes(reservedWord(word))) {
        wrong.push(`missing: ${reservedWord(word)}`);
      }
      if (wrong.length > 0) problems.push([where, ...wrong]);
    }
    expect(problems).toEqual([]);
  });

  // With no container name to cite, the boundary explanation stands down.
  test('a goto across an unnamed handler or subprocess keeps the stock unresolved-reference message', async () => {
    const crossings: Array<[program: string, name: string]> = [
      [`process p { start S on { step T } goto T end E }`, 'T'],
      [`process p { start S on { goto T } step T end E }`, 'T'],
      [`process p { start S subprocess { user U } goto U end E }`, 'U'],
      [`process p { start S subprocess { goto Fin } user U end Fin }`, 'Fin'],
    ];
    for (const [program, name] of crossings) {
      expect(await diagnosticsOf(program), program).toContain(
        unresolvedStatement(name),
      );
    }
  });

  test('an unterminated fence resolves to the malformed-body error', async () => {
    const messages = await diagnosticsOf(
      `process p { script total ${FENCE}js\nx = 1\n }`,
    );
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
