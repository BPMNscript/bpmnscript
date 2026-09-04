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
import {
  attributeBlockRuleOf,
  CATCH_TRIGGERS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  ENGINE_KEYS,
  EVENT_BINDING_FIELDS,
  IO_DIRECTIONS,
  LISTENER_BINDING_KEYS,
  listenerEventsFor,
  ON_TRIGGERS,
  PROCESS_HEADER_KEYS,
  START_TRIGGERS,
  THROW_TRIGGERS,
  TIMER_PARTICLES,
} from './vocabulary.js';

/** One shape a structural keyword opens, with the label it is offered under. */
interface StructureForm {
  readonly label: string;
  readonly insertText: string;
}

/**
 * Snippet bodies for the structural keywords, keyed by keyword text. Accepting
 * one scaffolds the whole construct so the caret lands inside the body, where
 * the next completions are already offered. Placeholders are LSP snippet
 * syntax: `$1` tab stops, `$0` final caret, `${n:default}`, `${n|a,b|}`
 * choices. A keyword absent here falls through to the default bare-keyword
 * completion. A keyword opening more than one construct lists a form per
 * shape, each offered under its own label.
 */
const STRUCTURE_SNIPPETS: Readonly<
  Record<string, string | readonly StructureForm[]>
> = {
  process: 'process ${1:name} {\n\t$0\n}',
  var: 'var ${1:name}: ${2|string,number,boolean,date,json,any|}',
  label: 'label = "${1:label}"',
  start: 'start ${1:name}',
  end: 'end ${1:name}',
  user: 'user ${1:id} {\n\tassignee = "${2:user}"\n}',
  service: 'service ${1:id} {\n\tclass = "${2:com.example.Delegate}"\n}',
  step: 'step ${1:id}',
  send: 'send ${1:id} {\n\tclass = "${2:com.example.Delegate}"\n}',
  receive: 'receive ${1:id} {\n\tmessage = "${2:MessageName}"\n}',
  decide: 'decide ${1:id} {\n\tdecision = "${2:decision-key}"\n}',
  script:
    'script ${1:id} ```${2|javascript,groovy,python,ruby,feel|}\n\t$0\n```',
  if: 'if (${1:condition}) {\n\t$0\n}',
  while: 'while (${1:condition}) {\n\t$0\n}',
  do: 'do {\n\t$1\n} while (${2:condition})',
  parallel: 'parallel {\n\t{\n\t\t$1\n\t}\n\t{\n\t\t$2\n\t}\n}',
  subprocess: 'subprocess ${1:id} {\n\t$0\n}',
  attempt: 'attempt ${1:id} {\n\t$0\n}',
  // Only the triggers taking a plain `"CODE"` string appear in these choices:
  // `timer`, `condition`, and `compensation` read a different payload and are
  // offered at the bare ID position instead. The host is a cross-reference, so
  // no hosted variant is scaffolded.
  on: 'on ${1|error,escalation,message,signal|} "${2:CODE}" {\n\t$0\n}',
  throw: 'throw ${1|error,escalation,message,signal|} "${2:CODE}"',
  // `emit` has no continuing form for `error` (an error always ends its path).
  emit: 'emit ${1|escalation,message,signal|} "${2:CODE}"',
  // `await` never catches error/escalation/compensation; those are thrown.
  await: 'await ${1|message,signal|} "${2:CODE}"',
  call: 'call ${1:id} {\n\tprocess = "${2:process-id}"\n\tin ${3:input}\n\tout ${4:result}\n}',
  // Offered at the position after a statement's name, not as a setting.
  for: [
    { label: 'for each', insertText: 'for each ${1:item} in ${2:collection}' },
    { label: 'for', insertText: 'for ${1:3}' },
  ],
};

/**
 * Snippet bodies for the settings a brace block can hold. These lex as plain
 * identifiers, so the default completion offers nothing for them. The `\$`
 * escapes keep an EL `${...}` literal instead of opening a nested placeholder;
 * only the tab stop's own `${n: ... }` wrapper is live.
 */
const SETTING_SNIPPETS: Readonly<Record<string, string>> = {
  asyncBefore: 'asyncBefore = ${1|true,false|}',
  asyncAfter: 'asyncAfter = ${1|true,false|}',
  exclusive: 'exclusive = ${1|false,true|}',
  jobPriority: 'jobPriority = ${1:50}',
  retryCycle: 'retryCycle = "${1:R3/PT10M}"',
  assignee: 'assignee = "${1:user}"',
  formKey: 'formKey = "${1:form-key}"',
  candidateGroups: 'candidateGroups = "${1:group}"',
  candidateUsers: 'candidateUsers = "${1:user}"',
  dueDate: 'dueDate = "${1:\\${dateTime().plusDays(3)}}"',
  followUpDate: 'followUpDate = "${1:\\${dateTime().plusDays(1)}}"',
  priority: 'priority = ${1:50}',
  class: 'class = "${1:com.example.Delegate}"',
  expression: 'expression = "${1:\\${bean.method(execution)}}"',
  delegate: 'delegate = "${1:\\${beanName}}"',
  topic: 'topic = "${1:topic-name}"',
  decision: 'decision = "${1:decision-key}"',
  mapDecisionResult:
    'mapDecisionResult = ${1|singleEntry,singleResult,collectEntries,resultList|}',
  message: 'message = "${1:MessageName}"',
  resultVariable: 'resultVariable = "${1:result}"',
  process: 'process = "${1:process-id}"',
  binding: 'binding = ${1|latest,deployment|}',
  version: 'version = ${1:1}',
  businessKey: 'businessKey = "${1:\\${execution.processBusinessKey}}"',
  versionTag: 'versionTag = "${1:1.0.0}"',
};

function settingKeysFor(node: AstNode): readonly string[] | undefined {
  if (node.$type === 'Process') {
    return PROCESS_HEADER_KEYS;
  }
  if (node.$type === 'Listener') {
    return LISTENER_BINDING_KEYS;
  }
  const rule = attributeBlockRuleOf(node);
  return rule && [...rule.own, ...ENGINE_KEYS];
}

/**
 * The grammar rule `node` belongs to. Where one word is written by two rules,
 * the rule tells the constructs apart; the AST node cannot, because at a caret
 * following a finished construct it is that construct, not the enclosing one.
 */
function ruleNameOf(node: AstNode): string | undefined {
  return AstUtils.getContainerOfType(node, GrammarAST.isParserRule)?.name;
}

/** A `MapKey` in a parameter value assigns `key` too, and takes the author's own keys. */
const SETTING_KEY_RULE = 'AttrKey';

/**
 * The element whose settings block holds the caret. The node at the caret is
 * that element only while the block is empty; after a member is written it is
 * the preceding member's own leaf. A member already closed above the caret ends
 * before it and is passed over, while a block whose closing brace is not typed
 * yet encloses nothing, so there the innermost element stands in.
 */
function owningElement(context: CompletionContext): AstNode | undefined {
  let innermost: AstNode | undefined;
  for (
    let node: AstNode | undefined = context.node;
    node;
    node = node.$container
  ) {
    if (settingKeysFor(node) === undefined) {
      continue;
    }
    if ((node.$cstNode?.end ?? 0) > context.offset) {
      return node;
    }
    innermost ??= node;
  }
  return innermost;
}

/** Scaffolds for the trigger words reading something other than a plain `"CODE"`. */
const TRIGGER_PAYLOAD_SNIPPETS: Readonly<
  Record<string, { insertText: string; detail: string }>
> = {
  timer: {
    insertText: 'timer after "${1:PT1H}"',
    detail: 'a scheduled or relative deadline',
  },
  condition: { insertText: 'condition ($1)', detail: 'a data-change watchdog' },
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
 * Captions that replace the default `'BPMNscript construct'` one, keyed by
 * keyword text like {@link STRUCTURE_SNIPPETS}, so every form a keyword opens
 * carries the same one.
 */
const STRUCTURE_DETAILS: Readonly<Record<string, string>> = {
  call: 'call another process like a function',
  for: 'how often the preceding step runs',
};

/**
 * Snippet completions for the structural keywords and for the soft words the
 * grammar leaves as plain identifiers. Every other completion keeps Langium's
 * default behavior.
 */
export class BpmnScriptCompletionProvider extends DefaultCompletionProvider {
  /**
   * Offers items for the soft words at the `trigger`, `particle`, `field`,
   * `key`, `direction`, and `event` positions. They lex as plain `ID`s, so the
   * default completion offers nothing there.
   *
   * `OnHandler.host` is absent because it is a real cross-reference: the
   * inherited `completionForCrossReference` already offers it, narrowed by
   * `BpmnScriptScopeProvider`.
   */
  protected override completionFor(
    context: CompletionContext,
    next: NextFeature,
    acceptor: CompletionAcceptor,
  ): MaybePromise<void> {
    const nodeType = context.node?.$type;
    const owner = owningElement(context);
    if (
      next.property === 'key' &&
      ruleNameOf(next.feature) === SETTING_KEY_RULE &&
      owner
    ) {
      const keys = settingKeysFor(owner);
      if (keys) {
        this.acceptSettingSnippets(context, acceptor, keys);
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
    if (
      next.property === 'particle' &&
      (nodeType === 'OnHandler' ||
        nodeType === 'IntermediateCatchEvent' ||
        nodeType === 'StartEvent')
    ) {
      this.acceptParticleWords(context, acceptor);
      return;
    }
    if (
      next.property === 'field' &&
      (nodeType === 'OnHandler' || nodeType === 'EventBinding')
    ) {
      this.acceptEventWords(context, acceptor, EVENT_BINDING_FIELDS);
      return;
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

  private static readonly PARTICLE_DETAILS: Readonly<Record<string, string>> = {
    after: 'a duration relative to when this scope starts',
    at: 'a fixed point in time',
    every: 'a repeating schedule',
  };

  private acceptParticleWords(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
  ): void {
    for (const word of TIMER_PARTICLES) {
      acceptor(context, {
        label: word,
        kind: CompletionItemKind.Keyword,
        detail: BpmnScriptCompletionProvider.PARTICLE_DETAILS[word],
        sortText: '1',
      });
    }
  }

  private acceptSettingSnippets(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    keys: readonly string[],
  ): void {
    for (const key of keys) {
      acceptor(context, {
        label: key,
        kind: CompletionItemKind.Snippet,
        detail: 'BPMNscript setting',
        insertText: SETTING_SNIPPETS[key],
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

  /** Each event scaffolds its binding block and, for `timeout`, the timer clause. */
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
      const timer = event === 'timeout' ? ' after "${1:PT1H}"' : '';
      const binding = event === 'timeout' ? '${2:' : '${1:';
      acceptor(context, {
        label: event,
        kind: CompletionItemKind.Snippet,
        detail: 'BPMNscript listener event',
        insertText: `${event}${timer} {\n\tclass = "${binding}com.example.Listener}"\n}`,
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
          'on ${1|start,end|} {\n\tclass = "${2:com.example.Listener}"\n}',
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: '1',
      });
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
