/** A `var` declared anywhere is visible from every expression in the process. */

import { AstUtils, type AstNode } from 'langium';
import type { Process, VarType } from './generated/ast.js';
import { caughtBindingsOf } from './paren-items.js';
import {
  FIELD_DIRECTION,
  formFieldVariableType,
  LOOP_VARIABLES,
  PROPERTY_DIRECTION,
} from './vocabulary.js';
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

/** Node and property so a rename finds the name's own leaf. */
export interface DeclaringSite {
  node: AstNode;
  property: string;
  name: string;
  type: VarType;
}

export interface VariableSymbolProvider {
  collect(process: Process): VariableTable;
  declaringSites(process: Process): DeclaringSite[];
}

interface RepeatSlots {
  cardinality?: unknown;
  collection?: unknown;
  element?: string;
}

/** `sequential` is `false` whether written or not, so only the count and collection tell. */
export function isRepeated(node: AstNode): node is AstNode & RepeatSlots {
  return (
    ('cardinality' in node && node.cardinality !== undefined) ||
    ('collection' in node && node.collection !== undefined)
  );
}

/**
 * In precedence order: `var`, form field, catch binding, then parameters and
 * repeat elements in source order.
 */
export function declaringSites(process: Process): DeclaringSite[] {
  const declared: DeclaringSite[] = [];
  for (const decl of process.decls) {
    if (isVarDecl(decl)) {
      declared.push({
        node: decl,
        property: 'name',
        name: decl.name,
        type: decl.type,
      });
    }
  }
  const formFields: DeclaringSite[] = [];
  const catchBindings: DeclaringSite[] = [];
  const mapped: DeclaringSite[] = [];
  for (const node of AstUtils.streamAst(process)) {
    if (isStartEvent(node) || isUserTask(node)) {
      for (const form of node.forms) {
        for (const field of form.fields) {
          const type = formFieldVariableType(field.type);
          if (type !== undefined) {
            formFields.push({
              node: field,
              property: 'id',
              name: field.id,
              type,
            });
          }
        }
      }
    } else if (isOnHandler(node)) {
      for (const { variable, node: setting } of caughtBindingsOf(node.items)) {
        if (variable === undefined) continue;
        catchBindings.push({
          node: setting.value,
          property: 'ref',
          name: variable,
          type: 'string',
        });
      }
    }
    if (isIoParameter(node)) {
      // A field or property is not a process variable.
      if (
        node.direction !== FIELD_DIRECTION &&
        node.direction !== PROPERTY_DIRECTION
      ) {
        mapped.push({ node, property: 'name', name: node.name, type: 'any' });
      }
    } else if (isRepeated(node) && node.element !== undefined) {
      mapped.push({
        node,
        property: 'element',
        name: node.element,
        type: 'any',
      });
    }
  }
  return [...declared, ...formFields, ...catchBindings, ...mapped];
}

export class DefaultVariableSymbolProvider implements VariableSymbolProvider {
  declaringSites(process: Process): DeclaringSite[] {
    return declaringSites(process);
  }

  collect(process: Process): VariableTable {
    const table: VariableTable = new Map();
    for (const site of this.declaringSites(process)) {
      if (!table.has(site.name)) {
        table.set(site.name, { name: site.name, type: site.type });
      }
    }
    // Seeded last so a declared name keeps its type; `for 3` sets them too, so
    // not read off the sites.
    if (AstUtils.streamAst(process).some(isRepeated)) {
      for (const name of LOOP_VARIABLES) {
        if (!table.has(name)) {
          table.set(name, { name, type: 'number' });
        }
      }
    }
    return table;
  }
}
