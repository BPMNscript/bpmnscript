/**
 * Normalizes `OnHandler.time`, which `time=(STRING | RAW_TEMPLATE)` fills with
 * a plain duration (`after "PT1H"`) or an EL template (`after "${dueDate}"`).
 * Langium's `DefaultValueConverter` auto-unquotes `STRING` but returns
 * `RAW_TEMPLATE` verbatim, quotes included, because the terminal's other use
 * (`RawExpr.raw`) needs them kept for `expression-render.ts` to strip, so left
 * alone the two alternatives disagree: `PT1H` vs `"${dueDate}"`.
 */

import {
  AstUtils,
  DefaultValueConverter,
  GrammarAST,
  ValueConverter,
  type CstNode,
  type ValueType,
} from 'langium';

const RAW_TEMPLATE_RULE_NAME = 'RAW_TEMPLATE';
const TIME_FEATURE_NAME = 'time';

export class BpmnScriptValueConverter extends DefaultValueConverter {
  protected override runConverter(
    rule: GrammarAST.AbstractRule,
    input: string,
    cstNode: CstNode,
  ): ValueType {
    if (
      rule.name === RAW_TEMPLATE_RULE_NAME &&
      this.fillsTimeFeature(cstNode)
    ) {
      return ValueConverter.convertString(input);
    }
    return super.runConverter(rule, input, cstNode);
  }

  private fillsTimeFeature(cstNode: CstNode): boolean {
    const source = cstNode.grammarSource;
    const assignment =
      source && AstUtils.getContainerOfType(source, GrammarAST.isAssignment);
    return assignment?.feature === TIME_FEATURE_NAME;
  }
}
