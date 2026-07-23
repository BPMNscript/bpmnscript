/**
 * Semantic-token highlighting for the soft event words.
 *
 * `error`, `escalation`, `code`, and `message` lex as plain `ID` (the
 * grammar's soft-word convention, `bpmn-script.langium`): they are among the
 * most common variable names a Java-background author reaches for, so
 * reserving them would make `var message: string` a parse error. The cost is
 * that they get none of the highlighting a real keyword gets for free — the
 * generated TextMate grammar is a regex over token text, and a regex cannot
 * tell `on error` (the word means an event kind) from `var error: string`
 * (the same word, meaning nothing beyond "an identifier").
 *
 * A regex-based TextMate injection could only approximate the difference
 * with lookbehind heuristics, which is exactly the class of problem semantic
 * tokens exist to solve properly: they are computed from the parsed AST, so
 * a soft word highlights precisely when the grammar itself put it in one of
 * the positions that give it event meaning. This provider marks those
 * positions — `OnHandler`/`ThrowStatement`/`EmitStatement.trigger`, the
 * `OnHandler.particle` timer word (`after`/`at`/`every`),
 * `EventBinding.field`, and `ErrorDecl.kind`/`field` — with the `keyword`
 * semantic token type. VS Code's default themes render a semantic `keyword`
 * token the same way as a lexical one, so `on error` reads visually
 * identical to `on`, while `var error: string` stays a plain identifier.
 * Every other AST node falls through to Langium's default (no token).
 *
 * `OnHandler.host` is deliberately excluded: it is a cross-reference to the
 * activity the handler attaches to, not a trigger word, so `on Review: timer
 * after "PT2H" { }` marks `timer`/`after` as keywords while `Review` stays
 * plain — the same look a variable reference gets, which is what it
 * structurally is.
 */

import type { AstNode } from 'langium';
import {
  AbstractSemanticTokenProvider,
  type SemanticTokenAcceptor,
} from 'langium/lsp';
import { SemanticTokenTypes } from 'vscode-languageserver-types';
import {
  isEmitStatement,
  isErrorDecl,
  isEventBinding,
  isOnHandler,
  isThrowStatement,
} from './generated/ast.js';

export class BpmnScriptSemanticTokenProvider extends AbstractSemanticTokenProvider {
  protected override highlightElement(
    node: AstNode,
    acceptor: SemanticTokenAcceptor,
  ): void | undefined | 'prune' {
    if (isOnHandler(node) || isThrowStatement(node) || isEmitStatement(node)) {
      acceptor({
        node,
        property: 'trigger',
        type: SemanticTokenTypes.keyword,
      });
      if (isOnHandler(node) && node.particle) {
        acceptor({
          node,
          property: 'particle',
          type: SemanticTokenTypes.keyword,
        });
      }
    } else if (isEventBinding(node)) {
      acceptor({ node, property: 'field', type: SemanticTokenTypes.keyword });
    } else if (isErrorDecl(node)) {
      acceptor({ node, property: 'kind', type: SemanticTokenTypes.keyword });
      acceptor({ node, property: 'field', type: SemanticTokenTypes.keyword });
    }
    return undefined;
  }
}
