/**
 * Reserved-word guidance for parse errors: a reserved grammar keyword (`date`,
 * `class`, `if`, ...) written where the parser expects a plain identifier gets
 * a message naming the word and pointing at the quoted `"${...}"` raw-string
 * fallback. Two Chevrotain paths reach that mistake, so both are overridden:
 * `buildMismatchTokenMessage` where the grammar expects exactly `ID`, and
 * `buildNoViableAltMessage` where `ID` is one alternative among several. A slot
 * whose alternatives are all keywords takes neither path and gets its own
 * message naming the words it does take. Every message here stays free of BPMN
 * vocabulary (ADR-0013).
 *
 * This only enriches the message Chevrotain already built; it cannot suppress
 * or restructure error recovery, nor change which token positions are legal.
 */

import {
  LangiumParserErrorMessageProvider,
  type LangiumCoreServices,
} from 'langium';

import { formatWordList, reservedWordsOf } from './vocabulary.js';

const ID_TOKEN_NAME = 'ID';

/**
 * A `var` declaration is legal only in the process header, so anywhere else the
 * parser has finished the statement list and reports "expecting `}`, found
 * `var`". `var` used as a name expects `ID` and takes the reserved-word path.
 */
const CLOSE_BRACE_TOKEN_NAME = '}';
const VAR_KEYWORD_TOKEN_NAME = 'var';

/** After a statement that takes no repeat clause, the same "expecting `}`". */
const FOR_KEYWORD_TOKEN_NAME = 'for';

/**
 * Two declarations start with a plain `ID` rather than a keyword (`error "CODE"
 * message "..."` and `<key> = <value>`), so a mistyped statement keyword in the
 * header region starts neither and Chevrotain falls back to the raw
 * expected-token list, which says nothing about the actual mistake.
 */
const PROCESS_DECL_RULE_NAME = 'ProcessDecl';

/** A token whose image could have been meant as a word rather than punctuation or a literal. */
const WORD_SHAPED = /^[A-Za-z_]/;

/**
 * Langium's generated Chevrotain rules carry a trailing zero-width space on
 * `ruleName` (`withRuleSuffix` in `langium-parser.ts`) so rule names never
 * collide with reserved JavaScript identifiers.
 */
function bareRuleName(ruleName: string): string {
  return ruleName.replace(/\u200b+$/, '');
}

/** Off the base signatures, so the transitive `chevrotain` package is unnamed. */
type MismatchTokenOptions = Parameters<
  LangiumParserErrorMessageProvider['buildMismatchTokenMessage']
>[0];
type NoViableAltOptions = Parameters<
  LangiumParserErrorMessageProvider['buildNoViableAltMessage']
>[0];

export class BpmnScriptParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
  private readonly services: LangiumCoreServices;

  constructor(services: LangiumCoreServices) {
    super();
    this.services = services;
  }

  override buildMismatchTokenMessage(options: MismatchTokenOptions): string {
    const { expected, actual } = options;
    if (expected.name === CLOSE_BRACE_TOKEN_NAME) {
      if (actual.tokenType.name === VAR_KEYWORD_TOKEN_NAME) {
        return this.varPlacementMessage();
      }
      if (actual.tokenType.name === FOR_KEYWORD_TOKEN_NAME) {
        return this.repeatClausePlacementMessage();
      }
    }
    if (
      expected.name === ID_TOKEN_NAME &&
      this.isReservedWord(actual.tokenType.name)
    ) {
      return this.reservedWordMessage(actual.image);
    }
    return super.buildMismatchTokenMessage(options);
  }

  private varPlacementMessage(): string {
    return (
      "A variable declaration ('var ...') must come before the first step in " +
      'the process, with the other declarations. Move it above the first ' +
      'statement.'
    );
  }

  private repeatClausePlacementMessage(): string {
    return (
      "A repeat clause ('for ...') attaches to the step that repeats. " +
      'The statement before it does not take one; move the clause onto ' +
      'the step that should.'
    );
  }

  private declarationOrStepMessage(word: string): string {
    return (
      `'${word}' is neither a known declaration nor a step keyword. ` +
      'A declaration starting with a plain word is either a setting ' +
      `('<key> = <value>') or 'error "CODE" message "..."'; every step starts ` +
      "with a keyword such as 'start', 'user', 'service', 'if', 'on', 'throw', 'emit', ..."
    );
  }

  override buildNoViableAltMessage(options: NoViableAltOptions): string {
    const actual = options.actual[0];
    if (
      actual &&
      bareRuleName(options.ruleName) === PROCESS_DECL_RULE_NAME &&
      actual.tokenType.name === ID_TOKEN_NAME
    ) {
      return this.declarationOrStepMessage(actual.image);
    }
    if (
      actual &&
      this.isReservedWord(actual.tokenType.name) &&
      this.expectsIdentifier(options.expectedPathsPerAlt)
    ) {
      return this.reservedWordMessage(actual.image);
    }
    if (actual && WORD_SHAPED.test(actual.image)) {
      const words = this.keywordAlternatives(options.expectedPathsPerAlt);
      if (words) {
        return this.wordAlternativeMessage(actual.image, words);
      }
    }
    return super.buildNoViableAltMessage(options);
  }

  private wordAlternativeMessage(
    word: string,
    alternatives: readonly string[],
  ): string {
    return `'${word}' is not a word this position takes; write ${formatWordList(alternatives)}.`;
  }

  /**
   * The keywords a slot admits, in grammar order, when every alternative is one
   * keyword and nothing else. `undefined` anywhere else, so a slot also taking
   * an identifier, a literal, or a longer phrase keeps Chevrotain's message
   * rather than being described as a closed set of words.
   */
  private keywordAlternatives(
    expectedPathsPerAlt: NoViableAltOptions['expectedPathsPerAlt'],
  ): readonly string[] | undefined {
    const words: string[] = [];
    for (const alt of expectedPathsPerAlt) {
      const path = alt.length === 1 ? alt[0] : undefined;
      const token = path?.length === 1 ? path[0] : undefined;
      if (token === undefined || !this.isReservedWord(token.name)) {
        return undefined;
      }
      words.push(token.name);
    }
    return words.length > 0 ? words : undefined;
  }

  private reservedWordMessage(word: string): string {
    const rawFallback = '"${' + word + '}"';
    return (
      `'${word}' is a reserved word and cannot be used as a plain name here. ` +
      `To refer to a variable named '${word}', write it as a quoted raw expression: ${rawFallback}.`
    );
  }

  private isReservedWord(tokenName: string): boolean {
    return reservedWordsOf(this.services.Grammar).has(tokenName);
  }

  private expectsIdentifier(
    expectedPathsPerAlt: NoViableAltOptions['expectedPathsPerAlt'],
  ): boolean {
    return expectedPathsPerAlt.some((alt) =>
      alt.some((path) => path.some((token) => token.name === ID_TOKEN_NAME)),
    );
  }
}
