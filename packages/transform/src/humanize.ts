/**
 * Derive a human-readable BPMN `name` from a DSL identifier.
 *
 * BPMNscript keeps the identifier primary and treats the human-readable label
 * as optional: when no explicit label is written, the BPMN `name` attribute is
 * derived from the id by this function. The derivation is applied only at
 * serialization time (IR → XML) and reversed on import (XML → IR drops a `name`
 * that exactly equals `humanize(id)`), so the IR and DSL round-trips never carry
 * a redundant label.
 *
 * The id is split on kebab/snake separators and camelCase/PascalCase boundaries,
 * then each word is title-cased:
 *
 *   invoice-approval → "Invoice Approval"
 *   ReviewInvoice    → "Review Invoice"
 *   ApproveA         → "Approve A"
 *   AuditLog         → "Audit Log"
 *   Done             → "Done"
 */
export function humanize(id: string): string {
  return id
    .replace(/[-_]+/g, ' ') // kebab / snake separators → space
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary: aB → a B
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMWord boundary: HTTPRequest → HTTP Request
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
