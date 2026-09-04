/**
 * Diagnostics with the message read as text, shared by the suites that assert
 * on wording.
 *
 * LSP 3.18 allows a diagnostic to carry its message as markup instead of a
 * string, so `Diagnostic['message']` is a union. Everything the validator and
 * the linker raise is a plain string, and every assertion here reads the
 * message as text, so each suite flattens the union once where it collects
 * diagnostics rather than at every assertion.
 */

import { Diagnostic } from 'vscode-languageserver-types';

/** A diagnostic whose message is plain text. */
export type TextDiagnostic = Omit<Diagnostic, 'message'> & { message: string };

/** `diagnostics`, each with its message read as text. */
export function withTextMessages(
  diagnostics: readonly Diagnostic[],
): TextDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: Diagnostic.getMessageString(diagnostic),
  }));
}
