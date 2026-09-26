import {
  AstUtils,
  GrammarAST,
  isCompositeCstNode,
  isLeafCstNode,
  type AstNode,
  type AstNodeDescription,
  type CstNode,
  type MaybePromise,
  type ReferenceInfo,
  type Stream,
} from 'langium';
import {
  DefaultCompletionProvider,
  type CompletionAcceptor,
  type CompletionContext,
  type NextFeature,
} from 'langium/lsp';
import {
  CompletionItemKind,
  InsertTextFormat,
} from 'vscode-languageserver-types';
import {
  isBlock,
  isCodeDecl,
  isEmitStatement,
  isFormField,
  isListener,
  isOnHandler,
  isParenValue,
  isProcess,
  isSetting,
  isStatement,
  isSubProcess,
  isThrowStatement,
  isVarRef,
  CodeDecl,
  ErrorMapping,
  Listener,
  LiteralBool,
  OnHandler,
  VarRef,
  type Block,
  type ParenItem,
} from './generated/ast.js';
import type { BpmnScriptServices } from './bpmn-script-module.js';
import {
  isActivityStatement,
  isAttemptBlock,
  isEscalationLegalHost,
  isVariableUse,
  NON_VARIABLE_ATTR_KEYS,
} from './bpmn-script-validator.js';
import {
  isStructuralParenKey,
  payloadItemOf,
  settingsOf,
  timerParticleOf,
  triggerWordOf,
} from './paren-items.js';
import {
  isRepeated,
  type VariableSymbolProvider,
} from './variable-symbol-provider.js';
import {
  attributeBlockRuleOf,
  BOOLEAN_ENGINE_KEYS,
  CALL_BINDING_VALUES,
  CATCH_TRIGGERS,
  DECLARED_CODE_TRIGGERS,
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  ENGINE_KEYS,
  engineSpellings,
  ERROR_MAPPING_HEAD,
  ERROR_MAPPING_WHEN,
  eventBindingFieldsFor,
  EXECUTION_LISTENER_EVENTS,
  EXTERNAL_BINDING_KEY,
  FIELD_BINDING_KEYS,
  FIELD_DIRECTION,
  FORM_FIELD_SETTING_KEYS,
  FORM_FIELD_TYPES,
  gatewayStatementRuleOf,
  JOIN_ENGINE_KEYS,
  joinSettingKey,
  JUEL_LITERAL_WORDS,
  LISTENER_BINDING_KEYS,
  listenerEventsFor,
  namesACode,
  ON_TRIGGERS,
  parameterDirectionsFor,
  PROCESS_HEADER_KEYS,
  PROPERTY_DIRECTION,
  RACE_TRIGGERS,
  RUN_ENGINE_KEYS,
  runSettingKey,
  SCRIPT_FORMAT_ALIASES,
  START_TRIGGERS,
  THROW_BINDING_TRIGGER,
  THROW_TRIGGERS,
  TIMER_PARTICLE_BY_KIND,
  TRIGGER_PAYLOAD,
  TYPE_BINDING_KEY,
  TYPE_BINDING_VALUES,
  type EngineKey,
} from './vocabulary.js';

interface StructureForm {
  readonly label: string;
  readonly insertText: string;
}

const SCRIPT_LANGUAGES = [
  ...new Set(Object.values(SCRIPT_FORMAT_ALIASES)),
].join(',');

const declaredCodeChoices = (triggers: readonly string[]): string =>
  triggers.filter((word) => DECLARED_CODE_TRIGGERS.has(word)).join(',');

const subscriptionChoices = (triggers: readonly string[]): string =>
  triggers
    .filter((word) => namesACode(word) && !DECLARED_CODE_TRIGGERS.has(word))
    .join(',');

/**
 * Keyed by keyword; accepting one scaffolds the whole construct and leaves the
 * caret inside it. A keyword absent here keeps Langium's bare-keyword item.
 */
const STRUCTURE_SNIPPETS: Readonly<
  Record<string, string | readonly StructureForm[]>
> = {
  process: 'process ${1:name} {\n\t$0\n}',
  var: 'var ${1:name}: ${2|string,number,boolean,date,json,any|}',
  start: 'start ${1:name}',
  end: 'end ${1:name}',
  user: 'user ${1:id}(assignee: "${2:user}")',
  service: 'service ${1:id}(class: "${2:com.example.Delegate}")',
  step: 'step ${1:id}',
  send: 'send ${1:id}(class: "${2:com.example.Delegate}")',
  receive: 'receive ${1:id}(message: "${2:MessageName}")',
  decide: 'decide ${1:id}(decision: "${2:decision-key}")',
  script: 'script ${1:id} ```${2|' + SCRIPT_LANGUAGES + '|}\n\t$0\n```',
  if: 'if (${1:condition}) {\n\t$0\n}',
  while: 'while (${1:condition}) {\n\t$0\n}',
  do: 'do {\n\t$1\n} while (${2:condition})',
  parallel: [
    {
      label: 'parallel',
      insertText: 'parallel {\n\t{\n\t\t$1\n\t}\n\t{\n\t\t$2\n\t}\n}',
    },
    {
      label: 'parallel if',
      insertText:
        'parallel {\n\tif (${1:condition}) {\n\t\t$2\n\t}\n\telse {\n\t\t$3\n\t}\n}',
    },
  ],
  subprocess: 'subprocess ${1:id} {\n\t$0\n}',
  attempt: 'attempt ${1:id} {\n\t$0\n}',
  // A code names a header declaration and is written bare; a subscription name
  // is quoted. A timer or condition payload is scaffolded at the trigger word
  // instead, and the host is a cross-reference, so neither gets a form here.
  on: [
    {
      label: 'on',
      insertText:
        'on ${1|' +
        declaredCodeChoices(ON_TRIGGERS) +
        '|}(${2:CODE}) {\n\t$0\n}',
    },
    {
      label: 'on message',
      insertText:
        'on ${1|' +
        subscriptionChoices(ON_TRIGGERS) +
        '|}("${2:NAME}") {\n\t$0\n}',
    },
  ],
  throw: [
    {
      label: 'throw',
      insertText:
        'throw ${1|' + declaredCodeChoices(THROW_TRIGGERS) + '|}(${2:CODE})',
    },
    {
      label: 'throw message',
      insertText:
        'throw ${1|' + subscriptionChoices(THROW_TRIGGERS) + '|}("${2:NAME}")',
    },
  ],
  emit: [
    {
      label: 'emit',
      insertText:
        'emit ${1|' + declaredCodeChoices(EMIT_TRIGGERS) + '|}(${2:CODE})',
    },
    {
      label: 'emit message',
      insertText:
        'emit ${1|' + subscriptionChoices(EMIT_TRIGGERS) + '|}("${2:NAME}")',
    },
  ],
  await: [
    {
      label: 'await',
      insertText:
        'await ${1|' + subscriptionChoices(CATCH_TRIGGERS) + '|}("${2:NAME}")',
    },
    {
      label: 'await any',
      insertText:
        'await {\n\t${1|' +
        subscriptionChoices(RACE_TRIGGERS) +
        '|}("${2:NAME}") {\n\t\t$3\n\t}\n\t${4|' +
        subscriptionChoices(RACE_TRIGGERS) +
        '|}("${5:OTHER}") {\n\t\t$6\n\t}\n}',
    },
  ],
  call: 'call ${1:id}(process: "${2:process-id}") {\n\tin ${3:input}\n\tout ${4:result}\n}',
  for: [
    { label: 'for each', insertText: 'for each ${1:item} in ${2:collection}' },
    { label: 'for', insertText: 'for ${1:3}' },
  ],
};

/** The value each engine setting scaffolds, under whichever spelling of the key. */
const ENGINE_VALUE_SNIPPETS: Readonly<Record<EngineKey, string>> = {
  asyncBefore: '${1|true,false|}',
  asyncAfter: '${1|true,false|}',
  exclusive: '${1|false,true|}',
  jobPriority: '${1:50}',
  retryCycle: '"${1:R3/PT10M}"',
};

const engineSnippets = (
  keyOf: (key: string) => string,
  keys: readonly EngineKey[] = ENGINE_KEYS,
): Record<string, string> =>
  Object.fromEntries(
    keys.map((key) => [
      keyOf(key),
      `${keyOf(key)}: ${ENGINE_VALUE_SNIPPETS[key]}`,
    ]),
  );

/**
 * Setting keys lex as plain identifiers, so the default completion offers
 * nothing for them. The `\$` escapes keep an EL `${...}` literal instead of
 * opening a nested placeholder.
 */
const SETTING_SNIPPETS: Readonly<Record<string, string>> = {
  label: 'label: "${1:label}"',
  documentation: 'documentation: "${1:documentation}"',
  ...engineSnippets((key) => key),
  ...engineSnippets(joinSettingKey),
  ...engineSnippets(
    runSettingKey,
    ENGINE_KEYS.filter((key) => RUN_ENGINE_KEYS.includes(runSettingKey(key))),
  ),
  assignee: 'assignee: "${1:user}"',
  formKey: 'formKey: "${1:form-key}"',
  formRef: 'formRef: "${1:form-id}"',
  candidateGroups: 'candidateGroups: "${1:group}"',
  candidateUsers: 'candidateUsers: "${1:user}"',
  dueDate: 'dueDate: "${1:\\${dateTime().plusDays(3)}}"',
  followUpDate: 'followUpDate: "${1:\\${dateTime().plusDays(1)}}"',
  priority: 'priority: ${1:50}',
  class: 'class: "${1:com.example.Delegate}"',
  expression: 'expression: "${1:\\${bean.method(execution)}}"',
  delegate: 'delegate: "${1:\\${beanName}}"',
  mapper: 'mapper: "${1:com.example.CallMapper}"',
  mapperDelegate: 'mapperDelegate: "${1:\\${callMapperBean}}"',
  [EXTERNAL_BINDING_KEY]: `${EXTERNAL_BINDING_KEY}: "\${1:topic-name}"`,
  [TYPE_BINDING_KEY]: `${TYPE_BINDING_KEY}: "\${1|${TYPE_BINDING_VALUES.join(',')}|}"`,
  taskPriority: 'taskPriority: ${1:50}',
  decision: 'decision: "${1:decision-key}"',
  mapDecisionResult:
    'mapDecisionResult: ${1|' + DECISION_RESULT_MAPPINGS.join(',') + '|}',
  message: 'message: "${1:MessageName}"',
  resultVariable: 'resultVariable: "${1:result}"',
  process: 'process: "${1:process-id}"',
  binding: 'binding: ${1|' + CALL_BINDING_VALUES.join(',') + '|}',
  version: 'version: ${1:1}',
  businessKey: 'businessKey: "${1:\\${execution.processBusinessKey}}"',
  versionTag: 'versionTag: "${1:1.0.0}"',
  historyTimeToLive: 'historyTimeToLive: "${1:P30D}"',
  candidateStarterUsers: 'candidateStarterUsers: "${1:demo,manager}"',
  candidateStarterGroups: 'candidateStarterGroups: "${1:adjusters}"',
  initiator: 'initiator: "${1:starter}"',
  // The two form flags are on while written, so neither scaffolds a choice.
  required: 'required: true',
  readonly: 'readonly: true',
  min: 'min: ${1:0}',
  max: 'max: ${1:100}',
  minlength: 'minlength: ${1:1}',
  maxlength: 'maxlength: ${1:80}',
  validator: 'validator: "${1:com.example.Validator}"',
  pattern: 'pattern: "${1:dd/MM/yyyy}"',
};

/**
 * A catch binding names a variable the handler declares, so it is bare; the
 * same `message` key on a receive task is the quoted subscription name.
 */
const CATCH_BINDING_SNIPPETS: Readonly<Record<string, string>> = {
  code: 'code: ${1:code}',
  message: 'message: ${1:message}',
};

/** A declaration's fields are text, so both are quoted. */
const DECLARATION_FIELD_SNIPPETS: Readonly<Record<string, string>> = {
  code: 'code: "${1:code}"',
  message: 'message: "${1:message}"',
};

const settingForms = (
  keys: readonly string[],
  snippets: Readonly<Record<string, string>> = SETTING_SNIPPETS,
): StructureForm[] =>
  keys.map((key) => ({ label: key, insertText: snippets[key] }));

/** The words a value slot offers; a quoted choice inserts its quotes. */
const SETTING_VALUE_CHOICES: Readonly<Record<string, readonly string[]>> = {
  [TYPE_BINDING_KEY]: TYPE_BINDING_VALUES.map((value) => `"${value}"`),
  binding: CALL_BINDING_VALUES,
  mapDecisionResult: DECISION_RESULT_MAPPINGS,
};

const BOOLEAN_SETTING_KEYS: ReadonlySet<string> = new Set(
  BOOLEAN_ENGINE_KEYS.flatMap(engineSpellings),
);

const LITERAL_WORDS: ReadonlySet<string> = new Set(JUEL_LITERAL_WORDS);

/** The grammar rule of the two boolean words; `null` has one of its own. */
const BOOLEAN_LITERAL_RULE = LiteralBool.$type;

/**
 * A duration is the bare payload the trigger word's snippet scaffolds, so only
 * the date and cycle keys are offered.
 */
const TIMER_KEY_SNIPPETS: Readonly<Record<string, string>> = {
  [TIMER_PARTICLE_BY_KIND.date]: `${TIMER_PARTICLE_BY_KIND.date}: "\${1:2026-08-01T09:00:00}"`,
  [TIMER_PARTICLE_BY_KIND.cycle]: `${TIMER_PARTICLE_BY_KIND.cycle}: "\${1:R/PT10M}"`,
};

const timerKeyForms = (node: AstNode): StructureForm[] =>
  triggerWordOf(node) === 'timer'
    ? settingForms(Object.keys(TIMER_KEY_SNIPPETS), TIMER_KEY_SNIPPETS)
    : [];

function catchBindingForms(node: AstNode): StructureForm[] {
  if (
    !isOnHandler(node) ||
    TRIGGER_PAYLOAD[node.trigger]?.parens !== 'bindings'
  )
    return [];
  return settingForms(
    eventBindingFieldsFor(node.trigger),
    CATCH_BINDING_SNIPPETS,
  );
}

const itemsOf = (owner: AstNode): ParenItem[] =>
  (owner as { items?: ParenItem[] }).items ?? [];

/**
 * Whether a setting is legal only after the unkeyed payload. A throw or emit
 * must name its code even where a handler of the same trigger may catch every
 * code.
 */
function payloadRequired(owner: AstNode): boolean {
  const trigger = triggerWordOf(owner);
  if (trigger === undefined) return false;
  const rule = TRIGGER_PAYLOAD[trigger];
  return (
    rule !== undefined &&
    (rule.code === 'required' ||
      rule.timer ||
      rule.parens === 'condition' ||
      ((isThrowStatement(owner) || isEmitStatement(owner)) &&
        namesACode(trigger)))
  );
}

/**
 * Keyed on the payload's CST end against the caret's token, not the caret: a
 * word still being typed at the slot is that slot, not something after it.
 */
function payloadWritten(owner: AstNode, context: CompletionContext): boolean {
  const items = itemsOf(owner);
  const payload = payloadItemOf(items) ?? timerParticleOf(items)?.node;
  return (
    payload?.$cstNode !== undefined &&
    payload.$cstNode.end <= context.tokenOffset
  );
}

const payloadOpen = (owner: AstNode, context: CompletionContext): boolean =>
  payloadRequired(owner) && !payloadWritten(owner, context);

function conditionSlotOpen(context: CompletionContext): boolean {
  const owner = owningElement(context);
  const trigger = owner === undefined ? undefined : triggerWordOf(owner);
  return (
    owner !== undefined &&
    trigger !== undefined &&
    TRIGGER_PAYLOAD[trigger]?.parens === 'condition' &&
    !payloadWritten(owner, context)
  );
}

/**
 * The only flag any rule lists is the handler's `alongside`, so the list is
 * offered whole where the trigger admits it.
 */
function flagWordsFor(node: AstNode): readonly string[] {
  const trigger = triggerWordOf(node);
  return trigger !== undefined && TRIGGER_PAYLOAD[trigger]?.alongside
    ? (attributeBlockRuleOf(node)?.flags ?? [])
    : [];
}

/**
 * `undefined` where `node` has no parens of its own; `owningElement` keys on
 * that. The `run` keys need the `for` clause the validator requires for them.
 */
function settingFormsFor(node: AstNode): StructureForm[] | undefined {
  if (isProcess(node)) {
    return settingForms(PROCESS_HEADER_KEYS);
  }
  if (isListener(node)) {
    return settingForms(LISTENER_BINDING_KEYS);
  }
  if (isFormField(node)) {
    return settingForms(FORM_FIELD_SETTING_KEYS);
  }
  if (isCodeDecl(node)) {
    return settingForms(
      eventBindingFieldsFor(node.kind),
      DECLARATION_FIELD_SNIPPETS,
    );
  }
  const gateway = gatewayStatementRuleOf(node);
  if (gateway) {
    return settingForms([
      ...ENGINE_KEYS.filter((key) => !gateway.refuses.includes(key)),
      ...(gateway.join ? JOIN_ENGINE_KEYS : []),
    ]);
  }
  const rule = attributeBlockRuleOf(node);
  if (!rule) return undefined;
  // The implementation bindings belong to a thrown or emitted message alone.
  const own =
    (isThrowStatement(node) || isEmitStatement(node)) &&
    node.trigger !== THROW_BINDING_TRIGGER
      ? []
      : rule.own;
  return [
    ...catchBindingForms(node),
    ...settingForms([
      ...own,
      ...ENGINE_KEYS,
      ...(rule.repeats && isRepeated(node) ? RUN_ENGINE_KEYS : []),
    ]),
  ];
}

const writtenKeysOf = (owner: AstNode): ReadonlySet<string> =>
  new Set(settingsOf(itemsOf(owner)).map((setting) => setting.key));

/** A listener's fenced script binds it in place of its settings, so no field. */
function bindsAField(owner: AstNode): boolean {
  if (isListener(owner) && owner.script !== undefined) return false;
  const keys = writtenKeysOf(owner);
  return FIELD_BINDING_KEYS.some((key) => keys.has(key));
}

/** A property line and a mapping ride the topic binding alone; its worker reads them. */
const bindsATopic = (owner: AstNode): boolean =>
  writtenKeysOf(owner).has(EXTERNAL_BINDING_KEY);

const mappingOffered = (owner: AstNode): boolean =>
  (attributeBlockRuleOf(owner)?.externalExtras ?? false) && bindsATopic(owner);

/**
 * A listener's block holds fields alone, for the reason
 * `BpmnScriptValidator.checkListenerFields` gives, and a form field's holds
 * properties alone, so neither has a rule row; a field or a property is
 * offered once the binding it rides is written.
 */
function parameterDirectionsOf(owner: AstNode): readonly string[] {
  if (isListener(owner)) {
    return bindsAField(owner) ? [FIELD_DIRECTION] : [];
  }
  if (isFormField(owner)) {
    return [PROPERTY_DIRECTION];
  }
  const rule = attributeBlockRuleOf(owner);
  if (!rule) return [];
  return parameterDirectionsFor(rule).filter((direction) =>
    direction === FIELD_DIRECTION
      ? bindsAField(owner)
      : direction === PROPERTY_DIRECTION
        ? bindsATopic(owner)
        : true,
  );
}

/**
 * On an element with a body, a lone brace after its head opens the body, not
 * the member block, and `Block` parses a parameter there as readily as the
 * member block does, so none is offered in the body, where it belongs to
 * nothing.
 */
const inBodyOf = (owner: AstNode, context: CompletionContext): boolean =>
  AstUtils.getContainerOfType(context.node, isBlock)?.$container === owner;

/**
 * The validator's `isVariableUse` cannot be asked: with nothing typed after
 * the colon the recovered tree holds the key as a bare value and no `Setting`.
 */
function valueSlotReadsVariable(owner: AstNode, key: string): boolean {
  return (
    !NON_VARIABLE_ATTR_KEYS.has(key) &&
    !BOOLEAN_SETTING_KEYS.has(key) &&
    !isFormField(owner) &&
    !isStructuralParenKey(owner, key) &&
    !isCodeDecl(owner)
  );
}

/** The default's stand-in for an untyped reference, held by the caret's node. */
const referenceStandInAt = (node: AstNode): VarRef => ({
  $type: 'VarRef',
  $container: node as VarRef['$container'],
  $containerProperty: 'ref',
  ref: { $refText: '', ref: undefined },
  accessors: [],
});

/**
 * A mapping with nothing after its head word leaves no node, so the head is
 * read off the text.
 */
const wordBefore = (context: CompletionContext): string | undefined =>
  /(\w+)\s*$/.exec(
    context.textDocument.getText().slice(0, context.tokenOffset),
  )?.[1];

/** A brace the recovery inserted leaves no leaf. */
function closesWithBrace(cst: CstNode): boolean {
  const last = isCompositeCstNode(cst) ? cst.content.at(-1) : undefined;
  return last !== undefined && isLeafCstNode(last) && last.text === '}';
}

/**
 * The innermost block whose braces hold the caret, read off the CST: at
 * `on |` inside a block the recovery closes that block before the handler and
 * hangs it on the process, so the handler's containers say nothing about where
 * it was typed, and the closed block must still count as open past its end.
 */
function innermostOpenBlockAt(context: CompletionContext): Block | undefined {
  return AstUtils.streamAst(context.document.parseResult.value)
    .filter(isBlock)
    .filter((block) => {
      const cst = block.$cstNode;
      return (
        cst !== undefined &&
        cst.offset < context.offset &&
        (cst.end > context.offset || !closesWithBrace(cst))
      );
    })
    .toArray()
    .at(-1);
}

/**
 * Host-less, a handler is an event sub-process and its undo block belongs in
 * the subprocess it undoes; hosted, it is a boundary event, which Operaton
 * attaches as a cancel to a transaction alone. An unresolved host keeps the
 * whole list.
 */
function handlerTriggerWords(
  handler: OnHandler,
  words: readonly string[],
  context: CompletionContext,
): readonly string[] {
  if (handler.host === undefined) {
    const inSubProcess = isSubProcess(
      innermostOpenBlockAt(context)?.$container,
    );
    return words.filter(
      (word) =>
        TRIGGER_PAYLOAD[word]?.hostless &&
        (word !== 'compensation' || inSubProcess),
    );
  }
  const host = handler.host.ref;
  if (host === undefined) return words;
  return words.filter(
    (word) =>
      TRIGGER_PAYLOAD[word]?.boundary &&
      (word !== 'cancel' || isAttemptBlock(host)) &&
      (word !== 'escalation' || isEscalationLegalHost(host)),
  );
}

/**
 * The grammar rule a feature belongs to. Where two rules write one word the
 * rule tells them apart and the caret's node cannot: after a finished construct
 * the node is that construct, not the enclosing one.
 */
function ruleNameOf(node: AstNode): string | undefined {
  return AstUtils.getContainerOfType(node, GrammarAST.isParserRule)?.name;
}

/**
 * A `MapKey` in a parameter value assigns `key` too, and takes the author's
 * own keys. A datatype rule has no generated `$type` to name it by.
 */
export const SETTING_KEY_RULE = 'ParenKey';

export const FLAG_WORD_RULE = 'FlagWord';

const atParenItemStart = (context: CompletionContext): boolean =>
  context.features.some(
    (next) => ruleNameOf(next.feature) === SETTING_KEY_RULE,
  );

/**
 * The key whose value slot holds the caret, or `undefined`. At `key: |` the
 * parser recovers the key as a bare unkeyed value and drops the colon, so that
 * shape is told by the colon still standing between the word and the caret.
 */
function settingKeyAt(context: CompletionContext): string | undefined {
  const node = context.node;
  const setting = AstUtils.getContainerOfType(node, isSetting);
  if (setting !== undefined) return setting.key;
  if (
    !isVarRef(node) ||
    !isParenValue(node.$container) ||
    node.$cstNode === undefined
  ) {
    return undefined;
  }
  const between = context.textDocument
    .getText()
    .slice(node.$cstNode.end, context.offset);
  return between.trim() === ':' ? node.ref.$refText : undefined;
}

/**
 * The element whose settings hold the caret. The caret's node is that element
 * only while its parens are empty and the preceding item's leaf afterwards, so
 * the walk climbs to the first element still enclosing the caret; parens whose
 * closing token is not typed enclose nothing, so there the innermost stands in.
 */
function owningElement(context: CompletionContext): AstNode | undefined {
  let innermost: AstNode | undefined;
  for (
    let node: AstNode | undefined = context.node;
    node;
    node = node.$container
  ) {
    if (settingFormsFor(node) === undefined) {
      continue;
    }
    if ((node.$cstNode?.end ?? 0) > context.offset) {
      return node;
    }
    innermost ??= node;
  }
  return innermost;
}

const TRIGGER_PAYLOAD_SNIPPETS: Readonly<
  Record<string, { insertText: string; detail: string }>
> = {
  timer: {
    insertText: 'timer("${1:PT1H}")',
    detail: 'a scheduled or relative deadline',
  },
  condition: {
    insertText: 'condition(${1:amount > 100})',
    detail: 'a data-change watchdog',
  },
};

const STATEMENT_TRIGGERS: Readonly<
  Record<
    string,
    {
      words: readonly string[];
      details?: Readonly<Record<string, string>>;
    }
  >
> = {
  OnHandler: {
    words: ON_TRIGGERS,
    details: { compensation: 'the undo block of this subprocess' },
  },
  ThrowStatement: {
    words: THROW_TRIGGERS,
    details: {
      compensation: "undo this scope's completed work, then end this path",
    },
  },
  EmitStatement: {
    words: EMIT_TRIGGERS,
    details: {
      compensation: "undo this scope's completed work, then continue",
      link: "jump to the 'await link' of the same name",
    },
  },
  IntermediateCatchEvent: {
    words: CATCH_TRIGGERS,
    details: { link: "the target of an 'emit link' of the same name" },
  },
  RaceBranch: { words: RACE_TRIGGERS },
  StartEvent: { words: START_TRIGGERS },
  EndEvent: {
    words: END_TRIGGERS,
    details: {
      terminate: 'stop every running path in this scope',
      cancel: 'give up the surrounding attempt block',
    },
  },
};

/** The header declarations open with a soft word, so no keyword path offers them. */
const CODE_DECLARATION_FORMS: readonly (StructureForm & { detail: string })[] =
  [...DECLARED_CODE_TRIGGERS].map((kind) => ({
    label: kind,
    detail: `declare an ${kind} code`,
    insertText:
      `${kind} \${1:NAME}` +
      (TRIGGER_PAYLOAD[kind]?.message ? '(message: "${2:message}")' : ''),
  }));

const STRUCTURE_DETAILS: Readonly<Record<string, string>> = {
  call: 'call another process like a function',
  for: 'how often the preceding step runs',
};

const FLAG_DETAIL = 'BPMNscript flag';
const FORM_TYPE_DETAIL = 'BPMNscript form type';
const SETTING_VALUE_DETAIL = 'BPMNscript setting value';

/**
 * Snippet completions for the structural keywords and for the soft words the
 * grammar leaves as plain identifiers; everything else keeps Langium's default.
 */
export class BpmnScriptCompletionProvider extends DefaultCompletionProvider {
  private readonly variables: VariableSymbolProvider;

  constructor(services: BpmnScriptServices) {
    super(services);
    this.variables = services.references.VariableSymbolProvider;
  }

  /** The soft words lex as plain `ID`s, so the default offers nothing for them. */
  protected override completionFor(
    context: CompletionContext,
    next: NextFeature,
    acceptor: CompletionAcceptor,
  ): MaybePromise<void> {
    // The node under the caret stays the shared rule while a keyword still
    // opens more than one shape, so the next feature decides first.
    const nodeType = next.type ?? context.node?.$type;
    const owner = owningElement(context);
    if (
      next.property === 'key' &&
      ruleNameOf(next.feature) === SETTING_KEY_RULE &&
      owner
    ) {
      // Until a required payload is written only the payload is offered, and
      // a timer's date and cycle keys are that payload.
      const forms = payloadOpen(owner, context)
        ? timerKeyForms(owner)
        : (settingFormsFor(owner) ?? []);
      for (const form of forms) {
        this.acceptSnippet(context, acceptor, {
          ...form,
          detail: 'BPMNscript setting',
        });
      }
      return;
    }
    // A form field's type slot admits any word, so the grammar's own list of
    // variable types is replaced by the form types the validator holds it to.
    if (
      next.property === 'type' &&
      AstUtils.getContainerOfType(context.node, isFormField)
    ) {
      if (!GrammarAST.isKeyword(next.feature)) {
        this.acceptWords(context, acceptor, FORM_FIELD_TYPES, FORM_TYPE_DETAIL);
      }
      return;
    }
    if (GrammarAST.isCrossReference(next.feature)) {
      if (atParenItemStart(context)) {
        // A second unkeyed value is refused, so after the payload no
        // reference belongs at the item start.
        if (owner && payloadWritten(owner, context)) return;
      } else {
        const key = settingKeyAt(context);
        const choices =
          key === undefined ? undefined : SETTING_VALUE_CHOICES[key];
        if (choices) {
          this.acceptWords(context, acceptor, choices, SETTING_VALUE_DETAIL);
          return;
        }
      }
    }
    if (
      next.property === 'direction' &&
      !GrammarAST.isKeyword(next.feature) &&
      owner
    ) {
      const directions = inBodyOf(owner, context)
        ? []
        : parameterDirectionsOf(owner);
      if (directions.length > 0) {
        this.acceptParameterDirections(context, acceptor, directions);
        return;
      }
    }
    if (next.property === 'event' && owner) {
      this.acceptListenerEvents(context, acceptor, owner);
      return;
    }
    if (next.property === 'kind' && next.type === CodeDecl.$type) {
      for (const form of CODE_DECLARATION_FORMS) {
        this.acceptSnippet(context, acceptor, form);
      }
      return;
    }
    if (next.property === 'trigger' && next.type === ErrorMapping.$type) {
      if (owner && mappingOffered(owner)) {
        this.acceptSnippet(context, acceptor, {
          label: ERROR_MAPPING_HEAD,
          detail: 'raise a declared error when a reported failure matches',
          insertText: `${ERROR_MAPPING_HEAD} \${1:CODE} ${ERROR_MAPPING_WHEN} \${2:condition}`,
        });
      }
      return;
    }
    if (next.property === 'trigger' && nodeType) {
      const triggers = STATEMENT_TRIGGERS[nodeType];
      if (triggers) {
        const words = isOnHandler(context.node)
          ? handlerTriggerWords(context.node, triggers.words, context)
          : triggers.words;
        this.acceptEventWords(context, acceptor, words, triggers.details);
        return;
      }
    }
    return super.completionFor(context, next, acceptor);
  }

  /**
   * A host resolves against every named statement so the validator can say
   * why a start or a throw cannot carry a boundary event; the offer stops at
   * the activities that can.
   */
  protected override getReferenceCandidates(
    refInfo: ReferenceInfo,
    context: CompletionContext,
  ): Stream<AstNodeDescription> {
    // Inside a block body a bare `on Ins` parses as a complete `Listener`, not
    // an `OnHandler`, so the guard keys on the property: only `OnHandler` has
    // `host`.
    if (refInfo.property !== 'host') {
      return super.getReferenceCandidates(refInfo, context);
    }
    // The recovery hangs a trigger-less handler on the process, so the scope
    // is read for a stand-in placed where the handler was typed.
    const placed: ReferenceInfo = {
      ...refInfo,
      container: {
        $type: OnHandler.$type,
        $container:
          innermostOpenBlockAt(context) ?? refInfo.container.$container,
      },
    };
    return super
      .getReferenceCandidates(placed, context)
      .filter(
        (candidate) =>
          isStatement(candidate.node) && isActivityStatement(candidate.node),
      );
  }

  protected override completionForCrossReference(
    context: CompletionContext,
    next: NextFeature<GrammarAST.CrossReference>,
    acceptor: CompletionAcceptor,
  ): MaybePromise<void> {
    if (next.type === ErrorMapping.$type && next.property === 'code') {
      // Not `owningElement`: with only the head word written the member block
      // is dropped from the CST and the element no longer encloses the caret,
      // so an enclosure walk climbs past it.
      let owner = context.node;
      while (owner !== undefined && attributeBlockRuleOf(owner) === undefined) {
        owner = owner.$container;
      }
      if (
        owner !== undefined &&
        mappingOffered(owner) &&
        wordBefore(context) === ERROR_MAPPING_HEAD
      ) {
        this.acceptMappingCodes(context, acceptor);
      }
      return;
    }
    if (
      next.type === VarRef.$type &&
      next.property === 'ref' &&
      this.variablesOffered(context)
    ) {
      this.acceptVariables(context, acceptor);
      return;
    }
    return super.completionForCrossReference(context, next, acceptor);
  }

  /**
   * The default's stand-in carries no trigger word, and with nothing after the
   * head word no parsed mapping holds one either, so the scope would read no
   * code kind; the stand-in is given the head word the parser has passed.
   */
  private acceptMappingCodes(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
  ): void {
    const standIn: AstNode & { trigger: string } = {
      $type: ErrorMapping.$type,
      $container: context.node,
      $containerProperty: 'code',
      trigger: ERROR_MAPPING_HEAD,
    };
    const refInfo: ReferenceInfo = {
      reference: { $refText: '', ref: undefined },
      container: standIn,
      property: 'code',
    };
    for (const candidate of this.getReferenceCandidates(refInfo, context)) {
      acceptor(
        context,
        this.createReferenceCompletionItem(candidate, refInfo, context),
      );
    }
  }

  private variablesOffered(context: CompletionContext): boolean {
    if (atParenItemStart(context)) return conditionSlotOpen(context);
    const key = settingKeyAt(context);
    if (key !== undefined) {
      const owner = owningElement(context);
      return owner !== undefined && valueSlotReadsVariable(owner, key);
    }
    return (
      context.node !== undefined &&
      isVariableUse(referenceStandInAt(context.node))
    );
  }

  /** A declared name sorts ahead of a keyword, as a code or a host does. */
  private acceptVariables(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
  ): void {
    const process = AstUtils.getContainerOfType(context.node, isProcess);
    if (process === undefined) return;
    for (const { name, type } of this.variables.collect(process).values()) {
      acceptor(context, {
        label: name,
        kind: CompletionItemKind.Variable,
        detail: type,
        sortText: '0',
      });
    }
  }

  private acceptWords(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    words: readonly string[],
    detail: string,
  ): void {
    for (const word of words) {
      acceptor(context, {
        label: word,
        kind: CompletionItemKind.Keyword,
        detail,
        sortText: '1',
      });
    }
  }

  private acceptSnippet(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    item: StructureForm & { detail: string },
  ): void {
    acceptor(context, {
      ...item,
      kind: CompletionItemKind.Snippet,
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: '1',
    });
  }

  private literalWordOffered(
    context: CompletionContext,
    boolean: boolean,
  ): boolean {
    if (atParenItemStart(context)) {
      return boolean && conditionSlotOpen(context);
    }
    const key = settingKeyAt(context);
    return key === undefined || (boolean && BOOLEAN_SETTING_KEYS.has(key));
  }

  private acceptEventWords(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    words: readonly string[],
    detailOverrides?: Readonly<Record<string, string>>,
  ): void {
    for (const word of words) {
      const payload = TRIGGER_PAYLOAD_SNIPPETS[word];
      acceptor(context, {
        label: word,
        kind: payload ? CompletionItemKind.Snippet : CompletionItemKind.Keyword,
        detail:
          detailOverrides?.[word] ?? payload?.detail ?? 'BPMNscript event word',
        ...(payload && {
          insertText: payload.insertText,
          insertTextFormat: InsertTextFormat.Snippet,
        }),
        sortText: '1',
      });
    }
  }

  private static readonly DIRECTION_DETAILS: Readonly<Record<string, string>> =
    {
      input: 'a value handed to this step',
      output: 'a value this step hands back',
      [FIELD_DIRECTION]:
        'a value injected into the class, delegate, or built-in behaviour this step names',
      [PROPERTY_DIRECTION]:
        'a value Tasklist or a worker reads off the step, never a variable',
    };

  /**
   * A field or property value is quoted where an io parameter's is not: a
   * field lowers to a `stringValue` attribute or an expression child and a
   * property to a `value` attribute, and none takes a list, map or script.
   */
  private static readonly DIRECTION_VALUES: Readonly<Record<string, string>> = {
    [FIELD_DIRECTION]: '"${2:value}"',
    [PROPERTY_DIRECTION]: '"${2:value}"',
  };

  private acceptParameterDirections(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    directions: readonly string[],
  ): void {
    for (const direction of directions) {
      const value =
        BpmnScriptCompletionProvider.DIRECTION_VALUES[direction] ??
        '${2:value}';
      this.acceptSnippet(context, acceptor, {
        label: direction,
        detail: BpmnScriptCompletionProvider.DIRECTION_DETAILS[direction],
        insertText: `${direction} \${1:name} = ${value}`,
      });
    }
  }

  private acceptListenerEvents(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    owner: AstNode,
  ): void {
    const host = isListener(owner) ? owner.$container : owner;
    const rule = host && attributeBlockRuleOf(host);
    if (!rule) {
      return;
    }
    for (const event of listenerEventsFor(rule)) {
      // A listener's timer clause is written before its settings, so the two
      // tab stops swap places on `timeout`.
      const timer = event === 'timeout' ? ' after "${1:PT1H}"' : '';
      const binding = event === 'timeout' ? '${2:' : '${1:';
      this.acceptSnippet(context, acceptor, {
        label: event,
        detail: 'BPMNscript listener event',
        insertText: `${event}${timer}(class: "${binding}com.example.Listener}")`,
      });
    }
  }

  protected override completionForKeyword(
    context: CompletionContext,
    keyword: GrammarAST.Keyword,
    acceptor: CompletionAcceptor,
  ): void {
    if (keyword.value === 'on' && ruleNameOf(keyword) === Listener.$type) {
      this.acceptSnippet(context, acceptor, {
        label: 'on',
        detail: 'run code when this step reaches a lifecycle point',
        insertText:
          'on ${1|' +
          EXECUTION_LISTENER_EVENTS.join(',') +
          '|}(class: "${2:com.example.Listener}")',
      });
      return;
    }
    // The grammar admits a form block on every element with a member block;
    // the rule says which take one.
    if (keyword.value === 'form') {
      const owner = owningElement(context);
      if (owner && attributeBlockRuleOf(owner)?.forms) {
        void super.completionForKeyword(context, keyword, acceptor);
      }
      return;
    }
    const rule = ruleNameOf(keyword);
    // In a setting position a keyword is a key or a flag, and which of them the
    // element takes is answered from its vocabulary, so the grammar's raw
    // alternatives are dropped.
    if (rule === FLAG_WORD_RULE) {
      const owner = owningElement(context);
      if (
        owner &&
        !payloadOpen(owner, context) &&
        flagWordsFor(owner).includes(keyword.value)
      ) {
        this.acceptWords(context, acceptor, [keyword.value], FLAG_DETAIL);
      }
      return;
    }
    if (rule === SETTING_KEY_RULE) {
      return;
    }
    if (
      LITERAL_WORDS.has(keyword.value) &&
      !this.literalWordOffered(context, rule === BOOLEAN_LITERAL_RULE)
    ) {
      return;
    }
    const snippet = STRUCTURE_SNIPPETS[keyword.value];
    if (snippet === undefined) {
      void super.completionForKeyword(context, keyword, acceptor);
      return;
    }
    const forms =
      typeof snippet === 'string'
        ? [{ label: keyword.value, insertText: snippet }]
        : snippet;
    for (const form of forms) {
      this.acceptSnippet(context, acceptor, {
        ...form,
        detail: STRUCTURE_DETAILS[keyword.value] ?? 'BPMNscript construct',
      });
    }
  }
}
