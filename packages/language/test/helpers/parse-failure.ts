/**
 * Turning a Langium parse result into a readable failure, shared by the suites
 * that treat any parse error as an aborted test rather than an assertion.
 */

import type { LangiumDocument } from 'langium';
import { isModel } from '@bpmn-script/language';

/**
 * Every parse failure in `document` as one human-readable string, or `undefined`
 * when it parsed cleanly. Lexer errors are checked first because they fire
 * before the parser and would otherwise be masked.
 */
export function formatParseFailure(
  document: LangiumDocument,
): string | undefined {
  if (document.parseResult.lexerErrors.length) {
    return (
      'Lexer errors:\n  ' +
      document.parseResult.lexerErrors.map((e) => e.message).join('\n  ')
    );
  }
  if (document.parseResult.parserErrors.length) {
    return (
      'Parser errors:\n  ' +
      document.parseResult.parserErrors.map((e) => e.message).join('\n  ')
    );
  }
  if (document.parseResult.value === undefined) {
    return "ParseResult is 'undefined'.";
  }
  if (!isModel(document.parseResult.value)) {
    return `Root AST object is a ${document.parseResult.value.$type}, expected a 'Model'.`;
  }
  return undefined;
}
