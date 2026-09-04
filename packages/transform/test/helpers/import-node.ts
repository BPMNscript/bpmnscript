/**
 * Import a BPMN XML fixture and pick one node out of the resulting IR, keeping
 * the warnings alongside it. An extension-import fixture needs both halves:
 * what was read onto the node, and what the read reported as dropped.
 */

import { expect } from 'vitest';

import { xmlToIr } from '../../src/xml-to-ir.js';
import type { ImportWarning } from '../../src/xml-to-ir.js';
import type { FlowElement } from '../../src/ir/types.js';
import { byId, only } from './ir-query.js';

interface Imported<K extends FlowElement['kind']> {
  node: Extract<FlowElement, { kind: K }>;
  warnings: ImportWarning[];
}

/** The single imported node of a kind, asserting the process holds one. */
export async function importOnly<K extends FlowElement['kind']>(
  xml: string,
  kind: K,
): Promise<Imported<K>> {
  const { ir, warnings } = await xmlToIr(xml);
  return { node: only(ir, kind), warnings };
}

/** The imported node with this id, asserting it imported as `kind`. */
export async function importById<K extends FlowElement['kind']>(
  xml: string,
  id: string,
  kind: K,
): Promise<Imported<K>> {
  const { ir, warnings } = await xmlToIr(xml);
  const node = byId(ir, id);
  expect(node.kind).toBe(kind);
  return { node: node as Extract<FlowElement, { kind: K }>, warnings };
}
