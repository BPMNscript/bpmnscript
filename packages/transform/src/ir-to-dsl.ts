/**
 * IR → DSL pretty-printer.
 *
 * Converts an engine-agnostic {@link BpmnProcess} IR back into a `.bpmnscript`
 * source string that is re-parseable by the BpmnScript grammar and
 * re-convertible to an equivalent IR via the AST→IR transform.
 *
 * `irToDsl` is a normalizer, not a faithful reproducer of the original source:
 * node declarations are regrouped (starts, then ends, then the rest) and flows
 * are emitted in IR order, so DSL → IR → DSL is stable but need not match the
 * original text byte-for-byte. The round-trip contract is IR equivalence, not
 * text equality.
 *
 * Output conventions:
 *   - 2-space indentation.
 *   - LF line endings.
 *   - Trailing newline at EOF.
 *   - String literals (labels, assignee, formKey, class, condition) are
 *     quoted with double-quotes. The grammar's `STRING` terminal accepts
 *     both single- and double-quoted strings; we always emit double-quoted
 *     for consistency.
 *   - Condition expressions are emitted verbatim (literal `>`, no entity
 *     escaping). The grammar passes them through as opaque strings; the XML
 *     serializer is responsible for XML entity encoding.
 *
 * Node ordering inside the block:
 *   1. Start events.
 *   2. End events.
 *   3. All remaining nodes (user tasks, service tasks, gateways) in the
 *      order they appear in `process.flowElements`.
 *
 * Sequence flows are emitted after a blank separator line, in IR order.
 * A flow receives an `as: <id>` tag when a gateway in the process declares
 * that flow as its `defaultFlowId` — this is the only reason the DSL needs
 * to name a flow, so we emit the tag only when required.
 */

import type { BpmnProcess, FlowElement, SequenceFlow } from './ir/types.js';

const INDENT = '  ';

/**
 * Render an IR process as a `.bpmnscript` source string.
 *
 * @param process The IR process to pretty-print.
 * @returns A UTF-8 `.bpmnscript` source string with a trailing newline.
 */
export function irToDsl(process: BpmnProcess): string {
  const lines: string[] = [];

  // Collect the set of flow ids that gateways reference as their default so
  // we can emit `as: <id>` on those flows.
  const defaultFlowIds = collectDefaultFlowIds(process);

  // ── Process header ───────────────────────────────────────────────────────
  const header = buildProcessHeader(process);
  lines.push(header);

  // ── Flow nodes ──────────────────────────────────────────────────────────
  // Partition into starts, ends, and the rest — preserving intra-group order.
  const starts = process.flowElements.filter((n) => n.kind === 'startEvent');
  const ends = process.flowElements.filter((n) => n.kind === 'endEvent');
  const rest = process.flowElements.filter(
    (n) => n.kind !== 'startEvent' && n.kind !== 'endEvent',
  );

  for (const node of [...starts, ...ends, ...rest]) {
    lines.push(renderFlowNode(node));
  }

  // ── Blank separator between nodes and flows ──────────────────────────────
  lines.push('');

  // ── Sequence flows ───────────────────────────────────────────────────────
  for (const flow of process.sequenceFlows) {
    lines.push(renderSequenceFlow(flow, defaultFlowIds));
  }

  lines.push('}');

  // Join with LF and add the required trailing newline.
  return lines.join('\n') + '\n';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Collect the ids of every sequence flow that is referenced as a gateway
 * `defaultFlowId`. These flows must carry an `as: <id>` tag so the grammar's
 * cross-reference from `gateway ... default: <ID>` can resolve.
 */
function collectDefaultFlowIds(process: BpmnProcess): Set<string> {
  const ids = new Set<string>();
  for (const node of process.flowElements) {
    if (node.kind === 'exclusiveGateway' && node.defaultFlowId !== undefined) {
      ids.add(node.defaultFlowId);
    }
  }
  return ids;
}

/**
 * Build the `process <id> "<name>" {` opening line (label is omitted when
 * `process.name` is absent, giving `process <id> {`).
 */
function buildProcessHeader(process: BpmnProcess): string {
  if (process.name !== undefined) {
    return `process ${process.id} ${quote(process.name)} {`;
  }
  return `process ${process.id} {`;
}

/**
 * Render a single flow node as an indented DSL line.
 *
 * Only fields that are present in the IR are emitted — absent optional
 * fields produce no output (no empty quotes, no bare attribute keywords).
 */
function renderFlowNode(node: FlowElement): string {
  switch (node.kind) {
    case 'startEvent':
      return renderStart(node.id, node.name);

    case 'endEvent':
      return renderEnd(node.id, node.name);

    case 'userTask': {
      let line = `${INDENT}user ${node.id}`;
      if (node.name !== undefined) line += ` ${quote(node.name)}`;
      if (node.assignee !== undefined)
        line += ` assignee: ${quote(node.assignee)}`;
      if (node.formKey !== undefined)
        line += ` formKey: ${quote(node.formKey)}`;
      return line;
    }

    case 'serviceTask': {
      let line = `${INDENT}service ${node.id}`;
      if (node.name !== undefined) line += ` ${quote(node.name)}`;
      line += ` class: ${quote(node.javaClass)}`;
      return line;
    }

    case 'exclusiveGateway': {
      let line = `${INDENT}gateway ${node.id}`;
      if (node.name !== undefined) line += ` ${quote(node.name)}`;
      if (node.defaultFlowId !== undefined)
        line += ` default: ${node.defaultFlowId}`;
      return line;
    }

    default: {
      // Exhaustiveness guard.
      const exhaustive: never = node;
      throw new Error(
        `Unhandled FlowElement kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Render `start <id>` with optional label. */
function renderStart(id: string, name?: string): string {
  let line = `${INDENT}start ${id}`;
  if (name !== undefined) line += ` ${quote(name)}`;
  return line;
}

/** Render `end <id>` with optional label. */
function renderEnd(id: string, name?: string): string {
  let line = `${INDENT}end ${id}`;
  if (name !== undefined) line += ` ${quote(name)}`;
  return line;
}

/**
 * Render a single sequence flow as an indented DSL line.
 *
 * @param flow The sequence flow to render.
 * @param defaultFlowIds The set of flow ids that need an `as: <id>` tag.
 */
function renderSequenceFlow(
  flow: SequenceFlow,
  defaultFlowIds: Set<string>,
): string {
  let line = `${INDENT}${flow.sourceRef} -> ${flow.targetRef}`;

  // Emit `as: <id>` only for flows that a gateway references as its default.
  // In the grammar the `as:` identifier becomes the flow's cross-reference
  // name, so we use the flow's IR `id` as the alias token.
  if (defaultFlowIds.has(flow.id)) {
    line += ` as: ${flow.id}`;
  }

  if (flow.conditionExpression !== undefined) {
    line += ` when: ${quote(flow.conditionExpression)}`;
  }

  return line;
}

/**
 * Wrap a string value in double-quotes.
 * Inner double-quotes are backslash-escaped (matching the grammar's STRING
 * terminal: `"(\\.|[^"\\])*"`). Other special chars are not escaped because
 * the grammar treats the body as an opaque pass-through; the downstream XML
 * serializer handles XML entity escaping.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
