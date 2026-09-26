/**
 * Definition, references, rename and document highlight through the real LSP
 * providers. `langium/test` has no rename helper, so the rename rows drive
 * `RenameProvider` by hand and assert the whole document after the edits: a
 * rename that touched the declaration alone cannot pass on the text.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, TextDocument } from 'langium';
import {
  expectFindReferences,
  expectGoToDefinition,
  expectHighlight,
  parseHelper,
  replaceIndices,
} from 'langium/test';
import {
  createBpmnScriptServices,
  type BpmnScriptServices,
} from '@bpmn-script/language';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { withTextMessages } from './helpers/diagnostics.js';
import { formatParseFailure } from './helpers/parse-failure.js';

let services: BpmnScriptServices;
let parse: ReturnType<typeof parseHelper>;
let definition: ReturnType<typeof expectGoToDefinition>;
let references: ReturnType<typeof expectFindReferences>;
let highlight: ReturnType<typeof expectHighlight>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem).BpmnScript;
  parse = parseHelper(services);
  definition = expectGoToDefinition(services);
  references = expectFindReferences(services);
  highlight = expectHighlight(services);
});

const REFUSED = 'refused';

/**
 * The whole document after renaming the name under `<|>` to `newName`, or
 * `REFUSED` where `prepareRename` and `rename` both answer `undefined`.
 */
async function renamed(text: string, newName: string): Promise<string> {
  const { output, indices } = replaceIndices({ text });
  const document = await parse(output);
  const params = {
    textDocument: { uri: document.textDocument.uri },
    position: document.textDocument.positionAt(indices[0]!),
    newName,
  };
  const provider = services.lsp.RenameProvider!;
  const range = await provider.prepareRename(document, params);
  const edit = await provider.rename(document, params);
  if (range === undefined && edit === undefined) return REFUSED;
  const edits = edit?.changes?.[document.textDocument.uri] ?? [];
  return TextDocument.applyEdits(document.textDocument, edits);
}

type RenameRow = readonly [
  title: string,
  text: string,
  newName: string,
  after: string,
];

const RENAMES: RenameRow[] = [
  [
    'a var renamed at its declaration edits the two uses too',
    'process p {\n  var <|>amount: number\n  user U { input total = amount }\n  if (amount > 1) { end E }\n}',
    'sum',
    'process p {\n  var sum: number\n  user U { input total = sum }\n  if (sum > 1) { end E }\n}',
  ],
  [
    'a var renamed at a use edits the declaration and the other use',
    'process p {\n  var amount: number\n  user U { input total = amount }\n  if (<|>amount > 1) { end E }\n}',
    'sum',
    'process p {\n  var sum: number\n  user U { input total = sum }\n  if (sum > 1) { end E }\n}',
  ],
  [
    'a form field renamed at its id edits the condition reading it',
    'process p {\n  user U { form { <|>customer: string } }\n  if (customer == "x") { end E }\n}',
    'client',
    'process p {\n  user U { form { client: string } }\n  if (client == "x") { end E }\n}',
  ],
  [
    'a catch binding renamed edits the condition reading it',
    'process p {\n  error E\n  user U\n  on error(E, code: <|>c) { if (c == "X") { end Failed } }\n}',
    'reason',
    'process p {\n  error E\n  user U\n  on error(E, code: reason) { if (reason == "X") { end Failed } }\n}',
  ],
  [
    'a loop element renamed edits the accessor head in the body and leaves the collection alone',
    'process p {\n  var items: json\n  user U for each <|>item in items { input x = item.price }\n}',
    'line',
    'process p {\n  var items: json\n  user U for each line in items { input x = line.price }\n}',
  ],
  [
    'an input parameter renamed edits the later condition',
    'process p {\n  user U { input <|>total = 1 }\n  if (total > 1) { end E }\n}',
    'sum',
    'process p {\n  user U { input sum = 1 }\n  if (sum > 1) { end E }\n}',
  ],
  [
    'a name declared twice renames both declarations and the use',
    'process p {\n  var <|>flag: boolean\n  user U { form { flag: boolean } }\n  if (flag) { end E }\n}',
    'done',
    'process p {\n  var done: boolean\n  user U { form { done: boolean } }\n  if (done) { end E }\n}',
  ],
  [
    'an undeclared name is refused',
    'process p {\n  user U\n  if (<|>missing) { end E }\n}',
    'found',
    REFUSED,
  ],
  [
    'a loop counter is refused: the engine sets it, nothing declares it',
    'process p {\n  user U for 3\n  if (<|>loopCounter > 1) { end E }\n}',
    'n',
    REFUSED,
  ],
  [
    'an accessor segment is refused',
    'process p {\n  var order: json\n  if (order.<|>total > 1) { end E }\n}',
    'sum',
    REFUSED,
  ],
  [
    'an out mapping target is refused',
    'process p {\n  call C(process: "shipping") { out <|>trackingCode }\n}',
    'code',
    REFUSED,
  ],
  [
    'a word under a plain-text setting is refused',
    'process p {\n  call C(process: "shipping", binding: <|>latest)\n}',
    'newest',
    REFUSED,
  ],
  [
    'a step renamed at a goto edits the step, the goto and the host',
    'process p {\n  user Review\n  goto <|>Review\n  on Review: timer("PT1H") { end Late }\n}',
    'Check',
    'process p {\n  user Check\n  goto Check\n  on Check: timer("PT1H") { end Late }\n}',
  ],
  [
    'a code renamed at a throw edits the declaration, the throw, the handler and the mapping',
    'process p {\n  error E\n  service S(topic: "t") { error E when true }\n  throw error(<|>E)\n  on error(E) { end Failed }\n}',
    'Declined',
    'process p {\n  error Declined\n  service S(topic: "t") { error Declined when true }\n  throw error(Declined)\n  on error(Declined) { end Failed }\n}',
  ],
];

/** A program with one `<|>` caret and the `<|...|>` ranges the request answers with. */
type Row = readonly [title: string, text: string];

const DEFINITIONS: Row[] = [
  [
    'a var use goes to its declaration',
    'process p {\n  var <|amount|>: number\n  if (<|>amount > 1) { end E }\n}',
  ],
  [
    'a form field use goes to the field',
    'process p {\n  user U { form { <|customer|>: string } }\n  if (<|>customer == "x") { end E }\n}',
  ],
  [
    'a catch binding use goes to the binding',
    'process p {\n  error E\n  user U\n  on error(E, code: <|c|>) { if (<|>c == "X") { end Failed } }\n}',
  ],
  [
    'a loop element use goes to the element',
    'process p {\n  var items: json\n  user U for each <|item|> in items { input x = <|>item.price }\n}',
  ],
  [
    'an input parameter use goes to the parameter',
    'process p {\n  user U { input <|total|> = 1 }\n  if (<|>total > 1) { end E }\n}',
  ],
  [
    "a goto goes to the step's name",
    'process p {\n  user <|Review|>\n  goto <|>Review\n}',
  ],
  [
    "a host goes to the step's name",
    'process p {\n  user <|Review|>\n  on <|>Review: timer("PT1H") { end Late }\n}',
  ],
  [
    "a thrown code goes to the declaration's name",
    'process p {\n  error <|E|>\n  throw error(<|>E)\n}',
  ],
];

const VAR_SITES =
  'process p {\n  var <|amount|>: number\n  user U { input total = <|amount|> }\n  if (<|><|amount|> > 1) { end E }\n}';

const REFERENCES: Row[] = [
  ['a var lists its declaration and both uses', VAR_SITES],
  [
    'a form field lists the field and the use',
    'process p {\n  user U { form { <|customer|>: string } }\n  if (<|><|customer|> == "x") { end E }\n}',
  ],
  [
    'a catch binding lists the binding and the use',
    'process p {\n  error E\n  user U\n  on error(E, code: <|c|>) { if (<|><|c|> == "X") { end Failed } }\n}',
  ],
  [
    'a loop element lists the element and the accessor head, not the collection',
    'process p {\n  var items: json\n  user U for each <|item|> in items { input x = <|><|item|>.price }\n}',
  ],
  [
    'an input parameter lists the parameter and the use',
    'process p {\n  user U { input <|total|> = 1 }\n  if (<|><|total|> > 1) { end E }\n}',
  ],
  [
    'a step lists its name, the goto and the host',
    'process p {\n  user <|Review|>\n  goto <|><|Review|>\n  on <|Review|>: timer("PT1H") { end Late }\n}',
  ],
];

describe('rename', () => {
  test.each(RENAMES)('%s', async (_title, text, newName, after) => {
    expect(await renamed(text, newName)).toBe(after);
    if (after !== REFUSED) {
      const document = await parse(after, { validation: true });
      expect(formatParseFailure(document)).toBeUndefined();
      expect(
        withTextMessages(document.diagnostics ?? [])
          .filter((d) => d.severity === DiagnosticSeverity.Error)
          .map((d) => d.message),
      ).toEqual([]);
    }
  });
});

describe('definition', () => {
  test.each(DEFINITIONS)('%s', async (_title, text) => {
    await definition({ text, index: 0, rangeIndex: 0 });
  });
});

describe('references', () => {
  test.each(REFERENCES)('%s', async (_title, text) => {
    await references({ text, includeDeclaration: true });
  });
});

describe('document highlight', () => {
  test('a var highlights its declaration and both uses in document order', async () => {
    await highlight({ text: VAR_SITES, index: 0, rangeIndex: [0, 1, 2] });
  });
});
