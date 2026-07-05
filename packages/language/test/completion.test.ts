/**
 * Completion test suite for the BPMNscript language server.
 *
 * The default Langium completion inserts bare keywords, which leaves the caret
 * at e.g. `process│` — a position the grammar continues with an id then `{`,
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
    const process = (await completionItems('pro', 0, 3)).find(
      (i) => i.label === 'process',
    );
    expect(process).toBeDefined();
    expect(process!.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(process!)!;
    expect(text).toContain('{');
    expect(text).toContain('}');
    expect(text).toContain('${1:name}');
  });

  test('`if` scaffolds both the condition parens and the brace body', async () => {
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'if',
    );
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('(');
    expect(text).toContain('{');
  });

  test('`parallel` scaffolds two branch blocks', async () => {
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'parallel',
    );
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toMatch(
      /\{[\s\S]*\{[\s\S]*\}[\s\S]*\{[\s\S]*\}[\s\S]*\}/,
    );
  });

  test('a `service` snippet pre-scaffolds the required `class` attribute', async () => {
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'service',
    );
    expect(inserted(item!)).toContain('class =');
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
        'goto',
      ]),
    );
  });
});

describe('non-structural keywords fall through', () => {
  test('`VarType` literals stay plain keyword completions, not snippets', async () => {
    // After `var x:` the grammar expects a VarType; those keywords are not snippets.
    const string = (
      await completionItems('process p {\n  var x: \n}', 1, 9)
    ).find((i) => i.label === 'string');
    expect(string).toBeDefined();
    expect(string!.insertTextFormat).not.toBe(InsertTextFormat.Snippet);
  });
});
