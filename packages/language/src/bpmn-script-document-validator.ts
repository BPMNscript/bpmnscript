/**
 * Drops the link failures of identifiers outside a code position, which never
 * resolve by design; the undeclared-variable warning speaks for them. Not the
 * linker: skipping the reference there would leave a stale `_ref` that
 * `unlink()` never walks.
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

function isExpectedToResolve(source: AstNode): boolean {
  return !isVarRef(source) || isCodePosition(source);
}

export class BpmnScriptDocumentValidator extends DefaultDocumentValidator {
  protected override processLinkingErrors(
    document: LangiumDocument,
    diagnostics: Diagnostic[],
    options: ValidationOptions,
  ): void {
    // Not a spread: `textDocument` is a lazy getter that would build the whole document.
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
