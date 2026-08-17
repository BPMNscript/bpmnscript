/**
 * Reserved-word guidance for parse errors.
 *
 * Using a reserved grammar keyword (`date`, `class`, `if`, ...) where the parser
 * expects a plain identifier produces, by default, a low-level Chevrotain error
 * ("Expecting token of type 'ID'...", or "Expecting: one of these possible token
 * sequences..."). Neither tells the DSL author why the name was rejected or what
 * to do about it. This provider replaces those two messages, when the offending
 * token is a reserved word, with guidance that names the word and points to the
 * quoted `"${...}"` raw-string fallback, the escape hatch for a variable that
 * happens to be spelled like a keyword.
 *
 * Two Chevrotain error paths reach a reserved-word-as-identifier mistake:
 *   - mismatched token (`buildMismatchTokenMessage`) fires where the grammar
 *     expects exactly `ID`, e.g. a step name (`user date`, `goto date`).
 *   - no-viable-alternative (`buildNoViableAltMessage`) fires in expression
 *     position, where `ID` is only one of several alternatives (a literal, `(`,
 *     the raw template, ...), e.g. `if (date > deadline)`.
 * Overriding both keeps the guidance consistent wherever a reserved word is
 * wrongly used as a name.
 *
 * The reserved-word set is derived from the grammar's own keyword tokens (not a
 * hardcoded list), so it stays correct as keywords are added or removed. Only
 * word-like keywords are considered; operators such as `&&` can never be
 * confused with an identifier.
 *
 * This provider only enriches the message Chevrotain already built. It cannot
 * suppress or restructure Chevrotain's error recovery, and it does not change
 * which token positions are legal.
 */

import {
  AstUtils,
  GrammarAST,
  LangiumParserErrorMessageProvider,
  type LangiumCoreServices,
} from 'langium';

/**
 * The identifier terminal name in the grammar, the token position a reserved
 * word wrongly occupies when used as a bare name.
 */
const ID_TOKEN_NAME = 'ID';

/**
 * Token names for the misplaced-`var` diagnostic. A `var` declaration is legal
 * only in the process header (before the first statement); anywhere in a body or
 * block the parser has finished the statement list and expects the closing `}`,
 * so it reports "expecting `}`, found `var`". That exact shape, a `var` token
 * where `}` was expected, is the misplacement, distinct from `var` used as a
 * name (which expects `ID` and is handled by the reserved-word path).
 */
const CLOSE_BRACE_TOKEN_NAME = '}';
const VAR_KEYWORD_TOKEN_NAME = 'var';

/**
 * Token/rule names for the header-typo diagnostic. `ErrorDecl` is the only
 * declaration whose first word is a plain `ID` rather than a keyword, making it
 * the sole ID-led alternative in the process-header region. A mistyped
 * statement keyword there (`usr Review` meaning `user Review`) therefore
 * mis-predicts into `ErrorDecl`: the parser commits to `kind=ID` and then fails
 * expecting `code=STRING`.
 *
 * `ErrorDecl` (`kind=ID code=STRING field=ID message=STRING`) has two `STRING`
 * positions, and only the first marks the typo. Excluding a failure whose
 * preceding token is the leading `error` or the field word `message` leaves a
 * genuine declaration gone wrong on the default message.
 */
const ERROR_DECL_RULE_NAME = 'ErrorDecl';
const STRING_TOKEN_NAME = 'STRING';
const ERROR_DECL_KEYWORD = 'error';
const ERROR_DECL_FIELD_WORD = 'message';

/**
 * Langium's generated Chevrotain rules carry an internal trailing zero-width
 * space on `ruleName` (`withRuleSuffix` in `langium-parser.ts`) so rule names
 * never collide with reserved JavaScript identifiers; strip it before
 * comparing against a plain grammar rule name like `'ErrorDecl'`.
 */
function bareRuleName(ruleName: string): string {
  return ruleName.replace(/\u200b+$/, '');
}

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
   * A reserved word where exactly `ID` was expected (e.g. a step name) gets
   * reserved-word guidance; otherwise the default mismatched-token message.
   */
  override buildMismatchTokenMessage(options: MismatchTokenOptions): string {
    const { expected, actual, previous, ruleName } = options;
    if (
      actual.tokenType.name === VAR_KEYWORD_TOKEN_NAME &&
      expected.name === CLOSE_BRACE_TOKEN_NAME
    ) {
      return this.varPlacementMessage();
    }
    if (
      bareRuleName(ruleName) === ERROR_DECL_RULE_NAME &&
      expected.name === STRING_TOKEN_NAME &&
      previous.image !== ERROR_DECL_KEYWORD &&
      previous.image !== ERROR_DECL_FIELD_WORD
    ) {
      return this.declarationOrStepMessage(previous.image);
    }
    if (
      expected.name === ID_TOKEN_NAME &&
      this.isReservedWord(actual.tokenType.name)
    ) {
      return this.reservedWordMessage(actual.image);
    }
    return super.buildMismatchTokenMessage(options);
  }

  /**
   * Guidance for a `var` declaration written after the first statement. Variable
   * declarations are header-only, so a misplaced one otherwise produces a
   * confusing "expecting '}'" cascade. Free of BPMN vocabulary (ADR-0013).
   */
  private varPlacementMessage(): string {
    return (
      "A variable declaration ('var …') must come before the first step in the " +
      'process, with the other declarations. Move it above the first statement.'
    );
  }

  /**
   * Guidance for a mistyped statement keyword in the process-header region
   * (e.g. `usr Review` meaning `user Review`). Free of BPMN vocabulary
   * (ADR-0013).
   */
  private declarationOrStepMessage(word: string): string {
    return (
      `'${word}' is neither a known declaration nor a step keyword. ` +
      'The only declaration that starts with a plain word is ' +
      `'error "CODE" message "…"'; every step starts with a keyword such as ` +
      "'start', 'user', 'service', 'if', 'on', 'throw', 'emit', …"
    );
  }

  /**
   * A reserved word in a position where `ID` is one of several alternatives
   * (expression position) gets reserved-word guidance; otherwise the default
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
   * The actionable message: names the word and shows the quoted `"${...}"`
   * raw-string form to use instead. Free of BPMN vocabulary (ADR-0013).
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
   * `actual.tokenType.name` for a keyword token. Operators (`&&`, `+`, `{`)
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
