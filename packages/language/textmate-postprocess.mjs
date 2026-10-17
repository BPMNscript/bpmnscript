// Runs after `langium generate`; `langium:watch` regenerates the unpatched
// file until the next full build, which also goes through this script.
//
// langium-cli's TextMate generator writes the keyword alternation as
// `\b(...)\b`, and `-` is a word boundary in that class, so a hyphenated name
// (`invoice-start`, `end-of-day`) colours only the part that collides with a
// keyword. It also emits no scope for numbers or expression operators, and
// none for a name in backticks, whose text would colour as a keyword.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GRAMMAR_PATH = fileURLToPath(
  new URL('./syntaxes/bpmn-script.tmLanguage.json', import.meta.url),
);

/** The shape langium-cli generates: `\b(...)\b`. */
const WORD_BOUNDARY = /^\\b\((.*)\)\\b$/;
/** The shape this script leaves behind, so a second run is a no-op. */
const PATCHED_BOUNDARY = /^\(\?<!\[\\w-\]\)\(.*\)\(\?!\[\\w-\]\)$/;

const NUMERIC_PATTERN = {
  name: 'constant.numeric.bpmn-script',
  match: String.raw`(?<![\w-])[0-9]+(\.[0-9]+)?(?![\w-])`,
};

/**
 * `-` is excluded when it follows a word character or another hyphen: that is
 * the same position the `ID` terminal treats as inside an identifier, so
 * `count-2` colours neither `-` nor the digit it sits before.
 */
const OPERATOR_PATTERN = {
  name: 'keyword.operator.bpmn-script',
  match: String.raw`\|\||&&|==|!=|<=|>=|<|>|\+|\*|\/|%|!|\?|(?<![\w-])-`,
};

/**
 * The `QUOTED_NAME` terminal, kept off a fence's backticks. It goes before the
 * keyword pattern, so a keyword in backticks colours as a name.
 */
const QUOTED_NAME_PATTERN = {
  name: 'entity.name.bpmn-script',
  match: String.raw`(?<!\`)\`(\\.|[^\`\\\r\n])+\`(?!\`)`,
};

/**
 * `fail` is a soft word, legal as a variable name, but after `else` it can
 * only be the fallback that stops the run. It goes before the keyword pattern,
 * which would otherwise take `else` alone. The word is `ELSE_FAIL_WORD` in
 * `vocabulary.ts`; a test pins the two together.
 */
const ELSE_FAIL_PATTERN = {
  match: String.raw`(?<![\w-])(else)\s+(fail)(?![\w-])`,
  captures: {
    1: { name: 'keyword.control.bpmn-script' },
    2: { name: 'keyword.control.bpmn-script' },
  },
};

const grammar = JSON.parse(readFileSync(GRAMMAR_PATH, 'utf8'));

const keywordPattern = grammar.patterns.find((pattern) =>
  pattern.name?.startsWith('keyword.control'),
);
if (!keywordPattern?.match) {
  throw new Error(
    'No keyword.control pattern in the generated TextMate grammar.',
  );
}
const boundary = keywordPattern.match.match(WORD_BOUNDARY);
if (boundary) {
  keywordPattern.match = `(?<![\\w-])(${boundary[1]})(?![\\w-])`;
} else if (!PATCHED_BOUNDARY.test(keywordPattern.match)) {
  throw new Error(
    `Unexpected keyword.control pattern shape: ${keywordPattern.match}`,
  );
}

if (
  !grammar.patterns.some((pattern) => pattern.match === ELSE_FAIL_PATTERN.match)
) {
  grammar.patterns.splice(
    grammar.patterns.indexOf(keywordPattern),
    0,
    ELSE_FAIL_PATTERN,
  );
}
if (
  !grammar.patterns.some((pattern) => pattern.name === QUOTED_NAME_PATTERN.name)
) {
  grammar.patterns.splice(
    grammar.patterns.indexOf(keywordPattern),
    0,
    QUOTED_NAME_PATTERN,
  );
}
if (
  !grammar.patterns.some((pattern) => pattern.name === NUMERIC_PATTERN.name)
) {
  grammar.patterns.push(NUMERIC_PATTERN);
}
if (
  !grammar.patterns.some((pattern) => pattern.name === OPERATOR_PATTERN.name)
) {
  grammar.patterns.push(OPERATOR_PATTERN);
}

writeFileSync(GRAMMAR_PATH, `${JSON.stringify(grammar, null, 2)}\n`);
