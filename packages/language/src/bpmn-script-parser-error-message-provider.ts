/**
 * Reserved-word guidance for parse errors: a reserved grammar keyword (`date`,
 * `class`, `if`, ...) written where the parser expects a plain identifier gets
 * a message naming the word and pointing at the quoted `"${...}"` raw-string
 * fallback. Two Chevrotain paths reach that mistake, so both are overridden:
 * `buildMismatchTokenMessage` where the grammar expects exactly `ID` (a step
 * name), and `buildNoViableAltMessage` in expression position, where `ID` is
 * one alternative among several. Every message here stays free of BPMN
 * vocabulary (ADR-0013).
 *
 * This only enriches the message Chevrotain already built; it cannot suppress
 * or restructure error recovery, nor change which token positions are legal.
 */

import {
  AstUtils,
  GrammarAST,
  LangiumParserErrorMessageProvider,
  type LangiumCoreServices,
} from 'langium';

const ID_TOKEN_NAME = 'ID';

/**
 * A `var` declaration is legal only in the process header, so anywhere else the
 * parser has finished the statement list and reports "expecting `}`, found
 * `var`". That exact pair is the misplacement, distinct from `var` used as a
 * name, which expects `ID` and takes the reserved-word path.
 */
const CLOSE_BRACE_TOKEN_NAME = '}';
const VAR_KEYWORD_TOKEN_NAME = 'var';

/**
 * Two declarations start with a plain `ID` rather than a keyword (`error "CODE"
 * message "..."` and `<key> = <value>`), so a mistyped statement keyword in the
 * header region (`usr Review`) starts neither. The parser then has no viable
 * `ProcessDecl` alternative and reports the raw expected-token list, which says
 * nothing about what the author got wrong.
 */
const PROCESS_DECL_RULE_NAME = 'ProcessDecl';

/**
 * Langium's generated Chevrotain rules carry a trailing zero-width space on
 * `ruleName` (`withRuleSuffix` in `langium-parser.ts`) so rule names never
 * collide with reserved JavaScript identifiers.
 */
function bareRuleName(ruleName: string): string {
  return ruleName.replace(/\u200b+$/, '');
}

/**
 * Derived from the base method signatures so the exact Chevrotain field shapes
 * are reused without naming the transitive `chevrotain` package.
 */
type MismatchTokenOptions = Parameters<
  LangiumParserErrorMessageProvider['buildMismatchTokenMessage']
>[0];
type NoViableAltOptions = Parameters<
  LangiumParserErrorMessageProvider['buildNoViableAltMessage']
>[0];

export class BpmnScriptParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
  private readonly services: LangiumCoreServices;
  private reservedWords?: ReadonlySet<string>;

  constructor(services: LangiumCoreServices) {
    super();
    this.services = services;
  }

  override buildMismatchTokenMessage(options: MismatchTokenOptions): string {
    const { expected, actual } = options;
    if (
      actual.tokenType.name === VAR_KEYWORD_TOKEN_NAME &&
      expected.name === CLOSE_BRACE_TOKEN_NAME
    ) {
      return this.varPlacementMessage();
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
      "A variable declaration ('var …') must come before the first step in the " +
      'process, with the other declarations. Move it above the first statement.'
    );
  }

  private declarationOrStepMessage(word: string): string {
    return (
      `'${word}' is neither a known declaration nor a step keyword. ` +
      'A declaration starting with a plain word is either a setting ' +
      `('<key> = <value>') or 'error "CODE" message "…"'; every step starts ` +
      "with a keyword such as 'start', 'user', 'service', 'if', 'on', 'throw', 'emit', …"
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
    return super.buildNoViableAltMessage(options);
  }

  private reservedWordMessage(word: string): string {
    const rawFallback = '"${' + word + '}"';
    return (
      `'${word}' is a reserved word and cannot be used as a plain name here. ` +
      `To refer to a variable named '${word}', write it as a quoted raw expression: ${rawFallback}.`
    );
  }

  private isReservedWord(tokenName: string): boolean {
    return this.getReservedWords().has(tokenName);
  }

  private expectsIdentifier(
    expectedPathsPerAlt: NoViableAltOptions['expectedPathsPerAlt'],
  ): boolean {
    return expectedPathsPerAlt.some((alt) =>
      alt.some((path) => path.some((token) => token.name === ID_TOKEN_NAME)),
    );
  }

  /**
   * Read out of the grammar itself so the set stays correct as keywords change.
   * A keyword's lexer token is named after its literal value, so these strings
   * match `actual.tokenType.name`. Operators (`&&`, `+`, `{`) are excluded:
   * they cannot be mistaken for an identifier.
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
