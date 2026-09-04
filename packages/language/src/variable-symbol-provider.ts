/**
 * Variables live in a flat process scope with position-independent visibility:
 * a `var` declared anywhere in a process is visible from every expression in
 * it, whatever the source order.
 */

import { AstUtils } from 'langium';
import type { Process, VarType } from './generated/ast.js';
import {
  isOnHandler,
  isVarDecl,
  isStartEvent,
  isUserTask,
} from './generated/ast.js';

export interface VariableSymbol {
  name: string;
  type: VarType;
}

export type VariableTable = Map<string, VariableSymbol>;

/** Injected as `references.VariableSymbolProvider`. */
export interface VariableSymbolProvider {
  collect(process: Process): VariableTable;
}

export class DefaultVariableSymbolProvider implements VariableSymbolProvider {
  collect(process: Process): VariableTable {
    const table: VariableTable = new Map();
    // Precedence, held by the `has` guards below: a header `var` beats a form
    // field, which beats a catch binding.
    for (const decl of process.decls) {
      if (isVarDecl(decl)) {
        table.set(decl.name, { name: decl.name, type: decl.type });
      }
    }
    // A type disagreement between two declarations is the validator's job.
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
    // A catch binding declares a `string`: the code or message text it caught.
    for (const node of AstUtils.streamAst(process)) {
      if (!isOnHandler(node)) continue;
      for (const binding of node.bindings) {
        if (!table.has(binding.variable)) {
          table.set(binding.variable, {
            name: binding.variable,
            type: 'string',
          });
        }
      }
    }
    return table;
  }
}
