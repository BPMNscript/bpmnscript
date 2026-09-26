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
 * One place a variable is declared: the AST node and the property holding
 * its name, so a rename can find the name's own leaf. A catch binding's site
 * is the `VarRef` its setting carries, under `ref`.
 */
export interface DeclaringSite {
  node: AstNode;
  property: string;
  name: string;
  type: VarType;
}

/** Injected as `references.VariableSymbolProvider`. */
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

/**
 * Whether `node` carries a repeat clause. Only the count and the collection
 * decide it: `sequential` is `false` on every repeatable statement, written or
 * not, so its value says nothing about whether a clause was written.
 */
export function isRepeated(node: AstNode): node is AstNode & RepeatSlots {
  return (
    ('cardinality' in node && node.cardinality !== undefined) ||
    ('collection' in node && node.collection !== undefined)
  );
}

/**
 * Every declaring site of the process, in precedence order: a header `var`,
 * then a form field, then a catch binding, then an `input`/`output`
 * parameter and a repeated statement's element in source order. A type
 * disagreement between two sites of one name is the validator's job.
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
      // A setting whose value is not a plain name reads a variable rather
      // than declaring one, so it seeds nothing.
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
      // A field names a property of the delegate the element binds, set as
      // that object is built, and a property is text handed to Tasklist or
      // a worker, so neither declares anything the process can read.
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
    // The first site of a name wins, so the table's type follows the
    // precedence `declaringSites` lists in.
    for (const site of this.declaringSites(process)) {
      if (!table.has(site.name)) {
        table.set(site.name, { name: site.name, type: site.type });
      }
    }
    // Seeded last, so an author who declares one of these names keeps its
    // type. A count alone (`for 3`) sets them too, so this is not read off
    // the sites.
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
