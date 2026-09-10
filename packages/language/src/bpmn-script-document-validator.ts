/**
 * Drops the link failures that were never meant to resolve.
 *
 * Every identifier in every expression is a cross-reference to a code
 * declaration, because nothing in the parens tells `error(OUT_OF_STOCK)` from
 * `condition(ready)`. A code position is the only one whose scope holds
 * anything, so `if (amount > 100)` fails to link by design and the
 * undeclared-variable warning stays the only diagnostic its author sees.
 *
 * This is the seam because the two earlier ones cannot be. `Linker` can only
 * reword: `createLinkingError` returns the error, `doLink` stores it on the
 * reference and lists the reference regardless. Skipping that push instead
 * would suppress the diagnostic and leave a stale `_ref` behind, since
 * `document.references` is the list `unlink()` walks to reset lazily-resolved
 * references between builds.
 */

import {
  DefaultDocumentValidator,
  type AstNode,
  type LangiumDocument,
  type ValidationOptions,
} from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import { isVarRef } from './generated/ast.js';
import { isCodePosition } from './paren-items.js';

/**
 * A `goto` target and a handler host are reported as they always were: only an
 * identifier written outside a code position is one the author never asked to
 * resolve.
 */
function isExpectedToResolve(source: AstNode): boolean {
  return !isVarRef(source) || isCodePosition(source);
}

export class BpmnScriptDocumentValidator extends DefaultDocumentValidator {
  protected override processLinkingErrors(
    document: LangiumDocument,
    diagnostics: Diagnostic[],
    options: ValidationOptions,
  ): void {
    // A view over the document rather than a copy of it: `textDocument` is a
    // lazy getter, and spreading would build the whole TextDocument to
    // validate one reference list.
    const reported: LangiumDocument = Object.create(document, {
      references: {
        value: document.references.filter(
          (reference) =>
            reference.error === undefined ||
            isExpectedToResolve(reference.error.info.container),
        ),
      },
    });
    super.processLinkingErrors(reported, diagnostics, options);
  }
}
