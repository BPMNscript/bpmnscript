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

  test('an `external` snippet pre-scaffolds the required `topic` attribute', async () => {
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'external',
    );
    expect(inserted(item!)).toContain('topic =');
  });

  test('a `script` snippet scaffolds a fenced block with a language choice', async () => {
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'script',
    );
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
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'subprocess',
    );
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('${1:id}');
    expect(text).toContain('{');
    expect(text).toContain('}');
  });

  test('`call` is offered as a snippet that scaffolds `process`/`in`/`out`', async () => {
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'call',
    );
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
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'on',
    );
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const text = inserted(item!)!;
    expect(text).toContain('${1|error,escalation|}');
    expect(text).toContain('{');
    expect(text).toContain('}');
  });

  test('`throw` scaffolds a trigger/code choice', async () => {
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'throw',
    );
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('${1|error,escalation|}');
  });

  test('`emit` scaffolds only the escalation code (its only continuing kind)', async () => {
    const item = (await completionItems('process p {\n  \n}', 1, 2)).find(
      (i) => i.label === 'emit',
    );
    expect(item?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(inserted(item!)).toContain('escalation');
  });
});

describe('event-layer ID-position completion (soft trigger/field words)', () => {
  test('`error` and `escalation` are offered at the `on` trigger position', async () => {
    const line = '  on ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(expect.arrayContaining(['error', 'escalation']));
  });

  test('`error` and `escalation` are offered at the `throw` trigger position', async () => {
    const line = '  throw ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(expect.arrayContaining(['error', 'escalation']));
  });

  test('only `escalation` is offered at the `emit` trigger position', async () => {
    const line = '  emit ';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toContain('escalation');
    expect(labels).not.toContain('error');
  });

  test('`code` and `message` are offered inside a handler binding parameter list', async () => {
    const line = '  on error "X" (';
    const labels = await labelsAt(`process p {\n${line}\n}`, 1, line.length);
    expect(labels).toEqual(expect.arrayContaining(['code', 'message']));
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
