/**
 * Soft words lex as `ID`, so TextMate cannot tell `on error` from
 * `var error: string`; semantic tokens come off the AST. `OnHandler.host` is a
 * reference, not a trigger word.
 */

import type { AstNode } from 'langium';
import {
  AbstractSemanticTokenProvider,
  type SemanticTokenAcceptor,
} from 'langium/lsp';
import { SemanticTokenTypes } from 'vscode-languageserver-types';
import {
  isCodeDecl,
  isEmitStatement,
  isEndEvent,
  isErrorMapping,
  isFormField,
  isIntermediateCatchEvent,
  isIoParameter,
  isListener,
  isOnHandler,
  isRaceBranch,
  isSetting,
  isStartEvent,
  isThrowStatement,
} from './generated/ast.js';

export class BpmnScriptSemanticTokenProvider extends AbstractSemanticTokenProvider {
  protected override highlightElement(
    node: AstNode,
    acceptor: SemanticTokenAcceptor,
  ): void | undefined | 'prune' {
    const keyword = (property: string): void =>
      acceptor({ node, property, type: SemanticTokenTypes.keyword });

    if (
      isOnHandler(node) ||
      isThrowStatement(node) ||
      isEmitStatement(node) ||
      isIntermediateCatchEvent(node) ||
      isRaceBranch(node)
    ) {
      keyword('trigger');
    } else if (isStartEvent(node) || isEndEvent(node)) {
      if (node.trigger) {
        keyword('trigger');
      }
    } else if (isCodeDecl(node)) {
      keyword('kind');
    } else if (isSetting(node)) {
      keyword('key');
    } else if (isIoParameter(node)) {
      keyword('direction');
    } else if (isFormField(node)) {
      keyword('type');
    } else if (isListener(node)) {
      keyword('event');
      if (node.particle) {
        keyword('particle');
      }
    } else if (isErrorMapping(node)) {
      keyword('trigger');
      keyword('when');
    }
    return undefined;
  }
}
