/**
 * Scoping + reserved-word-guidance test suite for BPMNscript.
 *
 * Two concerns are exercised here, both driven through the real parser/linker
 * pipeline (`parseHelper`, with `{ validation: true }` where cross-reference
 * linking must run):
 *
 *   - **Process-scoped `goto`** (custom `ScopeProvider`): a `goto` resolves to
 *     any named step of its *own* process — including one nested inside a
 *     `parallel`/`if`/`while` block — and to no step of any *other* process.
 *   - **Reserved-word guidance** (custom `ParserErrorMessageProvider`): a
 *     reserved keyword used as a bare identifier yields a parse error that names
 *     the word and points to the quoted `"${…}"` raw-string fallback, instead of
 *     a raw Chevrotain "expected ID" / "no viable alternative" message.
 *
 * Diagnostic severity follows the LSP convention: `1 = Error`, `2 = Warning`.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type { GotoStatement, Model, UserTask } from '@bpmn-script/language';
import { createBpmnScriptServices, isProcess } from '@bpmn-script/language';

const SEVERITY_ERROR = 1;

let services: ReturnType<typeof createBpmnScriptServices>;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ── Process-scoped goto resolution ──────────────────────────────────────────

describe('Scoping — process-scoped goto', () => {
  test('a same-process goto to a top-level step still resolves', async () => {
    const document = await parse(`process p { user Foo goto Foo }`, {
      validation: true,
    });
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const goto = findGoto(document.parseResult.value);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('Foo');

    // A same-process, non-parallel target is a clean resolve — no errors.
    expect(errorsOf(document)).toHaveLength(0);
  });

  test('a goto resolves to a step nested inside a parallel branch of the same process', async () => {
    // The stock (block-lexical) scope makes a step nested in a `parallel` branch
    // invisible to an outside goto, so this resolves ONLY through the process-
    // scoped provider. (The goto-into-parallel VALIDATOR then fires — see the
    // validator suite — but resolution itself is the concern here.)
    const document = await parse(
      `
process p {
  parallel {
    { user A }
    { user B }
  }
  goto A
}
`,
      { validation: true },
    );
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const goto = findGoto(document.parseResult.value);
    expect(goto.target.ref).toBeDefined();
    expect((goto.target.ref as UserTask).name).toBe('A');
  });

  test('a goto does not resolve to a same-named step in another process', async () => {
    const document = await parse(
      `
process a { user Foo goto Only }
process b { user Only }
`,
      { validation: true },
    );
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const goto = findGoto(document.parseResult.value);
    // `Only` exists only in process `b`; process-scoped goto cannot reach it.
    expect(goto.target.ref).toBeUndefined();

    const linkerErrors = errorsOf(document).filter((d) =>
      d.message.includes("'Only'"),
    );
    expect(linkerErrors).toHaveLength(1);
  });

  test('a goto resolves within its own process when the name also exists elsewhere', async () => {
    const document = await parse(
      `
process a { user Dup goto Dup }
process b { user Dup }
`,
      { validation: true },
    );
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const model = document.parseResult.value;
    const processA = model.processes[0]!;
    const goto = findGoto(model);
    expect(goto.target.ref).toBeDefined();
    // The resolved target must live inside process `a`, not the same-named `b`.
    expect(AstUtils.getContainerOfType(goto.target.ref!, isProcess)).toBe(
      processA,
    );
  });

  test('a goto to a name that exists in no process is unresolved (one linker error)', async () => {
    const document = await parse(`process p { user Foo goto Missing }`, {
      validation: true,
    });
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const goto = findGoto(document.parseResult.value);
    expect(goto.target.ref).toBeUndefined();
    const linkerErrors = errorsOf(document).filter((d) =>
      d.message.includes('Missing'),
    );
    expect(linkerErrors).toHaveLength(1);
  });
});

// ── Reserved-word guidance ──────────────────────────────────────────────────

describe('Scoping — reserved-word guidance', () => {
  test('a reserved word in expression position points to the raw-string fallback', async () => {
    // A reserved word inside a condition is a Chevrotain
    // no-viable-alternative error; the provider enriches it either way.
    const document = await parse(
      `process p { if (date > deadline) { user A } }`,
    );
    const message = parserErrorText(document);

    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
    expect(message).toContain('date');
    expect(message.toLowerCase()).toContain('reserved');
    // Points to the quoted "${…}" raw-string fallback for the offending name.
    expect(message).toContain('"${date}"');
  });

  test('a reserved word in a name position points to the raw-string fallback', async () => {
    // `user <name>` expects exactly ID → a Chevrotain mismatched-token error.
    const document = await parse(`process p { user date }`);
    const message = parserErrorText(document);

    expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
    expect(message).toContain('date');
    expect(message.toLowerCase()).toContain('reserved');
    expect(message).toContain('"${date}"');
  });

  test('a non-keyword identifier in the same expression position parses cleanly', async () => {
    const document = await parse(
      `process p { if (status > deadline) { user A } }`,
    );
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The (assumed single) `GotoStatement` anywhere in the parsed model. */
function findGoto(model: Model): GotoStatement {
  const goto = AstUtils.streamAst(model).find(
    (node): node is GotoStatement => node.$type === 'GotoStatement',
  );
  if (!goto) {
    throw new Error('Test fixture must contain exactly one goto statement.');
  }
  return goto;
}

/** All error-severity diagnostics of a built document. */
function errorsOf(document: {
  diagnostics?: Array<{ severity?: number; message: string }>;
}) {
  return (document.diagnostics ?? []).filter(
    (d) => d.severity === SEVERITY_ERROR,
  );
}

/** All parser-error messages of a document, joined for substring assertions. */
function parserErrorText(document: {
  parseResult: { parserErrors: Array<{ message: string }> };
}): string {
  return document.parseResult.parserErrors.map((e) => e.message).join('\n');
}
