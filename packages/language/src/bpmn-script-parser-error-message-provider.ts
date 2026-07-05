/**
 * Reserved-word guidance for parse errors.
 *
 * Using a reserved grammar keyword (`date`, `class`, `if`, …) where the parser
 * expects a plain identifier produces, by default, a low-level Chevrotain error
 * ("Expecting token of type 'ID'…", or "Expecting: one of these possible token
 * sequences…"). Neither tells the DSL author *why* the name was rejected or what
 * to do about it. This provider replaces those two messages, when the offending
 * token is a reserved word, with guidance that names the word and points to the
 * quoted `"${…}"` raw-string fallback — the escape hatch for a variable that
 * happens to be spelled like a keyword.
 *
 * Two Chevrotain error paths reach a reserved-word-as-identifier mistake:
 *   - **mismatched token** (`buildMismatchTokenMessage`) fires where the grammar
 *     expects exactly `ID` — e.g. a step name (`user date`, `goto date`).
 *   - **no-viable-alternative** (`buildNoViableAltMessage`) fires in *expression*
 *     position, where `ID` is only one of several alternatives (a literal, `(`,
 *     the raw template, …) — e.g. `if (date > deadline)`. This is the path a
 *     reserved word inside a condition takes.
 * Overriding both keeps the guidance consistent wherever a reserved word is
 * wrongly used as a name.
 *
 * The reserved-word set is derived from the grammar's own keyword tokens (not a
 * hardcoded list), so it stays correct as keywords are added or removed. Only
 * *word-like* keywords are considered — operators such as `&&` can never be
 * confused with an identifier.
 *
 * This provider only enriches the *message* Chevrotain already built; it
 * cannot suppress or restructure Chevrotain's error recovery, and it does not
 * change which token positions are legal. The grammar still rejects the
 * reserved word exactly where it did before — the author just gets an
 * actionable message instead of a raw one.
 */

import {
  AstUtils,
  GrammarAST,
  LangiumParserErrorMessageProvider,
  type LangiumCoreServices,
} from 'langium';

/**
 * The identifier terminal name in the grammar — the token position a reserved
 * word wrongly occupies when used as a bare name.
 */
const ID_TOKEN_NAME = 'ID';

/**
 * Option-object types for the two overridden Chevrotain error builders. Derived
 * from the base method signatures so the exact (Chevrotain) field shapes are
 * reused without naming the transitive `chevrotain` package.
 */
type MismatchTokenOptions = Parameters<
  LangiumParserErrorMessageProvider['buildMismatchTokenMessage']
>[0];
type NoViableAltOptions = Parameters<
  LangiumParserErrorMessageProvider['buildNoViableAltMessage']
>[0];

/**
 * Enriches the "expected an identifier" parse errors with reserved-word
 * guidance. See the file docstring for the scope and the documented limitation.
 */
export class BpmnScriptParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
  private readonly services: LangiumCoreServices;
  /** Lazily computed word-like keyword set (see {@link getReservedWords}). */
  private reservedWords?: ReadonlySet<string>;

  constructor(services: LangiumCoreServices) {
    super();
    this.services = services;
  }

  /**
   * A reserved word where exactly `ID` was expected (e.g. a step name) →
   * reserved-word guidance; otherwise the default mismatched-token message.
   */
  override buildMismatchTokenMessage(options: MismatchTokenOptions): string {
    const { expected, actual } = options;
    if (
      expected.name === ID_TOKEN_NAME &&
      this.isReservedWord(actual.tokenType.name)
    ) {
      return this.reservedWordMessage(actual.image);
    }
    return super.buildMismatchTokenMessage(options);
  }

  /**
   * A reserved word in a position where `ID` is one of several alternatives
   * (expression position) → reserved-word guidance; otherwise the default
   * no-viable-alternative message.
   */
  override buildNoViableAltMessage(options: NoViableAltOptions): string {
    const actual = options.actual[0];
    if (
      actual &&
      this.isReservedWord(actual.tokenType.name) &&
      this.expectsIdentifier(options.expectedPathsPerAlt)
    ) {
      return this.reservedWordMessage(actual.image);
    }
    return super.buildNoViableAltMessage(options);
  }

  /**
   * The actionable message: names the word and shows the quoted `"${…}"`
   * raw-string form to use instead. Deliberately free of BPMN vocabulary
   * (ADR-0013).
   */
  private reservedWordMessage(word: string): string {
    const rawFallback = '"${' + word + '}"';
    return (
      `'${word}' is a reserved word and cannot be used as a plain name here. ` +
      `To refer to a variable named '${word}', write it as a quoted raw expression: ${rawFallback}.`
    );
  }

  /** True when `tokenName` is one of the grammar's word-like reserved keywords. */
  private isReservedWord(tokenName: string): boolean {
    return this.getReservedWords().has(tokenName);
  }

  /** True when the identifier terminal is among the expected alternatives. */
  private expectsIdentifier(
    expectedPathsPerAlt: NoViableAltOptions['expectedPathsPerAlt'],
  ): boolean {
    return expectedPathsPerAlt.some((alt) =>
      alt.some((path) => path.some((token) => token.name === ID_TOKEN_NAME)),
    );
  }

  /**
   * The word-like keyword values from the grammar, computed once. A keyword's
   * lexer token is named after its literal value, so these strings match
   * `actual.tokenType.name` for a keyword token. Operators (`&&`, `+`, `{`, …)
   * are excluded because they cannot be mistaken for an identifier.
   */
  private getReservedWords(): ReadonlySet<string> {
    if (!this.reservedWords) {
      const words = new Set<string>();
      for (const node of AstUtils.streamAllContents(this.services.Grammar)) {
        if (GrammarAST.isKeyword(node) && /^[A-Za-z_]/.test(node.value)) {
          words.add(node.value);
        }
      }
      this.reservedWords = words;
    }
    return this.reservedWords;
  }
}
