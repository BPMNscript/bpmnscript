/**
 * The element kinds that take settings, as test fixtures.
 *
 * The validator suite checks what an element accepts and the completion suite
 * checks what it offers, which are two readings of one table. Both drive off
 * these rows, so a new kind is added in one place.
 */

/**
 * A triple-backtick fence, assembled without a literal fence in the test source
 * so it can be interpolated into JS template-literal DSL fixtures.
 */
export const FENCE = '`' + '`' + '`';

/** Every engine execution setting, as one parens' worth of items. */
export const ENGINE_SETTINGS =
  'asyncBefore: true, asyncAfter: true, exclusive: false, ' +
  'jobPriority: 50, retryCycle: "R3/PT10M"';

/**
 * One otherwise-valid program per element kind, with one slot left open:
 * `settings` opens the parens and `members` the brace block holding the forms,
 * the parameters, and the listeners. Everything else in each program already
 * validates, so the only diagnostics a case can produce are the slot's own.
 *
 * Both slots take non-empty contents. Parens with nothing between them are a
 * parse error, and an empty brace block is read as the body on the kinds that
 * take one.
 */
export const BLOCK_HOSTS: ReadonlyArray<
  [
    kind: string,
    description: string,
    members: (contents: string) => string,
    settings: (items: string) => string,
  ]
> = [
  [
    'start',
    'a start event',
    (c) => `process p { start S { ${c} } }`,
    (i) => `process p { start S(${i}) }`,
  ],
  [
    'end',
    'an end event',
    (c) => `process p { start S end E { ${c} } }`,
    (i) => `process p { start S end E(${i}) }`,
  ],
  [
    'user',
    'a user task',
    (c) => `process p { user U { ${c} } }`,
    (i) => `process p { user U(${i}) }`,
  ],
  [
    'service',
    'a service task',
    (c) => `process p { service V(topic: "t") { ${c} } }`,
    (i) => `process p { service V(topic: "t", ${i}) }`,
  ],
  [
    'script',
    'a script task',
    (c) => `process p { script T { ${c} } ${FENCE}js\nwork()\n${FENCE} }`,
    (i) => `process p { script T(${i}) ${FENCE}js\nwork()\n${FENCE} }`,
  ],
  [
    'step',
    'a step',
    (c) => `process p { step T { ${c} } }`,
    (i) => `process p { step T(${i}) }`,
  ],
  [
    'send',
    'a send task',
    (c) => `process p { send N(class: "com.example.Send") { ${c} } }`,
    (i) => `process p { send N(class: "com.example.Send", ${i}) }`,
  ],
  [
    'receive',
    'a receive task',
    (c) => `process p { receive R { ${c} } }`,
    (i) => `process p { receive R(${i}) }`,
  ],
  [
    'decide',
    'a decision step',
    (c) => `process p { decide D(decision: "riskRating") { ${c} } }`,
    (i) => `process p { decide D(decision: "riskRating", ${i}) }`,
  ],
  [
    'subprocess',
    'a subprocess',
    (c) => `process p { subprocess S { ${c} } { user U } }`,
    (i) => `process p { subprocess S(${i}) { user U } }`,
  ],
  [
    'attempt',
    'an attempt block',
    (c) => `process p { attempt S { ${c} } { user U } }`,
    (i) => `process p { attempt S(${i}) { user U } }`,
  ],
  [
    'call',
    'a call',
    (c) => `process p { call C(process: "q") { ${c} } }`,
    (i) => `process p { call C(process: "q", ${i}) }`,
  ],
  [
    'throw',
    'a throw statement',
    (c) => `process p { start S throw message("Settled") { ${c} } }`,
    (i) => `process p { start S throw message("Settled", ${i}) }`,
  ],
  [
    'emit',
    'an emit statement',
    (c) => `process p { start S emit signal("Ready") { ${c} } }`,
    (i) => `process p { start S emit signal("Ready", ${i}) }`,
  ],
  [
    'await',
    'an awaited event',
    (c) => `process p { await message("M") { ${c} } }`,
    (i) => `process p { await message("M", ${i}) }`,
  ],
  [
    'on',
    'an event handler',
    (c) => `process p { start S on message("M") { ${c} } { end Failed } }`,
    (i) => `process p { start S on message("M", ${i}) { end Failed } }`,
  ],
  [
    'on-hosted',
    'an event handler',
    (c) => `process p { user U on U: message("M") { ${c} } { end Failed } }`,
    (i) => `process p { user U on U: message("M", ${i}) { end Failed } }`,
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
 * The element kinds whose parens take a `label`. The rest lower to a BPMN node
 * with no name slot of its own, so a label there would be dropped.
 */
export const LABEL_HOSTS = new Set([
  'start',
  'end',
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
]);

/**
 * A row's program with the caret placed in one of its slots, after `before`.
 * Every program writes its element on the first line, so the caret's line is
 * always zero.
 */
export function caretInSlot(
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
