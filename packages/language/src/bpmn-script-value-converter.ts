/**
 * Reads a `RAW_TEMPLATE` token the way Langium reads `STRING`, quotes dropped
 * and escapes resolved, so `"${fn(\"a\")}"` becomes `${fn("a")}`. Langium's
 * `DefaultValueConverter` unquotes only the terminal named `STRING`; kept
 * verbatim, the body would reach the engine with a `\` outside a JUEL string
 * and gain one more each time the printer quotes it.
 */

import {
  DefaultValueConverter,
  GrammarAST,
  ValueConverter,
  type CstNode,
  type ValueType,
} from 'langium';

const RAW_TEMPLATE_RULE_NAME = 'RAW_TEMPLATE';

export class BpmnScriptValueConverter extends DefaultValueConverter {
  protected override runConverter(
    rule: GrammarAST.AbstractRule,
    input: string,
    cstNode: CstNode,
  ): ValueType {
    if (rule.name === RAW_TEMPLATE_RULE_NAME) {
      return ValueConverter.convertString(input);
    }
    return super.runConverter(rule, input, cstNode);
  }
}
