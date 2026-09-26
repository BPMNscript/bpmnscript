/**
 * Variables live in a flat process scope: a `var` declared anywhere is visible
 * from every expression in the process, whatever the source order.
 */

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

/**
 * One place a variable is declared, as the node and the property holding its
 * name so a rename finds the name's own leaf. A catch binding's site is the
 * `VarRef` its setting carries, under `ref`.
 */
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

/** The repeat-clause slots read here, off whichever statement carries them. */
interface RepeatSlots {
  cardinality?: unknown;
  collection?: unknown;
  element?: string;
}

/** `sequential` is `false` on every repeatable statement, written or not, so only the count and the collection say a clause was written. */
export function isRepeated(node: AstNode): node is AstNode & RepeatSlots {
  return (
    ('cardinality' in node && node.cardinality !== undefined) ||
    ('collection' in node && node.collection !== undefined)
  );
}

/**
 * Every declaring site, in precedence order: a header `var`, a form field, a
 * catch binding, then an `input`/`output` parameter or a repeated statement's
 * element in source order. A type disagreement between two sites of one name
 * is the validator's job.
 */
export function declaringSites(process: Process): DeclaringSite[] {
  const sites: DeclaringSite[] = [];
  for (const decl of process.decls) {
    if (isVarDecl(decl)) {
      sites.push({
        node: decl,
        property: 'name',
        name: decl.name,
        type: decl.type,
      });
    }
  }
  for (const node of AstUtils.streamAst(process)) {
    if (!isStartEvent(node) && !isUserTask(node)) continue;
    for (const form of node.forms) {
      for (const field of form.fields) {
        const type = formFieldVariableType(field.type);
        if (type !== undefined) {
          sites.push({ node: field, property: 'id', name: field.id, type });
        }
      }
    }
  }
  // A catch binding declares a `string`: the code or message text it caught.
  for (const node of AstUtils.streamAst(process)) {
    if (!isOnHandler(node)) continue;
    for (const { variable, node: setting } of caughtBindingsOf(node.items)) {
      if (variable === undefined) continue;
      sites.push({
        node: setting.value,
        property: 'ref',
        name: variable,
        type: 'string',
      });
    }
  }
  // Both hold whatever was mapped or collected, so their type is open.
  for (const node of AstUtils.streamAst(process)) {
    if (isIoParameter(node)) {
      // A field is set on the bound delegate and a property is text for
      // Tasklist or a worker; neither is a process variable.
      if (
        node.direction !== FIELD_DIRECTION &&
        node.direction !== PROPERTY_DIRECTION
      ) {
        sites.push({ node, property: 'name', name: node.name, type: 'any' });
      }
    } else if (isRepeated(node) && node.element !== undefined) {
      sites.push({
        node,
        property: 'element',
        name: node.element,
        type: 'any',
      });
    }
  }
  return sites;
}

export class DefaultVariableSymbolProvider implements VariableSymbolProvider {
  declaringSites(process: Process): DeclaringSite[] {
    return declaringSites(process);
  }

  collect(process: Process): VariableTable {
    const table: VariableTable = new Map();
    // The first site of a name wins, in the order `declaringSites` lists.
    for (const site of this.declaringSites(process)) {
      if (!table.has(site.name)) {
        table.set(site.name, { name: site.name, type: site.type });
      }
    }
    // Seeded last, so a declared name of the same spelling keeps its type. A
    // count alone (`for 3`) sets them too, so this is not read off the sites.
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
