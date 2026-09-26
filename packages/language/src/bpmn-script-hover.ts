/**
 * Hover for a named statement, a declared code and a variable. Langium
 * resolves the caret through `References.findDeclarations` first, so a `goto`
 * target, a host, a thrown or caught code and every site of a variable show
 * their declaration's line with no case of their own.
 */

import type { AstNode } from 'langium';
import { MultilineCommentHoverProvider } from 'langium/lsp';
import {
  isCodeDecl,
  isLiteralString,
  type CodeDecl,
  type ParenItem,
} from './generated/ast.js';
import {
  isNamedStatement,
  type NamedStatement,
} from './bpmn-script-scope-provider.js';
import {
  attributeBlockRuleOf,
  EVENT_CODE_FIELD,
  EVENT_MESSAGE_FIELD,
} from './vocabulary.js';
import { isVariableSymbolNode } from './bpmn-script-references.js';
import { declaredCodeOf, settingsOf } from './paren-items.js';

function literalSetting(items: ParenItem[], key: string): string | undefined {
  const setting = settingsOf(items).find((item) => item.key === key);
  return setting && isLiteralString(setting.value)
    ? setting.value.value
    : undefined;
}

function namedStatementHover(node: NamedStatement): string {
  const description = attributeBlockRuleOf(node)?.description;
  const label = literalSetting(node.items, 'label');
  const head = `${description} '${node.name}'`;
  return label === undefined ? head : `${head}: ${label}`;
}

function codeDeclHover(decl: CodeDecl): string {
  const article = /^[aeiou]/i.test(decl.kind) ? 'an' : 'a';
  let line = `${article} ${decl.kind} '${decl.name}'`;
  // `declaredCodeOf` falls back to the name; hover quotes only a written
  // setting.
  const hasCodeSetting = settingsOf(decl.items).some(
    (item) => item.key === EVENT_CODE_FIELD,
  );
  const code = hasCodeSetting ? declaredCodeOf(decl) : undefined;
  if (code !== undefined) line += ` with code "${code}"`;
  const message = literalSetting(decl.items, EVENT_MESSAGE_FIELD);
  if (message !== undefined) line += `: ${message}`;
  return line;
}

function ownHoverContent(node: AstNode): string | undefined {
  if (isNamedStatement(node)) return namedStatementHover(node);
  if (isCodeDecl(node)) return codeDeclHover(node);
  if (isVariableSymbolNode(node)) return `${node.name}: ${node.type}`;
  return undefined;
}

export class BpmnScriptHoverProvider extends MultilineCommentHoverProvider {
  protected override async getAstNodeHoverContent(
    node: AstNode,
  ): Promise<string | undefined> {
    const own = ownHoverContent(node);
    const doc = await super.getAstNodeHoverContent(node);
    if (own !== undefined && doc !== undefined) return `${own}\n\n${doc}`;
    return own ?? doc;
  }
}
