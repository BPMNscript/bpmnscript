/**
 * Plain wording in place of Chevrotain's token-type lists; recovery is
 * unchanged. A reserved word arrives as a token mismatch where the grammar
 * expects `ID` and as no viable alternative where `ID` is one choice, so both
 * are overridden.
 */

import {
  DefaultLexerErrorMessageProvider,
  LangiumParserErrorMessageProvider,
  type LangiumCoreServices,
} from 'langium';

import {
  DECLARED_CODE_TRIGGERS,
  diagnosticText,
  ELSE_FAIL_WORD,
  formatPlainWordList,
  formatWordList,
  IO_DIRECTIONS,
  reservedWordsOf,
} from './vocabulary.js';

const ID_TOKEN_NAME = 'ID';
const EOF_TOKEN_NAME = 'EOF';
const ELSE_KEYWORD = 'else';

const STEP_KEYWORD_NOTE =
  'note: every step starts with a keyword such as ' +
  "'start', 'user', 'service', 'if', 'on', 'throw', or 'emit'";

/** What each terminal means to an author; a keyword token is named after its text. */
const TERMINAL_NOUNS: Readonly<Record<string, string>> = {
  ID: 'a name',
  INT: 'a number',
  DECIMAL: 'a number',
  STRING: 'a quoted string',
  RAW_TEMPLATE: 'a "${...}" expression',
  QUOTED_NAME: 'a name',
  FENCED_SCRIPT: 'a fenced script',
  EOF: 'the end of the file',
};

/** These three starting the alternatives mean any value fits. */
const VALUE_START_TOKENS = ['ID', 'INT', 'STRING'];

/** More choices than this read as noise, so the message names the found token instead. */
const MAX_LISTED_CHOICES = 4;

const WORD_SHAPED = /^[A-Za-z_]/;

/** Langium suffixes every Chevrotain rule name with a zero-width space. */
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
type EarlyExitOptions = Parameters<
  LangiumParserErrorMessageProvider['buildEarlyExitMessage']
>[0];
type NotAllInputParsedOptions = Parameters<
  LangiumParserErrorMessageProvider['buildNotAllInputParsedMessage']
>[0];
type Token = MismatchTokenOptions['actual'];
type TokenType = MismatchTokenOptions['expected'];

function tokenNoun(tokenName: string): string {
  return TERMINAL_NOUNS[tokenName] ?? `'${tokenName.replace(/:KW$/, '')}'`;
}

/** A token spanning lines, such as a fenced script, is named by its kind so the headline stays one line. */
function tokenPhrase(token: Token): string {
  return token.image.includes('\n')
    ? tokenNoun(token.tokenType.name)
    : `'${token.image}'`;
}

function foundPhrase(token: Token | undefined): string {
  return token === undefined || token.tokenType.name === EOF_TOKEN_NAME
    ? 'the end of the file'
    : tokenPhrase(token);
}

/** Chevrotain hands a placeholder with an empty image when nothing came before. */
function afterPhrase(previous: Token | undefined): string {
  return previous?.image ? ` after ${tokenPhrase(previous)}` : '';
}

/** The first token of every path, described once each. */
function choiceNouns(paths: readonly (readonly TokenType[])[]): string[] {
  const names = [
    ...new Set(paths.flatMap((path) => (path[0] ? [path[0].name] : []))),
  ];
  if (VALUE_START_TOKENS.every((name) => names.includes(name))) {
    return ['a value'];
  }
  return [...new Set(names.map(tokenNoun))];
}

function expectedOrUnexpected(
  paths: readonly (readonly TokenType[])[],
  actual: Token | undefined,
  previous: Token | undefined,
): string {
  const nouns = choiceNouns(paths);
  if (nouns.length > 0 && nouns.length <= MAX_LISTED_CHOICES) {
    return `expected ${formatPlainWordList(nouns)}${afterPhrase(previous)}`;
  }
  return `unexpected ${foundPhrase(actual)}${afterPhrase(previous)}`;
}

export class BpmnScriptParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
  private readonly services: LangiumCoreServices;

  constructor(services: LangiumCoreServices) {
    super();
    this.services = services;
  }

  override buildMismatchTokenMessage(options: MismatchTokenOptions): string {
    const { expected, actual } = options;
    const rule = bareRuleName(options.ruleName);
    if (expected.name === ')') {
      return diagnosticText(
        `expected ')' before ${foundPhrase(actual)}`,
        "note: a '(' is still open",
      );
    }
    // In a braced block a plain word opens a parameter
    // (`direction=ID name=ID '='`) and fails at its name slot or at its `=`,
    // where only the name is left to quote.
    if (expected.name === '=' && rule === 'IoParameter') {
      return diagnosticText(
        `expected '=' after '${options.previous.image}'`,
        "note: inside a block, two plain words start a parameter such as 'input name = value'",
        STEP_KEYWORD_NOTE,
      );
    }
    // A misplaced `var` or `for`, or a plain word after the first step, ends the
    // statement list early; at `EOF` the stock message would say "found ``".
    if (expected.name === '}') {
      const found = actual.tokenType.name;
      if (found === 'var') return VAR_PLACEMENT_MESSAGE;
      if (found === 'for') return REPEAT_CLAUSE_PLACEMENT_MESSAGE;
      if (found === EOF_TOKEN_NAME) return UNCLOSED_BLOCK_MESSAGE;
      if (found === ID_TOKEN_NAME && rule === 'Process') {
        return stepKeywordMessage(actual.image);
      }
    }
    if (expected.name === ID_TOKEN_NAME) {
      if (options.previous.image === ELSE_KEYWORD) return ELSE_FOLLOWER_MESSAGE;
      if (this.isReservedWord(actual.tokenType.name)) {
        return reservedWordMessage(actual.image);
      }
      const word = options.previous.image;
      // A mistyped statement keyword parses as a code declaration and fails at
      // the name slot.
      if (rule === 'CodeDecl' && !DECLARED_CODE_TRIGGERS.has(word)) {
        return declarationOrStepMessage(word);
      }
      if (rule === 'IoParameter' && !IO_DIRECTIONS.includes(word)) {
        return stepKeywordMessage(word);
      }
    }
    if (expected.name === EOF_TOKEN_NAME) {
      return outsideProcessMessage(actual);
    }
    return `expected ${tokenNoun(expected.name)}${afterPhrase(options.previous)}`;
  }

  override buildNoViableAltMessage(options: NoViableAltOptions): string {
    const actual = options.actual[0];
    if (options.previous.image === ELSE_KEYWORD) return ELSE_FOLLOWER_MESSAGE;
    const rule = bareRuleName(options.ruleName);
    // A `Name` is a choice of two tokens, so a bad one arrives as no viable
    // alternative inside it rather than as a mismatch in the rule holding it.
    // The only `Name` after a plain word is a code declaration's.
    const inName = rule === 'Name';
    if (
      actual &&
      this.isReservedWord(actual.tokenType.name) &&
      this.expectsIdentifier(options.expectedPathsPerAlt)
    ) {
      return inName
        ? reservedNameMessage(actual.image)
        : reservedWordMessage(actual.image);
    }
    const word = options.previous.image;
    if (
      rule === 'IoParameter' &&
      options.previous.tokenType.name === ID_TOKEN_NAME &&
      !IO_DIRECTIONS.includes(word)
    ) {
      return stepKeywordMessage(word);
    }
    if (
      inName &&
      options.previous.tokenType.name === ID_TOKEN_NAME &&
      !DECLARED_CODE_TRIGGERS.has(word)
    ) {
      return declarationOrStepMessage(word);
    }
    if (actual && WORD_SHAPED.test(actual.image)) {
      const words = this.keywordAlternatives(options.expectedPathsPerAlt);
      if (words) {
        return diagnosticText(
          `'${actual.image}' is not a word this position takes`,
          `help: write ${formatWordList(words)}`,
        );
      }
    }
    return expectedOrUnexpected(
      options.expectedPathsPerAlt.flat(),
      actual,
      options.previous,
    );
  }

  override buildEarlyExitMessage(options: EarlyExitOptions): string {
    return expectedOrUnexpected(
      options.expectedIterationPaths,
      options.actual[0],
      options.previous,
    );
  }

  override buildNotAllInputParsedMessage(
    options: NotAllInputParsedOptions,
  ): string {
    return outsideProcessMessage(options.firstRedundant);
  }

  /** `undefined` unless every alternative is a single keyword. */
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

const VAR_PLACEMENT_MESSAGE = diagnosticText(
  "a variable declaration ('var ...') comes after the first step",
  'note: declarations come before the first step of the process',
  'help: move it above the first statement',
);

const REPEAT_CLAUSE_PLACEMENT_MESSAGE = diagnosticText(
  "a repeat clause ('for ...') follows a statement that does not take one",
  'note: a repeat clause attaches to the step that repeats',
  'help: move the clause onto the step that should repeat',
);

// Only `fail` follows `else` as a word, so a keyword there is no misspelt name.
const ELSE_FOLLOWER_MESSAGE = `expected '{' or '${ELSE_FAIL_WORD}' after '${ELSE_KEYWORD}'`;

const UNCLOSED_BLOCK_MESSAGE = diagnosticText(
  "expected '}' before the end of the file",
  'note: a block is still open',
);

function outsideProcessMessage(token: Token): string {
  return `unexpected ${foundPhrase(token)} outside any process`;
}

function stepKeywordMessage(word: string): string {
  return diagnosticText(`'${word}' is not a step keyword`, STEP_KEYWORD_NOTE);
}

function declarationOrStepMessage(word: string): string {
  return diagnosticText(
    `'${word}' is neither a known declaration nor a step keyword`,
    `note: a declaration starting with a plain word is ${formatWordList([...DECLARED_CODE_TRIGGERS])} followed by the name it declares`,
    STEP_KEYWORD_NOTE,
  );
}

function reservedNameMessage(word: string): string {
  return diagnosticText(
    `'${word}' is a reserved word and cannot be a plain name here`,
    `help: to use '${word}' as the name, write it in backticks as '\`${word}\`'`,
  );
}

function reservedWordMessage(word: string): string {
  return diagnosticText(
    `'${word}' is a reserved word and cannot be a plain name here`,
    `help: to refer to a variable named '${word}', write the quoted raw expression "\${${word}}"`,
  );
}

/** Chevrotain's own wording quotes the character between arrows and adds offsets. */
export class BpmnScriptLexerErrorMessageProvider extends DefaultLexerErrorMessageProvider {
  override buildUnexpectedCharactersMessage(
    fullText: string,
    startOffset: number,
    length: number,
  ): string {
    const text = fullText.substring(startOffset, startOffset + length);
    return `unexpected ${length === 1 ? 'character' : 'characters'} '${text}'`;
  }
}
