/**
 * The default outline skips an `on` handler (no `name`) and flattens its steps
 * into the process.
 */

import type { AstNode, AstNodeDescription, LangiumDocument } from 'langium';
import { GrammarUtils } from 'langium';
import {
  DefaultDocumentSymbolProvider,
  DefaultNodeKindProvider,
} from 'langium/lsp';
import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver-types';
import { isOnHandler } from './generated/ast.js';

// prettier-ignore
const SYMBOL_KIND_BY_TYPE: Readonly<Record<string, SymbolKind>> = {
  Process: SymbolKind.Module, SubProcess: SymbolKind.Namespace,
  UserTask: SymbolKind.Function, ServiceTask: SymbolKind.Function, ScriptTask: SymbolKind.Function,
  GenericTask: SymbolKind.Function, SendTask: SymbolKind.Function, ReceiveTask: SymbolKind.Function,
  BusinessRuleTask: SymbolKind.Function, CallActivity: SymbolKind.Function,
  StartEvent: SymbolKind.Event, EndEvent: SymbolKind.Event, ThrowStatement: SymbolKind.Event,
  EmitStatement: SymbolKind.Event, IntermediateCatchEvent: SymbolKind.Event, OnHandler: SymbolKind.Event,
  CodeDecl: SymbolKind.Constant, VarDecl: SymbolKind.Variable,
};

export class BpmnScriptNodeKindProvider extends DefaultNodeKindProvider {
  override getSymbolKind(node: AstNode | AstNodeDescription): SymbolKind {
    const type = 'type' in node ? node.type : node.$type;
    return SYMBOL_KIND_BY_TYPE[type] ?? super.getSymbolKind(node);
  }
}

/** A handler is named by its header; `alongside` tells two on one host apart. */
export class BpmnScriptDocumentSymbolProvider extends DefaultDocumentSymbolProvider {
  protected override getSymbol(
    document: LangiumDocument,
    astNode: AstNode,
  ): DocumentSymbol[] {
    if (!isOnHandler(astNode) || !astNode.$cstNode) {
      return super.getSymbol(document, astNode);
    }
    const text = astNode.$cstNode.text;
    const headerEnd = text.indexOf('{');
    const name = (headerEnd === -1 ? text : text.slice(0, headerEnd)).trim();
    const selection =
      GrammarUtils.findNodeForProperty(astNode.$cstNode, 'trigger') ??
      astNode.$cstNode;
    return [
      {
        kind: this.nodeKindProvider.getSymbolKind(astNode),
        name,
        range: astNode.$cstNode.range,
        selectionRange: selection.range,
        children: this.getChildSymbols(document, astNode),
      },
    ];
  }
}
