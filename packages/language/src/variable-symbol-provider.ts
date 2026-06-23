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
 * The collection is an **injectable service** rather than an inline helper so
 * validators resolve it through dependency injection. Today it has exactly one
 * symbol source — the explicit `var name: type` declarations.
 */

import type { Process, VarType } from './generated/ast.js';
import { isVarDecl } from './generated/ast.js';

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
 *
 * A `Map` (not a plain object) so iteration order is insertion order and lookup
 * is O(1).
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
 * Default {@link VariableSymbolProvider}: the explicit `var` declarations in a
 * process.
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
    // TODO: extend here when a second variable source exists (e.g. output mappings)
    return table;
  }
}
