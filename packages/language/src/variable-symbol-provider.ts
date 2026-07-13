/**
 * Variable symbol collection for BPMNscript.
 *
 * Variables live in a **flat process scope** with **position-independent
 * visibility**: a `var` declared anywhere in a process is visible from every
 * expression in that process, regardless of source order. This service turns a
 * {@link Process} AST into a {@link VariableTable} (declared variable names →
 * their declared {@link VarType}) that the validators consult to decide whether
 * a referenced variable is declared and whether it is used compatibly with an
 * operator.
 *
 * There are two symbol sources: the explicit `var name: type` declarations, and
 * the `form { … }` fields on start events and user tasks (a field binds the
 * process variable named by its id).
 */

import { AstUtils } from 'langium';
import type { Process, VarType } from './generated/ast.js';
import { isVarDecl, isStartEvent, isUserTask } from './generated/ast.js';

/**
 * A resolved variable: its declared name and its declared type.
 */
export interface VariableSymbol {
  /** The variable identifier as written in the source (`var <name>: …`). */
  name: string;
  /** The declared Operaton-aligned variable type. */
  type: VarType;
}

/**
 * The set of variables visible within a process, keyed by name.
 */
export type VariableTable = Map<string, VariableSymbol>;

/**
 * Collects the variables visible within a process.
 *
 * Registered as an injectable language service (`references.VariableSymbolProvider`
 * in the language module) so validators resolve it through dependency injection.
 */
export interface VariableSymbolProvider {
  /**
   * Build the flat, position-independent variable table for `process`.
   *
   * @param process The process to collect variables for.
   * @returns A table mapping each visible variable name to its symbol.
   */
  collect(process: Process): VariableTable;
}

/**
 * Default {@link VariableSymbolProvider}: the explicit `var` declarations plus
 * the `form { … }` fields of a process.
 */
export class DefaultVariableSymbolProvider implements VariableSymbolProvider {
  collect(process: Process): VariableTable {
    const table: VariableTable = new Map();
    // Explicit `var name: type` declarations live in `process.decls`.
    for (const decl of process.decls) {
      if (isVarDecl(decl)) {
        table.set(decl.name, { name: decl.name, type: decl.type });
      }
    }
    // Form fields (on start events and user tasks, at any nesting depth) each
    // declare the process variable they bind. An explicit `var` of the same name
    // keeps precedence in the table; a type disagreement is reported separately
    // by the validator.
    for (const node of AstUtils.streamAst(process)) {
      if (!isStartEvent(node) && !isUserTask(node)) continue;
      for (const form of node.forms) {
        for (const field of form.fields) {
          if (!table.has(field.id)) {
            table.set(field.id, { name: field.id, type: field.type });
          }
        }
      }
    }
    return table;
  }
}
