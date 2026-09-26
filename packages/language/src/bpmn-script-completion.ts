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
  type Block,
  type OnHandler,
  type ParenItem,
  type VarRef,
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

/**
 * The words of `triggers` whose payload is a declared name, as a snippet choice
 * list. Their scaffold writes the name bare, so it reads as the cross-reference
 * it is.
 */
const declaredCodeChoices = (triggers: readonly string[]): string =>
  triggers.filter((word) => DECLARED_CODE_TRIGGERS.has(word)).join(',');

/**
 * The words whose payload is the name the engine keys a subscription by. It
 * declares nothing, so the scaffold quotes it.
 */
const subscriptionChoices = (triggers: readonly string[]): string =>
  triggers
    .filter((word) => namesACode(word) && !DECLARED_CODE_TRIGGERS.has(word))
    .join(',');

/**
 * Snippet bodies for the structural keywords, keyed by keyword text. Accepting
 * one scaffolds the whole construct so the caret lands inside the body, where
 * the next completions are already offered. Placeholders are LSP snippet
 * syntax: `$1` tab stops, `$0` final caret, `${n:default}`, `${n|a,b|}`
 * choices. A keyword absent here keeps the default bare-keyword completion, and
 * one opening several constructs lists a form per shape.
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
  // Each event word takes one of two payloads, so each keyword lists a form per
  // payload: a code names a declaration in the process header, a subscription
  // carries its own quoted name. A trigger reading a timer or a condition
  // instead is offered at the bare ID position. The host is a cross-reference,
  // so no hosted variant is scaffolded.
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
  // The second form waits on several triggers at once and continues down the
  // one that fires first.
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
  // Offered at the position after a statement's name, not as a setting.
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

/** @param keys The engine keys to spell through `keyOf`; a carrier may take fewer than all. */
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
 * Snippet bodies for the settings an element's parens can hold. These lex as
 * plain identifiers, so the default completion offers nothing for them. The
 * `\$` escapes keep an EL `${...}` literal instead of opening a nested
 * placeholder.
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
  // A form field's parens. The two flags are on while written, so neither
  // scaffolds a choice.
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
 * A handler binds what the event it caught carries to variables of its own, so
 * the value is a name the handler introduces rather than one it looks up. The
 * same word means something else as a setting: `message` on a receive task
 * names the subscription the engine waits on.
 */
const CATCH_BINDING_SNIPPETS: Readonly<Record<string, string>> = {
  code: 'code: ${1:code}',
  message: 'message: ${1:message}',
};

/**
 * A declaration's fields hold the text the event is made of, so both are
 * quoted where a handler's binding of the same name is a bare variable.
 */
const DECLARATION_FIELD_SNIPPETS: Readonly<Record<string, string>> = {
  code: 'code: "${1:code}"',
  message: 'message: "${1:message}"',
};

const settingForms = (
  keys: readonly string[],
  snippets: Readonly<Record<string, string>> = SETTING_SNIPPETS,
): StructureForm[] =>
  keys.map((key) => ({ label: key, insertText: snippets[key] }));

/** The words a setting's value slot offers, keyed by the setting; a quoted choice inserts its quotes. */
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
const BOOLEAN_LITERAL_RULE = 'LiteralBool';

/**
 * The keys naming a timer's date and cycle. A duration is the bare payload the
 * trigger word's own snippet already scaffolds, so it is not offered again.
 */
const TIMER_KEY_SNIPPETS: Readonly<Record<string, string>> = {
  [TIMER_PARTICLE_BY_KIND.date]: `${TIMER_PARTICLE_BY_KIND.date}: "\${1:2026-08-01T09:00:00}"`,
  [TIMER_PARTICLE_BY_KIND.cycle]: `${TIMER_PARTICLE_BY_KIND.cycle}: "\${1:R/PT10M}"`,
};

/** The keys a timer trigger takes, wherever one is written. */
function timerKeyForms(node: AstNode): StructureForm[] {
  if (triggerWordOf(node) !== 'timer') return [];
  return Object.entries(TIMER_KEY_SNIPPETS).map(([label, insertText]) => ({
    label,
    insertText,
  }));
}

/** The bindings a handler catching an error or an escalation takes. */
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

/** The items written in `owner`'s parens; a kind without parens has none. */
const itemsOf = (owner: AstNode): ParenItem[] =>
  (owner as { items?: ParenItem[] }).items ?? [];

/**
 * Whether the unkeyed slot of `owner`'s parens has to be filled before a
 * setting is legal there: a subscription name, a timer clause, a condition,
 * and the code a throw or emit names, which is required even where a handler
 * may catch every code.
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
 * Whether the unkeyed slot is written before the caret's token, bare or as a
 * timer's keyed clause. A word still being typed there is that slot, not
 * something after it.
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

/**
 * Whether the caret opens the condition an event's parens take, the one item
 * start an expression belongs at.
 */
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
 * The bare words `node`'s parens take. The one flag any rule lists is the
 * handler's `alongside`, so the list is offered whole where the trigger's
 * rule lets a handler run alongside its host.
 */
function flagWordsFor(node: AstNode): readonly string[] {
  const trigger = triggerWordOf(node);
  return trigger !== undefined && TRIGGER_PAYLOAD[trigger]?.alongside
    ? (attributeBlockRuleOf(node)?.flags ?? [])
    : [];
}

/**
 * The settings the parens of `node` take, in the order they are offered, or
 * `undefined` where `node` has no parens of its own. The keys come from the
 * element's own row, so a kind that takes no label is offered none; a listener
 * carries a list of its own, being a callback on the element rather than one
 * of its settings. The `run` keys are offered only with a `for` clause, which
 * the validator requires for them.
 */
function settingFormsFor(node: AstNode): StructureForm[] | undefined {
  if (node.$type === 'Process') {
    return settingForms(PROCESS_HEADER_KEYS);
  }
  if (node.$type === 'Listener') {
    return settingForms(LISTENER_BINDING_KEYS);
  }
  if (node.$type === 'FormField') {
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
  // A throw or emit owns the implementation bindings, which only a thrown
  // message carries.
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

/**
 * Whether the parens name a binding the engine injects a field into. A
 * listener's fenced script binds it in place of its settings and takes none.
 */
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
 * The directions a member of `owner`'s block is written with. A listener's
 * block holds injected fields alone, for the reason
 * `BpmnScriptValidator.checkListenerFields` states, and a form field's holds
 * properties alone, so neither has a row to read. A field and a property each
 * ride one binding, so they are offered once that binding is written.
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
 * Whether the caret sits in `owner`'s body rather than in its member block.
 * The two open with the same brace and the parser reads the first as the body,
 * so a member offered there would land in the body, where it belongs to
 * nothing.
 */
const inBodyOf = (owner: AstNode, context: CompletionContext): boolean =>
  AstUtils.getContainerOfType(context.node, isBlock)?.$container === owner;

/**
 * Whether a bare name at the value slot of `key` on `owner` reads a variable.
 * The validator's own predicate cannot be asked: with nothing typed after the
 * colon the recovered tree holds the key as a bare value and no setting node.
 * A text key takes its value as written, a boolean its two words, a form
 * field's constraints a number, a timer clause a time, a catch binding a name
 * it declares, and a declaration's fields text.
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

/** The stand-in for a reference not yet typed, held by the caret's node as the default builds it. */
const referenceStandInAt = (node: AstNode): VarRef => ({
  $type: 'VarRef',
  $container: node as VarRef['$container'],
  $containerProperty: 'ref',
  ref: { $refText: '', ref: undefined },
  accessors: [],
});

/**
 * The word written before the token at the caret. A mapping with nothing after
 * its head word does not parse and leaves no node, so the head is read off the
 * text.
 */
const wordBefore = (context: CompletionContext): string | undefined =>
  /(\w+)\s*$/.exec(
    context.textDocument.getText().slice(0, context.tokenOffset),
  )?.[1];

/** Whether both braces are written: a brace the recovery inserted leaves no leaf. */
function closesWithBrace(cst: CstNode): boolean {
  const last = isCompositeCstNode(cst) ? cst.content.at(-1) : undefined;
  return last !== undefined && isLeafCstNode(last) && last.text === '}';
}

/**
 * The blocks whose braces hold the caret, outermost first, read off the CST
 * rather than off the caret's node: a handler with its trigger still unwritten
 * does not parse, and the recovery closes the body before it and hangs the
 * handler on the process, so its containers say nothing about where it was
 * typed. A block the recovery closed stays open to a caret past its end.
 */
function openBlocksAt(context: CompletionContext): Block[] {
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
    .toArray();
}

/**
 * The words a handler at the caret catches. Host-less it is an event
 * sub-process, and an undo block belongs directly in the subprocess whose work
 * it undoes; hosted it is a boundary event, which Operaton attaches as a
 * cancel to an attempt block alone and as an escalation to the hosts
 * `isEscalationLegalHost` names. An unresolved host keeps the whole list.
 */
function handlerTriggerWords(
  handler: OnHandler,
  words: readonly string[],
  context: CompletionContext,
): readonly string[] {
  if (handler.host === undefined) {
    const inSubProcess = isSubProcess(openBlocksAt(context).at(-1)?.$container);
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
 * The grammar rule `node` belongs to. Where one word is written by two rules
 * the rule tells them apart and the AST node cannot, because at a caret after a
 * finished construct the node is that construct, not the enclosing one.
 */
function ruleNameOf(node: AstNode): string | undefined {
  return AstUtils.getContainerOfType(node, GrammarAST.isParserRule)?.name;
}

/** A `MapKey` in a parameter value assigns `key` too, and takes the author's own keys. */
const SETTING_KEY_RULE = 'ParenKey';

/** The rule of the bare words an element's parens take. */
const FLAG_WORD_RULE = 'FlagWord';

/** Whether the caret opens a new item in an element's parens, where a key may start. */
const atParenItemStart = (context: CompletionContext): boolean =>
  context.features.some(
    (next) => ruleNameOf(next.feature) === SETTING_KEY_RULE,
  );

/**
 * The key whose value slot holds the caret, `key: |` or `key: pre|`, or
 * `undefined` anywhere else. With nothing typed after the colon the parser
 * recovers the key as a bare unkeyed value and drops the colon, so that shape
 * is told by the colon still standing between the word and the caret.
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
 * The element whose settings hold the caret. The node at the caret is that
 * element only while the parens are empty; afterwards it is the preceding
 * item's leaf. An item already closed above the caret is passed over, and
 * parens whose closing token is not typed yet enclose nothing, so there the
 * innermost element stands in.
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

/**
 * Scaffolds for the trigger words whose payload is neither a name nor a code.
 * A timer reads a bare duration, which is the common case; a fixed date or a
 * repeating cycle is written as an `at` or `every` setting instead.
 */
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

/** The trigger words each statement takes, with the captions a word earns. */
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

/**
 * The header declarations opening with a soft word, which no keyword path
 * offers. Each names its code; only an error carries a message.
 */
const CODE_DECLARATION_FORMS: readonly (StructureForm & { detail: string })[] =
  [...DECLARED_CODE_TRIGGERS].map((kind) => ({
    label: kind,
    detail: `declare an ${kind} code`,
    insertText:
      `${kind} \${1:NAME}` +
      (TRIGGER_PAYLOAD[kind]?.message ? '(message: "${2:message}")' : ''),
  }));

/** Captions replacing the default one, keyed as {@link STRUCTURE_SNIPPETS} is. */
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

  /**
   * Offers items for the soft words at the `trigger`, `particle`, `key`,
   * `direction`, `event` and `kind` positions, which lex as plain `ID`s.
   * `OnHandler.host` is absent because it is a real cross-reference, already
   * offered by the inherited `completionForCrossReference`.
   */
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
        : settingFormsFor(owner);
      if (forms) {
        this.acceptSettingSnippets(context, acceptor, forms);
        return;
      }
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
    if (next.property === 'kind' && next.type === 'CodeDecl') {
      for (const form of CODE_DECLARATION_FORMS) {
        acceptor(context, {
          label: form.label,
          kind: CompletionItemKind.Snippet,
          detail: form.detail,
          insertText: form.insertText,
          insertTextFormat: InsertTextFormat.Snippet,
          sortText: '1',
        });
      }
      return;
    }
    // A mapping is offered where its binding takes one; elsewhere the block
    // position offers nothing for it, so a user task is never handed one.
    if (next.property === 'trigger' && next.type === 'ErrorMapping') {
      if (owner && mappingOffered(owner)) {
        acceptor(context, {
          label: ERROR_MAPPING_HEAD,
          kind: CompletionItemKind.Snippet,
          detail: 'raise a declared error when a reported failure matches',
          insertText: `${ERROR_MAPPING_HEAD} \${1:CODE} ${ERROR_MAPPING_WHEN} \${2:condition}`,
          insertTextFormat: InsertTextFormat.Snippet,
          sortText: '1',
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
   * A host resolves against every named statement, so the validator can say
   * why a start or a throw cannot carry a boundary event; the offer stops at
   * the activities that can. The recovery of a trigger-less handler hangs it
   * on the process, so the scope is read for a stand-in placed in the
   * innermost block still open at the caret, where the handler was typed.
   * With a body still open, `on Ins` parses as a complete `Listener`, not an
   * `OnHandler`, so the guard keys on the property alone: only `OnHandler`
   * has `host`.
   */
  protected override getReferenceCandidates(
    refInfo: ReferenceInfo,
    context: CompletionContext,
  ): Stream<AstNodeDescription> {
    if (refInfo.property !== 'host') {
      return super.getReferenceCandidates(refInfo, context);
    }
    const block = openBlocksAt(context).at(-1);
    const placed: ReferenceInfo = {
      ...refInfo,
      container: {
        $type: 'OnHandler',
        $container: block ?? refInfo.container.$container,
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
    if (next.type === 'ErrorMapping' && next.property === 'code') {
      // context.node is the caret's leaf, which after any preceding member
      // is that member, not the block's owner; climb to the nearest node
      // with an attribute-block rule (the element the mapping belongs to).
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
      next.type === 'VarRef' &&
      next.property === 'ref' &&
      this.variablesOffered(context)
    ) {
      this.acceptVariables(context, acceptor);
      return;
    }
    return super.completionForCrossReference(context, next, acceptor);
  }

  /**
   * The stand-in the default builds for the code slot carries no trigger word,
   * and with nothing after the head word no parsed mapping holds it either, so
   * the scope would read no code kind. The parser reaches the slot only after
   * the head word, so the stand-in is given it.
   */
  private acceptMappingCodes(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
  ): void {
    const standIn: AstNode & { trigger: string } = {
      $type: 'ErrorMapping',
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

  /**
   * Whether a bare name at the caret reads a variable. In an element's parens
   * only an open condition slot does; at a setting's value the key decides;
   * elsewhere the validator's predicate answers on the stand-in for the
   * reference, whose containers are the caret's.
   */
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

  /**
   * Every variable the process knows, in the order the table seeds them. A
   * declared name sorts ahead of a keyword, as a code or a host does.
   */
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

  /** A plain keyword item per word. */
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

  /**
   * Whether a literal word belongs at the caret. In an element's parens it is
   * a payload, which an open condition slot alone takes and only as a boolean;
   * at a setting's value it fits a boolean key alone; an expression position
   * takes it as any operand.
   */
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

  /** A plain keyword item per word, or a snippet where the word carries a payload. */
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

  private acceptSettingSnippets(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    forms: readonly StructureForm[],
  ): void {
    for (const form of forms) {
      acceptor(context, {
        label: form.label,
        kind: CompletionItemKind.Snippet,
        detail: 'BPMNscript setting',
        insertText: form.insertText,
        insertTextFormat: InsertTextFormat.Snippet,
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
   * A field's value is quoted where an io parameter's is not: it lowers to a
   * `stringValue` attribute or to an expression child, and neither takes a
   * list, a map, or an inline script. A property's is the same text in a
   * `value` attribute.
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
      acceptor(context, {
        label: direction,
        kind: CompletionItemKind.Snippet,
        detail: BpmnScriptCompletionProvider.DIRECTION_DETAILS[direction],
        insertText: `${direction} \${1:name} = ${value}`,
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: '1',
      });
    }
  }

  /** Each event scaffolds its binding and, for `timeout`, the timer clause. */
  private acceptListenerEvents(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    owner: AstNode,
  ): void {
    const host = owner.$type === 'Listener' ? owner.$container : owner;
    const rule = host && attributeBlockRuleOf(host);
    if (!rule) {
      return;
    }
    for (const event of listenerEventsFor(rule)) {
      // A listener's timer clause is written before its settings, so the two
      // tab stops swap places on `timeout`.
      const timer = event === 'timeout' ? ' after "${1:PT1H}"' : '';
      const binding = event === 'timeout' ? '${2:' : '${1:';
      acceptor(context, {
        label: event,
        kind: CompletionItemKind.Snippet,
        detail: 'BPMNscript listener event',
        insertText: `${event}${timer}(class: "${binding}com.example.Listener}")`,
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: '1',
      });
    }
  }

  protected override completionForKeyword(
    context: CompletionContext,
    keyword: GrammarAST.Keyword,
    acceptor: CompletionAcceptor,
  ): void {
    if (keyword.value === 'on' && ruleNameOf(keyword) === 'Listener') {
      acceptor(context, {
        label: 'on',
        kind: CompletionItemKind.Snippet,
        detail: 'run code when this step reaches a lifecycle point',
        insertText:
          'on ${1|' +
          EXECUTION_LISTENER_EVENTS.join(',') +
          '|}(class: "${2:com.example.Listener}")',
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: '1',
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
    // A keyword in a setting position names a key or a flag, never the start of
    // a construct. Which of them belongs to the element is answered from its own
    // vocabulary, so the grammar's raw alternatives are dropped here.
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
    // Respect the same word-like filtering the default applies to keywords.
    if (!this.filterKeyword(context, keyword)) {
      return;
    }
    const forms =
      typeof snippet === 'string'
        ? [{ label: keyword.value, insertText: snippet }]
        : snippet;
    for (const form of forms) {
      acceptor(context, {
        label: form.label,
        kind: CompletionItemKind.Snippet,
        detail: STRUCTURE_DETAILS[keyword.value] ?? 'BPMNscript construct',
        insertText: form.insertText,
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: '1',
      });
    }
  }
}
