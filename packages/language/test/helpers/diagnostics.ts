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

// ── Messages shared by more than one suite, spelled once ───────────────────

export const UNREACHABLE =
  'This step can never run: an earlier `end`, `throw`, `goto`, `emit link`, ' +
  'or an all-terminating `if`/`parallel`/`await` in the same block always ' +
  'ends or redirects the flow before reaching it, so this step would lower ' +
  'to a disconnected node with no incoming flow, which is invalid BPMN.';

export const undeclaredVariable = (name: string): string =>
  `Variable '${name}' is not declared. Add 'var ${name}: <type>' to the process.`;
