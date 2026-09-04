/**
 * Derive a BPMN `name` from a DSL identifier, at serialization time only.
 * `xml-to-ir.ts` reverses this by dropping a `name` that equals `humanize(id)`,
 * so the two must stay in step or the round trip grows redundant labels.
 */
export function humanize(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase: reviewInvoice -> review Invoice
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // acronym: HTTPRequest -> HTTP Request
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
