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
 * one scaffolds the whole construct (braces, parentheses, and tab stops)
 * instead of inserting the bare word, so the caret lands inside the body where
 * the next statement/attribute completions are already offered.
 *
 * Placeholders use LSP snippet syntax: `$1`/`$2` tab stops, `$0` final caret,
 * `${n:default}` defaults, `${n|a,b|}` choices. Indentation uses tabs; the
 * editor reindents to the file's settings on insert.
 *
 * Keywords absent here (operators, the `VarType` literals, `else`, and `goto`,
 * whose target is a cross-reference the linker completes) fall through to the
 * default bare-keyword completion.
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
  script:
    'script ${1:id} ```${2|javascript,groovy,python,ruby,feel|}\n\t$0\n```',
  // task attributes
  assignee: 'assignee = "${1:user}"',
  formKey: 'formKey = "${1:form-key}"',
  class: 'class = "${1:com.example.Delegate}"',
  // the `\$` escapes keep the EL `${...}` literal instead of starting a nested
  // snippet placeholder; only the tab stop's own `${1: ... }` wrapper is live.
  expression: 'expression = "${1:\\${bean.method(execution)}}"',
  delegate: 'delegate = "${1:\\${beanName}}"',
  topic: 'topic = "${1:topic-name}"',
  // control flow
  if: 'if (${1:condition}) {\n\t$0\n}',
  while: 'while (${1:condition}) {\n\t$0\n}',
  do: 'do {\n\t$1\n} while (${2:condition})',
  parallel: 'parallel {\n\t{\n\t\t$1\n\t}\n\t{\n\t\t$2\n\t}\n}',
  subprocess: 'subprocess ${1:id} {\n\t$0\n}',
  // event handlers / throw / emit. Only the triggers taking a plain `"CODE"`
  // string appear in these choices: `timer` and `condition` read a
  // differently-shaped payload and `compensation` carries none at all, so they
  // are offered at the bare ID position instead (see `completionFor` below).
  // No hosted variant is scaffolded either, since the host is a
  // cross-reference rather than a fixed word.
  on: 'on ${1|error,escalation,message,signal|} "${2:CODE}" {\n\t$0\n}',
  throw: 'throw ${1|error,escalation,signal|} "${2:CODE}"',
  // `emit` has no continuing form for `error` (an error always ends its path).
  emit: 'emit ${1|escalation,signal|} "${2:CODE}"',
  // `await` never catches error/escalation/compensation, which are thrown
  // rather than awaited inline.
  await: 'await ${1|message,signal|} "${2:CODE}"',
  // call
  call: 'call ${1:id} {\n\tprocess = "${2:process-id}"\n\tin ${3:input}\n\tout ${4:result}\n}',
  // call attributes
  binding: 'binding = ${1|latest,deployment|}',
  version: 'version = ${1:1}',
  // the `\$` escape keeps the EL literal, same as `expression`/`delegate` above.
  businessKey: 'businessKey = "${1:\\${execution.processBusinessKey}}"',
};

/**
 * Per-keyword `detail` text, overriding the default `'BPMNscript construct'`
 * caption where a more specific description helps.
 */
const STRUCTURE_DETAILS: Readonly<Record<string, string>> = {
  call: 'call another process like a function',
};

/**
 * Offers snippet completions for the BPMNscript structural keywords so the
 * editor scaffolds a full construct (with its brackets) on accept. Every other
 * completion keeps Langium's default behaviour.
 */
export class BpmnScriptCompletionProvider extends DefaultCompletionProvider {
  /**
   * Offers items for the soft event words at the `trigger`, `particle`, and
   * `field` positions. These words lex as plain `ID`s rather than grammar
   * keywords, so the default completion offers nothing there; each construct
   * gets only the words that are legal for it.
   *
   * `OnHandler.host` is absent from this dispatch because it is a real
   * cross-reference: the inherited `completionForCrossReference` already offers
   * it, narrowed to the enclosing container's named steps by
   * `BpmnScriptScopeProvider`.
   */
  protected override completionFor(
    context: CompletionContext,
    next: NextFeature,
    acceptor: CompletionAcceptor,
  ): MaybePromise<void> {
    const containerType = context.node?.$type;
    if (next.property === 'trigger') {
      if (containerType === 'EmitStatement') {
        this.acceptEventWord(
          context,
          acceptor,
          ['escalation', 'signal', 'compensation'],
          {
            compensation: "undo this scope's completed work, then continue",
          },
        );
        return;
      }
      if (containerType === 'ThrowStatement') {
        this.acceptEventWord(
          context,
          acceptor,
          ['error', 'escalation', 'signal', 'compensation'],
          {
            compensation:
              "undo this scope's completed work, then end this path",
          },
        );
        return;
      }
      if (containerType === 'OnHandler') {
        this.acceptEventWord(
          context,
          acceptor,
          ['error', 'escalation', 'message', 'signal', 'compensation'],
          { compensation: 'the undo block of this subprocess' },
        );
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
      if (containerType === 'IntermediateCatchEvent') {
        this.acceptEventWord(context, acceptor, ['message', 'signal']);
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
    if (
      next.property === 'particle' &&
      (containerType === 'OnHandler' ||
        containerType === 'IntermediateCatchEvent')
    ) {
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

  /**
   * One keyword-kind item per word, each with the default
   * `'BPMNscript event word'` detail unless `detailOverrides` names a more
   * specific one (`compensation`'s undo wording differs per statement).
   */
  private acceptEventWord(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
    words: readonly string[],
    detailOverrides?: Readonly<Record<string, string>>,
  ): void {
    for (const word of words) {
      acceptor(context, {
        label: word,
        kind: CompletionItemKind.Keyword,
        detail: detailOverrides?.[word] ?? 'BPMNscript event word',
        sortText: '1',
      });
    }
  }

  /**
   * One snippet-kind item for a trigger word whose payload does not fit the
   * plain `"CODE"` string choice (`timer`, `condition`), scaffolding the
   * trigger word together with its own payload shape.
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

  /** One keyword-kind item per timer particle. */
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
