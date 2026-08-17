/**
 * Normalizes `OnHandler.time` so a timer's time string has the same shape
 * whichever grammar alternative produced it.
 *
 * `time=(STRING | RAW_TEMPLATE)` accepts a plain duration/date/cycle string
 * (`after "PT1H"`) or an EL template (`after "${dueDate}"`). Langium's
 * `DefaultValueConverter` auto-unquotes by rule name for `STRING` but returns a
 * `RAW_TEMPLATE` match verbatim, quotes included, because the terminal's other
 * use (`RawExpr.raw`) needs its quotes kept for `expression-render.ts` to
 * strip. Left alone the two alternatives would disagree: `PT1H` vs
 * `"${dueDate}"`. Unquoting `RAW_TEMPLATE` only where it fills `time` leaves
 * every `RawExpr.raw` match untouched.
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

  /** True when `cstNode` was matched for the `OnHandler.time` assignment. */
  private fillsTimeFeature(cstNode: CstNode): boolean {
    const source = cstNode.grammarSource;
    const assignment =
      source && AstUtils.getContainerOfType(source, GrammarAST.isAssignment);
    return assignment?.feature === TIME_FEATURE_NAME;
  }
}
