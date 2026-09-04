/**
 * Variables live in a flat process scope with position-independent visibility:
 * a `var` declared anywhere in a process is visible from every expression in
 * it, whatever the source order.
 */

import { AstUtils, type AstNode } from 'langium';
import type { Process, VarType } from './generated/ast.js';
import {
  isIoParameter,
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

/** The repeat-clause slots read here, off whichever statement carries them. */
interface RepeatSlots {
  cardinality?: unknown;
  collection?: unknown;
  element?: string;
}

/**
 * Whether `node` carries a repeat clause. Only the count and the collection
 * decide it: `sequential` is `false` on every repeatable statement, written or
 * not, so its value says nothing about whether a clause was written at all.
 */
export function isRepeated(node: AstNode): node is AstNode & RepeatSlots {
  return (
    ('cardinality' in node && node.cardinality !== undefined) ||
    ('collection' in node && node.collection !== undefined)
  );
}

/**
 * The variables Operaton sets around a repeated step: three counters on the
 * repetition as a whole and `loopCounter` on each run of it
 * (`MultiInstanceActivityBehavior`). They exist without being declared, so a
 * process that repeats anything gets them in scope.
 */
const LOOP_VARIABLES = [
  'nrOfInstances',
  'nrOfActiveInstances',
  'nrOfCompletedInstances',
  'loopCounter',
] as const;

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
    // Seeded last, so an author who declares one of these names keeps its type.
    // A parameter mapping and a bound element both hold whatever was mapped or
    // collected, so their type is open.
    const seedOpen = (name: string | undefined): void => {
      if (name !== undefined && !table.has(name)) {
        table.set(name, { name, type: 'any' });
      }
    };
    let repeats = false;
    for (const node of AstUtils.streamAst(process)) {
      if (isIoParameter(node)) {
        seedOpen(node.name);
        continue;
      }
      if (!isRepeated(node)) continue;
      repeats = true;
      seedOpen(node.element);
    }
    if (repeats) {
      for (const name of LOOP_VARIABLES) {
        if (!table.has(name)) {
          table.set(name, { name, type: 'number' });
        }
      }
    }
    return table;
  }
}
