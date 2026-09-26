/**
 * Langium unquotes only `STRING`; a verbatim `RAW_TEMPLATE` would reach the
 * engine with a stray `\` and gain another each time the printer quotes it.
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
