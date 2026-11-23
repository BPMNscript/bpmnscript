// Runs after `langium generate`, like textmate-postprocess.mjs.
//
// Monarch tokenizes one line at a time, so langium-cli's single-regex rule for
// FENCED_SCRIPT never matches a fence that spans lines: the body would colour
// as BPMNscript. A `fence` state carries it across lines instead. `fail` after
// `else` is the fallback keyword, not a name (ELSE_FAIL_WORD in vocabulary.ts),
// so it gets the same rule as in the TextMate grammar.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GRAMMAR_PATH = fileURLToPath(
  new URL('./syntaxes/bpmn-script.monarch.ts', import.meta.url),
);

const FENCE_RULE =
  '{ regex: /```[a-zA-Z]+[\\s\\S]*?```/, action: {"token":"FENCED_SCRIPT"} },';
const FENCE_OPEN =
  '{ regex: /```[a-zA-Z]+/, action: {"token":"FENCED_SCRIPT","next":"@fence"} },';
const FENCE_STATE = `fence: [
            { regex: /\`\`\`/, action: {"token":"FENCED_SCRIPT","next":"@pop"} },
            { regex: /[^\`]+/, action: {"token":"FENCED_SCRIPT"} },
            { regex: /\`/, action: {"token":"FENCED_SCRIPT"} },
        ],
        `;
const ELSE_FAIL_RULE =
  '{ regex: /(else)(\\s+)(fail)(?![\\w-])/, action: [{"token":"keyword"},{"token":"white"},{"token":"keyword"}] },';
const INITIAL = 'initial: [\n';
const WHITESPACE = 'whitespace: [';

let grammar = readFileSync(GRAMMAR_PATH, 'utf8');

if (!grammar.includes(FENCE_OPEN)) {
  if (!grammar.includes(FENCE_RULE) || !grammar.includes(WHITESPACE)) {
    throw new Error('Unexpected FENCED_SCRIPT rule in the Monarch grammar.');
  }
  grammar = grammar
    .replace(FENCE_RULE, FENCE_OPEN)
    .replace(WHITESPACE, FENCE_STATE + WHITESPACE);
}
if (!grammar.includes(ELSE_FAIL_RULE)) {
  if (!grammar.includes(INITIAL)) {
    throw new Error('No initial state in the Monarch grammar.');
  }
  grammar = grammar.replace(
    INITIAL,
    `${INITIAL}            ${ELSE_FAIL_RULE}\n`,
  );
}

writeFileSync(GRAMMAR_PATH, grammar);
