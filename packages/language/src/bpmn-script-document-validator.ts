/**
 * Drops the link failures that were never meant to resolve. Every identifier
 * in every expression is a cross-reference to a code declaration, and only a
 * code position has a scope, so `if (amount > 100)` fails to link by design
 * and the undeclared-variable warning stays the one diagnostic its author
 * sees. This is the seam because `Linker` can only reword: `doLink` stores
 * the error and lists the reference regardless, and skipping that push would
 * leave a stale `_ref` behind, since `document.references` is what `unlink()`
 * walks between builds.
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

/** Only an identifier outside a code position is one the author never asked to resolve. */
function isExpectedToResolve(source: AstNode): boolean {
  return !isVarRef(source) || isCodePosition(source);
}

export class BpmnScriptDocumentValidator extends DefaultDocumentValidator {
  protected override processLinkingErrors(
    document: LangiumDocument,
    diagnostics: Diagnostic[],
    options: ValidationOptions,
  ): void {
    // A view rather than a spread copy: `textDocument` is a lazy getter, and
    // spreading would build the whole TextDocument for one reference list.
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
