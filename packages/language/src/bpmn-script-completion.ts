import type { GrammarAST, MaybePromise } from 'langium';
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

/**
 * Snippet bodies for the structural keywords, keyed by keyword text. Accepting
 * one scaffolds the whole construct — braces, parentheses, and tab stops —
 * instead of inserting the bare word, so the caret lands inside the body where
 * the next statement/attribute completions are already offered.
 *
 * Placeholders use LSP snippet syntax: `$1`/`$2` tab stops, `$0` final caret,
 * `${n:default}` defaults, `${n|a,b|}` choices. Indentation uses tabs; the
 * editor reindents to the file's settings on insert.
 *
 * Keywords absent here — operators, the `VarType` literals, `else`, and `goto`
 * (whose target is a cross-reference the linker completes) — fall through to
 * the default bare-keyword completion.
 */
const STRUCTURE_SNIPPETS: Readonly<Record<string, string>> = {
  // process scope
  process: 'process ${1:name} {\n\t$0\n}',
  var: 'var ${1:name}: ${2|string,number,boolean,date,json,any|}',
  label: 'label = "${1:label}"',
  // events
  start: 'start ${1:name}',
  end: 'end ${1:name}',
  // tasks
  user: 'user ${1:id} {\n\tassignee = "${2:user}"\n}',
  service: 'service ${1:id} {\n\tclass = "${2:com.example.Delegate}"\n}',
  external: 'external ${1:id} {\n\ttopic = "${2:topic}"\n}',
  script:
    'script ${1:id} ```${2|javascript,groovy,python,ruby,feel|}\n\t$0\n```',
  // task attributes
  assignee: 'assignee = "${1:user}"',
  formKey: 'formKey = "${1:form-key}"',
  class: 'class = "${1:com.example.Delegate}"',
  // the `\$` escapes keep the EL `${…}` literal instead of starting a nested
  // snippet placeholder — only the tab stop's own `${1: … }` wrapper is live.
  expression: 'expression = "${1:\\${bean.method(execution)}}"',
  delegate: 'delegate = "${1:\\${beanName}}"',
  topic: 'topic = "${1:topic-name}"',
  // control flow
  if: 'if (${1:condition}) {\n\t$0\n}',
  while: 'while (${1:condition}) {\n\t$0\n}',
  do: 'do {\n\t$1\n} while (${2:condition})',
  parallel: 'parallel {\n\t{\n\t\t$1\n\t}\n\t{\n\t\t$2\n\t}\n}',
  subprocess: 'subprocess ${1:id} {\n\t$0\n}',
  // event handlers / throw / emit — the DSL's try/catch. The trigger words
  // are soft (plain identifiers, not keywords — see bpmn-script-validator.ts),
  // so they are offered here as snippet choice placeholders and, at the bare
  // ID position, through the ID-position completion override below. Only the
  // four triggers that take a plain `"CODE"` string appear in this choice —
  // `timer` and `condition` read a differently-shaped payload and get their
  // own scaffolding items at the ID position instead.
  on: 'on ${1|error,escalation,message,signal|} "${2:CODE}" {\n\t$0\n}',
  throw: 'throw ${1|error,escalation,signal|} "${2:CODE}"',
  // `emit` has no continuing form for `error` (an error always ends its
  // path), so `error` is absent from this choice.
  emit: 'emit ${1|escalation,signal|} "${2:CODE}"',
  // call — starts another process like a function call: `process` names the
  // callee, `in` entries are its arguments, `out` entries are its return
  // values.
  call: 'call ${1:id} {\n\tprocess = "${2:process-id}"\n\tin ${3:input}\n\tout ${4:result}\n}',
  // call attributes
  binding: 'binding = ${1|latest,deployment|}',
  version: 'version = ${1:1}',
  // the `\$` escape keeps the EL `${…}` literal, same as `expression`/`delegate` above.
  businessKey: 'businessKey = "${1:\\${execution.processBusinessKey}}"',
};

/**
 * Per-keyword completion-item `detail` text, overriding the default
 * `'BPMNscript construct'` caption for keywords where a more specific
 * description helps (currently just `call`, whose analogy to a function call
 * is the whole point of the construct). Every other structural keyword keeps
 * the default detail.
 */
const STRUCTURE_DETAILS: Readonly<Record<string, string>> = {
  call: 'call another process like a function',
};

/**
 * Offers snippet completions for the BPMNscript structural keywords so the
 * editor scaffolds a full construct (with its brackets) on accept. Every other
 * completion — non-structural keywords, cross-references, expressions — keeps
 * Langium's default behaviour.
 */
export class BpmnScriptCompletionProvider extends DefaultCompletionProvider {
  /**
   * Offers items for the soft event words: the `trigger` property of
   * `on`/`throw`/`emit` offers each construct's legal trigger words (`on`
   * offers all six — `timer` and `condition` as snippet items that also
   * scaffold their differently-shaped payload, since neither reads a plain
   * `"CODE"` string), the `particle` property of an `on timer` handler
   * offers the three timer particles with a one-line description each, and
   * `code`/`message` complete the `field` property of a handler binding.
   * These words lex as plain `ID`s (not grammar keywords — see
   * `bpmn-script-validator.ts`), so the default completion offers nothing at
   * these positions; every other position keeps the inherited behaviour.
   */
  protected override completionFor(
    context: CompletionContext,
    next: NextFeature,
    acceptor: CompletionAcceptor,
  ): MaybePromise<void> {
    const containerType = context.node?.$type;
    if (next.property === 'trigger') {
      if (containerType === 'EmitStatement') {
        this.acceptEventWord(context, acceptor, ['escalation', 'signal']);
        return;
      }
      if (containerType === 'ThrowStatement') {
        this.acceptEventWord(context, acceptor, [
          'error',
          'escalation',
          'signal',
        ]);
        return;
      }
      if (containerType === 'OnHandler') {
        this.acceptEventWord(context, acceptor, [
          'error',
          'escalation',
          'message',
          'signal',
        ]);
        this.acceptEventSnippet(
          context,
          acceptor,
          'timer',
          'timer after "${1:PT1H}"',
          'a scheduled or relative deadline',
        );
        this.acceptEventSnippet(
          context,
          acceptor,
          'condition',
          'condition ($1)',
          'a data-change watchdog',
        );
        return;
      }
    }
    if (next.property === 'particle' && containerType === 'OnHandler') {
      this.acceptParticleWords(context, acceptor);
      return;
    }
    if (
      next.property === 'field' &&
      (containerType === 'OnHandler' || containerType === 'EventBinding')
    ) {
      this.acceptEventWord(context, acceptor, ['code', 'message']);
      return;
    }
    return super.completionFor(context, next, acceptor);
  }

  /** Emit one plain keyword-kind completion item per word in `words`. */
  private acceptEventWord(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    words: readonly string[],
  ): void {
    for (const word of words) {
      acceptor(context, {
        label: word,
        kind: CompletionItemKind.Keyword,
        detail: 'BPMNscript event word',
        sortText: '1',
      });
    }
  }

  /**
   * Emit one snippet-kind completion item at a trigger position, for a
   * trigger word whose payload does not fit the plain `"CODE"` string
   * choice (`timer`, `condition`) — accepting it inserts the trigger word
   * together with a scaffold for its own payload shape.
   */
  private acceptEventSnippet(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    label: string,
    insertText: string,
    detail: string,
  ): void {
    acceptor(context, {
      label,
      kind: CompletionItemKind.Snippet,
      detail,
      insertText,
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: '1',
    });
  }

  /** The one-line description offered for each timer particle word. */
  private static readonly PARTICLE_DETAILS: Readonly<Record<string, string>> = {
    after: 'a duration relative to when this scope starts',
    at: 'a fixed point in time',
    every: 'a repeating schedule',
  };

  /** Emit one keyword-kind completion item per timer particle, each with its own `detail`. */
  private acceptParticleWords(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
  ): void {
    for (const [word, detail] of Object.entries(
      BpmnScriptCompletionProvider.PARTICLE_DETAILS,
    )) {
      acceptor(context, {
        label: word,
        kind: CompletionItemKind.Keyword,
        detail,
        sortText: '1',
      });
    }
  }

  protected override completionForKeyword(
    context: CompletionContext,
    keyword: GrammarAST.Keyword,
    acceptor: CompletionAcceptor,
  ): void {
    const snippet = STRUCTURE_SNIPPETS[keyword.value];
    if (snippet === undefined) {
      void super.completionForKeyword(context, keyword, acceptor);
      return;
    }
    // Respect the same word-like filtering the default applies to keywords.
    if (!this.filterKeyword(context, keyword)) {
      return;
    }
    acceptor(context, {
      label: keyword.value,
      kind: CompletionItemKind.Snippet,
      detail: STRUCTURE_DETAILS[keyword.value] ?? 'BPMNscript construct',
      insertText: snippet,
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: '1',
    });
  }
}
