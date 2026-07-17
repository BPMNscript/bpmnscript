import type { GrammarAST } from 'langium';
import {
  DefaultCompletionProvider,
  type CompletionAcceptor,
  type CompletionContext,
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
