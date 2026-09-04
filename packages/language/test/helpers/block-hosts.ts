/**
 * The element kinds that take an attribute block, as test fixtures.
 *
 * The validator suite checks what a block accepts and the completion suite
 * checks what it offers, which are two readings of one table. Both drive off
 * these rows, so a new block-bearing kind is added in one place.
 */

/**
 * A triple-backtick fence, assembled without a literal fence in the test source
 * so it can be interpolated into JS template-literal DSL fixtures.
 */
export const FENCE = '`' + '`' + '`';

/** Every engine execution setting, in one block's worth of source. */
export const ENGINE_SETTINGS =
  'asyncBefore = true asyncAfter = true exclusive = false ' +
  'jobPriority = 50 retryCycle = "R3/PT10M"';

/**
 * One otherwise-valid program per element kind that takes an attribute block,
 * with the block's contents left open. Everything else in each program already
 * validates, so the only diagnostics a case can produce are the block's own.
 */
export const BLOCK_HOSTS: ReadonlyArray<
  [kind: string, description: string, program: (contents: string) => string]
> = [
  ['start', 'a start event', (c) => `process p { start S { ${c} } }`],
  ['end', 'an end event', (c) => `process p { start S end E { ${c} } }`],
  ['user', 'a user task', (c) => `process p { user U { ${c} } }`],
  [
    'service',
    'a service task',
    (c) => `process p { service V { topic = "t" ${c} } }`,
  ],
  [
    'script',
    'a script task',
    (c) => `process p { script T { ${c} } ${FENCE}js\nwork()\n${FENCE} }`,
  ],
  ['step', 'a step', (c) => `process p { step T { ${c} } }`],
  [
    'send',
    'a send task',
    (c) => `process p { send N { class = "com.example.Send" ${c} } }`,
  ],
  ['receive', 'a receive task', (c) => `process p { receive R { ${c} } }`],
  [
    'decide',
    'a decision step',
    (c) => `process p { decide D { decision = "riskRating" ${c} } }`,
  ],
  [
    'subprocess',
    'a subprocess',
    (c) => `process p { subprocess S { ${c} } { user U } }`,
  ],
  [
    'attempt',
    'an attempt block',
    (c) => `process p { attempt S { ${c} } { user U } }`,
  ],
  ['call', 'a call', (c) => `process p { call C { process = "q" ${c} } }`],
  [
    'throw',
    'a throw statement',
    (c) => `process p { start S throw error "E409" { ${c} } }`,
  ],
  [
    'emit',
    'an emit statement',
    (c) => `process p { start S emit signal "Ready" { ${c} } }`,
  ],
  [
    'await',
    'an awaited event',
    (c) => `process p { await message "M" { ${c} } }`,
  ],
  [
    'on',
    'an event handler',
    (c) => `process p { start S on error { ${c} } { end Failed } }`,
  ],
  [
    'on-hosted',
    'an event handler',
    (c) => `process p { user U on U: error { ${c} } { end Failed } }`,
  ],
];

/**
 * The element kinds whose block carries `input`/`output` parameters. A
 * host-less `on` handler is in the set because it lowers to an event
 * sub-process; the hosted form lowers to a boundary event and is not.
 */
export const PARAMETER_HOSTS = new Set([
  'user',
  'service',
  'script',
  'step',
  'send',
  'receive',
  'decide',
  'subprocess',
  'attempt',
  'call',
  'on',
]);

/** The element kinds whose block carries a `form` declaration. */
export const FORM_HOSTS = new Set(['start', 'user']);

/**
 * A row's program with the caret placed inside the attribute block, after
 * `before`. Every program writes its block on the first line, so the caret's
 * line is always zero.
 *
 * An empty block is ambiguous where the element takes a second one: the parser
 * reads `subprocess S { │ }` as the body rather than the attributes, so pass a
 * `before` that commits the block to being the attribute block.
 */
export function caretInBlock(
  program: (contents: string) => string,
  before: string,
): { text: string; line: number; character: number } {
  const text = program(before);
  const longer = program(`${before}!`);
  let character = 0;
  while (text[character] === longer[character]) {
    character += 1;
  }
  return { text, line: 0, character };
}
