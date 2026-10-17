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
  'this step can never run\n' +
  "note: an earlier 'end', 'throw', 'goto', 'emit link', or an 'if', 'parallel', or 'await' whose every branch ends always ends or redirects the flow before it\n" +
  'note: the step would have no incoming flow, which is invalid BPMN';

export const undeclaredVariable = (name: string): string =>
  `variable '${name}' is not declared\nhelp: add 'var ${name}: <type>' to the process`;
