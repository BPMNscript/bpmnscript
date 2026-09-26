// The validator and completion suites both drive off these rows, so a new
// element kind is added in one place.

import { ENGINE_KEYS, type EngineKey } from '@bpmn-script/language';

export const FENCE = '`' + '`' + '`';

const VALID_ENGINE_VALUE: Readonly<Record<EngineKey, string>> = {
  asyncBefore: 'true',
  asyncAfter: 'true',
  exclusive: 'false',
  jobPriority: '50',
  retryCycle: '"R3/PT10M"',
};

export const engineItems = (
  keys: readonly EngineKey[],
  keyOf: (key: string) => string = (key) => key,
): string =>
  keys.map((key) => `${keyOf(key)}: ${VALID_ENGINE_VALUE[key]}`).join(', ');

export const ENGINE_SETTINGS = engineItems(ENGINE_KEYS);

/**
 * One otherwise-valid program per element kind with its parens (`settings`) or
 * member block (`members`) open. Both take non-empty contents: empty parens do
 * not parse, and an empty brace block reads as the body.
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

/** No handler: a boundary event carries no parameters, and `BpmnParse.checkActivityInputOutputSupported` refuses them on an event sub-process. */
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
]);

export const FORM_HOSTS = new Set(['start', 'user']);

/** The kinds taking `taskPriority`, `property` and `error ... when`, each only beside `topic`. */
export const EXTERNAL_HOSTS = new Set(['service', 'send', 'decide']);

/** The rest lower to a BPMN node with no name slot, which would drop a label. */
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

/** Every program writes its element on the first line, so the caret's line is zero. */
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
