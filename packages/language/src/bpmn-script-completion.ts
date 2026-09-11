import { AstUtils, GrammarAST, type AstNode, type MaybePromise } from 'langium';
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
import { isOnHandler } from './generated/ast.js';
import {
  attributeBlockRuleOf,
  CALL_BINDING_VALUES,
  CATCH_TRIGGERS,
  DECLARED_CODE_TRIGGERS,
  DECISION_RESULT_MAPPINGS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  ENGINE_KEYS,
  EVENT_BINDING_FIELDS,
  EXECUTION_LISTENER_EVENTS,
  IO_DIRECTIONS,
  LISTENER_BINDING_KEYS,
  listenerEventsFor,
  namesACode,
  ON_TRIGGERS,
  PROCESS_HEADER_KEYS,
  SCRIPT_FORMAT_ALIASES,
  START_TRIGGERS,
  THROW_TRIGGERS,
  TIMER_PARTICLE_BY_KIND,
  TRIGGER_PAYLOAD,
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
        subscriptionChoices(CATCH_TRIGGERS) +
        '|}("${2:NAME}") {\n\t\t$3\n\t}\n\t${4|' +
        subscriptionChoices(CATCH_TRIGGERS) +
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

/**
 * Snippet bodies for the settings an element's parens can hold. These lex as
 * plain identifiers, so the default completion offers nothing for them. The
 * `\$` escapes keep an EL `${...}` literal instead of opening a nested
 * placeholder.
 */
const SETTING_SNIPPETS: Readonly<Record<string, string>> = {
  label: 'label: "${1:label}"',
  documentation: 'documentation: "${1:documentation}"',
  asyncBefore: 'asyncBefore: ${1|true,false|}',
  asyncAfter: 'asyncAfter: ${1|true,false|}',
  exclusive: 'exclusive: ${1|false,true|}',
  jobPriority: 'jobPriority: ${1:50}',
  retryCycle: 'retryCycle: "${1:R3/PT10M}"',
  assignee: 'assignee: "${1:user}"',
  formKey: 'formKey: "${1:form-key}"',
  candidateGroups: 'candidateGroups: "${1:group}"',
  candidateUsers: 'candidateUsers: "${1:user}"',
  dueDate: 'dueDate: "${1:\\${dateTime().plusDays(3)}}"',
  followUpDate: 'followUpDate: "${1:\\${dateTime().plusDays(1)}}"',
  priority: 'priority: ${1:50}',
  class: 'class: "${1:com.example.Delegate}"',
  expression: 'expression: "${1:\\${bean.method(execution)}}"',
  delegate: 'delegate: "${1:\\${beanName}}"',
  topic: 'topic: "${1:topic-name}"',
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

const settingForms = (keys: readonly string[]): StructureForm[] =>
  keys.map((key) => ({ label: key, insertText: SETTING_SNIPPETS[key] }));

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
  if (!('trigger' in node) || node.trigger !== 'timer') return [];
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
  return EVENT_BINDING_FIELDS.map((field) => ({
    label: field,
    insertText: CATCH_BINDING_SNIPPETS[field],
  }));
}

/**
 * The settings the parens of `node` take, in the order they are offered, or
 * `undefined` where `node` is not an element. The keys come from the element's
 * own row, so a kind that takes no label is offered none; a listener carries a
 * list of its own, being a callback on the element rather than one of its
 * settings.
 */
function settingFormsFor(node: AstNode): StructureForm[] | undefined {
  if (node.$type === 'Process') {
    return settingForms(PROCESS_HEADER_KEYS);
  }
  if (node.$type === 'Listener') {
    return settingForms(LISTENER_BINDING_KEYS);
  }
  const rule = attributeBlockRuleOf(node);
  return (
    rule && [
      ...timerKeyForms(node),
      ...catchBindingForms(node),
      ...settingForms([...rule.own, ...ENGINE_KEYS]),
    ]
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

/** The rules whose keywords are a setting key or a flag, never a construct. */
const SETTING_WORD_RULES = [SETTING_KEY_RULE, 'FlagWord'];

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
    },
  },
  IntermediateCatchEvent: { words: CATCH_TRIGGERS },
  RaceBranch: { words: CATCH_TRIGGERS },
  StartEvent: { words: START_TRIGGERS },
  EndEvent: {
    words: END_TRIGGERS,
    details: {
      terminate: 'stop every running path in this scope',
      cancel: 'give up the surrounding attempt block',
    },
  },
};

/** Captions replacing the default one, keyed as {@link STRUCTURE_SNIPPETS} is. */
const STRUCTURE_DETAILS: Readonly<Record<string, string>> = {
  call: 'call another process like a function',
  for: 'how often the preceding step runs',
};

/**
 * Snippet completions for the structural keywords and for the soft words the
 * grammar leaves as plain identifiers; everything else keeps Langium's default.
 */
export class BpmnScriptCompletionProvider extends DefaultCompletionProvider {
  /**
   * Offers items for the soft words at the `trigger`, `particle`, `key`,
   * `direction`, and `event` positions, which lex as plain `ID`s.
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
      const forms = settingFormsFor(owner);
      if (forms) {
        this.acceptSettingSnippets(context, acceptor, forms);
        return;
      }
    }
    if (
      next.property === 'direction' &&
      !GrammarAST.isKeyword(next.feature) &&
      owner &&
      attributeBlockRuleOf(owner)?.parameters
    ) {
      this.acceptParameterDirections(context, acceptor);
      return;
    }
    if (next.property === 'event' && owner) {
      this.acceptListenerEvents(context, acceptor, owner);
      return;
    }
    if (next.property === 'trigger' && nodeType) {
      const triggers = STATEMENT_TRIGGERS[nodeType];
      if (triggers) {
        this.acceptEventWords(
          context,
          acceptor,
          triggers.words,
          triggers.details,
        );
        return;
      }
    }
    return super.completionFor(context, next, acceptor);
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
    };

  private acceptParameterDirections(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
  ): void {
    for (const direction of IO_DIRECTIONS) {
      const detail = BpmnScriptCompletionProvider.DIRECTION_DETAILS[direction];
      acceptor(context, {
        label: direction,
        kind: CompletionItemKind.Snippet,
        detail,
        insertText: `${direction} \${1:name} = \${2:value}`,
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
    // A keyword in a setting position names a key or a flag, never the start of
    // a construct. Which of them belongs to the element is answered from its own
    // vocabulary above, so the grammar's raw alternatives are dropped here.
    if (SETTING_WORD_RULES.includes(ruleNameOf(keyword) ?? '')) {
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
