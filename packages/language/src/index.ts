export * from './bpmn-script-module.js';
export { FLAG_WORD_RULE, SETTING_KEY_RULE } from './bpmn-script-completion.js';
export * from './bpmn-script-validator.js';
export * from './expression-render.js';
export * from './variable-symbol-provider.js';
export * from './paren-items.js';
export * from './vocabulary.js';
export { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
export * from './generated/ast.js';
export * from './generated/grammar.js';
export * from './generated/module.js';
// Not `export *`: the scope provider's `FlowContainer` clashes with the IR's.
export {
  isNamedStatement,
  type NamedStatement,
} from './bpmn-script-scope-provider.js';
