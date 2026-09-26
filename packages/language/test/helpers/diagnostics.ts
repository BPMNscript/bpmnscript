// LSP 3.18 lets a diagnostic message be markup; ours are all plain strings.

import { Diagnostic } from 'vscode-languageserver-types';

export type TextDiagnostic = Omit<Diagnostic, 'message'> & { message: string };

export function withTextMessages(
  diagnostics: readonly Diagnostic[],
): TextDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: Diagnostic.getMessageString(diagnostic),
  }));
}

export const UNREACHABLE =
  'This step can never run: an earlier `end`, `throw`, `goto`, `emit link`, ' +
  'or an all-terminating `if`/`parallel`/`await` in the same block always ' +
  'ends or redirects the flow before reaching it, so this step would lower ' +
  'to a disconnected node with no incoming flow, which is invalid BPMN.';

export const undeclaredVariable = (name: string): string =>
  `Variable '${name}' is not declared. Add 'var ${name}: <type>' to the process.`;
