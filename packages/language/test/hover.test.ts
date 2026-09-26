/**
 * Hover content, driven through the real `HoverProvider` with
 * `expectHover` from `langium/test`.
 *
 * Langium's default hover resolves the caret to a declaration through
 * `References.findDeclarations` before `getAstNodeHoverContent` ever runs, so
 * a `goto` target, a handler's host, and a thrown or caught code exercise the
 * same content function as the name they resolve to, with no row for the
 * position itself.
 */

import { describe, test, beforeAll } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { expectHover } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';

let hover: ReturnType<typeof expectHover>;

beforeAll(() => {
  hover = expectHover(createBpmnScriptServices(EmptyFileSystem).BpmnScript);
});

/** A row of the table: a title, a program with one `<|>` caret, and the expected hover text (`undefined` for none). */
type Row = readonly [title: string, text: string, expected: string | undefined];

const ROWS: Row[] = [
  [
    "a named statement's own name shows its kind, name and label",
    'process p {\n  user <|>Review(label: "Review the invoice")\n}',
    "a user task 'Review': Review the invoice",
  ],
  [
    'a goto resolves to the same content as the name it targets',
    'process p {\n  user Review(label: "Review the invoice")\n  goto <|>Review\n}',
    "a user task 'Review': Review the invoice",
  ],
  [
    "a handler's host resolves the same way",
    'process p {\n  user Review(label: "Review the invoice")\n  on <|>Review: timer("PT1H") { end Late }\n}',
    "a user task 'Review': Review the invoice",
  ],
  [
    'a subprocess names itself a subprocess',
    'process p {\n  subprocess <|>Pack(label: "Pack the goods") { }\n}',
    "a subprocess 'Pack': Pack the goods",
  ],
  [
    'an attempt block names itself an attempt block, not a subprocess',
    'process p {\n  attempt <|>Pay(label: "Pay the invoice") { }\n}',
    "an attempt block 'Pay': Pay the invoice",
  ],
  [
    'a declared error shows its code kind, name and message',
    'process p {\n  error <|>E(message: "Payment failed")\n}',
    "an error 'E': Payment failed",
  ],
  [
    'a thrown code resolves to the same content as its declaration',
    'process p {\n  error E(message: "Payment failed")\n  throw error(<|>E)\n}',
    "an error 'E': Payment failed",
  ],
  [
    'a written code setting is quoted; the fallback to the name is not',
    'process p {\n  escalation <|>OVERSIZED(code: "big-parcel")\n}',
    'an escalation \'OVERSIZED\' with code "big-parcel"',
  ],
  [
    'a preceding doc comment is appended after the element line and a blank line',
    'process p {\n  /** doc */\n  user <|>Review\n}',
    "a user task 'Review'\n\ndoc",
  ],
  ['a keyword shows nothing', 'process p {\n  <|>user Review\n}', undefined],
  [
    'a trigger word shows nothing: it is soft, not a name or reference',
    'process p {\n  error E(message: "m")\n  on <|>error(E) { end Failed }\n}',
    undefined,
  ],
  [
    'a var use shows the name and its declared type',
    'process p {\n  var amount: number\n  if (<|>amount > 1) { end E }\n}',
    'amount: number',
  ],
  [
    'a form field use shows the type the field binds',
    'process p {\n  user U { form { customer: string } }\n  if (<|>customer == "x") { end E }\n}',
    'customer: string',
  ],
  [
    'a loop element use shows an open type',
    'process p {\n  var items: json\n  user U for each item in items { input x = <|>item.price }\n}',
    'item: any',
  ],
];

describe('hover', () => {
  test.each(ROWS)('%s', async (_title, text, expected) => {
    await hover({ text, index: 0, hover: expected });
  });
});
