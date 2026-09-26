/**
 * Guidance in place of Chevrotain's stock wording for the mistakes an author
 * makes with the grammar's shape: a reserved word where a plain identifier
 * belongs, a `var` or a repeat clause after the position that takes it, a
 * mistyped statement keyword. A reserved word reaches the parser down two
 * Chevrotain paths, so both builders are overridden: `buildMismatchTokenMessage`
 * where the grammar expects exactly `ID`, `buildNoViableAltMessage` where `ID`
 * is one alternative among several. Every message stays free of BPMN
 * vocabulary. Only the message changes; recovery and the legal
 * token positions are Chevrotain's.
 */

import {
  LangiumParserErrorMessageProvider,
  type LangiumCoreServices,
} from 'langium';

import {
  DECLARED_CODE_TRIGGERS,
  formatWordList,
  reservedWordsOf,
} from './vocabulary.js';

const ID_TOKEN_NAME = 'ID';

/**
 * A `var` after the first step, or a `for` after a statement that takes no
 * repeat clause, ends the statement list early: the parser expects `}` and
 * finds the keyword. An unclosed block reads the same way at `EOF`, whose
 * image is the empty string, so the stock message would say "found ``".
 */
const CLOSE_BRACE_TOKEN_NAME = '}';
const VAR_KEYWORD_TOKEN_NAME = 'var';
const FOR_KEYWORD_TOKEN_NAME = 'for';
const EOF_TOKEN_NAME = 'EOF';

/**
 * A code declaration is the one header declaration opening with a plain `ID`,
 * so a mistyped statement keyword parses as its kind and fails at the name
 * slot. A word that really opens a declaration is excluded, so `error "PF"`
 * still blames the text where the name belongs.
 */
const CODE_DECL_RULE_NAME = 'CodeDecl';

const WORD_SHAPED = /^[A-Za-z_]/;

/** Langium suffixes every Chevrotain rule name with a zero-width space (`withRuleSuffix` in `langium-parser.ts`). */
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
      if (actual.tokenType.name === EOF_TOKEN_NAME) {
        return this.unclosedBlockMessage();
      }
    }
    if (expected.name === ID_TOKEN_NAME) {
      if (this.isReservedWord(actual.tokenType.name)) {
        return this.reservedWordMessage(actual.image);
      }
      const word = options.previous.image;
      if (
        bareRuleName(options.ruleName) === CODE_DECL_RULE_NAME &&
        !DECLARED_CODE_TRIGGERS.has(word)
      ) {
        return this.declarationOrStepMessage(word);
      }
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

  private unclosedBlockMessage(): string {
    return "Expected '}' before the end of the file: a block is still open.";
  }

  private declarationOrStepMessage(word: string): string {
    return (
      `'${word}' is neither a known declaration nor a step keyword. ` +
      'A declaration starting with a plain word is ' +
      `${formatWordList([...DECLARED_CODE_TRIGGERS])} followed by the name it ` +
      'declares; every step starts with a keyword such as ' +
      "'start', 'user', 'service', 'if', 'on', 'throw', 'emit', ..."
    );
  }

  override buildNoViableAltMessage(options: NoViableAltOptions): string {
    const actual = options.actual[0];
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
   * The keywords a slot admits when every alternative is one keyword and
   * nothing else, else `undefined`: a slot also taking an identifier, a
   * literal or a longer phrase is not a closed set of words.
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
