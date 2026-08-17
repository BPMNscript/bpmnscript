/**
 * Completion test suite for the BPMNscript language server.
 *
 * The default Langium completion inserts bare keywords, which leaves the caret
 * at e.g. `process│`, a position the grammar continues with an id then `{`,
 * where nothing is suggestible. The custom completion provider instead emits
 * LSP *snippet* items for the structural keywords so accepting one scaffolds
 * the whole construct (braces included) and drops the caret inside the body.
 *
 * These tests drive the real `CompletionProvider` through the shared services
 * (so the DI wiring is exercised too) and assert both *what* is offered and
 * that structural constructs come back as snippets, while non-structural
 * keywords still fall through to plain keyword completion.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, URI } from 'langium';
import {
  type CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from 'vscode-languageserver-types';
import {
  type BpmnScriptServices,
  createBpmnScriptServices,
} from '@bpmn-script/language';

let services: BpmnScriptServices;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem).BpmnScript;
});

async function completionItems(
  text: string,
  line: number,
  character: number,
): Promise<CompletionItem[]> {
  const factory = services.shared.workspace.LangiumDocumentFactory;
  const documents = services.shared.workspace.LangiumDocuments;
  const uri = URI.parse('file:///completion.bpmnscript');
  if (documents.hasDocument(uri)) {
    documents.deleteDocument(uri);
  }
  const document = factory.fromString(text, uri);
  documents.addDocument(document);
  await services.shared.workspace.DocumentBuilder.build([document]);
  const result = await services.lsp.CompletionProvider!.getCompletion(
    document,
    {
      textDocument: { uri: uri.toString() },
      position: { line, character },
    },
  );
  return result?.items ?? [];
}

/** The completion item labelled `label` at the given caret position. */
async function itemAt(
  text: string,
  line: number,
  character: number,
  label: string,
) {
  return (await completionItems(text, line, character)).find(
    (i) => i.label === label,
  );
}

async function labelsAt(
  text: string,
  line: number,
  character: number,
): Promise<string[]> {
  return (await completionItems(text, line, character)).map((i) => i.label);
}

/** The text an LSP client would actually insert (textEdit wins over insertText). */
function inserted(item: CompletionItem): string | undefined {
  if (item.textEdit && 'newText' in item.textEdit) {
    return item.textEdit.newText;
  }
  return item.insertText;
}

describe('structural keyword snippets', () => {
  test('`process` is offered as a snippet that scaffolds a brace body', async () => {
    const process = await itemAt('pro', 0, 3, 'process');
    expect(process).toBeDefined();
    expect(process!.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(process!)!;
    expect(text).toContain('{');
    expect(text).toContain('}');
    expect(text).toContain('${1:name}');
  });

  test('`if` scaffolds both the condition parens and the brace body', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'if');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('(');
    expect(text).toContain('{');
  });

  test('`parallel` scaffolds two branch blocks', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'parallel');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toMatch(
      /\{[\s\S]*\{[\s\S]*\}[\s\S]*\{[\s\S]*\}[\s\S]*\}/,
    );
  });

  test('a `service` snippet pre-scaffolds the required `class` attribute', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'service');
    expect(inserted(item!)).toContain('class =');
  });

  test('a `topic` attribute snippet is offered inside a `service` attribute block', async () => {
    const item = (
      await completionItems('process p {\n  service s {\n    \n  }\n}', 2, 4)
    ).find((i) => i.label === 'topic');
    expect(inserted(item!)).toContain('topic =');
  });

  test('a `script` snippet scaffolds a fenced block with a language choice', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'script');
    const text = inserted(item!)!;
    expect(text).toContain('```');
    expect(text).toContain('${2|javascript,groovy,python,ruby,feel|}');
  });

  test('a `delegate` attribute snippet is offered inside an attribute block', async () => {
    const item = (
      await completionItems('process p {\n  service s {\n    \n  }\n}', 2, 4)
    ).find((i) => i.label === 'delegate');
    const text = inserted(item!)!;
    expect(text).toContain('delegate =');
    // The `\$` escape must survive into the inserted text, or the default
    // reads as an empty/nested snippet placeholder instead of a literal EL
    // expression.
    expect(text).toContain('${beanName}');
  });

  test('an `expression` attribute snippet is offered inside an attribute block', async () => {
    const item = (
      await completionItems('process p {\n  service s {\n    \n  }\n}', 2, 4)
    ).find((i) => i.label === 'expression');
    const text = inserted(item!)!;
    expect(text).toContain('expression =');
    expect(text).toContain('${bean.method(execution)}');
  });

  test('the full body keyword set is still offered', async () => {
    const labels = await labelsAt('process p {\n  \n}', 1, 2);
    expect(labels).toEqual(
      expect.arrayContaining([
        'start',
        'end',
        'user',
        'service',
        'if',
        'while',
        'do',
        'parallel',
        'subprocess',
        'goto',
      ]),
    );
  });

  test('`subprocess` is offered as a snippet that scaffolds a brace body', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'subprocess');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('${1:id}');
    expect(text).toContain('{');
    expect(text).toContain('}');
  });

  test('`call` is offered as a snippet that scaffolds `process`/`in`/`out`', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'call');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('process =');
    expect(text).toContain('in ');
    expect(text).toContain('out ');
    // The detail reads as the function-call analogy, not BPMN vocabulary.
    expect(item!.detail).toMatch(/function/i);
  });

  test('`binding` is offered as a choice snippet inside a call block', async () => {
    const item = (
      await completionItems('process p {\n  call C {\n    \n  }\n}', 2, 4)
    ).find((i) => i.label === 'binding');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('binding =');
    expect(text).toContain('${1|latest,deployment|}');
  });

  test('a `businessKey` attribute snippet keeps the EL escape literal', async () => {
    const item = (
      await completionItems('process p {\n  call C {\n    \n  }\n}', 2, 4)
    ).find((i) => i.label === 'businessKey');
    const text = inserted(item!)!;
    expect(text).toContain('businessKey =');
    expect(text).toContain('${execution.processBusinessKey}');
  });
});

describe('event-layer structure snippets', () => {
  test('`on` scaffolds a trigger/code choice and a brace body', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'on');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('${1|error,escalation,message,signal|}');
    expect(text).toContain('{');
    expect(text).toContain('}');
  });

  test('`throw` scaffolds a trigger/code choice', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'throw');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('${1|error,escalation,signal|}');
  });

  test('`emit` scaffolds an escalation/signal choice (its two continuing kinds)', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'emit');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('${1|escalation,signal|}');
  });
});

describe('event-layer ID-position completion (soft trigger/field words)', () => {
  test('all six trigger words are offered at the `on` trigger position', async () => {
    const line = '  on ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(
      expect.arrayContaining([
        'error',
        'escalation',
        'message',
        'signal',
        'timer',
        'condition',
      ]),
    );
  });

  test('accepting the `timer` item at the `on` trigger position inserts the particle scaffold', async () => {
    const line = '  on ';
    const item = (
      await completionItems(`process p {\n${line}\n}`, 1, line.length)
    ).find((i) => i.label === 'timer');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('after "${1:PT1H}"');
  });

  test('accepting the `condition` item at the `on` trigger position inserts the parenthesized scaffold', async () => {
    const line = '  on ';
    const item = (
      await completionItems(`process p {\n${line}\n}`, 1, line.length)
    ).find((i) => i.label === 'condition');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('condition ($1)');
  });

  test('`error`, `escalation`, and `signal` are offered at the `throw` trigger position', async () => {
    const line = '  throw ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(
      expect.arrayContaining(['error', 'escalation', 'signal']),
    );
  });

  test('`escalation` and `signal` (not `error`) are offered at the `emit` trigger position', async () => {
    const line = '  emit ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toContain('escalation');
    expect(labels).toContain('signal');
    expect(labels).not.toContain('error');
  });

  test('`code` and `message` are offered inside a handler binding parameter list', async () => {
    const line = '  on error "X" (';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(expect.arrayContaining(['code', 'message']));
  });

  test('`after`, `at`, and `every` are offered at the timer particle position', async () => {
    const line = '  on timer ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(expect.arrayContaining(['after', 'at', 'every']));
  });

  test('`compensation` is offered at the `on` trigger position with the undo-block detail', async () => {
    const line = '  on ';
    const item = (
      await completionItems(`process p {\n${line}\n}`, 1, line.length)
    ).find((i) => i.label === 'compensation');
    expect(item).toBeDefined();
    expect(item!.kind).toBe(CompletionItemKind.Keyword);
    expect(item!.detail).toContain('undo block of this subprocess');
  });

  test('`compensation` is offered at the `throw` trigger position, framed as ending the path', async () => {
    const line = '  throw ';
    const item = (
      await completionItems(`process p {\n${line}\n}`, 1, line.length)
    ).find((i) => i.label === 'compensation');
    expect(item).toBeDefined();
    expect(item!.detail).toContain('then end this path');
  });

  test('`compensation` is offered at the `emit` trigger position, framed as continuing', async () => {
    const line = '  emit ';
    const item = (
      await completionItems(`process p {\n${line}\n}`, 1, line.length)
    ).find((i) => i.label === 'compensation');
    expect(item).toBeDefined();
    expect(item!.detail).toContain('then continue');
  });

  test('the `on` keyword snippet choice list does not offer `compensation`', async () => {
    const item = await itemAt('process p {\n  \n}', 1, 2, 'on');
    expect(inserted(item!)).not.toContain('compensation');
  });
});

describe('event-layer ID-position completion (await trigger words)', () => {
  test('exactly the four catch triggers are offered at the `await` trigger position, not error/escalation/compensation', async () => {
    const line = '  await ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(
      expect.arrayContaining(['message', 'timer', 'signal', 'condition']),
    );
    expect(labels).not.toContain('error');
    expect(labels).not.toContain('escalation');
    expect(labels).not.toContain('compensation');
  });

  test('`after`, `at`, and `every` are offered at the `await timer` particle position', async () => {
    const line = '  await timer ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(expect.arrayContaining(['after', 'at', 'every']));
  });
});

describe('the host slot on a handler attached to an activity', () => {
  test("the host position offers the container's activity names and nothing from another scope", async () => {
    // `Decoy` (another process) and `Inner` (a nested subprocess body) are both
    // named statements the scope must keep out. A presence-only assertion would
    // pass even if every named step in the file leaked in.
    const text =
      'process p {\n  user Review\n  service Ship\n  subprocess Sub {\n    user Inner\n  }\n  on \n}\nprocess q { user Decoy }';
    // Line 6 is `  on `, right after the keyword: the host slot.
    const labels = await labelsAt(text, 6, '  on '.length);
    expect(labels).toEqual(expect.arrayContaining(['Review', 'Ship']));
    expect(labels).not.toContain('Decoy');
    expect(labels).not.toContain('Inner');
  });

  test('the position after the colon offers the seven trigger items, exactly as the host-less position does', async () => {
    const text = 'process p {\n  user Review\n  on Review: \n}';
    const line = '  on Review: ';
    const labels = await labelsAt(text, 2, line.length);
    expect(labels).toEqual(
      expect.arrayContaining([
        'error',
        'escalation',
        'message',
        'signal',
        'timer',
        'condition',
        'compensation',
      ]),
    );
  });

  test('accepting `timer` after the colon still inserts the particle scaffold', async () => {
    const text = 'process p {\n  user Review\n  on Review: \n}';
    const line = '  on Review: ';
    const item = await itemAt(text, 2, line.length, 'timer');
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('after "${1:PT1H}"');
  });
});

describe('non-structural keywords fall through', () => {
  test('`VarType` literals stay plain keyword completions, not snippets', async () => {
    // After `var x:` the grammar expects a VarType; those keywords are not snippets.
    const string = await itemAt('process p {\n  var x: \n}', 1, 9, 'string');
    expect(string).toBeDefined();
    expect(string!.insertTextFormat).not.toBe(InsertTextFormat.Snippet);
  });
});
