/**
 * Hover content for the three shapes a name can declare: a named statement, a
 * declared error or escalation code, and a variable.
 *
 * Langium's hover resolves the caret through `References.findDeclarations`
 * before this method ever runs: a `goto` target, a handler's host, a thrown
 * or caught code, and every site of a variable all resolve to the declaration
 * they reference, so the same line answers there too, with no case for any of
 * them here.
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
import { attributeBlockRuleOf } from './vocabulary.js';
import { isVariableSymbolNode } from './bpmn-script-references.js';
import { declaredCodeOf, settingsOf } from './paren-items.js';

/** The literal-string value of a written setting, `undefined` where absent or not quoted text. */
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
  // `declaredCodeOf` falls back to the declaration's own name when no `code`
  // setting is written; that fallback is the code the engine uses, not a
  // value the source spells, so hover only quotes one that was actually
  // written.
  const hasCodeSetting = settingsOf(decl.items).some(
    (item) => item.key === 'code',
  );
  const code = hasCodeSetting ? declaredCodeOf(decl) : undefined;
  if (code !== undefined) line += ` with code "${code}"`;
  const message = literalSetting(decl.items, 'message');
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
