/**
 * Semantic-token highlighting for the soft event words.
 *
 * `error`, `escalation`, `code`, and `message` lex as plain `ID` so that
 * `var message: string` still parses. The cost is that they get none of the
 * highlighting a real keyword gets for free: the generated TextMate grammar is
 * a regex over token text and cannot tell `on error` from `var error: string`.
 * Semantic tokens are computed from the parsed AST, so a soft word highlights
 * precisely where the grammar gave it event meaning. VS Code's default themes
 * render a semantic `keyword` token the same way as a lexical one.
 *
 * `OnHandler.host` is excluded: it is a cross-reference to the activity the
 * handler attaches to, not a trigger word, so it keeps the plain look of any
 * other reference.
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
  isIntermediateCatchEvent,
  isOnHandler,
  isThrowStatement,
} from './generated/ast.js';

export class BpmnScriptSemanticTokenProvider extends AbstractSemanticTokenProvider {
  protected override highlightElement(
    node: AstNode,
    acceptor: SemanticTokenAcceptor,
  ): void | undefined | 'prune' {
    if (
      isOnHandler(node) ||
      isThrowStatement(node) ||
      isEmitStatement(node) ||
      isIntermediateCatchEvent(node)
    ) {
      acceptor({
        node,
        property: 'trigger',
        type: SemanticTokenTypes.keyword,
      });
      if (
        (isOnHandler(node) || isIntermediateCatchEvent(node)) &&
        node.particle
      ) {
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
