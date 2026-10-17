/**
 * Langium unquotes only `STRING`; a verbatim `RAW_TEMPLATE` would reach the
 * engine with a stray `\` and gain another each time the printer quotes it,
 * and a `QUOTED_NAME` would carry its backticks into the id.
 */

import {
  DefaultValueConverter,
  GrammarAST,
  ValueConverter,
  type CstNode,
  type ValueType,
} from 'langium';

import { unquoteName } from './vocabulary.js';

export class BpmnScriptValueConverter extends DefaultValueConverter {
  protected override runConverter(
    rule: GrammarAST.AbstractRule,
    input: string,
    cstNode: CstNode,
  ): ValueType {
    if (rule.name === 'RAW_TEMPLATE')
      return ValueConverter.convertString(input);
    if (rule.name === 'QUOTED_NAME') return unquoteName(input);
    return super.runConverter(rule, input, cstNode);
  }
}
