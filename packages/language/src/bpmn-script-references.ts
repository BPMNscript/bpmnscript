/**
 * `VarRef.ref` resolves in a code position alone, so Langium's definition,
 * references, rename, highlight and hover know nothing of variables; all five
 * go through `findDeclarations`/`findReferences`, overridden here with a
 * symbol node built from `declaringSites` per request (fast enough uncached).
 */

import {
  AstUtils,
  CstUtils,
  DefaultReferences,
  GrammarUtils,
  stream,
  type AstNode,
  type CstNode,
  type FindReferencesOptions,
  type LangiumDocument,
  type ReferenceDescription,
  type Stream,
} from 'langium';
import {
  isProcess,
  isVarRef,
  type Process,
  type VarType,
} from './generated/ast.js';
import type { BpmnScriptServices } from './bpmn-script-module.js';
import { isVariableUse } from './bpmn-script-validator.js';
import type {
  DeclaringSite,
  VariableSymbolProvider,
} from './variable-symbol-provider.js';

interface VariableSymbolNode extends AstNode {
  readonly $type: 'VariableSymbolNode';
  readonly $container: Process;
  readonly name: string;
  readonly type: VarType;
}

export function isVariableSymbolNode(
  node: AstNode,
): node is VariableSymbolNode {
  return node.$type === 'VariableSymbolNode';
}

function nameLeafOf(site: DeclaringSite): CstNode | undefined {
  return GrammarUtils.findNodeForProperty(site.node.$cstNode, site.property);
}

export class BpmnScriptReferences extends DefaultReferences {
  private readonly symbols: VariableSymbolProvider;

  constructor(services: BpmnScriptServices) {
    super(services);
    this.symbols = services.references.VariableSymbolProvider;
  }

  override findDeclarations(cst: CstNode): AstNode[] {
    const symbol = this.variableAt(cst);
    return symbol ? [symbol] : super.findDeclarations(cst);
  }

  override findDeclarationNodes(cst: CstNode): CstNode[] {
    const symbol = this.variableAt(cst);
    if (symbol === undefined) return super.findDeclarationNodes(cst);
    return this.sitesOf(symbol)
      .map(nameLeafOf)
      .filter((leaf) => leaf !== undefined);
  }

  override findReferences(
    node: AstNode,
    options: FindReferencesOptions,
  ): Stream<ReferenceDescription> {
    if (!isVariableSymbolNode(node)) return super.findReferences(node, options);
    const process = node.$container;
    const document = AstUtils.getDocument(process);
    const sites = this.sitesOf(node);
    const leaves: CstNode[] = [];
    if (options.includeDeclaration) {
      leaves.push(
        ...sites.map(nameLeafOf).filter((leaf) => leaf !== undefined),
      );
    }
    const declaring = new Set(sites.map((site) => site.node));
    for (const ref of AstUtils.streamAst(process).filter(isVarRef)) {
      if (declaring.has(ref)) continue;
      // The `ref` leaf alone, so `order.total` renames `order` and keeps `.total`.
      const leaf = ref.ref.$refNode;
      if (leaf && ref.ref.$refText === node.name && isVariableUse(ref)) {
        leaves.push(leaf);
      }
    }
    const targetPath = this.nodeLocator.getAstNodePath(sites[0].node);
    return stream(leaves).map((leaf) =>
      this.describe(document, leaf, targetPath),
    );
  }

  /** A name with no site falls through to the default, which refuses a rename. */
  private variableAt(cst: CstNode): VariableSymbolNode | undefined {
    const node = cst.astNode;
    const feature = GrammarUtils.findAssignment(cst)?.feature;
    const process = AstUtils.getContainerOfType(node, isProcess);
    if (feature === undefined || process === undefined) return undefined;
    const sites = this.symbols.declaringSites(process);
    const site = sites.find((s) => s.node === node && s.property === feature);
    const name =
      site?.name ??
      (feature === 'ref' && isVarRef(node) && isVariableUse(node)
        ? node.ref.$refText
        : undefined);
    const first = sites.find((s) => s.name === name);
    if (name === undefined || first === undefined) return undefined;
    return {
      $type: 'VariableSymbolNode',
      $container: process,
      $cstNode: nameLeafOf(first),
      name,
      type: first.type,
    };
  }

  private sitesOf(symbol: VariableSymbolNode): DeclaringSite[] {
    return this.symbols
      .declaringSites(symbol.$container)
      .filter((site) => site.name === symbol.name);
  }

  private describe(
    document: LangiumDocument,
    leaf: CstNode,
    targetPath: string,
  ): ReferenceDescription {
    return {
      sourceUri: document.uri,
      sourcePath: this.nodeLocator.getAstNodePath(leaf.astNode),
      targetUri: document.uri,
      targetPath,
      segment: CstUtils.toDocumentSegment(leaf),
      local: true,
    };
  }
}
