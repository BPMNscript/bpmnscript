/**
 * Normalizes `OnHandler.time` so a timer's time string has the same shape
 * regardless of which grammar alternative produced it.
 *
 * `time=(STRING | RAW_TEMPLATE)` lets an author write a plain duration/date/
 * cycle string (`after "PT1H"`) or an EL template (`after "${dueDate}"`) in
 * the same position. Langium's {@link DefaultValueConverter} only auto-
 * unquotes a match by rule name for `STRING` (and `INT`/`ID`) — a
 * `RAW_TEMPLATE` match is returned verbatim, quotes included, because the
 * grammar's other use of that terminal (`RawExpr.raw`) deliberately keeps its
 * quotes for `expression-render.ts` to strip. Left alone, the two `time`
 * alternatives would therefore disagree on shape: `PT1H` vs `"${dueDate}"`.
 *
 * This converter unquotes `RAW_TEMPLATE` exactly where it fills `time` (found
 * by walking up from the matched CST node to its enclosing grammar
 * `Assignment` and checking its `feature` name), so `after "${dueDate}"`
 * yields `${dueDate}` — the same normalized shape a `STRING` alternative
 * would yield for its content. Every other `RAW_TEMPLATE` match (`RawExpr.raw`)
 * is untouched.
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
