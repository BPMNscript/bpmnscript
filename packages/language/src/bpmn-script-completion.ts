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
  // own scaffolding items at the ID position instead; `compensation` carries
  // no code at all and is offered only as a plain keyword item at the ID
  // position, never in this choice. No hosted (attached) variant is offered
  // here: the host is a cross-reference into the enclosing container's own
  // steps, not a fixed word, so it cannot be folded into a `${n|a,b|}` choice
  // placeholder without forcing every accepted snippet to name some
  // arbitrary host. Building the attached form is instead an interactive
  // three-step completion — accept an activity name at the host position,
  // type the colon, then accept a trigger word — which the ID-position
  // completion below already offers in full.
  on: 'on ${1|error,escalation,message,signal|} "${2:CODE}" {\n\t$0\n}',
  throw: 'throw ${1|error,escalation,signal|} "${2:CODE}"',
  // `emit` has no continuing form for `error` (an error always ends its
  // path), so `error` is absent from this choice.
  emit: 'emit ${1|escalation,signal|} "${2:CODE}"',
  // `await` only ever catches message/timer/signal/condition (never
  // error/escalation/compensation, which are thrown, not awaited inline);
  // of those, `message`/`signal` are the two that take the plain `"CODE"`
  // string this choice scaffolds, mirroring `emit` above.
  await: 'await ${1|message,signal|} "${2:CODE}"',
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
   * offers all seven — `timer` and `condition` as snippet items that also
   * scaffold their differently-shaped payload, since neither reads a plain
   * `"CODE"` string; `compensation` as a plain keyword item on every one of
   * the three, each with its own undo-framed `detail` text, since it carries
   * no payload at all to scaffold), the `trigger` property of
   * `IntermediateCatchEvent` (`await`) offers only its four catch-legal
   * words — `message`/`signal` as plain items, `timer`/`condition` as the
   * same scaffolding snippets `on` offers, with `error`/`escalation`/
   * `compensation` withheld because they are thrown, not awaited inline —
   * the `particle` property of an `on timer` handler or an `await timer`
   * catch offers the three timer particles with a one-line description
   * each, and `code`/`message` complete the `field` property of a handler
   * binding. These words lex as plain `ID`s (not grammar keywords — see
   * `bpmn-script-validator.ts`), so the default completion offers nothing at
   * these positions; every other position keeps the inherited behaviour.
   *
   * `OnHandler.host` is deliberately absent from this dispatch: it is a real
   * cross-reference, not a soft trigger word, so the inherited
   * `completionForCrossReference` already offers it — scoped to the enclosing
   * container's named steps by `BpmnScriptScopeProvider`, the same narrowing
   * `goto` gets. Because the host is optional, the parser reports both the
   * host and the trigger as valid next features right after `on`, so an
   * author sees the container's activity names alongside the trigger words at
   * that position; typing a host and a colon narrows the next position down
   * to `trigger` alone, still dispatched exactly as the host-less case above.
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
   * Emit one plain keyword-kind completion item per word in `words`, each
   * with the default `'BPMNscript event word'` detail unless `detailOverrides`
   * names a more specific one for it (used for `compensation`'s undo-framed
   * text, which differs per statement).
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
