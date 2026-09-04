/**
 * Semantic-token highlighting for the soft words. `error`, `escalation`,
 * `code`, `message`, `terminate`, the attribute keys, the parameter
 * directions, and the listener events all lex as plain `ID` so that
 * `var message: string` still parses. The generated TextMate grammar is a
 * regex over token text and cannot tell `on error` from `var error: string`,
 * or an attribute `priority` from the variable in `if (priority > 5)`.
 * Semantic tokens are computed from the parsed AST, so a soft word highlights
 * exactly where the grammar gave it that meaning, and VS Code's default themes
 * render a semantic `keyword` like a lexical one.
 *
 * The trigger positions covered are `on`, `throw`, `emit`, `await`, and the
 * start and end events. `OnHandler.host` is excluded: it is a cross-reference
 * to the activity the handler attaches to, not a trigger word.
 */

import type { AstNode } from 'langium';
import {
  AbstractSemanticTokenProvider,
  type SemanticTokenAcceptor,
} from 'langium/lsp';
import { SemanticTokenTypes } from 'vscode-languageserver-types';
import {
  isAttribute,
  isEmitStatement,
  isEndEvent,
  isErrorDecl,
  isEventBinding,
  isIntermediateCatchEvent,
  isIoParameter,
  isListener,
  isOnHandler,
  isProcessAttribute,
  isStartEvent,
  isThrowStatement,
} from './generated/ast.js';

export class BpmnScriptSemanticTokenProvider extends AbstractSemanticTokenProvider {
  protected override highlightElement(
    node: AstNode,
    acceptor: SemanticTokenAcceptor,
  ): void | undefined | 'prune' {
    // Every soft word highlights as a keyword; only the property differs.
    const keyword = (property: string): void =>
      acceptor({ node, property, type: SemanticTokenTypes.keyword });

    if (
      isOnHandler(node) ||
      isThrowStatement(node) ||
      isEmitStatement(node) ||
      isIntermediateCatchEvent(node)
    ) {
      keyword('trigger');
      if (
        (isOnHandler(node) || isIntermediateCatchEvent(node)) &&
        node.particle
      ) {
        keyword('particle');
      }
    } else if (isStartEvent(node) || isEndEvent(node)) {
      if (node.trigger) {
        keyword('trigger');
      }
      if (isStartEvent(node) && node.particle) {
        keyword('particle');
      }
    } else if (isEventBinding(node)) {
      keyword('field');
    } else if (isErrorDecl(node)) {
      keyword('kind');
      keyword('field');
    } else if (isAttribute(node) || isProcessAttribute(node)) {
      keyword('key');
    } else if (isIoParameter(node)) {
      keyword('direction');
    } else if (isListener(node)) {
      keyword('event');
      if (node.particle) {
        keyword('particle');
      }
    }
    return undefined;
  }
}
