import type { LangiumDocument } from 'langium';
import { isModel } from '@bpmn-script/language';

/** Lexer errors come first: they fire before the parser and would otherwise be masked. */
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
